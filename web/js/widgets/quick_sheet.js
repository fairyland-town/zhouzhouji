/**
 * quick_sheet.js —— 「快速记录」底部抽屉（v1.6.0）
 *
 * 参考「生活流」的「嗨，想要归纳什么？」抽屉：
 *   ① 毛玻璃面板 + 顶部把手，从底部整块升起
 *   ② 上半区 2×2 彩色玻璃动作卡（有图标底座 + 标题 + 副标题）
 *   ③ 细分割线
 *   ④ 下半区 2×2 轻量功能行（只有图标 + 标题 + 副标题，无底座）
 *   ⑤ 底部一个居中的「取消」
 *
 * 为什么做成独立 widget 而不是塞进 main.js：
 *   交互形态是 Promise（等用户选一个动作再执行），
 *   和 actionSheet 同源但视觉复杂得多，需要自己的样式命名空间
 *   （.qsheet-*），避免污染通用 sheet 样式。
 *
 * 注意：所有条目都走 ctx.go(route, params) 深链到既有页面，
 * **不新增任何业务逻辑** —— 抽屉只是入口的重新编排。
 */

import { h, pushOverlay, popOverlay } from '../utils/dom.js';
import { Icons } from './icons.js';

/**
 * 上半区：四张彩色玻璃动作卡
 * tint 对应 style.css 里的 --tint-* 渐变底座
 */
const PRIMARY_ACTIONS = [
  {
    key: 'ocr',
    icon: 'camera',
    iconBg: 'var(--tint-blue)',
    iconColor: '#2563eb',
    title: '识图记账',
    desc: '截图 / 订单 OCR',
  },
  {
    key: 'entry',
    icon: 'wallet',
    iconBg: 'var(--tint-green)',
    iconColor: '#15803d',
    title: '记一笔',
    desc: '手动填写金额',
  },
  {
    key: 'account',
    icon: 'creditCard',
    iconBg: 'var(--tint-violet)',
    iconColor: '#6d28d9',
    title: '新增账户',
    desc: '饭卡 / 银行卡',
  },
  {
    key: 'todo',
    icon: 'list',
    iconBg: 'var(--tint-amber)',
    iconColor: '#b45309',
    title: '新建待办',
    desc: '任务 / 想要清单',
  },
];

/** 下半区：轻量功能行 */
const SECONDARY_ACTIONS = [
  { key: 'checkin', icon: 'checkCircle', color: '#2563eb', title: '去打卡', desc: '记今天做了什么' },
  { key: 'week', icon: 'calendar', color: '#6d28d9', title: '看周历', desc: '本周活动一览' },
  { key: 'todoList', icon: 'target', color: '#b45309', title: '待办清单', desc: '勾掉已完成的事' },
  { key: 'paste', icon: 'wand', color: '#0e7490', title: '粘贴通知', desc: '自动提取活动信息' },
];

/* ---------------- 动作 → 路由映射 ---------------- */

/** 把动作 key 翻译成一次 ctx.go() 调用 */
function dispatch(ctx, key) {
  switch (key) {
    case 'ocr':
      // 记账页 + 自动展开图片识别流程
      ctx.go('record', { tab: 'ledger', action: 'ocr' });
      break;
    case 'entry':
      ctx.go('record', { tab: 'ledger', action: 'entry' });
      break;
    case 'account':
      ctx.go('record', { tab: 'account', action: 'create' });
      break;
    case 'todo':
      ctx.go('record', { tab: 'todo', action: 'create' });
      break;
    case 'checkin':
      ctx.go('record', { tab: 'checkin' });
      break;
    case 'todoList':
      ctx.go('record', { tab: 'todo' });
      break;
    case 'week':
      ctx.go('week');
      break;
    case 'paste':
      ctx.go('add', { tab: 'paste' });
      break;
    default:
      break;
  }
}

/**
 * 打开快速记录抽屉。
 * @returns {Promise<string|null>} 选中的动作 key；取消返回 null
 */
export function quickSheet(ctx, { greeting } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const close = (val) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      popOverlay(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };

    /* --- 上半区：彩色玻璃卡 --- */
    const primaryGrid = h('div', { class: 'qsheet-grid' }, PRIMARY_ACTIONS.map((a) => h('button', {
      class: 'qsheet-card',
      dataset: { quick: a.key },
      onclick: () => { close(a.key); dispatch(ctx, a.key); },
    }, [
      h('span', {
        class: 'qsheet-card__icon',
        style: { background: a.iconBg, color: a.iconColor },
        html: Icons[a.icon],
      }),
      h('span', { class: 'qsheet-card__text' }, [
        h('span', { class: 'qsheet-card__title', text: a.title }),
        h('span', { class: 'qsheet-card__desc', text: a.desc }),
      ]),
    ])));

    /* --- 下半区：轻量功能行 --- */
    const secondaryGrid = h('div', { class: 'qsheet-mini-grid' }, SECONDARY_ACTIONS.map((a) => h('button', {
      class: 'qsheet-mini',
      dataset: { quick: a.key },
      onclick: () => { close(a.key); dispatch(ctx, a.key); },
    }, [
      h('span', { class: 'qsheet-mini__icon', style: { color: a.color }, html: Icons[a.icon] }),
      h('span', { class: 'qsheet-mini__text' }, [
        h('span', { class: 'qsheet-mini__title', text: a.title }),
        h('span', { class: 'qsheet-mini__desc', text: a.desc }),
      ]),
    ])));

    /* --- 面板 --- */
    const panel = h('div', { class: 'sheet qsheet' }, [
      h('div', { class: 'sheet__grabber' }),
      h('div', { class: 'qsheet__head' }, [
        h('span', { class: 'qsheet__wave', text: '👋' }),
        h('span', { class: 'qsheet__title', text: greeting || '嗨，想要记录什么？' }),
      ]),
      primaryGrid,
      h('div', { class: 'qsheet__divider' }),
      secondaryGrid,
      h('button', { class: 'qsheet__cancel', onclick: () => close(null) }, '取消'),
    ]);

    const overlay = h('div', { class: 'modal-overlay modal-overlay--bottom' }, panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    // 返回键 = 点「取消」（见 dom.js 的浮层栈说明）
    pushOverlay(overlay, () => close(null));
  });
}

export default quickSheet;
