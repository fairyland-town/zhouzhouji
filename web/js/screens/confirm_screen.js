/**
 * confirm_screen.js —— 识别确认页面（02 文档第 8、10 节）
 * 铁律：自动识别后不得直接保存，必须人工确认。
 *   - 全部识别成功：绿色提示
 *   - 部分识别成功：未识别字段高亮，提示补充
 *   - 全部失败：提示手动补充
 */
import { h, mount, toast } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { PageHeader } from '../widgets/page_header.js';
import { Event } from '../models/event.js';
import { formatDateTime, toDate } from '../utils/date_utils.js';
import { CATEGORY_LIST, getCategory, isAcademic, DEFAULT_CATEGORY } from '../models/categories.js';

const FIELD_META = [
  { key: 'title', label: '活动名称', type: 'text' },
  { key: 'startTime', label: '活动时间', type: 'datetime' },
  { key: 'location', label: '活动地点', type: 'text' },
];

/** 把 'YYYY-MM-DD HH:mm' 转成 datetime-local 需要的 'YYYY-MM-DDTHH:mm' */
function toInputValue(v) {
  if (!v) return '';
  return String(v).trim().replace(' ', 'T').slice(0, 16);
}

export function ConfirmScreen(ctx) {
  const el = h('div', { class: 'screen screen--confirm' });
  const parsed = ctx.params?.parsed || {};
  const editingId = ctx.params?.editingId ?? null;
  const isEdit = editingId != null;

  // 可编辑的当前值
  const values = {
    title: parsed.title || '',
    startTime: parsed.startTime || '',
    location: parsed.location || '',
    category: parsed.category || DEFAULT_CATEGORY,
    speaker: parsed.speaker || '',
  };

  const FIELD_LABELS = { title: '名称', startTime: '时间', location: '地点' };

  function confidenceOf(key) {
    return parsed.fieldConfidence ? (parsed.fieldConfidence[key] ?? 0) : 0;
  }

  function statusText() {
    const found = FIELD_META.filter((f) => values[f.key]).map((f) => FIELD_LABELS[f.key]);
    const missed = FIELD_META.filter((f) => !values[f.key]).map((f) => FIELD_LABELS[f.key]);
    if (missed.length === 0) return { kind: 'success', text: `已完整识别：${found.join('、')}` };
    if (found.length === 0) return { kind: 'danger', text: '未能完整识别活动信息，请手动补充缺失字段。' };
    return { kind: 'warn', text: `已识别：${found.join('、')}；未识别：${missed.join('、')}，请手动补充。` };
  }

  function render() {
    const st = statusText();
    const header = PageHeader({
      title: isEdit ? '修改活动' : '确认活动信息',
      sub: isEdit ? '修改后保存' : '请核对识别结果，确认无误后保存',
      onBack: () => ctx.back(),
    });

    const body = h('div', { class: 'app-body' });

    // 状态提示
    body.appendChild(h('div', { class: `notice notice--${st.kind}` }, [
      h('span', { class: 'notice__icon', html: st.kind === 'success' ? Icons.check : Icons.warn }),
      h('span', { text: st.text }),
    ]));

    // 识别结果概览卡
    if (!isEdit) {
      const overviewRows = FIELD_META.map((f) => h('div', { class: 'field-row' }, [
        h('span', { class: 'field-row__label', text: f.label }),
        h('span', {
          class: `field-row__value${values[f.key] ? '' : ' field-row__value--empty'}`,
          text: values[f.key] || '未识别',
        }),
      ]));
      // 分类与学术类附加字段也纳入概览
      overviewRows.push(h('div', { class: 'field-row' }, [
        h('span', { class: 'field-row__label', text: '分类' }),
        h('span', { class: 'field-row__value', text: getCategory(values.category).label }),
      ]));
      if (isAcademic(values.category)) {
        overviewRows.push(h('div', { class: 'field-row' }, [
          h('span', { class: 'field-row__label', text: '报告人' }),
          h('span', {
            class: `field-row__value${values.speaker ? '' : ' field-row__value--empty'}`,
            text: values.speaker || '未识别',
          }),
        ]));
      }
      body.appendChild(h('div', { class: 'result-card' }, [
        h('div', { class: 'result-card__head' }, [
          h('span', { html: Icons.wand }),
          h('span', { text: '识别结果' }),
          h('span', {
            class: 'count-badge',
            text: `可信度 ${Math.round((parsed.confidence || 0) * 100)}%`,
          }),
        ]),
        h('div', { class: 'result-card__body' }, overviewRows),
      ]));
    }

    // 分类选择（放在最前，因为选完分类才知道要不要填报告人）
    const catWrap = h('div', { class: 'cat-picker' });
    function renderCatPicker() {
      catWrap.replaceChildren(...CATEGORY_LIST.map((c) => {
        const active = values.category === c.id;
        return h('button', {
          class: `cat-option${active ? ' cat-option--active' : ''}`,
          style: { '--cat': c.color, '--cat-soft': c.soft, '--cat-border': c.border },
          onclick: () => {
            values.category = c.id;
            values._catTouched = true;
            render();
          },
        }, [
          h('span', { class: 'cat-option__icon', text: c.icon }),
          h('span', { text: c.label }),
        ]);
      }));
    }
    renderCatPicker();

    body.appendChild(h('div', { class: 'form-group' }, [
      h('label', { class: 'form-label' }, [
        h('span', { text: '活动分类' }),
        h('span', {
          class: 'field-status field-status--ok',
          text: confidenceOf('category') >= 0.8 ? '已识别' : '可调整',
        }),
      ]),
      catWrap,
      h('div', { class: 'form-hint', text: '学术：会议 / 报告 / 讲座 / 论坛　　就业：宣讲 / 招聘　　其余归入其他' }),
    ]));

    // 可编辑表单
    const inputs = {};
    FIELD_META.forEach((f) => {
      const missing = !values[f.key];
      const conf = confidenceOf(f.key);
      const input = h('input', {
        class: `input${missing && !isEdit ? ' input--missing' : ''}`,
        type: f.type === 'datetime' ? 'datetime-local' : 'text',
        step: f.type === 'datetime' ? '60' : null,
        value: f.type === 'datetime' ? toInputValue(values[f.key]) : values[f.key],
        placeholder: f.type === 'datetime' ? '' : (f.key === 'title' ? '例如：人工智能专题讲座' : '例如：信息楼A201'),
        oninput: (e) => {
          values[f.key] = f.type === 'datetime' ? e.target.value.replace('T', ' ') : e.target.value;
          const m = !values[f.key];
          e.target.classList.toggle('input--missing', m && !isEdit);
        },
      });
      inputs[f.key] = input;

      body.appendChild(h('div', { class: 'form-group' }, [
        h('label', { class: 'form-label' }, [
          h('span', { text: f.label }),
          h('span', { class: 'form-label__req', text: '*' }),
          values[f.key]
            ? h('span', { class: 'field-status field-status--ok', text: conf >= 0.8 ? '已识别' : '已填写' })
            : h('span', { class: 'field-status field-status--miss', text: '未识别' }),
        ]),
        input,
        f.key === 'startTime'
          ? h('div', { class: 'form-hint', text: '活动会按此时间自动归入对应周（每周从周一开始）' })
          : null,
      ]));
    });

    // 学术类专属：报告人（非学术类自动隐藏）
    if (isAcademic(values.category)) {
      const speakerInput = h('input', {
        class: 'input',
        type: 'text',
        value: values.speaker,
        placeholder: '例如：张伟教授',
        oninput: (e) => { values.speaker = e.target.value; },
      });
      inputs.speaker = speakerInput;
      body.appendChild(h('div', { class: 'academic-block' }, [
        h('div', { class: 'academic-block__head' }, [
          h('span', { html: Icons.book }),
          h('span', { text: '学术类补充信息' }),
        ]),
        h('div', { class: 'form-group' }, [
          h('label', { class: 'form-label' }, [
            h('span', { text: '报告人' }),
            values.speaker
              ? h('span', { class: 'field-status field-status--ok', text: '已识别' })
              : h('span', { class: 'field-status field-status--opt', text: '选填' }),
          ]),
          speakerInput,
          h('div', { class: 'form-hint', text: '「活动名称」填写会议全称或报告题目即可，无需重复填写会议名' }),
        ]),
      ]));
    }

    // 原文折叠查看
    if (parsed.rawText && !isEdit) {
      const raw = h('div', { class: 'form-hint', text: parsed.rawText, style: { display: 'none', whiteSpace: 'pre-wrap', background: '#f7f8fb', padding: '10px', borderRadius: '8px', marginTop: '4px', maxHeight: '150px', overflow: 'auto' } });
      const toggle = h('button', {
        class: 'btn btn--ghost btn--sm',
        text: '查看通知原文',
        onclick: () => {
          const hidden = raw.style.display === 'none';
          raw.style.display = hidden ? 'block' : 'none';
          toggle.textContent = hidden ? '收起原文' : '查看通知原文';
        },
      });
      body.appendChild(h('div', { class: 'form-group' }, [toggle, raw]));
    }

    // 保存 / 取消
    const save = async () => {
      const event = new Event({
        id: isEdit ? editingId : null,
        title: values.title.trim(),
        location: values.location.trim(),
        startTime: values.startTime,
        rawText: parsed.rawText || '',
        category: values.category,
        // 非学术类不保存学术字段，避免切换分类后残留脏数据
        speaker: isAcademic(values.category) ? values.speaker.trim() : '',
      });
      const check = event.validate();
      if (!check.ok) {
        toast(check.errors[0], 'warn');
        const bad = FIELD_META.find((f) => !values[f.key]);
        if (bad && inputs[bad.key]) inputs[bad.key].focus();
        return;
      }
      if (Number.isNaN(toDate(event.startTime).getTime())) {
        toast('活动时间格式不正确，请重新选择', 'warn');
        return;
      }
      try {
        if (isEdit) {
          await ctx.db.update(event);
          toast('已保存修改', 'success');
        } else {
          await ctx.db.add(event);
          toast('活动已添加', 'success');
        }
        // 跳到该活动所在周
        ctx.state.weekDate = toDate(event.startTime);
        ctx.state.pendingScrollDate = event.dateString;
        ctx.closeModal();
        ctx.go('week');
      } catch (err) {
        toast('保存失败：' + err.message, 'error');
      }
    };

    body.appendChild(h('div', { class: 'btn-row' }, [
      h('button', { class: 'btn btn--ghost', onclick: () => { if (isEdit) ctx.back(); else ctx.go('week'); } }, '取消'),
      h('button', { class: 'btn btn--primary', onclick: save }, [
        h('span', { html: Icons.check }),
        h('span', { text: isEdit ? '保存修改' : '确认添加' }),
      ]),
    ]));

    mount(el, [header, body]);
  }

  render();
  return el;
}
