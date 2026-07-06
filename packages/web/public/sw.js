/* BIDit service worker — makes the app installable and resilient offline,
 * WITHOUT ever caching live/money data.
 *
 * The backend API lives on a different origin, so cross-origin requests are
 * ignored here by design — balances, auctions and orders are always fetched
 * fresh from the network. We only touch same-origin GETs (the app shell +
 * static assets), and navigations are network-first so users can never get
 * stuck on a stale build while online. */
const CACHE = 'bidit-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept the API, fonts, or remote images

  // App navigations: always try the network first (fresh build), fall back to
  // the cached shell only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // Hashed build assets are immutable → cache-first.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
        return res;
      })),
    );
    return;
  }

  // Other same-origin GETs (icons, category art): stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((hit) => {
      const fetching = fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
          return res;
        })
        .catch(() => hit);
      return hit || fetching;
    }),
  );
});
