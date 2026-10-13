/**
 * asset_service.js —— 资产总览四类明细的读写（v1.13.0）
 *
 * 数据全部走 kv（理由见 models/asset.js 文件头第 1 条），
 * 所以这里每个方法都是「读整份 → 改 → 写回」的简单形态。
 * 数据量是「几十条」级别，不值得为它建索引。
 *
 * 🔴 一个必须守住的纪律：**读回来的东西一律先过 normalize**。
 *    kv 里存的可能是旧版本写进去的、字段不全的 JSON（比如 v1.13 之前没有这个概念），
 *    直接信任它就会在 UI 里渲染出 undefined 金额。
 */

import DatabaseService from './database_service.js';
import {
  ASSET_KEYS, LOAN_DIRECTION,
  normalizeLoan, normalizeReimbursement, normalizeGold, normalizeGoldPrice, normalizeDeposit,
  summarizeAssets, summarizeOverview,
} from '../models/asset.js';
import { formatDate } from '../utils/date_utils.js';

/** 读一个清单键，永远返回数组 */
async function readList(key) {
  const raw = await DatabaseService.getSetting(key, []);
  return Array.isArray(raw) ? raw : [];
}

/** 规范化整份清单，顺便丢掉坏数据 */
async function readNorm(key, norm) {
  return (await readList(key)).map(norm).filter(Boolean);
}

export const AssetService = {
  /* ---------------- 读 ---------------- */

  async loans() { return readNorm(ASSET_KEYS.LOANS, normalizeLoan); },

  async reimbursements() { return readNorm(ASSET_KEYS.REIMBURSEMENTS, normalizeReimbursement); },

  async gold() { return readNorm(ASSET_KEYS.GOLD, normalizeGold); },

  async deposits() { return readNorm(ASSET_KEYS.DEPOSITS, normalizeDeposit); },

  async goldPrice() {
    return normalizeGoldPrice(await DatabaseService.getSetting(ASSET_KEYS.GOLD_PRICE, 0));
  },

  /**
   * 一次读齐，供账户页渲染。
   * @param {number} accountBalance 账户余额合计（净资产要用）
   */
  async snapshot(accountBalance = 0, today = new Date()) {
    const [loans, reimbursements, gold, deposits, goldPrice] = await Promise.all([
      this.loans(), this.reimbursements(), this.gold(), this.deposits(), this.goldPrice(),
    ]);
    return summarizeAssets({
      loans, reimbursements, gold, deposits, goldPrice, accountBalance, today,
    });
  },

  /** 全局口径（累计充值 / 累计消耗 / 每月扣款 / 对账有差额） */
  overview(accounts = []) {
    return summarizeOverview({ accounts });
  },

  /* ---------------- 借入 / 借出 ---------------- */

  async addLoan({ direction = LOAN_DIRECTION.IN, counterparty, amount, date, dueDate = null, note = '' } = {}) {
    const item = normalizeLoan({
      direction, counterparty, amount, date: date || formatDate(new Date()), dueDate, note,
    });
    if (!item) throw new Error('金额必须大于 0');
    const list = await this.loans();
    list.push(item);
    await DatabaseService.setSetting(ASSET_KEYS.LOANS, list);
    return item;
  },

  /** 标记结清 / 取消结清 */
  async settleLoan(id, settled = true) {
    const list = await this.loans();
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error('这笔记录不存在');
    it.settled = Boolean(settled);
    it.settledDate = settled ? formatDate(new Date()) : null;
    await DatabaseService.setSetting(ASSET_KEYS.LOANS, list);
    return it;
  },

  async removeLoan(id) {
    const list = (await this.loans()).filter((x) => x.id !== id);
    await DatabaseService.setSetting(ASSET_KEYS.LOANS, list);
    return true;
  },

  /* ---------------- 报销 / 未报销 ---------------- */

  async addReimbursement({ item, amount, date, reimbursed = false, note = '' } = {}) {
    const rec = normalizeReimbursement({
      item, amount, date: date || formatDate(new Date()), reimbursed, note,
    });
    if (!rec) throw new Error('金额必须大于 0');
    const list = await this.reimbursements();
    list.push(rec);
    await DatabaseService.setSetting(ASSET_KEYS.REIMBURSEMENTS, list);
    return rec;
  },

  /** 标记已报销 / 撤回 */
  async markReimbursed(id, reimbursed = true) {
    const list = await this.reimbursements();
    const it = list.find((x) => x.id === id);
    if (!it) throw new Error('这笔记录不存在');
    it.reimbursed = Boolean(reimbursed);
    it.reimbursedDate = reimbursed ? formatDate(new Date()) : null;
    await DatabaseService.setSetting(ASSET_KEYS.REIMBURSEMENTS, list);
    return it;
  },

  async removeReimbursement(id) {
    const list = (await this.reimbursements()).filter((x) => x.id !== id);
    await DatabaseService.setSetting(ASSET_KEYS.REIMBURSEMENTS, list);
    return true;
  },

  /* ---------------- 黄金 ---------------- */

  async addGold({ name, grams, note = '' } = {}) {
    const it = normalizeGold({ name, grams, note });
    if (!it) throw new Error('克重必须大于 0');
    const list = await this.gold();
    list.push(it);
    await DatabaseService.setSetting(ASSET_KEYS.GOLD, list);
    return it;
  },

  async removeGold(id) {
    const list = (await this.gold()).filter((x) => x.id !== id);
    await DatabaseService.setSetting(ASSET_KEYS.GOLD, list);
    return true;
  },

  async setGoldPrice(price) {
    const p = normalizeGoldPrice(price);
    await DatabaseService.setSetting(ASSET_KEYS.GOLD_PRICE, p);
    return p;
  },

  /* ---------------- 定期 ---------------- */

  async addDeposit({ name, amount, rate = 0, startDate, maturityDate = null, note = '' } = {}) {
    const it = normalizeDeposit({
      name, amount, rate, startDate: startDate || formatDate(new Date()), maturityDate, note,
    });
    if (!it) throw new Error('本金必须大于 0');
    const list = await this.deposits();
    list.push(it);
    await DatabaseService.setSetting(ASSET_KEYS.DEPOSITS, list);
    return it;
  },

  async removeDeposit(id) {
    const list = (await this.deposits()).filter((x) => x.id !== id);
    await DatabaseService.setSetting(ASSET_KEYS.DEPOSITS, list);
    return true;
  },

  /* ---------------- 清空（设置页「清空数据 → 账户」用） ---------------- */

  /** 四类明细 + 金价全部归零。返回清掉的条目数 */
  async clearAll() {
    const counts = await Promise.all([
      this.loans(), this.reimbursements(), this.gold(), this.deposits(),
    ]);
    const n = counts.reduce((s, arr) => s + arr.length, 0);
    await Promise.all([
      DatabaseService.setSetting(ASSET_KEYS.LOANS, []),
      DatabaseService.setSetting(ASSET_KEYS.REIMBURSEMENTS, []),
      DatabaseService.setSetting(ASSET_KEYS.GOLD, []),
      DatabaseService.setSetting(ASSET_KEYS.DEPOSITS, []),
      DatabaseService.setSetting(ASSET_KEYS.GOLD_PRICE, 0),
    ]);
    return n;
  },
};

export default AssetService;
