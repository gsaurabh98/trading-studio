// ===================================================================
// INTRADAY VOLUME + FAKE-BREAKOUT DETECTION — pure, testable helpers.
// ===================================================================
// WHY THIS MODULE EXISTS
//   The intraday chart prices NSE_INDEX|Nifty 50, but the Nifty INDEX reports
//   volume = 0 on Upstox. To judge whether a breakout is real or a trap we need
//   a real volume series, so scripts/intraday-trade.js borrows the NIFTY FUTURES
//   volume (the standard "index volume" proxy). This module owns:
//     • pickFrontMonthFuture — choose the nearest non-expired futures contract
//       from the data/nifty-futures.json snapshot (auto-rollover, fail-safe).
//     • computeRvol          — relative volume of a bar vs its N-bar average.
//     • openingRange         — the session's opening-range high/low (ORH/ORL).
//     • detectFakeBreakouts  — the core non-repainting fake-vs-genuine engine.
//
// DESIGN RULES (real money reads these signals — see .cursor/rules):
//   • NON-REPAINTING: every verdict is computed on CLOSED bars only. The caller
//     MUST pass closed bars (drop the live forming bar). A still-forming pierce
//     is, at most, PENDING — never a confirmed FAKE/GENUINE.
//   • FAIL-SAFE: if futures volume is unavailable (rvol === null) we still report
//     the STRUCTURAL read (wick pierced, closed back inside) but mark volume as
//     "unconfirmed" — we NEVER fabricate a participation claim.
//   • Pure functions only: no DOM, no fetch, no globals. Exposed on
//     window.IntradayVolume (+ individual globals) so the chart module and the
//     Node backtest harness can both consume the SAME math (no drift).
// ===================================================================
(function intradayVolumeLib() {
  'use strict';

  var IST_OFF_MS = 19800 * 1000; // IST = UTC + 5:30
  var SESSION_OPEN_MIN = 9 * 60 + 15;  // 09:15 IST
  var SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

  // IST minute-of-day (0..1439) for an epoch-ms timestamp.
  function istMinOfDay(ms) {
    var d = new Date(ms + IST_OFF_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  // Numeric YYYYMMDD in IST — safe for date comparison (no string-order bugs).
  function istDayNum(ms) {
    var d = new Date(ms + IST_OFF_MS);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }

  // ── Front-month resolver ──────────────────────────────────────────
  // contracts: [{ instrument_key, expiry(ms), trading_symbol, ... }]
  // Returns the nearest contract whose expiry is still in the future, or null
  // when every snapshotted contract has expired (stale file → fail safe to "no
  // volume" rather than pricing a dead contract). Pure; nowMs defaults to now.
  function pickFrontMonthFuture(contracts, nowMs) {
    if (!Array.isArray(contracts) || !contracts.length) return null;
    if (nowMs == null) nowMs = Date.now();
    var live = contracts
      .filter(function (c) { return c && typeof c.instrument_key === 'string' && +c.expiry > nowMs; })
      .slice()
      .sort(function (a, b) { return (+a.expiry) - (+b.expiry); });
    return live.length ? live[0] : null;
  }

  // ── Relative volume (RVOL) ────────────────────────────────────────
  // vols: numeric array (oldest→newest). idx: the bar to score. lookback: how
  // many PRIOR bars form the average. Returns vols[idx] / avg(prior) or null
  // when there isn't enough data or the average is non-positive (e.g. an index
  // that reports 0 volume) — null means "can't confirm", handled fail-safe.
  function computeRvol(vols, idx, lookback) {
    if (!Array.isArray(vols) || idx == null || idx <= 0) return null;
    if (idx >= vols.length) return null;
    lookback = lookback || 20;
    var sum = 0, cnt = 0;
    for (var i = idx - 1; i >= 0 && cnt < lookback; i--) {
      var v = +vols[i];
      if (isFinite(v)) { sum += v; cnt++; }
    }
    if (cnt < 3) return null;            // too few samples to trust an average
    var avg = sum / cnt;
    var cur = +vols[idx];
    if (!(avg > 0) || !isFinite(cur)) return null;
    return cur / avg;
  }

  // ── Opening range (ORH / ORL) ─────────────────────────────────────
  // bars: [{ t(ms), h, l, ... }] ascending. windowMin: minutes after the open
  // that define the opening range (default 15 = first 15 min). Uses the MOST
  // RECENT session present in the data. Returns { high, low, dayNum } or null
  // (fail safe) when the opening-range window isn't represented in the bars.
  function openingRange(bars, windowMin) {
    if (!Array.isArray(bars) || !bars.length) return null;
    windowMin = windowMin || 15;
    // Most recent session day in the data.
    var lastDay = -1;
    for (var i = bars.length - 1; i >= 0; i--) {
      var dn = istDayNum(bars[i].t);
      if (dn > lastDay) lastDay = dn;
    }
    if (lastDay < 0) return null;
    var hi = -Infinity, lo = Infinity, found = false;
    for (var j = 0; j < bars.length; j++) {
      if (istDayNum(bars[j].t) !== lastDay) continue;
      var m = istMinOfDay(bars[j].t);
      if (m < SESSION_OPEN_MIN || m >= SESSION_OPEN_MIN + windowMin) continue;
      var h = +bars[j].h, l = +bars[j].l;
      if (isFinite(h) && h > hi) hi = h;
      if (isFinite(l) && l < lo) lo = l;
      found = true;
    }
    if (!found || !isFinite(hi) || !isFinite(lo)) return null;
    return { high: hi, low: lo, dayNum: lastDay };
  }

  // ── Fake-breakout engine ──────────────────────────────────────────
  // Classifies, per reference level, the MOST RECENT pierce within the lookback
  // window as FAKE (trap), GENUINE (breakout holding), or PENDING (unresolved).
  //
  // bars   : [{ t(ms), o, h, l, c, v }] ascending, CLOSED bars ONLY.
  // levels : [{ id, label, price, dir }] where dir = 'UP' (resistance broken
  //          upward, e.g. PDH/ORH/swing-high) or 'DOWN' (support broken downward,
  //          e.g. PDL/ORL/swing-low).
  // opts   :
  //   atr            — current ATR in index points (sets the noise buffer). If
  //                    absent, falls back to a fraction of price.
  //   bufferAtrMult  — wick must clear level by this × ATR to count as a pierce
  //                    (default 0.05) — filters tick noise.
  //   holdAtrMult    — a CLOSE this × ATR beyond the level counts as "held"
  //                    (default 0.10).
  //   rvolLookback   — bars for the RVOL average (default 20).
  //   rvolGenuine    — RVOL ≥ this confirms participation (default 1.5).
  //   rvolWeak       — RVOL < this = weak/no participation (default 1.0).
  //   resolveWithin  — bars after the pierce to wait for a resolution (default 3).
  //   lookbackBars   — only surface pierces this recent (default 10) so stale
  //                    traps from hours ago aren't reported as live.
  //
  // Returns { events: [...], primary: <event|null> } where each event is:
  //   { id, label, dir, level, kind:'FAKE'|'GENUINE'|'PENDING',
  //     volState:'CONFIRM'|'WEAK'|'EXHAUST'|'UNCONFIRMED', rvol|null,
  //     pierceIdx, pierceT, barsAgo, note }
  function detectFakeBreakouts(bars, levels, opts) {
    opts = opts || {};
    var out = { events: [], primary: null };
    if (!Array.isArray(bars) || bars.length < 4 || !Array.isArray(levels) || !levels.length) return out;

    var n = bars.length;
    var last = bars[n - 1];
    var atr = (isFinite(opts.atr) && opts.atr > 0) ? opts.atr : Math.max(1, (+last.c || 0) * 0.0015);
    var buf = atr * (opts.bufferAtrMult != null ? opts.bufferAtrMult : 0.05);
    var holdBuf = atr * (opts.holdAtrMult != null ? opts.holdAtrMult : 0.10);
    var rvolLookback = opts.rvolLookback || 20;
    var rvolGenuine = opts.rvolGenuine != null ? opts.rvolGenuine : 1.5;
    var rvolWeak = opts.rvolWeak != null ? opts.rvolWeak : 1.0;
    var resolveWithin = opts.resolveWithin != null ? opts.resolveWithin : 3;
    var lookbackBars = opts.lookbackBars != null ? opts.lookbackBars : 10;

    var vols = bars.map(function (b) { return +b.v; });
    var minPierceIdx = Math.max(1, n - lookbackBars);

    for (var li = 0; li < levels.length; li++) {
      var lvl = levels[li];
      if (!lvl || !isFinite(lvl.price)) continue;
      var up = lvl.dir === 'UP';
      var price = +lvl.price;

      // Most recent bar (within the lookback window) whose WICK pierced the
      // level — that's the breakout attempt we judge.
      var pierceIdx = -1;
      for (var i = n - 1; i >= minPierceIdx; i--) {
        var pierced = up ? ((+bars[i].h) > price + buf) : ((+bars[i].l) < price - buf);
        if (pierced) { pierceIdx = i; break; }
      }
      if (pierceIdx < 0) continue;

      var rvol = computeRvol(vols, pierceIdx, rvolLookback);

      // Resolution window: pierce bar through the next `resolveWithin` closed
      // bars (capped at the data we have — all closed, so non-repainting).
      var endIdx = Math.min(n - 1, pierceIdx + resolveWithin);
      var lastClose = +bars[endIdx].c;
      var closedBeyond = up ? (lastClose > price + holdBuf) : (lastClose < price - holdBuf);
      var closedBackInside = up ? (lastClose <= price) : (lastClose >= price);

      // Did ANY bar in the window close clearly beyond (a real breakout print)?
      var everClosedBeyond = false;
      for (var k = pierceIdx; k <= endIdx; k++) {
        var ck = +bars[k].c;
        if (up ? (ck > price + holdBuf) : (ck < price - holdBuf)) { everClosedBeyond = true; break; }
      }

      var kind;
      if (closedBackInside) {
        kind = 'FAKE';            // poked beyond, now rejected back inside
      } else if (closedBeyond) {
        kind = 'GENUINE';         // broke and is holding beyond the level
      } else {
        kind = 'PENDING';         // poked, sitting at the edge — not resolved
      }

      // Volume flavour — only a CLAIM when we actually have futures volume.
      var volState;
      if (rvol == null) {
        volState = 'UNCONFIRMED';
      } else if (kind === 'FAKE') {
        // High-volume reversal = exhaustion/blow-off; low-volume = no-conviction trap.
        volState = (rvol >= rvolGenuine) ? 'EXHAUST' : 'WEAK';
      } else if (kind === 'GENUINE') {
        volState = (rvol >= rvolGenuine) ? 'CONFIRM' : 'WEAK';
      } else { // PENDING
        volState = (rvol >= rvolGenuine) ? 'CONFIRM' : (rvol < rvolWeak ? 'WEAK' : 'UNCONFIRMED');
      }

      out.events.push({
        id: lvl.id || lvl.label || ('lvl' + li),
        label: lvl.label || lvl.id || 'level',
        dir: up ? 'UP' : 'DOWN',
        level: price,
        kind: kind,
        volState: volState,
        rvol: rvol,
        everClosedBeyond: everClosedBeyond,
        pierceIdx: pierceIdx,
        pierceT: bars[pierceIdx].t,
        barsAgo: (n - 1) - pierceIdx,
        note: buildNote(lvl, up, kind, volState, rvol)
      });
    }

    out.events.sort(byPriority);
    out.primary = out.events.length ? out.events[0] : null;
    return out;
  }

  // Priority for the single "headline" event: confirmed FAKE traps first (the
  // most actionable warning), then weak/unconfirmed fakes, then genuine, then
  // pending; ties broken by most-recent pierce.
  function kindRank(e) {
    if (e.kind === 'FAKE') return (e.volState === 'WEAK' || e.volState === 'EXHAUST') ? 0 : 1;
    if (e.kind === 'GENUINE') return 2;
    return 3;
  }
  function byPriority(a, b) {
    var ra = kindRank(a), rb = kindRank(b);
    if (ra !== rb) return ra - rb;
    return b.pierceIdx - a.pierceIdx; // more recent first
  }

  function dirWord(up, kind) {
    if (kind === 'FAKE') return up ? 'above' : 'below';
    return up ? 'above' : 'below';
  }
  function buildNote(lvl, up, kind, volState, rvol) {
    var label = lvl.label || 'the level';
    var rvolTxt = (rvol == null) ? 'volume unavailable' : (rvol.toFixed(2) + '× avg volume');
    if (kind === 'FAKE') {
      if (volState === 'WEAK') {
        return 'Fake breakout ' + dirWord(up, kind) + ' ' + label + ' — price poked through on LOW volume (' + rvolTxt + ') and closed back inside. Classic ' + (up ? 'bull' : 'bear') + ' trap; fade it, don\u2019t chase.';
      }
      if (volState === 'EXHAUST') {
        return 'Failed breakout ' + dirWord(up, kind) + ' ' + label + ' — a high-volume push (' + rvolTxt + ') was rejected and closed back inside. Looks like exhaustion; the move likely reverses.';
      }
      return 'Fake breakout ' + dirWord(up, kind) + ' ' + label + ' — price closed back inside after poking through (' + rvolTxt + '). Treat the breakout as failed until reclaimed.';
    }
    if (kind === 'GENUINE') {
      if (volState === 'CONFIRM') {
        return 'Genuine breakout ' + dirWord(up, kind) + ' ' + label + ' — closed beyond on strong volume (' + rvolTxt + '). Participation confirms the move.';
      }
      if (volState === 'WEAK') {
        return 'Breakout ' + dirWord(up, kind) + ' ' + label + ' is holding but on WEAK volume (' + rvolTxt + ') — no conviction yet; it can still fail.';
      }
      return 'Breakout ' + dirWord(up, kind) + ' ' + label + ' is holding (' + rvolTxt + ').';
    }
    return 'Price is testing ' + label + ' (' + rvolTxt + ') — breakout unconfirmed, wait for a close to resolve it.';
  }

  var API = {
    pickFrontMonthFuture: pickFrontMonthFuture,
    computeRvol: computeRvol,
    openingRange: openingRange,
    detectFakeBreakouts: detectFakeBreakouts,
    // small helpers exposed for reuse/testing
    istMinOfDay: istMinOfDay,
    istDayNum: istDayNum
  };

  if (typeof window !== 'undefined') {
    window.IntradayVolume = API;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API; // Node backtest harness
  }
})();
