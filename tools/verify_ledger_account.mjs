/**
 * verify_ledger_account.mjs —— 「记一笔」底部浮层 + 必选消费账户 回归
 *
 * 对应三条用户诉求（2026-09-23）：
 *   1.「点击记一笔后，每次都是自动滑到最底下，不是显示输入金额在里面，
 *      然后 ui 能改成如图所示吗」
 *      → **第二轮改版后这条的前提整个变了**：表单不再是页面里的一段，
 *        而是 `position: fixed` 的底部浮层。所以「会不会被页面滚动顶出屏幕」
 *        已经无从谈起 —— 现在要钉的是**浮层自己那层滚动**里金额是否可见。
 *   2.「在记账的时候多一个可选的消费账户选项，直接从对应的消费账户里面扣钱」
 *      → 选了账户就真扣余额，并计入该账户「累计消耗」；
 *        记账总账里**仍然只有这一笔**，不重复计。
 *   3.「关联账户或者不关联账户的选项是必选项，要我们自己选，而不是默认不关联」
 *      → 新建时账户行是**待办态**（虚线高亮），没选就按保存会被拦下并提示；
 *        「不关联账户」是一个**要主动点的选项**，不是默认值。
 *
 * 这个脚本要钉住的**语义**（不是像素）：
 *   · 键盘敲出来的金额 = 金额框里的值 = 存进库里的金额
 *   · 没选账户 → 存不进去（而且有可见提示，不是「点了没反应」）
 *   · 选了账户 → 账户余额减少、累计消耗增加
 *   · 记账总账的当月支出 = 那一笔的金额（**不是两倍**，证明没有重复入账）
 *   · 改金额 / 换账户 / 删除，账户侧都跟着变，且**不会**留下第二条扣款
 *   · 浮层打开后金额框必须在浮层可视区里（浮层滚到最底就不是死路，是 bug）
 *
 * 用法：node tools/verify_ledger_account.mjs   （需先 npm run serve）
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
const near = (label, actual, expected) => ok(label, Math.abs(Number(actual) - Number(expected)) < 0.005,
  `实际 ${actual} / 期望 ${expected}`);

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
  // 按**来源 URL** 过滤，不是按文本（资源加载失败的消息永远是同一句）
  try { if (/127\.0\.0\.1:8765/.test(m.location()?.url || '')) return; } catch { /* 忽略 */ }
  pageErrors.push('[console] ' + m.text());
});

const clickText = (text, sel = 'button, .btn, [role="button"]') => page.evaluate(
  ({ text, sel }) => {
    const b = [...document.querySelectorAll(sel)].find((x) => (x.textContent || '').trim().includes(text));
    if (b) { b.click(); return true; }
    return false;
  }, { text, sel },
);

/** 点键盘上的某个键。每次都重新查选择器 —— 切方向会整表重绘，句柄会失效 */
const tapKey = async (k) => { await page.click(`.led-pad .led-key[data-key="${k}"]`); await wait(90); };

/** 按「12.50」这样的字符串敲一遍键盘 */
async function typeByPad(str) {
  for (const ch of String(str)) await tapKey(ch);
}

/** 清空金额框（键盘删干净） */
async function clearAmount() {
  for (let i = 0; i < 10; i++) await tapKey('del');
}

/** 读金额输入框的值 */
const readAmount = () => page.$eval('.led-form .input--amount', (el) => el.value);

/** 关掉浮层（左上角「‹」）。表单开着时别的按钮都被遮罩挡着，必须用它 */
const closeSheet = async () => {
  await page.evaluate(() => {
    const b = document.querySelector('[data-action="close-entry"]');
    if (b) b.click();
  });
  await wait(450);
};

/** 打开「记一笔」浮层 */
async function openLedger() {
  await clickText('记一笔', '.led-action--primary');
  await page.waitForSelector('.led-form', { timeout: 4000 });
  await wait(350);
}

/** 选账户。`name` 传「不关联账户」时选的就是那一条 */
async function pickAccount(name) {
  await page.click('.led-form [data-action="pick-account"]');
  await page.waitForSelector('.sheet', { timeout: 4000 });
  await wait(250);
  await clickText(name, '.sheet__item');
  await wait(450);
}

/* ---------------- 准备：清库 + 建一个账户 ---------------- */

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

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

