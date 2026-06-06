/* ════════════════════════════════════════════════════════════════════
 * chart-patterns.js — Tier-1 GEOMETRIC (multi-swing) chart patterns
 * ════════════════════════════════════════════════════════════════════
 *
 * Adds Head & Shoulders, Inverse H&S, Double Top (M), Double Bottom (W)
 * and Cup & Handle to the swing chart — the structural cousins of the
 * single-/few-bar candlestick patterns in swing-analyzer.js. Detection is
 * built on CONFIRMED swing pivots; nothing is drawn off the live bar.
 *
 * Full spec + tiers: docs/chart-patterns.md.
 *
 * ── Why this is its own file (and stays out of swing-analyzer.js) ──
 * swing-analyzer.js is already a 16K-line single IIFE. Per the JS module
 * split contract (AGENTS.md §18) we keep new domains in their own file.
 * This module is loaded as a classic <script defer> AFTER swing-analyzer.js
 * and talks to the swing closure through ONE small bridge object that swing
 * publishes on `window._swCP` (candleTime / drawPriceLevel / getRawForTf /
 * renderMainChart / detectZones / computeFibZone). Everything else —
 * detection, geometry, overlay drawing, the cards — lives here.
 *
 * ── Real-money invariants (mirror the candlestick overlay) ──
 *  • NO REPAINTING. Pivots need `lookback` confirmed bars on BOTH sides, so
 *    the forming bar can never be a pivot. The breakout/confirmation bar
 *    must be a CLOSED bar: while the market is open we ignore the last bar,
 *    and when market state is UNKNOWN we ALSO ignore it (fail-safe).
 *  • A pattern is a SETUP, not a signal, until its neckline / resistance is
 *    broken by a confirmed close. Pre-break = PENDING (watch); post-break =
 *    CONFIRMED. We never call a PENDING shape a BUY/SELL.
 *  • Every row carries a measured-move TARGET and an INVALIDATION level. No
 *    target/stop ⇒ no row.
 *  • Conservative tolerances — prefer a missed pattern over a false one.
 *  • If the structure breaks the WRONG way first (e.g. a "double top" makes
 *    a new high before breaking its neckline), the candidate is discarded —
 *    never shown, not even as PENDING.
 * ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var IST_OFF_SEC = 19800;            // +5:30 in seconds

  // Colours reuse the candlestick palette so direction reads the same.
  var BULL = '#09a86e', BEAR = '#c91f3a';
  var BULL_STRONG = '#067a4f', BEAR_STRONG = '#9e1730';
  // Trade-plan convention (matches Entry/SL/T1/T2 elsewhere): blue = entry/
  // trigger, green = target, red = invalidation/stop — independent of the
  // pattern's direction. ENTRY_BLUE mirrors drawPriceLevel's '#3b82f6' Entry so
  // the chart-pattern entry reads the SAME as the trade-plan entry, and avoids
  // a green-on-green (entry vs target) or red-on-red (bearish entry vs
  // invalidation) clash on the y-axis.
  var ENTRY_BLUE = '#3b82f6', TARGET_GREEN = '#22c55e', STOP_RED = '#ef4444';
  // A resolved-FAILED pattern is drawn muted/grey so the eye reads it as
  // "this one didn't work" — kept on the chart for validation, not as a signal.
  var FAILED_GREY = '#8a8f98';

  // Pivot lookback per TF. Bigger = fewer, more significant pivots = fewer
  // false patterns. Lower TFs are noisier, so we widen the lookback there.
  var PIVOT_LB = { '5m': 4, '15m': 4, '30m': 4, '1h': 3, '4h': 3, '1d': 4, '1w': 3, '1mo': 2 };

  // Geometry tolerances (conservative on purpose — see docs/chart-patterns.md).
  var PEAK_TOL     = 0.03;   // double top/bottom: two peaks/troughs within 3%
  var SHOULDER_TOL = 0.05;   // H&S: left vs right shoulder within 5%
  var HEAD_MARGIN  = 0.015;  // H&S head must clear both shoulders by ≥1.5% (was 0.5% — too
                             //   loose: near-flat triple-tops were mislabeled H&S)
  // H&S quality gates (symmetry-free — added 2026-06-06 after a single-spike
  // top on HINDUNILVR/1d was wrongly tagged H&S). A real H&S has two shoulders
  // that clearly clear the neckline and a head that is a rounded top, NOT a
  // lone one-bar spike. Both gates are independent of left/right symmetry, so
  // genuinely lopsided (but real) H&S still passes.
  var SHOULDER_PROM = 0.35;  // each shoulder must rise ≥35% of the head's height above the neck
  var HEAD_NEIGHBOR = 0.5;   // ≥1 bar adjacent to the head must reach ≥50% of the head height
                             //   above the neck — a vertical spike's neighbors collapse to it
  var MIN_VALLEY   = 0.03;   // double top: trough ≥3% below peaks (real valley)
  var BREAK_BUF    = 0.003;  // 0.3% buffer for "broke the wrong way" guard
  var MAX_ROWS     = 6;      // cap rows we surface overall (recency) — incl. resolved history
  var CUP_MIN_W    = 12;     // cup must span ≥12 bars (filters tiny wiggles)
  var CUP_DEPTH_LO = 0.10;   // cup depth 10%–45% of the rim price
  var CUP_DEPTH_HI = 0.45;
  var CUP_HANDLE_MAXRETR = 0.5;  // handle pulls back ≤50% of cup depth

  // ── History view toggle ──────────────────────────────────────────────
  // Default OFF: the chart + cards show only ACTIONABLE (LIVE / WATCH)
  // patterns, so the default view stays calm. Resolved (WORKED / FAILED)
  // patterns are the AUDIT TRAIL — kept for validation but revealed only on
  // demand via the cards' "Show history" chip. Persisted so it sticks.
  var HIST_KEY = 'cp_show_history_v1';
  var showHistory = (function () {
    try { return localStorage.getItem(HIST_KEY) === '1'; } catch (_) { return false; }
  })();
  function isResolved(r) { return r.outcome === 'TARGET_HIT' || r.outcome === 'FAILED'; }
  function isActionable(r) { return !isResolved(r); }

  // ── Inspect-one focus ────────────────────────────────────────────────
  // Which RESOLVED pattern is currently "inspected" (full skeleton + plan
  // drawn). Stacking every resolved skeleton at once overlaps and is
  // unreadable, so resolved history shows as small ✓/✗ markers UNTIL you tap
  // its card — then just that one expands to its full shape + target +
  // invalidation. `null` = nothing inspected. Keyed by the row's anchorIdx
  // (breakout/confirmation bar — unique per pattern on a given render).
  var focusKey = null;

  var TF_LABEL = {
    '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour',
    '4h': '4 hour', '1d': 'Daily', '1w': 'Weekly', '1mo': 'Monthly'
  };

  // ── tiny utils (kept local — no swing-closure dependency) ──
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fp(n) { return '\u20B9' + (isFinite(n) ? Number(n).toFixed(2) : '\u2014'); }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dateLabel(ts, tf) {
    var ms = new Date(ts).getTime();
    if (!isFinite(ms)) return '';
    var ist = new Date(ms + IST_OFF_SEC * 1000);
    var base = ist.getUTCDate() + ' ' + MONTHS[ist.getUTCMonth()] + ' ' + ist.getUTCFullYear();
    if (tf === '1d' || tf === '1w' || tf === '1mo') return base;
    var hh = ('0' + ist.getUTCHours()).slice(-2);
    var mm = ('0' + ist.getUTCMinutes()).slice(-2);
    return base + ' ' + hh + ':' + mm;
  }
  // "from → to" span for a card. On intraday TFs where both ends fall on the
  // same IST day, the date is shown once (e.g. "3 Jun 11:15 → 14:15"); on
  // daily/weekly/monthly TFs both ends are plain dates ("3 Jun → 12 Jun").
  function rangeLabel(startTs, endTs, tf) {
    var s = dateLabel(startTs, tf), e = dateLabel(endTs, tf);
    if (!s) return e || '';
    if (!e || s === e) return s;
    var intraday = (tf !== '1d' && tf !== '1w' && tf !== '1mo');
    if (intraday) {
      var sParts = s.split(' '), eParts = e.split(' ');
      // parts = ['3','Jun','2026','11:15'] — compare the "3 Jun 2026" day prefix
      if (sParts[0] === eParts[0] && sParts[1] === eParts[1] && sParts[2] === eParts[2]) {
        e = eParts.slice(3).join(' ');   // same day → keep only the end time
      }
    }
    return s + ' \u2192 ' + e;
  }

  // ── Pivot detection (local copy of swing's swingHighs/swingLows so this
  //    module has ZERO dependency on the swing closure). A pivot needs `lb`
  //    strictly-lower (highs) / strictly-higher (lows) bars on both sides,
  //    which inherently excludes the last `lb` bars → no-repaint by design.
  function swingHighs(asc, lb) {
    var out = [];
    for (var i = lb; i < asc.length - lb; i++) {
      var h = +asc[i][2], ok = true;
      for (var j = 1; j <= lb; j++) {
        if (+asc[i - j][2] >= h || +asc[i + j][2] >= h) { ok = false; break; }
      }
      if (ok) out.push({ idx: i, price: h });
    }
    return out;
  }
  function swingLows(asc, lb) {
    var out = [];
    for (var i = lb; i < asc.length - lb; i++) {
      var l = +asc[i][3], ok = true;
      for (var j = 1; j <= lb; j++) {
        if (+asc[i - j][3] <= l || +asc[i + j][3] <= l) { ok = false; break; }
      }
      if (ok) out.push({ idx: i, price: l });
    }
    return out;
  }

  // Merge highs+lows into one chronological, strictly-ALTERNATING stream.
  // Consecutive same-kind pivots (noise) collapse to the more extreme one,
  // so we always get …H,L,H,L… — which makes the geometry tests clean.
  function altPivots(asc, lb) {
    var piv = [];
    swingHighs(asc, lb).forEach(function (h) { piv.push({ idx: h.idx, price: h.price, kind: 'H' }); });
    swingLows(asc, lb).forEach(function (l) { piv.push({ idx: l.idx, price: l.price, kind: 'L' }); });
    piv.sort(function (a, b) { return a.idx - b.idx; });
    var alt = [];
    for (var i = 0; i < piv.length; i++) {
      var p = piv[i];
      if (alt.length && alt[alt.length - 1].kind === p.kind) {
        var prev = alt[alt.length - 1];
        if (p.kind === 'H') { if (p.price > prev.price) alt[alt.length - 1] = p; }
        else { if (p.price < prev.price) alt[alt.length - 1] = p; }
      } else { alt.push(p); }
    }
    return alt;
  }

  // First CONFIRMED close beyond a (possibly sloped) level, scanning forward.
  // `levelFn(k)` returns the threshold price at bar k. `dir` = 'below'|'above'.
  // Returns the breakout bar index, or -1 if none up to `toIdx`.
  function firstBreak(asc, fromIdx, toIdx, levelFn, dir) {
    for (var k = fromIdx; k <= toIdx; k++) {
      var c = +asc[k][4];
      if (dir === 'below' && c < levelFn(k)) return k;
      if (dir === 'above' && c > levelFn(k)) return k;
    }
    return -1;
  }
  // Did price break the WRONG way (invalidating the setup) before `breakIdx`
  // (or before toIdx if still pending)? For a bearish top: a high above `stop`.
  // For a bullish bottom: a low below `stop`.
  function brokeWrongWay(asc, fromIdx, toIdx, stop, dir) {
    for (var k = fromIdx; k <= toIdx; k++) {
      if (dir === 'bear' && +asc[k][2] > stop * (1 + BREAK_BUF)) return true;
      if (dir === 'bull' && +asc[k][3] < stop * (1 - BREAK_BUF)) return true;
    }
    return false;
  }
  // First-touch outcome of a CONFIRMED pattern. Scanning the bars AFTER the
  // breakout, did price CLOSE through the TARGET or the STOP first? Close-based
  // (no-repaint). SEQUENCE matters: a pattern that reached target THEN later
  // broke the stop still WORKED (you'd be out at target), so whichever level is
  // closed through FIRST wins. A close is a single value and target/stop sit on
  // opposite sides of the breakout, so the two conditions can never both fire
  // on the same bar — no ambiguity. Returns 'TARGET' | 'STOP' | 'OPEN'.
  function resolveOutcome(asc, fromIdx, toIdx, target, stop, dir) {
    for (var k = Math.max(0, fromIdx); k <= toIdx && k < asc.length; k++) {
      var c = +asc[k][4];
      if (dir === 'bull') {
        if (c >= target) return 'TARGET';
        if (c < stop) return 'STOP';
      } else {
        if (c <= target) return 'TARGET';
        if (c > stop) return 'STOP';
      }
    }
    return 'OPEN';
  }
  // Map a (state, first-touch) pair to the lifecycle label we KEEP VISIBLE.
  // We no longer DROP resolved patterns (that hid both wins and losses and made
  // the labelling impossible to validate by eye — survivorship bias). Instead we
  // classify and surface the outcome:
  //   WATCH       — PENDING, neckline not broken yet (a setup, not a signal)
  //   LIVE        — CONFIRMED, neither target nor stop closed through yet (in play)
  //   TARGET_HIT  — CONFIRMED, target reached first (✓ worked — move is done)
  //   FAILED      — CONFIRMED, stop closed through first (✗ thesis broke)
  function outcomeFor(state, asc, br, lastIdx, target, stop, dir) {
    if (state !== 'CONFIRMED') return 'WATCH';
    var res = resolveOutcome(asc, br + 1, lastIdx, target, stop, dir);
    return res === 'TARGET' ? 'TARGET_HIT' : (res === 'STOP' ? 'FAILED' : 'LIVE');
  }
  function lowestLow(asc, a, b) {
    var m = Infinity;
    for (var k = Math.max(0, a); k <= b && k < asc.length; k++) m = Math.min(m, +asc[k][3]);
    return m;
  }
  function highestHigh(asc, a, b) {
    var m = -Infinity;
    for (var k = Math.max(0, a); k <= b && k < asc.length; k++) m = Math.max(m, +asc[k][2]);
    return m;
  }
  function lowestLowIdx(asc, a, b) {
    var m = Infinity, mi = Math.max(0, a);
    for (var k = Math.max(0, a); k <= b && k < asc.length; k++) {
      if (+asc[k][3] < m) { m = +asc[k][3]; mi = k; }
    }
    return mi;
  }

  // ── Confluence: does the pattern's key level sit on a trusted zone? ──
  // Reuses the SAME detectZones the chart draws (via the swing bridge), so a
  // "strong" chart pattern lines up with a demand/supply zone the user sees.
  function zoneHit(raw, dir, lo, hi) {
    var b = window._swCP;
    if (!b || typeof b.detectZones !== 'function') return false;
    var zones;
    try { zones = b.detectZones(raw) || []; } catch (_) { return false; }
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (dir === 'bull' && z.type !== 'DEMAND') continue;
      if (dir === 'bear' && z.type !== 'SUPPLY') continue;
      var zLo = Math.min(z.distal, z.proximal), zHi = Math.max(z.distal, z.proximal);
      if (isFinite(zLo) && isFinite(zHi) && hi >= zLo && lo <= zHi) return true;
    }
    return false;
  }

  // Build a finished row (shared shape). Returns null if target/stop invalid.
  // `asc` (ascending candles) is used only to resolve the pattern's START
  // timestamp (its first pivot bar) so the card can show a from→to span.
  function makeRow(o, asc) {
    if (!isFinite(o.target) || !isFinite(o.stop)) return null;
    var startIdx = (o.pivots && o.pivots.length) ? o.pivots[0].idx : o.anchorIdx;
    var startTs = (asc && asc[startIdx]) ? asc[startIdx][0] : o.ts;
    return {
      name: o.name, short: o.short, dir: o.dir, type: o.type,
      state: o.state,                       // 'PENDING' | 'CONFIRMED'
      outcome: o.outcome || (o.state === 'CONFIRMED' ? 'LIVE' : 'WATCH'), // lifecycle label
      anchorIdx: o.anchorIdx,               // recency sort key
      confirmIdx: (o.confirmIdx == null ? -1 : o.confirmIdx),
      pivots: o.pivots,                     // [{idx,price}] for markers/debug
      neck: o.neck,                         // {x1,y1,x2,y2} segment (idx,price)
      target: o.target, stop: o.stop,
      strong: !!o.strong,                   // confluence emphasis
      startTs: startTs,                     // first pivot bar — span start
      ts: o.ts                              // anchor/breakout bar — span end
    };
  }

  // ══════════════ THE FIVE TIER-1 DETECTORS ══════════════
  // Each scans the alternating pivot stream from the MOST RECENT backwards and
  // returns an ARRAY of every valid candidate (newest first), each tagged with
  // its lifecycle outcome (WATCH / LIVE / TARGET_HIT / FAILED) — so the chart
  // and cards can show the worked/failed HISTORY, not just the latest one.
  // `detect()` then merges, de-dups overlaps, and caps to MAX_ROWS overall.
  // `lastIdx` is the last CONFIRMED bar (live bar already excluded by caller).

  function detectDoubleTop(asc, alt, lastIdx, tf, raw) {
    // Two LEVEL tops with a real valley between. The tops need NOT be adjacent
    // pivots (2026-06-04): an intervening swing high is allowed, but ONLY if it
    // is strictly BELOW both tops — so the pair stays the two dominant peaks
    // (a higher intervening high would BE the real top and is paired instead).
    // The neckline is the LOWEST swing-low pivot between the tops (the deepest
    // reaction low = the most conservative trigger). For a clean adjacent
    // H,L,H this reduces exactly to the old behaviour. All other guards (valley
    // depth, rose-into-top, wrong-way, confirmed close-break, no-repaint) hold.
    var rows = [];
    for (var c = alt.length - 1; c >= 2; c--) {
      if (alt[c].kind !== 'H') continue;                  // P2 — the second top
      var P2 = alt[c], p2 = P2.price;
      var internalHiMax = -Infinity;                      // tallest high between P1 and P2
      for (var a = c - 2; a >= 0; a--) {
        if (alt[a].kind !== 'H') continue;                // P1 candidate — the first top
        var P1 = alt[a], p1 = P1.price, lowPk = Math.min(p1, p2);
        if (Math.abs(p2 - p1) / p1 <= PEAK_TOL           // peaks level
            && internalHiMax < lowPk) {                   // every intervening high below both tops
          // Neckline = lowest swing-low PIVOT between the tops (structural, not
          // a single-bar spike).
          var tr = Infinity, trIdx = -1;
          for (var k = a + 1; k < c; k++) {
            if (alt[k].kind === 'L' && alt[k].price < tr) { tr = alt[k].price; trIdx = alt[k].idx; }
          }
          var okT = (trIdx >= 0)
            && ((lowPk - tr) / lowPk >= MIN_VALLEY)        // real valley
            && (lowestLow(asc, P1.idx - 25, P1.idx) < tr); // rose into the top
          if (okT) {
            var stopT = Math.max(p1, p2);
            var trLvl = tr;
            var startScanT = P2.idx + 1;
            if (startScanT <= lastIdx) {
              var brT = firstBreak(asc, startScanT, lastIdx, function () { return trLvl; }, 'below');
              // A new high above both peaks BEFORE the neckline breaks kills it.
              var wwEndT = brT === -1 ? lastIdx : brT - 1;
              if (!(wwEndT >= startScanT && brokeWrongWay(asc, startScanT, wwEndT, stopT, 'bear'))) {
                var stateT = brT === -1 ? 'PENDING' : 'CONFIRMED';
                var avgPk = (p1 + p2) / 2;
                var targetT = tr - (avgPk - tr);
                var outcomeT = outcomeFor(stateT, asc, brT, lastIdx, targetT, stopT, 'bear');
                var anchorT = brT === -1 ? P2.idx : brT;
                var rowT = makeRow({
                  name: 'Double Top', short: 'Double Top', dir: 'bear', type: 'reversal',
                  state: stateT, outcome: outcomeT, anchorIdx: anchorT, confirmIdx: brT,
                  pivots: [{ idx: P1.idx, price: p1 }, { idx: trIdx, price: tr }, { idx: P2.idx, price: p2 }],
                  neck: { x1: P1.idx, y1: tr, x2: anchorT, y2: tr },
                  target: targetT, stop: stopT,
                  strong: zoneHit(raw, 'bear', lowPk, stopT),
                  ts: asc[anchorT][0]
                }, asc);
                if (rowT) { rows.push(rowT); break; }      // nearest valid pair for this P2
              }
            }
          }
        }
        internalHiMax = Math.max(internalHiMax, p1);        // this high is "intervening" for older P1s
        if (internalHiMax >= p2) break;                     // a high taller than P2 exists → stop
      }
    }
    return rows;
  }

  function detectDoubleBottom(asc, alt, lastIdx, tf, raw) {
    // Mirror of detectDoubleTop (2026-06-04): two LEVEL bottoms with a real
    // peak between, NOT required to be adjacent pivots — an intervening swing
    // low is allowed ONLY if strictly ABOVE both bottoms (so the pair stays the
    // two dominant troughs). Neckline = HIGHEST swing-high pivot between them.
    // Reduces to the old adjacent L,H,L behaviour for a clean base. All guards
    // (valley depth, fell-into-bottom, wrong-way, confirmed break, no-repaint).
    var rows = [];
    for (var c = alt.length - 1; c >= 2; c--) {
      if (alt[c].kind !== 'L') continue;                  // B2 — the second bottom
      var B2 = alt[c], b2 = B2.price;
      var internalLoMin = Infinity;                       // lowest low between B1 and B2
      for (var a = c - 2; a >= 0; a--) {
        if (alt[a].kind !== 'L') continue;                // B1 candidate — the first bottom
        var B1 = alt[a], b1 = B1.price, hiBot = Math.max(b1, b2);
        if (Math.abs(b2 - b1) / b1 <= PEAK_TOL           // bottoms level
            && internalLoMin > hiBot) {                   // every intervening low above both bottoms
          // Neckline = highest swing-high PIVOT between the bottoms.
          var pk = -Infinity, pkIdx = -1;
          for (var k = a + 1; k < c; k++) {
            if (alt[k].kind === 'H' && alt[k].price > pk) { pk = alt[k].price; pkIdx = alt[k].idx; }
          }
          var okB = (pkIdx >= 0)
            && ((pk - hiBot) / hiBot >= MIN_VALLEY)        // real valley
            && (highestHigh(asc, B1.idx - 25, B1.idx) > pk); // fell into the bottom
          if (okB) {
            var stopB = Math.min(b1, b2);
            var pkLvl = pk;
            var startScanB = B2.idx + 1;
            if (startScanB <= lastIdx) {
              var brB = firstBreak(asc, startScanB, lastIdx, function () { return pkLvl; }, 'above');
              // A new low below both troughs BEFORE the neckline breaks kills it.
              var wwEndB = brB === -1 ? lastIdx : brB - 1;
              if (!(wwEndB >= startScanB && brokeWrongWay(asc, startScanB, wwEndB, stopB, 'bull'))) {
                var stateB = brB === -1 ? 'PENDING' : 'CONFIRMED';
                var avgTr = (b1 + b2) / 2;
                var targetB = pk + (pk - avgTr);
                var outcomeB = outcomeFor(stateB, asc, brB, lastIdx, targetB, stopB, 'bull');
                var anchorB = brB === -1 ? B2.idx : brB;
                var rowB = makeRow({
                  name: 'Double Bottom', short: 'Double Bottom', dir: 'bull', type: 'reversal',
                  state: stateB, outcome: outcomeB, anchorIdx: anchorB, confirmIdx: brB,
                  pivots: [{ idx: B1.idx, price: b1 }, { idx: pkIdx, price: pk }, { idx: B2.idx, price: b2 }],
                  neck: { x1: B1.idx, y1: pk, x2: anchorB, y2: pk },
                  target: targetB, stop: stopB,
                  strong: zoneHit(raw, 'bull', stopB, hiBot),
                  ts: asc[anchorB][0]
                }, asc);
                if (rowB) { rows.push(rowB); break; }      // nearest valid pair for this B2
              }
            }
          }
        }
        internalLoMin = Math.min(internalLoMin, b1);        // this low is "intervening" for older B1s
        if (internalLoMin <= b2) break;                     // a low below B2 exists → stop
      }
    }
    return rows;
  }

  function detectHeadShoulders(asc, alt, lastIdx, tf, raw) {
    // …H(LS), L(T1), H(Head), L(T2), H(RS)… Head clearly highest, shoulders ≈.
    var rows = [];
    for (var c = alt.length - 1; c >= 4; c--) {
      if (alt[c].kind !== 'H' || alt[c - 1].kind !== 'L' || alt[c - 2].kind !== 'H'
        || alt[c - 3].kind !== 'L' || alt[c - 4].kind !== 'H') continue;
      var LS = alt[c - 4], T1 = alt[c - 3], HD = alt[c - 2], T2 = alt[c - 1], RS = alt[c];
      var head = HD.price, ls = LS.price, rs = RS.price;
      if (head <= Math.max(ls, rs) * (1 + HEAD_MARGIN)) continue;  // head clears both
      if (Math.abs(rs - ls) / ls > SHOULDER_TOL) continue;          // shoulders ≈
      if (lowestLow(asc, LS.idx - 25, LS.idx) >= Math.min(T1.price, T2.price)) continue; // uptrend in
      // Neckline through the two troughs (sloped). Skip a steeply UP-sloped
      // neckline (weak/ambiguous H&S).
      var slope = (T2.price - T1.price) / Math.max(1, (T2.idx - T1.idx));
      var neckAt = function (x) { return T1.price + slope * (x - T1.idx); };
      if (slope > 0 && slope * (RS.idx - T1.idx) > (head - T1.price) * 0.5) continue;
      // ── Quality gates (symmetry-free) ─────────────────────────────────
      // headHeight uses neckAt(HD.idx) — safe, the head sits BETWEEN T1 and T2
      // (interpolation). Shoulder prominence is measured against the ADJACENT
      // trough (T1 for LS, T2 for RS), NOT an extrapolated neckline — the
      // shoulders lie OUTSIDE [T1,T2], so neckAt() there would extrapolate a
      // sloped neckline and mis-measure a valid (e.g. down-sloping-neck) H&S.
      var headHeight = head - neckAt(HD.idx);
      if (headHeight <= 0) continue;
      // Both shoulders must be genuine peaks above their neckline trough (not base noise).
      if ((ls - T1.price) < SHOULDER_PROM * headHeight) continue;
      if ((rs - T2.price) < SHOULDER_PROM * headHeight) continue;
      // Rounded-head guard: a real head's neighbours stay elevated; a one-bar
      // spike's neighbours collapse toward the neckline.
      var hNbr = Math.max(+asc[HD.idx - 1][2], +asc[HD.idx + 1][2]) - neckAt(HD.idx);
      if (hNbr < HEAD_NEIGHBOR * headHeight) continue;
      var stop = rs;            // a close back above the right shoulder kills it
      var startScan = RS.idx + 1;
      if (startScan > lastIdx) continue;
      var br = firstBreak(asc, startScan, lastIdx, function (k) { return neckAt(k); }, 'below');
      // A close above the right shoulder BEFORE the neckline breaks kills it.
      var wwEnd = br === -1 ? lastIdx : br - 1;
      if (wwEnd >= startScan && brokeWrongWay(asc, startScan, wwEnd, stop, 'bear')) continue;
      var state = br === -1 ? 'PENDING' : 'CONFIRMED';
      var anchor = br === -1 ? RS.idx : br;
      var height = headHeight;
      var target = neckAt(anchor) - height;
      // Keep resolved patterns VISIBLE (no survivorship bias) — classify the
      // outcome (worked / failed / in play) instead of dropping them.
      var outcome = outcomeFor(state, asc, br, lastIdx, target, stop, 'bear');
      var row = makeRow({
        name: 'Head & Shoulders', short: 'H&S', dir: 'bear', type: 'reversal',
        state: state, outcome: outcome, anchorIdx: anchor, confirmIdx: br,
        pivots: [{ idx: LS.idx, price: ls }, { idx: T1.idx, price: T1.price },
          { idx: HD.idx, price: head }, { idx: T2.idx, price: T2.price }, { idx: RS.idx, price: rs }],
        neck: { x1: T1.idx, y1: T1.price, x2: anchor, y2: neckAt(anchor) },
        target: target, stop: stop,
        strong: zoneHit(raw, 'bear', Math.min(ls, rs), head),
        ts: asc[anchor][0]
      }, asc);
      if (row) rows.push(row);
    }
    return rows;
  }

  function detectInverseHS(asc, alt, lastIdx, tf, raw) {
    // …L(LS), H(P1), L(Head), H(P2), L(RS)… Head clearly lowest, shoulders ≈.
    var rows = [];
    for (var c = alt.length - 1; c >= 4; c--) {
      if (alt[c].kind !== 'L' || alt[c - 1].kind !== 'H' || alt[c - 2].kind !== 'L'
        || alt[c - 3].kind !== 'H' || alt[c - 4].kind !== 'L') continue;
      var LS = alt[c - 4], P1 = alt[c - 3], HD = alt[c - 2], P2 = alt[c - 1], RS = alt[c];
      var head = HD.price, ls = LS.price, rs = RS.price;
      if (head >= Math.min(ls, rs) * (1 - HEAD_MARGIN)) continue;   // head below both
      if (Math.abs(rs - ls) / ls > SHOULDER_TOL) continue;
      if (highestHigh(asc, LS.idx - 25, LS.idx) <= Math.max(P1.price, P2.price)) continue; // downtrend in
      var slope = (P2.price - P1.price) / Math.max(1, (P2.idx - P1.idx));
      var neckAt = function (x) { return P1.price + slope * (x - P1.idx); };
      if (slope < 0 && (-slope) * (RS.idx - P1.idx) > (P1.price - head) * 0.5) continue;
      // ── Quality gates (symmetry-free, mirror of H&S) ──────────────────
      // Shoulder prominence measured against the ADJACENT neckline peak
      // (P1 for LS, P2 for RS) to avoid extrapolating a sloped neckline past
      // its anchors — see the H&S detector for the rationale.
      var headHeight = neckAt(HD.idx) - head;
      if (headHeight <= 0) continue;
      // Both shoulders must dip clearly below their neckline peak (not just touch it).
      if ((P1.price - ls) < SHOULDER_PROM * headHeight) continue;
      if ((P2.price - rs) < SHOULDER_PROM * headHeight) continue;
      // Rounded-head guard: a one-bar downside spike's neighbours collapse up
      // toward the neckline; a real rounded bottom keeps them depressed.
      var hNbr = neckAt(HD.idx) - Math.min(+asc[HD.idx - 1][3], +asc[HD.idx + 1][3]);
      if (hNbr < HEAD_NEIGHBOR * headHeight) continue;
      var stop = rs;            // a close back below the right shoulder kills it
      var startScan = RS.idx + 1;
      if (startScan > lastIdx) continue;
      var br = firstBreak(asc, startScan, lastIdx, function (k) { return neckAt(k); }, 'above');
      // A close below the right shoulder BEFORE the neckline breaks kills it.
      var wwEnd = br === -1 ? lastIdx : br - 1;
      if (wwEnd >= startScan && brokeWrongWay(asc, startScan, wwEnd, stop, 'bull')) continue;
      var state = br === -1 ? 'PENDING' : 'CONFIRMED';
      var anchor = br === -1 ? RS.idx : br;
      var height = headHeight;
      var target = neckAt(anchor) + height;
      // Keep resolved patterns VISIBLE (no survivorship bias) — classify the
      // outcome (worked / failed / in play) instead of dropping them.
      var outcome = outcomeFor(state, asc, br, lastIdx, target, stop, 'bull');
      var row = makeRow({
        name: 'Inverse Head & Shoulders', short: 'Inv H&S', dir: 'bull', type: 'reversal',
        state: state, outcome: outcome, anchorIdx: anchor, confirmIdx: br,
        pivots: [{ idx: LS.idx, price: ls }, { idx: P1.idx, price: P1.price },
          { idx: HD.idx, price: head }, { idx: P2.idx, price: P2.price }, { idx: RS.idx, price: rs }],
        neck: { x1: P1.idx, y1: P1.price, x2: anchor, y2: neckAt(anchor) },
        target: target, stop: stop,
        strong: zoneHit(raw, 'bull', head, Math.max(ls, rs)),
        ts: asc[anchor][0]
      }, asc);
      if (row) rows.push(row);
    }
    return rows;
  }

  function detectCupHandle(asc, alt, lastIdx, tf, raw) {
    // Rounded U base between two ≈-height rims, then a shallow handle, then a
    // breakout above the right rim. Deliberately STRICT (continuation only).
    // rightRim = a High with a Low (handle) after it; leftRim = an earlier
    // High of similar height; cupLow = lowest Low between the rims.
    var rows = [];
    for (var c = alt.length - 1; c >= 1; c--) {
      if (alt[c].kind !== 'L') continue;               // candidate handle low
      var handle = alt[c];
      // right rim = the High immediately before the handle low
      if (c - 1 < 0 || alt[c - 1].kind !== 'H') continue;
      var rightRim = alt[c - 1];
      // find an earlier High (left rim) of similar height
      for (var a = c - 3; a >= 0; a--) {
        if (alt[a].kind !== 'H') continue;
        var leftRim = alt[a];
        if (Math.abs(rightRim.price - leftRim.price) / leftRim.price > SHOULDER_TOL) continue;
        if (rightRim.price > leftRim.price * 1.02) continue;   // not already broken out
        var avgRim = (leftRim.price + rightRim.price) / 2;
        var cupLow = lowestLow(asc, leftRim.idx, rightRim.idx);
        var depth = avgRim - cupLow;
        var depthPct = depth / avgRim;
        if (depthPct < CUP_DEPTH_LO || depthPct > CUP_DEPTH_HI) continue;
        if (rightRim.idx - leftRim.idx < CUP_MIN_W) continue;   // wide enough = rounded
        // handle: shallow pullback in the upper half of the cup
        var hRetr = (rightRim.price - handle.price) / depth;
        if (hRetr <= 0 || hRetr > CUP_HANDLE_MAXRETR) continue;
        if (handle.price < cupLow + depth * 0.5) continue;       // upper half only
        if ((handle.idx - rightRim.idx) >= (rightRim.idx - leftRim.idx)) continue; // handle < cup
        if (highestHigh(asc, leftRim.idx - 20, leftRim.idx) < cupLow) continue;     // rose into it (continuation)
        var lvl = function () { return rightRim.price; };
        var startScan = handle.idx + 1;
        var br = startScan <= lastIdx ? firstBreak(asc, startScan, lastIdx, lvl, 'above') : -1;
        // A close below the handle low BEFORE the rim breakout kills the cup.
        var wwEnd = br === -1 ? lastIdx : br - 1;
        if (startScan <= lastIdx && wwEnd >= startScan
          && brokeWrongWay(asc, startScan, wwEnd, handle.price, 'bull')) continue;
        var state = br === -1 ? 'PENDING' : 'CONFIRMED';
        var target = rightRim.price + depth;
        // Keep resolved patterns VISIBLE (no survivorship bias) — classify the
        // outcome (worked / failed / in play) instead of dropping them.
        var outcome = outcomeFor(state, asc, br, lastIdx, target, handle.price, 'bull');
        var anchor = br === -1 ? handle.idx : br;
        var row = makeRow({
          name: 'Cup & Handle', short: 'Cup&Handle', dir: 'bull', type: 'continuation',
          state: state, outcome: outcome, anchorIdx: anchor, confirmIdx: br,
          pivots: [{ idx: leftRim.idx, price: leftRim.price },
            { idx: lowestLowIdx(asc, leftRim.idx, rightRim.idx), price: cupLow },
            { idx: rightRim.idx, price: rightRim.price }, { idx: handle.idx, price: handle.price }],
          neck: { x1: leftRim.idx, y1: rightRim.price, x2: anchor, y2: rightRim.price },
          target: target, stop: handle.price,
          strong: zoneHit(raw, 'bull', cupLow, handle.price),
          ts: asc[anchor][0]
        }, asc);
        if (row) { rows.push(row); break; }   // one cup per handle low; next handle
      }
    }
    return rows;
  }

  // ── Public: pure detection. Returns up to MAX_ROWS rows, most-recent first.
  function detect(raw, tf) {
    if (!raw || raw.length < 20) return [];
    var asc = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var n = asc.length;
    // No-repaint: drop the forming bar while open; drop it too if state is
    // unknown (fail-safe). Same rule as the candlestick overlay.
    var marketOpen = (typeof window.isMarketOpen === 'function') ? !!window.isMarketOpen() : true;
    var lastIdx = marketOpen ? n - 2 : n - 1;
    if (lastIdx < 8) return [];
    var lb = PIVOT_LB[tf] || 3;
    var alt = altPivots(asc, lb);
    if (alt.length < 3) return [];

    var found = [];
    [detectHeadShoulders, detectInverseHS, detectDoubleTop, detectDoubleBottom, detectCupHandle]
      .forEach(function (fn) {
        var rs = null;
        try { rs = fn(asc, alt, lastIdx, tf, raw); } catch (_) { rs = null; }
        if (rs && rs.length) for (var k = 0; k < rs.length; k++) found.push(rs[k]);
      });
    // Most recent first; prefer CONFIRMED over PENDING at the same recency.
    found.sort(function (a, b) {
      if (b.anchorIdx !== a.anchorIdx) return b.anchorIdx - a.anchorIdx;
      return (a.state === 'CONFIRMED' ? -1 : 1) - (b.state === 'CONFIRMED' ? -1 : 1);
    });
    // De-dup overlapping detections (different shapes — or older same-type
    // candidates — anchored on the same bars); keep the most recent / confirmed.
    // Surviving rows are distinct patterns across the history (newest first),
    // capped at MAX_ROWS overall so the worked/failed audit trail stays readable.
    var out = [];
    for (var i = 0; i < found.length && out.length < MAX_ROWS; i++) {
      var r = found[i], dup = false;
      for (var j = 0; j < out.length; j++) {
        if (Math.abs(out[j].anchorIdx - r.anchorIdx) <= lb) { dup = true; break; }
      }
      if (!dup) out.push(r);
    }
    return out;
  }

  // ── Overlay drawing (chart TF). Draws EVERY detected pattern (the same set
  //    the cards show), so the chart and the cards are aligned 1:1. Actionable
  //    (LIVE / WATCH) patterns get the full plan (skeleton + neckline + target +
  //    invalidation); RESOLVED (worked / failed) ones get a skeleton + ✓/✗
  //    marker only — history, not a trade plan (keeps the chart readable).
  //    Uses the swing bridge for candleTime / drawPriceLevel. LineSeries +
  //    price lines are native chart objects, so they auto-reposition and die
  //    with the chart on the next render (no leak, no overlay-updater needed).
  function drawOverlays(ctx) {
    var b = window._swCP, LWC = window.LightweightCharts;
    if (!b || !LWC) return;
    var rows = ctx.rows, asc = ctx.asc, tf = ctx.tf;
    if (!rows || !rows.length) return;
    // Default view shows only ACTIONABLE (LIVE / WATCH) patterns; resolved
    // history is drawn only when the user expands it — so the chart and the
    // cards always show the same set (1:1).
    var visible = rows.filter(function (r) { return showHistory || isActionable(r); });

    // INSPECT MODE — if a card is tapped (focusKey set) and that pattern is in
    // view, draw ONLY that one pattern, full plan (skeleton + neckline + target
    // + invalidation), and nothing else. This is the key to a readable chart:
    // otherwise an actionable pattern's plan lines + the inspected pattern's
    // skeleton coexist and look unrelated ("lines seem off"). One pattern at a
    // time = its geometry stands alone.
    if (focusKey != null) {
      var foc = visible.filter(function (r) { return r.anchorIdx === focusKey; });
      if (foc.length) {
        try { drawOneOverlay(ctx, foc[0], asc, tf, LWC, b, true); }
        catch (e) { console.warn('[chart-patterns] overlay draw failed', e); }
        return;
      }
      // Focused pattern not present on this TF/data → fall back to overview.
    }

    // OVERVIEW MODE — draw oldest → newest so the most-recent pattern's labels
    // render on top. Actionable (LIVE/WATCH) rows draw their full plan; resolved
    // rows draw as a small ✓/✗ marker (tap a card to inspect one in full).
    visible.slice(0, MAX_ROWS).reverse().forEach(function (r) {
      try { drawOneOverlay(ctx, r, asc, tf, LWC, b, false); }
      catch (e) { console.warn('[chart-patterns] overlay draw failed', e); }
    });
  }

  // Draw a single pattern's overlay: skeleton (named) + neckline + target +
  // invalidation. Extracted from drawOverlays so the chart can show all of the
  // detected patterns, matching the cards exactly.
  function drawOneOverlay(ctx, r, asc, tf, LWC, b, focused) {
    var isBull = r.dir === 'bull';
    var failed = r.outcome === 'FAILED';
    var worked = r.outcome === 'TARGET_HIT';
    // Failed patterns are greyed; others keep their direction colour.
    var col = failed
      ? FAILED_GREY
      : (isBull ? (r.strong ? BULL_STRONG : BULL) : (r.strong ? BEAR_STRONG : BEAR));
    // Outcome tag shown on the skeleton arrow + level labels so a resolved
    // pattern can never be mistaken for a fresh actionable signal.
    var tag = worked ? ' \u2713 worked'
      : failed ? ' \u2717 failed'
      : (r.state === 'CONFIRMED' ? '' : ' \u2022 watch');
    var resolved = worked || failed;

    // ── LEVEL TAGS (Y-AXIS ONLY) — drawn for EVERY visible pattern, actionable
    //    AND resolved, so the ENTRY (neckline / resistance break = the trigger),
    //    TARGET and INVALIDATION are always readable off the price axis. (They
    //    used to sit AFTER the resolved early-return below, so a worked/failed
    //    pattern showed only a ✓/✗ marker with no levels — the bug the user hit.)
    //    Tags attach to the CANDLE series (always has data) so they render
    //    reliably — the same proven path as the Entry/SL/T1/T2 trade-plan tags
    //    (drawPriceLevel). lineVisible:false keeps the chart pane clean (no
    //    streaking segments) and price lines don't affect autoscale, so far
    //    targets are safe.
    var neckName = (r.type === 'continuation') ? 'resistance' : 'neckline';
    var bxc = (r.confirmIdx != null && r.confirmIdx >= 0) ? r.confirmIdx : r.anchorIdx;
    var nslope = (r.neck.y2 - r.neck.y1) / ((r.neck.x2 - r.neck.x1) || 1);
    function neckAt(x) { return r.neck.y1 + nslope * (x - r.neck.x1); }
    function axisTag(price, color, title) {
      if (!isFinite(price) || !ctx.series) return;
      try {
        ctx.series.createPriceLine({
          price: price, color: color,
          lineVisible: false, axisLabelVisible: true,
          title: title || ''
        });
      } catch (e) { console.warn('[chart-patterns] axis tag failed', e); }
    }
    // ENTRY blue / TARGET green / INVALIDATION red (same convention as the
    // Entry/SL/T1/T2 trade-plan tags), greyed when the pattern FAILED so a dead
    // level never reads as a live one. Entry = the neckline / resistance break
    // (the trigger you act on); for a sloped H&S neckline we tag the level AT
    // the breakout bar — the price that actually triggers.
    axisTag(neckAt(bxc), failed ? FAILED_GREY : ENTRY_BLUE, r.short + ' entry (' + neckName + ')');
    axisTag(r.target, failed ? FAILED_GREY : TARGET_GREEN, r.short + ' target');
    axisTag(r.stop, failed ? FAILED_GREY : STOP_RED, r.short + ' invalidation');

    // RESOLVED history, NOT inspected → a single ✓/✗ marker at the breakout bar
    // only. Several resolved skeletons overlapping was the clutter problem, so
    // by default history shows just markers. TAP A CARD to inspect one: that
    // sets `focusKey`, and this same pattern then falls through to the full
    // skeleton + neckline + target + invalidation below — so exactly ONE
    // resolved pattern is ever expanded at a time (no pile-up, no overlap).
    if (resolved && !focused) {
      try {
        var mIdx = (r.confirmIdx != null) ? r.confirmIdx : r.anchorIdx;
        var mk = ctx.chart.addSeries(LWC.LineSeries, {
          color: col, lineWidth: 1,
          lastValueVisible: false, priceLineVisible: false,
          crosshairMarkerVisible: false, pointMarkersVisible: false
        });
        mk.setData([{ time: b.candleTime(asc[mIdx][0], tf), value: asc[mIdx][4] }]);
        LWC.createSeriesMarkers(mk, [{
          time: b.candleTime(asc[mIdx][0], tf),
          position: isBull ? 'belowBar' : 'aboveBar',
          color: col, shape: 'circle', text: r.short + tag, size: 1
        }]);
      } catch (e) { console.warn('[chart-patterns] resolved marker draw failed', e); }
      return;
    }

    // 1) PATTERN SKELETON — a thin dotted zig-zag through the pattern's pivots,
    //    so it actually LOOKS like an M / W / H&S / cup on the chart (this is
    //    the main visual; the abstract target/invalid lines alone don't read as
    //    a pattern). Point markers sit on each pivot; a labelled arrow names it.
    try {
      var skel = ctx.chart.addSeries(LWC.LineSeries, {
        color: col, lineWidth: 1, lineStyle: 1,   // thin DOTTED — a light guide, not a heavy overlay
        lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
        pointMarkersVisible: true, pointMarkersRadius: 3
      });
      var pts = r.pivots
        .slice()
        .sort(function (a, c) { return a.idx - c.idx; })
        .map(function (p) { return { time: b.candleTime(asc[p.idx][0], tf), value: p.price }; });
      skel.setData(pts);
      // Name label at the extreme pivot (the head / a peak / a trough).
      var lbl = r.pivots[0];
      for (var i = 1; i < r.pivots.length; i++) {
        if (isBull ? (r.pivots[i].price < lbl.price) : (r.pivots[i].price > lbl.price)) lbl = r.pivots[i];
      }
      LWC.createSeriesMarkers(skel, [{
        time: b.candleTime(asc[lbl.idx][0], tf),
        position: isBull ? 'belowBar' : 'aboveBar',
        color: col, shape: isBull ? 'arrowUp' : 'arrowDown',
        text: r.short + tag, size: 2
      }]);
    } catch (e) { console.warn('[chart-patterns] skeleton draw failed', e); }
    // (Level tags — entry / target / invalidation — are drawn ABOVE, before the
    //  resolved early-return, so every visible pattern carries them.)
  }

  // ── Cards (below the chart) — single source of truth with the overlay. ──
  function locVerdict(r) {
    if (r.strong && r.dir === 'bull') return {
      cls: 'sw-cp-loc-strong-bull', label: 'At demand zone',
      note: 'Bullish pattern sitting on a demand zone (support) — the strongest long context.'
    };
    if (r.strong && r.dir === 'bear') return {
      cls: 'sw-cp-loc-strong-bear', label: 'At supply zone',
      note: 'Bearish pattern sitting on a supply zone (resistance) — a strong short / exit context.'
    };
    return { cls: 'sw-cp-loc-none', label: 'Open space',
      note: 'No nearby zone — weaker on its own; needs other confluence.' };
  }
  function actionNote(r) {
    var dirWord = r.dir === 'bull' ? 'bullish' : 'bearish';
    // Resolved patterns are kept for VALIDATION (eyeball the hit-rate) — say so
    // plainly so they read as history, never as a fresh actionable signal.
    if (r.outcome === 'TARGET_HIT') {
      return 'Played out — price reached the ' + fp(r.target) + ' target after a confirmed '
        + dirWord + ' break. Shown for validation; the move is done.';
    }
    if (r.outcome === 'FAILED') {
      return 'Failed — price closed back through the ' + fp(r.stop) + ' invalidation after the '
        + dirWord + ' break. Shown for validation; the thesis broke.';
    }
    if (r.state === 'CONFIRMED') {   // LIVE — still in play
      return r.dir === 'bull'
        ? 'Confirmed ' + dirWord + ' break, in play. Target ' + fp(r.target) + '; thesis invalid on a close below ' + fp(r.stop) + '.'
        : 'Confirmed ' + dirWord + ' break, in play. Target ' + fp(r.target) + '; thesis invalid on a close above ' + fp(r.stop) + '.';
    }
    return 'Setup forming (' + dirWord + '). WATCH — not a signal until a confirmed '
      + (r.dir === 'bull' ? 'close above the neckline' : 'close below the neckline')
      + '. Then target ' + fp(r.target) + ', invalid at ' + fp(r.stop) + '.';
  }
  // Lifecycle → card badge label + class suffix (styled in swing-analyzer.css).
  var OUTCOME_BADGE = {
    WATCH:      { label: 'WATCH',        cls: 'watch' },
    LIVE:       { label: 'LIVE',         cls: 'live' },
    TARGET_HIT: { label: '\u2713 WORKED', cls: 'worked' },
    FAILED:     { label: '\u2717 FAILED', cls: 'failed' }
  };

  function paintCards(rows, tf) {
    var host = document.getElementById('sw-chart-pattern-cards');
    if (!host) return;
    if (!rows || !rows.length) { host.hidden = true; host.innerHTML = ''; return; }
    var tfLabel = TF_LABEL[tf] || tf;
    var capped = rows.slice(0, MAX_ROWS);
    // Split: actionable (LIVE / WATCH) always shown; resolved (worked / failed)
    // is the audit trail, appended only when the user expands history.
    var actionable = capped.filter(isActionable);
    var resolved = capped.filter(isResolved);
    var nWorked = resolved.filter(function (r) { return r.outcome === 'TARGET_HIT'; }).length;
    var nFailed = resolved.filter(function (r) { return r.outcome === 'FAILED'; }).length;
    var shown = showHistory ? actionable.concat(resolved) : actionable;

    var cards = shown.map(function (r) {
      var loc = locVerdict(r);
      var arrow = r.dir === 'bull' ? '\u25B2' : '\u25BC';
      var badge = OUTCOME_BADGE[r.outcome] || OUTCOME_BADGE[r.state === 'CONFIRMED' ? 'LIVE' : 'WATCH'];
      var stateBadge = badge.label;
      var note = actionNote(r);
      var span = rangeLabel(r.startTs, r.ts, tf);
      var tip = r.name + ' (' + (r.dir === 'bull' ? 'bullish' : 'bearish') + ', '
        + r.type + '). ' + note + ' \u2014 ' + loc.note
        + ' Forms ' + span + '.';
      var cls = 'sw-cp-card sw-cp-card--' + r.dir
        + (r.strong ? ' is-strong' : '')
        + (r.state === 'CONFIRMED' ? ' is-confirmed' : ' is-pending')
        + (r.anchorIdx === focusKey ? ' is-focused' : '')
        + ' is-' + badge.cls;
      return '<button type="button" class="' + cls + '"'
        + ' onclick="window.swFocusChartPattern(' + r.anchorIdx + ',\'' + tf + '\')"'
        + ' title="' + esc(tip) + '">'
        + '<span class="sw-cp-card-r1">'
          + '<span class="sw-cp-card-arrow">' + arrow + '</span>'
          + '<span class="sw-cp-card-name">' + esc(r.short) + '</span>'
          + '<span class="sw-cp-card-dir sw-cp-card-dir--' + r.dir + '">'
            + (r.dir === 'bull' ? 'Bullish' : 'Bearish') + '</span>'
          + '<span class="sw-cp-card-state">' + stateBadge + '</span>'
        + '</span>'
        + '<span class="sw-cp-card-range" title="When this pattern forms on the chart">'
          + '<svg class="sw-cp-card-range-icon" viewBox="0 0 24 24" aria-hidden="true" '
            + 'fill="none" stroke="currentColor" stroke-width="2" '
            + 'stroke-linecap="round" stroke-linejoin="round">'
            + '<rect x="3" y="4.5" width="18" height="17" rx="2"></rect>'
            + '<line x1="3" y1="9.5" x2="21" y2="9.5"></line>'
            + '<line x1="8" y1="2.5" x2="8" y2="6.5"></line>'
            + '<line x1="16" y1="2.5" x2="16" y2="6.5"></line>'
          + '</svg>'
          + esc(span)
        + '</span>'
        + '<span class="sw-cp-card-r2">'
          + '<span class="sw-cp-card-loc ' + loc.cls + '">' + esc(loc.label) + '</span>'
          + '<span class="sw-cp-card-tgt">T ' + esc(fp(r.target)) + '</span>'
          + '<span class="sw-cp-card-inv">\u2715 ' + esc(fp(r.stop)) + '</span>'
        + '</span>'
        + '<span class="sw-cp-card-note">' + esc(note) + '</span>'
      + '</button>';
    }).join('');

    // "Show history" chip — only when there IS resolved history to reveal.
    // The "Show history" label colours the worked / failed counts so it
    // previews the audit trail at a glance — "Show history (5: 3✓ 2✗)".
    var chip = '';
    if (resolved.length) {
      var chipLbl = showHistory
        ? 'Hide history'
        : ('Show history (' + resolved.length + ': '
            + '<span class="sw-cp-hist-w">' + nWorked + '\u2713</span> '
            + '<span class="sw-cp-hist-f">' + nFailed + '\u2717</span>)');
      chip = '<button type="button" class="sw-cp-hist-toggle' + (showHistory ? ' is-on' : '') + '"'
        + ' onclick="window.swToggleChartPatternHistory()"'
        + ' title="Worked / failed patterns are kept for validation. Toggle to show or hide them on the chart and cards.">'
        + chipLbl + '</button>';
    }

    var body = shown.length
      ? '<div class="sw-cp-card-grid">' + cards + '</div>'
      : '<div class="sw-cp-card-empty">No live or watch setups on this timeframe right now.'
        + (resolved.length ? ' Use \u201CShow history\u201D to review past patterns.' : '')
        + '</div>';

    host.innerHTML =
      '<div class="sw-cp-cards-head">'
        + '<span class="sw-cp-cards-icon" aria-hidden="true">\u25C8</span>'
        + '<span class="sw-cp-cards-title">Chart Patterns</span>'
        + '<span class="sw-cp-cards-sub">' + shown.length + ' shown \u00B7 ' + esc(tfLabel)
          + ' (recommendation TF) \u00B7 tap a card to inspect it on the chart</span>'
        + chip
      + '</div>'
      + body;
    host.hidden = false;
  }

  function clearCards() {
    var host = document.getElementById('sw-chart-pattern-cards');
    if (host) { host.hidden = true; host.innerHTML = ''; }
  }

  // ── Main hook: called by swing-analyzer.js renderMainChart, once per
  //    render, AFTER the candle series + candlestick markers are drawn.
  function onChartRender(ctx) {
    // ctx = { chart, series, inner, raw, tf }
    var tf = ctx.tf, raw = ctx.raw;
    var asc = raw.slice().sort(function (a, b) {
      return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
    var rows = detect(raw, tf);
    drawOverlays({ chart: ctx.chart, series: ctx.series, inner: ctx.inner, asc: asc, rows: rows, tf: tf });
    // Cards follow the RECOMMENDATION TF (window.swGetRecoTf), exactly like the
    // candlestick cards — the chart OVERLAY follows the chart TF (same split as
    // candle arrows-on-chart vs cards-on-reco-TF). When the two TFs match
    // (common), the cards mirror what's drawn; when they differ, clicking a
    // card switches the chart to the reco TF and centres on the pattern.
    renderCardsForReco(tf, raw);
  }

  // Render the cards for the RECOMMENDATION TF (independent of the chart TF).
  // Re-runs on every renderMainChart — including the one swSetRecoTf triggers
  // when the reco TF changes — so the cards update with the reco-TF control.
  // Lazy-loads the reco TF's candles via the swing bridge if not cached.
  function renderCardsForReco(chartTf, chartRaw) {
    var b = window._swCP;
    var ctf = (typeof window.swGetRecoTf === 'function') ? window.swGetRecoTf() : (chartTf || '1d');
    if (ctf === chartTf) { paintCards(detect(chartRaw, ctf), ctf); return; }
    paintCards([], ctf);
    if (b && typeof b.getRawForTf === 'function') {
      b.getRawForTf(ctf).then(function (fresh) {
        try {
          var still = (typeof window.swGetRecoTf === 'function') ? window.swGetRecoTf() : ctf;
          if (still === ctf && fresh && fresh.length) paintCards(detect(fresh, ctf), ctf);
        } catch (_) {}
      }).catch(function () {});
    }
  }

  // Click-to-focus from a card. Cards run on the reco TF; if the chart shows a
  // different TF we switch it first (so the bars line up), then centre. Mirrors
  // swing's window.swFocusPatternBar.
  window.swFocusChartPattern = function (idx, tf) {
    var b = window._swCP; if (!b) return;
    // Toggle inspect: tapping the same card again clears the focus (collapses
    // it back to a marker). Tapping another card moves the focus to it.
    focusKey = (focusKey === idx) ? null : idx;
    function centre() { try { if (b.centerChartBar) b.centerChartBar(idx); } catch (_) {} }
    try {
      // Always re-render so the overlay redraws with the new focus (the
      // inspected pattern expands to its full skeleton + plan, others collapse).
      var curTf = (typeof b.currentChartTf === 'function') ? b.currentChartTf() : null;
      var targetTf = (tf && curTf && curTf !== tf) ? tf : (curTf || tf);
      if (typeof b.renderMainChart === 'function' && targetTf) {
        Promise.resolve(b.renderMainChart(targetTf)).then(centre);
      } else {
        centre();
      }
    } catch (_) {}
  };

  // Toggle the resolved-history view (chart markers + cards together). Persists
  // the choice, then re-renders through the swing bridge so the chart overlay
  // AND the cards refresh from the one render path — keeping them 1:1.
  window.swToggleChartPatternHistory = function () {
    showHistory = !showHistory;
    try { localStorage.setItem(HIST_KEY, showHistory ? '1' : '0'); } catch (_) {}
    var b = window._swCP;
    try {
      if (b && typeof b.renderMainChart === 'function') {
        var tf = (typeof b.currentChartTf === 'function') ? b.currentChartTf() : null;
        if (!tf && typeof window.swGetRecoTf === 'function') tf = window.swGetRecoTf();
        b.renderMainChart(tf || '1d');
      }
    } catch (_) {}
  };

  // ── Diagnostic: dump the detected patterns for the current reco TF with
  //    human-readable pivot dates + prices, so geometry can be verified against
  //    the chart (ground truth, not pixel-guessing). Run in the console:
  //        swDumpChartPatterns()
  window.swDumpChartPatterns = function () {
    var b = window._swCP;
    var tf = (typeof window.swGetRecoTf === 'function') ? window.swGetRecoTf() : '1d';
    function dump(raw) {
      var asc = raw.slice().sort(function (a, c) {
        return new Date(a[0]).getTime() - new Date(c[0]).getTime();
      });
      var rows = detect(raw, tf);
      console.log('%c[chart-patterns] ' + rows.length + ' detected on ' + tf, 'font-weight:bold');
      rows.forEach(function (r, i) {
        var piv = r.pivots.map(function (p) {
          return dateLabel(asc[p.idx][0], tf) + ' @' + Number(p.price).toFixed(2);
        }).join('  |  ');
        console.log(
          '#' + i + '  ' + r.short + '  [' + r.outcome + '/' + r.state + ']' +
          '\n    span : ' + dateLabel(r.startTs, tf) + '  →  ' + dateLabel(r.ts, tf) +
          '\n    pivots: ' + piv +
          '\n    neck : ' + Number(r.neck.y1).toFixed(2) + ' → ' + Number(r.neck.y2).toFixed(2) +
          '   target: ' + Number(r.target).toFixed(2) + '   stop: ' + Number(r.stop).toFixed(2)
        );
      });
      return rows;
    }
    if (b && typeof b.getRawForTf === 'function') return b.getRawForTf(tf).then(dump);
    console.warn('[chart-patterns] no _swCP.getRawForTf bridge available');
  };

  window.ChartPatterns = {
    detect: detect,
    onChartRender: onChartRender,
    paintCards: paintCards,
    clearCards: clearCards
  };
})();
