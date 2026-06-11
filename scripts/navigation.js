// Navigation + UI bootstrap — theme toggle, sidebar drawer, section
// nav (ORDER/LABELS/GROUPS, prev/next, jump grid), keyboard shortcuts,
// lazy section-content loader, hash routing, palette + shortcuts modals.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script
// src> in the SAME document position (classic script), so window.show /
// toggleTheme / toggleSidebar / gotoId / loadSectionContent /
// buildSectionChrome and the rest stay global for the inline handlers in
// the shell header + content/*.html, with unchanged DOMContentLoaded / hash
// routing timing.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

function toggleTheme() {
  var root = document.documentElement;
  var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch (e) { }
  var meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.setAttribute('content', next === 'light' ? '#f8fafc' : '#07090f');
  if (typeof setFavicon === 'function') setFavicon();
  // Re-theme chart canvases (Lightweight Charts renders its own
  // background + grid + text onto a <canvas>, so CSS variables
  // alone can't reach it — we must re-apply via the LWC API).
  if (typeof window.tvReapplyTheme === 'function') {
    try { window.tvReapplyTheme(); } catch (_) {}
  }
  if (typeof window.swingReapplyChartTheme === 'function') {
    try { window.swingReapplyChartTheme(); } catch (_) {}
  }
  // Capture theme in the autosave so reloads bring back the same look,
  // even if the user hasn't named-saved a layout.
  if (typeof scheduleAutosave === 'function') {
    try { scheduleAutosave(); } catch (_) {}
  }
}

function closeAllGroups() {
  document.querySelectorAll('.ngroup.open').forEach(function (g) { g.classList.remove('open'); });
}

function syncGroupActive() {
  document.querySelectorAll('.ngroup').forEach(function (g) {
    var trigger = g.querySelector('.tab-group');
    var hasActive = !!g.querySelector('.sub .tab.active');
    if (trigger) { trigger.classList.toggle('group-active', hasActive); }
  });
}

function isSidebarMode() { return document.body.classList.contains('has-sidebar'); }

function expandActiveGroup() {
  document.querySelectorAll('.ngroup').forEach(function (g) {
    var hasActive = !!g.querySelector('.sub .tab.active');
    g.classList.toggle('open', hasActive);
  });
}

function closeMobileDrawer() {
  var nav = document.querySelector('.nav');
  var bd = document.getElementById('sidebarBackdrop');
  if (nav) nav.classList.remove('drawer-open');
  if (bd) bd.classList.remove('visible');
  document.body.classList.remove('drawer-open');
}

function toggleSidebar(force) {
  var isMobile = window.matchMedia('(max-width:960px)').matches;
  if (isMobile) {
    var nav = document.querySelector('.nav');
    var bd = document.getElementById('sidebarBackdrop');
    if (!nav) return;
    var shouldOpen = typeof force === 'boolean' ? force : !nav.classList.contains('drawer-open');
    nav.classList.toggle('drawer-open', shouldOpen);
    document.body.classList.toggle('drawer-open', shouldOpen);
    if (bd) bd.classList.toggle('visible', shouldOpen);
  } else {
    var body = document.body;
    var isCollapsed = body.classList.contains('sidebar-collapsed');
    // force === true  => open (not collapsed); force === false => close (collapsed)
    var shouldCollapse = typeof force === 'boolean' ? !force : !isCollapsed;
    body.classList.toggle('sidebar-collapsed', shouldCollapse);
    try { localStorage.setItem('sidebarCollapsed', shouldCollapse ? '1' : '0'); } catch (e) { }
  }
}

// Restore collapsed state on desktop from localStorage
(function restoreSidebarState() {
  try {
    var saved = localStorage.getItem('sidebarCollapsed');
    if (saved === '1' && !window.matchMedia('(max-width:960px)').matches) {
      document.body.classList.add('sidebar-collapsed');
    }
  } catch (e) { }
})();

