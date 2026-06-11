// Live chart module — Lightweight Charts v5 wrapper, Upstox V3 WebSocket
// real-time feed (protobuf) + V2/V3 historical fetch + HTTP LTP fallback,
// market-hours detection, indicators / drawings / layouts, self-diagnostics.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script
// src> in the SAME document position (classic script), so tvReload /
// tvSetTimeframe / isMarketOpen / nextOpenLabel / processSpotLtp and the
// rest stay global for the inline handlers in content/live.html, with
// unchanged init timing. Cross-module references (paper-trade / chain) are
// call-time only.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

(function liveChartModule() {
  // TradingView Lightweight Charts v5 — minimal, performant candlestick
  // charting library with indicators and drawing tools plugin.
  var LWC_SRC = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
  var PROTOBUF_CDN = 'https://cdn.jsdelivr.net/npm/protobufjs@7.4.0/dist/protobuf.min.js';
  // Build marker — if you're chasing a "is my browser running the new
  // code?" question, look for this exact line in the JS console on page
  // load. If you don't see it, your browser is serving an SW-cached
  // copy of an older HTML; Cmd-Shift-R (or DevTools → Application →
  // Service Workers → Unregister) will rebuild against the latest.
  console.log('%c[Trading Studio] build v82-2026-05-27-lwc-phase1', 'color:#218ef7;font-weight:600');
  var INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
  // Routing strategy for Upstox API calls:
  //
  //   1. Cloudflare Worker (highest priority, set via localStorage)
  //      Routes through CF's edge IPs — bypasses Upstox's per-IP
  //      rate-limiter (Error 1015) entirely. Set with:
  //        localStorage.setItem('cf_worker_url',
  //          'https://trading-studio-proxy.<user>.workers.dev');
  //      See cloudflare-worker.js for the worker source + deploy steps.
  //
  //   2. Local proxy (server.py), auto-detected on localhost.
  //      Same-origin → no CORS preflight. Server-side retries absorb
  //      wifi blips. Doesn't help with per-IP throttling (still your IP).
  //
  //   3. Direct calls to api.upstox.com (everything else — file://,
  //      GitHub Pages, PWA install on phone where server.py isn't
  //      running and no worker is configured).
  // Allow setting / clearing the worker via URL query param so the
  // user doesn't have to fight Chrome's "allow pasting" guard in the
  // DevTools console. Visit:
  //   ...?cf_worker=https://trading-studio-proxy.<user>.workers.dev
  // to enable, or:
  //   ...?cf_worker=clear
  // to remove. The setting is persisted to localStorage and the URL
  // param is stripped from history so refreshes are clean.
  (function () {
    try {
      var params = new URLSearchParams(location.search || '');
      if (!params.has('cf_worker')) return;
      var v = (params.get('cf_worker') || '').trim();
      if (v === 'clear' || v === '' || v === 'off') {
        localStorage.removeItem('cf_worker_url');
        console.log('[chart] cleared CF Worker URL via ?cf_worker=clear');
      } else {
        localStorage.setItem('cf_worker_url', v.replace(/\/+$/, ''));
        console.log('[chart] set CF Worker URL via query param:', v);
      }
      // Strip the param so the URL is clean on next reload.
      params.delete('cf_worker');
      var clean = location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash;
      history.replaceState(null, '', clean);
    } catch (_) { /* private mode / very old browser — silently noop */ }
  })();
  var CF_WORKER_URL = (function () {
    try { return (localStorage.getItem('cf_worker_url') || '').trim().replace(/\/+$/, ''); }
    catch (_) { return ''; }
  })();
  var USE_LOCAL_PROXY = !CF_WORKER_URL && (function () {
    try {
      var h = (location.hostname || '').toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local');
    } catch (_) { return false; }
  })();
  var V2, V3;
  if (CF_WORKER_URL) {
    V2 = CF_WORKER_URL + '/api/v2';
    V3 = CF_WORKER_URL + '/api/v3';
    console.log('[chart] using Cloudflare Worker proxy:', CF_WORKER_URL);
  } else if (USE_LOCAL_PROXY) {
    V2 = '/api/v2';
    V3 = '/api/v3';
    console.log('[chart] using local proxy /api/v2/* /api/v3/* (server.py)');
  } else {
    V2 = 'https://api.upstox.com/v2';
    V3 = 'https://api.upstox.com/v3';
  }
  // Kept for backwards-compat with diagnostic raw-results table.
  var USE_PROXY = !!(CF_WORKER_URL || USE_LOCAL_PROXY);

  // ── Angel One SmartAPI (experimental, Stage 1: charts only) ──
  // The browser cannot call apiconnect.angelone.in directly (CORS), and the
  // SmartAPI key must never live in the browser — so Angel One only works
  // through the local server.py proxy (/angel/*). Empty elsewhere, which
  // makes getDataSource()==='angel' fail fast with a clear message.
  var ANGEL_BASE = USE_LOCAL_PROXY ? '/angel' : '';
  // Nifty 50 spot index on Angel One (exchange NSE, symboltoken 99926000).
  var ANGEL_INSTRUMENT = { exchange: 'NSE', symboltoken: '99926000' };
  // App timeframe key -> SmartAPI interval enum.
  var ANGEL_INTERVAL = {
    '1m': 'ONE_MINUTE', '3m': 'THREE_MINUTE', '5m': 'FIVE_MINUTE',
    '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE', '1h': 'ONE_HOUR', '1d': 'ONE_DAY'
  };
  // ── One-time data-source reset ──────────────────────────────────────
  // Upstox is the ONLY default. An earlier build let the experimental
  // Angel One toggle (in API Setup) persist a global 'data_source=angel'
  // flag that silently affected BOTH the live chart AND the swing analyzer.
  // This one-shot migration clears any stuck selection back to Upstox so a
  // stale 'angel' choice can never surface data without an explicit pick.
  // Guarded by a flag → it runs exactly once; afterwards a deliberate Angel
  // selection persists normally. Fails safe (any error → leaves default).
  (function _resetDataSourceOnce() {
    try {
      if (localStorage.getItem('data_source_reset_v1') === '1') return;
      localStorage.removeItem('data_source');
      localStorage.setItem('data_source_reset_v1', '1');
    } catch (_) {}
  })();
  function getDataSource() {
    try {
      return (localStorage.getItem('data_source') || 'upstox').toLowerCase() === 'angel'
        ? 'angel' : 'upstox';
    } catch (_) { return 'upstox'; }
  }
  function getAngelToken() {
    try { return (localStorage.getItem('angel_one_token') || '').trim(); }
    catch (_) { return ''; }
  }
  // SmartAPI wants IST "yyyy-MM-dd HH:mm" — format explicitly in Asia/Kolkata
  // so it is correct regardless of the user's machine timezone.
  function fmtAngelDate(d) {
    var parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(d);
    var g = function (t) { var x = parts.find(function (o) { return o.type === t; }); return x ? x.value : ''; };
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute');
  }
  window.tvGetDataSource = getDataSource;

  // Timeframe config: { unit, interval, bucketMs, historyDays }
  var TF = {
    '1m': { unit: 'minutes', interval: '1', bucketMs: 60 * 1000, historyDays: 5 },
    '3m': { unit: 'minutes', interval: '3', bucketMs: 3 * 60 * 1000, historyDays: 10 },
    '5m': { unit: 'minutes', interval: '5', bucketMs: 5 * 60 * 1000, historyDays: 15 },
    '15m': { unit: 'minutes', interval: '15', bucketMs: 15 * 60 * 1000, historyDays: 30 },
    '30m': { unit: 'minutes', interval: '30', bucketMs: 30 * 60 * 1000, historyDays: 60 },
    '1h': { unit: 'hours', interval: '1', bucketMs: 60 * 60 * 1000, historyDays: 90 },
    '1d': { unit: 'days', interval: '1', bucketMs: 24 * 60 * 60 * 1000, historyDays: 365 }
  };

  // Indicator catalogue. `stack:true` overlays on the candle pane (e.g.
  // moving averages on top of price); otherwise creates a separate pane
  // below (volume, MACD, RSI, etc.). `defaultParams` and `paramLabels`
  // drive the per-indicator settings panel (gear icon next to the row);
  // `custom:true` marks indicators with baked-in params (CPR, PDHL,
  // SMA44). Custom indicators skip the gear icon.
  var INDICATOR_DEFS = {
    MA:    { label: 'MA',                stack: true,  group: 'overlay', defaultParams: [5, 10, 30, 60], paramLabels: ['Period 1', 'Period 2', 'Period 3', 'Period 4'] },
    EMA:   { label: 'EMA',               stack: true,  group: 'overlay', defaultParams: [6, 12, 20],     paramLabels: ['Period 1', 'Period 2', 'Period 3'] },
    SMA44: { label: 'SMA 44',            stack: true,  group: 'overlay', defaultParams: [44],            paramLabels: ['Period'], custom: true },
    BOLL:  { label: 'Bollinger Bands',   stack: true,  group: 'overlay', defaultParams: [20, 2],         paramLabels: ['Period', 'Std Dev'] },
    SAR:   { label: 'Parabolic SAR',     stack: true,  group: 'overlay', defaultParams: [2, 2, 20],      paramLabels: ['Step %', 'Max %', 'Min'] },
    CPR:   { label: 'Central Pivot Range (CPR)',       stack: true,  group: 'overlay', custom: true },
    PDHL:  { label: 'Previous Day OHLC', stack: true,  group: 'overlay', custom: true },
    VOL:  { label: 'Volume',            stack: false, group: 'pane',    defaultParams: [5, 10, 20],     paramLabels: ['MA 1', 'MA 2', 'MA 3'] },
    MACD: { label: 'MACD',              stack: false, group: 'pane',    defaultParams: [12, 26, 9],     paramLabels: ['Fast', 'Slow', 'Signal'] },
    RSI:  { label: 'RSI',               stack: false, group: 'pane',    defaultParams: [6, 12, 24],     paramLabels: ['Period 1', 'Period 2', 'Period 3'] },
    KDJ:  { label: 'Stochastic KDJ',    stack: false, group: 'pane',    defaultParams: [9, 3, 3],       paramLabels: ['Period', 'K', 'D'] }
  };

  // Drawing catalogue. `name` is Klinecharts' built-in overlay id; click
  // an item and the chart enters draw-mode (next clicks place points).
  var DRAWING_DEFS = [
    { id: 'horizontalStraightLine', label: 'Horizontal Line',  glyph: '\u2500\u2500' },
    { id: 'segment',                label: 'Trendline',         glyph: '\u2571'       },
    { id: 'rayLine',                label: 'Ray',               glyph: '\u2192'       },
    { id: 'priceLine',              label: 'Price Level',       glyph: '\u22A2'       },
    { id: 'rectangle',              label: 'Rectangle',         glyph: '\u25AD'       },
    { id: 'fibonacciLine',          label: 'Fibonacci Retrace', glyph: '\u03C6'       },
    { id: 'parallelStraightLine',   label: 'Parallel Channel',  glyph: '\u2225'       },
    { id: 'verticalStraightLine',   label: 'Vertical Line',     glyph: '\u2502'       }
  ];

  // localStorage keys.
  //  - Drawings ARE persisted now via named layouts AND the dedicated
  //    autosave slot — the autosave runs (debounced) on any chart change
  //    so a reload never loses your work.
  //  - LAYOUT_STORAGE bumped v1 → v2 for the richer schema (theme,
  //    instrument, updatedAt, isDefault). migrateLayoutStorage() handles
  //    one-time migration of any v1 data the user already has.
  //  - LAYOUT_CURRENT_STORAGE tracks which named layout is currently
  //    "loaded" so Cmd+S / "Save" knows whether to update an existing
  //    layout or create a new one. Cleared when user clears all drawings
  //    + indicators (treated as a fresh canvas).
  //  - LAYOUT_AUTOSAVE_STORAGE holds the single auto-snapshot. It is
  //    overwritten in place — there's only ever one autosave at a time.
  var IND_STORAGE              = 'live_chart_indicators_v2';   // [string]
  var IND_PARAMS_STORAGE       = 'live_chart_ind_params_v1';   // {name:[p]}
  var LAYOUT_STORAGE           = 'live_chart_layouts_v2';      // [{name, ...}]
  var LAYOUT_STORAGE_LEGACY    = 'live_chart_layouts_v1';      // migrated then removed
  var LAYOUT_CURRENT_STORAGE   = 'live_chart_layout_current_v1';
  var LAYOUT_AUTOSAVE_STORAGE  = 'live_chart_layout_autosave_v1';
  var TF_STORAGE               = 'live_chart_tf_v1';           // last TF
  var DEFAULT_INDICATORS = ['VOL']; // first-load fallback if no default + no autosave

  function loadSavedTimeframe() {
    try {
      var saved = localStorage.getItem(TF_STORAGE);
      // Validate against the TF map below; fall back to 5m if the
      // saved value is unknown (e.g. user cleared a TF that no longer exists).
      if (saved && typeof TF !== 'undefined' && TF[saved]) return saved;
      if (saved && /^(1m|3m|5m|15m|30m|1h|1d)$/.test(saved)) return saved;
    } catch (_) {}
    return '5m';
  }

  var state = {
    chart: null,           // LightweightCharts chart instance
    timeframe: loadSavedTimeframe(),
    pollTimer: null,
    pollIntervalMs: 1000, // active poll cadence; throttled to 60s outside market hours
    candles: [],          // raw upstox candles: [iso, o, h, l, c, vol, oi]
    lwcLoaded: false,
    chartReady: false,
    fetchAbort: null,     // AbortController for the in-flight historical fetch (cancelled on rapid TF switches)
    loadSeq: 0,           // monotonic counter so a stale loadAndRender result can detect it's stale
    lastErr: null,
    activeIndicators: {}, // { indicatorName: paneId } for currently-mounted indicators
    indicatorParams: {},  // { indicatorName: [calcParams...] } user-customised periods etc.
    indicatorSeries: {},  // { indicatorName: [series1, series2, ...] } — LWC series refs for cleanup
    customIndicatorsRegistered: false, // ensures CPR/PDHL register exactly once per page
    pendingLayout: null,  // deferred layout-apply when load layout switches timeframes
    aggVolInflight: null, // AbortController for in-flight constituent-volume aggregation
    aggVolForTf: null,    // timeframe whose aggregated volumes are currently applied to state.candles
    aggVolDebounceTimer: null, // setTimeout id; debounces rapid TF switches before firing 100s of constituent fetches
    // Per-timeframe candle cache. Letting the user revisit a TF they
    // were just on (5m → 1m → back to 5m) hit the network round-trip
    // again was costing 1-2s per switch with no benefit — we already
    // fetched that exact data 3 seconds ago. Now we keep the candle
    // arrays in memory keyed by TF and render instantly on revisit;
    // a background fetch refreshes if the cache is older than the
    // freshness window. Cache is per-instrument so switching instruments
    // doesn't show stale candles from the wrong symbol.
    // Shape: { '<instrumentKey>|<tf>': { candles: [...], at: <ms> } }
    tfCache: {},
    // Klinecharts v9.8.x exposes getOverlayById(id) but NOT a method to
    // enumerate every overlay on the chart (no getOverlay() / getOverlays()).
    // To save / clear / restore drawings reliably we keep our own list of
    // every overlay id we've created. Maintained by trackOverlay() /
    // untrackOverlay() and the onDrawEnd / onRemoved overlay callbacks.
    activeOverlayIds: [],  // [{ id: string, name: string }]
    // Day-boundary separators (vertical dotted lines at the first candle
    // of each new IST trading day, à la TradingView session breaks).
    // Kept in a SEPARATE list from activeOverlayIds so they:
    //   - never appear in saved layouts / autosave
    //   - aren't removed by "Clear drawings"
    //   - aren't targeted by the Delete-key handler
    //   - aren't visible in any UI list of user drawings
    // Repopulated from scratch on every applyChartData success.
    dayMarkersPrimitive: null, // LWC v5 series markers primitive (detach to clear)
    daySeparatorIds: [],   // string[]
    // Id of the overlay the user has currently selected (clicked on its
    // handles). Updated by overlay onSelected/onDeselected callbacks and
    // consumed by the global Delete/Backspace key handler so a tap of
    // the delete key removes the selected drawing — same UX as Upstox /
    // TradingView.
    drawingManager: null,  // LightweightChartsDrawing.DrawingManager instance
    selectedOverlayId: null,
    // Single-shot guard so we only attach the document-level keyboard
    // listener once per page lifetime, no matter how many times the
    // chart re-initialises (timeframe switches, theme reloads, etc.).
    keyDeleteWired: false,
    // Name of the layout that's currently "loaded" (last saved or last
    // applied). Used by Cmd+S / the "Save" button to know whether to
    // overwrite an existing layout or fall through to "Save As". Null
    // means the user has an unnamed working draft.
    currentLayoutName: null,
    // Autosave bookkeeping. The interval timer ticks every
    // AUTOSAVE_INTERVAL_MS as a safety net; the debounce timer fires
    // shortly after any user change. Both write to the same single
    // LAYOUT_AUTOSAVE_STORAGE slot, so only the most recent state is kept.
    autosaveDebounceTimer: null,
    autosaveIntervalTimer: null,
    lastAutosaveTs: 0,
    autosaveInitialApplied: false,
    // Single-shot guard for the Cmd/Ctrl+S global shortcut. Same reasoning
    // as keyDeleteWired.
    keySaveWired: false,
    // Re-entrancy guard for silentRefetch(): pollTick can fire it on a
    // gap-detected boundary, but we don't want a second poll a second
    // later kicking off a duplicate fetchHistorical.
    silentRefetchInFlight: false,
    // Wall-clock of the last successful silentRefetch / loadAndRender —
    // used by pollTick to schedule a hands-off periodic resync once a
    // minute so authoritative Upstox OHLCV (volume, true open) replaces
    // any LTP-patched local state. Catches missed ticks from background
    // tab throttling without restarting the whole loader.
    lastSyncTs: 0,
    // ── WebSocket real-time feed ──
    ws: null,
    wsConnected: false,
    wsReconnectTimer: null,
    wsReconnectAttempt: 0,
    wsFeedResponseType: null,
    wsSyncTimer: null
  };

  // Autosave is debounced (snaps soon after any change) and additionally
  // ticks on an interval as a fallback. Tuned to feel instantaneous in
  // the dropdown without thrashing localStorage.
  var AUTOSAVE_DEBOUNCE_MS = 1200;
  var AUTOSAVE_INTERVAL_MS = 30000;

  function $(id) { return document.getElementById(id); }
  function getToken() { return localStorage.getItem('upstox_token') || ''; }

  // Load data/config.json (persists across browser data clears). It carries
  // the Upstox token AND tunable knobs like the swing price band, so it is
  // the single source of truth for both. We expose the parsed object on
  // window.APP_CONFIG and forward it to any module that registered an apply
  // hook (e.g. the swing analyzer reads swing_price_band from here). The
  // fetch resolves after all synchronous module IIFEs have evaluated and
  // registered their hooks, so the hooks are guaranteed to exist by then.
  (function _loadConfig() {
    fetch('data/config.json', { credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        if (!cfg) return;
        window.APP_CONFIG = cfg;
        if (cfg.upstox_token) {
          var existing = getToken();
          if (!existing) {
            try {
              localStorage.setItem('upstox_token', cfg.upstox_token);
              if (typeof window._swUpdateApiPill === 'function') window._swUpdateApiPill();
              if (typeof window._apiSetupRefresh === 'function') window._apiSetupRefresh();
            } catch (_) {}
          }
        }
        // Angel One JWT — stored for upcoming broker support. Not yet wired
        // into any live-data path, so we only persist it (never overwrite a
        // token the user pasted in this session).
        if (cfg.angel_one_token) {
          try {
            var existingAngel = (localStorage.getItem('angel_one_token') || '').trim();
            if (!existingAngel) {
              localStorage.setItem('angel_one_token', cfg.angel_one_token);
              if (typeof window._apiSetupRefresh === 'function') window._apiSetupRefresh();
            }
          } catch (_) {}
        }
        if (typeof window._swApplyConfig === 'function') {
          try { window._swApplyConfig(cfg); } catch (_) {}
        }
      })
      .catch(function () {});
  })();

  function setStatus(kind, text) {
    var pill = $('tv-status'), txt = $('tv-status-text');
    if (!pill || !txt) return;
    pill.classList.remove('tv-live', 'tv-conn', 'tv-off', 'tv-notok', 'tv-closed', 'tv-throttled');
    if (kind === 'live') pill.classList.add('tv-live');
    else if (kind === 'conn') pill.classList.add('tv-conn');
    else if (kind === 'off') pill.classList.add('tv-off');
    else if (kind === 'closed') pill.classList.add('tv-closed');
    else if (kind === 'throttled') pill.classList.add('tv-throttled');
    else pill.classList.add('tv-notok');
    txt.textContent = text;
  }

  // ═══════════════════════════════════════════════════════════════════
  // SHARED UPSTOX RATE-LIMIT GATE  — moved out to scripts/upstox-rate-limit.js
  // ═══════════════════════════════════════════════════════════════════
  // The _upstox* rate-limiter + token bucket used to live here, but it is
  // account-level infrastructure shared by EVERY Upstox caller (chart,
  // paper-trade, swing scan, option chain, intraday tab) — not chart logic.
  // It was extracted (2026-06-07) into its own standalone file loaded BEFORE
  // this module so the Options/Live tab can be removed without taking the
  // swing + intraday throttling down with it. The globals (_upstoxIsThrottled
  // / _upstoxNote429 / _upstoxNoteOk / _upstoxBucket / _upstoxRateLimit) are
  // identical and defined by that file.
  //
  // The limiter has no DOM; it surfaces its cooldown countdown through this
  // OPTIONAL hook, which we register here so the chart's status pill still
  // shows "RATE LIMITED · Ns" exactly as before. When this module isn't
  // mounted, the hook is simply absent and the limiter logs to console only.
  window._upstoxStatusHook = function (state, label) {
    try { setStatus(state, label); } catch (_) { /* pill not mounted — non-fatal */ }
  };

  // ── Angel One rate limiter (getCandleData: 3/sec, 180/min, 5000/hr) ──
  // Same token-bucket design as the Upstox bucket, but paced for Angel's
  // tighter limits. RATE 2.5/sec (= 150/min) keeps comfortable headroom
  // under BOTH the per-second (3) and per-minute (180) caps; CAP 3 bounds
  // bursts to the hard per-second limit. Used by every Angel candle fetch
  // (chart + swing scan) so a bulk scan paces itself instead of tripping
  // Angel's rate gate. Shared on window so both modules use one budget.
  window._angelBucket = (function () {
    var RATE = 2.5;
    var CAP = 3;
    var tokens = CAP;
    var last = Date.now();
    function refill() {
      var now = Date.now();
      tokens = Math.min(CAP, tokens + (now - last) / 1000 * RATE);
      last = now;
    }
    return {
      tryAcquire: function () {
        refill();
        if (tokens >= 1) { tokens -= 1; return true; }
        return false;
      },
      acquire: async function () {
        while (true) {
          refill();
          if (tokens >= 1) { tokens -= 1; return; }
          var waitMs = Math.ceil((1 - tokens) / RATE * 1000);
          await new Promise(function (r) { setTimeout(r, waitMs + 20); });
        }
      }
    };
  })();

  function showLoader(html, opts) {
    var l = $('tv-loading');
    if (!l) return;
    l.style.display = 'flex';
    if (html) $('tv-loading-text').innerHTML = html;
    var sp = $('tv-spinner');
    if (sp) sp.style.display = (opts && opts.noSpinner) ? 'none' : 'block';
  }
  function hideLoader() {
    var l = $('tv-loading');
    if (l) l.style.display = 'none';
  }

  function fmtDate(d) {
    var ist = new Date(d.getTime() + 19800000);
    var y = ist.getUTCFullYear(), m = String(ist.getUTCMonth() + 1).padStart(2, '0'), day = String(ist.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function isLight() { return document.documentElement.getAttribute('data-theme') === 'light'; }

  // LWC chart options — theme-aware colors for background, grid,
  // crosshair, and candlestick up/down.
  function getLWCOptions() {
    var light = isLight();
    var bg    = light ? '#ffffff' : '#0f1422';
    var text  = light ? '#1e293b' : '#cbd5e1';
    var grid  = light ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.10)';
    var cross = light ? '#0f1422' : '#cbd5e1';
    var isIntraday = (state.timeframe !== '1d');
    return {
      layout: { background: { type: 'solid', color: bg }, textColor: text },
      grid: {
        vertLines: { color: grid, style: 3 },
        horzLines: { color: grid, style: 3 }
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: grid },
      timeScale: {
        borderColor: grid,
        timeVisible: isIntraday,
        secondsVisible: false
      }
    };
  }

  function getLWCCandleOptions() {
    return {
      upColor: '#09a86e', downColor: '#c91f3a',
      borderUpColor: '#09a86e', borderDownColor: '#c91f3a',
      wickUpColor: '#09a86e', wickDownColor: '#c91f3a'
    };
  }

  // ── Load Lightweight Charts library lazily ──
  function loadLWC(cb) {
    if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) {
      state.lwcLoaded = true;
      cb();
      return;
    }
    var s = document.createElement('script');
    s.src = LWC_SRC;
    s.async = true;
    s.onload = function () {
      state.lwcLoaded = true;
      cb();
    };
    s.onerror = function () {
      setStatus('off', 'OFFLINE');
      showLoader('<b style="color:var(--bear)">&#10007; Could not load chart engine.</b><br>Check your internet connection.');
    };
    document.head.appendChild(s);
  }

  // ── Drawing tools plugin (lazy-loaded after LWC) ─────────────────
  var DRAWING_SRC = 'https://unpkg.com/lightweight-charts-drawing@0.1.1/dist/lightweight-charts-drawing.umd.js';

  function loadDrawingPlugin(cb) {
    if (typeof LightweightChartsDrawing !== 'undefined' && LightweightChartsDrawing.DrawingManager) {
      cb(); return;
    }
    var existing = document.querySelector('script[src="' + DRAWING_SRC + '"]');
    if (existing) {
      if (typeof LightweightChartsDrawing !== 'undefined') { cb(); return; }
      existing.addEventListener('load', cb);
      existing.addEventListener('error', function() { console.warn('[chart] Drawing plugin failed to load'); cb(); });
      return;
    }
    var s = document.createElement('script');
    s.src = DRAWING_SRC;
    s.async = true;
    s.onload = cb;
    s.onerror = function() { console.warn('[chart] Drawing plugin failed to load'); cb(); };
    document.head.appendChild(s);
  }

  function loadProtobuf(cb) {
    if (window.protobuf && window.protobuf.parse) { cb(); return; }
    var existing = document.querySelector('script[src="' + PROTOBUF_CDN + '"]');
    if (existing) {
      if (window.protobuf && window.protobuf.parse) { cb(); return; }
      existing.addEventListener('load', cb);
      existing.addEventListener('error', function () { console.warn('[ws] protobuf.js CDN failed'); cb(); });
      return;
    }
    var s = document.createElement('script');
    s.src = PROTOBUF_CDN;
    s.async = true;
    s.onload = cb;
    s.onerror = function () { console.warn('[ws] protobuf.js CDN failed'); cb(); };
    document.head.appendChild(s);
  }

  // ── Dead Klinecharts indicators removed (May 2026) ──────────────
  // registerCustomIndicators (CPR, PDHL, SMA44) and their
  // ensureCustomIndicators wrapper were Klinecharts-specific and are
  // no longer needed — both the live chart and swing chart now use
  // Lightweight Charts v5. The math for SMA/EMA is computed inline
  // in renderMainChart where needed.
  // Wrap fetch with one transient-network retry. "Failed to fetch" /
  // "NetworkError" usually means the browser couldn't even start the
  // request — DNS hiccup, wifi mid-roam, laptop just woke from sleep,
  // CORS preflight that got dropped. A single 600ms-spaced retry rescues
  // most of these without touching the UI; only persistent failures
  // bubble up as NO_DATA. AbortError is forwarded immediately because
  // it means the caller (e.g. a timeframe switch) deliberately cancelled.
  async function fetchWithRetry(url, options, signal) {
    // Exponential backoff: 4 attempts at 0 / 400 / 1200 / 2800 ms.
    // We learned the hard way that 1 retry at 600ms isn't enough when
    // the user's wifi / OS is briefly busy (mac wake-from-sleep, network
    // interface change, IPv6 route flap). 4 attempts spans ~4s total
    // which feels instant to the user but rescues every transient
    // failure we've actually seen in production.
    var attempts = 4;
    var backoffs = [0, 400, 1200, 2800];
    var lastErr = null;
    for (var i = 0; i < attempts; i++) {
      if (i > 0) await new Promise(function (r) { setTimeout(r, backoffs[i]); });
      if (signal && signal.aborted) {
        var ae0 = new Error('Aborted'); ae0.name = 'AbortError'; throw ae0;
      }
      try {
        // cache:'no-store' guarantees we never hand back a stale 401
        // and keeps each retry as a fresh request (no HTTP cache
        // confusion). The diagnostic uses the same option and works
        // 100% of the time, so we mirror it here.
        return await fetch(url, Object.assign({ cache: 'no-store' }, options, { signal: signal }));
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        lastErr = e;
        var msg = (e && e.message) || '';
        var transient = /Failed to fetch|NetworkError|Load failed|network/i.test(msg);
        if (!transient || i === attempts - 1) break;
        console.warn('[chart] fetch transient error (attempt ' + (i + 1) + '/' + attempts + '), retrying:', msg, url);
      }
    }
    throw lastErr;
  }

  // ── Fetch intraday + recent historical candles ──
  // Accepts an optional AbortSignal so a rapid timeframe switch can
  // cancel an in-flight request and avoid stale data overwriting the
  // newer chart series. AbortError is re-thrown so the caller can
  // detect cancellation and skip rendering.
  //
  // Error surface (caller checks via err.message):
  //   NO_TOKEN          — no upstox token in localStorage
  //   UNAUTHORIZED      — 401/403 (token expired or wrong scope)
  //   OFFLINE           — navigator.onLine === false at fetch time
  //   NO_DATA           — both endpoints returned 200 with empty candles[]
  //   NO_DATA: <detail> — both endpoints failed; <detail> shows what we
  //                       actually saw (e.g. "hist 400 ..., intra net err")
  //                       so the user can paste it back instead of guessing.
  // ── Angel One candle adapter (Stage 1) ──
  // Returns the SAME [ts, o, h, l, c, v] array shape the Upstox path
  // returns, so the renderer / indicators need zero changes. POSTs to the
  // SmartAPI getCandleData endpoint via the local proxy. Throws on any
  // failure (fail-safe: caller shows the error rather than a guessed chart).
  async function fetchHistoricalAngel(signal) {
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) {
      throw new Error('API_PAUSED');
    }
    if (!ANGEL_BASE) throw new Error('ANGEL_PROXY_REQUIRED');
    var token = getAngelToken();
    if (!token) throw new Error('NO_ANGEL_TOKEN');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('OFFLINE');
    }
    var tf = TF[state.timeframe];
    var interval = ANGEL_INTERVAL[state.timeframe];
    if (!interval) throw new Error('ANGEL_TF_UNSUPPORTED: ' + state.timeframe);
    var to = new Date();
    var from = new Date();
    from.setDate(to.getDate() - tf.historyDays);
    var body = {
      exchange: ANGEL_INSTRUMENT.exchange,
      symboltoken: ANGEL_INSTRUMENT.symboltoken,
      interval: interval,
      fromdate: fmtAngelDate(from),
      todate: fmtAngelDate(to)
    };
    var url = ANGEL_BASE + '/rest/secure/angelbroking/historical/v1/getCandleData';
    console.log('[chart] fetchHistoricalAngel \u00B7 tf=' + state.timeframe + ' \u00B7 ' + JSON.stringify(body));
    // Pace against Angel's getCandleData rate cap (3/sec, 180/min).
    if (window._angelBucket) await window._angelBucket.acquire();
    var resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, signal);
    if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
    if (!resp.ok) {
      var errBody = '';
      try { errBody = (await resp.text()).slice(0, 240); } catch (_) {}
      throw new Error('NO_DATA: angel HTTP ' + resp.status + ' ' + errBody);
    }
    var d = await resp.json();
    // SmartAPI has TWO error envelopes: the app layer ({status:false,
    // errorcode, message}) and the API-gateway auth rejection
    // ({success:false, errorCode, message, data:""}). Treat both as errors
    // and surface the real message (e.g. "Invalid Token" / AG8001) instead
    // of a misleading "0 candles".
    if (!d || d.success === false || d.status === false) {
      var emsg = (d && (d.message || d.errorCode || d.errorcode)) || 'error';
      throw new Error('NO_DATA: angel ' + emsg);
    }
    // Only an array `data` is real candle data — the auth-reject envelope
    // ships data:"" (empty string), which must never be read as candles.
    var arr = (d && Array.isArray(d.data)) ? d.data : [];
    if (!arr.length) throw new Error('NO_DATA: angel returned 0 candles');
    var seen = {}, clean = [];
    arr.forEach(function (c) { var t = c[0]; if (!seen[t]) { seen[t] = 1; clean.push(c); } });
    clean.sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    console.log('[chart] angel fetched ' + clean.length + ' candles');
    return clean;
  }

  async function fetchHistorical(signal) {
    // Experimental broker switch — Angel One (charts only, Nifty index).
    if (getDataSource() === 'angel') return fetchHistoricalAngel(signal);
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) {
      throw new Error('API_PAUSED');
    }
    var token = getToken();
    if (!token) throw new Error('NO_TOKEN');
    // Cheap offline pre-flight: if the browser already knows the network
    // is down, don't waste a 30s timeout trying to reach api.upstox.com.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('OFFLINE');
    }
    var tf = TF[state.timeframe];
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var ikey = encodeURIComponent(INSTRUMENT_KEY);

    // Per-call diagnostics: status code (or 'net') and short body excerpt.
    // We surface these in the NO_DATA error message + console.warn so when
    // Upstox is rate-limiting / down / returning malformed JSON the user
    // sees the actual reason instead of a generic "no data".
    var diag = { hist: null, intra: null };

    var to = new Date();
    var from = new Date();
    from.setDate(to.getDate() - tf.historyDays);
    var histUrl = V3 + '/historical-candle/' + ikey + '/' + tf.unit + '/' + tf.interval + '/' + fmtDate(to) + '/' + fmtDate(from);
    // Upstox V3 supports the intraday endpoint for every unit it accepts
    // on the historical endpoint — INCLUDING days/1 (their docs even ship a
    // "Get current day data" example for /intraday/.../days/1). The earlier
    // `state.timeframe !== '1d'` guard predated that support and made the
    // 1D tab fall over entirely on days where Upstox's historical endpoint
    // returned an empty array for the index instrument (no fallback ⇒
    // NO_DATA error in the UI). Always include intraday now so today's
    // in-progress daily bar is fetched and we have a fallback if hist
    // returns 0 candles.
    var intraUrl = V3 + '/historical-candle/intraday/' + ikey + '/' + tf.unit + '/' + tf.interval;
    console.log('[chart] fetchHistorical \u00B7 tf=' + state.timeframe + ' \u00B7 hist=' + histUrl + ' \u00B7 intra=' + intraUrl);

    // Pure-function fetch helper: returns { candles, diagStr } or
    // throws AbortError / UNAUTHORIZED. Used twice below — once for
    // historical, once for intraday — so we can run both in parallel.
    //
    // RATE LIMIT WIRING (May 2026 fix): both 429 paths now feed
    // the global _upstoxNote429 gate AND every entry checks
    // _upstoxIsThrottled first. Before this fix, V3 historical
    // 429s were silently swallowed (returned empty candles +
    // diagStr like "429 …") while leaving the global gate clear,
    // so the next pollTick 2s later fired another identical
    // request → another 429 → cascade until the user noticed.
    // V2 LTP polls had this gate already; V3 historical didn't.
    async function fetchOne(url, kind) {
      if (window._upstoxIsThrottled && window._upstoxIsThrottled()) {
        return { candles: [], diagStr: 'throttled' };
      }
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      try {
        var resp = await fetchWithRetry(url, { headers: headers }, signal);
        if (resp.ok) {
          var d = await resp.json();
          var arr = (d && d.data && d.data.candles) || [];
          if (window._upstoxNoteOk) window._upstoxNoteOk();
          return { candles: arr, diagStr: 'ok ' + arr.length + 'c' };
        }
        if (resp.status === 401 || resp.status === 403) {
          throw new Error('UNAUTHORIZED');
        }
        if (resp.status === 429) {
          // Engage the global gate so the OTHER pollers (V2 LTP,
          // option-price batch, analyzer fetchAll, VIX, BN) all
          // back off in unison — Upstox's per-key budget is
          // shared across endpoints, so one 429 means everyone
          // needs to sit out the cooldown.
          if (window._upstoxNote429) window._upstoxNote429('chart-historical-' + kind);
          return { candles: [], diagStr: '429 throttled' };
        }
        var body = '';
        try { body = (await resp.text()).slice(0, 240); } catch (_) {}
        console.warn('[chart] ' + kind + ' fetch ' + resp.status + ' for', url, body);
        return { candles: [], diagStr: resp.status + ' ' + body };
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (e && e.message === 'UNAUTHORIZED') throw e;
        console.warn('[chart] ' + kind + ' fetch threw for', url, e);
        return { candles: [], diagStr: 'net ' + (e && e.message || 'err') };
      }
    }

    // Run hist + intra in PARALLEL — they're independent and Upstox
    // serves them from different endpoints. Sequential added ~200ms
    // of pure round-trip latency per timeframe switch for no reason.
    var promises = [fetchOne(histUrl, 'hist')];
    if (intraUrl) promises.push(fetchOne(intraUrl, 'intra'));
    var results = await Promise.all(promises);
    var allCandles = [];
    diag.hist = results[0].diagStr;
    allCandles = allCandles.concat(results[0].candles);
    if (results[1]) {
      diag.intra = results[1].diagStr;
      allCandles = allCandles.concat(results[1].candles);
    }

    if (!allCandles.length) {
      var detail = 'hist=' + (diag.hist || 'skipped');
      if (diag.intra != null) detail += ', intra=' + diag.intra;
      console.error('[chart] NO_DATA on ' + state.timeframe + ' — ' + detail);
      throw new Error('NO_DATA: ' + detail);
    }
    console.log('[chart] fetched ' + allCandles.length + ' candles (hist=' + diag.hist + (diag.intra != null ? ', intra=' + diag.intra : '') + ')');

    // dedupe by timestamp + sort ascending
    var seen = {};
    var clean = [];
    allCandles.forEach(function (c) {
      var t = c[0];
      if (!seen[t]) { seen[t] = 1; clean.push(c); }
    });
    clean.sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    return clean;
  }

  // ── Indian market-hours helpers (NSE/BSE: Mon-Fri, 09:15 - 15:30 IST) ──
  // Holiday-aware: checks against the official NSE equity-segment holiday
  // calendar so that holidays like Bakri Id, Diwali, etc. correctly return
  // false from isMarketOpen() and suppress all API polling.

  // NSE equity-segment trading holidays (YYYY-MM-DD strings in IST).
  // Source: NSE circulars CMTR65587 (2025) and CMTR71775 (2026).
  // Update annually when the new calendar is published (~Dec each year).
  var NSE_HOLIDAYS = [
    // 2025
    '2025-02-26','2025-03-14','2025-03-31','2025-04-10','2025-04-14',
    '2025-04-18','2025-05-01','2025-08-15','2025-08-27','2025-10-02',
    '2025-10-21','2025-10-22','2025-11-05','2025-12-25',
    // 2026
    '2026-01-15','2026-01-26','2026-03-03','2026-03-26','2026-03-31',
    '2026-04-03','2026-04-14','2026-05-01','2026-05-28','2026-06-26',
    '2026-09-14','2026-10-02','2026-10-20','2026-11-10','2026-11-24',
    '2026-12-25'
  ];
  var _nseHolidaySet = null;
  function isNseHoliday(dateStr) {
    if (!_nseHolidaySet) _nseHolidaySet = new Set(NSE_HOLIDAYS);
    return _nseHolidaySet.has(dateStr);
  }

  function nowIST() {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata', hour12: false,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    var p = fmt.formatToParts(new Date());
    var get = function (t) { var x = p.find(function (o) { return o.type === t; }); return x ? x.value : ''; };
    var y = get('year'), m = get('month'), d = get('day');
    return {
      weekday: get('weekday'),
      minOfDay: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10),
      dateStr: y + '-' + m + '-' + d
    };
  }

  function isTradingDay(dateStr, weekday) {
    if (weekday === 'Sat' || weekday === 'Sun') return false;
    return !isNseHoliday(dateStr);
  }

  // Open: Mon-Fri (non-holiday), 09:15 - 15:30 IST
  function isMarketOpen() {
    var t = nowIST();
    if (!isTradingDay(t.dateStr, t.weekday)) return false;
    return t.minOfDay >= (9 * 60 + 15) && t.minOfDay < (15 * 60 + 30);
  }

  // Is today a trading day (regardless of time)?
  function isTradingDayToday() {
    var t = nowIST();
    return isTradingDay(t.dateStr, t.weekday);
  }

  // Advance an IST Date object by N calendar days and return { dateStr, weekday }.
  function _advanceIST(baseDateStr, daysAhead) {
    var parts = baseDateStr.split('-');
    var d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    d.setUTCDate(d.getUTCDate() + daysAhead);
    var y = d.getUTCFullYear();
    var m = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return { dateStr: y + '-' + m + '-' + dd, weekday: dayNames[d.getUTCDay()] };
  }

  // Find the next trading day (skipping weekends + holidays), returns
  // { dateStr, weekday, daysAhead }. Starts from tomorrow (daysAhead=1).
  function _nextTradingDay(fromDateStr) {
    for (var i = 1; i <= 15; i++) {
      var next = _advanceIST(fromDateStr, i);
      if (isTradingDay(next.dateStr, next.weekday)) {
        return { dateStr: next.dateStr, weekday: next.weekday, daysAhead: i };
      }
    }
    return { dateStr: '', weekday: 'Mon', daysAhead: 1 };
  }

  function nextOpenLabel() {
    var t = nowIST();
    var todayTrading = isTradingDay(t.dateStr, t.weekday);
    if (todayTrading && t.minOfDay < 9 * 60 + 15) return 'opens at 09:15 IST today';
    var next = _nextTradingDay(t.dateStr);
    var holiday = isNseHoliday(t.dateStr) && t.weekday !== 'Sat' && t.weekday !== 'Sun';
    var prefix = holiday ? 'Holiday today \u2014 ' : '';
    return prefix + 'next open ' + next.weekday + ' ' + next.dateStr.slice(5) + ' 09:15 IST';
  }

  // ── Bucket-aligned timestamp for a new candle ──
  // Given a UTC epoch (seconds) and a bucket size (seconds), return the
  // start of the bucket that `epochSec` falls in, *aligned to the NSE/BSE
  // session*:
  //   - Intraday buckets (1m / 3m / 5m / 15m / 30m / 1h) align to 09:15 IST
  //     on the IST date of `epochSec`. So 5m buckets are 09:15, 09:20, …,
  //     and 15m buckets are 09:15, 09:30, 09:45, … — matching what
  //     Upstox, TradingView and Sensibull show.
  //   - Daily buckets align to IST midnight (Upstox's convention for daily
  //     candle timestamps).
  //
  // This replaces the old "lastT + bucketSec" math in pollTick which broke
  // across overnight / weekend gaps: after sleeping through a 17h gap, the
  // first poll of the new session would stamp today's candle with
  // yesterday-15:30. Now we always anchor to the *current* session.
  var IST_OFFSET_SEC = 19800;            // IST = UTC + 5:30
  var SESSION_OPEN_SEC = 9 * 3600 + 15 * 60; // 33300 sec from IST midnight
  function bucketStartSec(epochSec, bucketSec) {
    var ist = epochSec + IST_OFFSET_SEC;
    if (bucketSec >= 86400) {
      // Daily — align to IST midnight
      var istMidnightDaily = Math.floor(ist / 86400) * 86400;
      return istMidnightDaily - IST_OFFSET_SEC;
    }
    var istMidnight = Math.floor(ist / 86400) * 86400;
    var sessionStart = istMidnight + SESSION_OPEN_SEC;
    if (ist < sessionStart) {
      // Pre-market on the IST date: anchor to today's 09:15 IST
      return sessionStart - IST_OFFSET_SEC;
    }
    var alignedIst = sessionStart + Math.floor((ist - sessionStart) / bucketSec) * bucketSec;
    return alignedIst - IST_OFFSET_SEC;
  }

  // ── Convert Upstox candle → Lightweight Charts bar ──
  // Upstox row shape: [iso_string, open, high, low, close, volume, oi]
  // LWC candlestick: { time: unix_seconds, open, high, low, close }
  // LWC histogram:   { time: unix_seconds, value, color }
  function toKline(c) {
    var ms = new Date(c[0]).getTime();
    var tf = state.timeframe;
    var t;
    if (tf === '1d') {
      var ist = new Date(ms + IST_OFFSET_SEC * 1000);
      t = { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
    } else {
      t = Math.floor(ms / 1000) + IST_OFFSET_SEC;
    }
    return { time: t, open: +c[1], high: +c[2], low: +c[3], close: +c[4] };
  }
  function toVolume(c) {
    var ms = new Date(c[0]).getTime();
    var tf = state.timeframe;
    var t;
    if (tf === '1d') {
      var ist = new Date(ms + IST_OFFSET_SEC * 1000);
      t = { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
    } else {
      t = Math.floor(ms / 1000) + IST_OFFSET_SEC;
    }
    var chg = +c[4] - +c[1];
    return { time: t, value: +c[5] || 0, color: chg >= 0 ? 'rgba(9,168,110,0.4)' : 'rgba(201,31,58,0.4)' };
  }

  // ── Authoritative-spot price-line (LWC price line API) ─────────
  // Draws a dashed horizontal line at the authoritative LTP so the
  // user sees a consistent "current price" across TF switches.
  function updateAuthSpotPriceLine() {
    if (!state.chart || !state.chartReady || !state.candleSeries) return;
    var spot = (typeof window.paperTradeGetLastSpot === 'function')
      ? window.paperTradeGetLastSpot() : null;
    if (!isFinite(spot) || spot <= 0) return;

    var color = '#888888';
    if (state.candles && state.candles.length) {
      var lastOpen = +state.candles[state.candles.length - 1][1];
      if (isFinite(lastOpen)) {
        color = (spot >= lastOpen) ? '#09a86e' : '#c91f3a';
      }
    }

    if (state.authPriceLine) {
      try { state.candleSeries.removePriceLine(state.authPriceLine); }
      catch (_) {}
      state.authPriceLine = null;
    }
    state.authPriceLine = state.candleSeries.createPriceLine({
      price: spot,
      color: color,
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true
    });
  }

  function pinChartLastPriceToAuthLtp() {
    updateAuthSpotPriceLine();
  }

  // ═══════════════════════════════════════════════════════════════════
  // NIFTY 50 CONSTITUENT VOLUME AGGREGATION
  // ═══════════════════════════════════════════════════════════════════
  // Why this exists: Upstox returns volume=0 for NSE_INDEX|Nifty 50
  // because indices aren't tradeable (you can't buy "the index"; you can
  // only buy its constituent stocks or its futures contract). To show
  // meaningful volume on the chart we sum the volume of all 50 component
  // stocks at every timestamp — the same approach TradingView, Yahoo
  // Finance, Investing.com and Zerodha Kite use.
  //
  // Cost: 50 historical fetches (+50 intraday for non-daily timeframes)
  // the first time VOL is enabled per timeframe. Browsers throttle
  // outbound HTTP to ~6 concurrent per host, so the 100 calls run in
  // ~17 batches taking ~3-5s total. Results cached to localStorage
  // for 30 minutes; subsequent timeframe switches reuse the cache.
  //
  // CONSTITUENT LIST: Nifty 50 is rebalanced quarterly (March/September)
  // by NIFTY Indices. When a stock joins or leaves the index, refresh
  // this list from
  //   https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-50
  // The trading symbol is for human reference; the ISIN is what Upstox
  // uses to identify the instrument (`NSE_EQ|<ISIN>`).
  //
  // LIVE VOLUME LIMITATION: the 2-second LTP poll updates only price.
  // The current bar's volume stays at whatever the last aggregation
  // snapshot left it at; it doesn't tick up tick-by-tick. Re-toggle
  // VOL or switch timeframes to refresh. (A full live-volume poll
  // would need a separate batched-quotes call every few seconds — TODO
  // if you want intraday volume to grow in real time.)
  var NIFTY50_CONSTITUENTS = [
    ['RELIANCE',     'INE002A01018'],
    ['TCS',          'INE467B01029'],
    ['HDFCBANK',     'INE040A01034'],
    ['BHARTIARTL',   'INE397D01024'],
    ['ICICIBANK',    'INE090A01021'],
    ['INFY',         'INE009A01021'],
    ['SBIN',         'INE062A01020'],
    ['LT',           'INE018A01030'],
    ['ITC',          'INE154A01025'],
    ['HINDUNILVR',   'INE030A01027'],
    ['KOTAKBANK',    'INE237A01028'],
    ['HCLTECH',      'INE860A01027'],
    ['SUNPHARMA',    'INE044A01036'],
    ['MARUTI',       'INE585B01010'],
    ['AXISBANK',     'INE238A01034'],
    ['BAJFINANCE',   'INE296A01024'],
    ['ASIANPAINT',   'INE021A01026'],
    ['ULTRACEMCO',   'INE481G01011'],
    ['NTPC',         'INE733E01010'],
    ['NESTLEIND',    'INE239A01024'],
    ['WIPRO',        'INE075A01022'],
    ['POWERGRID',    'INE752E01010'],
    ['M&M',          'INE101A01026'],
    ['TATAMOTORS',   'INE155A01022'],
    ['ONGC',         'INE213A01029'],
    ['COALINDIA',    'INE522F01014'],
    ['TATASTEEL',    'INE081A01020'],
    ['TITAN',        'INE280A01028'],
    ['INDUSINDBK',   'INE095A01012'],
    ['TECHM',        'INE669C01036'],
    ['ADANIENT',     'INE423A01024'],
    ['HDFCLIFE',     'INE795G01014'],
    ['BAJAJFINSV',   'INE918I01026'],
    ['GRASIM',       'INE047A01021'],
    ['ADANIPORTS',   'INE742F01042'],
    ['SBILIFE',      'INE123W01016'],
    ['DRREDDY',      'INE089A01023'],
    ['JSWSTEEL',     'INE019A01038'],
    ['BAJAJ-AUTO',   'INE917I01010'],
    ['TATACONSUM',   'INE192A01025'],
    ['HEROMOTOCO',   'INE158A01026'],
    ['EICHERMOT',    'INE066A01021'],
    ['HINDALCO',     'INE038A01020'],
    ['APOLLOHOSP',   'INE437A01024'],
    ['CIPLA',        'INE059A01026'],
    ['SHRIRAMFIN',   'INE721A01013'],
    ['BEL',          'INE263A01024'],
    ['TRENT',        'INE849A01020'],
    ['JIOFIN',       'INE758E01017'],
    ['ETERNAL',      'INE758T01015']  // formerly ZOMATO; renamed Sep 2024
  ];
  var NIFTY50_KEYS = NIFTY50_CONSTITUENTS.map(function (c) { return 'NSE_EQ|' + c[1]; });

  // localStorage cache: { 'tf:fromDate|toDate': { '<timestamp>': totalVolume, _at: ms } }
  var AGG_VOL_CACHE_KEY = 'nifty50_aggvol_v1';
  var aggVolCache = {};
  try { aggVolCache = JSON.parse(localStorage.getItem(AGG_VOL_CACHE_KEY) || '{}') || {}; }
  catch (_) { aggVolCache = {}; }

  // ── Per-TF chart cache (May 2026 — persisted for off-hours) ──
  // Each entry: { candles: [...Upstox rows], at: ms timestamp }
  // Keyed by `INSTRUMENT_KEY + '|' + timeframe`. Persisted to
  // localStorage so reloads outside market hours don't refetch
  // (which would risk Upstox rate-limiting — see the off-hours
  // gating in loadAndRender below). state.tfCache holds the
  // in-memory copy; CHART_TF_CACHE_KEY is the localStorage key.
  var CHART_TF_CACHE_KEY = 'chart_tf_cache_v1';
  function loadTfCacheFromStorage() {
    try {
      var raw = localStorage.getItem(CHART_TF_CACHE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_) { return {}; }
  }
  function persistTfCache(tfCache) {
    try {
      // Cap at 6 entries (each ~30-80 KB per TF × ~5 timeframes the
      // user actually flips between) to stay under localStorage quota.
      // Oldest entries evict first.
      var keys = Object.keys(tfCache);
      if (keys.length > 6) {
        var sorted = keys.sort(function (a, b) {
          return (tfCache[a].at || 0) - (tfCache[b].at || 0);
        });
        sorted.slice(0, sorted.length - 6).forEach(function (k) { delete tfCache[k]; });
      }
      localStorage.setItem(CHART_TF_CACHE_KEY, JSON.stringify(tfCache));
    } catch (_) {
      // Quota exceeded — clear and continue with in-memory only
      try { localStorage.removeItem(CHART_TF_CACHE_KEY); } catch (_) {}
    }
  }

  function persistAggVolCache() {
    try {
      // Cap at 8 entries (each ~50-100 KB) to stay under typical
      // localStorage quota; oldest cache entries get evicted first.
      var keys = Object.keys(aggVolCache);
      if (keys.length > 8) {
        var sorted = keys.sort(function (a, b) {
          return (aggVolCache[a]._at || 0) - (aggVolCache[b]._at || 0);
        });
        sorted.slice(0, sorted.length - 8).forEach(function (k) { delete aggVolCache[k]; });
      }
      localStorage.setItem(AGG_VOL_CACHE_KEY, JSON.stringify(aggVolCache));
    } catch (_) {
      // Quota exceeded — start fresh
      try { aggVolCache = {}; localStorage.removeItem(AGG_VOL_CACHE_KEY); } catch (_) {}
    }
  }

  // Bounded-concurrency Promise.all replacement. Runs `fn(item)` for
  // every item with at most `limit` in flight at a time. Order of
  // results matches the input order, so callers can keep using indices.
  // Aborts via signal: workers exit early, returning whatever they
  // have so far.
  async function pLimit(items, limit, fn, signal) {
    var results = new Array(items.length);
    var nextIdx = 0;
    async function worker() {
      while (true) {
        if (signal && signal.aborted) return;
        var i = nextIdx++;
        if (i >= items.length) return;
        try { results[i] = await fn(items[i]); }
        catch (e) {
          if (e && e.name === 'AbortError') return;
          results[i] = null;
        }
      }
    }
    var workers = [];
    var n = Math.min(limit, items.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  async function fetchAggregatedHistoricalVolume(timeframe, signal) {
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) return null;
    var token = getToken();
    if (!token) return null;
    var tf = TF[timeframe];
    if (!tf) return null;

    var to = new Date(), from = new Date();
    from.setDate(to.getDate() - tf.historyDays);
    var toStr = fmtDate(to), fromStr = fmtDate(from);
    var cacheKey = timeframe + ':' + fromStr + '|' + toStr;

    // Cache freshness — eternal when market is closed (volumes
    // for past sessions don't change), 30 min while market is
    // open. The off-hours rule is the API-rate-limit fix
    // (May 2026): without it, every analyze() pass refetched
    // 200 constituent candles per timeframe after 30 min and
    // tripped Cloudflare 429s on weekends.
    var cached = aggVolCache[cacheKey];
    var marketOpenAv = isMarketOpen();
    if (cached) {
      var ageMs = Date.now() - (cached._at || 0);
      if (!marketOpenAv || ageMs < 30 * 60 * 1000) {
        console.log('[chart] vol cache hit:', cacheKey,
          marketOpenAv ? '(age ' + Math.round(ageMs / 1000) + 's)' : '(market closed \u2014 eternal cache)');
        return cached;
      }
    }

    // ── Off-hours guard: never fire the 100-fetch burst when
    // market is closed and we have no cache. The volume layer is
    // a "nice to have" enrichment — without it OBV and the
    // volumeRatio signal default to neutral, but the verdict
    // engine still works (it gracefully handles null volumes).
    // Firing 100+ /historical-candle calls on a weekend is the
    // primary cause of the Cloudflare 429 the user was seeing.
    if (!marketOpenAv) {
      console.log('[chart] vol aggregation: skipping (' + timeframe + ' \u2014 market closed and no cache)');
      return null;
    }

    console.log('[chart] aggregating volume for ' + NIFTY50_KEYS.length + ' Nifty stocks @ ' + timeframe + '...');
    var t0 = Date.now();
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

    // fetchOne returns either an array of candles (success), or null on
    // any non-OK response. The probe step below uses `null` to detect
    // upstream-rejection so it can short-circuit the whole batch
    // instead of firing 99 more guaranteed-to-fail requests.
    function fetchOne(url) {
      return fetch(url, { headers: headers, signal: signal })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d == null) return null;
          return (d && d.data && d.data.candles) || [];
        })
        .catch(function (e) {
          if (e && e.name === 'AbortError') throw e;
          return null;
        });
    }

    // Build URL list: historical for all stocks, plus intraday for today.
    // Upstox V3 supports the intraday endpoint for days/1 too (per their
    // "Get current day data" sample), so we ALWAYS include the intraday
    // pass — it's how the today-bar's volume actually lands on the chart
    // on the 1D timeframe. Without it, the daily volume bar stays empty
    // until tomorrow's silentRefetch picks up yesterday's closed candle.
    var urls = NIFTY50_KEYS.map(function (key) {
      var ikey = encodeURIComponent(key);
      return V3 + '/historical-candle/' + ikey + '/' + tf.unit + '/' + tf.interval + '/' + toStr + '/' + fromStr;
    });
    NIFTY50_KEYS.forEach(function (key) {
      var ikey = encodeURIComponent(key);
      urls.push(V3 + '/historical-candle/intraday/' + ikey + '/' + tf.unit + '/' + tf.interval);
    });

    // PROBE: send the first URL alone before firing the rest. If
    // Upstox rejects it (400 from V3 historical-candle for stocks is
    // a known issue — different date-range cap than indices, or
    // possibly endpoint quirk), we abort the whole batch instead of
    // spamming 99 more red errors into the console. We also do a one-
    // time fetch + log of the response body so we can actually see WHY
    // Upstox said no, then mark this timeframe as "vol aggregation
    // broken" for the rest of the session so we don't re-probe on
    // every TF switch.
    if (urls.length) {
      if (state.volAggBrokenForTf && state.volAggBrokenForTf[timeframe]) {
        console.log('[chart] vol aggregation: skipping (' + timeframe + ' previously rejected this session)');
        return null;
      }
      try {
        var probeRes = await fetch(urls[0], { headers: headers, signal: signal });
        if (signal && signal.aborted) {
          var ae0 = new Error('Aborted'); ae0.name = 'AbortError'; throw ae0;
        }
        if (!probeRes.ok) {
          var bodyText = '';
          try { bodyText = (await probeRes.text()).slice(0, 400); } catch (_) {}
          console.warn(
            '[chart] vol aggregation: probe returned ' + probeRes.status +
            ' for ' + urls[0] + ' — aborting batch. Body: ' + bodyText
          );
          state.volAggBrokenForTf = state.volAggBrokenForTf || {};
          state.volAggBrokenForTf[timeframe] = true;
          return null;
        }
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        console.warn('[chart] vol aggregation: probe threw, aborting batch', e);
        return null;
      }
    }

    // Concurrency cap: cap parallel constituent fetches to 6 so we
    // never hammer Upstox with 100 simultaneous requests. Without this
    // cap, a single TF switch fires 100 GETs at api.upstox.com and the
    // host (or its CDN) tears down the HTTP/2 connection or rate-limits
    // us, which kills the user's *actual* chart fetch with a generic
    // "Failed to fetch". Cap of 6 = same as Chrome's default per-host
    // limit on HTTP/1.1 — well below anything Upstox will throttle.
    var results;
    try {
      results = await pLimit(urls, 6, fetchOne, signal);
      if (signal && signal.aborted) {
        var ae = new Error('Aborted'); ae.name = 'AbortError'; throw ae;
      }
      // Convert nulls (rejected fetches) back to [] so downstream
      // sum-by-timestamp logic doesn't choke.
      results = results.map(function (r) { return r == null ? [] : r; });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      console.warn('[chart] vol aggregation: pLimit rejected', e);
      return null;
    }

    var ok = results.filter(function (r) { return r.length > 0; }).length;
    var totals = { _at: Date.now() };
    results.forEach(function (candles) {
      candles.forEach(function (c) {
        var t = new Date(c[0]).getTime();
        totals[t] = (totals[t] || 0) + (+c[5] || 0);
      });
    });

    aggVolCache[cacheKey] = totals;
    persistAggVolCache();

    console.log('[chart] vol aggregation: ' + ok + '/' + urls.length + ' fetches succeeded in ' + (Date.now() - t0) + 'ms — covers ' + (Object.keys(totals).length - 1) + ' timestamps');
    return totals;
  }

  function applyAggregatedVolumeToCandles(totals) {
    if (!totals || !state.candles.length) return false;
    var changed = 0;
    state.candles.forEach(function (c) {
      var t = new Date(c[0]).getTime();
      if (totals[t] != null && totals[t] > 0) {
        c[5] = totals[t];
        changed++;
      }
    });
    console.log('[chart] vol applied to ' + changed + '/' + state.candles.length + ' candles');
    return changed > 0;
  }

  // Trigger an aggregation pass for the current timeframe if it isn't
  // already done or in flight. Idempotent: safe to call from multiple
  // entry points (addIndicator, loadAndRender, manual reload).
  //
  // Debounced 700ms — rapid TF switches (5m → 1m → 3m → 5m within a
  // second) used to fire 100 constituent fetches per switch, ~400
  // requests in flight, which Upstox's HTTP/2 connection couldn't
  // handle and tore down — taking down the user's main chart fetch
  // with a generic "Failed to fetch". The debounce ensures we only
  // start the heavy aggregation once the user lands on a timeframe.
  function ensureAggregatedVolume() {
    if (!state.activeIndicators || !state.activeIndicators.VOL) return;
    if (state.aggVolForTf === state.timeframe) return;
    if (INSTRUMENT_KEY !== 'NSE_INDEX|Nifty 50') return; // aggregator is Nifty 50 specific

    // Debounce: cancel any pending kickoff and schedule a new one. If
    // the user keeps switching TFs, we keep deferring — only the final
    // landing TF actually fires 50+50 constituent fetches.
    if (state.aggVolDebounceTimer) clearTimeout(state.aggVolDebounceTimer);
    state.aggVolDebounceTimer = setTimeout(function () {
      state.aggVolDebounceTimer = null;
      if (!state.activeIndicators || !state.activeIndicators.VOL) return;
      if (state.aggVolInflight) return;
      if (state.aggVolForTf === state.timeframe) return;
      startAggregatedVolume();
    }, 700);
  }

  function startAggregatedVolume() {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    state.aggVolInflight = ctrl;

    fetchAggregatedHistoricalVolume(state.timeframe, ctrl ? ctrl.signal : undefined)
      .then(function (totals) {
        state.aggVolInflight = null;
        if (!totals) return;
        if (applyAggregatedVolumeToCandles(totals)) {
          state.aggVolForTf = state.timeframe;
          if (state.chart && state.volumeSeries) {
            try { state.volumeSeries.setData(state.candles.map(toVolume)); }
            catch (e) { console.warn('[chart] vol setData failed', e); }
          }
        }
      })
      .catch(function (e) {
        state.aggVolInflight = null;
        if (e && e.name === 'AbortError') return;
        console.warn('[chart] vol aggregation failed', e);
      });
  }

  // Cancel any in-flight aggregation AND any pending debounced kickoff.
  // Called when the timeframe changes so a new aggregation can start
  // cleanly for the new timeframe — without leaving 50+ in-flight
  // constituent fetches racing the next TF's main chart fetch.
  function cancelAggregatedVolume() {
    if (state.aggVolDebounceTimer) {
      clearTimeout(state.aggVolDebounceTimer);
      state.aggVolDebounceTimer = null;
    }
    if (state.aggVolInflight && typeof state.aggVolInflight.abort === 'function') {
      try { state.aggVolInflight.abort(); } catch (_) {}
    }
    state.aggVolInflight = null;
    state.aggVolForTf = null;
  }

  // ── Initialize the chart ──
  function initChart() {
    var host = $('tv-chart-container');
    if (!host || typeof LightweightCharts === 'undefined') return;
    Array.from(host.children).forEach(function (ch) {
      if (ch.id !== 'tv-loading' && ch.id !== 'tv-countdown') host.removeChild(ch);
    });

    var mount = document.createElement('div');
    mount.id = 'tv-lwc-mount';
    mount.style.position = 'absolute';
    mount.style.inset = '0';
    host.style.position = 'relative';
    host.appendChild(mount);

    var opts = getLWCOptions();
    opts.autoSize = true;
    state.chart = LightweightCharts.createChart(mount, opts);
    if (!state.chart) return;

    state.candleSeries = state.chart.addSeries(LightweightCharts.CandlestickSeries, getLWCCandleOptions());
    state.volumeSeries = state.chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol'
    });
    state.chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 }
    });
    state.authPriceLine = null;

    buildToolsRow();
    state.indicatorParams = loadIndicatorParams();
    state.currentLayoutName = loadCurrentLayoutName();
    updateIndicatorMenu();
    refreshLayoutMenu();
    startAutosaveTimer();

    if (!state.resizeWired) {
      var onResize = function () {
        try { updateBarCountdown(); } catch (_) {}
      };
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(onResize);
        ro.observe(host);
      }
      window.addEventListener('resize', onResize);
      state.resizeWired = true;
    }

    if (!state.keySaveWired) {
      document.addEventListener('keydown', function (e) {
        if ((e.key !== 's' && e.key !== 'S') || !(e.metaKey || e.ctrlKey)) return;
        if (e.altKey || e.shiftKey) return;
        if (!isLiveActive()) return;
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        e.stopPropagation();
        saveCurrentLayout({ fromShortcut: true });
      });
      state.keySaveWired = true;
    }

    state.chartReady = true;

    loadDrawingPlugin(function() {
      if (typeof LightweightChartsDrawing === 'undefined' || !LightweightChartsDrawing.DrawingManager) return;
      if (!state.chart || !state.candleSeries) return;
      var host = $('tv-chart-container');
      if (!host) return;
      state.drawingManager = new LightweightChartsDrawing.DrawingManager();
      state.drawingManager.attach(state.chart, state.candleSeries, host);

      state.drawingManager.on('drawing:selected', function(event) {
        state.selectedOverlayId = event.drawingId;
      });
      state.drawingManager.on('drawing:deselected', function() {
        state.selectedOverlayId = null;
      });

      restoreDrawingsFromAutosave();
    });
  }

  function reapplyTheme() {
    if (!state.chart) return;
    state.chart.applyOptions(getLWCOptions());
    if (state.candleSeries) state.candleSeries.applyOptions(getLWCCandleOptions());
    renderIndicators();
    drawDaySeparators();
  }


  // ── Indicator catalogue helpers ──────────────────────────────────
  function loadSavedIndicators() {
    try {
      var raw = localStorage.getItem(IND_STORAGE);
      var arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveActiveIndicators() {
    try { localStorage.setItem(IND_STORAGE, JSON.stringify(Object.keys(state.activeIndicators))); }
    catch (_) {}
  }

  function addIndicator(name, skipPersist) {
    var def = INDICATOR_DEFS[name];
    if (!def) return;
    if (state.activeIndicators[name]) return;
    state.activeIndicators[name] = 'active';
    if (!skipPersist) saveActiveIndicators();
    renderIndicators();
  }

  // ── Previous-day OHLC extractor ─────────────────────────────────
  // Walks state.candles backwards to find the most recent complete
  // trading day (IST) before the latest candle. Returns { o, h, l, c }
  // or null when insufficient data.
  function findPrevDayHLC(candles) {
    if (!candles || candles.length < 2) return null;
    var IST_OFF = 19800000;
    function istKey(iso) {
      var ms = new Date(iso).getTime() + IST_OFF;
      var d = new Date(ms);
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    var todayKey = istKey(candles[candles.length - 1][0]);
    var prevDayKey = null;
    for (var i = candles.length - 1; i >= 0; i--) {
      var key = istKey(candles[i][0]);
      if (key !== todayKey) { prevDayKey = key; break; }
    }
    if (!prevDayKey) return null;
    var prevO = NaN, prevH = -Infinity, prevL = Infinity, prevC = NaN;
    for (var j = 0; j < candles.length; j++) {
      if (istKey(candles[j][0]) !== prevDayKey) continue;
      var o = +candles[j][1], h = +candles[j][2], l = +candles[j][3], c = +candles[j][4];
      if (isNaN(prevO)) prevO = o;
      if (h > prevH) prevH = h;
      if (l < prevL) prevL = l;
      prevC = c;
    }
    if (!isFinite(prevH) || !isFinite(prevL)) return null;
    return { o: prevO, h: prevH, l: prevL, c: prevC };
  }

  // ── Core indicator renderer ─────────────────────────────────────
  // Removes all existing indicator series, then recomputes + renders
  // every active indicator. Called after addIndicator, removeIndicator,
  // applyIndicatorParams, applyChartData, and reapplyTheme.
  function renderIndicators() {
    if (!state.chart || !state.candles || !state.candles.length) return;

    // Tear down old indicator series
    Object.keys(state.indicatorSeries).forEach(function (key) {
      (state.indicatorSeries[key] || []).forEach(function (s) {
        try { state.chart.removeSeries(s); } catch (_) {}
      });
    });
    state.indicatorSeries = {};

    var M = window._tfMath || {};
    var candles = state.candles;
    var closes = candles.map(function (c) { return +c[4]; });
    var times = candles.map(function (c) {
      var ms = new Date(c[0]).getTime();
      if (state.timeframe === '1d') {
        var ist = new Date(ms + IST_OFFSET_SEC * 1000);
        return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
      }
      return Math.floor(ms / 1000) + IST_OFFSET_SEC;
    });
    var tFirst = times[0], tLast = times[times.length - 1];

    function params(name) {
      return (state.indicatorParams && state.indicatorParams[name]) ||
             (INDICATOR_DEFS[name] && INDICATOR_DEFS[name].defaultParams) || [];
    }

    var OVERLAY_COLORS = ['#3b82f6', '#f97316', '#9333ea', '#06b6d4'];

    Object.keys(state.activeIndicators).forEach(function (name) {
      var series = [];
      try {
        // ── MA (Simple Moving Average) ──
        if (name === 'MA') {
          var ps = params('MA');
          ps.forEach(function (p, i) {
            if (!M.sma || !p) return;
            var vals = M.sma(closes, p);
            var data = [];
            for (var j = 0; j < vals.length; j++) {
              if (isFinite(vals[j])) data.push({ time: times[j], value: vals[j] });
            }
            if (data.length) {
              var s = state.chart.addSeries(LightweightCharts.LineSeries, { color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, title: 'MA' + p });
              s.setData(data);
              series.push(s);
            }
          });
        }
        // ── EMA (Exponential Moving Average) ──
        else if (name === 'EMA') {
          var ps = params('EMA');
          ps.forEach(function (p, i) {
            if (!M.ema || !p) return;
            var vals = M.ema(closes, p);
            var data = [];
            for (var j = 0; j < vals.length; j++) {
              if (isFinite(vals[j])) data.push({ time: times[j], value: vals[j] });
            }
            if (data.length) {
              var s = state.chart.addSeries(LightweightCharts.LineSeries, { color: OVERLAY_COLORS[i % OVERLAY_COLORS.length], lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, title: 'EMA' + p });
              s.setData(data);
              series.push(s);
            }
          });
        }
        // ── SMA 44 ──
        else if (name === 'SMA44') {
          if (!M.sma) return;
          var ps = params('SMA44');
          var period = (ps && ps[0]) || 44;
          var vals = M.sma(closes, period);
          var data = [];
          for (var j = 0; j < vals.length; j++) {
            if (isFinite(vals[j])) data.push({ time: times[j], value: vals[j] });
          }
          if (data.length) {
            var s = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#eab308', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false, title: 'SMA' + period });
            s.setData(data);
            series.push(s);
          }
        }
        // ── Bollinger Bands ──
        else if (name === 'BOLL') {
          if (!M.sma) return;
          var ps = params('BOLL');
          var period = ps[0] || 20;
          var mult = ps[1] || 2;
          var mid = M.sma(closes, period);
          var uData = [], mData = [], lData = [];
          for (var j = 0; j < closes.length; j++) {
            if (!isFinite(mid[j])) continue;
            var sum2 = 0;
            for (var k = j - period + 1; k <= j; k++) sum2 += (closes[k] - mid[j]) * (closes[k] - mid[j]);
            var std = Math.sqrt(sum2 / period);
            var t = times[j];
            mData.push({ time: t, value: mid[j] });
            uData.push({ time: t, value: mid[j] + mult * std });
            lData.push({ time: t, value: mid[j] - mult * std });
          }
          if (mData.length) {
            var s1 = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#a855f7', lineWidth: 1, lastValueVisible: false, priceLineVisible: false, title: 'BB Mid' });
            s1.setData(mData);
            series.push(s1);
          }
          if (uData.length) {
            var s2 = state.chart.addSeries(LightweightCharts.LineSeries, { color: 'rgba(168,85,247,0.5)', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, title: 'BB Up' });
            s2.setData(uData);
            series.push(s2);
          }
          if (lData.length) {
            var s3 = state.chart.addSeries(LightweightCharts.LineSeries, { color: 'rgba(168,85,247,0.5)', lineWidth: 1, lineStyle: 2, lastValueVisible: false, priceLineVisible: false, title: 'BB Low' });
            s3.setData(lData);
            series.push(s3);
          }
        }
        // ── SAR (Parabolic SAR) — stub ──
        else if (name === 'SAR') {
          console.log('[chart] Parabolic SAR indicator not yet implemented');
        }
        // ── CPR (Central Pivot Range) ──
        // Uses line series (2-point flat lines spanning the data) instead
        // of candleSeries.createPriceLine so cleanup via removeSeries works.
        else if (name === 'CPR') {
          var prevDay = findPrevDayHLC(candles);
          if (prevDay) {
            var pivot = (prevDay.h + prevDay.l + prevDay.c) / 3;
            var bc = (prevDay.h + prevDay.l) / 2;
            var tc = pivot + (pivot - bc);
            [{ p: tc, c: '#22c55e', t: 'TC' }, { p: pivot, c: '#eab308', t: 'Pivot' }, { p: bc, c: '#ef4444', t: 'BC' }].forEach(function (item) {
              if (!isFinite(item.p)) return;
              var s = state.chart.addSeries(LightweightCharts.LineSeries, { color: item.c, lineWidth: 1, lineStyle: 2, lastValueVisible: true, priceLineVisible: false, title: item.t });
              s.setData([{ time: tFirst, value: item.p }, { time: tLast, value: item.p }]);
              series.push(s);
            });
          }
        }
        // ── PDHL (Previous Day OHLC) ──
        else if (name === 'PDHL') {
          var prevDay = findPrevDayHLC(candles);
          if (prevDay) {
            [{ p: prevDay.h, c: '#22c55e', t: 'PDH' }, { p: prevDay.l, c: '#ef4444', t: 'PDL' },
             { p: prevDay.o, c: '#64748b', t: 'PDO' }, { p: prevDay.c, c: '#3b82f6', t: 'PDC' }].forEach(function (item) {
              if (!isFinite(item.p)) return;
              var s = state.chart.addSeries(LightweightCharts.LineSeries, { color: item.c, lineWidth: 1, lineStyle: 2, lastValueVisible: true, priceLineVisible: false, title: item.t });
              s.setData([{ time: tFirst, value: item.p }, { time: tLast, value: item.p }]);
              series.push(s);
            });
          }
        }
        // ── VOL (Volume MAs) ──
        else if (name === 'VOL') {
          var vols = candles.map(function (c) { return +c[5] || 0; });
          var ps = params('VOL');
          var volColors = ['#60a5fa', '#f97316', '#a78bfa'];
          ps.forEach(function (p, i) {
            if (!M.sma || !p) return;
            var vals = M.sma(vols, p);
            var data = [];
            for (var j = 0; j < vals.length; j++) {
              if (isFinite(vals[j])) data.push({ time: times[j], value: vals[j] });
            }
            if (data.length) {
              var s = state.chart.addSeries(LightweightCharts.LineSeries, {
                color: volColors[i % volColors.length], lineWidth: 1,
                lastValueVisible: false, priceLineVisible: false,
                priceScaleId: 'vol', title: 'VMa' + p
              });
              s.setData(data);
              series.push(s);
            }
          });
        }
        // ── MACD ──
        else if (name === 'MACD') {
          if (!M.macd) return;
          var result = M.macd(closes);
          if (!result) return;
          var macdData = [], sigData = [], histData = [];
          for (var j = 0; j < closes.length; j++) {
            var t = times[j];
            if (isFinite(result.macd[j])) macdData.push({ time: t, value: result.macd[j] });
            if (isFinite(result.signal[j])) sigData.push({ time: t, value: result.signal[j] });
            if (isFinite(result.hist[j])) {
              histData.push({ time: t, value: result.hist[j], color: result.hist[j] >= 0 ? 'rgba(34,197,94,0.5)' : 'rgba(239,68,68,0.5)' });
            }
          }
          var macdScale = 'macd_scale';
          if (histData.length) {
            var hS = state.chart.addSeries(LightweightCharts.HistogramSeries, { priceScaleId: macdScale, priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, lastValueVisible: false });
            hS.setData(histData);
            series.push(hS);
          }
          if (macdData.length) {
            var mS = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#3b82f6', lineWidth: 1.5, priceScaleId: macdScale, lastValueVisible: false, priceLineVisible: false, title: 'MACD' });
            mS.setData(macdData);
            series.push(mS);
          }
          if (sigData.length) {
            var sS = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#f97316', lineWidth: 1.5, priceScaleId: macdScale, lastValueVisible: false, priceLineVisible: false, title: 'Signal' });
            sS.setData(sigData);
            series.push(sS);
          }
          if (series.length) {
            state.chart.priceScale(macdScale).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
          }
        }
        // ── RSI ──
        else if (name === 'RSI') {
          if (!M.rsi) return;
          var ps = params('RSI');
          var rsiScale = 'rsi_scale';
          var rsiColors = ['#a855f7', '#3b82f6', '#f97316'];
          ps.forEach(function (p, i) {
            var vals = M.rsi(closes, p);
            var data = [];
            for (var j = 0; j < vals.length; j++) {
              if (isFinite(vals[j])) data.push({ time: times[j], value: vals[j] });
            }
            if (data.length) {
              var s = state.chart.addSeries(LightweightCharts.LineSeries, {
                color: rsiColors[i % rsiColors.length], lineWidth: 1.5,
                priceScaleId: rsiScale, lastValueVisible: false, priceLineVisible: false,
                title: 'RSI' + p
              });
              s.setData(data);
              series.push(s);
            }
          });
          if (series.length) {
            state.chart.priceScale(rsiScale).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
            try {
              series[0].createPriceLine({ price: 70, color: 'rgba(239,68,68,0.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
              series[0].createPriceLine({ price: 30, color: 'rgba(34,197,94,0.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
            } catch (_) {}
          }
        }
        // ── KDJ (Stochastic) ──
        else if (name === 'KDJ') {
          if (!M.stochastic) return;
          var ps = params('KDJ');
          // _tfMath.stochastic expects candles as [iso, o, h, l, c, vol, ...]
          // — state.candles matches that format exactly.
          var result = M.stochastic(candles, ps[0] || 9, ps[1] || 3, ps[2] || 3);
          if (!result) return;
          var kdjScale = 'kdj_scale';
          var kData = [], dData = [];
          for (var j = 0; j < candles.length; j++) {
            if (result[j] && isFinite(result[j].k)) kData.push({ time: times[j], value: result[j].k });
            if (result[j] && isFinite(result[j].d)) dData.push({ time: times[j], value: result[j].d });
          }
          if (kData.length) {
            var kS = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#3b82f6', lineWidth: 1.5, priceScaleId: kdjScale, lastValueVisible: false, priceLineVisible: false, title: '%K' });
            kS.setData(kData);
            series.push(kS);
          }
          if (dData.length) {
            var dS = state.chart.addSeries(LightweightCharts.LineSeries, { color: '#f97316', lineWidth: 1.5, priceScaleId: kdjScale, lastValueVisible: false, priceLineVisible: false, title: '%D' });
            dS.setData(dData);
            series.push(dS);
          }
          if (series.length) {
            state.chart.priceScale(kdjScale).applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
            try {
              series[0].createPriceLine({ price: 80, color: 'rgba(239,68,68,0.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
              series[0].createPriceLine({ price: 20, color: 'rgba(34,197,94,0.4)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
            } catch (_) {}
          }
        }
      } catch (e) {
        console.warn('[chart] renderIndicator ' + name + ' failed', e);
      }
      if (series.length) state.indicatorSeries[name] = series;
    });
  }

  // ── Indicator params persistence + apply ─────────────────────────
  function loadIndicatorParams() {
    try { return JSON.parse(localStorage.getItem(IND_PARAMS_STORAGE) || '{}') || {}; }
    catch (_) { return {}; }
  }
  function saveIndicatorParams() {
    try { localStorage.setItem(IND_PARAMS_STORAGE, JSON.stringify(state.indicatorParams || {})); }
    catch (_) {}
  }
  function applyIndicatorParams(name, params) {
    if (!INDICATOR_DEFS[name]) return;
    var clean = (params || []).map(function (v) { return Number(v); }).filter(function (v) { return isFinite(v) && v > 0; });
    if (clean.length) state.indicatorParams[name] = clean;
    else delete state.indicatorParams[name];
    saveIndicatorParams();
    scheduleAutosave();
    if (state.activeIndicators[name]) renderIndicators();
  }
  function resetIndicatorParams(name) {
    applyIndicatorParams(name, []); // empty -> falls back to defaultParams
  }

  // ── Named layouts: schema, migration, snapshot, save, load ──────
  // A "layout" captures everything the user customised about the chart
  // so it can be restored exactly later:
  //   - timeframe                  (e.g. '5m', '15m')
  //   - active indicators + per-indicator calcParams
  //   - drawn overlays (trendlines, fibs, etc.) with their points
  //   - theme (light / dark) — restored on apply so a layout always
  //     looks the same regardless of the user's current preference
  //   - instrument — recorded for future use; we only chart Nifty 50
  //     today, but this future-proofs the schema for multi-instrument
  //   - isDefault — exactly one layout can be flagged as the one to
  //     auto-load on page open (wins over autosave)
  //   - createdAt / updatedAt — drive the "Saved 2m ago" badges
  //
  // Storage migration: v1 entries (older format with no theme /
  // instrument / updatedAt) are read once, padded with sensible defaults,
  // written back under v2, and the v1 key is removed so we don't migrate
  // again. Idempotent — safe to call on every page load.
  function migrateLayoutStorage() {
    try {
      if (localStorage.getItem(LAYOUT_STORAGE)) return; // already migrated
      var raw = localStorage.getItem(LAYOUT_STORAGE_LEGACY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) {
        localStorage.removeItem(LAYOUT_STORAGE_LEGACY);
        return;
      }
      var now = Date.now();
      var migrated = arr.map(function (l) {
        return {
          name: l.name,
          timeframe: l.timeframe,
          indicators: Array.isArray(l.indicators) ? l.indicators : [],
          overlays: Array.isArray(l.overlays) ? l.overlays : [],
          theme: null,                            // unknown — keep user's current theme
          instrument: 'NSE_INDEX|Nifty 50',       // only instrument we shipped
          isDefault: false,
          createdAt: l.createdAt || now,
          updatedAt: l.createdAt || now
        };
      });
      localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(migrated));
      localStorage.removeItem(LAYOUT_STORAGE_LEGACY);
      console.log('[chart] migrated ' + migrated.length + ' layout(s) from v1 to v2');
    } catch (e) {
      console.warn('[chart] layout migration failed:', e);
    }
  }
  migrateLayoutStorage();

  function loadAllLayouts() {
    try {
      var arr = JSON.parse(localStorage.getItem(LAYOUT_STORAGE) || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }
  function saveAllLayouts(arr) {
    try { localStorage.setItem(LAYOUT_STORAGE, JSON.stringify(arr)); }
    catch (e) { console.warn('[chart] saveAllLayouts failed:', e); }
  }
  function findLayout(name) {
    return loadAllLayouts().find(function (l) { return l.name === name; }) || null;
  }
  function getDefaultLayout() {
    return loadAllLayouts().find(function (l) { return l.isDefault; }) || null;
  }
  function loadCurrentLayoutName() {
    try { return localStorage.getItem(LAYOUT_CURRENT_STORAGE) || null; }
    catch (_) { return null; }
  }
  function saveCurrentLayoutName(name) {
    try {
      if (name) localStorage.setItem(LAYOUT_CURRENT_STORAGE, name);
      else localStorage.removeItem(LAYOUT_CURRENT_STORAGE);
    } catch (_) {}
    state.currentLayoutName = name || null;
  }

  // Snapshot every restorable piece of chart state. Pulled by both named
  // save and the autosave path so they're guaranteed to capture the
  // same things.
  function snapshotLayout() {
    var indicators = Object.keys(state.activeIndicators).map(function (n) {
      var entry = { name: n };
      if (state.indicatorParams[n] && state.indicatorParams[n].length) {
        entry.calcParams = state.indicatorParams[n].slice();
      }
      return entry;
    });

    // Walk OUR tracked ids and pull each overlay's live state via
    // getOverlayById (the only enumeration tool v9.8 actually gives us).
    // Stale entries (overlay removed without us hearing about it) just
    // return null and get skipped.
    var overlays = [];
    if (state.chart && typeof state.chart.getOverlayById === 'function') {
      state.activeOverlayIds.forEach(function (entry) {
        try {
          var ov = state.chart.getOverlayById(entry.id);
          if (!ov) return;
          // Skip half-drawn overlays (user clicked first point but never
          // placed the second). currentStep === -1 means draw is done.
          if (typeof ov.totalStep === 'number' && typeof ov.currentStep === 'number'
              && ov.currentStep !== -1 && ov.currentStep < ov.totalStep) return;
          // Keep timestamp + value when present. dataIndex is window-
          // relative and meaningless after a scroll, so we drop it; the
          // absolute timestamp is enough for Klinecharts to recompute it.
          var pts = (ov.points || []).map(function (p) {
            if (!p) return null;
            var out = {};
            if (p.timestamp != null) out.timestamp = p.timestamp;
            if (p.value != null)     out.value     = p.value;
            return Object.keys(out).length > 0 ? out : null;
          }).filter(Boolean);
          if (!pts.length) return;
          overlays.push({ name: ov.name || entry.name, points: pts });
        } catch (e) {
          console.warn('[chart] snapshotLayout: skipping overlay', entry.id, e);
        }
      });
    }

    var theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    var snap = {
      timeframe: state.timeframe,
      instrument: (typeof INSTRUMENT_KEY === 'string' ? INSTRUMENT_KEY : null),
      theme: theme,
      indicators: indicators,
      overlays: overlays
    };
    if (state.drawingManager && state.drawingManager.exportDrawings) {
      try { snap.drawings = state.drawingManager.exportDrawings(); } catch (_) {}
    }
    return snap;
  }

  // Create or replace a named layout. `isUpdate=true` keeps createdAt /
  // isDefault from the existing record (you don't lose your "default"
  // flag when you press Save on the same name).
  function persistLayout(name, isUpdate) {
    name = (name || '').trim();
    if (!name) return false;
    var snap = snapshotLayout();
    snap.name = name;
    var all = loadAllLayouts();
    var existing = all.find(function (l) { return l.name === name; });
    var now = Date.now();
    if (existing && isUpdate) {
      snap.createdAt = existing.createdAt || now;
      snap.isDefault = !!existing.isDefault;
    } else {
      snap.createdAt = now;
      snap.isDefault = false;
    }
    snap.updatedAt = now;
    var others = all.filter(function (l) { return l.name !== name; });
    others.push(snap);
    others.sort(function (a, b) { return (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0); });
    saveAllLayouts(others);
    saveCurrentLayoutName(name);
    refreshLayoutMenu();
    return true;
  }

  // Two save modes. saveCurrentLayout updates the layout the user has
  // loaded (or — if none — opens the dropdown so they can name a new
  // one). saveAsLayout always creates a fresh entry. Cmd+S calls
  // saveCurrentLayout; the "Save As" button always calls saveAsLayout.
  function saveCurrentLayout(opts) {
    opts = opts || {};
    var name = state.currentLayoutName;
    if (name && findLayout(name)) {
      var ok = persistLayout(name, true);
      if (ok) flashSaveToast('Saved \u201c' + name + '\u201d');
      return ok;
    }
    // No current layout — prompt by opening the Layouts dropdown and
    // pre-focusing the name input. The user can then either type a name
    // or hit Esc.
    promptForLayoutName(opts.fromShortcut === true);
    return false;
  }
  function saveAsLayout(name) {
    var ok = persistLayout(name, false);
    if (ok) flashSaveToast('Saved as \u201c' + name + '\u201d');
    return ok;
  }
  function deleteLayout(name) {
    var all = loadAllLayouts().filter(function (l) { return l.name !== name; });
    saveAllLayouts(all);
    if (state.currentLayoutName === name) saveCurrentLayoutName(null);
    refreshLayoutMenu();
  }
  function setDefaultLayout(name) {
    var all = loadAllLayouts();
    // Toggle: if `name` was already the default, clear it (no default).
    // Otherwise mark `name` and clear every other.
    var target = all.find(function (l) { return l.name === name; });
    var wasDefault = !!(target && target.isDefault);
    all.forEach(function (l) { l.isDefault = false; });
    if (target && !wasDefault) target.isDefault = true;
    saveAllLayouts(all);
    refreshLayoutMenu();
  }

  function loadLayout(name) {
    var layout = findLayout(name);
    if (!layout || !state.chart) return;
    saveCurrentLayoutName(name);
    // Bump updatedAt? No — Loading is a read; only saves change updatedAt.
    if (layout.timeframe && layout.timeframe !== state.timeframe) {
      // Timeframe switch is async (refetch + re-render). Defer the layout
      // apply until loadAndRender finishes; loadAndRender checks
      // state.pendingLayout at the end and triggers applyLayout.
      state.pendingLayout = layout;
      setTimeframe(layout.timeframe);
    } else {
      applyLayout(layout);
    }
    closeDropdowns();
  }

  // ── Autosave ────────────────────────────────────────────────────
  // A single dedicated localStorage slot (LAYOUT_AUTOSAVE_STORAGE) is
  // overwritten in place every time the chart state changes. On page
  // load, if no default layout is marked, this slot is silently
  // re-applied so the user wakes up exactly where they left off — same
  // pattern as TradingView's built-in autosave.
  //
  // Triggers are debounced AUTOSAVE_DEBOUNCE_MS after the last change to
  // avoid hammering localStorage during rapid drawing/scrolling, and
  // backstopped by an AUTOSAVE_INTERVAL_MS interval so even a leak in
  // the debounce wiring can't silently lose more than 30s of work.
  function scheduleAutosave() {
    if (!state.chartReady) return;
    if (state.autosaveDebounceTimer) clearTimeout(state.autosaveDebounceTimer);
    state.autosaveDebounceTimer = setTimeout(function () {
      state.autosaveDebounceTimer = null;
      runAutosave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }
  function runAutosave() {
    if (!state.chartReady) return;
    try {
      var snap = snapshotLayout();
      snap.savedAt = Date.now();
      snap.currentLayoutName = state.currentLayoutName || null;
      localStorage.setItem(LAYOUT_AUTOSAVE_STORAGE, JSON.stringify(snap));
      state.lastAutosaveTs = snap.savedAt;
      // Cheap UI tick so the "Auto-saved … ago" badge stays fresh
      // without waiting for the next dropdown render.
      updateAutosaveBadge();
    } catch (e) {
      console.warn('[chart] autosave failed:', e);
    }
  }
  function startAutosaveTimer() {
    if (state.autosaveIntervalTimer) return;
    state.autosaveIntervalTimer = setInterval(runAutosave, AUTOSAVE_INTERVAL_MS);
  }
  function restoreDrawingsFromAutosave() {
    try {
      var raw = localStorage.getItem(LAYOUT_AUTOSAVE_STORAGE);
      if (!raw) return;
      var layout = JSON.parse(raw);
      if (layout && layout.drawings && state.drawingManager && state.drawingManager.importDrawings) {
        state.drawingManager.importDrawings(layout.drawings);
      }
    } catch (_) {}
  }
  function loadAutosave() {
    try {
      var raw = localStorage.getItem(LAYOUT_AUTOSAVE_STORAGE);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }
  function applyLayout(layout) {
    if (!state.chart || !layout) {
      console.warn('[chart] applyLayout: no chart or layout', { hasChart: !!state.chart, layout: layout });
      return;
    }
    var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    console.log('[chart] applyLayout: applying "' + (layout.name || '(unnamed)') + '"',
      'inds:', (layout.indicators || []).length, 'overlays:', (layout.overlays || []).length);

    // ── Step 1: tear down current state ──
    // Remove every active indicator. Force-clear the map afterwards in
    // case any removeIndicator silently failed and left a residue —
    // a stale entry would cause addIndicator's dedup guard below to
    // skip restoring that same indicator.
    Object.keys(state.activeIndicators).slice().forEach(function (n) {
      try { removeIndicator(n); } catch (e) { console.warn('[chart] applyLayout: removeIndicator threw', n, e); }
    });
    if (Object.keys(state.activeIndicators).length > 0) {
      console.warn('[chart] applyLayout: residual indicators after wipe:', Object.keys(state.activeIndicators));
      state.activeIndicators = {};
    }
    clearDrawings();
    state.indicatorParams = {};

    // ── Step 2: pre-load saved calcParams ──
    // addIndicator reads state.indicatorParams[name] when building the
    // config, so seed them BEFORE any addIndicator call.
    (layout.indicators || []).forEach(function (entry) {
      if (entry && entry.calcParams && entry.calcParams.length) {
        state.indicatorParams[entry.name] = entry.calcParams.slice();
      }
    });

    // ── Step 3: restore indicators ──
    var addedInd = 0, failedInd = 0;
    (layout.indicators || []).forEach(function (entry) {
      if (!entry || !INDICATOR_DEFS[entry.name]) {
        console.warn('[chart] applyLayout: unknown indicator', entry);
        failedInd++; return;
      }
      var before = Object.keys(state.activeIndicators).length;
      addIndicator(entry.name, true);
      if (Object.keys(state.activeIndicators).length > before) {
        addedInd++;
      } else {
        console.warn('[chart] applyLayout: addIndicator did not register', entry.name);
        failedInd++;
      }
    });

    // ── Step 4: restore drawings ──
    var addedOv = 0, failedOv = 0;
    if (layout.drawings && state.drawingManager && state.drawingManager.importDrawings) {
      try {
        state.drawingManager.importDrawings(layout.drawings);
        addedOv++;
      } catch (_) { failedOv++; }
    }

    // ── Step 5: restore theme ──
    // Switching theme also re-applies the Klinecharts style block via
    // reapplyTheme() under the hood, so we DON'T need a separate
    // setStyles call after this for the theme path. For the no-change
    // path we still call setStyles below so the grid is guaranteed back
    // (adding/removing panes can drop grid styling in some LWC builds).
    var themeChanged = false;
    if (layout.theme === 'light' || layout.theme === 'dark') {
      var current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      if (layout.theme !== current && typeof toggleTheme === 'function') {
        try { toggleTheme(); themeChanged = true; }
        catch (e) { console.warn('[chart] applyLayout: theme switch failed', e); }
      }
    }
    if (!themeChanged) {
      try { state.chart.applyOptions(getLWCOptions()); }
      catch (e) { console.warn('[chart] applyLayout: applyOptions re-apply failed', e); }
    }

    // ── Step 5b: instrument check ──
    // We only chart Nifty 50 right now; saving the instrument keeps the
    // schema forward-compatible. If the user manages to load a layout
    // saved for a different instrument we just log it loudly — no
    // automatic switch yet.
    if (layout.instrument && typeof INSTRUMENT_KEY === 'string' && layout.instrument !== INSTRUMENT_KEY) {
      console.warn('[chart] applyLayout: layout was saved for ' + layout.instrument +
                   ' but current instrument is ' + INSTRUMENT_KEY +
                   '. Restored indicators/drawings only; instrument was not switched.');
    }

    // ── Step 6: persist + sync UI ──
    saveActiveIndicators();
    saveIndicatorParams();
    updateIndicatorMenu();
    syncIndicatorSettingsValues();
    if (layout.name) saveCurrentLayoutName(layout.name);
    refreshLayoutMenu();
    scheduleAutosave();

    var dt = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    console.log('[chart] applyLayout: done in ' + dt.toFixed(0) + 'ms — indicators ' + addedInd + '/' + (addedInd + failedInd) + ', overlays ' + addedOv + '/' + (addedOv + failedOv));
  }

  // ── Layout UX helpers (toast, prompt, "saved Xs ago") ──────────────
  // Lightweight toast that fades in/out at the bottom of the chart shell
  // so Cmd+S / Save buttons have visible feedback. Single floating node
  // is reused so quick repeated saves never stack multiple toasts.
  function flashSaveToast(text) {
    try {
      var existing = document.getElementById('tv-save-toast');
      if (existing) existing.remove();
      var toast = document.createElement('div');
      toast.id = 'tv-save-toast';
      toast.className = 'tv-save-toast';
      toast.textContent = text;
      var host = document.querySelector('.tv-shell') || document.body;
      host.appendChild(toast);
      // RAF so the initial state paints first, then transition runs.
      requestAnimationFrame(function () { toast.classList.add('show'); });
      setTimeout(function () {
        toast.classList.remove('show');
        setTimeout(function () { if (toast.parentNode) toast.remove(); }, 250);
      }, 1600);
    } catch (_) { /* toast is purely decorative */ }
  }

  // Open the Layouts dropdown and put focus in the name input so the
  // user can immediately type a name and hit Enter. Used when Cmd+S
  // fires without a "current" layout to save.
  function promptForLayoutName(viaShortcut) {
    var dd = $('tv-layout-dd');
    if (!dd) return;
    var menu = dd.querySelector('.tv-tools-menu');
    if (menu) {
      closeDropdowns();
      menu.hidden = false;
      dd.classList.add('open');
    }
    setTimeout(function () {
      var inp = $('tv-layout-name');
      if (inp) {
        inp.focus();
        inp.select();
        if (viaShortcut) inp.placeholder = 'Name your layout, then Enter\u2026';
      }
    }, 30);
  }

  // Human-friendly "5s ago" / "12m ago" / "3h ago" / "2d ago".
  // Used both in the saved-layouts list and the "Auto-saved … ago"
  // badge below the Save buttons. Falls back to absolute time after a
  // week.
  function formatRelativeTime(ms) {
    if (!ms || typeof ms !== 'number') return '';
    var diff = Date.now() - ms;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    try { return new Date(ms).toLocaleDateString('en-IN'); }
    catch (_) { return new Date(ms).toISOString().slice(0, 10); }
  }

  // Refresh the "Auto-saved …" pill without re-rendering the whole
  // dropdown. Called on every autosave and at a slow interval while the
  // dropdown is open.
  function updateAutosaveBadge() {
    var el = $('tv-layout-autosave-badge');
    if (!el) return;
    if (!state.lastAutosaveTs) {
      el.textContent = '';
      return;
    }
    el.textContent = 'Auto-saved ' + formatRelativeTime(state.lastAutosaveTs);
  }

  function removeIndicator(name) {
    if (!state.activeIndicators[name]) return;
    if (state.indicatorSeries[name]) {
      state.indicatorSeries[name].forEach(function (s) {
        try { state.chart.removeSeries(s); } catch (_) {}
      });
      delete state.indicatorSeries[name];
    }
    delete state.activeIndicators[name];
    saveActiveIndicators();
    renderIndicators();
  }

  function toggleIndicator(name) {
    if (state.activeIndicators[name]) removeIndicator(name);
    else addIndicator(name);
    updateIndicatorMenu();
    scheduleAutosave();
  }

  // ── Overlay tracking ────────────────────────────────────────────
  // Klinecharts v9.8 has no API to enumerate all overlays — there's only
  // getOverlayById(id), so we have to remember every id we create. These
  // three helpers are the single source of truth that snapshotLayout(),
  // clearDrawings() and applyLayout() all read from.
  function trackOverlay(id, name) {
    if (!id || typeof id !== 'string') return;
    if (state.activeOverlayIds.some(function (e) { return e.id === id; })) return;
    state.activeOverlayIds.push({ id: id, name: name || '' });
    scheduleAutosave();
  }
  function untrackOverlay(id) {
    if (!id) return;
    state.activeOverlayIds = state.activeOverlayIds.filter(function (e) { return e.id !== id; });
    scheduleAutosave();
  }
  function untrackAllOverlays() {
    state.activeOverlayIds = [];
    scheduleAutosave();
  }

  // ── Overlay lifecycle handlers ──────────────────────────────────
  // Single source of truth for the four Klinecharts overlay callbacks
  // we care about. Both startDrawing() (interactive) and applyLayout()
  // (programmatic restore) build their createOverlay config from this,
  // so an overlay born either way behaves identically:
  //   onDrawEnd   → track the id (drawing now persistable)
  //   onSelected  → mark id as the current selection (Delete-key target)
  //   onDeselected→ clear selection if it was this id
  //   onRemoved   → untrack and clear selection if it was this id
  // All callbacks return false because Klinecharts' callback contract
  // treats `true` as "consume / prevent default" — we never want that.
  function overlayLifecycleHandlers(fallbackName) {
    return {
      onDrawEnd: function (event) {
        var ov = event && event.overlay;
        if (ov && ov.id) trackOverlay(ov.id, ov.name || fallbackName);
        return false;
      },
      onSelected: function (event) {
        var ov = event && event.overlay;
        if (ov && ov.id) state.selectedOverlayId = ov.id;
        return false;
      },
      onDeselected: function (event) {
        var ov = event && event.overlay;
        if (ov && ov.id && state.selectedOverlayId === ov.id) {
          state.selectedOverlayId = null;
        }
        return false;
      },
      onRemoved: function (event) {
        var ov = event && event.overlay;
        if (ov && ov.id) {
          if (state.selectedOverlayId === ov.id) state.selectedOverlayId = null;
          untrackOverlay(ov.id);
        }
        return false;
      }
    };
  }

  // ── Drawing helpers ─────────────────────────────────────────────
  var DRAWING_CLASS_MAP = {
    'horizontalStraightLine': 'HorizontalLine',
    'segment': 'TrendLine',
    'rayLine': 'Ray',
    'priceLine': 'HorizontalLine',
    'rectangle': 'Rectangle',
    'fibonacciLine': 'FibRetracement',
    'parallelStraightLine': 'ParallelChannel',
    'verticalStraightLine': 'VerticalLine'
  };

  function startDrawing(name) {
    closeDropdowns();
    if (!state.drawingManager || typeof LightweightChartsDrawing === 'undefined') {
      console.warn('[chart] Drawing plugin not loaded yet');
      return;
    }
    var className = DRAWING_CLASS_MAP[name];
    if (!className) {
      console.warn('[chart] No drawing class mapped for: ' + name);
      return;
    }
    var DrawingClass = LightweightChartsDrawing[className];
    if (!DrawingClass) {
      console.warn('[chart] Drawing class not found: ' + className);
      return;
    }
    var id = name + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    if (typeof state.drawingManager.startDrawing === 'function') {
      state.drawingManager.startDrawing(className);
    } else {
      var drawing = new DrawingClass(id, []);
      state.drawingManager.addDrawing(drawing);
    }
    trackOverlay(id, className);
    scheduleAutosave();
  }

  function clearDrawings() {
    if (state.drawingManager) {
      try {
        var drawings = state.drawingManager.getAllDrawings ? state.drawingManager.getAllDrawings() : [];
        if (Array.isArray(drawings)) {
          drawings.forEach(function(d) {
            try { state.drawingManager.removeDrawing(d.id || d); } catch (_) {}
          });
        }
      } catch (_) {}
    }
    untrackAllOverlays();
    state.selectedOverlayId = null;
    scheduleAutosave();
  }

  // ── Day-boundary separators ─────────────────────────────────────
  // Vertical dotted lines at the first candle of each new IST trading
  // day — TradingView/Upstox call them "session breaks". Lets the user
  // see at a glance where each day starts when scrolling back through
  // intraday data.
  //
  // We skip the daily/weekly timeframes (every candle is a new day
  // there so the lines would be meaningless), and we walk the candle
  // array converting each timestamp to an IST date-key — comparing
  // those keys is what defines a day boundary (NOT UTC date, NOT
  // local-machine date; the trading session is in Asia/Kolkata).
  //
  // Each line is a vertical marker so the user can't accidentally
  // select / drag / delete it, and we keep the ids in their own list
  // (state.daySeparatorIds) so they're completely isolated from
  // user-drawing lifecycle.
  function clearDaySeparators() {
    state.daySeparatorIds = [];
    if (state.dayMarkersPrimitive) {
      try { state.dayMarkersPrimitive.detach(); } catch (_) {}
      state.dayMarkersPrimitive = null;
    }
  }

  function drawDaySeparators() {
    if (!state.chart || !state.candles || !state.candles.length) return;
    clearDaySeparators();

    var tf = TF[state.timeframe];
    if (!tf || tf.unit === 'days' || tf.unit === 'weeks' || tf.unit === 'months') return;

    var lastKey = null;
    var markers = [];
    for (var i = 0; i < state.candles.length; i++) {
      var c = state.candles[i];
      var iso = c && c[0];
      if (!iso) continue;
      var ts = new Date(iso).getTime();
      if (!isFinite(ts) || ts <= 0) continue;
      var key = istDateKey(new Date(ts));
      if (lastKey != null && key !== lastKey) {
        markers.push({
          time: Math.floor(ts / 1000),
          position: 'aboveBar',
          color: 'rgba(100,116,139,0.5)',
          shape: 'arrowDown',
          text: key.slice(5)
        });
      }
      lastKey = key;
    }

    if (markers.length && state.candleSeries) {
      try {
        state.dayMarkersPrimitive = LightweightCharts.createSeriesMarkers(state.candleSeries, markers);
        state.daySeparatorIds = ['markers_set'];
      } catch (e) {
        console.warn('[chart] day separator markers failed', e);
      }
    }
  }

  function deleteSelectedOverlay() {
    if (!state.selectedOverlayId) return false;
    if (state.drawingManager) {
      try { state.drawingManager.removeDrawing(state.selectedOverlayId); } catch (_) {}
    }
    untrackOverlay(state.selectedOverlayId);
    state.selectedOverlayId = null;
    scheduleAutosave();
    return true;
  }

  // ── Tools row (Indicators ▾ | Drawings ▾ | Layouts ▾ | Clear all) ──
  // Inserted dynamically so adding a new indicator/drawing only requires
  // updating INDICATOR_DEFS / DRAWING_DEFS — not editing live.html.
  function buildToolsRow() {
    var shell = document.querySelector('.tv-shell');
    if (!shell || shell.querySelector('.tv-tools-row')) return;

    var row = document.createElement('div');
    row.className = 'tv-tools-row';

    // Indicator menu items: each tunable indicator gets a gear button +
    // an inline settings panel (hidden by default) with one number input
    // per param, plus Apply/Reset. Custom indicators (CPR, PDHL) skip
    // the gear since they have no user-tunable params today.
    var indItems = Object.keys(INDICATOR_DEFS).map(function (id) {
      var def = INDICATOR_DEFS[id];
      var hasParams = !def.custom && def.defaultParams && def.defaultParams.length > 0;
      var paramsHtml = '';
      if (hasParams) {
        paramsHtml =
          '<div class="tv-tools-settings" data-settings="' + id + '" hidden>' +
            def.paramLabels.map(function (lbl, i) {
              return '<label class="tv-tools-param">' +
                       '<span>' + lbl + '</span>' +
                       '<input type="number" min="1" step="1" data-param="' + id + '" data-idx="' + i + '" value="' + def.defaultParams[i] + '">' +
                     '</label>';
            }).join('') +
            '<div class="tv-tools-settings-actions">' +
              '<button type="button" class="tv-tools-mini-btn" data-apply="' + id + '">Apply</button>' +
              '<button type="button" class="tv-tools-mini-btn ghost" data-reset="' + id + '">Reset</button>' +
            '</div>' +
          '</div>';
      }
      var gearBtn = hasParams
        ? '<button type="button" class="tv-tools-gear" data-gear="' + id + '" title="Settings" aria-label="Settings">' +
            '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4"/></svg>' +
          '</button>'
        : '';
      return '<div class="tv-tools-row-item">' +
               '<label class="tv-tools-item">' +
                 '<input type="checkbox" data-ind="' + id + '">' +
                 '<span>' + def.label + '</span>' +
               '</label>' + gearBtn +
             '</div>' + paramsHtml;
    }).join('');

    var drawItems = DRAWING_DEFS.map(function (d) {
      return '<button class="tv-tools-item" type="button" data-draw="' + d.id + '">' +
               '<span class="tv-tools-item-icon">' + d.glyph + '</span>' +
               '<span>' + d.label + '</span>' +
             '</button>';
    }).join('');

    // Layouts dropdown content. The body (list of saved layouts +
    // autosave badge) is repainted by refreshLayoutMenu() whenever it
    // needs to update; the chrome around it (input, buttons, headers)
    // is rendered once here and reused.
    //
    // Two save buttons: "Save" updates the currently loaded layout in
    // place (matches Cmd+S behaviour), "Save As" always creates a new
    // entry from the name field. The dynamic state of those buttons —
    // which is enabled, which is the primary action — is refreshed in
    // refreshLayoutMenu().
    var layoutMenu =
      '<div class="tv-tools-section">' +
        '<input type="text" id="tv-layout-name" class="tv-tools-input" placeholder="New layout name\u2026" maxlength="40" autocomplete="off">' +
      '</div>' +
      '<div class="tv-tools-section" id="tv-layout-actions">' +
        '<button type="button" class="tv-tools-mini-btn" id="tv-layout-save" title="Update the currently loaded layout (\u2318S)">Save</button>' +
        '<button type="button" class="tv-tools-mini-btn ghost" id="tv-layout-saveas" title="Create a new named layout">Save As</button>' +
      '</div>' +
      '<div class="tv-tools-autosave" id="tv-layout-autosave-badge" title="Your work is auto-saved on every change"></div>' +
      '<div class="tv-tools-section-title">Saved layouts</div>' +
      '<div class="tv-tools-layout-list" id="tv-layout-list"></div>';

    var chev = '<svg class="tv-tools-chev" viewBox="0 0 12 12" aria-hidden="true">' +
                 '<polyline points="3,5 6,8 9,5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
               '</svg>';

    row.innerHTML =
      '<div class="tv-tools-dd" id="tv-ind-dd">' +
        '<button class="tv-tools-btn" type="button">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,11 5,6 8,9 11,4 14,7"/></svg>' +
          '<span>Indicators</span>' + chev +
        '</button>' +
        '<div class="tv-tools-menu" hidden>' + indItems + '</div>' +
      '</div>' +
      '<div class="tv-tools-dd" id="tv-draw-dd">' +
        '<button class="tv-tools-btn" type="button">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13 L13 3"/><circle cx="3" cy="13" r="1.4"/><circle cx="13" cy="3" r="1.4"/></svg>' +
          '<span>Drawings</span>' + chev +
        '</button>' +
        '<div class="tv-tools-menu" hidden>' + drawItems + '</div>' +
      '</div>' +
      '<div class="tv-tools-dd" id="tv-layout-dd">' +
        '<button class="tv-tools-btn" type="button">' +
          '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10v10H3z"/><path d="M3 6h10M6 3v10"/></svg>' +
          '<span>Layouts</span>' + chev +
        '</button>' +
        '<div class="tv-tools-menu wide" hidden>' + layoutMenu + '</div>' +
      '</div>' +
      '<button class="tv-tools-clear" type="button" id="tv-clear-draw" title="Remove all drawings from the chart">Clear drawings</button>';

    // Insert immediately after the toolbar (above the chart container)
    var toolbar = shell.querySelector('.tv-toolbar');
    if (toolbar && toolbar.nextSibling) shell.insertBefore(row, toolbar.nextSibling);
    else shell.appendChild(row);

    // Indicator checkboxes — toggle on/off
    row.querySelectorAll('input[type="checkbox"][data-ind]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleIndicator(cb.getAttribute('data-ind'));
      });
    });

    // Gear buttons — toggle the inline settings panel for that indicator
    row.querySelectorAll('button[data-gear]').forEach(function (g) {
      g.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var id = g.getAttribute('data-gear');
        var panel = row.querySelector('.tv-tools-settings[data-settings="' + id + '"]');
        if (!panel) return;
        // Snap inputs to currently-applied values (custom or default)
        var applied = (state.indicatorParams && state.indicatorParams[id]) || INDICATOR_DEFS[id].defaultParams;
        panel.querySelectorAll('input[data-param]').forEach(function (inp, i) {
          if (applied && applied[i] != null) inp.value = applied[i];
        });
        // Close all other open settings panels (one open at a time)
        row.querySelectorAll('.tv-tools-settings').forEach(function (p) {
          if (p !== panel) p.hidden = true;
        });
        panel.hidden = !panel.hidden;
      });
    });

    // Apply / Reset inside each settings panel
    row.querySelectorAll('button[data-apply]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var id = btn.getAttribute('data-apply');
        var inputs = row.querySelectorAll('input[data-param="' + id + '"]');
        var values = Array.prototype.map.call(inputs, function (inp) { return inp.value; });
        applyIndicatorParams(id, values);
        // Auto-enable the indicator if the user changes params on a row
        // that's currently off — matches what TradingView does.
        if (!state.activeIndicators[id]) {
          addIndicator(id);
          updateIndicatorMenu();
        }
      });
    });
    row.querySelectorAll('button[data-reset]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var id = btn.getAttribute('data-reset');
        resetIndicatorParams(id);
        var defaults = INDICATOR_DEFS[id].defaultParams || [];
        row.querySelectorAll('input[data-param="' + id + '"]').forEach(function (inp, i) {
          inp.value = defaults[i] != null ? defaults[i] : '';
        });
      });
    });

    // Drawing tool buttons — start a new overlay draw
    row.querySelectorAll('button[data-draw]').forEach(function (btn) {
      btn.addEventListener('click', function () { startDrawing(btn.getAttribute('data-draw')); });
    });

    // Clear-all-drawings button
    var clearBtn = $('tv-clear-draw');
    if (clearBtn) clearBtn.addEventListener('click', clearDrawings);

    // Layout: Save updates the currently loaded layout in place. If
    // there's no current layout, it falls back to Save As semantics so
    // the user is never blocked.
    var saveBtn = $('tv-layout-save');
    if (saveBtn) {
      saveBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        if (state.currentLayoutName && findLayout(state.currentLayoutName)) {
          saveCurrentLayout();
        } else {
          // No current layout — promote the input into a Save-As prompt.
          var inp = $('tv-layout-name');
          var name = inp ? inp.value : '';
          if (!name || !name.trim()) {
            if (inp) { inp.focus(); inp.placeholder = 'Name your layout, then Enter\u2026'; }
            return;
          }
          if (saveAsLayout(name) && inp) inp.value = '';
        }
      });
    }
    // Layout: Save As always creates a new entry under the typed name.
    var saveAsBtn = $('tv-layout-saveas');
    if (saveAsBtn) {
      saveAsBtn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        var inp = $('tv-layout-name');
        var name = inp ? inp.value : '';
        if (!name || !name.trim()) {
          if (inp) { inp.focus(); inp.placeholder = 'Name required for Save As\u2026'; }
          return;
        }
        if (saveAsLayout(name) && inp) inp.value = '';
      });
    }
    // Enter in the name input is "Save As" (it's the only action that
    // uses the name field — Save uses the currentLayoutName).
    var nameInp = $('tv-layout-name');
    if (nameInp) {
      nameInp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); saveAsBtn && saveAsBtn.click(); }
      });
    }

    // Layout: Load + Delete via event delegation. Bound ONCE to the
    // list container; survives every refreshLayoutMenu() innerHTML swap
    // (which would otherwise nuke any per-row listeners attached during
    // the previous render). Click target may be a child <span> inside
    // the load button — closest() finds the actual button either way.
    var listEl = $('tv-layout-list');
    if (listEl) {
      listEl.addEventListener('click', function (ev) {
        // Default-toggle star: clicking turns this layout into the one
        // that auto-loads on page open. Clicking the currently-default
        // entry clears it.
        var starBtn = ev.target && ev.target.closest && ev.target.closest('button[data-star]');
        if (starBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          setDefaultLayout(starBtn.getAttribute('data-star'));
          return;
        }
        var loadBtn = ev.target && ev.target.closest && ev.target.closest('button[data-load]');
        if (loadBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          loadLayout(loadBtn.getAttribute('data-load'));
          return;
        }
        var delBtn = ev.target && ev.target.closest && ev.target.closest('button[data-del]');
        if (delBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          var nm = delBtn.getAttribute('data-del');
          var safeNm = String(nm).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          customConfirm(
            'Delete layout <b>' + safeNm + '</b>?' +
            '<span class="tv-confirm-meta">This cannot be undone.</span>',
            { title: 'Delete layout', confirmLabel: 'Delete' }
          ).then(function (yes) { if (yes) deleteLayout(nm); });
        }
      });
    }

    // Dropdown open/close (each button toggles its own menu, closes others)
    ['tv-ind-dd', 'tv-draw-dd', 'tv-layout-dd'].forEach(function (id) {
      var dd = $(id);
      if (!dd) return;
      var btn = dd.querySelector('.tv-tools-btn');
      var menu = dd.querySelector('.tv-tools-menu');
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var isOpen = !menu.hidden;
        closeDropdowns();
        menu.hidden = isOpen;
        dd.classList.toggle('open', !isOpen);
        // Repaint the Layouts dropdown on every open so the "saved Xs
        // ago" badges show truthful relative times (a layout saved 30s
        // ago shouldn't still read "just now" five minutes later).
        if (id === 'tv-layout-dd' && !isOpen) refreshLayoutMenu();
      });
    });

    // Outside-click closes any open tools dropdown
    document.addEventListener('pointerdown', function (ev) {
      if (!ev.target.closest('.tv-tools-dd')) closeDropdowns();
    }, true);
  }

  function closeDropdowns() {
    document.querySelectorAll('.tv-tools-row .tv-tools-menu').forEach(function (m) { m.hidden = true; });
    document.querySelectorAll('.tv-tools-row .tv-tools-dd').forEach(function (dd) { dd.classList.remove('open'); });
    // Collapse any open settings panels too — keeps the next reopen tidy.
    document.querySelectorAll('.tv-tools-row .tv-tools-settings').forEach(function (p) { p.hidden = true; });
  }

  function updateIndicatorMenu() {
    document.querySelectorAll('.tv-tools-row input[data-ind]').forEach(function (cb) {
      cb.checked = !!state.activeIndicators[cb.getAttribute('data-ind')];
    });
  }

  // Push the currently-applied calcParams back into the visible <input>s
  // (used after applyLayout so the gear panels reflect the loaded layout).
  function syncIndicatorSettingsValues() {
    Object.keys(INDICATOR_DEFS).forEach(function (id) {
      var def = INDICATOR_DEFS[id];
      if (def.custom || !def.defaultParams) return;
      var applied = (state.indicatorParams && state.indicatorParams[id]) || def.defaultParams;
      var inputs = document.querySelectorAll('.tv-tools-row input[data-param="' + id + '"]');
      Array.prototype.forEach.call(inputs, function (inp, i) {
        if (applied && applied[i] != null) inp.value = applied[i];
      });
    });
  }

  // ── Styled confirmation modal (replaces the OS window.confirm) ───
  // Returns a promise that resolves true (confirm) / false (cancel).
  // Esc cancels, Enter confirms, click on backdrop cancels.
  function customConfirm(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var backdrop = document.createElement('div');
      backdrop.className = 'tv-confirm-backdrop';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      var icon =
        '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M3 6h14M8 6V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M5 6l1 11a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-11"/>' +
          '<path d="M9 10v5M11 10v5"/>' +
        '</svg>';
      backdrop.innerHTML =
        '<div class="tv-confirm-dialog">' +
          '<div class="tv-confirm-head">' +
            '<span class="tv-confirm-icon">' + icon + '</span>' +
            '<span class="tv-confirm-title">' + (opts.title || 'Confirm') + '</span>' +
          '</div>' +
          '<div class="tv-confirm-msg">' + message + '</div>' +
          '<div class="tv-confirm-actions">' +
            '<button type="button" class="tv-confirm-btn tv-confirm-cancel">' + (opts.cancelLabel || 'Cancel') + '</button>' +
            '<button type="button" class="tv-confirm-btn tv-confirm-yes">' + (opts.confirmLabel || 'Delete') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(backdrop);

      var cancelBtn = backdrop.querySelector('.tv-confirm-cancel');
      var yesBtn    = backdrop.querySelector('.tv-confirm-yes');

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        resolve(result);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
        else if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
      }
      cancelBtn.addEventListener('click', function () { close(false); });
      yesBtn.addEventListener('click', function () { close(true); });
      backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(false); });
      document.addEventListener('keydown', onKey, true);

      // Focus the destructive action so Enter == confirm. Defer one tick
      // so the click that opened the modal doesn't immediately fire on it.
      setTimeout(function () { yesBtn.focus(); }, 0);
    });
  }

  // Re-render the saved-layouts list inside the Layouts dropdown plus
  // the row of action buttons above it (Save / Save As) and the
  // autosave badge. Triggered after every save/delete/setDefault and
  // also when the dropdown is opened (so timestamps stay fresh).
  //
  // The list click handler is delegated (attached once in buildToolsRow)
  // so we only need to swap innerHTML here — no per-row addEventListener
  // dance, no chance of stale handlers firing on re-renders.
  function refreshLayoutMenu() {
    // ── 1. Save button state ──
    // "Save" is the primary action (filled, bull-green) only when we
    // actually have a current layout to overwrite — otherwise it's
    // visually demoted to ghost so "Save As" reads as the primary.
    var saveBtn = $('tv-layout-save');
    var saveAsBtn = $('tv-layout-saveas');
    var current = state.currentLayoutName && findLayout(state.currentLayoutName) ? state.currentLayoutName : null;
    if (saveBtn) {
      if (current) {
        saveBtn.classList.remove('ghost');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save \u201c' + (current.length > 14 ? current.slice(0, 13) + '\u2026' : current) + '\u201d';
        saveBtn.title = 'Update \u201c' + current + '\u201d in place (\u2318S)';
      } else {
        saveBtn.classList.add('ghost');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        saveBtn.title = 'No layout loaded \u2014 type a name and use Save As';
      }
    }
    if (saveAsBtn) {
      // Save As becomes the primary when there's no current.
      saveAsBtn.classList.toggle('ghost', !!current);
    }

    // ── 2. Autosave badge ──
    updateAutosaveBadge();

    // ── 3. Layouts button label (shows current layout name) ──
    var ddBtn = document.querySelector('#tv-layout-dd .tv-tools-btn span');
    if (ddBtn) {
      ddBtn.textContent = current ? 'Layouts \u00B7 ' + current : 'Layouts';
    }

    // ── 4. Saved-layouts list ──
    var listEl = $('tv-layout-list');
    if (!listEl) return;
    var layouts = loadAllLayouts();
    if (!layouts.length) {
      listEl.innerHTML = '<div class="tv-tools-empty">No saved layouts yet.<br>Customise the chart, then <b>Save As</b> to keep a snapshot.</div>';
      return;
    }
    listEl.innerHTML = layouts.map(function (l) {
      var safeName = String(l.name).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var indCount = (l.indicators || []).length;
      var ovCount  = (l.overlays || []).length;
      // updatedAt may be missing on freshly-migrated v1 rows; createdAt
      // is the fallback so the badge never says "ago undefined".
      var when = l.updatedAt || l.createdAt || 0;
      var ts = when ? '\u00B7 ' + formatRelativeTime(when) : '';
      var meta = (l.timeframe || '?') + ' \u00B7 ' + indCount + ' ind \u00B7 ' + ovCount + ' draw ' + ts;
      var isCurrent = state.currentLayoutName === l.name;
      var isDefault = !!l.isDefault;
      var starGlyph = isDefault ? '\u2605' : '\u2606';
      var starTitle = isDefault
        ? 'Default \u2014 click to clear (no layout will auto-load on open)'
        : 'Make this the default (auto-load on chart open)';
      return '<div class="tv-tools-layout-row' +
               (isCurrent ? ' is-current' : '') +
               (isDefault ? ' is-default' : '') + '">' +
               '<button type="button" class="tv-tools-layout-star" data-star="' + safeName + '" title="' + starTitle + '" aria-label="' + starTitle + '">' + starGlyph + '</button>' +
               '<button type="button" class="tv-tools-layout-load" data-load="' + safeName + '" title="Load this layout">' +
                 '<span class="tv-tools-layout-name">' + safeName +
                   (isCurrent ? '<span class="tv-tools-layout-tag">loaded</span>' : '') +
                 '</span>' +
                 '<span class="tv-tools-layout-meta">' + meta + '</span>' +
               '</button>' +
               '<button type="button" class="tv-tools-layout-del" data-del="' + safeName + '" title="Delete this layout" aria-label="Delete">\u2715</button>' +
             '</div>';
    }).join('');
  }

  // ── Update the LTP display in the toolbar ──
  // We compare candle dates in IST (not UTC) so "today" is the trading
  // day, not the UTC calendar day — without this, the change/% display
  // shows 0.00 between 00:00 and 09:15 IST (because candles from the
  // previous IST session don't match today's UTC date prefix).
  function istDateKey(d) {
    var p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    var get = function (t) { var x = p.find(function (o) { return o.type === t; }); return x ? x.value : ''; };
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  function updateLTP() {
    var c = state.candles;
    if (!c.length) { $('tv-ltp').style.display = 'none'; return; }
    var last = c[c.length - 1];
    // LTP VALUE = authoritative Upstox LTP when we have it (so the
    // value stays IDENTICAL across TF switches — a 1m chart and a
    // 1D chart should show the same current Nifty price, not the
    // close of whatever bar happens to be last in that TF). Falls
    // back to the chart's last bar close only on first ever load
    // before fetchAuthoritativeSpot has completed.
    var authoritativeLtp = (typeof window.paperTradeGetLastSpot === 'function')
      ? window.paperTradeGetLastSpot() : null;
    var ltp = (authoritativeLtp != null) ? authoritativeLtp : +last[4];
    // CHANGE = LTP vs today's session open. session open is read
    // from today's first bar's open; if the current TF has no
    // today bar (e.g. weekend on 5m, or a 1D chart on Saturday
    // where the most recent bar is Friday), fall back to the
    // last bar's open so the change still reflects "the last
    // shown bar's intraday move".
    var sessionOpen = +last[1];   // safe fallback
    var todayKey = istDateKey(new Date());
    for (var i = 0; i < c.length; i++) {
      if (istDateKey(new Date(c[i][0])) === todayKey) {
        sessionOpen = +c[i][1]; break;
      }
    }
    var change = ltp - sessionOpen;
    var pct = sessionOpen > 0 ? (change / sessionOpen) * 100 : 0;
    var color = change >= 0 ? 'var(--bull)' : 'var(--bear)';
    var arrow = change >= 0 ? '\u25B2' : '\u25BC';

    var v = $('tv-ltp-val'), ch = $('tv-ltp-change'), wrap = $('tv-ltp');
    if (!v || !ch || !wrap) return;
    v.textContent = ltp.toFixed(2);
    v.style.color = color;
    ch.innerHTML = arrow + ' ' + Math.abs(change).toFixed(2) + ' (' + Math.abs(pct).toFixed(2) + '%)';
    ch.style.color = color;
    wrap.style.display = 'flex';
  }

  // ═══════════════════════════════════════════════════════════════════
  // BAR-CLOSE COUNTDOWN — "time left in the current candle"
  // ═══════════════════════════════════════════════════════════════════
  // TradingView and Upstox both surface this next to the price axis: it
  // tells the trader how many seconds until the current bar prints and
  // a new one opens. Critical for entry/exit timing — most playbooks
  // (CPR breakout, ORB, BoS retest) trigger on a CLOSE, not on a wick,
  // so knowing whether you have 4 minutes or 4 seconds left changes
  // whether you front-run, wait for confirmation, or skip the trade.
  //
  // Math: for intraday timeframes we use the exact same session-aligned
  // bucket boundaries the chart paints (09:15 IST anchor) so the
  // countdown ticks down to zero exactly when the chart drops the
  // open candle and opens a new one — no off-by-one against the bar
  // grid the user is staring at. For 1D we count down to the NSE
  // close (15:30 IST) since "next IST midnight" isn't what a trader
  // cares about — the daily candle's effective close is 15:30.

  // Returns seconds remaining until the current bar closes, or null when
  // we shouldn't show anything (market closed, no timeframe selected,
  // weekend on 1D). Pure function — read-only on `state` and clock.
  function barCloseCountdownSec() {
    var tf = TF[state.timeframe];
    if (!tf) return null;
    var ist = nowIST();
    var weekend = (ist.weekday === 'Sat' || ist.weekday === 'Sun');

    if (state.timeframe === '1d') {
      // Daily: count down to market close (15:30 IST) on weekdays.
      // Outside the 09:15–15:30 weekday window there is no "in-progress
      // daily candle" to count down — hide the chip.
      if (weekend) return null;
      var marketOpenMin = 9 * 60 + 15;
      var marketCloseMin = 15 * 60 + 30;
      if (ist.minOfDay < marketOpenMin) return null;
      if (ist.minOfDay >= marketCloseMin) return null;
      // Second-level precision: derive seconds-of-day in IST from the
      // wall clock, not just minOfDay (which has 1-min resolution).
      var nowSecIst = (Math.floor(Date.now() / 1000) + IST_OFFSET_SEC) % 86400;
      return Math.max(0, marketCloseMin * 60 - nowSecIst);
    }

    // Intraday: hide outside market hours — there's no live bar in
    // progress, so the number would just be misleading.
    if (!isMarketOpen()) return null;

    var nowSec = Math.floor(Date.now() / 1000);
    var bucketSec = tf.bucketMs / 1000;
    var bucketStart = bucketStartSec(nowSec, bucketSec);
    var bucketEnd = bucketStart + bucketSec;
    return Math.max(0, bucketEnd - nowSec);
  }

  // Format seconds as TradingView-style: MM:SS for sub-hour, Hh Mm for
  // multi-hour (the 1D / pre-close stretch). Always returns a stable
  // width so the chip doesn't visibly resize on every tick.
  function fmtBarCountdown(sec) {
    if (sec == null) return '';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Position the countdown chip relative to the chart container.
  // LWC doesn't expose a priceToCoordinate on the main series easily,
  // so we anchor the chip at a fixed right-edge position.
  function positionBarCountdown(el) {
    if (!el || !state.candles || !state.candles.length) return;
    var last = state.candles[state.candles.length - 1];
    var lastClose = +last[4];
    var lastOpen = +last[1];
    if (!isFinite(lastClose)) return;
    var isBear = isFinite(lastOpen) && lastClose < lastOpen;
    el.classList.toggle('tv-countdown-bear', isBear);
    // Use LWC's priceToCoordinate if available
    if (state.candleSeries && typeof state.candleSeries.priceToCoordinate === 'function') {
      try {
        var y = state.candleSeries.priceToCoordinate(lastClose);
        if (isFinite(y) && y > 0) {
          var host = document.getElementById('tv-chart-container');
          var hostH = host ? host.clientHeight : 400;
          var yPos = y + 9;
          if (yPos < 2) yPos = 2;
          if (yPos > hostH - 20) yPos = hostH - 20;
          el.style.top = yPos + 'px';
          return;
        }
      } catch (_) {}
    }
  }

  // Paint the countdown chip. Cheap (DOM read + textContent +
  // convertToPixel), safe to call every 1s. Idempotent — hides itself
  // when there's nothing meaningful to show. The warn class flips on
  // in the final 10s so the trader notices the imminent close.
  function updateBarCountdown() {
    var el = document.getElementById('tv-countdown');
    var val = document.getElementById('tv-countdown-val');
    if (!el || !val) return;
    var sec = barCloseCountdownSec();
    if (sec == null) {
      el.style.display = 'none';
      el.classList.remove('tv-countdown-warn');
      return;
    }
    el.style.display = 'block';
    var text = fmtBarCountdown(sec);
    // textContent assignment is no-op when string is identical, so the
    // browser doesn't repaint on ticks where the value hasn't changed
    // (multi-hour countdown updates only once per minute).
    if (val.textContent !== text) val.textContent = text;
    // Warn pulse for the final 10 seconds of an intraday bar. Skipped
    // on 1D where the multi-hour countdown never enters that window.
    var warn = (state.timeframe !== '1d' && sec <= 10 && sec > 0);
    el.classList.toggle('tv-countdown-warn', warn);
    // Reposition every tick so the chip tracks the LTP as the last
    // candle moves up/down. positionBarCountdown is no-op when the
    // chart or candle data isn't ready — the next tick will catch up.
    positionBarCountdown(el);
  }

  // Single global ticker. Started once on first call; subsequent calls
  // are no-ops. We don't pause this on tab-hide — when the tab is
  // hidden setInterval is throttled to ~1/min anyway, and the
  // visibilitychange handler in the chart pipeline already triggers
  // a full refresh on resume which will repaint this too.
  var _barCountdownTimer = null;
  function startBarCountdownTicker() {
    if (_barCountdownTimer) return;
    updateBarCountdown();
    _barCountdownTimer = setInterval(updateBarCountdown, 1000);
  }

  // ── One-shot authoritative Nifty 50 spot LTP fetch ──────────────
  // Used after every (re)load — even when the market is closed —
  // to refresh the spot displayed in the Key S/R card, the
  // chart footer, and any other consumer of paperTradeTick(ltp).
  //
  // Why this is needed:
  //   When market is closed, pollTick() early-returns (no LTP
  //   request fires). The chart + Key S/R card sit on whatever
  //   the LAST historical-candle bar's close was — which can
  //   drift by a few points from Upstox's authoritative
  //   market-quote/ltp value (their two endpoints don't always
  //   sync on the exact closing tick; historical-candle can
  //   trail by a bar).
  //
  // One-shot only — does NOT install a recurring poll. Single
  // extra API call per load. Silent on failure (we keep the
  // candle-derived spot, which is the previous behaviour).
  // Pad a Date to YYYY-MM-DD in IST. Shared by the 5m fallback below
  // and the rest of the chart module that needs date-string args for
  // Upstox V3's /historical-candle URL. Returns local-date format
  // which the API accepts irrespective of timezone (it expects calendar
  // dates, not timestamps).
  function fmtYmd(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  async function fetchAuthoritativeSpot() {
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) return;
    var token = getToken();
    if (!token) return;
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return;
    var marketClosed = !isMarketOpen();
    // ── Off-hours skip (May 2026) ──
    // If market is closed AND we already have an authoritative
    // spot value (either from a previous fetchAuthoritativeSpot
    // this session, or from paper-trade's getLastSpot), don't
    // refetch. The spot does not change while market is closed,
    // so any refetch wastes API budget and risks rate-limiting.
    if (marketClosed && state.authSpotFetchedThisClosedSession) {
      return;
    }
    if (marketClosed) {
      var existingSpot = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      if (existingSpot != null && isFinite(existingSpot) && existingSpot > 0) {
        // Pin the chart's right-axis price line to whatever we
        // already have and exit — no need to hit Upstox.
        try { updateAuthSpotPriceLine(); } catch (_) {}
        state.authSpotFetchedThisClosedSession = true;
        console.log('[chart] fetchAuthoritativeSpot \u00B7 off-hours skip (existing spot=' + existingSpot + ')');
        return;
      }
    }
    var ikey = encodeURIComponent(INSTRUMENT_KEY);
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

    // ── PRIMARY (market closed) ── Fetch the most recent 5-minute
    // historical bar — its close == the actual closing print Upstox
    // shows in its UI. /market-quote/ltp can return a STALE
    // intraday tick that lingers in their cache after market hours
    // (we've observed it returning a value 30+ points away from
    // the day's official close on Saturdays).
    //
    // ── PRIMARY (market open) ── Skip the 5m fetch and use /ltp
    // directly — during open hours /ltp IS the freshest value
    // (sub-second), and the 5m bar lags up to 5 minutes.
    //
    // Either way we fall back to /ltp if the 5m path fails so
    // we never end up with no spot at all.
    var bestPrice = null;
    var bestSource = null;

    if (marketClosed) {
      // Strategy: fetch 1-minute bars (most granular = highest
      // chance of capturing the actual closing tick) via BOTH the
      // /historical-candle and /historical-candle/intraday paths.
      // Upstox returns different subsets through each endpoint on
      // non-trading days:
      //   - /historical-candle/{ikey}/minutes/1/{to}/{from} may
      //     omit the most recent trading day's intraday bars when
      //     `to` = a non-trading day (e.g. Saturday).
      //   - /historical-candle/intraday/{ikey}/minutes/1 returns
      //     the LAST TRADING DAY'S intraday bars on non-trading
      //     days. This bar's close == the actual market close
      //     (what Upstox UI shows).
      // Merging both and picking the bar with the latest timestamp
      // guarantees the closing print regardless of which endpoint
      // returned it. Falls through to /ltp if both fail (e.g. 429
      // / network).
      try {
        var to = new Date();
        var from = new Date();
        from.setDate(to.getDate() - 5); // 5 days covers any weekend / Friday→Mon
        var hist1Url = V3 + '/historical-candle/' + ikey + '/minutes/1/'
          + fmtYmd(to) + '/' + fmtYmd(from);
        var intra1Url = V3 + '/historical-candle/intraday/' + ikey + '/minutes/1';
        console.log('[chart] fetchAuthoritativeSpot \u00B7 1m hist=' + hist1Url);
        console.log('[chart] fetchAuthoritativeSpot \u00B7 1m intra=' + intra1Url);
        var pair = await Promise.all([
          fetch(hist1Url, { headers: headers }).then(function (r) {
            return r && r.ok ? r.json() : null;
          }).catch(function (e) {
            console.warn('[chart] fetchAuthoritativeSpot 1m hist fetch failed:', e && e.message);
            return null;
          }),
          fetch(intra1Url, { headers: headers }).then(function (r) {
            return r && r.ok ? r.json() : null;
          }).catch(function (e) {
            console.warn('[chart] fetchAuthoritativeSpot 1m intra fetch failed:', e && e.message);
            return null;
          })
        ]);
        var allBars = [];
        var histLen = 0, intraLen = 0;
        if (pair[0] && pair[0].data && pair[0].data.candles) {
          histLen = pair[0].data.candles.length;
          allBars = allBars.concat(pair[0].data.candles);
        }
        if (pair[1] && pair[1].data && pair[1].data.candles) {
          intraLen = pair[1].data.candles.length;
          allBars = allBars.concat(pair[1].data.candles);
        }
        console.log('[chart] fetchAuthoritativeSpot \u00B7 1m bars: hist=' + histLen + ' intra=' + intraLen);
        if (allBars.length) {
          // Pick the row whose timestamp is most recent regardless
          // of order (Upstox endpoints can disagree on ordering).
          var newest = allBars[0];
          var newestMs = new Date(allBars[0][0]).getTime();
          for (var i = 1; i < allBars.length; i++) {
            var ms = new Date(allBars[i][0]).getTime();
            if (ms > newestMs) { newest = allBars[i]; newestMs = ms; }
          }
          var px = +newest[4];
          if (isFinite(px) && px > 0) {
            bestPrice = px;
            bestSource = '1m-bar@' + new Date(newestMs).toISOString();
            console.log('[chart] fetchAuthoritativeSpot \u00B7 picked newest 1m bar:',
              new Date(newestMs).toISOString(), 'close=' + px);
          }
        }
      } catch (e) {
        console.warn('[chart] fetchAuthoritativeSpot 1m path threw:', e && e.message);
        /* fall through to /ltp */
      }
    }

    // /ltp fallback (or primary during market hours).
    if (bestPrice == null) {
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      try {
        var url = V2 + '/market-quote/ltp?instrument_key=' + ikey;
        var r = await fetch(url, { headers: headers });
        if (r.status === 429) {
          if (window._upstoxNote429) window._upstoxNote429('chart-spot-bootstrap');
          return;
        }
        if (!r.ok) return;
        var d = await r.json();
        var rec = d && d.data && Object.values(d.data)[0];
        if (!rec) return;
        var ltp = +rec.last_price;
        if (!isFinite(ltp) || ltp <= 0) return;
        bestPrice = ltp;
        bestSource = 'ltp';
      } catch (_) {
        return;
      }
    }

    if (bestPrice == null) return;
    if (window._upstoxNoteOk) window._upstoxNoteOk();
    // Mark the off-hours single-fetch latch so subsequent calls
    // skip the network entirely. Reset by pollTick when the
    // market re-opens (state.authSpotFetchedThisClosedSession =
    // false at that boundary).
    if (marketClosed) state.authSpotFetchedThisClosedSession = true;
    console.log('[chart] authoritative spot:', bestPrice,
                '(source=' + bestSource + ',',
                marketClosed ? 'market closed)' : 'market open)');
    // Persist on the chart module so consumers can read it too.
    state.lastLtp = bestPrice;
    // Cascade: paperTradeTick → intradayLiveTick → renderKeySr
    // and friends. paperTradeTick is the canonical entry point;
    // it fans out to every downstream consumer.
    if (typeof window.paperTradeTick === 'function') {
      try { window.paperTradeTick(bestPrice); } catch (_) {}
    }
    // Repaint the chart-toolbar LTP. updateLTP() now prefers the
    // authoritative spot we just persisted, so this swaps any
    // stale bar-close value (shown briefly during the async
    // fetch window) with the live LTP. Without this, the
    // toolbar would keep showing the bar close until the next
    // poll tick / TF switch.
    try { updateLTP(); } catch (_) {}
    // Pin the CHART CANVAS's right-axis last-price tag to the
    // authoritative LTP as well — see pinChartLastPriceToAuthLtp
    // for why (TF-dependent last-bar close mismatches Upstox).
    pinChartLastPriceToAuthLtp();
    // Refresh the chart footer's "Last close" to match the
    // authoritative LTP (only matters when market is closed —
    // when open, pollTick rewrites the footer every 2s anyway).
    if (marketClosed) {
      var foot = $('tv-foot-info');
      if (foot) {
        var ltpStr = bestPrice.toLocaleString('en-IN', { maximumFractionDigits: 2 });
        foot.textContent = 'Market closed \u00B7 ' + nextOpenLabel()
          + ' \u00B7 Last close: \u20B9' + ltpStr;
      }
    }
  }

  // ── Process a spot LTP tick (shared by HTTP poll and WebSocket) ──
  function processSpotLtp(ltp) {
    if (!state.chartReady || !state.candles.length) return;
    if (!isFinite(ltp) || ltp <= 0) return;

    var tf = TF[state.timeframe];
    var nowSec = Math.floor(Date.now() / 1000);
    var lastCandle = state.candles[state.candles.length - 1];
    var lastT = Math.floor(new Date(lastCandle[0]).getTime() / 1000);
    var bucketSec = tf.bucketMs / 1000;
    var nowBucket = bucketStartSec(nowSec, bucketSec);

    if (nowBucket > lastT) {
      var bucketsAhead = Math.round((nowBucket - lastT) / bucketSec);
      if (bucketsAhead >= 3) {
        console.log('[chart] tick gap detected (' + bucketsAhead + ' buckets) \u2014 silent refetch');
        silentRefetch();
      } else {
        var newIso = new Date(nowBucket * 1000).toISOString();
        var newCandle = [newIso, ltp, ltp, ltp, ltp, 0, 0];
        state.candles.push(newCandle);
        if (state.candleSeries) state.candleSeries.update(toKline(newCandle));
        if (state.volumeSeries) state.volumeSeries.update(toVolume(newCandle));
      }
    } else {
      if (ltp > +lastCandle[2]) lastCandle[2] = ltp;
      if (ltp < +lastCandle[3]) lastCandle[3] = ltp;
      lastCandle[4] = ltp;
      if (state.candleSeries) state.candleSeries.update(toKline(lastCandle));
      if (state.volumeSeries) state.volumeSeries.update(toVolume(lastCandle));
    }

    if (nowSec * 1000 - state.lastSyncTs > 60000) {
      silentRefetch();
    }

    updateLTP();
    if (typeof window.paperTradeTick === 'function') window.paperTradeTick(ltp);
    updateAuthSpotPriceLine();

    var src = state.wsConnected ? 'WebSocket \u00B7 Real-time' : 'Upstox API \u00B7 Polling every 2s';
    var t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
    var el = $('tv-foot-info');
    if (el) el.textContent = 'Last tick: ' + t + ' IST  \u00B7  ' + src;
    setStatus('live', state.wsConnected ? 'WS LIVE' : 'LIVE');

    if (state.authSpotFetchedThisClosedSession) {
      state.authSpotFetchedThisClosedSession = false;
    }
  }

  // ── Poll latest LTP and update the latest candle (HTTP fallback) ──
  async function pollTick() {
    window._lastPollTickTs = Date.now();
    if (typeof window.pollTick !== 'function') window.pollTick = pollTick;
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) return;
    // WebSocket is handling ticks — skip the HTTP round-trip entirely.
    // pollTick still fires on its interval to maintain _lastPollTickTs
    // (the rAF heartbeat reads it) but short-circuits here.
    if (state.wsConnected) return;
    var token = getToken();
    if (!token) return;
    if (!state.chartReady || !state.candles.length) return;
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return;

    if (!isMarketOpen()) {
      setStatus('closed', 'MARKET CLOSED');
      var foot = $('tv-foot-info');
      if (foot) {
        var authLtp = (typeof window.paperTradeGetLastSpot === 'function')
          ? window.paperTradeGetLastSpot() : null;
        var lastCloseVal = (authLtp != null) ? authLtp
          : +state.candles[state.candles.length - 1][4];
        var lastClose = lastCloseVal.toLocaleString('en-IN', { maximumFractionDigits: 2 });
        foot.textContent = 'Market closed \u00B7 ' + nextOpenLabel()
          + ' \u00B7 Last close: \u20B9' + lastClose;
      }
      if (state.pollIntervalMs !== 60000) {
        state.pollIntervalMs = 60000;
        startPolling();
      }
      return;
    }

    if (window._upstoxBucket && !window._upstoxBucket.tryAcquire()) return;

    try {
      var url = V2 + '/market-quote/ltp?instrument_key=' + encodeURIComponent(INSTRUMENT_KEY);
      var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
      if (r.status === 429) {
        if (window._upstoxNote429) window._upstoxNote429('chart-pollTick');
        return;
      }
      if (!r.ok) return;
      var d = await r.json();
      var rec = d && d.data && Object.values(d.data)[0];
      if (!rec) return;
      var ltp = +rec.last_price;
      if (window._upstoxNoteOk) window._upstoxNoteOk();

      processSpotLtp(ltp);

      if (state.pollIntervalMs !== 2000) {
        state.pollIntervalMs = 2000;
        startPolling();
      }
    } catch (e) {
      // silent — keep last good state
    }
  }

  // Quietly re-fetch authoritative candles from Upstox and merge them
  // into state.candles WITHOUT triggering the loader or status changes
  // a full loadAndRender does. Used for two purposes:
  //   1. Gap recovery: when pollTick detects 3+ missed buckets (overnight,
  //      weekend, suspended tab) we don't trust local LTP synthesis to
  //      fill that gap — we ask Upstox for the real candles.
  //   2. Periodic resync: once a minute we replace the locally-patched
  //      in-progress candle with Upstox's authoritative version so true
  //      OPEN and VOLUME values land in state instead of our LTP-seeded
  //      placeholders.
  // Re-entrancy guarded by state.silentRefetchInFlight so back-to-back
  // pollTicks never stack two simultaneous fetches.
  async function silentRefetch() {
    if (state.silentRefetchInFlight) return;
    if (!state.chart || !state.chartReady) return;
    // Honour the global throttle gate — if any other Upstox caller
    // recently saw a 429, sit out the cooldown instead of piling on.
    // Also stamps lastSyncTs so the 60s "periodic resync" gate in
    // pollTick doesn't immediately re-fire on the next tick. Before
    // this gate was added, a 429 left lastSyncTs at its old value,
    // so the 60s check stayed "expired" → silentRefetch fired on
    // EVERY 2s pollTick → cascade of 429s every 2s until cooldown.
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) {
      state.lastSyncTs = Date.now();
      return;
    }
    state.silentRefetchInFlight = true;
    try {
      var fresh = await fetchHistorical();
      if (!fresh || !fresh.length) {
        // Empty result usually means 429 / network blip — pretend the
        // resync just happened so the 60s gate restarts. Without this
        // the next pollTick will see lastSyncTs as still-expired and
        // immediately try again (the very behaviour that caused the
        // 429 cascade in the first place).
        state.lastSyncTs = Date.now();
        return;
      }
      // Authoritative cut-over: keep every server candle, then append
      // any LOCAL-only candles whose bucket is strictly newer than the
      // server's last candle (covers the 0-60s race where pollTick has
      // already opened the next bucket but Upstox hasn't published it
      // yet). This way server is always the source of truth for buckets
      // it knows about, and we never lose our forward-leaning candle.
      var serverLastMs = new Date(fresh[fresh.length - 1][0]).getTime();
      var localTail = state.candles.filter(function (c) {
        return new Date(c[0]).getTime() > serverLastMs;
      });
      state.candles = fresh.concat(localTail);
      state.tfCache[INSTRUMENT_KEY + '|' + state.timeframe] = {
        candles: state.candles, at: Date.now()
      };
      persistTfCache(state.tfCache);
      state.lastSyncTs = Date.now();
      // Re-apply through our wrapper so a Klinecharts-internal indicator
      // calc throw doesn't silently leave the chart on stale data.
      applyChartData(state.candles, 'silent-refetch', state.timeframe);
    } catch (e) {
      // Network blip / 429 / token expired — leave local state alone
      // BUT stamp lastSyncTs so the next pollTick's 60s gate doesn't
      // immediately re-trigger us. The global _upstoxNote429 gate
      // (set in fetchHistorical's fetchOne above) handles 429-specific
      // back-off; this stamp just keeps non-429 transient failures
      // from also looping every 2s.
      console.warn('[chart] silentRefetch failed silently', e && e.message);
      state.lastSyncTs = Date.now();
    } finally {
      state.silentRefetchInFlight = false;
    }
  }

  function startPolling() {
    stopPolling();
    // 2 s baseline (was 1 s) so chart-poll + option-poll combined stay
    // under Upstox's 30-min request budget. Overnight/closed-market
    // throttling still kicks in via pollTick → state.pollIntervalMs.
    var ms = state.pollIntervalMs || 2000;
    state.pollTimer = setInterval(pollTick, ms);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  // ═══════════════════════════════════════════════════════════════════
  // UPSTOX V3 WEBSOCKET REAL-TIME FEED
  // ═══════════════════════════════════════════════════════════════════
  // Replaces HTTP LTP polling with a persistent WebSocket connection.
  // The feed delivers protobuf-encoded ticks at sub-second latency —
  // matching TradingView / Upstox's own terminal.
  //
  // Lifecycle:
  //   1. loadAndRender completes → startWebSocket()
  //   2. Load protobufjs from CDN (lazy, cached by SW)
  //   3. Parse Upstox proto schema (inline, one-time)
  //   4. GET /v3/feed/market-data-feed/authorize → wss:// URL
  //   5. Connect WebSocket → subscribe NSE_INDEX|Nifty 50 (ltpc mode)
  //   6. On binary message → protobuf decode → processSpotLtp(ltp)
  //   7. On close → auto-reconnect with exponential backoff
  //
  // Fallback: if WS fails or protobuf isn't available, HTTP polling
  // continues as before (pollTick checks state.wsConnected).

  var WS_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

  var UPSTOX_PROTO_TEXT = [
    'syntax = "proto3";',
    'message LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }',
    'message MarketLevel { repeated Quote bidAskQuote = 1; }',
    'message MarketOHLC { repeated OHLC ohlc = 1; }',
    'message Quote { int64 bidQ = 1; double bidP = 2; int64 askQ = 3; double askP = 4; }',
    'message OptionGreeks { double delta = 1; double theta = 2; double gamma = 3; double vega = 4; double rho = 5; }',
    'message OHLC { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }',
    'enum Type { initial_feed = 0; live_feed = 1; market_info = 2; }',
    'message MarketFullFeed { LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3; MarketOHLC marketOHLC = 4; double atp = 5; int64 vtt = 6; double oi = 7; double iv = 8; double tbq = 9; double tsq = 10; }',
    'message IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }',
    'message FullFeed { oneof FullFeedUnion { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }',
    'message FirstLevelWithGreeks { LTPC ltpc = 1; Quote firstDepth = 2; OptionGreeks optionGreeks = 3; int64 vtt = 4; double oi = 5; double iv = 6; }',
    'enum RequestMode { ltpc = 0; full_d5 = 1; option_greeks = 2; full_d30 = 3; }',
    'message Feed { oneof FeedUnion { LTPC ltpc = 1; FullFeed fullFeed = 2; FirstLevelWithGreeks firstLevelWithGreeks = 3; } RequestMode requestMode = 4; }',
    'enum MarketStatus { PRE_OPEN_START = 0; PRE_OPEN_END = 1; NORMAL_OPEN = 2; NORMAL_CLOSE = 3; CLOSING_START = 4; CLOSING_END = 5; }',
    'message MarketInfo { map<string, string> segmentStatus = 1; }',
    'message FeedResponse { Type type = 1; map<string, Feed> feeds = 2; int64 currentTs = 3; MarketInfo marketInfo = 4; }'
  ].join('\n');

  function ensureProtoType(cb) {
    if (state.wsFeedResponseType) { cb(state.wsFeedResponseType); return; }
    if (!window.protobuf || !window.protobuf.parse) { cb(null); return; }
    try {
      var parsed = window.protobuf.parse(UPSTOX_PROTO_TEXT, { keepCase: true });
      state.wsFeedResponseType = parsed.root.lookupType('FeedResponse');
      cb(state.wsFeedResponseType);
    } catch (e) {
      console.warn('[ws] proto parse failed:', e && e.message);
      cb(null);
    }
  }

  function wsDisconnect() {
    state.wsConnected = false;
    if (state.ws) {
      try { state.ws.close(); } catch (_) {}
      state.ws = null;
    }
    if (state.wsReconnectTimer) {
      clearTimeout(state.wsReconnectTimer);
      state.wsReconnectTimer = null;
    }
    if (state.wsSyncTimer) {
      clearInterval(state.wsSyncTimer);
      state.wsSyncTimer = null;
    }
  }

  function wsScheduleReconnect() {
    if (state.wsReconnectTimer) return;
    var delay = WS_RECONNECT_DELAYS[
      Math.min(state.wsReconnectAttempt, WS_RECONNECT_DELAYS.length - 1)
    ];
    state.wsReconnectAttempt++;
    console.log('[ws] reconnecting in ' + delay + 'ms (attempt ' + state.wsReconnectAttempt + ')');
    state.wsReconnectTimer = setTimeout(function () {
      state.wsReconnectTimer = null;
      startWebSocket();
    }, delay);
  }

  async function startWebSocket() {
    var token = getToken();
    if (!token) return;
    if (!isMarketOpen()) return;
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) return;

    wsDisconnect();

    loadProtobuf(function () {
      if (!window.protobuf || !window.protobuf.parse) {
        console.warn('[ws] protobuf.js not available \u2014 staying on HTTP polling');
        return;
      }

      ensureProtoType(function (FeedResponse) {
        if (!FeedResponse) {
          console.warn('[ws] proto type not available \u2014 staying on HTTP polling');
          return;
        }
        wsAuthorizeAndConnect(token, FeedResponse);
      });
    });
  }

  async function wsAuthorizeAndConnect(token, FeedResponse) {
    try {
      var authUrl = V3 + '/feed/market-data-feed/authorize';
      var authRes = await fetch(authUrl, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      if (!authRes.ok) {
        console.warn('[ws] authorize failed: HTTP ' + authRes.status);
        wsScheduleReconnect();
        return;
      }
      var authData = await authRes.json();
      var wsUrl = authData && authData.data &&
        (authData.data.authorizedRedirectUri || authData.data.authorized_redirect_uri);
      if (!wsUrl) {
        console.warn('[ws] no WebSocket URL in authorize response');
        wsScheduleReconnect();
        return;
      }

      console.log('[ws] connecting to', wsUrl.substring(0, 60) + '...');
      var ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      state.ws = ws;

      ws.onopen = function () {
        console.log('[ws] connected \u2014 subscribing to ' + INSTRUMENT_KEY);
        state.wsConnected = true;
        state.wsReconnectAttempt = 0;

        var subMsg = JSON.stringify({
          guid: 'ts-' + Date.now(),
          method: 'sub',
          data: {
            mode: 'ltpc',
            instrumentKeys: [INSTRUMENT_KEY]
          }
        });
        ws.send(subMsg);

        stopPolling();
        if (state.wsSyncTimer) clearInterval(state.wsSyncTimer);
        state.wsSyncTimer = setInterval(function () {
          if (isMarketOpen()) silentRefetch();
        }, 60000);

        setStatus('live', 'WS LIVE');
        var el = $('tv-foot-info');
        if (el) el.textContent = 'WebSocket connected \u00B7 Real-time feed';
      };

      ws.onmessage = function (evt) {
        window._lastPollTickTs = Date.now();
        try {
          var buf = new Uint8Array(evt.data);
          var msg = FeedResponse.decode(buf);
          if (!msg || !msg.feeds) return;

          var feed = msg.feeds[INSTRUMENT_KEY];
          if (!feed) return;

          var ltpc = null;
          if (feed.ltpc) {
            ltpc = feed.ltpc;
          } else if (feed.fullFeed) {
            var ff = feed.fullFeed;
            var inner = ff.marketFF || ff.indexFF;
            if (inner && inner.ltpc) ltpc = inner.ltpc;
          } else if (feed.firstLevelWithGreeks && feed.firstLevelWithGreeks.ltpc) {
            ltpc = feed.firstLevelWithGreeks.ltpc;
          }

          if (ltpc && ltpc.ltp != null) {
            processSpotLtp(+ltpc.ltp);
          }
        } catch (e) {
          console.warn('[ws] decode error:', e && e.message);
        }
      };

      ws.onclose = function (evt) {
        console.log('[ws] closed (code=' + evt.code + ', reason=' + (evt.reason || 'none') + ')');
        state.wsConnected = false;
        state.ws = null;
        if (state.wsSyncTimer) { clearInterval(state.wsSyncTimer); state.wsSyncTimer = null; }

        if (state.chartReady) {
          state.pollIntervalMs = isMarketOpen() ? 2000 : 60000;
          startPolling();
        }

        if (isMarketOpen() && !(typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused())) {
          wsScheduleReconnect();
        }
      };

      ws.onerror = function () {
        console.warn('[ws] error \u2014 will attempt reconnect');
      };
    } catch (e) {
      console.warn('[ws] startWebSocket failed:', e && e.message);
      wsScheduleReconnect();
    }
  }

  window.tvWebSocketReconnect = function () { startWebSocket(); };

  // Wrap chart data application so we can (a) catch synchronous
  // throws, (b) verify via the completion callback that the chart
  // actually accepted the new data, and (c) recover if it didn't.
  //
  // The chart's internal data pipeline can silently swallow errors.
  // A broken indicator or corrupt state can leave the chart still
  // showing the previous TF with NO error surfaced. The callback
  // path lets us detect
  // that miss and retry with indicators stripped — a brand-new candle
  // pane always renders, even when an indicator is the saboteur.
  function applyChartData(candles, source, tfAtCallTime) {
    if (!state.chart || !state.candleSeries || !candles || !candles.length) {
      console.warn('[chart] applyChartData: bailing', { hasChart: !!state.chart, candleCount: candles && candles.length });
      return;
    }
    try {
      state.candleSeries.setData(candles.map(toKline));
      state.volumeSeries.setData(candles.map(toVolume));
      // Set the horizontal view only on the INITIAL render of a load
      // (fresh fetch / cache-hit), NOT on the 60s silent-refetch — a
      // periodic resync must not yank a user who has panned/zoomed back
      // into history. Show the most recent ~120 bars at a comfortable
      // spacing instead of fitContent(), which would cram the entire
      // multi-day/week history (1,000+ candles) into the viewport and
      // render each candle ~1px wide (the "compact" look). The keyboard
      // "fit" shortcut and zoom controls still call fitContent() on demand.
      if (source !== 'silent-refetch') {
        var ts = state.chart.timeScale();
        var n = candles.length;
        var VISIBLE_BARS = 120;
        ts.setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_BARS), to: n + 3 });
      }
      console.log('[chart] ' + source + ' setData OK \u00B7 tf=' + tfAtCallTime + ' \u00B7 ' + candles.length + ' candles \u00B7 first=' + candles[0][0] + ' last=' + candles[candles.length - 1][0]);
      try { updateBarCountdown(); } catch (_) {}
      renderIndicators();
      drawDaySeparators();
    } catch (e) {
      console.error('[chart] ' + source + ' setData threw for tf=' + tfAtCallTime, e);
    }
  }

  // ── Main load + render flow ──
  async function loadAndRender() {
    // ── Lazy-hydrate tfCache from localStorage on first call ──
    // This is what makes the off-hours "no API calls" gate work
    // across reloads: a Saturday-morning reload sees the Friday
    // afternoon cache and skips refetching. Done lazily here
    // (instead of at state-init time) because the cache helper
    // is defined below the state object literal.
    if (!state.tfCacheHydrated) {
      state.tfCacheHydrated = true;
      try {
        var persisted = loadTfCacheFromStorage();
        // Merge into in-memory cache (in-memory wins for keys
        // that already exist in case caller pre-populated some).
        for (var pk in persisted) {
          if (persisted.hasOwnProperty(pk) && !state.tfCache[pk]) {
            state.tfCache[pk] = persisted[pk];
          }
        }
        var cks = Object.keys(state.tfCache);
        if (cks.length) console.log('[chart] tfCache hydrated from localStorage \u00B7 ' + cks.length + ' entries');
      } catch (_) {}
    }
    var token = getToken();
    if (!token) {
      stopPolling();
      setStatus('notok', 'WAITING FOR TOKEN');
      showLoader(
        '<b>No Upstox token connected yet.</b><br><br>' +
        'Click the <a href="#" onclick="apiOpenModal();return false;" style="color:var(--info);font-weight:600">&#9881; gear icon</a> in the chart toolbar to connect your token.<br><br>' +
        '<span style="font-size:11px;opacity:0.7">Token is stored only in your browser. Nothing is sent anywhere except Upstox.</span>',
        { noSpinner: true }
      );
      return;
    }

    // Cancel any in-flight load so a rapid timeframe switch doesn't
    // race two responses back into the same chart. Cancel any in-flight
    // constituent-volume aggregation too — its results would belong to
    // the previous timeframe's bucket-set, which is no longer relevant.
    if (state.fetchAbort) { try { state.fetchAbort.abort(); } catch (_) { } }
    cancelAggregatedVolume();
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    state.fetchAbort = ctrl;
    var mySeq = ++state.loadSeq;

    // ── Per-TF cache: instant render on revisit ──
    // Cache freshness window depends on market state:
    //   - Market OPEN  → 8s freshness (data moves continuously,
    //                    pollTick handles intra-tick refresh)
    //   - Market CLOSED → ETERNAL (data does not change until
    //                     market reopens at 09:15 IST next session)
    //
    // The "eternal when closed" rule is the off-hours API-rate-
    // limiter fix (May 2026): previously the cache expired after
    // 5 min when closed, so a TF switch on a weekend (or after the
    // user left the tab idle for 5+ min) refetched and risked
    // Cloudflare 429 from Upstox. With eternal cache, we ONLY hit
    // Upstox during market hours OR for the very first load when
    // no cache exists yet. The cache is persisted to localStorage
    // (see persistTfCache below) so it survives reloads.
    //
    // Session boundary handling: when market reopens (09:15 IST
    // Monday after a weekend), marketOpenNow flips to true, the
    // 8s freshness kicks in, and the stale Friday-afternoon cache
    // gets discarded on the first loadAndRender call — refetching
    // automatically resyncs with the new session.
    var cacheKey = INSTRUMENT_KEY + '|' + state.timeframe;
    var cached = state.tfCache[cacheKey];
    var marketOpenNow = isMarketOpen();
    var cacheFresh;
    if (marketOpenNow) {
      cacheFresh = cached && (Date.now() - cached.at) < 8000;
    } else {
      // Closed: any cache is fresh. Refetch only when we have nothing.
      cacheFresh = !!(cached && cached.candles && cached.candles.length);
    }
    console.log('[chart] loadAndRender start \u00B7 tf=' + state.timeframe + ' \u00B7 seq=' + mySeq +
      ' \u00B7 cacheKey=' + cacheKey +
      ' \u00B7 cached=' + (!!cached) +
      (cached ? ' (age ' + (Date.now() - cached.at) + 'ms, ' + cached.candles.length + ' candles)' : '') +
      ' \u00B7 fresh=' + cacheFresh);

    // Make sure the chart is initialised before we try to use the cache
    // path — fresh page loads still need the initial mount.
    if (!state.lwcLoaded) {
      await new Promise(function (res) { loadLWC(res); });
      if (typeof LightweightCharts === 'undefined') return;
    }
    if (!state.chartReady) initChart();

    if (cacheFresh && state.chart && cached.candles && cached.candles.length) {
      if (mySeq !== state.loadSeq) return;
      console.log('[chart] cache hit for ' + cacheKey + ' (age ' + (Date.now() - cached.at) + 'ms) — instant render');
      state.outerRetryDone = false;
      state.candles = cached.candles;
      // Anchor the periodic resync clock to the cache's freshness — its
      // candles were just authoritative within the freshness window, so
      // the next silentRefetch can wait the full 60s before firing.
      state.lastSyncTs = cached.at;
      applyChartData(state.candles, 'cache-hit', state.timeframe);
      hideLoader();
      updateLTP();
      // Pin the chart's last-price line to the authoritative LTP
      // (when market closed and an earlier load already populated
      // it). Without this, switching TFs would briefly redraw
      // the price line at whatever the new TF's last bar closed
      // at — e.g. on 1H that's the 15:15 print, not the actual
      // 15:30 market close like every other TF.
      pinChartLastPriceToAuthLtp();
      if (marketOpenNow) {
        setStatus('live', 'LIVE');
        $('tv-foot-info').textContent = 'Loaded ' + state.candles.length + ' candles \u00B7 polling every 1s';
      } else {
        setStatus('closed', 'MARKET CLOSED');
      }
      // Only push the bar-close as a fallback "spot" when we DON'T
      // already have an authoritative LTP from a previous load —
      // different chart TFs have different "last bar close" times
      // (a 1m bar closes at 15:29, a 1h bar closes at 15:00) so
      // pushing the bar-close on every TF switch would clobber
      // the spot with a different stale value each time. The
      // authoritative spot comes from market-quote/ltp via
      // fetchAuthoritativeSpot() below.
      var hasLiveSpot0 = (typeof window.paperTradeGetLastSpot === 'function')
        && window.paperTradeGetLastSpot() != null;
      if (!hasLiveSpot0 && typeof window.paperTradeTick === 'function' && state.candles.length) {
        window.paperTradeTick(+state.candles[state.candles.length - 1][4]);
      }
      // Fire-and-forget one-shot fetch of Upstox's authoritative
      // LTP so the Key S/R card / chart footer show the actual
      // current Nifty value (not the historical-candle's last
      // bar close, which can trail by a tick when market is
      // closed). Doesn't block the render — paperTradeTick was
      // already called above with the bar-close as a fallback
      // (only on first load — see hasLiveSpot guard above).
      fetchAuthoritativeSpot();
      if (state.pendingLayout) {
        var pending0 = state.pendingLayout;
        state.pendingLayout = null;
        try { applyLayout(pending0); } catch (_) {}
      }
      if (state.activeIndicators && state.activeIndicators.VOL) {
        ensureAggregatedVolume();
      }
      state.pollIntervalMs = marketOpenNow ? 2000 : 60000;
      startPolling();
      if (marketOpenNow) startWebSocket();
      return;
    }

    showLoader('Loading Charts');
    setStatus('conn', 'CONNECTING');

    try {
      var candles = await fetchHistorical(ctrl ? ctrl.signal : undefined);
      // Discard if a newer load has started while we were awaiting.
      if (mySeq !== state.loadSeq) return;
      // Successful load — clear the outer-retry latch so the next
      // network blip gets its own silent retry attempt.
      state.outerRetryDone = false;
      state.candles = candles;
      state.tfCache[cacheKey] = { candles: candles, at: Date.now() };
      // Persist to localStorage so a reload during off-hours doesn't
      // re-trigger a fetch. The persistence is best-effort (silently
      // drops on quota error). See loadAndRender's cacheFresh logic
      // for the off-hours "eternal cache" rule that consumes this.
      persistTfCache(state.tfCache);
      // Anchor the periodic resync clock — these candles ARE the
      // authoritative ground truth as of right now.
      state.lastSyncTs = Date.now();
      applyChartData(candles, 'fetch', state.timeframe);

      hideLoader();
      updateLTP();
      // Pin the chart's last-price line to the authoritative LTP
      // (when market closed and a previous load already populated
      // it). See pinChartLastPriceToAuthLtp for why TFs like 1H
      // would otherwise drift away from the actual market close.
      pinChartLastPriceToAuthLtp();
      var marketOpen = isMarketOpen();
      if (marketOpen) {
        setStatus('live', 'LIVE');
        $('tv-foot-info').textContent = 'Loaded ' + candles.length + ' candles \u00B7 polling every 1s';
      } else {
        setStatus('closed', 'MARKET CLOSED');
        // Prefer authoritative spot LTP over the bar close so the
        // footer stays identical across TF switches (a 5m bar's
        // close timestamps differently than a 1D bar's close,
        // even though the underlying instrument's actual last
        // price is the same).
        var authLtp2 = (typeof window.paperTradeGetLastSpot === 'function')
          ? window.paperTradeGetLastSpot() : null;
        var lastClose = (authLtp2 != null)
          ? authLtp2.toLocaleString('en-IN', { maximumFractionDigits: 2 })
          : (candles.length
            ? (+candles[candles.length - 1][4]).toLocaleString('en-IN', { maximumFractionDigits: 2 })
            : '\u2014');
        $('tv-foot-info').textContent = 'Market closed \u00B7 ' + nextOpenLabel()
          + ' \u00B7 Last close: \u20B9' + lastClose;
      }
      // Only push the bar-close as a fallback "spot" when we DON'T
      // already have an authoritative LTP from a previous load —
      // different chart TFs have different "last bar close" times
      // (a 1m bar closes at 15:29, a 1h bar closes at 15:00) so
      // pushing the bar-close on every TF switch would clobber
      // the spot with a different stale value each time. The
      // authoritative spot comes from market-quote/ltp via
      // fetchAuthoritativeSpot() below.
      var hasLiveSpot1 = (typeof window.paperTradeGetLastSpot === 'function')
        && window.paperTradeGetLastSpot() != null;
      if (!hasLiveSpot1 && typeof window.paperTradeTick === 'function' && candles.length) {
        window.paperTradeTick(+candles[candles.length - 1][4]);
      }
      // Fire-and-forget one-shot fetch of Upstox's authoritative
      // LTP so the Key S/R card / chart footer show the actual
      // current Nifty value (not the historical-candle's last
      // bar close, which can trail by a tick when market is
      // closed). Doesn't block the render — paperTradeTick was
      // already called above with the bar-close as a fallback
      // (only on first load — see hasLiveSpot guard above).
      fetchAuthoritativeSpot();
      // If the user just clicked Load on a saved layout that lives on a
      // different timeframe, this loadAndRender was triggered by that
      // load. Apply the deferred layout now that the new candles are in.
      if (state.pendingLayout) {
        var pending = state.pendingLayout;
        state.pendingLayout = null;
        try { applyLayout(pending); } catch (_) {}
      }

      // If VOL is active and we're charting an index whose volume Upstox
      // doesn't report (Nifty 50 spot), kick off the constituent-volume
      // aggregation in the background. Chart shows immediately with
      // empty volume bars; bars populate ~3-5s later when the 100-fetch
      // aggregation finishes.
      if (state.activeIndicators && state.activeIndicators.VOL) {
        ensureAggregatedVolume();
      }

      // Set initial poll cadence based on market state, then start.
      // 2 s open-market cadence (was 1 s) — paired with the option
      // poller's 2 s cadence, keeps us comfortably under Upstox's
      // ~2 000 calls / 30-min budget.
      state.pollIntervalMs = marketOpen ? 2000 : 60000;
      startPolling();
      if (marketOpen) startWebSocket();

      // Auto-load option strikes once the chart is up (so user doesn't have to
      // click LOAD STRIKES manually). Only triggers if not already loaded
      // this session — natural per-session throttle.
      if (!window.optionChainData && typeof window.upFetchChain === 'function') {
        setTimeout(function () {
          if (!window.optionChainData) window.upFetchChain();
        }, 400);
      }
    } catch (e) {
      // A cancelled fetch is expected during rapid timeframe switches.
      // Don't change UI state — the newer call will own the chart.
      if (e && e.name === 'AbortError') return;
      if (mySeq !== state.loadSeq) return;
      var msg = e && e.message;
      stopPolling();
      if (msg === 'API_PAUSED') {
        setStatus('off', 'PAUSED');
        showLoader(
          '<b>API is paused.</b><br>Click <b>Resume</b> on the banner above to start the chart.',
          { noSpinner: true }
        );
      } else if (msg === 'NO_TOKEN') {
        setStatus('notok', 'WAITING FOR TOKEN');
        showLoader('<b>&uarr; Paste your Upstox token above</b> and click SAVE &amp; START CHART.', { noSpinner: true });
      } else if (msg === 'UNAUTHORIZED') {
        setStatus('notok', 'TOKEN EXPIRED');
        showLoader('<b>&#10007; Token rejected (401/403).</b><br>Upstox tokens expire daily at 3:30 AM IST.<br>Regenerate your token (see <b>Don\'t have a token?</b> help above).', { noSpinner: true });
      } else if (msg === 'OFFLINE') {
        setStatus('off', 'OFFLINE');
        showLoader(
          '<b style="color:var(--bear)">&#10007; You appear to be offline.</b><br>' +
          'The chart will retry automatically when your network comes back.' +
          '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">' +
            '<button type="button" id="tv-retry-load" class="tv-tools-mini-btn">Retry now</button>' +
            '<button type="button" id="tv-diagnose" class="tv-tools-mini-btn" style="background:transparent;color:var(--text);border:1px solid var(--bd)">Diagnose connection</button>' +
          '</div>',
          { noSpinner: true }
        );
        armLoadRetryBtn();
        armOnlineAutoRetry();
      } else if (msg && msg.indexOf('NO_DATA') === 0) {
        setStatus('off', 'NO DATA');
        // msg is either "NO_DATA" (both endpoints returned ok with []) or
        // "NO_DATA: hist=429 ..., intra=net Failed to fetch" (the new
        // diagnostic form). Surface whichever we have so the user can
        // see the actual reason without opening DevTools.
        var detail = (msg.length > 'NO_DATA'.length)
          ? msg.slice('NO_DATA: '.length)
          : '';

        // Self-heal: if the failure was purely network ("net Failed to
        // fetch" on BOTH endpoints) we silently auto-retry once after
        // a short pause before showing the user any error. This catches
        // the brief wifi/route blips that fetchWithRetry's 4 attempts
        // already missed (i.e. the entire ~4s retry window happened
        // during the same blip). One outer retry covers the case where
        // the blip is longer than 4s but shorter than ~6s.
        var isNetOnly = /^hist=net\b/.test(detail) && (!/intra=/.test(detail) || /intra=net\b/.test(detail));
        if (isNetOnly && !state.outerRetryDone) {
          state.outerRetryDone = true;
          console.warn('[chart] all hist+intra fetches failed with net errors — silent outer retry in 1500ms');
          showLoader('Loading Charts <span style="opacity:0.6;font-size:11px">(retrying after network blip)</span>');
          setStatus('conn', 'RETRYING');
          setTimeout(function () { loadAndRender(); }, 1500);
          return;
        }
        // Reset the outer-retry latch the moment we either succeed or
        // surface a non-net error — so the next genuine blip gets its
        // own fresh chance. (Success path resets it via the success
        // branch below.)
        state.outerRetryDone = false;
        // Classify the error. 429 / 1015 are rate-limit variants —
        // Cloudflare 1015 is the CDN-level IP block that fires when
        // too many requests hit Upstox in a short window. The old
        // code dumped raw Cloudflare JSON into a <pre> box, which
        // is frightening and adds no actionable info. Suppress it.
        var is429       = /429/.test(detail);
        var is1015      = /1015/.test(detail);
        var isRateLimit = is429 || is1015;
        var isNetMsg    = /\bnet\b/.test(detail) && !isRateLimit;
        var is400       = /\b400\b/.test(detail);

        // Raw detail: hide entirely for rate-limit errors; truncate
        // at 200 chars for other errors (enough for debugging).
        var detailHtml = '';
        if (!isRateLimit && detail) {
          var safeDetail = detail.length > 200 ? detail.slice(0, 200) + '\u2026' : detail;
          detailHtml = '<div style="margin-top:10px;padding:8px 10px;background:var(--s2);border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:var(--muted);text-align:left;white-space:pre-wrap;word-break:break-word">'
            + safeDetail.replace(/[<>&]/g, function (c) { return ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c]; })
            + '</div>';
        }

        var hint = '';
        if (is1015) {
          // Cloudflare 1015 = CDN-level IP block. Typically clears
          // in 2-3 min. Repeated retries extend the block — tell
          // the user explicitly NOT to keep clicking.
          hint = '<b>Cloudflare is temporarily blocking requests from your IP (Error 1015).</b> This is Upstox\u2019s CDN enforcing a per-IP rate cap. <b>Wait 2\u20133 minutes</b> \u2014 the app will retry automatically. Do NOT keep refreshing; extra requests extend the block.';
        } else if (is429) {
          hint = '<b>Upstox is rate-limiting your requests (HTTP 429).</b> Wait <b>60\u201390 seconds</b> \u2014 the app will retry automatically.';
        } else if (is400) {
          hint = 'Bad request \u2014 the date range or instrument key may be invalid. Try switching to a different timeframe.';
        } else if (isNetMsg) {
          hint = 'Network couldn\u2019t reach <code>api.upstox.com</code>. Check your wifi, disable any ad-blocker or privacy extension, then retry.';
        } else if (/ok 0c/.test(detail)) {
          hint = 'Upstox returned empty candle data for this window. Try a larger timeframe or check back after the next bar closes.';
        }
        var hintHtml = hint
          ? '<div style="margin-top:10px;padding:8px 10px;background:rgba(245,158,11,0.10);border-left:3px solid #f59e0b;border-radius:4px;font-size:12.5px;line-height:1.55;text-align:left">' + hint + '</div>'
          : '';

        // Auto-retry countdown for rate-limit errors so the user
        // doesn't have to sit there clicking Retry manually.
        // 1015 = 120s; plain 429 = 75s.
        var autoRetryMs = is1015 ? 120000 : is429 ? 75000 : 0;
        var countdownHtml = autoRetryMs
          ? '<div id="tv-retry-countdown" style="margin-top:8px;font-size:12px;color:var(--muted);font-style:italic">Auto-retrying in <b id="tv-cdown-sec">' + Math.round(autoRetryMs / 1000) + '</b>s&hellip;</div>'
          : '';

        showLoader(
          '<b>No candle data returned.</b><br>' +
          'Try a different timeframe, or click <b>Retry now</b>.' +
          hintHtml + detailHtml + countdownHtml +
          '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
            '<button type="button" id="tv-retry-load" class="tv-tools-mini-btn">Retry now</button>' +
            (isNetMsg ? '<button type="button" id="tv-diagnose" class="tv-tools-mini-btn" style="background:transparent;color:var(--text);border:1px solid var(--bd)">Diagnose connection</button>' : '') +
          '</div>',
          { noSpinner: true }
        );
        armLoadRetryBtn();
        if (isNetMsg) armOnlineAutoRetry();

        // Tick-down + auto-fire for rate-limit errors.
        // Cancelled automatically if the user clicks Retry manually
        // (loadAndRender replaces the loader HTML so the interval
        // fires harmlessly into a detached element and stops).
        if (autoRetryMs) {
          var cdownRemain = Math.round(autoRetryMs / 1000);
          var cdownEl = null;
          var cdownTimer = setInterval(function () {
            cdownRemain--;
            if (!cdownEl) cdownEl = document.getElementById('tv-cdown-sec');
            if (cdownEl) cdownEl.textContent = cdownRemain;
            if (cdownRemain <= 0) {
              clearInterval(cdownTimer);
              loadAndRender();
            }
          }, 1000);
        }
      } else {
        setStatus('off', 'ERROR');
        showLoader(
          '<b style="color:var(--bear)">&#10007; ' + (msg || 'Failed to load') + '</b><br><br>' +
          'If this looks like a CORS error, run the page via a local HTTP server:<br>' +
          '<code style="background:var(--s2);padding:2px 6px;border-radius:3px">python3 -m http.server 8000</code><br>' +
          'then open <code>http://localhost:8000/candlestick-patterns.html</code>' +
          '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center">' +
            '<button type="button" id="tv-retry-load" class="tv-tools-mini-btn">Retry now</button>' +
            '<button type="button" id="tv-diagnose" class="tv-tools-mini-btn" style="background:transparent;color:var(--text);border:1px solid var(--bd)">Diagnose connection</button>' +
          '</div>',
          { noSpinner: true }
        );
        armLoadRetryBtn();
      }
    }
  }

  // Wire the "Retry now" button (rendered into the chart loader by the
  // error branches above). The button is recreated each error render, so
  // we just bind to whatever element happens to be present right now.
  function armLoadRetryBtn() {
    var btn = document.getElementById('tv-retry-load');
    if (!btn) return;
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'Retrying...';
      loadAndRender();
    });
    // Bind the "Diagnose connection" button alongside, since they always
    // ship together in the same error render.
    var diagBtn = document.getElementById('tv-diagnose');
    if (diagBtn) {
      diagBtn.addEventListener('click', function () {
        diagBtn.disabled = true;
        diagBtn.textContent = 'Testing...';
        runConnectionDiagnostic().then(function (res) {
          renderDiagnosticResult(res);
        });
      });
    }
  }

  // ── Self-diagnostic for "Failed to fetch" failures ─────────────────
  // Runs a sequence of probes and returns a structured result so we can
  // tell the user EXACTLY which layer is broken (offline, SW, blocker,
  // token, rate-limit, or actually-our-bug) without making them open
  // DevTools. Each probe is wrapped in try/catch — one failing probe
  // never aborts the whole report.
  async function runConnectionDiagnostic() {
    var out = {
      online: (typeof navigator !== 'undefined') ? navigator.onLine : true,
      hasToken: !!getToken(),
      proxyEnabled: USE_PROXY,        // whether the app is routing through server.py
      v3Base: V3,                     // resolved base URL for V3 (proxy or direct)
      swController: null, swScript: null,
      basic: null,        // network reachability (no-cors HEAD, no auth) — DIRECT to upstream
      authed: null,       // status code from a real authed call (V2 LTP) — DIRECT to upstream
      authedBody: null,
      v3Hist: null,       // V3 hist via app's V3 constant (proxy on localhost, direct elsewhere)
      v3Intra: null,      // V3 intraday via app's V3 constant (proxy on localhost, direct elsewhere)
      v3HistViaWrapper: null, // same URL but through fetchWithRetry
      rawError: null
    };

    // Service-worker state. Tells us if the OLD SW (with clients.claim)
    // is still controlling this tab — that was the handover-blip cause
    // we already fixed in v35.
    try {
      if ('serviceWorker' in navigator) {
        out.swController = !!navigator.serviceWorker.controller;
        var reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.active) out.swScript = reg.active.scriptURL;
      }
    } catch (_) {}

    // Probe 1 — basic reachability of api.upstox.com via no-cors mode.
    // If this throws, the host itself is unreachable from this browser
    // (DNS, firewall, VPN, or an extension blocking the hostname).
    try {
      await fetch('https://api.upstox.com/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050', {
        method: 'GET', mode: 'no-cors', cache: 'no-store'
      });
      out.basic = 'reachable';
    } catch (e) {
      out.basic = 'BLOCKED: ' + (e && e.message || 'unknown');
      out.rawError = out.rawError || (e && e.message);
    }

    // Probe 2 — real authed call to the smallest cheap endpoint we use.
    // Tells us 200 / 401 / 429 / etc. so we know if it's a token issue
    // or a real network problem. If basic was "reachable" but this
    // throws with "Failed to fetch", it's almost always either:
    //   • Upstox returned 401 with no CORS headers (browser hides it
    //     and just throws — token is expired)
    //   • An extension is stripping the Authorization header
    if (out.hasToken) {
      var token = getToken();
      var authHdr = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

      // Probe 2 — V2 LTP (the same URL the diagnostic baseline hits).
      try {
        var r = await fetch('https://api.upstox.com/v2/market-quote/ltp?instrument_key=NSE_INDEX%7CNifty%2050', {
          method: 'GET', headers: authHdr, cache: 'no-store'
        });
        out.authed = String(r.status);
        try { out.authedBody = (await r.text()).slice(0, 200); } catch (_) {}
      } catch (e) {
        out.authed = 'THREW: ' + (e && e.message || 'unknown');
        out.rawError = out.rawError || (e && e.message);
      }

      // Probe 3 — the EXACT V3 historical-candle URL fetchHistorical
      // would build for the current timeframe + instrument. This is what
      // tells us whether the failure is endpoint-specific (V3 broken
      // upstream) or wrapper-specific (our fetchWithRetry mangling it).
      try {
        var tf = TF[state.timeframe];
        var ikey = encodeURIComponent(INSTRUMENT_KEY);
        var to = new Date(); var from = new Date();
        from.setDate(to.getDate() - tf.historyDays);
        var histUrl = V3 + '/historical-candle/' + ikey + '/' + tf.unit + '/' + tf.interval + '/' + fmtDate(to) + '/' + fmtDate(from);
        var rh = await fetch(histUrl, { method: 'GET', headers: authHdr, cache: 'no-store' });
        out.v3Hist = String(rh.status);
      } catch (e) {
        out.v3Hist = 'THREW: ' + (e && e.message || 'unknown');
        out.rawError = out.rawError || (e && e.message);
      }

      // Probe 4 — V3 intraday for the same timeframe. Upstox V3 supports
      // days/1 here too (per their "Get current day data" sample), so we
      // probe ALL timeframes including 1D — useful diagnostic when the
      // hist endpoint silently returns an empty array on the daily TF.
      try {
        var tf2 = TF[state.timeframe];
        var ikey2 = encodeURIComponent(INSTRUMENT_KEY);
        var intraUrl = V3 + '/historical-candle/intraday/' + ikey2 + '/' + tf2.unit + '/' + tf2.interval;
        var ri = await fetch(intraUrl, { method: 'GET', headers: authHdr, cache: 'no-store' });
        out.v3Intra = String(ri.status);
      } catch (e) {
        out.v3Intra = 'THREW: ' + (e && e.message || 'unknown');
        out.rawError = out.rawError || (e && e.message);
      }

      // Probe 5 — same V3 hist URL, but routed through our actual
      // fetchWithRetry wrapper. If probe 3 succeeded but this fails,
      // the bug lives inside our wrapper / signal handling.
      try {
        var tf3 = TF[state.timeframe];
        var ikey3 = encodeURIComponent(INSTRUMENT_KEY);
        var to3 = new Date(); var from3 = new Date();
        from3.setDate(to3.getDate() - tf3.historyDays);
        var histUrl3 = V3 + '/historical-candle/' + ikey3 + '/' + tf3.unit + '/' + tf3.interval + '/' + fmtDate(to3) + '/' + fmtDate(from3);
        var rw = await fetchWithRetry(histUrl3, { headers: authHdr }, undefined);
        out.v3HistViaWrapper = String(rw.status);
      } catch (e) {
        out.v3HistViaWrapper = 'THREW: ' + (e && e.message || 'unknown');
        out.rawError = out.rawError || (e && e.message);
      }
    }

    return out;
  }

  // Interpret diagnostic results into a single plain-English verdict
  // and an actionable next step, then render into the chart loader.
  function renderDiagnosticResult(r) {
    var verdict, action, color;
    if (!r.online) {
      verdict = 'Browser is offline.';
      action  = 'Reconnect to the internet — the chart will auto-resume.';
      color   = 'var(--bear)';
    } else if (/^BLOCKED/.test(r.basic)) {
      verdict = 'Your browser cannot reach api.upstox.com.';
      action  = 'Most likely an ad-blocker, privacy extension (uBlock, Brave Shields, Ghostery), VPN, or corporate firewall is blocking the host. Whitelist <code>api.upstox.com</code> and <code>localhost:8000</code>, then click Retry.';
      color   = 'var(--bear)';
    } else if (!r.hasToken) {
      verdict = 'Network is fine — no Upstox token saved yet.';
      action  = 'Paste a token in the API connection panel and try again.';
      color   = '#f59e0b';
    } else if (/^THREW/.test(r.authed)) {
      // Network reachable, but the authed call threw → almost always
      // Upstox returning 401 without CORS, which the browser surfaces
      // as a generic "Failed to fetch".
      verdict = 'Network is fine — but the authed request is being blocked.';
      action  = 'Almost certainly an <b>expired token</b> (Upstox tokens die daily at 03:30 IST). Regenerate it via Upstox Developer Console and paste the new one. If you just regenerated, also check that any browser extension isn\'t stripping the <code>Authorization</code> header.';
      color   = '#f59e0b';
    } else if (r.authed === '401' || r.authed === '403') {
      verdict = 'Upstox rejected the token (HTTP ' + r.authed + ').';
      action  = 'Token has expired or lacks the right scope. Regenerate it on Upstox and paste again.';
      color   = '#f59e0b';
    } else if (r.authed === '429') {
      verdict = 'Upstox is rate-limiting you (HTTP 429).';
      action  = 'Wait 60 seconds and click Retry. Consider lowering polling cadence.';
      color   = '#f59e0b';
    } else if (/^[45]\d\d$/.test(r.authed)) {
      verdict = 'Upstox returned HTTP ' + r.authed + '.';
      action  = 'API may be having issues — try again in a few minutes.';
      color   = '#f59e0b';
    } else if (r.authed === '200') {
      // V2 LTP works. Now check the V3 historical-candle endpoints,
      // because those are what fetchHistorical actually calls.
      var v3HistOk = r.v3Hist === '200';
      var v3IntraOk = r.v3Intra === '200' || /^skipped/.test(r.v3Intra || '');
      var wrapperOk = r.v3HistViaWrapper === '200';
      if (v3HistOk && v3IntraOk && wrapperOk) {
        verdict = 'Everything works end-to-end (V2, V3, and our wrapper).';
        action  = 'Original error was transient. Click Retry — it should load now. If it still fails the moment you click Retry, check the browser console for a JavaScript error happening BEFORE the fetch (state corruption).';
        color   = 'var(--bull)';
      } else if (v3HistOk && v3IntraOk && !wrapperOk) {
        verdict = 'Direct V3 fetch works, but our fetchWithRetry wrapper fails!';
        action  = 'The bug is inside the app — likely an aborted AbortSignal being reused, or a stale state.fetchAbort. Try a hard reload (Cmd+Shift+R) to reset the app state. If reload fixes it, we have a state-leak bug to fix.';
        color   = '#f59e0b';
      } else if (!v3HistOk && r.v3Hist && /^THREW/.test(r.v3Hist)) {
        verdict = 'V2 works, V3 historical-candle is throttled.';
        action  = 'Upstox is rate-limiting the <code>/v3/historical-candle/...</code> endpoint specifically (per-endpoint cap, not per-host — V2 LTP still works). This usually happens after rapid TF switching with the VOL indicator on (which fires 100 constituent fetches per switch). <b>Wait ~60 seconds</b> for the throttle window to reset, then hard-refresh (Cmd+Shift+R) so the new debounced + concurrency-capped code loads. If it persists after a fresh load, an extension blocking the V3 path is the next suspect — test in Incognito to confirm.';
        color   = '#f59e0b';
      } else if (r.v3Hist === '429' || r.v3Intra === '429') {
        verdict = 'Upstox is rate-limiting the historical-candle endpoint.';
        action  = 'Wait 60 seconds and click Retry. We\'re hitting the per-IP cap.';
        color   = '#f59e0b';
      } else if (/^4/.test(r.v3Hist || '') || /^5/.test(r.v3Hist || '')) {
        verdict = 'V3 historical-candle returned HTTP ' + r.v3Hist + '.';
        action  = 'Endpoint-specific failure. Try a different timeframe to isolate (some timeframes have date-range restrictions).';
        color   = '#f59e0b';
      } else {
        verdict = 'Mixed results — check raw probes below.';
        action  = 'Click "RAW PROBE RESULTS" to see exactly which probe failed.';
        color   = '#f59e0b';
      }
    } else {
      verdict = 'Diagnostic ran but the result is ambiguous.';
      action  = 'Open DevTools → Network tab and look at the failed historical-candle row.';
      color   = '#f59e0b';
    }

    var rows = [
      ['navigator.onLine',       String(r.online)],
      ['Token saved',            String(r.hasToken)],
      ['Proxy enabled',          String(r.proxyEnabled) + (r.proxyEnabled ? ' (server.py)' : ' (direct)')],
      ['V3 base URL',            r.v3Base || '(unset)'],
      ['SW controlling',         String(r.swController)],
      ['SW script',              r.swScript || '(none)'],
      ['Basic reach (no-cors)',  r.basic || '(skipped)'],
      ['V2 LTP authed (direct)', r.authed || '(skipped — no token)'],
      ['V3 historical-candle',   r.v3Hist || '(skipped)'],
      ['V3 intraday',            r.v3Intra || '(skipped)'],
      ['V3 hist via wrapper',    r.v3HistViaWrapper || '(skipped)'],
      ['Raw error',              r.rawError || '(none)']
    ];
    var rowsHtml = rows.map(function (kv) {
      return '<div style="display:flex;gap:10px;font:11px/1.5 ui-monospace,monospace"><span style="color:var(--muted);min-width:130px">' + kv[0] + '</span><span style="color:var(--text);word-break:break-all">' + String(kv[1]).replace(/[<>&]/g, function (c) { return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]; }) + '</span></div>';
    }).join('');

    showLoader(
      '<div style="text-align:left;max-width:560px;margin:0 auto">' +
        '<div style="font-size:14px;font-weight:600;color:' + color + ';margin-bottom:6px">Diagnosis: ' + verdict + '</div>' +
        '<div style="font-size:13px;line-height:1.6;color:var(--text);margin-bottom:14px">' + action + '</div>' +
        '<details style="margin-bottom:14px"><summary style="cursor:pointer;font-size:11.5px;color:var(--muted);font-family:ui-monospace,monospace;letter-spacing:0.05em">RAW PROBE RESULTS</summary>' +
          '<div style="margin-top:8px;padding:10px 12px;background:var(--s2);border-radius:5px">' + rowsHtml + '</div>' +
        '</details>' +
        '<div style="display:flex;gap:8px"><button type="button" id="tv-retry-load" class="tv-tools-mini-btn">Retry now</button><button type="button" id="tv-diagnose" class="tv-tools-mini-btn" style="background:transparent;color:var(--text);border:1px solid var(--bd)">Run again</button></div>' +
      '</div>',
      { noSpinner: true }
    );
    armLoadRetryBtn();
  }

  // One-shot listener for the browser's "online" event. As soon as the
  // network comes back, re-run the load. We dedupe with state.onlineWired
  // so we don't stack listeners across multiple OFFLINE error renders.
  function armOnlineAutoRetry() {
    if (state.onlineWired) return;
    state.onlineWired = true;
    var handler = function () {
      window.removeEventListener('online', handler);
      state.onlineWired = false;
      console.log('[chart] online event — auto-retrying loadAndRender');
      loadAndRender();
    };
    window.addEventListener('online', handler);
  }

  // Reflect the current state.timeframe in the toolbar button highlight.
  // Needed in two places: when the user clicks a TF button (setTimeframe
  // calls this) and on initial mount (the lazily-loaded content/live.html
  // hardcodes the .active class on the 5m button, so a saved-TF user
  // needs the highlight rewritten once after their template lands).
  function syncTimeframeButtons() {
    document.querySelectorAll('.tv-tf-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tf') === state.timeframe);
    });
  }

  function setTimeframe(tf) {
    if (!TF[tf]) {
      console.warn('[chart] setTimeframe: unknown tf', tf);
      return;
    }
    if (tf === state.timeframe) {
      console.log('[chart] setTimeframe: noop (already on ' + tf + ')');
      return;
    }
    var prev = state.timeframe;
    state.timeframe = tf;
    try { localStorage.setItem(TF_STORAGE, tf); } catch (_) { /* private mode etc. */ }
    syncTimeframeButtons();

    // ── NUCLEAR RESET ───────────────────────────────────────────────
    // Every previous defensive measure (cache bust, clearData,
    // applyNewData callback wrapper, resize() in callback) still left
    // some users with a chart that visibly refused to swap candles
    // when the TF changed. The class of bug is the chart's internal
    // store getting into a state where the viewport silently
    // skips the redraw. Rather than chase every leaf
    // failure mode, we just throw out the entire chart instance on
    // every TF switch and let loadAndRender() rebuild it from
    // scratch via initChart(). That path is the same one used on
    // first page load and is known to work; reusing it for TF
    // switches guarantees the new TF always renders, indicators are
    // re-added cleanly from the autosave layout, and there's no
    // possible state leak from the previous TF.
    //
    // Cost: ~50ms of "blank chart" flicker on each TF switch while
    // the new instance mounts and the fetch returns. Worth it for
    // 100% reliability.
    try { delete state.tfCache[INSTRUMENT_KEY + '|' + tf]; } catch (_) {}
    state.candles = [];
    state.aggVolForTf = null;
    cancelAggregatedVolume();
    if (state.chart) {
      try { state.chart.remove(); }
      catch (e) { console.warn('[chart] setTimeframe: chart.remove() failed', e); }
      state.chart = null;
      state.candleSeries = null;
      state.volumeSeries = null;
      state.authPriceLine = null;
    }
    // Also nuke the mount DOM so initChart can create a fresh container.
    // initChart's existing "remove all children except loader" logic
    // already does this, but we belt-and-brace it in case the dispose
    // above left a stray <div id="tv-lwc-mount"> behind.
    //
    // KEEP the bar-close countdown chip (#tv-countdown) too — it's a
    // sibling overlay anchored to the LTP price tag and gets re-pinned
    // by the next tick of updateBarCountdown(). Wiping it here was
    // why the chip disappeared on every TF switch and only came back
    // after a hard-refresh (which re-injects content/live.html).
    try {
      var host = $('tv-chart-container');
      if (host) {
        Array.from(host.children).forEach(function (ch) {
          if (ch.id !== 'tv-loading' && ch.id !== 'tv-countdown') host.removeChild(ch);
        });
      }
    } catch (e) { console.warn('[chart] setTimeframe: container cleanup failed', e); }
    state.chartReady = false;
    // Wipe indicator bookkeeping — initChart's autosave restore will
    // re-add whatever the user had active for the new TF.
    state.activeIndicators = {};
    state.activeOverlayIds = [];
    state.selectedOverlayId = null;

    console.log('[chart] setTimeframe: ' + prev + ' \u2192 ' + tf + ' \u00B7 chart disposed, will re-init via loadAndRender');
    loadAndRender();
    scheduleAutosave();
    // Force an immediate countdown repaint so the chip reflects the new
    // bucket size the instant the user clicks (instead of waiting up to
    // 1s for the next ticker fire). Cheap and idempotent.
    try { updateBarCountdown(); } catch (_) {}
  }

  function tvToggleFullscreen() {
    var shell = document.querySelector('.tv-shell');
    if (!shell) return;
    var entering = !shell.classList.contains('tv-fullscreen');
    shell.classList.toggle('tv-fullscreen', entering);
    document.body.classList.toggle('tv-fs-active', entering);
  }

  // ── Event wiring ──
  function isLiveActive() {
    var live = $('live');
    return live && live.classList.contains('active');
  }

  function onTabActivate() {
    if (!isLiveActive()) return;
    // The TF buttons are part of content/live.html which is lazily
    // injected when the user opens the Live tab. By the time we get
    // here the buttons should be in the DOM, so re-sync the .active
    // highlight to whatever timeframe was restored from localStorage.
    syncTimeframeButtons();
    if (!state.chartReady) loadAndRender();
    else if (!state.pollTimer) startPolling();
  }

  document.addEventListener('DOMContentLoaded', function () {
    // Timeframe buttons via event delegation. The .tv-tf-btn elements
    // live inside content/live.html which is fetched lazily when the
    // user opens the live tab — they don't exist at DOMContentLoaded,
    // so a one-shot forEach(addEventListener) silently misses them.
    // Delegating at the document level handles the lazy-mount race.
    document.addEventListener('click', function (ev) {
      var tfBtn = ev.target && ev.target.closest && ev.target.closest('.tv-tf-btn');
      if (tfBtn && tfBtn.hasAttribute('data-tf')) {
        setTimeframe(tfBtn.getAttribute('data-tf'));
      }
    });

    // Mount when tab becomes active
    onTabActivate();
    document.querySelectorAll('.tab').forEach(function (btn) {
      var oc = btn.getAttribute('onclick') || '';
      if (oc.indexOf("show('live'") !== -1) {
        btn.addEventListener('click', function () { setTimeout(onTabActivate, 80); });
      }
    });
    if (location.hash === '#live') setTimeout(onTabActivate, 200);

    // ESC exits fullscreen
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var shell = document.querySelector('.tv-shell.tv-fullscreen');
      if (!shell) return;
      shell.classList.remove('tv-fullscreen');
      document.body.classList.remove('tv-fs-active');
    });

    // Stop polling when tab is hidden / leaves the live section
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopPolling();
      else if (isLiveActive() && state.chartReady) startPolling();
    });

    // Kick off the bar-close countdown ticker. Safe to start early —
    // updateBarCountdown() resolves the chip lazily via getElementById
    // (the chip lives inside content/live.html which is fetched on
    // demand), so before the live tab mounts the ticker is a 1Hz no-op.
    // Once the chip lands in the DOM it begins painting immediately.
    try { startBarCountdownTicker(); } catch (_) {}

    // Theme observer
    var ob = new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.attributeName === 'data-theme') reapplyTheme();
      });
    });
    ob.observe(document.documentElement, { attributes: true });
  });

  // Expose
  window.tvToggleFullscreen = tvToggleFullscreen;
  window.tvSetTimeframe = setTimeframe;
  window.tvReload = loadAndRender;
  window.tvState = state;
  window.isMarketOpen = isMarketOpen;
  window.isTradingDayToday = isTradingDayToday;
  window.isNseHoliday = isNseHoliday;
  window.nextOpenLabel = nextOpenLabel;
  // Exposed for the intraday-verdict module so it can enrich
  // Nifty raw bars (volume=0 on the index) with the constituent-
  // summed volume — exactly what the live chart does for its VOL
  // pane. Without this the verdict's volume-ratio / OBV signals
  // silently never fire for Nifty/Bank Nifty (see ISSUE 2 in the
  // May 2026 audit). The function returns a `{ <timestamp_ms>:
  // volume_sum, _at: <fetchedMs> }` dict for the given timeframe
  // key, or null on token/network/permission failure. Caches in
  // localStorage for 30 min so multiple consumers (chart pane +
  // intraday analyzer) share the same fetched data.
  window.tvFetchAggregatedVolume = fetchAggregatedHistoricalVolume;
  window.tvReapplyTheme = reapplyTheme;
})();
