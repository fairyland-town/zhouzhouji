/**
 * verify_account_detail.mjs —— 账户页「账户明细」板块的回归（v1.13.8）
 *
 * 用户 2026-10-13 截图报的三条，都发生在**账户页同一个板块**上：
 *
 *   ① 「账户明细」与页面最下面那块（底部悬浮 dock）隔得太近，
 *      导致它不太好被发现 —— 它当时只是一行 13px 的裸文字，
 *      滚到底正好压在 dock 与中央那枚浮起的「＋」底下。
 *   ② 点「全部 ›」看全部流水时，面板**显示不完全、且不能滚动**
 *      （选项是 `.sheet` 的直接子节点，而 `.sheet` 既没限高也不滚动）。
 *   ③ 账户卡里那几行账户流水被**拉得很长**，日期竖着排
 *      （`.acct-flow__date` 写死 `width: 36px`，装不下 "10-10" → 折成两行）。
 *
 * 这个脚本钉的是**可判定的观测值**，不是像素：
 *   ① 滚到底后折叠标题的底边必须**高于** dock 顶边（不重叠）；
 *      且它现在是一张有底、有圆角、有内边距的卡片，与上一张卡有明显间距。
 *   ② `.sheet__list` 真的溢出（scrollHeight > clientHeight）、
 *      赋值 scrollTop 后真的动了、滚到底最后一项可见、且「取消」常驻视口内；
 *      选项数 == 账户流水数（不再被 `slice(0, 30)` 截掉）。
 *   ③ 每个日期元素都只占**一行**（高度 ≈ 单行行高），行高彼此一致且 <= 30px。
 *
 * ⚠️ 三条断言都必须能**变红**（见文件末尾的「负向验证」注释）：
 *    把对应 CSS/JS 改回旧写法，本脚本必须报错 —— 否则等于没钉。
 *
 * 用法：node tools/verify_account_detail.mjs   （需先 npm run serve）
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

/**
 * 等某个滚动容器的 scrollTop 稳定。
 * 🔴 容器带 `scroll-behavior: smooth`，赋值后走的是动画 ——
 *    绝不能 sleep 一个固定毫秒数再断言位置（机器一忙就随机红）。
 */
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

/* ================================================================
   准备：播两个账户 + 34 笔流水
   （34 > 旧的 `slice(0, 30)` 上限，这样「不再截断」才是真的被钉住）
   ================================================================ */

const FLOW_COUNT = 34;

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

// 全新 profile 库本来就是空的；显式清一遍防假绿
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

await page.evaluate(async (FLOW_COUNT) => {
  const { AccountService } = await import('./js/services/account_service.js');
  const { ACCOUNT_TYPE } = await import('./js/models/account.js');

  // ⚠️ `AccountService.create()` 返回的是**自增主键（number）**，不是账户对象 ——
  //    DatabaseService._add() 直接把 `store.add()` 的结果（新 key）透出来。
  //    当成对象用（`.id`）会拿到 undefined，后面 addEntry 就会抛
  //    `DataError: The parameter is not a valid key`。
  const aId = await AccountService.create({
    name: '一食堂饭卡', type: ACCOUNT_TYPE.MEAL_CARD, opening: 100, openingDate: '2026-09-01',
  });
  const bId = await AccountService.create({
    name: '建行卡', type: ACCOUNT_TYPE.BANK, opening: 1200, openingDate: '2026-09-01',
  });

  // 日期从**本月** 5 号往前倒推，覆盖跨月（本月 xx / 上月 xx）—— 日期都是 "MM-DD" 五位，
  // 正是原来在 36px 里被折成两行的那个宽度。
  // ⚠️ 跟着当前月走：写死月份的话，到了下个月「跨月」那半边就变成两个月前了。
  const n0 = new Date();
  const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const THIS_YM = ymOf(n0);
  const PREV_YM = ymOf(new Date(n0.getFullYear(), n0.getMonth() - 1, 1));
  const dd = (d) => String(d).padStart(2, '0');
  const notes = ['洗澡', '午饭晚饭', '洗衣服', '微信', '农行', '中晚饭', '帮别人刷卡，已转支付宝'];
  for (let i = 0; i < FLOW_COUNT; i++) {
    const day = 5 - Math.floor(i / 3);          // 一天三笔
    const date = day >= 1 ? `${THIS_YM}-${dd(day)}` : `${PREV_YM}-${dd(30 + day)}`;
    await AccountService.addEntry(aId, {
      kind: i % 7 === 3 ? 'in' : 'out',
      amount: i % 7 === 3 ? 50 : (3.7 + i * 1.3),
      date,
      note: notes[i % notes.length],
    });
  }
  await AccountService.addEntry(bId, { kind: 'out', amount: 8, date: `${THIS_YM}-01`, note: '月扣款' });
  return true;
}, FLOW_COUNT);
await wait(400);

