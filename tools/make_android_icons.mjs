// make_android_icons.mjs —— 用 web/icons/icon-512.png 生成安卓启动器图标
//
// 为什么需要这个脚本：
//   Capacitor 脚手架自带的是**它自己的默认图标**（白底 + 蓝色电容符号 +
//   Android Studio 的网格占位纹），`cap add android` 时直接铺进去，
//   所以打出来的 APK 桌面图标和「周周记」毫无关系。
//   `cap sync` 不会覆盖它，必须自己生成一次。
//
// 生成三类：
//   ① mipmap-*/ic_launcher.png          —— 传统方形图标（Android 7.0/7.1 用）
//   ② mipmap-*/ic_launcher_round.png    —— 传统圆形图标（部分启动器会要）
//   ③ mipmap-*/ic_launcher_foreground.png —— 自适应图标前景层（Android 8.0+ 用）
//      自适应图标的画布是 108dp，其中**只有中间 72dp 保证可见**，
//      外面 18dp 会被启动器的遮罩裁掉。所以前景必须缩到 72/108 = 66.7% 居中，
//      画满 108dp 的话日历两侧会被圆形遮罩切掉。
//
// 为什么背景用渐变而不是纯色：
//   前景里的 logo 本身是「蓝色圆角方块」，四角透明。如果背景只铺一块**纯色**蓝，
//   logo 自身的对角渐变（左上浅、右下深）就会在圆角处露出一圈可辨的接缝。
//   所以背景改成一个**同方向的线性渐变**，颜色从图标上实测取样 ——
//   logo 的圆角就自然融进背景，任何遮罩形状下都看不出边界。
//
// 为什么借浏览器画：
//   项目零依赖，Node 没有内置 PNG 解码/编码器。puppeteer-core 已是既有依赖
//   （E2E 与 make_icons 都在用），借它的 canvas 解码 + 编码，不新增任何依赖。
//
// 用法：
//   node tools/make_android_icons.mjs          # 从 web/icons/icon-512.png 生成
//   node tools/make_android_icons.mjs 源图.png  # 指定源图（512x512 最佳）

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res');
const DEFAULT_SRC = join(ROOT, 'web', 'icons', 'icon-512.png');

/** 各密度下「传统图标边长」与「自适应图标画布边长」（108dp） */
const DENSITIES = [
  { dir: 'mipmap-mdpi',    legacy: 48,  adaptive: 108 },
  { dir: 'mipmap-hdpi',    legacy: 72,  adaptive: 162 },
  { dir: 'mipmap-xhdpi',   legacy: 96,  adaptive: 216 },
  { dir: 'mipmap-xxhdpi',  legacy: 144, adaptive: 324 },
  { dir: 'mipmap-xxxhdpi', legacy: 192, adaptive: 432 },
];

/**
 * 通知栏「大图标」的落点与边长。
 *
 * 与启动器图标分开的原因：
 *   · 落点是 `drawable-*` 而不是 `mipmap-*` ——
 *     LocalNotifications 插件用 `AssetUtil.getResourceID(context, name, "drawable")`
 *     解析图标名，**只认 drawable 表**，放 mipmap 里解析不到，
 *     会静默回退成系统默认图标（一个灰色信息小圆点）。
 *   · 边长按 64dp 出，这是通知大图标的惯用尺寸（比小图标大、比启动图标小）。
 */
const NOTIF_DIRS = [
  { dir: 'drawable-mdpi',    size: 64 },
  { dir: 'drawable-hdpi',    size: 96 },
  { dir: 'drawable-xhdpi',   size: 128 },
  { dir: 'drawable-xxhdpi',  size: 192 },
  { dir: 'drawable-xxxhdpi', size: 256 },
];

/** 自适应图标的安全区比例：72 / 108 */
const SAFE_RATIO = 72 / 108;

function findPuppeteer() {
  const candidates = [
    'C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
    join(ROOT, 'node_modules', 'puppeteer-core', 'lib', 'puppeteer', 'puppeteer-core.js'),
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 puppeteer-core（请先 npm install）');
  return hit;
}

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome / Edge');
  return hit;
}

const src = process.argv[2] ? join(ROOT, process.argv[2]) : DEFAULT_SRC;
if (!existsSync(src)) {
  console.error(`\n✗ 找不到源图：${src}\n  先跑 npm run icons 生成 web/icons/icon-512.png\n`);
  process.exit(1);
}

