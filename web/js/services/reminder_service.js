/**
 * reminder_service.js —— 本地提醒
 *
 * 两条实现路径（按运行环境自动选择）：
 *
 *   · 安卓壳内 —— 交给**系统闹钟**（@capacitor/local-notifications）。
 *       应用被杀掉、手机重启后依然会响 —— 因为闹钟登记在系统里，
 *       插件还注册了 BOOT_COMPLETED 接收器，重启后会自动恢复。
 *
 *   · 浏览器   —— 浏览器 Notification + 页面内轮询（每 30 秒）。
 *       关闭页面后不会提醒，这与「离线优先、不上服务器」的原则一致。
 *
 * 🔴 为什么手机端必须换掉浏览器那套：
 *   Android WebView 里**根本没有 `window.Notification`**（`typeof` 是
 *   'undefined'），所以旧代码在手机上永远显示「不支持」。这不是权限问题，
 *   也不是配置问题 —— 是这套 API 在 WebView 里不存在，只能改用原生通道。
 */

import { isNative, callNative } from './native_bridge.js';

const STORAGE_KEY = 'cw_reminders';
const LEAD_MINUTES = 30; // 默认提前 30 分钟提醒

/* ---------------- 安卓原生通道的常量 ---------------- */

/** 通知渠道 id。Android 8+ 的声音/重要性挂在渠道上，不挂在单条通知上 */
const CHANNEL_ID = 'zhouzhouji-events';
/** 状态栏小图标（drawable 资源名，不含扩展名）。必须是与渠道无关的白色剪影 */
const SMALL_ICON = 'ic_stat_zhouzhouji';
/** 通知右侧大图标（drawable 资源名） */
const LARGE_ICON = 'ic_notification_large';
/** 最远只登记这么多天内的提醒 —— 太远的既无意义又占系统闹钟名额 */
const HORIZON_DAYS = 120;
/** 同时在挂的闹钟上限，留足余量（系统对单应用有数量限制） */
const MAX_SCHEDULED = 150;
/** 已经进入提醒窗口的活动，落到「立刻响」而不是排到过去的时间点 */
const IMMINENT_DELAY_MS = 5000;
/** 「已经排过什么」的本地账本，用于增量对账（避免无脑全清全排） */
const SCHEDULED_KEY = 'cw_reminders_scheduled';

export class ReminderService {
  constructor() {
    this.timer = null;
    this.fired = new Set();
    this._getEvents = null;
    this._syncTimer = null;
    this._visBound = false;
    this._channelReady = false;
    this.load();
  }

