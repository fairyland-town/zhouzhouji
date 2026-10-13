/**
 * todo_service.js —— 待办业务逻辑（v1.4.0）
 *
 * UI 只跟这里打交道，不直接读 store。
 * 提供「按类型分组 + 已完成折叠」所需的全部数据形态。
 */

import DatabaseService from './database_service.js';
import { Todo, TODO_KIND, sortTodos, summarizeTodos } from '../models/todo.js';

export const TodoService = {
  /** 全部待办，已排好序（未完成在前，已完成沉底） */
  async list() {
    const all = await DatabaseService.getTodos();
    return sortTodos(all);
  },

  async get(id) {
    return DatabaseService.getTodoById(id);
  },

  create({ title, kind = TODO_KIND.TASK, due = '' }) {
    return DatabaseService.addTodo(new Todo({ title, kind, due }));
  },

  update(todo) {
    return DatabaseService.updateTodo(todo);
  },

  remove(id) {
    return DatabaseService.removeTodo(id);
  },

  /** 切换完成，返回切换后的实例（UI 用它决定提示语与动画） */
  toggle(id) {
    return DatabaseService.toggleTodo(id);
  },

  /**
   * 列表视图数据：未完成（按类型分成两组）+ 已完成的集合。
   * 已完成的那一份供 UI 折叠到最下面。
   */
  async board() {
    const all = await this.list();
    const active = all.filter((t) => !t.done);
    const done = all.filter((t) => t.done);
    return {
      all,
      active,
      done,
      // 未完成再按类型分，便于「任务 / 想要」分区展示
      activeTasks: active.filter((t) => t.kind === TODO_KIND.TASK),
      activeWants: active.filter((t) => t.kind === TODO_KIND.WANT),
      stats: summarizeTodos(all),
    };
  },

  /** 清空所有已完成的待办，返回删除条数 */
  async clearDone() {
    const done = (await this.list()).filter((t) => t.done);
    for (const t of done) await DatabaseService.removeTodo(t.id);
    return done.length;
  },
};

export default TodoService;
