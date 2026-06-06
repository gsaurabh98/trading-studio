// Shared helpers for the swing backtest harness.
//
// Two responsibilities:
//   1. loadSwingExports() — load scripts/swing-analyzer.js in a Node vm
//      sandbox with minimal window/document/localStorage shims, set
//      window.__SWING_TEST__ so the guarded test hook publishes the
//      closure-private analyzeTf + generatePlan, and return them. This is
//      the ONLY way the backtest reuses the EXACT live verdict logic
//      (no reimplementation → zero signal drift, per the trading rules).
//   2. Candle plumbing — Upstox returns candles newest-first as
//      [ts, o, h, l, c, v, oi]. Helpers here slice to a point-in-time
//      cursor WITHOUT lookahead and drop still-forming higher-TF bars.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const DATA_DIR = path.join(REPO_ROOT, 'data', 'backtest');
const SWING_SRC = path.join(REPO_ROOT, 'scripts', 'swing-analyzer.js');
// Pure TA library extracted out of swing-analyzer.js (2026-06-05, AGENTS.md
// §18). Must run in the sandbox BEFORE swing so window.IndicatorMath exists
// when swing's closure-local alias block binds it.
const INDICATOR_MATH_SRC = path.join(REPO_ROOT, 'scripts', 'indicator-math.js');

/**
 * Load swing-analyzer.js inside a vm sandbox and return its test exports.
 * @returns {{ analyzeTf: Function, generatePlan: Function, ema: Function,
 *             sma: Function, atr: Function, adx: Function }}
 */
export function loadSwingExports() {
  const indicatorMathCode = fs.readFileSync(INDICATOR_MATH_SRC, 'utf8');
  const code = fs.readFileSync(SWING_SRC, 'utf8');

  // Minimal DOM/storage shims. The module's top-level IIFE touches
  // document.getElementById, localStorage, console and (only inside the
  // hook) window. None of the indicator math or generatePlan needs a real
  // DOM, so stubs that return null/no-op are enough to evaluate the file.
  const noop = () => {};
  const storage = new Map();
  const elementStub = new Proxy(
    { style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      addEventListener: noop, removeEventListener: noop, appendChild: noop,
      setAttribute: noop, getAttribute: () => null, querySelector: () => null,
      querySelectorAll: () => [], insertAdjacentHTML: noop, focus: noop, remove: noop },
    { get(t, k) { return k in t ? t[k] : noop; }, set() { return true; } }
  );
  const documentStub = {
    readyState: 'complete',
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => elementStub,
    addEventListener: noop,
    removeEventListener: noop,
    body: elementStub,
    documentElement: elementStub,
  };
  const windowStub = {
    __SWING_TEST__: true,
    addEventListener: noop,
    removeEventListener: noop,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, addListener: noop }),
    location: { hostname: 'localhost', href: 'http://localhost/' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
  };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    localStorage: windowStub.localStorage,
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    fetch: () => Promise.reject(new Error('network disabled in backtest sandbox')),
    navigator: { userAgent: 'node-backtest' },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = windowStub;

  vm.createContext(sandbox);
  vm.runInContext(indicatorMathCode, sandbox, { filename: 'indicator-math.js' });
  vm.runInContext(code, sandbox, { filename: 'swing-analyzer.js' });

  const exp = windowStub.__swingExports;
  if (!exp || typeof exp.analyzeTf !== 'function' || typeof exp.generatePlan !== 'function') {
    throw new Error(
      'swing-analyzer.js did not publish window.__swingExports — is the ' +
      'guarded test hook present and __SWING_TEST__ set before load?'
    );
  }
  return exp;
}

// ── Candle helpers ────────────────────────────────────────────────
// Upstox candle row: [tsISO, open, high, low, close, volume, oi]

/** Epoch ms for a candle row's timestamp. */
export function candleMs(row) {
  return new Date(row[0]).getTime();
}

/** Sort candles oldest→newest (chronological). Returns a new array. */
export function sortAsc(candles) {
  return candles.slice().sort((a, b) => candleMs(a) - candleMs(b));
}

/**
 * Slice a chronological candle array to only bars whose timestamp is at or
 * before `asOfMs` — i.e. "what the analyzer could legitimately see at the
 * close of as-of day D". No lookahead.
 *
 * `dropFormingBefore`: for higher timeframes (weekly/monthly) the bar that
 * CONTAINS asOfMs is still forming intraperiod, so including it would leak
 * future information (repainting). When true we drop any bar whose period
 * has not fully closed by asOfMs. We approximate "fully closed" as: the
 * NEXT bar's start exists in the series and is <= asOfMs+epsilon, OR the bar
 * is strictly older than asOfMs by at least one period. The simplest safe
 * rule, given Upstox stamps a weekly/monthly bar at its period START, is to
 * keep a higher-TF bar only if the FOLLOWING bar's timestamp is also <=
 * asOfMs (proving this bar's period has ended) — except we can't see the
 * following bar near the cursor, so we instead require the bar's own start
 * to be < the start of the period containing asOfMs.
 */
