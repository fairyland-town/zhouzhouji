/**
 * sw.js —— Service Worker：让应用可安装、可离线（v1.5.0）
 *
 * 策略：**缓存优先 + 后台更新**（stale-while-revalidate）
 *   本应用是纯静态资源，且用户可能在食堂、教学楼等网络不稳的地方用，
 *   所以「打开就要能用」比「永远最新」重要。
 *   有网时后台悄悄拉新版本，下次打开即是新的。
 *
 * 但 index.html 例外：走网络优先，保证导航壳不会长期卡在旧版本。
 *
 * 缓存版本：改动 web/ 下任何资源后，必须把 VERSION 加 1，
 * 否则老用户会一直用旧缓存。tools/build_pwa.mjs 会自动同步这个值。
 */

const VERSION = 'v1.13.8';
const CACHE = `campus-week-${VERSION}`;

/* 需要预缓存的资源（由 tools/build_pwa.mjs 自动生成） */
const PRECACHE = [
  './',
  './css/style.css',
  './icons/apple-touch-icon.png',
  './icons/favicon-16.png',
  './icons/favicon-32.png',
  './icons/favicon-48.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './index.html',
  './js/main.js',
  './js/models/account.js',
  './js/models/asset.js',
  './js/models/categories.js',
  './js/models/checkin.js',
  './js/models/event.js',
  './js/models/ledger_entry.js',
  './js/models/todo.js',
  './js/screens/add_event_screen.js',
  './js/screens/confirm_screen.js',
  './js/screens/edit_event_screen.js',
  './js/screens/guide_screen.js',
  './js/screens/record/account_view.js',
  './js/screens/record/checkin_view.js',
  './js/screens/record/gold_sheet.js',
  './js/screens/record/ledger_view.js',
  './js/screens/record/todo_view.js',
  './js/screens/record_screen.js',
  './js/screens/settings_screen.js',
  './js/screens/week_screen.js',
  './js/services/account_service.js',
  './js/services/asset_service.js',
  './js/services/backup_service.js',
  './js/services/category_parser.js',
  './js/services/checkin_service.js',
  './js/services/database_service.js',
  './js/services/event_parser.js',
  './js/services/ledger_service.js',
  './js/services/location_parser.js',
  './js/services/native_bridge.js',
  './js/services/ocr_service.js',
  './js/services/receipt_parser.js',
  './js/services/reminder_service.js',
  './js/services/speaker_parser.js',
  './js/services/time_parser.js',
  './js/services/title_parser.js',
  './js/services/todo_service.js',
  './js/utils/date_utils.js',
  './js/utils/dom.js',
  './js/utils/money.js',
  './js/utils/regex_patterns.js',
  './js/version.js',
  './js/widgets/day_section.js',
  './js/widgets/event_card.js',
  './js/widgets/icons.js',
  './js/widgets/page_header.js',
  './js/widgets/quick_sheet.js',
  './js/widgets/week_header.js',
  './manifest.webmanifest',
];

/* ---------------- 安装：预缓存 ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 用 addAll 会「一个失败就全失败」，这里逐个加，单个 404 不影响整体
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        console.warn('[sw] 预缓存失败（已跳过）:', url, err.message);
      }
    }));
    // 新 SW 立即接管，不等用户关掉所有标签页
    await self.skipWaiting();
  })());
});

/* ---------------- 激活：清理旧版本缓存 ---------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('campus-week-') && k !== CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------------- 请求拦截 ---------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET；OCR 的 POST 请求等一律放行
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 跨域请求（例如本机 OCR 服务）不走缓存，交给网络
  if (url.origin !== self.location.origin) return;

  // 导航请求（打开页面）：网络优先，失败回落缓存 —— 避免壳子卡在旧版
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cache = await caches.open(CACHE);
        return (await cache.match('./index.html'))
          || (await cache.match('./'))
          || new Response('离线中，且没有可用缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);

    const network = fetch(req).then((res) => {
      // 只缓存正常响应，避免把 404 / 500 写进缓存
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    if (cached) return cached;

    const fresh = await network;
    if (fresh) return fresh;

    return new Response('离线中，资源未缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});

/* ---------------- 消息：支持手动触发更新 ---------------- */

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
