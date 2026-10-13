/**
 * build_pwa.mjs —— PWA 打包检查 / 同步工具
 *
 * 做三件事：
 *   ① 扫描 web/ 下所有静态资源，把 sw.js 里的 PRECACHE 列表同步为最新
 *   ② 把 sw.js 的 VERSION 同步为 package.json 的版本号（改资源忘改版本 = 老用户吃旧缓存）
 *   ③ 校验 manifest / 图标 / SW 是否齐全，并给出「发布到手机」的操作指引
 *
 * 用法：node tools/build_pwa.mjs          # 同步 + 校验
 *       node tools/build_pwa.mjs --check  # 只校验，不改文件（CI 用）
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const SW_PATH = join(WEB, 'sw.js');
const MANIFEST_PATH = join(WEB, 'manifest.webmanifest');
const PKG_PATH = join(ROOT, 'package.json');

const CHECK_ONLY = process.argv.includes('--check');

let problems = 0;
const warn = (msg) => { problems++; console.error(`  \x1b[31m✗\x1b[0m ${msg}`); };
const good = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);

/* ---------------- ⓪ 版本号：只在 package.json 里写一次 ----------------
 *
 * 版本号由本脚本分发到各处，**别的地方一律不准手写**：
 *   · web/js/version.js —— 应用内显示（设置 → 关于）
 *   · web/sw.js         —— 缓存键
 *   · android versionName / versionCode —— gradle 直接读 package.json
 *
 * 🔴 为什么非要这么做：设置页原来把版本号**硬编码**在 settings_screen.js 里，
 *    结果 package.json 已经到 1.13.1 了，设置页还显示 v1.12.0。
 *    而用户判断「这次更新到底装上了没有」看的正是这一行 —— 它在撒谎。
 *    这类「两处各写一份、迟早对不上」的字段，必须收敛成单一来源。
 */

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
const version = `v${pkg.version}`;
const VERSION_JS = join(WEB, 'js', 'version.js');
const versionJsBody = `/**
 * version.js —— 应用版本号
 *
 * 🔴 **自动生成，不要手改**（由 tools/build_pwa.mjs 从 package.json 写入）。
 *    手改会在下次 npm run pwa 时被覆盖；而且一旦与 package.json 不一致，
 *    设置页「关于」里显示的版本就会骗人。
 */
export const APP_VERSION = '${pkg.version}';
export const APP_VERSION_TAG = '${version}';
`;

const versionJsChanged = !existsSync(VERSION_JS)
  || readFileSync(VERSION_JS, 'utf8') !== versionJsBody;

if (CHECK_ONLY) {
  if (versionJsChanged) warn(`web/js/version.js 与 package.json 不一致（应为 ${version}），请运行 node tools/build_pwa.mjs`);
  else good(`web/js/version.js 与 package.json 一致（${version}）`);
} else if (versionJsChanged) {
  writeFileSync(VERSION_JS, versionJsBody);
  good(`web/js/version.js 已同步为 ${version}`);
}

/* ---------------- ① 收集静态资源 ---------------- */

const EXT_OK = new Set(['.js', '.css']);

/**
 * 🔴 **不预缓存**的文件（放在 `web/` 里但用户用不到的东西）。
 *
 * 扫盘是按扩展名收的（`.js` / `.css` / `.html` / `.webmanifest` / `.png`），
 * 所以任何扔进 `web/` 的开发用页面都会被悄悄收进离线缓存。
 * 以前靠「跑完 `npm run pwa` 自己扫一眼 PRECACHE」来兜，容易漏 —— 现在写成代码。
 *
 * ⚠️ 排在这里**不代表访问不了**：SW 的静态分支是「缓存优先 + 后台更新」，
 *    没预缓存就退回网络，并且首次访问后照样会被缓存。只是不主动下载。
 */
