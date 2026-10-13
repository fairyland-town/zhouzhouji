/**
 * shot_account_detail.mjs —— 账户页三处修复的「改后」截图
 *
 * 对应用户 2026-10-13 给的三张图：
 *   ① shot_fix_1_account_bottom.png —— 滚到底，「账户明细」是一张卡片、不被 dock / ＋ 压住
 *   ② shot_fix_2_all_flows.png      —— 「全部 ›」面板：顶部不被裁、列表可滚、「取消」常驻
 *   ③ shot_fix_3_flow_rows.png      —— 账户卡里的流水行：日期一行、行不再被拉长
 *
 * 用法：node tools/shot_account_detail.mjs   （需先 npm run serve）
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

async function stableScrollTop(selector, timeout = 4000) {
  let last = null; let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.$eval(selector, (el) => Math.round(el.scrollTop)).catch(() => null);
    if (v === null) { await wait(60); continue; }
    if (v === last) { same++; if (same >= 5) return v; } else { same = 0; last = v; }
    await wait(90);
  }
  return last;
}

/* ---- 播种：和回归脚本同一套数据（34 笔，跨月） ---- */
await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['accounts', 'ledger'].filter((n) => db.objectStoreNames.contains(n));
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
  const { AccountService } = await import('./js/services/account_service.js');
  const { ACCOUNT_TYPE } = await import('./js/models/account.js');
  const aId = await AccountService.create({
    name: '一食堂饭卡', type: ACCOUNT_TYPE.MEAL_CARD, opening: 100, openingDate: '2026-09-01',
  });
  await AccountService.create({
    name: '建行卡', type: ACCOUNT_TYPE.BANK, opening: 1200, openingDate: '2026-09-01',
  });
  const notes = ['洗澡', '午饭晚饭', '洗衣服', '微信', '农行', '中晚饭', '帮别人刷卡，已转支付宝'];
  for (let i = 0; i < 34; i++) {
    const day = 5 - Math.floor(i / 3);
    const date = day >= 1 ? `2026-10-${String(day).padStart(2, '0')}`
      : `2026-09-${String(30 + day).padStart(2, '0')}`;
    await AccountService.addEntry(aId, {
      kind: i % 7 === 3 ? 'in' : 'out',
      amount: i % 7 === 3 ? 50 : (3.7 + i * 1.3),
      date,
      note: notes[i % notes.length],
    });
  }
});
await wait(400);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('账户', '.segmented__item'); await wait(1000);

/* ---- ① 滚到底：账户明细是一张卡片，且让开 dock 与 ＋ ---- */
await page.evaluate(() => {
  const host = document.querySelector('.record-body-host > .acct-view');
  if (host) host.scrollTop = host.scrollHeight;
});
await stableScrollTop('.record-body-host > .acct-view');
await wait(400);
await page.screenshot({ path: 'tools/shot_fix_1_account_bottom.png' });
console.log('✓ tools/shot_fix_1_account_bottom.png');

/* ---- ② 展开明细 → 点「全部 ›」→ 面板（已滚到中段，能看到列表在动） ---- */
await page.evaluate(() => {
  const btn = document.querySelector('[data-action="toggle-account-detail"]');
  if (btn && btn.classList.contains('acct-section-title--collapsed')) btn.click();
});
await wait(700);
await page.evaluate(() => {
  const host = document.querySelector('.record-body-host > .acct-view');
  if (host) host.scrollTop = host.scrollHeight;
});
await stableScrollTop('.record-body-host > .acct-view');
await wait(300);
await page.evaluate(() => {
  const b = document.querySelector('.acct-flows__more');
  if (b) b.click();
});
await wait(700);
await page.screenshot({ path: 'tools/shot_fix_2_all_flows.png' });
console.log('✓ tools/shot_fix_2_all_flows.png');

// 滚到列表中段再拍一张，证明「能滚」
await page.evaluate(() => {
  const list = document.querySelector('.sheet__list');
  if (list) list.scrollTop = Math.round(list.scrollHeight / 2);
});
await stableScrollTop('.sheet__list');
await wait(300);
await page.screenshot({ path: 'tools/shot_fix_2b_all_flows_scrolled.png' });
console.log('✓ tools/shot_fix_2b_all_flows_scrolled.png');

await page.evaluate(() => {
  const c = document.querySelector('.sheet__item--cancel');
  if (c) c.click();
});
await wait(600);

/* ---- ③ 账户卡里的流水行（日期一行、行不被拉长） ---- */
await page.evaluate(() => {
  const card = document.querySelector('.acct-card');
  if (!card) return;
  const host = document.querySelector('.record-body-host > .acct-view');
  if (!host) return;
  // 🔴 算「元素在滚动容器里的位置」不能用 offsetTop（相对 offsetParent 会多算头部）
  const topInRoot = card.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
  host.scrollTop = Math.min(topInRoot - 8, host.scrollHeight - host.clientHeight);
});
await stableScrollTop('.record-body-host > .acct-view');
await wait(400);
await page.screenshot({ path: 'tools/shot_fix_3_flow_rows.png' });
console.log('✓ tools/shot_fix_3_flow_rows.png');

await browser.close();
