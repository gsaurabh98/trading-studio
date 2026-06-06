# Chart Patterns in the App

A reference for the **geometric (multi-swing) chart patterns** the app will
detect and draw on the swing chart — Head & Shoulders, Double Top/Bottom,
Cup & Handle, triangles, wedges, flags, etc. These are **distinct from the
single-/few-bar candlestick patterns** documented in
[`patterns.md`](patterns.md):

| | Candlestick patterns ([`patterns.md`](patterns.md)) | Chart patterns (this file) |
|---|---|---|
| Span | 1–4 bars | **dozens of bars** (whole swings) |
| Built from | raw OHLC of adjacent bars | **confirmed swing pivots** (`swingHighs` / `swingLows`) |
| Signal | momentum / single reversal bar | **structural reversal or continuation** of the larger trend |
| Confirmed by | the bar closing | a **neckline / trendline break** (+ optional retest) |

> **STATUS: Tier 1 SHIPPED.** The five Tier-1 patterns (Head & Shoulders,
> Inverse H&S, Double Top, Double Bottom, Cup & Handle) are implemented in
> their own module, [`scripts/chart-patterns.js`](../scripts/chart-patterns.js)
> (`window.ChartPatterns.detect` / `onChartRender`). It is loaded as a
> `<script defer>` AFTER `swing-analyzer.js` and talks to the swing closure
> through one small bridge, `window._swCP` (published near
> [`scripts/swing-analyzer.js`](../scripts/swing-analyzer.js)'s
> `swFocusPatternBar`). It recomputes its own pivots (a local copy of
> `swingHighs`/`swingLows`) so it has zero coupling to the swing internals.
> **Tier 2 / Tier 3 below are not yet implemented** — they remain the spec.

---

## Why these are gated harder than candlesticks (real money)

Per [`.cursor/rules/trading-context.mdc`](../.cursor/rules/trading-context.mdc):
**accuracy and robustness beat coverage.** Chart patterns are subjective and
easy to over-fit — a loose fit "sees" a Head & Shoulders in any three bumps.
So every plotted pattern must clear these gates, and when any gate is unmet we
demote to a faint/unconfirmed marker or emit **nothing** — never a confident,
repainting BUY/SELL:

1. **Confirmed pivots only (no repainting).** Patterns are built from
   `swingHighs`/`swingLows`, which require `lookback` confirmed bars on **both
   sides** of a pivot. The live/forming bar can never be a pivot, so a pattern
   cannot be "drawn" off an unfinished candle and then vanish.
2. **A pattern is a SETUP, not a signal, until the line breaks.** Detection
   draws the shape (neckline / trendline) as **PENDING**. The directional
   verdict (BUY/SELL) only fires on a **confirmed close beyond the neckline**
   (reversal) or **trendline** (continuation). Pre-break = WATCH.
3. **Proportion / symmetry tolerances** keep noise out (see each pattern's
   exact rule). A "Double Top" whose two peaks differ by >3% is not a double
   top; it's two unrelated highs.
4. **Measured-move target + invalidation are mandatory.** Every confirmed
   pattern ships a target (measured move) **and** a structural stop (the level
   that, if breached, kills the thesis). No target/stop ⇒ no actionable signal.
5. **Volume is corroborating, not required.** Where volume is available it
   *strengthens* a pattern (e.g. H&S right shoulder on lighter volume, breakout
   on heavier volume) but a missing/partial volume series never *fabricates* a
   pattern — fail safe to the price-only rule.

---

## Categories at a glance

- **Tier 1** (plotted — high reliability, clean geometry, robustly detectable):
  Head & Shoulders, Inverse Head & Shoulders, Double Top (M),
  Double Bottom (W), Cup & Handle.
- **Tier 2** (detected, plotted **faint / PENDING-only**, needs confluence):
  Triple Top, Triple Bottom, Ascending Triangle, Descending Triangle,
  Symmetrical Triangle, Bull Flag, Bear Flag, Falling Wedge, Rising Wedge,
  Rounding Bottom (Saucer).
- **Tier 3** (context only, **not plotted** — noisy / subjective / low edge):
  Rectangle (range), Pennant, Broadening / Megaphone, Diamond,
  Inverse Cup & Handle, Channels.
- **Out of scope** (deliberately excluded): harmonic patterns
  (Gartley / Bat / Butterfly / Crab), Elliott-wave counts, three-drives.
  Too parameter-heavy and subjective for a real-money, no-repaint engine.

---

