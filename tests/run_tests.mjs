/**
 * run_tests.mjs —— 零依赖测试运行器
 * 覆盖 04_测试与质量保证.md 中的单元测试与异常情况用例
 *
 * 用法：node tests/run_tests.mjs
 */
import { parseTime } from '../web/js/services/time_parser.js';
import { parseLocation } from '../web/js/services/location_parser.js';
import { parseTitle } from '../web/js/services/title_parser.js';
import { parseEvent } from '../web/js/services/event_parser.js';
import {
  startOfWeek, startOfNextWeek, addDays, weekDays, isoWeekNumber,
  weekRangeLabel, formatDateTime, formatDate, endOfWeek, addWeeks, parseDateInput,
} from '../web/js/utils/date_utils.js';
import { Event } from '../web/js/models/event.js';
import { amountShort, signedAmount } from '../web/js/utils/money.js';

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0, failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
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

function stringify(v) {
  if (v instanceof Date) return formatDateTime(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1000) / 1000);
  return String(v);
}

/** 基准：04 文档以 2026-09-18 为测试日期 */
const BASE = { baseYear: 2026, now: new Date(2026, 8, 15, 10, 0, 0) };
const t = (text) => {
  const r = parseTime(text, BASE);
  return r.date ? formatDateTime(r.date) : null;
};

/* ================================================================
   1. 时间解析（04 文档第 2 节）
   ================================================================ */
group('1. 时间解析 — 04 文档第 2 节');

check('9月18日下午3点 → 2026-09-18 15:00', t('9月18日下午3点'), '2026-09-18 15:00');
check('9月18日上午9点半 → 2026-09-18 09:30', t('9月18日上午9点半'), '2026-09-18 09:30');
check('9.18 14:30 → 2026-09-18 14:30', t('9.18 14:30'), '2026-09-18 14:30');
check('9月18日 15:00 → 2026-09-18 15:00', t('9月18日 15:00'), '2026-09-18 15:00');
check('2026年9月18日15时 → 2026-09-18 15:00', t('2026年9月18日15时'), '2026-09-18 15:00');
check('时间：9月18日 15:00（带前缀）', t('时间：9月18日 15:00'), '2026-09-18 15:00');
check('活动时间：9月18号 下午3:30', t('活动时间：9月18号 下午3:30'), '2026-09-18 15:30');
check('9-18 19:00 → 2026-09-18 19:00', t('9-18 19:00'), '2026-09-18 19:00');
check('2026-09-18 09:00', t('2026-09-18 09:00'), '2026-09-18 09:00');
check('9月18日晚上7点半 → 19:30', t('9月18日晚上7点半'), '2026-09-18 19:30');
check('九月十八日下午三点 → 15:00', t('九月十八日下午三点'), '2026-09-18 15:00');
check('9月18日中午12:30 → 12:30', t('9月18日中午12:30'), '2026-09-18 12:30');
check('9月18日早上8点 → 08:00', t('9月18日早上8点'), '2026-09-18 08:00');
check('全角冒号 ９月１８日　１５：００', t('９月１８日　１５：００'), '2026-09-18 15:00');
check('9月18日 14时30分 → 14:30', t('9月18日 14时30分'), '2026-09-18 14:30');

/* 相对日期（基准 2026-09-15 是周二） */
check('今天19:00 → 2026-09-15 19:00', t('今天19:00'), '2026-09-15 19:00');
check('明天上午10点 → 2026-09-16 10:00', t('明天上午10点'), '2026-09-16 10:00');
check('本周五下午2点 → 2026-09-18 14:00', t('本周五下午2点'), '2026-09-18 14:00');
check('下周三上午9点 → 2026-09-23 09:00', t('下周三上午9点'), '2026-09-23 09:00');

/* 异常：无时间 */
check('无时间文本 → null', t('这是一条没有时间的通知'), null);
check('空字符串 → null', t(''), null);

