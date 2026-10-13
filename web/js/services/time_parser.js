/**
 * time_parser.js
 * 时间解析：支持
 *   9月18日 15:00 / 9月18日下午3点 / 2026年9月18日15时 / 9.18 14:30
 *   9月18日上午9点半 / 本周五下午2点 / 今天19:00 / 明天上午10时
 * 测试基准年：2026（与 04 文档一致）
 */

import { PATTERNS, CN_NUM, FULLWIDTH_MAP, TIME_PREFIXES } from '../utils/regex_patterns.js';
import { startOfWeek, addDays, formatDateTime, isSameDay, toDate } from '../utils/date_utils.js';

/** 全角转半角 + 统一空白 */
export function normalizeText(input) {
  if (!input) return '';
  let s = String(input);
  s = s.replace(/[\uFF10-\uFF19\uFF1A\uFF0E\uFF0D\uFF5E\u3000]/g, (ch) => FULLWIDTH_MAP[ch] || ch);
  s = s.replace(/\u00A0/g, ' ').replace(/\r\n?/g, '\n');
  return s;
}

/** 中文数字（含「二十三」「十九」）转阿拉伯数字 */
export function cnToNumber(str) {
  if (str === null || str === undefined) return NaN;
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (!s) return NaN;

  // 纯中文数字
  if (/^[零〇一二两三四五六七八九十]+$/.test(s)) {
    if (s.length === 1) return CN_NUM[s];
    const idx = s.indexOf('十');
    if (idx === -1) {
      // 如「二三」不合法，按位拼接兜底
      let n = 0;
      for (const c of s) n = n * 10 + (CN_NUM[c] ?? 0);
      return n;
    }
    const tens = idx === 0 ? 1 : CN_NUM[s[idx - 1]];
    const onesStr = s.slice(idx + 1);
    const ones = onesStr ? (CN_NUM[onesStr] ?? 0) : 0;
    return tens * 10 + ones;
  }
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

/** 时间段 -> 小时修正 */
function applyPeriod(hour, period) {
  if (!period) return hour;
  if (['下午', '晚上', '傍晚', '晚间', '今晚', '明晚', '昨晚'].includes(period)) {
    return hour < 12 ? hour + 12 : hour;
  }
  if (period === '中午') {
    return hour < 12 ? (hour === 12 ? 12 : hour + 12) : hour;
  }
  if (period === '凌晨') {
    return hour === 12 ? 0 : hour;
  }
  // 上午 / 早上：12 点视为 0 点
  if (['上午', '早上'].includes(period)) {
    return hour === 12 ? 0 : hour;
  }
  return hour;
}

/** 从文本中裁出「时间字段」的窗口，降低把正文数字误判为时间的概率 */
function timeWindows(text) {
  const lines = text.split('\n');
  const windows = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const hasPrefix = TIME_PREFIXES.some((p) => trimmed.includes(p));
    const hasDate = PATTERNS.FULL_DATE.test(trimmed)
      || PATTERNS.CN_MONTH_DAY.test(trimmed)
      || PATTERNS.CN_NUM_MONTH_DAY.test(trimmed);
    const hasClock = PATTERNS.COLON_TIME.test(trimmed);
    if (hasPrefix || hasDate || hasClock) {
      windows.push(trimmed);
      // 时间字段常跨行，附带下一行
      if (i + 1 < lines.length && lines[i + 1].trim()) windows.push(lines[i + 1].trim());
    }
  });
  return windows;
}

/** 在单个窗口里抽取 日期 */
function extractDate(win, baseYear, reference) {
  let year = null, month = null, day = null, matched = false;

  let m = win.match(PATTERNS.FULL_DATE);
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); matched = true;
  }
  if (!matched) {
    m = win.match(PATTERNS.CN_MONTH_DAY);
    if (m) { month = Number(m[1]); day = Number(m[2]); matched = true; }
  }
  if (!matched) {
    m = win.match(PATTERNS.CN_NUM_MONTH_DAY);
    if (m) {
      month = cnToNumber(m[1]); day = cnToNumber(m[2]); matched = true;
    }
  }
  if (!matched) {
    m = win.match(PATTERNS.SHORT_MONTH_DAY);
    if (m) {
      const mm = Number(m[1]), dd = Number(m[2]);
      // 排除 14:30 这类被误抓的情况，并要求像日期
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && !PATTERNS.COLON_TIME.test(m[0])) {
        month = mm; day = dd; matched = true;
      }
    }
  }

  // 中文数字日期兜底（03 文档：优先处理「月/日」中文表述）
  if (!matched) {
    m = win.match(/([一二三四五六七八九十]{1,2})\s*月\s*([一二三四五六七八九十]{1,3})\s*[日号]/);
    if (m) {
      const mm = cnToNumber(m[1]), dd = cnToNumber(m[2]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        month = mm; day = dd; matched = true;
      }
    }
  }

  if (!matched) {
    // 相对日期
    const rel = win.match(PATTERNS.RELATIVE_DAY);
    if (rel) {
      const base = reference || new Date();
      const offset = { 今天: 0, 今日: 0, 今晚: 0, 今早: 0, 今晨: 0, 明天: 1, 明日: 1, 明晚: 1, 后天: 2, 大后天: 3 }[rel[1]];
      const d = addDays(base, offset);
      return { date: d, hasExplicitDate: false, relative: true };
    }
    // 「本周五 / 下周三」
    const wd = win.match(PATTERNS.WEEKDAY_REF);
    if (wd) {
      const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 };
      const target = map[wd[2]];
      if (target) {
        const base = startOfWeek(reference || new Date());
        const weekOffset = wd[1] === '下' ? 1 : (wd[1] === '上' ? -1 : 0);
        const d = addDays(base, weekOffset * 7 + (target - 1));
        return { date: d, hasExplicitDate: false, relative: true };
      }
    }
    return null;
  }

  const y = year || baseYear;
  if (!month || !day) return null;
  const d = new Date(y, month - 1, day);
  if (d.getMonth() !== month - 1 || d.getDate() !== day) return null; // 非法日期
  return { date: d, hasExplicitDate: true, relative: false };
}

