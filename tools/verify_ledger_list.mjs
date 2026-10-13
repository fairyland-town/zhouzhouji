/**
 * verify_ledger_list.mjs —— 「流水明细」新版式（v1.13.5）的回归
 *
 * 用户 2026-09-23 给的参考图，结构是：
 *
 *   [ 05月09日 周一 | 支出 385 ]      ← 浅底圆角胶囊，宽度只包内容
 *   🍲  餐饮                          ← 大号那行是**分类名**
 *       跟同事一起AA                   ← 小号那行是备注
 *                                  -42.5   ← 深色数字，方向靠正负号
 *
 * 这个脚本钉的是**参考图里可判定的那几条**，不是像素：
 *   ① 组头是胶囊（只包内容、有底色、有圆角），文案是「MM月DD日 周X | 方向 小计」
 *   ② 组头小计 = 该组各行金额之和（**现场算真值**，不写死数字）
 *   ③ 一天里既有支出又有收入 → **仍然是同一个组**，组头把两边的小计都报出来
 *   ④ 行是平铺的：没有卡片底、没有边框、没有行间分隔线
 *   ⑤ 图标是正圆
 *   ⑥ 标题=分类名、副标题=备注（旧版是反的）
 *   ⑦ 金额是短格式：无 `¥`、无无意义小数尾巴、支出 `-` / 收入 `+`、深色不是红绿
 *
 * 用法：node tools/verify_ledger_list.mjs   （需先 npm run serve）
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

/*
 * ⚠️ 播种日期必须**跟着当前月份走**。
 *
 * 记账页默认只显示**本月**（`ledger_view.js`：`let month = monthKey(new Date())`）。
 * 这里原来把日期写死成 `2026-09-xx`，到了 10 月就一条都看不见 ——
 * 2026-10-13 实测：14 条断言全红，而代码根本没改。**假红比假绿更费时间**。
 *
 * `getLedgerByMonth` 只按 `date.startsWith(month)` 过滤，**没有上界**，
 * 所以本月任意一天（哪怕今天还没到）都会被取到，用固定的 18/19/20 号是安全的。
 */