/* ================================================================
   2. 地点解析（04 文档第 3 节）
   ================================================================ */
group('2. 地点解析 — 04 文档第 3 节');
const loc = (text) => parseLocation(text).location;

check('地点：数学学院201报告厅', loc('地点：数学学院201报告厅'), '数学学院201报告厅');
check('本次会议在社科楼A101举行', loc('本次会议在社科楼A101举行'), '社科楼A101');
check('报告地点：信息楼A201', loc('报告地点：信息楼A201'), '信息楼A201');
check('会议地点：行政楼三楼会议室', loc('会议地点：行政楼三楼会议室'), '行政楼三楼会议室');
check('讲座地点：文科楼报告厅', loc('讲座地点：文科楼报告厅'), '文科楼报告厅');
check('活动地点: 大学生活动中心', loc('活动地点: 大学生活动中心'), '大学生活动中心');
check('独立行「数学学院201报告厅」', loc('数学学院201报告厅'), '数学学院201报告厅');
check('于图书馆学术厅举办', loc('本次报告于图书馆学术厅举办'), '图书馆学术厅');
check('跨行：报告地点：\\n信息楼A201', loc('报告地点：\n信息楼A201'), '信息楼A201');
check('无地点 → null', loc('时间：9月18日15:00\n欢迎参加'), null);

/* ================================================================
   3. 名称解析（04 文档第 4 节）
   ================================================================ */
group('3. 名称解析 — 04 文档第 4 节');
const title = (text) => parseTitle(text).title;

check('报告题目：组合数学中的若干问题',
  title('报告题目：组合数学中的若干问题'), '组合数学中的若干问题');
check('讲座题目：人工智能前沿进展',
  title('讲座题目：人工智能前沿进展'), '人工智能前沿进展');
check('活动名称：2026年研究生就业宣讲会',
  title('活动名称：2026年研究生就业宣讲会'), '2026年研究生就业宣讲会');
check('主题：新能源材料发展',
  title('主题：新能源材料发展'), '新能源材料发展');
check('跨行 报告题目：\\n图论中的均衡染色问题',
  title('报告题目：\n图论中的均衡染色问题'), '图论中的均衡染色问题');
check('书名号《人工智能专题讲座》',
  title('请参加《人工智能专题讲座》，欢迎师生'), '人工智能专题讲座');
check('首行兜底：关于举办学术报告会的通知',
  title('关于举办学术报告会的通知\n时间：9月18日15:00'), '关于举办学术报告会');
check('首行兜底：关于举办第九届学术文化节的通知',
  title('关于举办第九届学术文化节的通知\n时间：9月28日9:00'), '关于举办第九届学术文化节');
check('栏目标签行不作为名称（【学术报告】）',
  title('【学术报告】\n时间：9月18日15:00\n地点：数学学院201报告厅'), null);

/* 回归用例：微信/公众号风格的宣讲会通知
   （2026-09-15 实际反馈：企业名 + 引号修饰 + 破折号后缀被截断成引号内的几个字） */
check('Markdown 波浪线包裹的宣讲会全名',
  title('~~泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站~~\n时间：9月17日下午15:00\n地点：柳林校区弘远楼101'),
  '泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站');
check('无引号的宣讲会全名',
  title('~~华为2026校园招聘宣讲会——西南财经大学站~~\n时间：9月20日19:00'),
  '华为2026校园招聘宣讲会——西南财经大学站');
check('引号作为名称修饰成分时不被单独截取',
  title('~~腾讯"青云计划"技术分享会~~\n时间：9月19日14:00'),
  '腾讯"青云计划"技术分享会');
check('引号包裹的完整名称（整行即名称）',
  title('"人工智能"专题讲座\n时间：9月18日15:00'),
  '人工智能"专题讲座');
check('【宣讲会】前缀不成残留】符号',
  title('【宣讲会】关于举办2027届"科技专场"巡回宣讲会的通知\n时间：9月17日15:00'),
  '关于举办2027届"科技专场"巡回宣讲会');
