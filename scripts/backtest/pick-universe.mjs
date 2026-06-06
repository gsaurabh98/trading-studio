// Pick a stratified, reproducible backtest universe from data/sectors.json.
//
// Method (deliberately a RULE, not a hand-pick — so the test can't be
// cherry-picked, per .cursor/rules/trading-context.mdc):
//   • Start from every stock in the ₹500–3,000 band (the user's range).
//   • Stratify across all 16 sectors — take up to PICK names per sector, so
//     no single big bucket (Services/Financials) dominates.
//   • Random sample within each sector using a FIXED SEED → fully reproducible
//     (re-running yields the identical list). This is the anti-bias guarantee.
//   • Over-sample slightly (PICK > target) so the later liquidity trim can drop
//     illiquid names and still leave ~10 tradeable per sector.
//   • De-dupe across sectors by ISIN (a stock listed in two sectors is kept once).
//
// Writes data/backtest/universe.json = [{ sym, isin, sector }] (candidates).
// The liquidity trim (liquidity-trim.mjs) runs AFTER harvest and produces the
// final universe-final.json.
//
// Usage: node scripts/backtest/pick-universe.mjs [--pick=12] [--seed=20260602]
//        [--min=500] [--max=3000]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const PICK = +arg('pick', '12');
const SEED = +arg('seed', '20260602');
const MIN = +arg('min', '500');
const MAX = +arg('max', '3000');

// Deterministic PRNG (mulberry32) — same seed ⇒ same shuffle ⇒ reproducible pick.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isValidIsin(isin) {
  return typeof isin === 'string' && /^INE[0-9A-Z]{9}$/.test(isin);
}

function main() {
  const sectors = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'sectors.json'), 'utf8')).sectors;
  const rnd = mulberry32(SEED);
  const seenIsin = new Set();
  const picked = [];
  const perSector = [];

  for (const sec of sectors) {
    const band = (sec.stocks || []).filter(
      (s) => isValidIsin(s.isin) && isFinite(s.price) && s.price >= MIN && s.price <= MAX
    );
    // Reproducible shuffle, then take the first PICK not-yet-seen ISINs.
    const shuffled = shuffle(band, rnd);
    let taken = 0;
    for (const s of shuffled) {
      if (taken >= PICK) break;
      if (seenIsin.has(s.isin)) continue;
      seenIsin.add(s.isin);
      picked.push({ sym: s.sym, isin: s.isin, sector: sec.id, sectorName: sec.name, pickPrice: s.price });
      taken++;
    }
    perSector.push([sec.name, band.length, taken]);
  }

  const out = path.join(REPO, 'data', 'backtest', 'universe.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    seed: SEED, pickPerSector: PICK, band: [MIN, MAX],
    count: picked.length, stocks: picked,
  }, null, 1));

  console.log(`Universe candidates: ${picked.length}  (seed ${SEED}, up to ${PICK}/sector, ₹${MIN}-${MAX})`);
  console.log('sector'.padEnd(24), 'inBand', 'picked');
  for (const [n, b, t] of perSector) console.log(n.padEnd(24), String(b).padStart(5), String(t).padStart(6));
  console.log(`\nWrote ${out}`);
}

main();
