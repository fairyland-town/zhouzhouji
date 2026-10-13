/**
 * verify_nav_icon.mjs —— 验证 v1.10.0 底部导航「整块填充」的激活态
 *
 * 覆盖：
 *   ① 未选中时显示描边字形（--line 不透明、--fill 透明）
 *   ② 选中时显示实心字形（--fill 不透明、--line 透明），且填充色 = currentColor = 品牌蓝
 *   ③ 小圆点指示器已被移除（::after 不再产生可见内容）
 *   ④ 实心字形的实际墨迹覆盖率显著高于描边字形（证明"填满"而非"还是线"）
 *   ⑤ 切换 tab 时激活态跟随转移，同一时刻只有一个激活项
 *
 * 截图：shot_nav_week.png / shot_nav_record.png
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
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
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

console.log('\n=== v1.10.0 底部导航激活态验证 ===\n');

await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(700);

/** 读取某个 nav item 的双字形状态 */
const readItem = (key) => page.evaluate((k) => {
  const btn = document.querySelector(`.bottom-nav__item[data-route="${k}"]`);
  if (!btn) return null;
  const line = btn.querySelector('.bottom-nav__ico--line');
  const fill = btn.querySelector('.bottom-nav__ico--fill');
  const cs = getComputedStyle(btn);
  const after = getComputedStyle(btn, '::after');
  return {
    active: btn.classList.contains('bottom-nav__item--active'),
    lineOpacity: line ? Number(getComputedStyle(line).opacity) : -1,
    fillOpacity: fill ? Number(getComputedStyle(fill).opacity) : -1,
    color: cs.color,
    fontWeight: cs.fontWeight,
    hasFillSvg: !!fill && !!fill.querySelector('svg'),
    dotContent: after.content,
    dotDisplay: after.display,
    label: btn.querySelector('.bottom-nav__label')?.textContent.trim(),
  };
}, key);

/** 用 canvas 量字形墨迹覆盖率：直接渲染真实的 DOM 节点，避免重新解析 SVG 字符串 */
const measureInk = () => page.evaluate(async () => {
  const measure = async (svgEl) => {
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', '64');
    clone.setAttribute('height', '64');
    // 统一成「黑墨 + 透明底」：先记下原始 fill-rule 判定是不是实心字形，
    // 再把所有 currentColor / 白镂空规整掉。
    // ⚠️ 不要给根 svg 写 stroke="none" —— 描边字形正是靠根节点的
    //    stroke="currentColor" 继承下来的，抹掉就量成 0。
    const isFillShape = clone.getAttribute('fill-rule') === 'evenodd';
    const norm = (n) => {
      const f = n.getAttribute('fill');
      if (f === 'currentColor') n.setAttribute('fill', 'black');
      // 白色镂空在「量形状」时要保留（它本来就该是空的）
      if (f && f !== 'none' && f !== 'white' && f !== '#fff') n.setAttribute('fill', 'black');
      const s = n.getAttribute('stroke');
      if (s === 'currentColor') n.setAttribute('stroke', 'black');
      if (s === 'none') n.removeAttribute('stroke');
      return n;
    };
    norm(clone);
    clone.querySelectorAll('*').forEach(norm);
    if (isFillShape) clone.setAttribute('fill', 'black');
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
    await img.decode();
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let ink = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) ink++;
    return ink / (64 * 64);
  };

  const btn = document.querySelector('.bottom-nav__item[data-route="week"]');
  const lineSvg = btn.querySelector('.bottom-nav__ico--line svg');
  const fillSvg = btn.querySelector('.bottom-nav__ico--fill svg');

  // 再取记录页的两个字形（点开前先 clone 出来，避免切页后节点被替换）
  const recBtn = document.querySelector('.bottom-nav__item[data-route="record"]');
  const recLine = recBtn.querySelector('.bottom-nav__ico--line svg');
  const recFill = recBtn.querySelector('.bottom-nav__ico--fill svg');

  return {
    line: await measure(lineSvg),
    fill: await measure(fillSvg),
    lineRecord: await measure(recLine),
    fillRecord: await measure(recFill),
    fillHasHoles: fillSvg.querySelectorAll('[fill="#fff"],[fill="white"]').length,
  };
});

