/**
 * verify_skip.mjs —— 「可跳过」字段真的能跳过 + 日期多格式回归
 *
 * 用户 2026-09-22 报的两个问题：
 *   1.「标注的可跳过的所有的模块都不能跳过，一旦跳过，就保存不了」
 *   2.「所有填写日期的时候不应该只有一种格式 2026-10-08。
 *      2026.3.8 这种以及 2026.09.08 都可以」
 *
 * 问题 1 的根因（🔴 这个脚本存在的意义就是钉死它）：
 *   `promptDialog` 的 `read()` 原本写的是 `input.value.trim() || null`，
 *   于是**留空确定**和**点取消**都 resolve `null`。调用方写的
 *   `if (due === null) return;`（本意是「取消就别记了」）就把
 *   老老实实留空跳过的用户一起挡在门外 —— 整笔账静默丢掉，连提示都没有。
 *   现在契约是三态：null = 取消 / '' = 明确留空 / 其它 = 输入内容。
 *
 * 这个脚本**必须走真实 UI**（点弹窗按钮），不能直接调 Service ——
 * 因为 bug 就在「弹窗返回什么值」这一层，绕过 UI 就永远测不到。
 *
 * 用法：node tools/verify_skip.mjs   （需先 npm run serve）
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
  // 🔴 必须按**来源 URL** 过滤：资源加载失败的文本永远是同一句
  //    「Failed to load resource: net::ERR_XXX」，从文本里分不出是谁在报错。
  try { if (/127\.0\.0\.1:8765/.test(m.location()?.url || '')) return; } catch { /* 忽略 */ }
  pageErrors.push('[console] ' + m.text());
});

/* ---------------- 通用操作 ---------------- */

const clickText = (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
    if (b) { b.click(); return true; }
    return false;
  }, { text, sel },
);

/** 在输入弹窗里填值（空串 = 留空）并点某个按钮 */
async function fillModal(value, btnText) {
  await page.waitForSelector('.modal .input', { timeout: 4000 });
  await page.evaluate((v) => {
    const el = document.querySelector('.modal .input--multiline, .modal .input, .modal input');
    if (!el) return;
    el.focus(); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await wait(220);
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.modal button')]
      .find((x) => (x.textContent || '').trim() === t);
    if (b) b.click();
  }, btnText);
  await wait(520);
}

/** 弹窗是否还在（用来验证「必填项不该被静默关掉」） */
const modalOpen = () => page.$('.modal') .then((x) => !!x);
const modalHint = () => page.evaluate(() => {
  const el = document.querySelector('.modal .modal__hint');
  if (!el) return '';
  const visible = el.style.display !== 'none' && el.offsetParent !== null;
  return visible ? (el.textContent || '').trim() : '';
});

/**
 * 打开「借出 / 借入 / 定期」的 actionSheet，把里面的条目文案读出来。
 * 返回 `{ title, items }`；打不开就返回 null。
 */
async function readSheet(triggerAction) {
  await page.click(`[data-action="${triggerAction}"]`).catch(() => {});
  await wait(650);
  const data = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    if (!sheet) return null;
    return {
      title: (sheet.querySelector('.sheet__title')?.textContent || '').trim(),
      items: [...sheet.querySelectorAll('.sheet__item')]
        .map((e) => (e.textContent || '').trim())
        .filter((t) => t !== '取消'),
    };
  });
  await clickText('取消', '.sheet__item');
  await wait(450);
  return data;
}

/* ---------------- 准备：清库 + 建一个账户 ---------------- */

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

// 每次 puppeteer 都是全新 profile，理论上库本来就是空的；
// 这里显式清一遍 accounts / kv，避免「上一次跑剩的数据」把断言弄成假绿。
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['accounts', 'kv'].filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) { res('none'); return; }
    const t = db.transaction(names, 'readwrite');
    names.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => res('cleared');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

await clickText('记录'); await wait(800);
await clickText('账户', '.segmented__item'); await wait(900);

console.log('\n\x1b[1m准备：建一个账户，好让资产格子渲染出来\x1b[0m');
await clickText('新建第一个账户'); await wait(650);
if (!(await page.$('.modal .input'))) await page.click('[data-action="new-account"]');
await fillModal('一食堂饭卡', '下一步');
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.sheet button, .modal button')]
    .find((x) => (x.textContent || '').includes('饭卡'));
  if (b) b.click();
});
await wait(600);
await fillModal('100', '创建');
await wait(700);
ok('账户已建好，资产格子出现', await page.$('[data-action="loan-out"]') !== null);

/* ================================================================
   第 1 组：借出 —— 跳过「约定哪天还」必须能存进去（D1 的核心）
   ================================================================ */
console.log('\n\x1b[1m第 1 组：借出 · 留空跳过到期日 → 必须真的保存\x1b[0m');

const before1 = await readSheet('loan-out');
const nBefore1 = (before1?.items || []).length;

