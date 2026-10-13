/**
 * money.js —— 金额 / 克重的显示格式化
 *
 * 🔴 为什么单独抽成一个模块：账户页和「设置 → 黄金持仓」都要格式化金额。
 *    各写一份的话，迟早出现「同一个数在两处显示得不一样」——
 *    用户看到两个不一样的数字，第一反应是「钱算错了」。
 *
 * 只负责**显示**。所有算术都在 services/asset_service.js 里，
 * 这里不做任何四舍五入以外的计算。
 */

import { PATTERNS } from './regex_patterns.js';

/**
 * 金额格式化：¥1,234.50
 *
 * 千分位不是装饰。净资产是账户页的头号数字，动辄四五位，
 * 没有分隔符时「¥10620.00」要一位一位数才读得出来。
 * 负数写成 `-¥100.00`（符号在币号前），符合中文书写习惯。
 */
export function money(n) {
  const v = Number(n) || 0;
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const grouped = int.replace(PATTERNS.MONEY_GROUP, ',');
  return `${v < 0 ? '-' : ''}¥${grouped}.${dec}`;
}

/** 克重格式化：去掉无意义的小数尾巴（10 而不是 10.000） */
export function grams(n) {
  const v = Number(n) || 0;
  return `${Number(v.toFixed(3))} 克`;
}

/**
 * 金额「短格式」：不带币号、不带千分位，去掉无意义的小数尾巴。
 *
 *   42.50 → 42.5      200.00 → 200      96.80 → 96.8      385 → 385
 *
 * 🔴 为什么需要它（v1.13.5）：流水明细照参考图改版后，右侧只剩一个数字，
 *    和分类名同一行。这时候 `¥42.50` 里的 `¥` 和 `.00` 全是噪音 ——
 *    满屏 `.00` 会把真正带小数的那几笔（42.5 / 96.8）淹掉，
 *    而那几笔恰恰是最需要被看见的。
 *    千分位也一并去掉：这里单个数字都很短（月流水量级），加了逗号反而更花。
 *
 * ⚠️ 这是**显示**格式，不要拿它的输出去做算术或比较 —— 它是有损的。
 *    需要算术时用 `round2()`（models/ledger_entry.js）。
 */
export function amountShort(n) {
  const v = Number(n) || 0;
  return String(Number(Math.abs(v).toFixed(2)));
}

/**
 * 带正负号的短格式：支出 `-42.5` / 收入 `+500`。
 *
 * 🔴 符号由**调用方传入的 isExpense** 决定，不是看数字的正负 ——
 *    库里存的 `amount` 永远是正数（方向另存在 `direction` 字段里），
 *    如果这里按 `v < 0` 判断，收入会被显示成 `+500` 而支出也变成 `+42.5`。
 */
export function signedAmount(n, isExpense) {
  return `${isExpense ? '-' : '+'}${amountShort(n)}`;
}
