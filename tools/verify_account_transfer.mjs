/**
 * verify_account_transfer.mjs —— 账户充值「关联账户」= 转账 的回归
 *
 * 对应用户诉求（2026-09-23 第 3 条）：
 *   「账户里面的充值可以有关联账户，也就是说，弹出来的这个界面，
 *     上面多加一个关联账户的选项」
 *   —— 追问确认的口径是「**转账：从那个账户真扣钱**」，
 *      不是只做个标记、也不是只记一笔备注。
 *
 * 第二轮（2026-09-23 第 2 条）：「账户充值的时候，那个关联选项改成必选项」
 *   —— 所以第 1 组现在还钉住：默认是**未选**（不是默认「不关联」），
 *      没选就点保存会被**就地拦下并提示**，不许静默按「不关联」走。
 *
 * 所以这个脚本钉的是**钱真的动了**：
 *   1. 充值弹窗里有「关联账户」这一行，默认未选、且是必选
 *   2. 选了另一个账户 → 转出方余额 -n、累计消耗 +n；转入方余额 +n、累计充值 +n
 *   3. 两条流水**互相指认**（linkedAccountId / linkedEntryId 对得上）
 *   4. 记账总账里**只有一条**镜像（转入侧），金额是 n 而不是 2n
 *      —— 这正是 v1.9.0 修过的老毛病，别把它改回来
 *   5. 选「不关联」→ 只动本账户，绝不凭空给别的账户扣钱
 *   6. 删掉转账的任意一半 → 另一半跟着没，镜像也一起撤
 *
 * 用法：node tools/verify_account_transfer.mjs   （需先 npm run serve）
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

/** 在弹窗里填值并点指定按钮 */
async function fillModal(value, okText) {
  await page.waitForSelector('.modal .input', { timeout: 4000 });
  await page.evaluate((v) => {
    const el = document.querySelector('.modal .input--multiline, .modal .input, .modal input');
    if (!el) return;
    el.focus(); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await wait(250);
  await clickModalBtn(okText);
}

/** 点弹窗里的某个按钮 */
async function clickModalBtn(text) {
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.modal button')].find((x) => (x.textContent || '').trim() === t);
    if (b) b.click();
  }, text);
  await wait(600);
}

/** 在弹窗的输入框里打字（不改 DOM，走真实键盘事件） */
async function typeInModal(text) {
  await page.evaluate(() => {
    const el = document.querySelector('.modal .input--multiline, .modal .input, .modal input');
    if (el) el.focus();
  });
  await page.keyboard.type(text);
  await wait(250);
}

/** 读两个账户 + 记账总账的快照 */
const snapshot = () => page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: LedgerService } = await import('./js/services/ledger_service.js');
  const accs = await AccountService.list();
  const by = Object.fromEntries(accs.map((a) => [a.name, a]));
  const pick = (a) => (a ? {
    id: a.id,
    balance: a.balance, totalIn: a.totalIn, totalOut: a.totalOut,
    // v1.13.7：扣掉转账后的口径 —— 账户概览的「累计充值 / 累计消耗」用的就是这两个
    totalInExternal: a.totalInExternal, totalOutExternal: a.totalOutExternal,
    entries: a.entries.map((e) => ({
      id: e.id, kind: e.kind, amount: e.amount,
      linkedAccountId: e.linkedAccountId ?? null,
      linkedEntryId: e.linkedEntryId ?? null,
      ledgerId: e.ledgerId ?? null,
    })),
  } : null);
  const m = new Date();
  const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
  const ov = await LedgerService.overview(key);
  const ledger = await DB.getLedgerEntries();
  return {
    wallet: pick(by['微信零钱']),
    card: pick(by['一食堂饭卡']),
    ledgerCount: ledger.length,
    // ⚠️ 「账户流水 ↔ 记账流水」的挂账关系存在**记账行**上
    //    （`accountId` + `accountEntryId`），不是存在账户流水的 `ledgerId` 上 ——
    //    两个方向用了两套字段（记账页挂账户是 v1.13.5，账户页镜像到记账是 v1.7.0）。
    //    撤镜像靠的正是这两个字段，所以要断言它们。
    ledgerRows: ledger.map((e) => ({
      amount: e.amount, direction: e.direction, source: e.source,
      accountId: e.accountId ?? null, accountEntryId: e.accountEntryId ?? null,
    })),
    monthIncome: ov.stats.income,
    monthExpense: ov.stats.expense,
  };
});

