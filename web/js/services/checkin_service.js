/**
 * checkin_service.js —— 打卡业务逻辑（v1.3.0）
 *
 * 职责：把 database_service 的裸记录组装成 Checkin 模型，并做统计。
 * UI 层只跟这里打交道，不直接读 checkin_logs。
 */

import DatabaseService from './database_service.js';
import { Checkin, buildCheckin } from '../models/checkin.js';
import { formatDate } from '../utils/date_utils.js';

export const CheckinService = {
  /** 全部打卡项（已带 dates 集合，可直接算 streak / 月历） */
  async list() {
    const [items, logs] = await Promise.all([
      DatabaseService.getCheckins(),
      DatabaseService.getAllCheckinLogs(),
    ]);
    return items.map((rec) => buildCheckin(rec, logs)).filter((c) => c && c.title);
  },

  async get(id) {
    const rec = (await DatabaseService.getCheckins()).find((c) => Number(c.id) === Number(id));
    if (!rec) return null;
    const logs = await DatabaseService.getCheckinLogs(id);
    return buildCheckin(rec, logs);
  },

  create(title) {
    return DatabaseService.addCheckin(title);
  },

  rename(id, title) {
    return DatabaseService.renameCheckin(id, title);
  },

  remove(id) {
    return DatabaseService.removeCheckin(id);
  },

  /** 切换某天打卡状态，返回 true=已打卡 / false=已取消 */
  toggle(id, date = new Date()) {
    return DatabaseService.toggleCheckin(id, formatDate(new Date(date)));
  },

  /** 今天是否已打卡 */
  async isTodayChecked(id) {
    const c = await this.get(id);
    return c ? c.isChecked(formatDate(new Date())) : false;
  },

  /** 列表摘要：每个打卡项的连续天数 + 本月完成率 */
  async summary(month, today = new Date()) {
    const items = await this.list();
    return items.map((c) => {
      const ms = c.monthStats(month, today);
      return {
        checkin: c,
        streak: c.streak(today),
        longest: c.longestStreak(),
        monthChecked: ms.checked,
        monthElapsed: ms.elapsed,
        monthRate: ms.rate,
        checkedToday: c.isChecked(formatDate(today)),
      };
    });
  },

  /** 全局：今天应打卡总数 / 已完成数 */
  async todayOverview(today = new Date()) {
    const items = await this.list();
    const key = formatDate(today);
    const done = items.filter((c) => c.isChecked(key)).length;
    return { total: items.length, done };
  },
};

export default CheckinService;