await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('账户', '.segmented__item'); await wait(1000);

/* ================================================================
   第 1 组：「账户明细」是一个**看得见的独立板块**，且不被 dock 压住
   ================================================================ */
console.log('\n\x1b[1m第 1 组：「账户明细」可发现性（不被 dock 挡住 / 是卡片不是裸文字）\x1b[0m');

ok('「账户明细」折叠标题已渲染',
  await page.$('[data-action="toggle-account-detail"]') !== null);

// 滚到底 —— 用户报的就是「滚到底之后它被压在 dock 底下」
await page.evaluate(() => {
  const host = document.querySelector('.record-body-host > .acct-view');
  if (host) host.scrollTop = host.scrollHeight;
});
await stableScrollTop('.record-body-host > .acct-view');
await wait(300);

const geo = await page.evaluate(() => {
  const host = document.querySelector('.record-body-host > .acct-view');
  const toggle = document.querySelector('[data-action="toggle-account-detail"]');
  const dock = document.querySelector('.bottom-nav');
  const fab = document.querySelector('.bottom-nav__fab');
  const dist = document.querySelector('.acct-dist');
  if (!host || !toggle || !dock) return null;
  const t = toggle.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  const f = fab ? fab.getBoundingClientRect() : null;
  // ⚠️ 注意别写成 getComputedStyle(t) —— t 是 DOMRect，不是元素
  const cs = getComputedStyle(toggle);
  return {
    hostFound: true,
    toggleTop: Math.round(t.top), toggleBottom: Math.round(t.bottom),
    dockTop: Math.round(d.top), dockBottom: Math.round(d.bottom),
    // 中央那枚「＋」向上**跨出** dock 上沿 20px —— 真正被占住的边界是它
    fabTop: f ? Math.round(f.top) : null,
    toggleH: Math.round(t.height),
    bg: cs.backgroundColor,
    radius: parseFloat(cs.borderTopLeftRadius) || 0,
    padTop: parseFloat(cs.paddingTop) || 0,
    borderW: parseFloat(cs.borderTopWidth) || 0,
    // 与「资产分布」卡片底边的间距（用户说「与最下面的版块隔得太近」）
    gapFromDist: dist ? Math.round(t.top - dist.getBoundingClientRect().bottom) : null,
    viewportH: window.innerHeight,
  };
});

