# Chart + ZOI Verdict Scenarios (PZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Geometric chart patterns are detected/drawn/carded but do not yet feed the ZOI
> verdict. This file defines the **chart pattern + ZOI** confluence rules to add.

Combines the **geometric chart pattern** (H&S, Inverse H&S, Double Top, Double
Bottom, Cup & Handle) with the **Zone of Interest** location (`zoiPosition`).

- **Chart pattern = the structural thesis**, with its own confirmation (neckline
  break), measured-move **target** and **stop**. `PENDING` = setup (WATCH),
  `CONFIRMED` = signal (LIVE).
- **ZOI = institutional context** — a bullish reversal anchored on a demand zone
  is far higher-quality, and overhead **supply** is the thing that caps the
  measured-move target (R:R reality check).

**Pattern state drives; the zone validates location and the target's headroom.**
A bullish breakout straight into overhead supply has a capped target → demote.

---

## Verdict precedence (resolve top-down; first match wins)

1. **Confirmed bearish structure VETO** — `CONFIRMED` (LIVE) H&S / Double Top →
   **AVOID** at any zone.
2. **FAILED pattern** → **SKIP**.
3. **Broken-demand override** — a bullish pattern whose base zone has **broken
   below demand** (`Z6`) → **AVOID** (the structure's own support failed).
4. **Confirmation gate** — bullish pattern `PENDING` (neckline unbroken) →
   **WATCH**.
5. **Headroom / chase guard** — `CONFIRMED` bullish pattern but price is
   **into/approaching supply** (`Z7`/`Z8`, target capped) or **extended** (>10%
   above demand `Z5`, breakout extended `Z11b`) → **WAIT/CAUTION**.
6. **Confluence BUY** — `CONFIRMED` (LIVE) bullish pattern + demand / supply-flip
   / stacked demand → **BUY**.

---

## Scenarios

Chart-pattern column: **Bull pattern** = Inverse H&S / Double Bottom / Cup &
Handle · **Bear pattern** = H&S / Double Top. State: **CONFIRMED-LIVE** /
**PENDING-WATCH** / **FAILED** / **WORKED**.

| # | Chart pattern (state) | ZOI position | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| PZ1 | Bull, **CONFIRMED-LIVE** | Base on demand zone (`Z1`/`Z3`/`Z5c`/`Z5d`) | **BUY** | Green | Structural reversal confirmed **at institutional demand** — structure + zone confluence, with clear headroom. Use the pattern's target/stop. |
| PZ2 | Bull, **CONFIRMED-LIVE** | Broke above supply, flipped to support (`Z10`) | **BUY** | Green | Breakout pattern through a flipped zone — supply-turned-support backs the continuation. |
| PZ3 | Bull, **CONFIRMED-LIVE** | Stacked demand (`Z13`) | **BUY** | Green | Multi-zone support under a confirmed structure — highest-conviction PZ long. |
| PZ4 | Bull, **PENDING-WATCH** | Demand / supply-flip | **WATCH** | Neutral | Right structure at a good zone, neckline **not yet broken** — the break is the trigger. |
| PZ5 | Bull, **CONFIRMED-LIVE** | Inside / approaching supply (`Z7`/`Z8`) | **CAUTION** | Amber | Breakout runs straight into overhead supply — measured target is **capped**, R:R poor. Demote; wait for supply to clear or a better entry. |
| PZ6 | Bull, **CONFIRMED-LIVE** | Extended >10% above demand (`Z5`) / breakout extended (`Z11b`) | **WAIT** | Neutral | Move already extended from support — don't chase; wait for a retest. |
| PZ7 | **Bear, CONFIRMED-LIVE** (H&S / Double Top) | **any** zone | **AVOID** | Red | Topping structure confirmed — suppress all longs regardless of zone. |
| PZ8 | **Bear, PENDING-WATCH** | Bullish demand location | **CAUTION** | Amber | A top is **forming** over a demand zone — conflict. Stand aside until the neckline resolves. |
| PZ9 | Bull, **CONFIRMED-LIVE** | Broke below demand (`Z6`) | **AVOID** | Red | The structure's own support has failed — pattern invalidated by the zone break. |
| PZ10 | Bull, **FAILED** | any | **SKIP** | Red | Stop closed through — reversal rejected. Not a setup. |
| PZ11 | Bull, **WORKED** (history) | any | _info only_ | Grey | Target already reached — audit row, not a fresh signal. |
| PZ12 | **none** | any | _passthrough_ | — | No chart pattern → defer to ZOI-only. |

---

## Summary

| Verdict | Scenarios |
|---|---|
| BUY | PZ1, PZ2, PZ3 |
| WATCH | PZ4 |
| WAIT | PZ6 |
| CAUTION | PZ5, PZ8 |
| SKIP | PZ10 |
| AVOID | PZ7, PZ9 |
| info/history | PZ11 |

**Net effect vs ZOI-only:** a `CONFIRMED-LIVE` bullish pattern on demand (or a
flipped/stacked zone) is the strongest two-factor structural long; overhead
supply demotes even a confirmed breakout (capped target); a `CONFIRMED` bearish
pattern or a broken demand base is an absolute veto.
