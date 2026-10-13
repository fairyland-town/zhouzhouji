/**
 * checkin_view.js —— 打卡子视图（v1.3.0）
 *
 * 两个形态：
 *   列表态：所有打卡项的卡片（名称 / 连续天数 / 本月完成率 / 今日打卡按钮）
 *   月历态：单个打卡项的月历，哪天打了、哪天没打、哪些还没到，一眼看清
 *
 * 月历交互：点击某天切换该天的打卡状态（可补打卡 / 取消误打卡），
 * 但未来日期不可点击 —— 还没到的日子没法打卡。
 */

import { h, mount, toast, confirmDialog, actionSheet, pushOverlay, popOverlay } from '../../utils/dom.js';
import { Icons } from '../../widgets/icons.js';
import CheckinService from '../../services/checkin_service.js';
import { formatDate, weekdayName } from '../../utils/date_utils.js';

/** 当前查看的月份，形如 '2026-09' */
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function CheckinView(ctx) {
  const root = h('div', { class: 'app-body' });
  let view = 'list';          // 'list' | 'calendar'
  let activeId = null;        // 月历态正在看的打卡项
  let month = monthKey(new Date()); // 月历态当前月份

  async function render() {
    if (view === 'calendar') await renderCalendar();
    else await renderList();
  }

  /* ---------------- 列表态 ---------------- */

  async function renderList() {
    const rows = await CheckinService.summary(monthKey(new Date()));

    if (rows.length === 0) {
      mount(root, [
        h('div', { class: 'empty-state' }, [
          h('div', { class: 'empty-state__icon', text: '✅' }),
          h('div', { class: 'empty-state__title', text: '还没有打卡项' }),
          h('div', { class: 'empty-state__desc', text: '比如「背单词」「跑步」「早睡」，每天点一下，自动统计连续天数。' }),
          h('button', { class: 'btn btn--primary', style: { marginTop: '14px' }, onclick: createCheckin }, '新建打卡项'),
        ]),
      ]);
      return;
    }

    const todayKey = formatDate(new Date());
    const doneCount = rows.filter((r) => r.checkedToday).length;

    const summaryCard = h('div', { class: 'chk-summary' }, [
      h('div', { class: 'chk-summary__icon', html: Icons.checkCircle }),
      h('div', { class: 'chk-summary__main' }, [
        h('div', { class: 'chk-summary__title', text: `今日已完成 ${doneCount} / ${rows.length}` }),
        h('div', { class: 'chk-summary__desc', text: doneCount === rows.length ? '全部打卡完成，很棒！' : '点右侧按钮快速打卡' }),
      ]),
      h('div', { class: 'chk-summary__ring', style: { '--rate': `${Math.round((doneCount / rows.length) * 100)}%` } }, [
        h('span', { text: `${Math.round((doneCount / rows.length) * 100)}%` }),
      ]),
    ]);

    const list = h('div', { class: 'chk-list' });
    rows.forEach((r) => {
      const c = r.checkin;
      list.appendChild(h('div', { class: 'chk-card' }, [
        h('button', {
          class: 'chk-card__main',
          onclick: () => { activeId = c.id; view = 'calendar'; month = monthKey(new Date()); render(); },
        }, [
          h('div', { class: 'chk-card__top' }, [
            h('span', { class: 'chk-card__title', text: c.title }),
            r.streak > 0
              ? h('span', { class: 'chk-card__streak', html: `${Icons.flame}<span>连续 ${r.streak} 天</span>` })
              : h('span', { class: 'chk-card__streak chk-card__streak--none', text: '暂无连续' }),
          ]),
          h('div', { class: 'chk-card__meta' }, [
            h('span', { text: `本月 ${r.monthChecked}/${r.monthElapsed} 天 · ${r.monthRate}%` }),
            h('span', { class: 'chk-card__dot', text: '·' }),
            h('span', { text: `累计 ${c.count} 次` }),
          ]),
          h('div', { class: 'chk-bar' }, [
            h('div', { class: 'chk-bar__fill', style: { width: `${Math.min(100, r.monthRate)}%` } }),
          ]),
        ]),
        h('button', {
          class: `chk-toggle${r.checkedToday ? ' chk-toggle--on' : ''}`,
          title: r.checkedToday ? '取消今日打卡' : '今日打卡',
          'aria-label': r.checkedToday ? '取消今日打卡' : '今日打卡',
          dataset: { checkinId: String(c.id), date: todayKey },
          onclick: async (e) => {
            e.stopPropagation();
            const added = await CheckinService.toggle(c.id, new Date());
            toast(added ? `已打卡：${c.title}` : `已取消：${c.title}`, added ? 'success' : 'info');
            render();
          },
        }, [
          h('span', { html: r.checkedToday ? Icons.check : Icons.plus }),
        ]),
      ]));
    });

    mount(root, [
      summaryCard,
      h('div', { class: 'section-title' }, [
        h('span', { text: '我的打卡项' }),
        h('button', { class: 'section-title__action', onclick: createCheckin }, '+ 新建'),
      ]),
      list,
    ]);
  }

  /* ---------------- 月历态 ---------------- */

  async function renderCalendar() {
    const c = await CheckinService.get(activeId);
    if (!c) { view = 'list'; render(); return; }

    const stats = c.monthStats(month);
    const [y, m] = month.split('-').map(Number);
    const todayKey = formatDate(new Date());

    const headerRow = h('div', { class: 'cal-head' }, [
      h('button', {
        class: 'icon-btn icon-btn--sm',
        title: '返回列表',
        'aria-label': '返回列表',
        html: Icons.back,
        onclick: () => { view = 'list'; render(); },
      }),
      h('div', { class: 'cal-head__title', text: c.title }),
      h('button', {
        class: 'icon-btn icon-btn--sm',
        title: '更多操作',
        'aria-label': '更多操作',
        html: Icons.edit,
        onclick: () => openMenu(c),
      }),
    ]);

    const monthNav = h('div', { class: 'cal-nav' }, [
      h('button', {
        class: 'cal-nav__btn',
        onclick: () => { month = shiftMonth(month, -1); render(); },
      }, h('span', { html: Icons.chevronLeft })),
      h('div', { class: 'cal-nav__center' }, [
        h('div', { class: 'cal-nav__month', text: `${y} 年 ${m} 月` }),
        h('div', { class: 'cal-nav__sub', text: `本月已打卡 ${stats.checked} 天 · 完成率 ${stats.rate}%` }),
      ]),
      h('button', {
        class: 'cal-nav__btn',
        onclick: () => { month = shiftMonth(month, 1); render(); },
      }, h('span', { html: Icons.chevronRight })),
    ]);

    // 月历网格：表头周一到周日 + 6 行日期
    const grid = h('div', { class: 'cal-grid' });
    ['一', '二', '三', '四', '五', '六', '日'].forEach((w) => {
      grid.appendChild(h('div', { class: 'cal-grid__wd', text: w }));
    });

    const first = new Date(y, m - 1, 1);
    // JS getDay(): 0=周日，转成周一起始的 0~6
    const lead = (first.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.appendChild(h('div', { class: 'cal-cell cal-cell--blank' }));

    stats.days.forEach((d) => {
      const cls = ['cal-cell'];
      if (d.checked) cls.push('cal-cell--checked');
      if (d.today) cls.push('cal-cell--today');
      if (d.future) cls.push('cal-cell--future');
      grid.appendChild(h('button', {
        class: cls.join(' '),
        dataset: { date: d.date, checked: d.checked ? '1' : '0' },
        disabled: d.future,
        title: d.future ? '还没到这一天' : (d.checked ? `${d.date} 已打卡，点击取消` : `${d.date} 未打卡，点击补打卡`),
        onclick: async () => {
          if (d.future) return;
          await CheckinService.toggle(c.id, d.date);
          render();
        },
      }, [
        h('span', { class: 'cal-cell__d', text: String(d.day) }),
        d.checked ? h('span', { class: 'cal-cell__mark', html: Icons.check }) : null,
      ]));
    });

    // 本月打卡日期趋势（当天是星期几无关，只展示「打了几天」的数字条）
    const statRow = h('div', { class: 'stat-row' }, [
      statBox('连续天数', `${c.streak()}`, '天'),
      statBox('本月打卡', `${stats.checked}`, '天'),
      statBox('完成率', `${stats.rate}`, '%'),
      statBox('历史最长', `${c.longestStreak()}`, '天'),
    ]);

    mount(root, [
      headerRow,
      monthNav,
      grid,
      h('div', { class: 'cal-legend' }, [
        h('span', { class: 'cal-legend__item' }, [h('i', { class: 'cal-legend__dot cal-legend__dot--on' }), h('span', { text: '已打卡' })]),
        h('span', { class: 'cal-legend__item' }, [h('i', { class: 'cal-legend__dot' }), h('span', { text: '未打卡' })]),
        h('span', { class: 'cal-legend__item' }, [h('i', { class: 'cal-legend__dot cal-legend__dot--future' }), h('span', { text: '未到日期' })]),
      ]),
      statRow,
      h('div', { class: 'cal-tip' }, [
        h('span', { html: Icons.info }),
        h('span', { text: '点击任意已过去的日期可补打卡或取消打卡。' }),
      ]),
    ]);

    // 今日快速打卡按钮（若本月就是当前月，且今天尚未打卡）
    if (todayKey.startsWith(month) && !c.isChecked(todayKey)) {
      root.appendChild(h('button', {
        class: 'btn btn--primary btn--block',
        style: { marginTop: '14px' },
        onclick: async () => { await CheckinService.toggle(c.id, new Date()); toast('已打卡', 'success'); render(); },
      }, `今天（${weekdayName(new Date())}）打卡`));
    }
  }

  /* ---------------- 交互 ---------------- */

  async function createCheckin() {
    const name = await promptDialog({
      title: '新建打卡项',
      placeholder: '例如：背单词 / 跑步 / 早睡',
      okText: '创建',
      required: true,
      requiredHint: '请给打卡项起个名字',
    });
    if (!name) return;
    try {
      await CheckinService.create(name);
      toast('已创建打卡项', 'success');
      view = 'list';
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openMenu(c) {
    const act = await actionSheet({
      title: c.title,
      actions: [
        { label: '重命名', value: 'rename' },
        { label: '删除打卡项', value: 'delete', danger: true },
      ],
    });
    if (act === 'rename') {
      const name = await promptDialog({
        title: '重命名',
        value: c.title,
        okText: '保存',
        required: true,
        requiredHint: '名字不能为空',
      });
      if (!name) return;
      await CheckinService.rename(c.id, name);
      toast('已重命名', 'success');
      render();
    } else if (act === 'delete') {
      const ok = await confirmDialog({
        title: '删除打卡项',
        message: `删除「${c.title}」会同时清除它的全部打卡记录，且不可撤销。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await CheckinService.remove(c.id);
      toast('已删除', 'success');
      view = 'list';
      render();
    }
  }

  render();
  return root;
}

/* ---------------- 小组件 ---------------- */

function statBox(label, value, unit) {
  return h('div', { class: 'stat-box' }, [
    h('div', { class: 'stat-box__value' }, [
      h('span', { text: value }),
      h('span', { class: 'stat-box__unit', text: unit }),
    ]),
    h('div', { class: 'stat-box__label', text: label }),
  ]);
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 轻量输入弹窗。dom.js 里只有 confirmDialog / actionSheet，
 * 这里补一个输入版，避免为了一个输入框引入额外依赖。
 *
 * v1.4.1：新增 multiline 选项。
 * 支付截图的 OCR 文字天然是多行的，用单行 <input> 根本粘不进去 ——
 * 这正是「图片识别时金额显示错乱」的隐形元凶之一。
 * multiline=true 时渲染 <textarea>，并放弃 Enter 提交（改由按钮 / Ctrl+Enter）。
 *
 * 🔴 v1.13.5 修正「返回值三态契约」——修的是用户 2026-09-22 报的
 *    「标注的可跳过的模块都不能跳过，一旦跳过就保存不了」。
 *
 *    改之前 `read()` 写的是 `input.value.trim() || null`，于是**留空确定**
 *    和**点取消**都 resolve `null`，调用方根本分不出来。那些「可跳过」的字段
 *    顺手写成 `if (due === null) return;`（本意是「取消就别记了」），
 *    结果用户老老实实留空跳过，也被当成取消 → **整笔账直接丢掉**。
 *
 *    现在三态分明，调用方按需判断：
 *      null       → 用户取消（取消 / Esc / 点遮罩 / 返回键）
 *      ''         → 用户**明确留空**（= 跳过这一项）
 *      其它字符串  → 用户填的内容
 *
 *    ⚠️ 因此 `if (!x) return;` 这种写法会把「跳过」也一起挡掉。
 *       只想拦取消，就必须写 `if (x === null) return;`。
 *       反过来，**必填项**请用 `required: true` —— 它会让弹窗自己拦住空提交，
 *       而不是等调用方 `return` 掉（那样是「点了没反应」，用户更懵）。
 */
/**
 * promptDialog —— 单输入框弹窗。**返回字符串**（或 null）。
 *
 * 🔴 返回值是「三态」，不是布尔：
 *    · `null` = 取消（取消按钮 / Esc / 点遮罩 / 返回键）
 *    · `''`   = 用户**明确留空**（= 跳过这一项）
 *    · 其它   = 用户填的内容
 *    调用方只想拦「取消」时必须写 `if (x === null) return;`，
 *    写 `if (!x)` 会把老实留空跳过的用户一起挡在门外，整笔账静默丢掉。
 *    必填项用 `required: true`，让弹窗自己就地提示。
 *
 * ⚠️ 需要「输入框 + 一个下拉选择」两栏的，用下面的 `promptDialogEx`，
 *    它的返回值是 `{ text, extra }`。**不要**把本函数的返回改成对象 ——
 *    全项目有 30 多处按字符串在用。
 */
export async function promptDialog(opts) {
  const r = await promptDialogEx(opts);
  return r === null ? null : r.text;
}

/**
 * promptDialogEx —— 比 promptDialog 多一个可选的「选择行」。
 *
 * 用途：账户页「充值」要一边填来源、一边选关联账户（用户 2026-09-23 第 3 条）。
 *
 * @param {object}   opts                    同 promptDialog
 * @param {object?}  opts.extra              可选的选择行
 * @param {string}   opts.extra.label        左侧标签，如「关联账户」
 * @param {string}   opts.extra.placeholder  还没选时显示什么
 * @param {Array}    opts.extra.options      [{ label, value }]
 * @param {any}      opts.extra.value        初始值
 * @param {boolean}  opts.extraRequired      true = 这一行必须主动选（见下）
 * @param {string}   opts.extraRequiredHint  没选就提交时的就地提示
 * @returns {Promise<{text:string, extra:any}|null>} null = 取消
 *
 * 🔴 `extra` 也是**三态**，和输入框一样别压成两态：
 *      `undefined` = 用户还没选（`extraRequired` 时会拦住提交）
 *      其它        = 选中的值（**包括**那个代表「不选」的哨兵值）
 *    区分方式是：调用方**不传** `extra.value` 就是「未选」，
 *    传了（哪怕是哨兵值）就是「已选」。
 *
 * ⚠️ 选项的 `value` **不许用 `null`** —— `actionSheet` 用 `null` 表示「取消」，
 *    选一个值为 null 的选项会和取消混淆。要表达「不选」请用一个非空哨兵，
 *    比如 `'__none'`（账户页就是这么用的）。
 */
export function promptDialogEx({
  title, message = '', value = '', placeholder = '', okText = '确定', multiline = false,
  required = false, requiredHint = '这一项不能为空', extra = null,
  extraRequired = false, extraRequiredHint = '请选择一项',
}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea', { class: 'input input--multiline', placeholder, rows: 6 })
      : h('input', { class: 'input', value, placeholder });
    if (multiline) input.value = value;

    const hint = h('div', { class: 'modal__hint', style: { display: 'none' } });
    // 留空 → ''（明确的「跳过」），不是 null（那是「取消」）
    const read = () => input.value.trim();
    const close = (val) => {
      overlay.remove();
      popOverlay(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };

    /* ---- 可选的选择行 ---- */
    // `undefined` = 还没选；null = 明确选了「不选」。
    // 传了 `extra.value` 就用它（`null` 也算「已选」，只是选的是「不选」那一项）。
    let extraValue = extra ? ('value' in extra ? extra.value : undefined) : null;
    let extraRow = null;
    /** 选到某一项了吗（拿选项表比对，而不是看值真假 —— 哨兵值也是有效选择） */
    const extraChosen = () => !!extra
      && (extra.options || []).some((o) => String(o.value) === String(extraValue));
    if (extra) {
      const text = h('span', { class: 'field-pick__v' });
      const paintExtra = () => {
        const hit = (extra.options || []).find((o) => String(o.value) === String(extraValue));
        text.textContent = hit ? hit.label : (extra.placeholder || '请选择');
        text.classList.toggle('field-pick__v--empty', !hit);
        // 必选但还没选 → 用和记账表单账户行同一种「待办」样式（虚线 + 主色），
        // 让用户一眼看出「这一行还欠我一次点击」
        extraRow?.classList.toggle('field-pick--todo', !!extraRequired && !hit);
      };
      extraRow = h('button', {
        class: 'field-pick', type: 'button', dataset: { action: 'extra-pick' },
      }, [
        h('span', { class: 'field-pick__k', text: extra.label }),
        text,
        h('span', { class: 'field-pick__arrow', html: Icons.chevronRight }),
      ]);
      extraRow.addEventListener('click', async () => {
        // 选完回到本弹窗 —— actionSheet 会叠在它上面，关掉后本弹窗还在
        const act = await actionSheet({ title: extra.label, actions: extra.options || [] });
        if (act === null) return;   // 取消选，保持原状
        extraValue = act;
        paintExtra();
        hint.style.display = 'none';
      });
      // ⚠️ 必须在 extraRow 建好之后再画一次，否则第一遍的 todo 类挂不上去
      paintExtra();
    }

    // required 模式下，空内容一律不关闭弹窗，并就地提示（避免和「取消」混淆）
    const submit = () => {
      const v = read();
      if (required && !v) {
        hint.textContent = requiredHint;
        hint.style.display = '';
        input.focus();
        return;
      }
      // 必选的选择行：没主动选过就不给提交。
      // 🔴 拦在**这里**（就地提示 + 把那一行闪一下），不要让调用方 return ——
      //    调用方 return 就是「点了保存没反应」，用户根本不知道哪儿没填。
      if (extraRequired && !extraChosen()) {
        hint.textContent = extraRequiredHint;
        hint.style.display = '';
        extraRow?.classList.add('field-pick--shake');
        setTimeout(() => extraRow?.classList.remove('field-pick--shake'), 700);
        return;
      }
      close(extra ? { text: v, extra: extraValue } : { text: v });
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      // 多行模式下 Enter 用来换行，只有 Ctrl / Cmd + Enter 才提交
      if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) submit();
    };
    input.addEventListener('input', () => { hint.style.display = 'none'; });
    const overlay = h('div', { class: 'modal-overlay' }, [
      h('div', { class: 'modal' }, [
        h('div', { class: 'modal__title', text: title }),
        message ? h('div', { class: 'modal__body', text: message }) : null,
        // 选择行放在输入框**上面**（用户原话：「上面多加一个关联账户的选项」）
        extraRow,
        h('div', { style: { margin: '12px 0 4px' } }, input),
        hint,
        h('div', { class: 'modal__actions' }, [
          h('button', { class: 'btn btn--ghost', onclick: () => close(null) }, '取消'),
          h('button', { class: 'btn btn--primary', onclick: submit }, okText),
        ]),
      ]),
    ]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // 返回键 = 点「取消」（见 dom.js 的浮层栈说明）
    pushOverlay(overlay, () => close(null));
    setTimeout(() => input.focus(), 30);
  });
}

export default CheckinView;
