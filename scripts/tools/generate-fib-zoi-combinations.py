#!/usr/bin/env python3
"""Generate Fib x ZOI x pocket-vs-zone scenarios.

.. warning::
   **STALE / NOT WIRED TO LIVE (as of 2026-06-05).** This script writes to a
   ``fibZoiCombinedProposed`` key and uses OLD engine ``fibClass`` names
   (``IN_POCKET_UP`` etc.). The LIVE matcher reads ``fibZoiCombined`` with the
   CURRENT names (``IN_POCKET_RISING`` etc.) — the two have diverged, so running
   this does NOT change live behaviour. To edit the live combined matrix today,
   edit ``data/verdict-rules.json`` directly, or use
   ``scripts/tools/expand-zoi-momentum-combined.py`` for the ZOI momentum clones.
   This generator is kept only as the historical design reference for the
   combinator logic; re-aligning it to the live schema is a separate task.

Outputs
-------
1. ``data/fib-zoi-combinations.csv`` — human review sheet (one row per scenario).
2. ``data/verdict-rules.json`` — injects the same scenarios under a NEW key
   ``fibZoiCombinedProposed`` (matcher-ready: real engine ``fibClass`` plus
   ``zoiPosition`` + ``pocketVsZone`` + optional ``touchedZone``/``bounceStatus``).
   The live ``fibZoiCombined`` array and the JS matcher are LEFT UNTOUCHED — the
   new schema only goes live once the matcher is updated to read these fields.

Why the third axis
------------------
"Fib + demand" only means something when the two price bands ALIGN. So every
scenario carries:

    pocket_vs_zone in { OVERLAP, POCKET_ABOVE, POCKET_BELOW }

OVERLAP      = pocket and zone share a price band (TRUE confluence).
POCKET_ABOVE = pocket sits entirely above the zone.
POCKET_BELOW = pocket sits entirely below the zone.

The axis is GEOMETRY-PRUNED: fib_class and zoi_position are both derived from
the SAME current price, so only physically-possible band arrangements are
emitted (431 minus 9 impossible far-zone overlaps = 422 real scenarios).

Verdicts come from a documented combinator (``combined_verdict``), not a hand
matrix. Safety bias per the trading rules: BUY only on confirmed bullish
alignment; supply OVERLAP with a long fib is never a BUY; ambiguous -> WAIT.

Run
---
    python3 scripts/tools/generate-fib-zoi-combinations.py
"""
from __future__ import annotations

import csv
import json
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Optional

# --------------------------------------------------------------------------
# Dimensions
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class FibRule:
    rule_id: str
    fib_class: str          # display label for the CSV
    engine_class: str       # raw fibClass the JS engine emits
    touched: Optional[bool]  # touchedZone discriminator (NEAR_ABOVE split)
    bounce: Optional[str]    # bounceStatus discriminator (IN_POCKET_UP split)
    verdict: str            # standalone fib-only verdict
    px_vs_pocket: str       # 'IN' | 'ABOVE' | 'BELOW'  (price vs 80%-61.8% band)
    short: str              # concise label for the sub line
    desc: str


@dataclass(frozen=True)
class ZoiRule:
    rule_id: str
    position: str
    zone: str               # 'demand' | 'supply' | 'none'
    polarity: str           # 'bull' | 'pend' | 'bear'
    verdict: str            # standalone zoi-only verdict
    px_vs_zone: str         # 'IN' | 'ABOVE' | 'BELOW' | 'NONE'
    short: str
    desc: str


