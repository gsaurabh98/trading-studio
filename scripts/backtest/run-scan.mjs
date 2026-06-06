// Walk-forward backtest of the Fib / ZOI / Fib+ZOI SCAN engine — the
// universe-scan verdicts driven by data/verdict-rules.json (the front of
// the stock-selection funnel). This is the engine that was previously
// UNVALIDATED by any historical simulation.
//
// Scenario (broad-universe spec):
//   • Window  : signals evaluated 2019 → 2025 (as-of dates) — spans the COVID
//               crash, the 2020-21 bull run, the 2022 correction and 2023-24
//               recovery, so every Nifty regime (BULL / BEAR / NEUTRAL) is hit.
//   • Stocks  : data/backtest/universe-final.json — ~127 liquidity-trimmed names
//               stratified ~10/sector across 16 sectors, ₹500-3000 band, picked
//               by a fixed seed (pick-universe.mjs) so the set can't be
//               cherry-picked. Deliberately includes laggards → less survivorship.
//   • Modes   : FIB, ZOI, FIB+ZOI  (each evaluated independently)
//   • TFs     : daily AND weekly  (reported separately)
//   • Trade   : on a BUY, deploy ₹1 lakh (shares = floor(1e5 / fill)) via a
//               limit at the verdict's rrEntry, hold until a SWING target
//               (TARGET_R × the engine's stop distance) or rrSl (SL), with a
//               ~6-week time-stop. The engine's own tight rrT1 is NOT used —
//               it was a scalper's target (median 0.13R).
//   • Report  : per stock × mode × TF, plus per-regime and per-mode rollups,
//               win rate, ₹ P&L, drawdown, and a target-reachability (MFE)
//               curve for sizing T1/T2 confidence.
//
// No-lookahead / no-repainting (mandatory — real capital depends on it):
//   • Each scan-TF bar is evaluated AT ITS CLOSE; the still-forming next
//     bar is dropped from the sliced history.
//   • Grading always walks DAILY bars strictly AFTER the signal bar closed.
//   • Regime is recomputed point-in-time from sliced Nifty daily history.
//
// Reuses the EXACT live engine via scanVerdictFromCandles (vm-loaded) —
// zero signal drift.
//
// Usage: node scripts/backtest/run-scan.mjs [--months-from=2024-01]
//        [--months-to=2026-01] [--shares=100]

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
// Capital deployed PER trade. Shares = floor(CAPITAL / fill price) — so a ₹550
// stock buys ~181 shares, a ₹1000 stock ~100. Fixed notional, not compounding;
// the single-position model already prevents overlapping exposure.
const CAPITAL = +arg('capital', '100000');
// SWING target as a reward:risk multiple of the engine's stop distance. The
// engine's own rrT1 was a scalper's target (median 0.13R) — far too tight for a
// swing hold. We keep the engine's ENTRY + STOP (its real edge) and set the
// target at TARGET_R × risk so a win is a meaningful multi-day/week move, not a
// ₹200 same-session scalp. 2.0R on a ~3-4% stop ⇒ ~6-8% target ⇒ typically a
// 1-2 week hold. Tune with --target-r=2.5 etc.
const TARGET_R = +arg('target-r', '2.0');
const TICK = 0.05;
const SLIPPAGE_FRAC = 0.0005; // 0.05% adverse per side (proxy for costs)
const FILL_WINDOW_BARS = 3;   // limit-entry validity, in DAILY bars
// Swing time-stop: if neither target nor SL is hit within this many TRADING
// days (~6 weeks), close at the bar's close. Stops a thesis from drifting
// forever while still giving a 1-2 week swing room to play out. Tune with
// --max-hold=30.
const MAX_HOLD_DAYS = +arg('max-hold', '30');

const STOCKS = loadUniverse(true).stocks; // universe-final.json (liquidity-trimmed)
if (!STOCKS.length) {
  console.error('No universe-final.json — run pick-universe.mjs → harvest.mjs → liquidity-trim.mjs first.');
  process.exit(1);
}
const MODES = ['FIB', 'ZOI', 'FIB_ZOI'];
const TFS = ['1d', '1w'];
const NIFTY_ID = 'NIFTY50';

