# ZOI (Zone of Interest) Verdict Scenarios

> **Source of truth**: `rules/swing-rules.json` — the code reads rules from this JSON file at runtime.
> Edit the JSON to change verdicts; this doc is a human-readable reference only.

## ZOI Only Scenarios

Zone of Interest = institutional supply/demand zones detected via RBR / DBR / DBD / RBD (leg → base → leg) framework.

**Direction rule (3-way momentum):** the zone-interior states (inside demand / inside supply) are graded on a 3-way read, not a boolean:
- **RISING** — HH-HL confirmed (≥2/3 highs rising + ≥2/3 lows rising over last 4 confirmed candles).
- **FALLING** — a clear down-sequence (≥2/3 lower-highs **and** ≥2/3 lower-lows).
- **CONSOLIDATING** — a tight, low-volatility base (mean of last 3 bars' range ≤ 0.6× the stock's ATR%) **or** no clear directional structure (choppy/flat). Fails safe to CONSOLIDATING on sparse data.

**Core rule: BUY only when price is AT/NEAR demand zone AND making HH-HL. A flat base on the demand floor (consolidating) is a WATCH (constructive but no trigger yet); falling through demand is AVOID. Anything inside supply is a non-BUY (FALLING = AVOID; RISING/CONSOLIDATING = WATCH until a confirmed break above the zone).**

---

## Demand Zone Scenarios

| # | Price Position | HH-HL | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| Z1 | Inside demand zone | Rising (HH-HL) | **BUY** | Green | Institutional support + structural uptrend = valid entry |
| Z2 | Inside demand zone | Falling (clear down-seq) | **AVOID** | Red | Demand zone breaking down — don't catch falling knife |
| Z2b | Inside demand zone | Consolidating (tight base) | **WATCH** | Neutral | Holding support and coiling, but no bounce trigger yet — watch for HH-HL to flip it to BUY |
| Z3 | 1%–10% above demand (just bounced) | Yes | **BUY** | Green | Recently bounced off demand with momentum — entry valid |
| Z4 | 1%–10% above demand (just bounced) | No (flat/weak) | **WATCH** | Neutral | Near demand but no structural confirmation — wait for HH-HL |
| Z5 | >10% above demand | Any | **WAIT** | Neutral | Extended away from the only support — chasing = wide stop / poor R:R, even with momentum. Wait for a pullback |
| Z5c | Was below demand, now inside demand zone | Yes (HH-HL) | **BUY** | Green | Recovery into demand zone — institutional level reclaimed with momentum |
| Z5d | Was below demand, now above demand zone (1%–10%) | Yes (HH-HL) | **BUY** | Green | Recovered through demand and rising — zone held as springboard |
| Z6 | Broke below demand (below distal) | Any | **AVOID** | Red | Demand zone invalidated — institutional support failed |

---

## Supply Zone Scenarios

| # | Price Position | HH-HL | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| Z7a | Inside supply zone | Rising (HH-HL) | **WATCH** | Neutral | Pushing up into resistance — breakout brewing but NOT confirmed; wait for a close above the zone |
| Z7b | Inside supply zone | Consolidating (tight base) | **WATCH** | Neutral | Tug-of-war under resistance — can resolve either way; wait for a confirmed break above |
| Z7c | Inside supply zone | Falling (rejecting) | **AVOID** | Red | Active institutional selling — textbook supply rejection |
| Z8 | 1%–10% below supply (approaching) | Any | **AVOID** | Red | Heading into resistance — don't buy into ceiling |
| Z9 | >10% below supply | Any | **WAIT** | Neutral | Supply too far overhead — not a factor yet |
| Z10 | Broke above supply (≤5%) | Yes (HH-HL) | **BUY** | Green | Supply zone flipped to support — momentum/breakout entry |
| Z11 | Broke above supply (≤5%) | No (falling back) | **AVOID** | Red | Failed breakout — bull trap, price rejected back into supply |
| Z11b | Broke above supply, ran >5% past it | Any | **WAIT** | Neutral | Breakout already happened and price is extended — don't chase, wait for pullback to flipped zone |

---

## No Zone / Between Zone Scenarios

| # | Price Position | HH-HL | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| Z12 | Between zones (no zone near) | Any | **WAIT** | Neutral | Price not near any zone — no ZOI verdict, run FIB for entry |
| Z13 | Stacked demand (2+ zones overlap) | Yes (HH-HL) | **BUY** | Green | Multi-zone confluence = highest conviction ZOI signal |

---

## Summary

| Verdict | Count | Scenarios |
|---|---|---|
| BUY | 6 | Z1, Z3, Z5c, Z5d, Z10, Z13 |
| WATCH | 4 | Z2b, Z4, Z7a, Z7b |
| WAIT | 4 | Z5, Z9, Z11b, Z12 |
| AVOID | 5 | Z2, Z6, Z7c, Z8, Z11 |
| **Total** | **19** | |

---

## Key Thresholds

| Parameter | Value |
|---|---|
| "Inside" demand | Between zone.distal and zone.proximal |
| "At/near" demand | Inside zone or ≤ 10% above proximal |
| "Approaching" supply | ≤ 10% below supply zone proximal |
| Supply "not relevant" | > 10% below supply |
| "Broke below" demand | Price closed below zone.distal |
| "Broke above" supply | Price closed above zone.distal |
| Demand "no longer actionable" | > 10% above demand (always WAIT — Z5) |
| HH-HL confirmation (RISING) | 2/3 highs rising + 2/3 lows rising over last 4 candles |
| FALLING (down-sequence) | ≥2/3 lower-highs AND ≥2/3 lower-lows over last 4 confirmed candles |
| CONSOLIDATING (tight base) | mean of last 3 bars' (high−low)/close ≤ 0.6× the stock's ATR%, or no clear up/down sequence |
| Supply breakout "extended" | > 5% above supply distal → WAIT (Z11b), don't chase |
| Stacked zones | 2+ demand zones with overlapping ranges or proximals within 2% |

---

## `zone` / position → scenario mapping:

| Position | HH-HL | Extra | Scenario |
|---|---|---|---|
| Inside demand | Rising | — | Z1 |
| Inside demand | Falling | — | Z2 |
| Inside demand | Consolidating | tight base / flat | Z2b |
| 1%-10% above demand | Yes | — | Z3 |
| 1%-10% above demand | No | — | Z4 |
| >10% above demand | Any | — | Z5 |
| Was below demand, now inside demand | Yes | Came from below | Z5c |
| Was below demand, now 1%-10% above demand | Yes | Came from below | Z5d |
| Below demand distal | Any | — | Z6 |
| Inside supply | Rising | — | Z7a |
| Inside supply | Consolidating | tight base / flat | Z7b |
| Inside supply | Falling | — | Z7c |
| 1%-10% below supply | Any | — | Z8 |
| >10% below supply | Any | — | Z9 |
| Above supply distal (≤5%) | Yes | — | Z10 |
| Above supply distal (≤5%) | No | — | Z11 |
| Above supply distal (>5%) | Any | Extended | Z11b |
| No zone within range | Any | — | Z12 |
| Stacked demand | Yes | 2+ zones | Z13 |
