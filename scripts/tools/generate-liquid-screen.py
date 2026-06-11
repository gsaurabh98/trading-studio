#!/usr/bin/env python3
"""Inject (or refresh) the "High Liquidity" screen group into data/sectors.json.

WHAT IT DOES
------------
The swing analyzer's sector grid is data-driven from `data/sectors.json`
(`sectors` + `indices` arrays — see scripts/swing-analyzer.js renderSectorGrid).
This script derives ONE extra group, id `liquid-band`, that is rendered as its
own card/row by the analyzer:

  * Source of "high liquidity" = `data/backtest/universe-final.json`, the
    backtest universe already gated to median daily turnover >= floor
    (default 2 crore/day) by scripts/backtest/liquidity-trim.mjs. We do NOT
    re-derive liquidity here — we reuse that honest, rule-based gate.
  * Source of name + price = the existing per-stock snapshots in sectors.json
    (Upstox LTP baked in at generation time by generate-sectors.py). No network.
  * We keep only names whose snapshot price sits inside the configurable band
    (default 400-5000) and sort by liquidity (most liquid first).

The group carries an explicit `band: {min, max}` so the analyzer scans and
browse-filters this card against 400-5000 instead of the global price band
(swing-analyzer.js `_swBandFor`). Every other card is untouched.

IDEMPOTENT: any existing `liquid-band` group is removed before the fresh one is
appended, so re-running just refreshes it. Re-run AFTER generate-sectors.py to
pick up fresh prices, then bump CACHE_VERSION in sw.js.

Usage:
    python3 scripts/tools/generate-liquid-screen.py [--min 400] [--max 5000]
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Iterable

REPO: Final[Path] = Path(__file__).resolve().parent.parent.parent
SECTORS_PATH: Final[Path] = REPO / "data" / "sectors.json"
UNIVERSE_PATH: Final[Path] = REPO / "data" / "backtest" / "universe-final.json"

GROUP_ID: Final[str] = "liquid-band"
GROUP_NAME: Final[str] = "High Liquidity"


@dataclass(frozen=True)
class StockMeta:
    """A name+price snapshot resolved from sectors.json, keyed by ISIN."""

    sym: str
    name: str
    price: float


@dataclass(frozen=True)
class LiquidStock:
    """One row of the emitted liquid-band group."""

    sym: str
    isin: str
    name: str
    price: float
    med_turnover: int

    def to_card(self) -> dict[str, object]:
        # Shape MUST match the other sector/index stock entries so the
        # analyzer's renderers + scan read it uniformly (sym/isin/name/price).
        return {"sym": self.sym, "isin": self.isin, "name": self.name, "price": self.price}


def _load_json(path: Path) -> dict[str, object]:
    if not path.exists():
        sys.exit(f"Missing required file: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _build_isin_index(sectors_doc: dict[str, object]) -> dict[str, StockMeta]:
    """ISIN -> {sym,name,price} from every sectors + indices stock.

    First occurrence wins (curated sector entries come first). Only entries
    carrying a finite price snapshot are usable for the band filter.
    """

    groups: list[dict[str, object]] = []
    groups.extend(sectors_doc.get("sectors", []) or [])  # type: ignore[arg-type]
    groups.extend(sectors_doc.get("indices", []) or [])  # type: ignore[arg-type]

    index: dict[str, StockMeta] = {}
    for group in groups:
        for stock in group.get("stocks", []) or []:  # type: ignore[union-attr]
            isin = stock.get("isin")
            if not isin or isin in index:
                continue
            price = stock.get("price")
            if not isinstance(price, (int, float)):
                continue
            index[isin] = StockMeta(
                sym=str(stock.get("sym") or ""),
                name=str(stock.get("name") or stock.get("sym") or ""),
                price=float(price),
            )
    return index


def _select_liquid(
    universe: Iterable[dict[str, object]],
    isin_index: dict[str, StockMeta],
    price_min: float,
    price_max: float,
) -> list[LiquidStock]:
    """Keep liquidity-universe names with a snapshot price in band; sort by liquidity."""

    selected: list[LiquidStock] = []
    for row in universe:
        isin = row.get("isin")
        if not isinstance(isin, str):
            continue
        meta = isin_index.get(isin)
        if meta is None:
            continue  # fail safe: no price snapshot => can't confirm band
        if not (price_min <= meta.price <= price_max):
            continue
        med = row.get("medTurnover")
        selected.append(
            LiquidStock(
                sym=meta.sym or str(row.get("sym") or ""),
                isin=isin,
                name=meta.name,
                price=meta.price,
                med_turnover=int(med) if isinstance(med, (int, float)) else 0,
            )
        )

    # Most liquid first — mirrors liquidity-trim.mjs ordering intent.
    selected.sort(key=lambda s: s.med_turnover, reverse=True)
    return selected


def _inject_group(
    sectors_doc: dict[str, object],
    stocks: list[LiquidStock],
    price_min: float,
    price_max: float,
) -> None:
    """Replace any existing liquid-band group inside `indices` with a fresh one.

    We place the group in the existing `indices` array (not a new top-level
    key) so EVERY flatten site in swing-analyzer.js — search, scan universe,
    `_swGetGroup`, validation — picks it up automatically with zero JS risk.
    The analyzer separates band-carrying groups into their own row for display.
    """

    indices: list[dict[str, object]] = list(sectors_doc.get("indices", []) or [])  # type: ignore[arg-type]
    indices = [g for g in indices if g.get("id") != GROUP_ID]

    group: dict[str, object] = {
        "id": GROUP_ID,
        "name": GROUP_NAME,
        "band": {"min": price_min, "max": price_max},
        "stocks": [s.to_card() for s in stocks],
    }
    indices.append(group)
    sectors_doc["indices"] = indices


def main() -> None:
    parser = argparse.ArgumentParser(description="Inject the High Liquidity screen into sectors.json")
    parser.add_argument("--min", type=float, default=400.0, help="lower price band (inclusive)")
    parser.add_argument("--max", type=float, default=5000.0, help="upper price band (inclusive)")
    args = parser.parse_args()

    price_min: float = float(args.min)
    price_max: float = float(args.max)
    if not price_min < price_max:
        sys.exit(f"Invalid band: min ({price_min}) must be < max ({price_max})")

    sectors_doc = _load_json(SECTORS_PATH)
    universe_doc = _load_json(UNIVERSE_PATH)
    universe = universe_doc.get("stocks", []) or []

    isin_index = _build_isin_index(sectors_doc)
    selected = _select_liquid(universe, isin_index, price_min, price_max)

    if not selected:
        sys.exit("No liquid names landed in band — aborting so the card is never empty.")

    _inject_group(sectors_doc, selected, price_min, price_max)

    # Pretty-print with 2-space indent to match the existing sectors.json style.
    SECTORS_PATH.write_text(
        json.dumps(sectors_doc, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    total_universe = len(universe)
    print(
        f"Injected '{GROUP_ID}' ({GROUP_NAME}) — {len(selected)} stocks "
        f"in band ₹{price_min:.0f}–₹{price_max:.0f} "
        f"(from {total_universe} liquidity-universe names)."
    )
    print(f"Top 5 by liquidity: {', '.join(s.sym for s in selected[:5])}")
    print(f"Wrote {SECTORS_PATH}")


if __name__ == "__main__":
    main()