/** 在单个窗口里抽取 时间点 */
function extractClock(win, period) {
  // 1) 14:30
  const m = win.match(PATTERNS.COLON_TIME);
  if (m) {
    let hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour <= 23 && minute <= 59) {
      hour = applyPeriod(hour, period);
      return { hour, minute };
    }
  }
  // 2) 15时 / 下午3点 / 9点半 / 15时30分
  const cm = win.match(PATTERNS.CN_HOUR);
  if (cm) {
    let hour = cnToNumber(cm[1]);
    if (!Number.isNaN(hour) && hour <= 24) {
      let minute = 0;
      if (cm[2] !== undefined && cm[2] !== '') {
        const v = cnToNumber(cm[2]);
        if (!Number.isNaN(v) && v <= 59) minute = v;
      } else if (PATTERNS.HALF.test(win.slice(cm.index + cm[0].length, cm.index + cm[0].length + 2))) {
        minute = 30;
      }
      if (hour === 24) hour = 0;
      hour = applyPeriod(hour, period);
      return { hour, minute };
    }
  }
  return null;
}

/**
 * 主入口
 * @param {string} text 通知原文
 * @param {object} options { baseYear, now }
 * @returns {{ date: Date|null, confidence: number, raw: string, hasExplicitDate: boolean }}
 */
export function parseTime(text, options = {}) {
  const baseYear = options.baseYear ?? new Date().getFullYear();
  const reference = options.now ?? new Date();
  const source = normalizeText(text);
  if (!source.trim()) return { date: null, confidence: 0, raw: '', hasExplicitDate: false };

  const wins = timeWindows(source);
  const pool = wins.length ? wins : [source];
  const globalPeriod = (source.match(PATTERNS.DAY_PERIOD) || [null])[1];

  let best = null;

  for (const win of pool) {
    const period = (win.match(PATTERNS.DAY_PERIOD) || [null, globalPeriod])[1];
    const datePart = extractDate(win, baseYear, reference);
    const clock = extractClock(win, period);

    if (datePart && clock) {
      const d = new Date(
        datePart.date.getFullYear(), datePart.date.getMonth(), datePart.date.getDate(),
        clock.hour, clock.minute
      );
      const confidence = datePart.hasExplicitDate ? 0.95 : 0.7;
      return { date: d, confidence, raw: win.trim(), hasExplicitDate: datePart.hasExplicitDate };
    }
    if (datePart && !clock) {
      if (!best || best.score < 2) best = { date: datePart.date, score: 2, raw: win.trim(), hasExplicitDate: datePart.hasExplicitDate };
    }
    if (!datePart && clock) {
      if (!best) best = { date: null, clock, score: 1, raw: win.trim(), hasExplicitDate: false };
    }
  }

  if (best && best.date && best.clock) {
    const d = new Date(best.date.getFullYear(), best.date.getMonth(), best.date.getDate(), best.clock.hour, best.clock.minute);
    return { date: d, confidence: 0.6, raw: best.raw, hasExplicitDate: best.hasExplicitDate };
  }
  if (best && best.date) {
    // 只有日期没有具体时刻 -> 默认全天 00:00
    return { date: best.date, confidence: 0.5, raw: best.raw, hasExplicitDate: best.hasExplicitDate };
  }

  // 兜底：整段文本再试一次
  const datePart = extractDate(source, baseYear, reference);
  const clock = extractClock(source, globalPeriod);
  if (datePart) {
    const hour = clock ? clock.hour : 0;
    const minute = clock ? clock.minute : 0;
    const d = new Date(datePart.date.getFullYear(), datePart.date.getMonth(), datePart.date.getDate(), hour, minute);
    return { date: d, confidence: clock ? 0.7 : 0.4, raw: source.trim().slice(0, 60), hasExplicitDate: datePart.hasExplicitDate };
  }

  return { date: null, confidence: 0, raw: '', hasExplicitDate: false };
}

/** 供 UI 直接使用：解析为 YYYY-MM-DD HH:mm 字符串 */
export function parseTimeString(text, options = {}) {
  const r = parseTime(text, options);
  return r.date ? formatDateTime(r.date) : '';
}
