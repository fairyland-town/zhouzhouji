/**
 * account.js —— 账户余额模型（v1.5.0）
 *
 * 用户诉求（原话）：
 *   「我充饭卡，我饭卡有多少金额，我消耗了多少金额，还剩下多少金额；
 *     又比如，我从来 100 的花费，经历几个月后还剩下多少钱等等自定义记账的。
 *     这样的目的在于把（记录）自己金额剩余多少全依靠给第三方平台，
 *     好明确知道自己的钱有没有被误吞或者误扣而导致（钱）减少而没记录。」
 *
 * 翻译成产品语言：**这是一套「对账」工具，不只是记账。**
 * 记账回答「钱花到哪儿了」，对账回答「平台说剩 87.5，我觉得该剩 92.3，差的 4.8 去哪了」。
 *
 * 设计要点：
 *
 * 1. **余额有两种来源，必须分开存**，否则永远对不上账：
 *    - `manual`  手动填充：用户从平台 App / 卡机抄下来的余额（比如「饭卡充值机显示 92.30」）
 *    - `derived` 按流水推导：初始余额 + 累计充值 − 累计消费
 *    两个都留，才能算出「差额」。只存一个就退化成普通记账了。
 *
 * 2. **账户的「消耗」不依赖记账流水**。饭卡刷一次就扣钱了，
 *    用户不一定每次都记账。所以充值和消费都能直接记在账户上（`entries`），
 *    记账流水只是**可选的**额外来源（`linkLedger`）。
 *
 *    v1.13.5：这个「可选来源」从设想变成了真功能 ——
 *    用户原话：「在记账的时候多一个可选的消费账户选项，直接从对应的消费账户里面扣钱」。
 *    选了账户的记账会在这里落一条带 `ledgerId` 的流水，
 *    于是它**同时**进账户的 `totalOut`（累计消耗）与余额，而记账总账里仍只有那一笔。
 *    注意：这不是 `account_id`（那是「账户页镜像过来的」），语义完全不同。
 *
 * 3. **余额永远算出来，不缓存**。缓存余额会导致删记录后余额不更新这类幽灵 bug。
 *
 * 数据结构（与 object store: accounts 对应）：
 *   id            INTEGER PRIMARY KEY AUTOINCREMENT
 *   name          TEXT NOT NULL      账户名，如「一食堂饭卡」
 *   type          TEXT NOT NULL      meal_card / bank / cash / wallet / custom
 *   balance_mode  TEXT NOT NULL      manual（手动填）| tracked（只按流水算）
 *   opening       REAL NOT NULL      期初余额
 *   opening_date  TEXT NOT NULL      期初余额对应日期 YYYY-MM-DD
 *   entries       JSON/TEXT          该账户自己的充值/消费流水（数组）
 *   checkpoints   JSON/TEXT          对账快照：用户填的「平台显示余额」
 *   archived      INTEGER NOT NULL   0 | 1
 *   note          TEXT
 *   created_at    TEXT NOT NULL
 *
 * entries 元素：{ id, kind: 'in'|'out', amount, date, note, ledgerId? }
 *   ledgerId（v1.13.5）：这条账户流水是「记账页选了本账户」自动落的，
 *   值是对应记账流水的 id。挂账关系**只存在账户这一侧**，理由见
 *   account_service.linkLedger 的注释（记账流水上的 account_id 是另一个语义）。
 * checkpoints 元素：{ date, balance, note }  —— 「这天平台显示是这么多」
 *
 * v1.7.0 新增 recurring（每月定时扣款，可选）：
 *   { enabled, day, amount, note, kind, since, lastRun, runCount }
 *   用户原话：「账户里面每一个账户多一个功能就是可以每个月按时扣款（选择性设置）」
 *   典型场景：房租 / 话费 / 会员费按月固定扣，不用每月手动记一次。
 *   注意 day 是「每月几号」（1–28，避开月末不存在的问题），不是 cron。
 *   since   启用月份（'YYYY-MM'），防止新建账户被倒扣历史月份
 *   lastRun 上次自动扣款的月份，保证一个月只扣一次
 *   runCount 已执行期数，作为补扣上限 —— 防止重复计算（v1.9.0）
 *
 * v1.9.0 定时扣款语义修正（用户明确要求）：
 *   「不是设置了立即扣除，而是在固定的设置的那一天扣款」——
 *   设置当时绝不扣；只有在「每月 N 号」那天及之后才执行。
 *   设置日在扣款日之前 → 本月到日子就扣；设置日已过扣款日 → 本月不管，下个月再扣。
 *   配套两条：**已错过的月份永久放弃、绝不补扣**（否则「那天没打开 App」会攒出一堆
 *   待扣项，下次打开一次性扣光）；**重新设置不刷新 `since`**
 *   （否则本月该扣的会被推到下月）。
 *   **账户「消费」不再镜像到记账总账**，只有「充值」会（用户要求「避免重复计算」）——
 *   日常消费由记账页自己记，账户只负责余额对账，同一笔钱不再入账两次。
 */