// Populate data-tip (custom tooltip) and aria-label (accessibility) on sidebar tabs and footer buttons.
// We avoid using `title` so the browser's slow native tooltip doesn't overlap our custom one.
(function addTabTooltips() {
  function apply(btn) {
    var txt = (btn.textContent || '').trim().replace(/\s+/g, ' ');
    if (!txt) return;
    if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', txt);
    if (!btn.getAttribute('data-tip')) btn.setAttribute('data-tip', txt);
    btn.removeAttribute('title');
  }
  document.querySelectorAll('.ntabs .tab').forEach(apply);
  document.querySelectorAll('.sidebar-footer button').forEach(apply);
})();

// ═════════ NEXT / PREVIOUS SECTION NAVIGATION ═════════
(function sectionNav() {
  var ORDER = [
    'anatomy',
    'single', 'double', 'triple', 'multi', 'continuation', 'exotic', 'missing', 'chart',
    'techanal',
    'snr', 'timeframe',
    'breakouts', 'retracement',
    'ind-trend', 'ind-momentum', 'ind-volume',
    'cpr',
    'smc',
    'operators', 'traps', 'behavior',
    'chain', 'greeks',
    'options', 'exits', 'hedging', 'expiry', 'scalping',
    'bias', 'playbook', 'calc',
    'risk', 'checklist',
    'live',
    'intraday-trade',
    'api-setup',
    'market', 'glossary', 'faq', 'strategy'
  ];
  var LABELS = {
    anatomy: 'Anatomy', single: 'Single Candles', double: 'Double Candles', triple: 'Triple Candles',
    multi: 'Multi-Candle', continuation: 'Continuation', exotic: 'Exotic', missing: 'More Patterns',
    chart: 'Chart Patterns', traps: 'Traps & Failures',
    techanal: 'Technical Analysis', strategy: 'Master Table',
    snr: 'Support & Resistance', breakouts: 'Breakouts', retracement: 'Retracement',
    cpr: 'CPR & Pivots', smc: 'Smart Money (SMC)', timeframe: 'Timeframe',
    'ind-trend': 'Trend', 'ind-momentum': 'Momentum', 'ind-volume': 'Volume',
    calc: 'Calculators', bias: 'Bias Calculator', chain: 'Option Chain', live: 'Options Trading',
    'intraday-trade': 'Intraday Trade',
    options: 'Buying Rules', exits: 'SL & Targets', greeks: 'Greeks',
    expiry: 'Expiry Day', scalping: 'Scalping', hedging: 'Hedging', operators: 'Operators',
    playbook: 'Pick Strategy',
    behavior: 'Behavioral Analysis', risk: 'Risk Mgmt', checklist: 'Checklist',
    'api-setup': 'API Setup',
    market: 'Indian Market', glossary: 'Glossary', faq: 'FAQ'
  };

  function findTab(id) {
    return document.querySelector('.sub .tab[onclick*="show(\'' + id + '\'"]')
      || document.querySelector('.ntabs > .tab[onclick*="show(\'' + id + '\'"]');
  }
  function gotoId(id) {
    if (!id) return;
    if (typeof show !== 'function') return;
    show(id, findTab(id));
  }
  function buildNav(sec) {
    var id = sec.id;
    var idx = ORDER.indexOf(id);
    if (idx === -1) return;
    if (sec.querySelector('.section-nav')) return;

    var prevId = idx > 0 ? ORDER[idx - 1] : null;
    var nextId = idx < ORDER.length - 1 ? ORDER[idx + 1] : null;

    var nav = document.createElement('nav');
    nav.className = 'section-nav';
    nav.setAttribute('aria-label', 'Section navigation');

    function btnHtml(targetId, dir, fallbackLabel) {
      var arrow = dir === 'prev'
        ? '<svg viewBox="0 0 24 24"><polyline points="15,6 9,12 15,18"/></svg>'
        : '<svg viewBox="0 0 24 24"><polyline points="9,6 15,12 9,18"/></svg>';
      var topLabel = dir === 'prev' ? 'Previous' : 'Next';
      if (!targetId) {
        return '<button class="section-nav-btn ' + dir + '" type="button" disabled>'
          + arrow
          + '<span class="snav-txt"><span class="snav-label">' + fallbackLabel + '</span>'
          + '<span class="snav-title">You\'re here</span></span>'
          + '</button>';
      }
      return '<button class="section-nav-btn ' + dir + '" type="button" data-target="' + targetId
        + '" title="' + (dir === 'prev' ? 'Previous section ([)' : 'Next section (])') + '">'
        + arrow
        + '<span class="snav-txt"><span class="snav-label">' + topLabel + '</span>'
        + '<span class="snav-title">' + (LABELS[targetId] || targetId) + '</span></span>'
        + '</button>';
    }

    nav.innerHTML = btnHtml(prevId, 'prev', 'Start') + btnHtml(nextId, 'next', 'End');
    nav.querySelectorAll('button[data-target]').forEach(function (btn) {
      btn.addEventListener('click', function () { gotoId(btn.getAttribute('data-target')); });
    });
    var host = sec.querySelector(':scope > .wrap') || sec;
    host.appendChild(nav);
  }

  var GROUPS = [
    { title: 'Foundation', ids: ['anatomy'] },
    { title: 'Candles', ids: ['single', 'double', 'triple', 'multi', 'continuation', 'exotic', 'missing'] },
    { title: 'Chart Patterns', ids: ['chart'] },
    { title: 'Technical Analysis', ids: ['techanal'] },
    { title: 'Levels & Timing', ids: ['snr', 'timeframe'] },
    { title: 'Price Action', ids: ['breakouts', 'retracement'] },
    { title: 'Indicators', ids: ['ind-trend', 'ind-momentum', 'ind-volume'] },
    { title: 'CPR & Pivots', ids: ['cpr'] },
    { title: 'Smart Money', ids: ['smc'] },
    { title: 'Market Behavior', ids: ['operators', 'traps', 'behavior'] },
    { title: 'Option Chain', ids: ['chain'] },
    { title: 'Greeks', ids: ['greeks'] },
    { title: 'F&O Playbook', ids: ['options', 'exits', 'hedging', 'expiry', 'scalping'] },
    { title: 'Decision Tools', ids: ['bias', 'playbook', 'calc'] },
    { title: 'Discipline', ids: ['risk', 'checklist'] },
    { title: 'Practice', ids: ['live', 'intraday-trade'] },
    { title: 'Settings', ids: ['api-setup'] },
    { title: 'Reference', ids: ['market', 'glossary', 'faq', 'strategy'] }
  ];

  function buildJump(sec) {
    if (ORDER.indexOf(sec.id) === -1) return;
    if (sec.querySelector('.section-jump')) return;

    var wrap = document.createElement('nav');
    wrap.className = 'section-jump';
    wrap.setAttribute('aria-label', 'Jump to section');

    var heading = document.createElement('div');
    heading.className = 'section-jump-title';
    heading.textContent = 'Jump to any section';
    wrap.appendChild(heading);

    var grid = document.createElement('div');
    grid.className = 'section-jump-grid';

    GROUPS.forEach(function (group) {
      var col = document.createElement('div');
      col.className = 'section-jump-group';
      var title = document.createElement('div');
      title.className = 'section-jump-col-title';
      title.textContent = group.title;
      col.appendChild(title);
      group.ids.forEach(function (id) {
        var link = document.createElement('button');
        link.type = 'button';
        link.className = 'section-jump-link';
        if (id === sec.id) link.classList.add('is-current');
        link.setAttribute('data-target', id);
        link.textContent = LABELS[id] || id;
        link.addEventListener('click', function () { gotoId(id); });
        col.appendChild(link);
      });
      grid.appendChild(col);
    });

    wrap.appendChild(grid);
    var host = sec.querySelector(':scope > .wrap') || sec;
    host.appendChild(wrap);
  }

  function buildSectionChrome(sec) {
    // Build prev/next nav + jump grid for ONE section. Safe to call repeatedly:
    // both buildNav and buildJump short-circuit if their element already exists.
    buildNav(sec);
    buildJump(sec);
  }
  // Exposed so loadSectionContent (in the outer bootstrap script) can re-run
  // the chrome build right after it injects content/<id>.html into a placeholder.
  window.buildSectionChrome = buildSectionChrome;
  // Exposed for inline onclick="gotoId('...')" links inside content/*.html.
  // gotoId lives in this IIFE (private), so without this the "see also" /
  // cross-reference links in 9 content pages threw ReferenceError on click.
  window.gotoId = gotoId;

  function renderAll() {
    document.querySelectorAll('.sec').forEach(function (sec) {
      // Skip lazy-loaded placeholders that haven't fetched their content yet —
      // their `.wrap` doesn't exist, so buildNav/buildJump would fall back to
      // appending nav/jump directly to the empty placeholder, which then masks
      // the "is this section loaded?" check and prevents the fetch from running.
      if (sec.dataset && sec.dataset.content && sec.dataset.loaded !== '1') return;
      buildSectionChrome(sec);
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    var tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    if (e.key !== '[' && e.key !== ']') return;
    var active = document.querySelector('.sec.active');
    if (!active) return;
    var idx = ORDER.indexOf(active.id);
    if (idx === -1) return;
    if (e.key === ']' && idx < ORDER.length - 1) { e.preventDefault(); gotoId(ORDER[idx + 1]); }
    else if (e.key === '[' && idx > 0) { e.preventDefault(); gotoId(ORDER[idx - 1]); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderAll);
  } else {
    renderAll();
  }
})();

// Keyboard shortcut: Ctrl/Cmd + B to toggle sidebar
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
    var tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    e.preventDefault();
    toggleSidebar();
  }
});

