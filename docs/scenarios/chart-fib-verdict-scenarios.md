# Chart + Fib Verdict Scenarios (PF)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Geometric chart patterns (`scripts/chart-patterns.js`, see
> `docs/chart-patterns.md`) are detected, drawn, and carded, but they do not yet
> feed the Fib/ZOI verdict text. This file defines the **chart pattern + Fib**
> confluence rules to add.

Combines the **geometric chart pattern** (multi-swing structure:
Head & Shoulders, Inverse H&S, Double Top, Double Bottom, Cup & Handle) with the
**Fib location** (`fibClass`).

- **Chart pattern = the structural thesis** — and it carries its **own**
  confirmation (a confirmed close beyond the neckline/trendline), **target**
  (measured move) and **stop** (invalidation). It is a SETUP while `PENDING`
  (badge WATCH) and a SIGNAL only once `CONFIRMED` (LIVE).
- **Fib = where that structure sits** — a bullish reversal whose base/right
  shoulder is anchored in the golden pocket is far higher-quality than one in
  open space.

**The chart pattern's state is the primary driver; Fib refines location quality
and the chase-guard.** A `PENDING` pattern is never a BUY (the break is the
trigger); a `CONFIRMED` **bearish** pattern vetoes every long.

---

## Verdict precedence (resolve top-down; first match wins)

1. **Confirmed bearish structure VETO** — a `CONFIRMED` (LIVE) **H&S** or
   **Double Top** → **AVOID** at every fib location. Don't buy into a confirmed
   top, even if price sits in the golden pocket.
2. **FAILED pattern** — a bullish pattern whose stop already closed through
   (`outcome = FAILED`) → **SKIP**. The thesis is dead.
3. **Confirmation gate** — bullish pattern still `PENDING` (neckline unbroken) →
   **WATCH**, regardless of fib quality. The neckline break is the trigger.
4. **Chase guard** — `CONFIRMED` bullish pattern but price already extended far
   past the breakout (`FAR_ABOVE` F7, or a breakout that ran well beyond the
   neckline) → **WAIT** for a retest; don't chase.
5. **Confluence BUY** — `CONFIRMED` (LIVE) bullish pattern + fib buy-zone /
   shallow-orderly pullback → **BUY**, conviction higher when the base is
   pocket-anchored.

---

## Scenarios

Chart-pattern column: **Bull pattern** = Inverse H&S / Double Bottom / Cup &
Handle · **Bear pattern** = H&S / Double Top. State: **CONFIRMED-LIVE** /
**PENDING-WATCH** / **FAILED** / **WORKED** (target already hit — history).

| # | Chart pattern (state) | Fib position | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| PF1 | Bull, **CONFIRMED-LIVE** | Base/right shoulder in pocket; price `IN_POCKET_UP` / `NEAR_ABOVE` touched | **BUY** | Green | Structural reversal confirmed **at fib support** — multi-swing + location confluence, the strongest PF long. Use the pattern's measured-move target + invalidation. |
| PF2 | Bull, **CONFIRMED-LIVE** | Orderly/shallow pullback after break (`SHALLOW` F13 of the post-break leg) | **BUY** | Green | Especially for **Cup & Handle** — a shallow handle/retrace is by-design healthy continuation. Buy the hold. |
| PF3 | Bull, **PENDING-WATCH** | In / near pocket | **WATCH** | Neutral | Right structure forming at a good location, but neckline **not yet broken** — the break is the trigger. Never pre-buy. |
| PF4 | Bull, **CONFIRMED-LIVE** | Extended `FAR_ABOVE` pocket / ran well past neckline | **WAIT** | Neutral | Breakout already extended — poor R:R to the measured target. Wait for a retest of the neckline / pocket. |
| PF5 | Bull, **CONFIRMED-LIVE** | At swing high (`AT_HIGH` F12) | **WATCH** | Neutral | For a reversal/continuation breakout, a new high **is** expected — but don't buy the exact extreme; wait one bar for the hold/retest before committing. |
| PF6 | **Bear, CONFIRMED-LIVE** (H&S / Double Top) | **any** fib location | **AVOID** | Red | Topping structure confirmed — suppress all longs. The fib pocket is irrelevant once the neckline has broken down. |
| PF7 | **Bear, PENDING-WATCH** | Bullish fib location (pocket) | **CAUTION** | Amber | A top is **forming** while fib says buy-zone — conflict. Stand aside until the neckline resolves; don't buy into a building H&S/Double-Top. |
| PF8 | Bull, **FAILED** | any | **SKIP** | Red | Stop closed through — the reversal was rejected. Not a setup. |
| PF9 | Bull, **CONFIRMED-LIVE** | Below pocket & falling (`BELOW_DOWN` F8 / `AT_LOW_DOWN` F11) | **WAIT** | Neutral | Confirmation vs falling price conflict (e.g. failed retest dropping back) — wait for stabilization back above the neckline. |
| PF10 | Bull, **WORKED** (history) | any | _info only_ | Grey | Target already reached — audit/validation row, not a fresh signal. |
| PF11 | **none** | any | _passthrough_ | — | No chart pattern → defer to Fib-only. |

---

## Summary

| Verdict | Scenarios |
|---|---|
| BUY | PF1, PF2 |
| WATCH | PF3, PF5 |
| WAIT | PF4, PF9 |
| CAUTION | PF7 |
| SKIP | PF8 |
| AVOID | PF6 |
| info/history | PF10 |

**Net effect vs Fib-only:** a `CONFIRMED-LIVE` bullish chart pattern at a
fib buy-zone is the highest-quality two-factor long (structure + location, each
with its own invalidation); a `PENDING` pattern downgrades any fib-BUY to WATCH
(wait for the break); a `CONFIRMED` bearish pattern is an absolute veto over any
bullish fib reading.
