/**
 * week_screen.js —— 周视图主页（02 文档第 2、3、5、6、10 节）
 */
import { h, mount, toast } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { WeekHeader, WeekdayStrip } from '../widgets/week_header.js';
import { DaySection } from '../widgets/day_section.js';
import { formatDate, startOfWeek, addWeeks, weekDays, isSameDay, formatMonthDay, addDays } from '../utils/date_utils.js';
import { CATEGORY_LIST, getCategory, categoryVars } from '../models/categories.js';

export function WeekScreen(ctx) {
  const el = h('div', { class: 'screen screen--week' });
  let weekDate = ctx.state.weekDate || new Date();
  // 分类筛选：null = 全部。切换后过滤卡片，便于把学术类单独拎出来看
  let filter = ctx.state.categoryFilter || null;

  /** 分类筛选条 */
  function FilterBar(events) {
    const present = new Set(events.map((e) => e.category));
    const items = [{ id: null, label: '全部', icon: '📚', color: 'var(--c-primary)', soft: 'var(--c-primary-soft)', border: 'var(--c-primary-border)' }];
    // 只展示本周实际出现过的分类，避免一排空标签
    CATEGORY_LIST.forEach((c) => {
      if (present.has(c.id)) items.push({ id: c.id, label: c.short, icon: c.icon, color: c.color, soft: c.soft, border: c.border });
    });
    if (items.length <= 2) return null;

    return h('div', { class: 'cat-filter' }, items.map((it) => {
      const active = filter === it.id;
      return h('button', {
        class: `cat-chip${active ? ' cat-chip--active' : ''}`,
        style: { '--cat': it.color, '--cat-soft': it.soft, '--cat-border': it.border },
        onclick: () => { filter = active ? null : it.id; ctx.state.categoryFilter = filter; render(); },
      }, [
        h('span', { class: 'cat-chip__icon', text: it.icon }),
        h('span', { text: it.label }),
      ]);
    }));
  }

  async function render() {
    ctx.state.weekDate = weekDate;
    const events = await ctx.db.getByWeek(weekDate);
    const all = await ctx.db.getAll();

    // 按日期分组（先应用分类筛选）
    const visible = filter ? events.filter((e) => e.category === filter) : events;
    const byDate = {};
    visible.forEach((e) => {
      const k = formatDate(e.startDate);
      (byDate[k] = byDate[k] || []).push(e);
    });
    const counts = {};
    Object.entries(byDate).forEach(([k, v]) => { counts[k] = v.length; });

    const days = weekDays(weekDate);
    const todayIndex = days.findIndex((d) => isSameDay(d, new Date()));

    const body = h('div', { class: 'app-body', id: 'week-body' }, days.map((d) => {
      const k = formatDate(d);
      return DaySection(d, (byDate[k] || []).slice().sort((a, b) => a.startTime.localeCompare(b.startTime)), {
        onEventClick: (ev) => ctx.go('detail', { id: ev.id }),
      });
    }));

    // 本周完全没有活动时的整体提示
    if (events.length === 0) {
      body.insertBefore(
        h('div', { class: 'notice notice--info' }, [
          h('span', { class: 'notice__icon', html: Icons.info }),
          h('span', { text: '本周暂无活动。点击下方「+」粘贴通知，或手动添加。' }),
        ]),
        body.firstChild
      );
    } else if (visible.length === 0) {
      // 有活动但被筛选条件过滤光了
      body.insertBefore(
        h('div', { class: 'notice notice--info' }, [
          h('span', { class: 'notice__icon', html: Icons.info }),
          h('span', { text: `本周没有「${getCategory(filter).label}」类活动，点上方标签可查看全部。` }),
        ]),
        body.firstChild
      );
    }

    const header = WeekHeader({
      weekDate,
      totalCount: all.length,
      onPrev: () => { weekDate = addWeeks(weekDate, -1); render(); },
      onNext: () => { weekDate = addWeeks(weekDate, 1); render(); },
      onToday: () => { weekDate = new Date(); render(); },
      onSettings: () => ctx.go('settings'),
    });

    const filterBar = FilterBar(events);

    const strip = WeekdayStrip({
      weekDate,
      eventsByDate: counts,
      onPick: (dateKey) => {
        const target = body.querySelector(`.day-section[data-date="${dateKey.replace(/^\d{4}-(\d{2})-(\d{2})$/, (m, a, b) => `${+a}/${+b}`)}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });

    // 顶部加「回到本周」按钮（不在本周时）
    if (!isSameDay(startOfWeek(weekDate), startOfWeek(new Date()))) {
      const btn = h('button', { class: 'today-btn', text: '回到本周', onclick: () => { weekDate = new Date(); render(); } });
      header.querySelector('.week-nav').appendChild(btn);
    }

    mount(el, [header, filterBar, strip, body]);

    // 进入本周时自动滚到今天，并让它落在可视区中间。
    //
    // 🔴 这里原来写的是 `body.scrollTop = sec.offsetTop - 12`，是个错的。
    //    `offsetTop` 量的是「相对 offsetParent 的距离」，而 `.app-body` 和
    //    `.screen` 都没有 position —— 它们的 offsetParent 一路找到 `#app`。
    //    于是量出来的是「相对整个应用顶部」的距离，比在滚动容器里的真实位置
    //    多出头部 + 筛选条 + 日期条那一整段（实测 205px）。
    //
    //    多滚 205px 的后果分两种：内容够长 → 停在后一天；内容不够长 →
    //    scrollTop 被钳到最大值，**直接落到周日**。
    //    用户 2026-09-22 报的「总是跳到最后，周日」就是后者。
    //
    //    正确做法：用 getBoundingClientRect() 算两者相对**滚动容器**的位置，
    //    再减去一半的剩余高度让它居中。
    if (todayIndex >= 0) {
      requestAnimationFrame(() => {
        const sec = body.querySelector('.day-section--today');
        if (!sec || body.scrollTop !== 0) return;
        const box = body.getBoundingClientRect();
        const secBox = sec.getBoundingClientRect();
        const topInBody = secBox.top - box.top + body.scrollTop;
        const max = Math.max(0, body.scrollHeight - body.clientHeight);
        const centered = topInBody - (body.clientHeight - secBox.height) / 2;
        // 首尾不够时由 clamp 兜住 —— 今天在周一就只能停在顶部，在周日就停在底部
        body.scrollTop = Math.max(0, Math.min(centered, max));
      });
    }
  }

  // 左右滑动切周
  let touchX = null, touchY = null;
  el.addEventListener('touchstart', (e) => {
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      weekDate = addWeeks(weekDate, dx > 0 ? -1 : 1);
      render();
    }
    touchX = touchY = null;
  }, { passive: true });

  // 鼠标拖拽（桌面模拟手机滑动）
  let downX = null, dragging = false;
  el.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, .event-card')) return;
    downX = e.clientX; dragging = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (!dragging || downX === null) return;
    const dx = e.clientX - downX;
    dragging = false; downX = null;
    if (Math.abs(dx) > 90) {
      weekDate = addWeeks(weekDate, dx < 0 ? 1 : -1);
      render();
    }
  });

  el._refresh = render;
  render();
  return el;
}
