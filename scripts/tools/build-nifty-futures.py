#!/usr/bin/env python3
"""Build ``data/nifty-futures.json`` — the front-month resolver for Nifty volume.

WHY THIS EXISTS
---------------
The intraday chart prices ``NSE_INDEX|Nifty 50``, but the **index reports
volume = 0** on Upstox. To get a real, bar-aligned volume series (so the app can
tell a genuine breakout from a fake one), we borrow the **Nifty futures** volume —
the standard "index volume" proxy professional traders use.

A futures contract expires on the last Thursday of its month, so its
``instrument_key`` changes every month (June → July → August …). This script
snapshots the next few monthly Nifty FUT contracts (key + expiry) into a small
JSON file. At runtime ``scripts/intraday-volume.js`` reads that file and picks the
nearest **non-expired** contract, so the app auto-rolls month-to-month for as long
as the snapshot has unexpired contracts (~3 months) before a refresh is needed.

Fail-safe by design: if every snapshotted contract has expired (the file went
stale), the runtime resolver returns ``null`` and the app simply shows
"volume unavailable" rather than pricing a dead contract — no wrong signals.

USAGE
-----
    python3 scripts/tools/build-nifty-futures.py

Re-run every couple of months (or after any expiry you care about) to keep the
snapshot fresh. Then bump ``CACHE_VERSION`` in ``sw.js`` so installed PWAs pick up
the new file. The script is read-only against the rest of the repo.
"""
from __future__ import annotations

import gzip
import io
import json
import sys
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Final, Sequence

# Upstox publishes the full NSE instrument master here (same source the swing
# tab's lookup tool uses). It contains every NSE_FO future / option row.
NSE_MASTER_URL: Final[str] = (
    "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz"
)

# Repo-root-relative output. The runtime fetch in intraday-volume.js is
# 'data/nifty-futures.json', so this path must not move (see AGENTS.md §1.1).
OUTPUT_PATH: Final[Path] = Path("data/nifty-futures.json")

# How many forward monthly contracts to snapshot. 3 covers ~3 months of
# auto-rollover headroom before a refresh is required.
MAX_CONTRACTS: Final[int] = 3

UNDERLYING_KEY: Final[str] = "NSE_INDEX|Nifty 50"


@dataclass(frozen=True)
class FuturesContract:
    """One monthly Nifty futures contract — the minimal shape the app needs."""

    instrument_key: str
    trading_symbol: str
    expiry_ms: int
    lot_size: int
    tick_size: float

    def to_json(self) -> dict[str, Any]:
        return {
            "instrument_key": self.instrument_key,
            "trading_symbol": self.trading_symbol,
            "expiry": self.expiry_ms,
            "lot_size": self.lot_size,
            "tick_size": self.tick_size,
        }


def _download_master() -> list[dict[str, Any]]:
    """Fetch + gunzip + parse the Upstox NSE instrument master."""
    with urllib.request.urlopen(NSE_MASTER_URL, timeout=60) as resp:
        raw = resp.read()
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as gz:
        data = json.load(gz)
    if not isinstance(data, list):
        raise RuntimeError("Unexpected master shape (expected a JSON array)")
    return data


def _is_nifty_future(row: dict[str, Any]) -> bool:
    """True only for the monthly NIFTY index future (not BankNifty, not options)."""
    return (
        row.get("segment") == "NSE_FO"
        and row.get("instrument_type") in ("FUT", "Futures")
        and (row.get("name") or "").upper() == "NIFTY"
        and (row.get("asset_key") or row.get("underlying_key")) == UNDERLYING_KEY
    )


def _to_contract(row: dict[str, Any]) -> FuturesContract | None:
    """Map a raw master row to a typed contract; None if a required field is bad."""
    key = row.get("instrument_key")
    expiry = row.get("expiry")
    if not isinstance(key, str) or not isinstance(expiry, (int, float)):
        return None
    return FuturesContract(
        instrument_key=key,
        trading_symbol=str(row.get("trading_symbol") or ""),
        expiry_ms=int(expiry),
        lot_size=int(row.get("lot_size") or 0),
        tick_size=float(row.get("tick_size") or 0.0),
    )


def select_contracts(
    rows: Sequence[dict[str, Any]], now_ms: int, limit: int
) -> list[FuturesContract]:
    """Pure: pick up to ``limit`` non-expired Nifty futures, nearest expiry first."""
    contracts = [c for c in (_to_contract(r) for r in rows if _is_nifty_future(r)) if c]
    live = [c for c in contracts if c.expiry_ms > now_ms]
    live.sort(key=lambda c: c.expiry_ms)
    return live[:limit]


def build_payload(contracts: Sequence[FuturesContract], now: datetime) -> dict[str, Any]:
    """Pure: assemble the JSON payload the runtime resolver reads."""
    return {
        "_comment": (
            "Front-month Nifty futures resolver for the intraday volume proxy. "
            "The Nifty INDEX reports vol=0, so the app borrows futures volume. "
            "Regenerate with: python3 scripts/tools/build-nifty-futures.py "
            "(then bump CACHE_VERSION in sw.js). Runtime picks the nearest "
            "non-expired contract; fails safe to 'no volume' if all expired."
        ),
        "generated_at": now.astimezone(timezone.utc).isoformat(),
        "underlying": UNDERLYING_KEY,
        "contracts": [c.to_json() for c in contracts],
    }


def main(argv: Sequence[str]) -> int:
    now = datetime.now(timezone.utc)
    now_ms = int(now.timestamp() * 1000)
    try:
        rows = _download_master()
    except Exception as exc:  # noqa: BLE001 — surface any network/parse failure clearly
        print(f"ERROR: could not download/parse the Upstox master: {exc}", file=sys.stderr)
        return 1

    contracts = select_contracts(rows, now_ms, MAX_CONTRACTS)
    if not contracts:
        print(
            "ERROR: found no non-expired Nifty futures in the master — refusing to "
            "write an empty file (the app would lose its volume source).",
            file=sys.stderr,
        )
        return 2

    payload = build_payload(contracts, now)
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")

    print(f"Wrote {OUTPUT_PATH} with {len(contracts)} contract(s):")
    for c in contracts:
        expiry = datetime.fromtimestamp(c.expiry_ms / 1000, tz=timezone.utc).date()
        print(f"  {c.instrument_key:14} {c.trading_symbol:22} expiry {expiry}")
    print("\nReminder: bump CACHE_VERSION in sw.js so installed PWAs pick this up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