/**
 * 展开「账户明细」。
 *
 * 🔴 v1.13.4 起这一段**默认收起**，收起时 `.acct-card` 根本不渲染
 *    （不是 display:none，是压根没这棵子树）—— 所以想按卡片定位
 *    「充值」按钮，就必须先展开，否则永远找不到，还看不出为什么。
 *
 * ⚠️ 用 JS 的 `el.click()`，别用坐标点击：这个折叠标题在页面靠下，
 *    经常正好落在底部悬浮 dock 底下，坐标点击会点到 dock 上 → 假红。
 */
async function expandDetail() {
  await page.evaluate(async () => {
    const btn = document.querySelector('[data-action="toggle-account-detail"].acct-section-title--collapsed');
    if (!btn) return;
    btn.click();
    await new Promise((r) => setTimeout(r, 600));
  });
  await wait(400);
}

/** 进账户页并展开明细 */
async function goAccounts() {
  await clickText('记录'); await wait(800);
  await clickText('账户', '.segmented__item'); await wait(1000);
  await expandDetail();
}

/** 在指定账户那张卡上点某个按钮（按 data-action 找，别按文字 —— 文字会改） */
async function tapCardAction(accountName, action) {
  const hit = await page.evaluate(({ accountName, action }) => {
    const card = [...document.querySelectorAll('.acct-card')]
      .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes(accountName));
    if (!card) return 'no-card';
    const b = card.querySelector(`[data-action="${action}"]`);
    if (!b) return 'no-btn';
    b.click();
    return 'ok';
  }, { accountName, action });
  await wait(600);
  return hit;
}

/* ---------------- 准备：清库 + 建两个账户 ---------------- */

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

await page.evaluate(async () => {
  const { default: AccountService } = await import('./js/services/account_service.js');
  await AccountService.create({ name: '微信零钱', type: 'wallet', opening: 500 });
  await AccountService.create({ name: '一食堂饭卡', type: 'meal_card', opening: 100 });
});
await wait(300);

await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

const before = await snapshot();
ok('两个账户已建好（微信零钱 500 / 一食堂饭卡 100）',
  before.wallet?.balance === 500 && before.card?.balance === 100,
  `微信 ${before.wallet?.balance} / 饭卡 ${before.card?.balance}`);

await goAccounts();

/* ================================================================
   第 1 组：充值弹窗里多了「关联账户」这一行
   ================================================================ */
console.log('\n\x1b[1m第 1 组：充值第二步有「关联账户」选择行\x1b[0m');

// 找到「一食堂饭卡」那张卡上的「充值」按钮 —— 卡片顺序不固定，所以按卡定位
const opened = await tapCardAction('一食堂饭卡', 'recharge');
check('点到了「一食堂饭卡」的充值按钮', opened, 'ok');

await fillModal('200', '下一步');

const pickRow = await page.evaluate(() => {
  const row = document.querySelector('.field-pick[data-action="extra-pick"]');
  if (!row) return null;
  return {
    label: row.querySelector('.field-pick__k')?.textContent.trim() || '',
    value: row.querySelector('.field-pick__v')?.textContent.trim() || '',
    empty: !!row.querySelector('.field-pick__v--empty'),
    todo: row.classList.contains('field-pick--todo'),
  };
});
ok('第二步弹窗里有「关联账户」选择行', pickRow !== null);
if (pickRow) {
  check('那一行的标签是「关联账户」', pickRow.label, '关联账户');
  // 🔴 v1.13.5 第二轮：改成**必选**了（用户 2026-09-23 第 2 条）——
  //    默认不再是「不关联」，而是没选。这样用户必须自己判断钱是哪儿来的。
  check('默认是「未选」而不是默认「不关联」', pickRow.value, '请选择');
  ok('未选时用「待办」样式（虚线 + 主色，一眼看出还欠一次点击）', pickRow.todo);
}

