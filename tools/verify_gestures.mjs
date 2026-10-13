/**
 * verify_gestures.mjs —— 记录页翻页手势 + 安卓返回键逐层回退（v1.13.0）
 *
 * 覆盖两条用户诉求：
 *   ① 「记录板块里面不能左右滑动来进行下一个板块」
 *   ② 「整个软件没有返回功能…滑两次就直接退出软件（是安卓全面屏手势那种）」
 *
 * 返回键在浏览器里没有真事件，所以这里直接调 `window.__cwBack()`
 * —— 那正是原生 backButton 监听回调里调用的同一个函数，
 * 测它等价于测真实链路（原生那一层只负责把事件转成这次调用）。
 *
 * 用法：node tools/verify_gestures.mjs   （需先 npm run serve）
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0; let fail = 0;
const failures = [];
function check(label, actual, expected) {
  const a = String(actual); const e = String(expected);
  if (a === e) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); } else {
    fail++; failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}\n      期望 ${e} / 实际 ${a}`);
  }
}
const ok = (label, cond, extra = '') => check(label + (extra ? `（${extra}）` : ''), !!cond, true);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 430, height: 860 },
});
const page = await browser.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('.app-header', { timeout: 8000 });
await wait(500);

/**
 * 在 .record-body-host 上派发一串真实 TouchEvent。
 *
 * 🔴 必须分步派发（touchstart → 多次 touchmove → touchend），
 *    不能一步到位：轴向判定靠的是**第一段位移的方向**，
 *    一次性给到终点的话，第一次 touchmove 就已经跨过阈值，
 *    判定仍然正确，但拿不到「中途跟手」的验证；而且真实手势本来就是多帧的。
 */
const swipe = (dir, dist = 150) => page.evaluate((dir2, dist2) => {
  const host = document.querySelector('.record-body-host');
  if (!host) return 'no-host';
  const r = host.getBoundingClientRect();
  const y = r.top + r.height / 2;
  const x0 = dir2 === 'left' ? r.left + r.width - 40 : r.left + 40;
  const x1 = dir2 === 'left' ? x0 - dist2 : x0 + dist2;
  const mk = (type, x) => {
    const t = new Touch({ identifier: 1, target: host, clientX: x, clientY: y });
    const empty = type === 'touchend';
    return new TouchEvent(type, {
      touches: empty ? [] : [t],
      changedTouches: [t],
      targetTouches: empty ? [] : [t],
      bubbles: true, cancelable: true,
    });
  };
  host.dispatchEvent(mk('touchstart', x0));
  for (let i = 1; i <= 6; i++) host.dispatchEvent(mk('touchmove', x0 + (x1 - x0) * i / 6));
  host.dispatchEvent(mk('touchend', x1));
  return 'ok';
}, dir, dist);

/** 纵向手势：应当交给浏览器滚动，绝不能翻页 */
const swipeVertical = () => page.evaluate(() => {
  const host = document.querySelector('.record-body-host');
  const r = host.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height * 0.72;
  const mk = (type, cy) => {
    const t = new Touch({ identifier: 1, target: host, clientX: x, clientY: cy });
    const empty = type === 'touchend';
    return new TouchEvent(type, {
      touches: empty ? [] : [t], changedTouches: [t], targetTouches: empty ? [] : [t],
      bubbles: true, cancelable: true,
    });
  };
  host.dispatchEvent(mk('touchstart', y));
  for (let i = 1; i <= 6; i++) host.dispatchEvent(mk('touchmove', y - 20 * i));
  host.dispatchEvent(mk('touchend', y - 120));
});

const activeTab = () => page.$eval('.segmented__item--active', (el) => el.textContent.trim());
const onRoute = (cls) => page.evaluate((c) => !!document.querySelector(c), cls);
const back = () => page.evaluate(() => window.__cwBack());

async function gotoRecord() {
  await page.$$eval('.bottom-nav__item', (els) => els.find((e) => e.dataset.route === 'record').click());
  await page.waitForSelector('.record-body-host', { timeout: 5000 });
  await wait(350);
}

/* ---------------- 1. 左右滑动翻板块 ---------------- */

console.log('\n\x1b[1m1. 记录页左右滑动翻板块\x1b[0m');
await gotoRecord();
check('初始板块', await activeTab(), '打卡');

await swipe('left'); await wait(600);
check('左滑一次 → 待办', await activeTab(), '待办');
await swipe('left'); await wait(600);
check('再左滑 → 记账', await activeTab(), '记账');
await swipe('left'); await wait(600);
check('再左滑 → 账户', await activeTab(), '账户');
await swipe('left'); await wait(600);
check('末板块左滑不越界', await activeTab(), '账户');
await swipe('right'); await wait(600);
check('右滑一次 → 记账', await activeTab(), '记账');
await swipe('right'); await wait(600);
check('再右滑 → 待办', await activeTab(), '待办');
await swipe('right'); await wait(600);
check('再右滑 → 打卡', await activeTab(), '打卡');
await swipe('right'); await wait(600);
check('首板块右滑不越界', await activeTab(), '打卡');

