/**
 * native_services_test.mjs —— 原生插件调用链测试（v1.12.0）
 *
 * 为什么需要这个：
 *   设备端 OCR 与系统闹钟这两条链路**从来没在真机上跑过**
 *   （开发机没有安卓设备/模拟器）。之前只是「读插件源码确认 API 形状」，
 *   但**没有验证过我们自己的调用代码是否产生了正确的调用**。
 *   这个文件补上这一段：用一个假的 `window.Capacitor` 把
 *   `nativePromise` 录下来，逐条断言「插件名 / 方法名 / 参数」。
 *
 * 能抓到的错：插件名或方法名写错、参数名写错（path vs uri）、
 *   `directory` 值写错、两步写盘的顺序错、临时文件没删、
 *   增量对账算错（该排的没排 / 不该排的重复排）。
 * 抓不到的：插件内部真实行为（那只能靠真机）。
 *
 * 用法：node tests/native_services_test.mjs
 */

/* ---------------- 先铺好浏览器全局（服务模块会用到） ---------------- */

const memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (memStore.has(k) ? memStore.get(k) : null),
  setItem: (k, v) => { memStore.set(k, String(v)); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => memStore.clear(),
};

/** 记录所有原生调用 */
const calls = [];
/** 'Plugin.method' -> (options) => 结果；返回 undefined 表示 resolve(null) */
let handlers = {};

function installNative(on) {
  calls.length = 0;
  if (!on) { globalThis.window = {}; return; }
  globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      nativePromise: async (plugin, method, options) => {
        calls.push({ plugin, method, options: options || {} });
        const h = handlers[`${plugin}.${method}`];
        if (!h) return null;
        return h(options || {});
      },
    },
  };
}

/** 只保留某个插件的调用，便于断言 */
const callsOf = (plugin, method) =>
  calls.filter((c) => c.plugin === plugin && (!method || c.method === method));

/* ---------------- FileReader / File 桩 ---------------- */

globalThis.FileReader = class {
  readAsDataURL(file) {
    const b64 = Buffer.from(file._bytes || []).toString('base64');
    this.result = `data:${file.type};base64,${b64}`;
    queueMicrotask(() => { if (this.onload) this.onload(); });
  }
};

function fakeImage(bytes, type = 'image/png') {
  return { _bytes: bytes, type, name: 'shot.png' };
}

/* ---------------- 加载被测服务 ---------------- */

installNative(true);   // 让 isNative() 一开始就为真
globalThis.document = { addEventListener() {} };

const { OCRService } = await import('../web/js/services/ocr_service.js');
const { ReminderService, LEAD_MINUTES } = await import('../web/js/services/reminder_service.js');

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0, failed = 0;
const failures = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}
function check(label, actual, expected) {
  const a = String(actual), e = String(expected);
  if (a === e) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push({ group: currentGroup, label, actual: a, expected: e });
    console.log(`  \x1b[31m✗\x1b[0m ${label}`);
    console.log(`      期望: ${e}`);
    console.log(`      实际: ${a}`);
  }
}
function ok(label, cond, detail = '') {
  check(label + (detail ? `  （${detail}）` : ''), cond ? 'true' : 'false', 'true');
}

async function throws(label, fn) {
  try {
    await fn();
    check(label, '没有抛错', '抛错');
  } catch (err) {
    check(label, err && err.message ? '抛错' : '抛错', '抛错');
    return err.message;
  }
}

/* ================================================================
   1. OCR：两步写盘 + 识别 + 删临时文件
   ================================================================ */
group('1. 设备端 OCR 的调用链');

const TEMP_URI = 'file:///data/user/0/com.zhouzhouji.app/cache/zzj-ocr-abc.png';

function freshOcr() {
  installNative(true);
  handlers = {
    'Filesystem.writeFile': () => ({ uri: TEMP_URI }),
    'Filesystem.deleteFile': () => undefined,
    'TextRecognition.processImage': () => ({ text: '时间：9月18日 15:00', blocks: [] }),
  };
  return new OCRService();
}

