/**
 * location_parser.js
 * 地点解析：优先字段前缀，其次关键词 + 位置推断
 */

import { PATTERNS, LOCATION_PREFIXES, LOCATION_KEYWORDS } from '../utils/regex_patterns.js';
import { normalizeText } from './time_parser.js';

/** 清理地点字符串：去掉尾部标点、括注尾巴、多余空白 */
function cleanLocation(str) {
  if (!str) return '';
  let s = String(str).trim();
  s = s.replace(/^[：:、,，\s]+/, '');
  // 去掉行尾常见噪声词
  s = s.replace(/[。;；,，]\s*$/, '');
  s = s.replace(/\s*(?:举行|举办|召开|进行|开展|签到|门口集合|集合)\s*$/, '');
  s = s.replace(/\s+/g, '');
  // 括号注释保留但去掉不成对的
  s = s.replace(/[（(]\s*$/g, '').replace(/^\s*[）)]/g, '');
  // 明显不是地点的词
  if (/^(不详|待定|另行通知|见通知|无|暂无|线上|腾讯会议|微信群|钉钉)$/.test(s)) return s;
  return s;
}

/** 判断字符串是否"像"一个地点 */
export function looksLikeLocation(s) {
  if (!s) return false;
  const t = s.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (/^[\d\s:：\-~至到.]+$/.test(t)) return false;          // 纯时间
  if (PATTERNS.FULL_DATE.test(t) || PATTERNS.CN_MONTH_DAY.test(t)) return false;
  return LOCATION_KEYWORDS.some((k) => t.includes(k));
}

/**
 * 主入口
 * @returns {{ location: string|null, confidence: number }}
 */
export function parseLocation(text) {
  const source = normalizeText(text);
  if (!source || !source.trim()) return { location: null, confidence: 0 };

  const lines = source.split('\n').map((l) => l.trim()).filter(Boolean);

  // 1) 前缀同行：「地点：数学学院201报告厅」
  for (const line of lines) {
    const m = line.match(PATTERNS.LOCATION_INLINE);
    if (m && m[1]) {
      const loc = cleanLocation(m[1]);
      if (loc) {
        const high = LOCATION_KEYWORDS.some((k) => loc.includes(k));
        return { location: loc, confidence: high ? 0.95 : 0.8 };
      }
    }
  }

  // 2) 前缀跨行：「报告地点：」后一行
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const p of LOCATION_PREFIXES) {
      const re = new RegExp(`^${p}\\s*[:：]?\\s*$`);
      if (re.test(line) && i + 1 < lines.length) {
        const loc = cleanLocation(lines[i + 1]);
        if (looksLikeLocation(loc) || loc.length >= 2) {
          return { location: loc, confidence: 0.85 };
        }
      }
    }
  }

  // 3) 句子内：「本次会议在社科楼A101举行」
  for (const line of lines) {
    const m = line.match(PATTERNS.LOCATION_IN_SENTENCE);
    if (m && m[1]) {
      const loc = cleanLocation(m[1]);
      if (looksLikeLocation(loc)) return { location: loc, confidence: 0.8 };
    }
  }

  // 4) 行内尾部裸地点：「9.18 14:30 英语四六级考试说明会 外语楼B301」
  for (const line of lines) {
    if (line.length > 60) continue;
    const tail = line.match(/([\u4e00-\u9fa5A-Za-z0-9\-]{2,20}(?:楼|室|厅|馆|中心|校区|教室|会议室|报告厅|礼堂|广场)(?:[A-Za-z0-9\-（）()]{1,10})?)\s*$/);
    if (tail && tail[1]) {
      const loc = cleanLocation(tail[1]);
      if (looksLikeLocation(loc) && loc.length >= 3) {
        return { location: loc, confidence: 0.7 };
      }
    }
  }

  // 5) 独立地点行
  for (const line of lines) {
    if (line.length > 40) continue;
    if (PATTERNS.FULL_DATE.test(line) || PATTERNS.COLON_TIME.test(line)) continue;
    if (/^\d{1,2}\s*[:：]\s*\d{2}$/.test(line)) continue;
    if (looksLikeLocation(line)) {
      return { location: cleanLocation(line), confidence: 0.65 };
    }
  }

  // 6) 兜底：整段搜 「在...」 并含地点关键词
  const m = source.match(/(?:在|于|到)\s*([\u4e00-\u9fa5A-Za-z0-9\-（）()]{2,30})/);
  if (m && m[1]) {
    const loc = cleanLocation(m[1]);
    if (looksLikeLocation(loc)) return { location: loc, confidence: 0.5 };
  }

  return { location: null, confidence: 0 };
}