await swipeVertical(); await wait(500);
check('纵向滑动不翻页', await activeTab(), '打卡');

// 短距离滑动不该翻页（防止误触）
await swipe('left', 30); await wait(500);
check('位移太小不翻页', await activeTab(), '打卡');

// 点击分段控件仍然有效（手势不能把点击吃掉）
await page.$$eval('.segmented__item', (els) => els.find((e) => e.dataset.tab === 'ledger').click());
await wait(450);
check('点分段控件照样能切', await activeTab(), '记账');
await page.$$eval('.segmented__item', (els) => els.find((e) => e.dataset.tab === 'checkin').click());
await wait(450);

/* ---------------- 2. 返回键逐层回退 ---------------- */

console.log('\n\x1b[1m2. 返回键：浮层 → 子板块 → 路由 → 两步退出\x1b[0m');
await page.click('.bottom-nav__fab');
await page.waitForSelector('.qsheet', { timeout: 4000 });
await wait(400);
ok('抽屉已打开', !!(await page.$('.qsheet')));
check('返回键被消费（返回 true）', await back(), 'true');
await wait(300);
check('返回键关掉了抽屉', (await page.$('.qsheet')) === null, 'true');
ok('关抽屉后没退页面（仍在记录页）', await onRoute('.screen--record'));

await swipe('left'); await wait(600);
check('先左滑到待办', await activeTab(), '待办');
await back(); await wait(450);
check('返回键先退回第一个板块', await activeTab(), '打卡');
ok('退回板块后仍在记录页', await onRoute('.screen--record'));

await back(); await wait(450);
ok('再按返回 → 回到周历', await onRoute('.screen--week'));

await back(); await wait(250);
const toastTxt = await page.$eval('#toast', (el) => el.textContent.trim()).catch(() => '');
check('根页面首次返回提示两步退出', toastTxt, '再滑一次返回即退出');
ok('应用未退出（页面还在）', await onRoute('.app-header'));

/* ---------------- 3. 返回栈不残留 ---------------- */

console.log('\n\x1b[1m3. 返回栈：保存回首页后不该残留\x1b[0m');
// 记录 → 返回 → 应该正好回到周历，而不是先弹出一个已经走过的页面
await gotoRecord();
await back(); await wait(450);
ok('记录页返回 → 周历', await onRoute('.screen--week'));
await gotoRecord();
await back(); await wait(450);
await back(); await wait(300);
const t2 = await page.$eval('#toast', (el) => el.textContent.trim()).catch(() => '');
check('连续往返后根页面仍在，且回到「两步退出」', t2, '再滑一次返回即退出');

// 设置页返回（原来用的是 ctx.go('week')，会往栈里塞一条，改成 ctx.back() 后应干净）
await page.evaluate(() => {
  const btn = document.querySelector('.page-header__action, .app-header button');
  if (btn) btn.click();
});
await wait(400);
if (await page.$('.screen--settings')) {
  await page.$eval('.page-header__back', (el) => el.click());
  await wait(450);
  ok('设置页返回 → 周历', await onRoute('.screen--week'));
  await back(); await wait(300);
  const t3 = await page.$eval('#toast', (el) => el.textContent.trim()).catch(() => '');
  check('设置页返回后返回键直接到「两步退出」（栈没残留）', t3, '再滑一次返回即退出');
} else {
  console.log('  （未找到设置入口，跳过设置页返回检查）');
}

/* ---------------- 截图 ---------------- */

await gotoRecord();
await page.screenshot({ path: 'tools/shot_record_swipe.png' });
console.log('  已保存 tools/shot_record_swipe.png');

console.log('\n未捕获异常：' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
check('无未捕获异常', pageErrors.length, 0);
// OCR 服务没起时会有一个 ERR_CONNECTION_REFUSED 的资源请求错误 ——
// 那是设计内的降级（前端会提示改用粘贴文字），不是缺陷（与 E2E 同一口径）
const realErrors = consoleErrors.filter((e) => !/ERR_CONNECTION_REFUSED|127\.0\.0\.1:8765/.test(e));
check('无控制台错误（OCR 未启动的降级提示除外）', realErrors.length, 0);
if (realErrors.length) realErrors.forEach((e) => console.log('      ' + e));

console.log('\n' + '='.repeat(60));
if (fail) {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  failures.forEach((f) => console.log('  · ' + f));
} else {
  console.log(`\x1b[32m手势与返回键全部通过：${pass} 项\x1b[0m`);
}
console.log('='.repeat(60));
await browser.close();
process.exit(fail ? 1 : 0);
