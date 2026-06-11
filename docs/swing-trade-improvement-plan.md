# Swing-Trade Improvement Plan

_Last updated: 2026-06-10_

## North star (the goal)

Catch stocks that have **pulled back into a fresh demand zone and are turning
back up**, with the bigger timeframes in agreement — for a **1–2 week hold**.
The screen should make that decision **loud and obvious**, with nothing tempting
the trader into noise.

**Guiding principle:** accuracy beats coverage. Seeing 1–3 clean setups is the
goal, not 30. When in doubt, emit WAIT / no-signal — never a speculative BUY.

---

## Already done

- [x] **4H + 1H alignment confidence layer** — boost a Daily BUY when 4H structure
  agrees and 1H triggers; demote to WATCH when 4H is still making lower highs.
- [x] **Chart default layers cleaned up** — EMA 20/50 ON, zones ON, chart
  patterns ON; Fib / FVG / OB / BOS / LIQ OFF by default (the biggest noise win).

---

## Phase 1 — Finish de-noising the screen ✅ DONE (2026-06-10)
_Pure UI / clarity. No signal-logic risk. Quick, high impact. Shipped + verified
(JS check, no lints, regression guards green — 25,395 assertions held)._

- [x] **Hide the sub-hour timeframe buttons** (30m / 15m / 5m). Removed from
  **both** the chart toolbar and the reco-TF selector (they're locked mirrors),
  and a saved sub-hour selection now falls back to Daily. Kept **1M · 1W · 1D ·
  4H · 1H**. No signal impact — those TFs were cards-only / never signalled.
- [x] **Loud visual hierarchy** — size ladder in the SETUP PLAN strip: context
  TFs (Monthly / 4H / 1H) smallest, Weekly + Daily larger with bold labels, the
  RECOMMENDATION cell the hero; the whole block lifted with a subtle shadow.
  Supporting panels (per-TF cards, pattern cards) recede slightly (swing-scoped,
  restored on hover) so the eye lands on the decision first.
- [x] **Group the chart legend** — "Trend & Levels" (EMA / zones / Fib / CP)
  visible; "Advanced (SMC)" (FVG / OB / BOS / LIQ) collapsed behind a toggle.
- [x] **Mute Monthly + 1H in the bias bar** _(was optional)_ — covered by the
  hierarchy ladder above: Monthly / 4H / 1H render smaller so Weekly + Daily
  carry the visual weight.

**Bonus (same pass):** the 4H/1H alignment banner was compacted to a one-line
read with the full explanation behind a "Why?" expander, and its AGAINST wording
was fixed so it no longer claims a "Daily BUY" when the Daily is NEUTRAL.

---

## Phase 2 — Harden accuracy (the signal gates)
_Real-money signal logic. Each gate makes a BUY survive a tougher test → fewer
but cleaner signals. Ordered by impact. Every change must pass the regression
guards before shipping._

- [x] **1. Fresh-zone scoring** ✅ DONE (2026-06-10) — untested demand zone = full
   score; tested once = weaker; **tested twice+ now rejected**. The freshness
   infra already existed (detectZones drops BROKEN zones and lower-scores tested
   ones), but a worn-out zone could still emit a BUY. Added a gate in the shared
   verdict finaliser (`_resolveVerdict`, used by both the scan table and the
   RECOMMENDATION chip): a demand-zone-backed BUY whose zone has `testCount ≥ 2`
   is demoted **BUY → WATCH** with a plain-English reason. Fires only when a
   demand zone actually drives the read; FRESH / single-test / FIB-only BUYs are
   untouched. Deterministic → verdict-purity guard held (25,395 assertions green).
- [x] **2. Zone × Fib golden-pocket tier** ✅ DONE (2026-06-10) — overlap with the
   61.8–80% pocket = HIGH; merely "near" (≤1.5% apart) = MEDIUM. Added a pure
   `_pocketZoneTier` grade (OVERLAP / NEAR / FAR), exposed on the gate, and
   credited it in the confluence scorer (+18 overlap, +8 near) so the best setups
   rank/score higher and read as a stronger conviction tier. Confluence is
   ranking/confidence only — it does **not** change the BUY/WAIT verdict, so the
   rule-matching axis (`_pocketVsZone`) was left untouched. Guards green.
3. **Volume confirmation on the trigger candle** — reject zone bounces on
   below-average volume (no institutional footprint = weak signal).
4. **R:R / stop-distance sanity gate** — reject when the structural stop is so
   far that reward-to-T1 drops below ~1.5.
5. **Liquidity floor** — average daily traded value ≥ a threshold (₹5–10 cr/day);
   demote thin stocks even if price looks right.
6. **Relative-strength floor** — require the stock to at least match Nifty over
   20 days before a continuation BUY.
7. **Sector + breadth regime** — demote a long when its own sector is in a
   downtrend, not just Nifty vs its 50-DMA.
8. **Earnings / event blackout** — demote any BUY whose results fall inside the
   1–2 week hold window.

---

## Phase 3 — Widen the funnel (not the bar) + measure
_See a few names even on quiet days without lowering quality._

1. **"APPROACHING ZONE — watch" state + alert** — surface stocks near (not yet
   in) the zone and ping when they enter. Turns "rare right now" into "ready
   when it happens."
2. **Freshness / expiry guard** — auto-mark a setup STALE once price leaves the
   entry zone or breaches the stop, so old signals are never acted on.
3. **Outcome calibration** — track hit-T1 / hit-SL / timeout per confidence band
   so "HIGH" becomes a measured claim; keep only the bands that actually win.

---

## Phase 4 — New setup family: catch the move *before* the spike
_Today the engine is tuned for **one** entry: a pullback into a fresh demand zone
in an existing uptrend. That misses the **CartTrade-type move** — a stock that
spent months in a quiet base after a downtrend, then broke out and ran ~30% in
two weeks. By the time that candle is vertical the safe entry is gone (chasing an
extended candle is exactly the low-accuracy BUY the rules forbid). This phase adds
a setup family that surfaces those names **while they're still quiet** — and keeps
the same accuracy-first discipline (confirmed bars only, volume required, never
chase extended)._

### 4A. Consolidation-in-demand-zone (the "coil" — the precursor)
_Goal: find a stock **sitting tight on / inside a demand zone**, volatility
squeezing, **before** it breaks out. This is the earliest, safest look — you're
buying the base, not the spike._

- [ ] **Volatility contraction** — recent daily range / ATR is shrinking vs its
  own past (a tight coil, not a wide chop). Tight range = energy building.
- [ ] **Holding a fresh demand zone** — price is parked **on or just inside** a
  FRESH (untested or once-tested) demand zone and **not** breaking below it.
- [ ] **Quiet volume drying up, then a pickup** — falling volume during the coil,
  with up-days starting to out-volume down-days (early accumulation).
- [ ] **Weekly not in a hard downtrend** — weekly trend flat→turning, not still
  falling. New verdict state: **"COILING — watch"** (never an auto-BUY; it's a
  pre-trigger watch that should feed the APPROACHING-ZONE alert from Phase 3).

### 4B. Base-breakout / momentum candidate (the trigger)
_Goal: catch the **first** clean breakout day out of that base — the safe momentum
entry — not the 5th extended candle._

- [ ] **Stage 1 → Stage 2 turn** — long downtrend, then a multi-week sideways base,
  now reclaiming and holding **above the 20 & 50-day lines** with the 50-line
  flattening / curving up.
- [ ] **Breakout of the base ceiling on volume** — closes above the multi-week
  resistance with **above-average volume** (real demand, not a drift). Reuses the
  Phase 2 volume gate.
- [ ] **Relative strength turning up** — at least matching / beating Nifty over
  ~20 days (the leaders, not the laggards).
- [ ] **Not-extended guard (critical)** — **block / demote** the BUY once price is
  already stretched far above its 20-day line (e.g. today's CartTrade) — no
  chasing. Prefer the breakout candle itself or the **first pullback** back to the
  broken level. This is the guardrail that keeps the new screen honest.
- [ ] **Confirmed-bar only** — read the breakout off the **closed** daily candle,
  never the live forming one (no repainting).

> **Where this lands in the UI:** a new scan **flavour** (alongside the existing
> pullback scan) plus two new verdict states — **COILING** (4A) and **BREAKOUT**
> (4B) — so the trader can choose "show me coils building" vs "show me fresh
> breakouts" without lowering the bar on the core pullback setup.

---

## Phase 5 — Early "forming" demand zones (mark the instant a candle closes)
_The current engine only marks a demand zone **after** a strong rally fires out of
the base — so the zone appears 1–2 days late, after the first move is gone. The
goal here: mark a **provisional** demand zone **the moment the base candle closes**,
using evidence available *right now* instead of waiting for tomorrow's rally to
prove it. Fakes are expected and **fine** — the existing tested/broken machinery
retires them. The hard requirement (real money): an **unconfirmed** zone must
**never** leak a BUY on its own — it stays a lower-confidence WATCH until proven._

### The core idea — the leg-out is just the LAZIEST proof; replace it with past-only confluence
The confirmed engine waits for the explosive exit because that is the *simplest*
possible proof big buyers were there. But that proof is **1–2 days late**. The real
win: a base can be judged a high-probability demand zone using **only the candles
that already exist** (up to and including the just-closed one) — **zero look-ahead**.
We replace the single future-rally check with a **confluence score** built from
evidence that is *all in the past*. This is exactly how a seasoned discretionary
trader marks a zone live — they read the footprints already on the chart, they don't
wait for the rally. Done right, this marks **both** the 2 Jun (reversal/bottom) and
5 Jun (continuation/higher-low) zones **at their own close**, not days later.

### What qualifies a FORMING demand zone — PAST-ONLY confluence (no look-ahead)
Anchored on the **closed** candle only — never the live bar (no repainting). Score
the evidence below; mark a forming zone when the score clears a calibrated
threshold (tuned by the backtest in this phase). Covers **two flavours** — a
*reversal* base (drop → turn, e.g. ~2 Jun) and a *continuation* base (uptrend
pause/higher-low, e.g. 5 Jun) — so we don't miss either.
- [ ] **1. Arrival with momentum (leg-in quality)** — price reached the level via a
  strong directional move (a sharp drop for a reversal base, a strong rally for a
  continuation base). Strong arrival = real interest, not drift. *(past)*
- [ ] **2. Base quality** — tight range / small bodies / volatility contraction over
  1–5 bars. Tighter base = more unfilled orders concentrated. *(past)*
- [ ] **3. Turn signal on the just-closed candle** — *reversal:* hammer /
  bullish-engulfing / long lower wick + close in the upper third (buyers defended
  the low). *continuation:* a strong bullish close that **holds above the base /
  reclaims a level**. *(past — current close)*
- [ ] **4. Volume footprint** — elevated volume on the arrival or the turn candle
  (absorption), or dry-up in the base then a pickup on the turn. Reuses Phase 2.3.
  *(past)*
- [ ] **5. Location / confluence** — at a prior swing low, a prior demand zone, a
  rising 20/50-EMA, a round number, or a fib level. Not floating mid-air. *(past)*
- [ ] **6. Trend regime** — *continuation:* stock is making **higher lows /
  reclaiming EMAs** (uptrend resuming — this is what makes 5 Jun valid at its close).
  *reversal:* signs of downtrend exhaustion (momentum waning, RSI turning).  *(past)*
- [ ] **Threshold, not a hard gate** — no single item is mandatory; the **weighted
  score** decides, so a strong base can qualify on confluence even if one leg is
  weak, while a lone quiet candle (low score) never fires. This is the robustness
  knob the backtest tunes.

> **Honest trade-off (state it plainly):** past-only marking produces **more zones
> and more fakes** than waiting for the leg-out — because we no longer require the
> move to have already happened. That is the *accepted* cost (the user's call:
> "fakes are fine, the tested/broken machinery removes them"). We contain it with
> three guardrails: (1) the **scored threshold** (quality bar, not "every pause"),
> (2) the **FORMING vs CONFIRMED two-tier** split so a fake never auto-BUYs, and
> (3) the **broken/tested lifecycle** that retires fakes on a close below the zone.

### Two tiers — keep them strictly separate (this is the safety spine)
- [ ] **CONFIRMED zone** = today's logic (a real leg-out happened). Full trust.
  **Can back a BUY.** Untouched — `detectZones` and its 25,395-assertion guard
  stay exactly as-is so nothing in the live signal path regresses.
- [ ] **FORMING zone** = new, marked at base-candle close, **no leg-out yet**.
  Lower trust. Drawn differently (dashed / amber + a **"FORMING"** tag and the
  formation date). **Never emits a standalone swing BUY** — at most a new
  **"EARLY — watch"** verdict state. A separate detection pass
  (`detectFormingZones`) feeds the **display + watch layer only**, so the verdict's
  confirmed-zone gate is unchanged.

### What qualifies a FORMING demand zone at candle close (no look-ahead)
Anchored on the **closed** candle only — never the live bar (no repainting).
- [ ] **A. Strong move IN** — price arrived at the level with momentum (leg-in drop
  ≥ ~1.2× ATR). A real discount, not a drift.
- [ ] **B. A credible bullish trigger on the just-closed candle** (this replaces the
  future rally): a **hammer / bullish-engulfing / piercing**, OR a **long lower
  wick + close in the upper third** (buyers defended the lows intraday).
- [ ] **C. Volume confirmation** — the trigger candle's volume is **above its
  average** (the absorption / accumulation footprint). Reuses the Phase 2.3 gate.
- [ ] **D. Good location** — at/near a prior swing low, a prior demand zone, or
  higher-timeframe support — not floating mid-air.
- [ ] **Gate**: A + B are **mandatory**; C and D raise the confidence grade. Miss
  A or B → no forming zone (stay silent rather than guess).

### Lifecycle (the state machine — reuses existing freshness/broken logic)
- [ ] **FORMING → CONFIRMED**: once a real leg-out later fires (existing
  `detectZones` criteria), upgrade the same band to CONFIRMED (full trust). The two
  systems reconcile on the same price band.
- [ ] **FORMING → BROKEN (remove)**: price **closes below the distal** (with a small
  ATR buffer) → retire it, exactly like today's broken-zone handling.
- [ ] **FORMING → tested**: each pullback that holds keeps/strengthens it; tested
  too many times → demote, same as the current `touches`/`testCount` rules.

### ⚑ BACKTEST FINDINGS (2026-06-10) — what the data actually said
_Built `detectFormingZones` (pure, past-only, no look-ahead) + a hit-rate backtest
(`scripts/backtest/forming-zones.mjs`) over 127 stocks. Trade model: enter at the
turn-candle close, hard stop just below the zone, 2R target, resolve within 20 bars.
**These numbers OVERRULE the assumptions written above them — read them first.**_

- **Forming demand REVERSALS: ~39% win-rate at 2R = +0.18R per trade** (n≈6,672;
  break-even at 2R is 33.3%). A **modest but real positive edge.**
- **CONTINUATION forming zones: ~39% / +0.17R** — basically the same.
- **The volume thesis was WRONG.** A loud volume spike at a fresh low does *not* mean
  absorption — it's often capitulation/news that keeps falling. On the full
  population, volume barely separates outcomes (moderate ~43% vs spike ~38%), so
  volume is **NOT** a gatekeeper. Kept only as an informational UI label.
- **No reliable sub-grade exists.** Volume / base-length / turn-type / location are
  each ~flat (~38–43%). An earlier stacked filter that looked like ~50% was
  **overfitting to a filtered sub-sample** and did NOT survive on the full set. So we
  deliberately ship **NO "grade A" tier** — we don't promise precision the data can't
  back (trading rule: accuracy/honesty over coverage).

### Tiers (final, honest)
- [x] **EARLY** = a forming demand **reversal** (~39% / +0.18R). A **small-starter,
  2R+, add-on-confirmation** candidate — **never a full-size, high-conviction BUY.**
  Positive expectancy justifies a *small* early entry; the 61% miss-rate forbids more.
- [x] **WATCH** = a forming **continuation** pullback — display/context only.
- [x] **CONFIRMED** (existing `detectZones`, untouched, 25,395 guards green) = the only
  thing that can back a full-size BUY.

### Entry & risk model — the EARLY tier (small starter, NOT a confident BUY)
_The edge is real but thin (you lose ~6 of 10), so the STOP + SMALL SIZE + 2R+ target
are what make it work — not conviction._
- [ ] **Entry**: turn-candle close, or a buy-stop just above the turn candle's high.
- [ ] **Tight stop just below the zone distal** → small, defined risk.
- [ ] **2R+ target** — at ~39% win-rate, 2R is comfortably profitable; do not take <2R.
- [ ] **Scale-in (the key mechanic)**: small **starter** on the forming zone, **add the
  rest only on CONFIRMED** (the proving rally). Never full size on the forming flag.
- [ ] **Loud labelling**: "EARLY — unconfirmed, ~40% hit, trade small, hard stop, 2R+."

### UI — two-date markers (Formed + Confirmed) on chart AND card
- [ ] Forming zones drawn **dashed/amber** with a **"FORMING"** tag, visually distinct
  from solid CONFIRMED zones; toggle to show/hide (independent of confirmed zones).
- [ ] **Two dates per zone** tell its whole life:
  - **Formed `<date>`** = the turn candle (early flag) — already shipped for confirmed.
  - **Confirmed `<date>` (+Nd)** = the day the rally proved it. The gap = the head-start.
  - While forming: chart shows `FORMING · 02 Jun`; once confirmed: `formed 02 Jun ·
    confirmed 04 Jun`. Card shows two rows; chart label stays compact (detail in card).
- [ ] **Optional candle pins** — a "Formed" flag on the turn candle and a "Confirmed"
  flag on the proving candle, like the existing pattern markers.
- [ ] **Quick win (independent of Phase 5)**: add **"Confirmed `<date>`"** to the
  EXISTING confirmed zones now — the engine already knows the proving leg's last
  candle (same mechanism as the just-shipped "Formed" date). Pure display, low risk.
- [ ] **Tooltip** in plain words: "Marked at candle close, **not yet confirmed** by a
  breakout — lower confidence. Upgrades to CONFIRMED if a strong rally follows, or
  drops if price closes below it."

### Validation before trusting it (mandatory — real money)
- [x] **Hit-rate backtest** built + run (`scripts/backtest/forming-zones.mjs`):
  reversals ~39% / +0.18R at 2R — a real, modest, positive edge (see findings above).
- [x] `detectZones` + the 25,395-assertion guard stay **green** (forming zones are a
  fully separate pass; confirmed-zone signal path untouched).
- [x] Synthetic **unit guard** added (`scripts/backtest/forming-guard.mjs`, 22
  assertions: reversal/continuation detection, bands, evidence flags, no-repaint).

### Build order
1. [x] `detectFormingZones(raw)` pure pass (past-only, closed-bar only, no
   look-ahead) + unit guard on synthetic candles. **DONE.**
2. [x] Hit-rate backtest harness → measured the real edge; killed the volume thesis
   and the overfit "grade A". **DONE.**
3. [x] Render forming zones (dashed/amber + **EARLY/WATCH** tag + Formed date +
   "Forming" legend chip, default OFF). Added the **"Confirmed date" quick win**
   (`confirmedTs` = proving leg-out's last bar) to existing confirmed-zone cards,
   shown as "Confirmed <date> (+Nd)". Display layer (`formingZonesForDisplay`)
   filters to recent (≤40 bars) + unbroken + near-price (≤8×ATR) + not-overlapping
   a confirmed zone, capped at 3 (EARLY first, then freshest). Amber dashed boxes
   on the chart + amber detail cards (`#sw-forming-cards`). **DONE.**
4. [ ] Gated, last: the **EARLY small-starter tier** (entry + tight stop + 2R + scale-in
   label). Wired so a forming zone can raise a WATCH/EARLY note but **never** a
   full-size BUY (which still requires a CONFIRMED zone).

> **Decision (2026-06-10, post-backtest):** a forming **reversal** is tradeable as a
> **small, tight-stop, 2R+ EARLY starter** (positive expectancy, ~39%/+0.18R), with
> scale-in adding full size only on CONFIRMED. There is **no volume gate** (the data
> disproved it) and **no higher grade** (the ~50% stack was overfit). The EARLY tier
> stays small by design so the "never emit a speculative full-size BUY" rule holds —
> a fake EARLY starter is a paper-cut, never a full position.

---

## Notes on "isn't a stock at a demand zone *and* rising rare?"

- **Yes — and that's intentional, not a bug.** A fresh-demand-zone pullback that
  is turning up is the single highest-probability swing entry, so it is naturally
  uncommon on any given day.
- **You need 1–3 good ones, not 30.** A narrow funnel is the goal.
- **Widen the pipeline, not the criteria** — scan the full universe / multiple
  sectors, surface APPROACHING-ZONE watches with alerts, use the engine's other
  valid triggers (pullback to rising 20-EMA, 20-day breakout + volume, reversal
  at support), and re-scan near market close when zone reactions confirm.
- **Never lower the bar just to get more BUYs.** An empty list = "no clean setup
  today," which protects capital.
