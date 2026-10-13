/**
 * event.js
 * Event 模型（字段与 03 文档 SQLite 表 events 完全一致）
 *   id, title, location, startTime, rawText, createdAt
 * 扩展字段（分类系统）：
 *   category  活动分类 id（见 models/categories.js：学术 / 就业 / 其他）
 *   speaker   报告人 / 主讲人（仅学术类展示）
 *
 * 注意：v1.1 的 meetingName 字段已废弃 ——
 * 学术类的「活动名称」本身就是会议名 / 报告题目，不需要重复维护。
 * 读取旧记录时若带 meeting_name，仅用于在 title 为空时兜底，不再单独存字段。
 */

import { toDate, formatDateTime, formatDate, formatTime } from '../utils/date_utils.js';
import { DEFAULT_CATEGORY, isAcademic, normalizeCategory } from './categories.js';

export class Event {
  constructor({
    id = null, title = '', location = '', startTime = '', rawText = '', createdAt = null,
    category = DEFAULT_CATEGORY, speaker = '',
  } = {}) {
    this.id = id;
    this.title = String(title || '').trim();
    this.location = String(location || '').trim();
    this.startTime = startTime instanceof Date ? formatDateTime(startTime) : String(startTime || '');
    this.rawText = rawText == null ? '' : String(rawText);
    this.createdAt = createdAt
      ? (createdAt instanceof Date ? formatDateTime(createdAt) : String(createdAt))
      : formatDateTime(new Date());
    // 分类归一化：v1.1 的 7 类旧 id 自动映射到新的 3 类，未知 id 回退到 other，
    // 保证历史数据与脏数据都不会让卡片渲染失败。
    this.category = normalizeCategory(category);
    this.speaker = String(speaker || '').trim();
  }

  /** 是否学术类 —— 决定卡片是否多显示报告人 */
  get academic() { return isAcademic(this.category); }

  get startDate() { return toDate(this.startTime); }
  get dateString() { return formatDate(this.startDate); }
  get timeString() { return formatTime(this.startDate); }

  /** 数据是否合法（title/location/start_time 均为 NOT NULL） */
  validate() {
    const errors = [];
    if (!this.title) errors.push('活动名称不能为空');
    if (!this.startTime || Number.isNaN(this.startDate.getTime())) errors.push('活动时间不能为空或格式不正确');
    if (!this.location) errors.push('活动地点不能为空');
    return { ok: errors.length === 0, errors };
  }

  /** 转为 IndexedDB / SQLite 记录 */
  toRecord() {
    return {
      id: this.id,
      title: this.title,
      location: this.location,
      start_time: this.startTime,   // 与 SQLite 列名保持一致
      raw_text: this.rawText,
      created_at: this.createdAt,
      category: this.category,
      speaker: this.speaker,
    };
  }

  /**
   * 从记录还原
   * 兼容性：
   *   - v1.0 旧记录没有 category / speaker → 回退 other / 空字符串
   *   - v1.1 旧记录 category 是 7 类旧 id → 由 normalizeCategory 自动映射到新 3 类
   *   - v1.1 旧记录可能带 meeting_name → 仅当 title 为空时兜底为 title，不再单独存
   */
  static fromRecord(rec) {
    if (!rec) return null;
    const title = rec.title || rec.meeting_name || rec.meetingName || '';
    return new Event({
      id: rec.id,
      title,
      location: rec.location,
      startTime: rec.start_time,
      rawText: rec.raw_text,
      createdAt: rec.created_at,
      category: rec.category || rec.category_id || DEFAULT_CATEGORY,
      speaker: rec.speaker || '',
    });
  }

  /** 用于 JSON 导入导出的干净结构 */
  toJSON() {
    return {
      title: this.title,
      location: this.location,
      start_time: this.startTime,
      raw_text: this.rawText,
      created_at: this.createdAt,
      category: this.category,
      speaker: this.speaker,
    };
  }

  clone() { return Event.fromRecord(this.toRecord()); }
}
