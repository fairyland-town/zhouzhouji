/**
 * zoom_icons.mjs —— 把 web/icons/ 下的图标并排放大渲染，用于肉眼检查抗锯齿与细节。
 *
 * 为什么需要它：小尺寸 PNG（16/32/48）之间的差异在人眼正常尺寸下看不出来，
 * Read 工具又会把视觉上相似的图判成「未变化」而不返回内容。放大 + 像素化渲染
 * 能把抗锯齿边缘、描边粗细、构图取舍暴露出来。
 *
 * 用法：node tools/zoom_icons.mjs
 * 产出：tools/_zoom_icons.png
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** ESM 不走 NODE_PATH，这里按需解析 puppeteer-core 的实际位置（与 tests/e2e_test.mjs 同一约定） */
const PUPPETEER_CANDIDATES = [
  process.env.PUPPETEER_PATH,
  'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
].filter(Boolean);

const puppeteerPath = PUPPETEER_CANDIDATES.find((p) => existsSync(p));
if (!puppeteerPath) {
  console.error('未找到 puppeteer-core，请先执行：');
  console.error('  cd C:/Users/27693/.workbuddy-ai/binaries/node/workspace && npm install puppeteer-core');
  process.exit(1);
}
const puppeteer = (await import(pathToFileURL(puppeteerPath).href)).default;

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.error('未找到 Chrome / Edge，无法渲染。');
  process.exit(1);
}

const ROOT = 'D:/desktop/周历记';

const items = [
  ['icon-512.png', '512'],
  ['icon-192.png', '192'],
  ['apple-touch-icon.png', '180'],
  ['favicon-48.png', '48'],
  ['favicon-32.png', '32'],
  ['favicon-16.png', '16'],
  ['icon-maskable-512.png', 'maskable'],
];

// 用 base64 内联：setContent 出来的页面没有 file:// 源，
// 直接引 file:// 图片会被跨源策略拦掉（表现为一堆破图）。
const dataUrl = (f) =>
  'data:image/png;base64,' + readFileSync(join(ROOT, 'web/icons', f)).toString('base64');

const html = `<!doctype html><html><body style="margin:0;background:#f2f5fa;font:12px/1.4 system-ui;display:flex;flex-wrap:wrap;gap:18px;padding:18px">
${items
  .map(
    ([f, label]) => `
  <div style="text-align:center">
    <div style="font-weight:600;margin-bottom:6px">${label}</div>
    <img src="${dataUrl(f)}"
         style="width:150px;height:150px;image-rendering:pixelated;border-radius:6px;
                background:repeating-conic-gradient(#e6e6e6 0 25%, #fff 0 50%) 50%/14px 14px">
  </div>`
  )
  .join('')}
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 560, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: join(ROOT, 'tools', '_zoom_icons.png') });
await browser.close();
console.log('ok -> tools/_zoom_icons.png');
