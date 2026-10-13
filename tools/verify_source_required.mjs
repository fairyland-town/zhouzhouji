/**
 * verify_source_required.mjs —— 目视验证「充值来源必填」（v1.7.2）
 *
 * 跑法：node tools/verify_source_required.mjs
 * 产出：tools/shot_source_required.png
 *
 * 为什么单独写这个：promptDialog 依赖真实 DOM，单元测试跑不了，
 * 只能靠真实浏览器点一遍 + 截图确认视觉，E2E 只断言行为不看长相。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ESM 不走 NODE_PATH，按绝对路径解析 puppeteer-core
const P = 'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
if (!existsSync(P)) {
  console.error('未找到 puppeteer-core，请先执行：cd C:/Users/27693/.workbuddy-ai/binaries/node/workspace && npm i puppeteer-core');
  process.exit(1);
}
const puppeteer = (await import(pathToFileURL(P).href)).default;

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', 'web');
const OUT = resolve(__dirname, 'shot_source_required.png');
const PORT = 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const f = join(ROOT, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    const info = await stat(f).catch(() => null);
    const file = info && info.isDirectory() ? join(f, 'index.html') : f;
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404).end('404'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? `  →  ${extra}` : ''}`); }
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 932, deviceScaleFactor: 2 });
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2' });
await sleep(1200);

// 清库，保证从干净状态开始
await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.deleteDatabase('campus_week_calendar');
  r.onsuccess = r.onerror = r.onblocked = () => res();
}));
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1500);

// 建一个账户（AccountService 内部会自行初始化数据库）
await page.evaluate(async () => {
  const { default: S } = await import('/js/services/account_service.js');
  await S.create({ name: '一食堂饭卡', type: 'meal_card', opening: 100 }).catch(() => null);
});
await sleep(600);

// 进记录页 → 账户
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.bottom-nav__item')];
  const t = items.find((e) => e.textContent.includes('记录'));
  if (t) t.click();
});
await sleep(900);
await page.evaluate(() => {
  const seg = [...document.querySelectorAll('.segmented__item')].find((e) => e.textContent.includes('账户'));
  if (seg) seg.click();
});
await sleep(1200);

console.log('\n\x1b[1m充值来源必填（v1.7.2）\x1b[0m');

// 🔴 「账户明细」v1.13.4 起**默认收起**，账户卡（连同卡上的「充值」按钮）默认不渲染，
//    不先展开就会卡在 `[data-action="recharge"]` 找不到。
//    ⚠️ 用 JS 的 `el.click()`，不要用坐标点击 —— 折叠标题在页面靠下，
//    经常正好落在底部悬浮 dock 底下，坐标点击会点到 dock 上。
await page.evaluate(async () => {
  const btn = document.querySelector('[data-action="toggle-account-detail"].acct-section-title--collapsed');
  if (!btn) return;
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
});
await sleep(400);

// 点充值 → 填金额 → 下一步
await page.click('[data-action="recharge"]');
await page.waitForSelector('.modal .input', { timeout: 5000 });
await page.$eval('.modal .input', (el) => { el.focus(); el.select(); });
await page.keyboard.type('200');
await sleep(300);
await page.evaluate(() => {
  [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('下一步'))?.click();
});
await sleep(700);

const title = await page.$eval('.modal__title', (el) => el.textContent.trim());
ok('弹窗标题是「这笔钱的来源」', title.includes('这笔钱的来源'), title);
ok('标题里没有「可跳过」', !title.includes('可跳过'), title);

const msg = await page.$eval('.modal__body', (el) => el.textContent.trim());
ok('提示词用的是「工资 / 奖学金 / 报销 / 退款」', /工资/.test(msg) && /奖学金/.test(msg), msg);
ok('提示词不再出现「爸妈」', !/爸妈|父母/.test(msg), msg);

const ph = await page.$eval('.modal .input', (el) => el.placeholder);
ok('占位符示例是「工资」', ph.includes('工资'), ph);

// 空着点保存 → 应当被拦住 + 出提示
await page.evaluate(() => {
  [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('保存'))?.click();
});
await sleep(500);
ok('空来源点保存后弹窗仍在', (await page.$('.modal .input')) !== null);

const hint = await page.$eval('.modal__hint', (el) => el.style.display !== 'none' ? el.textContent.trim() : '').catch(() => '');
ok('出现了红色必填提示', Boolean(hint), hint || '(无)');

const hintColor = await page.$eval('.modal__hint', (el) => getComputedStyle(el).color).catch(() => '');
ok('提示文字是危险色（浅色主题下可读）', /rgb\(220,\s*38,\s*38\)/.test(hintColor), hintColor);

await page.screenshot({ path: OUT });
console.log(`  \x1b[2m截图 → ${OUT}\x1b[0m`);

// 填入后提示消失、弹窗可关
await page.$eval('.modal .input', (el) => el.focus());
await page.keyboard.type('工资');
await sleep(400);
const hintGone = await page.$eval('.modal__hint', (el) => getComputedStyle(el).display).catch(() => 'none');
ok('开始输入后提示自动隐藏', hintGone === 'none', hintGone);

await page.evaluate(() => {
  [...document.querySelectorAll('.modal .btn')].find((b) => b.textContent.includes('保存'))?.click();
});
await sleep(900);
ok('填了来源后弹窗正常关闭', (await page.$('.modal .input')) === null);

const balance = await page.$eval('[data-field="balance"]', (el) => el.textContent.trim()).catch(() => '');
ok('余额已更新为 ¥300.00', balance === '¥300.00', balance);

await browser.close();
server.close();

console.log(`\n${'='.repeat(60)}`);
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} 项 / 共 ${pass + fail} 项`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