{
  const svc = freshOcr();
  const text = await svc.recognize(fakeImage([1, 2, 3, 4], 'image/png'));

  check('识别结果原样返回', text, '时间：9月18日 15:00');
  check('先写文件、再识别、最后删除', calls.map((c) => c.method).join(' → '),
    'writeFile → processImage → deleteFile');

  const w = callsOf('Filesystem', 'writeFile')[0].options;
  check('writeFile 的插件名与目录', callsOf('Filesystem', 'writeFile')[0].plugin, 'Filesystem');
  check('写入目录是 CACHE（不需要存储权限、系统自动回收）', w.directory, 'CACHE');
  check('data 是纯 base64（不带 dataURL 前缀）', w.data, Buffer.from([1, 2, 3, 4]).toString('base64'));
  ok('data 里不含 "base64,"', !String(w.data).includes('base64,'), String(w.data).slice(0, 12));
  ok('path 带 .png 扩展名', String(w.path).endsWith('.png'), String(w.path));
  ok('path 在应用缓存目录下（不带子目录）', !String(w.path).includes('/'), String(w.path));

  const p = callsOf('TextRecognition', 'processImage')[0].options;
  check('processImage 收到的是 writeFile 返回的 uri', p.path, TEMP_URI);
  check('识别语言用中文模型', p.script, 'CHINESE');

  const d = callsOf('Filesystem', 'deleteFile')[0].options;
  check('删除的正是刚写的那个文件', d.path, w.path);
  check('删除也在 CACHE 目录', d.directory, 'CACHE');
}

/* ---- 扩展名映射 ---- */
{
  for (const [mime, ext] of [['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/heic', 'heic']]) {
    const svc = freshOcr();
    await svc.recognize(fakeImage([9], mime));
    const path = callsOf('Filesystem', 'writeFile')[0].options.path;
    ok(`${mime} → .${ext}`, String(path).endsWith('.' + ext), String(path));
  }
  const svc = freshOcr();
  await svc.recognize(fakeImage([9], 'image/未知'));
  ok('未知 MIME 回退 .png', String(callsOf('Filesystem', 'writeFile')[0].options.path).endsWith('.png'));
}

/* ---- 失败路径 ---- */
{
  const svc = freshOcr();
  handlers['TextRecognition.processImage'] = () => {
    throw new Error('[TextRecognition.processImage] image could not be loaded.');
  };
  const msg = await throws('识别失败会抛错', () => svc.recognize(fakeImage([1])));
  check('临时文件在失败时也被删掉', callsOf('Filesystem', 'deleteFile').length, 1);
  ok('错误信息已翻译成中文', /[\u4e00-\u9fa5]/.test(msg), msg);
  ok('错误信息里没有插件英文前缀', !msg.includes('[TextRecognition'), msg);
}

{
  const svc = freshOcr();
  handlers['Filesystem.writeFile'] = () => ({});
  await throws('writeFile 没返回 uri 时报错', () => svc.recognize(fakeImage([1])));
  check('没写成文件就不该去删', callsOf('Filesystem', 'deleteFile').length, 0);
  check('也不该去调识别', callsOf('TextRecognition', 'processImage').length, 0);
}

{
  const svc = freshOcr();
  const msg = await throws('没有图片时报错', () => svc.recognize(null));
  ok('提示是中文', /[\u4e00-\u9fa5]/.test(msg), msg);
}

/* ---- 原生探测 ---- */
{
  installNative(true);
  const svc = new OCRService();
  check('原生环境下 check() 为真', await svc.check(), true);
  ok('check 不会去联网探测（原生没有本地服务）',
    callsOf('Filesystem').length === 0 && calls.length === 0);
  check('原生模式标记', svc.nativeMode, true);
  ok('能力说明是原生文案', svc.supportHint.includes('应用内置'), svc.supportHint);
}

{
  installNative(false);
  const svc = new OCRService();
  check('浏览器环境下 nativeMode 为假', svc.nativeMode, false);
}

/* ================================================================
   2. 系统闹钟：权限 → 渠道 → 登记
   ================================================================ */
group('2. 系统闹钟的调用链');

