// Regression guards for the swing trade-plan geometry + verdict inputs.
//
// These replace the two throwaway /tmp/*.js probes written while fixing the
// 2026-06-05 issues. They run the SHIPPED closure-private functions (via the
// __SWING_TEST__ hook in lib.mjs — zero reimplementation, zero drift) over
// REAL harvested candles and assert behavioural INVARIANTS, not brittle
// value snapshots. An invariant guard keeps passing as the engine is tuned,
// yet still fails loudly the moment a specific fix is regressed.
//
// What it protects (each maps to a real bug we shipped a fix for):
//   1. TARGET-FLOOR (the _swStandardRR fix): a long's first target must clear
//      the ENTRY ZONE TOP (golden-pocket 61.8% edge / demand-zone top), never
//      sit inside the buy zone. Regressing the `t1 > targetFloor` guard would
//      resurrect the degenerate "T1 inside the pocket, R:R ~0" plans.
//   2. PLAN SANITY: every non-null plan has sl < entry < t1 and a finite,
//      positive reward:risk — a plan that fails this should return null
//      (fail-safe), never reach the card.
//   3. VERDICT-INPUT PURITY: swComputeVerdictInputs (the SINGLE producer the
//      scan list AND the per-stock card both call) must be a pure function of
//      (raw, tf, mode) — calling it twice on the same candles yields identical
//      fibClass / zoiRising / gate / verdict. This is what makes "one source of
//      truth" real: if it ever depended on hidden mutable state, the scan and
//      the card could silently disagree.
//   4. FIBCLASS ENUM: fibClass is always one of the known ladder buckets.
//
// Usage:  node scripts/backtest/guards.mjs           (subset, fast — CI gate)
//         node scripts/backtest/guards.mjs --full    (whole universe)
//         node scripts/backtest/guards.mjs --stocks=40 --step=8
// Exit code 0 = all guards held; 1 = at least one invariant was violated.

import {
  loadSwingExports, sortAsc, candleMs, readHarvest, loadUniverse,
} from './lib.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

const FULL = has('full');
const MAX_STOCKS = FULL ? Infinity : +arg('stocks', '12');
const STEP = +arg('step', '20');          // evaluate every Nth daily cursor
const WIN_D_MS = 365 * 2 * 86400000;      // 2-year daily window (mirrors live)
const MIN_BARS = 60;                       // need enough history for pivots/fib
const MODES = ['FIB', 'ZOI', 'FIB_ZOI'];
// The purity double-call runs the heavy analyzeTf twice; purity is a
// structural property, so sampling 1-in-N windows proves it without doubling
// the whole run's cost. The cheap enum/shape + geometry guards run on ALL.
const PURITY_SAMPLE = FULL ? 1 : 8;
const FIBCLASS_ENUM = new Set([
  'NONE',
  'IN_POCKET_RISING', 'IN_POCKET_FALLING',
  'BELOW_POCKET_RISING', 'BELOW_POCKET_FALLING',
  'AT_SWING_LOW_RISING', 'AT_SWING_LOW_FALLING',
  'AT_SWING_HIGH',
  'RECOVERED_ABOVE_POCKET', 'SHALLOW_ABOVE_POCKET',
  'NEAR_ABOVE_POCKET_RISING', 'NEAR_ABOVE_POCKET_FALLING',
  'FAR_ABOVE_POCKET',
]);

// ── failure accumulator ──────────────────────────────────────────────
const failures = [];
let checks = 0;
let purityCounter = 0;
function check(cond, label, detail) {
  checks++;
  if (!cond) failures.push(label + (detail ? '  — ' + detail : ''));
}

// Replicate swBuildSetupPlan's ctx assembly EXACTLY (swing-analyzer.js
// ~10933-10954): pick the nearest DEMAND zone whose top sits at/just below
// price (≤ px·1.02), closest to price. Anything else would test a ctx the
// live app never produces.
function activeDemandZone(zones, px) {
  let dz = null, dDist = Infinity;
  if (zones && zones.length) {
    for (const z of zones) {
      if (z.type !== 'DEMAND') continue;
      const top = Math.max(z.proximal, z.distal);
      if (top <= px * 1.02) {
        const dd = Math.abs(px - top);
        if (dd < dDist) { dDist = dd; dz = z; }
      }
    }
  }
  return dz;
}

// Stable JSON of the verdict-input fields a consumer actually reads, so the
// purity check ignores object identity and only compares VALUES.
function verdictFingerprint(vi) {
  if (!vi) return 'null';
  return JSON.stringify({
    fibClass: vi.fibClass,
    zoiRising: vi.zoiRising,
    retPct: Number.isFinite(vi.retPct) ? +vi.retPct.toFixed(6) : vi.retPct,
    hasFib: vi.hasFib,
    hasZoi: vi.hasZoi,
    gate: vi.gate,
    vr: vi.vr,
  });
}