const NOW = new Date();
const YM = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}`;
const MM = String(NOW.getMonth() + 1).padStart(2, '0');
const D = (d) => `${YM}-${String(d).padStart(2, '0')}`;       // 2026-10-20
const DL = (d) => `${MM}月${String(d).padStart(2, '0')}日`;   // 10月20日

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

/** 等 `.app-body` 的 scrollTop 稳定（`scroll-behavior: smooth`，不能 sleep 固定值） */
async function stableScrollTop(timeout = 4000) {
  let last = null; let same = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.$eval('.app-body', (el) => Math.round(el.scrollTop)).catch(() => null);
    if (v === null) { await wait(60); continue; }
    if (v === last) { same++; if (same >= 5) return v; } else { same = 0; last = v; }
    await wait(90);
  }
  return last;
}

/* ---------------- 准备：播一批流水 ---------------- */

await page.goto(BASE, { waitUntil: 'networkidle2' });
await wait(900);

// 全新 profile 库本来就是空的；显式清一遍防假绿
await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('campus_week_calendar');
  req.onsuccess = () => {
    const db = req.result;
    const names = ['ledger'].filter((n) => db.objectStoreNames.contains(n));
    if (!names.length) { res('none'); return; }
    const t = db.transaction(names, 'readwrite');
    names.forEach((n) => t.objectStore(n).clear());
    t.oncomplete = () => res('cleared');
    t.onerror = () => res('err');
  };
  req.onerror = () => res('err');
}));
await wait(300);

/*
 * 本月 20 号照着参考图播：三笔支出，合计正好 385（42.5 + 142.5 + 200）。
 * 这样「组头小计 = 各行之和」这条断言就是参考图里那个真值。
 * 本月 19 号故意播成「同一天既有支出又有收入」，验证收支会**合在同一组**里。
 *
 * ⚠️ 方向常量是 'expense' / 'income'，**不是** 'out' / 'in'。
 *    写 'in' 会被 LedgerEntry 静默归到 expense，连分类都会回退成「其他支出」。
 */
const SEED_ROWS = [
  { amount: 42.5, direction: 'expense', category: 'meal', note: '跟同事一起AA', date: D(20) },
  { amount: 142.5, direction: 'expense', category: 'daily', note: '买了一件外套', date: D(20) },
  { amount: 200, direction: 'expense', category: 'other_ex', note: '话费', date: D(20) },
  { amount: 22.5, direction: 'expense', category: 'meal', note: '一杯冰美式', date: D(19) },
  { amount: 500, direction: 'income', category: 'allowance', note: '家里给的', date: D(19) },
  // 18 号：**没有备注、没挂账户、也不是镜像**的一笔 —— 副标题整行都空。
  // 这种行最容易被写塌：要么留一个空元素把行撑高，要么行矮一截跟别的不齐。
  { amount: 9.9, direction: 'expense', category: 'study', note: '', date: D(18) },
];
await page.evaluate(async (rows) => {
  const DB = (await import('./js/services/database_service.js')).default;
  for (const r of rows) await DB.addLedgerEntry(r);
}, SEED_ROWS);
await wait(400);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);

await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(900);

ok('流水列表已渲染', await page.$('.led-day') !== null);

/* ================================================================
   第 1 组：组头是「日期 | 方向 小计」的胶囊
   ================================================================ */
console.log('\n\x1b[1m第 1 组：组头胶囊\x1b[0m');

const heads = await page.evaluate(() => [...document.querySelectorAll('.led-day')].map((d) => {
  const head = d.querySelector('.led-day__head');
  const items = d.querySelector('.led-day__items');
  const hs = head ? getComputedStyle(head) : null;
  const sums = [...d.querySelectorAll('.led-day__sum')];
  return {
    date: d.querySelector('.led-day__date')?.textContent.trim() || '',
    sep: !!d.querySelector('.led-day__sep'),
    dir: d.querySelector('.led-day__dir')?.textContent.trim() || '',
    total: d.querySelector('.led-day__total')?.textContent.trim() || '',
    // 一天可能有**两组**小计（支出 + 收入）—— 全都要
    sumCount: sums.length,
    sums: sums.map((s) => ({
      dir: s.querySelector('.led-day__dir')?.textContent.trim() || '',
      total: s.querySelector('.led-day__total')?.textContent.trim() || '',
    })),
    // 两组小计之间的圆点是用 `::before` 画的，取伪元素的计算样式来看有没有
    dots: sums.map((s) => String(getComputedStyle(s, '::before').content || '')),
    headW: head ? Math.round(head.getBoundingClientRect().width) : 0,
    rowW: items ? Math.round(items.getBoundingClientRect().width) : 0,
    display: hs ? hs.display : '',
    wrap: hs ? hs.flexWrap : '',
    radius: hs ? parseFloat(hs.borderTopLeftRadius) : 0,
    // rgba(0,0,0,0) = 透明
    bg: hs ? hs.backgroundColor : '',
    amounts: [...d.querySelectorAll('.led-item__amount')].map((a) => a.textContent.trim()),
  };
}));

// 3 个日期 → **3 个组**（19 号有收有支，合在一组里，不再裂开）
check('3 个日期 → 3 个组（同一天只有一组）', heads.length, 3);
const day20 = heads.find((h) => h.date.includes(DL(20)));
const day19 = heads.find((h) => h.date.includes(DL(19)));

ok(`${MM}-20 那一组在`, !!day20);
ok(`${MM}-19 那一组在`, !!day19);

if (day20) {
  ok('日期文案是「MM月DD日 周X」', /^\d{2}月\d{2}日 周[一二三四五六日]$/.test(day20.date), day20.date);
  check('方向文案', day20.dir, '支出');
  // 🔴 参考图里的真值：42.5 + 142.5 + 200 = 385，且短格式不带小数尾巴
  check('组头小计 = 各行之和（参考图真值 385）', day20.total, '385');
  ok('日期与方向之间有分隔符', day20.sep);
  check('组头是 inline-flex（宽度只包内容）', day20.display, 'inline-flex');
  ok('组头比行窄 —— 是胶囊不是通栏', day20.headW < day20.rowW * 0.75,
    `组头 ${day20.headW}px / 行 ${day20.rowW}px`);
  ok('组头有圆角', day20.radius >= 8, `radius ${day20.radius}px`);
  ok('组头有浅色底（不是透明）', day20.bg !== 'rgba(0, 0, 0, 0)', day20.bg);
  check('组内三行金额都是短格式',
    day20.amounts.join(' '), '-42.5 -142.5 -200');
  // 🔴 只有支出的那天**只报一组小计** —— 不给另一边补「收入 0」。
  //    零值小计是纯噪音：用户这天没记收入，不需要被告知。
  check('只有支出的那天只报一组小计', day20.sumCount, 1);
  check('只有支出的那天不补「收入 0」', day20.sums[0]?.dir, '支出');
  // 组头允许换行（320px 窄屏上「支出 … · 收入 …」会顶到边界）
  check('组头允许换行（窄屏兜底）', day20.wrap, 'wrap');
}

/* ================================================================
   第 2 组：同一天有收有支 → **合在一组**（用户 2026-09-23 要求）
   ================================================================
   🔴 用户原话：「记账里面同一天的收入和支出放在一起啊」。
      旧版按「日期 → 收支方向」两级分组，19 号这天有支出 22.5 + 收入 500，
      于是裂成上下两个 `.led-day`、各带一个小计 —— 看起来像两天。
      现在同一天只有一个组，组头把两边的小计都报出来。
   ================================================================ */
console.log('\n\x1b[1m第 2 组：同一天的收入和支出放在一起\x1b[0m');

check(`${MM}-19 只有一个组（不再按方向裂开）`,
  heads.filter((h) => h.date.includes(DL(19))).length, 1);
if (day19) {
  check('组头报出两组小计', day19.sumCount, 2);
  check('小计顺序固定「支出在前」', day19.sums.map((s) => s.dir).join('|'), '支出|收入');
  // ⚠️ 用 `?.` 取值：分组一旦回归，`sums[1]` 就是 undefined，
  //    直接 `.total` 会让整个脚本抛异常退出，后面几十条断言一条都不跑
  //    （负向验证时踩过：只报出 3 条红就崩了，看不到全貌）。
  check('支出小计只算支出', day19.sums[0]?.total, '22.5');
  check('收入小计只算收入', day19.sums[1]?.total, '500');
  // 两组小计之间用圆点分隔（`::before`），第一组前面**不该**有圆点
  ok('两组小计之间有圆点分隔', (day19.dots[1] || '').includes('·'), day19.dots[1]);
  ok('第一组小计前面没有圆点', !(day19.dots[0] || '').includes('·'), day19.dots[0]);
  // 收支行都在**同一个**组里
  ok('支出行在这一组里', day19.amounts.includes('-22.5'), day19.amounts.join(' '));
  ok('收入行也在这一组里', day19.amounts.includes('+500'), day19.amounts.join(' '));
  // 组内保持录入先后（`ov.entries` 已是「日期倒序 + 同日内录入时间倒序」），
  // 不按方向二次排序 —— 流水是流水，时间顺序本身就是信息
  check('组内按录入先后排列', day19.amounts.join(' '), '-22.5 +500');
}

/* ================================================================
   第 3 组：行是平铺的（无卡片底 / 无边框 / 无分隔线 / 图标正圆）
   ================================================================ */
console.log('\n\x1b[1m第 3 组：平铺行\x1b[0m');

const row = await page.evaluate(() => {
  const items = document.querySelector('.led-day__items');
  const it = document.querySelector('.led-item');
  const icon = document.querySelector('.led-item__icon');
  if (!items || !it || !icon) return null;
  const is = getComputedStyle(items);
  const rs = getComputedStyle(it);
  const gs = getComputedStyle(icon);
  const ib = icon.getBoundingClientRect();
  return {
    itemsBg: is.backgroundColor,
    itemsBorder: parseFloat(is.borderTopWidth),
    itemBorderBottom: parseFloat(rs.borderBottomWidth),
    itemBg: rs.backgroundColor,
    iconRadius: gs.borderTopLeftRadius,
    iconW: Math.round(ib.width), iconH: Math.round(ib.height),
    title: document.querySelector('.led-item__title')?.textContent.trim() || '',
    desc: document.querySelector('.led-item__desc')?.textContent.trim() || '',
  };
});

ok('行容器取到了', row !== null);
if (row) {
  check('行容器没有卡片底', row.itemsBg, 'rgba(0, 0, 0, 0)');
  check('行容器没有边框', row.itemsBorder, 0);
  check('行之间没有分隔线', row.itemBorderBottom, 0);
  check('行自身没有底色', row.itemBg, 'rgba(0, 0, 0, 0)');
  // 正圆：border-radius 是 50%，且宽高相等
  check('图标是正圆（border-radius 50%）', row.iconRadius, '50%');
  check('图标宽高相等', row.iconW, row.iconH);
  ok('图标比旧版大（>= 34px）', row.iconW >= 34, `${row.iconW}px`);
}

/* ================================================================
   第 3b 组：没有备注的那一行（副标题整行空）
   ================================================================ */
console.log('\n\x1b[1m第 3b 组：没有备注的行\x1b[0m');

// ⚠️ `DL()` 是 **Node 侧**的函数，浏览器里没有 —— 必须当参数传进去，
//    直接在 evaluate 里调会 `ReferenceError` 把脚本打断（后面几十条一条都不跑）。
const bare = await page.evaluate((dl18) => {
  const d = [...document.querySelectorAll('.led-day')]
    .find((x) => (x.querySelector('.led-day__date')?.textContent || '').includes(dl18));
  if (!d) return null;
  const it = d.querySelector('.led-item');
  const withDesc = [...document.querySelectorAll('.led-item')]
    .find((x) => x.querySelector('.led-item__desc'));
  return {
    hasDesc: !!it?.querySelector('.led-item__desc'),
    title: it?.querySelector('.led-item__title')?.textContent.trim() || '',
    amount: it?.querySelector('.led-item__amount')?.textContent.trim() || '',
    bareH: it ? Math.round(it.getBoundingClientRect().height) : 0,
    normalH: withDesc ? Math.round(withDesc.getBoundingClientRect().height) : 0,
    total: d.querySelector('.led-day__total')?.textContent.trim() || '',
  };
}, DL(18));

ok(`${MM}-18 那一组在`, bare !== null);
if (bare) {
  check('没有备注就不渲染副标题（不留空元素）', bare.hasDesc, false);
  check('只有分类名当标题', bare.title, '学习');
  check('金额照旧带符号', bare.amount, '-9.9');
  check('组头小计 = 9.9', bare.total, '9.9');
  // 🔴 靠 min-height 顶住：没有副标题的行不能比别的行矮一截
  check('裸行与有副标题的行等高', bare.bareH, bare.normalH);
}

/* ================================================================
   第 4 组：标题是分类名、副标题是备注
   ================================================================ */
console.log('\n\x1b[1m第 4 组：标题 / 副标题\x1b[0m');

const titles = await page.$$eval('.led-item__title', (els) => els.map((e) => e.textContent.trim()));
const descs = await page.$$eval('.led-item__desc', (els) => els.map((e) => e.textContent.trim()));

// 参考图里大号那行是「餐饮 / 购物 / 通讯」= 分类
ok('标题里出现分类名「餐饮」', titles.includes('餐饮'), titles.join(' | '));
ok('标题里出现分类名「日用」', titles.includes('日用'), titles.join(' | '));
ok('标题里出现分类名「生活费」（收入类）', titles.includes('生活费'), titles.join(' | '));
// 备注必须还在，只是降为副标题
ok('备注「跟同事一起AA」在副标题里', descs.includes('跟同事一起AA'), descs.join(' | '));
ok('备注「买了一件外套」在副标题里', descs.includes('买了一件外套'), descs.join(' | '));
// 反向：备注不能还占着标题位（旧版就是反的）
ok('备注没占标题位', !titles.includes('跟同事一起AA'), titles.join(' | '));
ok('分类名没占副标题位', !descs.includes('餐饮'), descs.join(' | '));

/* ================================================================
   第 5 组：金额短格式 + 深色（不是红绿）
   ================================================================ */
console.log('\n\x1b[1m第 5 组：金额样式\x1b[0m');

const amt = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.led-item__amount')];
  const exp = document.querySelector('.led-item__amount--expense');
  const inc = document.querySelector('.led-item__amount--income');
  const title = document.querySelector('.led-item__title');
  const cs = (el) => (el ? getComputedStyle(el).color : '');
  return {
    texts: all.map((a) => a.textContent.trim()),
    expColor: cs(exp), incColor: cs(inc), titleColor: cs(title),
    expWeight: exp ? getComputedStyle(exp).fontWeight : '',
    titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
    amtSize: exp ? parseFloat(getComputedStyle(exp).fontSize) : 0,
  };
});

ok('金额里没有币号 ¥', !amt.texts.some((t) => t.includes('¥')), amt.texts.join(' | '));
ok('金额里没有无意义的小数尾巴 .00',
  !amt.texts.some((t) => /\.0+$/.test(t)), amt.texts.join(' | '));
ok('支出带负号', amt.texts.some((t) => t.startsWith('-')), amt.texts.join(' | '));
ok('收入带正号', amt.texts.some((t) => t.startsWith('+')), amt.texts.join(' | '));
ok('每笔金额都带符号', amt.texts.every((t) => /^[+-]/.test(t)), amt.texts.join(' | '));
// 🔴 参考图里支出也是深色数字，不是红色。
//    方向已经由组头的「支出 / 收入」和行首的 +/- 说清楚了。
//    要改回红绿，就把这三条断言一起改掉（别只改 CSS 让测试假红）。
check('支出金额是深色（与标题同色）', amt.expColor, amt.titleColor);
check('收入金额与支出同色（不用红绿区分）', amt.incColor, amt.expColor);
ok('金额字号不小于标题', amt.amtSize >= amt.titleSize, `金额 ${amt.amtSize}px / 标题 ${amt.titleSize}px`);

/* ================================================================
   第 5b 组：近 6 个月趋势是**曲线图**（v1.13.5 第二轮，用户给了参考图）
   ================================================================
   参考图要点：平滑曲线 + 曲线下渐变填充 + 横向网格线 + 峰值套空心圆环 +
   一条虚线垂到基线 + 两端轴标签 + 右上角支出/收入胶囊。

   🔴 最值得钉的一条是「**曲线不许冲出绘图区**」：
      平滑曲线用的是 Catmull-Rom 转三次贝塞尔，这个插值**会过冲**，
      所以控制点 y 必须夹在绘图区内。

      ⚠️ 但过冲**只在数据够极端时才看得见**，随便找一组数据是测不出来的 ——
      我第一版用了 [820, 1460, 640, 1980, 910, 306.85]，实测不夹控制点
      曲线只多拱 0.5px，断言照样绿，等于没测。
      过冲要越过边界，得满足「谷底离基线不到 1/7 个绘图高、且左右邻居落差极大」，
      所以 `EXP_PLAN` 特意做成 [900, 2400, 120, 200, 1500, 600]：
        · 索引 1 是唯一峰值 2400 → 上沿的控制点算出来 9.2（上沿是 14）
        · 索引 2 是深谷 120，左邻 2400、右邻 200 → 下沿的控制点算出来 111（基线是 102）
      实测不夹控制点：曲线顶 13.7、底 104.8；夹住时 14.0 / 100.6。两条断言都红（阈值卡 13.9 / 101）。

      ⚠️ 为什么下沿要「凑」到这个程度：`addLedgerEntry` 拒收 amount = 0，
      谷底不可能真的贴到基线上，所以只能靠极端的邻居落差把控制点顶出去。
   ================================================================ */
console.log('\n\x1b[1m第 5b 组：近 6 个月趋势（曲线图）\x1b[0m');

// ⚠️ 这个数组是**故意**造成「深谷紧邻陡峰」的，别顺手改成平滑的数据
const EXP_PLAN = [900, 2400, 120, 200, 1500, 600];
const INC_PLAN = [500, 500, 800, 500, 500, 500];

// plan[0] = 5 个月前 …… plan[5] = 本月
const labelOf = (i) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - (5 - i));
  return `${d.getMonth() + 1}月`;
};

await page.evaluate(async ({ exp, inc }) => {
  await new Promise((res) => {
    const req = indexedDB.open('campus_week_calendar');
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['ledger'], 'readwrite');
      t.objectStore('ledger').clear();
      t.oncomplete = () => res('ok');
      t.onerror = () => res('err');
    };
    req.onerror = () => res('err');
  });
  const DB = (await import('./js/services/database_service.js')).default;
  const today = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - (5 - i), 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    await DB.addLedgerEntry({ amount: exp[i], direction: 'expense', category: 'meal', note: '餐饮', date: `${key}-05` });
    await DB.addLedgerEntry({ amount: inc[i], direction: 'income', category: 'allowance', note: '生活费', date: `${key}-06` });
  }
}, { exp: EXP_PLAN, inc: INC_PLAN });
await wait(500);

await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(1000);

const trend = await page.evaluate(() => {
  const card = document.querySelector('.led-trend-card');
  if (!card) return null;
  const q = (s) => card.querySelector(s);
  const line = q('.led-trend__line');
  const dot = q('.led-trend__dot');
  const drop = q('.led-trend__drop');
  const bb = line ? line.getBBox() : null;
  return {
    title: q('.led-trend__title')?.textContent.trim() || '',
    sub: q('.led-trend__sub')?.textContent.trim() || '',
    segItems: [...card.querySelectorAll('.led-trend__seg-item')].map((e) => e.textContent.trim()),
    segOn: q('.led-trend__seg-item--on')?.textContent.trim() || '',
    readout: q('.led-trend__readout')?.textContent.trim() || '',
    axis: [...card.querySelectorAll('.led-trend__axis span')].map((e) => e.textContent.trim()),
    gridCount: card.querySelectorAll('.led-trend__grid').length,
    // 网格线的 y（参考图的特征是「**顶线正好压在峰值上**」）
    gridYs: [...card.querySelectorAll('.led-trend__grid')]
      .map((e) => Number(e.getAttribute('y1'))).sort((a, b) => a - b),
    hasArea: !!q('path[fill^="url("]'),
    d: line?.getAttribute('d') || '',
    curveCount: (line?.getAttribute('d') || '').split('C').length - 1,
    // 曲线的实际包围盒（viewBox 是 0 0 320 112，绘图区 y ∈ [14, 102]）
    bbY: bb ? Number(bb.y.toFixed(1)) : null,
    bbBottom: bb ? Number((bb.y + bb.height).toFixed(1)) : null,
    hasDot: !!dot,
    dotY: dot ? Number(dot.getAttribute('cy')) : null,
    dotStroke: dot ? getComputedStyle(dot).stroke : '',
    hasDrop: !!drop,
    dropDash: drop ? getComputedStyle(drop).strokeDasharray : '',
    lineStroke: line ? getComputedStyle(line).stroke : '',
  };
});

ok('趋势卡渲染出来了', trend !== null);
if (trend) {
  check('标题是「近 6 个月」', trend.title, '近 6 个月');
  check('副标题跟着方向走', trend.sub, '按月查看支出变化');
  check('右上角是支出 / 收入两个选项', trend.segItems.join('|'), '支出|收入');
  check('默认选中「支出」', trend.segOn, '支出');

  // 🔴 峰值那个月 + 那个金额（真值：2400 落在 4 个月前）
  check('读数显示峰值那个月', trend.readout, `${labelOf(1)} · 支出 ¥2,400.00`);
  check('两端轴标签是最早 / 最近的月份', trend.axis.join('|'), `${labelOf(0)}|${labelOf(5)}`);
  // 参考图是 3 条：顶线压在峰值上、中线、基线（[0, 1/2, 1]）
  check('画了 3 条横向网格线（跟参考图一致）', trend.gridCount, 3);
  // 参考图最显眼的特征：**顶线正好穿过峰值那个圆环**，中线在正中间
  ok('🔴 顶线压在峰值上（= max 的高度，跟参考图一致）',
    trend.dotY !== null && Math.abs(trend.gridYs[0] - trend.dotY) <= 0.6,
    `顶线 y=${trend.gridYs[0]} / 峰值 y=${trend.dotY}`);
  ok('中线在绘图区正中（[0, 1/2, 1] 而不是四等分）',
    Math.abs(trend.gridYs[1] - 58) <= 0.6, `中线 y=${trend.gridYs[1]} / 期望 58`);
  ok('曲线下有渐变填充', trend.hasArea);

  // 「是曲线不是折线」：6 个点之间用 5 段三次贝塞尔连起来
  check('曲线由 5 段三次贝塞尔组成（不是折线）', trend.curveCount, 5);

  // 🔴 上沿：峰值那格的 y 应当**正好**是 padT = 14。它的控制点按公式是 9.2，
  //    不夹的话曲线会拱到 13.7（实测）。阈值卡 13.9 —— 夹住时正好 14.0。
  //    ⚠️ 别把阈值放宽到 13.5，那样不夹也过得去，这条就白写了。
  ok('🔴 曲线没有冲出绘图区上沿（控制点被夹住了）', trend.bbY >= 13.9,
    `曲线顶 ${trend.bbY} / 绘图区顶 14`);
  ok('峰值顶到绘图区上沿（y 映射正确）', trend.bbY <= 16, `曲线顶 ${trend.bbY}`);
  // 🔴 下沿：深谷那格 y = 97.6，它的控制点是 111（越过基线 102），
  //    不夹的话曲线会鼓到 104.8（实测）。夹住时 100.6。
  ok('🔴 曲线没有钻到基线下面（不是「负支出」）', trend.bbBottom <= 101,
    `曲线底 ${trend.bbBottom} / 基线 102`);

  ok('峰值那个点套了空心圆环', trend.hasDot);
  ok('圆环是主色描边', /rgb\(37, 99, 235\)|#2563eb/i.test(trend.dotStroke), trend.dotStroke);
  ok('有一条虚线垂到基线', trend.hasDrop && /3/.test(trend.dropDash), trend.dropDash);
  // 曲线用主色、不用红绿（跟流水金额同一套规矩）
  ok('曲线是主色（不是红/绿）', /rgb\(37, 99, 235\)|#2563eb/i.test(trend.lineStroke), trend.lineStroke);
}

// 切到收入
await page.click('.led-trend__seg-item[data-dir="income"]');
await wait(500);
const incView = await page.evaluate(() => {
  const card = document.querySelector('.led-trend-card');
  const line = card.querySelector('.led-trend__line');
  const bb = line.getBBox();
  return {
    sub: card.querySelector('.led-trend__sub')?.textContent.trim() || '',
    segOn: card.querySelector('.led-trend__seg-item--on')?.textContent.trim() || '',
    readout: card.querySelector('.led-trend__readout')?.textContent.trim() || '',
    bbY: Number(bb.y.toFixed(1)),
    bbBottom: Number((bb.y + bb.height).toFixed(1)),
  };
});
check('切到收入后胶囊高亮换过去', incView.segOn, '收入');
check('副标题跟着变', incView.sub, '按月查看收入变化');
// 真值：收入峰值 800 落在 3 个月前
check('读数换成收入峰值那个月', incView.readout, `${labelOf(2)} · 收入 ¥800.00`);
ok('收入曲线也没越界', incView.bbY >= 13.5 && incView.bbBottom <= 102.5,
  `曲线 ${incView.bbY}–${incView.bbBottom}`);

// 切回支出，确认不是「切一次就锁死」
await page.click('.led-trend__seg-item[data-dir="expense"]');
await wait(500);
check('能切回支出', await page.$eval('.led-trend__seg-item--on', (el) => el.textContent.trim()), '支出');

/* ---- 边界：某一方向**六个月全是 0** ----------------------------------
   真实场景：只记过收入（生活费）、从没记过支出的用户点开「支出」。
   这条以前没覆盖 —— 上面那组数据两个方向都有值，永远走不到 allZero 分支。
   期望：曲线平躺在基线上；**不画**圆环和垂线（否则会有一个孤零零的环贴在右下角，
   看起来像「这个月有支出」）；读数仍然是「最近那个月 · 支出 ¥0.00」。 */
await page.evaluate(async () => {
  await new Promise((res) => {
    const req = indexedDB.open('campus_week_calendar');
    req.onsuccess = () => {
      const db = req.result;
      const t = db.transaction(['ledger'], 'readwrite');
      t.objectStore('ledger').clear();
      t.oncomplete = () => res('ok');
      t.onerror = () => res('err');
    };
    req.onerror = () => res('err');
  });
  const DB = (await import('./js/services/database_service.js')).default;
  const today = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() - (5 - i), 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // 只记收入 —— 支出侧六个月全是 0。金额取非零，确保是「真没支出」而不是「空库」。
    await DB.addLedgerEntry({
      amount: 1000 + i, direction: 'income', category: 'allowance',
      note: '生活费', date: `${key}-06`,
    });
  }
});
await wait(500);
await page.reload({ waitUntil: 'networkidle2' });
await wait(900);
await clickText('记录'); await wait(700);
await clickText('记账', '.segmented__item'); await wait(1000);

const zeroView = await page.evaluate(() => {
  const card = document.querySelector('.led-trend-card');
  if (!card) return null;
  const line = card.querySelector('.led-trend__line');
  const bb = line.getBBox();
  return {
    readout: card.querySelector('.led-trend__readout')?.textContent.trim() || '',
    bbY: Number(bb.y.toFixed(1)),
    bbH: Number(bb.height.toFixed(1)),
    hasDot: !!card.querySelector('.led-trend__dot'),
    hasDrop: !!card.querySelector('.led-trend__drop'),
  };
});
ok('六个月支出全为 0 时趋势卡照样渲染（有流水就不该整块消失）', zeroView !== null);
if (zeroView) {
  // 平线并列时峰值取**最近**那个月（`>=` 的作用），所以读数落在 labelOf(5)
  check('全 0 时读数落在最近那个月', zeroView.readout, `${labelOf(5)} · 支出 ¥0.00`);
  ok('全 0 时曲线平躺在基线上', Math.abs(zeroView.bbY - 102) <= 0.5 && zeroView.bbH <= 0.5,
    `曲线顶 ${zeroView.bbY} / 高 ${zeroView.bbH}（基线 102）`);
  check('全 0 时不画那个孤零零的圆环', zeroView.hasDot, false);
  check('全 0 时不画零长度的垂线', zeroView.hasDrop, false);
}

/* ================================================================
   第 6 组：控制台
   ================================================================ */
console.log('\n\x1b[1m第 6 组：控制台\x1b[0m');
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
