/**
 * verify_assets.mjs —— 账户页「资产总览」板块回归（v1.13.0）
 *
 * 覆盖：
 *   ① 净资产 = 总资产 − 总负债 的算式（含借入是负债、借出是资产的方向）
 *   ② 借入/借出、报销/未报销、定期/即将到期 各格子的数字
 *   ③ 逾期标红
 *   ④ 金额隐藏开关（含刷新后仍生效）
 *   ⑤ 资产分布的分组合计与折叠
 *   ⑥ 清空数据 → 账户，必须把 kv 里的资产明细一起清掉
 *   ⑦ v1.13.2：黄金撤出账户页（金价/克重格子不该再出现），
 *      但市值仍计入净资产，且入口必须能在「设置 → 黄金持仓」找到
 *
 * 用法：node tools/verify_assets.mjs   （需先 npm run serve）
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
].find((p) => existsSync(p));

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8080';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等某个滚动容器的 `scrollTop` 稳定。
 *
 * 🔴 `.record-body-host > .acct-view` 上有 `scroll-behavior: smooth`（style.css:1576），
 *    `scrollTop = scrollHeight` 之后要**等动画走完**再量位置。
 *    原来这里 `wait(600)` 写死 —— 单跑够，14 个脚本连着跑时机器一忙就量到中途，
 *    「开关底 851 / dock 顶 828」这种数看着像真 bug，其实是**没滚到底**（红线条 15）。
 */
async function stableScrollTop(sel, timeout = 5000) {
  let last = null; let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.$eval(sel, (el) => Math.round(el.scrollTop)).catch(() => null);
    if (v === null) { await wait(60); continue; }
    if (v === last) { same++; if (same >= 5) return v; } else { same = 0; last = v; }
    await wait(90);
  }
  return last;
}

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

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900, deviceScaleFactor: 2 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
/**
 * 设置页会去探测本机的离线 OCR 服务（http://127.0.0.1:8765/ocr）。
 * 测试机上没开那个服务，浏览器必然抛一条 ERR_CONNECTION_REFUSED ——
 * 这是**预期内**的噪声，不是 bug。
 * 🔴 它只能按 **URL** 认出来：消息文本里既没有「OCR」也没有端口号，
 *    所以老写法 `!/OCR/.test(m.text())` 挡不住（v1.13.2 访问设置页时暴露）。
 */
const isOcrProbe = (m) => {
  try { return /127\.0\.0\.1:8765/.test(m.location()?.url || ''); } catch { return false; }
};
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/OCR/.test(m.text())) return;
  if (isOcrProbe(m)) return;
  pageErrors.push('[console] ' + m.text());
});

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(600);

