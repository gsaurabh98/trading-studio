// ─────────────────────────────────────────────────────────────────────────
// Days-to-target CALIBRATION TABLE builder (2026-06-05)
//
// Produces data/days-to-target-table.json — an empirical lookup that the swing
// SETUP / STRUCTURE cards consult to answer "how long to T1/T2, and what are
// the odds it gets there?" — keyed by  TF × market-regime × mode × R-multiple.
//
// WHY a table instead of the (ATR × 0.17) formula:
//   • The formula's MEDIAN is well-calibrated but ADX-at-entry carried no
//     signal and a single constant ignores the one thing that clearly moves
//     hold-time + hit-odds: the MARKET REGIME (upside targets resolve faster
//     and hit more often in a BULL tape).
//   • A point estimate hides that ~half of setups never reach the target. The
//     honest deliverable is REACH-PROBABILITY + conditional median time.
//
// Faithfulness (real money — no shortcuts):
//   • Entries are the EXACT live scan verdict (scanVerdictFromCandles, vm-
//     loaded) → the reported reach-rate is the engine's TRUE edge, not a proxy.
//   • Entry + stop come from the verdict's own riskContext (rrEntry/rrSl) —
//     the SAME _swStandardRR geometry the SETUP card's levels use.
//   • Point-in-time, no lookahead: history is sliced to the bar's close, the
//     still-forming bar dropped, the window capped to the live fetch span,
//     regime recomputed from sliced Nifty daily.
//   • Bars-to-target are counted in the SIGNAL TF's OWN bars (daily signal →
//     trading days; weekly → weeks) so the unit matches what the card prints.
//   • A stop hit before the target = NOT reached (the trade is closed). A bar
//     that touches both stop and target counts as a stop (conservative).
//
// Usage:
//   node scripts/backtest/calibrate-days-to-target.mjs                 (full)
//   node scripts/backtest/calibrate-days-to-target.mjs --stocks=25     (fast)
//   node scripts/backtest/calibrate-days-to-target.mjs --stride=5
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import {
  loadSwingExports, sortAsc, sliceAsOf, candleMs,
  buildRegimeLookup, readHarvest, PERIOD_MS, loadUniverse, DATA_DIR,
} from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

const STOCK_LIMIT = +arg('stocks', '0') || Infinity;   // 0 = all
const STRIDE = { '1d': +arg('stride', '3'), '1w': 1 };  // cursor stride per TF
const WIN_FROM = arg('from', '2019-01-01');
const WIN_TO = arg('to', '2025-12-31');

const MODES = ['FIB', 'ZOI', 'FIB_ZOI'];
const TFS = ['1d', '1w'];
const NIFTY_ID = 'NIFTY50';

// R-multiple knots the table is sampled at. Card T1 is typically ~1.5R,
// T2 ~2.5–5R; the 0.5R knot anchors the low end for tight setups.
const R_KNOTS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5];
// Forward horizon to wait for a touch, in the SIGNAL TF's own bars.
const CAP_BARS = { '1d': 60, '1w': 26 };  // ≈ 3 months / 6 months
const FILL_WINDOW = { '1d': 3, '1w': 2 }; // limit-entry validity, signal-TF bars
// Live fetch windows (must mirror swing-analyzer TF_SPECS: daily 2y, weekly 3y).
const SCAN_WIN_MS = { '1d': 365 * 2 * 86400000, '1w': 365 * 3 * 86400000 };
const MIN_CELL_N = 40;   // below this a cell is too thin to publish

const fromMs = new Date(WIN_FROM + 'T00:00:00Z').getTime();
const toMs = new Date(WIN_TO + 'T23:59:59Z').getTime();

const capWin = (asc, asOfMs, winMs) => {
  const cut = asOfMs - winMs;
  let i = 0; while (i < asc.length && candleMs(asc[i]) < cut) i++;
  return i ? asc.slice(i) : asc;
};

const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pctl = (a, p) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))]; };

/**
 * Walk the signal-TF future from a limit fill at `entry`, recording the first
 * bar (1-based, in signal-TF bars) at which each R-knot target is touched.
 * A stop hit ends the trade (knots not yet reached → unreached). Returns null
 * if the limit never filled within the fill window.
 */
