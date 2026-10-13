/**
 * verify_glass.mjs —— 验证 v1.6.0 液态玻璃改版
 *
 * 覆盖四件事：
 *   ① 玻璃令牌真的生效（backdrop-filter / 半透明底 / 内高光）
 *   ② 底部 dock 与圆形悬浮加号的几何关系（fab 确实跨出 dock 上沿）
 *   ③ 快速记录抽屉能开、结构完整（4 张主卡 + 4 条迷你行 + 取消）
 *   ④ 抽屉能正确深链（点「记一笔」后记账页表单真的摊开了）
 *
 * 截图：shot_glass_week / shot_glass_quick / shot_glass_record / shot_glass_ledger
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8080/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-device-scale-factor=2'],
  defaultViewport: { width: 430, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

console.log('\n=== v1.6.0 液态玻璃改版验证 ===\n');

/* ---------- 1. 周历首屏 ---------- */
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(600);

console.log('1. 玻璃令牌与卡片');
const tokenCheck = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    glass1: cs.getPropertyValue('--glass-1').trim(),
    blurCard: cs.getPropertyValue('--blur-card').trim(),
    depth1: cs.getPropertyValue('--depth-1-y').trim(),
    radiusXl: cs.getPropertyValue('--radius-xl').trim(),
  };
});
check('--glass-1 已定义 (' + tokenCheck.glass1 + ')', tokenCheck.glass1.length > 0);
check('--blur-card 已定义 (' + tokenCheck.blurCard + ')', tokenCheck.blurCard.includes('blur'));
check('--depth-1-y 已定义 (' + tokenCheck.depth1 + ')', tokenCheck.depth1.length > 0);
check('--radius-xl 已定义 (' + tokenCheck.radiusXl + ')', tokenCheck.radiusXl.length > 0);

// 外壳背景含光晕（gradient）
const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
check('body 背景含径向光晕', bodyBg.includes('gradient'));

/* ---------- 2. 底部 dock ---------- */
console.log('\n2. 玻璃 Dock 与圆形悬浮加号');
const dock = await page.evaluate(() => {
  const nav = document.querySelector('.bottom-nav');
  const fab = document.querySelector('.bottom-nav__fab');
  if (!nav || !fab) return null;
  const cs = getComputedStyle(nav);
  const fs = getComputedStyle(fab);
  const nr = nav.getBoundingClientRect();
  const fr = fab.getBoundingClientRect();
  return {
    blur: cs.backdropFilter || cs.webkitBackdropFilter,
    radius: cs.borderRadius,
    navTop: nr.top, navHeight: nr.height,
    fabTop: fr.top, fabW: fr.width, fabH: fr.height,
    fabRadius: fs.borderRadius,
    fabBg: fs.backgroundImage,
    // fab 顶部必须明显高于 dock 顶部（跨出上沿）
    overhang: nr.top - fr.top,
  };
});
check('dock 存在', dock !== null);
check('dock 有 backdrop-filter (' + (dock?.blur || '').slice(0, 20) + '...)',
  (dock?.blur || '').includes('blur'));
check('dock 是圆角浮岛 (' + dock?.radius + ')', parseFloat(dock?.radius) >= 20);
check('加号为圆形 (' + dock?.fabRadius + ')',
  dock && parseFloat(dock.fabRadius) >= (dock.fabW / 2 - 1));
check('加号使用渐变背景', (dock?.fabBg || '').includes('gradient'));
check('加号跨出 dock 上沿 ' + Math.round(dock?.overhang || 0) + 'px',
  (dock?.overhang || 0) >= 12);

await page.screenshot({ path: 'tools/shot_glass_week.png' });

/* ---------- 3. 快速记录抽屉 ---------- */
console.log('\n3. 快速记录抽屉');
await page.click('.bottom-nav__fab');
await sleep(450);

