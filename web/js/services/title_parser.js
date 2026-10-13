/**
 * title_parser.js
 * 名称解析：优先字段前缀，其次书名号/引号，最后按「首行非噪声」推断
 */

import { PATTERNS, TITLE_PREFIXES, TITLE_LABEL_WORDS, LOCATION_KEYWORDS } from '../utils/regex_patterns.js';
import { normalizeText } from './time_parser.js';

/** 是否噪声行（时间/地点/主办方等） */
function isNoise(line) {
  if (!line) return true;
  const t = line.trim();
  if (!t) return true;
  if (PATTERNS.NOISE_LINE.test(t)) return true;
  if (t.length < 4) return true;

  // 形如「【招聘】」「【提醒】」「【学术报告】」的栏目标签，本身不是活动名称
  if (/^[【\[（(][^】\]）)]{1,10}[】\]）)]\s*[:：]?$/.test(t)) return true;
  // 形如「各位同学：」「各位老师：」的称呼行
  if (/^(各位|尊敬的|亲爱的|全体)[^，。]{0,10}\s*[:：]?$/.test(t)) return true;
  // 行首即为字段标签（报告题目：xxx 之外的裸标签行）
  if (/^(报告题目|讲座题目|活动名称|讲座名称|报告名称|会议名称|宣讲单位|单位名称|活动主题|讲座主题|报告主题|会议主题|时间|地点|报告人|主讲人|主持人|主办|承办|协办|联系|电话|邮箱|备注|内容)\s*[:：]/.test(t)) return true;

  // 纯时间行
  if (/^[\d\s:：\-~至到.年月日点时分上午下午晚上中午]+$/.test(t)) return true;
  // 含地点前缀
  if (PATTERNS.LOCATION_INLINE.test(t)) return true;
  // 短的地点行
  if (t.length <= 24 && LOCATION_KEYWORDS.some((k) => t.includes(k)) && !/[《》“"]/.test(t)) {
    if (!/(报告|讲座|会议|论坛|宣讲|研讨|主题|题目|座谈|沙龙|培训|典礼|演练|大赛|音乐会)/.test(t)) return true;
  }
  return false;
}

