/**
 * verify_ledger_form.mjs —— 「记一笔」底部浮层的回归（v1.13.5 第二轮）
 *
 * 背景：用户先后提了两件事，这个脚本把两件都钉住 ——
 *
 *   ① 2026-09-23 第一次：「点击记一笔后，每次都是自动滑到最底下，
 *      不是显示输入金额在里面」
 *      → 当时的修法是「把表单滚到顶部」。**第二轮改版后这条推导整个作废**：
 *        表单变成 `position: fixed` 的底部浮层，跟页面滚动完全无关。
 *
 *   ② 2026-09-23 第二次：「我要的效果是，从底部弹出一个模块，如图一样，
 *      是一个全新的 ui 模块」
 *      → 于是本脚本现在验证的是**浮层行为**：
 *        从底部弹出 / 页面不被滚动 / 金额框可见 / 三种方式都能关掉 /
 *        关掉后页面滚动位置原封不动 / 连点两次不叠层 / 抢跑取消不留孤儿浮层。
 *
 * 🔴 最值得保留的一条断言是「**打开浮层不会动页面滚动位置**」——
 *    它就是老 bug 的反面：老代码 `root.scrollTop = root.scrollHeight`
 *    会把页面一把撸到底。浮层方案如果哪天被改回内联，这条会立刻红。
 *
 * ⚠️ 三种关闭方式里，「返回键」走的是 `window.__cwBack()`
 *    （main.js 里专门为 E2E 挂的钩子，等价于安卓返回手势）。
 *    浏览器里没有原生返回键，所以浮层自己还挂了个 Esc 监听
 *    （见 ledger_view.js 的 openSheet）—— 第 3 组会单独验一次 Esc。
 *
 * 用法：node tools/verify_ledger_form.mjs   （需先 npm run serve）
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
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
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // 设置页会探测本机 OCR 服务，测试机上必然连接被拒。
  // 按**来源 URL** 过滤，不是按文本（资源加载失败的消息永远是同一句）
  try { if (/127\.0\.0\.1:8765/.test(m.location()?.url || '')) return; } catch { /* 忽略 */ }
  pageErrors.push('[console] ' + m.text());
});

const clickText = (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
    if (b) { b.click(); return true; }
    return false;
  }, { text, sel },
);

/** 等 `.app-body` 的 scrollTop 稳定（`scroll-behavior: smooth`，不能 sleep 固定值） */
async function stableScrollTop(timeout = 4000) {
  let last = null; let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.$eval('.app-body', (el) => Math.round(el.scrollTop)).catch(() => null);
    if (v === null) { await wait(60); continue; }
    if (v === last) { same++; if (same >= 5) return v; } else { same = 0; last = v; }
    await wait(90);
  }
  return last;
}

/* ---------------- 准备：播一批流水，把列表撑长 ---------------- */

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['ledger'].filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) { res('none'); return; }
    const t = db.transaction(names, 'readwrite');
    names.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => res('cleared');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);

// 30 笔，足够让列表超出视口 —— 这样「打开浮层会不会动页面」才测得出东西
await page.evaluate(async () => {
  const DB = (await import('./js/services/database_service.js')).default;
  // ⚠️ 日期必须落在**当前月**：记账页默认只看本月（`month = monthKey(new Date())`），
  //    原来写死 `2026-09`，到了 10 月列表就是空的 → 整个脚本在第 3 组崩掉
  //    （`No element found for selector: .led-item`）。2026-10-13 踩过。
  //    用 1–28 号，任何月份都存在；`getLedgerByMonth` 只按月份前缀过滤，没有上界。
  const n = new Date();
  const ym = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  const day = (i) => String((i % 28) + 1).padStart(2, '0');
  for (let i = 0; i < 30; i++) {
    await DB.addLedgerEntry({
      amount: 10 + i, direction: 'expense', category: 'meal',
      note: `测试流水 ${i + 1}`, date: `${ym}-${day(i)}`,
    });
  }
});
await wait(400);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);

// 先把页面滚到中间 —— 这样「打开浮层后 scrollTop 有没有变」才有意义
await page.evaluate(() => { document.querySelector('.app-body').scrollTop = 260; });
const before = await stableScrollTop();
ok('页面已经滚到中间（否则这个测试没意义）', before > 100, `scrollTop ${before}`);

/* ================================================================
   第 1 组：从底部弹出，且**不动页面滚动**
   ================================================================ */
console.log('\n\x1b[1m第 1 组：从底部弹出，页面纹丝不动\x1b[0m');

await clickText('记一笔', '.led-action--primary');
await wait(500);

