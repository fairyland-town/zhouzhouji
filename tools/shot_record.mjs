// shot_record.mjs —— 截取「记录」页（打卡 / 记账）截图，用于人工确认
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pptrPath = 'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const { default: puppeteer } = await import(pathToFileURL(pptrPath).href);

// serve.mjs 的根目录已经是 web/，端口通过命令行参数传入
const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), String(PORT)], {
  stdio: 'ignore',
});
await sleep(1500);

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: findChrome(),
  args: ['--no-sandbox'],
});

async function clickByText(page, sel, text) {
  const handles = await page.$$(sel);
  for (const hd of handles) {
    const t = await hd.evaluate((n) => n.textContent.trim());
    if (t.includes(text)) { await hd.click(); return true; }
  }
  throw new Error(`未找到 ${sel} 含 "${text}"`);
}

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 460, height: 900, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.app-header');
  await sleep(500);

  await clickByText(page, '.bottom-nav__item', '记录');
  await sleep(600);

  /* ---- 打卡：先建两个打卡项 ---- */
  for (const name of ['背单词', '跑步 3 公里']) {
    await clickByText(page, '.empty-state .btn, .section-title__action', '新建');
    await page.waitForSelector('.modal .input', { timeout: 4000 });
    await page.type('.modal .input', name);
    await clickByText(page, '.modal .btn', '创建');
    await sleep(700);
  }
  // 打一个卡
  await page.click('.chk-toggle');
  await sleep(600);
  await page.screenshot({ path: join(ROOT, 'screenshot_record_checkin.png') });
  console.log('✓ screenshot_record_checkin.png');

  /* ---- 打卡月历 ---- */
  await page.click('.chk-card__main');
  await sleep(700);
  await page.screenshot({ path: join(ROOT, 'screenshot_record_calendar.png') });
  console.log('✓ screenshot_record_calendar.png');

  // 回到列表，再切到记账
  await page.click('.cal-head .icon-btn');
  await sleep(500);
  // 记录页默认停在「打卡」，不切 tab 的话「记一笔」根本不存在
  await clickByText(page, '.segmented__item', '记账');
  await sleep(700);

  /* ---- 记账：记两笔 + 设预算 ---- */
  await clickByText(page, '.led-action', '记一笔');
  await page.waitForSelector('.led-form');
  await page.type('.input--amount', '12.5');
  await clickByText(page, '.led-cat', '餐饮');
  await sleep(400);
  // 分类点击会整表单重绘。puppeteer 的 page.type(sel, ...) 内部会重新查一次选择器，
  // 容易撞上重绘时序导致 "No element found"。
  // 这里改用 focus + keyboard.type，句柄一次找到、稳定输入。
  // 注意 placeholder 里含「食堂午饭」，所以按 data-field 精确定位。
  const noteSel = '.led-form .input[data-field="note"]';
  await page.$eval(noteSel, (el) => el.focus());
  await page.keyboard.type('食堂午饭');
  await page.click('.btn--primary[data-action="save-entry"]');
  await sleep(900);

  await clickByText(page, '.led-action', '粘贴文字');
  await page.waitForSelector('.modal .input');
  await page.type('.modal .input', '打车 28 元');
  await clickByText(page, '.modal .btn', '解析');
  await sleep(600);
  await page.screenshot({ path: join(ROOT, 'screenshot_record_ledger_form.png') });
  console.log('✓ screenshot_record_ledger_form.png');
  await clickByText(page, '.led-form .btn', '保存');
  await sleep(800);

  await clickByText(page, '.led-action', '粘贴文字');
  await page.waitForSelector('.modal .input');
  await page.type('.modal .input', '生活费到账 3000 元');
  await clickByText(page, '.modal .btn', '解析');
  await sleep(600);
  await clickByText(page, '.led-form .btn', '保存');
  await sleep(800);

  // 设预算
  await page.click('.budget--empty, .budget__edit');
  await page.waitForSelector('.modal .input');
  await page.type('.modal .input', '1500');
  await clickByText(page, '.modal .btn', '保存');
  await sleep(800);

  await page.screenshot({ path: join(ROOT, 'screenshot_record_ledger.png'), fullPage: true });
  console.log('✓ screenshot_record_ledger.png');
} finally {
  await browser.close();
  server.kill();
}

function findChrome() {
  const cands = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  return cands.find((p) => existsSync(p));
}