/** 清理标题 */
function cleanTitle(str) {
  if (!str) return '';
  let s = String(str).trim();

  // 去掉 Markdown 强调标记（微信/公众号通知常用 ~~加粗~~、**加粗**、*斜体*）
  s = s.replace(/^[~*_\s]+/, '').replace(/[~*_\s]+$/, '');
  s = s.replace(/\*\*|__|~~/g, '');

  // 先去掉行首成对的栏目标签：「【宣讲会】」「[通知]」「（重要）」
  s = s.replace(/^[【\[（(][^】\]）)]{1,12}[】\]）)]\s*[:：]?\s*/, '');
  // 去掉整行被书名号/引号包裹的外层（必须在通用去符号之前，
  // 否则「"青春歌会"校园歌手大赛」这种首尾不配对的引号会被削掉半边）
  s = s.replace(/^[《“"]([^》”"]+)[》”"]$/, '$1');
  // 再兜底清掉行首残留的括号与标点
  s = s.replace(/^[：:、,，\s《》“"【\[（(】\]）)]+/, '');
  // 行尾残留的孤立引号/书名号（只出现在被截断的一侧）
  s = s.replace(/[》”"）)\]]+$/, '');
  s = s.replace(/[。;；,，\s]+$/, '');

  s = s.replace(/\s{2,}/g, ' ');
  // 去掉尾部「的通知」「通知」这类尾巴
  s = s.replace(/(?:的通知|通知|公告)$/, '');
  return s.trim();
}

/**
 * 判断「整行」是否本身就是一个完整的活动名称。
 * 例如「泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站」
 * 虽是长句，但含明确活动类型词且不含句子标点，应优先于其中的引号片段。
 */
function looksLikeFullTitle(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 4 || t.length > 80) return false;
  // 含句子标点说明是叙述句，不是标题
  if (/[。；;]/.test(t)) return false;
  // 必须含活动类型词
  const hasKind = /(宣讲会|宣讲|报告会|报告|讲座|会议|论坛|沙龙|研讨会|座谈|培训|答辩|招聘|双选会|招聘会|音乐会|演出|晚会|比赛|大赛|竞赛|典礼|仪式|演练|展览|展会|分享会|交流会|见面会|open ?day|说明会|推介会|路演|专场|招募|面试)/i.test(t);
  if (!hasKind) return false;
  // 含时间描述的不算标题
  if (/(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*[:：]\s*\d{2})/.test(t)) return false;
  return true;
}

/** 标题看起来是否可信 */
function isPlausibleTitle(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 80) return false;
  if (/^[\d\s:：\-~至到.]+$/.test(t)) return false;
  if (PATTERNS.FULL_DATE.test(t) && t.length < 12) return false;
  return true;
}

/**
 * 是否像一个「活动名」而非普通事务动作。
 *
 * 用于句子内嵌抽取的守门条件：通知里「在群内进行活动签到」「开展相关工作」
 * 这类短语虽然结构上匹配「动词+短语」，但它们是**事务动作**，不是活动名。
 * 必须含活动类型词才放行。
 */
function isActivityPhrase(s) {
  if (!s) return false;
  return /(宣讲会|宣讲|报告会|报告|讲座|会议|论坛|沙龙|研讨会|座谈|培训|答辩|招聘会|招聘|双选会|音乐会|演出|晚会|比赛|大赛|竞赛|典礼|仪式|演练|展览|展会|分享会|交流会|见面会|说明会|推介会|路演|专场|开放日|open ?day|课程|公开课|读书会|观影|茶话会|表彰|启动仪式|主题活动|讲座|学术|专题)/i.test(s);
}

/**
 * 主入口
 * @returns {{ title: string|null, confidence: number }}
 */
export function parseTitle(text) {
  const source = normalizeText(text);
  if (!source || !source.trim()) return { title: null, confidence: 0 };
  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);

  // 0) 叙述式引入：「…举行讲座，主题为：考虑交易成本的最优均值回归trading策略」
  //      这类通知没有「报告题目：」字段，题目藏在句子里。
  //      必须排在「前缀同行」之前 —— 否则第 1 步的宽松 `主\s*题` 会从
  //      「明天下午3点在…举行讲座，主题为：量子计算前沿」整行截走，
  //      把时间和地点一起吞进标题。
  for (const line of lines) {
    const m = line.match(PATTERNS.TITLE_TOPIC_FULL_SENTENCE);
    if (m && m[1]) {
      const t = cleanTitle(m[1]);
      if (isPlausibleTitle(t)) return { title: t, confidence: 0.85 };
    }
  }

  // 1) 前缀同行
  for (const line of lines) {
    const m = line.match(PATTERNS.TITLE_INLINE);
    if (m && m[1]) {
      // 兜底：把「主\s*题」这类宽松标签从叙述句中间截取的整行，重新切成「主题」后的内容
      const topic = line.match(PATTERNS.TITLE_TOPIC_FULL_SENTENCE);
      if (topic && topic[1] && /[，。；;！!？?]/.test(line)) {
        const tt = cleanTitle(topic[1]);
        if (isPlausibleTitle(tt)) return { title: tt, confidence: 0.85 };
      }
      const t = cleanTitle(m[1]);
      if (isPlausibleTitle(t)) {
        // 越具体的字段（报告题目）越可信
        const strong = /题目|名称|主题/.test(m[0]);
        return { title: t, confidence: strong ? 0.95 : 0.85 };
      }
    }
  }

  // 2) 前缀跨行：「报告题目：」后一行
  for (let i = 0; i < lines.length; i++) {
    for (const p of TITLE_PREFIXES) {
      const re = new RegExp(`^${p}\\s*[:：]\\s*$`);
      if (re.test(lines[i]) && i + 1 < lines.length) {
        const t = cleanTitle(lines[i + 1]);
        if (isPlausibleTitle(t)) return { title: t, confidence: 0.85 };
      }
    }
  }

  // 3) 整行即完整活动名（优先于行内的引号片段）
  //    例：「~~泰康保险集团2027"科技专场"巡回宣讲会——西南财经大学站~~」
  //    引号只是名称中的修饰成分，不能只取引号内那几个字
  for (const line of lines) {
    if (isNoise(line)) continue;
    const t = cleanTitle(line);
    if (looksLikeFullTitle(t)) {
      return { title: t, confidence: 0.85 };
    }
  }

  // 3.5) 叙述式兜底（未被第 0 步命中的变体，如「题目是 xxx」）
  for (const line of lines) {
    const m = line.match(PATTERNS.TITLE_TOPIC_FULL_SENTENCE);
    if (m && m[1]) {
      const t = cleanTitle(m[1]);
      if (isPlausibleTitle(t)) {
        return { title: t, confidence: 0.8 };
      }
    }
  }

  // 4) 书名号 / 引号包裹的名称（整行不是完整活动名时的兜底）
  for (const line of lines) {
    const m = line.match(PATTERNS.TITLE_QUOTED);
    if (m && m[1] && isPlausibleTitle(m[1])) {
      return { title: cleanTitle(m[1]), confidence: 0.8 };
    }
  }

  // 5) 句子内嵌的活动名：「在社科楼报告厅举行研究生就业宣讲会」
  //    三重守门：
  //      a) 结果必须含活动类型词，否则「进行活动签到」「开展工作」会被捞出来；
  //      b) 结果不能是「整行去掉通知后缀」——「关于举办第九届学术文化节的通知」
  //         在这里会被截成「第九届学术文化节」，丢掉「关于举办」前缀，
  //         反而不如第 6 步的整体结果；
  //      c) 该行本身不能已经是一句完整的、以「关于…」开头的公文式标题。
  for (const line of lines) {
    if (isNoise(line)) continue;
    // (c) 公文式标题整行交给第 6 步，不在这里截断
    if (/^关于/.test(line) && /(通知|公告|安排|函)$/.test(line)) continue;
    const m = line.match(PATTERNS.TITLE_IN_SENTENCE);
    if (m && m[1]) {
      const t = cleanTitle(m[1]);
      // (b) 匹配结果若只是「整行去掉尾部通知」的同义词，说明没真正嵌入句子
      const wholeMinusTail = cleanTitle(line.replace(/(?:的通知|通知|公告)$/, ''));
      if (t === wholeMinusTail) continue;
      if (isPlausibleTitle(t) && isActivityPhrase(t)) {
        return { title: t, confidence: 0.7 };
      }
    }
  }

  // 6) 首行非噪声
  for (const line of lines) {
    if (isNoise(line)) continue;
    const t = cleanTitle(line);
    if (isPlausibleTitle(t)) {
      // 「关于...的报告/讲座」这类开头可信度更高
      const strong = /(关于|学术|专题|系列)?.*(报告|讲座|会议|论坛|宣讲|研讨|沙龙|培训|答辩|招聘|典礼|座谈)/.test(t);
      return { title: t, confidence: strong ? 0.75 : 0.55 };
    }
  }

  // 7) 兜底：取最长的非噪声行
  let best = null;
  for (const line of lines) {
    if (isNoise(line)) continue;
    const t = cleanTitle(line);
    if (isPlausibleTitle(t) && (!best || t.length > best.length)) best = t;
  }
  if (best) return { title: best, confidence: 0.4 };

  return { title: null, confidence: 0 };
}