// ⚠️ 顺序有讲究：来源（输入框）的 required 校验排在关联账户**前面**，
//    两个都空时先报的是来源。所以要先填好来源，才测得到关联账户那条必选。
await typeInModal('报销');

// 必选：来源填好了、但没选关联账户就点保存 → 要就地拦下
// （不是静默失败，也不是默认按「不关联」走）
await clickModalBtn('保存');
const blockedAcct = await page.evaluate(() => {
  const hint = document.querySelector('.modal .modal__hint');
  return {
    open: !!document.querySelector('.modal'),
    hint: hint?.textContent.trim() || '',
    shown: hint ? hint.style.display !== 'none' : false,
    todo: !!document.querySelector('.field-pick--todo'),
  };
});
ok('没选关联账户 → 弹窗不关（必选）', blockedAcct.open);
ok('没选关联账户 → 就地提示了', blockedAcct.shown && blockedAcct.hint.includes('请选'), blockedAcct.hint);
ok('被拦下后那一行还是待办态', blockedAcct.todo);

// 充值必须写明来源（v1.7.2 起的规矩）—— 空着点保存要就地拦下，不能静默失败
await page.evaluate(() => {
  const el = document.querySelector('.modal .input');
  if (!el) return;
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await clickModalBtn('保存');
const blocked = await page.evaluate(() => {
  const hint = document.querySelector('.modal .modal__hint');
  return {
    open: !!document.querySelector('.modal'),
    hint: hint?.textContent.trim() || '',
    shown: hint ? hint.style.display !== 'none' : false,
  };
});
ok('来源没填 → 弹窗不关（充值必须写明来源）', blocked.open);
ok('就地提示了「请填写这笔钱的来源」', blocked.shown && blocked.hint.includes('请填写'), blocked.hint);

await typeInModal('报销');

// 点开选择行 → 里面应该列出**另一个**账户，而不是自己
await page.click('.field-pick[data-action="extra-pick"]');
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(300);
const opts = await page.$$eval('.sheet__item', (els) => els.map((e) => e.textContent.trim()));
ok('选项里列出了「不关联」和「微信零钱」',
  opts.some((t) => t.includes('不关联')) && opts.some((t) => t.includes('微信零钱')),
  opts.join(' | '));
ok('🔴 选项里**没有**自己（转给自己会把余额算成两倍）',
  !opts.some((t) => t.includes('一食堂饭卡')), opts.join(' | '));
ok('选项里带了对方当前余额（选之前就能看出转不转得起）',
  opts.some((t) => /微信零钱（余额 ¥500\.00）/.test(t)), opts.join(' | '));

await clickText('微信零钱', '.sheet__item');
await wait(450);
const picked = await page.$eval('.field-pick__v', (el) => el.textContent.trim());
ok('选完之后那一行显示「微信零钱」', picked.includes('微信零钱'), picked);

/* ================================================================
   第 2 组：保存 → 钱真的从对方账户扣了
   ================================================================ */
console.log('\n\x1b[1m第 2 组：保存后两个账户的钱都动了\x1b[0m');

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.modal button')].find((x) => (x.textContent || '').trim() === '保存');
  if (b) b.click();
});
await wait(1100);

const after = await snapshot();
near('转出方 微信零钱 500 − 200 = 300', after.wallet.balance, 300);
near('转出方「累计消耗」计入 200', after.wallet.totalOut, 200);
near('转出方「累计充值」不受影响', after.wallet.totalIn, 0);
near('转入方 一食堂饭卡 100 + 200 = 300', after.card.balance, 300);
near('转入方「累计充值」计入 200', after.card.totalIn, 200);
near('转入方「累计消耗」不受影响', after.card.totalOut, 0);

check('两边各只有一条流水（没有重复落账）', after.wallet.entries.length, 1);
check('转入方也只有一条', after.card.entries.length, 1);