## Tier 1 — Plotted on the chart (high reliability)

These are drawn as a labelled **neckline/zone overlay** with an **outcome badge**:
**WATCH** (shape complete, line not yet broken) → **LIVE** (close broke the line,
in play) → **WORKED ✓** (target reached first) / **FAILED ✗** (stop hit first).
Resolved (WORKED / FAILED) patterns are **kept visible for validation**, never
dropped — see *Confirmed-pattern lifecycle*. Reliability ordering follows the
standard swing-trading literature (Bulkowski, *Encyclopedia of Chart Patterns*;
classic technical-analysis canon) where these consistently rank among the lowest
break-even-failure-rate formations.

| Pattern | Type | Direction | Confirms on | Measured-move target |
|---|---|---|---|---|
| **Head & Shoulders** | Reversal (of uptrend) | Bearish | close **below** the neckline | neckline − (head − neckline) |
| **Inverse Head & Shoulders** | Reversal (of downtrend) | Bullish | close **above** the neckline | neckline + (neckline − head) |
| **Double Top (M)** | Reversal (of uptrend) | Bearish | close **below** the trough between peaks | trough − (peak − trough) |
| **Double Bottom (W)** | Reversal (of downtrend) | Bullish | close **above** the peak between troughs | peak + (peak − trough) |
| **Cup & Handle** | Continuation | Bullish | close **above** the handle's resistance | breakout + cup depth |

Overlay colors match the candles / candlestick markers: bull `#09a86e`, bear
`#c91f3a`; **FAILED** patterns are greyed (`#8a8f98`). The **skeleton** is a thin
dotted zig-zag `LineSeries` through the pivots (so it visibly reads as an M / W /
H&S / cup) with a name + outcome (✓/✗/• watch) marker — and the skeleton is the
**only** thing drawn on the chart pane. **LIVE / WATCH** patterns additionally
label the **neckline**, **target** (green `#22c55e`) and **invalidation** (red
`#ef4444`) as **y-axis tags only** (`axisTag()` — `lineVisible:false` +
`axisLabelVisible:true`); nothing is drawn across the chart pane. **WORKED / FAILED**
(history) are **hidden by default**; when revealed via the
history toggle they show as small **✓/✗ markers**, and **tapping a card inspects
one** — expanding just that pattern to its full skeleton + plan (see
*Confirmed-pattern lifecycle*).

### The five, precisely

#### Head & Shoulders (bearish reversal)
- **Shape:** in an existing **uptrend**, three peaks — Left Shoulder (LS),
  Head (higher), Right Shoulder (RS, lower than head) — with two intervening
  troughs. Neckline connects the two troughs.
- **Pivots:** peak-trough-peak-trough-peak = LS, T1, Head, T2, RS, read from
  `swingHighs`/`swingLows`.
- **Tolerances (proposed):** Head > both shoulders by ≥ the pivot ATR;
  LS and RS within **~5%** of each other (symmetry); RS peak **below** the Head.
- **Confirm:** a **confirmed close below the neckline** (interpolated to the RS
  time). Neckline may be flat or slightly sloped — a steeply up-sloped neckline
  weakens it (demote).
- **Target:** `neckline − (head_high − neckline_at_head)`. **Stop/invalidation:**
  a close back **above** the right shoulder.

#### Inverse Head & Shoulders (bullish reversal)
- Mirror of the above in a **downtrend**: three troughs (LS, lower Head, RS),
  neckline through the two intervening peaks. **Confirm:** confirmed close
  **above** the neckline. **Target:** `neckline + (neckline_at_head − head_low)`.
  **Stop:** close back **below** the right shoulder.

#### Double Top — "M" (bearish reversal)
- **Shape:** two peaks at ~the same price separated by a trough; prior trend up.
- **Tolerances (proposed):** the two peaks within **~3%** of each other; the
  trough between them ≥ **~3%** below the peaks (a real valley, not a pause);
  reasonable time separation (peaks not adjacent pivots).
- **Confirm:** confirmed close **below** the intervening trough ("neckline").
  **Target:** `trough − (peak − trough)`. **Stop:** close back above the lower
  of the two peaks.

#### Double Bottom — "W" (bullish reversal)
- Mirror of Double Top in a **downtrend**: two troughs at ~the same price with
  an intervening peak. **Confirm:** close **above** the peak. **Target:**
  `peak + (peak − trough)`. **Stop:** close back below the higher of the two
  troughs.

