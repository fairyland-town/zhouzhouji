/**
 * record_screen.js —— 「记录」页（v1.3.0，替换原「历史」页）
 *
 * 一个页面四种功能，顶部用分段控件切换：
 *   打卡 —— 自己建打卡项，点进去看月历，哪天打了哪天没打一目了然
 *   待办 —— 任务 / 想要两类备忘录，可勾选完成，已完成沉淀折叠（v1.4.0）
 *   记账 —— 金额 + 收/支 + 分类 + 备注，带月度预算，支持图片 OCR 一键导入
 *   账户 —— 饭卡 / 银行卡等余额对账：充了多少、花了多少、还剩多少（v1.5.0）
 *
 * 结构：PageHeader + 分段控件 + 可滚动主体（由子视图各自填充）
 * 关键：.screen 必须撑满 #screen-slot 并参与纵向 flex，否则内部滚动失效。
 *
 * v1.6.0：支持 ctx.params.action —— 快速记录抽屉深链过来时，
 * 直接展开对应操作（如 action:'entry' 打开记一笔表单），
 * 而不是只切到 tab 让用户再点一次。
 *
 * v1.13.0：主体支持**左右滑动翻板块**（用户要求「记录板块里面不能左右滑动
 * 来进行下一个板块」）。手势直接挂在 `.record-body-host` 上，见文件末尾
 * installSwipe() 的注释 —— 核心是「先判轴向、再决定拦不拦默认行为」，
 * 绝不能一上来就 preventDefault，否则纵向滚动会被一起吃掉。
 */

import { h, mount } from '../utils/dom.js';
import { Icons } from '../widgets/icons.js';
import { PageHeader } from '../widgets/page_header.js';
import { CheckinView } from './record/checkin_view.js';
import { LedgerView } from './record/ledger_view.js';
import { TodoView } from './record/todo_view.js';
import { AccountView } from './record/account_view.js';

// v1.7.0：待办与记账调换位置（用户要求「代办和记账换一个位置」），
// 让高频的「待办」紧挨着「打卡」，记账往后排。
// ⚠️ 这个顺序同时被两处 E2E 断言钉死（第 8 组与 8.7 组的开场断言），改顺序必须同步改。
const TABS = [
  { key: 'checkin', label: '打卡', icon: 'checkCircle' },
  { key: 'todo', label: '待办', icon: 'list' },
  { key: 'ledger', label: '记账', icon: 'wallet' },
  { key: 'account', label: '账户', icon: 'creditCard' },
];

/* ---------------- v1.13.0 翻页手势参数 ---------------- */

/**
 * 松手时判定「翻页」的最小水平位移。
 * 太小会误翻（手指只是轻微抖动），太大又显得迟钝。
 */
const SWIPE_MIN = 56;

/**
 * 判定「这是一次横向手势」的最小位移。
 * ⚠️ 不能和 SWIPE_MIN 混用：AXIS_LOCK 偏大的话，手指已经斜着走了一段才被认定为
 * 横向，那一段会先被浏览器当成纵向滚动吃掉，观感是「内容先抖一下再翻页」。
 */
const AXIS_LOCK = 9;

/** 已经在首个/末个板块还继续往外拖时的阻尼，给出「到头了」的物理反馈 */
const RUBBER = 0.34;