/* ---------- 播种数据（直接用模块 API，比点 UI 稳） ---------- */
console.log('\n\x1b[1m播种：1 个银行账户 1000 + 借入 300 + 借出 500 + 报销 80/120 + 黄金 10g@900 + 定期 10000\x1b[0m');
const seeded = await page.evaluate(async () => {
  const { default: AccountService } = await import('/js/services/account_service.js');
  const { default: AssetService } = await import('/js/services/asset_service.js');
  const { formatDate } = await import('/js/utils/date_utils.js');

  // 清干净：账户 + 资产明细
  for (const a of await AccountService.list()) await AccountService.removeWithLedger(a.id);
  await AssetService.clearAll();

  await AccountService.create({ name: '测试银行卡', type: 'bank', opening: 1000, openingDate: formatDate(new Date()) });

  // 借入 300，约定归还日已过（造逾期）
  await AssetService.addLoan({ direction: 'in', counterparty: '室友', amount: 300, dueDate: '2026-01-01' });
  await AssetService.addLoan({ direction: 'out', counterparty: '同学', amount: 500 });
  await AssetService.addReimbursement({ item: '打印费', amount: 80, reimbursed: true });
  await AssetService.addReimbursement({ item: '团建垫付', amount: 120 });
  await AssetService.addGold({ name: '金条', grams: 10 });
  await AssetService.setGoldPrice(900);
  // 定期到期日 = 今天 + 20 天（落在「即将到期」的 30 天窗口内）
  const mat = new Date(); mat.setDate(mat.getDate() + 20);
  await AssetService.addDeposit({ name: '一年期定存', amount: 10000, rate: 1.75, maturityDate: formatDate(mat) });

  const snap = await AssetService.snapshot(1000);
  return {
    netWorth: snap.netWorth, totalAssets: snap.totalAssets, totalLiabilities: snap.totalLiabilities,
    borrowedIn: snap.borrowedIn, lentOut: snap.lentOut,
    pendingTotal: snap.pendingTotal, reimbursedTotal: snap.reimbursedTotal,
    goldValue: snap.goldValue, totalGrams: snap.totalGrams,
    depositTotal: snap.depositTotal, dueSoonCount: snap.dueSoonCount,
    overdueCount: snap.overdueCount,
  };
});
check('模型：净资产 10320', seeded.netWorth, 10320);
check('模型：总资产 10620', seeded.totalAssets, 10620);
check('模型：总负债 300', seeded.totalLiabilities, 300);
check('模型：逾期 1 笔', seeded.overdueCount, 1);
check('模型：黄金市值 9000', seeded.goldValue, 9000);
check('模型：即将到期 1 笔', seeded.dueSoonCount, 1);

/* ---------- 进账户页 ---------- */
await page.reload({ waitUntil: 'networkidle2' });
await wait(600);
await gotoAccount();

const field = (name) => page.$eval(`[data-field="${name}"]`, (el) => el.textContent.trim()).catch(() => '(缺)');

/**
 * 从任意状态回到「记录 → 账户」页。
 * 🔴 刷新后记录页默认停在**打卡**板块，不是账户 —— 忘了这一步就会
 *    一直在等一个根本不存在的 .acct-total。
 */
async function gotoAccount() {
  await page.waitForSelector('.bottom-nav__item', { timeout: 5000 });
  await page.$$eval('.bottom-nav__item', (els) => els.find((e) => e.dataset.route === 'record').click());
  await page.waitForSelector('.record-body-host', { timeout: 5000 });
  await wait(300);
  await page.$$eval('.segmented__item', (els) => els.find((e) => e.dataset.tab === 'account').click());
  await page.waitForSelector('.acct-total', { timeout: 5000 });
  await wait(600);
}

console.log('\n\x1b[1m1. 净资产大卡\x1b[0m');
check('净资产（净资产卡头号数字）', await field('total-balance'), '¥10,320.00');
check('总资产', await field('total-assets'), '¥10,620.00');
check('总负债', await field('total-liabilities'), '¥300.00');

console.log('\n\x1b[1m2. 借入/借出 · 报销/未报销\x1b[0m');
check('借入（负债）', await field('borrowed-in'), '¥300.00');
check('借出（资产）', await field('lent-out'), '¥500.00');
check('已报销', await field('reimbursed'), '¥80.00');
check('未报销', await field('pending-reimburse'), '¥120.00');
const borrowedCls = await page.$eval('[data-field="borrowed-in"]', (el) => el.closest('.acct-metric').className);
ok('借入逾期标红提示', borrowedCls.includes('acct-metric--warn'), borrowedCls);
const borrowedTone = await page.$eval('[data-field="borrowed-in"]', (el) => el.className);
ok('借入数字用负债色', borrowedTone.includes('acct-metric__v--neg'), borrowedTone);
// 逾期数必须按方向分开：只有借入逾期时，借出那一格不能跟着报警。
// v1.13.1 起逾期不再是整行解释文字，改成标签行右侧的小角标。
const flagOf = (name) => page.$eval(`[data-field="${name}"]`, (el) => {
  const f = el.closest('.acct-metric').querySelector('.acct-metric__flag');
  return f ? f.textContent.trim() : '';
});
check('借入逾期角标', await flagOf('borrowed-in'), '1 笔逾期');
check('借出不被借入的逾期带偏（无角标）', await flagOf('lent-out'), '');
const lentCls = await page.$eval('[data-field="lent-out"]', (el) => el.closest('.acct-metric').className);
ok('借出没有逾期底色', !lentCls.includes('acct-metric--warn'), lentCls);

