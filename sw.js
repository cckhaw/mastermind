/* Mastermind service worker — cache-first static shell, background refresh.
 * Bump CACHE when shipping changes so installed apps pick up the new shell. */
const CACHE = 'mastermind-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'webrtc.js',
  'vendor/peerjs.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Cross-origin traffic (PeerJS signaling, STUN, etc.) is never touched by the SW.
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = req.mode === 'navigate';
    // Ignore the query string (?join=CODE deep links) when matching the shell.
    const cached = await cache.match(isNav ? 'index.html' : req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(isNav ? 'index.html' : req, res.clone());
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const res = await refresh;
    if (res) return res;
    if (isNav) { const shell = await cache.match('index.html'); if (shell) return shell; }
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