const wIn = after.card.entries[0];
const wOut = after.wallet.entries[0];
if (wIn && wOut) {
  check('转入侧 kind 是 in（充值）', wIn.kind, 'in');
  check('转出侧 kind 是 out（转出）', wOut.kind, 'out');
  near('转入侧金额 200', wIn.amount, 200);
  near('转出侧金额 200', wOut.amount, 200);
  ok('🔴 转入侧指认了转出账户', wIn.linkedAccountId != null, `linkedAccountId=${wIn.linkedAccountId}`);
  ok('🔴 转出侧指认了转入账户', wOut.linkedAccountId != null, `linkedAccountId=${wOut.linkedAccountId}`);
  check('转入侧指向对方那条流水', wIn.linkedEntryId, wOut.id);
  check('转出侧指向对方那条流水', wOut.linkedEntryId, wIn.id);
}

// 🔴 v1.13.7：转账**一条都不进**记账总账（用户 2026-09-24
//    「账户与账户之间的转账不计入收入，因为，在钱入账的时候已经计算过了的」）。
//    这 200 只是把钱从「微信零钱」挪到「一食堂饭卡」，总资产分文未变；
//    零钱当初**充值进来**那一次已经在记账页算过收入了，这里再算一次就是同一笔钱算两遍。
check('🔴 转账一条都没进记账总账', after.ledgerCount, 0);
near('🔴 记账当月收入 = 0（转账不是收入）', after.monthIncome, 0);
near('记账当月支出 = 0（转出侧也不进总账）', after.monthExpense, 0);

/* ================================================================
   第 3 组：选「不关联」→ 只动本账户（**而且这条要进总账**）
   ================================================================
   🔴 这一组是第 2 组的**反向对照**，缺了它第 2 组就没有说服力：
      如果「转账不进总账」是靠「把 acct_in 镜像整个删掉」实现的，
      第 2 组照样绿，但用户真正要的那部分收入也没了。
      所以这里必须证明：**外部充值仍然计收入**。
   ================================================================ */
console.log('\n\x1b[1m第 3 组：选「不关联」= 普通充值，要进总账\x1b[0m');

await page.evaluate(() => {
  const card = [...document.querySelectorAll('.acct-card')]
    .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes('一食堂饭卡'));
  const b = card.querySelector('[data-action="recharge"]');
  b.click();
});
await fillModal('50', '下一步');
await typeInModal('爸妈转账');
await page.evaluate(() => {
  const row = document.querySelector('.field-pick[data-action="extra-pick"]');
  if (row) row.click();
});
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(300);
await clickText('不关联', '.sheet__item');
await wait(400);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('.modal button')].find((x) => (x.textContent || '').trim() === '保存');
  if (b) b.click();
});
await wait(1000);

const afterNone = await snapshot();
near('本账户 300 + 50 = 350', afterNone.card.balance, 350);
near('本账户累计充值 200 + 50 = 250', afterNone.card.totalIn, 250);
near('🔴 别的账户一分钱都没动（还是 300）', afterNone.wallet.balance, 300);
check('别的账户仍然只有原来那一条流水', afterNone.wallet.entries.length, 1);
check('本账户现在有两条流水', afterNone.card.entries.length, 2);
// 转账那 200 没进总账，只有这笔 50 的外部充值进了
check('🔴 记账总账现在只有 1 条镜像（外部充值那条）', afterNone.ledgerCount, 1);
near('🔴 记账当月收入 = 50（= 外部充值；转账的 200 不算）', afterNone.monthIncome, 50);
// 反向对照：这条外部充值镜像必须**在**，而且要认领账户流水（删账户流水时靠它撤回）
ok('🔴 外部充值那条镜像还在，且认领了账户流水',
  afterNone.ledgerRows[0]?.accountId === afterNone.card.id
  && afterNone.ledgerRows[0]?.accountEntryId === afterNone.card.entries.at(-1)?.id,
  `accountId=${afterNone.ledgerRows[0]?.accountId} / accountEntryId=${afterNone.ledgerRows[0]?.accountEntryId}`);
check('镜像行方向是 income', afterNone.ledgerRows[0]?.direction, 'income');
ok('镜像行来源标成 account（账户页来的）',
  afterNone.ledgerRows[0]?.source === 'account', afterNone.ledgerRows[0]?.source);