FIB_RULES: Final[tuple[FibRule, ...]] = (
    FibRule("F1", "IN_POCKET_UP", "IN_POCKET_UP", None, None, "BUY", "IN",
            "in pocket, rising",
            "price is inside the golden pocket (61.8-80%) and making HH-HL (confirmed fib bounce)"),
    FibRule("F2", "IN_POCKET_UP+RECOVERY", "IN_POCKET_UP", None, "RECOVERY", "BUY", "IN",
            "pocket recovery, rising",
            "price recovered from near the swing low back into the golden pocket and is making HH-HL (reversal)"),
    FibRule("F3", "IN_POCKET_DOWN", "IN_POCKET_DOWN", None, None, "WAIT", "IN",
            "in pocket, falling",
            "price is inside the golden pocket but still falling (no HH-HL bounce yet)"),
    FibRule("F4", "NEAR_ABOVE (touched)", "NEAR_ABOVE", True, None, "BUY", "ABOVE",
            "bounced from pocket",
            "price touched the golden pocket and bounced 1-20% above it with HH-HL"),
    FibRule("F5", "NEAR_ABOVE (not touched)", "NEAR_ABOVE", False, None, "SKIP", "ABOVE",
            "above pocket (never touched)",
            "price is 1-20% above the pocket but never entered it (not a valid fib setup)"),
    FibRule("F6", "NEAR_ABOVE_DOWN", "NEAR_ABOVE_DOWN", None, None, "WAIT", "ABOVE",
            "above pocket, falling in",
            "price is 1-20% above the pocket and falling toward it"),
    FibRule("F7", "FAR_ABOVE", "FAR_ABOVE", None, None, "SKIP", "ABOVE",
            "far above pocket",
            "price is >20% above the pocket (missed the move)"),
    FibRule("F8", "BELOW_DOWN", "BELOW_DOWN", None, None, "WAIT", "BELOW",
            "below pocket, falling",
            "price is below the pocket and still falling (falling knife)"),
    FibRule("F9", "BELOW_UP", "BELOW_UP", None, None, "WAIT", "BELOW",
            "below pocket, rising",
            "price is below the pocket but rising toward it"),
    FibRule("F10", "AT_LOW_UP", "AT_LOW_UP", None, None, "WAIT", "BELOW",
            "at swing low, recovering",
            "price is at the swing low and starting to recover"),
    FibRule("F11", "AT_LOW_DOWN", "AT_LOW_DOWN", None, None, "WAIT", "BELOW",
            "at swing low, falling",
            "price is at the swing low and still falling"),
    FibRule("F12", "AT_HIGH", "AT_HIGH", None, None, "AVOID", "ABOVE",
            "at swing high",
            "price is at the swing high (0% retracement, no upside left)"),
    FibRule("F13", "SHALLOW", "SHALLOW", None, None, "SKIP", "ABOVE",
            "shallow pullback",
            "price retraced only to the 23.6-38.2% zone (too shallow for a fib entry)"),
    FibRule("F14", "RECOVERED_ABOVE", "RECOVERED_ABOVE", None, None, "SKIP", "ABOVE",
            "recovered above pocket",
            "price already recovered above the pocket (the bounce happened, entry missed)"),
)

ZOI_RULES: Final[tuple[ZoiRule, ...]] = (
    ZoiRule("Z1", "INSIDE_DEMAND_UP", "demand", "bull", "BUY", "IN",
            "in demand, rising",
            "price is inside a demand zone and rising (institutional support confirmed)"),
    ZoiRule("Z2", "INSIDE_DEMAND_DOWN", "demand", "bear", "AVOID", "IN",
            "in demand, falling",
            "price is inside a demand zone but falling (zone breaking down)"),
    ZoiRule("Z3", "NEAR_ABOVE_DEMAND_UP", "demand", "bull", "BUY", "ABOVE",
            "above demand, rising",
            "price bounced 1-10% above a demand zone with momentum"),
    ZoiRule("Z4", "NEAR_ABOVE_DEMAND_DOWN", "demand", "pend", "WATCH", "ABOVE",
            "above demand, no HH-HL",
            "price is 1-10% above a demand zone but with no HH-HL"),
    ZoiRule("Z5", "FAR_ABOVE_DEMAND", "demand", "pend", "WAIT", "ABOVE",
            "far above demand",
            "price is >10% above the nearest demand zone (extended)"),
    ZoiRule("Z5c", "RECOVERY_INSIDE_DEMAND", "demand", "bull", "BUY", "IN",
            "reclaimed demand",
            "price recovered from below back into a demand zone (level reclaimed)"),
    ZoiRule("Z5d", "RECOVERY_ABOVE_DEMAND", "demand", "bull", "BUY", "ABOVE",
            "sprang above demand",
            "price recovered through a demand zone and is 1-10% above it"),
    ZoiRule("Z6", "BELOW_DEMAND", "demand", "bear", "AVOID", "BELOW",
            "below demand",
            "price closed below the demand zone (support invalidated)"),
    ZoiRule("Z13", "STACKED_DEMAND", "demand", "bull", "BUY", "IN",
            "stacked demand",
            "2+ demand zones overlap here (multi-zone confluence)"),
    ZoiRule("Z7", "INSIDE_SUPPLY", "supply", "bear", "AVOID", "IN",
            "in supply",
            "price is inside a supply zone (active institutional selling)"),
    ZoiRule("Z8", "NEAR_BELOW_SUPPLY", "supply", "bear", "AVOID", "BELOW",
            "below supply",
            "price is 1-10% below a supply zone (resistance overhead)"),
    ZoiRule("Z9", "FAR_BELOW_SUPPLY", "supply", "pend", "WAIT", "BELOW",
            "supply far overhead",
            "the nearest supply zone is >10% overhead (not a factor)"),
    ZoiRule("Z10", "ABOVE_SUPPLY_UP", "supply", "bull", "BUY", "ABOVE",
            "broke above supply",
            "price broke above a supply zone and is rising (breakout, old resistance now support)"),
    ZoiRule("Z11", "ABOVE_SUPPLY_DOWN", "supply", "bear", "AVOID", "ABOVE",
            "failed breakout",
            "price broke above supply but is falling back (failed breakout / bull trap)"),
    ZoiRule("Z11b", "ABOVE_SUPPLY_EXTENDED", "supply", "pend", "WAIT", "ABOVE",
            "extended above supply",
            "price ran >5% past the broken supply zone (extended)"),
    ZoiRule("Z12", "BETWEEN", "none", "pend", "WAIT", "NONE",
            "between zones",
            "price is between zones (no demand or supply nearby)"),
)