await page.click('[data-action="loan-out"]'); await wait(650);
await clickText('记一笔借出', '.sheet__item'); await wait(650);
await fillModal('同学小李', '下一步');
await fillModal('200', '下一步');
// 🔴 关键动作：留空 → 点「保存」。改之前这里会把整笔账丢掉。
await fillModal('', '保存');
await wait(700);

const after1 = await readSheet('loan-out');
const items1 = after1?.items || [];
check('留空跳过后，借出条目数 +1', items1.length, nBefore1 + 1);
ok('新借出条目出现在列表里', items1.some((t) => t.includes('同学小李')), items1.join(' | '));
ok('金额记对了 ¥200.00', items1.some((t) => t.includes('同学小李') && t.includes('200.00')));
ok('跳过的到期日没有被瞎填', !items1.some((t) => t.includes('同学小李') && t.includes('到期')));

/* ================================================================
   第 2 组：借出 —— 取消仍然要中止（别把「取消」也当成「跳过」）
   ================================================================ */
console.log('\n\x1b[1m第 2 组：借出 · 在到期日那步点「取消」→ 整笔不该落库\x1b[0m');

const nBefore2 = (after1?.items || []).length;
await page.click('[data-action="loan-out"]'); await wait(650);
await clickText('记一笔借出', '.sheet__item'); await wait(650);
await fillModal('不该被保存的人', '下一步');
await fillModal('999', '下一步');
await fillModal('', '取消');            // 取消 = 中止整个流程
await wait(700);

const after2 = await readSheet('loan-out');
const items2 = after2?.items || [];
check('取消后条目数不变', items2.length, nBefore2);
ok('「不该被保存的人」没有落库', !items2.some((t) => t.includes('不该被保存的人')), items2.join(' | '));

/* ================================================================
   第 3 组：借出 —— 日期多格式（D2）
   ================================================================ */
console.log('\n\x1b[1m第 3 组：到期日多格式 —— 2026.3.8 / 2026/3/8 / 2026年3月8日\x1b[0m');

const dateCases = [
  { input: '2026.3.8', label: '2026.3.8', want: '03-08' },
  { input: '2026/3/8', label: '2026/3/8', want: '03-08' },
  { input: '2026-10-8', label: '2026-10-8（日不补零）', want: '10-08' },
  { input: '2026年3月8日', label: '2026年3月8日', want: '03-08' },
  { input: '2026.09.08', label: '2026.09.08', want: '09-08' },
];

for (const c of dateCases) {
  await page.click('[data-action="loan-out"]'); await wait(620);
  await clickText('记一笔借出', '.sheet__item'); await wait(620);
  await fillModal(`格式${c.want}`, '下一步');
  await fillModal('50', '下一步');
  await fillModal(c.input, '保存');
  await wait(680);
  const s = await readSheet('loan-out');
  const row = (s?.items || []).find((t) => t.includes(`格式${c.want}`));
  ok(`${c.label} 被认成 ${c.want}`, !!row && row.includes(`${c.want} 到期`), row || '（没找到这一条）');
}

// 看不懂的日期必须报错、且**不落库**（不能静默存个空值）
console.log('\n\x1b[1m第 3b 组：看不懂的日期 → 提示 + 不落库\x1b[0m');
const nBefore3 = (await readSheet('loan-out'))?.items.length ?? 0;
await page.click('[data-action="loan-out"]'); await wait(620);
await clickText('记一笔借出', '.sheet__item'); await wait(620);
await fillModal('写错日期的人', '下一步');
await fillModal('30', '下一步');
await fillModal('2026-02-31', '保存');   // 格式对，但那天不存在
await wait(700);
const after3 = await readSheet('loan-out');
check('乱填日期后条目数不变', (after3?.items || []).length, nBefore3);
ok('「写错日期的人」没有落库', !(after3?.items || []).some((t) => t.includes('写错日期的人')));

/* ================================================================
   第 4 组：定期 —— 利率和到期日两个「可跳过」都要能跳
   ================================================================ */
console.log('\n\x1b[1m第 4 组：定期 · 利率留空 + 到期日留空 → 必须真的保存\x1b[0m');

const before4 = await readSheet('deposit');
const nBefore4 = (before4?.items || []).length;

await page.click('[data-action="deposit"]'); await wait(620);
await clickText('登记一笔定期', '.sheet__item'); await wait(620);
await fillModal('一年期定存', '下一步');
await fillModal('10000', '下一步');
await fillModal('', '下一步');     // 利率留空 = 跳过
await fillModal('', '保存');       // 到期日留空 = 跳过
await wait(750);

const after4 = await readSheet('deposit');
const items4 = after4?.items || [];
check('两个「可跳过」都跳过后，定期条目数 +1', items4.length, nBefore4 + 1);
ok('定期条目出现了', items4.some((t) => t.includes('一年期定存')), items4.join(' | '));
ok('本金记对了 ¥10,000.00', items4.some((t) => t.includes('一年期定存') && t.includes('10,000.00')));
ok('没填利率时不显示百分比', !items4.some((t) => t.includes('一年期定存') && t.includes('%')));

