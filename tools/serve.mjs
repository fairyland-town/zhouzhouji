/**
 * serve.mjs —— 零依赖静态服务器
 *
 * 用法：
 *   node tools/serve.mjs              # 默认 8080，并对局域网开放（手机可访问）
 *   node tools/serve.mjs 9000         # 指定端口
 *   node tools/serve.mjs 8080 local   # 只绑 127.0.0.1（仅本机访问，更安全）
 *
 * 为什么要绑 0.0.0.0：PWA 装到安卓手机时，手机必须能访问到这台电脑。
 * 只绑 127.0.0.1 的话手机浏览器会打不开，装不了。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..', 'web');
const PORT = Number(process.argv[2] || 8080);
const LOCAL_ONLY = process.argv[3] === 'local';
const HOST = LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';

    const target = join(ROOT, normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    const file = info && info.isDirectory() ? join(target, 'index.html') : target;
    const data = await readFile(file);

    const headers = {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    };
    // Service Worker 必须在作用域根上，且不允许被缓存代理改写
    if (file.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';

    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

/** 找出本机在局域网里的 IPv4 地址，方便手机访问 */
function lanAddresses() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log('周周记 本地服务器已启动');
  console.log(`  本机访问: http://localhost:${PORT}`);
  if (!LOCAL_ONLY) {
    const lans = lanAddresses();
    if (lans.length) {
      console.log('');
      console.log('  手机访问（与电脑连同一个 Wi-Fi，用手机 Chrome 打开）:');
      lans.forEach((l) => console.log(`    http://${l.address}:${PORT}    [${l.name}]`));
      console.log('  打开后：Chrome 菜单 →「添加到主屏幕 / 安装应用」');
    } else {
      console.log('  （未检测到局域网地址，手机可能无法访问）');
    }
  } else {
    console.log('  仅本机模式：手机无法访问');
  }
  console.log('');
  console.log(`  静态目录: ${ROOT}`);
  console.log('  按 Ctrl+C 停止');
  if (!LOCAL_ONLY) {
    console.log('');
    console.log('  提示：若手机打不开，多半是 Windows 防火墙拦了 Node.js。');
    console.log('        允许 Node.js 通过「专用网络」即可，无需开放公用网络。');
  }
});