const accId = await page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  const a = await AccountService.create({ name: '一食堂饭卡', type: 'meal_card', opening: 300 });
  return a;
});
ok('测试账户已建好（期初 300）', accId != null, `id=${accId}`);

await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);

/* ================================================================
   第 1 组：底部浮层的结构
   ================================================================ */
console.log('\n\x1b[1m第 1 组：底部浮层结构（‹ + 记一笔 / 方向 / 分类 / 大号金额 / 备注 · 账户 / 键盘）\x1b[0m');

await openLedger();

const shape = await page.evaluate(() => {
  const f = document.querySelector('.led-form');
  if (!f) return null;
  const q = (s) => f.querySelector(s);
  const overlay = document.querySelector('.modal-overlay--bottom');
  const r = f.getBoundingClientRect();
  return {
    // 左上角是个「‹」图标按钮，没有文字（参考图就是这样）
    cancelAction: q('.led-form__cancel')?.dataset.action || '',
    cancelLabel: q('.led-form__cancel')?.getAttribute('aria-label') || '',
    title: q('.led-form__title')?.textContent.trim() || '',
    dirText: q('.led-form__dir')?.textContent.trim() || '',
    dirState: q('.led-form__dir')?.dataset.dir || '',
    hasAmount: !!q('.input--amount'),
    cats: [...f.querySelectorAll('.led-cat')].map((e) => e.textContent.trim()),
    catCols: getComputedStyle(q('.led-cat-picker')).gridTemplateColumns.split(' ').length,
    hasNote: !!q('.input[data-field="note"]'),
    acctAction: q('[data-action="pick-account"]')?.dataset.action || '',
    acctText: q('[data-action="pick-account"]')?.textContent.trim() || '',
    padKeys: [...f.querySelectorAll('.led-key')].map((e) => e.textContent.trim()),
    saveKey: !!q('.led-key[data-action="save-entry"]'),
    // 键盘是不是真的排成 4 列。
    // ⚠️ 不能数「不同的左边缘有几个」—— ✓ 是**圆形**的（justify-self: center），
    //    它的左边缘跟同一列的数字键不一样，数出来会是 5。
    //    所以按**行**分组，再看每行是不是恰好 4 个、左边缘逐个递增。
    padRows: Object.values(
      [...f.querySelectorAll('.led-key')].reduce((acc, e) => {
        const r = e.getBoundingClientRect();
        const k = Math.round(r.top);
        (acc[k] = acc[k] || []).push(Math.round(r.left));
        return acc;
      }, {}),
    ).map((lefts) => lefts.sort((a, b) => a - b)),
    overlayPos: overlay ? getComputedStyle(overlay).position : '',
    gapToBottom: Math.round(window.innerHeight - r.bottom),
  };
});
ok('浮层渲染出来了', shape !== null);
if (shape) {
  check('左上角是「‹」关闭按钮', shape.cancelAction, 'close-entry');
  check('「‹」有无障碍标签「取消」', shape.cancelLabel, '取消');
  check('标题是「记一笔」', shape.title, '记一笔');
  check('有方向状态标签（支出 / 收入，不是说明文字）', shape.dirText, '支出');
  check('方向状态是 expense', shape.dirState, 'expense');
  ok('有独立的大号金额行', shape.hasAmount);
  check('支出分类 8 个（沿用现有分类，没有新建二级体系）', shape.cats.length, 8);
  check('分类格子排 4 列', shape.catCols, 4);
  ok('分类里含「餐饮」', shape.cats.join('|').includes('餐饮'), shape.cats.join('|'));
  ok('有备注输入框', shape.hasNote);
  check('账户行存在且可点', shape.acctAction, 'pick-account');
  check('键盘 4 行', shape.padRows.length, 4);
  ok('键盘每行都是 4 个键（真的排成 4 列）',
    shape.padRows.every((row) => row.length === 4),
    shape.padRows.map((r) => r.length).join(' | '));
  ok('键盘每行的左边缘逐个递增（没有叠在一起）',
    shape.padRows.every((row) => row.every((v, i) => i === 0 || v > row[i - 1] + 10)),
    shape.padRows.map((r) => r.join(',')).join(' / '));
  ok('键盘有数字 0–9 与小数点',
    '1|2|3|4|5|6|7|8|9|0|.'.split('|').every((k) => shape.padKeys.includes(k)),
    shape.padKeys.join(' '));
  ok('键盘有删除 ⌫ / 日期 📅 / 保存 ✓ 三个功能键',
    shape.padKeys.includes('⌫') && shape.padKeys.includes('📅') && shape.padKeys.includes('✓'),
    shape.padKeys.join(' '));
  // ＋ / － 就是收支方向切换（用户确认过：参考图顶部没有收支胶囊，靠键盘切）
  ok('键盘右列是 ＋ / － 方向切换键',
    shape.padKeys.includes('＋') && shape.padKeys.includes('－'), shape.padKeys.join(' '));
  ok('保存键仍然是主按钮（选择器没变，E2E 不用改）', shape.saveKey);
  // 浮层本体
  check('浮层是 fixed 定位（和页面滚动无关）', shape.overlayPos, 'fixed');
  ok('浮层贴住视口底边', shape.gapToBottom <= 2, `距底 ${shape.gapToBottom}px`);
}

