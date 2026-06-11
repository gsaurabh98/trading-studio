// ===================================================================
// INTRADAY TRADE - self-contained swing-style chart workspace.
// ===================================================================
// A separate tab (#intraday-trade) that renders a Lightweight Charts
// candlestick chart for NSE_INDEX|Nifty 50, mirroring the Swing
// Analyzer chart UX (TF buttons, indicator legend, zoom/scroll nav,
// live last-bar patching). DISPLAY ONLY - it never emits a buy/sell
// signal.
//
// Isolation contract (so it cannot break the Options Trading tab):
//   - Own DOM ids (it-*) and own window globals (itActivate /
//     itDeactivate / itChartSetTf / itChartNav / itChartToggleInd).
//   - Reuses the SHARED Upstox infra so it never doubles API load:
//       * window.localStorage 'upstox_token' (same token)
//       * window._upstoxBucket / _upstoxIsThrottled / _upstoxNote429 /
//         _upstoxNoteOk (one global rate-limiter across all callers)
//       * window.isMarketOpen / window.nextOpenLabel when present
//   - API pause is INDEPENDENT: this tab has its own dedicated toggle
//     (it_api_paused_v1); it does NOT honour the Options master switch
//     (window.ptIsApiPaused), and pausing here never affects Options.
//   - Overlays reuse the SHARED pure libs window.IndicatorMath and
//     window.ChartPatterns - no duplicated TA math.
//   - HTTP LTP polling only (no WebSocket) at a gentle cadence, gated
//     by market-hours + the shared rate-limiter, and only while the
//     tab is active.
// ===================================================================
(function intradayTrade() {
  'use strict';

  var INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
  var IST_OFF_SEC = 19800; // IST = UTC + 5:30

  // Base-URL resolution — identical to live-chart.js so this tab works
  // through the same Cloudflare Worker proxy / local server.py proxy /
  // direct Upstox path the rest of the app already uses.
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
  if (CF_WORKER_URL) { V2 = CF_WORKER_URL + '/api/v2'; V3 = CF_WORKER_URL + '/api/v3'; }
  else if (USE_LOCAL_PROXY) { V2 = '/api/v2'; V3 = '/api/v3'; }
  else { V2 = 'https://api.upstox.com/v2'; V3 = 'https://api.upstox.com/v3'; }

  // Per-TF fetch spec. historyDays drives the /historical-candle window;
  // bucketMs drives live-bar bucket alignment. Mirrors the live chart's
  // TF table but trimmed to the intraday set the user asked for.
  var TF = {
    '1m':  { unit: 'minutes', interval: '1',  historyDays: 4,   bucketMs: 60 * 1000,            label: '1 Minute',  intraday: true },
    '3m':  { unit: 'minutes', interval: '3',  historyDays: 8,   bucketMs: 3 * 60 * 1000,        label: '3 Minute',  intraday: true },
    '5m':  { unit: 'minutes', interval: '5',  historyDays: 12,  bucketMs: 5 * 60 * 1000,        label: '5 Minute',  intraday: true },
    '15m': { unit: 'minutes', interval: '15', historyDays: 30,  bucketMs: 15 * 60 * 1000,       label: '15 Minute', intraday: true },
    '30m': { unit: 'minutes', interval: '30', historyDays: 60,  bucketMs: 30 * 60 * 1000,       label: '30 Minute', intraday: true },
    '1h':  { unit: 'hours',   interval: '1',  historyDays: 90,  bucketMs: 60 * 60 * 1000,       label: '1 Hour',    intraday: true },
    '4h':  { unit: 'hours',   interval: '4',  historyDays: 90,  bucketMs: 4 * 60 * 60 * 1000,   label: '4 Hour',    intraday: true },
    '1d':  { unit: 'days',    interval: '1',  historyDays: 400, bucketMs: 24 * 60 * 60 * 1000,  label: '1 Day',     intraday: false }
  };

  // Zigzag structure params per TF (for the BOS overlay). Falls back to
  // the shared TREND_PARAMS_BY_TF where available, else a sane default.
  var STRUCT_PARAMS = {
    '1m':  { zigzagATR: 0.60, tolATR: 0.05, skipFirstBarsOfDay: 2 },
    '3m':  { zigzagATR: 0.70, tolATR: 0.05, skipFirstBarsOfDay: 2 },
    '5m':  { zigzagATR: 0.80, tolATR: 0.05, skipFirstBarsOfDay: 2 },
    '15m': { zigzagATR: 1.20, tolATR: 0.05, skipFirstBarsOfDay: 1 },
    '30m': { zigzagATR: 1.80, tolATR: 0.05, skipFirstBarsOfDay: 1 },
    '1h':  { zigzagATR: 2.00, tolATR: 0.05, skipFirstBarsOfDay: 1 },
    '4h':  { zigzagATR: 2.00, tolATR: 0.05, skipFirstBarsOfDay: 0 },
    '1d':  { zigzagATR: 2.00, tolATR: 0.05, skipFirstBarsOfDay: 0 }
  };

  var STATE = {
    active: false,
    timeframe: '5m',
    chart: null,
    candleSeries: null,
    volumeSeries: null,
    futVolMap: null,     // { isoTs: volume } from the Nifty FUTURE (index = vol 0)
    futContract: null,   // the resolved front-month futures contract (or null)
    breakouts: null,     // last detectFakeBreakouts() result for the current TF
    overlaySeries: [],   // line series for EMA/SMA/VWAP - cleared each render
    raw: [],             // last fetched raw candles (oldest -> newest)
    klines: [],          // mapped LWC candles
    lastClose: null,
    prevClose: null,     // previous session close, for the change % readout
    pollTimer: null,
    pollMs: 3000,
    fetchAbort: null,
    loadSeq: 0,
    lwcLoading: null,
    fetchCache: {},      // { tf: { at, raw } } short-lived candle cache
    fetchInflight: {},   // { tf: Promise }
    themeObserver: null,
    _ltpFetching: false,
    zones: [],           // detected demand/supply zones for the current TF
    zoneLayer: null,     // DOM container for zone band overlays
    fzLayer: null,       // DOM container for FORMING-zone (amber/dashed) overlays
    fzEls: [],           // [{ el, proximal, distal }] price-anchored forming bands
    formingZones: [],    // last computed forming zones (shared by overlay + cards)
    bosLayer: null,      // DOM container for BOS/CHoCH + swing-label overlays
    bosEls: [],          // [{ el, price, time, pos, isLine }] glued to price/time
    fvgLayer: null,      // DOM container for Fair-Value-Gap band overlays
    fvgEls: [],          // [{ el, top, bottom }] price-anchored full-width bands
    obLayer: null,       // DOM container for Order-Block band overlays
    obEls: [],           // [{ el, proximal, distal }] price-anchored full-width bands
    fibLayer: null,      // DOM container for anchored-Fib segments + labels
    fibEls: [],          // [{ el, label, price, startTime, endTime }] glued to price/time
    fibConnector: null,  // { svg, line, startTime, endTime, startPrice, endPrice } diagonal
    bosTrend: null,      // 'BULLISH' | 'BEARISH' | 'RANGING'
    overlayRaf: 0,       // single rAF handle keeping ALL price-anchored overlays glued
    // CPR (Central Pivot Range). cprDaily caches the AUTHORITATIVE prev-session
    // OHLC derived from the daily (1d) candle — fetched once per session, then
    // reused (the prior session's levels are static all day). cprLines holds the
    // createPriceLine handles so a background source-upgrade can cleanly redraw
    // without duplicating lines. See buildCpr / ensureCprDaily / drawCprLines.
    cprDaily: { ohlc: null, prevDayNum: null, computedForDay: null, source: null, stale: false },
    cprLines: [],        // [priceLine handles] for the CPR overlay on the candle series
    breakoutLine: null,  // single priceLine handle for the fake-breakout level (removed before redraw so bar-close refreshes don't stack labels)
    candleMarkers: null, // createSeriesMarkers handle for candlestick arrows (updated via setMarkers on bar close — no stacking)
    setup: {             // multi-TF Setup Plan + Trade Plan (1H/30m/15m/5m)
      data: null,        // last built setup object (trends + verdict + plan)
      loadSeq: 0
    },
    auto: {              // auto-trade + signal journal — fully SELF-CONTAINED (no paper-book dependency)
      on: true,          // master switch (persisted; default ON — loadAuto() respects a stored '0'/'1')
      taken: {},         // { fingerprint: true } for signals already taken — never retried. Seeded from the journal on load so it survives a reload (no duplicate re-entry across reloads / multiple signals per day).
      journal: [],       // [{ id, ts, side, strike, conf, entry, entryLo, entryHi, sl, t1, r, status:ARMED|OPEN|CLOSED, outcome:ARMED|OPEN|T1|SL|THESIS|EOD|EXPIRED|MISSED, filledTs, pts, exit, exitTs }]
      jLoaded: false,    // server hydrate guard
      jSaveTimer: null,
      dayFilter: 'all',  // signal-journal day-wise view filter ('all' | 'YYYY-MM-DD' IST day key)
      viewMode: 'live',  // journal view: 'live' (current) | 'archive' (read-only cleared rows)
      archive: [],       // loaded archive rows (cleared history) — read-only viewer
      archiveLoaded: false,
      setupTimer: null,  // periodic setup re-evaluation (only while armed + open)
      fastTimer: null    // fast (15s, no-fetch) trigger re-check while a bias is armed
    },
    cards: {             // intraday context cards (VIX / Max Pain / PCR)
      vix: null,         // { current, open, high, low, changePct } | null
      chain: null,       // { pcr, maxPain, spot, expiry, totCE, totPE } | null
      loading: false,
      lastAt: 0,
      loadSeq: 0
    },
    macro: {             // macro context for the below-chart banner
      bn: null,          // { trend, net, changePct } from window.iaGetBankNiftyBias()
      bnAt: 0            // last Bank-Nifty fetch time (ms) — throttled to ~60s
    },
    indVisible: {
      vwap: false, ema20: false, ema50: false, sma44: false, bb: false,
      macd: false, rsi: false, pdohlc: false, cpr: false, fib: false, zoi: true,
      patterns: true, bos: false, fvg: false, ob: false, chartpatterns: false,
      forming: false      // early, UNCONFIRMED amber demand zones — default OFF (low-trust, noisy on a scalp chart)
    }
  };

  var FETCH_TTL_MS = 20 * 1000; // reuse a fetched TF for 20s across renders

  // Mirror of swing's FIB_BAND_LEVELS — used only if the swing module's exposed
  // copy (window._swCP.FIB_BAND_LEVELS) isn't available yet. Keep in sync.
  var FIB_LEVELS_FALLBACK = [
    { ratio: 0.000, label: '0.00%', line: '#ef4444' },
    { ratio: 0.236, label: '23.6%', line: '#f97316' },
    { ratio: 0.382, label: '38.2%', line: '#22c55e' },
    { ratio: 0.500, label: '50.0%', line: '#06b6d4' },
    { ratio: 0.618, label: '61.8%', line: '#a855f7' },
    { ratio: 0.800, label: '80.0%', line: '#ec4899' },
    { ratio: 1.000, label: '100%',  line: '#3b82f6' }
  ];

  // ---- tiny DOM helpers (scoped to it-* ids) ----
  function $(id) { return document.getElementById(id); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t; }
  function getToken() {
    try { return (localStorage.getItem('upstox_token') || '').trim(); }
    catch (_) { return ''; }
  }
  // Dedicated intraday API pause (independent of the swing + options master
  // switches). Mirrors swing's sw_api_paused_v1. When ON, every intraday
  // Upstox call is blocked (all fetches route through apiPaused()), so the user
  // can protect their Upstox quota for Options Trading without touching the
  // other tabs. Survives reload via localStorage; in-memory fallback only in
  // private mode.
  var IT_API_PAUSED_KEY = 'it_api_paused_v1';
  // DEFAULT = PAUSED. On a first-ever visit (key absent) the tab stays paused so
  // it never auto-spends the user's Upstox quota — they explicitly flip to LIVE.
  // Once toggled, the explicit choice ('0' live / '1' paused) persists across
  // reloads. Private mode (no storage) also defaults to paused, fail-safe.
  function itIsApiPaused() {
    try {
      var v = localStorage.getItem(IT_API_PAUSED_KEY);
      return v === null ? true : v === '1';
    } catch (_) { return true; }
  }
  function itSetApiPaused(flag) {
    try { localStorage.setItem(IT_API_PAUSED_KEY, flag ? '1' : '0'); }
    catch (_) { /* private mode — session-only */ }
  }
  // Exposed so the intraday paper-book clone (scripts/intraday-paper-trade.js)
  // reads THIS tab's Live/Paused switch — not the Options tab's. Without this
  // the clone's itpIsApiPaused() couldn't see window.itIsApiPaused and fell
  // back to its own default-PAUSED key, so it wrongly reported "API paused"
  // even when the intraday header was flipped to LIVE.
  window.itIsApiPaused = itIsApiPaused;
  window.itSetApiPaused = itSetApiPaused;
  // Paused ONLY by this tab's own dedicated toggle — fully independent of the
  // Options Trading master switch (window.ptIsApiPaused). Pausing/resuming the
  // Options tab no longer touches the intraday chart, and vice-versa.
  function apiPaused() {
    return itIsApiPaused();
  }
  var IM = function () { return window.IndicatorMath || {}; };

  // ---- Market hours (reuse shared, else IST fallback w/o holidays) ----
  function isMarketOpen() {
    if (typeof window.isMarketOpen === 'function') {
      try { return !!window.isMarketOpen(); } catch (_) {}
    }
    var ist = new Date(Date.now() + IST_OFF_SEC * 1000);
    var dow = ist.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    var mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
  }
  function nextOpenLabel() {
    if (typeof window.nextOpenLabel === 'function') {
      try { return window.nextOpenLabel(); } catch (_) {}
    }
    return 'next session';
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // ISO timestamp -> LWC time. Intraday: shifted UNIX seconds so the
  // axis reads in IST. Daily: a {year,month,day} business-day object.
  function candleTime(ts, tf) {
    var ms = new Date(ts).getTime();
    if (!TF[tf] || !TF[tf].intraday) {
      var ist = new Date(ms + IST_OFF_SEC * 1000);
      return { year: ist.getUTCFullYear(), month: ist.getUTCMonth() + 1, day: ist.getUTCDate() };
    }
    return Math.floor(ms / 1000) + IST_OFF_SEC;
  }

  function rawToKlines(raw, tf) {
    if (!raw || !raw.length) return [];
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    return sorted.map(function (c) {
      return { time: candleTime(c[0], tf), open: +c[1], high: +c[2], low: +c[3], close: +c[4] };
    });
  }

  function rawToVolumes(raw, tf) {
    if (!raw || !raw.length) return [];
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    return sorted.map(function (c) {
      var cl = +c[4], op = +c[1];
      return {
        time: candleTime(c[0], tf),
        value: +c[5] || 0,
        color: cl >= op ? 'rgba(9,168,110,0.35)' : 'rgba(201,31,58,0.35)'
      };
    });
  }

  // ---- Lightweight Charts lazy loader (same CDN as swing/live) ----
  var LWC_CDN = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
  function loadLwcLib() {
    if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) return Promise.resolve();
    if (STATE.lwcLoading) return STATE.lwcLoading;
    STATE.lwcLoading = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + LWC_CDN + '"]');
      if (existing) {
        if (typeof LightweightCharts !== 'undefined') { resolve(); return; }
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('LWC CDN failed')); });
        return;
      }
      var s = document.createElement('script');
      s.src = LWC_CDN; s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('LWC CDN failed')); };
      document.head.appendChild(s);
    });
    return STATE.lwcLoading;
  }

  // ---- Data fetch (shared token + shared rate-limiter) ----
  // Fetches historical + intraday candles for a TF, deduped + sorted
  // ascending. Honours the master API pause and the global 429 gate so
  // it never piles onto a throttled Upstox key. Throws on NO_TOKEN /
  // UNAUTHORIZED / API_PAUSED; returns [] (never throws) on soft fails.
  async function fetchHistorical(tf, signal) {
    return fetchHistoricalKey(INSTRUMENT_KEY, tf, signal);
  }
  // Generalised candle fetch — same logic as fetchHistorical but for ANY
  // instrument key (the index for price + the Nifty FUTURE for its real volume,
  // since the index reports vol=0). Throws on NO_TOKEN / UNAUTHORIZED /
  // API_PAUSED; returns [] (never throws) on soft fails, EXCEPT it throws
  // NO_DATA only for the primary index path (the futures volume caller swallows
  // that as "no volume" — fail safe).
  async function fetchHistoricalKey(instrumentKey, tf, signal) {
    if (apiPaused()) throw new Error('API_PAUSED');
    var token = getToken();
    if (!token) throw new Error('NO_TOKEN');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('OFFLINE');
    var spec = TF[tf];
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var ikey = encodeURIComponent(instrumentKey);
    var to = new Date();
    var from = new Date();
    // Upstox V3 historical-candle caps the date range per unit. Exceeding it
    // returns HTTP 400 (→ empty → NO_DATA). Clamp the request window so a
    // generous historyDays can never silently break a TF:
    //   minutes interval 1 → 1 month · other minutes/hours → 1 quarter · days → years.
    var maxDays = (spec.unit === 'minutes')
      ? (spec.interval === '1' ? 28 : 90)
      : (spec.unit === 'hours' ? 90 : 3650);
    var effDays = Math.min(spec.historyDays, maxDays);
    from.setDate(to.getDate() - effDays);
    var histUrl  = V3 + '/historical-candle/' + ikey + '/' + spec.unit + '/' + spec.interval + '/' + fmtDate(to) + '/' + fmtDate(from);
    var intraUrl = V3 + '/historical-candle/intraday/' + ikey + '/' + spec.unit + '/' + spec.interval;

    async function fetchOne(url, kind) {
      if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return [];
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      try {
        var resp = await fetch(url, { headers: headers, signal: signal });
        if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
        if (resp.status === 429) {
          if (window._upstoxNote429) window._upstoxNote429('intraday-trade-' + kind);
          return [];
        }
        if (!resp.ok) return [];
        var d = await resp.json();
        if (window._upstoxNoteOk) window._upstoxNoteOk();
        return (d && d.data && d.data.candles) || [];
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (e && e.message === 'UNAUTHORIZED') throw e;
        return [];
      }
    }

    var results = await Promise.all([fetchOne(histUrl, 'hist'), fetchOne(intraUrl, 'intra')]);
    var merged = results[0].concat(results[1]);
    if (!merged.length) throw new Error('NO_DATA');
    var seen = {}, out = [];
    merged.forEach(function (c) { var t = c[0]; if (!seen[t]) { seen[t] = 1; out.push(c); } });
    out.sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    return out;
  }

  // Cache + de-dupe wrapper so rapid TF toggles reuse a recent fetch.
  function getRawForTf(tf, signal) {
    var cached = STATE.fetchCache[tf];
    if (cached && (Date.now() - cached.at) < FETCH_TTL_MS && cached.raw && cached.raw.length) {
      return Promise.resolve(cached.raw);
    }
    if (STATE.fetchInflight[tf]) return STATE.fetchInflight[tf];
    var p = fetchHistorical(tf, signal).then(function (raw) {
      STATE.fetchCache[tf] = { at: Date.now(), raw: raw };
      delete STATE.fetchInflight[tf];
      return raw;
    }, function (err) {
      delete STATE.fetchInflight[tf];
      throw err;
    });
    STATE.fetchInflight[tf] = p;
    return p;
  }

  // ═══════════════════════════════════════════════════════════════
  // NIFTY FUTURES VOLUME — the real-volume proxy for the index.
  // ═══════════════════════════════════════════════════════════════
  // The Nifty INDEX reports volume = 0 on Upstox, so we borrow the front-month
  // Nifty FUTURE's volume (what pros use as "index volume") to judge whether a
  // breakout is real or a trap. The contract key changes every monthly expiry,
  // so we resolve it from the data/nifty-futures.json snapshot (regenerated by
  // scripts/tools/build-nifty-futures.py). Fail-safe everywhere: any miss →
  // empty volume map → the app shows "volume unavailable", never a wrong claim.
  var FUT_STATE = {
    contracts: null,        // loaded snapshot array
    contractsLoading: null, // in-flight load promise (de-dupe)
    volCache: {},           // { tf: { at, map, contractKey } }
    volInflight: {}         // { tf: Promise }
  };
  var FUT_URL = 'data/nifty-futures.json';

  async function loadFuturesContracts() {
    if (FUT_STATE.contracts) return FUT_STATE.contracts;
    if (FUT_STATE.contractsLoading) return FUT_STATE.contractsLoading;
    FUT_STATE.contractsLoading = (async function () {
      try {
        var resp = await fetch(FUT_URL, { credentials: 'omit' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        FUT_STATE.contracts = (data && Array.isArray(data.contracts)) ? data.contracts : [];
      } catch (_) {
        FUT_STATE.contracts = []; // fail safe — resolver returns null → no volume
      }
      return FUT_STATE.contracts;
    })();
    return FUT_STATE.contractsLoading;
  }

  // The nearest non-expired Nifty future, or null (stale snapshot → no volume).
  function frontMonthFuture() {
    var c = FUT_STATE.contracts;
    if (!c || !c.length) return null;
    if (window.IntradayVolume && typeof window.IntradayVolume.pickFrontMonthFuture === 'function') {
      return window.IntradayVolume.pickFrontMonthFuture(c, Date.now());
    }
    return null;
  }

  // Build a { isoTimestamp: volume } map for the front-month future at this TF.
  // Reuses the SAME shared rate-limiter + 429 gate + API-pause as every other
  // fetch here, and a 20s cache so rapid re-renders don't re-hit Upstox. Returns
  // {} on any failure (paused, no token, throttled, no contract, network) so the
  // chart + detector degrade gracefully to "no volume".
  async function fetchFuturesVolMap(tf, signal) {
    if (apiPaused()) return {};
    if (!FUT_STATE.contracts) { try { await loadFuturesContracts(); } catch (_) {} }
    var contract = frontMonthFuture();
    if (!contract || !contract.instrument_key) return {};

    var cached = FUT_STATE.volCache[tf];
    if (cached && (Date.now() - cached.at) < FETCH_TTL_MS
        && cached.contractKey === contract.instrument_key && cached.map) {
      return cached.map;
    }
    if (FUT_STATE.volInflight[tf]) return FUT_STATE.volInflight[tf];

    var p = (async function () {
      try {
        var rawFut = await fetchHistoricalKey(contract.instrument_key, tf, signal);
        var map = {};
        for (var i = 0; i < rawFut.length; i++) {
          map[rawFut[i][0]] = (+rawFut[i][5]) || 0; // index 5 = volume
        }
        FUT_STATE.volCache[tf] = { at: Date.now(), map: map, contractKey: contract.instrument_key };
        return map;
      } catch (_) {
        return {}; // NO_DATA / NO_TOKEN / UNAUTHORIZED / API_PAUSED → no volume
      } finally {
        delete FUT_STATE.volInflight[tf];
      }
    })();
    FUT_STATE.volInflight[tf] = p;
    return p;
  }

  // One LTP read (V2 market-quote/ltp). Returns a finite number or null.
  async function fetchLtp() {
    if (apiPaused()) return null;
    var token = getToken();
    if (!token) return null;
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return null;
    if (window._upstoxBucket) await window._upstoxBucket.acquire();
    try {
      var url = V2 + '/market-quote/ltp?instrument_key=' + encodeURIComponent(INSTRUMENT_KEY);
      var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
      if (r.status === 429) { if (window._upstoxNote429) window._upstoxNote429('intraday-trade-ltp'); return null; }
      if (!r.ok) return null;
      var d = await r.json();
      var rec = d && d.data && Object.values(d.data)[0];
      if (!rec) return null;
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      var ltp = +rec.last_price;
      return (isFinite(ltp) && ltp > 0) ? ltp : null;
    } catch (_) { return null; }
  }

  // ---- status / live badge / overlay helpers ----
  function setChartOverlay(html) {
    var mount = $('it-chart');
    if (!mount) return;
    var ov = mount.querySelector('.it-chart-loading');
    if (!html) { if (ov) ov.remove(); return; }
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'it-chart-loading';
      mount.appendChild(ov);
    }
    ov.innerHTML = html;
  }
  function setChartStatus(text) { setText('it-chart-status', text); }
  function setLiveBadge(state, label) {
    var el = $('it-chart-live-badge');
    if (!el) return;
    el.className = 'it-chart-live ' + (state ? 'it-chart-live-' + state : '');
    el.textContent = label || '';
  }
  function setActiveTfBtn(tf) {
    var group = $('it-chart-tf-group');
    if (!group) return;
    group.querySelectorAll('.it-chart-tf-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tf') === tf);
    });
  }
  function syncIndToggles() {
    var legend = $('it-chart-legend');
    if (!legend) return;
    legend.querySelectorAll('.it-ind-toggle').forEach(function (el) {
      var id = el.getAttribute('data-ind');
      el.classList.toggle('active', !!STATE.indVisible[id]);
    });
  }

  // BOS is offered on 5m and higher — 1m/3m fractal pivots are too noisy to
  // frame reliable structure (real-money: avoid false BOS/CHoCH). 5m enabled
  // per user request (scalping reference timeframe).
  var BOS_TFS = { '5m': 1, '15m': 1, '30m': 1, '1h': 1, '4h': 1, '1d': 1 };
  function bosAllowed(tf) { return !!BOS_TFS[tf]; }

  // Show/disable the BOS legend chip per timeframe: visible+clickable on
  // 15m+, hidden on 1m/3m/5m so the user can't toggle a meaningless overlay.
  function updateBosAvailability(tf) {
    var chip = document.querySelector('#it-chart-legend .it-ind-toggle[data-ind="bos"]');
    if (chip) chip.hidden = !bosAllowed(tf);
  }

  // ---- LWC options (theme-aware, colours match swing/live) ----
  function isDark() { return document.documentElement.getAttribute('data-theme') !== 'light'; }
  function chartOptions(tf) {
    var dark = isDark();
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: dark ? '#0f172a' : '#ffffff' },
        textColor: dark ? '#94a3b8' : '#64748b',
        fontSize: 11, attributionLogo: false
      },
      grid: {
        vertLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.08)' },
        horzLines: { color: dark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.10)' }
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderVisible: false, autoScale: true },
      timeScale: { borderVisible: false, timeVisible: !!(TF[tf] && TF[tf].intraday), secondsVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true }, mouseWheel: true, pinch: true }
    };
  }
  function candleSeriesOpts() {
    return {
      upColor: '#09a86e', downColor: '#c91f3a',
      borderUpColor: '#09a86e', borderDownColor: '#c91f3a',
      wickUpColor: '#09a86e', wickDownColor: '#c91f3a'
    };
  }

  // ---- Overlays (reuse shared pure libs) ----
  var TIER1_BULL = {
    'Bullish Engulfing': 1, 'Morning Star': 1, 'Morning Doji Star': 1, 'Hammer': 1,
    'Three White Soldiers': 1, 'Piercing Pattern': 1, 'Dragonfly Doji': 1
  };
  var TIER1_BEAR = {
    'Bearish Engulfing': 1, 'Evening Star': 1, 'Evening Doji Star': 1, 'Shooting Star': 1,
    'Three Black Crows': 1, 'Dark Cloud Cover': 1, 'Gravestone Doji': 1
  };

  function addLine(chart, data, color, width, dashed) {
    if (!data || !data.length) return null;
    var opts = {
      color: color, lineWidth: width || 1.5, lastValueVisible: false, priceLineVisible: false
    };
    // LineStyle.Dashed === 2 in Lightweight Charts. Used for the Bollinger
    // upper/lower bands so they read as envelopes, not signal lines.
    if (dashed) opts.lineStyle = 2;
    var s = chart.addSeries(LightweightCharts.LineSeries, opts);
    s.setData(data);
    STATE.overlaySeries.push(s);
    return s;
  }

  // Session-anchored VWAP (resets each IST day). Falls back to a simple
  // mean of typical price when volume is 0 (Nifty index reports vol=0),
  // so the line is still a meaningful central tendency, not NaN.
  // Session-anchored VWAP (resets each IST day). The Nifty INDEX reports
  // volume = 0, so a naive read collapses to an unweighted mean of typical
  // price — NOT a real VWAP. When `volMap` (the front-month FUTURE's volume,
  // keyed by the raw ISO timestamp c[0] — see fetchFuturesVolMap) is supplied,
  // each bar is weighted by that futures volume, giving the TRUE volume-weighted
  // line a trader sees on their platform. Without it we fall back to the
  // typical-price mean (honest "average price today" anchor, just not weighted).
  // This same line feeds the stale-trend VWAP veto in classifyTfTrend, so a
  // correct VWAP directly sharpens the per-TF trend reads.
  function buildVwap(sorted, tf, volMap) {
    var out = [];
    var dayKey = null, cumPV = 0, cumV = 0, cumTP = 0, cnt = 0;
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var ist = new Date(new Date(c[0]).getTime() + IST_OFF_SEC * 1000);
      var key = ist.getUTCFullYear() + '-' + ist.getUTCMonth() + '-' + ist.getUTCDate();
      if (key !== dayKey) { dayKey = key; cumPV = 0; cumV = 0; cumTP = 0; cnt = 0; }
      var tp = (+c[2] + +c[3] + +c[4]) / 3;
      var v = +c[5] || 0;
      // Index volume is 0 → borrow the futures volume for this bar when we have it.
      if ((!v || v <= 0) && volMap) { var fv = volMap[c[0]]; if (isFinite(+fv) && +fv > 0) v = +fv; }
      cumPV += tp * v; cumV += v; cumTP += tp; cnt += 1;
      var val = cumV > 0 ? (cumPV / cumV) : (cumTP / cnt);
      out.push({ time: candleTime(c[0], tf), value: val });
    }
    return out;
  }

  // Bollinger Bands with an EMA middle band. Returns arrays aligned to `closes`
  // (leading slots NaN until the window fills). The basis is EMA(period); the
  // band offset is `mult` * the population standard deviation of close over the
  // SAME rolling `period` window (around the window's simple mean — the textbook
  // ta.stdev). Pure; no DOM, no state.
  function bollingerEma(closes, period, mult, math) {
    period = period || 9;
    mult = mult || 2;
    var n = closes.length;
    var mid = (math && math.ema) ? math.ema(closes, period) : [];
    var upper = new Array(n).fill(NaN);
    var lower = new Array(n).fill(NaN);
    for (var i = period - 1; i < n; i++) {
      if (!isFinite(mid[i])) continue;
      var sum = 0;
      for (var j = i - period + 1; j <= i; j++) sum += closes[j];
      var mean = sum / period;
      var v = 0;
      for (var k = i - period + 1; k <= i; k++) { var d = closes[k] - mean; v += d * d; }
      var sd = Math.sqrt(v / period);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid: mid, upper: upper, lower: lower };
  }

  function drawOverlays(chart, raw, tf) {
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var closes = sorted.map(function (c) { return +c[4]; });
    var times  = sorted.map(function (c) { return candleTime(c[0], tf); });
    var math = IM();

    // Oscillators (MACD, RSI) each render in their OWN pane below price. This
    // counter hands out the next free pane index so enabling either/both never
    // collides or leaves an empty pane (pane 0 is always the price pane).
    var nextOscPane = 1;
    function sizeOscPanes() {
      try {
        var panes = chart.panes();
        if (!panes || panes.length < 2) return;
        panes[0].setStretchFactor(3);                 // price pane dominates
        for (var p = 1; p < panes.length; p++) panes[p].setStretchFactor(1);
      } catch (_) {}
    }

    function emaLine(period, color) {
      if (!STATE.indVisible['ema' + period] || !math.ema) return;
      var vals = math.ema(closes, period), data = [];
      for (var i = 0; i < vals.length; i++) if (isFinite(vals[i])) data.push({ time: times[i], value: vals[i] });
      addLine(chart, data, color, 1.5);
    }
    emaLine(20, '#f97316');
    emaLine(50, '#9333ea');

    if (STATE.indVisible.sma44 && math.sma) {
      var sv = math.sma(closes, 44), sdata = [];
      for (var si = 0; si < sv.length; si++) if (isFinite(sv[si])) sdata.push({ time: times[si], value: sv[si] });
      addLine(chart, sdata, '#d97706', 1.5);
    }

    // Bollinger Bands with an EMA-9 middle band (intraday only). Basis = EMA(9);
    // upper/lower = basis +/- 2 * population stddev of close over the same
    // 9-period window. This matches TradingView's behaviour when the BB basis is
    // switched to EMA (ta.stdev is the window stddev around the SMA mean, added
    // to the chosen basis). Display-only — never feeds any signal.
    if (STATE.indVisible.bb && math.ema) {
      var bb = bollingerEma(closes, 9, 2, math);
      var midD = [], upD = [], loD = [];
      for (var bi = 0; bi < closes.length; bi++) {
        if (isFinite(bb.mid[bi]))   midD.push({ time: times[bi], value: bb.mid[bi] });
        if (isFinite(bb.upper[bi])) upD.push({ time: times[bi], value: bb.upper[bi] });
        if (isFinite(bb.lower[bi])) loD.push({ time: times[bi], value: bb.lower[bi] });
      }
      addLine(chart, upD,  '#ef4444', 1, true);   // upper (red, dashed)
      addLine(chart, loD,  '#3b82f6', 1, true);   // lower (blue, dashed)
      addLine(chart, midD, '#eab308', 1.5);       // EMA-9 basis (yellow, solid)
    }

    if (STATE.indVisible.vwap && TF[tf] && TF[tf].intraday) {
      // Weight by the front-month futures volume (STATE.futVolMap is for THIS
      // chart TF) so the drawn line is a true VWAP, not the index's zero-volume mean.
      addLine(chart, buildVwap(sorted, tf, STATE.futVolMap), '#3b82f6', 2);
    }

    // MACD(12,26,9) in its own pane below price (LWC v5 panes — the 3rd
    // addSeries arg is the pane index). Histogram = MACD - Signal (green above
    // zero, red below); MACD line blue, Signal line orange. Reuses the shared
    // IndicatorMath.macd (single source of truth). Display-only — no signal.
    if (STATE.indVisible.macd && math.macd) {
      var m = null;
      try { m = math.macd(closes); } catch (_) { m = null; }
      if (m && m.macd) {
        var PANE = nextOscPane++;
        var histData = [], macdData = [], sigData = [];
        for (var mi = 0; mi < closes.length; mi++) {
          if (isFinite(m.hist[mi])) {
            histData.push({
              time: times[mi], value: m.hist[mi],
              color: m.hist[mi] >= 0 ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)'
            });
          }
          if (isFinite(m.macd[mi]))   macdData.push({ time: times[mi], value: m.macd[mi] });
          if (isFinite(m.signal[mi])) sigData.push({ time: times[mi], value: m.signal[mi] });
        }
        try {
          var macdHist = chart.addSeries(LightweightCharts.HistogramSeries, {
            priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
            lastValueVisible: false, priceLineVisible: false
          }, PANE);
          macdHist.setData(histData);
          STATE.overlaySeries.push(macdHist);
          try { macdHist.createPriceLine({ price: 0, color: 'rgba(148,163,184,0.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false }); } catch (_) {}

          var macdLine = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#3b82f6', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false
          }, PANE);
          macdLine.setData(macdData);
          STATE.overlaySeries.push(macdLine);

          var sigLine = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#f97316', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false
          }, PANE);
          sigLine.setData(sigData);
          STATE.overlaySeries.push(sigLine);

          sizeOscPanes();
        } catch (_) {}
      }
    }

    // RSI(14) in its own pane below price. Line + 70 (overbought) / 30
    // (oversold) reference lines and a 50 midline. Reuses the shared
    // IndicatorMath.rsi (single source of truth). Display-only — no signal.
    if (STATE.indVisible.rsi && math.rsi) {
      var rv = null;
      try { rv = math.rsi(closes, 14); } catch (_) { rv = null; }
      if (rv && rv.length) {
        var rPane = nextOscPane++;
        var rsiData = [];
        for (var ri = 0; ri < rv.length; ri++) {
          if (isFinite(rv[ri])) rsiData.push({ time: times[ri], value: rv[ri] });
        }
        try {
          var rsiLine = chart.addSeries(LightweightCharts.LineSeries, {
            color: '#a855f7', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false,
            priceFormat: { type: 'price', precision: 1, minMove: 0.1 }
          }, rPane);
          rsiLine.setData(rsiData);
          STATE.overlaySeries.push(rsiLine);
          try {
            rsiLine.createPriceLine({ price: 70, color: 'rgba(239,68,68,0.55)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' });
            rsiLine.createPriceLine({ price: 50, color: 'rgba(148,163,184,0.40)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
            rsiLine.createPriceLine({ price: 30, color: 'rgba(34,197,94,0.55)', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' });
          } catch (_) {}
          sizeOscPanes();
        } catch (_) {}
      }
    }

    // Previous-day OHLC reference levels (intraday TFs only — a "previous day"
    // is only meaningful when the chart shows intraday bars). Four horizontal
    // dashed lines drawn on the candle series via createPriceLine, so they carry
    // axis labels and clear automatically when the series is recreated on the
    // next render. Fails safe: if a clean prior day can't be isolated, nothing
    // is drawn.
    if (STATE.indVisible.pdohlc && STATE.candleSeries && TF[tf] && TF[tf].intraday) {
      var pdo = computePrevDayOHLC(sorted);
      if (pdo) {
        var pdLines = [
          { price: pdo.high,  color: '#ef4444', label: 'PDH' },
          { price: pdo.open,  color: '#94a3b8', label: 'PDO' },
          { price: pdo.close, color: '#eab308', label: 'PDC' },
          { price: pdo.low,   color: '#22c55e', label: 'PDL' }
        ];
        for (var pi = 0; pi < pdLines.length; pi++) {
          var pl = pdLines[pi];
          if (!isFinite(pl.price)) continue;
          try {
            STATE.candleSeries.createPriceLine({
              price: pl.price, color: pl.color, lineWidth: 1, lineStyle: 2,
              axisLabelVisible: true, title: pl.label
            });
          } catch (_) {}
        }
      }
    }

    // CPR (Central Pivot Range) — daily pivot framework, intraday TFs only (a
    // daily pivot set is meaningless drawn on the 1d chart). Pivot / TC / BC +
    // R1 / S1 as horizontal price lines, computed from the PREVIOUS session via
    // the shared buildCpr → IndicatorMath.computeCPR (single source of truth
    // with the card). Static all day → non-repainting. Cleared on re-render.
    if (STATE.indVisible.cpr && STATE.candleSeries && TF[tf] && TF[tf].intraday) {
      drawCprLines(sorted, tf);
    }

    // Fib retracement is now drawn as a TradingView-style ANCHORED Fib (DOM
    // overlay, candle-to-candle segments + on-line labels) by renderFib(), called
    // from renderChart alongside the other price-anchored overlays — NOT here via
    // createPriceLine (which spans full width + tags the price axis).
  }

  // On-chart Fib direction tag, pinned next to the "FIB" legend chip. Reads the
  // mapped leg (legDir) + structure (fibDirection): up-leg = pocket is support
  // (buy-dip), down-leg = pocket is resistance (sell-bounce), consolidating =
  // range. Display-only label; mirrors what the Fib card already computes.
  function setFibDirLabel(fibCtx) {
    var el = $('it-fib-dir');
    if (!el) return;
    var ok = fibCtx && !fibCtx.building && isFinite(fibCtx.swHigh) && isFinite(fibCtx.swLow);
    if (!ok) { el.hidden = true; el.textContent = ''; el.className = 'it-fib-dir'; el.removeAttribute('data-tip'); el.removeAttribute('aria-label'); return; }
    var range = fibCtx.fibDirection === 'CONSOLIDATING';
    var up = fibCtx.legDir === 'UP';
    var txt = range ? '\u21C4 RANGE' : (up ? '\u2191 UP-LEG' : '\u2193 DOWN-LEG');
    var mod = range ? 'it-fib-dir--range' : (up ? 'it-fib-dir--up' : 'it-fib-dir--down');
    el.textContent = txt;
    el.className = 'it-fib-dir ' + mod;
    // Themed tooltip (data-tip → shared sw-zoi-tip bubble, dark/light aware) wired
    // on the chart legend in activate(). No native `title` (unthemed + "?" cursor);
    // aria-label keeps the same text accessible to screen readers.
    var dirTip = range
      ? 'Consolidating \u2014 Fib pocket is a mean-reversion zone, no clear directional edge.'
      : (up
        ? 'Up-leg: 0% is the rally top, 100% the rally start. The 38.2\u201361.8% pocket is potential SUPPORT (buy-the-dip / CE bias).'
        : 'Down-leg: 0% is the sell-off top, 100% the bottom. The 38.2\u201361.8% pocket is potential RESISTANCE (sell-the-bounce / PE bias).');
    el.setAttribute('data-tip', dirTip);
    el.setAttribute('aria-label', dirTip);
    el.hidden = false;
  }

  // TradingView-style ANCHORED Fib. Instead of full-width `createPriceLine`s with
  // price-axis tags, each level is a DOM segment drawn only across the leg's
  // candles (swing-start → swing-end), with the % + price label sitting ON the
  // line, plus a dashed diagonal connector from the leg origin to the leg end.
  // Glued to price/time every frame by startOverlayLoop (same mechanism as BOS).
  // `raw` is NEWEST-FIRST. Display-only; fails safe (draws nothing) on any error.
  function renderFib(raw, tf) {
    if (!STATE.indVisible.fib || !STATE.chart || !STATE.candleSeries
        || !(window._swCP && typeof window._swCP.computeFibZone === 'function')) {
      setFibDirLabel(null);
      return;
    }
    var fibCtx = null;
    try { fibCtx = computeIntradayFib(raw, tf); } catch (_) { fibCtx = null; }
    setFibDirLabel(fibCtx);
    if (!fibCtx || !isFinite(fibCtx.swHigh) || !isFinite(fibCtx.swLow) || fibCtx.swHigh <= fibCtx.swLow) return;
    var mount = $('it-chart');
    if (!mount) return;

    var leg = fibCtx.swHigh - fibCtx.swLow;
    var dnLeg = fibCtx.legDir === 'DOWN';
    var fibLevels = (window._swCP && window._swCP.FIB_BAND_LEVELS) || FIB_LEVELS_FALLBACK;

    // Leg span (chronological) → the segment's x-bounds. Both anchors carry raw
    // ISO timestamps; compare in ms to find the earlier/later end. If a timestamp
    // couldn't be resolved (rare), segStart/segEnd stay null → lines fall back to
    // full width (the gluer treats null bounds as edge-to-edge) and we skip the
    // diagonal connector — Fib still shows, never disappears.
    var haveTs = (fibCtx.swHighTs != null && fibCtx.swLowTs != null);
    var hiMs = haveTs ? new Date(fibCtx.swHighTs).getTime() : 0;
    var loMs = haveTs ? new Date(fibCtx.swLowTs).getTime() : 0;
    var segStart = null, segEnd = null;
    if (haveTs) {
      var earlierTs = (hiMs <= loMs) ? fibCtx.swHighTs : fibCtx.swLowTs;
      var laterTs   = (hiMs <= loMs) ? fibCtx.swLowTs  : fibCtx.swHighTs;
      try { segStart = candleTime(earlierTs, tf); segEnd = candleTime(laterTs, tf); }
      catch (_) { segStart = null; segEnd = null; haveTs = false; }
    }

    var fpf = function (v) { return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };

    var layer = document.createElement('div');
    layer.className = 'it-fib-layer';

    // Dashed diagonal connector: leg origin → leg end (low→high on an up-leg,
    // high→low on a down-leg). Drawn as an SVG line so any angle renders cleanly.
    // Only when both anchor times are known.
    if (haveTs) {
      var svgNS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'it-fib-connector');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none;overflow:visible;';
      var connLine = document.createElementNS(svgNS, 'line');
      connLine.style.stroke = 'var(--muted)';
      connLine.setAttribute('stroke-width', '1');
      connLine.setAttribute('stroke-dasharray', '4 3');
      connLine.setAttribute('opacity', '0.55');
      svg.appendChild(connLine);
      layer.appendChild(svg);
      STATE.fibConnector = {
        svg: svg, line: connLine,
        startTime: segStart,                            // earlier anchor in time
        endTime: segEnd,                                // later anchor in time
        startPrice: (hiMs <= loMs) ? fibCtx.swHigh : fibCtx.swLow,
        endPrice:   (hiMs <= loMs) ? fibCtx.swLow  : fibCtx.swHigh
      };
    }

    for (var fli = 0; fli < fibLevels.length; fli++) {
      var lvl = fibLevels[fli];
      var price = dnLeg
        ? (fibCtx.swLow + lvl.ratio * leg)
        : (fibCtx.swHigh - lvl.ratio * leg);
      if (!isFinite(price)) continue;
      var line = document.createElement('div');
      line.className = 'it-fib-line';
      line.style.borderTopColor = lvl.line;
      layer.appendChild(line);
      var label = document.createElement('span');
      label.className = 'it-fib-line-lbl';
      label.style.color = lvl.line;
      label.textContent = lvl.label + ' (' + fpf(price) + ')';
      layer.appendChild(label);
      // Approx label width (9px bold) so the glue loop can right-align labels just
      // inside the series edge without per-frame layout reads.
      var lblW = Math.ceil(label.textContent.length * 5.4) + 8;
      // Left stays anchored at the leg origin; the line EXTENDS RIGHT to the
      // series edge (endTime:null → gluer uses fullW) so the % (price) label lands
      // in the clear right area — away from candles, pattern arrows and BOS tags
      // even with every indicator on. The dashed connector still spans the leg
      // only, so the measured swing is still obvious on the left.
      STATE.fibEls.push({ el: line, label: label, price: price, startTime: segStart, endTime: null, lblW: lblW });
    }
    mount.appendChild(layer);
    STATE.fibLayer = layer;
  }

  // BOS / CHoCH structure — IDENTICAL rendering to the Swing chart.
  // Reuses the swing analyzer's chart-structure primitives (exposed on
  // window): detectStructureBreaks (fractal-pivot swings + BOS/CHoCH),
  // recentSwingTrend (regime), BOS_PIVOT_BY_TF (per-TF pivot width). Draws
  // HH/HL/LH/LL labels on each swing + dashed BOS (continuation) / CHoCH
  // (reversal) break lines, plus a trend badge. DOM overlay glued to price
  // (and the swing's own candle) every frame via the shared overlay rAF.
  // `raw` is newest-first (Upstox order) — same convention the swing
  // detector expects (it reverses internally; barIdx maps back via
  // raw[len-1-barIdx]). Fails safe (draws nothing) on any error.
  function renderBos(raw, tf) {
    // BOS structure is offered on 5m and higher — 1m/3m bars are too noisy for
    // reliable fractal pivots (false BOS/CHoCH). Hidden on 1m/3m (see bosAllowed
    // + the legend-chip gate in updateBosAvailability).
    if (!STATE.indVisible.bos || !bosAllowed(tf)) { STATE.bosTrend = null; return; }
    if (typeof window.detectStructureBreaks !== 'function' || !STATE.chart || !STATE.candleSeries) return;
    var mount = $('it-chart');
    if (!mount) return;

    var pivot = (window.BOS_PIVOT_BY_TF && window.BOS_PIVOT_BY_TF[tf]) || 5;
    var bosData;
    try { bosData = window.detectStructureBreaks(raw, { pivot: pivot }); } catch (_) { return; }
    if (!bosData) return;
    var swings = bosData.swings || [];
    var breaks = bosData.breaks || [];
    // Toolbar trend pill = the SAME net trend the Setup card shows for this TF
    // (classifyTfTrend: confirmed structure + the VWAP stale-trend veto + ADX),
    // so the chart and the recommendation can never contradict each other. The
    // HH/HL/LH/LL labels below stay as factual pivot annotations; the pill is the
    // net regime. Falls back to raw structure if the classifier can't read (few bars).
    try {
      var net = classifyTfTrend(STATE.raw, tf);
      if (net) STATE.bosTrend = net.dir === 'UP' ? 'BULLISH' : (net.dir === 'DOWN' ? 'BEARISH' : 'RANGING');
      else STATE.bosTrend = window.recentSwingTrend(bosData);
    } catch (_) {
      try { STATE.bosTrend = window.recentSwingTrend(bosData); } catch (__) { STATE.bosTrend = bosData.trend || null; }
    }

    var layer = STATE.bosLayer;
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'it-bos-layer';
      mount.appendChild(layer);
      STATE.bosLayer = layer;
    }

    // Trend badge is rendered as a pill in the chart TOOLBAR (see
    // updateLiveBadgeAndStatus) — identical to the swing chart. Nothing here.

    // Swing labels (HH/HL/LH/LL) — last 10, on their own candle.
    swings.slice(-10).forEach(function (vsw) {
      var isHigh = vsw.kind === 'HIGH';
      var color = (vsw.type === 'HH' || vsw.type === 'HL') ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)';
      var d = document.createElement('span');
      d.className = 'it-bos-swing';
      d.style.color = color;
      d.textContent = vsw.type;
      layer.appendChild(d);
      var swRaw = raw[raw.length - 1 - vsw.barIdx];
      var swTime = swRaw ? candleTime(swRaw[0], tf) : null;
      STATE.bosEls.push({ el: d, price: vsw.price, time: swTime, pos: isHigh ? 'above' : 'below' });
    });

    // Break markers (BOS = with-trend continuation, CHoCH = reversal) — last 5.
    // Each break is shown TWO ways: (1) a FAINT horizontal line at the broken
    // swing level (origin → break candle) for level reference; (2) a bold
    // TAG + arrow anchored directly ON the break candle (brk.barIdx) — like the
    // candlestick-pattern markers — so it's unambiguous which candle broke
    // structure. barIdx/swingIdx index the detector's oldest-first array; map
    // back via raw[len-1-idx] (raw is newest-first).
    breaks.slice(-5).forEach(function (brk) {
      var isBos = brk.type === 'BOS';
      var isBull = brk.direction === 'BULL';
      var color = isBos
        ? (isBull ? 'rgba(34,197,94,0.95)' : 'rgba(239,68,68,0.95)')
        : (isBull ? 'rgba(234,179,8,0.95)' : 'rgba(192,38,211,0.95)');
      var brkRaw = (brk.barIdx != null) ? raw[raw.length - 1 - brk.barIdx] : null;
      var swRaw2 = (brk.swingIdx != null) ? raw[raw.length - 1 - brk.swingIdx] : null;
      var brkTime = brkRaw ? candleTime(brkRaw[0], tf) : null;

      // (1) Faint level line.
      var line = document.createElement('div');
      line.className = 'it-bos-line';
      line.style.borderTopColor = color;
      line.style.opacity = '0.30';
      layer.appendChild(line);
      STATE.bosEls.push({
        el: line, price: brk.level, isLine: true,
        endTime: brkTime,
        startTime: swRaw2 ? candleTime(swRaw2[0], tf) : null
      });

      // (2) Bold tag ON the break candle. Anchored to the candle's low (bull,
      // below) or high (bear, above) so it hugs the breaking candle.
      if (brkRaw) {
        var mark = document.createElement('span');
        mark.className = 'it-bos-mark';
        mark.style.color = color;
        mark.textContent = (isBull ? '\u25B2 ' : '\u25BC ') + (isBos ? 'BOS' : 'CHoCH');
        layer.appendChild(mark);
        STATE.bosEls.push({
          el: mark,
          price: isBull ? +brkRaw[3] : +brkRaw[2],   // low (below) / high (above)
          time: brkTime,
          pos: isBull ? 'below' : 'above'
        });
      }
    });
  }

  // Tier-1 candlestick pattern markers. Walks bars, runs the SHARED
  // detectPatterns on a trailing window, marks bull/bear Tier-1 hits.
  // Never marks the still-forming last bar while the market is open
  // (no repainting). Uses per-bar local trend (close vs EMA50).
  function drawPatternMarkers(sorted, tf) {
    // Drive the chart arrows from the SAME rows the candlestick cards use
    // (collectIntradayPatterns) so the markers and the cards can never disagree
    // — exactly like swing's drawPatternMarkers/collectTier1Patterns pairing.
    // Confluence (★) reversals get a darker shade + larger arrow.
    var allRows = collectIntradayPatterns(sorted, tf);
    if (!allRows.length) return [];
    // Default view shows only the most-recent few (cards match); "Show history"
    // reveals every detected pattern on the chart too — lock-step with swing.
    // Default view = EVERY candlestick hit within the TF-aware SESSION WINDOW
    // (recencyMinTs: ~1 week on 15m/30m/1h, 2 sessions on 1m/3m/5m). On the
    // uncapped daily chart there's no window, so fall back to the most-recent few
    // (else the whole history would flood the chart). "Show history" reveals all.
    var rows;
    if (itCandleHistory) {
      rows = allRows;
    } else {
      var _cut = recencyMinTs(sorted);
      rows = (_cut > -Infinity)
        ? allRows.filter(function (r) { return new Date(r.ts).getTime() >= _cut; })
        : allRows.slice(-PATTERN_CARD_MAX);
    }
    return rows.map(function (r) {
      var bull = r.dir === 'bull';
      return {
        time: candleTime(r.ts, tf),
        position: bull ? 'belowBar' : 'aboveBar',
        color: bull ? (r.strong ? '#067a4f' : '#09a86e') : (r.strong ? '#9e1730' : '#c91f3a'),
        shape: bull ? 'arrowUp' : 'arrowDown',
        text: (r.strong ? '\u2605 ' : '') + r.name,
        size: r.strong ? 2 : 1
      };
    });
  }

  // ── TF-aware recency window (shared by zones + candlestick + chart patterns) ──
  // Returns the cutoff timestamp (ms epoch): only bars / levels at-or-after this
  // are "recent enough" to DRAW. The window scales with the chart and is inferred
  // from the bar spacing (so callers stay TF-agnostic):
  //   • 15m / 30m / 1h  → last ~1 trading WEEK (5 distinct sessions in the data).
  //     A level / pattern price hasn't broken in a few days is still live structure.
  //   • 1m / 3m / 5m    → last 2 sessions (today + prior). Fast order-flow turns
  //     over quickly here; older marks are noise on a scalp chart.
  //   • 1d daily / odd  → -Infinity (NO cap; deep history is wanted, swing-like).
  // Holiday/weekend safe — it counts DISTINCT sessions actually present in the
  // data, no calendar maths. Pure read; display-only (feeds no buy/sell verdict).
  function recencyMinTs(raw) {
    if (!raw || raw.length < 2) return -Infinity;
    var c = raw.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var n = c.length;
    var minGap = Infinity;
    for (var gi = Math.max(1, n - 12); gi < n; gi++) {
      var g = new Date(c[gi][0]).getTime() - new Date(c[gi - 1][0]).getTime();
      if (g > 0 && g < minGap) minGap = g;
    }
    if (!(isFinite(minGap) && minGap < 12 * 3600 * 1000)) return -Infinity; // daily / odd → no cap
    var sessKeep = (minGap >= 10 * 60 * 1000) ? 5 : 2; // ≥10m spacing ⇒ 15m+ ⇒ ~1 week
    function istDay(ms) { return new Date(ms + IST_OFF_SEC * 1000).toISOString().slice(0, 10); }
    var seen = {}, firsts = [];
    for (var di = 0; di < n; di++) {
      var ms = new Date(c[di][0]).getTime();
      var key = istDay(ms);
      if (!seen[key]) { seen[key] = 1; firsts.push(ms); }
    }
    return firsts.length ? firsts[Math.max(0, firsts.length - sessKeep)] : -Infinity;
  }
  // Keep only the bars within the recency window (returns the full array on
  // daily / odd data, where there is no cap). Used to scope the chart-pattern
  // detector to recent bars so it only draws patterns from this session window.
  function recencySlice(raw) {
    if (!raw || !raw.length) return raw;
    var cut = recencyMinTs(raw);
    if (!(cut > -Infinity)) return raw;
    return raw.filter(function (b) { return new Date(b[0]).getTime() >= cut; });
  }

  // ---- Demand / supply zones (institutional order blocks) ----
  // A zone = a small-bodied consolidation BASE immediately followed by a
  // strong directional LEG (displacement > ATR). The base price-band is
  // where institutions accumulated/distributed before the move; price
  // tends to react there again. DEMAND = base before a rally (support),
  // SUPPLY = base before a drop (resistance). We keep only FRESH (unbroken)
  // zones on the correct side of price, nearest first. Pure read of candles
  // — never mutates anything, returns [] on thin/odd data (fail safe).
  function detectZones(raw) {
    if (!raw || raw.length < 30) return [];
    var c = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var n = c.length;
    var math = IM();
    var atrVals = (math.atr ? math.atr(c, 14) : []);
    var curPx = +c[n - 1][4];
    if (!isFinite(curPx) || curPx <= 0) return [];

    function hi(i) { return +c[i][2]; }
    function lo(i) { return +c[i][3]; }
    function op(i) { return +c[i][1]; }
    function cl(i) { return +c[i][4]; }
    function bodyOf(i) { return Math.abs(cl(i) - op(i)); }
    function rangeOf(i) { var r = hi(i) - lo(i); return r > 0 ? r : 0.01; }
    function isBull(i) { return cl(i) > op(i); }
    function isBear(i) { return cl(i) < op(i); }
    function atrAt(i) { return (isFinite(atrVals[i]) && atrVals[i] > 0) ? atrVals[i] : 0; }

    // Recent ATR (last 7 true ranges) for the proximity filter — reflects
    // the CURRENT calm, not a stale rally's inflated ATR-14.
    var rAtr = 0, rc = 0;
    for (var ri = Math.max(1, n - 7); ri < n; ri++) {
      rAtr += Math.max(hi(ri) - lo(ri), Math.abs(hi(ri) - cl(ri - 1)), Math.abs(lo(ri) - cl(ri - 1)));
      rc++;
    }
    rAtr = rc ? (rAtr / rc) : (atrAt(n - 1) || curPx * 0.005);
    if (!(rAtr > 0)) rAtr = curPx * 0.005;

    // RECENCY CAP (intraday TFs only): a demand/supply level born too long ago is
    // STALE order-flow — it adds noise and a false "this is real structure" feel.
    // We keep only zones whose leg-out (confirmation) lands within the TF-aware
    // session window (see recencyMinTs — the SAME window the candlestick + chart-
    // pattern overlays use): ~1 trading week on 15m/30m/1h, 2 sessions on
    // 1m/3m/5m, NO cap on daily. The 8×ATR proximity + "broken when a candle
    // closes through it" rules already drop irrelevant/consumed levels; this
    // time-cap just trims ancient ones. _isIntradayBars ⟺ a cap applies
    // (recencyMinTs returns -Infinity only for daily/odd data, where the gate +
    // the walk-back clamp are correctly skipped). Display-only — no verdict.
    var _recencyMinTs = recencyMinTs(c);
    var _isIntradayBars = _recencyMinTs > -Infinity;

    // DISPLAY-ONLY: walk the detected base BACKWARD to the true start of the
    // sideways stretch (the detected base is only the last 1–3 bars before the
    // leg-out). Mirrors the swing chart. Stops at the impulse that delivered
    // price in, or a bar that closed outside the band. Confirmed bars only.
    function consolStartIdx(startIdx, top, bot) {
      var bandH = top - bot;
      if (!(bandH > 0) || startIdx <= 0) return startIdx;
      var tol = bandH * 0.6;
      var rngLo = bot - tol, rngHi = top + tol;
      // A genuine base OSCILLATES around one level. Walking back, stop the moment
      // the close has DRIFTED away from the base by more than ~0.75×ATR: beyond
      // that, price was still ARRIVING (a trending leg), not basing — so the
      // "Formed" date must not reach across it. (refCl = the base-start close =
      // the flat reference.) Without this, a slow directional grind that merely
      // stayed inside the wide band tolerance would push "Formed" too far back
      // onto a candle that wasn't part of the accumulation.
      var refCl = cl(startIdx);
      var driftCap = atrAt(startIdx) * 0.75;
      if (!(driftCap > 0)) driftCap = bandH; // fail-safe if ATR unavailable
      var idx = startIdx, guard = 0;
      for (var k = startIdx - 1; k >= 0 && guard < 40; k--, guard++) {
        // don't let the "Formed" date walk back past the recency window on a
        // scalp chart — a 2-session-old level shouldn't read as week-old structure.
        if (_isIntradayBars && _recencyMinTs > -Infinity && new Date(c[k][0]).getTime() < _recencyMinTs) break;
        var a2 = atrAt(k);
        if (a2 > 0 && bodyOf(k) > a2 * 0.85) break;          // impulse-in
        if (cl(k) < rngLo || cl(k) > rngHi) break;            // closed outside band
        if (hi(k) > rngHi + tol || lo(k) < rngLo - tol) break; // ranged far outside
        if (Math.abs(cl(k) - refCl) > driftCap) break;        // drifting away → arrival leg, not a flat base
        idx = k;
      }
      return idx;
    }

    var zones = [];
    for (var i = 15; i < n - 4; i++) {
      var a = atrAt(i);
      if (!a) continue;

      // BASE: 1–3 small-bodied candles starting at i. Track BOTH the wick
      // extremes (wHi/wLo) and the body extremes (bHi/bLo) so the zone can use
      // body for the proximal (entry) edge and wick for the distal (stop) edge.
      var baseEnd = i - 1, wHi = -Infinity, wLo = Infinity, bHi = -Infinity, bLo = Infinity;
      for (var k = i; k < Math.min(i + 3, n); k++) {
        if (bodyOf(k) > a * 0.6) break;
        wHi = Math.max(wHi, hi(k));
        wLo = Math.min(wLo, lo(k));
        bHi = Math.max(bHi, Math.max(op(k), cl(k)));
        bLo = Math.min(bLo, Math.min(op(k), cl(k)));
        baseEnd = k;
      }
      if (baseEnd < i) continue;
      if ((wHi - wLo) > a * 2.2) continue; // base too loose to be a zone

      // LEG: 1–4 strong same-direction candles right after the base.
      var legStart = baseEnd + 1;
      if (legStart >= n) continue;
      var dir = isBull(legStart) ? 1 : (isBear(legStart) ? -1 : 0);
      if (!dir) continue;
      var legEnd = legStart - 1;
      for (var m = legStart; m < Math.min(legStart + 4, n); m++) {
        if (dir === 1 && !isBull(m)) break;
        if (dir === -1 && !isBear(m)) break;
        if (bodyOf(m) / rangeOf(m) < 0.45) break;
        legEnd = m;
      }
      if (legEnd < legStart) continue;
      var disp = (dir === 1) ? (cl(legEnd) - op(legStart)) : (op(legStart) - cl(legEnd));
      if (disp < a * 1.0) continue; // weak leg out → not institutional

      var type = (dir === 1) ? 'DEMAND' : 'SUPPLY';
      // Boundaries: PROXIMAL (edge facing price = entry/reaction) uses the BODY;
      // DISTAL (far edge = stop / break level) uses the WICK. Matches the swing
      // chart. Demand sits below price so its proximal is the TOP (body high);
      // supply sits above so its proximal is the BOTTOM (body low).
      var zTop, zBot;
      if (type === 'DEMAND') {
        zTop = bHi;   // proximal — upper body edge (where buy orders rested)
        zBot = wLo;   // distal — lowest wick (liquidity sweep / break level)
      } else {
        zTop = wHi;   // distal — highest wick (liquidity sweep / break level)
        zBot = bLo;   // proximal — lower body edge (where sell orders rested)
      }

      // FRESHNESS + SIMPLE EXPIRY (display-only — this module feeds no verdict):
      //   • a candle CLOSING beyond the far edge = zone consumed → drop it.
      //   • each fresh re-entry into the band = one "touch" (counted ONCE per
      //     visit, not per bar, so price hovering in the zone isn't over-counted).
      //     1 touch → tested-but-held (faded); a 2nd touch retires the zone.
      //   Confirmed on candle closes / completed bars only — no repainting.
      var broken = false, touches = 0, prevOut = true;
      for (var p = legEnd + 1; p < n; p++) {
        if (type === 'DEMAND') {
          if (cl(p) < zBot) { broken = true; break; }   // closed below → broken
          var inD = lo(p) <= zTop;                       // range re-entered the band
          if (inD && prevOut) { touches++; if (touches >= 2) { broken = true; break; } }
          prevOut = !inD;
        } else {
          if (cl(p) > zTop) { broken = true; break; }    // closed above → broken
          var inS = hi(p) >= zBot;
          if (inS && prevOut) { touches++; if (touches >= 2) { broken = true; break; } }
          prevOut = !inS;
        }
      }
      if (broken) continue;

      // SIDE: demand must sit at/below price, supply at/above.
      if (type === 'DEMAND' && curPx < zBot) continue;
      if (type === 'SUPPLY' && curPx > zTop) continue;

      var inside = (curPx <= zTop && curPx >= zBot);
      var gap = inside ? 0 : Math.abs(type === 'DEMAND' ? (curPx - zTop) : (zBot - curPx));
      if (gap > rAtr * 8) continue; // too far to matter right now

      // startTs   = the consolidation START (base walked back) → card "Formed".
      // confirmTs = the FIRST leg-out bar (the breakout that proved the zone) →
      //             card "Confirmed". Mirrors the swing chart exactly. Both are
      // display-only (this module's verdict never reads zone dates) and anchor
      // on confirmed bars, never the live forming bar.
      // RECENCY GATE: on an intraday chart, drop a zone whose leg-out
      // (confirmation) is older than the last-2-sessions window. The 8×ATR
      // price filter above keeps zones at the right PRICE; this keeps them at
      // the right TIME. Daily bars are exempt (_isIntradayBars === false).
      var _confTs = (c[legStart] && c[legStart][0]) ? new Date(c[legStart][0]).getTime() : null;
      if (_isIntradayBars && _recencyMinTs > -Infinity && _confTs !== null && _confTs < _recencyMinTs) continue;

      var _cIdx = consolStartIdx(i, Math.max(zTop, zBot), Math.min(zTop, zBot));
      zones.push({
        type: type, top: zTop, bottom: zBot,
        startTs: (c[_cIdx] && c[_cIdx][0]) || c[i][0],
        confirmTs: (c[legStart] && c[legStart][0]) || null,
        gap: gap, touches: touches
      });
    }

    // MERGE nearby zones of the same type so the chart shows ONE clean band
    // instead of two confusing near-identical lines. Thresholds are ATR-based
    // (rAtr = recent volatility) so they auto-adapt — matching the rest of the
    // detector. Per type, nearest-to-price first, fold each candidate into the
    // kept set:
    //   • overlap, or edge-gap < 0.5×rAtr  → MERGE into the union band
    //     (unless the union would exceed 3×rAtr wide → demote to cluster).
    //   • edge-gap 0.5–1.5×rAtr            → keep SEPARATE but tag both 'cluster'
    //     (related levels; treat as a soft single area).
    //   • edge-gap ≥ 1.5×rAtr              → distinct, untagged.
    // The union keeps body/wick semantics: max top = closest-to-price body
    // proximal, min bottom = furthest wick distal. Cap at 2 bands per type.
    var MERGE_GAP = rAtr * 0.5;
    var CLUSTER_GAP = rAtr * 1.5;
    var MAX_MERGED_W = rAtr * 3;
    function gapToPx(top, bottom) {
      if (curPx > top) return curPx - top;     // band below price (demand)
      if (curPx < bottom) return bottom - curPx; // band above price (supply)
      return 0;                                 // price inside the band
    }
    function mergeZones(list) {
      var kept = [];
      list.sort(function (x, y) { return x.gap - y.gap; });
      for (var i = 0; i < list.length; i++) {
        var z = list[i], didMerge = false;
        for (var j = 0; j < kept.length; j++) {
          var k = kept[j];
          var ov = Math.min(z.top, k.top) - Math.max(z.bottom, k.bottom);
          var gapB = ov >= 0 ? 0 : -ov; // 0 = overlapping, else edge-gap
          if (gapB < MERGE_GAP) {
            var nt = Math.max(z.top, k.top), nb = Math.min(z.bottom, k.bottom);
            if ((nt - nb) <= MAX_MERGED_W) {
              k.top = nt; k.bottom = nb;
              k.touches = Math.max(k.touches || 0, z.touches || 0);
              if (z.cluster) k.cluster = true;
              k.gap = gapToPx(nt, nb);
              // DISPLAY-ONLY: KEEP k's OWN Formed/Confirmed. `k` is kept[0] for
              // this merge step — the nearest-to-price member — and the nearest
              // member is exactly the one that defines the band's PROXIMAL edge
              // (the entry edge a trader reacts to: highest top for demand /
              // lowest bottom for supply; merging farther members only extends
              // the DISTAL edge, never the proximal). So k's base + leg-out are
              // the dates that match the edge you trade. We deliberately do NOT
              // adopt an older/lower merged-in member's dates — that produced a
              // card whose "Formed/Confirmed" belonged to a DIFFERENT sub-zone
              // than the band's edge (a real mismatch). Swing/daily keeps its
              // own oldest-origin rule; this fix is intraday-specific.
              didMerge = true;
              break;
            }
            // Union too wide to be a usable scalp zone → treat as a cluster.
            z.cluster = true; k.cluster = true;
          } else if (gapB < CLUSTER_GAP) {
            z.cluster = true; k.cluster = true;
          }
        }
        if (!didMerge) {
          kept.push(z);
          if (kept.length >= 2) break;
        }
      }
      return kept;
    }
    var dem = mergeZones(zones.filter(function (z) { return z.type === 'DEMAND'; }));
    var sup = mergeZones(zones.filter(function (z) { return z.type === 'SUPPLY'; }));
    return dem.concat(sup);
  }

  // Tear down ALL price-anchored overlays (zones + BOS) and the shared gluer.
  function clearOverlays() {
    if (STATE.overlayRaf) { try { cancelAnimationFrame(STATE.overlayRaf); } catch (_) {} STATE.overlayRaf = 0; }
    if (STATE.zoneLayer && STATE.zoneLayer.parentNode) {
      try { STATE.zoneLayer.parentNode.removeChild(STATE.zoneLayer); } catch (_) {}
    }
    if (STATE.fzLayer && STATE.fzLayer.parentNode) {
      try { STATE.fzLayer.parentNode.removeChild(STATE.fzLayer); } catch (_) {}
    }
    if (STATE.bosLayer && STATE.bosLayer.parentNode) {
      try { STATE.bosLayer.parentNode.removeChild(STATE.bosLayer); } catch (_) {}
    }
    if (STATE.fvgLayer && STATE.fvgLayer.parentNode) {
      try { STATE.fvgLayer.parentNode.removeChild(STATE.fvgLayer); } catch (_) {}
    }
    if (STATE.obLayer && STATE.obLayer.parentNode) {
      try { STATE.obLayer.parentNode.removeChild(STATE.obLayer); } catch (_) {}
    }
    if (STATE.fibLayer && STATE.fibLayer.parentNode) {
      try { STATE.fibLayer.parentNode.removeChild(STATE.fibLayer); } catch (_) {}
    }
    STATE.zoneLayer = null;
    STATE.fzLayer = null;
    STATE.fzEls = [];
    STATE.bosLayer = null;
    STATE.fvgLayer = null;
    STATE.obLayer = null;
    STATE.fibLayer = null;
    STATE.fibConnector = null;
    STATE.bosEls = [];
    STATE.fvgEls = [];
    STATE.obEls = [];
    STATE.fibEls = [];
    // The shared chart-pattern lib appends DOM level labels (entry/target/
    // invalidation names) straight into the chart mount; it can't see our
    // teardown, so clear them here too — otherwise they orphan over the next
    // chart when the chart-pattern layer is toggled off.
    try {
      if (window.ChartPatterns && typeof window.ChartPatterns.clearOverlayLabels === 'function') {
        window.ChartPatterns.clearOverlayLabels();
      }
    } catch (_) {}
  }

  // Draw each zone as a price-anchored band (DOM rectangle inside the chart
  // mount). LWC has no native rectangle, so the band's vertical position is
  // glued to the price scale by the shared overlay loop (below). Bands span
  // the full width like a support/resistance area.
  function renderZones() {
    if (!STATE.indVisible.zoi || !STATE.chart || !STATE.candleSeries) return;
    var zones = STATE.zones || [];
    if (!zones.length) return;
    var mount = $('it-chart');
    if (!mount) return;

    var layer = document.createElement('div');
    layer.className = 'it-zone-layer';
    zones.forEach(function (z) {
      var d = document.createElement('div');
      // 'cluster' = a related sibling zone sits close by (0.5–1.5×ATR) but not
      // close enough to merge — drawn with a dashed edge as a soft single area.
      var clustered = !!z.cluster;
      d.className = 'it-zone ' + (z.type === 'DEMAND' ? 'demand' : 'supply') + (clustered ? ' cluster' : '');
      // A zone tested once (but still defended) is faded — weaker than a fresh,
      // untested level. A 2nd touch already retired it in detectZones.
      var tested = (z.touches || 0) >= 1;
      if (tested) d.style.opacity = '0.5';
      var lbl = document.createElement('span');
      lbl.className = 'it-zone-label';
      lbl.textContent = (z.type === 'DEMAND' ? 'Demand Zone' : 'Supply Zone')
        + (tested ? ' \u00b7 tested' : '') + (clustered ? ' \u00b7 cluster' : '');
      d.appendChild(lbl);
      z._el = d;
      layer.appendChild(d);
    });
    mount.appendChild(layer);
    STATE.zoneLayer = layer;
  }

  // ── FORMING (provisional) demand zones — amber/dashed, low-trust ──
  // Reuses the SWING module's backtested forming-zone detector + display filter
  // (window.__swingExports.formingZonesForDisplay) so the early reads are
  // byte-identical to the swing chart — same EARLY/WATCH tiers, same evidence,
  // same look-ahead-free scoring (a confirmed-bar feature; never the live bar).
  // Forming zones are DEMAND-only (the detector models early bullish reversals/
  // continuations). The display filter trims to unbroken + recent + near-price +
  // not-already-confirmed. Recency is sized to ~2 trading sessions for intraday
  // TFs (matching the confirmed-zone recency cap), full 40-bar default on daily.
  function computeFormingZones(raw, tf) {
    if (!STATE.indVisible.forming) return [];
    var SX = window.__swingExports;
    if (!SX || typeof SX.formingZonesForDisplay !== 'function') return [];
    if (!raw || raw.length < 30) return [];
    // detectFormingZones expects NEWEST-FIRST — normalise here so any caller order works.
    var nf = raw.slice().sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
    var spec = TF[tf];
    var px = isFinite(STATE.lastClose) ? STATE.lastClose : (nf[0] ? +nf[0][4] : NaN);
    // confirmed zones, mapped to the swing {type, proximal, distal} shape so the
    // filter's "don't double-draw an already-confirmed level" dedup works (our
    // detectZones emits top/bottom, not proximal/distal).
    var confirmed = (STATE.zones || []).map(function (z) {
      return { type: z.type, proximal: z.top, distal: z.bottom };
    });
    // recentBars: ~2 sessions for intraday TFs (375 min/session), swing-default 40 on daily.
    var recentBars = 40;
    if (spec && spec.intraday && spec.bucketMs > 0) {
      var perSession = Math.round((375 * 60 * 1000) / spec.bucketMs);
      recentBars = Math.max(40, perSession * 2);
    }
    var list = [];
    try { list = SX.formingZonesForDisplay(nf, confirmed, px, { recentBars: recentBars, nearAtr: 8, cap: 3 }) || []; }
    catch (_) { list = []; }
    return list;
  }

  // Draw the forming zones as amber, dashed-edge full-width bands (same glue
  // mechanism as the confirmed zones). Inline styles mirror the swing chart
  // exactly: EARLY (tradeable reversal) is brighter than WATCH (continuation).
  function renderFormingZones(raw, tf) {
    STATE.fzEls = [];
    STATE.formingZones = [];
    if (!STATE.indVisible.forming || !STATE.chart || !STATE.candleSeries) return;
    var list = computeFormingZones(raw, tf);
    STATE.formingZones = list;            // cached so the cards reuse the SAME set
    if (!list.length) return;
    var mount = $('it-chart');
    if (!mount) return;
    var layer = document.createElement('div');
    layer.className = 'it-zone-layer it-forming-layer';
    list.forEach(function (fz) {
      var early = !!fz.tradeable;
      var bg   = early ? 'rgba(245,158,11,0.13)' : 'rgba(245,158,11,0.07)';
      var edge = early ? 'rgba(245,158,11,0.65)' : 'rgba(245,158,11,0.40)';
      var txt  = early ? 'rgba(245,158,11,0.95)' : 'rgba(245,158,11,0.70)';
      var d = document.createElement('div');
      d.className = 'it-zone it-forming-zone';
      d.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:1;'
        + 'background:' + bg + ';border-top:1px dashed ' + edge + ';'
        + 'border-bottom:1px dashed ' + edge + ';display:none;';
      var lbl = document.createElement('span');
      lbl.className = 'it-zone-label';
      // bottom-anchored so it never collides with the top-pinned confirmed-zone label.
      lbl.textContent = 'Forming \u00b7 ' + (early ? 'EARLY' : 'WATCH');
      lbl.style.cssText = 'top:auto;bottom:2px;color:' + txt + ';';
      d.appendChild(lbl);
      STATE.fzEls.push({ el: d, proximal: fz.proximal, distal: fz.distal });
      layer.appendChild(d);
    });
    mount.appendChild(layer);
    STATE.fzLayer = layer;
  }

  // ── Fair Value Gaps (FVG) — full-width price bands ──
  // Reuses the swing module's pure detectFVG (window.detectFVG) so the gaps are
  // byte-identical to the swing chart. detectFVG expects NEWEST-FIRST candles
  // (it reverses internally); renderChart hands us that order. Bullish gaps are
  // blue, bearish orange — same palette as swing.
  function renderFvg(raw, tf) {
    if (!STATE.indVisible.fvg || !STATE.chart || !STATE.candleSeries) return;
    if (typeof window.detectFVG !== 'function') return;
    var gaps = [];
    try { gaps = window.detectFVG(raw) || []; } catch (_) { gaps = []; }
    if (!gaps.length) return;
    var mount = $('it-chart');
    if (!mount) return;

    var layer = document.createElement('div');
    layer.className = 'it-fvg-layer';
    gaps.forEach(function (g) {
      var isBull = g.type === 'BULL';
      var bg   = isBull ? 'rgba(59,130,246,0.12)' : 'rgba(251,146,60,0.12)';
      var edge = isBull ? 'rgba(59,130,246,0.40)' : 'rgba(251,146,60,0.40)';
      var txt  = isBull ? 'rgba(59,130,246,0.80)' : 'rgba(251,146,60,0.80)';
      var d = document.createElement('div');
      d.className = 'it-fvg-rect';
      d.style.cssText = 'position:absolute;pointer-events:none;z-index:1;display:none;'
        + 'background:' + bg + ';border:1px dashed ' + edge + ';';
      var lbl = document.createElement('span');
      lbl.textContent = 'FVG';
      lbl.style.cssText = 'position:absolute;left:4px;top:1px;font-size:8px;font-weight:700;'
        + 'letter-spacing:0.5px;color:' + txt + ';text-shadow:0 0 4px var(--bg),0 0 4px var(--bg);';
      d.appendChild(lbl);
      layer.appendChild(d);
      // startTime = the gap-forming (middle) candle; endTime = the most recent
      // candle. The box is drawn between them, so the origin candle is obvious
      // and the band stops at the latest price action (never runs into the
      // right-edge gap / price axis).
      var startTime = null, endTime = null;
      try { startTime = g.formed != null ? candleTime(g.formed, tf) : null; } catch (_) { startTime = null; }
      try { endTime = (raw && raw.length) ? candleTime(raw[0][0], tf) : null; } catch (_) { endTime = null; }
      STATE.fvgEls.push({ el: d, top: g.top, bottom: g.bottom, startTime: startTime, endTime: endTime });
    });
    mount.appendChild(layer);
    STATE.fvgLayer = layer;
  }

  // ── Order Blocks (OB) — full-width price bands ──
  // Reuses the swing module's pure detectOrderBlocks (window.detectOrderBlocks)
  // for identical blocks. It needs NEWEST-FIRST candles + the tf (for the
  // per-TF BOS pivot width); renderChart supplies both. Bullish = teal,
  // bearish = fuchsia, same as swing. Label notes USED (mitigated) blocks.
  function renderOb(raw, tf) {
    if (!STATE.indVisible.ob || !STATE.chart || !STATE.candleSeries) return;
    if (typeof window.detectOrderBlocks !== 'function') return;
    var blocks = [];
    try { blocks = window.detectOrderBlocks(raw, tf) || []; } catch (_) { blocks = []; }
    if (!blocks.length) return;
    var mount = $('it-chart');
    if (!mount) return;

    var layer = document.createElement('div');
    layer.className = 'it-ob-layer';
    blocks.forEach(function (ob) {
      var isBull = ob.type === 'BULL';
      var bg   = isBull ? 'rgba(20,184,166,0.13)' : 'rgba(217,70,239,0.13)';
      var edge = isBull ? 'rgba(20,184,166,0.55)' : 'rgba(217,70,239,0.55)';
      var txt  = isBull ? 'rgba(20,184,166,0.90)' : 'rgba(217,70,239,0.90)';
      var d = document.createElement('div');
      d.className = 'it-ob-rect';
      d.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:1;display:none;'
        + 'background:' + bg + ';border-top:1px solid ' + edge + ';border-bottom:1px solid ' + edge + ';';
      var lbl = document.createElement('span');
      lbl.textContent = (isBull ? 'BULL OB' : 'BEAR OB') + (ob.freshness === 'FRESH' ? '' : ' \u00b7 USED');
      lbl.style.cssText = 'position:absolute;left:8px;top:1px;font-size:8px;font-weight:700;'
        + 'letter-spacing:0.5px;color:' + txt + ';text-shadow:0 0 4px var(--bg),0 0 4px var(--bg);';
      d.appendChild(lbl);
      layer.appendChild(d);
      STATE.obEls.push({ el: d, proximal: ob.proximal, distal: ob.distal });
    });
    mount.appendChild(layer);
    STATE.obLayer = layer;
  }

  // ONE rAF loop glues every price-anchored overlay (zone bands + BOS swing
  // labels + break lines) to the price/time scales. LWC emits no event during
  // wheel/drag, so a continuous rAF is the robust way to keep overlays stuck
  // to the chart. A handful of divs per frame — negligible. Self-cancels when
  // the tab is left or the chart is disposed.
  function startOverlayLoop() {
    if (STATE.overlayRaf) return;
    function tick() {
      if (!STATE.active || !STATE.chart || !STATE.candleSeries) { STATE.overlayRaf = 0; return; }
      var series = STATE.candleSeries;
      var ts = STATE.chart.timeScale();
      var fullW = 0; try { fullW = ts.width(); } catch (_) {}

      // Zone bands (price-only, full width).
      var zones = STATE.zones || [];
      for (var zi = 0; zi < zones.length; zi++) {
        var z = zones[zi];
        if (!z._el) continue;
        var yT = null, yB = null;
        try { yT = series.priceToCoordinate(z.top); yB = series.priceToCoordinate(z.bottom); } catch (_) {}
        if (yT == null || yB == null) { z._el.style.display = 'none'; continue; }
        var zt = Math.min(yT, yB), zh = Math.abs(yB - yT);
        if (zh < 2) zh = 2;
        z._el.style.display = 'block';
        z._el.style.top = zt + 'px';
        z._el.style.height = zh + 'px';
      }

      // Forming zones (amber/dashed, price-only, full width) — same gluing as
      // the confirmed bands above. Full width so they read as a level area.
      var fzEls = STATE.fzEls || [];
      for (var fzi = 0; fzi < fzEls.length; fzi++) {
        var fzd = fzEls[fzi];
        if (!fzd.el) continue;
        var fyT = null, fyB = null;
        try { fyT = series.priceToCoordinate(fzd.proximal); fyB = series.priceToCoordinate(fzd.distal); } catch (_) {}
        if (fyT == null || fyB == null) { fzd.el.style.display = 'none'; continue; }
        var fzt = Math.min(fyT, fyB), fzh = Math.abs(fyB - fyT);
        if (fzt < 0) { fzh += fzt; fzt = 0; }
        if (fzh < 3) fzh = 3;
        fzd.el.style.display = 'block';
        fzd.el.style.top = fzt + 'px';
        fzd.el.style.height = fzh + 'px';
        fzd.el.style.width = (fullW || 0) + 'px';
      }

      // Price band gluing. top edge clamped to 0 so the band + label never ride
      // into the toolbar. startTime/endTime (optional) bound the band between
      // two candles — used by FVG so the origin candle is obvious AND the box
      // stops at the latest candle (never runs into the right-edge gap / price
      // axis). Without them, the band spans the full width (used by OB).
      function glueBand(el, pHi, pLo, startTime, endTime) {
        if (!el) return;
        var a = null, b = null;
        try { a = series.priceToCoordinate(pHi); b = series.priceToCoordinate(pLo); } catch (_) {}
        if (a == null || b == null) { el.style.display = 'none'; return; }
        var t = Math.min(a, b), h = Math.abs(a - b);
        if (t < 0) { h += t; t = 0; }
        var left = 0, w = fullW;
        if (startTime != null) {
          var x1 = null, x2 = null;
          try { x1 = ts.timeToCoordinate(startTime); } catch (_) {}
          try { x2 = (endTime != null) ? ts.timeToCoordinate(endTime) : null; } catch (_) {}
          // Clamp the origin to the left edge once it scrolls out so the band
          // stays visible; clamp the right edge to the latest candle (or the
          // chart edge if that candle scrolled off-screen to the right).
          left = (x1 == null || x1 < 0) ? 0 : x1;
          var right = (x2 == null) ? fullW : Math.min(x2, fullW);
          w = right - left;
          if (w < 1) w = 1;
        }
        el.style.top = t + 'px';
        el.style.height = Math.max(h, 2) + 'px';
        el.style.left = left + 'px';
        el.style.width = w + 'px';
        el.style.display = 'block';
      }
      var fvgEls = STATE.fvgEls || [];
      for (var fi = 0; fi < fvgEls.length; fi++) glueBand(fvgEls[fi].el, fvgEls[fi].top, fvgEls[fi].bottom, fvgEls[fi].startTime, fvgEls[fi].endTime);
      var obEls = STATE.obEls || [];
      for (var oi = 0; oi < obEls.length; oi++) glueBand(obEls[oi].el, obEls[oi].proximal, obEls[oi].distal);

      // Anchored Fib: each level is a SEGMENT spanning the leg's candles
      // (startTime → endTime), with its label sitting just past the right end —
      // ON the line, not on the price axis. Origin clamps to the left edge when
      // it scrolls out so the segment still terminates on the leg-end candle.
      var fibEls = STATE.fibEls || [];
      for (var fxi = 0; fxi < fibEls.length; fxi++) {
        var fe = fibEls[fxi];
        if (!fe.el) continue;
        var fy = null;
        try { fy = series.priceToCoordinate(fe.price); } catch (_) {}
        if (fy == null) { fe.el.style.display = 'none'; if (fe.label) fe.label.style.display = 'none'; continue; }
        var fx1 = null, fx2 = null;
        try {
          if (fe.startTime != null) fx1 = ts.timeToCoordinate(fe.startTime);
          if (fe.endTime != null) fx2 = ts.timeToCoordinate(fe.endTime);
        } catch (_) {}
        var fLeft = (fx1 == null || fx1 < 0) ? 0 : fx1;
        var fRight = (fx2 == null) ? fullW : Math.min(fx2, fullW);
        if (fRight < fLeft) fRight = fLeft;
        var fW = fRight - fLeft; if (fW < 1) fW = 1;
        fe.el.style.top = fy + 'px';
        fe.el.style.left = fLeft + 'px';
        fe.el.style.width = fW + 'px';
        fe.el.style.display = 'block';
        if (fe.label) {
          // Right-align the label just INSIDE the series edge (fullW) so it lands
          // in the clear right area and never bleeds onto the price axis. Clamp so
          // it never crosses left of the leg origin.
          var lw = fe.lblW || 70;
          var lx = fRight - lw - 4;
          if (lx < fLeft + 2) lx = fLeft + 2;
          fe.label.style.right = 'auto';
          fe.label.style.left = lx + 'px';
          fe.label.style.top = fy + 'px';
          fe.label.style.display = 'block';
        }
      }
      // Fib diagonal connector (leg origin → leg end) — an SVG line re-pointed
      // each frame. Hidden if either endpoint can't be projected.
      var fc = STATE.fibConnector;
      if (fc && fc.line) {
        var cx1 = null, cy1 = null, cx2 = null, cy2 = null;
        try {
          cx1 = ts.timeToCoordinate(fc.startTime); cy1 = series.priceToCoordinate(fc.startPrice);
          cx2 = ts.timeToCoordinate(fc.endTime);   cy2 = series.priceToCoordinate(fc.endPrice);
        } catch (_) {}
        if (cx1 != null && cy1 != null && cx2 != null && cy2 != null) {
          fc.line.setAttribute('x1', Math.max(0, cx1)); fc.line.setAttribute('y1', cy1);
          fc.line.setAttribute('x2', cx2); fc.line.setAttribute('y2', cy2);
          fc.svg.style.display = 'block';
        } else { fc.svg.style.display = 'none'; }
      }

      // BOS swing labels (on their own candle) + break lines (full width),
      // with collision-avoidance nudging so clustered labels stay readable.
      var cw = 0; try { cw = ts.width(); } catch (_) {}
      var placed = [];
      var XGAP = 22, YGAP = 11, STEP = 11;
      function collides(x, t) {
        for (var p = 0; p < placed.length; p++) {
          if (Math.abs(placed[p].x - x) < XGAP && Math.abs(placed[p].top - t) < YGAP) return true;
        }
        return false;
      }
      var els = STATE.bosEls || [];
      for (var bi = 0; bi < els.length; bi++) {
        var be = els[bi];
        if (!be.el) continue;
        var py = null;
        try { py = series.priceToCoordinate(be.price); } catch (_) {}
        if (py == null) { be.el.style.display = 'none'; continue; }
        if (be.isLine) {
          // Anchor the break line as a segment: broken-swing origin → break
          // candle, so the label lands on the candle that broke structure.
          var x1 = null, x2 = null;
          try {
            if (be.startTime != null) x1 = ts.timeToCoordinate(be.startTime);
            if (be.endTime != null) x2 = ts.timeToCoordinate(be.endTime);
          } catch (_) {}
          be.el.style.top = py + 'px';
          if (x2 == null) {
            // Break candle scrolled off-screen → fall back to a full-width line.
            be.el.style.left = '0px';
            be.el.style.width = cw + 'px';
          } else {
            // Clamp the origin to the left edge when it's scrolled out so the
            // segment still terminates exactly on the break candle.
            var left = (x1 == null || x1 < 0) ? 0 : x1;
            var w = x2 - left;
            if (w < 1) w = 1;
            be.el.style.left = left + 'px';
            be.el.style.width = w + 'px';
          }
          be.el.style.display = 'block';
        } else {
          var bx = null;
          try { bx = be.time != null ? ts.timeToCoordinate(be.time) : null; } catch (_) {}
          if (bx == null) { be.el.style.display = 'none'; continue; }
          var top = py + (be.pos === 'above' ? -14 : 4);
          var dir = be.pos === 'above' ? -1 : 1, guard = 0;
          while (collides(bx, top) && guard++ < 12) top += dir * STEP;
          placed.push({ x: bx, top: top });
          be.el.style.left = bx + 'px';
          be.el.style.transform = 'translateX(-50%)';
          be.el.style.top = top + 'px';
          be.el.style.display = 'block';
        }
      }
      STATE.overlayRaf = requestAnimationFrame(tick);
    }
    STATE.overlayRaf = requestAnimationFrame(tick);
  }

  // Update the toolbar LTP read-out + the change vs previous close.
  function renderLtpReadout(ltp) {
    var box = $('it-chart-ltp');
    if (!box) return;
    if (ltp == null || !isFinite(ltp)) { box.hidden = true; return; }
    box.hidden = false;
    setText('it-chart-ltp-val', ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    var chg = $('it-chart-ltp-chg');
    if (chg && STATE.prevClose != null && isFinite(STATE.prevClose) && STATE.prevClose > 0) {
      var diff = ltp - STATE.prevClose;
      var pct = (diff / STATE.prevClose) * 100;
      var sign = diff >= 0 ? '+' : '';
      chg.textContent = sign + diff.toFixed(2) + ' (' + sign + pct.toFixed(2) + '%)';
      chg.className = 'it-chart-ltp-chg ' + (diff >= 0 ? 'up' : 'down');
    } else if (chg) {
      chg.textContent = '';
      chg.className = 'it-chart-ltp-chg';
    }
  }

  // ---- Chart render ----
  // Trackpad / mouse-wheel over the PRICE axis → gentle price-range zoom,
  // anchored at the cursor (ported verbatim from the swing chart so both feel
  // identical). LWC's default wheel-over-anywhere zooms the TIME axis fast and
  // hard; this intercepts wheel events in the right ~65px (the price scale) and
  // applies a soft setVisibleRange zoom instead — exp(deltaY * 0.0005) clamped
  // to ±2× per event, so one notch can never leap. Wheel over the chart body is
  // left untouched (default LWC time-zoom). Attached ONCE to the persistent
  // mount; the handler reads STATE.chart / STATE.candleSeries so it always
  // targets the current chart across TF re-renders.
  function attachPriceAxisZoom(mount) {
    if (!mount || mount._itPriceZoomAttached) return;
    mount._itPriceZoomAttached = true;
    var PS_WIDTH = 65;

    function isOnPriceScale(e) {
      var rect = mount.getBoundingClientRect();
      return (e.clientX >= rect.right - PS_WIDTH);
    }

    mount.addEventListener('wheel', function (e) {
      var chart = STATE.chart, series = STATE.candleSeries;
      if (!chart || !series) return;
      if (!isOnPriceScale(e)) return;        // body wheel → default LWC time-zoom
      if (Math.abs(e.deltaY) < 1) return;
      e.preventDefault();
      e.stopPropagation();

      var ps = chart.priceScale('right');
      var rect = mount.getBoundingClientRect();
      var h = mount.clientHeight || rect.height || 1;

      var top, bot, cur = null;
      try { cur = ps.getVisibleRange(); } catch (_) {}
      if (cur && isFinite(cur.from) && isFinite(cur.to)) {
        top = Math.max(cur.from, cur.to);
        bot = Math.min(cur.from, cur.to);
      } else {
        top = series.coordinateToPrice(0);
        bot = series.coordinateToPrice(h);
      }
      if (!isFinite(top) || !isFinite(bot) || top <= bot) return;

      // Anchor at the price under the cursor so it stays put while zooming.
      var pc = series.coordinateToPrice(e.clientY - rect.top);
      if (!isFinite(pc)) pc = (top + bot) / 2;

      var ZOOM_SENSITIVITY = 0.0005;          // same as swing (0.0005 slow … 0.003 fast)
      var k = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
      k = Math.max(0.5, Math.min(2, k));      // cap one event to +/-2x
      var newTop = pc + (top - pc) * k;
      var newBot = pc - (pc - bot) * k;

      var span = newTop - newBot;
      if (!(span > 0.5) || !isFinite(span)) return;

      try {
        ps.setAutoScale(false);
        ps.setVisibleRange({ from: newBot, to: newTop });
      } catch (_) {}
    }, { capture: true, passive: false });

    // Double-click anywhere → back to auto-fit (price + time), matching swing.
    mount.addEventListener('dblclick', function () {
      var chart = STATE.chart;
      if (!chart) return;
      try {
        var ps = chart.priceScale('right');
        ps.setAutoScale(true);
        ps.applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
      } catch (_) {}
      try { chart.timeScale().fitContent(); } catch (_) {}
    });

    // ── VERTICAL grab-and-drag pan (desktop mouse) — match swing ──
    // LWC pans TIME on a body drag but leaves the price axis on autoScale, so
    // out of the box the chart can't be dragged up/down until a price-axis
    // zoom flips autoScale off. Swing adds a custom handler so a body drag pans
    // BOTH axes from first load (a diagonal drag moves the chart "360"); this
    // ports the same behaviour. We SHIFT the visible price range by the grabbed
    // price delta (constant span — true grab-and-drag), reading the current
    // chart/series from STATE so it survives TF re-renders. Drags starting over
    // the price axis are skipped (LWC scales it there). Reset is the dblclick
    // handler above (setAutoScale(true) + fitContent).
    var vpan = { dragging: false, lastY: 0 };
    mount.addEventListener('mousedown', function (e) {
      var chart = STATE.chart;
      if (!chart || e.button !== 0) return;
      var ps = chart.priceScale('right');
      var rect = mount.getBoundingClientRect();
      var axisW = 0;
      try { axisW = ps.width() || 0; } catch (_) {}
      if (axisW && (e.clientX - rect.left) > rect.width - axisW) return; // over price axis
      vpan.dragging = true; vpan.lastY = e.clientY;
    });
    window.addEventListener('mousemove', function (e) {
      if (!vpan.dragging) return;
      var chart = STATE.chart, s = STATE.candleSeries;
      if (!chart || !s) { vpan.dragging = false; return; }
      var rect = mount.getBoundingClientRect();
      var prevY = vpan.lastY - rect.top;
      var curY = e.clientY - rect.top;
      vpan.lastY = e.clientY;
      if (prevY === curY) return;

      var ps = chart.priceScale('right');
      var cur = null;
      try { cur = ps.getVisibleRange(); } catch (_) {}
      var top, bot;
      if (cur && isFinite(cur.from) && isFinite(cur.to)) {
        top = Math.max(cur.from, cur.to); bot = Math.min(cur.from, cur.to);
      } else {
        top = s.coordinateToPrice(0); bot = s.coordinateToPrice(rect.height);
      }
      if (!isFinite(top) || !isFinite(bot) || top <= bot) return;

      var pPrev = s.coordinateToPrice(prevY);
      var pCur = s.coordinateToPrice(curY);
      if (!isFinite(pPrev) || !isFinite(pCur)) return;
      var d = pPrev - pCur;                 // price the cursor moved across
      if (!d) return;
      try {
        ps.setAutoScale(false);
        ps.setVisibleRange({ from: bot + d, to: top + d });
      } catch (_) {}
    });
    window.addEventListener('mouseup', function () { vpan.dragging = false; });
  }

  function disposeChart() {
    clearOverlays();
    if (STATE.chart) {
      try { STATE.chart.remove(); } catch (_) {}
    }
    STATE.chart = null;
    STATE.candleSeries = null;
    STATE.volumeSeries = null;
    STATE.overlaySeries = [];
    STATE.zones = [];
    STATE.bosTrend = null;
    STATE.breakoutLine = null;   // handle died with the series; drop the stale ref
    STATE.candleMarkers = null;  // markers plugin died with the series; drop the stale ref
  }

  // ── Bar-close countdown (intraday) ─────────────────────────────────
  // TradingView-style "time until the current candle closes", pinned to the
  // last-price tag on the right price axis. Visually IDENTICAL to the swing
  // chart's chip — it reuses the same global `.tv-countdown` CSS — covering
  // every intraday TF (1m/3m/5m/15m/30m/1h/4h) plus 1d:
  //   • intraday: seconds to the next session-aligned bucket boundary,
  //     CLAMPED to 15:30 IST so the short last bar never counts past close.
  //   • 1d: time to the 15:30 IST close.
  // Shown only while the NSE session is open (no live bar = nothing to count).
  // PURE read of the wall clock + STATE — never reads the forming bar's shape
  // to decide a SIGNAL, so it cannot repaint. Mirrors swing's bucket math so
  // the chip never drifts from the bars the chart actually paints.
  var IT_IST_OFF_MS = IST_OFF_SEC * 1000;
  var IT_SESSION_OPEN_MIN = 9 * 60 + 15;   // 09:15 IST, minutes-of-day
  var IT_SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST, minutes-of-day

  // Epoch-ms of 15:30 IST on the IST calendar day containing `epochMs`.
  function _itSessionCloseMs(epochMs) {
    var ist = epochMs + IT_IST_OFF_MS;
    var istMid = Math.floor(ist / 86400000) * 86400000;
    return istMid + IT_SESSION_CLOSE_MIN * 60000 - IT_IST_OFF_MS;
  }

  // Seconds until the CURRENT chart-TF bar closes, or null when nothing
  // meaningful should be shown (market closed, no TF).
  function itBarCloseCountdownSec() {
    var tf = STATE.timeframe;
    var spec = TF[tf];
    if (!spec) return null;
    if (!isMarketOpen()) return null;       // only counts while a live bar forms
    var nowMs = Date.now();
    if (!spec.intraday) {                    // 1d — count to the session close
      return Math.max(0, Math.round((_itSessionCloseMs(nowMs) - nowMs) / 1000));
    }
    var bucketMs = spec.bucketMs;
    if (!bucketMs || bucketMs < 0) return null;
    var ist = nowMs + IT_IST_OFF_MS;
    var istMid = Math.floor(ist / 86400000) * 86400000;
    var sessionStart = istMid + IT_SESSION_OPEN_MIN * 60000;
    var alignedStart = (ist < sessionStart)
      ? sessionStart
      : sessionStart + Math.floor((ist - sessionStart) / bucketMs) * bucketMs;
    // Clamp to the session close — the final intraday bar of the day is short.
    var barCloseIst = Math.min(alignedStart + bucketMs, istMid + IT_SESSION_CLOSE_MIN * 60000);
    return Math.max(0, Math.round(((barCloseIst - IT_IST_OFF_MS) - nowMs) / 1000));
  }

  // Format remaining seconds: 'minsec' ("55m 41s") for sub-hour bars;
  // 'auto' (Hh MMm beyond an hour, else MM:SS) for 4H / 1D.
  function _itFmtCountdown(sec, mode) {
    if (sec == null) return '';
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (mode === 'minsec') return Math.floor(sec / 60) + 'm ' + String(s).padStart(2, '0') + 's';
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Lazily create the chip inside the #it-chart mount (a position:relative
  // box). Living in the mount — NOT a per-render child — keeps it alive
  // across TF switches / re-renders (disposeChart removes only the LWC chart).
  function _itEnsureCountdownEl() {
    var mount = $('it-chart');
    if (!mount) return null;
    var el = document.getElementById('it-countdown');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tv-countdown';
      el.id = 'it-countdown';
      el.style.display = 'none';
      el.title = 'Time remaining until the current candle closes';
      el.innerHTML = '<span id="it-countdown-val">--:--</span>';
      mount.appendChild(el);
    }
    return el;
  }

  // Pin the chip vertically to the forming bar's close via priceToCoordinate;
  // tint bear (red) when that bar is printing down. Falls back to the CSS 50%
  // anchor when the chart isn't ready.
  function _itPositionCountdown(el) {
    if (!el || !STATE.candleSeries || !STATE.klines.length) return;
    var last = STATE.klines[STATE.klines.length - 1];
    var px = last.close;
    if (!isFinite(px)) return;
    if (isFinite(last.open)) el.classList.toggle('tv-countdown-bear', px < last.open);
    try {
      if (typeof STATE.candleSeries.priceToCoordinate === 'function') {
        var y = STATE.candleSeries.priceToCoordinate(px);
        if (isFinite(y) && y > 0) {
          var mount = $('it-chart');
          var hostH = mount ? mount.clientHeight : 620;
          var yPos = y + 9;
          if (yPos < 2) yPos = 2;
          if (yPos > hostH - 20) yPos = hostH - 20;
          el.style.top = yPos + 'px';
        }
      }
    } catch (_) {}
  }

  function updateItCountdown() {
    var el = _itEnsureCountdownEl();
    if (!el) return;
    var val = document.getElementById('it-countdown-val');
    if (!val) return;
    if (!STATE.chart || !STATE.candleSeries) {
      el.style.display = 'none';
      el.classList.remove('tv-countdown-warn');
      return;
    }
    var sec = itBarCloseCountdownSec();
    if (sec == null) {
      el.style.display = 'none';
      el.classList.remove('tv-countdown-warn');
      return;
    }
    el.style.display = 'block';
    var tf = STATE.timeframe;
    var mode = (tf === '4h' || tf === '1d') ? 'auto' : 'minsec';
    var text = _itFmtCountdown(sec, mode);
    if (val.textContent !== text) val.textContent = text;
    // Warn pulse only in the final 10s of a true intraday bar (1d's hours-long
    // countdown would otherwise never enter — and shouldn't pulse — that window).
    el.classList.toggle('tv-countdown-warn', tf !== '1d' && sec <= 10 && sec > 0);
    _itPositionCountdown(el);
  }

  // Crosshair guard: the countdown chip is a DOM box pinned to the forming
  // bar's price on the right axis, so when you hover at (or near) that price it
  // sits ON TOP of LWC's crosshair PRICE label (which is painted on the canvas,
  // below the DOM — it can't be raised above the chip with z-index). So instead
  // we FADE the chip out while the crosshair hovers within its vertical band and
  // restore it the instant the crosshair moves away or leaves the chart. The
  // chip's top edge is set (by _itPositionCountdown) in the SAME coordinate space
  // as param.point.y, so a direct compare is valid; ~20px is the chip's height.
  function _itCrosshairCountdownGuard(param) {
    var el = document.getElementById('it-countdown');
    if (!el) return;
    var hide = false;
    if (param && param.point && isFinite(param.point.y) && el.style.display !== 'none') {
      var chipTop = parseFloat(el.style.top);
      if (isFinite(chipTop)) {
        var cy = param.point.y;
        if (cy >= chipTop - 12 && cy <= chipTop + 26) hide = true;
      }
    }
    el.classList.toggle('tv-countdown-cross-hide', hide);
  }

  // One global 1Hz ticker, started on first chart render. Resolves the chip
  // lazily via getElementById each tick, so it's a cheap no-op before the
  // chart mounts and self-heals across re-renders.
  var _itCountdownTimer = null;
  function startItCountdownTicker() {
    if (_itCountdownTimer) return;
    updateItCountdown();
    _itCountdownTimer = setInterval(updateItCountdown, 1000);
  }

  async function renderChart(tf, opts) {
    opts = opts || {};
    tf = TF[tf] ? tf : '5m';
    STATE.timeframe = tf;
    setActiveTfBtn(tf);
    syncIndToggles();
    updateBosAvailability(tf);

    var token = getToken();
    var emptyEl = $('it-empty');
    var sectionEl = $('it-chart-section');
    if (!token) {
      if (emptyEl) emptyEl.hidden = false;
      if (sectionEl) sectionEl.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (sectionEl) sectionEl.hidden = false;

    var mount = $('it-chart');
    if (!mount) return;

    var spec = TF[tf];

    // Paused (default on first visit): never fetch. Show a clean Resume prompt
    // instead of an API_PAUSED error overlay. Resuming re-runs renderChart.
    if (apiPaused()) {
      setChartOverlay('<div>Intraday is paused to protect your Upstox quota.</div>'
        + '<div style="margin-top:8px"><button type="button" class="it-chart-nav-btn" style="width:auto;padding:5px 14px" onclick="window.itToggleApiPause()">Go live</button></div>');
      setChartStatus(spec.label + ' \u2014 paused');
      try { updateLiveBadgeAndStatus(tf); } catch (_) {}
      return;
    }

    var seq = ++STATE.loadSeq;
    if (STATE.fetchAbort) { try { STATE.fetchAbort.abort(); } catch (_) {} }
    STATE.fetchAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;

    setChartOverlay('<div class="it-spinner"></div><div>Loading ' + spec.label + ' candles...</div>');
    setChartStatus(spec.label + ' - fetching from Upstox...');

    try { await loadLwcLib(); }
    catch (e) {
      setChartOverlay('<div>Chart engine could not load. Check your network and refresh.</div>');
      setChartStatus(spec.label + ' - engine failed');
      return;
    }
    if (seq !== STATE.loadSeq) return;

    var raw;
    try {
      raw = await getRawForTf(tf, STATE.fetchAbort ? STATE.fetchAbort.signal : undefined);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      var msg = (err && err.message) || 'unknown';
      if (msg === 'NO_TOKEN') {
        if (emptyEl) emptyEl.hidden = false;
        if (sectionEl) sectionEl.hidden = true;
        return;
      }
      setChartOverlay('<div>Failed to load ' + spec.label + ' candles (' + msg + '). <button type="button" class="it-chart-nav-btn" style="width:auto;padding:4px 10px" onclick="window.itChartSetTf(\'' + tf + '\')">Retry</button></div>');
      setChartStatus(spec.label + ' - ' + msg);
      return;
    }
    if (seq !== STATE.loadSeq) return;

    var klines = rawToKlines(raw, tf);
    if (klines.length < 3) {
      setChartOverlay('<div>Not enough ' + spec.label + ' candles to draw a chart.</div>');
      setChartStatus(spec.label + ' - ' + klines.length + ' candles');
      return;
    }

    STATE.raw = raw;
    STATE.klines = klines;
    STATE.lastClose = klines[klines.length - 1].close;
    // Previous session close = close of the last candle on a prior IST day.
    STATE.prevClose = computePrevClose(raw, tf);

    // Snapshot the current view for an indicator/TF-preserving render — BOTH
    // the logical (time) range AND the price-axis (vertical) range, so a legend
    // toggle never snaps the user's zoom/pan back to the default. Mirrors the
    // swing chart (which captures .timeScale + .priceScale('right')). The price
    // range is only meaningful when the user manually zoomed (wheel sets
    // setAutoScale(false)); under auto-scale getVisibleRange may be null/equal.
    var savedLogical = null, savedPrice = null;
    if (opts.preserveView && STATE.chart) {
      try { savedLogical = STATE.chart.timeScale().getVisibleLogicalRange(); } catch (_) {}
      try { savedPrice = STATE.chart.priceScale('right').getVisibleRange(); } catch (_) {}
    }

    disposeChart();
    setChartOverlay('');

    var chart;
    try { chart = LightweightCharts.createChart(mount, chartOptions(tf)); }
    catch (e) {
      setChartOverlay('<div>Chart failed to initialise.</div>');
      return;
    }
    STATE.chart = chart;
    attachPriceAxisZoom(mount);

    var candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, candleSeriesOpts());
    candleSeries.setData(klines);
    STATE.candleSeries = candleSeries;

    // Keep the bar-close countdown chip from masking the crosshair price label
    // on hover (subscription dies with the chart on TF switch / dispose).
    try { chart.subscribeCrosshairMove(_itCrosshairCountdownGuard); } catch (_) {}

    // Volume + fake-breakout radar are attached in the background AFTER the
    // chart paints — the Nifty INDEX reports vol=0, so the real volume comes
    // from a SECOND (futures) fetch we don't want blocking first paint. See
    // attachVolumeAndBreakouts(); fail-safe (no futures volume → no pane, the
    // breakout card honestly says "volume unconfirmed").
    STATE.volumeSeries = null;
    STATE.futVolMap = null;
    STATE.breakouts = null;

    drawOverlays(chart, raw, tf);

    // Markers (candlestick patterns + BOS swings) must go through ONE
    // createSeriesMarkers call, so collect both then set once. Sorted
    // ascending by time as LWC requires.
    var sortedRaw = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var allMarkers = [];
    if (STATE.indVisible.patterns) {
      allMarkers = allMarkers.concat(drawPatternMarkers(sortedRaw, tf));
    }
    if (LightweightCharts.createSeriesMarkers) {
      allMarkers.sort(function (a, b) {
        var ta = typeof a.time === 'object' ? (a.time.year * 372 + a.time.month * 31 + a.time.day) * 86400 : a.time;
        var tb = typeof b.time === 'object' ? (b.time.year * 372 + b.time.month * 31 + b.time.day) * 86400 : b.time;
        return ta - tb;
      });
      // Keep the markers-plugin handle so the bar-close refresh can update the
      // arrows in place via setMarkers (NOT a fresh createSeriesMarkers, which
      // would stack a second marker layer). Created even when empty so the
      // handle always exists for the live refresh.
      try { STATE.candleMarkers = LightweightCharts.createSeriesMarkers(candleSeries, allMarkers); } catch (_) {}
    }

    // Price-anchored overlays (DOM, glued by the shared rAF loop):
    //  • Demand/supply zone bands.
    //  • BOS/CHoCH structure — same engine + look as the swing chart.
    //  • FVG + Order-Block bands — shared swing detectors (window.detectFVG /
    //    detectOrderBlocks), identical look to the swing chart.
    STATE.zones = STATE.indVisible.zoi ? detectZones(raw) : [];
    renderZones();
    // detectStructureBreaks / detectFVG / detectOrderBlocks all expect
    // NEWEST-FIRST (they reverse internally so the forward scans run in true
    // time order). sortedRaw is oldest-first, so hand them the reversed copy;
    // the barIdx→candle mapping stays consistent.
    var newestFirst = sortedRaw.slice().reverse();
    renderBos(newestFirst, tf);
    renderFvg(newestFirst, tf);
    renderOb(newestFirst, tf);
    renderFib(newestFirst, tf);
    renderFormingZones(newestFirst, tf);
    if (STATE.zones.length || STATE.fzEls.length || STATE.bosEls.length || STATE.fvgEls.length || STATE.obEls.length || STATE.fibEls.length) startOverlayLoop();

    // Chart patterns (H&S, double top/bottom, etc.) via the shared lib.
    // We only CALL it when enabled; we never call clearCards() here because
    // that DOM/card container is shared with the swing tab.
    if (STATE.indVisible.chartpatterns && window.ChartPatterns && typeof window.ChartPatterns.onChartRender === 'function') {
      try {
        window.ChartPatterns.onChartRender({ chart: chart, series: candleSeries, inner: mount, raw: recencySlice(raw), tf: tf });
      } catch (_) {}
    }

    // Pattern cards below the chart (candlestick + geometric chart patterns) —
    // mirrors the swing analyzer. Detection is independent of the on-chart
    // overlay toggles so the cards are always available; the overlays stay
    // gated by their legend toggles above.
    renderPatternCards(raw, tf);

    // Upgrade CPR to the AUTHORITATIVE daily source in the background, then
    // redraw only if it actually changed the cache. Non-blocking so the chart
    // paint (and every other indicator) never waits on this extra fetch; the
    // card/lines already drew with the intraday-aggregation fallback. Guarded by
    // the load sequence + current TF so a stale resolve can't touch a newer
    // render. One fetch per session (cached by computedForDay), pause/429-gated.
    (function (curSeq, curTf) {
      ensureCprDaily(STATE.fetchAbort ? STATE.fetchAbort.signal : undefined).then(function (upgraded) {
        if (!upgraded) return;
        if (curSeq !== STATE.loadSeq || STATE.timeframe !== curTf || !STATE.candleSeries) return;
        try { if (STATE.indVisible.cpr && TF[curTf] && TF[curTf].intraday) drawCprLines(STATE.raw, curTf); } catch (_) {}
        try { renderCprCard(STATE.raw, curTf); } catch (_) {}
      }, function () {});
    })(seq, tf);

    // View: restore on preserve render, else show the latest ~100 bars
    // (same window as the swing chart, so bar density / scroll feel match).
    var ts = chart.timeScale();
    if (savedLogical) {
      try { ts.setVisibleLogicalRange(savedLogical); } catch (_) { ts.fitContent(); }
      // Restore the vertical (price-axis) zoom too so a toggle doesn't snap the
      // price scale back to auto-fit — matches swing. Only when the user had a
      // real manual range (from !== to); otherwise keep the new chart's auto-fit.
      if (savedPrice && isFinite(savedPrice.from) && isFinite(savedPrice.to)
          && savedPrice.from !== savedPrice.to) {
        try {
          var rps = chart.priceScale('right');
          rps.setAutoScale(false);
          rps.setVisibleRange(savedPrice);
        } catch (_) {}
      }
    } else {
      var n = klines.length, VIS = 100;
      try { ts.setVisibleLogicalRange({ from: Math.max(0, n - VIS), to: n + 3 }); } catch (_) { ts.fitContent(); }
    }

    updateLiveBadgeAndStatus(tf);

    // Bar-close countdown chip (pinned to the right price tag). Lazy 1Hz
    // ticker; first paint happens here so the chip shows immediately.
    startItCountdownTicker();

    // Volume pane + fake-breakout radar — non-blocking background patch (the
    // Nifty index has no volume; this fetches the front-month FUTURE's volume
    // and runs the non-repainting detector). Guarded by the load sequence + TF
    // so a stale resolve can't touch a newer render.
    (function (curSeq, curTf, curChart) {
      attachVolumeAndBreakouts(curChart, raw, curTf, STATE.fetchAbort ? STATE.fetchAbort.signal : undefined)
        .then(function () {
          if (curSeq !== STATE.loadSeq || STATE.timeframe !== curTf) return;
        }, function () {});
    })(seq, tf, chart);
  }

  // Fetch the front-month futures volume, draw the volume histogram pane from
  // it (clearly labelled as futures-derived), then run the fake-breakout
  // detector and render its card + chart marker + risk bullet. Fully fail-safe:
  // no futures volume → no pane, and the detector still reports the STRUCTURAL
  // read with volume marked "unconfirmed". Non-repainting (drops the live bar).
  async function attachVolumeAndBreakouts(chart, raw, tf, signal) {
    var volMap = {};
    try { volMap = await fetchFuturesVolMap(tf, signal) || {}; } catch (_) { volMap = {}; }
    // Bail if the render moved on (TF switch / reload) while we were fetching.
    if (!chart || chart !== STATE.chart || STATE.timeframe !== tf) return;
    STATE.futVolMap = volMap;
    STATE.futContract = frontMonthFuture();

    var hasVol = false;
    var volData = rawToVolumes(raw, tf).map(function (v, i) {
      var vol = volMap[raw[i] ? raw[i][0] : null];
      var value = (vol != null && isFinite(vol)) ? vol : 0;
      if (value > 0) hasVol = true;
      return { time: v.time, value: value, color: v.color };
    });

    if (hasVol) {
      try {
        var volSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
          priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false
        });
        try { volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); } catch (_) {}
        volSeries.setData(volData);
        STATE.volumeSeries = volSeries;
      } catch (_) {}
    }

    // Run the detector + render the radar card (works even without volume —
    // the structural read still stands, volume just shows "unconfirmed").
    try { renderFakeBreakout(raw, tf, volMap); } catch (_) {}
  }

  // ── Fake-breakout radar ───────────────────────────────────────────
  // Average bar range over the last `period` closed bars — a cheap, robust ATR
  // proxy used only to size the pierce/hold noise buffer (no precision needed).
  function avgBarRange(bars, period) {
    var n = bars.length;
    if (!n) return 1;
    var cnt = Math.min(period || 14, n), sum = 0, c = 0;
    for (var i = n - cnt; i < n; i++) {
      var r = (+bars[i].h) - (+bars[i].l);
      if (isFinite(r) && r >= 0) { sum += r; c++; }
    }
    return c ? Math.max(sum / c, 0.01) : 1;
  }

  // Drop later levels sitting within `tol` of an already-kept SAME-direction
  // level (e.g. on a quiet open PDH ≈ ORH — report it once).
  function dedupeLevels(levels, tol) {
    var kept = [];
    for (var i = 0; i < levels.length; i++) {
      var dup = false;
      for (var j = 0; j < kept.length; j++) {
        if (kept[j].dir === levels[i].dir && Math.abs(kept[j].price - levels[i].price) <= tol) { dup = true; break; }
      }
      if (!dup) kept.push(levels[i]);
    }
    return kept;
  }

  // Mark the primary broken level on the chart with an ISOLATED dashed price
  // line (price lines don't conflict with the pattern/BOS markers). The series
  // is recreated every render, so no cleanup is needed across renders.
  function drawBreakoutLevelLine(ev) {
    if (!STATE.candleSeries) return;
    // Remove the PREVIOUS breakout level line first. The bar-close refresh
    // re-runs renderFakeBreakout on the SAME (persistent) candle series, so
    // without this every refresh would stack another "PDH/ORH …" axis label
    // (the duplicate-label bug). Also clears a stale level when the new read
    // has no active breakout (ev null).
    if (STATE.breakoutLine) {
      try { STATE.candleSeries.removePriceLine(STATE.breakoutLine); } catch (_) {}
      STATE.breakoutLine = null;
    }
    if (!ev) return;
    var color = ev.kind === 'FAKE' ? '#ef4444' : ev.kind === 'GENUINE' ? '#22c55e' : '#eab308';
    var glyph = ev.kind === 'FAKE' ? ' \u2717' : ev.kind === 'GENUINE' ? ' \u2713' : ' ?';
    try {
      STATE.breakoutLine = STATE.candleSeries.createPriceLine({
        price: ev.level, color: color, lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: ev.id + glyph
      });
    } catch (_) {}
  }

  // Detect + render the fake-breakout radar for the current TF. Builds bars with
  // FUTURES volume, drops the live forming bar (non-repainting), assembles
  // independent reference levels (PDH/PDL + opening-range), runs the shared
  // detector, paints the card, and marks the primary level on the chart.
  function renderFakeBreakout(raw, tf, volMap) {
    var host = $('it-breakout-cards');
    var acc = document.querySelector('.it-acc[data-acc="breakout"]');
    if (!host) return;
    var spec = TF[tf];

    var bars = [];
    for (var i = 0; i < raw.length; i++) {
      var iso = raw[i][0];
      var vol = volMap ? volMap[iso] : null;
      bars.push({
        t: new Date(iso).getTime(),
        o: +raw[i][1], h: +raw[i][2], l: +raw[i][3], c: +raw[i][4],
        v: (vol != null && isFinite(vol)) ? vol : 0
      });
    }
    // NON-REPAINTING: drop the live forming bar while the market is open.
    if (bars.length && isMarketOpen()) {
      var bucketEnd = bars[bars.length - 1].t + (spec.bucketMs || 0);
      if (Date.now() < bucketEnd) bars = bars.slice(0, bars.length - 1);
    }

    var IV = window.IntradayVolume;
    if (!IV || bars.length < 6) { host.hidden = true; if (acc) acc.hidden = true; try { drawBreakoutLevelLine(null); } catch (_) {} return; }

    var atr = avgBarRange(bars, 14);

    // Reference levels — computed INDEPENDENTLY of the very recent bars (prior
    // session + opening range) so a fresh pierce is never part of its own level.
    var levels = [];
    var pdo = computePrevDayOHLC(raw);
    if (pdo) {
      levels.push({ id: 'PDH', label: 'previous-day high (PDH)', price: pdo.high, dir: 'UP' });
      levels.push({ id: 'PDL', label: 'previous-day low (PDL)', price: pdo.low, dir: 'DOWN' });
    }
    if (spec.intraday) {
      var or = IV.openingRange(bars, 15);
      if (or) {
        levels.push({ id: 'ORH', label: 'opening-range high (ORH)', price: or.high, dir: 'UP' });
        levels.push({ id: 'ORL', label: 'opening-range low (ORL)', price: or.low, dir: 'DOWN' });
      }
    }

    // Candle-formed swing levels — the most recent CONFIRMED pivot high/low the
    // candles printed (resistance to break up / support to break down). The
    // shared swingHighs/swingLows need `pivotLB` bars on BOTH sides, so the
    // newest pivot is already several bars old — it can never be its own pierce
    // (no repainting, no circularity). Listed AFTER the day levels so a swing
    // that coincides with PDH/ORH is de-duped away in favour of the named level.
    var im = IM();
    var pivotLB = (tf === '1m' || tf === '3m') ? 4 : 3;
    if (im && typeof im.swingHighs === 'function' && typeof im.swingLows === 'function') {
      try {
        var shs = im.swingHighs(raw, pivotLB);
        var sls = im.swingLows(raw, pivotLB);
        if (shs && shs.length) {
          var lastSh = shs[shs.length - 1];
          if (lastSh && isFinite(lastSh.price)) {
            levels.push({ id: 'SWH', label: 'recent swing high (candle level)', price: lastSh.price, dir: 'UP' });
          }
        }
        if (sls && sls.length) {
          var lastSl = sls[sls.length - 1];
          if (lastSl && isFinite(lastSl.price)) {
            levels.push({ id: 'SWL', label: 'recent swing low (candle level)', price: lastSl.price, dir: 'DOWN' });
          }
        }
      } catch (_) { /* fail safe — swing levels are optional */ }
    }

    levels = dedupeLevels(levels, atr * 0.5);
    if (!levels.length) { host.hidden = true; if (acc) acc.hidden = true; try { drawBreakoutLevelLine(null); } catch (_) {} return; }

    var res = IV.detectFakeBreakouts(bars, levels, {
      atr: atr, rvolLookback: 20, rvolGenuine: 1.5, rvolWeak: 1.0,
      resolveWithin: 3, lookbackBars: 10
    });
    STATE.breakouts = res;

    var haveVol = false;
    if (volMap) { for (var key in volMap) { if (volMap[key] > 0) { haveVol = true; break; } } }

    host.hidden = false;
    if (acc) acc.hidden = false;
    host.innerHTML = breakoutCardHtml(res, levels, haveVol, STATE.futContract, tf);

    drawBreakoutLevelLine(res.primary);
    try { itRenderContextBanner(); } catch (_) { /* context banner is best-effort */ }
  }

  // ── Volume + Candle context banner (below the chart) ─────────────────────
  // Two chips styled like the Live screen's gap / Bank-Nifty banners. LEFT =
  // the fake-breakout VOLUME read (futures volume / RVOL: genuine vs thin trap
  // vs exhaustion). RIGHT = the latest candlestick pattern on the chart's TF.
  // Pure CONTEXT — it mirrors the radar + on-chart markers, it does NOT drive
  // the verdict (the trade engine already factors volume + candle separately).
  // Non-repainting: the live forming bar is dropped while the market is open.
  // IST day key (YYYY-M-D) for "is this bar from today" comparisons.
  function itMacroIstKey(ms) {
    var d = new Date(ms + IST_OFF_SEC * 1000);
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }
  // Today's session OPEN from the current-TF candles (first bar dated today,
  // IST). Null on weekends / holidays / before today's first bar exists.
  function itTodayOpenPx(raw) {
    if (!raw || !raw.length) return null;
    var todayKey = itMacroIstKey(Date.now());
    for (var i = 0; i < raw.length; i++) {
      var t = new Date(raw[i][0]).getTime();
      if (itMacroIstKey(t) === todayKey) { var o = +raw[i][1]; return isFinite(o) ? o : null; }
    }
    return null;
  }
  // Overnight-gap read (matches the HUD: today open vs prev close; strong when
  // |pct| >= 0.5%). Returns null when we can't compute it.
  function itComputeGap() {
    var pc = STATE.prevClose;
    var po = itTodayOpenPx(STATE.raw);
    if (po == null || pc == null || !isFinite(pc) || pc <= 0) return null;
    var pts = po - pc, pct = (pts / pc) * 100;
    return { pts: pts, pct: pct, isStrong: (pct >= 0.5 || pct <= -0.5) };
  }
  // Refresh the macro context (Bank-Nifty bias) and repaint the banner.
  // Bank-Nifty is fetched via the HUD's exposed getter (no duplicate logic),
  // throttled to ~60s and gated by the API-pause switch. Fire-and-forget.
  function itRefreshMacroContext() {
    try {
      if (typeof apiPaused === 'function' && apiPaused()) return;
      var now = Date.now();
      if (STATE.macro.bn && (now - STATE.macro.bnAt) < 60000) return;   // fresh enough
      if (typeof window === 'undefined' || typeof window.iaGetBankNiftyBias !== 'function') return;
      STATE.macro.bnAt = now;
      Promise.resolve(window.iaGetBankNiftyBias()).then(function (bn) {
        if (bn) { STATE.macro.bn = bn; try { itRenderContextBanner(); } catch (_) {} }
      }).catch(function () {});
    } catch (_) { /* macro context is best-effort */ }
  }

  function itRenderContextBanner() {
    var strip = $('it-ctx-banner');
    if (!strip) return;
    if (typeof getToken === 'function' && !getToken()) { strip.hidden = true; strip.innerHTML = ''; return; }
    var chips = [];
    // GAP chip — overnight gap context (only on a strong gap, like the HUD).
    var gap = itComputeGap();
    if (gap && gap.isStrong) {
      var gapDir = gap.pct > 0 ? 'UP' : 'DOWN';
      var gapTitle = 'GAP-' + gapDir + ' \u00b7 ' + (gap.pct > 0 ? '+' : '') + gap.pct.toFixed(2) + '% \u00b7 ' + Math.round(Math.abs(gap.pts)) + ' PTS';
      chips.push({ sev: 'info', icon: gap.pct > 0 ? '\u25B2' : '\u25BC', title: gapTitle,
        detail: 'Look for an ORH break (gap-and-go) or an open rejection (gap-fade) to pick a side.' });
    }
    // BANK NIFTY chip — macro lead/confirm bias (Bank Nifty leads Nifty ~60%).
    var bn = STATE.macro.bn;
    if (bn && bn.trend) {
      var bnShort = bn.trend === 'STRONG_BULL' ? '\u25B2 STRONG UP'
                  : bn.trend === 'BULL'        ? '\u25B3 UP'
                  : bn.trend === 'STRONG_BEAR' ? '\u25BC STRONG DOWN'
                  : bn.trend === 'BEAR'        ? '\u25BD DOWN'
                  : '\u2014 FLAT';
      var bnChg = (bn.changePct != null && isFinite(bn.changePct)) ? ((bn.changePct >= 0 ? '+' : '') + bn.changePct.toFixed(2) + '%') : null;
      var bnSev = bn.net === 'BULL' ? 'bull' : (bn.net === 'BEAR' ? 'bear' : 'info');
      var bnDetail = bn.net === 'BULL' ? 'Macro Bank-Nifty bias UP \u2014 supports CALL setups.'
                   : bn.net === 'BEAR' ? 'Macro Bank-Nifty bias DOWN \u2014 supports PUT setups.'
                   : 'Bank Nifty flat \u2014 no directional lead yet.';
      chips.push({ sev: bnSev, icon: '\u25CF', title: 'BANK NIFTY \u00b7 ' + bnShort + (bnChg ? ' \u00b7 ' + bnChg : ''), detail: bnDetail });
    }
    // VOLUME chip — the headline fake-breakout event (already volume-judged).
    var bo = STATE.breakouts;
    var prim = bo && bo.primary ? bo.primary : null;
    if (prim) {
      var rvolTxt = (prim.rvol != null) ? prim.rvol.toFixed(2) + '\u00d7 avg' : null;
      var vSev = 'info', vTitle, vDetail = prim.note || '';
      if (prim.kind === 'FAKE') { vSev = 'danger'; vTitle = 'VOLUME \u00b7 FAKE BREAK' + (rvolTxt ? ' \u00b7 ' + rvolTxt : ''); }
      else if (prim.volState === 'CONFIRM') { vSev = 'bull'; vTitle = 'VOLUME \u00b7 CONFIRMED' + (rvolTxt ? ' \u00b7 ' + rvolTxt : ''); }
      else if (prim.volState === 'EXHAUST') { vSev = 'danger'; vTitle = 'VOLUME \u00b7 EXHAUSTION' + (rvolTxt ? ' \u00b7 ' + rvolTxt : ''); }
      else if (prim.volState === 'WEAK') { vSev = 'warn'; vTitle = 'VOLUME \u00b7 THIN' + (rvolTxt ? ' \u00b7 ' + rvolTxt : ''); }
      else { vSev = 'warn'; vTitle = 'VOLUME \u00b7 UNCONFIRMED'; if (!vDetail) vDetail = 'No futures volume to verify this break right now \u2014 treat with caution.'; }
      chips.push({ sev: vSev, icon: '\u25CF', title: vTitle, detail: vDetail });
    } else {
      chips.push({ sev: 'info', icon: '\u25CF', title: 'VOLUME \u00b7 NO ACTIVE BREAK',
        detail: 'No breakout of a key level on the chart right now \u2014 nothing to confirm or fade yet.' });
    }
    // CANDLE chip — latest pattern on the chart's TF (confirmed bar only).
    var raw = STATE.raw;
    var cChip = null;
    if (raw && raw.length >= 3) {
      var bars = raw.slice();
      if (typeof window !== 'undefined' && typeof window.isMarketOpen === 'function' && window.isMarketOpen()) bars = bars.slice(0, -1);
      var detect = IM().detectPatterns || (typeof window !== 'undefined' ? window.detectPatterns : null);
      if (typeof detect === 'function' && bars.length >= 3) {
        var c0 = +bars[Math.max(0, bars.length - 7)][4], c1 = +bars[bars.length - 1][4];
        var tg = c1 > c0 ? 'BULL' : (c1 < c0 ? 'BEAR' : 'NEUTRAL');
        var tfLbl = STATE.timeframe || 'current';
        var pr; try { pr = detect(bars, tg); } catch (_) { pr = null; }
        // Only surface TIER-1 reversals — the SAME set the chart arrows + the
        // candlestick cards mark (TIER1_BULL / TIER1_BEAR). Showing a non-Tier-1
        // pattern (e.g. a Tweezer Bottom) here while the chart deliberately marks
        // nothing was confusing — the banner now matches the chart exactly.
        // compression / neutral are intentionally dropped for the same reason
        // (they are never drawn on the chart, so announcing them looked broken).
        if (pr) {
          if (pr.bull && TIER1_BULL[pr.bull]) cChip = { sev: 'bull', icon: '\u25B2', title: 'CANDLE \u00b7 ' + String(pr.bull).toUpperCase(), detail: 'A bullish ' + pr.bull + ' just closed on the ' + tfLbl + ' chart \u2014 buyers stepping in.' };
          else if (pr.bear && TIER1_BEAR[pr.bear]) cChip = { sev: 'bear', icon: '\u25BC', title: 'CANDLE \u00b7 ' + String(pr.bear).toUpperCase(), detail: 'A bearish ' + pr.bear + ' just closed on the ' + tfLbl + ' chart \u2014 sellers stepping in.' };
        }
      }
    }
    // Only show the candle chip when there's an actual pattern — no "NONE"
    // filler (it's noise; absence of a pattern is the common, uninteresting case).
    if (cChip) chips.push(cChip);

    if (!chips.length) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    var safe = function (s) {
      return String(s).replace(/[<>&"']/g, function (ch) {
        return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[ch];
      });
    };
    strip.innerHTML = chips.map(function (c) {
      return '<div class="ia-event-chip" data-sev="' + safe(c.sev) + '">'
        + '<span class="ia-event-chip-icon">' + safe(c.icon) + '</span>'
        + '<div class="ia-event-chip-body">'
        +   '<span class="ia-event-chip-title">' + safe(c.title) + '</span>'
        +   '<span class="ia-event-chip-detail">' + safe(c.detail) + '</span>'
        + '</div></div>';
    }).join('');
  }

  // IST clock for a breakout candle. Intraday → the bar's time window
  // (open–close, e.g. "11:30\u201311:35"), with the date appended when the bar
  // isn't from today. Daily → the date. `bucketMs` derives the close edge.
  function fmtCandleWhen(openMs, bucketMs, intraday) {
    if (!isFinite(openMs)) return '';
    var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function hm(ms) {
      var d = new Date(ms + IST_OFF_SEC * 1000);
      return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    }
    var o = new Date(openMs + IST_OFF_SEC * 1000);
    var datePart = o.getUTCDate() + ' ' + MON[o.getUTCMonth()];
    if (!intraday) return datePart;
    var now = new Date(Date.now() + IST_OFF_SEC * 1000);
    var sameDay = now.getUTCFullYear() === o.getUTCFullYear() && now.getUTCMonth() === o.getUTCMonth() && now.getUTCDate() === o.getUTCDate();
    var range = hm(openMs) + '\u2013' + hm(openMs + (bucketMs || 0));
    return range + (sameDay ? '' : (' \u00b7 ' + datePart));
  }

  function breakoutCardHtml(res, levels, haveVol, fut, tf) {
    var spec = TF[tf] || {};
    var tfLabel = spec.label || tf;
    var bucketMs = spec.bucketMs || 0;
    var intraday = !!spec.intraday;
    function whenTxt(ev) {
      var w = fmtCandleWhen(ev.pierceT, bucketMs, intraday);
      var ago = ev.barsAgo === 0 ? 'this bar' : (ev.barsAgo + ' bar' + (ev.barsAgo === 1 ? '' : 's') + ' ago');
      return w ? (w + ' \u00b7 ' + ago) : ago;
    }
    var prim = res.primary;
    var volSrc = haveVol
      ? ('Volume source: ' + ((fut && fut.trading_symbol) ? fut.trading_symbol : 'Nifty futures') + ' \u2014 the Nifty index itself reports no volume, so we read the front-month future (what traders use as Nifty volume).')
      : 'Volume is unavailable right now (go Live + a valid token, or wait for the futures feed) \u2014 showing the structural read only.';

    // Plain-English intro so the card explains itself.
    var intro = '<div class="it-bo-intro">Watches your key levels on the <b>' + escAttr(tfLabel)
      + '</b> chart and tells you if a breakout is <b>real</b> or a <b>trap</b> \u2014 judged only on candles that have <b>already closed</b> (never the live one).</div>';

    var head;
    if (!prim) {
      head = '<div class="it-bo-head it-bo-clear">'
        + '<span class="it-bo-badge it-bo-badge-clear">NO BREAKOUT</span>'
        + '<div class="it-bo-head-txt"><span class="it-bo-headline">Price is sitting inside its range \u2014 no key level has been pierced in the last few bars. Nothing to fade or chase yet.</span></div>'
        + '</div>';
    } else {
      var cls = prim.kind === 'FAKE' ? 'fake' : prim.kind === 'GENUINE' ? 'genuine' : 'pending';
      var badgeTxt = prim.kind === 'FAKE' ? 'FAKE BREAKOUT' : prim.kind === 'GENUINE' ? 'GENUINE BREAKOUT' : 'BREAKOUT FORMING';
      // Time-specific: which candle, on which timeframe, broke the level.
      var verb = prim.kind === 'FAKE' ? 'Trap candle' : prim.kind === 'GENUINE' ? 'Breakout candle' : 'Test candle';
      var when = '<div class="it-bo-when"><b>' + escAttr(verb) + ':</b> the ' + escAttr(tfLabel)
        + ' candle at <b>' + escAttr(whenTxt(prim)) + '</b>, ' + escAttr(prim.dir === 'UP' ? 'above ' : 'below ') + escAttr(prim.label) + ' (' + fmtPrice(prim.level) + ').</div>';
      head = '<div class="it-bo-head it-bo-' + cls + '">'
        + '<span class="it-bo-badge it-bo-badge-' + cls + '">' + badgeTxt + '</span>'
        + '<div class="it-bo-head-txt"><span class="it-bo-headline">' + escAttr(prim.note) + '</span>' + when + '</div>'
        + '</div>';
    }

    var meter = '';
    if (prim) {
      if (prim.rvol == null) {
        meter = '<div class="it-bo-rvol it-bo-rvol-na">Relative volume: <b>unconfirmed</b> \u2014 no futures volume to verify participation on this break.</div>';
      } else {
        var pct = Math.max(4, Math.min(100, (prim.rvol / 3) * 100)); // 3x avg = full bar
        var vc = prim.rvol >= 1.5 ? 'hi' : prim.rvol >= 1.0 ? 'mid' : 'lo';
        meter = '<div class="it-bo-rvol">'
          + '<div class="it-bo-rvol-row"><span>Relative volume on the breakout bar</span><b class="it-bo-rvol-' + vc + '">' + prim.rvol.toFixed(2) + '\u00d7 avg</b></div>'
          + '<div class="it-bo-rvol-track"><div class="it-bo-rvol-fill it-bo-rvol-fill-' + vc + '" style="width:' + pct.toFixed(0) + '%"></div>'
          + '<span class="it-bo-rvol-tick" style="left:33.3%" title="1.0x average"></span>'
          + '<span class="it-bo-rvol-tick it-bo-rvol-tick-strong" style="left:50%" title="1.5x = strong"></span></div>'
          + '<div class="it-bo-rvol-cap">Under <b>1.0\u00d7</b> = thin participation (trap risk). <b>1.5\u00d7+</b> = real conviction behind the move.</div>'
          + '</div>';
      }
    }

    var chips = '';
    var seen = {};
    for (var i = 0; i < res.events.length; i++) {
      var e = res.events[i];
      seen[e.id] = 1;
      var ec = e.kind === 'FAKE' ? 'fake' : e.kind === 'GENUINE' ? 'genuine' : 'pending';
      var tag = e.kind === 'FAKE' ? 'trap' : e.kind === 'GENUINE' ? 'held' : 'testing';
      chips += '<div class="it-bo-chip it-bo-chip-' + ec + '">'
        + '<span class="it-bo-chip-lvl">' + escAttr(e.label) + '</span>'
        + '<span class="it-bo-chip-px">' + fmtPrice(e.level) + '</span>'
        + '<span class="it-bo-chip-tag">' + tag + (e.rvol != null ? (' \u00b7 ' + e.rvol.toFixed(2) + '\u00d7') : '') + '</span>'
        + '<span class="it-bo-chip-time">' + escAttr(whenTxt(e)) + '</span>'
        + '</div>';
    }
    for (var j = 0; j < levels.length; j++) {
      if (seen[levels[j].id]) continue;
      chips += '<div class="it-bo-chip it-bo-chip-watch">'
        + '<span class="it-bo-chip-lvl">' + escAttr(levels[j].label) + '</span>'
        + '<span class="it-bo-chip-px">' + fmtPrice(levels[j].price) + '</span>'
        + '<span class="it-bo-chip-tag">watching</span>'
        + '</div>';
    }

    return intro + head + meter
      + (chips ? '<div class="it-bo-chips">' + chips + '</div>' : '')
      + '<div class="it-bo-src">' + escAttr(volSrc) + '</div>';
  }

  // Close of the last candle whose IST day differs from the newest bar.
  function computePrevClose(raw, tf) {
    if (!raw || raw.length < 2) return null;
    function dayKey(ts) {
      var ist = new Date(new Date(ts).getTime() + IST_OFF_SEC * 1000);
      return ist.getUTCFullYear() + '-' + ist.getUTCMonth() + '-' + ist.getUTCDate();
    }
    var lastDay = dayKey(raw[raw.length - 1][0]);
    for (var i = raw.length - 2; i >= 0; i--) {
      if (dayKey(raw[i][0]) !== lastDay) return +raw[i][4];
    }
    return null;
  }

  // Previous-session OHLC from intraday candles. "Previous day" = the most
  // recent COMPLETED trading session strictly BEFORE today's IST date — NOT the
  // day before the last bar. This is the key fix: when the market is closed
  // (e.g. Saturday), the last bar is Friday's session, and traders want FRIDAY's
  // levels as "previous day" for the next session — not Thursday's. Anchoring on
  // the live IST date (instead of the last bar) gets this right in every case:
  //   • market open today  → today's bars exist → prev day = the day before today
  //   • market closed (wknd/holiday/after-hours) → prev day = last completed session
  // Aggregates that session: open = first bar's open, high = max, low = min,
  // close = last bar's close. `candles` must be ascending (oldest-first).
  // Numeric YYYYMMDD keys so date comparison is correct (no string-order bugs).
  // Fails safe: returns null if no completed prior session is present.
  function computePrevDayOHLC(candles) {
    if (!candles || candles.length < 1) return null;
    function dayNum(ts) {
      var ist = new Date(new Date(ts).getTime() + IST_OFF_SEC * 1000);
      return ist.getUTCFullYear() * 10000 + (ist.getUTCMonth() + 1) * 100 + ist.getUTCDate();
    }
    var nowIst = new Date(Date.now() + IST_OFF_SEC * 1000);
    var todayNum = nowIst.getUTCFullYear() * 10000 + (nowIst.getUTCMonth() + 1) * 100 + nowIst.getUTCDate();

    // Most recent session day strictly before today.
    var prevDay = -1;
    for (var i = candles.length - 1; i >= 0; i--) {
      var d = dayNum(candles[i][0]);
      if (d < todayNum && d > prevDay) prevDay = d;
    }
    if (prevDay < 0) return null;

    var o = null, h = -Infinity, l = Infinity, c = null;
    for (var j = 0; j < candles.length; j++) {
      if (dayNum(candles[j][0]) !== prevDay) continue;
      if (o == null) o = +candles[j][1];
      var hi = +candles[j][2], lo = +candles[j][3];
      if (hi > h) h = hi;
      if (lo < l) l = lo;
      c = +candles[j][4];
    }
    if (o == null || !isFinite(h) || !isFinite(l) || c == null) return null;
    // dayNum (numeric YYYYMMDD of that prior session) lets CPR cache + flag a
    // stale level set when the most recent session is many days behind today.
    return { open: o, high: h, low: l, close: c, dayNum: prevDay };
  }

  // ═══════════════════════════════════════════════════════════════
  // CPR (Central Pivot Range) — daily pivot framework for intraday.
  // ═══════════════════════════════════════════════════════════════
  // DISPLAY ONLY (this chart emits no buy/sell signal). The maths live in the
  // shared pure lib (IndicatorMath.computeCPR) so the Intraday tab and the
  // Options-Trading engine can never disagree on a level. Robustness model:
  //   • Source the prev-session OHLC from the AUTHORITATIVE daily (1d) candle
  //     when available (ensureCprDaily fetches it once per session, gated by the
  //     API pause + 429 throttle); fall back to aggregating the loaded intraday
  //     session so the card/lines never block on the network and never vanish.
  //   • NON-REPAINTING: levels come only from sessions strictly BEFORE today's
  //     IST date, so the whole set is frozen for the day.
  //   • FAIL-SAFE: any missing / degenerate prev session → no CPR (we suppress
  //     rather than draw a guessed level); a far-behind session is flagged STALE.
  function istTodayNum() {
    var n = new Date(Date.now() + IST_OFF_SEC * 1000);
    return n.getUTCFullYear() * 10000 + (n.getUTCMonth() + 1) * 100 + n.getUTCDate();
  }
  function ymdToDate(num) {
    return new Date(Date.UTC(Math.floor(num / 10000), Math.floor((num % 10000) / 100) - 1, num % 100));
  }
  // > 5 calendar days between the prior session and today → likely a data gap /
  // long outage, not a normal weekend or holiday bridge → flag the CPR as stale.
  function cprStaleByDays(todayNum, prevNum) {
    if (prevNum == null || todayNum == null) return false;
    var diff = (ymdToDate(todayNum).getTime() - ymdToDate(prevNum).getTime()) / 86400000;
    return diff > 5;
  }

  // Best-available previous-session OHLC for CPR, with provenance + staleness.
  // Prefers the cached authoritative daily candle; falls back to the loaded
  // intraday session. `raw` must be ascending (oldest-first). Returns null when
  // no completed prior session exists (→ caller suppresses CPR).
  function cprPrevOHLC(raw) {
    var todayNum = istTodayNum();
    var d = STATE.cprDaily;
    if (d && d.ohlc && d.computedForDay === todayNum && d.source === 'daily') {
      return { open: d.ohlc.open, high: d.ohlc.high, low: d.ohlc.low, close: d.ohlc.close,
        source: 'daily', prevDayNum: d.prevDayNum, stale: d.stale };
    }
    var pdo = computePrevDayOHLC(raw);
    if (!pdo) return null;
    return { open: pdo.open, high: pdo.high, low: pdo.low, close: pdo.close,
      source: 'intraday', prevDayNum: pdo.dayNum,
      stale: cprStaleByDays(todayNum, pdo.dayNum) };
  }

  // Single source of truth for both the chart lines and the card — so they can
  // never show different levels. Returns { levels, ohlc, source, stale } | null.
  function buildCpr(raw) {
    var src = cprPrevOHLC(raw);
    if (!src) return null;
    var levels = IM().computeCPR ? IM().computeCPR(src.high, src.low, src.close) : null;
    if (!levels) return null;
    return { levels: levels, ohlc: src, source: src.source, stale: src.stale, prevDayNum: src.prevDayNum };
  }

  // Fetch the authoritative daily series ONCE per session and cache the derived
  // prev-session OHLC. Honours the master API pause + the shared 429 gate (via
  // getRawForTf → fetchHistorical). Returns true only when it freshly upgraded
  // the cache to a daily source (so the caller knows a redraw is worthwhile).
  async function ensureCprDaily(signal) {
    if (apiPaused()) return false;
    var todayNum = istTodayNum();
    var d = STATE.cprDaily;
    if (d && d.ohlc && d.computedForDay === todayNum && d.source === 'daily') return false;
    var daily;
    try { daily = await getRawForTf('1d', signal); }
    catch (_) { return false; }
    if (!daily || !daily.length) return false;
    var pdo = computePrevDayOHLC(daily);
    if (!pdo || !(pdo.high > pdo.low)) return false;   // completeness guard
    STATE.cprDaily = {
      ohlc: { open: pdo.open, high: pdo.high, low: pdo.low, close: pdo.close },
      prevDayNum: pdo.dayNum, computedForDay: todayNum, source: 'daily',
      stale: cprStaleByDays(todayNum, pdo.dayNum)
    };
    return true;
  }

  // Draw the CPR overlay on the candle series: Pivot (solid gold), TC/BC (dashed
  // amber = the central range), R1 / S1 (large-dashed). Removes any prior CPR
  // lines first so a background source-upgrade redraw never stacks duplicates.
  // `raw` ascending. Fails safe per-line on non-finite prices.
  function drawCprLines(raw, tf) {
    if (!STATE.candleSeries) return;
    if (STATE.cprLines && STATE.cprLines.length) {
      for (var r = 0; r < STATE.cprLines.length; r++) {
        try { STATE.candleSeries.removePriceLine(STATE.cprLines[r]); } catch (_) {}
      }
    }
    STATE.cprLines = [];
    var cpr = buildCpr(raw);
    if (!cpr) return;
    var L = cpr.levels;
    // lineStyle: 0 solid · 2 dashed · 3 large-dashed (LightweightCharts).
    var lines = [
      { price: L.R1, color: '#ef4444', label: 'R1',    style: 3 },
      { price: L.TC, color: '#f59e0b', label: 'TC',    style: 2 },
      { price: L.P,  color: '#facc15', label: 'Pivot', style: 0 },
      { price: L.BC, color: '#f59e0b', label: 'BC',    style: 2 },
      { price: L.S1, color: '#22c55e', label: 'S1',    style: 3 }
    ];
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (!isFinite(ln.price)) continue;
      try {
        var h = STATE.candleSeries.createPriceLine({
          price: ln.price, color: ln.color, lineWidth: 1, lineStyle: ln.style,
          axisLabelVisible: true, title: ln.label
        });
        STATE.cprLines.push(h);
      } catch (_) {}
    }
  }

  function updateLiveBadgeAndStatus(tf) {
    var spec = TF[tf];
    var open = isMarketOpen();
    setLiveBadge(open ? 'live' : 'closed', open ? 'LIVE' : 'CLOSED');

    // BOS structure regime is shown as a prominent pill in the chart toolbar
    // (next to the symbol) so it's visible at a glance, not buried in the
    // bottom status line. Uses the same .sw-trend-badge classes as swing.
    var trendEl = $('it-chart-trend');
    if (trendEl) {
      if (STATE.indVisible.bos && bosAllowed(tf) && STATE.bosTrend) {
        var cls = STATE.bosTrend === 'BULLISH' ? 'sw-trend--bull'
          : (STATE.bosTrend === 'BEARISH' ? 'sw-trend--bear' : 'sw-trend--range');
        var arrow = STATE.bosTrend === 'BULLISH' ? '\u25B2'
          : (STATE.bosTrend === 'BEARISH' ? '\u25BC' : '\u25C6');
        trendEl.innerHTML = '<span class="sw-trend-badge ' + cls + '">' + arrow + ' ' + STATE.bosTrend + '</span>';
        trendEl.hidden = false;
      } else {
        trendEl.innerHTML = '';
        trendEl.hidden = true;
      }
    }

    // Status line mirrors the swing chart's format exactly:
    //   open   → "30 Minute · 533 candles · ₹23,400"
    //   closed → "4 Hour · market closed · last ₹1,058"
    if (open) {
      setChartStatus(spec.label + ' \u00b7 ' + STATE.klines.length + ' candles \u00b7 ' + fmtPrice(STATE.lastClose));
    } else {
      setChartStatus(spec.label + ' \u00b7 market closed \u00b7 last ' + fmtPrice(STATE.lastClose));
    }
  }

  // Whole-rupee price formatter — identical to the swing chart's fmtPrice
  // (display rounding only; never used in calculations, per the tick-size rule).
  function fmtPrice(n) {
    if (!isFinite(n)) return '\u2014';
    return '\u20B9' + Math.round(n).toLocaleString('en-IN');
  }

  // ===================================================================
  // PATTERN CARDS (below the chart) — candlestick + geometric chart patterns
  // ===================================================================
  // Mirrors the swing analyzer's two card decks (scripts/swing-analyzer.js
  // collectTier1Patterns + scripts/chart-patterns.js paintCards) so the
  // Intraday tab reads identically. DISPLAY ONLY — these cards never feed a
  // verdict or place a trade; they label what's already on the chart and how
  // each formation played out, for back-testing the timeframe by eye.
  //
  // Differences vs swing (intentional, noted so they don't read as bugs):
  //   • Cards follow the CURRENT CHART TF (intraday has no separate
  //     "recommendation TF" control), so the sub-line drops the "(reco TF)"
  //     wording and tapping a card just re-centres the chart on that bar
  //     (same TF ⇒ bar indices line up — no cross-TF switch needed).
  //   • The candlestick deck is gated by the Patterns legend toggle (matches
  //     the on-chart arrows). The chart-pattern deck renders independently of
  //     the Chart-Patterns OVERLAY toggle (which defaults OFF) so the cards are
  //     visible by default; the overlay toggle only controls the on-chart
  //     skeleton drawing.
  //   • Each deck's "Show history" reveals the resolved (WORKED/FAILED) audit
  //     trail in the CARDS only (intraday-local localStorage keys); it does not
  //     re-flag the shared chart-pattern overlay.
  var PATTERN_CARD_MAX = 4;   // most-recent + 3 prior (default candlestick view)

  // Tier-1 candlestick reversals we surface (same set as the chart arrows).
  // Shared with drawPatternMarkers' TIER1_BULL / TIER1_BEAR maps above.
  var PATTERN_DEFN = {
    'Bullish Engulfing':   'A green body that fully engulfs the prior red body \u2014 buyers overwhelm sellers.',
    'Bearish Engulfing':   'A red body that fully engulfs the prior green body \u2014 sellers overwhelm buyers.',
    'Morning Star':        'Three-bar bottom: a big red bar, a small indecision bar, then a big green bar closing past the first bar\u2019s midpoint.',
    'Morning Doji Star':   'A Morning Star whose middle bar is a true doji \u2014 a stronger bottom reversal.',
    'Evening Star':        'Three-bar top: a big green bar, a small indecision bar, then a big red bar closing past the first bar\u2019s midpoint.',
    'Evening Doji Star':   'An Evening Star whose middle bar is a true doji \u2014 a stronger top reversal.',
    'Hammer':              'Long lower wick with a small body at the top \u2014 sellers were rejected; a bullish reversal at support.',
    'Shooting Star':       'Long upper wick with a small body at the bottom \u2014 buyers were rejected; a bearish reversal at resistance.',
    'Three White Soldiers':'Three strong rising green bars \u2014 sustained bullish momentum.',
    'Three Black Crows':   'Three strong falling red bars \u2014 sustained bearish momentum.',
    'Piercing Pattern':    'A green bar that opens below the prior red close and closes past its midpoint \u2014 a near-engulfing bullish reversal.',
    'Dark Cloud Cover':    'A red bar that opens above the prior green close and closes below its midpoint \u2014 a near-engulfing bearish reversal.',
    'Dragonfly Doji':      'A doji with a long lower wick and almost no upper wick \u2014 a \u201Cpure\u201D hammer; a bullish rejection of the lows.',
    'Gravestone Doji':     'A doji with a long upper wick and almost no lower wick \u2014 a \u201Cpure\u201D shooting star; a bearish rejection of the highs.'
  };

  // Outcome badge — LIVE = in play, ✓ WORKED = 2R target hit first,
  // ✗ FAILED = formation stop closed through first. Resolved rows are KEPT
  // (never dropped) so the hit-rate can be validated by eye.
  var PATTERN_OUTCOME_BADGE = {
    LIVE:   { label: 'LIVE',          cls: 'live',
      tip: 'Still in play \u2014 neither the 2R target nor the formation stop has been closed through yet.' },
    WORKED: { label: '\u2713 WORKED', cls: 'worked',
      tip: 'Worked \u2014 price reached the 2R target before breaking the formation stop.' },
    FAILED: { label: '\u2717 FAILED', cls: 'failed',
      tip: 'Failed \u2014 price closed through the formation stop before reaching target (reversal rejected).' }
  };

  var _PAT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function patternDateLabel(ts, tf) {
    var ms = new Date(ts).getTime();
    if (!isFinite(ms)) return '';
    var ist = new Date(ms + IST_OFF_SEC * 1000);
    var base = ist.getUTCDate() + ' ' + _PAT_MONTHS[ist.getUTCMonth()] + ' ' + ist.getUTCFullYear();
    if (!TF[tf] || !TF[tf].intraday) return base;
    var hh = ('0' + ist.getUTCHours()).slice(-2);
    var mm = ('0' + ist.getUTCMinutes()).slice(-2);
    return base + ' ' + hh + ':' + mm;
  }
  // "from → to" span label for a chart-pattern card.
  function patternRangeLabel(startTs, endTs, tf) {
    var a = patternDateLabel(startTs, tf), b = patternDateLabel(endTs, tf);
    return (a && b && a !== b) ? (a + ' \u2192 ' + b) : (b || a);
  }

  // Location label + class + plain-English note for a candlestick card row.
  function candleLoc(row) {
    var k = row.kind;
    if (k === 'DEMAND') return {
      label: 'At demand zone', cls: 'it-loc-strong-bull',
      note: 'Bullish reversal sitting on a demand zone (support) \u2014 the strongest long context; watch for follow-through.'
    };
    if (k === 'SUPPLY') return {
      label: 'At supply zone', cls: 'it-loc-strong-bear',
      note: 'Bearish reversal sitting on a supply zone (resistance) \u2014 a strong short / exit context.'
    };
    if (k === 'POCKET') return {
      label: 'In Fib golden pocket', cls: 'it-loc-strong-bull',
      note: 'Bullish reversal in the 61.8\u201380% golden pocket (the discount long band) on a valid pullback \u2014 watch for follow-through.'
    };
    if (k === 'POCKET_FALLING') return {
      label: 'Golden pocket \u2014 falling', cls: 'it-loc-warn',
      note: '\u26A0 In the golden pocket but price is still falling THROUGH it \u2014 NOT a confirmed long. Wait for an actual reversal.'
    };
    return row.dir === 'bull'
      ? { label: 'Open space', cls: 'it-loc-none',
          note: 'Bullish reversal with no support level nearby \u2014 weaker on its own; needs other confluence.' }
      : { label: 'Open space', cls: 'it-loc-none',
          note: 'Bearish reversal with no resistance level nearby \u2014 weaker on its own; needs other confluence.' };
  }

  // Detect the Tier-1 candlestick patterns for a TF and return structured rows
  // — a faithful port of swing's collectTier1Patterns, but reading the INTRADAY
  // detectZones (which returns { type, top, bottom }) and the shared Fib zone
  // (window._swCP.computeFibZone, newest-first). PURE: never mutates anything.
  //   • Location (DEMAND / SUPPLY / POCKET / NONE) → the ★ confluence emphasis.
  //   • Outcome (LIVE / WORKED / FAILED) → 2R-target vs formation-stop, judged
  //     CLOSE-based on CONFIRMED bars after the signal (no repaint).
  function collectIntradayPatterns(raw, tf) {
    if (!raw || raw.length < 3) return [];
    var math = IM();
    var detectPatterns = math.detectPatterns || window.detectPatterns || null;
    if (typeof detectPatterns !== 'function') return [];
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var n = sorted.length;
    var closes = sorted.map(function (c) { return +c[4]; });

    // No-repaint guard: skip the still-forming bar while the market is open.
    var marketOpen = isMarketOpen();
    var lastIdx = marketOpen ? n - 2 : n - 1;
    if (lastIdx < 1) return [];

    // Local up-swing INTO the signal bar splits Hammer/Hanging-Man &
    // Inverted-Hammer/Shooting-Star (same shapes, opposite context). Only a
    // clear up-move counts as 'BULL'; flat/down stays 'NEUTRAL'.
    //
    // The required rise is TIMEFRAME-AWARE. The old single 0.5% bar was borrowed
    // from the higher timeframes and was far too big for 1m/3m — a normal
    // intraday run-up never reaches 0.5% on a 1-minute chart, so the "was there
    // an up-move?" test always said no and Shooting Star / Hanging Man were
    // effectively switched off on the fast charts (the rejection candle got
    // mis-filed as a bullish Inverted Hammer / Hammer and dropped). Price moves
    // scale ~sqrt(time), so we anchor 0.5% at 15m and scale DOWN for faster TFs:
    //   1m → 0.12%, 3m → 0.20%, 5m → 0.30%, 15m/30m/1h/1d → 0.50% (unchanged).
    // The MEANING is identical ("a real up-move into the candle"); it's just
    // measured proportionally to each timeframe. Higher-TF behaviour is byte-for-
    // byte unchanged (still 0.5%), so no slower-timeframe verdict shifts.
    var SWING_MIN_BY_TF = { '1m': 0.0012, '3m': 0.0020, '5m': 0.0030 };
    var SWING_LB = 5, SWING_MIN = SWING_MIN_BY_TF[tf] || 0.005;
    function trendInto(idx) {
      var pj = idx - 1;
      if (pj < 1) return 'NEUTRAL';
      var base = closes[Math.max(0, pj - SWING_LB)];
      if (!(base > 0)) return 'NEUTRAL';
      return (closes[pj] - base) / base >= SWING_MIN ? 'BULL' : 'NEUTRAL';
    }

    // Confluence levels — reuse the SAME overlays the chart draws so the card
    // emphasis matches what the user sees. detectZones sorts internally;
    // computeFibZone expects NEWEST-FIRST (the swing bridge).
    var zones = (typeof detectZones === 'function') ? (detectZones(raw) || []) : [];
    var fz = null;
    try { fz = computeIntradayFib(sorted.slice().reverse(), tf); } catch (_) { fz = null; }
    // Active pullback band edges (intraday = shallow 38.2–61.8%; else 61.8–80%).
    var gpLo = (fz && isFinite(fz.pocketLoPx)) ? fz.pocketLoPx : null;  // lower price (deep edge)
    var gpHi = (fz && isFinite(fz.pocketHiPx)) ? fz.pocketHiPx : null;  // higher price (shallow edge)
    var fzFalling = !!fz && (fz.fibDirection === 'FALLING' || fz.bounceStatus === 'FALLING');

    function levelInfo(idx, dir) {
      var lo = +sorted[idx][3], hi = +sorted[idx][2];
      if (!(hi >= lo)) return { kind: 'NONE', strong: false };
      for (var z = 0; z < zones.length; z++) {
        var zz = zones[z];
        if (dir === 'bull' && zz.type !== 'DEMAND') continue;
        if (dir === 'bear' && zz.type !== 'SUPPLY') continue;
        var zLo = Math.min(zz.bottom, zz.top);
        var zHi = Math.max(zz.bottom, zz.top);
        if (isFinite(zLo) && isFinite(zHi) && hi >= zLo && lo <= zHi) {
          return { kind: dir === 'bull' ? 'DEMAND' : 'SUPPLY', strong: true };
        }
      }
      if (dir === 'bull' && gpLo != null && gpHi != null && hi >= gpLo && lo <= gpHi) {
        return fzFalling ? { kind: 'POCKET_FALLING', strong: false } : { kind: 'POCKET', strong: true };
      }
      return { kind: 'NONE', strong: false };
    }

    // Outcome: STOP = the formation's own extreme (low of the 1–3 signal bars
    // for a bull reversal; high for a bear); TARGET = 2R from the signal close.
    // First CONFIRMED close to breach either wins; neither yet ⇒ LIVE.
    function candleOutcome(i, dir) {
      var a = Math.max(0, i - 2);
      var entry = +sorted[i][4];
      var lo = Infinity, hi = -Infinity;
      for (var k = a; k <= i; k++) {
        lo = Math.min(lo, +sorted[k][3]);
        hi = Math.max(hi, +sorted[k][2]);
      }
      if (dir === 'bull') {
        var risk = entry - lo;
        if (!(risk > 0)) return 'LIVE';
        var tgt = entry + 2 * risk;
        for (var b = i + 1; b <= lastIdx; b++) {
          if (closes[b] >= tgt) return 'WORKED';
          if (closes[b] < lo) return 'FAILED';
        }
        return 'LIVE';
      }
      var riskB = hi - entry;
      if (!(riskB > 0)) return 'LIVE';
      var tgtB = entry - 2 * riskB;
      for (var bb = i + 1; bb <= lastIdx; bb++) {
        if (closes[bb] <= tgtB) return 'WORKED';
        if (closes[bb] > hi) return 'FAILED';
      }
      return 'LIVE';
    }

    var rows = [];
    for (var i = 1; i <= lastIdx; i++) {
      var localTrend = trendInto(i);
      var win = sorted.slice(Math.max(0, i - 3), i + 1);
      var pr;
      try { pr = detectPatterns(win, localTrend); } catch (_) { continue; }
      if (!pr) continue;
      var name = null, dir = null;
      if (pr.bull && TIER1_BULL[pr.bull]) { name = pr.bull; dir = 'bull'; }
      else if (pr.bear && TIER1_BEAR[pr.bear]) { name = pr.bear; dir = 'bear'; }
      if (!name) continue;
      var li = levelInfo(i, dir);
      rows.push({
        idx: i, ts: sorted[i][0], name: name, dir: dir,
        strong: li.strong, kind: li.kind,
        close: +sorted[i][4], outcome: candleOutcome(i, dir)
      });
    }
    // Returns EVERY detected hit (full history). The TF-aware SESSION WINDOW is
    // applied at the DISPLAY layer (drawPatternMarkers + renderCandlePatternCards)
    // so the default chart/cards show all hits in the window while "Show history"
    // can still reveal all-time. Detection runs on the FULL series so each hit
    // keeps its proper lookback context.
    return rows;
  }

  // ── Candlestick history toggle (cards only) ──
  var IT_CANDLE_HIST_KEY = 'it_candle_history_v1';
  var itCandleHistory = (function () {
    try { return localStorage.getItem(IT_CANDLE_HIST_KEY) === '1'; } catch (_) { return false; }
  })();

  function renderCandlePatternCards(raw, tf) {
    var host = $('it-candle-cards');
    if (!host) return;
    // Gate on the Patterns legend toggle (matches the on-chart arrows).
    if (!STATE.indVisible.patterns) { host.hidden = true; host.innerHTML = ''; return; }
    var rows = collectIntradayPatterns(raw, tf);
    if (!rows || !rows.length) { host.hidden = true; host.innerHTML = ''; return; }

    var tfLabel = (TF[tf] && TF[tf].label) || tf;
    // Match the on-chart arrows 1:1 — default shows every hit within the TF-aware
    // SESSION WINDOW (recencyMinTs); uncapped daily falls back to the most-recent
    // few; "Show history" reveals all-time.
    var recent;
    if (itCandleHistory) {
      recent = rows.slice();
    } else {
      var _cut = recencyMinTs(raw);
      recent = (_cut > -Infinity)
        ? rows.filter(function (r) { return new Date(r.ts).getTime() >= _cut; })
        : rows.slice(-PATTERN_CARD_MAX);
    }
    var hiddenCount = rows.length - recent.length;

    var cards = recent.map(function (r) {
      var loc = candleLoc(r);
      var arrow = r.dir === 'bull' ? '\u25B2' : '\u25BC';
      var star = r.strong ? '\u2605 ' : '';
      var dateLabel = patternDateLabel(r.ts, tf);
      var defn = PATTERN_DEFN[r.name] || '';
      var oc = PATTERN_OUTCOME_BADGE[r.outcome] || PATTERN_OUTCOME_BADGE.LIVE;
      var tip = r.name + ' (' + (r.dir === 'bull' ? 'bullish' : 'bearish') + '). '
        + defn + ' \u2014 ' + loc.note + ' ' + oc.tip + ' Bar: ' + dateLabel + '.';
      var cls = 'it-pattern-card it-pattern-card--' + r.dir
        + (r.strong ? ' is-strong' : '')
        + (r.kind === 'POCKET_FALLING' ? ' is-warn' : '')
        + ' is-' + oc.cls;
      return '<button type="button" class="' + cls + '"'
        + ' onclick="window.itFocusPatternBar(' + r.idx + ')"'
        + ' data-tip="' + escAttr(tip) + '">'
        + '<span class="it-pattern-card-r1">'
          + '<span class="it-pattern-card-arrow">' + arrow + '</span>'
          + '<span class="it-pattern-card-name">' + escAttr(star + r.name) + '</span>'
          + '<span class="it-pattern-card-dir it-pattern-card-dir--' + r.dir + '">'
            + (r.dir === 'bull' ? 'Bullish' : 'Bearish') + '</span>'
          + '<span class="it-pattern-card-state">' + oc.label + '</span>'
          + '<span class="it-pattern-card-ago">' + escAttr(dateLabel) + '</span>'
        + '</span>'
        + '<span class="it-pattern-card-loc ' + loc.cls + '">' + escAttr(loc.label) + '</span>'
        + '<span class="it-pattern-card-note">' + escAttr(loc.note) + '</span>'
      + '</button>';
    }).join('');

    var histChip = '';
    if (itCandleHistory) {
      histChip = '<button type="button" class="it-pattern-hist-toggle is-on"'
        + ' onclick="window.itToggleCandleHistory()"'
        + ' data-tip="Hide older patterns \u2014 show only the most recent">Hide history</button>';
    } else if (hiddenCount > 0) {
      var hidden = rows.slice(0, hiddenCount);
      var nW = hidden.filter(function (r) { return r.outcome === 'WORKED'; }).length;
      var nF = hidden.filter(function (r) { return r.outcome === 'FAILED'; }).length;
      var breakdown = '<span class="it-pattern-hist-w">' + nW + '\u2713</span> '
        + '<span class="it-pattern-hist-f">' + nF + '\u2717</span>';
      histChip = '<button type="button" class="it-pattern-hist-toggle"'
        + ' onclick="window.itToggleCandleHistory()"'
        + ' data-tip="Reveal every detected pattern in the cards (' + nW + ' worked, ' + nF + ' failed in history)">'
        + 'Show history (' + hiddenCount + ': ' + breakdown + ')</button>';
    }

    var subText = (itCandleHistory ? 'all ' : 'latest ') + recent.length
      + ' \u00B7 ' + escAttr(tfLabel) + ' \u00B7 tap a card to jump to it';

    host.innerHTML =
      '<div class="it-pattern-cards-head">'
        + '<span class="it-pattern-cards-icon" aria-hidden="true">\u25C6</span>'
        + '<span class="it-pattern-cards-title">Candlestick Patterns</span>'
        + '<span class="it-pattern-cards-sub">' + subText + '</span>'
        + histChip
      + '</div>'
      + '<div class="it-pattern-card-grid">' + cards + '</div>';
    host.hidden = false;
    wireFibTooltips(host); // themed [data-tip] bubble (dark/light) — no native title
  }

  // ── Geometric chart-pattern cards (via the shared window.ChartPatterns) ──
  var IT_CP_HIST_KEY = 'it_cp_history_v1';
  var itCpHistory = (function () {
    try { return localStorage.getItem(IT_CP_HIST_KEY) === '1'; } catch (_) { return false; }
  })();
  var CP_OUTCOME_BADGE = {
    WATCH:      { label: 'WATCH',         cls: 'watch' },
    LIVE:       { label: 'LIVE',          cls: 'live' },
    TARGET_HIT: { label: '\u2713 WORKED', cls: 'worked' },
    FAILED:     { label: '\u2717 FAILED', cls: 'failed' }
  };
  function cpLoc(r) {
    if (r.strong && r.dir === 'bull') return { cls: 'it-loc-strong-bull', label: 'At demand zone',
      note: 'Bullish pattern sitting on a demand zone (support) \u2014 the strongest long context.' };
    if (r.strong && r.dir === 'bear') return { cls: 'it-loc-strong-bear', label: 'At supply zone',
      note: 'Bearish pattern sitting on a supply zone (resistance) \u2014 a strong short / exit context.' };
    return { cls: 'it-loc-none', label: 'Open space',
      note: 'No nearby zone \u2014 weaker on its own; needs other confluence.' };
  }
  function cpNote(r) {
    var dirWord = r.dir === 'bull' ? 'bullish' : 'bearish';
    if (r.outcome === 'TARGET_HIT') {
      return 'Played out \u2014 price reached the ' + fmtPrice(r.target) + ' target after a confirmed '
        + dirWord + ' break. Shown for validation; the move is done.';
    }
    if (r.outcome === 'FAILED') {
      return 'Failed \u2014 price closed back through the ' + fmtPrice(r.stop) + ' invalidation after the '
        + dirWord + ' break. Shown for validation; the thesis broke.';
    }
    if (r.state === 'CONFIRMED') {
      return r.dir === 'bull'
        ? 'Confirmed ' + dirWord + ' break, in play. Target ' + fmtPrice(r.target) + '; thesis invalid on a close below ' + fmtPrice(r.stop) + '.'
        : 'Confirmed ' + dirWord + ' break, in play. Target ' + fmtPrice(r.target) + '; thesis invalid on a close above ' + fmtPrice(r.stop) + '.';
    }
    return 'Setup forming (' + dirWord + '). WATCH \u2014 not a signal until a confirmed '
      + (r.dir === 'bull' ? 'close above the neckline' : 'close below the neckline')
      + '. Then target ' + fmtPrice(r.target) + ', invalid at ' + fmtPrice(r.stop) + '.';
  }
  var CP_RANGE_ICON = '<svg class="it-cp-card-range-icon" viewBox="0 0 24 24" aria-hidden="true" '
    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    + '<rect x="3" y="4.5" width="18" height="17" rx="2"></rect>'
    + '<line x1="3" y1="9.5" x2="21" y2="9.5"></line>'
    + '<line x1="8" y1="2.5" x2="8" y2="6.5"></line>'
    + '<line x1="16" y1="2.5" x2="16" y2="6.5"></line></svg>';

  function renderChartPatternCards(raw, tf) {
    var host = $('it-cp-cards');
    if (!host) return;
    if (!window.ChartPatterns || typeof window.ChartPatterns.detect !== 'function') {
      host.hidden = true; host.innerHTML = ''; return;
    }
    var rows;
    // RECENCY: scope the geometric-pattern detector to the TF-aware session
    // window (recencySlice) — the SAME window the zones + candlestick patterns
    // use. So only chart patterns from the last ~1 week (15m/30m/1h) or last 2
    // sessions (1m/3m/5m) are surfaced; daily is uncapped. The overlay call sites
    // slice with the identical helper, so the cards + the on-chart drawing stay 1:1.
    try { rows = window.ChartPatterns.detect(recencySlice(raw), tf) || []; }
    catch (_) { host.hidden = true; host.innerHTML = ''; return; }
    if (!rows.length) { host.hidden = true; host.innerHTML = ''; return; }

    var tfLabel = (TF[tf] && TF[tf].label) || tf;
    // Actionable (LIVE / WATCH) always shown; resolved (worked / failed) is the
    // audit trail, appended only when the user expands history.
    function isActionable(r) { return r.outcome === 'LIVE' || r.outcome === 'WATCH'; }
    function isResolved(r) { return r.outcome === 'TARGET_HIT' || r.outcome === 'FAILED'; }
    var actionable = rows.filter(isActionable);
    var resolved = rows.filter(isResolved);
    var nW = resolved.filter(function (r) { return r.outcome === 'TARGET_HIT'; }).length;
    var nF = resolved.filter(function (r) { return r.outcome === 'FAILED'; }).length;
    var shown = itCpHistory ? actionable.concat(resolved) : actionable;

    var cards = shown.map(function (r) {
      var loc = cpLoc(r);
      var arrow = r.dir === 'bull' ? '\u25B2' : '\u25BC';
      var badge = CP_OUTCOME_BADGE[r.outcome] || CP_OUTCOME_BADGE[r.state === 'CONFIRMED' ? 'LIVE' : 'WATCH'];
      var note = cpNote(r);
      var span = patternRangeLabel(r.startTs, r.ts, tf);
      var tip = r.name + ' (' + (r.dir === 'bull' ? 'bullish' : 'bearish') + ', ' + r.type + '). '
        + note + ' \u2014 ' + loc.note + ' Forms ' + span + '.';
      var cls = 'it-cp-card it-cp-card--' + r.dir
        + (r.strong ? ' is-strong' : '')
        + (r.state === 'CONFIRMED' ? ' is-confirmed' : ' is-pending')
        + ' is-' + badge.cls;
      return '<button type="button" class="' + cls + '"'
        + ' onclick="window.itFocusChartPattern(' + r.anchorIdx + ')"'
        + ' data-tip="' + escAttr(tip) + '">'
        + '<span class="it-cp-card-r1">'
          + '<span class="it-cp-card-arrow">' + arrow + '</span>'
          + '<span class="it-cp-card-name">' + escAttr(r.short || r.name) + '</span>'
          + '<span class="it-cp-card-dir it-cp-card-dir--' + r.dir + '">'
            + (r.dir === 'bull' ? 'Bullish' : 'Bearish') + '</span>'
          + '<span class="it-cp-card-state">' + badge.label + '</span>'
        + '</span>'
        + '<span class="it-cp-card-range" data-tip="When this pattern forms on the chart">'
          + CP_RANGE_ICON + escAttr(span)
        + '</span>'
        + '<span class="it-cp-card-r2">'
          + '<span class="it-cp-card-loc ' + loc.cls + '">' + escAttr(loc.label) + '</span>'
          + '<span class="it-cp-card-tgt">T ' + escAttr(fmtPrice(r.target)) + '</span>'
          + '<span class="it-cp-card-inv">\u2715 ' + escAttr(fmtPrice(r.stop)) + '</span>'
        + '</span>'
        + '<span class="it-cp-card-note">' + escAttr(note) + '</span>'
      + '</button>';
    }).join('');

    var chip = '';
    if (resolved.length) {
      var chipLbl = itCpHistory ? 'Hide history'
        : ('Show history (' + resolved.length + ': '
            + '<span class="it-cp-hist-w">' + nW + '\u2713</span> '
            + '<span class="it-cp-hist-f">' + nF + '\u2717</span>)');
      chip = '<button type="button" class="it-cp-hist-toggle' + (itCpHistory ? ' is-on' : '') + '"'
        + ' onclick="window.itToggleChartPatternHistory()"'
        + ' data-tip="Worked / failed patterns are kept for validation. Toggle to show or hide them in the cards.">'
        + chipLbl + '</button>';
    }

    var body = shown.length
      ? '<div class="it-cp-card-grid">' + cards + '</div>'
      : '<div class="it-cp-card-empty">No live or watch setups on this timeframe right now.'
        + (resolved.length ? ' Use \u201CShow history\u201D to review past patterns.' : '') + '</div>';

    host.innerHTML =
      '<div class="it-cp-cards-head">'
        + '<span class="it-cp-cards-icon" aria-hidden="true">\u25C8</span>'
        + '<span class="it-cp-cards-title">Chart Patterns</span>'
        + '<span class="it-cp-cards-sub">' + shown.length + ' shown \u00B7 ' + escAttr(tfLabel)
          + ' \u00B7 tap a card to inspect it on the chart</span>'
        + chip
      + '</div>'
      + body;
    host.hidden = false;
    wireFibTooltips(host); // themed [data-tip] bubble (dark/light) — no native title
  }

  // ── Fibonacci retracement card (mirrors the swing analyzer's Fib card) ──
  // DISPLAY ONLY — a descriptive read of where price sits in the last impulse
  // leg's retracement, NOT a buy/sell verdict. The swing card's headline badge
  // mirrors the swing recommendation-verdict engine (swComputeVerdictForTf); we
  // deliberately DON'T port that real-money engine here, so the badge instead
  // shows the neutral price-action status (Bounce / Forming / Falling / …) as
  // CONTEXT, coloured but never an explicit BUY/SKIP call. Reuses the global
  // sw-zoi-* / sw-smc-grouphead / sw-tip presentational classes (single source
  // of truth with the swing card — no drift) and adds the full it-fib-level
  // ladder of every level + price the user asked for.
  var FIB_LADDER = [
    { ratio: 0.000, label: '0.0%' },
    { ratio: 0.236, label: '23.6%' },
    { ratio: 0.382, label: '38.2%' },
    { ratio: 0.500, label: '50.0%' },
    { ratio: 0.618, label: '61.8%' },
    { ratio: 0.800, label: '80.0%' },
    { ratio: 1.000, label: '100%' }
  ];
  // bounceStatus → neutral price-action read (label + colour class + note).
  // Colour conveys "is this a discount-zone reaction or a falling knife"; it is
  // NOT a trade signal. Mirrors swing's descriptive arrow/label only.
  var FIB_PA = {
    BOUNCE:    { cls: 'sw-zoi-score--high',      arrow: '\u2191', label: 'Bounce',    desc: 'Tapped the pullback pocket and is rising back out \u2014 the classic discount-zone reaction. Context only, confirm with structure.' },
    RECOVERY:  { cls: 'sw-zoi-score--high',      arrow: '\u2197', label: 'Recovery',  desc: 'Dropped below the pocket then climbed back into it \u2014 momentum turning up. Context only.' },
    RECOVERED: { cls: 'sw-zoi-score--low',       arrow: '\u2197', label: 'Recovered', desc: 'Recovered from a deep retracement and now above the pocket \u2014 the discount entry was missed.' },
    FORMING:   { cls: 'sw-zoi-score--mid',       arrow: '\u21AF', label: 'Forming',   desc: 'Inside the pullback pocket and ticking up \u2014 wait for a clean reversal candle.' },
    FALLING:   { cls: 'sw-zoi-score--low',       arrow: '\u2193', label: 'Falling',   desc: 'In or below the pocket and still falling \u2014 no reversal yet, stand aside.' },
    ABOVE:     { cls: 'sw-zoi-card-score--none', arrow: '\u2192', label: 'Above',     desc: 'Has not pulled back into the pocket yet \u2014 too high for a discount entry.' }
  };

  // One reasoning row — reuses swing's global sw-rsn-* classes so the block is
  // visually identical to the swing card's REASONING list.
  //   kind: 'ok' (✓ pass) | 'no' (✗ fail) | 'warn' (⚠ caution) | 'info' (• neutral)
  function fibRsnRow(kind, txt) {
    var glyph = kind === 'ok' ? '\u2713' : kind === 'no' ? '\u2717' : kind === 'warn' ? '\u26A0' : '\u2022';
    return '<div class="sw-rsn-row sw-rsn-' + kind + '">'
      + '<span class="sw-rsn-ico" aria-hidden="true">' + glyph + '</span>'
      + '<span class="sw-rsn-txt">' + escAttr(txt) + '</span>'
      + '</div>';
  }

  // Build the REASONING / CONFLUENCE / RISKS block from the Fib read + the
  // intraday demand/supply zones. DISPLAY ONLY — honest, fact-based bullets
  // derived from data we actually have (retracement %, direction, volume,
  // nearby zones). It deliberately does NOT run the swing recommendation-verdict
  // engine, so it never fabricates a BUY/SKIP call or a confluence grade.
  function fibReasoningHtml(fb, raw, fpf) {
    var leg = fb.swHigh - fb.swLow;
    // Direction-aware counter-move depth so the % matches the reversed chart/
    // ladder: up-leg = pullback DOWN from the high; down-leg = bounce UP from the
    // low. (The narrative wording below is still long/buy-the-dip framed — a
    // separate follow-up would re-voice it for down-leg "sell-the-bounce".)
    var dnR = fb.legDir === 'DOWN';
    var retrace = leg > 0 ? (dnR ? ((fb.currentPx - fb.swLow) / leg) * 100 : ((fb.swHigh - fb.currentPx) / leg) * 100) : 0;
    // Active band (shallow 38.2–61.8% intraday; classic 61.8–80% on 30m/1h/1d).
    var pkName = fb.pocketName || 'Golden Pocket';
    var pkLabel = fb.pocketLabel || '61.8\u201380%';
    var pkTop = (fb.pocketTopRatio != null ? fb.pocketTopRatio : 0.618) * 100; // shallow edge %
    var pkBot = (fb.pocketBotRatio != null ? fb.pocketBotRatio : 0.800) * 100; // deep edge %
    var pkLo = pkName.toLowerCase();
    var inGP = retrace >= pkTop && retrace <= pkBot;
    var dir = fb.fibDirection || 'FALLING';
    var topEdgePx = dnR ? (fb.swLow + (pkTop / 100) * leg) : (fb.swHigh - (pkTop / 100) * leg);

    // Lead reason line.
    var reason = retrace < pkTop
      ? 'Only a shallow ' + retrace.toFixed(0) + '% dip \u2014 still above the ' + pkLabel + ' ' + pkLo + ', so no discount long entry yet.'
      : inGP
        ? 'Inside the ' + pkLabel + ' ' + pkLo + ' \u2014 the prime pullback zone. ' + (dir === 'RISING' ? 'Turning up here.' : dir === 'FALLING' ? 'Still falling through it \u2014 wait for a reversal.' : 'Consolidating here.')
        : 'Overshot the ' + pkLo + ' (' + retrace.toFixed(0) + '% > ' + pkBot.toFixed(0) + '%) \u2014 a deeper retracement; the up-leg may be failing.';

    var checks = [];
    // Pocket position (mirror swing's fib-scope bullet).
    if (inGP) checks.push(fibRsnRow('ok', 'price is inside the ' + pkLo + ' (' + pkLabel + ')'));
    else if (retrace > pkBot) checks.push(fibRsnRow('warn', 'overshot the pocket \u2014 below ' + pkBot.toFixed(0) + '%' + (dir === 'RISING' ? ', now recovering' : ', still below')));
    else checks.push(fibRsnRow('no', 'not yet pulled back into the pocket (still above ' + pkTop.toFixed(0) + '% \u2014 ' + fpf(topEdgePx) + ')'));
    var rp = Math.round(retrace);
    checks.push(fibRsnRow('info', 'current retracement: ~' + rp + '%' + (rp < pkTop ? ' (shallow)' : rp > pkBot ? ' (deep)' : '')));
    if (dir === 'RISING') checks.push(fibRsnRow('ok', 'higher-high / higher-low confirmed'));
    else if (dir === 'CONSOLIDATING') checks.push(fibRsnRow('info', 'range-bound \u2014 no clear trend yet'));
    else checks.push(fibRsnRow('no', 'no higher-high / higher-low yet'));

    // Nearby demand zone (support) from the intraday detector — used for both a
    // confluence factor (support below) and a risk (already-tested zone).
    var dem = null;
    try {
      var zones = (typeof detectZones === 'function') ? (detectZones(raw) || []) : [];
      for (var z = 0; z < zones.length; z++) {
        if (zones[z].type !== 'DEMAND') continue;
        if (!dem || (zones[z].gap || 0) < (dem.gap || 0)) dem = zones[z];
      }
    } catch (_) { dem = null; }

    // CONFLUENCE — list only factors that are actually TRUE (honest, no grade).
    var conf = [];
    if (inGP) conf.push('price in the ' + pkLo + ' (prime pullback zone)');
    if (dir === 'RISING') conf.push('uptrend structure \u2014 rising into the leg');
    if (fb.volConfirm) conf.push('volume confirms participation');
    if (dem && (dem.touches || 0) === 0) conf.push('fresh demand zone as support below (' + fpf(Math.max(dem.bottom, dem.top)) + ')');
    if (fb.bounceStatus === 'BOUNCE' || fb.bounceStatus === 'RECOVERY') conf.push('reacting up off the pocket (' + (fb.bounceStatus === 'BOUNCE' ? 'bounce' : 'recovery') + ')');

    // RISKS TO WEIGH.
    var risks = [];
    if (dir === 'FALLING') risks.push('still falling \u2014 no confirmed reversal yet');
    if (retrace > pkBot) risks.push('deep retracement (>' + pkBot.toFixed(0) + '%) \u2014 the up-leg may be failing');
    if (retrace < pkTop) risks.push('shallow dip \u2014 chasing risk, no discount entry');
    if (fb.volRatio != null && !fb.volConfirm) risks.push('volume below average \u2014 weak participation');
    if (dem && (dem.touches || 0) > 0) risks.push('demand zone already tested ' + dem.touches + '\u00d7 \u2014 weaker support');

    var html = '<div class="sw-rsn">'
      + '<div class="sw-rsn-head">REASONING</div>'
      + '<div class="sw-rsn-reason">' + escAttr(reason) + '</div>'
      + checks.join('');
    if (conf.length) {
      html += '<div class="sw-rsn-sub">Confluence (' + conf.length + ' aligned)</div>';
      for (var ci = 0; ci < conf.length; ci++) html += fibRsnRow('ok', conf[ci]);
    }
    if (risks.length) {
      html += '<div class="sw-rsn-sub">Risks to weigh</div>';
      for (var ri = 0; ri < risks.length; ri++) html += fibRsnRow('warn', risks[ri]);
    }
    html += '</div>';
    return html;
  }

  // ── Intraday-accurate Fib anchoring ──────────────────────────────
  // Why this exists (real money reads this chart): the swing computeFibZone()
  // anchors on a MULTI-DAY window with swing-scale fractal pivots + a
  // 5%-of-price noise floor. On 1m–15m Nifty that (a) lets the overnight gap
  // become part of the "leg" and (b) collapses to absolute extremes because no
  // intraday move is ever 5% — so the pocket is noisy and points at the wrong
  // place. For the TRUE intraday TFs we instead:
  //   • keep only TODAY's session bars (gap can never contaminate the leg),
  //   • take the latest SIGNIFICANT swing via the shared ATR-scaled ZigZag
  //     (window._zigzagFrom) so micro-wiggles are ignored,
  //   • treat the SHALLOW 38.2–61.8% band as the actionable pullback pocket —
  //     a healthy intraday trend retraces shallow; a 61.8–80% pull usually
  //     means the intraday leg already failed,
  //   • anchor on CLOSED bars only (no repaint), tick-round levels to 0.05.
  // 30m/1h/1d have too few bars in one session, so they DELEGATE to the proven
  // swing computeFibZone unchanged. DISPLAY ONLY — emits no buy/sell signal.
  // Returns the SAME shape computeFibZone does (every downstream consumer keeps
  // working) PLUS pocket* fields (the active band) and engine/building flags.
  function computeIntradayFib(rawNewestFirst, tf) {
    var swingFn = (window._swCP && typeof window._swCP.computeFibZone === 'function')
      ? window._swCP.computeFibZone : null;

    // Multi-day TFs (and every safety-net path) use the swing engine verbatim,
    // then tag on the classic 61.8–80% golden-pocket band so the card renders
    // exactly the wording it always has on those TFs.
    function asSwing(fz) {
      if (!fz) return null;
      fz.engine = 'swing';
      fz.building = false;
      fz.pocketName = 'Golden Pocket';
      fz.pocketLabel = '61.8\u201380%';
      fz.pocketTopRatio = 0.618;
      fz.pocketBotRatio = 0.800;
      fz.pocketHiPx = fz.fib618;   // higher price (shallow edge, 61.8%)
      fz.pocketLoPx = fz.fib786;   // lower price  (deep edge, 80%)
      // Derive the anchor candle timestamps so the chart can draw this Fib
      // candle-to-candle too (the swing engine doesn't return them). swHigh/swLow
      // ARE raw bar high/low values, so an exact match locates the anchor bar.
      if (rawNewestFirst && rawNewestFirst.length) {
        for (var _hi = 0; _hi < rawNewestFirst.length; _hi++) {
          if (+rawNewestFirst[_hi][2] === fz.swHigh) { fz.swHighTs = rawNewestFirst[_hi][0]; break; }
        }
        for (var _lo = 0; _lo < rawNewestFirst.length; _lo++) {
          if (+rawNewestFirst[_lo][3] === fz.swLow) { fz.swLowTs = rawNewestFirst[_lo][0]; break; }
        }
      }
      return fz;
    }

    var spec = TF[tf];
    var isFastIntraday = !!(spec && spec.intraday)
      && (tf === '1m' || tf === '3m' || tf === '5m' || tf === '15m');
    if (!isFastIntraday || !rawNewestFirst || rawNewestFirst.length < 8) {
      return asSwing(swingFn ? swingFn(rawNewestFirst) : null);
    }

    // Oldest-first, then keep only the CURRENT session (latest IST day-key).
    var asc = rawNewestFirst.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    function istKey(ts) {
      var d = new Date(new Date(ts).getTime() + IST_OFF_SEC * 1000);
      return d.getUTCFullYear() + '-' + d.getUTCMonth() + '-' + d.getUTCDate();
    }
    var lastKey = istKey(asc[asc.length - 1][0]);
    var sess = [];
    for (var si = 0; si < asc.length; si++) {
      if (istKey(asc[si][0]) === lastKey) sess.push(asc[si]);
    }
    var nAll = sess.length;
    if (nAll < 6) {
      return { engine: 'intraday', building: true, tf: tf,
        reason: 'session just opened \u2014 not enough bars to read a swing yet' };
    }

    var currentPx = +sess[nAll - 1][4];

    // Anchors come from CLOSED bars only (drop the still-forming bar while the
    // market is open) so the LEG never repaints; currentPx still tracks live.
    var closed = isMarketOpen() ? sess.slice(0, nAll - 1) : sess.slice();
    var n = closed.length;
    if (n < 5) {
      return { engine: 'intraday', building: true, tf: tf,
        reason: 'session just opened \u2014 not enough closed bars yet' };
    }

    // ATR (shared IndicatorMath) drives swing-significance + the min-leg gate.
    var atrv = NaN;
    try {
      var aa = IM().atr ? IM().atr(closed, 14) : [];
      if (aa && aa.length) atrv = +aa[aa.length - 1];
    } catch (_) { atrv = NaN; }
    if (!isFinite(atrv) || atrv <= 0) {
      var sumR = 0, cR = 0;
      for (var r = 0; r < n; r++) { var rg = +closed[r][2] - +closed[r][3]; if (isFinite(rg)) { sumR += rg; cR++; } }
      atrv = cR ? sumR / cR : (currentPx * 0.003);
    }

    // Anchor on the MOST RECENT SIGNIFICANT leg — not the latest micro-swing
    // (draws Fib on noise) and not the whole-day max/min (too wide for a scalp
    // and makes every TF look identical). The trick: drive the ZigZag with the
    // *significance threshold itself* as its reversal size, so every pivot it
    // emits is already a real impulse and well separated — adjacent pivots can
    // never be a 1-bar wiggle. The last two pivots are then, by construction,
    // the latest significant leg. Significance = ≥1.2 ATR AND ≥25% of the
    // session range (range term keeps it robust when ATR is unusually small).
    var sessHi = -Infinity, sessLo = Infinity;
    for (var sx = 0; sx < n; sx++) { sessHi = Math.max(sessHi, +closed[sx][2]); sessLo = Math.min(sessLo, +closed[sx][3]); }
    var minLeg = Math.max(atrv * 1.2, (sessHi - sessLo) * 0.25, 0.05);

    var startDir = (+closed[n - 1][4] >= +closed[0][4]) ? 'UP' : 'DOWN';
    var zz = null;
    try {
      if (typeof window._zigzagFrom === 'function') zz = window._zigzagFrom(closed, minLeg, startDir);
    } catch (_) { zz = null; }

    var swHigh = NaN, swLow = NaN, swHighIdx = -1, swLowIdx = -1;
    if (zz && zz.swingHighs && zz.swingLows && (zz.swingHighs.length + zz.swingLows.length) >= 1) {
      var piv = [];
      for (var ph = 0; ph < zz.swingHighs.length; ph++) piv.push({ idx: zz.swingHighs[ph].idx, price: zz.swingHighs[ph].price, hi: true });
      for (var pl = 0; pl < zz.swingLows.length; pl++) piv.push({ idx: zz.swingLows[pl].idx, price: zz.swingLows[pl].price, hi: false });
      piv.sort(function (a, b) { return a.idx - b.idx; });
      var last = piv[piv.length - 1];
      // The most recent CONFIRMED pivot fixes the NEAR anchor + the leg's
      // direction. The FAR anchor must be the TRUE extreme of the whole
      // connected move — NOT the immediately preceding ZigZag pivot, which can
      // be an intermediate higher-low / lower-high sitting above (or below) the
      // real swing origin. We find it by walking back to the bar where price
      // was last at this same level (the launch point) and taking the genuine
      // min-low / max-high in between. Self-bounding: on a choppy day price
      // revisits the level soon, so the leg stays local (no whole-day blow-up).
      //
      // RE-ANCHOR ON DEEP RETRACE: once the live move has retraced ≥78.6% of the
      // leg (the standard Fib invalidation point), the leg is effectively dead —
      // holding it would draw a stale map price has already pushed through. So
      // we flip to the DEVELOPING counter-leg (the move that's actually live)
      // instead of waiting for a full >100% break. Closed-bar only → no repaint.
      // INVALIDATION POINT: a retracement that exceeds 78.6% of its parent
      // impulse is the standard Fib "leg is dead" threshold. We use it to decide
      // whether the latest ZigZag leg is a RETRACEMENT of the prior impulse (map
      // the impulse — current price is pulling back into its pocket) or a fresh
      // IMPULSE in its own right (map the latest leg). Closed-bar only → no repaint.
      var REANCHOR_RETRACE = 0.786;
      if (!last.hi) {
        // ---- Latest leg is DOWN: `last` is a pullback / impulse LOW. ----
        // 1) Find the PEAK price fell from: back-scan to the launch bar (last bar
        //    STRICTLY below this low) and take the highest high in between.
        var bIdxD = 0;
        for (var bkD = last.idx - 1; bkD >= 0; bkD--) { if (+closed[bkD][3] < last.price) { bIdxD = bkD; break; } }
        var peakV = -Infinity, peakI = last.idx;
        for (var hkD = bIdxD; hkD <= last.idx; hkD++) { var hvD = +closed[hkD][2]; if (hvD > peakV) { peakV = hvD; peakI = hkD; } }
        // 2) Origin LOW of the up-impulse INTO that peak (the rally start):
        //    back-scan from the peak to the last bar STRICTLY above it, take the
        //    lowest low. Strict ">" skips the peak's own flat-top plateau.
        var oIdxD = 0;
        for (var okD = peakI - 1; okD >= 0; okD--) { if (+closed[okD][2] > peakV) { oIdxD = okD; break; } }
        var impLoV = Infinity, impLoI = peakI;
        for (var lkD = oIdxD; lkD <= peakI; lkD++) { var lvD = +closed[lkD][3]; if (lvD < impLoV) { impLoV = lvD; impLoI = lkD; } }
        var upImpulse = peakV - impLoV;
        var pullbackD = peakV - last.price;
        // RETRACEMENT (held above origin AND < 78.6%) → map the up-impulse so the
        // Fib pocket marks where the dip may find support. Otherwise the down move
        // is a fresh impulse → map peak → pullback-low.
        swHigh = peakV; swHighIdx = peakI;
        if (upImpulse > 0 && last.price > impLoV && pullbackD < REANCHOR_RETRACE * upImpulse) {
          swLow = impLoV; swLowIdx = impLoI;
        } else {
          swLow = last.price; swLowIdx = last.idx;
        }
      } else {
        // ---- Latest leg is UP: `last` is a bounce / impulse HIGH. ----
        // 1) Find the TROUGH price rose from: back-scan to the launch bar (last
        //    bar STRICTLY above this high) and take the lowest low in between.
        var bIdxU = 0;
        for (var bkU = last.idx - 1; bkU >= 0; bkU--) { if (+closed[bkU][2] > last.price) { bIdxU = bkU; break; } }
        var troughV = Infinity, troughI = last.idx;
        for (var lkU = bIdxU; lkU <= last.idx; lkU++) { var lvU = +closed[lkU][3]; if (lvU < troughV) { troughV = lvU; troughI = lkU; } }
        // 2) Origin HIGH of the down-impulse INTO that trough: back-scan from the
        //    trough to the last bar STRICTLY below it, take the highest high.
        var oIdxU = 0;
        for (var okU = troughI - 1; okU >= 0; okU--) { if (+closed[okU][3] < troughV) { oIdxU = okU; break; } }
        var impHiV = -Infinity, impHiI = troughI;
        for (var hkU = oIdxU; hkU <= troughI; hkU++) { var hvU = +closed[hkU][2]; if (hvU > impHiV) { impHiV = hvU; impHiI = hkU; } }
        var downImpulse = impHiV - troughV;
        var bounceU = last.price - troughV;
        // RETRACEMENT (stayed below origin AND < 78.6%) → map the down-impulse so
        // the Fib pocket marks where the bounce may meet resistance. Otherwise the
        // up move is a fresh impulse → map trough → bounce-high.
        swLow = troughV; swLowIdx = troughI;
        if (downImpulse > 0 && last.price < impHiV && bounceU < REANCHOR_RETRACE * downImpulse) {
          swHigh = impHiV; swHighIdx = impHiI;
        } else {
          swHigh = last.price; swHighIdx = last.idx;
        }
      }
    }

    // Fallback: no significant ZigZag leg → use the session's own high/low
    // extremes (a legit intraday range-Fib). Still session-scoped, no repaint.
    if (!(isFinite(swHigh) && isFinite(swLow) && swHigh > swLow)) {
      swHigh = -Infinity; swLow = Infinity;
      for (var e = 0; e < n; e++) {
        var eh = +closed[e][2], el = +closed[e][3];
        if (eh > swHigh) { swHigh = eh; swHighIdx = e; }
        if (el < swLow) { swLow = el; swLowIdx = e; }
      }
    }

    // ── CONFIRMED-BAR INVALIDATION / EXTENSION ─────────────────────────────
    // The leg above is chosen from bars up to the last confirmed ZigZag pivot,
    // so it can lag: if a CLOSED bar AFTER the leg's most-recent anchor prints a
    // new extreme beyond the leg (high above 0% / low below 100%), price has
    // already pushed through the map and holding the old leg draws a stale
    // "dead leg". Re-anchor to the live structure. CLOSED bars only (the still-
    // forming bar was dropped into `currentPx` up top) → strictly non-repainting.
    var legEndIdx = Math.max(swHighIdx, swLowIdx);
    var legStartIdx = Math.min(swHighIdx, swLowIdx);
    if (legEndIdx >= 0 && legEndIdx < n - 1 && isFinite(swHigh) && isFinite(swLow)) {
      var postHi = -Infinity, postHiI = -1, postLo = Infinity, postLoI = -1;
      for (var pb = legEndIdx + 1; pb < n; pb++) {
        var pbh = +closed[pb][2], pbl = +closed[pb][3];
        if (pbh > postHi) { postHi = pbh; postHiI = pb; }
        if (pbl < postLo) { postLo = pbl; postLoI = pb; }
      }
      var brokeUp = postHiI >= 0 && postHi > swHigh;
      var brokeDn = postLoI >= 0 && postLo < swLow;
      // Both broken in the post-leg window → the MORE RECENT break is the live
      // direction; the older one is just part of the move into it.
      if (brokeUp && brokeDn) { if (postHiI >= postLoI) brokeDn = false; else brokeUp = false; }
      if (brokeUp) {
        // New high beyond 0% → up-move. 0% = new high; 100% = lowest low from the
        // prior leg origin up to that new high (the true rally start).
        var nlo = swLow, nloI = swLowIdx;
        for (var qb = legStartIdx; qb <= postHiI; qb++) { var qbl = +closed[qb][3]; if (qbl < nlo) { nlo = qbl; nloI = qb; } }
        swHigh = postHi; swHighIdx = postHiI; swLow = nlo; swLowIdx = nloI;
      } else if (brokeDn) {
        // New low beyond 100% → down-move. 100% = new low; 0% = highest high from
        // the prior leg origin down to that new low (the true sell-off start).
        var nhi = swHigh, nhiI = swHighIdx;
        for (var rb = legStartIdx; rb <= postLoI; rb++) { var rbh = +closed[rb][2]; if (rbh > nhi) { nhi = rbh; nhiI = rb; } }
        swLow = postLo; swLowIdx = postLoI; swHigh = nhi; swHighIdx = nhiI;
      }
    }

    var leg = swHigh - swLow;
    // Range still too tight to mean anything (< ~0.3 ATR) → building, not a guess.
    if (!(leg > 0) || leg < atrv * 0.3) {
      return { engine: 'intraday', building: true, tf: tf,
        reason: 'session range still too tight for a reliable retracement' };
    }

    function r05(v) { return Math.round(v / 0.05) * 0.05; }
    var fib236 = r05(swHigh - 0.236 * leg);
    var fib382 = r05(swHigh - 0.382 * leg);
    var fib500 = r05(swHigh - 0.500 * leg);
    var fib618 = r05(swHigh - 0.618 * leg);
    var fib800 = r05(swHigh - 0.800 * leg);

    // Shallow actionable band: 38.2% (higher price) → 61.8% (lower price).
    var pocketHiPx = fib382, pocketLoPx = fib618;

    // Structure read (HH-HL over the last 4 closed bars) — same definition the
    // swing engine uses, just session-scoped.
    var isRising = false;
    var bullCandle = (+closed[n - 1][4] >= +closed[n - 1][1]);
    if (n >= 4) {
      var H0 = +closed[n-1][2], H1 = +closed[n-2][2], H2 = +closed[n-3][2], H3 = +closed[n-4][2];
      var L0 = +closed[n-1][3], L1 = +closed[n-2][3], L2 = +closed[n-3][3], L3 = +closed[n-4][3];
      var hhC = (H0>H1?1:0)+(H1>H2?1:0)+(H2>H3?1:0);
      var hlC = (L0>L1?1:0)+(L1>L2?1:0)+(L2>L3?1:0);
      isRising = hhC >= 2 && hlC >= 2;
    }
    // Consolidation: last 6 bars' range < 1.5 ATR.
    var cN = Math.min(6, n), cHi = -Infinity, cLo = Infinity;
    for (var ck = n - cN; ck < n; ck++) { cHi = Math.max(cHi, +closed[ck][2]); cLo = Math.min(cLo, +closed[ck][3]); }
    var tight = (cHi - cLo) < 1.5 * atrv;
    var fibDirection = isRising ? 'RISING' : (tight ? 'CONSOLIDATING' : 'FALLING');

    // Origin pivot (where the leg started) + how many bars ago.
    var fibPivotPrice, fibPivotBarsAgo;
    if (swHighIdx >= swLowIdx) { fibPivotPrice = swLow; fibPivotBarsAgo = (n - 1) - swLowIdx; }
    else { fibPivotPrice = swHigh; fibPivotBarsAgo = (n - 1) - swHighIdx; }
    if (!(fibPivotBarsAgo >= 0)) fibPivotBarsAgo = 0;

    var pivotDepth = (leg > 0) ? ((swHigh - fibPivotPrice) / leg) * 100 : 0;
    var fibOriginZone = pivotDepth > 100 ? 'Deep' : pivotDepth > 80 ? 'Below'
      : pivotDepth > 61.8 ? 'Pocket' : pivotDepth > 38.2 ? 'Mid' : pivotDepth >= 0 ? 'Above' : 'Top';

    // Bounce read vs the SHALLOW band (keys map to FIB_PA).
    var look = Math.min(8, n), recentMinLow = Infinity;
    for (var bi = n - look; bi < n; bi++) recentMinLow = Math.min(recentMinLow, +closed[bi][3]);
    var touchedPocket = recentMinLow <= pocketHiPx && recentMinLow >= pocketLoPx * 0.999;
    var wasDeep = recentMinLow < pocketLoPx;
    var bounceStatus;
    if (currentPx > pocketHiPx) {
      if (touchedPocket && isRising) bounceStatus = 'BOUNCE';
      else if (fibDirection === 'RISING' && wasDeep) bounceStatus = 'RECOVERED';
      else bounceStatus = 'ABOVE';
    } else if (currentPx >= pocketLoPx) {
      if (wasDeep && isRising && bullCandle) bounceStatus = 'RECOVERY';
      else bounceStatus = (isRising && bullCandle) ? 'FORMING' : 'FALLING';
    } else {
      bounceStatus = (isRising && bullCandle) ? 'RECOVERY' : 'FALLING';
    }

    // Volume confirmation off the last CLOSED bar vs its 20-bar average. Nifty
    // index reports vol=0 → volRatio null → no confirmation claim (honest).
    var vBase = n - 1, volAvgN = Math.min(20, n - 1), vSum = 0, vCnt = 0;
    for (var vk = vBase - 1; vk >= vBase - volAvgN && vk >= 0; vk--) { vSum += (+closed[vk][5] || 0); vCnt++; }
    var avgVol = vCnt ? vSum / vCnt : 0;
    var curVol = +closed[vBase][5] || 0;
    var volRatio = avgVol > 0 ? curVol / avgVol : null;
    var volConfirm = (volRatio == null) ? null : (volRatio >= 1.0);

    // Which leg is mapped: the more-recent anchor sets the direction. High more
    // recent → up-leg (0% is the rally top, pocket = support / buy-dip). Low more
    // recent → down-leg (100% is the sell-off bottom, pocket = resistance).
    var legDir = (swHighIdx >= swLowIdx) ? 'UP' : 'DOWN';
    // Anchor candle timestamps — let the chart draw the Fib as a candle-to-candle
    // segment (TradingView-style anchored Fib) instead of a full-width line.
    var swHighTs = (closed[swHighIdx] ? closed[swHighIdx][0] : null);
    var swLowTs = (closed[swLowIdx] ? closed[swLowIdx][0] : null);

    return {
      engine: 'intraday', building: false, tf: tf,
      currentPx: currentPx,
      swHigh: swHigh, swLow: swLow,
      legDir: legDir,
      swHighTs: swHighTs, swLowTs: swLowTs,
      fib236: fib236, fib382: fib382, fib500: fib500, fib618: fib618, fib786: fib800,
      bounceStatus: bounceStatus,
      isRising: isRising,
      fibDirection: fibDirection,
      fibOriginZone: fibOriginZone,
      fibPivotPrice: fibPivotPrice,
      fibPivotBarsAgo: fibPivotBarsAgo,
      volConfirm: volConfirm,
      volRatio: volRatio,
      pocketName: 'Pullback Pocket',
      pocketLabel: '38.2\u201361.8%',
      pocketTopRatio: 0.382,
      pocketBotRatio: 0.618,
      pocketHiPx: pocketHiPx,
      pocketLoPx: pocketLoPx
    };
  }

  function renderFibCard(raw, tf) {
    var host = $('it-fib-cards');
    if (!host) return;
    var fb = null;
    try {
      var newestFirst = raw.slice().sort(function (a, b) {
        return new Date(b[0]).getTime() - new Date(a[0]).getTime();
      });
      fb = computeIntradayFib(newestFirst, tf);
    } catch (_) { fb = null; }
    // Early-session / too-tight (intraday engine) — show an honest "building"
    // note instead of a misleading pocket drawn on noise.
    if (fb && fb.building) {
      var tfLabelB = (TF[tf] && TF[tf].label) || tf;
      host.hidden = false;
      host.innerHTML = '<div class="sw-smc-grouphead">'
        + '<span class="sw-smc-grouphead-title">Fibonacci Retracement</span>'
        + '<span class="sw-smc-grouphead-count">BUILDING</span>'
        + '</div>'
        + '<div class="it-fib-building">Building session structure on the ' + escAttr(tfLabelB)
        + ' \u2014 ' + escAttr(fb.reason || 'waiting for a clear intraday swing.')
        + ' The Fib needs a real low\u2192high leg from today\u2019s session before it can plot.</div>';
      return;
    }
    if (!fb || !isFinite(fb.swHigh) || !isFinite(fb.swLow) || fb.swHigh <= fb.swLow) {
      host.hidden = true; host.innerHTML = ''; return;
    }

    var fpf = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
    var leg = fb.swHigh - fb.swLow;
    // Down-leg uses the standard 0%-at-low convention: % = how far the bounce has
    // retraced UP from the low. Up-leg keeps 0%-at-high (pullback DOWN from high).
    var dn = fb.legDir === 'DOWN';
    var retrace = leg > 0 ? (dn ? ((fb.currentPx - fb.swLow) / leg) * 100 : ((fb.swHigh - fb.currentPx) / leg) * 100) : 0;
    var retraceClamped = Math.max(0, Math.min(100, retrace));
    // Active pullback band (intraday = shallow 38.2–61.8%; 30m/1h/1d = classic
    // 61.8–80% golden pocket). Driven entirely by the engine that produced fb.
    var pkName = fb.pocketName || 'Golden Pocket';
    var pkLabel = fb.pocketLabel || '61.8\u201380%';
    var pkTop = (fb.pocketTopRatio != null ? fb.pocketTopRatio : 0.618) * 100; // shallow edge %
    var pkBot = (fb.pocketBotRatio != null ? fb.pocketBotRatio : 0.800) * 100; // deep edge %
    var pkHiPx = isFinite(fb.pocketHiPx) ? fb.pocketHiPx : fb.fib618;          // higher price
    var pkLoPx = isFinite(fb.pocketLoPx) ? fb.pocketLoPx : fb.fib786;          // lower price
    var inGP = retrace >= pkTop && retrace <= pkBot;
    var pa = FIB_PA[fb.bounceStatus] || FIB_PA.ABOVE;
    var tfLabel = (TF[tf] && TF[tf].label) || tf;

    var typeTip = 'Fibonacci retracement of the latest ' + (fb.engine === 'intraday' ? 'intraday session ' : '')
      + 'impulse leg (swing low \u2192 swing high) on the ' + tfLabel
      + '. The ' + pkLabel + ' band is the \u201C' + pkName.toLowerCase() + '\u201D \u2014 where pullbacks most often find support'
      + (fb.engine === 'intraday' ? ' (intraday trends pull back shallow; a deeper 61.8\u201380% drop usually means the leg already failed).' : '.');
    var statusTip = 'What price is DOING around the ' + pkName.toLowerCase() + ' on this timeframe \u2014 context, not a trade call (this chart is display-only). '
      + pa.label + ': ' + pa.desc;
    var depthTip = retrace.toFixed(1) + (dn
        ? '% bounced from swing low (' + fpf(fb.swLow) + ') toward swing high (' + fpf(fb.swHigh) + ').\n\n'
        : '% retraced from swing high (' + fpf(fb.swHigh) + ') toward swing low (' + fpf(fb.swLow) + ').\n\n')
      + pkName + ' = ' + pkLabel + ' retracement.\n'
      + (inGP ? '\u2705 Price is INSIDE the ' + pkName.toLowerCase() + ' now.' : (retrace < pkTop ? 'Above the pocket \u2014 not pulled back deep enough yet.' : 'Below the pocket \u2014 overshot deeper than ' + pkBot.toFixed(0) + '%.'));
    var pocketTip = pkName + ' price band (' + pkLabel + ' retracement).\nUpper edge (' + pkTop.toFixed(1) + '%): ' + fpf(pkHiPx) + '\nLower edge (' + pkBot.toFixed(1) + '%): ' + fpf(pkLoPx) + '\nA pullback into this band is the highest-probability long entry.';

    // Direction tag (RISING / FALLING / CONSOLIDATING + origin zone).
    var dirLabel = fb.fibDirection || 'FALLING';
    var dirZone = fb.fibOriginZone || 'Above';
    var dirArrow = dirLabel === 'RISING' ? '\u2191' : dirLabel === 'FALLING' ? '\u2193' : '\u21C4';
    var dirCls = dirLabel === 'RISING' ? 'sw-zoi-tag--fresh' : dirLabel === 'CONSOLIDATING' ? 'sw-zoi-tag--neutral' : 'sw-zoi-tag--tested';
    var dirZoneDesc = { Deep: 'below the swing low', Below: 'below the golden pocket', Pocket: 'inside the golden pocket', Mid: 'mid-range (38\u201362%)', Above: 'shallow pullback zone', Top: 'at/near the swing high' };
    var dirPivotPx = fb.fibPivotPrice != null ? fpf(fb.fibPivotPrice) : '';
    var dirBars = fb.fibPivotBarsAgo || 0;
    var dirTip;
    if (dirLabel === 'RISING') {
      dirTip = 'Price bottomed at ' + dirPivotPx + ' (' + dirZoneDesc[dirZone] + ') and has been rising since.\nConfirmed pivot low ' + dirBars + ' bars ago.';
    } else if (dirLabel === 'CONSOLIDATING') {
      dirTip = 'Price is range-bound near ' + dirPivotPx + ' (last 6 bars).\nNo clear trend \u2014 wait for a breakout.';
    } else {
      dirTip = 'Price is declining from ' + dirPivotPx + ' (' + dirZoneDesc[dirZone] + ').\nNo confirmed pivot low yet \u2014 the decline has not reversed.';
    }

    var volTip = (fb.volRatio != null)
      ? 'Latest closed-bar volume vs its 20-bar average. ' + fb.volRatio.toFixed(2) + 'x \u2014 ' + (fb.volConfirm ? 'above average, confirms participation.' : 'below average, weak confirmation.')
      : 'No usable volume on this instrument (e.g. an index).';
    var volBar = (fb.volRatio != null) ? Math.min(100, Math.round(fb.volRatio / 3 * 100)) : 0;
    var volVal = (fb.volRatio != null) ? fb.volRatio.toFixed(1) + 'x avg' : 'n/a';

    // REASONING / CONFLUENCE / RISKS block (same visual as swing, honest
    // Fib-derived content — no verdict engine).
    var reasoningHtml = fibReasoningHtml(fb, raw, fpf);

    // Full level ladder — every Fib level + price + distance from the live
    // price. Fixed 4-column grid (ratio · price · distance · GP slot) so every
    // row lines up; the golden-pocket band is highlighted.
    var levelRows = FIB_LADDER.map(function (lv) {
      var price = dn ? (fb.swLow + lv.ratio * leg) : (fb.swHigh - lv.ratio * leg);
      var isGp = lv.ratio >= (pkTop / 100 - 1e-6) && lv.ratio <= (pkBot / 100 + 1e-6);
      var distPct = (isFinite(fb.currentPx) && fb.currentPx > 0) ? ((price - fb.currentPx) / fb.currentPx) * 100 : null;
      var distStr = (distPct == null) ? '' : (distPct >= 0 ? '+' : '') + distPct.toFixed(1) + '%';
      return '<div class="it-fib-level' + (isGp ? ' is-gp' : '') + '">'
        + '<span class="it-fib-level-ratio">' + lv.label + '</span>'
        + '<span class="it-fib-level-px">' + fpf(price) + '</span>'
        + '<span class="it-fib-level-dist">' + distStr + '</span>'
        + '<span class="it-fib-level-tag">' + (isGp ? '<span class="it-fib-level-gp-tag">GP</span>' : '') + '</span>'
      + '</div>';
    }).join('');
    var ladderHtml = '<div class="it-fib-levels">'
      + '<div class="it-fib-levels-head sw-tip" data-tip="Every Fibonacci level of the swing ' + (dn ? 'high \u2192 swing low (down-leg)' : 'low \u2192 swing high (up-leg)') + ', with its price and distance from the live price. ' + (dn ? '0% = swing low, 100% = swing high' : '0% = swing high, 100% = swing low') + '; the ' + escAttr(pkLabel) + ' band (GP) is the ' + escAttr(pkName.toLowerCase()) + '.">All levels (' + (dn ? '0% = low \u00B7 100% = high' : '0% = high \u00B7 100% = low') + ')</div>'
      + '<div class="it-fib-level-grid">' + levelRows + '</div>'
    + '</div>';

    var groupHtml = '<div class="sw-smc-grouphead">'
      + '<span class="sw-smc-grouphead-title">Fibonacci Retracement</span>'
      + '<span class="sw-smc-grouphead-count">' + (inGP ? 'IN POCKET' : retrace.toFixed(0) + '%') + '</span>'
    + '</div>';

    var metricsHtml = '<div class="sw-zoi-card-metrics">'
      +   '<div class="sw-zoi-metric sw-tip" data-tip="' + escAttr(depthTip) + '">'
      +     '<span class="sw-zoi-metric-label">Depth</span>'
      +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--fib" style="width:' + retraceClamped + '%"></div></div>'
      +     '<span class="sw-zoi-metric-val">' + retrace.toFixed(1) + '%</span>'
      +   '</div>'
      +   '<div class="sw-zoi-metric sw-tip" data-tip="' + escAttr(volTip) + '">'
      +     '<span class="sw-zoi-metric-label">Volume</span>'
      +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--vol" style="width:' + volBar + '%"></div></div>'
      +     '<span class="sw-zoi-metric-val">' + volVal + '</span>'
      +   '</div>'
      + '</div>';

    var tagsHtml = '<div class="sw-zoi-card-pattern">'
      +   '<span class="sw-zoi-tag ' + (inGP ? 'sw-zoi-tag--fresh' : '') + ' sw-tip" data-tip="' + escAttr(depthTip) + '">' + (inGP ? 'IN POCKET' : 'OUTSIDE') + '</span> '
      +   '<span class="sw-zoi-tag ' + dirCls + ' sw-tip" data-tip="' + escAttr(dirTip) + '">' + dirLabel + ' \u00B7 ' + dirArrow + ' ' + dirZone + '</span>'
      +   (fb.volConfirm ? ' <span class="sw-zoi-tag sw-zoi-tag--fresh">VOL \u2713</span>' : '')
      +   ' <span class="sw-zoi-pattern-label sw-tip" data-tip="' + escAttr(pa.desc) + '">' + pa.arrow + ' ' + pa.label + '</span>'
      + '</div>';

    // Full-width card with a 2-column body (reasoning | levels + metrics) so it
    // spans the section and stays short instead of one tall narrow column.
    var cardHtml = '<div class="sw-zoi-card sw-zoi-card--fib it-fib-card">'
      + '<div class="sw-zoi-card-head">'
      +   '<span class="sw-zoi-card-type sw-tip" data-tip="' + escAttr(typeTip) + '">Fib Retracement \u00B7 ' + escAttr(tfLabel) + '</span>'
      +   '<span class="sw-zoi-card-range-inline sw-tip" data-tip="' + escAttr(pocketTip) + '">' + escAttr(pkName) + ': ' + fpf(pkLoPx) + ' \u2013 ' + fpf(pkHiPx) + '</span>'
      +   '<span class="sw-zoi-card-score ' + pa.cls + ' sw-tip" data-tip="' + escAttr(statusTip) + '">' + pa.arrow + ' ' + pa.label.toUpperCase() + '</span>'
      + '</div>'
      + '<div class="it-fib-body">'
      +   '<div class="it-fib-col it-fib-col-left">' + reasoningHtml + tagsHtml + '</div>'
      +   '<div class="it-fib-col it-fib-col-right">' + ladderHtml + metricsHtml + '</div>'
      + '</div>'
      + '<div class="sw-zoi-card-foot">'
      +   '<span class="sw-tip" data-tip="The impulse leg the retracement is measured on (swing low \u2192 swing high).">Leg: ' + fpf(fb.swLow) + ' \u2192 ' + fpf(fb.swHigh) + '</span>'
      +   '<span class="sw-tip" data-tip="Latest close and how far it has retraced into the leg.">Now: ' + fpf(fb.currentPx) + ' (' + retrace.toFixed(0) + '%)</span>'
      + '</div>'
    + '</div>';

    host.innerHTML = groupHtml + cardHtml;
    host.hidden = false;
    wireFibTooltips(host);
  }

  // Reuse the swing themed-tooltip element + hover pattern so [data-tip] hints
  // render identically (dark/light aware). Creates the shared global tip node
  // if the swing tab hasn't been visited yet.
  function wireFibTooltips(panel) {
    var tip = document.getElementById('sw-zoi-tip-global');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'sw-zoi-tip-global';
      tip.className = 'sw-zoi-tip';
      document.body.appendChild(tip);
    }
    var timer = 0;
    panel.onmouseover = function (e) {
      var tgt = e.target.closest('[data-tip]');
      if (!tgt) { clearTimeout(timer); tip.style.display = 'none'; return; }
      clearTimeout(timer);
      timer = setTimeout(function () {
        tip.textContent = '';
        var lines = tgt.getAttribute('data-tip').split('\n');
        for (var li = 0; li < lines.length; li++) {
          if (li > 0) tip.appendChild(document.createElement('br'));
          tip.appendChild(document.createTextNode(lines[li]));
        }
        tip.style.display = '';
        var r = tgt.getBoundingClientRect();
        var lf = r.left, tp = r.bottom + 6;
        if (lf + 320 > window.innerWidth) lf = window.innerWidth - 330;
        if (lf < 8) lf = 8;
        if (tp + 200 > window.innerHeight) tp = r.top - tip.offsetHeight - 6;
        tip.style.left = lf + 'px';
        tip.style.top = tp + 'px';
      }, 300);
    };
    panel.onmouseout = function (e) {
      var tgt = e.target.closest('[data-tip]');
      if (tgt) { clearTimeout(timer); tip.style.display = 'none'; }
    };
  }

  // REASONING / CONFLUENCE / RISKS block for one supply/demand zone. Honest,
  // fact-based description of THIS zone — never a buy/sell verdict (the chart
  // feeds no signal). `pos` is the precomputed position read (inside/near/away).
  function zoiReasoningHtml(z, isDem, px, fpf, pos, fbBand) {
    var prox = isDem ? Math.max(z.top, z.bottom) : Math.min(z.top, z.bottom); // body edge
    var dist = isDem ? Math.min(z.top, z.bottom) : Math.max(z.top, z.bottom); // wick edge
    var tested = (z.touches || 0) >= 1;

    var reason = isDem
      ? 'Buyers absorbed the selling here and drove price up with an impulsive leg \u2014 unfilled buy orders likely rest at the body edge (' + fpf(prox) + '). The wick low (' + fpf(dist) + ') is the break level.'
      : 'Sellers overwhelmed the buying here and drove price down with an impulsive leg \u2014 unfilled sell orders likely rest at the body edge (' + fpf(prox) + '). The wick high (' + fpf(dist) + ') is the break level.';

    var checks = [];
    checks.push(tested
      ? fibRsnRow('warn', 'tested ' + z.touches + '\u00d7 since forming \u2014 partially consumed')
      : fibRsnRow('ok', 'fresh \u2014 untested since it formed'));
    // Clarify what "tested" actually counts (a recurring confusion): a touch is
    // ONE distinct visit, not one per candle inside the band.
    if (tested) checks.push(fibRsnRow('info', '\u201ctested\u201d = 1 distinct visit, not per-candle \u2014 price must fully leave and return for a 2nd'));
    if (pos.tag) checks.push(fibRsnRow('info', pos.reasonTxt));
    // Explain what actually retires the zone (answers "why is it still here?"),
    // shown where it matters: when tested, or when price is at/approaching it.
    if (tested || pos.near || pos.inside) {
      checks.push(fibRsnRow('info', 'breaks only when a candle CLOSES past ' + fpf(dist) + ' \u2014 a wick alone doesn\u2019t count'));
    }
    if (z.cluster) checks.push(fibRsnRow('info', 'part of a clustered area \u2014 a related level sits nearby'));

    // CONFLUENCE — only factors that are actually TRUE.
    var conf = [];
    if (!tested) conf.push('fresh zone \u2014 all resting orders still unfilled');
    if (pos.near || pos.inside) conf.push('price reacting at the zone now');
    if (fbBand && Math.min(z.top, z.bottom) <= fbBand.hi && Math.max(z.top, z.bottom) >= fbBand.lo) {
      conf.push('overlaps the Fib pullback pocket (' + fpf(fbBand.lo) + ' \u2013 ' + fpf(fbBand.hi) + ')');
    }
    if (isDem && px > Math.max(z.top, z.bottom)) conf.push('sits below price as support');
    if (!isDem && px < Math.min(z.top, z.bottom)) conf.push('sits above price as resistance');

    // RISKS TO WEIGH.
    var risks = [];
    if (tested) risks.push('already tested ' + z.touches + '\u00d7 \u2014 weaker than a fresh level');
    if (z.cluster) risks.push('clustered with a nearby zone \u2014 not one clean edge');
    if (pos.farPct != null && pos.farPct > 0) risks.push('price ' + pos.farPct.toFixed(2) + '% away \u2014 may not reach this zone soon');
    if (!isDem) risks.push('overhead supply \u2014 caps upside / expect resistance');

    var html = '<div class="sw-rsn">'
      + '<div class="sw-rsn-head">REASONING</div>'
      + '<div class="sw-rsn-reason">' + escAttr(reason) + '</div>'
      + checks.join('');
    if (conf.length) {
      html += '<div class="sw-rsn-sub">Confluence (' + conf.length + ' aligned)</div>';
      for (var ci = 0; ci < conf.length; ci++) html += fibRsnRow('ok', conf[ci]);
    }
    if (risks.length) {
      html += '<div class="sw-rsn-sub">Risks to weigh</div>';
      for (var ri = 0; ri < risks.length; ri++) html += fibRsnRow('warn', risks[ri]);
    }
    html += '</div>';
    return html;
  }

  // Render the demand/supply zone cards below the Fib card. Mirrors the Swing
  // Analyzer's ZOI deck (proximal/distal, position chip, reasoning + risks) but
  // is purely descriptive — intraday is display-only, so no buy/wait CALL is
  // ever mirrored onto a card (unlike swing, which sources it from the verdict).
  function renderZoiCards(raw, tf) {
    var host = $('it-zoi-cards');
    if (!host) return;
    if (!STATE.indVisible.zoi) { host.hidden = true; host.innerHTML = ''; return; }

    // Single source of truth: reuse the SAME post-expiry + post-merge zones the
    // chart bands drew this render pass (STATE.zones, set just before the card
    // render in renderChart). .slice() so our local sort can't reorder the
    // array the chart overlay loop iterates. Fall back to a fresh compute only
    // if STATE.zones isn't populated yet (deterministic — identical output).
    var zones = (STATE.zones && STATE.zones.length) ? STATE.zones.slice() : [];
    if (!zones.length) {
      try { zones = (typeof detectZones === 'function') ? (detectZones(raw) || []) : []; } catch (_) { zones = []; }
    }
    if (!zones.length) { host.hidden = true; host.innerHTML = ''; return; }

    var fpf = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };

    // Current price: live close if we have one, else the latest closed bar.
    var asc = raw.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var px = isFinite(STATE.lastClose) ? STATE.lastClose
      : (asc.length ? +asc[asc.length - 1][4] : NaN);

    // Adaptive "approaching" threshold = 1×ATR(14) (matches the detector's
    // ATR-based philosophy) so it scales with the TF instead of a fixed %.
    var atr = 0;
    try {
      var av = IM().atr ? IM().atr(asc, 14) : [];
      atr = (av.length && isFinite(av[av.length - 1])) ? av[av.length - 1] : 0;
    } catch (_) { atr = 0; }
    if (!(atr > 0)) atr = (isFinite(px) && px > 0) ? px * 0.003 : 0;

    // Fib pullback-pocket band for the confluence check (intraday-accurate
    // engine: shallow 38.2–61.8% on 1m–15m, classic 61.8–80% on 30m/1h/1d).
    var fbBand = null;
    try {
      var nf = raw.slice().sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
      var fb = computeIntradayFib(nf, tf);
      if (fb && isFinite(fb.pocketLoPx) && isFinite(fb.pocketHiPx)) {
        fbBand = { lo: Math.min(fb.pocketLoPx, fb.pocketHiPx), hi: Math.max(fb.pocketLoPx, fb.pocketHiPx) };
      }
    } catch (_) { fbBand = null; }

    // Demand first, then supply; nearest-to-price first within a type.
    zones.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'DEMAND' ? -1 : 1;
      return (a.gap || 0) - (b.gap || 0);
    });

    function positionOf(z, isDem) {
      var lo = Math.min(z.top, z.bottom), hi = Math.max(z.top, z.bottom);
      var out = { tag: '', cls: '', distTxt: '', reasonTxt: '', inside: false, near: false, farPct: null };
      if (!isFinite(px) || px <= 0) return out;
      if (px >= lo && px <= hi) {
        out.tag = 'PRICE INSIDE'; out.cls = 'sw-zoi-pos--inside';
        out.distTxt = 'in the zone now'; out.reasonTxt = 'price is inside the zone right now';
        out.inside = true; return out;
      }
      var gap = (px > hi) ? (px - hi) : (lo - px);
      var gapPct = gap / px * 100;
      var near = gap <= atr;
      out.near = near;
      out.farPct = near ? null : gapPct;
      if (px > hi) {
        out.tag = near ? 'APPROACHING' : 'PRICE ABOVE';
        out.cls = near ? 'sw-zoi-pos--near' : (isDem ? 'sw-zoi-pos--above' : 'sw-zoi-pos--broken');
        out.distTxt = 'zone ' + fpf(gap) + ' (' + gapPct.toFixed(2) + '%) below';
        out.reasonTxt = near ? 'price approaching the zone from above' : 'price ' + gapPct.toFixed(2) + '% above the zone';
      } else {
        out.tag = near ? 'APPROACHING' : 'PRICE BELOW';
        out.cls = near ? 'sw-zoi-pos--near' : (isDem ? 'sw-zoi-pos--broken' : 'sw-zoi-pos--below');
        out.distTxt = 'zone ' + fpf(gap) + ' (' + gapPct.toFixed(2) + '%) above';
        out.reasonTxt = near ? 'price approaching the zone from below' : 'price ' + gapPct.toFixed(2) + '% below the zone';
      }
      return out;
    }

    var tfLabel = (TF[tf] && TF[tf].label) || tf;
    var groupHtml = '<div class="sw-smc-grouphead">'
      + '<span class="sw-smc-grouphead-title">Supply &amp; Demand Zones</span>'
      + '<span class="sw-smc-grouphead-count">' + zones.length + '</span>'
    + '</div>';

    var cardsHtml = '';
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      var isDem = z.type === 'DEMAND';
      var cls = isDem ? 'sw-zoi-card sw-zoi-card--demand' : 'sw-zoi-card sw-zoi-card--supply';
      var lo = Math.min(z.top, z.bottom), hi = Math.max(z.top, z.bottom);
      var prox = isDem ? hi : lo, dist = isDem ? lo : hi;
      var tested = (z.touches || 0) >= 1;
      var pos = positionOf(z, isDem);

      var typeTip = isDem
        ? 'DEMAND ZONE: a level where buyers previously overwhelmed sellers with conviction. Unfilled buy orders likely remain \u2014 price tends to bounce up from here.'
        : 'SUPPLY ZONE: a level where sellers previously overwhelmed buyers with conviction. Unfilled sell orders likely remain \u2014 price tends to drop from here.';
      var freshTip = tested
        ? 'TESTED: price has revisited this zone ' + z.touches + ' distinct time(s) but held \u2014 a "visit" is counted once, no matter how many candles sit inside. Each visit absorbs some orders, so it is weaker than fresh. (A 2nd visit retires the zone.)'
        : 'FRESH: price has not returned to this zone since it formed. All unfilled orders are still waiting \u2014 highest probability of reaction.';
      var rangeTip = 'Zone price range on the ' + tfLabel + '.\nProximal (near edge): ' + fpf(prox) + ' \u2014 body edge where orders rested (entry/reaction).\nDistal (far edge): ' + fpf(dist) + ' \u2014 the break level (stop). The zone dies only when a candle CLOSES beyond here; a wick poking past is treated as a liquidity grab, not a break.';
      var posTip = pos.tag ? ('Where the live price (' + fpf(px) + ') sits relative to this zone (' + fpf(lo) + ' \u2013 ' + fpf(hi) + ').') : '';

      var freshBadge = tested ? 'TESTED' : 'FRESH';
      var freshCls = tested ? 'sw-zoi-score--mid' : 'sw-zoi-score--high';

      var posHtml = pos.tag
        ? '<div class="sw-zoi-card-pos ' + pos.cls + ' sw-tip" data-tip="' + escAttr(posTip) + '">'
          +   '<span class="sw-zoi-pos-tag">' + pos.tag + '</span>'
          +   '<span class="sw-zoi-pos-dist">' + pos.distTxt + '</span>'
          + '</div>'
        : '';

      var rsnHtml = zoiReasoningHtml(z, isDem, px, fpf, pos, fbBand);

      // Formed / Confirmed dated rows — prominent, right under the price range
      // (mirrors the Swing Analyzer ZOI card exactly). Reuses swing's .sw-zoi-card-
      // formed/-confirmed classes (loaded globally). patternDateLabel adds the
      // intraday time (e.g. "09 Jun 10:35") so a scalp zone's birth is precise.
      // Both anchor on confirmed (closed) bars — never the live forming bar.
      var formedHtml = z.startTs
        ? '<div class="sw-zoi-card-formed sw-tip" data-tip="When this zone STARTED forming \u2014 the first candle of the base (consolidation) where orders began stacking, before price launched away. Anchored to a confirmed (closed) candle, in IST.">'
          +   '<span class="sw-zoi-formed-icon" aria-hidden="true">\uD83D\uDCC5</span> Formed ' + patternDateLabel(z.startTs, tf)
          + '</div>'
        : '';
      var confirmedHtml = (z.confirmTs && z.startTs && z.confirmTs !== z.startTs)
        ? '<div class="sw-zoi-card-confirmed sw-tip" data-tip="When the zone was CONFIRMED \u2014 the breakout candle that launched away from the base and proved it. Anchored to a confirmed (closed) candle, in IST.">'
          +   '<span class="sw-zoi-confirmed-icon" aria-hidden="true">\u2713</span> Confirmed ' + patternDateLabel(z.confirmTs, tf)
          + '</div>'
        : '';

      var tagsHtml = '<div class="sw-zoi-card-pattern">'
        +   '<span class="sw-zoi-tag sw-zoi-tag--' + (tested ? 'tested' : 'fresh') + ' sw-tip" data-tip="' + escAttr(freshTip) + '">' + freshBadge + '</span> '
        +   (z.cluster ? '<span class="sw-zoi-tag sw-zoi-tag--neutral sw-tip" data-tip="A related zone of the same type sits close by (0.5\u20131.5\u00d7ATR) \u2014 treat them as one soft area.">CLUSTER</span> ' : '')
        + '</div>';

      cardsHtml += '<div class="' + cls + '">'
        + '<div class="sw-zoi-card-head">'
        +   '<span class="sw-zoi-card-type sw-tip" data-tip="' + escAttr(typeTip) + '">' + (isDem ? 'DEMAND ZONE' : 'SUPPLY ZONE') + '</span>'
        +   '<span class="sw-zoi-card-score ' + freshCls + ' sw-tip" data-tip="' + escAttr(freshTip) + '">' + freshBadge + '</span>'
        + '</div>'
        + '<div class="sw-zoi-card-range sw-tip" data-tip="' + escAttr(rangeTip) + '">' + fpf(lo) + ' \u2013 ' + fpf(hi) + '</div>'
        + formedHtml
        + confirmedHtml
        + posHtml
        + rsnHtml
        + tagsHtml
        + '<div class="sw-zoi-card-foot">'
        +   '<span class="sw-tip" data-tip="Proximal = body edge (entry). Distal = wick extreme (stop / break level).">Prox ' + fpf(prox) + ' \u00b7 Distal ' + fpf(dist) + '</span>'
        +   '<span class="sw-tip" data-tip="Live price and its distance to this zone.">Now: ' + fpf(px) + (pos.tag ? ' (' + pos.tag.toLowerCase() + ')' : '') + '</span>'
        + '</div>'
      + '</div>';
    }

    host.innerHTML = groupHtml + '<div class="it-zoi-deck">' + cardsHtml + '</div>';
    host.hidden = false;
    wireFibTooltips(host);
  }

  // Forming-zone CARDS (amber) — mirrors the Swing Analyzer's forming deck:
  // tier (EARLY/WATCH), the evidence chips, and the Formed date. Shown only when
  // the Forming legend chip is on. Reuses swing's .sw-forming-* CSS (loaded
  // globally). DISPLAY-ONLY + low-trust — never a buy/sell call.
  function renderFormingCards(raw, tf) {
    var host = $('it-forming-cards');
    if (!host) return;
    // The whole accordion is hidden unless there's something to show (the chip
    // is OFF by default, so an always-visible empty "Forming Zones" box would
    // just be clutter).
    var acc = document.querySelector('details.it-acc[data-acc="forming"]');
    var list = (STATE.formingZones && STATE.formingZones.length) ? STATE.formingZones : [];
    if (!STATE.indVisible.forming || !list.length) {
      host.hidden = true; host.innerHTML = '';
      if (acc) acc.hidden = true;
      return;
    }
    if (acc) acc.hidden = false;
    var fp = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
    var TURN_LABEL = { HAMMER: 'Hammer', PIERCING: 'Piercing', ENGULF: 'Bullish engulfing', STRONG_CLOSE: 'Strong close', WICK_REJECT: 'Wick rejection' };
    var htmlOut = '<div class="sw-smc-grouphead">'
      + '<span class="sw-smc-grouphead-title">Forming demand zones</span>'
      + '<span class="sw-smc-grouphead-count">' + list.length + '</span>'
      + '</div>'
      + '<div class="sw-forming-note">Early, UNCONFIRMED reads \u2014 marked the instant a base candle closed, before any confirming leg. Lower trust than confirmed zones. <b>EARLY</b> = small-starter candidate (tight stop below the zone, 2R+ target, add on confirmation). <b>WATCH</b> = context only. Never a full-size BUY.</div>';
    for (var i = 0; i < list.length; i++) {
      var fc = list[i];
      var early = !!fc.tradeable;
      var badge = early ? 'EARLY' : 'WATCH';
      var flav = fc.flavour === 'REVERSAL' ? 'Reversal' : 'Continuation';
      var turn = TURN_LABEL[fc.turnKind] || fc.turnKind || '';
      var ev = fc.evidence || {};
      var chips = '<span class="sw-forming-chip">' + turn + '</span>'
        + '<span class="sw-forming-chip">' + flav + '</span>'
        + (ev.atSupport ? '<span class="sw-forming-chip">At support</span>' : '')
        + (ev.nearEma ? '<span class="sw-forming-chip">At EMA</span>' : '')
        + '<span class="sw-forming-chip sw-forming-chip--vol">Vol ' + (fc.volMult != null ? fc.volMult + '\u00d7' : '?') + '</span>';
      var badgeTip = early
        ? 'EARLY \u2014 a forming demand REVERSAL. Backtests show a small but real positive edge (about +0.2R at a 2R target, ~39% win rate). Treat it as a SMALL-STARTER only: tight stop just below the zone, target 2R or more, add on confirmation. NOT a full-size BUY.'
        : 'WATCH \u2014 a forming continuation pullback. Context only; not a trade trigger on its own.';
      var lo = Math.min(fc.proximal, fc.distal), hi = Math.max(fc.proximal, fc.distal);
      var rangeTip = 'Forming zone band. Distal (far/stop edge): ' + fp(lo) + '. Proximal (near edge): ' + fp(hi) + '. A tight stop sits just below the distal edge.';
      var formedTs = fc.baseStartTs || fc.formationTs;
      htmlOut += '<div class="sw-forming-card ' + (early ? 'sw-forming-card--early' : 'sw-forming-card--watch') + '">'
        + '<div class="sw-forming-card-head">'
        +   '<span class="sw-forming-card-type">FORMING DEMAND</span>'
        +   '<span class="sw-forming-badge ' + (early ? 'sw-forming-badge--early' : 'sw-forming-badge--watch') + ' sw-tip" data-tip="' + escAttr(badgeTip) + '">' + badge + '</span>'
        + '</div>'
        + '<div class="sw-forming-card-range sw-tip" data-tip="' + escAttr(rangeTip) + '">' + fp(lo) + ' \u2013 ' + fp(hi) + '</div>'
        + (formedTs
            ? '<div class="sw-forming-card-formed sw-tip" data-tip="When this forming base STARTED \u2014 the first candle of the consolidation where the early read began, in IST. No confirming leg is required for a forming zone.">'
              + '<span aria-hidden="true">\uD83D\uDCC5</span> Formed ' + patternDateLabel(formedTs, tf)
              + (fc._barsAgo != null ? ' \u00b7 ' + fc._barsAgo + ' bar' + (fc._barsAgo === 1 ? '' : 's') + ' ago' : '')
              + '</div>'
            : '')
        + '<div class="sw-forming-card-evidence">' + chips + '</div>'
        + '</div>';
    }
    host.innerHTML = htmlOut;
    host.hidden = false;
    wireFibTooltips(host);
  }

  // Paint BOTH pattern decks + the Fib card + the zone cards for the current
  // raw/TF (from renderChart).
  // ── CPR (Central Pivot Range) card ───────────────────────────────
  // DISPLAY ONLY — frames the day-type (NARROW=trending / NORMAL / WIDE=range)
  // and where price sits vs the pivot framework. Mirrors the Options-Trading
  // tab's CPR pill semantics (GREEN=narrow/trending, AMBER=normal, RED=wide/
  // range) so the two tabs tell the same story. Levels via the shared buildCpr
  // (→ IndicatorMath.computeCPR). Renders on intraday TFs only; hides when no
  // prior session is available (fail safe — never a guessed level set).
  var CPR_CLASS_INFO = {
    NARROW: {
      cls: 'sw-zoi-score--high', label: 'NARROW',
      day: 'Trending day likely',
      note: 'CPR is tight (\u2264 25% of yesterday\u2019s range) \u2014 heavy disagreement on value, so players have to pick a side. Favour breakout / momentum continuation away from the pivot; this is the friendliest regime for option buyers.'
    },
    NORMAL: {
      cls: 'sw-zoi-score--mid', label: 'NORMAL',
      day: 'Average day',
      note: 'CPR is mid-width (25\u201360% of yesterday\u2019s range) \u2014 no strong day-type edge. Trade the level reactions (pivot, TC/BC, R1/S1) on their merits rather than betting on a trend or a range.'
    },
    WIDE: {
      cls: 'sw-zoi-score--low', label: 'WIDE',
      day: 'Range / chop day likely',
      note: 'CPR is wide (> 60% of yesterday\u2019s range) \u2014 lots of overlap with the prior session, so mean-reversion is favoured. Fade the extremes (R/S), and be cautious buying options into the chop (theta bleed). Inside TC\u2013BC is no-man\u2019s-land.'
    },
    UNKNOWN: {
      cls: 'sw-zoi-card-score--none', label: 'CPR',
      day: 'Day-type unavailable',
      note: 'Could not classify the CPR width against the prior range.'
    }
  };

  function renderCprCard(raw, tf) {
    var host = $('it-cpr-cards');
    if (!host) return;
    // Daily pivots only make sense on an intraday chart.
    if (!(TF[tf] && TF[tf].intraday)) { host.hidden = true; host.innerHTML = ''; return; }
    var cpr = null;
    try { cpr = buildCpr(raw); } catch (_) { cpr = null; }
    if (!cpr) { host.hidden = true; host.innerHTML = ''; return; }

    var L = cpr.levels;
    var info = CPR_CLASS_INFO[L.classification] || CPR_CLASS_INFO.UNKNOWN;
    var fpf = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
    var spot = isFinite(STATE.lastClose) ? STATE.lastClose : null;   // confirmed close (no tick flicker)
    var tfLabel = (TF[tf] && TF[tf].label) || tf;

    // Location of the confirmed price vs the pivot framework.
    var loc, locCls, locTip;
    if (spot == null) {
      loc = 'No price'; locCls = 'sw-zoi-tag--neutral';
      locTip = 'No confirmed close yet to locate against the CPR.';
    } else if (spot > L.TC) {
      loc = 'Above CPR'; locCls = 'sw-zoi-tag--fresh';
      locTip = 'Price is above the CPR top (TC ' + fpf(L.TC) + ') \u2014 bullish bias. Pivot / TC tend to act as support on dips; R1/R2 are the upside targets.';
    } else if (spot < L.BC) {
      loc = 'Below CPR'; locCls = 'sw-zoi-tag--tested';
      locTip = 'Price is below the CPR bottom (BC ' + fpf(L.BC) + ') \u2014 bearish bias. Pivot / BC tend to act as resistance on bounces; S1/S2 are the downside targets.';
    } else {
      loc = 'Inside CPR'; locCls = 'sw-zoi-tag--neutral';
      locTip = 'Price is inside the central range (BC ' + fpf(L.BC) + ' \u2013 TC ' + fpf(L.TC) + ') \u2014 balance / indecision. Wait for a clean break of TC (bullish) or BC (bearish) before committing.';
    }
    var pivotSide = (spot == null) ? '' : (spot >= L.P ? 'above pivot' : 'below pivot');

    var widthPct = (L.widthPctOfRange != null) ? L.widthPctOfRange : null;
    var widthBar = (widthPct != null) ? Math.min(100, Math.round(widthPct)) : 0;
    var widthVal = (widthPct != null) ? widthPct.toFixed(0) + '% of PDR' : 'n/a';
    var widthTip = 'CPR width = TC \u2212 BC = ' + fpf(L.width) + '.\nMeasured as ' + widthVal
      + ' (PDR = previous day\u2019s range).\n\u2264 25% NARROW (trending) \u00B7 25\u201360% NORMAL \u00B7 > 60% WIDE (range).';
    var typeTip = 'Central Pivot Range on the ' + tfLabel + ', computed from the previous session\u2019s High/Low/Close (' + (cpr.source === 'daily' ? 'authoritative daily candle' : 'aggregated intraday session') + '). Static all day \u2014 non-repainting. ' + info.note;

    // Ladder: high → low, central range (BC..TC) highlighted.
    var ladder = [
      { k: 'R2', px: L.R2, band: false },
      { k: 'R1', px: L.R1, band: false },
      { k: 'TC', px: L.TC, band: true },
      { k: 'Pivot', px: L.P, band: true },
      { k: 'BC', px: L.BC, band: true },
      { k: 'S1', px: L.S1, band: false },
      { k: 'S2', px: L.S2, band: false }
    ];
    var levelRows = ladder.map(function (lv) {
      if (!isFinite(lv.px)) return '';
      var distPct = (spot != null && spot > 0) ? ((lv.px - spot) / spot) * 100 : null;
      var distStr = (distPct == null) ? '' : (distPct >= 0 ? '+' : '') + distPct.toFixed(2) + '%';
      return '<div class="it-cpr-level' + (lv.band ? ' is-band' : '') + '">'
        + '<span class="it-cpr-level-k">' + lv.k + '</span>'
        + '<span class="it-cpr-level-px">' + fpf(lv.px) + '</span>'
        + '<span class="it-cpr-level-dist">' + distStr + '</span>'
        + '<span class="it-cpr-level-tag">' + (lv.k === 'Pivot' ? '<span class="it-cpr-pivot-tag">P</span>' : (lv.band ? '<span class="it-cpr-band-tag">CR</span>' : '')) + '</span>'
      + '</div>';
    }).join('');
    var ladderHtml = '<div class="it-cpr-levels">'
      + '<div class="it-cpr-levels-head sw-tip" data-tip="The full pivot ladder. CR = the Central Range (BC\u2013TC), the zone defended hardest. Distances are vs the latest confirmed close.">Pivot ladder (high \u2192 low)</div>'
      + '<div class="it-cpr-level-grid">' + levelRows + '</div>'
    + '</div>';

    // REASONING block (reuse swing's sw-rsn-* classes — single visual source).
    var rsn = '<div class="sw-rsn">'
      + '<div class="sw-rsn-head">HOW TO TRADE IT</div>'
      + '<div class="sw-rsn-reason">' + escAttr(info.day + ' \u2014 ' + info.note) + '</div>';
    if (spot != null) rsn += fibRsnRow(loc === 'Above CPR' ? 'ok' : loc === 'Below CPR' ? 'no' : 'info',
      loc + ' (' + pivotSide + ') \u2014 ' + (loc === 'Inside CPR' ? 'await a TC/BC break' : loc === 'Above CPR' ? 'bullish bias' : 'bearish bias'));
    rsn += fibRsnRow('info', 'Pivot ' + fpf(L.P) + ' is the key intraday level \u2014 the day\u2019s bull/bear line.');
    rsn += fibRsnRow('info', 'Targets: ' + (loc === 'Below CPR' ? 'S1 ' + fpf(L.S1) + ' \u00B7 S2 ' + fpf(L.S2) : 'R1 ' + fpf(L.R1) + ' \u00B7 R2 ' + fpf(L.R2)) + ' \u00B7 the opposite side frames the stop reference.');
    if (cpr.stale) rsn += fibRsnRow('warn', 'Prior session is several days old \u2014 these levels may be stale; treat with caution.');
    if (L.classification === 'WIDE') rsn += fibRsnRow('warn', 'Wide CPR \u2014 chop risk; option buyers fight theta on a range day.');
    rsn += '</div>';

    var groupHtml = '<div class="sw-smc-grouphead">'
      + '<span class="sw-smc-grouphead-title">Central Pivot Range (CPR)</span>'
      + '<span class="sw-smc-grouphead-count">' + (cpr.stale ? 'STALE' : info.label) + '</span>'
    + '</div>';

    var widthMetric = '<div class="sw-zoi-card-metrics">'
      + '<div class="sw-zoi-metric sw-tip" data-tip="' + escAttr(widthTip) + '">'
      +   '<span class="sw-zoi-metric-label">Width</span>'
      +   '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--fib" style="width:' + widthBar + '%"></div></div>'
      +   '<span class="sw-zoi-metric-val">' + widthVal + '</span>'
      + '</div>'
    + '</div>';

    var tagsHtml = '<div class="sw-zoi-card-pattern">'
      + '<span class="sw-zoi-tag ' + locCls + ' sw-tip" data-tip="' + escAttr(locTip) + '">' + loc + (pivotSide ? ' \u00B7 ' + pivotSide : '') + '</span> '
      + '<span class="sw-zoi-tag sw-tip" data-tip="' + escAttr(widthTip) + '">' + info.label + ' \u00B7 ' + widthVal + '</span>'
      + (cpr.stale ? ' <span class="sw-zoi-tag sw-zoi-tag--tested">STALE</span>' : '')
    + '</div>';

    var cardHtml = '<div class="sw-zoi-card it-cpr-card">'
      + '<div class="sw-zoi-card-head">'
      +   '<span class="sw-zoi-card-type sw-tip" data-tip="' + escAttr(typeTip) + '">CPR \u00B7 ' + escAttr(tfLabel) + '</span>'
      +   '<span class="sw-zoi-card-range-inline sw-tip" data-tip="Central Range (CR) = BC \u2013 TC, the zone defended hardest intraday.">CR: ' + fpf(L.BC) + ' \u2013 ' + fpf(L.TC) + '</span>'
      +   '<span class="sw-zoi-card-score ' + info.cls + ' sw-tip" data-tip="' + escAttr(info.day + ' \u2014 ' + info.note) + '">' + info.label + '</span>'
      + '</div>'
      + '<div class="it-fib-body">'
      +   '<div class="it-fib-col it-fib-col-left">' + rsn + tagsHtml + '</div>'
      +   '<div class="it-fib-col it-fib-col-right">' + ladderHtml + widthMetric + '</div>'
      + '</div>'
      + '<div class="sw-zoi-card-foot">'
      +   '<span class="sw-tip" data-tip="The previous completed session\u2019s High / Low / Close that the pivots are derived from.">Prev session: H ' + fpf(cpr.ohlc.high) + ' \u00B7 L ' + fpf(cpr.ohlc.low) + ' \u00B7 C ' + fpf(cpr.ohlc.close) + '</span>'
      +   '<span class="sw-tip" data-tip="Where the pivot inputs came from. Daily candle = settlement-authoritative; intraday = aggregated from the loaded session (fallback).">Source: ' + (cpr.source === 'daily' ? 'daily candle' : 'intraday agg') + '</span>'
      + '</div>'
    + '</div>';

    host.innerHTML = groupHtml + cardHtml;
    host.hidden = false;
    wireFibTooltips(host);
  }

  function renderPatternCards(raw, tf) {
    try { renderCandlePatternCards(raw, tf); } catch (_) {}
    try { renderChartPatternCards(raw, tf); } catch (_) {}
    try { renderCprCard(raw, tf); } catch (_) {}
    try { renderFibCard(raw, tf); } catch (_) {}
    try { renderZoiCards(raw, tf); } catch (_) {}
    try { renderFormingCards(raw, tf); } catch (_) {}
  }

  // Centre the chart on a bar index (click-to-focus from a card). Same TF as
  // the chart, so the index lines up directly — no cross-TF switch needed.
  function centerChartBar(idx) {
    try {
      if (!STATE.chart || typeof STATE.chart.timeScale !== 'function') return;
      STATE.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 50), to: idx + 50 });
    } catch (_) {}
  }
  window.itFocusPatternBar = function (idx) { centerChartBar(idx); };
  window.itFocusChartPattern = function (idx) { centerChartBar(idx); };

  window.itToggleCandleHistory = function () {
    itCandleHistory = !itCandleHistory;
    try { localStorage.setItem(IT_CANDLE_HIST_KEY, itCandleHistory ? '1' : '0'); } catch (_) {}
    // Re-render the chart so the markers AND the cards pick up the new cap in
    // lock-step (matches swing's swToggleCandleHistory). Preserve the view so
    // the toggle never snaps the user's zoom/pan back to auto-fit.
    if (STATE.chart) { try { renderChart(STATE.timeframe, { preserveView: true }); } catch (_) {} }
    else if (STATE.raw) { renderCandlePatternCards(STATE.raw, STATE.timeframe); }
  };
  window.itToggleChartPatternHistory = function () {
    itCpHistory = !itCpHistory;
    try { localStorage.setItem(IT_CP_HIST_KEY, itCpHistory ? '1' : '0'); } catch (_) {}
    if (STATE.raw) renderChartPatternCards(STATE.raw, STATE.timeframe);
  };

  // ---- Live last-bar patching ----
  // Patches the forming candle on each LTP without re-fetching history.
  // Intraday: append a new bar when the bucket rolls over, else update
  // H/L/C of the last bar. Daily: just track today's bar H/L/C.
  function patchLiveBar(ltp) {
    if (!STATE.candleSeries || !STATE.klines.length || !isFinite(ltp)) return;
    var tf = STATE.timeframe;
    var spec = TF[tf];
    var last = STATE.klines[STATE.klines.length - 1];
    if (!spec.intraday || typeof last.time === 'object') {
      // Daily (or business-day time): update today's bar in place.
      var upd = {
        time: last.time,
        open: last.open,
        high: Math.max(last.high, ltp),
        low: Math.min(last.low, ltp),
        close: ltp
      };
      STATE.klines[STATE.klines.length - 1] = upd;
      try { STATE.candleSeries.update(upd); } catch (_) {}
      STATE.lastClose = ltp;
      return;
    }
    var bucketSec = spec.bucketMs / 1000;
    var nowSec = Math.floor(Date.now() / 1000) + IST_OFF_SEC;
    var lastTime = last.time;
    if (nowSec >= lastTime + bucketSec) {
      // Roll forward to the bucket that contains 'now'.
      var k = Math.floor((nowSec - lastTime) / bucketSec);
      var newTime = lastTime + k * bucketSec;
      var bar = { time: newTime, open: ltp, high: ltp, low: ltp, close: ltp };
      STATE.klines.push(bar);
      try { STATE.candleSeries.update(bar); } catch (_) {}
      // A bucket just rolled over → the prior bar is now CLOSED. Refresh the
      // volume + candle context off the freshly-closed bar (small delay lets
      // the Upstox intraday feed publish it). Non-repainting, fail-safe.
      try { setTimeout(itOnBarClose, 1500); } catch (_) {}
    } else {
      var u = {
        time: lastTime,
        open: last.open,
        high: Math.max(last.high, ltp),
        low: Math.min(last.low, ltp),
        close: ltp
      };
      STATE.klines[STATE.klines.length - 1] = u;
      try { STATE.candleSeries.update(u); } catch (_) {}
    }
    STATE.lastClose = ltp;
    // Re-pin the countdown chip to the freshest forming-bar price each tick.
    try { _itPositionCountdown(document.getElementById('it-countdown')); } catch (_) {}
  }

  // ── Bar-close auto-refresh (so the volume + candle context updates the
  // instant a candle closes, like the swing chart — WITHOUT repainting) ────
  // Fired from patchLiveBar the moment the intraday bucket rolls over. A
  // single-candle pattern (hammer, etc.) is fully decided the instant the bar
  // closes, so there's no reason to wait for a manual refresh. We silently
  // re-fetch the current-TF candles (authoritative OHLCV + futures volume),
  // refresh STATE.raw, and repaint ONLY the context reads (fake-breakout radar
  // + below-chart banner + candle-pattern cards). We deliberately do NOT touch
  // the chart series or zoom — the live tick patcher already owns that. Still
  // non-repainting: every reader drops the live forming bar; this just makes
  // the just-CLOSED bar visible without the user hitting Refresh. The signal
  // engine is untouched (it has its own confirmed-bar logic). Fail-safe: any
  // miss keeps the last good state; the next bar-close retries.
  function itOnBarClose() {
    if (!STATE.active || !STATE.chart) return;
    if (typeof apiPaused === 'function' && apiPaused()) return;
    if (typeof isMarketOpen === 'function' && !isMarketOpen()) return;
    if (STATE._barCloseInFlight) return;
    var tf = STATE.timeframe;
    var spec = TF[tf];
    if (!spec || !spec.intraday) return;   // daily patches today's bar in place — no roll
    STATE._barCloseInFlight = true;
    // Drop the 20s fetch caches for this TF so we actually pull the just-closed
    // bar (a recent setup/fast tick may have warmed the cache seconds ago).
    try { delete STATE.fetchCache[tf]; } catch (_) {}
    try { delete FUT_STATE.volCache[tf]; } catch (_) {}
    Promise.resolve(getRawForTf(tf)).then(function (raw) {
      if (!raw || raw.length < 3 || STATE.timeframe !== tf) return null;
      STATE.raw = raw;
      try { STATE.prevClose = computePrevClose(raw, tf); } catch (_) {}
      // Re-scan demand/supply zones off the just-closed candles so new order
      // blocks appear and broken/retired ones drop off automatically. Gated by
      // the ZOI toggle (same as renderChart) so we never draw bands the user
      // hid. detectZones is close-based + non-repainting by construction. We
      // remove ONLY the old zone layer (not the shared rAF gluer or the BOS/
      // FVG/OB overlays) so repeated bar-close calls can't stack bands; the
      // gluer reads STATE.zones + z._el fresh each frame, so the new bands glue
      // automatically. startOverlayLoop is idempotent (re-arms if it had idled
      // because there were previously no zones).
      try {
        if (STATE.zoneLayer && STATE.zoneLayer.parentNode) {
          try { STATE.zoneLayer.parentNode.removeChild(STATE.zoneLayer); } catch (_) {}
        }
        STATE.zoneLayer = null;
        STATE.zones = (STATE.indVisible && STATE.indVisible.zoi) ? (detectZones(raw) || []) : [];
        renderZones();
        // Re-scan forming (amber) zones off the just-closed candles too, so early
        // reads appear / drop in lock-step with the confirmed bands. Same teardown
        // pattern (remove only the forming layer; the gluer reads STATE.fzEls fresh).
        if (STATE.fzLayer && STATE.fzLayer.parentNode) {
          try { STATE.fzLayer.parentNode.removeChild(STATE.fzLayer); } catch (_) {}
        }
        STATE.fzLayer = null; STATE.fzEls = [];
        renderFormingZones(raw, tf);
        if (STATE.zones.length || STATE.fzEls.length) { try { startOverlayLoop(); } catch (_) {} }
      } catch (_) { /* zone overlay is best-effort */ }
      // Re-draw geometric chart patterns (triangles, H&S, double tops, etc.) off
      // the just-closed candles. The shared ChartPatterns.onChartRender is now
      // idempotent on a persistent chart (it tears down its own prior series +
      // price lines + reposition subscription first), so a repeated call won't
      // stack overlays. Gated by the chart-patterns toggle, same as renderChart.
      // Cards (it-cp-cards) are refreshed unconditionally — cheap innerHTML swap.
      try {
        if (STATE.indVisible && STATE.indVisible.chartpatterns
            && window.ChartPatterns && typeof window.ChartPatterns.onChartRender === 'function') {
          var cpMount = $('it-chart');
          if (cpMount && STATE.chart && STATE.candleSeries) {
            window.ChartPatterns.onChartRender({ chart: STATE.chart, series: STATE.candleSeries, inner: cpMount, raw: recencySlice(raw), tf: tf });
          }
        }
        renderChartPatternCards(raw, tf);
      } catch (_) { /* chart-pattern overlay is best-effort */ }
      // Refresh the on-chart candlestick ARROWS (Tier-1 markers) so they appear
      // live the moment a pattern closes — matching the banner + cards. Updated
      // in place via the stored markers handle (setMarkers), so no second marker
      // layer stacks. Gated by the patterns toggle, same as renderChart.
      try {
        if (STATE.candleMarkers && typeof STATE.candleMarkers.setMarkers === 'function') {
          var mkSorted = (STATE.indVisible && STATE.indVisible.patterns)
            ? (drawPatternMarkers(raw.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); }), tf) || [])
            : [];
          mkSorted.sort(function (a, b) {
            var ta = typeof a.time === 'object' ? (a.time.year * 372 + a.time.month * 31 + a.time.day) * 86400 : a.time;
            var tb = typeof b.time === 'object' ? (b.time.year * 372 + b.time.month * 31 + b.time.day) * 86400 : b.time;
            return ta - tb;
          });
          STATE.candleMarkers.setMarkers(mkSorted);
        }
      } catch (_) { /* candle arrows are best-effort */ }
      // Candle pattern CARDS + the banner's candle chip refresh NOW (fast — they
      // read only price/shape, not volume). The banner's VOLUME chip stays on the
      // last SETTLED read (STATE.breakouts) for the moment — we do NOT recompute
      // the breakout/volume here, because futures volume is still filling in this
      // soon after the close and would show a premature low rvol that then jumps
      // (the banner-vs-card mismatch). That recompute is DEFERRED below.
      try { renderCandlePatternCards(raw, tf); } catch (_) {}
      try { itRenderContextBanner(); } catch (_) {}
      try { itRefreshMacroContext(); } catch (_) {}
      // Defer the VOLUME / fake-breakout recompute until the front-month future's
      // volume for the just-closed bar has settled (it trickles in for several
      // seconds after the bar closes). This is what keeps the banner + radar card
      // + chart line all showing ONE consistent, genuine rvol.
      try { setTimeout(function () { itRefreshBreakoutSettled(tf); }, IT_VOL_SETTLE_MS); } catch (_) {}
      return null;
    }, function () { /* fetch failed — keep last good state */ })
      .then(function () { STATE._barCloseInFlight = false; },
            function () { STATE._barCloseInFlight = false; });
  }

  // Settle delay (ms) for the bar-close VOLUME read. Front-month futures volume
  // for a just-closed bar isn't final the instant the bar closes — it fills in
  // over the next several seconds on Upstox. Reading it too early yields a
  // partial (too-low) rvol that later jumps once it settles, which made the
  // banner and the radar card disagree. ~10s after close is a safe buffer.
  var IT_VOL_SETTLE_MS = 10000;

  // Recompute the fake-breakout / volume read off SETTLED futures volume and
  // repaint the radar card + the banner's volume chip + the chart level line —
  // all from ONE computation (renderFakeBreakout), so they can never disagree.
  // Scheduled ~IT_VOL_SETTLE_MS after each bar close. Fail-safe + market-gated.
  function itRefreshBreakoutSettled(tf) {
    if (!STATE.active || !STATE.chart) return;
    if (typeof apiPaused === 'function' && apiPaused()) return;
    if (typeof isMarketOpen === 'function' && !isMarketOpen()) return;
    if (STATE.timeframe !== tf) return;                 // TF switched while waiting
    var raw = STATE.raw;
    if (!raw || raw.length < 3) return;
    try { delete FUT_STATE.volCache[tf]; } catch (_) {} // force a fresh (settled) pull
    Promise.resolve(fetchFuturesVolMap(tf)).then(function (vm) {
      if (STATE.timeframe !== tf) return;
      STATE.futVolMap = vm || {};
      try { renderFakeBreakout(STATE.raw, tf, STATE.futVolMap); } catch (_) {}
    }, function () {
      // No settled futures volume available — refresh the structural read with
      // whatever we last had so the card/banner still reflect current price.
      try { renderFakeBreakout(STATE.raw, tf, STATE.futVolMap || {}); } catch (_) {}
    });
  }

  async function pollTick() {
    if (!STATE.active || !STATE.chart) return;
    if (apiPaused()) { updateLiveBadgeAndStatus(STATE.timeframe); return; }
    // Off-hours: refresh the badge but don't burn API calls. We still do
    // ONE fetch on first activation (handled by activate) so the chart
    // shows today's close.
    if (!isMarketOpen()) { setLiveBadge('closed', 'CLOSED'); return; }
    if (STATE._ltpFetching) return;
    STATE._ltpFetching = true;
    try {
      var ltp = await fetchLtp();
      if (ltp != null) {
        patchLiveBar(ltp);
        renderLtpReadout(ltp);
        setLiveBadge('live', 'LIVE');
        // Fan out the spot tick to the intraday paper-trading book so its
        // open-position P&L, SL/TGT triggers and spot readout stay live.
        if (typeof window.itpPaperTradeTick === 'function') {
          try { window.itpPaperTradeTick(ltp); } catch (_) {}
        }
        // Drive the SELF-CONTAINED signal journal: close any OPEN virtual trade
        // whose SL/T1 the live spot just crossed (independent of the paper book).
        try { journalTick(ltp); } catch (_) {}
      }
    } finally {
      STATE._ltpFetching = false;
    }
  }

  function startPoller() {
    stopPoller();
    // First tick fires immediately so a freshly opened tab shows a live
    // price right away (or refreshes the closed badge). Subsequent ticks
    // run on the gentle cadence and self-gate on market hours.
    pollTick();
    STATE.pollTimer = setInterval(pollTick, STATE.pollMs);
  }
  function stopPoller() {
    if (STATE.pollTimer) { clearInterval(STATE.pollTimer); STATE.pollTimer = null; }
  }

  // ---- Theme: recolour the chart when the global theme flips ----
  function ensureThemeObserver() {
    if (STATE.themeObserver) return;
    try {
      STATE.themeObserver = new MutationObserver(function () {
        if (STATE.active && STATE.chart) {
          try { STATE.chart.applyOptions(chartOptions(STATE.timeframe)); } catch (_) {}
        }
      });
      STATE.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (_) {}
  }

  // ---- Public controls (window globals) ----
  window.itChartSetTf = function (tf) {
    if (!TF[tf]) return;
    renderChart(tf);
  };

  window.itChartToggleInd = function (id, el) {
    if (!(id in STATE.indVisible)) return;
    STATE.indVisible[id] = !STATE.indVisible[id];
    if (el && el.classList) el.classList.toggle('active', STATE.indVisible[id]);
    // Re-render preserving the current view so a toggle doesn't snap zoom.
    renderChart(STATE.timeframe, { preserveView: true });
  };

  window.itChartNav = function (action) {
    if (!STATE.chart) return;
    var ts = STATE.chart.timeScale();
    var bs = (ts.options && ts.options().barSpacing) || 6;
    switch (action) {
      case 'in':    ts.applyOptions({ barSpacing: bs + 2 }); break;
      case 'out':   ts.applyOptions({ barSpacing: Math.max(1, bs - 2) }); break;
      case 'left':  ts.scrollToPosition(ts.scrollPosition() - 10, false); break;
      case 'right': ts.scrollToPosition(ts.scrollPosition() + 10, false); break;
      case 'reset':
        var n = STATE.klines.length, VIS = 100;
        if (n > 1) { try { ts.setVisibleLogicalRange({ from: Math.max(0, n - VIS), to: n + 3 }); } catch (_) { ts.fitContent(); } }
        // setAutoScale(true) also clears any manual wheel price-zoom (which runs
        // with autoScale off), so reset == fresh load — same as swing.
        try { STATE.chart.priceScale('right').setAutoScale(true); } catch (_) {}
        break;
    }
  };

  // ===================================================================
  // INTRADAY CONTEXT CARDS — India VIX / Max Pain / PCR
  // ===================================================================
  // Three plain-language cards under the chart to help frame an intraday
  // trade. DISPLAY ONLY — never a buy/sell signal (per trading rules).
  //
  // Data sourcing (decided with the user):
  //   - Auto-fetch ONCE when the tab opens; a manual "Refresh" button
  //     re-pulls on demand (no background polling — keeps Upstox calls low).
  //   - Honour this tab's dedicated API-pause toggle (apiPaused → it_api_paused_v1,
  //     independent of Options) + the global 429 throttle gate + the shared
  //     rate-limiter bucket, exactly like every other fetch in this module.
  //   - VIX: one gated /historical-candle/intraday read for India VIX
  //     (mirrors intraday-analyzer.fetchVixIntraday).
  //   - Max Pain + PCR: computed from the live option chain
  //     (window.itOptionChainData), which this tab's OWN fetchChainDirect()
  //     populates. We trigger a SILENT ensureChainLoaded() only if no chain
  //     is loaded yet — no dependency on the Options tab's chain module.
  //
  // Fail-safe: any missing/stale data renders a "—" card with a clear
  // "data unavailable" note — never a guessed number.

  // One gated GET that returns Upstox candle rows (oldest→newest) or [].
  // Honours the throttle gate + shared rate-limiter exactly like the chart
  // fetch. Soft-fails to [] (never throws) so a missing feed can't break
  // the card.
  async function fetchVixCandles(url) {
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return [];
    if (window._upstoxBucket) await window._upstoxBucket.acquire();
    var token = getToken();
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    try {
      var resp = await fetch(url, { headers: headers });
      if (resp.status === 429) { if (window._upstoxNote429) window._upstoxNote429('intraday-trade-vix'); return []; }
      if (!resp.ok) return [];
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      var d = await resp.json();
      var candles = (d && d.data && d.data.candles) || [];
      return candles.slice().sort(function (a, b) {
        return new Date(a[0]).getTime() - new Date(b[0]).getTime();
      });
    } catch (_) { return []; }
  }

  // India-VIX snapshot → { current, open, high, low, changePct } or null.
  // Tries the intraday feed first (live session); on a weekend / holiday /
  // pre-open it's EMPTY, so we fall back to the daily historical feed and
  // use the LAST completed session's OHLC — so the card still shows a real
  // number off-hours (per the "handle weekends/holidays" rule) instead of a
  // permanent "unavailable". Same VIX figure the analyzer uses intraday.
  async function fetchVix() {
    if (apiPaused()) return null;
    var token = getToken();
    if (!token) return null;
    var ikey = encodeURIComponent('NSE_INDEX|India VIX');

    // 1) Live intraday 5-min bars (today). current = latest close,
    //    open = today's first open, hi/lo = today's range.
    var intra = await fetchVixCandles(V3 + '/historical-candle/intraday/' + ikey + '/minutes/5');
    if (intra.length) {
      var openVix = +intra[0][1];
      var currentVix = +intra[intra.length - 1][4];
      if (isFinite(openVix) && isFinite(currentVix)) {
        var hi = -Infinity, lo = Infinity;
        for (var i = 0; i < intra.length; i++) {
          var h = +intra[i][2], l = +intra[i][3];
          if (h > hi) hi = h;
          if (l < lo) lo = l;
        }
        return { current: currentVix, open: openVix, high: hi, low: lo,
          changePct: ((currentVix - openVix) / openVix) * 100 };
      }
    }

    // 2) Off-hours fallback — last ~10 days of daily candles; use the most
    //    recent session's OHLC. changePct is that session's open→close.
    var to = new Date(), from = new Date();
    from.setDate(to.getDate() - 10);
    var daily = await fetchVixCandles(
      V3 + '/historical-candle/' + ikey + '/days/1/' + fmtDate(to) + '/' + fmtDate(from)
    );
    if (daily.length) {
      var last = daily[daily.length - 1];           // [ts,o,h,l,c,...]
      var dOpen = +last[1], dHigh = +last[2], dLow = +last[3], dClose = +last[4];
      if (isFinite(dClose) && isFinite(dOpen)) {
        return { current: dClose, open: dOpen, high: dHigh, low: dLow,
          changePct: dOpen ? ((dClose - dOpen) / dOpen) * 100 : 0, stale: true };
      }
    }
    return null;
  }

  // Direct option-chain fetch → populates window.itOptionChainData, the
  // intraday tab's OWN chain store (deliberately NOT window.optionChainData,
  // which belongs to the Options Trading tab's liveChainModule). The new
  // intraday tab is fully self-contained: it never calls window.upFetchChain
  // and never reads the Options tab's shared chain, so the Options tab can be
  // removed without breaking intraday. On success it notifies the intraday
  // paper book (window.itpOnChainLoaded / itpUpdateLastFetch) so the strike
  // picker fills. Gated by apiPaused + the global throttle + the shared
  // rate-limiter, exactly like every other fetch here. Soft-fails silently.
  async function fetchChainDirect() {
    if (apiPaused()) return;
    var token = getToken();
    if (!token) return;
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return;
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var ikey = encodeURIComponent(INSTRUMENT_KEY);
    try {
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var ec = await fetch(V2 + '/option/contract?instrument_key=' + ikey, { headers: headers });
      if (ec.status === 429) { if (window._upstoxNote429) window._upstoxNote429('intraday-trade-chain'); return; }
      if (!ec.ok) return;
      var ed = await ec.json();
      var expiries = Array.from(new Set((ed.data || []).map(function (c) { return c.expiry; }))).filter(Boolean).sort();
      if (!expiries.length) return;
      var expiry = expiries[0];
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var cr = await fetch(V2 + '/option/chain?instrument_key=' + ikey + '&expiry_date=' + expiry, { headers: headers });
      if (cr.status === 429) { if (window._upstoxNote429) window._upstoxNote429('intraday-trade-chain'); return; }
      if (!cr.ok) return;
      var cd = await cr.json();
      var strikes = (cd && cd.data) || [];
      if (!strikes.length) return;
      strikes.sort(function (a, b) { return a.strike_price - b.strike_price; });
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      var now = Date.now();
      window.itOptionChainData = {
        symbol: 'NIFTY', expiry: expiry,
        spot: strikes[0].underlying_spot_price,
        strikes: strikes, fetchedAt: now
      };
      // Drive the intraday paper book's own callbacks (the Options tab no
      // longer feeds it — see live-chain.js). Fills the strike dropdown.
      try { if (typeof window.itpOnChainLoaded === 'function') window.itpOnChainLoaded(); } catch (_) {}
      try { if (typeof window.itpUpdateLastFetch === 'function') window.itpUpdateLastFetch(now); } catch (_) {}
      // Drive the intraday option-chain DASHBOARD (scripts/intraday-chain.js),
      // which reads the same itOptionChainData store. No-op until it loads.
      try { if (typeof window.itcOnChainLoaded === 'function') window.itcOnChainLoaded(); } catch (_) {}
    } catch (_) {}
  }

  // Ensure window.itOptionChainData (the intraday-owned store) is populated.
  // Uses ONLY this tab's own fetchChainDirect — no dependency on the Options
  // tab's window.upFetchChain. `force` re-pulls even when a chain is cached.
  async function ensureChainLoaded(force) {
    var have = function () {
      return window.itOptionChainData && window.itOptionChainData.strikes && window.itOptionChainData.strikes.length;
    };
    if (have() && !force) return;
    if (apiPaused()) return;
    try { await fetchChainDirect(); } catch (_) {}
  }

  // Compute PCR + Max Pain (+ walls) from the live option chain. Same math
  // as intraday-analyzer.readOptionChainSnapshot — kept in lockstep so the
  // numbers match the analyzer tab. Returns null if no chain is loaded.
  function computeChainSnapshot() {
    try {
      var chain = window.itOptionChainData;
      if (!chain || !chain.strikes || !chain.strikes.length) return null;
      var totCE = 0, totPE = 0;
      chain.strikes.forEach(function (s) {
        if (s.call_options && s.call_options.market_data) totCE += (s.call_options.market_data.oi || 0);
        if (s.put_options && s.put_options.market_data) totPE += (s.put_options.market_data.oi || 0);
      });
      // PCR = total PUT OI ÷ total CALL OI across the chain — the standard
      // definition. We deliberately do NOT use Upstox's per-strike `pcr`
      // field: it's the ratio AT a single strike (e.g. strikes[0], the
      // lowest), not a chain-wide number, so reading it yields nonsense
      // (saw ~51450 once). Compute it from the OI totals instead.
      var pcr = (totCE > 0) ? totPE / totCE : null;
      if (pcr == null || !isFinite(pcr)) return null;
      // Max-pain: strike minimising total option-buyer payout at expiry.
      var strikes = chain.strikes.slice().sort(function (a, b) { return a.strike_price - b.strike_price; });
      var maxPain = null, minLoss = Infinity;
      for (var i = 0; i < strikes.length; i++) {
        var K = strikes[i].strike_price, loss = 0;
        for (var j = 0; j < strikes.length; j++) {
          var Kj = strikes[j].strike_price;
          var ce = strikes[j].call_options && strikes[j].call_options.market_data ? (strikes[j].call_options.market_data.oi || 0) : 0;
          var pe = strikes[j].put_options && strikes[j].put_options.market_data ? (strikes[j].put_options.market_data.oi || 0) : 0;
          if (K > Kj) loss += ce * (K - Kj);
          if (K < Kj) loss += pe * (Kj - K);
        }
        if (loss < minLoss) { minLoss = loss; maxPain = K; }
      }
      return {
        pcr: pcr,
        maxPain: maxPain,
        spot: (chain.spot != null && isFinite(chain.spot)) ? chain.spot : null,
        expiry: chain.expiry || null,
        totCE: totCE,
        totPE: totPE
      };
    } catch (_) { return null; }
  }

  // ---- small render helpers ----
  function fmtNum(n, dp) { return (n == null || !isFinite(n)) ? '\u2014' : Number(n).toFixed(dp == null ? 0 : dp); }
  // Compact OI formatter — crores / lakhs, matching the Options-tab chain
  // stats (live-chain.compactCr) so the numbers read the same across tabs.
  function fmtCr(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    var a = Math.abs(n);
    if (a >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
    if (a >= 1e5) return (n / 1e5).toFixed(2) + 'L';
    return Math.round(n).toLocaleString('en-IN');
  }
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Theme-aware info icon (inherits the app theme via currentColor — no
  // hardcoded colour). Feather "info" glyph; the actual tooltip text is the
  // native title/aria-label so it stays accessible without extra JS.
  var INFO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="10"></circle>'
    + '<line x1="12" y1="16" x2="12" y2="12"></line>'
    + '<line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';

  // value/sub/reason → one card. tone ∈ bull|bear|neutral|na drives the accent.
  // The info icon shows a THEME-STYLED tooltip bubble (.it-card-tip) on
  // hover/focus — not the native browser title — so it matches dark/light and
  // can hold full multi-line detail. aria-label keeps it accessible.
  function cardHtml(opts) {
    var tip = escAttr(opts.tip || '');
    var info = opts.tip
      ? '<span class="it-card-info" tabindex="0" role="button" aria-label="' + tip + '">'
        + INFO_ICON + '<span class="it-card-tip" role="tooltip">' + tip + '</span></span>'
      : '';
    return ''
      + '<div class="it-card it-card--' + (opts.tone || 'na') + '">'
      +   '<div class="it-card-head">'
      +     '<span class="it-card-label">' + escAttr(opts.label) + '</span>'
      +     info
      +   '</div>'
      +   '<div class="it-card-value">' + (opts.value == null ? '\u2014' : escAttr(opts.value)) + '</div>'
      +   (opts.sub ? '<div class="it-card-sub">' + escAttr(opts.sub) + '</div>' : '')
      +   '<div class="it-card-reason">' + escAttr(opts.reason || '') + '</div>'
      + '</div>';
  }

  // Loading skeleton for one card — a theme-aware spinner (.it-spinner reuses
  // the chart loader's --bd / --info tokens, so it follows dark/light).
  function loadingCardHtml(label) {
    return ''
      + '<div class="it-card it-card--na">'
      +   '<div class="it-card-head"><span class="it-card-label">' + escAttr(label) + '</span></div>'
      +   '<div class="it-card-loader"><span class="it-spinner"></span><span>Loading\u2026</span></div>'
      + '</div>';
  }

  function renderCards() {
    var grid = $('it-cards-grid');
    if (!grid) return;
    var c = STATE.cards;

    if (c.loading) {
      grid.innerHTML = loadingCardHtml('India VIX') + loadingCardHtml('Max Pain') + loadingCardHtml('PCR')
        + loadingCardHtml('OI Bias') + loadingCardHtml('Total Call OI') + loadingCardHtml('Total Put OI');
      setText('it-cards-meta', 'Fetching\u2026');
      return;
    }

    // ── VIX card ──
    var vixTip = 'India VIX is the market\u2019s \u201Cfear gauge\u201D \u2014 how much movement traders expect in the Nifty over the next 30 days. '
      + 'High (>20): big swings expected, options are expensive and price whips around \u2014 trade smaller, wider stops. '
      + 'Normal (13\u201316): orderly, trend-friendly. '
      + 'Low (<13): calm, options are cheap but moves are small. '
      + 'It does not say up or down \u2014 only how wild.';
    var vixCard;
    if (c.vix && isFinite(c.vix.current)) {
      var v = c.vix.current, chg = c.vix.changePct;
      var vixTone, vixReason;
      if (v < 12) { vixTone = 'neutral'; vixReason = 'Very low volatility \u2014 calm market, option premiums move little. Favour tight scalps and don\u2019t overpay for options.'; }
      else if (v < 15) { vixTone = 'bull'; vixReason = 'Low\u2013normal volatility \u2014 orderly conditions, good for clean trend trades.'; }
      else if (v < 20) { vixTone = 'neutral'; vixReason = 'Elevated volatility \u2014 moves are bigger; size down and widen stops a little.'; }
      else { vixTone = 'bear'; vixReason = 'High volatility \u2014 choppy and whippy. Risky for option buyers; trade small or wait.'; }
      var chgWord = (chg >= 5) ? ' VIX rising fast vs open \u2014 fear building, expect sharp moves.'
        : (chg <= -5) ? ' VIX cooling vs open \u2014 sentiment stabilising.' : '';
      vixCard = cardHtml({
        label: 'India VIX', tone: vixTone, tip: vixTip,
        value: fmtNum(v, 2),
        sub: (chg >= 0 ? '+' : '') + fmtNum(chg, 1) + '% vs open',
        reason: vixReason + chgWord
      });
    } else {
      vixCard = cardHtml({ label: 'India VIX', tone: 'na', tip: vixTip, value: '\u2014',
        reason: apiPaused() ? 'API paused \u2014 resume to load VIX.' : 'VIX unavailable \u2014 needs a valid token / market data. Try Refresh.' });
    }

    // ── Max Pain + PCR cards (option chain) ──
    var mpTip = 'Max Pain is the strike where option BUYERS would lose the most money at expiry. '
      + 'Because the big players who SELL (write) options defend their positions, price often drifts toward this strike as expiry nears. '
      + 'If spot is ABOVE max pain there\u2019s a downward pull toward it; if BELOW, an upward pull. '
      + 'This pull is strongest on expiry day and weak early in the week. Use it as context, not a trigger.';
    var pcrTip = 'PCR (Put/Call Ratio) = total PUT open interest \u00F7 total CALL open interest across the chain. '
      + 'In India the big players mostly WRITE (sell) options, so: '
      + 'High PCR (>1.3) = heavy put-writing \u2014 they expect support to hold \u2192 bullish positioning. '
      + 'Low PCR (<0.7) = heavy call-writing \u2014 they expect a ceiling \u2192 bearish positioning. '
      + '0.7\u20131.3 = balanced. Extremes (>1.7 or <0.5) are stretched and can snap back.';
    var mpCard, pcrCard;
    var snap = c.chain;
    var spot = (snap && snap.spot != null) ? snap.spot
      : (isFinite(STATE.lastClose) ? STATE.lastClose : null);

    if (snap && isFinite(snap.maxPain)) {
      var mp = snap.maxPain;
      var mpTone, mpReason, mpSub;
      if (spot != null && isFinite(spot)) {
        var diff = spot - mp;
        var diffPct = Math.abs(diff) / spot * 100;
        mpSub = 'Spot ' + fmtNum(spot, 0) + ' \u00B7 ' + (diff >= 0 ? '+' : '') + fmtNum(diff, 0) + ' pts';
        if (diffPct < 0.1) { mpTone = 'neutral'; mpReason = 'Spot is sitting right at max pain \u2014 little expiry pull either way; trade the chart, not this.'; }
        else if (diff > 0) { mpTone = 'bear'; mpReason = 'Spot is ABOVE max pain \u2014 near expiry there\u2019s a gravitational pull DOWN toward ' + fmtNum(mp, 0) + '. Be cautious chasing longs into expiry.'; }
        else { mpTone = 'bull'; mpReason = 'Spot is BELOW max pain \u2014 near expiry there\u2019s a pull UP toward ' + fmtNum(mp, 0) + '. Dips may get bought into expiry.'; }
      } else {
        mpTone = 'neutral'; mpSub = snap.expiry ? ('Expiry ' + snap.expiry) : '';
        mpReason = 'Price tends to drift toward this strike near expiry.';
      }
      mpCard = cardHtml({ label: 'Max Pain', tone: mpTone, tip: mpTip, value: fmtNum(mp, 0), sub: mpSub, reason: mpReason });
    } else {
      mpCard = cardHtml({ label: 'Max Pain', tone: 'na', tip: mpTip, value: '\u2014',
        reason: apiPaused() ? 'API paused \u2014 resume to load the option chain.' : 'Option chain not loaded \u2014 hit Refresh (or open the Options tab) to compute it.' });
    }

    if (snap && isFinite(snap.pcr)) {
      var p = snap.pcr, pcrTone, pcrReason;
      if (p >= 1.7) { pcrTone = 'neutral'; pcrReason = 'PCR very high \u2014 extreme put-writing. Usually bullish, but stretched: watch for an overdue snap-back.'; }
      else if (p > 1.3) { pcrTone = 'bull'; pcrReason = 'High PCR \u2014 heavy put-writing means institutions are defending the downside (bullish positioning).'; }
      else if (p >= 0.7) { pcrTone = 'neutral'; pcrReason = 'PCR balanced \u2014 no clear positioning bias. Let price/structure lead the trade.'; }
      else if (p > 0.5) { pcrTone = 'bear'; pcrReason = 'Low PCR \u2014 heavy call-writing means institutions are capping the upside (bearish positioning).'; }
      else { pcrTone = 'neutral'; pcrReason = 'PCR very low \u2014 extreme call-writing. Usually bearish, but stretched: watch for a short-covering bounce.'; }
      pcrCard = cardHtml({ label: 'PCR', tone: pcrTone, tip: pcrTip, value: fmtNum(p, 2),
        sub: snap.expiry ? ('Expiry ' + snap.expiry) : '', reason: pcrReason });
    } else {
      pcrCard = cardHtml({ label: 'PCR', tone: 'na', tip: pcrTip, value: '\u2014',
        reason: apiPaused() ? 'API paused \u2014 resume to load the option chain.' : 'Option chain not loaded \u2014 hit Refresh (or open the Options tab) to compute it.' });
    }

    // ── OI structure cards (option chain): OI Bias / Total Call OI / Total Put OI ──
    // OI context (AGENTS §9): Call OI = resistance / ceiling (bear/red),
    // Put OI = support / floor (bull/green). Bias > +8% put-heavy = bullish,
    // < −8% call-heavy = bearish, else balanced. Same math as live-chain.js.
    var biasTip = '(Put OI \u2212 Call OI) \u00F7 total OI across the chain. '
      + 'Positive = put-heavy book \u2014 writers expect a floor to hold (bullish positioning). '
      + 'Negative = call-heavy book \u2014 writers expect a ceiling (bearish positioning). '
      + 'Within \u00B18% = balanced. Context only, not a trigger.';
    var callOiTip = 'Sum of all open CALL contracts across every strike. '
      + 'Calls are written (sold) at resistance, so a large call book marks the ceiling side \u2014 the more call OI, the heavier the overhead supply.';
    var putOiTip = 'Sum of all open PUT contracts across every strike. '
      + 'Puts are written (sold) at support, so a large put book marks the floor side \u2014 the more put OI, the stronger the cushion below.';
    var biasCard, callOiCard, putOiCard;
    if (snap && isFinite(snap.totCE) && isFinite(snap.totPE) && (snap.totCE + snap.totPE) > 0) {
      var oiBiasPct = (snap.totPE - snap.totCE) / (snap.totCE + snap.totPE) * 100;
      var biasTone, biasSub, biasReason;
      if (oiBiasPct > 8) { biasTone = 'bull'; biasSub = 'Put-heavy \u00B7 bullish'; biasReason = 'Put-heavy book \u2014 writers are defending the downside, a bullish lean. Favour dips toward support over chasing breakdowns.'; }
      else if (oiBiasPct < -8) { biasTone = 'bear'; biasSub = 'Call-heavy \u00B7 bearish'; biasReason = 'Call-heavy book \u2014 writers are capping the upside, a bearish lean. Rallies into resistance may get sold.'; }
      else { biasTone = 'neutral'; biasSub = 'Balanced'; biasReason = 'OI book is balanced \u2014 no clear writer lean. Let price and structure lead the trade.'; }
      biasCard = cardHtml({ label: 'OI Bias', tone: biasTone, tip: biasTip,
        value: (oiBiasPct >= 0 ? '+' : '') + oiBiasPct.toFixed(1) + '%', sub: biasSub, reason: biasReason });
      callOiCard = cardHtml({ label: 'Total Call OI', tone: 'bear', tip: callOiTip,
        value: fmtCr(snap.totCE), sub: 'resistance side \u00B7 all strikes',
        reason: 'Total open call interest \u2014 the overhead supply. Heavy call OI marks the ceiling the index must clear.' });
      putOiCard = cardHtml({ label: 'Total Put OI', tone: 'bull', tip: putOiTip,
        value: fmtCr(snap.totPE), sub: 'support side \u00B7 all strikes',
        reason: 'Total open put interest \u2014 the cushion below. Heavy put OI marks the floor that tends to hold dips.' });
    } else {
      var oiNa = apiPaused() ? 'API paused \u2014 resume to load the option chain.' : 'Option chain not loaded \u2014 hit Refresh (or open the Options tab) to compute it.';
      biasCard = cardHtml({ label: 'OI Bias', tone: 'na', tip: biasTip, value: '\u2014', reason: oiNa });
      callOiCard = cardHtml({ label: 'Total Call OI', tone: 'na', tip: callOiTip, value: '\u2014', reason: oiNa });
      putOiCard = cardHtml({ label: 'Total Put OI', tone: 'na', tip: putOiTip, value: '\u2014', reason: oiNa });
    }

    grid.innerHTML = vixCard + mpCard + pcrCard + biasCard + callOiCard + putOiCard;

    // Meta line: freshness + a not-for-signal reminder.
    var metaBits = [];
    if (c.lastAt) {
      var ist = new Date(c.lastAt + IST_OFF_SEC * 1000);
      metaBits.push('Updated ' + String(ist.getUTCHours()).padStart(2, '0') + ':' + String(ist.getUTCMinutes()).padStart(2, '0') + ' IST');
    }
    if (!isMarketOpen()) metaBits.push('market closed \u2014 last session\u2019s data');
    setText('it-cards-meta', metaBits.join(' \u00B7 '));
  }

  // Orchestrate a single load (VIX + chain) then render. `force` re-pulls
  // the chain even when one is already cached (manual Refresh).
  async function loadCards(force) {
    var box = $('it-cards');
    if (!getToken()) { if (box) box.hidden = true; return; }
    if (box) box.hidden = false;

    var seq = ++STATE.cards.loadSeq;
    STATE.cards.loading = true;
    renderCards();

    var btn = $('it-cards-refresh');
    if (btn) btn.disabled = true;

    var vix = null;
    try { vix = await fetchVix(); } catch (_) {}
    try { await ensureChainLoaded(force); } catch (_) {}

    // A newer load (rapid refresh / TF churn) superseded us — bail without
    // clobbering its result.
    if (seq !== STATE.cards.loadSeq) return;

    STATE.cards.vix = vix;
    STATE.cards.chain = computeChainSnapshot();
    STATE.cards.loading = false;
    STATE.cards.lastAt = Date.now();
    if (btn) btn.disabled = false;
    renderCards();
  }

  // ═══════════════════════════════════════════════════════════════
  // INTRADAY SETUP PLAN + TRADE PLAN (1H / 30m / 15m / 5m)
  // ═══════════════════════════════════════════════════════════════
  // The intraday sibling of the Swing Analyzer's Setup Plan. Two parts:
  //   (1) SETUP PLAN — a per-TF trend read on 1H / 30m / 15m / 5m + a single
  //       conservative RECOMMENDATION.
  //   (2) SETUP TRADE PLAN — entry zone / stop / T1 / T2 in SPOT (index) points.
  //
  // Design rules (real money — accuracy beats coverage, per trading-context):
  //   • LONG-ONLY. A bearish or conflicted higher-timeframe read resolves to
  //     WAIT, never a speculative short. (Mirrors the BUY-framed reference card;
  //     PE/short signals live in the Options-Trading tab.)
  //   • NON-REPAINTING. Trend comes from CONFIRMED swing structure (the same
  //     detectStructureBreaks the chart's BOS overlay uses); plan levels come
  //     from the previous session + closed-bar structure (CPR / PDH-PDL / VWAP /
  //     Fib / zones). Spot location uses the confirmed last close.
  //   • LEAN TO WAIT. The verdict starts as a BUY candidate ONLY when 1H AND 30m
  //     both trend up; every gate below can only DEMOTE it (→ WATCH / WAIT),
  //     never upgrade. A marginal setup is suppressed, not surfaced.
  //   • SESSION-AWARE. No fresh BUY pre-open, in the first 5 min, after 14:45
  //     IST, or when the market is closed.
  var IT_SETUP_TFS = ['1h', '30m', '15m', '5m'];
  // Trend key → display. STRONG_* requires ADX ≥ 25 on that TF (Wilder ADX; 25
  // is the textbook "trending vs ranging" line). Colours reuse the swing badge.
  var IT_TREND_VIEW = {
    STRONG_BULL: { label: 'STRONG UP',   dir: 'UP',   cls: 'it-tr-bull', arrow: '\u25B2' },
    BULL:        { label: 'UP',          dir: 'UP',   cls: 'it-tr-bull', arrow: '\u25B2' },
    NEUTRAL:     { label: 'RANGING',     dir: 'FLAT', cls: 'it-tr-range', arrow: '\u25C6' },
    BEAR:        { label: 'DOWN',        dir: 'DOWN', cls: 'it-tr-bear', arrow: '\u25BC' },
    STRONG_BEAR: { label: 'STRONG DOWN', dir: 'DOWN', cls: 'it-tr-bear', arrow: '\u25BC' }
  };
  function r05(v) { return Math.round(v / 0.05) * 0.05; }   // Nifty tick-size rounding (display/levels)

  // Per-TF trend classifier — a compact, browser-safe mirror of the swing
  // analyzer's analyzeTf trend logic (analyzeTf is only exposed under the Node
  // backtest harness, never in the browser). Trend = recent CONFIRMED swing
  // structure (window.detectStructureBreaks + recentSwingTrend) with ADX picking
  // STRONG vs plain; an EMA-stack fallback covers the rare no-structure case.
  // `raw` ascending. Returns null when there aren't enough bars to read honestly.
  function classifyTfTrend(raw, tf) {
    if (!raw || raw.length < 30) return null;
    var asc = raw.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var closes = asc.map(function (c) { return +c[4]; });
    var n = closes.length;
    var lc = closes[n - 1];                                   // confirmed last close
    var lastAdx = null;
    try { var dx = IM().adx ? IM().adx(asc, 14) : []; if (dx && dx.length) lastAdx = +dx[dx.length - 1]; } catch (_) {}
    var strongAdx = (lastAdx != null && isFinite(lastAdx) && lastAdx >= 25);
    var recentTrend = null;
    try {
      if (typeof window.detectStructureBreaks === 'function' && typeof window.recentSwingTrend === 'function') {
        var pivot = (window.BOS_PIVOT_BY_TF && window.BOS_PIVOT_BY_TF[tf]) || 5;
        recentTrend = window.recentSwingTrend(window.detectStructureBreaks(asc.slice().reverse(), { pivot: pivot }));
      }
    } catch (_) { recentTrend = null; }
    // 20/50 EMA stack on confirmed closes — the "fast structure" read. Used both
    // as the no-structure fallback AND as the corroborating signal for the VWAP
    // flip below (so we never flip the trend on a lone VWAP cross).
    var e20a = IM().ema ? IM().ema(closes, 20) : [];
    var e50a = IM().ema ? IM().ema(closes, 50) : [];
    var e20 = e20a.length ? e20a[n - 1] : null, e50 = e50a.length ? e50a[n - 1] : null;
    var emaStacked = (e20 != null && e50 != null && isFinite(e20) && isFinite(e50));
    var emaUp = emaStacked && lc > e20 && e20 > e50;     // bullish stack: price > 20 > 50
    var emaDn = emaStacked && lc < e20 && e20 < e50;     // bearish stack: price < 20 < 50
    var trend = 'NEUTRAL', basis = 'mixed swings';
    if (recentTrend === 'BULLISH')      { trend = strongAdx ? 'STRONG_BULL' : 'BULL'; basis = 'Higher highs & lows'; }
    else if (recentTrend === 'BEARISH') { trend = strongAdx ? 'STRONG_BEAR' : 'BEAR'; basis = 'Lower highs & lows'; }
    else {
      // No clear swing structure → fall back to the 20/50 EMA stack.
      if (emaUp)      { trend = 'BULL'; basis = 'Above 20 & 50 EMA'; }
      else if (emaDn) { trend = 'BEAR'; basis = 'Below 20 & 50 EMA'; }
    }
    // ── Stale-trend VETO via SESSION VWAP (applies to EVERY read above) ──
    // The structure / EMA / ADX reads all span MULTIPLE sessions, so after a gap
    // they keep reporting the prior multi-day trend even while TODAY's tape has
    // already reversed — e.g. a gap DOWN that rallies back above fair value still
    // reads STRONG_BEAR off the week-long down leg (the exact bug: 5m "STRONG
    // DOWN ADX 36" while price prints higher candles off the open low). Session
    // VWAP RESETS each IST day (see buildVwap) so it is NOT dragged across the
    // gap — it is the honest "where is fair value TODAY" line. If the computed
    // trend direction FIGHTS the side of VWAP that price is on, the read is stale.
    // RESOLUTION (2026-06-08, user-approved): if the 20/50 EMA stack — a CONFIRMED
    // fast-structure read — ALSO agrees with the VWAP side, the trend has genuinely
    // turned, so FLIP to that side (plain BULL/BEAR; a fresh reversal hasn't earned
    // STRONG). If VWAP disagrees but the EMA stack has NOT turned (e.g. a tiny
    // contained bounce above VWAP while EMAs stay down), DEMOTE to NEUTRAL as before
    // — we still refuse to lean on a lone VWAP cross. Non-repainting throughout (EMA
    // + VWAP read the confirmed last close). Keep the raw read if VWAP is missing.
    var vwapNow = null;
    // Use the TRUE (futures-volume-weighted) VWAP when this TF is the one the
    // chart loaded a futures-volume map for; otherwise the typical-price mean
    // (still a valid "fair value today" anchor for the veto). Never weaker than before.
    var vwVol = (tf === STATE.timeframe) ? STATE.futVolMap : null;
    try { var vwSeries = buildVwap(asc, tf, vwVol); if (vwSeries && vwSeries.length) vwapNow = +vwSeries[vwSeries.length - 1].value; } catch (_) {}
    if (vwapNow != null && isFinite(vwapNow)) {
      var bearish = (trend === 'BEAR' || trend === 'STRONG_BEAR');
      var bullish = (trend === 'BULL' || trend === 'STRONG_BULL');
      if (bearish && lc > vwapNow) {
        if (emaUp) { trend = 'BULL'; basis = 'Reclaimed VWAP + 20/50 EMA flipped up \u2014 trend turned'; }
        else       { trend = 'NEUTRAL'; basis = 'Reclaimed VWAP \u2014 down-trend stale'; }
      } else if (bullish && lc < vwapNow) {
        if (emaDn) { trend = 'BEAR'; basis = 'Lost VWAP + 20/50 EMA flipped down \u2014 trend turned'; }
        else       { trend = 'NEUTRAL'; basis = 'Lost VWAP \u2014 up-trend stale'; }
      }
    }
    if (lastAdx != null && isFinite(lastAdx)) basis += ' \u00B7 ADX ' + lastAdx.toFixed(0);
    return { trend: trend, dir: IT_TREND_VIEW[trend].dir, adx: lastAdx, basis: basis };
  }

  // Collect spot S/R candidates for the LONG plan from the levels the tab
  // already computes (single source of truth with the chart overlays): CPR,
  // previous-day OHLC, session VWAP, the intraday Fib pocket, and detected
  // demand/supply zones. Dedupes near-equal levels (within 0.1·ATR) keeping the
  // first (highest-priority) label. `raw5`/`raw15` ascending.
  function itCollectLevels(raw5, raw15, spot) {
    var atr15 = null;
    try { var a = IM().atr ? IM().atr(raw15, 14) : []; if (a && a.length) atr15 = +a[a.length - 1]; } catch (_) {}
    if (!isFinite(atr15) || atr15 <= 0) atr15 = (isFinite(spot) ? spot * 0.0015 : 10);  // ~0.15% fallback
    // 5m ATR — the SCALP yardstick for SL/target geometry (itBuildDirPlan). The
    // 15m ATR above stays as the structural scale used for level de-duping.
    var atr5 = null;
    try { var a5 = IM().atr ? IM().atr(raw5, 14) : []; if (a5 && a5.length) atr5 = +a5[a5.length - 1]; } catch (_) {}
    if (!isFinite(atr5) || atr5 <= 0) atr5 = (isFinite(spot) ? spot * 0.0008 : 6);       // ~0.08% fallback
    var supports = [], resists = [];
    function addS(px, label) { if (isFinite(px) && px <= spot + atr15 * 0.1) supports.push({ px: px, label: label }); }
    function addR(px, label) { if (isFinite(px) && px >= spot - atr15 * 0.1) resists.push({ px: px, label: label }); }
    // CPR + prev-day (the heavyweight intraday levels).
    var cpr = null; try { cpr = buildCpr(raw5); } catch (_) {}
    if (cpr && cpr.levels) {
      var L = cpr.levels;
      addS(L.P, 'CPR Pivot'); addS(L.BC, 'CPR BC'); addS(L.S1, 'CPR S1'); addS(L.S2, 'CPR S2');
      addR(L.P, 'CPR Pivot'); addR(L.TC, 'CPR TC'); addR(L.R1, 'CPR R1'); addR(L.R2, 'CPR R2');
    }
    var pdo = null; try { pdo = computePrevDayOHLC(raw5); } catch (_) {}
    if (pdo) { addS(pdo.low, 'PDL'); addS(pdo.close, 'PDC'); addR(pdo.high, 'PDH'); addR(pdo.close, 'PDC'); }
    // Session VWAP (fair value).
    try {
      var vw = buildVwap(raw5, '5m', STATE.timeframe === '5m' ? STATE.futVolMap : null);
      if (vw && vw.length) { var vwv = vw[vw.length - 1].value; addS(vwv, 'VWAP'); addR(vwv, 'VWAP'); }
    } catch (_) {}
    // Intraday Fib pocket + leg extremes.
    try {
      var fb = computeIntradayFib(raw5.slice().reverse(), '5m');
      if (fb && !fb.building && isFinite(fb.swHigh) && isFinite(fb.swLow)) {
        addS(fb.pocketHiPx, 'Fib 38.2%'); addS(fb.pocketLoPx, 'Fib 61.8%'); addS(fb.swLow, 'Leg low');
        addR(fb.swHigh, 'Leg high');
      }
    } catch (_) {}
    // Demand (support) / supply (resistance) zones.
    try {
      var zones = detectZones(raw5) || [];
      for (var z = 0; z < zones.length; z++) {
        var zo = zones[z];
        if (zo.type === 'DEMAND') addS(Math.max(zo.top, zo.bottom), 'Demand zone');
        else if (zo.type === 'SUPPLY') addR(Math.min(zo.top, zo.bottom), 'Supply zone');
      }
    } catch (_) {}
    // 15m recent swing low / high (structural stop references for CE / PE).
    try {
      var sl = IM().swingLows ? IM().swingLows(raw15, 3) : [];
      if (sl && sl.length) addS(sl[sl.length - 1].price, 'Swing low');
    } catch (_) {}
    try {
      var sh = IM().swingHighs ? IM().swingHighs(raw15, 3) : [];
      if (sh && sh.length) addR(sh[sh.length - 1].price, 'Swing high');
    } catch (_) {}
    function dedupe(arr, desc) {
      arr.sort(function (a, b) { return desc ? b.px - a.px : a.px - b.px; });
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var dup = false;
        for (var j = 0; j < out.length; j++) { if (Math.abs(out[j].px - arr[i].px) < atr15 * 0.1) { dup = true; break; } }
        if (!dup) out.push(arr[i]);
      }
      return out;
    }
    return { atr15: atr15, atr5: atr5, supports: dedupe(supports, true), resists: dedupe(resists, false), cpr: cpr };
  }

  // Build a directional spot trade plan from the collected levels — SCALP-SIZED.
  //   dir = +1  → CE (buy call / bullish): anchor on a SUPPORT at/below spot.
  //   dir = -1  → PE (buy put / bearish):  anchor on a RESISTANCE at/above spot.
  // ENTRY anchors on the nearest structural level (a real magnet to time the
  // entry), but SL/TARGETS are sized from the 5m ATR + the expected move over the
  // scalp horizon — NOT from far day-levels (CPR S2 / PDL / 15m swings), which
  // produced 200-400+ pt stops/targets unreachable in a ≤30-min option scalp.
  //   • risk  = 0.7 × ATR(5m), TIGHTENED (never widened) to a nearby 5m micro-swing
  //   • T1    = 1.5 × risk, capped at 0.8 × expected-move(horizon)
  //   • T2    = 2.5 × risk, capped at the full expected-move(horizon)
  // The two paths are exact mirrors. Levels are SPOT (index) points. Returns null
  // when there's no level to anchor the entry on.
  function itBuildDirPlan(dir, lv, spot) {
    var atr = lv.atr15;                                                  // structural scale (context)
    var atr5 = (lv.atr5 && isFinite(lv.atr5) && lv.atr5 > 0) ? lv.atr5 : atr;   // scalp yardstick
    var anchorList = dir > 0 ? lv.supports : lv.resists;   // supports desc, resists asc (nearest-to-spot first)
    var stopLabel = dir > 0 ? 'Swing low' : 'Swing high';
    var anchor = null;
    for (var i = 0; i < anchorList.length; i++) {
      if (dir > 0 ? (anchorList[i].px <= spot) : (anchorList[i].px >= spot)) { anchor = anchorList[i]; break; }
    }
    if (!anchor) return null;
    var entryRef = anchor.px;
    var dist = dir > 0 ? (spot - entryRef) : (entryRef - spot);   // how far price sits from the anchor
    // Entry zone — scalp-tight (5m ATR), not the wider structural band.
    var entryLo, entryHi;
    if (dir > 0) { entryLo = r05(entryRef - atr5 * 0.20); entryHi = r05(entryRef + atr5 * 0.10); }
    else { entryHi = r05(entryRef + atr5 * 0.20); entryLo = r05(entryRef - atr5 * 0.10); }

    // ── Expected move over the scalp horizon (√time scaling of the 5m ATR) ──
    // Six 5m bars in 30 min → EM ≈ ATR5 × √6 ≈ 2.45 × ATR5. Targets capped to this
    // so a ≤30-min scalp is never handed a target it can't physically reach.
    var bars = Math.max(1, SCALP_HORIZON_MIN / 5);
    var em = atr5 * Math.sqrt(bars);

    // ── Risk = a fraction of the 5m ATR, TIGHTENED to a nearby micro-swing ──
    var risk = atr5 * 0.7;
    var structPx = null;
    for (var s = 0; s < anchorList.length; s++) {
      if (anchorList[s].label !== stopLabel) continue;
      if (dir > 0 && anchorList[s].px < entryRef) { structPx = anchorList[s].px; break; }
      if (dir < 0 && anchorList[s].px > entryRef) { structPx = anchorList[s].px; break; }
    }
    if (structPx != null) {
      var structRisk = dir > 0 ? (entryRef - (structPx - atr5 * 0.10)) : ((structPx + atr5 * 0.10) - entryRef);
      if (structRisk > 0 && structRisk < risk) risk = structRisk;   // only ever TIGHTEN, never widen
    }
    // Clamp to a scalp band [0.4, 1.0] × ATR5 so the stop is always scalp-sized.
    risk = Math.max(atr5 * 0.4, Math.min(risk, atr5 * 1.0));
    var sl = r05(dir > 0 ? entryRef - risk : entryRef + risk);
    risk = dir > 0 ? (entryRef - sl) : (sl - entryRef);
    if (!(risk > 0)) { sl = r05(dir > 0 ? entryRef - atr5 * 0.7 : entryRef + atr5 * 0.7); risk = Math.abs(entryRef - sl); }

    // ── Targets: R-multiples capped by the expected move (reachable in horizon) ──
    var t1d = Math.min(1.5 * risk, 0.8 * em);
    if (t1d < 1.2 * risk) t1d = 1.2 * risk;                 // EM cap must not crush R:R below ~1.2
    var t2d = Math.min(2.5 * risk, em);
    if (t2d <= t1d) t2d = t1d + Math.max(atr5 * 0.5, 0.5 * risk);
    var t1 = r05(dir > 0 ? entryRef + t1d : entryRef - t1d);
    var t2 = r05(dir > 0 ? entryRef + t2d : entryRef - t2d);
    var rr1 = (dir > 0 ? (t1 - entryRef) : (entryRef - t1)) / risk;
    var rr2 = (dir > 0 ? (t2 - entryRef) : (entryRef - t2)) / risk;
    return {
      entryRef: entryRef, entryLo: entryLo, entryHi: entryHi, anchorLabel: anchor.label,
      sl: sl, risk: risk, t1: t1, t1lbl: rr1.toFixed(1) + 'R', t2: t2, t2lbl: rr2.toFixed(1) + 'R',
      rr1: rr1, rr2: rr2,
      atr: atr, atr5: atr5, em: em, dist: dist,
      // "Extended" = price already more than one expected-move past the entry
      // anchor → you've missed the scalp; wait for a pullback (demotes BUY→WATCH).
      extended: dist > em, atZone: dist <= atr5 * 0.5
    };
  }

  // ── Two-stage scalp model: BIAS (higher TFs) → TRIGGER (5m) ──────────────
  // The slow part of the engine is the 5m direction read: a swing pivot needs 5
  // confirmed bars on BOTH sides, so the latest 5m swing is only recognised ~25
  // min after it happens — almost the whole 30-min scalp. To stop missing scalps
  // we split the decision in two, exactly how a discretionary scalper works:
  //   1) BIAS — which side you're ALLOWED to trade — comes from the higher
  //      timeframes (15m lead, confirmed by 30m + 1H). Stable, slow-moving.
  //   2) TRIGGER — WHEN to actually enter — is a FRESH 5m structure break
  //      (CHoCH/BOS) in the bias direction. This fires on the breaking close, so
  //      it's caught immediately instead of waiting for the slow two-swing flip.
  // We NEVER enter against the 5m: if the 5m points opposite the bias, we stay
  // flat. This adds coverage (trend-aligned scalps that used to read WAIT) WITHOUT
  // loosening any quality gate — the plan still passes R:R / extended / chop / CPR.

  // Higher-timeframe BIAS — the "context" half of the top-down model: the higher
  // TFs decide the DIRECTION, the 5m only times the entry. A clean lean needs a
  // majority of {15m,30m,1H} on one side and ZERO opposition (no higher TF may
  // point the other way — still conservative). The lean must be intraday-relevant,
  // so it requires EITHER the 15m to lead OR (when the 15m is mid-pullback / flat)
  // the 30m AND 1H to BOTH agree — that is the classic "15m consolidating inside a
  // 30m/1H trend" pullback, which an experienced trader trades WITH the bigger
  // trend rather than sitting out. Returns 'CE' | 'PE' | null.
  function itHtfBias(t15, t30, t1h) {
    var arr = [t15, t30, t1h].filter(Boolean);
    if (arr.length < 2) return null;
    var up = 0, dn = 0;
    arr.forEach(function (t) { if (t.dir === 'UP') up++; else if (t.dir === 'DOWN') dn++; });
    var d15 = t15 && t15.dir, d30 = t30 && t30.dir, d1h = t1h && t1h.dir;
    if (dn >= 2 && up === 0 && (d15 === 'DOWN' || (d30 === 'DOWN' && d1h === 'DOWN'))) return 'PE';
    if (up >= 2 && dn === 0 && (d15 === 'UP' || (d30 === 'UP' && d1h === 'UP'))) return 'CE';
    return null;
  }

  // Fast 5m ENTRY trigger: a recent structure break (CHoCH/BOS) in the bias
  // direction that is STILL IN FORCE. Uses a TIGHTER pivot than the chart's
  // BOS/CHoCH markers (IT_TRIG_PIVOT, default 3 vs the chart's 5) on purpose: the
  // chart's pivot-5 swings need 5 bars to confirm, so a pivot-5 break is already
  // ~25 min old by the time it's recognised — too slow for a 30-min scalp. The
  // tighter pivot recognises the break sooner. The break is the SAME event the
  // chart plots a beat later, so they never contradict — the engine is just earlier.
  //
  // Swing-based breaks inherently trail price by roughly one swing spacing, so a
  // tight bar-age window would almost never fire. Instead the trigger requires:
  //   (1) the MOST RECENT break backs the bias (BEAR for a PE, BULL for a CE),
  //   (2) it is STILL IN FORCE — the last confirmed close is still beyond the
  //       broken level (price hasn't recovered through it), and
  //   (3) it is within the scalp lookback (RECENT bars, ~1h) — not an ancient break.
  // CHASING is prevented independently downstream: itBuildDirPlan anchors the entry
  // on a pullback into a level and the `extended` gate demotes BUY→WATCH when price
  // has already run > one expected-move from that anchor. Non-repainting (confirmed
  // bars only). biasSide: 'CE' → BULL break, 'PE' → BEAR. Returns the break or null.
  var IT_TRIG_PIVOT = 3;
  var IT_TRIG_RECENT_BARS = 12;   // ~1h on 5m — outer bound so an ancient break can't trigger
  function itFreshBreakTrigger(raw5, biasSide) {
    if (!raw5 || raw5.length < 20 || typeof window.detectStructureBreaks !== 'function') return null;
    var asc = raw5.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var n = asc.length;
    var lastClose = +asc[n - 1][4];
    var sb;
    try { sb = window.detectStructureBreaks(asc.slice().reverse(), { pivot: IT_TRIG_PIVOT }); } catch (_) { return null; }
    if (!sb || !sb.breaks || !sb.breaks.length) return null;
    var last = sb.breaks[sb.breaks.length - 1];                 // most recent break (ascending barIdx)
    var wantDir = (biasSide === 'PE') ? 'BEAR' : 'BULL';
    if (last.direction !== wantDir) return null;                // (1) break must back the bias
    if ((n - 1) - last.barIdx > IT_TRIG_RECENT_BARS) return null;  // (3) not an ancient break
    // (2) still in force: price hasn't recovered back through the broken level.
    if (!isFinite(lastClose) || !isFinite(last.level)) return null;
    var inForce = (wantDir === 'BEAR') ? (lastClose < last.level) : (lastClose > last.level);
    if (!inForce) return null;
    return { type: last.type, dir: last.direction, barIdx: last.barIdx, level: last.level };
  }

  // ── Room-to-wall (don't sell into support / buy into resistance) ─────────
  // An experienced scalper never shorts right on top of a support, nor buys right
  // under a resistance — there's no room left before price likely reverses off the
  // level, so the trade pays you a tiny move and then stops you on the bounce. This
  // is THE failure mode of a late trend entry: the move has already run into the
  // wall. We find the nearest OPPOSING wall in the trade's path (the nearest support
  // BELOW for a PE; the nearest resistance ABOVE for a CE) and let the verdict gate
  // demote the trade when that wall sits inside the target.
  function itNearestWall(lv, optType, spot) {
    if (!lv || !isFinite(spot)) return null;
    if (optType === 'PE') {
      // supports are sorted descending (nearest-below first) — first one strictly below spot.
      for (var i = 0; i < lv.supports.length; i++) { if (lv.supports[i].px < spot - 0.01) return lv.supports[i]; }
    } else if (optType === 'CE') {
      // resists are sorted ascending (nearest-above first) — first one strictly above spot.
      for (var j = 0; j < lv.resists.length; j++) { if (lv.resists[j].px > spot + 0.01) return lv.resists[j]; }
    }
    return null;
  }
  // Reward:risk measured to the WALL (not the ATR target). Returns the wall-adjusted
  // R:R when the wall sits between the entry and T1 (i.e. it would be hit first), or
  // null when the wall is beyond the target and doesn't interfere. Pure + testable.
  function itWallRR(plan, wall) {
    if (!plan || !wall || !(plan.risk > 0)) return null;
    var wallDist = Math.abs(plan.entryRef - wall.px);
    var t1Dist = Math.abs(plan.t1 - plan.entryRef);
    if (!(wallDist < t1Dist)) return null;       // wall is past the target → no interference
    return wallDist / plan.risk;                 // how many R's of room before the wall
  }

  // ── Volume confirmation (a breakout needs real participation) ────────────
  // The Nifty index reports no volume, so the fake-breakout detector reads the
  // front-month FUTURE's volume (RVOL = volume vs its own 20-bar average) on
  // CLOSED bars only (non-repainting). An experienced trader never trusts a
  // breakout on thin volume — that's the classic trap that reverses on you.
  // This pure helper reads the detector's result and reports how the breakout
  // in the TRADE direction is backed:
  //   'CONFIRM'     genuine break, ≥1.5× avg volume        → real conviction
  //   'WEAK'        break on thin volume (<1.0× avg) / failed → trap risk (demote)
  //   'EXHAUST'     high-volume push rejected back inside    → reversal risk (demote)
  //   'UNCONFIRMED' no futures volume to verify              → fail-safe: don't block
  //   'NONE'        no breakout in the trade direction       → gate is a no-op
  function itVolumeGate(breakouts, optType) {
    if (!breakouts || !breakouts.events || !optType) return { state: 'NONE', rvol: null, label: null };
    var want = (optType === 'CE') ? 'UP' : 'DOWN';   // CE rides an up-break, PE a down-break
    var e = null;
    if (breakouts.primary && breakouts.primary.dir === want) e = breakouts.primary;
    else { for (var i = 0; i < breakouts.events.length; i++) { if (breakouts.events[i].dir === want) { e = breakouts.events[i]; break; } } }
    if (!e) return { state: 'NONE', rvol: null, label: null };
    var st;
    if (e.kind === 'FAKE') st = (e.volState === 'EXHAUST') ? 'EXHAUST' : 'WEAK';  // a failed break in our dir is bad either way
    else if (e.volState === 'CONFIRM') st = 'CONFIRM';
    else if (e.volState === 'WEAK') st = 'WEAK';
    else if (e.volState === 'EXHAUST') st = 'EXHAUST';
    else st = 'UNCONFIRMED';
    return { state: st, rvol: (e.rvol != null ? e.rvol : null), label: e.label || null };
  }

  // ── Candlestick read at the entry zone (CONFIDENCE / reasoning only) ─────
  // Reads the candle pattern on the latest CONFIRMED 5m bars at the demand
  // (CE) / supply (PE) zone using the SAME pattern library the chart cards use.
  // This is deliberately NOT a hard gate: backtesting a "require a confirming
  // candle, else skip" rule on Mar→Jun LOST money (it suppressed valid
  // momentum entries and worsened the out-of-sample result — see
  // scripts/backtest/it-candle-confirm.mjs). So the candle only:
  //   • CONFIRM  — a bullish (CE) / bearish (PE) pattern at the zone → boosts
  //                confidence + adds a "why" note. Never creates a trade.
  //   • OPPOSE   — the latest bar is a pattern AGAINST the trade → adds a
  //                caution note only (no demote — that veto isn't validated yet).
  //   • null     — nothing notable.
  // trend context passed to the detector is the move INTO the zone (down for a
  // CE dip-buy, up for a PE pop-sell) so a Hammer stays a Hammer (not a Hanging
  // Man) and an Inverted Hammer at a top reads as a Shooting Star — i.e. the
  // reclassification matches a reversal-at-zone reading. Non-repainting: the
  // engine already treats the last 5m row as the confirmed close (same row it
  // reads `spot` from), so we judge that bar, never a live forming one.
  function itCandleAtZone(raw5m, optType) {
    if (!optType || !raw5m || raw5m.length < 2) return { dir: null, pattern: null };
    var detect = IM().detectPatterns || (typeof window !== 'undefined' ? window.detectPatterns : null);
    if (typeof detect !== 'function') return { dir: null, pattern: null };
    var r;
    try { r = detect(raw5m, optType === 'CE' ? 'BEAR' : 'BULL'); } catch (_) { return { dir: null, pattern: null }; }
    if (!r) return { dir: null, pattern: null };
    if (optType === 'CE') {
      if (r.bull) return { dir: 'CONFIRM', pattern: r.bull };
      if (r.bear) return { dir: 'OPPOSE', pattern: r.bear };
    } else {
      if (r.bear) return { dir: 'CONFIRM', pattern: r.bear };
      if (r.bull) return { dir: 'OPPOSE', pattern: r.bull };
    }
    return { dir: null, pattern: null };
  }

  // Build the full intraday setup: per-TF trend CONTEXT, a CE/PE verdict driven
  // by the entry timeframes, and a spot trade plan.
  // rawByTf = { '1h':[], '30m':[], '15m':[], '5m':[] } ascending.
  // opts.breakouts = the 5m fake-breakout/volume read (STATE.breakouts when the
  //   chart is on 5m) — used ONLY to confirm/deny participation, never to set
  //   direction. Omitted (test/no-vol) → the volume gate is a graceful no-op.
  function buildIntradaySetup(rawByTf, opts) {
    var trends = {};
    IT_SETUP_TFS.forEach(function (tf) { trends[tf] = (rawByTf[tf] ? classifyTfTrend(rawByTf[tf], tf) : null); });

    var t1h = trends['1h'], t30 = trends['30m'], t15 = trends['15m'], t5 = trends['5m'];
    // Spot = confirmed last close (non-repainting). Fall back to the 5m series'
    // last close if the chart hasn't published STATE.lastClose yet (first paint).
    var spot = isFinite(STATE.lastClose) ? STATE.lastClose : null;
    if (spot == null && rawByTf['5m'] && rawByTf['5m'].length) {
      var last5 = rawByTf['5m'][rawByTf['5m'].length - 1];
      if (last5 && isFinite(+last5[4])) spot = +last5[4];
    }

    // Session context (IST). This is a ≤30-min option-buyer scalp, so the
    // session-time gates are tuned for that horizon (a fresh entry after 15:00
    // would run into the 15:30 close), and the lunch lull is treated as chop.
    var nowIst = new Date(Date.now() + IST_OFF_SEC * 1000);
    var minOfDay = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
    var open = (typeof isMarketOpen === 'function') ? isMarketOpen() : true;
    var preSettle = open && minOfDay < (9 * 60 + 20);                       // first ~5 min — let the open settle
    var lunch     = open && minOfDay >= (12 * 60) && minOfDay < (13 * 60);  // midday lull — momentum dries up
    var lateScalp = open && minOfDay >= (15 * 60);                          // a ≤30-min trade would hit the close

    var why = [], skip = [];
    var verdict = 'WAIT', side = null, conf = 'LOW', plan = null;
    var bias = null, viaTrigger = false, viaReversal = false;   // bias+trigger model + 5m-led reversal

    // ── Direction = the ENTRY timeframes (5m + 15m) ──────────────────────────
    // This is a CE/PE option-buyer scalp, so DIRECTION (not "is the long-term
    // trend up") is what matters, and it comes from the timeframes actually held
    // (≤30 min): 5m + 15m. 1H + 30m are CONTEXT only — they shape confidence and
    // the WHY note, but NEVER gate the trade (a counter-1H scalp is still valid).
    //   5m & 15m both UP   → CE (buy call)
    //   5m & 15m both DOWN → PE (buy put)
    //   disagree           → no clean scalp direction → WAIT
    var haveEntry = !!(t5 && t15);
    var entryUp = haveEntry && t5.dir === 'UP' && t15.dir === 'UP';
    var entryDn = haveEntry && t5.dir === 'DOWN' && t15.dir === 'DOWN';
    var optType = entryUp ? 'CE' : (entryDn ? 'PE' : null);
    var dirSign = entryUp ? 1 : (entryDn ? -1 : 0);
    var lbl = function (t) { return t ? IT_TREND_VIEW[t.trend].label : '\u2014'; };

    // ── Two-stage fallback: higher-TF BIAS + fresh 5m TRIGGER ────────────────
    // When the strict 5m+15m alignment isn't there, see if the higher timeframes
    // give a clean directional bias. If they do AND the 5m isn't fighting it, we
    // expose that bias (so the user is armed and watching, not staring at a blank
    // WAIT) and — if a fresh 5m CHoCH/BOS has already printed in that direction —
    // upgrade it to a real entry (sets optType so the shared plan path runs).
    if (!optType && haveEntry) {
      var biasSide = itHtfBias(t15, t30, t1h);
      if (biasSide) {
        var opposing = (biasSide === 'PE' && t5.dir === 'UP') || (biasSide === 'CE' && t5.dir === 'DOWN');
        if (!opposing) {
          bias = { side: biasSide, label: (biasSide === 'CE' ? 'CALL' : 'PUT'), triggered: false };
          var trig = itFreshBreakTrigger(rawByTf['5m'], biasSide);
          if (trig) {
            optType = biasSide;
            dirSign = (biasSide === 'CE') ? 1 : -1;
            viaTrigger = true;
            bias.triggered = true;
            bias.trigType = trig.type;   // 'BOS' | 'CHoCH'
          }
        }
      }
    }

    // ── Third path: 5m-LED reversal (the turn shows on the fast TF first) ────
    // When neither strict alignment nor an HTF bias exists, the higher TFs are
    // merely RANGING — which is exactly what a fresh reversal/new trend looks like
    // before the slow TFs confirm (a V-bottom isn't higher-high/higher-low yet).
    // The move always shows on the 5m FIRST, so allow a 5m-led entry — but gate it
    // HARD so it is never noise:
    //   • the 5m must have a CLEAN trend read (UP/DOWN). classifyTfTrend already
    //     applies the session-VWAP veto, so a 5m UP read means price is holding the
    //     right side of fair value (a lone bounce below VWAP is demoted to NEUTRAL);
    //   • a FRESH 5m structure break (CHoCH/BOS) must confirm the turn (not drift);
    //   • NO higher TF may point the OPPOSITE way — never catch a falling knife
    //     against a still-trending higher timeframe.
    // Capped to MEDIUM confidence downstream (viaReversal). Every quality gate
    // (room-to-wall, R:R, extended, chop, volume) still applies after this.
    if (!optType && !bias && haveEntry && (t5.dir === 'UP' || t5.dir === 'DOWN')) {
      var revSide = (t5.dir === 'UP') ? 'CE' : 'PE';
      var htfOpposing = [t15, t30, t1h].some(function (t) {
        return t && ((revSide === 'CE' && t.dir === 'DOWN') || (revSide === 'PE' && t.dir === 'UP'));
      });
      if (!htfOpposing) {
        var revTrig = itFreshBreakTrigger(rawByTf['5m'], revSide);
        if (revTrig) {
          optType = revSide;
          dirSign = (revSide === 'CE') ? 1 : -1;
          viaReversal = true;
          bias = { side: revSide, label: (revSide === 'CE' ? 'CALL' : 'PUT'), triggered: true, trigType: revTrig.type, reversal: true };
        }
      }
    }

    if (!haveEntry) {
      verdict = 'WAIT';
      skip.push('Not enough 5m / 15m data to read an entry.');
    } else if (!optType) {
      verdict = 'WAIT';
      if (bias) {
        // Higher-TF bias is set but the 5m hasn't triggered yet — this is an
        // ARMED bias (get-ready), not a blind WAIT. Tell the user which way the
        // trend leans and exactly what we're waiting for.
        var bWord = bias.side === 'CE' ? 'up (calls)' : 'down (puts)';
        why.push('Higher timeframes lean ' + bWord + ' (' + lbl(t15) + ' 15m \u00B7 ' + lbl(t30) + ' 30m \u00B7 ' + lbl(t1h) + ' 1H), but the 5m hasn\u2019t triggered yet \u2014 waiting for a fresh 5m CHoCH/BOS in that direction before entering. Don\u2019t pre-empt it.');
        skip.push('5m trigger not in yet \u2014 ' + bias.side + ' bias only, no entry.');
      } else {
        // Distinguish "both flat / ranging" (common right after a gap, where the
        // VWAP veto correctly suppresses a lagging-EMA lean) from "actively pointing
        // opposite ways" — the user-facing reason should match what they see.
        var bothFlat = t5.dir === 'FLAT' && t15.dir === 'FLAT';
        var oneFlat = t5.dir === 'FLAT' || t15.dir === 'FLAT';
        var reason = bothFlat
          ? '5m and 15m are both ranging (' + lbl(t5) + ' / ' + lbl(t15) + ') \u2014 no clean scalp direction yet. Common just after a gap; wait for the tape to pick a side.'
          : oneFlat
            ? '5m and 15m are not aligned (' + lbl(t5) + ' / ' + lbl(t15) + ') \u2014 one side is still ranging. Wait for both entry timeframes to line up.'
            : '5m and 15m disagree (' + lbl(t5) + ' / ' + lbl(t15) + ') \u2014 no clean scalp direction. Option buyers wait for the entry timeframes to line up.';
        why.push(reason);
        skip.push('5m & 15m not aligned \u2014 direction unclear.');
      }
    } else {
      side = optType;
      var lv = itCollectLevels(rawByTf['5m'], rawByTf['15m'], spot);
      var cprClass = lv.cpr && lv.cpr.levels ? lv.cpr.levels.classification : null;
      plan = (spot != null) ? itBuildDirPlan(dirSign, lv, spot) : null;
      if (!plan) {
        verdict = 'WAIT';
        skip.push(optType === 'CE'
          ? 'No clean support below price to anchor a call entry.'
          : 'No clean resistance above price to anchor a put entry.');
      } else {
        plan.cprClass = cprClass; plan.optType = optType;
        verdict = 'BUY';   // candidate — gates below can only demote
        var dirWord = optType === 'CE' ? 'call (CE)' : 'put (PE)';
        var zoneWord = optType === 'CE' ? 'dips into' : 'pops into';
        if (viaReversal) {
          // 5m-led reversal: higher TFs are flat, the turn shows on the 5m first.
          why.push('The higher timeframes are flat/ranging, but the 5m just turned ' + (optType === 'CE' ? 'up' : 'down') + ' with a fresh ' + (bias && bias.trigType ? bias.trigType : 'CHoCH/BOS') + ' \u2014 a reversal usually shows on the 5m before the slower charts catch up. Early ' + dirWord + ' entry as price ' + zoneWord + ' ' + plan.anchorLabel + ' near ' + fmtPrice(plan.entryRef) + ' (kept to medium confidence until the higher TFs confirm).');
        } else if (viaTrigger) {
          // Bias-led entry: higher TFs set the side, a fresh 5m break is the trigger.
          why.push('Higher timeframes lean ' + (optType === 'CE' ? 'up' : 'down') + ' and the 5m just printed a fresh ' + (bias && bias.trigType ? bias.trigType : 'CHoCH/BOS') + ' ' + (optType === 'CE' ? 'up' : 'down') + ' \u2014 trend-aligned trigger. Buy a ' + dirWord + ' as price ' + zoneWord + ' ' + plan.anchorLabel + ' near ' + fmtPrice(plan.entryRef) + '.');
        } else {
          why.push('5m + 15m both ' + (optType === 'CE' ? 'up' : 'down') + ' \u2014 buy a ' + dirWord + ' as price ' + zoneWord + ' ' + plan.anchorLabel + ' near ' + fmtPrice(plan.entryRef) + '.');
        }
        if (plan.rr1 >= 1.5) why.push('Reward:risk to T1 is ' + plan.rr1.toFixed(1) + ':1 (' + fmtPrice(plan.t1) + ', ' + plan.t1lbl + ').');

        // Higher-TF CONTEXT (not a gate) — only colours the WHY note + confidence.
        var htfDir = (t1h && t30 && t1h.dir === t30.dir) ? t1h.dir : 'MIXED';
        var withHtf = (htfDir === (optType === 'CE' ? 'UP' : 'DOWN'));
        if (withHtf) why.push('1H + 30m agree (' + lbl(t1h) + ') \u2014 broader context backs this direction.');
        else why.push('1H / 30m are not aligned with this scalp \u2014 context only; fine for a quick \u226430-min trade, just keep it tight.');

        // ── Session-time CONTEXT (TESTING MODE: informational only, never gates). ──
        // For this first setup iteration the user wants the engine available in every
        // session window so it can be exercised freely (incl. weekends / off-hours).
        // So MOST time-of-day checks only annotate the WHY note. EXCEPTION (2026-06-09):
        // the late-session check IS now an active demote (see the LATE-SESSION gate
        // below) because a fresh entry after 15:00 running into the 15:25 square-off is
        // a real loss-maker, not just noise. The opening-noise (preSettle) and lunch
        // checks remain annotation-only for now \u2014 RE-ENABLE those demotes too before
        // fully trusting live signals.
        if (!open) why.push('Market is closed' + (typeof nextOpenLabel === 'function' ? ' \u2014 ' + nextOpenLabel() : '') + ' \u2014 this is a test/preview of the next session\u2019s plan.');
        else if (preSettle) why.push('First few minutes \u2014 opening range still forming; in live trading you\u2019d let it settle before entering.');
        else if (lateScalp) why.push('After 15:00 IST \u2014 close to EOD; a real \u226430-min scalp would run into the 15:30 close.');
        else if (lunch) why.push('Lunch lull (12:00\u201313:00) \u2014 momentum usually thins and premium bleeds; in live trading, scalp only decisive breaks.');

        // Momentum: option buyers need movement. Flat ADX on BOTH entry TFs = chop.
        var weakMo = (t5.adx != null && t5.adx < 18) && (t15.adx != null && t15.adx < 18);
        if (weakMo && cprClass !== 'NARROW') { if (verdict === 'BUY') verdict = 'WATCH'; skip.push('Weak momentum (ADX < 18 on 5m & 15m) \u2014 choppy tape; bad for option buyers (theta bleed).'); }
        // ── REGIME gate: stand aside when the 30-minute isn't trending (chop) ──
        // ROOT-CAUSE FIX (2026-06-09, backtested over Mar\u2013Jun on real Nifty candles):
        // the losing stretches in the choppy May\u2013Jun regime shared one trait \u2014 the
        // higher-timeframe (30m) was RANGEBOUND, not trending, so intraday trend signals
        // kept firing into mean-reverting chop and bled premium to theta. Measured:
        // gating fresh BUYs on 30m ADX < 18 flips the walk-forward (last-40% UNSEEN)
        // result from \u221253 pts / PF 0.95 to +76 pts / PF 1.10, cuts June \u2212120\u2192\u22129,
        // lowers max drawdown 203\u2192174 and lifts PF 1.45\u21921.51 \u2014 WITHOUT touching March
        // (the strongest trend month) and with total net \u2248 flat. The engine's per-TF
        // ADX (classifyTfTrend \u2192 IM.adx(asc,14)) is the SAME value the backtest gated on,
        // so live behaviour matches the validated numbers. This is a HIGHER-TF regime
        // read, distinct from the weak-momentum gate above (which needs BOTH 5m & 15m
        // flat) \u2014 the 30m can be choppy while the entry TFs briefly poke, the exact trap
        // this closes. `plan.regime` is set for EVERY candidate so the HUD can paint a
        // TRENDING chip on the good setups too, not just the chop stand-asides.
        var regimeAdx = (t30 && t30.adx != null && isFinite(t30.adx)) ? t30.adx : null;
        var regimeChoppy = (regimeAdx != null && regimeAdx < 18);
        plan.regime = { state: regimeChoppy ? 'CHOPPY' : (regimeAdx != null ? 'TRENDING' : 'UNKNOWN'), adx30: regimeAdx };
        // TEST-ONLY bypass (production no-op): the backtest harness sets
        // window.__IT_NO_REGIME__ to cache the PRE-regime baseline so it can measure
        // old-engine vs new-engine on identical data. The flag is NEVER set by the app,
        // so live behaviour is unchanged (plan.regime is still tagged either way).
        var regimeBypass = (typeof window !== 'undefined' && window.__IT_NO_REGIME__);
        if (regimeChoppy && !regimeBypass) {
          if (verdict === 'BUY') verdict = 'WATCH';
          skip.push('Choppy regime \u2014 the 30-minute trend strength (ADX ' + Math.round(regimeAdx) + ') is below 18, so the bigger picture is rangebound, not trending. Intraday trend signals fail in chop and your option premium bleeds to theta. Standing aside until a clean trend develops.');
          why.push('Held back as WATCH, not BUY: the 30m is rangebound (ADX ' + Math.round(regimeAdx) + ' < 18) \u2014 this choppy regime is exactly where these signals lost money in testing, so we wait for a real trend before risking premium.');
        }
        if (plan.rr1 < 1.5) { if (verdict === 'BUY') verdict = 'WATCH'; skip.push('Reward:risk to T1 below 1.5:1 \u2014 wait for a better entry.'); }
        // ── LATE-SESSION gate: no fresh scalp once there's no time to complete it ──
        // (2026-06-09, user-requested) A \u226430-min scalp entered after 15:00 IST runs
        // straight into the 15:25 EOD square-off / 15:30 close \u2014 not enough runway to
        // reach T1, and the forced square-off can cut it at a loss. So when the market
        // is OPEN and it's past 15:00, don't fire a FRESH BUY (demote to WATCH; manage
        // existing positions only). `lateScalp` already embeds the `open` check, so the
        // off-hours/weekend PREVIEW path is unaffected (it only annotates a next-session
        // plan and never reaches a live BUY). This re-enables the late-session demote
        // that was parked as annotation-only during the first setup iteration.
        if (lateScalp) { if (verdict === 'BUY') verdict = 'WATCH'; skip.push('After 15:00 IST \u2014 a fresh \u226430-min scalp would run into the 15:25 square-off / 15:30 close before it can reach target. No new entries this late; manage open positions only.'); }
        // ── ANTI-CHASE gate: don't market-buy a move that already ran past entry ──
        // ROOT-CAUSE FIX (2026-06-09, backtested): every losing afternoon CALL on a
        // trending day was the SAME mistake — the engine flashed BUY while price was
        // already well ABOVE the pullback-entry anchor, the market fill chased the
        // high, and the ordinary pullback hit the (re-anchored) stop ~10 min later,
        // BEFORE the move resumed. Measured on real candles: when price sits MORE
        // THAN 1× the trade's own risk-distance past the entry zone, the market-fill
        // win-rate collapses (~17% vs ~50% when near the zone). So: if price has run
        // > 1.0R beyond the entry anchor, it's a CHASE — demote BUY→WATCH and tell the
        // user to wait for the pullback to the zone (the limit fill that actually
        // wins) instead of buying the extension. `dist` is non-repainting (confirmed
        // last close vs the structural anchor). The old em-based `extended` gate
        // (~2.45×ATR) stays as a far backstop but this 1R rule is the real guard.
        // Regime-aware: a chase only reliably FAILS when higher-TF momentum is weak
        // (a choppy grind — price pokes up, then mean-reverts into your stop). In a
        // genuinely strong trend (15m ADX healthy) an "extended" entry is often just
        // momentum CONTINUATION that keeps running, so blocking it there only costs
        // winners. Backtest-tuned: apply the chase block only when the 15m isn't
        // strongly trending (ADX < 22); let continuation breathe when it is.
        var htfMomWeak = !(t15 && t15.adx != null && t15.adx >= 22);
        var chaseR = (plan.risk > 0) ? (plan.dist / plan.risk) : 0;
        if (chaseR > 1.0 && htfMomWeak) {
          if (verdict === 'BUY') verdict = 'WATCH';
          skip.push('Price has already run ' + Math.round(plan.dist) + ' pts (' + chaseR.toFixed(1) + 'R) past the entry zone near ' + fmtPrice(plan.entryRef) + ' \u2014 you\u2019ve missed the clean entry. Buying here chases the move and puts the stop right in the path of the normal pullback (the exact way these turn into instant stop-outs). Wait for a pullback toward ' + fmtPrice(plan.entryRef) + ' to enter.');
          why.push('Held back as WATCH, not BUY: price is ' + chaseR.toFixed(1) + 'R above the entry zone \u2014 chasing an extended move is how scalps get stopped on the first pullback. Patience for the retrace pays here.');
        } else if (plan.extended) { if (verdict === 'BUY') verdict = 'WATCH'; skip.push('Price is extended ' + Math.round(plan.dist) + ' pts from the entry zone \u2014 wait for the retrace, don\u2019t chase.'); }
        if (cprClass === 'WIDE') { if (verdict === 'BUY') verdict = 'WATCH'; skip.push('Wide CPR \u2014 likely range/chop day; option buyers whipsaw. Trade only decisive breaks.'); }
        // ── ROOM-TO-WALL gate: don't sell into support / buy into resistance ──
        // The fix for "we shorted right as price reached support and it bounced".
        // If the nearest opposing level (support below a PE / resistance above a CE)
        // sits inside the target, the move can't reach T1 before price likely reverses
        // off the wall — so the realistic reward:risk is poor. Demote BUY→WATCH and
        // say exactly which level is in the way and how little room is left.
        var wall = itNearestWall(lv, optType, spot);
        plan.wall = wall || null;
        var wallRR = itWallRR(plan, wall);
        if (wallRR != null && wallRR < 1.2) {
          if (verdict === 'BUY') verdict = 'WATCH';
          var wDist = Math.round(Math.abs(plan.entryRef - wall.px));
          var wSideWord = (optType === 'PE') ? 'support' : 'resistance';
          var wActWord = (optType === 'PE') ? 'Selling into the floor' : 'Buying into the ceiling';
          skip.push('Nearest ' + wSideWord + ' (' + wall.label + ' ' + fmtPrice(wall.px) + ') is only ' + wDist + ' pts away \u2014 just ' + wallRR.toFixed(1) + 'R of room before price likely reverses off it. ' + wActWord + ' near the end of the move; wait for a clean break of that level (then it becomes support\u2192resistance) or a pullback to re-enter.');
          why.push('Caution: a ' + wSideWord + ' sits close by at ' + fmtPrice(wall.px) + ' \u2014 the down/up move may be near exhaustion, so this is held back as WATCH, not a BUY.');
        }
        // ── VOLUME gate: a breakout needs real participation, not a thin poke ──
        // Reject the single most common false signal — the low-volume fakeout.
        // Uses the 5m fake-breakout/RVOL read (futures volume; non-repainting).
        // Fail-safe: when volume can't be verified we DON'T block (no false stand-aside).
        var vg = itVolumeGate(opts && opts.breakouts, optType);
        plan.volGate = vg.state;
        plan.volRvol = vg.rvol;
        if (vg.state === 'WEAK') {
          if (verdict === 'BUY') verdict = 'WATCH';
          skip.push('Breakout is on thin volume' + (vg.rvol != null ? ' (' + vg.rvol.toFixed(2) + '\u00d7 average)' : '') + ' \u2014 not enough real buying/selling behind it; this is the classic trap that reverses. Wait for volume to confirm the move.');
        } else if (vg.state === 'EXHAUST') {
          if (verdict === 'BUY') verdict = 'WATCH';
          skip.push('A high-volume push through ' + (vg.label || 'the level') + ' was rejected back inside' + (vg.rvol != null ? ' (' + vg.rvol.toFixed(2) + '\u00d7 average)' : '') + ' \u2014 looks like exhaustion, the move likely reverses. Stand aside.');
        } else if (vg.state === 'CONFIRM') {
          why.push('Volume confirms it \u2014 the breakout printed ' + (vg.rvol != null ? vg.rvol.toFixed(2) + '\u00d7 average volume' : 'strong participation') + ', so there\u2019s real money behind the move.');
        } else if (vg.state === 'UNCONFIRMED') {
          why.push('Note: no futures volume to verify participation right now \u2014 the structure read still stands, but volume can\u2019t confirm conviction (treat with a touch more caution).');
        }

        // ── CANDLE at the zone (confidence + reasoning only; never a gate) ──
        // A confirming reversal candle at the demand/supply zone strengthens the
        // read; an opposing one is flagged as caution. See itCandleAtZone — the
        // "require a candle" GATE was backtested and rejected (it cut winners), so
        // this only colours confidence + the WHY note and never removes a trade.
        var cz = itCandleAtZone(rawByTf['5m'], optType);
        plan.candle = cz.pattern || null;
        plan.candleDir = cz.dir || null;
        if (cz.dir === 'CONFIRM') {
          why.push('A ' + cz.pattern + ' just printed at the ' + plan.anchorLabel + ' \u2014 the candle confirms ' + (optType === 'CE' ? 'buyers stepping in at support' : 'sellers stepping in at resistance') + ', which strengthens the entry.');
        } else if (cz.dir === 'OPPOSE') {
          why.push('Caution: the latest 5m candle is a ' + cz.pattern + ' \u2014 that\u2019s against the trade, so there\u2019s no candle confirmation at the zone yet. Prefer a confirming candle (or size down) before committing.');
        }
        var confirmCandle = (cz.dir === 'CONFIRM');

        // Confidence: HTF agreement + entry-TF strength + day-type, with a
        // confirming candle as an extra positive (one confluence, not a gate).
        var strongEntry = (t5.trend === 'STRONG_BULL' || t5.trend === 'STRONG_BEAR' || t15.trend === 'STRONG_BULL' || t15.trend === 'STRONG_BEAR');
        if (((withHtf && strongEntry) || (confirmCandle && (withHtf || strongEntry))) && cprClass !== 'WIDE') conf = 'HIGH';
        else if (withHtf || strongEntry || confirmCandle) conf = 'MEDIUM';
        else conf = 'LOW';
        // A bias-led trigger entry hasn't earned full confidence: the 5m has only
        // just broken, not fully flipped its swing structure. Cap it one notch.
        if (viaTrigger && conf === 'HIGH') conf = 'MEDIUM';
        // A 5m-led reversal is the earliest (least-confirmed) entry — the higher TFs
        // haven't agreed yet — so it can never be HIGH; cap at MEDIUM.
        if (viaReversal && conf === 'HIGH') conf = 'MEDIUM';
        if (cprClass === 'NARROW') why.push('Narrow CPR \u2014 trending-day signal, favourable for a directional scalp.');
      }
    }

    return {
      trends: trends, verdict: verdict, side: side, optType: optType, conf: conf, plan: plan,
      bias: bias, viaTrigger: viaTrigger, viaReversal: viaReversal,
      why: why, skip: skip, spot: spot,
      asOf: nowIst.getUTCHours().toString().padStart(2, '0') + ':' + nowIst.getUTCMinutes().toString().padStart(2, '0')
    };
  }

  // Recommendation → display text + tone class. The verdict (BUY/WATCH/WAIT) is
  // combined with the direction (CE/PE) so the cell reads "BUY CALL" / "BUY PUT"
  // and is coloured by direction (CE = bull green, PE = bear red — the trade
  // context mapping, per AGENTS §9). WATCH/WAIT stay amber/grey.
  function itRecoView(verdict, optType, bias) {
    var dirWord = optType === 'CE' ? 'CALL' : (optType === 'PE' ? 'PUT' : '');
    if (verdict === 'BUY') return { text: 'BUY ' + dirWord, cls: optType === 'CE' ? 'it-reco-ce' : 'it-reco-pe' };
    if (verdict === 'WATCH') return { text: 'WATCH' + (dirWord ? ' ' + dirWord : ''), cls: 'it-reco-watch' };
    // Higher-TF bias set but no 5m trigger yet — show the lean (amber, not actionable).
    if (bias && bias.side && !bias.triggered) return { text: 'BIAS ' + (bias.side === 'CE' ? 'CALL' : 'PUT'), cls: 'it-reco-watch' };
    return { text: 'WAIT', cls: 'it-reco-wait' };
  }
  // Plan-card left-edge accent class by direction (green CE / red PE) when a plan
  // exists, else neutral grey.
  function itPlanAccent(setup) {
    if (!setup.plan) return 'it-reco-wait-plan';
    return setup.optType === 'CE' ? 'it-reco-ce-plan' : 'it-reco-pe-plan';
  }

  function renderSetupPlan(setup) {
    IT_SETUP_TFS.forEach(function (tf) {
      var t = setup.trends[tf];
      var v = $('it-bias-' + tf), sub = $('it-bias-' + tf + '-sub');
      if (!v) return;
      if (!t) { v.textContent = '\u2014'; v.className = 'sw-bias-v'; if (sub) sub.textContent = 'no data'; return; }
      var view = IT_TREND_VIEW[t.trend] || IT_TREND_VIEW.NEUTRAL;
      v.textContent = view.arrow + ' ' + view.label;
      v.className = 'sw-bias-v ' + view.cls;
      if (sub) sub.textContent = t.basis;
    });
    var reco = itRecoView(setup.verdict, setup.optType, setup.bias);
    var fb = $('it-final-bias'), fc = $('it-final-conf'), cell = $('it-final-cell');
    if (fb) { fb.textContent = reco.text; fb.className = 'sw-bias-v ' + reco.cls; }
    var armedBias = !!(setup.bias && setup.bias.side && !setup.bias.triggered);
    if (fc) fc.textContent = (setup.verdict === 'BUY' || setup.verdict === 'WATCH') ? (setup.conf.charAt(0) + setup.conf.slice(1).toLowerCase() + ' confidence') : (armedBias ? 'waiting for 5m trigger' : '\u2014');
    if (cell) cell.className = 'sw-bias-cell sw-bias-cell-final ' + reco.cls;
    setText('it-setup-meta', setup.asOf ? ('as of ' + setup.asOf + ' IST') : '');
  }

  // Look up the live premium (ltp) + signed delta for one ATM leg from the
  // intraday option chain. Returns null when the chain isn't loaded or the
  // strike/leg is missing — caller fails safe (hides the premium map).
  function itStrikePremium(optType, strike) {
    var chain = window.itOptionChainData;
    if (!chain || !Array.isArray(chain.strikes)) return null;
    for (var i = 0; i < chain.strikes.length; i++) {
      var s = chain.strikes[i];
      if (!s || s.strike_price !== strike) continue;
      var leg = (optType === 'CE') ? s.call_options : s.put_options;
      if (!leg) return null;
      var md = leg.market_data || {};
      var g = leg.option_greeks || {};
      var ltp = (typeof md.ltp === 'number' && isFinite(md.ltp)) ? md.ltp : null;
      var delta = (typeof g.delta === 'number' && isFinite(g.delta)) ? g.delta : null;
      return { ltp: ltp, delta: delta, spot: (typeof chain.spot === 'number') ? chain.spot : null };
    }
    return null;
  }
  // Round to the option tick (₹0.05) and never below one tick.
  function itPremTick(v) { return Math.max(0.05, Math.round(v / 0.05) * 0.05); }
  // Translate the SPOT-level plan (entry / SL / T1 / T2 in index points) into the
  // OPTION PREMIUM you'll actually trade on the broker. premium move ≈ delta ×
  // index move (the standard first-order mapping). Uses the chain's real delta;
  // falls back to ATM ≈ ±0.5 if greeks are missing. Approximate — ignores theta /
  // gamma / IV drift, which is why it's a ≤30-min scalp and labelled "approx".
  function itRenderPremiumMap(setup, p) {
    var el = $('it-tplan-prem');
    if (!el) return;
    var hide = function (note) {
      el.hidden = true;
      if (note) { var n = $('it-tplan-prem-note'); if (n) n.textContent = note; }
    };
    if (!p || (setup.optType !== 'CE' && setup.optType !== 'PE')) { hide(); return; }
    var spot = isFinite(STATE.lastClose) ? STATE.lastClose : null;
    if (spot == null) { hide(); return; }
    var strike = Math.round(spot / 50) * 50;                       // same ATM strike the journal logs
    var info = itStrikePremium(setup.optType, strike);
    if (!info || info.ltp == null) {
      // Chain not loaded → can't map. Show the bar with a gentle hint so the
      // user knows the feature exists and how to enable it.
      el.hidden = false;
      setText('it-tplan-prem-tag', 'ATM ' + strike + ' ' + setup.optType);
      ['entry', 'sl', 't1', 't2'].forEach(function (k) { setText('it-prem-' + k, '\u2014'); });
      setText('it-tplan-prem-note', 'Open the Options tab and load the chain to map these to a live premium.');
      return;
    }
    // Signed delta: CALL positive, PUT negative. Upstox already signs puts; if a
    // value is missing or has the wrong sign, coerce to the correct ATM default.
    var delta = info.delta;
    if (delta == null) delta = (setup.optType === 'CE') ? 0.5 : -0.5;
    if (setup.optType === 'CE' && delta < 0) delta = Math.abs(delta);
    if (setup.optType === 'PE' && delta > 0) delta = -Math.abs(delta);
    var spotNow = (info.spot != null) ? info.spot : spot;
    // Premium at the plan's entry level, then at SL / T1 / T2 — all via Δpremium = delta × Δspot.
    var entryPrem = itPremTick(info.ltp + delta * (p.entryRef - spotNow));
    var slPrem = itPremTick(entryPrem + delta * (p.sl - p.entryRef));
    var t1Prem = itPremTick(entryPrem + delta * (p.t1 - p.entryRef));
    var t2Prem = itPremTick(entryPrem + delta * (p.t2 - p.entryRef));
    var R = '\u20B9';
    var money = function (v) { return R + v.toFixed(2); };
    var delc = function (to) { var d = to - entryPrem; return ' (' + (d >= 0 ? '+' : '\u2212') + R + Math.abs(d).toFixed(2) + ')'; };
    el.hidden = false;
    setText('it-tplan-prem-tag', 'ATM ' + strike + ' ' + setup.optType + ' \u00B7 \u0394 ' + Math.abs(delta).toFixed(2));
    setText('it-prem-entry', money(entryPrem));
    setText('it-prem-sl', money(slPrem) + delc(slPrem));
    setText('it-prem-t1', money(t1Prem) + delc(t1Prem));
    setText('it-prem-t2', money(t2Prem) + delc(t2Prem));
    setText('it-tplan-prem-note', 'Approx \u2014 premium moves ~\u0394 \u00D7 index points; ignores time decay. Buy near ' + money(entryPrem) + ', book at the target premium or exit when Nifty hits the spot level above.');
  }

  // Render the Volume + Candle confluence chips beneath the plan grid. Reads
  // plan.volGate / plan.volRvol (the fake-breakout/RVOL read) and plan.candle /
  // plan.candleDir (the candlestick-at-zone read). Hidden when there's no
  // actionable CE/PE plan. Honest about "n/a" states (no futures volume → can't
  // confirm; no pattern at the zone → nothing to show) so nothing is implied.
  function itRenderConfluenceChips(setup, p) {
    var box = $('it-tplan-conf');
    if (!box) return;
    var volEl = $('it-tplan-conf-vol');
    var candEl = $('it-tplan-conf-candle');
    if (!p || !setup.optType) { box.hidden = true; return; }
    box.hidden = false;
    var rvolTxt = (p.volRvol != null) ? (p.volRvol.toFixed(2) + '\u00d7') : null;
    // ── Volume chip ──
    var vState = p.volGate || 'NONE';
    var vTone = 'na', vTxt = '';
    if (vState === 'CONFIRM') { vTone = 'good'; vTxt = 'Volume \u2713 confirmed' + (rvolTxt ? ' \u00b7 ' + rvolTxt + ' avg' : ''); }
    else if (vState === 'WEAK') { vTone = 'bad'; vTxt = 'Volume \u2717 thin' + (rvolTxt ? ' \u00b7 ' + rvolTxt + ' avg' : '') + ' (trap risk)'; }
    else if (vState === 'EXHAUST') { vTone = 'bad'; vTxt = 'Volume \u2717 exhaustion' + (rvolTxt ? ' \u00b7 ' + rvolTxt + ' avg' : ''); }
    else if (vState === 'UNCONFIRMED') { vTone = 'na'; vTxt = 'Volume \u2014 unconfirmed (no futures vol)'; }
    else { vTone = 'na'; vTxt = 'Volume \u2014 needs 5m chart + futures vol'; }
    if (volEl) { volEl.className = 'it-plan-conf-chip it-plan-conf-' + vTone; volEl.textContent = vTxt; }
    // ── Candle chip ──
    var cTone = 'na', cTxt = '';
    if (p.candleDir === 'CONFIRM' && p.candle) { cTone = 'good'; cTxt = 'Candle \u2713 ' + p.candle + ' at zone'; }
    else if (p.candleDir === 'OPPOSE' && p.candle) { cTone = 'warn'; cTxt = 'Candle \u26a0 ' + p.candle + ' (against)'; }
    else { cTone = 'na'; cTxt = 'Candle \u2014 none at the zone yet'; }
    if (candEl) { candEl.className = 'it-plan-conf-chip it-plan-conf-' + cTone; candEl.textContent = cTxt; }
  }

  function renderTradePlan(setup) {
    var wrap = $('it-tplan');
    var p = setup.plan;
    var pf = function (v) { return fmtPrice(v); };
    var pct = function (a, b) { return (b > 0 ? ((a - b) / b * 100) : 0); };
    var entryK = setup.optType === 'CE' ? 'CALL ENTRY \u00B7 CE' : (setup.optType === 'PE' ? 'PUT ENTRY \u00B7 PE' : 'ENTRY ZONE');
    if (!p) {
      // No actionable plan (WAIT / no anchor) — blank the cells, keep WHY/SKIP.
      ['entry', 'sl', 't1', 't2'].forEach(function (k) { setText('it-tplan-' + k, '\u2014'); setText('it-tplan-' + k + '-sub', '\u2014'); });
      setText('it-tplan-entry-k', 'ENTRY ZONE');
    } else {
      setText('it-tplan-entry-k', entryK);
      setText('it-tplan-entry', pf(p.entryLo) + ' \u2013 ' + pf(p.entryHi));
      setText('it-tplan-entry-sub', (p.atZone ? 'at zone \u00B7 ' : 'limit into zone \u00B7 ') + p.anchorLabel);
      // SL is the ADVERSE side: for a PE the stop sits ABOVE entry (price rising
      // hurts a put), for a CE it sits BELOW. Spell out which way so a beginner
      // isn't surprised the stop is above the entry on a PUT.
      var slDirWord = setup.optType === 'PE' ? 'spot rises to' : 'spot falls to';
      setText('it-tplan-sl', pf(p.sl));
      setText('it-tplan-sl-sub', Math.round(p.risk) + ' pts risk \u00B7 ' + slDirWord + ' ' + pf(p.sl));
      // Targets: show the favourable SPOT move. A CALL wins as spot RISES (targets
      // ABOVE entry); a PUT wins as spot FALLS (targets BELOW entry). State the
      // direction in words so "target lower than entry" reads correctly for a PUT.
      var tgtDirWord = setup.optType === 'PE' ? 'spot falls' : 'spot rises';
      setText('it-tplan-t1', pf(p.t1));
      setText('it-tplan-t1-sub', tgtDirWord + ' ' + Math.round(Math.abs(p.t1 - p.entryRef)) + ' pts \u00B7 R:R 1:' + p.rr1.toFixed(1) + (p.t1lbl ? ' \u00B7 ' + p.t1lbl : ''));
      setText('it-tplan-t2', pf(p.t2));
      setText('it-tplan-t2-sub', tgtDirWord + ' ' + Math.round(Math.abs(p.t2 - p.entryRef)) + ' pts \u00B7 R:R 1:' + p.rr2.toFixed(1) + (p.t2lbl ? ' \u00B7 ' + p.t2lbl : ''));
    }
    itRenderPremiumMap(setup, p);
    itRenderConfluenceChips(setup, p);
    // Left-edge accent (green CE / red PE / grey) + WHY/SKIP.
    if (wrap) wrap.className = 'sw-plan ' + itPlanAccent(setup);
    var whyEl = $('it-tplan-why');
    if (whyEl) {
      // Direction primer (display only) — answers "why is the target lower than
      // the entry?" for a PUT. These are Nifty SPOT levels, not option premium:
      // a PUT gains as spot drops, a CALL gains as spot rises.
      var dirLead = p ? (setup.optType === 'PE'
        ? 'You\u2019re buying a PUT \u2014 it gains when Nifty FALLS, so on these spot levels the targets sit BELOW your entry and the stop above. '
        : (setup.optType === 'CE'
          ? 'You\u2019re buying a CALL \u2014 it gains when Nifty RISES, so on these spot levels the targets sit ABOVE your entry and the stop below. '
          : '')) : '';
      whyEl.textContent = dirLead + (setup.why.length ? setup.why.join(' ') : 'No clean scalp right now.');
    }
    var skipEl = $('it-tplan-skip');
    if (skipEl) {
      skipEl.innerHTML = '';
      (setup.skip.length ? setup.skip : ['Nothing flagged.']).forEach(function (s) {
        var li = document.createElement('li'); li.textContent = s; skipEl.appendChild(li);
      });
    }
    setText('it-tplan-tfnote', ' \u00B7 entry 5m+15m \u00B7 1H/30m context \u00B7 CE & PE \u00B7 Nifty spot');
    try { itRenderContextBanner(); } catch (_) { /* context banner is best-effort */ }
  }

  // Async loader — reads 1H / 30m / 15m / 5m (reusing the per-TF fetch cache),
  // builds the setup, and renders. Gated by token + API pause + the 429 bucket
  // (via getRawForTf). Sequence-guarded against rapid refreshes.
  async function loadSetup(force) {
    var box = $('it-setup');
    if (!getToken()) { if (box) box.hidden = true; return; }
    if (box) box.hidden = false;
    var seq = ++STATE.setup.loadSeq;
    var btn = $('it-setup-refresh');
    if (btn) btn.disabled = true;
    setText('it-setup-meta', 'reading\u2026');
    if (apiPaused()) {
      setText('it-setup-meta', 'API paused');
      ['1h', '30m', '15m', '5m'].forEach(function (tf) { var v = $('it-bias-' + tf); if (v) v.textContent = '\u2014'; });
      if (btn) btn.disabled = false;
      return;
    }
    var rawByTf = {};
    // Fetch all Setup timeframes CONCURRENTLY. This used to be a sequential
    // await-in-loop — one full proxy→Upstox round-trip per TF (≈1s each ≈ 4s
    // wall time before the setup could even build). Firing them together just
    // pipelines them through the shared 429 rate-limiter as fast as it allows,
    // so the analyzer is ready in roughly one round-trip instead of four.
    // SAFE: getRawForTf already de-dupes in-flight requests + serves the 20s
    // fetch cache (so this can't double-hit the API), the current chart TF
    // reuses STATE.raw with no network at all, and each TF soft-fails to null
    // on its own so one bad timeframe can't sink the whole setup.
    await Promise.all(IT_SETUP_TFS.map(function (tf) {
      if (tf === STATE.timeframe && STATE.raw && STATE.raw.length) { rawByTf[tf] = STATE.raw; return Promise.resolve(); }
      return getRawForTf(tf).then(function (raw) { rawByTf[tf] = raw; }, function () { rawByTf[tf] = null; });
    }));
    if (seq !== STATE.setup.loadSeq) { if (btn) btn.disabled = false; return; }   // superseded
    var setup = null;
    // Volume confirmation uses the 5m breakout/RVOL read — only valid when the
    // chart is on 5m (same guard the 5m VWAP volume-weighting already uses).
    var volOpts = { breakouts: (STATE.timeframe === '5m') ? STATE.breakouts : null };
    try { setup = buildIntradaySetup(rawByTf, volOpts); } catch (e) { setup = null; }
    if (setup) {
      STATE.setup.data = setup;
      renderSetupPlan(setup);
      renderTradePlan(setup);
      // Auto-trade hook: if armed and this is a fresh BUY, take it in the
      // intraday paper book + log the signal to the journal. Fire-and-forget
      // (async); never blocks the render.
      try { maybeAutoTrade(setup); } catch (_) {}
    }
    // Repaint the live ENTER/HOLD/EXITED/WAIT strip off the fresh verdict.
    try { renderActiveSignal(); } catch (_) {}
    // Refresh the macro context banner (Bank-Nifty bias; gap is local).
    try { itRefreshMacroContext(); } catch (_) {}
    if (btn) btn.disabled = false;
  }
  window.itSetupRefresh = function () { loadSetup(true); };

  // ═══════════════════ AUTO-TRADE + SIGNAL JOURNAL ═══════════════════
  // A fully SELF-CONTAINED forward-test of signal quality. It is INDEPENDENT of
  // the intraday paper-trading desk — it does NOT place into the paper book, does
  // NOT read the paper book, and does NOT touch the paper book's JSON. When armed
  // (AUTO-TRADE toggle ON), every fresh BUY the setup engine emits opens a virtual
  // SPOT trade tracked entirely here: it fills at the plan's entry level and is
  // closed by the live Nifty spot crossing the plan's SL or T1 (or EOD). Outcome
  // is measured in INDEX POINTS. Everything persists to its OWN JSON
  // (data/intraday-signal-journal.json via /local/intraday-journal) so it survives
  // a browser storage clear. SIMULATED — no real orders, no paper-book entries.
  var AUTO_KEY = 'it_auto_trade_v1';
  var JOURNAL_KEY = 'it_signal_journal_v1';
  var JOURNAL_URL = '/local/intraday-journal';
  // Durable ARCHIVE of cleared rows — independent of the live store so "Clear"
  // tidies the table without destroying history (see archiveRows / itClearJournal).
  var ARCHIVE_KEY = 'it_signal_journal_archive_v1';
  var ARCHIVE_URL = '/local/intraday-journal-archive';
  // Scalp hold horizon (minutes). NOT a hard auto-exit — the user manages the
  // timed exit manually on their broker. It is used only to SIZE the trade plan:
  // targets are capped at the expected price move over this horizon (see
  // itBuildDirPlan) so a ≤30-min scalp is never handed an unreachable target.
  var SCALP_HORIZON_MIN = 30;
  // How long a resting (ARMED) order waits for price to trade back into its entry
  // zone before it is cancelled as MISSED. One scalp horizon: if the retest hasn't
  // come in 30 min the setup that justified it is stale — don't chase a late fill.
  var MAX_ARM_MS = SCALP_HORIZON_MIN * 60 * 1000;

  function journalServerAvailable() {
    try {
      var h = (location.hostname || '').toLowerCase();
      return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local');
    } catch (_) { return false; }
  }
  function istDayKeyOf(ms) {
    var d = new Date(ms + IST_OFF_SEC * 1000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }
  function istDayKey() { return istDayKeyOf(Date.now()); }
  // Fingerprint a signal: side + IST-day + rounded entry + rounded SL. The day
  // component means yesterday's identical-level plan won't collide with today's.
  function sigOf(side, dayKey, entry, sl) {
    return side + '|' + dayKey + '|' + Math.round(entry) + '|' + Math.round(sl);
  }
  // Rebuild the `taken` dedupe map from the persisted journal so a page reload
  // (or server hydrate) can't re-take a signal we already acted on. Every logged
  // signal counts as taken (OPEN or CLOSED) — there is no "skipped" state now.
  function seedDedupe() {
    STATE.auto.taken = {};
    (STATE.auto.journal || []).forEach(function (j) {
      if (!j || !j.side || !j.ts) return;
      // Prefer the persisted plan anchor (market-fill rows) so the fingerprint
      // matches the live one; fall back to entry/sl for legacy (pre-market-fill)
      // rows where the ARMED entry WAS the plan level.
      var e = (typeof j.planEntry === 'number') ? j.planEntry : j.entry;
      var s = (typeof j.planSl === 'number') ? j.planSl : j.sl;
      if (typeof e !== 'number' || typeof s !== 'number') return;
      STATE.auto.taken[sigOf(j.side, istDayKeyOf(j.ts), e, s)] = true;
    });
  }
  // A virtual trade only lives during the IST session it was opened. On load,
  // expire any OPEN trade carried over from a previous day (the tab was closed
  // before the EOD close fired) — mark EXPIRED with unknown P&L so it's excluded
  // from the win-rate rather than force-closed at a wrong, much-later price.
  function expireStaleOpen() {
    var today = istDayKey();
    var changed = false;
    (STATE.auto.journal || []).forEach(function (j) {
      if (!j || !j.ts || istDayKeyOf(j.ts) === today) return;
      // A filled trade carried past its session → EXPIRED (unknown P&L, excluded
      // from win-rate). A resting (ARMED) order that never filled → MISSED.
      if (j.status === 'OPEN') {
        j.status = 'CLOSED'; j.outcome = 'EXPIRED'; j.exitTs = Date.now(); j.pts = null;
        changed = true;
      } else if (j.status === 'ARMED') {
        j.status = 'CLOSED'; j.outcome = 'MISSED'; j.exit = null; j.exitTs = Date.now(); j.pts = null;
        changed = true;
      }
    });
    if (changed) saveJournal();
  }

  function loadAuto() {
    // Default ON: when the user has never toggled it (key absent), arm the
    // signal-journal auto-trade. Once they flip it, the stored '1'/'0' wins.
    try { var v = localStorage.getItem(AUTO_KEY); STATE.auto.on = (v === null ? true : v === '1'); } catch (_) { STATE.auto.on = true; }
    try {
      var j = JSON.parse(localStorage.getItem(JOURNAL_KEY));
      if (Array.isArray(j)) STATE.auto.journal = j;
    } catch (_) {}
    seedDedupe();
    expireStaleOpen();
  }
  function saveJournal() {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(STATE.auto.journal)); } catch (_) {}
    if (!journalServerAvailable()) return;
    if (STATE.auto.jSaveTimer) clearTimeout(STATE.auto.jSaveTimer);
    STATE.auto.jSaveTimer = setTimeout(function () {
      STATE.auto.jSaveTimer = null;
      try {
        fetch(JOURNAL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ journal: STATE.auto.journal, savedAt: new Date().toISOString() })
        }).catch(function () {});
      } catch (_) {}
    }, 250);
  }
  function hydrateJournalFromServer(done) {
    if (STATE.auto.jLoaded || !journalServerAvailable()) { if (done) done(); return; }
    STATE.auto.jLoaded = true;
    try {
      fetch(JOURNAL_URL, { credentials: 'omit', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          if (s && Array.isArray(s.journal)) {
            STATE.auto.journal = s.journal;
            seedDedupe();        // re-derive dedupe from the authoritative server copy
            expireStaleOpen();   // close any cross-day OPEN trades from the server copy
            try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(STATE.auto.journal)); } catch (_) {}
            renderJournal();
          }
        })
        .catch(function () {})
        .then(function () { if (done) done(); });
    } catch (_) { if (done) done(); }
  }

  function journalAdd(entry) {
    STATE.auto.journal.unshift(entry);   // newest first
    if (STATE.auto.journal.length > 500) STATE.auto.journal.length = 500;
  }

  // True once the IST clock is at/past 15:25 on a weekday (square-off window).
  function eodPassed() {
    var d = new Date(Date.now() + IST_OFF_SEC * 1000);
    var dow = d.getUTCDay();                       // IST day-of-week (date already shifted)
    if (dow === 0 || dow === 6) return false;      // weekend — nothing to square off
    return (d.getUTCHours() * 60 + d.getUTCMinutes()) >= (15 * 60 + 25);
  }

  // The actual auto-execution — OPENS A VIRTUAL SPOT TRADE in the journal only.
  // No paper-book call, no option premium: the trade fills at the plan's entry
  // level and is later closed by journalTick() when live spot crosses SL/T1/EOD.
  // Dedupe via the `taken` map (seeded from the journal, survives reload); never
  // stacks a second OPEN trade on the same side. Gated on market-open so a
  // virtual trade only exists while there are live ticks to manage its exit.
  function maybeAutoTrade(setup) {
    if (!STATE.auto.on) return;
    if (!isMarketOpen()) return;                       // only arm with a live tape to manage the fill/exit
    if (!setup || setup.verdict !== 'BUY' || !setup.plan) return;
    if (setup.optType !== 'CE' && setup.optType !== 'PE') return;
    var p = setup.plan;
    if (typeof p.entryRef !== 'number' || typeof p.sl !== 'number') return;
    var sig = sigOf(setup.optType, istDayKey(), p.entryRef, p.sl);
    if (STATE.auto.taken[sig]) return;                 // already took this exact signal (survives reload)
    // One trade at a time: skip ANY new signal (CE or PE) while a virtual trade
    // is still live — whether it's ARMED (resting, waiting for the price to come
    // back to the entry) or OPEN (filled). The next fresh BUY can only be taken
    // once journalTick() has resolved the current one (filled→T1/SL, or cancelled
    // as MISSED). A clean sequential forward-test that mirrors a single capital
    // slot and never holds an opposite-side hedge. Don't mark `sig` taken until we
    // actually arm — the fingerprint guard above is what prevents re-taking a
    // level that has already resolved today.
    if (STATE.auto.journal.some(function (j) { return j.status === 'OPEN' || j.status === 'ARMED'; })) return;
    STATE.auto.taken[sig] = true;
    // ATM strike derived independently from spot (nearest 50) — purely a label;
    // the trade is tracked in spot points, not premium.
    var spot = isFinite(STATE.lastClose) ? STATE.lastClose : p.entryRef;
    var strike = Math.round(spot / 50) * 50;
    // ── MARKET FILL (user-chosen, 2026-06-09) ────────────────────────────────
    // Take the order IMMEDIATELY at the current price instead of resting a limit
    // at a pullback level and waiting for a retrace. The old ARMED→fill model gave
    // better entries but lagged (and often MISSED) fast momentum scalps — the user
    // explicitly chose speed: fill now, every signal. We RE-ANCHOR the plan to the
    // actual fill by shifting every level by (fill − entryRef), which preserves the
    // exact stop distance and reward:risk the engine sized — so a market entry is
    // still a scalp-sized, gated trade, just entered at market. Chasing far from the
    // anchor is already blocked upstream: the ANTI-CHASE gate demotes BUY→WATCH once
    // price has run > 1R past the entry in weak-momentum tape (plus the far `extended`
    // backstop), and maybeAutoTrade only acts on a BUY — so `fill` is always within a
    // sane distance of `entryRef`.
    var entryRef = +p.entryRef.toFixed(2);
    var fill = +(isFinite(spot) ? spot : entryRef).toFixed(2);
    var delta = fill - entryRef;                          // shift the whole plan to the actual fill
    var slFill = +(p.sl + delta).toFixed(2);
    var t1Fill = (typeof p.t1 === 'number') ? +(p.t1 + delta).toFixed(2) : null;
    try {
      journalAdd({
        id: 'j' + Date.now() + Math.floor(Math.random() * 1000),
        ts: Date.now(),
        side: setup.optType,
        strike: strike,
        conf: setup.conf || null,
        entry: fill,
        entryLo: fill,
        entryHi: fill,
        sl: slFill,
        t1: t1Fill,
        // Persist the ORIGINAL plan anchor so the reload dedupe fingerprint stays
        // stable (the fill price varies tick-to-tick; the plan level does not).
        planEntry: entryRef,
        planSl: +p.sl.toFixed(2),
        r: (typeof p.rr1 === 'number') ? +p.rr1.toFixed(2) : null,
        status: 'OPEN',           // filled at market on this tick
        outcome: 'OPEN',
        filledTs: Date.now(),
        pts: null, exit: null, exitTs: null
      });
      saveJournal();
      renderJournal();
      renderActiveSignal();   // flip the strip straight to HOLD — we're in, no resting wait
    } catch (_) {}
  }

  // Close OPEN virtual trades on each live spot tick: T1 hit = WIN, SL hit = LOSS
  // (direction-aware), 15:25 IST = EOD close at the last spot. P&L in index points.
  // Self-contained — reads nothing from the paper book.
  function journalTick(ltp) {
    if (!isFinite(ltp) || ltp <= 0) return;
    var eod = eodPassed();
    var now = Date.now();
    // Current CONFIRMED 5m+15m direction from the last setup build (CE/PE/null).
    // Only trusted when both entry-TF trends are present — a missing read (failed
    // fetch / first paint) must NOT be mistaken for "direction lost".
    var d = STATE.setup.data;
    var haveDir = !!(d && d.trends && d.trends['5m'] && d.trends['15m']);
    var dirNow = haveDir ? (d.optType || null) : null;   // 'CE' | 'PE' | null(=5m/15m disagree)
    var changed = false;
    STATE.auto.journal.forEach(function (j) {
      // ── ARMED: resting order, NOT yet filled ─────────────────────────────────
      // Realistic-fill gate. A trade only becomes OPEN once live spot trades back
      // INTO the entry zone — proving the plan's entry was actually reachable. If
      // price never returns (it ran away), the order is cancelled as MISSED (no
      // P&L) instead of booking a fantasy fill at a price the tape never offered.
      if (j.status === 'ARMED') {
        // Entry-zone band (fall back to entry±0.1% for older rows without it).
        var lo = (typeof j.entryLo === 'number') ? j.entryLo : j.entry * 0.999;
        var hi = (typeof j.entryHi === 'number') ? j.entryHi : j.entry * 1.001;
        // FILL: price has traded into the zone. For a CE the entry sits below
        // spot (buy the dip) → fills when price dips to the zone top. For a PE the
        // entry sits above spot (sell the rip) → fills when price lifts to the
        // zone floor. Once filled the existing OPEN exit logic takes over on the
        // NEXT tick (no same-tick fill-and-exit — the fill price is the limit).
        var filled = (j.side === 'CE') ? (ltp <= hi) : (ltp >= lo);
        if (filled) {
          j.status = 'OPEN';
          j.outcome = 'OPEN';
          j.filledTs = now;
          changed = true;
          return;
        }
        // CANCEL → MISSED. The move happened without us, the thesis died, the day
        // closed, or the resting order simply aged out — all "we never got in".
        var ranToT1 = (j.t1 != null) && ((j.side === 'CE') ? (ltp >= j.t1) : (ltp <= j.t1));
        var thesisGone = haveDir && dirNow !== j.side;
        var agedOut = j.ts && (now - j.ts) > MAX_ARM_MS;
        if (ranToT1 || thesisGone || agedOut || eod) {
          j.status = 'CLOSED';
          j.outcome = 'MISSED';
          j.exit = null;
          j.exitTs = now;
          j.pts = null;
          changed = true;
        }
        return;
      }
      if (j.status !== 'OPEN') return;
      var hitT1 = false, hitSL = false;
      if (j.side === 'CE') {                 // bullish: T1 above, SL below
        if (j.t1 != null && ltp >= j.t1) hitT1 = true;
        else if (ltp <= j.sl) hitSL = true;
      } else {                               // PE — bearish: T1 below, SL above
        if (j.t1 != null && ltp <= j.t1) hitT1 = true;
        else if (ltp >= j.sl) hitSL = true;
      }
      // Thesis-invalidation: the 5m+15m direction that justified this trade is
      // gone (they no longer both agree on this side). The reason to hold has
      // evaporated → exit at the live spot. Guarded on a confirmed read so a
      // transient "no data" can't force a close. NOTE: there is intentionally NO
      // hard time-stop — the user manages the timed exit manually on their broker
      // (the 30-min horizon is used only to SIZE targets, see itBuildDirPlan).
      var thesisDead = !hitT1 && !hitSL && haveDir && dirNow !== j.side;
      if (!hitT1 && !hitSL && !thesisDead && !eod) return;
      var exitSpot = hitT1 ? j.t1 : (hitSL ? j.sl : ltp);
      var pts = (j.side === 'CE') ? (exitSpot - j.entry) : (j.entry - exitSpot);
      j.status = 'CLOSED';
      j.outcome = hitT1 ? 'T1' : (hitSL ? 'SL' : (thesisDead ? 'THESIS' : 'EOD'));
      j.exit = +exitSpot.toFixed(2);
      j.exitTs = now;
      j.pts = +pts.toFixed(2);
      changed = true;
    });
    if (changed) { saveJournal(); renderJournal(); }
    // Always repaint the live "what do I do now" strip so HOLD P&L tracks each
    // tick and an EXIT shows the instant a trade closes.
    try { renderActiveSignal(ltp); } catch (_) {}
  }

  // ═══════════════════ ACTIVE SIGNAL STRIP ═══════════════════
  // The single "what do I do RIGHT NOW" line for broker execution. This tab is a
  // signal MONITOR — the user enters/exits on their broker app — so every state
  // change has to be visible here, not just silently logged. Driven by the live
  // verdict (STATE.setup.data) + the signal journal's open / last-closed trade.
  // States: ENTER (a fresh, not-yet-taken BUY printed) · HOLD (a virtual trade is
  // live, with running points + whether the setup still backs it) · EXITED (just
  // closed, with reason + result) · WAIT/WATCH (stay flat). On-screen only.
  function itHhmm(ms) {
    try {
      return new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (_) { return ''; }
  }
  function itExitReasonLabel(o) {
    return o === 'T1' ? 'Target hit'
      : o === 'SL' ? 'Stop hit'
      : o === 'THESIS' ? 'Setup invalidated (5m/15m turned)'
      : o === 'TIME' ? 'Time exit'   // legacy entries only — hard time-stop removed
      : o === 'EOD' ? 'Day close (15:25)'
      : o === 'EXPIRED' ? 'Expired (carried overnight)'
      : o === 'MISSED' ? 'Missed (price never reached entry)'
      : (o || 'Closed');
  }
  function itSignalRow(action, side, detail, big, bigTone, sub) {
    var sideTag = side ? '<span class="it-sig-side ' + (side === 'CE' ? 'ce' : 'pe') + '">' + side + '</span>' : '';
    var bigHtml = big ? '<span class="it-sig-big it-sig-' + bigTone + '">' + big + '</span>' : '';
    return '<div class="it-sig-line">'
      + '<span class="it-sig-action">' + action + '</span>'
      + sideTag
      + '<span class="it-sig-detail">' + detail + '</span>'
      + bigHtml
      + '</div>'
      + (sub ? '<div class="it-sig-sub">' + sub + '</div>' : '');
  }
  // `liveLtp` (optional) is the freshest spot from pollTick so HOLD P&L tracks
  // each tick even between setup rebuilds; falls back to STATE.lastClose.
  function renderActiveSignal(liveLtp) {
    var host = $('it-active-signal');
    if (!host) return;
    if (!getToken()) { host.hidden = true; host.innerHTML = ''; return; }

    var open = null, armed = null;
    for (var i = 0; i < STATE.auto.journal.length; i++) {
      var jj = STATE.auto.journal[i];
      if (jj.status === 'OPEN' && !open) open = jj;
      else if (jj.status === 'ARMED' && !armed) armed = jj;
    }
    var spot = isFinite(liveLtp) ? liveLtp : (isFinite(STATE.lastClose) ? STATE.lastClose : null);
    var d = STATE.setup.data;
    var haveDir = !!(d && d.trends && d.trends['5m'] && d.trends['15m']);
    var dirNow = haveDir ? (d.optType || null) : null;
    var mktOpen = (typeof isMarketOpen === 'function') ? isMarketOpen() : true;
    var state, html;

    if (open) {
      // ── HOLD ──────────────────────────────────────────────────────────────
      var ltp = (spot != null) ? spot : open.entry;
      var pts = (open.side === 'CE') ? (ltp - open.entry) : (open.entry - ltp);
      var pos = pts >= 0;
      var weakening = haveDir && dirNow !== open.side;   // direction no longer backs it
      state = 'hold';
      html = itSignalRow('HOLD', open.side,
        'Entry ' + fmtPrice(open.entry) + ' &middot; LTP ' + fmtPrice(ltp)
          + ' &middot; SL ' + fmtPrice(open.sl)
          + (open.t1 != null ? ' &middot; T1 ' + fmtPrice(open.t1) : ''),
        (pos ? '+' : '') + pts.toFixed(1) + ' pts',
        pos ? 'pos' : 'neg',
        !mktOpen
          ? 'Market closed &mdash; position carried; no live ticks until the next session'
          : weakening
            ? '&#9888; Setup weakening &mdash; 5m/15m no longer agree; be ready to exit on your broker'
            : 'Setup still valid &mdash; hold to T1 / SL (exit manually if it stalls past ~' + SCALP_HORIZON_MIN + 'm)');
    } else if (armed) {
      // ── ARMED ──────────────────────────────────────────────────────────────
      // A resting order is waiting for price to come back to the entry. NOT a
      // "buy now" — we have NOT entered. The strip stays neutral-amber until the
      // tape actually trades into the zone (then it flips to HOLD) or the order is
      // cancelled as MISSED. This is what stops the fantasy back-to-back fills.
      var aWord = armed.side === 'CE' ? 'dips to' : 'rises to';
      var zone = fmtPrice(armed.entryLo) + '\u2013' + fmtPrice(armed.entryHi);
      state = 'armed';
      html = itSignalRow('PENDING', armed.side,
        'Wait for price &mdash; entry ' + zone
          + (spot != null ? ' &middot; LTP ' + fmtPrice(spot) : '')
          + (armed.t1 != null ? ' &middot; T1 ' + fmtPrice(armed.t1) : ''),
        'NO TRADE YET', armed.side === 'CE' ? 'pos' : 'neg',
        !mktOpen
          ? 'Market closed &mdash; resting order parked; nothing fills until the next session'
          : 'Resting order &mdash; fills ONLY if price ' + aWord + ' the entry zone. Don\u2019t chase &mdash; if it runs away this cancels as MISSED.');
    } else if (!mktOpen) {
      // ── MARKET CLOSED ───────────────────────────────────────────────────────
      // Off-hours the engine still computes a directional read, but it is a
      // PREVIEW of the next session's plan — never an actionable "buy now". Show a
      // clear closed banner with the next-open time so nobody places an order into
      // a shut market. (Mirrors the WHY note's "test/preview" framing.)
      state = 'closed';
      var nextOpen = (typeof nextOpenLabel === 'function') ? nextOpenLabel() : '';
      var hasPreview = !!(haveDir && dirNow && d && (d.verdict === 'BUY' || d.verdict === 'WATCH') && d.plan && typeof d.plan.entryRef === 'number');
      var closedDetail = hasPreview
        ? ('Next-session bias ' + dirNow + ' near ' + fmtPrice(d.plan.entryRef))
        : 'No clean 5m + 15m direction';
      html = itSignalRow('MARKET CLOSED', hasPreview ? dirNow : null, closedDetail, '', 'pos',
        'Preview only &mdash; don\u2019t place orders now' + (nextOpen ? ' &middot; ' + nextOpen : ''));
    } else {
      var newest = STATE.auto.journal.length ? STATE.auto.journal[0] : null;
      var todayKey = istDayKey();
      var lastClosedToday = (newest && newest.status === 'CLOSED' && newest.ts && istDayKeyOf(newest.ts) === todayKey) ? newest : null;
      var buyReady = !!(d && d.verdict === 'BUY' && d.optType && d.plan
        && typeof d.plan.entryRef === 'number' && typeof d.plan.sl === 'number');
      var freshBuy = false;
      if (buyReady) {
        var sig = sigOf(d.optType, todayKey, d.plan.entryRef, d.plan.sl);
        freshBuy = !STATE.auto.taken[sig];
      }
      if (buyReady && freshBuy) {
        // ── ENTER ───────────────────────────────────────────────────────────
        state = 'enter';
        html = itSignalRow('ENTER', d.optType,
          'Entry ' + fmtPrice(d.plan.entryRef) + ' &middot; SL ' + fmtPrice(d.plan.sl)
            + (typeof d.plan.t1 === 'number' ? ' &middot; T1 ' + fmtPrice(d.plan.t1) : ''),
          'BUY ' + d.optType, d.optType === 'CE' ? 'pos' : 'neg',
          (d.conf ? d.conf + ' confidence &middot; ' : '') + 'take the ' + d.optType + ' on your broker now');
      } else if (lastClosedToday) {
        // ── EXITED / MISSED (most recent close today) ─────────────────────────
        state = 'exited';
        var wasMiss = lastClosedToday.outcome === 'MISSED';
        var p = lastClosedToday.pts;
        var hasP = (typeof p === 'number');
        var sign = wasMiss ? 'NO FILL' : (hasP ? ((p >= 0 ? '+' : '') + p.toFixed(1) + ' pts') : '');
        html = itSignalRow(wasMiss ? 'MISSED' : 'EXITED', lastClosedToday.side,
          itExitReasonLabel(lastClosedToday.outcome)
            + ' &middot; ' + (wasMiss ? 'cancelled ' : 'closed ') + itHhmm(lastClosedToday.exitTs),
          sign, (hasP && p >= 0) ? 'pos' : 'neg',
          wasMiss
            ? 'You were never in &mdash; price ran away before tagging the entry. Waiting for the next clean setup.'
            : 'Square off on your broker if still in &mdash; waiting for the next clean setup');
      } else if (d && d.bias && d.bias.side && !d.bias.triggered) {
        // ── BIAS (armed, waiting for the 5m trigger) ──────────────────────────
        // Higher timeframes have picked a side but the 5m hasn't fired yet. Show
        // it as a GET-READY so the user is watching the right direction instead of
        // a blank WAIT — but it is explicitly NOT an entry.
        state = 'bias';
        var bSide = d.bias.side;
        html = itSignalRow('BIAS', bSide,
          'Higher TFs lean ' + (bSide === 'CE' ? 'up' : 'down') + ' &mdash; waiting for a 5m trigger',
          'GET READY', bSide === 'CE' ? 'pos' : 'neg',
          'Don\u2019t enter yet &mdash; a ' + bSide + ' fires the moment the 5m prints a fresh CHoCH/BOS ' + (bSide === 'CE' ? 'up' : 'down') + '. Watch this one closely.');
      } else {
        // ── WAIT / WATCH ──────────────────────────────────────────────────────
        var v = (d && d.verdict) || 'WAIT';
        state = (v === 'WATCH') ? 'watch' : 'wait';
        var msg = (haveDir && dirNow)
          ? ('Bias ' + dirNow + ' &mdash; not a clean entry yet')
          : 'No clean 5m + 15m direction yet';
        html = itSignalRow(state === 'watch' ? 'WATCH' : 'WAIT', null, msg, '', 'pos',
          'Stay flat &mdash; no trade until a BUY prints');
      }
    }
    host.dataset.state = state;
    host.innerHTML = html;
    host.hidden = false;
  }

  // Periodic setup re-evaluation — ONLY while auto-trade is armed. loadSetup
  // contains the maybeAutoTrade() hook, so re-running it on a cadence is what
  // lets a fresh BUY (formed after a new bar closes) get taken without a manual
  // refresh. Self-gates on market-open + not-paused so it never burns API
  // off-hours. 60s cadence is well inside a 5m bar; the engine anchors on the
  // last CLOSED bar (non-repainting) so there's nothing to gain from faster.
  function autoSetupTick() {
    if (!STATE.active || !STATE.auto.on) return;
    if (typeof apiPaused === 'function' && apiPaused()) return;
    if (!isMarketOpen()) return;
    loadSetup(false);
  }
  // Fast TRIGGER re-check (cheap, NO fetch). The 60s autoSetupTick is fine for
  // discovering a fresh higher-TF bias, but once a bias is ARMED we want to catch
  // the 5m CHoCH/BOS trigger within seconds — not wait up to a full minute. This
  // re-runs the setup off the LIVE 5m (STATE.raw, updated every chart tick) plus
  // the already-CACHED higher-TF candles, so it costs zero API calls. It only does
  // work while a bias is armed (or a position is live), and skips silently if a
  // higher-TF cache is cold (the 60s tick will refill it). Non-repainting — the
  // trigger detector still reads confirmed bars (itFreshBreakTrigger).
  function fastTriggerTick() {
    if (!STATE.active || !STATE.auto.on) return;
    if (typeof apiPaused === 'function' && apiPaused()) return;
    if (!isMarketOpen()) return;
    var d = STATE.setup.data;
    var armedBias = !!(d && d.bias && d.bias.side && !d.bias.triggered);
    var hasLive = STATE.auto.journal.some(function (j) { return j.status === 'OPEN' || j.status === 'ARMED'; });
    var freshBuy = !!(d && d.verdict === 'BUY' && d.optType);   // a ready BUY waiting to be placed
    if (!armedBias && !hasLive && !freshBuy) return;   // nothing time-sensitive to watch
    var rawByTf = {}, ready = true;
    IT_SETUP_TFS.forEach(function (tf) {
      if (tf === STATE.timeframe && STATE.raw && STATE.raw.length) { rawByTf[tf] = STATE.raw; return; }
      var c = STATE.fetchCache[tf];
      if (c && c.raw && c.raw.length) rawByTf[tf] = c.raw; else ready = false;
    });
    if (!ready || !rawByTf['5m']) return;     // need a 5m series to read the trigger
    var volOpts = { breakouts: (STATE.timeframe === '5m') ? STATE.breakouts : null };
    var setup; try { setup = buildIntradaySetup(rawByTf, volOpts); } catch (_) { return; }
    if (!setup) return;
    STATE.setup.data = setup;
    try { renderSetupPlan(setup); renderTradePlan(setup); } catch (_) {}
    try { maybeAutoTrade(setup); } catch (_) {}
    try { renderActiveSignal(); } catch (_) {}
  }
  function startAutoSetupRefresh() {
    if (STATE.auto.setupTimer) return;
    STATE.auto.setupTimer = setInterval(autoSetupTick, 60000);
    if (!STATE.auto.fastTimer) STATE.auto.fastTimer = setInterval(fastTriggerTick, 15000);
  }
  function stopAutoSetupRefresh() {
    if (STATE.auto.setupTimer) { clearInterval(STATE.auto.setupTimer); STATE.auto.setupTimer = null; }
    if (STATE.auto.fastTimer) { clearInterval(STATE.auto.fastTimer); STATE.auto.fastTimer = null; }
  }

  function renderJournal() {
    var toggle = $('it-auto-toggle');
    if (toggle) {
      toggle.dataset.on = STATE.auto.on ? 'true' : 'false';
      toggle.setAttribute('aria-checked', STATE.auto.on ? 'true' : 'false');
      var lbl = $('it-auto-toggle-label');
      if (lbl) lbl.textContent = STATE.auto.on ? 'Auto-Trade ON' : 'Auto-Trade OFF';
    }
    // Live vs Archive view. Archive is the read-only history of cleared trades.
    var isArchive = STATE.auto.viewMode === 'archive';
    var vLive = $('it-view-live'), vArch = $('it-view-archive');
    if (vLive) { vLive.classList.toggle('is-on', !isArchive); vLive.setAttribute('aria-selected', !isArchive ? 'true' : 'false'); }
    if (vArch) { vArch.classList.toggle('is-on', isArchive); vArch.setAttribute('aria-selected', isArchive ? 'true' : 'false'); }
    // Clear acts on the LIVE journal only — disable it while browsing the archive.
    var clearBtn = document.querySelector('.it-journal-clear');
    if (clearBtn) { clearBtn.disabled = isArchive; clearBtn.title = isArchive ? 'Switch to Live to clear the current journal' : 'Archive & clear the on-screen journal (history is kept in the archive JSON)'; }
    var allRows = isArchive ? (STATE.auto.archive || []) : STATE.auto.journal;
    var hhmm = function (ms) {
      return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
    };
    var dayLabel = function (ms) {
      return new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
    };

    // ── Day-wise filter ──────────────────────────────────────────────────────
    // Distinct IST days present, newest first, fed into the dropdown. The chosen
    // day scopes BOTH the table and the stat tiles so the win-rate you read is for
    // that session only. 'all' = the whole journal.
    var dayKeys = [];
    var seenDay = {};
    allRows.forEach(function (r) {
      if (!r || !r.ts) return;
      var k = istDayKeyOf(r.ts);
      if (!seenDay[k]) { seenDay[k] = true; dayKeys.push(k); }
    });
    dayKeys.sort(function (a, b) { return a < b ? 1 : (a > b ? -1 : 0); });   // newest day first
    var sel = STATE.auto.dayFilter || 'all';
    if (sel !== 'all' && !seenDay[sel]) sel = 'all';                          // chosen day gone (cleared) → reset
    STATE.auto.dayFilter = sel;
    // Populate the custom (fully app-themed) day dropdown: a current-label button
    // + a listbox of options. No native <select> → no un-themable OS popup.
    var firstTs = {};
    allRows.forEach(function (r) { if (r && r.ts) { var k = istDayKeyOf(r.ts); if (firstTs[k] == null) firstTs[k] = r.ts; } });
    var curLabel = (sel === 'all') ? 'All days' : (firstTs[sel] != null ? dayLabel(firstTs[sel]) : 'All days');
    var curEl = $('it-journal-day-cur');
    if (curEl) curEl.textContent = curLabel;
    var menu = $('it-journal-day-menu');
    if (menu) {
      var optRow = function (val, label) {
        var on = (val === sel) ? ' is-sel' : '';
        return '<li class="it-journal-day-opt' + on + '" role="option" tabindex="-1"'
          + ' aria-selected="' + (val === sel ? 'true' : 'false') + '"'
          + ' data-day="' + val + '" onclick="window.itJournalSetDay(\'' + val + '\')">' + label + '</li>';
      };
      menu.innerHTML = optRow('all', 'All days') + dayKeys.map(function (k) { return optRow(k, dayLabel(firstTs[k])); }).join('');
    }
    var dayBtn = $('it-journal-day-btn');
    if (dayBtn) dayBtn.disabled = !allRows.length;
    if (!allRows.length) itJournalCloseDayMenu();

    // Rows in scope for the table + stats (filtered by the chosen day).
    var rows = (sel === 'all') ? allRows : allRows.filter(function (r) { return r && r.ts && istDayKeyOf(r.ts) === sel; });

    // Stats (P&L in INDEX POINTS). Scored = CLOSED trades that actually FILLED and
    // resolved on T1/SL (have a numeric pts). ARMED (resting) and MISSED (never
    // filled) carry no P&L and are deliberately excluded from the win-rate.
    var scored = rows.filter(function (r) { return r.status === 'CLOSED' && typeof r.pts === 'number'; });
    var wins = scored.filter(function (r) { return r.pts > 0; }).length;
    var totalPts = scored.reduce(function (a, r) { return a + (r.pts || 0); }, 0);
    setText('it-j-signals', String(rows.length));
    setText('it-j-taken', String(scored.length));
    setText('it-j-winrate', scored.length ? Math.round(wins / scored.length * 100) + '%' : '\u2014');
    setText('it-j-pnl', scored.length ? (totalPts >= 0 ? '+' : '') + totalPts.toFixed(1) + ' pts' : '\u2014');
    var pnlEl = $('it-j-pnl'); if (pnlEl) pnlEl.style.color = scored.length ? (totalPts >= 0 ? 'var(--bull)' : 'var(--bear)') : '';

    var tb = $('it-journal-tbody');
    if (!tb) return;
    if (!rows.length) {
      var emptyMsg;
      if (allRows.length) emptyMsg = 'No signals on this day. Pick another day or <b>All days</b>.';
      else if (isArchive) emptyMsg = 'Archive is empty. Cleared trades will appear here \u2014 they\u2019re kept safe when you press <b>Clear</b> on the Live journal.';
      else emptyMsg = 'No signals logged yet. Turn on <b>Auto-Trade</b>; every BUY the engine fires arms a virtual spot trade here, fills only on a genuine retest, and is scored in points when it hits T1 / SL.';
      tb.innerHTML = '<tr><td colspan="10" class="it-journal-empty">' + emptyMsg + '</td></tr>';
      return;
    }
    // Newest signal on top (descending by entry time), regardless of how the
    // journal array happens to be ordered in storage.
    var ordered = rows.slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    tb.innerHTML = ordered.map(function (r) {
      var sideCls = r.side === 'CE' ? 'ce' : 'pe';
      var when = new Date(r.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
      var confRaw = (r.conf || '').toString().toUpperCase();
      var confCls = confRaw === 'HIGH' ? 'high' : ((confRaw === 'MEDIUM' || confRaw === 'MED') ? 'med' : (confRaw === 'LOW' ? 'low' : ''));
      var confHtml = confRaw ? '<span class="it-conf-tag ' + confCls + '">' + confRaw + '</span>' : '\u2014';
      // Status pill: ARMED (resting) · OPEN (filled, live) · MISSED (never filled)
      // · win / loss / flat (filled + resolved on T1 / SL).
      var outCls, outcome;
      if (r.status === 'ARMED') { outCls = 'armed'; outcome = 'PENDING'; }
      else if (r.status === 'OPEN') { outCls = 'open'; outcome = 'OPEN'; }
      else if (r.outcome === 'MISSED') { outCls = 'miss'; outcome = 'MISSED'; }
      else {
        outCls = (r.pts > 0 ? 'win' : (r.pts < 0 ? 'loss' : 'flat'));
        outcome = r.outcome + (typeof r.pts === 'number' ? ' \u00B7 ' + (r.pts >= 0 ? '+' : '') + r.pts.toFixed(1) + ' pts' : '');
      }
      // Exit cell: ARMED = still waiting; MISSED = the time it was cancelled (no
      // fill); a filled close shows the exit time + the price it filled at.
      var exitHtml;
      if (r.status === 'ARMED') {
        exitHtml = '<span class="it-jc-exit-wait">waiting&hellip;</span>';
      } else if (r.status === 'CLOSED' && r.exitTs) {
        exitHtml = '<span class="it-jc-exit-t">' + hhmm(r.exitTs) + '</span>'
          + (r.exit != null
            ? '<span class="it-jc-exit-px">@ ' + r.exit + '</span>'
            : '<span class="it-jc-exit-px it-jc-exit-nofill">no fill</span>');
      } else {
        exitHtml = '\u2014';
      }
      return '<tr>'
        + '<td class="it-jc-when">' + when + '</td>'
        + '<td><span class="it-side-tag ' + sideCls + '">BUY ' + r.side + '</span></td>'
        + '<td class="it-num">' + (r.strike != null ? r.strike : '\u2014') + '</td>'
        + '<td>' + confHtml + '</td>'
        + '<td class="it-num">' + (r.entry != null ? r.entry : '\u2014') + '</td>'
        + '<td class="it-num it-num-sl">' + (r.sl != null ? r.sl : '\u2014') + '</td>'
        + '<td class="it-num it-num-t1">' + (r.t1 != null ? r.t1 : '\u2014') + '</td>'
        + '<td>' + (r.r != null ? '<span class="it-r-chip">1:' + r.r + '</span>' : '\u2014') + '</td>'
        + '<td><span class="it-out-tag ' + outCls + '">' + outcome + '</span></td>'
        + '<td class="it-jc-exit">' + exitHtml + '</td>'
        + '</tr>';
    }).join('');
  }

  window.itToggleAutoTrade = function () {
    STATE.auto.on = !STATE.auto.on;
    try { localStorage.setItem(AUTO_KEY, STATE.auto.on ? '1' : '0'); } catch (_) {}
    renderJournal();
    if (STATE.auto.on) {
      startAutoSetupRefresh();
      // Arming with a BUY already on screen: act on it immediately.
      if (STATE.setup.data) { try { maybeAutoTrade(STATE.setup.data); } catch (_) {} }
    } else {
      stopAutoSetupRefresh();
    }
    return STATE.auto.on;
  };
  // Load the read-only ARCHIVE (cleared history) from localStorage + (on
  // localhost) the server file, newest-first. Merges both sources, de-duped by id.
  function loadArchive(done) {
    var fromLocal = [];
    try { var a = JSON.parse(localStorage.getItem(ARCHIVE_KEY)); if (Array.isArray(a)) fromLocal = a; } catch (_) {}
    var apply = function (extra) {
      var byId = {};
      var out = [];
      fromLocal.concat(extra || []).forEach(function (r) {
        if (!r) return;
        if (r.id) { if (byId[r.id]) return; byId[r.id] = true; }
        out.push(r);
      });
      out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      STATE.auto.archive = out;
      STATE.auto.archiveLoaded = true;
      if (done) done();
    };
    if (!journalServerAvailable()) { apply([]); return; }
    try {
      fetch(ARCHIVE_URL, { credentials: 'omit', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { apply((s && Array.isArray(s.journal)) ? s.journal : []); })
        .catch(function () { apply([]); });
    } catch (_) { apply([]); }
  }
  // Live ↔ Archive view switch. Archive is READ-ONLY (browse cleared trades).
  window.itJournalSetView = function (mode) {
    var next = (mode === 'archive') ? 'archive' : 'live';
    STATE.auto.viewMode = next;
    STATE.auto.dayFilter = 'all';        // reset the day picker when switching views
    itJournalCloseDayMenu();
    if (next === 'archive' && !STATE.auto.archiveLoaded) {
      renderJournal();                   // paint the toggle state immediately
      loadArchive(function () { renderJournal(); });
      return;
    }
    renderJournal();
  };
  // Day-wise filter: scope the table + stat tiles to one IST session (or 'all').
  // View-only — never mutates the journal.
  window.itJournalSetDay = function (val) {
    STATE.auto.dayFilter = (val && val !== 'all') ? String(val) : 'all';
    itJournalCloseDayMenu();
    renderJournal();
  };
  // Custom day dropdown open/close (app-themed listbox; no native <select>).
  function itJournalCloseDayMenu() {
    var menu = $('it-journal-day-menu');
    var btn = $('it-journal-day-btn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (STATE.auto._dayMenuDocHandler) {
      document.removeEventListener('mousedown', STATE.auto._dayMenuDocHandler, true);
      document.removeEventListener('keydown', STATE.auto._dayMenuKeyHandler, true);
      STATE.auto._dayMenuDocHandler = null;
      STATE.auto._dayMenuKeyHandler = null;
    }
  }
  window.itJournalToggleDayMenu = function () {
    var menu = $('it-journal-day-menu');
    var btn = $('it-journal-day-btn');
    if (!menu || !btn || btn.disabled) return;
    if (!menu.hidden) { itJournalCloseDayMenu(); return; }
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Dismiss on an outside click or Escape (capture phase so it beats the toggle).
    STATE.auto._dayMenuDocHandler = function (e) {
      var wrap = $('it-journal-day');
      if (wrap && !wrap.contains(e.target)) itJournalCloseDayMenu();
    };
    STATE.auto._dayMenuKeyHandler = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) { itJournalCloseDayMenu(); try { btn.focus(); } catch (_) {} }
    };
    document.addEventListener('mousedown', STATE.auto._dayMenuDocHandler, true);
    document.addEventListener('keydown', STATE.auto._dayMenuKeyHandler, true);
  };
  // Append the about-to-be-cleared rows to the durable ARCHIVE before emptying the
  // live journal, so "Clear" tidies the on-screen table WITHOUT destroying history.
  // The archive lives in its own localStorage key AND its own server JSON
  // (data/intraday-journal-archive.json) — independent of the live store, so it is
  // never overwritten by the empty save that follows. De-duped by row id.
  function archiveRows(rowsToArchive, done) {
    var rows = (rowsToArchive || []).slice();
    if (!rows.length) { if (done) done(); return; }
    var merge = function (existing) {
      var byId = {};
      var out = [];
      (existing || []).concat(rows).forEach(function (r) {
        if (!r || !r.id) { out.push(r); return; }
        if (byId[r.id]) return;          // keep the first occurrence (existing wins)
        byId[r.id] = true;
        out.push(r);
      });
      out.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });   // newest first
      if (out.length > 5000) out.length = 5000;                          // bound the archive
      return out;
    };
    // 1) localStorage archive (always available).
    var localArchive = [];
    try { var raw = localStorage.getItem(ARCHIVE_KEY); var a = JSON.parse(raw); if (Array.isArray(a)) localArchive = a; } catch (_) {}
    var mergedLocal = merge(localArchive);
    try { localStorage.setItem(ARCHIVE_KEY, JSON.stringify(mergedLocal)); } catch (_) {}
    // 2) server archive JSON (localhost only) — read-merge-write so concurrent
    //    days accumulate instead of clobbering each other.
    if (!journalServerAvailable()) { if (done) done(); return; }
    var finish = function () { if (done) done(); };
    try {
      fetch(ARCHIVE_URL, { credentials: 'omit', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) {
          var serverArchive = (s && Array.isArray(s.journal)) ? s.journal : [];
          var mergedServer = merge(serverArchive);
          return fetch(ARCHIVE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({ journal: mergedServer, savedAt: new Date().toISOString() })
          });
        })
        .catch(function () {})
        .then(finish);
    } catch (_) { finish(); }
  }
  window.itClearJournal = function () {
    if (!STATE.auto.journal.length) return;
    var doClear = function () {
      var snapshot = STATE.auto.journal.slice();
      archiveRows(snapshot, function () {
        STATE.auto.journal = [];
        STATE.auto.taken = {};
        STATE.auto.dayFilter = 'all';
        STATE.auto.archiveLoaded = false;   // force a fresh archive load next time it's viewed
        saveJournal();
        renderJournal();
      });
    };
    // App-themed confirm (dark/light aware) instead of the native OS dialog.
    if (typeof window.itpConfirm === 'function') {
      window.itpConfirm({
        title: 'Clear signal journal?',
        message: 'The on-screen journal is emptied, but every row is first copied to the archive (data/intraday-journal-archive.json) so nothing is lost.',
        confirmLabel: 'ARCHIVE & CLEAR',
        cancelLabel: 'KEEP',
        danger: true
      }).then(function (ok) { if (ok) doClear(); });
      return;
    }
    if (typeof window.confirm === 'function' && !window.confirm('Clear the on-screen journal? Rows are archived to data/intraday-journal-archive.json first.')) return;
    doClear();
  };

  // ---- Lifecycle (called from navigation.js show()/away) ----
  // Paints the dedicated intraday pause pill (green = active, amber = paused).
  // Reuses the global .sw-api-pause-* styling so it matches the swing banner.
  function renderApiPauseBanner() {
    var host = $('it-api-pause-banner');
    if (!host) return;
    var paused = itIsApiPaused();
    host.dataset.state = paused ? 'paused' : 'active';
    // Connection/manage pill + a single on/off toggle live in the SAME bar,
    // which is now the section header (title left). Mirrors the swing bar.
    var hasKey = !!getToken();
    var connDot = 'sw-api-dot' + (hasKey ? ' sw-api-dot--on' : '');
    var connLbl = hasKey ? 'API Connected' : 'Connect API';
    var GEAR = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none"'
      + ' stroke="currentColor" stroke-width="2" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="3"></circle>'
      + '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path>'
      + '</svg>';
    var switchTitle = paused
      ? 'API paused — click to resume live candle / LTP / VIX / chain fetches'
      : 'API live — click to pause and protect your Upstox quota';
    host.innerHTML = ''
      + '<div class="sw-api-pause-meta">'
      +   '<h2 class="sw-api-title">INTRADAY TRADE</h2>'
      +   '<button type="button" class="sw-api-switch" role="switch"'
      +     ' data-on="' + (paused ? 'false' : 'true') + '"'
      +     ' aria-checked="' + (paused ? 'false' : 'true') + '"'
      +     ' onclick="window.itToggleApiPause()" data-tip="' + switchTitle + '">'
      +     '<span class="sw-api-switch-track"><span class="sw-api-switch-knob"></span></span>'
      +     '<span class="sw-api-switch-label">' + (paused ? 'Paused' : 'Live') + '</span>'
      +   '</button>'
      + '</div>'
      + '<div class="sw-api-actions">'
      +   '<button type="button" class="sw-api-pill"'
      +     ' onclick="gotoId(\'api-setup\')" data-tip="Manage Upstox API token">'
      +     '<span class="' + connDot + '"></span>'
      +     '<span>' + connLbl + '</span>'
      +     GEAR
      +   '</button>'
      + '</div>';
    wireFibTooltips(host); // themed [data-tip] bubble — no native OS title
  }

  // Toggle the dedicated intraday pause. On PAUSE: stop the poller (no more
  // live fetches). On RESUME: reload the chart + restart polling + re-pull the
  // context cards so the tab catches up. Fail-safe — only acts while the tab is
  // active; the banner always re-renders so the state is visible.
  window.itToggleApiPause = function () {
    var now = !itIsApiPaused();
    itSetApiPaused(now);
    try { renderApiPauseBanner(); } catch (_) {}
    if (!STATE.active) return now;
    if (now) {
      stopPoller();
      updateLiveBadgeAndStatus(STATE.timeframe);
    } else {
      renderChart(STATE.timeframe, { preserveView: true }).then(function () {
        if (STATE.active) startPoller();
      }, function () {
        if (STATE.active) startPoller();
      });
      loadCards(true);
      loadSetup(true);
      // Resume the intraday paper book's option-LTP polling + strike fill.
      if (typeof window.itpActivate === 'function') {
        try { window.itpActivate(); } catch (_) {}
      }
    }
    return now;
  };

  // ── Collapsible (accordion) sections — progressive disclosure (de-clutter).
  // Native <details>; we persist each section's open/closed state so the user's
  // chosen layout survives reloads. The default open-state comes from the markup
  // ([open] attr); once the user toggles a section, their stored choice wins.
  var ACC_KEY = 'it_accordions_v2';
  function wireAccordions() {
    var nodes = document.querySelectorAll('#intraday-trade details.it-acc[data-acc]');
    if (!nodes || !nodes.length) return;
    var st;
    try { st = JSON.parse(localStorage.getItem(ACC_KEY) || '{}') || {}; } catch (_) { st = {}; }
    Array.prototype.forEach.call(nodes, function (d) {
      var key = d.getAttribute('data-acc');
      if (Object.prototype.hasOwnProperty.call(st, key)) d.open = !!st[key];
      if (d._accWired) return;
      d._accWired = true;
      d.addEventListener('toggle', function () {
        var cur;
        try { cur = JSON.parse(localStorage.getItem(ACC_KEY) || '{}') || {}; } catch (_) { cur = {}; }
        cur[key] = d.open;
        try { localStorage.setItem(ACC_KEY, JSON.stringify(cur)); } catch (_) {}
      });
    });
  }

  function activate() {
    STATE.active = true;
    ensureThemeObserver();
    try { renderApiPauseBanner(); } catch (_) {}
    // Auto-trade + signal journal: read persisted state, paint, hydrate the
    // durable journal JSON, then start the outcome reconciler.
    try {
      loadAuto();
      renderJournal();
      renderActiveSignal();
      hydrateJournalFromServer(function () { renderJournal(); renderActiveSignal(); });
      if (STATE.auto.on) startAutoSetupRefresh();   // resume periodic eval if armed before
    } catch (_) {}
    // Defer one frame so the lazily-injected content DOM is wired up.
    setTimeout(function () {
      if (!STATE.active) return;
      // Themed tooltip for the FIB direction pill (data-tip → shared sw-zoi-tip
      // bubble). Idempotent (assigns onmouseover), so safe on every activate.
      try { wireFibTooltips($('it-chart-legend')); } catch (_) {}
      // Restore persisted accordion open/closed state for the collapsible decks.
      try { wireAccordions(); } catch (_) {}
      renderChart(STATE.timeframe).then(function () {
        if (STATE.active) startPoller();
      }, function () {
        if (STATE.active) startPoller();
      });
      // Auto-fetch the context cards ONCE on open (fire-and-forget — never
      // blocks the chart). Manual Refresh re-pulls thereafter.
      loadCards(false);
      // Build the multi-TF Setup + Trade plan once on open (fire-and-forget).
      // Manual Refresh re-reads thereafter; levels are closed-bar / prev-session
      // based so they don't need per-tick recompute.
      loadSetup(false);
      // Bring up the independent intraday paper-trading book: hydrate its
      // durable server JSON, render, fill the strike picker, start option
      // polling if there's anything to price.
      if (typeof window.itpActivate === 'function') {
        try { window.itpActivate(); } catch (_) {}
      }
      // Bring up the intraday-owned option-chain dashboard (renders the cached
      // chain if present, else triggers one fetch; starts its own 30s refresh).
      if (typeof window.itcActivate === 'function') {
        try { window.itcActivate(); } catch (_) {}
      }
    }, 50);
  }
  function deactivate() {
    STATE.active = false;
    stopPoller();
    stopAutoSetupRefresh();
    // Tear down the LWC instance so we don't keep a hidden canvas + its
    // internal rAF alive on a tab the user has left.
    disposeChart();
  }

  window.itActivate = activate;
  window.itDeactivate = deactivate;
  window.itCardsRefresh = function () { loadCards(true); };
  // Intraday-owned option-chain fetch — the paper book calls THIS (never the
  // Options tab's window.upFetchChain). `force` re-pulls even if cached.
  window.itFetchChain = function (force) { return ensureChainLoaded(force); };
  // Expose the themed [data-tip] tooltip wirer so sibling intraday modules
  // (e.g. scripts/intraday-chain.js) can reuse the same dark/light bubble.
  window.itWireTooltips = wireFibTooltips;
  // Intraday-owned market-hours helpers (real IST fallback when the shared
  // holiday-aware impl from the Options tab isn't loaded). The paper book
  // prefers these over window.isMarketOpen so it never assumes "always open".
  window.itIsMarketOpen = isMarketOpen;
  window.itNextOpenLabel = nextOpenLabel;

  // Guarded test hook — publishes the closure-private Setup/Trade-plan engine
  // ONLY when a Node sandbox sets window.__IT_TEST__ before load (mirrors the
  // swing __SWING_TEST__ convention). No-op in the browser; nothing leaks.
  if (typeof window !== 'undefined' && window.__IT_TEST__) {
    window.__itExports = {
      classifyTfTrend: classifyTfTrend,
      itCollectLevels: itCollectLevels,
      buildIntradaySetup: buildIntradaySetup,
      // Two-stage (BIAS → TRIGGER) internals — for the regression guard.
      itHtfBias: itHtfBias,
      itFreshBreakTrigger: itFreshBreakTrigger,
      // Room-to-wall gate (don't sell into support / buy into resistance).
      itNearestWall: itNearestWall,
      itWallRR: itWallRR,
      // Volume confirmation gate (reject thin-volume fakeouts).
      itVolumeGate: itVolumeGate,
      // Auto-trade + journal internals (for the auto-trade regression test).
      maybeAutoTrade: maybeAutoTrade,
      journalTick: journalTick,
      seedDedupe: seedDedupe,
      expireStaleOpen: expireStaleOpen,
      sigOf: sigOf,
      getAuto: function () { return STATE.auto; },
      setArmed: function (on) { STATE.auto.on = !!on; },
      setSpot: function (v) { STATE.lastClose = v; },
      setSetupData: function (d) { STATE.setup.data = d; },
      // Persistence round-trip hooks (server JSON save/load).
      saveJournal: saveJournal,
      hydrateJournalFromServer: hydrateJournalFromServer,
      resetJournalHydrate: function () { STATE.auto.jLoaded = false; }
    };
  }
})();
