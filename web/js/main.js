/**
 * main.js —— 应用入口：路由、底部导航、全局状态
 * 路由（02 文档第 11 节）：周历 | 添加 | 记录  ／ 设置放右上角
 * v1.3.0：原「历史」页改为「记录」页（打卡 + 记账）。
 * v1.3.1：修叙述式通知的题目提取（「主题为：」）与英文报告人姓名。
 * v1.4.0：记录页新增「待办」——任务 / 想要两类清单，可勾选完成，已完成沉淀折叠。
 * v1.4.1：修记账金额识别 —— 型号（g27 / iPhone15）不再被当成价格，
 *         且结果与 OCR 行序无关（不再出现「早餐金额显示在前面」）。
 * v1.5.0：新增「账户余额对账」与「使用说明」；PWA 可安装到安卓。
 * v1.6.0：液态玻璃视觉改版 —— 景深卡片、玻璃 dock、胶囊分段控件；
 *         底部中央「＋」改为打开「快速记录」抽屉（QuickSheet），
 *         一个入口收敛到记账 / 账户 / 待办 / 打卡等所有高频动作。
 */
import { h, mount, clear, toast, dismissTopOverlay, resetOverlayStack, confirmDialog } from './utils/dom.js';
import { Icons } from './widgets/icons.js';
import { quickSheet } from './widgets/quick_sheet.js';
import DatabaseService from './services/database_service.js';
import { reminderService } from './services/reminder_service.js';
import { installAutoBackup, scheduleAutoBackup, offerRestoreIfFresh } from './services/backup_service.js';
import { callNative, isNative, onNativeEvent } from './services/native_bridge.js';
import { WeekScreen } from './screens/week_screen.js';
import { AddEventScreen } from './screens/add_event_screen.js';
import { ConfirmScreen } from './screens/confirm_screen.js';
import { EditEventScreen } from './screens/edit_event_screen.js';
import { RecordScreen } from './screens/record_screen.js';
import { SettingsScreen } from './screens/settings_screen.js';
import { GuideScreen } from './screens/guide_screen.js';

const appEl = document.getElementById('app');

/** 根页面。返回键退到它之后就该退出了（v1.13.0） */
const ROOT_ROUTE = 'week';

const ctx = {
  db: DatabaseService,
  state: { weekDate: new Date(), ocrDraft: '' },
  params: {},
  route: 'week',
  stack: [],

  /** 跳转 */
  go(route, params = {}, { replace = false } = {}) {
    // v1.13.0：**回根页面 = 清空返回栈**，而不是把当前页压进去。
    // 否则「添加 → 确认 → 保存回周历」之后按返回键，会退回那个已经提交完的确认页。
    // 这一条同时让「保存后回首页」「删完后回首页」这类终点动作自动把栈归零。
    if (route === ROOT_ROUTE) {
      this.stack.length = 0;
    } else if (!replace && this.route !== route) {
      this.stack.push({ route: this.route, params: { ...this.params } });
    }
    this.route = route;
    this.params = params || {};
    this.render();
  },

  /** 返回上一页（栈空时兜底回根页面） */
  back() {
    const prev = this.stack.pop();
    if (prev) {
      this.route = prev.route;
      this.params = prev.params || {};
      this.render();
    } else {
      this.go(ROOT_ROUTE);
    }
  },

  closeModal() {
    document.querySelectorAll('.modal-overlay').forEach((n) => n.remove());
    // DOM 都摘了，浮层栈里的记录必须一起作废，
    // 否则返回键会去 dismiss 一个已经不在文档里的节点，白按一次
    resetOverlayStack();
  },

  startReminders() {
    reminderService.start(() => this.db.getAll());
  },

  render() {
    this.closeModal();
    const main = document.getElementById('screen-slot');
    let screen;
    switch (this.route) {
      case 'add': screen = AddEventScreen(this); break;
      case 'confirm':
      case 'editConfirm': screen = ConfirmScreen(this); break;
      case 'detail': screen = EditEventScreen(this); break;
      case 'record': screen = RecordScreen(this); break;
      case 'settings': screen = SettingsScreen(this); break;
      case 'guide': screen = GuideScreen(this); break;
      case 'week':
      default: screen = WeekScreen(this); break;
    }
    mount(main, [screen]);
    // OCR 粘贴监听
    if (screen._onPaste) {
      document.onpaste = screen._onPaste;
    } else {
      document.onpaste = null;
    }
  },
};