ok('账户视图与折叠标题都在', geo && geo.hostFound, JSON.stringify(geo));
if (geo) {
  // 🔴 核心断言 A：滚到底后折叠标题的**底边必须高于 dock 的顶边**
  ok('滚到底后「账户明细」不与底部 dock 重叠',
    geo.toggleBottom <= geo.dockTop,
    `标题底边 ${geo.toggleBottom} / dock 顶边 ${geo.dockTop}`);
  ok('「账户明细」整体在视口内', geo.toggleTop >= 0 && geo.toggleBottom <= geo.viewportH,
    `top ${geo.toggleTop} / bottom ${geo.toggleBottom} / vh ${geo.viewportH}`);

  // 🔴 核心断言 B：还要让开**中央那枚浮起的「＋」**（它比 dock 上沿再高 20px）
  ok('让开了中央浮起的「＋」（没被它压住）',
    geo.fabTop !== null && geo.toggleBottom <= geo.fabTop,
    `标题底边 ${geo.toggleBottom} / ＋顶边 ${geo.fabTop}`);

  // 🔴 核心断言 C：「隔得太近」本身。
  //    这条**独立于卡片外观** —— 只把标题做成卡片、底部留白不补，
  //    上面 A/B 两条会过，这条不会。留 24px 是「看得出是另一块」的下限。
  const room = geo.dockTop - geo.toggleBottom;
  ok('与底部 dock 之间留有呼吸空间（>= 24px）', room >= 24,
    `实际 ${room}px`);

  // 它现在必须是一张**卡片**，不是一行裸文字
  ok('有底色（不是 transparent 裸文字）',
    geo.bg && geo.bg !== 'rgba(0, 0, 0, 0)' && geo.bg !== 'transparent', geo.bg);
  ok('有圆角（>= 12px）', geo.radius >= 12, `${geo.radius}px`);
  ok('有内边距（>= 10px）', geo.padTop >= 10, `${geo.padTop}px`);
  ok('有边框', geo.borderW >= 1, `${geo.borderW}px`);
  ok('点击区够高（>= 38px，不是一行细字）', geo.toggleH >= 38, `${geo.toggleH}px`);
  ok('与「资产分布」卡片拉开了间距（>= 10px）',
    geo.gapFromDist !== null && geo.gapFromDist >= 10, `${geo.gapFromDist}px`);
}

/* ================================================================
   第 2 组：「全部流水」面板能滚、不被裁、不截断
   ================================================================ */
console.log('\n\x1b[1m第 2 组：「全部流水」面板可滚动（原来显示不完全、滑不动）\x1b[0m');

// 展开账户明细（JS 点击 —— 它就在 dock 附近，坐标点击会点到 dock 上）
await page.evaluate(() => {
  const btn = document.querySelector('[data-action="toggle-account-detail"]');
  if (btn && btn.classList.contains('acct-section-title--collapsed')) btn.click();
});
await wait(700);

const opened = await page.evaluate(() => {
  const btn = document.querySelector('.acct-flows__more');
  if (!btn) return false;
  btn.click();
  return true;
});
ok('账户卡里有「全部 ›」入口', opened);
await wait(700);

ok('流水面板已打开', await page.$('.sheet') !== null);
ok('面板里有可滚动的选项列表 `.sheet__list`', await page.$('.sheet__list') !== null);

const sheetGeo = await page.evaluate(() => {
  const sheet = document.querySelector('.sheet');
  const list = document.querySelector('.sheet__list');
  const cancel = document.querySelector('.sheet__item--cancel');
  if (!sheet || !list) return null;
  const s = sheet.getBoundingClientRect();
  const c = cancel ? cancel.getBoundingClientRect() : null;
  const cs = getComputedStyle(list);
  return {
    sheetTop: Math.round(s.top), sheetBottom: Math.round(s.bottom),
    sheetH: Math.round(s.height),
    viewportH: window.innerHeight,
    overflowY: cs.overflowY,
    scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
    itemCount: list.querySelectorAll('.sheet__item').length,
    cancelBottom: c ? Math.round(c.bottom) : null,
    cancelTop: c ? Math.round(c.top) : null,
  };
});

ok('面板几何读到了', sheetGeo && sheetGeo.sheetTop !== undefined, JSON.stringify(sheetGeo));
if (sheetGeo) {
  ok('面板整体在视口内（顶部没被裁掉）',
    sheetGeo.sheetTop >= -1 && sheetGeo.sheetBottom <= sheetGeo.viewportH + 1,
    `top ${sheetGeo.sheetTop} / bottom ${sheetGeo.sheetBottom} / vh ${sheetGeo.viewportH}`);
  ok('面板高度被视口夹住（没有长到屏幕外）',
    sheetGeo.sheetH <= sheetGeo.viewportH, `${sheetGeo.sheetH} <= ${sheetGeo.viewportH}`);
  check('列表是滚动容器', sheetGeo.overflowY, 'auto');
  ok('列表确实溢出（确实需要滚动）',
    sheetGeo.scrollHeight > sheetGeo.clientHeight,
    `${sheetGeo.scrollHeight} > ${sheetGeo.clientHeight}`);
  // 🔴 旧代码 `slice(0, 30)` 会把 34 笔截成 30 笔 —— 这条专门钉它
  check('选项数 == 账户流水数（不再截断到 30）', sheetGeo.itemCount, FLOW_COUNT);
  ok('「取消」常驻在视口内（不被长列表顶出去）',
    sheetGeo.cancelTop >= 0 && sheetGeo.cancelBottom <= sheetGeo.viewportH + 1,
    `top ${sheetGeo.cancelTop} / bottom ${sheetGeo.cancelBottom}`);
}