import { formatDate, formatDateTime } from '../utils/date_utils.js';

/** 账户类型：决定图标与默认推荐场景 */
export const ACCOUNT_TYPE = {
  MEAL_CARD: 'meal_card',
  BANK: 'bank',
  CASH: 'cash',
  WALLET: 'wallet',
  CUSTOM: 'custom',
};

export const ACCOUNT_TYPE_META = {
  [ACCOUNT_TYPE.MEAL_CARD]: { id: ACCOUNT_TYPE.MEAL_CARD, label: '饭卡 / 校园卡', icon: '🍚', color: '#ea580c' },
  [ACCOUNT_TYPE.BANK]: { id: ACCOUNT_TYPE.BANK, label: '银行卡', icon: '🏦', color: '#1d4ed8' },
  [ACCOUNT_TYPE.CASH]: { id: ACCOUNT_TYPE.CASH, label: '现金', icon: '💵', color: '#16a34a' },
  [ACCOUNT_TYPE.WALLET]: { id: ACCOUNT_TYPE.WALLET, label: '微信 / 支付宝', icon: '📱', color: '#0891b2' },
  [ACCOUNT_TYPE.CUSTOM]: { id: ACCOUNT_TYPE.CUSTOM, label: '自定义', icon: '📦', color: '#7c3aed' },
};

export const ACCOUNT_TYPES = Object.values(ACCOUNT_TYPE);

export function getAccountTypeMeta(type) {
  return ACCOUNT_TYPE_META[type] || ACCOUNT_TYPE_META[ACCOUNT_TYPE.CUSTOM];
}

/**
 * 「资产分布」里用的分组名（v1.13.0）。
 *
 * 为什么不直接用 ACCOUNT_TYPE_META.label：
 * 那是**账户类型**的名字（「银行卡」「微信 / 支付宝」），
 * 而资产总览要的是**资产去向**的名字（「储蓄账户」「支付账户」）——
 * 参照图里就是「储蓄账户」「投资理财」这种口径。
 * 两套名字各自服务于不同语境，不要为了「统一」把它们合并掉。
 */
export const ACCOUNT_GROUP_LABEL = {
  [ACCOUNT_TYPE.BANK]: '储蓄账户',
  [ACCOUNT_TYPE.WALLET]: '支付账户',
  [ACCOUNT_TYPE.MEAL_CARD]: '校园卡',
  [ACCOUNT_TYPE.CASH]: '现金',
  [ACCOUNT_TYPE.CUSTOM]: '其他账户',
};

/** 分组展示顺序：钱多的场景排前面（银行 → 支付 → 校园卡 → 现金 → 其他） */
const GROUP_ORDER = [
  ACCOUNT_TYPE.BANK, ACCOUNT_TYPE.WALLET, ACCOUNT_TYPE.MEAL_CARD,
  ACCOUNT_TYPE.CASH, ACCOUNT_TYPE.CUSTOM,
];

/**
 * 按账户类型分组，供「资产分布」渲染。
 * 组内按余额降序（钱多的在前），空组不返回。
 * @returns {Array<{type,label,icon,color,accounts,total,count}>}
 */
