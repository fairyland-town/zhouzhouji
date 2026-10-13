/**
 * asset.js —— 「资产总览」四类明细的模型（v1.13.0）
 *
 * 用户诉求（原话）：
 *   「账户里面，新增加如图板块和ui」—— 参照图里那种「净资产 + 借入借出 +
 *     报销未报销 + 黄金克重 + 定期」的资产总览页。
 *
 * 设计取舍（重要，别随手改）：
 *
 * 1. **这四类数据不进 IndexedDB 的独立 store，而是存 kv。**
 *    加一个 store 要升 DB_VERSION、写迁移、改备份导入顺序、改清空类别……
 *    而 kv 本来就在 BACKUP_STORES 里，导出/导入/清空都能复用现成链路。
 *    代价是「清空数据 → 账户」要额外把这些 key 一起清掉（已在
 *    database_service.js 的 CLEAR_CATEGORIES 里挂上）。
 *
 * 2. **定期存款不计入「净资产」。**
 *    定期那笔钱通常就躺在某个已经建过账户的银行卡里，
 *    再加一遍就是重复计算 —— 而用户要的恰恰是「别让我重复算」。
 *    所以定期只在自己的卡片里显示本金/到期日，不参与净资产合计。
 *    借入/借出/报销/黄金则**计入**，因为它们不在任何账户余额里。
 *
 * 3. **借入是负债、借出是资产**，方向不能反。
 *    借入 = 我向别人借的 → 我欠别人 → 负债
 *    借出 = 别人向我借的 → 别人欠我 → 资产
 *    未结清的才算；已结清的一律不进合计（否则净资产永远虚高）。
 *
 * 4. **所有汇总都是纯函数**（summarizeAssets），不依赖 DOM、不依赖当前时间之外
 *    的任何外部状态，today 显式传入 —— 这样才能被单元测试钉死期望值。
 */

import { formatDate } from '../utils/date_utils.js';

/* ---------------- 存储键 ---------------- */

/**
 * kv 里的键名。
 * 🔴 全部以 `cw_` 开头，且**永不改名** —— 改名等于用户数据凭空消失。
 */
export const ASSET_KEYS = {
  LOANS: 'cw_loans',
  REIMBURSEMENTS: 'cw_reimbursements',
  GOLD: 'cw_gold',
  /** 当前金价（元/克）。单独存，不跟持仓混在一起 —— 它是全局标价，不属于某笔持仓 */
  GOLD_PRICE: 'cw_gold_price',
  DEPOSITS: 'cw_deposits',
};

/* ---------------- 枚举 ---------------- */

/** 借入 / 借出。方向决定它是资产还是负债，不能反 */
export const LOAN_DIRECTION = {
  /** 借入：我向别人借 → 我欠别人 → 负债 */
  IN: 'in',
  /** 借出：别人向我借 → 别人欠我 → 资产 */
  OUT: 'out',
};

export const LOAN_DIRECTION_META = {
  [LOAN_DIRECTION.IN]: { id: LOAN_DIRECTION.IN, label: '借入', desc: '我向别人借的，要还', sign: -1 },
  [LOAN_DIRECTION.OUT]: { id: LOAN_DIRECTION.OUT, label: '借出', desc: '别人向我借的，要收', sign: 1 },
};

/** 定期存款到期前多少天算「即将到期」 */
export const DUE_SOON_DAYS = 30;

/* ---------------- 工具 ---------------- */

