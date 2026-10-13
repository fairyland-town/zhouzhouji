/**
 * verify_week_scroll.mjs —— 周历页「进入时自动滚到今天」回归
 *
 * 背景（用户 2026-09-22 报的 bug）：
 *   「每次点击周历的时候，总是跳转到最后，周日，而不是具体的当天日期居中」
 *
 * 根因：`body.scrollTop = sec.offsetTop - 12`。
 *   `offsetTop` 量的是「相对 offsetParent 的距离」，而 `.app-body` 与 `.screen`
 *   都没有 `position` —— 它们的 offsetParent 一路找到 `#app`。于是量出来的是
 *   「相对整个应用顶部」的距离，比在滚动容器里的真实位置多出头部 + 筛选条 +
 *   日期条那一整段（实测 205px）。
 *   多滚 205px 之后：内容够长 → 停在后一天；内容不够长 → scrollTop 被钳到
 *   最大值 → **直接落到周日**。
 *
 * 这个脚本要钉住的**语义**是：「今天那一节必须完整落在可视区内，且尽量居中」，
 * 而不是「scrollTop 等于某个具体数字」—— 后者一改布局就假红。
 *
 * 用法：node tools/verify_week_scroll.mjs   （需先 npm run serve）
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/OCR/.test(m.text())) return;
  // 设置页会探测本机 OCR 服务，测试机上必然连接被拒；按来源 URL 过滤（不是按文本）
  try { if (/127\.0\.0\.1:8765/.test(m.location()?.url || '')) return; } catch { /* 忽略 */ }
  pageErrors.push('[console] ' + m.text());
});

/**
 * 等 `.app-body` 的 scrollTop 稳定下来。
 * 🔴 `scroll-behavior: smooth` 下**绝不能 sleep(固定值) 再断言** ——
 *    动画时长受内容长度影响，写死的等待会随机红绿。
 */
async function stableScrollTop(timeout = 4000) {
  let last = null; let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.$eval('#week-body', (el) => Math.round(el.scrollTop)).catch(() => null);
    if (v === null) { await wait(60); continue; }
    if (v === last) { same++; if (same >= 5) return v; } else { same = 0; last = v; }
    await wait(90);
  }
  return last;
}

/** 今天那一节相对滚动容器的几何 */
function todayGeometry() {
  return page.evaluate(() => {
    const body = document.querySelector('#week-body');
    const sec = document.querySelector('.day-section--today');
    if (!body || !sec) return null;
    const box = body.getBoundingClientRect();
    const s = sec.getBoundingClientRect();
    const days = [...document.querySelectorAll('.day-section')];
    return {
      scrollTop: Math.round(body.scrollTop),
      maxScroll: Math.round(body.scrollHeight - body.clientHeight),
      clientHeight: Math.round(body.clientHeight),
      secHeight: Math.round(s.height),
      secTopInBody: Math.round(s.top - box.top),
      secBottomInBody: Math.round(s.bottom - box.top),
      todayIndex: days.indexOf(sec),
      todayName: sec.querySelector('.day-section__name').textContent.trim(),
      lastDayName: days[days.length - 1].querySelector('.day-section__name').textContent.trim(),
    };
  });
}

/** 断言：今天那一节完整落在可视区内 */
function assertTodayVisible(g, tag) {
  ok(`${tag}：今天那一节完整可见（顶部没被切）`, g.secTopInBody >= -1, `top=${g.secTopInBody}px`);
  ok(`${tag}：今天那一节完整可见（底部没被切）`, g.secBottomInBody <= g.clientHeight + 1,
    `bottom=${g.secBottomInBody} / 视口高=${g.clientHeight}`);
}

async function gotoWeek() {
  await page.waitForSelector('.bottom-nav__item', { timeout: 5000 });
  await page.$$eval('.bottom-nav__item', (els) => els.find((e) => e.dataset.route === 'week').click());
  await page.waitForSelector('.day-section--today, .day-section', { timeout: 5000 });
}

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(700);