/* ---------- v1.13.1 视觉层级 ----------
 * 用户原话：「你那个账户全部都是一样大？能不能该大大，该小小」。
 * 根因是每格多了一行解释文字，把格子撑得比净资产卡还高。下面两条钉住这个结论。 */
const cellLines = await page.$$eval('.acct-grid--assets .acct-metric', (els) => els.map((e) => e.children.length));
ok('小格子只有两行（标签 + 数值，没有解释性第三行）', cellLines.every((n) => n === 2), JSON.stringify(cellLines));

const hierarchy = await page.evaluate(() => {
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  const box = (sel) => document.querySelector(sel).getBoundingClientRect().height;
  return {
    netFont: px(document.querySelector('.acct-total__value')),
    cellFont: px(document.querySelector('.acct-metric__v')),
    hero: box('.acct-total--net'),
    grid: box('.acct-grid--assets'),
    cell: box('.acct-metric'),
    netText: document.querySelector('.acct-view').innerText,
  };
});
ok('净资产数字明显大于小格子数字（≥1.8 倍）', hierarchy.netFont >= hierarchy.cellFont * 1.8,
  `${hierarchy.netFont}px vs ${hierarchy.cellFont}px`);
ok('净资产卡不低于小格子卡（层级不塌）', hierarchy.hero >= hierarchy.grid,
  `净资产 ${Math.round(hierarchy.hero)}px / 格子 ${Math.round(hierarchy.grid)}px`);
// v1.13.2：用户反馈小格子「还是很大」，靠减内边距 + 收字号再压了一轮。
// 单格两行文字，低于 50px 才算真的收住了（改回大 padding 就会立刻变红）。
ok('单格高度已收紧（< 50px）', hierarchy.cell < 50, `${Math.round(hierarchy.cell)}px`);

// 解释性文案必须消失 —— 它们既啰嗦，又把格子撑高
const BANNED = ['别人欠我的', '已拿回来的', '我欠别人的', '垫了还没报的', '不计入净资产',
  '共 3 个账户', '累计口径', '点分组收起', '点卡片展开', '持仓 1 笔'];
const leaked = BANNED.filter((t) => hierarchy.netText.includes(t));
ok('解释性文案已清除', leaked.length === 0, leaked.join('、') || '无残留');

console.log('\n\x1b[1m3. 定期（黄金已于 v1.13.2 撤出账户页）\x1b[0m');
check('定期本金', await field('deposit-total'), '¥10,000.00');
check('即将到期', await field('due-soon'), '1 笔');

/* 🔴 黄金只是「不显示」，不是「不算」：
   上面「模型：净资产 10320」里就含着 9000 的黄金市值。
   所以既要确认账户页真的没有它，也要确认入口真的还在（见 7.5 节），
   否则那笔钱会变成一个看不见、改不动的幽灵数字。 */
const goldCellsOnAcct = await page.$$eval(
  '.acct-view [data-field="gold-price"], .acct-view [data-field="gold-grams"]',
  (els) => els.length,
);
check('账户页不再出现金价 / 克重格子', goldCellsOnAcct, 0);
check('定期那一排只剩两格', await page.$$eval('.acct-grid--deposit .acct-metric', (els) => els.length), 2);

console.log('\n\x1b[1m4. 全局口径\x1b[0m');
check('累计充值（账户无流水）', await field('total-in'), '¥0.00');
check('累计消耗（账户无流水）', await field('total-out'), '¥0.00');
check('每月固定扣款（未设）', await field('recurring'), '无');
check('对账有差额（没对过账）', await field('diff-accounts'), '全部对得上');

/* v1.13.5：这四格从「标签在左、数值在右」的四行列表改回 2×2 格子。
   用户 2026-09-23：「这四个模块重新排列一下，不要拉的太长了」。 */