/* ================================================================
   第 2 组：自定义键盘
   ================================================================ */
console.log('\n\x1b[1m第 2 组：自定义键盘\x1b[0m');

await typeByPad('1250');
check('连敲 1 2 5 0 → 金额框是 1250', await readAmount(), '1250');

await tapKey('.');
check('点小数点 → 1250.', await readAmount(), '1250.');

await tapKey('5');
await tapKey('0');
check('小数最多两位（再敲 0 被挡住）', await readAmount(), '1250.50');

await tapKey('9');
check('小数第三位被挡住', await readAmount(), '1250.50');

await tapKey('.');
check('第二个小数点被挡住', await readAmount(), '1250.50');

await tapKey('del');
await tapKey('del');
await tapKey('del');
check('删除键退三位 → 1250', await readAmount(), '1250');

await clearAmount();
check('全删干净', await readAmount(), '');

await typeByPad('05');
check('前导零被换掉（敲 0 5 → 5，不是 05）', await readAmount(), '5');

await tapKey('.');
await tapKey('5');
await clearAmount();
await tapKey('.');
check('清空后直接点小数点 → 0.（不是光秃秃一个点）', await readAmount(), '0.');
await tapKey('5');
check('再敲 5 → 0.5', await readAmount(), '0.5');

/* ================================================================
   第 3 组：账户是必选项
   ================================================================ */
console.log('\n\x1b[1m第 3 组：账户必选（没选就存不进去，且要有可见提示）\x1b[0m');

const todoState = await page.evaluate(() => {
  const row = document.querySelector('.led-form [data-action="pick-account"]');
  return { chosen: row?.dataset.chosen || '', todo: !!row?.classList.contains('led-field--todo') };
});
check('新建时账户行是「未选」态', todoState.chosen, '0');
ok('未选态有单独的样式（虚线高亮，不是普通一行）', todoState.todo);

// 金额填 50，备注填好，然后**不选账户**直接按保存
await clearAmount();
await typeByPad('50');
await page.$eval('.led-form input[data-field="note"]', (el) => el.focus());
await page.keyboard.type('食堂午饭');
await wait(200);

await page.click('.led-key[data-action="save-entry"]');
await wait(700);

const blocked = await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const entries = await DB.getLedgerEntries();
  const row = document.querySelector('.led-form [data-action="pick-account"]');
  return {
    stillOpen: !!document.querySelector('.led-form'),
    entryCount: entries.length,
    toast: document.querySelector('.toast')?.textContent.trim() || '',
    chosen: row?.dataset.chosen || '',
  };
});
ok('没选账户 → 浮层不关（存不进去）', blocked.stillOpen);
check('没选账户 → 库里一条都没有', blocked.entryCount, 0);
ok('没选账户 → 弹了提示（不是「点了没反应」）',
  blocked.toast.includes('先选一下'), blocked.toast);
check('被拦下后账户行仍是「未选」态', blocked.chosen, '0');

// 选「不关联账户」——这是一个**要主动点的选项**，不是默认值
await pickAccount('不关联账户');
const afterNone = await page.evaluate(() => {
  const row = document.querySelector('.led-form [data-action="pick-account"]');
  return { chosen: row?.dataset.chosen || '', todo: !!row?.classList.contains('led-field--todo'), text: row?.textContent.trim() || '' };
});
check('选过「不关联账户」后进入「已选」态', afterNone.chosen, '1');
ok('「已选」态没有待办样式了', !afterNone.todo);
ok('账户行显示「不关联账户」', afterNone.text.includes('不关联账户'), afterNone.text);

