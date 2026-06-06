# Chart + Candle + Fib + ZOI Verdict Scenarios (PCFZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `data/verdict-rules.json`.**
> The full four-factor confluence — the master rule that composes all of the
> two/three-factor docs. `fibZoiCombined` (Fib×ZOI) is the only piece live today;
> the candle + chart-pattern layers are the additions this spec defines.

This is the **grand confluence**: the four independent lenses the app computes,
resolved into one verdict.

| Lens | Question it answers | Source |
|---|---|---|
| **ZOI** (zone) | Is price at institutional support, or under a ceiling? | `_classifyZoiPosition` |
| **Fib** | Is price in the golden-pocket buy band, or at the swing high? | `computeFibZone` / `fibClass` |
| **Chart pattern** | Is a multi-swing structure confirming (or topping)? | `ChartPatterns.detect` |
| **Candle** | Is a buyer/seller stepping in *right now*? | `detectPatterns` |

**The four are not equal voters — they are a strict hierarchy.** Location (ZOI +
Fib) decides whether a long is *allowed*; the chart pattern is the dominant
*structural* confirmation/veto; the candle is the *trigger* that times and
grades it. More aligned bullish lenses ⇒ higher conviction; **any single
hard-bearish lens demotes or vetoes** — we never average a veto away (per
`.cursor/rules/trading-context.mdc`: a BUY must survive **every** gate).

---

## Master precedence (resolve top-down; first match wins)

1. **HARD VETO (location or confirmed top) → AVOID.** Any of:
   - ZOI at supply / approaching supply / failed breakout / broke-below-demand /
     demand breaking (`Z7`,`Z8`,`Z11`,`Z6`,`Z2`)
   - Fib at the swing high (`AT_HIGH` F12)
   - a **`CONFIRMED` bearish chart pattern** (H&S / Double Top)

   No bullish candle, fib pocket, or demand zone overrides these. A bullish
   trigger here is a **trap**.
2. **FAILED bullish chart pattern → SKIP** (the dominant structure just broke).
3. **Confirmation gate → WATCH.** Location is bullish but the trigger isn't
   confirmed: chart pattern still `PENDING` (neckline unbroken), and/or no HH-HL.
   A good location without a fired trigger is a setup, never a BUY.
4. **Chase guard → WAIT.** Extended away from the entry zone (`FAR_ABOVE` pocket
   F7, >10% above demand `Z5`, breakout extended `Z11b`) — don't chase, even with
   full confluence.
5. **Headroom demote → CAUTION.** A `CONFIRMED` bullish breakout running straight
   into near overhead supply (`Z8`) → capped target, poor R:R.
6. **CONFLUENCE BUY (graded).** All present lenses bullish + confirmed → BUY,
   conviction scaled by how many align (see grading below).

---

## Conviction grading (when the precedence lands on BUY)

| Grade | Verdict label | Lenses aligned (all bullish + confirmed) |
|---|---|---|
| **A+** | **STRONG BUY** | All four: demand (or flip/stacked) **and** golden-pocket **and** `CONFIRMED-LIVE` bull chart pattern **and** Tier-1 bull candle, rising (HH-HL). |
| **A** | **STRONG BUY** | Chart pattern `CONFIRMED-LIVE` + location BUY (pocket∩demand) + (candle Tier-1 **or** Tier-2/3) — structure carries it. |
| **B** | **BUY** | Three lenses bullish (e.g. pocket∩demand + Tier-1 candle, chart pattern absent **or** still PENDING-but-leaning) with structure confirmed. |
| **C** | **BUY (std)** | Two lenses bullish + confirmed (the live Fib×ZOI BUY, no pattern/candle help) — i.e. today's baseline. |

A weak/neutral/absent candle never blocks a BUY that structure + location already
earned; it only caps the grade. A **bearish** candle at the entry demotes the
grade to **CAUTION** (see PCFZ rows below).

---

## Representative scenarios

These are the decision-driving rows; every other combination resolves through
the master precedence above (and the two/three-factor docs it composes).

| # | ZOI | Fib | Chart (state) | Candle | Verdict | Color |
|---|---|---|---|---|---|---|
| PCFZ1 | demand (`Z1`) | pocket up (`F1`) | Bull **CONFIRMED-LIVE** | Bull T1 + HH-HL | **STRONG BUY (A+)** | Green |
| PCFZ2 | demand / flip / stacked | pocket up | Bull **CONFIRMED-LIVE** | Bull T2/3 or Neutral | **STRONG BUY (A)** | Green |
| PCFZ3 | demand | pocket up | none / Bull PENDING | Bull T1 + HH-HL | **BUY (B)** | Green |
| PCFZ4 | demand | pocket up | none | none | **BUY (C, baseline Fib×ZOI)** | Green |
| PCFZ5 | demand | pocket up | Bull **CONFIRMED-LIVE** | **Bear T1** | **CAUTION** | Amber |
| PCFZ6 | demand, no HH-HL (`Z4`) | in pocket falling (`F3`) | Bull **PENDING-WATCH** | Bull T1 (no HH-HL) | **WATCH** | Neutral |
| PCFZ7 | extended (`Z5`/`Z11b`) | far above (`F7`) | any | any | **WAIT** | Neutral |
| PCFZ8 | approaching supply (`Z8`) | any | Bull **CONFIRMED-LIVE** | Bull T1 | **CAUTION** | Amber |
| PCFZ9 | **supply** (`Z7`) / broke demand (`Z6`) | any | any | Bull T1 | **AVOID** | Red |
| PCFZ10 | any | **swing high** (`F12`) | any | Bull T1 | **AVOID** | Red |
| PCFZ11 | any | any | **Bear CONFIRMED-LIVE** (H&S/Double Top) | any | **AVOID** | Red |
| PCFZ12 | any bullish | any bullish | Bull **FAILED** | any | **SKIP** | Red |
| PCFZ13 | demand | pocket up | **Bear PENDING-WATCH** | Bull T1 | **CAUTION** | Amber |

---

## Summary

| Verdict | Scenarios |
|---|---|
| STRONG BUY | PCFZ1, PCFZ2 |
| BUY | PCFZ3, PCFZ4 |
| WATCH | PCFZ6 |
| WAIT | PCFZ7 |
| CAUTION | PCFZ5, PCFZ8, PCFZ13 |
| SKIP | PCFZ12 |
| AVOID | PCFZ9, PCFZ10, PCFZ11 |

---

## How this composes the other 8 docs

- Drop a lens → fall back to that lens's doc: no candle ⇒ **PFZ**; no chart
  pattern ⇒ **CFZ**; no zone ⇒ **PCF**; no fib ⇒ **PCZ**; two lenses ⇒ the
  CF/PF/CZ/PZ docs.
- The **veto set** is identical in every doc (supply / broken-demand / swing-high
  / confirmed-top) — by design, so the same hard-bearish condition can never
  produce a BUY in *any* combination.
- The **grade** only ever moves *within* the BUY band based on how many bullish
  lenses confirm; it never converts a WAIT/AVOID into a BUY.

**One-line rule:** *location must allow the long, structure must confirm it, the
candle must time it — and any one of those failing demotes the verdict, never the
other way around.*