  load() {
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) === '1';
    } catch { this.enabled = false; }
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, this.enabled ? '1' : '0'); } catch { /* ignore */ }
  }

  /* ---------------- 权限 ---------------- */

  /** 浏览器里的同步权限状态（原生请用 checkPermission()） */
  get permission() {
    if (isNative()) return 'native';
    return typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
  }

  /** 是否具备提醒能力：原生恒为 true（能力随 APK 内置），浏览器看 Notification 是否存在 */
  get supported() {
    return isNative() || typeof Notification !== 'undefined';
  }

  /**
   * 查询通知权限（异步）。
   * @returns {Promise<'granted'|'denied'|'prompt'|'unsupported'>}
   */
  async checkPermission() {
    if (isNative()) {
      try {
        const st = await callNative('LocalNotifications', 'checkPermissions');
        return (st && st.display) || 'prompt';
      } catch {
        return 'prompt';
      }
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  /** 请求通知权限 */
  async requestPermission() {
    if (isNative()) {
      try {
        const st = await callNative('LocalNotifications', 'requestPermissions');
        return (st && st.display) || 'denied';
      } catch {
        return 'denied';
      }
    }
    if (typeof Notification === 'undefined') return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }

  /* ---------------- 开关 ---------------- */

  async enable() {
    const p = await this.requestPermission();
    if (p !== 'granted') return false;
    this.enabled = true;
    this.save();
    if (isNative()) {
      await this._ensureChannel();
      await this.syncNow();
    }
    return true;
  }

  async disable() {
    this.enabled = false;
    this.save();
    this.stop();
    if (isNative()) {
      await this._cancelScheduled().catch(() => {});
    }
  }

  /* ---------------- 启动 / 停止 ---------------- */

  /**
   * 开始提醒。
   * @param {() => Promise<Array>} getEvents 取全部活动的函数
   */
  start(getEvents) {
    this.stop();
    this._getEvents = getEvents || this._getEvents;
    if (!this.enabled) return;

    // 安卓壳：登记到系统闹钟，不再轮询
    if (isNative()) {
      this.syncNow().catch(() => {});
      // 回到前台时对一次账：期间用户可能改过数据，或系统重启后闹钟需要重建
      if (!this._visBound) {
        this._visBound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && this.enabled) {
            this.syncNow().catch(() => {});
          }
        });
      }
      return;
    }

    // 浏览器：页面内轮询
    const tick = async () => {
      try {
        const events = await this._getEvents();
        this.checkUpcoming(events);
      } catch { /* 静默失败，不影响主流程 */ }
    };
    tick();
    this.timer = setInterval(tick, 30 * 1000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 数据变动后调用（原生模式）：防抖地重新对账一次闹钟 */
  onDataChanged(delay = 3000) {
    if (!isNative() || !this.enabled) return;
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      this.syncNow().catch(() => {});
    }, delay);
  }

  /* ---------------- 浏览器路径 ---------------- */

  /** 检查并在需要时提醒（仅浏览器路径使用） */
  checkUpcoming(events) {
    if (!this.enabled) return;
    const now = Date.now();
    for (const e of events) {
      const t = e.startDate.getTime();
      if (Number.isNaN(t)) continue;
      const diff = t - now;
      const key = `${e.id}@${e.startTime}`;
      // 提前 30 分钟内、且尚未开始
      if (diff > 0 && diff <= LEAD_MINUTES * 60 * 1000 && !this.fired.has(key)) {
        this.fired.add(key);
        this.notify(e, diff);
      }
    }
  }

  notify(event, diffMs) {
    const mins = Math.max(1, Math.round(diffMs / 60000));
    const body = `${event.timeString} 开始 · ${event.location}`;
    const title = `即将开始（${mins} 分钟后）：${event.title}`;

    // 页面内 Toast 兜底，保证一定可见
    if (window.__cwToast) window.__cwToast(title);

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try { new Notification(title, { body, tag: `cw-${event.id}` }); } catch { /* ignore */ }
    }
  }

  /** 对某个活动的提醒状态 */
  isUpcoming(event) {
    const diff = event.startDate.getTime() - Date.now();
    return diff > 0 && diff <= LEAD_MINUTES * 60 * 1000;
  }

  /* ---------------- 原生路径 ---------------- */

  /** 建通知渠道（幂等，重复调用只会更新名称与说明） */
  async _ensureChannel() {
    if (this._channelReady) return;
    try {
      await callNative('LocalNotifications', 'createChannel', {
        id: CHANNEL_ID,
        name: '活动提醒',
        description: '周历里的活动开始前提醒',
        importance: 4,        // HIGH —— 会以横幅（heads-up）形式弹出
        visibility: 1,        // 锁屏上显示完整内容
        vibration: true,
        lights: true,
        lightColor: '#1B7CFD',
      });
      this._channelReady = true;
    } catch { /* 建渠道失败不阻断，走系统默认渠道 */ }
  }

  /** 读取「已登记」账本：{ [通知id]: 活动开始时间 } */
  _scheduled() {
    try {
      const raw = localStorage.getItem(SCHEDULED_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
  }

  _saveScheduled(obj) {
    try { localStorage.setItem(SCHEDULED_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
  }

  /**
   * 把活动列表换算成要登记的闹钟。
   *
   * 账本里的签名用**活动开始时间**而不是提醒时间：这样活动时间没变就绝不重排，
   * 避免每次对账都把已经弹过的通知又重排一遍（会重复响）。
   *
   * @returns {Object} { [通知id]: { title, body, at, sig } }
   */
  _plan(events) {
    const now = Date.now();
    const horizon = now + HORIZON_DAYS * 86400000;
    const out = {};
    let n = 0;

    for (const e of events) {
      if (n >= MAX_SCHEDULED) break;

      // 通知 id 用活动的自增主键 —— 天然唯一，且改活动时间后能对上同一条
      const id = Number(e && e.id);
      if (!Number.isInteger(id) || id <= 0 || id > 2147483647) continue;

      const start = e.startDate instanceof Date ? e.startDate.getTime() : NaN;
      if (!Number.isFinite(start)) continue;

      const remindAt = start - LEAD_MINUTES * 60000;
      // 已经开始了的活动不必提醒；太远的先不登记
      if (start <= now || remindAt > horizon) continue;

      out[id] = {
        title: `即将开始：${e.title}`,
        body: `${e.timeString} · ${e.location}`,
        // 已经进入提醒窗口（比如刚开启提醒时就有活动在 30 分钟内）就立刻响
        at: new Date(Math.max(remindAt, now + IMMINENT_DELAY_MS)),
        sig: String(e.startTime || start),
      };
      n++;
    }
    return out;
  }

  /** 与系统对账：只增删改有变化的那几条，不动其它 */
  async syncNow() {
    if (!isNative() || !this.enabled) return { skipped: true };
    if (!this._getEvents) return { skipped: true, reason: 'no-source' };

    await this._ensureChannel();

    let events;
    try {
      events = await this._getEvents();
    } catch {
      return { skipped: true, reason: 'load-failed' };
    }

    const desired = this._plan(events);
    const prev = this._scheduled();

    // 1) 已经不需要的（活动被删掉 / 已开始 / 超出范围）—— 撤掉闹钟
    const cancelIds = Object.keys(prev)
      .filter((k) => !(k in desired))
      .map(Number)
      .filter((n) => Number.isInteger(n));
    if (cancelIds.length) {
      await callNative('LocalNotifications', 'cancel', {
        notifications: cancelIds.map((id) => ({ id })),
      }).catch(() => {});
    }

    // 2) 新增的或活动时间变过的 —— 重新登记
    const toSchedule = [];
    for (const [k, n] of Object.entries(desired)) {
      if (prev[k] === n.sig) continue;
      toSchedule.push({
        id: Number(k),
        title: n.title,
        body: n.body,
        schedule: { at: n.at, allowWhileIdle: true },
        channelId: CHANNEL_ID,
        smallIcon: SMALL_ICON,
        largeIcon: LARGE_ICON,
        foreground: true,   // 应用在前台时也弹出来，否则用户以为没生效
      });
    }

    let warning = null;
    if (toSchedule.length) {
      const res = await callNative('LocalNotifications', 'schedule', {
        notifications: toSchedule,
      });
      // 未授予「精确闹钟」权限时插件会降级为不精确闹钟并回一条 warning
      warning = (res && res.warning) || null;
    }

    this._saveScheduled(
      Object.fromEntries(Object.entries(desired).map(([k, n]) => [k, n.sig])),
    );

    return { scheduled: toSchedule.length, cancelled: cancelIds.length, warning };
  }

  /** 撤掉本服务登记过的全部闹钟 */
  async _cancelScheduled() {
    const prev = this._scheduled();
    const ids = Object.keys(prev).map(Number).filter((n) => Number.isInteger(n));
    if (ids.length) {
      await callNative('LocalNotifications', 'cancel', {
        notifications: ids.map((id) => ({ id })),
      });
    }
    this._saveScheduled({});
  }

  /** 设置页展示用：当前有多少条待响的提醒 */
  async pendingCount() {
    if (!isNative() || !this.enabled) return 0;
    try {
      const res = await callNative('LocalNotifications', 'getPending');
      const list = (res && Array.isArray(res.notifications)) ? res.notifications : [];
      return list.length;
    } catch {
      return 0;
    }
  }
}

export const reminderService = new ReminderService();
export { LEAD_MINUTES };
