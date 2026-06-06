# Chart + Fib + ZOI Verdict Scenarios (PFZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `data/verdict-rules.json`.**
> `fibZoiCombined` (Fib×ZOI) IS implemented; the **geometric chart pattern** is
> NOT yet layered on top. This file defines the **chart pattern + Fib + ZOI**
> rules to add — the chart pattern becomes a structural confirmation/veto on the
> existing Fib×ZOI base verdict.

This combination **extends the live Fib×ZOI engine** with the multi-swing
**geometric chart pattern** (H&S, Inverse H&S, Double Top, Double Bottom,
Cup & Handle).

- **Fib + ZOI = location & invalidation** (the structural truth at the current
  swing).
- **Chart pattern = the larger structural thesis** — it carries its own
  confirmed neckline break, measured-move target and invalidation, and it spans
  *dozens* of bars (a bigger picture than the Fib×ZOI swing).

**A `CONFIRMED` bullish chart pattern aligned with a Fib×ZOI BUY is the strongest
non-candle signal in the app. A `CONFIRMED` bearish chart pattern VETOES a
Fib×ZOI BUY** — you do not buy a golden-pocket demand bounce that sits inside a
confirmed Head & Shoulders breakdown. The bigger structure wins.

---

## Verdict precedence (resolve top-down; first match wins)

1. **`CONFIRMED` bearish chart pattern (H&S / Double Top) VETO** — overrides
   **any** bullish Fib×ZOI base → **AVOID**. The larger topping structure is the
   dominant context.
2. **Base Fib×ZOI = AVOID/SKIP → stays AVOID/SKIP.** A bullish chart pattern at
   a vetoed location does not rescue it (and a `PENDING` one there → WATCH at
   best, never BUY).
3. **FAILED bullish chart pattern → SKIP/AVOID** even over a Fib×ZOI BUY (the
   structure just failed — don't fight it).
4. **`CONFIRMED` bullish chart pattern + Fib×ZOI BUY → STRONG BUY** (structure +
   location confluence; use the *tighter* of the two invalidations).
5. **`PENDING` bullish chart pattern + Fib×ZOI BUY → WATCH** (await the neckline
   break — the chart pattern hasn't triggered yet, even though the swing-level
   location is good).
6. **Chase guard** — extended past the breakout / >10% above demand / `FAR_ABOVE`
   pocket → **WAIT**.

---

## Scenarios

`Base` = existing Fib×ZOI verdict. Chart-pattern column as in
`docs/chart-fib-verdict-scenarios.md` (Bull = IHS / Double Bottom / Cup&Handle;
Bear = H&S / Double Top; states CONFIRMED-LIVE / PENDING-WATCH / FAILED /
WORKED).

| # | Base (Fib×ZOI) | Chart pattern (state) | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| PFZ1 | **BUY** — pocket ∩ demand (`F1xZ1xOVL`-class) | Bull, **CONFIRMED-LIVE** | **STRONG BUY** | Green | Confirmed multi-swing reversal **whose base sits on the pocket∩demand confluence** — A-grade structural long. Target = pattern measured move; stop = tighter of pattern stop / zone distal. |
| PFZ2 | **BUY** (any combined BUY) | Bull, **CONFIRMED-LIVE** | **BUY** | Green | Structural reversal confirmed and aligned with a location BUY. |
| PFZ3 | **BUY** (any combined BUY) | Bull, **PENDING-WATCH** | **WATCH** | Neutral | Location is a BUY but the bigger structure hasn't broken its neckline yet — wait for the break (don't pre-buy the bigger thesis). |
| PFZ4 | **BUY** (any combined BUY) | **Bear, CONFIRMED-LIVE** (H&S / Double Top) | **AVOID** | Red | **Veto.** A confirmed top dominates a swing-level buy zone — never buy into it. |
| PFZ5 | **BUY** (any combined BUY) | **Bear, PENDING-WATCH** | **CAUTION** | Amber | A top is forming over a buy zone — conflict; stand aside until the neckline resolves. |
| PFZ6 | **BUY** (any combined BUY) | Bull, **FAILED** | **CAUTION** | Amber | The bigger bullish structure just failed even though the swing location reads buy — reduce conviction; require fresh confirmation. |
| PFZ7 | **WATCH** — at demand no HH-HL / in pocket falling | Bull, **CONFIRMED-LIVE** | **BUY** | Green | The chart-pattern break supplies the confirmation the swing was missing — upgrade. |
| PFZ8 | **WAIT** — extended / between / approaching | Bull, **CONFIRMED-LIVE** | **WAIT** | Neutral | Even a confirmed pattern doesn't justify chasing an extended price — wait for a retest. |
| PFZ9 | **AVOID** — supply / broke demand / swing high | Bull, **CONFIRMED-LIVE** | **AVOID/CAUTION** | Red | Location veto stands. (A genuine `Z10` supply-flip is a BUY base, not this row — that's PFZ2.) At true supply/broken-demand: a bullish breakout into the ceiling has a capped target → demote. |
| PFZ10 | **AVOID** (any vetoed) | **Bear, CONFIRMED-LIVE** | **AVOID** | Red | Confluent bearish — reinforced suppress. |
| PFZ11 | **SKIP** — not a fib setup | any pattern PENDING | **SKIP** | Red | No valid swing setup and the bigger structure hasn't triggered — nothing to do. |

---

## Summary

| Verdict | Scenarios |
|---|---|
| STRONG BUY | PFZ1 |
| BUY | PFZ2, PFZ7 |
| WATCH | PFZ3 |
| WAIT | PFZ8 |
| CAUTION | PFZ5, PFZ6, PFZ9* |
| SKIP | PFZ11 |
| AVOID | PFZ4, PFZ9*, PFZ10 |

\*PFZ9 splits by zone type — supply-into-ceiling = CAUTION/WAIT, broken-demand /
swing-high = AVOID.

**Net effect:** the chart pattern is a **structural over-ride layer**. A
confirmed bullish one promotes a location BUY to STRONG BUY (or supplies a
missing confirmation); a confirmed bearish one is an absolute veto over any
bullish Fib×ZOI reading; a pending one keeps everything at WATCH until the
neckline breaks.
