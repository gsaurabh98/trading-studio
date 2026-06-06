// Harvest historical OHLC for the backtest, through the local server.py
// proxy (so we reuse the same Cloudflare-friendly path the app uses and
// never hit api.upstox.com directly).
//
// Usage:
//   1. Make sure `python server.py` is running (default port 8000).
//   2. Provide your Upstox bearer token (same one the app uses):
//        export UPSTOX_TOKEN="xxxxxxxx"   (or --token=xxxx, or data/config.json)
//   3. node scripts/backtest/pick-universe.mjs    # writes universe.json first
//      node scripts/backtest/harvest.mjs          # then harvest it
//
// Writes data/backtest/<ISIN>_<tf>.json = { isin, tf, fetchedAt, candles }
// where candles is the raw Upstox newest-first [ts,o,h,l,c,v,oi] array.
//
// Scope (broad-universe backtest, 2019-2025 signal window):
//   • Universe: data/backtest/universe.json (stratified ~12/sector, ₹500-3000)
//     — produced by pick-universe.mjs. Plus Nifty 50 (point-in-time regime).
//   • History: daily ~8y, weekly/monthly ~9y in a SINGLE request each (Upstox
//     V3 serves multi-year daily/weekly/monthly without truncation — verified),
//     so warmup reaches well before the 2019 backtest start.
//   • Resilient: 429 / 5xx exponential-backoff retry, and RESUME — a file that
//     already holds enough bars is skipped (re-run after a partial failure
//     picks up where it left off). Force a full re-pull with --force.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, REPO_ROOT, loadUniverse } from './lib.mjs';

const PROXY_BASE = process.env.BACKTEST_PROXY || 'http://localhost:8000/api/v3';

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const argVal = (k, d) => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const SLEEP_MS = +argVal('sleep', '220');

function getToken() {
  const arg = argv.find((a) => a.startsWith('--token='));
  if (arg) return arg.slice('--token='.length).trim();
  const env = (process.env.UPSTOX_TOKEN || '').trim();
  if (env) return env;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'config.json'), 'utf8'));
    return (cfg.upstox_token || '').trim();
  } catch {
    return '';
  }
}

// TF → Upstox {unit, interval} + how far back. Each pull is a single request
// (no chunking): a multi-year daily/weekly/monthly window returns the full
// series without truncation on the V3 endpoint (verified empirically — an
// 8-yr daily pull returns ~1,980 bars, 9-yr weekly ~470, 9-yr monthly ~109).
const TF_SPEC = {
  '1d': { unit: 'days', interval: '1', yearsBack: 8, minBars: 200 },
  '1w': { unit: 'weeks', interval: '1', yearsBack: 9, minBars: 40 },
  '1mo': { unit: 'months', interval: '1', yearsBack: 9, minBars: 8 },
};

// Nifty 50 only needs daily history (it drives the point-in-time regime).
const NIFTY = { instrumentKey: 'NSE_INDEX|Nifty 50', isin: 'NIFTY50', sym: 'Nifty 50 (regime)', tfs: ['1d'] };

function buildTargets() {
  const { source, stocks } = loadUniverse(false); // raw candidates only
  if (!stocks.length) {
    console.error('No data/backtest/universe.json — run pick-universe.mjs first.');
    process.exit(1);
  }
  console.log(`Universe source: ${source} · ${stocks.length} candidates + Nifty 50`);
  const targets = stocks.map((s) => ({
    instrumentKey: `NSE_EQ|${s.isin}`, isin: s.isin, sym: s.sym, tfs: Object.keys(TF_SPEC),
  }));
  targets.push(NIFTY);
  return targets;
}

function ymd(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch one window, retrying on 429 / 5xx with exponential backoff so a
// transient rate-limit hiccup mid-harvest doesn't lose the whole run.
async function fetchRange(instrumentKey, spec, toDate, fromDate, token) {
  const ikey = encodeURIComponent(instrumentKey);
  const url = `${PROXY_BASE}/historical-candle/${ikey}/${spec.unit}/${spec.interval}/${ymd(toDate)}/${ymd(fromDate)}`;
  const MAX_TRIES = 5;
  let wait = 1000;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let resp;
    try {
      resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    } catch (netErr) {
      if (attempt === MAX_TRIES) throw new Error(`network: ${netErr.message}`);
      await sleep(wait); wait *= 2; continue;
    }
    const body = await resp.text();
    if (resp.ok) {
      let json;
      try { json = JSON.parse(body); } catch { throw new Error(`Non-JSON: ${body.slice(0, 160)}`); }
      return (json && json.data && json.data.candles) || [];
    }
    // Retry the transient classes; fail fast on auth / not-found.
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_TRIES) {
      process.stdout.write(`[${resp.status} retry ${attempt}] `);
      await sleep(wait); wait *= 2; continue;
    }
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 160)}`);
  }
  return [];
}

async function fetchTf(instrumentKey, tf, token) {
  const spec = TF_SPEC[tf];
  const now = new Date();
  const top = new Date(now);
  top.setUTCDate(top.getUTCDate() + 1);
  const from = new Date(now);
  from.setUTCFullYear(from.getUTCFullYear() - spec.yearsBack);
  return await fetchRange(instrumentKey, spec, top, from, token);
}

// Resume guard: a file already holding >= minBars is considered done.
function alreadyHave(isin, tf) {
  if (FORCE) return false;
  const file = path.join(DATA_DIR, `${isin}_${tf}.json`);
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw.candles) && raw.candles.length >= (TF_SPEC[tf]?.minBars ?? 1);
  } catch { return false; }
}

async function main() {
  const token = getToken();
  if (!token) {
    console.error('No Upstox token. Set UPSTOX_TOKEN, pass --token=, or fill data/config.json.');
    process.exit(1);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const targets = buildTargets();

  let done = 0, skipped = 0, failed = 0;
  const failures = [];
  const total = targets.reduce((n, t) => n + t.tfs.length, 0);
  let i = 0;

  for (const t of targets) {
    for (const tf of t.tfs) {
      i++;
      const tag = `[${String(i).padStart(3)}/${total}] ${t.sym.padEnd(14)} ${tf}`;
      if (alreadyHave(t.isin, tf)) { console.log(`${tag} … skip (have)`); skipped++; continue; }
      process.stdout.write(`${tag} … `);
      try {
        const candles = await fetchTf(t.instrumentKey, tf, token);
        const file = path.join(DATA_DIR, `${t.isin}_${tf}.json`);
        fs.writeFileSync(file, JSON.stringify({ isin: t.isin, tf, instrumentKey: t.instrumentKey, fetchedAt: Date.now(), candles }));
        const oldest = candles.length ? String(candles[candles.length - 1][0]).slice(0, 10) : '—';
        const newest = candles.length ? String(candles[0][0]).slice(0, 10) : '—';
        console.log(`${String(candles.length).padStart(5)} bars  [${oldest} → ${newest}]`);
        done++;
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        failures.push(`${t.sym} ${tf}: ${err.message}`);
        failed++;
      }
      await sleep(SLEEP_MS);
    }
  }

  console.log(`\nHarvest: ${done} fetched · ${skipped} skipped · ${failed} failed → data/backtest/`);
  if (failures.length) {
    console.log('Failures (re-run to retry — successes are skipped):');
    for (const f of failures) console.log('  • ' + f);
  }
}

main();
