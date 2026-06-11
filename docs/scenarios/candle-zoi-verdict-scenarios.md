# Candle + ZOI Verdict Scenarios (CZ)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Candlestick patterns feed the picker score + cosmetic emphasis only; they do
> not yet feed the ZOI verdict. This file defines the **candlestick pattern +
> ZOI** confluence rules to add.

Combines the **candlestick trigger** (`detectPatterns()`) with the **Zone of
Interest** location (`_classifyZoiPosition()` → `zoiPosition`, see
`docs/zoi-verdict-scenarios.md`).

- **Candle = the trigger / timing** — buyers/sellers stepping in *here, now*.
- **ZOI = the institutional location / invalidation** — demand (floor / buy
  zone), supply (ceiling / danger), and the structural stop is the zone's distal
  edge.

**A bullish candle at demand confirms; a bullish candle at/into supply is a
trap.** The zone defines whether a long is even allowed; the candle times it.

---

## Verdict precedence (resolve top-down; first match wins)

1. **Supply / broken-demand VETO** — at supply, approaching supply (≤10%),
   inside a failed breakout, demand breaking down, or broken below demand
   (`Z7`, `Z8`, `Z11`, `Z2`, `Z6`) → **AVOID**. A bull candle into resistance or
   on a breaking floor is a trap.
2. **Confirmed bearish candle demotes** — a Tier-1 bearish reversal candle at a
   bullish location suppresses the long → **CAUTION**.
3. **Confirmation gate** — at/above demand but **not** making HH-HL (`Z4`), a
   lone bull candle → **WATCH** (early sign; wait for structure).
4. **No-zone guard** — far from any zone (`Z5` >10% above demand, `Z9`, `Z12`
   between, `Z11b` extended) → **WAIT**; a candle alone is not a setup.
5. **Confluence BUY** — at/near demand (or supply-flip / stacked demand) +
   Tier-1 bull candle + rising (HH-HL) → **BUY**, conviction scaling with zone
   quality (stacked demand strongest).
6. **No candle pattern** → pass through to **ZOI-only**.

---

## Scenarios

Candle column: **Bull T1** = Tier-1 bullish reversal · **Bull T2/3** = weaker
bullish · **Bear T1** = Tier-1 bearish reversal · **Neutral** = Doji / Inside
Bar / NR4.

| # | Candle | ZOI position | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| CZ1 | Bull T1 | Inside demand, rising (`Z1`) | **BUY** | Green | Reversal bar **at institutional demand** with structural uptrend — textbook ZOI long. |
| CZ2 | Bull T1 | 1%–10% above demand, just bounced & rising (`Z3`) | **BUY** | Green | Bounced off demand with a confirming bar — entry valid. |
| CZ3 | Bull T1 | Recovery into / above demand (`Z5c` / `Z5d`) | **BUY** | Green | Reclaimed the demand level with momentum + a confirming candle. |
| CZ4 | Bull T1 | Broke above supply ≤5%, rising (`Z10`) | **BUY** | Green | Supply flipped to support; the candle confirms the breakout hold. |
| CZ5 | Bull T1 | Stacked demand (`Z13`) | **BUY** | Green | Multi-zone confluence **+** confirming bar — highest-conviction CZ long. |
| CZ6 | Bull T1 | At/above demand, **no HH-HL** (`Z4`) | **WATCH** | Neutral | Right place, candle is an early sign, but no structural confirmation yet — wait for HH-HL. |
| CZ7 | Bull T1 | Demand breaking down (`Z2`) / broke below demand (`Z6`) | **AVOID** | Red | Zone failing / invalidated — a lone bull candle doesn't reclaim a broken floor. Falling knife. |
| CZ8 | Bull T1 | Inside supply (`Z7`) / approaching supply ≤10% (`Z8`) | **AVOID** | Red | Location veto — bullish bar **into the ceiling** is a trap; expect rejection. |
| CZ9 | Bull T1 | Failed supply breakout (`Z11`) | **AVOID** | Red | Bull trap confirmed — price rejected back into supply. |
| CZ10 | Bull T1 | Far from zones (`Z5` >10% above demand, `Z9`, `Z12`, `Z11b`) | **WAIT** | Neutral | No actionable zone nearby — candle alone isn't a setup. Run Fib for entry. |
| CZ11 | **Bear T1** | Bullish demand location (`Z1`/`Z3`/`Z5c`/`Z5d`/`Z13`) | **CAUTION** | Amber | Sellers printed a reversal at demand — long trigger killed. Wait for a bull candle (or zone failure → AVOID). |
| CZ12 | **Bear T1** | At/approaching supply (`Z7`/`Z8`) | **AVOID** | Red | Confluent bearish — bearish bar at the ceiling. Strong suppress. |
| CZ13 | **Bull T2/3** | At/near demand (`Z1`/`Z3`) | **WATCH** | Neutral | Weak trigger (Inverted Hammer, Harami, Tweezer, Marubozu) at a good zone — needs confirmation; demoted vs CZ1. |
| CZ14 | **Neutral** (Doji / Inside Bar / NR4) | At/near demand | **WATCH** | Neutral | Coiling/indecision at support — wait for the directional break. |
| CZ15 | **none** | any | _passthrough_ | — | No candle pattern → defer to ZOI-only. |

---

## Summary

| Verdict | Scenarios |
|---|---|
| BUY | CZ1, CZ2, CZ3, CZ4, CZ5 |
| WATCH | CZ6, CZ13, CZ14 |
| WAIT | CZ10 |
| CAUTION | CZ11 |
| AVOID | CZ7, CZ8, CZ9, CZ12 |

**Net effect vs ZOI-only:** a Tier-1 bull candle confirms/upgrades a demand-zone
bounce and times the entry; a bearish/neutral/weak candle downgrades it to
WATCH/CAUTION; no candle ever turns a supply-zone, broken-demand, or no-zone
state into a BUY.