check('双选会等非「报告」类活动名',
  title('2026年秋季双选会\n时间：10月15日9:00\n地点：体育馆'),
  '2026年秋季双选会');

/* 回归用例：叙述式（非公文式）通知 —— 2026-09-15 用户真实截图
   题目嵌在句子里，且句尾还跟着「进行活动签到」的干扰句 */
check('叙述式通知取「主题为：」后的题目（不被句尾签到干扰）',
  title('【学术部通知】各位同学好，商学院工商管理系邀请到香港理工大学商学院 Harry Zhang 教授于9月28日（周五）15:30-16:30在博学楼B412会议室举行讲座，主题为：考虑交易成本的最优均值回归trading策略，欢迎大家积极参加！我们将在群内进行活动签到'),
  '考虑交易成本的最优均值回归trading策略');
check('叙述式通知：句尾「进行活动签到」不得成为活动名',
  title('明天下午3点在博学楼B412会议室举行讲座，主题为：量子计算前沿，随后在群内进行活动签到'),
  '量子计算前沿');
check('句子内嵌活动名仍可提取（未回归）',
  title('定于9月20日上午9点半在社科楼报告厅举行研究生就业宣讲会，请准时参加。'),
  '研究生就业宣讲会');
check('公文式「关于…的通知」不被句子内嵌规则截断（未回归）',
  title('关于举办第九届学术文化节的通知\n时间：9月28日9:00'),
  '关于举办第九届学术文化节');

/* ================================================================
   3b. 报告人解析（含英文名）
   ================================================================ */
group('3b. 报告人解析 — 中英文姓名');

const spk = (text) => parseEvent(text, BASE).speaker;

check('中文报告人：报告人：张伟教授', spk('报告题目：图论\n报告人：张伟教授\n时间：9月18日15:00'), '张伟');
check('中文报告人：主讲人：李敏', spk('讲座题目：AI\n主讲人：李敏\n时间：9月16日19:00'), '李敏');
check('英文报告人：「邀请到… Harry Zhang 教授于…举行讲座」',
  spk('邀请到香港理工大学商学院 Harry Zhang 教授于9月28日15:30在博学楼B412会议室举行讲座，主题为：考虑交易成本的最优均值回归trading策略'),
  'Harry Zhang');
check('英文报告人：三节姓名 John F. Nash',
  spk('[学术报告] 由普林斯顿大学 John F. Nash 教授主讲，题目：博弈论\n时间：9月20日10:00\n地点：A101报告厅'),
  'John F. Nash');
check('英文报告人不被职称误当作姓名',
  spk('Professor Smith 于9月20日10:00在A101举行讲座') || '(空)', '(空)');
check('报告人字段在无姓名时为空',
  spk('通知：本周五下午2点在图书馆学术厅举办读书分享会。') || '(空)', '(空)');

/* ================================================================
   4. EventParser 整合
   ================================================================ */
group('4. EventParser 整合解析');

const realNotice = `【学术报告】
报告题目：图论中的均衡染色问题
报告人：张伟教授
时间：2026年9月18日下午3点
地点：数学学院201报告厅
欢迎广大师生参加！`;

const p1 = parseEvent(realNotice, BASE);
check('完整通知 — 名称', p1.title, '图论中的均衡染色问题');
check('完整通知 — 时间', p1.startTime, '2026-09-18 15:00');
check('完整通知 — 地点', p1.location, '数学学院201报告厅');
check('完整通知 — 无缺失字段', p1.missing.length, 0);
check('完整通知 — 置信度 ≥ 0.8', p1.confidence >= 0.8, true);

const p2 = parseEvent('【讲座通知】\n讲座题目：人工智能专题讲座\n时间：9月16日晚上7点\n地点：信息楼A201', BASE);
check('讲座通知 — 名称', p2.title, '人工智能专题讲座');
check('讲座通知 — 时间', p2.startTime, '2026-09-16 19:00');
check('讲座通知 — 地点', p2.location, '信息楼A201');