/* ================================================================
   第 4 组：账户「消费」绝不能进记账总账（v1.9.0 的规矩）
   ================================================================
   用户原话（v1.9.0）：「避免重复计算，然后账户里面的消费不用走记账总账，
   只有充值的时候会记录在记账总账」。

   为什么这一组必须单独存在：转账那条路径**同时**有两道保险 ——
   `transfer()` 只镜像转入侧，`flowToLedger()` 又对 out 返回 null。
   于是单独拆掉任何一道，第 2 组的「当月收入不是 400」都还是绿的
   （两道都拆才红），等于那条断言其实没钉住任何东西。
   而这一组走的是**账户消费**这条真实路径，它只经过 `flowToLedger`，
   所以把那个 `return null` 拆掉，这里会立刻红。
   ================================================================ */
console.log('\n\x1b[1m第 4 组：账户消费不进记账总账\x1b[0m');

const beforeSpend = await snapshot();
const openedSpend = await tapCardAction('一食堂饭卡', 'spend');
check('点到了「一食堂饭卡」的消费按钮', openedSpend, 'ok');
await fillModal('30', '下一步');
await clickModalBtn('保存');
await wait(1000);

const afterSpend = await snapshot();
near('本账户 350 − 30 = 320', afterSpend.card.balance, 320);
near('本账户累计消耗 30', afterSpend.card.totalOut, 30);
check('账户侧多了一条流水', afterSpend.card.entries.length, beforeSpend.card.entries.length + 1);
check('🔴 记账总账条数没变（账户消费不镜像）',
  afterSpend.ledgerCount, beforeSpend.ledgerCount);
near('🔴 记账当月支出没变（镜像了就凭空多一笔开销）',
  afterSpend.monthExpense, beforeSpend.monthExpense);
near('记账当月收入也没变', afterSpend.monthIncome, beforeSpend.monthIncome);

/* ================================================================
   第 5 组：删掉转账的一半 → 另一半跟着没，镜像也撤
   ================================================================
   只删一半的话，剩下的那半就是**幽灵流水** ——
   用户在转入方看到「+200 从微信零钱转入」，可微信零钱那边已经没这回事了，
   两边余额从此对不上，而且没有任何提示。
   ================================================================ */
console.log('\n\x1b[1m第 5 组：删掉转账的任意一半，另一半也要跟着撤\x1b[0m');

// 从「微信零钱」那张卡的「全部 ›」里删掉转出那条
const openedFlows = await page.evaluate(() => {
  const card = [...document.querySelectorAll('.acct-card')]
    .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes('微信零钱'));
  if (!card) return false;
  const b = card.querySelector('[data-action="all-flows"]');
  if (!b) return false;
  b.click();
  return true;
});
ok('打开了「微信零钱」的全部流水', openedFlows);
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(300);
const flowOpts = await page.$$eval('.sheet__item', (els) => els.map((e) => e.textContent.trim()));
ok('流水面板里能看到那笔 200 的转出',
  flowOpts.some((t) => t.includes('200')), flowOpts.join(' | '));

await page.evaluate(() => {
  const b = [...document.querySelectorAll('.sheet__item')].find((x) => (x.textContent || '').includes('200'));
  if (b) b.click();
});
await page.waitForSelector('.modal', { timeout: 4000 });
await wait(300);
await clickText('删除', '.modal .btn');
await wait(1100);

const afterDelete = await snapshot();
check('转出方那条流水没了', afterDelete.wallet.entries.length, 0);
// 转入方此时应有 2 条：普通充值 50 + 那笔 30 的消费（转账那条被连带撤了）
check('🔴 转入方那条也一起没了（不留幽灵流水）', afterDelete.card.entries.length, 2);
near('转出方余额回到 500', afterDelete.wallet.balance, 500);
near('转出方累计消耗回到 0', afterDelete.wallet.totalOut, 0);
near('转入方余额 320 − 200 = 120', afterDelete.card.balance, 120);
near('转入方累计充值 250 − 200 = 50', afterDelete.card.totalIn, 50);
near('转入方累计消耗不受影响（还是那笔 30）', afterDelete.card.totalOut, 30);
// 转账那条**从来没进过**总账（v1.13.7），所以这里总账里仍只有那笔 50 的外部充值
check('记账总账里没有转账留下的痕迹（只剩那笔不关联的 50）', afterDelete.ledgerCount, 1);
near('记账当月收入回到 50', afterDelete.monthIncome, 50);
ok('剩下那条镜像属于那笔 50 的普通充值',
  afterDelete.ledgerRows[0]?.amount === 50, String(afterDelete.ledgerRows[0]?.amount));