/* ──────────────────────────────────────────────────────────────────
   Lazy-loaded section content
   ──────────────────────────────────────────────────────────────────
   Most sections live in `content/<id>.html` (one file per section) and
   are fetched on first navigation, then cached in the DOM forever.
   This keeps the initial download to ~10K lines (app shell + modules)
   instead of 24K+ lines of educational HTML.

   A section is "external" if its placeholder `<div class="sec" id="X">`
   carries `data-content="X"` and is empty. The split script
   (`scripts/split-content.py`) wrote those placeholders. The default
   landing section (`anatomy`) stays inline so first paint has content
   without a fetch round-trip. */
var contentInflight = {}; // id -> Promise (prevents duplicate fetches on rapid clicks)

function loadSectionContent(id, done) {
  done = done || function () { };
  var target = document.getElementById(id);
  if (!target || !target.dataset || !target.dataset.content) { done(); return; }
  // Already loaded — explicit flag (NOT firstElementChild, because the section
  // nav + jump-grid get appended by buildNav/buildJump and would mask an
  // empty placeholder, causing this short-circuit to skip the fetch).
  if (target.dataset.loaded === '1') { done(); return; }
  // Already in-flight from a previous click — chain on the same promise.
  if (contentInflight[id]) { contentInflight[id].then(done, done); return; }

  target.innerHTML = '<div class="wrap" style="padding:60px 24px;text-align:center;color:var(--muted);font-family:\'IBM Plex Mono\',monospace;font-size:12px;letter-spacing:0.1em">LOADING&hellip;</div>';

  var p = fetch('content/' + target.dataset.content + '.html', { credentials: 'omit' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })
    .then(function (html) {
      target.innerHTML = html;
      target.dataset.loaded = '1';
      // Now that .wrap exists, build the per-section prev/next nav and
      // jump-grid. sectionNav exposes this on window for exactly this case.
      if (typeof window.buildSectionChrome === 'function') {
        window.buildSectionChrome(target);
      }
    });

  contentInflight[id] = p;
  p.then(function () { delete contentInflight[id]; done(); },
    function (err) {
      delete contentInflight[id];
      target.innerHTML = '<div class="wrap" style="padding:60px 24px;text-align:center"><b style="color:var(--bear);font-size:1rem">Failed to load this section</b><br><span style="color:var(--muted);font-size:13px;font-family:\'IBM Plex Mono\',monospace">' + (err && err.message ? err.message : 'Network error') + '</span><br><br><button type="button" onclick="(function(){var t=document.getElementById(\'' + id + '\');if(t){t.innerHTML=\'\';loadSectionContent(\'' + id + '\');}})()" style="background:var(--bull);color:#fff;border:0;padding:10px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">Retry</button></div>';
      done();
    });
}

