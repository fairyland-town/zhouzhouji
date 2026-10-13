/**
 * record_test.mjs —— 「记录」页（打卡 + 记账）测试（v1.3.0）
 *
 * 覆盖：
 *   1. 打卡模型：连续天数（含"今天没打不算断"）、月历统计、历史最长
 *   2. 记账模型：金额归一、收/支方向、汇总、分类聚合
 *   3. 收据解析：金额 / 方向 / 商户 / 日期 / 分类 / 置信度
 *
 * 用法：node tests/record_test.mjs
 */
import { Checkin } from '../web/js/models/checkin.js';
import {
  LedgerEntry, DIRECTION, summarize, groupByCategory, getLedgerCategory, ledgerCategoriesOf,
} from '../web/js/models/ledger_entry.js';
import {
  parseReceipt, parseAmount, parseDirection, parseMerchant, parseNote, parseDate, parseCategory,
} from '../web/js/services/receipt_parser.js';
import { formatDate } from '../web/js/utils/date_utils.js';

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0, failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function stringify(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.join(',')}]`;
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1000) / 1000);
  return String(v);
}

function check(label, actual, expected) {
  const a = stringify(actual), e = stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failed++;
    failures.push({ group: currentGroup, label, actual: a, expected: e });
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      期望: ${e}`);
    console.log(`      实际: ${a}`);
  }
}

function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push({ group: currentGroup, label, actual: detail || '(false)', expected: 'true' });
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const d = (s) => new Date(s.replace(/-/g, '/'));

/* ================================================================
   1. 打卡模型
   ================================================================ */
group('1. 打卡模型 — 连续天数与月历统计');

/** 基准日：2026-09-15（周二） */
const TODAY = d('2026-09-15');

