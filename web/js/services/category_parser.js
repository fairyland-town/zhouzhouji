/**
 * category_parser.js —— 活动分类识别（v1.2 三分类版）
 *
 * 只有三类，判定逻辑因此大幅简化：
 *   学术（academic）：学术会议 / 学术报告 / 讲座 / 论坛 / 沙龙 / 研讨会 / 报告会…
 *   就业（job）     ：宣讲会 / 招聘 / 双选会 / 实习 / 校招…
 *   其他（other）   ：剩下的全部
 *
 * 策略（按可靠性从高到低）：
 *   1. 用户显式指定（手动选择）——最高优先级
 *   2. 强关键词：命中即定（「学术报告」「宣讲会」这类形态足够明确）
 *   3. 关键词打分：统计命中次数与权重，取最高分
 *   4. 兜底：other
 *
 * 关键约束：
 *   - 学术与就业冲突时（如「就业专题讲座」），看谁的信号更具体：
 *     「专题讲座」是明确的学术形态，「就业」只是伴随词 → 判学术。
 *   - 地点字段不参与判定，避免「学术报告厅」把普通通知判成学术。
 */

import { CATEGORY, CATEGORIES, DEFAULT_CATEGORY } from '../models/categories.js';
import { CATEGORY_KEYWORDS, NON_ACADEMIC_BLOCK } from '../utils/regex_patterns.js';
import { normalizeText } from './time_parser.js';

/** 关键词 -> 分类 的扁平索引（长词优先，避免「报告」被泛词抢先） */
const KEYWORD_INDEX = (() => {
  const list = [];
  for (const group of CATEGORY_KEYWORDS) {
    for (const w of group.words) {
      list.push({ word: w.toLowerCase(), category: group.id });
    }
  }
  return list.sort((a, b) => b.word.length - a.word.length);
})();

/** 强关键词集合（命中和判定） */
const STRONG_KEYWORDS = CATEGORY_KEYWORDS
  .flatMap((g) => (g.strong || []).map((w) => ({ word: w.toLowerCase(), category: g.id })))
  .sort((a, b) => b.word.length - a.word.length);

/**
 * 把关键词按权重计分
 * 长词权重更高（「学术研讨会」比「研讨会」更具体）
 */
function scoreKeywords(text) {
  const lower = text.toLowerCase();
  const scores = {};

  for (const { word, category } of KEYWORD_INDEX) {
    if (!lower.includes(word)) continue;
    let count = 0;
    let idx = lower.indexOf(word);
    while (idx !== -1) { count++; idx = lower.indexOf(word, idx + word.length); }
    const weight = word.length * 2 + (word.length >= 4 ? 3 : 0);
    scores[category] = (scores[category] || 0) + weight * Math.min(count, 3);
  }
  return scores;
}

/**
 * 分类识别
 * @param {string} text 通知原文（或名称）
 * @param {object} options { hint: 用户已选分类，最高优先级 }
 * @returns {{ category: string, confidence: number, reason: string }}
 */
export function parseCategory(text, options = {}) {
  // 0) 用户显式指定（手动选择或编辑过）直接采用
  if (options.hint && CATEGORIES[options.hint]) {
    return { category: options.hint, confidence: 1, reason: '用户指定' };
  }

  const source = stripLocationField(normalizeText(text || ''));
  if (!source.trim()) {
    return { category: DEFAULT_CATEGORY, confidence: 0, reason: '空文本' };
  }

  // 1) 内部事务词否决：命中即归「其他」。
  //    必须排在学术判定之前 —— 「学院教学工作研讨会」含「研讨会」，
  //    但它是学校内部工作会，不该算学术活动。
  const blocked = NON_ACADEMIC_BLOCK.find((w) => source.includes(w));
  if (blocked) {
    return { category: DEFAULT_CATEGORY, confidence: 0.88, reason: `内部事务词「${blocked}」` };
  }

  // 2) 强关键词：命中即判定（强词互斥，谁更具体谁优先，已按词长排序）
  for (const { word, category } of STRONG_KEYWORDS) {
    if (!source.toLowerCase().includes(word)) continue;
    return { category, confidence: 0.92, reason: `强关键词「${word}」` };
  }

  // 3) 关键词打分
  const scores = scoreKeywords(source);
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    // 4) 兜底：报告人字段本身就是学术信号
    if (/(报告人|主讲人|报告题目|特邀报告)/.test(source)) {
      return { category: CATEGORY.ACADEMIC, confidence: 0.6, reason: '含报告人字段' };
    }
    return { category: DEFAULT_CATEGORY, confidence: 0.3, reason: '未命中关键词' };
  }

  const [bestId, bestScore] = entries[0];
  const second = entries[1];
  const gap = second ? bestScore / second[1] : Infinity;

  // 分差足够大才认为判定可信
  const confidence = gap >= 1.6 ? 0.85 : (gap >= 1.2 ? 0.7 : 0.55);

  return {
    category: bestId,
    confidence,
    reason: `关键词得分 ${bestScore}${second ? ` vs ${second[1]}` : ''}`,
  };
}

/**
 * 去掉「地点 / 会议地点 / 报告地点」字段值本身，避免地点里的
 * 「学术报告厅」「会议室」等词污染分类判断。
 * 例：「活动地点：材料学院学术报告厅」不该让通知被判成学术。
 */
function stripLocationField(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(?:活动|报告|会议|讲座|举办|开会)?地点\s*[:：]/.test(line))
    .join('\n');
}

/** 便捷：只要分类 id */
export function categoryOf(text, options) {
  return parseCategory(text, options).category;
}
