// Trim the raw candidate universe (universe.json) down to a liquid, testable
// final universe (universe-final.json) that both backtest runners consume.
//
// Two data-driven gates (no hand-picking — keeps the test honest):
//   1. LIQUIDITY: median daily ₹-turnover (close × volume) over the most recent
//      ~250 sessions must clear a floor. Illiquid names can't realistically be
//      filled at the backtest's limit price (the fill model assumes the limit
//      is reachable), so trading them would manufacture fake edge. Floor default
//      ₹2 crore/day — comfortably tradeable for a ₹1 lakh position.
//   2. HISTORY: enough daily bars to warm up the indicators AND leave a real
//      signal window. We deliberately DON'T require coverage back to 2019 — that
//      would re-introduce survivorship bias (only old survivors qualify). A 2021
//      listing is tested over its own available window instead.
//
// Then, to honour the "~10 per sector" spec, keep the TOP-N most-liquid names
// per sector (default 10). Sectors with fewer survivors keep all they have.
//
// Reads:  data/backtest/universe.json  +  data/backtest/<ISIN>_1d.json
// Writes: data/backtest/universe-final.json = { stocks:[{isin,sym,sector,...}] }
//
// Usage: node scripts/backtest/liquidity-trim.mjs [--floor=2e7] [--keep=10]
//        [--min-bars=300] [--window=250]

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadUniverse, readHarvest } from './lib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const FLOOR = +arg('floor', '2e7');     // ₹2 crore/day median turnover
const KEEP = +arg('keep', '10');        // top-N liquid per sector
const MIN_BARS = +arg('min-bars', '300');
const WINDOW = +arg('window', '250');   // recent sessions for the median

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function crore(x) { return (x / 1e7).toFixed(2) + 'cr'; }

function main() {
  const { stocks } = loadUniverse(false);
  if (!stocks.length) { console.error('No universe.json — run pick-universe.mjs.'); process.exit(1); }

  const rows = [];
  for (const s of stocks) {
    const daily = readHarvest(s.isin, '1d'); // newest-first [ts,o,h,l,c,v,oi]
    if (!daily || !daily.length) { rows.push({ ...s, bars: 0, medTurnover: 0, drop: 'NO_DATA' }); continue; }
    const recent = daily.slice(0, WINDOW);   // newest-first ⇒ slice(0,N) = last N
    const turn = recent
      .map((b) => (+b[4]) * (+b[5]))          // close × volume
      .filter((t) => isFinite(t) && t > 0);
    const med = median(turn);
    const oldest = String(daily[daily.length - 1][0]).slice(0, 10);
    const newest = String(daily[0][0]).slice(0, 10);
    let drop = null;
    if (daily.length < MIN_BARS) drop = 'SHORT_HIST';
    else if (med < FLOOR) drop = 'ILLIQUID';
    rows.push({ ...s, bars: daily.length, medTurnover: med, oldest, newest, drop });
  }

  // Keep survivors, then top-N per sector by liquidity.
  const survivors = rows.filter((r) => !r.drop);
  const bySector = new Map();
  for (const r of survivors) {
    if (!bySector.has(r.sector)) bySector.set(r.sector, []);
    bySector.get(r.sector).push(r);
  }
  const kept = [];
  const perSector = [];
  for (const [sector, list] of bySector) {
    list.sort((a, b) => b.medTurnover - a.medTurnover);
    const take = list.slice(0, KEEP);
    kept.push(...take);
    perSector.push([sector, list.length, take.length]);
  }
  kept.sort((a, b) => (a.sector || '').localeCompare(b.sector || '') || b.medTurnover - a.medTurnover);

  const out = path.join(DATA_DIR, 'universe-final.json');
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    floorTurnover: FLOOR, keepPerSector: KEEP, minBars: MIN_BARS, medianWindow: WINDOW,
    count: kept.length,
    stocks: kept.map((r) => ({
      isin: r.isin, sym: r.sym, sector: r.sector,
      medTurnover: Math.round(r.medTurnover), bars: r.bars, oldest: r.oldest, newest: r.newest,
    })),
  }, null, 1));

  // ── Report ──
  const dropCounts = rows.reduce((m, r) => { if (r.drop) m[r.drop] = (m[r.drop] || 0) + 1; return m; }, {});
  console.log(`Candidates: ${rows.length}  ·  survivors: ${survivors.length}  ·  final (top-${KEEP}/sector): ${kept.length}`);
  console.log(`Gates: median turnover ≥ ₹${crore(FLOOR)}/day · ≥ ${MIN_BARS} daily bars · median over last ${WINDOW} sessions`);
  console.log('Dropped:', Object.entries(dropCounts).map(([k, v]) => `${k} ${v}`).join(' · ') || 'none');
  console.log('\nsector'.padEnd(28), 'surv', 'kept');
  for (const [sec, surv, k] of perSector.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(String(sec).padEnd(28), String(surv).padStart(4), String(k).padStart(4));
  }
  console.log(`\nKept ${kept.length} stocks → ${out}`);
}

main();
