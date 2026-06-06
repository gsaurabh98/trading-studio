# Verdict Scenarios

> **Source of truth**: `data/verdict-rules.json` — the code reads rules from this JSON file at runtime.
> Edit the JSON to change verdicts; this doc is a human-readable reference only.

## Fib Only Scenarios (13 total)

Price position relative to Fibonacci retracement levels (0% = swing high, 100% = swing low, golden pocket = 61.8%–80%)

**Rule: BUY only when price is INSIDE the golden pocket (61.8%–80%) AND moving up, OR has bounced FROM the pocket and is now 1%–20% above it with HH-HL confirmed.**

| # | Price Position | Direction | History | Verdict | Color | Reasoning |
|---|---|---|---|---|---|---|
| F1 | Inside golden pocket (61.8%–80%) | Moving up (HH-HL) | — | **BUY** | Green | Inside golden pocket & rising — confirmed fib bounce |
| F2 | Inside golden pocket (61.8%–80%) | Moving up (HH-HL) | Recovery from below (was deep) | **BUY** | Green | Recovery from swing low into pocket — strong reversal |
| F3 | Inside golden pocket (61.8%–80%) | Moving down (entering/falling) | — | **WAIT** | Neutral | In pocket but still falling — wait for HH-HL bounce |
| F4 | 1%–20% above pocket | Moving up (HH-HL) | Came FROM golden pocket (touched/was inside) | **BUY** | Green | Bounced from pocket & rising — pocket tested and held |
| F5 | 1%–20% above pocket | Moving up (HH-HL) | Did NOT reach golden pocket | **SKIP** | Red | Never entered pocket — not a valid fib setup |
| F6 | 1%–20% above pocket | Moving down (toward pocket) | — | **WAIT** | Neutral | Approaching pocket — wait until price enters 61.8%–80% |
| F7 | >20% above pocket (above 38.2%) | Any | — | **SKIP** | Red | Too far above pocket — missed the move |
| F8 | Below golden pocket (80%–97%) | Moving down | — | **WAIT** | Neutral | Below pocket & falling — don't catch falling knife |
| F9 | Below golden pocket (80%–97%) | Moving up (toward pocket) | — | **WAIT** | Neutral | Rising toward pocket — wait for entry into 61.8%–80% |
| F10 | At/near 100% (swing low) | Moving up | — | **WAIT** | Neutral | At swing low — wait for recovery into pocket |
| F11 | At/near 100% (swing low) | Moving down / flat | — | **WAIT** | Neutral | At swing low & falling — wait for momentum |
| F12 | At/near 0% (swing high) | Any | — | **AVOID** | Red | At swing high — no upside, high reversal risk |
| F13 | Shallow retracement (23.6%–38.2%) | Any | — | **SKIP** | Red | Shallow retracement — not deep enough for fib entry |

### Key distinctions:

**F1 vs F2** — Both are BUY inside the golden pocket with HH-HL:
- **F1**: Normal scenario — price retraced from swing high into the pocket and bounced.
- **F2**: Recovery scenario — price was deep (near swing low), recovered back into the pocket, and is rising. Detected via `bounceStatus: "RECOVERY"` from `computeFibZone()`.

**F4 vs F5** — Both are 1%–20% above pocket with HH-HL, but:
- **F4 (BUY)**: Price was inside/touched the golden pocket in recent candles, then bounced up. This is a confirmed fib bounce — the pocket was tested and held. Detected via `touchedZone: true`.
- **F5 (SKIP)**: Price only pulled back from above to 1%–20% above the pocket. Never actually entered the golden zone. NOT a fib entry. Detected via `touchedZone: false`.

**F7 vs F13** — Both are SKIP (too far above), but:
- **F7**: Price is in the 38.2%–61.8% range but >20% price distance above the 61.8% level.
- **F13**: Price is in the 23.6%–38.2% retracement range (very shallow pullback).

### `fibClass` → scenario mapping:

| fibClass | Condition | Scenario |
|---|---|---|
| `IN_POCKET_UP` | bounceStatus = RECOVERY | F2 |
| `IN_POCKET_UP` | bounceStatus ≠ RECOVERY | F1 |
| `IN_POCKET_DOWN` | — | F3 |
| `NEAR_ABOVE` | touchedZone = true | F4 |
| `NEAR_ABOVE` | touchedZone = false | F5 |
| `NEAR_ABOVE_DOWN` | — | F6 |
| `FAR_ABOVE` | — | F7 |
| `BELOW_DOWN` | — | F8 |
| `BELOW_UP` | — | F9 |
| `AT_LOW_UP` | — | F10 |
| `AT_LOW_DOWN` | — | F11 |
| `AT_HIGH` | — | F12 |
| `SHALLOW` | — | F13 |

### `touchedZone` detection:
The `computeFibZone()` function checks recent 8 candles for any low that fell within or near the 61.8%–80% zone. If found → `touchedZone = true` (F4 applies). If not → `touchedZone = false` (F5 applies).

### `bounceStatus` values:
- `BOUNCE` — was in zone, now above 61.8% and rising
- `RECOVERY` — was deep (below 80%), now rising back into zone
- `FORMING` — currently in zone, rising (green candle)
- `FALLING` — in zone or below, but falling
- `ABOVE` — well above zone
