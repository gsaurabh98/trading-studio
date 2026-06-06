"""Build the ISIN -> Angel One symboltoken map used by the swing analyzer.

Why this exists
---------------
The app's swing universe (``data/sectors.json`` + ``data/instruments-index.json``)
identifies every stock by its **ISIN** and **Upstox trading symbol**. Angel One
SmartAPI, however, keys instruments by a numeric ``symboltoken`` (e.g. ``2885``
for RELIANCE) on a given ``exch_seg`` (``NSE``). To fetch candles from Angel for
the same universe we therefore need a lookup that the browser can consult:

    ISIN -> { token, exchange, symbol }

Angel publishes a public "scrip master" JSON (no auth needed) listing every
tradable instrument. We match our universe to it by **trading symbol** —
``<SYMBOL>-EQ`` in the ``NSE`` segment — because the master file does not carry
ISINs. Anything we can't match (some ETFs, freshly listed names, symbol drift)
is reported and simply omitted; the swing module fails safe and marks those
stocks as unavailable on Angel rather than guessing a wrong token.

Usage
-----
    .venv/bin/python scripts/tools/build-angel-instruments.py

Re-run whenever ``sectors.json`` / ``instruments-index.json`` change, or after
an Angel symbol rebrand. Pure stdlib (urllib + json) — no pip install needed.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from urllib import request as urlreq
from urllib.error import URLError

ROOT: Final[Path] = Path(__file__).resolve().parent.parent.parent
SECTORS_PATH: Final[Path] = ROOT / "data" / "sectors.json"
INDEX_PATH: Final[Path] = ROOT / "data" / "instruments-index.json"
OUTPUT_PATH: Final[Path] = ROOT / "data" / "angel-instruments.json"

# Public Angel One scrip master — no authentication required.
ANGEL_MASTER_URL: Final[str] = (
    "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
)
REQUEST_TIMEOUT_SEC: Final[float] = 60.0
BROWSER_UA: Final[str] = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class UniverseStock:
    """One stock from the app's swing universe."""

    sym: str
    isin: str
    name: str


def load_universe() -> dict[str, UniverseStock]:
    """Collect every (sym, isin) pair across sectors + the custom-add index.

    Keyed by ISIN so duplicates (a stock appearing in multiple sectors and the
    index) collapse to one entry.
    """
    universe: dict[str, UniverseStock] = {}

    sectors_raw = json.loads(SECTORS_PATH.read_text())
    for sector in sectors_raw.get("sectors", []):
        for st in sector.get("stocks", []):
            isin = str(st.get("isin", "")).strip()
            sym = str(st.get("sym", "")).strip()
            if isin and sym:
                universe[isin] = UniverseStock(sym=sym, isin=isin, name=str(st.get("name", "")))

    if INDEX_PATH.exists():
        index_raw = json.loads(INDEX_PATH.read_text())
        for sym, pair in index_raw.get("stocks", {}).items():
            if not isinstance(pair, list) or not pair:
                continue
            isin = str(pair[0]).strip()
            name = str(pair[1]) if len(pair) > 1 else ""
            if isin and sym and isin not in universe:
                universe[isin] = UniverseStock(sym=str(sym).strip(), isin=isin, name=name)

    return universe


def fetch_angel_master() -> list[dict[str, str]]:
    """Download the Angel One scrip master JSON (a flat list of instruments)."""
    req = urlreq.Request(
        ANGEL_MASTER_URL,
        headers={"User-Agent": BROWSER_UA, "Accept": "application/json"},
    )
    try:
        with urlreq.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read())
    except (URLError, json.JSONDecodeError) as exc:
        sys.exit(f"Failed to download Angel scrip master: {exc}")
    if not isinstance(payload, list):
        sys.exit("Unexpected Angel master shape (expected a JSON list)")
    return payload


def build_nse_equity_lookup(master: list[dict[str, str]]) -> dict[str, str]:
    """Map ``SYMBOL-EQ`` (upper) -> token for the NSE cash segment only."""
    lookup: dict[str, str] = {}
    for row in master:
        if str(row.get("exch_seg", "")).upper() != "NSE":
            continue
        symbol = str(row.get("symbol", "")).strip().upper()
        token = str(row.get("token", "")).strip()
        if symbol and token:
            lookup[symbol] = token
    return lookup


def main() -> None:
    print("Angel One instrument-map builder")
    print("=" * 40)

    universe = load_universe()
    print(f"Universe: {len(universe)} unique stocks")

    master = fetch_angel_master()
    print(f"Angel master: {len(master)} instruments")

    nse_eq = build_nse_equity_lookup(master)
    print(f"NSE equity symbols in master: {len(nse_eq)}")

    mapping: dict[str, dict[str, str]] = {}
    unmatched: list[str] = []
    for isin, stock in universe.items():
        angel_symbol = f"{stock.sym.upper()}-EQ"
        token = nse_eq.get(angel_symbol)
        if token:
            mapping[isin] = {"token": token, "exchange": "NSE", "symbol": angel_symbol}
        else:
            unmatched.append(stock.sym)

    out = {
        "version": 1,
        "note": (
            "ISIN -> Angel One {token, exchange, symbol} for the swing universe. "
            "Auto-generated by scripts/tools/build-angel-instruments.py. NSE cash "
            "segment only; unmatched symbols are omitted (swing fails safe)."
        ),
        "source": ANGEL_MASTER_URL,
        "instruments": mapping,
    }
    OUTPUT_PATH.write_text(json.dumps(out, separators=(",", ":")) + "\n")

    matched = len(mapping)
    total = len(universe)
    pct = (matched / total * 100.0) if total else 0.0
    print(f"\nMatched: {matched}/{total} ({pct:.1f}%)")
    print(f"Written: {OUTPUT_PATH.relative_to(ROOT)}")
    if unmatched:
        preview = ", ".join(sorted(unmatched)[:25])
        print(f"\nUnmatched ({len(unmatched)}) — omitted, e.g.: {preview}")


if __name__ == "__main__":
    main()
