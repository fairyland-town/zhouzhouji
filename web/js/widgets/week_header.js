/**
 * week_header.js —— 顶部周头部（02 文档第 2 节）
 *   周周记 / 2026年9月 / 本周 / 9月14日 - 9月20日
 *   注：按产品要求不再显示「第 N 周」序号，只显示相对周（本周/上周/下周）与日期区间。
 */
import { h } from '../utils/dom.js';
import { Icons } from './icons.js';
import {
  startOfWeek, addDays,
  weekRangeLabel, monthLabel, relativeWeekLabel, isSameWeek,
} from '../utils/date_utils.js';

export function WeekHeader({ weekDate, onPrev, onNext, onToday, onSettings, totalCount = 0 }) {
  const start = startOfWeek(weekDate);
  const rel = relativeWeekLabel(weekDate);
  const isCurrent = isSameWeek(weekDate, new Date());

  return h('header', { class: 'app-header' }, [
    h('div', { class: 'app-header__top' }, [
      h('div', { class: 'app-header__brand' }, [
        // 用真实应用图标（与主屏 / 标签页同源），而不是画一个「周」字方块 ——
        // 品牌资产只有一处，改图标时这里跟着变
        h('img', { class: 'app-header__logo', src: 'icons/icon-192.png', alt: '', 'aria-hidden': 'true' }),
        h('div', {}, [
          h('div', { class: 'app-header__title', text: '周周记' }),
          h('div', { class: 'app-header__sub', text: monthLabel(start) + (totalCount ? ` · 共 ${totalCount} 个活动` : '') }),
        ]),
      ]),
      h('div', { class: 'app-header__actions' }, [
        h('button', {
          class: 'icon-btn',
          title: '设置与数据',
          'aria-label': '设置',
          html: Icons.settings,
          onclick: onSettings,
        }),
      ]),
    ]),

    h('div', { class: 'week-nav' }, [
      h('button', { class: 'week-nav__btn', onclick: onPrev, title: '上一周' }, [
        h('span', { html: Icons.chevronLeft }),
        h('span', { text: '上一周' }),
      ]),
      h('div', { class: 'week-nav__center' }, [
        h('div', { class: 'week-nav__week' }, [
          h('span', { class: 'week-nav__badge', text: rel || '本周' }),
        ]),
        h('div', { class: 'week-nav__range', text: weekRangeLabel(start) }),
      ]),
      h('button', { class: 'week-nav__btn', onclick: onNext, title: '下一周' }, [
        h('span', { text: '下一周' }),
        h('span', { html: Icons.chevronRight }),
      ]),
    ]),
  ]);
}

/** 周一到周日的快速跳转条 */
export function WeekdayStrip({ weekDate, eventsByDate, onPick }) {
  const start = startOfWeek(weekDate);
  const names = ['一', '二', '三', '四', '五', '六', '日'];
  const today = new Date();

  return h('div', { class: 'weekday-strip' }, names.map((n, i) => {
    const d = addDays(start, i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const has = (eventsByDate[key] || 0) > 0;
    const isToday = d.getFullYear() === today.getFullYear()
      && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    return h('button', {
      class: `weekday-chip${has ? ' weekday-chip--has-event' : ''}${isToday ? ' weekday-chip--today' : ''}`,
      dataset: { date: key },
      onclick: () => onPick && onPick(key),
      title: has ? `${eventsByDate[key]} 个活动` : '暂无活动',
    }, [
      h('span', { class: 'weekday-chip__w', text: `周${n}` }),
      h('span', { class: 'weekday-chip__d', text: String(d.getDate()) }),
      h('span', { class: 'weekday-chip__dot' }),
    ]);
  }));
}
