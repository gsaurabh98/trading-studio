# Candlestick Patterns in the App

A reference for **which candlestick patterns the app detects**, how they're
**tiered by reliability**, and **which ones are drawn on the swing chart**.

- **Detection engine:** `detectPatterns(candles, trend)` in
  [`scripts/swing-analyzer.js`](../scripts/swing-analyzer.js) (priority-ordered
  classifier, ~line 4422). All the `is*` shape helpers live just above it.
- **Chart overlay:** `drawPatternMarkers(candleSeries, raw, tf)` in the same
  file (~line 11953), called from `renderMainChart` on every stock select /
  timeframe switch. **Only Tier 1 is plotted** (see below).
- **Everything detected** (all tiers) still feeds the verdict/scoring engine
  internally even when it isn't drawn — e.g. a pattern *at support* boosts a
  BUY setup. The tiers below only describe **what gets a marker on the chart**,
  not what the engine "knows".

---

## Categories at a glance

- **Tier 1** (plotted on chart) — Bullish Engulfing, Bearish Engulfing,
  Morning Star, Morning Doji Star, Evening Star, Evening Doji Star, Hammer,
  Shooting Star, Three White Soldiers, Three Black Crows,
  Piercing Pattern, Dark Cloud Cover, Dragonfly Doji, Gravestone Doji.
- **Tier 2** (detected, not plotted) — Tweezer Bottom, Tweezer Top,
  Bullish Marubozu, Bearish Marubozu.
- **Tier 3** (context only, not plotted) — Inverted Hammer, Hanging Man,
  Bullish Harami, Bearish Harami.
- **Compression** (orthogonal — reported alongside a bull/bear pattern) —
  Inside Bar, NR4.
- **Neutral Doji** (informational; surfaces in "SKIP IF") — Doji.

---

## Tier 1 — Plotted on the chart (high reliability)

These are the only patterns that get an arrow marker. Chosen because they have
real standalone edge for swing trading, especially **at a support/resistance
level with follow-through**.

| Pattern | Bars | Direction | Marker |
|---|---|---|---|
| Bullish Engulfing | 2 | Bullish | green `arrowUp`, below bar |
| Bearish Engulfing | 2 | Bearish | red `arrowDown`, above bar |
| Morning Star | 3 | Bullish | green `arrowUp`, below bar |
| Morning Doji Star | 3 | Bullish | green `arrowUp`, below bar — Star with a true **doji** middle (stronger) |
| Evening Star | 3 | Bearish | red `arrowDown`, above bar |
| Evening Doji Star | 3 | Bearish | red `arrowDown`, above bar — Star with a true **doji** middle (stronger) |
| Hammer | 1 | Bullish | green `arrowUp`, below bar |
| Shooting Star | 1 | Bearish | red `arrowDown`, above bar |
| Three White Soldiers | 3 | Bullish | green `arrowUp`, below bar |
| Three Black Crows | 3 | Bearish | red `arrowDown`, above bar |
| Piercing Pattern | 2 | Bullish | green `arrowUp`, below bar — "almost engulfing" (close past prev midpoint) |
| Dark Cloud Cover | 2 | Bearish | red `arrowDown`, above bar — bearish mirror of Piercing |
| Dragonfly Doji | 1 | Bullish | green `arrowUp`, below bar — doji with long lower wick (≥60% of range), ~no upper wick: a "pure" Hammer |
| Gravestone Doji | 1 | Bearish | red `arrowDown`, above bar — doji with long upper wick (≥60% of range), ~no lower wick: a "pure" Shooting Star |

Marker colors match the candles: bull `#09a86e`, bear `#c91f3a`. Every Tier-1
shape on a closed bar is *detected*; what's **drawn** depends on the history
toggle (see below) — by default only the most-recent few arrows render so the
chart isn't buried under dozens of labels.

**History toggle (chart + cards in lock-step).** Default OFF: the chart markers
**and** the cards show only the latest `PATTERN_CARD_MAX` (4) patterns. The
"Show history (N more)" chip in the cards header reveals **every** detected
pattern on both the chart and the cards; "Hide history" collapses back to the
recent few. State persists in `localStorage` (`sw_candle_history_v1`) and
`window.swToggleCandleHistory()` re-renders the chart so both paths update
together. This is detection-neutral — nothing changes *which* patterns are
found, only how many are shown at once. Mirrors the geometric chart-pattern
history toggle (`scripts/chart-patterns.js`).

**Confluence emphasis (ranking, not filtering):** an arrow that lands on a
level the chart already trusts is drawn **darker + larger + with a leading
`★`** so the high-probability setups stand out; arrows in open space stay
plain. Nothing is hidden — this only *ranks* what's already shown.