/* ================================================================
   第 5 组：必填项留空 → 弹窗要**留在原地**并提示，不能静默关掉
   ================================================================ */
console.log('\n\x1b[1m第 5 组：必填项留空 → 就地提示，而不是「点了没反应」\x1b[0m');

await page.click('[data-action="new-account"]').catch(() => {});
await wait(650);
if (!(await page.$('.modal .input'))) {
  await clickText('新建账户', '.acct-section-title, button');
  await wait(650);
}
await fillModal('', '下一步');
ok('必填项留空时弹窗没有关闭', await modalOpen());
const hint5 = await modalHint();
ok('并且就地给出了提示文字', hint5.length > 0, hint5 || '（提示为空）');

// 收尾：把弹窗关掉，别让残留浮层影响后面的页面错误检查
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.modal button')]
    .find((x) => (x.textContent || '').trim() === '取消');
  if (b) b.click();
});
await wait(500);

/* ================================================================
   第 6 组：整场跑下来不该有控制台错误
   ================================================================ */
console.log('\n\x1b[1m第 6 组：控制台\x1b[0m');
ok('无未预期的控制台 / 页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

/* ================================================================
   第 7 组：全局兜底 —— 异步处理器抛错不能变成「点了没反应」
   （⚠️ 这一组**故意**制造错误，所以必须排在控制台检查之后）
   ================================================================ */
console.log('\n\x1b[1m第 7 组：未捕获的异步错误 → 必须弹人话，不能静默\x1b[0m');

/**
 * 🔴 关键：触发错误必须用**同源脚本**，不能用 `page.evaluate` 直接抛。
 *
 * `page.evaluate` 的代码在 Chrome 眼里是「另一个源」，抛出的错误会被
 * **脱敏**：`e.error` 变成 `null`、`e.message` 变成 "Script error."。
 * 拿它测兜底处理器会得到**假阴性** —— 处理器其实好好的，只是收到的
 * 事件里根本没有 error 对象（我在这上面踩过，查了三轮才定位）。
 *
 * 所以这里往页面里注入一段真正的同源内联脚本，由它来抛。
 */
await page.evaluate(() => {
  const s = document.createElement('script');
  s.textContent = `
    window.__probeThrow = (msg) => { setTimeout(() => { throw new Error(msg); }, 0); };
    window.__probeReject = (msg) => { setTimeout(() => { Promise.reject(new Error(msg)); }, 0); };
    window.__probeRejectNoMsg = () => { setTimeout(() => { Promise.reject({ code: 42 }); }, 0); };
  `;
  document.head.appendChild(s);
});
await wait(200);

/** 读当前 toast 的文案（没有可见 toast 就返回 ''） */
const toastText = () => page.evaluate(() => {
  const el = document.getElementById('toast');
  if (!el || !el.className.includes('is-visible')) return '';
  return (el.textContent || '').trim();
});
const clearToast = () => page.evaluate(() => {
  const el = document.getElementById('toast');
  if (el) el.className = 'toast';
});

// 7a：同源脚本同步抛错 → 必须弹提示（否则就是「点了没反应」）
await page.evaluate(() => window.__probeThrow('同步炸了'));
await wait(400);
const t1 = await toastText();
ok('同步未捕获错误弹出了提示', t1.length > 0, t1 || '（没有 toast）');
ok('提示不是「undefined」或「Script error.」',
  !/undefined|Script error/i.test(t1), t1);

await clearToast();

// 7b：同源脚本未捕获的 Promise 拒绝 → 这正是「异步按钮点了没反应」的来源
await page.evaluate(() => window.__probeReject('异步炸了'));
await wait(400);
const t2 = await toastText();
ok('未捕获的异步拒绝弹出了提示', t2.length > 0, t2 || '（没有 toast）');
ok('提示里带上了原始原因', t2.includes('异步炸了'), t2);

await clearToast();

// 7c：拒绝的值**没有 message**（模拟 Capacitor / DOMException）
//     —— 这正是「空白气泡」和「undefined 气泡」的来源
await page.evaluate(() => window.__probeRejectNoMsg());
await wait(400);
const t3 = await toastText();
ok('没有 message 的拒绝也有兜底文案（不是空白气泡）', t3.length > 0, t3 || '（空白气泡！）');
ok('兜底文案里没有「undefined」', !t3.includes('undefined'), t3);
ok('兜底文案里没有「[object Object]」这种开发者黑话',
  !/\[object |null$/.test(t3), t3);

// 7d：直接调 toast('')，确认空串不会渲染成空白
const t4 = await page.evaluate(async () => {
  const { toast } = await import('./js/utils/dom.js');
  toast('', 'error');
  await new Promise((r) => setTimeout(r, 60));
  return (document.getElementById('toast').textContent || '').trim();
});
ok("toast('') 不会渲染成空白气泡", t4.length > 0, t4 || '（空白气泡！）');

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
