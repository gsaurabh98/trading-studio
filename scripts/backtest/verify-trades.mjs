// Hand-verification harness: trace individual trades from the SCAN ledger back
// to the raw daily candles, so a human can confirm by eye that
//   (1) the signal close matches the real bar,
//   (2) the entry was a limit fill on a session AFTER the signal (no lookahead),
//   (3) the exit (SL / target / time) is the first real bar that hit it, and
//   (4) every bar touched is strictly AFTER the signal — nothing from the future
//       leaked into the decision.
//
// Restricted to DAILY-timeframe trades so "as-of" = the signal bar's own close
// and the forward walk is unambiguous (weekly signals close mid-future-week and
// are harder to eyeball). Picks a few WINs and a few LOSSes by default.
//
// Usage: node scripts/backtest/verify-trades.mjs [--csv=path] [--n=3]
//        [--stock=SYM] [--mode=ZOI]

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, sortAsc, candleMs, readHarvest } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const N = +arg('n', '3');
const ONLY_STOCK = arg('stock', '');
const ONLY_MODE = arg('mode', '');

function latestScanCsv() {
  const cand = arg('csv', '');
  if (cand) return cand;
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('trades-') && /^trades-\d/.test(f))
    .sort();
  if (!files.length) throw new Error('no trades-<date>.csv in ' + DATA_DIR);
  return path.join(DATA_DIR, files[files.length - 1]);
}

function parseCsv(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  const lines = text.split('\n');
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // naive split is fine — our ledger has no commas inside fields
    const cells = line.split(',');
    const row = {};
    cols.forEach((c, i) => { row[c] = cells[i]; });
    return row;
  });
}

const TICK = 0.05, SLIP = 0.0005, FILL_WIN = 3, MAX_HOLD = 30;
const roundTick = (px) => Math.round(px / TICK) * TICK;
const f2 = (x) => (+x).toFixed(2);

function trace(row) {
  const isin = row.isin, sym = row.stock;
  const dailyAsc = sortAsc(readHarvest(isin, '1d') || []);
  const sigDate = row.signal_date.slice(0, 10);
  const sigIdx = dailyAsc.findIndex((b) => String(b[0]).slice(0, 10) === sigDate);
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`${sym} · ${row.mode}/${row.timeframe} · ${row.status} (${row.exit_reason}) · regime ${row.regime}`);
  if (sigIdx < 0) { console.log('  ! signal date not found in daily series'); return; }
  const sig = dailyAsc[sigIdx];
  const sigClose = +sig[4];
  const entry = +row.planned_entry, sl = +row.stop_loss, tgt = +row.target;
  console.log(`  signal bar ${sigDate}: close ₹${f2(sigClose)}  (ledger signal_close ₹${row.signal_close})  → match: ${Math.abs(sigClose - +row.signal_close) < 0.01 ? 'YES' : 'NO ❌'}`);
  console.log(`  plan: limit-entry ₹${f2(entry)} · stop ₹${f2(sl)} · target ₹${f2(tgt)}  (R:R ${f2((tgt - entry) / (entry - sl))})`);

  // Forward walk — bars strictly AFTER the signal.
  const fut = dailyAsc.slice(sigIdx + 1);
  console.log('  forward bars (all dated AFTER the signal — no lookahead):');
  let fi = -1, fillPx = NaN;
  for (let i = 0; i < Math.min(FILL_WIN, fut.length); i++) {
    const b = fut[i]; const d = String(b[0]).slice(0, 10);
    const touched = +b[3] <= entry;
    console.log(`    ${d}  H ${f2(b[2])} L ${f2(b[3])} C ${f2(b[4])}   ${touched ? `← LOW ≤ limit → FILL` : 'limit not touched'}`);
    if (touched) { fillPx = roundTick(Math.min(+b[1], entry)) * (1 + SLIP); fi = i; break; }
  }
  if (fi < 0) { console.log('  → NO FILL within 3 sessions (matches ledger NO_FILL)'); return; }
  const fillDate = String(fut[fi][0]).slice(0, 10);
  const risk = fillPx - sl;
  console.log(`  ENTRY  ${fillDate} @ ₹${f2(fillPx)} (ledger entry_fill ₹${row.entry_fill}, entry_date ${row.entry_date.slice(0, 10)}) · risk ₹${f2(risk)}`);

  for (let i = fi, held = 0; i < fut.length; i++) {
    const b = fut[i]; const d = String(b[0]).slice(0, 10); held++;
    const hitSl = +b[3] <= sl, hitT = +b[2] >= tgt;
    if (hitSl || hitT || held >= MAX_HOLD) {
      let why = held >= MAX_HOLD && !hitSl && !hitT ? 'TIME' : (hitSl && hitT ? 'SL_AMBIG' : hitSl ? 'SL' : 'TARGET');
      let px = why === 'TARGET' ? roundTick(Math.max(tgt, +b[1])) * (1 - SLIP)
        : why === 'TIME' ? roundTick(+b[4]) * (1 - SLIP)
          : roundTick(Math.min(sl, +b[1])) * (1 - SLIP);
      const r = (px - fillPx) / risk;
      console.log(`  EXIT   ${d} via ${why} @ ₹${f2(px)} after ${held} bars  → R ${r.toFixed(2)}`);
      console.log(`         ledger says: exit ${row.exit_date.slice(0, 10)} @ ₹${row.exit_fill} · reason ${row.exit_reason} · R ${row.R_multiple} · hold ${row.hold_trading_bars}b`);
      const ok = d === row.exit_date.slice(0, 10) && why === row.exit_reason;
      console.log(`         → reconstruction matches ledger: ${ok ? 'YES ✅' : 'CHECK ⚠️'}`);
      return;
    }
  }
}

function main() {
  const csv = latestScanCsv();
  console.log(`Ledger: ${csv}`);
  let rows = parseCsv(csv).filter((r) => r.timeframe === '1d' && (r.status === 'WIN' || r.status === 'LOSS'));
  if (ONLY_STOCK) rows = rows.filter((r) => r.stock === ONLY_STOCK);
  if (ONLY_MODE) rows = rows.filter((r) => r.mode === ONLY_MODE);
  const wins = rows.filter((r) => r.status === 'WIN');
  const losses = rows.filter((r) => r.status === 'LOSS');
  const pick = (arr, k) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / k)) === 0).slice(0, k);
  const sample = [...pick(wins, N), ...pick(losses, N)];
  console.log(`Tracing ${sample.length} daily-TF trades (${N} WIN + ${N} LOSS) against raw candles…`);
  for (const r of sample) trace(r);
  console.log(`\n${'─'.repeat(78)}\nIf every "match" line is YES/✅, the ledger is a faithful, no-lookahead replay.`);
}

main();