const geo = await page.evaluate(() => {
  const overlay = document.querySelector('.modal-overlay--bottom');
  const form = document.querySelector('.led-form');
  const amount = document.querySelector('.input--amount');
  const body = document.querySelector('.app-body');
  if (!overlay || !form || !amount) return null;
  const os = getComputedStyle(overlay);
  const f = form.getBoundingClientRect();
  const a = amount.getBoundingClientRect();
  const o = overlay.getBoundingClientRect();
  return {
    overlayPos: os.position,
    overlayBottomAligned: os.alignItems,
    // 浮层贴着视口底边（允许 2px 误差）
    formGapToBottom: Math.round(window.innerHeight - f.bottom),
    overlayCovers: Math.round(o.height) >= window.innerHeight - 1,
    amountTop: Math.round(a.top), amountBottom: Math.round(a.bottom),
    viewportH: window.innerHeight,
    scrollTop: Math.round(body.scrollTop),
  };
});

ok('浮层已经弹出来了', geo !== null);
if (geo) {
  check('浮层是 fixed 定位（和页面滚动无关）', geo.overlayPos, 'fixed');
  check('浮层贴底对齐', geo.overlayBottomAligned, 'flex-end');
  ok('浮层底边贴住视口底边', geo.formGapToBottom <= 2, `距底 ${geo.formGapToBottom}px`);
  ok('遮罩盖住整个视口', geo.overlayCovers);
  // 🔴 老 bug 的反面：打开表单**不能**动页面滚动
  check('打开浮层没有动页面滚动位置', geo.scrollTop, before);
  // 金额框必须在屏幕里
  ok('金额输入框完整可见',
    geo.amountTop >= 0 && geo.amountBottom <= geo.viewportH,
    `金额 ${geo.amountTop}–${geo.amountBottom} / 视口 0–${geo.viewportH}`);
}

/* ================================================================
   第 2 组：三种方式都能关掉，关掉后页面滚动位置原封不动
   ================================================================ */
console.log('\n\x1b[1m第 2 组：三种关闭方式\x1b[0m');

// 2a 左上角「‹」
await page.click('[data-action="close-entry"]');
await wait(500);
ok('点左上角「‹」能关掉', await page.$('.led-form') === null);
check('关掉后页面滚动位置没变', await stableScrollTop(), before);