const p3 = parseEvent('各位同学：\n定于9月20日上午9点半在社科楼报告厅举行研究生就业宣讲会，请准时参加。', BASE);
check('叙述体通知 — 时间', p3.startTime, '2026-09-20 09:30');
check('叙述体通知 — 地点', p3.location, '社科楼报告厅');

/* 异常情况（04 文档第 7 节） */
group('5. 异常情况 — 04 文档第 7 节');

const noLoc = parseEvent('报告题目：组合数学若干问题\n时间：9月18日15:00', BASE);
check('缺地点 — missing 含 location', noLoc.missing.includes('location'), true);
check('缺地点 — 名称仍可识别', noLoc.title, '组合数学若干问题');
check('缺地点 — 时间仍可识别', noLoc.startTime, '2026-09-18 15:00');

const noTime = parseEvent('报告题目：组合数学若干问题\n地点：数学学院201报告厅', BASE);
check('缺时间 — missing 含 startTime', noTime.missing.includes('startTime'), true);
check('缺时间 — startTime 为空', noTime.startTime, '');

const emptyText = parseEvent('', BASE);
check('空文本 — 三个字段都缺失', emptyText.missing.length, 3);
check('空文本 — 不抛异常且置信度为 0', emptyText.confidence, 0);

const garbage = parseEvent('阿萨德发噶十多个哈哈哈哈###$$$', BASE);
check('乱码文本 — 不抛异常', typeof garbage.confidence, 'number');
check('乱码文本 — 时间未识别', garbage.startTime, '');

const weird = parseEvent('时间：13月45日99点\n地点：不存在的地方', BASE);
check('非法日期 — 时间应未识别', weird.startTime, '');

const noCrash = () => {
  try {
    parseEvent(null, BASE);
    parseEvent(undefined, BASE);
    parseEvent(12345, BASE);
    return 'ok';
  } catch (e) { return 'threw: ' + e.message; }
};
check('null/undefined/数字 输入不崩溃', noCrash(), 'ok');

/* ================================================================
   6. 周计算（04 文档第 5 节 / 03 文档第 6 节）
   ================================================================ */
group('6. 周计算 — 04 文档第 5 节 / 03 文档第 6 节');

check('2026-09-15（周二）所在周周一', formatDate(startOfWeek(new Date(2026, 8, 15))), '2026-09-14');
check('2026-09-15 所在周下周一', formatDate(startOfNextWeek(new Date(2026, 8, 15))), '2026-09-21');
check('2026-09-15 所在周周日', formatDate(endOfWeek(new Date(2026, 8, 15))), '2026-09-20');
check('周一是周一自身', formatDate(startOfWeek(new Date(2026, 8, 14))), '2026-09-14');
check('周日归入本周（不跳到下周）', formatDate(startOfWeek(new Date(2026, 8, 20))), '2026-09-14');
check('周三（9/16）归入本周', formatDate(startOfWeek(new Date(2026, 8, 16))), '2026-09-14');

check('当前周日期范围标签', weekRangeLabel(new Date(2026, 8, 15)), '9月14日 - 9月20日');
check('跨月：9月28日 - 10月4日',
  weekRangeLabel(new Date(2026, 9, 1)), '9月28日 - 10月4日');
check('跨年：12月28日 - 1月3日',
  weekRangeLabel(new Date(2026, 11, 31)), '2026年12月28日 - 2027年1月3日');

check('周数组恰好 7 天', weekDays(new Date(2026, 8, 15)).length, 7);
check('周数组首日 = 周一', formatDate(weekDays(new Date(2026, 8, 15))[0]), '2026-09-14');
check('周数组末日 = 周日', formatDate(weekDays(new Date(2026, 8, 15))[6]), '2026-09-20');

