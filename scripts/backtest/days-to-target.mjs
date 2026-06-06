// ─────────────────────────────────────────────────────────────────────────
// Days-to-target calibration backtest (2026-06-05)
//
// Validates the ATR × ADX-scaled-efficiency estimator that the swing
// SETUP / STRUCTURE plans now show next to T1 / T2:
//
//     predicted bars-to-target = (Target − Entry) / (ATR × efficiency)
//     efficiency = f(ADX):  ADX≥25→0.65 · 18–25→0.50 · <18→0.35 · null→0.50
//
// We DON'T reimplement the math — we load the SHIPPED helpers
// (_swDaysToTarget / _swEfficiencyFromAdx) + the SHIPPED atr()/adx() out of
// scripts/swing-analyzer.js via the vm sandbox in lib.mjs, so this measures
// exactly what the app will display (zero drift, per the trading rules).
//
// Method (point-in-time, NO lookahead):
//   • For each stock's daily series (oldest→newest), step through history.
//   • At each entry bar i: ATR(14) and ADX(14) are computed ONLY from bars
//     ≤ i (the same thing the live engine sees at that close).
//   • Place a basket of upside targets at m×ATR above entry (m = the typical
//     swing-target distances: ~near T1 → far T2).
//   • Predict bars-to-target with the shipped estimator.
//   • Walk FORWARD up to CAP bars; the target is "hit" the first bar whose
//     HIGH ≥ target (a limit-sell fills on a touch). Record actual bars.
//   • Only HIT cases are scored (a censored/never-hit target tells us nothing
//     about hold-time) — this matches the question "if the trade works, how
//     long to T1/T2?".
//
// Calibration outputs:
//   • coverage  — % of hits whose actual bars fell inside the shown ~lo–hi
//                 range (target ≈ 70–80%; the range is mid ±25%).
//   • bias      — median(actual / predicted-mid); 1.00 = perfectly centred.
//   • implied efficiency per ADX bucket = distance/(ATR×actualBars) = m/bars.
//     If the median implied eff ≠ the hard-coded eff, the suggested value is
//     printed so the three anchors can be recalibrated with evidence.
//
// Sampling mode (the estimate is only ever DISPLAYED on a real BUY setup, so
// the relevant calibration conditions on a setup-like entry, not every bar):
//   default     → SETUP proxy: pullback-in-uptrend (close > SMA50 AND price
//                 within ~1 ATR of the prior-10-bar low) — mirrors the app's
//                 "buy the dip into support inside an uptrend" BUY.
//   --all       → unconditional (every Nth bar) — a pessimistic lower bound.
//
// Run:  node scripts/backtest/days-to-target.mjs          (setup-conditioned)
//       node scripts/backtest/days-to-target.mjs --all    (unconditional)
// ─────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { loadSwingExports, sortAsc, readHarvest, DATA_DIR } from './lib.mjs';

// ── Tunables ───────────────────────────────────────────────────────────────
const WARMUP = 40;          // bars of history before the first entry (ADX needs ≥29)
const STEP = 5;             // sample every Nth bar (decorrelate overlapping windows)
const CAP = 80;             // forward bars to wait for a hit (~16 trading weeks)
const TARGET_MULTS = [2, 3, 4, 6, 8, 10]; // target distance in ATR units (near→far)
const ADX_OFFSET = 27;      // adx()[k] ↔ bar index (k + 27) — verified at runtime

// ── Helpers ──────────────────────────────────────────────────────────────
const num = (v) => +v;
const median = (arr) => {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN);

function adxBucket(adxVal) {
  if (adxVal == null || !isFinite(adxVal)) return 'NULL';
  if (adxVal >= 25) return 'STRONG';
  if (adxVal >= 18) return 'NORMAL';
  return 'CHOPPY';
}

function listIsins() {
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('_1d.json'))
    .map((f) => f.replace('_1d.json', ''));
}

const SETUP_ONLY = !process.argv.includes('--all');

// Cheap SETUP proxy for "the app would consider a BUY here": an uptrend
// pullback into support — close above SMA50 AND price has just dipped to
// within ~1 ATR of the prior-10-bar swing low. Not the full verdict engine,
// but it isolates the entry CONTEXT the displayed estimate actually applies
// to (vs a random mid-trend bar), which is what we must calibrate against.
function isSetupEntry(close, low, sma50, atrV, i) {
  if (!(sma50 > 0) || close[i] <= sma50) return false;       // must be an uptrend
  let lo10 = Infinity;
  for (let k = Math.max(0, i - 10); k < i; k++) lo10 = Math.min(lo10, low[k]);
  if (!isFinite(lo10)) return false;
  return (close[i] - lo10) <= 1.0 * atrV;                     // pulled back into support
}

