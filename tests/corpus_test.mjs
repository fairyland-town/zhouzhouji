/**
 * corpus_test.mjs —— 模拟真实通知语料测试（04 文档第 8 节）
 * 用真实风格校园通知，统计名称/时间/地点识别成功率，
 * 并校验三分类（学术 / 就业 / 其他）是否正确。
 */
import { parseEvent } from '../web/js/services/event_parser.js';
import { CATEGORY, isAcademic, getCategory } from '../web/js/models/categories.js';
import { CATEGORIES } from '../web/js/models/categories.js';

const BASE = { baseYear: 2026, now: new Date(2026, 8, 15, 10, 0, 0) };

/**
 * [通知原文, 期望名称关键词, 期望时间, 期望地点关键词, 期望分类, 期望报告人]
 * - 分类为 undefined 时只做「必须解析成功」的宽松检查（不计入分类命中）
 * - 期望报告人为 undefined 时表示原文中确实没有报告人信息，不做断言
 */
const CORPUS = [
  [`【学术报告】\n报告题目：图论中的均衡染色问题\n报告人：张伟教授\n时间：2026年9月18日下午3点\n地点：数学学院201报告厅\n欢迎广大师生参加！`,
    '均衡染色问题', '2026-09-18 15:00', '数学学院201报告厅', CATEGORY.ACADEMIC, '张伟'],

  [`讲座通知\n讲座题目：人工智能前沿进展\n主讲人：李敏\n时间：9月16日晚上7点\n地点：信息楼A201`,
    '人工智能前沿进展', '2026-09-16 19:00', '信息楼A201', CATEGORY.ACADEMIC],

  [`各位同学：\n定于9月20日上午9点半在社科楼报告厅举行研究生就业宣讲会，请准时参加。`,
    '就业宣讲会', '2026-09-20 09:30', '社科楼报告厅', CATEGORY.JOB],

  [`会议通知\n会议名称：学院教学工作研讨会\n时间：9月17日 14:30\n会议地点：行政楼三楼会议室`,
    '教学工作研讨会', '2026-09-17 14:30', '行政楼三楼会议室', CATEGORY.OTHER],

  [`关于举办"新能源材料发展论坛"的通知\n活动时间：9月22日上午9:00\n活动地点：材料学院学术报告厅\n欢迎参加。`,
    '新能源材料发展论坛', '2026-09-22 09:00', '材料学院学术报告厅', CATEGORY.ACADEMIC],

  [`【招聘】\n宣讲单位：华为技术有限公司\n宣讲时间：9月19日 19:00\n宣讲地点：大学生活动中心`,
    '华为技术有限公司', '2026-09-19 19:00', '大学生活动中心', CATEGORY.JOB],

  [`学术讲座\n主题：机器学习在医学影像中的应用\n时间：2026年9月25日 15时\n地点：生物医学工程学院一楼报告厅`,
    '机器学习在医学影像中的应用', '2026-09-25 15:00', '生物医学工程学院一楼报告厅', CATEGORY.ACADEMIC],

  [`通知：本周五下午2点在图书馆学术厅举办读书分享会。`,
    '读书分享会', '2026-09-18 14:00', '图书馆学术厅', CATEGORY.ACADEMIC],

  [`明天上午10时在行政楼会议室召开学生工作会议，请各位辅导员准时参加。`,
    '学生工作会议', '2026-09-16 10:00', '行政楼会议室', CATEGORY.OTHER],

  [`9.18 14:30 英语四六级考试说明会 外语楼B301`,
    '英语四六级考试说明会', '2026-09-18 14:30', '外语楼B301', undefined],

  [`报告题目：组合数学中的若干问题\n报告人：王教授\n时间：9月18日上午9点半\n地点：数学学院201报告厅`,
    '组合数学中的若干问题', '2026-09-18 09:30', '数学学院201报告厅', CATEGORY.ACADEMIC, '王'],

  [`【重要】\n活动名称：2026级新生开学典礼\n时间：9月21日 08:00\n地点：学校大礼堂`,
    '2026级新生开学典礼', '2026-09-21 08:00', '学校大礼堂', CATEGORY.OTHER],

  [`学术报告通知\n题目：量子计算的发展与挑战\n时间：9月23日下午4点\n地点：物理学院阶梯教室`,
    '量子计算的发展与挑战', '2026-09-23 16:00', '物理学院阶梯教室', CATEGORY.ACADEMIC],

  [`会议时间：9月24日 上午 10:30\n会议地点：主楼一楼多功能厅\n会议主题：年度科研工作总结`,
    '年度科研工作总结', '2026-09-24 10:30', '主楼一楼多功能厅', CATEGORY.OTHER],

  [`下周三上午9点在实验楼A座会议室举行实验室安全培训。`,
    '实验室安全培训', '2026-09-23 09:00', '实验楼A座会议室', CATEGORY.OTHER],

  [`【宣讲会】\n时间：2026-09-26 14:00\n地点：就业指导中心报告厅\n单位：中国建筑集团`,
    '中国建筑集团', '2026-09-26 14:00', '就业指导中心报告厅', CATEGORY.JOB],

  [`活动主题：校园歌手大赛初赛\n活动时间：9月27日晚上6点半\n活动地点：大学生活动中心`,
    '校园歌手大赛初赛', '2026-09-27 18:30', '大学生活动中心', CATEGORY.OTHER],

  [`关于举办第九届学术文化节的通知\n时间：9月28日9:00\n地点：图书馆报告厅`,
    '第九届学术文化节', '2026-09-28 09:00', '图书馆报告厅', undefined],

  [`9月29日下午3点在艺术学院音乐厅举办钢琴独奏音乐会。`,
    '钢琴独奏音乐会', '2026-09-29 15:00', '艺术学院音乐厅', CATEGORY.OTHER],

  [`【提醒】\n时间：9月30日 中午12:30\n地点：第一食堂三楼\n内容：食堂满意度座谈会`,
    '食堂满意度座谈会', '2026-09-30 12:30', '第一食堂三楼', CATEGORY.OTHER],

  [`报告题目：数字经济时代的商业模式创新\n报告时间：2026年10月9日上午9时30分\n报告地点：管理学院报告厅`,
    '数字经济时代的商业模式创新', '2026-10-09 09:30', '管理学院报告厅', CATEGORY.ACADEMIC],

  [`各位老师：\n今晚7点在行政楼二楼会议室召开党支部会议。`,
    '党支部会议', '2026-09-15 19:00', '行政楼二楼会议室', CATEGORY.OTHER],

  [`【公告】\n活动名称：消防应急演练\n活动时间：10月10日 15:00\n活动地点：体育馆前广场`,
    '消防应急演练', '2026-10-10 15:00', '体育馆前广场', CATEGORY.OTHER],

  [`学术沙龙\n主题：城市更新与社区治理\n时间：10月12日下午2点\n地点：建筑学院会议室`,
    '城市更新与社区治理', '2026-10-12 14:00', '建筑学院会议室', CATEGORY.ACADEMIC],

  /* --- 以下为 2026-09-15 真实反馈补充的用例（微信/公众号风格） --- */
  [`~~泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站~~
现场面试！！！现场发offer！！！
时间：9月17日下午15:00
地点：柳林校区弘远楼101
扫码进群，即可报名参加~~`,
    '泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站', '2026-09-17 15:00', '柳林校区弘远楼101', CATEGORY.JOB],

  [`~~中国建筑集团2026届校园招聘宣讲会——西南财经大学站~~
时间：9月23日19:00
地点：柳林校区学生活动中心`,
    '中国建筑集团2026届校园招聘宣讲会——西南财经大学站', '2026-09-23 19:00', '柳林校区学生活动中心', CATEGORY.JOB],

  [`【宣讲会】关于举办2027届"科技专场"巡回宣讲会的通知
现场面试，现场发offer
时间：9月17日下午3点
地点：弘远楼101`,
    '关于举办2027届"科技专场"巡回宣讲会', '2026-09-17 15:00', '弘远楼101', CATEGORY.JOB],

  [`国家电网2026年校园招聘专场宣讲会
时间：10月8日上午10点
地点：柳林校区图书馆报告厅`,
    '国家电网2026年校园招聘专场宣讲会', '2026-10-08 10:00', '柳林校区图书馆报告厅', CATEGORY.JOB],

  /* --- v1.1 分类系统补充用例 --- */
  [`关于举办第12届计算机科学前沿学术研讨会的通知
第12届计算机科学前沿学术研讨会定于9月20日上午9:00在信息楼A301报告厅举行。
报告人：张伟教授
会议名称：第12届计算机科学前沿学术研讨会`,
    '学术研讨会', '2026-09-20 09:00', '信息楼A301报告厅', CATEGORY.ACADEMIC, '张伟'],

  [`名师讲座预告：如何写好学术论文
主讲人：陈明教授
时间：9月26日14:00
地点：图书馆学术厅`,
    '如何写好学术论文', '2026-09-26 14:00', '图书馆学术厅', CATEGORY.ACADEMIC],

  /* --- v1.3.1 回归用例（用户真实截图） --- */
  // 缺陷 1：叙述式通知，题目在「主题为：」之后，句尾还有「进行活动签到」
  //          —— 必须提取到真正的题目，不能把「活动签到」当活动名
  // 缺陷 2：报告人是英文名（Harry Zhang），原来只认 2~4 个汉字，提取不到
  [`【学术部通知】各位同学好，商学院工商管理系邀请到香港理工大学商学院 Harry Zhang 教授于9月28日（周五）15:30-16:30在博学楼B412会议室举行讲座，主题为：考虑交易成本的最优均值回归trading策略，欢迎大家积极参加！我们将在群内进行活动签到`,
    '考虑交易成本的最优均值回归trading策略', '2026-09-28 15:30', '博学楼B412会议室', CATEGORY.ACADEMIC, 'Harry Zhang'],
];