/* ================================================================
   第 6 组：历史转账镜像的一次性清理（v1.13.7 数据迁移）
   ================================================================
   v1.13.5 加「关联账户 = 转账」时，转入侧还是照充值的老路子镜像进了总账。
   只拦新的不够 —— 那些**已经写进库里**的镜像会把用户的收入总额一直顶高，
   而且他自己翻账单看不出哪一笔是错的。
   这里直接往库里塞两条记账镜像：一条对应**转账转入**流水、一条对应**外部充值**
   流水，清掉「只跑一次」的 kv 标记，重进记账页，看是不是**只**删了转账那条。

   ⚠️ 两条必须**成对**塞：只塞转账那条的话，「把 acct_in 全删掉」也能让断言变绿，
      而那会把用户真正要的收入一起删没。
   ⚠️ 还要断言**账户流水没被删** —— 那是两个账户余额的事实依据，
      删了余额立刻对不上（这是 `unlinkLedgerEverywhere` 的语义，这里绝不能走它）。
   ================================================================ */
console.log('\n\x1b[1m第 6 组：历史转账镜像的一次性清理\x1b[0m');

const seeded = await page.evaluate(async () => {
  const { default: DB } = await import('./js/services/database_service.js');
  const { default: AccountService } = await import('./js/services/account_service.js');
  const accs = await AccountService.list();
  const card = accs.find((a) => a.name === '一食堂饭卡');
  const wallet = accs.find((a) => a.name === '微信零钱');

  // ⚠️ 日期必须落在**当前月**：`snapshot()` 里的 `monthIncome` 取的是「当月收入」，
  //    写死月份到了下个月那笔 77 就落在这个月之外 → 3 条断言假红（2026-10-13 踩过）。
  //    用 10 号：`getLedgerByMonth` 只按月份前缀过滤，没有上界，月初跑也没问题。
  const n0 = new Date();
  const DAY = `${n0.getFullYear()}-${String(n0.getMonth() + 1).padStart(2, '0')}-10`;

  // ① 一条**转账转入**流水（有 linkedAccountId）+ 它的记账镜像 → 该被清掉
  const move = card.addEntryWithId({
    kind: 'in', amount: 999, date: DAY, note: '假的转账', linkedAccountId: wallet.id,
  });
  await AccountService.update(card);
  await DB.addLedgerEntry({
    amount: 999, direction: 'income', category: 'acct_in', note: '一食堂饭卡 · 假的转账',
    date: DAY, source: 'account', accountId: card.id, accountEntryId: move.id,
  });

  // ② 一条**外部充值**流水（没有 linkedAccountId）+ 它的记账镜像 → 必须留着
  const fresh = card.addEntryWithId({
    kind: 'in', amount: 77, date: DAY, note: '爸妈给的',
  });
  await AccountService.update(card);
  await DB.addLedgerEntry({
    amount: 77, direction: 'income', category: 'acct_in', note: '一食堂饭卡 · 爸妈给的',
    date: DAY, source: 'account', accountId: card.id, accountEntryId: fresh.id,
  });

  // 清掉「只跑一次」的标记，让清理重新生效
  // ⚠️ 用 removeSetting（kv 的键是**字符串**），不能用内部 `_remove`
  await DB.removeSetting('ledger_transfer_mirror_purged_v1137');
  return { moveEntryId: move.id, freshEntryId: fresh.id };
});
await wait(400);

const beforePurge = await snapshot();
check('塞完之后总账里有 3 条（旧的 50 + 假的 999 + 真的 77）', beforePurge.ledgerCount, 3);