function show(id, btn) {
  // Pause swing-analyzer live polling the moment the user navigates
  // away from the swing tab — no point burning Upstox quota fetching
  // LTPs for a chart the user can't see. Runs synchronously before
  // the loadSectionContent callback so the timer is killed even if
  // the new tab's content takes a moment to fetch.
  if (id !== 'swing' && typeof window.swingDeactivate === 'function') {
    try { window.swingDeactivate(); } catch (_) {}
  }
  // Same idea for the Intraday Recommendation module on the Paper
  // Trading tab — when the user navigates away we stop the on-bar-
  // close watcher so we're not burning API calls in the background.
  if (id !== 'live' && typeof window.intradayDeactivate === 'function') {
    try { window.intradayDeactivate(); } catch (_) {}
  }
  // Intraday Trade tab (separate, self-contained chart workspace) — stop
  // its live poller when navigating away so it doesn't burn API calls in
  // the background. Mirrors the swing / intraday deactivate guards above.
  if (id !== 'intraday-trade' && typeof window.itDeactivate === 'function') {
    try { window.itDeactivate(); } catch (_) {}
  }
  document.querySelectorAll('.sec').forEach(function (s) { s.classList.remove('active'); });
  document.querySelectorAll('.ntabs .tab').forEach(function (t) {
    if (!t.classList.contains('tab-group')) { t.classList.remove('active'); }
  });
  var target = document.getElementById(id);
  if (target) { target.classList.add('active'); }
  if (btn && !btn.classList.contains('tab-group')) { btn.classList.add('active'); }
  syncGroupActive();
  if (isSidebarMode()) {
    expandActiveGroup();
    closeMobileDrawer();
  } else {
    closeAllGroups();
  }
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', '#' + id);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Lazy-fetch the section's content if it's external. Anything that depends
  // on per-section DOM (chart elements, calc inputs, etc.) must run AFTER
  // content lands — those elements only exist once content/<id>.html is in.
  loadSectionContent(id, function () {
    if (id === 'live') {
      // The paper-trade module loaded its state from localStorage at
      // DOMContentLoaded but its render call no-op'd because the
      // pt-* elements weren't in the DOM yet. Re-render now that
      // they are — restores Open Positions, Trade History, Stats,
      // Equity, etc. without requiring a BUY click to trigger them.
      if (typeof window.ptRenderAll === 'function') {
        try { window.ptRenderAll(); } catch (_) {}
      }
      if (typeof window.ptRenderPauseBanner === 'function') {
        try { window.ptRenderPauseBanner(); } catch (_) {}
      }
      if (typeof window.tvReload === 'function') {
        var hasToken = false;
        try { hasToken = !!(localStorage.getItem('upstox_token') || '').trim(); } catch (_) { hasToken = false; }
        var alreadyReady = !!(window.tvState && window.tvState.chartReady);
        if (hasToken && !alreadyReady) { setTimeout(window.tvReload, 50); }
      }
      // Start the Intraday Recommendation module — it will auto-detect
      // whether a token is configured (no token → friendly empty state,
      // no API calls). Safe to call on every show('live') because
      // activate() is idempotent (it just flips STATE.active=true and
      // restarts the on-bar-close watcher).
      if (typeof window.intradayActivate === 'function') {
        try { window.intradayActivate(); } catch (_) {}
      }
    }
    // Intraday Trade tab — start its self-contained chart + live poller
    // once the lazy content has landed. Idempotent (activate just flips a
    // flag + (re)starts the poller), so safe to call on every show().
    if (id === 'intraday-trade' && typeof window.itActivate === 'function') {
      try { window.itActivate(); } catch (_) {}
    }
    if (id === 'calc' && typeof window.seedCalcOutputs === 'function') {
      window.seedCalcOutputs();
    }
    // Refresh the connection status the moment the API-setup HTML lands.
    // The hashchange listener in api-setup.js fires on a fixed 150ms
    // timeout, which loses a race against the lazy content fetch on the
    // FIRST visit (DOM not present yet → _apiSetupRefresh bails on the
    // null #api-setup-status, leaving the static "Not Connected" markup).
    // Calling it here — after loadSectionContent resolves — guarantees the
    // elements exist, so a saved token reflects "Connected" without a reload.
    if (id === 'api-setup' && typeof window._apiSetupRefresh === 'function') {
      try { window._apiSetupRefresh(); } catch (_) {}
    }
    // Wire up the Swing Trade Analyzer the moment its HTML lands.
    // The module is registered at page load but its event handlers
    // need #sw-search etc. to exist — those only appear once the
    // lazy content fetch completes. swingWire is idempotent (dataset
    // flag guard) so calling it on every show('swing') is safe.
    if (id === 'swing') {
      if (typeof window.swingWire === 'function') {
        try { window.swingWire(); } catch (_) {}
      }
      // Resume live polling for the swing chart. Safe to call even
      // if no analysis is loaded yet — swingActivate() no-ops in
      // that case and the first analyze() will pick up the active
      // flag and start polling itself.
      if (typeof window.swingActivate === 'function') {
        try { window.swingActivate(); } catch (_) {}
      }
    }
  });
}