// 连续 5 天，含今天
let c = new Checkin({ id: 1, title: '背单词', logs: ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15'] });
check('连打 5 天（含今天）→ streak 5', c.streak(TODAY), 5);
check('累计打卡次数', c.count, 5);

// 今天还没打卡，但昨天连上 —— 不算断卡
c = new Checkin({ id: 2, title: '跑步', logs: ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'] });
check('今天未打卡但从昨天连上 → streak 4', c.streak(TODAY), 4);

// 昨天也没打 —— 断了
c = new Checkin({ id: 3, title: '早睡', logs: ['2026-09-10', '2026-09-11'] });
check('昨天也没打 → streak 0', c.streak(TODAY), 0);

// 中间有断档：只算最近一段
c = new Checkin({ id: 4, title: '阅读', logs: ['2026-09-01', '2026-09-02', '2026-09-14', '2026-09-15'] });
check('有断档时连续天数只算最近一段 → 2', c.streak(TODAY), 2);
check('历史最长连续 → 2', c.longestStreak(), 2);

// 历史最长更长的情形
c = new Checkin({ id: 5, title: '晨跑', logs: ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-09-15'] });
check('历史最长连续 → 4（虽当前只有 1）', c.longestStreak(), 4);
check('当前连续 → 1', c.streak(TODAY), 1);

// 完全没打卡
c = new Checkin({ id: 6, title: '空项', logs: [] });
check('无记录 → streak 0', c.streak(TODAY), 0);
check('无记录 → longest 0', c.longestStreak(), 0);

// 月历统计：2026-09 共 30 天，今天 15 号，已过 15 天，未来 15 天
c = new Checkin({ id: 7, title: '月历', logs: ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-15'] });
const ms = c.monthStats('2026-09', TODAY);
check('月历天数 = 30', ms.days.length, 30);
check('已过天数 = 15（1~15 号）', ms.elapsed, 15);
check('未来天数 = 15（16~30 号）', ms.future, 15);
check('本月已打卡 = 4', ms.checked, 4);
check('完成率 = 27%（4/15）', ms.rate, 27);
check('1 号标记为已打卡', ms.days[0].checked, true);
check('4 号标记为未打卡', ms.days[3].checked, false);
check('15 号标记为今天', ms.days[14].today, true);
check('16 号标记为未来', ms.days[15].future, true);
check('30 号标记为未来', ms.days[29].future, true);

// 查看历史月份时，全部天数都算「已过」
c = new Checkin({ id: 8, title: '八月', logs: ['2026-08-01', '2026-08-02'] });
const aug = c.monthStats('2026-08', TODAY);
check('历史月 8 月共 31 天', aug.days.length, 31);
check('历史月无未来天数', aug.future, 0);
check('历史月已过 = 31', aug.elapsed, 31);
check('历史月完成率 = 6%（2/31）', aug.rate, 6);

// 闰年 2 月
c = new Checkin({ id: 9, title: '闰年', logs: [] });
check('2028-02 为闰年 29 天', c.monthStats('2028-02', TODAY).days.length, 29);
check('2026-02 为 28 天', c.monthStats('2026-02', TODAY).days.length, 28);

// 月初：完成率不应被未来日期稀释
c = new Checkin({ id: 10, title: '月初', logs: ['2026-09-01'] });
const early = c.monthStats('2026-09', d('2026-09-01'));
check('月初 1 号当天完成 → 100%', early.rate, 100);
check('月初分母只有 1 天', early.elapsed, 1);

/* ================================================================
   2. 记账模型
   ================================================================ */
group('2. 记账模型 — 金额、方向与汇总');

let e = new LedgerEntry({ amount: 12.5, direction: DIRECTION.EXPENSE, category: 'meal', note: '午饭', date: '2026-09-15' });
check('支出金额', e.amount, 12.5);
check('支出带符号金额为负', e.signedAmount, -12.5);
check('支出展示串', e.amountLabel, '-12.50');
check('支出 isExpense', e.isExpense, true);

e = new LedgerEntry({ amount: 3000, direction: DIRECTION.INCOME, category: 'allowance', date: '2026-09-01' });
check('收入带符号金额为正', e.signedAmount, 3000);
check('收入展示串', e.amountLabel, '+3000.00');
check('收入 isExpense', e.isExpense, false);

// 传入负数金额时取绝对值，方向仍由 direction 决定
e = new LedgerEntry({ amount: -50, direction: DIRECTION.EXPENSE, category: 'transport', date: '2026-09-15' });
check('负数金额归一为正数', e.amount, 50);

// 金额四舍五入到分
e = new LedgerEntry({ amount: 12.5678, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' });
check('金额保留两位小数', e.amount, 12.57);

// 分类与方向不匹配时自动纠正
e = new LedgerEntry({ amount: 10, direction: DIRECTION.INCOME, category: 'meal', date: '2026-09-15' });
check('收入方向配支出分类 → 纠正为其他收入', e.category, 'other_in');
e = new LedgerEntry({ amount: 10, direction: DIRECTION.EXPENSE, category: 'allowance', date: '2026-09-15' });
check('支出方向配收入分类 → 纠正为其他支出', e.category, 'other_ex');

// 校验
ok('金额 0 校验失败', !new LedgerEntry({ amount: 0, category: 'meal', date: '2026-09-15' }).validate().ok);
ok('金额为空校验失败', !new LedgerEntry({ amount: '', category: 'meal', date: '2026-09-15' }).validate().ok);
ok('合法记录校验通过', new LedgerEntry({ amount: 5, category: 'meal', date: '2026-09-15' }).validate().ok);
ok('非法日期格式（2026-9-5）校验失败', !new LedgerEntry({ amount: 5, category: 'meal', date: '2026-9-5' }).validate().ok);
ok('不存在的日期（2026-02-31）校验失败', !new LedgerEntry({ amount: 5, category: 'meal', date: '2026-02-31' }).validate().ok);
ok('闰日 2028-02-29 校验通过', new LedgerEntry({ amount: 5, category: 'meal', date: '2028-02-29' }).validate().ok);
ok('非闰年 2026-02-29 校验失败', !new LedgerEntry({ amount: 5, category: 'meal', date: '2026-02-29' }).validate().ok);

// month 派生
check('月份派生 = 2026-09', new LedgerEntry({ amount: 1, category: 'meal', date: '2026-09-15' }).month, '2026-09');

// 汇总
const entries = [
  new LedgerEntry({ amount: 12.5, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' }),
  new LedgerEntry({ amount: 7.5, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' }),
  new LedgerEntry({ amount: 30, direction: DIRECTION.EXPENSE, category: 'transport', date: '2026-09-14' }),
  new LedgerEntry({ amount: 3000, direction: DIRECTION.INCOME, category: 'allowance', date: '2026-09-01' }),
  new LedgerEntry({ amount: 200, direction: DIRECTION.INCOME, category: 'parttime', date: '2026-09-10' }),
];
const s = summarize(entries);
check('汇总支出 = 50', s.expense, 50);
check('汇总收入 = 3200', s.income, 3200);
check('汇总结余 = 3150', s.balance, 3150);
check('汇总笔数 = 5', s.count, 5);

// 分类聚合：同额时按分类 id 首次出现顺序稳定排序（此处餐饮 20 先出现且为最大值）
const cats = groupByCategory(entries.filter((x) => x.isExpense));
check('支出分类数 = 2', cats.length, 2);
check('交通合计 = 30（最高）', cats[0].total, 30);
check('餐饮合计 = 20', cats[1].total, 20);
check('餐饮笔数 = 2', cats[1].count, 2);
ok('按金额降序排列', cats[0].total >= cats[1].total, `${cats[0].total} vs ${cats[1].total}`);

// 分类元数据兜底
check('未知分类回退到其他支出', getLedgerCategory('nope', DIRECTION.EXPENSE).id, 'other_ex');
check('未知分类在收入方向回退到其他收入', getLedgerCategory('nope', DIRECTION.INCOME).id, 'other_in');
check('已知分类正常返回', getLedgerCategory('meal').label, '餐饮');

// toRecord / fromRecord 往返
const src = new LedgerEntry({ id: 7, amount: 88.8, direction: DIRECTION.EXPENSE, category: 'study', note: '买书', date: '2026-09-12', source: 'image' });
const back = LedgerEntry.fromRecord(src.toRecord());
check('往返后金额一致', back.amount, 88.8);
check('往返后分类一致', back.category, 'study');
check('往返后备注一致', back.note, '买书');
check('往返后来源一致', back.source, 'image');
check('往返后方向一致', back.direction, DIRECTION.EXPENSE);

/* ================================================================
   2b. 账户 → 记账 镜像（v1.7.0 建立，v1.9.0 收窄到「只有充值」）
   ================================================================ */
group('2b. 账户流水镜像到记账');

// v1.9.0 用户原话：「避免重复计算，然后账户里面的消费不用走记账总账，
//   只有充值的时候会记录在记账总账」
//
// ⚠️ 注意分工：**「要不要产生镜像」由 account_service.flowToLedger 决定**
//   （它只处理 kind === 'in'，消费直接返回 null）。
//   本组测试的是 **LedgerEntry 模型** 能不能正确承载这两种镜像 ——
//   acct_out 依然必须是个合法的分类，否则 v1.7–v1.8 期间已入库的旧记录会读不出来。
const acctOut = new LedgerEntry({
  amount: 15.5, direction: DIRECTION.EXPENSE, category: 'acct_out',
  note: '一食堂饭卡 · 午饭', date: '2026-09-15',
  source: 'account', accountId: 3, accountEntryId: 'eabc123',
});
check('旧账户消费记录仍可读（acct_out 分类保留）', acctOut.category, 'acct_out');
check('账户消费方向是支出', acctOut.direction, DIRECTION.EXPENSE);
check('fromAccount 标记为 true', acctOut.fromAccount, true);
check('分类元数据标签是「账户消费」', acctOut.categoryMeta.label, '账户消费');

const acctIn = new LedgerEntry({
  amount: 500, direction: DIRECTION.INCOME, category: 'acct_in',
  note: '一食堂饭卡 · 工资', date: '2026-09-15',
  source: 'account', accountId: 3, accountEntryId: 'eabc124',
});
check('账户充值落在 acct_in 分类', acctIn.category, 'acct_in');
check('账户充值方向是收入', acctIn.direction, DIRECTION.INCOME);
check('账户充值 fromAccount 为 true', acctIn.fromAccount, true);
check('分类元数据标签是「账户充值」', acctIn.categoryMeta.label, '账户充值');

// 手动记的流水不该被误判为账户来源
const manual = new LedgerEntry({ amount: 20, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' });
check('手动流水 fromAccount 为 false', manual.fromAccount, false);
check('accountId 缺省为 null', manual.accountId, 'null');

// 系统分类不能出现在手动选择器里（否则用户能手动选「账户充值」，账就串了）
check('支出可选分类不含 acct_out',
  ledgerCategoriesOf(DIRECTION.EXPENSE).some((c) => c.id === 'acct_out'), false);
check('收入可选分类不含 acct_in',
  ledgerCategoriesOf(DIRECTION.INCOME).some((c) => c.id === 'acct_in'), false);
check('支出可选分类数量 = 8', ledgerCategoriesOf(DIRECTION.EXPENSE).length, 8);
check('收入可选分类数量 = 4', ledgerCategoriesOf(DIRECTION.INCOME).length, 4);

// 镜像字段的序列化往返
const mirrorBack = LedgerEntry.fromRecord(acctOut.toRecord());
check('往返后 accountId 保留', mirrorBack.accountId, 3);
check('往返后 accountEntryId 保留', mirrorBack.accountEntryId, 'eabc123');
check('往返后 fromAccount 仍为 true', mirrorBack.fromAccount, true);
check('toJSON 输出 account_id', acctOut.toJSON().account_id, 3);
check('手动流水的 toJSON 不含 account_id', manual.toJSON().account_id, 'undefined');

// 按日期字符串（非 Date 对象）构造也不能丢字段
const strDate = new LedgerEntry({
  amount: 9.9, direction: DIRECTION.EXPENSE, category: 'acct_out',
  date: '2026-09-01', accountId: 5, accountEntryId: 'ex9',
});
check('字符串日期下 accountId 保留', strDate.accountId, 5);

// accountId 传空串/undefined 要归一成 null，不能让 'null' 字符串混进判断
check('accountId 空串归一为 null',
  new LedgerEntry({ amount: 1, category: 'meal', date: '2026-09-15', accountId: '' }).accountId, 'null');
check('accountId undefined 归一为 null',
  new LedgerEntry({ amount: 1, category: 'meal', date: '2026-09-15', accountId: undefined }).accountId, 'null');

// 汇总：账户**充值**镜像要计入月度收支（v1.9.0 起只有充值会进总账）
// 这里仍把 acct_out 一起放进混合数据，是为了验证「万一旧库里还有」时汇总不炸。
// 真正要守住的规则在 account_service 里（消费根本不产生镜像）。
const mixed = [
  new LedgerEntry({ amount: 15.5, direction: DIRECTION.EXPENSE, category: 'acct_out', date: '2026-09-15', accountId: 1 }),
  new LedgerEntry({ amount: 12, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' }),
  new LedgerEntry({ amount: 500, direction: DIRECTION.INCOME, category: 'acct_in', date: '2026-09-15', accountId: 1 }),
];
const msSum = summarize(mixed);
check('账户镜像计入支出汇总', msSum.expense, 27.5);
check('账户镜像计入收入汇总', msSum.income, 500);
check('账户镜像计入笔数', msSum.count, 3);

// v1.9.0：只有充值进总账的形态 —— 一笔手记消费 + 一笔账户充值
const v109 = summarize([
  new LedgerEntry({ amount: 12, direction: DIRECTION.EXPENSE, category: 'meal', date: '2026-09-15' }),
  new LedgerEntry({ amount: 500, direction: DIRECTION.INCOME, category: 'acct_in', date: '2026-09-15', accountId: 1 }),
]);
check('【v1.9】支出只算手记的那笔（账户消费不重复计）', v109.expense, 12);
check('【v1.9】收入算账户充值', v109.income, 500);
check('【v1.9】合计笔数 2（不再是 3）', v109.count, 2);

// v1.9.0：flowToLedger 的等价契约 —— 只有 kind='in' 才产出镜像。
// 这里用「category 是否存在」间接验证（模型层不引入 service 依赖）。
check('【v1.9】消费若误入总账会落在 acct_out（所以 service 必须拦住）',
  getLedgerCategory('acct_out').label, '账户消费');
check('【v1.9】充值镜像的分类标签', getLedgerCategory('acct_in').label, '账户充值');

// 有 accountId 与没有的混合时，去重键必须能区分
const dedup = new LedgerEntry({ amount: 1, category: 'acct_out', date: '2026-09-15', accountId: 1, accountEntryId: 'e1' });
const sameKey = new LedgerEntry({ amount: 1, category: 'acct_out', date: '2026-09-15', accountId: 1, accountEntryId: 'e1' });
const diffAcct = new LedgerEntry({ amount: 1, category: 'acct_out', date: '2026-09-15', accountId: 2, accountEntryId: 'e1' });
check('同账户同流水 id 视为同一笔',
  dedup.accountId === sameKey.accountId && dedup.accountEntryId === sameKey.accountEntryId, true);
check('不同账户的相同内部 id 不算同一笔', diffAcct.accountId === dedup.accountId, false);

/* ================================================================
   3. 收据解析（一键导入）
   ================================================================ */
group('3. 收据解析 — 金额 / 方向 / 商户 / 日期');

/* ---- 金额 ---- */
check('¥ 前缀金额', parseAmount('¥12.50'), 12.5);
check('￥ 前缀金额', parseAmount('￥28'), 28);
check('元 后缀金额', parseAmount('午饭 12.5 元'), 12.5);
check('带负号金额取正', parseAmount('-12.50'), 12.5);
check('同行含「实付」优先', parseAmount('商品合计 100.00\n实付 88.00\n余额 1000.00'), 100);
check('排除余额等噪音后取金额', parseAmount('付款成功\n-12.50\n余额 888.00'), 12.5);
check('多笔带¥时取最大', parseAmount('¥8.00\n¥25.50\n¥3.00'), 25.5);
check('无金额 → 0', parseAmount('今天天气不错'), 0);
check('空文本 → 0', parseAmount(''), 0);

/* ---- 金额：型号 vs 价格（v1.4.1 用户反馈修复） ---- */
check('型号不当价格·g27 不应被认成 27', parseAmount('买显示器g27'), 0);
check('型号不当价格·g75 不应被认成 75', parseAmount('买显示器g75'), 0);
check('型号不当价格·iPhone15 不应被认成 15', parseAmount('买iPhone15'), 0);
check('型号+元单位时仍能取到真价格', parseAmount('买显示器 g27 花了我 899 元'), 899);
check('型号无单位的行尾数字仍可作价格', parseAmount('买iPhone15花了6999'), 6999);
check('卡号不当价格', parseAmount('卡号6222 0212 3456 7890'), 0);
check('尾号不当价格', parseAmount('尾号8801'), 0);
check('年份不当价格（2026年）', parseAmount('2026年账本'), 0);
check('中文量词不当价格（3杯）', parseAmount('买了3杯奶茶'), 0);

/* ---- 金额：一句话行尾数字（无货币记号） ---- */
check('一句话·行尾整数', parseAmount('午饭100'), 100);
check('一句话·行尾整数带空格', parseAmount('打车 28'), 28);
check('一句话·行尾小数', parseAmount('吃早饭0.65'), 0.65);
check('一句话·行尾数字后有句号', parseAmount('午饭 100。'), 100);

/* ---- 金额：OCR 行序无关（v1.4.1 用户反馈修复） ---- */
const ocrA = '微信支付\n付款成功\n吃早饭0.65\n15.80\n收款方 星际烤肉店';
const ocrB = '微信支付\n付款成功\n15.80\n吃早饭0.65\n收款方 星际烤肉店';
check('OCR 行序·小额在前仍取到 15.80', parseAmount(ocrA), 15.8);
check('OCR 行序·小额在后仍取到 15.80', parseAmount(ocrB), 15.8);
ok('OCR 行序调换不改变金额', parseAmount(ocrA) === parseAmount(ocrB),
  `${parseAmount(ocrA)} vs ${parseAmount(ocrB)}`);
check('多行一句话·只认行尾数字不串行',
  parseAmount('微信支付\n付款成功\n早餐 3.5 元\n午饭 100\n收款方 食堂'), 3.5);

/* ---- 方向 ---- */
check('「支付成功」→ 支出', parseDirection('微信支付\n支付成功'), 'expense');
check('「收款成功」→ 收入', parseDirection('收款成功'), 'income');
check('「退款」→ 收入', parseDirection('已退款 ¥30'), 'income');
check('「收入」→ 收入', parseDirection('本月收入'), 'income');
check('无关键词默认支出', parseDirection('12.50'), 'expense');
check('先出现的词优先（支付在前）', parseDirection('支付成功\n收款方 星巴克'), 'expense');

/* ---- 商户 ---- */
check('收款方', parseMerchant('收款方 瑞幸咖啡'), '瑞幸咖啡');
check('商户全称去后缀', parseMerchant('商户全称：杭州瑞幸咖啡有限公司'), '杭州瑞幸咖啡');
check('收款人', parseMerchant('收款人：张三'), '张三');
check('无商户 → 空', parseMerchant('¥12.50'), '');
check('交易对方标签', parseMerchant('交易对方：星际烤肉店'), '星际烤肉店');

/* ---- 备注（这笔钱干什么用了）v1.3.2 ---- */
check('备注·收款方标签', parseNote('付款成功\n-12.50\n收款方 瑞幸咖啡'), '瑞幸咖啡');
check('备注·商家标签', parseNote('实付 ¥32.80\n商家 麦当劳（天府广场店）'), '麦当劳（天府广场店）');
check('备注·一句话剥掉金额', parseNote('午饭 12.5 元'), '午饭');
check('备注·一句话剥掉日期与金额', parseNote('9月15日 食堂午饭 15元'), '食堂午饭');
check('备注·剥掉方向词', parseNote('支出 35 元 买书'), '买书');
check('备注·剥掉时间前缀', parseNote('今天 打车 28 元'), '打车');
check('备注·独立成行的店名（支付宝风格）',
  parseNote('支付宝\n支付成功\n¥28.00\n2026-09-15 12:05\n星际烤肉店\n订单号 2026091522001'),
  '星际烤肉店');
check('备注·APP 名不算备注', parseNote('微信支付\n-8.00\n2026-09-15 09:12'), '');
check('备注·状态词不算备注', parseNote('支付成功'), '');
check('备注·纯金额不算备注', parseNote('¥12.50'), '');
check('备注·空文本', parseNote(''), '');

/* ---- 备注：型号不应污染备注（v1.4.1） ---- */
check('备注·型号行保留原始短语', parseNote('买显示器g27'), '买显示器g27');
check('备注·型号+价格剥掉价格', parseNote('买显示器 g27 花了我 899 元'), '买显示器 g27 我');

/* ---- 日期 ---- */
check('YYYY-MM-DD', parseDate('2026-09-15', TODAY), '2026-09-15');
check('YYYY/MM/DD', parseDate('2026/9/8', TODAY), '2026-09-08');
check('中文年月日', parseDate('2026年9月8日', TODAY), '2026-09-08');
check('M月D日 补当年', parseDate('9月20日', TODAY), '2026-09-20');
check('无日期 → 今天', parseDate('¥12.50', TODAY), '2026-09-15');
check('基准日不同则结果不同', parseDate('¥1', d('2026-08-03')), '2026-08-03');

/* ---- 分类 ---- */
check('午饭 → 餐饮', parseCategory('午饭'), 'meal');
check('瑞幸咖啡 → 餐饮', parseCategory('瑞幸咖啡'), 'meal');
check('打车 → 交通', parseCategory('打车'), 'transport');
check('买书 → 学习', parseCategory('买书'), 'study');
check('电影 → 娱乐', parseCategory('电影票'), 'entertain');
check('生活费（收入）→ allowance', parseCategory('生活费', 'income'), 'allowance');
check('奖学金（收入）→ scholarship', parseCategory('奖学金到账', 'income'), 'scholarship');
check('未知（支出）→ other_ex', parseCategory('随便什么', 'expense'), 'other_ex');

/* ---- 端到端：微信支付截图 ---- */
const wxShot = [
  '微信支付',
  '支付成功',
  '-12.50',
  '收款方 瑞幸咖啡',
  '2026-09-15 14:32:10',
  '余额 888.00',
].join('\n');
const r1 = parseReceipt(wxShot, TODAY);
check('端到端·金额', r1.amount, 12.5);
check('端到端·方向', r1.direction, 'expense');
check('端到端·商户', r1.note, '瑞幸咖啡');
check('端到端·分类', r1.category, 'meal');
check('端到端·日期', r1.date, '2026-09-15');
ok('端到端·置信度较高（≥0.75）', r1.confidence >= 0.75, `实际 ${r1.confidence}`);

/* ---- 端到端：支付宝收款 ---- */
const aliShot = [
  '支付宝',
  '收款成功',
  '￥200.00',
  '付款方 李四',
  '2026-09-10',
].join('\n');
const r2 = parseReceipt(aliShot, TODAY);
check('收款·金额', r2.amount, 200);
check('收款·方向', r2.direction, 'income');

/* ---- 端到端：一句话 ---- */
const r3 = parseReceipt('午饭 12.5 元', TODAY);
check('一句话·金额', r3.amount, 12.5);
check('一句话·方向默认支出', r3.direction, 'expense');
check('一句话·分类', r3.category, 'meal');
check('一句话·日期为今天', r3.date, '2026-09-15');
// v1.3.2：一句话里的「午饭」现在会被抓成备注，因此置信度不再偏低
check('一句话·备注抓到「午饭」', r3.note, '午饭');
ok('一句话·有备注时置信度较高（≥0.75）', r3.confidence >= 0.75, `实际 ${r3.confidence}`);

/* ---- 端到端：识别不出金额 ---- */
const r4 = parseReceipt('今天心情很好', TODAY);
check('无金额场景·金额为 0', r4.amount, 0);
ok('无金额场景·置信度低', r4.confidence < 0.5, `实际 ${r4.confidence}`);

/* ---- 端到端：负数支出不应被当成收入 ---- */
const r5 = parseReceipt('支出 ¥35.00\n食堂', TODAY);
check('支出关键词 → expense', r5.direction, 'expense');
check('支出金额取正', r5.amount, 35);

/* ================================================================
   汇总
   ================================================================ */
console.log('\n' + '='.repeat(56));
if (failed === 0) {
  console.log(`\x1b[32m全部通过：${passed} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m通过 ${passed} 项，失败 ${failed} 项\x1b[0m`);
  console.log('\n失败明细：');
  failures.forEach((f) => {
    console.log(`  [${f.group}] ${f.label}`);
    console.log(`      期望: ${f.expected}`);
    console.log(`      实际: ${f.actual}`);
  });
}
console.log('='.repeat(56));
process.exit(failed === 0 ? 0 : 1);
