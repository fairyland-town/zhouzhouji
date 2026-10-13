/**
 * shot_v1135_round2.mjs —— 人工看版式用（不是回归脚本）。
 * 出图：tools/shot_r2_*.png
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js'].find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => { await page.screenshot({ path: `tools/shot_r2_${name}.png` }); console.log(`✓ tools/shot_r2_${name}.png`); };
const clickText = (page, t, s = 'button, .btn, [role="button"]') => page.evaluate(({ t, s }) => {
  const x = [...document.querySelectorAll(s)].find((e) => (e.textContent || '').trim().includes(t));
  if (x) { x.click(); return true; } return false;
}, { t, s });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 412, height: 873, deviceScaleFactor: 2 });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(800);

// 清库并播 6 个月的流水 —— 曲线要有起伏才看得出形状
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['ledger', 'accounts'].filter((n) => db.objectStoreNames.contains(n));
    const t = db.transaction(names, 'readwrite');
    names.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => res('ok');
  };
}));
await wait(300);

await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: A } = await import('./js/services/account_service.js');
  const today = new Date();
  // 六个月各自的支出：让曲线有「尖峰 + 回落」的形状（像参考图）
  const plan = [820, 1460, 640, 1980, 910, 306.85];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const total = plan[5 - i];
    const n = 6;
    for (let k = 0; k < n; k++) {
      await DB.addLedgerEntry({
        amount: Number((total / n).toFixed(2)), direction: 'expense', category: 'meal',
        note: '餐饮', date: `${key}-${String(2 + k * 4).padStart(2, '0')}`,
      });
    }
    await DB.addLedgerEntry({
      amount: 500, direction: 'income', category: 'allowance', note: '生活费',
      date: `${key}-01`,
    });
  }
  await A.create({ name: '微信零钱', type: 'wallet', opening: 500 });
  await A.create({ name: '一食堂饭卡', type: 'meal_card', opening: 100 });
});
await wait(400);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

/* ---------- 1. 趋势曲线图 ---------- */
await clickText(page, '记录'); await wait(700);
await clickText(page, '记账', '.segmented__item'); await wait(1100);
// 滚到趋势图那里
await page.evaluate(() => {
  const el = document.querySelector('.led-trend-card');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
});
await wait(500);
await shot(page, '1_trend_expense');

await page.click('.led-trend__seg-item[data-dir="income"]');
await wait(600);
await shot(page, '2_trend_income');

/* ---------- 2. 记一笔浮层（不用滚动就该看全） ---------- */
await clickText(page, '记一笔', '.led-action--primary'); await wait(600);
const fit = await page.evaluate(() => {
  const f = document.querySelector('.led-form');
  return { formH: Math.round(f.getBoundingClientRect().height), scrollable: Math.round(f.scrollHeight - f.clientHeight) };
});
console.log('记一笔浮层：', JSON.stringify(fit));
await shot(page, '3_sheet_fits');
await page.evaluate(() => { const b = document.querySelector('[data-action="close-entry"]'); if (b) b.click(); });
await wait(400);

/* ---------- 3. 账户充值：关联账户必选 ---------- */
await clickText(page, '账户', '.segmented__item'); await wait(1000);
await page.evaluate(async () => {
  const btn = document.querySelector('[data-action="toggle-account-detail"].acct-section-title--collapsed');
  if (btn) { btn.click(); await new Promise((r) => setTimeout(r, 700)); }
});
await wait(400);
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.acct-card')]
    .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes('一食堂饭卡'));
  card.querySelector('[data-action="recharge"]').click();
});
await wait(700);
await page.evaluate((v) => {
  const el = document.querySelector('.modal .input');
  el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
}, '200');
await wait(300);
await clickText(page, '下一步');
await page.waitForSelector('.modal .input', { timeout: 4000 });
await wait(400);
await page.evaluate(() => { const el = document.querySelector('.modal .input'); if (el) el.focus(); });
await page.keyboard.type('报销');
await wait(300);
await shot(page, '4_recharge_todo');

// 没选就点保存 → 应该被就地拦下
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.modal button')].find((x) => (x.textContent || '').trim() === '保存');
  if (b) b.click();
});
await wait(600);
const blocked = await page.evaluate(() => ({
  open: !!document.querySelector('.modal'),
  hint: document.querySelector('.modal .modal__hint')?.textContent.trim() || '',
  shown: document.querySelector('.modal .modal__hint')?.style.display !== 'none',
  todo: !!document.querySelector('.field-pick--todo'),
}));
console.log('未选就保存：', JSON.stringify(blocked));
await shot(page, '5_recharge_blocked');

// 选一个账户
await page.click('.field-pick[data-action="extra-pick"]');
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(400);
await shot(page, '6_recharge_options');
await clickText(page, '微信零钱', '.sheet__item');
await wait(500);
await shot(page, '7_recharge_chosen');

await browser.close();
console.log('done');
