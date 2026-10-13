/**
 * asset_test.mjs —— 资产总览模型测试（v1.13.0）
 *
 * 用户诉求（原话）：
 *   「账户里面，新增加如图板块和ui」——
 *   参照图里的「净资产 + 借入借出 + 报销未报销 + 黄金克重 + 定期」。
 *
 * 本文件只测**纯函数**的数学与语义，不碰 DOM、不碰 IndexedDB。
 * 重点钉死这几件事（每一条都对应一个「算错了会很难发现」的坑）：
 *
 *   ① 借入是负债、借出是资产 —— 方向反了净资产就整体偏了 2 倍金额；
 *   ② 只有**未结清**的借贷进合计 —— 已结清还留着会让净资产永远虚高；
 *   ③ 逾期数必须**按方向分开** —— 合成一个数会让借入的逾期去污染借出那一格；
 *   ④ 没填金价时黄金市值为 0，**不能拿克重当钱**；
 *   ⑤ 定期**不计入净资产** —— 那笔钱通常已经在某个账户余额里了，算两遍就重复；
 *   ⑥ 规范化会丢弃坏数据（金额 ≤ 0、日期非法），不会把 NaN 渲染到界面上。
 *
 * 用法：node tests/asset_test.mjs
 */

import {
  summarizeAssets, summarizeOverview, normalizeLoan, normalizeReimbursement,
  normalizeGold, normalizeGoldPrice, normalizeDeposit,
  daysBetween, LOAN_DIRECTION, DUE_SOON_DAYS, ASSET_KEYS,
} from '../web/js/models/asset.js';
import { formatDate } from '../web/js/utils/date_utils.js';

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0; let failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(label, actual, expected) {
  const a = String(actual); const e = String(expected);
  if (a === e) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); } else {
    failed++;
    failures.push({ group: currentGroup, label, actual: a, expected: e });
    console.log(`  \x1b[31m✗\x1b[0m ${label}\n      期望: ${e}\n      实际: ${a}`);
  }
}
function near(label, actual, expected, eps = 0.005) {
  const okVal = Math.abs(Number(actual) - Number(expected)) < eps;
  if (okVal) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); } else {
    failed++;
    failures.push({ group: currentGroup, label, actual: String(actual), expected: `≈${expected}` });
    console.log(`  \x1b[31m✗\x1b[0m ${label}\n      期望: ≈${expected}\n      实际: ${actual}`);
  }
}
const ok = (label, cond, extra = '') => check(label + (extra ? `（${extra}）` : ''), !!cond, true);

/* 基准日固定，避免测试跟着真实时间漂移 */
const TODAY = new Date(2026, 8, 22);   // 2026-09-22
const T = formatDate(TODAY);

/* ---------------- 存储键 ---------------- */

group('存储键：改名等于丢数据');
check('借入借出键名', ASSET_KEYS.LOANS, 'cw_loans');
check('报销键名', ASSET_KEYS.REIMBURSEMENTS, 'cw_reimbursements');
check('黄金键名', ASSET_KEYS.GOLD, 'cw_gold');
check('金价键名', ASSET_KEYS.GOLD_PRICE, 'cw_gold_price');
check('定期键名', ASSET_KEYS.DEPOSITS, 'cw_deposits');
ok('键名都带 cw_ 前缀（避免和月度预算等其它 kv 混）',
  Object.values(ASSET_KEYS).every((k) => k.startsWith('cw_')));

/* ---------------- 规范化 ---------------- */

group('规范化：坏数据一律丢弃，不渲染 NaN');
check('金额为 0 的借入被丢弃', normalizeLoan({ direction: 'in', amount: 0 }), 'null');
check('金额为负的借入取绝对值后保留', normalizeLoan({ direction: 'in', amount: -50 }).amount, 50);
check('金额非数字被丢弃', normalizeLoan({ direction: 'in', amount: 'abc' }), 'null');
check('未知方向回退成借入', normalizeLoan({ amount: 10, direction: 'weird' }).direction, 'in');
check('借出方向保留', normalizeLoan({ amount: 10, direction: 'out' }).direction, 'out');
check('空 dueDate 保持 null（不兜底成今天）', normalizeLoan({ amount: 10, dueDate: '' }).dueDate, 'null');
check('非法 dueDate 也归 null', normalizeLoan({ amount: 10, dueDate: '2026/09/01' }).dueDate, 'null');
check('合法 dueDate 保留', normalizeLoan({ amount: 10, dueDate: '2026-10-01' }).dueDate, '2026-10-01');
check('默认 settled 为 false', normalizeLoan({ amount: 10 }).settled, false);

