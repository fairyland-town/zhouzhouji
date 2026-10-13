/**
 * dom.js —— 极简 DOM 辅助（避免引入任何第三方依赖，保证离线可用）
 */

/** 创建元素：h('div', {class:'x', onclick:fn}, [children | 'text']) */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') applyStyle(el, v);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  appendChildren(el, children);
  return el;
}

/**
 * 应用样式对象。
 * 注意：CSS 自定义属性（--xxx）无法通过 Object.assign(el.style, {...}) 生效，
 * 因为 style 对象只认驼峰式属性名，必须走 setProperty()。
 */
function applyStyle(el, styles) {
  for (const [k, v] of Object.entries(styles || {})) {
    if (v === null || v === undefined) continue;
    if (k.startsWith('--')) el.style.setProperty(k, String(v));
    else el.style[k] = v;
  }
}

function appendChildren(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    children.forEach((c) => appendChildren(el, c));
    return;
  }
  if (children instanceof Node) { el.appendChild(children); return; }
  el.appendChild(document.createTextNode(String(children)));
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------------- v1.13.0 浮层栈 ---------------- */

/**
 * 打开中的浮层栈（后进先出）。
 *
 * 存在的唯一理由是**安卓返回键**：返回键应该先关掉最上层的弹窗，
 * 而不是把整个页面退掉（用户原话：「整个软件没有返回功能…滑两次就直接退出软件」）。
 *
 * 🔴 `dismiss` 必须是各弹窗自己的「取消」路径，**绝不能**写成 `overlay.remove()`。
 *    直接摘 DOM 的话，`await confirmDialog(...)` 那个 Promise 永远不会 resolve，
 *    调用方会静默卡在 await 上（比如 openMenu 后续所有分支都不执行），
 *    而且没有任何报错 —— 这类 bug 极难定位。
 */
const overlayStack = [];

/** 登记一个浮层。el 用于识别，dismiss 用于「走正常取消流程」地关掉它 */
export function pushOverlay(el, dismiss) {
  overlayStack.push({ el, dismiss });
}

/** 注销（浮层自己关闭时调用） */
export function popOverlay(el) {
  const i = overlayStack.findIndex((o) => o.el === el);
  if (i >= 0) overlayStack.splice(i, 1);
}

/** 当前是否有浮层打开 */
export function hasOverlay() {
  return overlayStack.length > 0;
}

/**
 * 关掉最上层的浮层。
 * @returns {boolean} 是否真的关掉了一个
 */
export function dismissTopOverlay() {
  // 顺手丢掉「DOM 已被别处摘掉」的僵尸记录，避免返回键白按一次
  while (overlayStack.length && !overlayStack[overlayStack.length - 1].el.isConnected) {
    overlayStack.pop();
  }
  const top = overlayStack[overlayStack.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

/**
 * 清空栈（只清记录，不动 DOM）。
 * 路由切换时用：那边会把 .modal-overlay 整批摘掉，栈里对应的记录必须跟着作废。
 */
export function resetOverlayStack() {
  overlayStack.length = 0;
}


/**
 * 极简 Toast
 *
 * 🔴 v1.13.5：加了「兜底文案」。
 *    调用方大量写着 `catch (err) { toast(err.message, 'error') }`，
 *    但 `err.message` **不保证是字符串**：
 *      · 抛出的可能根本不是 Error（Capacitor 插件、IndexedDB 的 DOMException、
 *        `backup_service` 里 `throw lastErr || ...` 的 lastErr）；
 *      · `new Error()` 的 message 默认就是**空串**。
 *    这两种情况直接塞进 `textContent` 的结果是：
 *      · undefined → 用户看到写着「undefined」的气泡
 *      · ''        → 用户看到**一个空白气泡**
 *    空白气泡比报错更糟 —— 它看起来就是「点了没反应」，
 *    而用户根本无从判断到底成没成。所以这里保证**永远有字**。
 */
const TOAST_FALLBACK = {
  error: '操作失败，请重试',
  warn: '请检查填写的内容',
  success: '已完成',
  info: '已完成',
};

let toastTimer = null;
export function toast(message, type = 'info') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.className = `toast toast--${type} is-visible`;
  box.textContent = String(message ?? '').trim() || TOAST_FALLBACK[type] || TOAST_FALLBACK.info;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.className = 'toast'; }, 2400);
}

/** 确认弹窗（Promise<boolean>） */
export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const close = (val) => {
      overlay.remove();
      popOverlay(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(false); };

    const overlay = h('div', { class: 'modal-overlay' }, [
      h('div', { class: 'modal' }, [
        h('div', { class: 'modal__title', text: title }),
        message ? h('div', { class: 'modal__body', text: message }) : null,
        h('div', { class: 'modal__actions' }, [
          h('button', { class: 'btn btn--ghost', onclick: () => close(false) }, cancelText),
          h('button', {
            class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`,
            onclick: () => close(true),
          }, okText),
        ]),
      ]),
    ]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // 返回键先关它（等价于点「取消」），而不是退掉整个页面
    pushOverlay(overlay, () => close(false));
  });
}

/** 底部动作面板，返回 Promise<string|null> */
export function actionSheet({ title, message, actions }) {
  return new Promise((resolve) => {
    const close = (val) => { overlay.remove(); popOverlay(overlay); resolve(val); };
    const overlay = h('div', { class: 'modal-overlay modal-overlay--bottom' }, [
      h('div', { class: 'sheet' }, [
        h('div', { class: 'sheet__grabber' }),
        title ? h('div', { class: 'sheet__title', text: title }) : null,
        message ? h('div', { class: 'sheet__note', text: message }) : null,
        // 🔴 v1.13.8：选项列表必须包在可滚动的 `.sheet__list` 里。
        //    在此之前所有选项是 `.sheet` 的直接子节点，而 `.sheet` 既没有
        //    max-height 也不滚动 —— 选项一多（比如「账户 → 全部流水」，
        //    最多 30 条 × 46px ≈ 1380px）整张面板就会长到屏幕之外，
        //    顶部被裁掉、且**怎么滑都不动**（用户 2026-10-13 反馈
        //    「查看全部流水的时候显示不完全，不能滚动查看」）。
        //    现在：标题/说明固定在顶部，只有列表滚动，「取消」常驻底部。
        h('div', { class: 'sheet__list' }, actions.map((a) => h('button', {
          class: `sheet__item${a.danger ? ' sheet__item--danger' : ''}`,
          onclick: () => close(a.value),
        }, a.label))),
        h('button', { class: 'sheet__item sheet__item--cancel', onclick: () => close(null) }, '取消'),
      ]),
    ]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.body.appendChild(overlay);
    // 返回键 = 点「取消」
    pushOverlay(overlay, () => close(null));
  });
}