function toggleGroup(trigger, ev) {
  if (ev) { ev.stopPropagation(); }
  // If sidebar is collapsed (icons-only mode), first expand it, then open the group.
  if (document.body.classList.contains('sidebar-collapsed')) {
    toggleSidebar(true);
    var group = trigger.parentElement;
    setTimeout(function () {
      closeAllGroups();
      group.classList.add('open');
    }, 50);
    return;
  }
  var group = trigger.parentElement;
  var willOpen = !group.classList.contains('open');
  closeAllGroups();
  if (willOpen) { group.classList.add('open'); }
}

function showFromHash() {
  var hash = (window.location.hash || '').replace('#', '');
  if (!hash) return;
  // Old bookmarked URL — section was removed and replaced with a modal
  if (hash === 'connect') {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', '#api-setup');
    }
    show('api-setup');
    return;
  }
  var target = document.getElementById(hash);
  if (!target) return;
  var btn = document.querySelector('.sub .tab[onclick*="show(\'' + hash + '\'"]')
    || document.querySelector('.ntabs > .tab[onclick*="show(\'' + hash + '\'"]');
  show(hash, btn);
}

document.addEventListener('DOMContentLoaded', function () {
  showFromHash();
  syncGroupActive();
  if (isSidebarMode()) { expandActiveGroup(); }
});
window.addEventListener('hashchange', showFromHash);

