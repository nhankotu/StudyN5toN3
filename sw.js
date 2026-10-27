/* PWA offline cache. Network-first để khi cập nhật file JSON trên Netlify, thiết bị lấy bản mới. */
const CACHE_NAME = 'nihongo-study-v3';
const APP_ASSETS = [
  './', './index.html', './styles.css', './app.js', './db.js', './lesson.js',
  './manifest.webmanifest', './assets/logo.svg', './assets/icon-192.png',
  './assets/icon-512.png', './data/manifest.json'
];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_ASSETS);
    // Không tự tải trước toàn bộ các bài: có thể có rất nhiều file JSON.
    // Các bài được cache tự động khi ứng dụng đọc đến chúng.
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('nihongo-study-') && k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Bỏ qua các API endpoint để luôn lấy dữ liệu mới nhất từ MongoDB
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const network = await fetch(req);
      if (network.ok) await cache.put(req, network.clone());
      return network;
    } catch (error) {
      const saved = await cache.match(req);
      if (saved) return saved;
      if (req.mode === 'navigate') return (await cache.match('./index.html')) || Response.error();
      return Response.error();
    }
  })());
});