- **Bull** reversal is emphasised when its wick-inclusive range touches a
  **DEMAND zone** (`detectZones`) **or** the **Fib golden pocket** (61.8%–80%,
  the long-entry band) — **but** the golden-pocket emphasis is demoted when
  price is **falling through** the pocket (`computeFibZone` reports
  `fibDirection`/`bounceStatus` = `FALLING`). A hammer mid-collapse inside the
  61.8–80% band is the classic *false* long, so it stays a **plain** arrow
  (no `★`) rather than being highlighted as high-probability.
- **Bear** reversal is emphasised when it touches a **SUPPLY zone**.
- Levels are the *current* ones (same `detectZones` / `computeFibZone` the
  overlays use), so a past arrow's emphasis reflects today's zones and can
  change as zones evolve. The arrow's **existence** is still anchored on
  confirmed bars only (no-repaint); only the cosmetic emphasis is dynamic.
- Strong shades: bull `#067a4f`, bear `#9e1730`.

**Robustness guards on the overlay:**

- **No repainting** — the live/forming bar is never marked while the market is
  open (and is also skipped if market state is unknown — fail-safe).
- **Per-bar local trend** (the recent *swing into* the bar — close now vs ~5
  confirmed bars earlier, needing a ≥0.5% net rise to read "uptrend") decides
  Hammer vs Hanging Man and Inverted Hammer vs Shooting Star. This replaced an
  earlier `close > 50-EMA` proxy, which mislabeled bottoming hammers right
  after a sharp sell-off as Hanging Man — the slow 50-EMA lags and still sits
  below price just after a crash, so a genuine reversal hammer was suppressed.
  A hammer needs a **down-swing** into it; a hanging man needs an **up-swing**.

### Pattern cards (below the chart)

The most-recent Tier-1 patterns also render as **clickable cards** in the
"Zone & Signal Analysis" panel below the chart (`#sw-pattern-cards`).

- Driven by the **same** classifier (`collectTier1Patterns`) the chart arrows
  use — no second, drifting implementation.
- **Cards follow the Recommendation Timeframe control** (`swGetRecoTf`), NOT
  the chart's TF buttons. Switching the chart picture never changes the cards;
  only the reco-TF control does. (The chart arrows still follow the chart TF.)
- Works for **every** reco TF (1M / 1W / 1D / 4H / 1H / 30m / 15m / 5m); the
  reco TF's candles are lazy-loaded if not already cached.
- Shows the **latest + previous 3** patterns (newest first), capped at 4 — or
  **all** detected patterns when "Show history" is on (see the history toggle
  above). The chart markers honour the same cap, so cards ↔ arrows stay 1:1.
- Each card states the **pattern**, a **direction tag** (Bullish / Bearish), an
  **outcome badge** (see below), a **location verdict** (`At demand zone` /
  `In Fib golden pocket` / `Golden pocket — falling` ⚠ / `At supply zone` /
  `Open space`), and a **plain-English action**; the `title` tooltip carries
  the full definition + meaning + outcome + bar date.

#### Outcome label (did the reversal play out?)

Same philosophy as the geometric chart patterns (`docs/chart-patterns.md`):
**keep every pattern visible, but LABEL whether it worked — never drop**
(dropping hides losses and makes the labelling impossible to validate by eye →
survivorship bias). A single reversal candle has no neckline, so it's judged the
way a trader would actually size the trade, in `candleOutcome(i, dir)` inside
`collectTier1Patterns`:

- **STOP** = the formation's own extreme — the lowest low of the 1–3 signal bars
  for a bull reversal, the highest high for a bear. A **close** beyond it means
  the reversal was rejected.
- **TARGET** = **2R** measured from the signal close (`entry`), where
  `R = |entry − stop|`. 2:1 is the conservative swing-trade minimum reward and
  **self-scales** to the candle's own volatility (a tiny doji and a wide
  engulfing are judged proportionally — no fixed point/percent threshold).
- Judged **close-based** on the **confirmed** bars *after* the signal
  (no repaint). First close to breach either level wins:

| Badge | Meaning |
|---|---|
| `LIVE` (info) | In play — neither target nor stop closed through yet (the freshest patterns) |
| `✓ WORKED` (green) | Target reached first — the move paid out |
| `✗ FAILED` (red) | Stop closed through first — reversal rejected (card is greyed + name struck-through) |