/* ---------------- 底部导航 ---------------- */

function BottomNav() {
  const items = [
    // outline = 未选中（描边细线）；solid = 选中（整块填充蓝色）
    { key: 'week', label: '周历', icon: 'calendar', iconSolid: 'calendarSolid' },
    { key: 'add', label: '添加', icon: 'plus' },
    { key: 'record', label: '记录', icon: 'record', iconSolid: 'recordSolid' },
  ];

  const nav = h('nav', { class: 'bottom-nav' });

  items.forEach((it) => {
    if (it.key === 'add') {
      // v1.6.0：不再是"直接跳到添加页"，而是先弹「快速记录」抽屉，
      // 让用户在记账 / 账户 / 待办 / 打卡之间就地选，少一次页面往返。
      nav.appendChild(h('button', {
        class: 'bottom-nav__fab',
        dataset: { action: 'quick-add' },
        title: '快速记录',
        'aria-label': '快速记录',
        html: Icons.plus,
        onclick: () => openQuickAdd(),
      }));
      return;
    }
    // v1.10.0：两个字形都放进 DOM（.bottom-nav__ico--line / --fill），
    // 由 CSS 按 --active 交叉淡入淡出 —— 比运行时换 html 少一次重排，
    // 也天然带过渡动画。aria-hidden 防止读屏把两份图标读两遍。
    nav.appendChild(h('button', {
      class: `bottom-nav__item${ctx.route === it.key ? ' bottom-nav__item--active' : ''}`,
      dataset: { route: it.key, label: it.label },
      html:
        `<span class="bottom-nav__ico bottom-nav__ico--line" aria-hidden="true">${Icons[it.icon]}</span>` +
        `<span class="bottom-nav__ico bottom-nav__ico--fill" aria-hidden="true">${Icons[it.iconSolid]}</span>` +
        `<span class="bottom-nav__label">${it.label}</span>`,
      onclick: () => ctx.go(it.key),
    }));
  });

  return nav;
}

/** 打开快速记录抽屉；返回值交给 quick_sheet 内部做路由跳转 */
async function openQuickAdd() {
  await quickSheet(ctx, { greeting: '嗨，想要记录什么？' });
}

/* ---------------- v1.13.0 安卓返回键 / 侧边返回手势 ----------------
 *
 * 问题（用户原话）：「整个软件没有返回功能，滑两次就直接退出软件
 * （是安卓全面屏手势那种）」。
 *
 * 根因：路由是**内存栈**（ctx.stack），不是浏览器 history —— 这是 v1.3.0 特意
 * 去掉的（见本文件顶部注释与 README 的路由表）。于是 WebView 的 canGoBack()
 * 恒为 false。而 @capacitor/app 在没有 JS 监听 backButton 时的行为是：
 *     canGoBack() ? webView.goBack() : （什么都不做）
 * 后者会落回 Activity 的默认返回行为 = 直接结束应用。
 * （见 @capacitor/app 的 AppPlugin.java:46-58）
 *
 * 解法：**注册 backButton 监听**。只要注册了，原生就完全不再自己处理，
 * 退不退、退到哪儿全由我们说了算。然后按「最轻的先关」逐层回退：
 *     ① 浮层（弹窗 / 抽屉）
 *     ② 记录页的子板块 → 退回第一个板块
 *     ③ 路由栈 → 回上一页
 *     ④ 已在根页面 → 提示「再滑一次退出」，2 秒内再滑才真的退出
 *
 * ⚠️ 浏览器里没有 backButton 事件，这套逻辑不会被注册；
 *    网页版靠浏览器自己的前进后退（那是真 history）。
 */

