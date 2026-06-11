// ═══════════════════════════════════════════════════════════════════
// SHARED UPSTOX RATE-LIMIT GATE  (account-level infrastructure)
// ═══════════════════════════════════════════════════════════════════
// Extracted from scripts/live-chart.js (2026-06-07) into its own file so it
// is owned by NO tab. It is shared by EVERY Upstox caller in the app —
// the live chart, paper-trade, the swing scanner, the option chain, AND the
// self-contained intraday tab. Keeping it standalone means the Options/Live
// tab can be removed later without taking the rate-limiter (and therefore the
// swing + intraday throttling) down with it.
//
// Publishes on window (same global names as before, so the ~30 guarded
// callers across the app keep working unchanged):
//   window._upstoxIsThrottled()       — true while in a 429 cooldown
//   window._upstoxNote429(source)     — call on HTTP 429; extends backoff
//   window._upstoxNoteOk()            — call on a good 2xx; clears the gate
//   window._upstoxBucket              — { tryAcquire(), acquire() } token bucket
//   window._upstoxRateLimit           — shared backoff state object
//
// Status pill: the limiter has NO DOM of its own. It surfaces the cooldown
// countdown through an OPTIONAL hook — window._upstoxStatusHook(state, label)
// — which the live chart registers when it mounts. When the chart isn't
// present (e.g. after the Options tab is removed, or on the intraday tab),
// the hook is simply absent and the limiter logs to the console only. Load
// this BEFORE live-chart.js / swing-analyzer.js / intraday-*.js (it already
// is, via the <script defer> order in the shell) — but every consumer guards
// with `typeof`, so a late load only means the first poll skips the gate.
(function () {
  'use strict';

  // Optional pill updater — registered by live-chart.js (window._upstoxStatusHook).
  // Wrapped so a missing/throwing hook can never break the rate-limit logic.
  function _emitStatus(state, label) {
    try {
      if (typeof window._upstoxStatusHook === 'function') {
        window._upstoxStatusHook(state, label);
      }
    } catch (_) { /* hook not available / threw — non-fatal */ }
  }

  // Why: Upstox V2 market-quote/ltp has a 30-min budget of ~2 000 calls.
  // Two pollers at 1-second cadence = 2 req/sec = 3 600/30-min, blowing
  // the ceiling after ~17 minutes of continuous polling. The user then
  // sees "frozen prices, ticking countdown" because every fetch returns
  // HTTP 429 and our previous code silently swallowed it.
  //
  // Mechanic: on 429, we mark a `untilTs` cooldown in the future. Both
  // pollers (and their rescue mechanisms — watchdog, rAF heartbeat,
  // visibility / focus listeners) check `_upstoxIsThrottled()` first
  // and short-circuit so we don't make the rate-limit worse by piling
  // on retries. Back-off is exponential: 5s → 10s → 20s → 40s → 60s
  // → 90s. After 2 consecutive successes the gate fully clears and we
  // resume normal cadence.
  if (!window._upstoxRateLimit) {
    window._upstoxRateLimit = {
      count: 0,           // consecutive 429s seen (clamped to backoffSec.length)
      untilTs: 0,         // wall-clock ms before which no poller should hit Upstox
      consecutiveOk: 0    // successful polls in a row — need 2 to fully reset
    };
  }
  var _UPSTOX_BACKOFF_SEC = [5, 10, 20, 40, 60, 90];

  window._upstoxIsThrottled = function () {
    return Date.now() < (window._upstoxRateLimit.untilTs || 0);
  };

  // Public API — both pollers call this when they see a 429.
  // Returns the cooldown duration in seconds (so callers can log it).
  //
  // IDEMPOTENT inside a single cooldown window: if 3 concurrent
  // in-flight fetches all see a 429 at the same time and each
  // calls this helper, only the FIRST one extends the backoff.
  // The other two just learn the current cooldown and return.
  // Without this guard, the backoff index ratchets to maxBackoff
  // immediately on the first concurrent burst (5s → 10s → 20s
  // → ... → 90s within a single batch), turning a transient
  // limit into a multi-minute death spiral. Discovered May 2026
  // after swing-scan batches of 3 concurrent fetches all bumped
  // the cooldown into the 60-90s range on every retry. Source:
  // user-reported "stuck or slow" scan stuck at 13/100.
  window._upstoxNote429 = function (source) {
    var rl = window._upstoxRateLimit;
    if (Date.now() < rl.untilTs) {
      // Already in a cooldown — don't double-count.
      return Math.ceil((rl.untilTs - Date.now()) / 1000);
    }
    rl.count = Math.min(rl.count + 1, _UPSTOX_BACKOFF_SEC.length);
    rl.consecutiveOk = 0;
    var sec = _UPSTOX_BACKOFF_SEC[rl.count - 1];
    rl.untilTs = Date.now() + sec * 1000;
    console.warn('[upstox] HTTP 429 from ' + (source || 'unknown')
      + ' — backing off ' + sec + 's (#' + rl.count + ')');
    // Surface to the chart status pill if the chart module has hooked
    // itself up. Optional — falls back to console-only when chart isn't
    // mounted (e.g. before initial chart render, or on the intraday tab).
    try {
      _emitStatus('throttled', 'RATE LIMITED \u00B7 ' + sec + 's');
      // Tick the badge countdown each second so the user sees the
      // remaining seconds shrink — feels much less broken than a
      // single static "RATE LIMITED 60s" that doesn't change.
      if (!window._upstoxThrottleTicker) {
        window._upstoxThrottleTicker = setInterval(function () {
          var rem = Math.ceil((window._upstoxRateLimit.untilTs - Date.now()) / 1000);
          if (rem > 0) {
            _emitStatus('throttled', 'RATE LIMITED \u00B7 ' + rem + 's');
          } else {
            // Pill clear is left to the next successful poll — if we
            // clear here and the next poll 429s immediately the pill
            // would flicker green/amber. Just stop the ticker.
            clearInterval(window._upstoxThrottleTicker);
            window._upstoxThrottleTicker = null;
          }
        }, 1000);
      }
    } catch (_) { /* status hook not available yet — non-fatal */ }
    return sec;
  };

  // Both pollers call this when fetch returns 2xx with valid data.
  // We require TWO consecutive successes before fully clearing the
  // gate; one-off successes on borderline rate limits otherwise
  // flap the pill green/amber rapidly.
  window._upstoxNoteOk = function () {
    var rl = window._upstoxRateLimit;
    if (rl.count === 0) return;
    rl.consecutiveOk = (rl.consecutiveOk || 0) + 1;
    if (rl.consecutiveOk >= 2) {
      console.log('[upstox] rate-limit cleared after ' + rl.consecutiveOk + ' successes');
      rl.count = 0;
      rl.untilTs = 0;
      rl.consecutiveOk = 0;
      if (window._upstoxThrottleTicker) {
        clearInterval(window._upstoxThrottleTicker);
        window._upstoxThrottleTicker = null;
      }
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  // GLOBAL UPSTOX REQUEST BUDGET
  // ═══════════════════════════════════════════════════════════════════
  // Single token bucket shared by ALL modules (chart, paper-trade,
  // swing scan, fib scan, intraday analyzer, option chain). Prevents
  // combined throughput from exceeding Upstox's per-second / per-30-min
  // rate limits even when multiple modules poll simultaneously.
  //
  // Design:
  //   tryAcquire()  — non-blocking. Returns true if a token was taken,
  //                   false if budget exhausted. Pollers use this: if
  //                   false they skip this tick (next tick retries in
  //                   1-2s — no data loss, just a brief pause).
  //   acquire()     — async, blocks until a token is available. Scans
  //                   use this so they pace themselves but never drop
  //                   a stock.
  //
  // Rate: 10 tokens/sec sustained, burst cap 6, AND a hard 480-req
  // rolling-minute ceiling.
  //   - Upstox documented limits (Other Standard APIs incl. historical
  //     candles): 50 req/s, 500 req/min, 2000 req/30min. Exceeding ANY
  //     of these returns HTTP 429 (or 400 w/ UDAPI100011 rate-limit body).
  //   - The per-SECOND pace (10/s) is well under the 50/s cap, but 10/s
  //     SUSTAINED = 600/min, which BLOWS the 500/min cap after ~50s of a
  //     bulk scan. That was the real cause of mid-scan "not enough candles"
  //     failures: the minute budget tripped, every subsequent fetch 429'd,
  //     and the swing scanner mis-reported the empty result as missing data.
  //   - MINUTE_CAP = 480 keeps a 4% safety margin under 500/min and also
  //     leaves a little room for the handful of Upstox calls that bypass
  //     this bucket (some quote fan-outs). A sliding 60s window (not a
  //     fixed reset) means we never burst-then-stall at minute boundaries.
  //   - Burst 6 matches Chrome's per-host HTTP/1.1 connection cap.
  window._upstoxBucket = (function () {
    var RATE = 10;
    var CAP = 6;
    var MINUTE_CAP = 480;     // < Upstox's 500/min historical limit
    var tokens = CAP;
    var last = Date.now();
    var grants = [];          // wall-clock ms of grants in the last 60s
    function refill() {
      var now = Date.now();
      tokens = Math.min(CAP, tokens + (now - last) / 1000 * RATE);
      last = now;
    }
    // ms we must wait before the rolling-minute budget frees a slot
    // (0 = budget available now).
    function minuteWaitMs() {
      var now = Date.now();
      var cutoff = now - 60000;
      while (grants.length && grants[0] <= cutoff) grants.shift();
      if (grants.length < MINUTE_CAP) return 0;
      return Math.max(0, grants[0] + 60000 - now) + 20;
    }
    return {
      tryAcquire: function () {
        if (minuteWaitMs() > 0) return false;
        refill();
        if (tokens >= 1) { tokens -= 1; grants.push(Date.now()); return true; }
        return false;
      },
      acquire: async function () {
        while (true) {
          var mw = minuteWaitMs();
          if (mw > 0) { await new Promise(function (r) { setTimeout(r, mw); }); continue; }
          refill();
          if (tokens >= 1) { tokens -= 1; grants.push(Date.now()); return; }
          var waitMs = Math.ceil((1 - tokens) / RATE * 1000);
          await new Promise(function (r) { setTimeout(r, waitMs + 20); });
        }
      }
    };
  })();
})();