console.log('\n\x1b[1m4.5 账户概览改成 2×2 格子（v1.13.5）\x1b[0m');
check('概览是 4 个格子', await page.$$eval('.acct-grid--overview .acct-metric', (els) => els.length), 4);
check('概览是两列排布',
  await page.$eval('.acct-grid--overview', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);

const gridMetrics = await page.evaluate(() => {
  const px = (el) => parseFloat(getComputedStyle(el).fontSize);
  const h = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().height);
  const cells = [...document.querySelectorAll('.acct-grid--overview .acct-metric')];
  // 用 offsetTop 的去重个数数「有几行」——
  // 这比钉一个具体像素值稳，改了 padding / 字号也不会假红
  const rows = new Set(cells.map((c) => Math.round(c.offsetTop))).size;
  return {
    overviewV: px(document.querySelector('.acct-grid--overview .acct-metric__v')),
    assetsV: px(document.querySelector('.acct-grid--assets .acct-metric__v')),
    overviewH: h('.acct-grid--overview'),
    assetsH: h('.acct-grid--assets'),
    rows,
    cellH: Math.round(cells[0].getBoundingClientRect().height),
  };
});
ok('概览数值比资产明细小一号（保留视觉层级）',
  gridMetrics.overviewV < gridMetrics.assetsV,
  `概览 ${gridMetrics.overviewV}px / 资产明细 ${gridMetrics.assetsV}px`);
// 这是本组的核心：4 格必须排成 **2 行**，不是原来的 4 行
check('4 个格子排成 2 行（原来是 4 行）', gridMetrics.rows, 2);
// 松一点的绝对上限，用来兜住「退回四行列表」这种回归
// （四行列表约 150px；现在 2×2 实测 ~112px）
ok('概览整块高度没有退回四行列表的水平',
  gridMetrics.overviewH <= gridMetrics.cellH * 2 + 40,
  `实测 ${gridMetrics.overviewH}px（单格 ${gridMetrics.cellH}px × 2 + 余量）`);
ok('概览比资产明细那排更矮（不抢注意力）',
  gridMetrics.overviewH <= gridMetrics.assetsH,
  `概览 ${gridMetrics.overviewH}px / 资产明细 ${gridMetrics.assetsH}px`);

// 没有 onclick 的格子必须是 <div>：渲染成 <button> 会给人「能点」的错觉，
// 点了却什么都不发生 —— 正是「点了没反应」。
const staticTags = await page.$$eval('.acct-grid--overview .acct-metric', (els) => els.map((e) => e.tagName));
check('概览四格都是静态 div（不是假按钮）', staticTags.join(','), 'DIV,DIV,DIV,DIV');
ok('静态格子光标不是手型',
  (await page.$eval('.acct-grid--overview .acct-metric', (el) => getComputedStyle(el).cursor)) === 'default');
// 反过来：真能点的格子必须还是 button，别把交互性一起改没了
const assetsTags = await page.$$eval('.acct-grid--assets .acct-metric', (els) => els.map((e) => e.tagName));
check('资产明细四格仍然是 button（保留可点）', assetsTags.join(','), 'BUTTON,BUTTON,BUTTON,BUTTON');

console.log('\n\x1b[1m5. 资产分布（分组 + 合计 + 折叠）\x1b[0m');
const gname = await page.$eval('.acct-dist__gname', (el) => el.textContent.trim());
check('分组名用「储蓄账户」口径', gname, '储蓄账户(1)');
check('分组合计', await page.$eval('.acct-dist__gtotal', (el) => el.textContent.trim()), '¥1,000.00');
check('分组下列出账户', await page.$$eval('.acct-dist__row', (els) => els.length), 1);
await page.$eval('.acct-dist__group', (el) => el.click());
await wait(500);
check('折叠后账户行隐藏', await page.$$eval('.acct-dist__row', (els) => els.length), 0);
ok('折叠后箭头转向', (await page.$eval('.acct-dist__group', (el) => el.className)).includes('acct-dist__group--collapsed'));
await page.$eval('.acct-dist__group', (el) => el.click());
await wait(500);
check('展开后账户行回来', await page.$$eval('.acct-dist__row', (els) => els.length), 1);