function freshReminder({ granted = true } = {}) {
  installNative(true);
  memStore.clear();
  handlers = {
    'LocalNotifications.checkPermissions': () => ({ display: granted ? 'granted' : 'denied' }),
    'LocalNotifications.requestPermissions': () => ({ display: granted ? 'granted' : 'denied' }),
    'LocalNotifications.createChannel': () => undefined,
    'LocalNotifications.schedule': () => ({}),
    'LocalNotifications.cancel': () => undefined,
    'LocalNotifications.getPending': () => ({ notifications: [] }),
  };
  const svc = new ReminderService();
  svc._channelReady = false;
  return svc;
}

/**
 * 造一个「距基准时刻 minutesFromNow 分钟开始」的活动。
 * ⚠️ `base` 必须显式传（各组开头取一次 `Date.now()`）——
 * 否则同一个活动造两次会拿到两个相差几毫秒的 `startDate`，
 * 断言「提前量」时就会随机失败（曾经踩过：期望 …257 / 实际 …255）。
 */
function ev(id, minutesFromNow, base = Date.now()) {
  const d = new Date(base + minutesFromNow * 60000);
  const p = (n) => String(n).padStart(2, '0');
  const startTime = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
  return {
    id, title: `活动${id}`, location: '报告厅',
    startDate: d, startTime,
    timeString: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

/* ---- 权限被拒 ---- */
{
  const svc = freshReminder({ granted: false });
  const okRes = await svc.enable();
  check('权限被拒时 enable 返回 false', okRes, false);
  check('权限被拒时不建渠道', callsOf('LocalNotifications', 'createChannel').length, 0);
  check('权限被拒时不登记闹钟', callsOf('LocalNotifications', 'schedule').length, 0);
  check('权限被拒时不置为已开启', svc.enabled, false);
}

/* ---- 授权后 ---- */
{
  const svc = freshReminder();
  const T0 = Date.now();
  const e7 = ev(7, 3 * 24 * 60, T0);
  svc._getEvents = async () => [e7];
  const okRes = await svc.enable();
  check('授权后 enable 返回 true', okRes, true);
  check('置为已开启', svc.enabled, true);
  check('先查权限再申请', callsOf('LocalNotifications').map((c) => c.method).join(','),
    'requestPermissions,createChannel,schedule');

  const ch = callsOf('LocalNotifications', 'createChannel')[0].options;
  check('渠道 id 固定', ch.id, 'zhouzhouji-events');
  ok('渠道名是中文可读文案', /[\u4e00-\u9fa5]/.test(ch.name), ch.name);
  check('渠道重要性为 4（抬头横幅）', ch.importance, 4);

  const list = callsOf('LocalNotifications', 'schedule')[0].options.notifications;
  check('登记了 1 条', list.length, 1);
  const n = list[0];
  check('通知 id 用活动主键', n.id, 7);
  check('id 是数字（插件要求 32 位整数）', typeof n.id, 'number');
  check('指定了渠道', n.channelId, 'zhouzhouji-events');
  check('指定了状态栏小图标', n.smallIcon, 'ic_stat_zhouzhouji');
  check('指定了大图标', n.largeIcon, 'ic_notification_large');
  ok('标题含活动名', n.title.includes('活动7'), n.title);
  ok('正文含地点', n.body.includes('报告厅'), n.body);
  ok('schedule.at 是 Date 对象', n.schedule.at instanceof Date);
  check('提前量正确（30 分钟）',
    n.schedule.at.getTime(), e7.startDate.getTime() - LEAD_MINUTES * 60000);
  check('允许在 Doze 下唤醒', n.schedule.allowWhileIdle, true);
}

/* ---- 幂等：同样的活动再对一次账，不该重复登记 ---- */
{
  const svc = freshReminder();
  const T0 = Date.now();
  const events = [ev(7, 3 * 24 * 60, T0), ev(8, 4 * 24 * 60, T0)];
  svc._getEvents = async () => events;
  await svc.enable();
  check('首次登记 2 条', callsOf('LocalNotifications', 'schedule')[0].options.notifications.length, 2);

  calls.length = 0;
  await svc.syncNow();
  check('第二次对账不再重复登记', callsOf('LocalNotifications', 'schedule').length, 0);
  check('第二次对账也不误撤', callsOf('LocalNotifications', 'cancel').length, 0);
}

/* ---- 活动时间改了 → 重新登记同一条 ---- */
{
  const svc = freshReminder();
  const T0 = Date.now();
  let events = [ev(7, 3 * 24 * 60, T0)];
  svc._getEvents = async () => events;
  await svc.enable();

  calls.length = 0;
  events = [ev(7, 5 * 24 * 60, T0)];      // 同一个 id，时间变了
  await svc.syncNow();
  const list = callsOf('LocalNotifications', 'schedule')[0].options.notifications;
  check('改时间后重新登记 1 条', list.length, 1);
  check('仍是同一个通知 id（覆盖旧闹钟）', list[0].id, 7);
  check('不需要先撤旧的（同 id 会覆盖）', callsOf('LocalNotifications', 'cancel').length, 0);
}

/* ---- 活动删了 / 已开始 → 撤闹钟 ---- */
{
  const svc = freshReminder();
  const T0 = Date.now();
  let events = [ev(7, 3 * 24 * 60, T0), ev(8, 4 * 24 * 60, T0)];
  svc._getEvents = async () => events;
  await svc.enable();

  calls.length = 0;
  events = [ev(7, 3 * 24 * 60, T0)];      // 8 被删了
  await svc.syncNow();
  const cancelled = callsOf('LocalNotifications', 'cancel')[0].options.notifications;
  check('删掉的活动被撤销', cancelled.length, 1);
  check('撤销的是正确的 id', cancelled[0].id, 8);
  check('剩下的那条不重排', callsOf('LocalNotifications', 'schedule').length, 0);
}

/* ---- 关闭提醒 ---- */
{
  const svc = freshReminder();
  const T0 = Date.now();
  svc._getEvents = async () => [ev(7, 3 * 24 * 60, T0), ev(8, 4 * 24 * 60, T0)];
  await svc.enable();

  calls.length = 0;
  await svc.disable();
  check('关闭后置为未开启', svc.enabled, false);
  const cancelled = callsOf('LocalNotifications', 'cancel')[0].options.notifications;
  check('撤销了全部已登记闹钟', cancelled.length, 2);
  ok('撤销的 id 是 7 和 8',
    cancelled.map((c) => c.id).sort().join(',') === '7,8',
    cancelled.map((c) => c.id).join(','));

  calls.length = 0;
  await svc.syncNow();
  check('关闭后不再登记', callsOf('LocalNotifications', 'schedule').length, 0);
}

/* ---- 窗口内的活动立刻响 ---- */
{
  const svc = freshReminder();
  svc._getEvents = async () => [ev(9, 10)];   // 10 分钟后开始，已在 30 分钟窗口内
  await svc.enable();
  const n = callsOf('LocalNotifications', 'schedule')[0].options.notifications[0];
  const delta = n.schedule.at.getTime() - Date.now();
  ok('窗口内的活动排在「马上」而不是过去', delta >= 0 && delta <= 8000, `${Math.round(delta)} ms`);
}

/* ---- 待响数量 ---- */
{
  const svc = freshReminder();
  svc.enabled = true;
  handlers['LocalNotifications.getPending'] = () => ({ notifications: [{ id: 1 }, { id: 2 }] });
  check('待响数量来自 getPending', await svc.pendingCount(), 2);
}

/* ---- 浏览器环境仍是安全 no-op ---- */
{
  installNative(false);
  const svc = new ReminderService();
  const r = await svc.syncNow();
  check('浏览器里 syncNow 跳过', r.skipped, true);
  check('浏览器里不产生任何原生调用', calls.length, 0);
  check('浏览器里权限状态来自 Notification', svc.permission, 'unsupported');
}

/* ================================================================
   汇总
   ================================================================ */
installNative(false);
console.log('\n' + '='.repeat(56));
if (failed === 0) {
  console.log(`\x1b[32m全部通过：${passed} 项测试\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${failed} 项 / 共 ${passed + failed} 项\x1b[0m`);
  console.log('\n失败清单：');
  failures.forEach((f) => console.log(`  [${f.group}] ${f.label}\n    期望 ${f.expected} / 实际 ${f.actual}`));
}
console.log('='.repeat(56));

process.exit(failed === 0 ? 0 : 1);
