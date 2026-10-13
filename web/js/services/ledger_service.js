/**
 * ledger_service.js —— 记账业务逻辑（v1.3.0）
 *
 * 职责：流水 CRUD、月度汇总、预算读取与进度计算。
 * 预算存 kv store，键 ledger_budget_YYYY-MM，同时有全局兜底键 ledger_budget。
 */

import DatabaseService from './database_service.js';
import { summarize, groupByCategory, DIRECTION } from '../models/ledger_entry.js';
import { formatDate } from '../utils/date_utils.js';

const BUDGET_KEY = (month) => `ledger_budget_${month}`;
const BUDGET_FALLBACK = 'ledger_budget';

export const LedgerService = {
  add(entry) { return DatabaseService.addLedgerEntry(entry); },
  update(entry) { return DatabaseService.updateLedgerEntry(entry); },
  remove(id) { return DatabaseService.removeLedgerEntry(id); },
  all() { return DatabaseService.getLedgerEntries(); },
  byMonth(month) { return DatabaseService.getLedgerByMonth(month); },

  /** 当月概览：汇总 + 预算进度 + 分类占比 */
  async overview(month, today = new Date()) {
    const entries = await DatabaseService.getLedgerByMonth(month);
    const stats = summarize(entries);
    const budget = await this.getBudget(month);
    const isCurrentMonth = formatDate(today).startsWith(month);

    // 预算进度按「已过去天数」推一条参考线，便于判断花得快不快
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const elapsedDays = isCurrentMonth ? today.getDate() : daysInMonth;
    const expectedRate = Math.round((elapsedDays / daysInMonth) * 100);
    const usedRate = budget > 0 ? Math.round((stats.expense / budget) * 100) : 0;

    return {
      month,
      entries,
      stats,
      byCategory: groupByCategory(entries.filter((e) => e.isExpense)),
      incomeByCategory: groupByCategory(entries.filter((e) => !e.isExpense)),
      budget,
      usedRate,
      expectedRate,
      elapsedDays,
      daysInMonth,
      remaining: budget > 0 ? Math.round((budget - stats.expense) * 100) / 100 : 0,
      overBudget: budget > 0 && stats.expense > budget,
      // 花超参考线，且已用 > 60%，提示进度偏快
      aheadOfPace: budget > 0 && usedRate > expectedRate && usedRate > 60,
    };
  },

  /** 取某月预算；该月无预算时回退到全局预算 */
  async getBudget(month) {
    const per = await DatabaseService.getSetting(BUDGET_KEY(month), null);
    if (per != null) return Number(per) || 0;
    const global = await DatabaseService.getSetting(BUDGET_FALLBACK, 0);
    return Number(global) || 0;
  },

  /** 设置某月预算（同时更新全局兜底，让下个月自动继承） */
  async setBudget(month, amount, { asDefault = true } = {}) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) throw new Error('预算必须是不小于 0 的数字');
    await DatabaseService.setSetting(BUDGET_KEY(month), Math.round(n * 100) / 100);
    if (asDefault) await DatabaseService.setSetting(BUDGET_FALLBACK, Math.round(n * 100) / 100);
    return true;
  },

  /** 近 n 个月的支出趋势（用于汇总卡上的迷你柱状图） */
  async trend(months = 6, today = new Date()) {
    const all = await DatabaseService.getLedgerEntries();
    const out = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const inMonth = all.filter((e) => e.month === key);
      const s = summarize(inMonth);
      out.push({ month: key, label: `${d.getMonth() + 1}月`, expense: s.expense, income: s.income, count: s.count });
    }
    return out;
  },

  /** 全部流水导出（含预算），用于设置页备份 */
  async exportJSON() {
    const [entries, incomeCategory] = await Promise.all([
      DatabaseService.getLedgerEntries(),
      Promise.resolve(DIRECTION.INCOME),
    ]);
    const budgets = {};
    for (const e of entries) budgets[e.month] = await this.getBudget(e.month);
    return JSON.stringify({
      app: 'campus_week_calendar',
      kind: 'ledger',
      exported_at: formatDate(new Date()),
      count: entries.length,
      incomeCategory,
      entries: entries.map((e) => e.toJSON()),
      budgets,
    }, null, 2);
  },
};

export default LedgerService;
