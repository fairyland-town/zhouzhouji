/**
 * native_bridge.js —— 安卓壳（Capacitor）探测与低层桥接
 *
 * 🔴 为什么用 `Capacitor.nativePromise` 而不是 `import '@capacitor/filesystem'`：
 *    本项目**零构建、零依赖**，`web/` 直接当静态目录伺服。
 *    浏览器解析不了 `@capacitor/filesystem` 这种裸模块名（那是 npm 包路径），
 *    要让它能跑就得引入打包器或 import map —— 与项目原则冲突。
 *
 *    而 Capacitor 的原生层会往 WebView 注入 `native-bridge.js`，
 *    在上面挂好低层通道：
 *        Capacitor.nativePromise(插件名, 方法名, 参数) → Promise
 *    直接用它就能调原生插件，**不必把插件 JS 打进 web/**。
 *    （见 node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js）
 *
 * ⚠️ 在普通浏览器里 `window.Capacitor` 不存在，本模块所有函数安全降级：
 *    `isNative()` 返回 false，`callNative()` 返回 null。
 *    调用方必须据此走浏览器分支，**绝不能假设原生能力一定可用**。
 */

/** Capacitor 运行时对象（浏览器里为 null） */
function cap() {
  return (typeof window !== 'undefined' && window.Capacitor) || null;
}

/** 是否跑在原生壳里。普通浏览器返回 false */
export function isNative() {
  const c = cap();
  try {
    return !!(c && typeof c.isNativePlatform === 'function' && c.isNativePlatform());
  } catch {
    return false;
  }
}

/** 当前平台：'android' | 'ios' | 'web' */
export function platform() {
  const c = cap();
  try {
    if (c && typeof c.getPlatform === 'function') return c.getPlatform();
  } catch { /* 落到 web */ }
  return isNative() ? 'native' : 'web';
}

/**
 * 调用原生插件方法。
 *
 * @param {string} plugin  插件名，如 'Filesystem'
 * @param {string} method  方法名，如 'writeFile'
 * @param {object} options 参数
 * @returns {Promise<any|null>} 浏览器 / 无原生通道时返回 null，调用方据此降级
 */
export async function callNative(plugin, method, options = {}) {
  const c = cap();
  if (!c || typeof c.nativePromise !== 'function') return null;
  try {
    return await c.nativePromise(plugin, method, options);
  } catch (err) {
    // 原生侧报错（权限不足、路径非法等）往上抛，由调用方决定怎么提示
    throw new Error(`[${plugin}.${method}] ${err && err.message ? err.message : err}`);
  }
}

/** Capacitor Filesystem 的目录枚举值（字符串直传，无需加载插件 JS） */
export const DIR = {
  DOCUMENTS: 'DOCUMENTS',
  DATA: 'DATA',
  EXTERNAL: 'EXTERNAL_STORAGE',
  EXTERNAL_STORAGE: 'EXTERNAL_STORAGE',
  /**
   * 应用缓存目录（Android: context.getCacheDir()）。
   * OCR 的临时图片落在这里 —— 系统会自动回收，不会长期占用空间，
   * 而且这个目录必定可写，不需要任何存储权限。
   */
  CACHE: 'CACHE',
};

/** Capacitor Filesystem 的编码枚举值 */
export const ENC = { UTF8: 'utf8' };

/**
 * 监听原生插件的**事件**（v1.13.0）。
 *
 * 🔴 为什么不能直接 `import { App } from '@capacitor/app'`：
 *    同本文件顶部说明 —— 零构建项目解析不了裸模块名。
 *    但 Capacitor 注入到 WebView 的 `window.Capacitor` 上**已经挂好了**
 *    低层监听通道：
 *        Capacitor.addListener(插件名, 事件名, 回调) → { remove() }
 *    直接用它即可，不必把插件 JS 打进 web/。
 *    （见 node_modules/@capacitor/android/capacitor/src/main/assets/native-bridge.js:183）
 *
 * ⚠️ 浏览器里 `window.Capacitor.addListener` 不存在，返回 null。
 *    调用方必须据此判断「没接上监听」，并走浏览器分支。
 *
 * @param {string} plugin  插件名，如 'App'
 * @param {string} event   事件名，如 'backButton'
 * @param {(data:any)=>void} handler
 * @returns {{remove:()=>Promise<void>}|null} 句柄；不可用时为 null
 */
export function onNativeEvent(plugin, event, handler) {
  const c = cap();
  if (!c || typeof c.addListener !== 'function') return null;
  try {
    return c.addListener(plugin, event, handler);
  } catch (err) {
    console.warn(`[native] 注册 ${plugin}.${event} 监听失败：`, err && err.message);
    return null;
  }
}

