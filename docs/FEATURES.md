# Trading Studio — Feature Inventory

> **Purpose:** single source of truth for *what* the app does and *why*. Reference doc for debugging, regression checks, and "what changed last week" conversations. Companion to `AGENTS.md` (which covers *where* the code lives, not *what* it does).
>
> **Scope:** the `#live` section (intraday options trading workspace) and everything that feeds it. The 37 educational reference sections (`single`, `double`, `bullish-engulfing`, etc.) are out of scope here.
>
> **Last sync:** 2026-05-25, SW `v396-2026-05-25-engine-debug-panel`.

---

## 0. One-screen architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Upstox V2/V3 REST (candles + LTP + option chain)                │
│   → global throttle gate (back-off on 429)                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ liveChartModule        liveChainModule                          │
│   (Klinecharts +         (option chain + OI bias scorer)        │
│    polling)              ↳ window.optionChainData               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ analyzeTfIntraday(raw, tfKey, levels)   ×4   (1h, 15m, 5m, 3m)  │
│   trend classification (EMA stack + ADX gate + RANGE gates)     │
│   indicators (RSI, ATR, ADX, Supertrend, VWAP, OBV, Stoch)      │
│   pattern detection (engulfing, doji, hammer, …)                │
│   session-bar metrics (rangePts, netPts, directionality, comp.) │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ generateVerdict(an1h, an15, an5, an3, …)                        │
│   per-TF score aggregation → CE score, PE score                 │
│   sessionPhase classifier (PRIME, LATE_PUSH, LUNCH_CHOP, …)     │
│   computeRiskPlan → spot SL / T1 ladder                         │
│   R:R floor veto (< 1.5 ⇒ WAIT)                                 │
│   attachSpotPlan (entry-lock + live drift)                      │
│   → plan { action, scores, spotPlan, premium }                  │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   ┌─────────┐           ┌─────────┐          ┌─────────┐
   │  HUD    │           │ Journal │          │ Bridge  │
   │  Plan   │           │ + stats │          │  +auto- │
   │  Strip  │           │ +refire │          │  trade  │
   │ (DOM)   │           │ cooldown│          │ retry   │
   └─────────┘           └─────────┘          └─────────┘
                                                   │
                                                   ▼
                                            ┌─────────────┐
                                            │paperTrade   │
                                            │Module       │
                                            │(positions,  │
                                            │ EOD square- │
                                            │ off, P/L)   │
                                            └─────────────┘
