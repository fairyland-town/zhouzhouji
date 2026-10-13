/**
 * account_test.mjs —— 账户余额对账测试（v1.5.0）
 *
 * 用户诉求（原话）：
 *   「我充饭卡，我饭卡有多少金额，我消耗了多少金额，还剩下多少金额，又比如，
 *     我充 100 的花费，经历几个月后还剩下多少钱…目的在于不把『我还剩多少钱』
 *     全依靠给第三方平台，好明确知道自己的钱有没有被误吞或者误扣而导致减少而没记录」
 *
 * 所以本文件重点验证「对账」这件事的数学正确性：
 *   两种余额口径（推导值 derivedBalance / 快照基准值 balance）不能混；
 *   差额 balanceDiff 的正负号必须能正确表达「平台多扣了 / 我多记了」；
 *   快照之后新记的流水必须叠加在快照之上，而不是回到期初重算。
 *
 * 用法：node tests/account_test.mjs
 */

import {
  Account, ACCOUNT_TYPE, ACCOUNT_TYPES, ACCOUNT_TYPE_META, ACCOUNT_FLOW,
  BALANCE_MODE, getAccountTypeMeta, summarizeAccounts, addRunNote, isTransferLeg,
} from '../web/js/models/account.js';
import { formatDate } from '../web/js/utils/date_utils.js';

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0, failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(label, actual, expected, actualLabel = '') {
  const a = String(actual), e = String(expected);
  if (a === e) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    if (actualLabel) {
      // 数组断言用：把实际值也打出来，「期望 3 / 实际 1」看不出扣了哪些月
      failures.push({ group: currentGroup, label, actual: `${actualLabel}（${a}）`, expected: e });
    } else {
      failures.push({ group: currentGroup, label, actual: a, expected: e });
    }
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      期望: ${e}`);
    console.log(`      实际: ${a}`);
  }
}
function near(label, actual, expected, eps = 0.005) {
  const okVal = Math.abs(Number(actual) - Number(expected)) < eps;
  check(label, okVal ? 'true' : 'false', 'true');
  if (!okVal) console.log(`      （实际 ${actual}，期望约 ${expected}）`);
}
function ok(label, cond, detail = '') {
  check(label + (detail ? `  （${detail}）` : ''), cond ? 'true' : 'false', 'true');
}

/** 相对今天的日期串 */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/* ================================================================
   1. 类型元数据
   ================================================================ */
group('1. 账户类型元数据');

check('五种账户类型', ACCOUNT_TYPES.length, 5);
check('饭卡 id', ACCOUNT_TYPE.MEAL_CARD, 'meal_card');
check('银行卡 id', ACCOUNT_TYPE.BANK, 'bank');
check('现金 id', ACCOUNT_TYPE.CASH, 'cash');
check('零钱 id', ACCOUNT_TYPE.WALLET, 'wallet');
check('自定义 id', ACCOUNT_TYPE.CUSTOM, 'custom');
ok('饭卡标签是「饭卡 / 校园卡」',
  ACCOUNT_TYPE_META[ACCOUNT_TYPE.MEAL_CARD].label.includes('饭卡'),
  ACCOUNT_TYPE_META[ACCOUNT_TYPE.MEAL_CARD].label);
ok('每种类型都有图标', ACCOUNT_TYPES.every((t) => ACCOUNT_TYPE_META[t].icon));
ok('每种类型都有颜色', ACCOUNT_TYPES.every((t) => /^#[0-9a-f]{6}$/i.test(ACCOUNT_TYPE_META[t].color)));
const colors = ACCOUNT_TYPES.map((t) => ACCOUNT_TYPE_META[t].color);
check('五种类型颜色互不相同', new Set(colors).size, 5);
check('未知类型回退到自定义', getAccountTypeMeta('bogus').id, 'custom');
check('不传类型回退到自定义', getAccountTypeMeta(undefined).id, 'custom');

/* ================================================================
   2. 构造与校验
   ================================================================ */
group('2. 构造与校验');

const a1 = new Account({ name: '  一食堂饭卡  ', type: ACCOUNT_TYPE.MEAL_CARD, opening: 100 });
check('名称去首尾空格', a1.name, '一食堂饭卡');
check('类型正确', a1.type, 'meal_card');
check('期初余额', a1.opening, 100);
check('默认记账模式为追踪', a1.balanceMode, 'tracked');
check('期初日期自动补今天', a1.openingDate, formatDate(new Date()));
ok('创建时间已生成', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(a1.createdAt), a1.createdAt);

check('空名称校验失败', a1.constructor === Account && new Account({ name: '' }).validate().ok, false);
ok('超长名称校验失败', !new Account({ name: 'x'.repeat(31) }).validate().ok);
ok('正常账户校验通过', new Account({ name: '建行卡' }).validate().ok);
ok('非法类型被纠正为 custom', new Account({ name: 'x', type: 'nope' }).type === 'custom');

check('期初四舍五入到分', new Account({ name: 'x', opening: 100.005 }).opening, 100.01);
check('期初非数字回退 0', new Account({ name: 'x', opening: 'ab' }).opening, 0);

/* ================================================================
   3. 累计充值 / 累计消耗 / 推导余额
   ================================================================ */
group('3. 累计充值 · 累计消耗 · 推导余额');

const a2 = new Account({
  name: '一食堂饭卡', type: ACCOUNT_TYPE.MEAL_CARD, opening: 100,
  entries: [
    { kind: ACCOUNT_FLOW.IN, amount: 200, date: dayOffset(-30), note: '工资' },
    { kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: dayOffset(-20), note: '午饭' },
    { kind: ACCOUNT_FLOW.OUT, amount: 8, date: dayOffset(-10), note: '早饭' },
  ],
});
near('累计充值 200', a2.totalIn, 200);
near('累计消耗 20.5', a2.totalOut, 20.5);
near('推导余额 = 100 + 200 − 20.5 = 279.5', a2.derivedBalance, 279.5);
near('无快照时当前余额即推导余额', a2.balance, 279.5);
check('无快照时差额为 0', a2.balanceDiff, 0);
ok('已设过期初 → hasBaseline', a2.hasBaseline);

const aEmpty = new Account({ name: '空账户' });
check('什么都没设 → 推导余额 0', aEmpty.derivedBalance, 0);
check('什么都没设 → 没有基准', aEmpty.hasBaseline, false);

/* ================================================================
   3b. 转账不算充值 / 消费（v1.13.7）
   ----------------------------------------------------------------
   用户 2026-09-24 原话：
     「账户与账户之间的转账不计入收入，因为，在钱入账的时候已经计算过了的」

   `totalIn` / `totalOut` 是「这张卡进过 / 出过多少钱」，**单看一个账户是对的**；
   但把几个账户相加时，转账会让同一笔钱算两遍（A 收到 = B 转出）。
   所以全局口径要用 totalInExternal / totalOutExternal。
   ================================================================ */
group('3b. 转账不算充值 / 消费（v1.13.7）');

// 一食堂饭卡：外部充值 200、消费 12.5；另有「从银行卡转入 50」和「转给微信 80」
const cardT = new Account({
  name: '一食堂饭卡', opening: 0,
  entries: [
    { kind: ACCOUNT_FLOW.IN, amount: 200, date: dayOffset(-40), note: '工资' },
    { kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: dayOffset(-30), note: '午饭' },
    { kind: ACCOUNT_FLOW.IN, amount: 50, date: dayOffset(-20), note: '从「银行卡」转入', linkedAccountId: 2, linkedEntryId: 'peer-1' },
    { kind: ACCOUNT_FLOW.OUT, amount: 80, date: dayOffset(-10), note: '转给「微信」', linkedAccountId: 3, linkedEntryId: 'peer-2' },
  ],
});

near('totalIn 含转账转入 = 200 + 50 = 250', cardT.totalIn, 250);
near('totalOut 含转账转出 = 12.5 + 80 = 92.5', cardT.totalOut, 92.5);
near('🔴 totalInExternal 扣掉转账转入 = 200', cardT.totalInExternal, 200);
near('🔴 totalOutExternal 扣掉转账转出 = 12.5', cardT.totalOutExternal, 12.5);

// 判据只有 linkedAccountId —— 只有 transfer() 会写它
ok('isTransferLeg 认得转账转入', isTransferLeg(cardT.entries[2]));
ok('isTransferLeg 认得转账转出', isTransferLeg(cardT.entries[3]));
ok('普通充值不算转账', !isTransferLeg(cardT.entries[0]));
ok('普通消费不算转账', !isTransferLeg(cardT.entries[1]));
ok('null 不崩', !isTransferLeg(null));

// ⚠️ 关键：linkedAccountId 必须扛得住「存一次再读一次」。
//    normalizeEntry() 只挑字段返回，漏一个字段就会在读回之后凭空消失，
//    而那时 totalInExternal 会**悄悄把转账又算回去** —— 界面上看不出任何异常。
const cardT2 = Account.fromRecord(cardT.toRecord());
ok('往返后 linkedAccountId 还在', isTransferLeg(cardT2.entries[2]));
near('🔴 往返后 totalInExternal 仍是 200', cardT2.totalInExternal, 200);
near('🔴 往返后 totalOutExternal 仍是 12.5', cardT2.totalOutExternal, 12.5);

// 一张只有转账、没有任何真实收支的卡：两个「外部」口径都该是 0
const onlyTransfer = new Account({
  name: '中转卡', opening: 500,
  entries: [
    { kind: ACCOUNT_FLOW.IN, amount: 300, date: dayOffset(-5), note: '转入', linkedAccountId: 9, linkedEntryId: 'p' },
  ],
});
near('只有转账时 totalIn 仍报 300', onlyTransfer.totalIn, 300);
near('🔴 但 totalInExternal 是 0（不是收入）', onlyTransfer.totalInExternal, 0);
near('余额不受影响（钱确实在卡里）', onlyTransfer.balance, 800);

/* ================================================================
   4. 流水规范化（脏数据不能污染账目）
   ================================================================ */
group('4. 流水规范化');

const a3 = new Account({
  name: 'x', opening: 0,
  entries: [
    { kind: ACCOUNT_FLOW.OUT, amount: -50, date: dayOffset(-3) },   // 负数 → 取绝对值
    { kind: ACCOUNT_FLOW.OUT, amount: 0, date: dayOffset(-2) },     // 0 元 → 丢弃
    { kind: ACCOUNT_FLOW.OUT, amount: '10.567', date: dayOffset(-1) }, // 超过分位 → 进位
    { kind: ACCOUNT_FLOW.IN, amount: 5, date: 'not-a-date' },       // 非法日期 → 补今天
    { kind: 'weird', amount: 3, date: dayOffset(-1) },              // 未知流向 → 归为消费
  ],
});
check('0 元流水被丢弃', a3.entries.length, 4);
near('负数金额取绝对值 50', a3.totalOut, 50 + 10.57 + 3);
near('超精度四舍五入 10.567 → 10.57',
  a3.entries.find((e) => e.note === '' && e.amount === 10.57) ? 10.57 : 0, 10.57);
ok('非法日期被补成今天',
  a3.entries.some((e) => e.kind === 'in' && e.date === formatDate(new Date())));
ok('未知流向归为消费', a3.entries.some((e) => e.amount === 3 && e.kind === 'out'));

const aSort = new Account({
  name: 'x',
  entries: [
    { kind: ACCOUNT_FLOW.OUT, amount: 1, date: '2026-03-05' },
    { kind: ACCOUNT_FLOW.OUT, amount: 1, date: '2026-01-01' },
    { kind: ACCOUNT_FLOW.OUT, amount: 1, date: '2026-02-01' },
  ],
});
check('流水按日期升序',
  aSort.entries.map((e) => e.date).join(','),
  '2026-01-01,2026-02-01,2026-03-05');

/* ================================================================
   4b. 记账挂账（ledgerId）—— v1.13.5
   ================================================================
   用户诉求：「在记账的时候多一个可选的消费账户选项，
   直接从对应的消费账户里面扣钱」。
   实现是把关联写在**账户侧**的流水上（`ledgerId` = 那笔记账的 id），
   而不是给记账流水写 `account_id`（那个字段的语义是「账户页镜像过来的」）。

   🔴 这一组钉的是一个**只在重启 App 之后才会犯**的错：
      `normalizeEntry` 早期只挑 id/kind/amount/date/note 五个字段返回，
      ledgerId 会在「存一次再读一次」之后凭空消失 ——
      于是重复挂账检测失效（每次编辑都再扣一笔），
      删记账时也找不到该撤销哪条流水，钱就留在账户里变成幽灵支出。
      单元测试必须覆盖 **fromRecord(toRecord()) 往返**，光测 addEntryWithId 不够。
*/
group('4b. 记账挂账 ledgerId（v1.13.5）');

const lnkAcc = new Account({
  name: '一食堂饭卡', opening: 100,
  entries: [
    { kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: '2026-09-22', note: '食堂午饭', ledgerId: 7 },
    { kind: ACCOUNT_FLOW.IN, amount: 200, date: '2026-09-01', note: '充值', ledgerId: 8 },
    { kind: ACCOUNT_FLOW.OUT, amount: 3, date: '2026-09-20', note: '自己记的，不挂账' },
  ],
});
check('构造时保住 ledgerId',
  lnkAcc.entries.filter((e) => e.ledgerId != null).length, 2);
near('挂账的消费计入「累计消耗」', lnkAcc.totalOut, 15.5);
near('挂账的充值计入「累计充值」', lnkAcc.totalIn, 200);
near('挂账同时改变余额', lnkAcc.balance, 284.5);

const lnkRt = Account.fromRecord(lnkAcc.toRecord());
check('toRecord → fromRecord 往返后 ledgerId 还在',
  lnkRt.entries.filter((e) => e.ledgerId != null).length, 2);
check('往返后具体值不变',
  lnkRt.entries.filter((e) => e.ledgerId != null).map((e) => String(e.ledgerId)).sort().join(','),
  '7,8');
near('往返后余额一致', lnkRt.balance, lnkAcc.balance);

const lnkFresh = new Account({ name: 'x' });
const added = lnkFresh.addEntryWithId({ kind: ACCOUNT_FLOW.OUT, amount: 9, date: '2026-09-22', ledgerId: 42 });
check('addEntryWithId 返回的那条就带着 ledgerId', added.ledgerId, 42);
check('addEntryWithId 之后再往返也还在',
  Account.fromRecord(lnkFresh.toRecord()).entries[0].ledgerId, 42);
const plainAcc = new Account({
  name: 'y',
  entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 1, date: '2026-09-22' }],
});
ok('没挂账的流水**完全不带** ledgerId 字段（别把 undefined 写进库里）',
  !Object.prototype.hasOwnProperty.call(plainAcc.entries[0], 'ledgerId'));
check('没挂账的流水也不会凭空多出别的键',
  Object.keys(plainAcc.entries[0]).sort().join(','), 'amount,date,id,kind,note');

/* ================================================================
   5. 对账：核心价值
   ================================================================ */
group('5. 对账差额（钱有没有被误吞 / 误扣）');

// 场景：期初 100，充 200，花 12.5 → 应剩 287.5；平台却显示 280 → 平台多扣 7.5
const a4 = new Account({
  name: '一食堂饭卡', opening: 100, openingDate: '2026-06-01',
  entries: [
    { kind: ACCOUNT_FLOW.IN, amount: 200, date: '2026-07-01', note: '工资' },
    { kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: '2026-08-01', note: '午饭' },
  ],
  checkpoints: [{ date: '2026-08-02', balance: 280, note: '卡机显示' }],
});
near('对账后当前余额 = 快照 280（其后无流水）', a4.balance, 280);
near('按流水推导该是 287.5', a4.derivedFromOpeningAt('2026-08-02'), 287.5);
near('差额 7.5（正数 = 平台扣得比我记的多）', a4.balanceDiff, 7.5);
ok('差额为正表示可能有漏记的消费', a4.balanceDiff > 0);

// 场景：快照之后又记了新流水 → 必须叠加在快照上
const a5 = new Account({
  name: '一食堂饭卡', opening: 100, openingDate: '2026-06-01',
  entries: [
    { kind: ACCOUNT_FLOW.IN, amount: 200, date: '2026-07-01' },
    { kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: '2026-08-01' },
    { kind: ACCOUNT_FLOW.OUT, amount: 30, date: '2026-09-10', note: '快照后消费' },
    { kind: ACCOUNT_FLOW.IN, amount: 50, date: '2026-09-12', note: '快照后充值' },
  ],
  checkpoints: [{ date: '2026-08-02', balance: 280 }],
});
near('快照后余额 = 280 − 30 + 50 = 300', a5.balance, 300);
ok('快照之后的流水不会回到期初重算',
  Math.abs(a5.balance - a5.derivedBalance) > 1,
  `balance ${a5.balance} vs derived ${a5.derivedBalance}`);

// 场景：记多了 → 差额为负
const a6 = new Account({
  name: 'x', opening: 100, openingDate: '2026-06-01',
  entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 50, date: '2026-07-01' }],
  checkpoints: [{ date: '2026-07-02', balance: 60 }],
});
near('差额 −10（我记的比平台扣的多 → 可能重复记录）', a6.balanceDiff, -10);
ok('差额为负表示可能有重复记录', a6.balanceDiff < 0);

// 场景：完全一致
const a7 = new Account({
  name: 'x', opening: 100, openingDate: '2026-06-01',
  entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 50, date: '2026-07-01' }],
  checkpoints: [{ date: '2026-07-02', balance: 50 }],
});
near('完全一致时差额为 0', a7.balanceDiff, 0);
ok('差额 < 0.005 视为对得上', Math.abs(a7.balanceDiff) < 0.005);

check('没有快照时 lastCheckpoint 为 null', a2.lastCheckpoint, 'null');
check('多个快照取最近一次', a4.lastCheckpoint.date, '2026-08-02');

const aMultiCp = new Account({
  name: 'x', opening: 100,
  checkpoints: [
    { date: '2026-05-01', balance: 90 },
    { date: '2026-08-01', balance: 70 },
    { date: '2026-06-01', balance: 80 },
  ],
});
check('快照按日期升序规范化', aMultiCp.checkpoints.map((c) => c.date).join(','),
  '2026-05-01,2026-06-01,2026-08-01');
check('最近快照是 08-01', aMultiCp.lastCheckpoint.balance, 70);

/* ================================================================
   6. 日均消耗与可用天数
   ================================================================ */
group('6. 日均消耗 · 还能用多久');

// 从 30 天前开始消费，共 90 元
const a8 = new Account({
  name: '饭卡', opening: 275.5,
  entries: [
    { kind: ACCOUNT_FLOW.OUT, amount: 30, date: dayOffset(-30) },
    { kind: ACCOUNT_FLOW.OUT, amount: 30, date: dayOffset(-20) },
    { kind: ACCOUNT_FLOW.OUT, amount: 30, date: dayOffset(-10) },
  ],
});
near('跨 31 天共花 90 → 日均约 2.9', a8.dailyBurn(), 90 / 31);
const left = a8.daysLeft();
ok('能算出剩余可用天数', left != null && left > 0, `daysLeft=${left}`);
near('天数 = 余额 / 日均', a8.balance / a8.dailyBurn(), left, 1.5);

const aNoSpend = new Account({ name: 'x', opening: 100 });
check('没有消费记录时日均 0', aNoSpend.dailyBurn(), 0);
check('没有消费记录时天数 null', aNoSpend.daysLeft(), 'null');

const aBroke = new Account({
  name: 'x', opening: 0,
  entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 10, date: dayOffset(-5) }],
});
check('余额为 0 时天数 null', aBroke.daysLeft(), 'null');

/* ---- v1.13.7：转账转出不算消耗（同「转账不计入收入」的口径） ---- */

// 只有一笔转账的卡：不该出现任何「日均 / 还能用」预估。
// 不排除的话这里会算出 400/4 = 100 的日均、daysLeft = 1 并点亮警告色。
const aTransferOnly = new Account({
  name: '零钱', opening: 500,
  entries: [{
    kind: ACCOUNT_FLOW.OUT, amount: 400, date: dayOffset(-3),
    note: '转给「饭卡」', linkedAccountId: 9, linkedEntryId: 'p1',
  }],
});
near('转账仍如实记进 totalOut', aTransferOnly.totalOut, 400);
near('转账不计入 totalOutExternal', aTransferOnly.totalOutExternal, 0);
near('余额确实少了 400（钱真出去了）', aTransferOnly.balance, 100);
check('🔴 只有转账时日均消耗 0（不是 400）', aTransferOnly.dailyBurn(), 0);
check('🔴 只有转账时不显示「还能用」（null，不是 0 天警告）', aTransferOnly.daysLeft(), 'null');

// 混合：转账发生在 30 天前、真实消费在 3 天前。
// 🔴 这一组同时钉住**求和**和**区间**：
//    只把 totalOut 换成 totalOutExternal、区间却还从最早那笔 OUT（转账）算起的话，
//    会得到 20 / 31 ≈ 0.65，看着「更省」，其实是错的。
//    两边都过滤才对：20 / 4 天 = 5。
const aMixedBurn = new Account({
  name: '混合', opening: 500,
  entries: [
    { kind: ACCOUNT_FLOW.OUT, amount: 400, date: dayOffset(-30), note: '转出', linkedAccountId: 9, linkedEntryId: 'p2' },
    { kind: ACCOUNT_FLOW.OUT, amount: 20, date: dayOffset(-3), note: '午饭' },
  ],
});
near('🔴 混合场景日均 = 20 / 4 天 = 5（求和与区间都排除了转账）', aMixedBurn.dailyBurn(), 5);
near('混合场景还能用 = 余额 80 / 日均 5 = 16 天', aMixedBurn.daysLeft(), 16);

/* ================================================================
   7. 变更操作
   ================================================================ */
group('7. 变更操作');

const a9 = new Account({ name: 'x', opening: 0 });
a9.addEntry({ kind: ACCOUNT_FLOW.IN, amount: 100, date: dayOffset(-2), note: '充值' });
near('加一笔充值后余额 100', a9.balance, 100);
a9.addEntry({ kind: ACCOUNT_FLOW.OUT, amount: 30, date: dayOffset(-1), note: '吃饭' });
near('再加一笔消费后余额 70', a9.balance, 70);
check('共两笔流水', a9.entries.length, 2);

let threw = false;
try { a9.addEntry({ kind: ACCOUNT_FLOW.OUT, amount: 0 }); } catch { threw = true; }
ok('金额为 0 的流水会抛错（不允许空记账）', threw);

const firstId = a9.entries[0].id;
check('删除已存在的流水返回 true', a9.removeEntry(firstId), true);
near('删除充值后余额回到 −30', a9.balance, -30);
check('删除不存在的流水返回 false', a9.removeEntry('nope'), false);

const a10 = new Account({ name: 'x', opening: 100 });
a10.addCheckpoint({ date: dayOffset(-1), balance: 88, note: '对账' });
near('记快照后当前余额 = 88', a10.balance, 88);
near('差额 = 推导 100 − 快照 88 = 12', a10.balanceDiff, 12);

let threw2 = false;
try { a10.addCheckpoint({ balance: 'abc' }); } catch { threw2 = true; }
ok('非法余额的快照会抛错', threw2);

/* ================================================================
   8. 记录往返
   ================================================================ */
group('8. 记录往返（IndexedDB 存取）');

const orig = new Account({
  id: 7, name: '一食堂饭卡', type: ACCOUNT_TYPE.MEAL_CARD,
  balanceMode: BALANCE_MODE.TRACKED, opening: 100, openingDate: '2026-06-01',
  entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 12.5, date: '2026-08-01', note: '午饭' }],
  checkpoints: [{ date: '2026-08-02', balance: 280, note: '卡机' }],
  archived: false, note: '备注', createdAt: '2026-06-01 09:00',
});
const rec = orig.toRecord();
check('记录用下划线列名 balance_mode', rec.balance_mode, 'tracked');
check('记录用下划线列名 opening_date', rec.opening_date, '2026-06-01');
check('记录用下划线列名 created_at', rec.created_at, '2026-06-01 09:00');
check('archived 存 0 / 1', rec.archived, 0);

const back = Account.fromRecord(rec);
check('往返名称一致', back.name, orig.name);
check('往返类型一致', back.type, orig.type);
check('往返期初一致', back.opening, orig.opening);
near('往返余额一致', back.balance, orig.balance);
check('往返流水条数一致', back.entries.length, 1);
check('往返快照条数一致', back.checkpoints.length, 1);
check('往返备注一致', back.note, '备注');

check('空记录返回 null', Account.fromRecord(null), 'null');
check('archived=0 解析为 false', Account.fromRecord({ name: 'x', archived: 0 }).archived, false);
check('archived=1 解析为 true', Account.fromRecord({ name: 'x', archived: 1 }).archived, true);
check('archived=true 解析为 true', Account.fromRecord({ name: 'x', archived: true }).archived, true);

const json = orig.toJSON();
check('toJSON 不含 id（导入用）', json.id, 'undefined');
check('toJSON 含流水', json.entries.length, 1);

/* ================================================================
   9. 每月定时扣款（v1.7.0）
   ================================================================ */
group('9. 每月定时扣款');

const plain = new Account({ name: '普通卡', opening: 100 });
check('默认不启用每月扣款', plain.hasRecurring, 'false');
check('未启用时没有描述文案', plain.recurringLabel, '');
check('未启用时没有待扣项', plain.dueRecurring(new Date('2026-09-15')).length, 0);

const recur1 = new Account({
  name: '房租卡',
  opening: 5000,
  recurring: { enabled: true, day: 1, amount: 1500, note: '房租', kind: ACCOUNT_FLOW.OUT },
});
check('启用后 hasRecurring 为 true', recur1.hasRecurring, 'true');
check('描述文案含日期与金额', recur1.recurringLabel, '每月 1 号自动扣款 ¥1500.00（房租）');

// lastRun = 2026-08，今天 2026-09-15 → 只应产生 9 月这一笔
recur1.recurring.lastRun = '2026-08';
const due1 = recur1.dueRecurring(new Date('2026-09-15'));
check('只补未执行的月份', due1.length, 1);
check('补的是 9 月', due1[0].month, '2026-09');
check('执行日期是 1 号', due1[0].date, '2026-09-01');
near('扣款金额正确', due1[0].amount, 1500);

// 隔了三个月没打开 App → 10/11/12 三个月逐月补齐（用户确认：不设上限）
recur1.recurring.lastRun = '2026-09';
const due3 = recur1.dueRecurring(new Date('2026-12-20'));
check('跨月补扣三个月', due3.length, 3);
check('补扣按时间升序', due3.map((d) => d.month).join(','), '2026-10,2026-11,2026-12');
check('起始月是 lastRun 的次月', due3[0].month, '2026-10');

// 还没到当月扣款日 → 不产生
const early = new Account({
  name: '月末卡', opening: 1000,
  recurring: { enabled: true, day: 25, amount: 100, since: '2026-09' },
});
check('未到扣款日不产生', early.dueRecurring(new Date('2026-09-15')).length, 0);
check('到了扣款日才产生', early.dueRecurring(new Date('2026-09-25')).length, 1);

// 关键回归：新建账户启用月扣款，不能把之前的历史月份全部倒扣一遍
// （9/15 启用，扣款日 25 号还没到 → 本月 25 号扣一期，共一期）
const fresh = new Account({
  name: '刚建好', opening: 1000,
  recurring: { enabled: true, day: 25, amount: 100, since: '2026-09' },
});
check('新账户不倒扣启用前的月份', fresh.dueRecurring(new Date('2026-09-26')).length, 1);

/* ================================================================
   9b. v1.9.0 月扣款时序（设置当时绝不立即扣）
   ================================================================
   用户原话：「月扣款的时候不是设置了立即扣除，而是在固定的设置的那一天扣款，
     要是设置日期在扣款之前，到扣款日期就扣，要是设置日期在扣款之后，
     那么就不管他，下个月扣款日再扣」

   模型的约定：
     · since      = 启用月份，**重设时不刷新**
     · lastRun    = 已执行到的月份（唯一权威）
     · sinceSkip  = 启用当月那一期是否放弃（setRecurring 在「设置日已过扣款日」时置 true）
     · runCount   = 仅用于「第 N 期」展示，**不参与产生判定**
   ================================================================ */
group('9b. 月扣款时序（v1.9.0）');

// ① 设置日早于扣款日（15 号设，25 号扣）→ 当天不扣，到 25 号才扣
const beforeDay = new Account({
  name: '设置日早于扣款日', opening: 1000,
  recurring: {
    enabled: true, day: 25, amount: 100, since: '2026-09', sinceSkip: false,
  },
});
check('【v1.9】设置当时不扣款', beforeDay.dueRecurring(new Date('2026-09-15')).length, 0);
const beforeDue = beforeDay.dueRecurring(new Date('2026-09-25'));
check('【v1.9】到了本月扣款日就扣', beforeDue.length, 1);
check('【v1.9】扣的是本月', beforeDue[0].month, '2026-09');
// 执行后（lastRun 推进到 9 月）→ 10 月那天再扣一期，不会重复
beforeDay.markRecurringRun('2026-09');
check('【v1.9】执行后本月不重复', beforeDay.dueRecurring(new Date('2026-09-28')).length, 0);
check('【v1.9】下月扣款日再扣一期', beforeDay.dueRecurring(new Date('2026-10-25')).length, 1);

// ② 设置日已过扣款日（15 号设，10 号扣）→ 本月不管，下月 10 号才扣
const afterDay = new Account({
  name: '设置日已过扣款日', opening: 1000,
  recurring: {
    enabled: true, day: 10, amount: 100, since: '2026-09', sinceSkip: true,
  },
});
check('【v1.9】设置当时不扣款', afterDay.dueRecurring(new Date('2026-09-15')).length, 0);
check('【v1.9】设月内跑到月底也不扣', afterDay.dueRecurring(new Date('2026-09-30')).length, 0);
const nextDue = afterDay.dueRecurring(new Date('2026-10-10'));
check('【v1.9】下月扣款日才扣', nextDue.length, 1);
check('【v1.9】扣的是下月', nextDue[0].month, '2026-10');
// 放弃的那一期**永久放弃**：跳到 12 月也不会把 9 月补回来
const jumped = afterDay.dueRecurring(new Date('2026-12-25'));
check('【v1.9】被放弃的那期永不补扣', jumped.some((d) => d.month === '2026-09'), false);
check('【v1.9】错过中间月仍逐月补', jumped.map((d) => d.month).join(','), '2026-10,2026-11,2026-12');

// ③ 已启用账户重新设置（since 不刷新）→ 本月该扣的不能被吞掉
const reset9 = new Account({
  name: '重设', opening: 1000,
  recurring: { enabled: true, day: 1, amount: 100, since: '2026-08', lastRun: '2026-08' },
});
check('【v1.9】重新设置不刷新 since', reset9.dueRecurring(new Date('2026-09-15')).length, 1);
check('【v1.9】重设后扣的仍是 9 月', reset9.dueRecurring(new Date('2026-09-15'))[0].month, '2026-09');

// ④ 收入方向（自动充值）遵守同一套规则
const recInLater = new Account({
  name: '收入方向', opening: 0,
  recurring: {
    enabled: true, day: 10, amount: 2000, kind: ACCOUNT_FLOW.IN,
    since: '2026-09', sinceSkip: true,
  },
});
check('【v1.9】收入方向设置当时不扣', recInLater.dueRecurring(new Date('2026-09-15')).length, 0);
check('【v1.9】收入方向下月才执行', recInLater.dueRecurring(new Date('2026-10-10'))[0].month, '2026-10');

// ⑤ runCount / sinceSkip 的规范化兜底
check('【v1.9】runCount 兜底为 0', plain.recurring.runCount, 0);
check('【v1.9】sinceSkip 兜底为 false', plain.recurring.sinceSkip, false);
check('【v1.9】旧配置没有 runCount 也能读', recur1.recurringRunCount, 0);
check('【v1.9】sinceSkip 参与序列化',
  Account.fromRecord({ name: 'x', recurring: { enabled: true, day: 5, amount: 1, sinceSkip: true } })
    .recurring.sinceSkip, true);

// ⑥ 月扣款流水备注带期数
check('【v1.9】流水备注带期数', addRunNote('房租', 3, 12), '房租（第 3 期 / 共 12 期）');
check('【v1.9】无备注时只显示期数', addRunNote('', 2, 6), '第 2 期 / 共 6 期');

// 2 月没有 30 号 → 落到月末
const feb = new Account({
  name: '月末兜底', opening: 1000,
  recurring: { enabled: true, day: 28, amount: 100, since: '2026-02', runCount: 0 },
});
const febDue = feb.dueRecurring(new Date('2026-02-28'));
check('2 月按 28 号扣', febDue.length, 1);
check('2 月扣款日期正确', febDue[0].date, '2026-02-28');

// 标记执行后不重复（runDueRecurring 会同时推进 lastRun 与 runCount）
feb.markRecurringRun('2026-02');
feb.recurring.runCount = 1;
check('标记执行后当月不再重复扣', feb.dueRecurring(new Date('2026-02-28')).length, 0);
check('标记后下月仍会扣', feb.dueRecurring(new Date('2026-03-28')).length, 1);

// 边界值兜底：day 超界夹到 1–28
const clamp = new Account({
  name: '越界', recurring: { enabled: true, day: 31, amount: 50 },
});
check('day=31 被夹到 28', clamp.recurring.day, 28);
const clamp2 = new Account({
  name: '越界2', recurring: { enabled: true, day: 0, amount: 50 },
});
check('day=0 被夹到 1', clamp2.recurring.day, 1);

// 金额为 0 / 负数 → 视为未启用（不能显示一个凭空的扣款承诺）
const zero = new Account({
  name: '零额', recurring: { enabled: true, day: 5, amount: 0 },
});
check('金额 0 不算启用', zero.hasRecurring, 'false');
const negAmt = new Account({
  name: '负额', recurring: { enabled: true, day: 5, amount: -30 },
});
near('负数金额取绝对值', negAmt.recurring.amount, 30);

// 旧数据（v1.6 及以前）没有 recurring 字段 → 必须优雅兜底
const legacy = Account.fromRecord({
  id: 7, name: '老账户', type: 'bank', opening: 200, entries: [], checkpoints: [],
});
check('旧记录 recurring 兜底为对象', typeof legacy.recurring, 'object');
check('旧记录默认未启用', legacy.recurring.enabled, 'false');
check('旧记录默认 day=1', legacy.recurring.day, 1);
check('旧记录默认 lastRun=null', legacy.recurring.lastRun, 'null');
check('旧记录 hasRecurring=false', legacy.hasRecurring, 'false');

// 序列化往返
const roundTrip = Account.fromRecord(recur1.toRecord());
check('recurring 序列化后能还原', roundTrip.recurring.enabled, 'true');
check('recurring.amount 还原', roundTrip.recurring.amount, 1500);
check('recurring.note 还原', roundTrip.recurring.note, '房租');
check('recurring.lastRun 还原', roundTrip.recurring.lastRun, '2026-09');
check('toJSON 含 recurring', typeof recur1.toJSON().recurring, 'object');

// 充值方向的定时任务（「每月 10 号自动充值」）
// 9/5 启用 → 本月 10 号还没到 → 9/15 那天应已执行 9 月一期
const recIn = new Account({
  name: '按月到账', opening: 0,
  recurring: {
    enabled: true, day: 10, amount: 2000, kind: ACCOUNT_FLOW.IN, note: '生活费',
    since: '2026-09', sinceSkip: false,
  },
});
check('收入方向描述文案', recIn.recurringLabel, '每月 10 号自动充值 ¥2000.00（生活费）');
check('收入方向 due 的 kind', recIn.dueRecurring(new Date('2026-09-15'))[0].kind, ACCOUNT_FLOW.IN);
// 9/15 才启用（已过 10 号）→ 本月那期放弃，10 月 10 号才开始
recIn.recurring.sinceSkip = true;
check('收入方向同样遵守「设置日已过则不扣」', recIn.dueRecurring(new Date('2026-09-15')).length, 0);
check('收入方向下月才执行', recIn.dueRecurring(new Date('2026-10-10'))[0].month, '2026-10');

/* ================================================================
   10. 汇总
   ================================================================ */
group('10. 账户汇总');

const list = [
  new Account({ name: '饭卡', type: ACCOUNT_TYPE.MEAL_CARD, opening: 100, entries: [{ kind: ACCOUNT_FLOW.OUT, amount: 20, date: dayOffset(-1) }] }),
  new Account({ name: '建行卡', type: ACCOUNT_TYPE.BANK, opening: 1000 }),
  new Account({ name: '旧卡', type: ACCOUNT_TYPE.BANK, opening: 5, archived: true }),
];
const sum = summarizeAccounts(list);
check('全部账户 3 个', sum.all.length, 3);
check('活跃账户 2 个', sum.active.length, 2);
check('归档账户 1 个', sum.archived.length, 1);
near('总余额只算活跃账户 80 + 1000 = 1080', sum.totalBalance, 1080);
check('stats.count 是全部账户数', sum.stats.count, 3);
check('stats.activeCount 是活跃数', sum.stats.activeCount, 2);
check('stats.archivedCount 是归档数', sum.stats.archivedCount, 1);
near('stats.totalBalance 与顶层一致', sum.stats.totalBalance, sum.totalBalance);
check('没有快照时 maxDiffAccount 为 null', sum.stats.maxDiffAccount, 'null');

const withDiffList = [
  new Account({ name: '小差', opening: 100, checkpoints: [{ date: '2026-08-01', balance: 98 }] }),
  new Account({ name: '大差', opening: 100, checkpoints: [{ date: '2026-08-01', balance: 40 }] }),
];
check('maxDiffAccount 取差额最大的账户',
  summarizeAccounts(withDiffList).stats.maxDiffAccount.name, '大差');
check('空列表总余额 0', summarizeAccounts([]).totalBalance, 0);
check('空列表活跃 0', summarizeAccounts([]).active.length, 0);
check('空列表 count 0', summarizeAccounts([]).stats.count, 0);

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