export function groupAccountsByType(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  for (const type of GROUP_ORDER) {
    const accounts = arr.filter((a) => a.type === type)
      .sort((x, y) => y.balance - x.balance);
    if (!accounts.length) continue;
    const meta = getAccountTypeMeta(type);
    out.push({
      type,
      label: ACCOUNT_GROUP_LABEL[type] || meta.label,
      icon: meta.icon,
      color: meta.color,
      accounts,
      count: accounts.length,
      total: round2(accounts.reduce((s, a) => s + a.balance, 0)),
    });
  }
  return out;
}

/** 余额来源模式 */
export const BALANCE_MODE = {
  /** 手动填充 + 记账推导：既记流水，也允许随时抄平台余额对账（默认，最有用） */
  TRACKED: 'tracked',
  /** 只当静态余额：不记流水，就是「我现在有多少钱」 */
  STATIC: 'static',
};

/** 流水方向 */
export const ACCOUNT_FLOW = {
  IN: 'in',    // 充值 / 转入
  OUT: 'out',  // 消费 / 转出
};

/** 每月扣款的默认值（v1.7.0） */
export const RECURRING_DEFAULT = {
  enabled: false,
  day: 1,               // 每月几号，1–28
  amount: 0,            // 扣多少，必须 > 0 才算有效
  note: '',             // 备注，如「房租」
  kind: ACCOUNT_FLOW.OUT,
  since: null,          // 从哪个月开始生效 'YYYY-MM'，防止新建账户被倒扣历史月份
  lastRun: null,        // 上次自动扣款的月份 'YYYY-MM'，防重复
  runCount: 0,          // 已自动执行的期数，仅用于「第 N 期」展示
  sinceSkip: false,     // 启用当月那一期是否已放弃（设置日已过扣款日时为 true）
};

/** 每月扣款可选日期（1–28，避开 2 月 29/30/31 号不存在的坑） */
export const RECURRING_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);

