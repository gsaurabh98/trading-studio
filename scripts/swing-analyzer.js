// Swing-trade analyzer — stock-universe loader, indicator-math library
// (ADX / Supertrend / Stochastic / OBV / candle patterns / zigzag / fib),
// per-TF analysis, trade-plan generator, stock picker, sector + fib scanner,
// renderers, and the swing live chart. ONE module-level IIFE (swingModule);
// ~70 window.* exposures + ~170 closure-private helpers share its scope, so
// it is NOT internally splittable without rewriting signal logic — extracted
// whole (over the 1K cap by necessity; see AGENTS.md §18).
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split). Loaded via a plain <script src> in the SAME
// document position (classic script), so window.swing* / fibScan* / swSector*
// and the rest stay global for the inline handlers in content/swing.html,
// with unchanged init timing. Cross-module refs are call-time only.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

(function swingModule() {

  // ── Pure indicator-math (TA) library was extracted to
  //    scripts/indicator-math.js on 2026-06-05 (AGENTS.md §18). It loads
  //    BEFORE this module (shell <script defer> order + backtest lib.mjs),
  //    so window.IndicatorMath is always defined here. Re-bind every public
  //    name as a closure-local alias so the existing bare call sites
  //    (analyzeTf, generatePlan, the _tfMath / __swingExports bags, scan
  //    verdicts, …) keep working UNCHANGED — behaviour-preserving move, no
  //    signal-logic rewrite (trading-context rule).
  var _IM = window.IndicatorMath || {};
  var ema = _IM.ema, sma = _IM.sma, rsi = _IM.rsi, macd = _IM.macd, atr = _IM.atr, emReturnSigma = _IM.emReturnSigma, emBand = _IM.emBand, EM_HORIZONS_BY_TF = _IM.EM_HORIZONS_BY_TF, swingHighs = _IM.swingHighs, swingLows = _IM.swingLows, istDateKeyLocal = _IM.istDateKeyLocal, medianOfArr = _IM.medianOfArr, ATR_MEDIAN_BARS_BY_TF = _IM.ATR_MEDIAN_BARS_BY_TF, getMedian20dATR = _IM.getMedian20dATR, cappedAtrValue = _IM.cappedAtrValue, cappedAtrSeries = _IM.cappedAtrSeries, istDateKeyForTs = _IM.istDateKeyForTs, dropGapBars = _IM.dropGapBars, _zigzagFrom = _IM._zigzagFrom, classifyStructure = _IM.classifyStructure, TREND_PARAMS_BY_TF = _IM.TREND_PARAMS_BY_TF, adx = _IM.adx, supertrend = _IM.supertrend, stochastic = _IM.stochastic, obv = _IM.obv, candleParts = _IM.candleParts, isBullishEngulfing = _IM.isBullishEngulfing, isBearishEngulfing = _IM.isBearishEngulfing, isHammer = _IM.isHammer, isInvertedHammer = _IM.isInvertedHammer, isShootingStar = _IM.isShootingStar, isDoji = _IM.isDoji, isDragonflyDoji = _IM.isDragonflyDoji, isGravestoneDoji = _IM.isGravestoneDoji, isNeutralDoji = _IM.isNeutralDoji, isBullishMarubozu = _IM.isBullishMarubozu, isBearishMarubozu = _IM.isBearishMarubozu, isPiercing = _IM.isPiercing, isDarkCloudCover = _IM.isDarkCloudCover, isBullishHarami = _IM.isBullishHarami, isBearishHarami = _IM.isBearishHarami, isTweezerBottom = _IM.isTweezerBottom, isTweezerTop = _IM.isTweezerTop, isMorningStar = _IM.isMorningStar, isEveningStar = _IM.isEveningStar, isMorningDojiStar = _IM.isMorningDojiStar, isEveningDojiStar = _IM.isEveningDojiStar, isThreeWhiteSoldiers = _IM.isThreeWhiteSoldiers, isThreeBlackCrows = _IM.isThreeBlackCrows, isInsideBar = _IM.isInsideBar, isNR4 = _IM.isNR4, detectPatterns = _IM.detectPatterns, detectLookbackPattern = _IM.detectLookbackPattern;
  function $(id) { return document.getElementById(id); }

  // ── Routing: mirror the chart / chain modules so CORS-restricted
  //    environments (file://, public origins) flow through the
  //    Cloudflare worker / localhost proxy instead of failing.
  var BASE_V3 = (function () {
    try {
      var cfUrl = (localStorage.getItem('cf_worker_url') || '').trim().replace(/\/+$/, '');
      if (cfUrl) return cfUrl + '/api/v3';
      var h = (location.hostname || '').toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return '/api/v3';
    } catch (_) { /* fall through */ }
    return 'https://api.upstox.com/v3';
  })();
  var BASE_V2 = (function () {
    try {
      var cfUrl = (localStorage.getItem('cf_worker_url') || '').trim().replace(/\/+$/, '');
      if (cfUrl) return cfUrl + '/api/v2';
      var h = (location.hostname || '').toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return '/api/v2';
    } catch (_) { /* fall through */ }
    return 'https://api.upstox.com/v2';
  })();

  function getToken() {
    try { return (localStorage.getItem('upstox_token') || '').trim(); }
    catch (_) { return ''; }
  }

  function fmtDate(d) {
    var ist = new Date(d.getTime() + 19800000);
    var y = ist.getUTCFullYear(), m = String(ist.getUTCMonth() + 1).padStart(2, '0'), dd = String(ist.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function fmtPrice(n) {
    if (!isFinite(n)) return '—';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  }

  // Expected-move band formatter — keeps sub-₹100 moves to 1 decimal so a
  // small ₹6.4 daily cone doesn't collapse to a misleading "₹6"; larger
  // moves round to whole rupees (display rounding only — never used in
  // calculations, per the tick-size rule).
  function fmtMove(n) {
    if (!isFinite(n)) return '—';
    var a = Math.abs(n);
    return '₹' + (a < 100 ? a.toFixed(1) : Math.round(a).toLocaleString('en-IN'));
  }

  // Compact human date for timeline labels — "08 Aug 26" Indian
  // short form. Used by the BUY plan timeline strip to render
  // "Entry by" and "Time stop by" as concrete calendar dates so
  // the user sees the actual deadline, not just "+15 days".
  function _swFmtDate(ms) {
    if (!isFinite(ms)) return '—';
    try {
      var d = new Date(ms);
      return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    } catch (_) { return '—'; }
  }

  function fmtPct(n) {
    if (!isFinite(n)) return '—';
    var sign = n >= 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTOR-BASED NAVIGATION (May 2026 pivot)
  // ═══════════════════════════════════════════════════════════════
  // The only entry point into single-stock analysis. There is no
  // search box, no quick-picks, no watchlist, no batch scanner \u2014
  // all of those were removed at user request. The discovery path
  // is exactly one shape:
  //
  //   1. Render the 12 sector cards (from `data/sectors.json`).
  //   2. User clicks a sector \u2192 we bulk-fetch LTPs for every
  //      stock in that sector via Upstox `/v2/market-quote/ltp`
  //      and render only those currently priced \u20B9500\u2013\u20B92,000.
  //   3. User clicks a stock row \u2192 we set STATE.selected and
  //      invoke the existing analyze() pipeline, which renders
  //      the same chart / plan / WHY BUY / SKIP IF panel below.
  //
  // Adding a new stock or sector means editing data/sectors.json
  // \u2014 no JS changes required. The JSON is cached in
  // localStorage for 7 days and (separately) by the service worker.
  var SW_SECTORS_URL          = 'data/sectors.json';
  var SW_SECTORS_CACHE_KEY    = 'sw_sectors_v1';
  var SW_SECTORS_TTL_MS       = 7 * 24 * 60 * 60 * 1000; // 7 days
  // Quote cache. Re-clicking the same sector within the TTL is a
  // free read; flipping back from a different sector and returning
  // also short-circuits. 5-minute TTL works for both market hours
  // (price moved by < 0.5% typically in that window for the
  // \u20B9500\u2013\u20B92,000 band) and after-hours (the cached price is the
  // closing print and doesn't change until next open).
  var SW_QUOTE_CACHE_TTL_MS   = 5 * 60 * 1000;           // 5 minutes
  // Sector quotes are fetched + revealed in pages of this many stocks.
  // Opening a 400-800 stock sector no longer fires hundreds of LTP
  // calls at once \u2014 only the first page loads, and "Load next N"
  // pulls the next page on demand. This is the rate-limit limiter
  // (it replaced the old fire-60-immediately QUOTE_FETCH_CAP).
  var SW_QUOTE_PAGE           = 10;
  // The hard \u20B9500\u2013\u20B92,000 swing band. Below \u20B9500 is low-liquidity
  // micro-caps; above \u20B92,000 doesn't fit a 1-lac portfolio with
  // enough share count per position. No UI to change it.
  var SWING_PRICE_MIN         = 500;
  var SWING_PRICE_MAX         = 2000;

  // ── API pause toggle ──
  // User-controlled master switch that prevents the swing module
  // from making ANY Upstox API calls (bulk scan, single-stock
  // analyze, sector LTPs). Built in response to a real incident
  // where the bulk scan burned through the user's Cloudflare
  // budget and IP-blocked them out of Options Trading for hours.
  // While paused: the tile + sector grid still browse cached
  // verdicts + last-known prices, but no fresh HTTP fires. The
  // user explicitly re-enables when they're ready to refresh.
  var SW_API_PAUSED_KEY = 'sw_api_paused_v1';

  function swIsApiPaused() {
    try { return localStorage.getItem(SW_API_PAUSED_KEY) === '1'; }
    catch (_) { return false; }
  }

  function swSetApiPaused(flag) {
    try { localStorage.setItem(SW_API_PAUSED_KEY, flag ? '1' : '0'); }
    catch (_) { /* private mode \u2014 in-memory state only this session */ }
  }

  // ── Selected-stock persistence (survive page reload) ──
  // The deep-analysis selection (STATE.selected) lives in memory, so a
  // page reload used to drop the user back to the bare sector grid even
  // though the URL hash still pointed at #swing. We persist ONLY the
  // minimal {sym, isin, name} identity \u2014 never the result/candles \u2014
  // so swingInitSectors() can re-select + re-analyze the same stock on
  // the next load. Because identity (not the verdict) is stored, the
  // analysis is always re-derived (fresh fetch, or the session-aware
  // result cache) and a stale verdict can never be restored across a
  // session boundary. The ISIN is re-validated against the freshly
  // loaded universe before use, so a delisted / removed stock is
  // silently dropped rather than restored as a dead selection.
  var SW_SELECTED_KEY = 'sw_selected_v1';

  function swSaveSelected(sel) {
    try {
      if (!sel || !sel.isin) { localStorage.removeItem(SW_SELECTED_KEY); return; }
      localStorage.setItem(SW_SELECTED_KEY, JSON.stringify({
        sym: sel.sym || '', isin: sel.isin, name: sel.name || ''
      }));
    } catch (_) { /* private mode / quota \u2014 selection stays session-only */ }
  }

  function swClearSelected() {
    try { localStorage.removeItem(SW_SELECTED_KEY); } catch (_) {}
  }

  function swLoadSelected() {
    try {
      var raw = localStorage.getItem(SW_SELECTED_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || !o.isin || !SW_ISIN_RE.test(o.isin)) return null;
      return { sym: o.sym || '', isin: o.isin, name: o.name || '' };
    } catch (_) { return null; }
  }

  // Resolve an ISIN to its {sym, isin, name} against the currently
  // loaded universe (sectors \u2192 indices \u2192 My Stocks, same precedence
  // as swingPickGlobalStock). Returns null when the ISIN is no longer
  // present \u2014 the caller treats that as "drop the stale selection".
  function swFindStockByIsin(isin) {
    if (!isin) return null;
    var d = SECTOR_STATE.data;
    var hit = null;
    if (d) {
      (d.sectors || []).some(function (sec) {
        var st = sec.stocks.find(function (s) { return s.isin === isin; });
        if (st) { hit = st; return true; }
        return false;
      });
      if (!hit) {
        (d.indices || []).some(function (ix) {
          var st = ix.stocks.find(function (s) { return s.isin === isin; });
          if (st) { hit = st; return true; }
          return false;
        });
      }
    }
    if (!hit) {
      hit = (SECTOR_STATE.customStocks || []).find(function (s) {
        return s.isin === isin;
      }) || null;
    }
    return hit ? { sym: hit.sym, isin: hit.isin, name: hit.name } : null;
  }

  // Re-select + re-analyze the stock the user was last viewing so a
  // page reload doesn't lose the chart. Called from swingInitSectors()
  // AFTER the universe loads (so the ISIN can be validated). No-ops if
  // a selection was already made this session. analyze() enforces the
  // API-pause toggle + token presence, so a paused user sees the
  // standard "resume to fetch" notice instead of a silent network hit
  // \u2014 identical to a manual pick.
  function swRestoreSelected() {
    if (STATE.selected) return;
    var saved = swLoadSelected();
    if (!saved) return;
    var stock = swFindStockByIsin(saved.isin);
    if (!stock) { swClearSelected(); return; }
    // Restore the PICK A STOCK panel to the solo-pinned single-row view
    // the user left it in (active sector + soloIsin + that stock's quote),
    // exactly like the global-search pick that produced it. This replays
    // the panel half of the activity; the analyze() below replays the
    // chart half. swingPickGlobalStock re-validates internally and is a
    // safe no-op if the stock isn't in the loaded universe.
    try { window.swingPickGlobalStock(saved.isin); } catch (_) {}
    STATE.selected = stock;
    try { _swApplyScanModeOverlays(); } catch (_) {}
    analyze().then(function () {
      // Bring the restored chart into view, mirroring a sector-row pick
      // so the reload lands the user where they left off.
      try {
        var chartEl = document.querySelector('#sw-result .sw-chart-section')
          || document.getElementById('sw-chart')
          || document.getElementById('sw-result');
        if (chartEl && chartEl.scrollIntoView) {
          chartEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (_) {}
    }).catch(function () {});
  }

  // Standard error object every guarded call throws. Caller-level
  // handlers (showError, renderSectorError, etc.) can switch on
  // err.swPaused to render the toggle-aware "you paused this"
  // message instead of a generic failure banner.
  function swPausedError() {
    var e = new Error('Swing API is paused. Toggle the switch at the top of the Swing tab to resume fresh analysis.');
    e.swPaused = true;
    return e;
  }

  window.swToggleApiPause = function () {
    var now = !swIsApiPaused();
    swSetApiPaused(now);
    // Re-render both the toggle banner and the Today's Setups
    // tile (so its CTA / button states reflect the new mode).
    try { renderApiPauseBanner(); } catch (_) {}
    try { renderTodaySetups(); } catch (_) {}
    return now;
  };

  // ── Module state ──
  var STATE = {
    selected: null,        // {sym, isin, name} — the stock currently being analyzed
    result: null,          // last analysis result (incl. raw candles per TF)
    // Re-entrancy guard for analyze(). Rapid stock picks (or a pick
    // firing while a previous analyze is still fetching) used to stack
    // overlapping multi-TF fan-outs — saturating the browser's 6
    // connections-per-host cap so the newest run's Promise.all could
    // stall forever (spinner stuck) and a stale run could render the
    // wrong stock. analyzeSeq supersedes stale runs; analyzingIsin
    // de-dupes a double-fire for the SAME stock. Mirrors the live
    // chart's loadSeq pattern.
    analyzeSeq: 0,
    analyzingIsin: null,
    // Per-stock result cache { isin: { result, at } } so re-visiting a
    // stock — especially off-hours, when W/D/H/M data is static for the
    // session — paints instantly instead of re-running the 4-TF +
    // LTP + regime fan-out. Session-aware invalidation (see
    // swingResultCacheValid) guarantees a NEW trading session always
    // forces a fresh fetch, so a stale verdict can never leak across
    // the 09:15 boundary. Capped to SW_RESULT_CACHE_MAX entries (LRU
    // by insertion time) to bound memory.
    resultCache: {},
    chart: null,           // LWC chart instance (IChartApi)
    candleSeries: null,    // LWC candlestick series ref
    volumeSeries: null,    // LWC histogram (volume) series ref
    chartTf: '1d',         // currently displayed timeframe ('1mo'|'1w'|'1d'|'4h'|'1h'|'5m')
    chartFetching: {},     // { tfKey: Promise } — dedupes parallel fetches
    lwcLoading: null,      // Promise — dedupes parallel loadLwcLib calls
    indVisible: { ema20: false, ema50: false, ema200: false, sma44: false, zoi: true, fvg: false, ob: false, bos: false, liq: false, fib: true, chartpatterns: true },
    livePoll: {
      timer: null,
      intervalMs: 2000,
      lastSyncMs: 0,
      refetchInFlight: false,
      active: false,
      lastTickMs: 0,
      ltpInFlight: false,
      initialLtpDone: false
    }
  };

  // ── Sector navigation state ──
  var SECTOR_STATE = {
    data: null,            // payload of data/sectors.json once loaded
    loading: null,         // Promise while load is in flight (de-dupes parallel callers)
    loadError: null,
    activeSector: null,    // sector id currently expanded in the panel
    // quoteCache: { isin: { quote: { ltp, change, changePct, dayHigh,
    //               dayLow, yearHigh, yearLow, prevClose, volume }, ts: ms } }
    quoteCache: {},
    quoteInFlight: {},     // { sectorId: Promise } so a double-click doesn't double-fetch
    // ── Solo mode (global "PICK A STOCK" search pick) ──
    // When set, the panel pins to this one ISIN: only this stock is
    // shown and only its quote is fetched (1 API call). Cleared on any
    // manual sector-card click (swingPickSector) and by swingClearSolo().
    // Takes priority over paging.
    soloIsin: null,
    // ── Paged sector loading ──
    // { sectorId: number } = how many stocks have been revealed/fetched
    // so far for each group. Quotes fire SW_QUOTE_PAGE (10) at a time;
    // "Load next 10" advances the pointer. Prevents firing 60-800 quote
    // calls the moment a large sector is opened.
    sectorPage: {},
    // historyCache: { isin: { context: { prevClose, yearHigh, yearLow }, ts: ms } }
    // Separate cache because 52-week range / prev close change far
    // less frequently than intraday LTP \u2014 a 12-hour TTL means
    // re-opening any sector doesn't refetch 380 daily candles.
    historyCache: {},
    filterText: '',        // search box value (lowercased, trimmed)
    // Active signal filter \u2014 null means "all signals shown".
    // Otherwise an exact label string from computeQuickSignal
    // ('TREND', 'PULLBACK', 'BREAKOUT', 'AT HIGH', 'WATCH', 'BASING',
    // 'WAIT', 'WEAK', 'REBOUND?', 'AVOID'). Clicking the matching
    // chip in the panel toggles this on/off.
    signalFilter: null,
    // Minimum signal confidence (%) required to show a row.
    // 0 = no filter. Common levels: 60 (decent), 75 (high).
    confidenceMin: 0,
    // Sort key in '<field>-<dir>' form. field \u2208
    //   sym | ltp | change | 52w | swlow | swhigh | depth | signal
    // dir \u2208 asc | desc. Clicking a column header toggles
    // the direction if the same field is active, or activates
    // it with a sensible default direction (asc for alphabetical,
    // desc for numeric / signal). Empty string '' = no sort, i.e.
    // keep the rows in their natural (liquidity / insertion) order
    // until the user explicitly clicks a header.
    sortKey: '',
    // ─── Custom stocks (the "\u2605 My Stocks" virtual sector) ───
    // User-curated stocks that aren't in any sector / index in
    // data/sectors.json. Persisted in localStorage so they survive
    // page reloads. Shape: [{ sym, isin, name, addedAt }]
    customStocks: [],
    // ─── Instruments master (for "Add custom stock" auto-lookup) ───
    // Lazily loaded from data/instruments-index.json on first use
    // of the Add modal. NSE_EQ + BSE-only equities. Cached in
    // localStorage for 7 days. Shape:
    //   { stocks: { SYM: [ISIN, NAME] | [ISIN, NAME, 'BSE'] } }
    instruments: null,
    instrumentsLoading: null,
    // ─── Exchange map (ISIN \u2192 'NSE' | 'BSE') ───
    // Single source of truth for which exchange segment an ISIN
    // trades on, so every Upstox fetch builds the correct
    // instrument key (NSE_EQ|<isin> vs BSE_EQ|<isin>). Populated
    // from data/instruments-index.json (BSE-only rows carry a 3rd
    // element 'BSE') and from custom stocks. Unknown \u2192 NSE.
    exchByIsin: Object.create(null),
    // Autocomplete state for the Add Stock modal
    addStockSelection: null     // { sym, isin, name, exch } once user picks a match
  };
  // Resolve the Upstox cash-equity instrument key for an ISIN,
  // honouring its exchange (defaults to NSE when unknown). This is
  // the ONLY place segment selection lives \u2014 callers pass an ISIN.
  function swSegForIsin(isin) {
    return (SECTOR_STATE.exchByIsin[isin] === 'BSE') ? 'BSE_EQ' : 'NSE_EQ';
  }
  function swInstrumentKey(isin) {
    return swSegForIsin(isin) + '|' + isin;
  }
  // Record an ISIN's exchange. NSE always wins a conflict so a
  // dual-listed name is never demoted to a BSE key.
  function swNoteExch(isin, exch) {
    if (!isin) return;
    if (exch === 'BSE') {
      if (!SECTOR_STATE.exchByIsin[isin]) SECTOR_STATE.exchByIsin[isin] = 'BSE';
    } else {
      SECTOR_STATE.exchByIsin[isin] = 'NSE';
    }
  }
  // Seed the exchange map from a loaded instruments-index payload.
  // BSE-only rows carry a 3rd element 'BSE'; everything else is NSE.
  function _swPopulateExchFromIndex(data) {
    try {
      var st = (data && data.stocks) || {};
      for (var s in st) {
        if (!Object.prototype.hasOwnProperty.call(st, s)) continue;
        var p = st[s];
        if (p && p[0]) swNoteExch(p[0], p[2] === 'BSE' ? 'BSE' : 'NSE');
      }
    } catch (_) { /* non-fatal: unknown ISINs default to NSE */ }
  }
  var SW_HISTORY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  var SW_CUSTOM_STOCKS_KEY     = 'sw_custom_stocks_v1';
  var SW_INSTRUMENTS_URL       = 'data/instruments-index.json';
  var SW_INSTRUMENTS_CACHE_KEY = 'sw_instruments_index_v1';
  var SW_INSTRUMENTS_TTL_MS    = 7 * 24 * 60 * 60 * 1000;
  // ISIN regex: 12 chars, starts with 2-letter country code (INE for
  // Indian equities), then 9 alphanumeric. Used to gate manual entry.
  var SW_ISIN_RE               = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

  // Inline-SVG icon per sector id. Used by both the picker grid card
  // and the active-panel header. Strokes use `currentColor` so each
  // icon inherits the per-sector accent already defined on the
  // `.sw-sector-card-<id> .sw-sector-card-icon` rules (Banking blue,
  // Pharma pink, Auto red, etc.) — no extra CSS plumbing needed.
  // `width="1em" height="1em"` scales the glyph with the container's
  // `font-size`, matching the visual weight of the old emojis exactly
  // (40×40 chip ⇒ 22px, 30×30 panel ⇒ 16px). Keeping the map JS-side
  // (not in sectors.json) means a branding tweak never requires
  // re-running the sector generator.
  function _swIconLine(d) {
    return '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"'
         + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round"'
         + ' stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  function _swIconFill(d) {
    return '<svg viewBox="0 0 24 24" width="1em" height="1em"'
         + ' fill="currentColor" stroke="currentColor" stroke-width="1"'
         + ' stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
  }
  var SECTOR_ICONS = {
    // ─── Sectors (line-art glyphs, container colour drives accent) ───
    'banking':             _swIconLine('<path d="M3 10l9-5 9 5"/>'
                          + '<path d="M5 10v8M9 10v8M15 10v8M19 10v8"/>'
                          + '<path d="M3 20h18"/>'),
    'financial-services':  _swIconLine('<ellipse cx="12" cy="5.5" rx="7" ry="2"/>'
                          + '<path d="M5 5.5v3.5c0 1.1 3.1 2 7 2s7-.9 7-2V5.5"/>'
                          + '<path d="M5 10.5v3.5c0 1.1 3.1 2 7 2s7-.9 7-2v-3.5"/>'
                          + '<path d="M5 15.5v3.5c0 1.1 3.1 2 7 2s7-.9 7-2v-3.5"/>'),
    'it':                  _swIconLine('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'
                          + '<rect x="9.5" y="9.5" width="5" height="5"/>'
                          + '<path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3'
                          + 'M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/>'),
    'pharma-healthcare':   _swIconLine('<rect x="3" y="9" width="18" height="6" rx="3"/>'
                          + '<path d="M12 9v6"/>'),
    'fmcg-consumer':       _swIconLine('<path d="M5 8h14l-1 12H6L5 8z"/>'
                          + '<path d="M9 8V6a3 3 0 0 1 6 0v2"/>'),
    'auto':                _swIconLine('<path d="M4 14l1.5-5a2 2 0 0 1 2-1.5h9a2 2 0 0 1 2 1.5L20 14"/>'
                          + '<path d="M3 14h18v4a1 1 0 0 1-1 1h-2"/>'
                          + '<path d="M3 14v4a1 1 0 0 0 1 1h2"/>'
                          + '<circle cx="7" cy="18" r="1.5"/>'
                          + '<circle cx="17" cy="18" r="1.5"/>'),
    'oil-gas':             _swIconLine('<path d="M12 3c-3.5 4.5-6.5 8-6.5 12'
                          + 'a6.5 6.5 0 0 0 13 0c0-4-3-7.5-6.5-12z"/>'),
    'power':               _swIconLine('<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/>'),
    'metals':              _swIconLine('<path d="M5 9l2-2.5h10l2 2.5v3H5z"/>'
                          + '<path d="M3 15l2-2.5h14l2 2.5v3H3z"/>'),
    'cement-construction': _swIconLine('<rect x="3" y="4" width="18" height="16" rx="1"/>'
                          + '<path d="M3 9h18M3 14h18"/>'
                          + '<path d="M9 4v5M15 4v5M6 9v5M12 9v5M18 9v5M9 14v6M15 14v6"/>'),
    'industrial-goods':    _swIconLine('<circle cx="12" cy="12" r="3"/>'
                          + '<path d="M12 2v3M12 19v3M2 12h3M19 12h3'
                          + 'M4.9 4.9l2.1 2.1M16.9 16.9l2.2 2.2'
                          + 'M4.9 19.1l2.1-2.1M16.9 7l2.2-2.1"/>'),
    'telecom-infra':       _swIconLine('<path d="M5 13a7 7 0 0 1 14 0"/>'
                          + '<path d="M8 13a4 4 0 0 1 8 0"/>'
                          + '<circle cx="12" cy="13" r="1.4" fill="currentColor"/>'
                          + '<path d="M12 15v6"/>'),
    // ─── New auto-classified sectors ───
    'chemicals':           _swIconLine('<path d="M9 3v7l-4 8a2 2 0 0 0 2 2h10'
                          + 'a2 2 0 0 0 2-2l-4-8V3"/>'
                          + '<path d="M8 3h8"/>'),
    'textiles':            _swIconLine('<path d="M3 6h18M3 10h18M3 14h18M3 18h18"/>'
                          + '<path d="M6 3v18M12 3v18M18 3v18"/>'),
    'media':               _swIconLine('<path d="M4 4h16v12H4z"/>'
                          + '<path d="M8 20h8"/><path d="M12 16v4"/>'
                          + '<polygon points="10,8 10,12 14,10"/>'),
    'services':            _swIconLine('<circle cx="12" cy="8" r="4"/>'
                          + '<path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>'),
    // ─── Indices (NSE benchmark groups) ───
    'nifty-50':            _swIconLine('<path d="M3 17l5-5 4 4 9-10"/>'
                          + '<path d="M14 6h7v7"/>'),
    'nifty-next-50':       _swIconLine('<rect x="4" y="13" width="3" height="7"/>'
                          + '<rect x="10.5" y="9" width="3" height="11"/>'
                          + '<rect x="17" y="5" width="3" height="15"/>'),
    'nifty-bank':          _swIconLine('<path d="M3 10l9-5 9 5"/>'
                          + '<path d="M5 10v8M9 10v8M15 10v8M19 10v8"/>'
                          + '<path d="M3 20h18"/>'),
    'nifty-it':            _swIconLine('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'
                          + '<rect x="9.5" y="9.5" width="5" height="5"/>'
                          + '<path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3'
                          + 'M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/>'),
    // Broad-market breadth — a multi-peak trend over a baseline.
    'nifty-100':           _swIconLine('<path d="M3 17l4-4 3 3 4-6 4 4 3-5"/>'
                          + '<path d="M3 21h18"/>'),
    // Whole-market histogram — five staggered bars over a baseline.
    'nifty-500':           _swIconLine('<path d="M3 21h18"/>'
                          + '<rect x="3" y="14" width="2.4" height="6"/>'
                          + '<rect x="6.8" y="10" width="2.4" height="10"/>'
                          + '<rect x="10.6" y="13" width="2.4" height="7"/>'
                          + '<rect x="14.4" y="7" width="2.4" height="13"/>'
                          + '<rect x="18.2" y="11" width="2.4" height="9"/>'),
    // ─── Virtual sector for user-curated custom stocks ───
    'my-stocks':           _swIconFill('<path d="M12 3l2.6 5.5 6.1.7-4.6 4.1'
                          + ' 1.3 6L12 16.3 6.6 19.4l1.3-6L3.3 9.2l6.1-.7z"/>'),
    // ─── Liquidity screen (high-turnover names) — droplet over a baseline ───
    'liquid-band':         _swIconLine('<path d="M12 3c3.5 4.2 5.5 7 5.5 9.5'
                          + 'a5.5 5.5 0 0 1-11 0C6.5 10 8.5 7.2 12 3z"/>'
                          + '<path d="M3 21h18"/>')
  };
  // Fallback diamond glyph if a sector id is unknown — same line-art
  // family so it blends in rather than the previous text bullet.
  function _swSectorIcon(id) {
    return SECTOR_ICONS[id] || _swIconLine('<path d="M12 3l8 9-8 9-8-9z"/>');
  }

  // Search box handler \u2014 stash and re-render.
  window.swingSectorSearch = function (text) {
    SECTOR_STATE.filterText = (text || '').toLowerCase().trim();
    renderSectorPanel();
  };

  // Click handler for a signal-filter chip (TREND / PULLBACK /
  // BREAKOUT / WATCH / WEAK / AVOID / etc.). Passing the same
  // label that is already active toggles the filter off, so the
  // chip works as both selector and clear-button. Passing null
  // explicitly clears it (used by the "All" chip).
  window.swingSignalFilter = function (label) {
    var next = (label === SECTOR_STATE.signalFilter) ? null : (label || null);
    SECTOR_STATE.signalFilter = next;
    renderSectorPanel();
  };

  // Click handler for the confidence-floor pill. Cycles through
  // (any) \u2192 60% \u2192 75% \u2192 (any). Three levels strike a
  // balance between "no filter" and "show me only the strongest
  // setups" without needing a slider.
  window.swingConfFilter = function () {
    var cur = SECTOR_STATE.confidenceMin || 0;
    var next = (cur === 0) ? 60 : (cur === 60) ? 75 : 0;
    SECTOR_STATE.confidenceMin = next;
    renderSectorPanel();
  };

  // One-shot reset for both signal + confidence filters. Wired
  // to the "Clear filters" link in the empty-state message.
  window.swingClearFilters = function () {
    SECTOR_STATE.signalFilter  = null;
    SECTOR_STATE.confidenceMin = 0;
    renderSectorPanel();
  };

  // ═══════════════════════════════════════════════════════════════
  // (Universe Scan + Verdict filter were prototyped here but
  //  removed at the user's request \u2014 the feature added too much
  //  UI for too little daily value. The deep verdict remains
  //  accessible the original way: click any stock row \u2192 see the
  //  full BUY/WAIT verdict in the analysis panel below the chart.
  //  See the Signal Guide modal for the "Two layers" explainer
  //  of how the table's screener chip differs from that verdict.)
  // ═══════════════════════════════════════════════════════════════
  // (Universe Scan + verdict-cache module removed 2026-05-25 \u2014
  //  see the comment block above.)

  // Clicking a column header toggles the sort:
  //   \u2022 If the same field is already active \u2192 flip direction.
  //   \u2022 Otherwise \u2192 activate that field with its default
  //     direction (asc for symbol/name, desc for everything else
  //     so "best" / "biggest" is the natural first click).
  // Symbol/name sort ascending first (A→Z reads naturally); every
  // numeric / signal column starts descending so the first click
  // surfaces the "biggest / strongest" rows at the top.
  var _SW_DEFAULT_DIR = { sym: 'asc', name: 'asc' };
  window.swingSectorSortToggle = function (field) {
    var cur = SECTOR_STATE.sortKey || '';
    var idx = cur.lastIndexOf('-');
    var curField = idx > 0 ? cur.slice(0, idx) : cur;
    var curDir   = idx > 0 ? cur.slice(idx + 1) : 'desc';
    var nextDir;
    if (curField === field) {
      nextDir = (curDir === 'asc') ? 'desc' : 'asc';
    } else {
      nextDir = _SW_DEFAULT_DIR[field] || 'desc';
    }
    SECTOR_STATE.sortKey = field + '-' + nextDir;
    renderSectorPanel();
  };

  // ─────────────────────────────────────────────────────────
  // Cross-sector global stock search.
  //
  // Lets the user type ANY stock (sym or name) and jump straight
  // to analysis without first clicking a sector card. Indexed
  // off the same data/sectors.json that powers the sector grid —
  // no extra network. Symbol matches outrank name matches; exact
  // beats prefix beats substring. Query is alphanumeric-normalised
  // so "L&T" → "lt" matches NSE symbol "LT", "ICICI Bank" matches
  // "icicibank", etc. Top 12 results are rendered to keep the
  // dropdown short; total count is shown when truncated so the
  // user knows to refine.
  // ─────────────────────────────────────────────────────────
  function _swNormForSearch(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  window.swingGlobalSearch = function (text) {
    var q = (text || '').trim();
    var clearBtn = document.getElementById('sw-global-search-clear');
    if (clearBtn) clearBtn.hidden = (q.length === 0);
    _swRenderGlobalSearchResults(q);
  };

  function _swRenderGlobalSearchResults(q) {
    var host = document.getElementById('sw-global-search-results');
    if (!host) return;
    if (!q) { host.innerHTML = ''; host.hidden = true; return; }
    if (q.length < 2) {
      host.innerHTML = '<div class="sw-global-search-empty">Type at least 2 characters\u2026</div>';
      host.hidden = false;
      return;
    }
    if (!SECTOR_STATE.data) {
      host.innerHTML = '<div class="sw-global-search-empty">Stocks list still loading\u2026</div>';
      host.hidden = false;
      // Kick a load if not already in flight; re-render on resolve.
      loadSectors().then(function () { _swRenderGlobalSearchResults(q); })
                   .catch(function () {});
      return;
    }
    var nq = _swNormForSearch(q);
    if (!nq) { host.innerHTML = ''; host.hidden = true; return; }

    var matches = [];
    // De-dupe across sectors / indices / my-stocks so the same stock
    // (e.g. INFY in Nifty 50 AND IT sector) doesn't appear twice in
    // the dropdown. The first group we encounter (sectors first,
    // then indices, then custom) wins the citation.
    var seenIsin = {};

    var scan = function (groupId, groupName, stocks) {
      stocks.forEach(function (st) {
        if (seenIsin[st.isin]) return;
        var nSym  = _swNormForSearch(st.sym);
        var nName = _swNormForSearch(st.name);
        var iSym  = nSym.indexOf(nq);
        var iName = nName.indexOf(nq);
        if (iSym < 0 && iName < 0) return;
        seenIsin[st.isin] = true;
        // Lower rank = better match.
        var rank;
        if      (nSym === nq)  rank = 0;   // sym exact
        else if (iSym === 0)   rank = 1;   // sym prefix
        else if (iName === 0)  rank = 2;   // name prefix
        else if (iSym > 0)     rank = 3;   // sym substring
        else                   rank = 4;   // name substring
        matches.push({
          sym: st.sym, name: st.name, isin: st.isin,
          sectorId: groupId, sectorName: groupName, rank: rank
        });
      });
    };

    SECTOR_STATE.data.sectors.forEach(function (sec) {
      scan(sec.id, sec.name, sec.stocks);
    });
    (SECTOR_STATE.data.indices || []).forEach(function (ix) {
      scan(ix.id, ix.name, ix.stocks);
    });
    scan('my-stocks', 'My Stocks', SECTOR_STATE.customStocks || []);

    matches.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.sym.localeCompare(b.sym);
    });

    if (matches.length === 0) {
      // No match in any sector / index / custom list.
      // Offer the "Add as custom stock" CTA so the user can save it.
      // We pass the raw query (uppercased) to prefill the symbol
      // field; the modal does the ISIN lookup itself.
      var qUp = q.toUpperCase().replace(/[^A-Z0-9&\-]/g, '');
      host.innerHTML = ''
        + '<div class="sw-global-search-empty">'
        +   '<div class="sw-gs-empty-msg">'
        +     'No stocks match \u201C' + escapeHtml(q) + '\u201D in our sectors, indices, or your watchlist.'
        +   '</div>'
        +   '<button type="button" class="sw-gs-add-cta"'
        +     ' onclick="swingOpenAddStock(\'' + escapeHtml(qUp) + '\')">'
        +     '+ Add \u201C' + escapeHtml(qUp || q) + '\u201D to My Stocks'
        +   '</button>'
        +   '<div class="sw-gs-empty-hint">'
        +     'Saves to your local watchlist on this device.'
        +   '</div>'
        + '</div>';
      host.hidden = false;
      return;
    }

    var totalCount = matches.length;
    matches = matches.slice(0, 20);

    var rowsHtml = matches.map(function (m) {
      var icon = _swSectorIcon(m.sectorId);
      return ''
        + '<button type="button" class="sw-global-search-item" role="option"'
        +   ' onclick="swingPickGlobalStock(\'' + escapeHtml(m.isin) + '\')">'
        +   '<span class="sw-gs-sym">'  + escapeHtml(m.sym)  + '</span>'
        +   '<span class="sw-gs-name">' + escapeHtml(m.name) + '</span>'
        +   '<span class="sw-gs-sec">'
        +     '<span class="sw-gs-sec-icon" aria-hidden="true">' + icon + '</span> '
        +     escapeHtml(m.sectorName)
        +   '</span>'
        + '</button>';
    }).join('');

    var moreHtml = (totalCount > matches.length)
      ? '<div class="sw-global-search-more">Showing '
      + matches.length + ' of ' + totalCount
      + ' matches \u2014 refine to narrow.</div>'
      : '';

    host.innerHTML = rowsHtml + moreHtml;
    host.hidden = false;
  }

  SECTOR_STATE._scrollDeadline = 0;
  SECTOR_STATE._suppressRowScroll = false;
  var _swScrollDone = false;

  function _swDoScrollToFocused() {
    // Today's Setups clicks keep the sector-row highlight in sync but
    // navigate the viewport to the CHART, not the sector row — so they
    // suppress this auto-scroll. The persistent --focused highlight is
    // applied by renderSectorPanel (reads _focusedIsin), independent of
    // this function, so suppressing the scroll never loses the highlight.
    if (SECTOR_STATE._suppressRowScroll) return;
    var isin = SECTOR_STATE._focusedIsin;
    if (!isin) return;
    if (Date.now() > SECTOR_STATE._scrollDeadline) return;
    var panel = document.getElementById('sw-sector-panel');
    if (!panel) return;
    var fRow = panel.querySelector('tr[data-isin="' + isin + '"]');
    if (!fRow) return;
    if (!_swScrollDone) {
      // First scroll — instant, no animation delay.
      _swScrollDone = true;
      var sp = fRow.closest('.sw-sector-panel') || panel;
      sp.scrollIntoView({ block: 'start' });
      fRow.scrollIntoView({ block: 'center' });
      fRow.classList.add('sw-sector-row--flash');
      setTimeout(function () {
        var r = document.querySelector('tr[data-isin="' + isin + '"]');
        if (r) r.classList.remove('sw-sector-row--flash');
      }, 2200);
    } else {
      // Re-scroll after DOM rebuild (quote batch arrived).
      fRow.scrollIntoView({ block: 'center' });
    }
  }

  window.swingPickGlobalStock = function (isin) {
    var found = null;
    var foundSector = null;

    // Search order: sectors first (more contextual), then indices,
    // then My Stocks. First match wins.
    if (SECTOR_STATE.data) {
      SECTOR_STATE.data.sectors.some(function (sec) {
        var st = sec.stocks.find(function (s) { return s.isin === isin; });
        if (st) { found = st; foundSector = sec; return true; }
        return false;
      });
      if (!found) {
        (SECTOR_STATE.data.indices || []).some(function (ix) {
          var st = ix.stocks.find(function (s) { return s.isin === isin; });
          if (st) {
            found = st;
            foundSector = Object.assign({ kind: 'index' }, ix);
            return true;
          }
          return false;
        });
      }
    }
    if (!found) {
      var st = (SECTOR_STATE.customStocks || []).find(function (s) {
        return s.isin === isin;
      });
      if (st) {
        found = st;
        foundSector = { id: 'my-stocks', name: 'My Stocks', kind: 'custom' };
      }
    }
    if (!found) return;

    SECTOR_STATE._focusedIsin = isin;
    SECTOR_STATE._scrollDeadline = Date.now() + 8000;
    SECTOR_STATE._suppressRowScroll = false;  // global search DOES scroll to the row
    _swScrollDone = false;

    // Close the dropdown + clear the global search input immediately.
    var gsHost = document.getElementById('sw-global-search-results');
    if (gsHost) gsHost.hidden = true;
    var gsInput = document.getElementById('sw-global-search-input');
    if (gsInput) { gsInput.value = ''; gsInput.blur(); }
    var clearBtn = document.getElementById('sw-global-search-clear');
    if (clearBtn) clearBtn.hidden = true;

    // ── Solo mode ──
    // Pin the panel to this single stock: show ONLY this row and fetch
    // ONLY its quote (1 API call). This is the cheap path for "I know
    // the exact stock" \u2014 no full-sector batch, no paging. Cleared by a
    // manual sector-card click (swingPickSector) or swingClearSolo().
    SECTOR_STATE.soloIsin      = isin;
    SECTOR_STATE.activeSector  = foundSector.id;
    SECTOR_STATE.filterText    = '';
    SECTOR_STATE.signalFilter  = null;
    SECTOR_STATE.confidenceMin = 0;
    // Reset fib scan state for the newly-activated group.
    if (typeof _swFibAutoState !== 'undefined') {
      _swFibAutoState.doneSector    = null;
      _swFibAutoState.runningSector = null;
      _swFibAutoState.results       = [];
      _swFibAutoState.signalFilter  = null;
    }
    renderSectorGrid();
    renderSectorPanel();   // single-row loading state
    // Fetch just this one quote. Wait for any in-flight fetch on this
    // group first so the solo working-set isn't blocked by a stale
    // page fetch's in-flight guard. fetchSectorQuotes honours the
    // pause toggle + token check internally.
    var _soloRun = function () {
      return fetchSectorQuotes(foundSector.id).then(function () {
        if (SECTOR_STATE.soloIsin === isin && SECTOR_STATE.activeSector === foundSector.id) {
          renderSectorPanel();
        }
      });
    };
    var _soloInflight = SECTOR_STATE.quoteInFlight[foundSector.id];
    (_soloInflight ? _soloInflight.then(_soloRun, _soloRun) : _soloRun())
      .catch(function (e) {
        if (SECTOR_STATE.soloIsin === isin && SECTOR_STATE.activeSector === foundSector.id) {
          renderSectorPanelError(e);
        }
      });
  };

  // Click anywhere outside the search wrap closes the dropdown.
  // Attached once at module init (IIFE evaluation).
  document.addEventListener('click', function (e) {
    var wrap = document.querySelector('.sw-global-search-wrap');
    if (!wrap || wrap.contains(e.target)) return;
    var host = document.getElementById('sw-global-search-results');
    if (host && !host.hidden) host.hidden = true;
  });

  // ─────────────────────────────────────────────────────────
  // Signal-guide modal (the "?" button next to the per-sector
  // search input). Static HTML inside content/swing.html; this
  // module just toggles `.open` and wires focus / keyboard.
  //
  // Behaviour mirrors the existing api-modal pattern:
  //   \u2022 Backdrop click closes
  //   \u2022 Escape closes
  //   \u2022 Tab cycles focus inside the modal (focus trap)
  //   \u2022 Focus restored to the help button on close
  // ─────────────────────────────────────────────────────────
  var _swHelpPrevFocus = null;

  window.swingOpenSignalHelp = function () {
    var m = document.getElementById('sw-signal-help-modal');
    if (!m) return;
    _swHelpPrevFocus = document.activeElement;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', _swHelpKeyHandler, true);
    // Focus the close button so the first Tab cycles meaningfully
    // and Esc / Enter behave predictably for keyboard users.
    setTimeout(function () {
      var close = m.querySelector('.sw-help-modal-close');
      if (close) close.focus();
    }, 40);
  };

  window.swingCloseSignalHelp = function () {
    var m = document.getElementById('sw-signal-help-modal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _swHelpKeyHandler, true);
    if (_swHelpPrevFocus && typeof _swHelpPrevFocus.focus === 'function') {
      try { _swHelpPrevFocus.focus(); } catch (_) { /* element gone */ }
    }
    _swHelpPrevFocus = null;
  };

  function _swHelpKeyHandler(e) {
    var m = document.getElementById('sw-signal-help-modal');
    if (!m || !m.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      window.swingCloseSignalHelp();
      return;
    }
    if (e.key !== 'Tab') return;
    // Focus trap \u2014 cycle Tab inside the modal.
    var focusables = Array.prototype.slice.call(m.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (focusables.length === 0) { e.preventDefault(); return; }
    var first = focusables[0];
    var last  = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  // ─────────────────────────────────────────────────────────
  // GROUP RESOLVER \u2014 unifies sectors / indices / "My Stocks"
  //
  // The picker now has three kinds of clickable card:
  //   1. SECTOR    (id e.g. "banking")        \u2192 data.sectors[\u2026]
  //   2. INDEX     (id e.g. "nifty-50")       \u2192 data.indices[\u2026]
  //   3. MY-STOCKS (id "my-stocks")           \u2192 SECTOR_STATE.customStocks
  //
  // Rather than scatter `data.sectors.find()` calls across every
  // renderer / handler, a single resolver returns the right
  // {id, name, stocks, kind} object regardless of where it lives.
  // ─────────────────────────────────────────────────────────
  function _swGetGroup(id) {
    if (!id) return null;
    if (id === 'my-stocks') {
      return {
        id: 'my-stocks',
        name: 'My Stocks',
        kind: 'custom',
        stocks: SECTOR_STATE.customStocks || []
      };
    }
    if (!SECTOR_STATE.data) return null;
    var s = SECTOR_STATE.data.sectors.find(function (x) { return x.id === id; });
    if (s) return Object.assign({ kind: 'sector' }, s);
    var indices = SECTOR_STATE.data.indices || [];
    var i = indices.find(function (x) { return x.id === id; });
    if (i) return Object.assign({ kind: 'index' }, i);
    return null;
  }

  // ─────────────────────────────────────────────────────────
  // PER-GROUP PRICE BAND
  //
  // Most cards trade the global ₹SW_MIN_PRICE–₹SW_MAX_PRICE band. A
  // group MAY carry its own `band: {min,max}` in data/sectors.json (the
  // "High Liquidity" screen narrows to ₹500–₹2,000). This resolver
  // returns the effective {min,max} for a group id and FAILS SAFE to the
  // global defaults for my-stocks, the full universe, an unknown id, or a
  // malformed band — never widening on bad data (per trading-context.mdc).
  // ─────────────────────────────────────────────────────────
  function _swBandFor(id) {
    var def = { min: SW_MIN_PRICE, max: SW_MAX_PRICE };
    if (!id || id === '__all__' || id === 'my-stocks') return def;
    var g = _swGetGroup(id);
    var b = g && g.band;
    if (b && isFinite(+b.min) && isFinite(+b.max) && +b.min > 0 && +b.min < +b.max) {
      return { min: +b.min, max: +b.max };
    }
    return def;
  }

  // ─────────────────────────────────────────────────────────
  // CUSTOM STOCKS \u2014 "\u2605 My Stocks" virtual sector backed by localStorage
  // ─────────────────────────────────────────────────────────
  function _swLoadCustomStocks() {
    try {
      var raw = localStorage.getItem(SW_CUSTOM_STOCKS_KEY);
      if (!raw) { SECTOR_STATE.customStocks = []; return; }
      var p = JSON.parse(raw);
      SECTOR_STATE.customStocks = (p && Array.isArray(p.stocks)) ? p.stocks : [];
      // Seed the exchange map from any persisted custom stocks so
      // their fetches use the correct segment before the index loads.
      (SECTOR_STATE.customStocks || []).forEach(function (st) {
        if (st && st.isin) swNoteExch(st.isin, st.exch === 'BSE' ? 'BSE' : 'NSE');
      });
    } catch (_) {
      SECTOR_STATE.customStocks = [];
    }
  }
  function _swSaveCustomStocks() {
    try {
      localStorage.setItem(SW_CUSTOM_STOCKS_KEY, JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        stocks: SECTOR_STATE.customStocks
      }));
    } catch (_) { /* quota \u2014 in-memory still works for this session */ }
  }
  function _swCustomStockExists(isin) {
    return (SECTOR_STATE.customStocks || []).some(function (st) {
      return st.isin === isin;
    });
  }
  function _swAddCustomStock(stock) {
    // Idempotent insert; latest-added bubbles to the top for visibility.
    SECTOR_STATE.customStocks = (SECTOR_STATE.customStocks || []).filter(function (st) {
      return st.isin !== stock.isin;
    });
    var exch = stock.exch === 'BSE' ? 'BSE' : 'NSE';
    SECTOR_STATE.customStocks.unshift({
      sym: stock.sym,
      isin: stock.isin,
      name: stock.name,
      exch: exch,
      addedAt: Date.now()
    });
    // Keep the exchange map in sync so fetches for this custom stock
    // build the right instrument key even before the index loads.
    swNoteExch(stock.isin, exch);
    _swSaveCustomStocks();
  }

  window.swingRemoveCustomStock = function (isin) {
    SECTOR_STATE.customStocks = (SECTOR_STATE.customStocks || []).filter(function (st) {
      return st.isin !== isin;
    });
    _swSaveCustomStocks();
    renderSectorGrid();
    if (SECTOR_STATE.activeSector === 'my-stocks') {
      renderSectorPanel();
    }
  };

  // ─────────────────────────────────────────────────────────
  // INSTRUMENTS-INDEX LAZY-LOAD (data/instruments-index.json)
  // \u2014 powers the Add Stock modal's autocomplete and symbol
  // \u2192 ISIN auto-resolution. ~114 KB, cached 7 days.
  // ─────────────────────────────────────────────────────────
  async function loadInstrumentsIndex() {
    if (SECTOR_STATE.instruments) return SECTOR_STATE.instruments;
    if (SECTOR_STATE.instrumentsLoading) return SECTOR_STATE.instrumentsLoading;
    SECTOR_STATE.instrumentsLoading = (async function () {
      try {
        var raw = localStorage.getItem(SW_INSTRUMENTS_CACHE_KEY);
        if (raw) {
          var p = JSON.parse(raw);
          if (p && p.payload && (Date.now() - p.ts) < SW_INSTRUMENTS_TTL_MS) {
            SECTOR_STATE.instruments = p.payload;
            _swPopulateExchFromIndex(p.payload);
            return p.payload;
          }
        }
      } catch (_) { /* corrupt cache \u2014 fall through */ }
      var resp = await fetch(SW_INSTRUMENTS_URL, { credentials: 'omit' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading instruments index');
      var data = await resp.json();
      if (!data || !data.stocks) throw new Error('Malformed instruments-index.json');
      SECTOR_STATE.instruments = data;
      _swPopulateExchFromIndex(data);
      try {
        localStorage.setItem(SW_INSTRUMENTS_CACHE_KEY, JSON.stringify({
          ts: Date.now(), payload: data
        }));
      } catch (_) { /* quota \u2014 in-memory works for this session */ }
      return data;
    })().catch(function (err) {
      SECTOR_STATE.instrumentsLoading = null;
      throw err;
    });
    return SECTOR_STATE.instrumentsLoading;
  }

  // ─────────────────────────────────────────────────────────
  // ADD-CUSTOM-STOCK MODAL
  // ─────────────────────────────────────────────────────────
  var _swAddPrevFocus = null;

  window.swingOpenAddStock = function (prefillSym) {
    var m = document.getElementById('sw-add-stock-modal');
    if (!m) return;
    // If the modal was launched from the global-search empty-state
    // CTA, hide the dropdown so it doesn't sit visible behind the
    // modal card. The input value is preserved so the user sees
    // their search context once they close the modal.
    var gsHost = document.getElementById('sw-global-search-results');
    if (gsHost) gsHost.hidden = true;

    _swAddPrevFocus = document.activeElement;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', _swAddKeyHandler, true);

    // Reset form state
    SECTOR_STATE.addStockSelection = null;
    _swAddResetForm();

    // Prefill if a symbol was passed in (e.g. from the "no matches"
    // CTA in global search) and trigger the autocomplete.
    var symInput = document.getElementById('sw-add-sym');
    if (symInput) {
      symInput.value = (prefillSym || '').toUpperCase();
      window.swingAddSymInput(symInput.value);
    }

    // Kick off instruments-index fetch in the background so it's
    // ready by the time the user finishes typing.
    loadInstrumentsIndex().catch(function (err) {
      _swAddShowError('Could not load instruments list: ' + err.message
        + '. You can still enter ISIN manually below.');
    });

    setTimeout(function () { if (symInput) symInput.focus(); }, 40);
  };

  window.swingCloseAddStock = function () {
    var m = document.getElementById('sw-add-stock-modal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', _swAddKeyHandler, true);
    if (_swAddPrevFocus && typeof _swAddPrevFocus.focus === 'function') {
      try { _swAddPrevFocus.focus(); } catch (_) { /* gone */ }
    }
    _swAddPrevFocus = null;
  };

  function _swAddKeyHandler(e) {
    var m = document.getElementById('sw-add-stock-modal');
    if (!m || !m.classList.contains('open')) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      window.swingCloseAddStock();
      return;
    }
    if (e.key !== 'Tab') return;
    var focusables = Array.prototype.slice.call(m.querySelectorAll(
      'button, [href], input, select, textarea, details, [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (focusables.length === 0) { e.preventDefault(); return; }
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }

  function _swAddResetForm() {
    var dd = document.getElementById('sw-add-sym-dd');
    if (dd) { dd.innerHTML = ''; dd.hidden = true; }
    var prev = document.getElementById('sw-add-preview');
    if (prev) prev.hidden = true;
    var hint = document.getElementById('sw-add-sym-hint');
    if (hint) {
      hint.textContent = 'Start typing the NSE trading symbol \u2014 suggestions appear below.';
      hint.classList.remove('sw-add-hint-err');
    }
    var err = document.getElementById('sw-add-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    var manual = document.getElementById('sw-add-manual');
    if (manual) {
      manual.removeAttribute('open');
      var n = document.getElementById('sw-add-manual-name');
      var i = document.getElementById('sw-add-manual-isin');
      if (n) n.value = '';
      if (i) i.value = '';
    }
  }

  function _swAddShowError(msg) {
    var err = document.getElementById('sw-add-error');
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  }

  function _swSetAddSelection(sel) {
    SECTOR_STATE.addStockSelection = sel;
    var prev = document.getElementById('sw-add-preview');
    if (!prev) return;
    if (!sel) { prev.hidden = true; return; }
    document.getElementById('sw-add-prev-name').textContent = sel.name;
    document.getElementById('sw-add-prev-isin').textContent = sel.isin;
    var st = document.getElementById('sw-add-preview-status');
    if (st) {
      if (_swCustomStockExists(sel.isin)) {
        st.textContent = 'Already in My Stocks \u2014 saving will refresh it.';
        st.classList.add('sw-add-status-dim');
      } else {
        st.textContent = 'Ready to save.';
        st.classList.remove('sw-add-status-dim');
      }
    }
    prev.hidden = false;
  }

  window.swingAddSymInput = function (text) {
    var q = (text || '').toUpperCase().trim();
    var dd = document.getElementById('sw-add-sym-dd');
    if (!dd) return;
    // Any edit invalidates the prior selection
    _swSetAddSelection(null);
    if (q.length < 1) { dd.innerHTML = ''; dd.hidden = true; return; }

    if (!SECTOR_STATE.instruments) {
      dd.innerHTML = '<div class="sw-add-sym-empty">Loading instruments list\u2026</div>';
      dd.hidden = false;
      return;
    }
    var stocks = SECTOR_STATE.instruments.stocks;

    // ── ISIN reverse-lookup ──
    // Users coming from a broker app often have the ISIN handy but
    // not the trading symbol (e.g. INE377N01017 \u2192 WAAREEENER).
    // If the input matches ISIN format (12 chars: ^[A-Z]{2}[A-Z0-9]{9}\d$),
    // scan the master for a stock with that ISIN and auto-resolve
    // it to its symbol + clean name. Cuts the friction of
    // "open the master, look it up, then come back and type the sym".
    if (SW_ISIN_RE.test(q)) {
      var foundSym = null;
      for (var s1 in stocks) {
        if (!Object.prototype.hasOwnProperty.call(stocks, s1)) continue;
        if (stocks[s1][0] === q) { foundSym = s1; break; }
      }
      if (foundSym) {
        var foundName = stocks[foundSym][1] || foundSym;
        dd.innerHTML = ''
          + '<button type="button" class="sw-add-sym-item" role="option"'
          +   ' onclick="swingAddSymPick(\'' + escapeHtml(foundSym) + '\')">'
          +   '<span class="sw-add-sym-sym">' + escapeHtml(foundSym) + '</span>'
          +   '<span class="sw-add-sym-name">'
          +     escapeHtml(foundName) + ' \u00b7 ISIN match'
          +   '</span>'
          + '</button>';
        dd.hidden = false;
        _swSetAddSelection({ sym: foundSym, isin: q, name: foundName,
          exch: stocks[foundSym][2] === 'BSE' ? 'BSE' : 'NSE' });
        return;
      }
      // Format-valid ISIN but not in our master \u2014 surface the
      // manual entry hint clearly so the user isn't stuck.
      dd.innerHTML = '<div class="sw-add-sym-empty">'
        + 'ISIN <b>' + escapeHtml(q) + '</b> is not in the NSE master. '
        + 'Open <b>"Enter ISIN manually"</b> below to save it directly.'
        + '</div>';
      dd.hidden = false;
      return;
    }

    // ── Normal symbol / name autocomplete ──
    var matches = [];
    for (var sym in stocks) {
      if (!Object.prototype.hasOwnProperty.call(stocks, sym)) continue;
      var iSym = sym.indexOf(q);
      if (iSym < 0) {
        // Also try name substring match
        var name = stocks[sym][1] || '';
        if (name.toUpperCase().indexOf(q) < 0) continue;
        matches.push({ sym: sym, isin: stocks[sym][0], name: name,
          exch: stocks[sym][2] === 'BSE' ? 'BSE' : 'NSE', rank: 3 });
        continue;
      }
      matches.push({
        sym: sym,
        isin: stocks[sym][0],
        name: stocks[sym][1] || sym,
        exch: stocks[sym][2] === 'BSE' ? 'BSE' : 'NSE',
        rank: (sym === q ? 0 : (iSym === 0 ? 1 : 2))
      });
    }
    matches.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.sym.localeCompare(b.sym);
    });

    // Auto-select if there's a single exact symbol match.
    if (matches.length > 0 && matches[0].sym === q) {
      _swSetAddSelection({ sym: matches[0].sym, isin: matches[0].isin,
        name: matches[0].name, exch: matches[0].exch || 'NSE' });
    }

    matches = matches.slice(0, 8);
    if (matches.length === 0) {
      dd.innerHTML = '<div class="sw-add-sym-empty">'
        + 'No match for <b>' + escapeHtml(q) + '</b> in the NSE master. '
        + 'Try a shorter prefix, or use the manual ISIN entry below.</div>';
      dd.hidden = false;
      return;
    }
    dd.innerHTML = matches.map(function (m) {
      return '<button type="button" class="sw-add-sym-item" role="option"'
           +   ' onclick="swingAddSymPick(\'' + escapeHtml(m.sym) + '\')">'
           +   '<span class="sw-add-sym-sym">' + escapeHtml(m.sym) + '</span>'
           +   '<span class="sw-add-sym-name">' + escapeHtml(m.name) + '</span>'
           + '</button>';
    }).join('');
    dd.hidden = false;
  };

  window.swingAddSymPick = function (sym) {
    if (!SECTOR_STATE.instruments) return;
    var rec = SECTOR_STATE.instruments.stocks[sym];
    if (!rec) return;
    var input = document.getElementById('sw-add-sym');
    if (input) input.value = sym;
    var dd = document.getElementById('sw-add-sym-dd');
    if (dd) { dd.innerHTML = ''; dd.hidden = true; }
    _swSetAddSelection({ sym: sym, isin: rec[0], name: rec[1] || sym,
      exch: rec[2] === 'BSE' ? 'BSE' : 'NSE' });
  };

  window.swingAddSymKey = function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      // If the dropdown has exactly one item, pick it; otherwise submit.
      var dd = document.getElementById('sw-add-sym-dd');
      var items = dd ? dd.querySelectorAll('.sw-add-sym-item') : [];
      if (items.length === 1) {
        items[0].click();
      } else if (SECTOR_STATE.addStockSelection) {
        window.swingSubmitAddStock();
      }
    }
  };

  window.swingSubmitAddStock = function () {
    var err = document.getElementById('sw-add-error');
    if (err) { err.hidden = true; err.textContent = ''; }

    // Prefer the autocomplete selection. Fall back to manual ISIN entry.
    var pick = SECTOR_STATE.addStockSelection;
    var manual = document.getElementById('sw-add-manual');
    if (!pick && manual && manual.hasAttribute('open')) {
      var symInp  = document.getElementById('sw-add-sym');
      var nameInp = document.getElementById('sw-add-manual-name');
      var isinInp = document.getElementById('sw-add-manual-isin');
      var sym  = (symInp  ? symInp.value  : '').toUpperCase().trim();
      var name = (nameInp ? nameInp.value : '').trim();
      var isin = (isinInp ? isinInp.value : '').toUpperCase().trim();
      if (!sym)  { _swAddShowError('Symbol is required.'); return; }
      if (!isin) { _swAddShowError('ISIN is required for manual entry.'); return; }
      if (!SW_ISIN_RE.test(isin)) {
        _swAddShowError('ISIN format looks wrong. Expected 12 chars like INE002A01018.');
        return;
      }
      pick = { sym: sym, isin: isin, name: name || sym };
    }

    if (!pick) {
      _swAddShowError('Pick a symbol from the suggestions, or open the manual section below.');
      return;
    }

    _swAddCustomStock(pick);

    // Repaint everything that touches custom stocks: the picker grid
    // (so the My Stocks card appears / updates its count) and the
    // active panel if the user already had it open.
    renderSectorGrid();
    if (SECTOR_STATE.activeSector === 'my-stocks') {
      renderSectorPanel();
    }

    window.swingCloseAddStock();

    // Open the My Stocks sector so the user immediately sees the
    // newly-added stock in context.
    try {
      if (SECTOR_STATE.activeSector !== 'my-stocks') {
        swingPickSector('my-stocks');
      }
    } catch (_) {}
  };

  // Fetch \~52 weeks of daily candles in a single call and derive
  // everything we need for swing context:
  //   \u2022 prevClose \u2014 the last COMPLETED session's close,
  //     resolved by IST date (see _swParseCandles). Cross-session
  //     correct (vs. V2 quote's ohlc.close which equals last_price
  //     on weekends \u2192 the 0.00% change bug).
  //   \u2022 yearHigh / yearLow \u2014 max(highs) / min(lows) over
  //     the window. V2 quotes does NOT reliably return year_high /
  //     year_low for cash equities, which is why every signal was
  //     showing N/A. Deriving from candle bodies always works.
  // Result is cached for 12 hours per ISIN since 52w range and prev
  // close don't change minute-by-minute \u2014 re-opening the same
  // sector skips the network entirely. Returns null on any failure.
  // Index of the last COMPLETED daily session in a NEWEST-FIRST candle
  // array, resolved by IST date \u2014 NOT a fixed index. This is the
  // single source of truth for "which bar is the previous close" and is
  // shared by both the sector-quote path (/historical-candle/, no
  // intraday pass) and the analyzer-header path (R.candles['1d'], which
  // DOES merge today's intraday bar).
  //
  // Why date-aware and not just candles[1]:
  //   \u2022 The plain /historical-candle/ endpoint usually OMITS the
  //     still-forming current-session bar, so during a live session
  //     candles[0] is ALREADY the last completed session (e.g. Friday
  //     on a Monday). Blindly taking candles[1] reads a bar TWO sessions
  //     stale (Thursday) \u2014 the "Monday +38 vs the real +11" bug.
  //   \u2022 When today's bar IS present (after close, or the analyzer's
  //     merged intraday supplement), candles[0] is today \u2192 the
  //     previous close is candles[1].
  // Returns -1 when no usable previous-session bar exists (fail safe).
  function _swPrevCloseIdx(candles) {
    if (!candles || !candles.length) return -1;
    var todayKey = istDateKeyForTs(Date.now());
    var newestIsToday = (istDateKeyForTs(candles[0][0]) === todayKey);
    var idx = newestIsToday ? 1 : 0;
    return (candles.length > idx) ? idx : -1;
  }

  // Parse Upstox historical-candle response into { prevClose,
  // yearHigh, yearLow }. Candles arrive newest-first as
  // [ts, O, H, L, C, V, OI] in both V2 and V3 envelopes.
  function _swParseCandles(candles) {
    if (!candles || candles.length === 0) return null;
    var hi = -Infinity;
    var lo =  Infinity;
    for (var i = 0; i < candles.length; i++) {
      var c = candles[i];
      var ch = +c[2];
      var cl = +c[3];
      if (isFinite(ch) && ch > hi) hi = ch;
      if (isFinite(cl) && cl < lo) lo = cl;
    }
    var prev = null;
    var prevIdx = _swPrevCloseIdx(candles);
    if (prevIdx >= 0) {
      var p = +candles[prevIdx][4];
      if (isFinite(p) && p > 0) prev = p;
    }
    return {
      prevClose: prev,
      yearHigh:  (hi !== -Infinity) ? hi : null,
      yearLow:   (lo !==  Infinity) ? lo : null
    };
  }

  // Lazy historical fetch with V3 \u2192 V2 fallback.
  //
  // V3 historical-candle (the preferred endpoint, lower latency
  // and a richer response) occasionally fails on weekends / after
  // hours or under rate-limit pressure when we fan-out 50+ stocks
  // for a sector. When that happens every row falls back to V2
  // ohlc.close \u2014 which on a non-trading day equals LTP, so
  // change% reads 0.00% and the signal column lights up N/A.
  //
  // To make that failure mode invisible, we try V3 first and
  // silently retry on V2 if V3 returns null. V2's response shape
  // is identical (candles are [ts, O, H, L, C, V, OI] newest-first),
  // so _swParseCandles handles both. Only when BOTH endpoints
  // return nothing do we propagate null \u2014 in which case the
  // V2 quote response provides whatever fallback values it can.
  async function fetchHistoricalContext(isin) {
    var cached = SECTOR_STATE.historyCache[isin];
    if (cached && (Date.now() - cached.ts) < SW_HISTORY_CACHE_TTL_MS) {
      return cached.context;
    }
    var token = getToken();
    if (!token) return null;
    var ikey = encodeURIComponent(swInstrumentKey(isin));
    var today = new Date();
    var toStr = today.toISOString().slice(0, 10);
    // 380 calendar days \u2248 52 weeks + buffer for weekends /
    // exchange holidays. Yields \~252 daily candles, ~20 KB.
    var fromDate = new Date(today.getTime() - 380 * 86400000);
    var fromStr = fromDate.toISOString().slice(0, 10);
    var hdrs = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };

    // ── V3 attempt ──
    try {
      var v3 = 'https://api.upstox.com/v3/historical-candle/'
             + ikey + '/days/1/' + toStr + '/' + fromStr;
      // Same /historical-candle endpoint as the scan — share the bucket so
      // sector-browse traffic can't quietly eat the 500/min budget and trip
      // a concurrent scan.
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var r3 = await fetch(v3, { headers: hdrs });
      if (r3.status === 429) {
        if (window._upstoxNote429) window._upstoxNote429('hist-context-v3');
      } else if (r3.ok) {
        var d3 = await r3.json();
        if (window._upstoxNoteOk) window._upstoxNoteOk();
        var ctx3 = _swParseCandles(d3 && d3.data && d3.data.candles);
        if (ctx3) {
          SECTOR_STATE.historyCache[isin] = { context: ctx3, ts: Date.now() };
          return ctx3;
        }
      }
    } catch (_) { /* fall through to V2 */ }

    // ── V2 fallback ──
    try {
      var v2 = 'https://api.upstox.com/v2/historical-candle/'
             + ikey + '/day/' + toStr + '/' + fromStr;
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var r2 = await fetch(v2, { headers: hdrs });
      if (!r2.ok) return null;
      var d2 = await r2.json();
      var ctx2 = _swParseCandles(d2 && d2.data && d2.data.candles);
      if (!ctx2) return null;
      SECTOR_STATE.historyCache[isin] = { context: ctx2, ts: Date.now() };
      return ctx2;
    } catch (_) { return null; }
  }

  // Per-stock rich quote fetch. Issues two API calls in parallel:
  //   1. /v2/market-quote/quotes \u2014 LTP + day OHLC + volume (real-time)
  //   2. /v3/historical-candle   \u2014 prev close + 52w high/low
  //     (derived from \~252 daily candles; cached 12h per ISIN)
  // Same wall-clock as a single call thanks to Promise.all + HTTP/2
  // multiplexing. The historical-derived fields fix two long-standing
  // gaps in the V2 quote response:
  //   \u2022 0.00% change on weekends / after-hours
  //     (V2 ohlc.close == last_price when market is closed)
  //   \u2022 N/A signal pill on every row
  //     (V2 doesn't reliably return year_high / year_low)
  // V2 fields are kept as a 2nd / 3rd-choice fallback for the rare
  // case the historical call fails or the symbol is too new.
  async function fetchSectorQuote(isin) {
    var token = getToken();
    if (!token) return null;
    try {
      var ikey = encodeURIComponent(swInstrumentKey(isin));
      var quoteUrl = 'https://api.upstox.com/v2/market-quote/quotes?instrument_key=' + ikey;
      var hdrs = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
      var results = await Promise.all([
        fetch(quoteUrl, { headers: hdrs }),
        fetchHistoricalContext(isin)
      ]);
      var quoteResp = results[0];
      var hist      = results[1] || {};
      // Retry once on 429 after a jittered backoff
      if (quoteResp.status === 429) {
        if (window._upstoxNote429) window._upstoxNote429('sector-quote');
        await new Promise(function (r) { setTimeout(r, 1500 + Math.random() * 1500); });
        quoteResp = await fetch(quoteUrl, { headers: hdrs });
      }
      if (!quoteResp.ok) return null;
      var d = await quoteResp.json();
      var data = d && d.data;
      if (!data) return null;
      var firstKey = Object.keys(data)[0];
      if (!firstKey) return null;
      var q = data[firstKey];
      if (!q || q.last_price == null) return null;
      var ltp = +q.last_price;
      // Previous trading day's close. Historical first, V2 fallback.
      var prev = (hist.prevClose != null) ? hist.prevClose
               : (q.close_price != null) ? +q.close_price
               : (q.ohlc && q.ohlc.close != null) ? +q.ohlc.close
               : null;
      // 52-week range. Historical first \u2014 always present for
      // any stock with \u22652 weeks of trading history.
      var yearHi = (hist.yearHigh != null) ? hist.yearHigh
                 : (q.year_high  != null) ? +q.year_high : null;
      var yearLo = (hist.yearLow  != null) ? hist.yearLow
                 : (q.year_low   != null) ? +q.year_low  : null;
      var change    = (prev != null) ? (ltp - prev) : null;
      var changePct = (prev != null && prev > 0) ? (change / prev * 100) : null;
      return {
        ltp:       ltp,
        prevClose: prev,
        change:    change,
        changePct: changePct,
        dayOpen:  (q.ohlc && q.ohlc.open != null) ? +q.ohlc.open : null,
        dayHigh:  (q.ohlc && q.ohlc.high != null) ? +q.ohlc.high : null,
        dayLow:   (q.ohlc && q.ohlc.low  != null) ? +q.ohlc.low  : null,
        yearHigh: yearHi,
        yearLow:  yearLo,
        volume:   (q.volume    != null) ? +q.volume    : null
      };
    } catch (_) { return null; }
  }

  // ── Quick swing setup detector (derived purely from quote data) ──
  // Returns { label, key, confidence, why } for a stock. The label
  // is a SETUP NAME (PULLBACK, BREAKOUT, AT HIGH, TREND, BASING,
  // WATCH, REBOUND?, WEAK, AVOID) \u2014 deliberately NOT BUY/SELL
  // verbs, because a single snapshot can't honestly issue a trade
  // recommendation. The colour pill conveys direction; the label
  // tells the user WHAT the setup looks like so they can decide
  // whether to click in and run the full multi-TF analyze().
  //
  // Logic is anchored on two principles every swing trader knows:
  //   1. NEVER chase a stock at its 52w high. Best case it's a
  //      breakout (high-risk, needs volume); worst case it's the
  //      exact local top. Either way, the reward/risk is bad.
  //   2. The textbook swing entry is a PULLBACK inside an uptrend
  //      \u2014 strong stock, above its rising MAs, dipping 3-8%
  //      from highs, looking ready to resume. Only this pattern
  //      earns the 'strong-buy' colour.
  // Confidence is floored at 35% (never claim certainty from one
  // snapshot) and ceilinged at 78% (no quick scan is ever a sure
  // thing \u2014 the deep analyze() is what raises confidence).
  function computeQuickSignal(quote) {
    var ltp    = quote.ltp;
    var chgPct = quote.changePct;
    var yLow   = quote.yearLow;
    var yHigh  = quote.yearHigh;
    if (ltp == null || yLow == null || yHigh == null || yHigh <= yLow) {
      return { label: 'N/A', key: 'na', confidence: 0, why: '52w range unavailable' };
    }
    var pos = (ltp - yLow) / (yHigh - yLow) * 100;
    if (pos < 0) pos = 0;
    if (pos > 100) pos = 100;
    var today  = isFinite(chgPct) ? chgPct : 0;
    var fromHi = (yHigh - ltp) / yHigh * 100;
    var fromLo = (ltp - yLow) / yLow * 100;
    var label, key, confidence, why;

    // ── Tier 1: at / near 52w high (pos \u2265 92%) ──
    // Default stance is WAIT. Only an active pullback warrants
    // a (modest) entry signal. A new-high break is BREAKOUT but
    // capped at 'watch' \u2014 we can't verify volume / base
    // structure from one snapshot.
    if (pos >= 92) {
      if (today <= -1.0) {
        label = 'PULLBACK'; key = 'buy'; confidence = 60;
        why = 'Pulling back from 52w high \u2014 possible entry forming. '
            + 'Click for full analysis.';
      } else if (today >= 2.0) {
        label = 'BREAKOUT'; key = 'watch'; confidence = 50;
        why = 'New 52w high break \u2014 high risk for swing. '
            + 'Needs volume + base confirmation (click in).';
      } else {
        label = 'AT HIGH'; key = 'hold'; confidence = 72;
        why = 'At 52w high \u2014 wait for pullback. '
            + 'Buying here = paying full retail at resistance.';
      }
    }
    // ── Tier 2: strong uptrend zone (70% \u2264 pos < 92%) ──
    // The classic swing-entry zone. A red day here IS the setup;
    // a green day means you missed today's window.
    else if (pos >= 70) {
      if (today <= -1.0) {
        label = 'PULLBACK'; key = 'strong-buy'; confidence = 72;
        why = 'Pullback inside uptrend \u2014 textbook swing entry zone. '
            + 'Click in to verify trend strength + 4 EMA exit.';
      } else if (today >= 1.5) {
        label = 'TREND'; key = 'hold'; confidence = 52;
        why = 'In uptrend, today extended \u2014 entry window for '
            + 'today has passed. Wait for a red bar.';
      } else {
        label = 'WATCH'; key = 'watch'; confidence = 55;
        why = 'Strong trend, no setup today \u2014 monitor for pullback.';
      }
    }
    // ── Tier 3: upper-mid range (50% \u2264 pos < 70%) ──
    // Often basing / consolidating. Not a clean entry zone.
    else if (pos >= 50) {
      if (today <= -2.0) {
        label = 'WEAK'; key = 'weak'; confidence = 55;
        why = 'Mid range, sharp red day \u2014 trend may be breaking.';
      } else if (today >= 2.0) {
        label = 'WATCH'; key = 'watch'; confidence = 50;
        why = 'Mid-range bounce \u2014 watch for higher-low confirmation.';
      } else {
        label = 'BASING'; key = 'hold'; confidence = 45;
        why = 'Mid range \u2014 possibly consolidating. '
            + 'No swing setup yet, wait for direction.';
      }
    }
    // ── Tier 4: lower-mid (30% \u2264 pos < 50%) ──
    // Below the midpoint of the year \u2014 no edge for long entries.
    else if (pos >= 30) {
      if (today >= 3.0) {
        label = 'REBOUND?'; key = 'watch'; confidence = 48;
        why = 'Lower-mid range, sharp green day \u2014 speculative '
            + 'reversal attempt. Needs follow-through.';
      } else if (today <= -2.0) {
        label = 'WEAK'; key = 'weak'; confidence = 60;
        why = 'Lower-mid range, still under pressure \u2014 downtrend bias.';
      } else {
        label = 'WAIT'; key = 'hold'; confidence = 42;
        why = 'Below year midpoint \u2014 no swing setup here. Wait.';
      }
    }
    // ── Tier 5: bottom 30% (10% \u2264 pos < 30%) ──
    // Danger zone. Only big bounces are worth even a WATCH.
    else if (pos >= 10) {
      if (today >= 3.0) {
        label = 'REBOUND?'; key = 'watch'; confidence = 50;
        why = 'Near 52w low, strong bounce \u2014 speculative reversal. '
            + 'Wait for confirmation before any entry.';
      } else {
        label = 'WEAK'; key = 'weak'; confidence = 65;
        why = 'Lower third of range \u2014 downtrend, avoid long entries.';
      }
    }
    // ── Tier 6: at 52w low (pos < 10%) ──
    // Falling-knife territory. Default AVOID.
    else {
      if (today >= 4.0) {
        label = 'REBOUND?'; key = 'watch'; confidence = 52;
        why = 'At 52w low with sharp bounce \u2014 highly speculative.';
      } else {
        label = 'AVOID'; key = 'avoid'; confidence = 78;
        why = 'At 52w low \u2014 falling-knife risk. Do not buy.';
      }
    }
    return { label: label, key: key, confidence: confidence, why: why };
  }

  // Load sectors.json (cache-first). Always resolves to the data;
  // throws only on first-load network failure with no cache present.
  async function loadSectors() {
    if (SECTOR_STATE.data)    return SECTOR_STATE.data;
    if (SECTOR_STATE.loading) return SECTOR_STATE.loading;
    SECTOR_STATE.loading = (async function () {
      try {
        var raw = localStorage.getItem(SW_SECTORS_CACHE_KEY);
        if (raw) {
          var cached = JSON.parse(raw);
          if (cached && cached.payload && cached.payload.sectors
              && cached.ts && (Date.now() - cached.ts < SW_SECTORS_TTL_MS)) {
            SECTOR_STATE.data = cached.payload;
            // Refresh in the background so edits to the file show up
            // on the next page load even if the TTL hasn't lapsed.
            fetchAndCacheSectors().catch(function () { /* silent */ });
            return cached.payload;
          }
        }
      } catch (_) { /* corrupt cache \u2014 fall through to network */ }
      var data = await fetchAndCacheSectors();
      SECTOR_STATE.data = data;
      return data;
    })().catch(function (err) {
      SECTOR_STATE.loadError = err;
      SECTOR_STATE.loading = null;
      throw err;
    });
    return SECTOR_STATE.loading;
  }

  async function fetchAndCacheSectors() {
    var resp = await fetch(SW_SECTORS_URL, { credentials: 'omit' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading ' + SW_SECTORS_URL);
    var data = await resp.json();
    if (!data || !Array.isArray(data.sectors)) {
      throw new Error('Invalid sectors.json (no sectors array)');
    }
    try {
      localStorage.setItem(SW_SECTORS_CACHE_KEY, JSON.stringify({
        ts: Date.now(), payload: data
      }));
    } catch (_) { /* quota \u2014 in-memory still works */ }
    return data;
  }

  // Fetch live quotes for every stock in the given sector. Fans out
  // one /market-quote/quotes call per stock in parallel so:
  //   \u2022 results stream into the cache as each call resolves
  //     \u2014 the panel re-renders progressively, no waiting for
  //     the slowest stock to come back before showing anything.
  //   \u2022 a partial failure doesn't poison the batch \u2014
  //     fetchSectorQuote returns null on error, so one bad ISIN
  //     just hides that stock without breaking the sector view.
  //   \u2022 an 8s overall cap means a stalled backend doesn't
  //     leave the user on the loading state forever.
  async function fetchSectorQuotes(sectorId) {
    // Need sectors.json for sector/index ids; "my-stocks" is the only
    // virtual group that can be queried before sectors.json loads.
    if (!SECTOR_STATE.data && sectorId !== 'my-stocks') {
      throw new Error('Sectors not loaded yet');
    }
    var sec = _swGetGroup(sectorId);
    if (!sec) throw new Error('Unknown sector/index: ' + sectorId);

    var now = Date.now();
    var needFetch = [];
    // Determine the working set:
    //  • Solo mode  → just the pinned stock (1 API call).
    //  • Otherwise  → the first N stocks revealed so far (paged, 10 at
    //                 a time) so opening a 400-800 stock sector never
    //                 fires hundreds of quote calls at once. "Load
    //                 next N" advances SECTOR_STATE.sectorPage and
    //                 re-enters here for the next slice.
    var workingSet;
    if (SECTOR_STATE.soloIsin) {
      workingSet = sec.stocks.filter(function (st) { return st.isin === SECTOR_STATE.soloIsin; });
    } else {
      var pageCount = Math.min(
        SECTOR_STATE.sectorPage[sectorId] || SW_QUOTE_PAGE,
        sec.stocks.length
      );
      workingSet = sec.stocks.slice(0, pageCount);
    }
    workingSet.forEach(function (st) {
      var c = SECTOR_STATE.quoteCache[st.isin];
      if (!c || (now - c.ts) >= SW_QUOTE_CACHE_TTL_MS) needFetch.push(st);
    });
    if (needFetch.length === 0) return;

    if (SECTOR_STATE.quoteInFlight[sectorId]) return SECTOR_STATE.quoteInFlight[sectorId];

    // Respect the master pause toggle. We let cached quotes still
    // render \u2014 just don't fire NEW fetches. Throws an error that
    // the sector panel renderer treats specially (renders an
    // amber "paused" stub instead of a red error banner).
    if (swIsApiPaused()) throw swPausedError();

    var token = getToken();
    if (!token) throw new Error('Connect your access token to load live prices.');

    var FETCH_TIMEOUT_MS = 20000;
    var BATCH_SIZE = 6;
    var promise = (async function () {
      // Batched concurrency: fetch quotes in groups of BATCH_SIZE
      // instead of all at once. Prevents Upstox 429 rate-limit
      // errors that silently dropped every quote in the sector.
      // Each batch renders as it completes so the user sees
      // prices fill in progressively.
      var timer;
      var timedOut = false;
      var timeoutPromise = new Promise(function (_, reject) {
        timer = setTimeout(function () {
          timedOut = true;
          reject(new Error('Took too long \u2014 click the sector again to retry.'));
        }, FETCH_TIMEOUT_MS);
      });

      async function runBatches() {
        for (var b = 0; b < needFetch.length; b += BATCH_SIZE) {
          if (timedOut) return;
          if (SECTOR_STATE.activeSector !== sectorId) return;
          var batch = needFetch.slice(b, b + BATCH_SIZE);
          await Promise.all(batch.map(function (st) {
            return fetchSectorQuote(st.isin).then(function (quote) {
              if (quote) {
                SECTOR_STATE.quoteCache[st.isin] = { quote: quote, ts: Date.now() };
                if (SECTOR_STATE.activeSector === sectorId) {
                  renderSectorPanel();
                }
              }
              return quote;
            }).catch(function () { return null; });
          }));
        }
      }

      try {
        await Promise.race([runBatches(), timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(function () { delete SECTOR_STATE.quoteInFlight[sectorId]; });

    SECTOR_STATE.quoteInFlight[sectorId] = promise;
    return promise;
  }

  // Click handler for any picker card (sector, index, or My Stocks).
  // Toggles selection, fetches LTPs (with loading state), then renders
  // the filtered stock list panel. Re-clicking the same card collapses it.
  async function swingPickSector(sectorId) {
    // My Stocks doesn't need sectors.json; everything else does.
    if (sectorId !== 'my-stocks' && !SECTOR_STATE.data) {
      try { await loadSectors(); }
      catch (e) { renderSectorError(e); return; }
    }
    // Toggle off if same card clicked again
    if (SECTOR_STATE.activeSector === sectorId) {
      SECTOR_STATE.activeSector = null;
      SECTOR_STATE.filterText    = '';
      SECTOR_STATE.signalFilter  = null;
      SECTOR_STATE.confidenceMin = 0;
      SECTOR_STATE.soloIsin      = null;   // collapsing exits solo mode
      renderSectorGrid();
      renderSectorPanel();
      return;
    }
    SECTOR_STATE.activeSector = sectorId;
    // Reset per-panel UI state when opening a different group
    // \u2014 a search query / signal filter / confidence floor
    // from one group shouldn't carry over to another.
    SECTOR_STATE.filterText      = '';
    SECTOR_STATE.signalFilter    = null;
    SECTOR_STATE.confidenceMin   = 0;
    // A manual sector-card click always exits solo mode and starts the
    // paged browse at the first page (10 stocks).
    SECTOR_STATE.soloIsin        = null;
    SECTOR_STATE.sectorPage[sectorId] = SW_QUOTE_PAGE;
    // Keep _focusedIsin if set by swingPickGlobalStock just before
    // this call; clear it only for manual sector switches.
    if (!SECTOR_STATE._scrollDeadline || Date.now() > SECTOR_STATE._scrollDeadline) {
      SECTOR_STATE._focusedIsin = null;
    }
    // Reset auto-fib scan state for the new sector.
    if (typeof _swFibAutoState !== 'undefined') {
      _swFibAutoState.doneSector    = null;
      _swFibAutoState.runningSector = null;
      _swFibAutoState.results       = [];
      _swFibAutoState.signalFilter  = null;
    }
    renderSectorGrid();
    renderSectorPanel(); // loading state
    // The detail panel now lives BELOW the Today's Setups table, so a
    // plain sector-card click would otherwise render off-screen. Bring
    // it into view. Focused-row picks (Today's Setups / global search)
    // set _focusedIsin and run their own row-scroll, so skip those.
    if (!SECTOR_STATE._focusedIsin) {
      var _panelEl = document.getElementById('sw-sector-panel');
      if (_panelEl && _panelEl.scrollIntoView) {
        _panelEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }
    // My Stocks with zero entries: show empty-state instead of fetching.
    var grp = _swGetGroup(sectorId);
    if (grp && grp.stocks.length === 0) {
      renderSectorPanel();
      return;
    }
    try {
      await fetchSectorQuotes(sectorId);
      // Active group might have changed if user clicked another
      // card before quotes returned. Only render if still relevant.
      if (SECTOR_STATE.activeSector === sectorId) renderSectorPanel();
    } catch (e) {
      if (SECTOR_STATE.activeSector === sectorId) renderSectorPanelError(e);
    }
  }

  // Reveal + fetch the next page (SW_QUOTE_PAGE) of stocks in the
  // active sector. Each call only fetches the NEW slice (earlier pages
  // are already cached), so every click is at most SW_QUOTE_PAGE quote
  // calls. Waits for any in-flight page fetch first so rapid double
  // clicks don't get swallowed by the per-sector in-flight guard.
  window.swingLoadMoreSectorStocks = function () {
    var sid = SECTOR_STATE.activeSector;
    if (!sid) return;
    var grp = _swGetGroup(sid);
    if (!grp) return;
    var cur = SECTOR_STATE.sectorPage[sid] || SW_QUOTE_PAGE;
    SECTOR_STATE.sectorPage[sid] = Math.min(cur + SW_QUOTE_PAGE, grp.stocks.length);
    renderSectorPanel();   // reveal the new rows immediately (as "—" until priced)
    var run = function () {
      return fetchSectorQuotes(sid).then(function () {
        if (SECTOR_STATE.activeSector === sid) renderSectorPanel();
      });
    };
    var inflight = SECTOR_STATE.quoteInFlight[sid];
    (inflight ? inflight.then(run, run) : run()).catch(function (e) {
      if (SECTOR_STATE.activeSector === sid) renderSectorPanelError(e);
    });
  };

  // Exit solo mode (global-search single-stock pin) and fall back to
  // the paged browse of the parent sector, fetching its first page.
  window.swingClearSolo = function () {
    var sid = SECTOR_STATE.activeSector;
    SECTOR_STATE.soloIsin = null;
    SECTOR_STATE._focusedIsin = null;
    if (!sid) { renderSectorPanel(); return; }
    if (!SECTOR_STATE.sectorPage[sid]) SECTOR_STATE.sectorPage[sid] = SW_QUOTE_PAGE;
    renderSectorPanel();
    var run = function () {
      return fetchSectorQuotes(sid).then(function () {
        if (SECTOR_STATE.activeSector === sid) renderSectorPanel();
      });
    };
    var inflight = SECTOR_STATE.quoteInFlight[sid];
    (inflight ? inflight.then(run, run) : run()).catch(function (e) {
      if (SECTOR_STATE.activeSector === sid) renderSectorPanelError(e);
    });
  };

  // Click handler for a stock row inside the sector panel. Sets
  // STATE.selected and triggers the same analyze() flow that the
  // old picker used. Scrolls the result panel into view once it
  // renders so the chart isn't off-screen.
  function swingPickSectorStock(isin) {
    if (!SECTOR_STATE.activeSector) return;
    if (!SECTOR_STATE.data && SECTOR_STATE.activeSector !== 'my-stocks') return;
    var sec = _swGetGroup(SECTOR_STATE.activeSector);
    if (!sec) return;
    var stock = sec.stocks.find(function (st) { return st.isin === isin; });
    if (!stock) return;
    STATE.selected = { sym: stock.sym, isin: stock.isin, name: stock.name };
    if (FIB_STATE) { FIB_STATE.pendingFib = null; FIB_STATE.pendingTf = null; }
    // A sector-table click always opens the chart on DAILY — the primary
    // swing-trade timeframe (2026-06-02; was Weekly) — regardless of which
    // TF the last bulk scan ran on. The verdict/Risk card below is driven by
    // the independent Recommendation TF, so the chart TF can default to daily
    // without affecting the signal. Clearing requestedChartTf lets
    // renderResult fall through to its '1d' default.
    STATE.requestedChartTf = null;
    // Mirror the selection into the Today's Setups table so the same stock
    // reads selected in BOTH tables (the sector row is already highlighted
    // by the tbody click handler). Reverse of the sync swingPickTodayRow does.
    try {
      var _tr = document.querySelectorAll('.sw-today-rows .sw-today-row');
      for (var _ti = 0; _ti < _tr.length; _ti++) {
        _tr[_ti].classList.toggle('sw-today-row--selected',
          _tr[_ti].getAttribute('data-isin') === isin);
      }
    } catch (_) {}
    _swApplyScanModeOverlays();
    analyze().then(function () {
      // Navigate straight to the chart once the stock is analyzed, so a
      // sector-row click takes the user to the chart — same behaviour as
      // the Today's Setups row handler (swingPickTodayRow).
      try {
        var chartEl = document.querySelector('#sw-result .sw-chart-section')
          || document.getElementById('sw-chart')
          || document.getElementById('sw-result');
        if (chartEl && chartEl.scrollIntoView) {
          chartEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (_) {}
    }).catch(function () {});
  }

  // ── Sector / index / my-stocks picker grid ──
  // Builds three labeled rows inside #sw-sector-grid:
  //   1. MY STOCKS row \u2014 the gold custom watchlist card +
  //      an inline "+ Add custom stock" tile. Always shown.
  //   2. INDICES   row \u2014 the 4 NSE-index cards (Nifty 50,
  //      Next 50, Bank, IT). Shown if data.indices is present.
  //   3. SECTORS   row \u2014 the 12 industry sector cards.
  // The shared `.sw-sector-card` styling carries each card; row
  // ids let CSS apply per-row accents (gold for My Stocks,
  // blue tint for Indices, default for Sectors).
  function renderSectorGrid() {
    var host = document.getElementById('sw-sector-grid');
    if (!host) return;
    if (!SECTOR_STATE.data) {
      // Loading state \u2014 keep whatever was there (loader text in HTML).
      return;
    }

    var act = SECTOR_STATE.activeSector;

    // Count how many of a group's stocks carry a price snapshot that
    // sits inside the live tradeable band (SW_MIN_PRICE / SW_MAX_PRICE,
    // both config-overridable). Prices come from data/sectors.json
    // (Upstox LTP snapshot baked in at generation time — see
    // scripts/generate-sectors.py). A stock with no `price` field is
    // counted as "unpriced", never as in/out of band, so the card can
    // honestly fall back to the plain total when the snapshot is absent
    // (old file, or names Upstox couldn't quote). This is a DISPLAY
    // estimate only — the scan itself still applies the live price gate
    // per stock, so a stale snapshot never leaks a bad signal.
    function _swBandMeta(stocks, band) {
      var arr = stocks || [];
      var bMin = (band && isFinite(+band.min)) ? +band.min : SW_MIN_PRICE;
      var bMax = (band && isFinite(+band.max)) ? +band.max : SW_MAX_PRICE;
      var total = arr.length, priced = 0, inBand = 0;
      for (var i = 0; i < total; i++) {
        var p = arr[i] ? +arr[i].price : NaN;
        if (isFinite(p) && p > 0) {
          priced++;
          if (p >= bMin && p <= bMax) inBand++;
        }
      }
      return { total: total, priced: priced, inBand: inBand };
    }

    var cardHtml = function (id, name, stocks, accentClass) {
      var active = (act === id) ? ' sw-sector-card-active' : '';
      var slugClass = accentClass || (' sw-sector-card-' + id);
      var icon = _swSectorIcon(id);
      // A group may narrow to its own band (High Liquidity → ₹500–₹2,000);
      // everything else uses the global band. The card counts + labels match
      // whatever band that card actually scans against.
      var band = _swBandFor(id);
      var bandNarrowed = (band.min !== SW_MIN_PRICE || band.max !== SW_MAX_PRICE);
      var bandTxt = '\u20B9' + band.min.toLocaleString('en-IN')
                  + '\u2013\u20B9' + band.max.toLocaleString('en-IN');
      var meta = _swBandMeta(stocks, band);
      var metaTxt, metaTitle = '';
      if (meta.priced > 0) {
        metaTxt = (bandNarrowed ? meta.inBand + ' stocks \u00b7 ' + bandTxt
                                : meta.inBand + ' / ' + meta.total + ' stocks');
        metaTitle = meta.inBand + ' of ' + meta.total + ' priced within '
                  + bandTxt + (bandNarrowed ? ' (this screen\u2019s band)' : ' (the swing scan band)')
                  + (meta.total - meta.priced > 0
                      ? ' \u00b7 ' + (meta.total - meta.priced) + ' have no price snapshot'
                      : '') + '.';
      } else {
        metaTxt = meta.total + ' stocks' + (bandNarrowed ? ' \u00b7 ' + bandTxt : '');
      }
      return '<button type="button" class="sw-sector-card' + slugClass + active + '"'
           +   ' onclick="swingPickSector(\'' + id + '\')"'
           +   ' aria-pressed="' + (active ? 'true' : 'false') + '">'
           +   '<div class="sw-sector-card-icon" aria-hidden="true">' + icon + '</div>'
           +   '<div class="sw-sector-card-body">'
           +     '<div class="sw-sector-card-name">' + escapeHtml(name) + '</div>'
           +     '<div class="sw-sector-card-meta"' + (metaTitle ? ' title="' + escapeHtml(metaTitle) + '"' : '') + '>' + escapeHtml(metaTxt) + '</div>'
           +   '</div>'
           + '</button>';
    };

    // ── 1. My Stocks row ──
    var customCount = (SECTOR_STATE.customStocks || []).length;
    var myStocksCard = cardHtml('my-stocks', 'My Stocks',
      SECTOR_STATE.customStocks || [], ' sw-sector-card-mystocks');
    var addStockTile = ''
      + '<button type="button" class="sw-sector-card sw-sector-card-addnew"'
      +   ' onclick="swingOpenAddStock()"'
      +   ' aria-label="Add a custom stock to your watchlist">'
      +   '<div class="sw-sector-card-icon" aria-hidden="true">'
      +     _swIconLine('<path d="M12 5v14M5 12h14"/>')
      +   '</div>'
      +   '<div class="sw-sector-card-body">'
      +     '<div class="sw-sector-card-name">Add custom stock</div>'
      +     '<div class="sw-sector-card-meta">Search any NSE/BSE symbol</div>'
      +   '</div>'
      + '</button>';
    var myRow = ''
      + '<div class="sw-grid-row sw-grid-row-mystocks">'
      +   '<div class="sw-grid-row-head">'
      +     '<span class="sw-grid-row-title">My Watchlist</span>'
      +     '<span class="sw-grid-row-meta">'
      +       (customCount === 0
                ? 'No saved stocks yet \u2014 search any NSE/BSE symbol and add it'
                : customCount + ' saved \u00b7 stored locally on this device')
      +     '</span>'
      +   '</div>'
      +   '<div class="sw-grid-row-body">' + myStocksCard + addStockTile + '</div>'
      + '</div>';

    // ── 2. Screens row (band-carrying groups, e.g. High Liquidity) ──
    // A group with its own `band` is a curated SCREEN, not an NSE benchmark,
    // so it gets its own row (and is filtered out of the Indices row below).
    var allIndices = SECTOR_STATE.data.indices || [];
    var screenGroups = allIndices.filter(function (g) { return g && g.band; });
    var indices = allIndices.filter(function (g) { return !(g && g.band); });

    var screensRow = '';
    if (screenGroups.length > 0) {
      var screenCards = screenGroups.map(function (sg) {
        return cardHtml(sg.id, sg.name, sg.stocks, ' sw-sector-card-screen');
      }).join('');
      screensRow = ''
        + '<div class="sw-grid-row sw-grid-row-screens">'
        +   '<div class="sw-grid-row-head">'
        +     '<span class="sw-grid-row-title">Liquidity Screen</span>'
        +     '<span class="sw-grid-row-meta">'
        +       'High-turnover names only \u00b7 scanned within the screen\u2019s price band'
        +     '</span>'
        +   '</div>'
        +   '<div class="sw-grid-row-body">' + screenCards + '</div>'
        + '</div>';
    }

    // ── 3. Indices row ──
    var indicesRow = '';
    if (indices.length > 0) {
      var indexCards = indices.map(function (ix) {
        return cardHtml(ix.id, ix.name, ix.stocks, ' sw-sector-card-index');
      }).join('');
      indicesRow = ''
        + '<div class="sw-grid-row sw-grid-row-indices">'
        +   '<div class="sw-grid-row-head">'
        +     '<span class="sw-grid-row-title">NSE Indices</span>'
        +     '<span class="sw-grid-row-meta">'
        +       indices.length + ' benchmarks \u00b7 same swing rules apply'
        +     '</span>'
        +   '</div>'
        +   '<div class="sw-grid-row-body">' + indexCards + '</div>'
        + '</div>';
    }

    // ── 3. Sectors row ──
    var sectorCards = SECTOR_STATE.data.sectors.map(function (sec) {
      return cardHtml(sec.id, sec.name, sec.stocks, null);
    }).join('');
    var sectorsRow = ''
      + '<div class="sw-grid-row sw-grid-row-sectors">'
      +   '<div class="sw-grid-row-head">'
      +     '<span class="sw-grid-row-title">Industry Sectors</span>'
      +   '</div>'
      +   '<div class="sw-grid-row-body">' + sectorCards + '</div>'
      + '</div>';

    host.innerHTML = myRow + screensRow + indicesRow + sectorsRow;
  }

  // Format a number as Indian rupees with locale-aware grouping.
  // Always 2 decimals so day-low / day-high / 52w endpoints align.
  function _swFmtMoney(n) {
    if (n == null || !isFinite(n)) return '\u2014';
    return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Format a share-volume integer as Indian-style abbreviated counts.
  // 12,345,678 \u2192 "1.23 Cr", 234,567 \u2192 "2.35 L", 4,321 \u2192 "4.3K".
  function _swFmtVolume(n) {
    if (n == null || !isFinite(n) || n <= 0) return '';
    if (n >= 1e7)  return (n / 1e7).toFixed(2) + ' Cr';
    if (n >= 1e5)  return (n / 1e5).toFixed(2) + ' L';
    if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K';
    return Math.round(n).toLocaleString('en-IN');
  }

  // Render a single populated stock row. Layout:
  //   line 1: SYM \u00b7 NAME \u00b7 SIGNAL pill+conf% \u00b7 LTP+change%
  //   line 2: 52w range bar (full width) + day range + volume chips
  // The whole thing is a button so keyboard / click both work.
  function _swStockRowHtml(st, quote, isSelected, opts) {
    opts = opts || {};
    var cls = 'sw-stock-row' + (isSelected ? ' sw-stock-row-selected' : '');
    if (opts.removable) cls += ' sw-stock-row-removable';
    var ltp     = quote.ltp;
    var chgPct  = quote.changePct;
    var dayLow  = quote.dayLow;
    var dayHigh = quote.dayHigh;
    var yLow    = quote.yearLow;
    var yHigh   = quote.yearHigh;

    // Quick swing signal pill \u2014 leftmost data column so it
    // anchors the eye when scanning. `title` attr exposes the
    // underlying numbers as a tooltip for trust.
    var sig = computeQuickSignal(quote);
    // Tooltip makes the chip's purpose unambiguous: it's a SHAPE
    // DETECTOR from a single quote snapshot, not a trade decision.
    // The deep BUY/WAIT verdict lives in the analysis panel below
    // and runs through multi-TF gates that this chip cannot see.
    var sigTitle = 'Quick screen \u2014 ' + sig.label + ' shape \u00b7 ' + sig.why
                 + '  |  This is a snapshot-based shape detector, NOT a trade decision. '
                 + 'Click the stock for the full multi-timeframe BUY / WAIT recommendation.';
    var signalHtml = ''
      + '<div class="sw-signal sw-signal-' + sig.key + '" title="' + escapeHtml(sigTitle) + '">'
      +   '<span class="sw-signal-label">' + sig.label + '</span>'
      +   (sig.confidence > 0
          ? '<span class="sw-signal-conf">' + sig.confidence + '%</span>'
          : '')
      + '</div>';

    // Today's change pill. Sign + colour + arrow. Falls back to
    // a dash if we have no prev close at all (very rare now that
    // we fetch the historical prev close in parallel with the quote).
    var chgHtml;
    if (chgPct == null || !isFinite(chgPct)) {
      chgHtml = '<span class="sw-stock-row-chg sw-stock-row-chg-flat">\u2014</span>';
    } else {
      var dir   = chgPct > 0.005 ? 'up' : (chgPct < -0.005 ? 'down' : 'flat');
      var arrow = dir === 'up' ? '\u25B2' : dir === 'down' ? '\u25BC' : '\u2022';
      var sign  = chgPct > 0 ? '+' : '';
      chgHtml = '<span class="sw-stock-row-chg sw-stock-row-chg-' + dir + '">'
              +   arrow + ' ' + sign + chgPct.toFixed(2) + '%'
              + '</span>';
    }

    // Day range cell \u2014 absolute prices + intraday volatility %.
    var dayRangeHtml = '';
    if (dayLow != null && dayHigh != null && dayHigh > dayLow) {
      var dayRangePct = (dayHigh - dayLow) / ltp * 100;
      dayRangeHtml = '<span class="sw-stock-row-detail" title="Today\'s high \u2212 low">'
                   +   '<span class="sw-detail-key">Day</span> &#8377;' + _swFmtMoney(dayLow)
                   +   ' \u2013 &#8377;' + _swFmtMoney(dayHigh)
                   +   ' <span class="sw-detail-aside">(' + dayRangePct.toFixed(1) + '%)</span>'
                   + '</span>';
    }

    // Volume cell.
    var volumeHtml = '';
    if (quote.volume != null && quote.volume > 0) {
      volumeHtml = '<span class="sw-stock-row-detail" title="Today\'s traded volume (shares)">'
                 +   '<span class="sw-detail-key">Vol</span> ' + _swFmtVolume(quote.volume)
                 + '</span>';
    }

    // 52-week range bar widget \u2014 compact horizontal: [low]
    // [-track with dot-] [high]. Pos label moves INLINE to the
    // right of the bar (was on its own line above the bar before;
    // dropped for vertical density).
    var rangeBarHtml = '';
    var posLabelHtml = '';
    if (yLow != null && yHigh != null && yHigh > yLow) {
      var pos = (ltp - yLow) / (yHigh - yLow) * 100;
      if (pos < 0) pos = 0;
      if (pos > 100) pos = 100;
      var fromHi = (yHigh - ltp) / yHigh * 100;
      var fromLo = (ltp - yLow) / yLow * 100;
      var posLabel;
      if (pos >= 90)      posLabel = 'near 52w high';
      else if (pos >= 70) posLabel = 'upper third';
      else if (pos >= 30) posLabel = 'mid range';
      else if (pos >= 10) posLabel = 'lower third';
      else                posLabel = 'near 52w low';
      var fromTxt = (fromHi <= fromLo)
        ? '\u2212' + fromHi.toFixed(1) + '% from high'
        : '+' + fromLo.toFixed(1) + '% from low';
      rangeBarHtml = ''
        + '<div class="sw-stock-row-52w" title="52-week trading range (low \u2014 current \u2014 high)">'
        +   '<span class="sw-detail-key">52w</span>'
        +   '<span class="sw-52w-lo">&#8377;' + _swFmtMoney(yLow) + '</span>'
        +   '<div class="sw-52w-track">'
        +     '<div class="sw-52w-fill" style="width:' + pos.toFixed(1) + '%"></div>'
        +     '<div class="sw-52w-dot"  style="left:'  + pos.toFixed(1) + '%"></div>'
        +   '</div>'
        +   '<span class="sw-52w-hi">&#8377;' + _swFmtMoney(yHigh) + '</span>'
        + '</div>';
      posLabelHtml = '<span class="sw-stock-row-detail sw-52w-pos"'
                   +   ' title="Where today\'s price sits inside the 52-week range">'
                   +   '<span class="sw-detail-key">Pos</span> '
                   +   posLabel + ' \u00b7 ' + fromTxt
                   + '</span>';
    }

    // Single inline bottom row: bar widget + position label + day
    // range + volume. Everything on ONE line keeps the row to ~62px
    // total height (was ~93px when this was three stacked lines).
    var botInnerHtml = rangeBarHtml + posLabelHtml + dayRangeHtml + volumeHtml;
    var botHtml = botInnerHtml
      ? '<div class="sw-stock-row-bot">' + botInnerHtml + '</div>'
      : '';

    // Remove control (My Stocks only). Click bubbling is stopped
    // so removing a stock doesn't also "pick" it for analysis.
    // Using a span+onclick (not a nested <button>) sidesteps the
    // invalid nested-interactive markup that some screen readers
    // complain about while still keeping it keyboard-clickable.
    var removeHtml = opts.removable
      ? ('<span class="sw-stock-row-remove" role="button" tabindex="0"'
          + ' aria-label="Remove ' + escapeHtml(st.sym) + ' from My Stocks"'
          + ' title="Remove from My Stocks"'
          + ' onclick="event.stopPropagation();swingRemoveCustomStock(\'' + st.isin + '\')"'
          + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();swingRemoveCustomStock(\'' + st.isin + '\');}">'
          + '&times;</span>')
      : '';

    return ''
      + '<button type="button" class="' + cls + '"'
      +   ' onclick="swingPickSectorStock(\'' + st.isin + '\')">'
      +   '<div class="sw-stock-row-top">'
      +     '<span class="sw-stock-row-sym">'  + escapeHtml(st.sym)  + '</span>'
      +     '<span class="sw-stock-row-name">' + escapeHtml(st.name) + '</span>'
      +     signalHtml
      +     '<span class="sw-stock-row-price">'
      +       '<span class="sw-stock-row-ltp">&#8377;' + _swFmtMoney(ltp) + '</span>'
      +       chgHtml
      +     '</span>'
      +   '</div>'
      +   botHtml
      +   removeHtml
      + '</button>';
  }

  // Sort the loaded rows by '<field>-<dir>' key. `dir = 'asc'`
  // returns smallest first; `dir = 'desc'` returns largest first.
  // For the SIGNAL field, "largest" means STRONG BUY \u2192 AVOID
  // by score rank, then by confidence as tie-breaker.
  // Bounce-status ranking for the "Retracement / Signal" column sort —
  // best setups (golden-pocket bounce) rank highest so a desc sort floats
  // the actionable rows to the top.
  var _SW_BOUNCE_RANK = { BOUNCE: 6, RECOVERY: 5, FORMING: 4, RECOVERED: 3, ABOVE: 2, FALLING: 1 };

  // Sort the sector-table rows in place-ish (operates on a copy so the
  // caller's array is untouched). Row shape is the flat object built in
  // renderSectorPanel — { sym, isin, name, ltp, change, yearHigh, yearLow } —
  // and the Fib-derived columns (Swing Low/High, Depth, Signal) read from
  // the per-render `fibMap`. An empty/absent sortKey is a no-op so rows
  // keep their natural order until the user clicks a header.
  function _swSortRows(rows, sortKey, fibMap) {
    if (!sortKey) return rows;
    var idx = sortKey.lastIndexOf('-');
    var field = idx > 0 ? sortKey.slice(0, idx) : sortKey;
    var dir   = idx > 0 ? sortKey.slice(idx + 1) : 'desc';
    var sign  = (dir === 'asc') ? 1 : -1;
    fibMap = fibMap || {};

    // Missing values sort to the bottom regardless of direction would be
    // ideal, but a simple -Infinity keeps unpriced rows together at the
    // asc-end / desc-bottom, which reads fine while quotes stream in.
    function n(v) { return (v == null || !isFinite(v)) ? -Infinity : v; }
    function pos52w(r) {
      return (r.yearHigh != null && r.yearLow != null && r.yearHigh > r.yearLow && r.ltp != null)
        ? (r.ltp - r.yearLow) / (r.yearHigh - r.yearLow)
        : -Infinity;
    }
    function swLowOf(r)  { var f = fibMap[r.isin]; return n(f ? f.swLow  : r.yearLow); }
    function swHighOf(r) { var f = fibMap[r.isin]; return n(f ? f.swHigh : r.yearHigh); }
    function depthOf(r) {
      var f = fibMap[r.isin];
      return (f && isFinite(f.swHigh) && isFinite(f.swLow) && f.swHigh > f.swLow && isFinite(f.currentPx))
        ? ((f.swHigh - f.currentPx) / (f.swHigh - f.swLow)) * 100
        : -Infinity;
    }
    function sigOf(r) { var f = fibMap[r.isin]; return f ? (_SW_BOUNCE_RANK[f.bounceStatus] || 0) : -1; }

    var cmp;
    if      (field === 'sym')    cmp = function (a, b) { return sign * String(a.sym || '').localeCompare(String(b.sym || '')); };
    else if (field === 'ltp')    cmp = function (a, b) { return sign * (n(a.ltp)    - n(b.ltp)); };
    else if (field === 'change') cmp = function (a, b) { return sign * (n(a.change) - n(b.change)); };
    else if (field === '52w')    cmp = function (a, b) { return sign * (pos52w(a)   - pos52w(b)); };
    else if (field === 'swlow')  cmp = function (a, b) { return sign * (swLowOf(a)  - swLowOf(b)); };
    else if (field === 'swhigh') cmp = function (a, b) { return sign * (swHighOf(a) - swHighOf(b)); };
    else if (field === 'depth')  cmp = function (a, b) { return sign * (depthOf(a)  - depthOf(b)); };
    else if (field === 'signal') cmp = function (a, b) { return sign * (sigOf(a)    - sigOf(b)); };
    else return rows;

    // Array.prototype.sort is stable in every engine we target, so ties
    // preserve the incoming (natural) order — no jitter between renders.
    return rows.slice().sort(cmp);
  }

  // aria-sort attribute value for the active column (none | ascending |
  // descending) — keeps the sortable headers announced correctly to AT.
  function _swAriaSort(field, activeKey) {
    var idx = (activeKey || '').lastIndexOf('-');
    var aField = idx > 0 ? activeKey.slice(0, idx) : '';
    var aDir   = idx > 0 ? activeKey.slice(idx + 1) : 'desc';
    if (aField !== field) return 'none';
    return aDir === 'asc' ? 'ascending' : 'descending';
  }

  // Sort indicator glyph for a column header. Active column gets a
  // filled arrow in the info colour; inactive columns get a dim
  // double arrow so the user knows the column IS sortable.
  function _swSortArrow(field, activeKey) {
    var idx = (activeKey || '').lastIndexOf('-');
    var aField = idx > 0 ? activeKey.slice(0, idx) : '';
    var aDir   = idx > 0 ? activeKey.slice(idx + 1) : 'desc';
    if (aField !== field) {
      return '<span class="sw-th-arrow sw-th-arrow-idle">\u21F5</span>';
    }
    var glyph = (aDir === 'asc') ? '\u25B2' : '\u25BC';
    return '<span class="sw-th-arrow sw-th-arrow-active">' + glyph + '</span>';
  }

  function renderSectorPanel() {
    var host = document.getElementById('sw-sector-panel');
    if (!host) return;
    if (!SECTOR_STATE.activeSector) { host.innerHTML = ''; return; }
    var sec = _swGetGroup(SECTOR_STATE.activeSector);
    if (!sec) { host.innerHTML = ''; return; }

    // My Stocks empty state.
    if (sec.kind === 'custom' && sec.stocks.length === 0) {
      host.innerHTML = ''
        + '<div class="sw-sector-panel">'
        +   '<div class="sw-sector-panel-header">'
        +     '<div class="sw-sector-panel-title">'
        +       '<span class="sw-sector-panel-icon" aria-hidden="true">' + _swSectorIcon('my-stocks') + '</span>'
        +       '<span class="sw-sector-panel-name">My Stocks</span>'
        +       '<span class="sw-sector-panel-meta">no stocks saved yet</span>'
        +     '</div>'
        +   '</div>'
        +   '<div class="sw-sector-panel-empty">'
        +     '<p>Your custom watchlist is empty.</p>'
        +     '<p>Add any NSE/BSE stock by symbol \u2014 we\u2019ll auto-fill the ISIN and company name from the Upstox instruments master.</p>'
        +     '<button type="button" class="sw-help-modal-done" style="margin-top:14px"'
        +       ' onclick="swingOpenAddStock()">+ ADD CUSTOM STOCK</button>'
        +   '</div>'
        + '</div>';
      return;
    }

    // If a fib scan is in-flight for this sector, don't nuke the DOM.
    if (_swFibAutoState.runningSector === sec.id) return;

    var icon  = _swSectorIcon(sec.id);
    var scanDone = (_swFibAutoState.doneSector === sec.id);

    // ── Working set: solo (1 stock) or paged window (first N) ──
    // Solo mode pins to the globally-searched stock; otherwise we only
    // build rows for the stocks revealed so far (paged 10 at a time),
    // so a 400-stock sector renders ~10 rows, not 400 mostly-empty ones.
    var grandTotal = sec.stocks.length;
    var isSolo = !!SECTOR_STATE.soloIsin;
    var revealedCount, sourceStocks;
    if (isSolo) {
      sourceStocks = sec.stocks.filter(function (st) { return st.isin === SECTOR_STATE.soloIsin; });
      revealedCount = sourceStocks.length;
    } else {
      revealedCount = Math.min(SECTOR_STATE.sectorPage[sec.id] || SW_QUOTE_PAGE, grandTotal);
      sourceStocks = sec.stocks.slice(0, revealedCount);
    }
    var total = sourceStocks.length;

    // Gather stocks with whatever quote data is available.
    var rows = sourceStocks.map(function (st) {
      var c = SECTOR_STATE.quoteCache[st.isin];
      var q = (c && c.quote) ? c.quote : {};
      return {
        sym: st.sym, isin: st.isin, name: st.name,
        ltp: q.ltp || null,
        change: q.change || null,
        yearHigh: q.yearHigh || null,
        yearLow: q.yearLow || null
      };
    });
    // Price-band filter (₹SW_MIN_PRICE–₹SW_MAX_PRICE). The swing universe
    // only trades names in this band, so a stock priced outside it (₹13
    // Idea, ₹179 HFCL, ₹2,9xx+ names, etc.) is dropped from the sector
    // browse to match the scan universe. The JSON itself has no price
    // field, so this filter is the live-price equivalent of pruning the
    // list. Rows not yet priced (no quote) are kept and re-filtered on
    // the next render once their LTP arrives.
    // SOLO bypasses the band filter: the user explicitly searched for
    // this exact stock, so always show it even if it's outside the band.
    // The band is per-group: the High Liquidity screen narrows to its own
    // ₹500–₹2,000 band; every other card uses the global default.
    if (!isSolo) {
      var _browseBand = _swBandFor(SECTOR_STATE.activeSector);
      rows = rows.filter(function (r) {
        if (r.ltp == null) return true;
        return r.ltp >= _browseBand.min && r.ltp <= _browseBand.max;
      });
    }
    total = rows.length;
    var loadedCount = rows.filter(function (r) { return r.ltp != null; }).length;
    var headerMeta;
    if (isSolo) {
      headerMeta = 'showing 1 of ' + grandTotal + ' \u00b7 solo';
    } else if (loadedCount < total) {
      headerMeta = 'loading \u00b7 ' + loadedCount + ' of ' + total + ' priced';
    } else {
      // `total` is the count actually shown (after the ₹band filter);
      // `revealedCount` is how many we've fetched/scanned. They differ
      // when some scanned names are priced outside ₹SW_MIN–₹SW_MAX.
      headerMeta = total + ' shown \u00b7 ' + revealedCount + ' of ' + grandTotal + ' scanned';
    }

    // ── Toolbar: stock search only ──
    // (Per-row scan, the sector "Run Fib Scan" button, and the timeframe
    //  selector were removed — Fib plots automatically on the chart now,
    //  so the sector list is a pure browse-and-pick surface.)
    var searchVal = SECTOR_STATE.filterText || '';
    var searchHtml = ''
      + '<div class="sw-sector-search">'
      +   '<svg class="sw-sector-search-icon" viewBox="0 0 24 24" width="12" height="12"'
      +     ' fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">'
      +     '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
      +   '</svg>'
      +   '<input type="text" class="sw-sector-search-input" placeholder="Search\u2026"'
      +     ' value="' + escapeHtml(searchVal) + '"'
      +     ' oninput="swingSectorSearch(this.value)"'
      +     ' aria-label="Filter stocks by symbol or name">'
      +   (searchVal ? '<button type="button" class="sw-sector-search-clear" onclick="swingSectorSearch(\'\')"'
      +     ' aria-label="Clear search">&times;</button>' : '')
      + '</div>';

    var toolbarHtml = ''
      + '<div class="sw-sector-toolbar">'
      +   searchHtml
      + '</div>';

    // ── Fib results map (sector scan or individual scans) ──
    var fibMap = {};
    (_swFibAutoState.results || []).forEach(function (r) { fibMap[r.isin] = r; });
    var hasAnyFib = Object.keys(fibMap).length > 0;

    var activeFilter = _swFibAutoState.signalFilter || null;
    var filterBarHtml = '';
    if (scanDone) {
      var sigCounts = { BOUNCE: 0, RECOVERY: 0, FORMING: 0, FALLING: 0, ABOVE: 0 };
      rows.forEach(function (st) {
        var f = fibMap[st.isin];
        if (f && f.bounceStatus && sigCounts.hasOwnProperty(f.bounceStatus)) {
          sigCounts[f.bounceStatus]++;
        }
      });
      function _sfChip(key, label, cls, count) {
        var isActive = activeFilter === key;
        return '<button type="button"'
          + ' class="sw-sf-chip sw-sf-chip--' + cls + (isActive ? ' sw-sf-chip--active' : '') + '"'
          + ' onclick="swSectorSignalFilter(' + (key ? '\'' + key + '\'' : 'null') + ')">'
          + label + ' <span class="sw-sf-chip-n">' + count + '</span>'
          + '</button>';
      }
      var buyCount   = sigCounts.BOUNCE + sigCounts.RECOVERY;
      var watchCount = sigCounts.FORMING;
      var skipCount  = sigCounts.FALLING + sigCounts.ABOVE;
      filterBarHtml = '<div class="sw-sf-bar">'
        + '<span class="sw-sf-label">Retracement:</span>'
        + _sfChip(null, 'All', 'all', rows.length)
        + (sigCounts.BOUNCE   ? _sfChip('BOUNCE',   '\u2191 Bounce',   'bounce',   sigCounts.BOUNCE)   : '')
        + (sigCounts.RECOVERY ? _sfChip('RECOVERY', '\u2197 Recovery', 'recovery', sigCounts.RECOVERY) : '')
        + (sigCounts.FORMING  ? _sfChip('FORMING',  '\u21AF Forming',  'forming',  sigCounts.FORMING)  : '')
        + (sigCounts.FALLING  ? _sfChip('FALLING',  '\u2193 Falling',  'falling',  sigCounts.FALLING)  : '')
        + (sigCounts.ABOVE    ? _sfChip('ABOVE',    '\u2192 Above',    'above',    sigCounts.ABOVE)    : '')
        + '<span class="sw-sf-sep"></span>'
        + '<span class="sw-sf-label">Signal:</span>'
        + (buyCount   ? _sfChip('BUY',   '\u2713 Buy',   'bounce',  buyCount)   : '')
        + (watchCount ? _sfChip('WATCH', '\u25CB Watch', 'forming', watchCount) : '')
        + (skipCount  ? _sfChip('SKIP',  '\u2717 Skip',  'falling', skipCount)  : '')
        + '</div>';
    }

    // ── Filter rows (text search + signal or action) ──
    var visibleRows = rows;
    if (searchVal) {
      var q = searchVal.toLowerCase();
      visibleRows = visibleRows.filter(function (st) {
        return (st.sym && st.sym.toLowerCase().indexOf(q) !== -1)
            || (st.name && st.name.toLowerCase().indexOf(q) !== -1);
      });
    }
    if (activeFilter && scanDone) {
      visibleRows = visibleRows.filter(function (st) {
        var f = fibMap[st.isin];
        if (!f) return false;
        if (activeFilter === 'BUY')   return f.bounceStatus === 'BOUNCE';
        if (activeFilter === 'WATCH') return f.bounceStatus === 'FORMING';
        if (activeFilter === 'SKIP')  return f.bounceStatus === 'FALLING' || f.bounceStatus === 'ABOVE';
        return f.bounceStatus === activeFilter;
      });
    }

    // ── Column sort (header-click driven; no-op until a header is clicked) ──
    var sortKey = SECTOR_STATE.sortKey || '';
    visibleRows = _swSortRows(visibleRows, sortKey, fibMap);

    // ── Build table ──
    var fp = function (n) { return (n != null && isFinite(n)) ? '&#8377;' + Number(n).toFixed(2) : '\u2014'; };
    var SIGNAL_BADGE = {
      BOUNCE:    '<span class="sw-fib-signal sw-fib-signal--bounce" title="Price is bouncing off the 61.8%-80% golden pocket — strong buy setup">\u2191 BOUNCE</span>',
      RECOVERY:  '<span class="sw-fib-signal sw-fib-signal--recovery" title="Price fell below 80% and is now rising back into the golden pocket — recovery buy">\u2197 RECOVERY</span>',
      RECOVERED: '<span class="sw-fib-signal sw-fib-signal--above" title="Recovered from deep retracement — pocket entry missed, wait for next pullback">\u2197 RECOVERED</span>',
      FORMING:   '<span class="sw-fib-signal sw-fib-signal--forming" title="Price is approaching the golden pocket from above — watch for entry once it enters 61.8%-80%">\u21AF FORMING</span>',
      FALLING:   '<span class="sw-fib-signal sw-fib-signal--falling" title="Price is below the 80% level and still falling — no buy setup yet">\u2193 FALLING</span>',
      ABOVE:     '<span class="sw-fib-signal sw-fib-signal--above" title="Price has not pulled back enough — still above 38.2% retracement">\u2192 ABOVE</span>'
    };

    function _52wBar(ltp, yLow, yHigh) {
      if (ltp == null || yLow == null || yHigh == null || yHigh <= yLow) {
        return '<span class="sw-sector-cell-pending">\u2014</span>';
      }
      var pct = Math.max(0, Math.min(100, ((ltp - yLow) / (yHigh - yLow)) * 100));
      var pos = pct.toFixed(0) + '%';
      return ''
        + '<div class="sw-52w-wrap">'
        +   '<span class="sw-52w-lo">&#8377;' + Math.round(yLow) + '</span>'
        +   '<div class="sw-52w-track">'
        +     '<div class="sw-52w-fill" style="width:' + pos + '"></div>'
        +     '<div class="sw-52w-dot" style="left:' + pos + '"></div>'
        +   '</div>'
        +   '<span class="sw-52w-hi">&#8377;' + Math.round(yHigh) + '</span>'
        + '</div>';
    }

    // Change pill helper (absolute price change).
    function _chgPill(chg) {
      if (chg == null || !isFinite(chg)) return '';
      var cls = chg >= 0 ? 'sw-chg-pill--up' : 'sw-chg-pill--dn';
      var arrow = chg >= 0 ? '\u25B2' : '\u25BC';
      return '<span class="sw-chg-pill ' + cls + '">'
        + arrow + ' &#8377;' + Math.abs(chg).toFixed(2) + '</span>';
    }

    var hasAnyScan = scanDone || _swFibAutoState.results.length > 0;
    // Sortable header cell — the whole <th> is the click target (role=button
    // + Enter/Space) and carries aria-sort for AT. Title text already used
    // HTML entities (&#10; line breaks), kept verbatim; the sort affordance
    // is appended via _swSortArrow.
    function _swTh(field, label, cls, title) {
      return '<th class="' + cls + ' sw-th-sortable" role="button" tabindex="0"'
        + ' aria-sort="' + _swAriaSort(field, sortKey) + '"'
        + ' title="' + title + '&#10;&#10;Click to sort by this column."'
        + ' onclick="swingSectorSortToggle(\'' + field + '\')"'
        + ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();swingSectorSortToggle(\'' + field + '\');}">'
        + '<span class="sw-th-inner">' + label + _swSortArrow(field, sortKey) + '</span>'
        + '</th>';
    }
    var theadHtml = '<thead><tr>'
      + _swTh('sym',    'Symbol',     'sw-th-sym', 'Stock symbol and company name')
      + _swTh('ltp',    'Price',      'sw-th-num', 'Last traded price')
      + _swTh('change', 'Change',     'sw-th-chg', 'Today\'s absolute price change')
      + _swTh('52w',    '52W Range',  'sw-th-52w', 'Price position within the 52-week high/low range')
      + _swTh('swlow',  'Swing Low',  'sw-th-num', 'Lowest price in the lookback period (swing bottom)')
      + _swTh('swhigh', 'Swing High', 'sw-th-num', 'Highest price in the lookback period (swing top)')
      + (hasAnyScan
        ? _swTh('depth',  'Depth', 'sw-th-depth', 'How far price has retraced from Swing High to Swing Low.&#10;61.8%-80% = Golden Pocket (ideal buy zone).')
        + _swTh('signal', 'Retracement', 'sw-th-sig', 'Fibonacci retracement status:&#10;BOUNCE = bouncing from golden pocket&#10;RECOVERY = rising back into golden pocket&#10;FORMING = approaching golden pocket&#10;FALLING = below golden pocket&#10;ABOVE = not pulled back enough')
        + '<th class="sw-th-act" title="Trading signal:&#10;Buy = strong setup in golden pocket&#10;Watch = approaching, not yet in zone&#10;Skip = not actionable right now">Signal</th>'
        : '')
      + '</tr></thead>';

    var ACTION_BADGE = {
      BOUNCE:   '<span class="sw-act-badge sw-act-badge--buy" title="Golden pocket bounce — look for bullish reversal candle to enter">Buy</span>',
      RECOVERY: '<span class="sw-act-badge sw-act-badge--buy" title="Recovering into golden pocket from deeper fall — rising momentum, good entry">Buy</span>',
      FORMING:  '<span class="sw-act-badge sw-act-badge--watch" title="Not in golden pocket yet — add to watchlist, wait for price to enter 61.8%-80%">Watch</span>',
      FALLING:  '<span class="sw-act-badge sw-act-badge--skip" title="Below golden pocket and still falling — no clear reversal, skip for now">Skip</span>',
      ABOVE:    '<span class="sw-act-badge sw-act-badge--none" title="Price above 38.2% — has not pulled back enough for a Fib entry">\u2014</span>'
    };

    var focusedIsin = SECTOR_STATE._focusedIsin || null;
    var tbodyRows = visibleRows.map(function (st) {
      var fib = fibMap[st.isin];
      var isBuy = fib && (fib.bounceStatus === 'BOUNCE' || fib.bounceStatus === 'RECOVERY' || fib.bounceStatus === 'FORMING');
      var isFocused = (st.isin === focusedIsin);
      var sigTd = '';
      if (hasAnyScan) {
        var depthPct = '';
        if (fib && isFinite(fib.swHigh) && isFinite(fib.swLow) && fib.swHigh > fib.swLow) {
          var retrace = ((fib.swHigh - fib.currentPx) / (fib.swHigh - fib.swLow)) * 100;
          var inGP = retrace >= 61.8 && retrace <= 80;
          var depthTip = retrace.toFixed(1) + '% retracement from swing high (&#8377;'
            + fib.swHigh.toFixed(0) + ') to swing low (&#8377;' + fib.swLow.toFixed(0) + ').&#10;';
          if (inGP) depthTip += '&#10;&#9989; Inside golden pocket (61.8%-80%) — ideal buy zone.';
          else if (retrace < 61.8) depthTip += '&#10;Price has not pulled back enough into the golden pocket yet.';
          else depthTip += '&#10;Price has fallen past the golden pocket (below 80%).';
          depthPct = '<span class="sw-depth' + (inGP ? ' sw-depth--zone' : '') + '"'
            + ' title="' + depthTip + '">'
            + retrace.toFixed(1) + '%</span>';
        }
        sigTd = '<td class="sw-td-depth">' + (fib ? depthPct : '') + '</td>'
          + '<td class="sw-td-sig">' + (fib ? (SIGNAL_BADGE[fib.bounceStatus] || '') : '') + '</td>'
          + '<td class="sw-td-act">' + (fib ? (ACTION_BADGE[fib.bounceStatus] || '') : '') + '</td>';
      }
      var rowCls = 'sw-sector-row'
        + (isBuy ? ' sw-sector-row--buy' : '')
        + (isFocused ? ' sw-sector-row--focused' : '')
        + (searchVal ? ' sw-sector-row--match' : '');
      return '<tr data-isin="' + st.isin + '" class="' + rowCls + '">'
        + '<td class="sw-td-sym">'
        +   '<div class="sw-fib-sym">' + escapeHtml(st.sym) + '</div>'
        +   '<div class="sw-fib-name">' + escapeHtml(st.name || '') + '</div>'
        + '</td>'
        + '<td class="sw-td-num">' + fp(st.ltp) + '</td>'
        + '<td class="sw-td-chg">' + _chgPill(st.change) + '</td>'
        + '<td class="sw-td-52w">' + _52wBar(st.ltp, st.yearLow, st.yearHigh) + '</td>'
        + '<td class="sw-td-num">' + fp(fib ? fib.swLow : st.yearLow) + '</td>'
        + '<td class="sw-td-num">' + fp(fib ? fib.swHigh : st.yearHigh) + '</td>'
        + sigTd
        + '</tr>';
    }).join('');

    // ── Footer: solo "show full sector" OR paged "load next N" ──
    var footerHtml = '';
    if (isSolo) {
      footerHtml = '<div class="sw-sector-loadmore-wrap">'
        + '<button type="button" class="sw-sector-loadmore" onclick="swingClearSolo()">'
        +   'Show full sector \u2192'
        + '</button></div>';
    } else if (revealedCount < grandTotal) {
      var nextN = Math.min(SW_QUOTE_PAGE, grandTotal - revealedCount);
      footerHtml = '<div class="sw-sector-loadmore-wrap">'
        + '<button type="button" class="sw-sector-loadmore" onclick="swingLoadMoreSectorStocks()">'
        +   'Load next ' + nextN
        +   ' <span class="sw-sector-loadmore-meta">' + revealedCount + ' of ' + grandTotal + ' scanned</span>'
        + '</button></div>';
    }

    host.innerHTML = ''
      + '<div class="sw-sector-panel">'
      +   '<div class="sw-sector-panel-header">'
      +     '<div class="sw-sector-panel-title">'
      +       '<span class="sw-sector-panel-icon" aria-hidden="true">' + icon + '</span>'
      +       '<span class="sw-sector-panel-name">' + escapeHtml(sec.name) + '</span>'
      +       '<span class="sw-sector-panel-meta">' + headerMeta + '</span>'
      +     '</div>'
      +     toolbarHtml
      +   '</div>'
      +   filterBarHtml
      +   '<div class="sw-sector-fib-progress" id="sw-sector-fib-progress" style="display:none">'
      +     '<div class="sw-sector-fib-bar" id="sw-sector-fib-bar" style="width:0%"></div>'
      +   '</div>'
      +   '<div class="sw-sector-tbl-wrap" id="sw-sector-tbl-wrap">'
      +     '<table class="sw-sector-tbl">'
      +       theadHtml
      +       '<tbody id="sw-sector-tbody">' + tbodyRows + '</tbody>'
      +     '</table>'
      +   '</div>'
      +   footerHtml
      +   '<div class="sw-fib-results-hint">Click a row to load chart with Fibonacci levels</div>'
      + '</div>';

    // Delegated row click — loads chart with fib overlay.
    var tbody = document.getElementById('sw-sector-tbody');
    if (tbody) {
      tbody.onclick = function (e) {
        if (e.target.closest('.sw-row-scan-btn')) return;
        var row = e.target.closest('tr[data-isin]');
        if (!row) return;
        var isin = row.getAttribute('data-isin');
        var st = sec.stocks.find(function (s) { return s.isin === isin; });
        if (!st) return;

        // Highlight clicked row via CSS without full re-render.
        var prev = tbody.querySelector('.sw-sector-row--focused');
        if (prev) prev.classList.remove('sw-sector-row--focused');
        row.classList.add('sw-sector-row--focused');
        SECTOR_STATE._focusedIsin = isin;

        // ONE shared entry for every sector-table click. We no longer
        // special-case fib-scanned stocks via fibScanPick: the FIB overlay
        // is drawn LIVE from the chart's candles (renderMainChart →
        // computeFibZone), so the precomputed fib only ever nudged the
        // default TF. Routing through swingPickSectorStock instead makes a
        // sector click behave IDENTICALLY to a Today's Setups row click —
        // it syncs the scan-mode overlays (FIB-only / ZOI-only / both),
        // mirrors the green highlight into the Setups table, and opens on
        // the scan TF. (fibScanPick is left untouched for the dedicated
        // Fibonacci-scanner results list, where forcing fib IS intended.)
        window.swingPickSectorStock(isin);
      };
    }

    // Restore focus + caret to the search input after innerHTML rebuild.
    if (searchVal) {
      var inp = host.querySelector('.sw-sector-search-input');
      if (inp) { inp.focus(); inp.setSelectionRange(searchVal.length, searchVal.length); }
    }

    // Debounced scroll — each render resets the timer; only the
    // last render's scroll fires (after 600ms of DOM stability).
    _swDoScrollToFocused();
  }

  // ── Sector Fibonacci scan state + controls ──
  var _swFibAutoState = {
    doneSector:    null,
    runningSector: null,
    results:       [],
    tf:            '1d',
    signalFilter:  null
  };

  // Change TF (resets scan so user can re-run).
  window.swSectorFibTfChange = function (tf) {
    _swFibAutoState.tf = tf;
    _swFibAutoState.doneSector = null;
    _swFibAutoState.runningSector = null;
    _swFibAutoState.results = [];
    _swFibAutoState.signalFilter = null;
    renderSectorPanel();
  };

  // Filter by signal type.
  window.swSectorSignalFilter = function (key) {
    _swFibAutoState.signalFilter = (_swFibAutoState.signalFilter === key) ? null : key;
    renderSectorPanel();
  };

  // Patch a single table row after individual scan — avoids full rebuild.
  function _swPatchRowAfterScan(isin, entry) {
    var panel = document.getElementById('sw-sector-panel');
    if (!panel) return;
    var row = panel.querySelector('tr[data-isin="' + isin + '"]');
    if (!row) return;

    // 1) Replace scan button with "Scanned" disabled state.
    var btnEl = row.querySelector('.sw-row-scan-btn');
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '\u2713 Scanned';
      btnEl.removeAttribute('onclick');
      btnEl.title = 'Already scanned';
    }

    // 2) Ensure Depth / Retracement / Signal columns exist.
    var thead = panel.querySelector('thead tr');
    if (thead && !thead.querySelector('.sw-th-depth')) {
      var thD = document.createElement('th'); thD.className = 'sw-th-depth'; thD.textContent = 'Depth';
      thD.title = 'How far the price has retraced from Swing High toward Swing Low.\n61.8%\u201380% = Golden Pocket (ideal buy zone).';
      var thR = document.createElement('th'); thR.className = 'sw-th-sig';   thR.textContent = 'Retracement';
      thR.title = 'Fibonacci retracement status: BOUNCE / RECOVERY / FORMING / FALLING / ABOVE';
      var thS = document.createElement('th'); thS.className = 'sw-th-act';   thS.textContent = 'Signal';
      thS.title = 'Trading signal: Buy / Watch / Skip';
      thead.appendChild(thD); thead.appendChild(thR); thead.appendChild(thS);
      // Add empty cells to all OTHER rows so columns align.
      panel.querySelectorAll('tbody tr').forEach(function (tr) {
        if (tr.getAttribute('data-isin') === isin) return;
        for (var c = 0; c < 3; c++) { tr.appendChild(document.createElement('td')); }
      });
    }

    var SIGNAL_BADGE = {
      BOUNCE:    '<span class="sw-fib-signal sw-fib-signal--bounce" title="Price is bouncing off the 61.8%-80% golden pocket — strong buy setup">\u2191 BOUNCE</span>',
      RECOVERY:  '<span class="sw-fib-signal sw-fib-signal--recovery" title="Price fell below 80% and is now rising back into the golden pocket — recovery buy">\u2197 RECOVERY</span>',
      RECOVERED: '<span class="sw-fib-signal sw-fib-signal--above" title="Recovered from deep retracement — pocket entry missed, wait for next pullback">\u2197 RECOVERED</span>',
      FORMING:   '<span class="sw-fib-signal sw-fib-signal--forming" title="Price is approaching the golden pocket from above — watch for entry once it enters 61.8%-80%">\u21AF FORMING</span>',
      FALLING:   '<span class="sw-fib-signal sw-fib-signal--falling" title="Price is below the 80% level and still falling — no buy setup yet">\u2193 FALLING</span>',
      ABOVE:     '<span class="sw-fib-signal sw-fib-signal--above" title="Price has not pulled back enough — still above 38.2% retracement">\u2192 ABOVE</span>'
    };
    var ACTION_BADGE = {
      BOUNCE:   '<span class="sw-act-badge sw-act-badge--buy" title="Golden pocket bounce — look for bullish reversal candle to enter">Buy</span>',
      RECOVERY: '<span class="sw-act-badge sw-act-badge--buy" title="Recovering into golden pocket from deeper fall — rising momentum, good entry">Buy</span>',
      FORMING:  '<span class="sw-act-badge sw-act-badge--watch" title="Not in golden pocket yet — add to watchlist, wait for price to enter 61.8%-80%">Watch</span>',
      FALLING:  '<span class="sw-act-badge sw-act-badge--skip" title="Below golden pocket and still falling — no clear reversal, skip for now">Skip</span>',
      ABOVE:    '<span class="sw-act-badge sw-act-badge--none" title="Price above 38.2% — has not pulled back enough for a Fib entry">\u2014</span>'
    };

    // 3) Fill or update the three scan columns on THIS row.
    var existingDepth = row.querySelector('.sw-td-depth');
    var f = entry.fib || entry;
    var depthHtml = '';
    if (f && isFinite(f.swHigh) && isFinite(f.swLow) && f.swHigh > f.swLow) {
      var retrace = ((f.swHigh - f.currentPx) / (f.swHigh - f.swLow)) * 100;
      var inGP = retrace >= 61.8 && retrace <= 80;
      var depthTip = retrace.toFixed(1) + '% retracement from swing high (&#8377;'
        + f.swHigh.toFixed(0) + ') to swing low (&#8377;' + f.swLow.toFixed(0) + ').&#10;';
      if (inGP) depthTip += '&#10;&#9989; Inside golden pocket (61.8%-80%) — ideal buy zone.';
      else if (retrace < 61.8) depthTip += '&#10;Price has not pulled back enough into the golden pocket yet.';
      else depthTip += '&#10;Price has fallen past the golden pocket (below 80%).';
      depthHtml = '<span class="sw-depth' + (inGP ? ' sw-depth--zone' : '') + '"'
        + ' title="' + depthTip + '">'
        + retrace.toFixed(1) + '%</span>';
    }
    var sigHtml = f && f.bounceStatus ? (SIGNAL_BADGE[f.bounceStatus] || '') : '';
    var actHtml = f && f.bounceStatus ? (ACTION_BADGE[f.bounceStatus] || '') : '';

    if (existingDepth) {
      existingDepth.innerHTML = depthHtml;
      row.querySelector('.sw-td-sig').innerHTML = sigHtml;
      row.querySelector('.sw-td-act').innerHTML = actHtml;
    } else {
      var tdD = document.createElement('td'); tdD.className = 'sw-td-depth'; tdD.innerHTML = depthHtml;
      var tdR = document.createElement('td'); tdR.className = 'sw-td-sig';   tdR.innerHTML = sigHtml;
      var tdS = document.createElement('td'); tdS.className = 'sw-td-act';   tdS.innerHTML = actHtml;
      row.appendChild(tdD); row.appendChild(tdR); row.appendChild(tdS);
    }

    // 4) Update Swing Low / Swing High if fib data has them.
    if (f && f.swLow != null) {
      var numCells = row.querySelectorAll('.sw-td-num');
      if (numCells.length >= 2) {
        var last2 = [numCells[numCells.length - 2], numCells[numCells.length - 1]];
        last2[0].innerHTML = '&#8377;' + Number(f.swLow).toFixed(2);
        last2[1].innerHTML = '&#8377;' + Number(f.swHigh).toFixed(2);
      }
    }

    // 5) Highlight the row.
    var oldFocused = panel.querySelector('.sw-sector-row--focused');
    if (oldFocused) oldFocused.classList.remove('sw-sector-row--focused');
    row.classList.add('sw-sector-row--focused');
    if (f && (f.bounceStatus === 'BOUNCE' || f.bounceStatus === 'RECOVERY' || f.bounceStatus === 'FORMING')) {
      row.classList.add('sw-sector-row--buy');
    }
  }

  // ── Custom themed tooltip for entire swing section ──
  (function () {
    var box = document.createElement('div');
    box.className = 'sw-tooltip';
    document.body.appendChild(box);
    var tid = null, cur = null;

    // Move a native `title` onto `data-sw-tip` (and drop the `title`) so the
    // browser can never render its own (OS-themed) tooltip for this element.
    // Idempotent: a no-op once `title` is gone, so it is safe to call on the
    // same node repeatedly and on every ancestor.
    function _swStripTitle(el) {
      if (!el || !el.getAttribute) return;
      var t = el.getAttribute('title');
      if (t != null && t !== '') {
        el.setAttribute('data-sw-tip', t);
        el.removeAttribute('title');
      }
    }

    function show(el) {
      var txt = el.getAttribute('data-sw-tip');
      if (!txt) return;
      box.textContent = txt;
      box.style.display = 'block';
      var r = el.getBoundingClientRect();
      var bw = box.offsetWidth, bh = box.offsetHeight;
      var left = r.left + r.width / 2 - bw / 2;
      var top = r.top - bh - 6;
      if (top < 4) top = r.bottom + 6;
      if (left < 4) left = 4;
      if (left + bw > window.innerWidth - 4) left = window.innerWidth - bw - 4;
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.classList.add('sw-tooltip--show');
    }

    function hide() {
      clearTimeout(tid); tid = null;
      box.classList.remove('sw-tooltip--show');
      box.style.display = 'none';
      // Deliberately do NOT restore `title` — `data-sw-tip` persists, so a
      // native OS tooltip can never reappear on a re-hover.
      cur = null;
    }

    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest('[title], [data-sw-tip]');
      if (!el) return;
      if (!el.closest('#swing')) return;
      // Strip the native `title` from the hovered element AND every ancestor
      // up to #swing. Without this, hovering a child whose own title is
      // already converted lets the browser show a PARENT's native (Mac-
      // themed) tooltip — the exact mismatch this fixes.
      var node = el;
      while (node) {
        _swStripTitle(node);
        if (node.id === 'swing') break;
        node = node.parentElement;
      }
      if (el === cur) return;
      hide();
      cur = el;
      tid = setTimeout(function () { show(el); }, 120);
    });

    document.addEventListener('mouseout', function (e) {
      if (!cur) return;
      var el = e.target.closest('[data-sw-tip]');
      if (!el || el !== cur) return;
      if (el.contains(e.relatedTarget)) return;
      hide();
    });

    window.addEventListener('scroll', function () { if (cur) hide(); }, true);
  })();

  // Single-stock scan trigger (per-row button).
  var _swScanningIsin = null;
  window.swSectorRunFibScanSingle = async function (isin) {
    var sectorId = SECTOR_STATE.activeSector;
    if (!sectorId || !isin) return;
    if (_swFibAutoState.runningSector) return;
    if (_swScanningIsin) return;
    if (!getToken() || swIsApiPaused()) return;

    var grp = _swGetGroup(sectorId);
    if (!grp) return;
    var st = grp.stocks.find(function (s) { return s.isin === isin; });
    if (!st) return;

    // Show loading state on button.
    _swScanningIsin = isin;
    var btn = document.querySelector('tr[data-isin="' + isin + '"] .sw-row-scan-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Scanning\u2026'; }

    var tf = _swFibAutoState.tf || '1d';
    try {
      var candles = await fetchTf(isin, tf);
      var fib = computeFibZone(candles);
      var existing = _swFibAutoState.results.findIndex(function (r) { return r.isin === isin; });
      var entry = {
        isin: isin, sym: st.sym, name: st.name,
        fib: fib || null,
        swLow: fib ? fib.swLow : null, swHigh: fib ? fib.swHigh : null,
        bounceStatus: fib ? fib.bounceStatus : null,
        rr: (fib && fib.plan) ? fib.plan.rr : null,
        currentPx: fib ? fib.currentPx : null,
        fib618: fib ? fib.fib618 : null, fib786: fib ? fib.fib786 : null,
        inScanScope: fib ? fib.inScanScope : false
      };
      if (existing >= 0) {
        _swFibAutoState.results[existing] = entry;
      } else {
        _swFibAutoState.results.push(entry);
      }
      _swScanningIsin = null;
      SECTOR_STATE._focusedIsin = isin;

      // Update the row in-place — no full table rebuild.
      _swPatchRowAfterScan(isin, entry);

      // Store fib data so clicking the row later opens chart with overlay.
      if (fib && typeof FIB_STATE !== 'undefined') {
        var fe = FIB_STATE.results.find(function (r) { return r.isin === isin; });
        if (!fe) {
          FIB_STATE.results.push({ isin: isin, sym: st.sym, name: st.name, fib: fib });
        } else {
          fe.fib = fib;
        }
      }
    } catch (e) {
      _swScanningIsin = null;
      console.warn('[single-scan] failed for', isin, e);
      if (btn) { btn.disabled = false; btn.textContent = '\u2197 Scan'; }
    }
  };

  // Full sector scan trigger.
  window.swSectorRunFibScan = function () {
    var sectorId = SECTOR_STATE.activeSector;
    if (!sectorId) return;
    if (_swFibAutoState.runningSector) return;
    if (!getToken() || swIsApiPaused()) return;

    _swFibAutoState.runningSector = sectorId;
    _swFibAutoState.doneSector    = null;
    _swFibAutoState.results       = [];
    _swFibAutoState.signalFilter  = null;

    // Show progress bar.
    var pEl = document.getElementById('sw-sector-fib-progress');
    if (pEl) pEl.style.display = '';

    _swRunSectorFibScan(sectorId);
  };

  async function _swRunSectorFibScan(sectorId) {
    var grp = _swGetGroup(sectorId);
    if (!grp || !grp.stocks || !grp.stocks.length) {
      _swFibAutoState.runningSector = null;
      return;
    }
    var tf      = _swFibAutoState.tf || '1d';
    var stocks  = grp.stocks;
    var total   = stocks.length;

    var bar     = document.getElementById('sw-sector-fib-bar');
    var tbody   = document.getElementById('sw-sector-tbody');

    for (var i = 0; i < total; i++) {
      if (SECTOR_STATE.activeSector !== sectorId) {
        _swFibAutoState.runningSector = null;
        return;
      }
      var st = stocks[i];
      try {
        var candles = await fetchTf(st.isin, tf);
        var fib = computeFibZone(candles);
        _swFibAutoState.results.push({
          isin: st.isin, sym: st.sym, name: st.name,
          fib: fib || null,
          swLow: fib ? fib.swLow : null, swHigh: fib ? fib.swHigh : null,
          bounceStatus: fib ? fib.bounceStatus : null,
          rr: (fib && fib.plan) ? fib.plan.rr : null,
          currentPx: fib ? fib.currentPx : null,
          fib618: fib ? fib.fib618 : null, fib786: fib ? fib.fib786 : null,
          inScanScope: fib ? fib.inScanScope : false
        });
      } catch (_) { /* skip */ }

      // Progress bar.
      var pct = Math.round((i + 1) / total * 100);
      if (bar) bar.style.width = pct + '%';
      if ((i + 1) % 5 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }

    _swFibAutoState.runningSector = null;
    _swFibAutoState.doneSector    = sectorId;

    // Re-render with scan results (adds columns + filter chips).
    if (SECTOR_STATE.activeSector === sectorId) {
      renderSectorPanel();
    }
  }

  function renderSectorError(err) {
    var host = document.getElementById('sw-sector-grid');
    if (!host) return;
    var msg = (err && err.message) ? err.message : 'unknown error';
    host.innerHTML = '<div class="sw-sector-error">'
      + 'Failed to load sectors: ' + escapeHtml(msg) + '. '
      + '<button type="button" class="sw-link-btn" onclick="swingInitSectors()">Retry</button>'
      + '</div>';
  }

  function renderSectorPanelError(err) {
    var host = document.getElementById('sw-sector-panel');
    if (!host || !SECTOR_STATE.activeSector) return;
    var sec = SECTOR_STATE.data && SECTOR_STATE.data.sectors.find(function (s) {
      return s.id === SECTOR_STATE.activeSector;
    });
    var msg = (err && err.message) ? err.message : 'Failed to load prices';
    // If at least one quote made it into the cache before the
    // timeout fired, fall through to renderSectorPanel() instead
    // of wiping the panel \u2014 a partial result is more useful
    // than a blank error state.
    if (sec) {
      var anyLoaded = sec.stocks.some(function (st) { return SECTOR_STATE.quoteCache[st.isin] != null; });
      if (anyLoaded) { renderSectorPanel(); return; }
    }
    host.innerHTML = ''
      + '<div class="sw-sector-panel">'
      +   '<div class="sw-sector-panel-header">'
      +     '<span class="sw-sector-panel-name">' + escapeHtml(sec ? sec.name : 'Sector') + '</span>'
      +     '<span class="sw-sector-panel-meta">error</span>'
      +   '</div>'
      +   '<div class="sw-sector-panel-error">' + escapeHtml(msg)
      +     ' <button type="button" class="sw-link-btn" onclick="swingPickSector(\''
      +     SECTOR_STATE.activeSector + '\')">Retry</button>'
      +   '</div>'
      + '</div>';
  }

  // Boot: load sectors + render the grid. Called once from wire().
  async function swingInitSectors() {
    // Custom stocks live in localStorage and don't need a network
    // round-trip \u2014 load them up front so the My Stocks card
    // shows the correct count from the very first paint.
    _swLoadCustomStocks();
    // Paint the API-pause banner first \u2014 if the user previously
    // paused, this MUST be visible before any auto-fetching code
    // runs so they can resume or stay paused.
    try { renderApiPauseBanner(); } catch (_) {}
    // Paint the Today's Setups tile immediately from whatever's in
    // localStorage \u2014 empty-state CTA on first ever visit, BUY
    // rows otherwise. Independent of the sector grid load (and not
    // gated by network) so the user always sees the panel.
    try { renderTodaySetups(); } catch (_) {}
    try {
      await loadSectors();
      renderSectorGrid();
      swingRenderUniverseStat();
    } catch (e) {
      renderSectorError(e);
    }
    // Restore the last-viewed stock's chart AFTER the universe is in
    // (or failed) \u2014 validation needs the loaded sectors/indices, and
    // My-Stocks (custom) restores even if the sector fetch failed.
    try { swRestoreSelected(); } catch (_) {}
  }

  // Paints the persistent toggle pill at the top of the swing
  // section. Green when active, amber when paused; tooltip
  // explains the rationale. Re-rendered on every toggle so the
  // status reflects current state without a page reload.
  function renderApiPauseBanner() {
    var host = document.getElementById('sw-api-pause-banner');
    if (!host) return;
    var paused = swIsApiPaused();
    host.dataset.state = paused ? 'paused' : 'active';
    var dotCls = paused ? 'sw-api-pause-dot-paused' : 'sw-api-pause-dot-active';
    var statusTxt = paused ? 'Swing API: PAUSED' : 'Swing API: ACTIVE';
    var hintTxt = paused
      ? 'Cached recommendations + last-known prices only. No live fetches. Fresh analysis is blocked until you resume.'
      : 'Analyzer can fetch fresh candles, LTPs, and run the bulk scan. Pause to protect your Upstox quota for Options Trading.';
    var btnTxt = paused ? 'Resume' : 'Pause';
    host.innerHTML = ''
      + '<div class="sw-api-pause-meta">'
      +   '<span class="sw-api-pause-dot ' + dotCls + '" aria-hidden="true"></span>'
      +   '<span class="sw-api-pause-status">' + statusTxt + '</span>'
      +   '<span class="sw-api-pause-hint">' + hintTxt + '</span>'
      + '</div>'
      + '<button type="button" class="sw-api-pause-btn"'
      +   ' onclick="swToggleApiPause()"'
      +   ' aria-pressed="' + (paused ? 'true' : 'false') + '">'
      +   btnTxt
      + '</button>';
  }
  // (escapeHtml is defined further down in the same module
  // \u2014 function-declaration hoisting makes it available here.)

  // ═══════════════════════════════════════════════════════════════
  // LIGHTWEIGHT CHARTS LAZY LOADER
  // ═══════════════════════════════════════════════════════════════
  // Reuses the same LWC v5.2.0 CDN URL the live chart module
  // loads. If the user has already visited the Live tab the global
  // `LightweightCharts` exists and we resolve instantly; otherwise
  // we inject the <script> ourselves. Safe to call many times.
  var LWC_CDN = 'https://unpkg.com/lightweight-charts@5.2.0/dist/lightweight-charts.standalone.production.js';
  function loadLwcLib() {
    if (typeof LightweightCharts !== 'undefined' && LightweightCharts.createChart) return Promise.resolve();
    if (STATE.lwcLoading) return STATE.lwcLoading;
    STATE.lwcLoading = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + LWC_CDN + '"]');
      if (existing) {
        if (typeof LightweightCharts !== 'undefined') { resolve(); return; }
        existing.addEventListener('load', resolve);
        existing.addEventListener('error', function () { reject(new Error('LWC CDN failed')); });
        return;
      }
      var s = document.createElement('script');
      s.src = LWC_CDN;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('LWC CDN failed')); };
      document.head.appendChild(s);
    });
    return STATE.lwcLoading;
  }

  // ═══════════════════════════════════════════════════════════════
  // ZigZag HH/HL trend params for swing stock timeframes.
  // Same algorithm as the intraday module (classifyStructure +
  // _zigzagFrom) — parameters tuned for slower daily/weekly bars.
  //   zigzagATR : minimum reversal (× capped ATR) to register a swing.
  //               Higher = fewer but cleaner, longer-horizon swings.
  //   tolATR    : HH/HL comparison tolerance (× ATR). Same as intraday.
  //   freshWin  : max bars old for a swing to be "fresh" (directional).
  //   skipFirstBarsOfDay: 0 for OHLC daily/weekly bars (no intraday gap).
  var SWING_TREND_PARAMS_BY_TF = {
    '1d':  { zigzagATR: 2.0, tolATR: 0.05, freshWin: 8,  skipFirstBarsOfDay: 0 },
    '1w':  { zigzagATR: 1.5, tolATR: 0.05, freshWin: 6,  skipFirstBarsOfDay: 0 },
    '1mo': { zigzagATR: 1.0, tolATR: 0.05, freshWin: 4,  skipFirstBarsOfDay: 0 }
  };

  // PER-TIMEFRAME ANALYSIS
  // ═══════════════════════════════════════════════════════════════
  function analyzeTf(rawCandles, tfKey) {
    if (!rawCandles || rawCandles.length < 30) return null;
    // Upstox V3 returns candles newest-first. Sort to chronological
    // so indicator math (which expects oldest→newest) works correctly.
    var c = rawCandles.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var closes = c.map(function (x) { return +x[4]; });
    var highs  = c.map(function (x) { return +x[2]; });
    var lows   = c.map(function (x) { return +x[3]; });
    var vols   = c.map(function (x) { return +x[5] || 0; });
    var n = c.length;
    var lastClose = closes[n - 1];

    var e20 = ema(closes, 20);
    var e50 = ema(closes, 50);
    var e200 = n >= 200 ? ema(closes, 200) : [];
    // Bansal "44+4" method indicators — only meaningful on weekly bars
    // (44 SMA = ~10 months long-term trend filter; 4 EMA = ~1 month
    // weekly trailing stop). Computed on every TF for consistency
    // but the analyzer + plan generator only USES them when tfKey
    // === '1w'. ~50 bars min for 44 SMA to read cleanly; the early
    // NaN slots are tolerated by lastSma44 = null below.
    var s44 = n >= 44 ? sma(closes, 44) : [];
    var e4  = n >= 4  ? ema(closes, 4)  : [];
    var r = rsi(closes, 14);
    var m = macd(closes);
    var a = atr(c, 14);
    var dx = adx(c, 14);
    var volMa20 = ema(vols, 20);

    var lastE20 = e20[n - 1];
    var lastE50 = e50[n - 1];
    var lastE200 = e200.length ? e200[n - 1] : null;
    var lastSma44 = s44.length ? s44[n - 1] : null;
    var lastE4    = e4.length  ? e4[n - 1]  : null;
    var lastRsi = r[n - 1];
    var lastHist = m.hist[n - 1];
    var prevHist = m.hist[n - 2];
    var lastMacdLine = m.macd[n - 1];
    var lastMacdSig  = m.signal[n - 1];
    var prevMacdLine = m.macd[n - 2];
    var prevMacdSig  = m.signal[n - 2];
    var lastAtr = a[n - 1];
    var lastVol = vols[n - 1];
    var lastVolMa = volMa20[n - 1];
    var lastAdx = dx.length ? dx[dx.length - 1] : null;

    // ── Trend classification: recent swing structure ──
    // Uses detectStructureBreaks() labelled swings (HH/HL/LH/LL) but
    // derives trend from the MOST RECENT swings — not the full-history
    // state machine. This matches how a trader reads the chart: look at
    // the last 2–3 swing points and determine if structure is making
    // Higher Highs + Higher Lows (BULL) or Lower Highs + Lower Lows (BEAR).
    // The state machine's trend can lag for months on higher TFs because
    // it requires price to break above old decline-phase swing highs
    // (which may be far above current price even during clear recovery).
    var bosResult = (typeof detectStructureBreaks === 'function')
      ? detectStructureBreaks(rawCandles, { pivot: BOS_PIVOT_BY_TF[tfKey] || 5 })
      : null;
    var trend = 'NEUTRAL';
    // Human-readable description of WHY this trend was assigned — surfaced
    // in the M/W/D bias sub-label so the card explains its own logic
    // (recent swing structure), not an unrelated RSI/EMA snapshot.
    var trendBasis = 'no clear swing structure';
    if (bosResult) {
      var recentTrend = recentSwingTrend(bosResult);
      if      (recentTrend === 'BULLISH')  { trend = (lastAdx && lastAdx >= 25) ? 'STRONG_BULL' : 'BULL'; trendBasis = 'Higher highs & lows'; }
      else if (recentTrend === 'BEARISH')  { trend = (lastAdx && lastAdx >= 25) ? 'STRONG_BEAR' : 'BEAR'; trendBasis = 'Lower highs & lows'; }
      else                                 { trendBasis = 'Mixed swings'; }
    } else {
      // Fallback to EMA stack if detectStructureBreaks unavailable
      if      (lastClose > lastE20 && lastE20 > lastE50) { trend = 'BULL'; trendBasis = 'Above 20 & 50 EMA'; }
      else if (lastClose < lastE20 && lastE20 < lastE50) { trend = 'BEAR'; trendBasis = 'Below 20 & 50 EMA'; }
      else if (lastClose > lastE50) { trend = 'BULL'; trendBasis = 'Above 50 EMA'; }
      else if (lastClose < lastE50) { trend = 'BEAR'; trendBasis = 'Below 50 EMA'; }
    }
    // Append the ADX reading — it's what splits BULL/BEAR from STRONG_*.
    if (lastAdx != null && isFinite(lastAdx)) {
      trendBasis += ' \u00b7 ADX ' + lastAdx.toFixed(0);
    }

    // ── Momentum: RSI + MACD histogram direction. ──
    var momentum = 'NEUTRAL';
    if (lastRsi > 55 && lastHist > 0 && lastHist > prevHist) momentum = 'STRONG_BULL';
    else if (lastRsi > 50 && lastHist > 0) momentum = 'BULL';
    else if (lastRsi < 45 && lastHist < 0 && lastHist < prevHist) momentum = 'STRONG_BEAR';
    else if (lastRsi < 50 && lastHist < 0) momentum = 'BEAR';

    // ── EMA stack label (textbook trend-stack visualisation). ──
    // 20 > 50 > 200 = full bullish stack; reverse = full bearish.
    // Anything else is "mixed" — trend is in transition / weak.
    var emaStack;
    if (lastE200 != null && isFinite(lastE200)) {
      if (lastE20 > lastE50 && lastE50 > lastE200) emaStack = 'bullish (20 > 50 > 200)';
      else if (lastE20 < lastE50 && lastE50 < lastE200) emaStack = 'bearish (20 < 50 < 200)';
      else emaStack = 'mixed';
    } else {
      if (lastE20 > lastE50) emaStack = 'bullish (20 > 50)';
      else if (lastE20 < lastE50) emaStack = 'bearish (20 < 50)';
      else emaStack = 'flat';
    }

    // ── EMA slopes — is the MA itself trending up or down? ──
    // Compare current EMA value to its value 5 bars ago. Filters
    // out sub-1% noise so a sideways tape doesn't read as "rising".
    function slope(arr, lookback) {
      if (!arr || arr.length < lookback + 1) return 'flat';
      var cur = arr[arr.length - 1];
      var pst = arr[arr.length - 1 - lookback];
      if (!isFinite(cur) || !isFinite(pst) || pst === 0) return 'flat';
      var pct = ((cur - pst) / Math.abs(pst)) * 100;
      if (pct > 0.5) return 'rising';
      if (pct < -0.5) return 'falling';
      return 'flat';
    }
    var ema20Slope = slope(e20, 5);
    var ema50Slope = slope(e50, 5);
    // 44 SMA slope — measured over 5 bars (= 5 WEEKS on weekly TF =
    // ~5 weeks of price action). Bansal's rule treats a falling 44
    // SMA as a "do not buy" signal regardless of price position;
    // matching that semantics requires a directional read on the
    // line itself, not just on price-vs-line.
    var sma44Slope = s44.length ? slope(s44, 5) : 'flat';
    var ema4Slope  = e4.length  ? slope(e4, 3)  : 'flat';

    // ── RSI 3-bar direction (rising / falling / flat). ──
    // Tells you if momentum is BUILDING or FADING regardless of
    // the absolute RSI level. Often more useful than raw RSI alone.
    var rsiTrend = 'flat';
    if (r.length >= 3) {
      var d = lastRsi - r[n - 3];
      if (d > 1) rsiTrend = 'rising';
      else if (d < -1) rsiTrend = 'falling';
    }

    // ── MACD signal-line cross detection (last 5 bars). ──
    // Returns null when no recent cross, else 'bull cross N bars ago'
    // or 'bear cross N bars ago'. Crosses within 1-3 bars are tradable;
    // older crosses are reference-only.
    var macdCross = null;
    for (var i = n - 1; i >= Math.max(2, n - 5); i--) {
      var curL = m.macd[i], curS = m.signal[i];
      var prvL = m.macd[i - 1], prvS = m.signal[i - 1];
      if (!isFinite(curL) || !isFinite(curS) || !isFinite(prvL) || !isFinite(prvS)) continue;
      if (prvL <= prvS && curL > curS) { macdCross = { dir: 'bull', barsAgo: n - 1 - i }; break; }
      if (prvL >= prvS && curL < curS) { macdCross = { dir: 'bear', barsAgo: n - 1 - i }; break; }
    }
    var macdHistDir = (isFinite(lastHist) && isFinite(prevHist))
      ? (lastHist > prevHist ? 'rising' : (lastHist < prevHist ? 'falling' : 'flat'))
      : 'flat';

    // ── Swing high/low (last confirmed pivot, lookback=3). ──
    var swingHighsArr = swingHighs(c, 3);
    var swingLowsArr  = swingLows(c, 3);
    var recentHigh = swingHighsArr.length ? swingHighsArr[swingHighsArr.length - 1].price : null;
    var recentLow  = swingLowsArr.length ? swingLowsArr[swingLowsArr.length - 1].price : null;

    // ── 20-bar Donchian channel (highest high / lowest low). ──
    // Reference for breakout traders; also defines a "fair value"
    // range for mean-reversion plays.
    var donHigh20 = null, donLow20 = null;
    if (n >= 20) {
      donHigh20 = -Infinity; donLow20 = Infinity;
      for (var i = n - 20; i < n; i++) {
        if (highs[i] > donHigh20) donHigh20 = highs[i];
        if (lows[i] < donLow20)  donLow20 = lows[i];
      }
    }

    // ── 52-week range (only meaningful for Daily+). ──
    // For weekly we use the full 150-week history; for hourly we
    // skip (the 60-day window is too noisy to call "yearly").
    var rangeHigh = null, rangeLow = null, rangePosPct = null, rangeLabel = null;
    if (tfKey === '1d' && n >= 100) {
      var lookback = Math.min(n, 252); // 252 trading days = 1 year
      rangeHigh = -Infinity; rangeLow = Infinity;
      for (var i = n - lookback; i < n; i++) {
        if (highs[i] > rangeHigh) rangeHigh = highs[i];
        if (lows[i]  < rangeLow)  rangeLow  = lows[i];
      }
      rangeLabel = '52-week';
    } else if (tfKey === '1w' && n >= 50) {
      var lb = Math.min(n, 156); // 3 years of weekly
      rangeHigh = -Infinity; rangeLow = Infinity;
      for (var i = n - lb; i < n; i++) {
        if (highs[i] > rangeHigh) rangeHigh = highs[i];
        if (lows[i]  < rangeLow)  rangeLow  = lows[i];
      }
      rangeLabel = '3-year';
    }
    if (rangeHigh != null && rangeLow != null && rangeHigh > rangeLow) {
      rangePosPct = ((lastClose - rangeLow) / (rangeHigh - rangeLow)) * 100;
    }

    // ── All-time high (from the full available history). ──
    // Distinct from the 52-week high because ATH means "this
    // stock has NEVER traded higher than X — zero overhead
    // supply ever". A breakout above ATH is statistically the
    // single highest-base-rate setup in equity swing trading
    // (no one's underwater above this price, so no profit-taking
    // and no stop-running). We only compute on the daily TF
    // because intraday/weekly proxies don't add information.
    var athHigh = null, athDistPct = null;
    if (tfKey === '1d' && n >= 50) {
      athHigh = -Infinity;
      for (var i = 0; i < n; i++) {
        if (highs[i] > athHigh) athHigh = highs[i];
      }
      if (athHigh > 0 && isFinite(athHigh)) {
        athDistPct = ((lastClose - athHigh) / athHigh) * 100;
      } else {
        athHigh = null;
      }
    }

    // ── Nearest overhead resistance + headroom. ──
    // Walks the confirmed swing-high pivots (lookback=3) and
    // returns the LOWEST one strictly above the current close
    // — that's the next wall the price has to clear. Used by
    // the plan generator to cap T1 (we don't want T1 sitting
    // inside known supply, that's an unreachable target) and
    // to surface "X% headroom to resistance" in the WHY BUY
    // checklist so the user understands the trade has room.
    //
    // SwingHighsArr was just built above. We also include the
    // 52-week high (rangeHigh) and ATH as candidate levels
    // because those act as resistance even if no recent pivot
    // touched them.
    var nearestResistance = null;
    var nearestResistanceLabel = null;
    var resCandidates = [];
    for (var i = 0; i < swingHighsArr.length; i++) {
      var sh = swingHighsArr[i];
      if (sh.price > lastClose) resCandidates.push({ price: sh.price, label: 'recent swing high' });
    }
    if (rangeHigh != null && rangeHigh > lastClose) {
      resCandidates.push({ price: rangeHigh, label: rangeLabel + ' high' });
    }
    if (athHigh != null && athHigh > lastClose) {
      // Only treat ATH as a resistance candidate when it's distinct
      // from the 52WH — otherwise it duplicates the label noise.
      if (rangeHigh == null || Math.abs(athHigh - rangeHigh) / athHigh > 0.005) {
        resCandidates.push({ price: athHigh, label: 'all-time high' });
      }
    }
    for (var i = 0; i < resCandidates.length; i++) {
      var rc = resCandidates[i];
      if (nearestResistance == null || rc.price < nearestResistance) {
        nearestResistance = rc.price;
        nearestResistanceLabel = rc.label;
      }
    }
    var headroomPct = (nearestResistance != null)
      ? ((nearestResistance - lastClose) / lastClose) * 100
      : null;

    // ── Volume 5-bar trend (avg of last 5 vs prior 5). ──
    var volTrend = 'flat';
    if (n >= 10) {
      var sumA = 0, sumB = 0;
      for (var i = n - 5; i < n; i++) sumA += vols[i];
      for (var i = n - 10; i < n - 5; i++) sumB += vols[i];
      if (sumB > 0) {
        var dlt = (sumA - sumB) / sumB;
        if (dlt > 0.15) volTrend = 'rising';
        else if (dlt < -0.15) volTrend = 'falling';
      }
    }

    // Pass trend context so Hammer-at-top-of-uptrend correctly
    // classifies as Hanging Man (bearish reversal) instead of
    // Hammer (bullish reversal).
    var pat = detectPatterns(c, trend);

    // ── Helper for % distance metrics (positive = above ref). ──
    function pctDist(price, ref) {
      if (!isFinite(price) || !isFinite(ref) || ref === 0) return null;
      return ((price - ref) / Math.abs(ref)) * 100;
    }

    return {
      tfKey: tfKey,
      candleCount: n,
      lastClose: lastClose,
      // Close of the prior confirmed bar — the correct reference for the
      // header's change / % (comparing lastClose to itself always gave 0).
      prevClose: (n >= 2 ? closes[n - 2] : null),
      // How the trend label was derived (recent swing structure + ADX).
      trendBasis: trendBasis,
      // EMAs
      ema20: lastE20,
      ema50: lastE50,
      ema200: lastE200,
      ema20DistPct: pctDist(lastClose, lastE20),
      ema50DistPct: pctDist(lastClose, lastE50),
      ema200DistPct: lastE200 != null ? pctDist(lastClose, lastE200) : null,
      ema20Slope: ema20Slope,
      ema50Slope: ema50Slope,
      emaStack: emaStack,
      // Bansal "44+4" weekly indicators (computed on every TF but
      // only USED on weekly). sma44 = long-term swing trend filter;
      // ema4 = weekly trailing stop. Both are null when there isn't
      // enough history to compute (new listings).
      sma44: lastSma44,
      sma44DistPct: lastSma44 != null ? pctDist(lastClose, lastSma44) : null,
      sma44Slope: sma44Slope,
      ema4: lastE4,
      ema4DistPct: lastE4 != null ? pctDist(lastClose, lastE4) : null,
      ema4Slope: ema4Slope,
      // Momentum / oscillators
      rsi: lastRsi,
      rsiTrend: rsiTrend,
      macdHist: lastHist,
      macdHistDir: macdHistDir,
      macdLine: lastMacdLine,
      macdSignal: lastMacdSig,
      macdAboveSignal: lastMacdLine > lastMacdSig,
      macdCross: macdCross,
      adx: lastAdx,
      // Volatility
      atr: lastAtr,
      atrPct: pctDist(lastClose + lastAtr, lastClose), // ATR as % of price
      // Expected-move input: per-bar σ of log returns over the last 60
      // bars. Feeds the probability cone in the Volatility block (Option A)
      // and the Expected Move card (Option B). null when <10 clean returns.
      emSigma: emReturnSigma(closes, 60),
      // Volume
      volume: lastVol,
      volumeMa20: lastVolMa,
      volumeRatio: (isFinite(lastVolMa) && lastVolMa > 0) ? (lastVol / lastVolMa) : null,
      volumeAboveAvg: isFinite(lastVolMa) && lastVol > lastVolMa,
      volTrend: volTrend,
      // Structure
      trend: trend,
      momentum: momentum,
      swingHigh: recentHigh,
      swingLow: recentLow,
      swingHighDistPct: recentHigh != null ? pctDist(recentHigh, lastClose) : null,
      swingLowDistPct: recentLow != null ? pctDist(lastClose, recentLow) : null,
      donHigh20: donHigh20,
      donLow20: donLow20,
      rangeHigh: rangeHigh,
      rangeLow: rangeLow,
      rangePosPct: rangePosPct,
      rangeLabel: rangeLabel,
      // ATH + resistance — see comment block above for rationale.
      // Daily TF only; null on weekly/hourly. Consumed by the
      // plan generator (T1 cap, WHY BUY checklist, ATH trigger).
      athHigh: athHigh,
      athDistPct: athDistPct,
      nearestResistance: nearestResistance,
      nearestResistanceLabel: nearestResistanceLabel,
      headroomPct: headroomPct,
      // Pattern
      patternBull: pat.bull,
      patternBear: pat.bear,
      // Compression patterns (Inside Bar / NR4) and neutral Doji
      // travel separately from the directional bull/bear pattern
      // since they're "wait for break" or "indecision" signals,
      // not buy/sell triggers. Either or both may coexist with a
      // bull/bear pattern on the same bar.
      patternCompression: pat.compression,
      patternNeutral:     pat.neutral,
      // Last 21 closes — needed by the multi-trigger screener
      // (relative-strength check vs Nifty, momentum slope, etc.).
      // Kept as a short tail to limit memory; everything we use
      // it for only looks back 5/10/20 bars.
      recentCloses: closes.slice(-21)
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DUAL-HORIZON SWING / POSITION TRADE STYLES
  // ═══════════════════════════════════════════════════════════════
  // Every trigger gets stamped with one of these style profiles so
  // the downstream plan (entry timing, SL/T1/T2 multipliers, exit
  // rules, holding window) is style-appropriate. SWING and POSITION
  // are two DIFFERENT trades with the same setup geometry — the
  // difference is how long you hold and how aggressively you target.
  //
  // SWING (1–2 week holds, daily-driven):
  //   • Entry on today's close or next-day open (CNC delivery)
  //   • T1 = 1.5R (50% scale-out), T2 = 3R (let runner trail)
  //   • Stop: max(swing-low, entry − 2 ATR), with 0.3 ATR cushion
  //   • Time stop: 15 trading days
  //   • Structural exit: daily close < 20 EMA
  //
  // POSITION (1–3 month holds, weekly-driven):
  //   • Entry next-day open (limit at entry price)
  //   • T1 = 2.5R (33% scale-out), T2 = 5R (33% scale-out)
  //   • Stop: max(entry × 0.92, weekly-swing-low), 8% max risk
  //     (Minervini's hard-stop rule for position trades)
  //   • Time stop: 90 trading days (~4.5 months)
  //   • Structural exit: weekly close < weekly 20 EMA (Stage 2 broken)
  var STYLE_RULES = {
    SWING: {
      label: 'SWING',
      holdMin: 5, holdMax: 15, holdTypical: 10,
      t1RR: 1.5, t2RR: 3.0,
      // stopMaxLossPct = 6 — hard cap on swing-trade risk.
      // Industry standard for 5-15 day swings is 5-7%. Without
      // this cap a structural stop (e.g. distant swing low) can
      // produce 15-20% stops which are no longer "swing trades"
      // by any pro definition. The cap kicks in only when the
      // structural / ATR-based stop is wider than 6% from entry.
      stopAtrMult: 2.0, stopMaxLossPct: 6,
      entryTiming: 'today\'s close or next-day open (limit at entry price)',
      structuralExit: 'daily close < 20 EMA',
      trailingExit: 'after +1R: trail by daily 20 EMA close',
      earlyExit: 'bearish reversal candle on daily after profit > 1R',
      scaleOut: 'sell 50% at T1, let 50% run to T2'
    },
    POSITION: {
      label: 'POSITION',
      holdMin: 25, holdMax: 90, holdTypical: 50,
      t1RR: 2.5, t2RR: 5.0,
      stopAtrMult: 2.5, stopMaxLossPct: 8,
      entryTiming: 'next-day open (limit at entry price)',
      structuralExit: 'weekly close < weekly 20 EMA (Stage 2 broken)',
      trailingExit: 'after +2R: trail by weekly close < weekly 20 EMA',
      earlyExit: 'two consecutive weekly bear closes after profit > 2R',
      scaleOut: 'sell 33% at T1, 33% at T2, trail the final 33%'
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // TRADE PLAN GENERATOR — multi-trigger screener with style tagging
  // ═══════════════════════════════════════════════════════════════
  function generatePlan(monthly, weekly, daily, hourly, marketRegime) {
    // ── Multi-trigger screener (Option A) ──
    // Instead of a single "pullback to support" rule (which
    // generates ≤1 BUY per 100 scans on most days), we evaluate
    // SIX independent professional swing-entry ideas in parallel
    // and union the results. A stock that lights up multiple
    // triggers gets a confluence bonus (these are the A-grade
    // setups). Universal gates (market regime, ADX, relative
    // strength) demote or block weak environments.
    //
    // Timeframe roles (post 1M-context upgrade):
    //   Monthly — strategic context (Stage 1/2/3/4). Warn-only:
    //             surfaces in WHY BUY + skipIf but does NOT block.
    //   Weekly  — dominant intermediate trend (mandatory).
    //   Daily   — setup detection + entry trigger (mandatory).
    //   Hourly  — tactical entry timing only (informational).
    // Monthly + Hourly are both optional — a missing monthly (rare;
    // happens when Upstox returns < 6 months of history for a new
    // listing) or hourly (backtest beyond the 60-day 1H window)
    // just shifts the verdict by at most one confidence band.
    if (!weekly || !daily) {
      return { ok: false, reason: 'Not enough historical data for one or more timeframes.' };
    }

    // ── Monthly Stage detector (Weinstein-style 4-stage). ──
    // Stage 1: BASE — price flat near 20M EMA, momentum recovering.
    // Stage 2: MARKUP — price > 20M EMA, EMA rising (the GOOD zone).
    // Stage 3: DISTRIBUTION — price near/just above 20M EMA but
    //          momentum fading (late-cycle, reduce size).
    // Stage 4: MARKDOWN — price < 20M EMA, EMA falling (AVOID zone).
    // Returns null when monthly is missing or has too few bars.
    function monthlyStage(m) {
      if (!m || m.ema20 == null || m.lastClose == null) return null;
      var aboveEma = m.lastClose >= m.ema20;
      var farAbove = m.ema20DistPct != null && m.ema20DistPct > 6;
      var rising = m.ema20Slope === 'rising';
      var falling = m.ema20Slope === 'falling';
      var rsi = (m.rsi != null && isFinite(m.rsi)) ? m.rsi : 50;
      // Stage 4 — clear monthly downtrend
      if (!aboveEma && falling) {
        return {
          key: 'STAGE_4', label: 'Stage 4 markdown',
          tone: 'avoid', scoreDelta: -2,
          note: 'multi-year downtrend \u2014 major headwind for any long swing'
        };
      }
      // Stage 3 — distribution: price still above EMA but EMA
      // flattening AND RSI rolled over from elevated levels
      if (aboveEma && !rising && rsi < 55 && farAbove) {
        return {
          key: 'STAGE_3', label: 'Stage 3 distribution',
          tone: 'caution', scoreDelta: -1,
          note: 'late-cycle topping pattern \u2014 consider half-size'
        };
      }
      // Stage 2 — markup: price above rising EMA. The good zone.
      if (aboveEma && rising) {
        return {
          key: 'STAGE_2', label: 'Stage 2 markup',
          tone: 'good', scoreDelta: 1,
          note: 'multi-year uptrend intact \u2014 the strategic green zone'
        };
      }
      // Stage 1 — base: flat-ish, recovering. Acceptable for
      // breakout-style entries but no tailwind.
      return {
        key: 'STAGE_1', label: 'Stage 1 base',
        tone: 'neutral', scoreDelta: 0,
        note: 'multi-year consolidation \u2014 breakout candidate, no tailwind yet'
      };
    }
    var monthlyStageInfo = monthlyStage(monthly);

    // ── Support detector — used both by the AT_SUPPORT trigger
    // and by the REVERSAL_AT_SUPPORT trigger (a bullish reversal
    // candle at a known support is much higher-probability than
    // the same candle in mid-air). Three independent supports
    // get checked; the support must be RISING (we're buying a
    // retest, not catching a falling knife).
    function detectSupports(d, w) {
      var out = [];
      // 1. Daily 50 EMA — the classic trend-pullback support.
      if (d.ema50DistPct != null && d.ema50DistPct >= -0.5 && d.ema50DistPct <= 1.5
          && d.ema50Slope === 'rising') {
        out.push({ type: 'EMA50_DAILY', label: 'Daily 50 EMA', level: d.ema50, distPct: d.ema50DistPct });
      }
      // 2. Weekly 20 EMA — wider tolerance because weekly MAs trail.
      if (w.ema20DistPct != null && w.ema20DistPct >= -1 && w.ema20DistPct <= 2.5
          && w.ema20Slope === 'rising') {
        out.push({ type: 'EMA20_WEEKLY', label: 'Weekly 20 EMA', level: w.ema20, distPct: w.ema20DistPct });
      }
      // 3. Daily swing-low retest — horizontal consolidation base.
      // Also requires the underlying 50 EMA to be rising; a swing
      // low sitting above a FALLING 50 EMA is just a temporary
      // pause inside a downtrend, not a real support.
      if (d.swingLow != null && d.swingLow > 0 && d.lastClose >= d.swingLow
          && d.lastClose <= d.swingLow * 1.025
          && d.ema50 != null && d.swingLow > d.ema50 * 0.95
          && d.ema50Slope === 'rising') {
        out.push({
          type: 'SWING_LOW', label: 'Daily swing low', level: d.swingLow,
          distPct: ((d.lastClose - d.swingLow) / d.swingLow) * 100
        });
      }
      return out;
    }

    // ── Trigger 1: AT SUPPORT (textbook pullback to MA / swing low).
    // Requires a bullish backdrop on at least one of W/D so we
    // don't fire on supports inside a downtrend. SWING-style:
    // these supports get re-tested over 7–15 trading days; that's
    // the natural rhythm of a daily pullback.
    function tAtSupport(d, w, sups) {
      if (sups.length === 0) return null;
      var weeklyBull = w.trend && w.trend.indexOf('BULL') >= 0;
      var dailyBull  = d.trend && d.trend.indexOf('BULL') >= 0;
      if (!weeklyBull && !dailyBull) return null;
      var conflBonus = (sups.length - 1) * 2; // 0 / +2 / +4
      var trendBonus = (weeklyBull && dailyBull) ? 2 : 1;
      return {
        type: 'AT_SUPPORT',
        style: 'SWING',
        short: sups.length > 1 ? 'Support\u00d7' + sups.length : 'Support',
        label: sups.map(function (s) { return s.label; }).join(' + '),
        score: 4 + conflBonus + trendBonus,
        supports: sups,
        rsRequired: false
      };
    }

    // ── Trigger 2: PULLBACK TO 20 EMA.
    // Stock in confirmed uptrend (20>50>200, all rising), price
    // pulls into the 20 EMA band with a bullish confirmation
    // candle. Highest-frequency continuation setup for swing.
    function tPullback(d, w) {
      if (d.ema20 == null || d.ema50 == null) return null;
      if (!(d.ema20 > d.ema50)) return null;
      if (d.ema50Slope !== 'rising') return null;
      if (!(d.trend === 'BULL' || d.trend === 'STRONG_BULL')) return null;
      if (d.ema20DistPct == null) return null;
      if (d.ema20DistPct < -1.5 || d.ema20DistPct > 2.5) return null;
      // Bullish confirmation: any bull candle pattern, OR close
      // above the 5-day average (basic momentum proof).
      var recent = d.recentCloses || [];
      var n = recent.length;
      var avg5 = null;
      if (n >= 5) {
        var s5 = 0;
        for (var i = n - 5; i < n; i++) s5 += recent[i];
        avg5 = s5 / 5;
      }
      var confirmsClose = avg5 != null && d.lastClose > avg5;
      var hasPattern = !!d.patternBull;
      if (!confirmsClose && !hasPattern) return null;
      var volBoost = (d.volumeRatio != null && d.volumeRatio >= 1.2) ? 1 : 0;
      var weeklyBoost = (w.trend === 'BULL' || w.trend === 'STRONG_BULL') ? 1 : 0;
      var patternBoost = hasPattern ? 1 : 0;
      var label = 'Pullback to 20 EMA' + (hasPattern ? ' + ' + d.patternBull : '');
      return {
        type: 'PULLBACK_20EMA',
        style: 'SWING',
        short: 'Pullback',
        label: label,
        score: 5 + volBoost + weeklyBoost + patternBoost,
        rsRequired: true
      };
    }

    // ── Trigger 3: 20-DAY BREAKOUT WITH VOLUME.
    // Close above the prior 20-day high on above-average volume,
    // not extended too far from MAs (avoid late-stage chases).
    // Classic Darvas / O'Neil breakout style. Gets a +2 / +3
    // score boost when the breakout ALSO clears the 52-week
    // high or ATH — those are the highest-base-rate variants
    // because there's literally no overhead supply above them.
    function tBreakout(d, w) {
      if (d.lastClose == null) return null;
      // Three valid breakout shapes (any one qualifies):
      //   (a) 20-day high pop  \u2014 close > donHigh20 * 1.002
      //   (b) 52-week high clear  \u2014 close >= rangeHigh * 0.999
      //   (c) All-time high clear  \u2014 close >= athHigh * 0.999
      // Shape (a) catches normal continuation breakouts; (b) and
      // (c) catch consolidation breakouts near range highs that
      // wouldn't pop a 20-day high because they've been ranging
      // sideways for weeks. Folded together into one trigger as
      // part of the May 2026 factor-simplification pass (was
      // previously a dedicated tATHBreakout trigger).
      var clearsATH    = d.athHigh   != null && d.lastClose >= d.athHigh   * 0.999;
      var clears52WH   = d.rangeHigh != null && d.lastClose >= d.rangeHigh * 0.999;
      var clearsDon20  = d.donHigh20 != null && d.lastClose >= d.donHigh20 * 1.002;
      if (!clearsATH && !clears52WH && !clearsDon20) return null;
      if (d.volumeRatio == null || d.volumeRatio < 1.3) return null;
      if (d.ema50DistPct == null || d.ema50DistPct > 12) return null;
      if (!(d.trend === 'BULL' || d.trend === 'STRONG_BULL')) return null;
      if (d.ema50Slope !== 'rising') return null;
      var volBoost = (d.volumeRatio >= 2.0) ? 2 : 1;
      var weeklyBoost = (w.trend === 'BULL' || w.trend === 'STRONG_BULL') ? 1 : 0;
      // Range-context boost \u2014 clearing the 52WH or ATH adds
      // significant score because the trade has zero / minimal
      // overhead supply above it.
      var rangeBoost = 0;
      var rangeTag = '';
      if (clearsATH) {
        rangeBoost = 3;
        rangeTag = ' + ATH clear';
      } else if (clears52WH) {
        rangeBoost = 2;
        rangeTag = ' + 52WH clear';
      } else if (d.athDistPct != null && d.athDistPct >= -5) {
        rangeBoost = 1;
        rangeTag = ' (near ATH)';
      } else if (d.rangePosPct != null && d.rangePosPct >= 90) {
        rangeBoost = 1;
        rangeTag = ' (near 52WH)';
      }
      // ATH / 52WH breakouts with weekly volume confirmation get
      // POSITION style (they tend to run for months, not weeks).
      var style = (clearsATH || clears52WH)
                  && w.volumeRatio != null && w.volumeRatio >= 1.4
                  ? 'POSITION' : 'SWING';
      // type label preserved for back-compat with scanner +
      // backtest setupTypeLabel mappings.
      var typeStr = clearsATH ? 'ATH_BREAKOUT'
                  : clears52WH ? 'YEAR_HIGH_BREAKOUT'
                  : 'BREAKOUT_20D';
      var shortStr = clearsATH ? 'ATH BO'
                   : clears52WH ? '52WH BO'
                   : 'Breakout';
      var labelStr = (clearsATH ? 'All-time high breakout'
                    : clears52WH ? '52-week high breakout'
                    : '20-day high breakout')
                   + ' (vol ' + d.volumeRatio.toFixed(1) + 'x avg)' + rangeTag;
      return {
        type: typeStr,
        style: style,
        short: shortStr,
        label: labelStr,
        score: 5 + volBoost + weeklyBoost + rangeBoost,
        rsRequired: false
      };
    }

    // ── Trigger 4: BULLISH REVERSAL AT SUPPORT.
    // A bullish reversal pattern (Hammer / Bullish Engulfing /
    // Morning Star / Piercing Line) firing AT a support level.
    // The pattern alone is noise; the pattern at support is one
    // of the highest base-rate setups in swing trading.
    function tReversal(d, w) {
      if (!d.patternBull) return null;
      var P = d.patternBull;
      // Pattern tier — Hammer / Bullish Engulfing / Morning Star /
      // Piercing Line are STRONG reversals (high base-rate when
      // they confirm). Inverted Hammer is WEAK — it requires
      // next-bar follow-through to be tradable, so we treat it
      // as a "needs more confirmation" pattern that only fires
      // with volume + a bullish daily trend backdrop.
      var strongPatterns = (P === 'Hammer' || P === 'Bullish Engulfing'
                          || P === 'Morning Star' || P === 'Piercing Line');
      var weakPatterns   = (P === 'Inverted Hammer');
      if (!strongPatterns && !weakPatterns) return null;

      // ── Hard structural blockers ──
      // The whole point of "reversal at support" is to fade an
      // OVERSOLD pullback inside a healthy trend — not to catch
      // a falling knife inside a confirmed downtrend. Block both:
      //   - weekly BEAR or STRONG_BEAR (was only STRONG_BEAR — bug)
      //   - daily STRONG_BEAR (was not checked at all — bug)
      if (w.trend === 'BEAR' || w.trend === 'STRONG_BEAR') return null;
      if (d.trend === 'STRONG_BEAR') return null;

      // Weak patterns (Inverted Hammer) demand extra confirmation
      // because the pattern alone is unreliable. Require:
      //   - daily trend to be at minimum NEUTRAL (not even BEAR)
      //   - volume on the reversal bar ≥ 1.3× average
      if (weakPatterns) {
        if (d.trend === 'BEAR') return null;
        if (d.volumeRatio == null || d.volumeRatio < 1.3) return null;
      }

      // ── Support detector — each level must be a TRUE support,
      // not just "price happens to be near a moving average". A
      // falling 50 EMA in a downtrend is RESISTANCE, not support.
      var nearWhat = null;
      // 50 EMA must be near + RISING (true support). Old code
      // skipped the slope check, which is what let RELIANCE
      // (Inverted Hammer at a falling 50 EMA) become a BUY.
      if (d.ema50 != null
          && Math.abs((d.lastClose - d.ema50) / d.ema50) < 0.03
          && d.ema50Slope === 'rising'
          && d.lastClose >= d.ema50 * 0.98) {
        nearWhat = '50 EMA';
      // 200 EMA must be near + price ABOVE it (otherwise we're
      // bouncing INTO long-term resistance, not off long-term
      // support). We don't have a 200-EMA slope flag, so we
      // approximate "rising" by requiring price above it.
      } else if (d.ema200 != null
                 && Math.abs((d.lastClose - d.ema200) / d.ema200) < 0.025
                 && d.lastClose >= d.ema200) {
        nearWhat = '200 EMA';
      // Swing-low retest must be (a) at-or-just-above the low and
      // (b) sitting above a RISING 50 EMA so it's a consolidation
      // base inside a trend, not a lower-low inside a downtrend.
      } else if (d.swingLow != null
                 && (d.lastClose - d.swingLow) / d.swingLow < 0.02
                 && d.lastClose >= d.swingLow
                 && d.ema50 != null && d.swingLow > d.ema50 * 0.97
                 && d.ema50Slope === 'rising') {
        nearWhat = 'swing low';
      }
      if (!nearWhat) return null;

      var volBoost = (d.volumeRatio != null && d.volumeRatio >= 1.2) ? 1 : 0;
      var weeklyBoost = (w.trend === 'BULL' || w.trend === 'STRONG_BULL') ? 1 : 0;
      // Weak-pattern penalty — even after passing all the gates,
      // Inverted Hammer scores 1 point below strong patterns so
      // composite-score / confluence math doesn't over-weight it.
      var patternPenalty = weakPatterns ? -1 : 0;
      return {
        type: 'REVERSAL_AT_SUPPORT',
        style: 'SWING',
        short: 'Reversal',
        label: P + ' at ' + nearWhat,
        score: 4 + volBoost + weeklyBoost + patternPenalty,
        rsRequired: false
      };
    }

    // ── Trigger 5: WEEKLY STAGE-2 BREAKOUT.
    // Weinstein's Stage 2 framework: weekly close breaks out above
    // the 20-week high with the weekly 20 EMA rising. Multi-month
    // legs typically follow these — average hold 6–12 weeks. The
    // POSITION-style entry; SWING traders rarely catch the full
    // run because they exit on the first daily pullback.
    // ── Relative Strength vs Nifty (20-day return ratio).
    // Returns the stock's 20-day return MINUS Nifty's 20-day
    // return, expressed in percentage points. Positive = stock
    // is outperforming the index. The professional screener
    // mantra "buy what's already outperforming" comes from
    // decades of cross-sectional momentum research showing the
    // top-decile-RS basket beats the index by 4-6% annualised.
    // Returns null if either series lacks 20 closes.
    function computeRSpp(d, regime) {
      if (!regime || !regime.recentCloses) return null;
      var sc = d.recentCloses || [];
      var nc = regime.recentCloses || [];
      if (sc.length < 21 || nc.length < 21) return null;
      var sRet = (sc[sc.length - 1] - sc[sc.length - 21]) / sc[sc.length - 21];
      var nRet = (nc[nc.length - 1] - nc[nc.length - 21]) / nc[nc.length - 21];
      return (sRet - nRet) * 100;
    }

    // Confidence % derived from final composite score, trigger
    // count, RS, and regime. Clamped to the band of the
    // categorical confidence label so the % can't visually
    // disagree with the HIGH/MEDIUM/LOW chip.
    function confidencePctFor(label, score, trigCount, regimeStr) {
      if (label == null || label === '\u2014') return null;
      var scoreStr  = Math.min(Math.max((score - 4) / 8, 0), 1);
      var trigStr   = Math.min((trigCount || 0) / 3, 1);
      var regimeStr2 = (regimeStr === 'BULL') ? 1
                     : (regimeStr === 'NEUTRAL') ? 0.5 : 0;
      // RS factor removed in May 2026 simplification \u2014 weight
      // redistributed to score (60%) and trigger count (25%).
      var raw = 0.60 * scoreStr + 0.25 * trigStr + 0.15 * regimeStr2;
      var pct = Math.round(raw * 100);
      if (label === 'HIGH')        pct = Math.max(75, Math.min(95, pct));
      else if (label === 'MEDIUM') pct = Math.max(55, Math.min(74, pct));
      else if (label === 'LOW')    pct = Math.max(35, Math.min(54, pct));
      return pct;
    }

    var supports = detectSupports(daily, weekly);
    var regimeStr = (marketRegime && marketRegime.regime) ? marketRegime.regime : 'UNKNOWN';
    var rsPp = computeRSpp(daily, marketRegime);
    var adxOk = daily.adx == null || daily.adx >= 18;

    // ── Per-TF score breakdown (kept for the per-TF cards in the
    // analyzer detail panel — same shape as before so the
    // rendering code doesn't change). The screener verdict itself
    // is driven by the multi-trigger logic below, not by this
    // score; we maintain it as an explanatory artefact so a
    // user can drill into "why did this fire?".
    var tfScore = { '1mo': 0, '1w': 0, '1d': 0, '1h': 0 };
    var tfSignals = { '1mo': [], '1w': [], '1d': [], '1h': [] };
    var bullSignals = [];
    var bearSignals = [];
    function addBull(pts, label, tf) {
      bullSignals.push(label);
      if (tf) { tfScore[tf] += pts; tfSignals[tf].push({ pts: pts,  label: label, dir: 'bull' }); }
    }
    function addBear(pts, label, tf) {
      bearSignals.push(label);
      if (tf) { tfScore[tf] -= pts; tfSignals[tf].push({ pts: -pts, label: label, dir: 'bear' }); }
    }
    // Monthly contributions to the per-TF breakdown — strategic
    // trend + momentum, mirrors the W/D pattern. Stage-derived
    // bullets go via monthlyStageInfo above; these are raw trend
    // facts for the detail card. MUST sit AFTER bullSignals /
    // bearSignals are initialized — `var` hoists the declaration
    // but not the `= []` assignment, so calling addBull before
    // these lines would push onto `undefined`.
    if (monthly) {
      if (monthly.trend === 'STRONG_BULL') addBull(3, 'Monthly strong uptrend', '1mo');
      else if (monthly.trend === 'BULL')   addBull(2, 'Monthly uptrend', '1mo');
      else if (monthly.trend === 'STRONG_BEAR') addBear(3, 'Monthly strong downtrend', '1mo');
      else if (monthly.trend === 'BEAR')   addBear(2, 'Monthly downtrend', '1mo');
      if (monthly.ema20Slope === 'rising') addBull(1, 'Monthly 20 EMA rising', '1mo');
      else if (monthly.ema20Slope === 'falling') addBear(1, 'Monthly 20 EMA falling', '1mo');
      if (monthly.lastClose != null && monthly.ema20 != null) {
        if (monthly.lastClose >= monthly.ema20) addBull(1, 'Monthly close above 20 EMA', '1mo');
        else                                      addBear(1, 'Monthly close below 20 EMA', '1mo');
      }
    }
    if (weekly.trend === 'STRONG_BULL') addBull(3, 'Weekly strong uptrend', '1w');
    else if (weekly.trend === 'BULL')   addBull(2, 'Weekly uptrend', '1w');
    else if (weekly.trend === 'STRONG_BEAR') addBear(3, 'Weekly strong downtrend', '1w');
    else if (weekly.trend === 'BEAR')   addBear(2, 'Weekly downtrend', '1w');
    if (weekly.momentum === 'STRONG_BULL' || weekly.momentum === 'BULL') addBull(1, 'Weekly momentum positive', '1w');
    if (weekly.momentum === 'STRONG_BEAR' || weekly.momentum === 'BEAR') addBear(1, 'Weekly momentum negative', '1w');
    if (daily.trend === 'STRONG_BULL') addBull(2, 'Daily strong uptrend', '1d');
    else if (daily.trend === 'BULL')   addBull(1, 'Daily uptrend', '1d');
    else if (daily.trend === 'STRONG_BEAR') addBear(2, 'Daily strong downtrend', '1d');
    else if (daily.trend === 'BEAR')   addBear(1, 'Daily downtrend', '1d');
    if (daily.momentum === 'STRONG_BULL') addBull(2, 'Daily momentum surging', '1d');
    else if (daily.momentum === 'BULL')   addBull(1, 'Daily momentum positive', '1d');
    else if (daily.momentum === 'STRONG_BEAR') addBear(2, 'Daily momentum collapsing', '1d');
    else if (daily.momentum === 'BEAR')   addBear(1, 'Daily momentum negative', '1d');
    if (daily.patternBull) addBull(1, 'Daily ' + daily.patternBull, '1d');
    if (daily.patternBear) addBear(1, 'Daily ' + daily.patternBear, '1d');
    if (hourly) {
      if (hourly.momentum === 'STRONG_BULL' || hourly.momentum === 'BULL') addBull(1, '1H momentum confirms', '1h');
      if (hourly.momentum === 'STRONG_BEAR' || hourly.momentum === 'BEAR') addBear(1, '1H momentum confirms short', '1h');
    }

    // ── Evaluate ALL triggers ──
    // SWING triggers run on daily-driven setups (1–2 week holds).
    // POSITION triggers run on weekly-driven setups (1–3 month
    // holds). A stock can fire any combination; downstream logic
    // picks a primary by composite score and exposes the rest in
    // the analyzer detail panel.
    // ── Trigger evaluation (4 triggers, post-simplification) ──
    // Mapped 1:1 to the user's chart-reading mental model:
    //   AT_SUPPORT  = "at support"
    //   PULLBACK    = "pulled back / retraced and ready to uptrend"
    //   BREAKOUT    = "going uptrend / breaking out" (now also
    //                  inside one trigger; was 3 triggers prior to
    //                  May 2026 simplification)
    //   REVERSAL    = "made some good pattern"
    var triggers = [];
    var t;
    if ((t = tAtSupport(daily, weekly, supports))) triggers.push(t);
    if ((t = tPullback(daily, weekly)))             triggers.push(t);
    if ((t = tBreakout(daily, weekly)))             triggers.push(t);
    if ((t = tReversal(daily, weekly)))             triggers.push(t);

    // ── Universal gates (post-simplification) ──
    // BEAR regime + LOW_ADX: softened from HARD BLOCKS to SCORE
    // PENALTIES (handled in composite-score section below). The
    // user's chart-reading framework says "the chart decides" \u2014
    // sometimes a defensive stock breaks out cleanly in a BEAR
    // Nifty regime; we shouldn't categorically block that. These
    // factors still surface as red banners in SKIP IF when active.
    //
    // WEAK_RS gate: REMOVED entirely. The chart already tells you
    // whether a stock is leading or lagging \u2014 no need for an
    // index-relative gate that just adds noise to discretionary
    // chart reading.
    //
    // Bansal 44 SMA remains the only HARD GATE below regime/ADX,
    // because it directly maps to the user's "weekly is reliable"
    // criterion in their mental model.
    var gateReason = 'NONE';
    var regimeWarn = (regimeStr === 'BEAR');
    var adxWarn = !adxOk;

    // ── Bansal 44+4 HARD GATE (weekly 44 SMA) ──
    // The most widely-cited Indian-market swing filter, popularised
    // by Rakesh Bansal: a stock is only in a tradable swing-uptrend
    // when price > rising weekly 44 SMA. Otherwise stay out, even
    // if the daily setup looks valid. Treats the 44-SMA as a long-
    // term trend "permission slip" — without it firing, no entry.
    //
    // Skip gracefully when weekly.sma44 is null (rare; happens for
    // new listings with < 44 weeks of history). Better to allow the
    // trade than to false-block it on a missing-data condition.
    if (weekly.sma44 != null && gateReason === 'NONE') {
      var belowSma44 = weekly.lastClose < weekly.sma44;
      var sma44Falling = weekly.sma44Slope === 'falling';
      if (belowSma44 || sma44Falling) {
        triggers = [];
        gateReason = 'BELOW_44SMA';
      }
    }

    // ── Composite score & confidence (post-simplification) ──
    // primary trigger = highest score; +1.5 per additional trigger
    // (confluence is the strongest signal); + monthly stage
    // modifier; - softened-gate penalties (regime, ADX).
    //
    // REMOVED in May 2026 simplification pass:
    //   - Strong RS +1 modifier (no more rsPp comparison)
    //   - NEUTRAL regime -1 modifier ("no opinion" should be 0)
    //
    // The remaining modifiers stay because each one maps to a
    // user-visible fact about the chart (multi-trigger / stage /
    // regime warning), not to invisible relative-strength math.
    var bias, confidence, action, confidencePct = null;
    var compositeScore = 0;
    var setupName, setupShort;
    if (triggers.length > 0) {
      triggers.sort(function (a, b) { return b.score - a.score; });
      var primary = triggers[0];
      compositeScore = primary.score + (triggers.length - 1) * 1.5;
      // Monthly stage modifier (Weinstein) \u2014 warn-only.
      // Stage 2 (+1) | Stage 1 (0) | Stage 3 (-1) | Stage 4 (-2).
      if (monthlyStageInfo) compositeScore += monthlyStageInfo.scoreDelta;
      // Softened-gate penalties (replaces the old hard blocks).
      // BEAR regime is now a -2 score penalty (likely fails the
      // quality floor on its own unless the trigger is very strong);
      // LOW_ADX is -1 (chop is bad but a clean chart pattern can
      // still win). Combined with the quality floor (>= 6), this
      // means "strong setups in a tough environment can still BUY,
      // but mediocre setups get demoted to WAIT" \u2014 which is
      // exactly the discretionary-chart-reading semantics the user
      // asked for.
      if (regimeWarn) compositeScore -= 2;
      if (adxWarn)    compositeScore -= 1;
      // Quality floor — a BUY label MUST clear the MEDIUM
      // confidence band (compositeScore >= 6). A LOW-band BUY
      // ("BUY LOW 35%") is a coin flip with extra steps; no
      // experienced trader actually takes those. Drop them
      // into the WAIT branch with a clear "low quality" reason
      // so users still see the trigger fired but understand
      // why we're not calling it a BUY.
      //
      // Threshold tuning rationale:
      //   - Bare Pullback (score 5) + NEUTRAL regime (-1)
      //     + Stage 2 monthly (+1) = 5. Does NOT clear 6.
      //     Needs a SECOND tailwind (RS, multi-trigger, BULL
      //     regime, etc.) to qualify as a BUY. That matches
      //     the pro principle: a single weak trigger in a
      //     mediocre environment is not a trade.
      //   - A typical clean BUY: Pullback (5) + Stage 2 (+1)
      //     + Strong RS (+1) = 7 (MEDIUM 60-70%). Trades.
      //   - A great BUY: Pullback+Breakout confluence (5+1.5)
      //     + Stage 2 (+1) + RS (+1) = 8.5 (HIGH ~80%).
      if (compositeScore < 6) {
        triggers = [];
        gateReason = 'LOW_QUALITY';
      }
    }
    if (triggers.length > 0) {
      var primaryAfter = triggers[0];
      if (compositeScore >= 9)      confidence = 'HIGH';
      else if (compositeScore >= 6) confidence = 'MEDIUM';
      else                           confidence = 'LOW';
      action = 'BUY';
      bias = 'BULLISH';
      confidencePct = confidencePctFor(confidence, compositeScore, triggers.length, regimeStr);
      // Short label: comma-join the trigger.short for the table.
      // Full label: primary trigger's detailed label for the
      // analyzer detail panel.
      setupShort = triggers.map(function (t) { return t.short; }).join(' + ');
      setupName  = primaryAfter.label
        + (triggers.length > 1
            ? ' (+' + (triggers.length - 1) + ' more: '
                + triggers.slice(1).map(function (t) { return t.short; }).join(', ') + ')'
            : '');
    } else {
      // No trigger survived. Classify the no-trade as WAIT or
      // AVOID based on the trend stance — AVOID only for confirmed
      // downtrends (Daily BEAR + Weekly not bullish), so users
      // skip the stock entirely. Otherwise WAIT and re-scan later.
      var weeklyBearish = weekly.trend === 'BEAR' || weekly.trend === 'STRONG_BEAR';
      var dailyBearish  = daily.trend  === 'BEAR' || daily.trend  === 'STRONG_BEAR';
      if (dailyBearish && weeklyBearish) {
        action = 'AVOID'; bias = 'BEARISH';
        confidence = (daily.trend === 'STRONG_BEAR' && weekly.trend === 'STRONG_BEAR') ? 'HIGH' : 'MEDIUM';
      } else if (dailyBearish || (gateReason === 'NONE' && weeklyBearish)) {
        action = 'AVOID'; bias = 'BEARISH'; confidence = 'LOW';
      } else {
        action = 'WAIT'; bias = 'NEUTRAL'; confidence = 'LOW';
      }
    }

    // Legacy `score` field — many UI surfaces still display
    // "score +N". We expose the composite trigger score (BUY) or
    // a tf-based proxy (WAIT/AVOID) so existing renderers keep
    // working without conditional checks.
    // 1H removed from tfScore voting in May 2026 simplification
    // pass (signal too noisy at low TF; was already demoted to
    // optional). Still computed + shown in the detail panel as
    // info, just no longer influences the verdict.
    var tfNetScore = (tfScore['1mo'] || 0) + (tfScore['1w'] || 0) + (tfScore['1d'] || 0);
    var legacyScore = (action === 'BUY')
      ? Math.round(compositeScore * 10) / 10
      : tfNetScore;

    // ── WAIT / AVOID returns ──
    if (action === 'WAIT' || action === 'AVOID') {
      var msg, skipIf, headline;
      if (action === 'AVOID') {
        headline = 'AVOID \u2014 stock is in a downtrend (cash equity = no short)';
        var topBear = bearSignals.slice(0, 3);
        msg = 'Stock is trending DOWN across timeframes. Top bearish signals: '
          + topBear.join('; ') + '. Cash-equity swing traders can only BUY stocks, not short them \u2014 so this is a NO-TRADE. '
          + 'Skip and scan another stock for a clean bullish setup.';
        skipIf = [
          'Buying this stock now \u2014 you\'d be fighting a confirmed downtrend',
          'Trying to "catch the bottom" \u2014 wait until at least the Daily flips back to UP, then re-analyze'
        ];
      } else if (gateReason === 'LOW_QUALITY') {
        // Build dynamic context bits so the user knows WHY the
        // composite score didn't clear 6. The softened-gate
        // penalties (regime / ADX) are the most common culprits
        // post-simplification; surfacing them here keeps the
        // engine honest about why a trigger was demoted to WAIT.
        var lowCtx = [];
        if (regimeWarn) {
          var regimeBits = marketRegime
            ? 'Nifty closed ' + (marketRegime.distPct >= 0 ? '+' : '') + marketRegime.distPct.toFixed(2)
              + '% vs its 50 DMA (falling)'
            : 'Nifty is below its 50 DMA';
          lowCtx.push('Market regime is BEAR (' + regimeBits + ') \u2014 \u22122 score penalty');
        }
        if (adxWarn) {
          lowCtx.push('Daily ADX is ' + (daily.adx != null ? daily.adx.toFixed(0) : '?') + ' \u2014 below 18 = chop \u2014 \u22121 score penalty');
        }
        if (monthlyStageInfo && monthlyStageInfo.scoreDelta < 0) {
          lowCtx.push('Monthly stage is ' + monthlyStageInfo.stage + ' (' + monthlyStageInfo.label + ') \u2014 ' + monthlyStageInfo.scoreDelta + ' score penalty');
        }
        headline = 'LOW QUALITY \u2014 a trigger fired but the setup is too weak to act on';
        msg = 'A trigger lit up, but the composite score came in below the actionable floor of 6. '
          + (lowCtx.length > 0 ? 'Context dragging the score down: ' + lowCtx.join('; ') + '. ' : '')
          + 'Wait for either a stronger pattern, a second confirming trigger, or a friendlier market regime before re-analyzing.';
        skipIf = lowCtx.concat([
          'Buying this on a single weak trigger \u2014 wait for confluence (2+ triggers) or a stronger pattern',
          'Forcing a position because "it\'s technically a BUY" \u2014 low quality has the worst risk:reward profile in the screener'
        ]);
      } else if (gateReason === 'BELOW_44SMA') {
        var sma44Bits = weekly.sma44 != null
          ? ('Weekly 44 SMA sits at ' + fmtPrice(weekly.sma44)
             + ', current weekly close is ' + fmtPrice(weekly.lastClose)
             + (weekly.sma44DistPct != null
                ? ' (' + (weekly.sma44DistPct >= 0 ? '+' : '')
                  + weekly.sma44DistPct.toFixed(1) + '% vs SMA)' : '')
             + (weekly.sma44Slope === 'falling' ? ', and the SMA itself is falling' : ''))
          : '';
        headline = 'BLOCKED \u2014 below the weekly 44 SMA (Bansal filter)';
        msg = 'The Bansal 44+4 rule \u2014 the most-cited Indian-market long-term swing filter \u2014 '
          + 'says a stock is only in a tradable swing-uptrend when price is above a RISING weekly 44 SMA. '
          + (sma44Bits ? sma44Bits + '. ' : '')
          + 'A daily setup firing under these conditions has historically failed at much higher rates '
          + 'than the same setup above the 44 SMA. Wait for either (a) a weekly close back above '
          + 'the SMA, or (b) the SMA to turn up after the recent decline, before re-analyzing.';
        skipIf = [
          'Buying below the weekly 44 SMA \u2014 you\u2019d be buying into a long-term downtrend',
          'Trying to "bottom-fish" a falling 44 SMA \u2014 the Bansal rule explicitly bans this trade'
        ];
      } else {
        headline = 'No trigger fired \u2014 wait for a setup';
        msg = 'None of the four entry triggers (Pullback to 20 EMA \u00b7 20-day Breakout \u00b7 Reversal at Support \u00b7 At MA Support) '
          + 'fired on the latest bar. The stock may still be in a clean trend \u2014 just no actionable entry today. '
          + 'Re-scan in 1\u20132 sessions or pick another stock from the BUY list.';
        skipIf = ['Buying right now \u2014 no trigger means no edge'];
      }
      return {
        ok: true,
        bias: bias, action: action, confidence: confidence, score: legacyScore,
        confidencePct: confidencePct,
        marketRegime: marketRegime || null,
        monthlyStage: monthlyStageInfo,
        supports: supports,
        triggers: triggers,
        rsPp: rsPp,
        gateReason: gateReason,
        setupName: headline,
        setupShort: '\u2014',
        entry: daily.lastClose,
        sl: null, t1: null, t2: null, rr: null, holding: null,
        why: msg,
        skipIf: skipIf,
        bullSignals: bullSignals,
        bearSignals: bearSignals,
        tfScore: tfScore,
        tfSignals: tfSignals
      };
    }

    // ── BUY plan — style-aware (SWING vs POSITION) ──
    // Primary trigger drives the style. The SL/T1/T2/holding
    // numbers all come from STYLE_RULES[primary.style] so a
    // POSITION-style trigger automatically gets the wider 2.5R/5R
    // targets, 8%-max stop, and 90-day time stop — without us
    // having to thread style through every helper.
    var primaryT = triggers[0];
    var rules = STYLE_RULES[primaryT.style] || STYLE_RULES.SWING;
    var entry = daily.lastClose;

    // Stop calculation:
    //   SWING:    max(swing-low, entry − 2 ATR) − 0.3 ATR cushion
    //   POSITION: same structural base BUT capped by max-loss-pct
    //             (8% from entry — Minervini's max-stop rule for
    //             multi-month holds where wider stops are needed
    //             but a 12% air-pocket would wreck the account).
    var structSL = daily.swingLow != null ? daily.swingLow : entry - rules.stopAtrMult * daily.atr;
    var atrSL    = entry - rules.stopAtrMult * daily.atr;
    var sl = Math.min(structSL, atrSL) - 0.3 * daily.atr;
    if (rules.stopMaxLossPct != null) {
      var maxLossSL = entry * (1 - rules.stopMaxLossPct / 100);
      // Use the TIGHTER of structural and max-loss-pct so a deep
      // swing low doesn't dictate a 15% stop on a position trade.
      if (sl < maxLossSL) sl = maxLossSL;
    }
    var risk = entry - sl;
    var t1 = entry + risk * rules.t1RR;
    var t2 = entry + risk * rules.t2RR;

    // ── Resistance-aware T1 cap. ──
    // The original T1 = entry + 1.5R / 2.0R is a clean math number,
    // but if it sits ABOVE the nearest overhead resistance (a
    // recent swing high / 52WH / ATH) then in practice price will
    // stall at that resistance, not at our nice round R-multiple.
    // Cap T1 at the resistance level (less a small buffer) so the
    // target is realistic. If the resistance is below entry+0.5R,
    // we mark the trade as "tight headroom" rather than capping
    // — that small a target isn't worth the trade.
    var t1Capped = false;
    var t1CapReason = null;
    var nearestRes = daily.nearestResistance;
    var nearestResLbl = daily.nearestResistanceLabel;
    var skipForResistance = false;
    if (nearestRes != null && nearestRes > entry) {
      var resBuffer = nearestRes * 0.998; // 0.2% below resistance
      if (resBuffer < entry + risk * 0.5) {
        // Less than 0.5R headroom — there's nowhere for the trade
        // to go. Mark the plan for the skip-conditions section.
        skipForResistance = true;
      } else if (resBuffer < t1) {
        t1 = resBuffer;
        t1Capped = true;
        t1CapReason = nearestResLbl;
        // Recompute T2 to maintain the original t2/t1 R-ratio
        // proportional to the new t1 distance — preserves the
        // scale-out math while keeping T2 still beyond resistance.
        var newT1R = (t1 - entry) / Math.max(risk, 1e-6);
        t2 = entry + risk * Math.max(rules.t2RR, newT1R * 2.0);
      }
    }
    var rr = Math.abs((t1 - entry) / (entry - sl));

    // Holding window — for SWING, derived from ATR (how many days
    // to reach T1 at typical bar range); for POSITION, just use
    // the style's typical hold because weekly bars don't have a
    // daily-ATR-equivalent that maps cleanly to multi-month moves.
    //
    // The naïve formula (T1−entry)/ATR systematically UNDER-counts
    // because daily moves are NOT monotonic — for every 1 ATR up,
    // a normal swing bar gives back ~0.5 ATR. Empirically a 1.5R
    // move that "looks like" 3 ATR away takes 7–10 bars to reach,
    // not 3. Multiplying the estimate by ~2 matches the historical
    // T1-hit distribution from our own backtest module.
    var holding;
    if (primaryT.style === 'SWING') {
      var atrDistance = Math.abs(t1 - entry) / Math.max(daily.atr, 1e-6);
      var holdEst = Math.round(atrDistance * 2.0);
      holding = Math.max(rules.holdMin, Math.min(rules.holdMax, holdEst));
    } else {
      holding = rules.holdTypical;
    }

    // ── Timeline + Exit rules (explicit, per-style) ──
    // The user asked for "specifically when to take, when to exit,
    // timeline". These fields make every BUY plan self-contained
    // — no need for the user to remember the SWING vs POSITION
    // distinction in their head.
    var nowMs = Date.now();
    var entryByMs = nowMs + 1 * 24 * 60 * 60 * 1000;
    var timeStopMs = nowMs + rules.holdMax * 24 * 60 * 60 * 1000;
    var timeline = {
      style: primaryT.style,
      styleLabel: rules.label,
      entryTiming: rules.entryTiming,
      entryBy: entryByMs,
      holdMin: rules.holdMin,
      holdMax: rules.holdMax,
      holdTypical: holding,
      timeStopBy: timeStopMs
    };
    // Each exit rule has WHAT (detail) and WHY (rationale). The
    // WHY exists because every professional trade plan worth its
    // salt explains the rule, not just states it — a user who
    // understands WHY a rule exists is far more likely to obey it
    // under stress than one who just memorised a price.
    var rrTextT1 = (rules.t1RR.toFixed(1)) + 'R';
    var rrTextT2 = (rules.t2RR.toFixed(1)) + 'R';
    var scaleT1 = (primaryT.style === 'SWING') ? 'sell 50%' : 'sell 33%';
    var scaleT2 = (primaryT.style === 'SWING') ? 'let final 50% run with trailing stop' : 'sell another 33%, trail the final 33%';
    var exitRules = [
      {
        kind: 'TARGET', label: 'Target 1',
        detail: fmtPrice(t1) + '  \u00b7  ' + rrTextT1 + '  \u00b7  '
          + ((t1 - entry) / entry * 100).toFixed(1) + '% above entry',
        action: scaleT1 + ' here',
        why: 'Locks in the first profit at a statistically high-probability resistance. '
          + rrTextT1 + ' targets are reached ~60\u201370% of the time when entry is well-timed, '
          + 'so scaling out here banks the bulk of expected value before the runner risks giving it back.'
      },
      {
        kind: 'TARGET', label: 'Target 2',
        detail: fmtPrice(t2) + '  \u00b7  ' + rrTextT2 + '  \u00b7  '
          + ((t2 - entry) / entry * 100).toFixed(1) + '% above entry',
        action: scaleT2,
        why: rrTextT2 + ' is the "big winner" zone \u2014 the trade has gone exactly as planned. '
          + 'Most trades never reach this level; the ones that do account for the bulk of yearly returns. '
          + 'Don\'t exit early on a runner that\'s working.'
      },
      {
        kind: 'STOP', label: 'Hard stop',
        detail: fmtPrice(sl) + '  \u00b7  '
          + ((sl - entry) / entry * 100).toFixed(1) + '% risk per share',
        action: 'GTT sell-stop the moment your buy fills',
        why: 'Placed just below the structural support (swing low / 2 ATR \u2014 whichever is tighter) '
          + 'so noise wicks don\'t shake you out, but a real structural break does. '
          + 'A close below this means the setup is invalidated; staying in costs more than admitting you were wrong.'
      },
      {
        kind: 'TRAIL', label: 'Trailing stop',
        detail: rules.trailingExit,
        action: 'Raise stop only \u2014 never lower it',
        why: 'Once the trade is in profit, the structural framework can guide the stop forward without '
          + 'capping the upside. The 20 EMA (' + (primaryT.style === 'SWING' ? 'daily' : 'weekly')
          + ') is the median dynamic support across decades of cash-equity data \u2014 '
          + 'price closing below it after a profitable run is the cleanest "trend has ended" signal you can use.'
      },
      {
        kind: 'STRUCTURAL', label: 'Structural exit',
        detail: rules.structuralExit,
        action: 'Exit on the NEXT bar\'s open (don\'t wait)',
        why: 'When the structural pillar of the trade breaks, the entire thesis is gone. '
          + 'This can fire BEFORE the hard stop \u2014 a stock that closes below the '
          + (primaryT.style === 'SWING' ? '20 EMA' : 'weekly 20 EMA')
          + ' with the trade in profit means the swing is over even if SL hasn\'t hit. '
          + 'Take what you have and move on.'
      },
      {
        kind: 'TIME', label: 'Time stop',
        detail: rules.holdMax + ' trading days max hold  \u00b7  '
          + ((rules.holdMax / 5) | 0) + ' calendar weeks  \u00b7  exit by '
          + _swFmtDate(nowMs + rules.holdMax * 24 * 60 * 60 * 1000),
        action: 'Exit at the open on day ' + (rules.holdMax + 1),
        why: 'Capital tied up in a dead trade is capital not earning anything. If neither T1 nor SL '
          + 'has fired by day ' + rules.holdMax + ', the setup has lost its edge \u2014 '
          + (primaryT.style === 'SWING'
             ? 'daily pullback setups statistically resolve within 3 weeks; beyond that, win rate drops sharply.'
             : 'weekly Stage-2 / pullback setups have a ~90-day window before the multi-month leg either materialises or fizzles.')
      },
      {
        kind: 'EARLY', label: 'Early exit',
        detail: rules.earlyExit,
        action: 'Take 75% off the table, trail the remaining 25%',
        why: 'A clean bearish reversal pattern (Shooting Star, Bearish Engulfing, Evening Star) '
          + 'after the trade is already profitable is the market giving you a "take some" warning. '
          + 'Most of these turn out to be local tops; ignoring them is how 30% profit turns into 5% profit by Friday.'
      }
    ];
    // Bansal 4 EMA weekly trailing-stop exit. Added to EVERY BUY
    // plan (both SWING and POSITION style) per the user's choice.
    // Conceptually: once the weekly close breaches the 4 EMA, the
    // multi-week up-leg is over. This is a SLOWER trail than the
    // daily 20 EMA one we already have — useful as a "final exit"
    // gate for traders who want to ride the trend until the weekly
    // tape confirms reversal, not just the daily.
    if (weekly.ema4 != null) {
      var ema4SlopeTxt = weekly.ema4Slope === 'rising' ? 'rising'
                      : weekly.ema4Slope === 'falling' ? 'falling'
                      : 'flat';
      exitRules.push({
        kind: 'TRAIL', label: 'Bansal trailing exit (4 EMA weekly)',
        detail: 'Currently ' + fmtPrice(weekly.ema4)
          + ' (' + ema4SlopeTxt + ')  \u00b7  exit when a weekly candle closes below this level',
        action: 'Exit on the NEXT Monday\u2019s open after a weekly close < 4 EMA',
        why: 'The 4 EMA weekly is Rakesh Bansal\u2019s "44+4" trailing stop \u2014 it rides ~1 month '
          + 'of price action so it ignores normal pullbacks but cuts you out the moment the multi-week '
          + 'up-leg genuinely breaks. Slower than the daily-20-EMA trail above (which is right for fast '
          + 'SWINGs) and serves as a final "is the long-term trend still intact?" check, especially '
          + 'valuable for POSITION-style holds where you don\u2019t want to react to every daily wiggle.'
      });
    }

    // ── WHY BUY \u2014 5 essential bullets only (post-simplification).
    //   1. PRIMARY TRIGGER (always)
    //   2. MONTHLY STAGE (Weinstein context \u2014 the user's "monthly first" check)
    //   3. BANSAL FILTER (weekly 44 SMA \u2014 the user's "weekly is reliable" check)
    //   4. WEEKLY TREND (alignment)
    //   5. RESISTANCE / HEADROOM (where can this trade actually go?)
    //
    // CONFLUENCE shown as bonus bullet ONLY if 2+ triggers fired
    // (genuinely additive information, rare enough to be worth
    // surfacing prominently).
    //
    // REMOVED in May 2026 simplification: Market regime (now in
    // SKIP IF when bearish), ADX, RS pp, RSI sweet-spot text,
    // volume ratio, 52-week range position, ATH proximity. All of
    // those are still computed for the detail panel cards \u2014 just
    // not duplicated into WHY BUY.
    var whyBuy = [];

    // 1. PRIMARY TRIGGER
    var primTrig = triggers[0];
    whyBuy.push('TRIGGER: ' + primTrig.label
      + ' (style: ' + primTrig.style + ', score ' + primTrig.score + ').');

    // Bonus bullet \u2014 multi-trigger confluence (rare and meaningful)
    if (triggers.length > 1) {
      var confTags = triggers.slice(1).map(function (x) { return x.short; }).join(', ');
      whyBuy.push('CONFLUENCE: ' + triggers.length + ' independent setups firing on the same bar (+ '
        + confTags + ') \u2014 strongest signal the screener can produce.');
    }

    // 2. MONTHLY STAGE \u2014 user's "monthly first" check
    if (monthlyStageInfo) {
      var stageTag;
      if (monthlyStageInfo.tone === 'good')         stageTag = 'MONTHLY';
      else if (monthlyStageInfo.tone === 'neutral') stageTag = 'MONTHLY';
      else if (monthlyStageInfo.tone === 'caution') stageTag = 'MONTHLY (warning)';
      else                                          stageTag = 'MONTHLY (headwind)';
      whyBuy.push(stageTag + ': ' + monthlyStageInfo.label
        + ' \u2014 ' + monthlyStageInfo.note + '.');
    }

    // 3. BANSAL FILTER \u2014 weekly 44 SMA, always passes (gate above)
    if (weekly.sma44 != null) {
      var slopeTxt = weekly.sma44Slope === 'rising' ? 'rising'
                   : weekly.sma44Slope === 'falling' ? 'falling'
                   : 'flat';
      var distTxt = weekly.sma44DistPct != null
        ? ' (' + (weekly.sma44DistPct >= 0 ? '+' : '')
          + weekly.sma44DistPct.toFixed(1) + '% above)'
        : '';
      whyBuy.push('BANSAL: Price ' + fmtPrice(weekly.lastClose)
        + ' is above the ' + slopeTxt + ' weekly 44 SMA '
        + fmtPrice(weekly.sma44) + distTxt
        + ' \u2014 long-term swing zone confirmed.');
    }

    // 4. WEEKLY TREND \u2014 alignment with higher TF
    if (weekly.trend === 'BULL' || weekly.trend === 'STRONG_BULL') {
      whyBuy.push('WEEKLY: trend is '
        + (weekly.trend === 'STRONG_BULL' ? 'STRONG UP (all weekly EMAs stacked)'
                                           : 'UP')
        + ' \u2014 dominant trend on our side.');
    } else if (weekly.trend === 'NEUTRAL') {
      whyBuy.push('WEEKLY: trend is FLAT \u2014 daily setup is leading, weekly not confirming yet (smaller size).');
    }

    // 5. RESISTANCE \u2014 where can this trade go?
    if (nearestRes != null && daily.headroomPct != null) {
      var hrTag = (daily.headroomPct >= 10)
        ? 'CLEAR PATH (' + daily.headroomPct.toFixed(1) + '% headroom)'
        : (daily.headroomPct >= 5)
          ? 'OK headroom (' + daily.headroomPct.toFixed(1) + '%)'
          : 'TIGHT headroom (' + daily.headroomPct.toFixed(1) + '%)';
      whyBuy.push('RESISTANCE: nearest overhead at ' + fmtPrice(nearestRes)
        + ' (' + nearestResLbl + ') \u2014 ' + hrTag
        + (t1Capped ? '. T1 capped just under wall.' : '.'));
    } else {
      whyBuy.push('RESISTANCE: no overhead supply in recent pivots \u2014 price in discovery zone.');
    }

    // ── Position sizing math — concrete numbers for a 1-lac
    // capital account at 1% risk-per-trade. Industry-standard
    // sizing rule (Van Tharp / Mark Douglas) prevents a single
    // bad trade from destroying the account. We compute for
    // ₹1,00,000 as that's the user's stated capital; the same
    // formula generalises to any account size.
    var assumedCapital = 100000;
    var riskPerShare = Math.max(0.01, entry - sl);
    var risk1Pct = assumedCapital * 0.01;
    var risk05Pct = assumedCapital * 0.005;
    var sharesAt1Pct = Math.floor(risk1Pct / riskPerShare);
    var sharesAt05Pct = Math.floor(risk05Pct / riskPerShare);
    var capital1Pct = sharesAt1Pct * entry;
    var capital05Pct = sharesAt05Pct * entry;
    var sizing = {
      assumedCapital: assumedCapital,
      riskPerShare: riskPerShare,
      sharesAt1Pct: sharesAt1Pct,
      sharesAt05Pct: sharesAt05Pct,
      capital1Pct: capital1Pct,
      capital05Pct: capital05Pct,
      maxLoss1Pct: sharesAt1Pct * riskPerShare,
      targetGain1Pct: sharesAt1Pct * (t1 - entry)
    };

    // ── Narrative ──
    var allShort = triggers.map(function (tt) { return tt.short; }).join(' + ');
    var rsBit = (rsPp != null)
      ? (' Relative strength vs Nifty: ' + (rsPp >= 0 ? '+' : '') + rsPp.toFixed(1) + ' pp (20d).')
      : '';
    var adxBit = (daily.adx != null) ? (' ADX ' + daily.adx.toFixed(0) + ' = trending.') : '';
    var regimeBit = (regimeStr === 'BULL') ? ' Nifty regime BULL (tailwind).'
                  : (regimeStr === 'NEUTRAL') ? ' Nifty regime NEUTRAL (size smaller).'
                  : '';
    var multiBit = (triggers.length > 1)
      ? (' \u00b7 ' + triggers.length + ' triggers in confluence (' + allShort + ') \u2014 A-grade setup.')
      : '';
    var styleBit = ' Style: ' + rules.label + ' (' + rules.holdMin + '\u2013'
      + rules.holdMax + ' trading days, ~' + holding + ' typical).';
    var why = 'Trigger: ' + primaryT.label + '.' + multiBit + styleBit + adxBit + rsBit
      + ' Risk:Reward 1:' + rr.toFixed(2) + ' at Target 1. '
      + 'Buy delivery (CNC \u2014 not MIS). Size so the stop loss (' + fmtPrice(sl)
      + ') costs no more than 1% of capital.'
      + regimeBit;

    // ── SKIP IF \u2014 structural reasons only (post-simplification).
    // Every entry here points to a CONCRETE thing about the trade
    // that, if true, makes the setup invalid or risky enough to
    // pass on. NO generic warnings, no duplicate of WHY BUY data.
    //
    // Kept:
    //   - SL invalidation (always)
    //   - Overbought RSI (>75)
    //   - Extended from 50 EMA (>12%)
    //   - Tight / capped headroom to resistance
    //   - Monthly Stage 3 / Stage 4 warnings
    //   - Softened-gate warnings: BEAR regime + LOW_ADX (NEW)
    //
    // Removed: 1H bearish momentum, NEUTRAL regime, weak RS,
    // STAGE2_BREAKOUT specifics (trigger no longer exists).
    var skipIf = [
      'Daily candle closes below ' + fmtPrice(sl) + ' before entry fills \u2014 setup invalidated'
    ];
    // Softened-gate warnings \u2014 these used to be HARD BLOCKS.
    // Now they're surfaced here so the user sees the risk
    // prominently but the trade is still allowed (the chart
    // pattern is strong enough to overcome the -2 / -1 score
    // penalty applied above).
    if (regimeWarn) {
      var bearBit = marketRegime
        ? ' (Nifty ' + (marketRegime.distPct >= 0 ? '+' : '') + marketRegime.distPct.toFixed(2)
          + '% vs falling 50 DMA)'
        : '';
      skipIf.push('Nifty regime is BEAR' + bearBit + ' \u2014 take half size or skip entirely; long swings have negative expectancy when index is below a falling 50 DMA.');
    }
    if (adxWarn) {
      skipIf.push('Daily ADX is ' + (daily.adx != null ? daily.adx.toFixed(0) : '?')
        + ' (< 18 = chop) \u2014 even valid setups fail in range-bound tape; wait for ADX to clear 18 or size half.');
    }
    if (daily.rsi != null && daily.rsi > 75) {
      skipIf.push('Daily RSI is ' + daily.rsi.toFixed(1) + ' (overbought) \u2014 wait for a 2\u20133 day pullback before entry.');
    }
    // Resistance-aware skip conditions \u2014 added if T1 had to be
    // capped or if there's almost no headroom to the next wall.
    if (skipForResistance && nearestRes != null) {
      skipIf.push('Nearest overhead resistance (' + fmtPrice(nearestRes)
        + ' \u2014 ' + nearestResLbl + ') sits less than 0.5R above entry \u2014 not enough headroom. Wait for a clean breakout above this level.');
    } else if (t1Capped && nearestRes != null) {
      skipIf.push('T1 was CAPPED at the nearest resistance (' + fmtPrice(nearestRes)
        + ' \u2014 ' + nearestResLbl + '). If price stalls there, take the partial profit \u2014 don\'t hope for the original textbook target.');
    }
    // Extended-from-MA warning \u2014 chasing a Stage-3 move.
    if (daily.ema50DistPct != null && daily.ema50DistPct > 12) {
      skipIf.push('Stock is ' + daily.ema50DistPct.toFixed(1)
        + '% above the 50 EMA \u2014 extended, high reversion risk. Wait for a pullback.');
    }
    // Monthly Stage warnings.
    if (monthlyStageInfo && monthlyStageInfo.tone === 'avoid') {
      skipIf.push('Monthly is in Stage 4 markdown (multi-year downtrend) \u2014 base rate for long swings is low here. Consider half-size or skip entirely.');
    } else if (monthlyStageInfo && monthlyStageInfo.tone === 'caution') {
      skipIf.push('Monthly is in Stage 3 distribution \u2014 a topping pattern. If the trade fails the SL, do NOT re-enter.');
    }

    // Style mix — for the scanner chip. If at least one trigger of
    // each style fires, we tag the row as DUAL so the user knows
    // they have both options on this stock.
    var hasSwing = triggers.some(function (tt) { return tt.style === 'SWING'; });
    var hasPos   = triggers.some(function (tt) { return tt.style === 'POSITION'; });
    var styleMix = (hasSwing && hasPos) ? 'DUAL' : (hasSwing ? 'SWING' : 'POSITION');

    return {
      ok: true,
      bias: bias, action: action, confidence: confidence, score: legacyScore,
      confidencePct: confidencePct,
      marketRegime: marketRegime || null,
      monthlyStage: monthlyStageInfo,
      supports: supports,
      triggers: triggers,
      style: primaryT.style,
      styleMix: styleMix,
      timeline: timeline,
      exitRules: exitRules,
      whyBuy: whyBuy,
      sizing: sizing,
      rsPp: rsPp,
      gateReason: gateReason,
      setupName: setupName,
      setupShort: setupShort,
      entry: entry, entryHi: entry * 1.01, sl: sl, t1: t1, t2: t2,
      t1Days: _swEstimateDays(entry, sl, t1, daily.atr, (daily && isFinite(daily.adx)) ? daily.adx : null, '1d'),
      t2Days: _swEstimateDays(entry, sl, t2, daily.atr, (daily && isFinite(daily.adx)) ? daily.adx : null, '1d'),
      recoTf: '1d',
      rr: rr, holding: holding,
      why: why, skipIf: skipIf,
      bullSignals: bullSignals,
      bearSignals: bearSignals,
      tfScore: tfScore,
      tfSignals: tfSignals
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // FETCH — multi-TF historical candles from Upstox V3
  // ═══════════════════════════════════════════════════════════════
  // Each call hits /historical-candle/<key>/<unit>/<interval>/<to>/<from>.
  // We run W/D/1H in parallel because they're independent endpoints,
  // so a full analysis = 1 round-trip's worth of latency, not 3.
  // TF_SPECS drives both the analysis (1w/1d/1h are *analyzed*) and
  // the price chart (1mo/1w/1d/1h/5m are all *displayable*). The
  // extra unit/interval values for 1mo and 5m are only used by the
  // chart — analyzeTf() is never called on them. historyDays values
  // are tuned so each TF returns a comfortable "looks like a chart"
  // window of candles while staying within Upstox V3 endpoint limits
  // (monthly: years deep; minutes/5: ~15 days max with safe headroom).
  var TF_SPECS = {
    '1mo': { unit: 'months',  interval: '1',  historyDays: 365 * 5, label: 'Monthly',   hasIntraday: false },
    '1w':  { unit: 'weeks',   interval: '1',  historyDays: 365 * 3, label: 'Weekly',    hasIntraday: false },
    '1d':  { unit: 'days',    interval: '1',  historyDays: 365 * 2, label: 'Daily',     hasIntraday: true  },
    '4h':  { unit: 'hours',   interval: '4',  historyDays: 180,     label: '4 Hour',    hasIntraday: true  },
    '1h':  { unit: 'hours',   interval: '1',  historyDays: 90,      label: '1 Hour',    hasIntraday: true  },
    '30m': { unit: 'minutes', interval: '30', historyDays: 30,      label: '30 Minute', hasIntraday: true  },
    '15m': { unit: 'minutes', interval: '15', historyDays: 30,      label: '15 Minute', hasIntraday: true  },
    '5m':  { unit: 'minutes', interval: '5',  historyDays: 30,      label: '5 Minute',  hasIntraday: true  }
  };

  // Classify whether an error from a single Upstox candle fetch
  // is "rate-limit-ish" — i.e. transient and worth retrying.
  // Upstox / Cloudflare emit at least three shapes for the same
  // underlying problem (too many requests in too little time):
  //   1. HTTP 429 with a Cloudflare body
  //   2. HTTP 400 with `errorCode:"UDAPI100011"` in the JSON
  //      (their app-layer limit response — yes, with a 400)
  //   3. Network errors / aborted requests when the connection
  //      pool fills up
  // The retry loop below treats all three the same. Any other
  // error (401, 403, 404, validation problems) skips retry.
  function isRateLimitErrorBody(body) {
    if (!body) return false;
    if (/UDAPI100011/i.test(body)) return true;
    if (/cloudflare\.com\/.+rate[-_]?limit/i.test(body)) return true;
    if (/rate\s*limit|too\s*many\s*requests/i.test(body)) return true;
    return false;
  }

  // Low-level single-attempt fetch. Returns the parsed candles
  // array on success, or a structured error so the retry wrapper
  // can decide whether to back off + retry.
  // ══════════════════════════════════════════════════════════════════
  // ANGEL ONE swing candle path (experimental, Stage 2 — charts only).
  // Mirrors the Upstox _fetchTfOnce contract: returns [ts,o,h,l,c,v]
  // newest-first, or throws (NO_ANGEL_TOKEN / UNAUTHORIZED / etc.) so the
  // scan fails safe on a stock rather than guessing. Angel keys stocks by
  // a numeric symboltoken (see data/angel-instruments.json, built by
  // scripts/build-angel-instruments.py) — unmapped ISINs are skipped.
  // Angel's candle API has no native weekly/monthly/4h, so those are
  // aggregated from daily / 1-hour bars.
  // ══════════════════════════════════════════════════════════════════
  function swDataSource() {
    try { return (localStorage.getItem('data_source') || 'upstox').toLowerCase() === 'angel' ? 'angel' : 'upstox'; }
    catch (_) { return 'upstox'; }
  }
  function swAngelToken() {
    try { return (localStorage.getItem('angel_one_token') || '').trim(); } catch (_) { return ''; }
  }
  function swAngelBase() {
    try {
      var h = (location.hostname || '').toLowerCase();
      return (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) ? '/angel' : '';
    } catch (_) { return ''; }
  }
  function swFmtAngelDate(d) {
    var p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(d);
    var g = function (t) { var x = p.find(function (o) { return o.type === t; }); return x ? x.value : ''; };
    return g('year') + '-' + g('month') + '-' + g('day') + ' ' + g('hour') + ':' + g('minute');
  }
  // TF key → native SmartAPI interval (direct fetch).
  var SW_ANGEL_INTERVAL = {
    '5m': 'FIVE_MINUTE', '15m': 'FIFTEEN_MINUTE', '30m': 'THIRTY_MINUTE',
    '1h': 'ONE_HOUR', '1d': 'ONE_DAY'
  };
  // TF key → { base interval to fetch, aggregation mode } for TFs Angel
  // doesn't serve natively.
  var SW_ANGEL_DERIVED = {
    '4h':  { base: 'ONE_HOUR', agg: '4h' },
    '1w':  { base: 'ONE_DAY',  agg: 'week' },
    '1mo': { base: 'ONE_DAY',  agg: 'month' }
  };
  var _swAngelInst = null, _swAngelInstPromise = null;
  function swLoadAngelInstruments() {
    if (_swAngelInst) return Promise.resolve(_swAngelInst);
    if (_swAngelInstPromise) return _swAngelInstPromise;
    _swAngelInstPromise = fetch('data/angel-instruments.json', { credentials: 'omit' })
      .then(function (r) { if (!r.ok) throw new Error('angel-instruments HTTP ' + r.status); return r.json(); })
      .then(function (j) { _swAngelInst = (j && j.instruments) || {}; return _swAngelInst; })
      .catch(function (e) { _swAngelInstPromise = null; throw e; });
    return _swAngelInstPromise;
  }
  // Bucket key for aggregation. Week buckets anchor to the IST Monday;
  // month buckets to IST YYYY-MM; 4h to fixed 4-hour epoch boundaries.
  function swAngelBucketKey(tsStr, mode) {
    var d = new Date(tsStr);
    if (mode === '4h') return 'H' + Math.floor(d.getTime() / (4 * 3600 * 1000));
    var p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    var g = function (t) { var x = p.find(function (o) { return o.type === t; }); return x ? x.value : ''; };
    var y = g('year'), m = g('month'), day = g('day');
    if (mode === 'month') return y + '-' + m;
    var utc = new Date(y + '-' + m + '-' + day + 'T00:00:00Z');
    var dow = utc.getUTCDay();                 // 0=Sun..6=Sat
    var diff = (dow === 0 ? 6 : dow - 1);      // days since Monday
    return 'W' + new Date(utc.getTime() - diff * 86400000).toISOString().slice(0, 10);
  }
  // Aggregate ascending base candles into higher-TF OHLCV candles.
  function swAngelAggregate(candles, mode) {
    if (!candles || !candles.length) return candles || [];
    var asc = candles.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var buckets = {}, order = [];
    asc.forEach(function (c) {
      var key = swAngelBucketKey(c[0], mode);
      var b = buckets[key];
      if (!b) {
        buckets[key] = { ts: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] || 0 };
        order.push(key);
      } else {
        if (+c[2] > b.h) b.h = +c[2];
        if (+c[3] < b.l) b.l = +c[3];
        b.c = +c[4];                 // last close in the bucket wins
        b.v += +c[5] || 0;
      }
    });
    return order.map(function (k) { var b = buckets[k]; return [b.ts, b.o, b.h, b.l, b.c, b.v]; });
  }
  async function swAngelGetCandles(base, token, inst, interval, from, to) {
    var body = {
      exchange: inst.exchange, symboltoken: inst.token, interval: interval,
      fromdate: swFmtAngelDate(from), todate: swFmtAngelDate(to)
    };
    // Pace against Angel's getCandleData rate cap (3/sec, 180/min).
    if (window._angelBucket) await window._angelBucket.acquire();
    var resp = await fetch(base + '/rest/secure/angelbroking/historical/v1/getCandleData', {
      method: 'POST', cache: 'no-store',
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
    if (!resp.ok) {
      var b = ''; try { b = (await resp.text()).slice(0, 200); } catch (_) {}
      throw new Error('ANGEL_HTTP_' + resp.status + ' ' + b);
    }
    var d = await resp.json();
    if (!d || d.success === false || d.status === false) {
      throw new Error('ANGEL_' + ((d && (d.message || d.errorCode || d.errorcode)) || 'ERR'));
    }
    return (d && Array.isArray(d.data)) ? d.data : [];
  }
  async function _fetchTfOnceAngel(isin, tfKey) {
    // Gate on the SWING tab's own pause (swIsApiPaused), NOT the options
    // master switch (ptIsApiPaused). The Upstox swing path is gated the same
    // way at the scan entry points; the Angel path used to check ptIsApiPaused
    // by mistake — harmless while that defaulted to "active", but it now
    // defaults to PAUSED (options API is off until the user opts in), which
    // wrongly blocked every Angel-One swing scan. Angel data flows through
    // server.py, not Upstox, so the Upstox rate-limit switch is the wrong gate.
    if (swIsApiPaused()) throw swPausedError();
    var base = swAngelBase();
    if (!base) throw new Error('ANGEL_PROXY_REQUIRED');     // needs server.py
    var token = swAngelToken();
    if (!token) throw new Error('NO_ANGEL_TOKEN');
    var map = await swLoadAngelInstruments();
    var inst = map[isin];
    if (!inst) throw new Error('ANGEL_NO_INSTRUMENT');      // unmapped → skip
    var spec = TF_SPECS[tfKey];
    var derived = SW_ANGEL_DERIVED[tfKey];
    var interval = SW_ANGEL_INTERVAL[tfKey] || (derived && derived.base);
    if (!interval) throw new Error('ANGEL_TF_UNSUPPORTED: ' + tfKey);
    var now = new Date();
    var to = new Date(now); to.setDate(to.getDate() + 1);
    var from = new Date(now); from.setDate(from.getDate() - spec.historyDays);
    var candles = await swAngelGetCandles(base, token, inst, interval, from, to);
    if (derived) candles = swAngelAggregate(candles, derived.agg);
    // Match the Upstox path: newest-first.
    candles.sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
    console.log('[swing] angel ' + tfKey + ' ' + inst.symbol + ' → ' + candles.length + ' candles');
    return candles;
  }

  // ═══════════════════════════════════════════════════════════════
  // SHARED DAILY FETCH + DERIVED WEEKLY / MONTHLY  (Upstox path)
  // ═══════════════════════════════════════════════════════════════
  // Upstox's historical-candle endpoint never returns the CURRENT,
  // still-forming period (daily stops at the last completed session;
  // weekly/monthly stop at the last completed week/month), and the
  // /intraday/ patch endpoint that supplies "today" only exists for
  // days/hours/minutes — NOT weeks/months. So the weekly & monthly
  // charts were missing their current bar entirely, and the swing
  // analyze() fan-out was burning THREE historical calls (months/1 +
  // weeks/1 + days/1) per stock.
  //
  // A weekly/monthly candle is EXACTLY the roll-up of its daily candles
  // (open=first day, high=max, low=min, close=last day, vol=Σ) — verified
  // against Upstox's official weekly/monthly bars to the paisa across
  // multiple stocks. So we make ONE deep daily fetch and derive
  // 1d / 1w / 1mo from it. This cuts the swing historical-call count
  // 3→1 per stock (≈900 fewer calls on a full 449-stock scan → far less
  // 429 throttling) while keeping the analyzer's weekly/monthly bars
  // byte-identical to the old endpoints.
  //
  // NO REPAINT: deriveTfFromDaily drops the CURRENT clock-period bucket,
  // so the verdict still anchors on COMPLETED weeks/months only — the
  // same set Upstox's weeks/1 & months/1 returned on a trading day. The
  // live forming bar (formingPeriodBar) is a CHART-ONLY overlay applied
  // in renderMainChart / pollSwingTick — it is never fed to the signal.
  var _swDailyShared = {};                 // isin → { candles:[newest-first], fetchedAt, inflight }
  var SW_DAILY_SHARED_TTL_MS = 45 * 1000;  // fresh-enough for the analyze fan-out + chart TF switches
  var SW_DAILY_SHARED_DAYS = TF_SPECS['1mo'].historyDays;  // deepest window any derived TF needs (monthly = 5y)
  // Short recent daily window used to recover the latest completed session
  // when Upstox's deep archive lags (see _swFillDailyGapFromShortWindow).
  // ~15 calendar days comfortably spans a long weekend + holiday cluster.
  var SW_DAILY_GAP_WINDOW_DAYS = 15;

  function _swThrottleErr() {
    var e = new Error('Rate-limited by Upstox \u2014 re-scan to retry');
    e._retryable = true; e._throttled = true;
    return e;
  }

  // Single GET mirroring the legacy _fetchTfOnce.fetchOne: honours the
  // global throttle gate + token bucket, classifies 429 / 400-rate-limit
  // as a retryable throttle, returns [] on soft errors.
  async function _swFetchCandlesOnce(url, headers, skipThrottle) {
    if (!skipThrottle && window._upstoxIsThrottled && window._upstoxIsThrottled()) throw _swThrottleErr();
    if (window._upstoxBucket) await window._upstoxBucket.acquire();
    try {
      var resp = await fetch(url, { headers: headers });
      if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
      if (resp.status === 429) {
        if (typeof window._upstoxNote429 === 'function') window._upstoxNote429('swing-scan');
        if (!skipThrottle) throw _swThrottleErr();
        return [];
      }
      if (!resp.ok) {
        var body = '';
        try { body = (await resp.text()).slice(0, 300); } catch (_) {}
        if (resp.status === 400 && isRateLimitErrorBody(body)) {
          if (typeof window._upstoxNote429 === 'function') window._upstoxNote429('swing-scan');
          if (!skipThrottle) throw _swThrottleErr();
        }
        return [];
      }
      var d = await resp.json();
      if (typeof window._upstoxNoteOk === 'function') window._upstoxNoteOk();
      return (d && d.data && d.data.candles) || [];
    } catch (e) {
      if (e && (e.message === 'UNAUTHORIZED' || e._throttled)) throw e;
      return [];
    }
  }

  // Deep daily history (5y) + today's forming daily bar, merged, deduped,
  // NEWEST-FIRST. Per-isin cached (short TTL) with in-flight dedup so the
  // analyze() fan-out (1mo+1w+1d fired together) and rapid chart TF
  // switches all share ONE network call.
  async function fetchDailyShared(isin) {
    var slot = _swDailyShared[isin];
    var nowMs = Date.now();
    if (slot && slot.candles && (nowMs - slot.fetchedAt) < SW_DAILY_SHARED_TTL_MS) return slot.candles;
    if (slot && slot.inflight) return slot.inflight;
    // Evict stale, non-in-flight entries so a full 449-stock scan (each
    // isin fetched once, then never reused) can't balloon memory — only a
    // handful of TTL-fresh daily arrays are ever retained.
    for (var k in _swDailyShared) {
      var e = _swDailyShared[k];
      if (e && !e.inflight && (nowMs - e.fetchedAt) >= SW_DAILY_SHARED_TTL_MS) delete _swDailyShared[k];
    }

    var token = getToken();
    if (!token) throw new Error('NO_TOKEN');
    var ikey = encodeURIComponent(swInstrumentKey(isin));
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var to = new Date(); to.setDate(to.getDate() + 1);

    var p = (async function () {
      // Full 5y daily; fall back to shorter windows for newer listings
      // so we still get SOMETHING (aggregation just yields fewer bars).
      var fallbackDays = [SW_DAILY_SHARED_DAYS, 365, 90];
      var hist = [];
      for (var i = 0; i < fallbackDays.length; i++) {
        var from = new Date(); from.setDate(from.getDate() - fallbackDays[i]);
        var url = BASE_V3 + '/historical-candle/' + ikey + '/days/1/' + fmtDate(to) + '/' + fmtDate(from);
        hist = await _swFetchCandlesOnce(url, headers, false);
        if (hist.length >= 5) break;
      }
      // Today's forming daily bar — best-effort (skipThrottle so a throttled
      // supplement never sinks an otherwise-good history).
      var intra = await _swFetchCandlesOnce(BASE_V3 + '/historical-candle/intraday/' + ikey + '/days/1', headers, true);
      var seen = {}, deduped = [];
      hist.concat(intra).forEach(function (c) { if (!seen[c[0]]) { seen[c[0]] = 1; deduped.push(c); } });
      deduped.sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
      _swDailyShared[isin] = { candles: deduped, fetchedAt: Date.now(), inflight: null };
      return deduped;
    })();

    _swDailyShared[isin] = { candles: slot && slot.candles, fetchedAt: slot ? slot.fetchedAt : 0, inflight: p };
    try { return await p; }
    catch (e) {
      var s = _swDailyShared[isin];
      if (s) s.inflight = null;   // let the next call retry
      throw e;
    }
  }

  // Sync read of the shared daily cache (no fetch) — for the chart's
  // forming-bar overlay so it always sees the freshest daily series.
  function getDailyShared(isin) {
    var s = _swDailyShared[isin];
    return (s && s.candles) ? s.candles : null;
  }

  // Slice a NEWEST-FIRST daily series to the last `days` calendar days,
  // matching the `from` date the legacy per-TF Upstox fetch used (so the
  // 1d analyzer window is byte-identical to before).
  function _swSliceDailyDays(dailyNewestFirst, days) {
    if (!dailyNewestFirst || !dailyNewestFirst.length) return dailyNewestFirst || [];
    var fromD = new Date(); fromD.setDate(fromD.getDate() - days);
    var fromKey = fmtDate(fromD);
    return dailyNewestFirst.filter(function (c) { return fmtDate(new Date(c[0])) >= fromKey; });
  }

  // Derive a COMPLETED-ONLY weekly/monthly series (NEWEST-FIRST) from
  // daily, dropping the current clock-period bucket. Matches Upstox's
  // weeks/1 & months/1 output on a trading day → no repaint into the
  // signal. Reuses the Angel IST-Monday-week / calendar-month bucketing.
  function deriveTfFromDaily(dailyNewestFirst, tfKey) {
    if (!dailyNewestFirst || !dailyNewestFirst.length) return [];
    var mode = tfKey === '1w' ? 'week' : 'month';
    var bars = swAngelAggregate(dailyNewestFirst, mode);            // ascending [ts,o,h,l,c,v]
    var nowKey = swAngelBucketKey(new Date().toISOString(), mode);  // current forming period
    bars = bars.filter(function (b) { return swAngelBucketKey(b[0], mode) !== nowKey; });
    bars.sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
    return bars;
  }

  // Build the CURRENT (forming) weekly/monthly bar from the current
  // period's daily candles. CHART-ONLY — never returned to the analyzer.
  // Anchored at the period's first trading day so candleTime lines it up
  // right after the last completed bar. null when no daily data yet.
  function formingPeriodBar(dailyNewestFirst, tfKey) {
    if (!dailyNewestFirst || !dailyNewestFirst.length) return null;
    var mode = tfKey === '1w' ? 'week' : 'month';
    var nowKey = swAngelBucketKey(new Date().toISOString(), mode);
    var inPeriod = dailyNewestFirst.filter(function (c) { return swAngelBucketKey(c[0], mode) === nowKey; });
    if (!inPeriod.length) return null;
    var asc = inPeriod.slice().sort(function (a, b) { return new Date(a[0]).getTime() - new Date(b[0]).getTime(); });
    var o = +asc[0][1], h = -Infinity, l = Infinity, c = +asc[asc.length - 1][4], v = 0;
    asc.forEach(function (d) { if (+d[2] > h) h = +d[2]; if (+d[3] < l) l = +d[3]; v += (+d[5] || 0); });
    return [asc[0][0], o, h, l, c, v];
  }

  // ── Daily-feed gap fill (Upstox deep-window publish lag) ───────────
  // Upstox serves STALE data on its DEEP historical windows. The daily
  // series the analyzer builds asks for the deepest window any derived TF
  // needs (5y, for monthly), and that deep archive lags ~1 session: it can
  // be missing the most-recent COMPLETED trading day for hours after the
  // close — typically all weekend, since the intraday /days/1 supplement
  // (which normally carries "today" and was silently masking the lag) goes
  // empty once the IST calendar rolls off the trading day. Net effect: the
  // 1D chart + daily analysis fall one session behind what TradingView and
  // the live LTP already show.
  //
  // Crucially, Upstox's SHORT (recent) daily window is NOT stale — it
  // already holds the real, official daily bar (true closing-auction
  // close, exact OHLCV). So when (and only when) a gap is detected we
  // fetch ONE short recent window and merge the missing completed
  // session(s) into the NEWEST-FIRST daily array.
  //
  // Cost discipline (real-money app — protect the Upstox quota):
  //   • No gap (every normal trading day) → ZERO extra calls; returns the
  //     array untouched. This is what keeps Monday's behaviour identical.
  //   • Gap → exactly ONE best-effort short-window GET, throttle-gated,
  //     fail-safe (any error returns the deep array unchanged).
  //   • Called ONLY from the single-stock analyze + live-resync paths,
  //     never from the 449-stock bulk scan — so a weekend scan adds 0 calls.
  //
  // NO-REPAINT (real money depends on this): only sessions strictly newer
  // than what we have AND at/before the most-recent FULLY-CLOSED session
  // are merged. Today's still-forming bar is never added to the signal
  // series. Self-correcting: once Upstox backfills the deep archive the
  // date is already covered and nothing is merged (no duplicate).

  // IST date key (YYYY-MM-DD) of the most-recent NSE session that has
  // FULLY CLOSED (>= 15:30 IST) at `nowMs`. Skips weekends + NSE holidays.
  // Returns null when none resolves within 10 days (fail-safe → callers
  // then do nothing rather than guess).
  function _swMostRecentCompletedSessionKey(nowMs) {
    for (var back = 0; back < 10; back++) {
      var ist = new Date(nowMs - back * 86400000 + IST_OFFSET_MS);
      var y = ist.getUTCFullYear(), mo = ist.getUTCMonth(), da = ist.getUTCDate();
      var dow = ist.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      var ymd = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(da).padStart(2, '0');
      if (typeof window.isNseHoliday === 'function') {
        try { if (window.isNseHoliday(ymd)) continue; } catch (_) {}
      }
      // Close = 15:30 IST == 10:00 UTC on that IST calendar date.
      var closeMs = Date.UTC(y, mo, da, 10, 0, 0, 0);
      if (closeMs <= nowMs) return ymd;
    }
    return null;
  }

  async function _swFillDailyGapFromShortWindow(isin, dailyNewestFirst) {
    if (!dailyNewestFirst || !dailyNewestFirst.length) return dailyNewestFirst || [];
    var sessionKey = _swMostRecentCompletedSessionKey(Date.now());
    if (!sessionKey) return dailyNewestFirst;                 // can't resolve — do nothing
    var newestKey = fmtDate(new Date(dailyNewestFirst[0][0]));
    if (newestKey >= sessionKey) return dailyNewestFirst;     // no gap → NO fetch (the hot path)

    // Gap detected → pull the short recent window Upstox keeps current.
    var token = getToken();
    if (!token) return dailyNewestFirst;
    var ikey = encodeURIComponent(swInstrumentKey(isin));
    var headers = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var to = new Date(); to.setDate(to.getDate() + 1);
    var from = new Date(); from.setDate(from.getDate() - SW_DAILY_GAP_WINDOW_DAYS);
    var url = BASE_V3 + '/historical-candle/' + ikey + '/days/1/' + fmtDate(to) + '/' + fmtDate(from);
    var recent;
    try {
      // skipThrottle=true → best-effort: a throttle/soft-error returns []
      // (handled below) and we keep the deep array rather than throwing.
      recent = await _swFetchCandlesOnce(url, headers, true);
    } catch (_) {
      return dailyNewestFirst;
    }
    if (!recent || !recent.length) return dailyNewestFirst;

    // Merge ONLY completed sessions in the gap: strictly newer than what we
    // have, and at/before the most-recent fully-closed session (no repaint).
    var seen = {};
    dailyNewestFirst.forEach(function (c) { seen[c[0]] = 1; });
    var add = recent.filter(function (c) {
      var k = fmtDate(new Date(c[0]));
      return !seen[c[0]] && k > newestKey && k <= sessionKey;
    });
    if (!add.length) return dailyNewestFirst;

    var merged = add.concat(dailyNewestFirst);
    merged.sort(function (a, b) { return new Date(b[0]).getTime() - new Date(a[0]).getTime(); });
    return merged;
  }

  async function _fetchTfOnce(isin, tfKey) {
    if (swDataSource() === 'angel') return _fetchTfOnceAngel(isin, tfKey);
    // Swing TFs (1d/1w/1mo) all derive from ONE deep daily fetch (see
    // fetchDailyShared). Intraday TFs keep their native endpoints —
    // minute data can't be pulled over long ranges (Upstox 400s).
    if (tfKey === '1d' || tfKey === '1w' || tfKey === '1mo') {
      var daily = await fetchDailyShared(isin);
      if (tfKey === '1d') return _swSliceDailyDays(daily, TF_SPECS['1d'].historyDays);
      return deriveTfFromDaily(_swSliceDailyDays(daily, TF_SPECS[tfKey].historyDays), tfKey);
    }
    var token = getToken();
    if (!token) throw new Error('NO_TOKEN');
    var spec = TF_SPECS[tfKey];
    var ikey = encodeURIComponent(swInstrumentKey(isin));
    var now = new Date();
    var to = new Date(now);
    to.setDate(to.getDate() + 1);

    var headers  = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
    var intraUrl = spec.hasIntraday
      ? BASE_V3 + '/historical-candle/intraday/' + ikey + '/' + spec.unit + '/' + spec.interval
      : null;

    // Try the full historyDays first; if API returns too few candles
    // (some stocks/exchanges lack deep intraday history), retry with
    // progressively shorter windows so we still get SOMETHING.
    var fallbackDays = [spec.historyDays];
    if (spec.hasIntraday && spec.historyDays > 90) fallbackDays.push(90);
    if (spec.hasIntraday && spec.historyDays > 30) fallbackDays.push(30);

    // A rate-limit is NOT the same as "no data". When the global
    // throttle gate is hot, or Upstox answers 429 / 400-with-rate-limit-
    // body, we THROW a retryable throttle error instead of returning [].
    // Returning [] used to collapse into "not enough candles (0)" — which
    // permanently failed the stock AND lied to the user (the data exists,
    // we were just throttled). Throwing lets fetchTf's backoff ride out the
    // cooldown and retry; if it's still throttled after all retries the
    // error bubbles up and the row is labelled "rate-limited", not
    // "not enough candles". Only the PRIMARY (historical) fetch throws —
    // the intraday supplement (skipThrottle=true) stays best-effort and
    // returns [] so a throttled supplement never sinks an otherwise-good
    // historical result.
    function _throttleErr() {
      var e = new Error('Rate-limited by Upstox \u2014 re-scan to retry');
      e._retryable = true;
      e._throttled = true;
      return e;
    }
    async function fetchOne(url, skipThrottle) {
      if (!skipThrottle && window._upstoxIsThrottled && window._upstoxIsThrottled()) throw _throttleErr();
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      try {
        var resp = await fetch(url, { headers: headers });
        if (resp.status === 401 || resp.status === 403) throw new Error('UNAUTHORIZED');
        if (resp.status === 429) {
          if (typeof window._upstoxNote429 === 'function') window._upstoxNote429('swing-scan');
          if (!skipThrottle) throw _throttleErr();
          return [];
        }
        if (!resp.ok) {
          var body = '';
          try { body = (await resp.text()).slice(0, 300); } catch (_) {}
          if (resp.status === 400 && isRateLimitErrorBody(body)) {
            if (typeof window._upstoxNote429 === 'function') window._upstoxNote429('swing-scan');
            if (!skipThrottle) throw _throttleErr();
          }
          return [];
        }
        var d = await resp.json();
        if (typeof window._upstoxNoteOk === 'function') window._upstoxNoteOk();
        return (d && d.data && d.data.candles) || [];
      } catch (e) {
        if (e && (e.message === 'UNAUTHORIZED' || e._throttled)) throw e;
        return [];
      }
    }

    var histCandles = [];
    for (var fi = 0; fi < fallbackDays.length; fi++) {
      var from = new Date(now);
      from.setDate(from.getDate() - fallbackDays[fi]);
      var histUrl = BASE_V3 + '/historical-candle/' + ikey + '/' + spec.unit + '/' + spec.interval + '/' + fmtDate(to) + '/' + fmtDate(from);
      console.log('[swing] _fetchTfOnce ' + tfKey + ' attempt days=' + fallbackDays[fi] + ' hist=' + histUrl);
      histCandles = await fetchOne(histUrl, false);
      if (histCandles.length >= 5) break;
      if (fi < fallbackDays.length - 1) {
        console.log('[swing] ' + tfKey + ': only ' + histCandles.length + ' candles with ' + fallbackDays[fi] + 'd window, retrying with ' + fallbackDays[fi + 1] + 'd');
      }
    }

    var intraCandles = intraUrl ? await fetchOne(intraUrl, true) : [];
    console.log('[swing] ' + tfKey + ': hist=' + histCandles.length +
      ' intra=' + intraCandles.length +
      (histCandles.length ? ' hist.newest=' + histCandles[0][0] : '') +
      (intraCandles.length ? ' intra.newest=' + intraCandles[0][0] : ''));

    // Merge + dedupe. Intraday concat'd AFTER historical so when
    // timestamps overlap the hist version wins (same OHLCV, just
    // the first-seen survives the dedup). For daily/1h/5m where
    // the hist pipeline may lag, intraday adds the missing bars.
    var merged = histCandles.concat(intraCandles);
    var seen = {};
    var deduped = [];
    merged.forEach(function (c) {
      var t = c[0];
      if (!seen[t]) { seen[t] = 1; deduped.push(c); }
    });
    deduped.sort(function (a, b) {
      return new Date(b[0]).getTime() - new Date(a[0]).getTime();
    });
    return deduped;
  }

  // Public fetchTf — wraps the single-shot call with automatic
  // retry + exponential backoff for rate-limit errors. The
  // backoff schedule is tuned so a 3-attempt total takes at most
  // ~6 seconds (500 + 1500 = 2s of waiting + ~300ms of request
  // time × 3). This is enough to ride out the typical Upstox
  // sub-minute throttle without blocking the user too long.
  //
  // Honours window._upstoxIsThrottled() before EACH attempt,
  // sleeping the full remaining cooldown if the global gate is
  // hot — that's how the swing scanner cooperates with the
  // intraday + chart pollers (they all share the same gate).
  var FETCH_TF_BACKOFFS_MS = [500, 1500];   // → 3 attempts total
  // Max we'll sleep waiting for the global throttle gate to
  // clear before giving up on this fetch. 30s is long enough
  // to ride out the typical 5-20s Upstox cooldown but short
  // enough that a single stuck fetch doesn't block the whole
  // scan past the user's patience threshold. If the gate is
  // hotter than this (multi-minute cooldown from sustained
  // abuse), the fetch fails fast and the scan continues; the
  // failed row will surface as "rate-limited" and a retry
  // (or a re-scan) once the cooldown clears will work.
  var THROTTLE_WAIT_CAP_MS = 30000;
  // RIDE-OUT MODE — set TRUE only for the duration of a bulk scan's worker
  // pool (see swingComputeAllVerdicts). When on, fetchTf does NOT bail at the
  // 30s wait cap: it sleeps the FULL remaining Upstox cooldown (even a 60/90s
  // backoff) and keeps retrying until the call succeeds. This is the guarantee
  // the user asked for — a stock is never left "rate-limited / FAILED" merely
  // because the global limiter happened to be hot on its turn; the scan just
  // takes longer. A generous ride ceiling still bounds a genuine multi-hour
  // outage (e.g. a Cloudflare 1015 IP block) so a single fetch can't spin
  // forever. The single-stock + chart paths leave this FALSE and keep their
  // fast-fail behaviour (a wedged fetch there must not block the UI).
  var swScanRideOutThrottle = false;
  var SCAN_THROTTLE_MAX_RIDES = 80;        // transient limits clear in 1-3 rides; this is just a runaway guard
  var SCAN_THROTTLE_MAX_SLEEP_MS = 95000;  // cap one sleep, then re-check the gate (cooldown may need several)
  async function fetchTf(isin, tfKey) {
    var lastErr = null;
    var httpAttempt = 0;   // real HTTP tries (bounded to FETCH_TF_BACKOFFS_MS when NOT riding out)
    var rides = 0;         // ride-out waits + retryable retries (bounded by SCAN_THROTTLE_MAX_RIDES)
    while (true) {
      // Respect the GLOBAL throttle gate (set by intraday poller,
      // chart's 429 detector, or this scanner's own retries).
      // Waiting here serialises fetches behind the cooldown so
      // we don't fire doomed HTTP calls that just extend the
      // cooldown further. Add jitter so concurrent waiters don't
      // all wake on the same millisecond and stampede the limiter.
      if (typeof window._upstoxIsThrottled === 'function' && window._upstoxIsThrottled()) {
        var rem = (window._upstoxRateLimit && window._upstoxRateLimit.untilTs) || 0;
        var rawWaitMs = Math.max(0, rem - Date.now()) + 100;
        if (rawWaitMs > THROTTLE_WAIT_CAP_MS && !swScanRideOutThrottle) {
          // Fast-fail path (single stock / chart): cooldown too long to
          // wait — bail so the caller can retry once it expires.
          var eThrottle = new Error('THROTTLED: cooldown ' + Math.ceil(rawWaitMs / 1000) + 's exceeds wait cap');
          eThrottle._retryable = false;
          throw eThrottle;
        }
        if (swScanRideOutThrottle && ++rides > SCAN_THROTTLE_MAX_RIDES) {
          // Pathological: limiter hot far beyond any normal backoff. Let the
          // row flag as rate-limited so manual Retry can still pick it up,
          // rather than spinning this fetch indefinitely.
          var eCap = new Error('THROTTLED: rate limit persisted beyond scan ride-out ceiling');
          eCap._retryable = true; eCap._throttled = true;
          throw eCap;
        }
        var jitter = Math.floor(Math.random() * 800);   // 0-800ms spread
        var sleepMs = Math.min(rawWaitMs, SCAN_THROTTLE_MAX_SLEEP_MS) + jitter;
        await new Promise(function (res) { setTimeout(res, sleepMs); });
        // Ride-out: re-check the gate (a long cooldown can need several
        // capped sleeps). Fast-fail path falls through to attempt the call,
        // exactly as before (the full remaining cooldown was waited above).
        if (swScanRideOutThrottle) continue;
      }
      try {
        var candles = await _fetchTfOnce(isin, tfKey);
        if (typeof window._upstoxNoteOk === 'function') window._upstoxNoteOk();
        return candles;
      } catch (err) {
        lastErr = err;
        if (!err || !err._retryable) throw err;          // non-retryable → bubble immediately
        if (swScanRideOutThrottle) {
          // A retryable error (429 / transient 5xx) almost always just set
          // the global gate hot — loop back so the gate-wait above sleeps it
          // out, then retry. Bounded by the ride ceiling.
          if (++rides > SCAN_THROTTLE_MAX_RIDES) break;
          var rb = FETCH_TF_BACKOFFS_MS[Math.min(httpAttempt, FETCH_TF_BACKOFFS_MS.length - 1)];
          httpAttempt++;
          await new Promise(function (res) { setTimeout(res, rb + Math.floor(Math.random() * (rb / 2))); });
        } else {
          if (httpAttempt >= FETCH_TF_BACKOFFS_MS.length) break; // out of retries
          // Jittered backoff so concurrent retries don't stampede again.
          var base = FETCH_TF_BACKOFFS_MS[httpAttempt];
          httpAttempt++;
          await new Promise(function (res) { setTimeout(res, base + Math.floor(Math.random() * (base / 2))); });
        }
      }
    }
    throw lastErr || new Error('fetchTf failed without specific error');
  }

  async function fetchLtp(isin) {
    var token = getToken();
    if (!token) {
      console.warn('[swing] fetchLtp: no token available');
      return null;
    }
    try {
      var ikey = encodeURIComponent(swInstrumentKey(isin));
      var url = BASE_V2 + '/market-quote/ltp?instrument_key=' + ikey;
      console.log('[swing] fetchLtp requesting:', url);
      var resp = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
      if (!resp.ok) {
        console.warn('[swing] fetchLtp HTTP error:', resp.status, resp.statusText);
        return null;
      }
      var d = await resp.json();
      var data = d && d.data;
      if (!data) {
        console.warn('[swing] fetchLtp: no data in response', d);
        return null;
      }
      // Upstox returns a dict keyed by "NSE_EQ:<symbol>" — grab whatever's there.
      var firstKey = Object.keys(data)[0];
      var ltp = firstKey ? +data[firstKey].last_price : null;
      console.log('[swing] fetchLtp success:', ltp, 'for ISIN:', isin);
      return ltp;
    } catch (err) {
      console.error('[swing] fetchLtp exception:', err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MARKET REGIME — Nifty 50 above its 50 DMA?
  // ═══════════════════════════════════════════════════════════════
  // This is the FIRST filter a professional swing trader applies
  // before scanning individual stocks. Statistically, the median
  // long-only swing trade earns nothing when the broad index is
  // below its 50 DMA — even a "perfect" stock setup gets dragged
  // down by sector beta and market correlation. So we fetch ~120
  // daily Nifty bars in parallel with the stock data and tag the
  // verdict with one of:
  //
  //   BULL    — Nifty close > 50 DMA AND DMA slope rising
  //             → fresh BUY signals are tradable
  //   NEUTRAL — Nifty close > DMA but slope flat / falling
  //             OR close < DMA but slope still rising
  //             → BUY signals demoted by one confidence band
  //   BEAR    — Nifty close < 50 DMA AND DMA slope falling
  //             → all BUY signals demoted to WAIT (regime block)
  //
  // We do NOT trade Nifty itself here — this is purely a context
  // gate for the stock verdict. Falls back to NEUTRAL on any fetch
  // error (network, 401, insufficient history) so a transient
  // hiccup doesn't silently block all signals; the regime field
  // also surfaces in the verdict UI so the user sees the gate.
  // ── Shared Nifty 50 daily candle cache ─────────────────────────
  // Holds the raw chronological-sorted candles returned by the
  // most recent successful Upstox fetch. Both fetchMarketRegime
  // (scan path) and fetchNiftyDailyHistory (backtest path) read
  // and write this. Without the share, every per-stock backtest
  // would re-fetch Nifty even though we just pulled it 30s ago
  // for the scan's regime banner — and if that re-fetch hit a
  // transient 429 / 5xx, the backtest would die for no reason.
  //
  // Shape: { candles: [[ts,o,h,l,c,v,oi], ...], fetchedAt: msTs,
  //          rangeDays: 200|260 }
  var NIFTY_DAILY_CACHE = null;
  // Cache is considered fresh for 10 min — long enough that
  // scan → backtest → backtest in the same session reuses it,
  // short enough that "open the tab in the morning, scan, hold
  // for hours, then backtest" still picks up today's bar.
  var NIFTY_CACHE_TTL_MS = 10 * 60 * 1000;
  function getCachedNiftyCandles(minBars) {
    if (!NIFTY_DAILY_CACHE) return null;
    if (Date.now() - NIFTY_DAILY_CACHE.fetchedAt > NIFTY_CACHE_TTL_MS) return null;
    if (minBars && NIFTY_DAILY_CACHE.candles.length < minBars) return null;
    return NIFTY_DAILY_CACHE.candles;
  }
  function putCachedNiftyCandles(candles, rangeDays) {
    if (!candles || !candles.length) return;
    NIFTY_DAILY_CACHE = {
      candles: candles,
      fetchedAt: Date.now(),
      rangeDays: rangeDays || 0
    };
  }

  // Low-level fetch — returns sorted candles or THROWS a
  // descriptive Error (status code + body excerpt). Both
  // fetchMarketRegime + fetchNiftyDailyHistory call this so
  // there's exactly one place where the Upstox quirks (V3 URL
  // shape, Bearer header, NSE_INDEX|Nifty 50 instrument key,
  // newest-first ordering) are encoded. The fallback ladder
  // built on top of this can then try shorter ranges when a
  // wider one is rejected.
  async function fetchNiftyDailyRange(daysBack) {
    var token = getToken();
    if (!token) throw new Error('No Upstox token connected.');
    var ikey = encodeURIComponent('NSE_INDEX|Nifty 50');
    var to = new Date();
    var from = new Date();
    from.setDate(to.getDate() - daysBack);
    var url = BASE_V3 + '/historical-candle/' + ikey + '/days/1/' + fmtDate(to) + '/' + fmtDate(from);
    var resp;
    try {
      // Shares the /historical-candle 500/min budget with the scan.
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      resp = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }
      });
    } catch (netErr) {
      throw new Error('Network error reaching Upstox: ' + (netErr && netErr.message || netErr));
    }
    if (!resp.ok) {
      var bodyTxt = '';
      try { bodyTxt = (await resp.text()).slice(0, 200); } catch (_) {}
      // NOTE: deliberately does NOT feed its 429 into the shared throttle
      // gate. Regime is a NON-CRITICAL context fetch that degrades to null
      // (fetchMarketRegime catch → null → generatePlan treats regime as
      // unknown). If a regime 429 tripped the global cooldown, the CRITICAL
      // 1mo/1w/1d/1h candle fetches running in the SAME analyze() Promise.all
      // would stall behind that cooldown — leaving the chart stuck on its
      // loading spinner. The candle fetchers (fetchTf) have their own 429
      // detection + backoff; regime must not penalise them.
      throw new Error('Upstox HTTP ' + resp.status + ' for Nifty 50 daily (' + daysBack + 'd)'
        + (bodyTxt ? ': ' + bodyTxt : ''));
    }
    var d;
    try { d = await resp.json(); }
    catch (e) { throw new Error('Bad JSON from Upstox: ' + (e && e.message || e)); }
    var candles = (d && d.data && d.data.candles) || [];
    if (!candles.length) {
      throw new Error('Upstox returned zero Nifty 50 candles for ' + daysBack + 'd window.');
    }
    candles.sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    return candles;
  }

  async function fetchMarketRegime() {
    if (!getToken()) return null;
    var candles;
    try {
      // Re-use the cached candles when fresh, so scan-after-scan
      // doesn't hammer the regime endpoint.
      var cached = getCachedNiftyCandles(55);
      if (cached) {
        candles = cached;
      } else {
        candles = await fetchNiftyDailyRange(200);
        putCachedNiftyCandles(candles, 200);
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('[swing] fetchMarketRegime failed:', err && err.message);
      return null;
    }
    if (candles.length < 55) return null;
    var closes = candles.map(function (x) { return +x[4]; });
    var n = closes.length;
    var lastClose = closes[n - 1];
    // SMA-50 (textbook DMA — most traders watch the simple, not exponential).
    var sum50 = 0;
    for (var i = n - 50; i < n; i++) sum50 += closes[i];
    var dma50 = sum50 / 50;
    // DMA slope: compare today's 50-DMA to the 50-DMA five sessions
    // ago. Filters the "barely above" case where price is sitting
    // right on a falling DMA — technically above, but the line is
    // still pointed down → no edge.
    var sum50Prev = 0;
    for (var j = n - 55; j < n - 5; j++) sum50Prev += closes[j];
    var dma50Prev = sum50Prev / 50;
    var slopePct = dma50Prev > 0 ? ((dma50 - dma50Prev) / dma50Prev) * 100 : 0;
    var aboveDma = lastClose > dma50;
    var regime;
    if (aboveDma && slopePct > 0)       regime = 'BULL';
    else if (!aboveDma && slopePct < 0) regime = 'BEAR';
    else                                regime = 'NEUTRAL';
    return {
      regime: regime,
      lastClose: lastClose,
      dma50: dma50,
      distPct: ((lastClose - dma50) / dma50) * 100,
      slopePct: slopePct,
      // Last 21 daily closes so the multi-trigger screener can
      // compute each stock's 20-day return vs Nifty's (Relative
      // Strength). Tiny payload (~21 floats) reused across every
      // scan tick — no extra HTTP.
      recentCloses: closes.slice(-21)
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PER-STOCK RESULT CACHE
  // ═══════════════════════════════════════════════════════════════
  // Re-visiting a stock used to re-run the full 4-TF + LTP + regime
  // fan-out every time, even off-hours when nothing has changed. We
  // cache the computed result per ISIN and reuse it — but ONLY while
  // it still reflects the latest trading session's data.
  var SW_RESULT_CACHE_MAX = 60;            // bound memory (~60 stocks)
  var SW_RESULT_TTL_OPEN_MS = 5 * 60 * 1000; // intraday freshness window

  // Epoch ms of 09:15 IST (session open) on a given IST calendar date.
  // 09:15 IST == 03:45 UTC.
  function swingSessionOpenMsFor(istYear, istMonthIdx, istDay) {
    return Date.UTC(istYear, istMonthIdx, istDay, 3, 45, 0, 0);
  }

  // The most recent NSE session-open (09:15 IST on a trading day) at or
  // before `nowMs`. Walks back day-by-day, skipping weekends and (when
  // available) NSE holidays. Used as the cache-invalidation boundary:
  // any result computed BEFORE this instant predates the current
  // session and must be refetched.
  function swingMostRecentSessionOpenMs(nowMs) {
    for (var back = 0; back < 10; back++) {
      var ist = new Date(nowMs - back * 86400000 + IST_OFFSET_MS);
      var y = ist.getUTCFullYear(), mo = ist.getUTCMonth(), da = ist.getUTCDate();
      var dow = ist.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      var ymd = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(da).padStart(2, '0');
      if (typeof window.isNseHoliday === 'function') {
        try { if (window.isNseHoliday(ymd)) continue; } catch (_) {}
      }
      var openMs = swingSessionOpenMsFor(y, mo, da);
      if (openMs <= nowMs) return openMs;
    }
    // Couldn't resolve a session in 10 days — be conservative and treat
    // every cache entry as stale (forces a fresh fetch).
    return nowMs;
  }

  // A cached result is reusable iff (a) it was computed during/after the
  // current session's open (no 09:15 boundary has passed since), and
  // (b) if the market is currently OPEN, it's still within the intraday
  // freshness window (new bars close during the session). Off-hours the
  // session's W/D/H/M data is final, so no time cap is needed.
  function swingResultCacheValid(entry) {
    if (!entry || !entry.result) return false;
    // A result computed from a DIFFERENT data source (Upstox vs Angel One)
    // is stale the instant the user switches sources — the candles came
    // from a different broker feed. Reject the hit so analyze() re-fetches
    // from the now-current source instead of painting the old feed's data.
    if (entry.src && entry.src !== swDataSource()) return false;
    var now = Date.now();
    if (entry.at < swingMostRecentSessionOpenMs(now)) return false;
    if (swingMarketOpen()) return (now - entry.at) < SW_RESULT_TTL_OPEN_MS;
    return true;
  }

  // Store a result, evicting the oldest entry when over the cap.
  function swingCacheResult(isin, result) {
    if (!isin || !result) return;
    STATE.resultCache[isin] = { result: result, at: Date.now(), src: swDataSource() };
    var keys = Object.keys(STATE.resultCache);
    if (keys.length > SW_RESULT_CACHE_MAX) {
      var oldestKey = null, oldestAt = Infinity;
      for (var i = 0; i < keys.length; i++) {
        var e = STATE.resultCache[keys[i]];
        if (e && e.at < oldestAt) { oldestAt = e.at; oldestKey = keys[i]; }
      }
      if (oldestKey) delete STATE.resultCache[oldestKey];
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // ANALYZE — fetch + analyse + render
  // ═══════════════════════════════════════════════════════════════
  // `force` bypasses the per-stock cache (used by an explicit refresh).
  async function analyze(force) {
    if (!STATE.selected) return;
    // Persist the identity so a page reload can restore this stock's
    // chart (see swRestoreSelected). Stored before the pause/token
    // guards so the selection survives even when analysis is currently
    // blocked \u2014 reload then reproduces the same blocked state instead
    // of silently losing the pick.
    swSaveSelected(STATE.selected);
    // Mark the source this analysis ATTEMPT is for — set before any guard or
    // fetch so it reflects whatever ends up on screen (loading, a result, OR
    // an error card). swingActivate compares this against the live source to
    // decide whether a source switch (Upstox ⇄ Angel One) needs a re-fetch.
    // Tracking the attempt (not just a successful result) is what fixes a
    // stale "invalid token" error sticking around after switching back to a
    // source whose token actually works.
    STATE.resultSource = swDataSource();
    // De-dupe a double-fire for the SAME stock (e.g. a pick handler
    // that also re-renders the sector panel and re-triggers analyze).
    // A pick for a DIFFERENT stock is allowed through and supersedes
    // the in-flight run via the analyzeSeq check below.
    // STALENESS GUARD: only de-dupe a RECENT in-flight run. If a prior
    // analyze stalled (e.g. a candle fetch wedged in the rate-limiter and
    // never reached the `finally` that clears analyzingIsin), the flag
    // would otherwise permanently dead-click this stock until a page
    // reload. After the cap we let a fresh click through; it bumps
    // analyzeSeq so the stale run is discarded by the mySeq check below.
    var _inflightAgeMs = Date.now() - (STATE.analyzingStartTs || 0);
    if (STATE.analyzingIsin && STATE.analyzingIsin === STATE.selected.isin
        && _inflightAgeMs < 25000) return;
    if (swIsApiPaused()) {
      showError(
        'Swing API is paused',
        'You\'ve paused the swing module\u2019s API access (banner at the top of this tab). '
        + 'Click \u201cResume\u201d to fetch fresh analysis for ' + STATE.selected.sym + '. '
        + 'The pause is in place to protect your Upstox quota for Options Trading.'
      );
      return;
    }
    var token = getToken();
    if (!token) {
      showError('No Upstox token connected', 'Connect your token via the Options Trading tab → gear icon, then come back.');
      return;
    }

    // Cache hit → paint instantly, no network. Skipped on force-refresh.
    if (!force) {
      var cached = STATE.resultCache[STATE.selected.isin];
      if (swingResultCacheValid(cached)) {
        STATE.analyzeSeq++;          // supersede any in-flight stale run
        STATE.analyzingIsin = null;
        STATE.result = cached.result;
        renderResult();
        return;
      }
    }

    var mySeq = ++STATE.analyzeSeq;
    var myIsin = STATE.selected.isin;
    STATE.analyzingIsin = myIsin;
    STATE.analyzingStartTs = Date.now();   // staleness guard for the de-dupe above
    showLoading('Fetching weekly, daily and hourly candles for ' + STATE.selected.sym + '…');
    try {
      var isin = STATE.selected.isin;
      // Fan-out: stock W/D/H candles + LTP + Nifty regime (5 parallel
      // calls). Nifty regime sits behind a try/catch in the helper —
      // a failed regime fetch shouldn't abort the whole analysis,
      // generatePlan() just falls back to "regime unknown → don't
      // demote" so the user still gets a verdict on a flaky network.
      // Monthly is fetched alongside W/D/H — it's the strategic
      // context layer (Stage 1/2/3/4) that gates the verdict's
      // multi-year sanity check. Independent endpoint so it joins
      // the same parallel fan-out without adding latency.
      var results = await Promise.all([
        fetchTf(isin, '1mo'),
        fetchTf(isin, '1w'),
        fetchTf(isin, '1d'),
        fetchTf(isin, '1h'),
        fetchLtp(isin),
        fetchMarketRegime()
      ]);
      // A newer pick superseded this run while we were fetching —
      // discard so we don't render a stale stock or fight the newer
      // run's loading overlay.
      if (mySeq !== STATE.analyzeSeq) return;
      var rawM = results[0], rawW = results[1], rawD = results[2], rawH = results[3],
          ltp  = results[4], regime = results[5];

      // Upstox's DEEP daily window can lag the just-closed session (see
      // _swFillDailyGapFromShortWindow). Recover it from the short recent
      // window — BEFORE it feeds analyzeTf('1d') and is cached in
      // R.candles['1d'] — so the chart, cards and verdict all agree on the
      // latest closed day. No-op (and zero extra calls) when there's no
      // gap; single-stock path only, so the bulk scan never pays for it.
      rawD = await _swFillDailyGapFromShortWindow(myIsin, rawD);
      // The await above could be superseded by a newer pick — re-check.
      if (mySeq !== STATE.analyzeSeq) return;

      var anM = analyzeTf(rawM, '1mo');
      var anW = analyzeTf(rawW, '1w');
      var anD = analyzeTf(rawD, '1d');
      var anH = analyzeTf(rawH, '1h');
      if (!anW || !anD || !anH) {
        throw new Error('Insufficient historical data for one or more timeframes (W=' + (rawW || []).length + ', D=' + (rawD || []).length + ', H=' + (rawH || []).length + ' candles)');
      }
      // anM is allowed to be null (new listings with < 6 months of
      // monthly history) — generatePlan handles a missing monthly
      // gracefully (skips the stage bullet + score modifier).
      var plan = generatePlan(anM, anW, anD, anH, regime);
      STATE.result = {
        plan: plan,
        regime: regime,
        monthly: anM, weekly: anW, daily: anD, hourly: anH,
        // Per-TF raw candle cache keyed by TF spec. The Monthly /
        // Weekly / Daily / Hourly buffers are populated immediately
        // (we just fetched them for the analysis); 5-min (5m) is
        // added lazily when the user clicks that TF button on the
        // chart toolbar.
        candles: { '1mo': rawM, '1w': rawW, '1d': rawD, '1h': rawH },
        ltp: ltp,
        when: new Date()
      };
      swingCacheResult(myIsin, STATE.result);
      renderResult();
    } catch (e) {
      // Swallow errors from a superseded run — only the latest pick
      // should be allowed to paint an error card.
      if (mySeq !== STATE.analyzeSeq) return;
      var msg = (e && e.message) || 'Unknown error';
      if (msg === 'UNAUTHORIZED') {
        showError('Token rejected', 'Your Upstox token is invalid or expired. Open the Options Trading tab → gear icon and re-paste a fresh token.');
      } else if (msg === 'NO_TOKEN') {
        showError('No Upstox token connected', 'Connect your token via the Options Trading tab → gear icon, then come back.');
      } else {
        showError('Analysis failed', msg);
      }
    } finally {
      // Clear the in-flight marker only if we're still the latest run,
      // so a newer analyze that's already started keeps its guard.
      if (mySeq === STATE.analyzeSeq) STATE.analyzingIsin = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BULK VERDICT COMPUTE — Phase 0 discovery loop
  // ═══════════════════════════════════════════════════════════════
  // The single-stock `analyze()` above is DOM-coupled (writes
  // STATE, paints the result panel, manages loading/error UI). For
  // batch use we need a PURE pipeline that just returns the verdict
  // structure — so the orchestrator can run hundreds of stocks
  // through it without touching the DOM.
  //
  // analyzeStockPure(isin, regime):
  //   - Fetches M/W/D/H candles in parallel (no LTP — verdict only
  //     uses prior-close data, and LTP would double the HTTP fan-out
  //     for zero verdict-affecting value).
  //   - Calls the SAME `analyzeTf` + `generatePlan` the live
  //     analyzer uses → single source of truth, zero drift.
  //   - Caller passes `regime` (fetched once outside the loop) so
  //     604 stocks don't refetch Nifty 604 times.
  //   - Returns generatePlan's output directly (the plan object IS
  //     the verdict — { ok, action, bias, confidence, score, ... }).
  //   - On insufficient data: returns { ok: false, reason: '...' }.
  // Sub-INR-500 stocks are typically low-liquidity / high-noise
  // and most swing strategies can't size meaningfully into them
  // without moving the tape. Filtering at scan time also saves
  // 3 of the 4 historical-candle fetches per filtered stock
  // (we gate AFTER the cheap daily fetch but BEFORE M/W/H), which
  // materially reduces the rate-limit pressure on a 500+ stock
  // universe pass. Marked as `skipped: true` (not `failed`) so
  // the tile header can communicate "below floor" separately
  // from genuine fetch / rate-limit failures.
  // These two are the live source of truth for the price band everywhere
  // (scan gate, sector browse, universe stat line). The ₹400 / ₹2,200
  // values below are FALLBACK DEFAULTS — data/config.json can override them
  // via `swing_price_band: { min, max }` (applied by _swApplyPriceBand once
  // the config fetch resolves). If config is missing or malformed we keep
  // these defaults (fail safe — never widen the band on bad data).
  var SW_MIN_PRICE = 400;
  // Upper price band. Stocks closing above this are skipped (not failed)
  // the same way the floor works — the user trades a ₹400–₹2,200 band, so
  // very high-priced names (MRF, Page, Bosch, Shree Cement, etc.) are
  // filtered out of the scan to cut noise + rate-limit pressure. Both
  // bounds are inclusive of the band: keep ₹400 ≤ close ≤ ₹2,200.
  var SW_MAX_PRICE = 2200;

  // ── Scan timeframe (2026-05-30 multi-TF + pure-rules redesign) ──
  // The bulk scan + verdict engine run on ONE timeframe at a time,
  // chosen by the user. Default Daily (2026-06-02 — was Weekly; the
  // key was bumped to _v2 to force the new default for existing
  // users). The signal geometry (Fib / ZOI / structure) is
  // timeframe-agnostic — it just runs on whichever candles we pass —
  // so a TF switch is purely "which candles feed the same rules".
  var SW_SCAN_TF_KEY = 'sw_scan_tf_v2';
  // Timeframes that get an INDEPENDENT, live per-TF verdict via
  // swComputeVerdictForTf(). 4H/1H were added (2026-06-01) as
  // shorter-horizon, standalone reads — each computes ONLY from its
  // own candles (no cross-TF influence, and they do NOT feed the
  // daily/weekly composite screener verdict). The bulk-scan screener
  // still runs on 1M/1W/1D only; these two are detail-view reads the
  // user inspects manually for multi-TF confluence.
  var SW_TF_LABEL    = { '1mo': 'Monthly', '1w': 'Weekly', '1d': 'Daily', '4h': '4 Hour', '1h': '1 Hour' };
  // Timeframes the Reco-TF picker is allowed to select. This is a SUPERSET
  // of SW_TF_LABEL: the signalled TFs (1mo/1w/1d/4h/1h) produce a real
  // BUY/WAIT verdict, while the sub-hourly TFs (30m/15m/5m) are
  // CARDS-ONLY informational lenses — they render the Fib + ZOI analysis
  // cards from their own candles but NEVER emit a buy/sell signal
  // (swComputeVerdictForTf routes any TF outside SW_TF_LABEL to the
  // echo/intraday path). Sub-hourly is too fast to frame a reliable swing
  // leg, so surfacing structure without a signal is the safe contract.
  // KEEP these two lists separate — adding 30m/15m/5m to SW_TF_LABEL would
  // (wrongly) turn them into signal-generating TFs.
  var SW_RECO_TF_SELECTABLE = { '1mo': 1, '1w': 1, '1d': 1, '4h': 1, '1h': 1, '30m': 1, '15m': 1, '5m': 1 };
  // Minimum candle count to attempt a verdict on each TF. A swing
  // structure needs a completed leg: monthly/weekly are slow so 8
  // bars is enough; daily needs more bars to frame a comparable leg.
  // 4H/1H have hundreds of bars in their fetch window — the 40-bar
  // floor (> analyzeTf's own 30-bar guard) keeps a too-new / thin
  // instrument fail-safe (below the floor → "not enough data", never
  // a guessed signal).
  var SW_TF_MIN_BARS = { '1mo': 8, '1w': 8, '1d': 30, '4h': 40, '1h': 40 };
  // Next-higher timeframe, for the card's "higher-TF bias" context line.
  // 4H and 1H both point to Daily — it's the nearest higher TF we hold
  // a computed analysis object for (R.daily), and a sound bigger-picture
  // context for an intraday read. (We don't store a 4H analysis object,
  // so 1H→4H would have nothing to read.)
  // Sub-hourly cards-only TFs (30m/15m/5m) point at Daily too — same
  // rationale as 4H/1H: Daily (R.daily) is the nearest higher-TF analysis
  // object we hold, and a sound bigger-picture context line for an
  // intraday read. Surfaces the "Daily bias" chip in the Risk Context grid.
  var SW_HIGHER_TF   = { '1d': '1w', '1w': '1mo', '1mo': null, '4h': '1d', '1h': '1d', '30m': '1d', '15m': '1d', '5m': '1d' };
  function swingNormalizeTf(tf) {
    return (tf === '1mo' || tf === '1w' || tf === '1d') ? tf : '1d';
  }
  function swingGetScanTf() {
    try { return swingNormalizeTf(localStorage.getItem(SW_SCAN_TF_KEY)); }
    catch (_) { return '1d'; }
  }
  function swingSetScanTf(tf) {
    tf = swingNormalizeTf(tf);
    try { localStorage.setItem(SW_SCAN_TF_KEY, tf); } catch (_) {}
    return tf;
  }

  // ── Scan scope (which slice of the universe to scan) ──
  // '__all__' = the full NSE/BSE universe (curated sectors/indices
  // UNIONed with the instruments index — the historical default, ~20-30
  // min, the heaviest on the rate budget). Any other value is a curated
  // sector OR index id (see data/sectors.json); the scan is then limited
  // to just that group, which slashes the API call count and finishes in
  // a minute or two. Validated against the loaded group list at scan time
  // (swingComputeAllVerdicts) — an unknown/stale id fails safe back to
  // '__all__' rather than scanning an empty set.
  var SW_SCAN_SCOPE_KEY = 'sw_scan_scope_v1';
  function swingGetScanScope() {
    try { return localStorage.getItem(SW_SCAN_SCOPE_KEY) || '__all__'; }
    catch (_) { return '__all__'; }
  }
  function swingSetScanScope(scope) {
    scope = scope || '__all__';
    try { localStorage.setItem(SW_SCAN_SCOPE_KEY, scope); } catch (_) {}
    return scope;
  }

  // ── Token bucket throttle ──
  // The original bulk scan ran 4 workers \u00d7 4 timeframes in parallel,
  // which produced bursts of 16 concurrent HTTP requests. Upstox's
  // Cloudflare WAF flagged this as abuse and IP-blocked the user
  // for hours (Cloudflare error 1015 \u2014 worse than a soft 429
  // because it locks the entire endpoint surface, not just one
  // route). The token bucket caps sustained outbound rate so the
  // scan stays well below Upstox's per-minute cap AND below the
  // burst threshold that triggers Cloudflare.
  //
  // 1.5 req/sec sustained \u2248 90/min, comfortable margin under
  // typical "250/min historical" quotas. Burst capacity 3 lets a
  // single stock's M/W/H fetches start without waiting (paired
  // with the daily-first gate, that's 4 calls back-to-back at
  // most per stock). Total scan time: ~20 min for 600 stocks
  // post price-filter \u2014 slower than before, but reliable.
  function createTokenBucket(ratePerSec, capacity) {
    var tokens = capacity;
    var lastRefill = Date.now();
    return {
      acquire: async function () {
        while (true) {
          var now = Date.now();
          var elapsed = (now - lastRefill) / 1000;
          tokens = Math.min(capacity, tokens + elapsed * ratePerSec);
          lastRefill = now;
          if (tokens >= 1) {
            tokens -= 1;
            return;
          }
          var waitMs = Math.ceil((1 - tokens) / ratePerSec * 1000);
          await new Promise(function (res) {
            setTimeout(res, waitMs + 25);
          });
        }
      }
    };
  }

  async function analyzeStockPure(isin, regime, band) {
    // `band` (optional) overrides the global price gate for the active scan
    // scope — the High Liquidity screen passes its ₹500–₹2,000 band. Falls
    // safe to the global default when omitted (backtest + default scans).
    var bMin = (band && isFinite(+band.min)) ? +band.min : SW_MIN_PRICE;
    var bMax = (band && isFinite(+band.max)) ? +band.max : SW_MAX_PRICE;
    var rawD = await fetchTf(isin, '1d');
    if (!rawD || !rawD.length) {
      return { ok: false, insufficientHistory: true, reason: 'No daily candles \u2014 likely newly listed or bad instrument' };
    }
    var lastClose = +rawD[0][4];
    if (isFinite(lastClose) && (lastClose < bMin || lastClose > bMax)) {
      var _side = lastClose < bMin ? 'below' : 'above';
      return {
        ok: false,
        skipped: true,
        price: lastClose,
        reason: 'Price \u20B9' + lastClose.toFixed(2)
              + ' is ' + _side + ' the \u20B9' + bMin + '\u2013\u20B9' + bMax + ' band'
      };
    }
    var rest = await Promise.all([
      fetchTf(isin, '1mo'),
      fetchTf(isin, '1w'),
      fetchTf(isin, '1h')
    ]);
    var anM = analyzeTf(rest[0], '1mo');
    var anW = analyzeTf(rest[1], '1w');
    var anD = analyzeTf(rawD,    '1d');
    var anH = analyzeTf(rest[2], '1h');
    if (!anW || !anD || !anH) {
      return { ok: false, insufficientHistory: true, reason: 'Not enough historical data (W=' + (rest[1] || []).length + ', D=' + (rawD || []).length + ', H=' + (rest[2] || []).length + ' candles) \u2014 likely newly listed' };
    }
    return generatePlan(anM, anW, anD, anH, regime);
  }

  // Iterates the full universe (sectors + indices, deduplicated by
  // ISIN) and computes a verdict for every stock with N concurrent
  // workers. The existing fetchTf already respects the global
  // _upstoxIsThrottled gate and retries on 429 — so we don't add
  // any rate-limit logic here, the worker just calls and waits.
  //
  // `onProgress(done, total, last)` fires after each stock so the
  // UI can paint a live counter without inspecting internal state.
  // Returns the full verdicts payload (caller decides what to do
  // with it — download, render, persist).
  // Concurrency is now subordinate to the token bucket \u2014 the
  // bucket is the actual rate ceiling, workers just pipeline
  // around it. 2 workers is enough to keep the bucket saturated
  // (one stock's H fetch overlapping another's daily fetch)
  // without inflating burst behavior.
  var SW_BULK_CONCURRENCY = 2;

  async function _computeStockVerdict(isin, mode, regime, tf, band) {
    tf = swingNormalizeTf(tf);
    // The candle fetch is the ONLY impure step. Everything after it lives
    // in the pure scanVerdictFromCandles() below, so the headless backtest
    // harness (scripts/backtest/run-scan.mjs) can drive the EXACT same
    // Fib/ZOI verdict engine on sliced historical candles — single source
    // of truth, zero signal drift (see .cursor/rules/trading-context.mdc).
    var raw = await fetchTf(isin, tf);
    return scanVerdictFromCandles(raw, mode, regime, tf, band);
  }

  // ── SINGLE SOURCE OF TRUTH: verdict inputs (FIB + ZOI + FIB+ZOI) ─────────
  // Both the bulk SCAN (scanVerdictFromCandles) and the per-stock CARD
  // (swComputeVerdictForTf) used to INLINE the same three blocks — the
  // retPct -> fibClass ladder, the zoiRising HH/HL micro-count, and the
  // `gate` assembly — then call _resolveVerdict() with the same arg order.
  // Two copies = silent drift risk: a threshold tweak in one and not the
  // other makes the scan LIST disagree with the per-stock CARD (real money:
  // a BUY surfaced in the list that the card later contradicts). This pure
  // helper is now the ONLY place those inputs are computed, so the two paths
  // can never diverge.
  //
  // The three LEGITIMATE differences are passed in via opts (never flattened):
  //   • an              – the analyzeTf(raw, tf) trend result (the caller
  //                       already has it; reused for gate.weeklyTrend AND the
  //                       pattern context, so we never re-run the analyzer).
  //   • currentPx       – seed price: SCAN seeds with the last close, the CARD
  //                       seeds with the live LTP. It is overwritten to
  //                       fibResult.currentPx whenever a fib exists (both paths
  //                       already did this), so it only differs on a no-fib
  //                       (ZOI-only) verdict — exactly as before.
  //   • regime          – the regime object: SCAN passes its `regime` arg, the
  //                       CARD passes R.regime. Read as (regime && regime.regime).
  //   • withChartPatterns – SCAN false (fast: candle modifier only); CARD true
  //                       (full geometric chart-pattern detection).
  //
  // Returns every field both callers consume downstream of the verdict. Two
  // things are deliberately NOT unified and stay in the callers: (a) the SCAN
  // early-return on a missing FIB structure (mode==='FIB' && !hasFib) builds a
  // scan-shaped WAIT payload; (b) `basis` — SCAN derives it from the MODE,
  // the CARD derives it from hasFib/hasZoi (a pre-existing, intentional gap).
  //
  // NOTE: the scan gate historically carried an inert `bounceStatus` field; it
  // is intentionally dropped here. Rule matching consumes bounceStatus via the
  // 3rd POSITIONAL arg to _resolveVerdict (see _resolveVerdictCore) — never
  // gate.bounceStatus, and `gate` is only ever read by named property (no
  // Object.keys / for-in), so the resolved verdict is byte-identical without it.
  function swComputeVerdictInputs(raw, tf, mode, opts) {
    opts = opts || {};
    var an = opts.an || analyzeTf(raw, tf) || {};
    var ownTrend = (an && an.trend) ? an.trend : 'NEUTRAL';
    var regimeObj = opts.regime || null;
    var withChart = !!opts.withChartPatterns;
    var currentPx = (opts.currentPx != null && isFinite(opts.currentPx)) ? opts.currentPx : +raw[0][4];

    var doFib = (mode === 'FIB' || mode === 'FIB_ZOI');
    var doZoi = (mode === 'ZOI' || mode === 'FIB_ZOI');

    // ── FIB: retracement-depth -> fibClass ladder ──
    var fibResult = doFib ? computeFibZone(raw) : null;
    var hasFib = !!(fibResult && fibResult.plan);
    var fibClass = 'NONE', fibTouchedZone = false, fibBounceStatus = '', retPct = NaN;
    if (hasFib) {
      var fp = fibResult;
      var px = fp.currentPx;
      var range = fp.swHigh - fp.swLow;
      var rising = fp.isRising;
      fibTouchedZone = !!fp.touchedZone;
      fibBounceStatus = fp.bounceStatus || '';
      retPct = range > 0 ? ((fp.swHigh - px) / range) * 100 : 0;
      if (retPct >= 61.8 && retPct <= 80)      fibClass = rising ? 'IN_POCKET_RISING' : 'IN_POCKET_FALLING';
      else if (retPct > 80 && retPct < 97)     fibClass = rising ? 'BELOW_POCKET_RISING' : 'BELOW_POCKET_FALLING';
      else if (retPct >= 97)                   fibClass = rising ? 'AT_SWING_LOW_RISING' : 'AT_SWING_LOW_FALLING';
      else if (retPct <= 3)                    fibClass = 'AT_SWING_HIGH';
      else if (retPct > 3 && retPct <= 38.2)   fibClass = (fp.fibDirection === 'RISING' && (fp.fibOriginZone === 'Deep' || fp.fibOriginZone === 'Below' || fp.fibOriginZone === 'Pocket')) ? 'RECOVERED_ABOVE_POCKET' : 'SHALLOW_ABOVE_POCKET';
      else if (retPct > 38.2 && retPct < 61.8) {
        var dap = (px - fp.fib618) / fp.fib618 * 100;
        fibClass = (dap >= 0 && dap <= 20) ? (rising ? 'NEAR_ABOVE_POCKET_RISING' : 'NEAR_ABOVE_POCKET_FALLING') : 'FAR_ABOVE_POCKET';
      } else                                   fibClass = 'FAR_ABOVE_POCKET';
      currentPx = px;
    }

    // ── ZOI: demand/supply-zone position ──
    var zoiRising = false, zoiPos = { position: 'BETWEEN_ZONES', zone: null, distPct: 0, cameFromBelow: false, roomToRun: 1 };
    var hasZoi = false, zones = null, zoiAtrPct = null;
    if (doZoi) {
      zones = detectZones(raw);
      if (raw.length >= 4) {
        var h0 = +raw[0][2], h1 = +raw[1][2], h2 = +raw[2][2], h3 = +raw[3][2];
        var l0 = +raw[0][3], l1 = +raw[1][3], l2 = +raw[2][3], l3 = +raw[3][3];
        var hhC = (h0 > h1 ? 1 : 0) + (h1 > h2 ? 1 : 0) + (h2 > h3 ? 1 : 0);
        var hlC = (l0 > l1 ? 1 : 0) + (l1 > l2 ? 1 : 0) + (l2 > l3 ? 1 : 0);
        zoiRising = (hhC >= 2 && hlC >= 2);
      } else if (raw.length >= 3) {
        zoiRising = +raw[0][4] > +raw[1][4] && +raw[1][4] > +raw[2][4];
      }
      zoiAtrPct = _zoiAtrPct(raw);
      zoiPos = _classifyZoiPosition(zones, currentPx, raw, zoiRising, zoiAtrPct);
      hasZoi = zoiPos.position !== 'BETWEEN_ZONES';
    }

    // ── GATE: risk / confluence context (informational — never a veto) ──
    var fibResForGate = hasFib ? fibResult : null;
    var zone = (hasZoi && zoiPos && zoiPos.zone) ? zoiPos.zone : null;
    var sb = detectStructureBreaks(raw, { pivot: BOS_PIVOT_BY_TF[tf] || 5 });
    var fvgs = detectFVG(raw);
    var liq = detectLiqSweeps(raw);
    // Mode-native R:R — FIB uses fib levels, ZOI uses demand->supply zones,
    // FIB+ZOI combines, all capped by structure (see _swStandardRR).
    var stdRR = _swStandardRR(raw, currentPx, {
      mode: mode,
      fib: fibResForGate,
      zones: doZoi ? zones : null,
      demandZone: (zone && zone.type === 'DEMAND') ? zone : null
    });
    var gate = {
      tf: tf,
      // `weeklyTrend` keeps its name for the confluence scorer, but now holds
      // the OWN-trend on this timeframe (monthly/weekly/daily/hourly).
      weeklyTrend: ownTrend,
      regime: (regimeObj && regimeObj.regime) || null,
      rr: stdRR ? stdRR.rr : null,
      slPct: stdRR ? stdRR.slPct : null,
      rrEntry: stdRR ? stdRR.entry : null,
      rrSl: stdRR ? stdRR.sl : null,
      rrT1: stdRR ? stdRR.t1 : null,
      smcTrend: sb ? recentSwingTrend(sb) : null,
      smcLastBreak: (sb && sb.breaks && sb.breaks.length) ? sb.breaks[sb.breaks.length - 1] : null,
      zoneFreshness: zone ? zone.freshness : null,
      zoneTestCount: zone ? (zone.testCount || 0) : 0,
      volConfirm: fibResForGate ? fibResForGate.volConfirm : null,
      volRatio: fibResForGate ? fibResForGate.volRatio : null,
      bullFvgSupport: _bullFvgSupport(fvgs, currentPx),
      pocketFvg: fibResForGate ? _fvgInPocket(fvgs, fibResForGate.fib786, fibResForGate.fib618) : false,
      liqSweepSupport: _liqSweepSupport(liq, currentPx)
    };
    var pocketVsZone = _pocketVsZone(hasFib, hasZoi, fibResForGate, zoiPos);
    var patternCtx = _buildPatternContext(an, raw, tf, withChart);
    var vr = _resolveVerdict(fibClass, fibTouchedZone, fibBounceStatus, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf, gate, pocketVsZone, patternCtx);

    return {
      mode: mode, doFib: doFib, doZoi: doZoi, currentPx: currentPx,
      hasFib: hasFib, fibResult: fibResult, fibClass: fibClass,
      fibTouchedZone: fibTouchedZone, fibBounceStatus: fibBounceStatus, retPct: retPct,
      hasZoi: hasZoi, zoiRising: zoiRising, zoiPos: zoiPos, zones: zones,
      zoiAtrPct: zoiAtrPct, zone: zone,
      gate: gate, pocketVsZone: pocketVsZone, patternCtx: patternCtx,
      ownTrend: ownTrend, vr: vr
    };
  }

  // Pure Fib/ZOI scan verdict computed from already-fetched candles.
  // Extracted verbatim from _computeStockVerdict's post-fetch body
  // (behaviour-preserving move, not a rewrite). Exposed via the
  // __SWING_TEST__ hook for the backtester.
  function scanVerdictFromCandles(raw, mode, regime, tf, band) {
    tf = swingNormalizeTf(tf);
    var tfLabel = SW_TF_LABEL[tf] || tf;
    var minBars = SW_TF_MIN_BARS[tf] || 8;
    if (!raw || raw.length < minBars) {
      // Fetch SUCCEEDED but returned too few bars (newly listed, delisted,
      // or a bad instrument key) — this is NOT transient, so a retry would
      // just fail again. Flag it as insufficientHistory so the scan can
      // bucket it as a non-retryable "Too new" skip rather than lumping it
      // in with rate-limited failures. (Genuine rate-limits THROW
      // _throttleErr from fetchOne and are caught + flagged rateLimited.)
      return { ok: false, insufficientHistory: true, reason: 'Not enough ' + tfLabel.toLowerCase() + ' candles (' + (raw || []).length + ', need \u2265' + minBars + ') \u2014 likely newly listed' };
    }
    // Stock's OWN trend on the SCAN timeframe — the higher-timeframe
    // context surfaced in the risk card. Reuses the same analyzer the
    // single-stock path runs; no extra fetch (we already have candles).
    // `_anOwn` is the stock's own trend on the scan TF; it is handed to the
    // shared verdict helper (which derives gate.weeklyTrend + the pattern
    // context from it), so we don't recompute the trend twice.
    var _anOwn = analyzeTf(raw, tf);
    // Per-scope price gate. `band` (optional) lets the High Liquidity screen
    // narrow to ₹500–₹2,000; omitted (default scans + backtest) ⇒ global band.
    var _bMin = (band && isFinite(+band.min)) ? +band.min : SW_MIN_PRICE;
    var _bMax = (band && isFinite(+band.max)) ? +band.max : SW_MAX_PRICE;
    var lastClose = +raw[0][4];
    if (!isFinite(lastClose) || lastClose < _bMin || lastClose > _bMax) {
      var _side = (isFinite(lastClose) && lastClose < _bMin) ? 'below' : 'above';
      return {
        ok: false,
        skipped: true,
        price: isFinite(lastClose) ? lastClose : null,
        reason: 'Price \u20B9' + (isFinite(lastClose) ? lastClose.toFixed(2) : '?')
              + ' is ' + _side + ' the \u20B9' + _bMin + '\u2013\u20B9' + _bMax + ' band'
      };
    }

    var doFib = (mode === 'FIB' || mode === 'FIB_ZOI');
    var doZoi = (mode === 'ZOI' || mode === 'FIB_ZOI');
    // Plain-language basis of the signal, surfaced on every verdict so
    // a BUY always states WHAT it's based on (FIB / ZOI / FIB+ZOI). The SCAN
    // derives basis from the MODE (the card derives it from hasFib/hasZoi —
    // a pre-existing, intentional difference; see swComputeVerdictInputs).
    var basis = (doFib && doZoi) ? 'FIB+ZOI' : (doFib ? 'FIB' : (doZoi ? 'ZOI' : 'NONE'));

    // SINGLE SOURCE: FIB + ZOI + gate + verdict all come from the shared
    // helper. SCAN seeds currentPx with the last close and runs the fast
    // pattern path (candle modifier only, withChart=false).
    var _inputs = swComputeVerdictInputs(raw, tf, mode, {
      an: _anOwn,
      currentPx: lastClose,
      regime: regime,
      withChartPatterns: false
    });

    // FIB-mode with no valid fib structure: the only mode-specific early-out.
    // (FIB+ZOI falls through to ZOI; only pure FIB has nothing to say.) When
    // !hasFib here, the helper never overwrote the seed, so currentPx === last
    // close — identical to the pre-refactor payload.
    if (mode === 'FIB' && !_inputs.hasFib) {
      return {
        ok: true, action: 'WAIT',
        reasoning: 'no valid fib structure \u2014 stock has no completed swing low \u2192 high move to retrace',
        tooltip: 'FIB requires a clear swing low \u2192 swing high structure.\nThis stock either:\n  \u2022 Listed recently without enough history\n  \u2022 Has been in a continuous downtrend since its high\n  \u2022 Made its high at the start of available data\n\nNo fib retracement is possible. Use ZOI mode for zone-based analysis.',
        verdictClass: 'sw-neutral',
        price: _inputs.currentPx,
        fibClass: null,
        zoiPosition: null,
        tf: tf,
        basis: basis,
        mode: mode
      };
    }

    var vr = _inputs.vr;
    var currentPx = _inputs.currentPx;
    // Two-sided zone readout prepended to the scan-table reasoning (display
    // only — vr is untouched). "3% above demand · 6% below supply (≈1½ days
    // off the floor)": the % the trader reads, the ATR sense in plain words.
    var _zoiReadout = _inputs.hasZoi ? _zoiTwoSidedReadout(_inputs.zones, currentPx, _inputs.zoiPos.position, _inputs.zoiAtrPct, tf) : '';
    return {
      ok: true,
      action: vr.text,
      reasoning: _zoiReadout ? (_zoiReadout + ' \u2014 ' + vr.sub) : vr.sub,
      tooltip: vr.tip,
      verdictClass: vr.cls,
      price: currentPx,
      fibClass: _inputs.hasFib ? _inputs.fibClass : null,
      zoiPosition: _inputs.hasZoi ? _inputs.zoiPos.position : null,
      confluence: vr.confluence || null,
      conviction: vr.conviction || null,
      riskContext: vr.riskContext || null,
      riskFlags: vr.riskFlags || null,
      tf: tf,
      basis: basis,
      mode: mode
    };
  }

  // Guards against overlapping bulk runs: a full scan and a "retry
  // failed" (or a stray double-trigger across the two buttons) must not
  // run concurrently — they share the same status element AND the live-
  // feed pause/resume bookkeeping, which would otherwise interleave and
  // resume feeds out from under a still-running scan. Set true for the
  // duration of either run, cleared in their finally blocks.
  var _swBulkScanInFlight = false;

  // ── Shared verdict ordering + tallying ──
  // Extracted so the bulk scan AND the "retry failed" merge order/count
  // rows identically (no drift). Sort: BUY → WAIT/WATCH → AVOID/etc →
  // failures, highest confluence (then legacy score) first within a band.
  function _swRankVerdicts(verdicts) {
    function _bandRank(v) {
      if (!v.ok) return 4;
      if (v.action === 'BUY') return 1;
      if (v.action === 'WAIT' || v.action === 'WATCH') return 2;
      return 3; // AVOID / CAUTION / SKIP
    }
    function _rowRankScore(v) {
      if (v.confluence && v.confluence.score != null) return v.confluence.score;
      return (v.score != null) ? v.score : -Infinity;
    }
    verdicts.sort(function (a, b) {
      var aR = _bandRank(a), bR = _bandRank(b);
      if (aR !== bR) return aR - bR;
      return _rowRankScore(b) - _rowRankScore(a);
    });
    return verdicts;
  }
  function _swCountVerdicts(verdicts) {
    return {
      succeeded:  verdicts.filter(function (v) { return v.ok; }).length,
      skipped:    verdicts.filter(function (v) { return !v.ok && v.skipped; }).length,
      // Newly listed / too little history — NOT retryable (a re-scan would
      // just fail the same way), so it gets its own bucket and is excluded
      // from `failed` (which the Retry button targets).
      insufficientHistory: verdicts.filter(function (v) { return !v.ok && !v.skipped && v.insufficientHistory; }).length,
      // Transient failures only (rate-limited / network) — what Retry re-runs.
      failed:     verdicts.filter(function (v) { return !v.ok && !v.skipped && !v.insufficientHistory; }).length,
      buyCount:   verdicts.filter(function (v) { return v.ok && v.action === 'BUY'; }).length,
      waitCount:  verdicts.filter(function (v) { return v.ok && (v.action === 'WAIT' || v.action === 'WATCH'); }).length,
      avoidCount: verdicts.filter(function (v) { return v.ok && (v.action === 'AVOID' || v.action === 'CAUTION' || v.action === 'SKIP'); }).length
    };
  }

  async function swingComputeAllVerdicts(onProgress, verdictMode, allowMarketHours, scanTf, scanScope, stockSubset) {
    scanTf = swingNormalizeTf(scanTf);
    var scope = scanScope || '__all__';
    if (swIsApiPaused()) {
      throw new Error('Swing API is paused. Click \u201cResume\u201d on the banner at the top of the Swing tab before running the bulk scan.');
    }
    var token = getToken();
    if (!token) {
      throw new Error('No Upstox token connected. Open the Options Trading tab → gear icon to add one, then come back.');
    }

    // Soft market-hours guard. Running the bulk scan during live
    // market shares the same per-IP Upstox rate budget as the
    // chart's spot poller AND option-chain polling, so it can
    // momentarily slow them or (in the worst case) trip the rate
    // limit. The UI surfaces an explicit warning + opt-in confirm
    // before passing allowMarketHours=true; only block here if the
    // caller did NOT explicitly opt in (defensive guard).
    if (!allowMarketHours && typeof window.isMarketOpen === 'function' && window.isMarketOpen()) {
      throw new Error('Market is currently open. Confirm the live-data warning to run the bulk scan during market hours.');
    }

    // RETRY MODE: a caller may pass an explicit stockSubset (the failed
    // rows from a prior scan). When present we skip universe-building and
    // run the worker pool over just those names — regime fetch, worker
    // pool, and payload assembly downstream are identical, so the result
    // merges cleanly back into the original scan.
    var stocks, total, scopeName, scopeAll;
    var excludedTooNew = 0;
    if (stockSubset && stockSubset.length) {
      stocks = stockSubset.slice();
      total = stocks.length;
      scopeAll = (scope === '__all__');
      scopeName = scopeAll ? 'All NSE/BSE' : (scanScope || scope);
    } else {
    // Ensure sectors.json is loaded — single fetch (or cache hit).
    var sectorData;
    try { sectorData = await loadSectors(); }
    catch (e) { throw new Error('Could not load sector universe: ' + (e && e.message || e)); }

    // Flatten sectors + indices into one stock list, deduped by
    // ISIN (a Nifty 50 member is also in Banking / IT etc. — we
    // only want to analyze each stock once but record every group
    // it belongs to so the consumer can filter by sector or index).
    var byIsin = Object.create(null);
    function addStock(st, groupId, groupName) {
      if (!st.isin) return;
      // Keep the exchange map authoritative for everything we scan
      // (curated sector/index stocks are NSE; index merge passes exch).
      swNoteExch(st.isin, st.exch === 'BSE' ? 'BSE' : 'NSE');
      if (!byIsin[st.isin]) {
        byIsin[st.isin] = {
          sym: st.sym, isin: st.isin, name: st.name, groups: []
        };
      }
      byIsin[st.isin].groups.push({ id: groupId, name: groupName });
    }
    // Resolve the scope's human label from the freshly-loaded sector data
    // (self-contained — no dependency on the UI's cached group list). An
    // unknown/stale id falls safe back to the full universe so the scan
    // never silently runs on an empty set.
    var scopeName = 'All NSE/BSE';
    if (scope !== '__all__') {
      var _grp = (sectorData.sectors || []).concat(sectorData.indices || [])
        .filter(function (g) { return g && g.id === scope; })[0];
      if (_grp) { scopeName = _grp.name || scope; }
      else { scope = '__all__'; }  // stale id → fail safe to full universe
    }
    var scopeAll = (scope === '__all__');

    // When a single sector/index is selected we ONLY pull that group's
    // members; otherwise we union every curated group (the historical
    // default). Limiting the scope here is what slashes the API budget.
    (sectorData.sectors || []).forEach(function (sec) {
      if (!scopeAll && sec.id !== scope) return;
      (sec.stocks || []).forEach(function (st) { addStock(st, sec.id, sec.name); });
    });
    (sectorData.indices || []).forEach(function (idx) {
      if (!scopeAll && idx.id !== scope) return;
      (idx.stocks || []).forEach(function (st) { addStock(st, idx.id, idx.name); });
    });
    // Full-universe expansion (only for the '__all__' scope): merge in
    // EVERY equity from the instruments index (NSE_EQ + BSE-only) that
    // isn't already in a curated sector/index, tagged "All NSE/BSE".
    // BSE-only rows carry pair[2] === 'BSE' so fetches pick the right
    // segment. Fail-safe: if the index can't load we silently keep the
    // curated sector/index universe (~600) rather than abort — never
    // block the scan on the optional breadth layer. Curated names keep
    // their real sector grouping; we only add the ones that have no
    // curated home, so sector filters stay meaningful. A specific-sector
    // scan skips this entirely (that's the whole point — fewer calls).
    if (scopeAll) {
      try {
        var _allIdx = await loadInstrumentsIndex();
        if (_allIdx && _allIdx.stocks) {
          Object.keys(_allIdx.stocks).forEach(function (sym) {
            var pair = _allIdx.stocks[sym];
            if (!pair || !pair[0]) return;     // need an ISIN to fetch
            if (byIsin[pair[0]]) return;       // already in a sector/index
            addStock({ sym: sym, isin: pair[0], name: pair[1] || sym,
              exch: pair[2] === 'BSE' ? 'BSE' : 'NSE' },
              'all-nse', 'All NSE/BSE');
          });
        }
      } catch (_) { /* tolerated — fall back to curated universe */ }
    }
    stocks = Object.keys(byIsin).map(function (k) { return byIsin[k]; });
    // Drop names we already know are too new to analyze (within the
    // re-check cooldown). Saves the wasted fetch + keeps the result list
    // honest. Expired entries are NOT active, so a matured stock falls
    // through here and gets re-evaluated. (Retry mode skips this block
    // entirely — its subset is the caller's chosen failed rows.)
    var _tooNewMap = swLoadTooNew();
    stocks = stocks.filter(function (st) {
      if (swIsTooNewActive(st.isin, _tooNewMap)) { excludedTooNew++; return false; }
      return true;
    });
    total = stocks.length;
    }
    // Fail safe: a specific scope that produced zero scannable names
    // (e.g. a sector emptied by a prior universe prune) is an explicit
    // error rather than a silent no-op scan.
    if (!scopeAll && total === 0) {
      if (excludedTooNew > 0) {
        throw new Error('All ' + excludedTooNew + ' name(s) in \u201c' + scopeName
          + '\u201d are on the too-new skip-list (not enough history yet). Click \u201cClear too-new\u201d to force a re-scan, or pick another scope.');
      }
      throw new Error('No scannable stocks in \u201c' + scopeName + '\u201d. Pick another scope or choose All NSE/BSE.');
    }

    // Regime fetched ONCE — passed to every per-stock analyzer call.
    // A regime failure isn't fatal: generatePlan tolerates a null
    // regime (treats it as UNKNOWN, no demotion). We log it so the
    // user knows the verdicts were computed without the regime gate.
    var regime = null;
    try { regime = await fetchMarketRegime(); }
    catch (_) { /* tolerated */ }

    // Resolve the price band ONCE for this scan's scope — a group may
    // carry its own band (the High Liquidity screen → ₹500–₹2,000); every
    // other scope falls safe to the global ₹SW_MIN–₹SW_MAX default.
    var scanBand = _swBandFor(scope);

    // Worker pool — each worker pulls from the shared queue, calls
    // analyzeStockPure, records the result, fires the progress
    // callback. No retries here — fetchTf already retries internally
    // on retryable errors (429, transient 5xx). A persistent failure
    // (auth, throttle-cap exceeded) lands in catch as { ok: false }.
    var queue = stocks.slice();
    var verdicts = [];
    var done = 0;
    async function worker() {
      while (true) {
        var st = queue.shift();
        if (!st) return;
        var row = {
          isin: st.isin, sym: st.sym, name: st.name, groups: st.groups
        };
        try {
          if (verdictMode) {
            var vResult = await _computeStockVerdict(st.isin, verdictMode, regime, scanTf, scanBand);
            if (vResult && vResult.ok) {
              row.ok         = true;
              row.action     = vResult.action;
              row.reasoning  = vResult.reasoning;
              row.tooltip    = vResult.tooltip;
              row.verdictCls = vResult.verdictClass;
              row.price      = vResult.price;
              row.fibClass   = vResult.fibClass;
              row.zoiPosition = vResult.zoiPosition;
              row.confluence = vResult.confluence;
              row.conviction = vResult.conviction;
              row.riskContext = vResult.riskContext;
              row.riskFlags  = vResult.riskFlags;
              row.tf         = vResult.tf;
              row.basis      = vResult.basis;
              row.mode       = vResult.mode;
            } else {
              row.ok = false;
              row.error = (vResult && vResult.reason) || 'no recommendation';
              if (vResult && vResult.skipped) row.skipped = true;
              if (vResult && vResult.insufficientHistory) row.insufficientHistory = true;
              if (vResult && isFinite(vResult.price)) row.price = vResult.price;
            }
          } else {
            var plan = await analyzeStockPure(st.isin, regime, scanBand);
            if (plan && plan.ok) {
              row.ok           = true;
              row.action       = plan.action;
              row.bias         = plan.bias;
              row.confidence   = plan.confidence;
              row.confidencePct = plan.confidencePct != null ? plan.confidencePct : null;
              row.score        = plan.score;
              row.setupName    = plan.setupName;
              row.setupShort   = plan.setupShort;
              row.gateReason   = plan.gateReason;
              row.entry        = plan.entry;
              row.sl           = plan.sl;
              row.t1           = plan.t1;
              row.t2           = plan.t2;
              row.rr           = plan.rr;
              row.holding      = plan.holding;
              row.monthlyStage = plan.monthlyStage ? plan.monthlyStage.key : null;
              row.rsPp         = plan.rsPp != null ? Math.round(plan.rsPp * 100) / 100 : null;
              row.triggers     = (plan.triggers || []).map(function (t) {
                return { type: t.type, style: t.style, short: t.short, score: t.score };
              });
            } else {
              row.ok = false;
              row.error = (plan && plan.reason) || 'no plan';
              if (plan && plan.skipped) row.skipped = true;
              if (plan && plan.insufficientHistory) row.insufficientHistory = true;
              if (plan && isFinite(plan.price)) row.price = plan.price;
            }
          }
        } catch (e) {
          row.ok = false;
          row.error = (e && e.message) || String(e);
          // Throttle failures are transient — flag them so they read as
          // "rate-limited" (re-scan recovers them) rather than a genuine
          // data/analysis failure.
          if (e && e._throttled) row.rateLimited = true;
        }
        verdicts.push(row);
        done++;
        if (onProgress) {
          try { onProgress(done, total, row); } catch (_) { /* swallow */ }
        }
      }
    }

    // Turn on ride-out ONLY for the worker pool: every fetchTf inside the
    // scan now waits out the full Upstox cooldown instead of failing a row
    // at the 30s wait cap (see swScanRideOutThrottle). try/finally guarantees
    // the flag is cleared even if a worker throws, so the single-stock and
    // chart fetch paths immediately revert to fast-fail behaviour.
    var workers = [];
    swScanRideOutThrottle = true;
    try {
      for (var i = 0; i < SW_BULK_CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
    } finally {
      swScanRideOutThrottle = false;
    }

    // Persist freshly-discovered "too new" names so future scans skip
    // them (until the re-check cooldown lapses). Runs in both full-scan
    // and retry mode: a name that was rate-limited last time can come
    // back this time as a genuine insufficient-history result, and we
    // want to capture that too. Best-effort — a storage failure must
    // never break the scan.
    try {
      var _tnMap = swLoadTooNew();
      var _tnChanged = false;
      verdicts.forEach(function (v) {
        if (!v.ok && v.insufficientHistory && swMarkTooNew(_tnMap, v)) _tnChanged = true;
      });
      if (_tnChanged) swSaveTooNew(_tnMap);
    } catch (_) { /* tolerated */ }

    // BUY verdicts first (sorted by confluence desc), then WAIT, then
    // AVOID, then failures. Within each band, highest score first.
    // This matches the order a trader scans the file in — open the
    // JSON, the top of the list IS today's top setups. (2026-05-30:
    // GATED / LEADER bands removed — signals are pure-rules now.)
    _swRankVerdicts(verdicts);

    var _counts   = _swCountVerdicts(verdicts);
    var succeeded = _counts.succeeded;
    var skipped   = _counts.skipped;
    var failed    = _counts.failed;
    var buyCount  = _counts.buyCount;
    var waitCount = _counts.waitCount;
    var avoidCount = _counts.avoidCount;

    return {
      schemaVersion: 1,
      computedAt: new Date().toISOString(),
      computedAtIST: new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }) + ' IST',
      universeSize: total,
      succeeded: succeeded,
      failed: failed,
      skipped: skipped,
      insufficientHistory: _counts.insufficientHistory,
      excludedTooNew: excludedTooNew,
      minPrice: scanBand.min,
      maxPrice: scanBand.max,
      scanTf: scanTf,
      scanScope: scope,
      scanScopeName: scopeName,
      buyCount: buyCount,
      waitCount: waitCount,
      avoidCount: avoidCount,
      regime: regime ? {
        regime:   regime.regime,
        lastClose: regime.lastClose,
        dma50:    regime.dma50,
        distPct:  regime.distPct,
        slopePct: regime.slopePct
      } : null,
      verdictMode: verdictMode || null,
      verdicts: verdicts
    };
  }

  // ── Today's verdicts: localStorage persistence ──
  // The compute pipeline produces a ~600 KB JSON. Browsers can't
  // write arbitrary file paths (sandbox), so the JSON download was
  // originally the only "save" path — and it forced the user to
  // manually move the file into data/. localStorage solves that:
  // the payload lives in the browser, every consumer (Today's
  // Setups tile, BUY-only filter, etc.) reads from here. The JSON
  // download is kept as an OPTIONAL backup ("Export JSON") for
  // users who want a file to commit / share / archive.
  //
  // Quota: localStorage gives ~5–10 MB per origin in every modern
  // browser. A full universe payload is well under 1 MB so the
  // primary save path almost always succeeds; if it doesn't, we
  // re-try with the heavy `triggers` field stripped (UI doesn't
  // use it). Last-ditch failure surfaces to the handler which logs
  // a non-fatal warning — the download still happens as before.
  var SW_VERDICTS_LOCAL_KEY = 'sw_verdicts_today_v1';

  // ── "Too new" skip-list ───────────────────────────────────────────
  // Stocks a scan classified as insufficientHistory (newly listed / not
  // enough candles to analyze). They CANNOT produce a valid signal yet,
  // so we drop them from future scans — no point burning API calls +
  // re-cluttering the results with names that will just fail again.
  //
  // NOT a permanent blacklist. A newly-listed stock accrues ~1 weekly
  // bar per week, so it WILL eventually clear the scan minimum. Each
  // entry carries an `addedAt` timestamp and is auto-rechecked after
  // SW_TOO_NEW_COOLDOWN_MS: once expired it falls back into the
  // universe and gets re-evaluated. Permanently excluding it would
  // silently lose coverage of a maturing name — exactly the kind of
  // hidden gap the trading rules say to avoid. The user can also wipe
  // the whole list manually (Clear button in the scan actions row).
  var SW_TOO_NEW_KEY = 'sw_too_new_v1';
  var SW_TOO_NEW_COOLDOWN_MS = 45 * 24 * 60 * 60 * 1000; // ~45 days → re-check

  function swLoadTooNew() {
    try {
      var raw = localStorage.getItem(SW_TOO_NEW_KEY);
      if (!raw) return {};
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (_) { return {}; }
  }
  function swSaveTooNew(map) {
    try { localStorage.setItem(SW_TOO_NEW_KEY, JSON.stringify(map || {})); return true; }
    catch (_) { return false; }
  }
  // Active = added within the cooldown window. Expired entries are NOT
  // active, so the next scan re-includes + re-checks them.
  function swIsTooNewActive(isin, map) {
    if (!isin) return false;
    map = map || swLoadTooNew();
    var e = map[isin];
    if (!e) return false;
    return (Date.now() - (+e.addedAt || 0)) < SW_TOO_NEW_COOLDOWN_MS;
  }
  // Stamp a stock too-new (or refresh its timestamp if a re-checked name
  // failed the history gate again). Mutates `map`; returns true if changed.
  function swMarkTooNew(map, row) {
    if (!map || !row || !row.isin) return false;
    map[row.isin] = {
      sym: row.sym || '', name: row.name || '',
      reason: row.error || '', addedAt: Date.now()
    };
    return true;
  }
  // Count only ACTIVE (still-in-cooldown) entries — what's actually
  // being excluded from the next scan.
  function swCountTooNewActive(map) {
    map = map || swLoadTooNew();
    var now = Date.now(), n = 0;
    Object.keys(map).forEach(function (k) {
      if ((now - (+map[k].addedAt || 0)) < SW_TOO_NEW_COOLDOWN_MS) n++;
    });
    return n;
  }
  // Wipe the skip-list so every "too new" name re-enters the next scan.
  window.swingClearTooNew = function () {
    var n = swCountTooNewActive();
    if (n > 0 && typeof window.confirm === 'function'
        && !window.confirm('Clear the too-new skip-list (' + n + ' name'
          + (n === 1 ? '' : 's') + ')? They will be scanned again on the next run.')) {
      return;
    }
    swSaveTooNew({});
    try { renderTodaySetups(); } catch (_) {}
    var status = document.getElementById('sw-verdicts-tool-status');
    if (status) {
      status.hidden = false;
      status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-done';
      status.textContent = 'Too-new skip-list cleared \u2014 ' + n
        + ' name' + (n === 1 ? '' : 's') + ' will be re-scanned on the next run.';
    }
  };

  function swingSaveVerdictsLocal(payload) {
    if (!payload) return false;
    try {
      localStorage.setItem(SW_VERDICTS_LOCAL_KEY, JSON.stringify(payload));
      return true;
    } catch (_) {
      try {
        var slim = Object.assign({}, payload, {
          verdicts: (payload.verdicts || []).map(function (v) {
            var out = Object.assign({}, v);
            delete out.triggers;
            return out;
          })
        });
        localStorage.setItem(SW_VERDICTS_LOCAL_KEY, JSON.stringify(slim));
        return true;
      } catch (_) { return false; }
    }
  }

  function swingLoadVerdictsLocal() {
    try {
      var raw = localStorage.getItem(SW_VERDICTS_LOCAL_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (!p || !Array.isArray(p.verdicts)) return null;
      return p;
    } catch (_) { return null; }
  }

  function swingClearVerdictsLocal() {
    try { localStorage.removeItem(SW_VERDICTS_LOCAL_KEY); } catch (_) {}
  }

  // ── Today's Setups tile ──
  // Paints the #sw-today-setups host on the swing landing page
  // with one of two states: empty (no compute has run yet) or
  // populated (localStorage has a verdicts payload). Idempotent
  // — safe to call from first paint, after compute, after delete.
  //
  // Populated state shows the top BUY rows only (max
  // SW_TODAY_MAX_ROWS). Re-compute and Export sit in the header
  // strip, not as separate cards. Clicking any row opens the
  // analyzer for that stock via swingPickSectorStock — same
  // entry point a sector tile uses.
  var SW_TODAY_MAX_ROWS = 50;
  var SW_VERDICT_MODE_KEY = 'sw_verdict_mode_v1';

  // One-line, plain-SMC explanation of each scan mode, shown under the
  // toggle so the labels aren't opaque (FIB / ZOI / A-GRADE alone don't
  // tell you what they screen for). Uses the same vocabulary the app
  // teaches elsewhere: golden pocket / OTE, demand zone, LIQ sweep, FVG,
  // BOS/trend, volume. Updated live by swingSetVerdictMode().
  var SW_VERDICT_MODE_DESC = {
    FIB:     'FIB \u2014 signals only when price is inside the 61.8\u201380% Fib golden pocket (OTE discount zone).',
    ZOI:     'ZOI \u2014 signals only when price is at a fresh demand/supply zone (institutional order block).',
    FIB_ZOI: 'FIB + ZOI \u2014 signals only when a demand/supply zone overlaps the golden pocket at the same price (confluence).'
  };
  // Display order of the scan-mode buttons (the two location-only
  // lenses, then the FIB+ZOI confluence workhorse) + their short button
  // labels. The toggle is built from these so every mode gets its
  // description line (from SW_VERDICT_MODE_DESC) automatically.
  var SW_VERDICT_MODE_ORDER = ['FIB', 'ZOI', 'FIB_ZOI'];
  var SW_VERDICT_MODE_LABEL = {
    FIB: 'FIB', ZOI: 'ZOI', FIB_ZOI: 'FIB + ZOI'
  };

  // Single source of truth for the "Scan mode:" row (label + toggle +
  // live description). Used by BOTH the empty and populated states of
  // Today's Setups so the button set never drifts between them. Build
  // the buttons from SW_VERDICT_MODE_ORDER so adding/renaming a mode is
  // a one-line change in the constants above.
  function swingModeRowHtml() {
    var savedMode = swingGetVerdictMode();
    var btns = SW_VERDICT_MODE_ORDER.map(function (m) {
      var isAct = savedMode === m;
      // No title tooltip — the active mode's description is always
      // shown on the .sw-today-mode-desc line below, so a hover
      // tooltip would just duplicate it.
      return '<button type="button" class="sw-today-mode-btn'
        + (isAct ? ' active' : '') + '"'
        + ' data-mode="' + m + '" onclick="swingSetVerdictMode(\'' + m + '\')" role="radio"'
        + ' aria-checked="' + (isAct ? 'true' : 'false') + '">'
        + SW_VERDICT_MODE_LABEL[m] + '</button>';
    }).join('');
    // Scan timeframe toggle (2026-05-30). Picks WHICH candles the same
    // rules run on. Changing it only re-renders (and surfaces a "re-
    // compute to apply" hint) — the saved scan is left intact until the
    // user explicitly re-computes, so a stray click never wipes results.
    var savedTf = swingGetScanTf();
    var tfBtns = ['1mo', '1w', '1d'].map(function (t) {
      var isAct = savedTf === t;
      return '<button type="button" class="sw-today-mode-btn'
        + (isAct ? ' active' : '') + '"'
        + ' data-scantf="' + t + '" onclick="swingSetTodayScanTf(\'' + t + '\')" role="radio"'
        + ' aria-checked="' + (isAct ? 'true' : 'false') + '">'
        + SW_TF_LABEL[t] + '</button>';
    }).join('');
    return '<div class="sw-today-mode-row">'
      + '<span class="sw-today-mode-label">Scan scope:</span>'
      + swingScopeSelectHtml()
      + '<div class="sw-today-mode-desc">Scan one sector/index instead of the whole market \u2014 far fewer API calls and finishes in a minute or two. <strong>All NSE/BSE</strong> is the full ~20\u201330 min run.</div>'
      + '</div>'
      + '<div class="sw-today-mode-row">'
      + '<span class="sw-today-mode-label">Scan mode:</span>'
      + '<div class="sw-today-mode-toggle" role="radiogroup" aria-label="Recommendation scan mode">'
      + btns
      + '</div>'
      + '<div class="sw-today-mode-desc" id="sw-today-mode-desc">'
      + (SW_VERDICT_MODE_DESC[savedMode] || '') + '</div>'
      + '</div>'
      + '<div class="sw-today-mode-row">'
      + '<span class="sw-today-mode-label">Scan TF:</span>'
      + '<div class="sw-today-mode-toggle" role="radiogroup" aria-label="Scan timeframe">'
      + tfBtns
      + '</div>'
      + '<div class="sw-today-mode-desc">Signal, trend, structure &amp; R:R are computed on this timeframe \u2014 change it, then <strong>Compute</strong> to apply.</div>'
      + '</div>';
  }

  // Active label filter for the Today's Setups table. One of:
  // 'ALL' (default — show every row), 'BUY', 'WAIT', 'AVOID',
  // 'FAILED' (transient / rate-limited), 'NODATA' (newly listed —
  // too little history), 'SKIPPED' (price band). In-memory only.
  var _swTodayFilter = 'ALL';

  // Free-text search for the Today's Setups table — matches symbol +
  // company name (same behaviour as the per-sector search). In-memory
  // only (resets on reload); combines with the active label filter.
  var _swTodaySearch = '';

  // Active setup-column filter for the Today's Setups table. 'ALL'
  // (default) or one of the distinct setup tokens present in the current
  // scan — e.g. 'FIB: IN POCKET RISING', 'ZOI: AT DEMAND' (verdict mode)
  // or a trigger label like 'Pullback + Breakout' (legacy/score mode).
  // The option list is DERIVED from the rendered rows (see swSetupTokens
  // / swCollectSetups) so it can never offer a setup that isn't present.
  // In-memory only (resets on reload); combines with the label filter
  // AND the free-text search (all three stack).
  var _swTodaySetup = 'ALL';

  // Full catalogs of every FIB class / ZOI position the classifiers can
  // emit (see fibClass assignments ~7340-7357 / 11244-11252 and zoiPos
  // returns ~11157-11281). Ordered roughly best-buy → worst so the menu
  // reads top-to-bottom from "act on this" to "avoid". Used to render the
  // FULL setup catalog in verdict-mode scans — entries not present in the
  // current scan show a greyed (0). MUST stay in sync with the classifier;
  // any present-but-uncatalogued token is appended as a safety net so a
  // real value is never hidden (see swBuildSetupMenuOptions).
  var SW_FIB_CLASS_CATALOG = [
    'IN_POCKET_RISING',
    'RECOVERED_ABOVE_POCKET',
    'NEAR_ABOVE_POCKET_RISING',
    'BELOW_POCKET_RISING',
    'AT_SWING_LOW_RISING',
    'IN_POCKET_FALLING',
    'BELOW_POCKET_FALLING',
    'AT_SWING_LOW_FALLING',
    'NEAR_ABOVE_POCKET_FALLING',
    'SHALLOW_ABOVE_POCKET',
    'FAR_ABOVE_POCKET',
    'AT_SWING_HIGH'
  ];
  var SW_ZOI_POSITION_CATALOG = [
    'RECOVERED_INTO_DEMAND_RISING',
    'IN_DEMAND_RISING',
    'STACKED_DEMAND_RISING',
    'RECOVERED_ABOVE_DEMAND_RISING',
    'NEAR_ABOVE_DEMAND_RISING',
    'IN_DEMAND_CONSOLIDATING',
    'IN_DEMAND_FALLING',
    'NEAR_ABOVE_DEMAND_FALLING',
    'FAR_BELOW_SUPPLY_NEAR_DEMAND',
    'FAR_BELOW_SUPPLY_ABOVE_DEMAND',
    'FAR_ABOVE_DEMAND',
    'BROKE_ABOVE_SUPPLY_RISING',
    'BROKE_ABOVE_SUPPLY_FALLING',
    'NEAR_BELOW_SUPPLY',
    'IN_SUPPLY_RISING',
    'IN_SUPPLY_CONSOLIDATING',
    'IN_SUPPLY_FALLING',
    'FAR_ABOVE_SUPPLY',
    'BROKE_BELOW_DEMAND',
    'BETWEEN_ZONES'
  ];

  // ── ZOI position → display label (DISPLAY ONLY) ─────────────────────────
  // The classifier enum names are the matching keys for verdict-rules.json,
  // the conviction maps (_CONV_ZOI) and the per-rule matcher — so they are
  // NEVER renamed here. A couple read misleadingly when shown verbatim:
  // FAR_BELOW_SUPPLY_ABOVE_DEMAND is emitted ONLY when NO demand zone
  // survives below price (noDemand:true) — printing "ABOVE DEMAND" wrongly
  // implies a demand floor is present. Its sibling _NEAR_DEMAND is the
  // opposite (a demand floor DOES exist below). This map relabels just those
  // two and is applied UNIFORMLY to the three places this text surfaces — the
  // scan SETUP badge, the setup-filter tokens (swSetupTokens) and the filter
  // dropdown (swBuildSetupMenuOptions) — so all three still produce the SAME
  // string and filter equality keeps matching. Any code not in the map falls
  // back to the original underscores→spaces transform (fail safe).
  var SW_ZOI_DISPLAY_LABEL = {
    FAR_BELOW_SUPPLY_ABOVE_DEMAND: 'FAR BELOW SUPPLY \u00b7 NO DEMAND BELOW',
    FAR_BELOW_SUPPLY_NEAR_DEMAND:  'FAR BELOW SUPPLY \u00b7 DEMAND BELOW'
  };
  function swZoiPosLabel(position) {
    if (!position) return '';
    return SW_ZOI_DISPLAY_LABEL[position] || String(position).replace(/_/g, ' ');
  }

  // Build the dropdown's option list. In a verdict-mode scan (FIB / ZOI /
  // FIB_ZOI) we show the FULL catalog for the active mode(s) — every
  // possible setup, in a stable logical order, with counts from the
  // current scan (0 → greyed). This keeps the list predictable so a
  // setup like IN_DEMAND_RISING is always visible even when no stock is
  // in it today. Legacy/score-mode setups are open-ended trigger combos
  // that can't be enumerated, so those stay data-driven (present only).
  // Each option: { key, label, count, group } where group is 'FIB'/'ZOI'
  // (verdict mode) or '' (legacy).
  function swBuildSetupMenuOptions(payload, presentOptions) {
    var countMap = Object.create(null);
    for (var i = 0; i < presentOptions.length; i++) {
      countMap[presentOptions[i].key] = presentOptions[i].count;
    }
    var mode = payload && payload.verdictMode;
    if (mode !== 'FIB' && mode !== 'ZOI' && mode !== 'FIB_ZOI') {
      return presentOptions.map(function (o) {
        return { key: o.key, label: o.key, count: o.count, group: '' };
      });
    }
    var out = [], seen = Object.create(null);
    function pushGroup(prefix, group, rawList) {
      for (var j = 0; j < rawList.length; j++) {
        // ZOI codes go through swZoiPosLabel (same relabel the badge + tokens
        // use) so the dropdown option string matches the row token exactly.
        var key = prefix + (group === 'ZOI' ? swZoiPosLabel(rawList[j]) : rawList[j].replace(/_/g, ' '));
        out.push({ key: key, label: key, count: countMap[key] || 0, group: group });
        seen[key] = true;
      }
    }
    if (mode === 'FIB' || mode === 'FIB_ZOI') pushGroup('FIB: ', 'FIB', SW_FIB_CLASS_CATALOG);
    if (mode === 'ZOI' || mode === 'FIB_ZOI') pushGroup('ZOI: ', 'ZOI', SW_ZOI_POSITION_CATALOG);
    // Safety net: surface any present token the catalog doesn't know about
    // (classifier added a state we forgot to list) rather than hide it.
    for (var k in countMap) {
      if (!seen[k]) out.push({ key: k, label: k, count: countMap[k], group: '' });
    }
    return out;
  }

  // The distinct setup token(s) a verdict row contributes to the
  // setup-column filter. Mirrors EXACTLY what the Setup column renders:
  //   - verdict mode → its FIB class and/or ZOI position, each as its own
  //     token ('FIB: …' / 'ZOI: …'), normalised the same way the badge is
  //     (underscores → spaces). A row with both contributes both tokens,
  //     so filtering by either matches it.
  //   - legacy/score mode → the single trigger label (setupShort).
  // Returns [] when the row has no setup info (so it's excluded from any
  // specific-setup filter but still counted under 'ALL').
  function swSetupTokens(v) {
    if (!v) return [];
    var toks = [];
    if (v.fibClass)    toks.push('FIB: ' + String(v.fibClass).replace(/_/g, ' '));
    if (v.zoiPosition) toks.push('ZOI: ' + swZoiPosLabel(v.zoiPosition));
    if (toks.length) return toks;
    // Legacy/score mode: the trigger label. Skip the em-dash placeholder
    // (WAIT/AVOID rows carry setupShort = '—', which is not a real setup).
    var legacy = v.setupShort || v.setupName || '';
    if (legacy && legacy !== '\u2014') return [legacy];
    return [];
  }

  // Build the ordered, de-duplicated setup-option list for the dropdown
  // from an already label/search-filtered row set. Each option carries a
  // count = how many rows contain that token. Sorted by count desc, then
  // alphabetically, so the most common setups float to the top.
  function swCollectSetups(rows) {
    var counts = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var toks = swSetupTokens(rows[i]);
      for (var j = 0; j < toks.length; j++) {
        counts[toks[j]] = (counts[toks[j]] || 0) + 1;
      }
    }
    var out = [];
    for (var k in counts) out.push({ key: k, count: counts[k] });
    out.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0);
    });
    return out;
  }

  // Bucket a stored verdict row into a single filter category.
  function swVerdictCategory(v) {
    if (!v || !v.ok) {
      if (v && v.skipped) return 'SKIPPED';
      // Newly listed / too little history — non-retryable, own bucket.
      if (v && v.insufficientHistory) return 'NODATA';
      return 'FAILED';
    }
    if (v.action === 'BUY') return 'BUY';
    if (v.action === 'WAIT' || v.action === 'WATCH') return 'WAIT';
    return 'AVOID'; // AVOID / CAUTION / SKIP
  }

  window.swingSetTodayFilter = function (f) {
    _swTodayFilter = f || 'ALL';
    renderTodaySetups();
  };

  // Search-box handler for the Today's Setups table. Stash the query
  // and re-render; focus + caret are restored after the rebuild in
  // renderTodaySetups (same pattern as the per-sector search).
  window.swingTodaySearch = function (text) {
    _swTodaySearch = (text || '').toLowerCase().trim();
    renderTodaySetups();
  };

  // Setup-column filter handler. Receives the raw setup token (or 'ALL')
  // from the clicked menu row. Stacks with the label filter + search.
  // The full re-render closes the menu (the DOM is rebuilt fresh).
  window.swingSetTodaySetup = function (key) {
    _swTodaySetup = key || 'ALL';
    renderTodaySetups();
  };

  // Open / close the custom setup dropdown WITHOUT a full re-render (so it
  // feels instant and doesn't rebuild the whole table just to show a
  // menu). Selecting an option DOES re-render via swingSetTodaySetup.
  window.swingToggleSetupMenu = function (ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    var dd = document.getElementById('sw-setup-dd');
    if (!dd) return;
    var open = dd.classList.toggle('sw-sf-dd--open');
    var btn = document.getElementById('sw-setup-dd-btn');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    // On open, focus the filter input so the user can type immediately.
    if (open) {
      var inp = document.getElementById('sw-setup-dd-search');
      if (inp) { try { inp.focus(); inp.select(); } catch (_) {} }
    }
  };

  // Live in-menu filter for the setup list. Hides non-matching option
  // rows (and any group header left with no visible options) WITHOUT
  // re-rendering — the menu stays open and the table is untouched. The
  // "All setups" reset row is always kept visible. Pure DOM show/hide.
  window.swingSetupMenuSearch = function (text) {
    var menu = document.querySelector('#sw-setup-dd .sw-sf-dd-menu');
    if (!menu) return;
    var q = String(text || '').toLowerCase().trim();
    var opts = menu.querySelectorAll('.sw-sf-dd-opt');
    var visibleSpecific = 0;
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      var isAll = o.getAttribute('data-setup-all') === '1';
      var key = o.getAttribute('data-setup') || '';
      var show = isAll || !q || key.indexOf(q) !== -1;
      o.style.display = show ? '' : 'none';
      if (show && !isAll) visibleSpecific++;
    }
    // Group headers: hide any whose following options are all hidden.
    var heads = menu.querySelectorAll('.sw-sf-dd-head');
    for (var h = 0; h < heads.length; h++) {
      var sib = heads[h].nextElementSibling, anyVisible = false;
      while (sib && !sib.classList.contains('sw-sf-dd-head')) {
        if (sib.classList.contains('sw-sf-dd-opt') && sib.style.display !== 'none') { anyVisible = true; break; }
        sib = sib.nextElementSibling;
      }
      heads[h].style.display = anyVisible ? '' : 'none';
    }
    var empty = menu.querySelector('.sw-sf-dd-empty');
    if (empty) empty.hidden = !(q && visibleSpecific === 0);
  };
  function _swCloseSetupMenu() {
    var dd = document.getElementById('sw-setup-dd');
    if (!dd) return;
    dd.classList.remove('sw-sf-dd--open');
    var btn = document.getElementById('sw-setup-dd-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
  // Outside-click + Escape close the menu. Bound ONCE on the document
  // (guarded), so the repeated innerHTML rebuilds of the setups table
  // never stack duplicate listeners.
  function _swEnsureSetupMenuClose() {
    if (_swEnsureSetupMenuClose._bound) return;
    _swEnsureSetupMenuClose._bound = true;
    document.addEventListener('click', function (e) {
      var dd = document.getElementById('sw-setup-dd');
      if (dd && dd.classList.contains('sw-sf-dd--open') && !dd.contains(e.target)) {
        _swCloseSetupMenu();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') _swCloseSetupMenu();
    });
  }

  // Collapsed state for the Today's Setups card. Purely cosmetic — lets
  // the user fold the (tall) scan table down to just its header summary
  // (BUY/WAIT/AVOID counts + actions) to get the sector grid / analyzer
  // below back into view. Persisted in localStorage so the preference
  // survives reloads. Default = expanded.
  var SW_TODAY_COLLAPSE_KEY = 'sw_today_collapsed_v1';
  function swTodayIsCollapsed() {
    try { return localStorage.getItem(SW_TODAY_COLLAPSE_KEY) === '1'; }
    catch (_) { return false; }
  }
  window.swingToggleTodayCollapse = function () {
    var next = !swTodayIsCollapsed();
    try { localStorage.setItem(SW_TODAY_COLLAPSE_KEY, next ? '1' : '0'); }
    catch (_) {}
    renderTodaySetups();
  };

  // ── Recommendation-basis mode (CHART CARD ONLY) ──────────────────
  // The signal/verdict card below the chart has its OWN basis selector,
  // completely independent of the scan's verdict mode (SW_VERDICT_MODE_KEY).
  // Scanning only decides WHICH stocks to surface; HOW the recommendation
  // is computed for the open chart is the user's live choice here. Stored
  // under its own key so the two never interfere. Default FIB (pocket-only).
  var SW_RECO_MODE_KEY = 'sw_reco_mode_v1';
  var SW_RECO_MODE_DESC = {
    FIB:     'Signals only when price is inside the 61.8\u201380% Fib golden pocket (the OTE discount zone).',
    ZOI:     'Signals only when price is at a fresh demand / supply zone (an institutional order block).',
    FIB_ZOI: 'Signals only when a Fib golden pocket and a demand / supply zone overlap at the same price (confluence) \u2014 otherwise it waits.'
  };
  function swGetRecoMode() {
    try {
      var m = localStorage.getItem(SW_RECO_MODE_KEY);
      return (m === 'FIB' || m === 'ZOI' || m === 'FIB_ZOI') ? m : 'FIB';
    } catch (_) { return 'FIB'; }
  }
  // Reflect the active basis on the segmented control + description line
  // (no-op if the banner isn't in the DOM yet — content/swing.html is
  // lazy-loaded).
  function _swSyncRecoModeButtons(mode) {
    var btns = document.querySelectorAll('.sw-reco-mode-btn[data-reco]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-reco') === mode;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    var desc = document.getElementById('sw-reco-mode-desc');
    if (desc && SW_RECO_MODE_DESC[mode]) desc.textContent = SW_RECO_MODE_DESC[mode];
  }
  window.swSetRecoMode = function (mode) {
    if (mode !== 'FIB' && mode !== 'ZOI' && mode !== 'FIB_ZOI') return;
    try { localStorage.setItem(SW_RECO_MODE_KEY, mode); } catch (_) {}
    _swSyncRecoModeButtons(mode);
    // Re-render the chart PANEL so the analysis cards (Fib retracement /
    // supply-demand zones) AND the verdict re-evaluate on the new basis.
    // Mirrors swToggleInd — no scan, no chart-overlay (legend-chip) change.
    // renderMainChart repaints the verdict itself (swPaintVerdict at its end).
    try {
      if (STATE.chart && typeof renderMainChart === 'function') {
        renderMainChart(STATE.chartTf || '1d');
      } else {
        swPaintVerdict(swComputeVerdictForTf(swGetRecoTf()));
        _swRelocateSignalDetail();
        // No chart → re-render the plan cards here so the SETUP card's levels
        // + mode badge re-evaluate on the newly selected basis.
        if (typeof swRenderBothPlanCards === 'function') swRenderBothPlanCards();
      }
    } catch (_) {}
  };
  window.swGetRecoMode = swGetRecoMode;

  // ── Trade-plan ENGINE toggle — REMOVED 2026-06-05 ──
  // The legacy A/B engine (A = STRUCTURE / R.plan, B = SETUP / swBuildSetupPlan)
  // was retired. The UI segmented control was already deleted earlier; the
  // wiring fix made the chart, the SETUP card, and the trade plan all read ONE
  // producer (swSetupPlanForRender → swBuildSetupPlan, mode-driven), and the
  // STRUCTURE card always shows R.plan as context. With a single source there is
  // no "engine" to pick, so swGetPlanEngine / swSetPlanEngine / the localStorage
  // key (sw_plan_engine_v1) and the button-sync helper were all dead and removed.

  // ── Recommendation TIMEFRAME (independent of the chart TF) ──
  // 2026-06-01: the recommendation verdict + analysis cards (Fib /
  // ZOI) are driven by THIS selector, NOT the chart's TF buttons. The
  // chart TF is now purely "the picture" — flipping it re-skins the
  // candles + chart overlays but never changes the verdict. Default is
  // Weekly (the primary swing horizon). Selectable TFs are
  // SW_RECO_TF_SELECTABLE (1mo/1w/1d/4h/1h signalled + 30m/15m/5m
  // cards-only, no buy/sell signal).
  var SW_RECO_TF_KEY = 'sw_reco_tf_v2';
  function swGetRecoTf() {
    try {
      var t = localStorage.getItem(SW_RECO_TF_KEY);
      return (t && SW_RECO_TF_SELECTABLE[t]) ? t : '1d';
    } catch (_) { return '1d'; }
  }
  // Reflect the active reco TF on its segmented control (no-op until the
  // lazy-loaded content/swing.html banner is in the DOM).
  function _swSyncRecoTfButtons(tf) {
    var btns = document.querySelectorAll('.sw-reco-tf-btn[data-recotf]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-recotf') === tf;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }
  window.swSetRecoTf = function (tf) {
    if (!SW_RECO_TF_SELECTABLE[tf]) return;
    try { localStorage.setItem(SW_RECO_TF_KEY, tf); } catch (_) {}
    _swSyncRecoTfButtons(tf);
    if (!STATE.result) return;
    // Ensure the reco TF's candles are loaded (4h is lazy), THEN repaint.
    // Bidirectional TF lock (2026-06): the chart TF and the recommendation
    // TF are mirrored — changing the reco TF re-renders the chart ON THAT
    // SAME TF (not the old chart TF), so the on-chart overlay and the
    // cards/verdict always share one timeframe. renderMainChart persists +
    // reflects the reco control too, closing the loop from the chart-TF side.
    var repaint = function () {
      try {
        if (STATE.chart && typeof renderMainChart === 'function') {
          // renderMainChart re-renders both plan cards itself (see its tail).
          renderMainChart(tf);
        } else {
          swPaintVerdict(swComputeVerdictForTf(tf));
          _swRelocateSignalDetail();
          // No chart present → re-render the plan cards here so the SETUP
          // card's TF-native levels still track the picker.
          if (typeof swRenderBothPlanCards === 'function') swRenderBothPlanCards();
        }
      } catch (_) {}
    };
    var have = STATE.result.candles && STATE.result.candles[tf] && STATE.result.candles[tf].length;
    if (have) { repaint(); return; }
    if (typeof getRawForTf === 'function') {
      getRawForTf(tf).then(repaint).catch(repaint);
    } else {
      repaint();
    }
  };
  window.swGetRecoTf = swGetRecoTf;

  function swingGetVerdictMode() {
    try {
      var m = localStorage.getItem(SW_VERDICT_MODE_KEY);
      // Fall back to the default if the stored mode was retired (the
      // 2026-05-30 noise trim removed ZOI_LIQ / FIB_FVG / FIB_ZOI_FVG,
      // then AGRADE/BEST too).
      // A stale value would leave no active button and compute with
      // neither layer enabled — so validate against the live set.
      return (m && SW_VERDICT_MODE_ORDER.indexOf(m) !== -1) ? m : 'FIB_ZOI';
    } catch (_) { return 'FIB_ZOI'; }
  }
  window.swingSetVerdictMode = function (mode) {
    try { localStorage.setItem(SW_VERDICT_MODE_KEY, mode); } catch (_) {}
    // Scope to mode buttons only — the Scan-TF buttons share the
    // .sw-today-mode-btn class but carry data-scantf, not data-mode.
    var btns = document.querySelectorAll('.sw-today-mode-btn[data-mode]');
    for (var i = 0; i < btns.length; i++) {
      var isActive = btns[i].dataset.mode === mode;
      btns[i].classList.toggle('active', isActive);
      btns[i].setAttribute('aria-checked', isActive ? 'true' : 'false');
    }
    var desc = document.getElementById('sw-today-mode-desc');
    if (desc) desc.textContent = SW_VERDICT_MODE_DESC[mode] || '';
    // A mode change vs the saved scan should surface the "re-compute to
    // apply" hint in the meta line — re-render to reflect it.
    if (typeof renderTodaySetups === 'function') renderTodaySetups();
  };
  window.swingGetVerdictMode = swingGetVerdictMode;

  // Scan timeframe toggle handler. Persists the choice and re-renders
  // (does NOT re-run the scan — the saved results stay until Compute).
  window.swingSetTodayScanTf = function (tf) {
    swingSetScanTf(tf);
    if (typeof renderTodaySetups === 'function') renderTodaySetups();
  };
  window.swingGetScanTf = swingGetScanTf;

  // Cached size of the scannable universe — curated sectors + indices
  // UNIONed with the full NSE instruments index, deduped by ISIN (the
  // exact same set swingComputeAllVerdicts iterates). Computed once and
  // cached; rendered into #sw-universe-stat by swingRenderUniverseStat().
  var _swUniverseSize = null;
  async function swingEnsureUniverseSize() {
    if (_swUniverseSize != null) return _swUniverseSize;
    var seen = Object.create(null);
    try {
      var sd = await loadSectors();
      (sd.sectors || []).forEach(function (sec) {
        (sec.stocks || []).forEach(function (st) { if (st.isin) seen[st.isin] = 1; });
      });
      (sd.indices || []).forEach(function (idx) {
        (idx.stocks || []).forEach(function (st) { if (st.isin) seen[st.isin] = 1; });
      });
    } catch (_) { /* curated load failed — index alone still counts */ }
    try {
      var ix = await loadInstrumentsIndex();
      if (ix && ix.stocks) {
        Object.keys(ix.stocks).forEach(function (sym) {
          var pair = ix.stocks[sym];
          if (pair && pair[0]) seen[pair[0]] = 1;
        });
      }
    } catch (_) { /* index failed — curated count still shows */ }
    _swUniverseSize = Object.keys(seen).length;
    return _swUniverseSize;
  }

  // Cached list of scan-scope groups (curated sectors + indices) that
  // feeds the scope <select> in the mode row. Loaded once from
  // sectors.json; swingScopeSelectHtml() renders from the cache and
  // triggers a single re-render once it resolves (the empty-on-first-
  // paint case). Shape: { sectors:[{id,name,count}], indices:[…] }.
  var _swScanGroups = null;
  var _swScanGroupsLoading = false;
  async function swingEnsureScanGroups() {
    if (_swScanGroups) return _swScanGroups;
    var out = { sectors: [], indices: [], screens: [] };
    try {
      var sd = await loadSectors();
      (sd.sectors || []).forEach(function (sec) {
        if (sec && sec.id) out.sectors.push({ id: sec.id, name: sec.name || sec.id, count: (sec.stocks || []).length });
      });
      // Band-carrying groups are curated SCREENS (High Liquidity), bucketed
      // separately from true NSE-index benchmarks so the scope picker labels
      // them honestly (mirrors the grid's "Liquidity Screen" row).
      (sd.indices || []).forEach(function (idx) {
        if (!idx || !idx.id) return;
        var bucket = idx.band ? out.screens : out.indices;
        bucket.push({ id: idx.id, name: idx.name || idx.id, count: (idx.stocks || []).length });
      });
    } catch (_) { /* tolerated — only the "All" option will render */ }
    _swScanGroups = out;
    return out;
  }

  // Build the scope picker for the mode row. This is a CUSTOM dropdown
  // (button + in-flow menu), NOT a native <select> — macOS Chrome renders
  // the native <option> popup with the OS appearance and ignores CSS
  // color-scheme / option colours, so a native control can't be made to
  // match the app theme. The custom menu is plain divs/buttons styled with
  // the app's CSS tokens, so it matches light/dark exactly. It expands
  // IN FLOW (full-width line below the button) rather than absolutely, so
  // it isn't clipped by the populated card's `overflow:hidden`.
  //
  // Renders synchronously from the cache; if the cache isn't warm yet it
  // shows only the "All" option and kicks off a one-shot load → re-render
  // so the sector/index options appear a beat later. The "(n)" suffix is
  // the group's raw member count (pre price-band).
  function swingScopeSelectHtml() {
    var scope = swingGetScanScope();
    var groups = _swScanGroups;
    if (!groups && !_swScanGroupsLoading) {
      _swScanGroupsLoading = true;
      swingEnsureScanGroups().then(function () {
        _swScanGroupsLoading = false;
        if (typeof renderTodaySetups === 'function') renderTodaySetups();
      });
    }
    // Current selection label for the button face.
    var curName = 'All NSE/BSE';
    if (scope !== '__all__' && groups) {
      var _cur = (groups.screens || []).concat(groups.indices || [], groups.sectors || [])
        .filter(function (x) { return x.id === scope; })[0];
      if (_cur) curName = _cur.name;
    }
    function optRow(id, name, count, isSel) {
      var idArg = escapeHtml(String(id).replace(/'/g, "\\'"));
      return '<button type="button" class="sw-scope-dd-opt' + (isSel ? ' is-sel' : '') + '"'
        + ' role="option" aria-selected="' + (isSel ? 'true' : 'false') + '"'
        + ' onclick="swingPickScope(\'' + idArg + '\')">'
        + '<span class="sw-scope-dd-opt-name">' + escapeHtml(name)
        + (count != null ? ' <span class="sw-scope-dd-opt-n">(' + count + ')</span>' : '')
        + '</span>'
        + '<span class="sw-scope-dd-opt-check" aria-hidden="true">' + (isSel ? '\u2713' : '') + '</span>'
        + '</button>';
    }
    var items = optRow('__all__', 'All NSE/BSE (full universe)', null, scope === '__all__');
    if (groups && groups.screens && groups.screens.length) {
      items += '<div class="sw-scope-dd-group">Screens</div>';
      groups.screens.forEach(function (g) { items += optRow(g.id, g.name, g.count, scope === g.id); });
    }
    if (groups && groups.indices.length) {
      items += '<div class="sw-scope-dd-group">Indices</div>';
      groups.indices.forEach(function (g) { items += optRow(g.id, g.name, g.count, scope === g.id); });
    }
    if (groups && groups.sectors.length) {
      items += '<div class="sw-scope-dd-group">Sectors</div>';
      groups.sectors.forEach(function (g) { items += optRow(g.id, g.name, g.count, scope === g.id); });
    }
    return '<button type="button" class="sw-scope-dd-btn" id="sw-scope-dd-btn"'
      +   ' aria-haspopup="listbox" aria-expanded="false"'
      +   ' onclick="swingToggleScopeMenu(event)">'
      +   '<span class="sw-scope-dd-cur">' + escapeHtml(curName) + '</span>'
      +   '<span class="sw-scope-dd-chev" aria-hidden="true">\u25BE</span>'
      + '</button>'
      + '<div class="sw-scope-dd-menu" id="sw-scope-dd-menu" role="listbox"'
      +   ' aria-label="Universe slice to scan" hidden>'
      +   items
      + '</div>';
  }

  // Open/close state for the custom scope menu. In-memory only; a tile
  // re-render (which rebuilds the markup) implicitly closes it, and we
  // detach the outside-click/Escape listeners on close so they never leak.
  var _swScopeMenuOpen = false;
  var _swScopeOutsideHandler = null;
  function _swCloseScopeMenu() {
    _swScopeMenuOpen = false;
    var menu = document.getElementById('sw-scope-dd-menu');
    var btn = document.getElementById('sw-scope-dd-btn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (_swScopeOutsideHandler) {
      document.removeEventListener('mousedown', _swScopeOutsideHandler, true);
      document.removeEventListener('keydown', _swScopeOutsideHandler, true);
      _swScopeOutsideHandler = null;
    }
  }
  window.swingToggleScopeMenu = function (e) {
    if (e) { e.stopPropagation(); }
    if (_swScopeMenuOpen) { _swCloseScopeMenu(); return; }
    _swScopeMenuOpen = true;
    var menu = document.getElementById('sw-scope-dd-menu');
    var btn = document.getElementById('sw-scope-dd-btn');
    if (menu) menu.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    // Outside-click + Escape close. Capture phase so it fires before the
    // button's own onclick re-toggles it.
    _swScopeOutsideHandler = function (ev) {
      if (ev.type === 'keydown') { if (ev.key === 'Escape') _swCloseScopeMenu(); return; }
      var m = document.getElementById('sw-scope-dd-menu');
      var b = document.getElementById('sw-scope-dd-btn');
      if ((m && m.contains(ev.target)) || (b && b.contains(ev.target))) return;
      _swCloseScopeMenu();
    };
    document.addEventListener('mousedown', _swScopeOutsideHandler, true);
    document.addEventListener('keydown', _swScopeOutsideHandler, true);
  };
  window.swingPickScope = function (id) {
    _swCloseScopeMenu();
    swingSetScanScope(id);
    // Like the mode/TF toggles, this only re-renders + surfaces the
    // "re-compute to apply" hint — it never auto-runs a scan, so a stray
    // change can't wipe saved results or burn API budget.
    if (typeof renderTodaySetups === 'function') renderTodaySetups();
  };
  window.swingGetScanScope = swingGetScanScope;
  // Render the scannable-universe stat under the sector grid (its own
  // element in content/swing.html, independent of the optional Today's
  // Setups tile). Async — shows the count + active price band once the
  // lazy instruments index resolves. SW_MIN_PRICE / SW_MAX_PRICE are the
  // single source of truth for the band, so the line never drifts.
  function swingRenderUniverseStat() {
    var el = document.getElementById('sw-universe-stat');
    if (!el) return;
    el.textContent = 'Counting universe\u2026';
    swingEnsureUniverseSize().then(function (n) {
      el.innerHTML = 'Scannable universe: <strong>' + n.toLocaleString('en-IN')
        + '</strong> NSE/BSE stocks \u00b7 only \u20B9' + SW_MIN_PRICE.toLocaleString('en-IN')
        + '\u2013\u20B9' + SW_MAX_PRICE.toLocaleString('en-IN')
        + ' priced names are actually scanned';
    }).catch(function () { el.textContent = ''; });
  }

  // Apply an optional price band from data/config.json. Called by the early
  // config loader (window._swApplyConfig) once the fetch resolves. Validates
  // hard and fails safe: a non-numeric, non-positive, or inverted band is
  // ignored so the SW_MIN_PRICE / SW_MAX_PRICE fallback defaults stand —
  // we never let bad config widen the scan band and surface noisy BUYs.
  function _swApplyPriceBand(cfg) {
    var band = cfg && cfg.swing_price_band;
    if (!band) return;
    var mn = Number(band.min), mx = Number(band.max);
    if (!isFinite(mn) || !isFinite(mx) || mn <= 0 || mx <= 0 || mn >= mx) return;
    SW_MIN_PRICE = mn;
    SW_MAX_PRICE = mx;
    try { swingRenderUniverseStat(); } catch (_) {}
    if (typeof renderSectorPanel === 'function') { try { renderSectorPanel(); } catch (_) {} }
  }
  window._swApplyConfig = _swApplyPriceBand;

  function renderTodaySetups() {
    var host = document.getElementById('sw-today-setups');
    if (!host) return;
    var payload = swingLoadVerdictsLocal();
    if (!payload) {
      host.dataset.state = 'empty';
      host.innerHTML = swingTodayEmptyHtml();
      return;
    }
    host.dataset.state = 'populated';
    host.innerHTML = swingTodayPopulatedHtml(payload);
    _swEnsureSetupMenuClose();
    // Restore focus + caret to the search input after the innerHTML
    // rebuild so typing in the search box isn't interrupted.
    if (_swTodaySearch) {
      var inp = host.querySelector('.sw-today-search-input');
      if (inp) { inp.focus(); inp.setSelectionRange(_swTodaySearch.length, _swTodaySearch.length); }
    }
  }

  function swingTodayEmptyHtml() {
    var isCollapsed = swTodayIsCollapsed();
    // The WHOLE top strip is the collapse toggle (not just the chevron) so
    // it's a large, easy click target. Same affordance as the populated
    // state — fold this (tall) intro + scan-mode panel away to bring the
    // sector grid / analyzer below back into view even before any compute
    // has run. Collapsed keeps the badge + title visible so the panel
    // stays discoverable. The chevron is a non-interactive indicator.
    var topRow = ''
      + '<button type="button" class="sw-today-empty-top"'
      +   ' onclick="swingToggleTodayCollapse()"'
      +   ' aria-expanded="' + (isCollapsed ? 'false' : 'true') + '"'
      +   ' title="' + (isCollapsed ? 'Expand the setups panel' : 'Collapse the setups panel') + '">'
      +   '<span class="sw-today-collapse-toggle" aria-hidden="true">'
      +     (isCollapsed ? '\u25B8' : '\u25BE')
      +   '</span>'
      +   '<span class="sw-today-badge">TODAY\u2019S SETUPS</span>'
      +   '<span class="sw-today-title">No recommendations computed yet</span>'
      + '</button>';

    // Collapsed: show only the toggle + badge + title strip, nothing else.
    if (isCollapsed) {
      return ''
        + '<div class="sw-today-header sw-today-header-empty sw-today-header-empty--collapsed">'
        +   topRow
        + '</div>';
    }

    return ''
      + '<div class="sw-today-header sw-today-header-empty">'
      +   topRow
      +   '<div class="sw-today-header-meta">'
      +     '<span class="sw-today-sub">'
      +       'Run the recommendation engine on the full NSE/BSE universe (~20\u201330&nbsp;min) '
      +       'to surface today\u2019s BUY setups. Select a scan mode below, then click Compute.'
      +     '</span>'
      +   '</div>'
      +   '<button type="button" class="sw-today-btn-primary"'
      +     ' id="sw-verdicts-tool-btn"'
      +     ' onclick="swingStartComputeAll()"'
      +     ' aria-describedby="sw-verdicts-tool-status">'
      +     'Compute today\u2019s recommendations'
      +   '</button>'
      + '</div>'
      + swingModeRowHtml()
      + '<div class="sw-today-status sw-verdicts-tool-status"'
      +   ' id="sw-verdicts-tool-status" role="status"'
      +   ' aria-live="polite" hidden></div>';
  }

  function swingTodayPopulatedHtml(payload) {
    var isVerdictMode = !!payload.verdictMode;
    var allVerdicts = payload.verdicts || [];
    var buys = allVerdicts.filter(function (v) {
      return v.ok && v.action === 'BUY';
    });
    // Robust failed tally for the Retry button — fall back to a live
    // count when an older payload predates the `failed` summary field.
    var _failedForBtn = payload.failed != null
      ? payload.failed
      : allVerdicts.filter(function (v) { return !v.ok && !v.skipped && !v.insufficientHistory; }).length;
    // Live count of names currently on the too-new skip-list (excluded
    // from scans until their re-check cooldown lapses). Drives the
    // "Clear too-new" action so the user can force them back in.
    var _tooNewActive = swCountTooNewActive();
    // Apply the active label filter (BUY / WAIT / AVOID / FAILED /
    // SKIPPED / ALL). Rows arrive pre-sorted (BUY → WAIT → AVOID →
    // failed), so a sliced view stays in sensible order.
    var activeFilter = _swTodayFilter || 'ALL';
    var filtered = activeFilter === 'ALL'
      ? allVerdicts.slice()
      : allVerdicts.filter(function (v) { return swVerdictCategory(v) === activeFilter; });
    // Free-text search — matches symbol OR company name (case-insensitive).
    // Applied on top of the label filter so the two combine.
    var searchQ = _swTodaySearch || '';
    if (searchQ) {
      filtered = filtered.filter(function (v) {
        var sym  = String(v.sym  || '').toLowerCase();
        var name = String(v.name || '').toLowerCase();
        return sym.indexOf(searchQ) !== -1 || name.indexOf(searchQ) !== -1;
      });
    }
    // Setup-column filter. Options are derived from the rows that survive
    // the label + search filters (so the dropdown always reflects the
    // current context), THEN the chosen setup is applied as the third,
    // independent stage. Keeping the option list pre-setup-filter means
    // switching between setups never makes the other options disappear.
    var setupOptions = swCollectSetups(filtered);
    var setupBaseCount = filtered.length;
    // Verdict-mode scans render the full setup catalog (with greyed 0s);
    // legacy scans stay data-driven. Counts come from the present rows.
    var setupMenuOptions = swBuildSetupMenuOptions(payload, setupOptions);
    var activeSetup = _swTodaySetup || 'ALL';
    if (activeSetup !== 'ALL') {
      filtered = filtered.filter(function (v) {
        return swSetupTokens(v).indexOf(activeSetup) !== -1;
      });
    }
    var top = filtered.slice(0, SW_TODAY_MAX_ROWS);

    // Age — relative ("3h ago") helps the user judge freshness at
    // a glance; the IST timestamp underneath is the source of truth.
    var ageStr = '', ageWarn = false;
    try {
      var ms = new Date(payload.computedAt).getTime();
      if (isFinite(ms)) {
        var diffHr = (Date.now() - ms) / 3600000;
        if (diffHr < 1) {
          var diffMin = Math.max(0, Math.round(diffHr * 60));
          ageStr = diffMin <= 1 ? 'just now' : diffMin + 'm ago';
        } else if (diffHr < 24) {
          ageStr = Math.round(diffHr) + 'h ago';
        } else {
          var days = Math.floor(diffHr / 24);
          ageStr = days + 'd ago';
          if (days >= 1) ageWarn = true;
        }
      }
    } catch (_) {}

    var regimeTxt = 'Regime: unknown';
    var regimeCls = 'sw-today-regime-neutral';
    // Plain-language explanation of the broad-market regime — what it
    // is (Nifty 50 vs its 50-day moving average + that average's slope)
    // and how it steers the BUY gate. Shown as a hover tooltip on the
    // regime chip. Value-specific so BEAR explains why longs are blocked.
    var _regKey = (payload.regime && payload.regime.regime) || 'UNKNOWN';
    var _regDist = (payload.regime && isFinite(payload.regime.distPct))
      ? (payload.regime.distPct >= 0 ? '+' : '') + payload.regime.distPct.toFixed(1) + '%' : null;
    var _regNum = _regDist ? ' (Nifty is ' + _regDist + ' vs its 50-DMA)' : '';
    var REGIME_TIP = {
      BULL:    'Market regime = BULL.\nNifty 50 is ABOVE its 50-day moving average and that average is RISING' + _regNum + '.\nThe broad-market tide is up — this is the tailwind new long (BUY) setups want.',
      BEAR:    'Market regime = BEAR.\nNifty 50 is BELOW its 50-day moving average and that average is FALLING' + _regNum + '.\nThe broad-market tide is down — a headwind for new longs, since most stocks fall when the index falls. This NO LONGER blocks a BUY signal (signals are pure-rules now); it is shown in each setup\u2019s Risk Context so you can weigh it before acting.',
      NEUTRAL: 'Market regime = NEUTRAL.\nNifty 50 and its 50-day moving average disagree — price and slope are not both up or both down' + _regNum + '.\nNo clear broad-market tide. Longs are allowed but get no regime tailwind.',
      UNKNOWN: 'Market regime = UNKNOWN.\nCould not fetch Nifty 50 daily history to classify the broad market, so the regime gate was skipped for this scan.'
    };
    var regimeTip = REGIME_TIP[_regKey] || REGIME_TIP.UNKNOWN;
    if (payload.regime && payload.regime.regime) {
      regimeTxt = 'Regime: ' + payload.regime.regime;
      regimeCls = 'sw-today-regime-' + payload.regime.regime.toLowerCase();
    }

    // Badge label reflects actual scan age — avoid calling stale data "TODAY'S"
    var badgeLabel = ageWarn
      ? (ageStr === '1d ago' ? 'YESTERDAY\u2019S SETUPS' : 'SETUPS \u00B7 ' + ageStr.toUpperCase())
      : 'TODAY\u2019S SETUPS';

    // Pause/Resume feeds toggle — only when the options module's master
    // toggle is available. Lets the user kill every live Upstox feed
    // right here before a market-hours scan, then resume.
    var _apiPaused = (typeof window.ptIsApiPaused === 'function') && window.ptIsApiPaused();
    var pauseBtnHtml = (typeof window.ptIsApiPaused === 'function')
      ? '<button type="button" class="sw-today-act sw-today-pause-btn'
        + (_apiPaused ? ' is-paused' : '') + '"'
        + ' id="sw-today-pause-btn"'
        + ' onclick="swingToggleApiPause()"'
        + ' aria-pressed="' + (_apiPaused ? 'true' : 'false') + '"'
        + ' title="Live Upstox feeds (chart, option LTP, chain, intraday). Pause before a market-hours scan to protect your rate limit, then resume.">'
        + '<span class="sw-today-pause-dot" aria-hidden="true"></span>'
        + '<span class="sw-today-pause-txt">' + (_apiPaused ? 'Resume feeds' : 'Pause feeds') + '</span>'
        + '</button>'
      : '';

    var isCollapsed = swTodayIsCollapsed();
    // Leading collapse toggle — the chevron + badge + summary (BUY/WAIT/
    // AVOID counts) are ONE big click target so the user doesn't have to
    // aim at the tiny chevron. It can't swallow the whole header because
    // the action buttons (Re-compute / Export / Pause) are interactive
    // and a <button> can't nest buttons — so only the meta block is the
    // toggle; the actions stay separate on the right. The chevron points
    // down (open → click hides) when expanded and right (closed → click
    // reveals) when collapsed.
    var collapseTriggerHtml = ''
      + '<button type="button" class="sw-today-collapse-trigger"'
      +   ' onclick="swingToggleTodayCollapse()"'
      +   ' aria-expanded="' + (isCollapsed ? 'false' : 'true') + '"'
      +   ' title="' + (isCollapsed ? 'Expand the setups table' : 'Collapse the setups table') + '">'
      +   '<span class="sw-today-collapse-toggle" aria-hidden="true">'
      +     (isCollapsed ? '\u25B8' : '\u25BE')
      +   '</span>'
      +   '<span class="sw-today-header-meta">'
      +     '<span class="sw-today-badge' + (ageWarn ? ' sw-today-badge-stale' : '') + '">' + badgeLabel + '</span>'
      +     '<span class="sw-today-title">'
      +       '<span class="sw-today-count-buy">' + buys.length + ' BUY</span>'
      +       ' \u00b7 ' + (payload.waitCount || 0) + ' WAIT'
      +       ' \u00b7 ' + (payload.avoidCount || 0) + ' AVOID'
      +     '</span>'
      +   '</span>'
      + '</button>';

    var headerHtml = ''
      + '<div class="sw-today-header">'
      +   collapseTriggerHtml
      +   '<div class="sw-today-header-actions">'
      +     '<span class="sw-today-regime ' + regimeCls + '" title="' + escapeHtml(regimeTip) + '" tabindex="0">' + regimeTxt + '</span>'
      +     '<span class="sw-today-act-sep" aria-hidden="true"></span>'
      +     pauseBtnHtml
      +     '<button type="button" class="sw-today-act sw-today-act--primary"'
      +       ' id="sw-verdicts-tool-btn"'
      +       ' onclick="swingStartComputeAll()"'
      +       ' aria-describedby="sw-verdicts-tool-status"'
      +       ' title="Re-run the analyzer on every stock">'
      +       'Re-compute'
      +     '</button>'
      +     (_failedForBtn > 0
        ? '<button type="button" class="sw-today-act sw-today-act--retry"'
          + ' id="sw-verdicts-retry-btn"'
          + ' onclick="swingRetryFailed()"'
          + ' aria-describedby="sw-verdicts-tool-status"'
          + ' title="Re-run ONLY the ' + _failedForBtn + ' failed name(s) and merge them back in. '
          + 'Rate-limited names usually succeed on a retry \u2014 the ' + (payload.succeeded || 0)
          + ' already-computed names are kept as-is.">'
          + '\u21BB Retry ' + _failedForBtn + ' failed'
          + '</button>'
        : '')
      +     '<button type="button" class="sw-today-act"'
      +       ' onclick="swingExportVerdicts()"'
      +       ' title="Download verdicts-YYYY-MM-DD.json (backup / git commit)">'
      +       'Export'
      +     '</button>'
      +     (_tooNewActive > 0
        ? '<button type="button" class="sw-today-act"'
          + ' onclick="swingClearTooNew()"'
          + ' title="' + _tooNewActive + ' newly-listed name(s) are being skipped because they don\'t have enough history yet. '
          + 'They auto-recheck after ~45 days; click to force them back into the next scan now.">'
          + '\u21BA Clear ' + _tooNewActive + ' too-new'
          + '</button>'
        : '')
      +   '</div>'
      + '</div>';

    // Compute-progress status line. Kept present in BOTH collapsed and
    // expanded states because swingStartComputeAll() (Re-compute, which
    // stays clickable while collapsed) writes its progress here and bails
    // if the element is missing.
    var statusHtml = '<div class="sw-today-status sw-verdicts-tool-status"'
      + ' id="sw-verdicts-tool-status" role="status"'
      + ' aria-live="polite" hidden></div>';

    // Everything below the header strip — only shown when expanded.
    var metaHtml = ''
      + '<div class="sw-today-subline">'
      +   'Computed ' + escapeHtml(payload.computedAtIST || '\u2014')
      +   (ageStr ? ' \u00b7 <span class="' + (ageWarn ? 'sw-today-age-warn' : 'sw-today-age') + '">' + ageStr + '</span>' : '')
      +   ' \u00b7 ' + (payload.succeeded || 0) + ' / ' + (payload.universeSize || 0) + ' analyzed'
      +   (payload.verdictMode && SW_VERDICT_MODE_LABEL[payload.verdictMode] ? ' \u00b7 Mode: <strong>' + escapeHtml(SW_VERDICT_MODE_LABEL[payload.verdictMode]) + '</strong>' : '')
      +   (payload.scanTf ? ' \u00b7 TF: <strong>' + escapeHtml(SW_TF_LABEL[payload.scanTf] || payload.scanTf) + '</strong>' : '')
      +   (payload.scanScopeName ? ' \u00b7 Scope: <strong>' + escapeHtml(payload.scanScopeName) + '</strong>' : '')
      +   (payload.skipped ? ' \u00b7 ' + payload.skipped + ' outside \u20B9' + (payload.minPrice || SW_MIN_PRICE) + '\u2013\u20B9' + (payload.maxPrice || SW_MAX_PRICE) : '')
      +   (payload.insufficientHistory ? ' \u00b7 ' + payload.insufficientHistory + ' too new' : '')
      +   (payload.excludedTooNew ? ' \u00b7 <span title="Already-known too-new names, excluded from this scan to save API calls. Auto-rechecked after ~45 days; use Clear too-new to force them back in now.">' + payload.excludedTooNew + ' pre-skipped</span>' : '')
      +   (payload.failed ? ' \u00b7 ' + payload.failed + ' failed' : '')
      +   (function () {
            // Stale hint: the scope / scan TF / mode toggles only re-render
            // — the saved results stay until the user re-computes. Tell them.
            var curTf = swingGetScanTf(), curMode = swingGetVerdictMode(), curScope = swingGetScanScope();
            var tfStale = payload.scanTf && payload.scanTf !== curTf;
            var modeStale = payload.verdictMode && payload.verdictMode !== curMode;
            // payload.scanScope may be undefined on pre-scope scans — only
            // flag staleness when the saved value exists and differs.
            var scopeStale = payload.scanScope != null && payload.scanScope !== curScope;
            if (!tfStale && !modeStale && !scopeStale) return '';
            var curScopeName = '__all__' === curScope
              ? 'All NSE/BSE'
              : (function () {
                  var g = _swScanGroups
                    ? (_swScanGroups.screens || []).concat(_swScanGroups.indices || [], _swScanGroups.sectors || [])
                        .filter(function (x) { return x.id === curScope; })[0]
                    : null;
                  return g ? g.name : curScope;
                })();
            var parts = [];
            if (modeStale) parts.push(SW_VERDICT_MODE_LABEL[curMode] || curMode);
            if (tfStale) parts.push(SW_TF_LABEL[curTf] || curTf);
            if (scopeStale) parts.push(curScopeName);
            return ' \u00b7 <span class="sw-today-age-warn">selection changed to ' + escapeHtml(parts.join(' \u00b7 '))
              + ' \u2014 <button type="button" class="sw-today-btn-link" onclick="swingStartComputeAll()">re-compute</button> to apply</span>';
          })()
      + '</div>'
      + swingModeRowHtml();

    // Collapsed: fold the (tall) scan table away and show only the
    // summary header (BUY/WAIT/AVOID counts + actions) so the sector
    // grid / analyzer below come back into view. Re-compute / Export /
    // Pause / Expand all stay reachable from the header strip.
    if (isCollapsed) return headerHtml + statusHtml;

    headerHtml += metaHtml + statusHtml;

    // ── Label filter chips (All / BUY / WAIT / AVOID / Failed /
    //    Skipped) — let the user inspect every verdict band, not
    //    just BUY. Counts come straight off the payload summary. ──
    function _tfChip(key, label, cls, count, title) {
      var isActive = activeFilter === key;
      return '<button type="button"'
        + ' class="sw-sf-chip sw-sf-chip--' + cls + (isActive ? ' sw-sf-chip--active' : '') + '"'
        + (title ? ' title="' + escapeHtml(title) + '"' : '')
        + ' onclick="swingSetTodayFilter(\'' + key + '\')">'
        + label + ' <span class="sw-sf-chip-n">' + count + '</span>'
        + '</button>';
    }
    var failedCount  = payload.failed != null ? payload.failed
      : allVerdicts.filter(function (v) { return !v.ok && !v.skipped && !v.insufficientHistory; }).length;
    var skippedCount = payload.skipped != null ? payload.skipped
      : allVerdicts.filter(function (v) { return !v.ok && v.skipped; }).length;
    var nodataCount  = payload.insufficientHistory != null ? payload.insufficientHistory
      : allVerdicts.filter(function (v) { return !v.ok && !v.skipped && v.insufficientHistory; }).length;
    // Free-text search box — sits at the far right of the filter bar
    // (margin-left:auto pushes it there). Reuses the per-sector search
    // classes so the look + behaviour match. Matches symbol + name.
    var searchVal = _swTodaySearch || '';
    var todaySearchHtml = ''
      + '<div class="sw-sector-search sw-today-search">'
      +   '<svg class="sw-sector-search-icon" viewBox="0 0 24 24" width="12" height="12"'
      +     ' fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">'
      +     '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
      +   '</svg>'
      +   '<input type="text" class="sw-sector-search-input sw-today-search-input" placeholder="Search stock\u2026"'
      +     ' value="' + escapeHtml(searchVal) + '"'
      +     ' oninput="swingTodaySearch(this.value)"'
      +     ' onkeydown="if(event.key===\'Escape\'){swingTodaySearch(\'\');}"'
      +     ' aria-label="Search setups by symbol or company name">'
      +   (searchVal ? '<button type="button" class="sw-sector-search-clear" onclick="swingTodaySearch(\'\')"'
      +     ' aria-label="Clear search">&times;</button>' : '')
      + '</div>';

    // Setup-column filter dropdown. Options are data-driven from the
    // rows currently in view (post label + search), so it never offers a
    // setup that isn't on screen. Hidden entirely when the scan surfaces
    // no setups at all (e.g. an all-FAILED scan) — an empty dropdown is
    // noise. If the active setup has been filtered out of existence (the
    // user narrowed the label after picking a setup), it's still rendered
    // as the selected option with a (0) count so the control stays
    // truthful and the user can switch back to "All setups".
    // Custom, app-themed dropdown (NOT a native <select> — the browser
    // renders the native option popup with the OS chrome, which ignores
    // our theme tokens and looks out of place). This is a button + an
    // absolutely-positioned themed menu, toggled by swingToggleSetupMenu
    // and closed on outside-click / Escape (bound once below). The menu
    // scrolls when the option list is long so every value stays reachable.
    var setupSelectHtml = '';
    var hasSetupOptions = setupMenuOptions.length > 0 || activeSetup !== 'ALL';
    if (hasSetupOptions) {
      var activeInList = activeSetup === 'ALL'
        || setupMenuOptions.some(function (o) { return o.key === activeSetup; });
      // Label shown on the closed trigger button.
      var curLabel = activeSetup === 'ALL'
        ? 'All setups (' + setupBaseCount + ')'
        : (function () {
            var hit = setupMenuOptions.filter(function (o) { return o.key === activeSetup; })[0];
            return activeSetup + ' (' + (hit ? hit.count : 0) + ')';
          })();

      // One menu row. `key` is spliced into an onclick string literal, so
      // escape single quotes for the JS arg AND HTML-escape for the attr.
      // A 0-count row is greyed (--empty) but still selectable (it just
      // lands on the "no rows match" empty state).
      function _setupOpt(key, labelHtml, count, isAll) {
        var isActive = key === activeSetup;
        var isEmpty = count === 0 && !isAll;
        var keyArg = escapeHtml(String(key).replace(/'/g, "\\'"));
        // data-setup drives the in-menu live search (lowercased key text).
        var searchKey = escapeHtml(String(isAll ? 'all setups' : key).toLowerCase());
        return '<button type="button" role="option"'
          + ' class="sw-sf-dd-opt'
          +   (isActive ? ' sw-sf-dd-opt--active' : '')
          +   (isEmpty ? ' sw-sf-dd-opt--empty' : '') + '"'
          + ' data-setup="' + searchKey + '"'
          +   (isAll ? ' data-setup-all="1"' : '')
          + ' aria-selected="' + (isActive ? 'true' : 'false') + '"'
          + ' onclick="swingSetTodaySetup(\'' + keyArg + '\')">'
          + '<span class="sw-sf-dd-check" aria-hidden="true">' + (isActive ? '\u2713' : '') + '</span>'
          + '<span class="sw-sf-dd-opt-label">' + labelHtml + '</span>'
          + (count != null ? '<span class="sw-sf-dd-opt-n">' + count + '</span>' : '')
          + '</button>';
      }

      var menuRows = _setupOpt('ALL', 'All setups', setupBaseCount, true);
      if (!activeInList) {
        // Active setup not in the catalog/present set (legacy drift) —
        // keep it visible (selected, 0 rows) so the control stays truthful.
        menuRows += _setupOpt(activeSetup, escapeHtml(activeSetup), 0);
      }
      // Render the catalog, inserting a small group header whenever the
      // group changes — but only when more than one group is present
      // (i.e. FIB_ZOI mode). A single-group list needs no header.
      var _groupSet = {};
      setupMenuOptions.forEach(function (o) { if (o.group) _groupSet[o.group] = 1; });
      var showGroupHeads = Object.keys(_groupSet).length > 1;
      var _lastGroup = null;
      menuRows += setupMenuOptions.map(function (o) {
        var head = '';
        if (showGroupHeads && o.group && o.group !== _lastGroup) {
          _lastGroup = o.group;
          head = '<div class="sw-sf-dd-head" aria-hidden="true">'
            + (o.group === 'FIB' ? 'Fib pocket' : (o.group === 'ZOI' ? 'Demand / supply zone' : escapeHtml(o.group)))
            + '</div>';
        }
        return head + _setupOpt(o.key, escapeHtml(o.label), o.count);
      }).join('');

      setupSelectHtml = ''
        + '<div class="sw-sf-setup">'
        +   '<span class="sw-sf-setup-label">Setup:</span>'
        +   '<div class="sw-sf-dd' + (activeSetup !== 'ALL' ? ' sw-sf-dd--on' : '') + '" id="sw-setup-dd">'
        +     '<button type="button" class="sw-sf-dd-btn" id="sw-setup-dd-btn"'
        +       ' aria-haspopup="listbox" aria-expanded="false"'
        +       ' onclick="swingToggleSetupMenu(event)" title="Filter rows by setup">'
        +       '<span class="sw-sf-dd-cur">' + escapeHtml(curLabel) + '</span>'
        +       '<span class="sw-sf-dd-caret" aria-hidden="true">\u25BE</span>'
        +     '</button>'
        +     '<div class="sw-sf-dd-menu" role="listbox" aria-label="Filter by setup">'
        +       '<div class="sw-sf-dd-search">'
        +         '<svg class="sw-sf-dd-search-icon" viewBox="0 0 24 24" width="13" height="13"'
        +           ' fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">'
        +           '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
        +         '</svg>'
        +         '<input type="text" class="sw-sf-dd-search-input" id="sw-setup-dd-search"'
        +           ' placeholder="Filter setups\u2026" autocomplete="off"'
        +           ' oninput="swingSetupMenuSearch(this.value)"'
        +           ' onkeydown="if(event.key===\'Escape\'){this.value=\'\';swingSetupMenuSearch(\'\');event.stopPropagation();}"'
        +           ' aria-label="Filter the setup list">'
        +       '</div>'
        +       '<div class="sw-sf-dd-list">'
        +         menuRows
        +         '<div class="sw-sf-dd-empty" hidden>No setup matches</div>'
        +       '</div>'
        +     '</div>'
        +   '</div>'
        + '</div>';
    }

    var filterBarHtml = '<div class="sw-sf-bar">'
      + '<span class="sw-sf-label">Show:</span>'
      + _tfChip('ALL',   'All',     'all',     allVerdicts.length)
      + _tfChip('BUY',   '\u2713 Buy',   'bounce',  buys.length)
      + _tfChip('WAIT',  '\u25CB Wait',  'forming', payload.waitCount || 0)
      + _tfChip('AVOID', '\u2717 Avoid', 'falling', payload.avoidCount || 0)
      + (failedCount  ? _tfChip('FAILED',  '\u26A0 Failed',  'above', failedCount, 'Transient failures (rate-limited / network) \u2014 these are what \u201cRetry\u201d re-runs.')  : '')
      + (nodataCount  ? _tfChip('NODATA',  'Too new', 'above', nodataCount, 'Newly listed / not enough history to analyze \u2014 not retryable (a re-scan fails the same way).') : '')
      + (skippedCount ? _tfChip('SKIPPED', 'Skipped', 'above', skippedCount, 'Outside the price band \u2014 deliberately skipped.') : '')
      + setupSelectHtml
      + todaySearchHtml
      + '</div>';

    if (top.length === 0) {
      var emptyMsg = activeSetup !== 'ALL'
        ? '<strong>No rows match setup \u201c' + escapeHtml(activeSetup) + '\u201d</strong>'
          + (searchQ || activeFilter !== 'ALL' ? ' with the current filters' : '') + '. '
          + '<button type="button" class="sw-today-btn-link" onclick="swingSetTodaySetup(\'ALL\')">Clear setup filter</button>'
          + ' or pick another above.'
        : searchQ
        ? '<strong>No setups match \u201c' + escapeHtml(searchQ) + '\u201d.</strong> '
          + '<button type="button" class="sw-today-btn-link" onclick="swingTodaySearch(\'\')">Clear search</button>'
          + ' or pick another filter above.'
        : activeFilter === 'BUY'
        ? '<strong>No BUY recommendations in today\u2019s scan.</strong> '
          + 'Nothing met the ' + escapeHtml(SW_VERDICT_MODE_LABEL[payload.verdictMode] || payload.verdictMode || 'selected')
          + ' rules on the ' + escapeHtml(SW_TF_LABEL[payload.scanTf] || payload.scanTf || 'scan') + ' timeframe. '
          + 'Switch the scan timeframe or mode above and re-compute, or inspect WAIT / AVOID rows.'
        : '<strong>No ' + activeFilter + ' rows in this scan.</strong> '
          + 'Pick another filter above.';
      return headerHtml
        + filterBarHtml
        + '<div class="sw-today-empty-buys">' + emptyMsg + '</div>';
    }

    var _selIsin = (STATE && STATE.selected && STATE.selected.isin) || '';
    var rowsHtml = top.map(function (v) {
      var selCls = (v.isin && v.isin === _selIsin) ? ' sw-today-row--selected' : '';
      if (isVerdictMode) {
        var cat = swVerdictCategory(v);
        var catBadge = ({
          BUY:     '<span class="sw-act-badge sw-act-badge--buy">BUY</span>',
          WAIT:    '<span class="sw-act-badge sw-act-badge--watch">WAIT</span>',
          AVOID:   '<span class="sw-act-badge sw-act-badge--avoid">AVOID</span>',
          FAILED:  '<span class="sw-act-badge sw-act-badge--fail">FAILED</span>',
          NODATA:  '<span class="sw-act-badge sw-act-badge--none">TOO NEW</span>',
          SKIPPED: '<span class="sw-act-badge sw-act-badge--none">SKIPPED</span>'
        })[cat] || '';
        var pxTxt = isFinite(v.price) ? '\u20B9' + Number(v.price).toFixed(2) : '\u2014';
        var reasonTxt = v.ok ? (v.reasoning || '\u2014') : (v.error || 'analysis failed');
        // CONVICTION column — verdict-relative dots + word for EVERY row, so
        // the cell never misleads and no naked % competes with the word cells.
        //   • BUY  → GREEN dots + strength word (strong/good/fair) mapped from
        //            the bullish-confluence TIER (A+/A/B). Exact score in tip.
        //   • non-BUY → muted/red dots + a SITUATION word ("don't chase" /
        //            "watch" / "rejecting"…) keyed to the SAME zoiPosition/
        //            fibClass the Setup + Reasoning columns show, so identical
        //            setups always read identically and match the reasoning.
        var confCellHtml, confCellCls, confCellTitle;
        var cv = v.conviction;
        if (cv && cv.level) {
          var dotsHtml = '';
          for (var _di = 1; _di <= 3; _di++) dotsHtml += '<span class="sw-conv-dot' + (_di <= cv.level ? ' on' : '') + '"></span>';
          confCellHtml = '<span class="sw-conv-dots">' + dotsHtml + '</span>'
            + '<span class="sw-conv-word">' + escapeHtml(cv.label) + '</span>';
          if (cat === 'BUY') {
            confCellCls = 'sw-today-conv sw-conv--buy';
            confCellTitle = 'BUY conviction: ' + cv.label
              + (cv.score != null ? ' (confluence ' + cv.score + '/100'
                  + (v.confluence && v.confluence.tier ? ', tier ' + v.confluence.tier : '') + ')' : '')
              + (cv.factors && cv.factors.length ? ' \u2014 ' + cv.factors.join(', ') : '')
              + '. Dots = how strong the setup is (1 = fair, 3 = strong).';
          } else {
            confCellCls = 'sw-today-conv sw-conv--' + (cat === 'AVOID' ? 'avoid' : 'wait');
            confCellTitle = (cat === 'AVOID' ? 'Stay out (' : 'No entry yet (')
              + cv.label + ') \u2014 ' + (cv.factors && cv.factors.length ? cv.factors.join(', ') : 'based on price location vs the zone')
              + '. Dots = how firmly to stand aside (1 = near actionable, 3 = clearly stand aside).';
          }
        } else {
          confCellHtml = '\u2014';
          confCellCls = 'sw-today-conv sw-conv--na';
          confCellTitle = 'No conviction data.';
        }
        var modeBadge = '';
        if (v.fibClass) modeBadge += '<span class="sw-today-mode-badge sw-today-mode-fib">FIB: ' + escapeHtml(v.fibClass.replace(/_/g, ' ')) + '</span>';
        if (v.zoiPosition) modeBadge += '<span class="sw-today-mode-badge sw-today-mode-zoi">ZOI: ' + escapeHtml(swZoiPosLabel(v.zoiPosition)) + '</span>';
        var symArg  = escapeHtml(String(v.sym  || '').replace(/'/g, "\\'"));
        var isinArg = escapeHtml(String(v.isin || '').replace(/'/g, "\\'"));
        var nameArg = escapeHtml(String(v.name || '').replace(/'/g, "\\'"));
        return ''
          + '<button type="button" class="sw-today-row sw-today-row-verdict' + selCls + '"'
          +   ' data-isin="' + isinArg + '"'
          +   ' onclick="swingPickTodayRow(\'' + isinArg + '\',\'' + symArg + '\',\'' + nameArg + '\')"'
          +   ' title="' + escapeHtml(v.tooltip || reasonTxt) + '">'
          +   '<span class="sw-today-row-sym">' + escapeHtml(v.sym || '') + '</span>'
          +   '<span class="sw-today-row-name">' + escapeHtml(v.name || '') + '</span>'
          +   '<span class="sw-today-row-price">' + pxTxt + '</span>'
          +   '<span class="sw-today-row-context">' + (modeBadge || '<span class="sw-today-ctx-none">\u2014</span>') + '</span>'
          +   '<span class="sw-today-row-confidence ' + confCellCls + '" title="' + escapeHtml(confCellTitle) + '">' + confCellHtml + '</span>'
          +   '<span class="sw-today-row-badges">' + catBadge + '</span>'
          +   '<span class="sw-today-row-reasoning">' + escapeHtml(reasonTxt) + '</span>'
          + '</button>';
      }
      var rrTxt    = v.rr != null && isFinite(v.rr) ? v.rr.toFixed(1) + 'R' : '\u2014';
      var confTxt  = v.confidencePct != null ? v.confidencePct + '%' : (v.confidence || '\u2014');
      var confCls  = 'sw-today-conf-' + String(v.confidence || 'na').toLowerCase();
      var setupTxt = v.setupShort || v.setupName || '\u2014';
      var entryTxt = isFinite(v.entry) ? '\u20B9' + Number(v.entry).toFixed(2) : '\u2014';
      var slTxt    = isFinite(v.sl)    ? '\u20B9' + Number(v.sl).toFixed(2)    : '\u2014';
      var t1Txt    = isFinite(v.t1)    ? '\u20B9' + Number(v.t1).toFixed(2)    : '\u2014';
      var scoreTxt = v.score != null && isFinite(v.score) ? Number(v.score).toFixed(1) : '\u2014';
      // Drift badge: compare scan-time entry vs current LTP (if cached)
      var driftBadge = '';
      try {
        var cachedLtp = null;
        if (window.SECTOR_STATE && window.SECTOR_STATE.quoteCache && v.isin) {
          var qc = window.SECTOR_STATE.quoteCache[v.isin];
          if (qc && qc.ltp != null) cachedLtp = qc.ltp;
        }
        if (cachedLtp != null && isFinite(v.entry) && v.entry > 0) {
          var dPct = (cachedLtp - v.entry) / v.entry * 100;
          if (dPct > 3) {
            driftBadge = '<span class="sw-drift-badge sw-drift-up" title="Current price \u20B9' + cachedLtp.toFixed(2) + ' is ' + dPct.toFixed(1) + '% above scan entry \u2014 price has moved, wait for a pullback">\u25B2' + dPct.toFixed(1) + '%</span>';
          } else if (dPct < -3) {
            driftBadge = '<span class="sw-drift-badge sw-drift-dn" title="Current price \u20B9' + cachedLtp.toFixed(2) + ' is ' + Math.abs(dPct).toFixed(1) + '% below scan entry \u2014 near stop, review risk">\u25BC' + Math.abs(dPct).toFixed(1) + '%</span>';
          }
        }
      } catch (_) {}
      // Inline-attribute escaping: passing three string args via
      // onclick="..." means we need quotes inside the strings to
      // be safe to splice into a single-quoted JS string literal
      // inside a double-quoted HTML attribute. escapeJsArg covers
      // both: HTML-escape (for the attribute) AND backslash-escape
      // any embedded single quotes (for the JS string).
      var symArg  = escapeHtml(String(v.sym  || '').replace(/'/g, "\\'"));
      var isinArg = escapeHtml(String(v.isin || '').replace(/'/g, "\\'"));
      var nameArg = escapeHtml(String(v.name || '').replace(/'/g, "\\'"));
      return ''
        + '<button type="button" class="sw-today-row' + selCls + '"'
        +   ' data-isin="' + isinArg + '"'
        +   ' onclick="swingPickTodayRow(\'' + isinArg + '\',\'' + symArg + '\',\'' + nameArg + '\')"'
        +   ' title="' + escapeHtml(v.sym) + ' \u2014 open deep analysis">'
        +   '<span class="sw-today-row-sym">' + escapeHtml(v.sym || '') + driftBadge + '</span>'
        +   '<span class="sw-today-row-name">' + escapeHtml(v.name || '') + '</span>'
        +   '<span class="sw-today-row-score" title="Setup score">' + scoreTxt + '</span>'
        +   '<span class="sw-today-row-conf ' + confCls + '" title="Confidence">' + confTxt + '</span>'
        +   '<span class="sw-today-row-setup">' + escapeHtml(setupTxt) + '</span>'
        +   '<span class="sw-today-row-prices">'
        +     '<span class="sw-today-row-entry">' + entryTxt + '</span>'
        +     ' <span class="sw-today-row-arrow">\u2192</span> '
        +     '<span class="sw-today-row-t1">' + t1Txt + '</span>'
        +     ' <span class="sw-today-row-rr">(' + rrTxt + ')</span>'
        +   '</span>'
        +   '<span class="sw-today-row-sl" title="Stop loss">SL ' + slTxt + '</span>'
        + '</button>';
    }).join('');

    var moreHtml = '';
    if (filtered.length > SW_TODAY_MAX_ROWS) {
      moreHtml = '<div class="sw-today-more">'
        + '+' + (filtered.length - SW_TODAY_MAX_ROWS) + ' more '
        + (activeFilter === 'ALL' ? '' : activeFilter + ' ') + 'rows in storage \u00b7 '
        + '<button type="button" class="sw-today-btn-link"'
        +   ' onclick="swingExportVerdicts()">Export to inspect</button>'
        + '</div>';
    }

    // Column headers \u2014 same grid template as .sw-today-row so the
    // labels align perfectly with each row's columns. Hidden on
    // narrow screens (the rows reshape into a 2-row collapsed
    // layout where a fixed header strip stops making sense).
    var colHeadersHtml = '';
    if (isVerdictMode) {
      colHeadersHtml = ''
        + '<div class="sw-today-col-headers sw-today-col-headers-verdict" aria-hidden="true">'
        +   '<span>Symbol</span>'
        +   '<span>Company</span>'
        +   '<span class="sw-today-col-num">Price</span>'
        +   '<span>Setup</span>'
        +   '<span>Conviction</span>'
        +   '<span>Suggestion</span>'
        +   '<span>Reasoning</span>'
        + '</div>';
    } else {
      colHeadersHtml = ''
        + '<div class="sw-today-col-headers" aria-hidden="true">'
        +   '<span>Symbol</span>'
        +   '<span>Company</span>'
        +   '<span class="sw-today-col-num">Score</span>'
        +   '<span class="sw-today-col-num">Conf</span>'
        +   '<span>Setup</span>'
        +   '<span class="sw-today-col-num">Entry \u2192 Target (RR)</span>'
        +   '<span class="sw-today-col-num">Stop</span>'
        + '</div>';
    }

    // Stale-cache warning: if scan is ≥1 trading day old, remind
    // the user that entry prices are from a prior close and some
    // setups may have moved beyond the entry zone.
    var staleWarnHtml = '';
    if (ageWarn) {
      staleWarnHtml = '<div class="sw-today-stale-warn">'
        + '<span>\u26A0\uFE0F</span>'
        + '<span>Scan is <strong>' + ageStr + '</strong>. Entry prices are from a prior close \u2014 some stocks may have moved past the entry zone. '
        + 'Click a row to see how far the price has moved, or <button type="button" class="sw-today-btn-link" onclick="swingStartComputeAll()">Re-compute</button> to get fresh setups.</span>'
        + '</div>';
    }

    // Column headers live INSIDE the scrolling rows container as a
    // sticky first child — this guarantees the header strip and the
    // data rows share the exact same width (incl. any scrollbar
    // gutter), so labels stay glued above their values even when the
    // list scrolls.
    return headerHtml
      + filterBarHtml
      + staleWarnHtml
      + '<div class="sw-today-rows" role="list">' + colHeadersHtml + rowsHtml + '</div>'
      + moreHtml;
  }

  // Click handler for Today's Setups rows. Opens the stock's
  // parent sector panel, scrolls to and flashes the stock row in
  // the sector table, then triggers analyze().
  // Match the chart overlays to the scan mode the row was produced in:
  //   FIB     → fib pocket only      (zoi hidden)
  //   ZOI     → demand/supply only   (fib hidden)
  //   FIB_ZOI → both overlays on
  // Mirrors the mode resolution in swComputeVerdictForTf so the chart, the
  // clicked row, and the detail card all agree on what was actually scanned.
  // Prefer the saved scan's mode (what produced the row); fall back to the
  // live toggle for direct picks.
  function _swApplyScanModeOverlays() {
    if (!STATE.indVisible) return;
    var mode;
    try { var _p = swingLoadVerdictsLocal(); mode = (_p && _p.verdictMode) || swingGetVerdictMode(); }
    catch (_) { mode = swingGetVerdictMode(); }
    if (mode !== 'FIB' && mode !== 'ZOI' && mode !== 'FIB_ZOI') mode = 'FIB_ZOI';
    STATE.indVisible.fib = (mode === 'FIB' || mode === 'FIB_ZOI');
    STATE.indVisible.zoi = (mode === 'ZOI' || mode === 'FIB_ZOI');
    // Clear stale auto-fib context when fib is being hidden so the chart
    // never redraws a previous stock's pocket. renderMainChart auto-computes
    // a fresh pocket from the candles when fib is visible.
    if (!STATE.indVisible.fib && typeof FIB_STATE !== 'undefined') {
      FIB_STATE.pendingFib = null; FIB_STATE.pendingTf = null;
    }
  }

  window.swingPickTodayRow = function (isin, sym, name) {
    if (!isin) return;
    STATE.selected = { sym: sym || '', isin: isin, name: name || '' };
    _swApplyScanModeOverlays();
    // Open the chart on the SCAN timeframe so the detail-card verdict
    // matches the row the user just clicked (consumed once in renderResult).
    try {
      var _p = swingLoadVerdictsLocal();
      if (_p && _p.scanTf) STATE.requestedChartTf = swingNormalizeTf(_p.scanTf);
    } catch (_) {}

    // Highlight the picked row immediately. The Today's Setups list is
    // NOT re-rendered on pick (only the deep-analysis panel below is),
    // so toggle the selected class in place across the rendered rows.
    try {
      var _rows = document.querySelectorAll('.sw-today-rows .sw-today-row');
      for (var _i = 0; _i < _rows.length; _i++) {
        _rows[_i].classList.toggle('sw-today-row--selected',
          _rows[_i].getAttribute('data-isin') === isin);
      }
    } catch (_) {}

    // Sync the selection into the sector table below — the same stock
    // gets the focused highlight there too. Keep the deadline non-zero so
    // _focusedIsin is preserved (swingPickSector clears it when the
    // deadline has lapsed) and the panel-scroll branch is skipped, but set
    // _suppressRowScroll so _swDoScrollToFocused does NOT jump to the
    // sector row — we scroll to the chart instead (after analyze resolves).
    SECTOR_STATE._focusedIsin = isin;
    SECTOR_STATE._scrollDeadline = Date.now() + 8000;
    SECTOR_STATE._suppressRowScroll = true;
    _swScrollDone = false;

    var found = null;
    var foundSector = null;
    if (SECTOR_STATE.data) {
      SECTOR_STATE.data.sectors.some(function (sec) {
        var st = sec.stocks.find(function (s) { return s.isin === isin; });
        if (st) { found = st; foundSector = sec; return true; }
        return false;
      });
      if (!found) {
        (SECTOR_STATE.data.indices || []).some(function (ix) {
          var st = ix.stocks.find(function (s) { return s.isin === isin; });
          if (st) { found = st; foundSector = Object.assign({ kind: 'index' }, ix); return true; }
          return false;
        });
      }
    }
    if (!found) {
      var st = (SECTOR_STATE.customStocks || []).find(function (s) { return s.isin === isin; });
      if (st) { found = st; foundSector = { id: 'my-stocks', name: 'My Stocks', kind: 'custom' }; }
    }

    if (found && foundSector) {
      if (SECTOR_STATE.activeSector !== foundSector.id) {
        swingPickSector(foundSector.id).catch(function () {});
      } else {
        renderSectorPanel();
      }
    }

    analyze().then(function () {
      // Navigate straight to the chart once the stock is analyzed, so the
      // click takes the user to the chart (not the sector row above it).
      try {
        var chartEl = document.querySelector('#sw-result .sw-chart-section')
          || document.getElementById('sw-chart')
          || document.getElementById('sw-result');
        if (chartEl && chartEl.scrollIntoView) {
          chartEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      } catch (_) {}
    }).catch(function () {});
  };

  // Manual JSON export (backup / git commit / cross-device share).
  // Pulls the currently-stored payload from localStorage and routes
  // through swingDownloadVerdicts. No-op with a small toast if
  // nothing has been computed yet.
  window.swingExportVerdicts = function () {
    var payload = swingLoadVerdictsLocal();
    if (!payload) {
      alert('No recommendations in storage yet. Click "Compute today\u2019s recommendations" first.');
      return;
    }
    swingDownloadVerdicts(payload);
  };

  // Pause / resume ALL live Upstox feeds straight from the Today's
  // Setups header. Delegates to the options module's master toggle
  // (window.ptToggleApiPause) so chart polling, option LTP, chain
  // refresh and the intraday analyzer all stop/start together — then
  // updates this header's button in place (no full re-render needed).
  window.swingToggleApiPause = function () {
    if (typeof window.ptToggleApiPause !== 'function') return;
    var paused = window.ptToggleApiPause();
    var btn = document.getElementById('sw-today-pause-btn');
    if (btn) {
      btn.classList.toggle('is-paused', !!paused);
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      var txt = btn.querySelector('.sw-today-pause-txt');
      if (txt) txt.textContent = paused ? 'Resume feeds' : 'Pause feeds';
    }
  };

  // Serialises the payload to JSON and triggers a browser download
  // as `verdicts-YYYY-MM-DD.json`. Returns the filename so the
  // caller can show a "saved as X" status. The primary save path
  // is now localStorage (see swingSaveVerdictsLocal) — this is the
  // optional "Export JSON" backup used for git commits / sharing.
  function swingDownloadVerdicts(payload) {
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url  = URL.createObjectURL(blob);
    var d = new Date();
    var dateStr = d.getFullYear() + '-'
                + String(d.getMonth() + 1).padStart(2, '0') + '-'
                + String(d.getDate()).padStart(2, '0');
    var fileName = 'verdicts-' + dateStr + '.json';
    var a = document.createElement('a');
    a.href = url; a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Give the browser a tick to start the download before revoking.
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return fileName;
  }

  // ── Themed confirm dialog ──
  // Replaces window.confirm() so prompts render with the app's
  // palette + typography + dark/light awareness instead of the
  // browser's native dialog (which always looks out-of-place).
  // API: swingConfirm({ title, message, confirmLabel, cancelLabel,
  //                     danger }) → Promise<boolean>. Focus moves
  // to the primary button on open and restores on close. Esc and
  // backdrop click both resolve false (cancel).
  //
  // Falls back to window.confirm() if the modal element isn't in
  // the DOM (e.g. section content hasn't loaded yet) — better to
  // show the ugly native dialog than to block the user with a
  // dead button. Same fallback if a previous confirm is somehow
  // still open: the prior promise is resolved as cancel before
  // the new one is started, so we never leak a hanging resolver.
  var _swConfirmResolver  = null;
  var _swConfirmPrevFocus = null;
  var _swConfirmKeyHandler = null;
  function swingConfirm(opts) {
    opts = opts || {};
    var modal = document.getElementById('sw-confirm-modal');
    if (!modal) {
      // Fallback to the native dialog if the themed modal isn't
      // available yet (rare — only on the very first paint before
      // content/swing.html has been injected).
      var native = window.confirm(
        (opts.title ? opts.title + '\n\n' : '')
        + (opts.message || '')
      );
      return Promise.resolve(native);
    }
    // If a previous confirm is somehow still open, dismiss it as
    // cancel before starting the new one.
    if (_swConfirmResolver) {
      var prev = _swConfirmResolver;
      _swConfirmResolver = null;
      try { prev(false); } catch (_) {}
    }

    var titleEl  = document.getElementById('sw-confirm-modal-title');
    var msgEl    = document.getElementById('sw-confirm-modal-message');
    var okBtn    = document.getElementById('sw-confirm-ok');
    var cancelBtn = document.getElementById('sw-confirm-cancel');
    if (titleEl)  titleEl.textContent  = opts.title || 'Confirm';
    if (msgEl)    msgEl.textContent    = opts.message || '';
    if (okBtn)    okBtn.textContent    = opts.confirmLabel || 'Proceed';
    if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || 'Cancel';
    if (okBtn)    okBtn.classList.toggle('sw-confirm-btn-danger', !!opts.danger);

    _swConfirmPrevFocus = document.activeElement;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    // Focus the primary button after the open animation starts so
    // screen readers announce the dialog title first, then the
    // button label.
    setTimeout(function () {
      if (okBtn && typeof okBtn.focus === 'function') {
        try { okBtn.focus(); } catch (_) {}
      }
    }, 60);

    // Esc cancels. Tab is allowed to cycle naturally between
    // Cancel and OK (only two focusable controls inside the card
    // besides the close-X, so a focus trap isn't necessary —
    // Tab/Shift+Tab between them is the entire trap).
    _swConfirmKeyHandler = function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        swingConfirmDismiss(false);
      }
    };
    document.addEventListener('keydown', _swConfirmKeyHandler);

    return new Promise(function (resolve) {
      _swConfirmResolver = resolve;
    });
  }
  window.swingConfirmDismiss = function (result) {
    var modal = document.getElementById('sw-confirm-modal');
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    }
    if (_swConfirmKeyHandler) {
      document.removeEventListener('keydown', _swConfirmKeyHandler);
      _swConfirmKeyHandler = null;
    }
    if (_swConfirmPrevFocus && typeof _swConfirmPrevFocus.focus === 'function') {
      try { _swConfirmPrevFocus.focus(); } catch (_) {}
    }
    _swConfirmPrevFocus = null;
    if (_swConfirmResolver) {
      var r = _swConfirmResolver;
      _swConfirmResolver = null;
      r(!!result);
    }
  };

  // UI handler — wired to the "Compute today's verdicts" /
  // "Re-compute" button on the swing landing page (same button id
  // in both empty and populated tile states). Drives the inline
  // progress text, auto-saves the payload to localStorage on
  // success, then re-renders the Today's Setups tile so the user
  // sees their setups immediately. No JSON download by default —
  // export is a separate manual action.
  window.swingStartComputeAll = async function () {
    var btn    = document.getElementById('sw-verdicts-tool-btn');
    var status = document.getElementById('sw-verdicts-tool-status');
    if (!btn || !status) return;

    if (_swBulkScanInFlight) {
      status.hidden = false;
      status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-run';
      status.textContent = 'A scan is already running \u2014 let it finish first.';
      return;
    }
    // Claim the in-flight lock synchronously, BEFORE the pre-confirm
    // async fetches (scan groups / universe size) and the confirm modal.
    // Otherwise the still-clickable "Retry failed" button could start a
    // second concurrent run during those awaits. Released on every early
    // return below and in the finally.
    _swBulkScanInFlight = true;

    var verdictMode = swingGetVerdictMode();
    var scanTf = swingGetScanTf();
    var scanScope = swingGetScanScope();

    if (!getToken()) {
      _swBulkScanInFlight = false;
      status.hidden = false;
      status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-err';
      status.textContent = 'No Upstox token connected. Open the Options Trading tab \u2192 gear icon and paste a fresh token.';
      return;
    }

    var marketOpen = typeof window.isMarketOpen === 'function' && window.isMarketOpen();
    var tfLabel = SW_TF_LABEL[scanTf] || scanTf;
    var modeLabel = (verdictMode === 'FIB' ? 'FIB only'
      : (verdictMode === 'ZOI' ? 'ZOI only'
      : 'FIB + ZOI combined')) + ' \u00b7 ' + tfLabel;
    // Resolve the chosen scope to a label + member count so the confirm
    // dialog accurately describes what's about to run (full universe vs a
    // single sector/index). A stale id falls safe to the full universe.
    var _scopeAll = (scanScope === '__all__');
    var _scopeName = 'All NSE/BSE';
    var _scopeCount = null;
    if (!_scopeAll) {
      try {
        var _grps = await swingEnsureScanGroups();
        var _g = (_grps.screens || []).concat(_grps.indices || [], _grps.sectors || [])
          .filter(function (x) { return x.id === scanScope; })[0];
        if (_g) { _scopeName = _g.name; _scopeCount = _g.count; }
        else { scanScope = '__all__'; _scopeAll = true; }  // stale → full
      } catch (_) { scanScope = '__all__'; _scopeAll = true; }
    }
    // Build the scope-aware body. A specific sector/index is a small,
    // fast, rate-budget-friendly run; the full universe is the heavy
    // ~20-30 min pass.
    var baseMsg;
    if (_scopeAll) {
      // Live universe count (deduped curated + full NSE index) instead of a
      // hard-coded guess, and the active price band from config.json.
      var _uniN = 0;
      try { _uniN = await swingEnsureUniverseSize(); } catch (_) {}
      var _uniTxt = _uniN ? _uniN.toLocaleString('en-IN') : '~2,500';
      baseMsg = 'This runs the ' + modeLabel + ' recommendation engine on the FULL NSE/BSE universe '
        + '(' + _uniTxt + ' listed equities, including illiquid small/micro-caps). '
        + 'Names priced outside \u20B9' + SW_MIN_PRICE + '\u2013\u20B9' + SW_MAX_PRICE
        + ' are skipped at scan time. '
        + 'Throttled to 1.5 req/sec to stay under Upstox\u2019s rate limit \u2014 expected '
        + 'runtime ~20\u201330 minutes. Keep this tab in the foreground; results save '
        + 'automatically in your browser. Tip: many of the extra names are thinly traded '
        + '\u2014 weigh liquidity before acting on a signal in an unfamiliar stock.';
    } else {
      baseMsg = 'This runs the ' + modeLabel + ' recommendation engine on the '
        + '\u201c' + _scopeName + '\u201d group only'
        + (_scopeCount != null ? ' (' + _scopeCount + ' listed names)' : '') + '. '
        + 'Names priced outside \u20B9' + SW_MIN_PRICE + '\u2013\u20B9' + SW_MAX_PRICE
        + ' are skipped at scan time. '
        + 'Throttled to 1.5 req/sec \u2014 a single sector usually finishes in a minute or two, '
        + 'a fraction of the full-universe budget. Results save automatically in your browser.';
    }
    var marketWarn = '\u26A0\uFE0F MARKET IS OPEN. This scan shares the same Upstox rate budget '
      + 'as your live chart and option-chain feeds. To keep the scan clean and avoid '
      + 'tripping the rate limit, the live chart + option polling will be paused '
      + 'automatically while the scan runs, then resumed when it finishes. '
      + 'Proceed?\n\n';
    var ok = await swingConfirm({
      title: 'Compute recommendations \u2014 ' + _scopeName + ' (' + modeLabel + ')?',
      message: (marketOpen ? marketWarn : '') + baseMsg,
      confirmLabel: marketOpen ? 'Pause feeds & scan' : 'Start computing',
      cancelLabel:  'Cancel'
    });
    if (!ok) { _swBulkScanInFlight = false; return; }

    // Free the shared Upstox rate budget for the duration of the
    // scan: if the market is open and the live chart / option
    // polling (pt module) is currently active, pause it and
    // remember, so we can resume it when the scan finishes. The
    // swing tab's OWN api gate (swIsApiPaused) is intentionally
    // left untouched here — pausing that would block this scan.
    var _ptAutoPaused = false;
    if (marketOpen
        && typeof window.ptIsApiPaused === 'function'
        && typeof window.ptToggleApiPause === 'function'
        && !window.ptIsApiPaused()) {
      try { window.ptToggleApiPause(); _ptAutoPaused = true; } catch (_) {}
    }

    var origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Computing\u2026';
    status.hidden = false;
    status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-run';
    // Visual progress bar (fill width + text are updated each tick by
    // the callback below; built once here so the bar transition stays
    // smooth instead of re-creating the node ~1.5×/sec).
    status.innerHTML = ''
      + '<div class="sw-today-progress" role="progressbar"'
      +   ' id="sw-verdicts-progress" aria-valuemin="0" aria-valuemax="100"'
      +   ' aria-valuenow="0">'
      +   '<div class="sw-today-progress-track">'
      +     '<div class="sw-today-progress-fill sw-today-progress-fill--start"'
      +       ' id="sw-verdicts-progress-fill" style="width:0%"></div>'
      +   '</div>'
      +   '<div class="sw-today-progress-text" id="sw-verdicts-progress-text">'
      +     (_ptAutoPaused
        ? 'Live feeds paused for scan \u2014 starting\u2026'
        : 'Starting\u2026')
      +   '</div>'
      + '</div>';

    var failed = 0;
    var startedAt = Date.now();
    // Cooldown heartbeat: the per-stock progress callback only fires when a
    // stock COMPLETES, so while the scan is riding out a 60/90s Upstox
    // cooldown the bar would otherwise look frozen. This 1s ticker overwrites
    // the progress text with the live remaining-cooldown countdown whenever
    // the global limiter is hot, reassuring the user that the scan is holding
    // (not stuck) and that no stock will be dropped. Cleared in finally.
    var _throttleHeartbeat = setInterval(function () {
      if (typeof window._upstoxIsThrottled !== 'function' || !window._upstoxIsThrottled()) return;
      var rl = window._upstoxRateLimit || {};
      var rem = Math.max(0, Math.ceil(((rl.untilTs || 0) - Date.now()) / 1000));
      var pTxt = document.getElementById('sw-verdicts-progress-text');
      if (pTxt) {
        pTxt.textContent = '\u23F3 Waiting out Upstox rate limit \u00b7 ' + rem
          + 's left \u2014 holding the scan so no stock is dropped\u2026';
      }
    }, 1000);
    try {
      var payload = await swingComputeAllVerdicts(function (done, total, last) {
        if (!last.ok) failed++;
        var pct = total > 0 ? Math.round((done / total) * 100) : 0;
        var elapsedS = Math.round((Date.now() - startedAt) / 1000);
        var etaTxt = '';
        if (done > 5 && done < total) {
          var perStock = (Date.now() - startedAt) / done;
          var etaS = Math.round(perStock * (total - done) / 1000);
          etaTxt = ' \u00b7 ETA ~' + Math.ceil(etaS / 60) + 'm';
        }
        var progTxt = 'Computing ' + done + ' / ' + total
          + ' (' + pct + '%) \u00b7 ' + failed + ' failed \u00b7 '
          + Math.floor(elapsedS / 60) + 'm ' + (elapsedS % 60) + 's elapsed'
          + etaTxt + ' \u00b7 last: ' + last.sym;
        var pBar  = document.getElementById('sw-verdicts-progress');
        var pFill = document.getElementById('sw-verdicts-progress-fill');
        var pTxt  = document.getElementById('sw-verdicts-progress-text');
        if (pFill) {
          pFill.classList.remove('sw-today-progress-fill--start');
          pFill.style.width = pct + '%';
        }
        if (pBar) pBar.setAttribute('aria-valuenow', String(pct));
        if (pTxt) { pTxt.textContent = progTxt; }
        else { status.textContent = progTxt; }
      }, verdictMode, marketOpen, scanTf, scanScope);

      // Primary save path — straight into localStorage. The user
      // never has to move a file. Quota issues fall back to a
      // trimmed payload; if even that fails (extremely rare) we
      // surface a warning but still treat the compute as a
      // success so the user can manually Export JSON.
      var saved = swingSaveVerdictsLocal(payload);

      // Re-paint the tile — this replaces the empty-state CTA
      // (or the previous populated state) with the fresh BUY
      // rows. Importantly, this also replaces the button + status
      // elements we've been writing to, so we re-fetch them by id
      // afterwards to paint the success status.
      renderTodaySetups();
      var newStatus = document.getElementById('sw-verdicts-tool-status');
      if (newStatus) {
        newStatus.hidden = false;
        newStatus.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-done';
        newStatus.innerHTML = ''
          + '<strong>Done.</strong> '
          + payload.succeeded + ' / ' + payload.universeSize + ' computed \u00b7 '
          + (payload.scanTf ? '<strong>' + escapeHtml(SW_TF_LABEL[payload.scanTf] || payload.scanTf) + '</strong> \u00b7 ' : '')
          + '<span style="color:var(--bull)">' + payload.buyCount + ' BUY</span> \u00b7 '
          + payload.waitCount + ' WAIT \u00b7 '
          + payload.avoidCount + ' AVOID \u00b7 '
          + (payload.insufficientHistory ? payload.insufficientHistory + ' too new \u00b7 ' : '')
          + payload.failed + ' failed.'
          + (payload.excludedTooNew ? ' (' + payload.excludedTooNew + ' newly-listed name'
            + (payload.excludedTooNew === 1 ? '' : 's') + ' pre-skipped.)' : '')
          + (saved
            ? ' Saved in your browser \u2014 setups are listed above.'
            : ' Storage quota was exceeded \u2014 click <button type="button" class="sw-today-btn-link" onclick="swingExportVerdicts()">Export JSON</button> to download a backup.')
          + (_ptAutoPaused ? ' Live feeds resumed.' : '');
      }
    } catch (e) {
      status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-err';
      status.textContent = 'Failed: ' + (e && e.message || e)
        + (_ptAutoPaused ? ' \u00b7 Live feeds resumed.' : '');
      btn.disabled = false;
      btn.textContent = origLabel || 'Retry';
    } finally {
      _swBulkScanInFlight = false;
      if (_throttleHeartbeat) { clearInterval(_throttleHeartbeat); _throttleHeartbeat = null; }
      // Resume the live chart + option polling we auto-paused for
      // the scan. Only toggle back if WE paused it and it's still
      // paused (the user may have resumed manually mid-scan, in
      // which case we leave their choice intact).
      if (_ptAutoPaused
          && typeof window.ptIsApiPaused === 'function'
          && typeof window.ptToggleApiPause === 'function'
          && window.ptIsApiPaused()) {
        try { window.ptToggleApiPause(); } catch (_) {}
      }
    }
  };

  // Retry ONLY the rows that failed in the last scan, then merge the
  // results back into the saved payload. Surfaced as a "Retry N failed"
  // button in the results header whenever there are non-skipped failures.
  //
  // Why this exists: a bulk scan of a few hundred names can leave a
  // handful "failed" — almost always transient rate-limit hits (now
  // labelled "Rate-limited"), occasionally a network blip. Re-running
  // the WHOLE universe to recover 80 of 200 names wastes the API budget
  // and time. This re-fetches just the stragglers (same engine, same
  // regime/TF/mode/scope), keeps the 120 that already succeeded, and
  // splices the recovered rows into place — counts + ordering update so
  // a newly-recovered BUY jumps to the top. Price-band SKIPS are NOT
  // retried (deterministic — they'd just fail again and burn calls).
  window.swingRetryFailed = async function () {
    var payload = swingLoadVerdictsLocal();
    var status = document.getElementById('sw-verdicts-tool-status');
    var btn = document.getElementById('sw-verdicts-retry-btn');
    if (!payload || !payload.verdicts) return;

    if (_swBulkScanInFlight) {
      if (status) {
        status.hidden = false;
        status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-run';
        status.textContent = 'A scan is already running \u2014 let it finish first.';
      }
      return;
    }

    // Only transient failures are retryable. Price-band SKIPS and
    // newly-listed / insufficient-history names are deterministic — a
    // re-scan would just fail them the same way and burn API calls.
    var failedRows = payload.verdicts.filter(function (v) {
      return !v.ok && !v.skipped && !v.insufficientHistory;
    });
    if (!failedRows.length) {
      if (status) {
        status.hidden = false;
        status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-done';
        status.textContent = 'Nothing to retry \u2014 no rate-limited / transient failures in the last scan.';
      }
      return;
    }
    var subset = failedRows.map(function (v) {
      return { isin: v.isin, sym: v.sym, name: v.name, groups: v.groups || [] };
    });

    if (!getToken()) {
      if (status) {
        status.hidden = false;
        status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-err';
        status.textContent = 'No Upstox token connected. Open the Options Trading tab \u2192 gear icon and paste a fresh token.';
      }
      return;
    }

    var marketOpen = typeof window.isMarketOpen === 'function' && window.isMarketOpen();

    // Same shared-budget courtesy as the full scan: pause live feeds
    // during the retry if the market is open, resume after.
    var _ptAutoPaused = false;
    if (marketOpen
        && typeof window.ptIsApiPaused === 'function'
        && typeof window.ptToggleApiPause === 'function'
        && !window.ptIsApiPaused()) {
      try { window.ptToggleApiPause(); _ptAutoPaused = true; } catch (_) {}
    }

    var origLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Retrying\u2026'; }
    if (status) {
      status.hidden = false;
      status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-run';
      status.innerHTML = ''
        + '<div class="sw-today-progress" role="progressbar"'
        +   ' id="sw-verdicts-progress" aria-valuemin="0" aria-valuemax="100"'
        +   ' aria-valuenow="0">'
        +   '<div class="sw-today-progress-track">'
        +     '<div class="sw-today-progress-fill sw-today-progress-fill--start"'
        +       ' id="sw-verdicts-progress-fill" style="width:0%"></div>'
        +   '</div>'
        +   '<div class="sw-today-progress-text" id="sw-verdicts-progress-text">'
        +     'Retrying ' + subset.length + ' failed\u2026'
        +   '</div>'
        + '</div>';
    }

    var failedNow = 0;
    var startedAt = Date.now();
    _swBulkScanInFlight = true;
    try {
      var retryPayload = await swingComputeAllVerdicts(function (done, total, last) {
        if (!last.ok) failedNow++;
        var pct = total > 0 ? Math.round((done / total) * 100) : 0;
        var elapsedS = Math.round((Date.now() - startedAt) / 1000);
        var progTxt = 'Retrying ' + done + ' / ' + total
          + ' (' + pct + '%) \u00b7 ' + failedNow + ' still failing \u00b7 '
          + Math.floor(elapsedS / 60) + 'm ' + (elapsedS % 60) + 's \u00b7 last: ' + last.sym;
        var pFill = document.getElementById('sw-verdicts-progress-fill');
        var pBar  = document.getElementById('sw-verdicts-progress');
        var pTxt  = document.getElementById('sw-verdicts-progress-text');
        if (pFill) { pFill.classList.remove('sw-today-progress-fill--start'); pFill.style.width = pct + '%'; }
        if (pBar) pBar.setAttribute('aria-valuenow', String(pct));
        if (pTxt) pTxt.textContent = progTxt;
      }, payload.verdictMode, marketOpen, payload.scanTf, payload.scanScope, subset);

      // Merge: replace each retried row in-place by ISIN. Rows that
      // weren't part of the retry are left exactly as they were.
      var byIsin = Object.create(null);
      (retryPayload.verdicts || []).forEach(function (v) { byIsin[v.isin] = v; });
      var recovered = 0;
      payload.verdicts = (payload.verdicts || []).map(function (v) {
        var r = byIsin[v.isin];
        if (!r) return v;
        if (!v.ok && r.ok) recovered++;
        return r;
      });

      // Re-order + re-tally so a recovered BUY climbs to the top and the
      // header/filter counts reflect the merged set.
      _swRankVerdicts(payload.verdicts);
      var counts = _swCountVerdicts(payload.verdicts);
      payload.succeeded  = counts.succeeded;
      payload.failed     = counts.failed;
      payload.skipped    = counts.skipped;
      payload.insufficientHistory = counts.insufficientHistory;
      payload.buyCount   = counts.buyCount;
      payload.waitCount  = counts.waitCount;
      payload.avoidCount = counts.avoidCount;
      payload.lastRetryAt = new Date().toISOString();

      var saved = swingSaveVerdictsLocal(payload);
      renderTodaySetups();

      var newStatus = document.getElementById('sw-verdicts-tool-status');
      if (newStatus) {
        newStatus.hidden = false;
        newStatus.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-done';
        newStatus.innerHTML = ''
          + '<strong>Retry done.</strong> '
          + '<span style="color:var(--bull)">' + recovered + ' recovered</span> \u00b7 '
          + counts.failed + ' still failing'
          + (counts.failed
            ? ' \u2014 these are usually still rate-limited; wait a minute and click <strong>Retry</strong> again.'
            : ' \u2014 all clear.')
          + (saved ? '' : ' (storage quota exceeded \u2014 Export JSON to back up.)')
          + (_ptAutoPaused ? ' Live feeds resumed.' : '');
      }
    } catch (e) {
      if (status) {
        status.className = 'sw-verdicts-tool-status sw-verdicts-tool-status-err';
        status.textContent = 'Retry failed: ' + (e && e.message || e)
          + (_ptAutoPaused ? ' \u00b7 Live feeds resumed.' : '');
      }
      if (btn) { btn.disabled = false; btn.textContent = origLabel || 'Retry failed'; }
    } finally {
      _swBulkScanInFlight = false;
      if (_ptAutoPaused
          && typeof window.ptIsApiPaused === 'function'
          && typeof window.ptToggleApiPause === 'function'
          && window.ptIsApiPaused()) {
        try { window.ptToggleApiPause(); } catch (_) {}
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // RENDERING
  // ═══════════════════════════════════════════════════════════════
  function setText(id, txt) { var el = $(id); if (el) el.textContent = txt; }

  function biasClass(trendOrBias) {
    if (!trendOrBias) return 'sw-neutral';
    if (trendOrBias === 'RANGE') return 'sw-neutral';
    if (trendOrBias.indexOf('BULL') >= 0) return 'sw-bull';
    if (trendOrBias.indexOf('BEAR') >= 0) return 'sw-bear';
    return 'sw-neutral';
  }

  function shortTrend(t) {
    if (t === 'STRONG_BULL') return 'STRONG UP';
    if (t === 'BULL') return 'UP';
    if (t === 'STRONG_BEAR') return 'STRONG DOWN';
    if (t === 'BEAR') return 'DOWN';
    if (t === 'RANGE') return 'RANGE';
    return 'NEUTRAL';
  }

  // shortTrend() prefixed with a directional triangle so trend
  // direction reads at a glance from the TEXT alone — not just
  // from colour. Matches the convention already used by the BN
  // pill (\u25B2 STRONG UP / \u25BC STRONG DOWN). NEUTRAL stays
  // arrowless because a sideways glyph would add visual noise
  // without conveying anything the word "NEUTRAL" doesn't
  // already say. Helpful for colour-blind users, mono printers
  // and dim-mode screens. RANGE gets a sideways arrow (↔) since
  // that IS the most informative glyph for chop ("price oscillates
  // either way") — exception to the no-arrow-for-neutral rule.
  function shortTrendArrow(t) {
    var label = shortTrend(t);
    if (t === 'STRONG_BULL' || t === 'BULL') return '\u25B2 ' + label;
    if (t === 'STRONG_BEAR' || t === 'BEAR') return '\u25BC ' + label;
    if (t === 'RANGE') return '\u2194 ' + label;
    return label;
  }

  function showLoading(msg) {
    // Tear down any existing chart before we flip sw-result hidden.
    // disposeMainChart also stops live polling, so we cleanly leave
    // any in-flight ticks behind before fetching a new analysis.
    disposeMainChart();
    STATE.chartFetching = {};
    STATE.livePoll.lastSyncMs = 0;
    setLiveBadge('', '');
    // Reset chart-title to the stock that's about to be analyzed
    // (gives instant visual feedback even before the first candle
    // arrives — the loading spinner shows under the symbol).
    var pending = STATE.selected;
    setText('sw-chart-title-sym', pending && pending.sym ? pending.sym : '\u2014');
    setText('sw-chart-title-name', pending && pending.name ? pending.name : '');
    var emp = $('sw-empty'); if (emp) emp.hidden = true;
    var res = $('sw-result'); if (res) res.hidden = true;
    var err = $('sw-error'); if (err) err.hidden = true;
    var ld = $('sw-loading'); if (ld) ld.hidden = false;
    setText('sw-loading-text', msg);
  }

  function showError(title, msg) {
    var emp = $('sw-empty'); if (emp) emp.hidden = true;
    var ld = $('sw-loading'); if (ld) ld.hidden = true;
    var res = $('sw-result'); if (res) res.hidden = true;
    var err = $('sw-error'); if (err) err.hidden = false;
    setText('sw-error-title', title);
    setText('sw-error-msg', msg);
  }

  // ── Verdict Rules Engine (data-driven from data/verdict-rules.json) ──
  var _verdictRules = null;
  var _verdictRulesLoading = false;

  function _loadVerdictRules(cb) {
    if (_verdictRules) { if (cb) cb(_verdictRules); return; }
    if (_verdictRulesLoading) { setTimeout(function () { _loadVerdictRules(cb); }, 100); return; }
    _verdictRulesLoading = true;
    fetch('data/verdict-rules.json', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (json) {
        _verdictRules = json;
        _verdictRulesLoading = false;
        if (cb) cb(json);
      })
      .catch(function () {
        _verdictRulesLoading = false;
        console.warn('[swing] Failed to load verdict-rules.json, using inline fallback');
      });
  }
  _loadVerdictRules(null);

  // ── Days-to-target empirical table (data/days-to-target-table.json) ──
  // Built by scripts/backtest/calibrate-days-to-target.mjs from REAL scan-
  // verdict BUYs (point-in-time, no lookahead): per TF × R-multiple it gives
  // the conditional median bars-to-touch (+ p25/p75) AND the reach-PROBABILITY
  // (the engine's true edge). The card prefers this over the ATR×efficiency
  // formula; if the fetch fails the formula is the safe fallback (so behaviour
  // degrades to the prior, already-calibrated estimate — never to nothing).
  var _dttTable = null;
  var _dttLoading = false;
  function _loadDttTable(cb) {
    if (_dttTable) { if (cb) cb(_dttTable); return; }
    if (_dttLoading) { setTimeout(function () { _loadDttTable(cb); }, 100); return; }
    _dttLoading = true;
    fetch('data/days-to-target-table.json', { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        // File shape is { meta, table: { tf: { "1d": {...}, "1w": {...} } } }.
        // Normalise to the TF-keyed map so _dttKnots(tf) reads _dttTable[tf].
        var root = (j && j.table) ? j.table : j;
        _dttTable = (root && root.tf) ? root.tf : root;
        _dttLoading = false;
        if (cb) cb(_dttTable);
      })
      .catch(function () {
        _dttLoading = false;
        console.warn('[swing] days-to-target table load failed; using ATR formula fallback');
      });
  }
  _loadDttTable(null);

  function _colorToClass(color) {
    if (color === 'green') return 'sw-bull';
    if (color === 'red') return 'sw-bear';
    if (color === 'amber') return 'sw-warn';
    return 'sw-neutral';
  }

  // ── Pattern modifier layer (data-driven; verdict-rules.json
  // `patternModifiers` + docs/*-verdict-scenarios.md) ──────────────────
  // Candlestick + geometric chart patterns are layered ON TOP of the fib/zoi
  // base verdict. They can (a) UPGRADE a BUY's conviction → STRONG BUY (via the
  // existing confluence A+/A/B tier), or (b) DEMOTE a BUY to CAUTION on a HARD
  // bearish confirmation (a CONFIRMED-LIVE bearish chart pattern, or a Tier-1
  // bearish reversal candle printed at the entry). They NEVER turn a non-BUY
  // (WAIT/WATCH/AVOID/SKIP) into a BUY — location + structure must already
  // allow the long (false-positive guard, per .cursor/rules/trading-context.mdc:
  // false-negatives over false-positives). The hard LOCATION vetoes (supply /
  // broken-demand / swing-high) are already AVOID inside fibOnly/zoiOnly/
  // fibZoiCombined, so this layer only adds the pattern (trigger + structure)
  // dimension. No-op (v4-identical behaviour) when rules are missing/disabled
  // or no pattern context was gathered.

  // Gather the pattern dimension for THIS tf from the already-computed per-TF
  // analysis (`an.patternBull`/`an.patternBear` — the SAME classifier the cards
  // + chart arrows use, so there is no second drifting detection) plus, on the
  // single-stock card path only (`withChart`), the geometric chart pattern via
  // window.ChartPatterns.detect(raw, tf). Chart detection is skipped on the
  // universe SCAN path to keep it fast. Returns null when nothing actionable
  // was found (→ the modifier is a no-op).
  function _buildPatternContext(an, raw, tf, withChart) {
    var pm = _verdictRules && _verdictRules.patternModifiers;
    if (!pm || pm.enabled === false) return null;
    var cfg = pm.candle || {};
    var t1Bull = cfg.tier1Bull || [];
    var t1Bear = cfg.tier1Bear || [];
    var ctx = {
      candleTier1Bull: false, candleTier1Bear: false, candleBullName: null, candleBearName: null,
      chartConfirmedBull: false, chartConfirmedBear: false, chartBullName: null, chartBearName: null
    };
    var cBull = an && an.patternBull;
    var cBear = an && an.patternBear;
    if (cBull && t1Bull.indexOf(cBull) >= 0) { ctx.candleTier1Bull = true; ctx.candleBullName = cBull; }
    if (cBear && t1Bear.indexOf(cBear) >= 0) { ctx.candleTier1Bear = true; ctx.candleBearName = cBear; }

    if (withChart && raw && raw.length >= 4 &&
        typeof window !== 'undefined' && window.ChartPatterns &&
        typeof window.ChartPatterns.detect === 'function') {
      try {
        var rows = window.ChartPatterns.detect(raw, tf) || [];
        var bestBull = null, bestBear = null;
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          // Only a CONFIRMED + still-LIVE pattern is an actionable signal.
          // PENDING (WATCH) is a setup, not a trigger; WORKED/FAILED are history.
          if (r.state !== 'CONFIRMED' || r.outcome !== 'LIVE') continue;
          if (r.dir === 'bull') { if (!bestBull || (r.confirmIdx || 0) > (bestBull.confirmIdx || 0)) bestBull = r; }
          else if (r.dir === 'bear') { if (!bestBear || (r.confirmIdx || 0) > (bestBear.confirmIdx || 0)) bestBear = r; }
        }
        if (bestBull) { ctx.chartConfirmedBull = true; ctx.chartBullName = bestBull.name || bestBull.short || 'chart pattern'; }
        if (bestBear) { ctx.chartConfirmedBear = true; ctx.chartBearName = bestBear.name || bestBear.short || 'chart pattern'; }
      } catch (_) { /* chart-pattern module optional — fail safe to candle-only */ }
    }

    if (!ctx.candleTier1Bull && !ctx.candleTier1Bear && !ctx.chartConfirmedBull && !ctx.chartConfirmedBear) return null;
    return ctx;
  }

  // Apply the pattern modifier to a resolved verdict. Mutates+returns `result`.
  // `gate` is annotated with bullish-pattern flags so _computeConfluence folds
  // them into the A+/A/B tier (→ STRONG BUY). Only ever touches a BUY.
  function _applyPatternModifiers(result, ctx, gate) {
    var pm = _verdictRules && _verdictRules.patternModifiers;
    if (!pm || pm.enabled === false || !ctx || !result || result.text !== 'BUY') return result;
    var onBuy = pm.onBuy || {};

    // (a) HARD bearish confirmation DEMOTES the BUY. A confirmed topping
    //     structure outranks a swing-level buy zone; a fresh Tier-1 bearish
    //     reversal at the entry means sellers just stepped in — stand aside.
    if (ctx.chartConfirmedBear && onBuy.chartConfirmedBearDemote) {
      var d = onBuy.chartConfirmedBearDemote;
      var was = result.sub;
      result.text = d.to || 'CAUTION';
      result.cls = _colorToClass(d.color || 'amber');
      result.sub = (d.reason || 'confirmed bearish chart pattern').replace('{name}', ctx.chartBearName || 'chart pattern')
        + (was ? ' \u2014 was: ' + was : '');
      result._demotedByPattern = true;
      return result;
    }
    if (ctx.candleTier1Bear && onBuy.candleTier1BearDemote) {
      var d2 = onBuy.candleTier1BearDemote;
      var was2 = result.sub;
      result.text = d2.to || 'CAUTION';
      result.cls = _colorToClass(d2.color || 'amber');
      result.sub = (d2.reason || 'Tier-1 bearish reversal candle at the entry').replace('{name}', ctx.candleBearName || 'bearish candle')
        + (was2 ? ' \u2014 was: ' + was2 : '');
      result._demotedByPattern = true;
      return result;
    }

    // (b) Bullish pattern confluence — feed the tier + flag STRONG BUY.
    if (gate) {
      if (ctx.chartConfirmedBull) gate.chartConfirmedBull = ctx.chartBullName || true;
      if (ctx.candleTier1Bull) gate.candleTier1Bull = ctx.candleBullName || true;
    }
    if ((ctx.chartConfirmedBull && onBuy.chartConfirmedBullStrong) ||
        (ctx.candleTier1Bull && onBuy.candleTier1BullStrong)) {
      result.strongBuy = true;
    }
    return result;
  }

  function _interpolateTemplate(tpl, vars) {
    if (!tpl) return '';
    return tpl.replace(/\{(\w+)\}/g, function (_, key) {
      return vars[key] !== undefined ? vars[key] : '{' + key + '}';
    });
  }

  function _matchFibClass(ruleVal, actual) {
    if (Array.isArray(ruleVal)) return ruleVal.indexOf(actual) >= 0;
    return ruleVal === actual;
  }

  // Geometric relationship between the fib golden pocket band
  // [fib786..fib618] and the nearest ZOI zone band [distal..proximal].
  // This is the THIRD matching axis (alongside fibClass + zoiPosition)
  // the combined v4 rules key on. It separates TRUE confluence —
  // OVERLAP, where the pocket and the zone sit on the SAME price band
  // (one high-conviction level) — from a pocket that sits ABOVE or
  // BELOW the zone (two distinct levels that only happen to be in the
  // same chart). Returns 'N/A' when there is no zone band to compare
  // against (price BETWEEN zones) or the fib band is unavailable, which
  // matches the 'N/A' geometry used by the BETWEEN rules. Order-agnostic
  // on both bands; pure (no side effects).
  function _pocketVsZone(hasFib, hasZoi, fibResult, zoiPos) {
    if (!hasFib || !hasZoi || !fibResult || !zoiPos || !zoiPos.zone) return 'N/A';
    var a = fibResult.fib786, b = fibResult.fib618;
    if (!isFinite(a) || !isFinite(b)) return 'N/A';
    var pocLo = Math.min(a, b), pocHi = Math.max(a, b);
    var z = zoiPos.zone;
    var zLo = Math.min(z.distal, z.proximal), zHi = Math.max(z.distal, z.proximal);
    if (!isFinite(zLo) || !isFinite(zHi)) return 'N/A';
    if (pocLo <= zHi && zLo <= pocHi) return 'OVERLAP';   // bands intersect → confluence
    return pocHi < zLo ? 'POCKET_BELOW' : 'POCKET_ABOVE';
  }

  // Public entry: resolve the PURE-RULES geometry verdict, then attach
  // (never apply as a veto) the risk context. `gate` is optional — when
  // omitted, behaves exactly like the old pure-geometry resolver.
  function _resolveVerdict(fibClass, fibTouchedZone, bounceStatus, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf, gate, pocketVsZone, patternCtx) {
    var result = _resolveVerdictCore(fibClass, fibTouchedZone, bounceStatus, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf, pocketVsZone);
    result = _collectRiskContext(result, gate);
    // Pattern modifier layer (candlestick + chart patterns). Runs BEFORE the
    // BUY-prefix block so a hard bearish confirmation can demote BUY→CAUTION
    // (and a bullish pattern can flag STRONG BUY) before the label is built.
    // No-op when disabled / no pattern context (v4-identical behaviour).
    result = _applyPatternModifiers(result, patternCtx, gate);
    // Confluence is computed for EVERY verdict (not just BUY) so the setups
    // table can rank BUY rows by it. _computeConfluence omits the base-40 BUY
    // credit when this isn't a BUY, so the raw bullish-tailwind sum stays the
    // number we sort BUYs by.
    if (gate) result.confluence = _computeConfluence(gate, result.text === 'BUY');
    // VERDICT-RELATIVE CONVICTION (display only — never alters the verdict).
    // Every row gets a {level, label} so the setups table renders dots + a
    // word uniformly (no naked % on BUY competing with the word cells).
    //   • non-BUY → the call we actually made ("how sure to AVOID / that
    //     there's no edge"), keyed to the situation so it matches the setup.
    //   • BUY → the bullish-confluence TIER mapped to strong/good/fair; the
    //     exact score still rides in the tooltip and ranks the BUYs.
    if (gate && result.text !== 'BUY') {
      var _zPos = (hasZoi && zoiPos) ? zoiPos.position : null;
      result.conviction = _computeConviction(result.text, result.confluence, _computeBearishness(gate), _zPos, fibClass, hasZoi);
    } else if (gate && result.text === 'BUY') {
      result.conviction = _computeBuyConviction(result.confluence);
    }
    // Every BUY now states its BASIS + TIMEFRAME up front, and is ranked
    // by confluence so the trader knows which BUY to look at first. A
    // pattern-backed BUY reads "STRONG BUY" (same green, higher conviction).
    if (result.text === 'BUY') {
      var basis = (hasFib && hasZoi) ? 'FIB+ZOI' : (hasFib ? 'FIB' : (hasZoi ? 'ZOI' : ''));
      var tfLabel = SW_TF_LABEL[tf] || tf || '';
      var verdictWord = result.strongBuy ? 'STRONG BUY' : 'BUY';
      var prefix = verdictWord + (basis ? ' \u00b7 ' + basis : '') + (tfLabel ? ' (' + tfLabel + ')' : '');
      result.sub = prefix + (result.sub ? ' \u2014 ' + result.sub : '');
      if (gate) {
        if (result.confluence) {
          result.tip = (result.tip ? result.tip + '\n\n' : '')
            + 'Confluence ' + result.confluence.tier + ' (' + result.confluence.score + '/100):\n\u2022 '
            + result.confluence.factors.join('\n\u2022 ');
        }
        // Risks to weigh (informational — the BUY stands regardless).
        if (result.riskFlags && result.riskFlags.length) {
          result.tip = (result.tip ? result.tip + '\n\n' : '')
            + 'Risks to weigh (do NOT auto-veto \u2014 your call):\n\u2022 '
            + result.riskFlags.join('\n\u2022 ');
        }
      }
    }
    return result;
  }

  // Positive confluence score for a gated BUY. Pure geometry already
  // got it to BUY and the gate cleared it of red flags — this layer
  // counts how many INDEPENDENT tailwinds stack behind it (fresh zone,
  // FVG/pocket overlap, bullish structure, volume, R:R, HTF trend).
  // Returns { score: 0–100, tier: 'A+'|'A'|'B', factors: string[] }.
  function _computeConfluence(gate, isBuy) {
    if (!gate) return null;
    // Base credit (40) + the "rules-confirmed BUY" factor apply ONLY to an
    // actual BUY. For non-BUY rows (WAIT / AVOID / SKIP) the score starts at
    // 0 and only counts whatever bullish tailwinds happen to be present, so a
    // non-actionable row reads genuinely low — it is NOT a buy signal. The
    // SUGGESTION badge remains the source of truth for what to do.
    var score = isBuy ? 40 : 0;           // base: a rules-confirmed BUY
    var factors = isBuy ? ['rules-confirmed BUY (Fib/ZOI geometry)'] : [];

    if (gate.zoneFreshness === 'FRESH') { score += 15; factors.push('fresh demand zone'); }
    else if (gate.zoneFreshness === 'TESTED') { factors.push('demand zone tested ' + (gate.zoneTestCount || 1) + '\u00d7'); }

    // FVG confluence. The premium case is an FVG that OVERLAPS the
    // golden pocket (OTE + imbalance on the same price) — worth more
    // than a generic FVG sitting somewhere below. The two are mutually
    // exclusive so we never double-count the same gap.
    if (gate.pocketFvg) { score += 22; factors.push('OTE + FVG overlap (golden pocket = institutional gap)'); }
    else if (gate.bullFvgSupport) { score += 15; factors.push('unfilled bullish FVG support below'); }

    // Liquidity-sweep reclaim — an independent "trigger" tailwind: price
    // ran the stops below a level then reversed up and reclaimed it.
    // Counted on top of any FVG (different signal), capped by the clamp.
    if (gate.liqSweepSupport) { score += 12; factors.push('bullish liquidity-sweep reclaim (stop-hunt then recovery at support)'); }

    if (gate.smcTrend === 'BULLISH') { score += 12; factors.push('bullish market structure'); }
    else if (gate.smcLastBreak && gate.smcLastBreak.type === 'BOS' && gate.smcLastBreak.direction === 'BULL') { score += 8; factors.push('recent bullish BOS'); }

    if (gate.volRatio != null && isFinite(gate.volRatio) && gate.volRatio >= 1.5) { score += 10; factors.push('strong volume (' + gate.volRatio.toFixed(1) + '\u00d7 avg)'); }
    else if (gate.volConfirm === true) { score += 4; factors.push('volume confirmed'); }

    if (gate.rr != null && isFinite(gate.rr)) {
      if (gate.rr >= 2.5) { score += 10; factors.push('R:R ' + gate.rr.toFixed(1) + 'R'); }
      else if (gate.rr >= 2.0) { score += 5; factors.push('R:R ' + gate.rr.toFixed(1) + 'R'); }
    }

    var _tfLbl = (SW_TF_LABEL[gate.tf] || gate.tf || 'TF').toLowerCase();
    if (gate.weeklyTrend === 'STRONG_BULL') { score += 6; factors.push('strong ' + _tfLbl + ' uptrend'); }
    else if (gate.weeklyTrend === 'BULL') { score += 3; factors.push(_tfLbl + ' uptrend'); }
    if (gate.regime === 'BULL') { score += 4; factors.push('bullish market regime'); }

    // Pattern confluence (set by _applyPatternModifiers). A CONFIRMED-LIVE
    // bullish chart pattern (structural) and/or a Tier-1 bullish reversal
    // candle (trigger) are independent tailwinds that push a BUY toward the
    // A+ tier → "STRONG BUY". Bonuses are data-driven (patternModifiers).
    var _pmBonus = (_verdictRules && _verdictRules.patternModifiers && _verdictRules.patternModifiers.confluenceBonus) || {};
    if (gate.chartConfirmedBull) {
      score += (_pmBonus.chartConfirmedBull != null ? _pmBonus.chartConfirmedBull : 18);
      factors.push('confirmed bullish chart pattern' + (typeof gate.chartConfirmedBull === 'string' ? ' (' + gate.chartConfirmedBull + ')' : ''));
    }
    if (gate.candleTier1Bull) {
      score += (_pmBonus.candleTier1Bull != null ? _pmBonus.candleTier1Bull : 10);
      factors.push('Tier-1 bullish reversal candle' + (typeof gate.candleTier1Bull === 'string' ? ' (' + gate.candleTier1Bull + ')' : ''));
    }

    score = Math.max(0, Math.min(100, score));
    var tier = score >= 80 ? 'A+' : (score >= 62 ? 'A' : 'B');
    return { score: score, tier: tier, factors: factors };
  }

  // Bearish / headwind tally (0–100) — the mirror of _computeConfluence,
  // built from the SAME gate features _collectRiskContext surfaces as
  // "risks to weigh". Used only to give non-BUY rows a verdict-relative
  // conviction (see _computeConviction); it never gates or vetoes a BUY.
  function _computeBearishness(gate) {
    if (!gate) return { score: 0, factors: [] };
    var score = 0, factors = [];
    if (gate.weeklyTrend === 'STRONG_BEAR') { score += 22; factors.push('strong downtrend'); }
    else if (gate.weeklyTrend === 'BEAR') { score += 14; factors.push('downtrend'); }
    else if (gate.weeklyTrend === 'NEUTRAL') { score += 4; factors.push('flat trend (no confirmed up)'); }
    if (gate.smcTrend === 'BEARISH') { score += 16; factors.push('bearish market structure'); }
    else if (gate.smcLastBreak && gate.smcLastBreak.type === 'CHOCH' && gate.smcLastBreak.direction === 'BEAR') { score += 10; factors.push('bearish CHoCH'); }
    if (gate.regime === 'BEAR') { score += 10; factors.push('bearish market regime'); }
    if (gate.zoneTestCount != null && gate.zoneTestCount >= 3) { score += 8; factors.push('demand zone worn out (' + gate.zoneTestCount + ' tests)'); }
    if (gate.volRatio != null && isFinite(gate.volRatio) && gate.volRatio < 0.7) { score += 6; factors.push('weak volume (' + gate.volRatio.toFixed(1) + '\u00d7 avg)'); }
    score = Math.max(0, Math.min(100, score));
    return { score: score, factors: factors };
  }

  // SITUATION → conviction word + dot level for a NON-BUY row. The WORD must
  // describe the SAME situation the SETUP + REASONING columns show (so a
  // "FAR ABOVE DEMAND / extended, don't chase" row never reads "no edge" on
  // one stock and "watch" on another). Keyed on the canonical zoiPosition
  // (ZOI / FIB+ZOI) or fibClass (FIB-only) — NOT on a magnitude, so identical
  // setups always render identically. The DOT LEVEL = how firmly to stay out:
  //   1 = near actionable (one trigger away — keep an eye)
  //   2 = mid-range / unconfirmed (no edge here yet)
  //   3 = clearly stand aside (extended / rejecting / broken)
  var _CONV_ZOI = {
    FAR_ABOVE_DEMAND:               { word: 'don\u2019t chase', level: 3 },
    FAR_ABOVE_SUPPLY:               { word: 'extended',      level: 3 },
    BROKE_ABOVE_SUPPLY_RISING:      { word: 'extended',      level: 2 },
    BROKE_ABOVE_SUPPLY_FALLING:     { word: 'failed break',  level: 3 },
    NEAR_ABOVE_DEMAND_RISING:       { word: 'watch',         level: 1 },
    NEAR_ABOVE_DEMAND_FALLING:      { word: 'no entry yet',  level: 2 },
    IN_DEMAND_RISING:               { word: 'watch',         level: 1 },
    IN_DEMAND_CONSOLIDATING:        { word: 'basing',        level: 1 },
    IN_DEMAND_FALLING:              { word: 'testing support', level: 2 },
    RECOVERED_ABOVE_DEMAND_RISING:  { word: 'watch',         level: 1 },
    RECOVERED_INTO_DEMAND_RISING:   { word: 'watch',         level: 1 },
    STACKED_DEMAND_RISING:          { word: 'watch',         level: 1 },
    FAR_BELOW_SUPPLY_NEAR_DEMAND:   { word: 'near demand',   level: 1 },
    FAR_BELOW_SUPPLY_ABOVE_DEMAND:  { word: 'mid-range',     level: 2 },
    NEAR_BELOW_SUPPLY:              { word: 'at resistance', level: 2 },
    IN_SUPPLY_RISING:               { word: 'not confirmed', level: 2 },
    IN_SUPPLY_CONSOLIDATING:        { word: 'at resistance', level: 2 },
    IN_SUPPLY_FALLING:              { word: 'rejecting',     level: 3 },
    BROKE_BELOW_DEMAND:             { word: 'broke support', level: 3 },
    BETWEEN_ZONES:                  { word: 'no edge',       level: 3 }
  };
  var _CONV_FIB = {
    FAR_ABOVE_POCKET:           { word: 'don\u2019t chase', level: 3 },
    NEAR_ABOVE_POCKET_RISING:   { word: 'watch',         level: 1 },
    NEAR_ABOVE_POCKET_FALLING:  { word: 'no entry yet',  level: 2 },
    RECOVERED_ABOVE_POCKET:     { word: 'missed entry',  level: 2 },
    SHALLOW_ABOVE_POCKET:       { word: 'watch',         level: 2 },
    IN_POCKET_RISING:           { word: 'watch',         level: 1 },
    IN_POCKET_FALLING:          { word: 'no entry yet',  level: 2 },
    BELOW_POCKET_RISING:        { word: 'watch',         level: 2 },
    BELOW_POCKET_FALLING:       { word: 'falling',       level: 3 },
    AT_SWING_LOW_RISING:        { word: 'watch',         level: 1 },
    AT_SWING_LOW_FALLING:       { word: 'falling',       level: 3 },
    AT_SWING_HIGH:              { word: 'at resistance', level: 3 }
  };

  // Build the non-BUY conviction cell (display only — never alters the
  // verdict). `confluence` / `bearish` only enrich the tooltip; the WORD and
  // LEVEL come from the situation so they always agree with the row's setup.
  function _computeConviction(text, confluence, bearish, zoiPosition, fibClass, hasZoi) {
    var sit = (hasZoi && zoiPosition && _CONV_ZOI[zoiPosition]) ? _CONV_ZOI[zoiPosition]
            : (fibClass && _CONV_FIB[fibClass]) ? _CONV_FIB[fibClass]
            : { word: 'no edge', level: 2 };
    var B = (confluence && isFinite(confluence.score)) ? confluence.score : 0;
    var R = (bearish && isFinite(bearish.score)) ? bearish.score : 0;
    // Tooltip factors: a near-actionable "watch" leans on the bullish
    // tailwinds it's waiting to confirm; everything else lists the headwinds.
    var factors = (sit.level === 1 && confluence && confluence.factors && confluence.factors.length)
      ? confluence.factors.slice(0, 3)
      : ((bearish && bearish.factors) ? bearish.factors.slice() : []);
    return { level: sit.level, label: sit.word, dots: sit.level, factors: factors, bull: B, bear: R };
  }

  // Build the BUY conviction cell (display only — never alters the verdict).
  // BUYs are RANKED by the bullish-confluence score; this maps that score's
  // TIER to the SAME dots+word vocabulary the non-BUY rows use, so every row
  // in the setups table reads consistently (no naked % beside word cells).
  // The exact score still rides in the tooltip. Tiers mirror _computeConfluence:
  //   A+ (>=80) → 3 dots "strong"  ·  A (>=62) → 2 dots "good"  ·  B → 1 "fair".
  function _computeBuyConviction(confluence) {
    if (!confluence || !isFinite(confluence.score)) return null;
    var tier = confluence.tier;
    var level = tier === 'A+' ? 3 : (tier === 'A' ? 2 : 1);
    var label = tier === 'A+' ? 'strong' : (tier === 'A' ? 'good' : 'fair');
    var factors = (confluence.factors && confluence.factors.length) ? confluence.factors.slice(0, 3) : [];
    return { level: level, label: label, dots: level, factors: factors, score: confluence.score };
  }

  // Is there an unfilled BULLISH FVG acting as support at/below price?
  // A bullish gap that price is sitting inside, or just above (within
  // 8%), is a demand pocket of unfilled buy orders — extra confluence
  // under a long. fvgs: output of detectFVG (newest-first source).
  function _bullFvgSupport(fvgs, currentPx) {
    if (!fvgs || !fvgs.length || !isFinite(currentPx) || currentPx <= 0) return false;
    for (var i = 0; i < fvgs.length; i++) {
      var g = fvgs[i];
      if (g.type !== 'BULL') continue;
      if (g.fillPct != null && g.fillPct >= 50) continue;  // mitigated at CE (50%)
      var top = Math.max(g.top, g.bottom);
      var bot = Math.min(g.top, g.bottom);
      if (currentPx >= bot && currentPx <= top) return true;                 // price inside the gap
      if (top < currentPx && (currentPx - top) / currentPx <= 0.08) return true; // gap just below (<=8%)
    }
    return false;
  }

  // The premium confluence: does an unfilled BULLISH FVG OVERLAP the
  // fib golden pocket (the 61.8–80% "discount" / OTE zone)? When the
  // institutional imbalance and the deep-discount fib level land on the
  // SAME price, two independent reasons to turn up agree — the highest-
  // probability entry in the framework. pocketLo/pocketHi are the two
  // pocket boundaries (fib800 and fib618, order-agnostic).
  function _fvgInPocket(fvgs, pocketLo, pocketHi) {
    if (!fvgs || !fvgs.length || !isFinite(pocketLo) || !isFinite(pocketHi)) return false;
    var lo = Math.min(pocketLo, pocketHi), hi = Math.max(pocketLo, pocketHi);
    for (var i = 0; i < fvgs.length; i++) {
      var g = fvgs[i];
      if (g.type !== 'BULL') continue;
      if (g.fillPct != null && g.fillPct >= 50) continue;  // mitigated at CE (50%)
      var gTop = Math.max(g.top, g.bottom), gBot = Math.min(g.top, g.bottom);
      if (gBot <= hi && gTop >= lo) return true;            // ranges overlap
    }
    return false;
  }

  // Is there a recent BULLISH liquidity sweep acting as support under
  // price? A SWEEP_LOW is a confirmed stop-hunt below equal lows that
  // reversed UP (smart money grabbed sell-stops, then bought) — see
  // detectLiqSweeps. It supports a long when price has RECLAIMED the
  // swept level and now sits within 8% above it (the same proximity
  // window _bullFvgSupport uses). This is the "trigger" layer in the
  // confluence stack. liqSweeps: output of detectLiqSweeps (confirmed,
  // non-repainting, newest-first).
  function _liqSweepSupport(liqSweeps, currentPx) {
    if (!liqSweeps || !liqSweeps.length || !isFinite(currentPx) || currentPx <= 0) return false;
    for (var i = 0; i < liqSweeps.length; i++) {
      var s = liqSweeps[i];
      if (s.type !== 'SWEEP_LOW') continue;                 // bullish sweeps only
      var lvl = s.level;
      if (!isFinite(lvl) || lvl <= 0) continue;
      if (currentPx >= lvl && (currentPx - lvl) / currentPx <= 0.08) return true;
    }
    return false;
  }

  // ── Reward:Risk — MODE-NATIVE target, capped by structure ───────────
  // Entry is always the current confirmed price (where you'd buy now), so
  // the displayed R:R is "from here". The STOP and TARGET are derived from
  // the structure that actually defines each mode's setup, then sanity-
  // checked against real overhead resistance:
  //
  //   FIB      stop   = below the golden pocket (computeFibZone plan.sl)
  //            target = next fib level ABOVE the pocket top, climbing the
  //                     ladder fib500 → fib382 → fib236 → swing high (a level
  //                     INSIDE the pocket is the entry zone, never a target)
  //   ZOI      stop   = below the demand-zone DISTAL edge − ATR buffer
  //            target = NEAREST opposing SUPPLY zone proximal above the zone
  //   FIB+ZOI  stop   = the LOWER (more protective) of the two stops so a
  //                     wick through either edge doesn't auto-stop
  //            target = the NEAREST of {fib level, supply zone} above the zone
  //                     (the first objective both lenses agree price hits)
  //
  // ── Target floor (2026-06-05) ── Every target is floored at the ENTRY ZONE
  // TOP (golden-pocket 61.8% edge / demand-zone top), not the current tick. A
  // swing high INSIDE the zone is base structure (consolidation), NOT overhead
  // resistance, so it can neither BE the target nor cap it — anchoring on one
  // produced a degenerate target sitting inside the buy zone (R:R ~0).
  //
  // Universal fallbacks fill any anchor a mode can't supply (no fib plan /
  // no demand zone / no overhead supply): stop = most-recent confirmed
  // swing LOW below price − buffer (recent ~10-bar low if no pivot), and
  // target = nearest confirmed swing HIGH above the zone, else a 2R measured
  // move. A nearest swing high BELOW the chosen target CAPS it (never aim
  // through a wall). ATR(14)×0.25 buffer, floored at ~0.2% of price.
  //
  // Pivots use lookback-3 fractals (confirmed N bars either side → no
  // repaint), finer lookback-2 on short histories, so it works on monthly
  // / weekly series with as few as ~6 bars. Returns null — surfaced as
  // "n/a", never a guessed number — only when no structure can frame a
  // long (no support below entry, or no usable target above it).
  //
  // ctx = { mode:'FIB'|'ZOI'|'FIB_ZOI', fib:computeFibZone()|null,
  //         zones:detectZones()[]|null, demandZone:activeDemandZone|null }
  function _swStandardRR(raw, currentPx, ctx) {
    if (!raw || raw.length < 6 || !isFinite(currentPx) || currentPx <= 0) return null;
    ctx = ctx || {};
    var mode = (ctx.mode === 'FIB' || ctx.mode === 'ZOI' || ctx.mode === 'FIB_ZOI') ? ctx.mode : 'FIB_ZOI';
    var fib = ctx.fib || null;
    var zones = (ctx.zones && ctx.zones.length) ? ctx.zones : null;
    var demandZone = (ctx.demandZone && ctx.demandZone.type === 'DEMAND') ? ctx.demandZone : null;

    var c = raw.slice().reverse();          // oldest-first; higher idx = newer
    var n = c.length;
    var lb = (n >= 24) ? 3 : 2;             // finer lookback when data is short
    var lows = swingLows(c, lb);
    var highs = swingHighs(c, lb);

    // ATR(14) buffer, floored at ~0.2% of price.
    var atrVals = atr(c, 14);
    var atrLast = NaN;
    for (var a = atrVals.length - 1; a >= 0; a--) {
      if (isFinite(atrVals[a]) && atrVals[a] > 0) { atrLast = atrVals[a]; break; }
    }
    var buf = (isFinite(atrLast) && atrLast > 0) ? atrLast * 0.25 : currentPx * 0.002;

    // ── Universal structural anchors (fallback for every mode) ──
    // Most-recent confirmed swing low strictly below price = invalidation.
    var structLow = null;
    for (var i = lows.length - 1; i >= 0; i--) {
      if (lows[i].price < currentPx) { structLow = lows[i].price; break; }
    }
    if (structLow == null) {
      var recentLo = Infinity, look = Math.min(n, 10);
      for (var r = n - look; r < n; r++) { var lo = +c[r][3]; if (lo < recentLo) recentLo = lo; }
      if (isFinite(recentLo) && recentLo < currentPx) structLow = recentLo;
    }
    // ── Target floor — a long's first objective must clear the ENTRY ZONE,
    // not merely the current tick. The pocket 61.8% edge (FIB) / demand-zone
    // top (ZOI) is the floor: a swing high inside that band is base structure,
    // not a target or overhead resistance. When price has already run above the
    // zone the floor collapses to the current price (original behaviour). ──
    var targetFloor = currentPx;
    if (fib && isFinite(fib.fib618)) targetFloor = Math.max(targetFloor, fib.fib618);
    if (demandZone) {
      var _dTop = Math.max(demandZone.proximal, demandZone.distal);
      if (isFinite(_dTop)) targetFloor = Math.max(targetFloor, _dTop);
    }

    // Nearest confirmed swing high strictly above the ZONE TOP = real overhead
    // resistance / target cap (pivots inside the zone are deliberately ignored).
    var structHigh = null;
    for (var j = 0; j < highs.length; j++) {
      if (highs[j].price > targetFloor && (structHigh == null || highs[j].price < structHigh)) structHigh = highs[j].price;
    }

    // ── Mode-native anchor candidates ──
    // FIB target ladder: nearest fib level strictly above the ZONE TOP, so the
    // first objective clears the golden pocket — fib500 → fib382 → fib236 →
    // swing high. (targetFloor, computed below, is the pocket top when price is
    // in/below it, else the current price.) A fib level inside the pocket is the
    // buy zone itself, never a target.
    function _fibTarget() {
      if (!fib) return null;
      var cands = [];
      if (isFinite(fib.fib500)) cands.push(fib.fib500);
      if (isFinite(fib.fib382)) cands.push(fib.fib382);
      if (isFinite(fib.fib236)) cands.push(fib.fib236);
      if (isFinite(fib.swHigh)) cands.push(fib.swHigh);
      var best = null;
      for (var k = 0; k < cands.length; k++) {
        if (cands[k] > targetFloor && (best == null || cands[k] < best)) best = cands[k];
      }
      return best;
    }
    function _fibStop() {
      return (fib && fib.plan && isFinite(fib.plan.sl)) ? fib.plan.sl : null;
    }
    // ZOI target: nearest SUPPLY zone proximal (near edge) strictly above.
    function _supplyTarget() {
      if (!zones) return null;
      var best = null;
      for (var z = 0; z < zones.length; z++) {
        if (zones[z].type !== 'SUPPLY') continue;
        var prox = zones[z].proximal;       // supply proximal = bottom edge
        if (isFinite(prox) && prox > targetFloor && (best == null || prox < best)) best = prox;
      }
      return best;
    }
    function _zoiStop() {
      return (demandZone && isFinite(demandZone.distal)) ? demandZone.distal - buf : null;
    }
    function _nearestAbove(arr) {
      var best = null;
      for (var k = 0; k < arr.length; k++) {
        if (arr[k] != null && arr[k] > currentPx && (best == null || arr[k] < best)) best = arr[k];
      }
      return best;
    }

    var entry = currentPx, stop = null, t1 = null;
    if (mode === 'FIB') {
      stop = _fibStop();
      t1 = _fibTarget();
    } else if (mode === 'ZOI') {
      stop = _zoiStop();
      t1 = _supplyTarget();
    } else {                                // FIB_ZOI confluence
      var fSL = _fibStop(), zSL = _zoiStop();
      if (fSL != null && zSL != null) stop = Math.min(fSL, zSL);   // most-protective
      else stop = (fSL != null) ? fSL : zSL;
      t1 = _nearestAbove([_fibTarget(), _supplyTarget()]);          // nearest objective
    }

    // ── Fallbacks: fill any missing OR degenerate anchor from raw
    //    structure. A mode stop at/above entry (price below the demand
    //    zone, far above the pocket) or a target at/below entry counts as
    //    "the mode couldn't frame it" → defer to the universal pivots. ──
    if (stop != null && !(stop < entry)) stop = null;
    if (t1 != null && !(t1 > targetFloor)) t1 = null;
    if (stop == null && structLow != null && structLow - buf < entry) stop = structLow - buf;
    if (t1 == null && structHigh != null) t1 = structHigh;

    // ── Resistance cap: never aim THROUGH a confirmed swing high above the
    // zone (in-zone pivots were already excluded when structHigh was built). ──
    if (t1 != null && structHigh != null && structHigh < t1) t1 = structHigh;

    // ── Last-resort target: 2R measured move (only with a valid stop) ──
    if (t1 == null && stop != null && stop < entry) t1 = entry + 2 * (entry - stop);

    if (stop == null || !(stop < entry)) return null;
    // Target must clear the entry zone top — a target inside the buy zone is
    // degenerate (R:R ~0); fail safe to "no setup" rather than emit it.
    if (t1 == null || !(t1 > targetFloor)) return null;

    var risk = entry - stop;
    var reward = t1 - entry;
    if (!(risk > 0) || !(reward > 0)) return null;

    return {
      entry: entry,
      sl: stop,
      t1: t1,
      rr: reward / risk,
      slPct: ((stop - entry) / entry) * 100,
      mode: mode
    };
  }

  // ── Days-to-target estimator (2026-06-05, calibrated) ──────────────
  // Plain-English model:  time = distance / speed.
  //   • distance = Target − Entry (price the trade still has to travel).
  //   • speed    = ATR × EFFICIENCY  (net progress the stock makes PER BAR
  //                of the reco timeframe, after the zig-zag give-back).
  // ATR is the stock's own per-bar range, so a calm stock automatically
  // gets MORE bars and a volatile one FEWER — no per-stock tuning needed.
  // Because ATR is in the reco TF's units, the answer is in that TF's bars
  // (day / week / month), which _zoiUnitWord() labels.
  //
  // EFFICIENCY = the slice of ATR that becomes NET directional progress
  // (price never travels straight — it gives part of every push back).
  //
  // ── Backtest calibration (scripts/backtest/days-to-target.mjs) ──
  // Measured over 162 NSE daily series — both unconditional (308k target
  // attempts) AND setup-conditioned to pullback-in-uptrend BUY entries (34k)
  // — the realised efficiency = distance / (ATR × actual-bars-to-touch) had a
  // MEDIAN of ~0.17 with NO meaningful separation by ADX bucket at entry
  // (STRONG 0.167 · NORMAL 0.170 · CHOPPY 0.186 — if anything choppy was
  // marginally faster among reached targets). The original ADX-scaled
  // 0.35–0.65 anchors were ~3× too optimistic (median actual ≈ 3× the
  // predicted mid). So we use a SINGLE backtested constant and drop the ADX
  // tilt the data did not support. `adxVal` is kept in the signature only so
  // the estimator can be re-tested against ADX later without a call-site
  // churn — it does NOT change the answer today.
  //
  // Bars-to-target is a barrier-hitting WAITING TIME: heavy right-tailed and
  // genuinely wide (at eff 0.17 the actual/mid interquartile range is roughly
  // ×[0.5, 1.7]). So the displayed band IS that empirical IQR — "about half
  // the time it lands in here; it can be faster, or considerably slower" —
  // not a tight ±%. This is a PLANNING estimate, conditional on the target
  // being reached at all (only ~49% of setups reach even the nearest target
  // within 80 bars); it is never a verdict gate and never an exit trigger —
  // the structural / time stop owns the exit.
  var _SW_DTT_EFFICIENCY = 0.17;     // backtested median realised efficiency
  var _SW_DTT_BAND_LO = 0.5;         // empirical p25 / mid
  var _SW_DTT_BAND_HI = 1.7;         // empirical p75 / mid
  function _swEfficiencyFromAdx(adxVal) {
    // ADX-at-entry found non-predictive of bars-to-target (see calibration
    // note above) — return the single backtested constant regardless.
    return _SW_DTT_EFFICIENCY;
  }

  // distance/atrVal in the SAME price units; tf drives the unit word.
  // Returns { lo, hi, mid, unit, eff } in whole bars (band = empirical IQR
  // around the calibrated median, lo floored at 1), or null on unusable
  // input (fail safe: render nothing rather than a fabricated number).
  function _swDaysToTarget(distance, atrVal, adxVal, tf) {
    if (!isFinite(distance) || distance <= 0) return null;
    if (!isFinite(atrVal) || atrVal <= 0) return null;
    var eff = _swEfficiencyFromAdx(adxVal);
    var speed = atrVal * eff;
    if (!(speed > 0)) return null;
    var mid = distance / speed;
    if (!isFinite(mid) || mid <= 0) return null;
    var lo = Math.max(1, Math.round(mid * _SW_DTT_BAND_LO));
    var hi = Math.max(lo + 1, Math.round(mid * _SW_DTT_BAND_HI));
    return { lo: lo, hi: hi, mid: mid, unit: _zoiUnitWord(tf), eff: eff };
  }

  // Compact label = the CALIBRATED MEDIAN ("~18 days"), plus the reach-
  // PROBABILITY when the empirical table supplied one ("~18 days · 31%").
  // The median is well-centred (backtest actual/mid ≈ 1.00) so a single
  // rounded median is the honest, readable answer for the small T1/T2 sub-
  // cell; the wider lo–hi IQR stays on the estimate object for tooltips.
  // NBSP keeps each token from wrapping mid-label.
  function _swDaysLabel(est) {
    if (!est) return null;
    var n = Math.max(1, Math.round(est.mid));
    var lbl = '~' + n + '\u00a0' + est.unit + (n === 1 ? '' : 's');
    if (est.reach != null && isFinite(est.reach)) {
      lbl += '\u00a0\u00b7\u00a0' + Math.round(est.reach * 100) + '%\u00a0hit';
    }
    return lbl;
  }

  // Full reasoning for a target cell — surfaced as the native `title` tooltip on
  // the T1/T2 plan cell (matches the rest of the app, which uses `title=` for
  // hover help). Plain language only — what the % is, the reward:risk to that
  // target, the typical time + usual range, and the hit-odds. Internal
  // calibration provenance (R-floor / measured-rate / "2019-2025 universe") is
  // deliberately kept OUT — the tooltip is a trader-facing read, not a methods
  // note. Per the trading-context rule we never let the number read as a
  // promise: a very-tight target is flagged optimistic and every estimate ends
  // with "Planning estimate, not a guarantee."
  // Returns '' when there's nothing meaningful to say (caller clears the title).
  function _swTargetTooltip(name, target, entry, sl, est) {
    if (!isFinite(target) || !isFinite(entry) || target <= entry) return '';
    var lines = [];
    var pct = ((target - entry) / entry) * 100;
    lines.push(name + ': ' + fmtPrice(target)
      + '  (+' + pct.toFixed(2) + '% from entry ' + fmtPrice(entry) + ')');
    var risk = (isFinite(sl) ? entry - sl : NaN);
    if (isFinite(risk) && risk > 0) {
      lines.push('Reward : risk to here \u2014 1 : ' + ((target - entry) / risk).toFixed(2));
    }
    if (est) {
      var n = Math.max(1, Math.round(est.mid));
      var unit = est.unit + (n === 1 ? '' : 's');
      var range = (isFinite(est.lo) && isFinite(est.hi) && est.lo !== est.hi)
        ? '  (usually ' + est.lo + '\u2013' + est.hi + ' ' + est.unit + 's)'
        : '';
      lines.push('Typical time to reach: ~' + n + ' ' + unit + range);
      if (est.source === 'table' && est.reach != null && isFinite(est.reach)) {
        lines.push('Hit odds: ~' + Math.round(est.reach * 100)
          + '% of similar setups reached this target before the stop.');
        if (est.clamped) {
          lines.push('\u26a0 Target sits very close to entry \u2014 treat the time and odds as optimistic.');
        }
      }
      lines.push('Planning estimate, not a guarantee.');
    }
    return lines.join('\n');
  }

  // Attach (or clear) the reasoning tooltip on a target's PLAN CELL. `valId` is
  // the value-span id (e.g. 'sw-bplan-t1'); we hop to its enclosing .sw-plan-cell
  // so the whole cell (label + value + sub) is the hover target. Uses only the
  // native `title` attribute — same as every other tooltip in the app, no `?`
  // cursor or underline cue. Empty `txt` clears any stale tip (e.g. when a prior
  // BUY render is replaced by no-trade).
  function _swSetTargetTip(valId, txt) {
    var el = $(valId);
    if (!el) return;
    var cell = (el.closest && el.closest('.sw-plan-cell')) || el.parentElement || el;
    if (txt) cell.title = txt;
    else cell.removeAttribute('title');
  }

  // ── Empirical table lookup (preferred over the formula) ──────────────
  // Linear-interpolate a knot field at an arbitrary R across the cell's knots
  // (knots are pre-sorted ascending by r); clamps outside the knot range.
  function _dttInterp(knots, rVal, field) {
    if (!knots || !knots.length) return null;
    if (rVal <= knots[0].r) return knots[0][field];
    var last = knots[knots.length - 1];
    if (rVal >= last.r) return last[field];
    for (var i = 1; i < knots.length; i++) {
      if (rVal <= knots[i].r) {
        var a = knots[i - 1], b = knots[i];
        if (a[field] == null || b[field] == null) return (b[field] != null ? b[field] : a[field]);
        var t = (rVal - a.r) / (b.r - a.r);
        return a[field] + t * (b[field] - a[field]);
      }
    }
    return last[field];
  }

  // Robust default cell = pooled across regime AND mode (the largest, most
  // stable sample). Regime/mode breakdowns DO exist in the JSON, but we do
  // NOT key display off them: the calibration showed no clean, sensible
  // regime effect (BEAR upside-reach ≥ BULL — volatility/mean-reversion noise),
  // so shipping a regime tilt would repeat the dropped-ADX-tilt mistake. If a
  // future full-universe run shows a robust effect, switch the key here.
  function _dttKnots(tf) {
    if (!_dttTable) return null;
    // Accept either the TF-keyed map or a raw { tf: {...} } wrapper.
    var byTf = _dttTable[tf] || (_dttTable.tf && _dttTable.tf[tf]);
    var cell = byTf && byTf.ALL && byTf.ALL.ALL;
    return (cell && cell.knots && cell.knots.length) ? cell.knots : null;
  }

  // Empirical days+reach for a target at `rMultiple` R on timeframe `tf`.
  // Returns { lo, hi, mid, reach, unit, source:'table' } or null (→ caller
  // falls back to the ATR formula).
  function _swDaysToTargetR(rMultiple, tf) {
    if (!isFinite(rMultiple) || rMultiple <= 0) return null;
    var knots = _dttKnots(tf);
    if (!knots) return null;
    var mid = _dttInterp(knots, rMultiple, 'p50');
    if (!(mid > 0)) return null;
    var lo = _dttInterp(knots, rMultiple, 'p25');
    var hi = _dttInterp(knots, rMultiple, 'p75');
    var reach = _dttInterp(knots, rMultiple, 'reach');
    // The table's lowest knot is the calibration floor (~0.5R). A target tighter
    // than that is OUTSIDE the measured range, so _dttInterp clamps to the first
    // knot — the returned reach/days are then a best-case CEILING, not a measured
    // value. Flag it so the tooltip can say so honestly (no silent extrapolation).
    return {
      lo: Math.max(1, Math.round(lo > 0 ? lo : mid * 0.5)),
      hi: Math.max(2, Math.round(hi > 0 ? hi : mid * 1.7)),
      mid: mid,
      reach: (reach != null && isFinite(reach)) ? reach : null,
      unit: _zoiUnitWord(tf),
      r: rMultiple,
      clamped: rMultiple < knots[0].r,
      source: 'table'
    };
  }

  // Unified estimate: prefer the empirical R-keyed table (real-BUY calibrated,
  // carries reach-probability); fall back to the ATR×efficiency formula when
  // the table is missing or the stop distance is degenerate (no R available).
  function _swEstimateDays(entry, sl, target, atrVal, adxVal, tf) {
    if (!isFinite(target) || !isFinite(entry) || target <= entry) return null;
    var risk = entry - sl;
    if (isFinite(risk) && risk > 0) {
      var byR = _swDaysToTargetR((target - entry) / risk, tf);
      if (byR) return byR;
    }
    return _swDaysToTarget(target - entry, atrVal, adxVal, tf);
  }

  // Compute T1/T2 day estimates for a finalised plan-like object. Pure:
  // reads entry/sl/t1/t2 + the reco-TF candles, returns { t1Days, t2Days }
  // estimate objects (or nulls). sl is needed to express the targets in R
  // for the empirical table lookup; atr/adx feed the formula fallback.
  // Candles are newest-first (Upstox V3); atr()/adx() need oldest-first.
  function _swPlanDaysEstimate(rawNewestFirst, entry, sl, t1, t2, tf) {
    var out = { t1Days: null, t2Days: null };
    if (!rawNewestFirst || rawNewestFirst.length < 16 || !isFinite(entry)) return out;
    var c = rawNewestFirst.slice().reverse();   // oldest-first for atr()/adx()
    var atrArr = atr(c, 14);
    var atrV = NaN;
    for (var i = atrArr.length - 1; i >= 0; i--) {
      if (isFinite(atrArr[i]) && atrArr[i] > 0) { atrV = atrArr[i]; break; }
    }
    var adxArr = adx(c, 14);
    var adxV = (adxArr && adxArr.length && isFinite(adxArr[adxArr.length - 1]))
      ? adxArr[adxArr.length - 1] : null;
    if (isFinite(t1)) out.t1Days = _swEstimateDays(entry, sl, t1, atrV, adxV, tf);
    if (isFinite(t2)) out.t2Days = _swEstimateDays(entry, sl, t2, atrV, adxV, tf);
    return out;
  }

  // ── Option B: SETUP plan ───────────────────────────────────────────
  // Build a full trade plan whose levels come from the verdict's OWN
  // geometry — the Fib golden pocket and/or the demand zone the
  // recommendation engine matched — via _swStandardRR (the SAME level
  // engine that feeds the verdict's R:R, so the displayed R:R equals the
  // verdict's R:R; no divergence). Returns a plan object in the SAME shape
  // generatePlan() produces, so the existing renderers (grid, WHY BUY,
  // POSITION SIZE, WHEN TO EXIT, WHY / SKIP) consume it unchanged.
  // Returns null when no actionable setup can be framed (→ no-trade).
  function swBuildSetupPlan(R, vInfo) {
    if (!R || !R.candles) return null;
    var tf = swGetRecoTf();
    // Verdict for this reco TF drives the buy-zone anchoring (actionable NOW vs
    // wait-for-pullback) — see the BUY ZONE block below. Compute a fallback if
    // the caller didn't pass it.
    if (!vInfo) { try { vInfo = swComputeVerdictForTf(tf); } catch (_) { vInfo = null; } }
    var raw = (R.candles[tf] && R.candles[tf].length) ? R.candles[tf] : R.candles['1d'];
    if (!raw || raw.length < 6) return null;
    var px = (isFinite(R.ltp) && R.ltp) ? R.ltp : +raw[0][4];
    if (!isFinite(px) || px <= 0) return null;

    var mode = swGetRecoMode();
    var doFib = (mode === 'FIB' || mode === 'FIB_ZOI');
    var doZoi = (mode === 'ZOI' || mode === 'FIB_ZOI');
    var fib = doFib ? computeFibZone(raw) : null;
    var hasFib = !!(fib && fib.plan);
    var zones = doZoi ? detectZones(raw) : null;

    // Nearest demand zone whose top sits at/just below price — the floor
    // the stop leans on.
    var demandZone = null, dDist = Infinity;
    if (zones && zones.length) {
      for (var di = 0; di < zones.length; di++) {
        if (zones[di].type !== 'DEMAND') continue;
        var top = Math.max(zones[di].proximal, zones[di].distal);
        if (top <= px * 1.02) {
          var dd = Math.abs(px - top);
          if (dd < dDist) { dDist = dd; demandZone = zones[di]; }
        }
      }
    }

    var lv = _swStandardRR(raw, px, {
      mode: mode,
      fib: hasFib ? fib : null,
      zones: (zones && zones.length) ? zones : null,
      demandZone: demandZone
    });
    if (!lv) return null;

    var entry = lv.entry, sl = lv.sl, t1 = lv.t1;
    if (!(sl < entry) || !(t1 > entry)) return null;

    // ── BUY ZONE band + basis label (the structural zone the levels lean on) ──
    // Computed BEFORE the entry is finalised: when a real structural zone
    // exists the buy "entry" is that band, not the single market price.
    var zLo = null, zHi = null, basisLabel = '', freshTxt = '';
    if (hasFib && doFib) {
      zLo = Math.min(fib.fib618, fib.fib786);
      zHi = Math.max(fib.fib618, fib.fib786);
      basisLabel = 'Golden pocket (61.8\u201380%)';
    }
    if (demandZone && doZoi) {
      var dLo = Math.min(demandZone.proximal, demandZone.distal);
      var dHi = Math.max(demandZone.proximal, demandZone.distal);
      freshTxt = demandZone.freshness === 'FRESH'
        ? 'fresh zone'
        : 'tested ' + (demandZone.testCount || 1) + '\u00d7';
      if (zLo == null) { zLo = dLo; zHi = dHi; basisLabel = 'Demand zone'; }
      else {
        var iLo = Math.max(zLo, dLo), iHi = Math.min(zHi, dHi);
        if (iLo < iHi) { zLo = iLo; zHi = iHi; basisLabel = 'Pocket \u00d7 demand confluence'; }
        else { basisLabel = 'Pocket + demand'; }
      }
    }

    // BUY ZONE is always a RANGE (2026-06-04). HOW the range is anchored
    // depends on whether the setup is actionable NOW or still waiting for a
    // pullback — exactly the distinction the verdict rules draw for the
    // "above pocket" states (data/verdict-rules.json): F4 = touched & bounced
    // ABOVE the pocket → BUY now at market; F6 = approaching, not yet entered
    // → WAIT for price to fall into the pocket. So:
    //   • WAIT / WATCH / SKIP (not actionable now) AND a valid zone sits below
    //     → the buy zone IS the structural band [zLo,zHi]; place a limit and
    //       accumulate on the pullback. Anchor entry / R:R / % on the LOW edge
    //       (best realistic fill, mirroring the Fib scanner's fib800 entry) so
    //       the R:R reflects buying IN the zone, not at a market price that may
    //       sit far above it (which produced the degenerate ~1:0.0).
    //   • Price currently INSIDE the zone → same band (you accumulate across it).
    //   • BUY / STRONG BUY above the zone (confirmed bounce), or no clean band
    //     → buy NOW at the current price; widen into a tight band around market.
    // SL stays the structural stop below the zone; T1 the objective above it.
    var entryHi = entry, usedZoneBand = false;
    var _bandValid = (zLo != null && zHi != null && zLo < zHi && sl < zLo && t1 > zHi);
    var _actionableNow = !!(vInfo && (vInfo.text === 'BUY' || vInfo.text === 'STRONG BUY'));
    var _priceInZone = (zLo != null && zHi != null && entry >= zLo && entry <= zHi);
    if (_bandValid && (_priceInZone || !_actionableNow)) {
      entry = zLo; entryHi = zHi; usedZoneBand = true;
    } else {
      var pad = Math.min(entry * 0.0025, (t1 - entry) * 0.3);
      if (isFinite(pad) && pad > 0) entryHi = entry + pad;
    }
    if (!(sl < entry) || !(t1 > entry)) return null;
    var risk = entry - sl;

    // ── Displayed BUY ZONE range — decoupled from the R:R `entry` anchor ──
    // The risk math above anchors `entry` on ONE realistic fill (the zone low
    // for a limit-in-zone wait, the market price for a confirmed bounce). The
    // CARD, though, should always show the trader the actionable BAND, not a
    // lone tick, so the structural zone the trade leans on stays visible:
    //   • limit-in-zone (usedZoneBand) → entry/entryHi already ARE [zLo, zHi].
    //   • confirmed bounce just ABOVE the band → show pocket-top → current
    //     ([zHi, entry]): buy at market or on a dip back to the zone top.
    //   • price still INSIDE the band but R:R-degenerate (band not used for the
    //     anchor) → show the full structural band [zLo, zHi].
    //   • no structural band at all → the tight pad band around market.
    // These fields are DISPLAY-ONLY; SL / T1 / R:R / % all stay anchored on
    // `entry` (the realistic fill), so the risk numbers never change.
    var zoneLo = Math.min(entry, entryHi);
    var zoneHi = Math.max(entry, entryHi);
    if (!usedZoneBand && zLo != null && zHi != null && zLo < zHi) {
      if (entry >= zHi) { zoneLo = zHi; zoneHi = entry; }
      else if (entry <= zLo) { zoneLo = entry; zoneHi = zHi; }
      else { zoneLo = zLo; zoneHi = zHi; }
    }

    var bandTxt = (zLo != null && zHi != null)
      ? '\u20B9' + Math.round(zLo) + '\u2013\u20B9' + Math.round(zHi) : '';
    var setupName = (basisLabel || 'Mode setup')
      + (bandTxt ? ' \u2014 ' + bandTxt : '')
      + (freshTxt ? ' (' + freshTxt + ')' : '');

    // T2 — next structural objective above T1 (further supply bottom /
    // fib swing high), else a 2× measured-move extension of the T1 leg.
    var t2 = null, cand = [];
    if (zones && zones.length) {
      for (var zz = 0; zz < zones.length; zz++) {
        if (zones[zz].type !== 'SUPPLY') continue;
        var sb = Math.min(zones[zz].proximal, zones[zz].distal);
        if (sb > t1) cand.push(sb);
      }
    }
    if (hasFib && isFinite(fib.swHigh) && fib.swHigh > t1) cand.push(fib.swHigh);
    for (var ci = 0; ci < cand.length; ci++) { if (t2 == null || cand[ci] < t2) t2 = cand[ci]; }
    if (t2 == null || !(t2 > t1)) t2 = entry + 2 * (t1 - entry);

    // R:R recomputed from the FINALISED (zone-low) entry.
    var rr = (t1 - entry) / risk;

    // Timeline — swing defaults (Option B targets a swing move into the
    // next structural objective).
    var SR = STYLE_RULES.SWING;
    var holding = SR.holdTypical;
    var nowMs = Date.now();
    var timeline = {
      style: 'SWING', styleLabel: SR.label,
      entryTiming: 'limit into the ' + (basisLabel || 'zone').toLowerCase()
        + ' \u2014 enter on a bullish reversal candle, not mid-air',
      entryBy: nowMs + 1 * 24 * 60 * 60 * 1000,
      holdMin: SR.holdMin, holdMax: SR.holdMax, holdTypical: holding,
      timeStopBy: nowMs + SR.holdMax * 24 * 60 * 60 * 1000
    };

    // Position sizing — identical 1%-risk formula as the structure plan.
    var assumedCapital = 100000;
    var riskPerShare = Math.max(0.01, entry - sl);
    var sharesAt1Pct = Math.floor((assumedCapital * 0.01) / riskPerShare);
    var sharesAt05Pct = Math.floor((assumedCapital * 0.005) / riskPerShare);
    var sizing = {
      assumedCapital: assumedCapital, riskPerShare: riskPerShare,
      sharesAt1Pct: sharesAt1Pct, sharesAt05Pct: sharesAt05Pct,
      capital1Pct: sharesAt1Pct * entry, capital05Pct: sharesAt05Pct * entry,
      maxLoss1Pct: sharesAt1Pct * riskPerShare,
      targetGain1Pct: sharesAt1Pct * (t1 - entry)
    };

    // WHY BUY — facts measured from the verdict geometry + higher-TF context.
    var whyBuy = [];
    whyBuy.push('SETUP: ' + (basisLabel || 'mode setup')
      + (bandTxt ? ' at ' + bandTxt : '')
      + ' \u2014 levels derived from the recommendation\u2019s own geometry.');
    if (demandZone) {
      whyBuy.push('ZONE: ' + (demandZone.freshness === 'FRESH'
          ? 'FRESH' : 'tested ' + (demandZone.testCount || 1) + '\u00d7')
        + ' demand zone, reliability ' + (demandZone.score != null ? demandZone.score + '/100' : 'n/a')
        + (demandZone.patternLabel ? ' (' + demandZone.patternLabel + ')' : '') + '.');
    }
    if (hasFib) {
      var fRange = fib.swHigh - fib.swLow;
      var retPct = fRange > 0 ? ((fib.swHigh - px) / fRange) * 100 : 0;
      whyBuy.push('FIB: price has retraced ' + retPct.toFixed(0)
        + '% of the last leg (' + fmtPrice(fib.swLow) + ' \u2192 ' + fmtPrice(fib.swHigh)
        + ') \u2014 ' + (retPct >= 61.8 && retPct <= 80 ? 'inside the golden pocket' : 'near the pocket') + '.');
    }
    if (R.weekly && R.weekly.trend) {
      whyBuy.push('WEEKLY: higher-timeframe trend is ' + String(R.weekly.trend).replace('_', ' ') + '.');
    }
    whyBuy.push('RISK:REWARD: 1:' + rr.toFixed(2) + ' to T1 ('
      + fmtPrice(entry) + ' \u2192 ' + fmtPrice(t1) + ', stop ' + fmtPrice(sl) + ').');

    // WHEN TO EXIT — mode-native, structural.
    var zoneFloor = (zLo != null) ? zLo : sl;
    var exitRules = [
      { kind: 'TARGET', label: 'Target 1',
        detail: fmtPrice(t1) + '  \u00b7  ' + ((t1 - entry) / risk).toFixed(1) + 'R  \u00b7  '
          + ((t1 - entry) / entry * 100).toFixed(1) + '% above entry',
        action: 'sell 50% here',
        why: 'First objective is the nearest overhead supply / fib level above the zone. '
          + 'Banking half locks the bulk of expected value before the move risks giving it back.' },
      { kind: 'TARGET', label: 'Target 2',
        detail: fmtPrice(t2) + '  \u00b7  ' + ((t2 - entry) / risk).toFixed(1) + 'R  \u00b7  '
          + ((t2 - entry) / entry * 100).toFixed(1) + '% above entry',
        action: 'let the rest run with a trailing stop',
        why: 'The next structural objective \u2014 trades that reach it pay for the ones that fail. Don\u2019t cut a runner early.' },
      { kind: 'STOP', label: 'Hard stop',
        detail: fmtPrice(sl) + '  \u00b7  ' + ((sl - entry) / entry * 100).toFixed(1) + '% risk per share',
        action: 'GTT sell-stop the moment your buy fills',
        why: 'Placed just below the ' + (basisLabel || 'zone').toLowerCase()
          + '. A close below means the demand / pocket failed \u2014 the setup is invalid, exit without hoping.' },
      { kind: 'STRUCTURAL', label: 'Structural exit',
        detail: 'Daily close back below ' + fmtPrice(zoneFloor),
        action: 'Exit on the next bar\u2019s open',
        why: 'Closing back inside / under the zone after triggering means buyers failed to defend it \u2014 the thesis is gone even if the hard stop hasn\u2019t hit.' },
      { kind: 'TIME', label: 'Time stop',
        detail: SR.holdMax + ' trading days max hold  \u00b7  exit by '
          + _swFmtDate(nowMs + SR.holdMax * 24 * 60 * 60 * 1000),
        action: 'Exit at the open after the window',
        why: 'A zone / pocket bounce that hasn\u2019t reached T1 within the swing window has lost its edge \u2014 free the capital.' }
    ];

    // SKIP IF — structural invalidations.
    var skipIf = [
      'Daily candle closes below ' + fmtPrice(sl) + ' \u2014 the ' + (basisLabel || 'zone').toLowerCase() + ' has failed.',
      'Price loses ' + fmtPrice(zoneFloor) + ' on a closing basis before you enter \u2014 wait for it to reclaim.',
      'No bullish reversal candle forms in the zone \u2014 don\u2019t buy a falling knife.'
    ];
    if (R.regime && R.regime.regime === 'BEAR') {
      skipIf.push('Nifty regime is BEAR \u2014 take half size or skip; zone bounces fail more often against a falling index.');
    }
    if (rr < 1.5) {
      skipIf.push('R:R is only 1:' + rr.toFixed(2) + ' \u2014 below the 1:1.5 swing floor; skip unless you can enter lower in the zone.');
    }

    var why = (basisLabel || 'Mode setup') + ' bounce. Levels come from the recommendation\u2019s own geometry ('
      + mode.replace('_', '+') + '): entry ' + fmtPrice(entry) + ', stop ' + fmtPrice(sl)
      + ' below the zone, T1 ' + fmtPrice(t1) + ' at the next objective. '
      + 'Risk:Reward 1:' + rr.toFixed(2) + ' to T1. Buy delivery (CNC). '
      + 'Size so the stop costs no more than 1% of capital.';

    // Days-to-target + reach-probability for T1 & T2 (empirical table keyed by
    // R-multiple, ATR-formula fallback). Uses the reco-TF candles so the unit
    // matches (day/week/month).
    var _daysEst = _swPlanDaysEstimate(raw, entry, sl, t1, t2, tf);

    return {
      ok: true, action: 'BUY', style: 'SWING', styleMix: 'SWING', triggers: [],
      timeline: timeline, exitRules: exitRules, whyBuy: whyBuy, sizing: sizing,
      setupName: setupName, setupShort: basisLabel || 'SETUP',
      entry: entry, entryHi: entryHi, zoneLo: zoneLo, zoneHi: zoneHi,
      entrySub: usedZoneBand ? 'limit into zone (CNC)' : 'buy delivery (CNC)',
      sl: sl, t1: t1, t2: t2,
      t1Days: _daysEst.t1Days, t2Days: _daysEst.t2Days, recoTf: tf,
      rr: rr, holding: holding, why: why, skipIf: skipIf
    };
  }

  // No-trade clone of a plan — forces the render into the no-trade branch
  // (grid hidden; headline + reasoning driven by the verdict engine)
  // WITHOUT mutating the canonical plan. Used to GATE a structure / setup
  // BUY when the Fib/ZOI verdict for the reco TF is not BUY.
  function _swNoTradePlan(base, verdictText) {
    var b = base || {};
    var clone = {};
    for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) clone[k] = b[k]; }
    clone.action = (verdictText === 'AVOID') ? 'AVOID' : 'WAIT';
    clone.sl = null; clone.t1 = null; clone.t2 = null;
    return clone;
  }

  // Resolve the plan that should be DISPLAYED for the current stock, given
  // the selected engine (A / B) and the reco-TF verdict gate. Centralised
  // so the trade-plan CARD and the on-chart price levels stay consistent —
  // both call this. Never mutates STATE; returns a plan object (possibly a
  // no-trade clone) or the canonical plan unchanged.
  // Canonical SETUP-plan producer — the SINGLE source for BOTH the SETUP
  // trade-plan card (#sw-bplan) AND the on-chart Entry/SL/T1/T2 levels, so the
  // chart, the cards, and the trade plan can NEVER drift apart (2026-06-05
  // wiring fix: chart -> cards -> trade plan = ONE pipeline). Mode-aware via
  // swBuildSetupPlan (FIB / ZOI / FIB+ZOI off the reco TF); falls back to a
  // no-trade clone (which the chart's BUY gate then hides). `vInfo` (the reco-TF
  // verdict) is optional — passed through for buy-zone anchoring, recomputed if
  // absent. Never mutates STATE; returns a plan object (BUY or no-trade clone).
  function swSetupPlanForRender(vInfo) {
    var R = STATE.result;
    if (!R || !R.plan) return null;
    var v = vInfo;
    if (!v) { try { v = swComputeVerdictForTf(swGetRecoTf()); } catch (_) { v = null; } }
    var p = null;
    try { p = swBuildSetupPlan(R, v); } catch (_) { p = null; }
    if (!p) p = _swNoTradePlan(R.plan, (v && v.text) || null);
    return p;
  }

  // Plan whose Entry/SL/T1/T2 are DRAWN on the chart. Mirrors the SETUP card
  // EXACTLY (single producer above) so chart == card == trade plan. The legacy
  // A/B "plan engine" toggle (UI already removed) and the pendingFib override
  // are RETIRED here: the actionable trade the chart should visualise is the
  // mode-driven SETUP plan, not the monthly+weekly+daily STRUCTURE synthesis
  // (the STRUCTURE card was removed 2026-06-05; R.plan still backs the no-trade
  // fallback). The chart still GATES drawing on the reco-TF verdict being BUY,
  // so a no-trade/contradicted plan paints no levels (fail-safe).
  function swActivePlan() {
    return swSetupPlanForRender();
  }

  // swPlanGateWarning removed 2026-06-05 — its only caller was the inert legacy
  // single-card block (now deleted). swRenderPlanCard keeps its gate-warn element
  // permanently hidden; the WAIT/AVOID context lives in the SETUP PLAN
  // RECOMMENDATION cell + the verdict chip instead.

  // Render the SETUP trade-plan card. `pfx` is the element-id prefix
  // ('sw-bplan'); `plan` is a swBuildSetupPlan object (or a _swNoTradePlan
  // clone); `vInfo` is the reco-TF verdict; `opts.showModeBadge` shows the
  // Fib/ZONE basis badge. There's NO viability gate (a sub-1:1 setup still
  // shows its grid). Every accessor is null-guarded, so a missing prefix is a
  // safe no-op. (The STRUCTURE card that once shared this renderer was removed
  // 2026-06-05, so it now only ever draws the SETUP card.)
  function swRenderPlanCard(pfx, plan, vInfo, opts) {
    opts = opts || {};
    var cardEl = $(pfx);
    if (!cardEl) return;
    var setT = function (suf, txt) { setText(pfx + suf, txt); };
    var isNoTrade = !plan || plan.sl == null;

    // Grid hidden + reasoning shown only on a no-trade; card always visible.
    // (The STRUCTURE card was removed 2026-06-05, so this renderer now only
    // ever draws the SETUP card — the entry-ticket grid shows on any trade.)
    var gridEl = $(pfx + '-grid');
    if (gridEl) gridEl.hidden = isNoTrade;
    cardEl.style.display = '';

    // The card's verdict header strip (SETUP chip + mode badge + Holding) and
    // the gate-warning strip were removed from the markup 2026-06-04/06-05 —
    // the verdict shows in the SETUP PLAN → RECOMMENDATION cell, the Fib/ZONE
    // basis shows on the BUY ZONE cell's mode chip, and the left-edge accent
    // (set below) colours the card. The reasoning (WHY / SKIP-IF) block shows
    // only on a no-trade; on a BUY the card is purely the levels ticket.
    var whyWrap = $(pfx + '-why-wrap');
    if (whyWrap) whyWrap.style.display = isNoTrade ? '' : 'none';

    // ── Verdict accent — colours the card's left edge so
    // the recommendation reads at a glance (BUY green / WAIT-CAUTION amber /
    // AVOID red / neutral grey). Pure presentation; driven by vInfo.cls. ──
    var _accent = (vInfo && vInfo.cls === 'sw-bull') ? 'buy'
      : (vInfo && vInfo.cls === 'sw-bear') ? 'avoid'
      : (vInfo && vInfo.cls === 'sw-warn') ? 'wait'
      : (vInfo && vInfo.cls === 'sw-neutral') ? 'neutral'
      : (isNoTrade ? 'wait' : 'buy');
    cardEl.classList.remove('sw-plan--buy', 'sw-plan--avoid', 'sw-plan--wait', 'sw-plan--neutral');
    cardEl.classList.add('sw-plan--' + _accent);

    // ── Level grid ──
    if (isNoTrade) {
      _swSetTargetTip(pfx + '-t1', '');
      _swSetTargetTip(pfx + '-t2', '');
      var _emEl = $(pfx + '-entry-mode');
      if (_emEl) _emEl.hidden = true;
    } else {
      // BUY ZONE is shown as the structural band (golden pocket / demand zone)
      // via the display-only zoneLo/zoneHi the producer attaches — so it always
      // reads as a range, not a lone tick. Falls back to entry/entryHi (then
      // entry) for older/no-trade plans that don't carry the band fields.
      var _zLo = isFinite(plan.zoneLo) ? plan.zoneLo
        : (isFinite(plan.entryHi) ? Math.min(plan.entry, plan.entryHi) : plan.entry);
      var _zHi = isFinite(plan.zoneHi) ? plan.zoneHi
        : (isFinite(plan.entryHi) ? Math.max(plan.entry, plan.entryHi) : plan.entry);
      var entryTxt = (Math.round(_zHi) !== Math.round(_zLo))
        ? fmtPrice(_zLo) + ' \u2013 ' + fmtPrice(_zHi)
        : fmtPrice(_zLo);
      setT('-entry', entryTxt);
      setT('-entry-sub', plan.entrySub || 'buy delivery (CNC)');
      // Mode chip on the BUY ZONE cell — names the BASIS the setup levels were
      // built on (FIB / ZOI / FIB+ZOI). SETUP card only (opts.showModeBadge);
      // the structure card's grid is hidden so it has no entry cell to label.
      var _entryModeEl = $(pfx + '-entry-mode');
      if (_entryModeEl) {
        var _rm = (opts.showModeBadge && typeof swGetRecoMode === 'function')
          ? swGetRecoMode() : null;
        var _rmLbl = _rm === 'FIB_ZOI' ? 'FIB+ZOI' : _rm === 'ZOI' ? 'ZOI' : _rm === 'FIB' ? 'FIB' : '';
        if (_rmLbl) { _entryModeEl.textContent = _rmLbl; _entryModeEl.hidden = false; }
        else _entryModeEl.hidden = true;
      }
      setT('-sl', fmtPrice(plan.sl));
      setT('-sl-sub', fmtPct(((plan.sl - plan.entry) / plan.entry) * 100));
      // Each TARGET cell's sub is two lines: line 1 = % move + the reward:risk
      // (amber, so the trade math stands out); line 2 = time-to-reach + hit
      // odds. Both targets share the SAME risk (entry − SL); reward = target −
      // entry — so R:R rises with the further objective.
      var _rrRisk = plan.entry - plan.sl;
      function _rrLabel(tgt) {
        if (!(_rrRisk > 0) || !isFinite(tgt)) return '';
        return 'R:R 1:' + ((tgt - plan.entry) / _rrRisk).toFixed(1);
      }
      function _setTgtSub(suf, tgt, days) {
        var el = $(pfx + suf);
        if (!el) return;
        var pct = escapeHtml(fmtPct(((tgt - plan.entry) / plan.entry) * 100));
        var rr = _rrLabel(tgt);
        // Whole first line (% move + R:R) in amber so the trade math stands out.
        var line1 = '<span class="sw-tgt-rr">' + pct
          + (rr ? '  \u00b7  ' + escapeHtml(rr) : '') + '</span>';
        var daysLbl = _swDaysLabel(days);
        var line2 = daysLbl
          ? '<span class="sw-tgt-time">' + escapeHtml(daysLbl) + '</span>' : '';
        el.innerHTML = line1 + (line2 ? '<br>' + line2 : '');
      }
      setT('-t1', fmtPrice(plan.t1));
      _setTgtSub('-t1-sub', plan.t1, plan.t1Days);
      _swSetTargetTip(pfx + '-t1',
        _swTargetTooltip('Target 1', plan.t1, plan.entry, plan.sl, plan.t1Days));
      if (plan.t2 != null) {
        setT('-t2', fmtPrice(plan.t2));
        _setTgtSub('-t2-sub', plan.t2, plan.t2Days);
        _swSetTargetTip(pfx + '-t2',
          _swTargetTooltip('Target 2', plan.t2, plan.entry, plan.sl, plan.t2Days));
      } else { setT('-t2', '\u2014'); setT('-t2-sub', '\u2014'); _swSetTargetTip(pfx + '-t2', ''); }
    }

    // ── Reasoning block ──
    var whyH = $(pfx + '-why-h'); var skipH = $(pfx + '-skip-h');
    var skipUl = $(pfx + '-skip');
    if (isNoTrade) {
      if (whyH) whyH.textContent = (plan && plan.action === 'AVOID') ? 'WHY AVOID' : 'WHY NO ENTRY';
      if (skipH) skipH.textContent = 'RISKS TO WEIGH';
      setT('-why', (vInfo && vInfo.sub) ? vInfo.sub
        : (plan && plan.action === 'AVOID'
            ? 'Structure does not support a long here.'
            : 'No valid entry at the current price \u2014 wait for the setup to form.'));
      if (skipUl) {
        var flags = (vInfo && vInfo.riskFlags && vInfo.riskFlags.length) ? vInfo.riskFlags : null;
        skipUl.innerHTML = flags
          ? flags.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('')
          : '<li>No structural risk flags \u2014 trend, regime &amp; structure read clean; the wait is purely about entry location.</li>';
      }
    } else {
      // BUY / levels — the SETUP card's actionable wording.
      if (whyH) whyH.textContent = 'WHY THIS TRADE';
      if (skipH) skipH.textContent = 'SKIP IF';
      setT('-why', plan.why || '\u2014');
      if (skipUl) {
        skipUl.innerHTML = (plan.skipIf && plan.skipIf.length)
          ? plan.skipIf.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('')
          : '';
      }
    }
  }

  // Render the SETUP trade-plan card (#sw-bplan = swBuildSetupPlan) from the
  // CURRENT reco TF. Centralised so the identical path runs on a fresh analysis
  // (renderResult) AND on a reco-TF switch (swSetRecoTf) — the SETUP builder
  // reads the selected TF's candles, so its levels track the picker. The
  // STRUCTURE card (#sw-aplan) was removed 2026-06-05 (user request); the
  // function name is kept since several call sites + the window export use it.
  // Reads STATE.result; never mutates it. Safe no-op if there's no result yet.
  function swRenderBothPlanCards() {
    var R = STATE.result;
    if (!R || !R.plan) return;
    var tf = swGetRecoTf();
    var vInfo = null;
    try { vInfo = swComputeVerdictForTf(tf); } catch (_) { vInfo = null; }
    // SETUP card — built by the SINGLE canonical producer swSetupPlanForRender,
    // the SAME function that feeds the on-chart Entry/SL/T1/T2 levels (via
    // swActivePlan). One source ⇒ the chart, this card, and the trade plan can
    // never disagree (2026-06-05 wiring fix). swBuildSetupPlan underneath is
    // mode-aware (FIB / ZOI / FIB+ZOI), returns the BUY ZONE as a RANGE, and
    // attaches days-to-target + reach-probability + R:R + why/skipIf in one place.
    // The old inline "fibPlan" shortcut (raw FIB_STATE.pendingFib.plan) bypassed
    // all of that — single-price entry, no days/probability, mode-blind — so it
    // drifted out of sync on every feature add. A Fib-scanner pick is NOT lost:
    // it still drives the chart fib OVERLAY and mirrors the reco-TF to the picked
    // TF, so swBuildSetupPlan recomputes computeFibZone() on that SAME TF — the
    // same pocket the scanner found, now framed with the full feature set. The
    // mode chip on the BUY ZONE cell names which basis is shown.
    var setupPlan = swSetupPlanForRender(vInfo);
    if (!setupPlan) {
      setupPlan = _swNoTradePlan(R.plan, (vInfo && vInfo.text) || null);
    }
    // STRUCTURE card (#sw-aplan) removed 2026-06-05 — only the SETUP card renders.
    swRenderPlanCard('sw-bplan', setupPlan, vInfo, { showModeBadge: true });

    // SETUP card sub-label — name the timeframe its levels were built from, so
    // it's obvious the setup plan tracks the reco-TF picker (the structure card
    // carries the static "monthly+weekly+daily" note in markup instead).
    var _tfNoteEl = $('sw-bplan-tfnote');
    if (_tfNoteEl) {
      var _tfLbl = { '1mo': 'Monthly', '1w': 'Weekly', '1d': 'Daily', '4h': '4-Hour',
        '1h': '1-Hour', '30m': '30-Min', '15m': '15-Min', '5m': '5-Min' };
      _tfNoteEl.textContent = 'levels from ' + (_tfLbl[tf] || tf) + ' timeframe';
    }
  }
  window.swRenderBothPlanCards = swRenderBothPlanCards;

  // Attach RISK CONTEXT to a verdict — informational ONLY, never demotes.
  //
  // 2026-05-30 pure-rules redesign: the signal (BUY/WAIT/AVOID) now comes
  // 100% from the rule table for the selected mode (FIB / ZOI / FIB+ZOI).
  // The higher-timeframe trend, market regime, R:R, stop distance and SMC
  // structure used to VETO a geometric BUY (demote to GATED/WATCH). That
  // produced "0 BUY" lists in a bear tape and hid the geometry the user
  // actually wanted to see. Those same factors are now COLLECTED here and
  // surfaced in the detail card so the trader weighs them — the BUY/WAIT
  // text is left exactly as the rules produced it. `gate` fields:
  //   tf           : scan timeframe ('1mo'|'1w'|'1d')
  //   weeklyTrend  : OWN trend on the scan TF
  //                  ('STRONG_BULL'|'BULL'|'NEUTRAL'|'BEAR'|'STRONG_BEAR')
  //   regime       : 'BULL'|'BEAR'|'NEUTRAL'|null  (broad market / Nifty)
  //   rr           : reward:risk to T1 (number|null)
  //   slPct        : stop distance from entry, signed % (number|null)
  //   smcTrend     : 'BULLISH'|'BEARISH'|'RANGING'|null  (SMC structure)
  //   smcLastBreak : { type:'BOS'|'CHOCH', direction:'BULL'|'BEAR' }|null
  //   zoneFreshness: 'FRESH'|'TESTED'|null  (demand zone driving the BUY)
  //   zoneTestCount: number of times that zone was retested
  function _collectRiskContext(result, gate) {
    if (!gate || !result) return result;
    var tfLabel = (SW_TF_LABEL[gate.tf] || gate.tf || '').toLowerCase();
    // Concern notes — surfaced as "risks to weigh", NEVER as a veto.
    var flags = [];
    if (gate.weeklyTrend === 'BEAR' || gate.weeklyTrend === 'STRONG_BEAR') {
      flags.push('own ' + tfLabel + ' trend is down (' + gate.weeklyTrend.replace('_', ' ').toLowerCase() + ')');
    } else if (gate.weeklyTrend === 'NEUTRAL') {
      flags.push('own ' + tfLabel + ' trend is flat (no confirmed up/down)');
    }
    if (gate.regime === 'BEAR') {
      flags.push('broad market regime is BEAR (Nifty below a falling 50-DMA)');
    }
    // R:R and stop-distance are only meaningful once there's a REAL entry.
    // On a no-entry verdict (WAIT/SKIP/AVOID) the engine frames hypothetical
    // levels (entry = current price, stop = a far structural low), which
    // produce nonsense like "0.0R" / "46% stop" that doesn't match the
    // actual reason for skipping. Surface these only for an actionable BUY.
    if (result.text === 'BUY') {
      if (gate.rr != null && isFinite(gate.rr) && gate.rr < 1.5) {
        flags.push('reward:risk is only ' + gate.rr.toFixed(1) + 'R to T1 (want \u2265 1.5R)');
      }
      if (gate.slPct != null && isFinite(gate.slPct) && Math.abs(gate.slPct) > 10) {
        flags.push('stop is ' + Math.abs(gate.slPct).toFixed(0) + '% away \u2014 wide for a swing');
      }
    }
    if (gate.smcTrend === 'BEARISH') {
      flags.push('market structure is bearish (lower highs & lower lows)');
    } else if (gate.smcLastBreak && gate.smcLastBreak.type === 'CHOCH' && gate.smcLastBreak.direction === 'BEAR') {
      flags.push('structure just flipped down (bearish CHoCH)');
    }
    if (gate.zoneFreshness === 'TESTED' && gate.zoneTestCount >= 2) {
      flags.push('demand zone already tested ' + gate.zoneTestCount + '\u00d7');
    }
    result.riskContext = {
      tf: gate.tf || null,
      trend: gate.weeklyTrend || 'NEUTRAL',
      regime: gate.regime || null,
      smcTrend: gate.smcTrend || null,
      smcLastBreak: gate.smcLastBreak || null,
      rr: (gate.rr != null && isFinite(gate.rr)) ? gate.rr : null,
      slPct: (gate.slPct != null && isFinite(gate.slPct)) ? gate.slPct : null,
      // Standard-R:R levels (entry / structural stop / next-resistance T1)
      // so the chip tooltip can show exactly how the R:R was framed.
      rrEntry: (gate.rrEntry != null && isFinite(gate.rrEntry)) ? gate.rrEntry : null,
      rrSl: (gate.rrSl != null && isFinite(gate.rrSl)) ? gate.rrSl : null,
      rrT1: (gate.rrT1 != null && isFinite(gate.rrT1)) ? gate.rrT1 : null,
      zoneFreshness: gate.zoneFreshness || null,
      zoneTestCount: gate.zoneTestCount || 0
    };
    result.riskFlags = flags;
    return result;
  }

  function _resolveVerdictCore(fibClass, fibTouchedZone, bounceStatus, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf, pocketVsZone) {
    var result = { text: '', cls: 'sw-neutral', sub: '', tip: '' };
    var rules = _verdictRules;
    // Geometry axis is only meaningful for the FIB+ZOI path; default to
    // 'N/A' so a missing value never silently skips every combined rule.
    if (pocketVsZone === undefined || pocketVsZone === null) pocketVsZone = 'N/A';

    var zoiZone = zoiPos ? zoiPos.zone : null;
    var tplVars = {
      price: '\u20B9' + Math.round(currentPx),
      tf: tf,
      distal: zoiZone ? Math.round(zoiZone.distal) : '',
      proximal: zoiZone ? Math.round(zoiZone.proximal) : '',
      pattern: zoiZone ? zoiZone.patternLabel : '',
      score: zoiZone ? zoiZone.score : (zoiPos && zoiPos.combinedScore ? zoiPos.combinedScore : '')
    };

    if (!rules) {
      return _resolveVerdictFallback(fibClass, fibTouchedZone, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf);
    }

    var zoiPosition = zoiPos ? zoiPos.position : 'BETWEEN_ZONES';
    var zone = 'none';
    // FAR_BELOW_SUPPLY_NEAR_DEMAND carries both tokens — a SUPPLY-relative
    // position must classify as supply, so exclude any '…SUPPLY…' code from
    // the demand branch (true demand codes never contain SUPPLY).
    if (zoiPosition.indexOf('DEMAND') >= 0 && zoiPosition.indexOf('SUPPLY') < 0) zone = 'demand';
    else if (zoiPosition.indexOf('SUPPLY') >= 0) zone = 'supply';

    if (hasFib && hasZoi) {
      var combined = rules.fibZoiCombined;
      for (var i = 0; i < combined.length; i++) {
        var r = combined[i];
        if (!_matchFibClass(r.fibClass, fibClass)) continue;
        // v4 schema: match the FULL ZOI position (16 states) AND the
        // pocket↔zone geometry, so true confluence (OVERLAP) is scored
        // differently from a pocket sitting above/below the zone.
        if (r.zoiPosition && r.zoiPosition !== zoiPosition) continue;
        if (r.pocketVsZone && r.pocketVsZone !== pocketVsZone) continue;
        // v3 legacy schema: collapsed zone + rising. Guarded by the
        // undefined/null checks, so these are no-ops on v4 rules and
        // keep working if any legacy rule is ever reintroduced.
        if (r.zone && r.zone !== 'any' && r.zone !== zone) continue;
        if (r.rising !== undefined && r.rising !== null && r.rising !== zoiRising) continue;
        if (r.touchedZone !== undefined && r.touchedZone !== null && r.touchedZone !== fibTouchedZone) continue;
        if (r.bounceStatus && r.bounceStatus !== bounceStatus) continue;
        result.text = r.verdict;
        result.cls = _colorToClass(r.color);
        result.sub = _interpolateTemplate(r.sub, tplVars);
        result.tip = _interpolateTemplate(r.tooltip, tplVars);
        return result;
      }
      var fibFallback = rules.fibOnly;
      for (var fi = 0; fi < fibFallback.length; fi++) {
        var fr = fibFallback[fi];
        if (!_matchFibClass(fr.fibClass, fibClass)) continue;
        if (fr.touchedZone !== undefined && fr.touchedZone !== null && fr.touchedZone !== fibTouchedZone) continue;
        if (fr.bounceStatus && fr.bounceStatus !== bounceStatus) continue;
        result.text = fr.verdict;
        result.cls = _colorToClass(fr.color);
        result.sub = _interpolateTemplate(fr.sub, tplVars);
        result.tip = _interpolateTemplate(fr.tooltip, tplVars);
        return result;
      }
    } else if (hasFib) {
      var fibRules = rules.fibOnly;
      for (var j = 0; j < fibRules.length; j++) {
        var fRule = fibRules[j];
        if (!_matchFibClass(fRule.fibClass, fibClass)) continue;
        if (fRule.touchedZone !== undefined && fRule.touchedZone !== null && fRule.touchedZone !== fibTouchedZone) continue;
        if (fRule.bounceStatus && fRule.bounceStatus !== bounceStatus) continue;
        result.text = fRule.verdict;
        result.cls = _colorToClass(fRule.color);
        result.sub = _interpolateTemplate(fRule.sub, tplVars);
        result.tip = _interpolateTemplate(fRule.tooltip, tplVars);
        return result;
      }
    } else if (hasZoi) {
      var zoiRules = rules.zoiOnly;
      // Combination context (2026-05-31): the demand+supply geometry the
      // classifier now exposes. `room` grades a demand-floor bounce by its
      // reward:risk to the overhead ceiling; `noDemand` flags that no demand
      // floor survives below price. Rules carrying these fields are matched
      // ONLY when they agree, and MUST be ordered before their generic
      // (field-less) sibling so the specific case wins. Generic rules omit
      // the fields and match as before — so FIB and FIB+ZOI paths, which
      // never read room/noDemand, are completely unaffected.
      var _zoiRoom = zoiPos ? zoiPos.room : null;
      var _zoiNoDemand = !!(zoiPos && zoiPos.noDemand);
      for (var k = 0; k < zoiRules.length; k++) {
        var zRule = zoiRules[k];
        if (zRule.position && zRule.position !== zoiPosition) continue;
        if (zRule.room && zRule.room !== _zoiRoom) continue;
        if (zRule.noDemand === true && !_zoiNoDemand) continue;
        if (zRule.rising !== undefined && zRule.rising !== null && zRule.rising !== zoiRising) continue;
        result.text = zRule.verdict;
        result.cls = _colorToClass(zRule.color);
        result.sub = _interpolateTemplate(zRule.sub, tplVars);
        result.tip = _interpolateTemplate(zRule.tooltip, tplVars);
        return result;
      }
    }

    var noneRules = rules.zoiOnly;
    for (var n = 0; n < noneRules.length; n++) {
      if (noneRules[n].position === 'BETWEEN_ZONES') {
        result.text = 'WAIT';
        result.cls = 'sw-neutral';
        result.sub = _interpolateTemplate(noneRules[n].sub, tplVars);
        result.tip = _interpolateTemplate(noneRules[n].tooltip, tplVars);
        return result;
      }
    }

    result.text = '\u2014';
    result.sub = 'no signal data';
    return result;
  }

  function _resolveVerdictFallback(fibClass, fibTouchedZone, zoiRising, zoiPos, hasFib, hasZoi, currentPx, tf) {
    var r = { text: '\u2014', cls: 'sw-neutral', sub: 'loading rules\u2026', tip: 'Recommendation rules are loading. Refresh in a moment.' };
    if (hasFib && fibClass === 'IN_POCKET_RISING') { r.text = 'BUY'; r.cls = 'sw-bull'; r.sub = 'golden pocket bounce (fallback)'; }
    else if (hasFib && fibClass === 'AT_SWING_HIGH') { r.text = 'AVOID'; r.cls = 'sw-bear'; r.sub = 'at swing high'; }
    else if (hasZoi && zoiPos && zoiPos.position.indexOf('DEMAND') >= 0 && zoiPos.position.indexOf('SUPPLY') < 0 && zoiRising) { r.text = 'BUY'; r.cls = 'sw-bull'; r.sub = 'demand zone bounce (fallback)'; }
    else if (hasZoi && zoiPos && zoiPos.position.indexOf('SUPPLY') >= 0) { r.text = 'AVOID'; r.cls = 'sw-bear'; r.sub = 'at supply zone (fallback)'; }
    return r;
  }

  // ATR as a % of the latest close, for ONE stock's candles. This is the
  // unit the zone near/far thresholds are built on (volatility-adaptive),
  // while the UI still displays plain %. Robustness rules baked in:
  //   • raw is newest-first; atr() needs oldest-first → reverse once.
  //   • cap raw ATR at 1.5× the median of THIS stock's own recent ATR so a
  //     single freak bar (gap/news spike) can't inflate the threshold. The
  //     cap is SELF-CONTAINED per call (no cross-stock cache) so every stock
  //     in a universe scan is judged by its OWN volatility — consistent.
  //   • returns null (never NaN) when there isn't enough clean data, so the
  //     caller fails safe to the legacy fixed-% thresholds.
  function _zoiAtrPct(rawCandles) {
    if (!rawCandles || rawCandles.length < 16) return null;
    var c = rawCandles.slice().reverse();        // oldest-first for atr()
    var series = atr(c, 14);
    var last = NaN;
    for (var i = series.length - 1; i >= 0; i--) {
      if (isFinite(series[i]) && series[i] > 0) { last = series[i]; break; }
    }
    if (!isFinite(last) || last <= 0) return null;
    var med = medianOfArr(series);               // NaN-safe; skips warmup NaNs
    var capped = (isFinite(med) && med > 0) ? Math.min(last, 1.5 * med) : last;
    var px = +c[c.length - 1][4];                // most recent close
    if (!isFinite(px) || px <= 0) return null;
    var pct = capped / px * 100;
    return (isFinite(pct) && pct > 0) ? pct : null;
  }

  // 3-way momentum for the zone-INTERIOR states (IN_DEMAND_* / IN_SUPPLY_*).
  // Refines the existing boolean `zoiRising` WITHOUT contradicting it:
  //   • RISING  ⟺ zoiRising is true (so this never disagrees with the other
  //               positions — NEAR_ABOVE_*, BROKE_ABOVE_* — that still read
  //               the boolean directly; RISING stays exactly "HH-HL").
  //   • the "not rising" space (which used to all become *_FALLING) is split:
  //       FALLING       = a CLEAR down-sequence (>=2 lower-highs AND >=2
  //                       lower-lows over the last ~4 confirmed bars).
  //       CONSOLIDATING = a tight, low-volatility base (mean of the last 3
  //                       bars' range <= 0.6x the stock's ATR%) OR simply no
  //                       clear directional sequence (choppy/flat). Coiling.
  // Confirmed bars only — `rawCandles` already excludes the live forming bar
  // upstream, and is newest-first. Fails safe to CONSOLIDATING (the neutral,
  // non-actionable bucket) when there isn't enough clean data, so a sparse
  // series never manufactures a FALLING (AVOID) read it can't justify.
  // The 0.6x multiplier moves a verdict boundary — chosen conservative
  // (most "not clearly rising" coils read CONSOLIDATING, not FALLING) and is
  // backtest-tunable, not a free knob.
  var ZOI_CONSOLIDATION_ATR_MULT = 0.6;
  function _zoiMomentum(rawCandles, atrPct, rising) {
    if (rising) return 'RISING';
    if (!rawCandles || rawCandles.length < 4) return 'CONSOLIDATING';
    var h0 = +rawCandles[0][2], h1 = +rawCandles[1][2], h2 = +rawCandles[2][2], h3 = +rawCandles[3][2];
    var l0 = +rawCandles[0][3], l1 = +rawCandles[1][3], l2 = +rawCandles[2][3], l3 = +rawCandles[3][3];
    if (![h0, h1, h2, h3, l0, l1, l2, l3].every(isFinite)) return 'CONSOLIDATING';
    // newest-first: a down-sequence means each older bar was higher.
    var lhC = (h0 < h1 ? 1 : 0) + (h1 < h2 ? 1 : 0) + (h2 < h3 ? 1 : 0);
    var llC = (l0 < l1 ? 1 : 0) + (l1 < l2 ? 1 : 0) + (l2 < l3 ? 1 : 0);
    var fallingSeq = (lhC >= 2 && llC >= 2);
    // Tightness: mean of last 3 confirmed bars' (high-low)/close vs ATR%.
    var tight = false;
    if (isFinite(atrPct) && atrPct > 0) {
      var sum = 0, nn = 0;
      for (var i = 0; i < 3 && i < rawCandles.length; i++) {
        var hi = +rawCandles[i][2], lo = +rawCandles[i][3], cl = +rawCandles[i][4];
        if (isFinite(hi) && isFinite(lo) && isFinite(cl) && cl > 0) { sum += (hi - lo) / cl * 100; nn++; }
      }
      if (nn > 0) tight = (sum / nn) <= ZOI_CONSOLIDATION_ATR_MULT * atrPct;
    }
    // A coiling base takes priority over a weak/ambiguous down-read.
    if (tight && !fallingSeq) return 'CONSOLIDATING';
    if (fallingSeq) return 'FALLING';
    // Not tight, no clear down-sequence (choppy/mixed) -> no directional
    // edge -> CONSOLIDATING (conservative: not labelled FALLING/AVOID).
    return 'CONSOLIDATING';
  }

  // zoiAtrPct: ATR-as-%-of-price for THIS stock (from _zoiAtrPct), or null.
  // When null (sparse data) the near/far thresholds fall back to the legacy
  // fixed %s — fail safe, identical to pre-ATR behaviour.
  function _classifyZoiPosition(zones, currentPx, rawCandles, zoiRising, zoiAtrPct) {
    if (!zones || zones.length === 0) return { position: 'BETWEEN_ZONES', zone: null, distPct: 0, cameFromBelow: false, roomToRun: 1 };

    var demandZones = [];
    var supplyZones = [];
    for (var i = 0; i < zones.length; i++) {
      if (zones[i].type === 'DEMAND') demandZones.push(zones[i]);
      else if (zones[i].type === 'SUPPLY') supplyZones.push(zones[i]);
    }

    // ── Near/far thresholds: ATR-adaptive, clamped (2026-06-05) ──────────
    // Internally we measure distance in the stock's OWN volatility (ATR),
    // not a flat %, so "near a zone" means the same risk distance whether
    // the stock is a calm largecap or a wild midcap. The clamps are the
    // safety rail: without a floor a dead-flat stock makes "near"
    // microscopic; without a ceiling a freak-volatility stock calls
    // everything "near". Multipliers + clamps signed off 2026-06-05 — they
    // move verdict boundaries, so they are backtested, not free knobs. When
    // ATR is unavailable we fall back to the original fixed %s (fail safe).
    function _clampPct(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    var _atrPct = (isFinite(zoiAtrPct) && zoiAtrPct > 0) ? zoiAtrPct : null;
    var NEAR_MAX     = _atrPct ? _clampPct(1.5 * _atrPct, 4, 12) : 10;  // "at the zone"
    var BREAKOUT_MAX = _atrPct ? _clampPct(1.0 * _atrPct, 2, 6)  : 5;   // "just broke it"
    var STACKED_PCT  = _atrPct ? _clampPct(0.5 * _atrPct, 1, 3)  : 2;   // "two zones = one"
    var RECOVERY_LOOK = 8;
    var STACKED_MIN_SCORE = 120;

    var bestDemand = null;
    var bestDemandDist = Infinity;
    for (var d = 0; d < demandZones.length; d++) {
      var dz = demandZones[d];
      var dist = Math.abs(currentPx - dz.proximal) / dz.proximal * 100;
      if (dist < bestDemandDist) { bestDemandDist = dist; bestDemand = dz; }
    }

    var bestSupply = null;
    var bestSupplyDist = Infinity;
    for (var s = 0; s < supplyZones.length; s++) {
      var sz = supplyZones[s];
      var sDist = Math.abs(sz.proximal - currentPx) / sz.proximal * 100;
      if (sDist < bestSupplyDist) { bestSupplyDist = sDist; bestSupply = sz; }
    }

    var cameFromBelow = false;
    if (bestDemand && rawCandles && rawCandles.length >= 2) {
      var lookback = Math.min(RECOVERY_LOOK, rawCandles.length);
      for (var rb = 1; rb < lookback; rb++) {
        if (+rawCandles[rb][4] < bestDemand.distal) { cameFromBelow = true; break; }
      }
    }

    // Check for stacked demand zones
    if (demandZones.length >= 2 && zoiRising) {
      for (var s1 = 0; s1 < demandZones.length - 1; s1++) {
        for (var s2 = s1 + 1; s2 < demandZones.length; s2++) {
          var proxDiff = Math.abs(demandZones[s1].proximal - demandZones[s2].proximal) / demandZones[s1].proximal * 100;
          var combinedScore = demandZones[s1].score + demandZones[s2].score;
          if (proxDiff <= STACKED_PCT && combinedScore >= STACKED_MIN_SCORE) {
            var stackedZone = demandZones[s1].score >= demandZones[s2].score ? demandZones[s1] : demandZones[s2];
            var insideStacked = currentPx >= stackedZone.distal && currentPx <= stackedZone.proximal * (1 + NEAR_MAX / 100);
            if (insideStacked) {
              return { position: 'STACKED_DEMAND_RISING', zone: stackedZone, distPct: 0, cameFromBelow: false, roomToRun: 1, room: _roomBucket(currentPx, stackedZone, bestSupply), combinedScore: combinedScore };
            }
          }
        }
      }
    }

    // Which zone is price actually closest to? Distance is measured to
    // the NEAREST EDGE of each zone (0 when price is inside the band).
    // The nearest zone drives the classification so we never narrate a
    // far demand zone while price is sitting at a supply zone (or vice
    // versa). DEMAND: proximal=top, distal=bottom. SUPPLY: proximal=
    // bottom, distal=top.
    function _edgeDist(px, z) {
      if (z.type === 'DEMAND') {
        var dTop = z.proximal, dBot = z.distal;
        if (px >= dBot && px <= dTop) return 0;
        return px > dTop ? px - dTop : dBot - px;
      }
      var sLo = z.proximal, sHi = z.distal;
      if (px >= sLo && px <= sHi) return 0;
      return px < sLo ? sLo - px : px - sHi;
    }
    // Room grade for a LONG taken off the demand floor: reward (distance up
    // to the nearest overhead supply) vs risk (distance down to just below
    // the demand floor). Drives the combination-rule conviction in ZOI mode
    // (2026-05-31). Returns:
    //   OPEN     — no supply overhead at all (unlimited target, e.g. at highs)
    //   WIDE     — >= 2R of room to the ceiling (high-conviction bounce)
    //   MODERATE — 1.2R..2R (BUY stands, normal conviction)
    //   TIGHT    — < 1.2R (ceiling too close to pay for the risk -> demote a
    //              bounce BUY to WATCH; chasing here is poor reward:risk)
    //   null     — not applicable (price not above the demand floor)
    // Thresholds: a swing trade wants ~>=2R to a clean target; below ~1.2R the
    // trade can't reasonably clear its own risk before hitting resistance.
    function _roomBucket(px, demandZone, supplyZone) {
      if (!demandZone) return null;
      var stop = demandZone.distal;
      if (!(px > stop)) return null;
      if (!supplyZone || supplyZone.proximal <= px) return 'OPEN';
      var reward = supplyZone.proximal - px;
      var risk = px - stop;
      if (risk <= 0) return 'OPEN';
      var rr = reward / risk;
      if (rr >= 2) return 'WIDE';
      if (rr < 1.2) return 'TIGHT';
      return 'MODERATE';
    }

    var _supEdge = bestSupply ? _edgeDist(currentPx, bestSupply) : Infinity;
    var _demEdge = bestDemand ? _edgeDist(currentPx, bestDemand) : Infinity;
    var _supplyNearest = bestSupply && _supEdge <= _demEdge;

    // SUPPLY zone classification — runs when supply is the nearest
    // structure (or the only one). ALWAYS returns a supply-relative
    // position, so a stock interacting with supply can never silently
    // fall through to a distant demand narrative.
    if (bestSupply && _supplyNearest) {
      if (currentPx > bestSupply.distal) {
        // Price ABOVE supply distal (broke out).
        var breakoutPct = (currentPx - bestSupply.distal) / bestSupply.distal * 100;
        if (breakoutPct <= BREAKOUT_MAX) {
          return { position: zoiRising ? 'BROKE_ABOVE_SUPPLY_RISING' : 'BROKE_ABOVE_SUPPLY_FALLING', zone: bestSupply, distPct: breakoutPct, cameFromBelow: false, roomToRun: 1 };
        }
        // Broke out but ran far past it — extended, don't chase.
        return { position: 'FAR_ABOVE_SUPPLY', zone: bestSupply, distPct: breakoutPct, cameFromBelow: false, roomToRun: 1 };
      } else if (currentPx >= bestSupply.proximal) {
        // Inside supply (proximal..distal). Split on 3-way momentum:
        //   RISING        -> breakout brewing (still unconfirmed -> WATCH)
        //   CONSOLIDATING -> coiling under resistance (WATCH)
        //   FALLING       -> active rejection (AVOID, the legacy IN_SUPPLY call)
        var supMom = _zoiMomentum(rawCandles, zoiAtrPct, zoiRising);
        var supPos = supMom === 'RISING' ? 'IN_SUPPLY_RISING'
          : (supMom === 'FALLING' ? 'IN_SUPPLY_FALLING' : 'IN_SUPPLY_CONSOLIDATING');
        return { position: supPos, zone: bestSupply, distPct: 0, cameFromBelow: false, roomToRun: 0 };
      }
      // Below the supply proximal — approaching resistance from below.
      var distBelowSupply = (bestSupply.proximal - currentPx) / bestSupply.proximal * 100;
      if (distBelowSupply <= NEAR_MAX) {
        return { position: 'NEAR_BELOW_SUPPLY', zone: bestSupply, distPct: distBelowSupply, cameFromBelow: false, roomToRun: 0 };
      }
      // >10% below supply. Split on whether ANY demand zone survives below:
      // demand present → _NEAR_DEMAND (a floor to wait for); none → _ABOVE_DEMAND
      // (no support beneath price — falling-knife territory). Names per the ZOI
      // taxonomy; noDemand kept for any legacy reader.
      return bestDemand
        ? { position: 'FAR_BELOW_SUPPLY_NEAR_DEMAND', zone: bestSupply, distPct: distBelowSupply, cameFromBelow: false, roomToRun: 1, noDemand: false }
        : { position: 'FAR_BELOW_SUPPLY_ABOVE_DEMAND', zone: bestSupply, distPct: distBelowSupply, cameFromBelow: false, roomToRun: 1, noDemand: true };
    }

    // Demand zone classification — runs when demand is the nearest
    // structure (or the only one).
    if (bestDemand) {
      var roomToRun = 1;
      if (bestSupply && bestSupply.proximal > bestDemand.proximal) {
        var totalRange = bestSupply.proximal - bestDemand.proximal;
        roomToRun = totalRange > 0 ? (bestSupply.proximal - currentPx) / totalRange : 1;
      }
      // Reward:risk room to the overhead ceiling (drives combination-rule
      // conviction; only meaningful when price is at/above the demand floor).
      var _demRoom = _roomBucket(currentPx, bestDemand, bestSupply);

      if (currentPx < bestDemand.distal) {
        // Below demand zone
        return { position: 'BROKE_BELOW_DEMAND', zone: bestDemand, distPct: (bestDemand.distal - currentPx) / bestDemand.distal * 100, cameFromBelow: false, roomToRun: roomToRun };
      } else if (currentPx >= bestDemand.distal && currentPx <= bestDemand.proximal) {
        // Inside demand zone
        if (cameFromBelow && zoiRising) {
          return { position: 'RECOVERED_INTO_DEMAND_RISING', zone: bestDemand, distPct: 0, cameFromBelow: true, roomToRun: roomToRun, room: _demRoom };
        }
        // 3-way momentum: RISING (bounce) | FALLING (still dropping through
        // the zone) | CONSOLIDATING (basing on the floor — coiling, no bounce
        // yet but holding support). The flat slice that USED to be lumped into
        // *_FALLING (AVOID) now reads CONSOLIDATING (WATCH).
        var demMom = _zoiMomentum(rawCandles, zoiAtrPct, zoiRising);
        var demPos = demMom === 'RISING' ? 'IN_DEMAND_RISING'
          : (demMom === 'FALLING' ? 'IN_DEMAND_FALLING' : 'IN_DEMAND_CONSOLIDATING');
        return { position: demPos, zone: bestDemand, distPct: 0, cameFromBelow: cameFromBelow, roomToRun: roomToRun, room: _demRoom };
      } else {
        // Above demand zone
        var distAboveDemand = (currentPx - bestDemand.proximal) / bestDemand.proximal * 100;
        if (distAboveDemand <= NEAR_MAX) {
          if (cameFromBelow && zoiRising) {
            return { position: 'RECOVERED_ABOVE_DEMAND_RISING', zone: bestDemand, distPct: distAboveDemand, cameFromBelow: true, roomToRun: roomToRun, room: _demRoom };
          }
          return { position: zoiRising ? 'NEAR_ABOVE_DEMAND_RISING' : 'NEAR_ABOVE_DEMAND_FALLING', zone: bestDemand, distPct: distAboveDemand, cameFromBelow: cameFromBelow, roomToRun: roomToRun, room: _demRoom };
        } else {
          // Far above demand (>10%). Extended away from the only support
          // — chasing here is poor risk:reward regardless of momentum or
          // "room to run" (which defaults to max when there's no overhead
          // supply, e.g. at all-time highs). Single WAIT verdict (Z5).
          return { position: 'FAR_ABOVE_DEMAND', zone: bestDemand, distPct: distAboveDemand, cameFromBelow: false, roomToRun: roomToRun };
        }
      }
    }

    // No zone is relevant (neither demand nor supply within reach).
    return { position: 'BETWEEN_ZONES', zone: null, distPct: 0, cameFromBelow: false, roomToRun: 1 };
  }

  // ── Two-sided zone readout (scan-table REASONING, display only) ─────────
  // Renders "3% above demand · 6% below supply" + a plain-words ATR hint that
  // turns the ACTIONABLE distance into the stock's own volatility units
  // ("≈1½ normal days off the floor"). Pure display — NEVER alters a verdict.
  // It re-derives the nearest demand/supply from the SAME zones the
  // classifier saw and measures to each zone's proximal edge, so the numbers
  // always agree with the badge. The hint anchors to whichever side the
  // position is classified against (SUPPLY → ceiling, else DEMAND → floor).
  //   zones     : detectZones() output (same array passed to the classifier)
  //   currentPx : last close
  //   position  : zoiPos.position (drives which side the ATR hint anchors to)
  //   atrPct    : _zoiAtrPct(raw) — null/0 disables the hint (still shows %)
  //   tf        : timeframe key → unit word (day/week/month/bar)
  // Returns '' when no usable zone exists.
  function _zoiUnitWord(tf) {
    if (tf === '1d') return 'day';
    if (tf === '1w') return 'week';
    if (tf === '1mo') return 'month';
    return 'bar';
  }
  function _zoiFmtHalf(x) {
    // Round to nearest 0.5; render whole/half with a ½ glyph: "½","1","1½".
    var r = Math.round(x * 2) / 2;
    var whole = Math.floor(r);
    var frac = r - whole;
    if (frac === 0) return String(whole);
    return (whole === 0 ? '' : String(whole)) + '\u00bd';
  }
  function _zoiPctWord(pct, zoneWord, aboveWord, belowWord) {
    var a = Math.abs(pct);
    if (a < 0.5) return 'at ' + zoneWord;
    return a.toFixed(a < 10 ? 1 : 0) + '% ' + (pct >= 0 ? aboveWord : belowWord) + ' ' + zoneWord;
  }
  function _zoiTwoSidedReadout(zones, currentPx, position, atrPct, tf) {
    if (!zones || !zones.length || !isFinite(currentPx) || currentPx <= 0) return '';
    var bestD = null, bestDd = Infinity, bestS = null, bestSd = Infinity;
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (!z || !isFinite(z.proximal) || z.proximal <= 0) continue;
      if (z.type === 'DEMAND') {
        var dd = Math.abs(currentPx - z.proximal);
        if (dd < bestDd) { bestDd = dd; bestD = z; }
      } else if (z.type === 'SUPPLY') {
        var sd = Math.abs(z.proximal - currentPx);
        if (sd < bestSd) { bestSd = sd; bestS = z; }
      }
    }
    var parts = [], demandPct = null, supplyPct = null;
    if (bestD) {
      demandPct = (currentPx - bestD.proximal) / bestD.proximal * 100;  // + above demand
      parts.push(_zoiPctWord(demandPct, 'demand', 'above', 'below'));
    }
    if (bestS) {
      supplyPct = (bestS.proximal - currentPx) / bestS.proximal * 100;  // + below supply
      parts.push(_zoiPctWord(supplyPct, 'supply', 'below', 'above'));
    }
    if (!parts.length) return '';
    var readout = parts.join(' \u00b7 ');
    // ATR hint on the actionable side only — keeps the cell honest about how
    // "near" the % really is in this stock's volatility (a flat % lies across
    // calm vs wild names; ATR units don't).
    if (isFinite(atrPct) && atrPct > 0 && position) {
      var rel = null, anchor = '', edge = '';
      if (position.indexOf('SUPPLY') >= 0 && supplyPct != null) { rel = Math.abs(supplyPct); anchor = 'under the ceiling'; edge = 'at the ceiling'; }
      else if (position.indexOf('DEMAND') >= 0 && demandPct != null) { rel = Math.abs(demandPct); anchor = 'off the floor'; edge = 'at the floor'; }
      if (rel != null) {
        var units = rel / atrPct;
        var rounded = Math.round(units * 2) / 2;
        if (rounded < 0.5) readout += ' (right ' + edge + ')';
        else readout += ' (\u2248' + _zoiFmtHalf(units) + ' normal ' + _zoiUnitWord(tf) + (rounded > 1 ? 's' : '') + ' ' + anchor + ')';
      }
    }
    return readout;
  }

  // ═══════════════════════════════════════════════════════════════
  // DETAIL-CARD VERDICT (TF-aware) — 2026-05-30 multi-TF redesign
  // ═══════════════════════════════════════════════════════════════
  // Computes the swing verdict + risk context for ONE timeframe using
  // the SAME engine the bulk scan uses (computeFibZone / detectZones /
  // _resolveVerdict). Called from renderResult AND from renderMainChart
  // so the verdict + Risk Context card recompute LIVE when the chart TF
  // changes. Signalled TFs (1mo / 1w / 1d / 4h / 1h) each get an
  // INDEPENDENT live verdict computed only from that TF's own candles
  // — no cross-TF influence, and 4h/1h do NOT feed the daily/weekly
  // composite screener. Sub-hour TFs (30m / 15m / 5m) are too fast to
  // frame a reliable leg, so they echo the last signalled-TF verdict
  // + a note instead. The allow-list is SW_TF_LABEL.
  // NOTE: the FIB classification below mirrors _computeStockVerdict —
  // keep the two in sync if the fib buckets ever change.
  function _swHigherTfBias(tf) {
    var R = STATE.result; if (!R) return null;
    var htf = SW_HIGHER_TF[tf];
    if (!htf) return null;
    var an = htf === '1mo' ? R.monthly : (htf === '1w' ? R.weekly : R.daily);
    return { tf: htf, trend: (an && an.trend) || 'n/a' };
  }

  function swComputeVerdictForTf(tf) {
    var R = STATE.result;
    tf = tf || '1d';
    if (!R || !R.candles) return null;
    // Signalled TFs (SW_TF_LABEL: 1M/1W/1D/4H/1H) emit a BUY/WAIT
    // recommendation. Sub-hourly reco TFs (30m/15m/5m) are CARDS-ONLY: we
    // still compute the INFORMATIONAL Risk Context + Expected Move from
    // THEIR OWN candles (per user: "only block recommendation, rest we
    // should see it"), but we never surface a verdict and never overwrite
    // the last-signalled-TF echo below.
    var _signalled = !!SW_TF_LABEL[tf];
    // Echo the last SIGNALLED verdict on the sub-hourly chip ("Last signal:
    // WAIT on 1 Hour"). Only if it belongs to the CURRENT stock — never leak
    // a previous stock's verdict during the brief async window before
    // renderMainChart recomputes on a swing TF.
    var _lsEcho = STATE.lastSwingVerdict || null;
    var _curIsin = (STATE.selected && STATE.selected.isin) || null;
    if (_lsEcho && _curIsin && _lsEcho.isin && _lsEcho.isin !== _curIsin) _lsEcho = null;
    var raw = R.candles[tf];
    if (!raw || raw.length < (SW_TF_MIN_BARS[tf] || 8)) {
      // Too-thin data: signalled TFs show "not enough data"; sub-hourly
      // shows the cards-only note (intraday:true) with no panels to paint.
      return _signalled
        ? { tf: tf, intraday: false, noData: true }
        : { tf: tf, intraday: true, noData: true, lastSwing: _lsEcho };
    }
    var currentPx = isFinite(R.ltp) && R.ltp ? R.ltp : +raw[0][4];

    // Recommendation basis is the user's LIVE choice in the chart-card
    // selector (window.swSetRecoMode), FULLY INDEPENDENT of scanning.
    // Scanning only decides which stocks to surface; it never dictates how
    // THIS card computes. Default FIB (golden-pocket only).
    var _cardMode = swGetRecoMode();
    // SINGLE SOURCE: FIB + ZOI + gate + verdict all come from the shared
    // helper (same engine the bulk scan uses — no drift). The CARD seeds
    // currentPx with the LIVE LTP and runs the full pattern path (candle +
    // geometric chart patterns, withChart=true). ownAn is computed here
    // because it is also used below for the expected-move sigma.
    var ownAn = analyzeTf(raw, tf) || {};
    var _inputs = swComputeVerdictInputs(raw, tf, _cardMode, {
      an: ownAn,
      currentPx: currentPx,
      regime: R.regime,
      withChartPatterns: true
    });
    // Alias the helper's outputs to the locals the rest of this function (the
    // return payloads + reasoning block) already reference — minimal churn,
    // single producer.
    var hasFib = _inputs.hasFib, hasZoi = _inputs.hasZoi;
    var fibClass = _inputs.fibClass, fibTouchedZone = _inputs.fibTouchedZone;
    var fibResult = _inputs.fibResult, retPct = _inputs.retPct;
    var zoiPos = _inputs.zoiPos, zoiRising = _inputs.zoiRising;
    var gate = _inputs.gate, zone = _inputs.zone, vr = _inputs.vr;
    currentPx = _inputs.currentPx;
    var basis = (hasFib && hasZoi) ? 'FIB+ZOI' : (hasFib ? 'FIB' : (hasZoi ? 'ZOI' : 'NONE'));
    // Expected-move probability cone for THIS TF's horizons, centered on
    // the live LTP. σ is measured from CONFIRMED bars only (non-repainting,
    // per the trading rules); only the display center uses the live price.
    // A range estimate — never a direction. null when σ can't be computed.
    var _expMove = _swBuildExpectedMove(ownAn.emSigma, currentPx, tf);
    if (!_signalled) {
      // CARDS-ONLY (sub-hourly): attach the INFORMATIONAL panels — Risk
      // Context (built from THIS TF's own gate) + Expected Move — but NO
      // recommendation. intraday:true makes swPaintVerdict render the
      // "sub-hourly — not a signal" note on the chip instead of a verdict.
      // We deliberately do NOT write STATE.lastSwingVerdict: the echo must
      // stay anchored to the last SIGNALLED TF (e.g. "WAIT on 1 Hour").
      return {
        tf: tf, intraday: true, lastSwing: _lsEcho,
        riskContext: vr.riskContext || null,
        riskFlags: vr.riskFlags || null,
        basis: basis,
        higherBias: _swHigherTfBias(tf),
        expectedMove: _expMove
      };
    }
    STATE.lastSwingVerdict = { tf: tf, text: vr.text, cls: vr.cls, sub: vr.sub, basis: basis, isin: (STATE.selected && STATE.selected.isin) || null };
    return {
      tf: tf, intraday: false,
      text: vr.text, cls: vr.cls, sub: vr.sub, tip: vr.tip,
      strongBuy: vr.strongBuy || false,
      riskContext: vr.riskContext || null,
      riskFlags: vr.riskFlags || null,
      confluence: vr.confluence || null,
      conviction: vr.conviction || null,
      basis: basis,
      // Gate inputs surfaced for the on-card REASONING block (display only —
      // the verdict itself is unchanged). The cards build a pass/fail
      // checklist from these so the trader sees WHICH criterion drove the
      // call (e.g. "✗ no higher-high/higher-low yet" on a demand WATCH).
      hasFib: hasFib, hasZoi: hasZoi,
      fibClass: hasFib ? fibClass : null,
      fibTouchedZone: hasFib ? fibTouchedZone : null,
      fibRising: hasFib ? !!(fibResult && fibResult.isRising) : null,
      fibRetPct: (hasFib && isFinite(retPct)) ? retPct : null,
      zoiPosition: hasZoi ? zoiPos.position : null,
      zoiRising: hasZoi ? zoiRising : null,
      zoiRoom: hasZoi ? (zoiPos.room || null) : null,
      zoiCameFromBelow: hasZoi ? !!zoiPos.cameFromBelow : null,
      zoiDistPct: hasZoi ? zoiPos.distPct : null,
      zoneFreshness: gate.zoneFreshness || null,
      zoneTestCount: gate.zoneTestCount || 0,
      zoneScore: (zone && isFinite(zone.score)) ? zone.score : null,
      higherBias: _swHigherTfBias(tf),
      expectedMove: _expMove
    };
  }

  // ── On-card REASONING block ────────────────────────────────────────────
  // Surfaces the verdict's reasoning ON the card (display only — never alters
  // the verdict). One checklist row = one rule criterion, with a theme-coloured
  // glyph so the trader sees WHICH gate drove the call. Icons are glyphs tinted
  // via CSS custom properties (.sw-rsn-* — see styles/swing-analyzer.css), so
  // they adapt to light/dark per the app theme.
  function _swRsnEsc(s) {
    return (typeof escapeHtml === 'function') ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s);
  }
  function _swRsnRow(kind, txt) {
    // kind: 'ok' (pass) | 'no' (fail) | 'warn' (caution) | 'info' (neutral)
    var glyph = kind === 'ok' ? '\u2713' : kind === 'no' ? '\u2717' : kind === 'warn' ? '\u26A0' : '\u2022';
    return '<div class="sw-rsn-row sw-rsn-' + kind + '">'
      + '<span class="sw-rsn-ico" aria-hidden="true">' + glyph + '</span>'
      + '<span class="sw-rsn-txt">' + _swRsnEsc(txt) + '</span>'
      + '</div>';
  }
  // Verdict-tied reasoning — used on the card that mirrors the recommendation
  // (the primary demand zone) and on the Fib card. scope = 'zoi' | 'fib'.
  function swRenderVerdictReasoning(v, scope) {
    if (!v || v.intraday || v.noData || !v.text) return '';
    // Reason line — strip the "BUY · BASIS (TF) — " prefix the BUY path
    // prepends, so the line never echoes the badge word.
    var reason = v.sub || '';
    if (v.text === 'BUY') {
      var _d = reason.indexOf(' \u2014 ');
      if (_d > 0) reason = reason.slice(_d + 3);
    }
    var checks = [];
    if (scope === 'zoi' && v.hasZoi) {
      var pos = v.zoiPosition || '';
      var dist = (v.zoiDistPct != null && isFinite(v.zoiDistPct)) ? v.zoiDistPct.toFixed(1) + '%' : '';
      if (pos.indexOf('IN_DEMAND') >= 0)          checks.push(_swRsnRow('ok', 'inside the demand zone'));
      else if (pos.indexOf('RECOVERED') >= 0)          checks.push(_swRsnRow('ok', 'reclaimed the demand zone' + (dist ? ' (' + dist + ' above)' : '')));
      else if (pos.indexOf('NEAR_ABOVE_DEMAND') >= 0) checks.push(_swRsnRow('ok', 'within 1\u201310% of demand' + (dist ? ' (' + dist + ')' : '')));
      else if (pos === 'FAR_ABOVE_DEMAND')            checks.push(_swRsnRow('no', 'extended >10% above demand' + (dist ? ' (' + dist + ')' : '')));
      else if (pos === 'BROKE_BELOW_DEMAND')                checks.push(_swRsnRow('no', 'price below the demand zone \u2014 support broken'));
      else if (pos.indexOf('SUPPLY') >= 0)            checks.push(_swRsnRow('info', 'at / near a supply zone (resistance)'));
      if (pos.indexOf('DEMAND') >= 0 || pos.indexOf('RECOVERED') >= 0) {
        checks.push(v.zoiRising ? _swRsnRow('ok', 'higher-high / higher-low confirmed')
                                : _swRsnRow('no', 'no higher-high / higher-low yet'));
      }
      if (v.zoiRoom) {
        var rm = String(v.zoiRoom).toUpperCase();
        checks.push(rm === 'TIGHT' ? _swRsnRow('warn', 'room above: tight \u2014 ceiling too close for R:R')
                                   : _swRsnRow('info', 'room above: ' + rm.toLowerCase()));
      }
      if (v.zoneFreshness === 'FRESH') checks.push(_swRsnRow('ok', 'fresh zone (untested)'));
      else if (v.zoneFreshness === 'TESTED') checks.push(_swRsnRow('warn', 'zone tested ' + (v.zoneTestCount || 1) + '\u00d7' + (v.zoneScore != null ? ' (score ' + v.zoneScore + ')' : '') + ' \u2014 weaker'));
    } else if (scope === 'fib' && v.hasFib) {
      // Golden-pocket bullet — must reflect where price ACTUALLY is, not just
      // the verdict's `fibTouchedZone` flag. `fibTouchedZone` is narrow: it's
      // true only when the pullback LOW stopped *inside* the pocket (a shallow
      // pullback that held the pocket as support). When price overshoots the
      // pocket — falls below the 80% level to the swing low, then recovers back
      // UP into the pocket (a RECOVERY) — `fibTouchedZone` is false even though
      // price is sitting in the pocket right now. The old binary printed
      // "never entered golden pocket" in that case, contradicting the IN_POCKET
      // class + ~71% retracement on the same card. Disambiguate by current
      // position (fibClass / retracement %), so the bullet never lies.
      var _ret = (v.fibRetPct != null && isFinite(v.fibRetPct)) ? v.fibRetPct : null;
      var _inPocketNow = (v.fibClass === 'IN_POCKET_RISING' || v.fibClass === 'IN_POCKET_FALLING')
        || (_ret != null && _ret >= 61.8 && _ret <= 80);
      if (_inPocketNow) {
        checks.push(_swRsnRow('ok', 'price is inside the golden pocket (61.8\u201380%)'));
      } else if (v.fibTouchedZone) {
        checks.push(_swRsnRow('ok', 'pulled back into the golden pocket (61.8\u201380%) and held'));
      } else if (_ret != null && _ret > 80) {
        checks.push(_swRsnRow('warn', 'overshot the pocket \u2014 dipped below 80%'
          + (v.fibRising ? ', now recovering' : ', still below')));
      } else {
        checks.push(_swRsnRow('no', 'not yet pulled back into the pocket (still above 61.8%)'));
      }
      if (_ret != null) {
        var rp = Math.round(_ret);
        var depth = rp < 50 ? ' (shallow)' : (rp > 80 ? ' (deep)' : '');
        checks.push(_swRsnRow('info', 'current retracement: ~' + rp + '%' + depth));
      }
      if (v.fibClass) checks.push(_swRsnRow('info', 'class: ' + String(v.fibClass).replace(/_/g, ' ').toLowerCase()));
      if (v.fibRising != null) {
        checks.push(v.fibRising ? _swRsnRow('ok', 'higher-high / higher-low confirmed')
                                : _swRsnRow('no', 'no higher-high / higher-low yet'));
      }
    }
    var extra = '';
    if (v.confluence && v.confluence.factors && v.confluence.factors.length) {
      extra += '<div class="sw-rsn-sub">Confluence (' + _swRsnEsc(v.confluence.tier) + ', ' + v.confluence.score + '/100)</div>';
      for (var c = 0; c < v.confluence.factors.length; c++) extra += _swRsnRow('ok', v.confluence.factors[c]);
    }
    if (v.riskFlags && v.riskFlags.length) {
      extra += '<div class="sw-rsn-sub">Risks to weigh</div>';
      for (var rfi = 0; rfi < v.riskFlags.length; rfi++) extra += _swRsnRow('warn', v.riskFlags[rfi]);
    }
    if (!reason && !checks.length && !extra) return '';
    return '<div class="sw-rsn">'
      + '<div class="sw-rsn-head">REASONING</div>'
      + (reason ? '<div class="sw-rsn-reason">' + _swRsnEsc(reason) + '</div>' : '')
      + checks.join('') + extra
      + '</div>';
  }
  // Per-zone descriptive reasoning — used on supply zones and any secondary
  // zone that is NOT the verdict's zone. Same visual block as the verdict
  // reasoning, but the content describes THAT zone's own role (a long-only
  // verdict isn't a buy/wait call on resistance), so it never contradicts.
  function swRenderZoneContextReasoning(zc, isDem, px) {
    if (!zc) return '';
    var lo = Math.min(zc.proximal, zc.distal), hi = Math.max(zc.proximal, zc.distal);
    var reason = isDem
      ? 'Support zone \u2014 buyers stepped in here before; a deeper floor if price pulls back.'
      : 'Resistance overhead \u2014 a ceiling / target for longs, not a buy level.';
    var checks = [];
    if (zc.testCount && zc.testCount > 0) checks.push(_swRsnRow('warn', 'tested ' + zc.testCount + '\u00d7' + (isFinite(zc.score) ? ' (score ' + zc.score + ')' : '') + ' \u2014 weaker'));
    else checks.push(_swRsnRow('ok', 'fresh (untested)'));
    if (isFinite(px) && px > 0) {
      if (px > hi)      checks.push(_swRsnRow('info', 'price ' + ((px - hi) / px * 100).toFixed(1) + '% above the zone'));
      else if (px < lo) checks.push(_swRsnRow('info', 'price ' + ((lo - px) / px * 100).toFixed(1) + '% below the zone'));
      else              checks.push(_swRsnRow('info', 'price inside the zone'));
    }
    var extra = '';
    if (!isDem) {
      checks.push(_swRsnRow('info', 'flips to a breakout BUY only on a close above the zone'));
      extra += '<div class="sw-rsn-sub">Risks to weigh</div>' + _swRsnRow('warn', 'caps the upside for any long taken lower');
    } else {
      checks.push(_swRsnRow('info', 'not the active setup \u2014 watch if price returns here'));
    }
    return '<div class="sw-rsn">'
      + '<div class="sw-rsn-head">REASONING</div>'
      + '<div class="sw-rsn-reason">' + _swRsnEsc(reason) + '</div>'
      + checks.join('') + extra
      + '</div>';
  }

  // Build the expected-move cone payload for a timeframe: project the per-bar
  // return σ to each horizon (√time) and frame the ±range + price band around
  // the current price. Pure; returns null when there isn't a usable σ/price.
  function _swBuildExpectedMove(sigma, ltp, tf) {
    if (sigma == null || !isFinite(sigma) || sigma <= 0) return null;
    if (!isFinite(ltp) || ltp <= 0) return null;
    var hzDefs = EM_HORIZONS_BY_TF[tf];
    if (!hzDefs) return null;
    var horizons = [];
    for (var i = 0; i < hzDefs.length; i++) {
      var b = emBand(ltp, sigma, hzDefs[i].bars);
      if (!b) continue;
      horizons.push({
        label: hzDefs[i].label,
        bars: hzDefs[i].bars,
        p68: b.p68, p95: b.p95,
        pct68: b.pct68, pct95: b.pct95,
        lo68: ltp - b.p68, hi68: ltp + b.p68,
        lo95: ltp - b.p95, hi95: ltp + b.p95
      });
    }
    if (!horizons.length) return null;
    return { ltp: ltp, tf: tf, sigmaPct: sigma * 100, horizons: horizons };
  }

  function _swRiskClsForTrend(t) {
    t = t || '';
    return t.indexOf('BULL') >= 0 ? 'sw-risk-good' : (t.indexOf('BEAR') >= 0 ? 'sw-risk-bad' : 'sw-risk-warn');
  }

  // ── Plain-English tooltips for the Risk Context chips ──
  // These replace the old jargon-heavy tips (50-DMA, SMC, BOS/CHoCH) with
  // beginner-friendly wording, and are value-specific so the hover text
  // explains what THIS reading means for a buy — not just what the metric
  // is in the abstract. Kept informational: none of these block a signal.

  // Regime = the mood of the WHOLE market (the Nifty 50 index), not this
  // one stock. Up market = tailwind for buying; down market = headwind.
  function _swRegimeTip(regime) {
    switch (regime) {
      case 'BULL':
        return 'Overall market: UP.\nThe whole market (Nifty 50 index) is trending higher right now. '
          + 'Most stocks rise when the market rises, so this is a tailwind for buying. Helpful, not required.';
      case 'BEAR':
        return 'Overall market: DOWN.\nThe whole market (Nifty 50 index) is trending lower right now. '
          + 'Most stocks fall when the market falls, so buying is riskier here. Buys are still allowed \u2014 just be more careful. This does not block the signal.';
      case 'NEUTRAL':
        return 'Overall market: FLAT.\nThe whole market (Nifty 50 index) has no clear direction right now \u2014 no extra push for or against new buys.';
      default:
        return 'Overall market: UNKNOWN.\nCouldn\u2019t read the broad market (Nifty 50 data unavailable), so it\u2019s ignored for this signal.';
    }
  }

  // Trend = THIS stock's own direction on the shown timeframe.
  function _swTrendTip(trend, tfLabel) {
    var t = trend || '';
    if (t.indexOf('BULL') >= 0)
      return 'This stock\u2019s own direction on the ' + tfLabel + ' chart: UP.\nIt\u2019s making higher highs \u2014 the trend favours buying.';
    if (t.indexOf('BEAR') >= 0)
      return 'This stock\u2019s own direction on the ' + tfLabel + ' chart: DOWN.\nBuying a falling stock is riskier \u2014 you\u2019re going against the trend.';
    return 'This stock\u2019s own direction on the ' + tfLabel + ' chart: SIDEWAYS.\nNo clear up or down trend yet.';
  }

  // Structure = the shape of price swings (highs & lows) on the chart.
  function _swStructureTip(smc) {
    if (smc === 'BULLISH')
      return 'Price shape: CLIMBING.\nEach swing high and low is higher than the last \u2014 the healthy shape of an uptrend.';
    if (smc === 'BEARISH')
      return 'Price shape: SINKING.\nEach swing high and low is lower than the last \u2014 the shape of a downtrend.';
    return 'Price shape: UNCLEAR.\nNot enough clean swings yet to tell whether price is climbing or sinking.';
  }

  // (_swTipToHtml removed 2026-06-06 — it rendered the verdict tooltip as card
  // HTML for the Full Signal Detail banner, which has been retired. Its only
  // caller is gone; the scan-table tooltip uses the raw text directly.)

  function swRiskContextHtml(info) {
    var rc = info.riskContext || {};
    var tfLabel = SW_TF_LABEL[info.tf] || info.tf;
    function chip(label, val, cls, tip) {
      return '<div class="sw-risk-chip ' + (cls || '') + '"' + (tip ? ' title="' + escapeHtml(tip) + '"' : '') + '>'
        + '<span class="sw-risk-chip-k">' + escapeHtml(label) + '</span>'
        + '<span class="sw-risk-chip-v">' + escapeHtml(val) + '</span></div>';
    }
    var trend = rc.trend || 'NEUTRAL';
    var regime = rc.regime || 'UNKNOWN';
    var regimeCls = regime === 'BULL' ? 'sw-risk-good' : (regime === 'BEAR' ? 'sw-risk-bad' : 'sw-risk-warn');
    var smc = rc.smcTrend || 'n/a';
    var smcVal = smc === 'n/a' ? 'n/a' : (smc.charAt(0) + smc.slice(1).toLowerCase());
    if (rc.smcLastBreak && rc.smcLastBreak.type && rc.smcLastBreak.direction) {
      var breakMatchesTrend = (smc === 'BULLISH' && rc.smcLastBreak.direction === 'BULL')
        || (smc === 'BEARISH' && rc.smcLastBreak.direction === 'BEAR');
      if (breakMatchesTrend) {
        smcVal += ' \u00b7 ' + rc.smcLastBreak.type + ' ' + rc.smcLastBreak.direction;
      }
    }
    var smcCls = smc === 'BULLISH' ? 'sw-risk-good' : (smc === 'BEARISH' ? 'sw-risk-bad' : 'sw-risk-warn');
    var rr = rc.rr;
    var rrVal = (rr != null && isFinite(rr)) ? rr.toFixed(1) + 'R' : 'n/a';
    var rrCls = (rr != null && isFinite(rr)) ? (rr < 1.5 ? 'sw-risk-bad' : (rr >= 2 ? 'sw-risk-good' : 'sw-risk-warn')) : 'sw-risk-warn';
    // Document the MODE-NATIVE R:R method + the exact levels it framed on.
    var _fp2 = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
    var _basis = info.basis || 'NONE';
    var _stopDesc, _tgtDesc;
    if (_basis === 'FIB') {
      _stopDesc = 'just below the buy zone (where the setup would be wrong)';
      _tgtDesc  = 'the next price level the stock should reach on the way up';
    } else if (_basis === 'ZOI') {
      _stopDesc = 'just below the demand zone (the price floor we\u2019re buying from)';
      _tgtDesc  = 'the next selling zone above, where price often stalls';
    } else if (_basis === 'FIB+ZOI') {
      _stopDesc = 'just below the buy zone / demand floor (whichever is safer)';
      _tgtDesc  = 'the nearest level above where price often stalls';
    } else {
      _stopDesc = 'just below the last low price (where the setup would be wrong)';
      _tgtDesc  = 'the last high price above, a natural place to take profit';
    }
    var rrTip = 'Reward vs risk \u2014 how much you could gain vs how much you\u2019d lose if wrong.\n'
      + '\u2022 Buy at: today\u2019s price\n'
      + '\u2022 Stop (max loss): ' + _stopDesc + '\n'
      + '\u2022 Target (first profit): ' + _tgtDesc + '\n'
      + '2R means the possible gain is twice the risk. Below 1.5R is a thin edge (shown red).';
    if (rc.rrEntry != null && rc.rrSl != null && rc.rrT1 != null) {
      rrTip += '\nBuy ' + _fp2(rc.rrEntry) + ' \u00b7 Stop ' + _fp2(rc.rrSl) + ' \u00b7 Target ' + _fp2(rc.rrT1);
    } else if (rr == null) {
      rrTip += '\nNot shown here: there\u2019s no clean place to set a stop or target on this timeframe yet.';
    }
    var hb = info.higherBias;
    var html = '<div class="sw-risk-head">Risk Context'
      + '<span class="sw-risk-head-tf">' + escapeHtml(tfLabel) + '</span>'
      + '<span class="sw-risk-head-note">informational \u2014 does not block the signal</span></div>'
      + '<div class="sw-risk-chips">'
      + chip('Trend (' + tfLabel + ')', trend.replace('_', ' '), _swRiskClsForTrend(trend), _swTrendTip(trend, tfLabel))
      + chip('Regime', regime, regimeCls, _swRegimeTip(regime))
      + chip('Structure', smcVal, smcCls, _swStructureTip(smc))
      + chip('R:R \u2192 T1', rrVal, rrCls, rrTip)
      + (hb ? chip(SW_TF_LABEL[hb.tf] + ' bias', String(hb.trend).replace('_', ' '), _swRiskClsForTrend(hb.trend), 'Bigger-picture trend on the ' + SW_TF_LABEL[hb.tf] + ' chart. When it agrees with the buy, that\u2019s extra confidence.') : '')
      + '</div>';

    // NOTE: the full signal detail (verdict reasoning + confluence
    // breakdown + risks to weigh) is rendered separately, next to the
    // Fibonacci card in the Zone & Signal Analysis section — see
    // _swPaintSignalDetail(). The Risk Context card here keeps only the
    // at-a-glance chips + (for non-BUY) the collected risk flags.

    // A BUY tip already lists "Risks to weigh"; for WAIT/AVOID the tip is
    // geometry-only, so surface the collected flags (or a clean note) so
    // the risk context is never lost on a non-BUY card.
    if (info.text !== 'BUY') {
      if (info.riskFlags && info.riskFlags.length) {
        html += '<div class="sw-risk-detail-head">Risks to weigh</div>'
          + '<ul class="sw-risk-flags"><li>'
          + info.riskFlags.map(function (f) { return escapeHtml(f); }).join('</li><li>')
          + '</li></ul>';
      } else {
        html += '<div class="sw-risk-clean">\u2713 No risk flags \u2014 trend, regime, structure &amp; R:R all read clean on this timeframe.</div>';
      }
    }
    return html;
  }

  // Full Signal Detail banner REMOVED (2026-06-06): it was a standalone
  // restatement of the verdict tooltip (info.tip) — the SAME facts already
  // shown in the FIB / ZOI cards below it, the SAME text as the scan-table
  // hover tooltip, and the verdict badge is also in the final-bias cell. It
  // was pure duplication, so the banner was retired. This is now a no-op that
  // keeps the (now-removed) element + the legacy side column hidden, so the
  // single call site in swPaintVerdict() needs no change. info.tip itself is
  // untouched — the scan-table tooltip still uses it.
  function _swPaintSignalDetail(info) {
    var el = $('sw-signal-detail');
    if (el) { el.hidden = true; el.innerHTML = ''; }
    var sideCol = $('sw-fib-signal-col');
    if (sideCol) { sideCol.hidden = true; sideCol.innerHTML = ''; }
  }

  // Paint the Expected Move card in the Zone & Signal Analysis section.
  // Shows the probability cone (±range at 68% / 95%) for each horizon of
  // the selected swing TF, centered on the live LTP. This is a RANGE, not a
  // forecast — the card copy is explicit that it does not predict direction.
  // Hidden when there's no usable volatility estimate (intraday / no-data /
  // newly listed), so it never paints a misleading empty cone.
  function _swPaintExpectedMove(info) {
    var el = $('sw-expected-move');
    if (!el) return;
    var em = info && info.expectedMove;
    if (!em || !em.horizons || !em.horizons.length) {
      el.hidden = true; el.innerHTML = '';
      return;
    }
    var tfLabel = SW_TF_LABEL[em.tf] || em.tf || '';
    var html = '<div class="sw-em-head">Expected Move'
      + '<span class="sw-em-head-tf">' + escapeHtml(tfLabel) + '</span>'
      + '<span class="sw-em-head-note">probable \u00B1 range \u2014 not a direction</span></div>'
      + '<div class="sw-em-sub">From LTP <strong>' + fmtPrice(em.ltp) + '</strong>'
      + ' \u00B7 volatility \u03C3 ' + em.sigmaPct.toFixed(2) + '%/bar</div>'
      + '<div class="sw-em-rows">';
    for (var i = 0; i < em.horizons.length; i++) {
      var h = em.horizons[i];
      var hzWord = h.label.replace(/^next\s+/, '');
      var tip68 = 'There is roughly a 68% probability price stays between '
        + fmtPrice(h.lo68) + ' and ' + fmtPrice(h.hi68) + ' over the ' + hzWord + '.\n'
        + 'In plain terms: about 2 times out of 3, the move from now stays within \u00B1' + fmtMove(h.p68) + '.\n'
        + 'The other ~1 in 3 times it moves more than that. This is a RANGE only \u2014 it does NOT say up or down.\n'
        + '(This probability is estimated from how the stock has moved recently, so treat it as a good guide, not a promise.)';
      var tip95 = 'There is roughly a 95% probability price stays between '
        + fmtPrice(h.lo95) + ' and ' + fmtPrice(h.hi95) + ' over the ' + hzWord + '.\n'
        + 'In plain terms: about 19 times out of 20, the move from now stays within \u00B1' + fmtMove(h.p95) + '.\n'
        + 'So a target beyond this range is unlikely for this period \u2014 think of it as "don\u2019t expect more than this".\n'
        + '(Big news or results can push price past it more often than 1 in 20, so treat 95% as a safe floor, not a guarantee.)';
      html += '<div class="sw-em-row">'
        + '<div class="sw-em-horizon">' + escapeHtml(h.label) + '</div>'
        + '<div class="sw-em-bands">'
        +   '<div class="sw-em-band sw-em-band-68" title="' + escapeHtml(tip68) + '">'
        +     '<span class="sw-em-band-k">68% likely</span>'
        +     '<span class="sw-em-band-v">\u00B1' + fmtMove(h.p68) + '</span>'
        +     '<span class="sw-em-band-range">' + fmtPrice(h.lo68) + ' \u2013 ' + fmtPrice(h.hi68) + '</span>'
        +   '</div>'
        +   '<div class="sw-em-band sw-em-band-95" title="' + escapeHtml(tip95) + '">'
        +     '<span class="sw-em-band-k">95% likely</span>'
        +     '<span class="sw-em-band-v">\u00B1' + fmtMove(h.p95) + '</span>'
        +     '<span class="sw-em-band-range">' + fmtPrice(h.lo95) + ' \u2013 ' + fmtPrice(h.hi95) + '</span>'
        +   '</div>'
        + '</div>'
        + '</div>';
    }
    html += '</div>'
      + '<div class="sw-em-foot">68% = 1\u03C3, 95% = 2\u03C3 of past bar-to-bar moves, scaled by \u221Atime. '
      + 'A statistical range from historical volatility \u2014 real markets have fat tails, so treat 95% as a floor. '
      + 'It sizes stops &amp; targets to reality; it does <strong>not</strong> predict up vs down.</div>';
    el.hidden = false;
    el.innerHTML = html;
  }

  function _swRelocateSignalDetail() {
    // The Full Signal Detail is ALWAYS a standalone full-width banner at the
    // top of the analysis panel (#sw-signal-detail) — it is no longer glued
    // into the fib retracement row's side column. Keep the legacy side column
    // permanently empty so the fib card spans the full row on its own.
    var sideCol = $('sw-fib-signal-col');
    if (sideCol) { sideCol.hidden = true; sideCol.innerHTML = ''; }
  }

  function swPaintVerdict(info) {
    var finalV = $('sw-final-bias'), finalS = $('sw-final-conf'), finalCell = $('sw-final-cell');
    var risk = $('sw-risk-ctx');
    try { _swSyncRecoModeButtons(swGetRecoMode()); } catch (_) {}
    try { _swSyncRecoTfButtons(swGetRecoTf()); } catch (_) {}
    _swPaintSignalDetail(info);
    _swPaintExpectedMove(info);
    if (!info) {
      if (risk) { risk.hidden = true; risk.innerHTML = ''; }
      return;
    }
    if (info.intraday) {
      var ls = info.lastSwing;
      if (finalV) {
        finalV.textContent = ls ? ls.text : '\u2014';
        finalV.className = 'sw-bias-v ' + (ls ? ls.cls : 'sw-neutral');
      }
      if (finalS) finalS.textContent = ls ? ('last signal (' + (SW_TF_LABEL[ls.tf] || ls.tf) + ')') : 'higher TF only';
      if (finalCell) finalCell.title = 'Live per-timeframe signals are computed on 1M / 1W / 1D / 4H / 1H. '
        + (SW_TF_LABEL[info.tf] || info.tf) + ' is too fast (sub-hour) to frame a reliable swing/intraday leg. '
        + 'Switch to 1H or higher for a live signal.';
      if (risk) {
        risk.hidden = false;
        var _note = '<div class="sw-risk-note">\u24D8 Live per-timeframe signals are computed on <strong>1M / 1W / 1D / 4H / 1H</strong>. '
          + escapeHtml(SW_TF_LABEL[info.tf] || info.tf) + ' is sub-hourly \u2014 use it to fine-tune your entry, not to generate a signal. '
          + (ls ? 'Last signal: <strong>' + escapeHtml(ls.text) + '</strong> on ' + escapeHtml(SW_TF_LABEL[ls.tf] || ls.tf)
              + (ls.basis && ls.basis !== 'NONE' ? ' (' + escapeHtml(ls.basis) + ')' : '') + '.'
              : 'Switch to 1H or higher for a signal.')
          + '</div>';
        // CARDS-ONLY TFs still surface the INFORMATIONAL Risk Context grid
        // (Trend / Regime / Structure / R:R / higher-TF bias) computed from
        // THIS TF's own candles — only the BUY/WAIT recommendation is
        // withheld. The note sits above the grid to set expectations.
        risk.innerHTML = _note + (info.riskContext ? swRiskContextHtml(info) : '');
      }
      return;
    }
    if (info.noData) {
      if (finalV) { finalV.textContent = '\u2014'; finalV.className = 'sw-bias-v sw-neutral'; }
      if (finalS) finalS.textContent = 'not enough ' + (SW_TF_LABEL[info.tf] || info.tf) + ' data';
      if (finalCell) finalCell.title = 'Not enough candles on this timeframe to compute a swing recommendation.';
      if (risk) { risk.hidden = true; risk.innerHTML = ''; }
      return;
    }
    if (finalV) { finalV.textContent = (info.strongBuy && info.text === 'BUY') ? 'STRONG BUY' : info.text; finalV.className = 'sw-bias-v ' + info.cls; }
    if (finalS) finalS.textContent = info.sub || '';
    if (finalCell) finalCell.title = info.tip || '';
    if (risk) { risk.hidden = false; risk.innerHTML = swRiskContextHtml(info); }
  }

  // Single source of truth for the header's change / % so the initial
  // render and the live poll can NEVER disagree (the poll used to repaint
  // it as ltp − daily.lastClose, which is 0 when the market is closed and
  // the polled LTP == the last close — that was the "▲ 0.00" bug).
  // Reference close, best-available:
  //   1. scanner quote's prevClose (matches the sector table exactly)
  //   2. prior daily candle close from R.candles['1d'] (newest-first),
  //      resolved by IST date via _swPrevCloseIdx so it can't pick a
  //      2-sessions-stale bar if the intraday supplement was empty
  //      (the same off-by-one guard the sector path uses). Present on
  //      cache-served results too.
  //   3. R.daily.prevClose / lastClose fallbacks
  function swHeaderRefClose() {
    var R = STATE.result, sel = STATE.selected;
    if (!R) return null;
    var qCache = (typeof SECTOR_STATE !== 'undefined' && SECTOR_STATE.quoteCache)
      ? SECTOR_STATE.quoteCache : null;
    var quote = (qCache && sel && sel.isin && qCache[sel.isin]) ? qCache[sel.isin].quote : null;
    if (quote && quote.prevClose != null && quote.prevClose > 0) return quote.prevClose;
    var dC = (R.candles && R.candles['1d'] && R.candles['1d'].length) ? R.candles['1d'] : null;
    if (dC) {
      var pi = _swPrevCloseIdx(dC);
      if (pi >= 0 && dC[pi] && isFinite(+dC[pi][4])) return +dC[pi][4];
    }
    if (R.daily && R.daily.prevClose != null) return R.daily.prevClose;
    if (R.daily && isFinite(R.daily.lastClose)) return R.daily.lastClose;
    return null;
  }

  function swPaintHeaderChange(ltp) {
    var chEl = $('sw-stock-ltp-ch');
    if (!chEl) return;
    var ref = swHeaderRefClose();
    if (ref == null || !isFinite(ltp)) { chEl.textContent = ''; return; }
    var ch = ltp - ref;
    var chPct = ref > 0 ? (ch / ref) * 100 : 0;
    chEl.textContent = (ch >= 0 ? '▲' : '▼') + ' ' + Math.abs(ch).toFixed(2) + ' (' + fmtPct(chPct) + ')';
    chEl.style.color = ch >= 0 ? 'var(--bull)' : 'var(--bear)';
    chEl.classList.toggle('sw-up', ch >= 0);
    chEl.classList.toggle('sw-down', ch < 0);
  }

  function renderResult() {
    var emp = $('sw-empty'); if (emp) emp.hidden = true;
    var ld = $('sw-loading'); if (ld) ld.hidden = true;
    var err = $('sw-error'); if (err) err.hidden = true;
    var res = $('sw-result'); if (res) res.hidden = false;

    var R = STATE.result;
    var sel = STATE.selected;

    // Header strip + chart-toolbar title (chart toolbar now sits
    // ABOVE the strip, so it must independently carry the symbol
    // + company name so the user knows what chart they're looking
    // at without scrolling down).
    setText('sw-stock-sym', sel.sym);
    setText('sw-stock-name', sel.name);
    setText('sw-chart-title-sym', sel.sym);
    setText('sw-chart-title-name', sel.name);
    // Price + change. Reuse the SAME authoritative quote the scanner
    // table already computed (SECTOR_STATE.quoteCache[isin].quote holds
    // { ltp, prevClose, change, changePct } from a real prevClose), so
    // the header matches the table exactly. The old header recomputed
    // change off daily.lastClose vs itself, which rendered "▲ 0.00" with
    // the market closed. Fall back to the daily prior-bar close only when
    // the stock was opened directly (never scanned, so no cached quote).
    var _qCache = (typeof SECTOR_STATE !== 'undefined' && SECTOR_STATE.quoteCache)
      ? SECTOR_STATE.quoteCache
      : null;
    var _quote = (_qCache && sel && sel.isin && _qCache[sel.isin])
      ? _qCache[sel.isin].quote
      : null;
    var _dC0 = (R.candles && R.candles['1d'] && R.candles['1d'][0]) ? +R.candles['1d'][0][4] : null;
    var ltp = (_quote && isFinite(_quote.ltp)) ? _quote.ltp
      : (isFinite(R.ltp) && R.ltp ? R.ltp
         : (_dC0 != null ? _dC0 : R.daily.lastClose));
    setText('sw-stock-ltp', fmtPrice(ltp));
    swPaintHeaderChange(ltp);
    var whenEl = $('sw-stock-when');
    if (whenEl) whenEl.textContent = R.when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) + ' IST';

    // ── Bias bar (M / W / D / Verdict) ──
    // Hourly removed from the verdict strip — see content/swing.html
    // for the rationale (hourly signals decay in hours and don't
    // predict 5-15 day swing outcomes). Monthly added as the
    // strategic-context column because that's what professional
    // swing traders actually read first ("what stage is the stock
    // in over multi-year time?").
    function paintBias(tfId, an) {
      var v = $('sw-bias-' + tfId);
      var s = $('sw-bias-' + tfId + '-sub');
      if (!an) {
        if (v) { v.textContent = 'n/a'; v.className = 'sw-bias-v sw-neutral'; }
        if (s) { s.textContent = 'no data'; }
        return;
      }
      if (v) {
        v.textContent = shortTrendArrow(an.trend);
        v.className = 'sw-bias-v ' + biasClass(an.trend);
      }
      if (s) {
        // Sub-label = the ACTUAL basis for the trend label above (recent
        // swing structure + ADX), so the card explains its own verdict
        // instead of showing an unrelated RSI/EMA snapshot.
        s.textContent = an.trendBasis || 'trend basis n/a';
      }
    }
    paintBias('1mo', R.monthly);
    paintBias('1w',  R.weekly);
    paintBias('1d',  R.daily);

    // STRUCTURE PLAN grid + STRUCTURE TRADE PLAN card were removed 2026-06-05
    // (user request — the actionable read is the SETUP card + verdict + chart;
    // the structural macro backdrop added noise, not a tradable entry). The
    // canonical plan `R.plan` is still computed (it feeds swBuildSetupPlan /
    // swActivePlan's no-trade fallback) — only its on-screen cards are gone.

    // ── Verdict cell + Risk Context ──
    // 2026-05-30: the verdict is now computed by the SHARED, TF-aware
    // engine (swComputeVerdictForTf → _resolveVerdict, the SAME path the
    // bulk scan uses) and painted by swPaintVerdict, so changing the
    // chart timeframe below recomputes the signal + risk card live.
    // Verdict is driven by the Recommendation TF (independent of the chart).
    var _recoTf0 = swGetRecoTf();
    _swSyncRecoTfButtons(_recoTf0);
    var _recoLoaded = R.candles && R.candles[_recoTf0] && R.candles[_recoTf0].length;
    // Guarded: a verdict-compute failure here must NEVER abort renderResult
    // before the chart + the rest of the result wiring run (a thrown error
    // would leave a blank chart with dead navigation). Mirrors the guard at
    // every other swComputeVerdictForTf call site (7884 / 7929 / 10687 / 13095).
    // `_vInfo` is the reco-TF verdict result — the SAME object painted to the
    // chip AND read by the trade-plan card below (mode badge / SETUP line /
    // WHY-THIS-TRADE). It MUST stay declared in this function scope: the plan
    // card (~10809+) references `_vInfo`, so dropping it throws
    // "ReferenceError: _vInfo is not defined" and aborts the whole render.
    var _vInfo = null;
    try { _vInfo = swComputeVerdictForTf(_recoTf0); swPaintVerdict(_vInfo); } catch (_) {}
    // 4H candles are lazy — if the saved reco TF isn't fetched yet, load it
    // then repaint so the verdict isn't stuck on a "not enough data" stub.
    if (!_recoLoaded && _recoTf0 !== '1d' && typeof getRawForTf === 'function') {
      getRawForTf(_recoTf0).then(function () {
        try { swPaintVerdict(swComputeVerdictForTf(_recoTf0)); _swRelocateSignalDetail(); } catch (_) {}
      }).catch(function () {});
    }

    // ── Scanner context banner ───────────────────────────────────
    // When the individual view shows WAIT but the last bulk scan
    // had a BUY for this stock, explain the discrepancy: the entry
    // price the scanner found was at a prior close; the stock has
    // moved since then, so today's live analysis sees no valid entry.
    var ctxEl  = $('sw-scanner-ctx');
    var ctxTit = $('sw-scanner-ctx-title');
    var ctxSub = $('sw-scanner-ctx-sub');
    if (ctxEl) {
      var showCtx = false;
      if (R.plan.action === 'WAIT') {
        try {
          var cachedPayload = swingLoadVerdictsLocal();
          var isinNow = STATE.selected && STATE.selected.isin;
          if (cachedPayload && isinNow) {
            var cachedRow = (cachedPayload.verdicts || []).find(function (v) {
              return v.isin === isinNow && v.ok && v.action === 'BUY';
            });
            if (cachedRow) {
              // Reference price the scanner flagged the BUY at. The verdict-mode
              // scan rows (current default) store `price` (close at scan time)
              // but NOT `entry` — the fib/zoi verdict engine has no single entry
              // (that's built by the plan builder when the stock is opened). The
              // legacy plan-mode rows store `entry`. Prefer entry, fall back to
              // price, so we never render a fabricated "₹0.00".
              var cachedRef = (isFinite(cachedRow.entry) && cachedRow.entry > 0)
                ? cachedRow.entry
                : ((isFinite(cachedRow.price) && cachedRow.price > 0) ? cachedRow.price : null);
              var currentPx   = R.plan.entry; // today's close
              var drift = (cachedRef != null && isFinite(currentPx) && currentPx > 0)
                ? ((currentPx - cachedRef) / cachedRef * 100) : null;
              var driftTxt = drift != null
                ? (drift >= 0 ? '+' : '') + drift.toFixed(1) + '% since scan'
                : '';
              // Compute scan age
              var scanAge = '';
              if (cachedPayload.computedAt) {
                var ageMins = Math.round((Date.now() - new Date(cachedPayload.computedAt).getTime()) / 60000);
                scanAge = ageMins < 60
                  ? ageMins + ' min ago'
                  : Math.round(ageMins / 60) + 'h ago';
              }
              // Status chip based on drift
              var statusTxt;
              if (drift != null && drift > 5)
                statusTxt = 'Price has run \u2191' + drift.toFixed(1) + '% past the \u20B9' + cachedRef.toFixed(2) + ' scan level \u2014 wait for a pullback before acting.';
              else if (drift != null && drift >= -3)
                statusTxt = 'Price is still near the \u20B9' + cachedRef.toFixed(2) + ' scan level. Today\u2019s trigger conditions may not yet be confirmed \u2014 check the chart.';
              else if (drift != null && drift < -3)
                statusTxt = 'Price has dropped \u2193' + Math.abs(drift).toFixed(1) + '% below the \u20B9' + cachedRef.toFixed(2) + ' scan level \u2014 review before acting.';
              else
                statusTxt = 'Re-compute the scanner to refresh.';

              if (ctxTit) ctxTit.textContent =
                'Scanner found: ' + ((cachedRow.setupShort && cachedRow.setupShort !== '\u2014') ? cachedRow.setupShort : 'BUY setup') +
                (cachedRef != null ? ' \u00b7 BUY @ \u20B9' + cachedRef.toFixed(2) : '') +
                (driftTxt ? ' \u00b7 Now ' + driftTxt : '') +
                (scanAge ? ' \u00b7 Scanned ' + scanAge : '');
              if (ctxSub) ctxSub.textContent = statusTxt;
              showCtx = true;
            }
          }
        } catch (_) {}
      }
      ctxEl.hidden = !showCtx;
    }

    // ── SETUP trade-plan card — the ONLY plan render ──
    // swRenderBothPlanCards() draws the SETUP card (#sw-bplan, built by
    // swSetupPlanForRender — the single producer the on-chart Entry/SL/T1/T2
    // levels also use, so chart == card == trade plan can never drift). The
    // STRUCTURE card was removed 2026-06-05. Runs on a fresh analysis AND on a
    // reco-TF switch (swSetRecoTf calls it too). R.plan is never swapped — the
    // per-TF breakdown + chart below read it as-is.
    swRenderBothPlanCards();

    // ── Per-TF signal rows (no embedded charts — the big chart
    //    above is the single source of visual truth). Pass the plan
    //    in so each TF card can show its own contribution to the
    //    overall verdict score. ──
    renderTfCard('1mo', R.monthly, R.plan);
    renderTfCard('1w',  R.weekly,  R.plan);
    renderTfCard('1d',  R.daily,   R.plan);
    renderTfCard('1h',  R.hourly,  R.plan);

    // ── Big price chart with TF switcher ──
    // Default to 1D (the primary swing-trade timeframe as of 2026-06-02).
    // The 1W / 1D / 1H candle buffers were just stashed by analyze() so 1D
    // renders from cache without a second network call. The user can then
    // click 1M / 1D / 1H / 5m to inspect other timeframes — only
    // 1M and 5m trigger a fresh fetch.
    // When the stock was picked from the Fibonacci Scanner, use the
    // scanner's selected TF so the fib levels land on the right chart.
    // When picked from a Today's Setups row, open on the SCAN TF so the
    // detail-card verdict matches the row the user clicked (set by
    // swingPickTodayRow, consumed once here).
    // With the bidirectional TF lock the chart opens on the persisted
    // recommendation TF (swGetRecoTf) so a saved 1w/4h survives a reload —
    // a hardcoded '1d' would silently reset it on first render. An explicit
    // scanner / today-row request (requestedChartTf) or a pending Fib TF
    // still wins, and renderMainChart then mirrors the reco control to it.
    var defaultTf = STATE.requestedChartTf
      || ((FIB_STATE && FIB_STATE.pendingFib) ? (FIB_STATE.pendingTf || swGetRecoTf()) : swGetRecoTf());
    STATE.requestedChartTf = null;
    renderMainChart(defaultTf);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN PRICE CHART (Lightweight Charts v4) — single chart, switchable TF
  // ═══════════════════════════════════════════════════════════════
  // One full-sized LWC instance mirrors the Paper Trading tab's UX:
  // a row of TF buttons (1M / 1W / 1D / 1H / 5m) and one big chart
  // that swaps data when the user clicks a button. Three of the five
  // TFs (1W / 1D / 1H) are already in memory after analyze() — those
  // switches are zero-latency. 1M and 5m fetch on first click and
  // then sit in the cache (`STATE.result.candles`).
  //
  // EMA 20 / 50 / 200 + SMA 44 overlay every TF (computed inline).
  // When the verdict is BUY, dashed price lines mark Entry / SL /
  // T1 / T2. Fib levels drawn as price lines when the stock was
  // picked from the Fibonacci Scanner.

  function disposeMainChart() {
    stopSwingPolling();
    var inst = STATE.chart;
    if (!inst) return;
    try { inst.remove(); } catch (_) {}
    STATE.chart = null;
    STATE.candleSeries = null;
    STATE.volumeSeries = null;
  }

  // ── Shared overlay-interaction driver ──────────────────────────────
  // Lightweight Charts emits visible-range events on zoom/scroll but NOT
  // during an active mouse-drag / wheel / pinch, so the DOM overlay
  // rectangles (ZOI / FVG / OB / BOS / LIQ) need an rAF poll to stay
  // glued to price while the user is gesturing.
  //
  // The chart instance is recreated on every renderMainChart() call, so
  // its per-render `subscribeVisibleLogicalRangeChange` handlers die with
  // the old chart — no leak there. But `inner` PERSISTS across renders
  // (only its children are cleared), so binding mousedown/wheel/touch +
  // window mouseup/touchend listeners inside every overlay block on every
  // render accumulated stale listeners. This binds them EXACTLY ONCE per
  // `inner` element; each render simply repopulates `inner._swOverlayUpdaters`
  // (read live, not closure-captured) with the active overlays' reposition
  // callbacks, and one rAF loop drives them all.
  function _swBindOverlayInteractions(inner) {
    if (!inner || inner._swOverlayBound) return;
    inner._swOverlayBound = true;
    var rafId = 0, rafActive = false;
    function runAll() {
      var u = inner._swOverlayUpdaters;
      if (!u) return;
      for (var i = 0; i < u.length; i++) {
        try { u[i](); } catch (_) {}
      }
    }
    function loop() { runAll(); if (rafActive) rafId = requestAnimationFrame(loop); }
    function start() { if (!rafActive) { rafActive = true; loop(); } }
    function stop() { rafActive = false; cancelAnimationFrame(rafId); runAll(); }
    inner.addEventListener('mousedown', start);
    inner.addEventListener('wheel', function () {
      start();
      clearTimeout(inner._swOverlayWt);
      inner._swOverlayWt = setTimeout(stop, 200);
    }, { passive: true });
    inner.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('mouseup', stop);
    window.addEventListener('touchend', stop);
  }

  // ═══════════════════════════════════════════════════════════════
  // LIVE POLLING — make the swing chart tick like Paper Trading
  // ═══════════════════════════════════════════════════════════════
  // Architecture mirrors the Paper Trading chart's pollTick:
  //   - First tick ALWAYS fires (even when market is closed) to
  //     ensure the chart shows today's actual close — critical for
  //     weekly/monthly where the historical API only returns
  //     completed periods
  //   - 2s cadence during market hours (gentler than PT's 1s
  //     because swing is decision-support, not active execution)
  //   - After the initial LTP fetch, off-hours ticks display
  //     CLOSED without further API calls
  //   - Each tick fetches LTP (`/v2/market-quote/ltp`), then uses
  //     swingPeriodStartMs() to decide whether to PATCH the
  //     current candle (H/L/C) or APPEND a fresh one when the
  //     period has rolled over — works uniformly for all TFs
  //     including weekly and monthly
  //   - Every 60s a silent full-TF refetch lands authoritative
  //     OPEN + VOLUME values for any candle our LTP synthesis
  //     seeded with placeholders
  //
  // Polling is gated by `STATE.livePoll.active` which is flipped
  // by swingActivate/Deactivate when the user enters/leaves the
  // tab. That way the timer doesn't keep firing in the background
  // while the user is on a different tab.
  //
  // Period math: 5m / 1h / 1d use NSE-aligned bucket boundaries
  // (09:15 IST for intraday, IST midnight for daily). 1w uses
  // Monday-aligned IST weeks, 1mo uses 1st-of-month IST.
  // swingPeriodStartMs() handles all five TFs uniformly.

  var TF_BUCKET_MS = {
    '5m':  5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '30m': 30 * 60 * 1000,
    '1h':  60 * 60 * 1000,
    '4h':  4 * 60 * 60 * 1000,
    '1d':  24 * 60 * 60 * 1000,
    '1w':  7 * 24 * 60 * 60 * 1000,
    '1mo': -1
  };

  var IST_OFFSET_MS = 19800 * 1000; // IST = UTC + 5:30
  var SESSION_OPEN_OFFSET_MS = (9 * 3600 + 15 * 60) * 1000;

  // Start of the ISO week (Monday 00:00 IST) containing epochMs.
  function istWeekStartMs(epochMs) {
    var ist = new Date(epochMs + IST_OFFSET_MS);
    var dow = ist.getUTCDay();
    var daysSinceMon = dow === 0 ? 6 : dow - 1;
    var monIst = new Date(ist);
    monIst.setUTCDate(ist.getUTCDate() - daysSinceMon);
    monIst.setUTCHours(0, 0, 0, 0);
    return monIst.getTime() - IST_OFFSET_MS;
  }

  // Start of the calendar month (1st 00:00 IST) containing epochMs.
  function istMonthStartMs(epochMs) {
    var ist = new Date(epochMs + IST_OFFSET_MS);
    ist.setUTCDate(1);
    ist.setUTCHours(0, 0, 0, 0);
    return ist.getTime() - IST_OFFSET_MS;
  }

  // Period-start for any TF. Returns the epoch-ms at which the
  // candle containing `epochMs` opens. Handles intraday (session-
  // aligned), daily (IST midnight), weekly (Monday IST), and
  // monthly (1st IST).
  function swingPeriodStartMs(epochMs, tf) {
    var bucketMs = TF_BUCKET_MS[tf];
    if (tf === '1mo') return istMonthStartMs(epochMs);
    if (tf === '1w')  return istWeekStartMs(epochMs);
    if (!bucketMs) return null;
    return swingBucketStartMs(epochMs, bucketMs);
  }

  // NSE-aligned bucket start, in epoch-ms. Intraday buckets align
  // to 09:15 IST on the IST date of `epochMs`; daily buckets align
  // to IST midnight.
  function swingBucketStartMs(epochMs, bucketMs) {
    if (!bucketMs || bucketMs < 0) return null;
    var ist = epochMs + IST_OFFSET_MS;
    if (bucketMs >= 86400000) {
      var istMidD = Math.floor(ist / 86400000) * 86400000;
      return istMidD - IST_OFFSET_MS;
    }
    var istMid = Math.floor(ist / 86400000) * 86400000;
    var sessionStart = istMid + SESSION_OPEN_OFFSET_MS;
    if (ist < sessionStart) return sessionStart - IST_OFFSET_MS;
    var aligned = sessionStart + Math.floor((ist - sessionStart) / bucketMs) * bucketMs;
    return aligned - IST_OFFSET_MS;
  }

  // Prefer the chart module's exposed isMarketOpen if the user has
  // visited the Live tab (which installs window.isMarketOpen).
  // Otherwise fall back to our own IST check so the swing tab works
  // standalone for users who never opened Paper Trading.
  function swingMarketOpen() {
    if (typeof window.isMarketOpen === 'function') {
      try { return !!window.isMarketOpen(); } catch (_) { /* fall through */ }
    }
    var now = new Date();
    var utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    var ist = new Date(utcMs + IST_OFFSET_MS);
    var dow = ist.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    var y = ist.getUTCFullYear();
    var m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    var d = String(ist.getUTCDate()).padStart(2, '0');
    if (typeof window.isNseHoliday === 'function') {
      try { if (window.isNseHoliday(y + '-' + m + '-' + d)) return false; } catch (_) {}
    }
    var mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins < (15 * 60 + 30);
  }

  // ── Bar-close countdown (2026-06-05) ──────────────────────────────
  // TradingView-style "time until the current candle closes", pinned to
  // the last-price tag on the right price axis. Visually identical to the
  // live-chart chip — it reuses the same `.tv-countdown` styling (all CSS
  // is loaded globally) — but covers EVERY swing timeframe:
  //   • intraday (5m/15m/30m/1h/4h): seconds to the next session-aligned
  //     bucket boundary, CLAMPED to the 15:30 IST close so the last,
  //     short bar of the day never counts down past the session. Shown
  //     only while the market is open (no live bar = nothing to count).
  //   • 1d  : time to the 15:30 IST close (market-hours only).
  //   • 1w  : time to the week's final trading session close (Fri 15:30,
  //           stepped back over NSE holidays). Shown across days, even
  //           off-hours — a swing trader cares "weekly bar closes in 2d 4h".
  //   • 1mo : time to the month's final trading session close — ditto.
  // PURE read of the wall clock + STATE; never mutates candles, never
  // reads the still-forming bar's shape, so it cannot repaint a signal.
  // Reuses the exact session/bucket math the chart paints with
  // (swingBucketStartMs / istWeekStartMs / istMonthStartMs) — no drift.
  var SW_SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST, minutes-of-day

  // Is the IST calendar day of `istDate` (a Date read via getUTC*, built
  // from epoch + IST offset) an NSE trading day? Uses the live-chart
  // holiday set when present (window.isNseHoliday, installed once the
  // Live tab loads); falls back to weekday-only when it isn't — a safe
  // approximation for the rare standalone-swing case (worst case the
  // weekly/monthly close lands one day late on a Fri/month-end holiday).
  function _swIsTradingDayIst(istDate) {
    var dow = istDate.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    if (typeof window.isNseHoliday === 'function') {
      var y = istDate.getUTCFullYear();
      var m = String(istDate.getUTCMonth() + 1).padStart(2, '0');
      var d = String(istDate.getUTCDate()).padStart(2, '0');
      try { if (window.isNseHoliday(y + '-' + m + '-' + d)) return false; } catch (_) {}
    }
    return true;
  }

  // Epoch-ms of 15:30 IST on the IST calendar day containing `epochMs`.
  function _swSessionCloseMs(epochMs) {
    var ist = epochMs + IST_OFFSET_MS;
    var istMid = Math.floor(ist / 86400000) * 86400000;
    return istMid + SW_SESSION_CLOSE_MIN * 60000 - IST_OFFSET_MS;
  }

  // The next 1w / 1mo bar-close (final trading session, 15:30 IST) strictly
  // after `nowMs`. Computes this period's last trading day; if its close has
  // already passed (weekend after Fri close), rolls forward to the next
  // period. Returns null if it can't resolve (defensive).
  function _swPeriodCloseMs(tf, nowMs) {
    for (var step = 0; step < 2; step++) {
      var probe = nowMs + step * (tf === '1mo' ? 32 : 8) * 86400000;
      var lastDayMs;
      if (tf === '1w') {
        lastDayMs = istWeekStartMs(probe) + 4 * 86400000; // Mon 00:00 + 4d = Fri
      } else { // 1mo — last calendar day of the month
        var d0 = new Date(istMonthStartMs(probe) + IST_OFFSET_MS);
        d0.setUTCMonth(d0.getUTCMonth() + 1);
        d0.setUTCDate(0);
        d0.setUTCHours(0, 0, 0, 0);
        lastDayMs = d0.getTime() - IST_OFFSET_MS;
      }
      // Walk back to the last actual trading day in the period.
      var dt = new Date(lastDayMs + IST_OFFSET_MS);
      for (var i = 0; i < 12 && !_swIsTradingDayIst(dt); i++) {
        dt.setUTCDate(dt.getUTCDate() - 1);
      }
      var closeMs = _swSessionCloseMs(dt.getTime() - IST_OFFSET_MS);
      if (closeMs > nowMs) return closeMs;
    }
    return null;
  }

  // Seconds until the CURRENT chart-TF bar closes, or null when nothing
  // meaningful should be shown (market closed for intraday/daily, no TF).
  function swBarCloseCountdownSec() {
    var tf = STATE.chartTf;
    if (!tf) return null;
    var nowMs = Date.now();

    if (tf === '1w' || tf === '1mo') {
      var closeMs = _swPeriodCloseMs(tf, nowMs);
      if (closeMs == null) return null;
      return Math.max(0, Math.round((closeMs - nowMs) / 1000));
    }

    // Daily + intraday only count while a live bar is actually forming.
    if (!swingMarketOpen()) return null;

    if (tf === '1d') {
      return Math.max(0, Math.round((_swSessionCloseMs(nowMs) - nowMs) / 1000));
    }

    var bucketMs = TF_BUCKET_MS[tf];
    if (!bucketMs || bucketMs < 0) return null;
    var ist = nowMs + IST_OFFSET_MS;
    var istMid = Math.floor(ist / 86400000) * 86400000;
    var sessionStart = istMid + SESSION_OPEN_OFFSET_MS;
    var alignedStart = (ist < sessionStart)
      ? sessionStart
      : sessionStart + Math.floor((ist - sessionStart) / bucketMs) * bucketMs;
    // Clamp to the session close — the last intraday bar is short.
    var barCloseIst = Math.min(alignedStart + bucketMs, istMid + SW_SESSION_CLOSE_MIN * 60000);
    return Math.max(0, Math.round(((barCloseIst - IST_OFFSET_MS) - nowMs) / 1000));
  }

  // Format the remaining seconds by `mode`:
  //   • 'days'   (1W / 1M): pure whole-day figure ("2d"), never hours —
  //              a weekly/monthly bar only locks in on its final session,
  //              so day granularity is all that matters. The closing day
  //              itself (< 1 day left) reads "<1d" rather than "0d".
  //   • 'minsec' (5m / 15m / 30m / 1h): labelled minutes + seconds
  //              ("55m 41s"). Total minutes (never rolls to "1h 00m"),
  //              seconds zero-padded for a stable chip width.
  //   • 'auto'   (4H / 1D): Hh MMm sub-day, Dd Hh beyond, MM:SS sub-hour.
  function _swFmtCountdown(sec, mode) {
    if (sec == null) return '';
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    if (mode === 'days') return d >= 1 ? d + 'd' : '<1d';
    if (mode === 'minsec') return Math.floor(sec / 60) + 'm ' + String(s).padStart(2, '0') + 's';
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm';
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // Lazily create the chip inside the #sw-chart mount (a position:relative
  // box). Living in the mount — NOT the per-render `.sw-chart-inner` that
  // gets innerHTML-cleared — keeps it alive across TF switches / re-renders.
  function _swEnsureCountdownEl() {
    var mount = $('sw-chart');
    if (!mount) return null;
    var el = document.getElementById('sw-countdown');
    if (!el) {
      el = document.createElement('div');
      el.className = 'tv-countdown';
      el.id = 'sw-countdown';
      el.style.display = 'none';
      el.title = 'Time remaining until the current candle closes';
      el.innerHTML = '<span id="sw-countdown-val">--:--</span>';
      mount.appendChild(el);
    }
    return el;
  }

  // Pin the chip vertically to the last close via the series'
  // priceToCoordinate; falls back to the CSS 50% anchor when the chart
  // isn't ready. Tints bear (red) when the last bar printed down.
  function _swPositionCountdown(el) {
    if (!el || !STATE.candleSeries) return;
    var px = STATE._chartLastClose;
    if (!isFinite(px)) return;
    if (isFinite(STATE._chartLastOpen)) {
      el.classList.toggle('tv-countdown-bear', px < STATE._chartLastOpen);
    }
    try {
      if (typeof STATE.candleSeries.priceToCoordinate === 'function') {
        var y = STATE.candleSeries.priceToCoordinate(px);
        if (isFinite(y) && y > 0) {
          var mount = $('sw-chart');
          var hostH = mount ? mount.clientHeight : 700;
          var yPos = y + 9;
          if (yPos < 2) yPos = 2;
          if (yPos > hostH - 20) yPos = hostH - 20;
          el.style.top = yPos + 'px';
        }
      }
    } catch (_) {}
  }

  function updateSwCountdown() {
    var el = _swEnsureCountdownEl();
    if (!el) return;
    var val = document.getElementById('sw-countdown-val');
    if (!val) return;
    if (!STATE.chart || !STATE.candleSeries) {
      el.style.display = 'none';
      el.classList.remove('tv-countdown-warn');
      return;
    }
    var sec = swBarCloseCountdownSec();
    if (sec == null) {
      el.style.display = 'none';
      el.classList.remove('tv-countdown-warn');
      return;
    }
    el.style.display = 'block';
    var _tf = STATE.chartTf;
    var mode = (_tf === '1w' || _tf === '1mo') ? 'days'
      : (_tf === '5m' || _tf === '15m' || _tf === '30m' || _tf === '1h') ? 'minsec'
        : 'auto';
    var text = _swFmtCountdown(sec, mode);
    if (val.textContent !== text) val.textContent = text;
    // Warn pulse only for the final 10s of a true intraday bar (not 1d/1w/1mo,
    // where the multi-hour/day countdown never enters that window).
    var intraday = (STATE.chartTf !== '1w' && STATE.chartTf !== '1mo' && STATE.chartTf !== '1d');
    el.classList.toggle('tv-countdown-warn', intraday && sec <= 10 && sec > 0);
    _swPositionCountdown(el);
  }

  // One global 1Hz ticker, started on first chart render. Resolves the chip
  // lazily via getElementById each tick, so it's a cheap no-op before the
  // swing chart mounts and self-heals across re-renders.
  var _swCountdownTimer = null;
  function startSwCountdownTicker() {
    if (_swCountdownTimer) return;
    updateSwCountdown();
    _swCountdownTimer = setInterval(updateSwCountdown, 1000);
  }

  function rawRowToKline(c, tf) {
    return {
      time: candleTime(c[0], tf),
      open:  +c[1],
      high:  +c[2],
      low:   +c[3],
      close: +c[4]
    };
  }

  function rawRowToVolume(c, tf) {
    var cl = +c[4], op = +c[1];
    return {
      time: candleTime(c[0], tf),
      value: +c[5] || 0,
      color: cl >= op ? 'rgba(9,168,110,0.35)' : 'rgba(201,31,58,0.35)'
    };
  }

  // CHART-ONLY overlay of the current (forming) weekly/monthly bar.
  // The analyzer's R.candles['1w'|'1mo'] are completed-only (no repaint),
  // so the in-progress week/month would otherwise be invisible. We rebuild
  // it by aggregating the current period's DAILY candles (accurate OHLCV —
  // verified identical to Upstox's eventual weekly/monthly bar), then layer
  // the live LTP onto the close + extend H/L. Pushed to the series via
  // .update() only — R.candles is never mutated, so the signal stays clean.
  function applyFormingBar(tf, ltpOverride) {
    if (tf !== '1w' && tf !== '1mo') return;
    if (!STATE.candleSeries) return;
    var sel = STATE.selected;
    var daily = (sel && getDailyShared(sel.isin))
      || (STATE.result && STATE.result.candles && STATE.result.candles['1d']);
    var fb = formingPeriodBar(daily, tf);
    if (!fb) return;
    var ltp = isFinite(ltpOverride) ? ltpOverride : (STATE.result && STATE.result.ltp);
    if (isFinite(ltp) && ltp > 0) {
      fb = fb.slice();
      fb[4] = ltp;
      if (ltp > +fb[2]) fb[2] = ltp;
      if (ltp < +fb[3]) fb[3] = ltp;
    }
    // Track the live forming-bar price so the countdown chip pins to it.
    STATE._chartLastClose = +fb[4];
    STATE._chartLastOpen = +fb[1];
    try {
      STATE.candleSeries.update(rawRowToKline(fb, tf));
      if (STATE.volumeSeries) STATE.volumeSeries.update(rawRowToVolume(fb, tf));
    } catch (_) {}
  }

  function startSwingPolling() {
    console.log('[swing] startSwingPolling called');
    stopSwingPolling();
    if (!STATE.livePoll.active) {
      console.log('[swing] startSwingPolling: livePoll.active is false, returning');
      return;
    }
    if (!STATE.result || !STATE.chart) {
      console.log('[swing] startSwingPolling: no result or chart, returning');
      return;
    }
    console.log('[swing] startSwingPolling: starting polling for', STATE.selected?.sym);
    STATE.livePoll.initialLtpDone = false;
    STATE.livePoll.intervalMs = 2000;
    pollSwingTick();
    STATE.livePoll.timer = setInterval(pollSwingTick, STATE.livePoll.intervalMs);
  }

  function stopSwingPolling() {
    if (STATE.livePoll.timer) {
      clearInterval(STATE.livePoll.timer);
      STATE.livePoll.timer = null;
    }
  }

  function restartSwingPollingCadence() {
    if (!STATE.livePoll.timer) return;
    clearInterval(STATE.livePoll.timer);
    STATE.livePoll.timer = setInterval(pollSwingTick, STATE.livePoll.intervalMs);
  }

  function setLiveBadge(state, label) {
    var el = $('sw-chart-live-badge');
    if (!el) return;
    el.className = 'sw-chart-live ' + (state ? 'sw-chart-live-' + state : '');
    el.textContent = label || '';
  }

  async function pollSwingTick() {
    if (!STATE.livePoll.active) return;
    if (!STATE.chart || !STATE.result) return;
    var sel = STATE.selected;
    if (!sel || !sel.isin) return;
    var tf = STATE.chartTf;
    var R = STATE.result;
    if (!R.candles || !R.candles[tf] || !R.candles[tf].length) return;
    var spec = TF_SPECS[tf] || { label: tf };
    var marketOpen = swingMarketOpen();

    // ── Market closed + LTP already fetched → display CLOSED, no fetch ──
    if (!marketOpen && STATE.livePoll.initialLtpDone) {
      if (STATE.livePoll.intervalMs !== 60000) {
        STATE.livePoll.intervalMs = 60000;
        restartSwingPollingCadence();
      }
      setLiveBadge('closed', 'CLOSED');
      var lastClose = R.candles[tf][0] ? +R.candles[tf][0][4] : (R.ltp || 0);
      setChartStatus(spec.label + ' · market closed · last ' + fmtPrice(lastClose));
      return;
    }

    if (STATE.livePoll.ltpInFlight) return;
    STATE.livePoll.ltpInFlight = true;
    var ltp;
    var fetchError;
    try {
      ltp = await fetchLtp(sel.isin);
    } catch (err) {
      fetchError = err;
      console.warn('[swing] pollSwingTick fetchLtp error:', err);
    }
    STATE.livePoll.ltpInFlight = false;
        
    if (fetchError) {
      setLiveBadge('error', 'API ERROR');
      setChartStatus(spec.label + ' · API error – check token');
      return;
    }
        
    if (!isFinite(ltp) || ltp <= 0) {
      console.warn('[swing] pollSwingTick invalid LTP:', ltp, 'for ISIN:', sel.isin);
      setLiveBadge('error', 'NO DATA');
      setChartStatus(spec.label + ' · no data received');
      return;
    }
    if (STATE.chartTf !== tf) return;
    if (!STATE.chart || !STATE.result) return;

    STATE.livePoll.initialLtpDone = true;
    // Keep the countdown chip glued to the freshest price.
    STATE._chartLastClose = ltp;

    var raw = R.candles[tf];
    if (!raw.length) return;
    var newest = raw[0];
    var newestMs = new Date(newest[0]).getTime();
    var nowMs = Date.now();

    // ── Period detection: does the LTP belong to the newest candle
    //    or should we create a new one?
    //
    //    Session-based TFs (5m, 1h, 1d): only create new candles
    //    while the market is open — prevents phantom after-hours /
    //    weekend candles.
    //
    //    Calendar TFs (1w, 1mo): always create when the period has
    //    rolled — a new week/month always has valid trading data
    //    and the LTP reflects the current period's close. ──
    var newestPeriod = swingPeriodStartMs(newestMs, tf);
    var currentPeriod = swingPeriodStartMs(nowMs, tf);
    var isSessionTf = (tf === '5m' || tf === '15m' || tf === '30m' || tf === '1h' || tf === '4h' || tf === '1d');
    var periodRolled = (newestPeriod !== null && currentPeriod !== null && currentPeriod > newestPeriod);
    var shouldCreateNew = periodRolled && (!isSessionTf || marketOpen);

    if (tf === '1w' || tf === '1mo') {
      // Forming week/month is a chart-only overlay aggregated from daily
      // (accurate OHLCV + live LTP) — NOT an LTP-seeded stub, and never
      // written into R.candles[tf] (which stays completed-only for the
      // signal). See applyFormingBar.
      applyFormingBar(tf, ltp);
    } else if (shouldCreateNew) {
      var newIso = new Date(currentPeriod).toISOString();
      var newRow = [newIso, ltp, ltp, ltp, ltp, 0, 0];
      STATE._chartLastOpen = ltp; // new bar opens at the current LTP
      raw.unshift(newRow);
      try {
        if (STATE.candleSeries) STATE.candleSeries.update(rawRowToKline(newRow, tf));
        if (STATE.volumeSeries) STATE.volumeSeries.update(rawRowToVolume(newRow, tf));
      } catch (_) {}
    } else if (marketOpen) {
      if (ltp > +newest[2]) newest[2] = ltp;
      if (ltp < +newest[3]) newest[3] = ltp;
      newest[4] = ltp;
      try {
        if (STATE.candleSeries) STATE.candleSeries.update(rawRowToKline(newest, tf));
        if (STATE.volumeSeries) STATE.volumeSeries.update(rawRowToVolume(newest, tf));
      } catch (_) {}
    }

    setText('sw-stock-ltp', fmtPrice(ltp));
    R.ltp = ltp;
    swPaintHeaderChange(ltp);

    STATE.livePoll.lastTickMs = nowMs;

    // ── Market closed: first tick done — show CLOSED, throttle ──
    if (!marketOpen) {
      setLiveBadge('closed', 'CLOSED');
      setChartStatus(spec.label + ' · market closed · last ' + fmtPrice(ltp));
      if (STATE.livePoll.intervalMs !== 60000) {
        STATE.livePoll.intervalMs = 60000;
        restartSwingPollingCadence();
      }
      return;
    }

    // ── Market open: LIVE badge + continuous polling ──
    setLiveBadge('live', 'LIVE');
    setChartStatus(spec.label + ' · ' + raw.length + ' candles · ' + fmtPrice(ltp) +
      ' · last tick ' + new Date(nowMs).toLocaleTimeString('en-IN', { hour12: false }) + ' IST');

    if (nowMs - STATE.livePoll.lastSyncMs > 60000) {
      silentRefetchSwing(tf);
    }

    if (STATE.livePoll.intervalMs !== 2000) {
      STATE.livePoll.intervalMs = 2000;
      restartSwingPollingCadence();
    }
  }

  async function silentRefetchSwing(tf) {
    if (STATE.livePoll.refetchInFlight) return;
    var sel = STATE.selected;
    if (!sel || !sel.isin) return;
    STATE.livePoll.refetchInFlight = true;
    try {
      var fresh = await fetchTf(sel.isin, tf);
      if (!fresh || !fresh.length) return;
      // Keep the deep-window gap closed on re-sync too (no-op + zero extra
      // calls when there's no gap — e.g. any normal market-open tick).
      if (tf === '1d') fresh = await _swFillDailyGapFromShortWindow(sel.isin, fresh);
      if (!fresh || !fresh.length) return;
      if (STATE.chartTf !== tf) return;
      if (!STATE.result) return;
      STATE.result.candles[tf] = fresh;
      if (STATE.candleSeries) {
        try { STATE.candleSeries.setData(rawToKlines(fresh, tf)); } catch (_) {}
      }
      if (STATE.volumeSeries) {
        try { STATE.volumeSeries.setData(rawToVolumes(fresh, tf)); } catch (_) {}
      }
      // The fresh weekly/monthly series is completed-only, so re-layer the
      // forming bar that the setData above just wiped (otherwise it would
      // vanish for up to 2s until the next poll tick re-creates it).
      applyFormingBar(tf);
      STATE.livePoll.lastSyncMs = Date.now();
    } catch (_) {
      // silent — keep last good state, next pollTick will retry
    } finally {
      STATE.livePoll.refetchInFlight = false;
    }
  }

  function swingActivate() {
    console.log('[swing] swingActivate called');
    STATE.livePoll.active = true;
    // If the user switched data source (Upstox ⇄ Angel One) in API Setup
    // while away from this tab, whatever is on screen — a result OR an error
    // card (e.g. an Angel "invalid token") — belongs to the OTHER feed and is
    // now stale. Re-fetch from the current source. We gate on STATE.selected
    // (not STATE.result) so a prior FAILED attempt is also retried: otherwise
    // an Angel token error would linger after switching back to a working
    // Upstox token. This is what previously required a full page reload.
    if (STATE.selected && STATE.resultSource && STATE.resultSource !== swDataSource()) {
      console.log('[swing] swingActivate: data source changed ('
        + STATE.resultSource + ' \u2192 ' + swDataSource() + '), re-analyzing');
      analyze(true);
      return;
    }
    if (STATE.result && STATE.chart) {
      console.log('[swing] swingActivate: result and chart exist, starting polling');
      startSwingPolling();
    } else {
      console.log('[swing] swingActivate: no result or chart yet, will start when ready');
    }
  }

  function swingDeactivate() {
    console.log('[swing] swingDeactivate called');
    STATE.livePoll.active = false;
    stopSwingPolling();
  }

  // Upstox V3 candles are [ts, o, h, l, c, v, oi] with NEWEST first.
  // LWC wants chronological order + {time (unix sec), o, h, l, c}.
  var IST_OFF_SEC = 19800; // +5:30 in seconds

  function candleTime(ts, tf) {
    var ms = new Date(ts).getTime();
    if (tf === '1d' || tf === '1w' || tf === '1mo') {
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
      return {
        time: candleTime(c[0], tf),
        open: +c[1], high: +c[2], low: +c[3], close: +c[4]
      };
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

  // LWC chart options — colours match the live chart module and the
  // analyzer bull/bear palette.
  function chartOptions(tf) {
    var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
    var isIntraday = (tf === '5m' || tf === '15m' || tf === '30m' || tf === '1h' || tf === '4h');
    return {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: isDark ? '#0f172a' : '#ffffff' },
        textColor: isDark ? '#94a3b8' : '#64748b',
        fontSize: 11,
        attributionLogo: false
      },
      grid: {
        vertLines: { color: isDark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.08)' },
        horzLines: { color: isDark ? 'rgba(148,163,184,0.08)' : 'rgba(15,23,42,0.10)' }
      },
      crosshair: { mode: 0 },
      rightPriceScale: {
        borderVisible: false,
        autoScale: true
      },
      timeScale: {
        borderVisible: false,
        timeVisible: isIntraday,
        secondsVisible: false
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        pinch: true
      }
    };
  }

  function candleSeriesOpts() {
    return {
      upColor: '#09a86e', downColor: '#c91f3a',
      borderUpColor: '#09a86e', borderDownColor: '#c91f3a',
      wickUpColor: '#09a86e', wickDownColor: '#c91f3a'
    };
  }

  // Pattern names we surface on the chart, mapped to direction.
  // Piercing Pattern / Dark Cloud Cover were promoted from Tier 2 — they
  // are near-Tier-1 "almost engulfing" reversals (close past prior
  // midpoint), low noise. Dragonfly Doji / Gravestone Doji were also
  // promoted from Tier 2 — they are purer single-bar wick-rejection
  // reversals (a Hammer/Shooting-Star with effectively no body), and the
  // classifier already ranks them ABOVE Hammer/Shooting Star, so before
  // promotion those bars were suppressed entirely (Dragonfly won the label
  // over Hammer but wasn't Tier 1). Anything not in these maps (plain Doji,
  // Harami, Inside Bar, Inverted Hammer, Hanging Man, Tweezers, Marubozu,
  // etc.) is intentionally NOT plotted — low standalone edge = noise.
  var PATTERN_TIER1_BULL = {
    'Bullish Engulfing': 1, 'Morning Star': 1, 'Morning Doji Star': 1, 'Hammer': 1, 'Three White Soldiers': 1,
    'Piercing Pattern': 1, 'Dragonfly Doji': 1
  };
  var PATTERN_TIER1_BEAR = {
    'Bearish Engulfing': 1, 'Evening Star': 1, 'Evening Doji Star': 1, 'Shooting Star': 1, 'Three Black Crows': 1,
    'Dark Cloud Cover': 1, 'Gravestone Doji': 1
  };
  var PATTERN_BULL_COLOR = '#09a86e';   // matches candle upColor (plain / open-space)
  var PATTERN_BEAR_COLOR = '#c91f3a';   // matches candle downColor (plain / open-space)
  // CONFLUENCE emphasis — a darker, heavier shade for reversals that land on a
  // level the chart already trusts (see drawPatternMarkers). Same hue family
  // (green = bull, red = bear) so direction meaning is preserved; only the
  // shade/size/label change. This is RANKING, not filtering: plain arrows keep
  // their normal colour and stay fully visible.
  var PATTERN_BULL_STRONG = '#067a4f';  // darker green
  var PATTERN_BEAR_STRONG = '#9e1730';  // darker red

  // Detect the Tier-1 patterns for a TF and return structured rows (PURE —
  // no chart side-effects). Used by BOTH the chart markers (drawPatternMarkers,
  // on the CHART timeframe) and the pattern cards (on the RECOMMENDATION
  // timeframe) — same classifier, no drift.
  // `raw` is broker rows ([ts,o,h,l,c,v], newest-first); we sort ascending to
  // match the candle series and to feed detectPatterns(), which reads the END
  // of its window as the bar under test. A row is flagged `strong` (the ★)
  // only when it sits on an ALIGNED trusted level (bull on a demand zone or a
  // VALID golden-pocket pullback; bear on a supply zone). Open-space patterns
  // — and bull patterns falling THROUGH the pocket — stay plain. Returns []
  // when nothing qualifies.
  function collectTier1Patterns(raw, tf) {
    if (!raw || raw.length < 3) return [];
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var n = sorted.length;
    var closes = sorted.map(function (c) { return +c[4]; });

    // No-repaint guard: skip the forming bar while the market is open.
    // Unknown market state ⇒ also skip (fail-safe).
    var marketOpen = (typeof window.isMarketOpen === 'function')
      ? !!window.isMarketOpen() : true;
    var lastIdx = marketOpen ? n - 2 : n - 1;

    // Per-bar local trend INTO the signal candle, used only to split the
    // shape-identical Hammer/Hanging-Man and Inverted-Hammer/Shooting-Star
    // pairs. We measure the RECENT CONFIRMED swing leading up to the bar
    // (close now vs ~5 bars earlier), NOT price-vs-50-EMA. The old 50-EMA
    // proxy mislabeled bottoming hammers after a sharp sell-off as Hanging
    // Man: the slow 50-EMA lags and still sits BELOW price right after a
    // crash, so "close > ema50" wrongly read "uptrend". A hammer needs a
    // DOWN-swing into it; a hanging man needs an UP-swing. Only a clear
    // up-move (>= SWING_MIN over SWING_LB bars) counts as 'BULL'; anything
    // flat/down stays 'NEUTRAL', which preserves the bullish Hammer label.
    var SWING_LB = 5;        // confirmed bars of lead-in context
    var SWING_MIN = 0.005;   // 0.5% net rise = a "clear" up-swing (ignore chop)
    function trendInto(idx) {
      var pj = idx - 1;                      // last confirmed bar before the signal
      if (pj < 1) return 'NEUTRAL';
      var base = closes[Math.max(0, pj - SWING_LB)];
      if (!(base > 0)) return 'NEUTRAL';
      return (closes[pj] - base) / base >= SWING_MIN ? 'BULL' : 'NEUTRAL';
    }

    // ── Confluence levels (reuse what the chart already draws) ──
    // We do NOT invent a new rule: a bull reversal is "at a level" when it
    // touches a DEMAND zone or the Fib golden pocket (the long-entry band);
    // a bear reversal when it touches a SUPPLY zone. detectZones()/
    // computeFibZone() are pure functions of the same newest-first `raw`,
    // so the highlight matches the overlays the user sees. Computed ONCE
    // (not per bar). Both fail safe (empty/null) on short histories.
    //
    // NOTE: these are the CURRENT levels, so a past arrow's emphasis reflects
    // today's zones (it can change as zones evolve) — intentional: it mirrors
    // the live overlays. The arrow's existence is still anchored on confirmed
    // bars only (no-repaint); only the cosmetic emphasis is dynamic.
    var zones = (typeof detectZones === 'function') ? (detectZones(raw) || []) : [];
    var fz = (typeof computeFibZone === 'function') ? computeFibZone(raw) : null;
    var gpLo = (fz && isFinite(fz.fib786)) ? fz.fib786 : null;   // 80%  (lower edge)
    var gpHi = (fz && isFinite(fz.fib618)) ? fz.fib618 : null;   // 61.8% (upper edge)

    // What trusted level does bar `idx` sit on, for direction `dir`?
    // Returns { kind, strong } used BOTH for the chart's ★ emphasis and for
    // the pattern cards below the chart (single source of truth).
    //   bull → 'DEMAND'  (sits on a demand zone / support)
    //        | 'POCKET'  (in the Fib golden pocket on a VALID up-leg pullback)
    //        | 'POCKET_FALLING' (in the pocket but price is still falling
    //                            THROUGH it — a hammer mid-collapse, NOT a
    //                            confirmed long → demoted, no star)
    //        | 'NONE'    (open space)
    //   bear → 'SUPPLY'  (sits on a supply zone / resistance) | 'NONE'
    // `strong` (the ★) is true only for an ALIGNED, trustworthy level.
    //
    // The golden pocket is a long-entry band ONLY when the swing is a real
    // up-leg pullback. computeFibZone already classifies this via
    // fibDirection / bounceStatus; a 'FALLING' read means price is knifing
    // through the 61.8–80% band, which is the classic false long — so we
    // demote it (plain arrow + caution card) instead of starring it.
    var fzFalling = !!fz && (fz.fibDirection === 'FALLING' || fz.bounceStatus === 'FALLING');
    function levelInfo(idx, dir) {
      var lo = +sorted[idx][3], hi = +sorted[idx][2];
      if (!(hi >= lo)) return { kind: 'NONE', strong: false };
      for (var z = 0; z < zones.length; z++) {
        var zz = zones[z];
        if (dir === 'bull' && zz.type !== 'DEMAND') continue;
        if (dir === 'bear' && zz.type !== 'SUPPLY') continue;
        var zLo = Math.min(zz.distal, zz.proximal);
        var zHi = Math.max(zz.distal, zz.proximal);
        if (isFinite(zLo) && isFinite(zHi) && hi >= zLo && lo <= zHi) {
          return { kind: dir === 'bull' ? 'DEMAND' : 'SUPPLY', strong: true };
        }
      }
      // Golden pocket — bull-only long band.
      if (dir === 'bull' && gpLo != null && gpHi != null && hi >= gpLo && lo <= gpHi) {
        return fzFalling
          ? { kind: 'POCKET_FALLING', strong: false }
          : { kind: 'POCKET', strong: true };
      }
      return { kind: 'NONE', strong: false };
    }

    // ── Outcome (did the reversal play out?) ───────────────────────────
    // Same philosophy as the geometric chart patterns: KEEP every pattern
    // visible, but LABEL whether it worked — never drop (that hides losses and
    // makes the labelling impossible to validate by eye → survivorship bias).
    // A single reversal candle has no neckline, so we judge it as a real
    // trader would size the trade:
    //   • STOP   = the formation's own extreme (lowest low of the 1–3 signal
    //              bars for a bull reversal; highest high for a bear). A CLOSE
    //              beyond it means the reversal was rejected.
    //   • TARGET = 2R measured from the signal close (entry), where
    //              R = |entry − stop|. 2:1 is the conservative swing-trade
    //              minimum reward — self-scales to the candle's own volatility,
    //              so a tiny doji and a wide engulfing are judged proportionally.
    // Judged CLOSE-based on the CONFIRMED bars AFTER the signal (no repaint).
    // First close to breach either level wins; neither breached yet ⇒ LIVE.
    //   LIVE   — in play, not yet resolved (the freshest patterns)
    //   WORKED — target reached first (✓ the move paid out)
    //   FAILED — stop closed through first (✗ the reversal was rejected)
    function candleOutcome(i, dir) {
      var a = Math.max(0, i - 2);   // 1–3 bar formation covers every Tier-1 shape
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
          var c = closes[b];
          if (c >= tgt) return 'WORKED';
          if (c < lo) return 'FAILED';
        }
        return 'LIVE';
      }
      var riskB = hi - entry;
      if (!(riskB > 0)) return 'LIVE';
      var tgtB = entry - 2 * riskB;
      for (var bb = i + 1; bb <= lastIdx; bb++) {
        var cb = closes[bb];
        if (cb <= tgtB) return 'WORKED';
        if (cb > hi) return 'FAILED';
      }
      return 'LIVE';
    }

    var rows = [];
    var lastBarIdx = n - 1;
    for (var i = 1; i <= lastIdx; i++) {
      var localTrend = trendInto(i);
      var win = sorted.slice(Math.max(0, i - 3), i + 1);
      var pr = detectPatterns(win, localTrend);
      var name = null, dir = null;
      if (pr.bull && PATTERN_TIER1_BULL[pr.bull]) { name = pr.bull; dir = 'bull'; }
      else if (pr.bear && PATTERN_TIER1_BEAR[pr.bear]) { name = pr.bear; dir = 'bear'; }
      if (!name) continue;
      var li = levelInfo(i, dir);
      rows.push({
        idx: i,
        barsAgo: lastBarIdx - i,
        ts: sorted[i][0],
        name: name,
        dir: dir,
        strong: li.strong,
        kind: li.kind,
        bounceStatus: fz ? fz.bounceStatus : null,
        fibDirection: fz ? fz.fibDirection : null,
        close: +sorted[i][4],
        outcome: candleOutcome(i, dir)
      });
    }
    return rows;
  }

  // Build + attach the chart's Tier-1 markers for the CHART timeframe, from
  // the rows collectTier1Patterns() produces. Returns the rows.
  function drawPatternMarkers(candleSeries, raw, tf) {
    if (!candleSeries) return [];
    var allRows = collectTier1Patterns(raw, tf);
    if (!allRows.length) return allRows;
    // Default view: only the most-recent markers (matches the cards) so the
    // chart stays clean; "Show history" reveals every detected pattern.
    var rows = swCandleHistory ? allRows : allRows.slice(-PATTERN_CARD_MAX);
    var markers = rows.map(function (r) {
      return {
        time: candleTime(r.ts, tf),
        position: r.dir === 'bull' ? 'belowBar' : 'aboveBar',
        color: r.dir === 'bull'
          ? (r.strong ? PATTERN_BULL_STRONG : PATTERN_BULL_COLOR)
          : (r.strong ? PATTERN_BEAR_STRONG : PATTERN_BEAR_COLOR),
        shape: r.dir === 'bull' ? 'arrowUp' : 'arrowDown',
        text: r.strong ? ('\u2605 ' + r.name) : r.name,
        size: r.strong ? 2 : 1
      };
    });
    try {
      LightweightCharts.createSeriesMarkers(candleSeries, markers);
    } catch (e) {
      console.warn('[swing] pattern markers failed', e);
    }
    return allRows;
  }

  // ── Pattern cards (below the chart) ─────────────────────────────────
  // Renders the most-recent Tier-1 patterns as clickable cards in the
  // "Zone & Signal Analysis" panel. Driven by the SAME rows that produced
  // the chart markers (drawPatternMarkers), so the cards and the arrows can
  // never disagree. Each card states the pattern, its location/zone verdict,
  // and a plain-English action; the title attribute carries the full
  // tooltip (definition + meaning + bar date). Clicking a card centres the
  // chart on that bar. Cards inherit the no-repaint guard (the forming bar
  // is never in `rows`).
  var PATTERN_CARD_MAX = 4;   // most-recent + 3 prior (default view)

  // ── Candlestick history toggle ───────────────────────────────────────
  // Default OFF: the chart markers AND the cards show only the most-recent
  // PATTERN_CARD_MAX patterns, so the chart isn't buried under dozens of
  // labels. "Show history" reveals every detected pattern (chart + cards) for
  // back-testing by eye. Persisted so the choice sticks. Mirrors the chart-
  // pattern history toggle (scripts/chart-patterns.js).
  var CANDLE_HIST_KEY = 'sw_candle_history_v1';
  var swCandleHistory = (function () {
    try { return localStorage.getItem(CANDLE_HIST_KEY) === '1'; } catch (_) { return false; }
  })();

  // Outcome → card badge (label + class suffix + tooltip). Mirrors the
  // geometric chart-pattern badges (OUTCOME_BADGE in scripts/chart-patterns.js)
  // so candle and chart-pattern cards read the same: LIVE = still in play,
  // ✓ WORKED = the 2R target was reached first, ✗ FAILED = the formation's stop
  // closed through first. Resolved patterns are KEPT, never dropped.
  var PATTERN_OUTCOME_BADGE = {
    LIVE:   { label: 'LIVE',          cls: 'live',
      tip: 'Still in play \u2014 neither the 2R target nor the formation stop has been closed through yet.' },
    WORKED: { label: '\u2713 WORKED', cls: 'worked',
      tip: 'Worked \u2014 price reached the 2R target before breaking the formation stop.' },
    FAILED: { label: '\u2717 FAILED', cls: 'failed',
      tip: 'Failed \u2014 price closed through the formation stop before reaching target (reversal rejected).' }
  };

  // Short, plain-English definition of each plotted pattern (for tooltips).
  var PATTERN_DEFN = {
    'Bullish Engulfing':   'A green body that fully engulfs the prior red body — buyers overwhelm sellers.',
    'Bearish Engulfing':   'A red body that fully engulfs the prior green body — sellers overwhelm buyers.',
    'Morning Star':        'Three-bar bottom: a big red bar, a small indecision bar, then a big green bar closing past the first bar\u2019s midpoint.',
    'Morning Doji Star':   'A Morning Star whose middle bar is a true doji — a stronger bottom reversal.',
    'Evening Star':        'Three-bar top: a big green bar, a small indecision bar, then a big red bar closing past the first bar\u2019s midpoint.',
    'Evening Doji Star':   'An Evening Star whose middle bar is a true doji — a stronger top reversal.',
    'Hammer':              'Long lower wick with a small body at the top — sellers were rejected; a bullish reversal at support.',
    'Shooting Star':       'Long upper wick with a small body at the bottom — buyers were rejected; a bearish reversal at resistance.',
    'Three White Soldiers':'Three strong rising green bars — sustained bullish momentum.',
    'Three Black Crows':   'Three strong falling red bars — sustained bearish momentum.',
    'Piercing Pattern':    'A green bar that opens below the prior red close and closes past its midpoint — a near-engulfing bullish reversal.',
    'Dark Cloud Cover':    'A red bar that opens above the prior green close and closes below its midpoint — a near-engulfing bearish reversal.',
    'Dragonfly Doji':      'A doji with a long lower wick and almost no upper wick — a \u201Cpure\u201D hammer; a bullish rejection of the lows.',
    'Gravestone Doji':     'A doji with a long upper wick and almost no lower wick — a \u201Cpure\u201D shooting star; a bearish rejection of the highs.'
  };

  var _PAT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function _swPatternDateLabel(ts, tf) {
    var ms = new Date(ts).getTime();
    if (!isFinite(ms)) return '';
    var ist = new Date(ms + IST_OFF_SEC * 1000);
    var base = ist.getUTCDate() + ' ' + _PAT_MONTHS[ist.getUTCMonth()] + ' ' + ist.getUTCFullYear();
    if (tf === '1d' || tf === '1w' || tf === '1mo') return base;
    var hh = ('0' + ist.getUTCHours()).slice(-2);
    var mm = ('0' + ist.getUTCMinutes()).slice(-2);
    return base + ' ' + hh + ':' + mm;
  }

  // Location label + class + plain-English action note for a card row.
  function _swPatternLoc(row) {
    var k = row.kind;
    if (k === 'DEMAND') return {
      label: 'At demand zone', cls: 'sw-loc-strong-bull',
      note: 'Bullish reversal sitting on a demand zone (support) — the strongest long context; watch for follow-through.'
    };
    if (k === 'SUPPLY') return {
      label: 'At supply zone', cls: 'sw-loc-strong-bear',
      note: 'Bearish reversal sitting on a supply zone (resistance) — a strong short / exit context.'
    };
    if (k === 'POCKET') return {
      label: 'In Fib golden pocket', cls: 'sw-loc-strong-bull',
      note: 'Bullish reversal in the 61.8\u201380% golden pocket (the discount long band) on a valid pullback — watch for follow-through.'
    };
    if (k === 'POCKET_FALLING') return {
      label: 'Golden pocket \u2014 falling', cls: 'sw-loc-warn',
      note: '\u26A0 In the golden pocket but price is still falling THROUGH it — NOT a confirmed long. Wait for an actual reversal.'
    };
    // NONE
    return row.dir === 'bull'
      ? { label: 'Open space', cls: 'sw-loc-none',
          note: 'Bullish reversal with no support level nearby — weaker on its own; needs other confluence.' }
      : { label: 'Open space', cls: 'sw-loc-none',
          note: 'Bearish reversal with no resistance level nearby — weaker on its own; needs other confluence.' };
  }

  function _swPaintPatternCards(rows, tf) {
    var host = $('sw-pattern-cards');
    if (!host) return;
    if (!rows || !rows.length) { host.hidden = true; host.innerHTML = ''; return; }
    STATE.patternRows = rows;   // consumed by window.swFocusPatternBar

    var spec = (typeof TF_SPECS !== 'undefined' && TF_SPECS[tf]) ? TF_SPECS[tf] : null;
    var tfLabel = spec ? spec.label : tf;
    // Chronological, left→right: oldest on the left, LATEST on the right.
    // Default view caps to the most-recent PATTERN_CARD_MAX; "Show history"
    // reveals every detected pattern (matches the chart markers).
    var recent = swCandleHistory ? rows.slice() : rows.slice(-PATTERN_CARD_MAX);
    var hiddenCount = rows.length - recent.length;

    var cards = recent.map(function (r) {
      var loc = _swPatternLoc(r);
      var arrow = r.dir === 'bull' ? '\u25B2' : '\u25BC';
      var star = r.strong ? '\u2605 ' : '';
      // Date/time of the signal bar (date for daily+, date + IST time for
      // intraday) — clearer per-timeframe than a raw "N bars ago" count.
      var dateLabel = _swPatternDateLabel(r.ts, tf);
      var defn = PATTERN_DEFN[r.name] || '';
      var oc = PATTERN_OUTCOME_BADGE[r.outcome] || PATTERN_OUTCOME_BADGE.LIVE;
      var tip = r.name + ' (' + (r.dir === 'bull' ? 'bullish' : 'bearish') + '). '
        + defn + ' \u2014 ' + loc.note
        + ' ' + oc.tip
        + ' Bar: ' + dateLabel + '.';
      var cls = 'sw-pattern-card sw-pattern-card--' + r.dir
        + (r.strong ? ' is-strong' : '')
        + (r.kind === 'POCKET_FALLING' ? ' is-warn' : '')
        + ' is-' + oc.cls;
      return '<button type="button" class="' + cls + '"'
        + ' onclick="window.swFocusPatternBar(' + r.idx + ',\'' + tf + '\')"'
        + ' title="' + escapeHtml(tip) + '">'
        + '<span class="sw-pattern-card-r1">'
          + '<span class="sw-pattern-card-arrow">' + arrow + '</span>'
          + '<span class="sw-pattern-card-name">' + escapeHtml(star + r.name) + '</span>'
          + '<span class="sw-pattern-card-dir sw-pattern-card-dir--' + r.dir + '">'
            + (r.dir === 'bull' ? 'Bullish' : 'Bearish') + '</span>'
          + '<span class="sw-pattern-card-state">' + oc.label + '</span>'
          + '<span class="sw-pattern-card-ago">' + escapeHtml(dateLabel) + '</span>'
        + '</span>'
        + '<span class="sw-pattern-card-loc ' + loc.cls + '">' + escapeHtml(loc.label) + '</span>'
        + '<span class="sw-pattern-card-note">' + escapeHtml(loc.note) + '</span>'
      + '</button>';
    }).join('');

    // History chip: only meaningful when something is hidden (or already on).
    // The "Show history" label breaks down the hidden set by outcome so the
    // chip previews the audit trail — e.g. "Show history (5: 3✓ 2✗)".
    var histChip = '';
    if (swCandleHistory) {
      histChip = '<button type="button" class="sw-pattern-hist-toggle is-on"'
        + ' onclick="window.swToggleCandleHistory()"'
        + ' title="Hide older patterns — show only the most recent">'
        + 'Hide history</button>';
    } else if (hiddenCount > 0) {
      var hidden = rows.slice(0, hiddenCount);
      var nW = hidden.filter(function (r) { return r.outcome === 'WORKED'; }).length;
      var nF = hidden.filter(function (r) { return r.outcome === 'FAILED'; }).length;
      var breakdown = '<span class="sw-pattern-hist-w">' + nW + '\u2713</span> '
        + '<span class="sw-pattern-hist-f">' + nF + '\u2717</span>';
      histChip = '<button type="button" class="sw-pattern-hist-toggle"'
        + ' onclick="window.swToggleCandleHistory()"'
        + ' title="Reveal every detected pattern on the chart + cards ('
          + nW + ' worked, ' + nF + ' failed in history)">'
        + 'Show history (' + hiddenCount + ': ' + breakdown + ')</button>';
    }

    var subText = swCandleHistory
      ? ('all ' + recent.length + ' \u00B7 ' + escapeHtml(tfLabel) + ' (recommendation TF) \u00B7 tap a card to jump to it')
      : ('latest ' + recent.length + ' \u00B7 ' + escapeHtml(tfLabel) + ' (recommendation TF) \u00B7 tap a card to jump to it');

    host.innerHTML =
      '<div class="sw-pattern-cards-head">'
        + '<span class="sw-pattern-cards-icon" aria-hidden="true">\u25C6</span>'
        + '<span class="sw-pattern-cards-title">Candlestick Patterns</span>'
        + '<span class="sw-pattern-cards-sub">' + subText + '</span>'
        + histChip
      + '</div>'
      + '<div class="sw-pattern-card-grid">' + cards + '</div>';
    host.hidden = false;
  }

  // Render the pattern cards for the RECOMMENDATION timeframe (swGetRecoTf —
  // independent of the chart's TF). The chart TF only paints the chart's own
  // arrows; the cards always follow the reco TF control. Lazy-loads the reco
  // TF's candles if they aren't cached yet, then paints (guarding against a
  // reco-TF change that lands while the fetch is in flight).
  function _swRenderPatternCardsForReco(chartTf, chartRaw) {
    var ctf = (typeof swGetRecoTf === 'function') ? swGetRecoTf() : (chartTf || '1d');
    if (STATE.indVisible && STATE.indVisible.patterns === false) {
      _swPaintPatternCards([], ctf);
      return;
    }
    var R = STATE.result;
    var craw = (R && R.candles && R.candles[ctf] && R.candles[ctf].length)
      ? R.candles[ctf]
      : (ctf === chartTf ? chartRaw : null);
    if (craw && craw.length) {
      _swPaintPatternCards(collectTier1Patterns(craw, ctf), ctf);
      return;
    }
    // Reco-TF candles not loaded yet — hide for now, lazy-load, then paint
    // only if the reco TF hasn't changed again in the meantime.
    _swPaintPatternCards([], ctf);
    if (typeof getRawForTf === 'function') {
      getRawForTf(ctf).then(function (fresh) {
        try {
          if (swGetRecoTf() === ctf && fresh && fresh.length) {
            _swPaintPatternCards(collectTier1Patterns(fresh, ctf), ctf);
          }
        } catch (_) {}
      }).catch(function () {});
    }
  }

  // Centre the chart on a pattern's bar (click-to-focus from a card). The
  // cards run on the RECO TF, so if the chart is showing a different TF we
  // first switch the chart to the card's TF (bar indices only line up within
  // the same TF), THEN centre once the re-render settles.
  function _swCenterChartBar(idx) {
    try {
      if (!STATE.chart || typeof STATE.chart.timeScale !== 'function') return;
      STATE.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 50), to: idx + 50 });
    } catch (_) { /* chart gone / disposed — ignore */ }
  }
  window.swFocusPatternBar = function (idx, tf) {
    try {
      if (tf && STATE.chartTf !== tf && typeof renderMainChart === 'function') {
        Promise.resolve(renderMainChart(tf)).then(function () { _swCenterChartBar(idx); });
      } else {
        _swCenterChartBar(idx);
      }
    } catch (_) { /* ignore */ }
  };

  // Flip the candlestick history view (chart markers + cards) and persist it,
  // then re-render the chart so BOTH paths pick up the new cap in lock-step.
  window.swToggleCandleHistory = function () {
    swCandleHistory = !swCandleHistory;
    try { localStorage.setItem(CANDLE_HIST_KEY, swCandleHistory ? '1' : '0'); } catch (_) {}
    try {
      if (typeof renderMainChart === 'function') {
        renderMainChart(STATE.chartTf || (typeof swGetRecoTf === 'function' ? swGetRecoTf() : '1d'));
      }
    } catch (_) { /* ignore */ }
  };

  // ── Bridge for the chart-patterns.js module (scripts/chart-patterns.js) ──
  // The geometric chart-pattern engine (Head & Shoulders, Double Top/Bottom,
  // Cup & Handle, …) lives in its own file to keep this module from growing
  // (AGENTS.md §18). It only needs a handful of closure-private helpers; we
  // publish them ONCE here so ALL the detection/overlay/card logic can stay
  // in the module. Function declarations are hoisted, so this is safe even
  // though some are defined further down the closure.
  window._swCP = {
    candleTime: candleTime,
    drawPriceLevel: drawPriceLevel,
    getRawForTf: getRawForTf,
    renderMainChart: renderMainChart,
    detectZones: detectZones,
    computeFibZone: computeFibZone,
    centerChartBar: _swCenterChartBar,
    currentChartTf: function () { return STATE.chartTf; }
  };

  function volumeSeriesOpts() {
    return {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      scaleMargins: { top: 0.85, bottom: 0 },
      lastValueVisible: false,
      priceLineVisible: false
    };
  }

  // Fib levels: 0% = swing high, 100% = swing low.
  // Golden pocket: 61.8%–80.0%. Colours chosen to be maximally
  // distinct across all 7 levels.
  var FIB_BAND_LEVELS = [
    { ratio: 0.000, label: '0.00%', line: '#ef4444' },
    { ratio: 0.236, label: '23.6%', line: '#f97316' },
    { ratio: 0.382, label: '38.2%', line: '#22c55e' },
    { ratio: 0.500, label: '50.0%', line: '#06b6d4' },
    { ratio: 0.618, label: '61.8%', line: '#a855f7' },
    { ratio: 0.800, label: '80.0%', line: '#ec4899' },
    { ratio: 1.000, label: '100%',  line: '#3b82f6' }
  ];

  function drawPriceLevel(series, price, color, title, opts) {
    if (!isFinite(price) || !series) return;
    var cfg = {
      price: price,
      color: color,
      lineWidth: 2,
      lineStyle: 2,
      axisLabelVisible: true,
      title: title || ''
    };
    if (opts) { for (var k in opts) cfg[k] = opts[k]; }
    series.createPriceLine(cfg);
  }

  // Show / hide overlay messages in the chart mount. We swap inner
  // HTML instead of toggling [hidden] so layout reflow keeps the
  // chart canvas behind the message at the same dimensions.
  function setChartOverlay(html) {
    var mount = $('sw-chart');
    if (!mount) return;
    var ov = mount.querySelector('.sw-chart-overlay');
    if (!html) {
      if (ov) ov.remove();
      return;
    }
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'sw-chart-overlay sw-chart-empty';
      mount.appendChild(ov);
    }
    ov.innerHTML = html;
  }

  function setChartStatus(text) {
    var el = $('sw-chart-status');
    if (el) el.textContent = text;
  }

  // Mark which TF button is active. Also disables them while a
  // fetch is in-flight to prevent spamming Upstox V3.
  function setActiveTfBtn(tf, opts) {
    var locked = opts && opts.locked;
    var btns = document.querySelectorAll('.sw-chart-tf-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.getAttribute('data-tf') === tf) b.classList.add('active');
      else b.classList.remove('active');
      // Use a visual "busy" class, NOT the `disabled` attribute: a real
      // disabled <button> swallows click events entirely, so a stalled /
      // throttled render would leave TF switching permanently dead. The
      // busy class only dims the button + shows a wait cursor; clicks still
      // fire so the user can switch to a cached TF, which supersedes the
      // in-flight render (renderMainChart's chartTf guard discards the
      // stale paint and getRawForTf de-dupes the fetch).
      b.classList.toggle('sw-chart-tf-btn--busy', !!locked);
      b.removeAttribute('disabled');
    }
  }

  // Get the raw candles for a TF: prefer the in-memory cache; fall
  // back to a network fetch. The fetch promise itself is cached in
  // `STATE.chartFetching` so two quick button clicks on the same TF
  // don't double-request.
  async function getRawForTf(tf) {
    var R = STATE.result;
    if (!R) throw new Error('No analysis loaded');
    if (!R.candles) R.candles = {};
    if (R.candles[tf] && R.candles[tf].length) return R.candles[tf];
    if (STATE.chartFetching[tf]) return STATE.chartFetching[tf];
    var stock = STATE.selected;
    if (!stock || !stock.isin) throw new Error('No stock selected');
    var p = fetchTf(stock.isin, tf).then(function (raw) {
      R.candles[tf] = raw || [];
      delete STATE.chartFetching[tf];
      return R.candles[tf];
    }).catch(function (err) {
      delete STATE.chartFetching[tf];
      throw err;
    });
    STATE.chartFetching[tf] = p;
    return p;
  }

  // The core render. Called once on analyze (with '1d') and again
  // every time the user clicks a TF button. Idempotent — re-rendering
  // the same TF rebuilds the chart cleanly.
  async function renderMainChart(tf) {
    STATE.chartTf = tf;
    // Bidirectional TF lock (2026-06): the chart TF and the recommendation
    // TF are mirrored. Selecting any chart TF (toolbar click, scanner open,
    // card focus) also moves the reco TF to the same value here, so the
    // verdict + candlestick/chart-pattern cards (all computed off
    // swGetRecoTf() at the end of this render) and the on-chart overlay
    // always share one timeframe. The reco→chart direction is closed in
    // swSetRecoTf. Pure class/localStorage writes — no re-entrancy (this
    // never calls swSetRecoTf, and _swSyncRecoTfButtons only toggles CSS).
    try {
      if (SW_RECO_TF_SELECTABLE[tf]) localStorage.setItem(SW_RECO_TF_KEY, tf);
    } catch (_) {}
    try { _swSyncRecoTfButtons(tf); } catch (_) {}
    var mount = $('sw-chart');
    if (!mount) return;
    setActiveTfBtn(tf, { locked: true });

    var spec = TF_SPECS[tf] || { label: tf };
    var R = STATE.result;
    var haveCached = R && R.candles && R.candles[tf] && R.candles[tf].length;

    if (!haveCached) {
      setChartOverlay(
        '<div class="sw-spinner" style="width:26px;height:26px"></div>' +
        '<div>Loading ' + escapeHtml(spec.label) + ' candles&hellip;</div>'
      );
      setChartStatus(spec.label + ' — fetching from Upstox…');
    } else {
      setChartStatus(spec.label + ' — rendering…');
    }

    try {
      await loadLwcLib();
    } catch (e) {
      setChartOverlay('<div>Chart engine could not load. Check your network and refresh.</div>');
      setChartStatus(spec.label + ' — engine failed');
      setActiveTfBtn(tf, { locked: false });
      return;
    }

    if (STATE.chartTf !== tf) return;

    var raw;
    try {
      raw = await getRawForTf(tf);
    } catch (err) {
      setChartOverlay('<div>Failed to fetch ' + escapeHtml(spec.label) + ' candles: ' +
        escapeHtml((err && err.message) || 'unknown') + '</div>');
      setChartStatus(spec.label + ' — fetch failed');
      setActiveTfBtn(tf, { locked: false });
      return;
    }
    if (STATE.chartTf !== tf) return;

    // Diagnostic: dump last 10 candles so user can verify against TradingView
    var lastTen = raw.slice(0, 10);
    console.log('[swing] ' + tf + ' LAST 10 CANDLES (newest first):');
    lastTen.forEach(function (c, i) {
      console.log('  ' + i + ': ' + c[0] + '  O=' + c[1] + ' H=' + c[2] + ' L=' + c[3] + ' C=' + c[4] + ' V=' + c[5]);
    });

    var klines = rawToKlines(raw, tf);
    if (klines.length < 5) {
      setChartOverlay('<div>Not enough ' + escapeHtml(spec.label) + ' candles to draw a chart.</div>');
      setChartStatus(spec.label + ' — ' + klines.length + ' candles');
      setActiveTfBtn(tf, { locked: false });
      return;
    }

    // View preservation (2026-06-06): a label/indicator toggle re-renders the
    // whole chart, which would otherwise snap the view back to the default
    // window (see the two setVisibleLogicalRange calls below). When swToggleInd
    // requested a preserve render, snapshot the CURRENT view BEFORE disposing
    // the old chart, then restore it after the new chart is built. Toggles
    // re-use the SAME stock + TF + candles, so the logical (bar-index) range
    // maps 1:1. TF switches / stock changes / first load do NOT set the flag,
    // so they still reset to the default window. Price range is only captured
    // when the user had vertically panned (getVisibleRange returns null under
    // auto-scale) — otherwise we keep the new chart's auto-fit.
    var _preserveView = STATE._swPreserveView === true;
    STATE._swPreserveView = false;
    var _savedView = null;
    if (_preserveView && STATE.chart) {
      try {
        _savedView = {
          logical: STATE.chart.timeScale().getVisibleLogicalRange(),
          price: STATE.chart.priceScale('right').getVisibleRange()
        };
      } catch (_) { _savedView = null; }
    }

    disposeMainChart();
    setChartOverlay('');

    var inner = mount.querySelector('.sw-chart-inner');
    if (!inner) {
      inner = document.createElement('div');
      inner.className = 'sw-chart-inner';
      // overflow:hidden is a safety net: even if any price-anchored overlay
      // (zone band, FVG/OB rect, BOS/LIQ marker) computes a coordinate above
      // the plot on an aggressive zoom, it stays clipped to the chart instead
      // of spilling up over the toolbar / legend. Hover tooltips live on
      // <body> and the countdown chip on the outer mount, so neither is clipped.
      inner.style.cssText = 'position:absolute;inset:0;overflow:hidden';
      mount.appendChild(inner);
    } else {
      inner.innerHTML = '';
    }
    // Reset the per-render overlay-updater registry and bind the shared
    // scroll/drag/pinch interaction listeners ONCE for this `inner`
    // element (see _swBindOverlayInteractions). Each overlay block below
    // pushes its reposition callback into this array instead of attaching
    // its own (leaking) listeners.
    inner._swOverlayUpdaters = [];
    _swBindOverlayInteractions(inner);

    var chart;
    try {
      chart = LightweightCharts.createChart(inner, chartOptions(tf));
    } catch (e) {
      console.warn('[swing] LWC createChart failed', e);
      setChartOverlay('<div>Chart failed to initialise.</div>');
      setActiveTfBtn(tf, { locked: false });
      return;
    }
    if (!chart) {
      setChartOverlay('<div>Chart failed to initialise.</div>');
      setActiveTfBtn(tf, { locked: false });
      return;
    }

    var candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, candleSeriesOpts());
    candleSeries.setData(klines);
    // if you want to see more candles, you can increase the VISIBLE_BARS value
    var _ts = chart.timeScale();
    var _n = klines.length;
    var VISIBLE_BARS = 100;            // tune to taste
    _ts.setVisibleLogicalRange({ from: Math.max(0, _n - VISIBLE_BARS), to: _n + 3 });

    // ── Tier-1 candlestick-pattern markers (auto, per timeframe) ──
    // Plots only the high-reliability reversal/continuation patterns the
    // user trades off (Engulfing, Morning/Evening Star, Hammer, Shooting
    // Star, Three White Soldiers / Black Crows). Reuses the SAME tested
    // detectPatterns() classifier the verdict engine uses — no second,
    // drifting implementation. Re-derived on every render, so each TF and
    // each stock selection shows its own patterns automatically.
    //
    // Robustness invariants (real money depends on these):
    //  • NO REPAINTING — the live, still-forming bar is never marked while
    //    the market is open (its shape mutates tick-to-tick). When market
    //    state is unknown we also skip the last bar (fail-safe, favouring a
    //    missed marker over a repainting one).
    //  • LOCAL trend per bar — Hammer-vs-Hanging-Man and Inverted-Hammer-
    //    vs-Shooting-Star hinge on prior trend. We feed detectPatterns the
    //    bar's OWN trend (close vs its 50-EMA) instead of a single global
    //    trend, so a hammer at a local bottom inside an uptrend is still a
    //    bullish Hammer, not mislabelled Hanging Man.
    if (STATE.indVisible.patterns !== false) {
      drawPatternMarkers(candleSeries, raw, tf);
    }
    // Pattern CARDS follow the recommendation TF (not the chart TF), so
    // switching the chart picture never changes them — only the reco-TF
    // control does. See _swRenderPatternCardsForReco.
    _swRenderPatternCardsForReco(tf, raw);

    // ── Tier-1 GEOMETRIC chart patterns (separate module) ──────────────
    // Head & Shoulders / Inverse H&S / Double Top / Double Bottom / Cup &
    // Handle. Detection + overlay + cards live in scripts/chart-patterns.js;
    // we just hand it the freshly-built chart objects. Drawn as a neckline
    // line + target/invalidation price lines (NOT series markers, so the
    // candlestick arrows above are never clobbered). Toggle: 'chartpatterns'.
    if (window.ChartPatterns) {
      if (STATE.indVisible.chartpatterns !== false) {
        try {
          window.ChartPatterns.onChartRender({ chart: chart, series: candleSeries, inner: inner, raw: raw, tf: tf });
        } catch (e) { console.warn('[swing] chart-pattern overlay failed', e); }
      } else {
        window.ChartPatterns.clearCards();
      }
    }

    // ── Vertical drag-to-pan (2D panning like TradingView) ──────────
    // LWC body-drag only scrolls time (horizontal); vertical is left to
    // the price axis. We add price panning on top so a mouse drag moves
    // up/down too. Implemented via the right price scale's scaleMargins:
    // we add to `top` and subtract the SAME amount from `bottom`, so the
    // drawing-area height is unchanged — a pure vertical translation, no
    // zoom distortion. Horizontal time-drag is untouched, so a diagonal
    // drag pans both axes. (Touch already pans vertically via
    // vertTouchDrag; this is the desktop-mouse counterpart.)
    //
    // `inner` is reused across TF switches, so the listeners are bound
    // ONCE and read the current chart from inner._vpan, which we refresh
    // on every render below — no listener accumulation.
    // inner._vpan = { rps: chart.priceScale('right'), margins: { top: 0.1, bottom: 0.1 }, dragging: false, lastY: 0 };
    // if (!inner._vpanBound) {
    //   inner._vpanBound = true;
    //   var vClamp = function (v) { return v < 0 ? 0 : (v > 0.9 ? 0.9 : v); };
    //   inner.addEventListener('mousedown', function (e) {
    //     var vp = inner._vpan;
    //     if (!vp || e.button !== 0) return;
    //     // Skip drags starting over the price axis — LWC scales it there.
    //     var rect = inner.getBoundingClientRect();
    //     var axisW = 0;
    //     try { axisW = vp.rps.width() || 0; } catch (_) {}
    //     if (axisW && (e.clientX - rect.left) > rect.width - axisW) return;
    //     try {
    //       var sm = vp.rps.options().scaleMargins;
    //       if (sm && isFinite(sm.top) && isFinite(sm.bottom)) { vp.margins.top = sm.top; vp.margins.bottom = sm.bottom; }
    //     } catch (_) {}
    //     vp.dragging = true; vp.lastY = e.clientY;
    //   });
    //   window.addEventListener('mousemove', function (e) {
    //     var vp = inner._vpan;
    //     if (!vp || !vp.dragging) return;
    //     var h = inner.clientHeight || 1;
    //     var dy = e.clientY - vp.lastY;
    //     vp.lastY = e.clientY;
    //     if (!dy) return;
    //     var frac = dy / h;
    //     vp.margins.top = vClamp(vp.margins.top + frac);
    //     vp.margins.bottom = vClamp(vp.margins.bottom - frac);
    //     try { vp.rps.applyOptions({ scaleMargins: { top: vp.margins.top, bottom: vp.margins.bottom } }); } catch (_) {}
    //   });
    //   window.addEventListener('mouseup', function () { if (inner._vpan) inner._vpan.dragging = false; });
    //   // Double-click resets the vertical pan back to centred.
    //   inner.addEventListener('dblclick', function () {
    //     var vp = inner._vpan;
    //     if (!vp) return;
    //     vp.margins.top = 0.1; vp.margins.bottom = 0.1;
    //     try { vp.rps.applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } }); } catch (_) {}
    //   });
    // }
    inner._vpan = { rps: chart.priceScale('right'), series: candleSeries, dragging: false, lastY: 0 };
    if (!inner._vpanBound) {
      inner._vpanBound = true;
      inner.addEventListener('mousedown', function (e) {
        var vp = inner._vpan;
        if (!vp || e.button !== 0) return;
        // Skip drags starting over the price axis — LWC scales it there.
        var rect = inner.getBoundingClientRect();
        var axisW = 0;
        try { axisW = vp.rps.width() || 0; } catch (_) {}
        if (axisW && (e.clientX - rect.left) > rect.width - axisW) return;
        vp.dragging = true; vp.lastY = e.clientY;
      });
      window.addEventListener('mousemove', function (e) {
        var vp = inner._vpan;
        if (!vp || !vp.dragging) return;
        var rect = inner.getBoundingClientRect();
        var prevY = vp.lastY - rect.top;
        var curY  = e.clientY - rect.top;
        vp.lastY = e.clientY;
        if (prevY === curY) return;

        // TRUE vertical pan: SHIFT the visible price range by the grabbed price
        // delta (grab-and-drag), keeping its SPAN constant. The old scaleMargins
        // approach grew top+bottom once a margin hit its [0,0.9] clamp, which
        // squeezed the plot area and blew the price gaps out (the "compact chart").
        var ps = vp.rps, s = vp.series;
        if (!ps || !s) return;
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
        var pCur  = s.coordinateToPrice(curY);
        if (!isFinite(pPrev) || !isFinite(pCur)) return;
        var d = pPrev - pCur;                 // price the cursor moved across
        if (!d) return;
        try {
          ps.setAutoScale(false);
          ps.setVisibleRange({ from: bot + d, to: top + d });
        } catch (_) {}
      });
      window.addEventListener('mouseup', function () { if (inner._vpan) inner._vpan.dragging = false; });
      // Double-click → back to auto-fit (price + margins).
      inner.addEventListener('dblclick', function () {
        var vp = inner._vpan;
        if (!vp || !vp.rps) return;
        try {
          vp.rps.setAutoScale(true);
          vp.rps.applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
        } catch (_) {}
      });
    }



    // Volume bars removed — volume is shown on hover via the OHLCV tooltip.
    // Build a time→volume lookup for the tooltip.
    var volByTime = {};
    var volumes = rawToVolumes(raw, tf);
    for (var vi = 0; vi < volumes.length; vi++) {
      var vKey = typeof volumes[vi].time === 'object'
        ? volumes[vi].time.year + '-' + volumes[vi].time.month + '-' + volumes[vi].time.day
        : volumes[vi].time;
      volByTime[vKey] = volumes[vi].value;
    }

    // ── EMA / SMA overlays (computed manually) ──
    var sorted = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var closes = sorted.map(function (c) { return +c[4]; });
    var times  = sorted.map(function (c) { return candleTime(c[0], tf); });

    function addEmaLine(period, color) {
      if (!STATE.indVisible['ema' + period]) return;
      var vals = ema(closes, period);
      var data = [];
      for (var i = 0; i < vals.length; i++) {
        if (isFinite(vals[i])) data.push({ time: times[i], value: vals[i] });
      }
      if (!data.length) return;
      var s = chart.addSeries(LightweightCharts.LineSeries, { color: color, lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false });
      s.setData(data);
    }
    addEmaLine(20, '#3b82f6');
    addEmaLine(50, '#f97316');
    addEmaLine(200, '#9333ea');

    if (STATE.indVisible.sma44) {
      var sma44Vals = sma(closes, 44);
      var sma44Data = [];
      for (var si = 0; si < sma44Vals.length; si++) {
        if (isFinite(sma44Vals[si])) sma44Data.push({ time: times[si], value: sma44Vals[si] });
      }
      if (sma44Data.length) {
        var smaS = chart.addSeries(LightweightCharts.LineSeries, { color: '#eab308', lineWidth: 1.5, lastValueVisible: false, priceLineVisible: false });
        smaS.setData(sma44Data);
      }
    }

    _syncIndToggles();

    // Trade plan levels (Entry / SL / T1 / T2) drawn when verdict is BUY.
    // swActivePlan() == swSetupPlanForRender() — the SAME single producer the
    // SETUP card (#sw-bplan) renders from — so the on-chart levels match the
    // SETUP card exactly (chart == card == trade plan). It always returns a plan
    // object when STATE.result exists (a no-trade clone if no setup frames), so
    // there's no null to fall back from; the guard is just defensive.
    var plan = (typeof swActivePlan === 'function' ? swActivePlan() : null) || (R && R.plan);
    var hasLevels = plan && plan.action === 'BUY' && plan.sl != null;
    // Recompute fib from the CURRENT TF's candles so swing high /
    // swing low match this timeframe (they differ across TFs).
    // FIB overlay derives its golden-pocket levels directly from the
    // CURRENT TF's candles (computeFibZone) — it does NOT require the Fib
    // SCANNER to have run. The toggle is ON by default (like ZOI), so the
    // retracement is plotted the moment the chart opens, no scan needed.
    // A prior scan (FIB_STATE.pendingFib) only influences the default TF.
    var fibToggle = $('sw-fib-toggle');
    // Recommendation basis drives the ANALYSIS CARDS + verdict (recoFib /
    // recoZoi); the legend chips drive only what's DRAWN on the chart.
    var _recoMode = swGetRecoMode();
    var recoFib = (_recoMode === 'FIB' || _recoMode === 'FIB_ZOI');
    var recoZoi = (_recoMode === 'ZOI' || _recoMode === 'FIB_ZOI');
    // ── Reco TIMEFRAME decoupling (2026-06-01) ──
    // The analysis CARDS + verdict compute from the Recommendation TF
    // (swGetRecoTf, default Weekly), which is INDEPENDENT of the chart's
    // TF. The chart candles + chart overlays still use the chart-TF
    // candles (`raw`). `recoRaw` falls back to `raw` when the reco TF's
    // candles aren't loaded yet (swSetRecoTf lazy-loads + repaints).
    var _recoTf = swGetRecoTf();
    var recoRaw = (R && R.candles && R.candles[_recoTf] && R.candles[_recoTf].length)
      ? R.candles[_recoTf] : raw;
    // Chart fib OVERLAY uses the chart-TF candles; the fib CARD uses the
    // reco-TF candles. Two separate computes so they can diverge.
    var _fibChartCtx = computeFibZone(raw);
    var fibCtx = STATE.indVisible.fib ? _fibChartCtx : null;
    var _fibComputed = computeFibZone(recoRaw);
    if (fibToggle) fibToggle.classList.toggle('active', !!fibCtx);

    // Recommendation verdict for the reco TF — computed ONCE here and reused
    // for (a) gating the on-chart trade levels below and (b) the Fib card's
    // signal badge further down (single source of truth, one compute).
    var _recoVerdict = null;
    try { _recoVerdict = swComputeVerdictForTf(_recoTf); } catch (_) { _recoVerdict = null; }
    var _verdictUsable = !!(_recoVerdict && _recoVerdict.text && !_recoVerdict.intraday && !_recoVerdict.noData);
    var _verdictIsBuy = _verdictUsable && _recoVerdict.text === 'BUY';
    // ── Real-money gate: the structure plan is a SETUP blueprint, NOT a timing
    // trigger. Only paint Entry/SL/T1/T2 on the chart when the recommendation
    // for the reco TF is actually BUY. Otherwise the chart drew a clean
    // confirmed-BUY look (dashed Entry/SL/T1/T2) while the recommendation said
    // SKIP/WAIT — a dangerous mixed signal. When the verdict isn't usable
    // (cards-only sub-hourly TF / no data) we ALSO hide (fail-safe: never show
    // an un-gated BUY). The full blueprint + a "watch-only" warning still
    // render on the plan CARD below the chart, so nothing is lost.
    hasLevels = hasLevels && _verdictIsBuy;

    if (hasLevels) {
      drawPriceLevel(candleSeries, plan.entry, '#3b82f6', 'Entry');
      drawPriceLevel(candleSeries, plan.sl,    '#ef4444', 'SL');
      drawPriceLevel(candleSeries, plan.t1,    '#22c55e', 'T1');
      drawPriceLevel(candleSeries, plan.t2,    '#16a34a', 'T2');
    }

    // Fib retracement — price lines at each fib level.
    if (fibCtx) {
      FIB_BAND_LEVELS.forEach(function (lvl) {
        var price = fibCtx.swHigh - lvl.ratio * (fibCtx.swHigh - fibCtx.swLow);
        drawPriceLevel(candleSeries, price, lvl.line, lvl.label);
      });
    }

    var legendLevels = $('sw-chart-legend-levels');
    if (legendLevels) {
      // Fib levels live on the Y-axis now (see below), so the legend is shown
      // only when there's a trade plan to display — never for fib alone.
      // var hasAnything = hasLevels;
      // legendLevels.hidden = !hasAnything;

      var hasAnything = false;   // strip removed: duplicates chart price-lines + trade-plan card
      legendLevels.hidden = true;
      if (hasAnything) {
        var fp = function (n) { return '\u20B9' + (isFinite(n) ? Number(n).toFixed(2) : '\u2014'); };
        var pct = function (val, base) {
          if (!isFinite(val) || !isFinite(base) || base === 0) return '';
          var p = (val - base) / base * 100;
          return ' <span style="opacity:0.7;font-size:10px">(' + (p >= 0 ? '+' : '') + p.toFixed(1) + '%)</span>';
        };

        var html = '';

        if (hasLevels) {
          var rr = plan.rr && isFinite(plan.rr) ? ' &middot; 1:' + plan.rr.toFixed(1) + 'R' : '';
          // Label the trade-levels group by the PLAN SOURCE. The chart now draws
          // the mode-driven SETUP plan (same producer as the SETUP card, 2026-06-05
          // wiring fix), whose Entry/SL/T1/T2 come from the verdict's OWN Fib pocket
          // / demand zone — so the basis is the reco mode ('Fib' / 'ZOI' / 'Fib +
          // ZOI'). It is no longer the STRUCTURE (swing-low / ATR / stage) plan, so
          // it never reads 'Structure' here.
          var _planBasis = (recoFib && recoZoi) ? 'Fib + ZOI'
            : recoZoi ? 'ZOI' : recoFib ? 'Fib' : 'Setup';
          if (_planBasis) html += '<span class="sw-lvl-label">' + _planBasis + '</span>';
          html += '<span class="sw-lvl-chip sw-lvl-entry" title="Suggested entry price">'
            +   '<span class="sw-chart-dot sw-chart-dot-dash" style="background:#3b82f6"></span>'
            +   'Entry ' + fp(plan.entry)
            + '</span>'
            + '<span class="sw-lvl-chip sw-lvl-sl" title="Stop loss — exit below this level">'
            +   '<span class="sw-chart-dot sw-chart-dot-dash" style="background:#ef4444"></span>'
            +   'Stop ' + fp(plan.sl) + pct(plan.sl, plan.entry)
            + '</span>'
            + '<span class="sw-lvl-chip sw-lvl-t1" title="Target 1 — partial profit (50%)">'
            +   '<span class="sw-chart-dot sw-chart-dot-dash" style="background:#22c55e"></span>'
            +   'T1 ' + fp(plan.t1) + pct(plan.t1, plan.entry)
            + '</span>'
            + '<span class="sw-lvl-chip sw-lvl-t2" title="Target 2 — trail remaining">'
            +   '<span class="sw-chart-dot sw-chart-dot-dash" style="background:#16a34a"></span>'
            +   'T2 ' + fp(plan.t2) + pct(plan.t2, plan.entry)
            + '</span>'
            + (rr ? '<span class="sw-lvl-rr" title="Risk:Reward ratio">' + rr + '</span>' : '');
        }

        // Fib Retracement chips (0% / 61.8% / 80% / 100%) were removed here
        // (2026-06-06): the same levels are already drawn as labelled price
        // lines on the chart's Y-axis (drawPriceLevel above), so the legend
        // strip duplicated them. The legend now carries ONLY the trade plan
        // (Entry/SL/T1/T2/R:R + % move), which the axis does NOT spell out.

        legendLevels.innerHTML = html;
      }
    }

    // Trade plan banner removed — the detailed sw-plan card below
    // already shows Entry / T1 / T2 / SL / R:R with full precision.
    var tradePlan = $('sw-trade-plan');
    if (tradePlan) { tradePlan.hidden = true; tradePlan.innerHTML = ''; }

    // ── Fibonacci retracement card (mirrors the ZOI card style) ──
    // Surfaces the same data the old scanner table showed (Depth /
    // Retracement status / Signal) directly in the analysis cards, so
    // the trader gets it without ever running a scan. Driven entirely by
    // the already-computed fibCtx; tied to the FIB toggle like ZOI.
    var fibPanel = $('sw-fib-cards');
    if (fibPanel) {
      if (recoFib && _fibComputed) {
        fibPanel.hidden = false;
        var fpf = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
        var fb = _fibComputed;
        var fLeg = fb.swHigh - fb.swLow;
        var retrace = fLeg > 0 ? ((fb.swHigh - fb.currentPx) / fLeg) * 100 : 0;
        var retraceClamped = Math.max(0, Math.min(100, retrace));
        var inGP = retrace >= 61.8 && retrace <= 80;

        // bounceStatus → Buy/Watch/Skip signal + plain-English "what it's doing".
        var FIB_STATUS = {
          BOUNCE:    { sig: 'BUY',   cls: 'sw-zoi-score--high',     arrow: '\u2191', label: 'Bounce',    desc: 'Tapped the golden pocket and is rising back out \u2014 strongest long setup.' },
          RECOVERY:  { sig: 'BUY',   cls: 'sw-zoi-score--high',     arrow: '\u2197', label: 'Recovery',  desc: 'Fell below 80% then climbed back into the pocket \u2014 momentum turning up.' },
          RECOVERED: { sig: 'SKIP',  cls: 'sw-zoi-score--low',      arrow: '\u2197', label: 'Recovered', desc: 'Recovered from a deep retracement and now above the pocket \u2014 entry was missed, wait for next pullback.' },
          FORMING:   { sig: 'WATCH', cls: 'sw-zoi-score--mid',      arrow: '\u21AF', label: 'Forming',   desc: 'Inside the golden pocket and ticking up \u2014 wait for a clean reversal candle.' },
          FALLING:   { sig: 'SKIP',  cls: 'sw-zoi-score--low',      arrow: '\u2193', label: 'Falling',   desc: 'In or below the pocket and still falling \u2014 no reversal yet, stand aside.' },
          ABOVE:     { sig: '\u2014', cls: 'sw-zoi-card-score--none', arrow: '\u2192', label: 'Above',     desc: 'Has not pulled back into the pocket yet \u2014 too high to buy with an edge.' }
        };
        var fst = FIB_STATUS[fb.bounceStatus] || FIB_STATUS.ABOVE;

        // ── SIGNAL BADGE = the recommendation verdict (single source of truth) ──
        // The bounceStatus → BUY/SKIP map above is a LOOSE price-action read:
        // 'BOUNCE' keeps reading BUY even after price has run far above the
        // pocket, where the recommendation engine (fibClass RECOVERED_ABOVE_POCKET /
        // SHALLOW_ABOVE_POCKET / FAR_ABOVE_POCKET) correctly says SKIP. Surfacing that loose read as
        // the card's headline BUY contradicted the recommendation on the SAME
        // screen (e.g. card "BUY · Bounce" while the verdict says "SKIP —
        // recovered from deep retracement") — a dangerous mixed signal for a
        // real-money app. So the badge now MIRRORS swComputeVerdictForTf() for
        // the reco TF; the arrow + word further down stays as the descriptive
        // "what price is doing" context only, never as the actionable call.
        var _fibVerdict = _recoVerdict;   // reuse the single reco-TF verdict compute (see above)
        if (_fibVerdict && _fibVerdict.text && !_fibVerdict.intraday && !_fibVerdict.noData) {
          var _vt = _fibVerdict.text;   // 'BUY'|'WAIT'|'AVOID'|'SKIP'|'WATCH'|'\u2014'
          var _vSig = (_vt === 'BUY' && _fibVerdict.strongBuy) ? 'STRONG BUY' : _vt;
          var _vCls = (_vt === 'BUY') ? 'sw-zoi-score--high'
                    : (_vt === 'WAIT' || _vt === 'WATCH') ? 'sw-zoi-score--mid'
                    : (_vt === 'SKIP' || _vt === 'AVOID') ? 'sw-zoi-score--low'
                    : 'sw-zoi-card-score--none';
          fst = {
            sig: _vSig, cls: _vCls, arrow: fst.arrow, label: fst.label,
            desc: 'Recommendation for this timeframe: ' + _vSig
                + (_fibVerdict.sub ? ' \u2014 ' + _fibVerdict.sub : '')
                + '\n\nPrice action: ' + fst.label + '.'
          };
        }

        var typeTip = 'Fibonacci retracement of the last impulse leg (swing low \u2192 swing high). The 61.8%\u201380% band is the \u201cgolden pocket\u201d \u2014 where pullbacks in an uptrend most often find support.';
        var depthTip = retrace.toFixed(1) + '% retraced from swing high (' + fpf(fb.swHigh) + ') toward swing low (' + fpf(fb.swLow) + ').\n\nGolden pocket = 61.8%\u201380% retracement.\n' + (inGP ? '\u2705 Price is INSIDE the golden pocket now.' : (retrace < 61.8 ? 'Above the pocket \u2014 not pulled back deep enough yet.' : 'Below the pocket \u2014 overshot deeper than 80%.'));
        var sigTip = 'This badge is the RECOMMENDATION for this timeframe \u2014 the single source of truth. It always matches the verdict on the chart card, so the Fib card can never say BUY while the recommendation says SKIP.\n\nThe arrow + word below describes what price is DOING around the golden pocket (Bounce / Recovery / Recovered / Forming / Falling / Above) \u2014 context, not the call.\n\nThis stock: ' + fst.label + ' \u2192 ' + fst.sig;
        var pocketTip = 'Golden pocket price band (61.8% \u2192 80% retracement).\nUpper edge 61.8%: ' + fpf(fb.fib618) + '\nLower edge 80%: ' + fpf(fb.fib786) + '\nA pullback into this band is the highest-probability long entry.';

        // Direction tag: RISING / FALLING / CONSOLIDATING + origin zone + tooltip
        var _dirLabel = fb.fibDirection || 'FALLING';
        var _dirZone  = fb.fibOriginZone || 'Above';
        var _dirArrow = _dirLabel === 'RISING' ? '\u2191' : _dirLabel === 'FALLING' ? '\u2193' : '\u21C4';
        var _dirCls   = _dirLabel === 'RISING' ? 'sw-zoi-tag--fresh' : _dirLabel === 'CONSOLIDATING' ? 'sw-zoi-tag--neutral' : 'sw-zoi-tag--tested';
        var _dirZoneDesc = { Deep: 'below the swing low', Below: 'below the golden pocket', Pocket: 'inside the golden pocket', Mid: 'mid-range (38\u201362%)', Above: 'shallow pullback zone', Top: 'at/near the swing high' };
        var _dirPivotPx = fb.fibPivotPrice != null ? fpf(fb.fibPivotPrice) : '';
        var _dirBars = fb.fibPivotBarsAgo || 0;
        var _dirTip;
        if (_dirLabel === 'RISING') {
          _dirTip = 'Price bottomed at ' + _dirPivotPx + ' (' + _dirZoneDesc[_dirZone] + ') and has been rising since.\nConfirmed pivot low ' + _dirBars + ' bars ago.\n\n' + (_dirZone === 'Pocket' ? 'Classic golden pocket bounce \u2014 highest-probability entry.' : _dirZone === 'Deep' ? 'Strong recovery from below the swing low \u2014 momentum is up.' : 'Structural uptrend confirmed.');
        } else if (_dirLabel === 'CONSOLIDATING') {
          _dirTip = 'Price is range-bound near ' + _dirPivotPx + ' (last 6 bars).\nConfirmed support at pivot low ' + _dirBars + ' bars ago (' + _dirZoneDesc[_dirZone] + ').\n\nNo clear trend \u2014 wait for breakout.';
        } else {
          _dirTip = 'Price is declining from ' + _dirPivotPx + ' (' + _dirZoneDesc[_dirZone] + ').\nNo confirmed pivot low yet \u2014 the decline has not reversed.\n\nWait for a bottom to form before entering.';
        }
        var volTipF = (fb.volRatio != null)
          ? 'Latest closed-bar volume vs its 20-bar average. ' + fb.volRatio.toFixed(2) + 'x \u2014 ' + (fb.volConfirm ? 'above average, confirms participation.' : 'below average, weak confirmation.')
          : 'No usable volume on this instrument (e.g. an index).';
        var volBarF = (fb.volRatio != null) ? Math.min(100, Math.round(fb.volRatio / 3 * 100)) : 0;
        var volValF = (fb.volRatio != null) ? fb.volRatio.toFixed(1) + 'x avg' : 'n/a';

        var fGroupHtml = '<div class="sw-smc-grouphead">'
          + '<span class="sw-smc-grouphead-title">Fibonacci Retracement</span>'
          + '<span class="sw-smc-grouphead-count">' + (inGP ? 'IN POCKET' : retrace.toFixed(0) + '%') + '</span>'
          + '</div>';

        var fHtml = '<div class="sw-zoi-card sw-zoi-card--fib">'
          + '<div class="sw-zoi-card-head">'
          +   '<span class="sw-zoi-card-type sw-tip" data-tip="' + typeTip + '">Fib Retracement</span>'
          +   '<span class="sw-zoi-card-score ' + fst.cls + ' sw-tip" data-tip="' + sigTip + '">' + fst.sig + '</span>'
          + '</div>'
          + '<div class="sw-zoi-card-range sw-tip" data-tip="' + pocketTip + '">'
          +   'Golden Pocket: ' + fpf(fb.fib786) + ' \u2013 ' + fpf(fb.fib618)
          + '</div>'
          + swRenderVerdictReasoning(_recoVerdict, 'fib')
          + '<div class="sw-zoi-card-pattern">'
          +   '<span class="sw-zoi-tag ' + (inGP ? 'sw-zoi-tag--fresh' : '') + ' sw-tip" data-tip="' + depthTip + '">' + (inGP ? 'IN POCKET' : 'OUTSIDE') + '</span> '
          +   '<span class="sw-zoi-tag ' + _dirCls + ' sw-tip" data-tip="' + _dirTip + '">' + _dirLabel + ' \u00b7 ' + _dirArrow + ' ' + _dirZone + '</span>'
          +   (fb.volConfirm ? ' <span class="sw-zoi-tag sw-zoi-tag--fresh">VOL \u2713</span>' : '')
          +   ' <span class="sw-zoi-pattern-label sw-tip" data-tip="' + fst.desc + '">' + fst.arrow + ' ' + fst.label + '</span>'
          + '</div>'
          + '<div class="sw-zoi-card-metrics">'
          +   '<div class="sw-zoi-metric sw-tip" data-tip="' + depthTip + '">'
          +     '<span class="sw-zoi-metric-label">Depth</span>'
          +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--fib" style="width:' + retraceClamped + '%"></div></div>'
          +     '<span class="sw-zoi-metric-val">' + retrace.toFixed(1) + '%</span>'
          +   '</div>'
          +   '<div class="sw-zoi-metric sw-tip" data-tip="' + volTipF + '">'
          +     '<span class="sw-zoi-metric-label">Volume</span>'
          +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--vol" style="width:' + volBarF + '%"></div></div>'
          +     '<span class="sw-zoi-metric-val">' + volValF + '</span>'
          +   '</div>'
          + '</div>'
          + '<div class="sw-zoi-card-foot">'
          +   '<span class="sw-tip" data-tip="The impulse leg the retracement is measured on (swing low \u2192 swing high).">Leg: ' + fpf(fb.swLow) + ' \u2192 ' + fpf(fb.swHigh) + '</span>'
          +   '<span class="sw-tip" data-tip="Latest close and how far it has retraced into the leg.">Now: ' + fpf(fb.currentPx) + ' (' + retrace.toFixed(0) + '%)</span>'
          + '</div>'
          + '</div>';

        fibPanel.innerHTML = fHtml;

        var fibGroupEl = $('sw-fib-grouphead');
        if (fibGroupEl) { fibGroupEl.hidden = false; fibGroupEl.innerHTML = fGroupHtml; }

        // Reuse the shared themed tooltip element + the same hover pattern
        // as the ZOI / LIQ cards so [data-tip] hints work identically.
        var tipElF = document.getElementById('sw-zoi-tip-global');
        if (!tipElF) {
          tipElF = document.createElement('div');
          tipElF.id = 'sw-zoi-tip-global';
          tipElF.className = 'sw-zoi-tip';
          document.body.appendChild(tipElF);
        }
        var tipTimerF = 0;
        fibPanel.onmouseover = function (e) {
          var tgt = e.target.closest('[data-tip]');
          if (!tgt) { clearTimeout(tipTimerF); tipElF.style.display = 'none'; return; }
          clearTimeout(tipTimerF);
          tipTimerF = setTimeout(function () {
            tipElF.textContent = '';
            var lines = tgt.getAttribute('data-tip').split('\n');
            for (var li = 0; li < lines.length; li++) {
              if (li > 0) tipElF.appendChild(document.createElement('br'));
              tipElF.appendChild(document.createTextNode(lines[li]));
            }
            tipElF.style.display = '';
            var rF = tgt.getBoundingClientRect();
            var lf = rF.left, tp = rF.bottom + 6;
            if (lf + 320 > window.innerWidth) lf = window.innerWidth - 330;
            if (lf < 8) lf = 8;
            if (tp + 200 > window.innerHeight) tp = rF.top - tipElF.offsetHeight - 6;
            tipElF.style.left = lf + 'px';
            tipElF.style.top = tp + 'px';
          }, 300);
        };
        fibPanel.onmouseout = function (e) {
          var tgt = e.target.closest('[data-tip]');
          if (tgt) { clearTimeout(tipTimerF); tipElF.style.display = 'none'; }
        };
      } else {
        fibPanel.hidden = true;
        fibPanel.innerHTML = '';
        var fibGroupEl = $('sw-fib-grouphead');
        if (fibGroupEl) { fibGroupEl.hidden = true; fibGroupEl.innerHTML = ''; }
      }
    }

    _swRelocateSignalDetail();        // FIB_STATE.pendingFib persists across TF switches so the fib
    // lines remain visible as the user flips between 1M / 1W / 1D.
    // It is cleared when the user picks a stock via the sector panel,
    // global search, or scanner (see swingPickSectorStock /
    // swingPickGlobalStock). fibScanPick sets it fresh on each click.

    // ── Zone of Interest (supply / demand) ──
    // Chart RECTANGLES follow the legend chip (STATE.indVisible.zoi); the
    // analysis CARDS follow the Recommendation basis (recoZoi). Compute the
    // zones once if EITHER surface needs them.
    var _zoiRects = [];
    var _zoiUpdate = null;
    var _zoiChip = !!(STATE.indVisible && STATE.indVisible.zoi);
    if (_zoiChip || recoZoi) {
      // Chart rectangles read the CHART-TF zones; the analysis CARDS read
      // the reco-TF zones (decoupled — the chart is just the picture).
      var zoiZonesChart = _zoiChip ? detectZones(raw) : [];
      var zoiZones = recoZoi ? detectZones(recoRaw) : zoiZonesChart;
      if (_zoiChip) {
      for (var zi = 0; zi < zoiZonesChart.length; zi++) {
        var z = zoiZonesChart[zi];
        var isDemand = z.type === 'DEMAND';
        var bg   = isDemand ? 'rgba(34,197,94,0.13)' : 'rgba(239,68,68,0.13)';
        var edge = isDemand ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)';
        var txt  = isDemand ? 'rgba(34,197,94,0.85)' : 'rgba(239,68,68,0.85)';

        var zDiv = document.createElement('div');
        zDiv.className = 'sw-zoi-rect';
        zDiv.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:1;'
          + 'background:' + bg + ';'
          + 'border-top:1px solid ' + edge + ';'
          + 'border-bottom:1px solid ' + edge + ';'
          + 'display:none;';
        var lbl = document.createElement('span');
        lbl.textContent = isDemand ? 'DEMAND ZONE' : 'SUPPLY ZONE';
        lbl.style.cssText = 'position:absolute;left:8px;top:2px;font-size:9px;'
          + 'font-weight:700;letter-spacing:0.5px;color:' + txt + ';'
          + 'text-shadow:0 0 4px var(--bg),0 0 4px var(--bg);';
        zDiv.appendChild(lbl);
        inner.appendChild(zDiv);
        _zoiRects.push({ el: zDiv, proximal: z.proximal, distal: z.distal });
      }

      _zoiUpdate = function () {
        var cw = chart.timeScale().width();
        for (var ri = 0; ri < _zoiRects.length; ri++) {
          var d = _zoiRects[ri];
          var y1 = candleSeries.priceToCoordinate(d.proximal);
          var y2 = candleSeries.priceToCoordinate(d.distal);
          if (y1 === null || y2 === null) { d.el.style.display = 'none'; continue; }
          var top = Math.min(y1, y2);
          var h = Math.abs(y1 - y2);
          // Clamp to the chart's top edge: when the zone extends above the
          // visible range, priceToCoordinate goes negative, which would push
          // the band (and its top-pinned "SUPPLY/DEMAND ZONE" label) up out of
          // the chart and over the toolbar/legend. Trim the off-screen portion
          // instead so the label parks at the top edge, inside the plot.
          if (top < 0) { h += top; top = 0; }
          d.el.style.top = top + 'px';
          d.el.style.height = Math.max(h, 3) + 'px';
          d.el.style.width = cw + 'px';
          d.el.style.display = '';
        }
      };
      _zoiUpdate();
      chart.timeScale().subscribeVisibleLogicalRangeChange(_zoiUpdate);
      // Keep ZOI rectangles glued to price during active drag/pinch via
      // the shared, bound-once rAF driver (see _swBindOverlayInteractions).
      inner._swOverlayUpdaters.push(_zoiUpdate);
      }  // end chart-rectangle drawing (legend-chip gated)

      // Render ZOI justification CARDS — gated on the Recommendation basis,
      // independent of the chart-overlay chip.
      var zoiPanel = $('sw-zoi-cards');
      if (zoiPanel && recoZoi) {
        // Explain absent zones (demand / supply) so the chart never
        // shows "nothing" without a reason. Rendered as a muted card
        // (same shape as a real zone card) above the live cards;
        // built from detectZones' read-only diagnostic.
        var _zoiDiag = zoiZones.diag || null;
        function zoiNoteHtml(reason, kind) {
          if (!reason) return '';
          var label = kind === 'demand' ? 'DEMAND ZONE' : 'SUPPLY ZONE';
          var cls = kind === 'demand' ? 'sw-zoi-card--demand' : 'sw-zoi-card--supply';
          return '<div class="sw-zoi-card ' + cls + ' sw-zoi-card--empty">'
            + '<div class="sw-zoi-card-head">'
            +   '<span class="sw-zoi-card-type">' + label + '</span>'
            +   '<span class="sw-zoi-card-score sw-zoi-card-score--none">NONE</span>'
            + '</div>'
            + '<div class="sw-zoi-card-empty-body">' + reason + '</div>'
            + '</div>';
        }
        // Absence cards, split by side so demand stays first, supply last.
        var demandAbsence = _zoiDiag ? zoiNoteHtml(_zoiDiag.reasonDemand, 'demand') : '';
        var supplyAbsence = _zoiDiag ? zoiNoteHtml(_zoiDiag.reasonSupply, 'supply') : '';
        var zoiHead = '<div class="sw-smc-grouphead">'
          + '<span class="sw-smc-grouphead-title">Supply &amp; Demand Zones</span>'
          + '<span class="sw-smc-grouphead-count">' + zoiZones.length + '</span>'
          + '</div>';
        if (!zoiZones.length) {
          if (demandAbsence || supplyAbsence) {
            zoiPanel.hidden = false;
            zoiPanel.innerHTML = zoiHead + demandAbsence + supplyAbsence;
          } else {
            zoiPanel.hidden = true;
          }
        } else {
          zoiPanel.hidden = false;
          // Demand cards first, then supply; within a type, nearest price first.
          zoiZones.sort(function (a, b) {
            if (a.type !== b.type) return a.type === 'DEMAND' ? -1 : 1;
            return Math.min(a.proximal, a.distal) - Math.min(b.proximal, b.distal);
          });
          // Current price (live LTP if available, else the reco-TF's latest
          // close) — drives the per-zone "where is price now" chip + action
          // line below. Pure display; never feeds a verdict.
          var _zoiPx = (isFinite(R.ltp) && R.ltp) ? R.ltp
            : (recoRaw && recoRaw[0] ? +recoRaw[0][4] : NaN);
          // The buy/wait CALL is sourced from the recommendation verdict (one
          // rule for card + reco) and shown on the NEAREST demand zone only —
          // see the per-card block below. Cards are sorted demand-first /
          // nearest-first, so the first demand card is the verdict's zone.
          var _demandCallShown = false;
          var html = '';
          for (var zci = 0; zci < zoiZones.length; zci++) {
            var zc = zoiZones[zci];
            var isDem = zc.type === 'DEMAND';
            var cls = isDem ? 'sw-zoi-card sw-zoi-card--demand' : 'sw-zoi-card sw-zoi-card--supply';
            var r = zc.reason;
            var fp = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };

            var dispBar = Math.min(100, Math.round(r.dispMultiple / 3 * 100));
            var volBar  = Math.min(100, Math.round(r.volMultiple / 3 * 100));
            var tightBar = Math.max(0, Math.min(100, r.baseTightness));

            var scoreClass = zc.score >= 70 ? 'sw-zoi-score--high'
              : zc.score >= 50 ? 'sw-zoi-score--mid' : 'sw-zoi-score--low';

            var PATTERN_TIPS = {
              RBR: 'Rally \u2192 Base \u2192 Rally: Price rallied, paused (base), then rallied again. The base is where buyers stepped in during a pullback \u2014 unfilled buy orders remain.',
              DBR: 'Drop \u2192 Base \u2192 Rally: Price dropped into this level, paused, then reversed upward. Buyers absorbed all selling here \u2014 strong reversal demand.',
              DBD: 'Drop \u2192 Base \u2192 Drop: Price dropped, paused briefly, then dropped further. Sellers dominated this level \u2014 unfilled sell orders remain.',
              RBD: 'Rally \u2192 Base \u2192 Drop: Price rallied into this level, paused, then reversed downward. Sellers overwhelmed buyers here \u2014 strong reversal supply.'
            };
            var FRESH_TIPS = {
              FRESH: 'FRESH: Price has never returned to this zone since it formed. All unfilled orders are still waiting \u2014 highest probability of reaction.',
              TESTED: 'TESTED: Price has revisited this zone ' + zc.testCount + ' time(s) but didn\'t break through. Each test absorbs some orders \u2014 weaker than fresh.'
            };

            var scoreTip = 'Zone reliability score (0\u2013100).\n\nDisplacement: 0\u201325 pts \u2014 How explosive the departure move was.\nVolume spike: 0\u201320 pts \u2014 Institutional volume confirmation.\nBase tightness: 0\u201320 pts \u2014 Tighter base = more unfilled orders.\nFreshness: 0\u201320 pts \u2014 FRESH = 20, each test loses 5 pts.\nReversal bonus: 0\u201315 pts \u2014 Reversal patterns (DBR/RBD) score higher.\n\nThis zone: ' + zc.score + '/100';
            var typeTip = isDem
              ? 'DEMAND ZONE: A price level where buyers previously overwhelmed sellers with conviction. Unfilled buy orders likely remain \u2014 price tends to bounce up from here.'
              : 'SUPPLY ZONE: A price level where sellers previously overwhelmed buyers with conviction. Unfilled sell orders likely remain \u2014 price tends to drop from here.';
            var rangeTip = 'Zone price range.\nDistal (far edge): ' + fp(isDem ? Math.min(zc.proximal, zc.distal) : Math.max(zc.proximal, zc.distal)) + ' \u2014 liquidity sweep level (wick extreme).\nProximal (near edge): ' + fp(isDem ? Math.max(zc.proximal, zc.distal) : Math.min(zc.proximal, zc.distal)) + ' \u2014 unfilled order level (body edge).';

            // ── WHERE IS PRICE NOW vs this zone (factual) + the CALL ──
            // Position chip = pure geometry (distance to the zone). The
            // actionable buy/wait CALL is the recommendation VERDICT itself
            // (single rule for card + recommendation): mirrored onto the
            // nearest DEMAND zone, so the card can NEVER say "wait for a
            // pullback" while the engine says BUY — the 1–10%-above-demand
            // bounce is Z3 BUY (data/verdict-rules.json), not a "wait" case.
            // Supply zones stay descriptive context (a long-only verdict isn't
            // a call on resistance). APPROACHING = within 3% of the near edge.
            var _zLo = Math.min(zc.proximal, zc.distal);
            var _zHi = Math.max(zc.proximal, zc.distal);
            var _band = fp(_zLo) + ' \u2013 ' + fp(_zHi);
            var _posTag = '', _posCls = '', _distTxt = '';
            if (isFinite(_zoiPx) && _zoiPx > 0) {
              if (_zoiPx >= _zLo && _zoiPx <= _zHi) {
                _posTag = 'PRICE INSIDE'; _posCls = 'sw-zoi-pos--inside';
                _distTxt = 'in the zone now';
              } else if (_zoiPx > _zHi) {
                var _gapA = _zoiPx - _zHi, _gapAp = _gapA / _zoiPx * 100, _nearA = _gapAp <= 3;
                _posTag = _nearA ? 'APPROACHING' : 'PRICE ABOVE';
                _posCls = _nearA ? 'sw-zoi-pos--near' : (isDem ? 'sw-zoi-pos--above' : 'sw-zoi-pos--broken');
                _distTxt = 'zone ' + fp(_gapA) + ' (' + _gapAp.toFixed(1) + '%) below';
              } else {
                var _gapB = _zLo - _zoiPx, _gapBp = _gapB / _zoiPx * 100, _nearB = _gapBp <= 3;
                _posTag = _nearB ? 'APPROACHING' : 'PRICE BELOW';
                _posCls = _nearB ? 'sw-zoi-pos--near' : (isDem ? 'sw-zoi-pos--broken' : 'sw-zoi-pos--below');
                _distTxt = 'zone ' + fp(_gapB) + ' (' + _gapBp.toFixed(1) + '%) above';
              }
            }

            // Trailing CALL after the distance.
            var _callHtml = '', _posTip = '', _isVerdictCard = false;
            if (_posTag) {
              if (isDem && !_demandCallShown && _verdictUsable) {
                _isVerdictCard = true;
                // Mirror the recommendation verdict — ONE source of truth.
                var _vt = _recoVerdict.text;
                var _vWord = (_vt === 'BUY' && _recoVerdict.strongBuy) ? 'STRONG BUY' : _vt;
                var _vCls = (_vt === 'BUY') ? 'sw-zoi-call--buy'
                          : (_vt === 'WAIT' || _vt === 'WATCH') ? 'sw-zoi-call--wait'
                          : (_vt === 'SKIP' || _vt === 'AVOID') ? 'sw-zoi-call--avoid'
                          : 'sw-zoi-call--wait';
                _callHtml = ' \u00b7 <span class="sw-zoi-call ' + _vCls + '">' + _vWord + '</span>';
                _posTip = 'Recommendation for this timeframe: ' + _vWord
                  + (_recoVerdict.sub ? ' \u2014 ' + _recoVerdict.sub : '')
                  + '\n\nThis is the SAME verdict shown on the recommendation \u2014 the zone card never makes a separate call.'
                  + '\n\nPrice ' + fp(_zoiPx) + ' vs zone ' + _band + '.';
                _demandCallShown = true;
              } else {
                // Descriptive context only — no buy/wait call (can't contradict
                // the verdict). Supply = resistance / broken; extra demand = support.
                var _ctx = isDem
                  ? 'support zone'
                  : (_zoiPx != null && _zoiPx > _zHi ? 'broken \u2014 weakening' : 'resistance overhead');
                _callHtml = ' \u2014 <span class="sw-zoi-pos-ctx">' + _ctx + '</span>';
                _posTip = 'Where the current price (' + fp(_zoiPx) + ') sits relative to this zone (' + _band + ').';
              }
            }
            var _posHtml = _posTag
              ? '<div class="sw-zoi-card-pos ' + _posCls + ' sw-tip" data-tip="' + _posTip + '">'
                +   '<span class="sw-zoi-pos-tag">' + _posTag + '</span>'
                +   '<span class="sw-zoi-pos-dist">' + _distTxt + '</span>'
                +   _callHtml
                + '</div>'
              : '';

            // REASONING block: the verdict's card (primary demand) mirrors the
            // recommendation reasoning; every other zone (supply / secondary)
            // gets parallel per-zone context so it never asserts a buy/wait
            // call on resistance.
            var _rsnHtml = _isVerdictCard
              ? swRenderVerdictReasoning(_recoVerdict, 'zoi')
              : swRenderZoneContextReasoning(zc, isDem, _zoiPx);

            var _cardHtml = '<div class="' + cls + '">'
              + '<div class="sw-zoi-card-head">'
              +   '<span class="sw-zoi-card-type sw-tip" data-tip="' + typeTip + '">' + (isDem ? 'DEMAND ZONE' : 'SUPPLY ZONE') + '</span>'
              +   '<span class="sw-zoi-card-score ' + scoreClass + ' sw-tip" data-tip="' + scoreTip + '">' + zc.score + '</span>'
              + '</div>'
              + '<div class="sw-zoi-card-range sw-tip" data-tip="' + rangeTip + '">'
              +   fp(Math.min(zc.proximal, zc.distal)) + ' \u2013 ' + fp(Math.max(zc.proximal, zc.distal))
              + '</div>'
              + _posHtml
              + _rsnHtml
              + '<div class="sw-zoi-card-pattern">'
              +   '<span class="sw-zoi-tag sw-tip" data-tip="' + (PATTERN_TIPS[zc.pattern] || '') + '">' + zc.pattern + '</span> '
              +   '<span class="sw-zoi-tag sw-zoi-tag--' + zc.freshness.toLowerCase() + ' sw-tip" data-tip="' + (FRESH_TIPS[zc.freshness] || '') + '">'
              +     zc.freshness + (zc.testCount ? ' (' + zc.testCount + 'x)' : '')
              +   '</span>'
              +   ' <span class="sw-zoi-pattern-label sw-tip" data-tip="' + (PATTERN_TIPS[zc.pattern] || '') + '">' + zc.patternLabel + '</span>'
              + '</div>'
              + '<div class="sw-zoi-card-metrics">'
              +   '<div class="sw-zoi-metric sw-tip" data-tip="How explosive the departure move was relative to Average True Range (ATR).\n' + r.dispMultiple + 'x ATR = the leg-out moved ' + r.dispMultiple + ' times the average candle range.\nHigher = stronger institutional conviction. Scores up to 25 pts.">'
              +     '<span class="sw-zoi-metric-label">Displacement</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--disp" style="width:' + dispBar + '%"></div></div>'
              +     '<span class="sw-zoi-metric-val">' + r.dispMultiple + 'x ATR</span>'
              +   '</div>'
              +   '<div class="sw-zoi-metric sw-tip" data-tip="Peak volume on the leg-out candles vs 20-bar average volume.\n' + r.volMultiple + 'x avg = volume was ' + r.volMultiple + ' times normal.\nHigh volume confirms institutional participation. Scores up to 20 pts.">'
              +     '<span class="sw-zoi-metric-label">Volume spike</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--vol" style="width:' + volBar + '%"></div></div>'
              +     '<span class="sw-zoi-metric-val">' + r.volMultiple + 'x avg</span>'
              +   '</div>'
              +   '<div class="sw-zoi-metric sw-tip" data-tip="How tight the consolidation (base) was relative to ATR.\n' + tightBar + '% = tighter is better.\nA tight base means price barely moved during the pause \u2014 unfilled orders are concentrated in a narrow range. Scores up to 20 pts.">'
              +     '<span class="sw-zoi-metric-label">Base tightness</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--tight" style="width:' + tightBar + '%"></div></div>'
              +     '<span class="sw-zoi-metric-val">' + tightBar + '%</span>'
              +   '</div>'
              + '</div>'
              + '<div class="sw-zoi-card-foot">'
              +   '<span class="sw-tip" data-tip="Number of candles in the departure move and the total price displacement.">Leg-out: ' + r.legOutBars + ' bar' + (r.legOutBars > 1 ? 's' : '') + ', ' + fp(r.legOutDisp) + ' move</span>'
              +   '<span class="sw-tip" data-tip="Number of candles in the consolidation (pause) that forms the zone.">Base: ' + r.baseBars + ' bar' + (r.baseBars > 1 ? 's' : '') + '</span>'
              + '</div>'
              + '</div>';

            html += _cardHtml;
          }

          // All detected zones are shown (no history bucket) — near or far,
          // fresh or tested. The count reflects every zone on display.
          var _zoiHead = '<div class="sw-smc-grouphead">'
            + '<span class="sw-smc-grouphead-title">Supply &amp; Demand Zones</span>'
            + '<span class="sw-smc-grouphead-count">' + zoiZones.length + '</span>'
            + '</div>';
          zoiPanel.innerHTML = _zoiHead + demandAbsence + html + supplyAbsence;

          // Custom themed tooltip for [data-tip] elements.
          // Appended to body so it's never clipped by overflow.
          var tipEl = document.getElementById('sw-zoi-tip-global');
          if (!tipEl) {
            tipEl = document.createElement('div');
            tipEl.id = 'sw-zoi-tip-global';
            tipEl.className = 'sw-zoi-tip';
            document.body.appendChild(tipEl);
          }
          tipEl.style.display = 'none';
          var tipTimer = 0;
          zoiPanel.addEventListener('mouseover', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (!tgt) { clearTimeout(tipTimer); tipEl.style.display = 'none'; return; }
            clearTimeout(tipTimer);
            tipTimer = setTimeout(function () {
              tipEl.textContent = '';
              var lines = tgt.getAttribute('data-tip').split('\\n');
              for (var li = 0; li < lines.length; li++) {
                if (li > 0) tipEl.appendChild(document.createElement('br'));
                tipEl.appendChild(document.createTextNode(lines[li]));
              }
              tipEl.style.display = '';
              var r = tgt.getBoundingClientRect();
              var left = r.left;
              var top = r.bottom + 6;
              if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
              if (left < 8) left = 8;
              if (top + 200 > window.innerHeight) top = r.top - tipEl.offsetHeight - 6;
              tipEl.style.left = left + 'px';
              tipEl.style.top = top + 'px';
            }, 300);
          });
          zoiPanel.addEventListener('mouseout', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (tgt) { clearTimeout(tipTimer); tipEl.style.display = 'none'; }
          });
        }
      } else if (zoiPanel) {
        // Chip on (rects drawn) but ZOI not part of the chosen basis — hide cards.
        zoiPanel.hidden = true; zoiPanel.innerHTML = '';
      }
    } else {
      var zoiPanelOff = $('sw-zoi-cards');
      if (zoiPanelOff) { zoiPanelOff.hidden = true; zoiPanelOff.innerHTML = ''; }
    }

    // ── Fair Value Gaps (FVG filled rectangles) ──
    var _fvgRects = [];
    var _fvgUpdate = null;
    if (STATE.indVisible && STATE.indVisible.fvg) {
      var fvgGaps = detectFVG(raw);
      for (var fi = 0; fi < fvgGaps.length; fi++) {
        var fg = fvgGaps[fi];
        var isBull = fg.type === 'BULL';
        var fBg   = isBull ? 'rgba(59,130,246,0.12)' : 'rgba(251,146,60,0.12)';
        var fEdge = isBull ? 'rgba(59,130,246,0.40)' : 'rgba(251,146,60,0.40)';
        var fTxt  = isBull ? 'rgba(59,130,246,0.80)' : 'rgba(251,146,60,0.80)';

        var fDiv = document.createElement('div');
        fDiv.className = 'sw-fvg-rect';
        fDiv.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:1;'
          + 'background:' + fBg + ';'
          + 'border-top:1px dashed ' + fEdge + ';'
          + 'border-bottom:1px dashed ' + fEdge + ';'
          + 'display:none;';
        var fLbl = document.createElement('span');
        fLbl.textContent = 'FVG';
        fLbl.style.cssText = 'position:absolute;left:8px;top:1px;font-size:8px;'
          + 'font-weight:700;letter-spacing:0.5px;color:' + fTxt + ';'
          + 'text-shadow:0 0 4px var(--bg),0 0 4px var(--bg);';
        fDiv.appendChild(fLbl);
        inner.appendChild(fDiv);
        _fvgRects.push({ el: fDiv, top: fg.top, bottom: fg.bottom });
      }

      _fvgUpdate = function () {
        var cw = chart.timeScale().width();
        for (var ri = 0; ri < _fvgRects.length; ri++) {
          var d = _fvgRects[ri];
          var y1 = candleSeries.priceToCoordinate(d.top);
          var y2 = candleSeries.priceToCoordinate(d.bottom);
          if (y1 === null || y2 === null) { d.el.style.display = 'none'; continue; }
          var top2 = Math.min(y1, y2);
          var h2 = Math.abs(y1 - y2);
          // Clamp to the chart's top edge (see ZOI updater) so the FVG band +
          // its label never ride up into the toolbar/legend on zoom.
          if (top2 < 0) { h2 += top2; top2 = 0; }
          d.el.style.top = top2 + 'px';
          d.el.style.height = Math.max(h2, 2) + 'px';
          d.el.style.width = cw + 'px';
          d.el.style.display = '';
        }
      };
      _fvgUpdate();
      chart.timeScale().subscribeVisibleLogicalRangeChange(_fvgUpdate);
      inner._swOverlayUpdaters.push(_fvgUpdate);

      // FVG justification cards
      var fvgPanel = $('sw-fvg-cards');
      if (fvgPanel) {
        if (!fvgGaps.length) {
          fvgPanel.hidden = true;
        } else {
          fvgPanel.hidden = false;
          fvgGaps.sort(function (a, b) { return Math.min(a.top, a.bottom) - Math.min(b.top, b.bottom); });
          var fhtml = '<div class="sw-smc-grouphead">'
            + '<span class="sw-smc-grouphead-title">Fair Value Gaps</span>'
            + '<span class="sw-smc-grouphead-count">' + fvgGaps.length + '</span>'
            + '</div>';
          var fp2 = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
          for (var fci = 0; fci < fvgGaps.length; fci++) {
            var fc = fvgGaps[fci];
            var isBullC = fc.type === 'BULL';
            var fcCls = isBullC ? 'sw-smc-card sw-smc-card--bull-fvg' : 'sw-smc-card sw-smc-card--bear-fvg';
            var typeTip = isBullC
              ? 'BULLISH FVG: A gap where price moved up so fast that buy orders went unfilled. Price tends to retrace down into this gap before continuing higher.'
              : 'BEARISH FVG: A gap where price moved down so fast that sell orders went unfilled. Price tends to retrace up into this gap before continuing lower.';
            var fillTip = 'Fill percentage: how much of the gap has been closed by subsequent price action.\n0% = completely unfilled (strongest).\n50%+ = partially filled (weaker).\n90%+ = mitigated (discarded).';
            var atrTip = 'Gap size relative to ATR-14.\nLarger gaps (>1.0x ATR) indicate stronger institutional moves.\nSmall gaps (<0.5x ATR) may be noise.';
            var scoreTip = 'FVG quality score (0\u2013100).\n\nGap size vs ATR: 0\u201330 pts.\nFreshness bonus: 0\u201320 pts (unfilled = 20, partial = 10).\nRecency bonus: 0\u201315 pts (recent FVGs score higher).';

            var fillBar = Math.min(100, fc.fillPct);

            fhtml += '<div class="' + fcCls + '">'
              + '<div class="sw-smc-card-head">'
              +   '<span class="sw-smc-card-type sw-tip" data-tip="' + typeTip + '">' + (isBullC ? 'BULLISH FVG' : 'BEARISH FVG') + '</span>'
              +   '<span class="sw-smc-card-score sw-tip" data-tip="' + scoreTip + '">' + fc.score + '</span>'
              + '</div>'
              + '<div class="sw-smc-card-range sw-tip" data-tip="Price range of the fair value gap.\nTop: ' + fp2(fc.top) + '\nBottom: ' + fp2(fc.bottom) + '\nGap size: ' + fp2(fc.gapSize) + '">'
              +   fp2(Math.min(fc.top, fc.bottom)) + ' \u2013 ' + fp2(Math.max(fc.top, fc.bottom))
              + '</div>'
              + '<div class="sw-smc-card-metrics">'
              +   '<div class="sw-smc-metric sw-tip" data-tip="' + fillTip + '">'
              +     '<span class="sw-smc-metric-label">Fill %</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--tight" style="width:' + fillBar + '%"></div></div>'
              +     '<span class="sw-smc-metric-val">' + fc.fillPct + '%</span>'
              +   '</div>'
              +   '<div class="sw-smc-metric sw-tip" data-tip="' + atrTip + '">'
              +     '<span class="sw-smc-metric-label">Gap / ATR</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--disp" style="width:' + Math.min(100, Math.round(fc.atrRatio / 2 * 100)) + '%"></div></div>'
              +     '<span class="sw-smc-metric-val">' + fc.atrRatio + 'x</span>'
              +   '</div>'
              + '</div>'
              + '</div>';
          }

          fvgPanel.innerHTML = fhtml;

          var tipEl2 = document.getElementById('sw-smc-tip-global');
          if (!tipEl2) {
            tipEl2 = document.createElement('div');
            tipEl2.id = 'sw-smc-tip-global';
            tipEl2.className = 'sw-zoi-tip';
            document.body.appendChild(tipEl2);
          }
          tipEl2.style.display = 'none';
          var tipTimer2 = 0;
          fvgPanel.addEventListener('mouseover', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (!tgt) { clearTimeout(tipTimer2); tipEl2.style.display = 'none'; return; }
            clearTimeout(tipTimer2);
            tipTimer2 = setTimeout(function () {
              tipEl2.textContent = '';
              var lines = tgt.getAttribute('data-tip').split('\\n');
              for (var li = 0; li < lines.length; li++) {
                if (li > 0) tipEl2.appendChild(document.createElement('br'));
                tipEl2.appendChild(document.createTextNode(lines[li]));
              }
              tipEl2.style.display = '';
              var r = tgt.getBoundingClientRect();
              var left = r.left;
              var top3 = r.bottom + 6;
              if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
              if (left < 8) left = 8;
              if (top3 + 200 > window.innerHeight) top3 = r.top - tipEl2.offsetHeight - 6;
              tipEl2.style.left = left + 'px';
              tipEl2.style.top = top3 + 'px';
            }, 300);
          });
          fvgPanel.addEventListener('mouseout', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (tgt) { clearTimeout(tipTimer2); tipEl2.style.display = 'none'; }
          });
        }
      }
    } else {
      var fvgPanelOff = $('sw-fvg-cards');
      if (fvgPanelOff) { fvgPanelOff.hidden = true; fvgPanelOff.innerHTML = ''; }
    }

    // ── Order Blocks (OB filled rectangles + cards) ──
    // Both the chart band and the cards are gated on the legend chip
    // (STATE.indVisible.ob). OB is currently a VISUAL / confluence tool —
    // it does NOT feed the verdict basis, so (unlike ZOI) it has no
    // reco-TF decoupling. Bands are full-width price zones, same as FVG/ZOI.
    var _obRects = [];
    var _obUpdate = null;
    if (STATE.indVisible && STATE.indVisible.ob) {
      var obBlocks = detectOrderBlocks(raw, tf);
      for (var obi = 0; obi < obBlocks.length; obi++) {
        var ob = obBlocks[obi];
        var obBull = ob.type === 'BULL';
        var oBg   = obBull ? 'rgba(20,184,166,0.13)' : 'rgba(217,70,239,0.13)';
        var oEdge = obBull ? 'rgba(20,184,166,0.55)' : 'rgba(217,70,239,0.55)';
        var oTxt  = obBull ? 'rgba(20,184,166,0.90)' : 'rgba(217,70,239,0.90)';

        var oDiv = document.createElement('div');
        oDiv.className = 'sw-ob-rect';
        oDiv.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:1;'
          + 'background:' + oBg + ';'
          + 'border-top:1px solid ' + oEdge + ';'
          + 'border-bottom:1px solid ' + oEdge + ';'
          + 'display:none;';
        var oLbl = document.createElement('span');
        oLbl.textContent = (obBull ? 'BULL OB' : 'BEAR OB')
          + (ob.freshness === 'FRESH' ? '' : ' \u00b7 USED');
        oLbl.style.cssText = 'position:absolute;left:8px;top:1px;font-size:8px;'
          + 'font-weight:700;letter-spacing:0.5px;color:' + oTxt + ';'
          + 'text-shadow:0 0 4px var(--bg),0 0 4px var(--bg);';
        oDiv.appendChild(oLbl);
        inner.appendChild(oDiv);
        _obRects.push({ el: oDiv, proximal: ob.proximal, distal: ob.distal });
      }

      _obUpdate = function () {
        var cw = chart.timeScale().width();
        for (var ri = 0; ri < _obRects.length; ri++) {
          var d = _obRects[ri];
          var y1 = candleSeries.priceToCoordinate(d.proximal);
          var y2 = candleSeries.priceToCoordinate(d.distal);
          if (y1 === null || y2 === null) { d.el.style.display = 'none'; continue; }
          var top = Math.min(y1, y2);
          var h = Math.abs(y1 - y2);
          // Clamp to the chart's top edge (see ZOI updater) so the OB band +
          // its label never ride up into the toolbar/legend on zoom.
          if (top < 0) { h += top; top = 0; }
          d.el.style.top = top + 'px';
          d.el.style.height = Math.max(h, 2) + 'px';
          d.el.style.width = cw + 'px';
          d.el.style.display = '';
        }
      };
      _obUpdate();
      chart.timeScale().subscribeVisibleLogicalRangeChange(_obUpdate);
      inner._swOverlayUpdaters.push(_obUpdate);

      // OB justification cards
      var obPanel = $('sw-ob-cards');
      if (obPanel) {
        if (!obBlocks.length) {
          obPanel.hidden = true; obPanel.innerHTML = '';
        } else {
          obPanel.hidden = false;
          obBlocks.sort(function (a, b) {
            if (a.type !== b.type) return a.type === 'BULL' ? -1 : 1;
            return Math.min(a.proximal, a.distal) - Math.min(b.proximal, b.distal);
          });
          var ohtml = '<div class="sw-smc-grouphead">'
            + '<span class="sw-smc-grouphead-title">Order Blocks</span>'
            + '<span class="sw-smc-grouphead-count">' + obBlocks.length + '</span>'
            + '</div>';
          var ofp = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
          for (var oci = 0; oci < obBlocks.length; oci++) {
            var oc = obBlocks[oci];
            var ocBull = oc.type === 'BULL';
            var ocCls = ocBull ? 'sw-smc-card sw-smc-card--bull-ob' : 'sw-smc-card sw-smc-card--bear-ob';
            var oTypeTip = ocBull
              ? 'A price zone where big buyers stepped in before a strong move up. When price comes back down to it, it often bounces. A spot to look for a buy \u2014 with your stop just below the zone.'
              : 'A price zone where big sellers stepped in before a strong move down. When price comes back up to it, it often gets rejected. A spot to look for a sell or take profit \u2014 with your stop just above the zone.';
            var oFreshTip = oc.freshness === 'FRESH'
              ? 'Fresh: price has not come back to this zone yet, so it is the strongest \u2014 the orders are still waiting there.'
              : 'Used: price has already tapped this zone ' + oc.mitigations + ' time(s), so it is weaker than a fresh one.';
            var oBreakTip = oc.breakType === 'BOS'
              ? 'The move out of this zone went WITH the trend \u2014 more reliable.'
              : 'The move out of this zone FLIPPED the trend \u2014 an earlier signal, but higher risk.';
            var oScoreTip = 'How strong this zone is, from 0 to 100. Higher means a stronger move out of the zone, still fresh, and backed by a price gap. Only zones scoring 40 or more are shown.\n\nThis zone: ' + oc.score + ' out of 100.';
            var oFvgTip = oc.fvgConfirmed
              ? 'There is a price gap inside the move out of this zone \u2014 extra confirmation that big money was active.'
              : 'No price gap inside the move \u2014 still a valid zone, just without the extra confirmation.';

            var oScoreClass = oc.score >= 70 ? 'sw-zoi-score--high'
              : oc.score >= 55 ? 'sw-zoi-score--mid' : 'sw-zoi-score--low';
            var oDispBar = Math.min(100, Math.round(oc.reason.dispMultiple / 3 * 100));

            ohtml += '<div class="' + ocCls + '">'
              + '<div class="sw-smc-card-head">'
              +   '<span class="sw-smc-card-type sw-tip" data-tip="' + oTypeTip + '">' + (ocBull ? 'BULLISH OB' : 'BEARISH OB') + '</span>'
              +   '<span class="sw-smc-card-score ' + oScoreClass + ' sw-tip" data-tip="' + oScoreTip + '">' + oc.score + '</span>'
              + '</div>'
              + '<div class="sw-smc-card-range sw-tip" data-tip="The price range of this zone.\nEntry edge (where price enters): ' + ofp(oc.proximal) + '\nStop edge (put your stop past this): ' + ofp(oc.distal) + '">'
              +   ofp(Math.min(oc.proximal, oc.distal)) + ' \u2013 ' + ofp(Math.max(oc.proximal, oc.distal))
              + '</div>'
              + '<div class="sw-zoi-card-pattern">'
              +   '<span class="sw-zoi-tag sw-tip" data-tip="' + oBreakTip + '">' + (oc.breakType === 'BOS' ? 'with trend' : 'trend flip') + '</span> '
              +   '<span class="sw-zoi-tag sw-zoi-tag--' + oc.freshness.toLowerCase() + ' sw-tip" data-tip="' + oFreshTip + '">'
              +     (oc.freshness === 'FRESH' ? 'FRESH' : 'USED') + (oc.mitigations ? ' (' + oc.mitigations + 'x)' : '') + '</span> '
              +   '<span class="sw-zoi-tag sw-ob-fvg-tag' + (oc.fvgConfirmed ? ' sw-ob-fvg-tag--on' : '') + ' sw-tip" data-tip="' + oFvgTip + '">'
              +     (oc.fvgConfirmed ? '+ price gap' : 'no gap') + '</span>'
              + '</div>'
              + '<div class="sw-smc-card-metrics">'
              +   '<div class="sw-smc-metric sw-tip" data-tip="How strong the move out of this zone was. A bigger move means big money was more aggressive, which makes the zone more reliable.">'
              +     '<span class="sw-smc-metric-label">Move strength</span>'
              +     '<div class="sw-zoi-bar-wrap"><div class="sw-zoi-bar sw-zoi-bar--disp" style="width:' + oDispBar + '%"></div></div>'
              +     '<span class="sw-smc-metric-val">' + oc.reason.dispMultiple + '\u00d7</span>'
              +   '</div>'
              + '</div>'
              + '</div>';
          }
          obPanel.innerHTML = ohtml;

          var tipEl3 = document.getElementById('sw-ob-tip-global');
          if (!tipEl3) {
            tipEl3 = document.createElement('div');
            tipEl3.id = 'sw-ob-tip-global';
            tipEl3.className = 'sw-zoi-tip';
            document.body.appendChild(tipEl3);
          }
          tipEl3.style.display = 'none';
          var tipTimer3 = 0;
          obPanel.addEventListener('mouseover', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (!tgt) { clearTimeout(tipTimer3); tipEl3.style.display = 'none'; return; }
            clearTimeout(tipTimer3);
            tipTimer3 = setTimeout(function () {
              tipEl3.textContent = '';
              var lines = tgt.getAttribute('data-tip').split('\\n');
              for (var li = 0; li < lines.length; li++) {
                if (li > 0) tipEl3.appendChild(document.createElement('br'));
                tipEl3.appendChild(document.createTextNode(lines[li]));
              }
              tipEl3.style.display = '';
              var r = tgt.getBoundingClientRect();
              var left = r.left;
              var top = r.bottom + 6;
              if (left + 320 > window.innerWidth) left = window.innerWidth - 330;
              if (left < 8) left = 8;
              if (top + 200 > window.innerHeight) top = r.top - tipEl3.offsetHeight - 6;
              tipEl3.style.left = left + 'px';
              tipEl3.style.top = top + 'px';
            }, 300);
          });
          obPanel.addEventListener('mouseout', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (tgt) { clearTimeout(tipTimer3); tipEl3.style.display = 'none'; }
          });
        }
      }
    } else {
      var obPanelOff = $('sw-ob-cards');
      if (obPanelOff) { obPanelOff.hidden = true; obPanelOff.innerHTML = ''; }
    }

    // ── BOS / CHoCH (structure break lines + swing markers) ──
    var _bosEls = [];
    var _bosUpdate = null;
    if (STATE.indVisible && STATE.indVisible.bos) {
      var bosData = detectStructureBreaks(raw, { pivot: BOS_PIVOT_BY_TF[tf] || 5 });
      var bosBreaks = bosData.breaks;
      var bosSwings = bosData.swings;
      var bosTrend = recentSwingTrend(bosData);

      // Trend badge in chart status
      var statusEl = $('sw-chart-status');
      if (statusEl) {
        var trendCls = bosTrend === 'BULLISH' ? 'sw-trend--bull'
          : bosTrend === 'BEARISH' ? 'sw-trend--bear' : 'sw-trend--range';
        var trendArrow = bosTrend === 'BULLISH' ? '\u25B2'
          : bosTrend === 'BEARISH' ? '\u25BC' : '\u25C6';
        statusEl.innerHTML = '<span class="sw-trend-badge ' + trendCls + '">'
          + trendArrow + ' ' + bosTrend + '</span>';
      }

      // Render swing markers (small labels at swing points)
      var visibleSwings = bosSwings.slice(-10);
      for (var swi = 0; swi < visibleSwings.length; swi++) {
        var vsw = visibleSwings[swi];
        var isHighSwing = vsw.kind === 'HIGH';
        var swDiv = document.createElement('div');
        swDiv.className = 'sw-bos-swing';
        var swColor = (vsw.type === 'HH' || vsw.type === 'HL') ? 'rgba(34,197,94,0.75)' : 'rgba(239,68,68,0.75)';
        swDiv.style.cssText = 'position:absolute;pointer-events:none;z-index:2;'
          + 'font-size:8px;font-weight:700;color:' + swColor + ';'
          + 'text-shadow:0 0 3px var(--bg),0 0 3px var(--bg);display:none;';
        swDiv.textContent = vsw.type;
        swDiv.setAttribute('data-price', vsw.price);
        swDiv.setAttribute('data-bar', vsw.barIdx);
        swDiv.setAttribute('data-pos', isHighSwing ? 'above' : 'below');
        inner.appendChild(swDiv);
        // Map the pivot's bar index (index into detectStructureBreaks'
        // oldest-first reversed array) back to its raw candle, then to the
        // chart's time, so the label can sit on its actual candle.
        var _swRaw = raw[raw.length - 1 - vsw.barIdx];
        var _swTime = _swRaw ? candleTime(_swRaw[0], tf) : null;
        _bosEls.push({ el: swDiv, price: vsw.price, barIdx: vsw.barIdx, time: _swTime, pos: isHighSwing ? 'above' : 'below' });
      }

      // Render break lines (horizontal dashed lines with BOS/CHoCH label)
      var visibleBreaks = bosBreaks.slice(-5);
      for (var bki = 0; bki < visibleBreaks.length; bki++) {
        var brk = visibleBreaks[bki];
        var isBos = brk.type === 'BOS';
        var isBullBrk = brk.direction === 'BULL';
        var brkColor = isBos
          ? (isBullBrk ? 'rgba(34,197,94,0.60)' : 'rgba(239,68,68,0.60)')
          : (isBullBrk ? 'rgba(234,179,8,0.70)' : 'rgba(192,38,211,0.70)');
        var brkDiv = document.createElement('div');
        brkDiv.className = 'sw-bos-line';
        brkDiv.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:2;'
          + 'height:0;border-top:1.5px dashed ' + brkColor + ';display:none;';
        var brkLbl = document.createElement('span');
        brkLbl.textContent = (isBos ? 'BOS' : 'CHoCH') + ' ' + brk.direction;
        brkLbl.style.cssText = 'position:absolute;right:8px;top:-12px;font-size:9px;'
          + 'font-weight:700;color:' + brkColor + ';'
          + 'text-shadow:0 0 3px var(--bg),0 0 3px var(--bg);';
        brkDiv.appendChild(brkLbl);
        inner.appendChild(brkDiv);
        _bosEls.push({ el: brkDiv, price: brk.level, isLine: true });
      }

      _bosUpdate = function () {
        var cw = chart.timeScale().width();
        // Track already-placed swing labels so we can nudge a new one
        // vertically when it would collide with a nearby one (keeps
        // HH/HL/LH/LL readable where pivots cluster together).
        var placed = [];
        var XGAP = 22, YGAP = 11, STEP = 11;
        function collides(x, t) {
          for (var p = 0; p < placed.length; p++) {
            if (Math.abs(placed[p].x - x) < XGAP && Math.abs(placed[p].top - t) < YGAP) return true;
          }
          return false;
        }
        for (var bi2 = 0; bi2 < _bosEls.length; bi2++) {
          var be = _bosEls[bi2];
          var py = candleSeries.priceToCoordinate(be.price);
          if (py === null) { be.el.style.display = 'none'; continue; }
          if (be.isLine) {
            be.el.style.top = py + 'px';
            be.el.style.width = cw + 'px';
            be.el.style.display = '';
          } else {
            var offset = be.pos === 'above' ? -14 : 4;
            // Place the label on its own candle (time → x). Hide it when
            // that bar is scrolled out of the visible range.
            var bx = be.time != null ? chart.timeScale().timeToCoordinate(be.time) : null;
            if (bx === null) { be.el.style.display = 'none'; continue; }
            var top = py + offset;
            // Nudge in the label's own direction (above = up, below = down)
            // until it clears already-placed neighbours.
            var dir = be.pos === 'above' ? -1 : 1;
            var guard = 0;
            while (collides(bx, top) && guard++ < 12) top += dir * STEP;
            placed.push({ x: bx, top: top });
            be.el.style.left = bx + 'px';
            be.el.style.transform = 'translateX(-50%)';
            be.el.style.top = top + 'px';
            be.el.style.display = '';
          }
        }
      };
      _bosUpdate();
      chart.timeScale().subscribeVisibleLogicalRangeChange(_bosUpdate);
      inner._swOverlayUpdaters.push(_bosUpdate);

      // BOS/CHoCH summary card
      var bosPanel = $('sw-bos-cards');
      if (bosPanel) {
        if (!bosBreaks.length) {
          bosPanel.hidden = true;
        } else {
          bosPanel.hidden = false;
          var bhtml = '<div class="sw-smc-card sw-smc-card--bos">';
          bhtml += '<div class="sw-smc-card-head">'
            + '<span class="sw-smc-card-type sw-tip" data-tip="Market structure analysis based on swing highs and swing lows.\nBOS = Break of Structure (trend continuation).\nCHoCH = Change of Character (trend reversal).">MARKET STRUCTURE</span>'
            + '<span class="sw-trend-badge ' + trendCls + ' sw-tip" data-tip="Current trend determined by the sequence of swing highs and lows.\nBULLISH = Higher Highs + Higher Lows.\nBEARISH = Lower Highs + Lower Lows.\nRANGING = Mixed / no clear direction.">'
            + trendArrow + ' ' + bosTrend + '</span>'
            + '</div>';

          bhtml += '<div class="sw-bos-breaks">';
          var recentBreaks = bosBreaks.slice(-5).reverse();
          for (var rbi = 0; rbi < recentBreaks.length; rbi++) {
            var rb = recentBreaks[rbi];
            var rbIsBos = rb.type === 'BOS';
            var rbIsBull = rb.direction === 'BULL';
            var rbCls = rbIsBos
              ? (rbIsBull ? 'sw-bos-tag--bull-bos' : 'sw-bos-tag--bear-bos')
              : (rbIsBull ? 'sw-bos-tag--bull-choch' : 'sw-bos-tag--bear-choch');
            var rbArrow = rbIsBull ? '\u25B2' : '\u25BC';
            var rbTip = rbIsBos
              ? 'BOS (' + rb.direction + '): Price broke past swing ' + (rbIsBull ? 'high' : 'low') + ' at ' + rb.level.toFixed(2) + ', confirming trend continuation.'
              : 'CHoCH (' + rb.direction + '): Price broke past swing ' + (rbIsBull ? 'high' : 'low') + ' at ' + rb.level.toFixed(2) + ', signalling potential trend reversal.';
            bhtml += '<span class="sw-bos-tag ' + rbCls + ' sw-tip" data-tip="' + rbTip + '">'
              + rbArrow + ' ' + rb.type + ' @ \u20B9' + rb.level.toFixed(2)
              + '</span>';
          }
          bhtml += '</div>';

          // Swing sequence
          var recentSwings = bosSwings.slice(-8);
          if (recentSwings.length) {
            bhtml += '<div class="sw-bos-swings">';
            for (var rsi = 0; rsi < recentSwings.length; rsi++) {
              var rs = recentSwings[rsi];
              var rsUp = rs.type === 'HH' || rs.type === 'HL';
              bhtml += '<span class="sw-bos-swing-tag ' + (rsUp ? 'sw-bos-swing--up' : 'sw-bos-swing--down') + ' sw-tip" data-tip="' + rs.type + ' at \u20B9' + rs.price.toFixed(2) + '">'
                + rs.type + '</span>';
              if (rsi < recentSwings.length - 1) bhtml += '<span class="sw-bos-arrow">\u2192</span>';
            }
            bhtml += '</div>';
          }

          bhtml += '</div>';

          bosPanel.innerHTML = bhtml;

          // Reuse the SMC tooltip handler
          var tipEl3 = document.getElementById('sw-smc-tip-global');
          if (!tipEl3) {
            tipEl3 = document.createElement('div');
            tipEl3.id = 'sw-smc-tip-global';
            tipEl3.className = 'sw-zoi-tip';
            document.body.appendChild(tipEl3);
          }
          var tipTimer3 = 0;
          bosPanel.addEventListener('mouseover', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (!tgt) { clearTimeout(tipTimer3); tipEl3.style.display = 'none'; return; }
            clearTimeout(tipTimer3);
            tipTimer3 = setTimeout(function () {
              tipEl3.textContent = '';
              var lines = tgt.getAttribute('data-tip').split('\\n');
              for (var li = 0; li < lines.length; li++) {
                if (li > 0) tipEl3.appendChild(document.createElement('br'));
                tipEl3.appendChild(document.createTextNode(lines[li]));
              }
              tipEl3.style.display = '';
              var r2 = tgt.getBoundingClientRect();
              var left2 = r2.left;
              var top4 = r2.bottom + 6;
              if (left2 + 320 > window.innerWidth) left2 = window.innerWidth - 330;
              if (left2 < 8) left2 = 8;
              if (top4 + 200 > window.innerHeight) top4 = r2.top - tipEl3.offsetHeight - 6;
              tipEl3.style.left = left2 + 'px';
              tipEl3.style.top = top4 + 'px';
            }, 300);
          });
          bosPanel.addEventListener('mouseout', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (tgt) { clearTimeout(tipTimer3); tipEl3.style.display = 'none'; }
          });
        }
      }
    } else {
      var bosPanelOff = $('sw-bos-cards');
      if (bosPanelOff) { bosPanelOff.hidden = true; bosPanelOff.innerHTML = ''; }
      var statusElOff = $('sw-chart-status');
      if (statusElOff) statusElOff.innerHTML = '&mdash;';
    }

    // ── Liquidity Sweeps (level lines + sweep markers) ──
    var _liqEls = [];
    var _liqUpdate = null;
    if (STATE.indVisible && STATE.indVisible.liq) {
      var liqSweeps = detectLiqSweeps(raw);

      for (var li2 = 0; li2 < liqSweeps.length; li2++) {
        var lsw = liqSweeps[li2];
        var isHigh = lsw.type === 'SWEEP_HIGH';
        var lColor = 'rgba(245,158,11,0.55)';
        var sColor = isHigh ? 'rgba(239,68,68,0.80)' : 'rgba(34,197,94,0.80)';

        // Liquidity level line
        var lDiv = document.createElement('div');
        lDiv.className = 'sw-liq-line';
        lDiv.style.cssText = 'position:absolute;left:0;pointer-events:none;z-index:2;'
          + 'height:0;border-top:1px dotted ' + lColor + ';display:none;';
        var lLbl = document.createElement('span');
        lLbl.textContent = '$$$';
        lLbl.style.cssText = 'position:absolute;right:8px;top:-11px;font-size:8px;'
          + 'font-weight:700;color:' + lColor + ';'
          + 'text-shadow:0 0 3px var(--bg),0 0 3px var(--bg);';
        lDiv.appendChild(lLbl);
        inner.appendChild(lDiv);
        _liqEls.push({ el: lDiv, price: lsw.level, isLine: true });

        // Sweep marker (X at the wick tip)
        var sDiv = document.createElement('div');
        sDiv.className = 'sw-liq-sweep';
        sDiv.style.cssText = 'position:absolute;pointer-events:none;z-index:2;'
          + 'font-size:10px;font-weight:900;color:' + sColor + ';'
          + 'text-shadow:0 0 3px var(--bg),0 0 3px var(--bg);display:none;';
        sDiv.textContent = '\u2716';
        inner.appendChild(sDiv);
        // Map the sweep bar (index into the oldest-first reversed array)
        // back to its raw candle, then to chart time, so the ✖ sits on
        // the candle that did the sweep instead of the chart centre.
        var _swpRaw = raw[raw.length - 1 - lsw.sweepBar];
        var _swpTime = _swpRaw ? candleTime(_swpRaw[0], tf) : null;
        _liqEls.push({ el: sDiv, price: lsw.sweepWick, time: _swpTime, isSweep: true });
      }

      _liqUpdate = function () {
        var cw = chart.timeScale().width();
        for (var lei = 0; lei < _liqEls.length; lei++) {
          var le = _liqEls[lei];
          var py2 = candleSeries.priceToCoordinate(le.price);
          if (py2 === null) { le.el.style.display = 'none'; continue; }
          if (le.isLine) {
            le.el.style.top = py2 + 'px';
            le.el.style.width = cw + 'px';
            le.el.style.display = '';
          } else if (le.isSweep) {
            var lx = le.time != null ? chart.timeScale().timeToCoordinate(le.time) : null;
            if (lx === null) { le.el.style.display = 'none'; continue; }
            le.el.style.left = lx + 'px';
            le.el.style.transform = 'translateX(-50%)';
            le.el.style.top = (py2 - 6) + 'px';
            le.el.style.display = '';
          }
        }
      };
      _liqUpdate();
      chart.timeScale().subscribeVisibleLogicalRangeChange(_liqUpdate);
      inner._swOverlayUpdaters.push(_liqUpdate);

      // Liquidity sweep cards
      var liqPanel = $('sw-liq-cards');
      if (liqPanel) {
        if (!liqSweeps.length) {
          liqPanel.hidden = true;
        } else {
          liqPanel.hidden = false;
          var lhtml = '<div class="sw-smc-grouphead">'
            + '<span class="sw-smc-grouphead-title">Liquidity Sweeps</span>'
            + '<span class="sw-smc-grouphead-count">' + liqSweeps.length + '</span>'
            + '</div>';
          var fp3 = function (v) { return '\u20B9' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }); };
          for (var lci = 0; lci < liqSweeps.length; lci++) {
            var lc = liqSweeps[lci];
            var isHighSw = lc.type === 'SWEEP_HIGH';
            var lcCls = isHighSw ? 'sw-smc-card sw-smc-card--sweep-high' : 'sw-smc-card sw-smc-card--sweep-low';
            var sweepTip = isHighSw
              ? 'SWEEP HIGH: Price wicked above equal highs at ' + fp3(lc.level) + ', grabbing buy-stop liquidity, then reversed down. Smart money sold into retail buy stops.'
              : 'SWEEP LOW: Price wicked below equal lows at ' + fp3(lc.level) + ', grabbing sell-stop liquidity, then reversed up. Smart money bought into retail sell stops.';
            var clusterTip = 'Number of bars with highs/lows at approximately the same level.\nMore equal levels = larger liquidity pool = stronger sweep signal.';

            lhtml += '<div class="' + lcCls + '">'
              + '<div class="sw-smc-card-head">'
              +   '<span class="sw-smc-card-type sw-tip" data-tip="' + sweepTip + '">' + (isHighSw ? 'SWEEP HIGH' : 'SWEEP LOW') + '</span>'
              +   '<span class="sw-smc-card-icon">' + (isHighSw ? '\u25BC' : '\u25B2') + '</span>'
              + '</div>'
              + '<div class="sw-smc-card-range sw-tip" data-tip="Liquidity level: ' + fp3(lc.level) + '\nSweep wick: ' + fp3(lc.sweepWick) + '">'
              +   'Level: ' + fp3(lc.level) + ' \u2192 Wick: ' + fp3(lc.sweepWick)
              + '</div>'
              + '<div class="sw-smc-card-foot">'
              +   '<span class="sw-tip" data-tip="' + clusterTip + '">Cluster: ' + lc.clusterSize + ' equal ' + (isHighSw ? 'highs' : 'lows') + '</span>'
              +   '<span class="sw-liq-confirmed">\u2713 Reversal confirmed</span>'
              + '</div>'
              + '</div>';
          }

          liqPanel.innerHTML = lhtml;

          var tipEl4 = document.getElementById('sw-smc-tip-global');
          if (!tipEl4) {
            tipEl4 = document.createElement('div');
            tipEl4.id = 'sw-smc-tip-global';
            tipEl4.className = 'sw-zoi-tip';
            document.body.appendChild(tipEl4);
          }
          var tipTimer4 = 0;
          liqPanel.addEventListener('mouseover', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (!tgt) { clearTimeout(tipTimer4); tipEl4.style.display = 'none'; return; }
            clearTimeout(tipTimer4);
            tipTimer4 = setTimeout(function () {
              tipEl4.textContent = '';
              var lines = tgt.getAttribute('data-tip').split('\\n');
              for (var li3 = 0; li3 < lines.length; li3++) {
                if (li3 > 0) tipEl4.appendChild(document.createElement('br'));
                tipEl4.appendChild(document.createTextNode(lines[li3]));
              }
              tipEl4.style.display = '';
              var r3 = tgt.getBoundingClientRect();
              var left3 = r3.left;
              var top5 = r3.bottom + 6;
              if (left3 + 320 > window.innerWidth) left3 = window.innerWidth - 330;
              if (left3 < 8) left3 = 8;
              if (top5 + 200 > window.innerHeight) top5 = r3.top - tipEl4.offsetHeight - 6;
              tipEl4.style.left = left3 + 'px';
              tipEl4.style.top = top5 + 'px';
            }, 300);
          });
          liqPanel.addEventListener('mouseout', function (e) {
            var tgt = e.target.closest('[data-tip]');
            if (tgt) { clearTimeout(tipTimer4); tipEl4.style.display = 'none'; }
          });
        }
      }
    } else {
      var liqPanelOff = $('sw-liq-cards');
      if (liqPanelOff) { liqPanelOff.hidden = true; liqPanelOff.innerHTML = ''; }
    }

    // chart.timeScale().scrollToRealTime();
        // Default page-load view = the SAME recent window as the reset button
    // (last VISIBLE_BARS bars), so load and reset stay consistent. (Was
    // scrollToRealTime, which restored LWC's default scroll and could show a
    // different bar count.)
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, klines.length - VISIBLE_BARS), to: klines.length + 3 });

    // Restore the pre-toggle view (see the capture block before disposeMainChart).
    // Runs AFTER the default-range set above so it is the final word on the view.
    if (_savedView) {
      try {
        if (_savedView.logical && isFinite(_savedView.logical.from) && isFinite(_savedView.logical.to)) {
          chart.timeScale().setVisibleLogicalRange(_savedView.logical);
        }
        if (_savedView.price && isFinite(_savedView.price.from) && isFinite(_savedView.price.to)
            && _savedView.price.from !== _savedView.price.to) {
          var _rpsRestore = chart.priceScale('right');
          _rpsRestore.setAutoScale(false);
          _rpsRestore.setVisibleRange(_savedView.price);
        }
      } catch (_) {}
    }

    // Reposition ALL price-anchored overlays once the view above has settled
    // (2026-06-06). Each overlay block positions its DOM box immediately at
    // creation (via _zoiUpdate/_fvgUpdate/… + a subscribeVisibleLogicalRangeChange
    // handler), but that runs against the chart's TRANSIENT post-setData price
    // fit — BEFORE setVisibleLogicalRange() above narrows the window and the
    // vertical price-scale re-fits to it. The price re-fit lands on the next
    // paint frame, so for one frame priceToCoordinate() returns a stale Y and a
    // far-from-price box (typically the SUPPLY zone, high above current price)
    // is drawn at the wrong level, then visibly "jumps" to its correct spot when
    // the next crosshair/scroll event re-runs the updater. A double rAF defers
    // the reposition until AFTER the price fit has applied, so every band lands
    // at its correct level on first paint — no jump. Display-only: the zone
    // prices (proximal/distal) and the verdict are untouched.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var u = inner._swOverlayUpdaters;
        if (!u) return;
        for (var _ui = 0; _ui < u.length; _ui++) {
          try { u[_ui](); } catch (_) {}
        }
      });
    });

    // ── OHLCV tooltip (like TradingView / Upstox) ──
    var tooltip = mount.querySelector('.sw-chart-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'sw-chart-tooltip';
      mount.appendChild(tooltip);
    }
    tooltip.style.display = 'none';

    function fmtVol(v) {
      if (!v || !isFinite(v)) return '0';
      if (v >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
      if (v >= 1e5) return (v / 1e5).toFixed(2) + 'L';
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
      return String(Math.round(v));
    }

    chart.subscribeCrosshairMove(function (param) {
      if (_zoiUpdate) _zoiUpdate();
      if (_fvgUpdate) _fvgUpdate();
      if (_bosUpdate) _bosUpdate();
      if (_liqUpdate) _liqUpdate();
      if (!param || !param.time || !param.seriesData || !param.seriesData.size) {
        tooltip.style.display = 'none';
        return;
      }
      var candle = param.seriesData.get(candleSeries);
      if (!candle || candle.open == null) {
        tooltip.style.display = 'none';
        return;
      }
      var o = candle.open, h = candle.high, l = candle.low, cl = candle.close;
      var chg = cl - o;
      var chgPct = o ? ((chg / o) * 100).toFixed(2) : '0.00';
      var bullish = cl >= o;
      var color = bullish ? '#09a86e' : '#c91f3a';
      tooltip.innerHTML =
        '<span style="color:var(--text)">O</span> <b>' + o.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--text)">H</span> <b>' + h.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--text)">L</span> <b>' + l.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--text)">C</span> <b style="color:' + color + '">' + cl.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:' + color + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + ' (' + (chg >= 0 ? '+' : '') + chgPct + '%)</span>' +
        (function () {
          var vk = typeof param.time === 'object'
            ? param.time.year + '-' + param.time.month + '-' + param.time.day
            : param.time;
          return volByTime[vk] ? ' &nbsp;<span style="color:var(--muted)">Vol</span> <b>' + fmtVol(volByTime[vk]) + '</b>' : '';
        })();
      tooltip.style.display = '';
      tooltip.innerHTML =
        '<span style="color:var(--muted)">O</span> <b style="color:' + color + '">' + o.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--muted)">H</span> <b style="color:' + color + '">' + h.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--muted)">L</span> <b style="color:' + color + '">' + l.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:var(--muted)">C</span> <b style="color:' + color + '">' + cl.toFixed(2) + '</b> &nbsp;' +
        '<span style="color:' + color + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + ' (' + (chg >= 0 ? '+' : '') + chgPct + '%)</span>' +
        (function () {
          var vk = typeof param.time === 'object'
            ? param.time.year + '-' + param.time.month + '-' + param.time.day
            : param.time;
          return volByTime[vk] ? ' &nbsp;<span style="color:var(--muted)">Vol</span> <b>' + fmtVol(volByTime[vk]) + '</b>' : '';
        })();
    });

    STATE.chart = chart;
    STATE.candleSeries = candleSeries;

    // Bar-close countdown: seed the last completed bar's price (used to pin
    // the chip to the right-axis last-price tag) and start the 1s ticker.
    // For 1w/1mo applyFormingBar() below overwrites this with the live
    // forming-bar price. Idempotent — safe on every re-render / TF switch.
    try {
      var _lastK = klines[klines.length - 1];
      if (_lastK) { STATE._chartLastClose = _lastK.close; STATE._chartLastOpen = _lastK.open; }
      startSwCountdownTicker();
    } catch (_) {}

    // Overlay the current (forming) week/month bar — the klines just set
    // are completed-only (analyzer-clean), so this is what makes the live
    // weekly/monthly bar appear. No-op for daily/intraday TFs.
    applyFormingBar(tf);

    // ── Trackpad scroll: price-axis zoom only ──
    // Scroll on price axis (right panel) → zoom via scaleMargins.
    // All other interactions (pan, time zoom, drag) → LWC native.
    // (function attachPriceAxisZoom() {
    //   var PS_WIDTH = 65;
    //   var scaleLevel = 0.1;

    //   function isOnPriceScale(e) {
    //     var rect = inner.getBoundingClientRect();
    //     return (e.clientX >= rect.right - PS_WIDTH);
    //   }

    //   inner.addEventListener('wheel', function (e) {
    //     if (!isOnPriceScale(e)) return;
    //     if (Math.abs(e.deltaY) < 1) return;
    //     e.preventDefault();
    //     e.stopPropagation();

    //     var step = e.deltaY > 0 ? 0.0015 : -0.0015;
    //     scaleLevel = Math.max(0.02, Math.min(0.49, scaleLevel + step));
    //     chart.priceScale('right').applyOptions({
    //       autoScale: true,
    //       scaleMargins: { top: scaleLevel, bottom: scaleLevel }
    //     });

    //     requestAnimationFrame(function () {
    //       if (_zoiUpdate) _zoiUpdate();
    //       if (_fvgUpdate) _fvgUpdate();
    //       if (_bosUpdate) _bosUpdate();
    //       if (_liqUpdate) _liqUpdate();
    //     });
    //   }, { capture: true, passive: false });

    //   inner.addEventListener('dblclick', function () {
    //     scaleLevel = 0.1;
    //     chart.priceScale('right').applyOptions({
    //       autoScale: true,
    //       scaleMargins: { top: 0.1, bottom: 0.1 }
    //     });
    //     chart.timeScale().fitContent();
    //     requestAnimationFrame(function () {
    //       if (_zoiUpdate) _zoiUpdate();
    //       if (_fvgUpdate) _fvgUpdate();
    //       if (_bosUpdate) _bosUpdate();
    //       if (_liqUpdate) _liqUpdate();
    //     });
    //   });
    // })();




        // ── Trackpad scroll: price-axis zoom only ──
    // TRUE price-range zoom (v5 IPriceScaleApi.setVisibleRange) around the
    // cursor — same mechanism as dragging the axis. The old approach padded via
    // scaleMargins + autoScale, which could only zoom OUT (it dead-ended once
    // the data filled the pane → the ~20-pt-gap wall) and snapped any drag-zoom
    // back to auto-fit on every wheel tick.
    (function attachPriceAxisZoom() {
      var PS_WIDTH = 65;

      function isOnPriceScale(e) {
        var rect = inner.getBoundingClientRect();
        return (e.clientX >= rect.right - PS_WIDTH);
      }

      function refreshOverlays() {
        requestAnimationFrame(function () {
          if (_zoiUpdate) _zoiUpdate();
          if (_fvgUpdate) _fvgUpdate();
          if (_bosUpdate) _bosUpdate();
          if (_liqUpdate) _liqUpdate();
        });
      }

      inner.addEventListener('wheel', function (e) {
        if (!isOnPriceScale(e)) return;
        if (Math.abs(e.deltaY) < 1) return;
        e.preventDefault();
        e.stopPropagation();

        var ps = chart.priceScale('right');
        var rect = inner.getBoundingClientRect();
        var h = inner.clientHeight || rect.height || 1;

        // Current visible price range (fall back to pixel→price if not set yet).
        var top, bot, cur = null;
        try { cur = ps.getVisibleRange(); } catch (_) {}
        if (cur && isFinite(cur.from) && isFinite(cur.to)) {
          top = Math.max(cur.from, cur.to);
          bot = Math.min(cur.from, cur.to);
        } else {
          top = candleSeries.coordinateToPrice(0);
          bot = candleSeries.coordinateToPrice(h);
        }
        if (!isFinite(top) || !isFinite(bot) || top <= bot) return;

        // Anchor at the price under the cursor so it stays put while zooming.
        var pc = candleSeries.coordinateToPrice(e.clientY - rect.top);
        if (!isFinite(pc)) pc = (top + bot) / 2;

        // // Same direction as before: deltaY > 0 = zoom OUT, deltaY < 0 = zoom IN.
        // var k = e.deltaY > 0 ? 1.1 : (1 / 1.1);
        // var newTop = pc + (top - pc) * k;
        // var newBot = pc - (pc - bot) * k;


        // Zoom factor scales with scroll magnitude → smooth on a trackpad (many
        // tiny deltas) and on a mouse wheel (few big deltas). deltaY > 0 = zoom
        // OUT, < 0 = zoom IN. Lower ZOOM_SENSITIVITY = slower; the clamp stops a
        // single big wheel notch from leaping.
        var ZOOM_SENSITIVITY = 0.0005;          // ← TUNE THIS (0.0005 slow … 0.003 fast)
        var k = Math.exp(e.deltaY * ZOOM_SENSITIVITY);
        k = Math.max(0.5, Math.min(2, k));      // cap one event to ±2× / ÷2
        var newTop = pc + (top - pc) * k;
        var newBot = pc - (pc - bot) * k;


        var span = newTop - newBot;
        if (!(span > 0.5) || !isFinite(span)) return;   // don't zoom tighter than ~½ pt

        try {
          ps.setAutoScale(false);
          ps.setVisibleRange({ from: newBot, to: newTop });
        } catch (_) { return; }

        refreshOverlays();
      }, { capture: true, passive: false });

      // Double-click the axis → back to auto-fit (price + time).
      inner.addEventListener('dblclick', function () {
        try {
          var ps = chart.priceScale('right');
          ps.setAutoScale(true);
          ps.applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
        } catch (_) {}
        chart.timeScale().fitContent();
        refreshOverlays();
      });
    })();





    // ── Chart navigation buttons (zoom ±, scroll ‹ ›, reset) ──
    window.swChartNav = function (action) {
      if (!chart) return;
      var ts = chart.timeScale();
      switch (action) {
        case 'in':
          ts.applyOptions({ barSpacing: (ts.options().barSpacing || 6) + 2 });
          break;
        case 'out':
          ts.applyOptions({ barSpacing: Math.max(1, (ts.options().barSpacing || 6) - 2) });
          break;
        case 'left':
          ts.scrollToPosition(ts.scrollPosition() - 10, false);
          break;
        case 'right':
          ts.scrollToPosition(ts.scrollPosition() + 10, false);
          break;
        // case 'reset':
        //   ts.fitContent();
        //   chart.priceScale('right').applyOptions({ autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 } });
        //   break;
        case 'reset':
          // Show the LATEST window (not the whole history). Logical-bar range =
          // same recent view on every timeframe. autoScale refits the y-axis to
          // the visible candles (also clears any manual zoom/pan from the wheel
          // + drag handlers, which run with autoScale off).
          // var RESET_BARS = 100;                  // ← recent bars to show on reset
          // var nBars = (klines && klines.length) ? klines.length : 0;
          // if (nBars > 1) {
          //   ts.setVisibleLogicalRange({ from: Math.max(0, nBars - RESET_BARS), to: nBars + 2 });
          // } else {
          //   ts.fitContent();
          // }
          // chart.priceScale('right').setAutoScale(true);
          // chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.1 } });
          var RESET_BARS = VISIBLE_BARS;         // same window as page-load default
          var nBars = (klines && klines.length) ? klines.length : 0;
          if (nBars > 1) {
            ts.setVisibleLogicalRange({ from: Math.max(0, nBars - RESET_BARS), to: nBars + 3 });
          } else {
            ts.fitContent();
          }
          // Match the price-scale margins the chart is CREATED with (LWC default
          // 0.2/0.1) so reset == page refresh. setAutoScale(true) also clears any
          // manual wheel-zoom / drag-pan (those run with autoScale off).
          chart.priceScale('right').setAutoScale(true);
          chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.2, bottom: 0.1 } });
          break;
      }
    };

    setActiveTfBtn(tf, { locked: false });

    // Friendly status line: "Daily — 247 candles · last ₹1,359.70".
    // pollSwingTick will overwrite this on the first tick with the
    // live LTP + last-tick time, but the static version is useful
    // outside market hours when polling backs off to 60s.
    var last = klines[klines.length - 1];
    var lastPx = last ? fmtPrice(last.close) : '—';
    setChartStatus(spec.label + ' — ' + klines.length + ' candles · last ' + lastPx);

    // Recompute the verdict + Risk Context card for the RECOMMENDATION TF
    // (swGetRecoTf — independent of this chart's TF). Re-rendering the chart
    // panel therefore always paints the reco-TF verdict, not the chart TF's.
    // Signalled TFs (1M/1W/1D/4H/1H) each get a fresh independent signal;
    // sub-hour TFs (30m/15m/5m) echo the last signal + a note. Guarded so a
    // failure here never breaks the chart render.
    try { swPaintVerdict(swComputeVerdictForTf(swGetRecoTf())); _swRelocateSignalDetail(); } catch (_) {}

    // Re-render BOTH trade-plan cards for the (possibly changed) reco TF — this
    // is the chart-TF side of the bidirectional TF lock, so the SETUP card's
    // TF-native levels track the chart/picker here too; STRUCTURE holds its
    // multi-TF levels but refreshes its verdict / gate / reasoning.
    try { if (typeof swRenderBothPlanCards === 'function') swRenderBothPlanCards(); } catch (_) {}

    // Reset the silent-refetch debounce so the first tick won't
    // immediately fire a redundant full refetch (we just rendered
    // the freshest data we have).
    STATE.livePoll.lastSyncMs = Date.now();

    // Kick off live polling. Will no-op if the swing tab isn't
    // currently active (the active flag is set by swingActivate
    // when the user enters the tab via show('swing')).
    console.log('[swing] renderMainChart: calling startSwingPolling, livePoll.active=', STATE.livePoll.active);
    startSwingPolling();
  }

  // Format a signed percentage with sign + 1-decimal precision.
  function fmtSignedPct(p) {
    if (p == null || !isFinite(p)) return '\u2014';
    var s = (p >= 0 ? '+' : '');
    return s + p.toFixed(1) + '%';
  }

  // Slope direction → arrow + word, returned as plain markup so it
  // can be dropped into a value cell. ↑ rising / ↓ falling / → flat.
  function slopeLabel(s) {
    if (s === 'rising')  return '<span class="sw-arrow sw-arrow-up">\u2191</span> rising';
    if (s === 'falling') return '<span class="sw-arrow sw-arrow-down">\u2193</span> falling';
    return '<span class="sw-arrow sw-arrow-flat">\u2192</span> flat';
  }
  function slopeCls(s) {
    if (s === 'rising') return 'sw-bull';
    if (s === 'falling') return 'sw-bear';
    return 'sw-muted';
  }

  function classifyAdx(v) {
    if (v == null || !isFinite(v)) return { label: '\u2014', cls: 'sw-muted', zone: 'weak' };
    if (v < 20) return { label: v.toFixed(0) + ' · weak / range',  cls: 'sw-muted', zone: 'weak' };
    if (v < 25) return { label: v.toFixed(0) + ' · developing',    cls: 'sw-warn',  zone: 'developing' };
    if (v < 40) return { label: v.toFixed(0) + ' · strong trend',  cls: 'sw-bull',  zone: 'strong' };
    if (v < 50) return { label: v.toFixed(0) + ' · very strong',   cls: 'sw-bull',  zone: 'strong' };
    return            { label: v.toFixed(0) + ' · extreme',        cls: 'sw-warn',  zone: 'extreme' };
  }

  function shortMomentum(mom) {
    if (mom === 'STRONG_BULL') return 'STRONG BULLISH';
    if (mom === 'BULL') return 'BULLISH';
    if (mom === 'STRONG_BEAR') return 'STRONG BEARISH';
    if (mom === 'BEAR') return 'BEARISH';
    return 'NEUTRAL';
  }

  function momentumChip(mom) {
    var cls = mom && mom.indexOf('BULL') >= 0 ? 'bull'
            : mom && mom.indexOf('BEAR') >= 0 ? 'bear' : 'neutral';
    return chip(shortMomentum(mom), cls);
  }

  function trendChip(trend) {
    var cls = trend && trend.indexOf('BULL') >= 0 ? 'bull'
            : trend && trend.indexOf('BEAR') >= 0 ? 'bear' : 'neutral';
    return chip(shortTrend(trend), cls);
  }

  // Rounded coloured pill — used everywhere as a label badge.
  function chip(label, kind) {
    return '<span class="sw-chip sw-chip-' + (kind || 'neutral') + '">' + escapeHtml(label) + '</span>';
  }

  // ── Visual gauges ─────────────────────────────────────────────
  // All three return an HTML snippet containing a 7px-tall track
  // with shaded zones (if any), a marker at the current value, and
  // optional axis ticks below. The caller is responsible for the
  // surrounding `.sw-g` wrapper + header.

  function linearGauge(value, opts) {
    opts = opts || {};
    var min = opts.min == null ? 0 : opts.min;
    var max = opts.max == null ? 100 : opts.max;
    if (value == null || !isFinite(value)) value = min;
    var clamped = Math.max(min, Math.min(max, value));
    var pct = ((clamped - min) / (max - min)) * 100;
    var zones = '';
    if (opts.zones) {
      for (var i = 0; i < opts.zones.length; i++) {
        var z = opts.zones[i];
        var left = ((Math.max(z.from, min) - min) / (max - min)) * 100;
        var width = ((Math.min(z.to, max) - Math.max(z.from, min)) / (max - min)) * 100;
        zones += '<span class="sw-g-zone sw-g-zone-' + z.cls + '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></span>';
      }
    }
    var marker = '<span class="sw-g-marker ' + (opts.markerCls || '') + '" style="left:' + pct.toFixed(2) + '%"></span>';
    var ticks = '';
    if (opts.ticks && opts.ticks.length) {
      ticks = '<div class="sw-g-ticks">';
      for (var i = 0; i < opts.ticks.length; i++) ticks += '<span>' + escapeHtml(String(opts.ticks[i])) + '</span>';
      ticks += '</div>';
    }
    return '<div class="sw-g-track">' + zones + marker + '</div>' + ticks;
  }

  // Centre-zero bar that fills LEFT for negative, RIGHT for positive.
  // Used to show % distance from each EMA.
  function bipolarGauge(value, maxAbs) {
    maxAbs = maxAbs || 25;
    if (value == null || !isFinite(value)) value = 0;
    var clamped = Math.max(-maxAbs, Math.min(maxAbs, value));
    var halfPct = (Math.abs(clamped) / maxAbs) * 50;
    var left = clamped >= 0 ? 50 : (50 - halfPct);
    var color = clamped >= 0 ? 'bull' : 'bear';
    return '<div class="sw-g-track sw-g-bipolar">'
      + '<span class="sw-g-fill sw-g-fill-' + color + '" style="left:' + left.toFixed(2) + '%;width:' + halfPct.toFixed(2) + '%"></span>'
      + '<span class="sw-g-zero"></span>'
      + '</div>';
  }

  // 0-100% position slider. Used for 52-week range position.
  function rangeGauge(pct, lowLabel, highLabel) {
    if (pct == null || !isFinite(pct)) pct = 0;
    pct = Math.max(0, Math.min(100, pct));
    var markerCls = pct > 75 ? 'sw-bull' : (pct < 25 ? 'sw-bear' : 'sw-muted');
    return '<div class="sw-g-track">'
      + '<span class="sw-g-marker ' + markerCls + '" style="left:' + pct.toFixed(2) + '%"></span>'
      + '</div>'
      + '<div class="sw-g-ticks">'
      +   '<span>' + escapeHtml(lowLabel || '0%') + '</span>'
      +   '<span>' + pct.toFixed(0) + '%</span>'
      +   '<span>' + escapeHtml(highLabel || '100%') + '</span>'
      + '</div>';
  }

  // ── Compact row primitives ─────────────────────────────────────

  // Simple metric row inside a block body (no gauge — just label/value).
  function mrow(label, valueHtml, cls) {
    return '<div class="sw-tf-mrow">'
      + '<span class="sw-tf-mrow-k">' + escapeHtml(label) + '</span>'
      + '<span class="sw-tf-mrow-v ' + (cls || '') + '">' + valueHtml + '</span>'
      + '</div>';
  }

  // Gauge wrapper with header (label + value chip) + the gauge body.
  function gaugeRow(label, valueHtml, valueCls, gaugeBody) {
    return '<div class="sw-g">'
      + '<div class="sw-g-head">'
      +   '<span class="sw-g-head-k">' + escapeHtml(label) + '</span>'
      +   '<span class="sw-g-head-v ' + (valueCls || '') + '">' + valueHtml + '</span>'
      + '</div>'
      + gaugeBody
      + '</div>';
  }

  // Section-block wrapper. `theme` matches one of:
  //   trend | momentum | volatility | volume | structure | pattern
  function tfBlock(theme, icon, title, headerExtra, bodyHtml) {
    return '<div class="sw-tf-block sw-tf-block-' + theme + '">'
      + '<div class="sw-tf-block-h">'
      +   '<span class="sw-tf-block-icon">' + icon + '</span>'
      +   '<span class="sw-tf-block-title">' + escapeHtml(title) + '</span>'
      +   (headerExtra || '')
      + '</div>'
      + '<div class="sw-tf-block-body">' + bodyHtml + '</div>'
      + '</div>';
  }

  // The visual rewrite. Same data, MUCH more scannable presentation:
  //   1. Headline strip with the three numbers a swing trader checks
  //      first (Trend / RSI / ADX)
  //   2. Contribution panel showing how this TF voted on the verdict
  //   3. Six themed section blocks, each with section-level verdict
  //      chip in the header + visual gauges in the body
  function renderTfCard(tfId, an, plan) {
    // Card header is now just the timeframe label — the trend
    // value lives in the TREND headline cell below (with the
    // VWAP / RSI / ADX trio) so it isn't duplicated in two
    // places. The old corner `.sw-tf-trend` chip was removed
    // from the HTML in May 2026 (DOM lookup would return null
    // anyway).
    //
    // Null-guard: monthly (1mo) can be absent for newly listed
    // stocks with <6 months of history. The verdict strip already
    // paints "n/a" in that case; here we render a quiet placeholder
    // card instead of crashing on an.rsi / an.adx access.
    if (!an) {
      var emptyEl = $('sw-tf-' + tfId + '-rows');
      if (emptyEl) {
        emptyEl.innerHTML = '<div class="sw-tf-contrib-empty" '
          + 'style="text-align:center;padding:24px 8px">'
          + 'Not enough history at this timeframe (newly listed?).'
          + '</div>';
      }
      return;
    }
    var html = '';

    // ── 1. HEADLINE STRIP ──
    // Three numbers a swing trader instinctively glances at first:
    // Trend (already chipped), RSI level, ADX strength. Big-font,
    // top-of-card.
    var rsiTag = an.rsi > 70 ? 'overbought' : (an.rsi < 30 ? 'oversold' : (an.rsi > 55 ? 'bullish' : (an.rsi < 45 ? 'bearish' : 'neutral')));
    var rsiCls = an.rsi > 60 ? 'sw-bull' : (an.rsi < 40 ? 'sw-bear' : 'sw-muted');
    var adxClass = classifyAdx(an.adx);
    var adxNum = (an.adx != null && isFinite(an.adx)) ? an.adx.toFixed(0) : '\u2014';
    var adxZoneName = an.adx == null ? '\u2014'
      : (an.adx < 20 ? 'weak' : an.adx < 25 ? 'developing' : an.adx < 40 ? 'strong' : an.adx < 50 ? 'very strong' : 'extreme');
    html += '<div class="sw-tf-headline">'
      +   '<div class="sw-tf-headline-cell">'
      +     '<span class="sw-tf-headline-k">TREND</span>'
      +     '<span class="sw-tf-headline-v ' + biasClass(an.trend) + '">' + escapeHtml(shortTrendArrow(an.trend)) + '</span>'
      +     '<span class="sw-tf-headline-sub">' + escapeHtml(an.emaStack || '') + '</span>'
      +   '</div>'
      +   '<div class="sw-tf-headline-cell">'
      +     '<span class="sw-tf-headline-k">RSI (14)</span>'
      +     '<span class="sw-tf-headline-v ' + rsiCls + '">' + an.rsi.toFixed(1) + '</span>'
      +     '<span class="sw-tf-headline-sub">' + escapeHtml(rsiTag) + '</span>'
      +   '</div>'
      +   '<div class="sw-tf-headline-cell">'
      +     '<span class="sw-tf-headline-k">ADX (14)</span>'
      +     '<span class="sw-tf-headline-v ' + adxClass.cls + '">' + adxNum + '</span>'
      +     '<span class="sw-tf-headline-sub">' + escapeHtml(adxZoneName) + '</span>'
      +   '</div>'
      + '</div>';

    // ── 2. TF CONTRIBUTION PANEL ──
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
          html += '<li><span class="sw-tf-contrib-pts ' + sCls + '">' + escapeHtml(sPts) + '</span><span>' + escapeHtml(s.label) + '</span></li>';
        }
        html += '</ul>';
      } else {
        html += '<div class="sw-tf-contrib-empty">No directional signal at this timeframe \u2014 neutral vote.</div>';
      }
      html += '</div>';
    }

    // ── 3. TREND BLOCK ──
    // Section-level verdict chip in the header. Bipolar gauges for
    // each EMA distance + a linear gauge for ADX. The arrow column
    // captures the EMA-slope direction.
    var trendBody = '';
    // Three EMA distance gauges (centered on 0%)
    trendBody += gaugeRow(
      'vs 20 EMA',
      (an.ema20DistPct == null ? '\u2014' : fmtSignedPct(an.ema20DistPct))
        + ' &middot; ' + (an.lastClose > an.ema20 ? 'above' : 'below') + ' ' + fmtPrice(an.ema20),
      an.lastClose > an.ema20 ? 'sw-bull' : 'sw-bear',
      bipolarGauge(an.ema20DistPct, 15)
    );
    trendBody += gaugeRow(
      'vs 50 EMA',
      (an.ema50DistPct == null ? '\u2014' : fmtSignedPct(an.ema50DistPct))
        + ' &middot; ' + (an.lastClose > an.ema50 ? 'above' : 'below') + ' ' + fmtPrice(an.ema50),
      an.lastClose > an.ema50 ? 'sw-bull' : 'sw-bear',
      bipolarGauge(an.ema50DistPct, 25)
    );
    if (an.ema200 != null && isFinite(an.ema200)) {
      trendBody += gaugeRow(
        'vs 200 EMA',
        (an.ema200DistPct == null ? '\u2014' : fmtSignedPct(an.ema200DistPct))
          + ' &middot; ' + (an.lastClose > an.ema200 ? 'above' : 'below') + ' ' + fmtPrice(an.ema200),
        an.lastClose > an.ema200 ? 'sw-bull' : 'sw-bear',
        bipolarGauge(an.ema200DistPct, 35)
      );
    } else {
      // Placeholder row when the timeframe has too few candles for
      // an EMA-200 calc (typical on Weekly where 200 weeks ≈ 4 yrs
      // isn't always available). Keeps row count consistent so this
      // row stays at the same Y as in the other TF cards.
      trendBody += gaugeRow(
        'vs 200 EMA',
        'n/a \u00B7 needs 200+ candles',
        'sw-muted',
        bipolarGauge(0, 35)
      );
    }
    // ADX gauge with zones
    trendBody += gaugeRow(
      'Trend strength (ADX 14)',
      adxNum + ' &middot; ' + adxZoneName,
      adxClass.cls,
      linearGauge(an.adx, {
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
    // EMA slopes — stacked, not side-by-side, so the value column
    // (↓ falling / ↑ rising) lines up vertically with the EMA-distance
    // gauges above it. Two short rows are cheap on vertical space.
    trendBody += mrow('20 EMA slope', slopeLabel(an.ema20Slope), slopeCls(an.ema20Slope));
    trendBody += mrow('50 EMA slope', slopeLabel(an.ema50Slope), slopeCls(an.ema50Slope));
    html += tfBlock('trend', '\u2197', 'Trend', trendChip(an.trend), trendBody);

    // ── 3b. BANSAL 44+4 BLOCK (Weekly only) ──
    // Surfaced as a dedicated section so the user can see at a
    // glance whether the Bansal HARD GATE (weekly 44 SMA) is
    // passing and how much room is left to the trailing-stop
    // 4 EMA. Restricted to the Weekly card because that's where
    // the indicators are SEMANTICALLY MEANINGFUL \u2014 a daily
    // 44 SMA is just another \~2-month MA and doesn't gate
    // anything in our engine; showing it with a "GATE PASS / FAIL"
    // chip on the Daily card would mislead the user about what
    // the verdict actually depends on.
    //
    // The headline chip on the Weekly card summarises the gate
    // result (PASS = green / FAIL = red) so the user can verdict
    // the entire Bansal filter at a glance without reading every
    // row inside the block.
    if (tfId === '1w' && an.sma44 != null) {
      var sma44Above = an.lastClose >= an.sma44;
      var sma44Rising = an.sma44Slope === 'rising';
      var sma44Falling = an.sma44Slope === 'falling';
      // Gate semantics: PASS only when price > SMA AND SMA is NOT
      // falling. Mirrors the BELOW_44SMA gate in generatePlan.
      var gatePass = sma44Above && !sma44Falling;
      var gateChip;
      if (gatePass) {
        gateChip = chip('\u2713 GATE PASS', 'bull');
      } else {
        var failBits = [];
        if (!sma44Above) failBits.push('price below SMA');
        if (sma44Falling) failBits.push('SMA falling');
        gateChip = chip('\u2717 GATE FAIL \u00b7 ' + failBits.join(' + '), 'bear');
      }
      var bansalBody = '';
      // 44 SMA distance + level + slope
      bansalBody += gaugeRow(
        'vs 44 SMA',
        (an.sma44DistPct == null ? '\u2014' : fmtSignedPct(an.sma44DistPct))
          + ' \u00b7 ' + (sma44Above ? 'above' : 'below') + ' ' + fmtPrice(an.sma44),
        sma44Above ? 'sw-bull' : 'sw-bear',
        bipolarGauge(an.sma44DistPct, 30)
      );
      bansalBody += mrow('44 SMA slope', slopeLabel(an.sma44Slope), slopeCls(an.sma44Slope));
      // 4 EMA — the trailing-stop reference. Distance to it tells
      // the user "how much room before the Bansal trailing-exit
      // would trigger if a weekly candle closed at the current
      // level". Negative distance = trailing-stop already breached
      // (red flag, even if the gate is still PASS).
      if (an.ema4 != null) {
        var ema4Above = an.lastClose >= an.ema4;
        bansalBody += gaugeRow(
          'vs 4 EMA (trailing SL)',
          (an.ema4DistPct == null ? '\u2014' : fmtSignedPct(an.ema4DistPct))
            + ' \u00b7 ' + (ema4Above ? 'above' : 'below') + ' ' + fmtPrice(an.ema4),
          ema4Above ? 'sw-bull' : 'sw-bear',
          bipolarGauge(an.ema4DistPct, 8)
        );
        bansalBody += mrow('4 EMA slope', slopeLabel(an.ema4Slope), slopeCls(an.ema4Slope));
        // Plain-English exit hint: tells the user what action
        // the 4 EMA suggests RIGHT NOW.
        var exitHint, exitCls;
        if (ema4Above && an.ema4Slope === 'rising') {
          exitHint = 'Trailing SL intact \u2014 hold'; exitCls = 'sw-bull';
        } else if (ema4Above && an.ema4Slope === 'flat') {
          exitHint = 'Trailing SL flattening \u2014 tighten manual stop'; exitCls = 'sw-warn';
        } else if (!ema4Above) {
          exitHint = 'Trailing SL BREACHED \u2014 weekly close below 4 EMA = exit'; exitCls = 'sw-bear';
        } else {
          exitHint = 'Trailing SL eroding \u2014 reduce position'; exitCls = 'sw-warn';
        }
        bansalBody += mrow('Exit signal', exitHint, exitCls);
      } else {
        bansalBody += mrow('vs 4 EMA (trailing SL)', 'n/a \u00b7 needs 4+ candles', 'sw-muted');
      }
      html += tfBlock('bansal', '\u25C6', 'Bansal 44+4', gateChip, bansalBody);
    }

    // ── 4. MOMENTUM BLOCK ──
    // Single-column rows: the labels here ("MACD line vs signal",
    // "MACD histogram trend") are too long for a 2-col grid at
    // typical card widths (~340px). Stacked is also more scannable
    // because the eye reads down a single value column.
    var momBody = '';
    // RSI gauge with overbought/oversold zones
    momBody += gaugeRow(
      'RSI (14)',
      an.rsi.toFixed(1) + ' &middot; ' + escapeHtml(rsiTag),
      rsiCls,
      linearGauge(an.rsi, {
        min: 0, max: 100,
        zones: [
          { from: 0,  to: 30,  cls: 'oversold' },
          { from: 70, to: 100, cls: 'overbought' }
        ],
        markerCls: rsiCls,
        ticks: ['0', '30', '50', '70', '100']
      })
    );
    momBody += mrow('Momentum label', momentumChip(an.momentum), '');
    momBody += mrow('RSI direction', slopeLabel(an.rsiTrend), slopeCls(an.rsiTrend));
    momBody += mrow('MACD histogram',
      (an.macdHist > 0 ? 'bullish ' : 'bearish ') + '(' + an.macdHist.toFixed(2) + ')',
      an.macdHist > 0 ? 'sw-bull' : 'sw-bear');
    momBody += mrow('Histogram trend', slopeLabel(an.macdHistDir), slopeCls(an.macdHistDir));
    momBody += mrow('MACD vs signal',
      an.macdAboveSignal ? 'above (bull bias)' : 'below (bear bias)',
      an.macdAboveSignal ? 'sw-bull' : 'sw-bear');
    momBody += (an.macdCross
      ? mrow('Recent cross',
          (an.macdCross.dir === 'bull' ? 'bull cross' : 'bear cross')
            + (an.macdCross.barsAgo === 0 ? ' this bar' : ' ' + an.macdCross.barsAgo + ' bars ago'),
          an.macdCross.dir === 'bull' ? 'sw-bull' : 'sw-bear')
      : mrow('Recent cross', 'none in last 5 bars', 'sw-muted'));
    html += tfBlock('momentum', '~', 'Momentum', momentumChip(an.momentum), momBody);

    // ── 5. VOLATILITY BLOCK ──
    var volBody = mrow('ATR (14)', escapeHtml(fmtPrice(an.atr)), '')
      + mrow('ATR % of price',
          (an.atrPct != null ? an.atrPct.toFixed(2) + '%' : '\u2014'),
          an.atrPct != null && an.atrPct > 3 ? 'sw-warn' : 'sw-muted');
    var volChip = an.atrPct == null ? ''
      : (an.atrPct > 4 ? chip('HIGH VOL', 'warn')
          : an.atrPct < 1.5 ? chip('LOW VOL', 'neutral')
            : chip('NORMAL', 'neutral'));
    // ── Expected Move (probability cone) ──
    // Project the ± RANGE price is likely to travel over this TF's
    // horizons from the per-bar return σ, scaled √time. This is a range,
    // not a direction — the rows read "±X (68%) · ±Y (95%)" so the trader
    // sizes stops/targets to real volatility instead of guessing. A 68%
    // band is roughly 1 ATR's worth on most names; the 95% band is the
    // "don't expect a target beyond here this period" line.
    var emHz = EM_HORIZONS_BY_TF[an.tfKey];
    if (an.emSigma != null && emHz && isFinite(an.lastClose)) {
      for (var ei = 0; ei < emHz.length; ei++) {
        var hb = emBand(an.lastClose, an.emSigma, emHz[ei].bars);
        if (!hb) continue;
        volBody += mrow(
          'Expected move \u00B7 ' + emHz[ei].label,
          '\u00B1' + fmtMove(hb.p68) + ' (68%) \u00B7 \u00B1' + fmtMove(hb.p95) + ' (95%)',
          'sw-muted'
        );
      }
    }
    html += tfBlock('volatility', '\u2A91', 'Volatility', volChip, volBody);

    // ── 6. VOLUME BLOCK ──
    // Always render the gauge so the row count matches across TF
    // cards. If volumeRatio is missing the gauge degrades to a
    // muted "n/a" marker at the 0× position.
    var volumeBody = '';
    if (an.volumeRatio != null) {
      var volMarkerCls = an.volumeAboveAvg ? 'sw-bull' : 'sw-muted';
      volumeBody += gaugeRow(
        'Volume vs 20-bar MA',
        an.volumeRatio.toFixed(2) + '\u00D7 &middot; ' + (an.volumeAboveAvg ? 'above avg' : 'below avg'),
        an.volumeAboveAvg ? 'sw-bull' : 'sw-muted',
        linearGauge(Math.min(an.volumeRatio, 3), {
          min: 0, max: 3,
          zones: [{ from: 1, to: 3, cls: 'strong' }],
          markerCls: volMarkerCls,
          ticks: ['0', '1\u00D7', '2\u00D7', '3\u00D7']
        })
      );
    } else {
      volumeBody += gaugeRow(
        'Volume vs 20-bar MA',
        'n/a',
        'sw-muted',
        linearGauge(0, {
          min: 0, max: 3,
          zones: [{ from: 1, to: 3, cls: 'weak' }],
          markerCls: 'sw-muted',
          ticks: ['0', '1\u00D7', '2\u00D7', '3\u00D7']
        })
      );
    }
    volumeBody += mrow('Volume trend (5-bar)', slopeLabel(an.volTrend), slopeCls(an.volTrend));
    var volChipUI = an.volumeRatio != null && an.volumeAboveAvg ? chip('CONFIRMING', 'bull') : chip('LIGHT', 'neutral');
    html += tfBlock('volume', '|||', 'Volume', volChipUI, volumeBody);

    // ── 7. STRUCTURE BLOCK ──
    // Always render all 5 rows (4 mrows + 1 gauge) so this block's
    // body height matches across all 3 TF cards. Rows degrade to a
    // muted "n/a" when the indicator hasn't enough data (e.g. 1H
    // doesn't compute the 52-week / range position; weekly may not
    // have a confirmed swing high yet).
    var structBody = '';
    if (an.swingHigh != null) {
      var shTxt = fmtPrice(an.swingHigh)
        + (an.swingHighDistPct != null ? ' (' + fmtSignedPct(an.swingHighDistPct) + ')' : '');
      structBody += mrow('Swing high (resistance)', shTxt, 'sw-bull');
    } else {
      structBody += mrow('Swing high (resistance)', 'n/a', 'sw-muted');
    }
    if (an.swingLow != null) {
      var slTxt = fmtPrice(an.swingLow)
        + (an.swingLowDistPct != null ? ' (' + fmtSignedPct(-an.swingLowDistPct) + ')' : '');
      structBody += mrow('Swing low (support)', slTxt, 'sw-bear');
    } else {
      structBody += mrow('Swing low (support)', 'n/a', 'sw-muted');
    }
    structBody += mrow('20-bar high', an.donHigh20 != null ? fmtPrice(an.donHigh20) : 'n/a',
      an.donHigh20 != null ? '' : 'sw-muted');
    structBody += mrow('20-bar low', an.donLow20 != null ? fmtPrice(an.donLow20) : 'n/a',
      an.donLow20 != null ? '' : 'sw-muted');
    if (an.rangePosPct != null && an.rangeLabel) {
      structBody += gaugeRow(
        an.rangeLabel + ' range position',
        an.rangePosPct.toFixed(0) + '%',
        an.rangePosPct > 75 ? 'sw-bull' : (an.rangePosPct < 25 ? 'sw-bear' : 'sw-muted'),
        rangeGauge(an.rangePosPct, fmtPrice(an.rangeLow), fmtPrice(an.rangeHigh))
      );
    } else {
      // Placeholder gauge keeps the row count + row height the
      // same on TFs (like 1H) where the 52-week range isn't
      // calculated. Marker centered, no real value.
      structBody += gaugeRow(
        'Range position',
        'n/a',
        'sw-muted',
        rangeGauge(0, 'low', 'high')
      );
    }
    html += tfBlock('structure', '#', 'Structure', '', structBody);

    // ── 8. PATTERN BLOCK ──
    var patBody = '';
    if (an.patternBull) {
      patBody += '<div style="text-align:center;padding:6px 0">'
        + chip(an.patternBull, 'bull') + '</div>';
    } else if (an.patternBear) {
      patBody += '<div style="text-align:center;padding:6px 0">'
        + chip(an.patternBear, 'bear') + '</div>';
    } else {
      patBody += '<div class="sw-tf-contrib-empty" style="text-align:center;margin:0">No tradable pattern on the last bar.</div>';
    }
    html += tfBlock('pattern', '\u25C7', 'Pattern', '', patBody);

    // ── 9. Footnote ──
    html += '<div class="sw-tf-foot">Computed from ' + an.candleCount + ' candles</div>';

    var rowsEl = $('sw-tf-' + tfId + '-rows');
    if (rowsEl) rowsEl.innerHTML = html;
  }

  // ═══════════════════════════════════════════════════════════════
  // WIRE-UP — runs once when content/swing.html lands in the DOM
  // ═══════════════════════════════════════════════════════════════
  // The sector-grid host is our wiring anchor — it's the ONE
  // element the swing tab always ships. Old anchor was the search
  // input #sw-search, which is now removed.
  function wire() {
    var anchor = $('sw-sector-grid');
    if (!anchor || anchor.dataset.swWired === '1') return; // already wired
    anchor.dataset.swWired = '1';

    // Boot the sector data + render the 12 sector cards. Network
    // failure is surfaced inline (Retry button) so we don't need
    // a try/catch here — swingInitSectors handles it.
    swingInitSectors();

    // ── Chart timeframe buttons (event delegation) ──
    // One listener on the toolbar group handles all 5 TF buttons.
    // Each click hands off to renderMainChart(); the helper itself
    // dedupes parallel fetches via STATE.chartFetching and locks
    // the buttons while a network call is in flight.
    var tfGroup = $('sw-chart-tf-group');
    if (tfGroup) {
      tfGroup.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest && ev.target.closest('.sw-chart-tf-btn');
        if (!btn) return;
        // Buttons are locked with a non-blocking "busy" class (not the
        // `disabled` attribute), so a click always reaches here even mid-
        // render. A new TF supersedes a stalled / throttled render —
        // renderMainChart's chartTf guard discards the stale paint and
        // getRawForTf de-dupes the fetch.
        var tf = btn.getAttribute('data-tf');
        if (!tf || tf === STATE.chartTf) return;
        if (!STATE.result) return;
        renderMainChart(tf);
      });
    }

    // Big chart needs a resize() whenever the viewport or container
    // changes size — otherwise it keeps its initial-mount dimensions
    // and a phone-rotation / sidebar collapse / fullscreen toggle
    // leaves the canvas misaligned. We throttle through rAF so
    // resize storms (drag-resizing the window) don't thrash.
    var rafPending = false;
    window.addEventListener('resize', function () {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        if (STATE.chart) try { STATE.chart.resize(); } catch (_) {}
      });
    });
  }

  // ── Indicator toggle ──

  function _syncIndToggles() {
    var legend = document.getElementById('sw-chart-legend');
    if (!legend) return;
    var items = legend.querySelectorAll('.sw-ind-toggle');
    for (var i = 0; i < items.length; i++) {
      var key = items[i].getAttribute('data-ind');
      if (key && STATE.indVisible[key] !== undefined) {
        items[i].classList.toggle('active', STATE.indVisible[key]);
      }
    }
  }

  window.swToggleInd = function (key, el) {
    if (!STATE.chart) return;
    STATE.indVisible[key] = !STATE.indVisible[key];
    if (el) el.classList.toggle('active', STATE.indVisible[key]);

    // Auto-compute Fib from current chart candles when toggling FIB on
    // without a prior scan — so clicking FIB in the legend "just works".
    if (key === 'fib' && STATE.indVisible.fib && !FIB_STATE.pendingFib) {
      var tf = STATE.chartTf || '1d';
      var raw = STATE.result && STATE.result.candles && STATE.result.candles[tf];
      if (raw && raw.length >= 8) {
        var autoFib = computeFibZone(raw);
        if (autoFib) {
          FIB_STATE.pendingFib = autoFib;
          FIB_STATE.pendingTf = tf;
        }
      }
    }
    // Clear fib context when toggling FIB off
    if (key === 'fib' && !STATE.indVisible.fib) {
      FIB_STATE.pendingFib = null;
      FIB_STATE.pendingTf = null;
    }

    // Preserve the user's zoom/pan across this re-render — a toggle only adds/
    // removes overlays on the SAME candles, so the view should not jump back to
    // the default window. Consumed (and reset) inside renderMainChart.
    STATE._swPreserveView = true;
    renderMainChart(STATE.chartTf);
  };

  // Expose for inline onclick + lazy section loader
  window.swingAnalyze     = analyze;
  function _swUpdateApiPill() {
    var dot   = document.getElementById('sw-api-dot');
    var label = document.getElementById('sw-api-pill-label');
    var pill  = document.getElementById('sw-api-pill');
    if (!dot || !label || !pill) return;
    var hasKey = !!getToken();
    dot.className = 'sw-api-dot' + (hasKey ? ' sw-api-dot--on' : '');
    label.textContent = hasKey ? 'API Connected' : 'Connect API';
    pill.title = hasKey
      ? 'Upstox token active \u2014 click to manage'
      : 'No Upstox token \u2014 click to connect';
  }
  window._swUpdateApiPill = _swUpdateApiPill;

  var _origWire = wire;
  wire = function () {
    _origWire();
    _swUpdateApiPill();
  };

  window.swingWire        = wire;
  window.swingActivate    = swingActivate;
  window.swingDeactivate  = swingDeactivate;
  // Sector navigation (the only entry path into single-stock analysis).
  window.swingPickSector       = swingPickSector;
  window.swingPickSectorStock  = swingPickSectorStock;
  window.swingInitSectors      = swingInitSectors;
  window.swingReapplyChartTheme = function () {
    if (STATE.chart) STATE.chart.applyOptions(chartOptions(STATE.chartTf));
  };

  // Expose the pure-function indicator + util math so the Intraday
  // Recommendation module (Paper Trading tab) can reuse them rather
  // than duplicating ~200 lines of carefully-tuned indicator code.
  // These are not "swing-specific" — they're standard TA primitives.
  window._tfMath = {
    ema: ema, rsi: rsi, macd: macd, atr: atr, adx: adx,
    // Newly added intraday-grade indicators (May 2026):
    //   supertrend — ATR-based trend flip, popular Indian intraday
    //   stochastic — short-term overbought/oversold momentum
    //   obv        — cumulative volume-flow accumulation/distribution
    supertrend: supertrend, stochastic: stochastic, obv: obv,
    swingHighs: swingHighs, swingLows: swingLows,
    // Expose the FULL pattern API so the intraday module can pass
    // trend context (for Hammer / Hanging Man disambiguation) and
    // read the new fields (compression, neutral) on the result.
    detectPatterns: detectPatterns,
    // Lookback pattern detection — used by the intraday card
    // renderer when the LATEST bar fires no pattern, to surface
    // the most recent pattern up to maxLookback bars back.
    detectLookbackPattern: detectLookbackPattern,
    candleParts: candleParts,
    isBullishEngulfing: isBullishEngulfing, isBearishEngulfing: isBearishEngulfing,
    isHammer: isHammer, isInvertedHammer: isInvertedHammer,
    isShootingStar: isShootingStar,
    isDragonflyDoji: isDragonflyDoji, isGravestoneDoji: isGravestoneDoji,
    isNeutralDoji: isNeutralDoji, isDoji: isDoji,
    isBullishMarubozu: isBullishMarubozu, isBearishMarubozu: isBearishMarubozu,
    isPiercing: isPiercing, isDarkCloudCover: isDarkCloudCover,
    isBullishHarami: isBullishHarami, isBearishHarami: isBearishHarami,
    isTweezerBottom: isTweezerBottom, isTweezerTop: isTweezerTop,
    isMorningStar: isMorningStar, isEveningStar: isEveningStar,
    isMorningDojiStar: isMorningDojiStar, isEveningDojiStar: isEveningDojiStar,
    isThreeWhiteSoldiers: isThreeWhiteSoldiers, isThreeBlackCrows: isThreeBlackCrows,
    isInsideBar: isInsideBar, isNR4: isNR4,
    escapeHtml: escapeHtml,
    shortTrend: shortTrend, shortTrendArrow: shortTrendArrow, biasClass: biasClass,
    // Visual primitives so the per-TF cards in the intraday
    // analyzer can render with the identical look-and-feel.
    chip: chip, slopeLabel: slopeLabel, slopeCls: slopeCls,
    classifyAdx: classifyAdx, shortMomentum: shortMomentum,
    momentumChip: momentumChip, trendChip: trendChip,
    linearGauge: linearGauge, bipolarGauge: bipolarGauge, rangeGauge: rangeGauge,
    mrow: mrow, gaugeRow: gaugeRow, tfBlock: tfBlock,
    fmtSignedPct: fmtSignedPct,
    BASE_V3: BASE_V3, BASE_V2: BASE_V2, getToken: getToken,
    fmtDate: fmtDate, fmtPrice: fmtPrice, fmtPct: fmtPct
  };

  // ── Backtest test hook (browser-inert) ──────────────────────────
  // The headless walk-forward backtester (scripts/backtest/*.mjs) needs
  // the SAME closure-private verdict pipeline the live app uses, so the
  // backtest can never drift from production signal logic (a hard rule
  // in .cursor/rules/trading-context.mdc — real capital depends on it).
  // analyzeTf + generatePlan are closure-private, so we expose them ONLY
  // when a test harness has set window.__SWING_TEST__ before loading this
  // file in a Node vm sandbox. In a normal browser __SWING_TEST__ is
  // undefined, so this block is a no-op and nothing leaks into the app.
  if (typeof window !== 'undefined' && window.__SWING_TEST__) {
    window.__swingExports = {
      analyzeTf: analyzeTf,
      generatePlan: generatePlan,
      // The Fib/ZOI scan engine (universe scan-table verdicts). Pure on
      // candles → the backtester can replay the EXACT scan signals.
      scanVerdictFromCandles: scanVerdictFromCandles,
      // The SINGLE producer of FIB+ZOI verdict inputs (the scan-list AND the
      // per-stock card both call it). Exported so the regression guard can
      // assert the fibClass ladder / zoiRising / gate stay byte-identical to
      // the reference spec across FIB / ZOI / FIB+ZOI.
      swComputeVerdictInputs: swComputeVerdictInputs,
      computeFibZone: computeFibZone,
      // Mode-aware Entry/SL/T1 geometry (pure on candles + ctx). Exported so the
      // regression guard can assert targets always clear the entry zone top.
      _swStandardRR: _swStandardRR,
      // SMC zone/structure detectors — pure on candles, used for
      // validating the overlay/card detectors against real history.
      detectZones: detectZones,
      detectFVG: detectFVG,
      detectStructureBreaks: detectStructureBreaks,
      detectOrderBlocks: detectOrderBlocks,
      // Higher-TF derivation primitives — the live swing path builds weekly/
      // monthly by aggregating the daily series (deriveTfFromDaily →
      // swAngelAggregate / swAngelBucketKey), NOT from native Upstox weekly.
      // Exposing them lets the backtest reproduce the EXACT same HTF bars the
      // app feeds the engine (no native-vs-derived drift).
      swAngelAggregate: swAngelAggregate,
      swAngelBucketKey: swAngelBucketKey,
      deriveTfFromDaily: deriveTfFromDaily,
      // Indicator/util primitives are already on window._tfMath, but
      // re-export the ones a backtest commonly needs for convenience.
      ema: ema, sma: sma, atr: atr, adx: adx,
      // Days-to-target estimator (2026-06-05) — exported so the
      // calibration backtest validates the SHIPPED function, not a
      // reimplementation (zero drift, per the trading rules).
      _swDaysToTarget: _swDaysToTarget,
      _swEfficiencyFromAdx: _swEfficiencyFromAdx,
      _swPlanDaysEstimate: _swPlanDaysEstimate,
      _swDaysToTargetR: _swDaysToTargetR,
      _swEstimateDays: _swEstimateDays,
      _swTargetTooltip: _swTargetTooltip,
      // Inject a calibration table in tests (live load is via fetch, which is
      // disabled in the vm sandbox) so the table path can be exercised.
      _setDttTable: function (tbl) { _dttTable = tbl; }
    };
  }

  // Wire immediately if the content is already in the DOM, otherwise
  // the lazy section loader (show('swing')) calls swingWire after fetch.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  // ═══════════════════════════════════════════════════════════════
  // FIBONACCI GOLDEN-POCKET SCANNER
  // Scans all stocks on the chosen timeframe (1M / 1W / 1D / 4H / 1H) and
  // surfaces those whose current price sits between the 61.8% and
  // 80.0% Fibonacci retracement levels of their most recent
  // significant swing (low → high). This "golden pocket" zone is
  // a high-probability reversal area used in swing trading.
  //
  // Algorithm:
  //  1. Fetch candles on the chosen TF for each stock (reuses
  //     the same fetchTf() + rate-limit machinery as the bulk scan).
  //  2. Find the highest high in the full window = swing high.
  //  3. Find the lowest low in bars OLDER than the swing high
  //     (i.e. the origin of the move) = swing low.
  //  4. Compute Fib levels from low → high:
  //       61.8% retracement = high − 0.618 × (high − low)
  //       80.0% retracement = high − 0.800 × (high − low)
  //  5. Check if the latest close is between these two levels.
  //  6. Compute an implied R:R using T1 at the swing high and
  //     SL just below the 80.0% level (−1%).
  // ═══════════════════════════════════════════════════════════════

  var FIB_STATE = {
    tf:         '1d',    // selected timeframe (1mo / 1w / 1d / 4h / 1h)
    scope:      'all',   // scan scope: 'all' | 'sector' | 'stock'
    stockIsin:  null,    // isin for single-stock scope
    stockSym:   null,    // symbol text for single-stock scope
    running:    false,
    aborted:    false,
    results:    [],
    pendingFib: null,    // fib context carried into renderMainChart
    pendingTf:  null
  };

  // ── Pure math ──────────────────────────────────────────────────

  // Confirmed fractal-pivot swing anchors for the fib grid.
  // rawCandles: newest-first [ts,O,H,L,C,V]. A pivot high at index i
  // has `P` strictly-lower highs on BOTH the newer (i-1..i-P) and
  // older (i+1..i+P) sides; a pivot low is the mirror. We return the
  // MOST-RECENT confirmed pivot high (smallest i ≥ P) as the swing
  // high, then the lowest low among older bars as the swing low —
  // i.e. the base of the leg price is currently retracing.
  //
  // Why this matters: a pivot needs P bars to its NEWER side to be
  // confirmed, so the last P candles can never become the swing
  // high. That kills the repaint the old naive max() had — where
  // every fresh marginal high re-anchored the whole grid and flipped
  // verdicts. Same fractal idea the BOS/CHoCH detector uses.
  // Returns null when no confirmed pivot high exists in the window.
  function _fibPivotSwings(rawCandles, P) {
    var len = rawCandles.length;
    if (len < 2 * P + 2) return null;
    var hi = function (k) { return +rawCandles[k][2]; };
    var lo = function (k) { return +rawCandles[k][3]; };

    // STEP 1 — swing HIGH = most recent CONFIRMED pivot high (strictly
    // above the P bars on each side). The array is newest-first, so
    // scanning index low→high walks from "now" backwards; the first hit
    // is the most recent swing high. (Anti-repaint: a pivot needs P bars
    // on BOTH sides, so it can never be the still-forming live bar.)
    var hiIdx = -1;
    for (var i = P; i <= len - 1 - P; i++) {
      var isPivotHigh = true;
      for (var d = 1; d <= P; d++) {
        if (hi(i) <= hi(i - d) || hi(i) <= hi(i + d)) { isPivotHigh = false; break; }
      }
      if (isPivotHigh) { hiIdx = i; break; }
    }
    if (hiIdx < 0) return null;
    var swHigh = hi(hiIdx);

    // STEP 1b — find the PREVIOUS swing high (boundary of the impulse).
    // The impulse leg is the move from a low UP TO the current swing high.
    // Its origin cannot be older than the prior peak of similar magnitude.
    // This bounds the search to "this one leg" and prevents anchoring on
    // an ancient low from a prior cycle.
    var prevHiIdx = -1;
    for (var ph = hiIdx + 1; ph <= len - 1 - P; ph++) {
      var isPrevHi = true;
      for (var pd = 1; pd <= P; pd++) {
        if (hi(ph) <= hi(ph - pd) || hi(ph) <= hi(ph + pd)) { isPrevHi = false; break; }
      }
      if (isPrevHi) { prevHiIdx = ph; break; }
    }
    var scanEnd = (prevHiIdx > 0) ? prevHiIdx : len - 1;

    // STEP 2 — swing LOW = the DEEPEST confirmed pivot low between the
    // current swing high and the prior swing high (or end of data).
    // An experienced trader draws the Fib on the FULL impulse leg — from
    // the true origin (deepest low) to the peak — not from the nearest
    // minor consolidation. This ensures the golden pocket captures the
    // real support levels where institutions re-entered.
    var MIN_LEG_FRAC = 0.05; // 5% of price — noise floor for a real leg
    var currentPx = +rawCandles[0][4]; // most-recent close

    // Deepest CONFIRMED pivot low among older bars up to `untilIdx`.
    var deepestPivotLow = function (untilIdx) {
      var bIdx = -1, bPrice = Infinity;
      for (var j = hiIdx + 1; j <= Math.min(untilIdx, len - 1 - P); j++) {
        var isPivotLow = true;
        for (var e = 1; e <= P; e++) {
          if (lo(j) >= lo(j - e) || lo(j) >= lo(j + e)) { isPivotLow = false; break; }
        }
        if (!isPivotLow) continue;
        if ((swHigh - lo(j)) < MIN_LEG_FRAC * swHigh) continue;
        if (lo(j) < bPrice) { bPrice = lo(j); bIdx = j; }
      }
      return { idx: bIdx, price: bPrice };
    };

    var best = deepestPivotLow(scanEnd);

    // EXPANSION GUARD — if price has retraced BELOW the bounded swing low
    // (i.e. current price is under the 100% level), the bounded impulse
    // leg is broken and its Fib grid is meaningless. Zoom out: drop the
    // prior-swing-high boundary and anchor on the deepest pivot low in the
    // FULL available history — the true origin of the larger move. This
    // is timeframe-agnostic: it only fires when the bounded Fib is already
    // invalidated (price < 100%), so normal in-range cases are untouched.
    if (best.idx >= 0 && currentPx < best.price && scanEnd < len - 1) {
      var expanded = deepestPivotLow(len - 1);
      if (expanded.idx >= 0 && expanded.price < best.price) best = expanded;
    }
    if (best.idx >= 0) {
      return { swHigh: swHigh, swHighIdx: hiIdx, swLow: best.price, swLowIdx: best.idx, lowKind: 'PIVOT' };
    }

    // STEP 3 (fallback) — no qualifying pivot low (very short or choppy
    // history). Fall back to the lowest low among all bars between the
    // high and the boundary so a Fib can still be drawn. Still
    // non-repainting (confirmed bars only). Same expansion guard applies.
    var lowestLow = function (untilIdx) {
      var gLow = Infinity, gIdx = -1;
      for (var k = hiIdx + 1; k <= untilIdx; k++) {
        if (lo(k) < gLow) { gLow = lo(k); gIdx = k; }
      }
      return { idx: gIdx, price: gLow };
    };
    var g = lowestLow(scanEnd);
    if (g.idx >= 0 && currentPx < g.price && scanEnd < len - 1) {
      var gExp = lowestLow(len - 1);
      if (gExp.idx >= 0 && gExp.price < g.price) g = gExp;
    }
    if (g.idx < 0) return null;
    return { swHigh: swHigh, swHighIdx: hiIdx, swLow: g.price, swLowIdx: g.idx, lowKind: 'GLOBAL' };
  }

  function computeFibZone(rawCandles) {
    // rawCandles: Upstox V3 format, newest-first: [ts, O, H, L, C, V]
    if (!rawCandles || rawCandles.length < 8) return null;

    var currentPx = +rawCandles[0][4]; // most-recent close

    // 1+2. Swing anchors via CONFIRMED fractal pivots (anti-repaint).
    //    Prefer a wide pivot (P=3) for a cleaner, more significant
    //    swing; fall back to P=2 on shorter histories.
    var sw = _fibPivotSwings(rawCandles, 3) || _fibPivotSwings(rawCandles, 2);
    var swHigh, swLow, swHighIdx, swLowIdx;
    if (sw) {
      swHigh = sw.swHigh; swHighIdx = sw.swHighIdx;
      swLow  = sw.swLow;  swLowIdx  = sw.swLowIdx;
    } else {
      // Fallback: no confirmed pivot high (e.g. price printing fresh
      // highs every bar with no pullback). Use absolute extremes but
      // exclude the last 2 bars from the high so the anchor doesn't
      // track the live bar.
      swHigh = -Infinity; swHighIdx = 2;
      for (var i = 2; i < rawCandles.length; i++) {
        var h = +rawCandles[i][2];
        if (h > swHigh) { swHigh = h; swHighIdx = i; }
      }
      swLow = Infinity; swLowIdx = -1;
      for (var j = swHighIdx + 3; j < rawCandles.length; j++) {
        var l = +rawCandles[j][3];
        if (l < swLow) { swLow = l; swLowIdx = j; }
      }
    }

    if (swLowIdx < 0 || !isFinite(swHigh) || !isFinite(swLow)) return null;
    if (swHigh <= swLow) return null;

    var range   = swHigh - swLow;
    var fib618  = swHigh - 0.618 * range;
    var fib800  = swHigh - 0.800 * range;  // 80.0% — replaces 78.6%
    var fib786  = fib800;                   // alias kept for legacy callers
    var fib500  = swHigh - 0.500 * range;
    var fib382  = swHigh - 0.382 * range;

    // 3. Check if price is currently inside the golden pocket (61.8%–80%).
    var inZone  = currentPx >= fib800 && currentPx <= fib618;

    // 4. Zone position: 0 = at 80% (deeper), 1 = at 61.8% (shallower).
    var zonePos = (fib618 - fib800 > 0)
      ? Math.max(0, Math.min(1, (currentPx - fib800) / (fib618 - fib800)))
      : 0.5;

    // 5. Fib level labels (for chart legend / zone shading).
    var fib236 = swHigh - 0.236 * range;

    // 6. Bounce detection — did price touch the zone recently and is now
    //    recovering? This is the KEY filter: we want stocks bouncing UP from
    //    the zone, not stocks falling through it.
    //
    //    bounceStatus:
    //      'BOUNCE'   — was in zone, now above 61.8% and rising    ← best buy
    //      'RECOVERY' — was deep (below 80%), now rising into zone ← strong buy
    //      'FORMING'  — currently in zone, rising (green candle)   ← watch
    //      'FALLING'  — in zone or just below, but falling          ← skip
    //      'ABOVE'    — well above zone, not relevant
    var BOUNCE_LOOK = Math.min(8, rawCandles.length - 1);
    var recentMinLow = Infinity;
    for (var bi = 0; bi < BOUNCE_LOOK; bi++) {
      var bLow = +rawCandles[bi][3];
      if (bLow < recentMinLow) recentMinLow = bLow;
    }
    var touchedZone = recentMinLow <= fib618 && recentMinLow >= fib800 * 0.97;
    var wasDeep     = recentMinLow < fib800;

    var prevClose1 = rawCandles.length > 1 ? +rawCandles[1][4] : currentPx;
    var prevClose2 = rawCandles.length > 2 ? +rawCandles[2][4] : prevClose1;

    // HH-HL (Higher High, Higher Low) check over recent 5 candles.
    // A single green candle is NOT enough — we need structural proof
    // that the trend has turned up: at least 2 of the last 3 candle
    // highs are rising AND at least 2 of the last 3 lows are rising.
    var isRising = false;
    var bullCandle = currentPx >= +rawCandles[0][1];
    if (rawCandles.length >= 4) {
      var h0 = +rawCandles[0][2], h1 = +rawCandles[1][2], h2 = +rawCandles[2][2], h3 = +rawCandles[3][2];
      var l0 = +rawCandles[0][3], l1 = +rawCandles[1][3], l2 = +rawCandles[2][3], l3 = +rawCandles[3][3];
      var hhCount = (h0 > h1 ? 1 : 0) + (h1 > h2 ? 1 : 0) + (h2 > h3 ? 1 : 0);
      var hlCount = (l0 > l1 ? 1 : 0) + (l1 > l2 ? 1 : 0) + (l2 > l3 ? 1 : 0);
      isRising = (hhCount >= 2 && hlCount >= 2);
    } else {
      isRising = currentPx > prevClose1 && prevClose1 > prevClose2;
    }

    // 6b. Structural direction detection — pivot-based.
    //     Scan for the most recent confirmed pivot LOW between the Fib
    //     swing high and the current bar. If found and price is above it
    //     → structurally RISING. If not → FALLING. Consolidation detected
    //     via tight range relative to ATR.
    //     Fallback: if no strict fractal pivot found (V-bottom with
    //     clustered lows), use the absolute minimum low in the post-high
    //     region — still requires current price to be meaningfully above it.
    var _dirP = 2;
    var _dirPivotLow = null, _dirPivotLowIdx = -1;
    var _dirScanEnd = Math.min(swHighIdx, rawCandles.length - _dirP);
    if (_dirScanEnd > _dirP) {
      for (var di = _dirP; di < _dirScanEnd; di++) {
        var _dpLow = true;
        for (var dd = 1; dd <= _dirP; dd++) {
          if (+rawCandles[di][3] >= +rawCandles[di - dd][3] ||
              +rawCandles[di][3] >= +rawCandles[di + dd][3]) {
            _dpLow = false; break;
          }
        }
        if (_dpLow) { _dirPivotLow = +rawCandles[di][3]; _dirPivotLowIdx = di; break; }
      }
    }
    // Fallback: no strict pivot found — find the absolute minimum low
    // between bar 1 and swHighIdx. Qualifies as structural low if current
    // price has risen >5% above it (meaningful recovery, not noise).
    if (_dirPivotLow === null && swHighIdx > 1) {
      var _absMin = Infinity, _absMinIdx = -1;
      for (var ami = 1; ami < swHighIdx; ami++) {
        var _amLow = +rawCandles[ami][3];
        if (_amLow < _absMin) { _absMin = _amLow; _absMinIdx = ami; }
      }
      if (_absMinIdx > 0 && currentPx > _absMin * 1.05) {
        _dirPivotLow = _absMin;
        _dirPivotLowIdx = _absMinIdx;
      }
    }

    var fibDirection, fibOriginZone, fibPivotPrice, fibPivotBarsAgo;
    if (_dirPivotLow !== null && currentPx > _dirPivotLow) {
      // Consolidation check: range of last 6 bars vs ATR
      var _conN = Math.min(6, rawCandles.length);
      var _conHi = -Infinity, _conLo = Infinity, _atrSum = 0;
      for (var ci = 0; ci < _conN; ci++) {
        var _ch = +rawCandles[ci][2], _cl = +rawCandles[ci][3];
        if (_ch > _conHi) _conHi = _ch;
        if (_cl < _conLo) _conLo = _cl;
        if (ci > 0) {
          var _prevC = +rawCandles[ci - 1][4];
          _atrSum += Math.max(_ch - _cl, Math.abs(_ch - _prevC), Math.abs(_cl - _prevC));
        }
      }
      var _atr = (_conN > 1) ? _atrSum / (_conN - 1) : (_conHi - _conLo);
      var _rangeWidth = _conHi - _conLo;
      fibDirection = (_atr > 0 && _rangeWidth < 1.5 * _atr) ? 'CONSOLIDATING' : 'RISING';
      fibPivotPrice = _dirPivotLow;
      fibPivotBarsAgo = _dirPivotLowIdx;
    } else {
      fibDirection = 'FALLING';
      fibPivotPrice = swHigh;
      fibPivotBarsAgo = swHighIdx;
    }

    // Origin zone: where was the pivot in Fib terms?
    var _pivotDepth = (range > 0) ? ((swHigh - fibPivotPrice) / range) * 100 : 0;
    if (_pivotDepth > 100)       fibOriginZone = 'Deep';
    else if (_pivotDepth > 80)   fibOriginZone = 'Below';
    else if (_pivotDepth > 61.8) fibOriginZone = 'Pocket';
    else if (_pivotDepth > 38.2) fibOriginZone = 'Mid';
    else if (_pivotDepth >= 0)   fibOriginZone = 'Above';
    else                         fibOriginZone = 'Top';

    var bounceStatus;
    if (currentPx > fib618) {
      if (touchedZone && isRising) {
        bounceStatus = 'BOUNCE';
      } else if (fibDirection === 'RISING' && (fibOriginZone === 'Deep' || fibOriginZone === 'Below' || fibOriginZone === 'Pocket')) {
        bounceStatus = 'RECOVERED';
      } else {
        bounceStatus = 'ABOVE';
      }
    } else if (currentPx >= fib800) {
      if (wasDeep && isRising && bullCandle) {
        bounceStatus = 'RECOVERY';
      } else {
        bounceStatus = (isRising && bullCandle) ? 'FORMING' : 'FALLING';
      }
    } else {
      bounceStatus = 'FALLING';
    }

    var inScanScope = inZone || bounceStatus === 'BOUNCE' || bounceStatus === 'RECOVERY';

    // 7. Position-aware trade plan: entry/SL/T1/T2 depend on where
    //    the current price sits relative to the fib levels.
    var plan = {};
    plan.t2 = swHigh;

    if (bounceStatus === 'BOUNCE') {
      plan.entry   = currentPx;
      plan.entryHi = currentPx;
      plan.sl    = fib618 * 0.98;
      plan.t1    = fib382;
      plan.label = 'at market (post-bounce)';
    } else if (bounceStatus === 'RECOVERY') {
      plan.entry   = currentPx;
      plan.entryHi = currentPx;
      plan.sl    = (currentPx > fib618) ? fib618 * 0.98 : fib800 * 0.97;
      plan.t1    = (currentPx < fib382) ? fib382 : fib236;
      plan.label = 'at market (recovery)';
    } else if (bounceStatus === 'FORMING') {
      plan.entry   = fib800;
      plan.entryHi = fib618;
      plan.sl    = fib800 * 0.97;
      plan.t1    = fib382;
      plan.label = 'golden pocket zone';
    } else if (bounceStatus === 'RECOVERED') {
      plan.entry   = fib800;
      plan.entryHi = fib618;
      plan.sl    = fib800 * 0.97;
      plan.t1    = fib382;
      plan.label = 'recovered \u2014 wait for pullback to 61.8\u201380%';
    } else if (bounceStatus === 'ABOVE') {
      plan.entry   = fib800;
      plan.entryHi = fib618;
      plan.sl    = fib800 * 0.97;
      plan.t1    = fib382;
      plan.label = 'limit in 61.8\u201380% zone';
    } else {
      plan.entry   = currentPx;
      plan.entryHi = currentPx;
      plan.sl    = currentPx * 0.95;
      plan.t1    = fib618;
      plan.label = 'falling \u2014 wait for reversal';
    }

    var planRisk = plan.entry - plan.sl;
    plan.rr   = (planRisk > 0) ? (plan.t1 - plan.entry) / planRisk : null;
    plan.rrT2 = (planRisk > 0) ? (plan.t2 - plan.entry) / planRisk : null;
    plan.slPct = ((plan.sl - plan.entry) / plan.entry) * 100;
    plan.t1Pct = ((plan.t1 - plan.entry) / plan.entry) * 100;
    plan.t2Pct = ((plan.t2 - plan.entry) / plan.entry) * 100;

    // Volume confirmation as a CONFLUENCE signal (not a veto). Real
    // reversals carry a volume footprint. We measure off the most
    // recent CLOSED bar (index 1) when available — the newest bar may
    // be the still-forming current period (partial volume) which would
    // systematically under-read and mislead. volConfirm = null when the
    // feed has no usable volume (e.g. an index).
    var _vBase   = rawCandles.length >= 3 ? 1 : 0;   // last closed bar
    var _volAvgN = Math.min(20, rawCandles.length - _vBase - 1);
    var _volSum = 0, _volCnt = 0;
    for (var vk = _vBase + 1; vk <= _vBase + _volAvgN; vk++) {
      _volSum += (+rawCandles[vk][5] || 0); _volCnt++;
    }
    var _avgVol = _volCnt > 0 ? _volSum / _volCnt : 0;
    var _curVol = +rawCandles[_vBase][5] || 0;
    var volRatio   = _avgVol > 0 ? _curVol / _avgVol : null;
    var volConfirm = (volRatio == null) ? null : (volRatio >= 1.0);

    return {
      currentPx: currentPx,
      swHigh: swHigh, swLow: swLow,
      fib236: fib236, fib382: fib382, fib500: fib500,
      fib618: fib618, fib786: fib800,
      inZone: inZone,
      inScanScope: inScanScope,
      bounceStatus: bounceStatus,
      touchedZone: touchedZone,
      isRising: isRising,
      fibDirection: fibDirection,
      fibOriginZone: fibOriginZone,
      fibPivotPrice: fibPivotPrice,
      fibPivotBarsAgo: fibPivotBarsAgo,
      zonePos: zonePos,
      volConfirm: volConfirm,
      volRatio: volRatio,
      plan: plan
    };
  }

  // ── Zone of Interest (Supply / Demand) detector ────────────────
  // Identifies institutional supply/demand zones using the standard
  // RBR / DBR / DBD / RBD (leg → base → leg) framework.
  //
  // Design priorities (your money depends on this):
  //  1. Leg = true displacement — the move from first open to last
  //     close must exceed 1× ATR, confirming institutional force.
  //  2. Candle direction is strict: close > open = bull, close < open
  //     = bear. Doji (close == open) never qualifies as a leg candle.
  //  3. Base must be tight consolidation — each candle body < 0.5×
  //     ATR, total wick range < 1.5× ATR.
  //  4. Zone boundaries: proximal = body extremes of base (where
  //     unfilled orders sit), distal = wick extremes (liquidity grab).
  //  5. Freshness: a zone that price closed through is BROKEN and
  //     never shown. Tested (wicked into but held) is flagged.
  //  6. Only zones near current price are shown (within 5× ATR) —
  //     distant historical zones are irrelevant for live trading.
  //  7. Leg-out must be stronger than leg-in (the departure move is
  //     what proves the zone matters).

  function detectZones(rawCandles) {
    if (!rawCandles || rawCandles.length < 25) return [];

    // Work oldest-first (index 0 = oldest candle).
    var c = rawCandles.slice().reverse();
    var n = c.length;
    var currentPx = +c[n - 1][4];

    // ── Diagnostic (always computed — cheap) ────────────────────
    // Tracks, per zone type, how many DEMAND / SUPPLY structures were
    // found and which gate dropped each one. Surfaced to the UI (so
    // the chart can EXPLAIN why a zone is absent) and dumped to the
    // console when `window.__zoiDebug = true`. Pure bookkeeping — it
    // does NOT alter which zones are produced.
    var DBG = (typeof window !== 'undefined' && window.__zoiDebug);
    function newDiag() {
      return {
        structures: 0, rejWeakLegOut: 0, rejWidthTiny: 0, rejWidthWide: 0,
        rejBroken: 0, rejFar: 0, rejOvershoot: 0, rejScore: 0, accepted: 0,
        nearestFar: null, nearestBroken: null
      };
    }
    var diag = { DEMAND: newDiag(), SUPPLY: newDiag() };
    function dbgRow(zoneType, reason, extra) {
      if (!DBG) return;
      var row = { reason: reason };
      for (var key in extra) if (extra.hasOwnProperty(key)) row[key] = extra[key];
      console.log('[ZOI ' + String(zoneType).toLowerCase() + ']', reason, row);
    }

    var atrVals = atr(c, 14);
    var vols = c.map(function (k) { return +k[5] || 0; });
    var volSma = sma(vols, 20);

    function hi(i)      { return +c[i][2]; }
    function lo(i)      { return +c[i][3]; }
    function cl(i)      { return +c[i][4]; }
    function op(i)      { return +c[i][1]; }
    function vol(i)     { return +c[i][5] || 0; }
    function body(i)    { return Math.abs(cl(i) - op(i)); }
    function range(i)   { var r = hi(i) - lo(i); return r > 0 ? r : 0.01; }
    function bodyTop(i) { return Math.max(op(i), cl(i)); }
    function bodyBot(i) { return Math.min(op(i), cl(i)); }
    function isBull(i)  { return cl(i) > op(i); }
    function isBear(i)  { return cl(i) < op(i); }
    // ATR at bar i — used for formation quality (was the move strong
    // relative to the volatility AT THAT MOMENT).
    function atrAt(i) {
      return isFinite(atrVals[i]) && atrVals[i] > 0 ? atrVals[i] : 0;
    }
    // Recent ATR — average of last 7 bars' true ranges. Used ONLY for
    // the proximity filter (is this zone relevant to WHERE PRICE IS NOW).
    // After a huge rally + pullback, ATR-14 stays inflated from the rally
    // period, making the proximity window too wide or too narrow.
    // A 7-bar lookback reflects the current calm.
    function recentAtr() {
      var sum = 0, cnt = 0;
      for (var ri = Math.max(1, n - 7); ri < n; ri++) {
        var tr = Math.max(hi(ri) - lo(ri),
          Math.abs(hi(ri) - cl(ri - 1)),
          Math.abs(lo(ri) - cl(ri - 1)));
        sum += tr; cnt++;
      }
      return cnt > 0 ? sum / cnt : atrAt(n - 1);
    }

    // Detect a directional leg: 1–4 consecutive strong candles.
    // dir: 1 = bullish rally, -1 = bearish drop.
    // Returns { end, displacement, avgVol, maxVol, len } or null.
    function detectLeg(start, dir) {
      if (start >= n) return null;
      var a = atrAt(start);
      if (!a) return null;

      var legEnd = start - 1;
      var totalVol = 0;
      var maxVol = 0;

      for (var k = start; k < Math.min(start + 5, n); k++) {
        if (dir === 1 && !isBull(k)) break;
        if (dir === -1 && !isBear(k)) break;

        // Body should dominate (strong move, not indecisive wick).
        if (body(k) / range(k) < 0.45) break;

        totalVol += vol(k);
        if (vol(k) > maxVol) maxVol = vol(k);
        legEnd = k;
      }

      var legLen = legEnd - start + 1;
      if (legLen < 1) return null;

      var displacement = (dir === 1)
        ? cl(legEnd) - op(start)
        : op(start) - cl(legEnd);

      if (displacement < a * 0.8) return null;

      return {
        end: legEnd,
        displacement: displacement,
        avgVol: totalVol / legLen,
        maxVol: maxVol,
        len: legLen
      };
    }

    // Detect a consolidation base: 1–4 small-bodied candles.
    function detectBase(start) {
      if (start >= n) return null;
      var a = atrAt(start);
      if (!a) return null;

      var baseEnd = start - 1;
      var wickHi = -Infinity, wickLo = Infinity;
      var bTop = -Infinity, bBot = Infinity;

      for (var k = start; k < Math.min(start + 5, n); k++) {
        if (body(k) > a * 0.6) break;

        wickHi = Math.max(wickHi, hi(k));
        wickLo = Math.min(wickLo, lo(k));
        bTop   = Math.max(bTop, bodyTop(k));
        bBot   = Math.min(bBot, bodyBot(k));
        baseEnd = k;
      }

      var baseLen = baseEnd - start + 1;
      if (baseLen < 1) return null;

      if ((wickHi - wickLo) > a * 2.0) return null;

      return {
        end: baseEnd, len: baseLen,
        bodyHi: bTop, bodyLo: bBot,
        wickHi: wickHi, wickLo: wickLo
      };
    }

    var zones = [];

    // Scan candles — start after ATR warm-up (need ~15 bars).
    for (var i = 15; i < n - 4; i++) {
      var a = atrAt(i);
      if (!a) continue;

      // Try both leg-in directions.
      for (var dir = -1; dir <= 1; dir += 2) {
        var legIn = detectLeg(i, dir);
        if (!legIn) continue;

        var base = detectBase(legIn.end + 1);
        if (!base) continue;

        // Leg-out must exist in a specific direction per pattern type.
        for (var outDir = -1; outDir <= 1; outDir += 2) {
          var legOut = detectLeg(base.end + 1, outDir);
          if (!legOut) continue;

          // outDir === 1 (up leg-out) => DEMAND candidate (RBR / DBR);
          // outDir === -1 (down leg-out) => SUPPLY candidate (RBD / DBD).
          var _candType = (outDir === 1) ? 'DEMAND' : 'SUPPLY';
          diag[_candType].structures++;

          if (legOut.displacement < legIn.displacement * 0.5) {
            diag[_candType].rejWeakLegOut++;
            dbgRow(_candType, 'leg-out weaker than half of leg-in', {
              formationIdx: i, legOutDisp: +legOut.displacement.toFixed(2),
              legInDisp: +legIn.displacement.toFixed(2)
            });
            continue;
          }

          // Classify pattern.
          var pattern, zoneType;
          if (dir === 1  && outDir === 1)  { pattern = 'RBR'; zoneType = 'DEMAND'; }
          else if (dir === -1 && outDir === 1)  { pattern = 'DBR'; zoneType = 'DEMAND'; }
          else if (dir === -1 && outDir === -1) { pattern = 'DBD'; zoneType = 'SUPPLY'; }
          else if (dir === 1  && outDir === -1) { pattern = 'RBD'; zoneType = 'SUPPLY'; }
          else continue;

          // Zone boundaries from the base candles.
          var proximal, distal;
          if (zoneType === 'DEMAND') {
            proximal = base.bodyHi;   // upper body edge — unfilled buy orders
            distal   = base.wickLo;   // lowest wick — liquidity sweep level
          } else {
            proximal = base.bodyLo;   // lower body edge — unfilled sell orders
            distal   = base.wickHi;   // highest wick — liquidity sweep level
          }

          var zoneWidth = Math.abs(proximal - distal);
          if (zoneWidth < a * 0.05) {
            diag[zoneType].rejWidthTiny++;
            dbgRow(zoneType, 'zone too thin (< 0.05x ATR)', {
              formationIdx: i, pattern: pattern,
              zoneWidth: +zoneWidth.toFixed(2), atr: +a.toFixed(2)
            });
            continue;
          }
          if (zoneWidth > a * 4.0) {
            diag[zoneType].rejWidthWide++;
            dbgRow(zoneType, 'zone too wide (> 4x ATR)', {
              formationIdx: i, pattern: pattern,
              zoneWidth: +zoneWidth.toFixed(2), atr: +a.toFixed(2)
            });
            continue;
          }

          // Freshness: scan all candles AFTER the formation.
          var freshness = 'FRESH';
          var testCount = 0;
          for (var f = legOut.end + 1; f < n; f++) {
            var inZone = (zoneType === 'DEMAND')
              ? lo(f) <= proximal && hi(f) >= distal
              : hi(f) >= proximal && lo(f) <= distal;

            var brokeThrough = (zoneType === 'DEMAND')
              ? cl(f) < distal
              : cl(f) > distal;

            if (brokeThrough) { freshness = 'BROKEN'; break; }
            if (inZone) { testCount++; freshness = 'TESTED'; }
          }

          if (freshness === 'BROKEN') {
            diag[zoneType].rejBroken++;
            if (!diag[zoneType].nearestBroken) {
              diag[zoneType].nearestBroken = { proximal: proximal, distal: distal };
            }
            dbgRow(zoneType, 'BROKEN: price later closed through the zone', {
              formationIdx: i, pattern: pattern,
              proximal: +proximal.toFixed(2), distal: +distal.toFixed(2),
              currentPx: +currentPx.toFixed(2)
            });
            continue;
          }

          var proxAtr = recentAtr() || a;
          var distFromPx = (zoneType === 'DEMAND')
            ? currentPx - proximal
            : proximal - currentPx;
          if (distFromPx > proxAtr * 8) {
            diag[zoneType].rejFar++;
            if (!diag[zoneType].nearestFar || distFromPx < diag[zoneType].nearestFar.distFromPx) {
              diag[zoneType].nearestFar = { proximal: proximal, distFromPx: distFromPx };
            }
            dbgRow(zoneType, 'TOO FAR: zone is > 8x recentATR from price', {
              formationIdx: i, pattern: pattern,
              distFromPx: +distFromPx.toFixed(2), limit: +(proxAtr * 8).toFixed(2),
              proximal: +proximal.toFixed(2), currentPx: +currentPx.toFixed(2),
              recentAtr: +proxAtr.toFixed(2)
            });
            continue;
          }
          if (distFromPx < -proxAtr * 3) {
            diag[zoneType].rejOvershoot++;
            dbgRow(zoneType, 'OVERSHOOT: price already > 3x recentATR past the zone', {
              formationIdx: i, pattern: pattern,
              distFromPx: +distFromPx.toFixed(2), limit: +(-proxAtr * 3).toFixed(2),
              proximal: +proximal.toFixed(2), currentPx: +currentPx.toFixed(2),
              recentAtr: +proxAtr.toFixed(2)
            });
            continue;
          }

          // Score (0–100) — weighted by what matters to a real trader.
          var score = 0;

          // 1. Displacement strength of leg-out (0–25 pts).
          var dispMult = legOut.displacement / a;
          score += Math.min(25, Math.round(dispMult * 10));

          // 2. Volume spike on leg-out vs average (0–20 pts).
          var vs = isFinite(volSma[base.end]) && volSma[base.end] > 0
            ? volSma[base.end] : 1;
          var volMult = legOut.maxVol / vs;
          score += Math.min(20, Math.round(Math.max(0, volMult - 1) * 15));

          // 3. Base tightness — tight = strong unfilled orders (0–20 pts).
          var baseAtr = atrAt(base.end) || a;
          var baseRatio = (base.wickHi - base.wickLo) / baseAtr;
          score += Math.round(Math.max(0, 1 - baseRatio / 2.0) * 20);

          // 4. Freshness (0–20 pts).
          score += (freshness === 'FRESH') ? 20 : Math.max(0, 15 - testCount * 5);

          // 5. Reversal > continuation (0–15 pts).
          score += (pattern === 'DBR' || pattern === 'RBD') ? 15 : 8;

          score = Math.max(0, Math.min(100, score));
          if (score < 30) {
            diag[zoneType].rejScore++;
            dbgRow(zoneType, 'SCORE too low (< 30)', {
              formationIdx: i, pattern: pattern, score: score,
              proximal: +proximal.toFixed(2), distal: +distal.toFixed(2)
            });
            continue;
          }
          diag[zoneType].accepted++;

          var PATTERN_LABELS = {
            RBR: 'Rally \u2192 Base \u2192 Rally',
            DBR: 'Drop \u2192 Base \u2192 Rally',
            DBD: 'Drop \u2192 Base \u2192 Drop',
            RBD: 'Rally \u2192 Base \u2192 Drop'
          };

          zones.push({
            type: zoneType,
            pattern: pattern,
            patternLabel: PATTERN_LABELS[pattern] || pattern,
            proximal: proximal,
            distal: distal,
            freshness: freshness,
            score: score,
            formationIdx: i,
            testCount: testCount,
            reason: {
              dispMultiple: Math.round(dispMult * 10) / 10,
              volMultiple: Math.round(volMult * 10) / 10,
              baseTightness: Math.round((1 - baseRatio / 1.5) * 100),
              legInBars: legIn.len,
              legOutBars: legOut.len,
              baseBars: base.len,
              legOutDisp: Math.round(legOut.displacement * 100) / 100,
              atr: Math.round(a * 100) / 100
            }
          });
        }
      }
    }

    // Deduplicate: if two zones of the same type overlap, keep the
    // one with the higher score (it has better structure).
    zones.sort(function (a, b) { return b.score - a.score; });
    var kept = [];
    for (var zi = 0; zi < zones.length; zi++) {
      var zone = zones[zi];
      var dup = false;
      var zTop = Math.max(zone.proximal, zone.distal);
      var zBot = Math.min(zone.proximal, zone.distal);
      var latA = recentAtr() || 1;
      for (var ki = 0; ki < kept.length; ki++) {
        var ex = kept[ki];
        if (ex.type !== zone.type) continue;
        var eTop = Math.max(ex.proximal, ex.distal);
        var eBot = Math.min(ex.proximal, ex.distal);
        // Overlap OR within 0.5× ATR of each other.
        if (zBot <= eTop + latA * 0.5 && zTop >= eBot - latA * 0.5) {
          dup = true; break;
        }
      }
      if (!dup) kept.push(zone);
    }

    function distToPx(z) {
      var mid = (z.proximal + z.distal) / 2;
      return Math.abs(currentPx - mid);
    }
    var demand = kept.filter(function (z) { return z.type === 'DEMAND'; })
      .sort(function (a, b) { return distToPx(a) - distToPx(b); }).slice(0, 4);
    var supply = kept.filter(function (z) { return z.type === 'SUPPLY'; })
      .sort(function (a, b) { return distToPx(a) - distToPx(b); }).slice(0, 4);

    var finalAtr = recentAtr() || 0;

    // Human-readable explanation of WHY a side has no shown zone.
    // Returns null when at least one zone of that type is displayed.
    function buildAbsenceReason(label, d, shownCount) {
      if (shownCount > 0) return null;
      if (d.structures === 0) {
        return 'No valid base-and-leg structure (Rally/Drop \u2192 tight '
          + 'Base \u2192 Rally/Drop) has formed in the visible history.';
      }
      var reasons = [];
      if (d.rejBroken) {
        reasons.push({ n: d.rejBroken, txt: (d.rejBroken > 1 ? 'The ' + d.rejBroken + ' nearest candidates were' : 'The only candidate was')
          + ' already broken \u2014 price has traded through them.' });
      }
      if (d.rejFar) {
        var farTxt = 'The nearest one is beyond the relevant range (8\u00d7ATR).';
        if (d.nearestFar && currentPx > 0) {
          var pct = Math.round(Math.abs(d.nearestFar.proximal - currentPx) / currentPx * 100);
          farTxt = 'Nearest one (\u20B9' + Math.round(d.nearestFar.proximal) + ', ~'
            + pct + '% away) is beyond the relevant range (8\u00d7ATR \u2248 \u20B9'
            + Math.round(finalAtr * 8) + ').';
        }
        reasons.push({ n: d.rejFar, txt: farTxt });
      }
      if (d.rejScore) reasons.push({ n: d.rejScore, txt: d.rejScore + ' candidate(s) scored below the reliability threshold (30).' });
      if (d.rejWidthWide) reasons.push({ n: d.rejWidthWide, txt: d.rejWidthWide + ' base(s) were too wide/loose to be reliable.' });
      if (d.rejWidthTiny) reasons.push({ n: d.rejWidthTiny, txt: d.rejWidthTiny + ' base(s) were too thin to be meaningful.' });
      if (d.rejOvershoot) reasons.push({ n: d.rejOvershoot, txt: d.rejOvershoot + ' candidate(s) were already overshot by price.' });
      if (d.rejWeakLegOut) reasons.push({ n: d.rejWeakLegOut, txt: d.rejWeakLegOut + ' candidate(s) had too weak a departure move.' });
      if (!reasons.length) return 'None near current price.';
      reasons.sort(function (x, y) { return y.n - x.n; });
      return reasons[0].txt;
    }

    function packRej(d) {
      return {
        weakLegOut: d.rejWeakLegOut, widthTiny: d.rejWidthTiny, widthWide: d.rejWidthWide,
        broken: d.rejBroken, tooFar: d.rejFar, overshoot: d.rejOvershoot, lowScore: d.rejScore
      };
    }

    var result = demand.concat(supply);
    result.diag = {
      currentPx: currentPx,
      recentAtr: finalAtr,
      demand: { shown: demand.length, structures: diag.DEMAND.structures, rejected: packRej(diag.DEMAND) },
      supply: { shown: supply.length, structures: diag.SUPPLY.structures, rejected: packRej(diag.SUPPLY) },
      reasonDemand: buildAbsenceReason('demand', diag.DEMAND, demand.length),
      reasonSupply: buildAbsenceReason('supply', diag.SUPPLY, supply.length)
    };

    if (DBG) {
      console.log('[ZOI] SUMMARY', {
        currentPx: +currentPx.toFixed(2),
        recentAtr: +finalAtr.toFixed(2),
        demand: { structures: diag.DEMAND.structures, rejected: packRej(diag.DEMAND), shown: demand.length, reason: result.diag.reasonDemand },
        supply: { structures: diag.SUPPLY.structures, rejected: packRej(diag.SUPPLY), shown: supply.length, reason: result.diag.reasonSupply }
      });
    }

    return result;
  }

  // ═══════════════════════════════════════════════════════════════
  // SMART MONEY CONCEPTS — Fair Value Gap (FVG)
  //
  // A 3-candle imbalance: the middle candle moved so fast that a gap
  // exists between candle 1's wick and candle 3's wick. Price tends
  // to return and "fill" these gaps. Bullish FVG = gap above (buy
  // opportunity when price retraces down into it). Bearish FVG = gap
  // below (sell opportunity when price retraces up into it).
  // ═══════════════════════════════════════════════════════════════

  function detectFVG(rawCandles) {
    if (!rawCandles || rawCandles.length < 20) return [];

    var c = rawCandles.slice().reverse();
    var n = c.length;
    var atrVals = atr(c, 14);

    function hi(i) { return +c[i][2]; }
    function lo(i) { return +c[i][3]; }
    function cl(i) { return +c[i][4]; }
    function op(i) { return +c[i][1]; }
    function atrAt(i) {
      return isFinite(atrVals[i]) && atrVals[i] > 0 ? atrVals[i] : 0;
    }

    var gaps = [];

    for (var i = 1; i < n - 1; i++) {
      var a = atrAt(i);
      if (!a) continue;

      var bullGap = lo(i + 1) - hi(i - 1);
      var bearGap = lo(i - 1) - hi(i + 1);

      var type = null, gapTop = 0, gapBot = 0, gapSize = 0;

      if (bullGap > 0) {
        type = 'BULL';
        gapTop = lo(i + 1);
        gapBot = hi(i - 1);
        gapSize = bullGap;
      } else if (bearGap > 0) {
        type = 'BEAR';
        gapTop = lo(i - 1);
        gapBot = hi(i + 1);
        gapSize = bearGap;
      }

      if (!type) continue;
      if (gapSize < a * 0.3) continue;

      var ce = (gapTop + gapBot) / 2;
      var fillPct = 0;
      var filled = false;

      for (var f = i + 2; f < n; f++) {
        if (type === 'BULL') {
          if (lo(f) <= ce) { fillPct = 100; filled = true; break; }
          if (lo(f) < gapTop) {
            var pct = (gapTop - lo(f)) / gapSize * 100;
            if (pct > fillPct) fillPct = pct;
          }
        } else {
          if (hi(f) >= ce) { fillPct = 100; filled = true; break; }
          if (hi(f) > gapBot) {
            var pct2 = (hi(f) - gapBot) / gapSize * 100;
            if (pct2 > fillPct) fillPct = pct2;
          }
        }
      }

      if (fillPct >= 90) continue;

      var atrRatio = Math.round(gapSize / a * 100) / 100;
      var score = Math.min(100, Math.round(atrRatio * 30));
      if (fillPct < 10) score += 20;
      else if (fillPct < 50) score += 10;
      if (i > n * 0.7) score += 15;

      gaps.push({
        type: type,
        top: gapTop,
        bottom: gapBot,
        midIdx: i,
        formed: c[i][0],
        filled: filled,
        fillPct: Math.round(fillPct),
        atrRatio: atrRatio,
        gapSize: Math.round(gapSize * 100) / 100,
        score: Math.min(100, score)
      });
    }

    gaps.sort(function (a, b) { return b.score - a.score; });
    var bulls = gaps.filter(function (g) { return g.type === 'BULL'; }).slice(0, 3);
    var bears = gaps.filter(function (g) { return g.type === 'BEAR'; }).slice(0, 3);
    return bulls.concat(bears);
  }

  // ═══════════════════════════════════════════════════════════════
  // SMART MONEY CONCEPTS — Break of Structure (BOS) / Change of
  // Character (CHoCH)
  //
  // Tracks swing highs and swing lows to classify market structure.
  // BOS = trend continuation (price breaks past a swing in the
  // direction of the existing trend). CHoCH = trend reversal (price
  // breaks past a swing AGAINST the current trend, signalling a
  // potential direction change).
  // ═══════════════════════════════════════════════════════════════

  var BOS_PIVOT_BY_TF = {
    '1mo': 2,
    '1w':  3,
    '1d':  5,
    '4h':  5,
    '1h':  5,
    '30m': 5,
    '15m': 5,
    '5m':  5
  };

  function detectStructureBreaks(rawCandles, opts) {
    if (!rawCandles || rawCandles.length < 20) {
      return { breaks: [], trend: 'RANGING', swings: [] };
    }

    var c = rawCandles.slice().reverse();
    var n = c.length;
    var PIVOT = (opts && opts.pivot) ? opts.pivot : 5;

    function hi(i) { return +c[i][2]; }
    function lo(i) { return +c[i][3]; }
    function cl(i) { return +c[i][4]; }

    var swingHighs = [];
    var swingLows = [];

    for (var i = PIVOT; i < n - PIVOT; i++) {
      var isHigh = true, isLow = true;
      for (var j = 1; j <= PIVOT; j++) {
        if (hi(i) <= hi(i - j) || hi(i) <= hi(i + j)) isHigh = false;
        if (lo(i) >= lo(i - j) || lo(i) >= lo(i + j)) isLow = false;
      }
      if (isHigh) swingHighs.push({ price: hi(i), barIdx: i });
      if (isLow) swingLows.push({ price: lo(i), barIdx: i });
    }

    var allSwings = [];
    for (var shi = 0; shi < swingHighs.length; shi++) {
      allSwings.push({ kind: 'HIGH', price: swingHighs[shi].price, barIdx: swingHighs[shi].barIdx });
    }
    for (var sli = 0; sli < swingLows.length; sli++) {
      allSwings.push({ kind: 'LOW', price: swingLows[sli].price, barIdx: swingLows[sli].barIdx });
    }
    allSwings.sort(function (a, b) { return a.barIdx - b.barIdx; });

    var labelledSwings = [];
    var prevHigh = null, prevLow = null;

    for (var si = 0; si < allSwings.length; si++) {
      var sw = allSwings[si];
      var label;
      if (sw.kind === 'HIGH') {
        if (!prevHigh) { label = 'HH'; }
        else { label = sw.price > prevHigh.price ? 'HH' : 'LH'; }
        prevHigh = sw;
      } else {
        if (!prevLow) { label = 'HL'; }
        else { label = sw.price > prevLow.price ? 'HL' : 'LL'; }
        prevLow = sw;
      }
      labelledSwings.push({ type: label, kind: sw.kind, price: sw.price, barIdx: sw.barIdx });
    }

    var trend = 'RANGING';
    var breaks = [];

    var lastSwingHigh = null, lastSwingLow = null;

    for (var bi = 0; bi < labelledSwings.length; bi++) {
      var s = labelledSwings[bi];

      if (s.kind === 'HIGH') {
        if (lastSwingHigh) {
          for (var k = lastSwingHigh.barIdx + 1; k <= s.barIdx && k < n; k++) {
            if (cl(k) > lastSwingHigh.price) {
              var breakType = (trend === 'BULLISH' || trend === 'RANGING') ? 'BOS' : 'CHOCH';
              var breakDir = 'BULL';
              breaks.push({
                type: breakType, direction: breakDir,
                level: lastSwingHigh.price, barIdx: k,
                swingIdx: lastSwingHigh.barIdx
              });
              if (breakType === 'CHOCH') trend = 'BULLISH';
              else if (trend === 'RANGING') trend = 'BULLISH';
              break;
            }
          }
        }
        lastSwingHigh = s;
      } else {
        if (lastSwingLow) {
          for (var k2 = lastSwingLow.barIdx + 1; k2 <= s.barIdx && k2 < n; k2++) {
            if (cl(k2) < lastSwingLow.price) {
              var breakType2 = (trend === 'BEARISH' || trend === 'RANGING') ? 'BOS' : 'CHOCH';
              var breakDir2 = 'BEAR';
              breaks.push({
                type: breakType2, direction: breakDir2,
                level: lastSwingLow.price, barIdx: k2,
                swingIdx: lastSwingLow.barIdx
              });
              if (breakType2 === 'CHOCH') trend = 'BEARISH';
              else if (trend === 'RANGING') trend = 'BEARISH';
              break;
            }
          }
        }
        lastSwingLow = s;
      }
    }

    return {
      breaks: breaks.slice(-10),
      trend: trend,
      swings: labelledSwings
    };
  }

  function recentSwingTrend(bosResult) {
    if (!bosResult || !bosResult.swings || bosResult.swings.length < 4) {
      return bosResult ? bosResult.trend : 'RANGING';
    }
    var swings = bosResult.swings;
    var lastHigh = null, prevHigh = null, lastLow = null, prevLow = null;
    for (var si = swings.length - 1; si >= 0; si--) {
      var sw = swings[si];
      if (sw.kind === 'HIGH') {
        if (!lastHigh) lastHigh = sw;
        else if (!prevHigh) prevHigh = sw;
      } else {
        if (!lastLow) lastLow = sw;
        else if (!prevLow) prevLow = sw;
      }
      if (lastHigh && prevHigh && lastLow && prevLow) break;
    }
    var highBull = (lastHigh && prevHigh) ? lastHigh.price > prevHigh.price : false;
    var lowBull  = (lastLow && prevLow)   ? lastLow.price > prevLow.price   : false;
    if (highBull && lowBull)       return 'BULLISH';
    if (!highBull && !lowBull)     return 'BEARISH';
    return 'RANGING';
  }

  // ═══════════════════════════════════════════════════════════════
  // SMART MONEY CONCEPTS — Order Blocks (OB)
  //
  // An Order Block is the LAST opposite-colour candle before a strong
  // displacement move that BREAKS market structure (BoS / CHoCH).
  // Institutions accumulate inside that last candle, then drive price
  // away hard; when price later returns to the candle's range, the
  // unfilled orders defend it — a high-probability reaction zone.
  //
  //   • Bullish OB (demand) = last DOWN candle before an up-move that
  //     closed above a prior swing high. Zone = that candle's low→high.
  //   • Bearish OB (supply) = last UP candle before a down-move that
  //     closed below a prior swing low. Zone = that candle's low→high.
  //
  // Confirmed bars only (anchored on detectStructureBreaks, which works
  // on closed candles) — never computed off the live, still-forming bar.
  // Mirrors detectZones' freshness model: FRESH (never revisited),
  // MITIGATED (tapped but not closed through), BROKEN (closed through →
  // discarded). A same-direction FVG inside the displacement leg is a
  // confluence bonus, not a requirement. Conservative score threshold
  // (≥ 40) — OB is a higher-conviction tool; prefer fewer, cleaner blocks.
  // ═══════════════════════════════════════════════════════════════

  function detectOrderBlocks(rawCandles, tf) {
    if (!rawCandles || rawCandles.length < 25) return [];

    // Work oldest-first (index 0 = oldest) — same convention as the
    // other SMC detectors so barIdx values line up with detectStructureBreaks.
    var c = rawCandles.slice().reverse();
    var n = c.length;
    var currentPx = +c[n - 1][4];
    var atrVals = atr(c, 14);

    function hi(i)     { return +c[i][2]; }
    function lo(i)     { return +c[i][3]; }
    function cl(i)     { return +c[i][4]; }
    function op(i)     { return +c[i][1]; }
    function vol(i)    { return +c[i][5] || 0; }
    function isBull(i) { return cl(i) > op(i); }
    function isBear(i) { return cl(i) < op(i); }
    function atrAt(i)  { return isFinite(atrVals[i]) && atrVals[i] > 0 ? atrVals[i] : 0; }

    // Recent ATR (last 7 true ranges) — proximity yardstick relative to
    // where price is NOW (ATR-14 stays inflated after a big move).
    function recentAtr() {
      var sum = 0, cnt = 0;
      for (var ri = Math.max(1, n - 7); ri < n; ri++) {
        var tr = Math.max(hi(ri) - lo(ri),
          Math.abs(hi(ri) - cl(ri - 1)),
          Math.abs(lo(ri) - cl(ri - 1)));
        sum += tr; cnt++;
      }
      return cnt > 0 ? sum / cnt : atrAt(n - 1);
    }

    var bos = detectStructureBreaks(rawCandles, { pivot: BOS_PIVOT_BY_TF[tf] || 5 });
    if (!bos || !bos.breaks || !bos.breaks.length) return [];

    // FVG confluence — computed once; detectFVG returns gaps in the same
    // reversed-array coordinate space (midIdx).
    var fvgs = detectFVG(rawCandles) || [];

    var rAtr = recentAtr() || atrAt(n - 1) || 0;
    var blocks = [];

    // Read-only diagnostic — explains WHY a timeframe shows few/no order
    // blocks (every candidate that was dropped is counted by reason). Pure
    // bookkeeping; does not affect which blocks are produced. Surfaced on
    // the returned array as `.diag` (mirrors detectZones' diagnostic).
    var diag = {
      breaks: bos.breaks.length, noOb: 0, widthThin: 0, widthWide: 0,
      weakDisp: 0, broken: 0, tooFar: 0, lowScore: 0, accepted: 0,
      nearestTooFar: null
    };

    for (var bi = 0; bi < bos.breaks.length; bi++) {
      var brk = bos.breaks[bi];
      var breakBar = brk.barIdx;          // bar whose CLOSE broke the level
      if (!(breakBar > 0 && breakBar < n)) continue;
      var dir = brk.direction;            // 'BULL' | 'BEAR'
      var a = atrAt(breakBar) || rAtr;
      if (!a) continue;

      // Walk back through the impulse candles to the last opposite candle.
      var obIdx = -1;
      for (var k = breakBar; k >= Math.max(0, breakBar - 10); k--) {
        if (dir === 'BULL' && isBear(k)) { obIdx = k; break; }
        if (dir === 'BEAR' && isBull(k)) { obIdx = k; break; }
      }
      if (obIdx < 0 || obIdx >= breakBar) { diag.noOb++; continue; }   // no clean OB before the break

      // Zone = the OB candle's full range. Proximal = the edge price
      // re-enters from; distal = the protective (stop) edge.
      var obHi = hi(obIdx), obLo = lo(obIdx);
      var proximal, distal;
      if (dir === 'BULL') { proximal = obHi; distal = obLo; }  // demand: enter from above, stop below
      else                { proximal = obLo; distal = obHi; }  // supply: enter from below, stop above

      var zoneWidth = Math.abs(obHi - obLo);
      if (zoneWidth < a * 0.05) { diag.widthThin++; continue; }   // doji-thin, no usable zone
      if (zoneWidth > a * 4.0)  { diag.widthWide++; continue; }   // unusually wide bar, unreliable

      // Displacement strength — how far the impulse drove past the OB.
      var displacement = (dir === 'BULL')
        ? cl(breakBar) - obLo
        : obHi - cl(breakBar);
      if (displacement < a * 0.8) { diag.weakDisp++; continue; }  // weak break, skip
      var dispMult = displacement / a;

      // Freshness / mitigation — scan candles AFTER the break.
      var freshness = 'FRESH';
      var mitigations = 0;
      for (var f = breakBar + 1; f < n; f++) {
        var brokeThrough = (dir === 'BULL') ? cl(f) < distal : cl(f) > distal;
        if (brokeThrough) { freshness = 'BROKEN'; break; }
        var inZone = (dir === 'BULL')
          ? (lo(f) <= proximal && hi(f) >= distal)
          : (hi(f) >= proximal && lo(f) <= distal);
        if (inZone) { mitigations++; freshness = 'MITIGATED'; }
      }
      if (freshness === 'BROKEN') { diag.broken++; continue; }    // invalidated — never emit

      // Proximity — discard blocks far from current price (irrelevant now).
      var pAtr = rAtr || a;
      var zTop = Math.max(proximal, distal);
      var zBot = Math.min(proximal, distal);
      var distFromPx = (currentPx > zTop) ? currentPx - zTop
        : (currentPx < zBot) ? zBot - currentPx : 0;
      if (distFromPx > pAtr * 8) {
        diag.tooFar++;
        if (!diag.nearestTooFar || distFromPx < diag.nearestTooFar) diag.nearestTooFar = distFromPx;
        continue;
      }

      // Same-direction FVG inside the displacement leg = confluence bonus.
      var fvgConfirmed = false;
      for (var gi = 0; gi < fvgs.length; gi++) {
        var g = fvgs[gi];
        if (g.type !== dir) continue;
        if (g.midIdx > obIdx && g.midIdx <= breakBar + 2) { fvgConfirmed = true; break; }
      }

      // Score (0–100).
      var score = 0;
      score += Math.min(35, Math.round(dispMult * 15));                 // displacement
      score += fvgConfirmed ? 25 : 0;                                   // imbalance confluence
      score += (freshness === 'FRESH') ? 25 : Math.max(0, 20 - mitigations * 5); // freshness
      score += (brk.type === 'BOS') ? 15 : 10;                          // continuation > reversal
      score = Math.max(0, Math.min(100, score));
      if (score < 40) { diag.lowScore++; continue; }
      diag.accepted++;

      // Volume multiple of the OB candle vs surrounding (info only).
      var volRef = 0, vcnt = 0;
      for (var vi = Math.max(0, obIdx - 10); vi < obIdx; vi++) { volRef += vol(vi); vcnt++; }
      var volAvg = vcnt > 0 ? volRef / vcnt : 0;
      var volMult = volAvg > 0 ? Math.round(vol(obIdx) / volAvg * 10) / 10 : 0;

      blocks.push({
        type: dir,
        proximal: proximal,
        distal: distal,
        freshness: freshness,
        mitigations: mitigations,
        score: score,
        breakType: brk.type,                 // 'BOS' | 'CHOCH'
        fvgConfirmed: fvgConfirmed,
        obIdx: obIdx,
        formed: c[obIdx][0],
        reason: {
          dispMultiple: Math.round(dispMult * 10) / 10,
          atr: Math.round(a * 100) / 100,
          breakLevel: Math.round(brk.level * 100) / 100,
          volMultiple: volMult
        }
      });
    }

    // Deduplicate overlapping blocks of the same type — keep higher score.
    blocks.sort(function (x, y) { return y.score - x.score; });
    var kept = [];
    var latA = rAtr || 1;
    for (var zi = 0; zi < blocks.length; zi++) {
      var z = blocks[zi];
      var zT = Math.max(z.proximal, z.distal);
      var zB = Math.min(z.proximal, z.distal);
      var dup = false;
      for (var ki = 0; ki < kept.length; ki++) {
        var ex = kept[ki];
        if (ex.type !== z.type) continue;
        var eT = Math.max(ex.proximal, ex.distal);
        var eB = Math.min(ex.proximal, ex.distal);
        if (zB <= eT + latA * 0.5 && zT >= eB - latA * 0.5) { dup = true; break; }
      }
      if (!dup) kept.push(z);
    }

    function distToPx(z) {
      var mid = (z.proximal + z.distal) / 2;
      return Math.abs(currentPx - mid);
    }
    var bulls = kept.filter(function (z) { return z.type === 'BULL'; })
      .sort(function (x, y) { return distToPx(x) - distToPx(y); }).slice(0, 3);
    var bears = kept.filter(function (z) { return z.type === 'BEAR'; })
      .sort(function (x, y) { return distToPx(x) - distToPx(y); }).slice(0, 3);

    var out = bulls.concat(bears);
    diag.currentPx = currentPx;
    diag.recentAtr = rAtr;
    out.diag = diag;
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  // SMART MONEY CONCEPTS — Liquidity Sweeps
  //
  // Detects when price sweeps past a cluster of equal highs/lows
  // (where retail stop losses accumulate), grabs that liquidity,
  // then reverses. This "sweep and reject" pattern is the signature
  // of institutional order filling.
  // ═══════════════════════════════════════════════════════════════

  function detectLiqSweeps(rawCandles) {
    if (!rawCandles || rawCandles.length < 25) return [];

    var c = rawCandles.slice().reverse();
    var n = c.length;
    var atrVals = atr(c, 14);

    function hi(i) { return +c[i][2]; }
    function lo(i) { return +c[i][3]; }
    function cl(i) { return +c[i][4]; }
    function op(i) { return +c[i][1]; }
    function atrAt(i) {
      return isFinite(atrVals[i]) && atrVals[i] > 0 ? atrVals[i] : 0;
    }

    var WINDOW = 20;
    // A genuine liquidity sweep is a TIGHT poke through the level that
    // immediately rejects — a stop-hunt, not a full breakdown. Cap how
    // far the wick may pierce the pool at 0.75 × ATR. Without this, a
    // deep V-reversal (e.g. a wick plunging ~1 ATR below the level then
    // recovering) was being marked as a "sweep", which (a) diluted signal
    // quality and (b) plotted the ✖ far from its own $$$ line — sometimes
    // landing on a DIFFERENT sweep's line. Conservative by design: prefer
    // missing a loose sweep over flagging a deep bounce as a clean grab.
    var MAX_SWEEP_PEN_ATR = 0.75;
    var clusters = [];

    for (var i = WINDOW; i < n - 3; i++) {
      var a = atrAt(i);
      if (!a) continue;
      var tol = a * 0.15;

      var eqHighs = [i];
      var eqLows = [i];

      for (var j = Math.max(0, i - WINDOW); j < i; j++) {
        if (Math.abs(hi(j) - hi(i)) <= tol) eqHighs.push(j);
        if (Math.abs(lo(j) - lo(i)) <= tol) eqLows.push(j);
      }

      if (eqHighs.length >= 2) {
        var avgHigh = 0;
        for (var eh = 0; eh < eqHighs.length; eh++) avgHigh += hi(eqHighs[eh]);
        avgHigh /= eqHighs.length;
        clusters.push({ type: 'HIGH', level: avgHigh, anchorIdx: i, bars: eqHighs.slice(), size: eqHighs.length });
      }

      if (eqLows.length >= 2) {
        var avgLow = 0;
        for (var el = 0; el < eqLows.length; el++) avgLow += lo(eqLows[el]);
        avgLow /= eqLows.length;
        clusters.push({ type: 'LOW', level: avgLow, anchorIdx: i, bars: eqLows.slice(), size: eqLows.length });
      }
    }

    var sweeps = [];
    var freshStart = Math.floor(n * 0.6);

    for (var ci2 = 0; ci2 < clusters.length; ci2++) {
      var cluster = clusters[ci2];
      if (cluster.anchorIdx < freshStart) continue;

      for (var s = cluster.anchorIdx + 1; s < n - 1; s++) {
        var a2 = atrAt(s);
        if (!a2) continue;

        if (cluster.type === 'HIGH') {
          if (hi(s) > cluster.level && cl(s) < cluster.level &&
              (hi(s) - cluster.level) <= a2 * MAX_SWEEP_PEN_ATR) {
            var nextBar = s + 1;
            if (nextBar < n && cl(nextBar) < cl(s)) {
              sweeps.push({
                type: 'SWEEP_HIGH',
                level: cluster.level,
                sweepBar: s,
                sweepWick: hi(s),
                reversal: true,
                clusterBars: cluster.bars,
                clusterSize: cluster.size,
                formed: c[s][0]
              });
              break;
            }
          }
        } else {
          if (lo(s) < cluster.level && cl(s) > cluster.level &&
              (cluster.level - lo(s)) <= a2 * MAX_SWEEP_PEN_ATR) {
            var nextBar2 = s + 1;
            if (nextBar2 < n && cl(nextBar2) > cl(s)) {
              sweeps.push({
                type: 'SWEEP_LOW',
                level: cluster.level,
                sweepBar: s,
                sweepWick: lo(s),
                reversal: true,
                clusterBars: cluster.bars,
                clusterSize: cluster.size,
                formed: c[s][0]
              });
              break;
            }
          }
        }
      }
    }

    var deduped = [];
    for (var di = 0; di < sweeps.length; di++) {
      var dup = false;
      for (var dk = 0; dk < deduped.length; dk++) {
        if (deduped[dk].type === sweeps[di].type &&
            Math.abs(deduped[dk].level - sweeps[di].level) < (atrAt(sweeps[di].sweepBar) || 1) * 0.3) {
          dup = true; break;
        }
      }
      if (!dup) deduped.push(sweeps[di]);
    }

    deduped.sort(function (a, b) { return b.sweepBar - a.sweepBar; });
    return deduped.slice(0, 4);
  }

  // ── Render ─────────────────────────────────────────────────────

  function renderFibResults(results) {
    var tbody = document.getElementById('sw-fib-tbody');
    var panel = document.getElementById('sw-fib-results');
    var countEl = document.getElementById('sw-fib-results-count');
    if (!tbody || !panel) return;

    panel.hidden = false;

    var fp = function (n) {
      return isFinite(n) ? '\u20B9' + Number(n).toFixed(2) : '\u2014';
    };

    var SIGNAL_BADGE = {
      BOUNCE:    '<span class="sw-fib-signal sw-fib-signal--bounce">\u2191 BOUNCE</span>',
      RECOVERY:  '<span class="sw-fib-signal sw-fib-signal--recovery">\u2197 RECOVERY</span>',
      RECOVERED: '<span class="sw-fib-signal sw-fib-signal--above">\u2197 RECOVERED</span>',
      FORMING:   '<span class="sw-fib-signal sw-fib-signal--forming">\u21AF FORMING</span>',
      FALLING:   '<span class="sw-fib-signal sw-fib-signal--falling">\u2193 FALLING</span>',
      ABOVE:     '<span class="sw-fib-signal sw-fib-signal--above">\u2192 ABOVE</span>'
    };

    if (!results || !results.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="sw-fib-empty">No stocks found bouncing from the Fibonacci golden pocket on this timeframe.</td></tr>';
      if (countEl) countEl.textContent = '0 stocks in zone';
      return;
    }

    var bounceCount = results.filter(function (r) { return r.fib.bounceStatus === 'BOUNCE'; }).length;
    var formCount   = results.filter(function (r) { return r.fib.bounceStatus === 'FORMING'; }).length;
    if (countEl) countEl.textContent = results.length === 1
      ? (results[0].fib.bounceStatus === 'BOUNCE'
          ? results[0].sym + ' \u2191 Bouncing from golden pocket'
          : results[0].fib.bounceStatus === 'FORMING'
            ? results[0].sym + ' forming a bounce in zone'
            : results[0].sym + ' \u2014 no bounce signal')
      : bounceCount + ' bounce' + (formCount ? ', ' + formCount + ' forming' : '') + ' of ' + results.length + ' scanned';

    tbody.innerHTML = results.map(function (r, idx) {
      var fib    = r.fib;
      var bs     = fib.bounceStatus || 'FALLING';
      var rrStr  = (fib.plan && fib.plan.rr && isFinite(fib.plan.rr)) ? fib.plan.rr.toFixed(1) : '\u2014';
      var isBuy  = bs === 'BOUNCE' || bs === 'FORMING';
      var rowDim = bs === 'FALLING' || bs === 'ABOVE';

      return ''
        + '<tr data-fidx="' + idx + '" class="sw-fib-row' + (isBuy ? ' sw-fib-row--buy' : '') + '"'
        + (rowDim ? ' style="opacity:0.45"' : '') + '>'
        +   '<td>'
        +     '<div class="sw-fib-sym">' + r.sym + '</div>'
        +     '<div class="sw-fib-name">' + (r.name || '') + '</div>'
        +   '</td>'
        +   '<td>' + (SIGNAL_BADGE[bs] || '') + '</td>'
        +   '<td>' + fp(fib.currentPx) + '</td>'
        +   '<td><span class="sw-fib-rr' + (isBuy ? ' sw-fib-rr--buy' : '') + '">1:' + rrStr + 'R</span></td>'
        + '</tr>';
    }).join('');

    var newTbody = tbody.cloneNode(true);
    tbody.parentNode.replaceChild(newTbody, tbody);
    newTbody.addEventListener('click', function (e) {
      var row = e.target.closest('tr[data-fidx]');
      if (!row) return;
      var idx = parseInt(row.getAttribute('data-fidx'), 10);
      var r = results[idx];
      if (!r) return;
      window.fibScanPick(r.isin, r.sym, r.name || '');
    });
  }

  // ── Scan orchestration ─────────────────────────────────────────

  window.fibScanSetTf = function (tf) {
    FIB_STATE.tf = tf;
    document.querySelectorAll('#sw-fib-tf-group .sw-fib-tf-btn').forEach(function (b) {
      b.classList.toggle('sw-fib-tf-btn--active', b.dataset.tf === tf);
    });
  };

  window.fibScanSetScope = function (scope) {
    FIB_STATE.scope = scope;
    document.querySelectorAll('#sw-fib-scope-group .sw-fib-tf-btn').forEach(function (b) {
      b.classList.toggle('sw-fib-tf-btn--active', b.dataset.scope === scope);
    });
    var symRow = document.getElementById('sw-fib-sym-row');
    if (symRow) symRow.hidden = (scope !== 'stock');
    // Pre-fill with the currently selected stock when switching to 'stock' scope.
    if (scope === 'stock' && STATE.selected && STATE.selected.sym) {
      var inp = document.getElementById('sw-fib-sym-input');
      if (inp && !inp.value) inp.value = STATE.selected.sym;
      FIB_STATE.stockIsin = STATE.selected.isin;
      FIB_STATE.stockSym  = STATE.selected.sym;
    }
  };

  // Symbol autocomplete for single-stock scope.
  window.fibScanSymInput = function (text) {
    text = (text || '').trim().toUpperCase();
    var res = document.getElementById('sw-fib-sym-results');
    if (!res) return;
    if (!text) { res.hidden = true; return; }

    // Collect all stocks from the universe.
    var all = [];
    var seen = {};
    if (SECTOR_STATE.data) {
      (SECTOR_STATE.data.sectors || []).concat(SECTOR_STATE.data.indices || []).forEach(function (g) {
        (g.stocks || []).forEach(function (s) {
          if (!seen[s.isin]) { seen[s.isin] = true; all.push(s); }
        });
      });
    }
    (SECTOR_STATE.customStocks || []).forEach(function (s) {
      if (!seen[s.isin]) { seen[s.isin] = true; all.push(s); }
    });

    var matches = all.filter(function (s) {
      return s.sym.indexOf(text) === 0 || (s.name && s.name.toUpperCase().indexOf(text) >= 0);
    }).slice(0, 10);

    if (!matches.length) { res.hidden = true; return; }

    // Use data attributes — inline JSON.stringify embeds double-quoted strings
    // inside double-quoted HTML attributes, breaking the parser silently.
    // escAttr handles &, ", ', <, > so any company name is safe.
    function escAttr(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    res.innerHTML = matches.map(function (s) {
      return '<div class="sw-fib-sym-opt"'
        + ' data-isin="' + escAttr(s.isin) + '"'
        + ' data-sym="'  + escAttr(s.sym)  + '"'
        + ' data-name="' + escAttr(s.name || '') + '">'
        + '<span class="sw-fib-sym-opt-sym">' + s.sym + '</span>'
        + '<span class="sw-fib-sym-opt-name">' + (s.name || '') + '</span>'
        + '</div>';
    }).join('');

    // Delegated mousedown on the container — fires before blur on the input.
    // event.preventDefault() keeps the input focused so the selection lands.
    res.onmousedown = function (e) {
      e.preventDefault();
      var opt = e.target.closest('.sw-fib-sym-opt');
      if (!opt) return;
      window.fibScanPickSym(opt.dataset.isin, opt.dataset.sym, opt.dataset.name || '');
    };
    res.hidden = false;
  };

  window.fibScanPickSym = function (isin, sym, name) {
    FIB_STATE.stockIsin  = isin;
    FIB_STATE.stockSym   = sym;
    FIB_STATE.stockName  = name || '';
    var inp = document.getElementById('sw-fib-sym-input');
    if (inp) { inp.value = sym; inp.focus(); }
    var res = document.getElementById('sw-fib-sym-results');
    if (res) res.hidden = true;
  };

  // Hide the autocomplete when the user clicks anywhere else on the page.
  document.addEventListener('click', function (e) {
    var res = document.getElementById('sw-fib-sym-results');
    var inp = document.getElementById('sw-fib-sym-input');
    if (res && inp && !inp.contains(e.target) && !res.contains(e.target)) {
      res.hidden = true;
    }
  });

  window.fibScanStop = function () {
    FIB_STATE.aborted = true;
    FIB_STATE.running = false;
    var stopBtn = document.getElementById('sw-fib-stop-btn');
    var runBtn  = document.getElementById('sw-fib-run-btn');
    if (stopBtn) stopBtn.hidden = true;
    if (runBtn)  runBtn.hidden  = false;
    var lbl = document.getElementById('sw-fib-progress-label');
    if (lbl) lbl.textContent = 'Scan stopped.';
  };

  window.fibScanPick = function (isin, sym, name) {
    // Look up the fib result for this stock from the scan results array.
    var found = FIB_STATE.results.find(function (r) { return r.isin === isin; });

    // Set the fib context BEFORE analyze() so renderMainChart can read it.
    FIB_STATE.pendingFib = found ? found.fib : null;
    FIB_STATE.pendingTf  = FIB_STATE.tf;

    // Set STATE.selected directly — do NOT use swingPickGlobalStock because
    // that function has an early-return guard (if (!found) return) which
    // silently skips analyze() when the sector data isn't loaded. Since we
    // already have isin/sym/name from the scan, we can wire analyze() ourselves.
    STATE.selected = { isin: isin, sym: sym || isin, name: name || '' };

    try { analyze(); } catch (e) { console.warn('[fib] analyze failed', e); }

    // Scroll to the result panel once analyze() has had time to start
    // rendering (loading placeholder appears immediately).
    var res = document.getElementById('sw-result');
    if (res) setTimeout(function () { res.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
  };

  // Build the universe to scan based on the current scope setting.
  function fibBuildUniverse() {
    var scope = FIB_STATE.scope;

    // Single-stock scope.
    if (scope === 'stock') {
      var isin = FIB_STATE.stockIsin;
      var sym  = FIB_STATE.stockSym;
      if (!isin) {
        // Try to fall back to the currently selected stock.
        if (STATE.selected && STATE.selected.isin) {
          isin = STATE.selected.isin;
          sym  = STATE.selected.sym;
        }
      }
      if (!isin) return null; // caller will show an error
      return [{ isin: isin, sym: sym || isin, name: FIB_STATE.stockName || '' }];
    }

    // Active-sector scope.
    if (scope === 'sector') {
      var activeSec = SECTOR_STATE.activeSector;
      if (!activeSec || !SECTOR_STATE.data) return []; // empty → caller shows hint
      var group = _swGetGroup(activeSec);
      if (!group || !group.stocks || !group.stocks.length) return [];
      return group.stocks.slice(); // shallow copy
    }

    // Default: entire universe (deduplicated by ISIN).
    var seen = {}, universe = [];
    if (SECTOR_STATE.data) {
      (SECTOR_STATE.data.sectors || []).forEach(function (sec) {
        (sec.stocks || []).forEach(function (s) {
          if (!seen[s.isin]) { seen[s.isin] = true; universe.push(s); }
        });
      });
      (SECTOR_STATE.data.indices || []).forEach(function (ix) {
        (ix.stocks || []).forEach(function (s) {
          if (!seen[s.isin]) { seen[s.isin] = true; universe.push(s); }
        });
      });
    }
    (SECTOR_STATE.customStocks || []).forEach(function (s) {
      if (!seen[s.isin]) { seen[s.isin] = true; universe.push(s); }
    });
    return universe;
  }

  window.fibScanStart = async function () {
    if (FIB_STATE.running) return;
    if (swIsApiPaused()) {
      alert('Swing API is paused. Click "Resume" on the banner before scanning.');
      return;
    }
    var token = getToken();
    if (!token) {
      alert('No Upstox token. Connect via the Options Trading tab → gear icon first.');
      return;
    }

    var universe = fibBuildUniverse();
    if (universe === null) {
      // Single-stock scope but no stock selected.
      alert('No stock selected. Type a symbol in the box or analyse a stock first.');
      return;
    }
    if (!universe.length) {
      var scopeHint = FIB_STATE.scope === 'sector'
        ? 'No active sector. Browse a sector card first, then Scan.'
        : 'No stocks loaded. Browse a sector first.';
      var lbl0 = document.getElementById('sw-fib-progress-label');
      var prog0 = document.getElementById('sw-fib-progress');
      if (prog0) prog0.hidden = false;
      if (lbl0)  lbl0.textContent = scopeHint;
      return;
    }

    FIB_STATE.running = true;
    FIB_STATE.aborted = false;
    FIB_STATE.results = [];

    var runBtn   = document.getElementById('sw-fib-run-btn');
    var stopBtn  = document.getElementById('sw-fib-stop-btn');
    var progress = document.getElementById('sw-fib-progress');
    var bar      = document.getElementById('sw-fib-progress-bar');
    var lbl      = document.getElementById('sw-fib-progress-label');
    var resPanel = document.getElementById('sw-fib-results');

    if (runBtn)   runBtn.hidden   = true;
    if (stopBtn)  stopBtn.hidden  = false;
    if (progress) progress.hidden = false;
    if (resPanel) resPanel.hidden = true;
    if (bar)      bar.style.width = '0%';

    var tf     = FIB_STATE.tf;
    var total  = universe.length;
    var done   = 0;
    var inZone = [];

    for (var i = 0; i < universe.length; i++) {
      if (FIB_STATE.aborted) break;
      var stock = universe[i];
      try {
        var candles = await fetchTf(stock.isin, tf);
        var fib = computeFibZone(candles);
        if (fib) {
          // Include stocks that are in the zone OR have bounced out of it
          // with upward momentum. For single-stock scans always push so the
          // user can see fib levels even if outside the pocket.
          if (fib.inScanScope || total === 1) {
            inZone.push({ sym: stock.sym, isin: stock.isin, name: stock.name, fib: fib });
          }
        }
      } catch (e) { /* skip failed stocks */ }

      done++;
      var pct = Math.round(done / total * 100);
      if (bar) bar.style.width = pct + '%';
      var bounceCount = inZone.filter(function (r) { return r.fib.bounceStatus === 'BOUNCE'; }).length;
      if (lbl) lbl.textContent = total === 1
        ? 'Fetching ' + stock.sym + ' on ' + tf + '…'
        : 'Scanned ' + done + ' / ' + total + ' — ' + bounceCount + ' bounce, ' + inZone.length + ' total';

      if (done % 5 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }

    FIB_STATE.running = false;
    FIB_STATE.results = inZone;

    if (runBtn)  runBtn.hidden  = false;
    if (stopBtn) stopBtn.hidden = true;

    var bounceCount  = inZone.filter(function (r) { return r.fib.bounceStatus === 'BOUNCE'; }).length;
    var formingCount = inZone.filter(function (r) { return r.fib.bounceStatus === 'FORMING'; }).length;
    var endMsg = FIB_STATE.aborted
      ? 'Stopped — ' + bounceCount + ' bounce signals found.'
      : total === 1 && inZone.length
        ? (inZone[0].fib.bounceStatus === 'BOUNCE'
            ? inZone[0].sym + ' \u2191 BOUNCING from golden pocket \u2713'
            : inZone[0].fib.bounceStatus === 'FORMING'
              ? inZone[0].sym + ' is forming a bounce in the zone'
              : inZone[0].sym + ' is falling — no buy signal')
        : 'Done — ' + bounceCount + ' bounce' + (formingCount ? ', ' + formingCount + ' forming' : '') + ' / ' + total + ' scanned';
    if (lbl) lbl.textContent = endMsg;

    // Sort: BOUNCE first → FORMING → FALLING → ABOVE; within each group by R:R desc.
    var BOUNCE_ORDER = { BOUNCE: 0, RECOVERY: 1, FORMING: 2, FALLING: 3, ABOVE: 4 };
    inZone.sort(function (a, b) {
      var oa = BOUNCE_ORDER[a.fib.bounceStatus] || 2;
      var ob = BOUNCE_ORDER[b.fib.bounceStatus] || 2;
      if (oa !== ob) return oa - ob;
      var rrA = (a.fib.plan && a.fib.plan.rr) || 0;
      var rrB = (b.fib.plan && b.fib.plan.rr) || 0;
      return rrB - rrA;
    });

    renderFibResults(inZone);

    // For single-stock scans auto-pick the stock so the chart updates.
    if (total === 1 && inZone.length) {
      setTimeout(function () { window.fibScanPick(inZone[0].isin, inZone[0].sym, inZone[0].name); }, 200);
    }
  };

})();
