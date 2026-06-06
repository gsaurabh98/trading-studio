// Walk-forward backtest of the DEEP verdict engine (generatePlan) — the
// multi-timeframe trade-plan engine that fills the Entry / SL / T1 / T2 /
// Holding card in the single-stock chart view. This is the COMPLEMENT to
// run-scan.mjs (which tests the Fib/ZOI verdict-rules.json engine):
//
//   • run-scan.mjs → tests the VERDICT you read (BUY/WAIT/SKIP)
//   • run.mjs      → tests generatePlan's LEVELS (the entry/stop/target you'd
//                    actually place from the trade-plan card)
//
// Kept deliberately apples-to-apples with run-scan.mjs so the two engines can
// be compared directly:
//   • Window  : signals 2019 → 2025 (as-of dates) — all Nifty regimes
//   • Stocks  : data/backtest/universe-final.json (~127 liquidity-trimmed names,
//               stratified ~10/sector, fixed-seed pick — same set as run-scan)
//   • Sizing  : deploy ₹1 lakh/trade → shares = floor(1e5 / fill price)
//   • Trade   : on a generatePlan BUY, limit-buy at plan.entryHi, hold to the
//               plan's OWN t1 (target) or sl (stop), with the plan's OWN
//               holding-period time-stop. NO 2R override — we are testing the
//               plan's native geometry exactly as the chart card shows it.
//
// No-lookahead / no-repainting (mandatory — real capital depends on it):
//   • Each TF is sliced to bars confirmed at the as-of daily close; the
//     still-forming weekly/monthly bar is dropped.
//   • Grading walks DAILY bars strictly AFTER the signal bar.
//   • Regime is recomputed point-in-time from sliced Nifty daily history.
//   • Monthly is OPTIONAL (we harvest only daily+weekly) — generatePlan
//     degrades gracefully to "no monthly stage" exactly as the live app does
//     for a new listing / beyond the monthly window.
//
// Reuses the EXACT live engine via generatePlan (vm-loaded) — zero drift.
//
// Usage: node scripts/backtest/run.mjs [--from=2024-01-01] [--to=2026-01-31]
//        [--capital=100000]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSwingExports, sortAsc, sliceAsOf, candleMs,
  buildRegimeLookup, readHarvest, PERIOD_MS, loadUniverse,
} from './lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

const WIN_FROM = arg('from', '2019-01-01');
const WIN_TO = arg('to', '2025-12-31');
const CAPITAL = +arg('capital', '100000');
const TICK = 0.05;
const SLIPPAGE_FRAC = 0.0005;   // 0.05% adverse per side (proxy for costs)
const FILL_WINDOW_BARS = 3;     // limit-entry validity, in DAILY bars
const DEFAULT_HOLD = 15;        // fallback time-stop if plan.holding missing

const STOCKS = loadUniverse(true).stocks; // universe-final.json (liquidity-trimmed)
if (!STOCKS.length) {
  console.error('No universe-final.json — run pick-universe.mjs → harvest.mjs → liquidity-trim.mjs first.');
  process.exit(1);
}
const NIFTY_ID = 'NIFTY50';

const roundTick = (px) => Math.round(px / TICK) * TICK;
const round2 = (x) => Math.round(x * 100) / 100;
const fromMs = new Date(WIN_FROM + 'T00:00:00Z').getTime();
const toMs = new Date(WIN_TO + 'T23:59:59Z').getTime();

// Per-TF lookback windows MUST mirror the live app (TF_SPECS in
// swing-analyzer.js: daily 2y, weekly 3y, monthly 5y). generatePlan computes
// its plan on exactly this much history per TF; feeding the full 8-year harvest
// would shift swing/fib anchors AND run ~4× slower. capWin trims the ascending
// as-of slice to the window before the engine sees it.
const WIN_D_MS = 365 * 2 * 86400000;
const WIN_W_MS = 365 * 3 * 86400000;
const WIN_M_MS = 365 * 5 * 86400000;
const capWin = (asc, asOfMs, winMs) => {
  const cut = asOfMs - winMs;
  let i = 0; while (i < asc.length && candleMs(asc[i]) < cut) i++;
  return i ? asc.slice(i) : asc;
};