const roundTick = (px) => Math.round(px / TICK) * TICK;
const fromMs = new Date(WIN_FROM + 'T00:00:00Z').getTime();
const toMs = new Date(WIN_TO + 'T23:59:59Z').getTime();

// Per-TF lookback window — MUST match the live app's fetch (TF_SPECS in
// swing-analyzer.js: daily 2y, weekly 3y). Capping the as-of slice to this
// window is both FAITHFUL (the live verdict is computed on exactly this much
// history — feeding 8 years would shift fib/S-R anchors and change the verdict)
// and far faster than re-running the engine over the full harvested series.
const SCAN_WIN_MS = { '1d': 365 * 2 * 86400000, '1w': 365 * 3 * 86400000 };
const capWin = (asc, asOfMs, winMs) => {
  const cut = asOfMs - winMs;
  let i = 0; while (i < asc.length && candleMs(asc[i]) < cut) i++;
  return i ? asc.slice(i) : asc;
};

// ── Market-hours / trading-day discipline ───────────────────────────────────
// A daily candle EXISTS only for a day NSE actually held a session — so simply
// iterating the harvested daily series already guarantees fills/exits land on
// real trading days. We deliberately DON'T impose a Mon-Fri filter: NSE does
// run occasional weekend sessions (Union-Budget Saturdays e.g. 01-Feb-2025,
// Diwali Muhurat e.g. 12-Nov-2023, DR-site live tests e.g. 18-May-2024) and
// those bars are legitimate tradable sessions. The data is the authority; a
// weekday heuristic would wrongly discard valid trades.
//
// NOTE on execution TIME: daily bars carry no intraday clock, so the backtest
// records the trading DATE only — never a fabricated HH:MM. A limit fill or a
// target/SL exit happens at some unknown minute within the session; the true
// time is NOT recoverable from daily data (would need intraday candles, which
// Upstox only serves ~90 days back).

/**
 * Grade one BUY. `dailyFuture` = chronological daily bars strictly after
 * the signal bar closed. Returns { status, r, pnl, entryFillPx, exitPx,
 * entryDate, exitDate, exitReason, exitMs }.
 */
// Max favourable excursion, in R, IGNORING our target but RESPECTING the stop:
// from the fill bar, walk forward tracking the best high until SL is breached or
// the time-stop hits. Answers "while still in the trade, how far did it actually
// run?" — the honest basis for a target-reachability curve (would a 2R/3R target
// have been hit?), unbiased by where WE chose to take profit. `fi` is the fill
// index in dailyFuture; `entryFillPx` the actual fill; `risk` = entry − SL.
function mfeUntilStop(dailyFuture, fi, entryFillPx, sl, risk) {
  let best = 0;
  for (let i = fi, held = 0; i < dailyFuture.length; i++, held++) {
    const b = dailyFuture[i];
    const fav = (+b[2] - entryFillPx) / risk;        // high-based favourable excursion
    if (fav > best) best = fav;
    if (+b[3] <= sl) break;                           // stopped out → out of the trade
    if (held + 1 >= MAX_HOLD_DAYS) break;             // time-stop horizon
  }
  return best;
}

