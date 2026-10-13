// make_icons.mjs —— 生成 PWA 所需的全部 PNG 图标（不依赖任何第三方库）
//
// 生成策略是「混合」的（v1.8.0 起，v1.12.1 补齐两处缺陷）：
//   大尺寸（192 / 512）  → 用设计稿的 3D 黏土版 logo 裁切缩放，**保留透明圆角**
//   apple-touch-180     → 同一张 3D 稿，但**满幅不透明**（iOS 会把透明合成成黑色）
//   maskable-512        → 同一张 3D 稿，满幅不透明 + 14% 安全区（安卓会自己裁形状）
//   favicon 48          → 同构图的扁平矢量版，SDF 绘制
//   favicon 32 / 16     → 扁平矢量版的**极简版**（白纸 + 蓝表头 + 粗勾）
//
// 为什么小尺寸不用 3D 版：
//   3D 版靠柔和渐变、投影、高光传达质感，缩到 16px 后这些细节全部糊成一团蓝，
//   浏览器标签页上根本认不出是什么。扁平版把构图抽象成「日历 + 勾选格 + 钱包 + 环绕带」，
//   去掉所有质感层，只留形状与对比，小尺寸下反而清楚。
//
// 为什么 16/32 还要再删一轮：
//   扁平版等比缩到 16px，日期格只剩 2.5px、勾的笔画只剩 0.36px（亚像素），
//   渲染出来仍是一团糊。极简版只保留「白纸 + 蓝表头 + 粗勾」三个形状，
//   每根笔画都 ≥1.75px，缩到 16px 才认得出。用 tools/zoom_icons.mjs 放大可对比。
//
// 为什么大尺寸不重画：
//   3D 版的质感是矢量画不出来的（至少不引依赖画不出来），
//   有现成的 1254x1254 稿就直接用，效果最好。
//
// 用法：
//   node tools/make_icons.mjs                    # 自动找源图
//   node tools/make_icons.mjs path/to/logo.png   # 指定 3D 源图
//
// 源图要求：正方形、白底、图标居中。脚本会自动探测内容边界并裁掉白边。

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'web', 'icons');

/* ============================================================
   第一部分：PNG 编码
   ============================================================ */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 像素写成 PNG */