#### Cup & Handle (bullish continuation)
- **Shape:** a rounded **U-shaped** base (the cup — *not* a sharp V), followed
  by a smaller, shallower **pullback (the handle)** drifting down on the right
  rim, then a breakout. Prior trend up (it's a continuation pattern).
- **Detection (proposed):** find a swing-low cluster forming a rounded bottom
  between two rims of similar height (within ~5%); the handle is a shallow
  retrace (typically < ~1/3 of cup depth) off the right rim; cup is meaningfully
  wider than the handle.
- **Confirm:** confirmed close **above** the handle's resistance (right-rim /
  handle high). **Target:** `breakout + cup_depth`. **Stop:** close below the
  handle low.
- **Guard:** reject V-shaped recoveries and cups deeper than the prior advance
  (those are reversals, not continuations).

### Confluence emphasis (ranking, not filtering)

Like the candlestick overlay, a confirmed chart pattern is drawn **stronger
(★, darker, thicker)** when its breakout aligns with the chart's existing
structure, and plain otherwise — nothing is hidden, only ranked:

- **Bullish** pattern (Inverse H&S, Double Bottom, Cup & Handle) emphasised when
  the base / right shoulder sits on a **DEMAND zone** (`detectZones`) or in the
  **Fib golden pocket** (61.8–80%, with the same `FALLING`-pocket demotion the
  candlestick overlay uses).
- **Bearish** pattern (H&S, Double Top) emphasised when the head / peaks sit at
  a **SUPPLY zone**.
- A breakout on **heavier volume than the pattern's average** (when volume is
  available) adds emphasis; a breakout on shrinking volume is demoted to plain.

### Pattern cards (below the chart)

Mirroring the candlestick cards (`#sw-pattern-cards`), chart patterns also render
as **clickable cards** in the "Zone & Signal Analysis" panel
(`#sw-chart-pattern-cards`), driven by the **same** rows the overlay uses (single
source of truth). Each card states the pattern, its **outcome badge** (WATCH /
LIVE / WORKED ✓ / FAILED ✗ — FAILED is greyed + struck-through), the **time
span** it forms over (calendar icon, e.g. "3 Oct 2023 → 2 May 2024"), the
measured-move target, the invalidation level, and a plain-English action;
clicking centres the chart on the breakout/anchor bar. Cards follow the
  Recommendation Timeframe control (`swGetRecoTf`), like the candlestick cards.
By default only **actionable** (LIVE / WATCH) cards show; a `Show history` chip
reveals the resolved (✓/✗) audit trail, capped at `MAX_ROWS` overall.

---

## Tier 2 — Detected, plotted faint (needs confluence)

Real, well-known formations, but either more parameter-sensitive (triangles /
wedges depend on fitted trendlines) or weaker standalone than Tier 1. **Drawn
only as a faint PENDING shape**; they upgrade to a full CONFIRMED overlay (and
emit a directional verdict) **only with confluence** (trend alignment + zone /
volume backing). Until then they feed the scoring engine as context.

| Pattern | Type | Direction | Confirms on |
|---|---|---|---|
| Triple Top | Reversal | Bearish | close below the support shared by the 3 peaks |
| Triple Bottom | Reversal | Bullish | close above the resistance shared by the 3 troughs |
| Ascending Triangle | Continuation (usually) | Bullish | close above flat-top resistance |
| Descending Triangle | Continuation (usually) | Bearish | close below flat-bottom support |
| Symmetrical Triangle | Bilateral (breakout) | Trend-following | close beyond the converging line in the trend's direction |
| Bull Flag | Continuation | Bullish | close above the flag's upper channel after a sharp rise (pole) |
| Bear Flag | Continuation | Bearish | close below the flag's lower channel after a sharp drop (pole) |
| Falling Wedge | Reversal / continuation | Bullish | close above the upper falling trendline |
| Rising Wedge | Reversal / continuation | Bearish | close below the lower rising trendline |
| Rounding Bottom (Saucer) | Reversal | Bullish | close above the rim |

**Why faint, not Tier 1:** triangles/wedges/flags require fitting **trendlines**
to ≥2 pivots each, and small pivot-set changes can flip the fit — higher
false-positive risk. Symmetrical triangles are explicitly **bilateral** (the
break direction decides), so we never pre-commit a direction before the break.

---

## Tier 3 — Context only, NOT plotted (noisy / subjective)

Low standalone edge for an automated, no-repaint engine, or geometrically
ambiguous to fit. They may still nudge the scoring engine but get **no marker**.

