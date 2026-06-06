# Chart + Candle + ZOI Verdict Scenarios (PCZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `data/verdict-rules.json`.**
> Defines the three-factor **chart pattern + candlestick + ZOI** confluence
> (no Fib). Builds on `docs/chart-zoi-verdict-scenarios.md` (PZ) by adding the
> candlestick **trigger** on the breakout / zone test.

Three layers:

- **Chart pattern = the structural thesis** (multi-swing), with its own neckline
  break confirmation, measured target and invalidation.
- **Candle = the trigger / timing** — a bull reversal bar firing **on the
  demand-zone test or the neckline breakout**.
- **ZOI = institutional location** — demand under the base (support), supply
  overhead (the target's ceiling / R:R reality check).

**Best case:** a confirmed bullish chart pattern whose base sits on demand,
breaking out with a Tier-1 bull candle, clear of overhead supply → A-grade
structural long. **Trap to avoid:** a bull candle on a pending/bearish
structure, into supply, or on a broken demand floor.

---

## Verdict precedence (resolve top-down; first match wins)

1. **`CONFIRMED` bearish chart pattern VETO** (H&S / Double Top) → **AVOID**.
2. **Supply / broken-demand VETO** (`Z7`,`Z8`,`Z11`,`Z6`,`Z2`) → **AVOID**; a
   bull candle into the ceiling or on a breaking floor is a trap. (Exception: a
   genuine `Z10` supply-**flip** is a bullish base, handled as a BUY row.)
3. **FAILED bullish chart pattern → SKIP.**
4. **Confirmation gate** — bullish pattern `PENDING`: a bull candle at demand is
   a **WATCH**, not a BUY (await neckline break).
5. **Headroom / chase guard** — confirmed + extended (>10% above demand `Z5`,
   `Z11b`) → **WAIT**; confirmed breakout into near supply → **CAUTION** (capped
   target).
6. **Confluence BUY** — `CONFIRMED-LIVE` bullish pattern + Tier-1 bull candle +
   demand / supply-flip / stacked demand → **STRONG BUY**.

---

## Scenarios

Chart = Bull / Bear, state CONFIRMED-LIVE / PENDING-WATCH / FAILED. Candle =
Bull T1 / Bull T2-3 / Bear T1 / Neutral / none. ZOI bucketed as in
`docs/zoi-verdict-scenarios.md`.

| # | Chart (state) | Candle | ZOI | Verdict | Color | Reasoning |
|---|---|---|---|---|---|---|
| PCZ1 | Bull, **CONFIRMED-LIVE** | Bull T1 | base on demand (`Z1`/`Z3`/`Z5c`/`Z5d`) | **STRONG BUY** | Green | Structure + trigger + institutional support aligned, clear headroom — A-grade long. Use pattern target; stop = tighter of pattern stop / zone distal. |
| PCZ2 | Bull, **CONFIRMED-LIVE** | Bull T1 | supply-flip (`Z10`) / stacked demand (`Z13`) | **STRONG BUY** | Green | Breakout backed by a flipped/stacked zone + confirming bar — highest conviction. |
| PCZ3 | Bull, **CONFIRMED-LIVE** | Bull T2/3 or Neutral | demand / flip / stacked | **BUY** | Green | Confirmed structure on support; weak/indecisive candle → standard conviction. |
| PCZ4 | Bull, **CONFIRMED-LIVE** | **Bear T1** | demand | **CAUTION** | Amber | Bearish bar at the entry on a confirmed bull structure — likely failed retest; wait for a bull candle. |
| PCZ5 | Bull, **PENDING-WATCH** | Bull T1 | demand | **WATCH** | Neutral | Bull bar at demand before the neckline breaks — promising, but the break is the trigger. |
| PCZ6 | Bull, **CONFIRMED-LIVE** | any | inside/approaching supply (`Z7`/`Z8`) | **CAUTION** | Amber | Breakout target capped by overhead supply — R:R poor; wait for supply to clear. |
| PCZ7 | Bull, **CONFIRMED-LIVE** | any | extended >10% above demand (`Z5`) / `Z11b` | **WAIT** | Neutral | Move extended from support — don't chase; wait for a retest. |
| PCZ8 | Bull, **CONFIRMED-LIVE** | any | broke below demand (`Z6`) / demand breaking (`Z2`) | **AVOID** | Red | The structure's own support failed — pattern invalidated by the zone break. |
| PCZ9 | **Bear, CONFIRMED-LIVE** (H&S / Double Top) | any | any | **AVOID** | Red | Confirmed top — suppress all longs. |
| PCZ10 | **Bear, PENDING-WATCH** | Bull T1 | demand | **CAUTION** | Amber | Conflict — top forming while candle + zone say buy. Stand aside until it resolves. |
| PCZ11 | Bull, **FAILED** | any | any | **SKIP** | Red | Structure failed — not a setup. |
| PCZ12 | **none** | (per candle+zoi) | any | _passthrough_ | — | No chart pattern → defer to Candle+ZOI (`docs/candle-zoi-verdict-scenarios.md`). |

---

## Summary

| Verdict | Scenarios |
|---|---|
| STRONG BUY | PCZ1, PCZ2 |
| BUY | PCZ3 |
| WATCH | PCZ5 |
| WAIT | PCZ7 |
| CAUTION | PCZ4, PCZ6, PCZ10 |
| SKIP | PCZ11 |
| AVOID | PCZ8, PCZ9 |

**Net effect:** the chart pattern's state is the backbone (PENDING ⇒ WATCH;
CONFIRMED bearish ⇒ veto); the zone gates location (supply/broken-demand ⇒ veto
or capped-target demote; demand/flip/stacked ⇒ valid base); the candle decides
STRONG-BUY-vs-BUY-vs-CAUTION on a confirmed bullish structure at a valid zone.
