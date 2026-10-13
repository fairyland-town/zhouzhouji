/**
 * mask_preview.mjs —— 模拟 Android 各种遮罩形状，检查 maskable 图标是否露馅。
 *
 * 为什么需要它：maskable 图标在普通方形缩略图里看着正常，
 * 但系统会裁成圆形 / 水滴形 / 方形。四角透明、白边、内容越界这些问题
 * 只有套上真实遮罩才看得出来。
 *
 * 用法：node tools/mask_preview.mjs
 * 产出：tools/_mask_preview.png
 */
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const PUPPETEER_CANDIDATES = [
  process.env.PUPPETEER_PATH,
  'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
].filter(Boolean);

const puppeteerPath = PUPPETEER_CANDIDATES.find((p) => existsSync(p));
if (!puppeteerPath) {
  console.error('未找到 puppeteer-core');
  process.exit(1);
}
const puppeteer = (await import(pathToFileURL(puppeteerPath).href)).default;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p));

const ROOT = 'D:/desktop/周历记';
const dataUrl = (f) =>
  'data:image/png;base64,' + readFileSync(join(ROOT, 'web/icons', f)).toString('base64');

const masks = [
  ['circle', '圆形', '50%'],
  ['squircle', '超椭圆', '30%'],
  ['rounded', '圆角方', '18%'],
  ['none', '方形（不裁）', '0'],
];

const html = `<!doctype html><html><body style="margin:0;background:#f2f5fa;font:12px/1.4 system-ui;padding:20px">
<div style="display:flex;gap:26px;align-items:flex-start">
${masks
  .map(
    ([, label, r]) => `
  <div style="text-align:center">
    <div style="font-weight:600;margin-bottom:8px">${label}</div>
    <div style="width:180px;height:180px;overflow:hidden;border-radius:${r};
                box-shadow:0 4px 14px rgba(20,50,120,.18)">
      <img src="${dataUrl('icon-maskable-512.png')}" style="width:100%;height:100%;display:block">
    </div>
    <div style="font-weight:600;margin:22px 0 8px">普通版 512</div>
    <div style="width:110px;height:110px;overflow:hidden;border-radius:${r};margin:0 auto;
                box-shadow:0 4px 14px rgba(20,50,120,.18)">
      <img src="${dataUrl('icon-512.png')}" style="width:100%;height:100%;display:block">
    </div>
  </div>`
  )
  .join('')}
</div>
</body></html>`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 460, deviceScaleFactor: 1.6 });
await page.setContent(html, { waitUntil: 'load' });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: join(ROOT, 'tools', '_mask_preview.png') });
await browser.close();
console.log('ok -> tools/_mask_preview.png');