/* ================================================================
   第 4 组：选了消费账户 → 真扣钱 + 计入累计消耗
   ================================================================ */
console.log('\n\x1b[1m第 4 组：消费账户扣钱（口径：扣余额 + 计入累计消耗）\x1b[0m');

await pickAccount('一食堂饭卡');
const acctRowText = await page.$eval('.led-form [data-action="pick-account"]', (el) => el.textContent.trim());
ok('账户行变成了账户名', acctRowText.includes('一食堂饭卡'), acctRowText);
ok('账户行顺带显示余额（选完不用回账户页确认）', /余额 ¥300\.00/.test(acctRowText), acctRowText);

// 保存
await page.click('.led-key[data-action="save-entry"]');
await wait(900);

const afterSave = await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: AccountService } = await import('./js/services/account_service.js');
  const entries = await DB.getLedgerEntries();
  const accs = await AccountService.list();
  const a = accs[0];
  return {
    entryCount: entries.length,
    amount: entries[0]?.amount,
    note: entries[0]?.note,
    // 🔴 account_id 必须为空：它是「账户页镜像过来的」的意思，
    //    写了它记账页会把这条锁成只读、标成「来自账户 · 充值」
    ledgerAccountId: entries[0]?.accountId,
    balance: a?.balance,
    totalOut: a?.totalOut,
    linkedCount: a ? a.entries.filter((e) => e.ledgerId != null).length : -1,
    sheetOpen: !!document.querySelector('.led-form'),
  };
});

ok('保存后浮层自动收起来（不用用户再点一下「‹」）', !afterSave.sheetOpen);
check('只写进 1 笔记账（没有额外镜像一条）', afterSave.entryCount, 1);
check('金额是键盘敲的 50', afterSave.amount, 50);
check('备注正确', afterSave.note, '食堂午饭');
check('记账流水没有 account_id（那是账户镜像专用的字段）', afterSave.ledgerAccountId, null);
near('账户余额 300 − 50 = 250', afterSave.balance, 250);
near('账户「累计消耗」计入了这 50', afterSave.totalOut, 50);
check('账户侧只挂了一条流水', afterSave.linkedCount, 1);

const ovExpense = await page.evaluate(async () => {
  const { default: LedgerService } = await import('./js/services/ledger_service.js');
  const m = new Date();
  const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
  const ov = await LedgerService.overview(key);
  return { expense: ov.stats.expense, count: ov.stats.count };
});
near('🔴 记账总账当月支出 = 50（不是 100，证明没重复入账）', ovExpense.expense, 50);
check('记账总账当月只有 1 笔', ovExpense.count, 1);

const desc = await page.$eval('.led-item__desc', (el) => el.textContent.trim());
ok('流水列表标出了这笔钱从哪个账户走的', desc.includes('一食堂饭卡'), desc);

/* ================================================================
   第 5 组：改金额 → 账户跟着改，且不叠加
   ================================================================ */
console.log('\n\x1b[1m第 5 组：改金额 / 换账户 / 删除，账户侧都要跟着走\x1b[0m');

await page.click('.led-item');
await page.waitForSelector('.sheet', { timeout: 4000 });
await clickText('编辑', '.sheet__item');
await page.waitForSelector('.led-form', { timeout: 4000 });
await wait(500);

const editShape = await page.evaluate(() => ({
  title: document.querySelector('.led-form__title')?.textContent.trim() || '',
  amount: document.querySelector('.led-form .input--amount')?.value || '',
  acct: document.querySelector('.led-form [data-action="pick-account"]')?.textContent.trim() || '',
  chosen: document.querySelector('.led-form [data-action="pick-account"]')?.dataset.chosen || '',
}));
check('编辑时标题变「编辑记录」', editShape.title, '编辑记录');
check('编辑时带出原金额', editShape.amount, '50');
check('编辑时账户行是「已选」态（不是又要重选一遍）', editShape.chosen, '1');
ok('编辑时带出原来挂的账户（不带出来一保存就把扣款抹了）',
  editShape.acct.includes('一食堂饭卡'), editShape.acct);

await clearAmount();
await typeByPad('80');
await page.click('.led-key[data-action="save-entry"]');
await wait(900);