# --------------------------------------------------------------------------
# Geometry: physically-possible pocket_vs_zone per (px_vs_pocket, px_vs_zone).
#   OVERLAP : bands intersect | POCKET_ABOVE : P_lo > Z_hi | POCKET_BELOW : P_hi < Z_lo
# --------------------------------------------------------------------------
ALLOWED_REL: Final[dict[tuple[str, str], tuple[str, ...]]] = {
    ("IN", "IN"):       ("OVERLAP",),
    ("IN", "ABOVE"):    ("OVERLAP", "POCKET_ABOVE"),
    ("IN", "BELOW"):    ("OVERLAP", "POCKET_BELOW"),
    ("ABOVE", "IN"):    ("OVERLAP", "POCKET_BELOW"),
    ("BELOW", "IN"):    ("OVERLAP", "POCKET_ABOVE"),
    ("ABOVE", "ABOVE"): ("OVERLAP", "POCKET_ABOVE", "POCKET_BELOW"),
    ("BELOW", "BELOW"): ("OVERLAP", "POCKET_ABOVE", "POCKET_BELOW"),
    ("ABOVE", "BELOW"): ("POCKET_BELOW",),
    ("BELOW", "ABOVE"): ("POCKET_ABOVE",),
}

# Zones explicitly FAR from price: cannot OVERLAP a pocket that price sits IN.
FAR_ZONES: Final[frozenset[str]] = frozenset({"Z5", "Z9", "Z11b"})

REL_SHORT: Final[dict[str, str]] = {
    "OVERLAP": "OVL", "POCKET_ABOVE": "PABV", "POCKET_BELOW": "PBLW", "N/A": "NA",
}
REL_TAG: Final[dict[str, str]] = {
    "OVERLAP": "same price",
    "POCKET_ABOVE": "pocket above zone",
    "POCKET_BELOW": "pocket below zone",
    "N/A": "no zone",
}
REL_PHRASE: Final[dict[str, str]] = {
    "OVERLAP": "the golden pocket and the zone occupy the SAME price band (true confluence at one level)",
    "POCKET_ABOVE": "the golden pocket sits ABOVE the zone (the zone is a deeper support/backstop below)",
    "POCKET_BELOW": "the golden pocket sits BELOW the zone (the zone is the nearer level; the pocket is a deeper/secondary level)",
    "N/A": "price is between zones, so there is no zone band to align with the pocket",
}

# --------------------------------------------------------------------------
# Verdict combinator
# --------------------------------------------------------------------------
FIB_LONG: Final[frozenset[str]] = frozenset({"F1", "F2", "F4"})
FIB_PENDING: Final[frozenset[str]] = frozenset({"F3", "F6", "F9", "F10"})
FIB_FALLING: Final[frozenset[str]] = frozenset({"F8", "F11"})
FIB_INVALID: Final[frozenset[str]] = frozenset({"F5", "F7", "F13", "F14"})

_LONG_BULL_BY_REL: Final[dict[str, str]] = {
    "OVERLAP": "BUY*", "POCKET_ABOVE": "BUY", "POCKET_BELOW": "CAUTION",
}