// 2b 点遮罩
await clickText('记一笔', '.led-action--primary');
await wait(450);
ok('又弹出来了', await page.$('.led-form') !== null);
await page.evaluate(() => {
  const o = document.querySelector('.modal-overlay--bottom');
  // 点在遮罩**自己**身上（不是子元素），才算「点遮罩」
  o.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await wait(500);
ok('点遮罩能关掉', await page.$('.led-form') === null);

// 2c 返回键（安卓返回手势走的就是这条）
await clickText('记一笔', '.led-action--primary');
await wait(450);
ok('第三次弹出来', await page.$('.led-form') !== null);
// 🔴 用 `window.__cwBack`（main.js 里专门为 E2E 挂的钩子），
//    它走的是真正的 handleBack()：先 dismissTopOverlay()，再谈别的。
//    比直接按 Esc 更接近安卓上的真实路径。
const usedBack = await page.evaluate(() => {
  if (typeof window.__cwBack !== 'function') return false;
  window.__cwBack();
  return true;
});
await wait(500);
ok('返回键能关掉浮层（不是把页面退掉）', await page.$('.led-form') === null);
ok('关浮层后还停在记账页', await page.$('.sum-cell') !== null);
if (!usedBack) {
  // 钩子没了才降级（说明 main.js 那行被删了），单独报一条
  ok('（降级）Esc 也能关掉浮层', await page.$('.led-form') === null);
}
check('关掉后页面滚动位置仍然没变', await stableScrollTop(), before);

/* ================================================================
   第 3 组：重复打开 / 抢跑取消，不能叠层、不能报错、不能留孤儿浮层
   ================================================================ */
console.log('\n\x1b[1m第 3 组：重复打开与抢跑取消\x1b[0m');

// 3a 同一 tick 里连点两次「记一笔」
//    openSheet() 里是 `const keep = draft; if (sheet) closeSheet(); draft = keep;`，
//    漏掉 keep 那一步就会「连点两次 = 弹两层」，而且 draft 被清空后第二层是空表单。
await page.evaluate(() => {
  const b = document.querySelector('.led-action--primary');
  b.click(); b.click();
});
await wait(600);
ok('连点两次仍然只有一层表单', await page.$$eval('.led-form', (els) => els.length) === 1);
check('连点两次只有一层遮罩', await page.$$eval('.modal-overlay', (els) => els.length), 1);
ok('连点后金额框还在（草稿没被清空）', await page.$('.input--amount') !== null);
await page.click('[data-action="close-entry"]');
await wait(450);
check('收干净了：遮罩数量为 0', await page.$$eval('.modal-overlay', (els) => els.length), 0);

// 3b 编辑已有流水时 openForm 要先 await 读挂账账户，这段空档里取消
//    曾经会抛 "Cannot read properties of null (reading 'direction')"
await page.click('.led-item');
await page.waitForSelector('.sheet', { timeout: 4000 });
await clickText('编辑', '.sheet__item');
await wait(120);                                   // 不等它 await 完就取消
const closedEarly = await page.evaluate(() => {
  const b = document.querySelector('[data-action="close-entry"]');
  if (!b) return false;
  b.click();
  return true;
});
await wait(900);
ok('抢跑取消后没有留下孤儿浮层', await page.$('.led-form') === null);
check('浮层数量为 0', await page.$$eval('.modal-overlay', (els) => els.length), 0);
// 3c 抢跑之后表单还能正常再打开（formSeq 只是作废了那一次，不是把功能关死）
await clickText('记一笔', '.led-action--primary');
await wait(600);
ok('抢跑取消后还能正常再打开表单', await page.$('.led-form') !== null);
await page.keyboard.press('Escape');
await wait(450);
ok('Esc 也能关掉浮层（浏览器 / 桌面 PWA 的退出手段）', await page.$('.led-form') === null);
if (!closedEarly) ok('（降级）编辑浮层没来得及开出来', true);

/* ================================================================
   第 4 组：全站浮层的高度尺子（**源码级**断言）
   ================================================================
   用户第二条反馈「数字键盘会要自己上下滑动才可以点击下面的内容」的
   第二层根因是 `vh` —— 手机浏览器里 `vh` 量的是**大视口**（地址栏收起时），
   地址栏一展开真实可见区就比它矮，浮层上沿被顶出屏幕。

   🔴 为什么只能断言**源码**、不能断言渲染结果：
      headless 浏览器没有动态地址栏，`100dvh` 和 `100vh` **永远相等**，
      这条差异在测试环境里根本复现不出来。所以只能钉住
      「两行都在、且 dvh 那行写在后面」——
      防止有人把重复声明当冗余删掉（删掉就退回大视口，手机上的顶被吃掉）。
      ⚠️ 顺序是这条断言的**主要价值**：不认识的声明在解析期就被丢掉，
        把 dvh 写在 vh 前面等于没写。 */
console.log('\n\x1b[1m第 4 组：全站浮层的高度尺子\x1b[0m');

const css = await readFile(new URL('../web/css/style.css', import.meta.url), 'utf8');
/* ⚠️ 同一个选择器可以出现**多块**（`body` 就有两块：138 行的页面底色 +
   156 行的外壳居中），只取第一块会漏掉要断言的属性 —— 全部拼起来。 */
const cssBlocksOf = (sel) => {
  let out = ''; let i = -1;
  while ((i = css.indexOf(`\n${sel} {`, i + 1)) >= 0) {
    out += css.slice(i, css.indexOf('}', i)) + '\n';
  }
  return out;
};

for (const [sel, prop, oldV, newV, why] of [
  ['.led-form', 'max-height', '92vh', '92dvh', '「记一笔」浮层'],
  ['.qsheet', 'max-height', '86vh', '86dvh', '「快速记录」抽屉'],
  ['.input--multiline', 'max-height', '46vh', '46dvh', '多行输入框'],
  ['body', 'min-height', '100vh', '100dvh', '手机外壳（关系到底部导航会不会被挤出去）'],
]) {
  const b = cssBlocksOf(sel);
  ok(`${sel} 规则找得到（${why}）`, b !== '');
  if (!b) continue;
  const iOld = b.indexOf(`${prop}: ${oldV}`);
  const iNew = b.indexOf(`${prop}: ${newV}`);
  ok(`${why}：保留了 ${oldV} 兜底（老 WebView 不认 dvh）`, iOld >= 0);
  ok(`${why}：有 ${newV}（手机浏览器按真实可见高度算）`, iNew >= 0);
  ok(`🔴 ${why}：${newV} 写在 ${oldV} **后面**（顺序反了就等于没写）`, iNew > iOld && iOld >= 0,
    `${oldV}@${iOld} / ${newV}@${iNew}`);
}

/* ================================================================
   第 5 组：控制台
   ================================================================ */
console.log('\n\x1b[1m第 5 组：控制台\x1b[0m');
ok('无未预期的控制台 / 页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

/* ---------------- 汇总 ---------------- */
await browser.close();
console.log('\n' + '='.repeat(56));
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  failures.forEach((f) => console.log(`  · ${f}`));
}
console.log('='.repeat(56));
process.exit(fail === 0 ? 0 : 1);
