/**
 * todo_view.js —— 待办子视图：任务 / 想要（v1.4.0）
 *
 * 用户诉求：
 *   1. 「想要」与「任务」两类都做成备忘录式的清单，可勾选表示完成
 *   2. 已完成的事项**沉淀到最下面并折叠**，不干扰未完成的主线
 *   3. 两类要用**折叠分组或不同颜色**明确区分
 *
 * 设计取舍：颜色 + 分组折叠**两个都用**。
 *   - 颜色：任务=蓝、想要=橙，扫一眼就能认出这是哪类，卡片左侧还有色条
 *   - 分组折叠：未完成区按「任务 / 想要」两个可折叠分区陈列；
 *     已完成整体沉到最下面的「已完成」折叠区（默认收起）
 * 只用颜色不折叠 → 两类混在一起，条目多了还是乱；
 * 只用折叠不上色 → 每次都要展开才知道是什么类型。两者叠加才既快又清。
 */

import { h, mount, toast, confirmDialog, actionSheet } from '../../utils/dom.js';
import { Icons } from '../../widgets/icons.js';
import TodoService from '../../services/todo_service.js';
import { TODO_KIND, TODO_KIND_META, TODO_KINDS } from '../../models/todo.js';
import { promptDialog } from './checkin_view.js';
import { formatDate, parseDateInput } from '../../utils/date_utils.js';

/** 折叠状态在视图会话内保持（不落库，刷新页面回到默认展开） */
const collapsed = {
  [TODO_KIND.TASK]: false,
  [TODO_KIND.WANT]: false,
  done: true,      // 已完成默认收起 —— 这正是「沉淀到最下面折叠」的诉求
};