Because the **default view shows only the recent few** (history toggle OFF), most
visible cards read `LIVE`; flip **Show history** to surface the `✓ WORKED` /
`✗ FAILED` audit trail and eyeball the hit-rate. The badge is detection-neutral —
it never changes *which* patterns are found, only annotates what happened after.
- **Aligned** setups (bull @ demand / valid pocket, bear @ supply) get a
  tinted, accented card matching the chart `★`; a bull **falling through** the
  pocket gets an **amber caution** card ("NOT a confirmed long").
- **Click a card** → the chart switches to the card's (reco) TF if needed and
  centres on that bar (`window.swFocusPatternBar(idx, tf)`).
- Inherits the no-repaint guard (the forming bar is never carded).

---

## Tier 2 — Detected, NOT plotted (useful with confluence)

Real signals, but weaker / noisier than Tier 1 — they need trend + location +
volume backing to trust. The engine uses them; the chart does not mark them.

| Pattern | Bars | Direction | Notes |
|---|---|---|---|
| Tweezer Bottom | 2 | Bullish | twin lows at a tested level |
| Tweezer Top | 2 | Bearish | twin highs at a tested level |
| Bullish Marubozu | 1 | Bullish (continuation) | full body, no wicks — momentum, fires constantly in trends (noise if plotted) |
| Bearish Marubozu | 1 | Bearish (continuation) | full body, no wicks — momentum, fires constantly in trends (noise if plotted) |

---

## Tier 3 — Detected, NOT plotted (context only)

Low standalone edge. Useful as background context, not as triggers. The engine
already treats some of these as "needs more confirmation" or surfaces them in
"SKIP IF" notes.

| Pattern | Bars | Direction | Notes |
|---|---|---|---|
| Inverted Hammer | 1 | Bullish (weak) | engine penalizes it vs strong patterns |
| Hanging Man | 1 | Bearish | Hammer shape at top of an uptrend |
| Bullish Harami | 2 | Bullish (early) | momentum stalling, not a reversal yet |
| Bearish Harami | 2 | Bearish (early) | momentum stalling, not a reversal yet |

---

## Compression — Detected, NOT plotted (orthogonal)

No directional bias — "wait for the break" setups. Reported *alongside* any
bull/bear pattern (a bar can be both), not instead of it.

| Pattern | Bars | Direction | Notes |
|---|---|---|---|
| Inside Bar | 2 | Neutral (compression) | "coiling, breakout pending" |
| NR4 | 4 | Neutral (compression) | narrowest range of last 4 bars |

---

## Neutral Doji — Detected, NOT plotted (informational)

| Pattern | Bars | Direction | Notes |
|---|---|---|---|
| Doji | 1 | Neutral | indecision; surfaces in "SKIP IF" |

---

## Implemented — exact detection formulas

The precise rule each `is*` helper in [`scripts/swing-analyzer.js`](../scripts/swing-analyzer.js)
applies, plus whether it matches the standard market definition (Steve Nison,
*Japanese Candlestick Charting Techniques*; Thomas Bulkowski, *Encyclopedia of
Candlestick Charts*). Notation: `body = |close − open|`, `range = high − low`,
`body%` = `body / range`, wick fractions are of `range`. **Standard?** flags
whether the *shape rule* is canonical; the exact numeric cut-offs are
conservative engineering choices (no single universal number exists) and are
easy to tune at the helper.

### 1-bar

| Pattern | Exact rule | Standard? |
|---|---|---|
| Hammer | `body > 0` · `lowerWick ≥ 2×body` · `upperWick ≤ body` · `body% ≥ 0.05` | ✅ canonical (long lower shadow ≥ 2× body, tiny upper shadow) |
| Inverted Hammer | `upperWick ≥ 2×body` · `lowerWick ≤ body` · `body% ≥ 0.05` | ✅ mirror of Hammer |
| Shooting Star | same shape as Inverted Hammer; label chosen when at **top of an up-swing** | ✅ shape + location is canonical |
| Hanging Man | same shape as Hammer; label chosen when at **top of an up-swing** | ✅ shape + location is canonical |
| Dragonfly Doji | `body% ≤ 0.05` · `upperWick ≤ 0.10` · `lowerWick ≥ 0.60` | ✅ canonical (a doji that is a "pure" hammer) |
| Gravestone Doji | `body% ≤ 0.05` · `lowerWick ≤ 0.10` · `upperWick ≥ 0.60` | ✅ canonical (a doji that is a "pure" shooting star) |
| Neutral Doji | `body% ≤ 0.05` · both wicks `≥ 0.20` · not Dragonfly/Gravestone | ✅ open ≈ close = indecision |
| Bullish Marubozu | `isBull` · `body% ≥ 0.92` · both wicks `≤ 0.05` | ✅ 92% body is the common textbook cut-off |
| Bearish Marubozu | `isBear` · `body% ≥ 0.92` · both wicks `≤ 0.05` | ✅ |

