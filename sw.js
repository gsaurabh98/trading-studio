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
 * ONLY when this file's logic or PRECACHE_URLS actually changes.
 * App-code changes (HTML / JS / CSS inside candlestick-patterns.html or
 * content/*.html) DO NOT need a bump — they refresh on the next reload via
 * the network-first / stale-while-revalidate strategies. Bumping for every
 * UI tweak forces a SW handover that can drop in-flight Upstox fetches with
 * a generic "Failed to fetch" error, which is the bug we just fixed.
 *
 * ── Activation policy ──
 * NO skipWaiting() and NO clients.claim(). A new SW enters the "waiting"
 * state and only takes over on the NEXT page reload, when no clients are
 * controlled by the old SW. This guarantees in-flight fetches always
 * complete under one consistent SW — eliminating the handover-blip class
 * of bugs entirely.
 */

const CACHE_VERSION = 'v38-2026-05-11-rename-wall-strength-check';
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
  // Precache the small static set, then enter the WAITING state. We do NOT
  // call skipWaiting() — the old SW keeps serving in-flight requests until
  // the user reloads, at which point this new SW activates cleanly.
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

self.addEventListener('activate', (event) => {
  // Drop any old cache versions so we don't leak storage between releases.
  // We do NOT call clients.claim() — already-open tabs continue under their
  // existing SW until the user reloads them. This prevents the SW handover
  // from ever happening mid-flight.
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => ![STATIC_CACHE, RUNTIME_CACHE, FONT_CACHE].includes(k))
        .map((k) => caches.delete(k))
    ))
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
    const res = await fetch(req);
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
