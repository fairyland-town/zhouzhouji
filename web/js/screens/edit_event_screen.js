/**
 * edit_event_screen.js —— 活动详情 / 编辑 / 删除（02 文档第 9 节）
 */
import { h, mount, toast, confirmDialog } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { PageHeader } from '../widgets/page_header.js';
import { Event } from '../models/event.js';
import { CATEGORY_LIST, getCategory, isAcademic, categoryVars } from '../models/categories.js';
import {
  weekdayName, formatMonthDay, formatTime, toDate,
  weekRangeLabel, relativeWeekLabel,
} from '../utils/date_utils.js';

function toInputValue(v) {
  if (!v) return '';
  return String(v).trim().replace(' ', 'T').slice(0, 16);
}

export function EditEventScreen(ctx) {
  const el = h('div', { class: 'screen screen--detail' });
  const id = ctx.params?.id;
  let event = null;
  let editing = false;

  async function load() {
    event = await ctx.db.getById(id);
    if (!event) {
      mount(el, [
        PageHeader({ title: '活动详情', onBack: () => ctx.back() }),
        h('div', { class: 'app-body' }, h('div', { class: 'empty-state' }, [
          h('div', { class: 'empty-state__icon', text: '🗂' }),
          h('div', { class: 'empty-state__title', text: '活动不存在或已被删除' }),
        ])),
      ]);
      return;
    }
    render();
  }

  function render() {
    const d = event.startDate;
    const header = PageHeader({
      title: editing ? '编辑活动' : '活动详情',
      sub: editing ? '修改后点击保存' : `${formatMonthDay(d)} ${weekdayName(d)} ${formatTime(d)}`,
      onBack: () => { if (editing) { editing = false; render(); } else ctx.back(); },
    });

    const body = h('div', { class: 'app-body' });
    const cat = getCategory(event.category);

    if (!editing) {
      /* ---------- 详情视图 ---------- */
      const rows = [
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '分类' }),
          h('span', { class: 'field-row__value' }, [
            h('span', {
              class: 'detail-cat',
              style: categoryVars(event.category),
              text: `${cat.icon} ${cat.label}`,
            }),
          ]),
        ]),
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '名称' }),
          h('span', { class: 'field-row__value', text: event.title }),
        ]),
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '时间' }),
          h('span', { class: 'field-row__value', text: event.startTime }),
        ]),
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '地点' }),
          h('span', { class: 'field-row__value', text: event.location }),
        ]),
      ];

      // 学术类：额外展示报告人
      if (isAcademic(event.category) && event.speaker) {
        rows.push(h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '报告人' }),
          h('span', { class: 'field-row__value', text: event.speaker }),
        ]));
      }

      rows.push(
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '所属周' }),
          h('span', {
            class: 'field-row__value',
            text: `${weekRangeLabel(d)}${relativeWeekLabel(d) ? ' · ' + relativeWeekLabel(d) : ''}`,
          }),
        ]),
        h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '创建于' }),
          h('span', { class: 'field-row__value', style: { color: 'var(--c-text-3)', fontSize: '12.5px' }, text: event.createdAt }),
        ]),
      );

      body.appendChild(h('div', {
        class: 'result-card',
        style: categoryVars(event.category),
      }, [
        h('div', { class: 'result-card__head' }, [
          h('span', { html: Icons.calendar }),
          h('span', { text: '活动信息' }),
        ]),
        h('div', { class: 'result-card__body' }, rows),
      ]));

      if (event.rawText) {
        body.appendChild(h('div', { class: 'section-title', text: '通知原文' }));
        body.appendChild(h('div', {
          class: 'list-card',
          style: { padding: '12px', fontSize: '12.5px', color: 'var(--c-text-2)', whiteSpace: 'pre-wrap', lineHeight: '1.65', maxHeight: '220px', overflow: 'auto' },
          text: event.rawText,
        }));
      }

      body.appendChild(h('div', { class: 'btn-row' }, [
        h('button', { class: 'btn btn--soft-danger', onclick: doDelete }, [
          h('span', { html: Icons.trash }),
          h('span', { text: '删除' }),
        ]),
        h('button', { class: 'btn btn--primary', onclick: () => { editing = true; render(); } }, [
          h('span', { html: Icons.edit }),
          h('span', { text: '修改' }),
        ]),
      ]));

      mount(el, [header, body]);
      return;
    }

    /* ---------- 编辑视图 ---------- */
    // 编辑态用草稿对象，取消时不污染 event
    const draft = {
      title: event.title,
      startTime: event.startTime,
      location: event.location,
      category: event.category,
      speaker: event.speaker,
    };

    const titleI = h('input', { class: 'input', value: draft.title, oninput: (e) => { draft.title = e.target.value; } });
    const timeI = h('input', { class: 'input', type: 'datetime-local', step: '60', value: toInputValue(draft.startTime), oninput: (e) => { draft.startTime = e.target.value.replace('T', ' '); } });
    const locI = h('input', { class: 'input', value: draft.location, oninput: (e) => { draft.location = e.target.value; } });

    body.appendChild(h('div', { class: 'notice notice--info' }, [
      h('span', { class: 'notice__icon', html: Icons.info }),
      h('span', { text: '修改时间后，活动会自动归入新的对应周。' }),
    ]));

    // 分类选择
    const catWrap = h('div', { class: 'cat-picker' });
    function paintCats() {
      catWrap.replaceChildren(...CATEGORY_LIST.map((c) => {
        const active = draft.category === c.id;
        return h('button', {
          class: `cat-option${active ? ' cat-option--active' : ''}`,
          style: { '--cat': c.color, '--cat-soft': c.soft, '--cat-border': c.border },
          onclick: () => { draft.category = c.id; render(); },
        }, [
          h('span', { class: 'cat-option__icon', text: c.icon }),
          h('span', { text: c.label }),
        ]);
      }));
    }
    paintCats();

    body.appendChild(h('div', { class: 'form-group' }, [
      h('label', { class: 'form-label' }, [h('span', { text: '活动分类' })]),
      catWrap,
    ]));

    [
      { label: '活动名称', input: titleI },
      { label: '活动时间', input: timeI },
      { label: '活动地点', input: locI },
    ].forEach((f) => {
      body.appendChild(h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, [h('span', { text: f.label }), h('span', { class: 'form-label__req', text: '*' })]),
        f.input,
      ]));
    });

    // 学术类补充字段：报告人
    if (isAcademic(draft.category)) {
      const spkI = h('input', { class: 'input', value: draft.speaker, placeholder: '例如：张伟教授', oninput: (e) => { draft.speaker = e.target.value; } });
      body.appendChild(h('div', { class: 'academic-block' }, [
        h('div', { class: 'academic-block__head' }, [
          h('span', { html: Icons.book }),
          h('span', { text: '学术类补充信息' }),
        ]),
        h('div', { class: 'form-group' }, [
          h('label', { class: 'form-label' }, [h('span', { text: '报告人' })]),
          spkI,
        ]),
      ]));
    }

    body.appendChild(h('div', { class: 'btn-row' }, [
      h('button', { class: 'btn btn--ghost', onclick: () => { editing = false; render(); } }, '取消'),
      h('button', {
        class: 'btn btn--primary',
        onclick: async () => {
          const updated = new Event({
            id: event.id,
            title: draft.title.trim(),
            location: draft.location.trim(),
            startTime: draft.startTime,
            rawText: event.rawText,
            createdAt: event.createdAt,
            category: draft.category,
            speaker: isAcademic(draft.category) ? draft.speaker.trim() : '',
          });
          const check = updated.validate();
          if (!check.ok) { toast(check.errors[0], 'warn'); return; }
          try {
            await ctx.db.update(updated);
            event = updated;
            editing = false;
            ctx.state.weekDate = updated.startDate;
            toast('已保存修改', 'success');
            render();
          } catch (err) {
            toast('保存失败：' + err.message, 'error');
          }
        },
      }, '保存修改'),
    ]));

    mount(el, [header, body]);
  }

  async function doDelete() {
    const ok = await confirmDialog({
      title: '删除活动',
      message: `确定要删除「${event.title}」吗？此操作不可撤销。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await ctx.db.remove(event.id);
      toast('已删除', 'success');
      ctx.state.weekDate = event.startDate;
      ctx.go('week');
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
    }
  }

  load();
  return el;
}
