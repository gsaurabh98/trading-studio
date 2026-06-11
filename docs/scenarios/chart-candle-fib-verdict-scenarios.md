# Chart + Candle + Fib Verdict Scenarios (PCF)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Defines the three-factor **chart pattern + candlestick + Fib** confluence
> (no ZOI). Builds on `docs/chart-fib-verdict-scenarios.md` (PF) by adding the
> candlestick **trigger** on the chart pattern's neckline break / retest.

Three layers, each answering a different question:

- **Chart pattern = the structural thesis** (multi-swing) — *what* is setting up
  and *where* it confirms (neckline break), with its own target + stop.
- **Candle = the trigger / timing** — *is a buyer stepping in right now*, e.g. a
  Bullish Engulfing **at the neckline break or its retest**.
- **Fib = location quality** — is the pattern's base / breakout retest anchored
  in the golden pocket?

**Best case:** a confirmed bullish chart pattern, breaking out (or retesting)
with a Tier-1 bull candle, at a fib pocket → an A-grade structural long. **Worst
trap to avoid:** a bullish candle on a *pending* or *bearish* structure, or at
the swing high.

---

## Verdict precedence (resolve top-down; first match wins)

1. **`CONFIRMED` bearish chart pattern VETO** (H&S / Double Top) → **AVOID**,
   regardless of candle or fib. A bull candle there is a dead-cat trigger.
2. **Fib swing-high VETO** (`AT_HIGH` F12) → **AVOID** even on a confirmed
   bullish pattern + bull candle (exhaustion at the extreme).
3. **FAILED bullish chart pattern → SKIP.**
4. **Confirmation gate** — bullish pattern `PENDING` (neckline unbroken): a bull
   candle at a good fib spot is a **WATCH** (early hint of the coming break), not
   a BUY. The neckline break is the real trigger.
5. **Chase guard** — confirmed + extended (`FAR_ABOVE` F7 / ran past neckline) →
   **WAIT**.
6. **Confluence BUY** — `CONFIRMED-LIVE` bullish pattern + Tier-1 bull candle +
   fib pocket/orderly-pullback → **STRONG BUY**. Drop the candle (or weaken it) →
   plain **BUY**; flip the candle bearish → **CAUTION**.

---

## Scenarios

Chart = Bull (IHS/DoubleBottom/Cup&Handle) or Bear (H&S/DoubleTop), state
CONFIRMED-LIVE / PENDING-WATCH / FAILED. Candle = Bull T1 / Bull T2-3 / Bear T1 /
Neutral / none. Fib = pocket-bullish (`IN_POCKET_UP`/`NEAR_ABOVE` touched) /
extended (`FAR_ABOVE`) / swing-high (`AT_HIGH`) / shallow (`SHALLOW`).

| # | Chart (state) | Candle | Fib | Verdict | Color | Reasoning |
|---|---|---|---|---|---|---|
| PCF1 | Bull, **CONFIRMED-LIVE** | Bull T1 | pocket-bullish | **STRONG BUY** | Green | Structure + trigger + location all aligned — confirmed reversal breaking/retesting with a bull bar in the pocket. A-grade. |
| PCF2 | Bull, **CONFIRMED-LIVE** | Bull T1 | shallow orderly pullback (`SHALLOW`) | **BUY** | Green | Especially Cup & Handle — shallow handle + confirming bar on the break = healthy continuation. |
| PCF3 | Bull, **CONFIRMED-LIVE** | Bull T2/3 or Neutral | pocket-bullish | **BUY** | Green | Confirmed structure at a good location; weak/indecisive candle → standard (not max) conviction. |
| PCF4 | Bull, **CONFIRMED-LIVE** | **Bear T1** | pocket-bullish | **CAUTION** | Amber | Confirmed bull structure but a bearish reversal bar just printed at the entry — likely a failed retest. Stand aside for a bull candle. |
| PCF5 | Bull, **PENDING-WATCH** | Bull T1 | pocket-bullish | **WATCH** | Neutral | Bull bar at a good fib spot **before** the neckline breaks — promising, but the break is the trigger. Monitor. |
| PCF6 | Bull, **PENDING-WATCH** | any | extended / shallow / other | **WATCH** | Neutral | Setup forming; nothing actionable until neckline break. |
| PCF7 | Bull, **CONFIRMED-LIVE** | any | extended (`FAR_ABOVE`) / ran past neckline | **WAIT** | Neutral | Breakout already extended — poor R:R; wait for a retest of neckline/pocket. |
| PCF8 | Bull, **CONFIRMED-LIVE** or PENDING | any (even Bull T1) | swing high (`AT_HIGH`) | **AVOID** | Red | Fib veto — exhaustion at the extreme; don't buy the top. |
| PCF9 | **Bear, CONFIRMED-LIVE** (H&S / Double Top) | any | any | **AVOID** | Red | Confirmed top — suppress all longs; a bull candle/fib pocket is irrelevant. |
| PCF10 | **Bear, PENDING-WATCH** | Bull T1 | pocket-bullish | **CAUTION** | Amber | Conflict — a top is forming while candle + fib say buy. Stand aside until the structure resolves. |
| PCF11 | Bull, **FAILED** | any | any | **SKIP** | Red | Structure failed — not a setup. |
| PCF12 | **none** | (per candle+fib) | any | _passthrough_ | — | No chart pattern → defer to Candle+Fib (`docs/candle-fib-verdict-scenarios.md`). |

---

## Summary

| Verdict | Scenarios |
|---|---|
| STRONG BUY | PCF1 |
| BUY | PCF2, PCF3 |
| WATCH | PCF5, PCF6 |
| WAIT | PCF7 |
| CAUTION | PCF4, PCF10 |
| SKIP | PCF11 |
| AVOID | PCF8, PCF9 |

**Net effect:** the chart pattern's state is the backbone (PENDING ⇒ never more
than WATCH; CONFIRMED bearish ⇒ veto); the candle decides STRONG-BUY-vs-BUY-vs-
CAUTION on a confirmed bullish structure; fib gates the swing-high AVOID and the
extended-chase WAIT.