export function TodoView(ctx) {
  const root = h('div', { class: 'app-body' });
  const openForm = { kind: TODO_KIND.TASK };

  /** 同一类型的高亮色，供卡片色条 / 徽标复用 */
  function kindOf(kind) { return TODO_KIND_META[kind] || TODO_KIND_META[TODO_KIND.TASK]; }

  async function render() {
    const board = await TodoService.board();
    const { activeTasks, activeWants, done, stats } = board;

    const nodes = [];

    // 顶部汇总 + 快速新建
    nodes.push(h('div', { class: 'todo-summary' }, [
      h('div', { class: 'todo-summary__stats' }, [
        statPill('待完成', stats.active, '#2563eb'),
        statPill('已完成', stats.done, '#16a34a'),
        stats.overdue ? statPill('已逾期', stats.overdue, '#dc2626') : null,
      ]),
      h('div', { class: 'todo-summary__actions' }, [
        h('button', {
          class: 'todo-quick todo-quick--task',
          dataset: { action: 'new-task' },
          onclick: () => openCreate(TODO_KIND.TASK),
        }, [h('span', { text: '＋' }), h('span', { text: '任务' })]),
        h('button', {
          class: 'todo-quick todo-quick--want',
          dataset: { action: 'new-want' },
          onclick: () => openCreate(TODO_KIND.WANT),
        }, [h('span', { text: '＋' }), h('span', { text: '想要' })]),
      ]),
    ]));

    // 空态不再单独占一屏：
    // 用户要的是「没有任务时直接看到管理界面」，而不是先看一个空状态页再点按钮。
    // 所以汇总卡 / 两个分区 / 已完成折叠区**始终渲染**，
    // 没有待办时分区内部给出轻量占位（真正的行动入口就在上方的「＋任务 / ＋想要」）。
    // 首次零条目时在汇总卡下方补一排引导按钮，兼容既有 E2E 断言。
    if (stats.total === 0) {
      nodes.push(h('div', { class: 'todo-empty-actions todo-empty-actions--inline' }, [
        h('button', {
          class: 'btn btn--primary',
          onclick: () => openCreate(TODO_KIND.TASK),
        }, '新建任务'),
        h('button', {
          class: 'btn btn--ghost todo-btn--want',
          onclick: () => openCreate(TODO_KIND.WANT),
        }, '新建想要'),
      ]));
    }

    // 未完成：按类型分两个可折叠分区
    nodes.push(kindSection(TODO_KIND.TASK, activeTasks));
    nodes.push(kindSection(TODO_KIND.WANT, activeWants));

    // 已完成：沉到最下面 + 折叠（默认收起）
    nodes.push(doneSection(done));

    mount(root, nodes);
  }

  /** 一个类型分区的完整节点（标题 + 折叠 + 列表） */
  function kindSection(kind, items) {
    const meta = kindOf(kind);
    const isCollapsed = collapsed[kind];
    const wrap = h('div', { class: `todo-section todo-section--${kind}` });

    const head = h('button', {
      class: 'todo-section__head',
      dataset: { kind },
      onclick: () => { collapsed[kind] = !collapsed[kind]; render(); },
    }, [
      h('span', { class: 'todo-section__dot', style: { background: meta.color } }),
      h('span', { class: 'todo-section__label', text: meta.label }),
      h('span', { class: 'todo-section__count', text: `${items.length}` }),
      h('span', {
        class: `todo-section__chev${isCollapsed ? ' todo-section__chev--closed' : ''}`,
        html: Icons.chevronRight,
      }),
    ]);
    wrap.appendChild(head);

    if (isCollapsed) return wrap;

    if (items.length === 0) {
      wrap.appendChild(h('div', {
        class: 'todo-section__empty',
        text: kind === TODO_KIND.TASK
          ? '暂无任务。点上方「＋任务」记一件要做的事。'
          : '暂无想要。点上方「＋想要」记一件想做的事。',
      }));
      return wrap;
    }

    const list = h('div', { class: 'todo-list' });
    items.forEach((t) => list.appendChild(itemRow(t)));
    wrap.appendChild(list);
    return wrap;
  }

  /** 已完成折叠区 */
  function doneSection(items) {
    const isCollapsed = collapsed.done;
    const wrap = h('div', { class: 'todo-section todo-section--done' });

    wrap.appendChild(h('button', {
      class: 'todo-section__head todo-section__head--done',
      dataset: { kind: 'done' },
      onclick: () => { collapsed.done = !collapsed.done; render(); },
    }, [
      h('span', { class: 'todo-section__dot', style: { background: '#16a34a' } }),
      h('span', { class: 'todo-section__label', text: '已完成' }),
      h('span', { class: 'todo-section__count', text: `${items.length}` }),
      items.length
        ? h('span', {
          class: 'todo-section__clear',
          dataset: { action: 'clear-done' },
          onclick: (e) => { e.stopPropagation(); clearDone(); },
        }, '清空')
        : null,
      h('span', {
        class: `todo-section__chev${isCollapsed ? ' todo-section__chev--closed' : ''}`,
        html: Icons.chevronRight,
      }),
    ]));

    if (isCollapsed) return wrap;

    if (items.length === 0) {
      wrap.appendChild(h('div', { class: 'todo-section__empty', text: '还没有完成的事项，勾选后会沉淀到这里。' }));
      return wrap;
    }

    const list = h('div', { class: 'todo-list' });
    items.forEach((t) => list.appendChild(itemRow(t)));
    wrap.appendChild(list);
    return wrap;
  }

  /** 单条待办 */
  function itemRow(t) {
    const meta = kindOf(t.kind);
    const cls = ['todo-item', `todo-item--${t.kind}`];
    if (t.done) cls.push('todo-item--done');
    if (t.overdue) cls.push('todo-item--overdue');

    return h('div', {
      class: cls.join(' '),
      dataset: { todoId: String(t.id), kind: t.kind },
      style: { '--todo-color': meta.color },
    }, [
      // 左侧类型色条：不展开也能一眼看出是任务还是想要
      h('span', { class: 'todo-item__bar' }),
      h('button', {
        class: `todo-check${t.done ? ' todo-check--on' : ''}`,
        title: t.done ? '标记为未完成' : '标记为已完成',
        'aria-label': t.done ? '标记为未完成' : '标记为已完成',
        dataset: { action: 'toggle', todoId: String(t.id) },
        onclick: async (e) => {
          e.stopPropagation();
          const after = await TodoService.toggle(t.id);
          toast(after.done ? `已完成：${after.title}` : `已恢复：${after.title}`,
            after.done ? 'success' : 'info');
          render();
        },
      }, h('span', { html: Icons.check })),

      h('button', {
        class: 'todo-item__main',
        onclick: () => openMenu(t),
      }, [
        h('span', { class: 'todo-item__title', text: t.title }),
        h('span', { class: 'todo-item__meta' }, [
          h('span', {
            class: 'todo-item__kind',
            style: { color: meta.color, background: `${meta.color}14` },
            text: `${meta.icon} ${meta.label}`,
          }),
          t.due
            ? h('span', {
              class: `todo-item__due${t.overdue ? ' todo-item__due--overdue' : ''}${t.dueToday ? ' todo-item__due--today' : ''}`,
              text: t.dueLabel,
            })
            : null,
        ]),
      ]),
    ]);
  }

  /* ---------------- 交互 ---------------- */

  async function openCreate(kind) {
    const meta = kindOf(kind);
    openForm.kind = kind;
    const title = await promptDialog({
      title: `新建${meta.label}`,
      message: meta.hint,
      placeholder: kind === TODO_KIND.TASK ? '例如：交实验报告' : '例如：看那部新上映的电影',
      okText: '添加',
      required: true,
      requiredHint: `请填写${meta.label}内容`,
    });
    if (!title) return;
    try {
      await TodoService.create({ title, kind });
      collapsed[kind] = false;   // 新建后确保能看到新条目
      toast(`已添加${meta.label}`, 'success');
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function openMenu(t) {
    const act = await actionSheet({
      title: t.title,
      actions: [
        { label: t.done ? '标记为未完成' : '标记为已完成', value: 'toggle' },
        { label: '改类型（任务 / 想要）', value: 'kind' },
        { label: '设置截止日期', value: 'due' },
        { label: '编辑标题', value: 'rename' },
        { label: '删除', value: 'delete', danger: true },
      ],
    });
    if (!act) return;

    if (act === 'toggle') {
      await TodoService.toggle(t.id);
      render();
    } else if (act === 'kind') {
      const next = t.kind === TODO_KIND.TASK ? TODO_KIND.WANT : TODO_KIND.TASK;
      const todo = await TodoService.get(t.id);
      todo.kind = next;
      await TodoService.update(todo);
      toast(`已改为「${kindOf(next).label}」`, 'success');
      render();
    } else if (act === 'due') {
      // 可跳过：留空 = 不设截止（返回 ''）；只有取消才返回 null。
      const dueRaw = await promptDialog({
        title: '截止日期',
        message: '2026-09-20、2026.9.20、2026/9/20 都认。留空表示不设截止。',
        value: t.due || '',
        placeholder: '例如：2026-09-20（留空即不设）',
        okText: '保存',
      });
      if (dueRaw === null) return;
      const due = dueRaw ? parseDateInput(dueRaw) : '';
      if (dueRaw && !due) { toast('日期看不懂，试试 2026-09-20 或 2026.9.20', 'warn'); return; }
      const todo = await TodoService.get(t.id);
      todo.due = due;   // parseDateInput 已经规范化成 YYYY-MM-DD，模型校验不会再挡
      await TodoService.update(todo);
      toast('已更新截止日期', 'success');
      render();
    } else if (act === 'rename') {
      const title = await promptDialog({
        title: '编辑标题',
        value: t.title,
        okText: '保存',
        required: true,
        requiredHint: '标题不能为空',
      });
      if (!title) return;
      const todo = await TodoService.get(t.id);
      todo.title = title;
      await TodoService.update(todo);
      toast('已保存', 'success');
      render();
    } else if (act === 'delete') {
      const ok = await confirmDialog({
        title: '删除待办',
        message: `确定删除「${t.title}」吗？此操作不可撤销。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      await TodoService.remove(t.id);
      toast('已删除', 'success');
      render();
    }
  }

  async function clearDone() {
    const n = (await TodoService.list()).filter((t) => t.done).length;
    if (!n) return;
    const ok = await confirmDialog({
      title: '清空已完成',
      message: `将删除 ${n} 条已完成的待办，此操作不可撤销。`,
      okText: '清空',
      danger: true,
    });
    if (!ok) return;
    const removed = await TodoService.clearDone();
    toast(`已清空 ${removed} 条`, 'success');
    render();
  }

  render().then(() => {
    // 抽屉深链：action:'create' 直接弹「新建任务」
    if (ctx.params?.action === 'create') openCreate(TODO_KIND.TASK);
  });
  return root;
}

/* ---------------- 小组件 ---------------- */

function statPill(label, value, color) {
  return h('div', { class: 'todo-stat', style: { '--pill-color': color } }, [
    h('span', { class: 'todo-stat__value', text: String(value) }),
    h('span', { class: 'todo-stat__label', text: label }),
  ]);
}

/** 今天（供外部/E2E 参考，避免 tree-shaking 误删 formatDate 依赖） */
export const todayKey = () => formatDate(new Date());

export default TodoView;
