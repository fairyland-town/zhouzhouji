/**
 * account_service.js —— 账户余额业务逻辑（v1.5.0）
 *
 * 职责：账户 CRUD、充值/消费、对账快照、余额汇总。
 * 核心目的（用户原话）：不把「我还剩多少钱」全托付给第三方平台，
 * 自己算一遍，才能发现钱被误扣 / 漏记。
 */

import DatabaseService from './database_service.js';
import {
  Account, ACCOUNT_FLOW, BALANCE_MODE, summarizeAccounts, addRunNote,
} from '../models/account.js';
import { LedgerEntry, DIRECTION } from '../models/ledger_entry.js';
import { formatDate } from '../utils/date_utils.js';

/**
 * 账户流水 → 记账流水的映射（v1.7.0，v1.9.0 收窄到只镜像充值）
 *
 * v1.7.0 原话：「我往卡里冲了多少钱，那么账单显示我这一笔钱花了多少钱往哪里冲」
 * 当时的做法是充值、消费都镜像进记账页。
 *
 * v1.9.0 用户改了主意：「避免重复计算，然后账户里面的消费不用走记账总账，
 * 只有充值的时候会记录在记账总账」——
 * 日常消费本来就在记账页自己记一份，账户侧再镜像一次就是**同一笔钱入账两遍**，
 * 月度支出会凭空翻倍。所以：
 *   · 账户**充值** → `acct_in` 收入（记账页能看到「钱从哪儿充进来的」）
 *   · 账户**消费** → **不镜像**（返回 null）
 * 每月扣款在用户看来也是「充值」（钱从活期划进这张卡），照旧镜像。
 *
 * 🔴 v1.13.7：**账户之间的转账也不镜像**（用户 2026-09-24）——
 *    「账户与账户之间的转账不计入收入，因为，在钱入账的时候已经计算过了的」。
 *    转账只是钱在自己名下的两张卡之间挪，总资产分文未变；那笔钱**首次入账**
 *    （充值）时已经在记账页算过一次收入了，再算一次就是同一笔钱算两遍 ——
 *    跟 v1.9.0 要消灭的「消费镜像」是同一类错误。
 *    判据是 `linkedAccountId`：**只有 `transfer()` 会写这个字段**，
 *    外部充值（`recharge`）和每月扣款（`runDueRecurring`）都不写，
 *    所以它等价于「这条流水是转账的一半」。
 *
 * @returns {LedgerEntry|null} null 表示这条流水不需要进记账总账
 */
function flowToLedger(a, e, { source = 'account' } = {}) {
  if (e.kind !== ACCOUNT_FLOW.IN) return null;   // v1.9.0：只有充值进总账
  // v1.13.7：转账的转入侧不进总账（转出侧上面那行已经拦掉了）
  if (e.linkedAccountId !== null && e.linkedAccountId !== undefined) return null;
  return new LedgerEntry({
    amount: e.amount,
    direction: DIRECTION.INCOME,
    category: 'acct_in',
    // 备注里带上账户名，否则账单上只看到「账户充值 500 元」，不知道充到哪张卡
    note: e.note ? `${a.name} · ${e.note}` : a.name,
    date: e.date,
    source,
    accountId: a.id,
    accountEntryId: e.id,
  });
}