console.log('\n=== 生成安卓启动器图标 ===\n');
console.log(`源图：${src}`);

const puppeteer = (await import(pathToFileURL(findPuppeteer()).href)).default;
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();

const dataUrl = 'data:image/png;base64,' + readFileSync(src).toString('base64');

const jobs = [
  ...DENSITIES.flatMap((d) => ([
    { kind: 'legacy',     size: d.legacy,   path: join(RES, d.dir, 'ic_launcher.png') },
    { kind: 'round',      size: d.legacy,   path: join(RES, d.dir, 'ic_launcher_round.png') },
    { kind: 'foreground', size: d.adaptive, path: join(RES, d.dir, 'ic_launcher_foreground.png') },
  ])),
  // 通知栏大图标：方形、满幅、带圆角（源图自带 4% 留白与圆角，直接缩放即可）
  ...NOTIF_DIRS.map((d) => ({
    kind: 'notify', size: d.size, path: join(RES, d.dir, 'ic_notification_large.png'),
  })),
];

const out = await page.evaluate(async (srcUrl, jobList, safeRatio) => {
  const img = new Image();
  img.src = srcUrl;
  await img.decode();

  const W = img.naturalWidth, H = img.naturalHeight;

  // ---- 实测 logo 的对角渐变两端 ----
  // 取「圆角方块内部、但避开中央日历与右下钱包」的两簇点：
  //   左上簇 → 浅蓝端；右下簇 → 深蓝端
  // 坐标是按 3D 稿的构图定的（圆角方块占 4%~96%，日历占 28%~72%，
  // 钱包占 x 54%~86% / y 56%~78%，环绕带落在 k≈1 的椭圆上），
  // 所以这几个点一定落在纯蓝底上，不会采到图案。
  const probe = document.createElement('canvas');
  probe.width = W; probe.height = H;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  pctx.drawImage(img, 0, 0);
  const pd = pctx.getImageData(0, 0, W, H).data;

  const sample = (pts) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const [fx, fy] of pts) {
      const x = Math.round(W * fx), y = Math.round(H * fy);
      const i = (y * W + x) * 4;
      if (pd[i + 3] < 200) continue;
      r += pd[i]; g += pd[i + 1]; b += pd[i + 2]; n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  };
  const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

  const topBlue = toHex(sample([[0.22, 0.22], [0.30, 0.15], [0.15, 0.30]]) || [0x74, 0xb3, 0xfa]);
  const bottomBlue = toHex(sample([[0.90, 0.74], [0.70, 0.88], [0.86, 0.86]]) || [0x1c, 0x66, 0xe6]);

  const results = [];
  for (const job of jobList) {
    const size = job.size;
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');

    if (job.kind === 'legacy' || job.kind === 'notify') {
      // 传统方形图标 / 通知大图标：满幅绘制。
      // 源图自带 4% 内边距与圆角，直接缩放即可，不需要额外裁切或加边。
      ctx.drawImage(img, 0, 0, size, size);
    } else if (job.kind === 'round') {
      // 传统圆形图标：圆形裁切，稍微内缩一点免得边缘被啃
      const m = size * 0.03;
      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - m, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, 0, 0, size, size);
      ctx.restore();
    } else {
      // 自适应前景层：**把 logo 放大到溢出自适应画布**，让启动器的遮罩去裁它。
      //
      // 为什么不「缩到安全区中央 + 铺底色」：
      // 试过，logo 自身的边缘（柔和渐变 + 一圈浅色描边）和任何纯色/渐变背景
      // 都对不齐，圆角处必然留一圈能看见的接缝（已渲染预览确认过）。
      //
      // 溢出的做法从根上避开这个问题：整幅画布**始终落在 logo 不透明的蓝底内**，
      // 根本没有「两种蓝相接」的地方，任何遮罩形状下都不会有缝。
      // 放大系数 1.10 是算出来的：源图四周有 4% 透明留白，
      // 放大 10% 后留白被推到画布外（4% × 1.10 = 4.4% < 溢出量 5%），
      // 所以画布内不存在透明像素。
      const scale = 1.10;
      const inner = size * scale;
      const off = (size - inner) / 2;
      ctx.drawImage(img, off, off, inner, inner);
    }

    results.push({
      path: job.path,
      data: cv.toDataURL('image/png').split(',')[1],
    });
  }

  return { results, topBlue, bottomBlue, W, H };
}, dataUrl, jobs, SAFE_RATIO);

