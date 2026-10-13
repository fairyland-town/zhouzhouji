/**
 * speaker_parser.js —— 报告人 / 主讲人 提取
 *
 * 用户诉求：学术类活动要「多显示一点内容」——报告人名字。
 * 本模块负责把「报告人」从通知原文里抽出来，供 EventCard 展示。
 *
 * 注意：「会议名」不再单独提取 —— 学术类的「活动名称」本身就是会议名 / 报告题目，
 * 让用户填两遍是冗余的（v1.1 的 parseMeetingName 已移除）。
 *
 * 提取优先级（越靠前越可靠）：
 *   1) 「报告人：张伟」行内字段
 *   2) 「报告人：」独立标签行的下一行
 *   3) 「由张伟教授主讲」句子
 *   4) 「张伟（清华大学）」带单位形式
 */

import {
  PATTERNS,
  SPEAKER_STOP_WORDS,
  SPEAKER_TITLE_SUFFIX,
  SPEAKER_PREFIXES,
} from '../utils/regex_patterns.js';
import { normalizeText } from './time_parser.js';

/**
 * 姓名：2~4 个汉字为主。
 * 也接受 1 个汉字 + 职称后缀的形式（「王教授」「李老师」这种口语化写法），
 * 由 cleanName 先剥离职称后剩下单字，再放宽校验。
 */
const NAME_RE = /^[\u4e00-\u9fa5]{1,4}$/;
/**
 * 英文姓名（v1.3.0 新增）。
 * 通知里外籍 / 海归学者很常见：「邀请到香港理工大学商学院 Harry Zhang 教授…举行讲座」。
 * 原来是纯汉字正则，这类报告人一律提取不到。
 * 允许 2~4 个单词，单词内可含 `.` `-` `'`（J. Smith / Van-Der Berg / O'Neil）。
 */
const EN_NAME_RE = /^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){1,3}$/;
/** 姓名 + 可选职称/学位后缀 */
const NAME_WITH_TITLE_RE = /^([\u4e00-\u9fa5]{2,4})\s*(?:(教授|副教授|研究员|副研究员|博士|博士生导师|硕导|博导|院士|讲师|助教|高级工程师|工程师|老师|先生|女士|医生|主任|院长|校长|处长|部长))?$/;

/** 明显不是人名的词（机构、字段名等），命中即拒绝 */
const NOT_A_NAME = [
  '学校', '学院', '大学', '单位', '时间', '地点', '主办', '承办', '协办',
  '通知', '讲座', '报告', '会议', '活动', '题目', '主题', '内容', '欢迎',
  '届时', '备注', '联系', '电话', '邮箱', '各位', '同学', '全体', '师生',
  '敬请', '期待', '简介', '详情', '信息', '代表', '专家', '学者', '嘉宾',
  '领导', '老师', '教授', '博士', '院士', '名额', '人数', '报名', '扫码',
  '详见', '另行', '待定', '注意', '要求', '对象', '范围', '方式', '安排',
];

/** 职称/学位后缀按长度降序，保证「副教授」先于「教授」被剥离 */
const TITLE_SUFFIX_DESC = [...SPEAKER_TITLE_SUFFIX].sort((a, b) => b.length - a.length);