| Pattern | Type | Why not plotted |
|---|---|---|
| Rectangle (trading range) | Continuation/range | Just S/R already shown by `detectZones`; a marker adds noise |
| Pennant | Continuation | Tiny, short-lived; overlaps Bull/Bear Flag; hard to separate from a Symmetrical Triangle at swing scale |
| Broadening / Megaphone | Bilateral | Expanding volatility; very low reliability, frequent whipsaw |
| Diamond | Reversal | Rare; needs a broadening-then-narrowing fit — fragile |
| Inverse Cup & Handle | Reversal/continuation | Bearish mirror of Cup & Handle; rarer + lower documented edge |
| Channels (up/down/horizontal) | Trend | Drawn better by the existing trendline / zone tooling |

---

## Out of scope (deliberately excluded)

Harmonic patterns (Gartley, Bat, Butterfly, Crab, Shark, Cypher), Elliott-wave
counts, and three-drives. They depend on precise Fibonacci-ratio fits between
many pivots and are highly subjective — too easy to over-fit and too likely to
repaint as pivots resolve, which conflicts with the "fail safe, no repaint,
accuracy over coverage" rule. If ever added, they would start in a clearly
labelled experimental tier behind a flag.

---

## Detection approach (as implemented)

Single pure classifier in [`scripts/chart-patterns.js`](../scripts/chart-patterns.js):

```
ChartPatterns.detect(raw, tf)
  → [{ name, short, dir, type, state, outcome, anchorIdx, confirmIdx,
       pivots[], neck:{x1,y1,x2,y2}, target, stop, strong, startTs, ts }]
       // state   : 'PENDING' | 'CONFIRMED'
       // outcome : 'WATCH' | 'LIVE' | 'TARGET_HIT' | 'FAILED'
```

1. **Pivots first.** Compute `highs = swingHighs(candles, LB)` and
   `lows = swingLows(candles, LB)` with a TF-aware `lookback` (wider on lower
   TFs to suppress noise). Merge into one time-ordered pivot stream.
2. **Window scan.** Slide a bounded window over the recent pivot stream
   (cap the number of pivots back, e.g. last ~12) and test each Tier 1/2
   geometry against the relevant pivot sub-sequence. **Confirmed pivots only** —
   the trailing `lookback` bars can't yet be a pivot, so the forming bar is
   structurally excluded (no repaint).
3. **Validate proportions/symmetry** against the per-pattern tolerances above,
   scaled by the **capped ATR** (reuse `cappedAtrValue` / `TREND_PARAMS_BY_TF`)
   so thresholds adapt to the instrument's volatility instead of fixed %s where
   appropriate.
4. **State machine per pattern:**
   - `PENDING` (badge **WATCH**) — geometry complete, neckline/trendline not yet
     broken. **Not** aged out — an old un-triggered setup is still shown (it's
     part of the historical picture you validate against).
   - `CONFIRMED` — a **confirmed close** beyond the line in the signal
     direction. The breakout's *outcome* is then classified (LIVE / WORKED /
     FAILED) and **kept visible** — see *Confirmed-pattern lifecycle* below.
   - A pattern that broke the **wrong way first** (a new high above both peaks
     before a "double top" breaks down, etc.) is discarded outright — it was
     never a valid pattern, so it's not even shown as PENDING. (This is the one
     thing we still drop: it prevents a *false positive*, not survivorship.)
5. **Attach target + stop** (measured move + invalidation level) to every
   PENDING/CONFIRMED row — never emit a row without both.
6. **Overlay + cards** read these rows (single source of truth), exactly like
   `drawPatternMarkers` / `collectTier1Patterns` do for candlesticks.

### Confirmed-pattern lifecycle (outcome is LABELLED, not dropped)

**Design note (2026-06):** confirmed patterns are **never dropped** for having
played out or failed. Dropping them hid *both* wins and losses, leaving only
in-flight setups on the chart — so the labelling looked flawless (survivorship
bias) and could not be **validated by eye** (the whole reason a trader scrolls
back through old data). Instead we **keep every pattern visible and label its
outcome**. A resolved row is styled so it can never be mistaken for a fresh,
actionable signal (greyed/✗ skeleton on the chart, coloured badge on the card).

The outcome is decided by `resolveOutcome()` /  `outcomeFor()` in
[`scripts/chart-patterns.js`](../scripts/chart-patterns.js): scanning only the
**closed** bars *after* the breakout (no-repaint, close-based), whichever of the
target or the stop is closed through **first** wins. Sequence matters — a
pattern that reached target *then* later broke the stop still **worked** (you'd
be out at target). Target and stop sit on opposite sides of the breakout, so a
single close can never trigger both.