document.addEventListener('click', function (e) {
  if (isSidebarMode()) return;
  if (!e.target.closest('.ngroup')) { closeAllGroups(); }
});

/* ═════════ UX: progress bar, back-to-top, palette, shortcuts ═════════ */

function onScroll() {
  var doc = document.documentElement;
  var h = doc.scrollHeight - doc.clientHeight;
  var pct = h > 0 ? (doc.scrollTop / h) * 100 : 0;
  var bar = document.getElementById('progressBar');
  if (bar) bar.style.width = pct + '%';
  var btn = document.getElementById('toTop');
  if (btn) btn.classList.toggle('visible', doc.scrollTop > 420);
}
window.addEventListener('scroll', onScroll, { passive: true });

function scrollTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

/* Command palette */
var PALETTE_INDEX = null;
function buildPaletteIndex() {
  var idx = [];
  var seen = {};
  document.querySelectorAll('.ntabs .tab[onclick*="show("], .sub .tab[onclick*="show("]').forEach(function (btn) {
    var m = btn.getAttribute('onclick').match(/show\('([^']+)'/);
    if (!m) return;
    var id = m[1]; if (seen[id]) return; seen[id] = 1;
    var sec = document.getElementById(id);
    if (!sec) return;
    var h2 = sec.querySelector('.shead h2');
    var title = h2 ? (h2.childNodes[0] && h2.childNodes[0].nodeValue || h2.textContent).trim() : btn.textContent.trim();
    var group = btn.closest('.ngroup');
    var groupLabel = group ? group.querySelector('.tab-group').textContent.trim().replace(/[\u25BE\u25BC].*$/, '').trim() : '';
    idx.push({ id: id, title: title, tag: 'Section', group: groupLabel, keywords: (title + ' ' + groupLabel + ' ' + id).toLowerCase() });
  });
  document.querySelectorAll('#glossary .ganchor, #glossary .gcard').forEach(function (el) {
    var name = el.getAttribute('data-term') || el.querySelector('b, h3, .gterm') && (el.querySelector('b, h3, .gterm').textContent.trim());
    if (name) idx.push({ id: 'glossary', title: name, tag: 'Glossary', group: 'Reference', keywords: name.toLowerCase() });
  });
  document.querySelectorAll('#strategy tbody tr td:first-child').forEach(function (td) {
    var name = (td.textContent || '').trim();
    if (name && name.length < 60) idx.push({ id: 'strategy', title: name, tag: 'Pattern', group: 'Master Table', keywords: name.toLowerCase() });
  });
  return idx;
}