const afterEdit = await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: AccountService } = await import('./js/services/account_service.js');
  const entries = await DB.getLedgerEntries();
  const a = (await AccountService.list())[0];
  return {
    entryCount: entries.length,
    amount: entries[0]?.amount,
    balance: a.balance,
    totalOut: a.totalOut,
    linkedCount: a.entries.filter((e) => e.ledgerId != null).length,
    linkedAmount: a.entries.filter((e) => e.ledgerId != null)[0]?.amount,
  };
});
check('改金额没有多出一条记账', afterEdit.entryCount, 1);
check('金额改成 80', afterEdit.amount, 80);
check('账户侧仍然只有一条挂账（没有叠加成两条）', afterEdit.linkedCount, 1);
near('账户侧那条也跟着变成 80', afterEdit.linkedAmount, 80);
near('余额 300 − 80 = 220', afterEdit.balance, 220);
near('累计消耗 = 80', afterEdit.totalOut, 80);

// 换账户：再加一个账户，改成挂到它身上
const acc2 = await page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  return AccountService.create({ name: '微信零钱', type: 'wallet', opening: 500 });
});
ok('第二个账户已建好', acc2 != null, `id=${acc2}`);

await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);
await page.click('.led-item');
await page.waitForSelector('.sheet', { timeout: 4000 });
await clickText('编辑', '.sheet__item');
await page.waitForSelector('.led-form', { timeout: 4000 });
await wait(500);

await pickAccount('微信零钱');
await page.click('.led-key[data-action="save-entry"]');
await wait(900);

const afterSwap = await page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  const accs = await AccountService.list();
  const byName = Object.fromEntries(accs.map((a) => [a.name, a]));
  return {
    mealBalance: byName['一食堂饭卡'].balance,
    mealOut: byName['一食堂饭卡'].totalOut,
    mealLinked: byName['一食堂饭卡'].entries.filter((e) => e.ledgerId != null).length,
    walletBalance: byName['微信零钱'].balance,
    walletOut: byName['微信零钱'].totalOut,
    walletLinked: byName['微信零钱'].entries.filter((e) => e.ledgerId != null).length,
  };
});
near('换账户后旧账户余额回到 300（那笔扣款被撤了）', afterSwap.mealBalance, 300);
near('旧账户累计消耗回到 0', afterSwap.mealOut, 0);
check('旧账户上不留挂账', afterSwap.mealLinked, 0);
near('新账户余额 500 − 80 = 420', afterSwap.walletBalance, 420);
near('新账户累计消耗 80', afterSwap.walletOut, 80);
check('新账户上正好一条挂账', afterSwap.walletLinked, 1);

/* ================================================================
   第 6 组：删除记账 → 账户上的扣款一起撤销
   ================================================================ */
console.log('\n\x1b[1m第 6 组：删记账要连账户扣款一起撤（否则变成幽灵支出）\x1b[0m');

await page.click('.led-item');
await page.waitForSelector('.sheet', { timeout: 4000 });
await clickText('删除', '.sheet__item');
await page.waitForSelector('.modal', { timeout: 4000 });
await wait(300);
const confirmMsg = await page.$eval('.modal__body', (el) => el.textContent.trim());
ok('删除确认里说明了会连带撤销账户流水', confirmMsg.includes('微信零钱'), confirmMsg);
await clickText('删除', '.modal .btn');
await wait(900);

const afterDelete = await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: AccountService } = await import('./js/services/account_service.js');
  const entries = await DB.getLedgerEntries();
  const a = (await AccountService.list()).find((x) => x.name === '微信零钱');
  return {
    entryCount: entries.length,
    walletBalance: a.balance,
    walletOut: a.totalOut,
    walletLinked: a.entries.filter((e) => e.ledgerId != null).length,
  };
});
check('记账被删掉了', afterDelete.entryCount, 0);
check('账户上不留挂账', afterDelete.walletLinked, 0);
near('余额回到 500', afterDelete.walletBalance, 500);
near('累计消耗回到 0', afterDelete.walletOut, 0);

