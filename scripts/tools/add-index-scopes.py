#!/usr/bin/env python3
"""Inject the Nifty 100 and Nifty 500 broad-market indices into
``data/sectors.json`` without a full ``generate-sectors.py`` re-run.

Why a separate script: the full generator downloads the multi-MB Upstox
instruments master and needs a live Upstox token to attach per-stock
prices — heavy, network-and-token dependent, and it rewrites the entire
file. Adding two broad indices does not need any of that: the
constituents (and their ISINs) come straight from NSE's published index
CSVs, and every price we need is already present in the existing
``sectors.json`` snapshot (these 600 names are all auto-classified into
sectors there). So we resolve names + prices by ISIN against the file we
already have and only append the two new index buckets.

Idempotent: re-running replaces any pre-existing ``nifty-100`` /
``nifty-500`` entries rather than duplicating them.

Run: ``python3 scripts/tools/add-index-scopes.py``
"""

from __future__ import annotations

import csv
import io
import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Mapping

REPO_ROOT: Final[Path] = Path(__file__).resolve().parent.parent.parent
SECTORS_PATH: Final[Path] = REPO_ROOT / "data" / "sectors.json"
INSTRUMENTS_PATH: Final[Path] = REPO_ROOT / "data" / "instruments-index.json"

# NSE archive CSVs — Symbol + ISIN Code columns are the source of truth.
NSE_CSV_URLS: Final[Mapping[str, str]] = {
    "nifty-100": "https://archives.nseindia.com/content/indices/ind_nifty100list.csv",
    "nifty-500": "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
}
INDEX_NAMES: Final[Mapping[str, str]] = {
    "nifty-100": "Nifty 100",
    "nifty-500": "Nifty 500",
}
# Final display order of the whole indices row (broad market first, then
# sectoral). Any index id present in the file but not listed here is kept
# and appended afterwards so nothing is silently dropped.
INDEX_ORDER: Final[tuple[str, ...]] = (
    "nifty-50", "nifty-next-50", "nifty-100", "nifty-500",
    "nifty-bank", "nifty-it",
)

_UA: Final[str] = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# Words preserved in original case during the lightweight name fallback.
_LOWER_WORDS: Final[frozenset[str]] = frozenset(
    {"OF", "AND", "FOR", "IN", "ON", "AT", "THE", "A", "AN", "TO"}
)


@dataclass(frozen=True)
class Constituent:
    """One index member resolved from the NSE CSV."""

    sym: str
    isin: str
    csv_name: str


def fetch_constituents(url: str) -> list[Constituent]:
    """Download an NSE index CSV and parse Symbol / ISIN / Company Name."""
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode("utf-8-sig")
    out: list[Constituent] = []
    seen: set[str] = set()
    for row in csv.DictReader(io.StringIO(body)):
        sym = (row.get("Symbol") or "").strip()
        isin = (row.get("ISIN Code") or "").strip()
        name = (row.get("Company Name") or "").strip()
        if not sym or not isin or sym in seen:
            continue
        seen.add(sym)
        out.append(Constituent(sym=sym, isin=isin, csv_name=name))
    if not out:
        raise RuntimeError(f"No constituents parsed from {url}")
    return out


def _clean_name(raw: str) -> str:
    """Lightweight fallback name cleaner (drops Ltd/Limited, title-cases).

    Mirrors ``generate-sectors.py``'s ``clean_name`` closely enough for the
    rare CSV-only stock that isn't already in ``sectors.json``.
    """
    n = raw.strip()
    upper = n.upper()
    for suf in (" LIMITED", " LTD.", " LTD"):
        if upper.endswith(suf):
            n = n[: -len(suf)].strip()
            break
    if not n.isupper():
        return n
    words = []
    for i, w in enumerate(n.split()):
        if len(w) <= 3 and w in _LOWER_WORDS and i != 0:
            words.append(w.lower())
        elif len(w) <= 3:
            words.append(w)
        else:
            words.append(w.capitalize())
    return " ".join(words)


def load_real_universe() -> dict[str, str]:
    """Load data/instruments-index.json → {symbol: isin} of REAL tradables.

    This is the Upstox NSE+BSE master snapshot. We use it to reject any
    constituent the upstream CSV claims but that does not correspond to a
    real, quotable instrument — e.g. injected test fixtures like the
    "Dummy Vedanta" rows (fake ISIN ``DU…``). Fail safe: a name we cannot
    map to a real instrument is dropped, never scanned.
    """
    raw = json.loads(INSTRUMENTS_PATH.read_text(encoding="utf-8"))
    stocks = raw.get("stocks", {})
    out: dict[str, str] = {}
    for sym, arr in stocks.items():
        if isinstance(arr, list) and arr:
            out[sym] = arr[0]  # arr = [isin, name, exch?]
    return out


