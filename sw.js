// Offline support.
// Online: always fetches the newest files from GitHub first (so updates show up on the next open).
// Offline or slow signal: falls back to the copy saved on the phone.
// You no longer need to change CACHE for each update; change it only to force-clear old copies.
const CACHE = 'debit-hours-v4';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];
const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch calls to Google

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    // 'no-cache' = ask GitHub whether the file changed instead of trusting the browser's 10-minute copy.
    const network = fetch(req, { cache: 'no-cache' }).then(res => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    });
    const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT_MS, null));
    try {
      const res = await Promise.race([network, timeout]);
      if (res) return res;
    } catch (err) { /* offline */ }
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) { network.catch(() => {}); return cached; }
    try { return await network; } catch (err) { return new Response('Offline', { status: 503 }); }
  })());
});