/* ================================================================
   第 7 组：打开浮层后，「金额」一定要看得见（多种屏高）
   ================================================================
   用户原话：「点击记一笔后，每次都是自动滑到最底下，不是显示输入金额在里面」。

   ⚠️ 第二轮改版后，表单搬进了 `position: fixed` 的底部浮层，
   **页面滚动这条路径已经不存在了** —— 所以「旧 bug 会一路滚到内容最底」
   那种断言在这里已经没有意义（写下去就是假的绿）。
   现在真正的风险换成了**浮层自己那层滚动**：
   `.led-form` 有 `max-height: 92vh; overflow-y: auto`，
   一旦哪里给它塞个 `scrollTop = scrollHeight`，矮屏上金额照样会被顶出浮层可视区。

   所以这里钉的是：
     · 刚打开时浮层**停在最上面**（scrollTop = 0），没有自己滚下去
     · 金额框完整落在**浮层可视区**里（这才是用户看到的「输入金额在里面」）
   四种屏高都要过。
   ================================================================ */
console.log('\n\x1b[1m第 7 组：打开浮层后金额一定要看得见（多种屏高）\x1b[0m');

const measureSheet = () => page.evaluate(() => {
  const form = document.querySelector('.led-form');
  if (!form) return null;
  const amount = form.querySelector('.input--amount');
  const f = form.getBoundingClientRect();
  const a = amount.getBoundingClientRect();
  // 浮层可视区 = 浮层自己的矩形 ∩ 视口（浮层贴底，正常情况下上边界就是它的上边界）
  const visTop = Math.max(0, f.top);
  const visBottom = Math.min(window.innerHeight, f.bottom);
  return {
    visTop: Math.round(visTop), visBottom: Math.round(visBottom),
    amountTop: Math.round(a.top), amountBottom: Math.round(a.bottom),
    formTop: Math.round(f.top), formBottom: Math.round(f.bottom),
    formH: Math.round(f.height),
    formScrollTop: Math.round(form.scrollTop),
    formScrollable: Math.round(form.scrollHeight - form.clientHeight),
    viewportH: window.innerHeight,
  };
});

function assertAmountVisible(geo, tag) {
  const amountVisible = geo.amountTop >= geo.visTop && geo.amountBottom <= geo.visBottom;
  ok(`${tag}：金额输入框完整落在浮层可视区里（用户要的就是这个）`, amountVisible,
    `金额 ${geo.amountTop}–${geo.amountBottom} / 浮层可视 ${geo.visTop}–${geo.visBottom}`);
  // 🔴 直接对着旧 bug：旧实现无条件滚到最底。浮层方案里对应的是
  //    「一打开浮层内部就滚到底」—— 那会把金额顶出可视区。
  check(`${tag}：浮层打开时停在最上面，没有自己滚下去`, geo.formScrollTop, 0);
}

const VIEWPORTS = [
  { h: 900, tag: '手机竖屏 900' },
  { h: 1100, tag: '高屏 1100' },
  { h: 1280, tag: '高屏 1280（PWA / 桌面浏览器）' },
  { h: 640, tag: '矮屏 640' },
];

for (const { h, tag } of VIEWPORTS) {
  await page.setViewport({ width: 430, height: h, deviceScaleFactor: 2 });
  await wait(500);
  await openLedger();
  const geo = await measureSheet();
  ok(`${tag}：浮层已渲染`, geo !== null);
  if (geo) assertAmountVisible(geo, tag);
  await closeSheet();
  ok(`${tag}：关掉后浮层消失`,
    await page.evaluate(() => document.querySelector('.led-form') === null));
}

/* ----------------------------------------------------------------
   7b. 浮层要**装得下**，不许让用户自己上下滑动
   ----------------------------------------------------------------
   用户 2026-09-23 第 1 条：「记一笔的那个界面调整一下，要不然数字键盘会要
   自己上下滑动才可以点击下面的内容」。

   所以这一组钉的第一件事是「**不用滚**」：常见手机屏高下，
   `.led-form` 的 `scrollHeight` 必须等于 `clientHeight`（即压根没有可滚空间）。
   第二件事是兜底：真到了装不下的极矮屏（横屏 / 小折叠外屏），
   浮层内部滚到底仍然要够得着保存键 —— 不能是死路。
   ================================================================ */
console.log('\n\x1b[1m7b. 浮层要装得下（不用用户自己滑），装不下时保存键也要够得着\x1b[0m');