| Outcome | Badge | When | Shown as |
|---|---|---|---|
| **WATCH** | grey, dashed border | `PENDING` — neckline not broken yet | A setup, not a signal. Target/invalidation shown as the *would-be* plan. |
| **LIVE** | blue | `CONFIRMED`, neither target nor stop closed through yet | Tradeable setup, in play. |
| **WORKED** (✓) | green | `CONFIRMED`, target closed through **first** | History — the move played out. Kept for validation. |
| **FAILED** (✗) | red, greyed + struck-through | `CONFIRMED`, stop closed through **first** | History — the thesis broke. Kept for validation. |

The measured-move **target** is computed once per detector and reused for both
the outcome test and the displayed row, so the classifier and the shown target
can never diverge. There is **no breakout-age / formation-age cap** — patterns
are surfaced regardless of age (capped only by `MAX_ROWS` for readability).

**Historical audit (2026-06):** each detector returns an **array** of every
valid candidate (newest first), so the overlay/cards can show the worked/failed
**history**, not just the latest pattern of each type. `detect()` merges all
detectors' rows, de-dups overlaps (anchored within `lookback` bars), and caps to
**`MAX_ROWS` overall** (most recent across all types) so the audit trail stays
readable.

**Actionable-by-default + history toggle (2026-06, de-noise):** showing all
`MAX_ROWS` at once (live + history) was too busy on both the chart and the
cards. So the **default view shows only ACTIONABLE rows** (`LIVE` + `WATCH`) —
usually 0–2 — and the resolved audit trail is revealed on demand:

- **Cards** group actionable rows first; a `Show history (N: X✓ Y✗)` chip in the
  cards header (rendered by `paintCards`, only when there *is* resolved history)
  appends the worked/failed cards. If there are no live/watch setups, the panel
  shows an empty note + the chip so history is still one tap away.
- **Chart — overview vs. inspect.** `drawOverlays` has two modes:
  - **Overview** (nothing tapped): resolved rows are hidden unless history is on;
    when shown they're small **✓/✗ markers**, while **LIVE / WATCH** draw their
    full plan. Capped at `MAX_ROWS`.
  - **Inspect** (a card tapped → `focusKey` set via `swFocusChartPattern`): the
    chart draws **ONLY that one pattern**, full plan (skeleton + neckline +
    target + invalidation), and **hides every other pattern**. This is essential
    for readability — otherwise an actionable pattern's plan lines and the
    inspected pattern's skeleton coexist and look unrelated ("lines seem off").
    One pattern's geometry stands alone. Tap again to collapse (back to
    overview), tap another card to move the focus. The inspected card gets an
    `is-focused` ring.
- **No price lines are drawn on the chart pane — the skeleton is the only
  on-chart geometry.** The bounded neckline segment was removed too: for wide
  formations (double top, cup) it still read as a chart-wide dashed line, so it
  now lives on the price axis like the other levels. One shared renderer
  (`drawOneOverlay`) for all five patterns, so H&S, Inverse H&S, Double
  Top/Bottom and Cup & Handle behave identically. (The bridge's full-width
  `drawPriceLevel` is no longer used by this overlay.)
- **All levels are labelled on the PRICE AXIS (y-axis), not over the candles.**
  Floating in-chart text markers (`<pattern> neckline`, `target …`,
  `invalidation …`) overlapped the bars and were unreadable; on-chart segments
  streaked across the pane. Now **neckline, target and invalidation are all
  y-axis tags ONLY — no on-chart line, no stub, no autoscale blow-out:**
  - The **neckline** (pattern-direction colour) is tagged at the level it has at
    the **breakout bar** (`neckAt(bxc)`) — the price that actually triggers the
    pattern (flat for double top/bottom, interpolated for a sloped H&S neckline).
  - **Target** (green) and **invalidation** (red). As on-chart lines these read
    as floating marks disconnected from the candles (esp. a far Cup & Handle
    target high above, which also zoomed the whole chart out).
  - `axisTag(price, color, title)` attaches a
    `createPriceLine({ lineVisible: false, axisLabelVisible: true })` to an
    **empty (data-less) `LineSeries`** — so there is nothing on the pane and no
    autoscale contribution, just the colored `<pattern> neckline` /
    `<pattern> target` / `<pattern> invalidation` price tag on the axis (visible
    when the level is within the candle-scaled price range; the exact ₹ value is
    always in the card). A single-point series was tried first but still rendered
    a short bar and pulled the autoscale to the far target — `lineVisible:false`
    is the fix.
  The pattern **name** still rides the skeleton arrow at the extreme pivot, so
  the shape is identifiable on the chart and its full plan is read off the axis.
