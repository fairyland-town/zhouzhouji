/**
 * reminder_test.mjs —— 本地提醒测试（v1.12.0）
 *
 * 覆盖的是**与平台无关的纯逻辑**：把活动列表换算成要登记的系统闹钟。
 * 真正调用原生插件那一步没法在 Node 里跑，所以这里只测「算什么」，
 * 不测「怎么登记」——后者由 E2E 与真机验证兜底。
 *
 * 为什么值得单独测：这段逻辑决定「提醒会不会响 / 会不会重复响」。
 *   算错一天 = 用户漏掉活动；签名不稳定 = 每次对账都重排 = 反复响。
 *
 * 用法：node tests/reminder_test.mjs
 */

import { formatDateTime, formatTime } from '../web/js/utils/date_utils.js';

/* ---------------- 内存版 localStorage（Node 里没有） ---------------- */

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => memStore.clear(),
};

// 必须在 localStorage 就位之后再加载服务（模块内会读它）
const { reminderService, LEAD_MINUTES } = await import('../web/js/services/reminder_service.js');

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0, failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(label, actual, expected) {
  const a = String(actual), e = String(expected);
  if (a === e) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push({ group: currentGroup, label, actual: a, expected: e });
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      期望: ${e}`);
    console.log(`      实际: ${a}`);
  }
}
function ok(label, cond, detail = '') {
  check(label + (detail ? `  （${detail}）` : ''), cond ? 'true' : 'false', 'true');
}

/* ---------------- 造活动 ---------------- */

/** 造一个「距现在 minutesFromNow 分钟开始」的活动 */
function ev(id, minutesFromNow, extra = {}) {
  const d = new Date(Date.now() + minutesFromNow * 60000);
  return {
    id,
    title: `活动${id}`,
    location: '数学学院 201 报告厅',
    startDate: d,
    startTime: formatDateTime(d),
    timeString: formatTime(d),
    ...extra,
  };
}

const LEAD = LEAD_MINUTES * 60000;

/* ================================================================
   1. 基本换算
   ================================================================ */
group('1. 活动 → 闹钟时间换算');

check('提前量是 30 分钟', LEAD_MINUTES, 30);

{
  const start = Date.now() + 3 * 86400000;
  const d = new Date(start);
  const plan = reminderService._plan([{
    id: 7, title: '图论报告', location: '信息楼 A201',
    startDate: d, startTime: formatDateTime(d), timeString: formatTime(d),
  }]);
  const one = plan[7];
  ok('三天后的活动会被登记', !!one);
  check('提醒时间 = 开始时间 − 30 分钟', one.at.getTime(), start - LEAD);
  check('通知标题带活动名', one.title, '即将开始：图论报告');
  ok('通知正文含时间与地点', one.body.includes('信息楼 A201') && one.body.includes(formatTime(d)), one.body);
  check('签名用活动开始时间', one.sig, formatDateTime(d));
}

/* ================================================================
   2. 不该登记的
   ================================================================ */
group('2. 应当被排除的活动');

check('已开始的活动不登记', Object.keys(reminderService._plan([ev(1, -60)])).length, 0);
check('刚开始一秒的活动不登记', Object.keys(reminderService._plan([ev(2, -0.02)])).length, 0);

{
  // 超出 120 天视野的不登记（121 天）
  const far = ev(3, 121 * 24 * 60);
  check('121 天后的活动不登记', Object.keys(reminderService._plan([far])).length, 0);
  // 119 天要登记
  const near = ev(4, 119 * 24 * 60);
  check('119 天后的活动要登记', Object.keys(reminderService._plan([near])).length, 1);
}

check('id 为 0 的活动跳过', Object.keys(reminderService._plan([ev(0, 600)])).length, 0);
check('id 为负数的活动跳过', Object.keys(reminderService._plan([ev(-3, 600)])).length, 0);
check('id 非整数的活动跳过', Object.keys(reminderService._plan([ev(1.5, 600)])).length, 0);
// 数字字符串是**故意放行**的：JSON 导入过的旧数据里 id 可能是字符串，
// 而登记时会 Number() 回数字，所以放行无害、拒绝反而会漏提醒。
{
  const plan = reminderService._plan([ev('9', 600)]);
  check('数字字符串 id 放行并归一化', Object.keys(plan).join(','), '9');
  check('归一化后的 key 就是数字', plan['9'] !== undefined && plan[9] !== undefined, true);
}
check('非数字字符串 id 跳过', Object.keys(reminderService._plan([ev('abc', 600)])).length, 0);
check('超过 32 位的 id 跳过', Object.keys(reminderService._plan([ev(2147483648, 600)])).length, 0);

{
  const bad = ev(5, 600);
  bad.startDate = new Date('不是日期');
  check('时间非法的活动跳过', Object.keys(reminderService._plan([bad])).length, 0);
}

check('空列表返回空计划', Object.keys(reminderService._plan([])).length, 0);
check('null 活动不会炸', Object.keys(reminderService._plan([null, undefined])).length, 0);

/* ================================================================
   3. 已经进入提醒窗口
   ================================================================ */
group('3. 已经进入 30 分钟窗口的活动');

{
  const soon = ev(11, 10);                 // 10 分钟后开始
  const plan = reminderService._plan([soon]);
  const one = plan[11];
  ok('窗口内的活动照样登记', !!one);
  const delta = one.at.getTime() - Date.now();
  ok('落到「立刻响」而不是排到过去的时间点',
    delta >= 0 && delta <= 8000, `${Math.round(delta)} ms 后`);
  // 关键：签名仍取活动开始时间，所以再次对账时不会重排、不会重复响
  check('签名仍是活动开始时间', one.sig, soon.startTime);
}

{
  // 再算一次，签名必须一致 —— 这是「不重复响」的根据
  const soon = ev(12, 12);
  const a = reminderService._plan([soon])[12].sig;
  const b = reminderService._plan([soon])[12].sig;
  check('同一活动两次计算的签名一致', a, b);
}

/* ================================================================
   4. 数量上限
   ================================================================ */
group('4. 数量上限');

{
  const many = [];
  for (let i = 1; i <= 200; i++) many.push(ev(i, 600 + i));
  const plan = reminderService._plan(many);
  check('超出上限时截断到 150 条', Object.keys(plan).length, 150);
  ok('截断后 id 从 1 开始连续', !!plan[1] && !!plan[150] && !plan[151]);
}

/* ================================================================
   5. 已登记账本
   ================================================================ */
group('5. 已登记账本（增量对账的依据）');

{
  reminderService._saveScheduled({ 3: '2026-09-20 14:00', 4: '2026-09-21 09:00' });
  const back = reminderService._scheduled();
  check('账本可读回', back['3'], '2026-09-20 14:00');
  check('账本条目数', Object.keys(back).length, 2);

  reminderService._saveScheduled({});
  check('清空账本', Object.keys(reminderService._scheduled()).length, 0);

  // 脏数据不能让对账崩掉
  localStorage.setItem('cw_reminders_scheduled', '{ 这不是 JSON');
  check('账本损坏时回退为空对象', Object.keys(reminderService._scheduled()).length, 0);
  localStorage.setItem('cw_reminders_scheduled', '"字符串"');
  check('账本类型不对时回退为空对象', Object.keys(reminderService._scheduled()).length, 0);
  reminderService._saveScheduled({});
}

/* ================================================================
   6. 浏览器环境下必须是安全 no-op
   ================================================================ */
group('6. 非原生环境的安全降级');

{
  const r = await reminderService.syncNow();
  check('浏览器里 syncNow 直接跳过', r.skipped, true);

  reminderService._getEvents = () => Promise.resolve([]);
  const r2 = await reminderService.syncNow();
  check('未启用时不登记闹钟', r2.skipped, true);

  check('浏览器里 pendingCount 为 0', await reminderService.pendingCount(), 0);
  check('权限状态来自浏览器 Notification', reminderService.permission, 'unsupported');
  ok('supported 与 Notification 存在性一致', reminderService.supported === false);
}

/* ================================================================
   7. 浏览器轮询路径仍然可用
   ================================================================ */
group('7. 浏览器轮询路径（未被原生改动破坏）');

{
  reminderService.enabled = true;
  reminderService.fired.clear();

  let fired = 0;
  const origNotify = reminderService.notify.bind(reminderService);
  reminderService.notify = () => { fired++; };

  // 窗口内两条 + 窗口外两条 + 已开始一条
  reminderService.checkUpcoming([
    ev(21, 10), ev(22, 25), ev(23, 90), ev(24, 300), ev(25, -10),
  ]);
  check('只对窗口内的活动提醒', fired, 2);

  reminderService.checkUpcoming([ev(21, 10), ev(22, 25)]);
  check('同一条不会重复提醒', fired, 2);

  reminderService.notify = origNotify;
  reminderService.enabled = false;
  reminderService.fired.clear();
}

/* ================================================================
   汇总
   ================================================================ */
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