let titleHit = 0, timeHit = 0, locHit = 0, catHit = 0, catTotal = 0;
let speakerHit = 0, speakerTotal = 0;
const rows = [];
const MISS = [];

CORPUS.forEach(([text, expTitle, expTime, expLoc, expCat, expSpeaker], i) => {
  let p;
  try {
    p = parseEvent(text, BASE);
  } catch (e) {
    MISS.push(`#${i + 1} 抛出异常: ${e.message}`);
    rows.push({ i: i + 1, title: '✗', time: '✗', location: '✗', category: '✗' });
    return;
  }

  const tOk = !!p.title && p.title.includes(expTitle);
  const tmOk = p.startTime === expTime;
  const lOk = !!p.location && p.location.includes(expLoc);
  const cOk = expCat ? p.category === expCat : true;

  if (tOk) titleHit++;
  if (tmOk) timeHit++;
  if (lOk) locHit++;
  if (expCat) { catTotal++; if (cOk) catHit++; }

  // 只在用例显式给出期望报告人时才断言
  let sOk = true;
  if (expSpeaker !== undefined) {
    speakerTotal++;
    sOk = p.speaker === expSpeaker;
    if (sOk) speakerHit++;
    else MISS.push(`#${i + 1} 报告人: 期望「${expSpeaker}」/ 实际「${p.speaker || '(空)'}」`);
  }

  rows.push({
    i: i + 1,
    title: tOk ? '✓' : '✗',
    time: tmOk ? '✓' : '✗',
    location: lOk ? '✓' : '✗',
    category: !expCat ? '-' : (cOk ? '✓' : '✗'),
    catName: getCategory(p.category).short,
    speaker: expSpeaker === undefined ? '-' : (sOk ? '✓' : '✗'),
  });

  if (!tOk) MISS.push(`#${i + 1} 名称: 期望含「${expTitle}」/ 实际「${p.title}」`);
  if (!tmOk) MISS.push(`#${i + 1} 时间: 期望 ${expTime} / 实际 ${p.startTime || '(空)'}`);
  if (!lOk) MISS.push(`#${i + 1} 地点: 期望含「${expLoc}」/ 实际「${p.location || '(空)'}」`);
  if (expCat && !cOk) MISS.push(`#${i + 1} 分类: 期望 ${getCategory(expCat).label} / 实际 ${getCategory(p.category).label}`);
});

