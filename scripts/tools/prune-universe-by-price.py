#!/usr/bin/env python3
"""Prune data/instruments-index.json + data/sectors.json to a price band.

Why
---
The swing tab only trades names inside a ₹250–₹3,500 band, but the JSON
universe files carry **no price** — they're just ``{sym, isin, name}``.
So a price filter can only be applied with *live* prices. This one-shot
script fetches the last price for every stock in the universe from Upstox
and rewrites both JSON files keeping only the in-band names. After running
it, the in-app "Scannable universe" count and the sector browse reflect
the pruned list directly (no runtime price filter needed).

Stocks Upstox can't price (delisted, suspended, illiquid with no quote)
are also dropped — if it can't be priced it can't be traded safely, which
matches the app's "fail safe, accuracy over coverage" rule.

Auth
----
Needs a *fresh* Upstox access token (the same daily token the app uses).
Pass it via the ``UPSTOX_TOKEN`` env var or ``--token``::

    UPSTOX_TOKEN=xxxxx .venv/bin/python scripts/tools/prune-universe-by-price.py
    # or
    .venv/bin/python scripts/tools/prune-universe-by-price.py --token xxxxx

Options
-------
    --min   lower bound, inclusive (default 400)
    --max   upper bound, inclusive (default 2200)
    --dry-run   report what would change, write nothing

Re-run ``scripts/tools/generate-sectors.py`` first if you want to start from the
full universe again (this script only ever removes, never adds).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Iterable, Mapping

LTP_URL: Final[str] = "https://api.upstox.com/v2/market-quote/ltp"
# Upstox caps instrument_key lists per request; 500 is the documented safe
# ceiling for the LTP endpoint. Smaller batches = more round-trips but
# friendlier to the rate limit.
BATCH_SIZE: Final[int] = 500
# Polite gap between batches so a full-universe prune doesn't burst the
# per-IP budget the live app shares.
BATCH_PAUSE_S: Final[float] = 0.7


@dataclass(frozen=True)
class Band:
    """Inclusive price band — keep ``lo <= price <= hi``."""

    lo: float
    hi: float

    def contains(self, price: float) -> bool:
        return self.lo <= price <= self.hi


def ikey(isin: str, exch: str = "NSE") -> str:
    """Upstox cash-equity instrument key for an ISIN on a given exchange."""
    seg = "BSE_EQ" if exch == "BSE" else "NSE_EQ"
    return f"{seg}|{isin}"


def fetch_prices(isin_exch: Mapping[str, str], token: str) -> dict[str, float]:
    """Fetch last price per ISIN from Upstox LTP, batched.

    ``isin_exch`` maps each ISIN to its exchange ("NSE"/"BSE") so the
    right instrument key (``NSE_EQ|`` vs ``BSE_EQ|``) is requested.

    Returns ``{isin: last_price}`` for every ISIN Upstox could price.
    ISINs absent from the result simply had no quote (delisted / illiquid).
    """
    out: dict[str, float] = {}
    isins = list(isin_exch)
    batches = [isins[i : i + BATCH_SIZE] for i in range(0, len(isins), BATCH_SIZE)]
    for n, batch in enumerate(batches, start=1):
        keys = ",".join(ikey(i, isin_exch.get(i, "NSE")) for i in batch)
        url = f"{LTP_URL}?{urllib.parse.urlencode({'instrument_key': keys})}"
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                # Upstox sits behind Cloudflare, which 1010-blocks the
                # default urllib UA. A normal browser UA clears it.
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0 Safari/537.36"
                ),
            },
        )
        print(
            f"  batch {n}/{len(batches)} ({len(batch)} keys) …",
            file=sys.stderr,
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            raise SystemExit(
                f"Upstox HTTP {e.code} on batch {n}: {body}\n"
                "If 401/403, your token expired — paste a fresh one."
            )
        data = payload.get("data") or {}
        for rec in data.values():
            tok = rec.get("instrument_token") or ""
            price = rec.get("last_price")
            if price is None:
                continue
            if not (tok.startswith("NSE_EQ|") or tok.startswith("BSE_EQ|")):
                continue
            isin = tok.split("|", 1)[1]
            try:
                out[isin] = float(price)
            except (TypeError, ValueError):
                continue
        if n < len(batches):
            time.sleep(BATCH_PAUSE_S)
    return out


def collect_isins(sectors: Mapping, instruments: Mapping) -> dict[str, str]:
    """Union of every ISIN across both universe files → exchange map.

    Returns ``{isin: "NSE"|"BSE"}``. Curated sectors / indices are NSE
    tickers (exch defaults NSE unless a stock carries an ``exch`` field).
    The flat instruments index flags BSE-only rows with a 3rd element
    ``"BSE"``; everything else is NSE. NSE wins on any conflict so a
    dual-listed ISIN is always priced via its NSE key.
    """
    seen: dict[str, str] = {}
    for group_key in ("sectors", "indices"):
        for grp in sectors.get(group_key, []) or []:
            for st in grp.get("stocks", []) or []:
                isin = st.get("isin")
                if not isin:
                    continue
                exch = st.get("exch") or "NSE"
                if isin not in seen or exch == "NSE":
                    seen[isin] = exch
    for pair in (instruments.get("stocks") or {}).values():
        if not pair or not pair[0]:
            continue
        isin = pair[0]
        exch = pair[2] if len(pair) >= 3 and pair[2] else "NSE"
        if isin not in seen:
            seen[isin] = exch
        elif exch == "NSE":
            seen[isin] = "NSE"
    return seen


def keep_isins(prices: Mapping[str, float], band: Band) -> set[str]:
    """ISINs whose live price falls inside the band."""
    return {isin for isin, px in prices.items() if band.contains(px)}


def prune_sectors(sectors: dict, keep: set[str]) -> tuple[dict, int, int]:
    """Filter sectors + indices stock lists to the kept ISIN set."""
    removed = 0
    kept = 0
    for group_key in ("sectors", "indices"):
        for grp in sectors.get(group_key, []) or []:
            before = grp.get("stocks", []) or []
            after = [st for st in before if st.get("isin") in keep]
            removed += len(before) - len(after)
            kept += len(after)
            grp["stocks"] = after
    return sectors, kept, removed


def prune_instruments(instruments: dict, keep: set[str]) -> tuple[dict, int, int]:
    """Filter the flat sym -> [isin, name] index to the kept ISIN set."""
    stocks = instruments.get("stocks") or {}
    after = {
        sym: pair
        for sym, pair in stocks.items()
        if pair and pair[0] in keep
    }
    removed = len(stocks) - len(after)
    instruments["stocks"] = after
    return instruments, len(after), removed


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--token", default=os.environ.get("UPSTOX_TOKEN", ""))
    ap.add_argument("--min", type=float, default=400.0, dest="lo")
    ap.add_argument("--max", type=float, default=2200.0, dest="hi")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    if not args.token:
        raise SystemExit(
            "No token. Set UPSTOX_TOKEN env var or pass --token <access_token> "
            "(the same daily token the app uses)."
        )

    band = Band(lo=args.lo, hi=args.hi)
    repo_root = Path(__file__).resolve().parent.parent.parent
    sectors_path = repo_root / "data" / "sectors.json"
    instruments_path = repo_root / "data" / "instruments-index.json"

    sectors = load_json(sectors_path)
    instruments = load_json(instruments_path)

    isin_exch = collect_isins(sectors, instruments)
    n_bse = sum(1 for e in isin_exch.values() if e == "BSE")
    print(
        f"Universe: {len(isin_exch)} unique ISINs "
        f"({len(isin_exch) - n_bse} NSE, {n_bse} BSE-only)",
        file=sys.stderr,
    )
    print(
        f"Fetching live prices from Upstox (band ₹{band.lo:g}–₹{band.hi:g}) …",
        file=sys.stderr,
    )
    prices = fetch_prices(isin_exch, args.token)
    print(f"  priced {len(prices)} / {len(isin_exch)}", file=sys.stderr)

    keep = keep_isins(prices, band)
    unpriced = len(isin_exch) - len(prices)
    print(
        f"In-band: {len(keep)} · out-of-band: {len(prices) - len(keep)} · "
        f"unpriced (dropped): {unpriced}",
        file=sys.stderr,
    )

    _, sec_kept, sec_removed = prune_sectors(sectors, keep)
    _, idx_kept, idx_removed = prune_instruments(instruments, keep)

    print(
        f"\nsectors.json: keep {sec_kept}, remove {sec_removed}\n"
        f"instruments-index.json: keep {idx_kept}, remove {idx_removed}",
        file=sys.stderr,
    )

    if args.dry_run:
        print("\n--dry-run: no files written.", file=sys.stderr)
        return 0

    sectors_path.write_text(
        json.dumps(sectors, indent=2) + "\n", encoding="utf-8"
    )
    instruments_path.write_text(
        json.dumps(instruments, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"\nWrote {sectors_path}\nWrote {instruments_path}", file=sys.stderr)
    print(
        "Done. Bump CACHE_VERSION in sw.js so clients pick up the pruned "
        "lists.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