var palettePrevFocus = null;
function openPalette() {
  if (!PALETTE_INDEX) PALETTE_INDEX = buildPaletteIndex();
  var o = document.getElementById('palette');
  palettePrevFocus = document.activeElement;
  o.classList.add('open');
  var input = document.getElementById('paletteInput');
  input.value = '';
  renderPalette('');
  setTimeout(function () { input.focus(); }, 10);
}
function closePalette() {
  document.getElementById('palette').classList.remove('open');
  if (palettePrevFocus && typeof palettePrevFocus.focus === 'function') {
    try { palettePrevFocus.focus(); } catch (_) { }
  }
  palettePrevFocus = null;
}

function renderPalette(q) {
  var list = document.getElementById('paletteList');
  var query = q.trim().toLowerCase();
  var items = PALETTE_INDEX;
  if (query) {
    items = items.filter(function (it) { return it.keywords.indexOf(query) !== -1; });
    items.sort(function (a, b) {
      var ai = a.keywords.indexOf(query), bi = b.keywords.indexOf(query);
      if (ai !== bi) return ai - bi;
      return a.title.length - b.title.length;
    });
  } else {
    items = items.filter(function (it) { return it.tag === 'Section'; });
  }
  items = items.slice(0, 40);
  if (!items.length) { list.innerHTML = '<div class="palette-empty">No results for &ldquo;' + escapeHtml(query) + '&rdquo;</div>'; return; }
  list.innerHTML = items.map(function (it, i) {
    return '<div class="palette-item' + (i === 0 ? ' selected' : '') + '" data-id="' + it.id + '" role="option">'
      + '<div class="palette-item-text">'
      + '<div class="palette-item-title">' + escapeHtml(it.title) + '</div>'
      + (it.group ? '<div class="palette-item-meta">' + escapeHtml(it.group) + '</div>' : '')
      + '</div>'
      + '<span class="palette-item-tag">' + it.tag + '</span>'
      + '</div>';
  }).join('');
  list.querySelectorAll('.palette-item').forEach(function (el) {
    el.addEventListener('click', function () { paletteSelect(el.getAttribute('data-id')); });
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

function paletteSelect(id) {
  closePalette();
  var btn = document.querySelector('.ntabs .tab[onclick*="show(\'' + id + '\'"], .sub .tab[onclick*="show(\'' + id + '\'"]');
  if (btn) { btn.click(); } else { show(id, null); }
  setTimeout(function () { window.scrollTo({ top: 0, behavior: 'smooth' }); }, 80);
}

function paletteNav(dir) {
  var items = Array.prototype.slice.call(document.querySelectorAll('.palette-item'));
  if (!items.length) return;
  var i = items.findIndex(function (e) { return e.classList.contains('selected'); });
  items.forEach(function (e) { e.classList.remove('selected'); });
  var n = (i + dir + items.length) % items.length;
  if (i < 0) n = dir > 0 ? 0 : items.length - 1;
  items[n].classList.add('selected');
  items[n].scrollIntoView({ block: 'nearest' });
}

document.addEventListener('DOMContentLoaded', function () {
  var input = document.getElementById('paletteInput');
  if (input) input.addEventListener('input', function () { renderPalette(input.value); });
  onScroll();
});

/* Shortcuts modal */
var shortcutsPrevFocus = null;
function openShortcuts() {
  shortcutsPrevFocus = document.activeElement;
  document.getElementById('shortcutsModal').classList.add('open');
}
function closeShortcuts() {
  document.getElementById('shortcutsModal').classList.remove('open');
  if (shortcutsPrevFocus && typeof shortcutsPrevFocus.focus === 'function') {
    try { shortcutsPrevFocus.focus(); } catch (_) { }
  }
  shortcutsPrevFocus = null;
}

/* Global keyboard */
document.addEventListener('keydown', function (e) {
  var palette = document.getElementById('palette');
  var shortcuts = document.getElementById('shortcutsModal');
  var paletteOpen = palette && palette.classList.contains('open');
  var shortcutsOpen = shortcuts && shortcuts.classList.contains('open');
  var tag = (e.target && e.target.tagName) || '';
  var inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);

  if (e.key === 'Escape') {
    if (paletteOpen) { closePalette(); return; }
    if (shortcutsOpen) { closeShortcuts(); return; }
    var nav = document.querySelector('.nav');
    if (nav && nav.classList.contains('drawer-open')) { closeMobileDrawer(); return; }
    closeAllGroups();
    return;
  }

  if (paletteOpen) {
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteNav(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); paletteNav(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      var sel = document.querySelector('.palette-item.selected');
      if (sel) paletteSelect(sel.getAttribute('data-id'));
      return;
    }
    return;
  }

  if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); openPalette(); return; }
  if (inInput) return;

  if (e.key === '/') { e.preventDefault(); openPalette(); return; }
  if (e.key === '?') { e.preventDefault(); shortcutsOpen ? closeShortcuts() : openShortcuts(); return; }
  if (e.key === 't' || e.key === 'T') { if (!e.metaKey && !e.ctrlKey && !e.altKey) { toggleTheme(); return; } }
  if (e.key === 'g' || e.key === 'G') { if (!e.metaKey && !e.ctrlKey && !e.altKey) { scrollTop(); return; } }

  if (!(e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.ntabs .tab:not(.tab-group), .sub .tab'));
  var activeIdx = tabs.findIndex(function (t) { return t.classList.contains('active'); });
  if (activeIdx < 0) return;
  var nextIdx = e.key === 'ArrowRight'
    ? (activeIdx + 1) % tabs.length
    : (activeIdx - 1 + tabs.length) % tabs.length;
  tabs[nextIdx].click();
});