/** 量「浮层要不要滚」+ 保存键在不在可视区 */
const measureFit = () => page.evaluate(() => {
  const f = document.querySelector('.led-form');
  if (!f) return null;
  const r = f.getBoundingClientRect();
  const s = f.querySelector('.led-key[data-action="save-entry"]').getBoundingClientRect();
  return {
    scrollable: Math.round(f.scrollHeight - f.clientHeight),
    saveTop: Math.round(s.top), saveBottom: Math.round(s.bottom),
    visTop: Math.round(Math.max(0, r.top)),
    visBottom: Math.round(Math.min(window.innerHeight, r.bottom)),
    formH: Math.round(r.height),
    viewportH: window.innerHeight,
  };
});

// 常见手机可见高度。**每一个都必须不用滚**（535px 的表单对得上任何 ≥ 582 的屏）
const FIT_VIEWPORTS = [
  { h: 915, tag: '常见全面屏 915' },
  { h: 873, tag: '常见全面屏 873' },
  { h: 740, tag: '带浏览器地址栏 740' },
  { h: 667, tag: 'iPhone SE 667' },
  { h: 640, tag: '小屏 640' },
  { h: 600, tag: '极窄可视区 600' },
];
for (const { h, tag } of FIT_VIEWPORTS) {
  await page.setViewport({ width: 430, height: h, deviceScaleFactor: 2 });
  await wait(450);
  await openLedger();
  const fit = await measureFit();
  ok(`${tag}：浮层已渲染`, fit !== null);
  if (fit) {
    check(`${tag}：🔴 不用滚动就能看全（用户要的就是这个）`, fit.scrollable, 0);
    ok(`${tag}：保存键在可视区里`, fit.saveTop >= fit.visTop && fit.saveBottom <= fit.visBottom,
      `保存键 ${fit.saveTop}–${fit.saveBottom} / 可视 ${fit.visTop}–${fit.visBottom}`);
  }
  await closeSheet();
}

// 兜底：极矮屏（横屏手机 ~360 高）真的装不下 —— 那也必须能滚到保存键
await page.setViewport({ width: 720, height: 360, deviceScaleFactor: 2 });
await wait(450);
await openLedger();
const tiny = await measureFit();
ok('横屏 720×360：浮层已渲染', tiny !== null);
if (tiny) {
  ok('横屏装不下 → 浮层内部确实可滚（这条是兜底，不是主诉求）', tiny.scrollable > 0,
    `可滚 ${tiny.scrollable}px / 表单高 ${tiny.formH} / 屏高 ${tiny.viewportH}`);
  await page.evaluate(() => {
    const f = document.querySelector('.led-form');
    f.scrollTop = f.scrollHeight;   // 滚的是浮层自己，不是 .app-body
  });
  await wait(400);
  const reach = await measureFit();
  ok('横屏滚到底能够到保存键（装不下也不能是死路）',
    reach.saveTop >= reach.visTop && reach.saveBottom <= reach.visBottom,
    `保存键 ${reach.saveTop}–${reach.saveBottom} / 可视 ${reach.visTop}–${reach.visBottom}`);
}

await closeSheet();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
await wait(400);

/* ================================================================
   第 8 组：收入方向也能挂账户（存入）
   ================================================================ */
console.log('\n\x1b[1m第 8 组：收入方向挂账户 = 存进去\x1b[0m');

await openLedger();
// 方向改由键盘右列的 ＋ / － 切（用户确认；参考图顶部没有收支胶囊）
await page.click('.led-key[data-dir="income"]');
await wait(500);
const dirNow = await page.$eval('.led-form__dir', (el) => el.textContent.trim());
check('点「＋」切到收入', dirNow, '收入');

await typeByPad('200');
await page.$eval('.led-form input[data-field="note"]', (el) => el.focus());
await page.keyboard.type('生活费');
await pickAccount('微信零钱');
await page.click('.led-key[data-action="save-entry"]');
await wait(900);

const afterIncome = await page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  const a = (await AccountService.list()).find((x) => x.name === '微信零钱');
  return { balance: a.balance, totalIn: a.totalIn, totalOut: a.totalOut };
});
near('收入方向：余额 500 + 200 = 700', afterIncome.balance, 700);
near('计入「累计充值」200', afterIncome.totalIn, 200);
near('不污染「累计消耗」', afterIncome.totalOut, 0);

/* ================================================================
   第 9 组：控制台
   ================================================================ */
console.log('\n\x1b[1m第 9 组：控制台\x1b[0m');
ok('无未预期的控制台 / 页面错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

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
