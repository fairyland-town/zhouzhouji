// category_test.mjs —— 活动分类识别 与 报告人提取 回归测试
// 覆盖用户诉求（v1.2）：
//   1. 只保留三类：学术 / 就业 / 其他，简洁为主
//   2. 学术会议、学术报告、讲座、论坛统一归「学术」
//   3. 宣讲、招聘统一归「就业」
//   4. 学术类的「活动名称」本身就是会议名，不再单独维护会议名字段
import { parseCategory } from '../web/js/services/category_parser.js';
import { parseSpeaker } from '../web/js/services/speaker_parser.js';
import { parseEvent } from '../web/js/services/event_parser.js';
import { CATEGORY, isAcademic, getCategory, normalizeCategory, LEGACY_CATEGORY_MAP } from '../web/js/models/categories.js';
import { Event } from '../web/js/models/event.js';

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` —— ${extra}` : '')); console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ============================================================
   1. 只有三个分类
   ============================================================ */
console.log('\n1. 分类精简为三类');

{
  const all = [CATEGORY.ACADEMIC, CATEGORY.JOB, CATEGORY.OTHER];
  eq(all.length, 3, '分类总数为 3');
  eq(CATEGORY.ACADEMIC, 'academic', '分类 id：学术');
  eq(CATEGORY.JOB, 'job', '分类 id：就业');
  eq(CATEGORY.OTHER, 'other', '分类 id：其他');
  /* 旧的 7 类 id 必须已不存在 */
  ok(!normalizeCategory('academic_meeting') || normalizeCategory('academic_meeting') === CATEGORY.ACADEMIC,
    '旧 id academic_meeting 被迁移');
  ok(!normalizeCategory('lecture') || normalizeCategory('lecture') === CATEGORY.ACADEMIC,
    '旧 id lecture 被迁移到学术');
  ok(!normalizeCategory('recruit') || normalizeCategory('recruit') === CATEGORY.JOB,
    '旧 id recruit 被迁移到就业');
  ok(!normalizeCategory('campus') || normalizeCategory('campus') === CATEGORY.OTHER,
    '旧 id campus 被迁移到其他');
  ok(!normalizeCategory('teaching_meeting') || normalizeCategory('teaching_meeting') === CATEGORY.OTHER,
    '旧 id teaching_meeting 被迁移到其他');
}

/* ============================================================
   2. 分类识别
   ============================================================ */
console.log('\n2. 活动分类识别');

const CAT_CASES = [
  /* 学术：会议 / 报告 / 讲座 / 论坛 全部归学术 */
  ['关于举办第12届计算机科学前沿学术研讨会的通知', CATEGORY.ACADEMIC, '学术研讨会'],
  ['2026年国际会议暨人工智能前沿论坛', CATEGORY.ACADEMIC, '国际会议'],
  ['学术交流会：数字经济发展新趋势', CATEGORY.ACADEMIC, '学术交流会'],
  ['学术报告：图论中的均衡染色问题', CATEGORY.ACADEMIC, '学术报告'],
  ['特邀报告——量子计算最新进展', CATEGORY.ACADEMIC, '特邀报告'],
  ['报告题目：深度学习在医学影像中的应用', CATEGORY.ACADEMIC, '报告题目'],
  ['关于举办"数字经济与就业"专题讲座的通知', CATEGORY.ACADEMIC, '专题讲座'],
  ['名师讲座预告：如何写好学术论文', CATEGORY.ACADEMIC, '名师讲座'],
  ['新能源材料发展论坛', CATEGORY.ACADEMIC, '论坛'],
  ['关于举办"青年学者沙龙"的通知', CATEGORY.ACADEMIC, '沙龙'],
  ['学术沙龙：城市更新与社区治理', CATEGORY.ACADEMIC, '学术沙龙'],

  /* 就业：宣讲 / 招聘 */
  ['~~泰康保险集团2027"科技专场"巡回宣讲会~~', CATEGORY.JOB, '宣讲会'],
  ['2026届毕业生秋季双选会通知', CATEGORY.JOB, '双选会'],
  ['校园招聘专场：某银行管培生项目', CATEGORY.JOB, '校园招聘'],
  ['【招聘】宣讲单位：华为技术有限公司', CATEGORY.JOB, '招聘'],

  /* 其他：教学 / 校园 / 会议等剩下的全部 */
  ['关于开展2026年秋季学期教学工作部署会的通知', CATEGORY.OTHER, '教学工作部署会'],
  ['数学学院党委会会议安排', CATEGORY.OTHER, '党委会'],
  ['"青春歌会"校园歌手大赛决赛', CATEGORY.OTHER, '歌手大赛'],
  ['2026级新生开学典礼', CATEGORY.OTHER, '开学典礼'],
  ['关于举办消防应急演练的通知', CATEGORY.OTHER, '演练'],
];
CAT_CASES.forEach(([text, expected, label]) => {
  eq(parseCategory(text).category, expected, `${label} → ${getCategory(expected).label}`);
});