/* ================================================================
   场景 A：本周内容明显高于视口（用户报 bug 时的典型情形）
   ================================================================ */
console.log('\n\x1b[1m场景 A：本周每天 2 条活动（内容远高于视口）\x1b[0m');
await page.evaluate(async () => {
  const { default: db } = await import('/js/services/database_service.js');
  const { startOfWeek, addDays, formatDate } = await import('/js/utils/date_utils.js');
  for (const e of await db.getAll()) await db.remove(e.id);
  const mon = startOfWeek(new Date());
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 2; j++) {
      const ds = formatDate(addDays(mon, i));
      await db.add({
        title: '滚动回归 ' + i + '-' + j, location: '信息楼A201', rawText: '',
        startTime: ds + ' ' + (9 + j) + ':00',
      });
    }
  }
});
await page.reload({ waitUntil: 'networkidle2' });
await wait(700);
await gotoWeek();
const aTop = await stableScrollTop();
const A = await todayGeometry();
console.log(`      今天=周${A.todayName.slice(-1)}（第 ${A.todayIndex + 1} 天）· scrollTop ${aTop} / 上限 ${A.maxScroll}`);
assertTodayVisible(A, 'A');
ok('A：没有把今天滚过头（今天顶部不高于可视区顶部）', A.secTopInBody >= -1, `${A.secTopInBody}px`);
// 🔴 这条是用户报的那个 bug 的直接反例：内容够长时不该停在周日
ok('A：没有直接落到周日', !(A.scrollTop >= A.maxScroll - 2 && A.todayIndex < 6),
  `scrollTop ${A.scrollTop} / 上限 ${A.maxScroll} / 今天第 ${A.todayIndex + 1} 天`);
await page.screenshot({ path: 'tools/shot_week_today.png', fullPage: false });
console.log('  已保存 tools/shot_week_today.png');

/* ================================================================
   场景 B：本周内容很矮（不够滚）—— 原来这里必定落到周日
   ================================================================ */
console.log('\n\x1b[1m场景 B：本周只有 1 条活动（内容矮于视口）\x1b[0m');
await page.evaluate(async () => {
  const { default: db } = await import('/js/services/database_service.js');
  for (const e of await db.getAll()) await db.remove(e.id);
});
await page.reload({ waitUntil: 'networkidle2' });
await wait(700);
await gotoWeek();
const bTop = await stableScrollTop();
const B = await todayGeometry();
console.log(`      内容高度不足以滚动时 scrollTop=${bTop} / 上限 ${B.maxScroll}`);
assertTodayVisible(B, 'B');
ok('B：内容不够滚时不乱跳（scrollTop 必须为 0）', bTop === 0, `实际 ${bTop}`);

/* ================================================================
   场景 C：切到上一周 —— 不该自动滚到今天（今天不在那一周里）
   ================================================================ */
console.log('\n\x1b[1m场景 C：切到上一周，不该自动滚动\x1b[0m');
await page.$$eval('.week-nav__btn', (els) => els[0].click()); // 第一个是「上一周」
await wait(500);
const cTop = await stableScrollTop();
const C = await page.evaluate(() => {
  const body = document.querySelector('#week-body');
  return { scrollTop: Math.round(body.scrollTop), hasToday: !!document.querySelector('.day-section--today') };
});
check('C：上一周没有「今天」那一节', C.hasToday, false);
check('C：上一周不自动滚动', cTop, 0);

/* ================================================================
   场景 D：点「回到本周」→ 又回到今天
   ================================================================ */
