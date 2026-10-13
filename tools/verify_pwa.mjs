// verify_pwa.mjs —— 验证 PWA：SW 注册、预缓存落盘、离线可用、manifest 可读
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
  .find((p) => existsSync(p));
const puppeteer = (await import(pathToFileURL(P).href)).default;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? `  （${detail}）` : ''}`); }
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=430,900'],
  defaultViewport: { width: 430, height: 860 },
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// ---- 1. 首次加载 & SW 注册 ----
await page.goto('http://localhost:8080/', { waitUntil: 'networkidle2' });
await sleep(2500);

console.log('\n1. Service Worker 注册');
const swState = await page.evaluate(async () => {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { supported: true, registered: false };
  return {
    supported: true,
    registered: true,
    scope: reg.scope,
    active: !!reg.active,
    state: reg.active ? reg.active.state : (reg.installing ? reg.installing.state : 'none'),
  };
});
ok('浏览器支持 Service Worker', swState.supported);
ok('Service Worker 已注册', swState.registered, JSON.stringify(swState));
ok('Service Worker 已激活', swState.active, `state=${swState.state}`);
ok('作用域为站点根', (swState.scope || '').endsWith('/'), swState.scope);

// ---- 2. 预缓存内容 ----
console.log('\n2. 预缓存（离线可用性）');
await sleep(1500);
const cacheInfo = await page.evaluate(async () => {
  const keys = await caches.keys();
  if (!keys.length) return { keys, count: 0, sample: [] };
  const cache = await caches.open(keys[0]);
  const reqs = await cache.keys();
  return {
    keys,
    count: reqs.length,
    sample: reqs.map((r) => new URL(r.url).pathname).slice(0, 8),
    hasIndex: reqs.some((r) => r.url.endsWith('/index.html') || r.url.endsWith('/')),
    hasCss: reqs.some((r) => r.url.endsWith('/css/style.css')),
    hasMain: reqs.some((r) => r.url.endsWith('/js/main.js')),
    hasGuide: reqs.some((r) => r.url.endsWith('/guide_screen.js')),
    hasAccount: reqs.some((r) => r.url.endsWith('/account_view.js')),
    // 🔴 开发用页面不该被预缓存（见 build_pwa.mjs 的 NO_PRECACHE）
    hasDevPage: reqs.some((r) => r.url.endsWith('/logo-preview.html')),
    htmlEntries: reqs.map((r) => new URL(r.url).pathname).filter((p) => p.endsWith('.html')),
  };
});
ok('已创建缓存空间', cacheInfo.keys.length > 0, cacheInfo.keys.join(','));
ok('预缓存条目数 >= 40', cacheInfo.count >= 40, `实际 ${cacheInfo.count}`);
ok('缓存了 index.html', cacheInfo.hasIndex);
ok('缓存了 style.css', cacheInfo.hasCss);
ok('缓存了 main.js', cacheInfo.hasMain);
ok('缓存了使用说明页', cacheInfo.hasGuide);
ok('缓存了账户视图', cacheInfo.hasAccount);
// 🔴 扫盘是按扩展名收的，任何扔进 web/ 的 .html 都会被悄悄收进离线缓存。
//    build_pwa.mjs 的 NO_PRECACHE 把它写成代码；这两条钉住「别退化成手工检查」。
ok('🔴 开发用页面没被预缓存（logo-preview.html）', !cacheInfo.hasDevPage);
ok('🔴 预缓存里的 .html 只有 index.html 一个',
  cacheInfo.htmlEntries.length === 1 && cacheInfo.htmlEntries[0] === '/index.html',
  `实际 ${cacheInfo.htmlEntries.join(', ') || '（无）'}`);

// ---- 3. manifest 可被浏览器解析 ----
console.log('\n3. Manifest');
const mf = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return null;
  const res = await fetch(link.href);
  return res.ok ? await res.json() : { error: res.status };
});
ok('页面引用了 manifest', mf !== null);
ok('manifest 能正确获取并解析', mf && !mf.error, mf && mf.error);
ok('名称正确', mf && mf.short_name === '周周记', mf && mf.short_name);
ok('display 为 standalone', mf && mf.display === 'standalone', mf && mf.display);
ok('含 512 图标', mf && (mf.icons || []).some((i) => i.sizes === '512x512'));

// ---- 4. 离线可用 ----
console.log('\n4. 离线可用（断网后重载）');
await page.setOfflineMode(true);
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(2000);
const offlineOk = await page.evaluate(() => {
  const slot = document.getElementById('screen-slot');
  return {
    hasShell: !!document.getElementById('app'),
    hasContent: !!slot && slot.children.length > 0,
    title: document.title,
    hasBody: !!document.querySelector('.app-header, .screen, .bottom-nav'),
  };
});
ok('离线时页面外壳存在', offlineOk.hasShell);
ok('离线时应用渲染出内容', offlineOk.hasBody, JSON.stringify(offlineOk));
ok('离线时标题正常', offlineOk.title.includes('周周记'), offlineOk.title);

// ---- 5. 离线时导航到说明页 ----
const offlineNav = await page.evaluate(async () => {
  const slot = document.getElementById('screen-slot');
  return !!slot && slot.children.length > 0;
});
ok('离线状态下界面可用', offlineNav);

await page.setOfflineMode(false);
await page.screenshot({ path: 'tools/shot_pwa_offline.png' });

ok('无未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

/* ================================================================
   5. 版本号单一来源：设置 → 关于 必须与 package.json 一致
   ----------------------------------------------------------------
   这里曾经是个真 bug：设置页把版本号**硬编码**成 v1.12.0，
   而 package.json 已经到 1.13.1 —— 偏偏用户判断「这次更新装上了没有」
   看的就是这一行，它在撒谎。
   现在版本号由 tools/build_pwa.mjs 从 package.json 生成到 js/version.js，
   这条断言钉住「生成的那份真的被页面用上了」。
   ================================================================ */
console.log('\n5. 版本号与 package.json 一致');

const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

await page.setOfflineMode(false);
await page.goto('http://localhost:8080/', { waitUntil: 'networkidle2' });
await sleep(800);
await page.click('.icon-btn');           // 右上角进设置
await sleep(800);

const shownVersion = await page
  .$eval('[data-field="app-version"]', (el) => el.textContent.trim())
  .catch(() => '(缺)');

ok('设置页显示的版本与 package.json 一致',
  shownVersion === `版本 v${pkgVersion}`,
  `页面「${shownVersion}」/ package.json「v${pkgVersion}」`);

// 顺带钉住「设置页确实有一处显示版本」—— 否则上面那条会因为取不到元素而假失败
ok('设置页「关于」里有版本号一行', shownVersion !== '(缺)', shownVersion);

console.log('\n' + '='.repeat(52));
if (fail === 0) console.log(`\x1b[32mPWA 验证全部通过：${pass} 项\x1b[0m`);
else console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
console.log('='.repeat(52));

await browser.close();
process.exit(fail === 0 ? 0 : 1);
