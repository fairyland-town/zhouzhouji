/**
 * verify_icons.mjs —— 校验 web/icons/ 下所有图标的「硬约束」
 *
 * 为什么需要它：图标是**重新生成一次就可能悄悄退化**的那类资产 ——
 * `npm run icons` 跑完永远打印一排 ✓，但下面这些错误它不会告诉你：
 *
 *   🔴 apple-touch-icon 带透明像素 —— iOS 会把透明**合成成黑色**，
 *      装到 iPhone 桌面上四个角就是四块黑。浏览器里完全看不出来。
 *   🔴 maskable 带透明像素 —— 安卓自适应图标会自己裁形状，
 *      透明的角会直接露出桌面壁纸。
 *   🔴 favicon-16 的笔画掉到亚像素 —— 缩到 16px 后勾只剩 0.36px，
 *      渲染出来是一团蓝白色的糊（v1.12.1 之前的真实状况）。
 *
 * 这些都不是「跑起来报错」的问题，只能靠断言钉住。
 *
 * 用法：node tools/verify_icons.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'web', 'icons');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
function group(t) { console.log('\n' + t); }

/* ============================================================
   PNG 解码（只支持 make_icons.mjs 产出的那种：8bit / RGBA / 非隔行）
   故意不支持调色板与灰度 —— 遇到就直接报错，别静默算错。
   ============================================================ */

function decodePNG(file) {
  const buf = readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG：' + file);
  let off = 8, W = 0, H = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      depth = data[8]; color = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || color !== 6 || interlace !== 0) {
    throw new Error(`${file} 不是 8bit/RGBA/非隔行（depth=${depth} color=${color} interlace=${interlace}）`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = W * bpp;
  const px = Buffer.alloc(W * H * bpp);

  // 逐行反滤波（PNG 规范里的 5 种 filter）
  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;          // 左
      const b = prev ? prev[x] : 0;                    // 上
      const c = prev && x >= bpp ? prev[x - bpp] : 0;  // 左上
      let v = src[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (ft !== 0) throw new Error(`${file} 未知 filter ${ft}`);
      cur[x] = v & 0xff;
    }
  }

  return {
    W, H, px,
    at(x, y) { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; },
  };
}

/** 是否「是蓝」：品牌蓝的色相，且明显不透明 */
const isBlue = (r, g, b, a) => a > 200 && b > 170 && b - r > 50;
/** 是否「是白」：接近纯白 */
const isWhite = (r, g, b, a) => a > 200 && r > 225 && g > 232 && b > 240;

/* ============================================================
   1. 文件齐全 + 尺寸正确
   ============================================================ */

group('1. 资产齐全与尺寸');

const EXPECTED = [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['favicon-48.png', 48],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
];

const images = {};
for (const [name, size] of EXPECTED) {
  const p = join(ICON_DIR, name);
  if (!existsSync(p)) { check(`${name} 存在`, false, '文件缺失'); continue; }
  const im = decodePNG(p);
  images[name] = im;
  check(`${name} 是 ${size}x${size}`, im.W === size && im.H === size, `实际 ${im.W}x${im.H}`);
}

/* ============================================================
   2. 不透明性（两个「会真的出问题」的地方）
   ============================================================ */

group('2. 不透明性');

function minAlpha(im) {
  let m = 255;
  for (let i = 3; i < im.px.length; i += 4) if (im.px[i] < m) m = im.px[i];
  return m;
}

{
  // 🔴 iOS：apple-touch-icon 的透明像素会被合成成黑色
  const im = images['apple-touch-icon.png'];
  if (im) {
    const a = minAlpha(im);
    check('apple-touch-icon 整幅不透明（否则 iOS 上四角变黑）', a === 255, `最小 alpha=${a}`);
    for (const [x, y] of [[0, 0], [179, 0], [0, 179], [179, 179]]) {
      check(`apple-touch-icon 角 (${x},${y}) 不透明`, im.at(x, y)[3] === 255, `alpha=${im.at(x, y)[3]}`);
    }
  }
}

{
  // 🔴 安卓自适应图标：系统自己裁形状，透明的角会露出壁纸
  const im = images['icon-maskable-512.png'];
  if (im) {
    const a = minAlpha(im);
    check('maskable 整幅不透明（否则安卓裁圆/水滴时露底）', a === 255, `最小 alpha=${a}`);
  }
}

{
  // PWA 的 purpose:"any" 允许透明圆角，但中间必须有实心内容
  for (const name of ['icon-192.png', 'icon-512.png']) {
    const im = images[name];
    if (!im) continue;
    const c = im.at(im.W >> 1, im.H >> 1);
    check(`${name} 中心有实心内容`, c[3] === 255, `中心 alpha=${c[3]}`);
    check(`${name} 四角透明（保留圆角造型）`, im.at(0, 0)[3] === 0, `(0,0) alpha=${im.at(0, 0)[3]}`);
  }
}

/* ============================================================
   3. 16/32px 的可辨认性
   ============================================================ */

group('3. 极小尺寸的可辨认性（16 / 32）');