### 2-bar

| Pattern | Exact rule | Standard? |
|---|---|---|
| Bullish Engulfing | prev bear · curr bull · `close₂ ≥ open₁` · `open₂ ≤ close₁` (real-body engulf) | ✅ Nison uses *real-body* engulf |
| Bearish Engulfing | prev bull · curr bear · `close₂ ≤ open₁` · `open₂ ≥ close₁` | ✅ |
| Piercing Pattern | prev bear · curr bull · `open₂ < close₁` · `close₂ > midpoint(body₁)` · `close₂ < open₁` (not full engulf) | ⚠️ **relaxed**: strict textbook wants `open₂ < low₁` (true gap-down); we use `open₂ < close₁` since clean gaps are rare on liquid NSE names. The "close past the 50% midpoint" core is preserved. |
| Dark Cloud Cover | prev bull · curr bear · `open₂ > close₁` · `close₂ < midpoint(body₁)` · `close₂ > open₁` | ⚠️ same relaxation as Piercing (mirror) |
| Bullish Harami | prev bear · curr bull · `open₂ > close₁` · `close₂ < open₁` (body₂ inside body₁) · `body₁ ≥ 1.5×body₂` | ✅ small body engulfed by prior larger body |
| Bearish Harami | prev bull · curr bear · `open₂ < close₁` · `close₂ > open₁` · `body₁ ≥ 1.5×body₂` | ✅ |
| Tweezer Bottom | `abs(low₁ − low₂) / low₁ ≤ 0.0005` (twin lows, 0.05% tol) · prev bear · curr bull · `close₂ > close₁` | ✅ matching lows + bullish reversal |
| Tweezer Top | `abs(high₁ − high₂) / high₁ ≤ 0.0005` · prev bull · curr bear · `close₂ < close₁` | ✅ |

### 3-bar

| Pattern | Exact rule | Standard? |
|---|---|---|
| Morning Star | bar1 bear `body% ≥ 0.5` · bar2 small `body₂ ≤ 0.4×body₁` and `max(o,c)₂ < close₁` (gap below) · bar3 bull `body% ≥ 0.5` and `close₃ > midpoint(body₁)` | ✅ "close past bar-1 midpoint" is Nison's requirement |
| Evening Star | bar1 bull `body% ≥ 0.5` · bar2 small and `min(o,c)₂ > close₁` (gap above) · bar3 bear `body% ≥ 0.5` and `close₃ < midpoint(body₁)` | ✅ |
| Morning Doji Star | same as Morning Star but **bar2 is a true Doji** (`body% ≤ 0.05`) | ✅ recognised stronger variant |
| Evening Doji Star | same as Evening Star but **bar2 is a true Doji** | ✅ |
| Three White Soldiers | 3 bull bars · each `body% ≥ 0.6` · higher opens & closes · each `open` inside prior body · each `upperWick ≤ body/3` | ✅ (opens within prior body, closes near high, small upper shadows) |
| Three Black Crows | 3 bear bars · each `body% ≥ 0.6` · lower opens & closes · each `open` inside prior body · each `lowerWick ≤ body/3` | ✅ |

### Compression (orthogonal — no direction)

| Pattern | Exact rule | Standard? |
|---|---|---|
| Inside Bar | `high₂ < high₁` · `low₂ > low₁` · `range₂ ≤ 0.7×range₁` | ✅ "mother bar / inside bar"; the 0.7 range filter is an added noise guard |
| NR4 | current bar's range is **strictly** the narrowest of the last 4 bars | ✅ standard volatility-compression scan |

---

## Notes

- **Compression patterns** (Inside Bar, NR4) and the **neutral Doji** are
  reported *separately* from the directional bull/bear pattern — a bar can be
  both (e.g. "Bullish Engulfing" + "Inside Bar").
- **Hammer / Shooting Star share a shape** with Hanging Man / Inverted Hammer;
  the difference is **prior trend**, which is why the chart overlay computes a
  per-bar local trend rather than using one global trend.
- To change which patterns are plotted, edit `PATTERN_TIER1_BULL` /
  `PATTERN_TIER1_BEAR` near `drawPatternMarkers` in
  [`scripts/swing-analyzer.js`](../scripts/swing-analyzer.js), then bump
  `CACHE_VERSION` in [`sw.js`](../sw.js).
