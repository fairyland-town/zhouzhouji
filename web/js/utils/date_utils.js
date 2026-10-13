/**
 * date_utils.js
 * 周计算规则严格遵循 03 文档：
 *   - 每周从周一开始
 *   - 当前周 = 本周一 00:00 至 本周日 23:59
 */

import { PATTERNS } from './regex_patterns.js';

/** 把任意时间值规整为本地 Date（避免时区偏差） */
export function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
      );
    }
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(NaN);
}

/** 归零到当天 00:00:00 */
export function startOfDay(date) {
  const d = toDate(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** 归零到当天 23:59:59.999 */
export function endOfDay(date) {
  const d = toDate(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * 返回所在周的周一 00:00（周三/周日都回退到本周一）
 * JS getDay(): 周日=0, 周一=1 ... 周六=6
 */
export function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // 周日回退 6 天，其余回退 day-1 天
  return addDays(d, diff);
}

/** 所在周的下周一 00:00 */
export function startOfNextWeek(date) {
  return addDays(startOfWeek(date), 7);
}

/** 所在周周日 23:59:59.999 */
export function endOfWeek(date) {
  return endOfDay(addDays(startOfWeek(date), 6));
}

/** 日期加减天数 */
export function addDays(date, days) {
  const d = startOfDay(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** 日期加减周数 */
export function addWeeks(date, weeks) {
  return addDays(date, weeks * 7);
}

/** 生成一周 7 天的日期数组（周一 -> 周日） */
export function weekDays(date) {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 是否同一天 */
export function isSameDay(a, b) {
  const x = toDate(a), y = toDate(b);
  return x.getFullYear() === y.getFullYear()
    && x.getMonth() === y.getMonth()
    && x.getDate() === y.getDate();
}

export function isToday(date) {
  return isSameDay(date, new Date());
}

/** 是否同一年同一周 */
export function isSameWeek(a, b) {
  return startOfWeek(a).getTime() === startOfWeek(b).getTime();
}

/** 格式化为 YYYY-MM-DD */
export function formatDate(date) {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 格式化为 HH:mm */
export function formatTime(date) {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 格式化为 YYYY-MM-DD HH:mm （数据库存储格式） */
export function formatDateTime(date) {
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return '';
  return `${formatDate(d)} ${formatTime(d)}`;
}

/** M月D日 */
export function formatMonthDay(date) {
  const d = toDate(date);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** M/D */
export function formatSlash(date) {
  const d = toDate(date);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 中文星期 */
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayName(date) {
  return WEEKDAY_CN[toDate(date).getDay()];
}
export const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * ISO 周号（第一条周四所在周为第 1 周）
 * 用于顶部「第38周」显示
 */
export function isoWeekNumber(date) {
  const d = startOfDay(date);
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayNr = (target.getDay() + 6) % 7; // 周一=0
  target.setDate(target.getDate() - dayNr + 3); // 该周周四
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}

/** 该周的年份（ISO 周所属年份，跨年时跟随周四所在年） */
export function isoWeekYear(date) {
  const d = startOfWeek(date);
  const thursday = addDays(d, 3);
  return thursday.getFullYear();
}

/**
 * 周的显示标签
 * 跨年：2026年12月28日 - 2027年1月3日
 */
export function weekRangeLabel(date) {
  const s = startOfWeek(date);
  const e = addDays(s, 6);
  if (s.getFullYear() !== e.getFullYear()) {
    return `${s.getFullYear()}年${formatMonthDay(s)} - ${e.getFullYear()}年${formatMonthDay(e)}`;
  }
  return `${formatMonthDay(s)} - ${formatMonthDay(e)}`;
}

/** 顶部月份标签，如 2026年9月 */
export function monthLabel(date) {
  const d = toDate(date);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

/** 相对当前周的偏移描述 */
export function relativeWeekLabel(date) {
  const cur = startOfWeek(new Date());
  const target = startOfWeek(date);
  const weeks = Math.round((target.getTime() - cur.getTime()) / (7 * 24 * 3600 * 1000));
  if (weeks === 0) return '本周';
  if (weeks === 1) return '下周';
  if (weeks === -1) return '上周';
  return '';
}

/** 两个日期相差的天数（b - a） */
export function diffDays(a, b) {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.round(ms / (24 * 3600 * 1000));
}

/**
 * 解析用户手输的日期 → 规范化成 `YYYY-MM-DD`；看不懂就返回 `null`。
 *
 * 用户 2026-09-22 报的问题：「所有填写日期的时候不应该只有一种格式
 * 2026-10-08。2026.3.8 这种以及 2026.09.08 都可以」。
 * 于是这里放行 `-` `/` `.` `年/月/日` 四种分隔符，且月/日允许不补零：
 *   2026-10-08 / 2026-10-8 / 2026.3.8 / 2026.09.08 / 2026/3/8 / 2026年3月8日
 *
 * 🔴 为什么一定要「回读校验」而不是只过正则：
 *    正则只能保证「长得像日期」。`2026-02-31` 完全符合正则，而
 *    `new Date(2026, 1, 31)` 会被 JS **静默滚到 3 月 3 日** ——
 *    用户从没输入过这个日期，却会被存进库里，事后根本查不出是哪来的。
 *    所以必须把构造出来的 Date 反读一遍年/月/日，三个都对上才算数。
 *
 * ⚠️ 空串一律返回 `null`。但调用方要自己区分「留空 = 跳过」和「取消」——
 *    这个函数看不到弹窗，分不清这两者（见 promptDialog 的三态契约）。
 */
export function parseDateInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  const m = s.match(PATTERNS.DATE_INPUT);
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
    return null;   // 2026-02-31 这类「格式对但那天不存在」
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