/** 'YYYY-MM' 偏移 n 个月，返回 'YYYY-MM' */
function addMonths(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const d = new Date(y, m - 1 + Number(n), 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 两个 'YYYY-MM' 之间相隔几个月（to 早于 from 时为负） */
function monthDiff(from, to) {
  const [fy, fm] = String(from).split('-').map(Number);
  const [ty, tm] = String(to).split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * 自动扣款的流水备注（v1.9.0）。
 * 附上「第 N 期 / 共 M 期」，用户一眼能看出这笔是月扣款、且总共扣了多久，
 * 不会和手记的消费混淆。重新设置扣款时会重新从第 1 期计。
 */
export function addRunNote(base, n, total) {
  const label = Number(total) > 0 ? `第 ${n} 期 / 共 ${total} 期` : `第 ${n} 期`;
  const b = String(base || '').trim();
  return b ? `${b}（${label}）` : label;
}

let seq = 1;
/** 账户内部流水条目的本地 id（只在账户内唯一，不进全局自增） */
function entryId() {
  seq += 1;
  return `e${Date.now().toString(36)}${seq.toString(36)}`;
}

export class Account {
  constructor({
    id = null,
    name = '',
    type = ACCOUNT_TYPE.CUSTOM,
    balanceMode = BALANCE_MODE.TRACKED,
    opening = 0,
    openingDate = null,
    entries = [],
    checkpoints = [],
    recurring = null,
    archived = false,
    note = '',
    createdAt = null,
  } = {}) {
    this.id = id;
    this.name = String(name || '').trim();
    this.type = ACCOUNT_TYPES.includes(type) ? type : ACCOUNT_TYPE.CUSTOM;
    this.balanceMode = balanceMode === BALANCE_MODE.STATIC ? BALANCE_MODE.STATIC : BALANCE_MODE.TRACKED;

    const n = Number(opening);
    this.opening = Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    this.openingDate = openingDate ? formatDate(new Date(openingDate)) : formatDate(new Date());

    // 流水按日期升序规范化，保证「累计」的语义稳定
    this.entries = (Array.isArray(entries) ? entries : [])
      .map((e) => normalizeEntry(e))
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));

    this.checkpoints = (Array.isArray(checkpoints) ? checkpoints : [])
      .map((c) => normalizeCheckpoint(c))
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    this.recurring = normalizeRecurring(recurring);

    this.archived = Boolean(archived);
    this.note = String(note || '').trim();
    this.createdAt = createdAt
      ? (createdAt instanceof Date ? formatDateTime(createdAt) : String(createdAt))
      : formatDateTime(new Date());
  }

  get typeMeta() { return getAccountTypeMeta(this.type); }

  /* ---------------- 余额计算 ---------------- */

  /** 累计充值 */
  get totalIn() {
    return round2(this.entries.filter((e) => e.kind === ACCOUNT_FLOW.IN).reduce((s, e) => s + e.amount, 0));
  }

  /** 累计消费 */
  get totalOut() {
    return round2(this.entries.filter((e) => e.kind === ACCOUNT_FLOW.OUT).reduce((s, e) => s + e.amount, 0));
  }

  /**
   * 累计充值（**不含账户之间的转账转入**）—— v1.13.7。
   *
   * 🔴 为什么 `totalIn` 不够用：
   *    `totalIn` 回答的是「**这张卡**一共进过多少钱」，单看一个账户它是对的
   *    —— B 转 200 给 A，A 确实进过这 200。
   *    但**把各账户加起来**的时候，同一笔钱会被算两遍：
   *    A.totalIn +200 而 B.totalOut +200，钱却从没离开过这个人。
   *    用户 2026-09-24 的口径：「在钱入账的时候已经计算过了的」——
   *    那 200 首次从外部充进 B 时已经算过一次，转进 A 不该再算。
   *
   * 所以**全局口径**（`summarizeOverview`）必须用这一对 getter，
   * 单个账户卡片继续用 `totalIn` / `totalOut`（那里「进过多少」才是用户想看的）。
   *
   * 判据见 `isTransferLeg()`：`linkedAccountId` 只有 `transfer()` 会写。
   */
  get totalInExternal() {
    return round2(this.entries
      .filter((e) => e.kind === ACCOUNT_FLOW.IN && !isTransferLeg(e))
      .reduce((s, e) => s + e.amount, 0));
  }

  /** 累计消费（**不含账户之间的转账转出**）—— 与 `totalInExternal` 成对，理由见上。 */
  get totalOutExternal() {
    return round2(this.entries
      .filter((e) => e.kind === ACCOUNT_FLOW.OUT && !isTransferLeg(e))
      .reduce((s, e) => s + e.amount, 0));
  }

  /** 按流水推导出的余额：期初 + 充 − 消 */
  get derivedBalance() {
    return round2(this.opening + this.totalIn - this.totalOut);
  }

  /** 最近一次「抄下来的平台余额」（对账基准）；没有则为 null */
  get lastCheckpoint() {
    return this.checkpoints.length ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  /**
   * 当前余额。
   * 有对账快照时：以快照余额为基准，叠加快照之后的流水 —— 这样才反映最新状态。
   * 没有快照时：用期初 + 全部流水推导。
   */
  get balance() {
    const cp = this.lastCheckpoint;
    if (!cp) return this.derivedBalance;
    const after = this.entries.filter((e) => e.date > cp.date);
    const delta = after.reduce((s, e) => s + (e.kind === ACCOUNT_FLOW.IN ? e.amount : -e.amount), 0);
    return round2(cp.balance + delta);
  }

  /**
   * 对账差额：按流水推导 vs 平台显示，差多少。
   * 这正是用户要的「钱有没有被误吞 / 误扣」——
   * > 0 表示记账口径下应该剩更多（平台多扣了 / 有笔消费没记）
   * < 0 表示实际比推导的少（可能有没记的消费）
   */
  get balanceDiff() {
    const cp = this.lastCheckpoint;
    if (!cp) return 0;
    // 快照之后到今天的流水
    const after = this.entries.filter((e) => e.date > cp.date);
    const delta = after.reduce((s, e) => s + (e.kind === ACCOUNT_FLOW.IN ? e.amount : -e.amount), 0);
    const expected = round2(cp.balance + delta);
    return round2(this.derivedFromOpeningAt(cp.date) - expected);
  }

  /** 从期初推到某一天的应有余额（不含该日之后的流水） */
  derivedFromOpeningAt(dateStr) {
    const upto = this.entries.filter((e) => e.date <= dateStr);
    const delta = upto.reduce((s, e) => s + (e.kind === ACCOUNT_FLOW.IN ? e.amount : -e.amount), 0);
    return round2(this.opening + delta);
  }

  /**
   * 日均消耗（按「有消费记录的天数区间」估算）。
   * 没有消费时返回 0，避免除零。
   *
   * 🔴 v1.13.7：**转账转出不算消耗**（用户 2026-09-24「转账不计入收入」的同一条口径）。
   *    不排除的话，转出方那张卡会被一笔转账顶飞 —— 实测：
   *    期初 500、今天转 400 给饭卡 → 余额还有 100，却显示
   *    「日均 ¥400.00 · 还能用 0 天」并点亮警告色（`daysLeft() <= 7`）。
   *    钱只是挪到另一张卡去了，一分没花。
   *
   *    ⚠️ **求和与区间必须用同一套过滤**。只把 `totalOut` 换成 `totalOutExternal`
   *    而 `outs` 里还留着转账的话，「零消耗但区间被转账拉长」会算出更小的日均
   *    —— 数字看着变温和了，其实是错的。
   *
   *    ⚠️ 这里的区间是「最早一笔消费 → 今天」，**没有上限**。
   *    （早先的注释写着「最多看最近 90 天」，但代码从来没实现过，2026-09-24 已把注释改对。
   *      要不要真加这个上限是另一个决定，别顺手加。）
   */
  dailyBurn(today = new Date()) {
    const outs = this.entries.filter((e) => e.kind === ACCOUNT_FLOW.OUT && !isTransferLeg(e));
    if (!outs.length) return 0;
    const first = outs[0].date;
    const t = formatDate(today);
    const spanDays = Math.max(1, Math.round(
      (new Date(t.replace(/-/g, '/')) - new Date(first.replace(/-/g, '/'))) / 86400000,
    ) + 1);
    return round2(this.totalOutExternal / spanDays);
  }

  /** 按日均消耗估算还能用多少天；无消耗时返回 null */
  daysLeft(today = new Date()) {
    const burn = this.dailyBurn(today);
    if (burn <= 0 || this.balance <= 0) return null;
    return Math.floor(this.balance / burn);
  }

  /* ---------------- 变更 ---------------- */

  /** 加一笔充值 / 消费，返回自身 */
  addEntry({ kind = ACCOUNT_FLOW.OUT, amount = 0, date = null, note = '', ledgerId = null } = {}) {
    this.addEntryWithId({ kind, amount, date, note, ledgerId });
    return this;
  }

  /**
   * 同 addEntry，但返回**新建的那条流水**。
   * v1.7.0：账户流水要镜像到记账页，需要拿到新 stream 的 id 做去重键，
   * 而 entries 是按日期升序排的，新条目不一定在末位，所以不能靠 entries.at(-1) 取。
   *
   * v1.13.5：多了 ledgerId（记账页挂账过来时写入）与
   * linkedAccountId / linkedEntryId（转账时两边互相认领）。
   * 必须由这里透传给 normalizeEntry —— 手工 `e.ledgerId = ...` 也行，
   * 但那样等于把「哪些字段要持久化」的知识散到调用方，容易漏。
   */
  addEntryWithId({
    kind = ACCOUNT_FLOW.OUT, amount = 0, date = null, note = '',
    ledgerId = null, linkedAccountId = null, linkedEntryId = null,
  } = {}) {
    const e = normalizeEntry({
      id: entryId(), kind, amount, date, note, ledgerId, linkedAccountId, linkedEntryId,
    });
    if (!e) throw new Error('金额必须大于 0');
    this.entries.push(e);
    this.entries.sort((a, b) => a.date.localeCompare(b.date));
    return e;
  }

  removeEntry(entryId2) {
    const i = this.entries.findIndex((e) => e.id === entryId2);
    if (i < 0) return false;
    this.entries.splice(i, 1);
    return true;
  }

  /** 记一次对账快照：平台这天显示这么多 */
  addCheckpoint({ date = null, balance = 0, note = '' } = {}) {
    const c = normalizeCheckpoint({ date, balance, note });
    if (!c) throw new Error('余额格式不正确');
    this.checkpoints.push(c);
    this.checkpoints.sort((a, b) => a.date.localeCompare(b.date));
    return this;
  }

  /** 是否已设置过期初余额（没设过就不该显示「消耗 / 剩余」这类推导数字） */
  get hasBaseline() {
    return this.opening !== 0 || this.entries.length > 0 || this.checkpoints.length > 0;
  }

  /* ---------------- 每月定时扣款（v1.7.0） ---------------- */

  /** 是否真的启用了每月扣款（开关打开 + 金额 > 0 才算数，否则 UI 会显示假承诺） */
  get hasRecurring() {
    return Boolean(this.recurring && this.recurring.enabled && this.recurring.amount > 0);
  }

  /** 人话描述，如「每月 1 号自动扣 ¥1500.00（房租）」 */
  get recurringLabel() {
    if (!this.hasRecurring) return '';
    const r = this.recurring;
    const verb = r.kind === ACCOUNT_FLOW.IN ? '自动充值' : '自动扣款';
    return `每月 ${r.day} 号${verb} ¥${r.amount.toFixed(2)}${r.note ? `（${r.note}）` : ''}`;
  }

  /** 累计自动扣款期数（UI 里显示「已自动执行 N 期」） */
  get recurringRunCount() {
    return Number(this.recurring && this.recurring.runCount) || 0;
  }

  /**
   * 该月自动扣款的执行日（'YYYY-MM-DD'）。
   * 该月不存在 day 号时（比如只到 28 号）落到月末。
   */
  recurringDateOf(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    const dim = new Date(y, m, 0).getDate();
    const day = Math.min(this.recurring.day, dim);
    return `${ym}-${String(day).padStart(2, '0')}`;
  }

  /**
   * 到「今天」为止应该自动扣款的清单。
   *
   * 三条规则（v1.9.0 用户确认）：
   *
   * 1. 🔴 **设置当时绝不立即扣。** 只有到了「每月 N 号」才扣。
   *    设置日早于扣款日 → 本月那天就扣；设置日已过扣款日 → 本月不管，下月那天再扣。
   *    实现：`recurring.sinceSkip` 记住「启用月那期是否已放弃」。
   *
   * 2. **错过的一律补上，不设上限**（用户确认）。
   *    几个月没打开 App，回来时那几期逐月补齐 —— 房租本来就是要交的。
   *
   * 3. `lastRun` 是唯一的「已执行到哪月」权威；`runCount` 只用于 UI 展示
   *    与流水备注的「第 N 期」，不参与是否产生的判定。
   *
   * @returns {Array<{month:string, date:string, amount:number, note:string, kind:string, total:number}>} 升序
   */
  dueRecurring(today = new Date()) {
    if (!this.hasRecurring) return [];
    const r = this.recurring;
    const todayStr = formatDate(today);
    const curMonth = todayStr.slice(0, 7);

    // 起点：lastRun 的次月 → since（含）→ 本月
    let from = r.lastRun ? addMonths(r.lastRun, 1) : (r.since || curMonth);
    if (r.since && from < r.since) from = r.since;
    if (from > curMonth) return [];          // 还没到时候

    // 「第 N 期 / 共 M 期」的展示用总数：since 起到今天总共该执行几期
    const total = r.since
      ? Math.max(1, monthDiff(r.since, curMonth) + 1)
      : this.recurringRunCount + 1;

    const out = [];
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    let guard = 0;
    while (guard < 24) {
      guard += 1;
      const ym = `${y}-${String(m).padStart(2, '0')}`;
      if (ym > curMonth) break;
      const dateStr = this.recurringDateOf(ym);
      if (dateStr > todayStr) break;         // 这月还没到扣款日，后面的更不会到
      // 启用当月且设置日已过扣款日 → 那期是用户主动放弃的
      const skipped = r.sinceSkip && r.since && ym === r.since;
      if (!skipped) {
        out.push({
          month: ym, date: dateStr,
          amount: r.amount, note: r.note, kind: r.kind, total,
        });
      }
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
    return out;
  }

  /** 标记某月已执行自动扣款 */
  markRecurringRun(month) {
    if (!this.recurring) return this;
    this.recurring.lastRun = String(month).slice(0, 7);
    return this;
  }

  validate() {
    const errors = [];
    if (!this.name) errors.push('账户名称不能为空');
    if (this.name.length > 30) errors.push('账户名称不能超过 30 个字');
    if (!ACCOUNT_TYPES.includes(this.type)) errors.push('账户类型不合法');
    if (this.openingDate && !/^\d{4}-\d{2}-\d{2}$/.test(this.openingDate)) errors.push('期初日期格式不正确');
    return { ok: errors.length === 0, errors };
  }

  toRecord() {
    return {
      id: this.id,
      name: this.name,
      type: this.type,
      balance_mode: this.balanceMode,
      opening: this.opening,
      opening_date: this.openingDate,
      entries: this.entries.map((e) => ({ ...e })),
      checkpoints: this.checkpoints.map((c) => ({ ...c })),
      recurring: { ...this.recurring },
      archived: this.archived ? 1 : 0,
      note: this.note,
      created_at: this.createdAt,
    };
  }

  static fromRecord(rec) {
    if (!rec) return null;
    return new Account({
      id: rec.id,
      name: rec.name,
      type: rec.type,
      balanceMode: rec.balance_mode,
      opening: rec.opening,
      openingDate: rec.opening_date,
      entries: rec.entries,
      checkpoints: rec.checkpoints,
      recurring: rec.recurring,
      archived: rec.archived === 1 || rec.archived === true,
      note: rec.note,
      createdAt: rec.created_at,
    });
  }

  toJSON() {
    return {
      name: this.name,
      type: this.type,
      balance_mode: this.balanceMode,
      opening: this.opening,
      opening_date: this.openingDate,
      entries: this.entries.map((e) => ({ ...e })),
      checkpoints: this.checkpoints.map((c) => ({ ...c })),
      recurring: { ...this.recurring },
      archived: this.archived,
      note: this.note,
      created_at: this.createdAt,
    };
  }
}

/* ---------------- 工具 ---------------- */

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * 这条账户流水是不是「账户之间转账」的一半（转入或转出都算）。
 *
 * 🔴 判据只有 `linkedAccountId` —— 全项目**只有 `AccountService.transfer()` 会写它**
 *    （外部充值走 `recharge` → `addEntry`，每月扣款走 `runDueRecurring`，都不写）。
 *    所以「有没有这个字段」等价于「是不是转账的一半」，不需要再查别的表。
 *
 * ⚠️ `normalizeEntry()` 在字段为空时**根本不写这个 key**（不是写成 null），
 *    所以判定必须同时挡 `null` 和 `undefined`。
 */
export function isTransferLeg(e) {
  return !!e && e.linkedAccountId !== null && e.linkedAccountId !== undefined;
}

function normalizeEntry(e) {
  if (!e) return null;
  const amount = round2(Math.abs(Number(e.amount)));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const kind = e.kind === ACCOUNT_FLOW.IN ? ACCOUNT_FLOW.IN : ACCOUNT_FLOW.OUT;
  const rawDate = e.date ? String(e.date).trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : formatDate(new Date());
  const out = {
    id: e.id || entryId(),
    kind,
    amount,
    date,
    note: String(e.note || '').trim(),
  };
  // 🔴 v1.13.5：必须留住 ledgerId。
  //    它是「这条账户流水由哪笔记账挂过来的」的唯一凭据。
  //    早先这里只挑了 id/kind/amount/date/note 五个字段返回，
  //    ledgerId 会在**存一次再读一次**之后凭空消失 —— 于是
  //    · 重复挂账检测失效（每次编辑都再扣一笔）
  //    · 删记账时找不到该撤销哪条账户流水，钱留在账户里变成幽灵支出
  //    这类 bug 只在「重启 App 之后」才出现，现场极难复现，所以在这里钉死。
  if (e.ledgerId !== null && e.ledgerId !== undefined && e.ledgerId !== '') {
    out.ledgerId = e.ledgerId;
  }
  // 🔴 v1.13.5 转账：同一次转账在两边各落一条流水，靠这两个字段互相认领。
  //    · linkedAccountId 对方账户 id
  //    · linkedEntryId   对方那条流水的 id
  //    删一条时要顺着它把对方那条一起撤掉，否则会留下「钱转出去了、
  //    但另一边没收到」的半截账 —— 对账时怎么算都对不上。
  //    ⚠️ 和 ledgerId 一样，**不在这里显式保留就会在存读往返后消失**，
  //    所以每加一个要持久化的字段，都必须回到这个函数来补一行。
  const linkedAcc = Number(e.linkedAccountId);
  if (Number.isFinite(linkedAcc) && e.linkedAccountId !== null && e.linkedAccountId !== '') {
    out.linkedAccountId = linkedAcc;
  }
  if (e.linkedEntryId !== null && e.linkedEntryId !== undefined && e.linkedEntryId !== '') {
    out.linkedEntryId = e.linkedEntryId;
  }
  return out;
}

function normalizeCheckpoint(c) {
  if (!c) return null;
  const bal = Number(c.balance);
  if (!Number.isFinite(bal)) return null;
  const rawDate = c.date ? String(c.date).trim() : '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : formatDate(new Date());
  return {
    date,
    balance: round2(bal),
    note: String(c.note || '').trim(),
  };
}

/**
 * 规范化每月扣款配置。
 * 旧账户（v1.6 及以前保存的）没有这个字段，必须优雅兜底成「未启用」，
 * 否则读历史数据会直接崩或者显示出一个凭空的扣款承诺。
 */
function normalizeRecurring(r) {
  const out = { ...RECURRING_DEFAULT };
  if (!r || typeof r !== 'object') return out;
  out.enabled = Boolean(r.enabled);
  const day = Number(r.day);
  out.day = Number.isFinite(day) ? Math.min(28, Math.max(1, Math.round(day))) : 1;
  const amt = round2(Math.abs(Number(r.amount)));
  out.amount = Number.isFinite(amt) ? amt : 0;
  out.note = String(r.note || '').trim();
  out.kind = r.kind === ACCOUNT_FLOW.IN ? ACCOUNT_FLOW.IN : ACCOUNT_FLOW.OUT;
  out.since = r.since && /^\d{4}-\d{2}$/.test(String(r.since)) ? String(r.since) : null;
  out.lastRun = r.lastRun && /^\d{4}-\d{2}$/.test(String(r.lastRun)) ? String(r.lastRun) : null;
  const rc = Number(r.runCount);
  out.runCount = Number.isFinite(rc) && rc > 0 ? Math.floor(rc) : 0;
  out.sinceSkip = Boolean(r.sinceSkip);
  return out;
}

/**
 * 账户列表视图数据。
 * @returns {{all,active,archived,totalBalance,stats}}
 */
export function summarizeAccounts(list) {
  const active = list.filter((a) => !a.archived);
  const archived = list.filter((a) => a.archived);
  const totalBalance = round2(active.reduce((s, a) => s + a.balance, 0));
  const withDiff = active.filter((a) => a.lastCheckpoint);
  return {
    all: list,
    active,
    archived,
    totalBalance,
    stats: {
      count: list.length,
      activeCount: active.length,
      archivedCount: archived.length,
      totalBalance,
      // 有对账快照的账户里，差额最大的那个（供 UI 提示「可能有问题」）
      maxDiffAccount: withDiff.length
        ? withDiff.reduce((worst, a) => (Math.abs(a.balanceDiff) > Math.abs(worst.balanceDiff) ? a : worst))
        : null,
    },
  };
}

export default Account;