export function sliceAsOf(candlesAsc, asOfMs, dropForming = false, periodMs = 0) {
  const kept = [];
  for (const row of candlesAsc) {
    const ms = candleMs(row);
    if (ms > asOfMs) break;
    kept.push(row);
  }
  if (!dropForming || periodMs <= 0 || kept.length === 0) return kept;
  // Drop the last bar if its period still contains asOfMs (i.e. it has not
  // closed yet). A bar starting at `start` closes at `start + periodMs`.
  const last = kept[kept.length - 1];
  const lastStart = candleMs(last);
  if (lastStart + periodMs > asOfMs + 1) {
    // The period that this bar represents extends beyond asOf → it is the
    // still-forming current bar. Remove it so we only feed CONFIRMED bars.
    kept.pop();
  }
  return kept;
}

/** Approximate period length in ms for a TF key (for the forming-bar drop). */
export const PERIOD_MS = {
  '1mo': 30 * 86400000,
  '1w': 7 * 86400000,
  '1d': 86400000,
  '1h': 3600000,
};

/**
 * Point-in-time market regime, replicating fetchMarketRegime() exactly
 * (SMA-50 of Nifty daily closes + 5-session slope) but on a sliced history.
 * Returns null when fewer than 55 confirmed daily closes exist (same floor
 * the live code uses), so generatePlan falls back to "regime unknown".
 */
export function computeRegimeAsOf(niftyDailyAsc, asOfMs) {
  const sliced = sliceAsOf(niftyDailyAsc, asOfMs, true, PERIOD_MS['1d']);
  if (sliced.length < 55) return null;
  const closes = sliced.map((x) => +x[4]);
  const n = closes.length;
  const lastClose = closes[n - 1];
  let sum50 = 0;
  for (let i = n - 50; i < n; i++) sum50 += closes[i];
  const dma50 = sum50 / 50;
  let sum50Prev = 0;
  for (let j = n - 55; j < n - 5; j++) sum50Prev += closes[j];
  const dma50Prev = sum50Prev / 50;
  const slopePct = dma50Prev > 0 ? ((dma50 - dma50Prev) / dma50Prev) * 100 : 0;
  const aboveDma = lastClose > dma50;
  let regime;
  if (aboveDma && slopePct > 0) regime = 'BULL';
  else if (!aboveDma && slopePct < 0) regime = 'BEAR';
  else regime = 'NEUTRAL';
  return {
    regime,
    lastClose,
    dma50,
    distPct: ((lastClose - dma50) / dma50) * 100,
    slopePct,
    recentCloses: closes.slice(-21),
  };
}

/**
 * Precompute the point-in-time regime at EVERY Nifty daily bar once, then
 * answer regime(asOfMs) in O(log n) via binary search for the latest confirmed
 * Nifty close ≤ asOfMs. The regime is identical across all stocks for a given
 * date, so recomputing it per-cursor-per-track (computeRegimeAsOf is O(n)) was
 * pure waste; this collapses ~millions of O(n) calls into one O(n²) prepass.
 * Result is byte-identical to calling computeRegimeAsOf(niftyAsc, asOfMs).
 */
export function buildRegimeLookup(niftyDailyAsc) {
  const ms = niftyDailyAsc.map((b) => candleMs(b));
  const regimes = niftyDailyAsc.map((b) => computeRegimeAsOf(niftyDailyAsc, candleMs(b)));
  return function regimeAsOf(asOfMs) {
    // largest index with ms[idx] <= asOfMs
    let lo = 0, hi = ms.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ms[mid] <= asOfMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return idx < 0 ? null : regimes[idx];
  };
}

/** Read a harvested candle file: { isin, tf, candles: [...] }. */
export function readHarvest(isin, tf) {
  const file = path.join(DATA_DIR, `${isin}_${tf}.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw.candles) ? raw.candles : null;
}

/**
 * Load the backtest universe — the single source of truth both runners read so
 * the engines test the SAME stratified, liquidity-trimmed list (no hand-picked
 * subset that could flatter results).
 *   • Prefers universe-final.json (post liquidity trim) when present.
 *   • Falls back to universe.json (raw candidates from pick-universe.mjs).
 * Returns [{ isin, sym, sector }] or [] if neither file exists.
 */
export function loadUniverse(preferFinal = true) {
  const order = preferFinal ? ['universe-final.json', 'universe.json'] : ['universe.json'];
  for (const name of order) {
    const f = path.join(DATA_DIR, name);
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const stocks = (j.stocks || []).map((s) => ({
      isin: s.isin, sym: s.sym, sector: s.sector || s.sectorName || '',
    }));
    return { source: name, stocks };
  }
  return { source: null, stocks: [] };
}