```

---

## 1. Constants & thresholds (verified against source)

| Constant | Value | File / line | Purpose |
|---|---|---|---|
| `START_CAPITAL` | `100_000` (₹1 L) | `candlestick-patterns.html:6065` | Paper-trade starting capital |
| `LOT_SIZE_NIFTY` | `65` | `candlestick-patterns.html:6066` (also `:22051` as `ANALYZER_LOT_SIZE_NIFTY`) | Nifty 50 lot size (SEBI revised) |
| `MAX_LOTS` | `20` | paper-trade module | Hard cap on lot stepper |
| `EOD_HOUR` / `EOD_MINUTE` | `15` / `25` IST | `candlestick-patterns.html:6071` | Auto square-off cutoff (Mon–Fri) |
| `MIN_RR` | `1.5` | `candlestick-patterns.html:20460` | R:R floor in `generateVerdict`. Below this ⇒ demote to WAIT |
| `MIN_REFIRE_MS` | `20 min` (1.2 M ms) | `candlestick-patterns.html:22636` | Per-direction journal refire cooldown |
| `STALE_EXPIRE_MS` | `8 min` | `candlestick-patterns.html:22520` | Active signal expiry (resets `lastAction` to WAIT) |
| `STALE_ABANDON_MS` | `10 min` | `candlestick-patterns.html:23216` | Signal-freshness band-ageing |
| `COMPRESS_ATR_MULT` | `2.0` | `candlestick-patterns.html:17971` | Range/ATR floor for **compression gate** |
| `ADX gate threshold` | `< 18` | `candlestick-patterns.html:17923` | BULL/BEAR → RANGE if ADX below this |
| `Directionality gate` | `< 0.30` | `candlestick-patterns.html:17998` | net/range floor (oscillation detector) |
| `SESSION_BARS_BY_TF` | `{1h:4, 15m:5, 5m:10, 3m:14}` | `candlestick-patterns.html:17969` | Lookback bars for session-window metrics |
| Pre-market open | `09:15 IST` | `isMarketOpen()` | Mon–Fri |
| Post-market close | `15:30 IST` | `isMarketOpen()` | Mon–Fri |
| Chart poll cadence (open) | `2 s` | `liveChartModule.state.pollIntervalMs` | While market is open |
| Chart poll cadence (closed) | `60 s` | derived | Throttled outside market hours |

---

## 2. Storage keys (localStorage)

| Key | Owner | Shape (top-level) | Notes |
|---|---|---|---|
| `paper_trade_state_v1` | `paperTradeModule` | `{ capital, open[], history[], qtyCE, qtyPE }` | Persists positions across reloads |
| `signal_journal_v2` | `signalJournalModule` | `{ entries[] }` | Each entry: `{id, ts, direction, confidence, spotAtFire, entrySpot, …}` |
| `upstox_token` | `liveChartModule` / API modal | string (bearer) | Daily expiring; user pastes via API modal |
| `cf_worker_url` | API modal (optional) | string URL | CORS proxy for some tokens |
| `paper_bridge_link_v1` | `paperBridgeModule` | `{ entryIdByPosId, autoOn, lots, autoFiredForEntry, autoPendingForEntry, attempts }` | Auto-trade state + last-attempt log |
| `discipline_v1` | `disciplineModule` | `{ lockUntilMs, … }` | Currently bypassed for testing |
| `event_calendar_v1` | event-banner module | array | Cached economic events |
| `alert_settings_v1` | audio-alert module | `{ muted, volume }` | Mute / volume |
| `theme` | shell pre-paint script | `'dark' \| 'light'` | Read sync before paint to avoid FOUC |
| `sidebarCollapsed` | sidebar | `'0' \| '1'` | Collapsed state |
| `engine_debug_open_v1` | engine-debug panel | `'true' \| 'false'` | Diagnostic panel persisted open-state |

---

## 3. UI layer (live page, top → bottom)

### 3.1 Live chart shell
- **Klinecharts v9.8.12** Nifty 50 candle chart (`liveChartModule`), lazy-loaded from unpkg.
- Timeframe switcher: `1m / 3m / 5m / 15m / 30m / 1h / 1d`.
- Drawings, indicators, layouts persisted on chart.
- **Market-open / next-open pill** in header (drives both chart polling cadence and paper-trade gating).
- **API token modal** — paste daily Upstox bearer; saved to `localStorage('upstox_token')`.

### 3.2 Event banner (full-width, below chart)
- Renders for: **gap-up** (open >0.5% above prev close), **gap-down** (open <-0.5%), **expiry day** (Tue weekly / monthly), **rate decision**, etc.
- Neutral info-blue styling — explicitly NOT directional (was bull-green earlier; reverted to avoid implying "GAP UP = BUY").

### 3.3 Engine debug panel (NEW — collapsed by default)
- **Amber-dashed** disclosure widget above HUD (`<details>` element).
- Open state persisted (`engine_debug_open_v1`).
- Sections:
  - **PER-TIMEFRAME** — 4-col grid (1h/15m/5m/3m) showing: `trend`, `trendReason`, `ADX(14)`, `sessionBars`, `rangePts`, `netPts`, `directionality`, `compression`.
  - **PLAN** — `action`, `confidence`, `CE/PE scores`, `sessionPhase`, `spotPlan.entry` (locked), `spotLive`, `drift pts`, `sl`, `t1`, `rrToT1`, premium estimate.
  - **PAPER BRIDGE** — `auto-trade` ON/OFF, `lots`, `open links`, `activeSignal.id`, `lastAttempt` ok/fail + reason.
  - **JOURNAL** — entries total, last BUY_CE/BUY_PE ts + refire countdown.
- Renders on every `renderDecisionHud` cycle (no-op when collapsed).

### 3.4 Decision HUD (the big card)
- **Verdict pill**: BUY CE / BUY PE / WAIT / BLOCKED with confidence chip (HIGH / MED / LOW + %).
- **3-row layout** (CSS grid `grid-template-areas`):
  - Row 1 — STRIKE banner (hero font).
  - Row 2 — ENTRY / SL / T1 triplet (spot-price values; sub-line shows live spot drift under entry).
  - Row 3 — R:R banner.
- All numbers are **spot-based** (Nifty points). Premium is shown as secondary metadata.
- **Entry-lock**: `plan.spotPlan.entry` is seeded once per signal-fire from the 5m close and preserved across `liveTick` calls. Live spot tracked separately as `spotLive` / `spotDriftPts`.
- Veto reasons listed below the verdict when WAIT (e.g. "R:R 0.95 < 1.50", "ADX 12 < 18 on 15m").

### 3.5 Plan card
- **Active plan view** when action is BUY_CE / BUY_PE: setup label, ladder, S/R context, "why now" bullets.
- **WAIT placeholder** with diagnostic chips: live CE / PE scores, current sessionPhase, countdown to next analyze cycle.

### 3.6 Quick Paper Strip
- **BUY / EXIT button** + lots stepper.
- **Live LTP and P/L** updated from option-quote poll.
- **AUTO-TRADE toggle** (mirrored to a second toggle in the journal settings card for persistent visibility).
- All confirms use themed `appConfirm` modal (not native `confirm()`).

### 3.7 Per-TF analyzer cards (1h / 15m / 5m / 3m)
- Card per TF showing: trend (`STRONG_BULL` / `BULL` / `RANGE` / `BEAR` / `STRONG_BEAR`), bias chip, key indicators (RSI, ATR, ADX, Supertrend, VWAP), pattern hits, top scoring bullets.
- RANGE cards show a 0-weight info line with `rangeReasonText()` — e.g. *"15m: RANGE — last 5 bars: net 8 pts in 95-pt range (directionality 0.08)"*.

### 3.8 S/R Levels Ladder
- Auto-discovered support / resistance from historical candles (multi-day lookback).
- Colour-coded rungs: green = support, red = resistance.
- ATM / strike highlighted.

### 3.9 Signal Journal
- Log of every fired signal: `{direction, confidence, spotAtFire, entrySpot, premium snapshot, sessionPhase, mode, …}`.
- Outcome tracking: TAKEN / OBSERVED, then WIN / LOSS / EXPIRED.
- **OBSERVED tooltip** dynamically shows the auto-trade failure reason (`Option chain not loaded yet`, `Signal expired`, `AUTO is OFF`, etc.) sourced from `paperBridgeModule.getLastAttempt(id)`.
- Today's stats row: count, win-rate, avg confidence.

### 3.10 Paper Trading positions table
- Open positions: instrument, qty, entry, LTP, P/L, SL / Target inline-editable (absolute premium prices, not %).
- History: closed positions with exit reason (MANUAL / SL / TGT / EOD).
- Stats strip: equity, total P/L, today's realized P/L.

---

## 4. Engine layer

### 4.1 Indicator library (`candlestick-patterns.html:11199–11580`)

| Indicator | Function | Standard params used |
|---|---|---|
| **EMA** | `ema(values, period)` | 4, 9, 12, 20, 21, 26, 50, 200 (varies by call site) |
| **RSI** | `rsi(closes, 14)` | period 14 |
| **MACD** | derived from EMA | 12 / 26 / 9 |
| **ATR** | `atr(candles, 14)` | period 14 |
| **ADX** | `adx(candles, 14)` | period 14 |
| **Supertrend** | `supertrend(candles, 10, 3)` | period 10, multiplier 3 |
| **Stochastic** | `stochastic(candles, 14, 3, 3)` | %K 14, smooth %K 3, %D 3 |
| **OBV** | `obv(candles)` | cumulative |
| **VWAP** | session VWAP (intraday only) | daily reset |

### 4.2 Trend classification (`analyzeTfIntraday`)

Order of evaluation per TF — first match wins:

1. **EMA stack** — base classification:
   - `close > EMA20 > EMA50 > EMA200` ⇒ `STRONG_BULL`
   - `close > EMA20 > EMA50` ⇒ `BULL`
   - inverse ⇒ `BEAR` / `STRONG_BEAR`
   - otherwise ⇒ `MIXED` / `RANGE`
   - `trendReason = 'EMA_STACK'`

2. **ADX gate** *(NEW)* — if `ADX(14) < 18` AND trend ∈ {BULL, BEAR}:
   - Demote to `RANGE`, `trendReason = 'ADX_LOW_FLUTTER'`.
   - Rationale: low ADX = no trend strength, EMA stack is "fluttering" not trending.

3. **Compression gate** *(NEW)* — if `sessionRangePts / ATR(14) < 2.0`:
   - Demote to `RANGE`, `trendReason = 'COMPRESSION'`.
   - Catches tight consolidation (range smaller than 2 ATRs over the window).

4. **Directionality gate** *(NEW)* — if `|netPts| / rangePts < 0.30`:
   - Demote to `RANGE`, `trendReason = 'POST_TREND_CHOP'`.
   - Catches gap-then-chop scenarios where net displacement is tiny vs. wiggle.

**Window per TF** (`SESSION_BARS_BY_TF`):
- 1h → last 4 bars (~4 h)
- 15m → last 5 bars (~75 min)
- 5m → last 10 bars (~50 min)
- 3m → last 14 bars (~42 min)

### 4.3 Per-TF analyzer output shape

```js
{
  trend: 'STRONG_BULL'|'BULL'|'RANGE'|'BEAR'|'STRONG_BEAR'|'MIXED',
  trendReason: 'EMA_STACK'|'ADX_LOW_FLUTTER'|'COMPRESSION'|'POST_TREND_CHOP'|'DEFAULT_MIXED',
  adx: number, rsi: number, atr: number,
  emaStack: { e20, e50, e200, e9, e21, e4 },
  supertrend: { dir, line },
  vwap: number, vwapDiffPct: number,
  pattern: { name, weight, … } | null,
  sessionBars: number,
  sessionRangePts: number,    // max(high) - min(low) over window
  sessionNetPts: number,       // |last_close - first_close|
  sessionDirectionality: number, // netPts / rangePts (0..1)
  sessionCompression: number,    // rangePts / atr14   (>3 = trending, <2 = tight)
  scoreBull: number, scoreBear: number,
  bullets: [{label, weight, tf}]
}
```

### 4.4 Verdict generation (`generateVerdict`)

Order of operations:

1. Sum per-TF bull/bear scores weighted by TF priority (5m/3m heaviest, 1h lightest for scalp mode).
2. Choose tentative side (higher score).
3. Apply session-phase gating (e.g. NO_NEW = no new entries last 5 min).
4. Apply structural/range vetoes from per-TF `RANGE` info messages.
5. `computeRiskPlan` — picks SL (last swing, ATR-based, or structural) and T1 ladder.
6. **R:R floor veto** *(NEW)* — if `spotPlan.rrToT1 < 1.5` ⇒ demote action to `WAIT`, push veto reason `"Risk-reward is only 1:X.XX … Need at least 1:1.5"`.
7. `attachSpotPlan(plan, spot)` — lock entry, compute SL / T1 in spot points, compute drift fields.

### 4.5 Session phases (`classifySessionPhase`)

| Phase | Window IST | Behaviour |
|---|---|---|
| `WEEKEND` | Sat / Sun | No analysis |
| `PRE_OPEN` | < 09:15 | Show readiness only |
| `OR_FORMING` | 09:15–09:20 | Block new entries (opening range forming) |
| `OR_SETTLED` | 09:20–09:30 | Light scoring |
| `PRIME` | 09:30–11:30 | Full HIGH-confidence scoring |
| `LATE_MORN` | 11:30–12:30 | Full but demoted by 1 step |
| `LUNCH_CHOP` | 12:30–13:30 | SKIP unless very strong |
| `AFTERNOON` | 13:30–14:30 | Full scoring |
| `LATE_PUSH` | 14:30–15:10 | Full HIGH |
| `LATE_SCALP` | 15:10–15:25 | LOW only, very tight SL |
| `NO_NEW` | 15:25–15:30 | No new entries |
| `POST_CLOSE` | > 15:30 | Read-only |

### 4.6 Strike selection
- Default: **ITM-1** (one strike in-the-money from spot).
- Falls back to ATM if ITM-1 not present in chain.
- Spot-side picks PE-ITM-1 for bearish, CE-ITM-1 for bullish.

---

## 5. Paper trading layer

### 5.1 `paperTradeModule`
- State persisted to `paper_trade_state_v1`.
- Position shape includes: `{id, kind:'OPT', side:'BUY', optType:'CE'|'PE', strike, expiry, instrumentKey, qty, entry, entryTs, lastPx, sl, tgt}`.
- **`checkRiskTriggers()`** on every option-price poll — long-premium logic only (`px <= sl` ⇒ exit SL; `px >= tgt` ⇒ exit TGT).
- **`checkEodSquareOff()`** every 30 s — closes everything once IST crosses 15:25 on Mon–Fri. Falls back: `priceFor → lastPx → entry` so a stale poll cannot leave a position stuck.
- **Per-position SL/TGT** edited inline; SL can be raised mid-trade for manual trailing.
- **`pollOptionPrices()`** gated by `shouldPollOptions()` — no API calls outside market hours.

### 5.2 `paperBridgeModule` (NEW behaviour)
- Connects signal-journal entries to paper-trade positions.
- **AUTO-TRADE flow**:
  1. New BUY signal logged → `maybeAutoTrade(entryId)` scheduled.
  2. `autoPendingForEntry[entryId] = true` (re-entry guard).
  3. After 600 ms (chain settle), `take(entryId)` runs.
  4. `take()` returns `{ok: bool, reason: string}`.
  5. On `ok` ⇒ `autoFiredForEntry[entryId] = true` (don't retry).
  6. On `!ok` ⇒ flag stays clear ⇒ next analyze tick retries with current state.
- **`noteAttempt(entryId, ok, reason)`** — appends to a ring buffer per entry, surfaces via `getLastAttempt(entryId)` which the journal's OBSERVED tooltip reads.
- **Failure reasons** captured by `take()`:
  - `"No active BUY signal"`
  - `"Option chain not loaded yet"`
  - `"Signal expired"`
  - `"Already paper-traded this signal"`
  - `"Paper-trade not ready"` (paperTradeModule init not complete)

### 5.3 `signalJournalModule`
- Append-only journal at `signal_journal_v2`.
- Per-direction refire cooldown (`MIN_REFIRE_MS = 20 min`) in `logSignal` — same direction can't log a new entry inside the window.
- `getActiveSignal()` returns the most recent un-resolved entry within `STALE_EXPIRE_MS` (8 min).
- `markTaken(id)` / outcome marking writes back to entry.

### 5.4 Discipline lock (`disciplineModule`)
- **Currently bypassed** for paper-trade testing (you asked for this so signals could be tested without cooling-off blocks).
- Code still in place for future re-enable: daily loss limit, max trades, cooling-off after 2 consecutive losses.

---

## 6. Audio alerts

| Event | Sound | Volume |
|---|---|---|
| New BUY signal | bellNote sequence (apple-note timbre, additive synthesis) | high |
| Direction flip (BUY_CE → BUY_PE or v.v.) | distinct bellSeq | medium-high |
| Reverse-exit suggestion | distinct bellSeq | high |
| Generic tick | quiet beep | low |

- Implemented with **Web Audio API** + additive synthesis (multiple oscillators summed to get bell harmonic content, no samples shipped).
- Mute toggle + volume slider persisted to `alert_settings_v1`.

---

## 7. Supporting modules

### 7.1 Global API throttle gate
- `_upstoxIsThrottled()` / `_upstoxNote429()` — every request first checks the gate; on HTTP 429 the gate opens for an exponentially backed-off cool-off (~5s, 15s, 45s, …).
- All Upstox V2/V3 fetches wrapped: historical candles, intraday candles, LTP batch, option contracts, option chain.
- `silentRefetch()` also updates `state.lastSyncTs` on failure so it doesn't hammer.

### 7.2 `liveChainModule`
- Endpoints: `/v2/option/contract` → nearest expiry; `/v2/option/chain?expiry_date=…`.
- Stores at `window.optionChainData = { spot, strikes }`; notifies paper-trade via `window.ptOnChainLoaded()`.
- `scoreBias(...)` — multi-factor OI bias scorer (asymmetry, size, direction, PCR) drives bias calculator UI.

### 7.3 Bias calculator
- OI bias bucket: STRONG BULL / BULL / NEUTRAL / BEAR / STRONG BEAR.
- Pine-script copy button.

---

## 8. PWA shell

| Aspect | Status |
|---|---|
| Service worker | `sw.js` v396, stale-while-revalidate for same-origin, cache-first for unpkg + fonts, never-cache for api.upstox.com |
| Manifest | `manifest.webmanifest` (root, scope-bound) with maskable icons + shortcuts |
| Icons | 12 PNG variants generated from `scripts/generate-icons.py` (Pillow) |
| Offline fallback | `pwa/offline.html` |
| Lazy content | 37 `content/<id>.html` files fetched on first nav, cached forever (see `AGENTS.md` §16) |
| Lazy CSS | 10 `styles/*.css` files, cascade-ordered (see `AGENTS.md` §17) |
| Mobile reader | `mobile-reader.html` — self-contained build from `scripts/build-mobile-reader.py` |
| Theme | Dark (default) / Light; pre-paint script + `MutationObserver` for chart re-color |

---

## 9. NEW in the last 1–2 days (not yet verified end-to-end on live data)

| # | Change | File / area |
|---|---|---|
| N1 | Engine debug panel | `content/live.html`, `styles/intraday-analyzer.css`, `candlestick-patterns.html` |
| N2 | Spot-first signal architecture (entry/SL/T1 in spot points, premium = metadata) | `attachSpotPlan`, `renderDecisionHud`, journal schema |
| N3 | Entry-lock in `attachSpotPlan` (preserve seeded entry across `liveTick`) | `attachSpotPlan` |
| N4 | Live spot drift fields (`spotLive`, `spotDriftPts`) | `attachSpotPlan`, `renderDecisionHud` |
| N5 | ADX gate (BULL/BEAR → RANGE if ADX < 18) | `analyzeTfIntraday` |
| N6 | Compression gate (range/ATR < 2.0 → RANGE) | `analyzeTfIntraday` |
| N7 | Directionality gate (net/range < 0.30 → RANGE) | `analyzeTfIntraday` |
| N8 | TF-aware session windows (`SESSION_BARS_BY_TF`) | `analyzeTfIntraday` |
| N9 | `trendReason` exposed + `rangeReasonText()` in info bullets | `analyzeTfIntraday`, `addBull`/`addBear` |
| N10 | R:R floor veto (< 1.5 ⇒ WAIT) | `generateVerdict` |
| N11 | Per-direction refire cooldown (20 min) | `signalJournalModule.logSignal` |
| N12 | Bridge retry-on-failure (`autoFiredForEntry` set only after `take()` succeeds) | `paperBridgeModule.maybeAutoTrade` |
| N13 | `take()` returns `{ok, reason}` + `noteAttempt` / `getLastAttempt` | `paperBridgeModule` |
| N14 | Mirrored AUTO-TRADE toggle in journal settings | `content/live.html`, `signalJournalModule` |
| N15 | OBSERVED tooltip with detailed failure reason | `signalJournalModule.buildRowHtml` |
| N16 | 3-row HUD layout (STRIKE banner / Entry-SL-T1 / R:R banner) | `content/live.html`, `styles/intraday-analyzer.css` |
| N17 | Plan-WAIT diagnostic chips (CE/PE scores, phase, countdown) | `renderPlan` |
| N18 | Bell-note synthesis + distinct alert sounds | audio-alert module |
| N19 | Global 429 throttle gate + back-off | wrapped on all Upstox fetches |
| N20 | Themed `appConfirm` modal (replaces native `confirm()`) | shell |

---

## 10. OPEN issues (user-reported, still wrong)

These are the items the user has flagged but we have **not yet confirmed fixed on live data**. The engine debug panel (N1) was added specifically to give us ground-truth values to diagnose these.

| # | Issue | Hypothesis / what we tried | What to verify in debug panel |
|---|---|---|---|
| **O1** | Entry / SL / T1 jitter every second | Added entry-lock (N3); should be stable between 5m closes | Watch `spotPlan.entry` — should be constant, only `spotLive` should tick |
| **O2** | 15m chart looks sideways but engine says "uptrend" | Added ADX (N5) + directionality (N7) + compression (N6) gates | Read 15m row: if ADX≥18 AND directionality≥0.30 AND compression≥2.0 the gate **shouldn't** fire; thresholds may need tuning |
| **O3** | Entry / SL / target ratios don't make sense (R:R < 1) | Added MIN_RR=1.5 floor (N10) | Watch `rrToT1` — must be ≥ 1.50, anything below should demote to WAIT |
| **O4** | Auto-trade not firing, no positions, no P/L | Refactored bridge (N12, N13) + AUTO toggle visibility (N14) | Bridge section: `lastAttempt` will name the exact reason. Common: chain not loaded, signal expired, AUTO off |

---

## 11. Out of scope / explicitly removed

- **SWING mode** — removed 2026-05-24, app is SCALP-only (single-trader, 2–30 min holds).
- **STRUCTURE ROOM pill** — removed 2026-05-24, was SWING-leftover.
- **Trailing SL** — implemented earlier, then removed by user request (manual SL adjustment via inline input covers it).
- **EOD square-off toggle** — explicitly rejected; always-on.
- **Pre-trade SL/TGT % inputs** — replaced with inline absolute-premium prices.
- **BankNifty / Sensex paper trading** — instrument keys exist in chain module but not wired end-to-end. Single-symbol (Nifty 50) only.

---

## 12. Trend Identifier v1 — locked spec (2026-05-25)

> **Status:** Locked. This is the spec being implemented to replace the prior 4-stacked-gate approach (EMA stack + ADX gate + compression gate + directionality gate) that produced false uptrend labels on sideways charts.
>
> **Implementation order:** Phase 0 (this doc) → Phase 1 (foundation) → Phase 2 (engine) → Phase 3 (UI) → Phase 4 (back-test) → Phase 5 (tune).

### 12.1 Design principles

1. **Structure-first.** Higher-Highs + Higher-Lows / Lower-Highs + Lower-Lows decides the trend label. Indicators (EMA, ADX, RSI, VWAP) are *decoration* on each card, **never classifiers**.
2. **One detector, four timeframes.** `classifyStructure()` is applied identically on 1h, 30m, 15m, 5m. Only the per-TF parameters differ — same code path everywhere.
3. **Top-down composition.** Higher TFs set bias; lower TFs decide entry timing. Never the reverse.
4. **Honest WAIT.** When the engine doesn't trade, it tells the user *what's missing and what would need to change*.
5. **Trader-facing rupee math.** Spot points are the engine's truth; ₹ is what the trader thinks in. Both are shown.

### 12.2 Timeframes

| TF | Role |
|---|---|
| **1h** | Day / multi-day context — sets BIAS (with 30m) |
| **30m** | Session swing — confirms BIAS |
| **15m** | Intraday trend — gates ARM (must align with bias + price in value zone) |
| **5m** | Short-term direction + entry trigger |

**3m removed** — too noisy on Nifty index, redundant with 5m. **30m added** — fills the session-swing gap between 15m and 1h.

### 12.3 The classifier (one function, used identically)

```
classifyStructure(bars, swingN, tolATR, freshWin, skipFirstBarsOfDay)
  → { label, swingHighs[3], swingLows[3], bosLevel, freshSwingAge, reason }
```

Per-TF parameters:

| TF | window | swingN | tolATR | freshWin | skipFirstBarsOfDay |
|---|---|---|---|---|---|
| **1h** | 12 bars | 3 | 0.20 | 6 (`swingN+3`) | 1 |
| **30m** | 14 bars | 3 | 0.18 | 6 | 1 |
| **15m** | 16 bars | 3 | 0.15 | 6 | 1 |
| **5m** | 20 bars | 2 | 0.12 | 5 | 2 |

Algorithm:

1. Drop the first `skipFirstBarsOfDay` bars of the current trading day from the window (gap-exclusion — see §12.7 Gap B).
2. Find swing highs and swing lows (a swing = bar whose high/low is greater/lesser than `swingN` bars on each side).
3. Require ≥ 2 swing highs AND ≥ 2 swing lows. If fewer → label `SIDEWAYS`, reason `"insufficient structure"`.
4. Compare last two of each with tolerance:
   - `HH = newHigh > prevHigh + tolATR × cappedATR`
   - `HL = newLow > prevLow + tolATR × cappedATR`
   - (symmetric for `LH` / `LL`)
5. Classify:
   - `HH AND HL` → **UP**, `bosLevel = lastSwingLow`
   - `LH AND LL` → **DOWN**, `bosLevel = lastSwingHigh`
   - anything else → **SIDEWAYS**
6. Compute `freshSwingAge` = bars since most recent swing in bias direction, **measured from the swing candle itself, not the confirmation candle** (see §12.7 Fix 2).

### 12.4 Capped ATR (replaces raw ATR everywhere it sets a distance threshold)

```
cappedATR(tf) = min(rawATR(tf), 1.5 × median20dATR(tf))
```

- **Why:** raw ATR(14) spikes for 14 bars after a single freak bar (gap day, news spike), inflating tolerances and freezing the classifier.
- **Why 1.5× not 1.0×:** absorbs legitimate regime shifts (election week, RBI policy) — only rejects single freak bars.
- **Cache:** `median20dATR` per TF is recomputed lazily on the first `generateVerdict` call of each new IST trading day (compare cached date vs `istDateKey()`; recompute if different). No scheduled job needed.
- **Scope:** use `cappedATR` everywhere ATR enters structural or trade-plan math — tolerance, value-zone bounds on 15m, T1 fill-room on 5m, fresh-swing distance thresholds. Raw ATR is used **only for display** (debug chip "ATR 18.3").

### 12.5 Top-down composition

#### BIAS layer (from 1h + 30m)

| 1h | 30m | Bias |
|---|---|---|
| UP | UP | **UP** (HIGH confluence) |
| UP | SIDEWAYS | UP (weakened — confidence cap MED) |
| UP | DOWN | **SIDEWAYS** (conflict — no trade) |
| SIDEWAYS | * | **SIDEWAYS** (no trade) |
| DOWN | DOWN | **DOWN** (HIGH confluence) |
| DOWN | SIDEWAYS | DOWN (weakened — cap MED) |
| DOWN | UP | **SIDEWAYS** (conflict — no trade) |

If bias = SIDEWAYS → **WAIT** regardless of 15m/5m. (No counter-bias trades in v1.)

#### ARM layer (15m gate)

Three conditions, all required:

1. `15m.label == bias`
2. **Value zone check** — `spot` is in pullback territory:
   - UP: spot ∈ `[EMA20(15m) − 0.5 × cappedATR(15m), EMA20(15m) + 0.3 × cappedATR(15m)]` OR within `0.3 × cappedATR` of VWAP
   - DOWN: symmetric
3. **Fallback for trending days** — value-zone check is bypassed only when BOTH are true:
   - 15m has been bias-aligned for ≥ 3 consecutive bars
   - **`ADX(15m) ≥ 25`** (matches STRONG ADX tier — see §12.6)

**ADX(15m) chip** (confidence cap, not gate):

| ADX | Chip | Confidence cap |
|---|---|---|
| ≥ 25 | STRONG | HIGH allowed |
| 18–25 | TRADEABLE | cap MED |
| < 18 | WEAK | cap LOW |

#### TRIGGER layer (5m gate)

Three conditions, all required:

1. `5m.label == bias`
2. **Fresh micro-swing in bias direction:** `freshSwingAge ≤ freshWin (5)` AND the freshest swing is in the bias direction
3. **EMA20 confirmation:** current 5m close on the correct side of EMA20(5m)

When all three → **FIRE**.

#### TRADE PLAN (auto-derived from structure)

```
Entry = 5m trigger close (current spot)
SL    = 5m.bosLevel                    (= last 5m swing low/high — also the kill level)
T1    = 15m.lastSwingHigh − 0.5 × cappedATR(5m)   (UP, "fill room")
T2    = 30m.lastSwingHigh − 0.5 × cappedATR(5m)   (stretch)
rrT1  = (T1 − Entry) / (Entry − SL)
```

**R:R floor 1.5:**
- If `rrT1 ≥ 1.5` → use structural T1
- If `rrT1 < 1.5` → stretch T1 to `Entry + 1.5 × (Entry − SL)`
- If even structural T2 falls short of 1.5 → **SKIP signal** (room too tight today)

### 12.6 Confidence tiers (descending cap, downgrade for each caveat)

| Tier | Conditions |
|---|---|
| **HIGH** | 1h+30m both labeled bias (no SIDEWAYS), 15m ARMED in value zone, 5m TRIGGER clean, ADX(15m) ≥ 25, rrT1 ≥ 2.0, macro-aligned |
| **MED** | bias OK (one may be SIDEWAYS), 15m ARMED (zone or fallback), 5m TRIGGER, ADX ≥ 18, rrT1 ≥ 1.5 |
| **LOW** | gates pass with caveats: extended price, weak ADX, counter-macro, rrT1 exactly 1.5 |
| **WAIT** | any required gate fails |

Caveat caps:
- Counter-macro (signal direction ≠ EMA200(1h) regime) → cap MED + warning chip
- ADX(15m) < 18 → cap LOW
- Extended price (outside value zone AND no fallback) → cap LOW

### 12.7 Fixes & gaps (engineering details)

#### Fix 1 — Capped ATR everywhere (see §12.4)

#### Fix 2 — Swing bar counting from the swing itself

`bars_since_swing` is measured from the actual swing candle, **not** from the confirmation candle. A swing high formed at bar 10 with `swingN=2` is confirmed at bar 12 — but its age is `currentBar − 10`, not `currentBar − 12`.

Compensating: the fresh-swing window is `swingN + 3` per TF (§12.3 table), so at the moment of confirmation a freshly-confirmed swing is already `swingN` bars old but still well within window.

#### Fix 3 — ARM fallback ADX guard

Already documented in §12.5 ARM layer.

#### Fix 4 — 1h BOS state machine

Engine has two states: `NORMAL` | `MANUAL_REVIEW`, persisted to `localStorage('engine_mode_v1')`.

**Entry into MANUAL_REVIEW:**
- 1h close breaches `1h.bosLevel` → emit audio alert → set `engineMode = MANUAL_REVIEW`
- **Intrabar 1h BOS** also enters MANUAL_REVIEW immediately (safety asymmetry — see §12.7 Gap A)

**While in MANUAL_REVIEW:**
- No new signals (skip `generateVerdict` body)
- No ARM / no TRIGGER
- Existing open positions still managed (SL, EOD square-off, manual exit all work)
- UI shows prominent red banner: *"1h regime change detected — Bias INVALID. Review 1h chart and reset to continue."*
- Reset button visible with themed confirm modal

**Reset criteria** (operator action only — never automatic):
- Operator reviews 1h chart and confirms one of:
  - new HH+HL or LH+LL forming on the post-breach side, OR
  - clean reversal back to prior direction, OR
  - consolidation clear enough to continue cautiously
- Operator clicks Reset → confirm modal → `engineMode = NORMAL`

**Optional guidance helper** (not auto-reset):
- After 2 new 1h bars close with valid structure post-breach, banner text auto-updates to: *"Review READY — new structure visible, you may reset"*
- Still requires explicit operator click

#### Fix 5 — Startup data per TF

| TF | Bars | History |
|---|---|---|
| 1h | 120 | ~20 trading days |
| 30m | 120 | ~10 trading days |
| 15m | 120 | ~5 trading days |
| 5m | 80 | ~1 trading day |

Without this, structure detection has insufficient swings at market open — bias would be SIDEWAYS for the first 2–3 hours every day.

#### Gap A — Bar-close synchronization (closed bars only)

`classifyStructure` runs on **confirmed/closed bars only** — never the live in-progress bar. Each TF uses its most recently closed bar at the moment `generateVerdict` runs (e.g. at 11:23 IST: 5m=11:20 close, 15m=11:15 close, 30m=11:00 close, 1h=11:00 close).

**Prevents** structure labels from flickering as the live bar's high/low expands during its life.

**BOS asymmetry**:
- Intrabar 1h BOS → MANUAL_REVIEW immediately (safety wins)
- New signals → bar close only (conservative entry)

#### Gap B — Overnight gap exclusion

Skip the first N bars of each trading day from swing detection on every intraday TF:

| TF | Bars skipped | Swing detection starts |
|---|---|---|
| 5m | first 2 | 09:25 |
| 15m | first 1 | 09:30 |
| 30m | first 1 | 09:45 |
| 1h | first 1 | 10:15 |

Reason: the first bar of each session absorbs the overnight gap into its range, creating false HH / LL signals against prior-session bars. Aligns naturally with existing `OR_FORMING` / `OR_SETTLED` session phases.

### 12.8 Trader-facing UI additions

Three small additions on top of the engine rewrite, chosen because they directly answer questions the trader is asking in front of the screen.

#### TUA-1 — Risk in ₹ on the HUD

Under the Entry / SL / T1 row, display rupee outcomes at the current lot setting:

```
Risk: −₹2,400   Reward: +₹3,600
3 lots × 65 qty × Δpts × delta(0.55)
```

Trader thinks in ₹, not points. One line of arithmetic using fields already computed (`Entry−SL`, `T1−Entry`, current lots, `LOT_SIZE_NIFTY`, ATM delta ≈ 0.55 for ITM-1, ≈ 0.35 for OTM-1).

#### TUA-2 — WAIT diagnostic with action checklist

Replace the existing generic WAIT chips with a structured "**Waiting for**" checklist:

```
WAITING FOR (in priority order):
  ✓ 1h bias = UP
  ✓ 30m bias = UP
  ✗ 15m structure ≠ UP (currently SIDEWAYS — needs HH+HL)
  ✗ 5m no fresh swing yet
Earliest next check: 11:15 IST (next 15m bar close)
```

Teaches the user what to watch for. All fields already computed during the verdict cycle.

#### TUA-3 — Daily ribbon at top of `#live`

Always-visible compact line above the chart:

```
TODAY · 3 trades · 2W 1L · ₹+4,200 · DDL: ₹15,000 remaining · phase: PRIME
```

Keeps the trader grounded in P&L + risk-budget without scrolling to the journal. Uses existing journal stats + session-phase + (future) discipline-module daily-loss-limit. DDL placeholder shows "—" if discipline module is bypassed (current state).

### 12.9 Deletions (in v1 push)

- EMA stack as classifier (`STRONG_BULL = close > EMA20 > EMA50 > EMA200`)
- ADX < 18 gate
- Compression gate (`range/ATR < 2.0`)
- Directionality gate (`net/range < 0.30`)
- `sessionCompression`, `sessionDirectionality`, `sessionBars`, `trendReason`, `rangeReasonText()`
- 3m TF analyzer (3m remains available in chart TF switcher)
- `addBull/addBear` weighted score aggregation
- ATR-based SL fallback (replaced by structural SL)

**Net delta:** ~400 LOC removed, ~250 LOC added.

### 12.10 Retentions

- All indicator math (ema, rsi, atr, adx, supertrend, vwap, stoch, obv)
- `liveChainModule`, `paperTradeModule`, `paperBridgeModule`
- Signal journal + 20-min refire cooldown + 8-min stale expiry
- Engine debug panel (new fields, same shell)
- Strike selection (ITM-1)
- Session phase classifier (still gates NO_NEW / OR_FORMING)
- Spot-first signals (all numbers in Nifty points)

### 12.11 Back-test view (Phase 4 — verification tool only)

Separate sub-section on `#live`. **No P&L, no R:R, no option pricing** — purely visual verification that `classifyStructure` agrees with the trader's eye on historical data.

**Inputs:** TF selector (1h / 30m / 15m / 5m), lookback selector (5 / 15 / 30 days), Run button, 3 tuning knobs per TF (window / swingN / tolATR).

**Output:**
- Klinecharts overlay: colored strip below candles (UP green / DOWN red / SIDEWAYS grey), triangles at detected swings (▼ swing highs red, ▲ swing lows green), horizontal line at current `bosLevel`
- Stats panel: % bars per label, avg run length per label, total flips, flips/day

**Use:** scroll history, eyeball where labels disagree with the chart, nudge knobs, re-run. 5-min iteration loop.

### 12.12 Open limitations (be honest)

1. **No counter-bias / reversal trades** in v1. If 1h has been UP all day and a real reversal forms, engine waits until 1h structure flips (could be hours). v2 candidate.
2. **First leg of trends missed.** Need ≥ 2 swings per TF — costs ~10–15 min at trend start.
3. **No real volume on Nifty index** — intentionally absent. Nifty Futures volume could be added separately later.
4. **Parameters (window, swingN, tolATR) hard-coded** — tunable via backtest knobs but not exposed in main UI.

### 12.13 Build order

| Phase | Work | File(s) |
|---|---|---|
| 0 | This spec | `docs/FEATURES.md` |
| 1a | `cappedATR()` + daily `median20dATR` cache | `candlestick-patterns.html` |
| 1b | `classifyStructure()` pure function | `candlestick-patterns.html` |
| 1c | 30m TF fetch + remove 3m analyze + startup bars | `candlestick-patterns.html`, `liveChartModule` |
| 2a | Rewrite `generateVerdict` (BIAS → ARM → TRIGGER → PLAN) | `candlestick-patterns.html` |
| 2b | Structural trade plan + R:R floor stretch/skip | `candlestick-patterns.html` |
| 2c | MANUAL_REVIEW state machine + persistence + BOS asymmetry | `candlestick-patterns.html` |
| 2d | Delete dead code | `candlestick-patterns.html` |
| 3a | Per-TF cards (structure + chips) + macro/caveat chips | `content/live.html`, `styles/intraday-analyzer.css`, `candlestick-patterns.html` |
| 3b | MANUAL_REVIEW banner + reset modal | `content/live.html`, `styles/`, `candlestick-patterns.html` |
| 3c | Engine debug panel update | `candlestick-patterns.html` |
| 3d | TUA-1: Risk in ₹ on HUD | `content/live.html`, `candlestick-patterns.html` |
| 3e | TUA-2: WAIT diagnostic checklist | `content/live.html`, `candlestick-patterns.html` |
| 3f | TUA-3: Daily ribbon | `content/live.html`, `styles/`, `candlestick-patterns.html` |
| 4 | Trend Backtest view | `content/live.html`, `styles/`, `candlestick-patterns.html` |
| — | Bump `CACHE_VERSION` (single bump after Phase 3) | `sw.js` |
| 5 | User-driven tune & verify on live data | — |

---

*This document is a snapshot. When a feature is added, removed, or changed materially, update the relevant section AND `AGENTS.md` §10 (recent feature history). Bump SW `CACHE_VERSION` after any user-visible change.*