await browser.close();

for (const r of out.results) {
  mkdirSync(dirname(r.path), { recursive: true });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(r.path, buf);
  const rel = r.path.slice(RES.length + 1).replace(/\\/g, '/');
  console.log(`✓ ${rel.padEnd(46)} ${String(buf.length).padStart(6)} B`);
}

// ---- 自适应图标的背景层：与 logo 同方向的线性渐变 ----
// 前景虽然放大了 1.10 倍，但它的**圆角**仍落在画布内，那几处是透明的，
// 会露出这一层。所以背景不能是纯色 —— 纯色和 logo 自身的对角渐变对不上，
// 四个角会各差半个色阶，看起来像图标里套了个浅色方框（渲染预览确认过）。
//
// 铺满整幅画布的 315° 渐变（安卓里 315 = 左上→右下）正好和 logo 的渐变同向同跨度
// ——前景放大后其内容已经接近铺满画布，两者在四角处颜色一致，接缝就消失了。
//
// 用 <shape> 而不是 vector + aapt：这里只需要「起止两色、铺满整个 drawable」，
// <shape> 完全够用，还少一层 aapt 编译风险。
const bgDrawable = join(RES, 'drawable', 'ic_launcher_background.xml');
writeFileSync(bgDrawable,
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<!-- 由 tools/make_android_icons.mjs 生成，两端颜色取自 web/icons/icon-512.png 实测 -->\n'
  + '<shape xmlns:android="http://schemas.android.com/apk/res/android"\n'
  + '    android:shape="rectangle">\n'
  + '    <gradient\n'
  + '        android:type="linear"\n'
  + '        android:angle="315"\n'
  + `        android:startColor="${out.topBlue}"\n`
  + `        android:endColor="${out.bottomBlue}" />\n`
  + '</shape>\n');
console.log(`\n✓ drawable/ic_launcher_background.xml → ${out.topBlue} → ${out.bottomBlue}（315° 实测渐变）`);

// ---- 纯色兜底：个别工具/预览按名字找 @color 时用 ----
const mid = (() => {
  const a = out.topBlue.slice(1).match(/../g).map((h) => parseInt(h, 16));
  const b = out.bottomBlue.slice(1).match(/../g).map((h) => parseInt(h, 16));
  return '#' + a.map((v, i) => Math.round((v + b[i]) / 2).toString(16).padStart(2, '0')).join('').toUpperCase();
})();
writeFileSync(join(RES, 'values', 'ic_launcher_background.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<resources>\n'
  + `    <color name="ic_launcher_background">${mid}</color>\n`
  + '</resources>\n');
console.log(`✓ values/ic_launcher_background.xml  → ${mid}（渐变中点的纯色兜底）`);

// ---- 自适应图标描述文件：背景指向渐变 drawable ----
const adaptiveXml =
  '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
  + '    <background android:drawable="@drawable/ic_launcher_background"/>\n'
  + '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
  + '</adaptive-icon>\n';
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  writeFileSync(join(RES, 'mipmap-anydpi-v26', f), adaptiveXml);
}
console.log('✓ mipmap-anydpi-v26/ic_launcher{,_round}.xml → 渐变背景 + 放大前景');

// ---- 残留的 Capacitor 默认矢量前景：已被 mipmap 前景取代，删掉免得混淆 ----
const staleVector = join(RES, 'drawable-v24', 'ic_launcher_foreground.xml');
if (existsSync(staleVector)) {
  writeFileSync(staleVector,
    '<?xml version="1.0" encoding="utf-8"?>\n'
    + '<!-- Capacitor 默认前景已弃用：真正的图标由 tools/make_android_icons.mjs 生成到\n'
    + '     mipmap-*/ic_launcher_foreground.png，mipmap-anydpi-v26/ic_launcher.xml 引用的是后者。\n'
    + '     这里保留一个透明占位，避免别处 @drawable/ic_launcher_foreground 引用时报错。 -->\n'
    + '<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
    + '    android:width="108dp" android:height="108dp"\n'
    + '    android:viewportWidth="108" android:viewportHeight="108" />\n');
  console.log('✓ drawable-v24/ic_launcher_foreground.xml → 透明占位（替换 Capacitor 默认图形）');
}

console.log('\n图标已写入 android/app/src/main/res/mipmap-*/ 与 drawable-*/ic_notification_large.png\n');
