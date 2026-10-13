/**
 * day_section.js —— 按天分组的区块（02 文档第 3 节）
 *   周一 9/14
 *   暂无活动
 */
import { h } from '../utils/dom.js';
import { EventCard } from './event_card.js';
import { formatSlash, weekdayName, isToday } from '../utils/date_utils.js';

export function DaySection(date, events, { onEventClick } = {}) {
  const today = isToday(date);
  const cls = `day-section${today ? ' day-section--today' : ''}`;

  const head = h('div', { class: 'day-section__head' }, [
    h('span', { class: 'day-section__dot' }),
    h('span', { class: 'day-section__name', text: weekdayName(date) }),
    h('span', { class: 'day-section__date', text: formatSlash(date) + (today ? ' · 今天' : '') }),
    events.length ? h('span', { class: 'day-section__count', text: `${events.length} 项` }) : null,
  ]);

  if (!events.length) {
    return h('section', { class: cls, dataset: { date: formatSlash(date) } }, [
      head,
      h('div', { class: 'day-section__empty', text: today ? '今天暂无活动' : '暂无活动' }),
    ]);
  }

  return h('section', { class: cls, dataset: { date: formatSlash(date) } }, [
    head,
    ...events.map((e) => EventCard(e, { onClick: onEventClick })),
  ]);
}