console.log('\n\x1b[1m5.5 账户明细默认收起（v1.13.4）\x1b[0m');
// 「资产分布」已经列过每个账户的名字 + 余额，下面这摞大卡是同一批账户的详细版。
// 默认全摊开 = 同一批账户出现两次、页面被拉得很长，所以默认收起。
const toggleSel = '[data-action="toggle-account-detail"]';
check('标题带上账户数', await page.$eval(toggleSel, (el) => el.textContent.trim().replace(/\s+/g, '')), '账户明细（1）');
ok('默认是收起态', (await page.$eval(toggleSel, (el) => el.className)).includes('acct-section-title--collapsed'));
check('收起时不渲染账户大卡', await page.$$eval('.acct-card', (els) => els.length), 0);
const chevOf = () => page.$eval(toggleSel, (el) => getComputedStyle(el.querySelector('.acct-section-title__chev')).transform);
ok('收起时箭头转向（rotate -90deg）', (await chevOf()) !== 'none', await chevOf());
await page.$eval(toggleSel, (el) => el.click());
await wait(500);
check('点开后出现账户大卡', await page.$$eval('.acct-card', (els) => els.length), 1);
ok('点开后不再是收起态', !(await page.$eval(toggleSel, (el) => el.className)).includes('acct-section-title--collapsed'));
ok('点开后箭头转回来', (await chevOf()) === 'none', await chevOf());
await page.$eval(toggleSel, (el) => el.click());
await wait(500);
check('再点一次又收起', await page.$$eval('.acct-card', (els) => els.length), 0);

// 收起态的开关落在首屏之下 —— 滚到底后它必须完整可见，不能被悬浮 dock 挡住。
// （最后一个元素从「一张高卡片」变成「一行细开关」之后，这里最容易出事。）
await page.evaluate(() => {
  const v = document.querySelector('.record-body-host > .acct-view');
  if (v) v.scrollTop = v.scrollHeight;
});
const settledAt = await stableScrollTop('.record-body-host > .acct-view');
const dockSafe = await page.evaluate(() => {
  const t = document.querySelector('[data-action="toggle-account-detail"]');
  const dock = document.querySelector('.bottom-nav');
  if (!t) return { ok: false, toggleBottom: null, dockTop: null };
  const tr = t.getBoundingClientRect();
  const dr = dock ? dock.getBoundingClientRect() : null;
  return {
    ok: !dr || tr.bottom <= dr.top + 1,
    toggleBottom: Math.round(tr.bottom),
    dockTop: dr ? Math.round(dr.top) : null,
  };
});
ok(`滚到底后折叠开关不被底部导航挡住（scrollTop 停在 ${settledAt}）`, dockSafe.ok,
  `开关底 ${dockSafe.toggleBottom}px / dock 顶 ${dockSafe.dockTop}px`);
await page.evaluate(() => {
  const v = document.querySelector('.record-body-host > .acct-view');
  if (v) v.scrollTop = 0;
});
await wait(400);

console.log('\n\x1b[1m6. 金额隐藏开关\x1b[0m');
await page.$eval('[data-action="toggle-amounts"]', (el) => el.click());
await wait(500);
check('隐藏后净资产变遮罩', await field('total-balance'), '¥ ••••');
check('隐藏后总资产也遮住', await field('total-assets'), '¥ ••••');
check('隐藏后借入也遮住', await field('borrowed-in'), '¥ ••••');
check('隐藏后分组合计也遮住', await page.$eval('.acct-dist__gtotal', (el) => el.textContent.trim()), '¥ ••••');
ok('隐藏后不残留真实数字', !(await page.$eval('.acct-view', (el) => el.innerText)).includes('10,320.00'));