/** 翻页动画时长，需与 CSS 里 .record-body-host 的过渡时长保持一致 */
const SLIDE_MS = 200;

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function RecordScreen(ctx) {
  const el = h('div', { class: 'screen screen--record' });
  // 默认「打卡」，但允许路由参数指定，便于从别处深链
  let tab = TABS.some((t) => t.key === ctx.params?.tab) ? ctx.params.tab : 'checkin';
  // 抽屉指定的一次性动作，交给子视图消费后即失效（避免每次切 tab 都重放）
  let pendingAction = ctx.params?.action || null;

  const header = PageHeader({
    title: '记录',
    sub: '打卡 · 待办 · 记账 · 账户余额',
    // 头部箭头 = 「离开这一页」；系统返回键才会先在子板块之间回退（见 main.js 的 handleBack）
    onBack: () => ctx.back(),
  });

  const segWrap = h('div', { class: 'record-seg-wrap' });
  const bodyHost = h('div', { class: 'record-body-host' });

  function paintSeg() {
    mount(segWrap, h('div', { class: 'segmented' }, TABS.map((t) => h('button', {
      class: `segmented__item${tab === t.key ? ' segmented__item--active' : ''}`,
      dataset: { tab: t.key },
      onclick: () => {
        setOffset(0, false);   // 清掉手势可能留下的位移，避免点 tab 后画面歪着
        switchTab(t.key);
      },
    }, [
      h('span', { class: 'segmented__item__icon', html: Icons[t.icon] }),
      h('span', { text: t.label }),
    ]))));
  }

  function switchTab(next) {
    if (tab === next) return;
    tab = next;
    pendingAction = null;   // 手动切 tab 时丢弃未消费的动作
    // 🔴 v1.13.5：切子板块前先收掉所有浮层。
    //    `paintBody()` 会把旧的子视图整个换掉（连它闭包里的状态一起丢弃），
    //    但浮层是挂在 document.body 上的 —— 不主动收就会**变成孤儿**：
    //    界面还浮着一块「记一笔」，而它背后的视图已经换人了，
    //    这时候连「返回键」都不知道该关谁。
    //    记账页的「记一笔」现在是底部浮层，正是踩这个坑的第一个。
    ctx.closeModal?.();
    paintSeg();
    paintBody();
  }

  let currentView = null;

  function paintBody() {
    const params = pendingAction ? { action: pendingAction } : {};
    pendingAction = null;   // 只生效一次
    const sub = { ...ctx, params };
    if (tab === 'checkin') currentView = CheckinView(sub);
    else if (tab === 'ledger') currentView = LedgerView(sub);
    else if (tab === 'todo') currentView = TodoView(sub);
    else currentView = AccountView(sub);
    mount(bodyHost, currentView);
  }

  /* ---------------- v1.13.0 左右滑动翻板块 ---------------- */

  /** 当前板块序号 */
  const tabIndex = () => TABS.findIndex((t) => t.key === tab);

  /** 翻页动画进行中：期间忽略新手势，否则连划两下会把 transform 叠成一团 */
  let animating = false;

  /** 刚发生过滑动：用来吞掉紧随其后的那次 click（防止划过按钮时误触发） */
  let justSwiped = false;

  /** 位移容器。px 为 0 时清空 transform（而不是写 translateX(0)），少一个合成层 */
  function setOffset(px, animate) {
    bodyHost.style.transition = animate
      ? `transform ${SLIDE_MS}ms cubic-bezier(.22,.61,.36,1)`
      : 'none';
    bodyHost.style.transform = px ? `translateX(${px}px)` : '';
  }

  /**
   * 翻到相邻板块。
   *
   * 动画分两段：先把当前内容滑出屏幕 → 换内容 → 从另一侧滑进来。
   * 比「原地淡出淡入」更像「一页推着一页走」，方向感也更明确。
   *
   * @param {string} next 目标 tab key
   * @param {number} dir  1 = 往左翻（下一个），-1 = 往右翻（上一个）
   */
  function slideTo(next, dir) {
    if (prefersReducedMotion()) { switchTab(next); setOffset(0, false); return; }
    const w = bodyHost.clientWidth || window.innerWidth || 360;
    animating = true;
    setOffset(-dir * w, true);
    setTimeout(() => {
      switchTab(next);
      setOffset(dir * w, false);   // 无过渡地瞬移到另一侧
      // 🔴 必须强制一次重排：同一帧内先改 transition 再改 transform，
      //    浏览器会把两次样式变更合并，结果是「跳变」而不是「滑入」。
      void bodyHost.offsetWidth;
      setOffset(0, true);
      setTimeout(() => { setOffset(0, false); animating = false; }, SLIDE_MS);
    }, SLIDE_MS);
  }

  /**
   * 挂手势。用 touch 事件而不是 pointer 事件，理由：
   * 我们要在判定为横向之后 **主动 preventDefault**，pointer 事件做不到这件事
   * （指针事件不可取消），只能靠 CSS touch-action 预先声明，那样就失去了
   * 「先看方向再决定」的余地。
   */
  function installSwipe() {
    let sx = 0; let sy = 0; let dx = 0;
    let axis = null;          // null = 未判定 | 'x' = 横向翻页 | 'y' = 交给浏览器滚动
    let tracking = false;

    /**
     * 起点是否落在「自己就能横向滚动」的元素里。
     * 那种元素上的左右滑应该是滚它自己，不是翻页。
     * （记录页当前没有这种元素，但子视图以后加了也不会悄悄坏掉。）
     */
    function inHorizontalScroller(target) {
      for (let n = target; n && n !== bodyHost; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 4) return true;
      }
      return false;
    }

    bodyHost.addEventListener('touchstart', (e) => {
      if (animating || e.touches.length !== 1) return;
      if (inHorizontalScroller(e.target)) { tracking = false; return; }
      const t = e.touches[0];
      sx = t.clientX; sy = t.clientY;
      dx = 0; axis = null; tracking = true;
    }, { passive: true });

    bodyHost.addEventListener('touchmove', (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      const mx = t.clientX - sx;
      const my = t.clientY - sy;

      if (axis === null) {
        // 位移还太小，方向不明 —— 此时什么都不做，绝不 preventDefault
        if (Math.abs(mx) < AXIS_LOCK && Math.abs(my) < AXIS_LOCK) return;
        axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
        if (axis === 'y') { tracking = false; return; }   // 纵向手势整场交还给浏览器
      }

      // 到这里确定是横向翻页：必须拦住默认行为，
      // 否则浏览器会同时开始纵向滚动，翻页和滚动一起动，两个都别扭
      e.preventDefault();

      const i = tabIndex();
      const atStart = mx > 0 && i === 0;
      const atEnd = mx < 0 && i === TABS.length - 1;
      dx = (atStart || atEnd) ? mx * RUBBER : mx;
      bodyHost.style.willChange = 'transform';
      setOffset(dx, false);
    }, { passive: false });

    function finish() {
      const wasX = axis === 'x';
      tracking = false;
      axis = null;
      bodyHost.style.willChange = '';
      if (!wasX) return;

      const i = tabIndex();
      const w = bodyHost.clientWidth || window.innerWidth || 360;
      const need = Math.min(SWIPE_MIN, w * 0.22);
      const atEdge = (dx > 0 && i === 0) || (dx < 0 && i === TABS.length - 1);

      if (Math.abs(dx) < need || atEdge) {
        // 不够远 / 已经到头 → 弹回原位
        setOffset(0, true);
        setTimeout(() => setOffset(0, false), SLIDE_MS);
        return;
      }

      justSwiped = true;
      setTimeout(() => { justSwiped = false; }, 340);
      const dir = dx < 0 ? 1 : -1;
      slideTo(TABS[i + dir].key, dir);
    }

    bodyHost.addEventListener('touchend', finish);
    bodyHost.addEventListener('touchcancel', finish);

    // 滑动过程中手指下面压着的按钮不该被点中。
    // 理论上 preventDefault 已经阻止了 click，但 WebView 版本差异较大，这里再兜一层。
    bodyHost.addEventListener('click', (e) => {
      if (!justSwiped) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }

  paintSeg();
  paintBody();
  mount(el, [header, segWrap, bodyHost]);
  installSwipe();

  // 供 E2E / 外部调用：切到指定 tab
  el.__switchTab = switchTab;
  // 供返回键逻辑查询：当前在第几个板块、能不能再往左走
  el.__tabIndex = tabIndex;
  el.__tabCount = TABS.length;
  return el;
}

export default RecordScreen;
