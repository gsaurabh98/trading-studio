/* ─────────────────────────────────────────────────────────────────────
 * Clear app cache / site data — in-app replacement for Chrome's
 * "Clear cache / cookies", so the user never has to dig into browser
 * settings to pick up a fresh build or wipe local state.
 *
 * Two tiers, both wired to footer buttons:
 *
 *   clearAppCache()  — SAFE. Deletes the Cache Storage entries (the SW
 *     precache + runtime caches), unregisters the service worker, and
 *     clears sessionStorage, then hard-reloads. KEEPS localStorage so the
 *     Upstox/broker token, paper-trade positions & history, and saved
 *     swing scans all survive. This is the "I edited the app / want the
 *     latest version" button — the common case.
 *
 *   resetAppData()   — DESTRUCTIVE. Everything above PLUS localStorage,
 *     IndexedDB and cookies — a full site-data wipe equivalent to Chrome's
 *     "Clear cookies and site data". Guarded by an explicit confirm()
 *     spelling out exactly what is lost (token, trades, saved scans).
 *
 * Classic <script defer> (not a module) so window.clearAppCache /
 * window.resetAppData resolve from the footer's inline onclick handlers,
 * matching the rest of the app's JS-module-split convention.
 * ───────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // Delete every Cache Storage bucket (all CACHE_VERSION-stamped names).
  async function dropCaches() {
    if (!window.caches || !caches.keys) return;
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (_) { /* best-effort */ }
  }

  // Unregister all service workers so a fresh one installs on reload.
  async function unregisterServiceWorkers() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;
    try {
      var regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(function (r) { return r.unregister(); }));
    } catch (_) { /* best-effort */ }
  }

  // Drop every IndexedDB database for this origin (full-reset only).
  async function dropIndexedDb() {
    try {
      if (!window.indexedDB) return;
      if (indexedDB.databases) {
        var dbs = await indexedDB.databases();
        await Promise.all((dbs || []).map(function (d) {
          return new Promise(function (res) {
            if (!d || !d.name) { res(); return; }
            var req = indexedDB.deleteDatabase(d.name);
            req.onsuccess = req.onerror = req.onblocked = function () { res(); };
          });
        }));
      }
    } catch (_) { /* best-effort */ }
  }

  // Expire every cookie this page can see (full-reset only).
  function dropCookies() {
    try {
      var expiry = ';expires=Thu, 01 Jan 1970 00:00:00 GMT';
      document.cookie.split(';').forEach(function (c) {
        var name = c.split('=')[0].trim();
        if (!name) return;
        document.cookie = name + '=' + expiry + ';path=/';
        document.cookie = name + '=' + expiry + ';path=' + location.pathname;
      });
    } catch (_) { /* best-effort */ }
  }

  function flash(msg) {
    var el = document.getElementById('foot-cache-status');
    if (el) { el.hidden = false; el.textContent = msg; }
  }

  // SAFE: cache + SW + sessionStorage only. Keeps saved data.
  window.clearAppCache = async function () {
    flash('Clearing cache & updating\u2026');
    await dropCaches();
    await unregisterServiceWorkers();
    try { sessionStorage.clear(); } catch (_) { /* private mode */ }
    // Hard reload — the unregistered SW means the browser now fetches the
    // shell + assets straight from the network.
    location.reload();
  };

  // DESTRUCTIVE: full site-data wipe. Confirmed first.
  window.resetAppData = async function () {
    var ok = window.confirm(
      'Reset ALL app data?\n\n' +
      'This permanently clears:\n' +
      '\u2022 Upstox / broker API token\n' +
      '\u2022 Paper-trading positions & history\n' +
      '\u2022 Saved swing scans & preferences\n' +
      '\u2022 Cached files (service worker) & cookies\n\n' +
      'You will need to reconnect your API token afterwards. Continue?'
    );
    if (!ok) return;
    flash('Resetting all app data\u2026');
    await dropCaches();
    await unregisterServiceWorkers();
    await dropIndexedDb();
    try { sessionStorage.clear(); } catch (_) { /* private mode */ }
    try { localStorage.clear(); } catch (_) { /* private mode */ }
    dropCookies();
    location.reload();
  };
})();