check('2026-09-14 的 ISO 周号 = 38', isoWeekNumber(new Date(2026, 8, 14)), 38);
check('上下周偏移 ±7 天', formatDate(addWeeks(new Date(2026, 8, 15), -1)), '2026-09-08');
check('加 7 天跨月正确', formatDate(addDays(new Date(2026, 8, 28), 7)), '2026-10-05');

/* 跨年边界：2026-12-28 是周一 */
check('跨年周起始', formatDate(startOfWeek(new Date(2026, 11, 31))), '2026-12-28');
check('跨年周含次年 1 月', formatDate(addDays(startOfWeek(new Date(2026, 11, 31)), 6)), '2027-01-03');

/* ================================================================
   7. 归周逻辑（活动不会放错周）
   ================================================================ */
group('7. 活动归周逻辑');

function bucketOf(startTime, anyDayInWeek) {
  const from = formatDateTime(startOfWeek(anyDayInWeek));
  const to = formatDateTime(startOfNextWeek(anyDayInWeek));
  return startTime >= from && startTime < to;
}

check('9/14 09:00 属于 9/14-9/20 周', bucketOf('2026-09-14 09:00', new Date(2026, 8, 15)), true);
check('9/20 23:00 属于 9/14-9/20 周', bucketOf('2026-09-20 23:00', new Date(2026, 8, 15)), true);
check('9/21 00:00 不属于 9/14-9/20 周', bucketOf('2026-09-21 00:00', new Date(2026, 8, 15)), false);
check('9/13 23:59 不属于 9/14-9/20 周', bucketOf('2026-09-13 23:59', new Date(2026, 8, 15)), false);
check('跨年 2027-01-01 归入 12/28-1/3 周', bucketOf('2027-01-01 10:00', new Date(2026, 11, 31)), true);

/* ================================================================
   8. Event 模型（04 文档第 6 节）
   ================================================================ */
group('8. Event 模型与校验');

const ev = new Event({ title: '测试活动', location: '测试地点', startTime: '2026-09-18 15:00' });
check('Event — timeString', ev.timeString, '15:00');
check('Event — dateString', ev.dateString, '2026-09-18');
check('Event — 校验通过', ev.validate().ok, true);
check('Event — createdAt 自动生成', !!ev.createdAt, true);
check('Event — toRecord 使用 SQLite 列名', ev.toRecord().start_time, '2026-09-18 15:00');

const bad = new Event({ title: '', location: '', startTime: '' });
check('Event — 空字段校验失败', bad.validate().ok, false);
check('Event — 错误信息 3 条', bad.validate().errors.length, 3);

const restored = Event.fromRecord(ev.toRecord());
check('Event — 记录往返一致', restored.startTime, ev.startTime);
check('Event — 记录往返标题一致', restored.title, ev.title);

/* ================================================================
   手输日期解析（v1.13.5）
   —— 用户 2026-09-22：「所有填写日期的时候不应该只有一种格式
      2026-10-08。2026.3.8 这种以及 2026.09.08 都可以」
   ================================================================ */
group('手输日期解析 parseDateInput —— 多种写法都要认');

// 用户点名的三种写法，必须全过
check('2026-10-08 → 原样', parseDateInput('2026-10-08'), '2026-10-08');
check('2026.3.8 → 补零', parseDateInput('2026.3.8'), '2026-03-08');
check('2026.09.08 → 原样', parseDateInput('2026.09.08'), '2026-09-08');
// 顺带放行的写法
check('2026/3/8（斜杠）', parseDateInput('2026/3/8'), '2026-03-08');
check('2026-10-8（日不补零）', parseDateInput('2026-10-8'), '2026-10-08');
check('2026年3月8日（中文）', parseDateInput('2026年3月8日'), '2026-03-08');
check('2026年3月8号（号）', parseDateInput('2026年3月8号'), '2026-03-08');
check('前后有空格也能认', parseDateInput('  2026-10-08  '), '2026-10-08');
check('边界 2026-01-01', parseDateInput('2026-01-01'), '2026-01-01');
check('边界 2026-12-31', parseDateInput('2026-12-31'), '2026-12-31');