check('报销金额 0 被丢弃', normalizeReimbursement({ item: 'x', amount: 0 }), 'null');
check('报销事由去空格', normalizeReimbursement({ item: '  打印费  ', amount: 5 }).item, '打印费');
check('报销默认未报', normalizeReimbursement({ item: 'x', amount: 5 }).reimbursed, false);

check('克重 0 被丢弃', normalizeGold({ name: '金条', grams: 0 }), 'null');
check('克重支持三位小数', normalizeGold({ name: '金条', grams: 3.125 }).grams, 3.125);
check('金价 0 视为未填', normalizeGoldPrice(0), 0);
check('金价负数视为未填', normalizeGoldPrice(-5), 0);
check('金价字符串可解析', normalizeGoldPrice('932.81'), 932.81);

check('定期本金 0 被丢弃', normalizeDeposit({ name: 'x', amount: 0 }), 'null');
check('定期利率负数归 0', normalizeDeposit({ name: 'x', amount: 100, rate: -1 }).rate, 0);
check('定期利率保留两位', normalizeDeposit({ name: 'x', amount: 100, rate: 1.755 }).rate, 1.76);

/* ---------------- 借入借出方向 ---------------- */

group('借入是负债、借出是资产（方向不能反）');
{
  const s = summarizeAssets({
    accountBalance: 1000,
    loans: [
      { direction: LOAN_DIRECTION.IN, amount: 300 },
      { direction: LOAN_DIRECTION.OUT, amount: 500 },
    ],
    today: TODAY,
  });
  near('借入合计 300', s.borrowedIn, 300);
  near('借出合计 500', s.lentOut, 500);
  // 1000（现金） + 500（别人欠我） = 1500 资产；300（我欠别人） = 负债
  near('总资产 = 现金 + 借出', s.totalAssets, 1500);
  near('总负债 = 借入', s.totalLiabilities, 300);
  near('净资产 = 1500 − 300', s.netWorth, 1200);
  ok('借出进资产、借入进负债（没被写反）', s.totalAssets > s.totalLiabilities && s.netWorth === 1200);
}

group('已结清的借贷不进合计');
{
  const s = summarizeAssets({
    accountBalance: 0,
    loans: [
      { direction: LOAN_DIRECTION.IN, amount: 300, settled: true },
      { direction: LOAN_DIRECTION.OUT, amount: 500, settled: false },
    ],
    today: TODAY,
  });
  near('已结清的借入不算负债', s.borrowedIn, 0);
  near('未结清的借出仍算资产', s.lentOut, 500);
  near('净资产只剩借出那 500', s.netWorth, 500);
  check('未结清笔数 1', s.openLoans.length, 1);
}

group('逾期按方向分开统计（不能合成一个数）');
{
  const s = summarizeAssets({
    accountBalance: 0,
    loans: [
      { direction: LOAN_DIRECTION.IN, amount: 300, dueDate: '2026-01-01' },   // 已过
      { direction: LOAN_DIRECTION.OUT, amount: 500, dueDate: '2026-12-01' },  // 未到
    ],
    today: TODAY,
  });
  check('总逾期 1 笔', s.overdueCount, 1);
  check('借入逾期 1 笔', s.overdueInCount, 1);
  check('借出逾期 0 笔（不能被借入带偏）', s.overdueOutCount, 0);
  near('借入逾期金额 300', s.overdueInAmount, 300);
  near('借出逾期金额 0', s.overdueOutAmount, 0);
}

group('当天到期算逾期吗 —— 不算');
{
  const s = summarizeAssets({
    loans: [{ direction: LOAN_DIRECTION.IN, amount: 100, dueDate: T }],
    today: TODAY,
  });
  // 约定「今天还」当天还没还，不算逾期；过了才算
  check('约定日 = 今天，不算逾期', s.overdueCount, 0);
  const s2 = summarizeAssets({
    loans: [{ direction: LOAN_DIRECTION.IN, amount: 100, dueDate: '2026-09-21' }],
    today: TODAY,
  });
  check('约定日 = 昨天，算逾期', s2.overdueCount, 1);
}

/* ---------------- 报销 ---------------- */