// 重进记账页 → 触发清理
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(1100);

const afterPurge = await snapshot();
const amounts = afterPurge.ledgerRows.map((r) => r.amount).sort((a, b) => a - b);
check('🔴 转账那条镜像被清掉了（999 没了）', amounts.includes(999), false);
ok('🔴 外部充值那条镜像留着（77 还在）', amounts.includes(77), amounts.join(' | '));
check('总账从 3 条变 2 条', afterPurge.ledgerCount, 2);
near('🔴 当月收入 = 50 + 77 = 127（999 不再计入）', afterPurge.monthIncome, 127);
// 账户流水**一条都不能少** —— 那是余额的依据
ok('🔴 账户那条转账流水没被删（余额依据还在）',
  afterPurge.card.entries.some((e) => e.id === seeded.moveEntryId && e.amount === 999),
  afterPurge.card.entries.map((e) => e.amount).join(' | '));
ok('账户那条外部充值流水也在',
  afterPurge.card.entries.some((e) => e.id === seeded.freshEntryId && e.amount === 77));
near('账户余额不受清理影响（120 + 999 + 77 = 1196）', afterPurge.card.balance, 1196);

// 幂等：再进一次不该继续删（靠 kv 标记）
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(1100);
const afterAgain = await snapshot();
check('🔴 清理是幂等的（第二次进来不会再动）', afterAgain.ledgerCount, afterPurge.ledgerCount);
near('当月收入还是 127', afterAgain.monthIncome, 127);

/* ================================================================
   第 7 组：账户概览的「累计充值 / 累计消耗」也不含转账（v1.13.7）
   ================================================================
   第 2 组管的是**记账总账**，这一组管的是**账户页那个「账户概览」**。
   两处是同一个道理、但是两套代码：概览是把各账户的 `totalIn` **加起来**，
   而转账会让同一笔钱在两个账户里各留一条（A 转入 +、B 转出 −），
   于是全局合计被凭空顶高 —— 钱从没离开过这个人。

   ⚠️ 这组**必须**先证明「转账真的发生了」（两个账户余额各动了 400），
      否则一个静默失败的转账也能让「合计没变」变绿，等于什么都没测。
   ⚠️ 还要钉住**单个账户卡片上的数字不跟着改** —— 那里问的是
      「这张卡进过多少钱」，250 确实进过，是对的。改错了才是 bug。
   ================================================================ */
console.log('\n\x1b[1m第 7 组：账户概览的合计不含转账\x1b[0m');

/** 读「账户概览」四格的显示文本（走真实 DOM，覆盖 account_view → summarizeOverview 这条链） */
const readOverview = () => page.evaluate(() => {
  const pick = (f) => document.querySelector(`.acct-grid--overview [data-field="${f}"]`)?.textContent?.trim() || '';
  return { in: pick('total-in'), out: pick('total-out') };
});

/** 读某张卡「当前余额 / 累计充值 / 累计消耗」三格的显示文本 */
const readCardBal = (name) => page.evaluate((n) => {
  const card = [...document.querySelectorAll('.acct-card')]
    .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes(n));
  if (!card) return null;
  return Object.fromEntries([...card.querySelectorAll('.acct-bal__cell')].map((c) => [
    c.querySelector('.acct-bal__k')?.textContent.trim() || '',
    c.querySelector('.acct-bal__v')?.textContent.trim() || '',
  ]));
}, name);

/**
 * 读某张卡底部那行「日均 ¥x · 还能用 约 n 天」。
 * 没有预估时（`daysLeft()` 为 null）**整行不渲染**，这里返回 null。
 */
const readPace = (name) => page.evaluate((n) => {
  const card = [...document.querySelectorAll('.acct-card')]
    .find((c) => (c.querySelector('.acct-card__name')?.textContent || '').includes(n));
  if (!card) return 'no-card';
  const el = card.querySelector('.acct-bal__pace');
  return el ? el.textContent.trim() : null;
}, name);

await goAccounts();
const ovBefore = await readOverview();
const stBefore = await snapshot();