/* 用户指定分类优先级最高 */
eq(parseCategory('随便什么文字', { hint: CATEGORY.ACADEMIC }).category, CATEGORY.ACADEMIC, '用户指定分类优先');
eq(parseCategory('').category, CATEGORY.OTHER, '空文本 → 其他');
eq(parseCategory('明天上午开会').category, CATEGORY.OTHER, '无关键词 → 其他');

/* --- 学术 / 就业 的冲突边界 --- */
const BOUNDARY = [
  // 「专题讲座」是明确学术形态，不被伴随词「就业」抢走
  ['关于举办"数字经济与就业"专题讲座的通知', CATEGORY.ACADEMIC, '专题讲座不被「就业」抢走'],
  ['就业指导专题讲座，由张伟教授主讲', CATEGORY.ACADEMIC, '就业+专题讲座 → 学术'],
  // 宣讲会形态明确，不被学术词抢走
  ['就业宣讲会暨产学研论坛', CATEGORY.JOB, '宣讲会优先于论坛'],
  // 地点字段不得污染分类
  ['关于举办发展论坛的通知\n活动地点：材料学院学术报告厅', CATEGORY.ACADEMIC, '地点里的「学术报告厅」不污染分类'],
  ['学生工作会议\n地点：行政楼学术报告厅', CATEGORY.OTHER, '工作会议 + 学术报告厅地点 → 其他'],
];
BOUNDARY.forEach(([text, expected, label]) => {
  eq(parseCategory(text).category, expected, label);
});

/* --- 内部事务词否决：带「研讨会」但其实是学校内部工作会 --- */
console.log('\n2b. 内部事务词否决（不被「研讨会」误判为学术）');
const BLOCK_CASES = [
  ['会议通知\n会议名称：学院教学工作研讨会', CATEGORY.OTHER, '教学工作研讨会 → 其他'],
  ['年度科研工作总结会议', CATEGORY.OTHER, '科研工作总结 → 其他'],
  ['明天的党委会扩大会议，含专题研讨环节', CATEGORY.OTHER, '党委会 → 其他'],
  ['实验室安全培训研讨会', CATEGORY.OTHER, '安全培训 → 其他'],
  ['本科毕业论文答辩工作研讨会', CATEGORY.OTHER, '答辩 → 其他'],
  // 不能被误杀的真正学术活动
  ['第12届计算机科学前沿学术研讨会', CATEGORY.ACADEMIC, '真学术研讨会不会被否决'],
  ['人工智能前沿讲座，由张伟教授主讲', CATEGORY.ACADEMIC, '真学术讲座不会被否决'],
];
BLOCK_CASES.forEach(([text, expected, label]) => {
  eq(parseCategory(text).category, expected, label);
});

/* 学术标记 */
ok(isAcademic(CATEGORY.ACADEMIC), 'academic 标记为学术类');
ok(!isAcademic(CATEGORY.JOB), 'job 不是学术类');
ok(!isAcademic(CATEGORY.OTHER), 'other 不是学术类');

/* ============================================================
   3. 报告人提取
   ============================================================ */
console.log('\n3. 报告人提取');