await page.reload({ waitUntil: 'networkidle2' });
await wait(600);
await gotoAccount();
check('刷新后隐藏偏好仍生效', await field('total-balance'), '¥ ••••');

await page.$eval('[data-action="toggle-amounts"]', (el) => el.click());
await wait(500);
check('再点一次恢复显示', await field('total-balance'), '¥10,320.00');

console.log('\n\x1b[1m7. 点格子能进明细\x1b[0m');
await page.$eval('[data-action="loan-in"]', (el) => el.click());
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(400);
const sheetTitle = await page.$eval('.sheet__title', (el) => el.textContent.trim());
ok('借入格子打开借入明细', sheetTitle.includes('借入'), sheetTitle);
const sheetItems = await page.$$eval('.sheet__item', (els) => els.map((e) => e.textContent.trim()));
ok('明细里有那笔 300', sheetItems.some((t) => t.includes('300.00')), sheetItems.join(' | '));
ok('明细里有「＋ 记一笔」入口', sheetItems.some((t) => t.includes('记一笔借入')));
await page.$eval('.sheet__item--cancel', (el) => el.click());
await wait(400);

console.log('\n\x1b[1m7.5 黄金入口搬到了「设置 → 黄金持仓」\x1b[0m');
// 设置页不在底部导航里，要从周历页头右上角的齿轮进 —— 别去点 .bottom-nav__item
await page.$$eval('.bottom-nav__item', (els) => els.find((e) => e.dataset.route === 'week').click());
await page.waitForSelector('.app-header__actions .icon-btn', { timeout: 5000 });
await page.$eval('.app-header__actions .icon-btn', (el) => el.click());
await page.waitForSelector('[data-action="gold"]', { timeout: 5000 });
await wait(400);
const goldRowDesc = await page.$eval('[data-action="gold"] .list-item__desc', (el) => el.textContent.trim());
ok('设置页能看持仓克重', goldRowDesc.includes('10 克'), goldRowDesc);
ok('设置页能看当前金价', goldRowDesc.includes('900.00'), goldRowDesc);
await page.$eval('[data-action="gold"]', (el) => el.click());
await page.waitForSelector('.sheet', { timeout: 4000 });
await wait(400);
const goldSheetTitle = await page.$eval('.sheet__title', (el) => el.textContent.trim());
ok('入口能打开黄金面板（不是死路）', goldSheetTitle.includes('黄金'), goldSheetTitle);
await page.$eval('.sheet__item--cancel', (el) => el.click());
await wait(400);
await gotoAccount();

console.log('\n\x1b[1m8. 清空数据 → 账户 要连资产明细一起清\x1b[0m');
const beforeClear = await page.evaluate(async () => {
  const { default: AssetService } = await import('/js/services/asset_service.js');
  return {
    loans: (await AssetService.loans()).length,
    reimb: (await AssetService.reimbursements()).length,
    gold: (await AssetService.gold()).length,
    deposits: (await AssetService.deposits()).length,
    price: await AssetService.goldPrice(),
  };
});
ok('清空前四类都有数据', beforeClear.loans === 2 && beforeClear.reimb === 2 && beforeClear.gold === 1 && beforeClear.deposits === 1 && beforeClear.price === 900);

const cleared = await page.evaluate(async () => {
  const { default: db } = await import('/js/services/database_service.js');
  const { default: AssetService } = await import('/js/services/asset_service.js');
  const counted = await db.countCategory('accounts');
  const n = await db.clearCategory('accounts');
  return {
    countedTotal: counted.total,
    countedKv: Object.keys(counted.per).filter((k) => k.startsWith('kv:')).length,
    cleared: n,
    loans: (await AssetService.loans()).length,
    reimb: (await AssetService.reimbursements()).length,
    gold: (await AssetService.gold()).length,
    deposits: (await AssetService.deposits()).length,
    price: await AssetService.goldPrice(),
  };
});
ok('统计口径含 kv 里的资产明细', cleared.countedKv >= 4, `kv 键 ${cleared.countedKv} 个`);
ok('清空条数 = 账户 1 + 资产 6', cleared.cleared === 7, `实际 ${cleared.cleared}`);
check('借入借出已清空', cleared.loans, 0);
check('报销已清空', cleared.reimb, 0);
check('黄金已清空', cleared.gold, 0);
check('定期已清空', cleared.deposits, 0);
check('金价已清零', cleared.price, 0);

