// verify_guide.mjs —— 打开 设置 → 使用说明，截图并校验关键渲染
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, selector, text) {
  const handles = await page.$$(selector);
  for (const el of handles) {
    const t = await page.evaluate((n) => n.textContent.trim(), el);
    if (t.includes(text)) { await el.click(); return true; }
  }
  return false;
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=430,900'],
  defaultViewport: { width: 430, height: 860 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

await page.goto('http://localhost:8080/', { waitUntil: 'networkidle2' });
await sleep(1200);

// 从周历页顶栏进设置
await page.click('.app-header__actions .icon-btn');
await sleep(700);
console.log('设置页:', await page.$('.screen--settings') !== null);

const hasEntry = await page.$('[data-action="guide"]');
console.log('设置页有「使用说明」入口:', hasEntry !== null);

await page.click('[data-action="guide"]');
await sleep(700);

console.log('说明页已渲染:', await page.$('.screen--guide') !== null);
console.log('导语:', await page.$eval('.guide-lead__title', (e) => e.textContent.trim()).catch(() => '(无)'));
console.log('小节数:', await page.$$eval('.guide-card', (e) => e.length));
console.log('目录项:', await page.$$eval('.guide-toc__label', (e) => e.map((n) => n.textContent.trim())).catch(() => []));
console.log('✅行数:', await page.$$eval('.guide-row__good', (e) => e.length));
console.log('❌行数:', await page.$$eval('.guide-row__bad', (e) => e.length));
console.log('警告框数:', await page.$$eval('.guide-warn', (e) => e.length));
console.log('严重警告框:', await page.$$eval('.guide-danger', (e) => e.length));
console.log('pageerrors:', errs.length ? errs : '无');

await page.screenshot({ path: 'tools/shot_guide.png', fullPage: false });
await page.evaluate(() => { document.querySelector('.app-body').scrollTop = 99999; });
await sleep(500);
await page.screenshot({ path: 'tools/shot_guide_bottom.png', fullPage: false });
console.log('已保存 tools/shot_guide.png 和 tools/shot_guide_bottom.png');

await browser.close();