function sma(closes, i, period) {
  if (i < period - 1) return NaN;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) s += closes[k];
  return s / period;
}

// ── Main ───────────────────────────────────────────────────────────────────
function main() {
  const exp = loadSwingExports();
  const { atr, adx, _swDaysToTarget, _swEfficiencyFromAdx } = exp;
  if (typeof _swDaysToTarget !== 'function') {
    throw new Error('_swDaysToTarget not exported — is the test hook updated?');
  }

  const isins = listIsins();
  console.log(`Loaded shipped estimator + ${isins.length} daily series from ${DATA_DIR}`);
  console.log(`Sampling mode: ${SETUP_ONLY ? 'SETUP-conditioned (pullback-in-uptrend)' : 'UNCONDITIONAL (every Nth bar)'}\n`);

  const samples = [];          // { m, distance, atrV, adxV, bucket, predLo, predHi, predMid, actualBars }
  let entriesTried = 0;
  let offsetVerified = false;

  for (const isin of isins) {
    const raw = readHarvest(isin, '1d');
    if (!raw || raw.length < WARMUP + CAP + 5) continue;
    const asc = sortAsc(raw);                 // oldest→newest
    const n = asc.length;
    const high = asc.map((r) => num(r[2]));
    const low = asc.map((r) => num(r[3]));
    const close = asc.map((r) => num(r[4]));

    const atrFull = atr(asc, 14);             // bar-index aligned
    const adxFull = adx(asc, 14);             // compacted; bar i → adxFull[i-27]

    const adxAsOf = (i) => {
      const k = i - ADX_OFFSET;
      return (k >= 0 && k < adxFull.length && isFinite(adxFull[k])) ? adxFull[k] : null;
    };

    // Verify the ADX offset ONCE against a from-scratch slice (no drift risk).
    if (!offsetVerified && n > WARMUP + 20) {
      const probe = WARMUP + 10;
      const sliceAdx = adx(asc.slice(0, probe + 1), 14);
      const fromSlice = sliceAdx.length ? sliceAdx[sliceAdx.length - 1] : null;
      const fromFull = adxAsOf(probe);
      if (fromSlice == null || fromFull == null || Math.abs(fromSlice - fromFull) > 1e-6) {
        throw new Error(`ADX offset mismatch at bar ${probe}: slice=${fromSlice} full=${fromFull}`);
      }
      offsetVerified = true;
    }

    for (let i = WARMUP; i < n - 1; i += STEP) {
      const atrV = atrFull[i];
      if (!(atrV > 0)) continue;
      const entry = close[i];
      if (!(entry > 0)) continue;
      if (SETUP_ONLY && !isSetupEntry(close, low, sma(close, i, 50), atrV, i)) continue;
      const adxV = adxAsOf(i);
      const lastJ = Math.min(i + CAP, n - 1);

      for (const m of TARGET_MULTS) {
        const distance = m * atrV;
        const target = entry + distance;
        const pred = _swDaysToTarget(distance, atrV, adxV, '1d');
        if (!pred) continue;
        entriesTried++;

        let actualBars = -1;
        for (let j = i + 1; j <= lastJ; j++) {
          if (high[j] >= target) { actualBars = j - i; break; }
        }
        if (actualBars < 0) continue;          // censored — never reached in window

        samples.push({
          m, distance, atrV, adxV, bucket: adxBucket(adxV),
          predLo: pred.lo, predHi: pred.hi, predMid: pred.mid, eff: pred.eff,
          actualBars,
        });
      }
    }
  }

  report(samples, entriesTried, _swEfficiencyFromAdx);
}