const n = CORPUS.length;
const pct = (x) => ((x / n) * 100).toFixed(1) + '%';

console.log('='.repeat(78));
console.log(`人工语料测试 —— 共 ${n} 条真实风格校园通知（04 文档第 8 节）`);
console.log('='.repeat(78));
console.log('序号  名称  时间  地点  分类  报告人  识别出的分类');
rows.forEach((r) => {
  console.log(`${String(r.i).padStart(3)}     ${r.title}     ${r.time}     ${r.location}     ${String(r.category).padEnd(4)}  ${String(r.speaker).padEnd(5)}  ${r.catName}`);
});
console.log('-'.repeat(78));
console.log(`名称识别成功率： ${titleHit}/${n}  ${pct(titleHit)}`);
console.log(`时间识别成功率： ${timeHit}/${n}  ${pct(timeHit)}`);
console.log(`地点识别成功率： ${locHit}/${n}  ${pct(locHit)}`);
console.log(`分类判定成功率： ${catHit}/${catTotal}  ${((catHit / catTotal) * 100).toFixed(1)}%`);
console.log(`报告人提取成功率： ${speakerHit}/${speakerTotal}  ${speakerTotal ? ((speakerHit / speakerTotal) * 100).toFixed(1) : '-'}%`);
console.log('-'.repeat(78));

if (MISS.length) {
  console.log('\n未完全命中的明细：');
  MISS.forEach((m) => console.log('  · ' + m));
} else {
  console.log(`\n全部 ${n} 条通知的核心字段、分类与报告人均正确提取。`);
}
console.log('='.repeat(78));

const allOk = titleHit === n && timeHit === n && locHit === n
  && catHit === catTotal && speakerHit === speakerTotal;
process.exit(allOk ? 0 : 1);