// 真做一笔转账：微信零钱 → 一食堂饭卡 400（走和第 1 组同一条真实 UI 路径）
const openedOv = await tapCardAction('一食堂饭卡', 'recharge');
check('点到了「一食堂饭卡」的充值按钮', openedOv, 'ok');
await fillModal('400', '下一步');
await typeInModal('从零钱挪过来');
await page.evaluate(() => {
  const row = document.querySelector('.field-pick[data-action="extra-pick"]');
  if (row) row.click();
});
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(300);
await clickText('微信零钱', '.sheet__item');
await wait(400);
await clickModalBtn('保存');
await wait(1100);

await goAccounts();
const ovAfter = await readOverview();
const stAfter = await snapshot();

// ① 先证明这笔转账**真的发生了**
near('转出方 500 − 400 = 100', stAfter.wallet.balance, 100);
near('转入方 1196 + 400 = 1596', stAfter.card.balance, 1596);

// ② 模型层：`totalIn` 涨了（说明流水确实落了），`totalInExternal` 纹丝不动
near('🔴 转入方 totalIn 涨到 1526（流水确实落了）', stAfter.card.totalIn, 1526);
near('🔴 但 totalInExternal 仍是 127（转账不算充值）', stAfter.card.totalInExternal, 127);
near('🔴 转出方 totalOut 涨到 400（流水确实落了）', stAfter.wallet.totalOut, 400);
near('🔴 但 totalOutExternal 仍是 0（转账不算消费）', stAfter.wallet.totalOutExternal, 0);

// ③ UI 层：概览合计一分钱都不该动
check('🔴 概览「累计充值」没变（转账不是充值）', ovAfter.in, ovBefore.in);
check('🔴 概览「累计消耗」没变（转账不是消费）', ovAfter.out, ovBefore.out);
// 钉住绝对数字 —— 外部充值只有那两笔：50 + 77 = 127。
// 没修之前这里会显示 ¥1,126.00（把 999 的转账也算成收入了）。
check('🔴 概览「累计充值」= ¥127.00（50 + 77 两笔外部充值）', ovAfter.in, '¥127.00');
check('概览「累计消耗」= ¥30.00（那笔账户消费）', ovAfter.out, '¥30.00');

// ④ ⚠️ 单个账户卡片**故意不跟着改** —— 这张卡确实进过 1526
const balCard = await readCardBal('一食堂饭卡');
ok('读到了「一食堂饭卡」的余额区', balCard !== null);
if (balCard) {
  check('⚠️ 卡片「累计充值」仍是 ¥1,526.00（"这张卡进过多少" 是对的，不跟着改）',
    balCard['累计充值'], '¥1,526.00');
  check('卡片「累计消耗」仍是 ¥30.00', balCard['累计消耗'], '¥30.00');
}

// ⑤ 概览这四格**不该**再进记账总账那套逻辑：转账前后总账条数不变
check('🔴 记账总账条数没变（转账一条都不进）', stAfter.ledgerCount, stBefore.ledgerCount);
near('🔴 记账当月收入仍是 127（没被这 400 顶高）', stAfter.monthIncome, 127);

// ⑥ 转账也不该让转出方冒出「日均 / 还能用」预估（v1.13.7 续）
//    「微信零钱」只有那一笔 400 的转账、没有任何真实消费 → 整行不该渲染。
//    不排除转账的话这里会算出 400/1 = 400 的日均、daysLeft = 0 并点亮警告色。
check('🔴 转出方（微信零钱）不显示「日均 / 还能用」', await readPace('微信零钱'), 'null');
// ⚠️ 对照组不能省：否则「把预估整个删掉」也能让上一条变绿。
//    「一食堂饭卡」有一笔 30 的真实消费，那行小字必须还在。
const paceCard = await readPace('一食堂饭卡');
ok('对照组：有真实消费的「一食堂饭卡」仍显示「日均 / 还能用」',
  (paceCard || '').includes('日均'), String(paceCard));

/* ================================================================
   第 8 组：控制台
   ================================================================ */
console.log('\n\x1b[1m第 8 组：控制台\x1b[0m');
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
