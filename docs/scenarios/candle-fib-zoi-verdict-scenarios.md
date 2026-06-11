# Candle + Fib + ZOI Verdict Scenarios (CFZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Today `fibZoiCombined` (Fib×ZOI) IS implemented; the **candlestick trigger** is
> NOT yet layered on top. This file defines the **candle + Fib + ZOI** rules to
> add — the candle becomes a conviction/timing modifier on the existing Fib×ZOI
> base verdict.

This combination **extends the live Fib×ZOI engine**
(`docs/fib-verdict-scenarios.md` + `docs/zoi-verdict-scenarios.md` →
`fibZoiCombined`, e.g. `F1xZ1xOVL`). The Fib×ZOI rule already yields a base
verdict; the **candle modifies it**:

- **Fib + ZOI = the location & invalidation** (the structural truth — where
  price is, and where the thesis dies).
- **Candle = the trigger / timing** layered on top — *is a buyer stepping in
  right now, at this confluence?*

**The candle can only confirm/upgrade a structural BUY or demote it — it can
NEVER upgrade a structural AVOID/SKIP into a BUY.** This is the precedence the
previous turn flagged: a bullish candle at supply / a broken floor / the swing
high stays AVOID.

---

## Verdict precedence (resolve top-down; first match wins)

1. **Base Fib×ZOI = AVOID/SKIP → stays AVOID/SKIP.** A bullish candle at a
   vetoed location (supply, broken demand, swing high, demand breaking) is a
   **trap**; never upgrade. A *bearish* candle there → AVOID (reinforced).
2. **Base Fib×ZOI = BUY + Tier-1 bull candle → STRONG BUY.** Triple confluence
   (location + structure + trigger) — the engine's highest conviction.
3. **Base Fib×ZOI = BUY + bearish/neutral/weak candle → demote to WATCH/CAUTION.**
   Sellers (or indecision) just printed at the confluence — wait for a bull bar.
4. **Base Fib×ZOI = WATCH/WAIT + Tier-1 bull candle + HH-HL → may upgrade to
   BUY** *only* when the location is genuinely bullish (in pocket / at demand)
   and structure confirms; otherwise stays WATCH/WAIT.
5. **Base Fib×ZOI = WAIT (extended / no-zone / approaching) → stays WAIT.** A
   candle doesn't fix "too far to chase."

---

## Scenarios

`Base` = the verdict the existing Fib×ZOI rule already returns. Candle column as
in `docs/candle-fib-verdict-scenarios.md`.

| # | Base (Fib×ZOI) | Candle | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| CFZ1 | **BUY** — pocket ∩ demand overlap (`F1xZ1xOVL`-class) | Bull T1 | **STRONG BUY** | Green | Golden pocket overlapping demand **with** a confirming reversal bar — the A-grade triple confluence. Conviction max. |
| CFZ2 | **BUY** — pocket bounce or demand bounce (any combined BUY) | Bull T1 | **BUY** | Green | Structural BUY confirmed and timed by a Tier-1 bull candle. |
| CFZ3 | **BUY** (any combined BUY) | Bull T2/3 | **BUY** | Green | Still a BUY (location carries it), but flag standard conviction — the trigger is weak, not absent. |
| CFZ4 | **BUY** (any combined BUY) | Neutral (Doji / Inside Bar / NR4) | **WATCH** | Neutral | Indecision printed at the confluence — let the coil break up before committing. |
| CFZ5 | **BUY** (any combined BUY) | **Bear T1** | **CAUTION** | Amber | Sellers printed a reversal **at the buy confluence** — stand aside; wait for a bull candle or zone/fib failure. |
| CFZ6 | **WATCH** — e.g. at demand no HH-HL (`Z4`) / in pocket falling (`F3`) | Bull T1 + HH-HL | **BUY** | Green | The missing trigger arrived at a bullish location with structure — upgrade WATCH → BUY. |
| CFZ7 | **WATCH** | Bull T1, **no** HH-HL | **WATCH** | Neutral | Bar printed but structure not yet confirmed — hold. |
| CFZ8 | **WAIT** — extended / between / approaching (`Z5`,`Z12`,`Z11b`,`F7`) | any candle | **WAIT** | Neutral | Too far / no zone — a candle doesn't make a chase a setup. |
| CFZ9 | **AVOID** — supply / broke demand / demand breaking (`Z7`,`Z8`,`Z11`,`Z6`,`Z2`) | Bull T1 | **AVOID** | Red | Location veto — a bullish bar into resistance / on a breaking floor is a trap. Never upgrade. |
| CFZ10 | **AVOID** — at swing high (`F12`) | Bull T1 | **AVOID** | Red | Exhaustion bar at the top — no upside, high reversal risk. |
| CFZ11 | **AVOID** (any vetoed location) | **Bear T1** | **AVOID** | Red | Confluent bearish — reinforced suppress (exit context). |
| CFZ12 | **SKIP** — not a fib setup (`F5`/`F7`/`F13` with no zone) | any candle | **SKIP** | Red | Not a valid setup; the candle is noise here. |

---

## Summary

| Verdict | Scenarios |
|---|---|
| STRONG BUY | CFZ1 |
| BUY | CFZ2, CFZ3, CFZ6 |
| WATCH | CFZ4, CFZ7 |
| WAIT | CFZ8 |
| CAUTION | CFZ5 |
| SKIP | CFZ12 |
| AVOID | CFZ9, CFZ10, CFZ11 |

**Net effect:** the candle is a **modifier**, not a gate. It promotes a
structural BUY to STRONG BUY (or upgrades a WATCH that was only missing a
trigger), and demotes a BUY when sellers/indecision print — but the underlying
Fib×ZOI location always decides whether a long is *allowed* at all.
