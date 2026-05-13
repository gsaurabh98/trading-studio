/* Trading Studio — service worker
 *
 * Caching strategy by request type:
 *   - HTML / manifest / icons    → network-first for HTML, SWR for the rest
 *                                  (so app-code changes show up next reload
 *                                  WITHOUT needing a CACHE_VERSION bump)
 *   - content/*.html section files → stale-while-revalidate
 *   - Google Fonts CSS + woff2   → cache-first with long TTL (immutable URLs)
 *   - Klinecharts CDN            → cache-first (versioned URL → effectively immutable)
 *   - Upstox API (api.upstox.com) → bypassed entirely (live market data must
 *                                   never be served stale, AND the SW must
 *                                   not be in the request path so a SW
 *                                   handover can't drop a live fetch)
 *   - Everything else            → network-first with cache fallback
 *
 * Educational sections (~770 KB total, ~10–70 KB each) are NOT precached.
 * They're fetched lazily on first navigation and cached on demand.
 *
 * ── When to bump CACHE_VERSION ──
 * Bump on every meaningful release. Old caches are deleted on activation
 * (see the activate handler below) so storage doesn't leak.
 *
 * ── Activation policy ──
 * Aggressive auto-update: skipWaiting() at install + clients.claim() at
 * activate. The page also listens for 'controllerchange' and reloads
 * automatically when a new SW takes over. End result: when you push a new
 * version, every open tab silently picks it up on its next reload — no
 * "clear cookies" dance, no "Unregister SW in DevTools" dance.
 *
 * Why this is safe even though we previously avoided handover mid-flight:
 *   • All Upstox API calls (api.upstox.com + same-origin /api/*) BYPASS
 *     the SW entirely (see the fetch handler below). A SW handover cannot
 *     drop them because they were never in the SW's request path.
 *   • Static assets are cached either way; a brief handover gap may pull
 *     them from the new SW's cache instead of the old, which is fine.
 *   • The auto-reload runs AFTER the new SW is active, so the new HTML
 *     comes from a consistent SW instance.
 */

const CACHE_VERSION = 'v96-2026-05-14-github-pages-index-redirect';
const STATIC_CACHE = `trading-studio-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `trading-studio-runtime-${CACHE_VERSION}`;
const FONT_CACHE = `trading-studio-fonts-${CACHE_VERSION}`;

// Files we want available immediately the first time the SW activates.
// Keep this list small — favicons, social cards, and PNG fallbacks are NOT
// precached; they're cached on first fetch via the runtime SWR strategy.
const PRECACHE_URLS = [
  './candlestick-patterns.html',
  './manifest.webmanifest',
  './pwa/icons/icon-192.svg',
  './pwa/icons/icon-512.svg',
  './pwa/icons/icon-maskable-512.svg',
  './pwa/icons/apple-touch-icon.png',
  './pwa/offline.html'
];

self.addEventListener('install', (event) => {
  // Precache the small static set, then immediately skip the WAITING state.
  // Combined with clients.claim() in 'activate', this means a freshly-pushed
  // version takes over on the next page reload — no need to close every tab
  // of the site first. The page-side controllerchange listener completes
  // the loop by reloading the tab so the user actually SEES the new code.
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Drop any old cache versions so we don't leak storage between releases,
  // then claim every client tab so the new SW takes immediate control.
  // clients.claim() is what triggers the page's 'controllerchange' event
  // and the auto-reload.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE, FONT_CACHE].includes(k))
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Strategy helpers ──────────────────────────────────────────────────

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || networkPromise || (await networkPromise);
}

async function networkFirst(req, cacheName) {
  try {
    // cache:'no-store' forces a real network round-trip every time, bypassing
    // the browser's HTTP cache. Without this, a server that responds with
    // 304 Not Modified (or a cached 200 with a long max-age) can let stale
    // HTML survive a refresh — exactly the "I have to clear cookies to see
    // your fix" symptom we're trying to kill. Same-origin GETs on localhost
    // are essentially free so the cost is invisible, and on remote hosts
    // we'd rather take the network hit than ship yesterday's bug.
    const res = await fetch(req, { cache: 'no-store' });
    if (res && res.ok && cacheName) {
      const cache = await caches.open(cacheName);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    if (cacheName) {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(req);
      if (cached) return cached;
    }
    throw err;
  }
}

// ── Request router ────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // only cache GETs

  const url = new URL(req.url);

  // 1) Live market data — never serve stale. If offline, fall through to
  // a network error so the app's existing error handling can show its
  // "OFFLINE / TOKEN EXPIRED" UI instead of a stale 401 from yesterday.
  // We bypass two URL shapes:
  //   • Direct calls to api.upstox.com (when the app runs without the
  //     local proxy — file://, GitHub Pages, PWA install on phone)
  //   • Same-origin /api/* paths (when the app runs behind server.py
  //     which proxies /api/v2/* and /api/v3/* to api.upstox.com).
  // Without the second bypass, the same-origin static-asset branch below
  // would cache live LTPs / candles via stale-while-revalidate — the
  // user would see yesterday's data on next reload.
  if (url.hostname === 'api.upstox.com' || url.pathname.startsWith('/api/')) {
    return; // let the browser handle it normally (no SW interception)
  }

  // 2) Lightweight Charts from unpkg — versioned URL, treat as immutable.
  if (url.hostname === 'unpkg.com') {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }

  // 3) Google Fonts — CSS + woff2, both immutable when versioned.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // 4) Same-origin navigations (e.g. opening the PWA fresh) — try network
  // first so users always get the latest HTML when they're online, but
  // fall back to cache (then offline page) when they aren't.
  if (req.mode === 'navigate' || (req.destination === 'document')) {
    event.respondWith(
      networkFirst(req, STATIC_CACHE).catch(async () => {
        const cache = await caches.open(STATIC_CACHE);
        return (
          (await cache.match('./candlestick-patterns.html')) ||
          (await cache.match('./pwa/offline.html')) ||
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        );
      })
    );
    return;
  }

  // 5) Same-origin static assets (icons, manifest, anything else):
  // stale-while-revalidate — instant from cache, refreshed in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    return;
  }

  // 6) Anything else (third-party affiliate links etc.) — network-first
  // with no cache. Don't want to cache redirect pages by accident.
  event.respondWith(
    fetch(req).catch(() => new Response('', { status: 504 }))
  );
});

// ── Message handler — lets the page trigger updates without reload ────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
