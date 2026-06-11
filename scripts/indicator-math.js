// ═══════════════════════════════════════════════════════════════
// INDICATOR MATH LIBRARY — pure technical-analysis functions.
// ═══════════════════════════════════════════════════════════════
// Extracted verbatim from scripts/swing-analyzer.js on 2026-06-05
// (AGENTS.md §18). These are PURE functions on a closes[]/candles[]
// array — no STATE, no DOM, no fetch — so they live in their own IIFE
// and publish two ways:
//   • window.IndicatorMath — namespace consumed by swing-analyzer.js's
//     closure-local alias block (every bare call site keeps working).
//   • the individual window.<fn> globals (classifyStructure, _zigzagFrom,
//     cappedAtrValue, TREND_PARAMS_BY_TF, …) that intraday-analyzer.js +
//     the backtest harness already read.
// MUST load BEFORE swing-analyzer.js + intraday-analyzer.js (shell
// <script defer> order is document order; backtest lib.mjs runs it first).
// ═══════════════════════════════════════════════════════════════
(function indicatorMath() {
  // ═══════════════════════════════════════════════════════════════
  // INDICATOR MATH — pure functions on a closes[] / candles[] array.
  // Candle shape (Upstox V3): [timestamp, open, high, low, close, volume, oi].
  // ═══════════════════════════════════════════════════════════════

  // Standard EMA with the SMA-of-first-`period`-values warmup that
  // every charting platform uses. Returns an array aligned to input
  // (first `period-1` slots are NaN so indices line up with `closes`).
  function ema(values, period) {
    if (!values || values.length < period) return [];
    var k = 2 / (period + 1);
    var out = new Array(values.length).fill(NaN);
    var seed = 0;
    for (var i = 0; i < period; i++) seed += values[i];
    out[period - 1] = seed / period;
    for (var j = period; j < values.length; j++) {
      out[j] = values[j] * k + out[j - 1] * (1 - k);
    }
    return out;
  }

  // Simple Moving Average (SMA). Equally-weighted mean of the last
  // `period` values. Used for the weekly 44 SMA (Bansal's long-term
  // swing-trend filter) — the most widely-cited Indian-retail filter
  // for "is this stock in a long-term uptrend at all?". Returns
  // array aligned to input; first `period-1` slots are NaN.
  function sma(values, period) {
    if (!values || values.length < period) return [];
    var out = new Array(values.length).fill(NaN);
    var sum = 0;
    for (var i = 0; i < period; i++) sum += values[i];
    out[period - 1] = sum / period;
    for (var j = period; j < values.length; j++) {
      sum += values[j] - values[j - period];
      out[j] = sum / period;
    }
    return out;
  }

  // Wilder-smoothed RSI(14). Returns array aligned to input.
  function rsi(closes, period) {
    period = period || 14;
    var n = closes.length;
    var out = new Array(n).fill(NaN);
    if (n < period + 1) return out;
    var gainSum = 0, lossSum = 0;
    for (var i = 1; i <= period; i++) {
      var diff = closes[i] - closes[i - 1];
      if (diff >= 0) gainSum += diff; else lossSum -= diff;
    }
    var avgG = gainSum / period;
    var avgL = lossSum / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (var i2 = period + 1; i2 < n; i2++) {
      var d = closes[i2] - closes[i2 - 1];
      var g = d > 0 ? d : 0;
      var l = d < 0 ? -d : 0;
      avgG = (avgG * (period - 1) + g) / period;
      avgL = (avgL * (period - 1) + l) / period;
      out[i2] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  // MACD(12,26,9). Returns {macd, signal, hist} all aligned to input.
  function macd(closes) {
    var e12 = ema(closes, 12);
    var e26 = ema(closes, 26);
    var line = closes.map(function (_, i) {
      return isFinite(e12[i]) && isFinite(e26[i]) ? e12[i] - e26[i] : NaN;
    });
    // Signal = EMA(9) of MACD line — only defined from idx 25 + 8.
    var validLine = line.filter(isFinite);
    var sig9 = ema(validLine, 9);
    var sigAligned = new Array(closes.length).fill(NaN);
    var firstValid = line.findIndex(isFinite);
    if (firstValid >= 0) {
      for (var i = 0; i < sig9.length; i++) sigAligned[firstValid + i] = sig9[i];
    }
    var hist = closes.map(function (_, i) {
      return isFinite(line[i]) && isFinite(sigAligned[i]) ? line[i] - sigAligned[i] : NaN;
    });
    return { macd: line, signal: sigAligned, hist: hist };
  }

  // Wilder-smoothed ATR(14). Returns array aligned to candles.
  function atr(candles, period) {
    period = period || 14;
    var n = candles.length;
    var out = new Array(n).fill(NaN);
    if (n < period + 1) return out;
    var trs = [0];
    for (var i = 1; i < n; i++) {
      var h = +candles[i][2], l = +candles[i][3], pc = +candles[i - 1][4];
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    var seed = 0;
    for (var k = 1; k <= period; k++) seed += trs[k];
    out[period] = seed / period;
    for (var j = period + 1; j < n; j++) {
      out[j] = (out[j - 1] * (period - 1) + trs[j]) / period;
    }
    return out;
  }

  // ═════════ EXPECTED MOVE (probability cone) — pure math ═════════
  //
  // Estimates the ± RANGE a price is statistically likely to travel over
  // N bars ahead. This is a *range* (volatility) estimate, NEVER a
  // directional forecast — it deliberately does not predict up vs down.
  // Per .cursor/rules/trading-context.mdc a confident directional call
  // that's wrong loses real capital, so the only honest, defensible
  // output is "~68% chance price stays within ±X over the next N bars".
  //
  // Method (the same "expected move" math option desks use):
  //   1. σ = sample standard deviation of recent per-bar LOG returns.
  //   2. Scale to N bars with the √time rule: σ_N = σ · √N (variance of
  //      independent returns adds linearly, so std-dev grows with √N).
  //   3. Bands: ±1σ ≈ 68% confidence, ±1.96σ ≈ 95% confidence (normal
  //      approximation). Real markets have fat tails, so treat 95% as a
  //      floor — the true odds of breaching it are a bit higher than 5%.
  //
  //   emReturnSigma(closes, lookback) → per-bar σ of log returns (or null
  //                                     when there isn't enough clean data).
  //   emBand(ltp, sigma, bars)        → { p68, p95, pct68, pct95 } in price.
  function emReturnSigma(closes, lookback) {
    if (!closes || closes.length < 11) return null;
    lookback = lookback || 60;
    var start = Math.max(1, closes.length - lookback);
    var rets = [];
    for (var i = start; i < closes.length; i++) {
      var p0 = closes[i - 1], p1 = closes[i];
      if (p0 > 0 && p1 > 0 && isFinite(p0) && isFinite(p1)) {
        rets.push(Math.log(p1 / p0));
      }
    }
    if (rets.length < 10) return null;
    var mean = 0, k;
    for (k = 0; k < rets.length; k++) mean += rets[k];
    mean /= rets.length;
    var ss = 0;
    for (k = 0; k < rets.length; k++) { var d = rets[k] - mean; ss += d * d; }
    var variance = ss / (rets.length - 1); // sample variance (Bessel's n-1)
    var sigma = Math.sqrt(variance);
    return isFinite(sigma) && sigma > 0 ? sigma : null;
  }

  function emBand(ltp, sigma, bars) {
    if (!isFinite(ltp) || ltp <= 0 || !isFinite(sigma) || sigma <= 0
        || !isFinite(bars) || bars <= 0) return null;
    var sN = sigma * Math.sqrt(bars); // log-return σ over N bars
    // Price-space moves aren't perfectly symmetric (returns are lognormal),
    // so average the up/down legs into one honest ± magnitude for display.
    function band(z) {
      var up = ltp * (Math.exp(z * sN) - 1);
      var dn = ltp * (1 - Math.exp(-z * sN));
      return (up + dn) / 2;
    }
    return { p68: band(1), p95: band(1.96), pct68: sN * 100, pct95: 1.96 * sN * 100 };
  }

  // Horizons to project per timeframe: [bars ahead, human label]. Daily
  // bars → next day / next week (5 trading days); weekly → next week /
  // next month (4 weeks); monthly → next month / next quarter; hourly →
  // next hour / next session (≈6 one-hour bars in an NSE day).
  var EM_HORIZONS_BY_TF = {
    '1d':  [{ bars: 1, label: 'next day' },   { bars: 5, label: 'next week' }],
    '1w':  [{ bars: 1, label: 'next week' },  { bars: 4, label: 'next month' }],
    '1mo': [{ bars: 1, label: 'next month' }, { bars: 3, label: 'next quarter' }],
    '4h':  [{ bars: 1, label: 'next 4h bar' }, { bars: 2, label: 'next session' }],
    '1h':  [{ bars: 1, label: 'next hour' },  { bars: 6, label: 'next session' }],
    // Sub-hourly (cards-only reco TFs). No buy/sell signal is emitted on
    // these, but the Expected-Move cone is pure volatility math (±range, not
    // a direction) and is useful for sizing a fine-tuned entry — so it IS
    // shown. Horizons: the next bar + a ~1-hour look-ahead.
    '30m': [{ bars: 1, label: 'next 30m bar' }, { bars: 2,  label: 'next hour' }],
    '15m': [{ bars: 1, label: 'next 15m bar' }, { bars: 4,  label: 'next hour' }],
    '5m':  [{ bars: 1, label: 'next 5m bar' },  { bars: 12, label: 'next hour' }]
  };

  window.emReturnSigma = emReturnSigma;
  window.emBand        = emBand;

  // Find swing highs/lows using a "left and right N bars are lower/higher"
  // definition. lookback=3 is the standard for daily swing trading.
  function swingHighs(candles, lookback) {
    lookback = lookback || 3;
    var out = [];
    for (var i = lookback; i < candles.length - lookback; i++) {
      var h = +candles[i][2];
      var ok = true;
      for (var j = 1; j <= lookback; j++) {
        if (+candles[i - j][2] >= h || +candles[i + j][2] >= h) { ok = false; break; }
      }
      if (ok) out.push({ idx: i, price: h });
    }
    return out;
  }
  function swingLows(candles, lookback) {
    lookback = lookback || 3;
    var out = [];
    for (var i = lookback; i < candles.length - lookback; i++) {
      var l = +candles[i][3];
      var ok = true;
      for (var j = 1; j <= lookback; j++) {
        if (+candles[i - j][3] <= l || +candles[i + j][3] <= l) { ok = false; break; }
      }
      if (ok) out.push({ idx: i, price: l });
    }
    return out;
  }

  // ═════════ TREND IDENTIFIER v1 — CAPPED ATR (May 2026) ══════════
  //
  // Why: raw ATR(14) over-reacts to single freak bars (gap day,
  //   news spike). Wilder's smoothing has a long memory — one 80-pt
  //   bar inflates ATR for the next 14 bars. Every distance
  //   threshold that scales with ATR (HH/HL tolerance, value-zone
  //   width on 15m, T1 fill-room on 5m) then becomes too loose for
  //   ~3 trading days, freezing the structural classifier into
  //   "everything looks near-equal" mode.
  //
  // Fix: cap raw ATR at 1.5 × median-of-recent-ATR. The 1.5×
  //   factor absorbs legitimate regime shifts (election week, RBI
  //   policy) but rejects single freak bars. Raw ATR is still
  //   exposed to the debug panel (decoration); cappedATR is what
  //   structural / trade-plan math consumes.
  //
  // Cache: median is recomputed lazily on the first analyze cycle
  //   of each new IST trading day, keyed by istDateKeyLocal().
  //   One cache slot per TF. No scheduled job needed — happens
  //   automatically the moment a new day's first verdict runs.
  //
  // Scope (use cappedATR EVERYWHERE ATR sets a distance):
  //   - HH/HL tolerance:           tolATR × cappedATR
  //   - value-zone bounds on 15m:  EMA20 ± 0.5 × cappedATR(15m)
  //   - T1 fill-room on 5m:        T1 − 0.5 × cappedATR(5m)
  //   - fresh-swing distance       (any future ATR-based threshold)
  // Raw ATR is ONLY for display.
  //
  // See docs/FEATURES.md §12.4 for the locked spec.

  // Local IST date helper — duplicated from liveChartModule's
  // istDateKey() so we don't depend on its IIFE export order.
  // Kept tiny on purpose; both call the same Intl primitive so
  // they always agree.
  function istDateKeyLocal(d) {
    var p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d || new Date());
    var get = function (t) {
      var x = p.find(function (o) { return o.type === t; });
      return x ? x.value : '';
    };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  // Median of valid positive numbers in an array. NaN-safe.
  // Returns NaN if no valid values (caller decides fallback).
  function medianOfArr(arr) {
    var v = [];
    for (var i = 0; i < arr.length; i++) {
      var x = +arr[i];
      if (isFinite(x) && x > 0) v.push(x);
    }
    if (v.length === 0) return NaN;
    v.sort(function (a, b) { return a - b; });
    var mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // Per-TF cache for the daily-recomputed median ATR.
  // Shape: { '1h': { date: 'YYYY-MM-DD', value: 18.3 }, ... }
  // Date is the IST trading day; stale entries (different date)
  // are recomputed on next access.
  var _atrMedianCache = {};

  // How many recent ATR values to take the median of, per TF.
  // Matches our startup-bar counts (§12.7 Fix 5): 1h/30m/15m all
  // load 120 bars, 5m loads 80. We slice from the END of the ATR
  // series, so even with longer histories we only consider the
  // most recent N — keeps "median20d" meaning what its name says.
  var ATR_MEDIAN_BARS_BY_TF = {
    '1h':  120,
    '30m': 120,
    '15m': 120,
    '5m':  80
  };

  // Lazily compute (and cache) the median of the recent N ATR
  // values for a TF on the current IST trading day.
  //
  // rawAtrSeries: full ATR(14) series for the TF (same length as
  //               the candle array, NaN at warmup).
  // tfKey:        '1h' | '30m' | '15m' | '5m' (anything else
  //               falls through to the default 120-bar slice).
  function getMedian20dATR(rawAtrSeries, tfKey) {
    if (!rawAtrSeries || !rawAtrSeries.length) return NaN;
    var today = istDateKeyLocal();
    var slot  = _atrMedianCache[tfKey];
    if (slot && slot.date === today && isFinite(slot.value) && slot.value > 0) {
      return slot.value;
    }
    var maxN  = ATR_MEDIAN_BARS_BY_TF[tfKey] || 120;
    var slice = (rawAtrSeries.length > maxN)
                ? rawAtrSeries.slice(-maxN)
                : rawAtrSeries.slice();
    var med   = medianOfArr(slice);
    _atrMedianCache[tfKey] = { date: today, value: med };
    return med;
  }

  // Cap a single ATR value at 1.5× the per-TF median.
  //
  // Returns the raw value unchanged when the median is unavailable
  // (e.g. very early in the trading day with too few warmed-up
  // ATR samples), so distance math degrades gracefully to "use
  // whatever ATR we have" instead of NaN.
  function cappedAtrValue(rawAtrValue, rawAtrSeries, tfKey) {
    var raw = +rawAtrValue;
    if (!isFinite(raw) || raw <= 0) return NaN;
    var med = getMedian20dATR(rawAtrSeries, tfKey);
    if (!isFinite(med) || med <= 0) return raw;
    return Math.min(raw, 1.5 * med);
  }

  // Convenience: cap an entire ATR series (one cappedATR per bar).
  // Useful when the caller needs the capped value at multiple
  // historical bars (e.g. back-test view replaying classifier).
  function cappedAtrSeries(rawAtrSeries, tfKey) {
    if (!rawAtrSeries || !rawAtrSeries.length) return [];
    var med = getMedian20dATR(rawAtrSeries, tfKey);
    if (!isFinite(med) || med <= 0) return rawAtrSeries.slice();
    var cap = 1.5 * med;
    var out = new Array(rawAtrSeries.length);
    for (var i = 0; i < rawAtrSeries.length; i++) {
      var v = +rawAtrSeries[i];
      out[i] = (isFinite(v) && v > 0) ? Math.min(v, cap) : v;
    }
    return out;
  }

  // Expose to window so back-test view / debug panel can read the
  // current cap values without re-implementing the math.
  window.cappedAtrValue   = cappedAtrValue;
  window.cappedAtrSeries  = cappedAtrSeries;
  window.getMedian20dATR  = getMedian20dATR;

  // ═════════ TREND IDENTIFIER v2 — ZigZag HH/HL (May 2026) ════════
  //
  // Pure function. Single source of truth for "what's the trend on
  // this TF right now?". Applied identically on 1h / 30m / 15m / 5m
  // — only the per-TF parameters differ.
  //
  // Replaces: group-based classifier (v1b), slope fallback (v1a), and
  // the original pivot-scan + ADX gate (v0).
  // uptrend labels on sideways charts. See AGENTS.md §10 and
  // docs/FEATURES.md §12 for the locked spec.
  //
  // Algorithm (matches docs/FEATURES.md §12.3 exactly):
  //   1. Drop first `skipFirstBarsOfDay` bars of the current IST
  //      trading day from the candle array (gap exclusion).
  //   2. Take the last `window` bars from the post-exclusion array
  //      as the analysis window.
  //   3. Find swing highs / lows in the window using `swingN` as
  //      the lookback (existing helpers — left+right N bars all
  //      lower/higher than the candidate).
  //   4. Require ≥ 2 swing highs AND ≥ 2 swing lows. Otherwise
  //      → SIDEWAYS with reason "insufficient structure".
  //   5. Compare last two of each with tolerance:
  //        HH = newHigh > prevHigh + tolATR × cappedATR
  //        HL = newLow  > prevLow  + tolATR × cappedATR
  //      (symmetric for LH / LL).
  //   6. Classify:
  //        HH AND HL → UP    bosLevel = lastSwingLow.price
  //        LH AND LL → DOWN  bosLevel = lastSwingHigh.price
  //        anything else → SIDEWAYS  bosLevel = null
  //   7. freshSwingAge = barsToWindowEnd from the swing candle
  //      itself (NOT the confirmation candle — see §12.7 Fix 2).
  //
  // Params (all required, no implicit defaults — caller must pass
  // the per-TF table from §12.3 to keep behaviour explicit):
  //   window:             how many recent bars to consider
  //   swingN:             bars on each side for swing detection
  //   tolATR:             tolerance multiplier for HH/HL
  //   freshWin:           max bars old for a swing to be "fresh"
  //   skipFirstBarsOfDay: bars at start of each trading day to drop
  //   tfKey:              '1h' | '30m' | '15m' | '5m'
  //   rawAtrSeries:       full ATR(14) series for cappedATR lookup
  //
  // Returns: {
  //   label:           'UP' | 'DOWN' | 'SIDEWAYS',
  //   swingHighs:      [{idx, price, ts, ageBars}, ...] up to 3 most recent first
  //   swingLows:       [{idx, price, ts, ageBars}, ...] up to 3 most recent first
  //   bosLevel:        number | null,  // kill-this-trend price
  //   distToBosPts:    number | null,  // last close - bosLevel (signed)
  //   bosAgeBars:      number | null,  // bars since bosLevel swing was formed
  //   freshSwingAge:   number | null,  // bars since most recent bias-dir swing (from swing candle)
  //   reason:          string,         // human diagnostic
  //   tolPts:          number,         // tolATR × cappedATR (debug)
  //   cappedATR:       number,         // capped ATR used (debug)
  //   rawATR:          number,         // raw ATR for comparison (debug)
  //   windowSize:      number          // bars actually analysed (post-skip)
  // }

  // Helper — local IST date key for a candle timestamp. Same shape
  // as istDateKeyLocal() above but takes a Date or timestamp arg.
  function istDateKeyForTs(ts) {
    return istDateKeyLocal(new Date(ts));
  }

  // Build a "today-bar-aware" candle subset: drop the first
  // `skipN` bars whose IST date matches the last bar's IST date.
  // This implements the §12.7 Gap B rule cleanly.
  //
  // Returns the array of candles AFTER the skip. If the last bar
  // is not actually on the current trading day (weekend / overnight
  // analysis), no skip happens — the gap rule only matters when
  // today's session has bars.
  function dropGapBars(candles, skipN) {
    if (!candles || !candles.length || skipN <= 0) return candles || [];
    var lastDay = istDateKeyForTs(candles[candles.length - 1][0]);
    var todayStartIdx = -1;
    for (var i = 0; i < candles.length; i++) {
      if (istDateKeyForTs(candles[i][0]) === lastDay) {
        todayStartIdx = i;
        break;
      }
    }
    if (todayStartIdx < 0) return candles.slice();
    // Drop the first `skipN` bars of today, keep all prior days
    // intact (they're needed for structural lookback context).
    var pre  = candles.slice(0, todayStartIdx);
    var todayBars = candles.slice(todayStartIdx);
    if (todayBars.length <= skipN) {
      // All of today's bars are gap-bars — keep only prior days
      // until the post-skip portion of today materialises.
      return pre;
    }
    return pre.concat(todayBars.slice(skipN));
  }

  // The classifier itself. Pure function — no I/O, no DOM, no
  // module state mutation. Safe to call from analyze cycle AND
  // from the back-test replay view with identical semantics.
  // ── ZigZag swing finder ───────────────────────────────────────────────
  // Tracks alternating price extremes. Each time price reverses by more
  // than minMovePts from the current extreme, the extreme is recorded as
  // a swing high (if direction was UP) or swing low (if DOWN) and direction
  // flips. Unlike the strict N-bar pivot scan, this always produces swings
  // for any directional move — including smooth grinding trends.
  //
  // startDir: 'UP' begins by tracking for a swing high; 'DOWN' for a low.
  // Caller tries both and picks whichever yields ≥2 of each type.
  function _zigzagFrom(prepped, minMovePts, startDir) {
    var swHi = [], swLo = [];
    var n = prepped.length;
    if (n < 2) return { swingHighs: swHi, swingLows: swLo };

    var dir          = startDir;
    var peakPrice    = +prepped[0][2], peakIdx    = 0;
    var troughPrice  = +prepped[0][3], troughIdx  = 0;

    for (var i = 1; i < n; i++) {
      var h = +prepped[i][2], l = +prepped[i][3];
      if (dir === 'UP') {
        if (h >= peakPrice) { peakPrice = h; peakIdx = i; }
        if (peakPrice - l >= minMovePts) {
          swHi.push({ idx: peakIdx, price: peakPrice });
          dir = 'DOWN'; troughPrice = l; troughIdx = i;
        }
      } else {
        if (l <= troughPrice) { troughPrice = l; troughIdx = i; }
        if (h - troughPrice >= minMovePts) {
          swLo.push({ idx: troughIdx, price: troughPrice });
          dir = 'UP'; peakPrice = h; peakIdx = i;
        }
      }
    }
    return { swingHighs: swHi, swingLows: swLo };
  }

  // ── Structural Trend Classifier v3 — ZigZag HH/HL (May 2026) ─────────
  // Params (from TREND_PARAMS_BY_TF):
  //   zigzagATR — minimum reversal size to mark a swing = zigzagATR × cappedATR.
  //               Bigger = fewer, cleaner swings; smaller = faster but noisier.
  //   tolATR    — HH/HL comparison tolerance = tolATR × cappedATR.
  //               Consecutive swing highs must differ by > tolPts to count as HH.
  //
  // Key advantage over group-based v2: comparing the MOST RECENT pair of swings
  // always reflects the current trend, even when a long lookback window contains
  // an earlier opposing trend. ZigZag naturally surfaces the latest structure.
  function classifyStructure(candles, params) {
    var p = params || {};
    var zigzagATR        = p.zigzagATR          || 0.5;
    var tolATR           = p.tolATR             || 0.05;
    var skipFirstBarsDay = p.skipFirstBarsOfDay || 0;
    var tfKey            = p.tfKey              || '15m';
    var rawAtrSeries     = p.rawAtrSeries       || [];

    function emptyResult(reason) {
      return {
        label: 'SIDEWAYS', swingHighs: [], swingLows: [],
        bosLevel: null, distToBosPts: null, bosAgeBars: null, freshSwingAge: null,
        reason: reason, tolPts: NaN, cappedATR: NaN, rawATR: NaN, windowSize: 0
      };
    }

    if (!candles || candles.length < 4) {
      return emptyResult('not enough candles (' + (candles ? candles.length : 0) + ')');
    }

    var prepped = dropGapBars(candles, skipFirstBarsDay);
    var N = prepped.length;
    if (N < 4) return emptyResult('after gap-skip, only ' + N + ' bars');

    // ── Capped ATR ───────────────────────────────────────────────────────
    var rawAtrLast = NaN;
    for (var ai = rawAtrSeries.length - 1; ai >= 0; ai--) {
      var av = +rawAtrSeries[ai];
      if (isFinite(av) && av > 0) { rawAtrLast = av; break; }
    }
    var cappedAtr = cappedAtrValue(rawAtrLast, rawAtrSeries, tfKey);
    if (!isFinite(cappedAtr) || cappedAtr <= 0) {
      cappedAtr = isFinite(+prepped[N - 1][4]) ? +prepped[N - 1][4] * 0.001 : 1;
    }
    var minMovePts = zigzagATR * cappedAtr; // reversal size to record a swing
    var tolPts     = tolATR    * cappedAtr; // HH/HL comparison tolerance

    // ── ZigZag: try both starting directions, pick the better result ─────
    var swUp = _zigzagFrom(prepped, minMovePts, 'UP');
    var swDn = _zigzagFrom(prepped, minMovePts, 'DOWN');
    var upOk = swUp.swingHighs.length >= 2 && swUp.swingLows.length >= 2;
    var dnOk = swDn.swingHighs.length >= 2 && swDn.swingLows.length >= 2;
    var sh, sl;
    if (upOk && dnOk) {
      // Both qualify — use whichever has more total swings (more data = more reliable)
      var upTot = swUp.swingHighs.length + swUp.swingLows.length;
      var dnTot = swDn.swingHighs.length + swDn.swingLows.length;
      sh = (dnTot > upTot) ? swDn.swingHighs : swUp.swingHighs;
      sl = (dnTot > upTot) ? swDn.swingLows  : swUp.swingLows;
    } else if (upOk) { sh = swUp.swingHighs; sl = swUp.swingLows; }
    else if (dnOk)   { sh = swDn.swingHighs; sl = swDn.swingLows; }
    else {
      // Neither has 2 of each — merge best of both for markers
      sh = (swUp.swingHighs.length >= swDn.swingHighs.length) ? swUp.swingHighs : swDn.swingHighs;
      sl = (swUp.swingLows.length  >= swDn.swingLows.length)  ? swUp.swingLows  : swDn.swingLows;
      var r0 = emptyResult('insufficient zigzag swings (H:' + sh.length + ' L:' + sl.length
                         + ' minMove:' + minMovePts.toFixed(1) + 'pt)');
      r0.tolPts = tolPts; r0.cappedATR = cappedAtr; r0.rawATR = rawAtrLast;
      r0.windowSize = N;
      r0.swingHighs = sh.slice(-3).reverse().map(function (s) {
        return { idx: s.idx, price: s.price, ts: prepped[s.idx][0], ageBars: N - 1 - s.idx };
      });
      r0.swingLows = sl.slice(-3).reverse().map(function (s) {
        return { idx: s.idx, price: s.price, ts: prepped[s.idx][0], ageBars: N - 1 - s.idx };
      });
      return r0;
    }

    // ── HH/HL comparison on most recent 2 swings of each type ────────────
    var shRev = sh.slice().reverse(); // most recent first
    var slRev = sl.slice().reverse();
    var newHigh  = shRev[0].price, prevHigh = shRev[1].price;
    var newLow   = slRev[0].price, prevLow  = slRev[1].price;
    var lastClose = +prepped[N - 1][4];

    var isHH = newHigh > prevHigh + tolPts;
    var isHL = newLow  > prevLow  + tolPts;
    var isLH = newHigh < prevHigh - tolPts;
    var isLL = newLow  < prevLow  - tolPts;

    var label = 'SIDEWAYS', bosLevel = null, bosAgeBars = null, reason;
    var freshSwingIdx = null;

    if (isHH && isHL) {
      label         = 'UP';
      bosLevel      = slRev[0].price;           // most recent swing low = invalidation
      bosAgeBars    = N - 1 - slRev[0].idx;
      freshSwingIdx = slRev[0].idx;
      reason = 'ZZ_HH+HL: H ' + newHigh.toFixed(1) + '>' + prevHigh.toFixed(1)
             + ' L ' + newLow.toFixed(1) + '>' + prevLow.toFixed(1)
             + ' (tol ' + tolPts.toFixed(1) + 'pt minMv ' + minMovePts.toFixed(1) + 'pt)';
    } else if (isLH && isLL) {
      label         = 'DOWN';
      bosLevel      = shRev[0].price;           // most recent swing high = invalidation
      bosAgeBars    = N - 1 - shRev[0].idx;
      freshSwingIdx = shRev[0].idx;
      reason = 'ZZ_LH+LL: H ' + newHigh.toFixed(1) + '<' + prevHigh.toFixed(1)
             + ' L ' + newLow.toFixed(1) + '<' + prevLow.toFixed(1)
             + ' (tol ' + tolPts.toFixed(1) + 'pt minMv ' + minMovePts.toFixed(1) + 'pt)';
    } else {
      var hTag = (Math.abs(newHigh - prevHigh) <= tolPts) ? 'EH' : (isHH ? 'HH' : 'LH');
      var lTag = (Math.abs(newLow  - prevLow)  <= tolPts) ? 'EL' : (isHL ? 'HL' : 'LL');
      reason = 'ZZ_MIXED ' + hTag + '+' + lTag
             + ' H ' + newHigh.toFixed(1) + '/' + prevHigh.toFixed(1)
             + ' L ' + newLow.toFixed(1)  + '/' + prevLow.toFixed(1)
             + ' (tol ' + tolPts.toFixed(1) + 'pt minMv ' + minMovePts.toFixed(1) + 'pt)';
    }

    var distToBosPts  = (bosLevel != null) ? +(lastClose - bosLevel).toFixed(2) : null;
    var freshSwingAge = (freshSwingIdx != null) ? (N - 1 - freshSwingIdx) : null;

    return {
      label:         label,
      swingHighs:    shRev.slice(0, 3).map(function (s) {
        return { idx: s.idx, price: s.price, ts: prepped[s.idx][0], ageBars: N - 1 - s.idx };
      }),
      swingLows:     slRev.slice(0, 3).map(function (s) {
        return { idx: s.idx, price: s.price, ts: prepped[s.idx][0], ageBars: N - 1 - s.idx };
      }),
      bosLevel:      bosLevel,
      distToBosPts:  distToBosPts,
      bosAgeBars:    bosAgeBars,
      freshSwingAge: freshSwingAge,
      reason:        reason,
      tolPts:        tolPts,
      cappedATR:     cappedAtr,
      rawATR:        rawAtrLast,
      windowSize:    N
    };
  }

  // Per-TF parameter table — the locked numbers from §12.3.
  // Centralised here so the analyzer, the debug panel, and the
  // back-test view all read the same source of truth.
  // Classifier v3 params — ZigZag HH/HL.
  //   zigzagATR: reversal size to mark a swing = zigzagATR × cappedATR.
  //              Typical 5m ATR ~35pt → zigzagATR=0.5 → minMove=17.5pt.
  //   tolATR:    HH/HL comparison tolerance = tolATR × cappedATR.
  //              Small because zigzag swings are already macroscopic.
  var TREND_PARAMS_BY_TF = {
    '1h':  { zigzagATR: 2.00, tolATR: 0.05, freshWin: 8,  skipFirstBarsOfDay: 1 },
    '30m': { zigzagATR: 1.80, tolATR: 0.05, freshWin: 8,  skipFirstBarsOfDay: 1 },
    '15m': { zigzagATR: 1.20, tolATR: 0.05, freshWin: 6,  skipFirstBarsOfDay: 1 },
    '5m':  { zigzagATR: 0.80, tolATR: 0.05, freshWin: 5,  skipFirstBarsOfDay: 2 }
  };

  // Expose so back-test view + debug panel can call the same
  // function with the same defaults the live engine uses.
  window.classifyStructure   = classifyStructure;
  window._zigzagFrom         = _zigzagFrom;
  window.TREND_PARAMS_BY_TF  = TREND_PARAMS_BY_TF;

  // ── Wilder's ADX (14) — trend-strength indicator. ──
  // ADX = 0…100 scalar that quantifies HOW STRONG a trend is,
  // independent of its direction. Standard reading:
  //   < 20: weak / range-bound (no trend to follow)
  //   20-25: developing trend
  //   25-40: strong trend (sweet spot for trend-following)
  //   > 40: very strong / possibly exhausted
  // Uses Wilder's smoothing (a special EMA where new = prev*(N-1)/N + cur)
  // rather than simple EMA — that's the canonical definition.
  function adx(candles, period) {
    period = period || 14;
    if (!candles || candles.length < period * 2 + 1) return [];
    var n = candles.length;
    var trArr = [], pDmArr = [], mDmArr = [];
    for (var i = 1; i < n; i++) {
      var h = +candles[i][2], l = +candles[i][3], cPrev = +candles[i - 1][4];
      var hPrev = +candles[i - 1][2], lPrev = +candles[i - 1][3];
      trArr.push(Math.max(h - l, Math.abs(h - cPrev), Math.abs(l - cPrev)));
      var up = h - hPrev, dn = lPrev - l;
      pDmArr.push((up > dn && up > 0) ? up : 0);
      mDmArr.push((dn > up && dn > 0) ? dn : 0);
    }
    function wilderSmooth(arr, p) {
      if (arr.length < p) return [];
      var out = [], seed = 0;
      for (var k = 0; k < p; k++) seed += arr[k];
      out.push(seed);
      for (var k = p; k < arr.length; k++) {
        out.push(out[out.length - 1] - out[out.length - 1] / p + arr[k]);
      }
      return out;
    }
    var trS = wilderSmooth(trArr, period);
    var pS  = wilderSmooth(pDmArr, period);
    var mS  = wilderSmooth(mDmArr, period);
    if (!trS.length) return [];
    var dxArr = [];
    for (var i = 0; i < trS.length; i++) {
      var pDi = trS[i] === 0 ? 0 : (pS[i] / trS[i]) * 100;
      var mDi = trS[i] === 0 ? 0 : (mS[i] / trS[i]) * 100;
      var sum = pDi + mDi;
      dxArr.push(sum === 0 ? 0 : (Math.abs(pDi - mDi) / sum) * 100);
    }
    if (dxArr.length < period) return [];
    var adxArr = [], seed2 = 0;
    for (var i = 0; i < period; i++) seed2 += dxArr[i];
    adxArr.push(seed2 / period);
    for (var i = period; i < dxArr.length; i++) {
      adxArr.push((adxArr[adxArr.length - 1] * (period - 1) + dxArr[i]) / period);
    }
    return adxArr;
  }

  // ═══════════════════════════════════════════════════════════════
  // SUPERTREND (10, 3) — Indian-intraday-standard flip indicator
  // ═══════════════════════════════════════════════════════════════
  // Builds two bands around (high+low)/2 ± multiplier × ATR, then
  // "locks" the trailing band so it only moves in the direction
  // of the trend (never backs off, until price closes through it
  // — at which point the trend flips and the OTHER band takes
  // over as the trailing line).
  //
  // Output per bar (chronological order): { value, trend, flip }
  //   value: the active trailing band price (acts as dynamic SL)
  //   trend: 'BULL' (price above value) | 'BEAR' (price below)
  //   flip : true on the bar where trend just reversed
  //
  // Standard intraday config is period=10, multiplier=3. Higher
  // multipliers (e.g. 4) give fewer but cleaner flips; lower
  // (e.g. 2) gives faster but choppier flips. Period=10 lines up
  // with the most popular Indian intraday templates and matches
  // what TradingView's default Supertrend shows.
  function supertrend(candles, period, multiplier) {
    period = period || 10;
    multiplier = multiplier || 3;
    var n = candles.length;
    var out = new Array(n).fill(null);
    if (n < period + 2) return out;
    // ATR with the supertrend's period (not the global ATR-14).
    var trs = [0];
    for (var i = 1; i < n; i++) {
      var h = +candles[i][2], l = +candles[i][3], pc = +candles[i - 1][4];
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    var atrArr = new Array(n).fill(NaN);
    var seed = 0;
    for (var k = 1; k <= period; k++) seed += trs[k];
    atrArr[period] = seed / period;
    for (var j = period + 1; j < n; j++) {
      atrArr[j] = (atrArr[j - 1] * (period - 1) + trs[j]) / period;
    }
    // Build basic bands, then smooth via the locking rules.
    var finalUpper = new Array(n).fill(NaN);
    var finalLower = new Array(n).fill(NaN);
    var trendArr   = new Array(n).fill(null);
    var stValue    = new Array(n).fill(NaN);
    var prevTrend  = 'BULL';  // seed; will lock in after period+1
    for (var i = period; i < n; i++) {
      var hi = +candles[i][2], lo = +candles[i][3], cl = +candles[i][4];
      var hl2 = (hi + lo) / 2;
      var basicUp = hl2 + multiplier * atrArr[i];
      var basicLo = hl2 - multiplier * atrArr[i];
      // Lock the upper band: it can only DECREASE (or hold) while
      // we're in a bear trend (otherwise it'd be useless as a
      // trailing stop). Same logic mirrored for lower in bull.
      if (i === period) {
        finalUpper[i] = basicUp;
        finalLower[i] = basicLo;
      } else {
        finalUpper[i] = (basicUp < finalUpper[i - 1] || +candles[i - 1][4] > finalUpper[i - 1])
          ? basicUp : finalUpper[i - 1];
        finalLower[i] = (basicLo > finalLower[i - 1] || +candles[i - 1][4] < finalLower[i - 1])
          ? basicLo : finalLower[i - 1];
      }
      // Determine current trend by which side of the trailing
      // bands the close sits on. Trend flips happen exactly when
      // close crosses through the previous active band.
      var curTrend;
      if (i === period) {
        curTrend = cl <= basicUp ? 'BEAR' : 'BULL';
      } else if (prevTrend === 'BULL') {
        curTrend = (cl < finalLower[i]) ? 'BEAR' : 'BULL';
      } else {
        curTrend = (cl > finalUpper[i]) ? 'BULL' : 'BEAR';
      }
      trendArr[i] = curTrend;
      stValue[i]  = (curTrend === 'BULL') ? finalLower[i] : finalUpper[i];
      prevTrend = curTrend;
    }
    for (var i = period; i < n; i++) {
      out[i] = {
        value: stValue[i],
        trend: trendArr[i],
        flip:  (i > period && trendArr[i - 1] != null && trendArr[i] !== trendArr[i - 1])
      };
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  // STOCHASTIC (14, 3, 3) — short-term overbought/oversold momentum
  // ═══════════════════════════════════════════════════════════════
  // Normalises the current close against the recent N-bar range
  // (highest high to lowest low). Distinct from RSI because it
  // doesn't care about the magnitude of price moves — only where
  // close sits inside the recent range. Catches short turns that
  // RSI's averaging smooths over.
  //
  // %K(N)   = 100 × (close - lowestLow(N)) / (highestHigh(N) - lowestLow(N))
  // %D      = SMA(%K, smoothK)       [the "fast" line]
  // %D-slow = SMA(%D, smoothD)       [the "slow" / signal line]
  //
  // Conventional thresholds: K > 80 = overbought, K < 20 = oversold.
  // Trade signal: bullish crossover (K crosses ABOVE D) below 20,
  // bearish crossover (K crosses BELOW D) above 80.
  //
  // Returns array of { k, d } per bar (chronological).
  function stochastic(candles, period, smoothK, smoothD) {
    period  = period  || 14;
    smoothK = smoothK || 3;
    smoothD = smoothD || 3;
    var n = candles.length;
    var rawK = new Array(n).fill(NaN);
    if (n < period) return new Array(n).fill(null);
    for (var i = period - 1; i < n; i++) {
      var hh = -Infinity, ll = Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        var hh1 = +candles[j][2], ll1 = +candles[j][3];
        if (hh1 > hh) hh = hh1;
        if (ll1 < ll) ll = ll1;
      }
      var cl = +candles[i][4];
      var range = hh - ll;
      rawK[i] = range === 0 ? 50 : ((cl - ll) / range) * 100;
    }
    function smaArr(arr, p) {
      var out = new Array(arr.length).fill(NaN);
      for (var i = p - 1; i < arr.length; i++) {
        var s = 0, any = true;
        for (var k = 0; k < p; k++) {
          var v = arr[i - k];
          if (!isFinite(v)) { any = false; break; }
          s += v;
        }
        if (any) out[i] = s / p;
      }
      return out;
    }
    var kSmoothed = smaArr(rawK, smoothK);   // %K (the slow K — Pine's default is smoothed)
    var dArr      = smaArr(kSmoothed, smoothD); // %D = SMA(%K, smoothD)
    var out = new Array(n).fill(null);
    for (var i = 0; i < n; i++) {
      if (isFinite(kSmoothed[i]) && isFinite(dArr[i])) {
        out[i] = { k: kSmoothed[i], d: dArr[i] };
      }
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════
  // OBV (On-Balance Volume) — cumulative volume-flow confirmation
  // ═══════════════════════════════════════════════════════════════
  // Adds bar's volume to a running cumulative total if close ↑,
  // subtracts it if close ↓, no change if flat. Useful for
  // detecting accumulation/distribution: if price is making a
  // new high but OBV isn't, the breakout is weakly supported by
  // volume and likely to fail (bearish divergence).
  //
  // We also compute a normalized slope (last 20-bar ratio) so the
  // verdict can score "OBV slope rising" as confirmation. Returns
  // { value, slope20 } per bar (chronological).
  function obv(candles) {
    var n = candles.length;
    var out = new Array(n).fill(null);
    if (n < 2) return out;
    var cum = 0;
    var cumArr = new Array(n).fill(0);
    for (var i = 1; i < n; i++) {
      var c0 = +candles[i - 1][4], c1 = +candles[i][4];
      var v  = +candles[i][5] || 0;
      if (c1 > c0)      cum += v;
      else if (c1 < c0) cum -= v;
      cumArr[i] = cum;
    }
    // Slope = (OBV[i] - OBV[i-20]) / 20 → normalised to OBV's last
    // value to make it a relative figure. Positive = accumulation,
    // negative = distribution.
    for (var i = 0; i < n; i++) {
      var slope20 = null;
      if (i >= 20) {
        var diff = cumArr[i] - cumArr[i - 20];
        var denom = Math.max(1, Math.abs(cumArr[i]));
        slope20 = diff / denom;
      }
      out[i] = { value: cumArr[i], slope20: slope20 };
    }
    return out;
  }

  // ══════════════════════════════════════════════════════════════
  // CANDLE PATTERN DETECTION LIBRARY
  // ──────────────────────────────────────────────────────────────
  // 15 patterns organized into three families:
  //   • Reversal (10) — Engulfing pair, Hammer/Inverted Hammer/
  //     Hanging Man/Shooting Star, Dragonfly/Gravestone Doji,
  //     Piercing/Dark Cloud, Harami pair, Morning/Evening Star,
  //     Tweezer Top/Bottom.
  //   • Continuation (4) — Marubozu (bull/bear), Three White
  //     Soldiers, Three Black Crows.
  //   • Compression (2) — Inside Bar, NR4 (narrow range 4).
  //     These don't have a directional bias; they're "wait for
  //     break" setups that surface separately as `compression`
  //     on the result, not as bull/bear.
  //
  // Each helper takes the candle(s) it needs and returns a
  // boolean. They're pure functions (no side effects) so the
  // intraday module can call them via the exposed _tfMath API.
  // ══════════════════════════════════════════════════════════════

  // ── Helpers: candle anatomy ──
  // Tiny utilities to avoid recomputing body / range / wicks in
  // every pattern check. Use these instead of inline math.
  function candleParts(c) {
    var o = +c[1], h = +c[2], l = +c[3], cl = +c[4];
    var body = Math.abs(cl - o);
    var range = h - l;
    var lowerWick = Math.min(o, cl) - l;
    var upperWick = h - Math.max(o, cl);
    return {
      o: o, h: h, l: l, c: cl,
      body: body, range: range,
      lowerWick: lowerWick, upperWick: upperWick,
      isBull: cl > o, isBear: cl < o,
      bodyPctOfRange: range > 0 ? body / range : 0
    };
  }

  // ── 2-bar: Engulfing pair (unchanged, kept for compatibility) ──
  function isBullishEngulfing(c1, c2) {
    var o1 = +c1[1], cl1 = +c1[4], o2 = +c2[1], cl2 = +c2[4];
    return cl1 < o1 && cl2 > o2 && cl2 >= o1 && o2 <= cl1;
  }
  function isBearishEngulfing(c1, c2) {
    var o1 = +c1[1], cl1 = +c1[4], o2 = +c2[1], cl2 = +c2[4];
    return cl1 > o1 && cl2 < o2 && cl2 <= o1 && o2 >= cl1;
  }

  // ── 1-bar: Wick-rejection family (Hammer / Inverted / Shooting / Hanging) ──
  // Hammer = long lower wick, no upper wick → bullish reversal at support.
  // Inverted Hammer = long upper wick, no lower wick AT SUPPORT
  //                 → bullish reversal (caller checks "at support").
  // Shooting Star = long upper wick at TOP of move → bearish reversal.
  // Hanging Man = HAMMER shape but at TOP of uptrend → bearish reversal.
  //               (Detect via prior-trend context, not shape alone.)
  // body / range >= 0.05 keeps us out of pure-doji territory; below
  // that threshold the candle is reported by the Doji helpers.
  function isHammer(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.body > 0 && p.lowerWick >= 2 * p.body && p.upperWick <= p.body && p.bodyPctOfRange >= 0.05;
  }
  function isInvertedHammer(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.body > 0 && p.upperWick >= 2 * p.body && p.lowerWick <= p.body && p.bodyPctOfRange >= 0.05;
  }
  function isShootingStar(c) {
    // Shape-identical to Inverted Hammer; the difference is
    // location (top vs bottom of move) — caller decides which
    // label to apply. Here we just detect the shape.
    return isInvertedHammer(c);
  }

  // ── 1-bar: Doji family ──
  // The doji types differ ONLY in wick distribution. Body must
  // be ≤ 5% of range (open ≈ close) to qualify.
  function isDoji(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.bodyPctOfRange <= 0.05;
  }
  function isDragonflyDoji(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.bodyPctOfRange <= 0.05
        && p.upperWick / p.range <= 0.10      // virtually no upper wick
        && p.lowerWick / p.range >= 0.60;     // long lower wick (60%+ of range)
  }
  function isGravestoneDoji(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.bodyPctOfRange <= 0.05
        && p.lowerWick / p.range <= 0.10      // virtually no lower wick
        && p.upperWick / p.range >= 0.60;     // long upper wick (60%+ of range)
  }
  function isNeutralDoji(c) {
    var p = candleParts(c);
    if (p.range <= 0) return false;
    return p.bodyPctOfRange <= 0.05
        && p.upperWick / p.range >= 0.20      // both wicks meaningful
        && p.lowerWick / p.range >= 0.20
        && !isDragonflyDoji(c) && !isGravestoneDoji(c);
  }

  // ── 1-bar: Marubozu (continuation) ──
  // Full-body candle, no (or near-zero) wicks. body / range ≥ 92%
  // is the standard textbook threshold. Strong continuation.
  function isBullishMarubozu(c) {
    var p = candleParts(c);
    if (p.range <= 0 || !p.isBull) return false;
    return p.bodyPctOfRange >= 0.92
        && p.upperWick / p.range <= 0.05
        && p.lowerWick / p.range <= 0.05;
  }
  function isBearishMarubozu(c) {
    var p = candleParts(c);
    if (p.range <= 0 || !p.isBear) return false;
    return p.bodyPctOfRange >= 0.92
        && p.upperWick / p.range <= 0.05
        && p.lowerWick / p.range <= 0.05;
  }

  // ── 2-bar: Piercing / Dark Cloud (gap + close past midpoint) ──
  // Piercing = prev bear, curr bull opens below prev close (gap-down)
  //            and closes ABOVE the midpoint of prev body.
  //            Does NOT fully engulf (else it'd be Bullish Engulfing).
  function isPiercing(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (!p1.isBear || !p2.isBull) return false;
    var mid1 = (p1.o + p1.c) / 2;
    return p2.o < p1.c       // gap-down open (or below prev close)
        && p2.c > mid1       // close above midpoint of prev body
        && p2.c < p1.o;      // does NOT fully engulf
  }
  function isDarkCloudCover(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (!p1.isBull || !p2.isBear) return false;
    var mid1 = (p1.o + p1.c) / 2;
    return p2.o > p1.c       // gap-up open
        && p2.c < mid1       // close below midpoint of prev body
        && p2.c > p1.o;      // does NOT fully engulf
  }

  // ── 2-bar: Harami (small body INSIDE prior body, opposite color) ──
  // Bullish Harami = prev big bear, curr small bull body INSIDE
  //                  prev body. Weakening sellers; needs confirm.
  function isBullishHarami(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (!p1.isBear || !p2.isBull) return false;
    if (p1.body <= 0 || p2.body <= 0) return false;
    // Body 2 must fit inside Body 1 (both open and close).
    if (!(p2.o > p1.c && p2.c < p1.o)) return false;
    // Body 1 needs to be at least 1.5× larger than body 2.
    return p1.body >= p2.body * 1.5;
  }
  function isBearishHarami(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (!p1.isBull || !p2.isBear) return false;
    if (p1.body <= 0 || p2.body <= 0) return false;
    if (!(p2.o < p1.c && p2.c > p1.o)) return false;
    return p1.body >= p2.body * 1.5;
  }

  // ── 2-bar: Tweezer (twin extremes at same price) ──
  // Tolerance: 0.05% of price (5 pts on Nifty @ 23,700 ≈ 12 pts).
  // Use direction confirmation — prev + curr opposite sides.
  function isTweezerBottom(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (p1.l <= 0) return false;
    var lowsClose = Math.abs(p1.l - p2.l) / p1.l <= 0.0005;
    return lowsClose && p1.isBear && p2.isBull && p2.c > p1.c;
  }
  function isTweezerTop(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (p1.h <= 0) return false;
    var highsClose = Math.abs(p1.h - p2.h) / p1.h <= 0.0005;
    return highsClose && p1.isBull && p2.isBear && p2.c < p1.c;
  }

  // ── 3-bar: Morning / Evening Star (the heavyweights) ──
  // Morning Star = strong bear → small-body indecision (gap-down)
  //                → strong bull that closes past midpoint of bar 1.
  function isMorningStar(c1, c2, c3) {
    var p1 = candleParts(c1), p2 = candleParts(c2), p3 = candleParts(c3);
    if (p1.range <= 0 || p3.range <= 0) return false;
    if (!p1.isBear || !p3.isBull) return false;
    if (p1.bodyPctOfRange < 0.5) return false;        // bar 1 is significant bear
    if (p2.body > p1.body * 0.4) return false;        // bar 2 is small (indecision)
    // Bar 2 must be below bar 1's close (gap-down/below-close).
    if (Math.max(p2.o, p2.c) >= p1.c) return false;
    // Bar 3 closes above midpoint of bar 1's body + is significant.
    var mid1 = (p1.o + p1.c) / 2;
    if (p3.c < mid1) return false;
    if (p3.bodyPctOfRange < 0.5) return false;
    return true;
  }
  function isEveningStar(c1, c2, c3) {
    var p1 = candleParts(c1), p2 = candleParts(c2), p3 = candleParts(c3);
    if (p1.range <= 0 || p3.range <= 0) return false;
    if (!p1.isBull || !p3.isBear) return false;
    if (p1.bodyPctOfRange < 0.5) return false;
    if (p2.body > p1.body * 0.4) return false;
    if (Math.min(p2.o, p2.c) <= p1.c) return false;   // gap-up above bar 1 close
    var mid1 = (p1.o + p1.c) / 2;
    if (p3.c > mid1) return false;
    if (p3.bodyPctOfRange < 0.5) return false;
    return true;
  }

  // ── 3-bar: Morning / Evening DOJI Star ──
  // Stronger, more specific variants of the Star where the middle
  // bar is a true DOJI (open ≈ close — maximal indecision) rather
  // than just a small body. The doji at the turn is a higher-
  // conviction reversal signal than a small-body star. Same gap +
  // significant-bar-1/bar-3 + close-past-midpoint structure as the
  // regular Star, but bar 2 must satisfy isDoji().
  function isMorningDojiStar(c1, c2, c3) {
    var p1 = candleParts(c1), p3 = candleParts(c3);
    if (p1.range <= 0 || p3.range <= 0) return false;
    if (!p1.isBear || !p3.isBull) return false;
    if (p1.bodyPctOfRange < 0.5) return false;          // significant bear
    if (!isDoji(c2)) return false;                      // middle MUST be a doji
    var p2 = candleParts(c2);
    if (Math.max(p2.o, p2.c) >= p1.c) return false;     // doji gaps below bar 1 close
    var mid1 = (p1.o + p1.c) / 2;
    if (p3.c < mid1) return false;                      // bar 3 closes past midpoint
    if (p3.bodyPctOfRange < 0.5) return false;          // significant bull
    return true;
  }
  function isEveningDojiStar(c1, c2, c3) {
    var p1 = candleParts(c1), p3 = candleParts(c3);
    if (p1.range <= 0 || p3.range <= 0) return false;
    if (!p1.isBull || !p3.isBear) return false;
    if (p1.bodyPctOfRange < 0.5) return false;          // significant bull
    if (!isDoji(c2)) return false;                      // middle MUST be a doji
    var p2 = candleParts(c2);
    if (Math.min(p2.o, p2.c) <= p1.c) return false;     // doji gaps above bar 1 close
    var mid1 = (p1.o + p1.c) / 2;
    if (p3.c > mid1) return false;                      // bar 3 closes past midpoint
    if (p3.bodyPctOfRange < 0.5) return false;          // significant bear
    return true;
  }

  // ── 3-bar: Three White Soldiers / Three Black Crows ──
  // Three consecutive strong bull/bear candles, each opening
  // INSIDE the previous body (not gap) + each closing higher/lower
  // than the previous. Small upper wicks (≤ body/3) = no rejection.
  function isThreeWhiteSoldiers(c1, c2, c3) {
    var p1 = candleParts(c1), p2 = candleParts(c2), p3 = candleParts(c3);
    if (!p1.isBull || !p2.isBull || !p3.isBull) return false;
    if (p1.bodyPctOfRange < 0.6 || p2.bodyPctOfRange < 0.6 || p3.bodyPctOfRange < 0.6) return false;
    if (!(p2.c > p1.c && p3.c > p2.c)) return false;        // higher closes
    if (!(p2.o > p1.o && p3.o > p2.o)) return false;        // higher opens
    if (!(p2.o < p1.c && p3.o < p2.c)) return false;        // opens inside prev body
    // Small upper wicks (no rejection at session highs).
    if (p1.upperWick > p1.body / 3) return false;
    if (p2.upperWick > p2.body / 3) return false;
    if (p3.upperWick > p3.body / 3) return false;
    return true;
  }
  function isThreeBlackCrows(c1, c2, c3) {
    var p1 = candleParts(c1), p2 = candleParts(c2), p3 = candleParts(c3);
    if (!p1.isBear || !p2.isBear || !p3.isBear) return false;
    if (p1.bodyPctOfRange < 0.6 || p2.bodyPctOfRange < 0.6 || p3.bodyPctOfRange < 0.6) return false;
    if (!(p2.c < p1.c && p3.c < p2.c)) return false;
    if (!(p2.o < p1.o && p3.o < p2.o)) return false;
    if (!(p2.o > p1.c && p3.o > p2.c)) return false;
    if (p1.lowerWick > p1.body / 3) return false;
    if (p2.lowerWick > p2.body / 3) return false;
    if (p3.lowerWick > p3.body / 3) return false;
    return true;
  }

  // ── Compression patterns: Inside Bar + NR4 ──
  // Inside Bar = current candle's H+L entirely within previous
  //              candle's H+L AND current range ≤ 70% of prev.
  //              "Mother bar / baby bar" compression setup.
  // NR4        = current candle's range is the narrowest of the
  //              last 4 candles. Bollinger-style compression.
  // These don't have a directional bias — caller treats them as
  // "wait for break of high (long) or low (short)".
  function isInsideBar(c1, c2) {
    var p1 = candleParts(c1), p2 = candleParts(c2);
    if (p1.range <= 0 || p2.range <= 0) return false;
    return p2.h < p1.h && p2.l > p1.l && p2.range <= p1.range * 0.7;
  }
  function isNR4(candles) {
    // Needs the LAST 4 candles; current candle's range must be
    // strictly the narrowest (not tied).
    if (!candles || candles.length < 4) return false;
    var last4 = candles.slice(-4);
    var ranges = last4.map(function (c) {
      var p = candleParts(c);
      return p.range;
    });
    var lastRange = ranges[3];
    for (var i = 0; i < 3; i++) {
      if (ranges[i] <= lastRange) return false;     // not strictly narrowest
    }
    return true;
  }

  // ══════════════════════════════════════════════════════════════
  // detectPatterns — priority-ordered classifier
  // ──────────────────────────────────────────────────────────────
  // Returns { bull, bear, compression, neutral } where each field
  // is either a string (pattern name) or null. Only ONE pattern is
  // reported per side — the highest-priority one that matches.
  // Compression + neutral are independent (can coexist with a
  // bull/bear pattern, though typically one wins).
  //
  // The `trend` argument is optional. When provided ('BULL' /
  // 'STRONG_BULL' / 'BEAR' / 'STRONG_BEAR' / 'NEUTRAL'), the
  // Hammer-shape candle is reclassified:
  //   • Hammer shape at TOP of bull trend → 'Hanging Man' (bear)
  //   • Hammer shape anywhere else        → 'Hammer' (bull)
  //   • Inverted-Hammer shape at TOP      → 'Shooting Star' (bear)
  //   • Inverted-Hammer shape elsewhere   → 'Inverted Hammer' (bull)
  // Priority orders (strongest first):
  //   Bull : Morning Star > 3 White Soldiers > Bullish Engulfing
  //        > Piercing > Dragonfly Doji > Bullish Marubozu
  //        > Inverted Hammer > Hammer > Tweezer Bottom > Bullish Harami
  //   Bear : Evening Star > 3 Black Crows  > Bearish Engulfing
  //        > Dark Cloud Cover > Gravestone Doji > Bearish Marubozu
  //        > Hanging Man > Shooting Star > Tweezer Top > Bearish Harami
  // ══════════════════════════════════════════════════════════════
  function detectPatterns(candles, trend) {
    var n = candles.length;
    if (n < 2) return { bull: null, bear: null, compression: null, neutral: null };
    var last = candles[n - 1];
    var prev = candles[n - 2];
    var prevPrev = n >= 3 ? candles[n - 3] : null;
    // Normalize trend — only TOP-of-uptrend matters for Hanging Man.
    var trendUp = (trend === 'BULL' || trend === 'STRONG_BULL');
    var bull = null, bear = null, compression = null, neutral = null;

    // ── 3-bar patterns (highest priority) ──
    // Doji-Star variants are MORE specific than the plain Star (their
    // middle bar is a true doji), so they're tested first and win the
    // label when both match.
    if (prevPrev) {
      if (isMorningDojiStar(prevPrev, prev, last))      bull = 'Morning Doji Star';
      else if (isMorningStar(prevPrev, prev, last))     bull = 'Morning Star';
      if (isEveningDojiStar(prevPrev, prev, last))      bear = 'Evening Doji Star';
      else if (isEveningStar(prevPrev, prev, last))     bear = 'Evening Star';
      if (!bull && isThreeWhiteSoldiers(prevPrev, prev, last)) bull = 'Three White Soldiers';
      if (!bear && isThreeBlackCrows(prevPrev, prev, last))    bear = 'Three Black Crows';
    }

    // ── 2-bar patterns ──
    if (!bull && isBullishEngulfing(prev, last)) bull = 'Bullish Engulfing';
    if (!bear && isBearishEngulfing(prev, last)) bear = 'Bearish Engulfing';
    if (!bull && isPiercing(prev, last))         bull = 'Piercing Pattern';
    if (!bear && isDarkCloudCover(prev, last))   bear = 'Dark Cloud Cover';

    // ── 1-bar Doji family (more specific than Hammer/Star) ──
    if (!bull && isDragonflyDoji(last))   bull = 'Dragonfly Doji';
    if (!bear && isGravestoneDoji(last))  bear = 'Gravestone Doji';

    // ── 1-bar Marubozu (continuation; reported AFTER reversals
    //    since reversals take priority when both fire — rare but
    //    possible on edge cases). ──
    if (!bull && isBullishMarubozu(last)) bull = 'Bullish Marubozu';
    if (!bear && isBearishMarubozu(last)) bear = 'Bearish Marubozu';

    // ── 1-bar wick-rejection (Hammer / Inverted Hammer / Shooting Star / Hanging Man) ──
    // Hammer SHAPE: reclassified to Hanging Man if at top of uptrend.
    if (!bull && !bear && isHammer(last)) {
      if (trendUp) bear = 'Hanging Man';
      else         bull = 'Hammer';
    }
    // Inverted-Hammer SHAPE: reclassified to Shooting Star at top.
    if (!bull && !bear && isInvertedHammer(last)) {
      if (trendUp) bear = 'Shooting Star';
      else         bull = 'Inverted Hammer';
    }

    // ── 2-bar Tweezer + Harami (lowest reversal priority) ──
    if (!bull && isTweezerBottom(prev, last)) bull = 'Tweezer Bottom';
    if (!bear && isTweezerTop(prev, last))    bear = 'Tweezer Top';
    if (!bull && isBullishHarami(prev, last)) bull = 'Bullish Harami';
    if (!bear && isBearishHarami(prev, last)) bear = 'Bearish Harami';

    // ── Compression patterns (orthogonal to bull/bear) ──
    // Reported alongside any bull/bear pattern. Inside Bar wins
    // over NR4 when both fire since IB is more specific.
    if (isInsideBar(prev, last))           compression = 'Inside Bar';
    else if (n >= 4 && isNR4(candles))     compression = 'NR4';

    // ── Neutral Doji (informational; surfaces in SKIP IF) ──
    if (!bull && !bear && isNeutralDoji(last)) neutral = 'Doji';

    return { bull: bull, bear: bear, compression: compression, neutral: neutral };
  }

  // ═══════════════════════════════════════════════════════════════
  // LOOKBACK PATTERN DETECTION
  // ═══════════════════════════════════════════════════════════════
  // detectPatterns only inspects the LAST candle in the array. For
  // smaller TFs (5m / 3m) it's very common for the current bar to
  // be a "boring" mid-range candle that fires no pattern — which
  // leaves the per-TF card visually empty.
  //
  // detectLookbackPattern walks backward and returns the MOST
  // RECENT prior bar that fired any directional pattern, so the
  // renderer can show "Last pattern: Hammer 3 bars ago" instead of
  // a blank panel. Used for DISPLAY ONLY — stale patterns are NOT
  // fed into the scoring pipeline because the entry trigger they
  // imply has already passed.
  function detectLookbackPattern(candles, trend, maxLookback) {
    if (!candles || candles.length < 3) return null;
    // ago=1 → second-to-last bar treated as "last", ago=2 → 3rd
    // from end, etc. We stop as soon as ANY directional pattern
    // (bull or bear) fires. Compression / neutral don't count
    // here — they're "wait for break" markers, not reversals.
    for (var ago = 1; ago <= maxLookback && ago < candles.length - 1; ago++) {
      var slice = candles.slice(0, candles.length - ago);
      var r = detectPatterns(slice, trend);
      if (r.bull || r.bear) {
        return {
          bull:    r.bull,
          bear:    r.bear,
          barsAgo: ago,
          candle:  candles[candles.length - 1 - ago]
        };
      }
    }
    return null;
  }


  // ── Central Pivot Range (CPR) — Indian intraday-desk standard ──
  // Subhadip-Nandy-style floor pivots + the central range. Computed ONCE from
  // the PREVIOUS completed session's High / Low / Close, so the whole level set
  // is static all day and is inherently NON-REPAINTING — callers MUST never
  // feed today's still-forming bars in (anchor strictly on the prior session).
  //   P  (Pivot)          = (H + L + C) / 3
  //   BC (Bottom Central) = (H + L) / 2
  //   TC (Top Central)    = 2*P - BC            (mirror of BC across P)
  //   R1 = 2*P - L ; R2 = P + (H-L) ; R3 = R1 + (H-L)
  //   S1 = 2*P - H ; S2 = P - (H-L) ; S3 = S1 - (H-L)
  // TC can fall BELOW BC when the prior close sat under the H/L midpoint; by
  // convention TC is always the UPPER boundary, so we swap to guarantee TC>=BC.
  // Width is classified against the PREVIOUS day's range (the industry-standard
  // self-scaling normalisation — keeps the heuristic valid across instruments
  // and volatility regimes):
  //   NARROW : width <= 25% of prev range  → trending-day signal (pick a side)
  //   NORMAL : 25% < width <= 60%          → average day
  //   WIDE   : width > 60%                 → range-day signal (mean-reversion)
  // PURE + FAIL-SAFE: returns null on any non-finite / degenerate input rather
  // than emitting a guessed level (real capital reads these — never fabricate).
  function computeCPR(prevHigh, prevLow, prevClose) {
    var H = +prevHigh, L = +prevLow, C = +prevClose;
    if (!isFinite(H) || !isFinite(L) || !isFinite(C)) return null;
    if (!(H >= L)) return null;
    var range = H - L;
    var P  = (H + L + C) / 3;
    var BC = (H + L) / 2;
    var TC = 2 * P - BC;
    var top = Math.max(TC, BC), bot = Math.min(TC, BC);
    var width = top - bot;
    var widthPctOfRange = range > 0 ? (width / range) * 100 : null;
    var classification = 'UNKNOWN';
    if (widthPctOfRange != null) {
      if (widthPctOfRange <= 25)      classification = 'NARROW';
      else if (widthPctOfRange <= 60) classification = 'NORMAL';
      else                            classification = 'WIDE';
    }
    return {
      P: P, TC: top, BC: bot,
      R1: 2 * P - L, R2: P + range, R3: (2 * P - L) + range,
      S1: 2 * P - H, S2: P - range, S3: (2 * P - H) - range,
      width: width, widthPctOfRange: widthPctOfRange,
      classification: classification, prevClose: C
    };
  }


  // ── Namespace export (consumed by swing-analyzer.js alias block) ──
  window.IndicatorMath = {
    ema: ema,
    sma: sma,
    rsi: rsi,
    macd: macd,
    atr: atr,
    emReturnSigma: emReturnSigma,
    emBand: emBand,
    EM_HORIZONS_BY_TF: EM_HORIZONS_BY_TF,
    swingHighs: swingHighs,
    swingLows: swingLows,
    istDateKeyLocal: istDateKeyLocal,
    medianOfArr: medianOfArr,
    ATR_MEDIAN_BARS_BY_TF: ATR_MEDIAN_BARS_BY_TF,
    getMedian20dATR: getMedian20dATR,
    cappedAtrValue: cappedAtrValue,
    cappedAtrSeries: cappedAtrSeries,
    istDateKeyForTs: istDateKeyForTs,
    dropGapBars: dropGapBars,
    _zigzagFrom: _zigzagFrom,
    classifyStructure: classifyStructure,
    TREND_PARAMS_BY_TF: TREND_PARAMS_BY_TF,
    adx: adx,
    supertrend: supertrend,
    stochastic: stochastic,
    obv: obv,
    candleParts: candleParts,
    isBullishEngulfing: isBullishEngulfing,
    isBearishEngulfing: isBearishEngulfing,
    isHammer: isHammer,
    isInvertedHammer: isInvertedHammer,
    isShootingStar: isShootingStar,
    isDoji: isDoji,
    isDragonflyDoji: isDragonflyDoji,
    isGravestoneDoji: isGravestoneDoji,
    isNeutralDoji: isNeutralDoji,
    isBullishMarubozu: isBullishMarubozu,
    isBearishMarubozu: isBearishMarubozu,
    isPiercing: isPiercing,
    isDarkCloudCover: isDarkCloudCover,
    isBullishHarami: isBullishHarami,
    isBearishHarami: isBearishHarami,
    isTweezerBottom: isTweezerBottom,
    isTweezerTop: isTweezerTop,
    isMorningStar: isMorningStar,
    isEveningStar: isEveningStar,
    isMorningDojiStar: isMorningDojiStar,
    isEveningDojiStar: isEveningDojiStar,
    isThreeWhiteSoldiers: isThreeWhiteSoldiers,
    isThreeBlackCrows: isThreeBlackCrows,
    isInsideBar: isInsideBar,
    isNR4: isNR4,
    detectPatterns: detectPatterns,
    detectLookbackPattern: detectLookbackPattern,
    computeCPR: computeCPR,
  };
})();