def combined_verdict(fib: FibRule, zoi: ZoiRule, rel: str) -> str:
    if fib.rule_id == "F12":                       # AT_HIGH — exhausted top
        return "AVOID"

    fam, pol = zoi.zone, zoi.polarity
    is_long = fib.rule_id in FIB_LONG
    is_pending = fib.rule_id in FIB_PENDING
    is_falling = fib.rule_id in FIB_FALLING
    is_invalid = fib.rule_id in FIB_INVALID

    if fam == "none":                              # price between zones -> fib drives
        if is_long:
            return "BUY"
        return "SKIP" if is_invalid else "WAIT"

    if zoi.rule_id == "Z9":                         # supply too far overhead -> fib drives
        if is_long:
            return "BUY"
        return "SKIP" if is_invalid else "WAIT"

    if fam == "demand":
        if pol == "bull":
            return _LONG_BULL_BY_REL[rel] if is_long else "WATCH"
        if pol == "pend":
            return "CAUTION" if is_long else "WAIT"
        # bear
        if zoi.rule_id == "Z6":                     # demand broken / invalidated
            return "CAUTION" if is_long else "AVOID"
        if is_long:                                 # Z2 failing inside demand
            return "CAUTION"
        if is_pending:
            return "WAIT"
        return "AVOID"

    # supply
    if pol == "bull":                               # Z10 breakout up
        return _LONG_BULL_BY_REL[rel] if is_long else "WATCH"
    if pol == "pend":                               # Z11b extended
        return "CAUTION" if is_long else "WAIT"
    # bear (Z7 inside, Z8 near-below, Z11 failed breakout)
    if rel == "OVERLAP":
        return "AVOID"                              # buying straight into supply
    if is_long:
        return "CAUTION"                            # supply overhead caps the long
    if is_falling:
        return "AVOID"
    if is_invalid:
        return "AVOID" if zoi.rule_id == "Z11" else "SKIP"
    return "WAIT"


# --------------------------------------------------------------------------
# Text builders
# --------------------------------------------------------------------------
_PREAMBLE: Final[dict[str, str]] = {
    "BUY*": "HIGHEST-CONVICTION CONFLUENCE",
    "BUY": "VALID ENTRY",
    "WATCH": "SETUP FORMING",
    "WAIT": "NOT ACTIONABLE YET",
    "CAUTION": "CONFLICTING SIGNALS",
    "SKIP": "NO EDGE",
    "AVOID": "DANGEROUS",
}
_SUB_PHRASE: Final[dict[str, str]] = {
    "BUY*": "highest-conviction confluence",
    "BUY": "valid entry",
    "WATCH": "forming - wait for HH-HL",
    "WAIT": "not actionable",
    "CAUTION": "conflicting - size down",
    "SKIP": "no edge",
    "AVOID": "avoid",
}
_RATIONALE: Final[dict[str, str]] = {
    "BUY*": "Fib retracement and zone agree bullish at the SAME price - full-confidence entry.",
    "BUY": "Fib and zone align bullish - take the trade.",
    "WATCH": "The zone supports a long but the fib leg is not confirmed yet; wait for HH-HL before entering.",
    "WAIT": "No confirmed signal; wait for price to reach a zone or confirm direction.",
    "CAUTION": "The two signals do not cleanly agree (overhead supply, a breaking/extended zone, or pocket and zone at different prices); reduce size or wait for the conflict to resolve.",
    "SKIP": "The fib setup is missed/invalid and the zone does not rescue it; wait for a deeper pullback into the golden pocket.",
    "AVOID": "High risk of loss - do not enter here.",
}
_COLOR: Final[dict[str, str]] = {
    "BUY*": "green", "BUY": "green", "WATCH": "neutral", "WAIT": "neutral",
    "CAUTION": "neutral", "SKIP": "red", "AVOID": "red",
}


def explain(verdict: str, fib: FibRule, zoi: ZoiRule, rel: str) -> str:
    return (
        f"{_PREAMBLE[verdict]} - Fib: {fib.desc}. ZOI: {zoi.desc}. "
        f"Geometry: {REL_PHRASE[rel]}. {_RATIONALE[verdict]}"
    )


def build_sub(verdict: str, fib: FibRule, zoi: ZoiRule, rel: str) -> str:
    return f"{_SUB_PHRASE[verdict]}: {fib.short} + {zoi.short} ({REL_TAG[rel]})"


# --------------------------------------------------------------------------
# Scenario enumeration
# --------------------------------------------------------------------------
DATA_DIR: Final[Path] = Path(__file__).resolve().parents[2] / "data"
CSV_PATH: Final[Path] = DATA_DIR / "fib-zoi-combinations.csv"
RULES_PATH: Final[Path] = DATA_DIR / "verdict-rules.json"