/** 上一次在根页面按返回的时刻，用于「两步退出」 */
let lastBackAt = 0;
/** 两步退出的时间窗（毫秒） */
const BACK_EXIT_WINDOW = 2000;

/** 退出应用（仅原生壳内有效；浏览器里是 no-op） */
async function exitApp() {
  if (!isNative()) return;
  try {
    await callNative('App', 'exitApp', {});
  } catch (err) {
    console.warn('[back] 退出应用失败：', err && err.message);
  }
}

/**
 * 处理一次返回。抽成独立函数是为了能在 E2E / 调试里直接调用，
 * 不必真的去触发原生事件。
 * @returns {boolean} 恒为 true —— 表示「这次返回已被消费，不要退出应用」
 */
export function handleBack() {
  // ① 浮层最轻，先关它
  if (dismissTopOverlay()) return true;

  // ② 记录页在子板块里 → 先退回第一个板块，而不是直接离开整个记录页。
  //    和左右滑动翻页是一对：能划进去，就该能划回来。
  const rec = document.querySelector('.screen--record');
  if (rec && typeof rec.__tabIndex === 'function' && rec.__tabIndex() > 0) {
    rec.__switchTab('checkin');
    return true;
  }

  // ③ 不在根页面 → 回上一页（栈空时 ctx.back() 会兜底回周历）
  if (ctx.route !== ROOT_ROUTE) {
    ctx.back();
    return true;
  }

  // ④ 已在根页面：两步退出，避免手一滑就把应用关了
  const now = Date.now();
  if (now - lastBackAt < BACK_EXIT_WINDOW) {
    exitApp();
    return true;
  }
  lastBackAt = now;
  toast('再滑一次返回即退出', 'info');
  return true;
}

/**
 * 注册原生返回键监听。
 * @returns {boolean} 是否注册成功（浏览器里恒为 false）
 */
function installBackButton() {
  if (!isNative()) return false;
  const handle = onNativeEvent('App', 'backButton', () => { handleBack(); });
  if (!handle) {
    console.warn('[back] 原生返回键监听未接上，返回手势仍会直接退出应用');
    return false;
  }
  return true;
}

/* ---------------- 启动 ---------------- */

async function boot() {
  mount(appEl, [
    h('main', { id: 'screen-slot', style: { flex: '1', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: '0' } }),
  ]);
  // 底部导航固定在外壳底部，不随路由重建
  appEl.appendChild(BottomNav());

  // 路由变化时更新导航高亮
  // v1.11.0：顺带在切页后安排一次防抖自动备份（仅安卓壳内生效）。
  //   不挂在每次 render 上 —— render 太频繁；切页与「用户刚动过数据」强相关。
  let lastRoute = null;
  const origRender = ctx.render.bind(ctx);
  ctx.render = function patchedRender() {
    origRender();
    document.querySelectorAll('.bottom-nav__item').forEach((btn) => {
      const r = btn.dataset.route;
      btn.classList.toggle('bottom-nav__item--active', r === ctx.route);
    });
    if (ctx.route !== lastRoute) {
      lastRoute = ctx.route;
      scheduleAutoBackup(ctx.db);
      // v1.12.0：切页与「用户刚动过数据」强相关，顺手把系统闹钟对一次账。
      //   浏览器里是 no-op（那边靠页面内轮询）。
      reminderService.onDataChanged();
    }
  };

  // 全局 Toast 兜底给提醒服务用
  window.__cwToast = (msg) => toast(msg, 'info');
  // 返回键逻辑挂到 window：便于 E2E 直接调用，不必真去触发原生事件
  window.__cwBack = () => handleBack();

  try {
    await ctx.db.count(); // 触发数据库初始化
  } catch (err) {
    document.body.appendChild(h('div', {
      class: 'notice notice--danger',
      style: { position: 'fixed', top: '20px', left: '50%', transform: 'translateX(-50%)', zIndex: '300', maxWidth: '340px' },
      text: '本地数据库初始化失败：' + err.message,
    }));
    return;
  }

  ctx.render();
  ctx.startReminders();

  // 安卓壳内：接管系统返回键 / 侧边返回手势（见上方 handleBack 注释）
  installBackButton();

  // 安卓壳内：应用切到后台时自动把全部数据备份到手机文件系统。
  // 浏览器里是 no-op（网页版走「设置 → 导出 JSON」）。
  installAutoBackup(ctx.db);

  // 安卓壳内：本机第一次打开、数据库又是空的，但手机里躺着上一份备份 ——
  // 主动问一句要不要恢复。
  // 卸载应用会删掉 IndexedDB，但**删不掉「文档」目录里的备份文件**；
  // 数据其实还在，只是没人告诉用户。这个提示就是那个「告诉」。
  offerRestore(ctx.db);
}