console.log('\n\x1b[1m场景 D：点「回到本周」\x1b[0m');
await page.evaluate(async () => {
  const { default: db } = await import('/js/services/database_service.js');
  const { startOfWeek, addDays, formatDate } = await import('/js/utils/date_utils.js');
  for (const e of await db.getAll()) await db.remove(e.id);
  const mon = startOfWeek(new Date());
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 2; j++) {
      const ds = formatDate(addDays(mon, i));
      await db.add({
        title: '滚动回归 ' + i + '-' + j, location: '信息楼A201', rawText: '',
        startTime: ds + ' ' + (9 + j) + ':00',
      });
    }
  }
});
await page.reload({ waitUntil: 'networkidle2' });
await wait(700);
await gotoWeek();
await stableScrollTop();
await page.$$eval('.week-nav__btn', (els) => els[0].click()); // 退到上一周
await wait(500);
const backBtn = await page.$('.today-btn');
ok('D：「回到本周」按钮出现', backBtn !== null);
if (backBtn) {
  await page.$eval('.today-btn', (el) => el.click());
  await wait(500);
  await stableScrollTop();
  const D = await todayGeometry();
  assertTodayVisible(D, 'D');
  ok('D：回到本周后今天又居中', Math.abs(D.secTopInBody - (D.clientHeight - D.secHeight) / 2) <= 10,
    `secTop ${D.secTopInBody} / 期望约 ${Math.round((D.clientHeight - D.secHeight) / 2)}`);
}

/* ================================================================
   场景 E：点日期条上的某一天，应滚到那一天
   ⚠️ 分两天测，因为语义不同：
      中间那天能被顶到可视区顶部；**周日是最后一节，物理上顶不到顶部**
      （要它贴顶就得滚过 maxScroll），只能要求「完整可见 + 已滚到底」。
   ================================================================ */
console.log('\n\x1b[1m场景 E：点日期条跳转\x1b[0m');
await gotoWeek();
await stableScrollTop();

const geoOf = (idx) => page.evaluate((i) => {
  const body = document.querySelector('#week-body');
  const sec = document.querySelectorAll('.day-section')[i];
  const box = body.getBoundingClientRect();
  const s = sec.getBoundingClientRect();
  return {
    name: sec.querySelector('.day-section__name').textContent.trim(),
    top: Math.round(s.top - box.top),
    bottom: Math.round(s.bottom - box.top),
    clientHeight: Math.round(body.clientHeight),
    scrollTop: Math.round(body.scrollTop),
    maxScroll: Math.round(body.scrollHeight - body.clientHeight),
  };
}, idx);

// E1：中间那天（周四）—— 应该贴到可视区顶部
await page.$$eval('.weekday-chip', (els) => els[3].click());
await wait(400);
await stableScrollTop();
const E1 = await geoOf(3);
check('E1：点周四跳到周四', E1.name, '周四');
ok('E1：周四被顶到可视区顶部', E1.top <= 24 && E1.top >= -24, `距顶部 ${E1.top}px`);

// E2：最后一天（周日）—— 顶不到顶部，但必须完整可见且已滚到底
await page.$$eval('.weekday-chip', (els) => els[6].click());
await wait(400);
await stableScrollTop();
const E2 = await geoOf(6);
check('E2：点周日跳到周日', E2.name, '周日');
ok('E2：周日完整可见', E2.top >= -1 && E2.bottom <= E2.clientHeight + 1,
  `top=${E2.top} bottom=${E2.bottom} / 视口高=${E2.clientHeight}`);
ok('E2：已经滚到底（周日是最后一节，贴不了顶是正常的）',
  E2.scrollTop >= E2.maxScroll - 2, `scrollTop ${E2.scrollTop} / 上限 ${E2.maxScroll}`);

console.log('\n未捕获异常：' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
ok('无未捕获异常 / 控制台错误', pageErrors.length === 0);

console.log('\n' + '='.repeat(60));
if (fail) {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  failures.forEach((f) => console.log('  · ' + f));
} else {
  console.log(`\x1b[32m周历页滚动全部通过：${pass} 项\x1b[0m`);
}
console.log('='.repeat(60));
await browser.close();
process.exit(fail ? 1 : 0);
