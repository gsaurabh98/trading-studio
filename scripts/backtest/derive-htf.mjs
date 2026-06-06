// Regenerate the stored weekly (1w) and monthly (1mo) harvest files by DERIVING
// them from the daily series with the live app's EXACT aggregator
// (deriveTfFromDaily → swAngelAggregate / swAngelBucketKey), overwriting the
// native Upstox weekly/monthly we harvested.
//
// Why: the live swing path never fetches native weekly/monthly — it pulls one
// deep daily series and derives the higher TFs (see _fetchTfOnce in
// swing-analyzer.js). Native Upstox weekly bars can sit on different period
// boundaries (week anchor / holiday handling), so feeding them would make the
// backtest verdict DIFFER from what the app actually shows. Deriving here makes
// the stored 1w/1mo byte-for-byte what the engine sees live → zero drift.
//
// The runners (run.mjs / run-scan.mjs) read these files unchanged; their
// sliceAsOf(dropForming) at each as-of then reproduces deriveTfFromDaily's
// as-of view exactly (the current forming bucket is dropped both here — vs real
// "now" — and again per-cursor — vs the as-of date).
//
// Usage: node scripts/backtest/derive-htf.mjs   (run AFTER harvest.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadSwingExports, readHarvest } from './lib.mjs';

function main() {
  const { deriveTfFromDaily } = loadSwingExports();
  if (typeof deriveTfFromDaily !== 'function') {
    console.error('deriveTfFromDaily not exposed — update the __SWING_TEST__ hook in swing-analyzer.js.');
    process.exit(1);
  }

  // Every harvested daily file → derive its 1w + 1mo. (Nifty included; only its
  // daily is used for regime, but deriving its HTF is harmless.)
  const dailyFiles = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_1d.json'));
  let done = 0;
  for (const f of dailyFiles) {
    const isin = f.slice(0, -('_1d.json'.length));
    const daily = readHarvest(isin, '1d'); // newest-first [ts,o,h,l,c,v,oi]
    if (!daily || !daily.length) continue;
    for (const tf of ['1w', '1mo']) {
      const derived = deriveTfFromDaily(daily, tf); // newest-first [ts,o,h,l,c,v]
      const out = path.join(DATA_DIR, `${isin}_${tf}.json`);
      fs.writeFileSync(out, JSON.stringify({
        isin, tf, derivedFromDaily: true, fetchedAt: Date.now(), candles: derived,
      }));
    }
    done++;
  }
  console.log(`Derived 1w + 1mo from daily for ${done} instruments (live aggregator) → data/backtest/`);
}

main();
