/**
 * 验证账户视图：建账户 → 充值 → 消费 → 对账。
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(800);

// 清空 accounts，保证干净起点
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('accounts')) { res('no-store'); return; }
    const t = db.transaction('accounts', 'readwrite');
    t.objectStore('accounts').clear();
    t.oncomplete = () => res('cleared');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);
await page.reload({ waitUntil: 'networkidle2' });
await wait(800);

const clickText = (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
    if (b) { b.click(); return true; }
    return false;
  }, { text, sel },
);

/** 在弹窗里填值并点确定 */
const fillModal = async (value, okText) => {
  await page.waitForSelector('.modal .input', { timeout: 4000 });
  await page.evaluate((v) => {
    const el = document.querySelector('.modal .input--multiline, .modal .input, .modal input');
    if (!el) return;
    el.focus(); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await wait(250);
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.modal button')].find((x) => (x.textContent || '').trim() === t);
    if (b) b.click();
  }, okText);
  await wait(600);
};

console.log('--- 进入账户页 ---');
await clickText('记录'); await wait(800);
await clickText('账户'); await wait(900);

const intro = await page.evaluate(() => ({
  hasIntro: !!document.querySelector('.acct-intro'),
  total: document.querySelector('[data-field="total-balance"]')?.textContent,
  segs: [...document.querySelectorAll('.segmented__item')].map((e) => e.textContent.trim()),
}));
console.log('分段控件：', JSON.stringify(intro.segs));
console.log('首次引导：', intro.hasIntro, ' 总余额：', intro.total);

console.log('\n--- 新建账户：一食堂饭卡 / 期初 100 ---');
await clickText('新建第一个账户'); await wait(600);
await fillModal('一食堂饭卡', '下一步');
// 类型选择（actionSheet）
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.sheet button, .action-sheet button, .modal button')]
    .find((x) => (x.textContent || '').includes('饭卡'));
  if (b) b.click();
});
await wait(600);
await fillModal('100', '创建');
await wait(600);

console.log('\n--- 充值 200 ---');
await clickText('充值'); await wait(600);
await fillModal('200', '下一步');
await fillModal('爸妈转账', '保存');

console.log('\n--- 消费 12.5 ---');
await clickText('消费'); await wait(600);
await fillModal('12.5', '下一步');
await fillModal('午饭', '保存');

// 「账户明细」v1.13.4 起默认收起，断言账户卡之前先展开。
// ⚠️ 用 JS 的 `el.click()`，别用坐标点击 —— 这个折叠标题在页面靠下，
//    经常正好落在底部悬浮 dock 底下，坐标点击会点到 dock 上，导致假红。
await page.evaluate(async () => {
  const btn = document.querySelector('[data-action="toggle-account-detail"].acct-section-title--collapsed');
  if (!btn) return;
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
});
await wait(300);

const after = await page.evaluate(() => {
  const card = document.querySelector('.acct-card');
  if (!card) return null;
  const cell = (k) => {
    const kEl = [...card.querySelectorAll('.acct-bal__k')].find((e) => e.textContent.includes(k));
    return kEl ? kEl.nextElementSibling.textContent.trim() : null;
  };
  return {
    name: card.querySelector('.acct-card__name')?.textContent,
    balance: cell('当前余额'),
    totalIn: cell('累计充值'),
    totalOut: cell('累计消耗'),
    flows: card.querySelectorAll('.acct-flow').length,
    total: document.querySelector('[data-field="total-balance"]')?.textContent,
  };
});
console.log('账户卡：', JSON.stringify(after, null, 2));

await page.screenshot({ path: 'tools/shot_account.png' });
console.log('已保存 tools/shot_account.png');

console.log('\n--- 对账：平台显示 280（实际应 287.5，差额 7.5）---');
await clickText('对账'); await wait(600);
await fillModal('280', '开始对账');
await wait(700);
const modalText = await page.evaluate(() => {
  const m = document.querySelector('.modal');
  return m ? m.textContent.replace(/\s+/g, ' ').trim() : '(无弹窗)';
});
console.log('对账结论：', modalText.slice(0, 300));

await page.screenshot({ path: 'tools/shot_account_check.png' });
console.log('已保存 tools/shot_account_check.png');

await browser.close();
