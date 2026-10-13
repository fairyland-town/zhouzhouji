/**
 * ledger_entry.js —— 记账流水模型（v1.3.0）
 *
 * 字段（与 SQLite 表 ledger 对应）：
 *   id          INTEGER PRIMARY KEY AUTOINCREMENT
 *   amount       REAL NOT NULL     金额，始终存正数，方向由 direction 决定
 *   direction    TEXT NOT NULL     'expense' 支出 | 'income' 收入
 *   category     TEXT NOT NULL     消费分类 id（见下方 LEDGER_CATEGORIES）
 *   note         TEXT              备注 / 商户名
 *   date         TEXT NOT NULL     发生日期 YYYY-MM-DD
 *   created_at   TEXT NOT NULL     录入时间
 *   source       TEXT              录入来源 manual | image | text | account | recurring
 *   account_id   INTEGER           来源账户（v1.7.0）：由「账户」页充值/消费/月扣款镜像过来的流水
 *   account_entry_id TEXT          来源账户内部流水 id（v1.7.0）：用于去重与级联删除
 *
 * 金额一律存正数 + 方向字段，避免负数金额带来的排序与汇总歧义。
 */

import { formatDate, formatDateTime } from '../utils/date_utils.js';

/** 收 / 支方向 */
export const DIRECTION = {
  EXPENSE: 'expense',  // 支出
  INCOME: 'income',    // 收入
};

/**
 * 记账分类。emoji 直接复用为图标，避免为每个分类再引入 SVG。
 * direction 用于「选择支出分类时只显示支出类目」的过滤。
 *
 * v1.7.0：新增「账户充值 / 账户消费」两个系统分类（system: true）。
 * 它们由「账户」页的充值 / 消费 / 每月扣款镜像生成，不该出现在「记一笔」
 * 的分类选择器里，否则用户手动记一笔也能选「账户充值」，账就串了。
 * 所以 ledgerCategoriesOf() 会把这些过滤掉。
 */
export const LEDGER_CATEGORIES = [
  { id: 'meal', label: '餐饮', icon: '🍜', color: '#ea580c', direction: 'expense' },
  { id: 'transport', label: '交通', icon: '🚌', color: '#0891b2', direction: 'expense' },
  { id: 'study', label: '学习', icon: '📚', color: '#1d4ed8', direction: 'expense' },
  { id: 'daily', label: '日用', icon: '🧻', color: '#7c3aed', direction: 'expense' },
  { id: 'entertain', label: '娱乐', icon: '🎮', color: '#db2777', direction: 'expense' },
  { id: 'medical', label: '医疗', icon: '💊', color: '#dc2626', direction: 'expense' },
  { id: 'housing', label: '居住', icon: '🏠', color: '#0d9488', direction: 'expense' },
  { id: 'other_ex', label: '其他支出', icon: '📌', color: '#64748b', direction: 'expense' },
  { id: 'allowance', label: '生活费', icon: '💰', color: '#16a34a', direction: 'income' },
  { id: 'parttime', label: '兼职', icon: '🧾', color: '#15803d', direction: 'income' },
  { id: 'scholarship', label: '奖助学金', icon: '🏅', color: '#ca8a04', direction: 'income' },
  { id: 'other_in', label: '其他收入', icon: '➕', color: '#475569', direction: 'income' },
  // —— 系统分类：由账户流水自动生成，不供手动选择 ——
  { id: 'acct_out', label: '账户消费', icon: '💳', color: '#b45309', direction: 'expense', system: true },
  { id: 'acct_in', label: '账户充值', icon: '🏧', color: '#0f766e', direction: 'income', system: true },
];

const CATEGORY_MAP = Object.fromEntries(LEDGER_CATEGORIES.map((c) => [c.id, c]));

export function getLedgerCategory(id, direction = DIRECTION.EXPENSE) {
  if (CATEGORY_MAP[id]) return CATEGORY_MAP[id];
  return direction === DIRECTION.INCOME ? CATEGORY_MAP.other_in : CATEGORY_MAP.other_ex;
}

/** 按方向过滤可选分类（排除系统分类，它们只由账户流水自动生成） */
export function ledgerCategoriesOf(direction) {
  return LEDGER_CATEGORIES.filter((c) => c.direction === direction && !c.system);
}

