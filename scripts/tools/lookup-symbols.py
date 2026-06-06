#!/usr/bin/env python3
"""One-off helper: fuzzy-search the Upstox NSE master for a symbol or name.

Usage::

    python3 scripts/tools/lookup-symbols.py LTIM BIRLASOFT TATAMOTORS

For each argument, prints up to 10 NSE_EQ rows whose trading symbol OR
name contains the substring (case-insensitive). Use to track down the
correct symbol after a corporate rename.
"""
from __future__ import annotations

import gzip
import io
import json
import sys
import urllib.request
from pathlib import Path
from typing import Final


NSE_MASTER_URL: Final[str] = (
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
)
CACHE_PATH: Final[Path] = Path("/tmp/upstox-nse-master.json")


def main(needles: list[str]) -> int:
    if CACHE_PATH.exists():
        instruments = json.loads(CACHE_PATH.read_text())
        print(f"(using cached master at {CACHE_PATH})", file=sys.stderr)
    else:
        with urllib.request.urlopen(NSE_MASTER_URL, timeout=60) as resp:
            raw = resp.read()
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
            instruments = json.load(gz)
        CACHE_PATH.write_text(json.dumps(instruments))
        print(f"(cached master at {CACHE_PATH})", file=sys.stderr)
    nse_eq = [
        i for i in instruments
        if i.get("segment") == "NSE_EQ"
        and i.get("instrument_type") in ("EQ", "Equity")
    ]
    for needle in needles:
        n = needle.upper()
        hits = []
        for i in nse_eq:
            sym = (i.get("trading_symbol") or "").upper()
            name = (i.get("name") or "").upper()
            if n in sym or n in name:
                hits.append(i)
        print(f"\n=== {needle} → {len(hits)} hit(s) ===")
        for h in hits[:10]:
            print(
                f"  {h.get('trading_symbol'):20} "
                f"isin={h.get('isin'):14} "
                f"name={h.get('name')}"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