const sheet = await page.evaluate(() => {
  const s = document.querySelector('.qsheet');
  if (!s) return null;
  const cs = getComputedStyle(s);
  return {
    blur: cs.backdropFilter || cs.webkitBackdropFilter,
    bg: cs.backgroundColor,
    grabber: !!document.querySelector('.qsheet .sheet__grabber'),
    title: document.querySelector('.qsheet__title')?.textContent || '',
    cards: document.querySelectorAll('.qsheet-card').length,
    cardTitles: Array.from(document.querySelectorAll('.qsheet-card__title')).map((n) => n.textContent),
    minis: document.querySelectorAll('.qsheet-mini').length,
    divider: !!document.querySelector('.qsheet__divider'),
    cancel: document.querySelector('.qsheet__cancel')?.textContent || '',
  };
});
check('抽屉已打开', sheet !== null);
check('抽屉是毛玻璃面板', (sheet?.blur || '').includes('blur'));
check('抽屉底色半透明 rgba', (sheet?.bg || '').startsWith('rgba'));
check('有顶部把守（grabber）', sheet?.grabber === true);
check('问候标题：「' + (sheet?.title || '') + '」', (sheet?.title || '').includes('嗨'));
check('上半区 4 张彩色动作卡（实际 ' + (sheet?.cards || 0) + '）', sheet?.cards === 4);
check('动作卡文案正确（' + (sheet?.cardTitles || []).join(' / ') + '）',
  JSON.stringify(sheet?.cardTitles) === JSON.stringify(['识图记账', '记一笔', '新增账户', '新建待办']));
check('有分割线', sheet?.divider === true);
check('下半区 4 条迷你功能行（实际 ' + (sheet?.minis || 0) + '）', sheet?.minis === 4);
check('取消按钮存在', (sheet?.cancel || '') === '取消');

await page.screenshot({ path: 'tools/shot_glass_quick.png' });

/* ---------- 4. 抽屉深链 ---------- */
console.log('\n4. 抽屉深链到记账表单');
// 关掉重开，点「记一笔」
await page.click('.qsheet__cancel');
await sleep(300);
check('取消后抽屉关闭', (await page.$('.qsheet')) === null);

await page.click('.bottom-nav__fab');
await sleep(400);
// 点「记一笔」卡（第二张）
const cards = await page.$$('.qsheet-card');
await cards[1].click();
await sleep(700);

const ledger = await page.evaluate(() => ({
  routeRecord: !!document.querySelector('.screen--record'),
  activeTab: document.querySelector('.segmented__item--active')?.textContent.trim() || '',
  formOpen: !!document.querySelector('.led-form'),
  formTitle: document.querySelector('.led-form__title')?.textContent.trim() || '',
  sheetGone: !document.querySelector('.qsheet'),
}));
check('已跳到记录页', ledger.routeRecord);
check('当前 tab 是「记账」（实际「' + ledger.activeTab + '」）', ledger.activeTab.includes('记账'));
check('记一笔表单已自动摊开', ledger.formOpen);
check('抽屉已关闭', ledger.sheetGone);

await page.screenshot({ path: 'tools/shot_glass_ledger.png' });

/* ---------- 5. 记账汇总卡玻璃 ---------- */
console.log('\n5. 记账页与账户页玻璃卡片');
const sumGlass = await page.evaluate(() => {
  const s = document.querySelector('.sum-card');
  if (!s) return null;
  const cs = getComputedStyle(s);
  const before = getComputedStyle(s, '::before');
  return {
    blur: cs.backdropFilter || cs.webkitBackdropFilter,
    bg: cs.backgroundColor,
    depth: before.content !== 'none' && before.content !== '',
    depthBottom: before.bottom,
  };
});
check('记账汇总卡是玻璃', (sumGlass?.blur || '').includes('blur'));
check('汇总卡底色半透明', (sumGlass?.bg || '').startsWith('rgba'));
check('汇总卡有层叠景深伪元素', sumGlass?.depth === true);

// 切到账户 tab
await page.evaluate(() => {
  const el = document.querySelector('.screen--record');
  if (el && el.__switchTab) el.__switchTab('account');
});
await sleep(600);
const acct = await page.evaluate(() => ({
  view: !!document.querySelector('.acct-view'),
  total: !!document.querySelector('.acct-total'),
  totalBlur: document.querySelector('.acct-total')
    ? (getComputedStyle(document.querySelector('.acct-total')).backdropFilter
      || getComputedStyle(document.querySelector('.acct-total')).webkitBackdropFilter)
    : '',
  segRadius: document.querySelector('.segmented') ? getComputedStyle(document.querySelector('.segmented')).borderRadius : '',
  segItemRadius: document.querySelector('.segmented__item') ? getComputedStyle(document.querySelector('.segmented__item')).borderRadius : '',
}));
check('账户视图已渲染', acct.view);
check('总余额卡是玻璃', (acct.totalBlur || '').includes('blur'));
check('分段控件为胶囊 (' + acct.segRadius + ')', parseFloat(acct.segRadius) >= 20);
check('分段项为胶囊 (' + acct.segItemRadius + ')', parseFloat(acct.segItemRadius) >= 20);