export class LedgerEntry {
  constructor({
    id = null,
    amount = 0,
    direction = DIRECTION.EXPENSE,
    category = '',
    note = '',
    date = null,
    createdAt = null,
    source = 'manual',
    accountId = null,
    accountEntryId = null,
  } = {}) {
    this.id = id;
    // 金额存正数；传入负数时取其绝对值，方向交给 direction
    const n = Number(amount);
    this.amount = Number.isFinite(n) ? Math.abs(Math.round(n * 100) / 100) : 0;
    this.direction = direction === DIRECTION.INCOME ? DIRECTION.INCOME : DIRECTION.EXPENSE;
    // 分类必须与方向匹配：收入记录挂到支出类目（或反之）会让月度统计串账，
    // 所以这里兜底到该方向的「其他」类目，而不是原样保留。
    const fallbackCat = this.direction === DIRECTION.INCOME ? 'other_in' : 'other_ex';
    const known = CATEGORY_MAP[category];
    this.category = (known && known.direction === this.direction) ? category : fallbackCat;
    this.note = String(note || '').trim();
    this.rawDate = date == null ? null : String(date).trim();
    this.date = date ? formatDate(new Date(date)) : formatDate(new Date());
    this.createdAt = createdAt
      ? (createdAt instanceof Date ? formatDateTime(createdAt) : String(createdAt))
      : formatDateTime(new Date());
    this.source = String(source || 'manual');
    // v1.7.0：来源账户。非空表示这条流水是「账户」页镜像过来的，
    // 不该在记账页被随手改分类，也不该重复镜像（用 accountEntryId 去重）。
    this.accountId = accountId == null || accountId === '' ? null : Number(accountId);
    this.accountEntryId = accountEntryId ? String(accountEntryId) : null;
  }

  /** 带符号的金额：支出为负、收入为正，用于汇总计算 */
  get signedAmount() {
    return this.direction === DIRECTION.INCOME ? this.amount : -this.amount;
  }

  get isExpense() { return this.direction === DIRECTION.EXPENSE; }

  get categoryMeta() { return getLedgerCategory(this.category, this.direction); }

  /** 形如 "-12.50" / "+3000.00" 的展示串 */
  get amountLabel() {
    const sign = this.isExpense ? '-' : '+';
    return `${sign}${this.amount.toFixed(2)}`;
  }

  get month() { return this.date.slice(0, 7); }

  /** 是否由「账户」页镜像生成（充值 / 消费 / 每月扣款） */
  get fromAccount() { return this.accountId != null; }

  validate() {
    const errors = [];
    if (!this.amount || this.amount <= 0) errors.push('金额必须大于 0');
    if (this.amount > 99999999) errors.push('金额过大');
    // 直接校验原始 date 字符串，不用 this.date —— 构造函数会把非法日期
    // 规范化成今天，那样 error 就永远校验不出来了。
    const raw = this.rawDate;
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      errors.push('日期格式不正确');
    } else {
      // 排除 2026-02-31 这类「格式对但日期不存在」的输入
      const [y, m, dd] = raw.split('-').map(Number);
      const probe = new Date(y, m - 1, dd);
      if (probe.getFullYear() !== y || probe.getMonth() !== m - 1 || probe.getDate() !== dd) {
        errors.push('日期不存在');
      }
    }
    const meta = CATEGORY_MAP[this.category];
    if (!meta) errors.push('请选择记账分类');
    else if (meta.direction !== this.direction) errors.push('分类与收支方向不一致');
    return { ok: errors.length === 0, errors };
  }

  toRecord() {
    return {
      id: this.id,
      amount: this.amount,
      direction: this.direction,
      category: this.category,
      note: this.note,
      date: this.date,
      created_at: this.createdAt,
      source: this.source,
      account_id: this.accountId,
      account_entry_id: this.accountEntryId,
    };
  }

  static fromRecord(rec) {
    if (!rec) return null;
    return new LedgerEntry({
      id: rec.id,
      amount: rec.amount,
      direction: rec.direction,
      category: rec.category,
      note: rec.note,
      date: rec.date,
      createdAt: rec.created_at,
      source: rec.source,
      accountId: rec.account_id,
      accountEntryId: rec.account_entry_id,
    });
  }

  toJSON() {
    return {
      amount: this.amount,
      direction: this.direction,
      category: this.category,
      note: this.note,
      date: this.date,
      created_at: this.createdAt,
      source: this.source,
      ...(this.accountId != null ? { account_id: this.accountId } : {}),
      ...(this.accountEntryId ? { account_entry_id: this.accountEntryId } : {}),
    };
  }
}

/**
 * 汇总一组流水
 * @returns {{expense:number, income:number, balance:number, count:number}}
 */
export function summarize(entries) {
  let expense = 0;
  let income = 0;
  for (const e of entries) {
    if (e.isExpense) expense += e.amount;
    else income += e.amount;
  }
  return {
    expense: Math.round(expense * 100) / 100,
    income: Math.round(income * 100) / 100,
    balance: Math.round((income - expense) * 100) / 100,
    count: entries.length,
  };
}

/** 按分类聚合支出，返回 [{...category, total, count}] 降序 */
export function groupByCategory(entries) {
  const map = new Map();
  for (const e of entries) {
    const cur = map.get(e.category) || { total: 0, count: 0 };
    cur.total += e.amount;
    cur.count += 1;
    map.set(e.category, cur);
  }
  return Array.from(map.entries())
    .map(([id, v]) => ({ ...getLedgerCategory(id), total: Math.round(v.total * 100) / 100, count: v.count }))
    .sort((a, b) => b.total - a.total);
}

export default LedgerEntry;