group('手输日期解析 —— 看不懂的必须老实返回 null');

// 🔴 这一条是整个函数的重点：正则能过，但那天根本不存在。
//    JS 的 new Date(2026, 1, 31) 会**静默滚到 3 月 3 日**，
//    不做回读校验就会把一个用户从没输入过的日期存进库里。
check('2026-02-31（那天不存在）', parseDateInput('2026-02-31'), null);
check('2026-13-01（13 月）', parseDateInput('2026-13-01'), null);
check('2026-00-10（0 月）', parseDateInput('2026-00-10'), null);
check('2026-10-00（0 日）', parseDateInput('2026-10-00'), null);
check('2026-04-31（4 月没有 31 号）', parseDateInput('2026-04-31'), null);
check('2026-02-29（2026 不是闰年）', parseDateInput('2026-02-29'), null);
// 反向验证：上一条不是「一刀切禁掉 2-29」，2024 是闰年，必须放行
check('2024-02-29（闰年，合法）', parseDateInput('2024-02-29'), '2024-02-29');

check('空串', parseDateInput(''), null);
check('纯空格', parseDateInput('   '), null);
check('null', parseDateInput(null), null);
check('undefined', parseDateInput(undefined), null);
check('人话「明天」', parseDateInput('明天'), null);
check('两位年份 26-10-08', parseDateInput('26-10-08'), null);
// 🔴 锚定验证：不加 ^ $ 的话，下面这条会被判成合法日期
check('后面拖垃圾', parseDateInput('2026-10-08 随便写点什么'), null);
check('前面拖垃圾', parseDateInput('截止 2026-10-08'), null);
check('紧贴字母', parseDateInput('2026-10-08abc'), null);

/* ================================================================
   流水金额短格式（v1.13.5）
   —— 流水明细照参考图改版后，右侧只留一个数字，
      参考图里写的是 `-42.5` / `385`，不是 `¥42.50`。
   ================================================================ */
group('流水金额短格式 amountShort / signedAmount');

// 去掉无意义的小数尾巴 —— 这是参考图里最明显的一条
check('42.50 → 42.5', amountShort(42.5), '42.5');
check('200.00 → 200', amountShort(200), '200');
check('96.80 → 96.8', amountShort(96.8), '96.8');
check('385 → 385', amountShort(385), '385');
check('0.50 → 0.5', amountShort(0.5), '0.5');
// 该留的小数一位不少
check('1234.56 → 1234.56', amountShort(1234.56), '1234.56');
check('0.01 → 0.01', amountShort(0.01), '0.01');
// 日小计不带符号（方向已经由组头「支出/收入」说了）
check('日小计 100.50 → 100.5', amountShort(100.5), '100.5');

// 🔴 符号来自 isExpense，**不是**看数字正负 ——
//    库里 amount 恒为正数，方向另存在 direction 字段。
//    如果这里按 `v < 0` 判断，支出会显示成 +42.5。
check('支出 -42.5', signedAmount(42.5, true), '-42.5');
check('支出 -200', signedAmount(200, true), '-200');
check('收入 +3000', signedAmount(3000, false), '+3000');
check('收入 +12.5', signedAmount(12.5, false), '+12.5');
// 反向验证：传负数进来（脏数据）也要按方向给号，不能出现 `--42.5`
check('传负数也不出现双负号', signedAmount(-42.5, true), '-42.5');
check('传负数、方向是收入 → +42.5', signedAmount(-42.5, false), '+42.5');

check('0 → 0', amountShort(0), '0');
check('null → 0（不抛错）', amountShort(null), '0');
check('undefined → 0', amountShort(undefined), '0');
check('NaN → 0', amountShort(NaN), '0');
check('字符串数字 "42.50"', amountShort('42.50'), '42.5');

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
