/**
 * event_card.js —— 活动卡片
 *
 * 基础展示（02 文档第 4 节）：时间 / 名称 / 地点
 * 分类扩展：
 *   - 每个分类有独立主色（左边框 + 标签 + 时间文字）由 --cat 系列 CSS 变量驱动
 *   - 学术类额外多显示一行「报告人」
 *     （学术类的「活动名称」本身就是会议名 / 报告题目，不重复展示）
 */
import { h } from '../utils/dom.js';
import { Icons } from './icons.js';
import { isSameDay, formatDate } from '../utils/date_utils.js';
import { getCategory, categoryVars } from '../models/categories.js';

export function EventCard(event, { onClick } = {}) {
  const isPast = event.startDate.getTime() < new Date().setHours(0, 0, 0, 0);
  const cat = getCategory(event.category);
  const academic = cat.academic;

  // 学术类才展示报告人
  const showSpeaker = academic && event.speaker;

  const meta = [
    event.location
      ? h('div', { class: 'event-card__location' }, [
          h('span', { class: 'event-card__ico', html: Icons.pin }),
          h('span', { text: event.location }),
        ])
      : null,
    // 学术类专属：报告人
    showSpeaker
      ? h('div', { class: 'event-card__meta event-card__meta--speaker' }, [
          h('span', { class: 'event-card__ico', html: Icons.user }),
          h('span', { class: 'event-card__meta-k', text: '报告人' }),
          h('span', { class: 'event-card__meta-v', text: event.speaker }),
        ])
      : null,
  ].filter(Boolean);

  const card = h('div', {
    class: `event-card${isPast ? ' event-card--past' : ''}${academic ? ' event-card--academic' : ''}`,
    dataset: {
      id: event.id,
      date: formatDate(event.startDate),
      category: event.category,
    },
    style: categoryVars(event.category),
    role: 'button',
    tabindex: '0',
    onclick: () => onClick && onClick(event),
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick && onClick(event); }
    },
  }, [
    h('div', { class: 'event-card__time', text: event.timeString || '全天' }),
    h('div', { class: 'event-card__main' }, [
      h('div', { class: 'event-card__badge' }, [
        h('span', { class: 'event-card__badge-icon', text: cat.icon }),
        h('span', { text: cat.short }),
      ]),
      h('div', { class: 'event-card__title', text: event.title }),
      meta.length ? h('div', { class: 'event-card__metas' }, meta) : null,
      event.rawText
        ? h('span', {
            class: 'event-card__raw',
            text: '来自通知识别',
            title: '该活动由通知文本自动识别生成',
          })
        : null,
    ]),
  ]);

  return card;
}