HEADER: Final[tuple[str, ...]] = (
    "combo_id", "fib_id", "zoi_id", "zoi_zone", "pocket_vs_zone",
    "fib_class", "zoi_position", "combined_verdict", "fib_verdict",
    "zoi_verdict", "rule_explanation",
)


def relationships_for(fib: FibRule, zoi: ZoiRule) -> tuple[str, ...]:
    if zoi.zone == "none":
        return ("N/A",)
    rels = ALLOWED_REL[(fib.px_vs_pocket, zoi.px_vs_zone)]
    if zoi.rule_id in FAR_ZONES and fib.px_vs_pocket == "IN":
        rels = tuple(r for r in rels if r != "OVERLAP")
    return rels


def build_csv_rows() -> list[tuple[str, ...]]:
    rows: list[tuple[str, ...]] = []
    for fib in FIB_RULES:
        for zoi in ZOI_RULES:
            for rel in relationships_for(fib, zoi):
                v = combined_verdict(fib, zoi, rel)
                rows.append((
                    f"{fib.rule_id}x{zoi.rule_id}x{REL_SHORT[rel]}",
                    fib.rule_id, zoi.rule_id, zoi.zone, rel,
                    fib.fib_class, zoi.position, v,
                    fib.verdict, zoi.verdict,
                    explain(v, fib, zoi, rel),
                ))
    return rows


def build_json_rules() -> list[dict]:
    out: list[dict] = []
    for fib in FIB_RULES:
        for zoi in ZOI_RULES:
            for rel in relationships_for(fib, zoi):
                v = combined_verdict(fib, zoi, rel)
                rule: dict = {
                    "id": f"{fib.rule_id}x{zoi.rule_id}x{REL_SHORT[rel]}",
                    "fibClass": fib.engine_class,
                    "zoiPosition": zoi.position,
                    "pocketVsZone": rel,
                    "verdict": "BUY" if v == "BUY*" else v,
                    "color": _COLOR[v],
                    "sub": build_sub(v, fib, zoi, rel),
                    "tooltip": explain(v, fib, zoi, rel),
                }
                if fib.touched is not None:
                    rule["touchedZone"] = fib.touched
                if fib.bounce is not None:
                    rule["bounceStatus"] = fib.bounce
                if v == "BUY*":
                    rule["highConviction"] = True
                out.append(rule)
    return out


# --------------------------------------------------------------------------
# Writers
# --------------------------------------------------------------------------

def write_csv(rows: list[tuple[str, ...]]) -> None:
    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(HEADER)
        writer.writerows(rows)


def inject_proposed_rules(json_rules: list[dict]) -> None:
    """Add/replace the ``fibZoiCombinedProposed`` key without disturbing the
    rest of verdict-rules.json (preserves existing formatting + the live
    ``fibZoiCombined`` array)."""
    text = RULES_PATH.read_text(encoding="utf-8").rstrip() + "\n"

    arr = json.dumps(json_rules, indent=2, ensure_ascii=True)
    arr_lines = arr.split("\n")
    indented = arr_lines[0] + (
        "\n" + "\n".join("  " + ln for ln in arr_lines[1:]) if len(arr_lines) > 1 else ""
    )
    block = '"fibZoiCombinedProposed": ' + indented

    # 1) strip any existing proposed block (sits as the last key, before "}")
    text = re.sub(
        r',\s*"fibZoiCombinedProposed"\s*:\s*\[[\s\S]*?\]\s*(?=}\s*\Z)',
        "",
        text.rstrip() + "\n",
    )

    # 2) insert fresh before the final closing brace
    stripped = text.rstrip()
    if not stripped.endswith("}"):
        raise RuntimeError("verdict-rules.json does not end with '}'")
    body = stripped[:-1].rstrip()
    if not body.endswith("]"):
        raise RuntimeError("expected an array (fibZoiCombined) as the last key")
    new_text = f"{body},\n  {block}\n}}\n"

    json.loads(new_text)  # validate before writing
    RULES_PATH.write_text(new_text, encoding="utf-8")


def main() -> None:
    csv_rows = build_csv_rows()
    json_rules = build_json_rules()
    if len(csv_rows) != len(json_rules):
        raise RuntimeError("CSV/JSON row count mismatch")

    write_csv(csv_rows)
    inject_proposed_rules(json_rules)

    dist = Counter(r[7] for r in csv_rows)
    print(f"Wrote {len(csv_rows)} scenarios to {CSV_PATH}")
    print(f"Injected {len(json_rules)} rules into {RULES_PATH} under 'fibZoiCombinedProposed'")
    print("verdict distribution:", dict(dist.most_common()))


if __name__ == "__main__":
    main()
