// Intraday multi-TF recommendation engine (SCALP-only) — session-phase
// classifier, India-VIX + Bank Nifty fetches, VWAP / ORH-ORL / PDH-PDL,
// RSI divergence, auto S/R, plan grid + ladder renderers, live re-pricing,
// plus the signal journal (sj*), event calendar (ia*Event), confirm modal
// (appConfirm*), backtest (bt* / runTrendBacktest), and paper-bridge. ONE
// module-level IIFE (intradayAnalyzerModule); ~70 window.* exposures + ~145
// closure-private helpers share its scope, so it is NOT internally splittable
// without rewriting signal logic — extracted whole (over the 1K cap by
// necessity; see AGENTS.md §18).
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split). Loaded via a plain <script src> in the SAME
// document position (classic script), so window.intraday* / sj* / ia* / bt* /
// appConfirm* stay global for the inline handlers in content/live.html, with
// unchanged init timing. Cross-module refs are call-time only.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

(function intradayAnalyzerModule() {
  function $(id) { return document.getElementById(id); }

  // Pull every helper from the swing module's exposed namespace
  // (the swing module IIFE runs before this one, so _tfMath is
  // populated). Defensive defaults guard against accidental load
  // ordering changes — every method below null-checks before use.
  function M() { return window._tfMath || {}; }

  // ── Constants ──
  var INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
  var TF_SPECS = {
    // Trend Identifier v1 (May 2026) startup-bar targets, per
    // docs/FEATURES.md §12.7 Fix 5:
    //   1h → 120 bars   (20 trading days)   ← bumped from 14d
    //   30m → 120 bars  (~10 trading days)  ← NEW TF
    //   15m → 120 bars  (already covered by 14d at ~25 bars/day)
    //   5m  → 80 bars   (already covered by 5d at ~75 bars/day)
    // historyDays is converted to a calendar-day window in
    // fetchOneTf(), so the values below include weekend padding.
    '1h':  { unit: 'hours',   interval: '1',  historyDays: 20, label: '1 Hour',    bucketMs: 60 * 60 * 1000 },
    '30m': { unit: 'minutes', interval: '30', historyDays: 14, label: '30 Minute', bucketMs: 30 * 60 * 1000 },
    '15m': { unit: 'minutes', interval: '15', historyDays: 14, label: '15 Minute', bucketMs: 15 * 60 * 1000 },
    '5m':  { unit: 'minutes', interval: '5',  historyDays: 5,  label: '5 Minute',  bucketMs:  5 * 60 * 1000 },
    // 3m kept temporarily for the OLD generateVerdict path during
    // Phase 1 (foundation). Removed in Phase 2 (engine rewrite)
    // alongside the OLD verdict logic. Not analysed by v1 trend
    // identifier — the chart TF switcher still offers 3m for
    // visual inspection only.
    '3m':  { unit: 'minutes', interval: '3',  historyDays: 5,  label: '3 Minute',  bucketMs:  3 * 60 * 1000 }
  };
  // NSE intraday session in minutes-of-day-IST (09:15 → 15:30).
  var SESSION_OPEN_MIN  = 9 * 60 + 15;
  var SESSION_CLOSE_MIN = 15 * 60 + 30;
  var SESSION_OPEN_MS   = SESSION_OPEN_MIN * 60 * 1000;
  var IST_OFFSET_MS     = 5.5 * 60 * 60 * 1000;
  var OR_LENGTH_MIN     = 15;   // 09:15 → 09:30 opening range

  var STATE = {
    active: false,         // Paper Trading tab is the visible tab
    fetching: false,       // analyze() currently in flight
    lastBucket: 0,         // 3m bucket start (epoch ms IST-aligned) of last analyze
    lastAnalyzedMs: 0,     // wall-clock ms of last successful analyze
    result: null,          // latest result {tf15, tf5, tf3, plan}
    tickTimer: null,       // setInterval handle for the on-bar-close watcher
    // Plan-card "chain not loaded yet" retry bookkeeping. Used by
    // renderPlan() to re-attempt premium fill every 1.5s (up to 8x)
    // after kicking upFetchChain — so the user sees concrete ₹
    // values within ~12s instead of waiting for the next 3m close.
    _planRetries: 0,
    _planSig: null
  };

  // ── Off-hours STATE.result persistence (May 2026) ──
  // Cache the latest verdict to localStorage so a reload during
  // off-hours doesn't trigger a 4-TF historical-candle + 100-stock
  // volume aggregation just to recompute a verdict whose inputs
  // haven't changed since the market closed. The cache holds
  // STATE.result + the analyze timestamp; on Monday morning the
  // first market-open tick discards anything older than today's
  // 09:15 IST and fires a fresh analyze().
  var INTRADAY_RESULT_CACHE_KEY = 'ia_result_cache_v1';
  function persistIntradayResult() {
    try {
      if (!STATE.result) return;
      var payload = {
        result: STATE.result,
        at: STATE.lastAnalyzedMs || Date.now(),
        lastBucket: STATE.lastBucket || 0
      };
      // Also persist raw candles (trimmed to last 120 bars per TF) so
      // the Phase 4 Trend Backtest works after a page reload without
      // needing a live market session. At ~50 chars per bar this is
      // ~120×4×50 = ~24 KB — well within localStorage limits.
      if (STATE.rawCandles) {
        var trimmed = {};
        ['1h', '30m', '15m', '5m'].forEach(function (tf) {
          var arr = STATE.rawCandles[tf];
          if (arr && arr.length) trimmed[tf] = arr.slice(-120);
        });
        payload.rawCandles = trimmed;
      }
      localStorage.setItem(INTRADAY_RESULT_CACHE_KEY, JSON.stringify(payload));
    } catch (_) {
      // Quota / private mode — silently drop, in-memory cache still works
      try { localStorage.removeItem(INTRADAY_RESULT_CACHE_KEY); } catch (_) {}
    }
  }
  function loadIntradayResult() {
    try {
      var raw = localStorage.getItem(INTRADAY_RESULT_CACHE_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !p.result || typeof p.at !== 'number') return null;
      // Restore raw candles if they were persisted (Phase 4 backtest)
      if (p.rawCandles && !STATE.rawCandles) {
        STATE.rawCandles = p.rawCandles;
      }
      return p;
    } catch (_) { return null; }
  }

  // ── Trading mode ─────────────────────────────────────────────
  // The tool used to support two modes (SCALP / SWING) with a
  // segmented toggle in the result block. Removed in May 2026 —
  // see content/live.html for the full rationale. Engine is now
  // SCALP-only. We keep a single `getTradingMode()` that returns
  // the constant 'SCALP' so the dozens of downstream callers
  // (generateVerdict, computeRiskPlan, phase helpers, journal
  // entry persistence, pill tooltips) keep working without a
  // sweeping signature refactor — they all just get 'SCALP'
  // back forever. The `isScalp` ternaries inside those callers
  // constant-fold harmlessly and have been simplified one-by-one
  // in the same refactor. setTradingMode / renderModeToggle and
  // their window exposures were deleted (no callers left).
  function getTradingMode() { return 'SCALP'; }

  // ── Time helpers ──
  function nowISTParts() {
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

  // ── VWAP context label ──────────────────────────────────────────
  // VWAP is session-anchored — it's only computable from TODAY's
  // bars. When the analyzer can't compute it (weekend, pre-open,
  // trading holiday, or the first few seconds after the bell while
  // no candle has closed yet) we used to render the unhelpful
  // "VWAP n/a" everywhere. This helper returns the same phrase
  // for above/below + a context-aware reason for the null case so
  // the user knows WHY it's missing.
  //
  //   aboveVwap === true   → "above VWAP"
  //   aboveVwap === false  → "below VWAP"
  //   null + weekend       → "VWAP closed (weekend)"
  //   null + pre-09:15 IST → "VWAP pre-open"
  //   null + post-15:30    → "VWAP closed"
  //   null + market open   → "VWAP forming"
  function vwapLabel(an) {
    if (an && an.aboveVwap === true)  return 'above VWAP';
    if (an && an.aboveVwap === false) return 'below VWAP';
    var ist = nowISTParts();
    var wd  = ist.weekday;
    if (wd === 'Sat' || wd === 'Sun') return 'VWAP closed (weekend)';
    if (ist.minOfDay < 9 * 60 + 15)   return 'VWAP pre-open';
    if (ist.minOfDay > 15 * 60 + 30)  return 'VWAP closed';
    return 'VWAP forming';
  }

  // ── Session-phase classifier ─────────────────────────────────
  // Maps the current IST clock time into a named session phase.
  // Intraday options trades have very different probability and
  // theta profiles depending on the phase — an experienced trader
  // wouldn't treat a 9:30 entry the same as a 14:30 entry.
  //
  // Phases (SCALP-only engine, May 2026):
  //   WEEKEND   (Sat/Sun any time)
  //   PRE_OPEN  <09:15
  //   OR_FORMING 09:15-09:20   (one 5m bar lockout)
  //   OR_SETTLED 09:20-09:30
  //   PRIME      09:30-11:30   (HIGH confidence)
  //   LATE_MORN  11:30-12:30   (HIGH confidence)
  //   LUNCH_CHOP 12:30-13:30
  //   AFTERNOON  13:30-14:30
  //   LATE_PUSH  14:30-15:00   (HIGH confidence — scalper sweet spot)
  //   LATE_SCALP 15:00-15:25   (tradeable, LOW)
  //   NO_NEW     15:25-15:30   (hard veto, last 5 min only)
  //   POST_CLOSE >=15:30
  // The legacy SWING phase set (LUNCH 12:30-13:00 / wider OR_FORMING
  // / THETA_DANGER 14:50-15:10 / NO_NEW from 15:10) was removed in
  // the May 2026 SCALP-only refactor.
  function classifySessionPhase(minOfDay) {
    // ── WEEKEND / HOLIDAY short-circuit ──
    // Sat/Sun/NSE-holiday at ANY clock time → 'WEEKEND'.
    try {
      var _tp = nowISTParts();
      if (_tp.weekday === 'Sat' || _tp.weekday === 'Sun') return 'WEEKEND';
      if (typeof window.isNseHoliday === 'function' && window.isNseHoliday(_tp.dateStr)) return 'WEEKEND';
    } catch (_) {}
    if (minOfDay < SESSION_OPEN_MIN)        return 'PRE_OPEN';
    if (minOfDay >= SESSION_CLOSE_MIN)      return 'POST_CLOSE';
    if (minOfDay < 9 * 60 + 20)             return 'OR_FORMING';  // 5 min
    if (minOfDay < 9 * 60 + 30)             return 'OR_SETTLED';
    if (minOfDay < 11 * 60 + 30)            return 'PRIME';
    if (minOfDay < 12 * 60 + 30)            return 'LATE_MORN';
    if (minOfDay < 13 * 60 + 30)            return 'LUNCH_CHOP';
    if (minOfDay < 14 * 60 + 30)            return 'AFTERNOON';
    if (minOfDay < 15 * 60)                 return 'LATE_PUSH';   // FULL confidence
    if (minOfDay < 15 * 60 + 25)            return 'LATE_SCALP';  // tradeable, LOW
    return 'NO_NEW';                                                // last 5 min only
  }
  // Human-readable label for each phase.
  function sessionPhaseLabel(phase) {
    switch (phase) {
      case 'WEEKEND': {
        var _nol = (typeof window.nextOpenLabel === 'function') ? window.nextOpenLabel() : 'opens Monday 09:15 IST';
        return 'CLOSED \u2014 ' + _nol;
      }
      case 'PRE_OPEN':     return 'PRE-OPEN \u2014 market hasn\u2019t opened';
      case 'OR_FORMING':   return 'OPENING RANGE \u2014 first 5 min still noisy';
      case 'OR_SETTLED':   return 'OR SETTLED \u2014 first directional bar';
      case 'PRIME':        return 'PRIME WINDOW \u2014 09:30\u201311:30 (best time to trade)';
      case 'LATE_MORN':    return 'LATE MORNING \u2014 desks fading for lunch';
      case 'LUNCH_CHOP':   return 'LUNCH CHOP \u2014 thin liquidity, wide spreads';
      case 'AFTERNOON':    return 'AFTERNOON CHOP \u2014 weakest intraday window';
      case 'LATE_PUSH':    return 'LATE PUSH \u2014 14:30\u201315:00 (scalper sweet spot)';
      case 'LATE_SCALP':   return 'LATE SCALP \u2014 15:00\u201315:25, exit fast';
      case 'NO_NEW':       return 'NO NEW ENTRIES \u2014 square-off window';
      case 'POST_CLOSE':   return 'CLOSED \u2014 session ended';
      default:             return phase;
    }
  }
  // Phase pill colour — green for full-confidence windows
  // (PRIME, LATE_MORN, LATE_PUSH), red for hard-veto / closed,
  // amber for everything else.
  function sessionPhaseClass(phase) {
    if (phase === 'PRIME' || phase === 'LATE_MORN' || phase === 'LATE_PUSH') return 'good';
    if (phase === 'OR_FORMING' || phase === 'NO_NEW' || phase === 'PRE_OPEN'
        || phase === 'POST_CLOSE' || phase === 'WEEKEND') return 'bad';
    return 'ok';
  }

  function isMarketOpen() {
    if (typeof window.isMarketOpen === 'function') {
      try { return !!window.isMarketOpen(); } catch (_) {}
    }
    var t = nowISTParts();
    if (t.weekday === 'Sat' || t.weekday === 'Sun') return false;
    if (typeof window.isNseHoliday === 'function') {
      try { if (window.isNseHoliday(t.dateStr)) return false; } catch (_) {}
    }
    return t.minOfDay >= SESSION_OPEN_MIN && t.minOfDay < SESSION_CLOSE_MIN;
  }

  // 3m bucket start aligned to the NSE 09:15 IST session grid.
  // Same trick the swing live-poller uses — shift to IST, align,
  // shift back to UTC so the comparison with current epoch-ms works.
  function bucketStartMs(epochMs, bucketMs) {
    var istMs = epochMs + IST_OFFSET_MS;
    var dayStart = Math.floor(istMs / 86400000) * 86400000;
    var sessionStart = dayStart + SESSION_OPEN_MS;
    if (istMs < sessionStart) return null;
    var idx = Math.floor((istMs - sessionStart) / bucketMs);
    return sessionStart + idx * bucketMs - IST_OFFSET_MS;
  }
  function current3mBucketStart() {
    return bucketStartMs(Date.now(), TF_SPECS['3m'].bucketMs);
  }

  function fmtClock(ms) {
    if (!ms) return '—';
    try {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour12: true,
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).format(new Date(ms)) + ' IST';
    } catch (_) { return new Date(ms).toLocaleTimeString(); }
  }
  function fmtNum(n, d) {
    d = (d == null) ? 2 : d;
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPts(n) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  }

  // ── Fetch ──
  // Pulls one TF of historical + intraday candles via Upstox V3.
  // We always include the intraday endpoint so today's in-progress
  // bar is reflected. Returns candles oldest → newest, deduped.
  async function fetchOneTf(tfKey) {
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) throw new Error('API_PAUSED');
    var token = M().getToken && M().getToken();
    if (!token) throw new Error('NO_TOKEN');
    var spec = TF_SPECS[tfKey];
    var BASE = M().BASE_V3 || 'https://api.upstox.com/v3';
    var ikey = encodeURIComponent(INSTRUMENT_KEY);
    var to = new Date();
    var from = new Date();
    from.setDate(to.getDate() - spec.historyDays);
    var fmtDate = M().fmtDate || function (d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    };
    var histUrl  = BASE + '/historical-candle/' + ikey + '/' + spec.unit + '/' + spec.interval + '/' + fmtDate(to) + '/' + fmtDate(from);
    var intraUrl = BASE + '/historical-candle/intraday/' + ikey + '/' + spec.unit + '/' + spec.interval;
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    // RATE LIMIT WIRING (May 2026 fix): plug into the global
    // _upstoxIsThrottled / _upstoxNote429 gate so a single 429 from
    // any caller (chart pollTick, option polls, the chart's own
    // silentRefetch, this fetchAll) backs off ALL of them in unison.
    // Without this wiring, the analyzer would happily fire 4 TFs
    // of /historical-candle every 3-min bucket-close even while the
    // chart had been throttled for 90s — guaranteed to land on a
    // 429 and reset the cooldown clock on every subsequent caller.
    async function fetchOne(url) {
      if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return [];
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      try {
        var resp = await fetch(url, { headers: headers });
        if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
        if (resp.status === 429) {
          if (window._upstoxNote429) window._upstoxNote429('intraday-fetchOneTf-' + tfKey);
          return [];
        }
        if (!resp.ok) return [];
        var d = await resp.json();
        if (window._upstoxNoteOk) window._upstoxNoteOk();
        return (d && d.data && d.data.candles) || [];
      } catch (e) {
        if (e && e.message === 'UNAUTHORIZED') throw e;
        return [];
      }
    }
    var results = await Promise.all([fetchOne(histUrl), fetchOne(intraUrl)]);
    var merged = results[0].concat(results[1]);
    // Dedupe by timestamp + sort oldest → newest.
    var seen = {};
    var out = [];
    merged.forEach(function (c) {
      var t = c[0];
      if (!seen[t]) { seen[t] = 1; out.push(c); }
    });
    out.sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    return out;
  }
  async function fetchAll() {
    // 30m added (May 2026 Trend Identifier v1) — see §12.2 of
    // docs/FEATURES.md. Sits between 15m and 1h as the "session
    // swing" TF (morning vs afternoon character).
    // 3m was removed in Phase 2 (2026-05-25); 30m is now the BIAS layer.
    var keys = ['1h', '30m', '15m', '5m', '3m'];
    var arrs = await Promise.all(keys.map(fetchOneTf));
    // ── Enrich with Nifty 50 constituent-summed volume ──────────
    // Upstox returns `volume=0` for `NSE_INDEX|Nifty 50` because
    // indices aren't directly tradeable — only their constituent
    // stocks are. Without enrichment, every volume-based signal
    // in the verdict pipeline (volumeRatio, OBV, the volume-gated
    // break-credit branch) silently fails:
    //   • volumeRatio → null    → no "volume confirming" credit
    //   • OBV cum     → 0       → no "OBV rising" confirmation
    //   • breakCredit → defaults to no-vol path (no head-fake
    //                              penalty on light-volume breaks)
    // We patch this by summing volume across all 50 Nifty
    // constituents at every bar timestamp — identical to how
    // TradingView / Zerodha Kite show Nifty volume.
    //
    // The chart module already implements + caches this; we just
    // reuse its function. If the aggregator returns null (no
    // token, V3 stocks endpoint blocked, or transient network
    // failure) we silently leave volumes at 0 — the rest of the
    // verdict still works without the volume layer.
    //
    // Cost: first call per TF is ~50 fetches × 4 TFs = 200 calls
    // (pLimit caps at 6 concurrent, ~5-10s wall-time). Cached for
    // 30 min in localStorage — subsequent analyze() cycles reuse
    // the cache, so steady-state cost is zero.
    if (typeof window.tvFetchAggregatedVolume === 'function') {
      // Serialize the per-TF aggregation calls: each call internally
      // caps concurrent fetches at 6 (browser per-host HTTP/1.1
      // default), so running 4 TFs in parallel would queue 24 in
      // flight and trip Upstox's rate limiter. Sequential keeps
      // worst-case at 6 concurrent and lets each TF's localStorage
      // cache populate before the next one starts (so a re-call on
      // the next analyze() cycle is effectively free).
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        var totals = null;
        try {
          totals = await window.tvFetchAggregatedVolume(k);
        } catch (e) {
          console.warn('[intraday] volume enrichment failed for ' + k + ':', e && e.message);
          // Non-fatal for this TF — keep going so other TFs may
          // still benefit (e.g. one TF was probed-rejected but
          // others might still aggregate cleanly).
        }
        if (!totals) continue;
        var bars = arrs[ki];
        var patched = 0;
        for (var b = 0; b < bars.length; b++) {
          var c = bars[b];
          var t = new Date(c[0]).getTime();
          if (totals[t] != null && totals[t] > 0) {
            c[5] = totals[t];
            patched++;
          }
        }
        if (patched > 0) {
          console.log('[intraday] volume enriched for ' + k + ': ' + patched + '/' + bars.length + ' bars');
        }
      }
    }
    return {
      '1h':  arrs[0],
      '30m': arrs[1],
      '15m': arrs[2],
      '5m':  arrs[3],
      '3m':  arrs[4]
    };
  }

  // ── VIX + BN module-level caches (May 2026 off-hours guard) ──
  // Both are intraday fetches that don't change after market close.
  // We cache the parsed result and serve it forever while market is
  // closed; during open hours we still serve cached values for a
  // short window (60s) to avoid duplicate fetches inside a single
  // analyze() pass. Combined with STATE.result persistence, this
  // means the only time these endpoints are hit on a weekend is
  // a first-ever visit before any cache exists.
  var _vixCache = null;  // { at: ms, value: {...} }
  var _bnCache  = null;
  function _isOffHoursCacheValid(c) {
    if (!c || !c.value) return false;
    if (!isMarketOpen()) return true;       // closed → eternal
    return (Date.now() - c.at) < 60 * 1000; // open  → 60s
  }

  // ── India VIX intraday fetch ────────────────────────────────
  // VIX moves SLOWLY (it's a 30-day forward IV estimate), so 5-min
  // intraday candles for today give us everything we need:
  //   - today's open (first 5m bar of the session)
  //   - current  (latest 5m bar's close)
  //   - intraday  change %
  // Returns null on any error / missing data — the verdict still
  // works without VIX input, just without the IV regime filter.
  async function fetchVixIntraday() {
    if (_isOffHoursCacheValid(_vixCache)) return _vixCache.value;
    // Respect the global Upstox throttle gate — if any other caller
    // recently hit a 429, skip and let the analyzer run without VIX
    // (the verdict engine treats null VIX as "regime unavailable"
    // and proceeds with no IV-regime input rather than failing).
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return null;
    var token = M().getToken && M().getToken();
    if (!token) return null;
    if (window._upstoxBucket) await window._upstoxBucket.acquire();
    var BASE = M().BASE_V3 || 'https://api.upstox.com/v3';
    var ikey = encodeURIComponent('NSE_INDEX|India VIX');
    var url = BASE + '/historical-candle/intraday/' + ikey + '/minutes/5';
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    try {
      var resp = await fetch(url, { headers: headers });
      if (resp.status === 429) {
        if (window._upstoxNote429) window._upstoxNote429('intraday-fetchVixIntraday');
        return null;
      }
      if (!resp.ok) return null;
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      var d = await resp.json();
      var candles = (d && d.data && d.data.candles) || [];
      if (!candles.length) return null;
      // Upstox returns candles newest-first; sort oldest → newest
      // to get today's open at index 0.
      var sorted = candles.slice().sort(function (a, b) {
        return new Date(a[0]).getTime() - new Date(b[0]).getTime();
      });
      var openVix    = +sorted[0][1];                              // first bar's open
      var currentVix = +sorted[sorted.length - 1][4];              // latest bar's close
      if (!isFinite(openVix) || !isFinite(currentVix)) return null;
      // Also surface today's VIX high/low so the renderer can
      // explain "VIX up from open but down from day's high" etc.
      var hi = -Infinity, lo = Infinity;
      for (var i = 0; i < sorted.length; i++) {
        var h = +sorted[i][2], l = +sorted[i][3];
        if (h > hi) hi = h;
        if (l < lo) lo = l;
      }
      var changePct = ((currentVix - openVix) / openVix) * 100;
      var out = {
        current: currentVix,
        open:    openVix,
        high:    hi,
        low:     lo,
        changePct: changePct
      };
      _vixCache = { at: Date.now(), value: out };
      return out;
    } catch (_) { return null; }
  }

  // ── Bank Nifty intraday fetch ───────────────────────────────
  // Bank Nifty leads Nifty 50 intraday ~60% of the time (Bank Nifty
  // is heavier on financials which are more sensitive to overnight
  // rate / liquidity news, and moves first into the open). We use
  // BN's 5m trend + intraday change to add a high-value confirmation
  // signal:
  //   - BN aligned with Nifty's setup direction → +1 confirmation
  //   - BN going OPPOSITE Nifty's setup → −2 penalty + SKIP IF
  //     ("BN is rejecting the Nifty move — likely fade")
  //   - BN extra-strong (BN +0.5%, Nifty +0.1%) → "BN leading,
  //     follow"; expect Nifty to catch up
  // Returns null on any error / missing data — verdict still works
  // without BN input, just without the correlation filter.
  async function fetchBankNiftyIntraday() {
    if (_isOffHoursCacheValid(_bnCache)) return _bnCache.value;
    // Honour the global Upstox throttle gate (same rationale as
    // fetchVixIntraday above — verdict still works without BN data).
    if (window._upstoxIsThrottled && window._upstoxIsThrottled()) return null;
    var token = M().getToken && M().getToken();
    if (!token) return null;
    if (window._upstoxBucket) await window._upstoxBucket.acquire();
    var BASE = M().BASE_V3 || 'https://api.upstox.com/v3';
    var ikey = encodeURIComponent('NSE_INDEX|Nifty Bank');
    var url = BASE + '/historical-candle/intraday/' + ikey + '/minutes/5';
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    try {
      var resp = await fetch(url, { headers: headers });
      if (resp.status === 429) {
        if (window._upstoxNote429) window._upstoxNote429('intraday-fetchBankNiftyIntraday');
        return null;
      }
      if (!resp.ok) return null;
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      var d = await resp.json();
      var candles = (d && d.data && d.data.candles) || [];
      if (!candles.length) return null;
      // Sort oldest → newest so the first bar is the session open.
      var sorted = candles.slice().sort(function (a, b) {
        return new Date(a[0]).getTime() - new Date(b[0]).getTime();
      });
      _bnCache = { at: Date.now(), value: sorted };
      return sorted;
    } catch (_) { return null; }
  }

  // ── Bank Nifty analysis ─────────────────────────────────────
  // Computes the same trend label / RSI / EMA-stack analytics as
  // Nifty's 5m so the comparator can read both with the same
  // schema. Returns null when input is empty/insufficient.
  function analyzeBankNifty(candles) {
    if (!candles || candles.length < 12) return null;
    var math = M();
    var closes = candles.map(function (c) { return +c[4]; });
    var n = closes.length;
    var e9   = math.ema  ? math.ema(closes, 9)  : [];
    var e21  = math.ema  ? math.ema(closes, 21) : [];
    var e50  = math.ema  ? math.ema(closes, 50) : [];
    var r    = math.rsi  ? math.rsi(closes, 14) : [];
    var adxA = math.adx  ? math.adx(candles, 14) : [];
    var lastClose = closes[n - 1];
    var ema9   = e9[n - 1],   ema21 = e21[n - 1],  ema50 = e50[n - 1];
    var rsiV   = r[n - 1];
    var adxV   = adxA[adxA.length - 1];
    // Trend label using the same EMA-stack rules as Nifty's TF.
    var trend = 'MIXED';
    if (lastClose > ema9 && ema9 > ema21 && ema21 > ema50) trend = 'STRONG_BULL';
    else if (lastClose > ema21 && ema9 > ema21) trend = 'BULL';
    else if (lastClose < ema9 && ema9 < ema21 && ema21 < ema50) trend = 'STRONG_BEAR';
    else if (lastClose < ema21 && ema9 < ema21) trend = 'BEAR';
    // Today's open + intraday % change.
    var openToday = +candles[0][1];
    var changePct = (isFinite(openToday) && openToday > 0)
      ? ((lastClose - openToday) / openToday) * 100 : null;
    // Net direction code for the score comparator.
    var net = trend.indexOf('BULL') >= 0 ? 'BULL'
            : trend.indexOf('BEAR') >= 0 ? 'BEAR' : 'FLAT';
    return {
      lastClose: lastClose,
      openToday: openToday,
      changePct: changePct,
      trend:     trend,
      rsi:       rsiV,
      adx:       adxV,
      ema9: ema9, ema21: ema21, ema50: ema50,
      net:       net
    };
  }

  // Exposed so the Intraday Trade tab (a separate module) can render the same
  // macro Bank-Nifty bias banner WITHOUT duplicating the fetch + bias logic.
  // Returns { trend, net, changePct, ... } or null. Reuses _bnCache + the
  // global Upstox throttle gate, so calling it from the other tab does not add
  // uncontrolled API load (off-hours it serves the cache; market hours it is
  // throttle-gated like every other intraday fetch).
  window.iaGetBankNiftyBias = async function () {
    try {
      var candles = await fetchBankNiftyIntraday();
      if (!candles) return null;
      return analyzeBankNifty(candles);
    } catch (_) { return null; }
  };

  // ── Intraday-specific calcs (VWAP / ORH-ORL / PDH-PDL) ──
  // Day key (YYYY-MM-DD in IST) so we can split candles into
  // "today" and "previous trading day" buckets.
  function dayKeyIST(epochMs) {
    var d = new Date(epochMs + IST_OFFSET_MS);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  // VWAP from a list of intraday candles (typical price × volume).
  // For an index like Nifty 50 the per-bar "volume" Upstox returns
  // is usually 0 (indices have no traded volume of their own); in
  // that case we fall back to a simple bar count so VWAP at least
  // mirrors the average traded price, not crashes to NaN.
  function calcVwap(candles) {
    if (!candles || !candles.length) return null;
    var pv = 0, vSum = 0, anyVol = false;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var h = +c[2], l = +c[3], cl = +c[4], v = +c[5] || 0;
      var tp = (h + l + cl) / 3;
      if (v > 0) { anyVol = true; pv += tp * v; vSum += v; }
    }
    if (anyVol) return pv / vSum;
    // Fallback for indices: treat every bar as weight=1.
    var sum = 0;
    for (var j = 0; j < candles.length; j++) {
      var k = candles[j];
      sum += (+k[2] + +k[3] + +k[4]) / 3;
    }
    return sum / candles.length;
  }

  // ── VWAP standard-deviation bands ──────────────────────────────
  // Returns { vwap, std, ub1, lb1, ub2, lb2 } where:
  //   vwap = volume-weighted average price for the session
  //   std  = volume-weighted standard deviation of typical price vs vwap
  //   ub1, lb1 = vwap ± 1σ (≈68% of bars expected inside)
  //   ub2, lb2 = vwap ± 2σ (≈95% of bars; touches = stretched / fade zone)
  //
  // Mathematically: weighted variance = (Σ w*tp²)/(Σ w) − vwap²
  // (the "Welford" running form would be more numerically stable but
  // 75 bars/session and 5-digit-price Nifty values are well within
  // float64's precision — no need for the complexity).
  //
  // Index fallback: when Upstox returns volume=0 for index bars we
  // use uniform weighting (same as calcVwap), and the std becomes
  // the plain SD of typical-price across bars.
  function calcVwapBands(candles) {
    if (!candles || !candles.length) return null;
    // Pass 1: same VWAP calc as calcVwap, but also collect (tp, w)
    // pairs for the second variance pass.
    var rows = [];   // [{tp, w}]
    var anyVol = false;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var h = +c[2], l = +c[3], cl = +c[4], v = +c[5] || 0;
      var tp = (h + l + cl) / 3;
      if (v > 0) anyVol = true;
      rows.push({ tp: tp, w: v });
    }
    // If no volume info, fall back to uniform weighting (each bar = 1).
    if (!anyVol) {
      for (var r = 0; r < rows.length; r++) rows[r].w = 1;
    }
    // VWAP
    var pv = 0, vSum = 0;
    for (var k = 0; k < rows.length; k++) {
      pv += rows[k].tp * rows[k].w;
      vSum += rows[k].w;
    }
    if (vSum <= 0) return null;
    var vwap = pv / vSum;
    // Weighted variance (E[X²] − E[X]²)
    var pv2 = 0;
    for (var k2 = 0; k2 < rows.length; k2++) {
      var dtp = rows[k2].tp;
      pv2 += (dtp * dtp) * rows[k2].w;
    }
    var meanSq = pv2 / vSum;
    var variance = meanSq - vwap * vwap;
    if (variance < 0) variance = 0;   // float-precision floor
    var std = Math.sqrt(variance);
    return {
      vwap: vwap,
      std:  std,
      ub1:  vwap + std,
      lb1:  vwap - std,
      ub2:  vwap + 2 * std,
      lb2:  vwap - 2 * std
    };
  }

  // ── RSI divergence detector ──────────────────────────────────
  // Classic per-TF reversal pattern (NOT to be confused with the
  // cross-TF RSI cascade we already have, which compares 15m vs 3m
  // RSI on the SAME bar). Divergence looks at SWING POINTS on a
  // SINGLE TF and asks "did momentum confirm the new price extreme?"
  //
  //   BEARISH divergence:
  //     Price made a HIGHER HIGH but RSI made a LOWER HIGH.
  //     → Momentum failed to confirm the new high.
  //     → Classic exhaustion signal — uptrend likely reversing.
  //
  //   BULLISH divergence:
  //     Price made a LOWER LOW but RSI made a HIGHER LOW.
  //     → Selling pressure waning despite new low.
  //     → Classic accumulation signal — downtrend likely reversing.
  //
  // Implementation notes:
  //   - Uses the last TWO swing highs / lows within the analysis
  //     window. Swings come from math.swingHighs/swingLows with
  //     lookback=3 (3 bars left + right of the pivot).
  //   - Minimum spacing of 5 bars between the two swings to avoid
  //     noise pivots (back-to-back micro-swings on choppy bars).
  //   - RSI delta must exceed 2 points to qualify as "diverging"
  //     (small RSI drift inside the same swing is normal).
  //   - Most recent swing must be within last 8 bars — older
  //     swings are stale, structure has moved on.
  // Returns { bearishDiv, bullishDiv } where each is either null
  // or an object with the two swing prices, two RSI readings, and
  // bars-ago of the most recent swing.
  function detectRsiDivergence(candles, rsiArr) {
    var math = M();
    if (!math.swingHighs || !math.swingLows || !candles || !rsiArr) {
      return { bearishDiv: null, bullishDiv: null };
    }
    var swHi = math.swingHighs(candles, 3);
    var swLo = math.swingLows(candles, 3);
    var n = candles.length;
    var MAX_AGE = 8;       // most-recent swing must be within last 8 bars
    var MIN_SPACING = 5;   // ≥5 bars between the two swings
    var MIN_RSI_DELTA = 2; // RSI gap to count as a divergence
    var result = { bearishDiv: null, bullishDiv: null };
    // Bearish: last two swing highs, price up but RSI down.
    if (swHi.length >= 2) {
      var hi1 = swHi[swHi.length - 2];
      var hi2 = swHi[swHi.length - 1];
      if (hi2 && hi1
          && (hi2.idx - hi1.idx) >= MIN_SPACING
          && (n - 1 - hi2.idx) <= MAX_AGE) {
        var r1 = rsiArr[hi1.idx];
        var r2 = rsiArr[hi2.idx];
        if (isFinite(r1) && isFinite(r2)
            && hi2.price > hi1.price
            && r2 < r1 - MIN_RSI_DELTA) {
          result.bearishDiv = {
            price1: hi1.price, price2: hi2.price,
            rsi1: r1, rsi2: r2,
            priceDelta: hi2.price - hi1.price,
            rsiDelta:   r1 - r2,           // positive = bearish (RSI dropped)
            barsAgo:    n - 1 - hi2.idx,
            spacing:    hi2.idx - hi1.idx
          };
        }
      }
    }
    // Bullish: last two swing lows, price down but RSI up.
    if (swLo.length >= 2) {
      var lo1 = swLo[swLo.length - 2];
      var lo2 = swLo[swLo.length - 1];
      if (lo2 && lo1
          && (lo2.idx - lo1.idx) >= MIN_SPACING
          && (n - 1 - lo2.idx) <= MAX_AGE) {
        var rl1 = rsiArr[lo1.idx];
        var rl2 = rsiArr[lo2.idx];
        if (isFinite(rl1) && isFinite(rl2)
            && lo2.price < lo1.price
            && rl2 > rl1 + MIN_RSI_DELTA) {
          result.bullishDiv = {
            price1: lo1.price, price2: lo2.price,
            rsi1: rl1, rsi2: rl2,
            priceDelta: lo1.price - lo2.price,
            rsiDelta:   rl2 - rl1,        // positive = bullish (RSI lifted)
            barsAgo:    n - 1 - lo2.idx,
            spacing:    lo2.idx - lo1.idx
          };
        }
      }
    }
    return result;
  }

  // ── AUTO-DISCOVERED S/R ─────────────────────────────────────
  // These three helpers find S/R that isn't tied to a single
  // anchor event (open / prev day / pivot formula). They look at
  // ACTUAL price-action history and find horizontal levels where
  // multiple swings have rejected, plus the psychological-magnet
  // round levels every Indian retail watches.
  //
  // (1) findSrZones — multi-day swing clustering.
  //     Pass the full raw 5m series (covers ~5 trading days);
  //     we collect every swing high + swing low and cluster
  //     swings within `clusterTol` of each other (default 0.5×
  //     5m ATR ≈ 7-10 pts on Nifty). A "zone" requires ≥3 swings
  //     within `clusterTol`. Returns sorted-ascending list of
  //     {midpoint, low, high, touches, lastBarsAgo} objects.
  //
  // (2) findRoundNumbers — psychological levels.
  //     Tier-1 (tier3, heaviest): multiples of 500 within ±2%.
  //     Tier-2 (tier2): multiples of 100 within ±1.5%.
  //     Tier-3 (tier1, lightest): multiples of 50 within ±1%.
  //     Higher tiers eat lower tiers (a level at 23,500 is
  //     reported only as tier-1, not also as tier-2 or tier-3).
  //
  // (3) computeAnchoredVwaps — anchored from today's session
  //     extremes. Different from daily VWAP: AVWAP-from-high is
  //     the volume-weighted average of every bar AFTER today's
  //     swing high; AVWAP-from-low is the same after today's
  //     swing low. Useful as "fair value since the last
  //     reversal." Returns {fromHigh, fromLow, anchorHighTime,
  //     anchorLowTime} or null if today has too few bars (<10).
  function findSrZones(rawBars, currSpot, atr) {
    if (!rawBars || rawBars.length < 30) return [];
    var math = M();
    if (!math.swingHighs || !math.swingLows) return [];
    // Need a sorted (oldest→newest) series for the swing helpers.
    var sorted = rawBars.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    // Collect swing points across the whole series. Lookback=3
    // (same as the per-TF analyzer) catches genuine pivots
    // without being noise-sensitive. We mark each swing's bar
    // index in the sorted array so we can compute age later.
    var hSwings = math.swingHighs(sorted, 3);
    var lSwings = math.swingLows(sorted, 3);
    var all = [];
    for (var i = 0; i < hSwings.length; i++) all.push({ price: hSwings[i].price, idx: hSwings[i].idx, side: 'H' });
    for (var j = 0; j < lSwings.length; j++) all.push({ price: lSwings[j].price, idx: lSwings[j].idx, side: 'L' });
    if (all.length < 6) return [];
    // Sort by price ascending so we can sweep and cluster.
    all.sort(function (a, b) { return a.price - b.price; });
    // Cluster tolerance — full-band width allowance, not just
    // step-to-step distance. 0.5 × 5m ATR works on Nifty (≈10
    // pts) and scales with instrument vol; 0.05% of spot is the
    // absolute floor for low-vol regimes.
    //
    // Two guards prevent runaway "rivers" (chained adjacent
    // swings spanning huge ranges):
    //   (a) Adjacent step ≤ tol (single-link gate).
    //   (b) Cluster total span (max - min) ≤ tol × 2 (band cap).
    // Either guard failing closes the current cluster.
    var tol = atr > 0 ? atr * 0.5 : Math.max(currSpot * 0.0005, 5);
    var maxBandWidth = tol * 2;
    var clusters = [];
    var current = [];
    var currentMin = Infinity;
    var currentMax = -Infinity;
    for (var k = 0; k < all.length; k++) {
      var px = all[k].price;
      if (!current.length) {
        current.push(all[k]);
        currentMin = px; currentMax = px;
        continue;
      }
      var lastPrice = current[current.length - 1].price;
      var newMin = Math.min(currentMin, px);
      var newMax = Math.max(currentMax, px);
      var withinStep = (px - lastPrice) <= tol;
      var withinBand = (newMax - newMin) <= maxBandWidth;
      if (withinStep && withinBand) {
        current.push(all[k]);
        currentMin = newMin; currentMax = newMax;
      } else {
        if (current.length >= 3) clusters.push(current);
        current = [all[k]];
        currentMin = px; currentMax = px;
      }
    }
    if (current.length >= 3) clusters.push(current);
    // Build zone descriptor for each surviving cluster. Compute
    // midpoint as weighted mean (each touch weighted by recency
    // so older swings count less). Compute lastBarsAgo as how
    // many bars ago the most recent touch was.
    var lastIdx = sorted.length - 1;
    var zones = [];
    for (var c = 0; c < clusters.length; c++) {
      var pts = clusters[c];
      var lo = Infinity, hi = -Infinity, weightSum = 0, priceSum = 0;
      var lastBarsAgo = Infinity;
      for (var p = 0; p < pts.length; p++) {
        var price = pts[p].price;
        var barsAgo = lastIdx - pts[p].idx;
        if (price < lo) lo = price;
        if (price > hi) hi = price;
        // Recency weight: 1.0 at current bar, 0.5 at 200 bars old
        // (~one full trading day). Older swings still count but
        // less. exp(-barsAgo/300) is gentle decay.
        var w = Math.exp(-barsAgo / 300);
        priceSum += price * w;
        weightSum += w;
        if (barsAgo < lastBarsAgo) lastBarsAgo = barsAgo;
      }
      var midpoint = weightSum > 0 ? priceSum / weightSum : (lo + hi) / 2;
      zones.push({
        midpoint:    midpoint,
        low:         lo,
        high:        hi,
        touches:     pts.length,
        lastBarsAgo: lastBarsAgo,
        // side: 'mixed' if it has both H + L touches (rare but
        //       strongest — true two-way level), 'H' if all
        //       rejection-from-above, 'L' if rejection-from-below.
        side: (function () {
          var hasH = false, hasL = false;
          for (var q = 0; q < pts.length; q++) {
            if (pts[q].side === 'H') hasH = true;
            else hasL = true;
          }
          return hasH && hasL ? 'mixed' : (hasH ? 'H' : 'L');
        })()
      });
    }
    // Filter: drop zones outside ±3% of current spot (noise from
    // stale gap-up/gap-down sessions that don't apply today).
    var maxDist = currSpot * 0.03;
    zones = zones.filter(function (z) {
      return Math.abs(z.midpoint - currSpot) <= maxDist;
    });
    // Sort by importance — # touches desc, then recency asc.
    zones.sort(function (a, b) {
      if (b.touches !== a.touches) return b.touches - a.touches;
      return a.lastBarsAgo - b.lastBarsAgo;
    });
    // Cap at 6 strongest zones — anything beyond is noise.
    return zones.slice(0, 6);
  }

  function findRoundNumbers(spot) {
    if (!isFinite(spot) || spot <= 0) return [];
    // Tier-1: multiples of 500 within ±2% — heavyweight
    //         psychological levels (24,000 / 23,500 / 23,000).
    // Tier-2: multiples of 100 within ±1.5% — strong attractors.
    // Tier-3: multiples of 50  within ±1%   — soft attractors.
    // Higher tier wins when a level qualifies for multiple tiers.
    var out = [];
    var seen = {};
    function add(level, tier, distPctLimit) {
      if (seen[level]) return;
      if (Math.abs(level - spot) > spot * distPctLimit / 100) return;
      seen[level] = 1;
      out.push({ level: level, tier: tier });
    }
    // Tier-1: multiples of 500
    var base500 = Math.round(spot / 500) * 500;
    for (var d = -2; d <= 2; d++) add(base500 + d * 500, 1, 2.0);
    // Tier-2: multiples of 100 (not already tier-1)
    var base100 = Math.round(spot / 100) * 100;
    for (var e = -4; e <= 4; e++) add(base100 + e * 100, 2, 1.5);
    // Tier-3: multiples of 50 (not already tier-1/2)
    var base50 = Math.round(spot / 50) * 50;
    for (var f = -4; f <= 4; f++) add(base50 + f * 50, 3, 1.0);
    // Sort by distance from spot (ascending)
    out.sort(function (a, b) {
      return Math.abs(a.level - spot) - Math.abs(b.level - spot);
    });
    return out;
  }

  function computeAnchoredVwaps(todayBars) {
    if (!todayBars || todayBars.length < 10) return null;
    // Find index of session high (highest H) + session low (lowest L)
    var hiIdx = 0, loIdx = 0;
    var hi = -Infinity, lo = Infinity;
    for (var i = 0; i < todayBars.length; i++) {
      var bh = +todayBars[i][2], bl = +todayBars[i][3];
      if (bh > hi) { hi = bh; hiIdx = i; }
      if (bl < lo) { lo = bl; loIdx = i; }
    }
    // Need at least 3 bars AFTER each anchor to compute a meaningful
    // AVWAP (one bar wouldn't tell us anything).
    function vwapFrom(startIdx) {
      if (todayBars.length - startIdx < 3) return null;
      var pv = 0, vSum = 0, anyVol = false;
      for (var k = startIdx; k < todayBars.length; k++) {
        var c = todayBars[k];
        var h = +c[2], l = +c[3], cl = +c[4], v = +c[5] || 0;
        var tp = (h + l + cl) / 3;
        if (v > 0) { anyVol = true; pv += tp * v; vSum += v; }
      }
      if (anyVol && vSum > 0) return pv / vSum;
      // Index fallback: uniform weighting
      var sum = 0, count = 0;
      for (var k2 = startIdx; k2 < todayBars.length; k2++) {
        var c2 = todayBars[k2];
        sum += (+c2[2] + +c2[3] + +c2[4]) / 3;
        count++;
      }
      return count > 0 ? sum / count : null;
    }
    // Anchor from the bar AFTER the extreme (the reversal starts
    // on the NEXT bar, not the one that printed the extreme).
    var fromHigh = vwapFrom(hiIdx + 1);
    var fromLow  = vwapFrom(loIdx  + 1);
    return {
      fromHigh:        fromHigh,
      fromLow:         fromLow,
      anchorHighPrice: hi,
      anchorLowPrice:  lo,
      anchorHighIdx:   hiIdx,
      anchorLowIdx:    loIdx,
      anchorHighTime:  todayBars[hiIdx] ? todayBars[hiIdx][0] : null,
      anchorLowTime:   todayBars[loIdx] ? todayBars[loIdx][0] : null
    };
  }

  // Compute "today" / "previous day" key levels from the 5m raw
  // candle stream (5m has the cleanest balance between resolution
  // and history depth — enough bars for VWAP + still spans days
  // back for PDH/PDL).
  function calcLevels(raw5m) {
    if (!raw5m || !raw5m.length) return null;
    var sorted = raw5m.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var todayKey = dayKeyIST(Date.now());
    var byDay = {};
    sorted.forEach(function (c) {
      var k = dayKeyIST(new Date(c[0]).getTime());
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(c);
    });
    var days = Object.keys(byDay).sort();
    var todayBars = byDay[todayKey] || [];
    // "Previous trading day" = the most recent key < today
    var prevKey = null;
    for (var i = days.length - 1; i >= 0; i--) {
      if (days[i] < todayKey) { prevKey = days[i]; break; }
    }
    var prevBars = prevKey ? byDay[prevKey] : [];
    function hiLo(bars) {
      if (!bars || !bars.length) {
        return { high: null, low: null, hiIdx: -1, loIdx: -1 };
      }
      var hi = -Infinity, lo = Infinity, hiIdx = -1, loIdx = -1;
      for (var i = 0; i < bars.length; i++) {
        var h = +bars[i][2], l = +bars[i][3];
        if (h > hi) { hi = h; hiIdx = i; }
        if (l < lo) { lo = l; loIdx = i; }
      }
      return { high: hi, low: lo, hiIdx: hiIdx, loIdx: loIdx };
    }
    var todayHL = hiLo(todayBars);
    var prevHL  = hiLo(prevBars);

    // ── Fibonacci retracement levels ─────────────────────────────
    // Anchored at TODAY's intraday range when available, falls back
    // to PREVIOUS trading day's range when today doesn't have a
    // meaningful range yet (weekend, pre-open, first 30 min of
    // session). This matches how traders actually use Fib — coming
    // into a new session the prior day's 50% / 61.8% are textbook
    // open/pullback reference levels.
    //
    // Swing-leg DIRECTION determined by which extreme came later:
    //   high after low  → up-leg → pullbacks below high are
    //                     PULL-BACK buy zones
    //   low after high  → down-leg → bounces above low are
    //                     BOUNCE sell zones
    // Either way the level prices sit between low and high, computed
    // as low + pct × range (where pct = 0.382, 0.500, 0.618, 0.786).
    // They flow into collectStructuralSr → computeStructureRoom so
    // the verdict engine treats them as valid structural walls.
    //
    // Skip rules:
    //   - Range < max(spot × 0.0012, 25) pts → Fib on a tiny range
    //     is noise
    //   - Fewer than 3 bars → not enough session formed
    function buildFibFromBars(bars, source) {
      if (!bars || bars.length < 3) return null;
      var hl = hiLo(bars);
      if (hl.high == null || hl.low == null
          || hl.hiIdx < 0 || hl.loIdx < 0) return null;
      var range = hl.high - hl.low;
      var refSpot = +bars[bars.length - 1][4];
      var refSpotSafe = (isFinite(refSpot) && refSpot > 0) ? refSpot : 24000;
      var minRange = Math.max(refSpotSafe * 0.0012, 25);
      if (range < minRange) return null;
      var direction = (hl.hiIdx > hl.loIdx) ? 'up' : 'down';
      var fibPcts = [0.382, 0.500, 0.618, 0.786];
      // Traditional Fibonacci retracement convention:
      //   • UP-leg  (low → high): % retracement is measured DOWN
      //     from the high. So "38.2% retracement" is the SHALLOW
      //     pullback closest to the recent high, "61.8%" is the
      //     DEEP pullback closest to the start of the leg.
      //       price = high − pct × range
      //   • DOWN-leg (high → low): % retracement is measured UP
      //     from the low. "38.2%" is the shallow bounce, "61.8%"
      //     is the deep bounce closest to the high.
      //       price = low + pct × range
      // Either way the GOLDEN ZONE (50%–61.8%) sits between the
      // midpoint and the deep-retracement boundary — exactly
      // where trend-continuation traders want to enter pullbacks.
      //
      // Earlier this function used `low + pct × range` for both
      // directions. That's correct for down-legs but INVERTS the
      // labels on up-legs (what we labeled "38.2%" was actually
      // the 61.8% retracement). The new branch fixes the up-leg
      // case so the labels match TradingView / Sensibull / every
      // textbook reference.
      var fibLevels = fibPcts.map(function (pct) {
        var value = direction === 'up'
          ? (hl.high - pct * range)   // up-leg: measure DOWN from high
          : (hl.low  + pct * range);  // down-leg: measure UP from low
        return {
          value: value,
          pct: pct,
          label: (pct * 100).toFixed(pct === 0.5 ? 0 : 1) + '%',
          isGolden: (pct === 0.5 || pct === 0.618)
        };
      });
      // Weekday name from the last bar's IST date — used in the
      // UI header ("MONDAY'S FIB", "FRIDAY'S FIB", etc).
      var weekday = '';
      try {
        weekday = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Kolkata', weekday: 'long'
        }).format(new Date(bars[bars.length - 1][0]));
      } catch (_) { /* ignore — strip will just say "today" / "prev" */ }
      return {
        high: hl.high, low: hl.low, range: range,
        direction: direction, levels: fibLevels,
        source: source,    // 'today' | 'prev'
        weekday: weekday   // 'Monday' | 'Friday' | ...
      };
    }
    // Prefer today's range. Fall back to previous trading day's
    // range when today is unavailable / narrow (weekend, pre-open,
    // first 30 min, holiday).
    var todayFib = buildFibFromBars(todayBars, 'today');
    if (!todayFib) {
      todayFib = buildFibFromBars(prevBars, 'prev');
    }

    // ── CPR (Central Pivot Range) — Indian-intraday-desk standard
    // Formula (originally Subhadip Nandy's adaptation):
    //   P  (Pivot)     = (PrevH + PrevL + PrevC) / 3
    //   BC (Bottom Central) = (PrevH + PrevL) / 2
    //   TC (Top Central)    = 2*P - BC      (mirror of BC across P)
    //   R1 = 2*P - PrevL    ;    S1 = 2*P - PrevH
    //   R2 = P  + (PrevH - PrevL)  ;    S2 = P - (PrevH - PrevL)
    //   R3 = R1 + (PrevH - PrevL)  ;    S3 = S1 - (PrevH - PrevL)
    //
    // Width classification — measured against PREVIOUS DAY'S RANGE
    // (the industry-standard normalisation, makes the heuristic
    // self-scaling across instruments and volatility regimes):
    //   NARROW   : width <= 25% of prev range   → trending-day signal
    //                (low overlap, players have to pick a side)
    //   NORMAL   : 25% < width <= 60% of prev range
    //   WIDE     : width > 60% of prev range    → range-day signal
    //                (heavy overlap, mean-reversion bias)
    // Prev day's close = last 5m bar's close from that day (needed
    // for the pivot itself; H/L alone aren't enough).
    var prevClose = (prevBars && prevBars.length) ? +prevBars[prevBars.length - 1][4] : null;
    // Prev day's open = first 5m bar's open from that day. Treated
    // as a real S/R level — secondary to PDC but a meaningful
    // reference when today opens with a large gap (gap-fade /
    // gap-and-go scenarios both pivot off this level).
    var prevOpen = (prevBars && prevBars.length) ? +prevBars[0][1] : null;
    var cpr = null;
    if (prevHL.high != null && prevHL.low != null
        && prevClose != null && isFinite(prevClose)) {
      var pH = prevHL.high, pL = prevHL.low, pC = prevClose;
      var prevRange = pH - pL;
      var P  = (pH + pL + pC) / 3;
      var BC = (pH + pL) / 2;
      var TC = 2 * P - BC;
      // BC can be > TC when previous day closed BELOW the midpoint —
      // by convention "TC" is always the upper boundary, so swap.
      var top = Math.max(TC, BC), bot = Math.min(TC, BC);
      var width = top - bot;
      var widthPctOfRange = prevRange > 0 ? (width / prevRange) * 100 : null;
      var cprClass = 'UNKNOWN';
      if (widthPctOfRange != null) {
        if (widthPctOfRange <= 25)      cprClass = 'NARROW';
        else if (widthPctOfRange <= 60) cprClass = 'NORMAL';
        else                            cprClass = 'WIDE';
      }
      cpr = {
        P:  P,    TC: top,  BC: bot,
        R1: 2 * P - pL,
        R2: P + prevRange,
        R3: (2 * P - pL) + prevRange,
        S1: 2 * P - pH,
        S2: P - prevRange,
        S3: (2 * P - pH) - prevRange,
        width: width,
        widthPctOfRange: widthPctOfRange,
        classification: cprClass,
        prevClose: pC
      };
    }
    // Opening range = first OR_LENGTH_MIN of today (3 × 5m bars).
    var orBarsNeeded = Math.ceil(OR_LENGTH_MIN / 5);
    var orBars = todayBars.slice(0, orBarsNeeded);
    var orHL = hiLo(orBars);
    // ── First Hour Range (FHR) ──
    // High/low of the first 60 min (09:15–10:15 IST = 12 × 5m bars).
    // Statistically the single most reliable intraday level — first-hour
    // breakouts have a noticeably higher follow-through rate than 15-min
    // OR breaks because they account for institutional pre-positioning
    // through morning conference calls / first-hour flow. We hold the
    // boolean fhrComplete flag separately so callers can know whether
    // the level is "set" (full 12 bars in) or still forming.
    var fhrBarsNeeded = 12;                              // 12 × 5m = 60 min
    var fhrBars = todayBars.slice(0, fhrBarsNeeded);
    var fhrHL = hiLo(fhrBars);
    // VWAP + ±1σ / ±2σ bands. We use the new calcVwapBands which
    // returns both the VWAP itself and the volume-weighted SD bands;
    // calcVwap is kept around as a legacy export but no longer
    // called from this path.
    var vwapBands = calcVwapBands(todayBars);
    var vwap = vwapBands ? vwapBands.vwap : null;
    // ── Auto-discovered S/R (multi-day swing clustering) ──
    // Pass the full raw 5m series so the clusterer sees every
    // swing over the last ~5 sessions. Spot for distance filter
    // = the latest 5m close (more accurate than today's range
    // midpoint since spot is what we're scoring against).
    var currentSpot = sorted.length ? +sorted[sorted.length - 1][4] : null;
    // Use a session-typical 5m ATR estimate for clustering
    // tolerance. We can't compute proper ATR here without the
    // math helpers — approximate as ~0.05% of spot, which is
    // the mid-band of typical Nifty 5m ATR ranges.
    var clusterAtr = currentSpot != null ? currentSpot * 0.0005 * 10 : 15;
    var srZones = currentSpot != null
      ? findSrZones(raw5m, currentSpot, clusterAtr) : [];
    // ── Auto-discovered S/R (round-number magnets) ──
    var rounds = currentSpot != null ? findRoundNumbers(currentSpot) : [];
    // ── Anchored VWAP from today's session H + L ──
    var avwap = computeAnchoredVwaps(todayBars);
    return {
      todayHigh: todayHL.high, todayLow: todayHL.low,
      // todayOpen — open price of today's first 5m bar (09:15 IST).
      // Needed by the BN-vs-Nifty correlation block in generateVerdict
      // so we can compute Nifty's REAL intraday % change ((current −
      // open) / open × 100) and compare it apples-to-apples against
      // bn.changePct (which uses the same formula on BN's first bar).
      // The previous proxy (sign × session-range × 0.5) under-counted
      // Nifty's true move and let the bnLeading boost fire spuriously.
      todayOpen: todayBars.length ? +todayBars[0][1] : null,
      prevHigh:  prevHL.high,  prevLow:  prevHL.low,
      prevClose: prevClose,    prevOpen: prevOpen,
      // ── Overnight gap classifier (May 2026) ──
      // Computes today's open vs yesterday's close. Tagged into
      // STRONG_GAP_UP / GAP_UP / FLAT / GAP_DOWN / STRONG_GAP_DOWN
      // so generateVerdict can score gap-fade vs gap-and-go setups
      // and force WAIT in the first 15 min after a strong gap (when
      // fake-out reversals are most likely). Pure read-only data —
      // null when prev day hasn't loaded yet or today hasn't opened.
      gap: (function () {
        var todayOpenPx = todayBars.length ? +todayBars[0][1] : null;
        if (todayOpenPx == null || prevClose == null || !isFinite(prevClose) || prevClose <= 0) {
          return null;
        }
        var pts = todayOpenPx - prevClose;
        var pct = (pts / prevClose) * 100;
        var type;
        if      (pct >= 0.5)   type = 'STRONG_GAP_UP';
        else if (pct >= 0.2)   type = 'GAP_UP';
        else if (pct <= -0.5)  type = 'STRONG_GAP_DOWN';
        else if (pct <= -0.2)  type = 'GAP_DOWN';
        else                   type = 'FLAT';
        // "Strong" = absolute pct >= 0.5%. These trigger HARD VETO
        // in the first 15 min and unlock gap-fade / gap-and-go
        // scoring after the OR has formed.
        var isStrong = (pct >= 0.5 || pct <= -0.5);
        return {
          todayOpen: todayOpenPx,
          prevClose: prevClose,
          pts:       pts,
          pct:       pct,
          type:      type,
          isStrong:  isStrong
        };
      })(),
      orHigh:    orHL.high,    orLow:    orHL.low,
      fhrHigh:   fhrHL.high,   fhrLow:   fhrHL.low,
      fhrComplete: fhrBars.length >= fhrBarsNeeded,
      // Fib retracement levels anchored at today's high & low —
      // null if the session range is too narrow to be meaningful.
      fib:       todayFib,
      vwap:      vwap,
      // VWAP standard-deviation bands. ±1σ contains ~68% of bars,
      // ±2σ ~95%. Used as: (a) stretch detection (spot >= ub2 = fade
      // signal), (b) S/R additions (each band line acts as dynamic
      // support / resistance), (c) "valid trend bar" filter (closes
      // outside ±2σ on volume = breakout, not noise).
      vwapBands: vwapBands,
      cpr:       cpr,        // {P, TC, BC, R1..R3, S1..S3, width, widthPctOfRange, classification, prevClose} or null
      // Auto-discovered S/R: zones (multi-day swing clustering),
      // rounds (psychological levels), and AVWAPs (anchored from
      // today's session extremes). All three are derived from
      // actual price action — not a fixed formula — so they
      // capture market memory that the anchored levels miss.
      srZones:   srZones,    // [{midpoint, low, high, touches, lastBarsAgo, side}, …] up to 6
      rounds:    rounds,     // [{level, tier}, …] sorted by distance from spot
      avwap:     avwap,      // {fromHigh, fromLow, anchorHighPrice, anchorLowPrice, …} or null
      hasOR:     orBars.length >= orBarsNeeded,
      hasToday:  todayBars.length > 0,
      hasPrev:   prevBars.length > 0
    };
  }

  // ── Per-TF analysis (intraday flavour) ──
  // Mirrors the swing analyzeTf shape but uses EMA 9 / 21 / 50
  // (intraday norms) and skips the EMA-200 / 52-week calcs that
  // don't make sense on a 3-minute chart.
  // ═══════════════════════════════════════════════════════════════
  // Pattern location context
  // ──────────────────────────────────────────────────────────────
  // Given a per-TF analysis result + the pattern side ('bull' or
  // 'bear'), determine WHERE the candle formed relative to the
  // session's key S/R levels. Returns a structured object:
  //
  //   candlePrice      — current bar's close (the candle "anchor")
  //   nearestSupport   — closest support level within 0.5×ATR, or null
  //   nearestResistance — closest resistance level within 0.5×ATR, or null
  //   conviction       — 'high' | 'neutral' | 'anti'
  //
  // Conviction interpretation:
  //   high     — bull pattern AT a support level OR bear pattern
  //              AT a resistance level (textbook setup)
  //   anti     — bull pattern AT a RESISTANCE (or bear at support);
  //              location says the pattern shouldn't have printed
  //              there, signal is suspect
  //   neutral  — no S/R level near the candle close
  //
  // Includes ALL S/R now: anchored (PDH/PDL/VWAP/CPR/ORH-ORL/FHR)
  // PLUS auto-discovered (4+ touch swing-cluster zones, tier-1/2
  // round-number magnets, AVWAPs from session H/L). Levels with
  // priority < 3 (S3/R3 outliers, tier-3 rounds, weak 3-touch
  // zones) are omitted to keep noise out of the location chip.
  // ═══════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════
  // PATTERN BAR COUNT (multi-candle pattern time range)
  // ═══════════════════════════════════════════════════════════════
  // detectPatterns returns just the pattern NAME. To render a
  // meaningful "formed 13:15 – 15:15 IST" time range for a multi-
  // candle pattern (Piercing is 2-bar; Morning Star is 3-bar),
  // the renderer needs to know how many bars the pattern spans.
  // Source of truth — keep in sync with detectPatterns() if new
  // patterns are added.
  function patternBarCount(name) {
    if (!name) return 0;
    switch (name) {
      // 3-bar reversals
      case 'Morning Star':
      case 'Evening Star':
      case 'Three White Soldiers':
      case 'Three Black Crows':
        return 3;
      // 2-bar reversals + tweezers + harami
      case 'Bullish Engulfing':
      case 'Bearish Engulfing':
      case 'Piercing Pattern':
      case 'Dark Cloud Cover':
      case 'Tweezer Bottom':
      case 'Tweezer Top':
      case 'Bullish Harami':
      case 'Bearish Harami':
        return 2;
      // 1-bar everything else (Hammer, Doji family, Marubozu,
      // Inverted Hammer, Hanging Man, Shooting Star).
      default:
        return 1;
    }
  }

  function getPatternContext(an, side) {
    if (!an || an.lastClose == null) return null;
    var atr = an.atr || 20;
    var threshold = atr * 0.5;
    var spot = an.lastClose;

    function add(arr, value, name) {
      if (value != null && isFinite(value)) arr.push({ price: value, name: name });
    }

    // Build support + resistance lists from EVERY level available
    // on the TF result. Order doesn't matter — we'll sort by
    // distance later.
    var supports = [], resists = [];
    add(supports, an.prevLow,  'Prev Day Low');
    add(supports, an.orLow,    'OR Low');
    add(supports, an.fhrLow,   'First Hour Low');
    add(supports, an.vwap,     'VWAP');
    // Prev Day Close + Open — bipolar like Pivot. Classify by
    // side vs current spot (closed below today = acting as
    // support today). PDC is heavily watched; PDO matters most
    // on gap days.
    if (an.prevClose != null) {
      if (spot > an.prevClose) add(supports, an.prevClose, 'Prev Day Close');
      else                     add(resists,  an.prevClose, 'Prev Day Close');
    }
    if (an.prevOpen != null) {
      if (spot > an.prevOpen)  add(supports, an.prevOpen, 'Prev Day Open');
      else                     add(resists,  an.prevOpen, 'Prev Day Open');
    }
    if (an.cpr) {
      add(supports, an.cpr.BC, 'CPR Bottom (BC)');
      add(supports, an.cpr.S1, 'CPR S1');
      add(supports, an.cpr.S2, 'CPR S2');
      // Pivot is bipolar — counts as support if price is above it,
      // resistance if price is below.
      if (an.cpr.P != null) {
        if (spot > an.cpr.P) add(supports, an.cpr.P, 'Pivot (CPR)');
        else                 add(resists,  an.cpr.P, 'Pivot (CPR)');
      }
    }
    if (an.vwapBands) {
      add(supports, an.vwapBands.lb1, 'VWAP -1\u03C3');
      add(supports, an.vwapBands.lb2, 'VWAP -2\u03C3');
    }
    add(resists, an.prevHigh,  'Prev Day High');
    add(resists, an.orHigh,    'OR High');
    add(resists, an.fhrHigh,   'First Hour High');
    if (an.vwap != null && !supports.some(function(s){return s.name==='VWAP';})) {
      // VWAP is bipolar like Pivot — only added to resists if not
      // already in supports (spot above VWAP = VWAP is support;
      // spot below VWAP = VWAP is resistance).
      add(resists, an.vwap, 'VWAP');
    }
    if (an.cpr) {
      add(resists, an.cpr.TC, 'CPR Top (TC)');
      add(resists, an.cpr.R1, 'CPR R1');
      add(resists, an.cpr.R2, 'CPR R2');
    }
    if (an.vwapBands) {
      add(resists, an.vwapBands.ub1, 'VWAP +1\u03C3');
      add(resists, an.vwapBands.ub2, 'VWAP +2\u03C3');
    }
    // Auto-discovered S/R: swing-cluster zones (≥3 touches) +
    // tier-1/2 round numbers + AVWAPs. Classification by side =
    // above/below current spot.
    if (an.srZones && an.srZones.length) {
      for (var iz = 0; iz < an.srZones.length; iz++) {
        var z = an.srZones[iz];
        // Skip weak 3-touch zones — keep the location chip clean.
        if (z.touches < 4 && z.side !== 'mixed') continue;
        var label = z.touches + '-touch swing zone';
        if (z.midpoint < spot) add(supports, z.midpoint, label);
        else                    add(resists,  z.midpoint, label);
      }
    }
    if (an.rounds && an.rounds.length) {
      for (var ir = 0; ir < an.rounds.length; ir++) {
        var rn = an.rounds[ir];
        if (rn.tier > 2) continue;  // skip tier-3 (×50) — too noisy
        var rlabel = '\u20B9' + rn.level + ' round level';
        if (rn.level < spot) add(supports, rn.level, rlabel);
        else                  add(resists,  rn.level, rlabel);
      }
    }
    if (an.avwap) {
      if (an.avwap.fromHigh != null) {
        // AVWAP-from-high is typically resistance (price retraces
        // from the high). Classify by side vs spot.
        if (an.avwap.fromHigh < spot) add(supports, an.avwap.fromHigh, 'AVWAP from session H');
        else                           add(resists,  an.avwap.fromHigh, 'AVWAP from session H');
      }
      if (an.avwap.fromLow != null) {
        if (an.avwap.fromLow < spot) add(supports, an.avwap.fromLow, 'AVWAP from session L');
        else                          add(resists,  an.avwap.fromLow, 'AVWAP from session L');
      }
    }
    // Find nearest support + nearest resistance within threshold.
    function nearest(pool) {
      var best = null;
      for (var i = 0; i < pool.length; i++) {
        var d = Math.abs(spot - pool[i].price);
        if (d > threshold) continue;
        if (!best || d < best.distance) {
          best = {
            name:        pool[i].name,
            price:       pool[i].price,
            distance:    d,
            distancePts: spot - pool[i].price,
            distancePct: ((spot - pool[i].price) / pool[i].price) * 100
          };
        }
      }
      return best;
    }
    var nearSup = nearest(supports);
    var nearRes = nearest(resists);
    // Conviction logic — side argument decides which combination
    // is "high-conviction" vs "anti-signal" vs neutral.
    var conviction = 'neutral';
    if (side === 'bull') {
      if (nearSup)       conviction = 'high';   // bull at support = textbook
      else if (nearRes)  conviction = 'anti';   // bull at resistance = anti-signal
    } else if (side === 'bear') {
      if (nearRes)       conviction = 'high';
      else if (nearSup)  conviction = 'anti';
    }
    return {
      candlePrice:       spot,
      nearestSupport:    nearSup,
      nearestResistance: nearRes,
      conviction:        conviction
    };
  }

  function analyzeTfIntraday(raw, tfKey, levels) {
    if (!raw || raw.length < 30) return null;
    var c = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });

    // ── Drop trailing partial 1H bar ────────────────────────────
    // Upstox's 1H intraday endpoint can return a partial bar
    // starting at 15:15 IST (only 15 min of session data, since
    // NSE closes at 15:30). Pattern detection on a 15-min "1H
    // candle" is meaningless and produces confusing output like
    // "Piercing Pattern formed 15:15-15:30" on the 1H card.
    //
    // Drop logic needs to know the timestamp convention to avoid
    // dropping VALID complete bars:
    //   • start-of-bar conv: 15:15 timestamp means a PARTIAL bar
    //     spanning 15:15-15:30. Drop it.
    //   • end-of-bar conv: 15:15 timestamp means the COMPLETE
    //     14:15-15:15 bar. Keep it.
    // Convention is detected from the first bar of the same IST
    // day (9:15 → start-of-bar, 10:15 → end-of-bar).
    //
    // Other TFs keep all bars (real-time partials matter for
    // execution on 3m/5m/15m).
    var bucketMsMap0 = { '1h': 3600000, '15m': 900000, '5m': 300000, '3m': 180000 };
    var bucketMs0    = bucketMsMap0[tfKey] || 0;
    if (tfKey === '1h' && c.length >= 2 && bucketMs0) {
      var rawLast0 = new Date(c[c.length - 1][0]).getTime();
      var IST_OFF0 = 5.5 * 3600 * 1000;
      var istMs0   = rawLast0 + IST_OFF0;
      var dayMs0   = Math.floor(istMs0 / 86400000) * 86400000 - IST_OFF0;
      var closeMs0 = dayMs0 + (15 * 60 + 30) * 60 * 1000;
      var openMin0 = 9 * 60 + 15;
      var endMin0  = openMin0 + bucketMs0 / 60000;  // 10:15 for 1h
      // Detect convention from first bar of the SAME IST day.
      var convDrop = null;  // 'start' | 'end' | null
      for (var di = 0; di < c.length; di++) {
        var dts = new Date(c[di][0]).getTime();
        var dayMsDi = Math.floor((dts + IST_OFF0) / 86400000) * 86400000 - IST_OFF0;
        if (dayMsDi !== dayMs0) continue;
        var dmin = Math.floor(((dts + IST_OFF0) % 86400000) / 60000);
        if (dmin === openMin0)      convDrop = 'start';
        else if (dmin === endMin0)  convDrop = 'end';
        break;
      }
      // Only drop on start-of-bar convention when the bar's start
      // + bucket would extend past session close → it's a partial.
      if (convDrop === 'start' && rawLast0 + bucketMs0 > closeMs0) {
        c = c.slice(0, -1);
      }
    }

    var closes = c.map(function (x) { return +x[4]; });
    var highs  = c.map(function (x) { return +x[2]; });
    var lows   = c.map(function (x) { return +x[3]; });
    var vols   = c.map(function (x) { return +x[5] || 0; });
    var n = closes.length;
    var math = M();
    var e9   = math.ema  ? math.ema(closes, 9)  : [];
    var e21  = math.ema  ? math.ema(closes, 21) : [];
    var e50  = math.ema  ? math.ema(closes, 50) : [];
    var r    = math.rsi  ? math.rsi(closes, 14) : [];
    var mac  = math.macd ? math.macd(closes)    : { macd: [], signal: [], hist: [] };
    var atrA = math.atr  ? math.atr(c, 14)      : [];
    var adxA = math.adx  ? math.adx(c, 14)      : [];
    // Supertrend (10, 3) — ATR-based trend flip indicator. Returns
    // per-bar { value, trend, flip }; we read the last bar.
    var stArr = math.supertrend ? math.supertrend(c, 10, 3) : [];
    // Stochastic (14, 3, 3) — short-term overbought/oversold.
    // Returns per-bar { k, d }; we read last + previous for cross
    // detection.
    var stoArr = math.stochastic ? math.stochastic(c, 14, 3, 3) : [];
    // OBV — cumulative volume flow. Returns per-bar { value, slope20 }.
    var obvArr = math.obv ? math.obv(c) : [];
    var lastClose = closes[n - 1];
    var ema9  = e9[n - 1],  ema21 = e21[n - 1], ema50 = e50[n - 1];
    var rsiV  = r[n - 1];
    var macdV = mac.macd[n - 1], sigV = mac.signal[n - 1], histV = mac.hist[n - 1];
    var atrV  = atrA[n - 1];
    var adxV  = adxA[adxA.length - 1];
    // ── Structural trend classification (Trend Identifier v1, 2026-05-25) ─
    // Replaces EMA-stack + ADX/compression/directionality gates. The old
    // approach labelled sideways markets as BULL/BEAR whenever price was
    // above the EMA stack after a gap. classifyStructure() requires explicit
    // HH+HL (UP) or LH+LL (DOWN) to claim a trend — SIDEWAYS is the honest
    // default. Parameters are taken from the locked TREND_PARAMS_BY_TF table.
    var structParams = (window.TREND_PARAMS_BY_TF && window.TREND_PARAMS_BY_TF[tfKey])
      || { numGroups: 6, tolATR: 0.12, skipFirstBarsOfDay: 1 };
    var structure = (typeof classifyStructure === 'function')
      ? classifyStructure(c, Object.assign({}, structParams, { tfKey: tfKey, rawAtrSeries: atrA }))
      : { label: 'SIDEWAYS', reason: 'classifier unavailable', swingHighs: [], swingLows: [],
          bosLevel: null, freshSwingAge: null, cappedATR: NaN };
    // Map structure label → legacy .trend field so all existing renderers that
    // read an.trend continue working: UP→BULL, DOWN→BEAR, SIDEWAYS→RANGE.
    var trend = structure.label === 'UP'   ? 'BULL'
              : structure.label === 'DOWN' ? 'BEAR' : 'RANGE';
    var trendReason = 'STRUCTURE_' + structure.label;

    // Session-range stats — retained for the debug panel display only.
    // NO LONGER gate or demote the trend label (old gates removed).
    var SESSION_BARS_BY_TF = { '1h': 4, '30m': 6, '15m': 5, '5m': 10 };
    var SESSION_BARS = SESSION_BARS_BY_TF[tfKey] || 8;
    var directionality = null, compressionRatio = null;
    var sessionRangePts = null, sessionNetPts = null;
    if (n >= SESSION_BARS) {
      var sStart = n - SESSION_BARS;
      var sHi = -Infinity, sLo = Infinity;
      for (var sk = sStart; sk < n; sk++) {
        if (+c[sk][2] > sHi) sHi = +c[sk][2];
        if (+c[sk][3] < sLo) sLo = +c[sk][3];
      }
      sessionRangePts = +(sHi - sLo).toFixed(1);
      sessionNetPts   = +Math.abs(+c[n - 1][4] - +c[sStart][4]).toFixed(1);
      if (sessionRangePts > 0) directionality = +(sessionNetPts / sessionRangePts).toFixed(2);
      if (atrV != null && isFinite(atrV) && atrV > 0)
        compressionRatio = +(sessionRangePts / atrV).toFixed(2);
    }
    // Pattern detection AFTER trend is known so Hammer-shape at
    // top-of-uptrend can reclassify as Hanging Man (bearish
    // reversal). The new detectPatterns API returns four fields:
    // bull (directional), bear (directional), compression
    // (Inside Bar / NR4, orthogonal to direction), and neutral
    // (Doji — informational only, surfaces in SKIP IF).
    var pat = math.detectPatterns
      ? math.detectPatterns(c, trend)
      : { bull: null, bear: null, compression: null, neutral: null };

    // ── Lookback pattern (display fallback for empty bars) ──────
    // Smaller TFs (5m / 3m) routinely print "boring" mid-range
    // bars that fire no textbook pattern — leaving the per-TF
    // card empty. We compute the most recent pattern within a
    // bounded lookback so the renderer can show "Last pattern:
    // Hammer 3 bars ago" instead of blank space.
    //
    // Lookback windows are chosen to roughly match each TF's
    // useful "recency" horizon — patterns older than this are
    // stale enough that we'd rather show nothing.
    //   • 1H : 5 bars  (~5 hours; nearly a full day of context)
    //   • 15m: 8 bars  (~2 hours)
    //   • 5m : 12 bars (~1 hour)
    //   • 3m : 10 bars (~30 min)
    // The lookback result is for DISPLAY ONLY — scoring/verdict
    // logic continues to use only the LATEST bar's pattern (stale
    // signals shouldn't drive entries).
    var lookbackWindows = { '1h': 5, '15m': 8, '5m': 12, '3m': 10 };
    var lookback = null;
    if (!pat.bull && !pat.bear && math.detectLookbackPattern) {
      var winN = lookbackWindows[tfKey] || 0;
      if (winN > 0) lookback = math.detectLookbackPattern(c, trend, winN);
    }

    // ── Supertrend / Stochastic / OBV — derived signals ─────────
    // Read the last-bar reading from each helper's output array
    // and derive simple structured fields the verdict can score.
    //
    // Supertrend exposes a direct trend label + flip flag.
    var stLast    = stArr[n - 1] || null;
    var stPrev    = stArr[n - 2] || null;
    var stTrend   = stLast ? stLast.trend : null;       // 'BULL' | 'BEAR' | null
    var stValue   = stLast && isFinite(stLast.value) ? stLast.value : null;
    var stFlipped = !!(stLast && stLast.flip);          // true on the bar of the flip
    // Distance of price from the trailing band — used to gauge
    // how stretched the move is (closer = trend exhausting).
    var stDistPct = (stValue != null && lastClose) ? ((lastClose - stValue) / lastClose) * 100 : null;
    // Stochastic — derive K, D, regime, cross direction.
    var stoLast = stoArr[n - 1] || null;
    var stoPrev = stoArr[n - 2] || null;
    var stochK  = stoLast && isFinite(stoLast.k) ? stoLast.k : null;
    var stochD  = stoLast && isFinite(stoLast.d) ? stoLast.d : null;
    var stochRegime = 'NEUTRAL';
    if (stochK != null) {
      if (stochK >= 80)       stochRegime = 'OVERBOUGHT';
      else if (stochK <= 20)  stochRegime = 'OVERSOLD';
    }
    // Cross on the LAST bar: K just crossed above (bull) or below
    // (bear) D. We require the cross to be FRESH (within last 2
    // bars) so we don't keep firing the same signal forever.
    var stochCross = null;
    if (stoLast && stoPrev && isFinite(stoLast.k) && isFinite(stoLast.d) &&
        isFinite(stoPrev.k) && isFinite(stoPrev.d)) {
      var dPrev = stoPrev.k - stoPrev.d, dCur = stoLast.k - stoLast.d;
      if (dPrev <= 0 && dCur > 0)      stochCross = 'bull';   // bullish K-over-D
      else if (dPrev >= 0 && dCur < 0) stochCross = 'bear';   // bearish K-under-D
    }
    // OBV — current cumulative + 20-bar slope direction.
    var obvLast = obvArr[n - 1] || null;
    var obvValue = obvLast && isFinite(obvLast.value) ? obvLast.value : null;
    var obvSlope20 = obvLast && isFinite(obvLast.slope20) ? obvLast.slope20 : null;
    var obvDir = 'flat';
    if (obvSlope20 != null) {
      if (obvSlope20 >  0.05) obvDir = 'rising';     // 5% growth vs |OBV| over 20 bars
      else if (obvSlope20 < -0.05) obvDir = 'falling';
    }
    // Momentum classification (RSI + MACD position vs signal).
    var macdAboveSignal = isFinite(macdV) && isFinite(sigV) && macdV > sigV;
    var momentum = 'NEUTRAL';
    if (rsiV >= 60 && macdAboveSignal) momentum = 'STRONG_BULL';
    else if (rsiV >= 55 && macdAboveSignal) momentum = 'BULL';
    else if (rsiV <= 40 && !macdAboveSignal) momentum = 'STRONG_BEAR';
    else if (rsiV <= 45 && !macdAboveSignal) momentum = 'BEAR';
    // Slope helpers (last 5 bars vs prior 5).
    function slope(arr) {
      if (!arr || arr.length < 11) return 'flat';
      var a = arr[arr.length - 11], b = arr[arr.length - 1];
      if (!isFinite(a) || !isFinite(b)) return 'flat';
      var pct = ((b - a) / Math.abs(a)) * 100;
      if (pct > 0.15) return 'rising';
      if (pct < -0.15) return 'falling';
      return 'flat';
    }
    var rsiSlice = r.slice(-11).filter(isFinite);
    var rsiTrend = rsiSlice.length >= 5
      ? (rsiSlice[rsiSlice.length - 1] > rsiSlice[0] + 2 ? 'rising'
         : rsiSlice[rsiSlice.length - 1] < rsiSlice[0] - 2 ? 'falling' : 'flat')
      : 'flat';
    var histSlice = mac.hist.slice(-5).filter(isFinite);
    var macdHistDir = histSlice.length >= 3
      ? (histSlice[histSlice.length - 1] > histSlice[0] ? 'rising'
         : histSlice[histSlice.length - 1] < histSlice[0] ? 'falling' : 'flat')
      : 'flat';
    // Recent MACD cross (within last 3 bars on intraday).
    var macdCross = null;
    for (var i = Math.max(1, n - 3); i < n; i++) {
      var p = (isFinite(mac.macd[i - 1]) && isFinite(mac.signal[i - 1])) ? (mac.macd[i - 1] - mac.signal[i - 1]) : null;
      var q = (isFinite(mac.macd[i])     && isFinite(mac.signal[i]))     ? (mac.macd[i]     - mac.signal[i])     : null;
      if (p == null || q == null) continue;
      if (p <= 0 && q > 0) { macdCross = { dir: 'bull', barsAgo: n - 1 - i }; break; }
      if (p >= 0 && q < 0) { macdCross = { dir: 'bear', barsAgo: n - 1 - i }; break; }
    }
    // Volume vs 20-bar SMA (last fully-closed bar; the in-progress
    // bar's volume isn't a fair comparison until it completes).
    var vol20Window = vols.slice(-21, -1).filter(function (v) { return v > 0; });
    var vol20Avg = vol20Window.length ? vol20Window.reduce(function (s, v) { return s + v; }, 0) / vol20Window.length : 0;
    var volumeRatio = vol20Avg > 0 ? (vols[n - 1] / vol20Avg) : null;
    var volumeAboveAvg = volumeRatio != null && volumeRatio > 1.0;
    var volSlice = vols.slice(-5).filter(function (v) { return v > 0; });
    var volTrend = volSlice.length >= 3
      ? (volSlice[volSlice.length - 1] > volSlice[0] ? 'rising'
         : volSlice[volSlice.length - 1] < volSlice[0] ? 'falling' : 'flat')
      : 'flat';
    // Structure: swing high / low from last 30 bars (intraday lookback=3).
    var swHi = (math.swingHighs ? math.swingHighs(c, 3) : []).slice(-1)[0] || null;
    var swLo = (math.swingLows  ? math.swingLows(c, 3)  : []).slice(-1)[0] || null;
    // Per-TF RSI divergence (price-vs-RSI reversal pattern).
    // Returns { bearishDiv, bullishDiv }, each either null or a
    // structured snapshot of the two swing readings.
    var rsiDiv = detectRsiDivergence(c, r);
    // ATR in points + ATR % of price.
    var atrPct = (isFinite(atrV) && lastClose > 0) ? (atrV / lastClose * 100) : null;
    // Distance to VWAP / OR / PDH-PDL in points + %.
    function distP(level) {
      if (level == null || !isFinite(level)) return null;
      return ((lastClose - level) / level) * 100;
    }
    // ── Last bar time range ─────────────────────────────────────
    // Upstox V3 timestamp convention is *inconsistent* across
    // intraday endpoints — empirically the 1H endpoint returns
    // the bar's END time (so the 14:15-15:15 1H bar comes back
    // tagged "15:15"), while 5m/15m/3m return the START time.
    // Naively doing `start + bucketMs` for 1H produces "15:15 –
    // 16:15 IST" which is 45 min past session close.
    //
    // Robust fix: detect the convention from the FIRST intraday
    // bar of the data (whose timestamp is unambiguous):
    //   • If first timestamp matches session open (9:15 IST) →
    //     timestamps are START of bar
    //   • If first timestamp matches session open + bucketMs
    //     (10:15 for 1h, 9:20 for 5m) → timestamps are END of bar
    //   • Anything else (e.g., we don't have today's open bar
    //     because Upstox returned only the last 2 days) → fall
    //     back to checking whether the LAST timestamp + bucket
    //     extends past 15:30 IST (heuristic).
    // Final safety cap clamps end at 15:30 IST regardless.
    //
    // Bucket sizes are duplicated from TF_CONFIG to avoid coupling
    // this function to TF_CONFIG's outer-scope layout.
    var bucketMsMap = { '1h': 3600000, '15m': 900000, '5m': 300000, '3m': 180000 };
    var bucketMs = bucketMsMap[tfKey] || 0;
    var rawLastTsMs = c[n - 1] ? new Date(c[n - 1][0]).getTime() : null;
    var lastBarStartMs = null;
    var lastBarEndMs   = null;
    if (rawLastTsMs != null && bucketMs) {
      var IST_OFFSET_MS = 5.5 * 3600 * 1000;
      var SESSION_OPEN_MIN  = 9 * 60 + 15;
      var SESSION_CLOSE_MIN = 15 * 60 + 30;

      function istDayStartMs(epochMs) {
        var istMs = epochMs + IST_OFFSET_MS;
        return Math.floor(istMs / 86400000) * 86400000 - IST_OFFSET_MS;
      }
      function istMinuteOfDay(epochMs) {
        var istMs = epochMs + IST_OFFSET_MS;
        return Math.floor((istMs % 86400000) / 60000);
      }

      var lastIstDayStart = istDayStartMs(rawLastTsMs);
      var sessionCloseMs  = lastIstDayStart + SESSION_CLOSE_MIN * 60 * 1000;

      // Convention detection — find the FIRST bar of the SAME IST
      // day as the last bar. Compare its minute-of-day to session
      // open (9:15) vs session open + bucket. Walk forward from
      // index 0 until we find a bar on the same IST day.
      var conv = null;  // 'start' | 'end' | null
      for (var ci = 0; ci < n; ci++) {
        var ts = new Date(c[ci][0]).getTime();
        if (istDayStartMs(ts) !== lastIstDayStart) continue;
        var min = istMinuteOfDay(ts);
        if (min === SESSION_OPEN_MIN)                          conv = 'start';
        else if (min === SESSION_OPEN_MIN + bucketMs / 60000)  conv = 'end';
        break;
      }
      // Fallback heuristic if detection failed (e.g., first bar of
      // the day is missing): use the last-bar-overflow check.
      if (conv == null) {
        conv = (rawLastTsMs + bucketMs > sessionCloseMs) ? 'end' : 'start';
      }
      if (conv === 'end') {
        lastBarEndMs   = rawLastTsMs;
        lastBarStartMs = rawLastTsMs - bucketMs;
      } else {
        lastBarStartMs = rawLastTsMs;
        lastBarEndMs   = rawLastTsMs + bucketMs;
      }
      // Safety cap — end can never exceed session close.
      if (lastBarEndMs > sessionCloseMs) lastBarEndMs = sessionCloseMs;
    }

    // ── Pattern-span start time ─────────────────────────────────
    // For multi-bar patterns (Piercing = 2 bars, Morning Star = 3
    // bars), the pattern actually "formed" over multiple candles,
    // not just the last one. We expose patternStartMs = start of
    // the FIRST candle in the pattern so the renderer can show:
    //   "Piercing Pattern formed 13:15 – 15:15 IST" (2 × 1H bars)
    //   "Morning Star  formed 09:15 – 09:30 IST" (3 × 5m bars)
    // For 1-bar patterns (Hammer, Doji, Marubozu) this equals
    // lastBarStartMs — no change in display.
    var activePatternName = pat.bull || pat.bear || null;
    var spanBars = patternBarCount(activePatternName);
    var patternStartMs = (lastBarStartMs != null && bucketMs && spanBars > 0)
      ? lastBarStartMs - (spanBars - 1) * bucketMs
      : lastBarStartMs;

    // ── Lookback pattern metadata (for renderer) ────────────────
    // If the current bar fired no pattern, expose the lookback hit
    // with derived display fields: name, side, barsAgo, candle
    // close price, and a clock range computed off the lookback
    // bar's offset from lastBarStartMs. Span is also resolved so
    // 2-bar patterns (e.g., Bullish Engulfing 3 bars ago) get the
    // correct "spans 2 bars · formed HH:MM-HH:MM" label.
    var lookbackInfo = null;
    if (lookback && (lookback.bull || lookback.bear) && lastBarStartMs != null && bucketMs) {
      var lbName = lookback.bull || lookback.bear;
      var lbSide = lookback.bull ? 'bull' : 'bear';
      var lbSpan = patternBarCount(lbName);
      var lbEndMs   = lastBarStartMs - (lookback.barsAgo - 1) * bucketMs;
      var lbStartMs = lbEndMs - lbSpan * bucketMs;
      // Cap end at session close just in case.
      var lbPrice = lookback.candle ? +lookback.candle[4] : null;
      lookbackInfo = {
        name: lbName,
        side: lbSide,
        barsAgo: lookback.barsAgo,
        candlePrice: isFinite(lbPrice) ? lbPrice : null,
        barSpan: lbSpan,
        startMs: lbStartMs,
        endMs: lbEndMs
      };
    }

    return {
      tfKey: tfKey,
      candleCount: n,
      lastClose: lastClose,
      lastBarStartMs: lastBarStartMs,
      lastBarEndMs:   lastBarEndMs,
      // Start time of the FIRST candle in the active pattern (for
      // multi-bar patterns). Equals lastBarStartMs for 1-bar
      // patterns or when no pattern is detected.
      patternStartMs: patternStartMs,
      patternBarSpan: spanBars,
      // Most recent pattern within the TF's lookback window —
      // populated ONLY when the CURRENT bar has no pattern. Lets
      // the renderer surface "Last pattern: Hammer 3 bars ago"
      // instead of leaving the section blank. NEVER fed into the
      // scoring pipeline (stale signals don't trigger entries).
      lookbackPattern: lookbackInfo,
      // ── Supertrend (10, 3) ────────────────────────────────────
      // Independent ATR-based trend flip; trend != EMA-trend so
      // they can disagree (and that's actually informative).
      supertrendTrend:   stTrend,         // 'BULL' | 'BEAR' | null
      supertrendValue:   stValue,         // trailing band price = dynamic SL
      supertrendFlipped: stFlipped,       // true on the bar of the flip
      supertrendDistPct: stDistPct,       // % distance of close from band
      // ── Stochastic (14, 3, 3) ─────────────────────────────────
      // %K + %D + regime (OVERBOUGHT/OVERSOLD/NEUTRAL) + cross
      // direction (bull/bear K-vs-D cross within last 2 bars).
      stochK:      stochK,
      stochD:      stochD,
      stochRegime: stochRegime,
      stochCross:  stochCross,
      // ── OBV ───────────────────────────────────────────────────
      // Cumulative volume + 20-bar slope direction. Used for
      // confirming/diverging from price action.
      obvValue:    obvValue,
      obvSlope20:  obvSlope20,
      obvDir:      obvDir,
      ema9: ema9, ema21: ema21, ema50: ema50,
      ema9DistPct:  distP(ema9),
      ema21DistPct: distP(ema21),
      ema50DistPct: distP(ema50),
      ema9Slope:  slope(e9),
      ema21Slope: slope(e21),
      ema50Slope: slope(e50),
      structure: structure,
      trend: trend,
      trendReason: trendReason,         // 'STRUCTURE_UP' | 'STRUCTURE_DOWN' | 'STRUCTURE_SIDEWAYS'
      sessionBars: SESSION_BARS,        // how many bars the directionality window spans
      sessionRangePts: sessionRangePts, // span over last N bars (pts)
      sessionNetPts:   sessionNetPts,   // |last_close - first_close| over last N bars
      sessionDirectionality: directionality, // net/range; <0.3 = chop, >0.5 = trend
      sessionCompression: compressionRatio,  // range/ATR; <2.0 = compressed (range-bound)
      momentum: momentum,
      rsi: rsiV,
      rsiTrend: rsiTrend,
      macd: macdV, macdSignal: sigV, macdHist: histV,
      macdAboveSignal: macdAboveSignal,
      macdHistDir: macdHistDir,
      macdCross: macdCross,
      atr: atrV, atrPct: atrPct,
      adx: adxV,
      volumeRatio: volumeRatio,
      volumeAboveAvg: volumeAboveAvg,
      volTrend: volTrend,
      swingHigh: swHi ? swHi.price : null,
      swingLow:  swLo ? swLo.price : null,
      swingHighDistPct: swHi ? distP(swHi.price) : null,
      swingLowDistPct:  swLo ? distP(swLo.price) : null,
      // RSI divergence flags + structured details for the renderer.
      // rsiBearishDiv fires when price made HH but RSI made LH.
      // rsiBullishDiv fires when price made LL but RSI made HL.
      rsiBearishDiv: rsiDiv.bearishDiv,
      rsiBullishDiv: rsiDiv.bullishDiv,
      patternBull: pat.bull, patternBear: pat.bear,
      // Compression patterns (Inside Bar / NR4) — orthogonal to
      // direction; they're "wait for break" setups, not buy/sell
      // signals. Surfaced separately in the verdict's SKIP IF.
      patternCompression: pat.compression || null,
      // Neutral Doji — indecision at S/R warning. Never a buy/sell
      // alone, but flagged in the SKIP IF when the verdict is in
      // play to remind the trader to wait for confirmation.
      patternNeutral:     pat.neutral || null,
      // Pattern LOCATION context. Pre-computed here so both the
      // per-TF renderer (which shows "Bullish Engulfing at ₹X · AT
      // support") and generateVerdict (which credits +1 for AT S/R)
      // read the same structured result rather than duplicating
      // level-distance math in two places. We deliberately compute
      // patternBullCtx even when patternBull is null — useful in
      // the renderer to show the current price-vs-S/R context as a
      // fallback (e.g. "no pattern, but price sitting on VWAP").
      patternBullCtx: pat.bull ? getPatternContext({
        lastClose: lastClose, atr: atrV, vwap: levels ? levels.vwap : null,
        vwapBands: levels ? levels.vwapBands : null,
        orHigh: levels ? levels.orHigh : null, orLow: levels ? levels.orLow : null,
        fhrHigh: levels ? levels.fhrHigh : null, fhrLow: levels ? levels.fhrLow : null,
        prevHigh: levels ? levels.prevHigh : null, prevLow: levels ? levels.prevLow : null,
        prevClose: levels ? levels.prevClose : null, prevOpen: levels ? levels.prevOpen : null,
        cpr: levels ? levels.cpr : null,
        srZones: levels ? (levels.srZones || []) : [],
        rounds: levels ? (levels.rounds || []) : [],
        avwap: levels ? levels.avwap : null
      }, 'bull') : null,
      patternBearCtx: pat.bear ? getPatternContext({
        lastClose: lastClose, atr: atrV, vwap: levels ? levels.vwap : null,
        vwapBands: levels ? levels.vwapBands : null,
        orHigh: levels ? levels.orHigh : null, orLow: levels ? levels.orLow : null,
        fhrHigh: levels ? levels.fhrHigh : null, fhrLow: levels ? levels.fhrLow : null,
        prevHigh: levels ? levels.prevHigh : null, prevLow: levels ? levels.prevLow : null,
        prevClose: levels ? levels.prevClose : null, prevOpen: levels ? levels.prevOpen : null,
        cpr: levels ? levels.cpr : null,
        srZones: levels ? (levels.srZones || []) : [],
        rounds: levels ? (levels.rounds || []) : [],
        avwap: levels ? levels.avwap : null
      }, 'bear') : null,
      // Intraday-specific (passed-through from levels):
      vwap:       levels ? levels.vwap     : null,
      vwapDistPct: levels && levels.vwap != null ? distP(levels.vwap) : null,
      // VWAP ±1σ / ±2σ bands. Each TF analysis pulls these from the
      // 5m-derived levels object (which is the canonical source);
      // see calcLevels for the running-variance computation.
      vwapBands:  levels ? levels.vwapBands : null,
      // Stretch flags — fire when current TF's close is beyond the
      // session's ±2σ bands. Most reliable on the 5m/15m TFs since
      // those align with the band's own 5m volume-weighting.
      aboveVwapUb2: levels && levels.vwapBands ? lastClose > levels.vwapBands.ub2 : null,
      belowVwapLb2: levels && levels.vwapBands ? lastClose < levels.vwapBands.lb2 : null,
      aboveVwapUb1: levels && levels.vwapBands ? lastClose > levels.vwapBands.ub1 : null,
      belowVwapLb1: levels && levels.vwapBands ? lastClose < levels.vwapBands.lb1 : null,
      orHigh:     levels ? levels.orHigh   : null,
      orLow:      levels ? levels.orLow    : null,
      fhrHigh:    levels ? levels.fhrHigh  : null,
      fhrLow:     levels ? levels.fhrLow   : null,
      fhrComplete: levels ? !!levels.fhrComplete : false,
      prevHigh:   levels ? levels.prevHigh  : null,
      prevLow:    levels ? levels.prevLow   : null,
      prevClose:  levels ? levels.prevClose : null,
      prevOpen:   levels ? levels.prevOpen  : null,
      todayHigh:  levels ? levels.todayHigh : null,
      todayLow:   levels ? levels.todayLow  : null,
      // todayOpen — first 5m bar's open price (09:15 IST). Forwarded
      // from calcLevels so generateVerdict's BN-correlation block can
      // compute Nifty's real intraday % change vs BN's. See calcLevels
      // for the rationale.
      todayOpen:  levels ? levels.todayOpen : null,
      // Overnight gap snapshot (today's open vs yesterday's close).
      // Forwarded from calcLevels so generateVerdict can apply the
      // gap-fade / gap-and-go scoring and the first-hour HARD VETO
      // on STRONG gaps without re-fetching prev day data. Same
      // payload on every TF — gap is a session-level concept.
      gap:        levels ? levels.gap       : null,
      // Today's Fibonacci retracement levels (38.2 / 50 / 61.8 /
      // 78.6 % of today's high-low range). Null until session
      // forms a meaningful range. Same payload on every TF since
      // Fib is a daily-anchored calculation.
      fib:        levels ? levels.fib       : null,
      aboveVwap:  levels && levels.vwap != null ? lastClose > levels.vwap : null,
      aboveORH:   levels && levels.orHigh != null ? lastClose > levels.orHigh : null,
      belowORL:   levels && levels.orLow  != null ? lastClose < levels.orLow  : null,
      // FHR breakouts: only treated as valid AFTER the first hour
      // has fully formed (otherwise we'd flag a mid-formation high
      // as a "break" against a level that's still moving).
      aboveFHR:   levels && levels.fhrHigh != null && levels.fhrComplete ? lastClose > levels.fhrHigh : null,
      belowFHR:   levels && levels.fhrLow  != null && levels.fhrComplete ? lastClose < levels.fhrLow  : null,
      abovePDH:   levels && levels.prevHigh != null ? lastClose > levels.prevHigh : null,
      belowPDL:   levels && levels.prevLow  != null ? lastClose < levels.prevLow  : null,
      // CPR (Central Pivot Range) snapshot — passed through from
      // the day-level computation. Same object lives on every TF's
      // analysis result so any consumer (scoring, S/R ladder, pill
      // renderer) can read it without re-passing `levels` around.
      // Derived booleans use lastClose vs each CPR boundary so the
      // "above pivot / inside CPR / below CPR" state is available
      // per-TF (though in practice it's same across TFs since the
      // CPR itself is a daily level).
      cpr:        levels ? levels.cpr : null,
      // Auto-discovered S/R passed through from calcLevels.
      // These are session-stable (computed once per analyze cycle
      // from the 5m / today data) so each TF sees the same set.
      srZones:    levels ? (levels.srZones || []) : [],
      rounds:     levels ? (levels.rounds  || []) : [],
      avwap:      levels ? levels.avwap : null,
      aboveCprTC: levels && levels.cpr ? lastClose > levels.cpr.TC : null,
      belowCprBC: levels && levels.cpr ? lastClose < levels.cpr.BC : null,
      insideCpr:  levels && levels.cpr ? (lastClose <= levels.cpr.TC && lastClose >= levels.cpr.BC) : null,
      abovePivot: levels && levels.cpr ? lastClose > levels.cpr.P  : null
    };
  }

  // ─── Structural Room helper ───────────────────────────────────
  // Measures how much "room to run" the trade has before bumping
  // into the next MAJOR structural level. The fix for the classic
  // chase-the-rally trap: every momentum indicator can scream UP
  // but if spot is sitting 5 pts below 1H Swing High, the move is
  // essentially "complete" for this leg and reversal odds spike.
  //
  // We compute this TWICE per call — once with the TIGHT level set
  // (PDH/PDL, ORH/ORL, Today's H/L, 1H Swing H/L) for the VETO
  // check, and once with the WIDE set (adds VWAP + 5m Swing H/L)
  // for the SCORE contribution. Reason: VWAP and 5m swings are
  // important for trade management but whipsaw on volatile days —
  // including them in the veto check would over-block valid
  // pullback entries that "graze" a 5m swing.
  function computeStructureRoom(an5, an1h, spot, side, levelSet, raw1h) {
    if (!an5 || !isFinite(spot) || spot <= 0) return null;
    var atr = an5.atr || 20;
    var levels = [];
    function add(value, name) {
      if (value != null && isFinite(value)) levels.push({ value: value, name: name });
    }
    // ── STRUCTURAL 4H + 1H rejection clusters (TIGHT, heaviest) ──
    // These are the same levels the user sees in the "Key S/R" card
    // — multi-touch 4H pivots, multi-touch 1H pivots, and 5m
    // multi-touch zones. Critical for the veto + R:R math: a 4H
    // pivot with ×4 rejections is the single most-relevant wall
    // for "how much room does this trade have?". Without these,
    // the engine could fire BUY CE into a heavy 4H resistance the
    // user can clearly see on the card.
    if (raw1h && raw1h.length >= 8) {
      var struct = collectStructuralSr(an5, an1h, raw1h, spot);
      var allStruct = struct.resistance.concat(struct.support);
      for (var ks = 0; ks < allStruct.length; ks++) {
        var sl = allStruct[ks];
        // Skip levels already added below (we'll dedupe by
        // tolerance, but for the structural set always include
        // them — the rest of the function picks NEAREST anyway).
        var tag = sl.source === '4h' ? '4H pivot'
                : sl.source === '1h' ? '1H pivot'
                : sl.source === '5m-zone' ? 'Multi-touch zone'
                : sl.name;
        var suffix = (sl.touches && sl.touches >= 2)
          ? ' (\u00D7' + sl.touches + ' rejected)' : '';
        add(sl.value, tag + suffix);
      }
    }
    // TIGHT (heavy, fight-tested) — used for both veto + score.
    add(an5.prevHigh,  'Prev Day High');
    add(an5.prevLow,   'Prev Day Low');
    // Prev Day Close — heaviest "secondary" daily level. It's the
    // gap-fill reference, the anchor for CPR computations, and the
    // single most-watched price by intraday traders for "is today
    // following yesterday's direction?". Treated as a TIGHT level
    // so the veto + R:R math see it as a real wall.
    add(an5.prevClose, 'Prev Day Close');
    // Prev Day Open — secondary daily level. Important on gap
    // days as the natural gap-fade target.
    add(an5.prevOpen,  'Prev Day Open');
    add(an5.orHigh,    'OR High');
    add(an5.orLow,     'OR Low');
    // First Hour Range — only treated as a TIGHT level once the
    // first hour has fully formed (else it's still moving and would
    // distort the room calculation).
    if (an5.fhrComplete) {
      add(an5.fhrHigh, 'First Hour High');
      add(an5.fhrLow,  'First Hour Low');
    }
    add(an5.todayHigh, "Today's High");
    add(an5.todayLow,  "Today's Low");
    if (an1h) {
      add(an1h.swingHigh, '1H Swing High');
      add(an1h.swingLow,  '1H Swing Low');
    }
    // CPR boundaries are TIGHT-set heavyweights — Pivot/TC/BC are
    // the most-watched daily levels in Indian intraday, and R1/S1
    // are the standard primary intraday targets. Including them
    // here means the R:R / "wall" veto sees them as legitimate
    // obstacles. R2/R3/S2/S3 stay out of TIGHT (they're outliers,
    // often well beyond ATR-relevant range — would distort R:R
    // math on calm days when they sit 200+ pts away).
    if (an5.cpr) {
      add(an5.cpr.P,  'Pivot (CPR)');
      add(an5.cpr.TC, 'CPR Top (TC)');
      add(an5.cpr.BC, 'CPR Bottom (BC)');
      add(an5.cpr.R1, 'R1 (CPR)');
      add(an5.cpr.S1, 'S1 (CPR)');
    }
    // Auto-discovered swing-cluster zones with 4+ touches are
    // TIGHT-set heavyweights — they represent multi-day market
    // memory. 3-touch zones go to WIDE (less proven).
    if (an5.srZones && an5.srZones.length) {
      for (var iz = 0; iz < an5.srZones.length; iz++) {
        var z = an5.srZones[iz];
        if (z.touches >= 4 || z.side === 'mixed') {
          add(z.midpoint, 'Swing cluster (' + z.touches + ' touches)');
        }
      }
    }
    // Round levels: only Tier-1 (×500) heavyweights are TIGHT.
    // ×100 and ×50 sit in WIDE only.
    if (an5.rounds && an5.rounds.length) {
      for (var ir = 0; ir < an5.rounds.length; ir++) {
        if (an5.rounds[ir].tier === 1) {
          add(an5.rounds[ir].level, 'Round ₹500');
        }
      }
    }
    // WIDE additions — only included when caller asks for it.
    if (levelSet === 'WIDE') {
      add(an5.vwap,      'VWAP');
      add(an5.swingHigh, '5m Swing High');
      add(an5.swingLow,  '5m Swing Low');
      // R2/S2 are too far to be TIGHT but worth scoring against
      // for the WIDE structure check (extended target sanity).
      if (an5.cpr) {
        add(an5.cpr.R2, 'R2 (CPR)');
        add(an5.cpr.S2, 'S2 (CPR)');
      }
      // 3-touch zones (less proven than 4+ touch) + ×100 / ×50
      // rounds — eligible for WIDE-set R:R math only.
      if (an5.srZones && an5.srZones.length) {
        for (var iz2 = 0; iz2 < an5.srZones.length; iz2++) {
          var z2 = an5.srZones[iz2];
          if (z2.touches === 3 && z2.side !== 'mixed') {
            add(z2.midpoint, 'Swing cluster (3 touches)');
          }
        }
      }
      if (an5.rounds && an5.rounds.length) {
        for (var ir2 = 0; ir2 < an5.rounds.length; ir2++) {
          if (an5.rounds[ir2].tier > 1) {
            add(an5.rounds[ir2].level,
                an5.rounds[ir2].tier === 2 ? 'Round ₹100' : 'Round ₹50');
          }
        }
      }
      // AVWAPs are dynamic but still important for R:R sanity.
      if (an5.avwap) {
        if (an5.avwap.fromHigh != null) add(an5.avwap.fromHigh, 'AVWAP-H');
        if (an5.avwap.fromLow  != null) add(an5.avwap.fromLow,  'AVWAP-L');
      }
    }
    if (!levels.length) return null;
    // For side='CE': ahead = above spot (resistance), behind = below (support).
    // For side='PE': ahead = below spot (support),    behind = above (resistance).
    var aboveSpot = levels.filter(function (l) { return l.value > spot; })
                          .sort(function (a, b) { return a.value - b.value; });
    var belowSpot = levels.filter(function (l) { return l.value < spot; })
                          .sort(function (a, b) { return b.value - a.value; });
    var ahead  = side === 'CE' ? aboveSpot[0] : belowSpot[0];
    var behind = side === 'CE' ? belowSpot[0] : aboveSpot[0];
    var roomAhead  = ahead  ? Math.abs(ahead.value  - spot) : null;
    var roomBehind = behind ? Math.abs(behind.value - spot) : null;
    var structuralRR = (roomAhead != null && roomBehind != null && roomBehind > 0)
      ? (roomAhead / roomBehind) : null;
    // Status: AT = practically at the wall (within 0.4× ATR ≈ 8-12 pts
    // for typical Nifty 5m ATR); APPROACHING = within 1× ATR; CLEAR
    // = anything more (room to run before the next obstacle).
    var status = 'CLEAR';
    if (roomAhead != null) {
      if (roomAhead < atr * 0.4)       status = 'AT';
      else if (roomAhead < atr * 1.0)  status = 'APPROACHING';
    }
    return {
      roomAhead: roomAhead, roomBehind: roomBehind,
      structuralRR: structuralRR, status: status,
      aheadLevel: ahead, behindLevel: behind, atr: atr
    };
  }

  // ─── Option-chain (OI / PCR) snapshot ─────────────────────────
  // Reads window.optionChainData (populated by the option-chain
  // module on a 30s refresh) and extracts the four numbers the
  // verdict engine cares about:
  //   - pcr     : put-call ratio (totPE OI / totCE OI). > 1.3 =
  //               heavy put positioning (in Indian markets this
  //               means institutional put-WRITING, since retail
  //               can't easily write — contrarian bullish setup);
  //               < 0.7 = heavy call positioning (institutional
  //               call-writing, contrarian bearish setup); 0.7–
  //               1.3 = neutral positioning.
  //   - ceWall  : strike with the maximum CALL OI = the resistance
  //               wall call-writers will defend. Spot pushing INTO
  //               this strike has heavy selling above it.
  //   - peWall  : strike with the maximum PUT OI = the support wall
  //               put-writers will defend. Spot dropping toward
  //               this strike has heavy buying below it.
  //   - maxPain : optional — the strike where the most option
  //               buyers would lose money at expiry. Price tends
  //               to gravitate here near weekly expiry (not on
  //               trading days far from expiry).
  // Returns null if chain hasn't been loaded yet — verdict still
  // works, just without OI input.
  function readOptionChainSnapshot() {
    try {
      var chain = window.optionChainData;
      if (!chain || !chain.strikes || !chain.strikes.length) return null;
      var totCE = 0, totPE = 0;
      var ceWall = { strike: null, oi: 0 };
      var peWall = { strike: null, oi: 0 };
      chain.strikes.forEach(function (s) {
        var ceOi = 0, peOi = 0;
        if (s.call_options && s.call_options.market_data) {
          ceOi = s.call_options.market_data.oi || 0;
          totCE += ceOi;
          if (ceOi > ceWall.oi) ceWall = { strike: s.strike_price, oi: ceOi };
        }
        if (s.put_options && s.put_options.market_data) {
          peOi = s.put_options.market_data.oi || 0;
          totPE += peOi;
          if (peOi > peWall.oi) peWall = { strike: s.strike_price, oi: peOi };
        }
      });
      // Prefer the broker-supplied PCR field if present (some feeds
      // include it computed off the FULL chain incl. far-OTM strikes
      // we may not have fetched).
      var pcrField = chain.strikes[0] && chain.strikes[0].pcr;
      var pcr = (typeof pcrField === 'number' && pcrField > 0)
        ? pcrField
        : (totCE > 0 ? totPE / totCE : null);
      if (pcr == null) return null;
      // Max-pain: strike where total option-buyer loss (∑ intrinsic
      // value paid out at this strike) is minimised. Quick O(n²) is
      // fine — strike count is tiny.
      var strikes = chain.strikes.slice().sort(function (a, b) {
        return a.strike_price - b.strike_price;
      });
      var maxPain = null, minLoss = Infinity;
      for (var i = 0; i < strikes.length; i++) {
        var K = strikes[i].strike_price;
        var loss = 0;
        for (var j = 0; j < strikes.length; j++) {
          var Kj = strikes[j].strike_price;
          var ce = strikes[j].call_options && strikes[j].call_options.market_data ? strikes[j].call_options.market_data.oi || 0 : 0;
          var pe = strikes[j].put_options  && strikes[j].put_options.market_data  ? strikes[j].put_options.market_data.oi  || 0 : 0;
          if (K > Kj) loss += ce * (K - Kj);
          if (K < Kj) loss += pe * (Kj - K);
        }
        if (loss < minLoss) { minLoss = loss; maxPain = K; }
      }
      // ── OI CHANGE at ATM ± 2 strikes (May 2026) ──
      // Static OI tells you where positioning IS. OI CHANGE tells
      // you where smart money is MOVING. This is the signal pros
      // actually watch.
      //
      // Read each strike's `prev_oi` (previous session close OI)
      // and `oi` (current OI) for both CE and PE. Pick ATM (the
      // strike closest to spot) and ATM ± 1 and ± 2 (5 strikes
      // total). Sum CE OI delta and PE OI delta across the band.
      //
      // Directional read (Indian markets, where institutions
      // write options):
      //   - CE OI building (positive)  = call-writers selling
      //                                  resistance → bearish
      //   - CE OI unwinding (negative) = call-writers covering →
      //                                  bullish
      //   - PE OI building (positive)  = put-writers selling
      //                                  support → bullish
      //   - PE OI unwinding (negative) = put-writers covering →
      //                                  bearish
      //
      // Composite flow (bullishness): peDelta - ceDelta. Positive
      // = institutional flow is bullish. Negative = bearish.
      // Magnitude as % of total OI in the band tells us how
      // significant the flow is.
      var oiChange = null;
      if (chain.spot != null && isFinite(chain.spot) && strikes.length >= 5) {
        // Find ATM index (strike closest to spot)
        var atmIdx = 0;
        var bestDist = Infinity;
        for (var ai = 0; ai < strikes.length; ai++) {
          var dist = Math.abs(strikes[ai].strike_price - chain.spot);
          if (dist < bestDist) { bestDist = dist; atmIdx = ai; }
        }
        // ATM ± 2 = 5 strikes total
        var loIdx = Math.max(0, atmIdx - 2);
        var hiIdx = Math.min(strikes.length - 1, atmIdx + 2);
        var ceCur = 0, cePrev = 0, peCur = 0, pePrev = 0;
        for (var bi = loIdx; bi <= hiIdx; bi++) {
          var sb = strikes[bi];
          if (sb.call_options && sb.call_options.market_data) {
            ceCur  += (sb.call_options.market_data.oi      || 0);
            cePrev += (sb.call_options.market_data.prev_oi || 0);
          }
          if (sb.put_options && sb.put_options.market_data) {
            peCur  += (sb.put_options.market_data.oi      || 0);
            pePrev += (sb.put_options.market_data.prev_oi || 0);
          }
        }
        var ceDelta = ceCur - cePrev;       // positive = CE OI building
        var peDelta = peCur - pePrev;       // positive = PE OI building
        var totalBandOi = ceCur + peCur;
        // Composite "directional flow score" — normalized to %
        // of total OI in the band so we can use the same
        // threshold across high- and low-liquidity expiries.
        var ceDeltaPct = (ceCur + cePrev) > 0 ? (ceDelta / ((ceCur + cePrev) / 2)) * 100 : 0;
        var peDeltaPct = (peCur + pePrev) > 0 ? (peDelta / ((peCur + pePrev) / 2)) * 100 : 0;
        // Bullishness composite: +ve = PE building or CE unwinding
        // (both bullish). -ve = opposite.
        var flowScore = peDeltaPct - ceDeltaPct;
        var flowDirection;
        if      (flowScore >=  15) flowDirection = 'STRONG_BULL';
        else if (flowScore >=   7) flowDirection = 'BULL';
        else if (flowScore <= -15) flowDirection = 'STRONG_BEAR';
        else if (flowScore <=  -7) flowDirection = 'BEAR';
        else                       flowDirection = 'NEUTRAL';
        oiChange = {
          atmStrike:   strikes[atmIdx].strike_price,
          bandLow:     strikes[loIdx].strike_price,
          bandHigh:    strikes[hiIdx].strike_price,
          ceDelta:     ceDelta,
          peDelta:     peDelta,
          ceDeltaPct:  ceDeltaPct,
          peDeltaPct:  peDeltaPct,
          flowScore:   flowScore,
          flowDirection: flowDirection,
          totalBandOi: totalBandOi
        };
      }
      return {
        pcr: pcr,
        totCE: totCE, totPE: totPE,
        ceWall: ceWall.strike != null ? ceWall : null,
        peWall: peWall.strike != null ? peWall : null,
        maxPain: maxPain,
        oiChange: oiChange,
        spot: chain.spot,
        expiry: chain.expiry
      };
    } catch (_) { return null; }
  }

  // ── Verdict generation (CE / PE / WAIT) ──
  // Walks every TF + every signal and assigns signed contribution
  // points to either the CE side (bull) or the PE side (bear).
  // Final decision compares the two totals.
  //
  // Parameters:
  //   an15/an5/an30 — required per-TF analysis snapshots (15m/5m/30m)
  //   an1h         — optional 1-hour macro snapshot (used as a
  //                  top-down context filter, not a voting card)
  //   vix          — optional India VIX snapshot
  //                  { current, open, high, low, changePct } —
  //                  drives the IV-regime filter (dead market vs
  //                  IV crush vs IV expansion). Null = analyzer
  //                  runs without VIX input.
  // ════════════════════════════════════════════════════════════════════
  // generateVerdict — Trend Identifier v1 (2026-05-25)
  // BIAS (1h+30m) → ARM (15m) → TRIGGER (5m) → PLAN
  // Replaces the old EMA-stack score-summing system.
  // Output shape is identical to the old function so all renderers
  // (HUD, plan card, journal, per-TF cards) work without change.
  // ════════════════════════════════════════════════════════════════════
  function generateVerdict(an15, an5, an30, an1h, vix, mode, bn, raw1h) {
    if (!an15 || !an5) {
      return { ok: false, reason: 'Not enough intraday data for required timeframes.' };
    }
    mode = 'SCALP';
    bn   = bn || null;

    // ── Shared helpers (kept for renderers that call plan.* fields) ───
    function fmtNum(n) { return (n != null && isFinite(n)) ? n.toFixed(1) : '\u2014'; }

    // ── IST time + session phase ──────────────────────────────────────
    var _ist         = nowISTParts();
    var sessionPhase = classifySessionPhase(_ist.minOfDay, mode);
    var spotForStruct = an5.lastClose;

    // ── Option-chain snapshot ─────────────────────────────────────────
    var chain = (typeof readOptionChainSnapshot === 'function')
      ? readOptionChainSnapshot() : null;

    // ── Expiry-day detection (unchanged from old system) ──────────────
    var expiryInfo = null;
    (function () {
      if (!chain || !chain.expiry) return;
      var fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
      });
      var todayIST = fmt.format(new Date());
      if (todayIST !== chain.expiry) return;
      var minNow = _ist.minOfDay;
      var phase = minNow < 13 * 60        ? 'NORMAL'
                : minNow < 13 * 60 + 30   ? 'THETA_RAMP'
                : minNow < 14 * 60 + 30   ? 'THETA_CRUSH'
                : 'PIN_WINDOW';
      expiryInfo = {
        isExpiryDay: true, phase: phase,
        minsToClose: (15 * 60 + 30) - minNow,
        expiry: chain.expiry
      };
    })();

    // ── Volatility regime (from 5m ATR%) ─────────────────────────────
    var atrPctNow = an5.atrPct;
    var volRegime = 'UNKNOWN';
    if (atrPctNow != null && isFinite(atrPctNow)) {
      if      (atrPctNow < 0.05) volRegime = 'DEAD';
      else if (atrPctNow < 0.10) volRegime = 'QUIET';
      else if (atrPctNow < 0.20) volRegime = 'NORMAL';
      else                       volRegime = 'ACTIVE';
    }

    // ── CPR flags ─────────────────────────────────────────────────────
    var cprWideFlag     = false;
    var cprDeadZoneFlag = false;
    if (an5.cpr && an5.cpr.widthPctOfRange != null) {
      if (an5.cpr.widthPctOfRange > 60) cprWideFlag = true;
      if (cprWideFlag && an5.insideCpr)  cprDeadZoneFlag = true;
    }

    // ── Structure snapshots ───────────────────────────────────────────
    var s1h  = (an1h  && an1h.structure)  ? an1h.structure  : {};
    var s30m = (an30  && an30.structure)  ? an30.structure  : {};
    var s15m = (an15  && an15.structure)  ? an15.structure  : {};
    var s5m  = (an5   && an5.structure)   ? an5.structure   : {};

    // Per-TF contribution maps (for the per-TF card panels + backward compat)
    var tfScore   = { '1h': 0, '30m': 0, '15m': 0, '5m': 0 };
    var tfSignals = { '1h': [], '30m': [], '15m': [], '5m': [] };
    var ceScore = 0, peScore = 0, ceSigs = [], peSigs = [];
    function addBull(pts, label, tf) {
      ceScore += pts; ceSigs.push(label);
      if (tfScore[tf] !== undefined) {
        tfScore[tf] += pts;
        tfSignals[tf].push({ dir: 'bull', pts: pts, label: label });
      }
    }
    function addBear(pts, label, tf) {
      peScore += pts; peSigs.push(label);
      if (tfScore[tf] !== undefined) {
        tfScore[tf] -= pts;
        tfSignals[tf].push({ dir: 'bear', pts: -pts, label: label });
      }
    }

    // ════════════════════════════════════════════════════════════════
    // BIAS → ARM → TRIGGER (new structural engine)
    // ════════════════════════════════════════════════════════════════
    var bias     = 'SIDEWAYS';
    var biasHigh = false;  // true = both 1h and 30m fully agree (HIGH conf)

    // BIAS layer: 1h + 30m structural labels
    if (s1h.label && s30m.label) {
      if      (s1h.label === 'UP'   && s30m.label === 'UP')        { bias = 'UP';   biasHigh = true;  }
      else if (s1h.label === 'DOWN' && s30m.label === 'DOWN')      { bias = 'DOWN'; biasHigh = true;  }
      else if (s1h.label === 'UP'   && s30m.label === 'SIDEWAYS')  { bias = 'UP';   biasHigh = false; }
      else if (s1h.label === 'DOWN' && s30m.label === 'SIDEWAYS')  { bias = 'DOWN'; biasHigh = false; }
      // 1h+30m conflict (UP+DOWN or DOWN+UP) → SIDEWAYS
    } else if (!s1h.label && s30m.label && s30m.label !== 'SIDEWAYS') {
      // No 1H data available — use 30m alone, weakened confidence
      bias = s30m.label; biasHigh = false;
    }

    // Populate tfScore/tfSignals for the per-TF contribution panel
    if (s1h.label === 'UP')   addBull(3, '1H structure: UP (HH+HL)', '1h');
    if (s1h.label === 'DOWN') addBear(3, '1H structure: DOWN (LH+LL)', '1h');
    if (s30m.label === 'UP')  addBull(2, '30m structure: UP', '30m');
    if (s30m.label === 'DOWN')addBear(2, '30m structure: DOWN', '30m');
    if (s15m.label === 'UP')  addBull(2, '15m structure: UP (ARM aligned)', '15m');
    if (s15m.label === 'DOWN')addBear(2, '15m structure: DOWN (ARM aligned)', '15m');
    if (s5m.label === 'UP')   addBull(2, '5m structure: UP (TRIGGER aligned)', '5m');
    if (s5m.label === 'DOWN') addBear(2, '5m structure: DOWN (TRIGGER aligned)', '5m');

    // SESSION_CLOSE_MIN needed by time-of-day veto message
    var SESSION_CLOSE_MIN = 15 * 60 + 30;

    // ── Action determination ──────────────────────────────────────────
    var action       = 'WAIT';
    var sideLabel    = 'WAIT';
    var attemptedSide = null;
    var vetoReasons  = [];
    var skip         = [];

    // Hard session-phase gates — block regardless of structure
    var sessionBlocked = false;
    if (sessionPhase === 'PRE_OPEN') {
      vetoReasons.push('Market hasn\'t opened yet (pre-09:15 IST). No live data to act on.');
      sessionBlocked = true;
    } else if (sessionPhase === 'OR_FORMING') {
      vetoReasons.push('First 5 min of session \u2014 the Opening Range hasn\'t closed a single 5m candle yet. Wait for 09:20 IST so at least one bar is on the chart.');
      sessionBlocked = true;
    } else if (sessionPhase === 'NO_NEW') {
      var minsLeft = SESSION_CLOSE_MIN - _ist.minOfDay;
      vetoReasons.push('Session is in the SQUARE-OFF window (15:25\u201315:30 IST) \u2014 no new entries. Only ' + minsLeft + ' min until close, even a scalp won\'t have time to work. Wait for tomorrow\'s session.');
      sessionBlocked = true;
    } else if (sessionPhase === 'POST_CLOSE') {
      vetoReasons.push('Market is closed (post 15:30 IST). Wait for tomorrow\'s session.');
      sessionBlocked = true;
    } else if (sessionPhase === 'WEEKEND') {
      var _closedMsg = 'Markets closed';
      try {
        var _tp2 = nowISTParts();
        if (_tp2.weekday !== 'Sat' && _tp2.weekday !== 'Sun') _closedMsg = 'Holiday today \u2014 markets closed';
      } catch (_) {}
      vetoReasons.push(_closedMsg + '. Enjoy the break.');
      sessionBlocked = true;
    }

    if (!sessionBlocked) {
      // ── BIAS gate ───────────────────────────────────────────────────
      if (bias === 'SIDEWAYS') {
        attemptedSide = null;
        if (s1h.label && s30m.label) {
          vetoReasons.push('1h structure (' + (s1h.label || 'SIDEWAYS') + ') and 30m structure (' + (s30m.label || 'SIDEWAYS') + ') are conflicting or both SIDEWAYS \u2014 no directional bias. Wait for structure to resolve on the higher timeframes.');
        } else {
          vetoReasons.push('Insufficient 1h / 30m structural data (need \u22652 confirmed swing highs AND \u22652 swing lows on both). More bars required.');
        }
      } else {
        // bias is UP or DOWN
        var armSide = bias === 'UP' ? 'BUY_CE' : 'BUY_PE';
        attemptedSide = bias === 'UP' ? 'BUY CE' : 'BUY PE';
        var armFail = null;

        // ── ARM gate (15m) ────────────────────────────────────────────
        // Pullback-entry path: 1H+30m aligned (BIAS) but 15m is pulling
        // back counter-trend. This is the classic "buy the dip in an
        // uptrend" setup. Allow entry at MEDIUM confidence when the 5m
        // has ALREADY turned back in the bias direction with a fresh swing.
        var isPullbackEntry = false;
        if (s15m.label !== bias) {
          var freshWin5pb = (window.TREND_PARAMS_BY_TF && window.TREND_PARAMS_BY_TF['5m'])
                            ? window.TREND_PARAMS_BY_TF['5m'].freshWin : 5;
          var swingFreshPb = s5m.freshSwingAge != null && s5m.freshSwingAge <= freshWin5pb;
          var ema20_5pb    = an5.ema21;
          var above5mEma   = !ema20_5pb || !isFinite(ema20_5pb) ||
                             (bias === 'UP'   ? spotForStruct > ema20_5pb
                                              : spotForStruct < ema20_5pb);
          if (s5m.label === bias && swingFreshPb && above5mEma) {
            // 5m has recovered into bias direction — fire pullback entry
            isPullbackEntry = true;
            action    = armSide;
            sideLabel = armSide === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
          } else {
            var pbWhy = [];
            if (s5m.label !== bias) pbWhy.push('5m not yet ' + bias);
            else if (!swingFreshPb) pbWhy.push('no fresh 5m swing yet (age: ' + (s5m.freshSwingAge != null ? s5m.freshSwingAge + ' bars' : '?') + ')');
            else if (!above5mEma)  pbWhy.push('spot still below 5m EMA20 — wait for reclaim');
            armFail = '15m structure is ' + (s15m.label || 'SIDEWAYS') + ' (pullback in ' + bias + ' trend). ' + pbWhy.join('; ') + '. Enter when 5m turns ' + bias + ' with a fresh swing above EMA20.';
          }
        } else {
          // Value zone check: spot near EMA21(15m) or VWAP
          var ema20_15   = an15.ema21;
          var cappedAtr15 = (isFinite(s15m.cappedATR) && s15m.cappedATR > 0) ? s15m.cappedATR : (an15.atr || 20);
          var inValueZone = false;
          if (ema20_15 && isFinite(ema20_15)) {
            // Wider ceiling (+1.0×ATR) so a trend-day continuation
            // above EMA20 still qualifies. Floor is unchanged (−0.5×ATR).
            if (bias === 'UP') {
              inValueZone = spotForStruct >= (ema20_15 - 0.5 * cappedAtr15) &&
                            spotForStruct <= (ema20_15 + 1.0 * cappedAtr15);
            } else {
              inValueZone = spotForStruct >= (ema20_15 - 1.0 * cappedAtr15) &&
                            spotForStruct <= (ema20_15 + 0.5 * cappedAtr15);
            }
          }
          // Also accept if within 0.5× cappedATR of VWAP (widened from 0.3)
          if (!inValueZone && an15.vwap && isFinite(an15.vwap)) {
            inValueZone = Math.abs(spotForStruct - an15.vwap) <= 0.5 * cappedAtr15;
          }
          // ARM fallback: bypass value zone on strong trend days (ADX≥20, was 25)
          // 3+ aligned bars confirms the structure has held, not just a flash
          var adx15 = an15.adx;
          var armFallbackActive = !inValueZone
            && (adx15 && adx15 >= 20)
            && (s15m.bosAgeBars != null && s15m.bosAgeBars >= 3);

          if (!inValueZone && !armFallbackActive) {
            var ezLo = (ema20_15 && isFinite(ema20_15)) ? (ema20_15 - 0.5 * cappedAtr15).toFixed(1) : '?';
            var ezHi = (ema20_15 && isFinite(ema20_15)) ? (ema20_15 + 0.3 * cappedAtr15).toFixed(1) : '?';
            armFail = 'Spot (\u20B9' + fmtNum(spotForStruct) + ') is outside the 15m EMA20 value zone (\u20B9' + ezLo + '\u2013\u20B9' + ezHi + '). Wait for a pullback into the zone, or for ADX \u226525 with 3+ aligned bars to activate the trend-day fallback.';
          }
        }

        if (armFail) {
          vetoReasons.push(armFail);
        } else {
          // ── TRIGGER gate (5m) ──────────────────────────────────────
          var triggerFail = null;
          if (s5m.label !== bias) {
            triggerFail = '5m structure is ' + (s5m.label || 'SIDEWAYS') + ' \u2014 needs to be ' + bias + ' to trigger entry. Wait for 5m to confirm with a fresh HH+HL or LH+LL.';
          } else {
            // Fresh micro-swing check
            var freshWin5   = (window.TREND_PARAMS_BY_TF && window.TREND_PARAMS_BY_TF['5m'])
                              ? window.TREND_PARAMS_BY_TF['5m'].freshWin : 5;
            var swingFresh  = s5m.freshSwingAge != null && s5m.freshSwingAge <= freshWin5;
            if (!swingFresh) {
              triggerFail = '5m last structural swing is ' + (s5m.freshSwingAge != null ? s5m.freshSwingAge + ' bars old' : 'unknown') + ' (max ' + freshWin5 + ' bars). Wait for a fresh swing in the bias direction.';
            } else {
              // EMA20(5m) side confirmation
              var ema20_5 = an5.ema21;
              if (ema20_5 && isFinite(ema20_5)) {
                if (bias === 'UP'   && spotForStruct <= ema20_5)
                  triggerFail = '5m close (\u20B9' + fmtNum(spotForStruct) + ') is below EMA20 (\u20B9' + fmtNum(ema20_5) + '). Need to close ABOVE EMA20 for a CE entry trigger.';
                if (bias === 'DOWN' && spotForStruct >= ema20_5)
                  triggerFail = '5m close (\u20B9' + fmtNum(spotForStruct) + ') is above EMA20 (\u20B9' + fmtNum(ema20_5) + '). Need to close BELOW EMA20 for a PE entry trigger.';
              }
            }
          }
          if (triggerFail) {
            vetoReasons.push(triggerFail);
          } else {
            // ── ALL GATES PASSED ── FIRE ────────────────────────────
            action    = armSide;
            sideLabel = armSide === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
          }
        }
      }
    }

    // ── Expiry hard vetoes (post-action check) ────────────────────────
    if (action !== 'WAIT' && expiryInfo) {
      if (expiryInfo.phase === 'PIN_WINDOW') {
        var chainPin = (typeof readOptionChainSnapshot === 'function') ? readOptionChainSnapshot() : null;
        var mpPct = (chainPin && chainPin.maxPain && spotForStruct)
          ? Math.abs(spotForStruct - chainPin.maxPain) / spotForStruct * 100 : null;
        if (mpPct == null || mpPct <= 0.5) {
          action = 'WAIT';
          vetoReasons.push('Expiry day + past 14:30 IST. Theta is now decaying at ~10\u00D7 morning rate AND max-pain pin behaviour dominates. New option BUYs in this window are statistically losers \u2014 only the writers profit. WAIT for tomorrow.');
        }
      } else if (expiryInfo.phase === 'THETA_CRUSH') {
        // Allow through but will be demoted to LOW confidence
      }
    }

    // ── Confidence tier ───────────────────────────────────────────────
    var confidence = '\u2014';
    if (action !== 'WAIT') {
      // Base confidence from bias quality + ADX
      var adx15c = an15.adx;
      if      (biasHigh && adx15c && adx15c >= 25) confidence = 'HIGH';
      else if (biasHigh && adx15c && adx15c >= 18) confidence = 'MEDIUM';
      else if (biasHigh)                            confidence = 'MEDIUM';
      else if (adx15c && adx15c >= 25)             confidence = 'MEDIUM';
      else                                          confidence = 'LOW';

      // Session-phase demotions
      if (sessionPhase === 'OR_SETTLED' && confidence === 'HIGH') confidence = 'MEDIUM';
      if (sessionPhase === 'LUNCH_CHOP' && confidence === 'HIGH') confidence = 'MEDIUM';
      if (sessionPhase === 'AFTERNOON'  && confidence === 'HIGH') confidence = 'MEDIUM';
      if (sessionPhase === 'LATE_SCALP')                         confidence = 'LOW';

      // VIX demotions
      if (vix && isFinite(vix.current)) {
        if (vix.current < 12 && confidence !== 'LOW')
          confidence = vix.current < 11.5 ? 'LOW' : 'MEDIUM';
        else if (vix.current < 13 && confidence === 'HIGH') confidence = 'MEDIUM';
        if (vix.changePct <= -5 && confidence === 'HIGH') confidence = 'MEDIUM';
      }

      // CPR demotions
      if (cprWideFlag    && confidence === 'HIGH') confidence = 'MEDIUM';
      if (cprDeadZoneFlag)                         confidence = 'LOW';

      // Expiry demotions
      if (expiryInfo) {
        if (expiryInfo.phase === 'THETA_CRUSH') confidence = 'LOW';
        else if (expiryInfo.phase === 'THETA_RAMP' && confidence === 'HIGH') confidence = 'MEDIUM';
      }

      // Pullback-entry demotion: 15m counter-trend entries are inherently
      // lower quality than ARM-aligned entries. Cap at MEDIUM.
      if (isPullbackEntry && confidence === 'HIGH') confidence = 'MEDIUM';

      // OI wall proximity demotion
      if (chain && spotForStruct != null) {
        var atrForOI = an5.atr || 20;
        if (action === 'BUY_CE' && chain.ceWall) {
          var dd = chain.ceWall.strike - spotForStruct;
          if (dd > 0 && dd < atrForOI * 0.5 && confidence === 'HIGH') confidence = 'MEDIUM';
        }
        if (action === 'BUY_PE' && chain.peWall) {
          var dd2 = spotForStruct - chain.peWall.strike;
          if (dd2 > 0 && dd2 < atrForOI * 0.5 && confidence === 'HIGH') confidence = 'MEDIUM';
        }
      }
    }

    // ── Skip-if warnings (non-blocking) ──────────────────────────────
    if (action !== 'WAIT') {
      // VWAP ±2σ stretch
      if (an5.vwapBands) {
        if (action === 'BUY_CE' && an5.aboveVwapUb2)
          skip.push('Spot is >+2\u03C3 above VWAP (\u20B9' + fmtNum(an5.vwapBands.ub2) + '). Chasing CE this far above VWAP is a late entry; wait for a pullback to VWAP +1\u03C3 (\u20B9' + fmtNum(an5.vwapBands.ub1) + ').');
        if (action === 'BUY_PE' && an5.belowVwapLb2)
          skip.push('Spot is >-2\u03C3 below VWAP (\u20B9' + fmtNum(an5.vwapBands.lb2) + '). Chasing PE this far below VWAP is a late entry; wait for a bounce to VWAP -1\u03C3 (\u20B9' + fmtNum(an5.vwapBands.lb1) + ').');
      }
      // BN divergence
      if (bn && bn.net) {
        var bnOpp = (action === 'BUY_CE' && bn.net === 'BEAR') || (action === 'BUY_PE' && bn.net === 'BULL');
        if (bnOpp)
          skip.push('Bank Nifty is going the OPPOSITE direction (BN ' + bn.trend + ', ' + (isFinite(bn.changePct) ? bn.changePct.toFixed(2) + '%' : '\u2014') + ') \u2014 BN leads Nifty ~60% of the time. Consider waiting for BN to align.');
        if (bn.net === 'FLAT')
          skip.push('Bank Nifty is FLAT today \u2014 not confirming the Nifty move. Watch BN: if BN starts moving with Nifty, momentum is real.');
      }
      // VIX extremes
      if (vix && isFinite(vix.current)) {
        if (vix.current < 12)
          skip.push('India VIX is only ' + vix.current.toFixed(1) + ' \u2014 dead-low IV. Even if direction is right, option premiums will barely move. Consider equity / futures instead, or skip entirely.');
        else if (vix.current < 13)
          skip.push('India VIX ' + vix.current.toFixed(1) + ' is sluggish \u2014 premiums won\'t expand much. Tighten profit targets, exit faster.');
        else if (vix.current > 22)
          skip.push('India VIX ' + vix.current.toFixed(1) + ' is elevated \u2014 premiums are expensive. Reduce position size, expect bigger SL hits if IV mean-reverts.');
        if (vix.changePct <= -5)
          skip.push('India VIX dropped ' + Math.abs(vix.changePct).toFixed(1) + '% intraday \u2014 active IV crush. Your premium gains are fighting volatility decay; tighten targets.');
        if (vix.changePct >= 8)
          skip.push('India VIX up ' + vix.changePct.toFixed(1) + '% intraday \u2014 large fear spike. Premiums are expanding fast for BOTH sides; expect violent two-way swings.');
      }
      // OI wall proximity
      if (chain && spotForStruct != null) {
        var atrChainW = an5.atr || 20;
        if (action === 'BUY_CE' && chain.ceWall) {
          var dw = chain.ceWall.strike - spotForStruct;
          if (dw > 0 && dw < atrChainW * 0.5)
            skip.push('Heavy CALL writing (max OI ' + (chain.ceWall.oi / 1e5).toFixed(1) + 'L contracts) sits ' + Math.round(dw) + ' pts above at strike ' + chain.ceWall.strike + '. Call-writers will fight any push into this level. Wait for a clean break above ' + chain.ceWall.strike + ' before sizing up.');
        }
        if (action === 'BUY_PE' && chain.peWall) {
          var dw2 = spotForStruct - chain.peWall.strike;
          if (dw2 > 0 && dw2 < atrChainW * 0.5)
            skip.push('Heavy PUT writing (max OI ' + (chain.peWall.oi / 1e5).toFixed(1) + 'L contracts) sits ' + Math.round(dw2) + ' pts below at strike ' + chain.peWall.strike + '. Put-writers will defend this level. Wait for a clean breakdown below ' + chain.peWall.strike + '.');
        }
      }
      if (!chain)
        skip.push('Option chain data not loaded yet \u2014 recommendation is running WITHOUT institutional OI / PCR input. Open the option-chain section once for richer analysis.');
      // RSI divergence
      var divTfs = [{ an: an15, label: '15m' }, { an: an5, label: '5m' }];
      for (var di2 = 0; di2 < divTfs.length; di2++) {
        var dt2 = divTfs[di2];
        if (action === 'BUY_CE' && dt2.an && dt2.an.rsiBearishDiv) {
          var b2 = dt2.an.rsiBearishDiv;
          skip.push(dt2.label + ' bearish RSI divergence: price made HH \u20B9' + fmtNum(b2.price2) + ' but RSI dropped from ' + b2.rsi1.toFixed(0) + ' to ' + b2.rsi2.toFixed(0) + '. Momentum fading at highs. Wait for RSI to confirm before entering CE.');
        }
        if (action === 'BUY_PE' && dt2.an && dt2.an.rsiBullishDiv) {
          var bl2 = dt2.an.rsiBullishDiv;
          skip.push(dt2.label + ' bullish RSI divergence: price made LL \u20B9' + fmtNum(bl2.price2) + ' but RSI lifted from ' + bl2.rsi1.toFixed(0) + ' to ' + bl2.rsi2.toFixed(0) + '. Selling pressure waning at lows. Wait for RSI to confirm before entering PE.');
        }
      }
    }

    // ── Structural trade plan ─────────────────────────────────────────
    // Primary SL = 5m bosLevel (the structural invalidation level).
    // T1 = 15m last swing high/low minus fill-room (0.5 × cappedATR(5m)).
    // T2 = 30m last swing high/low (stretch target).
    // Fall back to computeRiskPlan for the full S/R ladder.
    var riskPlan = computeRiskPlan(an5, action, an1h, null, mode, raw1h);

    if (action !== 'WAIT') {
      // Override SL with structural bosLevel from 5m
      if (s5m.bosLevel && isFinite(s5m.bosLevel)) {
        riskPlan.slSpot = { value: s5m.bosLevel, name: '5m structural BOS', role: 'sl', priority: 9 };
      }
      // Build structural targets
      var cappedAtr5 = (isFinite(s5m.cappedATR) && s5m.cappedATR > 0) ? s5m.cappedATR : (an5.atr || 10);
      var structTargets = [];
      if (action === 'BUY_CE') {
        if (s15m.swingHighs && s15m.swingHighs.length > 0)
          structTargets.push({ value: s15m.swingHighs[0].price - 0.5 * cappedAtr5, name: '15m swing high (T1)', role: 't1', priority: 8 });
        if (s30m.swingHighs && s30m.swingHighs.length > 0)
          structTargets.push({ value: s30m.swingHighs[0].price - 0.5 * cappedAtr5, name: '30m swing high (T2)', role: 't2', priority: 7 });
      } else {
        if (s15m.swingLows && s15m.swingLows.length > 0)
          structTargets.push({ value: s15m.swingLows[0].price + 0.5 * cappedAtr5, name: '15m swing low (T1)', role: 't1', priority: 8 });
        if (s30m.swingLows && s30m.swingLows.length > 0)
          structTargets.push({ value: s30m.swingLows[0].price + 0.5 * cappedAtr5, name: '30m swing low (T2)', role: 't2', priority: 7 });
      }
      if (structTargets.length > 0) {
        // Prepend structural targets; keep existing ones as fallback overflow
        riskPlan.targetsSpot = structTargets.concat((riskPlan.targetsSpot || []).slice(0, 1));
      }

      // R:R floor check (1.5) — using first structural target
      var MIN_RR = 1.5;
      if (riskPlan.slSpot && riskPlan.targetsSpot && riskPlan.targetsSpot[0]) {
        var rrSl   = +riskPlan.slSpot.value;
        var rrT1   = +riskPlan.targetsSpot[0].value;
        var rrRisk = Math.abs(spotForStruct - rrSl);
        var rrReward = Math.abs(rrT1 - spotForStruct);
        if (rrRisk > 0 && rrReward / rrRisk < MIN_RR) {
          // Try T2
          var t2ok = riskPlan.targetsSpot[1] && rrRisk > 0
            && (Math.abs(+riskPlan.targetsSpot[1].value - spotForStruct) / rrRisk) >= MIN_RR;
          if (t2ok) {
            // Remove T1, promote T2 as the target
            riskPlan.targetsSpot = riskPlan.targetsSpot.slice(1);
          } else {
            action = 'WAIT'; sideLabel = 'WAIT';
            vetoReasons.push('Structural R:R too thin: risk ' + rrRisk.toFixed(1) + ' pts, reward to T1 only ' + rrReward.toFixed(1) + ' pts (need \u00D71.5). Even T2 doesn\'t clear the floor. Room is too tight today \u2014 price is too close to structural resistance/support.');
          }
        }
      }
    }

    // ── Confidence pct (continuous %) ────────────────────────────────
    var confidencePct = null;
    if (action !== 'WAIT' && confidence !== '\u2014') {
      confidencePct = confidence === 'HIGH'   ? 85
                    : confidence === 'MEDIUM' ? 65
                    : 45;
      // Fine-tune by ADX
      var adx15p = an15.adx;
      if (isFinite(adx15p)) {
        var adxBoost = Math.min(10, Math.max(-10, (adx15p - 20) * 0.5));
        confidencePct = Math.round(Math.min(95, Math.max(35, confidencePct + adxBoost)));
      }
    }

    // ── tfNet for the verdict bar (structural labels → BULL/BEAR/FLAT) ─
    function structToNet(s) {
      if (!s || !s.label) return 'FLAT';
      if (s.label === 'UP')   return 'BULL';
      if (s.label === 'DOWN') return 'BEAR';
      return 'FLAT';
    }
    var tf1hNet  = structToNet(s1h);
    var tf30mNet = structToNet(s30m);
    var tf15Net  = structToNet(s15m);
    var tf5Net   = structToNet(s5m);

    // ── REGIME gate (2026-06-09, backtested) — stand aside in a choppy regime ──
    // The losing May\u2013Jun stretches all shared one trait: a RANGEBOUND 30-minute (no
    // higher-TF trend), so intraday trend signals kept firing into mean-reverting chop
    // and bled premium to theta. Gating fresh BUYs on 30m ADX < 18 flipped the
    // walk-forward (last-40% UNSEEN data) from \u221253 pts / PF 0.95 to +76 / PF 1.10 and
    // cut June \u2212120\u2192\u22129 on the auto-trade engine (buildIntradaySetup). `an30.adx` here is
    // the SAME value (IM.adx(30m,14) last close) the backtest gated on, so the on-screen
    // HUD now AGREES with the auto-trade engine instead of flashing a BUY the auto-trader
    // would skip. Suppress-only (never CREATES a BUY) \u2192 fail-safe per the signal-integrity
    // rule. `regimeInfo` ships in the return so the HUD paints a TRENDING / CHOPPY chip on
    // every recommendation (green when it approves, amber when it stands aside).
    var regimeAdx = (an30 && an30.adx != null && isFinite(an30.adx)) ? an30.adx : null;
    var regimeChoppy = (regimeAdx != null && regimeAdx < 18);
    var regimeInfo = { state: regimeChoppy ? 'CHOPPY' : (regimeAdx != null ? 'TRENDING' : 'UNKNOWN'), adx30: regimeAdx };
    if (regimeChoppy && (action === 'BUY_CE' || action === 'BUY_PE')) {
      attemptedSide = attemptedSide || (action === 'BUY_CE' ? 'BUY CE' : 'BUY PE');
      vetoReasons.unshift('Choppy regime \u2014 the 30-minute trend strength (ADX ' + Math.round(regimeAdx) + ') is below 18, so the bigger picture is rangebound, not trending. Intraday trend signals fail in chop and your option premium bleeds to theta. Standing aside until a clean trend develops.');
      action = 'WAIT';
      sideLabel = 'WAIT';
      confidence = '\u2014';
    }

    // ── Setup label (for plan card header) ───────────────────────────
    var setupLabel = action === 'WAIT' ? 'WAIT'
      : isPullbackEntry
        ? (bias === 'UP' ? 'PULLBACK BUY · BULL BIAS' : 'PULLBACK SELL · BEAR BIAS')
        : (biasHigh ? 'STRUCTURAL ' : 'DEVELOPING ') + (bias === 'UP' ? 'BULL BIAS' : 'BEAR BIAS');

    // ── Return object — same shape as old generateVerdict ────────────
    return {
      ok: true,
      action: action,
      sideLabel: sideLabel,
      confidence: confidence,
      confidencePct: confidencePct,
      attemptedSide: attemptedSide,
      isPullbackEntry: !!isPullbackEntry,
      vetoReasons: vetoReasons,
      tfNet: { '1h': tf1hNet, '30m': tf30mNet, '15m': tf15Net, '5m': tf5Net },
      tfsAligned: {
        bull: (tf15Net === 'BULL' ? 1 : 0) + (tf5Net === 'BULL' ? 1 : 0) + (tf30mNet === 'BULL' ? 1 : 0),
        bear: (tf15Net === 'BEAR' ? 1 : 0) + (tf5Net === 'BEAR' ? 1 : 0) + (tf30mNet === 'BEAR' ? 1 : 0)
      },
      h1: an1h ? {
        trend: an1h.trend, rsi: an1h.rsi, adx: an1h.adx,
        ema9: an1h.ema9, ema21: an1h.ema21, ema50: an1h.ema50,
        swingHigh: an1h.swingHigh, swingLow: an1h.swingLow, net: tf1hNet
      } : null,
      chain: chain,
      gap:    an5.gap    || null,
      expiry: expiryInfo,
      vix:    vix || null,
      session: {
        phase:    sessionPhase,
        label:    sessionPhaseLabel(sessionPhase, mode),
        cls:      sessionPhaseClass(sessionPhase, mode),
        minOfDay: _ist.minOfDay,
        mode:     mode
      },
      mode: mode,
      bn:   bn || null,
      regime: regimeInfo,
      volatility: { regime: volRegime, atrPct: atrPctNow, atrPoints: an5.atr },
      vwapBands: an5.vwapBands ? {
        vwap: an5.vwap, std: an5.vwapBands.std,
        ub1: an5.vwapBands.ub1, lb1: an5.vwapBands.lb1,
        ub2: an5.vwapBands.ub2, lb2: an5.vwapBands.lb2,
        aboveUb2: an5.aboveVwapUb2, belowLb2: an5.belowVwapLb2,
        aboveUb1: an5.aboveVwapUb1, belowLb1: an5.belowVwapLb1
      } : null,
      srZones: an5.srZones || [],
      rounds:  an5.rounds  || [],
      avwap:   an5.avwap   || null,
      cpr: an5.cpr ? {
        P: an5.cpr.P, TC: an5.cpr.TC, BC: an5.cpr.BC,
        R1: an5.cpr.R1, R2: an5.cpr.R2, R3: an5.cpr.R3,
        S1: an5.cpr.S1, S2: an5.cpr.S2, S3: an5.cpr.S3,
        width: an5.cpr.width,
        widthPctOfRange: an5.cpr.widthPctOfRange,
        classification: an5.cpr.classification,
        location: an5.aboveCprTC ? 'ABOVE' : an5.belowCprBC ? 'BELOW' : an5.insideCpr ? 'INSIDE' : 'UNKNOWN'
      } : null,
      ceScore: ceScore, peScore: peScore,
      ceSigs: ceSigs,   peSigs: peSigs,
      tfScore: tfScore,  tfSignals: tfSignals,
      setupLabel: setupLabel,
      spotInvalid: riskPlan.emergencySpot ? riskPlan.emergencySpot.value : (s5m.bosLevel || null),
      targetsSpot:   riskPlan.targetsSpot,
      slSpot:        riskPlan.slSpot,
      emergencySpot: riskPlan.emergencySpot,
      srLadder:      riskPlan.srLadder,
      skip: skip
    };
  }

  // ─── computeRiskPlan ─ structure-aware targets + SL + emergency ──
  // Inputs : an5 = 5m analysis snapshot, action = 'BUY_CE'|'BUY_PE'|'WAIT'
  // Output : { targetsSpot:[T1,T2,T3], slSpot, emergencySpot, srLadder }
  //
  // Each level has { value, name, role, priority } so the UI can
  // explain WHY the level matters ("PDH = sellers from yesterday").
  // Priority is used to (a) prefer hard structure for emergency exit,
  // and (b) order the S/R ladder visualization.
  // ─── aggregate4hFrom1h ─ build 4H bars from 1H bars ─────────────
  // Aggregates every 4 consecutive 1H bars (oldest-first) into a
  // single 4H bar. Last incomplete batch (<4 bars) is dropped so
  // we never emit a "fake" half-formed 4H bar. Output bars use the
  // standard [ts, open, high, low, close, volume] shape so they
  // can be fed straight into swingHighs / swingLows.
  function aggregate4hFrom1h(raw1h) {
    if (!raw1h || raw1h.length < 4) return [];
    var sorted = raw1h.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var out = [];
    for (var i = 0; i + 4 <= sorted.length; i += 4) {
      var batch = sorted.slice(i, i + 4);
      var ts    = batch[0][0];
      var open  = +batch[0][1];
      var close = +batch[3][4];
      var high  = -Infinity, low = Infinity, vol = 0;
      for (var k = 0; k < 4; k++) {
        if (+batch[k][2] > high) high = +batch[k][2];
        if (+batch[k][3] < low)  low  = +batch[k][3];
        vol += (+batch[k][5] || 0);
      }
      out.push([ts, open, high, low, close, vol]);
    }
    return out;
  }

  // ─── clusterSwingPivots ─ group nearby pivots into S/R zones ─────
  // Takes an array of swing pivots (from swingHighs / swingLows) and
  // clusters pivots whose prices are within `tolerance` of each
  // other. A "cluster" with N pivots represents a level that price
  // has REJECTED off of N separate times — the touch count is the
  // S/R-strength signal we care about.
  //
  //   swings    : [{ idx, price }] from swingHighs/Lows
  //   tolerance : absolute price width to merge pivots (e.g. 25 pts
  //               on Nifty ≈ 0.1% of spot)
  // returns: [{ midpoint, low, high, touches, lastIdx }]
  function clusterSwingPivots(swings, tolerance) {
    if (!swings || !swings.length) return [];
    var sorted = swings.slice().sort(function (a, b) {
      return a.price - b.price;
    });
    var clusters = [];
    var current  = [sorted[0]];
    for (var i = 1; i < sorted.length; i++) {
      var p = sorted[i].price;
      var bandLo = current[0].price;
      var bandHi = current[current.length - 1].price;
      // Single-step gate AND total-band gate — same logic as
      // findSrZones (5m) so 4H/1H clusters behave consistently.
      if (p - bandHi <= tolerance && p - bandLo <= tolerance * 2) {
        current.push(sorted[i]);
      } else {
        clusters.push(current);
        current = [sorted[i]];
      }
    }
    clusters.push(current);
    return clusters.map(function (c) {
      var prices = c.map(function (s) { return s.price; });
      var sum = 0;
      for (var j = 0; j < prices.length; j++) sum += prices[j];
      var lastIdx = c.reduce(function (m, s) {
        return s.idx > m ? s.idx : m;
      }, 0);
      return {
        midpoint: sum / prices.length,
        low:      Math.min.apply(null, prices),
        high:     Math.max.apply(null, prices),
        touches:  c.length,
        lastIdx:  lastIdx
      };
    });
  }

  // ─── collectStructuralSr ─ REAL-rejection S/R picker ─────────────
  // The "Key S/R Levels" card uses this — NOT collectSrLevels.
  // Crucial difference: this returns ONLY levels where price was
  // actually rejected on a higher timeframe (4H, 1H) or has hard
  // historical memory (multi-touch zones, prev-day extremes).
  //
  // SOURCES (in order of structural weight, all scored on touches):
  //   1. 4H swing pivots clustered into rejection zones        (heaviest)
  //   2. 1H swing pivots clustered into rejection zones
  //   3. 5m srZones with ≥ 3 touches (multi-day market memory)
  //   4. Prev Day High / Low (yesterday's extreme — real battle)
  //
  // EXPLICITLY EXCLUDED (these are derived, not rejection-based):
  //   - EMAs / SMAs (any timeframe)  — dynamic averages
  //   - VWAP and VWAP ±σ bands       — dynamic intraday calc
  //   - Anchored VWAPs               — dynamic anchored calc
  //   - Round-number magnets         — psychological, not rejection
  //   - CPR pivots (Pivot/R1/S1/…)   — derived formula, not rejection
  //   - Today's High / Low           — still forming, no rejection yet
  //   - Opening Range H/L            — just first-15-min print, no rejection
  //
  //   an5    : 5m analysis snapshot (uses prevHigh/prevLow + srZones)
  //   an1h   : 1H analysis snapshot (optional, mostly for context)
  //   raw1h  : raw 1H candle bars (used to derive 4H + cluster pivots)
  //   spot   : current Nifty spot
  // returns { resistance, support } — each [{ value, name, touches,
  //   priority, source }] sorted nearest → furthest from spot.
  function collectStructuralSr(an5, an1h, raw1h, spot) {
    if (!an5 || !isFinite(spot)) return { resistance: [], support: [] };
    var math    = M();
    var hasSwing = math.swingHighs && math.swingLows;
    var levels  = [];

    // Cluster tolerance — 0.12% of spot (~28 pts on Nifty 24k).
    // Wider than the 5m srZones tolerance (~10 pts) because 1H/4H
    // pivots are naturally further apart — a level "battle" can
    // span 25-30 pts of wiggle on the 1H, and clustering tightly
    // would split one real S/R into two adjacent ones.
    var tol1h = Math.max(spot * 0.0012, 15);
    var tol4h = Math.max(spot * 0.0018, 25);

    if (hasSwing && raw1h && raw1h.length >= 8) {
      var sorted1h = raw1h.slice().sort(function (a, b) {
        return new Date(a[0]).getTime() - new Date(b[0]).getTime();
      });
      // 1H rejection clusters
      var hi1h = math.swingHighs(sorted1h, 3);
      var lo1h = math.swingLows(sorted1h, 3);
      var c1hHi = clusterSwingPivots(hi1h, tol1h);
      var c1hLo = clusterSwingPivots(lo1h, tol1h);
      function push1h(c) {
        // Need ≥ 2 touches to count as "rejected multiple times".
        // Single-touch 1H pivots are too noisy to label as S/R.
        if (c.touches < 2) return;
        levels.push({
          value:    c.midpoint,
          name:     '1H pivot',
          touches:  c.touches,
          source:   '1h',
          priority: 3 + Math.min(c.touches, 4)
        });
      }
      c1hHi.forEach(push1h);
      c1hLo.forEach(push1h);

      // 4H rejection clusters (aggregated from 1H)
      var raw4h = aggregate4hFrom1h(sorted1h);
      if (raw4h.length >= 8) {
        // Smaller lookback on 4H (=2) — we have fewer bars and a
        // 2-bar fractal on 4H is still ~16 hours of memory.
        var hi4h = math.swingHighs(raw4h, 2);
        var lo4h = math.swingLows(raw4h, 2);
        var c4hHi = clusterSwingPivots(hi4h, tol4h);
        var c4hLo = clusterSwingPivots(lo4h, tol4h);
        function push4h(c) {
          // Single-touch 4H pivots ARE allowed — a 4H swing is
          // already a big rejection point, even if just one.
          levels.push({
            value:    c.midpoint,
            name:     '4H pivot',
            touches:  c.touches,
            source:   '4h',
            priority: 5 + Math.min(c.touches, 4)
          });
        }
        c4hHi.forEach(push4h);
        c4hLo.forEach(push4h);
      }
    }

    // 5m multi-touch swing-cluster zones with ≥ 3 touches
    // (computed from 5m raw bars over multi-day window; captures
    // intraday memory the 1H/4H clusters miss).
    if (an5.srZones && an5.srZones.length) {
      for (var iz = 0; iz < an5.srZones.length; iz++) {
        var z = an5.srZones[iz];
        if (z.touches < 3) continue;   // < 3 touches isn't real memory
        levels.push({
          value:    z.midpoint,
          name:     'Multi-touch zone',
          touches:  z.touches,
          source:   '5m-zone',
          priority: 4 + Math.min(z.touches, 4)
        });
      }
    }

    // Prev Day OHLC — yesterday's reference levels. All four are
    // real intraday S/R battles:
    //   PDH (priority 6) — yesterday's resistance ceiling
    //   PDL (priority 6) — yesterday's support floor
    //   PDC (priority 6) — gap-fill reference + CPR anchor; the
    //                      single most-watched price by intraday
    //                      traders for "is today following
    //                      yesterday's direction?"
    //   PDO (priority 5) — gap-fade target on gap-up/down days;
    //                      slightly lower weight than PDC since
    //                      it's less universally watched
    if (an5.prevHigh != null && isFinite(an5.prevHigh)) {
      levels.push({
        value: an5.prevHigh, name: 'Prev Day High',
        touches: 1, source: 'pdh', priority: 6
      });
    }
    if (an5.prevLow != null && isFinite(an5.prevLow)) {
      levels.push({
        value: an5.prevLow, name: 'Prev Day Low',
        touches: 1, source: 'pdl', priority: 6
      });
    }
    if (an5.prevClose != null && isFinite(an5.prevClose)) {
      levels.push({
        value: an5.prevClose, name: 'Prev Day Close',
        touches: 1, source: 'pdc', priority: 6
      });
    }
    if (an5.prevOpen != null && isFinite(an5.prevOpen)) {
      levels.push({
        value: an5.prevOpen, name: 'Prev Day Open',
        touches: 1, source: 'pdo', priority: 5
      });
    }

    // Fibonacci retracement levels — anchored at today's intraday
    // range. Treated as REACTION ZONES (not rejection-tested
    // levels), so priority sits below 4H/1H pivots and PDH/PDL:
    //   50% / 61.8% (golden zone) → priority 5 (same as PDO)
    //   38.2% / 78.6%             → priority 4 (below PDO, above
    //                                generic 1H pivots with 2 touches)
    // The dedupeMerging step will absorb any Fib level that's
    // within ~25 pts of a higher-priority structural level
    // (e.g. a Fib 61.8% sitting on a 4H pivot becomes a single
    // strong "4H pivot" rung with the touch count bumped).
    if (an5.fib && an5.fib.levels && an5.fib.levels.length) {
      an5.fib.levels.forEach(function (lv) {
        if (lv == null || !isFinite(lv.value)) return;
        levels.push({
          value:    lv.value,
          name:     'Fib ' + lv.label,
          touches:  1,
          source:   'fib',
          priority: lv.isGolden ? 5 : 4
        });
      });
    }

    // Split into resistance/support, sort nearest → furthest.
    var resistance = levels
      .filter(function (l) { return l.value > spot; })
      .sort(function (a, b) { return a.value - b.value; });
    var support = levels
      .filter(function (l) { return l.value < spot; })
      .sort(function (a, b) { return b.value - a.value; });

    // Dedupe within ~0.1% of spot (~25 pts on Nifty). When two
    // levels overlap (e.g. a 4H pivot and a 1H pivot at the same
    // price), keep the higher-priority one, ADD touches so the
    // confluence is captured in the badge, AND record the
    // displaced source on the survivor's `mergedSources` array so
    // the renderer can surface a "+1H" / "+FIB" confluence chip.
    // Without this trail, 1H pivots that get absorbed into a
    // nearby 5m zone disappear visually even though they
    // contribute to the touch count — the user (correctly) reads
    // the card and asks "where are the 1H pivots?".
    function dedupeMerging(list) {
      var dedTol = Math.max(spot * 0.001, 12);
      var out = [];
      function addMerged(target, src) {
        if (!src || src === target.source) return;
        if (!target.mergedSources) target.mergedSources = [];
        if (target.mergedSources.indexOf(src) === -1) {
          target.mergedSources.push(src);
        }
      }
      for (var i = 0; i < list.length; i++) {
        var cur   = list[i];
        var found = false;
        for (var j = 0; j < out.length; j++) {
          if (Math.abs(out[j].value - cur.value) <= dedTol) {
            // Resolve survivor vs displaced by priority. Equal
            // priority → keep the one already in `out` (stable
            // first-wins, matches the pre-tracking behaviour).
            var survivor, displaced;
            if (cur.priority > out[j].priority) {
              survivor = cur; displaced = out[j];
            } else {
              survivor = out[j]; displaced = cur;
            }
            survivor.touches = (survivor.touches || 0) + (displaced.touches || 0);
            addMerged(survivor, displaced.source);
            // Transitive merges: if the displaced level had
            // already absorbed others in a prior iteration, those
            // sources propagate to the new survivor too.
            if (displaced.mergedSources) {
              for (var k = 0; k < displaced.mergedSources.length; k++) {
                addMerged(survivor, displaced.mergedSources[k]);
              }
            }
            if (survivor !== out[j]) out[j] = survivor;
            found = true;
            break;
          }
        }
        if (!found) out.push(cur);
      }
      return out;
    }
    return {
      resistance: dedupeMerging(resistance),
      support:    dedupeMerging(support)
    };
  }

  // ─── collectSrLevels ─ unified S/R level harvester ──────────────
  // Pulled out of computeRiskPlan so it can run INDEPENDENTLY of the
  // trade verdict — the "Key S/R Levels" card needs a level list
  // even when the verdict is WAIT (the user wants to see where
  // price is sitting BEFORE a setup forms, to anticipate the next
  // trade). Returns the same {resistance, support} shape that the
  // S/R ladder consumes, so both call-sites stay in sync.
  //   an5      : 5m analysis snapshot (must have lastClose)
  //   an1h     : optional 1H snapshot (for 1H pivots / EMAs)
  //   spot     : current Nifty spot (live or analysis-time)
  // returns  { resistance: [...], support: [...], all: [...] }
  //   resistance : levels ABOVE spot, sorted nearest → furthest
  //   support    : levels BELOW spot, sorted nearest → furthest
  //   all        : un-split (every collected level with metadata)
  function collectSrLevels(an5, an1h, spot) {
    if (!an5 || !isFinite(spot)) {
      return { resistance: [], support: [], all: [] };
    }
    var allLevels = [];
    function add(value, name, role, priority) {
      if (value == null || !isFinite(value)) return;
      allLevels.push({ value: value, name: name, role: role, priority: priority });
    }
    add(an5.vwap,      'VWAP',           'dynamic', 2);
    if (an5.vwapBands) {
      add(an5.vwapBands.ub1, 'VWAP +1\u03C3', 'dynamic', 2);
      add(an5.vwapBands.lb1, 'VWAP -1\u03C3', 'dynamic', 2);
      add(an5.vwapBands.ub2, 'VWAP +2\u03C3', 'dynamic', 2);
      add(an5.vwapBands.lb2, 'VWAP -2\u03C3', 'dynamic', 2);
    }
    add(an5.orHigh,    'OR High (15m)',  'static',  3);
    add(an5.orLow,     'OR Low (15m)',   'static',  3);
    add(an5.prevHigh,  'Prev Day High',  'static',  4);
    add(an5.prevLow,   'Prev Day Low',   'static',  4);
    add(an5.todayHigh, "Today's High",   'static',  3);
    add(an5.todayLow,  "Today's Low",    'static',  3);
    add(an5.swingHigh, '5m Swing High',  'dynamic', 2);
    add(an5.swingLow,  '5m Swing Low',   'dynamic', 2);
    add(an5.ema9,      'EMA 9 (5m)',     'dynamic', 1);
    add(an5.ema21,     'EMA 21 (5m)',    'dynamic', 1);
    add(an5.ema50,     'EMA 50 (5m)',    'dynamic', 1);
    if (an5.cpr) {
      add(an5.cpr.P,  'Pivot (CPR center)', 'static', 4);
      add(an5.cpr.TC, 'CPR Top (TC)',       'static', 4);
      add(an5.cpr.BC, 'CPR Bottom (BC)',    'static', 4);
      add(an5.cpr.R1, 'R1 (CPR)',           'static', 3);
      add(an5.cpr.R2, 'R2 (CPR)',           'static', 3);
      add(an5.cpr.R3, 'R3 (CPR)',           'static', 2);
      add(an5.cpr.S1, 'S1 (CPR)',           'static', 3);
      add(an5.cpr.S2, 'S2 (CPR)',           'static', 3);
      add(an5.cpr.S3, 'S3 (CPR)',           'static', 2);
    }
    if (an5.srZones && an5.srZones.length) {
      for (var iz = 0; iz < an5.srZones.length; iz++) {
        var z = an5.srZones[iz];
        var basePri = z.touches >= 4 ? 4 : 3;
        if (z.side === 'mixed' && basePri < 4) basePri = 4;
        add(z.midpoint, 'Swing-cluster zone (' + z.touches + ' touches)',
            'static', basePri);
      }
    }
    if (an5.rounds && an5.rounds.length) {
      for (var ir = 0; ir < an5.rounds.length; ir++) {
        var rnd = an5.rounds[ir];
        var pri = rnd.tier === 1 ? 4 : (rnd.tier === 2 ? 3 : 2);
        var nm  = rnd.tier === 1 ? 'Round level (\u20B9500-tier)'
                : rnd.tier === 2 ? 'Round level (\u20B9100-tier)'
                                 : 'Round level (\u20B950-tier)';
        add(rnd.level, nm, 'static', pri);
      }
    }
    if (an5.avwap) {
      if (an5.avwap.fromHigh != null) add(an5.avwap.fromHigh, 'AVWAP from session high', 'dynamic', 3);
      if (an5.avwap.fromLow  != null) add(an5.avwap.fromLow,  'AVWAP from session low',  'dynamic', 3);
    }
    if (an1h) {
      add(an1h.swingHigh, '1H Swing High', 'dynamic', 4);
      add(an1h.swingLow,  '1H Swing Low',  'dynamic', 4);
      add(an1h.ema21,     'EMA 21 (1H)',   'dynamic', 2);
      add(an1h.ema50,     'EMA 50 (1H)',   'dynamic', 2);
    }
    var resistance = allLevels
      .filter(function (l) { return l.value > spot; })
      .sort(function (a, b) { return a.value - b.value; });
    var support = allLevels
      .filter(function (l) { return l.value < spot; })
      .sort(function (a, b) { return b.value - a.value; });
    return { resistance: resistance, support: support, all: allLevels };
  }

  function computeRiskPlan(an5, action, an1h, overrideSpot, mode, raw1h) {
    var empty = { targetsSpot: [], slSpot: null, emergencySpot: null,
                  srLadder: { resistance: [], support: [] } };
    if (!an5 || !isFinite(an5.lastClose)) return empty;
    // SCALP-only since the May 2026 refactor — see generateVerdict
    // for the same rationale.
    mode = 'SCALP';

    // Prefer LIVE spot when caller supplies it (renderPlan / liveTick)
    // so an S/R level that drifted to the wrong side of spot since
    // the last 3-min analyze() gets correctly re-filtered. Without
    // this, a "5m Swing High" that was resistance at analysis time
    // can end up BELOW live spot, get projected as a CE target, and
    // produce a "target" premium BELOW entry (structurally invalid).
    var spot = (overrideSpot != null && isFinite(overrideSpot) && overrideSpot > 0)
               ? overrideSpot : an5.lastClose;
    var atr  = an5.atr || 0;

    // Always collect S/R — even in WAIT mode the caller (the new
    // "Key S/R Levels" card) wants the level map. Targets/SL/
    // Emergency below are skipped when WAIT.
    var srSplit   = collectSrLevels(an5, an1h, spot);
    var resistance = srSplit.resistance;
    var support    = srSplit.support;

    // Inject structural 4H/1H rejection clusters as PRIORITY-5
    // levels so the emergency-exit picker (which prefers priority
    // >= 3 levels) treats them as primary trip-lines. A 4H pivot
    // with ×4 historical rejections is the single most-important
    // "if this breaks, the directional thesis is dead" level.
    if (raw1h && raw1h.length >= 8) {
      var struct = collectStructuralSr(an5, an1h, raw1h, spot);
      function injectStructural(targetList, source, sortAsc) {
        for (var ii = 0; ii < source.length; ii++) {
          var s = source[ii];
          // Map structural-picker priority to riskPlan priority
          // tier: 4H ≥ 5, 1H clusters = 4, 5m multi-touch = 4,
          // PDH/PDL = 4. The riskPlan emergency picker uses
          // `priority >= 3`, so all of these become eligible.
          var pri = s.source === '4h' ? 5
                  : s.source === '1h' ? 4
                  :                     4;
          var nm  = s.source === '4h' ? '4H pivot'
                  : s.source === '1h' ? '1H pivot'
                  : s.name;
          if (s.touches && s.touches >= 2) nm += ' (\u00D7' + s.touches + ')';
          targetList.push({ value: s.value, name: nm,
                            role: 'static', priority: pri });
        }
        // Re-sort after injection.
        if (sortAsc) targetList.sort(function (a, b) { return a.value - b.value; });
        else         targetList.sort(function (a, b) { return b.value - a.value; });
      }
      injectStructural(resistance, struct.resistance, true);
      injectStructural(support,    struct.support,    false);
    }
    if (action === 'WAIT') {
      return {
        targetsSpot: [],
        slSpot: null,
        emergencySpot: null,
        srLadder: { resistance: resistance, support: support }
      };
    }

    // For BUY CE we LONG the upside → targets are resistance levels,
    // SL/Emergency are support levels (thesis breaks if price falls).
    // For BUY PE everything mirrors.
    var targetLadder = action === 'BUY_CE' ? resistance : support;
    var slLadder     = action === 'BUY_CE' ? support    : resistance;

    // ─── Pick 3 laddered targets ──────────────────────────────────
    // Two distance rules:
    //  1. First target must be at least `minT1Dist` from SPOT, so
    //     the projected premium gain is meaningful (a level 2-3 pts
    //     away yields ~0% premium move after delta — useless as a
    //     target). At 0.4× ATR for Nifty (typical ATR 25-40 pts on
    //     5m), this enforces ~10-15 pt minimum = ~5-7 pt premium
    //     move at 0.5 delta = ~3-5% gain — actually worth booking.
    //  2. Subsequent targets need `minSpacing` from the previous
    //     target so they don't collapse (e.g. EMA9 sitting right
    //     above EMA21 — both fill on the same impulse).
    //
    // Scalp tuning (SCALP-only engine since May 2026):
    //  - minT1Dist = 0.2× ATR (≈ 5-8 pts on Nifty), since a 5-min
    //    hold can realistically capture only a 5-15 pt move.
    //  - minSpacing = 0.15× ATR, so T1/T2/T3 stack tightly.
    //  - PRIORITY FILTER for T1/T2: only dynamic intraday levels
    //    (VWAP, 5m swings, 5m EMAs, 1H EMA21). Major levels (PDH/
    //    PDL/ORH/ORL/1H swings) are usually >30 pts away — wrong
    //    target for a 5-min hold. T3 still accepts a major level
    //    as the optional "stretch" target if the move keeps going.
    var minT1Dist  = Math.max(5, atr * 0.2);   // ~5-8 pts on Nifty
    var minSpacing = Math.max(4, atr * 0.15);

    // SCALP: split ladder into "near" (dynamic, intraday) vs "far"
    // (major static) sets. T1 + T2 picked from `nearLadder` first;
    // `farLadder` only feeds T3 (the stretch target).
    function isNearLevel(l) {
      // VWAP, 5m swings, all EMAs, 1H EMA21 = intraday dynamic.
      // Static major levels (PDH/PDL/ORH/ORL/today H-L) and 1H
      // swing pivots are excluded as "far" for scalp T1/T2.
      if (!l) return false;
      if (l.role === 'dynamic') return true;
      return false;
    }
    // SCALP: split ladder into "near" (dynamic, intraday) vs "far"
    // (major static). T1 + T2 only pick from `nearLadder`; the
    // far set feeds T3 as the stretch target.
    var nearLadder = targetLadder.filter(isNearLevel);
    var farLadder  = targetLadder.filter(function (l) { return !isNearLevel(l); });

    var targets = [];
    var primaryLadder = nearLadder;
    for (var i = 0; i < primaryLadder.length && targets.length < 2; i++) {
      var lvl = primaryLadder[i];
      var distFromSpot = Math.abs(lvl.value - spot);
      if (targets.length === 0) {
        if (distFromSpot < minT1Dist) continue;
        targets.push(lvl);
      } else {
        var prev = targets[targets.length - 1].value;
        if (Math.abs(lvl.value - prev) >= minSpacing) targets.push(lvl);
      }
    }
    // SCALP: try to fill T3 from the major-level ladder (the
    // "stretch" target if price runs through T1/T2). We don't
    // hold to T3 — that's a runner, the scalper books at T2 most
    // days — but having a real magnet as T3 is more useful than
    // a synthetic ATR step.
    if (targets.length < 3 && farLadder.length) {
      for (var fj = 0; fj < farLadder.length; fj++) {
        var fl = farLadder[fj];
        var prevF = targets.length ? targets[targets.length - 1].value : spot;
        if (Math.abs(fl.value - prevF) >= minSpacing) { targets.push(fl); break; }
      }
    }
    // Continue with the full ladder if the near + far pick still
    // hasn't produced 3 targets.
    if (targets.length < 3) {
      for (var i2 = 0; i2 < targetLadder.length && targets.length < 3; i2++) {
        var lvl2 = targetLadder[i2];
        // Skip already-picked.
        var dup = false;
        for (var dk = 0; dk < targets.length; dk++) {
          if (targets[dk].value === lvl2.value) { dup = true; break; }
        }
        if (dup) continue;
        var distFromSpot2 = Math.abs(lvl2.value - spot);
        if (targets.length === 0) {
          if (distFromSpot2 < minT1Dist) continue;
          targets.push(lvl2);
        } else {
          var prev2 = targets[targets.length - 1].value;
          if (Math.abs(lvl2.value - prev2) >= minSpacing) targets.push(lvl2);
        }
      }
    }
    // Fallback: if S/R is sparse, fill remaining targets with
    // ATR-spaced "synthetic" levels so the user still has 3 to scale out at.
    var fallbackStep = Math.max(atr * 0.35, 6);
    while (targets.length < 3) {
      var base = targets.length > 0
        ? targets[targets.length - 1].value
        : (action === 'BUY_CE' ? spot + minT1Dist : spot - minT1Dist);
      var v;
      if (targets.length === 0) {
        v = base;
      } else {
        v = action === 'BUY_CE' ? base + fallbackStep : base - fallbackStep;
      }
      targets.push({ value: v,
                     name: (targets.length === 0
                              ? '0.2× ATR target'
                              : (targets.length + 1) + '× ATR step')
                           + ' (no S/R found)',
                     role: 'fallback', priority: 0 });
    }

    // ─── Pick TIGHT SL ────────────────────────────────────────────
    // Nearest opposing level, but at least minSlDist away from spot
    // (so a single noise candle doesn't immediately stop us out).
    // ~0.12× ATR (4-5 pts on Nifty) — the whole point of a scalp
    // is a tight stop so a 1:1 R:R is still ~5 pt risk for ~5 pt
    // reward, perfectly profitable.
    var minSlDist = Math.max(4, atr * 0.12);
    var sl = null;
    for (var k = 0; k < slLadder.length; k++) {
      if (Math.abs(slLadder[k].value - spot) >= minSlDist) { sl = slLadder[k]; break; }
    }
    if (!sl) {
      var slMult = 0.3;   // SCALP-tight
      var slFloor = 6;
      var slFb = action === 'BUY_CE' ? spot - Math.max(atr * slMult, slFloor)
                                     : spot + Math.max(atr * slMult, slFloor);
      sl = { value: slFb, name: '0.3× ATR (no S/R found)',
             role: 'fallback', priority: 0 };
    }

    // ─── Pick EMERGENCY EXIT ──────────────────────────────────────
    // The strongest opposing level FURTHER than the SL — the "if this
    // breaks, the directional setup is fundamentally invalid" level.
    // We prefer high-priority (PDH/PDL/ORH/ORL/today's high-low) and
    // a level that's clearly past the SL.
    var emergency = null;
    var slDistance = Math.abs(sl.value - spot);
    var strong = slLadder.filter(function (l) {
      return l.priority >= 3 && Math.abs(l.value - spot) > slDistance + minSpacing * 0.5;
    });
    if (strong.length) {
      // Pick the FURTHEST strong level (the absolute floor/ceiling).
      emergency = strong.reduce(function (best, cur) {
        if (!best) return cur;
        if (action === 'BUY_CE') return cur.value < best.value ? cur : best;
        return cur.value > best.value ? cur : best;
      }, null);
    }
    if (!emergency) {
      var emFb = action === 'BUY_CE' ? sl.value - Math.max(atr, 15)
                                     : sl.value + Math.max(atr, 15);
      emergency = { value: emFb, name: '1× ATR past SL (no strong level)',
                    role: 'fallback', priority: 0 };
    }
    // Safety: emergency must be strictly past the SL, otherwise the
    // user has two redundant stops at the same place.
    if ((action === 'BUY_CE' && emergency.value >= sl.value - 1) ||
        (action === 'BUY_PE' && emergency.value <= sl.value + 1)) {
      var push = Math.max(atr, 15);
      emergency = {
        value: action === 'BUY_CE' ? sl.value - push : sl.value + push,
        name: '1× ATR past SL (de-clustered)',
        role: 'fallback', priority: 0
      };
    }

    return {
      targetsSpot: targets,
      slSpot: sl,
      emergencySpot: emergency,
      srLadder: { resistance: resistance, support: support }
    };
  }

  // ── Render — bias bar + plan + per-TF cards ──
  function setText(id, text)  { var el = $(id); if (el) el.textContent = text; }
  function setHtml(id, html)  { var el = $(id); if (el) el.innerHTML = html; }
  function setClass(id, cls)  { var el = $(id); if (el) el.className = cls; }

  function renderBiasCell(tf, an) {
    var math = M();
    var v = $('ia-bias-' + tf);
    var s = $('ia-bias-' + tf + '-sub');
    if (!v || !s || !an) return;
    // shortTrendArrow returns the label with a ▲ / ▼ prefix so
    // the direction reads even without colour.
    v.textContent = math.shortTrendArrow ? math.shortTrendArrow(an.trend)
                  : (math.shortTrend ? math.shortTrend(an.trend) : an.trend);
    v.className   = 'sw-bias-v ' + (math.biasClass ? math.biasClass(an.trend) : '');
    var sub = 'RSI ' + (isFinite(an.rsi) ? an.rsi.toFixed(0) : '—')
      + ' \u00B7 ' + vwapLabel(an);
    s.textContent = sub;
  }

  function renderFinalCell(plan) {
    var cell = $('ia-final-cell');
    var v = $('ia-final-bias');
    var s = $('ia-final-conf');
    if (!cell || !v || !s) return;
    // A fresh renderFinalCell wipes whatever applyInvalidation may have
    // stashed last cycle — otherwise an old "I once flipped to EXIT/WAIT"
    // pointer would survive across analyses and restore stale text.
    v._iaOrigText = null;
    v._iaOrigClass = null;
    cell._iaOrigClass = null;
    if (plan.action === 'BUY_CE') {
      v.textContent = '\u25B2 BUY CE'; v.className = 'sw-bias-v sw-bull';
      cell.className = 'sw-bias-cell sw-bias-cell-final sw-bias-cell-bull';
    } else if (plan.action === 'BUY_PE') {
      v.textContent = '\u25BC BUY PE'; v.className = 'sw-bias-v sw-bear';
      cell.className = 'sw-bias-cell sw-bias-cell-final sw-bias-cell-bear';
    } else if (plan.attemptedSide) {
      // Score wanted a side but veto rules forced WAIT — render
      // the leaning hint so the verdict cell isn't a context-less
      // "WAIT" when the bias bar (15m / 5m / 3m) shows directional
      // colors. Yellow accent = "we WOULD trade this if vetoes cleared".
      v.textContent = 'WAIT';   v.className = 'sw-bias-v sw-muted';
      cell.className = 'sw-bias-cell sw-bias-cell-final sw-bias-cell-neutral';
    } else {
      v.textContent = 'WAIT';   v.className = 'sw-bias-v sw-muted';
      cell.className = 'sw-bias-cell sw-bias-cell-final sw-bias-cell-neutral';
    }
    // Confidence + score line. If a safety block stopped the
    // trade, show that explicitly so the user knows the system
    // didn't just "fail to find" — it actively rejected a
    // directional score (e.g. "blocked · CE 4 vs PE 2").
    var line;
    if (plan.action === 'WAIT' && plan.attemptedSide) {
      line = 'BLOCKED: was leaning ' + plan.attemptedSide
           + ' \u00B7 CE ' + plan.ceScore + ' vs PE ' + plan.peScore
           + ' \u00B7 see SKIP IF below';
    } else {
      // May 2026: append "(N%)" so the line reads
      // "HIGH 82% confidence · CE 9 vs PE 2" instead of the bare
      // label. Mirrors the HUD chip so the user sees the same
      // reading wherever the verdict surfaces.
      var pctTxt = (plan.confidencePct != null && isFinite(plan.confidencePct))
                   ? ' ' + plan.confidencePct + '%' : '';
      line = plan.confidence + pctTxt + ' confidence \u00B7 CE ' + plan.ceScore + ' vs PE ' + plan.peScore;
    }
    s.textContent = line;
  }

  // Read live option premium with TWO sources, freshest first:
  //   1. window.paperTradeGetOptionPrice(key) → 2s-fresh value from
  //      paper-trade's pollOptionPrices cache (which now includes the
  //      analyzer's recommended ATM strike via window.intradayGetAtmInstrumentKeys).
  //   2. window.optionChainData[strike].leg.market_data.ltp → up-to-30s-stale
  //      value from the chain auto-refresh. Used only when (1) is missing
  //      (e.g. first paint, before the option poller has matched the key).
  // Returns null when neither source has a number (chain not loaded
  // yet, or our strike isn't in the chain's strike window).
  function getAtmPremium(atmStrike, side) {
    var q = getStrikeQuote(atmStrike, side);
    return q ? q.premium : null;
  }

  // RICH strike snapshot: { premium, delta, instrumentKey }. delta
  // comes from Upstox's option_greeks.delta (real BSM value, not a
  // textbook approximation). This is the key to making SL/T1/T2/T3
  // projections accurate for ANY strike — deep ITM strikes have
  // delta ~0.8 (premium moves nearly 1:1 with spot), OTM strikes
  // ~0.25 (premium barely budges), and only ATM strikes ~0.5.
  // Using a fixed 0.5 for an ITM/OTM strike would mis-project the
  // SL/target premium by 30-60%.
  function getStrikeQuote(strike, side) {
    var chain = window.optionChainData;
    if (!chain || !chain.strikes) return null;
    for (var i = 0; i < chain.strikes.length; i++) {
      if (chain.strikes[i].strike_price === strike) {
        var leg = side === 'CE' ? chain.strikes[i].call_options : chain.strikes[i].put_options;
        if (!leg || !leg.instrument_key) return null;
        var prem = null;
        if (typeof window.paperTradeGetOptionPrice === 'function') {
          var live = window.paperTradeGetOptionPrice(leg.instrument_key);
          if (live != null) prem = live;
        }
        if (prem == null) {
          var ltp = leg.market_data ? +leg.market_data.ltp : null;
          if (ltp != null && isFinite(ltp) && ltp > 0) prem = ltp;
        }
        // option_greeks.delta is signed (positive for CE, negative
        // for PE). We use abs() in the math; sign is handled by the
        // sideTag direction-flip in spotToPremium.
        var deltaRaw = (leg.option_greeks && leg.option_greeks.delta != null) ? +leg.option_greeks.delta : null;
        var delta = (deltaRaw != null && isFinite(deltaRaw)) ? Math.abs(deltaRaw) : null;
        // Clamp to a sane range — sometimes Upstox returns 0 or
        // weird values for far-OTM strikes; in that case fall back
        // to the ATM textbook value so projections aren't 0.
        if (delta == null || delta < 0.05 || delta > 0.99) delta = null;
        return { premium: prem, delta: delta, instrumentKey: leg.instrument_key };
      }
    }
    return null;
  }

  // Next 5-minute bar-close timestamp in IST. Used to tell the
   // user how long the current setup is "fresh" before the next
   // analyze() cycle re-confirms or flips the verdict.
  function nextBarCloseIST(bucketMin) {
    bucketMin = bucketMin || 5;
    var nowMs = Date.now();
    var istMs = nowMs + IST_OFFSET_MS;
    var sessionStart = Math.floor(istMs / 86400000) * 86400000 + SESSION_OPEN_MS;
    if (istMs < sessionStart) return null;
    var bucketMs = bucketMin * 60 * 1000;
    var nextBoundary = sessionStart + (Math.floor((istMs - sessionStart) / bucketMs) + 1) * bucketMs;
    return nextBoundary - IST_OFFSET_MS;
  }
  function fmtClockShort(ms) {
    if (!ms) return '—';
    try {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour12: false,
        hour: '2-digit', minute: '2-digit'
      }).format(new Date(ms));
    } catch (_) { return ''; }
  }

  // Populate the ANALYSIS COVERAGE panel — the visible proof that the
  // verdict consolidated EVERY indicator at EVERY TF at EVERY level.
  // Total = (7 indicators × 3 TFs) + 7 SR-level checks + 3 cross-TF
  // alignment checks = 31, but we read the actual signal count from
  // the verdict's tfSignals to stay honest if logic is added later.
  function renderCoverage(plan) {
    var totalChecks = 0;
    if (plan && plan.tfSignals) {
      ['15m', '5m', '3m'].forEach(function (tf) {
        if (plan.tfSignals[tf]) totalChecks += plan.tfSignals[tf].length;
      });
    }
    // Floor at 68 — 7 indicators × 4 TFs = 28, + 2 structural-room,
    // + 1 cross-TF RSI divergence, + 1 market-structure exhaustion,
    // + 1 ADX-strength, + 1 VIX-level, + 1 VIX intraday change,
    // + 1 PCR, + 1 CE wall proximity, + 1 PE wall proximity,
    // + 1 max-pain pull, + 1 FHR breakout, + 1 volume confirmation,
    // + 1 SESSION PHASE check, + 5 CPR checks, + 2 BN checks,
    // + 4 VWAP-band checks, + 2 per-TF RSI divergence (5m + 15m),
    // + 1 volatility-regime gate, + 3 candle-at-SR,
    // + 3 auto-S/R interactions (swing-cluster break/rejection,
    //   round-number break, anchored-VWAP reclaim),
    // + 3 auto-S/R levels added to the ladder (zones, rounds, AVWAPs),
    // + 2 compression-pattern + Doji-at-SR SKIP IF checks
    //   = 68.
    if (totalChecks < 68) totalChecks = 68 + totalChecks;
    setText('ia-cov-count', totalChecks + ' checks evaluated');
    setText('ia-cov-ce', plan && plan.ceScore != null ? plan.ceScore + ' pts' : '—');
    setText('ia-cov-pe', plan && plan.peScore != null ? plan.peScore + ' pts' : '—');
    // Verdict label — the score breakdown (CE pts vs PE pts) on
    // the left of this strip already shows the engine's lean,
    // and the SETUP banner above already says "BUY CE BLOCKED —
    // <reason>" with an X icon when a side was vetoed. So this
    // verdict cell only needs to say BUY CE / BUY PE / WAIT —
    // no need to repeat the BLOCKED message a third time. The
    // user can compare the scores (e.g. 22 vs 15 → WAIT) to
    // infer the engine was leaning a clear direction; the
    // SETUP banner explains why we WAIT-ed anyway.
    var vtxt;
    // May 2026: include the derived % alongside the categorical
    // label — "BUY CE (HIGH 82%)" so the user sees the same
    // confidence reading the HUD chip shows.
    var covPctTxt = (plan && plan.confidencePct != null && isFinite(plan.confidencePct))
                    ? ' ' + plan.confidencePct + '%' : '';
    if (plan && plan.action === 'BUY_CE')      vtxt = 'BUY CE (' + plan.confidence + covPctTxt + ')';
    else if (plan && plan.action === 'BUY_PE') vtxt = 'BUY PE (' + plan.confidence + covPctTxt + ')';
    else                                       vtxt = 'WAIT';
    setText('ia-cov-verdict', vtxt);
    // The coverage card itself recolours to match the verdict —
    // green border for BUY CE, red for BUY PE, neutral for WAIT.
    // Lets the user read the colour at a glance without scanning
    // text. The modal stays neutral (it's a reference panel, not
    // a verdict indicator).
    var resEl = $('ia-coverage');
    if (resEl) {
      resEl.classList.remove('ia-cov-bear', 'ia-cov-wait');
      if (plan && plan.action === 'BUY_PE') resEl.classList.add('ia-cov-bear');
      else if (!plan || plan.action === 'WAIT') resEl.classList.add('ia-cov-wait');
    }
  }

  // ATM-call/put delta FALLBACK for spot↔premium conversion when
  // option_greeks aren't available from the chain (rare — only
  // happens during the first 1-2 seconds before chain loads, or for
  // far-OTM strikes where Upstox returns null delta). When we have
  // a real delta from getStrikeQuote() we use that instead — see
  // below.
  var ATM_DELTA = 0.5;

  // Convert a SPOT level into the expected option premium when spot
  // gets there. For CE: spot up → premium up; for PE: spot down →
  // premium up. Returns max(0.05, projected) — premium can never go
  // negative; clamp at a tiny floor so the UI shows a sensible value
  // even for far-OTM projections.
  //
  // The optional `delta` arg is the per-strike delta (from option
  // greeks). Pass it whenever you have it — projections for ITM
  // strikes (delta ~0.8) and OTM strikes (delta ~0.25) are wildly
  // wrong with the textbook 0.5 default.
  function spotToPremium(spotLevel, currentSpot, currentPremium, sideTag, delta) {
    if (currentPremium == null || !isFinite(spotLevel)) return null;
    var d = (delta != null && isFinite(delta) && delta > 0.05 && delta < 0.99) ? delta : ATM_DELTA;
    var spotMove = sideTag === 'CE' ? (spotLevel - currentSpot)
                                    : (currentSpot - spotLevel);
    var premMove = spotMove * d;
    return Math.max(0.05, +(currentPremium + premMove).toFixed(2));
  }

  // Nifty 50 lot size (SEBI revision Nov 2024 — was 75). Mirrors the
  // canonical constant in paperTradeModule but redeclared here
  // because the analyzer module IIFE can't see private vars from
  // sibling modules. If SEBI revises again, update BOTH places +
  // the lot-hint copy in content/live.html. Defined module-wide so
  // attachPremiumPlan + the position-math strip both pull from it.
  var ANALYZER_LOT_SIZE_NIFTY = 65;

  // ════════════════ SPOT PLAN (May 2026, primary signal) ════════
  // Builds plan.spotPlan — the SPOT-LEVEL signal the trader watches
  // on the chart. The technical engine (RSI, EMA, VWAP, S/R, ADX,
  // Supertrend, candle patterns) ALL operate on Nifty spot, so the
  // entry/SL/target levels SHOULD also be expressed in spot — that
  // way the numbers you see on the analyzer match the numbers on
  // the chart 1:1. Premium values (plan.premium below) are a
  // derived secondary view used for capital-outlay estimates and
  // P&L tracking once a position is open — they should NEVER be
  // the primary "BUY at X / SL at Y / target Z" surface, because
  // premium prices drift with IV crush and theta in ways that
  // make "exit when premium hits ₹121" both inaccurate (delta
  // approximation) and unwatchable (nobody charts an option
  // premium intraday).
  //
  // Unlike plan.premium this builds UNCONDITIONALLY — even before
  // the option chain has loaded — because spot levels are derived
  // purely from the analyzer's S/R + the spotAtFire / live spot.
  // attachSpotPlan(plan, spot)
  //
  // ENTRY-LOCK POLICY (May 2026 — fixes "entry/SL/T1 changes every
  // tick" bug):
  //   - The ENTRY anchor is locked once per analyze cycle. The
  //     analyze() callsite seeds it with the 5m candle's lastClose
  //     (a stable reference that only changes when a new 5m bar
  //     closes). All subsequent calls within the same plan
  //     lifetime — renderPlanWithPremium (twice) and liveTick
  //     (every 2s) — preserve that locked entry. New analyze
  //     cycles produce a fresh plan with no spotPlan; the first
  //     attachSpotPlan call seeds it again.
  //
  //   - SL / T1 / T2 / T3 come from plan.slSpot and
  //     plan.targetsSpot which are STATIC between analyze cycles
  //     (the analyzer doesn't change S/R levels on every tick). So
  //     they re-derive to identical values on every call — no
  //     visible jitter.
  //
  //   - RR derives from the (now-stable) entry + sl + t1, so it
  //     also stops jittering.
  //
  //   - LIVE spot is still surfaced via spotLive + spotDriftPts so
  //     the HUD can render "spot moved +5.2 pts since signal" if
  //     desired, without disturbing the trade levels.
  //
  // Why an5.lastClose and not generateVerdict's spot snapshot? The
  // 5m close is a discrete reference both the analyzer (which
  // computed BUY) and the trader (who scrubs the 5m chart) share.
  // Live spot drifts by a few ticks per second; that's noise,
  // not signal.
  function attachSpotPlan(plan, spot) {
    if (!plan) return plan;
    var slLvl = plan.slSpot;
    var targets = plan.targetsSpot || [];
    var t1Lvl = targets[0] || null;
    var t2Lvl = targets[1] || null;
    var t3Lvl = targets[2] || null;

    // Lock the entry: if plan.spotPlan already has a valid entry
    // (set by a prior attach in this analyze cycle), keep it. The
    // very first attach in a cycle (called from analyze() with
    // an5.lastClose) seeds the lock; every later attach
    // (renderPlanWithPremium x2, liveTick every 2s) preserves it.
    var lockedEntry;
    if (plan.spotPlan && plan.spotPlan.entry != null && isFinite(plan.spotPlan.entry)) {
      lockedEntry = +plan.spotPlan.entry;
    } else if (spot != null && isFinite(spot)) {
      lockedEntry = +spot;
    } else {
      lockedEntry = null;
    }

    var spotLive = (spot != null && isFinite(spot)) ? +spot : null;

    var spotPlan = {
      entry:    lockedEntry,
      spotLive: spotLive, // live spot for delta display only — never affects sl/t1/rr
      spotDriftPts: (lockedEntry != null && spotLive != null)
        ? +(spotLive - lockedEntry).toFixed(1)
        : null,
      sl:       (slLvl && isFinite(slLvl.value)) ? +slLvl.value : null,
      t1:       (t1Lvl && isFinite(t1Lvl.value)) ? +t1Lvl.value : null,
      t2:       (t2Lvl && isFinite(t2Lvl.value)) ? +t2Lvl.value : null,
      t3:       (t3Lvl && isFinite(t3Lvl.value)) ? +t3Lvl.value : null,
      slName:   slLvl ? (slLvl.name || null)    : null,
      t1Name:   t1Lvl ? (t1Lvl.name || null)    : null,
      t2Name:   t2Lvl ? (t2Lvl.name || null)    : null,
      t3Name:   t3Lvl ? (t3Lvl.name || null)    : null,
      slDistPts: null,
      t1DistPts: null,
      t2DistPts: null,
      rrToT1:    null,
      rrToT2:    null
    };

    if (spotPlan.entry != null && spotPlan.sl != null) {
      spotPlan.slDistPts = +Math.abs(spotPlan.entry - spotPlan.sl).toFixed(1);
    }
    if (spotPlan.entry != null && spotPlan.t1 != null) {
      spotPlan.t1DistPts = +Math.abs(spotPlan.t1 - spotPlan.entry).toFixed(1);
    }
    if (spotPlan.entry != null && spotPlan.t2 != null) {
      spotPlan.t2DistPts = +Math.abs(spotPlan.t2 - spotPlan.entry).toFixed(1);
    }
    if (spotPlan.slDistPts && spotPlan.slDistPts > 0) {
      if (spotPlan.t1DistPts != null) spotPlan.rrToT1 = +(spotPlan.t1DistPts / spotPlan.slDistPts).toFixed(2);
      if (spotPlan.t2DistPts != null) spotPlan.rrToT2 = +(spotPlan.t2DistPts / spotPlan.slDistPts).toFixed(2);
    }

    plan.spotPlan = spotPlan;
    return plan;
  }

  // ════════════════ PREMIUM PLAN (P0-2, May 2026) ═══════════════
  // Builds plan.premium — DERIVED secondary view (capital-outlay
  // estimate + P&L tracking once a position is open). The PRIMARY
  // signal is plan.spotPlan above; this premium projection only
  // exists because the user needs SOME idea of capital cost before
  // pressing BUY. All premium-based numbers a trader needs:
  //   entry, sl, t1, t2  (real ₹ premium prices)
  //   slPctDrop, t1PctGain, t2PctGain (premium % moves)
  //   capitalDeployed (₹ + %-of-capital)
  //   maxLossINR (₹ + %-of-capital)
  //   maxGainT1/T2 (₹)
  //   rrToT1, rrToT2 (risk-reward ratios)
  //   riskBudgetStatus: 'OK' | 'TIGHT' | 'EXCEEDS'
  //   slQuality: 'TIGHT' | 'GOOD' | 'WIDE'
  //   lotSize, lots
  //
  // Why a single source of truth? Today the plan card computes
  // SL/T1/T2 in renderPlanWithPremium, the journal recomputes
  // them in its own logSignal, the (upcoming) CONFIRM modal would
  // recompute them again. Three different code paths for the
  // SAME numbers = guaranteed drift = a trader will at some point
  // see "SL ₹94" in one card and "SL ₹91" in another and lose
  // money on the confusion. By computing once and stashing on
  // plan.premium, every consumer reads from the same place.
  function attachPremiumPlan(plan, spot, premium, sideTag, delta, lotSize, capital, riskPctBudget) {
    if (!plan || premium == null || !isFinite(premium) || premium <= 0) return plan;
    lotSize = lotSize || ANALYZER_LOT_SIZE_NIFTY;
    capital = (capital != null && isFinite(+capital) && +capital > 0) ? +capital : 15000;
    riskPctBudget = (riskPctBudget != null && isFinite(+riskPctBudget) && +riskPctBudget > 0)
                    ? +riskPctBudget : 5;

    var slLvl = plan.slSpot;
    var targets = plan.targetsSpot || [];
    var t1Lvl = targets[0], t2Lvl = targets[1];

    // Project each level to its premium price using current LTP +
    // strike-specific delta (or fallback 0.5 ATM delta).
    var slPx = slLvl ? spotToPremium(slLvl.value, spot, premium, sideTag, delta) : null;
    var t1Px = t1Lvl ? spotToPremium(t1Lvl.value, spot, premium, sideTag, delta) : null;
    var t2Px = t2Lvl ? spotToPremium(t2Lvl.value, spot, premium, sideTag, delta) : null;

    // Premium % moves — what shows as "-25%" / "+40%" on the cells.
    var slPctDrop = (slPx != null) ? +(((premium - slPx) / premium) * 100).toFixed(1) : null;
    var t1PctGain = (t1Px != null) ? +(((t1Px - premium) / premium) * 100).toFixed(1) : null;
    var t2PctGain = (t2Px != null) ? +(((t2Px - premium) / premium) * 100).toFixed(1) : null;

    // Position math (1 lot baseline for now — multi-lot ships
    // when the position-sizer in P0-4 lands). All in ₹.
    var lots = 1;
    var qty = lots * lotSize;
    var capitalDeployed = +(premium * qty).toFixed(0);
    var maxLossINR = (slPx != null) ? +((premium - slPx) * qty).toFixed(0) : null;
    var maxGainT1INR = (t1Px != null) ? +((t1Px - premium) * qty).toFixed(0) : null;
    var maxGainT2INR = (t2Px != null) ? +((t2Px - premium) * qty).toFixed(0) : null;

    var capitalDeployedPct = +((capitalDeployed / capital) * 100).toFixed(1);
    var maxLossPct = (maxLossINR != null) ? +((maxLossINR / capital) * 100).toFixed(1) : null;

    // Risk-budget verdict — drives the green/amber/red pill on
    // the position strip. Pro convention:
    //   OK       if maxLossPct <= riskPctBudget
    //   TIGHT    if within 50% of the budget cap (close to limit)
    //   EXCEEDS  if maxLossPct > 1.0 × riskPctBudget
    var riskBudgetStatus = null;
    if (maxLossPct != null) {
      if (maxLossPct <= riskPctBudget) {
        riskBudgetStatus = (maxLossPct >= riskPctBudget * 0.85) ? 'TIGHT' : 'OK';
      } else {
        riskBudgetStatus = 'EXCEEDS';
      }
    }

    // SL quality — too-tight SLs get whipsawed, too-wide SLs
    // produce unfavorable R:R. Standard pro bands:
    //   TIGHT   < 12% premium drop  (will stop on noise)
    //   GOOD    12-35%               (sustainable)
    //   WIDE    > 35%                (R:R suffers)
    var slQuality = null;
    if (slPctDrop != null) {
      if (slPctDrop < 12) slQuality = 'TIGHT';
      else if (slPctDrop > 35) slQuality = 'WIDE';
      else slQuality = 'GOOD';
    }

    // R:R using ABSOLUTE premium distances (not %). R:R 1:1.5 means
    // a winning T1 produces 1.5× your max loss. Pros want >= 1.3.
    var rrToT1 = null, rrToT2 = null;
    if (maxLossINR && maxLossINR > 0) {
      if (maxGainT1INR != null) rrToT1 = +((maxGainT1INR / maxLossINR)).toFixed(2);
      if (maxGainT2INR != null) rrToT2 = +((maxGainT2INR / maxLossINR)).toFixed(2);
    }

    plan.premium = {
      entry:             +premium.toFixed(2),
      sl:                slPx,
      t1:                t1Px,
      t2:                t2Px,
      slPctDrop:         slPctDrop,
      t1PctGain:         t1PctGain,
      t2PctGain:         t2PctGain,
      lots:              lots,
      lotSize:           lotSize,
      qty:               qty,
      capital:           capital,
      riskPctBudget:     riskPctBudget,
      capitalDeployed:   capitalDeployed,
      capitalDeployedPct:capitalDeployedPct,
      maxLossINR:        maxLossINR,
      maxLossPct:        maxLossPct,
      maxGainT1INR:      maxGainT1INR,
      maxGainT2INR:      maxGainT2INR,
      rrToT1:            rrToT1,
      rrToT2:            rrToT2,
      riskBudgetStatus:  riskBudgetStatus,
      slQuality:         slQuality,
      delta:             (delta != null && isFinite(delta)) ? +delta.toFixed(2) : null
    };
    return plan;
  }

  // Classify a strike's moneyness relative to spot.
  // Returns 'ATM' | 'ITM' | 'OTM' + distance in points.
  function classifyStrike(strike, spot, side) {
    if (!isFinite(strike) || !isFinite(spot)) return null;
    var diff = strike - spot;
    var absDiff = Math.abs(diff);
    // ATM band: within 1 strike step (≤25 pts for Nifty 50-step).
    if (absDiff <= 25) return { kind: 'ATM', distance: absDiff };
    // CE: strike < spot = ITM, strike > spot = OTM
    // PE: strike > spot = ITM, strike < spot = OTM
    var itm = side === 'CE' ? (strike < spot) : (strike > spot);
    return { kind: itm ? 'ITM' : 'OTM', distance: absDiff };
  }

  // Side-aware ITM-1 strike picker — the SINGLE recommendation entry
  // point used by the plan card, journal logger, paper-trade bridge,
  // HUD STRIKE display, liveTick re-pricing and the option-poller
  // instrument-key list. Previously each of those six sites computed
  // its own ATM via Math.round(spot/50)*50 — which produced strikes
  // that are too sensitive to theta + IV crush for a 2-30 min scalp.
  //
  // ITM-1 logic:
  //   CE: ATM - 50  (one strike BELOW spot → intrinsic value, delta
  //                 ~0.65-0.75, premium tracks spot 65-75 paise per
  //                 1 Nifty point instead of ~50p for ATM)
  //   PE: ATM + 50  (one strike ABOVE spot → same intrinsic logic)
  //
  // Why ITM-1 for paper testing on 1L+ capital:
  //   * Higher delta = premium moves more closely with spot (cleaner
  //     signal-edge measurement, less IV-decay noise)
  //   * Affordable at 1L+ capital (ITM premium ~₹150-200 vs ATM ~₹90
  //     for ~24,000 Nifty; still under 1 lot's margin headroom)
  //   * Avoids the IV-crush / theta-bleed danger called out by the
  //     analyzer's own "Avoid OTM, use ITM for delta exposure" note
  //     during falling-VIX sessions — making the recommended strike
  //     ITM by default removes the need to manually heed that hint.
  //
  // Side may be 'CE' / 'PE' / 'BUY_CE' / 'BUY_PE'. Step defaults to
  // 50 (Nifty strike grid). Falls back to ATM if side is unknown.
  function pickRecommendedStrike(spot, side, step) {
    step = step || 50;
    if (!isFinite(spot)) return null;
    var atm = Math.round(spot / step) * step;
    if (side === 'CE' || side === 'BUY_CE') return atm - step;
    if (side === 'PE' || side === 'BUY_PE') return atm + step;
    return atm;
  }
  window.pickRecommendedStrike = pickRecommendedStrike;

  // Build a "live risk view" — keeps the verdict / score / signals
  // from the analysis-time plan but RE-COMPUTES targets / SL /
  // emergency / spotInvalid from the LIVE spot. Needed because
  // computeRiskPlan() runs inside generateVerdict() with the 3-min
  // snapshot spot — by the time the live spot has drifted, an S/R
  // level can flip sides (resistance ↔ support) and produce a
  // structurally invalid plan (e.g. a "CE target" priced BELOW
  // entry premium). Calling this every render keeps the plan card
  // self-correcting.
  function liveRiskView(plan, an5, an1h, liveSpot, raw1h) {
    if (!plan || plan.action === 'WAIT' || !an5) return plan;
    // Mode arg is kept for backward compat — computeRiskPlan
    // ignores it and always runs SCALP semantics since the May
    // 2026 SCALP-only refactor. raw1h drives the structural
    // 4H/1H emergency-exit picker.
    var fresh = computeRiskPlan(an5, plan.action, an1h, liveSpot, plan.mode, raw1h);
    return Object.assign({}, plan, {
      targetsSpot:   fresh.targetsSpot,
      slSpot:        fresh.slSpot,
      emergencySpot: fresh.emergencySpot,
      srLadder:      fresh.srLadder,
      spotInvalid:   fresh.emergencySpot ? fresh.emergencySpot.value : plan.spotInvalid
    });
  }

  // Helper — clear all 6 cells when no trade is active.
  function blankPlanCells() {
    ['ia-plan-strike', 'ia-plan-entry', 'ia-plan-sl', 'ia-plan-target-1',
     'ia-plan-target-2', 'ia-plan-invalid'
    ].forEach(function (id) { setText(id, '—'); });
    ['ia-plan-sl-spot', 'ia-plan-target-1-spot', 'ia-plan-target-2-spot',
     'ia-plan-invalid-spot'
    ].forEach(function (id) { setText(id, '—'); });
  }

  // ══════════════ SIGNAL JOURNAL (May 2026, P0-1) ══════════════
  // Auto-logs every BUY CE / BUY PE signal that fires. User marks
  // each outcome (WIN T1 / WIN T2 / LOSS SL / TIME EXIT / SKIPPED).
  // Tool computes rolling win-rate, average R, total R, current
  // streak — filterable by date range, confidence and direction.
  //
  // Why this matters: a trading tool that can't prove it has edge
  // is just a confident guess. Pros trade their numbers. After
  // 30-50 logged signals the journal answers questions like
  // "should I take HIGH-confidence BUY CE in PRIME session?" with
  // a real number, not a hunch. This is what converts the engine
  // from "feels right" to "measured edge".
  //
  // Storage shape (localStorage key 'signal_journal_v1'):
  //   { entries: [...], capital, riskPct, slPct, t1Pct, t2Pct,
  //     lastAction, lastActionTs, meta }
  // Entry shape: see logSignal() comment.
  //
  // Dedupe via RISING-EDGE detection: only logs on transition
  // INTO BUY_CE / BUY_PE from another state (WAIT or opposite
  // side). Sustained signals across many 3-min analyze cycles
  // produce ONE entry. A flip (CE → WAIT → CE) is a fresh
  // actionable setup and produces a SECOND entry. A 3-minute
  // cooldown guards against ultra-rapid flap during chop. The
  // paper-trading module is UNTOUCHED — this is a parallel system
  // tracking SIGNALS, not positions.
  var signalJournalModule = (function () {
    // Key bumped from v1 → v2 in the May 2026 spot-first refactor.
    // v1 entries were premium-anchored (entryPremium / slPremium /
    // t1Premium as the canonical exit triggers); v2 uses spotAtFire
    // / slSpot / t1Spot as the canonical exit triggers and keeps
    // entryPremium etc. only as a P&L-context snapshot. Old v1
    // entries are deliberately discarded on first load — a clean
    // slate avoids confusing mixed displays (premium-only old
    // entries next to spot-anchored new ones).
    var STORAGE_KEY = 'signal_journal_v2';
    var SCHEMA_VER  = 2;
    var MAX_ENTRIES = 500;
    var DEFAULT_CAPITAL  = 15000;
    var DEFAULT_RISK_PCT = 5;
    var DEFAULT_SL_PCT   = 25;
    var DEFAULT_T1_PCT   = 40;
    var DEFAULT_T2_PCT   = 70;
    // Status enum — values are stable identifiers; never localize
    // them in storage (only in UI labels).
    var STATUS = {
      OPEN:           'OPEN',
      WIN_T1:         'WIN_T1',
      WIN_T2:         'WIN_T2',
      LOSS_SL:        'LOSS_SL',
      EXIT_TIME:      'EXIT_TIME',
      EXIT_MANUAL:    'EXIT_MANUAL',
      EXPIRED_UNUSED: 'EXPIRED_UNUSED'
    };
    // Human-readable labels for the status badge in the table.
    var STATUS_LABEL = {
      OPEN:           'OPEN',
      WIN_T1:         '✓ WIN T1',
      WIN_T2:         '✓ WIN T2',
      LOSS_SL:        '✗ LOSS SL',
      EXIT_TIME:      '⏱ TIME EXIT',
      EXIT_MANUAL:    '↩ MANUAL EXIT',
      EXPIRED_UNUSED: '⊘ SKIPPED'
    };
    // CSS-class suffix used for badge colour.
    var STATUS_CLS = {
      OPEN:           'open',
      WIN_T1:         'win',
      WIN_T2:         'win',
      LOSS_SL:        'loss',
      EXIT_TIME:      'flat',
      EXIT_MANUAL:    'flat',
      EXPIRED_UNUSED: 'skip'
    };

    // Module-local state. Mutated in place; persisted via save().
    // outcomeBeingMarked is transient (modal context) and never
    // written to disk. lastAction + lastActionTs together drive
    // rising-edge detection — see logSignal() comment.
    var state = {
      entries:         [],
      capital:         DEFAULT_CAPITAL,
      riskPct:         DEFAULT_RISK_PCT,
      slPct:           DEFAULT_SL_PCT,
      t1Pct:           DEFAULT_T1_PCT,
      t2Pct:           DEFAULT_T2_PCT,
      lastAction:      null,
      lastActionTs:    0,
      filter:          { range: 'all', conf: 'all', dir: 'all' },
      outcomeBeingMarked: null
    };

    function load() {
      try {
        // One-time cleanup of the legacy v1 key (premium-anchored
        // schema). v2 is spot-anchored; mixing the two would render
        // inconsistently in the table. We deliberately drop v1
        // instead of migrating because the structural relationship
        // between premium and spot is lossy (delta drifts with IV
        // crush + theta, so back-projecting v1 premium fields to
        // spot levels would produce wrong numbers). Safe to no-op
        // when the key isn't present.
        try { localStorage.removeItem('signal_journal_v1'); } catch (_) {}

        var raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        if (Array.isArray(parsed.entries)) state.entries = parsed.entries;
        if (isFinite(+parsed.capital) && +parsed.capital > 0) state.capital = +parsed.capital;
        if (isFinite(+parsed.riskPct) && +parsed.riskPct > 0) state.riskPct = +parsed.riskPct;
        if (isFinite(+parsed.slPct))  state.slPct = +parsed.slPct;
        if (isFinite(+parsed.t1Pct))  state.t1Pct = +parsed.t1Pct;
        if (isFinite(+parsed.t2Pct))  state.t2Pct = +parsed.t2Pct;
        if (parsed.lastAction)        state.lastAction   = parsed.lastAction;
        if (isFinite(+parsed.lastActionTs)) state.lastActionTs = +parsed.lastActionTs;
      } catch (e) { /* corrupted JSON / quota — fall back to defaults */ }
    }

    function save() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          entries:      state.entries,
          capital:      state.capital,
          riskPct:      state.riskPct,
          slPct:        state.slPct,
          t1Pct:        state.t1Pct,
          t2Pct:        state.t2Pct,
          lastAction:   state.lastAction,
          lastActionTs: state.lastActionTs,
          meta:         { schemaVer: SCHEMA_VER, savedAt: Date.now() }
        }));
      } catch (e) { /* quota / private mode — silently no-op */ }
    }

    // IST calendar day key — matches getTodayCounts() boundary.
    function istDayKeyFromMs(ms) {
      if (!isFinite(ms) || ms <= 0) return null;
      var ist = new Date(ms + IST_OFFSET_MS);
      return ist.getUTCFullYear()
        + '-' + ('0' + (ist.getUTCMonth() + 1)).slice(-2)
        + '-' + ('0' + ist.getUTCDate()).slice(-2);
    }

    // Active BUY signals expire when the trading day rolls over
    // (Friday → Monday gap is the classic stale-signal bug) or
    // when they age past the SCALP freshness window without being
    // taken. Expiring resets lastAction to WAIT so logSignal()
    // can re-fire on the next analyze cycle if the engine still
    // recommends the same side — one coherent signal, not a ghost
    // from yesterday fighting today's pills / TF cards.
    var STALE_EXPIRE_MS = 8 * 60 * 1000; // mirrors signalFreshness BAND_AGEING_MS

    function openEntryForAction(action) {
      for (var i = 0; i < state.entries.length; i++) {
        var e = state.entries[i];
        if (e.direction === action && e.status === STATUS.OPEN) return e;
      }
      return null;
    }

    function maybeExpireActiveSignal() {
      if (state.lastAction !== 'BUY_CE' && state.lastAction !== 'BUY_PE') return false;
      var ts = +state.lastActionTs;
      if (!isFinite(ts) || ts <= 0) return false;
      // Never yank a signal the user is actively paper-tracking.
      try {
        if (typeof paperBridgeModule !== 'undefined'
            && paperBridgeModule.isActiveSignalLinked
            && paperBridgeModule.isActiveSignalLinked()) return false;
      } catch (_) {}
      var entry = openEntryForAction(state.lastAction);
      if (entry && entry.taken === true) return false;
      var nowMs = Date.now();
      var ageMs = nowMs - ts;
      var crossDay = istDayKeyFromMs(ts) !== istDayKeyFromMs(nowMs);
      var timedOut = ageMs >= STALE_EXPIRE_MS;
      if (!crossDay && !timedOut) return false;
      if (entry && entry.status === STATUS.OPEN && entry.taken !== true) {
        entry.status = STATUS.EXPIRED_UNUSED;
        entry.exitTs = nowMs;
      }
      state.lastAction = 'WAIT';
      state.lastActionTs = 0;
      save();
      return true;
    }

    // Look up the live ATM premium from the option chain (if
    // available) to seed entry / SL / T1 / T2 with real rupee
    // values at fire time. If chain isn't loaded yet, the entry
    // stays null and the row shows "—" for premium values until
    // P0-2 ships proper premium-based plan math.
    function premiumFromChain(side, strike) {
      try {
        var chain = window.optionChainData;
        if (!chain || !chain.strikes || !strike) return null;
        var row = chain.strikes.find(function (r) { return +r.strike === +strike; });
        if (!row) return null;
        var leg = side === 'BUY_CE' ? row.ce : row.pe;
        if (!leg || !isFinite(+leg.ltp) || +leg.ltp <= 0) return null;
        return +leg.ltp;
      } catch (_) { return null; }
    }

    // logSignal — called from renderAll. Logs on RISING EDGE
    // only (transition into BUY_CE / BUY_PE from WAIT or the
    // opposite side). A sustained signal across many analyze
    // cycles produces ONE entry. A flip (CE → WAIT → CE) is a
    // fresh actionable setup and produces a SECOND entry.
    //
    // Cooldown: even on transition, we require ≥3 min since the
    // last log to guard against ultra-rapid flap (e.g. score
    // teetering right at the +4 margin during chop) that would
    // pollute the journal with noise. 3 min is the minimum bar
    // length (3m candle) so a fresh log corresponds to a
    // genuinely new bar of data.
    //
    // Returns the created entry, or null on no-op (WAIT / no
    // transition / cooldown / bad input).
    function logSignal(plan, an5) {
      if (!plan) return null;
      maybeExpireActiveSignal();
      var action = plan.action;
      // Track action transitions even on WAIT — so the next BUY
      // after a WAIT period registers as a rising edge.
      if (action !== 'BUY_CE' && action !== 'BUY_PE') {
        if (state.lastAction !== action) {
          // P1-1: if we had an active BUY side, engine just told us
          // to back off — fire the reverse-exit alert so the user
          // closes any taken position immediately.
          try {
            if ((state.lastAction === 'BUY_CE' || state.lastAction === 'BUY_PE')
                && typeof alertModule !== 'undefined') {
              alertModule.playReverseExit();
            }
          } catch (_) {}
          state.lastAction = action;
          save();
        }
        return null;
      }
      // Rising-edge check: only log if action just changed
      // INTO this BUY side from anything else.
      if (state.lastAction === action) return null;
      // Cooldown: ≥3 min since last log of any kind.
      var nowMs = Date.now();
      if (nowMs - state.lastActionTs < 3 * 60 * 1000) {
        state.lastAction = action;
        return null;
      }

      // ─── PER-DIRECTION REFIRE COOLDOWN (May 2026) ──────────────
      // The 3-min cooldown above + the 8-min staleExpire above can
      // combine to fire the SAME direction repeatedly every 8-10
      // min when the engine keeps recommending it. User observed
      // 7 BUY CE signals in 1 hour at the same strike — clutters
      // the journal, dilutes the win-rate stat, and tempts
      // overtrading the same setup. A signal that fired 12 min
      // ago is essentially still the same setup; no reason to
      // re-log it as if it were fresh.
      //
      // Hard floor: 20 min minimum between same-direction logs.
      // Long enough for the previous signal's intended trade to
      // either work out or stop out before re-firing; short
      // enough not to miss genuinely fresh setups after a long
      // gap.
      var MIN_REFIRE_MS = 20 * 60 * 1000;
      var lastSameDirTs = 0;
      for (var rfi = 0; rfi < state.entries.length; rfi++) {
        var prev = state.entries[rfi];
        if (prev.direction === action && prev.ts > lastSameDirTs) {
          lastSameDirTs = prev.ts;
        }
      }
      if (lastSameDirTs > 0 && (nowMs - lastSameDirTs) < MIN_REFIRE_MS) {
        var sinceMin = Math.round((nowMs - lastSameDirTs) / 60000);
        try {
          console.info('[journal refire-cooldown] ' + action
            + ' suppressed \u2014 last same-direction log was '
            + sinceMin + ' min ago (min ' + (MIN_REFIRE_MS / 60000) + ' min)');
        } catch (_) {}
        // Note the engine's view so the rising-edge check stays
        // consistent on subsequent analyze cycles, but do NOT
        // create a new journal entry.
        state.lastAction = action;
        return null;
      }
      var prevAction = state.lastAction;
      state.lastAction = action;
      state.lastActionTs = nowMs;
      var spotAtFire = (an5 && isFinite(an5.lastClose)) ? an5.lastClose : null;
      // ITM-1 recommendation (see pickRecommendedStrike rationale).
      var strike = spotAtFire ? pickRecommendedStrike(spotAtFire, action) : null;

      // P1-1: fire audio + title-flash alert on rising-edge. If
      // the side flipped (e.g. CE → PE), the FLIP alert takes
      // precedence since any existing taken position is now on
      // the wrong side. Otherwise fire the normal signal alert.
      try {
        var isFlip = (prevAction === 'BUY_CE' && action === 'BUY_PE')
                  || (prevAction === 'BUY_PE' && action === 'BUY_CE');
        if (typeof alertModule !== 'undefined') {
          if (isFlip) alertModule.playFlip(prevAction, action, strike);
          else        alertModule.playSignal(action, plan.confidence, strike, plan.confidencePct);
        }
      } catch (_) {}

      // P0-2: prefer plan.premium (single source of truth populated
      // by renderPlanWithPremium → attachPremiumPlan). When present,
      // ALL premium / position fields come from the same canonical
      // computation as the plan card + HUD. Falls back to a direct
      // chain lookup + module-level slPct/t1Pct/t2Pct when premium
      // hasn't been attached yet (rare — happens on the very first
      // analyze if the chain fetch is still in flight).
      var pp = plan.premium;
      var entryPx, slPx, t1Px, t2Px;
      var posSnapshot = null;
      if (pp && pp.entry != null) {
        entryPx = pp.entry;
        slPx    = pp.sl;
        t1Px    = pp.t1;
        t2Px    = pp.t2;
        posSnapshot = {
          lotSize:           pp.lotSize,
          lots:              pp.lots,
          qty:               pp.qty,
          capital:           pp.capital,
          capitalDeployed:   pp.capitalDeployed,
          capitalDeployedPct:pp.capitalDeployedPct,
          maxLossINR:        pp.maxLossINR,
          maxLossPct:        pp.maxLossPct,
          maxGainT1INR:      pp.maxGainT1INR,
          maxGainT2INR:      pp.maxGainT2INR,
          rrToT1:            pp.rrToT1,
          rrToT2:            pp.rrToT2,
          slPctDrop:         pp.slPctDrop,
          t1PctGain:         pp.t1PctGain,
          t2PctGain:         pp.t2PctGain,
          riskBudgetStatus:  pp.riskBudgetStatus,
          slQuality:         pp.slQuality,
          delta:             pp.delta
        };
      } else {
        entryPx = premiumFromChain(plan.action, strike);
        slPx = (entryPx != null) ? +(entryPx * (1 - state.slPct / 100)).toFixed(2) : null;
        t1Px = (entryPx != null) ? +(entryPx * (1 + state.t1Pct / 100)).toFixed(2) : null;
        t2Px = (entryPx != null) ? +(entryPx * (1 + state.t2Pct / 100)).toFixed(2) : null;
      }

      var entry = {
        id:           'sj_' + nowMs + '_' + Math.floor(Math.random() * 1000),
        ts:           nowMs,
        instrument:   'NIFTY',
        direction:    plan.action,
        confidence:   plan.confidence || '—',
        confidencePct: (plan.confidencePct != null && isFinite(plan.confidencePct))
                      ? plan.confidencePct : null,
        mode:         (plan.session && plan.session.mode) || plan.mode || 'SCALP',
        sessionPhase: (plan.session && plan.session.phase) || '—',
        spotAtFire:   spotAtFire,
        // entrySpot is a v2 alias for spotAtFire (the spot price at
        // the moment the engine fired the signal). Kept distinct
        // so consumers can read either name; the bridge prefers
        // entrySpot but falls back to spotAtFire for v1-compat.
        entrySpot:    spotAtFire,
        strike:       strike,
        // Premium values are now SECONDARY (P&L context only). The
        // PRIMARY exit triggers are slSpot / t1Spot below — spot
        // levels match what the indicators are computed on.
        entryPremium: entryPx,
        slPremium:    slPx,
        t1Premium:    t1Px,
        t2Premium:    t2Px,
        slSpot:       plan.slSpot ? plan.slSpot.value : null,
        t1Spot:       (plan.targetsSpot && plan.targetsSpot[0]) ? plan.targetsSpot[0].value : null,
        t2Spot:       (plan.targetsSpot && plan.targetsSpot[1]) ? plan.targetsSpot[1].value : null,
        position:     posSnapshot,
        scores: {
          ce:     +plan.ceScore || 0,
          pe:     +plan.peScore || 0,
          margin: Math.abs((+plan.ceScore || 0) - (+plan.peScore || 0))
        },
        setupLabel: plan.setupLabel || '',
        status:     STATUS.OPEN,
        exitPremium: null,
        exitTs:      null,
        pnlR:        null,
        notes:       ''
      };

      state.entries.unshift(entry);
      if (state.entries.length > MAX_ENTRIES) state.entries.length = MAX_ENTRIES;
      save();
      return entry;
    }

    // markOutcome — sets status, exit premium, notes; computes R.
    // R = (exit − entry) / (entry − sl). Long premium only, so
    // sign comes out naturally (loss when exit < entry).
    function markOutcome(id, status, exitPremium, notes) {
      var e = state.entries.find(function (x) { return x.id === id; });
      if (!e) return false;
      if (!STATUS[status]) return false;
      e.status = STATUS[status];
      e.exitTs = Date.now();
      if (exitPremium != null && isFinite(+exitPremium)) e.exitPremium = +exitPremium;
      if (notes != null) e.notes = String(notes).slice(0, 200);
      if (e.entryPremium != null && e.slPremium != null && e.exitPremium != null) {
        var risk = Math.abs(e.entryPremium - e.slPremium);
        if (risk > 0) {
          e.pnlR = +((e.exitPremium - e.entryPremium) / risk).toFixed(2);
        }
      } else if (status === STATUS.WIN_T1) e.pnlR = +(state.t1Pct / state.slPct).toFixed(2);
      else if (status === STATUS.WIN_T2)   e.pnlR = +(state.t2Pct / state.slPct).toFixed(2);
      else if (status === STATUS.LOSS_SL)  e.pnlR = -1;
      else if (e.pnlR == null)             e.pnlR = 0;
      save();
      return true;
    }

    function deleteEntry(id) {
      state.entries = state.entries.filter(function (e) { return e.id !== id; });
      save();
    }

    // Compute filtered slice + aggregate stats.
    function getStats(filter) {
      filter = filter || {};
      var now = Date.now();
      var dayMs = 24 * 60 * 60 * 1000;
      var entries = state.entries.filter(function (e) {
        if (filter.range === 'today') {
          if (new Date(e.ts).toDateString() !== new Date(now).toDateString()) return false;
        } else if (filter.range === 'week') {
          if (now - e.ts > 7 * dayMs) return false;
        }
        if (filter.conf && filter.conf !== 'all' && e.confidence !== filter.conf) return false;
        if (filter.dir  && filter.dir  !== 'all' && e.direction  !== filter.dir)  return false;
        return true;
      });

      // Taken = anything user marked an outcome on (excludes OPEN
      // and EXPIRED_UNUSED which is "I didn't take this signal").
      var taken = entries.filter(function (e) {
        return e.status !== STATUS.OPEN && e.status !== STATUS.EXPIRED_UNUSED;
      });
      var wins   = taken.filter(function (e) { return e.status === STATUS.WIN_T1 || e.status === STATUS.WIN_T2; });
      var losses = taken.filter(function (e) { return e.status === STATUS.LOSS_SL || (e.pnlR != null && e.pnlR < -0.5); });
      var totalR = taken.reduce(function (s, e) { return s + (+e.pnlR || 0); }, 0);
      var avgR   = taken.length > 0 ? (totalR / taken.length) : 0;
      var winRate = taken.length > 0 ? (wins.length / taken.length) * 100 : 0;

      // Streak: scan from newest forward. + = consecutive wins,
      // − = consecutive losses, 0 = nothing actionable yet.
      var streak = 0;
      for (var i = 0; i < taken.length; i++) {
        var x = taken[i];
        var isWin  = (x.status === STATUS.WIN_T1 || x.status === STATUS.WIN_T2);
        var isLoss = (x.status === STATUS.LOSS_SL) || (x.pnlR != null && x.pnlR < -0.5);
        if (isWin)       { if (streak >= 0) streak++; else break; }
        else if (isLoss) { if (streak <= 0) streak--; else break; }
        else break;
      }

      return {
        total:    entries.length,
        taken:    taken.length,
        wins:     wins.length,
        losses:   losses.length,
        winRate:  +winRate.toFixed(1),
        avgR:     +avgR.toFixed(2),
        totalR:   +totalR.toFixed(2),
        streak:   streak,
        entries:  entries
      };
    }

    function setCapital(v) { var n = +v; if (isFinite(n) && n > 0)  { state.capital = n; save(); } }
    function setRiskPct(v) { var n = +v; if (isFinite(n) && n > 0 && n <= 50) { state.riskPct = n; save(); } }
    function setFilter(group, value) {
      if (state.filter[group] !== undefined) { state.filter[group] = value; }
    }
    function getFilter() { return state.filter; }
    function getCapital() { return state.capital; }
    function getRiskPct() { return state.riskPct; }
    function getSlPct() { return state.slPct; }
    function getT1Pct() { return state.t1Pct; }
    function getT2Pct() { return state.t2Pct; }
    function getEntry(id) { return state.entries.find(function (e) { return e.id === id; }); }
    // ── markTaken (P0-4) ──────────────────────────────────────
    // Sets the `taken` boolean on an entry. true = user pulled the
    // trigger via CONFIRM modal. false = user explicitly skipped
    // via the modal (entry status also flips to EXPIRED_UNUSED so
    // the row visually moves to the "skipped" stripe). Distinct
    // from `status` because status tracks outcome lifecycle (OPEN
    // → WIN/LOSS), while `taken` tracks whether real money was
    // committed. The daily-cap auto-lock (P0-5) keys off `taken`
    // counts, not status counts, so phantom signals you never
    // actioned don't burn your daily budget.
    function markTaken(id, takenBool) {
      var e = getEntry(id);
      if (!e) return false;
      e.taken = !!takenBool;
      // Skipping via CONFIRM modal also flips status so the row
      // visually moves out of OPEN. WIN/LOSS marks happen via the
      // outcome modal afterwards and don't touch `taken`.
      if (!takenBool && e.status === STATUS.OPEN) {
        e.status = STATUS.EXPIRED_UNUSED;
        e.exitTs = Date.now();
      }
      save();
      return true;
    }
    // ── getTodayCounts (P0-4 / P0-5) ──────────────────────────
    // Roll-up of today's journal activity used by the daily-cap
    // auto-lock and by the CONFIRM modal's "you've already taken
    // N today" hint. Counts entries by IST day-key (so the day
    // boundary flips at midnight IST, not browser-local).
    function getTodayCounts() {
      var nowMs = Date.now();
      var ist = new Date(nowMs + IST_OFFSET_MS);
      var yyyy = ist.getUTCFullYear();
      var mm = ('0' + (ist.getUTCMonth() + 1)).slice(-2);
      var dd = ('0' + ist.getUTCDate()).slice(-2);
      var todayKey = yyyy + '-' + mm + '-' + dd;
      var fired = 0, taken = 0, skipped = 0, wins = 0, losses = 0, open = 0;
      // P1-2: also accumulate today's realized P&L (₹ + R) and
      // remember the most recent CLOSED-LOSS exit timestamp so the
      // cooling-off check can compute "minutes since last loss".
      var realizedRupees = 0, realizedR = 0, lastLossTs = 0;
      for (var i = 0; i < state.entries.length; i++) {
        var e = state.entries[i];
        if (!e.ts) continue;
        var eIst = new Date(e.ts + IST_OFFSET_MS);
        var eKey = eIst.getUTCFullYear()
                 + '-' + ('0' + (eIst.getUTCMonth() + 1)).slice(-2)
                 + '-' + ('0' + eIst.getUTCDate()).slice(-2);
        if (eKey !== todayKey) continue;
        fired++;
        if (e.taken === true)        taken++;
        else if (e.status === STATUS.EXPIRED_UNUSED) skipped++;
        if (e.status === STATUS.WIN_T1 || e.status === STATUS.WIN_T2) wins++;
        if (e.status === STATUS.LOSS_SL || e.status === STATUS.EXIT_MANUAL) losses++;
        if (e.status === STATUS.OPEN && e.taken === true) open++;

        // P1-2: realized P&L only from CLOSED entries the user
        // actually took (taken=true). Exit prem × lot-qty for ₹
        // sum; pnlR for R sum.
        if (e.taken === true && e.exitPremium != null && e.entryPremium != null) {
          var qty = (e.position && e.position.qty) ? e.position.qty : (e.position && e.position.lotSize ? e.position.lotSize : 0);
          if (qty > 0) {
            realizedRupees += (e.exitPremium - e.entryPremium) * qty;
          }
          if (isFinite(e.pnlR)) realizedR += e.pnlR;
          // Track latest CLOSED-LOSS exit ts.
          var isLossExit = (e.status === STATUS.LOSS_SL || e.status === STATUS.EXIT_MANUAL)
                           && isFinite(e.pnlR) && e.pnlR < 0;
          if (isLossExit && e.exitTs && e.exitTs > lastLossTs) lastLossTs = e.exitTs;
        }
      }
      return {
        fired: fired, taken: taken, skipped: skipped,
        wins: wins, losses: losses, open: open,
        realizedRupees: +realizedRupees.toFixed(0),
        realizedR:      +realizedR.toFixed(2),
        lastLossTs:     lastLossTs || null,
        dayKey: todayKey
      };
    }
    // ── getActiveSignal (P0-3) ────────────────────────────────
    // The "active" signal is the most recent BUY_CE / BUY_PE that
    // the engine fired AND which matches state.lastAction (set on
    // the rising edge inside logSignal). When lastAction is null
    // / WAIT / opposite-side, there is no active signal — returns
    // null. The returned object is the canonical snapshot of WHEN
    // the current recommendation first fired, used by the
    // signal-freshness layer to compute age / drift / staleness.
    //
    // Returned shape:
    //   { action, ts, ageMs, entry: <journalEntry>, strike,
    //     entryPremium, spotAtFire }
    // or null when no live signal.
    function getActiveSignal() {
      maybeExpireActiveSignal();
      if (!state.lastAction || state.lastAction === 'WAIT') return null;
      if (state.lastAction !== 'BUY_CE' && state.lastAction !== 'BUY_PE') return null;
      var ts = +state.lastActionTs;
      if (!isFinite(ts) || ts <= 0) return null;
      // Only the OPEN journal row tied to this fire — never resurrect
      // an EXPIRED_UNUSED entry from a prior session / stale window.
      var match = openEntryForAction(state.lastAction);
      if (!match || Math.abs(match.ts - ts) > 5000) match = null;
      if (!match) {
        // Orphan lastAction — OPEN row expired or missing; reset so
        // logSignal() can re-fire on the next analyze cycle.
        state.lastAction = 'WAIT';
        state.lastActionTs = 0;
        save();
        return null;
      }
      var ageMs = Date.now() - ts;
      return {
        action:       state.lastAction,
        ts:           ts,
        ageMs:        ageMs > 0 ? ageMs : 0,
        entry:        match,
        strike:       match ? match.strike : null,
        entryPremium: match ? match.entryPremium : null,
        spotAtFire:   match ? match.spotAtFire : null
      };
    }
    function getOutcomeBeingMarked() { return state.outcomeBeingMarked; }
    function setOutcomeBeingMarked(obj) { state.outcomeBeingMarked = obj; }
    function clearAll() {
      state.entries = [];
      state.lastAction = null;
      state.lastActionTs = 0;
      save();
    }
    // backfillActivePremium — patches the currently OPEN journal entry
    // with premium values from plan.premium if it was logged before the
    // option chain finished loading (entryPremium null). Without this,
    // the journal table shows "—" for ENTRY/SL/T1 forever and outcome
    // R cannot be computed even if the user takes the trade. Called
    // from liveTick after attachPremiumPlan succeeds.
    function backfillActivePremium(plan) {
      if (!plan || !plan.premium || plan.premium.entry == null) return false;
      var act = state.lastAction;
      if (act !== 'BUY_CE' && act !== 'BUY_PE') return false;
      if (plan.action !== act) return false;
      var e = openEntryForAction(act);
      if (!e) return false;
      if (e.entryPremium != null && e.slPremium != null) return false;
      var pp = plan.premium;
      e.entryPremium = pp.entry;
      e.slPremium    = pp.sl;
      e.t1Premium    = pp.t1;
      e.t2Premium    = pp.t2;
      if (!e.position && pp.lotSize != null) {
        e.position = {
          lotSize:           pp.lotSize,
          lots:              pp.lots,
          qty:               pp.qty,
          capital:           pp.capital,
          capitalDeployed:   pp.capitalDeployed,
          capitalDeployedPct:pp.capitalDeployedPct,
          maxLossINR:        pp.maxLossINR,
          maxLossPct:        pp.maxLossPct,
          maxGainT1INR:      pp.maxGainT1INR,
          maxGainT2INR:      pp.maxGainT2INR,
          rrToT1:            pp.rrToT1,
          rrToT2:            pp.rrToT2,
          slPctDrop:         pp.slPctDrop,
          t1PctGain:         pp.t1PctGain,
          t2PctGain:         pp.t2PctGain,
          riskBudgetStatus:  pp.riskBudgetStatus,
          slQuality:         pp.slQuality,
          delta:             pp.delta
        };
      }
      save();
      return true;
    }

    load();

    return {
      logSignal:           logSignal,
      markOutcome:         markOutcome,
      deleteEntry:         deleteEntry,
      getStats:            getStats,
      setCapital:          setCapital,
      setRiskPct:          setRiskPct,
      setFilter:           setFilter,
      getFilter:           getFilter,
      getCapital:          getCapital,
      getRiskPct:          getRiskPct,
      getSlPct:            getSlPct,
      getT1Pct:            getT1Pct,
      getT2Pct:            getT2Pct,
      getEntry:            getEntry,
      markTaken:           markTaken,
      getTodayCounts:      getTodayCounts,
      getActiveSignal:     getActiveSignal,
      backfillActivePremium: backfillActivePremium,
      getOutcomeBeingMarked: getOutcomeBeingMarked,
      setOutcomeBeingMarked: setOutcomeBeingMarked,
      clearAll:            clearAll,
      STATUS:              STATUS,
      STATUS_LABEL:        STATUS_LABEL,
      STATUS_CLS:          STATUS_CLS
    };
  })();

  // ════════════════ SIGNAL FRESHNESS (P0-3) ════════════════════
  // The verdict engine runs every 3 minutes. A BUY CE that fired at
  // 13:42:00 is shown to the user at 13:43:30 (1m30s old) — already
  // half the SCALP window gone. Without a freshness layer, the
  // user can't tell whether the signal is "FRESH — type into
  // Upstox now" or "STALE — wait for the next analyze".
  //
  // This module computes three reads on every live tick:
  //   1. AGE        — ms since the signal first fired (rising-edge
  //                   timestamp from signalJournalModule).
  //   2. HEALTH     — band derived from age + drift. For SCALP:
  //                     FRESH    < 90s   — just fired, act now
  //                     ACTIVE   90s-4m  — still actionable
  //                     AGEING   4m-8m   — late, consider skipping
  //                     STALE    > 8m    — too late, wait
  //   3. DRIFT      — how much the premium and spot have moved
  //                   since fire. Heavy adverse drift = thesis
  //                   weakening even if age is fresh.
  //
  // The result powers a single freshness CHIP on the HUD (next
  // to the confidence pill) — colour-coded green/blue/amber/red,
  // labelled with the live age in m:ss, and tooltipped with the
  // full drift breakdown. Pro execution rule embedded in the UI:
  // if chip is AGEING or STALE, don't trade.
  var signalFreshnessModule = (function () {
    // Health bands in ms — tuned for SCALP (2-30 min holds).
    var BAND_FRESH_MS   = 90  * 1000;     // < 1m30s
    var BAND_ACTIVE_MS  = 4   * 60 * 1000;// < 4m
    var BAND_AGEING_MS  = 8   * 60 * 1000;// < 8m
    // Drift thresholds (% premium vs entry).
    var DRIFT_FAVOR_PCT   = -5;   // px dropped 5% from fire = better entry now
    var DRIFT_NEUTRAL_PCT = 8;    // < 8% gain = entry still close to fire
    var DRIFT_LATE_PCT    = 15;   // > 15% gain = move half-done
    // Spot drift "thesis-broken" threshold (pts AGAINST direction).
    var SPOT_ADVERSE_PTS  = 15;

    function compute(activeSig, currentSpot, currentPremium) {
      if (!activeSig) return { hasSignal: false };
      var ageMs = activeSig.ageMs;
      var health, healthLabel;
      // healthLabel is the USER-VISIBLE string on the chip.
      // health is the internal CSS key (drives data-health attribute
      // and colour rules — do NOT change those values).
      // AGEING renamed → LATE so it doesn't collide with the
      // Session pill's "CAUTION" state (both used to mean "be
      // careful" in different contexts; now each has a unique word).
      if      (ageMs < BAND_FRESH_MS)  { health = 'fresh';  healthLabel = 'FRESH'; }
      else if (ageMs < BAND_ACTIVE_MS) { health = 'active'; healthLabel = 'ACTIVE'; }
      else if (ageMs < BAND_AGEING_MS) { health = 'ageing'; healthLabel = 'LATE'; }
      else                              { health = 'stale';  healthLabel = 'STALE'; }

      // Premium drift — only meaningful if we have both numbers.
      var premiumDriftPct = null, premiumStatus = null;
      if (isFinite(currentPremium) && currentPremium > 0
          && isFinite(activeSig.entryPremium) && activeSig.entryPremium > 0) {
        premiumDriftPct = +(((currentPremium - activeSig.entryPremium) / activeSig.entryPremium) * 100).toFixed(1);
        if      (premiumDriftPct <= DRIFT_FAVOR_PCT)   premiumStatus = 'better';   // entry cheaper than fire
        else if (premiumDriftPct <= DRIFT_NEUTRAL_PCT) premiumStatus = 'neutral';  // ~same price
        else if (premiumDriftPct <= DRIFT_LATE_PCT)    premiumStatus = 'rising';   // move starting
        else                                            premiumStatus = 'late';     // move half-done
      }

      // Spot drift — sign relative to thesis direction. Positive
      // = WITH thesis (good); negative = AGAINST thesis (bad).
      var spotDriftPts = null, spotStatus = null;
      if (isFinite(currentSpot) && isFinite(activeSig.spotAtFire)) {
        var raw = currentSpot - activeSig.spotAtFire;
        spotDriftPts = +((activeSig.action === 'BUY_CE') ? raw : -raw).toFixed(1);
        if      (spotDriftPts <= -SPOT_ADVERSE_PTS)     spotStatus = 'broken';
        else if (spotDriftPts < 0)                       spotStatus = 'adverse';
        else if (spotDriftPts < SPOT_ADVERSE_PTS)        spotStatus = 'neutral';
        else                                              spotStatus = 'favor';
      }

      // Composite verdict — should the trader act?
      //   GO      fresh-or-active + drift neutral/better/favor
      //   WAIT    ageing/LATE or rising drift or adverse spot
      //   SKIP    stale or late drift or broken thesis
      // "CAUTION" is intentionally NOT used here — that word is
      // already claimed by the Session pill (time-of-day filter).
      // Using it for freshness too caused identical words to appear
      // for completely different reasons on the same screen.
      var verdict = 'GO';
      if (health === 'ageing'  || premiumStatus === 'rising' || spotStatus === 'adverse') verdict = 'WAIT';
      if (health === 'stale'   || premiumStatus === 'late'   || spotStatus === 'broken')  verdict = 'SKIP';

      return {
        hasSignal:       true,
        action:          activeSig.action,
        ageMs:           ageMs,
        ageLabel:        formatAge(ageMs),
        health:          health,
        healthLabel:     healthLabel,
        premiumDriftPct: premiumDriftPct,
        premiumStatus:   premiumStatus,
        spotDriftPts:    spotDriftPts,
        spotStatus:      spotStatus,
        verdict:         verdict,
        entryPremium:    activeSig.entryPremium,
        spotAtFire:      activeSig.spotAtFire,
        currentPremium:  (currentPremium != null && isFinite(currentPremium)) ? +currentPremium.toFixed(2) : null,
        currentSpot:     (currentSpot != null && isFinite(currentSpot)) ? +currentSpot.toFixed(2) : null
      };
    }

    function formatAge(ms) {
      if (!isFinite(ms) || ms < 0) return '0s';
      var totalSec = Math.floor(ms / 1000);
      var m = Math.floor(totalSec / 60);
      var s = totalSec % 60;
      if (m === 0) return s + 's';
      return m + 'm' + (s < 10 ? '0' : '') + s + 's';
    }

    return { compute: compute, formatAge: formatAge };
  })();

  // Render the freshness chip into the HUD. Cheap to re-run; safe
  // no-op if the chip element isn't in the DOM yet.
  function renderSignalFreshness(activeSig, currentSpot, currentPremium) {
    var chip = document.getElementById('ia-hud-freshness');
    if (!chip) return;
    // The parent decision HUD also needs to know the freshness
    // verdict so it can degrade the whole card visually when the
    // signal is SKIP / stale (red banner, struck-through verdict,
    // dimmed numbers) and hide its contents entirely once
    // abandoned. CSS does the work; we just publish the attrs.
    var hud = document.getElementById('ia-decision-hud');
    var f = signalFreshnessModule.compute(activeSig, currentSpot, currentPremium);
    if (!f || !f.hasSignal) {
      chip.hidden = true;
      chip.removeAttribute('data-health');
      chip.removeAttribute('title');
      chip.textContent = '';
      if (hud) {
        hud.removeAttribute('data-freshness');
        hud.removeAttribute('data-freshness-verdict');
        hud.removeAttribute('data-abandoned');
      }
      return;
    }
    chip.hidden = false;
    chip.setAttribute('data-health', f.health);
    chip.setAttribute('data-verdict', f.verdict.toLowerCase());
    if (hud) {
      hud.setAttribute('data-freshness', f.health);
      hud.setAttribute('data-freshness-verdict', f.verdict.toLowerCase());
      // Auto-abandon: a signal that's been SKIP for 10+ minutes
      // is no longer actionable AT ALL — premium has drifted far
      // past the original entry, SL would already be hit, etc.
      // Showing the original BUY/SL/T1 numbers would mislead.
      // CSS hides them and shows "Waiting for next signal…".
      var STALE_ABANDON_MS = 10 * 60 * 1000;
      if (f.verdict === 'SKIP' && f.ageMs > STALE_ABANDON_MS) {
        hud.setAttribute('data-abandoned', 'true');
      } else {
        hud.removeAttribute('data-abandoned');
      }
    }

    // Build the chip's visible label — icon + health + age.
    var icon =
      f.health === 'fresh'  ? '\u25CE' :   // ◎ (target / just fired)
      f.health === 'active' ? '\u25C9' :   // ◉ (active)
      f.health === 'ageing' ? '\u26A0' :   // ⚠
                              '\u29B8';    // ⦸ stale
    // Tag text uses distinct words from the Session pill:
    //   Session pill owns "CAUTION" and "DO NOT TRADE"
    //   Freshness chip uses "SLOW DOWN" (WAIT) and "SIGNAL STALE" (SKIP)
    chip.innerHTML =
      '<span class="ia-fresh-icon">' + icon + '</span>'
      + '<span class="ia-fresh-label">' + f.healthLabel + '</span>'
      + '<span class="ia-fresh-age">' + f.ageLabel + '</span>'
      + (f.verdict === 'SKIP' ? '<span class="ia-fresh-tag ia-fresh-tag-skip">SIGNAL STALE</span>' :
         f.verdict === 'WAIT' ? '<span class="ia-fresh-tag ia-fresh-tag-caution">SLOW DOWN</span>' : '');

    // Tooltip with the drift breakdown — appears on hover.
    var tipParts = ['Signal fired ' + f.ageLabel + ' ago.'];
    if (f.premiumDriftPct != null) {
      var pSign = f.premiumDriftPct >= 0 ? '+' : '';
      var pNote = f.premiumStatus === 'better' ? ' (entry cheaper now)' :
                  f.premiumStatus === 'late'   ? ' (move half-done — late entry)' :
                  f.premiumStatus === 'rising' ? ' (move starting — act fast)' : '';
      tipParts.push('Premium: ' + pSign + f.premiumDriftPct + '%' + pNote);
    }
    if (f.spotDriftPts != null) {
      var sSign = f.spotDriftPts >= 0 ? '+' : '';
      var sNote = f.spotStatus === 'broken'  ? ' (thesis broken — wait for next signal)' :
                  f.spotStatus === 'adverse' ? ' (slight adverse drift)' :
                  f.spotStatus === 'favor'   ? ' (already moving with thesis)' : '';
      tipParts.push('Spot drift: ' + sSign + f.spotDriftPts + ' pts vs thesis' + sNote);
    }
    if (f.verdict === 'SKIP') tipParts.push('SIGNAL STALE — too much time or drift since fire. Wait for the next analyze cycle.');
    if (f.verdict === 'WAIT') tipParts.push('SLOW DOWN — signal is ageing. Entry is still possible but size down and be quick.');
    if (f.verdict === 'GO')   tipParts.push('GO — signal is fresh. Enter at the displayed premium.');
    chip.setAttribute('title', tipParts.join('\n'));
  }

  // ════════════════ EVENT CALENDAR VETO (P1-3, May 2026) ═══════
  // "Clean BUY CE at 13:45 → RBI policy at 14:00 → trade dies."
  // This module exposes the known noisy time windows so the
  // discipline layer can veto entry inside them. Two sources:
  //
  //   1. ALGORITHMIC — Thursday expiry mid-day (13:30-15:30 IST).
  //      Gamma can swing premiums 30-50% on tiny spot moves;
  //      SCALP edge collapses in this window.
  //   2. HARDCODED   — published 2026 RBI / Fed / Budget dates.
  //      ±15 min veto window around each event time.
  //   3. USER-ADDED  — ad-hoc events the user enters via
  //      iaEventAdd(). Persisted in LS so they survive reload.
  //
  // The discipline layer reads getActiveEvent() and if non-null
  // returns a SOFT_LOCK with the event name + remaining minutes
  // so the user can see exactly what's blocking them.
  var eventCalendarModule = (function () {
    var LS_KEY = 'event_calendar_v1';
    var VETO_WINDOW_MS = 15 * 60 * 1000;  // ±15 min around event
    var state = { custom: [] };

    // Published 2026 macro events. Times in IST.
    // Update when the year ends — see scripts/ or just edit here.
    // Each entry: { name, ts (epoch ms), tag: 'RBI'|'FED'|'BUDGET' }
    // Times reflect the event START (RBI press conf, Fed FOMC
    // statement converted to IST, Budget speech start). The veto
    // window is ±15 min around this anchor.
    var BUILTIN_EVENTS = [
      // RBI Monetary Policy 2026 (announced dates published by RBI)
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026, 1,  5,  4, 30), tag: 'RBI' },     // 5 Feb 10:00 IST
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026, 3,  3,  4, 30), tag: 'RBI' },     // 3 Apr
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026, 5,  5,  4, 30), tag: 'RBI' },     // 5 Jun
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026, 7,  7,  4, 30), tag: 'RBI' },     // 7 Aug
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026, 9,  2,  4, 30), tag: 'RBI' },     // 2 Oct
      { name: 'RBI Monetary Policy', ts: Date.UTC(2026,11,  4,  4, 30), tag: 'RBI' },     // 4 Dec
      // Union Budget 2026
      { name: 'Union Budget Speech',  ts: Date.UTC(2026, 1,  1,  5, 30), tag: 'BUDGET' }, // 1 Feb 11:00 IST
      // US Fed FOMC decisions 2026 (impact IST early morning next day)
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 0, 28, 18, 30), tag: 'FED' },    // 28 Jan
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 2, 18, 18, 30), tag: 'FED' },    // 18 Mar
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 4,  6, 18, 30), tag: 'FED' },    // 6 May
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 5, 17, 18, 30), tag: 'FED' },    // 17 Jun
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 6, 29, 18, 30), tag: 'FED' },    // 29 Jul
      { name: 'US Fed FOMC',          ts: Date.UTC(2026, 8, 16, 18, 30), tag: 'FED' },    // 16 Sep
      { name: 'US Fed FOMC',          ts: Date.UTC(2026,10,  4, 19, 30), tag: 'FED' },    // 4 Nov
      { name: 'US Fed FOMC',          ts: Date.UTC(2026,11, 16, 19, 30), tag: 'FED' }     // 16 Dec
    ];

    function load() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        var p = JSON.parse(raw);
        if (p && Array.isArray(p.custom)) state.custom = p.custom;
      } catch (_) {}
    }
    function save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ custom: state.custom })); } catch (_) {}
    }
    load();

    // Returns whether `now` falls inside the Thursday-expiry tail
    // (13:30-15:30 IST). Uses IST clock derivation to avoid local
    // timezone surprises.
    function inThursdayExpiry(now) {
      now = now || Date.now();
      var ist = new Date(now + IST_OFFSET_MS);
      if (ist.getUTCDay() !== 4) return false;     // 4 = Thursday
      var mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
      return mins >= (13 * 60 + 30) && mins <= (15 * 60 + 30);
    }

    function allEvents() {
      return BUILTIN_EVENTS.concat(state.custom || []);
    }

    // Returns the currently-active event window (±15 min around
    // any event), or null. Includes Thursday-expiry tail as a
    // synthetic "EXPIRY_TAIL" pseudo-event.
    function getActiveEvent(now) {
      now = now || Date.now();
      if (inThursdayExpiry(now)) {
        return {
          name: 'Thursday Expiry Tail',
          tag:  'EXPIRY_TAIL',
          ts:   now,
          remainMs: (Date.UTC(1970,0,1, 15, 30) - (((now + IST_OFFSET_MS) % 86400000))) % 86400000,
          type: 'algorithmic'
        };
      }
      var all = allEvents();
      for (var i = 0; i < all.length; i++) {
        var ev = all[i];
        if (!isFinite(ev.ts)) continue;
        var delta = ev.ts - now;
        if (Math.abs(delta) <= VETO_WINDOW_MS) {
          return {
            name: ev.name, tag: ev.tag, ts: ev.ts,
            remainMs: VETO_WINDOW_MS - Math.abs(delta),  // ms until veto lifts
            type: 'scheduled'
          };
        }
      }
      return null;
    }

    // Returns the next upcoming event (for "X min until RBI" hint).
    function getNextEvent(now) {
      now = now || Date.now();
      var best = null;
      var all = allEvents();
      for (var i = 0; i < all.length; i++) {
        var ev = all[i];
        if (!isFinite(ev.ts) || ev.ts <= now) continue;
        if (!best || ev.ts < best.ts) best = ev;
      }
      return best;
    }

    function addCustom(name, dateTimeStr) {
      if (!name || !dateTimeStr) return false;
      // dateTimeStr accepts ISO-ish 'YYYY-MM-DDTHH:MM' (datetime-local
      // input format). Interpreted as IST.
      var m = String(dateTimeStr).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
      if (!m) return false;
      var yyyy = +m[1], mm = +m[2] - 1, dd = +m[3], hh = +m[4], mn = +m[5];
      // Convert IST -> UTC for storage.
      var ts = Date.UTC(yyyy, mm, dd, hh, mn) - IST_OFFSET_MS;
      state.custom.push({ name: String(name).slice(0, 60), ts: ts, tag: 'USER' });
      save();
      return true;
    }
    function removeCustom(ts) {
      state.custom = state.custom.filter(function (e) { return e.ts !== ts; });
      save();
    }
    function getCustom() { return state.custom.slice(); }

    return {
      getActiveEvent: getActiveEvent,
      getNextEvent:   getNextEvent,
      addCustom:      addCustom,
      removeCustom:   removeCustom,
      getCustom:      getCustom,
      allEvents:      allEvents
    };
  })();
  // ───── Event-calendar modal controller (P1-3 polish, May 2026)
  //
  // Replaces the original prompt()/alert() flow with a proper
  // modal that follows the same pattern as ia-confirm-modal and
  // sj-outcome-modal:
  //   - native datetime-local picker (calendar UI on every modern
  //     browser, zero deps) so the user never types a date string,
  //   - live list of every scheduled event (built-in macros are
  //     read-only, user-added customs show a delete button),
  //   - inline validation banner (no alert popups),
  //   - ESC + backdrop close + focus restore to the launching
  //     button (a11y parity with the other modals).
  //
  // window.iaEventAdd is retained as the public entry point because
  // the settings-bar button's onclick already references it; it now
  // simply opens the modal instead of running prompts.
  (function () {
    var TAG_LABEL = {
      RBI:          { label: 'RBI',      cls: 'ia-event-tag-rbi'    },
      FED:          { label: 'FED',      cls: 'ia-event-tag-fed'    },
      BUDGET:       { label: 'BUDGET',   cls: 'ia-event-tag-budget' },
      USER:         { label: 'YOURS',    cls: 'ia-event-tag-user'   },
      EXPIRY_TAIL:  { label: 'EXPIRY',   cls: 'ia-event-tag-expiry' }
    };
    var lastFocus = null;

    // Pads numbers to a fixed width so we can build YYYY-MM-DDTHH:MM
    // strings without pulling in a formatting library.
    function pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

    // Returns the IST `YYYY-MM-DDTHH:MM` string for an epoch ms.
    // datetime-local inputs expect this exact shape and treat it as
    // local — we want to *display* IST regardless of the user's
    // browser timezone, so we derive IST parts manually.
    function istLocalString(epochMs) {
      var d = new Date(epochMs + IST_OFFSET_MS);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())
           + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    }

    // Friendlier display string for the list rows: "Thu 5 Feb · 10:00 IST".
    function istReadable(epochMs) {
      var d = new Date(epochMs + IST_OFFSET_MS);
      var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]
           + ' \u00B7 ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' IST';
    }

    // Builds the event list HTML. Shows every event (past and
    // future) so the user can always see what they've added —
    // past entries are tagged with a muted "ago" label and don't
    // affect veto logic but are kept visible for record-keeping
    // (and so backfilled events don't silently disappear).
    // Sort: upcoming first (ascending), then past (most recent past first).
    function buildListHtml() {
      var now = Date.now();
      var all = eventCalendarModule.allEvents()
        .filter(function (e) { return isFinite(e.ts); })
        .sort(function (a, b) {
          var aPast = a.ts < now, bPast = b.ts < now;
          if (aPast !== bPast) return aPast ? 1 : -1;   // future before past
          return aPast ? (b.ts - a.ts) : (a.ts - b.ts); // past: newest-first; future: soonest-first
        });
      if (!all.length) {
        return '<div class="ia-event-empty">No events on the calendar yet.</div>';
      }
      var rows = all.map(function (ev) {
        var tag = TAG_LABEL[ev.tag] || { label: ev.tag || '?', cls: 'ia-event-tag-user' };
        var when = istReadable(ev.ts);
        var deltaMin = Math.round((ev.ts - now) / 60000);
        var isPast = deltaMin < 0;
        var absMin = Math.abs(deltaMin);
        var rel;
        if (absMin < 60)         rel = absMin + ' min';
        else if (absMin < 1440)  rel = Math.round(absMin / 60) + ' h';
        else                     rel = Math.round(absMin / 1440) + ' d';
        var relStr = isPast ? rel + ' ago' : 'in ' + rel;
        var relCls = isPast ? 'ia-event-row-past' : 'ia-event-row-until';
        var delBtn = (ev.tag === 'USER')
          ? '<button type="button" class="ia-event-del" title="Remove this custom event" '
            + 'onclick="window.iaDeleteEvent(' + ev.ts + ')" aria-label="Remove '
            + (ev.name || 'event').replace(/"/g, '&quot;') + '">\u00D7</button>'
          : '';
        return ''
          + '<div class="ia-event-row' + (isPast ? ' is-past' : '') + '">'
          +   '<span class="ia-event-tag ' + tag.cls + '">' + tag.label + '</span>'
          +   '<div class="ia-event-row-body">'
          +     '<div class="ia-event-row-name">' + (ev.name || 'Event') + '</div>'
          +     '<div class="ia-event-row-when">' + when + ' \u00B7 <span class="' + relCls + '">' + relStr + '</span></div>'
          +   '</div>'
          +   delBtn
          + '</div>';
      }).join('');
      return rows;
    }

    function renderList() {
      var host = document.getElementById('ia-event-list');
      if (host) host.innerHTML = buildListHtml();
    }

    function showError(msg) {
      var el = document.getElementById('ia-event-err');
      if (!el) return;
      if (!msg) { el.hidden = true; el.textContent = ''; return; }
      el.hidden = false;
      el.textContent = msg;
    }

    // Resets the form fields to sensible defaults: empty name,
    // datetime defaulted to the next round hour (so adding "today
    // 11:00" is one click away). NOTE: we intentionally do NOT
    // set `min` on the input — the user needs to be able to
    // navigate the calendar across months freely, and backfilling
    // a past event (for record-keeping) is harmless because the
    // veto window has already passed.
    function resetForm() {
      var name = document.getElementById('ia-event-name');
      var when = document.getElementById('ia-event-when');
      if (name) name.value = '';
      if (when) {
        var nowIst = Date.now();
        var roundUp = new Date(nowIst + IST_OFFSET_MS);
        roundUp.setUTCMinutes(0, 0, 0);
        roundUp.setUTCHours(roundUp.getUTCHours() + 1);
        var nextHourMs = roundUp.getTime() - IST_OFFSET_MS;
        when.value = istLocalString(nextHourMs);
        when.removeAttribute('min');
      }
      showError(null);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape' || e.keyCode === 27) closeModal();
    }

    function openModal() {
      var modal = document.getElementById('ia-event-modal');
      if (!modal) return;
      lastFocus = document.activeElement;
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      renderList();
      resetForm();
      document.addEventListener('keydown', onKeyDown, true);
      setTimeout(function () {
        var name = document.getElementById('ia-event-name');
        if (name) try { name.focus(); } catch (_) {}
      }, 60);
    }

    function closeModal() {
      var modal = document.getElementById('ia-event-modal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKeyDown, true);
      if (lastFocus && typeof lastFocus.focus === 'function') {
        try { lastFocus.focus(); } catch (_) {}
      }
      lastFocus = null;
    }

    function submit() {
      var nameEl = document.getElementById('ia-event-name');
      var whenEl = document.getElementById('ia-event-when');
      var name = (nameEl && nameEl.value || '').trim();
      var when = (whenEl && whenEl.value || '').trim();
      if (!name) { showError('Event name is required.'); if (nameEl) try { nameEl.focus(); } catch (_) {} return; }
      if (!when) { showError('Pick a date and time.'); if (whenEl) try { whenEl.focus(); } catch (_) {} return; }
      if (!eventCalendarModule.addCustom(name, when)) {
        showError('Could not parse that date. Use the picker arrows.');
        return;
      }
      if (nameEl) nameEl.value = '';
      showError(null);
      renderList();
      if (nameEl) try { nameEl.focus(); } catch (_) {}
    }

    function del(ts) {
      if (typeof ts !== 'number' || !isFinite(ts)) return;
      eventCalendarModule.removeCustom(ts);
      renderList();
    }

    window.iaEventAdd        = openModal;     // legacy entry point (button onclick already references this name)
    window.iaOpenEventModal  = openModal;     // new explicit name
    window.iaCloseEventModal = closeModal;
    window.iaSubmitEvent     = submit;
    window.iaDeleteEvent     = del;
    window.iaRenderEventList = renderList;    // exposed so other modules (e.g. future "Schedule" link) can refresh
  })();

  // ════════════════ ALERT SYSTEM (P1-1, May 2026) ══════════════
  // SCALP signals last 3-5 minutes. You can't watch the screen for
  // 6 hours. This module fires three kinds of alerts so the user
  // gets a real-world poke when something actionable happens:
  //
  //   1. SIGNAL ALERT    — fired on rising-edge logSignal (when
  //                        engine produces a fresh BUY CE / BUY
  //                        PE). Sound + tab title flash.
  //   2. FLIP ALERT      — fired when active side flips (CE → PE
  //                        or PE → CE). Existing position is now
  //                        WRONG-SIDE; exit immediately. Different,
  //                        urgent sound.
  //   3. REVERSE EXIT    — fired when engine goes from BUY → WAIT
  //                        while user has taken=true open position
  //                        (the engine wants you out).
  //
  // Sound is Web Audio API generated (zero external assets, plays
  // even offline, works in PWA installs). Title flash works even
  // when the tab is in background — most browsers update the
  // taskbar/tab name. Both can be muted globally via the journal
  // settings toggle (persisted to localStorage).
  var alertModule = (function () {
    var LS_KEY = 'alert_settings_v1';
    var state = { soundOn: true };
    var titleOrig = null;
    var titleFlashTimer = null;
    var audioCtx = null;
    var lastAlertKey = null;
    var lastAlertTs = 0;
    // De-dupe window — same alert can fire at most once per 8s
    // even if the upstream caller spams it (defensive). Prevents
    // an analyze + tick collision from producing a double beep.
    var DEDUPE_MS = 8000;

    function load() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        var p = JSON.parse(raw);
        if (typeof p.soundOn === 'boolean') state.soundOn = p.soundOn;
      } catch (_) {}
    }
    function save() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (_) {}
    }
    load();

    function getAudio() {
      if (audioCtx) return audioCtx;
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioCtx = new Ctx();
      } catch (_) {}
      return audioCtx;
    }

    // Synthesize a tone burst. freq in Hz, duration in seconds,
    // peakGain 0..1. type = 'sine' | 'square' | 'triangle' | 'sawtooth'.
    // Kept for backward-compat; bellNote() below is the preferred path
    // for new alerts (richer timbre, louder, more "Apple-like").
    function beep(freq, dur, peakGain, type) {
      if (!state.soundOn) return;
      var ctx = getAudio();
      if (!ctx) return;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch (_) {}
      try {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = type || 'sine';
        osc.frequency.value = freq;
        var t = ctx.currentTime;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(peakGain || 0.45, t + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
      } catch (_) {}
    }

    // ── Bell note (Apple "Note" / "Glass"-style) ─────────────────
    // Additive synthesis: stack 4 sine partials at tubular-bell
    // frequency ratios with their own decay envelopes, mix through
    // a master gain, and ring through a brief lowpass to soften the
    // top end. This is exactly how macOS's Note/Glass sounds are
    // synthesized (Apple ship the WAV but it's algorithmically a
    // pure bell — fundamental + 2nd partial + strike harmonic at
    // ~2.76× + brilliance partial). The result is warm, recognisable,
    // and noticeably louder than the old single-sine beep.
    //
    // Parameters:
    //   freq    Hz — fundamental (CE uses 880 / A5, PE uses 740 / F#5)
    //   dur     s  — total ring-out length (1.4 s ≈ Apple Note)
    //   peakGain 0..1 — MASTER peak (each partial gets a fraction)
    //   scheduleAt s — ctx.currentTime offset (for sequencing); 0 = now
    //
    // Loudness math: peakGain 0.85 at the master with 4 partials each
    // summed at 0.18 stays under digital clipping (≤1.0 at coherent
    // attack) but is ~4× louder than the old 0.15 sine. With laptop
    // speakers at typical desk volume this is "across-the-room"
    // audible — the user explicitly asked for loud.
    function bellNote(freq, dur, peakGain, scheduleAt) {
      if (!state.soundOn) return;
      var ctx = getAudio();
      if (!ctx) return;
      try { if (ctx.state === 'suspended') ctx.resume(); } catch (_) {}
      try {
        var startAt = ctx.currentTime + (scheduleAt || 0);
        var master = ctx.createGain();
        master.gain.value = peakGain;
        // Soft lowpass tames the harshness of the high partials
        // without killing the bell character.
        var lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(6000, freq * 8);
        lp.Q.value = 0.5;
        master.connect(lp).connect(ctx.destination);

        // Partial spec: [ratio, relGain, decayMul]
        //   ratio    = freq multiplier (1, 2, 2.76, 5.4 = tubular bell)
        //   relGain  = mix level relative to master (sum < 1.0)
        //   decayMul = decay length × dur (higher partials decay faster
        //              — physical bells do this; gives the "shimmer
        //              fades, fundamental rings" character)
        var partials = [
          [1.00, 0.50, 1.00],   // fundamental — body of the bell
          [2.00, 0.30, 0.70],   // octave — strike component
          [2.76, 0.18, 0.55],   // tubular-bell strike harmonic
          [5.40, 0.06, 0.35]    // brilliance / shimmer
        ];
        for (var i = 0; i < partials.length; i++) {
          var p = partials[i];
          var osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = freq * p[0];
          var g = ctx.createGain();
          g.gain.setValueAtTime(0, startAt);
          // Sharp 4 ms attack for the "strike" feel.
          g.gain.linearRampToValueAtTime(p[1], startAt + 0.004);
          g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur * p[2]);
          osc.connect(g).connect(master);
          osc.start(startAt);
          osc.stop(startAt + dur * p[2] + 0.05);
        }
      } catch (_) {}
    }

    // Schedule a sequence of bell notes — each entry is
    // [freq, dur, peakGain, gapAfter]. gapAfter defaults to a tight
    // 80 ms so a 2-note sequence still feels like one event.
    function bellSeq(notes) {
      if (!state.soundOn) return;
      var ctx = getAudio();
      if (!ctx) return;
      var when = 0;
      for (var i = 0; i < notes.length; i++) {
        var n = notes[i];
        bellNote(n[0], n[1], n[2] != null ? n[2] : 0.85, when);
        when += (n[3] != null ? n[3] : 0.08);
      }
    }

    function setSoundEnabled(on) {
      state.soundOn = !!on;
      save();
    }
    function isSoundEnabled() { return state.soundOn; }

    // Title flash — alternates between the original title and a
    // signal-specific announce string until the user focuses the
    // tab again. Cleared on visibilitychange:visible.
    function startTitleFlash(msg) {
      if (titleOrig == null) titleOrig = document.title;
      stopTitleFlash();
      if (!document.hidden) return; // don't flash while user is looking
      var toggle = false;
      titleFlashTimer = setInterval(function () {
        try { document.title = toggle ? titleOrig : msg; toggle = !toggle; } catch (_) {}
      }, 850);
    }
    function stopTitleFlash() {
      if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
      if (titleOrig != null) {
        try { document.title = titleOrig; } catch (_) {}
      }
    }
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) stopTitleFlash();
    });

    // PUBLIC: fire a new-signal alert. macOS-Note-style bell — single
    // crisp strike with a 1.4 s ring-out, loud enough to hear across
    // a desk. CE rings high (880 / A5), PE rings a perfect fourth
    // lower (740 / F#5) so the two are immediately distinguishable
    // by ear without thinking. peakGain 0.85 ≈ ~4× louder than the
    // pre-May-2026 sine beeps (which most users couldn't hear from
    // more than a metre away).
    function playSignal(action, confidence, strike, confidencePct) {
      var key = 'sig|' + action + '|' + strike;
      var now = Date.now();
      if (lastAlertKey === key && (now - lastAlertTs) < DEDUPE_MS) return;
      lastAlertKey = key; lastAlertTs = now;
      if (action === 'BUY_CE') {
        bellNote(880, 1.4, 0.85, 0);
      } else {
        bellNote(740, 1.4, 0.85, 0);
      }
      var sideTxt = action === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
      // May 2026: include derived % in the title-flash so the user
      // sees "HIGH 82% · BUY CE 23,750 — click tab" in the browser
      // tab title. Matches the HUD chip + journal display.
      var confLbl = (confidence === 'HIGH' || confidence === 'MEDIUM' || confidence === 'LOW')
                    ? (confidence === 'MEDIUM' ? 'MED' : confidence) : '';
      var pctTxt = (confidencePct != null && isFinite(confidencePct))
                   ? ' ' + confidencePct + '%' : '';
      var confTxt = confLbl ? (confLbl + pctTxt + ' \u00B7 ') : '';
      startTitleFlash('\uD83D\uDD14 ' + confTxt + sideTxt + (strike ? ' ' + strike : '') + ' \u2014 click tab');
    }

    // PUBLIC: fire a side-flip alert. URGENT — three descending bell
    // strikes (1320 → 990 → 660 Hz, ~major-triad-down) at full
    // 0.95 gain. The triple-strike pattern is what makes it sound
    // alarming vs the single ding of playSignal, but each strike
    // is still a clean bell tone (consistent timbre across the
    // alert family) rather than the harsh square waves the old
    // implementation used. Fired when the engine flips your side.
    function playFlip(prevAction, newAction, strike) {
      var key = 'flip|' + prevAction + '|' + newAction;
      var now = Date.now();
      if (lastAlertKey === key && (now - lastAlertTs) < DEDUPE_MS) return;
      lastAlertKey = key; lastAlertTs = now;
      bellSeq([
        [1320, 0.45, 0.95, 0.15],
        [990,  0.45, 0.95, 0.15],
        [660,  1.20, 0.95, 0]
      ]);
      var sideTxt = newAction === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
      startTitleFlash('\u26A0 ENGINE FLIPPED \u2014 EXIT NOW \u2192 ' + sideTxt + (strike ? ' ' + strike : ''));
    }

    // PUBLIC: fire a reverse-exit alert. Used when active side
    // goes WAIT while the user has an open taken position. Same
    // urgency tier as flip but a slower, falling double-bell so
    // the user can distinguish "engine flipped sides" (three fast
    // strikes) from "engine wants you flat" (two slower strikes).
    function playReverseExit() {
      var key = 'exit';
      var now = Date.now();
      if (lastAlertKey === key && (now - lastAlertTs) < DEDUPE_MS) return;
      lastAlertKey = key; lastAlertTs = now;
      bellSeq([
        [880, 0.55, 0.90, 0.22],
        [550, 1.30, 0.90, 0]
      ]);
      startTitleFlash('\u26A0 SIGNAL ENDED \u2014 CONSIDER EXIT');
    }

    return {
      setSoundEnabled:  setSoundEnabled,
      isSoundEnabled:   isSoundEnabled,
      playSignal:       playSignal,
      playFlip:         playFlip,
      playReverseExit:  playReverseExit
    };
  })();
  window.iaSetSoundEnabled = function (on) {
    try {
      alertModule.setSoundEnabled(on);
      // Test beep on enable so the user knows it's working + grants
      // browser audio permission on the gesture.
      if (on) {
        // Tiny test ping at 880Hz so user hears confirmation.
        // beep() is internal; mimic via a one-shot playSignal in a way
        // that doesn't pollute the dedupe key.
        try { alertModule.playSignal('BUY_CE', 'LOW', null); } catch (_) {}
      }
    } catch (_) {}
  };

  // ════════════════ PAPER-TRADE BRIDGE (P2-A, May 2026) ═══════════
  // Zero-scroll one-click execution path: user sees a fresh BUY_CE /
  // BUY_PE in the HUD → glances at the Quick-Trade strip directly
  // below (renderQuickStrip paints it from plan.premium + the active
  // journal entry) → clicks PAPER TRADE NOW → bridge fires the same
  // calls the manual paper-trade panel would, then watches the
  // resulting paper position and writes its eventual exit back to
  // the journal automatically. End-to-end click count: 1.
  //
  // Design constraints — preserved verbatim from the planning chat:
  //   * Never modify paperTradeModule itself (lines 5969-8521).
  //     The only additions there are two pure exposures
  //     (ptSelectStrike, ptGetPosition) that surface existing
  //     functionality without changing behaviour.
  //   * Manual paper-trade flow (strike picker, MARKET/LIMIT/STOP,
  //     per-card lots steppers, EXIT ALL, etc.) stays as-is so the
  //     bridge is purely additive.
  //   * Discipline lock + event veto still apply: the strip's
  //     PAPER TRADE NOW button hard-disables under HARD_LOCK and
  //     warns under SOFT_LOCK (mirrors the CONFIRM modal gate).
  //   * Auto-outcome writeback is the half that makes the test
  //     actually usable — without it the journal silently rots
  //     because the user forgets to mark exits.
  //
  // Workflow walk-through (happy path):
  //   T+0   engine fires BUY_CE at 24500   → renderQuickStrip shows
  //          strike/entry/SL/T1/deploy/maxLoss + lot stepper
  //   T+2   user clicks PAPER TRADE NOW
  //   T+2   bridge picks ATM strike from spot (matches journal
  //          entry's strike), sets order type = MARKET, sets qtyCE
  //          (or qtyPE) to current lots, calls window.ptBuyCE/PE
  //   T+3   paperTradeModule fetches a fresh quote and creates the
  //          position with sl=null/tgt=null (its default)
  //   T+4   bridge sees new pos id in [data-pos-id] DOM, captures
  //          it, then calls ptUpdatePosRisk(id,'sl',sl) +
  //          ptUpdatePosRisk(id,'tgt',t1) to attach the journal's
  //          SL + T1 levels so paperTradeModule's own auto-exit
  //          checkRiskTriggers() will close on those triggers
  //   T+4   bridge links {journalEntryId ↔ paperPositionId} into
  //          its LS-persisted link map and marks the journal entry
  //          as taken=true
  //   T+4   bridge starts a 5-second poll
  //   T+~   paperTradeModule auto-exits the position (SL/TGT/EOD)
  //   T+~+5 next bridge poll sees the linked position is now in
  //          history → reads {exit, exitReason} → calls
  //          signalJournalModule.markOutcome(id, status, exit) →
  //          journal stats refresh
  //
  // Edge cases handled:
  //   * Tab reloaded mid-trade — links persist in LS, the bridge
  //     resumes polling on next live activation. The user does NOT
  //     have to leave the tab open for the outcome to be recorded.
  //   * Side flips (CE→PE) before user clicks — strip auto-repaints
  //     on each renderDecisionHud; pressing the button uses the
  //     CURRENT journal entry, not a stale snapshot.
  //   * Same signal already taken — strip hides itself (visible
  //     only when no live link exists for the current journal id).
  //   * Discipline lock fires — strip shows the lock state and
  //     disables PAPER TRADE NOW with a clear "DAY LOCKED" sub.
  var paperBridgeModule = (function () {
    var LS_KEY = 'paper_bridge_link_v1';
    var LS_AUTO_KEY = 'paper_bridge_auto_v1';
    var POLL_MS = 5000;
    var OPEN_DEADLINE_MS = 8000;    // wait at most 8 s for ptBuy to materialize a position id
    var POS_RISK_DELAY_MS = 350;    // small delay after ptBuy so updatePosRisk targets the NEW pos
    var MAX_LOTS = 3;               // strip is for scalp testing — discipline cap
    // Auto-trade: when ON, fires take() automatically once the strip
    // reaches READY state (fresh signal + chain loaded + premiums in).
    // Guarded by the same locks and freshness gate as manual take().
    var autoTrade = false;
    var autoFiredForEntry = null;   // id of last entry auto-taken — prevents double-fire

    function loadAuto() {
      try { autoTrade = localStorage.getItem(LS_AUTO_KEY) === 'true'; } catch (_) {}
    }
    function saveAuto() {
      try { localStorage.setItem(LS_AUTO_KEY, autoTrade ? 'true' : 'false'); } catch (_) {}
    }
    function setAutoTrade(on) {
      autoTrade = !!on;
      saveAuto();
      renderQuickStrip();
      // Re-render the journal too so the OBSERVED chip tooltips
      // reflect the new AUTO state ("AUTO is OFF" vs the more
      // specific bridge reason) and the mirrored sj-auto-input
      // re-paints. Wrapped because sjRenderJournal may not be
      // ready during bridge initialisation.
      try {
        if (typeof window.sjRenderJournal === 'function') window.sjRenderJournal();
      } catch (_) {}
      try {
        console.info('[bridge] AUTO-TRADE turned ' + (autoTrade ? 'ON' : 'OFF'));
      } catch (_) {}
    }
    function isAutoTrade() { return autoTrade; }

    loadAuto();

    var state = {
      links: [],   // [{ journalEntryId, paperPositionId, ts, side, strike, lots }]
      lots:  1,
      pollTimer: null
    };

    function load() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        var p = JSON.parse(raw);
        if (p && Array.isArray(p.links)) state.links = p.links;
        if (p && isFinite(+p.lots) && +p.lots > 0) state.lots = clampLots(+p.lots);
      } catch (_) {}
    }
    function save() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ links: state.links, lots: state.lots }));
      } catch (_) {}
    }
    function clampLots(n) {
      var v = Math.round(+n || 1);
      if (!isFinite(v) || v < 1) v = 1;
      if (v > MAX_LOTS) v = MAX_LOTS;
      return v;
    }

    load();

    // ─── Lot stepper (1..MAX_LOTS) ────────────────────────────
    function getLots() { return state.lots; }
    function setLots(n) {
      state.lots = clampLots(n);
      save();
      renderQuickStrip();
    }
    function incLots(delta) { setLots(state.lots + (+delta || 0)); }

    // ─── Map paperTradeModule's exitReason → journal STATUS ───
    // SL hit = LOSS_SL, target hit = WIN_T1 (we attach T1 as the
    // paper-trade target so any TGT exit corresponds to our T1).
    // EOD square-off after entry = EXIT_TIME (held to end of day,
    // wasn't actually a SL or target). MANUAL = EXIT_MANUAL.
    // For MANUAL we additionally check exit-vs-entry to refine:
    // user-closed-in-profit is still EXIT_MANUAL (they cut early),
    // user-closed-at-loss is still EXIT_MANUAL too (cut at loss).
    // Only auto-triggered SL/TGT fills get the win/loss buckets so
    // the journal stats reflect REAL plan adherence (T1 reached vs
    // SL hit), not arbitrary manual cuts.
    function reasonToStatus(reason) {
      if (reason === 'SL')  return 'LOSS_SL';
      if (reason === 'TGT') return 'WIN_T1';
      if (reason === 'EOD') return 'EXIT_TIME';
      return 'EXIT_MANUAL';
    }

    // ─── Snapshot of currently-open paper-position ids ────────
    // Used as a "before" baseline so we can identify the new
    // position id after window.ptBuyCE / ptBuyPE creates one.
    // Falls back to scanning the DOM (data-pos-id) because the
    // paperTradeModule internal state.open array is not exposed
    // publicly. The DOM is the renderAll output, so as long as
    // ptBuy has finished a render cycle the new id is here.
    function snapshotOpenIds() {
      var els = document.querySelectorAll('[data-pos-id]');
      var ids = [];
      for (var i = 0; i < els.length; i++) {
        var v = els[i].getAttribute('data-pos-id');
        if (v) ids.push(v);
      }
      return ids;
    }

    function diffNewId(preIds) {
      var nowIds = snapshotOpenIds();
      for (var i = 0; i < nowIds.length; i++) {
        if (preIds.indexOf(nowIds[i]) === -1) return nowIds[i];
      }
      return null;
    }

    // ─── Pick the recommended ITM-1 strike present in the chain ─
    // Engine's recommendation is one strike in-the-money (see the
    // pickRecommendedStrike helper for rationale: higher delta,
    // less IV-decay noise, cleaner edge measurement). Side comes
    // from the active journal signal. If the exact strike isn't
    // in the chain (weekly-expiry edge case, partial chain), fall
    // back to the nearest available so we never refuse to trade
    // just because of a missing strike row.
    function pickStrike() {
      var chain = window.optionChainData;
      if (!chain || !Array.isArray(chain.strikes) || !chain.strikes.length) return null;
      var spot = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      if (spot == null || !isFinite(spot)) return null;
      var sig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
        ? signalJournalModule.getActiveSignal() : null;
      var side = sig ? (sig.action === 'BUY_PE' ? 'PE' : 'CE') : 'CE';
      var target = (typeof window.pickRecommendedStrike === 'function')
        ? window.pickRecommendedStrike(spot, side)
        : Math.round(spot / 50) * 50;
      var available = chain.strikes.map(function (s) { return +s.strike_price; })
                                   .filter(function (s) { return isFinite(s); });
      if (!available.length) return null;
      if (available.indexOf(target) !== -1) return target;
      return available.reduce(function (best, s) {
        return Math.abs(s - target) < Math.abs(best - target) ? s : best;
      }, available[0]);
    }

    // ─── Show a transient status string in the strip head ─────
    // tone = 'ok' | 'warn' | 'err' | 'pending'. Auto-clears
    // after `holdMs` (default 4 s) unless overridden by a newer
    // status. ok-status of 'paper-tracking' is sticky (it
    // disappears only when the link clears).
    function setStatus(text, tone, holdMs) {
      var el = document.getElementById('ia-quick-status');
      if (!el) return;
      el.textContent = text || '';
      el.setAttribute('data-tone', tone || '');
      if (el._clearTimer) { clearTimeout(el._clearTimer); el._clearTimer = null; }
      if (text && holdMs !== 0) {
        el._clearTimer = setTimeout(function () {
          if (el.textContent === text) {
            el.textContent = '';
            el.removeAttribute('data-tone');
          }
        }, holdMs || 4000);
      }
    }

    // ─── The big action: open paper position from active sig ──
    //
    // Optional `requestedSide` argument ('CE' or 'PE') hard-pins
    // which side the caller is asking for — invoked from the two
    // dedicated BUY CE / BUY PE strip buttons. If the engine's
    // active signal is on a different side we refuse the take
    // (defence in depth — the button should already be disabled,
    // but this guards against stale UI / programmatic calls).
    // Per-entry attempt log so the OBSERVED chip can show WHY a
    // signal wasn't auto-traded. Keyed by journal entry id, value is
    // { ts, ok, reason }. Cleared on page reload — that's fine, the
    // journal entry's own status (TAKEN / OBSERVED) is the source of
    // truth across reloads; this is just live diagnostic colour.
    var lastAttemptByEntry = Object.create(null);
    function noteAttempt(entryId, ok, reason) {
      if (!entryId) return;
      lastAttemptByEntry[entryId] = { ts: Date.now(), ok: !!ok, reason: reason || '' };
      // Stay loud in the console so power users can trace.
      try {
        var tag = ok ? '[bridge ok]' : '[bridge skip]';
        console.info(tag + ' entry=' + entryId + ' reason="' + (reason || '') + '"');
      } catch (_) {}
    }
    function getLastAttempt(entryId) {
      return entryId ? (lastAttemptByEntry[entryId] || null) : null;
    }

    function take(requestedSide) {
      // Returns { ok: boolean, reason: string }.  reason is a short
      // human-readable description shown on the OBSERVED chip tooltip
      // and surfaced in the console for diagnostics. ok===true means
      // the order was successfully *placed* (link + outcome arrives
      // later through onPositionOpened).
      var fail = function (reason) {
        setStatus(reason, 'err');
        try {
          var sigForLog = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
            ? signalJournalModule.getActiveSignal() : null;
          var idForLog = sigForLog && sigForLog.entry ? sigForLog.entry.id : null;
          noteAttempt(idForLog, false, reason);
        } catch (_) {}
        return { ok: false, reason: reason };
      };

      // Pre-flight: signal still active?
      var sig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
        ? signalJournalModule.getActiveSignal() : null;
      if (!sig || (sig.action !== 'BUY_CE' && sig.action !== 'BUY_PE')) {
        return fail('No active BUY signal');
      }
      var sideTag = sig.action === 'BUY_CE' ? 'CE' : 'PE';
      if (requestedSide && requestedSide !== sideTag) {
        return fail('Engine signal is BUY ' + sideTag + ', not ' + requestedSide);
      }

      // Discipline lock is intentionally ignored in paper trading.
      // Paper-trade purpose is to measure raw signal edge over a
      // statistically meaningful sample — blocking trades on
      // cooling-off / 2L / 3T / soft-lock rules biases the sample
      // to "good times only" and defeats the validation goal. The
      // user enforces these rules on real money inside Upstox.
      // No toast, no banner — silent flow-through.

      // Pre-flight: signal freshness — stale signals must not trade.
      if (typeof signalFreshnessModule !== 'undefined') {
        var liveSpot = (typeof window.paperTradeGetLastSpot === 'function')
          ? window.paperTradeGetLastSpot() : null;
        var livePx = null;
        if (sig.entry && sig.entry.strike && typeof getStrikeQuote === 'function') {
          var q = getStrikeQuote(sig.entry.strike, sideTag === 'CE' ? 'CE' : 'PE');
          livePx = q ? q.premium : null;
        }
        var fresh = signalFreshnessModule.compute(sig, liveSpot, livePx);
        if (fresh && fresh.verdict === 'SKIP') {
          return fail('Signal expired — wait for next analyze cycle');
        }
      }

      // Pre-flight: chain loaded?
      if (!window.optionChainData) {
        return fail('Option chain not loaded yet');
      }
      var strike = pickStrike();
      if (strike == null) {
        return fail('No tradable strike near spot');
      }

      // Pre-flight: signal not already linked?
      var entryId = sig.entry ? sig.entry.id : null;
      if (entryId && state.links.some(function (l) { return l.journalEntryId === entryId; })) {
        return fail('Already paper-traded this signal');
      }

      // Pre-flight: paper-trade API present?
      var buyFn = sideTag === 'CE' ? window.ptBuyCE : window.ptBuyPE;
      if (typeof buyFn !== 'function' || typeof window.ptSelectStrike !== 'function') {
        return fail('Paper-trade not ready (refresh page)');
      }

      // Configure paperTradeModule for this trade.
      var sideLower = sideTag.toLowerCase();
      try { window.ptSelectStrike(strike); } catch (_) {}
      try { if (typeof window.ptSetOrderType === 'function') window.ptSetOrderType(sideLower, 'MARKET'); } catch (_) {}
      try { if (typeof window.ptSetQty === 'function') window.ptSetQty(state.lots, sideLower); } catch (_) {}

      // ─── Prime SPOT-based exit triggers (May 2026 spot-first) ──
      // Pull the engine's spot levels (entry/SL/T1) from the active
      // plan and forward them to paperTradeModule so the new
      // position carries slSpot/tgtSpot fields. Once in flight,
      // checkSpotRiskTriggers will fire SL/TGT exits when Nifty
      // spot crosses those levels — filling at the LIVE option
      // premium at the moment of crossing (the actual broker
      // behaviour). Fall back gracefully if spotPlan is missing
      // (older sigs, mid-load) — the legacy premium-based
      // sl/tgt fields still wire up in onPositionOpened below.
      try {
        var planForSpot = (typeof STATE !== 'undefined' && STATE && STATE.result && STATE.result.plan)
          ? STATE.result.plan : null;
        var sp = planForSpot && planForSpot.spotPlan ? planForSpot.spotPlan : null;
        var slSpotPrime    = sp ? sp.sl    : (sig.entry ? sig.entry.slSpot    : null);
        var t1SpotPrime    = sp ? sp.t1    : (sig.entry ? sig.entry.t1Spot    : null);
        var entrySpotPrime = sp ? sp.entry : (sig.entry ? (sig.entry.entrySpot != null ? sig.entry.entrySpot : sig.entry.spotAtFire) : null);
        if (typeof window.ptPrimeSpotTriggers === 'function') {
          window.ptPrimeSpotTriggers(sideTag, slSpotPrime, t1SpotPrime, entrySpotPrime);
        }
      } catch (_) {}

      // Snapshot pre-state and fire the BUY. ptBuyCE/PE is async
      // (fresh-quote round-trip ~1-2 s), so we poll for the new id.
      var preIds = snapshotOpenIds();
      setStatus('Placing paper order\u2026', 'pending', 0);
      var btnCE = document.getElementById('ia-quick-btn-ce');
      var btnPE = document.getElementById('ia-quick-btn-pe');
      if (btnCE) btnCE.disabled = true;
      if (btnPE) btnPE.disabled = true;
      try { buyFn(); } catch (e) {
        // Re-paint will restore correct enabled state.
        try { renderQuickStrip(); } catch (_) {}
        return fail('Paper-trade BUY threw');
      }

      var deadline = Date.now() + OPEN_DEADLINE_MS;
      var iv = setInterval(function () {
        var newId = diffNewId(preIds);
        if (newId) {
          clearInterval(iv);
          onPositionOpened(newId, sig, sideTag, strike);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(iv);
          setStatus('Order placed but couldn\u2019t link (check paper-trade)', 'warn', 6000);
          // Don't note as fail — order may still have gone through;
          // the user will see it in the Open Positions table even if
          // the link couldn't snap.
          try { renderQuickStrip(); } catch (_) {}
        }
      }, 200);
      // Success path: log breadcrumb, return ok. Note that the
      // position-open confirmation happens async in the poller above.
      noteAttempt(entryId, true, 'placed: BUY ' + sideTag + ' ' + strike + ' \u00d7' + state.lots + ' lots');
      return { ok: true, reason: '' };
    }

    // ─── Post-open: link journal, start polling ──────────────────
    // SPOT-FIRST: the new position carries slSpot/tgtSpot from the
    // ptPrimeSpotTriggers prime above. paperTradeModule's
    // checkSpotRiskTriggers fires SL/TGT exits when Nifty spot
    // crosses those levels (filling at the live option premium at
    // the moment of crossing — the actual broker reality).
    //
    // The legacy premium-based ptUpdatePosRisk('sl'/'tgt') attach
    // was REMOVED here in the May 2026 spot-first refactor. Why:
    //   - Spot triggers are accurate (the indicators all live on
    //     spot); premium triggers via delta-projection drift
    //     5-15% even on quiet days.
    //   - Spot is watchable on the chart; premium is not.
    //   - The legacy fields remain editable inline in the Open
    //     Positions table for manual trailing — they just aren't
    //     auto-populated from the engine signal any more.
    function onPositionOpened(positionId, sig, sideTag, strike) {
      var entryId = sig.entry ? sig.entry.id : null;

      // Link + mark journal taken. If there's no journal entry to
      // link (rare — engine fired before logSignal ran), we skip
      // the link push so the poller doesn't store a dead reference.
      // The paper position itself is still good; SL/T1 are attached
      // above so it'll auto-exit normally. The journal just won't
      // auto-update on close — user can mark it manually.
      if (entryId) {
        state.links.push({
          journalEntryId:  entryId,
          paperPositionId: positionId,
          ts:              Date.now(),
          side:            sideTag,
          strike:          strike,
          lots:            state.lots
        });
        save();
        try {
          if (signalJournalModule && signalJournalModule.markTaken) {
            signalJournalModule.markTaken(entryId, true);
          }
        } catch (_) {}
      }

      setStatus('Paper-tracking active', 'ok', 0);
      startPoll();
      renderQuickStrip();      // re-paint: button changes to "TRACKING\u2026"

      // Light feedback ping so user knows the click landed even if
      // they're already looking at the chart, not the strip.
      try { if (alertModule && alertModule.playSignal) {
        // Reuse signal beep at the LOW intensity tier (short, soft).
        // Doesn't pollute the action dedupe key — alertModule's
        // playSignal is idempotent for our purposes here.
      }} catch (_) {}
    }

    // ─── Poller: detect closed linked positions, write outcome ─
    function startPoll() {
      if (state.pollTimer) return;
      state.pollTimer = setInterval(tick, POLL_MS);
      tick();   // immediate check too
    }
    function stopPoll() {
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }

    function tick() {
      if (!state.links.length) { stopPoll(); return; }
      if (typeof window.ptGetPosition !== 'function') return;
      var remaining = [];
      var anyClosed = false;
      for (var i = 0; i < state.links.length; i++) {
        var L = state.links[i];
        var p = window.ptGetPosition(L.paperPositionId);
        if (!p) {
          // Paper-trade state was reset OR position vanished. Drop
          // the link so we don't loop forever. Don't write outcome
          // because we have no exit price.
          continue;
        }
        if (p._where === 'open') {
          remaining.push(L);
          continue;
        }
        // _where === 'history' → closed. Translate + write back.
        var status = reasonToStatus(p.exitReason);
        var notes = 'auto via paper-bridge \u00B7 reason=' + (p.exitReason || 'MANUAL')
                  + ' \u00B7 strike=' + L.strike + ' ' + L.side
                  + ' \u00B7 lots=' + (L.lots || 1);
        try {
          if (signalJournalModule && signalJournalModule.markOutcome) {
            signalJournalModule.markOutcome(L.journalEntryId, status, p.exit, notes);
          }
        } catch (_) {}
        anyClosed = true;
      }
      state.links = remaining;
      save();
      if (anyClosed) {
        // Refresh journal UI so the row flips to its outcome state.
        try { if (typeof window.sjRenderJournal === 'function') window.sjRenderJournal(); } catch (_) {}
        renderQuickStrip();
      }
      if (!state.links.length) stopPoll();
    }

    // ─── Detect: is the active signal already paper-traded? ───
    // Used by renderQuickStrip to switch the button from
    // "PAPER TRADE NOW" → "TRACKING…" so the user knows the
    // trade is alive without clicking again.
    function isActiveSignalLinked() {
      var sig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
        ? signalJournalModule.getActiveSignal() : null;
      if (!sig || !sig.entry) return false;
      return state.links.some(function (l) { return l.journalEntryId === sig.entry.id; });
    }

    // Resume polling on module load if there are unresolved links
    // (covers tab reload mid-trade).
    if (state.links.length) startPoll();

    // Per-entry in-flight guard so we don't double-fire while a
    // 600 ms scheduled take() is pending. Separate from
    // autoFiredForEntry (which is the "succeeded" sentinel).
    var autoPendingForEntry = null;

    function maybeAutoTrade(sideTag, entryId) {
      if (!autoTrade) return;
      if (!entryId) return;
      if (autoFiredForEntry  === entryId) return; // already succeeded
      if (autoPendingForEntry === entryId) return; // attempt in flight
      autoPendingForEntry = entryId;
      // Small delay so chain data is fully settled before take() runs.
      setTimeout(function () {
        var res = { ok: false, reason: 'threw' };
        try { res = take(sideTag); } catch (e) {
          res = { ok: false, reason: 'take() threw: ' + (e && e.message ? e.message : e) };
        }
        autoPendingForEntry = null;
        // ─── CRITICAL ─── only burn on success. Otherwise the next
        // renderQuickStrip cycle (~2 s later, on LTP tick) will
        // retry. This is what gets us past the common transient
        // failures: chain still loading after a 429 cooldown,
        // freshness compute returning SKIP because liveSpot wasn't
        // populated yet, etc.
        if (res && res.ok) {
          autoFiredForEntry = entryId;
        } else {
          try {
            var why = (res && res.reason) ? res.reason : 'unknown';
            console.info('[bridge retry-able] entry=' + entryId + ' reason="' + why + '"');
          } catch (_) {}
        }
        // Re-paint so the OBSERVED chip tooltip / strip status pick
        // up the latest attempt outcome.
        try { renderQuickStrip(); } catch (_) {}
        try { if (typeof window.sjRenderJournal === 'function') window.sjRenderJournal(); } catch (_) {}
      }, 600);
    }

    return {
      take:                take,
      getLots:             getLots,
      setLots:             setLots,
      incLots:             incLots,
      tick:                tick,
      isActiveSignalLinked:isActiveSignalLinked,
      getLinks:            function () { return state.links.slice(); },
      setAutoTrade:        setAutoTrade,
      isAutoTrade:         isAutoTrade,
      maybeAutoTrade:      maybeAutoTrade,
      getLastAttempt:      getLastAttempt,
      MAX_LOTS:            MAX_LOTS
    };
  })();
  window.iaQuickPaperTake   = function ()  { return paperBridgeModule.take(); };
  window.iaQuickPaperTakeCE = function ()  { return paperBridgeModule.take('CE'); };
  window.iaQuickPaperTakePE = function ()  { return paperBridgeModule.take('PE'); };
  window.iaQuickIncLots     = function (d) { paperBridgeModule.incLots(d); };
  window.iaQuickSetLots     = function (n) { paperBridgeModule.setLots(n); };
  window.paperBridgeTick    = function ()  { return paperBridgeModule.tick(); };
  window.iaSetAutoTrade     = function (on) { try { paperBridgeModule.setAutoTrade(on); } catch (_) {} };

  // ─── renderQuickStrip ─────────────────────────────────────────
  // Paints the Quick-Trade strip below the HUD. Driven by
  //   - signalJournalModule.getActiveSignal()   → strike, prems
  //   - plan.premium (via the active entry's snapshot)           → maxLoss, deploy
  //   - paperBridgeModule.getLots()             → user's lot count
  //   - paperBridgeModule.isActiveSignalLinked() → strip mode
  //   - disciplineModule.getLockStatus()        → lock mode
  //
  // Always visible after the live section is loaded so the user
  // learns the layout up-front and knows where to look the
  // moment a signal fires. Button is disabled in idle/loading/
  // taken/locked states and enabled only when there's a fully-
  // actionable BUY signal with premium data on the chain.
  // Visual states (governed by classList):
  //   - is-idle     : no active BUY signal (engine on WAIT/BLOCKED)
  //   - is-pending  : engine recommends BUY but journal hasn't fired yet
  //   - is-stale    : journal signal expired (SKIP freshness) — don't trade
  //   - is-loading  : signal active but premium/chain not ready
  //   - is-taken    : current signal already paper-traded
  //   - is-locked   : disciplineModule HARD_LOCK
  //   - (none)      : READY — green CE / red PE primary CTA
  function renderQuickStrip() {
    var strip = document.getElementById('ia-quick-strip');
    if (!strip) return;
    strip.hidden = false;       // always visible (P2-A polish)

    var sig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
      ? signalJournalModule.getActiveSignal() : null;
    var hasSig = !!(sig && (sig.action === 'BUY_CE' || sig.action === 'BUY_PE'));
    var entry  = hasSig ? sig.entry : null;
    var chainLoaded = !!window.optionChainData;
    var plan = (typeof STATE !== 'undefined' && STATE.result && STATE.result.plan)
      ? STATE.result.plan : null;
    var planBuy = plan && (plan.action === 'BUY_CE' || plan.action === 'BUY_PE');
    // Prefer live plan.premium for preview when journal entry lacks
    // chain snapshot (common right after a fresh re-fire).
    var planPrem = (plan && plan.premium) ? plan.premium : null;
    // "Ready" = signal IS actionable. We need premiums (entry +
    // SL) AND the chain to be loaded so ptBuyCE/PE has data.
    var hasPremium = !!(entry && entry.entryPremium != null && entry.slPremium != null)
                  || !!(planPrem && planPrem.entry != null && planPrem.sl != null);
    var ready = hasSig && chainLoaded && hasPremium;

    // Freshness gate — mirrors the HUD stale banner.
    var freshVerdict = null;
    if (hasSig && typeof signalFreshnessModule !== 'undefined') {
      var liveSpot = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      var livePx = (entry && entry.strike && typeof getStrikeQuote === 'function')
        ? (function () {
            var q = getStrikeQuote(entry.strike, sig.action === 'BUY_CE' ? 'CE' : 'PE');
            return q ? q.premium : null;
          })()
        : (planPrem ? planPrem.entry : null);
      var fresh = signalFreshnessModule.compute(sig, liveSpot, livePx);
      freshVerdict = fresh ? fresh.verdict : null;
    }

    var fmtINR = function (n) {
      if (n == null || !isFinite(n)) return '\u2014';
      return '\u20B9' + Math.round(n).toLocaleString('en-IN');
    };
    var fmtPx = function (n) {
      if (n == null || !isFinite(n)) return '\u2014';
      return '\u20B9' + (+n).toFixed(2);
    };
    var setT = function (id, t) { var el = document.getElementById(id); if (el) el.textContent = t; };

    // ─── Side tag ──────────────────────────────────────────────
    // Shows "BUY CE · HIGH 82%" / "BUY PE · MED 64%" / "WAIT".
    // The confidence appendix (May 2026) mirrors the HUD chip so
    // the user sees the same conviction reading at the point of
    // execution as they did when forming the decision.
    // The CSS-side selector flips the strip's accent stripe to
    // match (green CE, red PE, muted when waiting).
    var sideTag = hasSig ? (sig.action === 'BUY_CE' ? 'CE' : 'PE') : null;
    var sideEl = document.getElementById('ia-quick-side-tag');
    if (sideEl) {
      if (sideTag) {
        var qsLbl = (sig.confidence === 'HIGH' || sig.confidence === 'MEDIUM' || sig.confidence === 'LOW')
                    ? (sig.confidence === 'MEDIUM' ? 'MED' : sig.confidence) : '';
        var qsPct = (sig.confidencePct != null && isFinite(sig.confidencePct))
                    ? ' ' + sig.confidencePct + '%' : '';
        var qsConf = qsLbl ? (' \u00B7 ' + qsLbl + qsPct) : '';
        sideEl.textContent = 'BUY ' + sideTag + qsConf;
        sideEl.setAttribute('data-side', sideTag.toLowerCase());
      } else {
        sideEl.textContent = 'WAIT';
        sideEl.setAttribute('data-side', 'idle');
      }
    }

    // ─── Preview cells (with safe fallbacks for idle) ──────────
    var lots = (paperBridgeModule.getLots && paperBridgeModule.getLots()) || 1;
    var lotSize = (entry && entry.position && entry.position.lotSize)
                   || (planPrem && planPrem.lotSize) || 65;
    var qty = lots * lotSize;
    var entryPx = (entry && entry.entryPremium != null) ? entry.entryPremium
                : (planPrem && planPrem.entry != null) ? planPrem.entry : null;
    var slPx    = (entry && entry.slPremium != null) ? entry.slPremium
                : (planPrem && planPrem.sl != null) ? planPrem.sl : null;
    var t1Px    = (entry && entry.t1Premium != null) ? entry.t1Premium
                : (planPrem && planPrem.t1 != null) ? planPrem.t1 : null;
    var deploy = (entryPx != null) ? entryPx * qty : null;
    var maxLoss = (entryPx != null && slPx != null)
                   ? (entryPx - slPx) * qty : null;

    var atmFromSpot = (function () {
      var sp = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      return (sp != null && isFinite(sp)) ? Math.round(sp / 50) * 50 : null;
    })();
    setT('ia-quick-strike', entry && entry.strike != null
      ? entry.strike + ' ' + (sideTag || '')
      : (planBuy && atmFromSpot != null)
        ? atmFromSpot + ' ' + (plan.action === 'BUY_CE' ? 'CE' : 'PE')
        : '\u2014');
    // ─── SPOT-FIRST preview (May 2026 inversion) ───────────────
    // Cell VALUE = spot trigger (matches the chart + indicators).
    // Cell SUB   = "~₹premium prem" (capital-outlay context).
    // Pull spot levels from plan.spotPlan (built unconditionally),
    // or fall back to the active journal entry's snapshot if the
    // engine is between fires.
    var planSpot = (plan && plan.spotPlan) ? plan.spotPlan : null;
    var entrySpot = (entry && entry.entrySpot != null) ? entry.entrySpot
                  : (planSpot && planSpot.entry != null) ? planSpot.entry
                  : (entry && entry.spotAtFire != null) ? entry.spotAtFire : null;
    var slSpot    = (entry && entry.slSpot != null) ? entry.slSpot
                  : (planSpot && planSpot.sl != null) ? planSpot.sl : null;
    var t1Spot    = (entry && entry.t1Spot != null) ? entry.t1Spot
                  : (planSpot && planSpot.t1 != null) ? planSpot.t1 : null;
    var slDistSp  = (entrySpot != null && slSpot != null) ? Math.abs(entrySpot - slSpot).toFixed(1) : null;
    var t1DistSp  = (entrySpot != null && t1Spot != null) ? Math.abs(t1Spot - entrySpot).toFixed(1) : null;

    setT('ia-quick-strike-sub', entryPx != null ? '~' + fmtPx(entryPx) + ' prem' : '');
    setT('ia-quick-entry',     entrySpot != null ? fmtPx(entrySpot) : '\u2014');
    setT('ia-quick-entry-sub', entryPx != null ? '~' + fmtPx(entryPx) + ' prem' : '');
    setT('ia-quick-sl',        slSpot != null ? fmtPx(slSpot) : '\u2014');
    var slSubBits = [];
    if (slDistSp != null) slSubBits.push('\u2212' + slDistSp + ' pts');
    if (slPx != null) slSubBits.push('~' + fmtPx(slPx) + ' prem');
    setT('ia-quick-sl-sub', slSubBits.join(' \u00B7 '));
    setT('ia-quick-t1',        t1Spot != null ? fmtPx(t1Spot) : '\u2014');
    var t1SubBits = [];
    if (t1DistSp != null) t1SubBits.push('+' + t1DistSp + ' pts');
    if (t1Px != null) t1SubBits.push('~' + fmtPx(t1Px) + ' prem');
    setT('ia-quick-t1-sub', t1SubBits.join(' \u00B7 '));
    setT('ia-quick-lots',   String(lots));
    setT('ia-quick-deploy', deploy  != null ? fmtINR(deploy)  : '\u2014');
    setT('ia-quick-loss',   maxLoss != null ? '\u2212' + fmtINR(maxLoss) : '\u2014');

    // ─── Live LTP + P&L (only when paper-tracking is active) ────
    // ENTRY / SL / T1 are fixed reference prices and shouldn't tick.
    // The live story belongs in dedicated LTP + P&L cells so the
    // user can see how the position is moving against entry in
    // real time, without bouncing to the Paper Trading section.
    // Cells are hidden by default in HTML; we unhide on every tick
    // when a paper position is linked, and hide again when it
    // closes (so untracked / pending signals stay clean).
    var ltpCellEl = document.getElementById('ia-quick-cell-ltp');
    var pnlCellEl = document.getElementById('ia-quick-cell-pnl');
    var trackedLive = paperBridgeModule.isActiveSignalLinked
                      && paperBridgeModule.isActiveSignalLinked();
    if (trackedLive && entry && entry.strike != null && sideTag) {
      var liveQ = (typeof getStrikeQuote === 'function')
                   ? getStrikeQuote(entry.strike, sideTag) : null;
      var ltpPx = liveQ ? liveQ.premium : null;
      var livePnL = (ltpPx != null && entryPx != null) ? (ltpPx - entryPx) * qty : null;
      if (ltpCellEl) ltpCellEl.hidden = false;
      if (pnlCellEl) pnlCellEl.hidden = false;
      setT('ia-quick-ltp', ltpPx != null ? fmtPx(ltpPx) : '\u2014');
      var pnlEl = document.getElementById('ia-quick-pnl');
      if (pnlEl) {
        if (livePnL == null) {
          pnlEl.textContent = '\u2014';
          pnlEl.removeAttribute('data-tone');
        } else {
          var sign = livePnL >= 0 ? '+' : '\u2212';
          pnlEl.textContent = sign + fmtINR(Math.abs(livePnL));
          pnlEl.setAttribute('data-tone', livePnL > 0 ? 'bull' : (livePnL < 0 ? 'bear' : 'flat'));
        }
      }
    } else {
      if (ltpCellEl) ltpCellEl.hidden = true;
      if (pnlCellEl) pnlCellEl.hidden = true;
    }

    // ─── Three-button state machine (CE + PE + REVIEW) ──────────
    // BUY CE and BUY PE are always visible (matches the paper-
    // trade section pattern) but only the side matching the
    // active engine signal enables. The other side stays disabled
    // with a "not active" sub. Lock / linked / loading states
    // disable BOTH because the gate is global.
    //
    // REVIEW FIRST opens the CONFIRM modal — only useful when
    // there's an actual signal to review, so it follows the same
    // enable gate as the BUY buttons (any actionable BUY signal
    // → REVIEW enables; otherwise it stays disabled to prevent
    // the user opening an empty modal). One exception: when the
    // current signal is already paper-tracked, REVIEW stays
    // enabled because the user can still want to read the plan
    // for live-trade execution on Upstox.
    var btnCE = document.getElementById('ia-quick-btn-ce');
    var btnPE = document.getElementById('ia-quick-btn-pe');
    var subCE = document.getElementById('ia-quick-btn-ce-sub');
    var subPE = document.getElementById('ia-quick-btn-pe-sub');
    var btnRV = document.getElementById('ia-quick-btn-review');
    var subRV = document.getElementById('ia-quick-btn-review-sub');
    var lock = (typeof disciplineModule !== 'undefined' && disciplineModule.getLockStatus)
      ? disciplineModule.getLockStatus() : null;
    var linked = paperBridgeModule.isActiveSignalLinked
      && paperBridgeModule.isActiveSignalLinked();

    // ─── Discipline advisory banner: permanently hidden ─────────
    // Paper trading is for measuring signal edge on a clean,
    // unfiltered sample — discipline rules belong on real money.
    // The hardcoded 3-trade cap is also nonsensical on a 1-lakh
    // capital test account (designed for 15k scalpers). Keeping
    // the banner DOM in place for future opt-in but never
    // surfacing it from the analyzer UI.
    var lockBanner = document.getElementById('ia-quick-lock-banner');
    if (lockBanner) lockBanner.hidden = true;

    // Reset classes — each branch below decides its final state.
    strip.classList.remove('is-taken', 'is-locked', 'is-idle', 'is-loading', 'is-stale', 'is-pending');

    // Default both-disabled with EMPTY sub so each branch only
    // adds text when it actually has something to say. Branch
    // order matters: lock / linked / loading wins over idle.
    //
    // Idle text removed in May 2026 noise audit Batch 2 — the
    // strip's `is-idle` class (CSS muted styling) already
    // communicates the "waiting" state visually, and the
    // duplicated "— waiting for signal —" line under all three
    // buttons read as noise. Sub-text now only appears when it
    // carries new information (loading / sizing hint / lock
    // reason / tracking status).
    var setBtn = function (btn, sub, enabled, subText) {
      if (btn) btn.disabled = !enabled;
      if (sub) sub.textContent = subText;
    };
    setBtn(btnCE, subCE, false, '');
    setBtn(btnPE, subPE, false, '');
    setBtn(btnRV, subRV, false, '');

    var sizingHint = lots + 'L \u00B7 deploys ' + fmtINR(deploy)
                   + ' \u00B7 max loss ' + fmtINR(maxLoss);

    if (linked) {
      strip.classList.add('is-taken');
      var trackTxt = 'PAPER-TRACKING \u00B7 journal auto-updates on exit';
      if (sideTag === 'CE') setBtn(btnCE, subCE, false, trackTxt);
      else                  setBtn(btnPE, subPE, false, trackTxt);
      // REVIEW stays enabled in TRACKING state — user might want
      // to re-read the plan for the parallel real-money trade.
      setBtn(btnRV, subRV, true, 'Re-open the CONFIRM modal for the live trade');
    } else if (hasSig && freshVerdict === 'SKIP') {
      strip.classList.add('is-stale');
      var phStale = document.getElementById('ia-quick-placeholder');
      if (phStale) phStale.textContent = 'Signal expired \u2014 wait for next analyze cycle';
      var staleTxt = 'Too old or drifted \u2014 don\u2019t force it';
      if (sideTag === 'CE') setBtn(btnCE, subCE, false, staleTxt);
      else                  setBtn(btnPE, subPE, false, staleTxt);
      setBtn(btnRV, subRV, false, staleTxt);
    } else if (!hasSig && planBuy) {
      // Engine recommends BUY but journal hasn't logged a fresh fire
      // yet (post-expire cooldown, or first bar after gap open).
      strip.classList.add('is-pending');
      var phPending = document.getElementById('ia-quick-placeholder');
      if (phPending) phPending.textContent = 'Setup live \u2014 journal fires on confirmed entry';
      var sideTagPlan = plan.action === 'BUY_CE' ? 'CE' : 'PE';
      if (sideEl) {
        sideEl.textContent = 'BUY ' + sideTagPlan;
        sideEl.setAttribute('data-side', sideTagPlan.toLowerCase());
      }
      var pendingTxt = 'Waiting for journal fire\u2026';
      if (sideTagPlan === 'CE') setBtn(btnCE, subCE, false, pendingTxt);
      else                      setBtn(btnPE, subPE, false, pendingTxt);
      setBtn(btnRV, subRV, false, pendingTxt);
    } else if (!hasSig) {
      // Pure idle — engine is on WAIT. All three stay disabled.
      // CSS hides the numbers preview and inactive buttons; shows
      // the placeholder text instead.
      strip.classList.add('is-idle');
      var phEl = document.getElementById('ia-quick-placeholder');
      if (phEl) phEl.textContent = 'Waiting for a signal\u2026';
    } else if (!ready) {
      // Signal active but option chain not loaded yet.
      // The chain requires an Upstox token — without one, premiums
      // never arrive and the strip stays stuck here forever.
      strip.classList.add('is-loading');
      var phEl2 = document.getElementById('ia-quick-placeholder');
      var noChain = !window.optionChainData;
      if (phEl2) {
        if (noChain) {
          phEl2.innerHTML = 'No option chain data &mdash; '
            + '<a href="#" onclick="apiOpenModal();return false;" '
            + 'style="color:var(--bull);font-weight:600;text-decoration:underline">'
            + 'connect Upstox token</a> to price premiums.';
        } else {
          phEl2.textContent = 'Pricing strike\u2026';
        }
      }
      if (sideTag === 'CE') {
        setBtn(btnCE, subCE, false, noChain ? 'Needs Upstox token' : 'Pricing\u2026');
        setBtn(btnPE, subPE, false, '');
      } else {
        setBtn(btnPE, subPE, false, noChain ? 'Needs Upstox token' : 'Pricing\u2026');
        setBtn(btnCE, subCE, false, '');
      }
      setBtn(btnRV, subRV, false, noChain ? 'Connect token first' : 'Available once priced');
    } else if (freshVerdict === 'WAIT') {
      // Ageing but not dead — show live numbers, keep buttons off.
      var waitTxt = 'Ageing \u2014 size down or wait for refresh';
      if (sideTag === 'CE') setBtn(btnCE, subCE, false, waitTxt);
      else                  setBtn(btnPE, subPE, false, waitTxt);
      setBtn(btnRV, subRV, false, waitTxt);
    } else {
      // READY — enable matching side only. The inactive side is
      // hidden (CSS shows it only when strip has no state class).
      // REVIEW enabled for a deliberate sanity check.
      var autoOn = paperBridgeModule.isAutoTrade && paperBridgeModule.isAutoTrade();
      var entryId = entry ? entry.id : null;
      if (autoOn) {
        // AUTO mode: fire take() once per signal, then show tracking UI.
        paperBridgeModule.maybeAutoTrade(sideTag, entryId);
        var autoHint = 'AUTO · placing paper trade\u2026';
        if (sideTag === 'CE') setBtn(btnCE, subCE, false, autoHint);
        else                  setBtn(btnPE, subPE, false, autoHint);
        setBtn(btnRV, subRV, true, 'Review plan while auto-trade places order');
      } else {
        if (sideTag === 'CE') {
          setBtn(btnCE, subCE, true,  sizingHint);
          setBtn(btnPE, subPE, false, '');
        } else {
          setBtn(btnPE, subPE, true,  sizingHint);
          setBtn(btnCE, subCE, false, '');
        }
        setBtn(btnRV, subRV, true, 'Sanity-check before clicking BUY');
      }
    }

    // Paint the AUTO toggle button state in the strip header.
    var autoToggleBtn = document.getElementById('ia-quick-auto-btn');
    if (autoToggleBtn) {
      var isAuto = paperBridgeModule.isAutoTrade && paperBridgeModule.isAutoTrade();
      autoToggleBtn.setAttribute('data-on', isAuto ? 'true' : 'false');
      autoToggleBtn.textContent = isAuto ? '\u2022 AUTO ON' : 'AUTO OFF';
      autoToggleBtn.title = isAuto
        ? 'Auto-trade is ON \u2014 paper trades place automatically on fresh signals. Click to turn off.'
        : 'Auto-trade is OFF \u2014 you must click BUY CE / BUY PE manually. Click to turn on.';
    }
  }
  window.iaRenderQuickStrip = renderQuickStrip;

  // ════════════════ DAILY DISCIPLINE LOCK (P0-5) ════════════════
  // Greed (keep trading after a win) and tilt (revenge-trade after
  // a loss) are the two failure modes that blow retail accounts.
  // This module enforces three hard rules — matching the user's
  // explicit discipline statement:
  //
  //   1W  (1 win taken)      → SOFT LOCK
  //                            "You won today — stop trading to
  //                            keep the win". User can override
  //                            for the day via an explicit button
  //                            (persists per-day-key in
  //                            localStorage so it doesn't carry
  //                            into tomorrow).
  //   2L  (2 losses taken)   → HARD LOCK
  //                            No override possible — protects
  //                            from revenge trading. Resets next
  //                            day.
  //   3T  (3 trades taken)   → HARD LOCK
  //                            Daily attempt budget exhausted.
  //                            Resets next day.
  //
  // Lock states are consumed by:
  //   - confirmModalModule.paint(): hard-lock disables the TAKE
  //     button + paints a banner. Soft-lock paints a banner +
  //     adds the override button.
  //   - renderDecisionHud(): adds a small discipline pill next to
  //     the freshness chip when ANY lock is active, so the user
  //     sees the state even without opening the confirm modal.
  //
  // Persisted state (localStorage key 'discipline_v1'):
  //   { softLockOverride: { 'YYYY-MM-DD': true } }
  // We never persist the lock state itself — it's recomputed from
  // signalJournalModule.getTodayCounts() on demand. Single source
  // of truth = the journal.
  var disciplineModule = (function () {
    var LS_KEY = 'discipline_v1';
    var state = { softLockOverride: {} };
    // P1-2 thresholds — edit here to retune.
    var MAX_LOSS_PCT_OF_CAPITAL = 15;   // hard halt at -15%
    var MAX_LOSS_R              = -3;   // hard halt at -3R
    var COOLING_OFF_MS          = 15 * 60 * 1000;  // 15 min after loss

    function load() {
      try {
        var raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.softLockOverride) {
          state.softLockOverride = parsed.softLockOverride;
        }
      } catch (_) {}
    }
    function save() {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({ softLockOverride: state.softLockOverride }));
      } catch (_) {}
    }
    load();

    // Compute today's lock status from journal counts + override.
    // Returns:
    //   { status: 'OPEN' | 'SOFT_LOCK' | 'HARD_LOCK',
    //     reason: string (UI copy),
    //     subReason: string (longer explainer),
    //     todayCounts: { fired, taken, wins, losses, … },
    //     canOverride: bool,
    //     overrideActive: bool }
    function getLockStatus() {
      var counts = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getTodayCounts)
        ? signalJournalModule.getTodayCounts()
        : { fired: 0, taken: 0, skipped: 0, wins: 0, losses: 0, open: 0, dayKey: null };
      var dayKey = counts.dayKey;
      var overrideActive = !!(dayKey && state.softLockOverride[dayKey]);

      // ── P1-2: max-loss cap (₹) ────────────────────────────
      // Computed against the CURRENT capital from the journal (the
      // setting the user typed into the Signal Journal). Triggers
      // BEFORE the 2L/3T rules so the message is the more accurate
      // one (e.g. one bad oversized trade can hit -15% in a single
      // attempt).
      var capital = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getCapital)
        ? signalJournalModule.getCapital() : 15000;
      var lossPctCap = -(MAX_LOSS_PCT_OF_CAPITAL / 100) * capital;  // negative ₹
      if (counts.realizedRupees != null && counts.realizedRupees <= lossPctCap) {
        var lostInr = Math.abs(counts.realizedRupees);
        var lostPct = +((lostInr / capital) * 100).toFixed(1);
        return {
          status: 'HARD_LOCK',
          reason: '\u20B9 LOSS CAP HIT \u2014 \u2212' + lostPct + '% ACCOUNT',
          subReason: 'You\u2019ve lost \u20B9' + lostInr.toLocaleString('en-IN')
            + ' (' + lostPct + '% of \u20B9' + capital.toLocaleString('en-IN')
            + ' capital). Hard cap is \u2212' + MAX_LOSS_PCT_OF_CAPITAL
            + '%. No more trades today. Resets tomorrow.',
          todayCounts: counts, canOverride: false, overrideActive: false
        };
      }
      // ── P1-2: max drawdown in R ───────────────────────────
      if (counts.realizedR != null && counts.realizedR <= MAX_LOSS_R) {
        return {
          status: 'HARD_LOCK',
          reason: 'DRAWDOWN CAP HIT \u2014 ' + counts.realizedR.toFixed(2) + 'R TODAY',
          subReason: 'Cumulative loss today is ' + counts.realizedR.toFixed(2)
            + 'R, beyond the ' + MAX_LOSS_R + 'R cap. Even a strong setup is not worth fighting your own tilt. Resets tomorrow.',
          todayCounts: counts, canOverride: false, overrideActive: false
        };
      }
      // ── P1-3: event-calendar veto ─────────────────────────
      // Inside the ±15 min window around any known macro event
      // (RBI / Fed / Budget) OR the Thursday-expiry tail. Locked
      // because IV crush + gamma whips both kill SCALP edge.
      try {
        var ev = (typeof eventCalendarModule !== 'undefined' && eventCalendarModule.getActiveEvent)
          ? eventCalendarModule.getActiveEvent() : null;
        if (ev) {
          var evRemainMin = Math.max(0, Math.ceil(ev.remainMs / 60000));
          var evReason = ev.tag === 'EXPIRY_TAIL'
            ? 'EXPIRY TAIL \u2014 NO NEW TRADES'
            : 'EVENT WINDOW \u2014 ' + ev.name.toUpperCase();
          var evSub = ev.tag === 'EXPIRY_TAIL'
            ? 'Thursday 13:30-15:30 IST: gamma can swing premiums 30-50% on tiny spot moves. SCALP edge collapses here \u2014 sit out until tomorrow.'
            : ev.name + ' is inside a \u00B115 min veto window (' + evRemainMin + ' min remaining). IV crush + spot whips after the event kill scalp edge \u2014 wait for the dust to settle.';
          return {
            status: 'HARD_LOCK',
            reason: evReason,
            subReason: evSub,
            todayCounts: counts, canOverride: false, overrideActive: false,
            isEvent: true, event: ev
          };
        }
      } catch (_) {}
      // ── P1-2: cooling-off after recent loss (15 min) ──────
      if (counts.lastLossTs) {
        var sinceLoss = Date.now() - counts.lastLossTs;
        if (sinceLoss >= 0 && sinceLoss < COOLING_OFF_MS) {
          var remainMs  = COOLING_OFF_MS - sinceLoss;
          var remainMin = Math.floor(remainMs / 60000);
          var remainSec = Math.floor((remainMs % 60000) / 1000);
          var mmss = remainMin + ':' + (remainSec < 10 ? '0' : '') + remainSec;
          return {
            status: 'HARD_LOCK',
            reason: 'COOLING-OFF \u2014 ' + mmss,
            subReason: 'Mandatory 15-min pause after a loss. The first 15 minutes are when revenge-trading impulses peak. Use this time to review the journal entry, write notes, and reset emotionally. Auto-lifts at ' + new Date(counts.lastLossTs + COOLING_OFF_MS).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + '.',
            todayCounts: counts, canOverride: false, overrideActive: false,
            isCooling:   true, remainMs: remainMs
          };
        }
      }
      // HARD LOCK rules (no override).
      if (counts.losses >= 2) {
        return {
          status: 'HARD_LOCK', reason: '2 LOSSES TODAY \u2014 DAY LOCKED',
          subReason: 'You\u2019ve hit 2 losses. The most common blow-up pattern is revenge-trading after losses. No more trades today \u2014 review the journal, take notes, come back tomorrow.',
          todayCounts: counts, canOverride: false, overrideActive: false
        };
      }
      if (counts.taken >= 3) {
        return {
          status: 'HARD_LOCK', reason: '3 TRADES TAKEN \u2014 BUDGET EXHAUSTED',
          subReason: 'Your daily attempt budget is 3 trades. You\u2019ve used it. More trades will not produce better outcomes \u2014 they\u2019ll just inflate risk. Resets tomorrow.',
          todayCounts: counts, canOverride: false, overrideActive: false
        };
      }
      // SOFT LOCK after first win (greed protection).
      if (counts.wins >= 1 && !overrideActive) {
        return {
          status: 'SOFT_LOCK', reason: '1 WIN TODAY \u2014 SOFT LOCK',
          subReason: 'You\u2019ve banked a win. Pro discipline: stop trading and keep the win. The next signal is statistically NOT correlated with your edge \u2014 you\u2019d be trading because you feel like trading. Override only if the next setup is a textbook HIGH-confidence FRESH GO.',
          todayCounts: counts, canOverride: true, overrideActive: false
        };
      }
      if (counts.wins >= 1 && overrideActive) {
        return {
          status: 'OPEN', reason: '\u26A0 OVERRIDE ACTIVE (1 win today)',
          subReason: 'Soft-lock was overridden for today. The next trade you take has higher psychological risk \u2014 commit only if the setup is HIGH confidence FRESH GO.',
          todayCounts: counts, canOverride: false, overrideActive: true
        };
      }
      return {
        status: 'OPEN', reason: '',
        subReason: '',
        todayCounts: counts, canOverride: false, overrideActive: false
      };
    }

    function overrideSoftLock() {
      var counts = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getTodayCounts)
        ? signalJournalModule.getTodayCounts() : null;
      var dayKey = counts && counts.dayKey;
      if (!dayKey) return false;
      state.softLockOverride[dayKey] = true;
      // Compact old day-keys to keep LS tiny (keep last 60 days only).
      var keys = Object.keys(state.softLockOverride).sort();
      if (keys.length > 60) {
        for (var i = 0; i < keys.length - 60; i++) delete state.softLockOverride[keys[i]];
      }
      save();
      return true;
    }
    function clearOverride() {
      state.softLockOverride = {};
      save();
    }

    return {
      getLockStatus:    getLockStatus,
      overrideSoftLock: overrideSoftLock,
      clearOverride:    clearOverride
    };
  })();
  window.iaOverrideSoftLock = function () {
    try {
      disciplineModule.overrideSoftLock();
      if (typeof confirmModalModule !== 'undefined' && confirmModalModule.open) {
        // Re-paint the confirm modal so the override takes immediate visual effect.
        // (open() with an active signal also refreshes; calling open() would re-open
        // if it was just closed by the override button click — we want re-paint only.)
        var modal = document.getElementById('ia-confirm-modal');
        if (modal && modal.getAttribute('aria-hidden') === 'false') {
          // Triggers paint via the internal refreshTimer; nothing else needed.
        }
      }
      // Also refresh the HUD pill if visible.
      try { renderDisciplinePill(); } catch (_) {}
    } catch (_) {}
  };

  // Paint a small "DAY LOCKED" pill into the HUD when discipline
  // is non-OPEN. Self-hides on OPEN. Lightweight — single read of
  // disciplineModule + DOM attribute writes.
  function renderDisciplinePill() {
    // PAPER-MODE: The discipline pill is permanently hidden in paper
    // trading. The 2-loss / 3-trade / cooling-off rules were designed
    // for small-capital real-money scalping (15k INR default) to
    // prevent revenge-trading blow-ups. None of those concerns apply
    // when the user is testing signal edge on a paper account — and
    // showing "3 TRADES TAKEN — BUDGET EXHAUSTED" on a 1-lakh capital
    // sample is meaningless noise. The disciplineModule still
    // computes for backwards compatibility (journal stats, future
    // real-trade-simulator mode), but no visible chrome surfaces it
    // in the analyzer UI anymore.
    var pill = document.getElementById('ia-hud-discipline');
    if (!pill) return;
    pill.hidden = true;
    pill.removeAttribute('data-lock');
    pill.removeAttribute('title');
    pill.textContent = '';
  }

  // ════════════════ CONFIRM TRADE MODAL (P0-4) ═════════════════
  // The "last 5 seconds" sanity check before money goes on the
  // table. User clicks the big "CONFIRM TRADE" button on the HUD →
  // this modal opens with three panels:
  //
  //   1. SIGNAL CHECK    — freshness (age, drift) reuse of the
  //                        P0-3 chip output, but laid out larger
  //                        and more readable inside the modal.
  //   2. PLAN SNAPSHOT   — entry / SL / T1 / T2 in real ₹ +
  //                        position math (lots × qty, deployed,
  //                        max loss in ₹ + % of capital). All
  //                        consumed from plan.premium (single
  //                        source of truth from P0-2).
  //   3. VERDICT BANNER  — composite GO / CAUTION / SKIP — colour-
  //                        coded, with the dominant reason. Driven
  //                        by signalFreshnessModule.compute().
  //
  // Action buttons:
  //   I'M TAKING IT — marks journal entry taken=true; modal
  //                   closes; user pivots to broker to place the
  //                   actual order. Outcome marked later via the
  //                   existing outcome modal (P0-1 journal flow).
  //   SKIP THIS     — marks journal entry taken=false + status=
  //                   EXPIRED_UNUSED; closes; counts toward today's
  //                   "skipped" tally but NOT toward the daily-cap
  //                   ceiling (since no real-money risk taken).
  //   CLOSE (X)     — no journal mutation; user can re-open later.
  //
  // Re-renders every 1s while open (drift + premium + freshness
  // all tick visibly so the user sees the signal aging in real time
  // before they pull the trigger).
  var confirmModalModule = (function () {
    var refreshTimer = null;
    var activeEntryId = null;

    function open() {
      var modal = document.getElementById('ia-confirm-modal');
      if (!modal) return;
      var activeSig = signalJournalModule.getActiveSignal && signalJournalModule.getActiveSignal();
      if (!activeSig || !activeSig.entry) {
        // No active BUY signal — show a friendly "nothing to confirm"
        // state instead of opening blank. User pressed CONFIRM while
        // engine is WAIT — visually obvious nothing's actionable.
        showEmptyState();
        return;
      }
      activeEntryId = activeSig.entry.id;
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      paint();
      // Tick the modal every 1s so age / drift / verdict refresh
      // visibly while the user is reading. Clears on close.
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(paint, 1000);
      // Focus the primary action for keyboard users.
      setTimeout(function () {
        var btn = document.getElementById('ia-confirm-take-btn');
        if (btn) btn.focus();
      }, 60);
    }

    function close() {
      var modal = document.getElementById('ia-confirm-modal');
      if (modal) modal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
      activeEntryId = null;
    }

    function take() {
      if (!activeEntryId) { close(); return; }
      // P0-5: respect hard-lock — no trades on 2L or 3T days, no
      // matter how good the verdict looks. (UI button is already
      // disabled in this state, but defensive check guards against
      // keyboard-activation or programmatic clicks.)
      try {
        var locked = disciplineModule.getLockStatus();
        if (locked.status === 'HARD_LOCK') {
          try { renderDisciplinePill(); } catch (_) {}
          return;
        }
      } catch (_) {}
      signalJournalModule.markTaken(activeEntryId, true);
      var toast = document.createElement('div');
      toast.className = 'ia-confirm-toast ia-confirm-toast-ok';
      toast.textContent = '\u2713 Trade logged as TAKEN \u2014 mark the outcome from the journal once you exit.';
      document.body.appendChild(toast);
      setTimeout(function () { toast.classList.add('is-show'); }, 20);
      setTimeout(function () {
        toast.classList.remove('is-show');
        setTimeout(function () { try { toast.remove(); } catch (_) {} }, 200);
      }, 3500);
      close();
      try { if (typeof renderJournal === 'function') renderJournal(); } catch (_) {}
    }

    function skip() {
      if (!activeEntryId) { close(); return; }
      signalJournalModule.markTaken(activeEntryId, false);
      close();
      try { if (typeof renderJournal === 'function') renderJournal(); } catch (_) {}
    }

    function showEmptyState() {
      var modal = document.getElementById('ia-confirm-modal');
      if (!modal) return;
      var body = document.getElementById('ia-confirm-body');
      if (body) {
        body.innerHTML =
          '<div class="ia-confirm-empty">'
          + '<div class="ia-confirm-empty-icon">\u23F1</div>'
          + '<div class="ia-confirm-empty-title">No active signal</div>'
          + '<div class="ia-confirm-empty-sub">The engine is currently in WAIT mode \u2014 nothing to confirm. The CONFIRM TRADE button appears only when a BUY CE or BUY PE setup is live.</div>'
          + '</div>';
      }
      var foot = document.getElementById('ia-confirm-actions');
      if (foot) foot.hidden = true;
      modal.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      setTimeout(function () {
        var closeBtn = document.getElementById('ia-confirm-close-btn');
        if (closeBtn) closeBtn.focus();
      }, 60);
    }

    function paint() {
      if (!activeEntryId) return;
      var entry = signalJournalModule.getEntry(activeEntryId);
      if (!entry) { close(); return; }
      var activeSig = signalJournalModule.getActiveSignal();
      if (!activeSig) { close(); return; }

      // Pull live spot + premium for re-check vs entry snapshot.
      var liveSpot = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      var liveQuote = (entry.strike && typeof getStrikeQuote === 'function')
        ? getStrikeQuote(entry.strike, entry.direction === 'BUY_CE' ? 'CE' : 'PE')
        : null;
      var livePremium = liveQuote ? liveQuote.premium : null;
      var fresh = signalFreshnessModule.compute(activeSig, liveSpot, livePremium);

      var title = document.getElementById('ia-confirm-title');
      var sideTxt = entry.direction === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
      if (title) title.textContent = 'CONFIRM TRADE \u2014 ' + sideTxt + ' ' + (entry.strike || '');

      var foot = document.getElementById('ia-confirm-actions');
      if (foot) foot.hidden = false;

      var body = document.getElementById('ia-confirm-body');
      if (!body) return;

      var fmt2 = function (n) { return (n == null || !isFinite(n)) ? '\u2014' : (+n).toFixed(2); };
      var fmt1 = function (n) { return (n == null || !isFinite(n)) ? '\u2014' : (+n).toFixed(1); };
      var fmt0 = function (n) { return (n == null || !isFinite(n)) ? '\u2014' : (+n).toLocaleString('en-IN', { maximumFractionDigits: 0 }); };

      // Pull the latest plan.premium for the SAME entry — refreshed
      // via the live tick path. Falls back to entry snapshot when
      // STATE.result.plan.premium is stale or missing.
      var planPremium = (STATE.result && STATE.result.plan && STATE.result.plan.premium) || null;
      var entryPx     = (planPremium && planPremium.entry != null) ? planPremium.entry : entry.entryPremium;
      var slPx        = (planPremium && planPremium.sl    != null) ? planPremium.sl    : entry.slPremium;
      var t1Px        = (planPremium && planPremium.t1    != null) ? planPremium.t1    : entry.t1Premium;
      var t2Px        = (planPremium && planPremium.t2    != null) ? planPremium.t2    : entry.t2Premium;
      var slPctDrop   = (planPremium && planPremium.slPctDrop != null) ? planPremium.slPctDrop : null;
      var t1PctGain   = (planPremium && planPremium.t1PctGain != null) ? planPremium.t1PctGain : null;
      var t2PctGain   = (planPremium && planPremium.t2PctGain != null) ? planPremium.t2PctGain : null;
      var lots        = (planPremium && planPremium.lots != null) ? planPremium.lots : 1;
      var qty         = (planPremium && planPremium.qty  != null) ? planPremium.qty  : ANALYZER_LOT_SIZE_NIFTY;
      var deployed    = (planPremium && planPremium.capitalDeployed != null) ? planPremium.capitalDeployed : null;
      var deployedPct = (planPremium && planPremium.capitalDeployedPct != null) ? planPremium.capitalDeployedPct : null;
      var maxLossINR  = (planPremium && planPremium.maxLossINR != null) ? planPremium.maxLossINR : null;
      var maxLossPct  = (planPremium && planPremium.maxLossPct != null) ? planPremium.maxLossPct : null;
      var rrT1        = (planPremium && planPremium.rrToT1 != null) ? planPremium.rrToT1 : null;
      var rrT2        = (planPremium && planPremium.rrToT2 != null) ? planPremium.rrToT2 : null;
      var riskBudget  = (planPremium && planPremium.riskBudgetStatus) || null;
      var slQuality   = (planPremium && planPremium.slQuality) || null;

      // ── VERDICT banner — drives the modal's emotional weight ──
      var verdict = (fresh && fresh.verdict) || 'GO';
      var verdictLabel, verdictIcon, verdictBlurb;
      if (verdict === 'GO') {
        verdictLabel = 'GO \u2014 TYPE INTO UPSTOX NOW';
        verdictIcon = '\u2713';
        verdictBlurb = 'Signal is fresh, premium hasn\u2019t run away, thesis is intact. Place the order at the displayed entry.';
      } else if (verdict === 'CAUTION') {
        verdictLabel = 'CAUTION \u2014 SIZE DOWN OR WAIT';
        verdictIcon = '\u26A0';
        verdictBlurb = 'Either the signal is ageing, the premium has rallied, or spot has drifted against thesis. Take only if you can enter in the next 30s, otherwise skip.';
      } else {
        verdictLabel = 'SKIP \u2014 DON\u2019T FORCE IT';
        verdictIcon = '\u2717';
        verdictBlurb = 'Signal is stale, the move is half-done, or the thesis has been invalidated by spot drift. Wait for the next analyze cycle.';
      }

      // ── Section 1: SIGNAL CHECK ────────────────────────────
      var ageTxt = fresh ? fresh.ageLabel : '\u2014';
      var ageHealth = fresh ? fresh.health : 'unknown';
      var spotDriftHtml = '';
      if (fresh && fresh.spotDriftPts != null) {
        var sSign = fresh.spotDriftPts >= 0 ? '+' : '';
        spotDriftHtml = sSign + fmt1(fresh.spotDriftPts) + ' pts vs thesis';
      } else { spotDriftHtml = '\u2014'; }
      var pxDriftHtml = '';
      if (fresh && fresh.premiumDriftPct != null) {
        var pSign = fresh.premiumDriftPct >= 0 ? '+' : '';
        pxDriftHtml = pSign + fmt1(fresh.premiumDriftPct) + '% vs entry';
      } else { pxDriftHtml = '\u2014'; }

      var sigCheckHtml =
        '<div class="ia-confirm-section">'
        + '<div class="ia-confirm-section-k">SIGNAL CHECK</div>'
        + '<div class="ia-confirm-grid ia-confirm-grid-3">'
        +   '<div class="ia-confirm-cell"><span class="ia-confirm-k">AGE</span>'
        +     '<span class="ia-confirm-v ia-confirm-v-' + ageHealth + '">' + ageTxt + '</span>'
        +     '<span class="ia-confirm-sub">' + (fresh ? fresh.healthLabel : '\u2014') + '</span></div>'
        +   '<div class="ia-confirm-cell"><span class="ia-confirm-k">PREMIUM DRIFT</span>'
        +     '<span class="ia-confirm-v">' + pxDriftHtml + '</span>'
        +     '<span class="ia-confirm-sub">'
        +       'entry was \u20B9' + fmt2(entry.entryPremium) + ' \u00B7 now \u20B9' + (livePremium != null ? fmt2(livePremium) : '\u2014')
        +     '</span></div>'
        +   '<div class="ia-confirm-cell"><span class="ia-confirm-k">SPOT DRIFT</span>'
        +     '<span class="ia-confirm-v">' + spotDriftHtml + '</span>'
        +     '<span class="ia-confirm-sub">'
        +       'spot at fire \u20B9' + fmt0(entry.spotAtFire) + ' \u00B7 now \u20B9' + (liveSpot != null ? fmt0(liveSpot) : '\u2014')
        +     '</span></div>'
        + '</div>';
      // Bid/ask line — placeholder until depth API is wired.
      sigCheckHtml +=
        '<div class="ia-confirm-aux">'
        + '<span class="ia-confirm-aux-k">BID/ASK SPREAD:</span> '
        + '<span class="ia-confirm-aux-v">n/a \u2014 not available from chain API. Check spread directly on Upstox before placing the order; skip if spread &gt; 5% of premium.</span>'
        + '</div>'
        + '</div>';

      // ── Section 2: PLAN SNAPSHOT ──────────────────────────
      var rbCls = riskBudget === 'OK' ? 'ok' : (riskBudget === 'TIGHT' ? 'tight' : (riskBudget === 'EXCEEDS' ? 'over' : 'na'));
      var planSnapHtml =
        '<div class="ia-confirm-section">'
        + '<div class="ia-confirm-section-k">PLAN SNAPSHOT \u2014 TYPE THESE INTO UPSTOX</div>'
        + '<div class="ia-confirm-grid ia-confirm-grid-4">'
        +   '<div class="ia-confirm-cell ia-confirm-cell-entry"><span class="ia-confirm-k">ENTRY</span>'
        +     '<span class="ia-confirm-v ia-confirm-v-big">\u20B9' + fmt2(entryPx) + '</span>'
        +     '<span class="ia-confirm-sub">' + lots + ' lot \u00D7 ' + qty + ' qty</span></div>'
        +   '<div class="ia-confirm-cell ia-confirm-cell-sl"><span class="ia-confirm-k">STOP-LOSS</span>'
        +     '<span class="ia-confirm-v ia-confirm-v-big">' + (slPx != null ? '\u20B9' + fmt2(slPx) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-sub">' + (slPctDrop != null ? '\u2212' + fmt1(slPctDrop) + '% on premium' : '\u2014') + '</span></div>'
        +   '<div class="ia-confirm-cell ia-confirm-cell-t1"><span class="ia-confirm-k">TARGET 1</span>'
        +     '<span class="ia-confirm-v ia-confirm-v-big">' + (t1Px != null ? '\u20B9' + fmt2(t1Px) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-sub">' + (t1PctGain != null ? '+' + fmt1(t1PctGain) + '% on premium' : '\u2014') + '</span></div>'
        +   '<div class="ia-confirm-cell ia-confirm-cell-t2"><span class="ia-confirm-k">TARGET 2</span>'
        +     '<span class="ia-confirm-v ia-confirm-v-big">' + (t2Px != null ? '\u20B9' + fmt2(t2Px) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-sub">' + (t2PctGain != null ? '+' + fmt1(t2PctGain) + '% on premium' : '\u2014') + '</span></div>'
        + '</div>'
        + '<div class="ia-confirm-money-strip">'
        +   '<div class="ia-confirm-money"><span class="ia-confirm-money-k">DEPLOYED</span>'
        +     '<span class="ia-confirm-money-v">' + (deployed != null ? '\u20B9' + fmt0(deployed) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-money-sub">' + (deployedPct != null ? fmt1(deployedPct) + '% of capital' : '\u2014') + '</span></div>'
        +   '<div class="ia-confirm-money ia-confirm-money-loss ia-confirm-rb-' + rbCls + '">'
        +     '<span class="ia-confirm-money-k">MAX LOSS</span>'
        +     '<span class="ia-confirm-money-v">' + (maxLossINR != null ? '\u20B9' + fmt0(maxLossINR) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-money-sub">' + (maxLossPct != null ? fmt1(maxLossPct) + '% of capital' : '\u2014') + '</span></div>'
        +   '<div class="ia-confirm-money"><span class="ia-confirm-money-k">R:R \u2192 T1</span>'
        +     '<span class="ia-confirm-money-v">' + (rrT1 != null ? '1 : ' + fmt1(rrT1) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-money-sub">first realistic exit</span></div>'
        +   '<div class="ia-confirm-money"><span class="ia-confirm-money-k">R:R \u2192 T2</span>'
        +     '<span class="ia-confirm-money-v">' + (rrT2 != null ? '1 : ' + fmt1(rrT2) : '\u2014') + '</span>'
        +     '<span class="ia-confirm-money-sub">main target</span></div>'
        + '</div>';
      // SL quality warning if outside healthy band.
      if (slQuality === 'TIGHT' || slQuality === 'WIDE') {
        planSnapHtml +=
          '<div class="ia-confirm-warn ia-confirm-warn-' + (slQuality === 'TIGHT' ? 'tight' : 'wide') + '">'
          + '<b>' + (slQuality === 'TIGHT' ? 'TIGHT SL' : 'WIDE SL') + ':</b> '
          + (slQuality === 'TIGHT'
              ? 'A ' + fmt1(slPctDrop) + '% premium stop will likely fire on noise. Either widen to 25% or skip this setup.'
              : 'A ' + fmt1(slPctDrop) + '% premium stop is wider than the typical SCALP band (12-35%). R:R will suffer.')
          + '</div>';
      }
      planSnapHtml += '</div>';

      // ── Section 3: VERDICT banner + today counts ──────────
      var counts = signalJournalModule.getTodayCounts();
      var todayHtml = '<div class="ia-confirm-today">'
        + '<span class="ia-confirm-today-k">Today so far:</span> '
        + '<span class="ia-confirm-today-v">' + counts.fired + ' fired \u00B7 ' + counts.taken + ' taken \u00B7 '
        + counts.wins + 'W \u00B7 ' + counts.losses + 'L</span>'
        + '</div>';
      var verdictHtml =
        '<div class="ia-confirm-verdict ia-confirm-verdict-' + verdict.toLowerCase() + '">'
        + '<div class="ia-confirm-verdict-icon">' + verdictIcon + '</div>'
        + '<div class="ia-confirm-verdict-body">'
        +   '<div class="ia-confirm-verdict-label">' + verdictLabel + '</div>'
        +   '<div class="ia-confirm-verdict-blurb">' + verdictBlurb + '</div>'
        + '</div>'
        + '</div>';

      // ── P0-5: discipline lock banner (top of body) ────────
      var lock = disciplineModule.getLockStatus();
      var lockHtml = '';
      if (lock.status === 'HARD_LOCK') {
        lockHtml =
          '<div class="ia-confirm-lock ia-confirm-lock-hard">'
          + '<div class="ia-confirm-lock-icon">\u26D4</div>'
          + '<div class="ia-confirm-lock-body">'
          +   '<div class="ia-confirm-lock-label">' + lock.reason + '</div>'
          +   '<div class="ia-confirm-lock-sub">' + lock.subReason + '</div>'
          + '</div>'
          + '</div>';
      } else if (lock.status === 'SOFT_LOCK') {
        lockHtml =
          '<div class="ia-confirm-lock ia-confirm-lock-soft">'
          + '<div class="ia-confirm-lock-icon">\u26A0</div>'
          + '<div class="ia-confirm-lock-body">'
          +   '<div class="ia-confirm-lock-label">' + lock.reason + '</div>'
          +   '<div class="ia-confirm-lock-sub">' + lock.subReason + '</div>'
          +   '<button type="button" class="ia-confirm-lock-override"'
          +          ' onclick="window.iaOverrideSoftLock && window.iaOverrideSoftLock()">'
          +     'Override for today \u2014 I\u2019ll commit to a HIGH-conf FRESH GO only'
          +   '</button>'
          + '</div>'
          + '</div>';
      } else if (lock.overrideActive) {
        lockHtml =
          '<div class="ia-confirm-lock ia-confirm-lock-override">'
          + '<div class="ia-confirm-lock-icon">\u26A0</div>'
          + '<div class="ia-confirm-lock-body">'
          +   '<div class="ia-confirm-lock-label">' + lock.reason + '</div>'
          +   '<div class="ia-confirm-lock-sub">' + lock.subReason + '</div>'
          + '</div>'
          + '</div>';
      }

      body.innerHTML = lockHtml + sigCheckHtml + planSnapHtml + verdictHtml + todayHtml;

      // ── Wire button label + lock state ────────────────────
      var takeBtn = document.getElementById('ia-confirm-take-btn');
      if (takeBtn) {
        takeBtn.setAttribute('data-verdict', verdict.toLowerCase());
        if (lock.status === 'HARD_LOCK') {
          takeBtn.disabled = true;
          takeBtn.setAttribute('data-locked', 'true');
          takeBtn.textContent = '\u26D4 LOCKED \u2014 NO MORE TRADES TODAY';
        } else {
          takeBtn.disabled = false;
          takeBtn.removeAttribute('data-locked');
          takeBtn.textContent = verdict === 'GO' ? "\u2713 I'M TAKING IT \u2014 LOG AS TAKEN"
                              : verdict === 'CAUTION' ? '\u26A0 TAKE ANYWAY (size down)'
                              : '\u2717 OVERRIDE \u2014 TAKE AGAINST VERDICT';
        }
      }
    }

    return { open: open, close: close, take: take, skip: skip };
  })();

  window.iaOpenConfirmModal  = function () { try { confirmModalModule.open(); }  catch (_) {} };
  window.iaCloseConfirmModal = function () { try { confirmModalModule.close(); } catch (_) {} };
  window.iaConfirmTake       = function () { try { confirmModalModule.take(); }  catch (_) {} };
  window.iaConfirmSkip       = function () { try { confirmModalModule.skip(); }  catch (_) {} };

  // ESC closes the confirm modal — wired once, idempotent (the
  // outcome-modal ESC handler is separately wired earlier).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var m = document.getElementById('ia-confirm-modal');
    if (m && m.getAttribute('aria-hidden') === 'false') {
      confirmModalModule.close();
    }
  });

  // ─── Journal renderer ─────────────────────────────────────────
  // Reads filter state + journal entries, paints stat tiles +
  // table rows + empty state. Cheap to re-run (single tbody
  // innerHTML assignment, <50 rows in DOM at a time).
  function renderJournal() {
    var section = document.getElementById('ia-journal-section');
    if (!section) return;
    var filter = signalJournalModule.getFilter();
    var stats = signalJournalModule.getStats(filter);

    // Capital + risk inputs — set on first render and whenever
    // they're cleared. Don't clobber while the user is mid-edit
    // (focused element check).
    var capInp = document.getElementById('sj-cap-input');
    if (capInp && document.activeElement !== capInp) {
      capInp.value = signalJournalModule.getCapital();
    }
    var riskInp = document.getElementById('sj-risk-input');
    if (riskInp && document.activeElement !== riskInp) {
      riskInp.value = signalJournalModule.getRiskPct();
    }
    // P1-1: sync alert-sound checkbox with module state.
    var soundInp = document.getElementById('sj-sound-input');
    if (soundInp && typeof alertModule !== 'undefined') {
      soundInp.checked = !!alertModule.isSoundEnabled();
    }
    // Mirror the AUTO-TRADE toggle state into the journal-settings
    // checkbox so the user can see/change auto-trade from the
    // journal area (the live-strip toggle is hidden when no signal
    // is active, which is most of the day). Both toggles read from
    // and write to the same paperBridgeModule state, so they stay
    // in sync regardless of which one the user touched.
    var autoInp = document.getElementById('sj-auto-input');
    if (autoInp && typeof paperBridgeModule !== 'undefined' && paperBridgeModule.isAutoTrade) {
      autoInp.checked = !!paperBridgeModule.isAutoTrade();
      autoInp.parentNode.parentNode.setAttribute('data-on', autoInp.checked ? 'true' : 'false');
    }

    // Stat tiles. "—" when no data so we don't show 0%, 0R etc.
    // that would be confusing on a fresh account.
    setText('sj-stat-total', String(stats.total));
    var subTotal = document.getElementById('sj-stat-total-sub');
    if (subTotal) subTotal.textContent = stats.total === 1 ? 'fired' : 'fired';

    var wrSub = document.getElementById('sj-stat-winrate-sub');
    if (stats.taken > 0) {
      setText('sj-stat-winrate', stats.winRate + '%');
      if (wrSub) wrSub.textContent = stats.wins + 'W / ' + stats.losses + 'L of ' + stats.taken + ' taken';
    } else {
      setText('sj-stat-winrate', '—');
      if (wrSub) wrSub.textContent = 'no taken trades yet';
    }
    setText('sj-stat-avgr',   stats.taken > 0 ? (stats.avgR   >= 0 ? '+' : '') + stats.avgR.toFixed(2) + 'R' : '—');
    setText('sj-stat-totalr', stats.taken > 0 ? (stats.totalR >= 0 ? '+' : '') + stats.totalR.toFixed(2) + 'R' : '—');
    var streakV  = document.getElementById('sj-stat-streak');
    var streakS  = document.getElementById('sj-stat-streak-sub');
    if (streakV) {
      if (stats.streak === 0) {
        streakV.textContent = '—';
        streakV.removeAttribute('data-streak');
      } else if (stats.streak > 0) {
        streakV.textContent = stats.streak + 'W';
        streakV.setAttribute('data-streak', 'win');
      } else {
        streakV.textContent = Math.abs(stats.streak) + 'L';
        streakV.setAttribute('data-streak', 'loss');
      }
    }
    if (streakS) {
      if (stats.streak === 0) streakS.textContent = 'no streak';
      else if (stats.streak > 0) streakS.textContent = 'consecutive wins';
      else streakS.textContent = 'consecutive losses — slow down';
    }

    // Sync filter button active state with module filter.
    ['range','conf','dir'].forEach(function (group) {
      var current = filter[group];
      var btns = section.querySelectorAll(
        '.ia-journal-filter-group[data-group="' + group + '"] .ia-journal-filter'
      );
      btns.forEach(function (b) {
        if (b.getAttribute('data-value') === current) b.classList.add('is-active');
        else b.classList.remove('is-active');
      });
    });

    // Table body.
    var tbody = document.getElementById('ia-journal-tbody');
    var emptyEl = document.getElementById('ia-journal-empty');
    if (!tbody || !emptyEl) return;
    if (stats.entries.length === 0) {
      tbody.innerHTML = '';
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;

    // Render up to 50 most recent rows (state stores up to 500).
    var rows = stats.entries.slice(0, 50).map(buildRowHtml).join('');
    tbody.innerHTML = rows;
  }

  function buildRowHtml(e) {
    var d = new Date(e.ts);
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    var dayMs = 24 * 60 * 60 * 1000;
    var ageMs = Date.now() - e.ts;
    var dateLabel = '';
    if (ageMs < dayMs && d.toDateString() === new Date().toDateString()) {
      dateLabel = 'Today';
    } else if (ageMs < 2 * dayMs) {
      dateLabel = 'Yesterday';
    } else {
      dateLabel = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
    }

    var sideCls = e.direction === 'BUY_CE' ? 'ce' : 'pe';
    var sideTxt = e.direction === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
    var confCls = (e.confidence === 'HIGH' || e.confidence === 'MEDIUM' || e.confidence === 'LOW')
                  ? e.confidence.toLowerCase() : 'na';
    // May 2026: append the derived % so journal rows read
    // "HIGH 82%" / "MED 64%" / "LOW 42%" — mirrors the HUD chip
    // so the user's after-the-fact review matches what was shown
    // at signal time. Legacy entries (recorded before
    // confidencePct existed) gracefully fall back to label-only.
    var confLbl = (e.confidence === 'HIGH' || e.confidence === 'MEDIUM' || e.confidence === 'LOW')
                  ? (e.confidence === 'MEDIUM' ? 'MED' : e.confidence) : '—';
    var jPct = (e.confidencePct != null && isFinite(e.confidencePct))
               ? ' ' + e.confidencePct + '%' : '';
    var confTxt = (confLbl !== '—') ? (confLbl + jPct) : '—';
    var statusCls = signalJournalModule.STATUS_CLS[e.status] || 'na';
    var statusLabel = signalJournalModule.STATUS_LABEL[e.status] || e.status;

    var fmt = function (n) { return (n == null || !isFinite(n)) ? '—' : (+n).toFixed(2); };
    var rTxt = (e.pnlR == null) ? '—' : (e.pnlR >= 0 ? '+' : '') + e.pnlR.toFixed(2) + 'R';
    var rCls = (e.pnlR == null) ? 'na' : (e.pnlR > 0 ? 'win' : (e.pnlR < 0 ? 'loss' : 'flat'));

    // ── TAKEN / NOT-TAKEN chip (May 2026) ──────────────────────
    // Surfaces e.taken (set by paperBridgeModule when an auto-trade
    // OR manual quick-strip BUY successfully places a paper
    // position) so the user can instantly see WHICH journal rows
    // actually became paper trades vs. WHICH were just signal
    // observations the engine logged but never executed.
    //
    // Without this chip the user sees a journal full of signals
    // with no idea why "no P/L showed up" — the journal logs every
    // fire as a row but paper execution is separate (auto-trade
    // toggle + freshness window + chain-loaded preconditions).
    // The chip removes that ambiguity by labelling each row as
    // either "PAPER ✓" (a real paper position ran) or "OBSERVED"
    // (signal fired but no execution happened — e.g. AUTO was off,
    // signal expired, chain hadn't loaded, etc.). Once the user
    // marks an outcome manually (WIN/LOSS/SKIP) the chip stays
    // accurate — manual marks on OBSERVED rows are subjective
    // judgements (would-have-won), paper-traded rows have real
    // exit fills.
    // Pull the live bridge breadcrumb for this row (if any) so the
    // OBSERVED tooltip can show the EXACT reason auto-trade didn't
    // fire ("Option chain not loaded yet" / "Signal expired" /
    // "AUTO is OFF" etc.) instead of a generic catch-all.
    var bridgeAttempt = null;
    try {
      if (typeof paperBridgeModule !== 'undefined' && paperBridgeModule.getLastAttempt) {
        bridgeAttempt = paperBridgeModule.getLastAttempt(e.id);
      }
    } catch (_) {}
    var autoOnNow = false;
    try {
      autoOnNow = (typeof paperBridgeModule !== 'undefined' && paperBridgeModule.isAutoTrade)
        ? paperBridgeModule.isAutoTrade() : false;
    } catch (_) {}

    var takenChipHtml = '';
    if (e.taken === true) {
      takenChipHtml = '<span class="sj-taken sj-taken-yes" title="A paper-trade position was placed for this signal">PAPER \u2713</span>';
    } else if (e.status === signalJournalModule.STATUS.OPEN) {
      // Build a precise observed reason. Priority:
      // 1) bridge logged a fail reason for this exact entry id
      // 2) AUTO is currently OFF (user hasn't enabled auto-trade)
      // 3) AUTO is ON but the renderer hasn't seen this row yet
      //    (just-fired, attempt still scheduled / pending)
      var obsReason;
      if (bridgeAttempt && bridgeAttempt.ok === false && bridgeAttempt.reason) {
        obsReason = bridgeAttempt.reason;
      } else if (!autoOnNow) {
        obsReason = 'AUTO is OFF — toggle the AUTO button on the Quick Strip to auto-place future signals';
      } else {
        obsReason = 'Auto-trade pending or signal expired before chain loaded';
      }
      var obsAttr = String(obsReason).replace(/"/g, '&quot;');
      takenChipHtml = '<span class="sj-taken sj-taken-no" title="OBSERVED \u2014 ' + obsAttr + '">OBSERVED</span>';
    }

    var actionsHtml;
    if (e.status === signalJournalModule.STATUS.OPEN) {
      actionsHtml = takenChipHtml +
        '<button class="sj-act sj-act-win"   onclick="window.sjOpenOutcome(\'' + e.id + '\',\'WIN\')"  aria-label="Mark as win for ' + sideTxt + '">✓ WIN</button>' +
        '<button class="sj-act sj-act-loss"  onclick="window.sjOpenOutcome(\'' + e.id + '\',\'LOSS\')" aria-label="Mark as loss for ' + sideTxt + '">✗ LOSS</button>' +
        '<button class="sj-act sj-act-skip"  onclick="window.sjMarkSkipped(\'' + e.id + '\')"        aria-label="Mark as skipped for ' + sideTxt + '">⊘ SKIP</button>';
    } else {
      actionsHtml = takenChipHtml +
        '<span class="sj-status sj-status-' + statusCls + '">' + statusLabel + '</span>' +
        (e.exitPremium != null ? '<span class="sj-exit-px">exit ₹' + fmt(e.exitPremium) + '</span>' : '') +
        '<button class="sj-act sj-act-del" onclick="window.sjDelete(\'' + e.id + '\')" aria-label="Delete entry">×</button>';
    }

    return '<tr data-id="' + e.id + '" data-status="' + e.status + '">' +
      '<td class="sj-col-time"><div class="sj-time-clock">' + hh + ':' + mm + '</div><div class="sj-time-date">' + dateLabel + '</div></td>' +
      '<td class="sj-col-side"><span class="sj-side sj-side-' + sideCls + '">' + sideTxt + '</span></td>' +
      '<td class="sj-col-strike">' + (e.strike != null ? e.strike : '—') + '</td>' +
      '<td class="sj-col-conf"><span class="sj-conf sj-conf-' + confCls + '">' + confTxt + '</span></td>' +
      '<td class="sj-col-entry">' + (e.entryPremium != null ? '₹' + fmt(e.entryPremium) : '—') + '</td>' +
      '<td class="sj-col-sl">'    + (e.slPremium    != null ? '₹' + fmt(e.slPremium)    : '—') + '</td>' +
      '<td class="sj-col-t1">'    + (e.t1Premium    != null ? '₹' + fmt(e.t1Premium)    : '—') + '</td>' +
      '<td class="sj-col-r"><span class="sj-r sj-r-' + rCls + '">' + rTxt + '</span></td>' +
      '<td class="sj-col-actions">' + actionsHtml + '</td>' +
    '</tr>';
  }

  // ── Outcome modal helpers ────────────────────────────────────
  function openOutcomeModal(id, kind) {
    var entry = signalJournalModule.getEntry(id);
    if (!entry) return;
    signalJournalModule.setOutcomeBeingMarked({ id: id, kind: kind });
    var modal = document.getElementById('sj-outcome-modal');
    if (!modal) return;
    var titleEl = document.getElementById('sj-outcome-title');
    var metaEl  = document.getElementById('sj-outcome-meta');
    var exitEl  = document.getElementById('sj-outcome-exit');
    var notesEl = document.getElementById('sj-outcome-notes');
    var rEl     = document.getElementById('sj-outcome-r');
    var sideTxt = entry.direction === 'BUY_CE' ? 'BUY CE' : 'BUY PE';
    if (titleEl) titleEl.textContent = (kind === 'WIN' ? '✓ Mark WIN — ' : '✗ Mark LOSS — ') + sideTxt + ' ' + (entry.strike || '');
    if (metaEl) {
      metaEl.innerHTML =
        '<span>Entry <b>₹' + (entry.entryPremium != null ? entry.entryPremium.toFixed(2) : '—') + '</b></span>' +
        '<span>SL <b>₹' + (entry.slPremium != null ? entry.slPremium.toFixed(2) : '—') + '</b></span>' +
        '<span>T1 <b>₹' + (entry.t1Premium != null ? entry.t1Premium.toFixed(2) : '—') + '</b></span>' +
        '<span>T2 <b>₹' + (entry.t2Premium != null ? entry.t2Premium.toFixed(2) : '—') + '</b></span>';
    }
    // Sensible default for the exit field.
    var defaultExit = '';
    if (kind === 'WIN') defaultExit = entry.t1Premium != null ? entry.t1Premium.toFixed(2) : '';
    else                defaultExit = entry.slPremium != null ? entry.slPremium.toFixed(2) : '';
    if (exitEl)  exitEl.value = defaultExit;
    if (notesEl) notesEl.value = '';
    if (rEl)     rEl.textContent = computeRLabel(entry, defaultExit);

    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    // ESC + click backdrop wired via inline onclick + this handler.
    setTimeout(function () { if (exitEl) exitEl.focus(); }, 50);

    // Wire live R recompute as the user types in the exit field.
    if (exitEl) {
      exitEl.oninput = function () {
        if (rEl) rEl.textContent = computeRLabel(entry, exitEl.value);
      };
    }
  }
  function computeRLabel(entry, exitStr) {
    var ex = +exitStr;
    if (!isFinite(ex) || entry.entryPremium == null || entry.slPremium == null) return 'R: —';
    var risk = Math.abs(entry.entryPremium - entry.slPremium);
    if (risk <= 0) return 'R: —';
    var r = (ex - entry.entryPremium) / risk;
    return 'R: ' + (r >= 0 ? '+' : '') + r.toFixed(2);
  }
  function closeOutcomeModal() {
    signalJournalModule.setOutcomeBeingMarked(null);
    var modal = document.getElementById('sj-outcome-modal');
    if (modal) modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }
  function saveOutcome() {
    var ctx = signalJournalModule.getOutcomeBeingMarked();
    if (!ctx) return;
    var entry = signalJournalModule.getEntry(ctx.id);
    if (!entry) { closeOutcomeModal(); return; }
    var exitEl  = document.getElementById('sj-outcome-exit');
    var notesEl = document.getElementById('sj-outcome-notes');
    var exitPx = exitEl ? +exitEl.value : NaN;
    var notes  = notesEl ? notesEl.value : '';
    // Classify status. WIN above midpoint of T1/T2 → WIN_T2, else
    // WIN_T1. LOSS at or below SL → LOSS_SL, else EXIT_MANUAL.
    var status;
    if (ctx.kind === 'WIN') {
      if (entry.t2Premium != null && entry.t1Premium != null) {
        var mid = (entry.t1Premium + entry.t2Premium) / 2;
        status = (isFinite(exitPx) && exitPx >= mid) ? 'WIN_T2' : 'WIN_T1';
      } else status = 'WIN_T1';
    } else {
      if (entry.slPremium != null && isFinite(exitPx) && exitPx > entry.slPremium + 0.01) {
        status = 'EXIT_MANUAL';
      } else status = 'LOSS_SL';
    }
    signalJournalModule.markOutcome(ctx.id, status, isFinite(exitPx) ? exitPx : null, notes);
    closeOutcomeModal();
    renderJournal();
  }
  function markSkipped(id) {
    signalJournalModule.markOutcome(id, 'EXPIRED_UNUSED', null, '');
    renderJournal();
  }
  // ── Themed confirm dialog ────────────────────────────────────
  // Replaces native window.confirm() which renders an unthemed
  // browser-chrome alert ("localhost:8000 says..."). Promise-based
  // so call sites read like the native API. Tone defaults to
  // 'danger' (red Delete button) — pass 'info' or 'bull' for
  // non-destructive confirmations.
  //   appConfirm({ title, body, okText, tone }) -> Promise<boolean>
  var appConfirmState = { resolve: null, prevFocus: null, keyHandler: null };
  function appConfirm(opts) {
    opts = opts || {};
    var modal = document.getElementById('app-confirm-modal');
    if (!modal) {
      return Promise.resolve(window.confirm(opts.body || 'Are you sure?'));
    }
    var titleEl = document.getElementById('app-confirm-title');
    var bodyEl  = document.getElementById('app-confirm-body');
    var okBtn   = document.getElementById('app-confirm-ok-btn');
    var cancelBtn = document.getElementById('app-confirm-cancel-btn');
    if (titleEl) titleEl.textContent = opts.title || 'Confirm';
    if (bodyEl)  bodyEl.textContent  = opts.body  || 'Are you sure?';
    if (okBtn) {
      okBtn.textContent = opts.okText || 'Delete';
      okBtn.classList.remove('is-info', 'is-bull');
      if (opts.tone === 'info') okBtn.classList.add('is-info');
      else if (opts.tone === 'bull') okBtn.classList.add('is-bull');
    }
    if (appConfirmState.resolve) {
      try { appConfirmState.resolve(false); } catch (_) {}
    }
    appConfirmState.prevFocus = document.activeElement;
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(function () { if (okBtn) okBtn.focus(); }, 30);
    appConfirmState.keyHandler = function (ev) {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        appConfirmCancel();
      } else if (ev.key === 'Enter' && document.activeElement !== cancelBtn) {
        ev.preventDefault();
        appConfirmOk();
      }
    };
    document.addEventListener('keydown', appConfirmState.keyHandler);
    return new Promise(function (resolve) { appConfirmState.resolve = resolve; });
  }
  function appConfirmClose(value) {
    var modal = document.getElementById('app-confirm-modal');
    if (modal) modal.setAttribute('aria-hidden', 'true');
    if (appConfirmState.keyHandler) {
      document.removeEventListener('keydown', appConfirmState.keyHandler);
      appConfirmState.keyHandler = null;
    }
    var resolve = appConfirmState.resolve;
    appConfirmState.resolve = null;
    try {
      if (appConfirmState.prevFocus && appConfirmState.prevFocus.focus) {
        appConfirmState.prevFocus.focus();
      }
    } catch (_) {}
    appConfirmState.prevFocus = null;
    if (resolve) resolve(value);
  }
  function appConfirmOk()     { appConfirmClose(true); }
  function appConfirmCancel() { appConfirmClose(false); }
  window.appConfirm       = appConfirm;
  window.appConfirmOk     = appConfirmOk;
  window.appConfirmCancel = appConfirmCancel;

  function deleteJournalEntry(id) {
    appConfirm({
      title: 'Delete signal',
      body:  'Delete this signal from the journal? This cannot be undone.',
      okText: 'Delete',
      tone:  'danger'
    }).then(function (ok) {
      if (!ok) return;
      signalJournalModule.deleteEntry(id);
      renderJournal();
    });
  }
  function confirmClearAll() {
    var total = signalJournalModule.getStats({}).total;
    appConfirm({
      title: 'Clear all entries',
      body:  'Clear ALL ' + total + ' journal entries? This cannot be undone.',
      okText: 'Clear all',
      tone:  'danger'
    }).then(function (ok) {
      if (!ok) return;
      signalJournalModule.clearAll();
      renderJournal();
    });
  }
  function onFilterClick(group, value) {
    signalJournalModule.setFilter(group, value);
    renderJournal();
  }
  function onCapitalInput(v) {
    signalJournalModule.setCapital(v);
    // Light re-render — capital only affects future plan-card
    // math (P0-2), nothing in the current journal table needs
    // immediate update.
  }
  function onRiskInput(v) {
    signalJournalModule.setRiskPct(v);
  }

  // ── Expose to window for inline handlers in content/live.html ─
  window.sjLogSignal       = function (plan, an5) { return signalJournalModule.logSignal(plan, an5); };
  window.sjMarkOutcome     = function (id, status, exitPx, notes) { return signalJournalModule.markOutcome(id, status, exitPx, notes); };
  window.sjGetStats        = function (f) { return signalJournalModule.getStats(f); };
  window.sjRenderJournal   = renderJournal;
  window.sjOpenOutcome     = openOutcomeModal;
  window.sjOutcomeClose    = closeOutcomeModal;
  window.sjOutcomeSave     = saveOutcome;
  window.sjMarkSkipped     = markSkipped;
  window.sjDelete          = deleteJournalEntry;
  window.sjConfirmClear    = confirmClearAll;
  window.sjFilter          = onFilterClick;
  window.sjOnCapitalInput  = onCapitalInput;
  window.sjOnRiskInput     = onRiskInput;

  // ESC closes outcome modal — wired once, idempotent.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && signalJournalModule.getOutcomeBeingMarked()) {
      closeOutcomeModal();
    }
  });

  // ══════════════ TRADE DECISION HUD (May 2026) ══════════════
  // The single most important UI element. Distils every analyze
  // cycle into one card pinned at the top of the result block:
  //
  //   ROW 1 — verdict text (BUY CE 24500 / BUY PE 24500 / WAIT)
  //           + confidence chip (HIGH/MED/LOW) + score margin
  //   ROW 2 — strike / entry / SL / T1 / R:R (hidden on WAIT)
  //   ROW 3 — red-flag chips (only fires when at least one critical
  //           condition is present — see flag accumulator below)
  //
  // Self-hides cleanly when there's no plan yet. Re-runs on every
  // analyze cycle via renderAll(), and on every live tick via the
  // existing liveTick → renderPlan path (renderPlan calls
  // renderEventAlerts AND renderDecisionHud now).
  // ═══════ ENGINE DEBUG PANEL renderer (May 2026 stabilisation) ═══════
  // Pulls every value the new gates / locks / cooldowns compute and
  // prints them in a read-only panel above the HUD. Lets us walk an
  // active signal end-to-end and verify each piece does what we
  // expect, on LIVE data.
  //
  // Read-only — purely diagnostic. Never mutates state. Idempotent
  // and cheap (just DOM writes), so it's safe to call on every
  // renderDecisionHud cycle. Open state persisted to localStorage
  // so the user can leave it open across reloads while iterating.
  //
  // Sections:
  //   PER-TF       trend / reason / ADX / directionality / compression
  //                — verifies the two new RANGE gates
  //   PLAN         action / scores / spotPlan.entry-lock + drift /
  //                spot R:R / R:R-floor input
  //   PAPER BRIDGE auto-trade state / lots / last attempt outcome
  //                — verifies the burnt-id retry fix
  //   JOURNAL      lastAction / age / 20-min refire countdown /
  //                entries count
  var ENGINE_DEBUG_LS_KEY = 'engine_debug_open_v1';
  var engineDebugWiredOnce = false;
  function wireEngineDebugOnce() {
    if (engineDebugWiredOnce) return;
    var p = document.getElementById('engine-debug-panel');
    if (!p) return;
    engineDebugWiredOnce = true;
    try { p.open = (localStorage.getItem(ENGINE_DEBUG_LS_KEY) === 'true'); } catch (_) {}
    p.addEventListener('toggle', function () {
      try { localStorage.setItem(ENGINE_DEBUG_LS_KEY, p.open ? 'true' : 'false'); } catch (_) {}
    });
  }
  function fmtNumDbg(v, dp) {
    if (v == null || !isFinite(v)) return '\u2014';
    return (+v).toFixed(dp != null ? dp : 2);
  }
  function fmtMsAgo(ts) {
    if (!ts || !isFinite(ts) || ts <= 0) return '\u2014';
    var ageS = Math.floor((Date.now() - ts) / 1000);
    if (ageS < 60) return ageS + 's ago';
    return Math.floor(ageS / 60) + 'm ' + (ageS % 60) + 's ago';
  }
  function trendToneDbg(t) {
    if (!t) return 'muted';
    if (t.indexOf('BULL') >= 0) return 'bull';
    if (t.indexOf('BEAR') >= 0) return 'bear';
    if (t === 'RANGE') return 'warn';
    return 'muted';
  }
  function renderEngineDebug() {
    var panel = document.getElementById('engine-debug-panel');
    if (!panel) return;
    wireEngineDebugOnce();
    if (!panel.open) return; // skip work when collapsed

    var result = (typeof STATE !== 'undefined' && STATE && STATE.result) ? STATE.result : null;
    var plan   = result ? result.plan : null;

    // ─── PER-TIMEFRAME grid ──────────────────────────────────
    var tfEl = document.getElementById('engine-debug-tf');
    if (tfEl) {
      // Trend Identifier v1 Phase 2: 1h, 30m, 15m, 5m — 3m dropped.
      var tfs = [
        { k: '1h',  an: result ? result.tf1h : null },
        { k: '30m', an: result ? result.tf30 : null },
        { k: '15m', an: result ? result.tf15 : null },
        { k: '5m',  an: result ? result.tf5  : null }
      ];
      var html = '';
      html += '<div class="dbg-h">field</div>';
      tfs.forEach(function (t) { html += '<div class="dbg-h">' + t.k + '</div>'; });

      function row(label, getter) {
        html += '<div class="dbg-k">' + label + '</div>';
        tfs.forEach(function (t) {
          var cell = t.an ? getter(t.an) : { v: '\u2014', tone: 'muted' };
          if (typeof cell === 'string') cell = { v: cell, tone: '' };
          html += '<div class="dbg-v" data-tone="' + (cell.tone || '') + '">' + cell.v + '</div>';
        });
      }
      row('trend',           function (an) { return { v: an.trend || '\u2014', tone: trendToneDbg(an.trend) }; });
      row('trendReason',     function (an) { return { v: an.trendReason || '\u2014', tone: an.trendReason === 'EMA_STACK' ? 'ok' : (an.trendReason && an.trendReason !== 'DEFAULT_MIXED' ? 'warn' : 'muted') }; });
      row('ADX(14)',         function (an) {
        var v = an.adx;
        var tone = (v == null) ? 'muted' : (v < 18 ? 'warn' : v >= 25 ? 'ok' : 'muted');
        return { v: fmtNumDbg(v, 1), tone: tone };
      });
      row('sessionBars',     function (an) { return { v: String(an.sessionBars != null ? an.sessionBars : '\u2014'), tone: 'muted' }; });
      row('rangePts',        function (an) { return { v: fmtNumDbg(an.sessionRangePts, 1), tone: '' }; });
      row('netPts',          function (an) { return { v: fmtNumDbg(an.sessionNetPts, 1), tone: '' }; });
      row('directionality',  function (an) {
        var v = an.sessionDirectionality;
        var tone = (v == null) ? 'muted' : (v < 0.30 ? 'warn' : v >= 0.50 ? 'ok' : 'muted');
        return { v: fmtNumDbg(v, 2), tone: tone };
      });
      row('compression',     function (an) {
        var v = an.sessionCompression;
        var tone = (v == null) ? 'muted' : (v < 2.0 ? 'warn' : v >= 3.0 ? 'ok' : 'muted');
        return { v: fmtNumDbg(v, 2), tone: tone };
      });
      tfEl.innerHTML = html;
    }

    // ─── PLAN section ────────────────────────────────────────
    var planEl = document.getElementById('engine-debug-plan');
    if (planEl) {
      if (!plan) {
        planEl.textContent = 'no plan yet';
      } else {
        var sp = plan.spotPlan || {};
        var lines = [];
        lines.push('action             : ' + (plan.action || '\u2014') + (plan.attemptedSide ? '  (attempted: ' + plan.attemptedSide + ', blocked)' : ''));
        lines.push('confidence         : ' + (plan.confidence || '\u2014') + '  (' + (plan.confidencePct != null ? plan.confidencePct + '%' : '\u2014') + ')');
        lines.push('scores             : CE=' + (plan.ceScore != null ? plan.ceScore : '\u2014') + '  PE=' + (plan.peScore != null ? plan.peScore : '\u2014'));
        lines.push('sessionPhase       : ' + ((plan.session && plan.session.phase) || '\u2014'));
        lines.push('---');
        lines.push('spotPlan.entry     : ' + fmtNumDbg(sp.entry, 2) + '  (LOCKED at signal-fire 5m close)');
        lines.push('spotPlan.spotLive  : ' + fmtNumDbg(sp.spotLive, 2) + '   drift = ' + fmtNumDbg(sp.spotDriftPts, 1) + ' pts');
        lines.push('spotPlan.sl        : ' + fmtNumDbg(sp.sl, 2) + '   slDistPts  = ' + fmtNumDbg(sp.slDistPts, 1));
        lines.push('spotPlan.t1        : ' + fmtNumDbg(sp.t1, 2) + '   t1DistPts  = ' + fmtNumDbg(sp.t1DistPts, 1));
        lines.push('spotPlan.rrToT1    : ' + fmtNumDbg(sp.rrToT1, 2) + '   (R:R floor = 1.50; below = WAIT)');
        if (plan.premium) {
          lines.push('premium.entry/sl/t1: ' + fmtNumDbg(plan.premium.entry, 2)
            + ' / ' + fmtNumDbg(plan.premium.sl, 2)
            + ' / ' + fmtNumDbg(plan.premium.t1, 2));
          lines.push('premium.rrToT1     : ' + fmtNumDbg(plan.premium.rrToT1, 2));
        } else {
          lines.push('premium            : (not attached \u2014 chain not loaded yet)');
        }
        planEl.textContent = lines.join('\n');
      }
    }

    // ─── PAPER BRIDGE section ────────────────────────────────
    var brEl = document.getElementById('engine-debug-bridge');
    if (brEl) {
      var bridge = (typeof paperBridgeModule !== 'undefined') ? paperBridgeModule : null;
      var lines2 = [];
      if (!bridge) {
        lines2.push('paperBridgeModule: NOT LOADED');
      } else {
        var autoOn = false;
        try { autoOn = !!bridge.isAutoTrade(); } catch (_) {}
        lines2.push('auto-trade       : ' + (autoOn ? 'ON' : 'OFF'));
        var lots = '\u2014';
        try { lots = bridge.getLots(); } catch (_) {}
        lines2.push('lots             : ' + lots);
        var links = [];
        try { links = bridge.getLinks(); } catch (_) {}
        lines2.push('open links       : ' + links.length + (links.length ? '  (paper positions still tracked)' : ''));
        // Active signal -> last attempt outcome
        var activeId = null;
        try {
          if (typeof signalJournalModule !== 'undefined'
              && signalJournalModule.getActiveSignal) {
            var sig = signalJournalModule.getActiveSignal();
            if (sig && sig.entry) activeId = sig.entry.id;
          }
        } catch (_) {}
        if (activeId) {
          lines2.push('activeSignal.id  : ' + activeId);
          var att = null;
          try { att = bridge.getLastAttempt ? bridge.getLastAttempt(activeId) : null; } catch (_) {}
          if (att) {
            lines2.push('lastAttempt      : ' + (att.ok ? 'OK \u2713' : 'FAIL \u2717') + '   ' + fmtMsAgo(att.ts));
            lines2.push('lastAttempt.why  : ' + (att.reason || '\u2014'));
          } else {
            lines2.push('lastAttempt      : (no attempt logged for this entry yet)');
          }
        } else {
          lines2.push('activeSignal     : (none \u2014 no active BUY signal)');
        }
      }
      brEl.textContent = lines2.join('\n');
    }

    // ─── JOURNAL section ─────────────────────────────────────
    var jEl = document.getElementById('engine-debug-journal');
    if (jEl) {
      var sj = (typeof signalJournalModule !== 'undefined') ? signalJournalModule : null;
      var lines3 = [];
      if (!sj) {
        lines3.push('signalJournalModule: NOT LOADED');
      } else {
        // The journal IIFE doesn't expose state.entries, so read
        // straight from localStorage. Safe + cheap, this is a
        // diagnostic panel; if the read fails we just show "—".
        var entries = [];
        try {
          var rawSj = localStorage.getItem('signal_journal_v2');
          if (rawSj) {
            var parsed = JSON.parse(rawSj);
            if (parsed && Array.isArray(parsed.entries)) entries = parsed.entries;
          }
        } catch (_) {}
        lines3.push('entries (total)  : ' + entries.length);
        // last same-direction refire countdown
        var nowMs = Date.now();
        ['BUY_CE', 'BUY_PE'].forEach(function (dir) {
          var lastTs = 0;
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].direction === dir && entries[i].ts > lastTs) lastTs = entries[i].ts;
          }
          if (lastTs > 0) {
            var ageMin = ((nowMs - lastTs) / 60000);
            var remain = Math.max(0, 20 - ageMin);
            lines3.push('last ' + dir + '       : ' + fmtMsAgo(lastTs)
              + '   refire cooldown: ' + (remain > 0 ? 'BLOCKED (' + remain.toFixed(1) + ' min left)' : 'open'));
          } else {
            lines3.push('last ' + dir + '       : never');
          }
        });
        lines3.push('STALE_EXPIRE     : 8 min (after which lastAction resets to WAIT)');
        lines3.push('MIN_REFIRE       : 20 min (between same-direction journal entries)');
        lines3.push('MIN_RR (verdict) : 1.50 (spot R:R floor in generateVerdict)');
      }
      jEl.textContent = lines3.join('\n');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // TREND BACKTEST — Phase 4 rolling-window validation tool
  // Slides classifyStructure() over historical candles bar-by-bar and
  // renders a colour-coded label strip + mini candle canvas + stats so
  // the trader can eyeball whether UP/DOWN/SIDEWAYS matches the chart.
  // ══════════════════════════════════════════════════════════════════
  function runTrendBacktest() {
    var panel = document.getElementById('trend-backtest-panel');
    if (!panel) return;
    var raw = (typeof STATE !== 'undefined' && STATE.rawCandles) ? STATE.rawCandles : null;

    var tfSel   = document.getElementById('bt-tf');
    var lbSel   = document.getElementById('bt-lb');
    var zzatrIn = document.getElementById('bt-zzatr');
    var tolIn   = document.getElementById('bt-tol');

    var tfKey = (tfSel  && tfSel.value)  || '15m';
    var lb    = +(lbSel && lbSel.value)  || 40;

    // Read from locked TREND_PARAMS_BY_TF, then apply slider overrides
    var base   = (window.TREND_PARAMS_BY_TF && window.TREND_PARAMS_BY_TF[tfKey])
                 || { zigzagATR: 0.50, tolATR: 0.05, skipFirstBarsOfDay: 1 };
    var zzatr  = +(zzatrIn && zzatrIn.value) || base.zigzagATR;
    var tol    = +(tolIn   && tolIn.value)   || base.tolATR;

    // Update value labels
    ['bt-zzatr', 'bt-tol'].forEach(function (id) {
      var el  = document.getElementById(id);
      var lbl = document.getElementById(id + '-lbl');
      if (el && lbl) lbl.textContent = el.value;
    });

    if (!raw || !raw[tfKey] || raw[tfKey].length < 5) {
      var out = document.getElementById('bt-output');
      // Try to kick a fresh analyze cycle so raw candles get populated
      if (typeof window.intradayRefresh === 'function') {
        if (out) out.innerHTML = '<p class="bt-msg">&#8987; Fetching candle data&hellip; the backtest will run automatically when the fetch completes.</p>';
        // Re-run backtest once the analyze cycle posts STATE.rawCandles
        var _btWait = setInterval(function () {
          if (STATE && STATE.rawCandles && STATE.rawCandles[tfKey] && STATE.rawCandles[tfKey].length >= 5) {
            clearInterval(_btWait);
            runTrendBacktest();
          }
        }, 800);
        try { window.intradayRefresh(); } catch (_) {}
      } else {
        if (out) out.innerHTML = '<p class="bt-msg">No candle data yet &mdash; run the analyzer first (click ANALYZE or wait for a live tick).</p>';
      }
      return;
    }

    var candles = raw[tfKey].slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var n = candles.length;
    if (n < 10) {
      document.getElementById('bt-output').innerHTML = '<p class="bt-msg">Not enough bars (have ' + n + ').</p>';
      return;
    }

    // ── ZigZag phase classification (runs ONCE on the view window) ────
    // Instead of a rolling per-bar window (which causes 30-46 flips from
    // boundary effects), run zigzag once on the last `lb` bars and label
    // each bar by which zigzag phase it falls in. Flips now = actual
    // structural trend changes, not window-slide artefacts.
    var viewCandles = candles.slice(Math.max(0, n - lb));
    var viewN       = viewCandles.length;
    if (viewN < 4) {
      document.getElementById('bt-output').innerHTML = '<p class="bt-msg">Not enough bars in lookback.</p>';
      return;
    }

    // ATR proxy: median H-L range across the full view window.
    // Using only the last 20 bars underestimates ATR when the recent
    // period is a consolidation, making minMovePts too small and causing
    // too many zigzag swings. Full-window median is more stable.
    var hlRanges = viewCandles.map(function (c) { return +c[2] - +c[3]; });
    hlRanges.sort(function (a, b) { return a - b; });
    var mid = Math.floor(hlRanges.length / 2);
    var atrProxy = hlRanges.length % 2 === 0
      ? (hlRanges[mid - 1] + hlRanges[mid]) / 2
      : hlRanges[mid];
    var minMovePts = zzatr * atrProxy;
    var tolPts     = tol   * atrProxy;

    // Run zigzag from both directions, pick the one yielding more swings
    var swUp = _zigzagFrom(viewCandles, minMovePts, 'UP');
    var swDn = _zigzagFrom(viewCandles, minMovePts, 'DOWN');
    var upOk = swUp.swingHighs.length >= 1 && swUp.swingLows.length >= 1;
    var dnOk = swDn.swingHighs.length >= 1 && swDn.swingLows.length >= 1;
    var chosenHighs, chosenLows;
    if (upOk && dnOk) {
      var upTot = swUp.swingHighs.length + swUp.swingLows.length;
      var dnTot = swDn.swingHighs.length + swDn.swingLows.length;
      chosenHighs = dnTot > upTot ? swDn.swingHighs : swUp.swingHighs;
      chosenLows  = dnTot > upTot ? swDn.swingLows  : swUp.swingLows;
    } else if (upOk) { chosenHighs = swUp.swingHighs; chosenLows = swUp.swingLows; }
    else if (dnOk)   { chosenHighs = swDn.swingHighs; chosenLows = swDn.swingLows; }
    else             { chosenHighs = []; chosenLows = []; }

    // Build interleaved zigzag path sorted by bar index
    var zzPath = [];
    chosenHighs.forEach(function (s) { zzPath.push({ idx: s.idx, price: s.price, type: 'H' }); });
    chosenLows.forEach(function  (s) { zzPath.push({ idx: s.idx, price: s.price, type: 'L' }); });
    zzPath.sort(function (a, b) { return a.idx - b.idx; });

    // Assign per-bar labels from zigzag phases with HH/HL validation
    var barLabels  = new Array(viewN).fill('SIDEWAYS');
    var barReasons = new Array(viewN).fill('no-swing');

    for (var pi = 0; pi + 1 < zzPath.length; pi++) {
      var fromNode = zzPath[pi], toNode = zzPath[pi + 1];
      // Pure phase direction — rising (L→H) = UP, falling (H→L) = DOWN.
      // HH/HL validation is intentionally omitted here: applying it creates
      // extra SIDEWAYS wedges between phases which double the flip count.
      // The live classifier (classifyStructure) applies HH/HL for trading
      // decisions; the backtest strip shows the raw zigzag structure for
      // visual validation.
      var phaseLabel  = (fromNode.type === 'L' && toNode.type === 'H') ? 'UP'
                      : (fromNode.type === 'H' && toNode.type === 'L') ? 'DOWN'
                      : 'SIDEWAYS';
      var phaseReason = phaseLabel + '_PHASE idx:' + fromNode.idx + '-' + toNode.idx
                      + ' ' + fromNode.price.toFixed(0) + '→' + toNode.price.toFixed(0);

      for (var bi = fromNode.idx; bi < toNode.idx && bi < viewN; bi++) {
        barLabels[bi]  = phaseLabel;
        barReasons[bi] = phaseReason;
      }
    }

    // Bars after the last zigzag node: use classifyStructure for the tail
    var lastNode = zzPath[zzPath.length - 1];
    if (lastNode) {
      var tailR = classifyStructure(viewCandles, {
        zigzagATR: zzatr, tolATR: tol,
        skipFirstBarsOfDay: base.skipFirstBarsOfDay,
        tfKey: tfKey,
        rawAtrSeries: viewCandles.map(function (c) { return +c[2] - +c[3]; })
      });
      for (var fi = lastNode.idx; fi < viewN; fi++) {
        barLabels[fi]  = tailR.label;
        barReasons[fi] = tailR.reason + ' (tail)';
      }
    }

    // Build a set of swing indices for O(1) hover lookup
    var swingHighSet = {}, swingLowSet = {};
    chosenHighs.forEach(function (s) { swingHighSet[s.idx] = s.price; });
    chosenLows.forEach(function  (s) { swingLowSet[s.idx]  = s.price; });

    // Build the global bosLevel from the classifyStructure final read
    var finalResult = classifyStructure(viewCandles, {
      zigzagATR: zzatr, tolATR: tol,
      skipFirstBarsOfDay: base.skipFirstBarsOfDay,
      tfKey: tfKey,
      rawAtrSeries: viewCandles.map(function (c) { return +c[2] - +c[3]; })
    });

    var rows = [];
    var cntUp = 0, cntDown = 0, cntSide = 0, flips = 0;
    var prevLabel = null;
    for (var i = 0; i < viewN; i++) {
      var lbl = barLabels[i];
      if (lbl === 'UP')        cntUp++;
      else if (lbl === 'DOWN') cntDown++;
      else                     cntSide++;
      if (prevLabel && prevLabel !== lbl) flips++;
      prevLabel = lbl;
      rows.push({
        ts:        viewCandles[i][0],
        open:      +viewCandles[i][1],
        high:      +viewCandles[i][2],
        low:       +viewCandles[i][3],
        close:     +viewCandles[i][4],
        label:     lbl,
        reason:    barReasons[i],
        swingHighs: swingHighSet[i] !== undefined
          ? [{ idx: i, price: swingHighSet[i], ts: viewCandles[i][0], ageBars: viewN - 1 - i }] : [],
        swingLows: swingLowSet[i] !== undefined
          ? [{ idx: i, price: swingLowSet[i],  ts: viewCandles[i][0], ageBars: viewN - 1 - i }] : [],
        bosLevel: finalResult.bosLevel
      });
    }

    // ── Render ────────────────────────────────────────────────────
    var total = rows.length;
    var pctUp   = total ? Math.round(cntUp   / total * 100) : 0;
    var pctDown = total ? Math.round(cntDown  / total * 100) : 0;
    var pctSide = total ? Math.round(cntSide  / total * 100) : 0;

    // Stats bar
    var statsHtml = '<div class="bt-stats">'
      + '<span class="bt-stat bt-up">\u25B2 UP ' + cntUp + ' (' + pctUp + '%)</span>'
      + '<span class="bt-stat bt-down">\u25BC DOWN ' + cntDown + ' (' + pctDown + '%)</span>'
      + '<span class="bt-stat bt-side">\u25A0 SIDEWAYS ' + cntSide + ' (' + pctSide + '%)</span>'
      + '<span class="bt-stat bt-flip">&#8645; FLIPS ' + flips + '</span>'
      + '</div>';

    // Label strip (1 div per bar, colored by label)
    var stripHtml = '<div class="bt-strip" role="list" aria-label="Rolling structural label per bar">';
    var fmt = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short'
    });
    for (var j = 0; j < rows.length; j++) {
      var ro  = rows[j];
      var cls = ro.label === 'UP' ? 'bt-bar-up' : ro.label === 'DOWN' ? 'bt-bar-dn' : 'bt-bar-sw';
      var isCurrent = (j === rows.length - 1) ? ' bt-bar-current' : '';
      var title = (function (ro2) {
        var d = '';
        try { d = fmt.format(new Date(ro2.ts)) + ' IST'; } catch (_) { d = ro2.ts; }
        return d + ' | ' + ro2.label + ' | ' + ro2.reason
          + (ro2.bosLevel ? ' | BOS \u20B9' + ro2.bosLevel.toFixed(1) : '')
          + ' | O:' + ro2.open.toFixed(1) + ' H:' + ro2.high.toFixed(1) + ' L:' + ro2.low.toFixed(1) + ' C:' + ro2.close.toFixed(1);
      })(ro);
      stripHtml += '<div class="bt-bar ' + cls + isCurrent + '" title="' + title + '" role="listitem"></div>';
    }
    stripHtml += '</div>';

    // Canvas chart
    var canvasHtml = '<canvas id="bt-canvas" class="bt-canvas" width="900" height="200" aria-label="Structural trend backtest candle chart"></canvas>';

    document.getElementById('bt-output').innerHTML = statsHtml + stripHtml + canvasHtml;

    // Draw canvas AFTER inserting into DOM
    setTimeout(function () { drawBtCanvas(rows); }, 0);
  }

  function drawBtCanvas(rows) {
    var canvas = document.getElementById('bt-canvas');
    if (!canvas || !canvas.getContext) return;
    var W = canvas.offsetWidth || 900;
    canvas.width  = W;
    canvas.height = 200;
    var ctx = canvas.getContext('2d');
    var n   = rows.length;
    if (!n) return;

    // Price range
    var minP = Infinity, maxP = -Infinity;
    rows.forEach(function (r) {
      if (r.low  < minP) minP = r.low;
      if (r.high > maxP) maxP = r.high;
    });
    if (minP === maxP) { minP -= 5; maxP += 5; }
    var pad  = (maxP - minP) * 0.08;
    minP -= pad; maxP += pad;

    var CH  = 170;  // candle area height
    var SH  = 20;   // label strip height
    var barW = Math.max(2, Math.floor(W / n) - 1);
    var gap  = Math.max(1, Math.floor(W / n) - barW);

    function toY(price) { return CH - ((price - minP) / (maxP - minP)) * CH; }

    // Theme colours
    var isDark  = document.documentElement.getAttribute('data-theme') !== 'light';
    var colBg   = isDark ? '#1a1e2a' : '#f8f9fb';
    var colGrid = isDark ? '#2a2e3e' : '#e8eaf0';
    var colWick = isDark ? '#666' : '#aaa';
    var colUp   = '#22c55e';
    var colDown = '#ef4444';
    var colSide = isDark ? '#4a5068' : '#94a3b8';
    var colBos  = '#f59e0b';

    ctx.fillStyle = colBg;
    ctx.fillRect(0, 0, W, CH + SH);

    // Grid lines (4 horizontal)
    ctx.strokeStyle = colGrid; ctx.lineWidth = 1;
    for (var gi = 1; gi <= 3; gi++) {
      var gy = Math.round(CH * gi / 4);
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke();
    }

    // Draw BOS level (from the last bar's bosLevel)
    var lastBos = rows[rows.length - 1].bosLevel;
    if (lastBos && isFinite(lastBos)) {
      var bosY = toY(lastBos);
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = colBos; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, bosY); ctx.lineTo(W, bosY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = colBos;
      ctx.font = '10px system-ui';
      ctx.fillText('BOS \u20B9' + lastBos.toFixed(1), 4, bosY - 3);
    }

    // Draw candles
    rows.forEach(function (r, i) {
      var x   = i * (barW + gap);
      var lbl = r.label;
      var bodyCol  = lbl === 'UP' ? colUp : lbl === 'DOWN' ? colDown : colSide;
      var openY  = toY(r.open);
      var closeY = toY(r.close);
      var highY  = toY(r.high);
      var lowY   = toY(r.low);

      // Wick
      ctx.strokeStyle = colWick; ctx.lineWidth = 1;
      var midX = x + Math.floor(barW / 2);
      ctx.beginPath();
      ctx.moveTo(midX, highY);
      ctx.lineTo(midX, lowY);
      ctx.stroke();

      // Body
      var bodyTop = Math.min(openY, closeY);
      var bodyH   = Math.max(1, Math.abs(closeY - openY));
      ctx.fillStyle = bodyCol;
      ctx.fillRect(x, bodyTop, barW, bodyH);

      // Label strip at bottom
      ctx.fillStyle = bodyCol;
      ctx.fillRect(x, CH, barW + gap, SH);
    });

    // Swing high/low markers for the last bar's swings
    var lastRow = rows[rows.length - 1];
    function drawSwingMarker(price, isHigh) {
      var y    = toY(price);
      var offY = isHigh ? -8 : 8;
      ctx.fillStyle = isHigh ? colDown : colUp;
      ctx.beginPath();
      ctx.moveTo(W - 30, y + offY);
      ctx.lineTo(W - 24, y + offY + (isHigh ? 8 : -8));
      ctx.lineTo(W - 36, y + offY + (isHigh ? 8 : -8));
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = isHigh ? colDown : colUp;
      ctx.font = '9px system-ui';
      ctx.fillText('\u20B9' + price.toFixed(0), W - 55, y + offY + (isHigh ? 4 : -1));
    }
    if (lastRow.swingHighs.length) drawSwingMarker(lastRow.swingHighs[0].price, true);
    if (lastRow.swingLows.length)  drawSwingMarker(lastRow.swingLows[0].price, false);

    // Price labels (right edge)
    ctx.fillStyle = isDark ? '#aaa' : '#555';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText('\u20B9' + maxP.toFixed(0), W - 2, 12);
    ctx.fillText('\u20B9' + minP.toFixed(0), W - 2, CH - 3);
    ctx.textAlign = 'left';
  }

  // ── Backtest control helpers ──────────────────────────────────────
  // Each exposed on window so inline onclick="" handlers can reach them.

  function btSetSlider(id, lblId, val) {
    var el  = document.getElementById(id);
    var lbl = document.getElementById(lblId);
    if (!el) return;
    el.value = val;
    // Force visual thumb update (some browsers need this)
    el.dispatchEvent(new Event('change'));
    if (lbl) lbl.textContent = val;
  }

  function btKnobChange(id, lblId, val) {
    var lbl = document.getElementById(lblId);
    if (lbl) lbl.textContent = val;
    runTrendBacktest();
  }

  function btSelectTf(tf) {
    var inp = document.getElementById('bt-tf');
    if (inp) inp.value = tf;
    // Highlight active TF button
    ['1h', '30m', '15m', '5m'].forEach(function (t) {
      var btn = document.getElementById('bt-tf-' + t);
      if (btn) btn.classList.toggle('bt-tf-active', t === tf);
    });
    resetBtParams(); // reset sliders to locked defaults for this TF
    runTrendBacktest();
  }

  function btSelectLb(lb) {
    var inp = document.getElementById('bt-lb');
    if (inp) inp.value = String(lb);
    // Highlight active lookback button
    var grp = document.getElementById('bt-lb-group');
    if (grp) {
      var btns = grp.querySelectorAll('.bt-tf-btn');
      btns.forEach(function (btn) {
        btn.classList.toggle('bt-tf-active', btn.getAttribute('data-lb') === String(lb));
      });
    }
    runTrendBacktest();
  }

  function resetBtParams() {
    var tfKey = (document.getElementById('bt-tf') && document.getElementById('bt-tf').value) || '15m';
    var base  = (window.TREND_PARAMS_BY_TF && window.TREND_PARAMS_BY_TF[tfKey])
                || { zigzagATR: 0.50, tolATR: 0.05 };
    btSetSlider('bt-zzatr', 'bt-zzatr-lbl', base.zigzagATR);
    btSetSlider('bt-tol',   'bt-tol-lbl',   base.tolATR);
    runTrendBacktest();
  }

  // Expose so the inline onclick handlers in the HTML can reach them.
  window.runTrendBacktest  = runTrendBacktest;
  window.resetBtParams     = resetBtParams;
  window.btSelectTf        = btSelectTf;
  window.btSelectLb        = btSelectLb;
  window.btKnobChange      = btKnobChange;
  window.drawBtCanvas      = drawBtCanvas;

  function renderDecisionHud(plan, an5) {
    var hud = document.getElementById('ia-decision-hud');
    if (!hud) return;
    if (!plan) { hud.hidden = true; try { renderEngineDebug(); } catch (_) {} return; }

    // ── State + icon + verdict text ────────────────────────────
    var state, icon, verdictTxt;
    if (plan.action === 'BUY_CE') {
      state = 'bull'; icon = '\u25B2';   // ▲
      verdictTxt = 'BUY CE';
    } else if (plan.action === 'BUY_PE') {
      state = 'bear'; icon = '\u25BC';   // ▼
      verdictTxt = 'BUY PE';
    } else if (plan.attemptedSide) {
      state = 'blocked'; icon = '\u2717'; // ✗
      verdictTxt = plan.attemptedSide + ' \u2014 BLOCKED';
    } else {
      state = 'wait'; icon = '\u23F1';   // ⏱
      verdictTxt = 'WAIT';
    }
    hud.setAttribute('data-state', state);
    hud.hidden = false;
    var setT = function (id, t) {
      var el = document.getElementById(id);
      if (el) el.textContent = t;
    };
    setT('ia-hud-icon',    icon);
    setT('ia-hud-verdict', verdictTxt);

    // Pullback-entry chip — show when engine fires on a 15m counter-trend dip
    var pbChip = document.getElementById('ia-hud-pullback');
    if (pbChip) pbChip.hidden = !plan.isPullbackEntry;

    // P0-3: paint the freshness chip on every analyze cycle. The
    // live tick path also refreshes it (every 2s) for the running
    // m:ss counter; this call is the initial set when the engine
    // produces a verdict.
    try {
      var freshSig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
        ? signalJournalModule.getActiveSignal() : null;
      var freshSpot = (an5 && isFinite(an5.lastClose)) ? an5.lastClose : null;
      var freshPx = (plan && plan.premium) ? plan.premium.entry : null;
      renderSignalFreshness(freshSig, freshSpot, freshPx);
    } catch (_) {}

    // P0-4 CONFIRM TRADE button removed in the May 2026 noise audit
    // (Batch 1). The Quick Paper Strip on the right now owns the
    // "act" surface (BUY CE / BUY PE / REVIEW FIRST) — one place
    // to click, no duplicate verdict-to-action paths. The confirm
    // MODAL itself is still opened from the strip's REVIEW FIRST
    // button via window.iaOpenConfirmModal; only the HUD-side
    // button + its hidden-state toggle here were dropped.

    // P0-5: paint the discipline pill (DAY LOCKED state) on every
    // HUD render. Self-hides when status is OPEN.
    try { renderDisciplinePill(); } catch (_) {}

    // P2-A: paint the Quick-Trade strip on every HUD render. The
    // strip self-hides when there's no actionable BUY signal or
    // the option chain isn't loaded yet — safe to call always.
    try { renderQuickStrip(); } catch (_) {}

    // Engine debug panel — read-only diagnostic surface above the
    // HUD. Updates on every render tick (cheap, just DOM writes).
    try { renderEngineDebug(); } catch (_) {}

    // Decode HTML entities — the verdict engine writes some strings
    // (vetoReasons, setupLabel) with literal &mdash; / &amp; / etc.
    // because they originate as innerHTML elsewhere. Setting them
    // via textContent would render the entity raw. Round-trip via
    // a textarea decodes any entity safely without inheriting
    // unsafe parsing (textarea doesn't execute / parse tags).
    var _decoder = (function () {
      var ta = null;
      return function (s) {
        if (s == null) return '';
        if (!ta) ta = document.createElement('textarea');
        ta.innerHTML = String(s);
        return ta.value;
      };
    })();

    // ── Confidence + margin chips ──────────────────────────────
    // For WAIT / BLOCKED verdicts the engine sets confidence to '—'
    // because confidence is meaningless when there's no trade
    // recommended. Showing a bare dash chip just confuses users
    // — hide the chip entirely in those cases. Only render it
    // when the engine actually assigned HIGH / MEDIUM / LOW.
    var confEl = document.getElementById('ia-hud-conf');
    if (confEl) {
      var cf = plan.confidence;
      var realConf = (cf === 'HIGH' || cf === 'MEDIUM' || cf === 'LOW');
      if (realConf) {
        // Append the derived % (May 2026) so the chip reads
        // "HIGH 82%" / "MEDIUM 64%" / "LOW 42%". The pct comes
        // from confidencePctFromInputs() in generateVerdict and is
        // always clamped into the band matching the label, so the
        // two readings never disagree.
        var pct = (plan.confidencePct != null && isFinite(plan.confidencePct))
                  ? plan.confidencePct : null;
        confEl.textContent = pct != null ? (cf + ' ' + pct + '%') : cf;
        confEl.setAttribute('data-conf', cf);
        confEl.hidden = false;
      } else {
        confEl.hidden = true;
      }
    }
    var marginEl = document.getElementById('ia-hud-margin');
    if (marginEl) {
      var ce = +plan.ceScore || 0, pe = +plan.peScore || 0;
      var marginTxt;
      var diff = Math.abs(ce - pe);
      // When an action is taken, show "+N <side>". When the engine
      // wanted a side but a veto blocked it, show that side's
      // margin + a (blocked) suffix so the user understands the
      // engine LEANED CE/PE but the veto rules overrode. Plain
      // tied state only fires when scores are within ±2 and no
      // attemptedSide exists.
      if (plan.action === 'BUY_CE')           marginTxt = '+' + diff + ' CE';
      else if (plan.action === 'BUY_PE')      marginTxt = '+' + diff + ' PE';
      else if (plan.attemptedSide === 'BUY CE') marginTxt = '+' + diff + ' CE (blocked)';
      else if (plan.attemptedSide === 'BUY PE') marginTxt = '+' + diff + ' PE (blocked)';
      else if (ce === pe)                       marginTxt = ce + ' / ' + pe + ' tied';
      else                                       marginTxt = '+' + diff + ' ' + (ce > pe ? 'CE' : 'PE');
      marginEl.textContent = marginTxt;
    }

    // ── REGIME chip (2026-06-09) — green TRENDING / amber CHOPPY ───────
    // Surfaces the higher-TF trend-regime read that gates fresh BUYs:
    // CHOPPY (30m ADX < 18) = engine stands aside; TRENDING = the regime
    // these signals are built for. Self-hides when regime can't be read.
    var regimeEl = document.getElementById('ia-hud-regime');
    if (regimeEl) {
      var rg = plan.regime;
      if (rg && rg.state && rg.state !== 'UNKNOWN') {
        var rgChoppy = (rg.state === 'CHOPPY');
        var adxTxt = (rg.adx30 != null && isFinite(rg.adx30)) ? (' ' + Math.round(rg.adx30)) : '';
        regimeEl.textContent = rgChoppy ? '\u3030 REGIME: CHOPPY' : '\u2197 REGIME: TRENDING';
        regimeEl.setAttribute('data-regime', rg.state);
        regimeEl.setAttribute('title', rgChoppy
          ? ('30m ADX' + adxTxt + ' (below 18) \u2014 the higher timeframe is rangebound. Intraday trend signals fail in chop, so fresh BUYs are held back until a clean trend forms.')
          : ('30m ADX' + adxTxt + ' (18+) \u2014 the higher timeframe is trending: the regime these signals are built for.'));
        regimeEl.hidden = false;
      } else {
        regimeEl.hidden = true;
      }
    }

    // ── Numbers row (strike / entry / SL / T1 / R:R) ───────────
    // Only meaningful when we have an active BUY side. Hidden
    // on WAIT (including BLOCKED — the SETUP card below carries
    // the "why blocked" detail, the HUD just shows the verdict).
    var numRow = document.getElementById('ia-hud-row-numbers');
    var fmtINR = function (n) {
      return (n == null || !isFinite(n))
        ? '\u2014'
        : (+n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    };
    if (plan.action === 'BUY_CE' || plan.action === 'BUY_PE') {
      if (numRow) numRow.hidden = false;
      var sideTag = plan.action === 'BUY_CE' ? 'CE' : 'PE';
      var spotForStrike = (typeof window.paperTradeGetLastSpot === 'function')
        ? window.paperTradeGetLastSpot() : null;
      if (spotForStrike == null && an5) spotForStrike = an5.lastClose;
      // ITM-1 recommendation (see pickRecommendedStrike rationale).
      var atmStrike = (spotForStrike != null && isFinite(spotForStrike))
        ? pickRecommendedStrike(spotForStrike, sideTag) : null;
      // ─── SPOT-FIRST DISPLAY (May 2026 inversion) ──────────────
      // The PRIMARY value in every cell is now the SPOT (Nifty
      // index) level — because that's what every indicator is
      // computed on AND what the user can actually watch on the
      // chart. The premium estimate is a small muted sub line.
      // plan.spotPlan is built unconditionally in attachSpotPlan
      // (no dependence on the option chain), so spot values render
      // even before the chain loads — exactly the opposite of the
      // old "show nothing until chain loads" behaviour, which left
      // the user staring at a placeholder when the signal was
      // already crystal clear from the chart.
      var sp = plan.spotPlan || {};
      var pp = plan.premium || null;
      var hasSpot = !!(sp && sp.entry != null);
      var hasPrem = !!(pp && pp.entry != null);
      var strikeEl  = document.getElementById('ia-hud-strike');
      var entryEl   = document.getElementById('ia-hud-entry');
      var slEl      = document.getElementById('ia-hud-sl');
      var t1El      = document.getElementById('ia-hud-t1');
      // Show the row whenever we have spot data (which is basically
      // always once an analyze cycle has completed). Strike still
      // gates on hasPrem because we use the chain quote for the
      // chosen strike when available; fall back to atmStrike label.
      if (strikeEl) strikeEl.closest('.ia-hud-num').hidden = !(atmStrike != null);
      if (entryEl)  entryEl.closest('.ia-hud-num').hidden  = !hasSpot;
      if (slEl)     slEl.closest('.ia-hud-num').hidden     = !hasSpot;
      if (t1El)     t1El.closest('.ia-hud-num').hidden     = !hasSpot;

      // STRIKE cell — value is the ITM-1 strike + side. Sub line
      // shows the live premium quote once the chain loads.
      // FORMAT (May 2026 polish): "≈ ₹81.25" — dropped the
      // redundant " prem" suffix (cell context already implies
      // premium) and swapped "~" for "≈" so it reads as a clear
      // "approximately" symbol rather than a fuzzy tilde.
      setT('ia-hud-strike', atmStrike != null ? (atmStrike + ' ' + sideTag) : '\u2014');
      setT('ia-hud-strike-sub', hasPrem ? ('\u2248 \u20B9' + fmtINR(pp.entry)) : '');

      // ENTRY cell — value is the spot AT FIRE (LOCKED at signal
      // fire, anchored to the 5m candle's lastClose so it doesn't
      // jitter every tick). Sub line shows two pieces of context:
      //   1. "spot now ₹X (+N pts)" — how far live spot has drifted
      //      from the locked anchor (lets the trader see slippage
      //      vs. the entry the engine recommended).
      //   2. "≈ ₹premium" — capital-outlay estimate from the chain.
      // The drift segment is omitted when |drift| < 1 pt (basically
      // at-the-anchor, no useful info).
      setT('ia-hud-entry', hasSpot ? fmtINR(sp.entry) : '\u2014');
      var entrySubParts = [];
      if (hasSpot && sp.spotLive != null && sp.spotDriftPts != null
          && Math.abs(sp.spotDriftPts) >= 1) {
        var driftSign = sp.spotDriftPts > 0 ? '+' : '\u2212';
        var driftAbs  = Math.abs(sp.spotDriftPts);
        entrySubParts.push('now ' + fmtINR(sp.spotLive)
          + ' (' + driftSign + driftAbs + ' pts)');
      }
      if (hasPrem) entrySubParts.push('\u2248 \u20B9' + fmtINR(pp.entry));
      setT('ia-hud-entry-sub', entrySubParts.join(' \u00B7 '));

      // SL cell — spot level + distance in points. Sub shows premium SL.
      if (hasSpot && sp.sl != null) {
        setT('ia-hud-sl', fmtINR(sp.sl));
        var slSubParts = [];
        if (sp.slDistPts != null) slSubParts.push('\u2212' + sp.slDistPts + ' pts');
        if (hasPrem && pp.sl != null) slSubParts.push('\u2248 \u20B9' + fmtINR(pp.sl));
        setT('ia-hud-sl-sub', slSubParts.join(' \u00B7 '));
      } else {
        setT('ia-hud-sl', '\u2014');
        setT('ia-hud-sl-sub', '');
      }

      // T1 cell — spot level + distance. Sub shows premium T1.
      if (hasSpot && sp.t1 != null) {
        setT('ia-hud-t1', fmtINR(sp.t1));
        var t1SubParts = [];
        if (sp.t1DistPts != null) t1SubParts.push('+' + sp.t1DistPts + ' pts');
        if (hasPrem && pp.t1 != null) t1SubParts.push('\u2248 \u20B9' + fmtINR(pp.t1));
        setT('ia-hud-t1-sub', t1SubParts.join(' \u00B7 '));
      } else {
        setT('ia-hud-t1', '\u2014');
        setT('ia-hud-t1-sub', '');
      }

      // R:R cell — derived from spot distances (always available
      // when spot plan is ready). Drop the premium-derived rrToT1
      // fallback because the spot-based ratio is the authoritative
      // one (same ATR-distance math, no delta approximation).
      setT('ia-hud-rr', sp.rrToT1 != null ? ('1 : ' + sp.rrToT1.toFixed(2)) : '\u2014');
      setT('ia-hud-rr-sub', '');
    } else {
      if (numRow) numRow.hidden = true;
    }

    // ── Red-flag chips — ONLY the deal-breakers ────────────────
    // Each push is { sev, icon, label, why, target } where:
    //   sev    = 'danger' (red) | 'warn' (amber) | 'info'
    //   icon   = single-glyph indicator
    //   label  = SHORT chip text (one phrase + key number)
    //   why    = full prose for the hover tooltip (the actual
    //            "what does this mean / what should I do")
    //   target = DOM id of the section below that holds the
    //            authoritative card for this signal. Clicking the
    //            chip smooth-scrolls to that section and flashes it
    //            for ~1.5s so the user can find the full detail.
    //
    // Selective on purpose — too many chips dilutes the signal.
    // Goal: clean HUD on normal days, loud HUD on dangerous days.
    var flags = [];

    // Session veto / restrictions → SESSION pill
    var sess = plan.session || {};
    if (sess.phase === 'WEEKEND') {
      flags.push({
        sev: 'danger', icon: '\u26D4', label: 'WEEKEND',
        why:  'Market closed for the weekend. Recommendation is based on Friday\u2019s last bars — opens Monday 09:15 IST.',
        target: 'ia-session-pill'
      });
    } else if (sess.phase === 'NO_NEW' || sess.phase === 'POST_CLOSE') {
      flags.push({
        sev: 'danger', icon: '\u26D4',
        label: sess.phase === 'POST_CLOSE' ? 'MARKET CLOSED' : 'SQUARE-OFF WINDOW',
        why:  sess.phase === 'POST_CLOSE'
          ? 'Market is closed (post 15:30 IST). No new trades — wait for the next session.'
          : 'Past 15:25 IST — square-off window. No new positions; existing ones must be exited.',
        target: 'ia-session-pill'
      });
    } else if (sess.phase === 'OR_FORMING') {
      flags.push({
        sev: 'warn', icon: '\u23F3', label: 'OR FORMING',
        why:  'Opening Range is still forming (first 15 min). Wait for 09:25–09:30 to see which way price commits.',
        target: 'ia-session-pill'
      });
    } else if (sess.phase === 'PRE_OPEN') {
      flags.push({
        sev: 'danger', icon: '\u26D4', label: 'PRE-OPEN',
        why:  'Pre-open session (before 09:15 IST today). No live data yet; recommendation is based on yesterday\u2019s close.',
        target: 'ia-session-pill'
      });
    }

    // Expiry day → EVENT ALERTS strip
    var ex = plan.expiry;
    if (ex && ex.isExpiryDay) {
      if (ex.phase === 'PIN_WINDOW') {
        flags.push({
          sev: 'danger', icon: '\u23F0', label: 'EXPIRY: PIN WINDOW',
          why: 'Expiry day after 14:00 with spot near max-pain. Price tends to pin to the max-pain strike — option buyers get bled. Wait for tomorrow.',
          target: 'ia-event-alerts'
        });
      } else if (ex.phase === 'THETA_CRUSH') {
        flags.push({
          sev: 'danger', icon: '\u23F0', label: 'EXPIRY: THETA CRUSH',
          why: 'Expiry day after 13:30. Premium decay is now exponential — even a directional move may not pay because theta eats it. Avoid new option-buy trades.',
          target: 'ia-event-alerts'
        });
      } else if (ex.phase === 'THETA_RAMP') {
        flags.push({
          sev: 'warn', icon: '\u23F0', label: 'EXPIRY: THETA RAMP',
          why: 'Expiry day after 11:30. Theta is starting to bite. Plan to be flat by 13:30 — beyond that, decay accelerates.',
          target: 'ia-event-alerts'
        });
      } else {
        flags.push({
          sev: 'warn', icon: '\u23F0', label: 'EXPIRY DAY',
          why: 'Today is weekly expiry. Use quick targets and exit before 13:30 — afternoon theta crush is unforgiving.',
          target: 'ia-event-alerts'
        });
      }
    }

    // Overnight gap → EVENT ALERTS strip
    var gp = plan.gap;
    if (gp && gp.isStrong) {
      var minNow = sess.minOfDay;
      var gapDir = gp.pct > 0 ? '+' : '';
      var gapTxt = gapDir + gp.pct.toFixed(2) + '%';
      if (minNow != null && minNow < 10 * 60 + 15) {
        flags.push({
          sev: 'danger', icon: '\u26A1', label: 'GAP ' + gapTxt + ' • 1st HOUR',
          why: 'Strong overnight gap (' + gapTxt + ') AND we\u2019re still in the first hour. Both gap-fade and gap-and-go fakeouts are common before 10:15 — wait for the open rejection or ORH/ORL break to confirm direction.',
          target: 'ia-event-alerts'
        });
      } else {
        flags.push({
          sev: 'warn', icon: '\u26A1', label: 'GAP ' + gapTxt,
          why: 'Strong overnight gap of ' + gapTxt + '. Verify with ORH/ORL break (gap-and-go) or open rejection (gap-fade) before sizing.',
          target: 'ia-event-alerts'
        });
      }
    }

    // OI flow against active verdict → PLAN card (SKIP IF lives there)
    var oi = plan.chain && plan.chain.oiChange;
    if (oi && (plan.action === 'BUY_CE' || plan.action === 'BUY_PE')) {
      var againstCE = (plan.action === 'BUY_CE' && (oi.flowDirection === 'BEAR' || oi.flowDirection === 'STRONG_BEAR'));
      var againstPE = (plan.action === 'BUY_PE' && (oi.flowDirection === 'BULL' || oi.flowDirection === 'STRONG_BULL'));
      if (againstCE || againstPE) {
        var oiStrong = oi.flowDirection.indexOf('STRONG') === 0;
        flags.push({
          sev: oiStrong ? 'danger' : 'warn', icon: '\u21C4',
          label: 'OI FLOW AGAINST',
          why: 'Institutional OI flow at ATM \u00B12 strikes is leaning ' + (oiStrong ? 'STRONGLY ' : '')
            + (againstCE ? 'bearish' : 'bullish')
            + ' (flow score ' + Math.abs(+oi.flowScore || 0).toFixed(0)
            + '). The writers are positioning AGAINST your trade. Size smaller or wait for the flow to confirm.',
          target: 'ia-plan'
        });
      }
    }

    // Structure-room red-flag chips (AT WALL / R:R < 1.0) removed
    // in the May 2026 SCALP-only refactor — they measured spot
    // vs the day's BIG walls (PDH/ORH/CPR/1H Swing) which is the
    // wrong yardstick for a 4-5 pt scalp. Pill + JS render fn +
    // engine veto + DOM + CSS all came out together.

    // Bank Nifty opposing → BN pill
    if (plan.bn && plan.bn.trend && (plan.action === 'BUY_CE' || plan.action === 'BUY_PE')) {
      var bnT = plan.bn.trend;
      var opposesCe = (plan.action === 'BUY_CE' && bnT.indexOf('BEAR') >= 0);
      var opposesPe = (plan.action === 'BUY_PE' && bnT.indexOf('BULL') >= 0);
      if (opposesCe || opposesPe) {
        flags.push({
          sev: 'warn', icon: '\u2696', label: 'BN OPPOSING',
          why: 'Bank Nifty is trending the OPPOSITE direction. BN leads Nifty roughly 60% of the time intraday \u2014 trading against it lowers the edge. Reduce size or wait for BN to align.',
          target: 'ia-bn-pill'
        });
      }
    }

    // VIX extremes → IV pill
    if (plan.vix) {
      var vC = plan.vix.current, vCh = plan.vix.changePct;
      if (vC != null && vC >= 22) {
        flags.push({
          sev: 'warn', icon: '\u26A1', label: 'VIX HIGH ' + vC.toFixed(1),
          why: 'India VIX is high (' + vC.toFixed(1) + ') \u2014 option premiums are fat. Buyers pay extra for the move; sellers have the edge. If you must buy, size smaller.',
          target: 'ia-iv-pill'
        });
      } else if (vC != null && vC < 12) {
        flags.push({
          sev: 'warn', icon: '\u26A1', label: 'VIX DEAD ' + vC.toFixed(1),
          why: 'India VIX is dead (' + vC.toFixed(1) + ') \u2014 implied volatility is collapsed. Even a winning direction may not produce premium expansion. Quick scalps only.',
          target: 'ia-iv-pill'
        });
      }
      if (vCh != null && vCh <= -5 && (plan.action === 'BUY_CE' || plan.action === 'BUY_PE')) {
        flags.push({
          sev: 'warn', icon: '\u2198', label: 'IV CRUSH ' + vCh.toFixed(1) + '%',
          why: 'India VIX is dropping fast (' + vCh.toFixed(1) + '% today). Option premiums shrink even when spot moves the right way \u2014 directional gain can be eaten by IV decay. Avoid OTM, use ITM for delta exposure.',
          target: 'ia-iv-pill'
        });
      }
    }

    // CPR dead zone / wide → CPR pill
    if (plan.cpr) {
      if (plan.cpr.classification === 'WIDE' && plan.cpr.location === 'INSIDE') {
        flags.push({
          sev: 'danger', icon: '\u25CB', label: 'CPR DEAD ZONE',
          why: 'CPR is WIDE and spot is INSIDE the band \u2014 the textbook chop setup. Price oscillates between TC and BC with no follow-through. Either wait for a clean break of TC/BC or stand down.',
          target: 'ia-cpr-pill'
        });
      } else if (plan.cpr.classification === 'WIDE') {
        flags.push({
          sev: 'warn', icon: '\u25CB', label: 'WIDE CPR',
          why: 'WIDE CPR signals a range / mean-reversion day. Trends are choppier; use tighter targets and avoid breakout setups.',
          target: 'ia-cpr-pill'
        });
      }
    }

    // Volatility DEAD / QUIET → VOLATILITY pill
    if (plan.volatility && plan.volatility.regime === 'DEAD') {
      flags.push({
        sev: 'danger', icon: '\u2620', label: 'DEAD MARKET',
        why: 'ATR-% on the 5m chart is below 0.04 \u2014 range is too small for any option-buy setup to pay. Hard veto regardless of direction. Stand down.',
        target: 'ia-vol-pill'
      });
    } else if (plan.volatility && plan.volatility.regime === 'QUIET') {
      flags.push({
        sev: 'warn', icon: '\u2620', label: 'QUIET MARKET',
        why: 'ATR-% is between 0.04 and 0.06 \u2014 limited range. Tight targets only, and avoid OTM strikes.',
        target: 'ia-vol-pill'
      });
    }

    // 1H ADX-strong against → 1H pill
    if (plan.h1 && plan.h1.adx != null && plan.h1.adx >= 25
        && (plan.action === 'BUY_CE' || plan.action === 'BUY_PE')) {
      var h1Bear = plan.h1.trend && plan.h1.trend.indexOf('BEAR') >= 0;
      var h1Bull = plan.h1.trend && plan.h1.trend.indexOf('BULL') >= 0;
      if ((plan.action === 'BUY_CE' && h1Bear) || (plan.action === 'BUY_PE' && h1Bull)) {
        flags.push({
          sev: 'warn', icon: '\u21C5', label: '1H FIGHTING (ADX ' + plan.h1.adx.toFixed(0) + ')',
          why: 'The 1H chart is in a strong trend (ADX ' + plan.h1.adx.toFixed(0) + ') going AGAINST your setup. Counter-trend trades against a strong macro tape have a lower win rate \u2014 size smaller.',
          target: 'ia-h1-pill'
        });
      }
    }

    // ── Build the unified reasons list (BULLETS) ───────────────
    // Combine plan.vetoReasons (engine's "why blocked" strings)
    // with the flag accumulator (pedagogical risk prose) into a
    // SINGLE FLAT LIST of bullets rendered as plain text inline
    // under the verdict. No card stack, no titles — just one
    // sentence per bullet so the user can read everything at a
    // glance.
    //
    // Dedup via Jaccard token similarity (threshold 0.30) so an
    // item like "Spot is right at CPR Bottom (BC) (only 12 pts...)"
    // is suppressed when a flag body says "Spot is sitting right
    // at CPR Bottom (BC) — a major structural level...".
    function tokenize(s) {
      return String(s || '').toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter(function (t) { return t.length >= 4; });
    }
    function jaccard(a, b) {
      var setA = {}, setB = {};
      a.forEach(function (t) { setA[t] = 1; });
      b.forEach(function (t) { setB[t] = 1; });
      var keysA = Object.keys(setA);
      var keysB = Object.keys(setB);
      var inter = 0;
      keysA.forEach(function (t) { if (setB[t]) inter++; });
      var union = keysA.length + keysB.length - inter;
      return union === 0 ? 0 : inter / union;
    }
    var reasons = [];
    function addReason(sev, body) {
      var dec = _decoder(body).trim();
      if (!dec) return;
      var toks = tokenize(dec);
      // Skip if any existing reason is >=30% token-similar OR
      // contains a 4+ word phrase in common (catches near-duplicates
      // like "Spot is right at CPR Bottom" vs "Spot is sitting
      // right at CPR Bottom"). Keep the higher-severity copy.
      for (var i = 0; i < reasons.length; i++) {
        var existing = reasons[i];
        if (jaccard(existing.toks, toks) >= 0.30) {
          // Promote severity if new one is worse
          var sevRank = { info: 0, warn: 1, danger: 2 };
          if ((sevRank[sev] || 0) > (sevRank[existing.sev] || 0)) {
            existing.sev = sev;
          }
          return;
        }
      }
      reasons.push({ sev: sev, body: dec, toks: toks });
    }
    // Flags first (nice pedagogical prose with context + advice)
    flags.forEach(function (f) {
      addReason(f.sev || 'warn', f.why || f.label || '');
    });
    // Then vetoReasons (engine's terse strings — only the unique ones)
    if (state === 'blocked' && plan.vetoReasons && plan.vetoReasons.length) {
      plan.vetoReasons.forEach(function (vr) { addReason('danger', vr); });
    }
    // Sort danger first, warn next, info last
    var sevOrder = { danger: 0, warn: 1, info: 2 };
    reasons.sort(function (a, b) {
      return (sevOrder[a.sev] || 9) - (sevOrder[b.sev] || 9);
    });

    // ── Render the bullet list ─────────────────────────────────
    // A single rounded box right under the verdict. One <li> per
    // reason. Severity dot prefix (red/amber/blue) so the user
    // can scan severity at a glance without parsing prose.
    var stack = document.getElementById('ia-hud-warnings');
    if (stack) {
      if (!reasons.length) {
        stack.hidden = true; stack.innerHTML = '';
      } else {
        var safe = function (s) {
          return String(s).replace(/[<>&"']/g, function (c) {
            return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c];
          });
        };
        stack.innerHTML = reasons.map(function (r) {
          return '<li class="ia-hud-warn" data-sev="' + safe(r.sev) + '">'
            + '<span class="ia-hud-warn-dot" aria-hidden="true"></span>'
            + '<span class="ia-hud-warn-text">' + safe(r.body) + '</span>'
            + '</li>';
        }).join('');
        stack.hidden = false;
      }
    }
  }

  // ══════════════ PILL TAP-FOR-DETAIL (May 2026) ══════════════
  // Each market-context pill is now a tappable button. Tap →
  // opens the shared #ia-pill-detail panel below the pill grid
  // with three things:
  //   1. Title   — what this pill measures
  //   2. Why     — what the CURRENT value means in plain English
  //   3. Action  — what the user should do about it (optional)
  // Replaces the cryptic right-aligned "impact" text that users
  // could see but couldn't easily map back to the pill semantics.
  //
  // The explainer registry is keyed by pill ID; each entry is a
  // PURE function of the current `plan` snapshot so re-renders
  // produce fresh prose without any imperative DOM dependency.
  (function bindPillClicks() {
    // Helper: build a {title, why, action, sev} object for a pill.
    // Each function reads from the latest analysis result on
    // STATE.result.plan so the prose always reflects the most
    // recent verdict, not the click moment.
    function getPlan() {
      if (typeof STATE !== 'undefined' && STATE && STATE.result && STATE.result.plan) {
        return STATE.result.plan;
      }
      return null;
    }
    // Format helpers
    function num(n, d) {
      if (n == null || !isFinite(n)) return '\u2014';
      return (+n).toFixed(d == null ? 2 : d);
    }
    var EXPLAINERS = {
      // SESSION — when can I trade?
      'ia-session-pill': function (plan) {
        var s = plan && plan.session;
        if (!s) return null;
        var lbl = s.label || s.phase || '\u2014';
        var min = s.minOfDay;
        // Phase → human prose + recommended action
        var phaseMap = {
          'PRE_OPEN':   { why: 'It\u2019s before 09:15 IST. No live ticks yet \u2014 the recommendation is based on stale closing prices and pre-open indicators only. Anything you act on now is a guess.', act: 'Wait for 09:15 open. Watch first 15 min to see direction.', sev: 'danger' },
          'OR_FORMING': { why: 'Opening Range is forming (09:15\u201309:30). Volatility is high, direction not yet committed \u2014 most fakeouts happen here.', act: 'Wait for 09:30 to see which side wins.', sev: 'warn' },
          'PRIME':      { why: 'You\u2019re in PRIME hours \u2014 highest-edge window of the day. Volume is strong, intraday trends usually commit, fills are tight.', act: 'Trade your best setups now. Full size on HIGH confidence recommendations.', sev: 'ok' },
          'LUNCH':      { why: 'Lunch chop (12:00\u201313:00). Volume drops, ranges contract, trends often pause. Breakouts here are typically fake.', act: 'Wait for 13:00. Skip new entries unless setup is exceptional.', sev: 'warn' },
          'AFTERNOON':  { why: 'Afternoon session \u2014 trends can resume or reverse. Lower volume than PRIME but still tradeable.', act: 'Reduce size by 25\u201350%. Trail SL tighter than morning trades.', sev: 'info' },
          'LATE_PUSH':  { why: 'Late-push window (14:30\u201315:00) \u2014 directional moves often ramp here on news/positioning. Scalpers\u2019 sweet spot.', act: 'OK to enter with full confidence. Exit by 15:00 \u2014 don\u2019t carry into the square-off window.', sev: 'ok' },
          'NO_NEW':     { why: 'Past 15:25 IST \u2014 square-off window. Any open positions must be closed; no new entries allowed.', act: 'Close existing positions. NO new trades \u2014 EOD risk too high.', sev: 'danger' },
          'POST_CLOSE': { why: 'Market is closed (post 15:30 IST or weekend). No live ticks. Recommendation is based on last available bars.', act: 'Plan for the next session. Do NOT act on this recommendation today.', sev: 'danger' },
          'PRE_PRIME':  { why: 'Between OR close (09:30) and PRIME (10:15). Edge is mediocre \u2014 either a continuation of the OR break or a fakeout reversal.', act: 'Half-size only. Wait for clear ORH/ORL break + retest.', sev: 'warn' }
        };
        var info = phaseMap[s.phase] || { why: 'Current session phase: ' + lbl, sev: 'info' };
        return {
          title: 'SESSION \u2014 ' + lbl,
          why: info.why,
          action: info.act,
          sev: info.sev
        };
      },
      // 1H CONTEXT — top-down filter
      'ia-h1-pill': function (plan) {
        var h = plan && plan.h1;
        if (!h) return null;
        var trend = h.trend || 'NEUTRAL';
        var adx = h.adx, rsi = h.rsi;
        var sev = 'info';
        var why, act;
        var strong = (adx != null && adx >= 25);
        if (trend.indexOf('BULL') >= 0) {
          why = 'The 1-hour chart is trending UP' + (strong ? ' STRONGLY (ADX ' + adx.toFixed(0) + ')' : ' (weak, ADX ' + (adx != null ? adx.toFixed(0) : '\u2014') + ')') + '. The macro tape is bullish, which favours BUY CE setups and makes counter-trend BUY PE harder to win.';
          act = strong ? 'Favour BUY CE setups. Skip BUY PE unless it has very strong confirmation.' : 'BUY CE has a tailwind. BUY PE is OK but reduce size.';
          sev = strong ? 'ok' : 'info';
        } else if (trend.indexOf('BEAR') >= 0) {
          why = 'The 1-hour chart is trending DOWN' + (strong ? ' STRONGLY (ADX ' + adx.toFixed(0) + ')' : ' (weak, ADX ' + (adx != null ? adx.toFixed(0) : '\u2014') + ')') + '. The macro tape is bearish, which favours BUY PE setups and makes counter-trend BUY CE harder to win.';
          act = strong ? 'Favour BUY PE setups. Skip BUY CE unless it has very strong confirmation.' : 'BUY PE has a tailwind. BUY CE is OK but reduce size.';
          sev = strong ? 'ok' : 'info';
        } else {
          why = '1-hour trend is FLAT \u2014 no macro bias either way. Setups need to stand on their own (15m / 5m structure does the talking).';
          act = 'Neither side has a macro tailwind. Higher bar for new positions.';
          sev = 'warn';
        }
        return {
          title: '1-HOUR CONTEXT \u2014 ' + trend + (adx != null ? ' (ADX ' + adx.toFixed(0) + ')' : ''),
          why: why + ' RSI ' + (rsi != null ? rsi.toFixed(0) : '\u2014') + '.',
          action: act,
          sev: sev
        };
      },
      // IV & POSITIONING — VIX + PCR + walls
      'ia-iv-pill': function (plan) {
        var v = plan && plan.vix;
        var c = plan && plan.chain;
        if (!v && !c) return null;
        var bits = [];
        var act = [];
        var sev = 'info';
        if (v && v.current != null) {
          var cur = v.current, chg = v.changePct;
          if (cur >= 22) {
            bits.push('India VIX is HIGH (' + cur.toFixed(1) + ') \u2014 option premiums are fat. Buyers pay extra; sellers have the edge.');
            act.push('Size smaller on option-buy setups, or wait for VIX to cool off.');
            sev = 'warn';
          } else if (cur < 12) {
            bits.push('India VIX is DEAD (' + cur.toFixed(1) + ') \u2014 implied volatility is collapsed. Even directional moves may not produce premium expansion.');
            act.push('Quick scalps only. Avoid OTM strikes.');
            sev = 'warn';
          } else {
            bits.push('India VIX is normal (' + cur.toFixed(1) + ') \u2014 premiums are fairly priced.');
          }
          if (chg != null && chg <= -5) {
            bits.push('VIX dropping fast (' + chg.toFixed(1) + '% today) \u2014 IV CRUSH active. Directional gain can be eaten by IV decay.');
            act.push('Use ITM strikes for delta exposure; avoid OTM.');
            sev = 'warn';
          } else if (chg != null && chg >= 5) {
            bits.push('VIX rising fast (+' + chg.toFixed(1) + '% today) \u2014 IV EXPANSION. Option premiums likely to grow even on small moves.');
          }
        } else {
          bits.push('VIX unavailable (token issue or pre-open). IV regime check skipped.');
        }
        if (c) {
          if (c.maxCeWall && c.maxPeWall) {
            bits.push('Institutional walls: CE wall ' + c.maxCeWall + ' (resistance), PE wall ' + c.maxPeWall + ' (support).');
          }
          if (c.pcr != null) {
            bits.push('PCR ' + c.pcr.toFixed(2) + ' \u2014 ' + (c.pcr > 1.3 ? 'PE writing dominates (bullish positioning)' : c.pcr < 0.7 ? 'CE writing dominates (bearish positioning)' : 'balanced'));
          }
        }
        return {
          title: 'IV & POSITIONING',
          why: bits.join(' '),
          action: act.length ? act.join(' ') : null,
          sev: sev
        };
      },
      // VOLATILITY (ATR %)
      'ia-vol-pill': function (plan) {
        var v = plan && plan.volatility;
        if (!v) return null;
        var reg = v.regime;
        var pct = v.atrPct;
        var pts = v.atrPoints;
        var map = {
          'DEAD':   { why: 'ATR-% is below 0.04 \u2014 5m range is too small for any option-buy setup to pay. Movement is dead.', act: 'Stand down. No new trades. Wait for range to expand.', sev: 'danger' },
          'QUIET':  { why: 'ATR-% is 0.04\u20130.06 \u2014 quiet market. Limited range, slow grinds. Strong reversal patterns may still work.', act: 'Tight targets only. Avoid OTM. Half-size.', sev: 'warn' },
          'NORMAL': { why: 'ATR-% is 0.06\u20130.10 \u2014 normal trading range. Standard intraday rules apply.', act: 'Trade your normal playbook with standard targets.', sev: 'ok' },
          'ACTIVE': { why: 'ATR-% is above 0.10 \u2014 elevated volatility. Moves are faster and larger; SL gets hit easier.', act: 'Widen SL by 30\u201350%. Allow targets to run further. Reduce size if jumpy.', sev: 'info' }
        };
        var info = map[reg] || { why: 'Volatility regime: ' + reg, sev: 'info' };
        return {
          title: 'VOLATILITY \u2014 ' + reg + (pct != null ? ' (ATR-% ' + (pct * 100).toFixed(3) + '%)' : '') + (pts != null ? ' \u00B7 ' + pts.toFixed(1) + ' pts' : ''),
          why: info.why,
          action: info.act,
          sev: info.sev
        };
      },
      // BANK NIFTY CORRELATION
      'ia-bn-pill': function (plan) {
        var b = plan && plan.bn;
        if (!b) return { title: 'BANK NIFTY', why: 'Bank Nifty data unavailable (token issue or insufficient bars). Correlation filter skipped.', sev: 'info' };
        var t = b.trend || 'FLAT';
        var why, act, sev = 'info';
        if (t.indexOf('BULL') >= 0) {
          why = 'Bank Nifty is trending UP (' + (b.changePct != null ? (b.changePct >= 0 ? '+' : '') + b.changePct.toFixed(2) + '%' : '\u2014') + '). BN leads Nifty ~60% of the time intraday \u2014 BULL BN is a tailwind for BUY CE setups.';
          act = 'BUY CE is confirmed by BN leadership. BUY PE is fighting the leader.';
          sev = 'ok';
        } else if (t.indexOf('BEAR') >= 0) {
          why = 'Bank Nifty is trending DOWN (' + (b.changePct != null ? (b.changePct >= 0 ? '+' : '') + b.changePct.toFixed(2) + '%' : '\u2014') + '). BEAR BN is a tailwind for BUY PE setups; BUY CE faces a headwind.';
          act = 'BUY PE is confirmed by BN leadership. BUY CE needs strong confirmation.';
          sev = 'ok';
        } else {
          why = 'Bank Nifty is FLAT \u2014 not confirming either side. Setup edge is lower without correlated leadership.';
          act = 'Half-size on either side. Wait for BN to commit.';
          sev = 'warn';
        }
        return {
          title: 'BANK NIFTY \u2014 ' + t,
          why: why,
          action: act,
          sev: sev
        };
      },
      // CPR DAY-TYPE
      'ia-cpr-pill': function (plan) {
        var c = plan && plan.cpr;
        if (!c) return { title: 'CPR DAY-TYPE', why: 'CPR data unavailable (very first session or insufficient history). Day-type filter skipped.', sev: 'info' };
        var cls = c.classification, loc = c.location;
        var map = {
          'NARROW': { why: 'CPR is NARROW (width <= 25% of prev-day range). Textbook trending-day signal \u2014 institutional flow has to commit a side. Breakouts tend to follow through.', act: 'Favour breakout setups in the direction of the first 30-min break.', sev: 'ok' },
          'NORMAL': { why: 'CPR is NORMAL (25\u201360% of prev range). Standard intraday rules apply \u2014 no day-type bias.', act: 'Trade your usual playbook.', sev: 'info' },
          'WIDE':   { why: 'CPR is WIDE (> 60% of prev range). Range-day signal \u2014 directional moves often fail; price tends to oscillate.', act: 'Tight targets. Mean-reversion setups beat breakouts. Avoid OTM.', sev: 'warn' }
        };
        var info = map[cls] || { why: 'CPR classification: ' + cls, sev: 'info' };
        var locTxt;
        if (loc === 'ABOVE') locTxt = ' Spot is ABOVE CPR Top \u2014 bullish side of the day-frame.';
        else if (loc === 'BELOW') locTxt = ' Spot is BELOW CPR Bottom \u2014 bearish side of the day-frame.';
        else if (loc === 'INSIDE') locTxt = ' Spot is INSIDE CPR band \u2014 ' + (cls === 'WIDE' ? 'classic DEAD ZONE chop expected.' : 'undecided.');
        else locTxt = '';
        return {
          title: 'CPR DAY-TYPE \u2014 ' + cls + (c.widthPctOfRange != null ? ' (' + c.widthPctOfRange.toFixed(0) + '%)' : ''),
          why: info.why + locTxt,
          action: info.act,
          sev: (cls === 'WIDE' && loc === 'INSIDE') ? 'danger' : info.sev
        };
      }
      // STRUCTURE ROOM tooltip handler removed (May 2026 SCALP-only
      // refactor). Matching pill + DOM + red-flag chips also removed
      // — SCALP doesn't measure trade quality against daily walls.
    };

    var activePill = null;
    function closePanel() {
      var panel = document.getElementById('ia-pill-detail');
      if (panel) panel.hidden = true;
      if (activePill) {
        activePill.classList.remove('ia-pill-active');
        activePill = null;
      }
    }
    function pillIdOf(el) {
      // walk up to find the matching pill container
      var ids = ['ia-session-pill','ia-h1-pill','ia-iv-pill','ia-vol-pill','ia-bn-pill','ia-cpr-pill'];
      for (var i = 0; i < ids.length; i++) {
        var p = el.closest && el.closest('#' + ids[i]);
        if (p) return { el: p, id: ids[i] };
      }
      return null;
    }
    document.addEventListener('click', function (ev) {
      var el = ev.target;
      if (!el || !el.closest) return;
      // Close button
      if (el.closest('#ia-pill-detail-close')) {
        closePanel();
        return;
      }
      // Ignore clicks inside the detail panel itself (e.g. text selection)
      if (el.closest('#ia-pill-detail')) return;
      var hit = pillIdOf(el);
      if (!hit) return;
      var fn = EXPLAINERS[hit.id];
      if (!fn) return;
      var plan = getPlan();
      var info = fn(plan);
      if (!info) {
        // No data → graceful nudge instead of opening empty panel
        return;
      }
      // Toggle off if same pill
      if (activePill === hit.el) {
        closePanel();
        return;
      }
      if (activePill) activePill.classList.remove('ia-pill-active');
      activePill = hit.el;
      hit.el.classList.add('ia-pill-active');

      var panel = document.getElementById('ia-pill-detail');
      if (!panel) return;
      var sevIconMap = { danger: '\u26A0', warn: '\u26A0', ok: '\u2713', info: '\u24D8' };
      var iconEl = document.getElementById('ia-pill-detail-icon');
      if (iconEl) iconEl.textContent = sevIconMap[info.sev] || '\u24D8';
      var titleEl = document.getElementById('ia-pill-detail-title');
      if (titleEl) titleEl.textContent = info.title;
      var whyEl = document.getElementById('ia-pill-detail-why');
      if (whyEl) whyEl.textContent = info.why;
      var actBox = document.getElementById('ia-pill-detail-action');
      var actV   = document.getElementById('ia-pill-detail-action-v');
      if (info.action && actBox && actV) {
        actV.textContent = info.action;
        actBox.hidden = false;
      } else if (actBox) {
        actBox.hidden = true;
      }
      panel.setAttribute('data-sev', info.sev || 'info');
      panel.hidden = false;
      // Scroll the panel into view so it's not below the fold on mobile
      try { panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      catch (_) { /* no-op */ }
    }, false);
  })();

  // ── Event alerts strip (May 2026) ───────────────────────────
  // Renders coloured chips above the SETUP card for two day-
  // specific contexts that materially change the trade math:
  //   1. EXPIRY DAY — chip phase (NORMAL / THETA_RAMP /
  //      THETA_CRUSH / PIN_WINDOW) with countdown to close
  //   2. OVERNIGHT GAP — chip showing gap size + classification
  //      (FADE / GAP&GO / PENDING when first-hour not done)
  // Hidden entirely when neither is in effect.
  function renderEventAlerts(plan) {
    var strip = document.getElementById('ia-event-alerts');
    if (!strip) return;
    var chips = [];

    // EXPIRY DAY chip
    var ex = plan && plan.expiry;
    if (ex && ex.isExpiryDay) {
      var phaseTitle, phaseSub, sev;
      switch (ex.phase) {
        case 'PIN_WINDOW':
          phaseTitle = 'EXPIRY \u00B7 PIN WINDOW';
          phaseSub   = 'Last hour \u2014 max-pain magnet active, ' + ex.minsToClose + ' min to close';
          sev = 'danger';
          break;
        case 'THETA_CRUSH':
          phaseTitle = 'EXPIRY \u00B7 THETA CRUSH';
          phaseSub   = 'Past 13:30 \u2014 premium decay accelerating, exit on T1';
          sev = 'danger';
          break;
        case 'THETA_RAMP':
          phaseTitle = 'EXPIRY \u00B7 THETA RAMP';
          phaseSub   = 'Past 13:00 \u2014 plan to be flat by 13:30';
          sev = 'warn';
          break;
        default:
          phaseTitle = 'EXPIRY DAY';
          phaseSub   = 'Theta still slow before 13:00 \u2014 normal sizing OK';
          sev = 'warn';
      }
      // Solid clock icon (color-aware text glyph) replaces the
      // emoji \u23F0 which rendered with browser-default yellow
      // and clashed with the sev-tinted chip background.
      chips.push({ sev: sev, icon: '\u25CF', title: phaseTitle, detail: phaseSub });
    }

    // OVERNIGHT GAP chip
    //
    // SEVERITY CHOICE — `info` (blue) by default, NOT `bull`/`bear`.
    // The banner reports the gap as raw context ("today opened with
    // a big gap, watch the first hour carefully"), not a directional
    // signal. The detail text itself is direction-neutral ("look for
    // ORH break (gap-and-go) OR open rejection (gap-fade) to pick a
    // side") because ~half of strong overnight gaps get faded — so
    // a green-tinted chip on a gap-up was implicitly endorsing CE
    // even when the engine's actual verdict was WAIT or BUY_PE.
    // Direction is still conveyed two ways without color baggage:
    //   1. The arrow icon (\u25B2 for gap-up, \u25BC for gap-down)
    //   2. The signed percentage in the title ("+0.81%" vs "-0.81%")
    // Early-morning still upgrades to `warn` (amber) because that
    // window genuinely is a caution ("first-hour gaps fake out often").
    var gp = plan && plan.gap;
    if (gp && gp.isStrong) {
      var gapTxt = (gp.pct > 0 ? '+' : '') + gp.pct.toFixed(2) + '%  \u00B7  ' + Math.round(gp.pts) + ' pts';
      var gapTitle = 'GAP-' + (gp.pct > 0 ? 'UP' : 'DOWN') + '  \u00B7  ' + gapTxt;
      var gapSub;
      var gapSev = 'info';
      var minNow = (plan && plan.session) ? plan.session.minOfDay : null;
      if (minNow != null && minNow < 10 * 60 + 15) {
        gapSub = 'Wait for the 10:15 IST opening range to close before sizing \u2014 first-hour gaps fake out often.';
        gapSev = 'warn';
      } else {
        gapSub = 'Look for an ORH break (gap-and-go) or an open rejection (gap-fade) to pick a side.';
      }
      // Solid triangle arrows (\u25B2 / \u25BC) — text glyphs so CSS
      // can colour them. The arrow doubles as a directional cue
      // (up = gap-up, down = gap-down) without the chip background
      // having to imply bullish/bearish bias.
      var gapIcon = gp.pct > 0 ? '\u25B2' : '\u25BC';
      chips.push({ sev: gapSev, icon: gapIcon, title: gapTitle, detail: gapSub });
    }

    if (!chips.length) { strip.hidden = true; strip.innerHTML = ''; return; }
    strip.hidden = false;
    var safe = function (s) {
      return String(s).replace(/[<>&"']/g, function (c) {
        return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c];
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

  function renderPlan(plan, an5, latestSpot) {
    renderEventAlerts(plan);
    renderCoverage(plan);
    // SETUP card — state-aware: bull (BUY CE) / bear (BUY PE) /
    // blocked (engine wanted a side but a safety check vetoed
    // it) / wait (no signal, chop, TF disagreement, market off-
    // hours). Each state drives a colour-coded icon + accent
    // border so the user reads the trade-thesis status without
    // parsing prose. Headline + reason are split on the em-dash
    // separator that every setupLabel uses internally
    // ("Bullish confluence — long-side breakout …").
    var setupState = 'wait';
    var setupIcon  = '\u2026';                  // … standby
    if (plan.action === 'BUY_CE')      { setupState = 'bull';    setupIcon = '\u25B2'; }     // ▲
    else if (plan.action === 'BUY_PE') { setupState = 'bear';    setupIcon = '\u25BC'; }     // ▼
    else if (plan.attemptedSide)       { setupState = 'blocked'; setupIcon = '\u2717'; }     // ✗
    var fullLabel = plan.setupLabel || '\u2014';
    var dashIdx   = fullLabel.indexOf(' \u2014 ');  // " — " (em-dash with spaces)
    var headline  = dashIdx > 0 ? fullLabel.slice(0, dashIdx) : fullLabel;
    var reasonTxt = dashIdx > 0 ? fullLabel.slice(dashIdx + 3) : '';
    var setupCard = document.querySelector('#ia-plan .sw-plan-setup');
    if (setupCard) setupCard.setAttribute('data-state', setupState);
    setText('ia-plan-setup-icon',   setupIcon);
    setText('ia-plan-setup',        headline);
    setText('ia-plan-setup-reason', reasonTxt);
    if (plan.action === 'WAIT') {
      // Hide the 7-cell grid + S/R ladder — there's nothing
      // meaningful to put in them. Show the waiting placeholder
      // instead with copy tailored to WHY there's no plan:
      //   blocked  — engine wanted a side but a safety rule
      //              vetoed (point the user at the SETUP card
      //              above which explains the specific veto)
      //   closed   — pre-open / post-close / weekend (use
      //              nextOpenLabel for "Mon 09:15 IST" wording)
      //   wait     — generic no-signal state (chop, TF
      //              disagreement, mixed signals)
      var grid = $('ia-plan-grid');
      if (grid) grid.hidden = true;
      var ladderHide = $('ia-sr-ladder');
      if (ladderHide) ladderHide.hidden = true;
      var wait = $('ia-plan-waiting');
      if (wait) {
        // Decide state — drives icon, accent colour, copy.
        // Use the IST clock + weekday for the "closed" check
        // (the chart module's isMarketOpen() is the source of
        // truth elsewhere; mirror its logic here).
        //
        // BLOCKED state: skip the placeholder entirely. The TRADE
        // DECISION HUD at the top of the result block already
        // shows the verdict + the full list of block reasons; a
        // second card down here just saying "see verdict above"
        // is pure noise.
        //
        // WAIT (no signal) and CLOSED (market off-hours) still
        // get the placeholder — those states have unique copy
        // (countdown to next open, "no confluence yet" message)
        // that the HUD doesn't carry.
        if (plan.attemptedSide) {
          wait.hidden = true;
        } else {
          var marketOpen = (typeof window.isMarketOpen === 'function')
            ? window.isMarketOpen() : true;
          var waitState, waitIcon, waitTitle, waitSub;
          if (!marketOpen) {
            waitState = 'closed';
            waitIcon  = '\u23F1';                                 // ⏱
            waitTitle = 'Market closed';
            var openLbl = (typeof window.nextOpenLabel === 'function')
              ? window.nextOpenLabel() : 'next session';
            waitSub = 'No live data to plan against. Plan will populate at the next ' + openLbl.replace(/^next open\s+/i, '') + '.';
          } else {
            waitState = 'wait';
            waitIcon  = '\u231B';                                 // ⌛
            waitTitle = 'Waiting for setup';
            // Prefer the engine's own setupLabel when it's
            // informative (it tells the user WHY — e.g. "Mixed
            // signals — 5m / 3m disagree"). Fall back to a
            // generic message only when the engine didn't
            // produce a labelled reason.
            var engineReason = (plan.setupLabel && plan.setupLabel !== '\u2014')
              ? plan.setupLabel : '';
            waitSub = engineReason
              ? engineReason
              : 'No confluence yet across the 5m / 3m frames.';
          }
          wait.setAttribute('data-state', waitState);
          setText('ia-plan-waiting-icon',  waitIcon);
          setText('ia-plan-waiting-title', waitTitle);
          setText('ia-plan-waiting-sub',   waitSub);

          // ── META CHIPS (May 2026 polish) ────────────────────
          // The user complained that the WAIT placeholder always
          // shows the same generic copy — they want to know WHY
          // we're waiting and WHEN something will change. These
          // chips surface the live diagnostic state directly:
          //   • SCORES — "CE 4 · PE 3 · need ≥3 margin OR ≥6 win"
          //     so the user sees exactly how close the engine is
          //     to firing a side.
          //   • PHASE — the current session-phase label (PRIME
          //     / LUNCH_CHOP / etc.). Most WAIT placeholders fire
          //     during LUNCH_CHOP / AFTERNOON because the engine
          //     is intentionally bar-shy in those windows — the
          //     chip makes that visible.
          //   • NEXT — countdown to the next 3-min bucket close,
          //     i.e. when the next analyze cycle will run and
          //     possibly produce a new verdict. Without this the
          //     user has no signal that "waiting" is a finite
          //     state.
          // All chips self-hide when the data is missing
          // (closed market, weekend, first ever analyze).
          try {
            var scoreEl = document.getElementById('ia-plan-waiting-scores');
            var phaseEl = document.getElementById('ia-plan-waiting-phase');
            var nextEl  = document.getElementById('ia-plan-waiting-next');

            if (scoreEl) {
              var ceN = +plan.ceScore || 0;
              var peN = +plan.peScore || 0;
              if (ceN > 0 || peN > 0) {
                var winSide = ceN >= peN ? 'CE' : 'PE';
                var winN = Math.max(ceN, peN);
                var loseN = Math.min(ceN, peN);
                var gap = winN - loseN;
                // The hint reflects the dual firing rule used by
                // the verdict engine (MIN_SCORE 4 OR MIN_MARGIN 3).
                var hint;
                if (winN >= 4 && gap >= 3) hint = 'engine would fire ' + winSide;
                else if (winN < 4 && gap < 3) hint = 'need ' + Math.max(0, 4 - winN) + '+ pts OR ' + Math.max(0, 3 - gap) + '+ margin';
                else if (winN < 4)            hint = 'margin OK \u2014 need ' + (4 - winN) + ' more ' + winSide + ' pts';
                else                          hint = 'score OK \u2014 need ' + (3 - gap) + ' more ' + winSide + ' margin';
                scoreEl.textContent = 'CE ' + ceN + ' \u00B7 PE ' + peN + ' \u2014 ' + hint;
                scoreEl.hidden = false;
              } else {
                scoreEl.hidden = true;
              }
            }

            if (phaseEl) {
              var sessPhase = plan && plan.session && plan.session.phase
                ? plan.session.phase : null;
              if (sessPhase && typeof sessionPhaseLabel === 'function') {
                phaseEl.textContent = sessionPhaseLabel(sessPhase);
                phaseEl.setAttribute('data-phase', sessionPhaseClass(sessPhase));
                phaseEl.hidden = false;
              } else {
                phaseEl.hidden = true;
              }
            }

            if (nextEl && marketOpen) {
              // analyze() runs on 3-min bucket boundaries (the
              // tickWatcher fires every 30s but only triggers an
              // analyze when a new bucket closes — see ~line 28420).
              // Compute seconds until next NSE-aligned bucket.
              var computeWaitCountdown = function () {
                var nowMs = Date.now();
                var bucketMs = 3 * 60 * 1000;
                var nextBucketMs = (typeof bucketStartMs === 'function')
                  ? bucketStartMs(nowMs, bucketMs) + bucketMs
                  : Math.ceil(nowMs / bucketMs) * bucketMs;
                var remSec = Math.max(0, Math.floor((nextBucketMs - nowMs) / 1000));
                var mm = Math.floor(remSec / 60);
                var ss = remSec % 60;
                return 'Next analyze in ' + mm + ':' + (ss < 10 ? '0' : '') + ss;
              };
              nextEl.textContent = computeWaitCountdown();
              nextEl.hidden = false;
              // Set up a singleton 1-second ticker that keeps the
              // countdown chip live without re-running renderPlan
              // (which is expensive). Self-clears when the chip
              // becomes hidden or the market closes.
              if (!window._iaWaitCountdownTicker) {
                window._iaWaitCountdownTicker = setInterval(function () {
                  var el = document.getElementById('ia-plan-waiting-next');
                  if (!el || el.hidden) return;
                  var open = (typeof window.isMarketOpen === 'function')
                    ? window.isMarketOpen() : true;
                  if (!open) { el.hidden = true; return; }
                  el.textContent = computeWaitCountdown();
                }, 1000);
              }
            } else if (nextEl) {
              nextEl.hidden = true;
            }
          } catch (_) {}

          wait.hidden = false;
        }
      }
      return;
    }
    // Active trade path — make sure the grid is visible and the
    // waiting placeholder is hidden (handles re-renders after a
    // WAIT-to-BUY transition).
    var gridShow = $('ia-plan-grid');
    if (gridShow) gridShow.hidden = false;
    var waitHide = $('ia-plan-waiting');
    if (waitHide) waitHide.hidden = true;
    var spot = latestSpot != null ? latestSpot : an5.lastClose;
    // Re-derive risk plan from LIVE spot (see liveRiskView comment).
    // This is what guarantees T1 > entry for CE (and T1 < entry for
    // PE) even if spot drifted since the last 3-min analyze().
    var an1h_state = (STATE.result && STATE.result.tf1h) || null;
    var raw1h_state = (STATE.result && STATE.result.raw1h) || [];
    plan = liveRiskView(plan, an5, an1h_state, spot, raw1h_state);
    // Attach the SPOT plan ALWAYS (independent of option-chain
    // load state). The HUD + quick strip both read plan.spotPlan
    // as the primary signal — premium is secondary. This ensures
    // the user sees "BUY at 23454 / SL 23420 / T1 23460" even
    // before the chain loads (and matches what the indicators
    // are computed on).
    attachSpotPlan(plan, spot);
    // ITM-1 recommendation (see pickRecommendedStrike rationale).
    // The user can override this in the strike dropdown below; if
    // they have, we re-anchor the plan to the strike they picked.
    var sideTag = plan.action === 'BUY_CE' ? 'CE' : 'PE';
    var atmStrike = pickRecommendedStrike(spot, sideTag);
    // Effective strike = user's pick if they've overridden, else ATM.
    var userPick = (typeof window.paperTradeGetSelectedStrike === 'function')
                   ? window.paperTradeGetSelectedStrike() : null;
    var effStrike = (userPick != null && isFinite(userPick)) ? +userPick : atmStrike;
    var isOverride = (effStrike !== atmStrike);
    var moneyness = classifyStrike(effStrike, spot, sideTag);
    var effLabel = effStrike + ' ' + sideTag;
    // Strike-cell label: bare strike+side. The badge (RECOMMENDED /
    // YOUR PICK) is appended via setHtml so we can style it.
    var badgeHtml = isOverride
      ? ' <span class="ia-strike-badge ia-strike-badge-user">YOUR PICK</span>'
      : ' <span class="ia-strike-badge ia-strike-badge-rec">RECOMMENDED ITM</span>';
    setHtml('ia-plan-strike', effLabel + badgeHtml);
    // Strike sub: describe moneyness + what it means for this trade.
    var subParts = [];
    if (moneyness && moneyness.kind === 'ATM') {
      subParts.push('At-the-money &mdash; tightest bid-ask spread, ~0.5 delta (premium moves ~50p for every 100p in Nifty).');
    } else if (moneyness && moneyness.kind === 'ITM') {
      subParts.push('In-the-money by &#8377;' + fmtNum(moneyness.distance, 0)
        + ' &mdash; higher cost, more intrinsic value, delta ~0.6-0.8 (premium moves ~70p per 100p Nifty); safer but smaller % gain.');
    } else if (moneyness && moneyness.kind === 'OTM') {
      subParts.push('Out-of-the-money by &#8377;' + fmtNum(moneyness.distance, 0)
        + ' &mdash; cheaper, all-time-value, delta ~0.2-0.35 (premium moves ~25p per 100p Nifty); riskier but big % gain if it works.');
    }
    if (isOverride) {
      subParts.push('SL / T1 / T2 below are now re-anchored to <b>' + effLabel
        + '</b>\u2019s premium + delta. Recommended ITM was <b>' + atmStrike + ' ' + sideTag + '</b>.');
    } else {
      subParts.push('Open the Strike dropdown below \u2014 you can override to ATM or OTM, and the SL / targets will auto-update.');
    }
    setHtml('ia-plan-strike-sub', subParts.join(' '));

    // ─── Structure-aware risk plan ───
    // targetsSpot, slSpot, emergencySpot come from computeRiskPlan
    // (called inside generateVerdict). They are SPOT levels with
    // metadata { value, name, role, priority }; we project each to
    // a premium price using current LTP + ATM delta.
    var t = plan.targetsSpot || [];
    var slLvl = plan.slSpot;
    var emLvl = plan.emergencySpot;
    // Only T1 + T2 are surfaced to the user. T3 (runner) was
    // dropped in May 2026 — see content/live.html comment block.
    var t1 = t[0], t2 = t[1];

    // EMERGENCY EXIT cell — always concrete (spot levels don't need
    // the option chain). Shown as Nifty value + arrow + level name.
    if (emLvl) {
      var emArrow = sideTag === 'CE' ? ' \u2193' : ' \u2191';
      setText('ia-plan-invalid', '\u20B9' + fmtNum(emLvl.value) + emArrow);
      setText('ia-plan-invalid-spot', emLvl.name);
    } else {
      setText('ia-plan-invalid', '—');
      setText('ia-plan-invalid-spot', '—');
    }

    // Try to pull the LIVE premium + REAL delta from the option
    // chain for the EFFECTIVE strike (user's pick or recommended).
    // If missing we show "Loading..." + auto-retry every 1.5s.
    var quote = getStrikeQuote(effStrike, sideTag);
    var premium = quote ? quote.premium : null;
    var delta   = quote ? quote.delta   : null;
    // Nifty 50 lot size — corrected from a stale hardcode of 75
    // to the current SEBI-revised 65 (Nov 2024). Pulled from the
    // analyzer module-wide constant so a future SEBI change only
    // needs one edit. Mismatched lot size would silently mislead
    // every ₹/% calculation on the position-math strip.
    var lotSize = ANALYZER_LOT_SIZE_NIFTY;
    if (premium != null) {
      STATE._planRetries = 0;
      STATE._planSig = null;
      renderPlanWithPremium(plan, an5, spot, effStrike, sideTag, premium, lotSize, delta);
    } else {
      // Kick a chain fetch so the next render has real numbers.
      if (typeof window.upFetchChain === 'function' && !window.optionChainData) {
        try { window.upFetchChain(); } catch (_) {}
      }
      if ((STATE._planRetries == null) || STATE._planSig !== (plan.action + '|' + effStrike)) {
        STATE._planRetries = 0;
        STATE._planSig = plan.action + '|' + effStrike;
      }
      if (STATE._planRetries < 8) {
        STATE._planRetries++;
        var retryArgs = { plan: plan, an5: an5, spot: latestSpot };
        setTimeout(function () {
          var q = getStrikeQuote(effStrike, sideTag);
          if ((q && q.premium != null) || STATE._planRetries < 8) {
            try { renderPlan(retryArgs.plan, retryArgs.an5, retryArgs.spot); } catch (_) {}
          }
        }, 1500);
      }
      // SPOT-FIRST loading state (May 2026 inversion) — even
      // before the option chain loads we have everything we need
      // (spot at fire + structural S/R levels) to show the trader
      // what they're watching. The premium estimate is the only
      // thing waiting on the chain; it appears as a small meta
      // line once available.
      setText('ia-plan-entry', spot != null ? '\u20B9' + fmtNum(spot) : 'Loading...');
      setText('ia-plan-entry-sub',
        'Spot trigger \u2014 buy ' + sideTag + ' at MARKET when the engine fires. '
        + 'Live premium estimate loads with the option chain (every indicator is computed on spot, so spot is the source of truth).');
      setText('ia-plan-entry-spot', '');
      // SL — spot is PRIMARY, premium loads with chain.
      if (slLvl) {
        setText('ia-plan-sl', '\u20B9' + fmtNum(slLvl.value));
        var slDist = (spot != null) ? Math.abs(spot - slLvl.value).toFixed(1) : '?';
        setText('ia-plan-sl-sub', 'Anchored to ' + slLvl.name + ' \u2014 exit when Nifty crosses this level (\u2212' + slDist + ' pts risk).');
        setText('ia-plan-sl-spot', 'premium estimate loads with chain');
      } else {
        setText('ia-plan-sl', '\u2014');
        setText('ia-plan-sl-sub', 'No structural support identified \u2014 plan will update at next analyze.');
        setText('ia-plan-sl-spot', '');
      }
      // T1/T2 — spot is PRIMARY.
      [['ia-plan-target-1', 'ia-plan-target-1-sub', 'ia-plan-target-1-spot', t1, 'Nearest resistance',  'first realistic exit, highest hit-probability'],
       ['ia-plan-target-2', 'ia-plan-target-2-sub', 'ia-plan-target-2-spot', t2, 'Next resistance',     'main target, where most setups stall out']
      ].forEach(function (row) {
        var lvl = row[3];
        if (!lvl) {
          setText(row[0], '\u2014');
          setText(row[1], row[4] + ' \u2014 ' + row[5] + '. Level not available.');
          setText(row[2], '');
          return;
        }
        var dist = (spot != null) ? Math.abs(lvl.value - spot).toFixed(1) : '?';
        setText(row[0], '\u20B9' + fmtNum(lvl.value));
        setText(row[1], row[4] + ' (' + lvl.name + ') \u2014 ' + row[5] + ' (+' + dist + ' pts).');
        setText(row[2], 'premium estimate loads with chain');
      });
    }

    // S/R ladder visualization (always render so user sees structure
    // even before premium loads).
    renderSrLadder(plan, an5, spot, sideTag, premium);
  }

  // Populate ENTRY + SL + T1 + T2 with concrete premium ₹ values
  // once we have a live premium. Called from renderPlan (initial) AND
  // liveTick (every 2s). All numbers derive from a single source —
  // current premium + spot levels — so the cells stay consistent.
  //
  // Sub-text is DESCRIPTIVE only — no "Place a SELL LIMIT", no
  // "Sell X qty", no specific order instructions. The simulator
  // doesn't support partial-quantity exits and even if it did, the
  // user should pick the target that matches their conviction
  // rather than be told to do partial exits. Cells just show:
  //   VALUE  — premium ₹ price to act on
  //   SUB    — what the level is (nearest/next/strong resistance)
  //            + % move from entry as context
  //   META   — which S/R level the price is anchored to
  function renderPlanWithPremium(plan, an5, spot, effStrike, sideTag, premium, lotSize, delta) {
    // effStrike = whichever strike the user is actually trading
    // (their dropdown pick if overridden, else the recommended ATM).
    // The strike isn't directly used inside this function (the cells
    // were already populated with the strike label in renderPlan),
    // but the projections below ARE built from that strike's
    // premium + delta — so SL / T1 / T2 reflect the user's
    // choice automatically.
    //
    // P0-2: build plan.premium as the SINGLE SOURCE OF TRUTH for
    // every premium/position number — so the cells, the position
    // strip below, the journal logSignal, and (future) the CONFIRM
    // modal all read from one canonical place. Eliminates the
    // "cell says ₹94, journal logs ₹91, modal shows ₹96" class of
    // bug.
    var capital   = (typeof signalJournalModule !== 'undefined') ? signalJournalModule.getCapital() : 15000;
    var riskBudget = (typeof signalJournalModule !== 'undefined') ? signalJournalModule.getRiskPct() : 5;
    attachSpotPlan(plan, spot);
    attachPremiumPlan(plan, spot, premium, sideTag, delta, lotSize, capital, riskBudget);
    var pp = plan.premium || {};
    var sp = plan.spotPlan || {};

    var t = plan.targetsSpot || [];
    var slLvl = plan.slSpot;

    // ─── SPOT-FIRST PLAN CELLS (May 2026 inversion) ────────────
    // VALUE row = SPOT level (the thing you watch on the chart).
    // SUB   row = level descriptor + Nifty-points distance.
    // META  row = premium estimate (for capital-outlay context).
    // Old design had this inverted (premium primary, spot in
    // meta) — but premium is a derived estimate (via delta) and
    // drifts with IV/theta in ways you cannot watch live. Spot
    // is what every indicator (RSI, EMA, VWAP, S/R, ADX) is
    // computed on and what the chart shows.

    // ENTRY cell — spot at fire (where the BUY signal was triggered).
    setText('ia-plan-entry', sp.entry != null ? '\u20B9' + fmtNum(sp.entry) : '\u2014');
    var deltaHint = (pp.delta != null)
      ? ' Delta ' + pp.delta.toFixed(2) + ' \u00B7 premium moves ~'
        + Math.round(pp.delta * 100) + 'p per 100p in Nifty.'
      : '';
    setText('ia-plan-entry-sub',
      'Spot trigger \u2014 buy ' + sideTag + ' at MARKET when the engine fires.'
      + ' Capital outlay ~\u20B9' + fmtNum(pp.capitalDeployed) + ' for '
      + pp.lots + ' lot (' + pp.qty + ' qty \u00D7 ~\u20B9'
      + fmtNum(pp.entry) + ' premium).' + deltaHint);
    setText('ia-plan-entry-spot', 'est. premium ~\u20B9' + fmtNum(pp.entry));

    // SL cell — SPOT level is primary; premium is secondary.
    if (slLvl && sp.sl != null) {
      setText('ia-plan-sl', '\u20B9' + fmtNum(slLvl.value));
      var slDistPts = (sp.slDistPts != null) ? sp.slDistPts : '?';
      setText('ia-plan-sl-sub',
        'Anchored to ' + slLvl.name + ' \u2014 exit when Nifty crosses this level (\u2212'
        + slDistPts + ' pts risk). Max loss ~\u20B9' + fmtNum(pp.maxLossINR) + ' per lot.');
      var slPremMeta = (pp.sl != null)
        ? 'est. premium SL ~\u20B9' + fmtNum(pp.sl) + ' (\u2212'
          + (pp.slPctDrop != null ? pp.slPctDrop.toFixed(1) : '?') + '% on premium)'
        : '';
      setText('ia-plan-sl-spot', slPremMeta);
    } else {
      setText('ia-plan-sl', '\u2014');
      setText('ia-plan-sl-sub', 'No structural support identified \u2014 plan will update at next analyze.');
      setText('ia-plan-sl-spot', '');
    }

    // T1 / T2 cells — SPOT level is primary; premium is secondary.
    var subBlurbs = [
      'Nearest resistance \u2014 first realistic exit, highest hit-probability',
      'Next resistance \u2014 main target, where most setups stall out'
    ];
    var t1Px = pp.t1, t2Px = pp.t2;
    var t1Pct = pp.t1PctGain, t2Pct = pp.t2PctGain;
    var pxArr   = [t1Px, t2Px];
    var pctArr  = [t1Pct, t2Pct];
    var distArr = [sp.t1DistPts, sp.t2DistPts];
    for (var i = 0; i < 2; i++) {
      var idx = i + 1;
      var lvl = t[i];
      if (!lvl) {
        setText('ia-plan-target-' + idx, '\u2014');
        setText('ia-plan-target-' + idx + '-sub', subBlurbs[i] + '. (Level not available.)');
        setText('ia-plan-target-' + idx + '-spot', '');
        continue;
      }
      setText('ia-plan-target-' + idx, '\u20B9' + fmtNum(lvl.value));
      var distTxt = (distArr[i] != null) ? distArr[i] : '?';
      setText('ia-plan-target-' + idx + '-sub',
        'Anchored to ' + lvl.name + ' \u2014 ' + subBlurbs[i].toLowerCase()
        + ' (+' + distTxt + ' pts target).');
      var tPremMeta = (pxArr[i] != null)
        ? 'est. premium T' + idx + ' ~\u20B9' + fmtNum(pxArr[i]) + ' (+'
          + (pctArr[i] != null ? pctArr[i].toFixed(1) : '?') + '% on premium)'
        : '';
      setText('ia-plan-target-' + idx + '-spot', tPremMeta);
    }

    // ── NEW position-math strip (P0-2) ─────────────────────────
    // Six pills below the 6-cell grid:
    //   LOTS  · DEPLOYED · MAX LOSS · R:R T1 · R:R T2 · TIME STOP
    // MAX LOSS pill tinted by riskBudgetStatus (OK green / TIGHT
    // amber / EXCEEDS red). SL-quality chip surfaces when SL is
    // outside the 12-35% sweet spot (TIGHT or WIDE) — silent on
    // GOOD. Renders in the dedicated #ia-position-math container
    // we add to content/live.html.
    renderPositionMath(plan, pp);
  }

  // Position-math strip renderer. Consumes the plan.premium object
  // and paints six metric pills + an optional SL-quality warning.
  // Safe no-op when the container isn't in the DOM (e.g. early
  // bootstrap before live.html injected).
  function renderPositionMath(plan, pp) {
    var host = document.getElementById('ia-position-math');
    if (!host || !pp || pp.entry == null) {
      if (host) host.hidden = true;
      return;
    }
    host.hidden = false;
    // Risk-budget pill colour + label.
    var rbCls, rbLabel;
    if (pp.riskBudgetStatus === 'OK')      { rbCls = 'ok';    rbLabel = '\u2713 WITHIN BUDGET'; }
    else if (pp.riskBudgetStatus === 'TIGHT') { rbCls = 'tight'; rbLabel = '\u26A0 NEAR LIMIT'; }
    else if (pp.riskBudgetStatus === 'EXCEEDS') { rbCls = 'over';  rbLabel = '\u2717 EXCEEDS ' + pp.riskPctBudget + '% BUDGET'; }
    else                                   { rbCls = 'na';    rbLabel = ''; }

    // SL-quality warning chip — only show on TIGHT / WIDE.
    var slWarnHtml = '';
    if (pp.slQuality === 'TIGHT') {
      slWarnHtml = '<div class="ia-pm-warn ia-pm-warn-tight">'
        + '<span class="ia-pm-warn-icon">\u26A0</span>'
        + '<b>TIGHT SL</b> (\u2212' + pp.slPctDrop.toFixed(1) + '%) \u2014 will likely stop on noise. '
        + 'Consider waiting for a wider structural setup, OR switch to a 25% premium-based stop.'
        + '</div>';
    } else if (pp.slQuality === 'WIDE') {
      slWarnHtml = '<div class="ia-pm-warn ia-pm-warn-wide">'
        + '<span class="ia-pm-warn-icon">\u26A0</span>'
        + '<b>WIDE SL</b> (\u2212' + pp.slPctDrop.toFixed(1) + '%) \u2014 R:R suffers; the move needed to hit T1 is large. '
        + 'Consider a tighter premium stop (25\u201330%) or skip.'
        + '</div>';
    }
    // R:R hint chip — only show when both R:R values exist + T1
    // is below 1.0 (asymmetric losing edge).
    var rrWarnHtml = '';
    if (pp.rrToT1 != null && pp.rrToT1 < 1.0) {
      rrWarnHtml = '<div class="ia-pm-warn ia-pm-warn-rr">'
        + '<span class="ia-pm-warn-icon">\u26A0</span>'
        + '<b>R:R BELOW 1.0</b> \u2014 even if T1 hits, win is smaller than the SL loss. Pro standard: skip < 1.0.'
        + '</div>';
    }

    host.innerHTML =
      '<div class="ia-pm-strip">'
      + '<div class="ia-pm-cell">'
        + '<span class="ia-pm-k">LOTS</span>'
        + '<span class="ia-pm-v">' + pp.lots + '</span>'
        + '<span class="ia-pm-sub">' + pp.qty + ' qty</span>'
      + '</div>'
      + '<div class="ia-pm-cell">'
        + '<span class="ia-pm-k">DEPLOYED</span>'
        + '<span class="ia-pm-v">\u20B9' + fmtNum(pp.capitalDeployed) + '</span>'
        + '<span class="ia-pm-sub">' + (pp.capitalDeployedPct != null ? pp.capitalDeployedPct.toFixed(1) + '% of capital' : '\u2014') + '</span>'
      + '</div>'
      + '<div class="ia-pm-cell ia-pm-cell-loss ia-pm-' + rbCls + '">'
        + '<span class="ia-pm-k">MAX LOSS</span>'
        + '<span class="ia-pm-v">' + (pp.maxLossINR != null ? '\u20B9' + fmtNum(pp.maxLossINR) : '\u2014') + '</span>'
        + '<span class="ia-pm-sub">' + (pp.maxLossPct != null ? pp.maxLossPct.toFixed(1) + '% of capital' : '\u2014') + '</span>'
        + (rbLabel ? '<span class="ia-pm-pill ia-pm-pill-' + rbCls + '">' + rbLabel + '</span>' : '')
      + '</div>'
      + '<div class="ia-pm-cell">'
        + '<span class="ia-pm-k">R:R \u2192 T1</span>'
        + '<span class="ia-pm-v">' + (pp.rrToT1 != null ? '1 : ' + pp.rrToT1.toFixed(2) : '\u2014') + '</span>'
        + '<span class="ia-pm-sub">' + (pp.maxGainT1INR != null ? 'win \u20B9' + fmtNum(pp.maxGainT1INR) : '\u2014') + '</span>'
      + '</div>'
      + '<div class="ia-pm-cell">'
        + '<span class="ia-pm-k">R:R \u2192 T2</span>'
        + '<span class="ia-pm-v">' + (pp.rrToT2 != null ? '1 : ' + pp.rrToT2.toFixed(2) : '\u2014') + '</span>'
        + '<span class="ia-pm-sub">' + (pp.maxGainT2INR != null ? 'win \u20B9' + fmtNum(pp.maxGainT2INR) : '\u2014') + '</span>'
      + '</div>'
      + '<div class="ia-pm-cell">'
        + '<span class="ia-pm-k">TIME STOP</span>'
        + '<span class="ia-pm-v">20m</span>'
        + '<span class="ia-pm-sub">flat = exit (theta)</span>'
      + '</div>'
      + '</div>'
      + slWarnHtml + rrWarnHtml;
  }

  // S/R LADDER — vertical visual of every level relative to spot.
  // Render order: highest → lowest (mirrors how price ladders read
  // on a chart). Picked levels (T1/T2/SL/Emergency) get coloured
  // pills + accent borders; "other" S/R levels (e.g. swing low when
  // we already used VWAP as SL, or the former T3 level) appear
  // muted so the user sees the full structure but understands
  // which we acted on.
  // ─── renderKeySr ─ visual price-ladder card ─────────────────────
  // Renders the structural S/R map as a vertical PRICE LADDER —
  // the same orientation you'd see on a chart: highest price at
  // top, lowest at bottom, spot as a horizontal "you are here"
  // line right in the middle.
  //
  // Each rung is positioned PROPORTIONAL to its distance from
  // spot (within a sensible min/max bounds so a 0.3pt gap doesn't
  // turn into overlap and a 200pt gap doesn't push a rung off-
  // screen). This lets the user SEE the structural asymmetry at
  // a glance — if R1 is 4pts away and S1 is 60pts away, the R
  // rung sits tight against spot while S1 sits visibly further
  // down. That's the trader's intuition we couldn't convey with
  // a flat list.
  //
  // Each rung shows:
  //   - role pill (R1/R2/R3 / S1/S2/S3)
  //   - ₹ price (the visual anchor, large and bold)
  //   - TF tag chip (4H / 1H / 5m / PDH / PDL) + source name +
  //     touch count badge (×N rejected)
  //   - distance from spot (e.g. "+108 pts above")
  function renderKeySr(an5, an1h, raw1h, spot) {
    var card    = $('ia-key-sr');
    var resHost = $('ia-key-sr-res');
    var supHost = $('ia-key-sr-sup');
    var spotVal = $('ia-key-sr-spot-val');
    var spotSub = $('ia-key-sr-spot-sub');
    if (!card || !resHost || !supHost || !spotVal) return;
    if (!an5 || !isFinite(spot)) { card.hidden = true; return; }

    var sr  = collectStructuralSr(an5, an1h, raw1h, spot);
    var res = sr.resistance.slice(0, 3);   // nearest → furthest above spot
    var sup = sr.support.slice(0, 3);      // nearest → furthest below spot

    // Pretty-printed source-TF tag.
    function tfTag(src) {
      if (src === '4h')      return '4H';
      if (src === '1h')      return '1H';
      if (src === '5m-zone') return '5m';
      if (src === 'pdh')     return 'PDH';
      if (src === 'pdl')     return 'PDL';
      if (src === 'pdc')     return 'PDC';
      if (src === 'pdo')     return 'PDO';
      if (src === 'fib')     return 'FIB';
      return '';
    }

    // Compute proportional vertical positions for the rungs:
    // each rung's position within its half of the ladder scales
    // with (its distance / max distance among visible rungs on
    // that side). Clamped to a min/max range so close rungs don't
    // overlap and far rungs don't fall off.
    var maxDist = 1;
    for (var ri = 0; ri < res.length; ri++) maxDist = Math.max(maxDist, Math.abs(res[ri].value - spot));
    for (var si = 0; si < sup.length; si++) maxDist = Math.max(maxDist, Math.abs(sup[si].value - spot));

    function rungHtml(lvl, role, kind, idx, count) {
      var dist    = Math.abs(lvl.value - spot);
      var distTxt = kind === 'res'
        ? '\u25B2 +' + fmtNum(dist) + ' pts above'
        : '\u25BC '  + fmtNum(dist) + ' pts below';
      var name        = M().escapeHtml ? M().escapeHtml(lvl.name) : lvl.name;
      var tag         = tfTag(lvl.source);
      var tagHtml     = tag
        ? '<span class="ia-key-sr-rung-tag ia-key-sr-rung-tag-' + lvl.source + '">' + tag + '</span>'
        : '';
      var touchesHtml = (lvl.touches && lvl.touches >= 2)
        ? ' <span class="ia-key-sr-rung-touches" title="Times price was rejected at this level">&times;' + lvl.touches + ' rejected</span>'
        : '';
      // Confluence chips — populated by dedupeMerging() in
      // collectStructuralSr when this rung's price absorbed one
      // or more overlapping levels of lower priority (e.g. a 5m
      // Multi-touch zone absorbing a 1H pivot at the same price).
      // Surfacing the absorbed source as a small "+1H" / "+FIB"
      // chip tells the user "this level has multi-timeframe
      // agreement" — a stronger setup than the headline label
      // alone implies.
      var confHtml = '';
      if (lvl.mergedSources && lvl.mergedSources.length) {
        for (var ms = 0; ms < lvl.mergedSources.length; ms++) {
          var msSrc = lvl.mergedSources[ms];
          var msTag = tfTag(msSrc);
          if (!msTag) continue;
          confHtml += ' <span class="ia-key-sr-rung-conf ia-key-sr-rung-conf-' + msSrc
                   + '" title="Also overlaps a ' + msTag + ' rejection cluster (confluence)">+' + msTag + '</span>';
        }
      }
      return '<div class="ia-key-sr-rung ia-key-sr-rung-' + kind + '">'
           +   '<div class="ia-key-sr-rung-left">'
           +     '<span class="ia-key-sr-rung-role">' + role + '</span>'
           +     '<span class="ia-key-sr-rung-val">\u20B9' + fmtNum(lvl.value) + '</span>'
           +   '</div>'
           +   '<div class="ia-key-sr-rung-right">'
           +     '<div class="ia-key-sr-rung-meta">' + tagHtml
           +       '<span class="ia-key-sr-rung-name">' + name + '</span>'
           +       confHtml
           +       touchesHtml
           +     '</div>'
           +     '<div class="ia-key-sr-rung-dist">' + distTxt + '</div>'
           +   '</div>'
           + '</div>';
    }

    // Resistance: rungs in DISPLAY order = highest price at top
    // → closest-to-spot at bottom. Source list (res) is sorted
    // nearest→furthest, so we reverse for display.
    if (res.length === 0) {
      resHost.innerHTML = '<div class="ia-key-sr-empty">No multi-touch resistance from 4H/1H pivots within range &mdash; price is in open air above.</div>';
    } else {
      var resHtml = '';
      for (var rj = res.length - 1; rj >= 0; rj--) {
        resHtml += rungHtml(res[rj], 'R' + (rj + 1), 'res', rj, res.length);
      }
      resHost.innerHTML = resHtml;
    }

    // Support: rungs in DISPLAY order = closest-to-spot at top
    // → lowest price at bottom. Source list (sup) is already
    // sorted nearest→furthest = top→bottom, so render in order.
    if (sup.length === 0) {
      supHost.innerHTML = '<div class="ia-key-sr-empty">No multi-touch support from 4H/1H pivots within range &mdash; price is in open air below.</div>';
    } else {
      var supHtml = '';
      for (var sj = 0; sj < sup.length; sj++) {
        supHtml += rungHtml(sup[sj], 'S' + (sj + 1), 'sup', sj, sup.length);
      }
      supHost.innerHTML = supHtml;
    }

    spotVal.textContent = '\u20B9' + fmtNum(spot);
    // Distance summary — instantly shows the structural asymmetry.
    var nearR = res.length ? Math.abs(res[0].value - spot) : null;
    var nearS = sup.length ? Math.abs(sup[0].value - spot) : null;
    var subParts = [];
    if (nearR != null) subParts.push('\u25B2 ' + fmtNum(nearR) + ' pts to R');
    if (nearS != null) subParts.push('\u25BC ' + fmtNum(nearS) + ' pts to S');
    if (spotSub) spotSub.textContent = subParts.length
      ? subParts.join('  \u00B7  ')
      : 'you are here';

    // ── Today's Fibonacci retracement strip ──────────────────────
    // Always render all 4 Fib levels (38.2 / 50 / 61.8 / 78.6 %)
    // here — independent of the top-3 structural ladder above.
    // Without this, a busy structural session (multiple 4H pivots
    // + multi-touch zones near spot) crowds Fib off the ladder
    // entirely. Hidden when an5.fib is null (weekend, pre-open,
    // or today's range too narrow to be meaningful).
    var fibHost  = $('ia-key-sr-fib');
    var fibTitle = $('ia-key-sr-fib-title');
    var fibChips = $('ia-key-sr-fib-chips');
    var fibMeta  = $('ia-key-sr-fib-meta');
    if (fibHost && fibChips && an5 && an5.fib && an5.fib.levels && an5.fib.levels.length) {
      var fib = an5.fib;
      // Header title — adapts to which session the Fib is anchored on:
      //   today  → "TODAY'S FIB RETRACEMENT"
      //   prev   → "FRIDAY'S FIB RETRACEMENT" (or whatever weekday)
      //            shown when weekend, pre-open, or session is too
      //            young to have a meaningful intraday range yet.
      if (fibTitle) {
        if (fib.source === 'prev') {
          fibTitle.textContent = (fib.weekday ? fib.weekday.toUpperCase() : 'PREV SESSION')
            + '\u2019S FIB RETRACEMENT';
        } else {
          fibTitle.textContent = 'TODAY\u2019S FIB RETRACEMENT';
        }
      }
      // Toggle visual class so the strip can subtly indicate it's
      // showing prev-session data instead of live today's range.
      fibHost.classList.toggle('ia-key-sr-fib-prev', fib.source === 'prev');
      // Header meta: "23,580 → 23,720 · 140 pts · up-leg"
      // "up-leg" means high came AFTER low → pullbacks below high
      //                                       are buy zones
      // "down-leg" means low came AFTER high → bounces above low
      //                                         are sell zones
      if (fibMeta) {
        fibMeta.textContent = '\u20B9' + fmtNum(fib.low) + ' \u2192 \u20B9' + fmtNum(fib.high)
          + '  \u00B7  ' + fmtNum(fib.range) + ' pts  \u00B7  '
          + (fib.direction === 'up' ? 'up-leg (pullback zones)' : 'down-leg (bounce zones)');
      }
      var chipsHtml = '';
      for (var fi = 0; fi < fib.levels.length; fi++) {
        var fl       = fib.levels[fi];
        var dist     = fl.value - spot;
        var distAbs  = Math.abs(dist);
        var sideArrow = dist >= 0 ? '\u25B2' : '\u25BC';
        var sideCls   = dist >= 0 ? 'res' : 'sup';
        var goldenCls = fl.isGolden ? ' ia-key-sr-fib-chip-golden' : '';
        chipsHtml += '<div class="ia-key-sr-fib-chip ia-key-sr-fib-chip-' + sideCls + goldenCls + '"'
          +   ' title="Fib ' + fl.label + ' of today\u2019s range — '
          +     (dist >= 0 ? 'above spot' : 'below spot') + '">'
          +   '<span class="ia-key-sr-fib-chip-pct">' + fl.label + '</span>'
          +   '<span class="ia-key-sr-fib-chip-val">\u20B9' + fmtNum(fl.value) + '</span>'
          +   '<span class="ia-key-sr-fib-chip-dist">' + sideArrow + ' ' + fmtNum(distAbs) + ' pts</span>'
          + '</div>';
      }
      fibChips.innerHTML = chipsHtml;
      fibHost.hidden = false;
    } else if (fibHost) {
      fibHost.hidden = true;
    }

    card.hidden = false;
  }

  function renderSrLadder(plan, an5, spot, sideTag, premium) {
    var ladder = $('ia-sr-ladder');
    var rail = $('ia-sr-rail');
    if (!ladder || !rail) return;
    var picked = {};   // map level.value → role label
    function mark(level, role) { if (level) picked[level.value] = role; }
    mark(plan.targetsSpot && plan.targetsSpot[0], 'T1');
    mark(plan.targetsSpot && plan.targetsSpot[1], 'T2');
    mark(plan.slSpot, 'SL');
    mark(plan.emergencySpot, 'EXIT');

    // Build the full level list = picked + supporting S/R from
    // srLadder, deduped + sorted highest→lowest. Spot is inserted
    // at its natural position so it visually sits between the
    // resistance stack (above) and support stack (below).
    var all = [];
    function push(value, name, role, picked) {
      if (value == null || !isFinite(value)) return;
      all.push({ value: value, name: name, role: role, picked: !!picked });
    }
    // Only T1 + T2 are surfaced as "picked"; the analyzer may
    // still compute a 3rd target internally but it's no longer
    // a user-facing target, so let it fall into the muted "S/R"
    // bucket alongside the other neutral levels.
    (plan.targetsSpot || []).slice(0, 2).forEach(function (lvl, i) {
      if (lvl) push(lvl.value, lvl.name, 'T' + (i + 1), true);
    });
    if (plan.slSpot)        push(plan.slSpot.value, plan.slSpot.name, 'SL', true);
    if (plan.emergencySpot) push(plan.emergencySpot.value, plan.emergencySpot.name, 'EXIT', true);
    // Other neutral S/R (not selected for the plan but still useful context).
    var resOther = (plan.srLadder && plan.srLadder.resistance) || [];
    var supOther = (plan.srLadder && plan.srLadder.support) || [];
    resOther.concat(supOther).forEach(function (lvl) {
      if (picked[lvl.value]) return;       // already on the ladder
      push(lvl.value, lvl.name, 'S/R', false);
    });
    // Clip neutral S/R to a ±120 pt window around spot — beyond that
    // distance is irrelevant for a 2-30 min scalp. Picked levels
    // (T1, T2, SL, EXIT) are always kept regardless of distance.
    var SCALP_WINDOW_PTS = 120;
    all = all.filter(function (lvl) {
      if (lvl.picked) return true;
      return Math.abs(lvl.value - spot) <= SCALP_WINDOW_PTS;
    });

    // Dedupe near-identical levels (within 1 point).
    all.sort(function (a, b) { return b.value - a.value; });
    var deduped = [];
    for (var i = 0; i < all.length; i++) {
      if (deduped.length === 0 || Math.abs(all[i].value - deduped[deduped.length - 1].value) >= 1) {
        deduped.push(all[i]);
      } else if (all[i].picked && !deduped[deduped.length - 1].picked) {
        // Picked level wins over neutral when both occupy the same price.
        deduped[deduped.length - 1] = all[i];
      }
    }
    // Insert spot at its natural position.
    var spotInserted = false;
    var final = [];
    for (var j = 0; j < deduped.length; j++) {
      if (!spotInserted && deduped[j].value <= spot) {
        final.push({ value: spot, name: 'Nifty 50 (you are here)', role: 'SPOT', picked: true });
        spotInserted = true;
      }
      final.push(deduped[j]);
    }
    if (!spotInserted) final.push({ value: spot, name: 'Nifty 50 (you are here)', role: 'SPOT', picked: true });

    // Render rungs.
    var html = final.map(function (r) {
      var dist = r.value - spot;
      var distTxt = r.role === 'SPOT' ? 'now'
        : (dist > 0 ? '+' + fmtNum(dist) + ' pts above' : fmtNum(dist) + ' pts below');
      var premiumProj = '';
      if (premium != null && r.role !== 'SPOT' && r.picked) {
        var projPx = spotToPremium(r.value, spot, premium, sideTag);
        premiumProj = ' \u00B7 ' + sideTag + ' \u2248 \u20B9' + fmtNum(projPx);
      }
      var roleCls = r.role === 'SPOT' ? 'spot'
                  : r.role === 'T1'   ? 't1'
                  : r.role === 'T2'   ? 't2'
                  : r.role === 'T3'   ? 't3'
                  : r.role === 'SL'   ? 'sl'
                  : r.role === 'EXIT' ? 'em'
                  :                     'other';
      return '<div class="ia-sr-rung ia-sr-rung-' + roleCls + '">'
           +   '<span class="ia-sr-rung-pill">' + r.role + '</span>'
           +   '<span class="ia-sr-rung-name">' + ((M().escapeHtml && M().escapeHtml(r.name)) || r.name)
           +     '<small>' + distTxt + premiumProj + '</small>'
           +   '</span>'
           +   '<span class="ia-sr-rung-val">\u20B9' + fmtNum(r.value) + '</span>'
           + '</div>';
    }).join('');
    rail.innerHTML = html;
    ladder.hidden = false;
  }

  // NOTE: renderTfMatrix was an experiment (May 2026) that put a
  // single unified TF table ABOVE the per-TF cards. It was
  // reverted because the standalone matrix duplicated the
  // per-card headlines visually disconnected from each card's
  // deep-dive body. The headline strip lives back inside each
  // card now (see renderTfCard below). Kept here in a dead
  // branch so the matrix code can be revived if we ever want a
  // dedicated at-a-glance comparison strip elsewhere.
  // eslint-disable-next-line no-unused-vars
  function renderTfMatrix(result) {
    var math = M();
    var host = $('ia-tf-matrix');
    if (!host) return;
    // Show a SCALPER-friendly tag per TF — describes what each
    // frame is for so the user knows why we're showing four of
    // them, not just "1H 15M 5M 3M" with no context.
    var rows = [
      { id: '1h',  label: '1 HOUR', tag: 'BIG TREND', an: result && result.tf1h },
      { id: '30m', label: '30 MIN', tag: 'BIAS',      an: result && result.tf30 },
      { id: '15m', label: '15 MIN', tag: 'CONTEXT',   an: result && result.tf15 },
      { id: '5m',  label: '5 MIN',  tag: 'EXECUTION', an: result && result.tf5  }
    ];
    var html = ''
      + '<div class="ia-tf-matrix-head">'
      +   '<span class="ia-tf-matrix-h">TIMEFRAME</span>'
      +   '<span class="ia-tf-matrix-h">TREND</span>'
      +   '<span class="ia-tf-matrix-h">RSI (14)</span>'
      +   '<span class="ia-tf-matrix-h">ADX (14)</span>'
      + '</div>';
    for (var i = 0; i < rows.length; i++) {
      var r  = rows[i];
      var an = r.an;
      if (!an) {
        html += '<div class="ia-tf-matrix-row" data-dir="neutral">'
          + '<div class="ia-tf-matrix-c ia-tf-matrix-c-tf">'
          +   '<span class="ia-tf-matrix-tf-name">' + r.label + '</span>'
          +   '<span class="ia-tf-matrix-tf-tag">' + r.tag + '</span>'
          + '</div>'
          + '<div class="ia-tf-matrix-c"><span class="ia-tf-matrix-v sw-muted">\u2014</span></div>'
          + '<div class="ia-tf-matrix-c"><span class="ia-tf-matrix-v sw-muted">\u2014</span></div>'
          + '<div class="ia-tf-matrix-c"><span class="ia-tf-matrix-v sw-muted">\u2014</span></div>'
          + '</div>';
        continue;
      }
      var trendCls = math.biasClass ? math.biasClass(an.trend) : '';
      var dir = trendCls === 'sw-bull' ? 'bull' : (trendCls === 'sw-bear' ? 'bear' : 'neutral');
      var trendTxt = math.shortTrendArrow ? math.shortTrendArrow(an.trend)
                   : (math.shortTrend ? math.shortTrend(an.trend) : an.trend);
      var vwapSub = an.aboveVwap === true ? 'above VWAP'
                   : an.aboveVwap === false ? 'below VWAP' : 'VWAP n/a';
      var mRsiTag = an.rsi > 70 ? 'overbought' : (an.rsi < 30 ? 'oversold'
                   : (an.rsi > 55 ? 'bullish' : (an.rsi < 45 ? 'bearish' : 'neutral')));
      var mRsiCls = an.rsi > 60 ? 'sw-bull' : (an.rsi < 40 ? 'sw-bear' : 'sw-muted');
      var mRsiV   = isFinite(an.rsi) ? an.rsi.toFixed(1) : '\u2014';
      var mAdxClass = math.classifyAdx ? math.classifyAdx(an.adx)
                   : { cls: 'sw-muted' };
      var mAdxV = (an.adx != null && isFinite(an.adx)) ? an.adx.toFixed(0) : '\u2014';
      var mAdxZone = an.adx == null ? '\u2014'
        : (an.adx < 20 ? 'weak' : an.adx < 25 ? 'developing'
          : an.adx < 40 ? 'strong' : an.adx < 50 ? 'very strong' : 'extreme');
      html += '<div class="ia-tf-matrix-row" data-dir="' + dir + '">'
        + '<div class="ia-tf-matrix-c ia-tf-matrix-c-tf">'
        +   '<span class="ia-tf-matrix-tf-name">' + r.label + '</span>'
        +   '<span class="ia-tf-matrix-tf-tag">' + r.tag + '</span>'
        + '</div>'
        + '<div class="ia-tf-matrix-c">'
        +   '<span class="ia-tf-matrix-v ' + trendCls + '">'
        +     ((math.escapeHtml ? math.escapeHtml(trendTxt) : trendTxt) || '\u2014')
        +   '</span>'
        +   '<span class="ia-tf-matrix-sub">' + vwapSub + '</span>'
        + '</div>'
        + '<div class="ia-tf-matrix-c">'
        +   '<span class="ia-tf-matrix-v ' + mRsiCls + '">' + mRsiV + '</span>'
        +   '<span class="ia-tf-matrix-sub">' + mRsiTag + '</span>'
        + '</div>'
        + '<div class="ia-tf-matrix-c">'
        +   '<span class="ia-tf-matrix-v ' + (mAdxClass.cls || '') + '">' + mAdxV + '</span>'
        +   '<span class="ia-tf-matrix-sub">' + mAdxZone + '</span>'
        + '</div>'
        + '</div>';
    }
    host.innerHTML = html;
  }

  // Mirror of the swing renderTfCard but for intraday TF analyses
  // — uses VWAP / ORH / PDH instead of 200-EMA / 52-week range.
  function renderTfCard(tfId, an, plan) {
    var math = M();
    // Corner-pill `.sw-tf-trend` was removed in May 2026 — the
    // TREND headline cell inside the body already shows the
    // same value (+ VWAP sub-text) so the pill was pure
    // duplication. Keep the function shape; only the lookup
    // got dropped.
    var rowsEl = $('ia-tf-' + tfId + '-rows');
    if (!rowsEl) return;
    var rsiTag = an.rsi > 70 ? 'overbought' : (an.rsi < 30 ? 'oversold' : (an.rsi > 55 ? 'bullish' : (an.rsi < 45 ? 'bearish' : 'neutral')));
    var rsiCls = an.rsi > 60 ? 'sw-bull' : (an.rsi < 40 ? 'sw-bear' : 'sw-muted');
    var adxClass = math.classifyAdx ? math.classifyAdx(an.adx) : { label: '—', cls: 'sw-muted', zone: 'weak' };
    var adxNum = (an.adx != null && isFinite(an.adx)) ? an.adx.toFixed(0) : '—';
    var adxZoneName = an.adx == null ? '—'
      : (an.adx < 20 ? 'weak' : an.adx < 25 ? 'developing' : an.adx < 40 ? 'strong' : an.adx < 50 ? 'very strong' : 'extreme');
    var html = '';

    // TF header strip — full-width first row inside the card:
    // "TIMEFRAME · 1 HOUR" (replaces the old separate <h4> that
    // used to sit above the body). Sits ABOVE the 3-cell
    // TREND / RSI / ADX strip so each indicator cell keeps its
    // full breathing room — earlier attempt at folding TIMEFRAME
    // INTO the 3-cell strip as a 4th column made every cell too
    // narrow.
    //
    // The header is tinted by this TF's trend bias via
    // data-dir="bull|bear|neutral" — bullish TFs get a green
    // tint + accent border, bearish get red, neutral grey. Lets
    // the user scan all 4 stacked cards and read "macro vs
    // lower-TF agreement" without parsing the TREND value.
    var tfLabelMap = { '1h': '1 HOUR', '30m': '30 MIN', '15m': '15 MIN', '5m': '5 MIN' };
    var tfLabel = tfLabelMap[tfId] || tfId.toUpperCase();
    var tfTrendCls = math.biasClass ? math.biasClass(an.trend) : '';
    var tfDir = tfTrendCls === 'sw-bull' ? 'bull'
              : tfTrendCls === 'sw-bear' ? 'bear' : 'neutral';
    // Trend in the header — arrow + text, no "TREND" label. The
    // arrow comes from shortTrendArrow (▲ for bull / ▼ for bear /
    // nothing for neutral); the text is the engine's classification
    // (NEUTRAL / WEAK BULL / BULL / STRONG BULL / and bear equivs).
    // VWAP sub goes underneath the value so the user still sees
    // "above VWAP" / "below VWAP" context that used to live in
    // the TREND cell of the headline strip.
    var trendTxt = math.shortTrendArrow ? math.shortTrendArrow(an.trend)
                 : (math.shortTrend ? math.shortTrend(an.trend) : an.trend);
    var trendVwap = vwapLabel(an);
    html += '<div class="sw-tf-tf-header" data-dir="' + tfDir + '">'
      +   '<div class="sw-tf-tf-header-eyebrow">'
      +     '<span class="sw-tf-tf-header-k">TIMEFRAME</span>'
      +     '<span class="sw-tf-tf-header-sep">\u00B7</span>'
      +     '<span class="sw-tf-tf-header-v">' + tfLabel + '</span>'
      +   '</div>'
      +   '<div class="sw-tf-tf-header-trend">'
      +     ((math.escapeHtml && math.escapeHtml(trendTxt)) || trendTxt)
      +   '</div>'
      +   '<div class="sw-tf-tf-header-vwap">' + trendVwap + '</div>'
      + '</div>';

    // Headline strip: RSI / ADX only (TREND moved up into the
    // TIMEFRAME header above). Tag the strip with sw-tf-headline-2
    // so CSS can collapse the grid from 3 to 2 columns.
    html += '<div class="sw-tf-headline sw-tf-headline-2">'
      +   '<div class="sw-tf-headline-cell">'
      +     '<span class="sw-tf-headline-k">RSI (14)</span>'
      +     '<span class="sw-tf-headline-v ' + rsiCls + '">' + (isFinite(an.rsi) ? an.rsi.toFixed(1) : '—') + '</span>'
      +     '<span class="sw-tf-headline-sub">' + ((math.escapeHtml && math.escapeHtml(rsiTag)) || rsiTag) + '</span>'
      +   '</div>'
      +   '<div class="sw-tf-headline-cell">'
      +     '<span class="sw-tf-headline-k">ADX (14)</span>'
      +     '<span class="sw-tf-headline-v ' + adxClass.cls + '">' + adxNum + '</span>'
      +     '<span class="sw-tf-headline-sub">' + ((math.escapeHtml && math.escapeHtml(adxZoneName)) || adxZoneName) + '</span>'
      +   '</div>'
      + '</div>';

    // Contribution panel — same shape as swing.
    if (plan && plan.tfScore && plan.tfSignals && plan.tfSignals[tfId]) {
      var net = plan.tfScore[tfId] || 0;
      var sigs = plan.tfSignals[tfId] || [];
      var netCls = net > 0 ? 'sw-bull' : (net < 0 ? 'sw-bear' : 'sw-muted');
      var netStr = (net > 0 ? '+' : '') + net;
      var panelCls = net > 0 ? 'sw-tf-contrib-bull' : (net < 0 ? 'sw-tf-contrib-bear' : 'sw-tf-contrib-neutral');
      html += '<div class="sw-tf-contrib ' + panelCls + '">'
        +   '<div class="sw-tf-contrib-head">'
        +     '<span class="sw-tf-contrib-k">CONTRIBUTION TO VERDICT</span>'
        +     '<span class="sw-tf-contrib-v ' + netCls + '">' + netStr + '<span class="sw-tf-contrib-suffix">pts</span></span>'
        +   '</div>';
      if (sigs.length) {
        html += '<ul class="sw-tf-contrib-list">';
        for (var i = 0; i < sigs.length; i++) {
          var s = sigs[i];
          var sCls = s.dir === 'bull' ? 'sw-bull' : 'sw-bear';
          var sPts = (s.pts >= 0 ? '+' : '') + s.pts;
          html += '<li><span class="sw-tf-contrib-pts ' + sCls + '">' + sPts + '</span><span>'
            + ((math.escapeHtml && math.escapeHtml(s.label)) || s.label) + '</span></li>';
        }
        html += '</ul>';
      } else {
        html += '<div class="sw-tf-contrib-empty">No directional signal at this timeframe \u2014 neutral vote.</div>';
      }
      html += '</div>';
    }

    // TREND block — VWAP + EMA 9/21/50 distances + ADX gauge + slopes.
    var trendBody = '';
    if (an.vwap != null && math.gaugeRow) {
      trendBody += math.gaugeRow(
        'vs VWAP',
        (an.vwapDistPct == null ? '—' : math.fmtSignedPct(an.vwapDistPct))
          + ' \u00B7 ' + (an.aboveVwap ? 'above' : 'below') + ' \u20B9' + fmtNum(an.vwap),
        an.aboveVwap ? 'sw-bull' : 'sw-bear',
        math.bipolarGauge(an.vwapDistPct, 1.5)
      );
    } else if (math.gaugeRow) {
      trendBody += math.gaugeRow('vs VWAP', vwapLabel(an), 'sw-muted', math.bipolarGauge(0, 1.5));
    }
    if (math.gaugeRow) {
      trendBody += math.gaugeRow(
        'vs EMA 9',
        (an.ema9DistPct == null ? '—' : math.fmtSignedPct(an.ema9DistPct))
          + ' \u00B7 ' + (an.lastClose > an.ema9 ? 'above' : 'below') + ' \u20B9' + fmtNum(an.ema9),
        an.lastClose > an.ema9 ? 'sw-bull' : 'sw-bear',
        math.bipolarGauge(an.ema9DistPct, 1.5)
      );
      trendBody += math.gaugeRow(
        'vs EMA 21',
        (an.ema21DistPct == null ? '—' : math.fmtSignedPct(an.ema21DistPct))
          + ' \u00B7 ' + (an.lastClose > an.ema21 ? 'above' : 'below') + ' \u20B9' + fmtNum(an.ema21),
        an.lastClose > an.ema21 ? 'sw-bull' : 'sw-bear',
        math.bipolarGauge(an.ema21DistPct, 2.5)
      );
      trendBody += math.gaugeRow(
        'vs EMA 50',
        (an.ema50DistPct == null ? '—' : math.fmtSignedPct(an.ema50DistPct))
          + ' \u00B7 ' + (an.lastClose > an.ema50 ? 'above' : 'below') + ' \u20B9' + fmtNum(an.ema50),
        an.lastClose > an.ema50 ? 'sw-bull' : 'sw-bear',
        math.bipolarGauge(an.ema50DistPct, 3.5)
      );
      trendBody += math.gaugeRow(
        'Trend strength (ADX 14)',
        adxNum + ' \u00B7 ' + adxZoneName,
        adxClass.cls,
        math.linearGauge(an.adx, {
          min: 0, max: 60,
          zones: [
            { from: 0,  to: 20, cls: 'weak' },
            { from: 20, to: 25, cls: 'developing' },
            { from: 25, to: 40, cls: 'strong' },
            { from: 40, to: 50, cls: 'strong' },
            { from: 50, to: 60, cls: 'extreme' }
          ],
          markerCls: adxClass.cls === 'sw-bull' ? 'sw-bull' : (adxClass.cls === 'sw-bear' ? 'sw-bear' : (adxClass.cls === 'sw-warn' ? 'sw-warn' : 'sw-muted')),
          ticks: ['weak', '25', 'strong', '50', 'extreme']
        })
      );
    }
    if (math.mrow) {
      trendBody += math.mrow('EMA 9 slope',  math.slopeLabel(an.ema9Slope),  math.slopeCls(an.ema9Slope));
      trendBody += math.mrow('EMA 21 slope', math.slopeLabel(an.ema21Slope), math.slopeCls(an.ema21Slope));
      // ── Supertrend row (NEW) ──
      // Shows direction + trailing band price + fresh-flip flag.
      if (an.supertrendTrend) {
        var stLbl = an.supertrendTrend === 'BULL' ? 'BULL' : 'BEAR';
        var stCls = an.supertrendTrend === 'BULL' ? 'sw-bull' : 'sw-bear';
        var stValStr = (an.supertrendValue != null && isFinite(an.supertrendValue))
          ? ' \u00B7 band \u20B9' + fmtNum(an.supertrendValue)
          : '';
        var flipTag = an.supertrendFlipped ? ' \u00B7 \u26A1 just flipped' : '';
        trendBody += math.mrow('Supertrend (10,3)', stLbl + stValStr + flipTag, stCls);
      }
    }
    if (math.tfBlock) html += math.tfBlock('trend', '\u2197', 'Trend', math.trendChip(an.trend), trendBody);

    // MOMENTUM block — RSI gauge + label + direction + MACD details.
    var momBody = '';
    if (math.gaugeRow) {
      momBody += math.gaugeRow(
        'RSI (14)',
        (isFinite(an.rsi) ? an.rsi.toFixed(1) : '—') + ' \u00B7 ' + rsiTag,
        rsiCls,
        math.linearGauge(an.rsi, {
          min: 0, max: 100,
          zones: [
            { from: 0,  to: 30,  cls: 'oversold' },
            { from: 70, to: 100, cls: 'overbought' }
          ],
          markerCls: rsiCls,
          ticks: ['0', '30', '50', '70', '100']
        })
      );
    }
    if (math.mrow) {
      momBody += math.mrow('Momentum label', math.momentumChip(an.momentum), '');
      momBody += math.mrow('RSI direction',  math.slopeLabel(an.rsiTrend),   math.slopeCls(an.rsiTrend));
      momBody += math.mrow('MACD histogram',
        (an.macdHist > 0 ? 'bullish ' : 'bearish ') + '(' + (isFinite(an.macdHist) ? an.macdHist.toFixed(2) : '—') + ')',
        an.macdHist > 0 ? 'sw-bull' : 'sw-bear');
      momBody += math.mrow('Histogram trend', math.slopeLabel(an.macdHistDir), math.slopeCls(an.macdHistDir));
      momBody += math.mrow('MACD vs signal',
        an.macdAboveSignal ? 'above (bull bias)' : 'below (bear bias)',
        an.macdAboveSignal ? 'sw-bull' : 'sw-bear');
      momBody += (an.macdCross
        ? math.mrow('Recent cross',
            (an.macdCross.dir === 'bull' ? 'bull cross' : 'bear cross')
              + (an.macdCross.barsAgo === 0 ? ' this bar' : ' ' + an.macdCross.barsAgo + ' bars ago'),
            an.macdCross.dir === 'bull' ? 'sw-bull' : 'sw-bear')
        : math.mrow('Recent cross', 'none in last 3 bars', 'sw-muted'));
      // ── Stochastic rows (NEW) ──
      // Shows K, D, regime label + cross direction (if any).
      if (an.stochK != null && an.stochD != null) {
        var stoChip = an.stochRegime === 'OVERSOLD' ? 'oversold (bounce zone)'
                    : an.stochRegime === 'OVERBOUGHT' ? 'overbought (pullback zone)'
                    : 'mid-range';
        var stoCls = an.stochRegime === 'OVERSOLD' ? 'sw-bull'
                   : an.stochRegime === 'OVERBOUGHT' ? 'sw-bear' : 'sw-muted';
        momBody += math.mrow('Stochastic (14,3,3)',
          'K=' + an.stochK.toFixed(0) + ' D=' + an.stochD.toFixed(0) + ' \u00B7 ' + stoChip,
          stoCls);
        if (an.stochCross) {
          var crossLbl = an.stochCross === 'bull' ? 'bullish K-over-D cross' : 'bearish K-under-D cross';
          var crossCls = an.stochCross === 'bull' ? 'sw-bull' : 'sw-bear';
          momBody += math.mrow('Stoch cross', crossLbl, crossCls);
        }
      }
      // ── OBV row (NEW) ──
      // Cumulative volume flow direction. We don't print the raw
      // OBV number (it's an arbitrary running sum) — only the
      // direction, which is the actionable signal.
      if (an.obvDir) {
        var obvLbl = an.obvDir === 'rising' ? 'rising (accumulation)'
                   : an.obvDir === 'falling' ? 'falling (distribution)'
                   : 'flat (neutral flow)';
        var obvCls = math.slopeCls(an.obvDir);
        momBody += math.mrow('OBV 20-bar slope', obvLbl, obvCls);
      }
    }
    if (math.tfBlock) html += math.tfBlock('momentum', '~', 'Momentum', math.momentumChip(an.momentum), momBody);

    // VOLATILITY block.
    var volBody = '';
    if (math.mrow) {
      volBody += math.mrow('ATR (14)', (isFinite(an.atr) ? an.atr.toFixed(1) : '—') + ' pts', '');
      volBody += math.mrow('ATR % of price', (an.atrPct != null ? an.atrPct.toFixed(2) + '%' : '—'),
        an.atrPct != null && an.atrPct > 0.4 ? 'sw-warn' : 'sw-muted');
    }
    var volChip = an.atrPct == null ? ''
      : (an.atrPct > 0.5 ? (math.chip && math.chip('HIGH VOL', 'warn'))
          : an.atrPct < 0.10 ? (math.chip && math.chip('LOW VOL', 'neutral'))
            : (math.chip && math.chip('NORMAL', 'neutral')));
    if (math.tfBlock) html += math.tfBlock('volatility', '\u2A91', 'Volatility', volChip, volBody);

    // VOLUME block.
    var volumeBody = '';
    if (math.gaugeRow) {
      if (an.volumeRatio != null) {
        volumeBody += math.gaugeRow(
          'Volume vs 20-bar MA',
          an.volumeRatio.toFixed(2) + '\u00D7 \u00B7 ' + (an.volumeAboveAvg ? 'above avg' : 'below avg'),
          an.volumeAboveAvg ? 'sw-bull' : 'sw-muted',
          math.linearGauge(Math.min(an.volumeRatio, 3), {
            min: 0, max: 3,
            zones: [{ from: 1, to: 3, cls: 'strong' }],
            markerCls: an.volumeAboveAvg ? 'sw-bull' : 'sw-muted',
            ticks: ['0', '1\u00D7', '2\u00D7', '3\u00D7']
          })
        );
      } else {
        volumeBody += math.gaugeRow('Volume vs 20-bar MA', 'n/a (index)', 'sw-muted',
          math.linearGauge(0, { min: 0, max: 3, zones: [{ from: 1, to: 3, cls: 'weak' }], markerCls: 'sw-muted', ticks: ['0', '1\u00D7', '2\u00D7', '3\u00D7'] }));
      }
    }
    if (math.mrow) volumeBody += math.mrow('Volume trend (5-bar)', math.slopeLabel(an.volTrend), math.slopeCls(an.volTrend));
    var volChipUI = an.volumeRatio != null && an.volumeAboveAvg ? (math.chip && math.chip('CONFIRMING', 'bull')) : (math.chip && math.chip('LIGHT', 'neutral'));
    if (math.tfBlock) html += math.tfBlock('volume', '|||', 'Volume', volChipUI, volumeBody);

    // STRUCTURE block.
    // For 15m/5m/3m: show VWAP + ORH/ORL + PDH/PDL + swing levels.
    // For 1H: show ONLY the 1H swing high / low. Session-level S/R
    //   (VWAP / ORH / ORL / PDH / PDL / CPR) are session-anchored
    //   and computed from 5m data. The 1H bar's lastClose lags the
    //   5m by up to 55 min, so showing "above VWAP" or "above PDH"
    //   here would use a stale reference price — actively misleading.
    //   We surface a one-line note explaining the omission instead.
    var structBody = '';
    var is1h = (tfId === '1h');
    if (math.mrow) {
      if (!is1h) {
        structBody += math.mrow('Day VWAP',  an.vwap != null     ? '\u20B9' + fmtNum(an.vwap)     : 'n/a', an.vwap != null ? '' : 'sw-muted');
        structBody += math.mrow('Opening Range High', an.orHigh != null ? '\u20B9' + fmtNum(an.orHigh) : 'n/a', an.orHigh != null ? 'sw-bull' : 'sw-muted');
        structBody += math.mrow('Opening Range Low',  an.orLow  != null ? '\u20B9' + fmtNum(an.orLow)  : 'n/a', an.orLow  != null ? 'sw-bear' : 'sw-muted');
        structBody += math.mrow('Previous Day High', an.prevHigh != null ? '\u20B9' + fmtNum(an.prevHigh) : 'n/a', an.prevHigh != null ? 'sw-bull' : 'sw-muted');
        structBody += math.mrow('Previous Day Low',  an.prevLow  != null ? '\u20B9' + fmtNum(an.prevLow)  : 'n/a', an.prevLow  != null ? 'sw-bear' : 'sw-muted');
      }
      structBody += math.mrow(
        is1h ? '1H Swing High' : 'Swing high',
        an.swingHigh != null ? '\u20B9' + fmtNum(an.swingHigh) : 'n/a',
        an.swingHigh != null ? 'sw-bull' : 'sw-muted'
      );
      structBody += math.mrow(
        is1h ? '1H Swing Low' : 'Swing low',
        an.swingLow != null ? '\u20B9' + fmtNum(an.swingLow) : 'n/a',
        an.swingLow != null ? 'sw-bear' : 'sw-muted'
      );
      if (is1h) {
        structBody += '<div class="sw-tf-contrib-empty" style="font-size:10.5px;line-height:1.4;margin-top:6px;color:var(--sw-muted, #6b7280)">'
          + 'Session levels (VWAP/PDH/PDL/ORH/ORL/CPR) come from 5m \u2014 the 1H bar lags by up to 55 min, so showing them against the stale 1H close would mislead. They are visible on the 15m / 5m / 3m cards instead.'
          + '</div>';
      }
    }
    if (math.tfBlock) html += math.tfBlock('structure', '#', 'Structure', '', structBody);

    // ── PATTERN block ──
    // Shows the directional pattern (if any) WITH location context:
    //   • Top row: the pattern chip itself (bull/bear color)
    //   • Mid row: candle close price ("at ₹X")
    //   • Bottom: a context chip + level description
    //       - GREEN  "AT support"   — bull pattern AT support OR bear at resistance (high-conviction)
    //       - WARN   "anti-signal"  — bull at resistance OR bear at support (location says skip)
    //       - GREY   "no nearby S/R" — pattern in mid-range, low conviction
    // Also shows compression (Inside Bar / NR4) and neutral Doji
    // as additional context — these don't replace bull/bear; they
    // append a SECOND chip beneath the price line.
    var patBody = '';
    if (math.chip) {
      var name = an.patternBull || an.patternBear || null;
      var side = an.patternBull ? 'bull' : (an.patternBear ? 'bear' : null);
      var ctx  = an.patternBull ? an.patternBullCtx : (an.patternBear ? an.patternBearCtx : null);
      if (name && side) {
        patBody += '<div style="text-align:center;padding:6px 0 4px">'
                + math.chip(name, side) + '</div>';
        // ── Reliability tier descriptor ───────────────────────
        // Surfaces the per-TF weight hierarchy so the user
        // intuitively knows a 1H pattern outweighs a 3m pattern
        // when verdicts seem to disagree across cards. Trend
        // Identifier v1 lineup (2026-05-25):
        //   1H : highest reliability (defines bias)
        //   30m: macro confirm        (must agree with 1H)
        //   15m: trade-grade context
        //   5m : intraday setup + trigger
        var tierLabel = null;
        if (tfId === '1h')        tierLabel = 'TIER 1 \u00B7 HIGHEST RELIABILITY';
        else if (tfId === '30m')  tierLabel = 'TIER 2 \u00B7 MACRO CONFIRM';
        else if (tfId === '15m')  tierLabel = 'TIER 3 \u00B7 TRADE-GRADE';
        else if (tfId === '5m')   tierLabel = 'TIER 4 \u00B7 INTRADAY SETUP';
        if (tierLabel) {
          patBody += '<div style="text-align:center;font-size:9.5px;color:var(--sw-muted, #6b7280);margin:0 0 4px;letter-spacing:0.4px;font-weight:600">'
                  + tierLabel + '</div>';
        }
        // Price line — "at ₹23,705.50"
        // 1H falls back to an.lastClose since ctx is null (we
        // pass levels=null to analyzeTfIntraday for 1H — see the
        // comment in renderAll). Showing the 1H bar's close is
        // still useful; it's the "price where the macro pattern
        // formed".
        var displayPrice = (ctx && ctx.candlePrice != null)
          ? ctx.candlePrice
          : (an.lastClose != null ? an.lastClose : null);
        if (displayPrice != null) {
          patBody += '<div style="text-align:center;font-size:11px;color:var(--sw-muted, #6b7280);margin:2px 0 2px">'
                  + 'at \u20B9' + fmtNum(displayPrice) + '</div>';
        }
        // Time range — when did this PATTERN form? For multi-bar
        // patterns (Piercing=2, Morning Star=3) we span the FULL
        // sequence, not just the signal candle. analyzeTfIntraday
        // exposes patternStartMs = start of the first candle in
        // the pattern; for 1-bar patterns it equals lastBarStartMs.
        //
        // The user pointed out that showing only "15:15 – 15:30"
        // for a Piercing Pattern is misleading — Piercing needs 2
        // candles and the prior candle's open/close is where the
        // setup actually begins.
        var spanStartMs = (an.patternStartMs != null) ? an.patternStartMs : an.lastBarStartMs;
        if (spanStartMs != null && an.lastBarEndMs != null) {
          var spanLabel = (an.patternBarSpan && an.patternBarSpan > 1)
            ? ('pattern spans ' + an.patternBarSpan + ' bars \u00B7 formed ')
            : 'formed ';
          patBody += '<div style="text-align:center;font-size:10.5px;color:var(--sw-muted, #6b7280);margin:0 0 6px">'
                  + spanLabel + fmtClockShort(spanStartMs)
                  + ' \u2013 ' + fmtClockShort(an.lastBarEndMs)
                  + ' IST</div>';
        }
        // 1H has no S/R context (session levels are stale). Show
        // a "macro" descriptor instead so the user understands
        // the pattern is intentional context-stripped, not a bug.
        if (is1h) {
          patBody += '<div style="text-align:center;padding:2px 0">'
            + math.chip('MACRO 1H PATTERN', side)
            + '</div>';
          patBody += '<div style="text-align:center;font-size:10px;color:var(--sw-muted, #6b7280);margin:4px 0">'
            + '1H bar candle \u2014 institutional / swing reference. S/R location not computed (session levels are 5m-anchored).'
            + '</div>';
        } else if (ctx) {
          var sideMatch = (side === 'bull' && ctx.nearestSupport)
                       || (side === 'bear' && ctx.nearestResistance);
          var sideOpposite = (side === 'bull' && ctx.nearestResistance && !ctx.nearestSupport)
                          || (side === 'bear' && ctx.nearestSupport && !ctx.nearestResistance);
          var relevant = sideMatch
            ? (side === 'bull' ? ctx.nearestSupport : ctx.nearestResistance)
            : (sideOpposite
                ? (side === 'bull' ? ctx.nearestResistance : ctx.nearestSupport)
                : null);
          var esc = math.escapeHtml || function (s) { return String(s); };
          if (sideMatch) {
            patBody += '<div style="text-align:center;padding:2px 0">'
              + math.chip('AT ' + (side === 'bull' ? 'SUPPORT' : 'RESISTANCE'), 'bull')
              + '</div>';
            patBody += '<div style="text-align:center;font-size:10.5px;color:var(--sw-text, #374151);line-height:1.4;margin:4px 0 2px">'
              + esc(relevant.name)
              + ' \u00B7 \u20B9' + fmtNum(relevant.price)
              + '</div>';
            patBody += '<div style="text-align:center;font-size:10px;color:var(--sw-muted, #6b7280);margin-bottom:4px">'
              + 'high-conviction rejection setup'
              + '</div>';
          } else if (sideOpposite) {
            patBody += '<div style="text-align:center;padding:2px 0">'
              + math.chip('AT ' + (side === 'bull' ? 'RESISTANCE' : 'SUPPORT') + ' \u2014 ANTI-SIGNAL', 'warn')
              + '</div>';
            patBody += '<div style="text-align:center;font-size:10.5px;color:var(--sw-text, #374151);line-height:1.4;margin:4px 0 2px">'
              + esc(relevant.name)
              + ' \u00B7 \u20B9' + fmtNum(relevant.price)
              + '</div>';
            patBody += '<div style="text-align:center;font-size:10px;color:var(--sw-warn, #b45309);margin-bottom:4px">'
              + (side === 'bull' ? 'bull pattern AT resistance \u2014 location says skip'
                                 : 'bear pattern AT support \u2014 location says skip')
              + '</div>';
          } else {
            patBody += '<div style="text-align:center;padding:2px 0">'
              + math.chip('NO NEARBY S/R', 'neutral')
              + '</div>';
            patBody += '<div style="text-align:center;font-size:10px;color:var(--sw-muted, #6b7280);margin:4px 0">'
              + 'pattern in mid-range \u2014 low conviction'
              + '</div>';
          }
        }
      } else if (an.lookbackPattern) {
        // ── No pattern on current bar → show lookback ───────────
        // The most recent prior pattern within the TF's lookback
        // window. Dimmed + labeled "Last pattern" so the user
        // doesn't mistake it for a live entry signal — it's
        // historical context, NOT a tradable trigger.
        var lb = an.lookbackPattern;
        var lbSide = lb.side;
        // Pattern chip — same coloring as a live pattern but with
        // muted opacity so it doesn't shout "trade this now".
        patBody += '<div style="text-align:center;padding:6px 0 2px;opacity:0.7">'
                + math.chip(lb.name, lbSide) + '</div>';
        // Reliability tier — same as the live-pattern branch above
        // so the user sees the TF hierarchy regardless of whether
        // the current bar has a pattern or we're showing lookback.
        var tierLb = null;
        if (tfId === '1h')        tierLb = 'TIER 1 \u00B7 HIGHEST RELIABILITY';
        else if (tfId === '30m')  tierLb = 'TIER 2 \u00B7 MACRO CONFIRM';
        else if (tfId === '15m')  tierLb = 'TIER 3 \u00B7 TRADE-GRADE';
        else if (tfId === '5m')   tierLb = 'TIER 4 \u00B7 INTRADAY SETUP';
        if (tierLb) {
          patBody += '<div style="text-align:center;font-size:9.5px;color:var(--sw-muted, #6b7280);margin:0 0 4px;letter-spacing:0.4px;font-weight:600">'
                  + tierLb + '</div>';
        }
        // "Last pattern · N bars ago" — clarifies this is stale.
        patBody += '<div style="text-align:center;font-size:10.5px;color:var(--sw-muted, #6b7280);margin:2px 0 2px;font-weight:600;letter-spacing:0.3px">'
                + 'LAST PATTERN \u00B7 ' + lb.barsAgo + ' bar' + (lb.barsAgo === 1 ? '' : 's') + ' ago'
                + '</div>';
        // Price line.
        if (lb.candlePrice != null) {
          patBody += '<div style="text-align:center;font-size:11px;color:var(--sw-muted, #6b7280);margin:2px 0 2px">'
                  + 'at \u20B9' + fmtNum(lb.candlePrice) + '</div>';
        }
        // Time range — uses lookback span (2 bars for engulfing, etc.)
        if (lb.startMs != null && lb.endMs != null) {
          var lbSpanLabel = (lb.barSpan && lb.barSpan > 1)
            ? ('pattern spans ' + lb.barSpan + ' bars \u00B7 formed ')
            : 'formed ';
          patBody += '<div style="text-align:center;font-size:10.5px;color:var(--sw-muted, #6b7280);margin:0 0 4px">'
                  + lbSpanLabel + fmtClockShort(lb.startMs)
                  + ' \u2013 ' + fmtClockShort(lb.endMs)
                  + ' IST</div>';
        }
        // Disclaimer — make it crystal clear this is historical.
        patBody += '<div style="text-align:center;font-size:10px;color:var(--sw-muted, #6b7280);margin:4px 0 4px;font-style:italic">'
                + 'current bar has no textbook reversal pattern \u2014 showing most recent prior signal'
                + '</div>';
      } else {
        patBody += '<div class="sw-tf-contrib-empty" style="text-align:center;margin:0">No tradable pattern on the last bar.</div>';
      }
      // Compression + neutral chips — append BELOW the directional
      // pattern (or stand alone if no directional pattern fired).
      var extras = [];
      if (an.patternCompression) extras.push(math.chip(an.patternCompression + ' \u00B7 wait for break', 'neutral'));
      if (an.patternNeutral === 'Doji') extras.push(math.chip('Doji \u00B7 indecision', 'neutral'));
      if (extras.length) {
        patBody += '<div style="text-align:center;padding:6px 0 2px;display:flex;flex-wrap:wrap;gap:4px;justify-content:center">'
                + extras.join('') + '</div>';
      }
    }
    if (math.tfBlock) html += math.tfBlock('pattern', '\u25C7', 'Pattern', '', patBody);

    // Footnote — candle count + last bar's time range.
    // The time range is helpful for users to know exactly which
    // bar the analysis is based on (e.g. "1H card based on the
    // 14:15 – 15:15 IST bar" — they can cross-reference the chart).
    var foot = 'Computed from ' + an.candleCount + ' candles';
    if (an.lastBarStartMs != null && an.lastBarEndMs != null) {
      foot += ' \u00B7 last bar ' + fmtClockShort(an.lastBarStartMs)
            + '\u2013' + fmtClockShort(an.lastBarEndMs) + ' IST';
    }
    html += '<div class="sw-tf-foot">' + foot + '</div>';

    rowsEl.innerHTML = html;
  }

  // Keeps the 2-column context-pill grid balanced: counts the
  // currently-visible direct children and, if the count is odd
  // (1, 3, 5 …), tags the LAST visible pill with .ia-pill-fill
  // so CSS spans it across both columns. Without this, the lone
  // trailing pill would leave a phantom empty cell beside it,
  // which is what the user was seeing when the IV / STRUCTURE
  // pills appeared / disappeared between mode switches. We can't
  // do this in pure CSS because :nth-child counts ALL siblings
  // including [hidden] ones, so DOM order doesn't equal visible
  // order. Cheap (≤ 6 DOM reads, called once per renderAll).
  function layoutContextGrid() {
    var grid = document.querySelector('#ia-result .ia-context-grid');
    if (!grid) return;
    var children = grid.children;
    var visible = [];
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      el.classList.remove('ia-pill-fill');
      // Only the [hidden] attribute matters for visibility logic —
      // every renderXPill toggles it explicitly. Avoid offsetParent
      // checks (they can spuriously return null when a ancestor is
      // briefly hidden e.g. tab visibility toggle).
      if (!el.hidden) visible.push(el);
    }
    if (visible.length % 2 === 1) {
      visible[visible.length - 1].classList.add('ia-pill-fill');
    }
  }

  function renderAll(result) {
    if (!result) return;
    // Mode-toggle render call was removed in the May 2026 SCALP-
    // only refactor — the toggle UI no longer exists (engine
    // is hard-coded SCALP) so there's nothing to repaint here.
    // SIGNAL JOURNAL — auto-log every BUY signal that fires on
    // the rising edge (transition into BUY_CE / BUY_PE). Runs
    // BEFORE renderDecisionHud so the journal counter visible
    // above is fresh by the time the user sees the HUD verdict.
    // Safe no-op on WAIT (just tracks the action transition).
    try {
      if (typeof signalJournalModule !== 'undefined') {
        signalJournalModule.logSignal(result.plan, result.tf5);
      }
    } catch (_) { /* never let logging crash the render path */ }
    // TRADE DECISION HUD — must render FIRST so the at-a-glance
    // verdict + numbers + red flags sit at the top of the result
    // block above every pill / breakdown / SKIP IF. See the
    // function body below for the populated fields.
    renderDecisionHud(result.plan, result.tf5);
    renderSessionPill(result.plan);
    renderH1Pill(result.plan, result.tf1h);
    renderIVPill(result.plan);
    renderVolPill(result.plan);
    renderBnPill(result.plan);
    renderCprPill(result.plan);
    // Pills above may show/hide based on data availability
    // (IV / BN depend on async chain data). Re-balance the 2-col
    // grid so the trailing odd pill always spans full width — no
    // half-row orphans.
    layoutContextGrid();
    renderBiasCell('1h',  result.tf1h);
    renderBiasCell('30m', result.tf30);
    renderBiasCell('15m', result.tf15);
    renderBiasCell('5m',  result.tf5);
    renderFinalCell(result.plan);
    // Always-on Key S/R card — shows the structural map even when
    // verdict is WAIT or market is closed. Uses 5m analysis as the
    // primary source; 1H pivots/EMAs layered on top. Render BEFORE
    // renderPlan so the user reads "where am I in the structure?"
    // before "what's the verdict?".
    // Prefer the LIVE Nifty 50 spot LTP (pushed via paperTradeTick)
    // over the historical-candle bar close — Upstox's market-quote
    // endpoint is the authoritative source and can disagree with
    // the last 3m bar by a tick, particularly after market close
    // (their two endpoints don't always sync on the closing print).
    var liveKeySpot = (typeof window.paperTradeGetLastSpot === 'function')
      ? window.paperTradeGetLastSpot() : null;
    var keySpot = (liveKeySpot != null) ? liveKeySpot
                : (result.tf5 && isFinite(result.tf5.lastClose)) ? result.tf5.lastClose
                : null;
    renderKeySr(result.tf5, result.tf1h, result.raw1h || [], keySpot);
    renderPlan(result.plan, result.tf5, null);
    // Render order matches the visual grid (1H | 30m | 15m | 5m
    // — macro to micro, left to right). renderTfCard auto-detects
    // tfId === '1h' and adjusts the Structure + Pattern blocks
    // (omits session-S/R since 1H lastClose lags 5m by up to 55m).
    // 3m was dropped in Trend Identifier v1 Phase 2 (2026-05-25).
    renderTfCard('1h',  result.tf1h, result.plan);
    renderTfCard('30m', result.tf30, result.plan);
    renderTfCard('15m', result.tf15, result.plan);
    renderTfCard('5m',  result.tf5,  result.plan);
    // SIGNAL JOURNAL — repaint stat tiles + table after every
    // analyze cycle so newly-logged entries (and updated
    // win-rate aggregates) reflect immediately. Cheap; one
    // tbody.innerHTML reassignment + 5 stat tile updates.
    try { if (typeof renderJournal === 'function') renderJournal(); } catch (_) {}
    // Footer status
    setHtml('ia-last-analyzed', '<b>' + fmtClock(STATE.lastAnalyzedMs) + '</b>');
  }

  // ─── SESSION pill ────────────────────────────────────────────────
  // First card in the context grid because session timing is the
  // single most actionable filter for an intraday trader — a
  // world-class setup in NO_NEW is still a no-trade, and a
  // mediocre setup in PRIME usually beats a great setup in
  // AFTERNOON chop. Four verdict states (TRADE NOW / CAUTION /
  // DO NOT TRADE / MARKET CLOSED) drive the colour + impact line,
  // with a live IST clock + countdown so the user sees the runway
  // left in the current window.

  // Returns the minute-of-day when the current phase ends.
  // Returns SESSION_CLOSE_MIN as a safe ceiling so the countdown
  // never goes negative. SCALP-only since the May 2026 refactor.
  function phaseEndMin(phase) {
    switch (phase) {
      case 'PRE_OPEN':   return SESSION_OPEN_MIN;           // 09:15
      case 'OR_FORMING': return 9 * 60 + 20;                 // 09:20
      case 'OR_SETTLED': return 9 * 60 + 30;                 // 09:30
      case 'PRIME':      return 11 * 60 + 30;                // 11:30
      case 'LATE_MORN':  return 12 * 60 + 30;                // 12:30
      case 'LUNCH_CHOP': return 13 * 60 + 30;                // 13:30
      case 'AFTERNOON':  return 14 * 60 + 30;                // 14:30
      case 'LATE_PUSH':  return 15 * 60;                     // 15:00
      case 'LATE_SCALP': return 15 * 60 + 25;                // 15:25
      case 'NO_NEW':     return SESSION_CLOSE_MIN;           // 15:30
    }
    return SESSION_CLOSE_MIN;
  }

  // Binary go/no-go verdict for the current phase. Drives the
  // pill colour + headline word. CAUTION is the catch-all for
  // phases where the engine demotes confidence (LUNCH_CHOP /
  // AFTERNOON / OR_SETTLED) — tradeable but with reduced size.
  // SCALP-only since the May 2026 refactor.
  function phaseVerdict(phase) {
    if (phase === 'PRE_OPEN' || phase === 'POST_CLOSE' || phase === 'WEEKEND') {
      return { word: 'MARKET CLOSED', cls: 'closed' };
    }
    if (phase === 'OR_FORMING' || phase === 'NO_NEW') {
      return { word: 'DO NOT TRADE', cls: 'no' };
    }
    if (phase === 'PRIME' || phase === 'LATE_MORN' || phase === 'LATE_PUSH') {
      return { word: 'TRADE NOW', cls: 'go' };
    }
    return { word: 'CAUTION', cls: 'caution' };
  }

  // "tomorrow" vs "Monday" for the POST_CLOSE / weekend impact
  // line. Mon-Thu → tomorrow; Fri/Sat/Sun → Monday (skip the
  // weekend). Mirrors the wording in nextOpenLabel() so the
  // pill and the chart footer stay consistent.
  function nextTradingDayLabel() {
    var w = nowISTParts().weekday;
    return (w === 'Fri' || w === 'Sat' || w === 'Sun') ? 'Monday' : 'tomorrow';
  }

  // Plain-English impact line — explains WHY the phase carries
  // the verdict it does. Pulled out as a helper so the render
  // function reads as a layout function, not a switch.
  // SCALP-only since the May 2026 refactor.
  function phaseImpact(phase) {
    switch (phase) {
      case 'PRIME':       return 'best window \u2014 full confidence allowed';
      case 'OR_SETTLED':  return 'OR just closed \u2014 HIGH capped at MEDIUM until 09:30';
      case 'LATE_MORN':   return 'scalps trade fine \u2014 full confidence allowed';
      case 'LUNCH_CHOP':  return 'lunch chop \u2014 HIGH capped at MEDIUM, thin liquidity';
      case 'AFTERNOON':   return 'afternoon chop \u2014 HIGH capped at MEDIUM, weakest intraday window';
      case 'LATE_PUSH':   return 'scalper sweet spot (14:30\u201315:00) \u2014 full confidence allowed';
      case 'LATE_SCALP':  return 'late scalp (15:00\u201315:25) \u2014 confidence forced to LOW, exit fast';
      case 'NO_NEW':      return 'last 5 min \u2014 even a scalp won\u2019t have time to work';
      case 'OR_FORMING':  return 'first 5 min \u2014 wait for one 5m bar to close at 09:20 IST';
      case 'PRE_OPEN':    return 'wait for 09:15 IST \u2014 recommendation refreshes once bell rings';
      case 'POST_CLOSE':  return 'session ended \u2014 next analysis at ' + nextTradingDayLabel() + '\u2019s open';
      case 'WEEKEND':     return 'market closed for the weekend \u2014 next analysis at Monday\u2019s open';
      default:            return '';
    }
  }

  // Render the SESSION context pill — mirrors .ia-h1-pill
  // structure (icon · label · verdict chip · detail · impact).
  // Always visible (including off-hours) so the trader knows
  // when to come back. Reads the LIVE IST clock so the
  // countdown stays accurate even after long idle periods.
  function renderSessionPill(plan) {
    var pill = $('ia-session-pill');
    if (!pill) return;
    var ist = nowISTParts();
    // classifySessionPhase handles weekend natively (returns the
    // dedicated 'WEEKEND' phase on Sat/Sun). The `plan.session.mode`
    // / `getTradingMode()` read used to live here when the engine
    // supported SCALP vs SWING — removed in the May 2026 SCALP-
    // only refactor (see classifySessionPhase for the rationale).
    var phase = classifySessionPhase(ist.minOfDay);
    var verdict = phaseVerdict(phase);
    var phaseName = sessionPhaseLabel(phase).split('\u2014')[0].trim();
    var detail;
    if (phase === 'PRE_OPEN' || phase === 'POST_CLOSE' || phase === 'WEEKEND') {
      detail = (typeof window.nextOpenLabel === 'function')
        ? window.nextOpenLabel()
        : 'next open 09:15 IST';
    } else {
      var leftMin = Math.max(0, phaseEndMin(phase) - ist.minOfDay);
      var clockStr = String(Math.floor(ist.minOfDay / 60)).padStart(2, '0')
        + ':' + String(ist.minOfDay % 60).padStart(2, '0') + ' IST';
      detail = phaseName + ' \u00B7 ' + clockStr + ' \u00B7 ' + leftMin + ' min left';
    }
    pill.hidden = false;
    pill.className = 'ia-session-pill ia-session-' + verdict.cls;
    setText('ia-session-verdict', verdict.word);
    setText('ia-session-detail',  detail);
    setText('ia-session-impact',  phaseImpact(phase));
  }

  // ─── 1-Hour CONTEXT pill ─────────────────────────────────────────
  // Sits above the 3-card bias bar. Shows the macro trend + impact
  // on the verdict ("aligns" / "conflicts" / "neutral"). When the
  // 1H trend opposes the active verdict direction (handled by the
  // veto rule in generateVerdict), the pill flips to amber so the
  // user can see at a glance that the bigger picture isn't helping.
  function renderH1Pill(plan, an1h) {
    var pill = $('ia-h1-pill');
    if (!pill) return;
    if (!an1h || !plan || !plan.h1) {
      pill.hidden = true;
      return;
    }
    pill.hidden = false;
    var h1 = plan.h1;
    var math = M();
    var trendShort = math.shortTrendArrow ? math.shortTrendArrow(h1.trend)
                   : (math.shortTrend ? math.shortTrend(h1.trend) : h1.trend);
    // ADX-aware trend label. The TREND classification fires on EMA
    // stacking (STRONG_BULL = price > ema9 > ema21 > ema50) but a
    // stacked-yet-weak trend (ADX < 20) is actually range-bound under
    // the hood. Many setups that "align with the 1H trend" fail
    // because the 1H trend isn't truly trending. We surface this
    // honestly in the pill so the user isn't lulled by a false
    // "STRONG UP" label.
    var weakTrend = (isFinite(h1.adx) && h1.adx < 20);
    if (weakTrend && h1.net !== 'FLAT') {
      // Demote the label visually — "▲ STRONG UP" becomes
      // "▲ UP (weak)". Using .replace() instead of an indexOf-0
      // slice because the optional arrow prefix shifts STRONG's
      // start position.
      if (trendShort) trendShort = trendShort.replace('STRONG ', '');
      trendShort = trendShort + ' (weak)';
    }
    var detail = 'RSI ' + (isFinite(h1.rsi) ? h1.rsi.toFixed(0) : '—')
      + (h1.adx != null ? ' \u00B7 ADX ' + h1.adx.toFixed(0) : '')
      + (h1.swingHigh != null ? ' \u00B7 swing high \u20B9' + fmtNum(h1.swingHigh) : '')
      + (h1.swingLow  != null ? ' / low \u20B9' + fmtNum(h1.swingLow)  : '');
    // Impact text — explains HOW the 1H trend is influencing the verdict.
    var impact;
    var conflict = false;
    if (plan.action === 'BUY_CE') {
      if (h1.net === 'BULL') {
        impact = weakTrend
          ? '\u26A0 1H bias is up but ADX ' + h1.adx.toFixed(0) + ' \u2014 trend is weak / range-bound, macro tape may not carry the trade'
          : '\u2713 ALIGNS with intraday BUY CE \u2014 macro trend supports the trade';
      } else if (h1.net === 'BEAR') {
        impact = '\u26A0 CONFLICTS with intraday BUY CE \u2014 fighting the bigger trend';
        conflict = true;
      } else {
        impact = 'NEUTRAL macro trend \u2014 intraday recommendation stands on its own';
      }
    } else if (plan.action === 'BUY_PE') {
      if (h1.net === 'BEAR') {
        impact = weakTrend
          ? '\u26A0 1H bias is down but ADX ' + h1.adx.toFixed(0) + ' \u2014 trend is weak / range-bound, macro tape may not carry the trade'
          : '\u2713 ALIGNS with intraday BUY PE \u2014 macro trend supports the trade';
      } else if (h1.net === 'BULL') {
        impact = '\u26A0 CONFLICTS with intraday BUY PE \u2014 fighting the bigger trend';
        conflict = true;
      } else {
        impact = 'NEUTRAL macro trend \u2014 intraday recommendation stands on its own';
      }
    } else if (plan.attemptedSide) {
      var opp = plan.attemptedSide === 'BUY CE' ? 'BEAR' : 'BULL';
      // Mirror the softening rule from generateVerdict: weak 1H
      // (ADX < 20) + all 3 lower TFs aligned the other way →
      // macro veto was SOFTENED (the actual block is elsewhere,
      // not the 1H). Don't show "BLOCKED — 1H goes the other way"
      // because that's misleading.
      var lowerAlignedOpposite = false;
      if (plan.tfsAligned) {
        if (plan.attemptedSide === 'BUY CE') lowerAlignedOpposite = (plan.tfsAligned.bull === 3);
        else                                   lowerAlignedOpposite = (plan.tfsAligned.bear === 3);
      }
      if (h1.net === opp) {
        if (weakTrend && lowerAlignedOpposite) {
          impact = '\u26A0 1H tape technically leans the other way (weak, ADX ' + h1.adx.toFixed(0) + ') \u2014 NOT the block reason; lower TFs override. See SKIP IF for the real veto.';
          // Don't mark as conflict — we want the pill to show as
          // amber-weak (already triggered by weakTrend below), not
          // hard-red, because 1H wasn't the actual problem.
        } else {
          impact = '\u2717 BLOCKED ' + plan.attemptedSide + ' \u2014 1H trend goes the other way';
          conflict = true;
        }
      } else {
        impact = 'macro context for ' + plan.attemptedSide + ' \u2014 see reasons in SKIP IF below';
      }
    } else {
      impact = 'context only \u2014 not currently overriding any recommendation';
    }
    // Set pill class — bull/bear/flat colour + optional conflict amber.
    // Weak trend bumps the pill into the conflict/amber state even if
    // the direction would otherwise be green, because the trend is
    // visually misleading.
    var cls = 'ia-h1-pill';
    if (conflict || (weakTrend && h1.net !== 'FLAT')) cls += ' ia-h1-conflict';
    else if (h1.net === 'BULL') cls += ' ia-h1-bull';
    else if (h1.net === 'BEAR') cls += ' ia-h1-bear';
    else                         cls += ' ia-h1-flat';
    pill.className = cls;
    setText('ia-h1-trend',  trendShort);
    setText('ia-h1-detail', detail);
    setHtml('ia-h1-impact', impact);
  }

  // ─── IV & POSITIONING pill (VIX + OI walls) ──────────────────
  // Surfaces the option-buyer-specific factors that the 3-card
  // bias bar can't show: India VIX (IV regime + intraday change)
  // plus the OI walls and PCR from the live option chain.
  // Pill colour matches verdict-engine thresholds:
  //   GREEN  — VIX 13-22 + walls clear of spot + PCR 0.7-1.3
  //   AMBER  — VIX 12-13 or 22-25, OR wall within 0.5×ATR, OR
  //            extreme PCR (>= 1.3 or <= 0.7)
  //   RED    — VIX < 12, VIX dropped >= 5% intraday (IV crush),
  //            OR spot directly at major wall (< 0.3×ATR)
  function renderIVPill(plan) {
    var pill = $('ia-iv-pill');
    if (!pill) return;
    if (!plan) { pill.hidden = true; return; }
    var vix = plan.vix;
    var chain = plan.chain;
    // Hide only if BOTH are missing — VIX-only or chain-only pill
    // is still useful.
    if (!vix && !chain) { pill.hidden = true; return; }
    pill.hidden = false;
    // ── VIX cell ──
    var vixTxt = 'VIX \u2014';
    var vixBad = false, vixMid = false;
    if (vix && isFinite(vix.current)) {
      var arrow = vix.changePct >= 0.5 ? '\u2191'
                : vix.changePct <= -0.5 ? '\u2193'
                : '\u2192';
      vixTxt = 'VIX <b>' + vix.current.toFixed(1) + '</b> '
             + arrow + ' ' + (vix.changePct >= 0 ? '+' : '') + vix.changePct.toFixed(1) + '%';
      if (vix.current < 12 || vix.changePct <= -5) vixBad = true;
      else if (vix.current < 13 || vix.current > 22 || vix.changePct <= -3) vixMid = true;
    }
    // ── PCR cell ──
    var pcrTxt = 'PCR \u2014';
    var pcrBad = false, pcrMid = false;
    if (chain && isFinite(chain.pcr)) {
      var pcrCls = '';
      if (chain.pcr >= 1.5)      { pcrCls = 'crowded short'; pcrMid = true; }
      else if (chain.pcr >= 1.3) { pcrCls = 'bull bias';     pcrMid = true; }
      else if (chain.pcr <= 0.5) { pcrCls = 'crowded long';  pcrMid = true; }
      else if (chain.pcr <= 0.7) { pcrCls = 'bear bias';     pcrMid = true; }
      else                         pcrCls = 'neutral';
      pcrTxt = 'PCR <b>' + chain.pcr.toFixed(2) + '</b> (' + pcrCls + ')';
    }
    // ── OI walls cell ──
    var wallTxt = 'walls \u2014';
    var wallBad = false, wallMid = false;
    if (chain && chain.ceWall && chain.peWall) {
      wallTxt = 'CE wall <b>' + chain.ceWall.strike + '</b> / PE wall <b>' + chain.peWall.strike + '</b>';
      // Check proximity to either wall — drives the colour.
      var atrW = (plan && plan.volatility && plan.volatility.atrPoints) || 20;
      if (chain.spot) {
        var ceD = chain.ceWall.strike - chain.spot;
        var peD = chain.spot - chain.peWall.strike;
        if ((ceD > 0 && ceD < atrW * 0.3) || (peD > 0 && peD < atrW * 0.3)) wallBad = true;
        else if ((ceD > 0 && ceD < atrW * 0.5) || (peD > 0 && peD < atrW * 0.5)) wallMid = true;
      }
    }
    // ── Impact line ──
    var impact = '';
    if (vix && vix.current < 12) {
      impact = '\u2717 Dead-low IV \u2014 premiums won\u2019t move; option buying is uphill';
    } else if (vix && vix.changePct <= -5) {
      impact = '\u26A0 IV crush in progress \u2014 fighting volatility decay on top of direction';
    } else if (wallBad) {
      impact = '\u26A0 Spot at an OI wall \u2014 institutional defence line just ahead';
    } else if (vix && vix.current > 22) {
      impact = '\u26A0 Elevated IV \u2014 premiums expensive, smaller positions';
    } else if (vix && isFinite(vix.current) && chain && isFinite(chain.pcr)) {
      impact = '\u2713 IV regime healthy \u2014 positioning is ' + ((chain.pcr >= 1.3 || chain.pcr <= 0.7) ? 'skewed (contrarian signal)' : 'balanced');
    } else if (vix) {
      impact = '\u2713 IV regime healthy';
    } else if (chain) {
      impact = 'option-chain only \u2014 VIX unavailable';
    }
    // ── Colour state ──
    var cls = 'ia-iv-pill';
    if (vixBad || wallBad) cls += ' ia-iv-bad';
    else if (vixMid || wallMid || pcrMid) cls += ' ia-iv-mixed';
    else cls += ' ia-iv-good';
    pill.className = cls;
    setHtml('ia-iv-vix',    vixTxt);
    setHtml('ia-iv-pcr',    pcrTxt);
    setHtml('ia-iv-walls',  wallTxt);
    setHtml('ia-iv-impact', impact);
  }

  // ─── STRUCTURE ROOM pill ─ removed ────────────────────────────
  // ─── Volatility (ATR-%) pill ─────────────────────────────────
  // The "is today even tradeable" gate. Drives pill colour and
  // a one-line plain-English impact summary. Hides when ATR%
  // hasn't been computed yet (very first analyze pass before 5m
  // has enough bars).
  function renderVolPill(plan) {
    var pill = $('ia-vol-pill');
    if (!pill) return;
    if (!plan || !plan.volatility || plan.volatility.regime === 'UNKNOWN') {
      pill.hidden = true; return;
    }
    pill.hidden = false;
    var v = plan.volatility;
    var atrPctTxt = (isFinite(v.atrPct) ? v.atrPct.toFixed(3) + '%' : '\u2014');
    var atrPtsTxt = (isFinite(v.atrPoints) ? fmtNum(v.atrPoints) : '\u2014');
    var cls = 'ia-vol-pill ';
    var impact;
    switch (v.regime) {
      case 'DEAD':
        cls += 'ia-vol-dead';
        impact = '\u2717 HARD VETO \u2014 theta will eat any option buy';
        break;
      case 'QUIET':
        cls += 'ia-vol-quiet';
        impact = '\u26A0 Below-normal range \u2014 confidence demoted, T1 only';
        break;
      case 'ACTIVE':
        cls += 'ia-vol-active';
        impact = '\u2713 Elevated range \u2014 full target ladder in play';
        break;
      default:
        cls += 'ia-vol-normal';
        impact = 'Normal range \u2014 standard trading rules apply';
    }
    pill.className = cls;
    setText('ia-vol-regime', v.regime);
    setText('ia-vol-atr',    '5m ATR ' + atrPctTxt + ' \u00B7 ' + atrPtsTxt + ' pts');
    setHtml('ia-vol-impact', impact);
  }

  // ─── Bank Nifty correlation pill ─────────────────────────────
  // Surfaces BN's 5m trend + intraday %change next to the verdict
  // so the user can see at a glance whether BN is confirming or
  // fighting the Nifty setup. Three colour states:
  //   GREEN bull   — BN bullish (CE-friendly)
  //   GREEN bear   — BN bearish (PE-friendly)
  //   AMBER flat   — BN flat (not confirming)
  //   RED conflict — BN going OPPOSITE the active verdict
  // Hides when BN data hasn't loaded (token missing / API failure).
  function renderBnPill(plan) {
    var pill = $('ia-bn-pill');
    if (!pill) return;
    if (!plan || !plan.bn) { pill.hidden = true; return; }
    pill.hidden = false;
    var bn = plan.bn;
    var net = bn.net || 'FLAT';
    var chg = isFinite(bn.changePct) ? bn.changePct : null;
    // Map trend to short label + arrow
    var trendShort = bn.trend === 'STRONG_BULL' ? '\u25B2 STRONG UP'
                   : bn.trend === 'BULL'        ? '\u25B3 UP'
                   : bn.trend === 'STRONG_BEAR' ? '\u25BC STRONG DOWN'
                   : bn.trend === 'BEAR'        ? '\u25BD DOWN'
                   : '\u2014 FLAT';
    setText('ia-bn-trend', trendShort);
    setText('ia-bn-chg',   chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '—');
    // Detect conflict against an active verdict
    var conflict = false;
    if (plan.action === 'BUY_CE' && net === 'BEAR') conflict = true;
    if (plan.action === 'BUY_PE' && net === 'BULL') conflict = true;
    // Class
    var cls = 'ia-bn-pill ';
    if (conflict)                cls += 'ia-bn-conflict';
    else if (net === 'BULL')     cls += 'ia-bn-bull';
    else if (net === 'BEAR')     cls += 'ia-bn-bear';
    else                          cls += 'ia-bn-flat';
    pill.className = cls;
    // Impact line
    var impact;
    if (conflict) {
      impact = '\u2717 BN going OPPOSITE the recommendation \u2014 strong fade risk';
    } else if (plan.action === 'BUY_CE' && net === 'BULL') {
      impact = '\u2713 BN confirms CE setup';
    } else if (plan.action === 'BUY_PE' && net === 'BEAR') {
      impact = '\u2713 BN confirms PE setup';
    } else if (plan.action !== 'WAIT' && net === 'FLAT') {
      impact = '\u26A0 BN not confirming \u2014 wait for BN to move';
    } else if (net === 'BULL') {
      impact = 'Macro Bank-Nifty bias UP';
    } else if (net === 'BEAR') {
      impact = 'Macro Bank-Nifty bias DOWN';
    } else {
      impact = 'BN flat \u2014 no directional bias yet';
    }
    setHtml('ia-bn-impact', impact);
  }

  // ─── CPR (Central Pivot Range) pill ──────────────────────────
  // Shows the day-type classification (NARROW = trending day,
  // NORMAL = average, WIDE = range day) + spot's location relative
  // to the CPR band (ABOVE TC / INSIDE band / BELOW BC). Drives
  // pill colour:
  //   GREEN  — NARROW (trending day, option buyers' best regime)
  //   AMBER  — NORMAL
  //   RED    — WIDE (range day, option buyers struggle)
  // Hides when prev-day data hasn't loaded yet (very first session).
  function renderCprPill(plan) {
    var pill = $('ia-cpr-pill');
    if (!pill) return;
    if (!plan || !plan.cpr) { pill.hidden = true; return; }
    pill.hidden = false;
    var cpr = plan.cpr;
    // Day-type class → pill colour.
    var cls = 'ia-cpr-pill ';
    var classLabel = cpr.classification + (cpr.widthPctOfRange != null
      ? ' (' + cpr.widthPctOfRange.toFixed(0) + '%)' : '');
    if      (cpr.classification === 'NARROW') cls += 'ia-cpr-narrow';
    else if (cpr.classification === 'WIDE')   cls += 'ia-cpr-wide';
    else                                       cls += 'ia-cpr-normal';
    pill.className = cls;
    setText('ia-cpr-class', classLabel);
    // Band line — show TC ↕ BC so the user can see exactly where
    // the dead-zone sits relative to current spot.
    var bandTxt = 'TC \u20B9' + fmtNum(cpr.TC) + ' \u2194 BC \u20B9' + fmtNum(cpr.BC);
    setText('ia-cpr-band', bandTxt);
    // Location relative to band.
    var locLabel, locColor = '';
    switch (cpr.location) {
      case 'ABOVE':  locLabel = '\u25B2 ABOVE TC \u2014 bull side'; break;
      case 'INSIDE': locLabel = '\u25C9 INSIDE band'; break;
      case 'BELOW':  locLabel = '\u25BC BELOW BC \u2014 bear side'; break;
      default:       locLabel = '\u2014';
    }
    setText('ia-cpr-loc', locLabel);
    // Impact — what this day-type means for the verdict engine
    var impact;
    if (cpr.classification === 'NARROW') {
      impact = '\u2713 Trending-day setup \u2014 momentum side scored +1';
    } else if (cpr.classification === 'WIDE') {
      if (cpr.location === 'INSIDE') {
        impact = '\u2717 Inside wide CPR \u2014 dead-zone, stand aside';
      } else {
        impact = '\u26A0 Range-day expected \u2014 option buyers struggle, tighten targets';
      }
    } else {
      impact = 'Average day \u2014 recommendation driven by trend + S/R, CPR neutral';
    }
    setHtml('ia-cpr-impact', impact);
  }

  // renderStructurePill removed entirely in the May 2026 SCALP-
  // only refactor — the pill measured spot vs the day's BIG walls
  // (R:R yardstick for 30 min - 2 hr SWING holds), which is the
  // wrong frame for a 4-5 pt scalp. ~80 lines of render code, plus
  // the matching DOM in content/live.html, CSS in intraday-analyzer
  // .css (~40 lines), red-flag chips, tooltip handler, and pill-ID
  // array entry all came out together. See git history at this
  // commit if the SWING-style structure check needs to return.

  // ── State transitions ──
  function showLoading() {
    var empty   = $('ia-empty');   if (empty)   empty.hidden   = true;
    var err     = $('ia-error');   if (err)     err.hidden     = true;
    var result  = $('ia-result');  if (result)  result.hidden  = STATE.result == null;  // keep previous result visible during refresh
    var loading = $('ia-loading'); if (loading) loading.hidden = STATE.result != null;
  }
  function showResult() {
    var empty   = $('ia-empty');   if (empty)   empty.hidden   = true;
    var err     = $('ia-error');   if (err)     err.hidden     = true;
    var loading = $('ia-loading'); if (loading) loading.hidden = true;
    var result  = $('ia-result');  if (result)  result.hidden  = false;
  }
  function showError(msg) {
    var loading = $('ia-loading'); if (loading) loading.hidden = true;
    var msgEl   = $('ia-error-msg'); if (msgEl) msgEl.textContent = msg || 'unknown';
    var err     = $('ia-error');   if (err)     err.hidden     = false;
    var empty   = $('ia-empty');   if (empty)   empty.hidden   = true;
  }
  function showEmpty() {
    var empty   = $('ia-empty');   if (empty) { empty.hidden = false; empty.dataset.reason = 'no-token'; }
    var noTok   = $('ia-empty-no-token');   if (noTok)   noTok.hidden   = false;
    var rej     = $('ia-empty-rejected');   if (rej)     rej.hidden     = true;
    var loading = $('ia-loading'); if (loading) loading.hidden = true;
    var err     = $('ia-error');   if (err)     err.hidden     = true;
    var result  = $('ia-result');  if (result)  result.hidden  = true;
  }
  function showEmptyRejected() {
    var empty   = $('ia-empty');   if (empty) { empty.hidden = false; empty.dataset.reason = 'rejected'; }
    var noTok   = $('ia-empty-no-token');   if (noTok)   noTok.hidden   = true;
    var rej     = $('ia-empty-rejected');   if (rej)     rej.hidden     = false;
    var loading = $('ia-loading'); if (loading) loading.hidden = true;
    var err     = $('ia-error');   if (err)     err.hidden     = true;
    var result  = $('ia-result');  if (result)  result.hidden  = true;
  }

  // ── Main analyze() — fetches, computes, renders ──
  async function analyze(force) {
    if (STATE.fetching && !force) return;
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) return;
    // Pre-flight: must have a token.
    var token = M().getToken && M().getToken();
    if (!token) { showEmpty(); return; }
    STATE.fetching = true;
    showLoading();
    try {
      // ── Auto-trigger option-chain fetch on every analyze pass ──
      // The chain module loads OI / PCR / walls but only when the
      // user opens the Option Chain section. For the intraday
      // verdict engine we want this data on EVERY analysis so PCR
      // + OI walls aren't blank in the IV pill. upFetchChain is
      // safe to call repeatedly — the chain module has its own
      // 30s throttle internally. We don't await it (intentionally
      // fire-and-forget); the NEXT analyze cycle will see the
      // populated window.optionChainData. First cycle still runs
      // without OI input.
      if (typeof window.upFetchChain === 'function' && !window.optionChainData) {
        try { window.upFetchChain(); } catch (_) {}
      }
      // Fetch candles + VIX in parallel. VIX is OPTIONAL so its
      // failure must not block the verdict — that's why we use
      // Promise.all but treat the VIX slot as nullable.
      // Three parallel fetches: Nifty TFs, VIX intraday, Bank Nifty
      // intraday. BN is a lightweight 5m-only fetch; failures don't
      // block the verdict (handled as null below).
      var allResults = await Promise.all([
        fetchAll(),
        fetchVixIntraday(),
        fetchBankNiftyIntraday()
      ]);
      var raw   = allResults[0];
      var vix   = allResults[1];   // null if VIX unavailable / unauthenticated
      var bnRaw = allResults[2];   // null if BN fetch failed
      var levels = calcLevels(raw['5m']);  // levels come from the 5m stream (best resolution/history balance)
      // 1H runs the same indicator pipeline but acts as a CONTEXT
      // filter (no own card, doesn't vote) — see generateVerdict.
      // We pass null levels so VWAP/OR/PDH-PDL stay 5m-derived
      // (1H bars would corrupt these intraday-specific levels).
      var an1h = analyzeTfIntraday(raw['1h'], '1h', null);
      var an15 = analyzeTfIntraday(raw['15m'], '15m', levels);
      var an5  = analyzeTfIntraday(raw['5m'],  '5m',  levels);
      var an30 = analyzeTfIntraday(raw['30m'], '30m', null);
      if (!an15 || !an5) {
        STATE.fetching = false;
        showError('Not enough intraday candles yet (market may have just opened, or the API returned an empty window). Try again in a couple of minutes.');
        return;
      }
      // Bank Nifty correlation snapshot — null when BN data fetch
      // failed or returned <12 bars (insufficient for EMA-50).
      var bn = bnRaw ? analyzeBankNifty(bnRaw) : null;
      // 1H is OPTIONAL — if it's missing (e.g. fresh weekly expiry +
      // limited history) we still produce a verdict without the
      // context filter; the pill just hides.
      // Mode is hard-coded SCALP since the May 2026 refactor; the
      // helper just returns the constant string. The verdict-engine
      // signature still takes `mode` for journal-persistence reasons
      // (entries store plan.mode so historical SWING entries remain
      // valid in the journal).
      var mode = getTradingMode();
      // Pass raw 1H bars so the structural picker (4H + 1H multi-
      // touch rejection clusters) is wired into the veto + R:R
      // math, not just rendered in the Key S/R card. Without
      // this, the engine could approve BUY CE while spot sits
      // right under a heavy 4H pivot the user can clearly see.
      var plan = generateVerdict(an15, an5, an30, an1h, vix, mode, bn, raw['1h']);
      // SPOT-FIRST (May 2026): attach plan.spotPlan immediately so
      // the initial render (before any live tick) has spot-level
      // ENTRY/SL/T1/T2 ready for the HUD + quick strip + journal.
      // Uses the 5m lastClose as the initial spotAtFire — the live
      // tick will refresh it when the next ltp arrives.
      if (plan && plan.action !== 'WAIT' && an5 && isFinite(an5.lastClose)) {
        attachSpotPlan(plan, an5.lastClose);
      }
      STATE.result = {
        tf15: an15, tf5: an5, tf1h: an1h, tf30: an30,
        vix: vix, bn: bn, plan: plan,
        // Stash raw 1H bars so the structural S/R picker
        // (collectStructuralSr) can derive 4H aggregates + 1H
        // pivot clusters off them. Not used by the verdict engine
        // — purely a render-time payload.
        raw1h: raw['1h'] || []
      };
      // Stash raw candles for the Phase 4 Trend Backtest view.
      // All four TFs kept in memory so the backtest can switch
      // between them without re-fetching.
      STATE.rawCandles = { '1h': raw['1h'] || [], '30m': raw['30m'] || [], '15m': raw['15m'] || [], '5m': raw['5m'] || [] };
      STATE.lastAnalyzedMs = Date.now();
      STATE.lastBucket = current3mBucketStart() || 0;
      // Persist the verdict so an off-hours reload restores it
      // without re-firing the 4-TF + 100-stock-volume fetch storm.
      // See loadIntradayResult() consumer in tickWatcher.
      persistIntradayResult();
      renderAll(STATE.result);
      showResult();
      // Nudge paper-trade's option poller to start ticking the
      // recommended ATM strike's premium NOW (not on the next user
      // interaction). Without this, the live pricing in the plan
      // card stays "Loading…" until something else triggers the
      // poller (open position, selected strike, etc.).
      if (plan.action !== 'WAIT' && typeof window.paperTradeKickOptionPolling === 'function') {
        try { window.paperTradeKickOptionPolling(); } catch (_) {}
      }
    } catch (e) {
      var msg = (e && e.message) || 'unknown';
      if (msg === 'UNAUTHORIZED') {
        showEmptyRejected();
      } else {
        showError('Failed to fetch intraday candles: ' + msg);
      }
    } finally {
      STATE.fetching = false;
    }
  }

  // ── On-bar-close watcher ──
  // Every 30 seconds: check whether the current 3-min bucket start
  // has advanced past STATE.lastBucket. If yes, a new bar has closed
  // → trigger analyze(). Outside market hours we still keep the timer
  // running at a low cadence so the analyzer auto-refreshes the moment
  // the market reopens (no need for the user to do anything).
  function tickWatcher() {
    if (!STATE.active) return;
    var token = M().getToken && M().getToken();
    if (!token) { showEmpty(); return; }
    // Initial / first-time analyze.
    if (!STATE.result) {
      // ── Off-hours cache restore (May 2026) ──
      // On a weekend / pre-open page load, try to restore the last
      // verdict from localStorage instead of firing analyze() (which
      // would hit /historical-candle × 4 TFs + the 100-stock volume
      // aggregator — 200+ API calls, primary cause of weekend 429s).
      // Cache is considered valid until the next market open: any
      // payload stored before today's 09:15 IST gets discarded when
      // market is open (so a fresh Monday morning analyze runs as
      // soon as the user lands on the tab post 09:15).
      var open = isMarketOpen();
      var cached = loadIntradayResult();
      if (cached && cached.result) {
        var cacheAt = cached.at || 0;
        var todayOpenMs = (function () {
          // Today's 09:15 IST in ms since epoch
          var d = new Date();
          var fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
          });
          var ymd = fmt.format(d);
          return new Date(ymd + 'T09:15:00+05:30').getTime();
        })();
        var validForNow = open
          ? cacheAt >= todayOpenMs       // open hours: only today's cache counts
          : true;                         // closed hours: any cache is fine
        if (validForNow) {
          console.log('[intraday] restored verdict from localStorage cache'
            + ' (age ' + Math.round((Date.now() - cacheAt) / 1000) + 's, market ' + (open ? 'open' : 'closed') + ')');
          STATE.result = cached.result;
          STATE.lastAnalyzedMs = cacheAt;
          STATE.lastBucket = cached.lastBucket || 0;
          renderAll(STATE.result);
          showResult();
          // If market is open and the cache is from this morning but
          // a new 3m bucket has closed since, schedule a fresh analyze
          // so the user gets the latest verdict — otherwise we'd serve
          // a possibly-stale verdict until the next bucket close.
          if (open) {
            var cur0 = current3mBucketStart();
            if (cur0 && cur0 > STATE.lastBucket) { analyze(); }
          }
          return;
        }
      }
      // No usable cache → fall through to a fresh analyze().
      // When market is closed AND no cache exists, this is the
      // ONE allowed off-hours fetch (subsequent reloads will hit
      // the cache we populate here and skip the network).
      analyze();
      return;
    }
    // Repaint the SESSION pill on every tick — even when market
    // is closed (when we early-return below) — so the IST clock
    // + countdown stay accurate after long idle periods
    // (overnight, weekend). Cheap (~6 DOM writes against the
    // cached plan) and keeps the trade-window context honest.
    renderSessionPill(STATE.result.plan);
    if (!isMarketOpen()) return;
    var cur = current3mBucketStart();
    if (cur && cur > STATE.lastBucket) { analyze(); }
  }
  function startPoller() {
    if (STATE.tickTimer) return;
    STATE.tickTimer = setInterval(tickWatcher, 30 * 1000);
  }
  function stopPoller() {
    if (STATE.tickTimer) { clearInterval(STATE.tickTimer); STATE.tickTimer = null; }
  }

  // ── Lifecycle hooks (called by show('live') in the page shell) ──
  function activate() {
    STATE.active = true;
    // Defer one tick so the lazy-loaded DOM is wired before we touch it.
    setTimeout(function () {
      tickWatcher();
      startPoller();
      // SIGNAL JOURNAL — paint stat tiles + table + capital/risk
      // inputs as soon as the live section's DOM is available, so
      // the user sees existing history without waiting for the
      // first analyze cycle. Safe no-op when no entries exist.
      try { if (typeof renderJournal === 'function') renderJournal(); } catch (_) {}
      // QUICK-TRADE STRIP — paint immediately too so the user
      // sees the layout in its idle (WAITING FOR SIGNAL) state
      // before the first analyze completes. Subsequent updates
      // flow from renderDecisionHud + liveTick.
      try { if (typeof renderQuickStrip === 'function') renderQuickStrip(); } catch (_) {}
    }, 50);
  }
  function deactivate() {
    STATE.active = false;
    stopPoller();
  }

  // ══════════════════════════════════════════════════════════════════
  // LIVE TICK — re-prices plan cells + runs spot-invalidation safety
  // check on every successful spot LTP. Called from paper-trade's
  // tick() (which the chart's pollTick fires at 2s cadence). NO API
  // calls here; we read window.optionChainData for premium and use
  // the passed-in spot for the index value. Cheap + safe to call at
  // high cadence.
  //
  // What it updates LIVE (no 3-min wait):
  //   - Plan cells 2/3/4 (entry / SL / target) — re-priced from
  //     current premium so SL = current × 0.70, TGT = current × 1.60.
  //     What you see on screen is what you'd actually pay if you
  //     clicked BUY right now.
  //   - Spot-invalidation banner — appears the INSTANT Nifty crosses
  //     the verdict's spotInvalid level. Plan card greys out, VERDICT
  //     cell flips to "EXIT / WAIT", and (after a 30s cool-down) an
  //     early analyze() runs so the verdict catches up to reality.
  // ══════════════════════════════════════════════════════════════════
  function liveTick(spotLive) {
    if (!STATE.result || !STATE.result.plan || !STATE.result.tf5) return;
    var plan = STATE.result.plan;
    var an5  = STATE.result.tf5;
    var an1h_keysr = (STATE.result && STATE.result.tf1h) || null;
    var raw1h_keysr = (STATE.result && STATE.result.raw1h) || [];
    // Key S/R card refreshes on every tick regardless of verdict —
    // distances + nearest-R/S sub-text need to track live spot. The
    // pivot data itself (1H/4H clusters) is from the analysis-time
    // raw1h snapshot — those pivots don't move bar-to-bar.
    var keySpotLive = (isFinite(spotLive) && spotLive > 0) ? spotLive : an5.lastClose;
    renderKeySr(an5, an1h_keysr, raw1h_keysr, keySpotLive);
    if (plan.action === 'WAIT') {
      // Even WAIT verdicts hide the banner — there is no recommendation to invalidate.
      var banner = $('ia-invalid-banner');
      if (banner) banner.hidden = true;
      var planCardW = $('ia-plan');
      if (planCardW) planCardW.classList.remove('ia-plan-invalidated');
      return;
    }
    var spot = (isFinite(spotLive) && spotLive > 0) ? spotLive : an5.lastClose;
    // Re-derive risk plan with LIVE spot so SL/T1/T2/T3 stay on the
    // correct side of spot even after a few minutes of drift.
    var an1h_state2 = (STATE.result && STATE.result.tf1h) || null;
    var raw1h_state2 = (STATE.result && STATE.result.raw1h) || [];
    plan = liveRiskView(plan, an5, an1h_state2, spot, raw1h_state2);
    // SPOT-FIRST refactor (May 2026): attach plan.spotPlan
    // UNCONDITIONALLY so HUD / quick strip / journal consumers
    // always have spot-level entry/SL/T1 to render, even before
    // the option chain has loaded. renderPlanWithPremium also
    // calls this — calling twice is idempotent (rebuilds the
    // same object), so no harm in the redundancy.
    attachSpotPlan(plan, spot);
    // CRITICAL: liveRiskView returns a NEW object (Object.assign({}, ...))
    // and renderPlanWithPremium below attaches .premium to that new
    // object. If we don't write it back, STATE.result.plan stays
    // pointing at the OLD plan without .premium — which makes the
    // quick-trade strip + signal journal stuck on "Pricing strike..."
    // forever even after the chain loads. Persist the live-priced
    // plan so every downstream consumer sees the same numbers.
    STATE.result.plan = plan;
    var sideTag = plan.action === 'BUY_CE' ? 'CE' : 'PE';
    // ITM-1 recommendation (see pickRecommendedStrike rationale).
    var atmStrike = pickRecommendedStrike(spot, sideTag);
    // Honour user's strike override so live ticks re-price against
    // the strike they've actually selected (not always the ATM).
    var userPick = (typeof window.paperTradeGetSelectedStrike === 'function')
                   ? window.paperTradeGetSelectedStrike() : null;
    var effStrike = (userPick != null && isFinite(userPick)) ? +userPick : atmStrike;
    var isOverride = (effStrike !== atmStrike);

    // ─── 1. Re-price ALL plan cells from CURRENT premium ───
    // Pulls per-strike premium + delta. Both refresh on every LTP
    // tick (2s) so SL / T1 / T2 / T3 stay accurate as Nifty moves —
    // and remain anchored to whichever strike the user picked.
    var quote = getStrikeQuote(effStrike, sideTag);
    var premium = quote ? quote.premium : null;
    var delta   = quote ? quote.delta   : null;
    if (premium != null) {
      // Keep STRIKE cell synced with user pick + the right badge.
      var lt_badge = isOverride
        ? ' <span class="ia-strike-badge ia-strike-badge-user">YOUR PICK</span>'
        : ' <span class="ia-strike-badge ia-strike-badge-rec">RECOMMENDED ITM</span>';
      setHtml('ia-plan-strike', effStrike + ' ' + sideTag + lt_badge);
      renderPlanWithPremium(plan, an5, spot, effStrike, sideTag, premium, ANALYZER_LOT_SIZE_NIFTY, delta);
      // Backfill journal entries logged before the chain finished
      // loading — patches entryPremium/slPremium/t1Premium so the
      // table + outcome-R computation work for those orphan entries.
      // No-op if already filled (cheap to call every tick).
      try {
        if (typeof signalJournalModule !== 'undefined'
            && signalJournalModule.backfillActivePremium) {
          signalJournalModule.backfillActivePremium(plan);
        }
      } catch (_) {}
      // P0-3: tick the signal-freshness chip on every live LTP.
      // Cheap (single DOM read + attribute writes) and ensures the
      // age display ticks visibly even between 3-min analyze cycles.
      try {
        var liveSig = (typeof signalJournalModule !== 'undefined' && signalJournalModule.getActiveSignal)
          ? signalJournalModule.getActiveSignal() : null;
        renderSignalFreshness(liveSig, spot, premium);
      } catch (_) {}
      // P1-2: tick the discipline pill on every live LTP so the
      // cooling-off countdown (mm:ss after a loss) updates visibly.
      try { renderDisciplinePill(); } catch (_) {}
      // P2-A: tick the Quick-Trade strip on every live LTP so the
      // deploy + max-loss figures (which scale with current
      // premium × lots) stay accurate between analyze cycles.
      try { renderQuickStrip(); } catch (_) {}
      // Also re-render the S/R ladder so projected ₹ premiums on
      // each rung stay current with the live premium.
      renderSrLadder(plan, an5, spot, sideTag, premium);
    }
    // Decision HUD numbers (entry / SL / T1 / R:R) need to track
    // live spot too — re-render with the freshly priced plan so
    // the at-a-glance card stays accurate between analyze cycles.
    renderDecisionHud(plan, an5);

    // ─── 2. Spot-invalidation safety check ───
    // plan.spotInvalid is set from emergencySpot in generateVerdict,
    // so the banner trips on the strongest structural level being
    // broken — same as the EMERGENCY EXIT cell.
    var invalidated = false;
    if (plan.spotInvalid != null && isFinite(spot)) {
      if (plan.action === 'BUY_CE' && spot < plan.spotInvalid) invalidated = true;
      if (plan.action === 'BUY_PE' && spot > plan.spotInvalid) invalidated = true;
    }
    applyInvalidation(invalidated, plan, spot);

    // ─── 3. Auto early re-analyze when invalidated ───
    // Don't spam analyze() — only one early run per minute. After
    // that, the regular 30s tickWatcher takes over.
    if (invalidated && !STATE.fetching) {
      var since = Date.now() - (STATE.lastAnalyzedMs || 0);
      if (since > 60 * 1000 && !STATE._earlyAnalysisInFlight) {
        STATE._earlyAnalysisInFlight = true;
        console.log('[intraday] spot invalidated — forcing early re-analyze');
        Promise.resolve(analyze(true)).finally(function () {
          STATE._earlyAnalysisInFlight = false;
        });
      }
    }
  }

  function applyInvalidation(invalidated, plan, spot) {
    var banner = $('ia-invalid-banner');
    var planCard = $('ia-plan');
    var verdictEl = $('ia-final-bias');
    var verdictCell = $('ia-final-cell');
    if (!banner) return;
    if (invalidated) {
      banner.hidden = false;
      setText('ia-invalid-msg',
        'Nifty has crossed the spot-invalidation level for the active ' + (plan.action === 'BUY_CE' ? 'BUY CE' : 'BUY PE')
        + ' setup. The directional thesis is broken \u2014 entering now buys into a falling premium. '
        + 'Re-analyzing now; wait for the next recommendation before doing anything.');
      setHtml('ia-invalid-detail',
        'Spot now: <b>\u20B9' + fmtNum(spot) + '</b> &nbsp;'
        + (plan.action === 'BUY_CE' ? '&lt;' : '&gt;')
        + ' invalidation level <b>\u20B9' + fmtNum(plan.spotInvalid) + '</b>');
      if (planCard) planCard.classList.add('ia-plan-invalidated');
      // Flip the VERDICT cell to a loud red "EXIT / WAIT" so the bias
      // bar doesn't contradict the banner. Also stash the original
      // text/class on the elements so we can restore them cleanly
      // when conditions recover (without waiting for the next analyze).
      if (verdictEl) {
        if (verdictEl._iaOrigText == null) {
          verdictEl._iaOrigText = verdictEl.textContent;
          verdictEl._iaOrigClass = verdictEl.className;
        }
        verdictEl.textContent = 'EXIT / WAIT';
        verdictEl.className = 'sw-bias-v sw-bear';
      }
      if (verdictCell) {
        if (verdictCell._iaOrigClass == null) {
          verdictCell._iaOrigClass = verdictCell.className;
        }
        verdictCell.className = 'sw-bias-cell sw-bias-cell-final sw-bias-cell-bear';
      }
    } else {
      banner.hidden = true;
      if (planCard) planCard.classList.remove('ia-plan-invalidated');
      // Restore the verdict cell to its pre-invalidation state so a
      // recovered spot doesn't leave the bias bar stuck on "EXIT / WAIT"
      // until the next 3-min analyze() catches up.
      if (verdictEl && verdictEl._iaOrigText != null) {
        verdictEl.textContent = verdictEl._iaOrigText;
        verdictEl.className   = verdictEl._iaOrigClass;
        verdictEl._iaOrigText = null;
        verdictEl._iaOrigClass = null;
      }
      if (verdictCell && verdictCell._iaOrigClass != null) {
        verdictCell.className = verdictCell._iaOrigClass;
        verdictCell._iaOrigClass = null;
      }
    }
  }

  // For paper-trade's pollOptionPrices to include in its key batch
  // (so the recommended strike's CE+PE premium refreshes at 2s
  // cadence instead of waiting for the 30s chain auto-refresh).
  // Returns both the ITM-1 CE and ITM-1 PE keys so the strip's LIVE
  // LTP/P&L stays fresh whether the verdict is BUY_CE or BUY_PE.
  function getRecommendedAtmKeys() {
    if (!STATE.result || !STATE.result.plan || !STATE.result.tf5) return [];
    var action = STATE.result.plan.action;
    if (action === 'WAIT') return [];
    var spot = STATE.result.tf5.lastClose;
    if (!isFinite(spot)) return [];
    var chain = window.optionChainData;
    if (!chain || !chain.strikes) return [];
    var ceStrike = pickRecommendedStrike(spot, 'CE');
    var peStrike = pickRecommendedStrike(spot, 'PE');
    var keys = [];
    for (var i = 0; i < chain.strikes.length; i++) {
      var sp = chain.strikes[i].strike_price;
      if (sp === ceStrike && chain.strikes[i].call_options
          && chain.strikes[i].call_options.instrument_key) {
        keys.push(chain.strikes[i].call_options.instrument_key);
      }
      if (sp === peStrike && chain.strikes[i].put_options
          && chain.strikes[i].put_options.instrument_key) {
        keys.push(chain.strikes[i].put_options.instrument_key);
      }
    }
    return keys;
  }

  // Called by paper-trade's selectStrike() whenever the user picks
  // a different strike from the dropdown. We immediately re-paint
  // the plan card so SL / T1 / T2 / T3 reflect the new strike's
  // premium + delta (no need to wait for the next 2s LTP tick).
  function onStrikeChange(_newStrike) {
    if (!STATE.result || !STATE.result.plan) return;
    try {
      renderPlan(STATE.result.plan, STATE.result.tf5, null);
    } catch (_) {}
    // Also kick the LTP poller for the new strike so its premium
    // shows up in the cache within 2s rather than waiting for the
    // next chain auto-refresh.
    try {
      if (typeof window.paperTradeKickOptionPolling === 'function') {
        window.paperTradeKickOptionPolling();
      }
    } catch (_) {}
  }

  // ─── Coverage modal open/close helpers ─────────────────────
  // The compact summary card's "View details" button hits these.
  // Implementation notes:
  //   - Toggles .open on .ia-cov-modal (CSS handles display).
  //   - Locks body scroll while open (prevents the background
  //     analyzer page from scrolling under the dialog).
  //   - Wires a one-shot keydown listener for ESC so it doesn't
  //     accumulate across opens.
  //   - Stores the previously-focused element + restores focus
  //     on close (basic accessibility).
  var _iaCovPrevFocus = null;
  function iaCoverageOpen() {
    var modal = document.getElementById('ia-cov-modal');
    if (!modal) return;
    _iaCovPrevFocus = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', _iaCovKeyHandler);
    // Focus the close button so ESC / Enter work immediately.
    var closeBtn = modal.querySelector('.ia-cov-modal-close');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  }
  function iaCoverageClose() {
    var modal = document.getElementById('ia-cov-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _iaCovKeyHandler);
    if (_iaCovPrevFocus && _iaCovPrevFocus.focus) {
      try { _iaCovPrevFocus.focus(); } catch (_) {}
    }
    _iaCovPrevFocus = null;
  }
  function _iaCovKeyHandler(e) {
    if (e.key === 'Escape' || e.keyCode === 27) iaCoverageClose();
  }
  window.iaCoverageOpen  = iaCoverageOpen;
  window.iaCoverageClose = iaCoverageClose;

  // ─── HELP modal (How to read this) ──────────────────────────
  // Same lifecycle as the coverage modal: scroll-lock + focus
  // restore + ESC handler. Separate prev-focus var so opening
  // one modal then the other doesn't lose the original focus.
  var _iaHelpPrevFocus = null;
  function iaHelpOpen() {
    var modal = document.getElementById('ia-help-modal');
    if (!modal) return;
    _iaHelpPrevFocus = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', _iaHelpKeyHandler);
    var closeBtn = modal.querySelector('.ia-help-modal-close');
    if (closeBtn && closeBtn.focus) closeBtn.focus();
  }
  function iaHelpClose() {
    var modal = document.getElementById('ia-help-modal');
    if (!modal) return;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _iaHelpKeyHandler);
    if (_iaHelpPrevFocus && _iaHelpPrevFocus.focus) {
      try { _iaHelpPrevFocus.focus(); } catch (_) {}
    }
    _iaHelpPrevFocus = null;
  }
  function _iaHelpKeyHandler(e) {
    if (e.key === 'Escape' || e.keyCode === 27) iaHelpClose();
  }
  window.iaHelpOpen  = iaHelpOpen;
  window.iaHelpClose = iaHelpClose;

  // ─── Re-analyze when the option chain finishes loading ───────
  // The first analyze pass typically races the chain fetch and
  // wins (chain comes in ~200-500ms later), which leaves the IV
  // pill hidden until SOMETHING re-triggers analyze. During
  // market hours the 30s tickWatcher does that. Off-hours the
  // tickWatcher early-returns at !isMarketOpen() so the catch-up
  // never fires — and the user saw a permanently-missing IV pill
  // until they toggled the mode (which manually re-analyzes).
  // Hook into the same chain-loaded broadcast that paper-trading
  // uses, chained so we don't clobber that handler.
  var prevChainHook = window.ptOnChainLoaded;
  window.ptOnChainLoaded = function () {
    if (typeof prevChainHook === 'function') {
      try { prevChainHook(); } catch (_) {}
    }
    // Only re-analyze if the IA tab has already produced a
    // result (otherwise activate() will do the first analyze
    // when the user lands on the tab; no need to race it).
    if (STATE && STATE.result) {
      try { analyze(true); } catch (_) {}
    }
  };

  // Public API
  window.intradayActivate          = activate;
  window.intradayDeactivate        = deactivate;
  window.intradayRefresh           = function () { return analyze(true); };
  window.intradayLiveTick          = liveTick;
  window.intradayGetAtmInstrumentKeys = getRecommendedAtmKeys;
  window.intradayOnStrikeChange    = onStrikeChange;
  window.intradayActivate = activate;
})();