await page.screenshot({ path: 'tools/shot_glass_account.png' });

/* ---------- 5b. v1.7.0 新增元素仍然符合玻璃规范 ---------- */
console.log('\n5b. v1.7.0 新增：月扣款提示条与抽屉说明');

// 造一个带月扣款的账户，让扣款提示条与徽标有机会渲染
await page.evaluate(async () => {
  const { default: S } = await import('/js/services/account_service.js');
  const id = await S.create({ name: '玻璃检查卡', type: 'card', opening: 5000 }).catch(() => null);
  if (id) await S.setRecurring(id, { enabled: true, amount: 1500, day: 1, note: '房租', kind: 'out' }).catch(() => {});
  const el = document.querySelector('.screen--record');
  if (el && el.__switchTab) { el.__switchTab('checkin'); el.__switchTab('account'); }
});
await sleep(900);

// 🔴 「账户明细」v1.13.4 起**默认收起**（资产分布已经列过名字和余额，
//    默认再摊开一遍等于同一批账户出现两次）。月扣款徽标在账户卡里，
//    所以断言 `.acct-card__badge` 之前必须先展开。
//    ⚠️ 用 JS 的 `el.click()`，**不要**用坐标点击：这个折叠标题在页面靠下，
//    经常正好落在底部悬浮 dock 底下 —— 按元素中心坐标点下去会点到 dock 上，
//    于是「点了没反应」，下面四条断言全假红（踩过：中心 y≈881 / 视口高 900）。
const expandedDetail = await page.evaluate(async () => {
  const btn = document.querySelector('[data-action="toggle-account-detail"].acct-section-title--collapsed');
  if (!btn) return false;
  btn.click();
  await new Promise((r) => setTimeout(r, 600));
  return true;
});
if (expandedDetail) await sleep(400);

const newBits = await page.evaluate(() => {
  const pick = (sel) => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const cs = getComputedStyle(n);
    return {
      bg: cs.backgroundColor,
      hasGrad: cs.backgroundImage.includes('gradient'),
      blur: cs.backdropFilter || cs.webkitBackdropFilter,
      color: cs.color,
    };
  };
  return {
    recur: pick('.acct-recur'),
    auto: pick('.acct-auto'),
    badge: pick('.acct-card__badge'),
    viewOverflow: document.querySelector('.acct-view')
      ? getComputedStyle(document.querySelector('.acct-view')).overflowY : '',
  };
});
check('账户视图 overflow-y 为 auto（多账户可滚动）', newBits.viewOverflow === 'auto', newBits.viewOverflow);
check('月扣款说明条已渲染', newBits.recur !== null);
check('月扣款徽标已渲染', newBits.badge !== null);
check('月扣款说明条为浅色玻璃底', newBits.recur ? newBits.recur.hasGrad || newBits.recur.bg.startsWith('rgba') : false,
  JSON.stringify(newBits.recur));
check('月扣款文案为深色（浅色主题可读）',
  newBits.recur ? !/#(f|e|d)[0-9a-f]{2}/i.test(newBits.recur.color) : false,
  newBits.recur ? newBits.recur.color : 'n/a');

await page.screenshot({ path: 'tools/shot_glass_account_recur.png' });

/* ---------- 6. 运行时健康 ---------- */
console.log('\n6. 运行时健康');
const realErrs = errs.filter((e) => !/OCR|Failed to fetch|net::ERR/i.test(e));
check('无未捕获异常（' + realErrs.length + '）', realErrs.length === 0);
if (realErrs.length) realErrs.slice(0, 5).forEach((e) => console.log('      → ' + e));

await browser.close();

console.log('\n' + '='.repeat(52));
console.log(fail === 0 ? `全部通过：${pass} 项` : `通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