// 真的滚一次
await page.evaluate(() => {
  const list = document.querySelector('.sheet__list');
  if (list) list.scrollTop = list.scrollHeight;
});
const sheetScrollTop = await stableScrollTop('.sheet__list');
ok('列表可以向下滚动（scrollTop > 0）', sheetScrollTop > 0, `scrollTop=${sheetScrollTop}`);

const lastItemVisible = await page.evaluate(() => {
  const list = document.querySelector('.sheet__list');
  if (!list) return false;
  const items = [...list.querySelectorAll('.sheet__item')];
  const last = items[items.length - 1];
  if (!last) return false;
  const lr = list.getBoundingClientRect();
  const ir = last.getBoundingClientRect();
  return ir.top >= lr.top - 1 && ir.bottom <= lr.bottom + 1;
});
ok('滚到底后最后一条流水可见（不是被裁在列表外）', lastItemVisible);

// 关掉面板（走正常取消路径，不要动 overlay）
await page.evaluate(() => {
  const c = document.querySelector('.sheet__item--cancel');
  if (c) c.click();
});
await wait(600);
ok('点「取消」后面板正常关闭', await page.$('.sheet') === null);

/* ================================================================
   第 3 组：账户卡里的流水行不被拉长（日期不竖排）
   ----------------------------------------------------------------
   🔴 这里有个**假绿陷阱**，必须记下来：
      光在默认字号下量「日期是不是只占一行」是抓不到这个 bug 的 ——
      在 Windows 的 Segoe UI 下 "10-10" 只有 31.95px，塞得进原来那个
      `width: 36px`；而用户手机上（安卓 / 更宽的中文字体）同样的
      "10-10" 超过 36px 就折成了两行。
      也就是说：**只按本机默认字体断言，把 CSS 改回旧写法照样全绿。**
      所以下面额外做一轮「字体放大」测量 —— 它复现的正是用户看到的几何：
      文字比那个 36px 的盒子宽，于是折行、行高一倍。
   ================================================================ */
console.log('\n\x1b[1m第 3 组：账户流水行排版（日期竖排 / 行被拉长）\x1b[0m');

/** 量一遍账户卡里的流水行 */
const measureFlows = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('.acct-flow')];
  return rows.map((r) => {
    const date = r.querySelector('.acct-flow__date');
    const note = r.querySelector('.acct-flow__note');
    const amt = r.querySelector('.acct-flow__amt');
    if (!date) return null;
    const dcs = getComputedStyle(date);
    const lineH = parseFloat(dcs.lineHeight) || parseFloat(dcs.fontSize) * 1.6;
    return {
      date: date.textContent.trim(),
      dateH: Math.round(date.getBoundingClientRect().height * 10) / 10,
      lineH: Math.round(lineH * 10) / 10,
      whiteSpace: dcs.whiteSpace,
      rowH: Math.round(r.getBoundingClientRect().height * 10) / 10,
      hasNote: !!note && note.textContent.trim().length > 0,
      hasAmt: !!amt && /[+-]?\d/.test(amt.textContent),
    };
  }).filter(Boolean);
});

const flowRows = await measureFlows();

ok('账户卡里渲染了流水行', flowRows.length > 0, `${flowRows.length} 行`);