function firstTouchByKnot(future, entry, sl, capBars) {
  const risk = entry - sl;
  if (!(risk > 0)) return null;
  // Limit fill: first bar whose low ≤ entry.
  let fi = -1;
  for (let i = 0; i < Math.min(FILL_WINDOW[future.tf] || 3, future.bars.length); i++) {
    if (+future.bars[i][3] <= entry) { fi = i; break; }
  }
  if (fi < 0) return null;

  const targets = R_KNOTS.map((r) => entry + r * risk);
  const touchedAt = new Array(R_KNOTS.length).fill(null);
  let held = 0;
  for (let i = fi; i < future.bars.length && held < capBars; i++) {
    const b = future.bars[i];
    held++;
    if (+b[3] <= sl) break;                 // stop first (conservative) → trade closed
    const hi = +b[2];
    for (let k = 0; k < targets.length; k++) {
      if (touchedAt[k] == null && hi >= targets[k]) touchedAt[k] = held;
    }
  }
  return touchedAt;   // [bars|null] per knot; null = not reached before stop/cap
}

function emptyCell() {
  // per knot: { reached, total, bars: [] }
  return R_KNOTS.map(() => ({ reached: 0, total: 0, bars: [] }));
}

function main() {
  const exp = loadSwingExports();
  const { scanVerdictFromCandles } = exp;

  let stocks = loadUniverse(true).stocks;
  if (!stocks.length) {
    // Fall back to every harvested ISIN if the universe file is absent.
    stocks = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_1d.json'))
      .map((f) => ({ isin: f.replace('_1d.json', ''), sym: f.replace('_1d.json', '') }))
      .filter((s) => s.isin !== NIFTY_ID);
  }
  if (Number.isFinite(STOCK_LIMIT)) stocks = stocks.slice(0, STOCK_LIMIT);

  const niftyDaily = readHarvest(NIFTY_ID, '1d');
  if (!niftyDaily) throw new Error(`Missing ${NIFTY_ID}_1d.json for regime`);
  const regimeAsOf = buildRegimeLookup(sortAsc(niftyDaily));

  // accum[tf][regime][mode] = cell ; regimes include pooled 'ALL', modes 'ALL'
  const accum = {};
  const cellOf = (tf, regime, mode) => {
    accum[tf] = accum[tf] || {};
    accum[tf][regime] = accum[tf][regime] || {};
    if (!accum[tf][regime][mode]) accum[tf][regime][mode] = emptyCell();
    return accum[tf][regime][mode];
  };

  let buySignals = 0, eligible = 0;
  const t0 = Date.now();

  for (const tf of TFS) {
    for (const st of stocks) {
      const rawScan = readHarvest(st.isin, tf);
      if (!rawScan || rawScan.length < 30) continue;
      const scanAsc = sortAsc(rawScan);
      const stride = STRIDE[tf] || 1;
      const cap = CAP_BARS[tf];

      for (let ci = 0; ci < scanAsc.length; ci += stride) {
        const cur = scanAsc[ci];
        const barStart = candleMs(cur);
        if (barStart < fromMs || barStart > toMs) continue;
        const asOfMs = barStart + PERIOD_MS[tf] - 1;     // this bar's close
        const slice = capWin(sliceAsOf(scanAsc, asOfMs, true, PERIOD_MS[tf]), asOfMs, SCAN_WIN_MS[tf]);
        if (slice.length < 30) continue;
        const newestFirst = slice.slice().reverse();      // engine reads raw[0]=latest
        const regime = regimeAsOf(asOfMs);
        const regimeKey = regime && regime.regime ? regime.regime : 'UNK';

        for (const mode of MODES) {
          let v;
          try { v = scanVerdictFromCandles(newestFirst, mode, regime, tf); } catch { continue; }
          if (!v || !v.ok || v.action !== 'BUY') continue;
          const rc = v.riskContext || {};
          const entry = rc.rrEntry, sl = rc.rrSl;
          if (!(entry > 0) || !(sl > 0) || sl >= entry) continue;
          buySignals++;

          // Forward walk in the SIGNAL TF's own bars, strictly AFTER this close.
          const future = { tf, bars: scanAsc.filter((b) => candleMs(b) > asOfMs) };
          const touched = firstTouchByKnot(future, entry, sl, cap);
          if (!touched) continue;            // never filled → not a holdable trade
          eligible++;

          // Record into [regime, mode] and the pooled fallbacks.
          for (const rk of [regimeKey, 'ALL']) {
            for (const mk of [mode, 'ALL']) {
              const cell = cellOf(tf, rk, mk);
              for (let k = 0; k < R_KNOTS.length; k++) {
                cell[k].total++;
                if (touched[k] != null) { cell[k].reached++; cell[k].bars.push(touched[k]); }
              }
            }
          }
        }
      }
    }
  }

  buildAndWrite(accum, { buySignals, eligible, elapsedMs: Date.now() - t0 });
}