function evalWindow(exp, sym, rawNewestFirst) {
  const px = +rawNewestFirst[0][4];
  if (!Number.isFinite(px) || px <= 0) return;

  for (const mode of MODES) {
    const doFib = mode === 'FIB' || mode === 'FIB_ZOI';
    const doZoi = mode === 'ZOI' || mode === 'FIB_ZOI';
    const fib = doFib ? exp.computeFibZone(rawNewestFirst) : null;
    const zones = doZoi ? exp.detectZones(rawNewestFirst) : null;
    const demandZone = doZoi ? activeDemandZone(zones, px) : null;

    // ── Guard group 3 + 4: verdict-input shape + enum (every window) ──
    const vi1 = exp.swComputeVerdictInputs(rawNewestFirst, '1d', mode, { regime: null });
    check(vi1 != null, 'verdict-inputs returned null', `${sym} ${mode}`);
    if (vi1) {
      check(FIBCLASS_ENUM.has(vi1.fibClass), 'fibClass not in enum',
        `${sym} ${mode} got "${vi1.fibClass}"`);
      check(typeof vi1.zoiRising === 'boolean', 'zoiRising not boolean',
        `${sym} ${mode}`);
      check(vi1.gate && typeof vi1.gate === 'object', 'gate missing/not object',
        `${sym} ${mode}`);
      // PURITY (sampled — the double-call is the run's heaviest op): the SINGLE
      // producer the scan list and the card share must be a pure function of
      // (raw, tf, mode), or the two could silently disagree.
      if ((purityCounter++ % PURITY_SAMPLE) === 0) {
        const vi2 = exp.swComputeVerdictInputs(rawNewestFirst, '1d', mode, { regime: null });
        check(verdictFingerprint(vi1) === verdictFingerprint(vi2),
          'verdict-inputs NOT pure (two calls differ)', `${sym} ${mode}`);
      }
    }

    // ── Guard group 1 + 2: plan geometry invariants ──
    // Comparisons are STRICT (>) to mirror _swStandardRR's OWN gates exactly:
    // it only emits a plan when sl < entry, t1 > entry, t1 > targetFloor and
    // reward > 0. Re-asserting the same strict contract here means the guard
    // can ONLY fail if a future edit breaks one of those gates (e.g. drops the
    // target-floor check) — never on a benign float-boundary plan the live
    // code legitimately emits.
    const plan = exp._swStandardRR(rawNewestFirst, px, { mode, fib, zones, demandZone });
    if (!plan) continue;            // null = "no setup" — valid, nothing to check

    const { entry, sl, t1, rr } = plan;
    check(sl < entry, 'SL not below entry', `${sym} ${mode} sl=${sl} entry=${entry}`);
    check(t1 > entry, 'T1 not above entry', `${sym} ${mode} t1=${t1} entry=${entry}`);
    check(Number.isFinite(rr) && rr > 0, 'R:R not finite/positive',
      `${sym} ${mode} rr=${rr}`);

    // Target floor = entry-zone top (the 2026-06-05 fix). Mirror the live
    // computation: max(currentPx, fib618, demand-zone top).
    let floor = px;
    if (fib && Number.isFinite(fib.fib618)) floor = Math.max(floor, fib.fib618);
    if (demandZone) {
      const dTop = Math.max(demandZone.proximal, demandZone.distal);
      if (Number.isFinite(dTop)) floor = Math.max(floor, dTop);
    }
    check(t1 > floor, 'T1 sits inside the buy zone (target-floor regressed)',
      `${sym} ${mode} t1=${t1.toFixed(2)} floor=${floor.toFixed(2)}`);
  }
}

function main() {
  const exp = loadSwingExports();
  for (const fn of ['computeFibZone', 'detectZones', '_swStandardRR', 'swComputeVerdictInputs']) {
    if (typeof exp[fn] !== 'function') {
      console.error(`✗ swing-analyzer.js did not export ${fn} — is the __SWING_TEST__ hook intact?`);
      process.exit(1);
    }
  }

  const all = loadUniverse(true).stocks;
  if (!all.length) {
    console.error('✗ No backtest universe — run pick-universe.mjs → harvest.mjs first.');
    process.exit(1);
  }
  const stocks = all.slice(0, MAX_STOCKS);

  let windows = 0, stocksUsed = 0;
  for (const s of stocks) {
    const dailyAsc = sortAsc(readHarvest(s.isin, '1d') || []);
    if (dailyAsc.length < MIN_BARS) continue;
    stocksUsed++;
    // Slice the ascending series at stepped endpoints (no lookahead needed —
    // we assert math invariants, not returns), cap to the live 2y window, then
    // reverse to NEWEST-FIRST exactly as the live engine reads candles.
    for (let end = MIN_BARS; end <= dailyAsc.length; end += STEP) {
      const asOfMs = candleMs(dailyAsc[end - 1]);
      const cut = asOfMs - WIN_D_MS;
      let start = 0;
      while (start < end && candleMs(dailyAsc[start]) < cut) start++;
      const win = dailyAsc.slice(start, end);
      if (win.length < MIN_BARS) continue;
      evalWindow(exp, s.sym, win.slice().reverse());
      windows++;
    }
  }

  const L = '─'.repeat(70);
  console.log(L);
  console.log(`swing geometry + verdict-input guards`);
  console.log(`  stocks: ${stocksUsed}/${stocks.length}  ·  windows: ${windows}  ·  assertions: ${checks}`);
  console.log(L);
  if (failures.length) {
    const show = failures.slice(0, 25);
    console.error(`✗ ${failures.length} invariant violation(s):`);
    for (const f of show) console.error('   • ' + f);
    if (failures.length > show.length) console.error(`   … and ${failures.length - show.length} more`);
    console.log(L);
    process.exit(1);
  }
  console.log(`✓ all ${checks} assertions held across ${windows} real-candle windows`);
  console.log(L);
}

main();