const SPK_CASES = [
  ['报告人：张伟教授\n时间：9月18日', '张伟', '行内 + 职称'],
  ['报告人：李敏', '李敏', '行内无职称'],
  ['主讲人: 王强老师', '王强', '主讲人 + 老师'],
  ['特邀报告人：陈明院士', '陈明', '特邀报告人 + 院士'],
  ['报告人：张三、李四', '张三', '多人取首位'],
  ['报告人：张伟（清华大学）', '张伟', '带单位'],
  ['报告人：\n赵六\n时间：9月18日', '赵六', '标签行在上一行'],
  ['本次讲座由孙七教授主讲', '孙七', '句内「由…主讲」'],
  ['特邀周八博士作报告', '周八', '句内「特邀…作报告」'],
];
SPK_CASES.forEach(([text, expected, label]) => {
  eq(parseSpeaker(text).speaker, expected, label);
});

/* 职称后缀必须长词优先，否则「副教授」会被削成「副」 */
eq(parseSpeaker('报告人：李敏副教授').speaker, '李敏', '「副教授」完整剥离（长后缀优先）');
eq(parseSpeaker('报告人：赵四副研究员').speaker, '赵四', '「副研究员」完整剥离');
eq(parseSpeaker('报告人：钱五博士生导师').speaker, '钱五', '「博士生导师」完整剥离');

/* 不应误抓 */
eq(parseSpeaker('时间：9月18日\n地点：信息楼A201').speaker, '', '无报告人字段 → 空');
eq(parseSpeaker('报告人：各位同学').speaker, '', '「各位同学」不是姓名');
eq(parseSpeaker('报告人：时间').speaker, '', '字段名不是姓名');
eq(parseSpeaker('').speaker, '', '空文本 → 空');

/* ============================================================
   4. 端到端整合（parseEvent）
   ============================================================ */
console.log('\n4. 端到端整合 parseEvent');

const NOTICE_ACADEMIC = `关于举办第12届计算机科学前沿学术研讨会的通知
各位老师：
    第12届计算机科学前沿学术研讨会定于9月20日上午9:00在信息楼A301报告厅举行。
    报告人：张伟教授（清华大学）
    欢迎参加。`;

{
  const r = parseEvent(NOTICE_ACADEMIC, { baseYear: 2026 });
  eq(r.category, CATEGORY.ACADEMIC, '学术类分类正确');
  ok(r.academic, 'academic 标记为 true');
  eq(r.speaker, '张伟', '报告人提取正确');
  eq(r.startTime, '2026-09-20 09:00', '时间提取正确');
  eq(r.location, '信息楼A301报告厅', '地点提取正确');
  ok(r.title.includes('学术研讨会'), '学术类的活动名称即会议全称', `实际：${r.title}`);
  ok(!('meetingName' in r), 'parseEvent 不再返回 meetingName 字段');
}

const NOTICE_JOB = `~~泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站~~
时间：9月19日19:00
地点：柳林校区学生活动中心
欢迎各专业同学参加！`;

{
  const r = parseEvent(NOTICE_JOB, { baseYear: 2026 });
  eq(r.category, CATEGORY.JOB, '宣讲会归入就业');
  ok(!r.academic, '就业类非学术');
  eq(r.speaker, '', '非学术类不提取报告人');
  ok(r.title.includes('泰康保险集团'), '企业名保留在标题中', `实际：${r.title}`);
}

const NOTICE_OTHER = `明天上午10时在行政楼会议室召开学生工作会议，请各位辅导员准时参加。`;
{
  const r = parseEvent(NOTICE_OTHER, { baseYear: 2026 });
  eq(r.category, CATEGORY.OTHER, '工作会议归入其他');
  ok(!r.academic, '其他类非学术');
}

/* ============================================================
   5. 学术类只需填名称 + 报告人（不再有会议名）
   ============================================================ */
console.log('\n5. 学术类字段精简');

{
  const r = parseEvent(NOTICE_ACADEMIC, { baseYear: 2026 });
  const e = new Event({
    title: r.title, location: r.location, startTime: r.startTime,
    category: r.category, speaker: r.speaker,
  });
  eq(e.title, r.title, '活动名称直接存为标题（即会议名 / 报告题目）');
  eq(e.speaker, '张伟', '报告人单独存');
  ok(!('meetingName' in e), 'Event 实例没有 meetingName 属性');
  const rec = e.toRecord();
  ok(!('meeting_name' in rec), 'toRecord 不再输出 meeting_name');
}

/* ============================================================
   6. Event 模型字段与向后兼容
   ============================================================ */
console.log('\n6. Event 模型字段与向后兼容');