// 🔴 核心断言（默认字号）：日期只占一行。
//    折行时高度会接近 2 × lineHeight，所以用 1.5 × lineHeight 作分界线。
const wrapped = flowRows.filter((r) => r.dateH > r.lineH * 1.5);
ok('每个日期都只占一行（没有竖排折行）', wrapped.length === 0,
  wrapped.map((r) => `「${r.date}」高 ${r.dateH}px / 行高 ${r.lineH}px`).join('；'));

const heights = flowRows.map((r) => r.rowH);
const maxH = Math.max(...heights); const minH = Math.min(...heights);
ok('行高不超过 30px（没有被拉长）', maxH <= 30, `最高 ${maxH}px`);
ok('各行高度一致（差 <= 2px）', maxH - minH <= 2, `${minH}~${maxH}px`);

ok('每行都带备注和金额（没有因为改版丢字段）',
  flowRows.every((r) => r.hasAmt) && flowRows.filter((r) => r.hasNote).length >= flowRows.length - 1,
  `${flowRows.filter((r) => r.hasNote).length}/${flowRows.length} 有备注`);

/* ---- 3b. 字体放大一轮：这才是能抓住「定宽 36px」的那条断言 ---- */
console.log('  \x1b[2m· 模拟安卓字体放大 / 更宽的中文字体，再量一遍\x1b[0m');

await page.evaluate(() => {
  const s = document.createElement('style');
  s.id = 'verify-flow-font-boost';
  // 15px ≈ 12.5px 放大 20%，是安卓字体放大 / 字体度量更宽时很保守的量级。
  // 只改字号，不动布局 —— 复现的正是「文字比那个定宽盒子宽」。
  s.textContent = '.acct-flow { font-size: 15px; }';
  document.head.appendChild(s);
});
await wait(300);

const boosted = await measureFlows();
const boostedWrapped = boosted.filter((r) => r.dateH > r.lineH * 1.5);
ok('字体放大后日期仍然只占一行（不依赖定宽）', boostedWrapped.length === 0,
  boostedWrapped.map((r) => `「${r.date}」高 ${r.dateH}px / 行高 ${r.lineH}px`).join('；'));
const boostedMaxH = Math.max(...boosted.map((r) => r.rowH));
ok('字体放大后行高仍然 <= 34px', boostedMaxH <= 34, `最高 ${boostedMaxH}px`);
ok('日期元素是 nowrap（换字体/放大字号也不会再折）',
  flowRows.every((r) => r.whiteSpace === 'nowrap'),
  flowRows.map((r) => r.whiteSpace).join(','));

await page.evaluate(() => {
  const s = document.getElementById('verify-flow-font-boost');
  if (s) s.remove();
});

/* ================================================================ */

if (pageErrors.length) {
  console.log('\n\x1b[31m页面报错：\x1b[0m');
  pageErrors.slice(0, 10).forEach((e) => console.log('  ' + e));
}
ok('页面没有未捕获的错误', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();

console.log('\n' + '='.repeat(60));
if (fail) {
  console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 共 ${pass + fail} 项`);
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log(`\x1b[32m全部通过\x1b[0m（${pass} 项）`);

/* ================================================================
   负向验证（改坏 → 必须变红 → 改回）—— 手工做一次即可，别写进脚本
   ----------------------------------------------------------------
   ① `.record-body-host > .acct-view` 的 padding-bottom 改回
      `calc(var(--nav-h) + 22px)`  → 「不与底部 dock 重叠」应报错。
   ② `.acct-section-title--toggle` 去掉 background / border-radius / padding
      → 「有底色 / 有圆角 / 有内边距」应报错。
   ③ `.sheet` 去掉 max-height，`.sheet__list` 去掉 overflow-y
      → 「面板高度被视口夹住」「列表是滚动容器」「可以向下滚动」应报错。
   ④ `.acct-flow__date` 改回 `width: 36px` 且去掉 nowrap
      → 「每个日期都只占一行」「行高不超过 30px」应报错。
   ⑤ `openFlows` 的 `all.map` 改回 `all.slice(0, 30)`
      → 「选项数 == 账户流水数」应报错。
   ================================================================ */
