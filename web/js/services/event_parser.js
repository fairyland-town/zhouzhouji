/**
 * event_parser.js
 * 整合 TitleParser / TimeParser / LocationParser / CategoryParser / SpeakerParser
 * 返回 ParsedEvent：
 *   { title, startTime, location, category, speaker,
 *     confidence, fieldConfidence, rawText, missing }
 *
 * 注意：学术类的「活动名称」本身就是会议名 / 报告题目，因此不再单独解析会议名。
 */

import { parseTitle } from './title_parser.js';
import { parseTime } from './time_parser.js';
import { parseLocation } from './location_parser.js';
import { parseCategory } from './category_parser.js';
import { parseSpeaker } from './speaker_parser.js';
import { isAcademic } from '../models/categories.js';
import { formatDateTime } from '../utils/date_utils.js';

/**
 * @param {string} text 通知原文
 * @param {object} options { baseYear, now, categoryHint }
 * @returns {{
 *   title: string, startTime: string, location: string,
 *   category: string, speaker: string,
 *   academic: boolean,
 *   confidence: number,
 *   fieldConfidence: {title:number, startTime:number, location:number, category:number, speaker:number},
 *   rawText: string,
 *   missing: string[]
 * }}
 */
export function parseEvent(text, options = {}) {
  const rawText = text == null ? '' : String(text);

  const t = parseTitle(rawText);
  const tm = parseTime(rawText, options);
  const l = parseLocation(rawText);
  const c = parseCategory(rawText, { hint: options.categoryHint });

  // 报告人只在学术类下才有意义，非学术类直接跳过，避免误抓
  const academic = isAcademic(c.category);
  const sp = academic ? parseSpeaker(rawText) : { speaker: '', confidence: 0, reason: '非学术类' };

  const startTime = tm.date ? formatDateTime(tm.date) : '';

  const fieldConfidence = {
    title: t.confidence,
    startTime: tm.confidence,
    location: l.confidence,
    category: c.confidence,
    speaker: sp.confidence,
  };

  // 综合置信度：以归周依据（时间）为最高权重，标题次之，地点再次
  const confidence = Number((
    fieldConfidence.title * 0.3
    + fieldConfidence.startTime * 0.45
    + fieldConfidence.location * 0.25
  ).toFixed(2));

  const missing = [];
  if (!t.title) missing.push('title');
  if (!startTime) missing.push('startTime');
  if (!l.location) missing.push('location');

  return {
    title: t.title || '',
    startTime,
    location: l.location || '',
    category: c.category,
    speaker: sp.speaker || '',
    academic,
    confidence,
    fieldConfidence,
    rawText,
    missing,
  };
}

/** 判断解析结果是否达到"可直接保存"的水平 */
export function isComplete(parsed) {
  return !!(parsed && parsed.title && parsed.startTime && parsed.location);
}