def is_real_constituent(c: "Constituent", universe: Mapping[str, str]) -> bool:
    """True only if the symbol exists in the real master AND its ISIN matches.

    The ISIN cross-check also catches a real symbol carrying a tampered
    ISIN. A genuine Indian equity ISIN is 12 chars starting with ``IN``;
    the injected fixtures use ``DU…`` and are absent from the master, so
    they fail both checks.
    """
    real_isin = universe.get(c.sym)
    if not real_isin:
        return False
    if c.isin and c.isin != real_isin:
        return False
    return real_isin.startswith("IN") and len(real_isin) == 12


def build_price_name_maps(
    data: dict,
) -> tuple[dict[str, float], dict[str, str]]:
    """Walk every stock already in the file → {isin: price}, {isin: name}.

    Prefers names/prices already curated in the snapshot so the new index
    cards stay visually consistent with the rest of the app and need no
    Upstox quote round-trip.
    """
    price_by_isin: dict[str, float] = {}
    name_by_isin: dict[str, str] = {}
    groups = list(data.get("sectors", [])) + list(data.get("indices", []))
    for grp in groups:
        for st in grp.get("stocks", []):
            isin = st.get("isin")
            if not isin:
                continue
            if isin not in name_by_isin and st.get("name"):
                name_by_isin[isin] = st["name"]
            px = st.get("price")
            if isin not in price_by_isin and isinstance(px, (int, float)):
                price_by_isin[isin] = float(px)
    return price_by_isin, name_by_isin


def build_index_entry(
    index_id: str,
    constituents: list[Constituent],
    price_by_isin: Mapping[str, float],
    name_by_isin: Mapping[str, str],
    universe: Mapping[str, str],
) -> tuple[dict, int, list[str]]:
    """Assemble one ``{id, name, stocks[]}`` index dict.

    Returns (entry, n_no_price, rejected_symbols). Constituents that do
    not map to a real, quotable instrument are rejected (fail safe).
    """
    stocks: list[dict] = []
    no_price = 0
    rejected: list[str] = []
    for c in constituents:
        if not is_real_constituent(c, universe):
            rejected.append(c.sym)
            continue
        name = name_by_isin.get(c.isin) or _clean_name(c.csv_name) or c.sym
        entry: dict = {"sym": c.sym, "isin": c.isin, "name": name}
        px = price_by_isin.get(c.isin)
        if px is not None:
            entry["price"] = px
        else:
            no_price += 1
        stocks.append(entry)
    return (
        {"id": index_id, "name": INDEX_NAMES[index_id], "stocks": stocks},
        no_price,
        rejected,
    )


def main() -> int:
    data = json.loads(SECTORS_PATH.read_text(encoding="utf-8"))
    price_by_isin, name_by_isin = build_price_name_maps(data)
    universe = load_real_universe()
    print(
        f"Resolved {len(price_by_isin)} prices / {len(name_by_isin)} names "
        f"from snapshot; {len(universe)} real instruments in master",
        file=sys.stderr,
    )

    new_entries: dict[str, dict] = {}
    for index_id, url in NSE_CSV_URLS.items():
        cons = fetch_constituents(url)
        entry, no_price, rejected = build_index_entry(
            index_id, cons, price_by_isin, name_by_isin, universe
        )
        new_entries[index_id] = entry
        msg = (
            f"  {index_id}: {len(entry['stocks'])} real constituents "
            f"({no_price} without a cached price)"
        )
        if rejected:
            msg += f" — rejected {len(rejected)} non-real: {', '.join(rejected)}"
        print(msg, file=sys.stderr)

    # Merge: keep all existing indices except the two we are (re)building,
    # then emit in the canonical display order.
    existing = {ix["id"]: ix for ix in data.get("indices", [])}
    existing.update(new_entries)
    ordered: list[dict] = [existing[i] for i in INDEX_ORDER if i in existing]
    leftovers = [ix for k, ix in existing.items() if k not in INDEX_ORDER]
    data["indices"] = ordered + leftovers

    SECTORS_PATH.write_text(
        json.dumps(data, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"\nWrote {SECTORS_PATH} — indices now: "
        + ", ".join(ix["id"] for ix in data["indices"]),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