for (const name of ['favicon-16.png', 'favicon-32.png']) {
  const im = images[name];
  if (!im) continue;
  const { W, H } = im;

  // 先框出「白纸」的范围：白纸是这个设计的载体，找不到就说明整个构图崩了
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = im.at(x, y);
      if (isWhite(r, g, b, a)) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { check(`${name} 能找到白纸区域`, false, '整张图没有白色像素'); continue; }
  const pw = maxX - minX + 1, ph = maxY - minY + 1;
  check(`${name} 白纸够大（占宽 ≥55%）`, pw >= W * 0.55, `${pw}/${W}`);
  check(`${name} 白纸够高（占高 ≥55%）`, ph >= H * 0.55, `${ph}/${H}`);

  // 表头「白缝」：卡片上沿必须看得见。
  //
  // 🔴 这一条守的是一个真实踩过的坑 —— 表头一旦和图标外圈的蓝底连成一片，
  // 「日历」这个线索就没了，只剩一块白卡片加一个勾。
  // 16px 下实测曾出现 y=0..4 整五行全蓝（表头贴着纸的上沿）。
  //
  // 注意别用「找一条长蓝带」来判表头：底色本身就是蓝的，任何蓝行都能通过，
  // 那种断言看着绿其实什么都没守住。要判的是「白缝 + 白缝之上是底色」。
  const topLimit = minY + Math.max(1, Math.round(ph * 0.5));
  /** 某一行里最长的连续白段 */
  const longestWhite = (y) => {
    let run = 0, best = 0;
    for (let x = minX; x <= maxX; x++) {
      const [r, g, b, a] = im.at(x, y);
      run = isWhite(r, g, b, a) ? run + 1 : 0;
      if (run > best) best = run;
    }
    return best;
  };
  /** 某一行里蓝像素的个数 */
  const blueCount = (y) => {
    let n = 0;
    for (let x = minX; x <= maxX; x++) {
      const [r, g, b, a] = im.at(x, y);
      if (isBlue(r, g, b, a)) n++;
    }
    return n;
  };

  let gapY = -1;
  for (let y = minY; y <= topLimit && y < H; y++) {
    if (longestWhite(y) >= pw * 0.55) { gapY = y; break; }
  }
  // 白缝的宽度随尺寸变（16px 只有 1 行，32px 有 2 行），
  // 所以要一路吃到「不再是白」为止，不能假定它只有一行。
  let gapEnd = gapY;
  while (gapEnd >= 0 && gapEnd + 1 <= maxY && longestWhite(gapEnd + 1) >= pw * 0.55) gapEnd++;

  check(`${name} 卡片上沿有白缝（表头没贴沿）`, gapY >= 0, `未找到贯穿纸宽的白色行`);
  if (gapY > minY) {
    check(`${name} 白缝之上是底色（上沿真的被描出来了）`,
      blueCount(gapY - 1) >= pw * 0.6, `蓝 ${blueCount(gapY - 1)}/${pw}`);
  }
  if (gapEnd >= 0 && gapEnd + 1 <= maxY) {
    check(`${name} 白缝之下是表头蓝带`,
      blueCount(gapEnd + 1) >= pw * 0.6, `蓝 ${blueCount(gapEnd + 1)}/${pw}`);
  }

  // 表头以下：白纸和蓝勾都要存在 —— 白纸被吞掉说明勾太大，没蓝说明勾没了
  const belowY = gapEnd >= 0 ? gapEnd + 2 : minY + Math.max(1, Math.round(ph * 0.45));
  let whiteBelow = 0, blueBelow = 0, totalBelow = 0;
  for (let y = belowY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const [r, g, b, a] = im.at(x, y);
      totalBelow++;
      if (isWhite(r, g, b, a)) whiteBelow++;
      if (isBlue(r, g, b, a)) blueBelow++;
    }
  }
  const wRatio = totalBelow ? whiteBelow / totalBelow : 0;
  const bRatio = totalBelow ? blueBelow / totalBelow : 0;
  check(`${name} 表头下仍留有白底（勾没吞掉纸，≥12%）`, wRatio >= 0.12, `白 ${(wRatio * 100).toFixed(1)}%`);
  check(`${name} 表头下有蓝色勾（≥8%）`, bRatio >= 0.08, `蓝 ${(bRatio * 100).toFixed(1)}%`);
}

/* ============================================================
   4. 引用一致性
   ============================================================ */

group('4. 引用一致性');

{
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  // 512 与 maskable 只从 manifest 走：浏览器装 PWA 时自己去 manifest 里挑，
  // 没必要在 <link> 里再声明一遍（声明了反而多一次无谓的下载）。
  const MANIFEST_ONLY = new Set(['icon-512.png', 'icon-maskable-512.png']);
  for (const [name] of EXPECTED) {
    if (MANIFEST_ONLY.has(name)) continue;
    check(`index.html 引用了 ${name}`, html.includes('icons/' + name), '未引用');
  }
  check('index.html 声明了 apple-touch-icon', /rel="apple-touch-icon"/.test(html));
  check('index.html 声明了 16x16 favicon', /sizes="16x16"/.test(html));
}

{
  const mf = JSON.parse(readFileSync(join(ROOT, 'web', 'manifest.webmanifest'), 'utf8'));
  const srcs = (mf.icons || []).map((i) => i.src);
  for (const [name] of EXPECTED) {
    if (!/^icon-/.test(name)) continue;
    check(`manifest 声明了 ${name}`, srcs.includes('icons/' + name), srcs.join(', '));
  }
  const maskable = (mf.icons || []).find((i) => i.purpose === 'maskable');
  check('manifest 有 maskable 图标', !!maskable);
  check('maskable 指向 icon-maskable-512.png',
    !!maskable && maskable.src === 'icons/icon-maskable-512.png',
    maskable ? maskable.src : '无');
  // 512 必须同时有 any 与 maskable 两个用途，缺 any 时部分平台会拿 maskable 硬当普通图标
  check('manifest 同时有 purpose:"any" 的 512',
    (mf.icons || []).some((i) => i.src === 'icons/icon-512.png' && i.purpose === 'any'));
}

/* ============================================================
   汇总
   ============================================================ */

console.log('\n' + '='.repeat(52));
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  console.log('\n失败清单：');
  failures.forEach((f) => console.log('  · ' + f));
}
console.log('='.repeat(52));
process.exit(fail === 0 ? 0 : 1);