group('报销 / 未报销');
{
  const s = summarizeAssets({
    accountBalance: 0,
    reimbursements: [
      { item: '打印费', amount: 80, reimbursed: true },
      { item: '团建', amount: 120 },
      { item: '车费', amount: 20, reimbursed: true },
    ],
    today: TODAY,
  });
  near('已报销合计 100', s.reimbursedTotal, 100);
  near('未报销合计 120', s.pendingTotal, 120);
  check('已报销笔数 2', s.reimbursedCount, 2);
  check('未报销笔数 1', s.pendingCount, 1);
  // 垫出去的钱是「别人欠我」，属于资产
  near('未报销进总资产', s.totalAssets, 120);
  near('已报销不进净资产（钱已经回来了）', s.netWorth, 120);
}

/* ---------------- 黄金 ---------------- */

group('黄金：没填金价就不折算');
{
  const gold = [{ name: '金条', grams: 10 }];
  const noPrice = summarizeAssets({ gold, goldPrice: 0, today: TODAY });
  near('没填金价时市值 0（不能拿克重当钱）', noPrice.goldValue, 0);
  near('没填金价时净资产不受影响', noPrice.netWorth, 0);
  near('克重照样统计', noPrice.totalGrams, 10);

  const withPrice = summarizeAssets({ gold, goldPrice: 932.81, today: TODAY });
  near('市值 = 克重 × 金价', withPrice.goldValue, 9328.1);
  near('市值进总资产', withPrice.totalAssets, 9328.1);
  near('净资产跟着涨', withPrice.netWorth, 9328.1);
}

group('黄金：多笔持仓累加');
{
  const s = summarizeAssets({
    gold: [{ grams: 10 }, { grams: 3.125 }, { grams: 0.5 }],
    goldPrice: 100,
    today: TODAY,
  });
  near('总克重 13.625', s.totalGrams, 13.625);
  near('市值 1362.5', s.goldValue, 1362.5);
}

/* ---------------- 定期 ---------------- */

group('定期：只统计，不计入净资产（避免和账户余额重复）');
{
  const mat = '2026-10-10';   // 距 2026-09-22 还有 18 天，落在 30 天窗口内
  const s = summarizeAssets({
    accountBalance: 1000,
    deposits: [{ name: '一年期', amount: 10000, maturityDate: mat }],
    today: TODAY,
  });
  near('定期本金合计 10000', s.depositTotal, 10000);
  check('定期笔数 1', s.depositCount, 1);
  near('净资产只含账户余额 1000（定期不加进来）', s.netWorth, 1000);
  near('总资产也只有 1000', s.totalAssets, 1000);
  check('即将到期 1 笔', s.dueSoonCount, 1);
  near('即将到期金额 10000', s.dueSoonAmount, 10000);
  check('最近到期日', s.nextMaturity.maturityDate, mat);
}

group('定期：到期窗口边界');
{
  const inWindow = summarizeAssets({
    deposits: [{ amount: 1, maturityDate: '2026-10-22' }], today: TODAY,   // +30 天
  });
  check('正好 30 天后到期 → 算即将到期', inWindow.dueSoonCount, 1);
  const outWindow = summarizeAssets({
    deposits: [{ amount: 1, maturityDate: '2026-10-23' }], today: TODAY,   // +31 天
  });
  check('31 天后到期 → 不算', outWindow.dueSoonCount, 0);
  const expired = summarizeAssets({
    deposits: [{ amount: 1, maturityDate: '2026-09-01' }], today: TODAY,
  });
  check('已经到期的 → 不算「即将」到期', expired.dueSoonCount, 0);
  check('已经到期的也不进 nextMaturity', expired.nextMaturity, 'null');
}

/* ---------------- 账户余额为负 ---------------- */

group('账户余额为负时：正负要分开进资产 / 负债');
{
  const s = summarizeAssets({ accountBalance: -250, today: TODAY });
  near('负数余额不进资产', s.cashPositive, 0);
  near('负数余额的绝对值进负债', s.cashNegative, 250);
  near('总资产 0', s.totalAssets, 0);
  near('总负债 250', s.totalLiabilities, 250);
  near('净资产 −250', s.netWorth, -250);
}

/* ---------------- 空输入 ---------------- */

group('空输入不崩、不产生 NaN');
{
  const s = summarizeAssets();
  near('净资产 0', s.netWorth, 0);
  near('总资产 0', s.totalAssets, 0);
  near('总负债 0', s.totalLiabilities, 0);
  check('借入 0', s.borrowedIn, 0);
  check('借出 0', s.lentOut, 0);
  check('总克重 0', s.totalGrams, 0);
  check('定期 0', s.depositTotal, 0);
  check('最近到期 null', s.nextMaturity, 'null');
  ok('所有金额都是有限数', ['netWorth', 'totalAssets', 'totalLiabilities', 'borrowedIn', 'lentOut',
    'goldValue', 'depositTotal'].every((k) => Number.isFinite(s[k])));
}

