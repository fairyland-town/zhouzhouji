/**
 * checkin.js —— 打卡数据模型与统计（v1.3.0）
 *
 * 数据结构（与 SQLite 对应）：
 *   checkins       id / title / created_at
 *   checkin_logs   id / checkin_id / date(YYYY-MM-DD) / created_at
 *
 * 统计口径：
 *   - 连续天数：从「今天」往前数。今天没打卡不算断（当天还没结束），
 *     所以从今天或从昨天起算，取能连上的最长一段。
 *   - 月完成率：已打卡天数 / 该月截至今天的应打卡天数（今天之前/含今天），
 *     未来的日期不计入分母，避免月初显示 3% 这种失真的数字。
 */

import { formatDate, startOfDay, addDays } from '../utils/date_utils.js';

export class Checkin {
  constructor({ id = null, title = '', createdAt = null, logs = [] } = {}) {
    this.id = id;
    this.title = String(title || '').trim();
    this.createdAt = createdAt == null ? '' : String(createdAt);
    /** 已打卡日期集合（'YYYY-MM-DD'），构造时传入 number[] 或 string[] 皆可 */
    this.dates = new Set((logs || []).map((d) => (typeof d === 'string' ? d : formatDate(new Date(d)))));
  }

  get count() { return this.dates.size; }

  isChecked(dateStr) { return this.dates.has(dateStr); }

  /**
   * 连续打卡天数。
   * 今天打过卡 → 从今天往前连；今天还没打 → 从昨天往前连（不视为断卡）。
   */
  streak(today = new Date()) {
    const start = startOfDay(today);
    let cursor = start;
    if (!this.isChecked(formatDate(cursor))) {
      cursor = addDays(cursor, -1);
      if (!this.isChecked(formatDate(cursor))) return 0;
    }
    let n = 0;
    while (this.isChecked(formatDate(cursor))) {
      n++;
      cursor = addDays(cursor, -1);
    }
    return n;
  }

  /** 该打卡项出现过的历史最长连续天数 */
  longestStreak() {
    if (!this.dates.size) return 0;
    const sorted = Array.from(this.dates).sort();
    let best = 1;
    let cur = 1;
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1].replace(/-/g, '/'));
      const now = new Date(sorted[i].replace(/-/g, '/'));
      const gap = Math.round((now - prev) / 86400000);
      cur = gap === 1 ? cur + 1 : 1;
      if (cur > best) best = cur;
    }
    return best;
  }

  /**
   * 指定月份（'YYYY-MM'）的完成情况
   * @returns {{month:string, days:Array<{date:string,day:number,checked:boolean,future:boolean,today:boolean}>, checked:number, elapsed:number, rate:number, future:number}}
   */
  monthStats(month, today = new Date()) {
    const [y, m] = month.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const t = startOfDay(today);
    const days = [];
    let checked = 0;
    let elapsed = 0;
    let future = 0;

    for (let d = 1; d <= daysInMonth; d++) {
      const cur = new Date(y, m - 1, d);
      const key = formatDate(cur);
      const isFuture = cur.getTime() > t.getTime();
      const isChecked = this.dates.has(key);
      if (isFuture) future++;
      else {
        elapsed++;
        if (isChecked) checked++;
      }
      days.push({
        date: key,
        day: d,
        checked: isChecked,
        future: isFuture,
        today: cur.getTime() === t.getTime(),
      });
    }

    return {
      month,
      days,
      checked,
      elapsed,
      future,
      // 分母为「该月已过去的天数」，未来日期不参与，避免月初数字失真
      rate: elapsed ? Math.round((checked / elapsed) * 100) : 0,
    };
  }
}

/** 把 indexDb 记录（checkins 行 + 对应 logs）组装成 Checkin 实例 */
export function buildCheckin(rec, logRecords = []) {
  if (!rec) return null;
  return new Checkin({
    id: rec.id,
    title: rec.title,
    createdAt: rec.created_at,
    logs: logRecords.filter((l) => Number(l.checkin_id) === Number(rec.id)).map((l) => l.date),
  });
}

export default Checkin;