const NO_PRECACHE = new Set([
  'sw.js',              // 由浏览器自己管理
  'logo-preview.html',  // 品牌资产预览页，开发时看的
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const assets = walk(WEB)
  .map((f) => relative(WEB, f).replace(/\\/g, '/'))
  .filter((f) => EXT_OK.has(extname(f)) || extname(f) === '.html' || extname(f) === '.webmanifest' || extname(f) === '.png')
  .filter((f) => !NO_PRECACHE.has(f))
  .sort();

/** 需要预缓存的资源：全部静态资源 + 根路径 */
const desired = ['./', ...assets.map((a) => `./${a}`)];

/* ---------------- ② 同步 sw.js ---------------- */

let sw = readFileSync(SW_PATH, 'utf8');

const versionRe = /const VERSION = '[^']*';/;
const listRe = /const PRECACHE = \[[\s\S]*?\n\];/;

if (!versionRe.test(sw)) { console.error('sw.js 里找不到 VERSION 常量'); process.exit(1); }
if (!listRe.test(sw)) { console.error('sw.js 里找不到 PRECACHE 列表'); process.exit(1); }

const newVersionLine = `const VERSION = '${version}';`;
const newList = 'const PRECACHE = [\n' + desired.map((d) => `  '${d}',`).join('\n') + '\n];';

const oldVersionLine = sw.match(versionRe)[0];
const oldList = sw.match(listRe)[0];

const versionChanged = oldVersionLine !== newVersionLine;
const listChanged = oldList !== newList;

if (CHECK_ONLY) {
  if (versionChanged) warn(`sw.js VERSION 与 package.json 不一致：${oldVersionLine} → 应为 ${newVersionLine}`);
  else good(`sw.js VERSION 与 package.json 一致（${version}）`);
  if (listChanged) warn('sw.js PRECACHE 列表与 web/ 实际资源不一致，请运行 node tools/build_pwa.mjs');
  else good(`sw.js PRECACHE 覆盖全部 ${assets.length} 个静态资源`);
} else {
  sw = sw.replace(versionRe, newVersionLine).replace(listRe, newList);
  writeFileSync(SW_PATH, sw);
  if (versionChanged) good(`sw.js VERSION 已同步为 ${version}`);
  else good(`sw.js VERSION 已是 ${version}`);
  if (listChanged) good(`sw.js PRECACHE 已同步（${desired.length} 项）`);
  else good(`sw.js PRECACHE 无需变更（${desired.length} 项）`);
}

/* ---------------- ③ 校验 PWA 完整性 ---------------- */

console.log('\nPWA 完整性校验：');

// manifest
if (!existsSync(MANIFEST_PATH)) warn('缺少 web/manifest.webmanifest');
else {
  let mf = null;
  try { mf = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch (e) { warn(`manifest 不是合法 JSON：${e.message}`); }
  if (mf) {
    const need = ['name', 'short_name', 'start_url', 'display', 'icons'];
    const miss = need.filter((k) => !mf[k]);
    if (miss.length) warn(`manifest 缺少字段：${miss.join(', ')}`);
    else good('manifest 字段完整');
    if (mf.display !== 'standalone' && mf.display !== 'fullscreen') warn(`manifest display 是 "${mf.display}"，安卓安装后不会有独立窗口`);
    else good(`manifest display = ${mf.display}（安装后有独立图标）`);
    const sizes = (mf.icons || []).map((i) => i.sizes);
    if (!sizes.includes('192x192') || !sizes.includes('512x512')) warn('manifest 缺少 192x192 或 512x512 图标（Chrome 安装条件）');
    else good('manifest 含 192 / 512 图标');
    if (!(mf.icons || []).some((i) => (i.purpose || '').includes('maskable'))) warn('manifest 缺少 maskable 图标（安卓圆形图标会被裁）');
    else good('manifest 含 maskable 图标');
  }
}

// 图标文件实际存在
// 大尺寸用设计稿的 3D 版，小尺寸（favicon）用扁平矢量版，两套都要在
const ICONS = [
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'favicon-48.png', 'favicon-32.png', 'favicon-16.png',
];
const missIcons = ICONS.filter((f) => !existsSync(join(WEB, 'icons', f)));
if (missIcons.length) warn(`缺少图标文件：${missIcons.join(', ')}（运行 node tools/make_icons.mjs 生成）`);
else good(`${ICONS.length} 个图标文件齐全`);

// index.html 引用
const html = readFileSync(join(WEB, 'index.html'), 'utf8');
if (!html.includes('rel="manifest"')) warn('index.html 没有引用 manifest');
else good('index.html 已引用 manifest');
if (!html.includes('serviceWorker.register')) warn('index.html 没有注册 Service Worker');
else good('index.html 已注册 Service Worker');
if (!html.includes('apple-touch-icon')) warn('index.html 缺少 apple-touch-icon（iOS 加到主屏会没图标）');
else good('index.html 含 apple-touch-icon');

// sw.js 结构
if (!sw.includes("self.addEventListener('install'")) warn('sw.js 缺少 install 事件');
else good('sw.js 有 install（预缓存）');
if (!sw.includes("self.addEventListener('fetch'")) warn('sw.js 缺少 fetch 事件');
else good('sw.js 有 fetch（离线响应）');

/* ---------------- 汇总 ---------------- */

console.log('\n' + '='.repeat(58));
if (problems === 0) {
  console.log('\x1b[32mPWA 就绪：可以安装到安卓手机了\x1b[0m');
} else {
  console.log(`\x1b[33m发现 ${problems} 处待处理项\x1b[0m`);
}
console.log('='.repeat(58));

console.log(`
下一步 —— 装到安卓手机上
------------------------------------------------------------
① 电脑上启动服务（已含局域网访问）：
     npm run serve
   终端会打印形如 http://192.168.x.x:8080 的地址。

② 手机与电脑连同一个 Wi-Fi，用 Chrome 打开上面那个地址。

③ Chrome 菜单（右上角 ⋮）→「添加到主屏幕」/「安装应用」。
   装好后桌面会出现「周周记」的蓝色日历图标，打开即全屏，无浏览器地址栏。

④ 首次打开后断网再试一次 —— 能正常打开就说明离线缓存生效了。
------------------------------------------------------------`);
process.exit(problems === 0 ? 0 : 1);