/* ---------------- 金额精度 ---------------- */

group('金额精度：浮点不能漏出来');
{
  const s = summarizeAssets({
    accountBalance: 0.1,
    loans: [{ direction: LOAN_DIRECTION.OUT, amount: 0.2 }],
    reimbursements: [{ amount: 0.3 }],
    today: TODAY,
  });
  // 0.1 + 0.2 + 0.3 在浮点下是 0.6000000000000001
  near('0.1 + 0.2 + 0.3 = 0.6', s.netWorth, 0.6, 1e-9);
  check('净资产是两位小数', String(s.netWorth).split('.')[1].length <= 2, true);
}

/* ---------------- 全局口径 ---------------- */

group('全局口径（累计充值 / 消耗 / 月扣款 / 对账差额）');
{
  const accounts = [
    { totalIn: 200, totalOut: 12.5, hasRecurring: false, lastCheckpoint: null, balanceDiff: 0 },
    {
      totalIn: 1500,
      totalOut: 300,
      hasRecurring: true,
      recurring: { amount: 1500 },
      lastCheckpoint: { date: '2026-08-01', balance: 100 },
      balanceDiff: 7.5,
    },
    {
      totalIn: 0,
      totalOut: 0,
      hasRecurring: false,
      lastCheckpoint: { date: '2026-08-01', balance: 50 },
      balanceDiff: 0,
    },
  ];
  const ov = summarizeOverview({ accounts });
  near('累计充值 1700', ov.totalIn, 1700);
  near('累计消耗 312.5', ov.totalOut, 312.5);
  check('每月扣款账户数 1', ov.recurringCount, 1);
  near('每月扣款合计 1500', ov.recurringTotal, 1500);
  check('对账有差额的账户数 1（差额 0 的不算）', ov.diffCount, 1);
  near('差额合计 7.5', ov.diffTotal, 7.5);

  const empty = summarizeOverview({});
  check('空账户列表不崩', empty.totalIn, 0);
  check('空列表月扣款 0', empty.recurringCount, 0);
  check('空列表差额 0', empty.diffCount, 0);

  // 🔴 v1.13.7：有 `totalInExternal` 时**必须**用它（转账不算充值）。
  //    这里用的是普通对象而不是 Account 实例 —— 上面那批夹具也是普通对象，
  //    它们没有 entries，所以只能退回 `totalIn`（那条兜底路径也一并钉住）。
  const withExternal = [
    { totalIn: 1126, totalInExternal: 127, totalOut: 430, totalOutExternal: 30, hasRecurring: false, lastCheckpoint: null, balanceDiff: 0 },
    { totalIn: 0, totalInExternal: 0, totalOut: 400, totalOutExternal: 0, hasRecurring: false, lastCheckpoint: null, balanceDiff: 0 },
  ];
  const ov2 = summarizeOverview({ accounts: withExternal });
  near('🔴 有 totalInExternal 时优先用它（127 而不是 1126）', ov2.totalIn, 127);
  near('🔴 有 totalOutExternal 时优先用它（30 而不是 430）', ov2.totalOut, 30);

  // 只有一半字段时各算各的，不能整体退回
  const half = summarizeOverview({
    accounts: [{ totalIn: 500, totalInExternal: 100, totalOut: 60 }],
  });
  near('只给了 totalInExternal → 用 100', half.totalIn, 100);
  near('没给 totalOutExternal → 退回 totalOut 的 60', half.totalOut, 60);
}

/* ---------------- 日期工具 ---------------- */

group('日期工具');
check('daysBetween 跨月', daysBetween('2026-09-22', '2026-10-02'), 10);
check('daysBetween 同一天 0', daysBetween('2026-09-22', '2026-09-22'), 0);
check('daysBetween 负数（过去）', daysBetween('2026-09-22', '2026-09-12'), -10);
check('daysBetween 非法输入返回 null', daysBetween('x', '2026-09-22'), 'null');
check('DUE_SOON_DAYS 是 30', DUE_SOON_DAYS, 30);

/* ---------------- 汇总 ---------------- */

console.log('\n' + '='.repeat(56));
if (failed === 0) {
  console.log(`\x1b[32m全部通过：${passed} 项测试\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${failed} 项 / 共 ${passed + failed} 项\x1b[0m`);
  console.log('\n失败清单：');
  failures.forEach((f) => console.log(`  [${f.group}] ${f.label}\n    期望 ${f.expected} / 实际 ${f.actual}`));
}
console.log('='.repeat(56));

process.exit(failed === 0 ? 0 : 1);