{
  const e = new Event({
    title: '图论中的均衡染色问题', location: '信息楼A201', startTime: '2026-09-18 15:00',
    category: CATEGORY.ACADEMIC, speaker: '李敏',
  });
  eq(e.category, CATEGORY.ACADEMIC, 'category 字段');
  eq(e.speaker, '李敏', 'speaker 字段');
  ok(e.academic, 'Event.academic getter');

  const rec = e.toRecord();
  eq(rec.category, CATEGORY.ACADEMIC, 'toRecord 输出 category');
  eq(rec.speaker, '李敏', 'toRecord 输出 speaker');

  const back = Event.fromRecord(rec);
  eq(back.category, CATEGORY.ACADEMIC, '记录往返 category');
  eq(back.speaker, '李敏', '记录往返 speaker');
  eq(back.title, '图论中的均衡染色问题', '记录往返 title');
}

/* v1.0 旧记录（无新字段）必须能正常还原，不抛错 */
{
  const legacy = {
    id: 7, title: '旧的宣讲会', location: '学生活动中心',
    start_time: '2026-09-19 19:00', raw_text: '旧数据', created_at: '2026-09-15 10:00',
  };
  const e = Event.fromRecord(legacy);
  eq(e.category, CATEGORY.OTHER, 'v1.0 旧记录 category 回退到 other');
  eq(e.speaker, '', 'v1.0 旧记录 speaker 为空字符串');
  ok(!e.academic, 'v1.0 旧记录 academic 为 false');
  ok(e.validate().ok, 'v1.0 旧记录仍通过校验');
}

/* v1.1 旧记录的 7 类 id 必须自动迁移到新 3 类 */
console.log('\n7. v1.1 旧数据迁移到新三分类');
const MIGRATION = [
  ['academic_meeting', CATEGORY.ACADEMIC, 'academic_meeting → 学术'],
  ['academic_report', CATEGORY.ACADEMIC, 'academic_report → 学术'],
  ['lecture', CATEGORY.ACADEMIC, 'lecture（讲座·论坛）→ 学术'],
  ['recruit', CATEGORY.JOB, 'recruit（宣讲·招聘）→ 就业'],
  ['teaching_meeting', CATEGORY.OTHER, 'teaching_meeting → 其他'],
  ['campus', CATEGORY.OTHER, 'campus → 其他'],
  ['other', CATEGORY.OTHER, 'other → 其他'],
];
MIGRATION.forEach(([oldId, expected, label]) => {
  const e = Event.fromRecord({
    id: 1, title: 'x', location: 'y', start_time: '2026-09-19 19:00', category: oldId,
  });
  eq(e.category, expected, label);
});

/* 旧记录带 meeting_name：title 为空时兜底，不抛错 */
{
  const e = Event.fromRecord({
    id: 2, title: '', location: 'y', start_time: '2026-09-19 19:00',
    category: 'academic_meeting', meeting_name: '第8届数字经济学术年会',
  });
  eq(e.title, '第8届数字经济学术年会', '旧会议名字段在标题为空时兜底为标题');
  eq(e.category, CATEGORY.ACADEMIC, '同时完成分类迁移');
}

/* 未知 / 脏分类 id 必须容错回退 */
{
  const e = new Event({ title: 'x', location: 'y', startTime: '2026-09-19 19:00', category: 'not_a_real_category' });
  eq(e.category, CATEGORY.OTHER, '未知分类 id 回退到 other');
}

/* 非学术类不得残留学术字段 */
{
  const e = new Event({ title: 'x', location: 'y', startTime: '2026-09-19 19:00', category: CATEGORY.JOB, speaker: '张伟' });
  ok(!!e.speaker, 'Event 层不主动清空（由页面在保存时决定）');
  const r = parseEvent(NOTICE_JOB, { baseYear: 2026 });
  const e2 = new Event({ title: r.title, location: r.location, startTime: r.startTime, category: r.category, speaker: r.speaker });
  ok(!e2.speaker, '就业类解析结果不含报告人');
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(56));
if (fail === 0) {
  console.log(`全部通过：${pass} 项测试`);
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项：`);
  failures.forEach((f) => console.log(`  - ${f}`));
}
console.log('='.repeat(56) + '\n');

process.exit(fail === 0 ? 0 : 1);