- **Diagnostic:** `swDumpChartPatterns()` (console) prints every detected
  pattern for the current reco TF with pivot **dates + prices**, neckline,
  target and stop — ground truth for verifying geometry against the chart.
- The toggle is `window.swToggleChartPatternHistory()`; the choice persists in
  `localStorage('cp_show_history_v1')` and re-renders through the swing bridge
  (`_swCP.renderMainChart`) so the chart overlay and the cards refresh from one
  render path (they can never drift apart).

There is **no breakout-age / formation-age cap** — patterns are surfaced
regardless of age (capped only by `MAX_ROWS`); the history toggle controls
*visibility*, not *retention*.

### No-repaint contract (non-negotiable)

- A pattern's **pivots** are confirmed-bar pivots; the shape can extend/age but
  an already-CONFIRMED breakout bar is a **closed** bar and never re-evaluated.
- The forming bar is never a pivot and never the breakout bar while the market
  is open (reuse `isMarketOpen()`; fail safe when market state is unknown).
- Targets/stops are computed from confirmed levels and don't drift once
  CONFIRMED (only the cosmetic confluence ★ may change as zones evolve — same
  rule as the candlestick overlay).

---

## How this feeds the verdict engine

Like candlesticks, **everything detected feeds scoring** even when only Tier 1
is plotted. A CONFIRMED Tier-1 reversal **against** the higher-timeframe trend
is a strong demote/exit signal; a CONFIRMED continuation **with** the trend at a
fresh zone boosts a BUY. A PENDING pattern is **WATCH**, never a BUY — the
break is the trigger. As always: if a gate is unmet, **demote, don't leak a
flawed signal**.

---

## How it's wired into the chart

- **Overlay (chart TF):** `swing-analyzer.js`'s `renderMainChart` calls
  `window.ChartPatterns.onChartRender({chart, series, inner, raw, tf})` once
  per render, after the candlestick markers. By default the module draws only
  the **actionable** (`LIVE` / `WATCH`) patterns — resolved history is drawn only
  when the history toggle is on (`drawOverlays` filters it). Visible rows are
  drawn oldest→newest (latest label on top). An actionable row is: (1) a thin
  dotted **skeleton** zig-zag `LineSeries` through the pivots with point markers
  (so it visibly reads as an M / W / H&S / cup) and a name + `• watch` label
  marker; and (2) the **neckline** (pattern colour), **target** (green) and
  **invalidation** (red) shown as **y-axis tags only** (`axisTag()` — a
  `lineVisible:false` price line on an empty series, no on-chart mark). Nothing
  but the skeleton is drawn on the chart pane. A
  **resolved** (worked/failed)
  row is a small **✓/✗ marker** until you tap its card to inspect it, at which
  point that one expands to the full skeleton + plan (and only that one — see
  *inspect one at a time* above). The label marker is attached to the pattern's
  own series (not the candle series), so the candlestick arrows are never
  clobbered.
- **Cards (recommendation TF):** rendered into `#sw-chart-pattern-cards` in
  [`content/swing.html`](../content/swing.html), following the Recommendation
  TF (`window.swGetRecoTf`) — exactly like the candlestick cards. The chart
  OVERLAY follows the chart TF (same split as candle arrows-on-chart vs
  cards-on-reco-TF). When the two TFs match they mirror each other; when they
  differ, clicking a card switches the chart to the reco TF and centres on it.
  `swSetRecoTf` re-renders the chart, which re-fires `onChartRender`, so the
  cards update whenever the reco-TF control changes.
- **Toggle:** the `CP` chip in the chart legend (`data-ind="chartpatterns"`,
  default on) flips `STATE.indVisible.chartpatterns` and re-renders.

## To change which patterns / thresholds

Edit the tolerance constants (`PEAK_TOL`, `SHOULDER_TOL`, `MIN_VALLEY`,
`CUP_*`, `MAX_ROWS`, …) and the five `detect*` helpers at the top of
[`scripts/chart-patterns.js`](../scripts/chart-patterns.js), then bump
`CACHE_VERSION` in [`sw.js`](../sw.js).
