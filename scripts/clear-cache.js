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
 *     "Clear cookies and site data". Guarded by a themed confirm modal
 *     (theme-driven, self-contained) spelling out exactly what is lost
 *     (token, trades, saved scans).
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

  // ── Themed confirm modal ───────────────────────────────────────────
  // Self-contained (no dependency on the lazily-loaded content/live.html
  // appConfirm modal, which isn't in the DOM unless the user has visited the
  // Intraday tab). Theme-driven via the global CSS custom properties from
  // base.css, so it follows dark/light automatically. Returns Promise<boolean>.
  function injectConfirmStyles() {
    if (document.getElementById('cc-confirm-styles')) return;
    var css = ''
      + '.cc-confirm-overlay{position:fixed;inset:0;z-index:100000;display:flex;'
      +   'align-items:center;justify-content:center;padding:20px;'
      +   'background:rgba(0,0,0,0.6);backdrop-filter:blur(2px);'
      +   'animation:cc-fade .12s ease-out;}'
      + '@keyframes cc-fade{from{opacity:0}to{opacity:1}}'
      + '.cc-confirm-card{width:100%;max-width:440px;background:var(--card,#1a1a28);'
      +   'color:var(--text,#e8e8f0);border:1px solid color-mix(in srgb,var(--text,#fff) 12%,transparent);'
      +   'border-radius:14px;padding:22px 22px 18px;box-shadow:0 18px 60px rgba(0,0,0,0.5);'
      +   'animation:cc-pop .14s ease-out;}'
      + '@keyframes cc-pop{from{transform:translateY(8px) scale(.98);opacity:0}to{transform:none;opacity:1}}'
      + '.cc-confirm-title{margin:0 0 10px;font-size:16px;font-weight:700;color:var(--text,#fff);}'
      + '.cc-confirm-body{margin:0 0 18px;font-size:13.5px;line-height:1.55;color:var(--muted,#aab);}'
      + '.cc-confirm-body p{margin:0 0 8px;}'
      + '.cc-confirm-body ul{margin:8px 0;padding-left:18px;}'
      + '.cc-confirm-body li{margin:3px 0;}'
      + '.cc-confirm-actions{display:flex;justify-content:flex-end;gap:10px;}'
      + '.cc-confirm-btn{font:inherit;font-size:13px;font-weight:600;padding:8px 16px;'
      +   'border-radius:8px;cursor:pointer;border:1px solid transparent;'
      +   '-webkit-tap-highlight-color:transparent;touch-action:manipulation;'
      +   'transition:background .15s,color .15s,border-color .15s;}'
      + '.cc-confirm-cancel{background:transparent;color:var(--text,#e8e8f0);'
      +   'border-color:color-mix(in srgb,var(--text,#fff) 18%,transparent);}'
      + '.cc-confirm-cancel:hover{background:color-mix(in srgb,var(--text,#fff) 8%,transparent);}'
      + '.cc-confirm-ok{background:var(--bear,#c91f3a);color:#fff;border-color:var(--bear,#c91f3a);}'
      + '.cc-confirm-ok:hover{filter:brightness(1.08);}'
      + '.cc-confirm-ok:focus-visible,.cc-confirm-cancel:focus-visible{outline:2px solid var(--info,#4db8ff);outline-offset:2px;}';
    var style = document.createElement('style');
    style.id = 'cc-confirm-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function themedConfirm(opts) {
    opts = opts || {};
    injectConfirmStyles();
    return new Promise(function (resolve) {
      var prevFocus = document.activeElement;
      var overlay = document.createElement('div');
      overlay.className = 'cc-confirm-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = ''
        + '<div class="cc-confirm-card">'
        +   '<h3 class="cc-confirm-title"></h3>'
        +   '<div class="cc-confirm-body"></div>'
        +   '<div class="cc-confirm-actions">'
        +     '<button type="button" class="cc-confirm-btn cc-confirm-cancel"></button>'
        +     '<button type="button" class="cc-confirm-btn cc-confirm-ok"></button>'
        +   '</div>'
        + '</div>';
      // Title + OK label are plain text (safe); body is trusted markup we
      // author here (no user input), so innerHTML is fine for the bullet list.
      overlay.querySelector('.cc-confirm-title').textContent = opts.title || 'Are you sure?';
      overlay.querySelector('.cc-confirm-body').innerHTML = opts.bodyHtml || '';
      var cancelBtn = overlay.querySelector('.cc-confirm-cancel');
      var okBtn = overlay.querySelector('.cc-confirm-ok');
      cancelBtn.textContent = opts.cancelText || 'Cancel';
      okBtn.textContent = opts.okText || 'Confirm';

      var done = false;
      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (_) {}
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
        else if (ev.key === 'Tab') {
          // Minimal focus trap between the two buttons.
          ev.preventDefault();
          (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
        }
      }
      cancelBtn.addEventListener('click', function () { close(false); });
      okBtn.addEventListener('click', function () { close(true); });
      overlay.addEventListener('mousedown', function (ev) {
        if (ev.target === overlay) close(false);   // backdrop click cancels
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(overlay);
      // Default focus on Cancel — destructive action shouldn't be one stray
      // Enter away.
      setTimeout(function () { try { cancelBtn.focus(); } catch (_) {} }, 30);
    });
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

  // DESTRUCTIVE: full site-data wipe. Confirmed first via the themed modal.
  window.resetAppData = async function () {
    var ok = await themedConfirm({
      title: 'Reset ALL app data?',
      bodyHtml:
        '<p>This permanently clears:</p>'
        + '<ul>'
        +   '<li>Broker API token</li>'
        +   '<li>Paper-trading positions &amp; history</li>'
        +   '<li>Saved swing scans &amp; preferences</li>'
        +   '<li>Cached files (service worker) &amp; cookies</li>'
        + '</ul>'
        + '<p>You will need to reconnect your API token afterwards.</p>',
      okText: 'Reset everything',
      cancelText: 'Cancel'
    });
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