function encodePNG(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ============================================================
   第二部分：几何与抗锯齿（画扁平矢量小图标用）
   ============================================================ */

/** 点到圆角矩形的有符号距离（负值在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const rr = Math.min(r, hw, hh);
  const qx = Math.abs(px - cx) - (hw - rr);
  const qy = Math.abs(py - cy) - (hh - rr);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - rr;
}

/** 点到圆的有符号距离 */
function sdCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/**
 * 圆角矩形描边：内缩 strokeW/2 求距离再减 strokeW/2。
 * 不要用「大矩形减小矩形」—— 圆角处会产生月牙缺口。
 */
function sdRoundRectStroke(px, py, cx, cy, hw, hh, cornerR, strokeW) {
  const hw2 = hw - strokeW / 2;
  const hh2 = hh - strokeW / 2;
  if (hw2 <= 0 || hh2 <= 0) {
    return Math.abs(sdRoundRect(px, py, cx, cy, hw, hh, cornerR)) - strokeW / 2;
  }
  return Math.abs(sdRoundRect(px, py, cx, cy, hw2, hh2, Math.max(cornerR - strokeW / 2, 0))) - strokeW / 2;
}

/**
 * 胶囊（圆头线段）：用「两端点 + 半径」定义。
 * 不要用「长度算式相减」—— 很容易算出负长度、把胶囊缩成一个小凸起。
 */
function sdCapsule(px, py, x1, y1, x2, y2, r) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(Math.max((wx * vx + wy * vy) / len2, 0), 1);
  const dx = px - (x1 + t * vx), dy = py - (y1 + t * vy);
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** 椭圆环的有符号距离：|点到椭圆归一化距离 - 1| 再缩放回像素 */
function sdEllipseRing(px, py, cx, cy, a, b, halfW, rot) {
  const dx = px - cx, dy = py - cy;
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const rx = dx * ca + dy * sa;
  const ry = -dx * sa + dy * ca;
  const k = Math.sqrt((rx / a) ** 2 + (ry / b) ** 2);
  if (k === 0) return -halfW;
  // 近似：沿径向的像素距离
  const rad = Math.sqrt(rx * rx + ry * ry);
  const approx = Math.min(a, b);
  return (k - 1) * approx * (rad / Math.max(rad, 1e-6)) - halfW;
}

/** 距离 → 覆盖率 */
function coverage(d, aa = 1) {
  return Math.min(Math.max(0.5 - d / aa, 0), 1);
}

/** 把 src 按 alpha 混进 dst（就地修改） */
function blend(dst, src, a) {
  if (a <= 0) return;
  dst[0] += (src[0] - dst[0]) * a;
  dst[1] += (src[1] - dst[1]) * a;
  dst[2] += (src[2] - dst[2]) * a;
}

/* ============================================================
   第三部分：扁平矢量小图标（favicon）
   ============================================================ */

// 取色自 3D 版 logo，保证两套同源
const V_BG_TOP   = [0x74, 0xb3, 0xfa];   // 浅天蓝（左上）
const V_BG_BOT   = [0x1c, 0x66, 0xe6];   // 主蓝（右下）
const V_CAL      = [0xff, 0xff, 0xff];   // 日历白
const V_CAL_BAR  = [0xe6, 0xef, 0xfd];   // 日历表头条
const V_CELL     = [0xd2, 0xe4, 0xfb];   // 日期格
const V_CHECK    = [0x1c, 0x66, 0xe6];   // 勾选格底
const V_WALLET   = [0x33, 0x82, 0xf0];   // 钱包主体
const V_WALLET_B = [0x1a, 0x57, 0xcf];   // 钱包翻盖
const V_RING     = [0xc9, 0xdf, 0xfc];   // 环绕带

/**
 * 画扁平矢量小图标。
 *
 * 关键设计：**细节量随尺寸递减**。小图标不是「大图缩小」，而是「大图的删减版」。
 * 缩略图阶段人眼只能分辨 2~3 个形状，把所有元素等比例缩下去只会得到一团蓝。
 *
 *   size >= 96：完整构图（环绕带 + 日历 + 勾选格 + 钱包）
 *   size <  96：只留日历 + 勾选格，去掉环绕带与钱包
 *
 * 阈值定在 96 是实测出来的（试过 24 / 48 都不行）：
 * 「环绕带」是个大而浅的圆环，尺寸一小就变成一团灰饼，
 * 反而盖过日历这个主角。48px 下带上环的效果明显比不带更糊。
 * 小图标不是「能塞多少塞多少」，而是「塞进去还认得出」。
 *
 * @param {number} size 边长
 */
function drawFlatIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const R = size / 2;
  const cornerR = size * 0.225;
  const aa = Math.max(0.7, size / 110);

  // 细节开关
  const detailed = size >= 96;
  const tiny = size < 48;

  /* ---------- 极小尺寸（16 / 32）：换一套专门的构图 ---------- *
   *
   * 🔴 为什么不能沿用下面那套「等比缩小」：
   *   16px 下所有细节都掉到亚像素级 —— 日期格只有 2.5px、勾的笔画只有 0.36px，
   *   渲染出来是一团蓝白色的糊（tools/zoom_icons.mjs 放大后非常明显）。
   *   小图标不是「大图缩小」，而是「大图的删减版」：只留三个形状 ——
   *   白纸 + 蓝色表头 + 一个粗勾，每根笔画都 ≥1.5px，缩到 16px 才认得出。
   *
   * 为什么表头用主蓝而不是浅蓝：浅蓝表头（V_CAL_BAR）在白纸上一缩就没了，
   * 而表头正是「这是日历」的唯一线索。勾也用主蓝，两者同色反而更整体。
   */
  if (tiny) {
    const pageW = size * 0.74, pageH = size * 0.76;
    const pageCX = cx, pageCY = cy + size * 0.01;
    const pageR = pageW * 0.15;
    // 🔴 表头**不能贴着纸的上沿**。
    // 贴沿时它和图标外圈的蓝底直接连成一片（16px 下实测 y=0..4 整五行全蓝），
    // 「日历表头」这个线索就没了 —— 只剩一块白卡片加一个勾。
    // 留一道白缝把纸的上沿描出来，卡片才成立。缝宽至少 1px，否则会渲染成灰线。
    const barGap = Math.max(1, size * 0.07);
    const barH = Math.max(2.2, pageH * 0.22);
    const barCY = pageCY - pageH / 2 + barGap + barH / 2;
    // 勾的粗细按尺寸走。太粗会和两段胶囊在转折处糊成一坨
    // （32px 下 3.8px 的笔画就是个蓝疙瘩，完全不像勾）；太细又整条消失。
    // 1.5px 是 16px 下的实测下限，再细就看不见了。
    const checkStroke = Math.max(1.5, size * 0.062);
    const ckCY = pageCY + pageH * 0.14;
    // u 决定勾的大小：勾的外接框是 1.82u × 1.34u，取 0.28 让勾占纸宽的约 51%
    const u = pageW * 0.28;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const px = x + 0.5, py = y + 0.5;

        const aBg = coverage(sdRoundRect(px, py, cx, cy, R, R, cornerR), aa);
        if (aBg <= 0) { rgba[i + 3] = 0; continue; }

        const t = Math.min(Math.max((px + py) / (2 * size), 0), 1);
        const col = [
          V_BG_TOP[0] + (V_BG_BOT[0] - V_BG_TOP[0]) * t,
          V_BG_TOP[1] + (V_BG_BOT[1] - V_BG_TOP[1]) * t,
          V_BG_TOP[2] + (V_BG_BOT[2] - V_BG_TOP[2]) * t,
        ];

        // 白纸
        const aPage = coverage(sdRoundRect(px, py, pageCX, pageCY, pageW / 2, pageH / 2, pageR), aa);
        if (aPage > 0) {
          blend(col, V_CAL, aPage);

          // 蓝色表头（日历的唯一线索，必须压得住）
          const aBar = coverage(
            sdRoundRect(px, py, pageCX, barCY, pageW / 2 - pageW * 0.035, barH / 2, pageR * 0.4),
            aa
          );
          if (aBar > 0) blend(col, V_CHECK, aBar * aPage);

          // 粗勾：两段胶囊，笔画 ≥1.75px
          const aTick = Math.max(
            coverage(sdCapsule(px, py, pageCX - u * 0.86, ckCY - u * 0.04, pageCX - u * 0.16, ckCY + u * 0.60, checkStroke), aa),
            coverage(sdCapsule(px, py, pageCX - u * 0.16, ckCY + u * 0.60, pageCX + u * 0.96, ckCY - u * 0.74, checkStroke), aa)
          );
          if (aTick > 0) blend(col, V_CHECK, aTick * aPage);
        }

        rgba[i] = Math.round(col[0]);
        rgba[i + 1] = Math.round(col[1]);
        rgba[i + 2] = Math.round(col[2]);
        rgba[i + 3] = Math.round(aBg * 255);
      }
    }
    return rgba;
  }

  // --- 构图比例：全部按 size 百分比，保证等比 ---
  // 简化版把日历放大、居中，因为它是唯一要传达的信息
  const calW = size * (detailed ? 0.55 : 0.66);
  const calH = size * (detailed ? 0.475 : 0.575);
  const calCX = size * (detailed ? 0.475 : 0.50);
  const calCY = size * (detailed ? 0.515 : 0.505);
  const calCorner = calW * 0.14;

  // 环绕带（简化版不要）
  const ringA = size * 0.415, ringB = size * 0.315;
  // 环在 48px 这种「刚够详细版」的尺寸下容易过粗过亮，压过日历，
  // 所以按尺寸收缩：尺寸越小越细越淡，到了 96px 以上才是设计稿的观感
  const ringScale = Math.min(1, size / 128);
  const ringHalf = size * 0.021 * (0.62 + 0.38 * ringScale);
  const ringAlpha = 0.62 + 0.30 * ringScale;
  const ringRot = -0.42;

  // 活页环（简化版加粗加长，否则看不见）
  const capR = size * (detailed ? 0.020 : 0.035);
  const capY1 = calCY - calH / 2 - size * (detailed ? 0.070 : 0.062);
  const capY2 = calCY - calH / 2 + size * (detailed ? 0.038 : 0.030);
  const capDX = calW * 0.245;

  // 日期格
  const cellW = calW * (detailed ? 0.215 : 0.24);
  const cellH = calH * (detailed ? 0.30 : 0.30);
  const gx0 = calCX - cellW * 1.18;
  const gy0 = calCY - cellH * 0.62;
  const chkCX = gx0 + cellW * 1.18;
  const chkCY = gy0;

  // 钱包（简化版不要）
  const wHW = size * 0.160, wHH = size * 0.112;
  const wCX = size * 0.700, wCY = size * 0.672;
  const wCorner = size * 0.036;

  // 简化版勾选的笔画粗细要相对更粗（缩到 16px 后细线会整条消失）
  const tickW = detailed ? cellW * 0.42 * 0.24 : cellW * 0.42 * 0.34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const px = x + 0.5, py = y + 0.5;

      // ① 背板
      const aBg = coverage(sdRoundRect(px, py, cx, cy, R, R, cornerR), aa);
      if (aBg <= 0) { rgba[i + 3] = 0; continue; }

      // 底色对角渐变
      const t = Math.min(Math.max((px + py) / (2 * size), 0), 1);
      const col = [
        V_BG_TOP[0] + (V_BG_BOT[0] - V_BG_TOP[0]) * t,
        V_BG_TOP[1] + (V_BG_BOT[1] - V_BG_TOP[1]) * t,
        V_BG_TOP[2] + (V_BG_BOT[2] - V_BG_TOP[2]) * t,
      ];

      // ② 环绕带（仅详细版）
      if (detailed) {
        const dRing = sdEllipseRing(px, py, cx, cy + size * 0.02, ringA, ringB, ringHalf, ringRot);
        const aRing = coverage(dRing, aa);
        if (aRing > 0) blend(col, V_RING, aRing * ringAlpha);
      }

      // ③ 活页环
      let aCap = 0;
      for (const sign of [-1, 1]) {
        const rx = calCX + sign * capDX;
        aCap = Math.max(aCap, coverage(sdCapsule(px, py, rx, capY1, rx, capY2, capR), aa));
      }
      if (aCap > 0) blend(col, V_CAL, aCap);

      // ④ 日历主体
      const aCal = coverage(sdRoundRect(px, py, calCX, calCY, calW / 2, calH / 2, calCorner), aa);
      if (aCal > 0) {
        blend(col, V_CAL, aCal);

        // 表头浅色横条（简化版略过：小尺寸下这条会和白底糊在一起）
        if (detailed) {
          const barH = calH * 0.24;
          const aBar = coverage(
            sdRoundRect(px, py, calCX, calCY - calH / 2 + barH / 2, calW / 2 - calW * 0.02, barH / 2, calCorner * 0.4),
            aa
          );
          if (aBar > 0) blend(col, V_CAL_BAR, aBar * aCal);
        }

        // 日期格：详细版 3x2 六格；简化版只留勾选格正下方那一格，
        // 给个「这是日历」的暗示就够了，铺满反而变噪点
        if (detailed) {
          for (let r = 0; r < 2; r++) {
            for (let c = 0; c < 3; c++) {
              if (r === 0 && c === 1) continue;
              const bx = gx0 + c * cellW * 1.18;
              const by = gy0 + r * cellH * 1.16;
              const a = coverage(sdRoundRect(px, py, bx, by, cellW / 2, cellH / 2, cellW * 0.22), aa);
              if (a > 0) blend(col, V_CELL, a * aCal);
            }
          }
        } else {
          // 勾选格两侧各留一格，形成「三格一排」的日历印象
          for (const dx of [-1, 1]) {
            const bx = chkCX + dx * cellW * 1.18;
            const a = coverage(sdRoundRect(px, py, bx, chkCY, cellW / 2, cellH / 2, cellW * 0.22), aa);
            if (a > 0) blend(col, V_CELL, a * aCal);
          }
        }
      }

      // ⑤ 勾选格（蓝底 + 白勾）—— 简化版也保留，这是最核心的识别点
      const aChk = coverage(sdRoundRect(px, py, chkCX, chkCY, cellW / 2, cellH / 2, cellW * 0.26), aa);
      if (aChk > 0) {
        blend(col, V_CHECK, aChk);
        const u = cellW * 0.42;
        const aTick = Math.max(
          coverage(sdCapsule(px, py, chkCX - u * 0.62, chkCY + u * 0.02, chkCX - u * 0.12, chkCY + u * 0.50, tickW), aa),
          coverage(sdCapsule(px, py, chkCX - u * 0.12, chkCY + u * 0.50, chkCX + u * 0.72, chkCY - u * 0.55, tickW), aa)
        );
        if (aTick > 0) blend(col, V_CAL, aTick * aChk);
      }

      // ⑥ 钱包（仅详细版）
      if (detailed) {
        const aFlip = coverage(
          sdRoundRect(px, py, wCX - wHW * 0.12, wCY - wHH * 0.66, wHW * 0.84, wHH * 0.30, wCorner * 0.75),
          aa
        );
        if (aFlip > 0) blend(col, V_WALLET_B, aFlip);
        const aW = coverage(sdRoundRect(px, py, wCX, wCY, wHW, wHH, wCorner), aa);
        if (aW > 0) {
          blend(col, V_WALLET, aW);
          const aSlot = coverage(
            sdRoundRect(px, py, wCX - wHW * 0.06, wCY + wHH * 0.28, wHW * 0.40, wHH * 0.115, wHH * 0.115),
            aa
          );
          if (aSlot > 0) blend(col, V_CAL, aSlot * aW);
        }
      }

      rgba[i] = Math.round(col[0]);
      rgba[i + 1] = Math.round(col[1]);
      rgba[i + 2] = Math.round(col[2]);
      rgba[i + 3] = Math.round(aBg * 255);
    }
  }
  return rgba;
}

