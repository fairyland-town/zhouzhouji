/**
 * todo.js —— 待办数据模型（v1.4.0）
 *
 * 一个模型承载两种形态，靠 kind 区分：
 *   task  「任务」 —— 有明确要做/要交的事（写作业、交材料、开会）
 *   want  「想要」 —— 想做的事、想买的东西（想看电影、想买球鞋）
 *
 * 为什么合一个模型而不是两张表：
 *   两种形态的字段与操作完全一致（标题 / 完成 / 完成时间 / 可选截止日），
 *   差别只在语义与展示，拆两张表会带来两套 CRUD、两套 UI，得不偿失。
 *   未来若要给 want 加「预算」、给 task 加「优先级」，再加字段即可。
 *
 * 数据结构（与 object store: todos 对应）：
 *   id          INTEGER PRIMARY KEY AUTOINCREMENT
 *   title       TEXT NOT NULL
 *   kind        TEXT NOT NULL      'task' | 'want'
 *   done        INTEGER NOT NULL   0 未完成 | 1 已完成
 *   due         TEXT               可选截止日期 YYYY-MM-DD
 *   done_at     TEXT               完成时间（未完成时为空串）
 *   created_at  TEXT NOT NULL
 *   sort        INTEGER            排序权重，数值越小越靠前
 */

import { formatDate, formatDateTime } from '../utils/date_utils.js';

/** 待办类型 */
export const TODO_KIND = {
  TASK: 'task',   // 任务
  WANT: 'want',   // 想要
};

/**
 * 类型的展示元数据。
 * 两种类型用**不同颜色**区分（任务蓝、想要橙），与「折叠分组」形成双重区分，
 * 用户既能靠颜色扫一眼认出，也能靠折叠区把已完成 / 不同类型收纳起来。
 */
export const TODO_KIND_META = {
  [TODO_KIND.TASK]: {
    id: TODO_KIND.TASK,
    label: '任务',
    icon: '📋',
    color: '#2563eb',
    hint: '要做的事，比如「交实验报告」「开组会」',
  },
  [TODO_KIND.WANT]: {
    id: TODO_KIND.WANT,
    label: '想要',
    icon: '💫',
    color: '#ea580c',
    hint: '想做的事，比如「想看那部电影」「想买双球鞋」',
  },
};

export const TODO_KINDS = [TODO_KIND.TASK, TODO_KIND.WANT];

export function getTodoKindMeta(kind) {
  return TODO_KIND_META[kind] || TODO_KIND_META[TODO_KIND.TASK];
}

export class Todo {
  constructor({
    id = null,
    title = '',
    kind = TODO_KIND.TASK,
    done = false,
    due = '',
    doneAt = '',
    createdAt = null,
    sort = 0,
  } = {}) {
    this.id = id;
    this.title = String(title || '').trim();
    this.kind = TODO_KINDS.includes(kind) ? kind : TODO_KIND.TASK;
    this.done = Boolean(done);
    this.due = String(due || '').trim();
    this.doneAt = this.done ? String(doneAt || '') : '';
    this.createdAt = createdAt == null ? '' : String(createdAt);
    this.sort = Number.isFinite(Number(sort)) ? Number(sort) : 0;
  }

  get kindMeta() { return getTodoKindMeta(this.kind); }

  /** 截止日期是否已过（未完成才算逾期） */
  get overdue() {
    if (this.done || !this.due) return false;
    return this.due < formatDate(new Date());
  }

  /** 截止日期是否为今天 */
  get dueToday() {
    return !this.done && this.due === formatDate(new Date());
  }

  /** 形如「今天 / 明天 / 9月20日 / 已逾期 3 天」的截止日展示串 */
  get dueLabel() {
    if (!this.due) return '';
    const today = formatDate(new Date());
    if (this.due === today) return '今天';
    const t = new Date(today.replace(/-/g, '/'));
    const d = new Date(this.due.replace(/-/g, '/'));
    const gap = Math.round((d - t) / 86400000);
    if (gap === 1) return '明天';
    if (gap === -1) return '昨天';
    if (gap < 0) return `已逾期 ${-gap} 天`;
    if (gap > 0 && gap <= 7) return `${gap} 天后`;
    const [, m, dd] = this.due.split('-');
    return `${Number(m)}月${Number(dd)}日`;
  }

  /** 完成状态切换（返回自身，便于链式） */
  toggleDone(now = new Date()) {
    this.done = !this.done;
    this.doneAt = this.done ? formatDateTime(now) : '';
    return this;
  }

  validate() {
    const errors = [];
    if (!this.title) errors.push('标题不能为空');
    if (this.title.length > 60) errors.push('标题不能超过 60 个字');
    if (!TODO_KINDS.includes(this.kind)) errors.push('类型只能是任务或想要');
    if (this.due && !/^\d{4}-\d{2}-\d{2}$/.test(this.due)) errors.push('截止日期格式不正确');
    return { ok: errors.length === 0, errors };
  }

  toRecord() {
    return {
      id: this.id,
      title: this.title,
      kind: this.kind,
      done: this.done ? 1 : 0,
      due: this.due,
      done_at: this.doneAt,
      created_at: this.createdAt,
      sort: this.sort,
    };
  }

  static fromRecord(rec) {
    if (!rec) return null;
    return new Todo({
      id: rec.id,
      title: rec.title,
      kind: rec.kind,
      done: rec.done === 1 || rec.done === true,
      due: rec.due,
      doneAt: rec.done_at,
      createdAt: rec.created_at,
      sort: rec.sort,
    });
  }
}

/**
 * 给待办列表排序：未完成在前，再按「有截止日 → 早的在前」，最后按创建时间。
 * 已完成的整体沉底（UI 再折叠起来）。
 */
export function sortTodos(list) {
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.done && b.done) {
      // 已完成的按完成时间倒序（最近完成的在上）
      return String(b.doneAt).localeCompare(String(a.doneAt));
    }
    // 未完成：逾期/有截止日的排前面
    if (a.due && b.due) return a.due.localeCompare(b.due);
    if (a.due) return -1;
    if (b.due) return 1;
    return String(a.createdAt).localeCompare(String(b.createdAt));
  });
}

/** 汇总一组待办：总数 / 未完成 / 已完成 / 逾期 / 各类型计数 */
export function summarizeTodos(list) {
  const out = {
    total: list.length,
    active: 0,
    done: 0,
    overdue: 0,
    task: 0,
    want: 0,
    taskDone: 0,
    wantDone: 0,
  };
  for (const t of list) {
    if (t.done) out.done++;
    else out.active++;
    if (t.overdue) out.overdue++;
    if (t.kind === TODO_KIND.TASK) { out.task++; if (t.done) out.taskDone++; }
    if (t.kind === TODO_KIND.WANT) { out.want++; if (t.done) out.wantDone++; }
  }
  return out;
}

export default Todo;