await page.reload({ waitUntil: 'networkidle2' });
await wait(600);
await gotoAccount();
check('清空后净资产归零', await field('total-balance'), '¥0.00');
check('清空后总资产归零', await field('total-assets'), '¥0.00');
ok('清空后回到首次引导', await page.$('.acct-intro') !== null);

/* ---------- 截图（带数据的那一版） ---------- */
console.log('\n\x1b[1m重播一份数据用于截图\x1b[0m');
await page.evaluate(async () => {
  const { default: AccountService } = await import('/js/services/account_service.js');
  const { default: AssetService } = await import('/js/services/asset_service.js');
  const { formatDate } = await import('/js/utils/date_utils.js');
  await AccountService.create({ name: '一食堂饭卡', type: 'meal_card', opening: 287.5, openingDate: formatDate(new Date()) });
  await AccountService.create({ name: '建行卡', type: 'bank', opening: 14000, openingDate: formatDate(new Date()) });
  await AccountService.create({ name: '支付宝', type: 'wallet', opening: 3646.81, openingDate: formatDate(new Date()) });
  await AssetService.addLoan({ direction: 'in', counterparty: '室友小王', amount: 300, dueDate: '2026-01-01' });
  await AssetService.addLoan({ direction: 'out', counterparty: '同学小李', amount: 500 });
  await AssetService.addReimbursement({ item: '实验室打印费', amount: 120 });
  await AssetService.addGold({ name: '金条', grams: 10 });
  await AssetService.setGoldPrice(932.81);
  const mat = new Date(); mat.setDate(mat.getDate() + 20);
  await AssetService.addDeposit({ name: '一年期定存', amount: 10000, rate: 1.75, maturityDate: formatDate(mat) });
});
await page.reload({ waitUntil: 'networkidle2' });
await wait(600);
await gotoAccount();
await page.screenshot({ path: 'tools/shot_assets.png', fullPage: true });
console.log('  已保存 tools/shot_assets.png');

// v1.13.4：「账户明细」默认收起，收起态在首屏之下 —— 滚到底再拍一张，
// 否则截图里根本看不到那个折叠开关。
await page.evaluate(() => {
  const v = document.querySelector('.record-body-host > .acct-view');
  if (v) v.scrollTop = v.scrollHeight;
});
await wait(800);
await page.screenshot({ path: 'tools/shot_account_collapsed.png' });
console.log('  已保存 tools/shot_account_collapsed.png');

// v1.13.2：黄金入口搬到设置页了，顺手留一张图备查（同时含「关于」里的版本号）
await page.$$eval('.bottom-nav__item', (els) => els.find((e) => e.dataset.route === 'week').click());
await page.waitForSelector('.app-header__actions .icon-btn', { timeout: 5000 });
await page.$eval('.app-header__actions .icon-btn', (el) => el.click());
await page.waitForSelector('[data-action="gold"]', { timeout: 5000 });
await wait(600);
await page.screenshot({ path: 'tools/shot_settings_gold.png', fullPage: true });
console.log('  已保存 tools/shot_settings_gold.png');

console.log('\n未捕获异常：' + (pageErrors.length ? pageErrors.join(' | ') : '无'));
ok('无未捕获异常 / 控制台错误', pageErrors.length === 0);

console.log('\n' + '='.repeat(60));
if (fail) {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  failures.forEach((f) => console.log('  · ' + f));
} else {
  console.log(`\x1b[32m资产总览全部通过：${pass} 项\x1b[0m`);
}
console.log('='.repeat(60));
await browser.close();
process.exit(fail ? 1 : 0);