function summariseCell(cell) {
  return R_KNOTS.map((r, k) => {
    const c = cell[k];
    const reachRate = c.total ? c.reached / c.total : null;
    return {
      r,
      n: c.total,
      reached: c.reached,
      reach: reachRate != null ? +reachRate.toFixed(3) : null,
      p25: c.bars.length ? Math.round(pctl(c.bars, 0.25)) : null,
      p50: c.bars.length ? Math.round(median(c.bars)) : null,
      p75: c.bars.length ? Math.round(pctl(c.bars, 0.75)) : null,
    };
  });
}

function buildAndWrite(accum, stats) {
  // Build the shipped table: keep cells with enough samples; drop knots whose
  // reached-bars sample is too thin to median.
  const table = { tf: {} };
  for (const tf of Object.keys(accum)) {
    table.tf[tf] = {};
    for (const regime of Object.keys(accum[tf])) {
      table.tf[tf][regime] = {};
      for (const mode of Object.keys(accum[tf][regime])) {
        const knots = summariseCell(accum[tf][regime][mode])
          .filter((kn) => kn.n >= MIN_CELL_N && kn.p50 != null);
        if (knots.length >= 2) table.tf[tf][regime][mode] = { knots };
      }
    }
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      note: 'Empirical days-to-target + reach-probability by TF×regime×mode×R. '
        + 'Bars are in the SIGNAL TF own units. Built from real scanVerdictFromCandles BUYs, '
        + 'point-in-time, no lookahead. See scripts/backtest/calibrate-days-to-target.mjs.',
      rKnots: R_KNOTS, capBars: CAP_BARS, minCellN: MIN_CELL_N,
      window: [WIN_FROM, WIN_TO],
      buySignals: stats.buySignals, eligibleFills: stats.eligible,
    },
    table,
  };

  const outFile = path.join(DATA_DIR, 'days-to-target-table.json');
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));

  // Also drop a copy next to the app data so the live fetch finds it.
  const appFile = path.join(DATA_DIR, '..', 'days-to-target-table.json');
  fs.writeFileSync(appFile, JSON.stringify(out));

  report(accum, stats, outFile, appFile);
}

function report(accum, stats, outFile, appFile) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DAYS-TO-TARGET TABLE CALIBRATION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  BUY signals: ${stats.buySignals.toLocaleString()}  ·  eligible fills: ${stats.eligible.toLocaleString()}  ·  ${(stats.elapsedMs / 1000).toFixed(1)}s\n`);

  for (const tf of TFS) {
    if (!accum[tf]) continue;
    const unit = tf === '1d' ? 'days' : tf === '1w' ? 'weeks' : 'bars';
    console.log(`  ── ${tf}  (bars = ${unit}) ──`);
    for (const regime of ['BULL', 'NEUTRAL', 'BEAR', 'ALL']) {
      const cell = accum[tf][regime] && accum[tf][regime]['ALL'];
      if (!cell) continue;
      const s = summariseCell(cell);
      console.log(`    ${regime.padEnd(8)}  (mode=ALL)`);
      console.log(`      R     n       reach%   p25   p50   p75`);
      for (const kn of s) {
        if (kn.n < 1) continue;
        console.log(
          `      ${String(kn.r).padEnd(5)} ${String(kn.n).padEnd(7)} ` +
          `${kn.reach != null ? (100 * kn.reach).toFixed(0).padStart(5) : '   - '}    ` +
          `${kn.p25 != null ? String(kn.p25).padStart(3) : '  -'}   ` +
          `${kn.p50 != null ? String(kn.p50).padStart(3) : '  -'}   ` +
          `${kn.p75 != null ? String(kn.p75).padStart(3) : '  -'}`
        );
      }
    }
    console.log('');
  }
  console.log(`  table written → ${path.relative(process.cwd(), outFile)}`);
  console.log(`               + ${path.relative(process.cwd(), appFile)} (minified, app-loaded)`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main();
