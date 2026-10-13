/**
 * 验证 v1.4.1 金额识别修复在真实浏览器中的效果。
 * 走「记账页 → 粘贴文字 → 解析」链路，模拟用户实际使用路径。
 *
 * 用法：BASE_URL=http://127.0.0.1:8080 node tools/verify_amount_ui.mjs
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PUPPETEER_CANDIDATES = [
  process.env.PUPPETEER_PATH,
  'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
].filter(Boolean);
const puppeteerPath = PUPPETEER_CANDIDATES.find((p) => existsSync(p));
if (!puppeteerPath) { console.error('未找到 puppeteer-core'); process.exit(1); }
const puppeteer = (await import(pathToFileURL(puppeteerPath).href)).default;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) { console.error('未找到浏览器'); process.exit(1); }

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 900 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(700);

// 进入「记录」页 → 「记账」分段
const clickText = async (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const t = [...document.querySelectorAll(sel)].find((b) => (b.textContent || '').trim().includes(text));
    if (t) { t.click(); return true; }
    return false;
  },
  { text, sel },
);

await clickText('记录');
await wait(800);
await clickText('记账');
await wait(800);

const CASES = [
  { label: '型号当价格', text: '买显示器g27', expect: '' }, // 型号不认，留空等用户手填
  { label: '型号+真实价格', text: '买显示器 g27 花了我 899 元', expect: '899' },
  { label: '一句话行尾整数', text: '午饭100', expect: '100' },
  { label: 'OCR 行序（早餐在前）', text: '微信支付\n付款成功\n吃早饭0.65\n15.80\n收款方 星际烤肉店', expect: '15.8' },
  { label: 'OCR 行序（早餐在后）', text: '微信支付\n付款成功\n15.80\n吃早饭0.65\n收款方 星际烤肉店', expect: '15.8' },
];

console.log('--- 记账页「粘贴文字」识别结果 ---');
let pass = 0;

for (const c of CASES) {
  // 打开弹窗
  await clickText('粘贴文字');
  await wait(500);

  // 填值：用 native setter 触发 React 之外的普通 input 事件
  const filled = await page.evaluate((text) => {
    const input = document.querySelector(".modal .input--multiline, .modal .input, .modal input, .modal textarea");
    if (!input) return null;
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  }, c.text);
  if (filled === null) { console.log(c.label, '→ 弹窗输入框未找到'); continue; }

  await wait(250);

  // 点「解析」
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.modal button')].find((b) => /解析/.test(b.textContent || ''));
    if (t) t.click();
  });
  await wait(900);

  // 读表单里的金额
  // v1.13.5：金额框改成自定义键盘之后，`inputmode` 变成 `none`（为了点它不弹系统键盘），
  // 占位符也不再含「金额」二字，所以**按类名认它**才稳。
  const got = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')].filter((el) => el.offsetParent !== null);
    const amount = inputs.find((el) => el.classList.contains('led-amount__input')
      || el.classList.contains('input--amount')
      || /decimal|number/.test(el.getAttribute('inputmode') || '') || el.type === 'number'
      || /金额/.test(el.placeholder || ''));
    const note = inputs.find((el) => el.dataset.field === 'note'
      || /备注|用途|说明/.test(el.placeholder || ''));
    return {
      amount: amount ? amount.value : '(未找到金额框)',
      note: note ? note.value : '(未找到备注框)',
      placeholders: inputs.map((el) => el.placeholder || el.type).slice(0, 8),
    };
  });

  const ok = String(got.amount) === c.expect;
  if (ok) pass += 1;
  console.log(`${ok ? '✓' : '✗'} ${c.label.padEnd(20)} 期望=${c.expect.padEnd(6)} 实际=${String(got.amount).padEnd(8)} 备注=${JSON.stringify(got.note)}`);
  if (!amountFound(got)) console.log('   输入框占位符：', JSON.stringify(got.placeholders));

  // 清场：返回列表，避免草稿叠加
  await page.reload({ waitUntil: 'networkidle2' });
  await wait(700);
  await clickText('记录');
  await wait(800);
  await clickText('记账');
  await wait(800);
}

function amountFound(got) { return got.amount !== '(未找到金额框)'; }

console.log(`\n浏览器内验证：${pass}/${CASES.length} 项通过`);
await browser.close();