export const AccountService = {
  list() { return DatabaseService.getAccounts(); },

  get(id) { return DatabaseService.getAccountById(id); },

  /**
   * 新建账户。
   * @param {{name:string,type?:string,opening?:number,openingDate?:string,note?:string}} data
   */
  create(data) {
    const acc = new Account({
      name: data.name,
      type: data.type,
      balanceMode: data.balanceMode || BALANCE_MODE.TRACKED,
      opening: data.opening != null ? data.opening : 0,
      openingDate: data.openingDate || null,
      note: data.note || '',
    });
    const check = acc.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    return DatabaseService.addAccount(acc);
  },

  update(acc) {
    const check = acc.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    return DatabaseService.updateAccount(acc);
  },

  remove(id) { return DatabaseService.removeAccount(id); },

  /**
   * 删除账户，并清掉它在记账页留下的所有镜像流水（v1.7.0）。
   * 不清理的话，记账页会留下一堆「账户充值 / 账户消费」但已经没有对应账户的记录。
   */
  async removeWithLedger(id) {
    try {
      const all = await DatabaseService.getLedgerEntries();
      const mine = all.filter((e) => e.accountId === Number(id));
      for (const e of mine) await DatabaseService.removeLedgerEntry(e.id);
    } catch (err) {
      console.warn('[account_service] 清理记账镜像失败：', err && err.message);
    }
    return this.remove(id);
  },

  /** 归档 / 取消归档（归档账户不参与总额，但数据保留） */
  async setArchived(id, archived) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');
    acc.archived = Boolean(archived);
    await this.update(acc);
    return acc;
  },

  /**
   * 记一笔充值或消费，并同步镜像到记账流水（v1.7.0）。
   *
   * 镜像失败不回滚账户流水 —— 账户余额是用户的核心数据，
   * 不能因为附加的记账写入失败就让用户的输入丢掉。失败只打日志。
   *
   * @param {number} id
   * @param {{kind:'in'|'out', amount:number, date?:string, note?:string, source?:string}} payload
   */
  async addEntry(id, payload) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');
    // addEntry 内部会生成 entry.id；让它返回新条目，拿 id 去记账页建镜像。
    const entry = acc.addEntryWithId(payload);
    await this.update(acc);
    await this._mirrorToLedger(acc, entry, { source: (payload && payload.source) || 'account' });
    return acc;
  },

  /**
   * 把账户流水镜像成一条记账流水。
   * 用 (accountId, accountEntryId) 去重，重复调用不会产生多条。
   *
   * v1.9.0：只有充值会进来（消费由 flowToLedger 返回 null 拦掉）。
   */
  async _mirrorToLedger(acc, entry, { source = 'account' } = {}) {
    if (!entry) return null;
    try {
      const payload = flowToLedger(acc, entry, { source });
      if (!payload) return null;              // 消费不镜像（v1.9.0）
      const all = await DatabaseService.getLedgerEntries();
      const dup = all.find((e) => e.accountId === acc.id && e.accountEntryId === entry.id);
      if (dup) {
        // 已存在则同步金额/备注/日期（比如用户改了备注），避免两边显示不一致
        dup.amount = entry.amount;
        dup.date = entry.date;
        dup.note = payload.note;
        await DatabaseService.updateLedgerEntry(dup);
        return dup.id;
      }
      return await DatabaseService.addLedgerEntry(payload);
    } catch (err) {
      // 镜像失败不影响账户本身，但要让开发者看得见
      console.warn('[account_service] 镜像到记账流水失败：', err && err.message);
      return null;
    }
  },

  /**
   * 清掉账户在记账页留下的**全部**镜像流水（v1.9.0 清理历史数据用）。
   *
   * v1.9.0 起账户「消费」不再进记账总账，但 v1.7.0–v1.8.x 期间已经镜像过去的
   * `acct_out`/`acct_in` 支出记录还留在库里。这些正是「重复计算」的源头，
   * 进记账页时顺手清一次，之后由 `kv` 标记保证只跑一次。
   *
   * 只按 `accountId` 判定归属，并且**必须 `source === 'account'`** ——
   * 用户手动记的流水 `accountId` 为 null，不会被误删。
   * 重新注意：**这会删掉历史上账户消费留下的记账记录**，是用户明确要求的清理。
   */
  async purgeAcctLedgerMirrors() {
    const KEY = 'ledger_acct_mirror_purged_v109';
    try {
      const done = await DatabaseService.getSetting(KEY);
      if (done) return { purged: 0, skipped: true };
      const all = await DatabaseService.getLedgerEntries();
      // 只清「账户侧支出镜像」：充值镜像（acct_in）保留，用户要的就是它
      const mine = all.filter((e) => e.category === 'acct_out' && e.source === 'account');
      for (const e of mine) await DatabaseService.removeLedgerEntry(e.id);
      await DatabaseService.setSetting(KEY, true);
      return { purged: mine.length, skipped: false };
    } catch (err) {
      console.warn('[account_service] 清理账户消费镜像失败：', err && err.message);
      return { purged: 0, skipped: false };
    }
  },

  /**
   * 清掉历史上「账户间转账」留下的记账镜像（v1.13.7 一次性清理）。
   *
   * v1.13.5 加「关联账户 = 转账」时，转入侧还是照充值的老路子镜像进了记账总账，
   * 于是「微信零钱 → 饭卡 200」会在记账页多出一笔 200 收入 ——
   * 而 200 早在零钱**充值进来**那次就算过收入了，等于同一笔钱算两遍。
   * 用户 2026-09-24 明确要求「转账不计入收入」，`flowToLedger` 已拦掉新的，
   * 这里负责把**已经写进库里的**那些清掉，否则用户的收入总额会一直偏高。
   *
   * 判定链路：记账镜像身上带 `accountId` + `accountEntryId` →
   * 顺着去账户里找那条流水 → 它有 `linkedAccountId` 就说明是转账的一半。
   * ⚠️ 不能只看 `category === 'acct_in'`：外部充值镜像也是这个分类，
   *    那是用户**要**的，删了就把收入删没了。
   *
   * ⚠️ 只删记账侧，**账户流水原样保留** —— 转账两条流水是余额的事实依据，
   *    动它们会让两个账户的余额同时对不上。
   *    （与 `unlinkLedgerEverywhere` 不同：那个是「撤挂账」，会把账户流水一起删掉，
   *      这里绝不能走它。）
   */
  async purgeTransferLedgerMirrors() {
    const KEY = 'ledger_transfer_mirror_purged_v1137';
    try {
      const done = await DatabaseService.getSetting(KEY);
      if (done) return { purged: 0, skipped: true };

      const all = await DatabaseService.getLedgerEntries();
      const accounts = await this.list();
      const accById = new Map(accounts.map((a) => [a.id, a]));

      const doomed = all.filter((e) => {
        if (e.category !== 'acct_in' || e.source !== 'account') return false;
        const acc = accById.get(e.accountId);
        if (!acc) return false;
        const entry = acc.entries.find((x) => x.id === e.accountEntryId);
        return !!(entry && entry.linkedAccountId !== null && entry.linkedAccountId !== undefined);
      });

      for (const e of doomed) await DatabaseService.removeLedgerEntry(e.id);
      await DatabaseService.setSetting(KEY, true);
      return { purged: doomed.length, skipped: false };
    } catch (err) {
      console.warn('[account_service] 清理转账记账镜像失败：', err && err.message);
      return { purged: 0, skipped: false };
    }
  },

  /** 删掉某条账户流水对应的记账流水（级联，避免账单里留下幽灵记录） */
  async _unmirrorFromLedger(accountId, entryId) {
    try {
      const all = await DatabaseService.getLedgerEntries();
      // 可能同时存在旧版留下的 acct_out 与新的 acct_in，一并清掉
      const hits = all.filter((e) => e.accountId === accountId && e.accountEntryId === entryId);
      for (const hit of hits) await DatabaseService.removeLedgerEntry(hit.id);
      return hits.length > 0;
    } catch (err) {
      console.warn('[account_service] 取消记账镜像失败：', err && err.message);
      return false;
    }
  },

  /**
   * 删掉一条账户流水。
   *
   * 🔴 v1.13.5：如果这条是**转账**的一半，必须把对方那条一起撤掉。
   *    只删一半会留下「钱从 A 出去了、但 B 没收到」的半截账 ——
   *    两边余额各自看起来都「算得通」，只有把两个账户放在一起看才发现少了 200。
   *    （用户 2026-09-23 第 3 条：充值可以关联账户 = 转账）
   */
  async removeEntry(id, entryId) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');

    // 先记下对方是谁 —— removeEntry 之后这条就没了，查不到了
    const doomed = acc.entries.find((e) => e.id === entryId);
    const peerAccId = doomed ? doomed.linkedAccountId : null;
    const peerEntryId = doomed ? doomed.linkedEntryId : null;

    acc.removeEntry(entryId);
    await this.update(acc);
    await this._unmirrorFromLedger(acc.id, entryId);

    // 撤对方那条。对方账户可能已经被删了，那就没什么可撤的
    if (peerAccId != null && peerEntryId) {
      try {
        const peer = await this.get(peerAccId);
        if (peer && peer.removeEntry(peerEntryId)) {
          await this.update(peer);
          await this._unmirrorFromLedger(peer.id, peerEntryId);
        }
      } catch (err) {
        console.warn('[account_service] 撤销转账的另一半失败：', err && err.message);
      }
    }
    return acc;
  },

  /**
   * 账户之间转账（v1.13.5）。
   *
   * 入口：账户页给 A「充值」时，在「这笔钱的来源」那一步多选一个**关联账户 B**，
   * 语义就是「从 B 转进 A」（用户 2026-09-23 第 3 条确认的口径）。
   *
   * 落两条流水，互相引用：
   *   · 目标账户 A：IN  amount，备注 = 用户填的来源
   *   · 来源账户 B：OUT amount，备注 = 「转给「A」」
   *
   * ⚠️ **转账一条都不进记账总账**（v1.13.7，用户 2026-09-24）：
   *    「账户与账户之间的转账不计入收入，因为，在钱入账的时候已经计算过了的」。
   *    钱只是在自己名下的两张卡之间挪，总资产没变 —— 那笔钱**首次充值进来**时
   *    记账页已经算过一次收入，转账再算一次就是同一笔钱算两遍。
   *    下面那行 `_mirrorToLedger` 现在必然返回 null（由 `flowToLedger` 拦下），
   *    留着它是为了让「所有镜像都走同一个门」，别在这里另开一条路。
   *
   * @returns {{inEntry:object, outEntry:object, to:object, from:object}}
   */
  async transfer({ fromId, toId, amount, date = null, note = '' } = {}) {
    if (fromId == null || toId == null) throw new Error('请选择要转出的账户');
    if (Number(fromId) === Number(toId)) throw new Error('不能从同一个账户转入');
    // 只做「大于 0」的校验；四舍五入交给 normalizeEntry（两侧同一个函数，不会算出两个数）
    const n = Math.abs(Number(amount));
    if (!Number.isFinite(n) || n <= 0) throw new Error('金额必须大于 0');

    const from = await this.get(fromId);
    const to = await this.get(toId);
    if (!from) throw new Error('转出账户不存在');
    if (!to) throw new Error('转入账户不存在');

    const d = date || formatDate(new Date());

    const inEntry = to.addEntryWithId({
      kind: ACCOUNT_FLOW.IN,
      amount: n,
      date: d,
      note: note || `从「${from.name}」转入`,
      linkedAccountId: from.id,
    });
    const outEntry = from.addEntryWithId({
      kind: ACCOUNT_FLOW.OUT,
      amount: n,
      date: d,
      note: `转给「${to.name}」`,
      linkedAccountId: to.id,
    });
    // 两条互相指认。⚠️ 必须在 update() **之前**赋值 ——
    //    update 会把 entries 序列化落库，之后再改就只改到内存里那份。
    inEntry.linkedEntryId = outEntry.id;
    outEntry.linkedEntryId = inEntry.id;

    await this.update(to);
    await this.update(from);
    // 走一趟镜像流程，但转账会被 `flowToLedger` 拦下（返回 null）——
    // 见上面 transfer 的注释：转账不是收支，一条都不该进记账总账。
    await this._mirrorToLedger(to, inEntry, { source: 'account' });

    return { inEntry, outEntry, to, from };
  },

  /**
   * 对账：把平台显示的余额抄进来，系统会算出与推导值的差额。
   * @param {number} id
   * @param {{balance:number, date?:string, note?:string}} payload
   */
  async checkpoint(id, payload) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');
    acc.addCheckpoint(payload);
    await this.update(acc);
    return acc;
  },

  /** 重命名 */
  async rename(id, name) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');
    acc.name = String(name || '').trim();
    const check = acc.validate();
    if (!check.ok) throw new Error(check.errors.join('；'));
    await this.update(acc);
    return acc;
  },

  /* ---------------- 每月定时扣款（v1.7.0） ---------------- */

  /**
   * 设置 / 修改 / 关闭每月扣款。
   *
   * v1.9.0 语义（用户明确要求「不是设置了立即扣除」）：
   *   · **设置当时绝不扣款**，只在「每月 N 号」那天及之后执行；
   *     设置日在扣款日之前 → 本月到日子就扣；设置日已过扣款日 → 本月不管，下月再扣。
   *   · **`since` 一旦打上就不再改写**。重新设置只改金额/日期/备注时，
   *     不能把起点推到本月，否则本月本来就该扣的那期会被悄悄跳过。
   *   · **错过的一律补上、不设上限**（用户确认）：几个月没打开 App，
   *     回来时那几期逐月补齐 —— 房租本来就是要交的。
   *
   * @param {number} id
   * @param {{enabled?:boolean, day?:number, amount?:number, note?:string, kind?:'in'|'out'}} cfg
   */
  async setRecurring(id, cfg = {}) {
    const acc = await this.get(id);
    if (!acc) throw new Error('账户不存在');
    const cur = acc.recurring || {};
    const wasEnabled = Boolean(cur.enabled);

    // 走一遍 fromRecord(toRecord()) 让模型的 normalizeRecurring 统一兜底：
    // day 夹到 1–28、amount 取正、kind 只允许 in/out、since/lastRun 格式校验。
    const probe = Account.fromRecord({
      ...acc.toRecord(),
      recurring: { ...cur, ...cfg },
    });
    const now = new Date();
    const next = probe.recurring;

    if (next.enabled) {
      if (!(next.amount > 0)) throw new Error('每月扣款金额必须大于 0');
      const ym = formatDate(now).slice(0, 7);

      if (!wasEnabled) {
        // 首次启用：起点钉在本月。
        // 若「今天」已经过了本月扣款日，本月那期就是用户主动放弃的
        // （规则 1：不立即扣，等下月那天）。用 sinceSkip 记住，
        // 这样 dueRecurring 从 since 起扫时不会把它补出来。
        next.since = ym;
        next.lastRun = null;
        next.runCount = 0;
        next.sinceSkip = next.day < now.getDate();
      } else {
        // 已启用：since / sinceSkip 原地保留（这是「重新设置不能刷新起点」的关键）
        next.since = cur.since || ym;
        next.sinceSkip = Boolean(cur.sinceSkip);
        next.runCount = Number(cur.runCount) || 0;
        // 金额变了 → 期数从 1 重新计；只是改日期/备注则继续往下数
        if (Number(cur.amount) !== Number(next.amount)) next.runCount = 0;
      }
    } else {
      // 关闭后清掉所有进度，下次重新打开能从零开始
      next.lastRun = null;
      next.since = null;
      next.runCount = 0;
      next.sinceSkip = false;
    }

    acc.recurring = next;
    await this.update(acc);
    return acc;
  },

  /** 关闭某账户的每月扣款 */
  async clearRecurring(id) {
    return this.setRecurring(id, { enabled: false });
  },

  /**
   * 把所有已到期但还没执行的每月扣款跑一遍，补进账户流水
   * （充值会顺带镜像到记账总账，消费不镜像 —— v1.9.0）。
   *
   * 幂等：靠 recurring.lastRun 记月份，同一个月重复调用不会重复扣；
   * 条数上限靠 recurring.runCount（见 dueRecurring 的说明），防止重复计算。
   *
   * 在每次进入「账户」页时调用，这样用户隔了两个月再打开，两个月的扣款都会补上。
   *
   * @returns {{runs:Array<{accountId:number, name:string, month:string, amount:number}>}}
   */
  async runDueRecurring(today = new Date()) {
    const all = await this.list();
    const runs = [];
    for (const a of all) {
      if (a.archived || !a.hasRecurring) continue;
      const due = a.dueRecurring(today);
      if (!due.length) continue;
      // 记下本次新建的流水 id —— 不能用「日期相同」去反查，
      // 那样会把用户当天手记的流水也一起镜像成「每月扣款」。
      const created = [];
      for (const d of due) {
        a.recurring.runCount = (Number(a.recurring.runCount) || 0) + 1;
        created.push(a.addEntryWithId({
          kind: d.kind, amount: d.amount, date: d.date,
          note: addRunNote(d.note || '每月扣款', a.recurring.runCount, d.total),
        }));
        runs.push({ accountId: a.id, name: a.name, month: d.month, amount: d.amount });
      }
      a.markRecurringRun(due[due.length - 1].month);
      await this.update(a);
      // 逐笔镜像（充值方向的月扣款会进记账总账，出账的不会）
      for (const e of created) {
        await this._mirrorToLedger(a, e, { source: 'recurring' });
      }
    }
    return { runs };
  },

  /**
   * 把某条记账流水挂到账户上：记账里选了「消费账户」时调用。
   *
   * 用户诉求（2026-09-23）：「在记账的时候多一个可选的消费账户选项，
   * 直接从对应的消费账户里面扣钱」。
   * 口径（用户确认）：「扣余额 + 计入账户累计消耗」——
   * 选了账户就**真扣**，并且那笔钱同时算进该账户的「累计消耗」。
   * 记账总账里**仍然只有这一笔**，不额外镜像，避免同一笔钱算两遍。
   *
   * 🔴 关联写在**账户这一侧**（账户内部流水挂 `ledgerId`），
   *    而不是给记账流水写 `account_id`。因为 `account_id` 的语义是
   *    「这条流水是账户页镜像过来的」（见 LedgerEntry.fromAccount），
   *    写了它，记账页就会把它标成「来自账户 · 充值」，还会把
   *    「编辑 / 删除」入口锁掉、让用户回账户页操作 ——
   *    可这笔本来就是用户在记账页手记的，必须能在这里改、在这里删。
   *
   * 幂等：先撤掉这条记账流水身上所有的旧挂账（含同一个账户上的旧条目），
   * 所以重复保存 / 换账户 / 改金额都不会叠加出第二条扣款。
   */
  async linkLedger(accountId, entry) {
    if (!entry || entry.id == null) throw new Error('这条记账流水还没保存，不能挂账户');
    await this.unlinkLedgerEverywhere(entry.id);
    const acc = await this.get(accountId);
    if (!acc) throw new Error('账户不存在');
    acc.addEntryWithId({
      kind: entry.isExpense ? ACCOUNT_FLOW.OUT : ACCOUNT_FLOW.IN,
      amount: entry.amount,
      date: entry.date,
      note: entry.note || '来自记账',
      ledgerId: entry.id,
    });
    await this.update(acc);
    return acc;
  },

  /**
   * 这条记账流水挂在哪些账户上。
   * 正常最多 1 个（一条记账只挂一个账户）；返回数组是为了能顺手自愈
   * 历史脏数据 —— 万一真的挂了两处，`unlinkLedgerEverywhere` 能一次清干净。
   */
  async findLedgerLinks(ledgerId) {
    if (ledgerId === null || ledgerId === undefined) return [];
    const key = String(ledgerId);
    const all = await this.list();
    const out = [];
    for (const a of all) {
      for (const e of a.entries) {
        if (e.ledgerId !== null && e.ledgerId !== undefined && String(e.ledgerId) === key) {
          out.push({ accountId: a.id, accountName: a.name, entry: e });
        }
      }
    }
    return out;
  },

  /**
   * 撤掉这条记账流水在所有账户上的挂账（幂等）。
   *
   * 🔴 删记账 / 换账户 / 保存时都必须走它。
   *    漏了的话，账户余额会留下一个「记账里已经删掉、但钱还在扣」的幽灵支出 ——
   *    用户永远找不到它，只能靠对账差额去猜（正是本项目最想消灭的那类问题）。
   */
  async unlinkLedgerEverywhere(ledgerId) {
    const links = await this.findLedgerLinks(ledgerId);
    let n = 0;
    for (const l of links) {
      const acc = await this.get(l.accountId);
      if (!acc) continue;
      if (acc.removeEntry(l.entry.id)) {
        await this.update(acc);
        n += 1;
      }
    }
    return n;
  },

  /** ledgerId → 账户名。供记账列表显示「这笔钱从哪个账户走的」 */
  async linkedAccountNames() {
    const all = await this.list();
    const map = new Map();
    for (const a of all) {
      for (const e of a.entries) {
        if (e.ledgerId !== null && e.ledgerId !== undefined) map.set(String(e.ledgerId), a.name);
      }
    }
    return map;
  },

  /** 汇总形态，供账户列表 UI 使用 */
  async board() {
    const all = await this.list();
    return summarizeAccounts(all);
  },

  /** 导出用：全部账户（含内部流水与对账快照） */
  async exportJSON() {
    const all = await this.list();
    return JSON.stringify({
      app: 'campus_week_calendar',
      kind: 'accounts',
      count: all.length,
      accounts: all.map((a) => a.toJSON()),
    }, null, 2);
  },
};

export default AccountService;