/* ============================================================
   第四部分：用设计稿的 3D logo 生成大尺寸图标
   ============================================================ */

/**
 * 在无头浏览器里解码 3D 源图，并做「探测内容边界 → 裁切 → 缩放 → 套圆角」。
 *
 * 为什么借浏览器解码：源图是 JPEG，Node 没有内置解码器。
 * 为了两张图引 sharp/jimp 会破坏项目的零依赖原则，
 * 而 puppeteer-core 已是端到端测试的既有依赖，借它的解码能力不增加成本。
 */
async function renderFrom3D(sourcePath, targets) {
  const P = ['C:/Users/27693/.workbuddy-ai/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js']
    .find((p) => existsSync(p));
  if (!P) throw new Error('找不到 puppeteer-core，无法解码 3D 源图');
  const puppeteer = (await import(pathToFileURL(P).href)).default;

  const CHROME = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => existsSync(p));
  if (!CHROME) throw new Error('找不到 Chrome / Edge');

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();

  const dataUrl = 'data:image/jpeg;base64,' + readFileSync(sourcePath).toString('base64');

  const out = await page.evaluate(async (src, jobs) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    // --- 探测内容边界：从四边往内扫，找第一个「明显不是白底」的像素 ---
    const W = img.naturalWidth, H = img.naturalHeight;
    const probe = document.createElement('canvas');
    probe.width = W; probe.height = H;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    pctx.drawImage(img, 0, 0);
    const data = pctx.getImageData(0, 0, W, H).data;

    const isContent = (x, y) => {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a < 24) return false;
      if (r > 244 && g > 244 && b > 244) return false;   // 白底
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return (mx - mn) > 14 || mn < 232;
    };

    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isContent(x, y)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }

    // 取正方形（内容居中）。
    //
    // 注意这里**必须外扩一点**：`isContent` 找的是「第一个明显不是白的像素」，
    // 而 3D 稿的边缘是「白 → 蓝」的柔和渐变（还有一圈浅浅的投影），
    // 所以探到的边界其实落在真实边缘的内侧几个像素。
    // 不外扩的话，缩放后外缘会被削掉一圈，四个圆角处最明显（会啃出透明缺口）。
    const side = Math.max(maxX - minX + 1, maxY - minY + 1);
    const cx = (minX + maxX + 1) / 2, cy = (minY + maxY + 1) / 2;
    const pad = side * 0.022;
    const sx = cx - side / 2 - pad, sy = cy - side / 2 - pad;
    const sSide = side + pad * 2;

    // --- 量出作品自身的圆角半径，别拿一个猜的数字去裁 ---
    // 从内容左边缘那一列自顶向下找「蓝色从哪里开始」，
    // 与上边缘那一行自左向右找的起点相减，就是圆角的横向进深。
    // 直接硬编码 0.225 是很危险的：那个值比这稿的实际圆角小，
    // 裁上去就会啃进蓝色里（v1.8.0 初版就这么错的）。
    const isBlue = (x, y) => {
      const i = (y * W + x) * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      return a > 128 && b > 150 && b - r > 40;
    };
    let cornerR = 0;
    {
      // 左侧：在 x = minX 这一列自上而下，蓝第一个出现的位置
      let topLeftY = -1;
      for (let y = minY; y <= maxY; y++) if (isBlue(minX + 2, y)) { topLeftY = y; break; }
      // 顶部：在 y = minY 这一行自左向右，蓝第一个出现的位置
      let topLeftX = -1;
      for (let x = minX; x <= maxX; x++) if (isBlue(x, minY + 2)) { topLeftX = x; break; }
      if (topLeftY >= 0 && topLeftX >= 0) {
        cornerR = Math.max(Math.abs(topLeftY - minY), Math.abs(topLeftX - minX));
      }
    }
    // 换算成相对边长比例，并夹在合理区间（20%~30% 是 iOS squircle 的常见范围）
    const cornerRatio = Math.min(Math.max(cornerR / side, 0.2), 0.3);

    // --- 取一个「作品的蓝」用于铺底 ---
    // 取上边缘中点往下 12% 处：那里一定是纯蓝底色，
    // 避开了圆角（角落偏白）也避开了中央的日历图案。
    let edgeBlue = '#2f74e8';
    {
      const px = Math.round(cx);
      const py = Math.round(minY + side * 0.12);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        const i = (py * W + px) * 4;
        edgeBlue = `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
      }
    }

    // 同样取一次**下**边缘中点往上 12% 的蓝。
    // 作品是「左上浅、右下深」的对角渐变，拿单色铺底会在远端露出色差；
    // 用实测的上下两端色做对角渐变，四周接缝几乎看不见。
    let edgeBlueBottom = edgeBlue;
    {
      const px = Math.round(cx);
      const py = Math.round(maxY - side * 0.12);
      if (px >= 0 && px < W && py >= 0 && py < H) {
        const i = (py * W + px) * 4;
        edgeBlueBottom = `rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`;
      }
    }

    const results = {};
    for (const job of jobs) {
      const { name, size, maskable, cover, insetRatio } = job;
      const cv = document.createElement('canvas');
      cv.width = size; cv.height = size;
      const ctx = cv.getContext('2d');

      // 安全区比例：maskable 默认 14%（安卓的遮罩很激进），
      // 其他「满幅不透明」用途可以给更小的值，让内容更满。
      const inset = size * (insetRatio != null ? insetRatio : (maskable ? 0.14 : 0.04));
      const inner = size - inset * 2;

      if (cover) {
        // 满幅不透明（apple-touch-icon 专用）：把作品**放大到圆角落到画布之外**。
        //
        // 🔴 iOS 会把 apple-touch-icon 的透明像素合成成黑色 —— 带透明圆角的图标
        // 装到 iPhone 桌面上，四个角就是四块黑。所以这一版必须整幅不透明。
        //
        // 为什么用「放大溢出」而不是「铺底」：铺底要求铺的蓝与作品边缘的蓝完全一致，
        // 而作品是左上浅、右下深的对角渐变，任何单色或近似渐变都会在某条边上露出色差，
        // 表现成图标里凭空多出一圈「边框」。放大溢出则**根本不需要配色** ——
        // 画布上每个像素都来自作品本身，接缝在原理上就不可能存在。
        //
        // 放大倍数的下限是「画布四角要落在作品的圆角之内」：
        // 角点映射到作品归一化坐标 a = 0.5 - 0.5/S，要求 a ≥ R(1 - 1/√2)（R 为圆角占比）。
        // 实测 R ≈ 0.259 → S ≥ 1.179，这里再留一点余量。
        // 代价是每条边裁掉约 0.2%：环绕带最外侧各削掉不到 1 个像素，看不出来。
        const S = Math.max(1.21, 1 / (1 - 2 * cornerRatio * (1 - Math.SQRT1_2)));
        const dSide = size * S;
        const off = (size - dSide) / 2;
        ctx.drawImage(img, sx, sy, sSide, sSide, off, off, dSide, dSide);
      } else if (maskable) {
        // 🔴 满幅不透明（安卓自适应图标）。
        // 系统会自己裁形状（圆 / 方 / 水滴都可能），任何透明的角都会露出底色，
        // 所以内容必须收在中央安全区内、四周由底色填满。
        //
        // 为什么不能「缩小贴一份」：源图是圆角方块，它的**外接方框四个角是白的**。
        // 无论怎么取景，只要把方框贴进来，就会带入四块白角 ——
        // 缩小贴会得到白色描边环，铺满贴会得到白色方块（两种都试过，都不行）。
        //
        // 正确做法：只贴**一次**，然后拿作品自身的蓝色把四周空白填满。
        // 蓝取自作品边缘的实测颜色，所以接缝不可见。
        // 用「上缘色 → 下缘色」的对角渐变而不是单色：
        // 作品本身是左上浅、右下深的对角渐变，单色铺底会在远端露出色差。
        //
        // ⚠️ 安全区大（14%）时，这层铺底读起来是「背景」而不是「边框」，观感没问题。
        // 需要更小的安全区时别用这条分支 —— 用 `cover`（放大溢出，无需配色）。
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(inset, inset, inner, inner, inner * cornerRatio);
        ctx.clip();
        ctx.drawImage(img, sx, sy, sSide, sSide, inset, inset, inner, inner);
        ctx.restore();

        // 铺底用 destination-over：只落在还没着色的像素上（也就是四周空白），
        // 不会盖住刚贴好的作品，顺序也就不再有讲究。
        ctx.globalCompositeOperation = 'destination-over';
        const grad = ctx.createLinearGradient(0, 0, size, size);
        grad.addColorStop(0, edgeBlue);
        grad.addColorStop(1, edgeBlueBottom);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, size, size);
        ctx.globalCompositeOperation = 'source-over';
      } else {
        // 用**量出来的**圆角半径裁，别用猜的。
        // 半径偏小 → 啃进蓝色，四角出现透明缺口；半径偏大 → 角落残留白边。
        //
        // 另外留一点点内边距（4%）：有些启动器会在方形图标上套一个圆形遮罩，
        // 贴边画的话日历左右两侧和钱包会被圆切掉（tools/mask_preview.mjs 能看到）。
        // 留 4% 既能保住内容，视觉上仍是「满格」的。
        //
        // ⚠️ 这一支的四个角是**透明**的（PWA 的 purpose:"any" 允许）。
        // 别把它复用给 apple-touch-icon —— iOS 会把透明合成成黑色。
        ctx.beginPath();
        ctx.roundRect(inset, inset, size - inset * 2, size - inset * 2, (size - inset * 2) * cornerRatio);
        ctx.clip();
        ctx.drawImage(img, sx, sy, sSide, sSide, inset, inset, size - inset * 2, size - inset * 2);
      }

      results[name] = Array.from(ctx.getImageData(0, 0, size, size).data);
    }
    return { results, bbox: { minX, minY, maxX, maxY, W, H, cornerR, cornerRatio, side } };
  }, dataUrl, targets);

  await browser.close();
  return out;
}

/* ============================================================
   第五部分：主流程
   ============================================================ */

mkdirSync(OUT_DIR, { recursive: true });

const explicit = process.argv[2];
const CANDIDATES = [
  explicit ? resolve(explicit) : null,
  join(ROOT, 'logo1.png'),
  join(ROOT, 'assets', 'logo-3d.png'),
  'C:/Users/27693/.workbuddy-ai/clipboard-images/clipboard-2026-09-15T15-50-48-166Z-331f5f56.jpg',
  'C:/Users/27693/.workbuddy-ai/clipboard-images/clipboard-2026-09-15T15-50-48-168Z-98086ef7.jpg',
].filter(Boolean);

const src = CANDIDATES.find((p) => existsSync(p));

console.log('\n=== 生成应用图标 ===\n');

if (src) {
  console.log(`3D 源图：${src}`);

  const bigTargets = [
    { name: 'icon-192.png', size: 192, maskable: false },
    { name: 'icon-512.png', size: 512, maskable: false },
    // 🔴 apple-touch-icon 必须「满幅不透明」—— iOS 会把透明像素合成成黑色，
    // 带透明圆角的图标装到 iPhone 桌面上，四个角就是四块黑。
    // 用 cover（放大溢出）而不是 maskable（铺底）：iOS 的遮罩比安卓温和，
    // 不需要 14% 那么大的安全区，而安全区一小，铺底就会露成「边框」。
    { name: 'apple-touch-icon.png', size: 180, cover: true },
    { name: 'icon-maskable-512.png', size: 512, maskable: true },
  ];

  const { results, bbox } = await renderFrom3D(src, bigTargets);
  console.log(`内容边界：${bbox.maxX - bbox.minX + 1}x${bbox.maxY - bbox.minY + 1}（源图 ${bbox.W}x${bbox.H}）`);
  console.log(`圆角半径：约 ${bbox.cornerR}px（占内容边长 ${(bbox.cornerRatio * 100).toFixed(1)}%）\n`);

  for (const t of bigTargets) {
    const png = encodePNG(t.size, t.size, Buffer.from(results[t.name]));
    writeFileSync(join(OUT_DIR, t.name), png);
    console.log(`\u2713 ${t.name.padEnd(24)} ${String(t.size).padStart(3)}x${t.size}  ${(png.length / 1024).toFixed(1)} KB  (3D)`);
  }
} else {
  console.log('\u26a0 未找到 3D 源图，大尺寸图标跳过（仅生成矢量版）');
  console.log('  可以把设计稿存为 logo1.png 放在项目根目录后重跑。\n');
}

for (const [name, size] of [['favicon-48.png', 48], ['favicon-32.png', 32], ['favicon-16.png', 16]]) {
  const png = encodePNG(size, size, drawFlatIcon(size));
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`\u2713 ${name.padEnd(24)} ${String(size).padStart(3)}x${size}  ${(png.length / 1024).toFixed(1)} KB  (矢量)`);
}

console.log(`\n全部图标已输出到 web/icons/`);
