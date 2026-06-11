#!/usr/bin/env python3
"""Expand the live ``fibZoiCombined`` matrix for the 3-way ZOI momentum codes.

Context
-------
The ZOI classifier (``scripts/swing-analyzer.js``) now emits a 3-way momentum
read for the zone-interior states instead of a boolean:

    IN_SUPPLY        -> IN_SUPPLY_RISING / IN_SUPPLY_CONSOLIDATING / IN_SUPPLY_FALLING
    (flat) IN_DEMAND -> IN_DEMAND_CONSOLIDATING   (alongside IN_DEMAND_FALLING)

``zoiOnly`` already has explicit rules for every new code. This script makes the
**FIB+ZOI combined** matrix explicit too, by CLONING the existing live rows:

    every IN_SUPPLY        row  -> IN_SUPPLY_RISING + _CONSOLIDATING + _FALLING
    every IN_DEMAND_FALLING row -> IN_DEMAND_CONSOLIDATING

Verdict policy (DELIBERATE, real-money safe)
--------------------------------------------
Clones inherit the base row's ``verdict`` / ``color`` / ``highConviction``
VERBATIM. We do NOT soften AVOID->WATCH for "rising/coiling inside supply":
inside an institutional supply zone that also overlaps a bullish fib pocket,
micro-momentum does not earn a looser verdict — buying into that resistance is
exactly what the trading rules forbid. So this is a ZERO-verdict-change
expansion vs the prior normalization shim; it only makes the states explicit
(real rows + accurate badges), which lets the shim be removed.

Only ``id`` (suffixed), ``zoiPosition``, and the human ``sub`` / ``tooltip``
wording change per clone.

Idempotent: re-running strips any previously-inserted clones (tagged by id
suffix) before re-inserting. Preserves the rest of the file's formatting by
splicing serialized rows into the (last-key) ``fibZoiCombined`` array rather
than re-dumping the whole document.

Run
---
    python3 scripts/tools/expand-zoi-momentum-combined.py
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final

RULES_PATH: Final[Path] = Path(__file__).resolve().parents[2] / "rules" / "swing-rules.json"

# id suffix that tags a generated clone (used for idempotent strip + insert).
CLONE_SUFFIX_RE: Final[re.Pattern[str]] = re.compile(r"-(SR|SC|SF|DC)$")


@dataclass(frozen=True)
class Variant:
    """One derived ZOI code cloned from a base zoiPosition."""
    base_position: str          # zoiPosition to clone FROM (live rows)
    new_position: str           # zoiPosition to emit
    id_suffix: str              # appended to base id (collision-free, tagged)
    short_from: str             # substring in `sub` to replace (base zoi short)
    short_to: str               # replacement short
    desc_from: str              # substring in `tooltip` to replace (base zoi desc)
    desc_to: str                # replacement desc


# The base zoi phrases are CONSTANT across every combined row for a given
# zoiPosition (they come from the generator's zoi.short / zoi.desc), so a plain
# first-occurrence substring replace is safe and unambiguous.
_SUPPLY_DESC: Final[str] = "price is inside a supply zone (active institutional selling)"
_DEMAND_FALL_DESC: Final[str] = "price is inside a demand zone but falling (zone breaking down)"

VARIANTS: Final[tuple[Variant, ...]] = (
    Variant(
        "IN_SUPPLY", "IN_SUPPLY_RISING", "-SR",
        "in supply", "in supply, rising",
        _SUPPLY_DESC,
        "price is inside a supply zone and pushing UP into resistance (breakout NOT confirmed)",
    ),
    Variant(
        "IN_SUPPLY", "IN_SUPPLY_CONSOLIDATING", "-SC",
        "in supply", "in supply, coiling",
        _SUPPLY_DESC,
        "price is inside a supply zone and coiling under resistance (tug-of-war, unresolved)",
    ),
    Variant(
        "IN_SUPPLY", "IN_SUPPLY_FALLING", "-SF",
        "in supply", "in supply, rejecting",
        _SUPPLY_DESC,
        "price is inside a supply zone and being rejected (active institutional selling)",
    ),
    Variant(
        "IN_DEMAND_FALLING", "IN_DEMAND_CONSOLIDATING", "-DC",
        "in demand, falling", "in demand, basing",
        _DEMAND_FALL_DESC,
        "price is inside a demand zone and consolidating on support (holding, no bounce trigger yet)",
    ),
)


def _clone_row(base: dict, var: Variant) -> dict:
    """Clone a base combined row into a momentum variant, verdict-preserving."""
    out: dict = dict(base)  # shallow copy keeps key order + all flags
    out["id"] = str(base["id"]) + var.id_suffix
    out["zoiPosition"] = var.new_position
    if isinstance(base.get("sub"), str):
        out["sub"] = base["sub"].replace(var.short_from, var.short_to, 1)
    if isinstance(base.get("tooltip"), str):
        out["tooltip"] = base["tooltip"].replace(var.desc_from, var.desc_to, 1)
    return out


def build_clones(combined: list[dict]) -> list[dict]:
    """Build all clone rows (in variant order, base order preserved within)."""
    is_clone: Callable[[dict], bool] = lambda r: bool(
        CLONE_SUFFIX_RE.search(str(r.get("id", "")))
    )
    base_rows = [r for r in combined if not is_clone(r)]
    clones: list[dict] = []
    for var in VARIANTS:
        for row in base_rows:
            if row.get("zoiPosition") == var.base_position:
                clones.append(_clone_row(row, var))
    return clones


def _serialize_rows(rows: list[dict]) -> str:
    """Serialize rows as the inner body of the fibZoiCombined array, indented
    to match the file (4 spaces for object braces, 6 for keys)."""
    chunks: list[str] = []
    for row in rows:
        obj = json.dumps(row, indent=2, ensure_ascii=True)
        lines = obj.split("\n")
        # First line "{" at 4-space indent; remaining lines +4 more spaces.
        body = "    " + lines[0] + "\n" + "\n".join("    " + ln for ln in lines[1:])
        chunks.append(body)
    return ",\n".join(chunks)


def splice_into_combined(text: str, clones: list[dict]) -> str:
    """Insert serialized clone rows just before the closing ``]`` of the
    fibZoiCombined array (which is the file's LAST top-level key)."""
    stripped = text.rstrip()
    if not stripped.endswith("}"):
        raise RuntimeError("swing-rules.json does not end with '}'")
    # Locate the array's closing ']' (last ']' before the final '}').
    close_brace = stripped.rfind("}")
    close_bracket = stripped.rfind("]", 0, close_brace)
    if close_bracket == -1:
        raise RuntimeError("could not find fibZoiCombined closing ']'")
    head = stripped[:close_bracket].rstrip()  # ends at last existing row '}'
    tail = stripped[close_bracket:]           # ']\n}'
    block = _serialize_rows(clones)
    return f"{head},\n{block}\n  {tail}\n"


def strip_existing_clones(rules: dict) -> int:
    """Remove previously-inserted clones (idempotency). Returns count removed."""
    combined = rules["fibZoiCombined"]
    kept = [r for r in combined if not CLONE_SUFFIX_RE.search(str(r.get("id", "")))]
    removed = len(combined) - len(kept)
    rules["fibZoiCombined"] = kept
    return removed


def main() -> None:
    raw = RULES_PATH.read_text(encoding="utf-8")
    rules = json.loads(raw)

    # If clones already exist, rebuild the file fresh from the stripped state so
    # re-runs are deterministic. We re-serialize the WHOLE file in that case
    # (only when re-running); first run uses surgical splice to preserve format.
    had_clones = any(
        CLONE_SUFFIX_RE.search(str(r.get("id", ""))) for r in rules["fibZoiCombined"]
    )

    if had_clones:
        removed = strip_existing_clones(rules)
        clones = build_clones(rules["fibZoiCombined"])
        rules["fibZoiCombined"].extend(clones)
        RULES_PATH.write_text(
            json.dumps(rules, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
        )
        print(f"Re-run: stripped {removed} old clones, inserted {len(clones)} fresh "
              f"(full re-dump). Total combined: {len(rules['fibZoiCombined'])}")
        return

    clones = build_clones(rules["fibZoiCombined"])
    new_text = splice_into_combined(raw, clones)
    json.loads(new_text)  # validate before writing
    RULES_PATH.write_text(new_text, encoding="utf-8")

    by_pos: dict[str, int] = {}
    for c in clones:
        by_pos[c["zoiPosition"]] = by_pos.get(c["zoiPosition"], 0) + 1
    print(f"Inserted {len(clones)} clone rows into fibZoiCombined:")
    for pos in sorted(by_pos):
        print(f"  {pos}: {by_pos[pos]}")


if __name__ == "__main__":
    main()
