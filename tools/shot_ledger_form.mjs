/**
 * shot_ledger_form.mjs —— 截「记一笔」新表单的图，用于人工确认版式（v1.13.5）
 *
 * 为什么单独一个脚本：这个表单被用户反复调版式，改完要能一眼看到实际效果，
 * 而不是靠读 CSS 猜。产出落在 `tools/shot_ledger_form_*.png`。
 *
 * 用法：node tools/shot_ledger_form.mjs   （需先 npm run serve）
 * ⚠️ 会清空浏览器的 ledger / accounts 两张表（用的是 puppeteer 全新 profile，不影响真机数据）
 */
import { existsSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = 'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const OUT = 'tools';
mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });

const clickText = (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
    if (b) { b.click(); return true; }
    return false;
  }, { text, sel },
);

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

const shot = async (name, sel) => {
  const path = `${OUT}/shot_ledger_form_${name}.png`;
  if (sel) {
    const el = await page.$(sel);
    if (!el) { console.log(`✗ 找不到 ${sel}，跳过 ${name}`); return; }
    await el.screenshot({ path });
  } else {
    await page.screenshot({ path });
  }
  console.log('✓', path);
};

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

/* 清库，重新播种 */
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['ledger', 'accounts'].filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) { res('none'); return; }
    const t = db.transaction(names, 'readwrite');
    names.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => res('cleared');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);

await page.evaluate(async () => {
  const DB = (await import('./js/services/database_service.js')).default;
  const day = (i) => String((i % 28) + 1).padStart(2, '0');
  for (let i = 0; i < 24; i++) {
    await DB.addLedgerEntry({
      amount: 10 + i, direction: 'expense', category: 'meal',
      note: `测试流水 ${i + 1}`, date: `2026-09-${day(i)}`,
    });
  }
});
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

/* 建两个账户 */
await page.evaluate(async () => {
  const { AccountService } = await import('./js/services/account_service.js');
  await AccountService.create({ name: '微信零钱', type: 'wechat', opening: 1200 });
  await AccountService.create({ name: '校园卡', type: 'card', opening: 300 });
});
await wait(300);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);

/* 1. 点「记一笔」后立刻截图 —— 证明没滑到底、金额框在视野里 */
await clickText('记一笔', '.led-action--primary');
await wait(450);
await shot('1_onopen');

/* 2. 表单空态整块 */
await shot('2_empty', '.led-form');

/* 3. 输入 50 + 选分类「餐饮」+ 选账户「微信零钱」 */
await page.click('.led-key[data-key="5"]');
await page.click('.led-key[data-key="0"]');
await wait(200);
await page.click('.led-cat[data-cat="meal"]');
await wait(300);
await page.click('[data-action="pick-account"]');
await wait(500);
await shot('3_account_sheet', '.sheet');
await clickText('微信零钱', '.sheet__item');
await wait(500);
await shot('4_filled', '.led-form');

/* 4. 保存 → 列表 */
await page.click('[data-action="save-entry"]');
await wait(900);
await stableScrollTop();
await shot('5_list_linked');

/* 5. 收入方向也来一张（键盘 + 分类跟着换） */
await clickText('记一笔', '.led-action--primary');
await wait(120);
await stableScrollTop();
await page.click('.led-key[data-dir="income"]');
await wait(500);
await shot('6_income', '.led-form');

/* 6. 同一天既有支出又有收入 —— 组头必须裂成两块，各带各的小计 */
await page.evaluate(() => document.querySelector('[data-action="close-entry"]')?.click());
await wait(400);
await page.evaluate(async () => {
  const DB = (await import('./js/services/database_service.js')).default;
  // ⚠️ 方向常量是 'income' / 'expense'，不是 'in' / 'out'。
  //    写 'in' 会被 LedgerEntry 当成非法值**静默归到 expense**，
  //    连分类也会回退成「其他支出」—— 播种时踩过一次。
  await DB.addLedgerEntry({ amount: 3000, direction: 'income', category: 'parttime', note: '八月兼职', date: '2026-09-23' });
  await DB.addLedgerEntry({ amount: 18.5, direction: 'expense', category: 'transport', note: '地铁', date: '2026-09-23' });
});
await wait(300);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);
// 滚到 09月23日 那一块 —— 它是「同一天既有支出又有收入」，要看到两个胶囊都在
await page.evaluate(() => {
  const body = document.querySelector('.app-body');
  const hit = [...document.querySelectorAll('.led-day')]
    .find((d) => (d.querySelector('.led-day__date')?.textContent || '').includes('09月23日'));
  if (!hit) return;
  // 🔴 位置必须用 getBoundingClientRect 算，不能用 offsetTop：
  //    .app-body / .screen 都没有 position，offsetParent 会一路找到 #app，
  //    量出来会多出头部 + 分段控件 + 月份条那一整段。
  const top = hit.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  body.scrollTop = Math.max(0, top - 26);
});
await stableScrollTop();
await shot('7_mixed_day');

await browser.close();
console.log('done');
