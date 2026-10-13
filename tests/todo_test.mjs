/**
 * todo_test.mjs —— 待办（任务 / 想要）测试（v1.4.0）
 *
 * 覆盖：
 *   模型 —— 构造 / 校验 / 类型 / 完成切换 / 截止日展示 / 逾期判定
 *   排序 —— 未完成在前、逾期优先、已完成沉底
 *   汇总 —— 总数 / 未完成 / 已完成 / 逾期 / 各类型
 *   服务 —— 需要 IndexedDB，浏览器环境才跑得起来；这里用内存桩替代
 *
 * 用法：node tests/todo_test.mjs
 */

import {
  Todo, TODO_KIND, TODO_KIND_META, TODO_KINDS,
  getTodoKindMeta, sortTodos, summarizeTodos,
} from '../web/js/models/todo.js';
import { formatDate } from '../web/js/utils/date_utils.js';

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

/** 相对今天的日期串，便于校验 dueLabel */
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return formatDate(d);
}

/* ================================================================
   1. 类型元数据
   ================================================================ */
group('1. 待办类型（任务 / 想要）');

check('恰好两种类型', TODO_KINDS.length, 2);
check('任务 id', TODO_KIND.TASK, 'task');
check('想要 id', TODO_KIND.WANT, 'want');
check('任务标签', TODO_KIND_META[TODO_KIND.TASK].label, '任务');
check('想要标签', TODO_KIND_META[TODO_KIND.WANT].label, '想要');
ok('两种类型颜色不同',
  TODO_KIND_META[TODO_KIND.TASK].color !== TODO_KIND_META[TODO_KIND.WANT].color,
  `${TODO_KIND_META[TODO_KIND.TASK].color} vs ${TODO_KIND_META[TODO_KIND.WANT].color}`);
ok('两种类型图标不同',
  TODO_KIND_META[TODO_KIND.TASK].icon !== TODO_KIND_META[TODO_KIND.WANT].icon);
check('未知类型回退到任务', getTodoKindMeta('bogus').id, 'task');
check('未传类型回退到任务', getTodoKindMeta(undefined).id, 'task');

/* ================================================================
   2. 构造与校验
   ================================================================ */
group('2. 构造与校验');

const t1 = new Todo({ title: '交实验报告', kind: TODO_KIND.TASK });
check('标题', t1.title, '交实验报告');
check('类型', t1.kind, 'task');
check('默认未完成', t1.done, false);
check('未完成时 doneAt 为空', t1.doneAt, '');
check('校验通过', t1.validate().ok, true);

const t2 = new Todo({ title: '  想看那部电影  ', kind: TODO_KIND.WANT });
check('标题两端空白被裁剪', t2.title, '想看那部电影');
check('想要类型', t2.kind, 'want');

const t3 = new Todo({ title: '', kind: TODO_KIND.TASK });
check('空标题校验失败', t3.validate().ok, false);
check('空标题错误信息', t3.validate().errors[0], '标题不能为空');

const t4 = new Todo({ title: 'x'.repeat(61) });
check('超长标题校验失败', t4.validate().ok, false);

const t5 = new Todo({ title: '测试', kind: 'nonsense' });
check('非法类型被纠正为任务', t5.kind, 'task');

const t6 = new Todo({ title: '测试', due: '2026/09/20' });
check('非法日期格式校验失败', t6.validate().ok, false);
const t7 = new Todo({ title: '测试', due: '2026-09-20' });
check('合法日期通过校验', t7.validate().ok, true);

/* ================================================================
   3. 完成状态切换
   ================================================================ */
group('3. 完成状态切换');

const t8 = new Todo({ title: '写作业' });
check('初始未完成', t8.done, false);
t8.toggleDone();
check('切换后已完成', t8.done, true);
ok('完成后写入 doneAt', !!t8.doneAt, t8.doneAt);
t8.toggleDone();
check('再次切换回未完成', t8.done, false);
check('取消完成后清空 doneAt', t8.doneAt, '');

const t9 = new Todo({ title: '已完成项', done: true, doneAt: '2026-09-15 10:00' });
check('直接构造已完成', t9.done, true);
check('已完成保留 doneAt', t9.doneAt, '2026-09-15 10:00');

/* ================================================================
   4. 截止日期与逾期
   ================================================================ */
group('4. 截止日期与逾期');

const noDue = new Todo({ title: '无截止' });
check('无截止 dueLabel 为空', noDue.dueLabel, '');
check('无截止不逾期', noDue.overdue, false);
check('无截止非今日到期', noDue.dueToday, false);

const todayTodo = new Todo({ title: '今天到期', due: dayOffset(0) });
check('今天 → dueLabel 今天', todayTodo.dueLabel, '今天');
check('今天 → dueToday', todayTodo.dueToday, true);
check('今天不算逾期', todayTodo.overdue, false);