function gradeBuy(entry, sl, t1, dailyFuture) {
  if (!(entry > 0) || !(sl > 0) || !(t1 > 0) || sl >= entry || t1 <= entry) {
    return { status: 'NO_PLAN', r: 0, pnl: 0 };
  }
  // 1) Limit fill within the next few daily sessions (every daily bar is a real
  //    NSE session, so fills are inherently market-hours-only).
  let fi = -1, entryFillPx = NaN, entryMs = 0;
  for (let i = 0; i < Math.min(FILL_WINDOW_BARS, dailyFuture.length); i++) {
    const b = dailyFuture[i];
    if (+b[3] <= entry) { // low touched the limit
      entryFillPx = roundTick(Math.min(+b[1], entry)) * (1 + SLIPPAGE_FRAC);
      entryMs = candleMs(b);
      fi = i;
      break;
    }
  }
  if (fi < 0) return { status: 'NO_FILL', r: 0, pnl: 0 };

  const risk = entryFillPx - sl;
  if (!(risk > 0)) return { status: 'NO_FILL', r: 0, pnl: 0 };
  const entryDate = String(dailyFuture[fi][0]).slice(0, 10);
  // ₹1 lakh (CAPITAL) deployed → whole shares at the actual fill price.
  const shares = Math.floor(CAPITAL / entryFillPx);
  if (shares < 1) return { status: 'NO_FILL', r: 0, pnl: 0 };

  // Target-reachability: how far it ran (in R) before SL/time, ignoring our T1.
  const mfeR = mfeUntilStop(dailyFuture, fi, entryFillPx, sl, risk);

  // 2) Walk forward to SL / target / safety time-stop.
  let held = 0;
  for (let i = fi; i < dailyFuture.length; i++) {
    const b = dailyFuture[i];
    const high = +b[2], low = +b[3], close = +b[4];
    held++;
    const hitSl = low <= sl, hitT1 = high >= t1;
    if (hitSl && hitT1) return done('LOSS', 'SL_AMBIG', roundTick(Math.min(sl, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (hitSl) return done('LOSS', 'SL', roundTick(Math.min(sl, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (hitT1) return done('WIN', 'TARGET', roundTick(Math.max(t1, +b[1])) * (1 - SLIPPAGE_FRAC), b);
    if (held >= MAX_HOLD_DAYS) return done(close > entryFillPx ? 'WIN' : 'LOSS', 'TIME', roundTick(close) * (1 - SLIPPAGE_FRAC), b);
  }
  return { status: 'OPEN', r: 0, pnl: 0, entryDate };

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

function runTrack(exports, stock, mode, tf, dailyAsc, scanAsc, regimeAsOf) {
  const { scanVerdictFromCandles } = exports;
  const cursors = scanAsc.filter((b) => {
    const ms = candleMs(b);
    return ms >= fromMs && ms <= toMs;
  });

  const trades = [];
  let buySignals = 0, noPlan = 0;
  let blockedUntilMs = 0;

  for (const cur of cursors) {
    const barStart = candleMs(cur);
    const asOfMs = barStart + PERIOD_MS[tf] - 1; // this bar's close
    // Single-position model: while a trade is open no new one can be taken, so
    // skip the (expensive) verdict computation entirely until it closes.
    if (asOfMs <= blockedUntilMs) continue;
    const slice = capWin(sliceAsOf(scanAsc, asOfMs, true, PERIOD_MS[tf]), asOfMs, SCAN_WIN_MS[tf] || SCAN_WIN_MS['1d']);
    if (!slice.length) continue;
    const newestFirst = slice.slice().reverse(); // engine reads raw[0]=latest
    const regime = regimeAsOf(asOfMs);

    let v;
    try {
      v = scanVerdictFromCandles(newestFirst, mode, regime, tf);
    } catch { continue; }
    if (!v || !v.ok || v.action !== 'BUY') continue;
    buySignals++;

    const rc = v.riskContext || {};
    const entry = rc.rrEntry, sl = rc.rrSl;
    // SWING target: ignore the engine's tight rrT1; place the target at
    // TARGET_R × the engine's own stop distance. Entry + stop come from the
    // engine (its edge); the target is sized for a real swing move.
    const t1 = (entry > 0 && sl > 0 && sl < entry)
      ? roundTick(entry + TARGET_R * (entry - sl))
      : 0;
    const dailyFuture = dailyAsc.filter((b) => candleMs(b) > asOfMs);
    const g = gradeBuy(entry, sl, t1, dailyFuture);
    const signalDate = String(cur[0]).slice(0, 10);

    if (g.status === 'NO_PLAN') { noPlan++; continue; }
    if (g.status === 'NO_FILL') { trades.push({ signalDate, status: 'NO_FILL' }); continue; }
    if (g.status === 'OPEN') { trades.push({ signalDate, status: 'OPEN' }); blockedUntilMs = toMs + MAX_HOLD_DAYS * 86400000; continue; }

    blockedUntilMs = g.exitMs;
    trades.push({
      signalDate, status: g.status, exitReason: g.exitReason,
      regime: regime ? regime.regime : 'UNK',
      signalPrice: round2(+cur[4]),
      plannedEntry: round2(entry), sl: round2(g.sl), target: round2(g.target),
      entry: round2(g.entryFillPx), exit: round2(g.exitPx),
      r: g.r, pnl: g.pnl, shares: g.shares, capitalDeployed: g.capitalDeployed,
      entryDate: g.entryDate, exitDate: g.exitDate,
      holdBars: g.heldBars,
      holdCalDays: Math.round((g.exitMs - g.entryMs) / 86400000),
      fibClass: v.fibClass, zoiPosition: v.zoiPosition,
      mfeR: g.mfeR != null ? round2(g.mfeR) : null,
    });
  }
  return { stock, mode, tf, buySignals, noPlan, trades };
}

function round2(x) { return Math.round(x * 100) / 100; }

const inr = (x) => (x >= 0 ? '+₹' : '-₹') + Math.abs(Math.round(x)).toLocaleString('en-IN');

// Emit EVERY signal (taken, no-fill, still-open) as a flat CSV so the user can
// independently re-price each trade against a chart. One row per signal.
function writeTradesCsv(tracks) {
  const cols = [
    'stock', 'isin', 'sector', 'timeframe', 'mode', 'status', 'exit_reason',
    'regime', 'fib_class', 'zoi_position',
    'signal_date', 'signal_close',
    'planned_entry', 'stop_loss', 'target',
    'entry_date', 'entry_fill', 'exit_date', 'exit_fill',
    'shares', 'capital_deployed', 'hold_trading_bars', 'hold_calendar_days',
    'R_multiple', 'mfe_R', 'pnl_rupees',
  ];
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [cols.join(',')];
  for (const tr of tracks) {
    const { sym, isin, sector } = tr.stock;
    for (const t of tr.trades) {
      rows.push([
        sym, isin, sector ?? '', tr.tf, tr.mode, t.status, t.exitReason ?? '',
        t.regime ?? '', t.fibClass ?? '', t.zoiPosition ?? '',
        t.signalDate ?? '', t.signalPrice ?? '',
        t.plannedEntry ?? '', t.sl ?? '', t.target ?? '',
        t.entryDate ?? '', t.entry ?? '',
        t.exitDate ?? '', t.exit ?? '',
        t.shares ?? '', t.capitalDeployed ?? '',
        t.holdBars ?? '', t.holdCalDays ?? '',
        t.r != null ? round2(t.r) : '', t.mfeR ?? '', t.pnl != null ? Math.round(t.pnl) : '',
      ].map(esc).join(','));
    }
  }
  const outDir = path.resolve(__dirname, '../../data/backtest');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const out = path.join(outDir, `trades-${stamp}.csv`);
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

  const tracks = [];
  let missing = 0;
  for (const stock of STOCKS) {
    const dailyRaw = readHarvest(stock.isin, '1d');
    if (!dailyRaw) { missing++; continue; }
    const dailyAsc = sortAsc(dailyRaw);
    for (const tf of TFS) {
      const scanRaw = tf === '1d' ? dailyRaw : readHarvest(stock.isin, tf);
      if (!scanRaw) { missing++; continue; }
      const scanAsc = sortAsc(scanRaw);
      for (const mode of MODES) {
        tracks.push(runTrack(exports, stock, mode, tf, dailyAsc, scanAsc, regimeAsOf));
      }
    }
  }

  // Flatten every resolved trade once, tagging mode/tf/sector so we can roll up
  // any way we like without re-walking tracks.
  const flat = [];
  for (const tr of tracks) {
    for (const t of tr.trades) {
      if (t.status !== 'WIN' && t.status !== 'LOSS') continue;
      flat.push({ ...t, mode: tr.mode, tf: tr.tf, sym: tr.stock.sym, sector: tr.stock.sector });
    }
  }

  // Aggregate a flat trade list → headline stats (chronological maxDD).
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

  const totalBuys = tracks.reduce((n, tr) => n + tr.buySignals, 0);
  const L = '═'.repeat(82);
  console.log('\n' + L);
  console.log(`FIB / ZOI SCAN BACKTEST · ${WIN_FROM} → ${WIN_TO} · ₹${CAPITAL.toLocaleString('en-IN')}/trade · target ${TARGET_R}R · max-hold ${MAX_HOLD_DAYS}d`);
  console.log(`Universe: ${STOCKS.length} stocks (${missing} TF-series missing) · ${totalBuys} BUY signals · ${flat.length} resolved trades`);
  console.log(L);
  console.log('bucket            taken  win%      totalP&L        maxDD       ΣR    expectancy');
  console.log('─'.repeat(82));
  console.log('  by MODE × TF:');
  for (const mode of MODES) for (const tf of TFS) {
    console.log('  ' + row(`${mode}/${tf}`, flat.filter((t) => t.mode === mode && t.tf === tf)));
  }
  console.log('  by MODE (both TFs):');
  for (const mode of MODES) console.log('  ' + row(mode, flat.filter((t) => t.mode === mode)));
  console.log('  by NIFTY REGIME (all modes):');
  for (const reg of ['BULL', 'NEUTRAL', 'BEAR']) console.log('  ' + row(reg, flat.filter((t) => t.regime === reg)));
  console.log('─'.repeat(82));
  console.log('  ' + row('ALL', flat));
  console.log(L);

  // ── Target-reachability (MFE) curve ── what fraction of filled trades ran at
  // least Nx risk in our favour (respecting the stop) — the empirical basis for
  // how aggressive a T1/T2 target can be while still being hit often enough.
  const withMfe = flat.filter((t) => t.mfeR != null);
  if (withMfe.length) {
    console.log('Target reachability (share of trades whose favourable run reached ≥ N·risk,');
    console.log(`ignoring our exit but respecting the stop; n=${withMfe.length}):`);
    for (const r of [0.5, 1, 1.5, 2, 2.5, 3, 4]) {
      const hit = withMfe.filter((t) => t.mfeR >= r).length;
      const pct = (hit / withMfe.length) * 100;
      const bar = '█'.repeat(Math.round(pct / 2.5));
      console.log(`  ≥ ${r.toFixed(1)}R  ${pct.toFixed(0).padStart(3)}%  ${bar}`);
    }
    console.log(L);
  }

  // Best / worst stocks by net P&L (so laggards are visible, not hidden in a mean).
  const bySym = new Map();
  for (const t of flat) { if (!bySym.has(t.sym)) bySym.set(t.sym, []); bySym.get(t.sym).push(t); }
  const symStats = [...bySym.entries()].map(([sym, list]) => ({ sym, ...agg(list) })).sort((a, b) => b.pnl - a.pnl);
  const show = (s) => `  ${s.sym.padEnd(12)} ${String(s.taken).padStart(3)}t ${s.winRate.toFixed(0).padStart(3)}%  ${inr(s.pnl).padStart(12)}`;
  console.log('Top 8 stocks by net P&L:'); symStats.slice(0, 8).forEach((s) => console.log(show(s)));
  console.log('Bottom 8 stocks by net P&L:'); symStats.slice(-8).forEach((s) => console.log(show(s)));
  console.log(L);

  // ── Full per-trade CSV (manual-verification data frame) ──
  const csvPath = writeTradesCsv(tracks);
  console.log(`Full per-trade ledger (open in Excel / pandas):\n  ${csvPath}`);

  console.log('\n' + L);
  console.log('CAVEATS (read before trusting these numbers):');
  console.log(`  • ${STOCKS.length} stocks × ~7 years across all regimes — far broader than the`);
  console.log('    earlier 5-stock probe, but still NSE-only and India-only.');
  console.log('  • Survivorship: the universe is sampled from TODAY\'s listed names, so');
  console.log('    fully delisted failures are absent; the fixed-seed stratified pick +');
  console.log('    deliberate inclusion of laggards reduces (does not erase) this bias.');
  console.log('  • Recent listings are tested only over their available window (no 2019');
  console.log('    coverage required) — avoids the opposite (old-survivor) bias.');
  console.log('  • Costs modelled as 0.05%/side slippage only (no brokerage/STT/impact).');
  console.log('  • Confirm with forward paper-testing on data the engine never saw.');
  console.log(L + '\n');
}

main();