function report(samples, entriesTried, effFn) {
  const hit = samples.length;
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  DAYS-TO-TARGET CALIBRATION');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  target attempts : ${entriesTried.toLocaleString()}`);
  console.log(`  hit within ${CAP} bars : ${hit.toLocaleString()} (${(100 * hit / entriesTried).toFixed(1)}% reach-rate)\n`);
  if (!hit) { console.log('  no hits — nothing to calibrate'); return; }

  // Overall coverage + bias.
  const inRange = samples.filter((s) => s.actualBars >= s.predLo && s.actualBars <= s.predHi).length;
  const ratios = samples.map((s) => s.actualBars / s.predMid);
  console.log('  OVERALL');
  console.log(`    range coverage (actual ∈ ~lo–hi) : ${(100 * inRange / hit).toFixed(1)}%   (target ≈ 70–80%)`);
  console.log(`    bias median(actual / pred-mid)   : ${median(ratios).toFixed(2)}   (1.00 = centred)`);
  console.log(`    bias mean(actual / pred-mid)     : ${mean(ratios).toFixed(2)}\n`);

  // Per-ADX-bucket implied efficiency (the core calibration).
  console.log('  EFFICIENCY BY ADX BUCKET   (implied eff = distance / (ATR × actual bars))');
  console.log('  bucket   n        chosen-eff   median-implied   suggested');
  console.log('  ──────────────────────────────────────────────────────────');
  const sampleAdxForBucket = { STRONG: 30, NORMAL: 21, CHOPPY: 14, NULL: null };
  for (const b of ['STRONG', 'NORMAL', 'CHOPPY', 'NULL']) {
    const rows = samples.filter((s) => s.bucket === b);
    if (!rows.length) continue;
    const chosen = effFn(sampleAdxForBucket[b]);
    const implied = rows.map((s) => s.distance / (s.atrV * s.actualBars)); // = m / actualBars
    const medImplied = median(implied);
    console.log(
      `  ${b.padEnd(8)} ${String(rows.length).padEnd(8)} ` +
      `${chosen.toFixed(2).padEnd(12)} ${medImplied.toFixed(3).padEnd(16)} ${medImplied.toFixed(2)}`
    );
  }
  console.log('');

  // ── Recalibration probe: at a candidate single efficiency, where do the
  // actual outcomes fall vs the predicted MID? Picks the honest display band.
  const CAND_EFF = 0.17;   // shipped efficiency (see swing-analyzer _SW_DTT_EFFICIENCY)
  const pctl = (arr, p) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
  };
  const ratiosCal = samples.map((s) => {
    const predMid = s.distance / (s.atrV * CAND_EFF); // bars
    return s.actualBars / predMid;
  });
  console.log(`  RECALIBRATION PROBE  (single efficiency = ${CAND_EFF})`);
  console.log('    actual / predicted-mid percentiles:');
  console.log(`      p10=${pctl(ratiosCal, 0.10).toFixed(2)}  p25=${pctl(ratiosCal, 0.25).toFixed(2)}  ` +
    `p50=${pctl(ratiosCal, 0.50).toFixed(2)}  p75=${pctl(ratiosCal, 0.75).toFixed(2)}  p90=${pctl(ratiosCal, 0.90).toFixed(2)}`);
  for (const [flo, fhi] of [[0.75, 1.25], [0.6, 1.6], [0.5, 2.0], [0.5, 2.5]]) {
    const cov = ratiosCal.filter((r) => r >= flo && r <= fhi).length / ratiosCal.length;
    console.log(`      band ×[${flo}, ${fhi}] covers ${(100 * cov).toFixed(1)}%`);
  }
  console.log('');

  // Per target-distance behaviour.
  console.log('  BY TARGET DISTANCE');
  console.log('  m×ATR    n        median-actual   median-pred-mid   median-ratio');
  console.log('  ──────────────────────────────────────────────────────────────');
  for (const m of TARGET_MULTS) {
    const rows = samples.filter((s) => s.m === m);
    if (!rows.length) continue;
    const a = median(rows.map((s) => s.actualBars));
    const p = median(rows.map((s) => s.predMid));
    const r = median(rows.map((s) => s.actualBars / s.predMid));
    console.log(
      `  ${(m + '×').padEnd(8)} ${String(rows.length).padEnd(8)} ` +
      `${a.toFixed(1).padEnd(15)} ${p.toFixed(1).padEnd(17)} ${r.toFixed(2)}`
    );
  }
  console.log('');

  // Persist a machine-readable summary for the notebook / future runs.
  const summary = {
    generatedAt: new Date().toISOString(),
    params: { WARMUP, STEP, CAP, TARGET_MULTS, ADX_OFFSET },
    entriesTried, hit,
    reachRatePct: +(100 * hit / entriesTried).toFixed(2),
    rangeCoveragePct: +(100 * inRange / hit).toFixed(2),
    biasMedian: +median(ratios).toFixed(3),
    byBucket: ['STRONG', 'NORMAL', 'CHOPPY', 'NULL'].reduce((acc, b) => {
      const rows = samples.filter((s) => s.bucket === b);
      if (rows.length) {
        acc[b] = {
          n: rows.length,
          chosenEff: effFn(sampleAdxForBucket[b]),
          medianImpliedEff: +median(rows.map((s) => s.distance / (s.atrV * s.actualBars))).toFixed(3),
        };
      }
      return acc;
    }, {}),
  };
  const outFile = path.join(DATA_DIR, 'days-to-target-results.json');
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`  summary written → ${path.relative(process.cwd(), outFile)}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main();