let seq = 1;
/** 本地 id：只在同类清单内唯一，不进全局自增 */
function localId(prefix) {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round3(n) {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}

/** 规范成 'YYYY-MM-DD'；空 / 非法一律返回 null（**不兜底成今天** —— 空日期是有意义的） */
function normDate(v) {
  const s = v ? String(v).trim() : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

/** 'YYYY-MM-DD' → Date（本地时区，避免 new Date('YYYY-MM-DD') 被当 UTC 差一天） */
function parseDay(s) {
  if (!s) return null;
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

/** 两个 'YYYY-MM-DD' 相差几天（to − from） */
export function daysBetween(from, to) {
  const a = parseDay(from);
  const b = parseDay(to);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

/* ---------------- 借入 / 借出 ---------------- */

export function normalizeLoan(raw) {
  if (!raw) return null;
  const amount = round2(Math.abs(Number(raw.amount)));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: raw.id || localId('l'),
    direction: raw.direction === LOAN_DIRECTION.OUT ? LOAN_DIRECTION.OUT : LOAN_DIRECTION.IN,
    counterparty: String(raw.counterparty || '').trim(),
    amount,
    date: normDate(raw.date) || formatDate(new Date()),
    dueDate: normDate(raw.dueDate),
    settled: Boolean(raw.settled),
    settledDate: normDate(raw.settledDate),
    note: String(raw.note || '').trim(),
  };
}

/* ---------------- 报销 / 未报销 ---------------- */

export function normalizeReimbursement(raw) {
  if (!raw) return null;
  const amount = round2(Math.abs(Number(raw.amount)));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    id: raw.id || localId('r'),
    item: String(raw.item || '').trim(),
    amount,
    date: normDate(raw.date) || formatDate(new Date()),
    reimbursed: Boolean(raw.reimbursed),
    reimbursedDate: normDate(raw.reimbursedDate),
    note: String(raw.note || '').trim(),
  };
}

/* ---------------- 黄金持仓 ---------------- */

export function normalizeGold(raw) {
  if (!raw) return null;
  const grams = round3(Math.abs(Number(raw.grams)));
  if (!Number.isFinite(grams) || grams <= 0) return null;
  return {
    id: raw.id || localId('g'),
    name: String(raw.name || '').trim(),
    grams,
    note: String(raw.note || '').trim(),
  };
}

/** 金价规范：非负数；0 表示「还没填」 */
export function normalizeGoldPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? round2(n) : 0;
}

/* ---------------- 定期存款 ---------------- */

export function normalizeDeposit(raw) {
  if (!raw) return null;
  const amount = round2(Math.abs(Number(raw.amount)));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rate = Number(raw.rate);
  return {
    id: raw.id || localId('d'),
    name: String(raw.name || '').trim(),
    amount,
    // 年利率（%）。允许 0（活期 / 不计息），负数没有意义
    rate: Number.isFinite(rate) && rate > 0 ? Math.round(rate * 100) / 100 : 0,
    startDate: normDate(raw.startDate) || formatDate(new Date()),
    maturityDate: normDate(raw.maturityDate),
    note: String(raw.note || '').trim(),
  };
}

/* ---------------- 汇总（纯函数） ---------------- */

/**
 * 把四类明细 + 账户余额合成「资产总览」。
 *
 * @param {object} input
 * @param {Array}  input.loans           借入/借出清单（原始或已规范化都可）
 * @param {Array}  input.reimbursements  报销清单
 * @param {Array}  input.gold            黄金持仓清单
 * @param {Array}  input.deposits        定期清单
 * @param {number} input.goldPrice       当前金价（元/克），0 = 未填
 * @param {number} input.accountBalance  账户余额合计（可以为负）
 * @param {Date}   [input.today]         基准日，默认今天
 * @returns {object} 供 UI 直接消费的汇总对象
 */
export function summarizeAssets({
  loans = [], reimbursements = [], gold = [], deposits = [],
  goldPrice = 0, accountBalance = 0, today = new Date(),
} = {}) {
  const todayStr = formatDate(today);

  const L = loans.map(normalizeLoan).filter(Boolean);
  const R = reimbursements.map(normalizeReimbursement).filter(Boolean);
  const G = gold.map(normalizeGold).filter(Boolean);
  const D = deposits.map(normalizeDeposit).filter(Boolean);

  /* ---- 借入 / 借出（只算未结清） ---- */
  const openLoans = L.filter((x) => !x.settled);
  const borrowedIn = round2(openLoans.filter((x) => x.direction === LOAN_DIRECTION.IN)
    .reduce((s, x) => s + x.amount, 0));
  const lentOut = round2(openLoans.filter((x) => x.direction === LOAN_DIRECTION.OUT)
    .reduce((s, x) => s + x.amount, 0));
  // 已过约定归还日还没结清的 —— 这才是真正要催的。
  // 🔴 逾期数必须**按方向分开**：合成一个总数的话，一笔「借入逾期」会让
  //    「借出」那一格也显示「1 笔已到期」，等于凭空造出一笔别人欠你却没还的钱。
  const overdue = openLoans.filter((x) => x.dueDate && x.dueDate < todayStr);
  const overdueIn = overdue.filter((x) => x.direction === LOAN_DIRECTION.IN);
  const overdueOut = overdue.filter((x) => x.direction === LOAN_DIRECTION.OUT);

  /* ---- 报销 / 未报销 ---- */
  const doneR = R.filter((x) => x.reimbursed);
  const pendingR = R.filter((x) => !x.reimbursed);
  const reimbursedTotal = round2(doneR.reduce((s, x) => s + x.amount, 0));
  const pendingTotal = round2(pendingR.reduce((s, x) => s + x.amount, 0));

  /* ---- 黄金 ---- */
  const totalGrams = round3(G.reduce((s, x) => s + x.grams, 0));
  const price = normalizeGoldPrice(goldPrice);
  // 没填金价时市值算 0，而不是拿克重当钱 —— 否则净资产会凭空多出一个数
  const goldValue = price > 0 ? round2(totalGrams * price) : 0;

  /* ---- 定期（只统计，不计入净资产，理由见文件头） ---- */
  const depositTotal = round2(D.reduce((s, x) => s + x.amount, 0));
  const dueSoon = D.filter((x) => {
    const left = daysBetween(todayStr, x.maturityDate);
    return left != null && left >= 0 && left <= DUE_SOON_DAYS;
  });
  const dueSoonAmount = round2(dueSoon.reduce((s, x) => s + x.amount, 0));
  const nextMaturity = D
    .filter((x) => x.maturityDate && x.maturityDate >= todayStr)
    .sort((a, b) => a.maturityDate.localeCompare(b.maturityDate))[0] || null;

  /* ---- 净资产 ---- */
  const bal = round2(accountBalance);
  const cashPositive = round2(Math.max(bal, 0));
  const cashNegative = round2(Math.max(-bal, 0));

  const totalAssets = round2(cashPositive + lentOut + pendingTotal + goldValue);
  const totalLiabilities = round2(cashNegative + borrowedIn);
  const netWorth = round2(totalAssets - totalLiabilities);

  return {
    loans: L,
    openLoans,
    reimbursements: R,
    gold: G,
    deposits: D,
    goldPrice: price,

    borrowedIn,
    lentOut,
    overdueLoans: overdue,
    overdueCount: overdue.length,
    overdueInCount: overdueIn.length,
    overdueOutCount: overdueOut.length,
    overdueInAmount: round2(overdueIn.reduce((s, x) => s + x.amount, 0)),
    overdueOutAmount: round2(overdueOut.reduce((s, x) => s + x.amount, 0)),

    reimbursedTotal,
    pendingTotal,
    pendingCount: pendingR.length,
    reimbursedCount: doneR.length,

    totalGrams,
    goldValue,

    depositTotal,
    depositCount: D.length,
    dueSoonDeposits: dueSoon,
    dueSoonCount: dueSoon.length,
    dueSoonAmount,
    nextMaturity,

    cashPositive,
    cashNegative,
    totalAssets,
    totalLiabilities,
    netWorth,
  };
}

/**
 * 「全局口径」四个小格子的数据（用户选的口径）。
 * 与净资产无关，纯粹是账户 / 记账侧的整体概览。
 *
 * 🔴 v1.13.7：**累计充值 / 累计消耗必须扣掉账户之间的转账**。
 *    这两个数字是把各账户加起来的**全局合计**，而转账会让同一笔钱算两遍：
 *    B 转 200 给 A → A.totalIn +200、B.totalOut +200，可钱从没离开过这个人。
 *    用户 2026-09-24 的口径：「在钱入账的时候已经计算过了的」——
 *    那 200 首次从外部充进 B 时已经算过一次了。
 *    （与 v1.13.7 记账总账那条是同一个道理，见 `account_service.flowToLedger`。）
 *
 *    ⚠️ **单个账户卡片上的 `totalIn` / `totalOut` 不改** ——
 *    那里问的是「这张卡进过多少钱」，250 确实进过，是对的。
 *    错的只是把几个账户简单相加得到的**全局合计**。
 *
 * @param {object} input
 * @param {Array}  input.accounts  全部账户（含 balance / totalIn / totalOut / hasRecurring）
 * @param {Array}  input.ledger    记账流水（用于「本月」口径，当前未用但保留）
 */
export function summarizeOverview({ accounts = [] } = {}) {
  // Account 实例上取 `totalInExternal`（已扣转账）；
  // 传进来的是**普通对象**（测试夹具、外部调用）时退回 `totalIn`，
  // 因为那种输入里根本没有流水，也就无从判断哪条是转账。
  const amountOf = (a, externalKey, plainKey) => {
    const v = a[externalKey] !== undefined ? a[externalKey] : a[plainKey];
    return Number(v) || 0;
  };
  const totalIn = round2(accounts.reduce((s, a) => s + amountOf(a, 'totalInExternal', 'totalIn'), 0));
  const totalOut = round2(accounts.reduce((s, a) => s + amountOf(a, 'totalOutExternal', 'totalOut'), 0));
  const recurringCount = accounts.filter((a) => a.hasRecurring).length;
  const recurringTotal = round2(accounts
    .filter((a) => a.hasRecurring)
    .reduce((s, a) => s + (Number(a.recurring && a.recurring.amount) || 0), 0));
  // 有对账快照、且差额不为 0 的账户数 —— 「账对不上」的账户
  const diffAccounts = accounts.filter((a) => a.lastCheckpoint && Math.abs(Number(a.balanceDiff) || 0) >= 0.005);
  return {
    totalIn,
    totalOut,
    recurringCount,
    recurringTotal,
    diffCount: diffAccounts.length,
    diffTotal: round2(diffAccounts.reduce((s, a) => s + Math.abs(Number(a.balanceDiff) || 0), 0)),
  };
}

export default { ASSET_KEYS, LOAN_DIRECTION, summarizeAssets, summarizeOverview };