/* ---------- 1. 首屏（周历激活） ---------- */
console.log('1. 首屏：周历为激活项');
const w = await readItem('week');
check('周历项带 --active', w.active);
check('描边字形已隐藏（opacity 0）', w.lineOpacity === 0, `实际 ${w.lineOpacity}`);
check('实心字形已显示（opacity 1）', w.fillOpacity === 1, `实际 ${w.fillOpacity}`);
check('实心字形确实是 svg', w.hasFillSvg);
check('激活色是品牌蓝 rgb(37,99,235)', w.color === 'rgb(37, 99, 235)', `实际 ${w.color}`);
check('标签文字不变（周历）', w.label === '周历');
check('文字加粗', Number(w.fontWeight) >= 600, `实际 ${w.fontWeight}`);

const r1 = await readItem('record');
check('记录项未激活', !r1.active);
check('未激活项显示描边字形', r1.lineOpacity === 1 && r1.fillOpacity === 0,
  `line ${r1.lineOpacity} / fill ${r1.fillOpacity}`);
check('未激活项是灰色', r1.color !== 'rgb(37, 99, 235)', `实际 ${r1.color}`);

/* ---------- 2. 小圆点已移除 ---------- */
console.log('\n2. 旧的小圆点指示器');
check('::after 不再渲染内容', w.dotContent === 'none' || w.dotDisplay === 'none',
  `content=${w.dotContent} display=${w.dotDisplay}`);

/* ---------- 3. 墨迹覆盖率（证明"填满"） ---------- */
console.log('\n3. 字形墨迹覆盖率');
const ink = await measureInk();
const pct = (n) => (n * 100).toFixed(1) + '%';
console.log(`     描边日历 ${pct(ink.line)} → 实心日历 ${pct(ink.fill)}`);
console.log(`     描边记录 ${pct(ink.lineRecord)} → 实心记录 ${pct(ink.fillRecord)}`);
check('实心日历墨迹 ≈ 描边 × 1.6 以上', ink.fill > ink.line * 1.6,
  `${pct(ink.fill)} vs ${pct(ink.line)}`);
check('实心记录墨迹 ≈ 描边 × 1.6 以上', ink.fillRecord > ink.lineRecord * 1.6,
  `${pct(ink.fillRecord)} vs ${pct(ink.lineRecord)}`);
check('描边字形在 30–45%（确认量的是"线"不是"块"）',
  ink.line > 0.30 && ink.line < 0.45, pct(ink.line));
check('实心覆盖率 > 25%（视觉上是"实心块"）', ink.fill > 0.25, pct(ink.fill));
check('实心覆盖率 < 80%（仍有镂空，不是实心方块）', ink.fill < 0.8, pct(ink.fill));
check('实心日历含白色镂空（日期点 ×2）', ink.fillHasHoles === 2, `实际 ${ink.fillHasHoles}`);

await page.screenshot({ path: 'shot_nav_week.png', clip: { x: 0, y: 780, width: 430, height: 120 } });

/* ---------- 4. 切到记录页，激活态转移 ---------- */
console.log('\n4. 切换到记录页');
await page.evaluate(() => {
  const items = [...document.querySelectorAll('.bottom-nav__item')];
  const rec = items.find((b) => b.dataset.route === 'record');
  rec.click();
});
await sleep(700);

const w2 = await readItem('week');
const r2 = await readItem('record');
check('周历失去激活', !w2.active);
check('记录获得激活', r2.active);
check('记录显示实心字形', r2.fillOpacity === 1 && r2.lineOpacity === 0,
  `line ${r2.lineOpacity} / fill ${r2.fillOpacity}`);
check('周历回到描边字形', w2.lineOpacity === 1 && w2.fillOpacity === 0,
  `line ${w2.lineOpacity} / fill ${w2.fillOpacity}`);

const activeCount = await page.$$eval('.bottom-nav__item--active', (els) => els.length);
check('同一时刻只有一个激活项', activeCount === 1, `实际 ${activeCount}`);

const navCount = await page.$$eval('.bottom-nav__item', (els) => els.length);
check('导航仍是 2 项', navCount === 2, `实际 ${navCount}`);
const fabOk = await page.$('.bottom-nav__fab') !== null;
check('中间加号按钮仍在', fabOk);

await page.screenshot({ path: 'shot_nav_record.png', clip: { x: 0, y: 780, width: 430, height: 120 } });

/* ---------- 5. 无异常 ---------- */
console.log('\n5. 运行时异常');
check('无未捕获异常', errs.length === 0, errs.slice(0, 3).join(' | '));

await browser.close();

console.log('\n' + '='.repeat(52));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} 项 / 通过 ${pass} 项`);
console.log('='.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);
