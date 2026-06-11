# Candle + Fib Verdict Scenarios (CF)

> **STATUS: DESIGN SPEC (proposed) — NOT yet wired into `rules/swing-rules.json`.**
> Today the verdict engine combines only Fib×ZOI; candlestick patterns feed the
> picker score + cosmetic confluence emphasis, never the verdict text (see
> `docs/candle-patterns.md` §"How this feeds the verdict engine"). This file
> defines the rules to ADD so a **candlestick pattern + Fib** confluence can
> produce a verdict. When implemented, `rules/swing-rules.json` becomes the
> source of truth and this doc is the human-readable reference.

Combines the **candlestick trigger** (`detectPatterns()`, see
`docs/candle-patterns.md`) with the **Fib location** (`computeFibZone()` →
`fibClass`, see `docs/fib-verdict-scenarios.md`).

- **Candle = the trigger / timing.** A single- or few-bar reversal that says
  "buyers just stepped in *here, now*."
- **Fib = the location / invalidation.** The golden pocket (61.8%–80%) is the
  long zone; 0% (swing high) is the danger zone; the swing low is the stop.

**The candle never manufactures a BUY at a bad location, and a good location
never becomes a BUY without a confirmed up-move.** Confluence raises conviction;
conflict demotes — never the reverse (per `.cursor/rules/trading-context.mdc`:
false-negatives over false-positives).

---

## Verdict precedence (resolve top-down; first match wins)

1. **Fib location VETO** — at the **swing high** (`AT_HIGH`, F12) the verdict is
   **AVOID** no matter how bullish the candle. A bull candle at the high is
   exhaustion / a bull trap, not an entry.
2. **Confirmed bearish candle demotes** — a Tier-1 **bearish** reversal candle
   (Bearish Engulfing, Evening Star, Shooting Star, Three Black Crows, Dark
   Cloud, Gravestone) inside the buy zone **suppresses the long** → WATCH /
   AVOID. Never buy when sellers just printed a reversal bar.
3. **Falling-knife guard** — below the pocket and **falling** (`BELOW_DOWN` F8 /
   `AT_LOW_DOWN` F11), a lone bullish candle does **not** upgrade to BUY → WAIT.
   (This mirrors the existing overlay rule: a hammer mid-collapse stays a plain
   arrow, never a ★ long.)
4. **Not-a-setup guard** — never reached / too shallow / extended
   (`NEAR_ABOVE` untouched F5, `FAR_ABOVE` F7, `SHALLOW` F13) → **SKIP**; a bull
   candle there is noise, not a fib entry.
5. **Confluence BUY** — valid pocket location + Tier-1 bull candle + rising
   (HH-HL) → **BUY**. Tier-2/3 or neutral candle at the same spot → **WATCH**
   (weaker trigger needs confirmation).
6. **No candle pattern** → pass through to **Fib-only** (`docs/fib-verdict-scenarios.md`).

---

## Scenarios

Candle column: **Bull T1** = Tier-1 bullish reversal · **Bull T2/3** = weaker
bullish · **Bear T1** = Tier-1 bearish reversal · **Neutral** = Doji / Inside
Bar / NR4 (indecision-compression).

| # | Candle | Fib position | Verdict | Color | Reasoning |
|---|---|---|---|---|---|
| CF1 | Bull T1 | Inside golden pocket, rising (`IN_POCKET_UP` F1/F2) | **BUY** | Green | Textbook fib bounce **with** a confirming reversal bar — the highest-conviction CF long. |
| CF2 | Bull T1 | 1%–20% above pocket, **touched** & rising (`NEAR_ABOVE` F4) | **BUY** | Green | Pocket was tested and held; the candle confirms continuation off it. |
| CF3 | Bull T1 | In pocket but still **falling** (`IN_POCKET_DOWN` F3) | **WATCH** | Neutral | Reversal bar printed but the pocket is still being worked; wait for HH-HL / a higher close before buying. |
| CF4 | Bull T1 | Below pocket, rising toward it (`BELOW_UP` F9 / `AT_LOW_UP` F10) | **WAIT** | Neutral | Bar is early — price hasn't reclaimed the pocket. Let it get back into 61.8%–80%. |
| CF5 | Bull T1 | Below pocket, **falling** (`BELOW_DOWN` F8 / `AT_LOW_DOWN` F11) | **WAIT** | Neutral | Falling knife. A lone bullish candle mid-collapse is the classic false long — no BUY. |
| CF6 | Bull T1 | Never reached / shallow / extended (`NEAR_ABOVE` untouched F5, `FAR_ABOVE` F7, `SHALLOW` F13) | **SKIP** | Red | Not a valid fib setup; the candle doesn't rescue a non-entry. |
| CF7 | Bull T1 | At swing high (`AT_HIGH` F12) | **AVOID** | Red | Location veto — bullish bar at the top = exhaustion / trap, no upside, wide-stop risk. |
| CF8 | Bull **T2/3** | Inside pocket, rising (`IN_POCKET_UP`) | **WATCH** | Neutral | Right location, but a weak trigger (Inverted Hammer, Harami, Tweezer, Marubozu) needs confirmation — demoted vs CF1. |
| CF9 | **Neutral** (Doji / Inside Bar / NR4) | Inside pocket (`IN_POCKET_*`) | **WATCH** | Neutral | Indecision / coiling at the pocket — wait for the directional break. |
| CF10 | **Bear T1** | Bullish fib location (`IN_POCKET_UP`, `NEAR_ABOVE` touched) | **CAUTION** | Amber | Sellers printed a reversal **inside the buy zone** — long trigger killed. Stand aside; wait for a bull candle. |
| CF11 | **Bear T1** | At high / extended (`AT_HIGH` F12, `FAR_ABOVE` F7) | **AVOID** | Red | Confluent bearish — bearish bar at the top. Strong suppress (this is an exit context in a long-only app). |
| CF12 | **none** | any | _passthrough_ | — | No candle pattern → defer entirely to Fib-only (CF layer only adds/subtracts conviction, never gates the base fib verdict). |

---

## Summary

| Verdict | Scenarios |
|---|---|
| BUY | CF1, CF2 |
| WATCH | CF3, CF8, CF9 |
| WAIT | CF4, CF5 |
| CAUTION | CF10 |
| SKIP | CF6 |
| AVOID | CF7, CF11 |

**Net effect vs Fib-only:** a Tier-1 bull candle **upgrades** F1/F4 conviction
(still BUY, but flagged high-confidence) and lets the engine label *why now*; a
bearish/neutral candle **downgrades** an otherwise-BUY pocket to WATCH/CAUTION;
no candle ever upgrades a falling-knife, shallow, extended, or swing-high fib
state into a BUY.