/** 重装后找回数据的提示（仅原生壳内、且只在本机第一次打开时出现） */
async function offerRestore(db) {
  let found = null;
  try {
    found = await offerRestoreIfFresh(db);
  } catch (err) {
    console.warn('[main] 检查历史备份失败：', err && err.message);
    return;
  }
  if (!found) return;

  const ok = await confirmDialog({
    title: '发现上一份备份',
    message: `这台手机里有一份备份，共 ${found.total} 条记录`
      + `${found.at ? `（${found.at}）` : ''}。\n`
      + '数据改动后会自动写进手机「文档」目录，卸载应用不会删掉它。\n\n'
      + '要把这份备份恢复到本机吗？',
    okText: '恢复',
    cancelText: '不用',
  });
  if (!ok) return;

  try {
    const res = await db.importJSON(found.json, { merge: false });
    toast(`已恢复 ${res.total} 条记录`, 'success');
    ctx.render();
  } catch (err) {
    toast('恢复失败：' + err.message, 'error');
  }
}

// 快捷键：Alt+← 回上一周（桌面测试用）
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft' && ctx.route === 'week') {
    ctx.state.weekDate = new Date(ctx.state.weekDate.getTime() - 7 * 86400000);
    ctx.render();
  }
  if (e.altKey && e.key === 'ArrowRight' && ctx.route === 'week') {
    ctx.state.weekDate = new Date(ctx.state.weekDate.getTime() + 7 * 86400000);
    ctx.render();
  }
});

/* ---------------- 全局静默失败兜底 ---------------- */

/**
 * v1.13.5：兜住「异步点击处理器抛错」这条静默路径。
 *
 * 界面上大量按钮写成 `onclick: async () => { ... }`。只要里面 `await` 的
 * 某一步抛了错，而这个错又没被就地 catch（比如某个 Service 忘了包 try），
 * 浏览器只会把它记成一次 unhandledrejection —— **界面上什么都不发生**。
 * 用户看到的就是「我点了，没反应」，既不知道成没成，也不知道该不该重试。
 *
 * 所以这里把它变成一句人话。同时保留 console.error：
 * 兜底是给用户看的，堆栈是给开发者看的，两个都要。
 */
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  // 只有 Error 和字符串才配得上给用户看。
  // 🔴 别写成 `String(reason)` 兜底 —— `Promise.reject({ code: 42 })` 会得到
  //    「操作失败：[object Object]」，`reject(null)` 会得到「操作失败：null」。
  //    这种开发者黑话糊在用户脸上，比只说一句「操作失败」还糟。
  let detail = '';
  if (reason instanceof Error) detail = (reason.message || '').trim();
  else if (typeof reason === 'string') detail = reason.trim();
  console.error('[unhandledrejection]', reason);
  toast(detail ? `操作失败：${detail}` : '操作失败，请重试', 'error');
});

window.addEventListener('error', (e) => {
  // 资源加载失败（img / script 404）也走 'error' 事件，但它的 e.error 是 null，
  // 且消息永远是同一句「Failed to load resource」—— 那种不该弹给用户看。
  if (!e.error) return;
  console.error('[uncaught]', e.error);
  toast('页面出错了，请重试一次', 'error');
});

boot();

export { ctx };