/** 清洗姓名：去掉空白、职称后缀、单位括号、markdown */
function cleanName(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/\*\*|__|~~/g, '');
  t = t.replace(/[（(][^）)]*[）)]/g, '');          // 去掉「（清华大学）」
  t = t.replace(/[，,。；;、].*$/, '');             // 只保留第一个逗号前

  // 判断「这是不是一个英文姓名」必须在剥离中文职称后缀**之前**做：
  // 「John F. Nash 教授」此时尾部还挂着「教授」，整体不是纯 ASCII，
  // 若先判 isAscii 就会走中文分支把空格全删成「JohnF.Nash教授」，英文名彻底丢失。
  // 因此这里先探针式地剥掉中文职称后缀，再看剩下的部分是否纯 ASCII。
  let probe = t;
  for (const suffix of TITLE_SUFFIX_DESC) {
    if (probe.trim().endsWith(suffix)) {
      probe = probe.trim().slice(0, -suffix.length);
      break;
    }
  }
  const isAscii = /^[\x20-\x7E]*$/.test(probe.trim());

  // 英文姓名必须保留单词之间的空格（「Harry Zhang」不能压成「HarryZhang」），
  // 中文姓名则相反：中间的空格是排版噪声，要去掉。
  t = isAscii ? t.replace(/\s+/g, ' ').trim() : t.replace(/\s+/g, '');

  t = t.replace(/^[：:·．.\-—–]+/, '').replace(/[：:·．.\-—–]+$/, '');

  // 英文姓名：剥掉尾部的职称后缀（「John F. Nash 教授」→「John F. Nash」）
  if (isAscii) {
    for (const suffix of TITLE_SUFFIX_DESC) {
      if (t.endsWith(suffix)) {
        t = t.slice(0, -suffix.length).trim();
        break;
      }
    }
    return t.replace(/\s+/g, ' ').replace(/[\s.]+$/, '').trim();
  }

  // 「李敏 副教授」→「李敏」；必须长后缀优先，否则「副教授」会被削成「副」
  for (const suffix of TITLE_SUFFIX_DESC) {
    if (t.length > suffix.length && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  // 剩余被截断的孤立职级字（「李敏副」这种二次残留）
  t = t.replace(/[副正高级助理]{1,2}$/, '');
  // 去掉「等」结尾的并列（「张伟、李敏等」→ 取第一个）
  t = t.replace(/[、及和].*$/, '').replace(/等$/, '');
  return t.trim();
}

/**
 * 判断清洗后的字符串是否像一个真实姓名
 * @param {string} s       清洗后的候选名
 * @param {boolean} hadTitle 原始串是否带职称后缀（「王教授」允许单字，裸「王」不允许）
 */
function looksLikeName(s, hadTitle = false) {
  if (!s) return false;
  // 英文姓名走单独的正则
  if (/^[A-Za-z]/.test(s)) {
    if (!EN_NAME_RE.test(s.trim())) return false;
    // 「Professor Smith」这种把职称当名字一部分的写法，前面已由职称词拦掉，
    // 这里再挡一次常见的称谓前缀
    if (/^(Professor|Doctor|Dr|Mr|Mrs|Ms|Miss)\b/i.test(s.trim())) return false;
    return true;
  }
  if (!NAME_RE.test(s)) return false;
  // 单字名仅在有职称/学位后缀时接受，避免把「由」「等」这类单字误认成姓名
  if (s.length === 1 && !hadTitle) return false;
  // 以职称字结尾说明没洗干净（「张副」「李研究员」残留）
  if (/[副正高级助理]$/.test(s) && s.length >= 3) return false;
  if (NOT_A_NAME.some((w) => s.includes(w))) return false;
  if (SPEAKER_STOP_WORDS.some((w) => s.includes(w))) return false;
  return true;
}

/** 原串是否带职称/学位后缀 */
function hasTitleSuffix(raw) {
  if (!raw) return false;
  return TITLE_SUFFIX_DESC.some((s) => raw.trim().endsWith(s));
}

/** 提取「多人并列」时的第一位（报告人常常写「张伟、李敏」） */
function firstPerson(segment) {
  if (!segment) return '';
  const parts = String(segment).split(/[、,，和及\/]/);
  for (const p of parts) {
    const name = cleanName(p);
    if (looksLikeName(name, hasTitleSuffix(p))) return name;
  }
  return '';
}
/**
 * 提取报告人
 * @param {string} text 通知原文
 * @returns {{ speaker: string, confidence: number, reason: string }}
 */
export function parseSpeaker(text) {
  const source = normalizeText(text || '');
  if (!source.trim()) return { speaker: '', confidence: 0, reason: '空文本' };

  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1) 行内字段：报告人：张伟教授
  for (const line of lines) {
    const m = line.match(PATTERNS.SPEAKER_INLINE);
    if (m) {
      const name = firstPerson(m[1]);
      if (name) return { speaker: name, confidence: 0.95, reason: '行内字段「报告人：」' };
    }
  }

  // 2) 独立标签行：「报告人：」独占一行，姓名在下一行
  for (let i = 0; i < lines.length; i++) {
    if (PATTERNS.SPEAKER_LABEL_ONLY.test(lines[i])) {
      const next = lines[i + 1];
      if (next) {
        const name = firstPerson(next);
        if (name) return { speaker: name, confidence: 0.9, reason: '标签行下一行' };
      }
    }
  }

  // 3) 句子内：「由张伟教授主讲」「邀请到… Harry Zhang 教授…举行讲座」
  const mSentence = source.match(PATTERNS.SPEAKER_IN_SENTENCE);
  if (mSentence) {
    const name = cleanName(mSentence[1]);
    if (looksLikeName(name)) return { speaker: name, confidence: 0.8, reason: '句内「由…主讲」' };
  }

  // 3.5) 「Harry Zhang 教授于9月28日…举行讲座」——英文姓名 + 职称嵌在句子里，
  //      前面没有「由 / 邀请」引入词时的兜底。
  //      刻意排在句内「由…主讲」之后，避免把真正的引入形式降级。
  const mNameTitle = source.match(PATTERNS.SPEAKER_NAME_TITLE_INLINE);
  if (mNameTitle) {
    const name = cleanName(mNameTitle[1]);
    if (looksLikeName(name)) {
      return { speaker: name, confidence: 0.75, reason: '「姓名+职称」嵌在句中' };
    }
  }

  // 4) 带单位形式：「张伟（清华大学）」
  const mAffiliation = source.match(PATTERNS.SPEAKER_WITH_AFFILIATION);
  if (mAffiliation) {
    const name = cleanName(mAffiliation[1]);
    if (looksLikeName(name) && !NOT_A_NAME.some((w) => (mAffiliation[2] || '').includes(w))) {
      return { speaker: name, confidence: 0.65, reason: '姓名（单位）形式' };
    }
  }

  // 5) 兜底：任意一行以「前缀 + 冒号」开头且内容像姓名
  for (const line of lines) {
    for (const prefix of SPEAKER_PREFIXES) {
      const re = new RegExp(`^${prefix}\\s*[:：]?\\s*(.+)$`);
      const m = line.match(re);
      if (m) {
        const name = firstPerson(m[1]);
        if (name) return { speaker: name, confidence: 0.7, reason: `前缀「${prefix}」` };
      }
    }
  }

  return { speaker: '', confidence: 0, reason: '未找到报告人' };
}

