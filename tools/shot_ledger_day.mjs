/**
 * shot_ledger_day.mjs —— 记账页「一天一组」的目视记录（v1.13.5 第三轮）
 *
 * 只出图，不做断言（断言在 `verify_ledger_list.mjs` 第 1/2 组）。
 *
 * 这一轮改的是用户 2026-09-23 提的那一条：
 *   「记账里面同一天的收入和支出放在一起啊」
 *   → 一天只有一个 `.led-day`，组头把两组小计都报出来：
 *     `09月21日 周一 | 支出 22.5 · 收入 500`
 *   （旧版按「日期 → 方向」两级分组，这天会裂成上下两块，看着像两天。）
 *
 * 产出：
 *   tools/shot_r3_1_day_merged.png   同一天收+支的那一组（看合并）
 *   tools/shot_r3_2_day_single.png   只有支出的那天（不该补「收入 0」）
 *
 * 用法：node tools/shot_ledger_day.mjs   （需先 npm run serve）
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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

// 清空流水，播一批「一天只有支出」+「一天有收有支」的数据
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const t = db.transaction(['ledger'], 'readwrite');
    t.objectStore('ledger').clear();
    t.oncomplete = () => res('ok');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);

await page.evaluate(async () => {
  const DB = (await import('./js/services/database_service.js')).default;
  const rows = [
    // 09-22：只有支出 → 组头只报「支出 385」
    { amount: 42.5, direction: 'expense', category: 'meal', note: '跟同事一起AA', date: '2026-09-22' },
    { amount: 142.5, direction: 'expense', category: 'daily', note: '买了一件外套', date: '2026-09-22' },
    { amount: 200, direction: 'expense', category: 'other_ex', note: '话费', date: '2026-09-22' },
    // 09-21：收 + 支 → **同一组**，组头报「支出 22.5 · 收入 500」
    { amount: 22.5, direction: 'expense', category: 'meal', note: '一杯冰美式', date: '2026-09-21' },
    { amount: 500, direction: 'income', category: 'allowance', note: '家里给的', date: '2026-09-21' },
  ];
  for (const r of rows) await DB.addLedgerEntry(r);
});
await wait(400);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

const clickText = (text, sel) => page.evaluate(({ text, sel }) => {
  const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
  if (b) { b.click(); return true; } return false;
}, { text, sel });

await clickText('记录', 'button, .btn, [role="button"]'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);

// ① 同一天收+支的那一组 —— 直接对元素截图，省得跟内部滚动较劲
const groups = await page.$$('.led-day');
if (groups[1]) await groups[1].screenshot({ path: 'tools/shot_r3_1_day_merged.png' });
// ② 只有支出的那天 —— 组头不该补一个「收入 0」
if (groups[0]) await groups[0].screenshot({ path: 'tools/shot_r3_2_day_single.png' });

const info = await page.evaluate(() => ({
  分组数: document.querySelectorAll('.led-day').length,
  组头: [...document.querySelectorAll('.led-day__head')].map((x) => x.textContent.trim()),
}));
console.log(JSON.stringify(info, null, 2));
console.log('→ tools/shot_r3_1_day_merged.png / tools/shot_r3_2_day_single.png');

await browser.close();