// Max favourable excursion (in R), ignoring the plan's target but respecting
// its stop + hold horizon — the honest "how far did it actually run while we
// were in it" measure that powers the target-reachability curve.
function mfeUntilStop(dailyFuture, fi, entryFillPx, sl, risk, holdMax) {
  let best = 0;
  for (let i = fi, held = 0; i < dailyFuture.length; i++, held++) {
    const b = dailyFuture[i];
    const fav = (+b[2] - entryFillPx) / risk;
    if (fav > best) best = fav;
    if (+b[3] <= sl) break;
    if (held + 1 >= holdMax) break;
  }
  return best;
}

// ── Grade one generatePlan BUY using its OWN levels ─────────────────────────
// `dailyFuture` = chronological daily bars strictly after the signal close.
function gradeBuy(plan, dailyFuture) {
  const entryLimit = (isFinite(plan.entryHi) && plan.entryHi > 0) ? plan.entryHi : plan.entry;
  const sl = plan.sl, t1 = plan.t1;
  const holdMax = (isFinite(plan.holding) && plan.holding > 0) ? plan.holding : DEFAULT_HOLD;
  if (!(entryLimit > 0) || !(sl > 0) || !(t1 > 0) || sl >= entryLimit || t1 <= entryLimit) {
    return { status: 'NO_PLAN' };
  }

  // 1) Limit fill within the next few daily sessions.
  let fi = -1, entryFillPx = NaN, entryMs = 0;
  for (let i = 0; i < Math.min(FILL_WINDOW_BARS, dailyFuture.length); i++) {
    const b = dailyFuture[i];
    if (+b[3] <= entryLimit) { // low touched the limit
      entryFillPx = roundTick(Math.min(+b[1], entryLimit)) * (1 + SLIPPAGE_FRAC);
      entryMs = candleMs(b);
      fi = i;
      break;
    }
  }
  if (fi < 0) return { status: 'NO_FILL' };

  const risk = entryFillPx - sl;
  if (!(risk > 0)) return { status: 'NO_FILL' };
  const entryDate = String(dailyFuture[fi][0]).slice(0, 10);
  const shares = Math.floor(CAPITAL / entryFillPx);
  if (shares < 1) return { status: 'NO_FILL' };
  const mfeR = mfeUntilStop(dailyFuture, fi, entryFillPx, sl, risk, holdMax);

  // 2) Walk forward to SL / T1 / plan-holding time-stop.
  let held = 0;
  for (let i = fi; i < dailyFuture.length; i++) {
    const b = dailyFuture[i];
    const high = +b[2], low = +b[3], close = +b[4];
    held++;
    const hitSl = low <= sl, hitT1 = high >= t1;
    if (hitSl && hitT1) return done('LOSS', 'SL_AMBIG', roundTick(Math.min(sl, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (hitSl) return done('LOSS', 'SL', roundTick(Math.min(sl, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (hitT1) return done('WIN', 'TARGET', roundTick(Math.max(t1, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (held >= holdMax) return done('TIME', 'TIME', roundTick(close) * (1 - SLIPPAGE_FRAC), b);
  }
  return { status: 'OPEN', entryDate };

  function done(status, exitReason, exitPx, bar) {
    const r = (exitPx - entryFillPx) / risk;
    const pnl = (exitPx - entryFillPx) * shares;
    return {
      status: status === 'TIME' ? (pnl >= 0 ? 'WIN' : 'LOSS') : status,
      rawStatus: status, exitReason, r, pnl, shares,
      capitalDeployed: Math.round(entryFillPx * shares),
      entryFillPx, exitPx, entryDate, entryMs,
      exitDate: String(bar[0]).slice(0, 10), exitMs: candleMs(bar),
      sl, target: t1, heldBars: held, mfeR,
    };
  }
}

function runTrack(exports, stock, regimeAsOf) {
  const { analyzeTf, generatePlan } = exports;
  const dailyAsc = sortAsc(readHarvest(stock.isin, '1d') || []);
  const weeklyAsc = sortAsc(readHarvest(stock.isin, '1w') || []);
  const monthlyRaw = readHarvest(stock.isin, '1mo');           // optional
  const monthlyAsc = monthlyRaw ? sortAsc(monthlyRaw) : null;

  const cursors = dailyAsc.filter((b) => {
    const ms = candleMs(b);
    return ms >= fromMs && ms <= toMs;
  });

  const verdicts = { BUY: 0, WAIT: 0, WATCH: 0, AVOID: 0, OTHER: 0, ERR: 0 };
  const trades = [];
  let blockedUntilMs = 0;

  for (const cur of cursors) {
    const asOfMs = candleMs(cur); // daily close at the cursor IS confirmed
    if (asOfMs <= blockedUntilMs) continue; // single-position: skip work while in a trade
    // sliceAsOf returns ASCENDING; the live engine (analyzeTf →
    // detectStructureBreaks, generatePlan) reads candles NEWEST-FIRST
    // (raw[0] = latest), the way the Upstox API delivers them. Feeding
    // ascending silently inverts the swing-structure trend (an uptrend reads
    // as "lower highs & lows"). Cap to the live per-TF window, then reverse to
    // newest-first before the engine, exactly like the live app.
    const sliceD = capWin(sliceAsOf(dailyAsc, asOfMs, false, 0), asOfMs, WIN_D_MS).reverse();
    const sliceW = capWin(sliceAsOf(weeklyAsc, asOfMs, true, PERIOD_MS['1w']), asOfMs, WIN_W_MS).reverse();
    const sliceM = monthlyAsc ? capWin(sliceAsOf(monthlyAsc, asOfMs, true, PERIOD_MS['1mo']), asOfMs, WIN_M_MS).reverse() : null;
    const regime = regimeAsOf(asOfMs);

    let plan;
    try {
      const anM = sliceM ? analyzeTf(sliceM, '1mo') : null;
      const anW = analyzeTf(sliceW, '1w');
      const anD = analyzeTf(sliceD, '1d');
      if (!anW || !anD) { verdicts.ERR++; continue; }
      plan = generatePlan(anM, anW, anD, null, regime); // hourly omitted (optional)
    } catch { verdicts.ERR++; continue; }
    if (!plan || !plan.ok) { verdicts.ERR++; continue; }

    const act = plan.action || 'OTHER';
    if (verdicts[act] === undefined) verdicts.OTHER++; else verdicts[act]++;
    if (act !== 'BUY') continue; // (blocked days already skipped above)

    const dailyFuture = dailyAsc.filter((b) => candleMs(b) > asOfMs);
    const g = gradeBuy(plan, dailyFuture);
    const signalDate = String(cur[0]).slice(0, 10);

    if (g.status === 'NO_PLAN') { continue; }
    if (g.status === 'NO_FILL') { trades.push({ signalDate, status: 'NO_FILL' }); continue; }
    if (g.status === 'OPEN') { trades.push({ signalDate, status: 'OPEN' }); blockedUntilMs = toMs + DEFAULT_HOLD * 86400000; continue; }

    blockedUntilMs = g.exitMs;
    trades.push({
      signalDate, status: g.status, exitReason: g.exitReason,
      regime: regime ? regime.regime : 'UNK',
      confidence: plan.confidence || null,
      setup: plan.setupShort || plan.setupName || null,
      signalPrice: round2(+cur[4]),
      plannedEntry: round2(plan.entry), entryLimit: round2(plan.entryHi || plan.entry),
      sl: round2(g.sl), target: round2(g.target),
      entry: round2(g.entryFillPx), exit: round2(g.exitPx),
      r: g.r, pnl: g.pnl, shares: g.shares, capitalDeployed: g.capitalDeployed,
      entryDate: g.entryDate, exitDate: g.exitDate,
      holdBars: g.heldBars,
      holdCalDays: Math.round((g.exitMs - g.entryMs) / 86400000),
      mfeR: g.mfeR != null ? round2(g.mfeR) : null,
      rrPlanned: (g.target - plan.entry) > 0 && (plan.entry - g.sl) > 0
        ? round2((g.target - plan.entry) / (plan.entry - g.sl)) : null,
    });
  }
  return { stock, verdicts, trades };
}

const inr = (x) => (x >= 0 ? '+₹' : '-₹') + Math.abs(Math.round(x)).toLocaleString('en-IN');

function writeTradesCsv(tracks) {
  const cols = [
    'stock', 'isin', 'sector', 'mode', 'status', 'exit_reason', 'regime', 'confidence', 'setup',
    'signal_date', 'signal_close', 'planned_entry', 'entry_limit', 'stop_loss', 'target', 'planned_rr',
    'entry_date', 'entry_fill', 'exit_date', 'exit_fill',
    'shares', 'capital_deployed', 'hold_trading_bars', 'hold_calendar_days', 'R_multiple', 'mfe_R', 'pnl_rupees',
  ];
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  for (const tr of tracks) {
    for (const t of tr.trades) {
      rows.push([
        tr.stock.sym, tr.stock.isin, tr.stock.sector ?? '', 'DEEP', t.status, t.exitReason ?? '', t.regime ?? '',
        t.confidence ?? '', t.setup ?? '',
        t.signalDate ?? '', t.signalPrice ?? '', t.plannedEntry ?? '', t.entryLimit ?? '',
        t.sl ?? '', t.target ?? '', t.rrPlanned ?? '',
        t.entryDate ?? '', t.entry ?? '', t.exitDate ?? '', t.exit ?? '',
        t.shares ?? '', t.capitalDeployed ?? '', t.holdBars ?? '', t.holdCalDays ?? '',
        t.r != null ? round2(t.r) : '', t.mfeR ?? '', t.pnl != null ? Math.round(t.pnl) : '',
      ].map(esc).join(','));
    }
  }
  const outDir = path.resolve(__dirname, '../../data/backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(outDir, `trades-generateplan-${stamp}.csv`);
  fs.writeFileSync(out, rows.join('\n') + '\n', 'utf8');
  return out;
}

function main() {
  const exports = loadSwingExports();
  const niftyAsc = sortAsc(readHarvest(NIFTY_ID, '1d') || []);
  if (!niftyAsc.length) {
    console.error('Missing Nifty daily harvest. Run scripts/backtest/harvest.mjs first.');
    process.exit(1);
  }
  const regimeAsOf = buildRegimeLookup(niftyAsc); // precomputed once, shared by all tracks

  const tracks = STOCKS.map((s) => runTrack(exports, s, regimeAsOf));

  // Flatten resolved trades, tag regime/sector/sym for rollups.
  const flat = [];
  const verdAll = { BUY: 0, WAIT: 0, WATCH: 0, AVOID: 0, OTHER: 0, ERR: 0 };
  for (const tr of tracks) {
    for (const k of Object.keys(verdAll)) verdAll[k] += tr.verdicts[k] || 0;
    for (const t of tr.trades) {
      if (t.status !== 'WIN' && t.status !== 'LOSS') continue;
      flat.push({ ...t, sym: tr.stock.sym, sector: tr.stock.sector });
    }
  }

  const agg = (list) => {
    const wins = list.filter((t) => t.status === 'WIN').length;
    const pnl = list.reduce((s, t) => s + t.pnl, 0);
    const sumR = list.reduce((s, t) => s + t.r, 0);
    const seq = list.slice().sort((a, b) => (a.exitMs || 0) - (b.exitMs || 0));
    let peak = 0, cum = 0, maxDd = 0;
    for (const t of seq) { cum += t.pnl; if (cum > peak) peak = cum; if (peak - cum > maxDd) maxDd = peak - cum; }
    return { taken: list.length, wins, winRate: list.length ? (wins / list.length) * 100 : 0, pnl, sumR, maxDd, expR: list.length ? sumR / list.length : 0 };
  };
  const row = (label, list) => {
    const s = agg(list);
    return `${label.padEnd(16)} ${String(s.taken).padStart(5)}  ${s.taken ? s.winRate.toFixed(0).padStart(3) : '  -'}%  ` +
      `${inr(s.pnl).padStart(12)}  ${('₹' + Math.round(s.maxDd).toLocaleString('en-IN')).padStart(10)}  ` +
      `${(s.sumR >= 0 ? '+' : '') + s.sumR.toFixed(0)}R  exp ${(s.expR >= 0 ? '+' : '') + s.expR.toFixed(2)}R`;
  };

  const totalBuys = tracks.reduce((n, tr) => n + tr.verdicts.BUY, 0);
  const L = '═'.repeat(82);
  console.log('\n' + L);
  console.log(`generatePlan (DEEP) BACKTEST · ${WIN_FROM} → ${WIN_TO} · ₹${CAPITAL.toLocaleString('en-IN')}/trade · plan's OWN entry/SL/T1`);
  console.log(`Universe: ${STOCKS.length} stocks · ${totalBuys} BUY signals · ${flat.length} resolved trades`);
  console.log(L);
  console.log('bucket            taken  win%      totalP&L        maxDD       ΣR    expectancy');
  console.log('─'.repeat(82));
  console.log('  by NIFTY REGIME:');
  for (const reg of ['BULL', 'NEUTRAL', 'BEAR']) console.log('  ' + row(reg, flat.filter((t) => t.regime === reg)));
  console.log('  by PLAN CONFIDENCE:');
  for (const c of [...new Set(flat.map((t) => t.confidence || 'none'))].sort()) {
    console.log('  ' + row(String(c), flat.filter((t) => (t.confidence || 'none') === c)));
  }
  console.log('─'.repeat(82));
  console.log('  ' + row('ALL', flat));
  console.log(L);

  // Verdict distribution (how selective generatePlan is across the universe).
  console.log(`Verdict distribution (as-of days, all stocks): BUY ${verdAll.BUY} · WAIT ${verdAll.WAIT} · WATCH ${verdAll.WATCH} · AVOID ${verdAll.AVOID} · OTHER ${verdAll.OTHER} · ERR ${verdAll.ERR}`);
  console.log(L);

  // Target-reachability (MFE) curve.
  const withMfe = flat.filter((t) => t.mfeR != null);
  if (withMfe.length) {
    console.log(`Target reachability (favourable run reached ≥ N·risk before stop/hold; n=${withMfe.length}):`);
    for (const r of [0.5, 1, 1.5, 2, 2.5, 3, 4]) {
      const pct = (withMfe.filter((t) => t.mfeR >= r).length / withMfe.length) * 100;
      console.log(`  ≥ ${r.toFixed(1)}R  ${pct.toFixed(0).padStart(3)}%  ${'█'.repeat(Math.round(pct / 2.5))}`);
    }
    console.log(L);
  }

  // Best / worst stocks by net P&L.
  const bySym = new Map();
  for (const t of flat) { if (!bySym.has(t.sym)) bySym.set(t.sym, []); bySym.get(t.sym).push(t); }
  const symStats = [...bySym.entries()].map(([sym, list]) => ({ sym, ...agg(list) })).sort((a, b) => b.pnl - a.pnl);
  const show = (s) => `  ${s.sym.padEnd(12)} ${String(s.taken).padStart(3)}t ${s.winRate.toFixed(0).padStart(3)}%  ${inr(s.pnl).padStart(12)}`;
  console.log('Top 8 stocks by net P&L:'); symStats.slice(0, 8).forEach((s) => console.log(show(s)));
  console.log('Bottom 8 stocks by net P&L:'); symStats.slice(-8).forEach((s) => console.log(show(s)));
  console.log(L);

  const csvPath = writeTradesCsv(tracks);
  console.log(`Full per-trade ledger: ${csvPath}`);

  console.log('\n' + L);
  console.log('CAVEATS (read before trusting these numbers):');
  console.log(`  • ${STOCKS.length} stocks × ~7 years across all regimes — far broader than the`);
  console.log('    earlier 5-stock probe, but still NSE-only and India-only.');
  console.log('  • Survivorship: sampled from TODAY\'s listed names; the fixed-seed');
  console.log('    stratified pick + included laggards reduce (not erase) the bias.');
  console.log('  • Monthly TF harvested too — generatePlan runs its full Stage 1-4 stack.');
  console.log('  • Costs modelled as 0.05%/side slippage only (no brokerage/STT/impact).');
  console.log('  • Uses the plan\'s OWN t1/sl (no 2R override) — the DEEP engine tested as');
  console.log('    the chart trade-plan card shows it.');
  console.log(L + '\n');
}

main();