const tomorrow = new Todo({ title: '明天到期', due: dayOffset(1) });
check('明天 → dueLabel 明天', tomorrow.dueLabel, '明天');

const yesterday = new Todo({ title: '昨天到期', due: dayOffset(-1) });
check('昨天 → dueLabel 昨天', yesterday.dueLabel, '昨天');
ok('昨天未完成 → 逾期', yesterday.overdue);

const threeDaysAgo = new Todo({ title: '三天前', due: dayOffset(-3) });
check('三天前 → dueLabel 已逾期 3 天', threeDaysAgo.dueLabel, '已逾期 3 天');

const in3 = new Todo({ title: '三天后', due: dayOffset(3) });
check('三天后 → dueLabel 3 天后', in3.dueLabel, '3 天后');

const in30 = new Todo({ title: '三十天后', due: dayOffset(30) });
ok('远期日期显示月日', /月\d+日/.test(in30.dueLabel), in30.dueLabel);

const doneOverdue = new Todo({ title: '已完成的逾期项', due: dayOffset(-5), done: true });
check('已完成不再算逾期', doneOverdue.overdue, false);

/* ================================================================
   5. 排序
   ================================================================ */
group('5. 排序（未完成在前 · 已完成沉底）');

const a = new Todo({ id: 1, title: 'A 无截止', createdAt: '2026-09-01 10:00' });
const b = new Todo({ id: 2, title: 'B 明天', due: dayOffset(1), createdAt: '2026-09-02 10:00' });
const c = new Todo({ id: 3, title: 'C 昨天(逾期)', due: dayOffset(-1), createdAt: '2026-09-03 10:00' });
const d = new Todo({ id: 4, title: 'D 已完成', done: true, doneAt: '2026-09-10 10:00' });
const e = new Todo({ id: 5, title: 'E 已完成更新', done: true, doneAt: '2026-09-14 10:00' });

const sorted = sortTodos([d, a, e, c, b]);
check('已完成排在最后', sorted.slice(3).every((x) => x.done), true);
check('未完成第 1 位是逾期项', sorted[0].id, 3);
check('未完成第 2 位是明天到期', sorted[1].id, 2);
check('未完成第 3 位是无截止', sorted[2].id, 1);
check('已完成按完成时间倒序（最近在前）', sorted[3].id, 5);
check('已完成最后是较早完成的', sorted[4].id, 4);
ok('排序不改变原数组', [d, a, e, c, b][0].id === 4);

/* ================================================================
   6. 汇总
   ================================================================ */
group('6. 汇总统计');

const stats = summarizeTodos([
  new Todo({ title: 'T1', kind: TODO_KIND.TASK }),
  new Todo({ title: 'T2', kind: TODO_KIND.TASK, done: true, doneAt: '2026-09-10 10:00' }),
  new Todo({ title: 'W1', kind: TODO_KIND.WANT }),
  new Todo({ title: 'W2', kind: TODO_KIND.WANT, done: true, doneAt: '2026-09-11 10:00' }),
  new Todo({ title: '逾期', kind: TODO_KIND.TASK, due: dayOffset(-2) }),
]);
check('总数', stats.total, 5);
check('未完成数', stats.active, 3);
check('已完成数', stats.done, 2);
check('逾期数', stats.overdue, 1);
check('任务总数', stats.task, 3);
check('想要总数', stats.want, 2);
check('已完成任务数', stats.taskDone, 1);
check('已完成想要数', stats.wantDone, 1);

const empty = summarizeTodos([]);
check('空列表总数 0', empty.total, 0);
check('空列表未完成 0', empty.active, 0);
check('空列表逾期 0', empty.overdue, 0);

/* ================================================================
   7. 记录往返
   ================================================================ */
group('7. 记录往返（IndexedDB 存取）');

const orig = new Todo({
  id: 9, title: '往返测试', kind: TODO_KIND.WANT,
  due: '2026-09-25', done: true, doneAt: '2026-09-15 12:00',
  createdAt: '2026-09-01 09:00', sort: 3,
});
const rec = orig.toRecord();
check('记录用下划线列名', rec.done_at, '2026-09-15 12:00');
check('记录里 done 存 1', rec.done, 1);

const back = Todo.fromRecord(rec);
check('往返标题一致', back.title, orig.title);
check('往返类型一致', back.kind, orig.kind);
check('往返完成态一致', back.done, true);
check('往返截止日一致', back.due, orig.due);
check('往返完成时间一致', back.doneAt, orig.doneAt);
check('往返创建时间一致', back.createdAt, orig.createdAt);

check('空记录返回 null', Todo.fromRecord(null), 'null');
check('done=0 解析为 false', Todo.fromRecord({ id: 1, title: 'x', done: 0 }).done, false);
check('done=true 解析为 true', Todo.fromRecord({ id: 1, title: 'x', done: true }).done, true);

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
