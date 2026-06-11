#!/usr/bin/env python3
"""Seed DEMO data into the two intraday durable JSON stores so the Signal
Journal table and the Paper-Trading tables (Open / History) render with
realistic-looking rows.

Writes (overwrites) both files the app hydrates from on localhost:
  - data/intraday-signal-journal.json   ({ "journal": [...], "savedAt": ... })
  - data/intraday-paper-trades.json      ({ capital, open, history, ... })

The shapes here EXACTLY match what the renderers read:
  journal rows  → scripts/intraday-trade.js  renderJournal()
  paper open    → scripts/intraday-paper-trade.js renderOpen()
  paper history → scripts/intraday-paper-trade.js renderHistory()

Timestamps are anchored to TODAY (IST) so:
  - the journal's one OPEN row is not expired by expireStaleOpen() (which only
    closes OPEN rows carried over from a *previous* IST day), and
  - "Today's realized P&L" picks up the closed paper trades.

This is DEMO data only — no real capital. Re-run any time to reset the demo.
Run from the repo root:  python3 scripts/tools/seed-intraday-dummy.py
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Final

# India Standard Time — every timestamp the app reasons about is IST.
IST: Final[timezone] = timezone(timedelta(hours=5, minutes=30))
DATA_DIR: Final[Path] = Path(__file__).resolve().parents[2] / "data"
JOURNAL_PATH: Final[Path] = DATA_DIR / "intraday-signal-journal.json"
TRADES_PATH: Final[Path] = DATA_DIR / "intraday-paper-trades.json"

START_CAPITAL: Final[int] = 100_000
LOT_SIZE: Final[int] = 65
EXPIRY: Final[str] = "2026-06-11"  # nearest weekly (display only)


def _ms_today(hour: int, minute: int) -> int:
    """Epoch milliseconds for HH:MM IST *today* (the IST calendar day)."""
    now_ist = datetime.now(IST)
    stamp = now_ist.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return int(stamp.timestamp() * 1000)


# ─────────────────────────── Signal Journal ───────────────────────────
@dataclass(frozen=True)
class JournalRow:
    """One auto-trade signal — spot forward-test, scored in index points."""

    id: str
    ts: int
    side: str            # 'CE' | 'PE'
    strike: int
    conf: str            # 'HIGH' | 'MEDIUM' | 'LOW'
    entry: float
    sl: float
    t1: float
    r: float
    status: str          # 'OPEN' | 'CLOSED'
    outcome: str         # 'OPEN' | 'T1' | 'SL' | 'EOD'
    pts: float | None
    exit: float | None
    exitTs: int | None


def _rr(entry: float, sl: float, t1: float) -> float:
    risk = abs(entry - sl)
    return round(abs(t1 - entry) / risk, 1) if risk else 0.0


def build_journal() -> list[JournalRow]:
    """Newest-first list mirroring how journalAdd() unshifts entries."""
    return [
        # OPEN now (survives expireStaleOpen because ts is today).
        JournalRow("demoJ6", _ms_today(14, 35), "CE", 23700, "HIGH",
                   23702.0, 23672.0, 23762.0, _rr(23702, 23672, 23762),
                   "OPEN", "OPEN", None, None, None),
        # CLOSED — stop hit (loss).
        JournalRow("demoJ5", _ms_today(14, 5), "CE", 23650, "MEDIUM",
                   23652.0, 23624.0, 23710.0, _rr(23652, 23624, 23710),
                   "CLOSED", "SL", -28.0, 23624.0, _ms_today(14, 18)),
        # CLOSED — squared off at 15:25 (small win).
        JournalRow("demoJ4", _ms_today(13, 20), "PE", 23750, "LOW",
                   23748.0, 23778.0, 23690.0, _rr(23748, 23778, 23690),
                   "CLOSED", "EOD", 8.0, 23740.0, _ms_today(13, 40)),
        # CLOSED — target hit (win).
        JournalRow("demoJ3", _ms_today(11, 0), "CE", 23600, "HIGH",
                   23602.0, 23574.0, 23660.0, _rr(23602, 23574, 23660),
                   "CLOSED", "T1", 58.0, 23660.0, _ms_today(11, 22)),
        # CLOSED — stop hit (loss).
        JournalRow("demoJ2", _ms_today(10, 15), "PE", 23700, "MEDIUM",
                   23700.0, 23730.0, 23640.0, _rr(23700, 23730, 23640),
                   "CLOSED", "SL", -30.0, 23730.0, _ms_today(10, 31)),
        # CLOSED — target hit (win).
        JournalRow("demoJ1", _ms_today(9, 30), "CE", 23650, "HIGH",
                   23648.0, 23618.0, 23708.0, _rr(23648, 23618, 23708),
                   "CLOSED", "T1", 60.0, 23708.0, _ms_today(9, 52)),
    ]


# ─────────────────────────── Paper Book ───────────────────────────
@dataclass(frozen=True)
class OptPosition:
    """An OPT leg shaped exactly like paperTradeModule's open/history items."""

    id: str
    kind: str
    side: str
    optType: str
    strike: int
    expiry: str
    instrumentKey: str
    qty: int
    entry: float
    entryTs: int
    lastPx: float | None = None
    sl: float | None = None
    tgt: float | None = None
    exit: float | None = None
    exitTs: int | None = None
    pnl: int | None = None
    pts: float | None = None
    exitReason: str | None = None


def _open_positions() -> list[OptPosition]:
    return [
        OptPosition(
            id="demoP_OPEN", kind="OPT", side="BUY", optType="CE", strike=23700,
            expiry=EXPIRY, instrumentKey="NSE_FO|DEMO_CE_23700", qty=LOT_SIZE,
            entry=120.5, entryTs=_ms_today(14, 35), lastPx=138.0, sl=95.0, tgt=175.0,
        ),
    ]


def _history_positions() -> list[OptPosition]:
    # Closed legs. pnl = (exit - entry) * qty ; pts = exit - entry.
    win = OptPosition(
        id="demoP_WIN", kind="OPT", side="BUY", optType="PE", strike=23700,
        expiry=EXPIRY, instrumentKey="NSE_FO|DEMO_PE_23700", qty=LOT_SIZE,
        entry=88.0, entryTs=_ms_today(10, 5), exit=132.0, exitTs=_ms_today(10, 38),
        pnl=int(round((132.0 - 88.0) * LOT_SIZE)), pts=44.0, exitReason="TGT",
    )
    loss = OptPosition(
        id="demoP_LOSS", kind="OPT", side="BUY", optType="CE", strike=23600,
        expiry=EXPIRY, instrumentKey="NSE_FO|DEMO_CE_23600", qty=LOT_SIZE * 2,
        entry=145.0, entryTs=_ms_today(11, 50), exit=130.5, exitTs=_ms_today(12, 12),
        pnl=int(round((130.5 - 145.0) * LOT_SIZE * 2)), pts=-14.5, exitReason="SL",
    )
    return [loss, win]   # newest-first is not required; renderHistory maps in order


def _fmt_dur(ms: int) -> str:
    secs = ms // 1000
    mins, _ = divmod(secs, 60)
    hrs, mins = divmod(mins, 60)
    return f"{hrs}h {mins}m" if hrs else f"{mins}m"


def _history_as_trades(history: list[OptPosition]) -> list[dict[str, object]]:
    """The self-describing column list (Result/Instrument/Side/Lots/Entry/Exit/
    Pts/P&L/Held) that paperTradeModule.historyAsTrades() writes alongside the
    raw state — kept here so the on-disk JSON is human-readable too."""
    rows: list[dict[str, object]] = []
    for h in history:
        held = _fmt_dur((h.exitTs or 0) - h.entryTs) if h.exitTs else ""
        rows.append({
            "result": h.exitReason or "",
            "instrument": f"{h.strike} {h.optType}",
            "side": f"BUY {h.optType}",
            "lots": h.qty,
            "entry": h.entry,
            "exit": h.exit,
            "pts": h.pts,
            "pnl": h.pnl,
            "held": held,
            "entryTs": h.entryTs,
            "exitTs": h.exitTs,
        })
    return rows


def _clean(d: dict[str, object]) -> dict[str, object]:
    """Drop None fields so the JSON matches the runtime shape (which omits
    undefined keys) rather than carrying explicit nulls for OPT-only fields."""
    return {k: v for k, v in d.items() if v is not None}


def build_paper_book() -> dict[str, object]:
    open_pos = _open_positions()
    history = _history_positions()
    realized = sum(int(h.pnl or 0) for h in history)
    capital = START_CAPITAL + realized   # capital only moves on exit (capital += pnl)
    return {
        "capital": capital,
        "open": [_clean(asdict(p)) for p in open_pos],
        "history": [_clean(asdict(p)) for p in history],
        "pending": [],
        "qtyCE": 1,
        "qtyPE": 1,
        "trades": _history_as_trades(history),
        "savedAt": datetime.now(IST).isoformat(),
    }


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    journal = {
        "journal": [asdict(r) for r in build_journal()],
        "savedAt": datetime.now(IST).isoformat(),
    }
    JOURNAL_PATH.write_text(json.dumps(journal, indent=2), encoding="utf-8")

    book = build_paper_book()
    TRADES_PATH.write_text(json.dumps(book, indent=2), encoding="utf-8")

    scored = [r for r in build_journal() if r.status == "CLOSED" and r.pts is not None]
    net_pts = sum(r.pts for r in scored if r.pts is not None)
    print(f"Seeded {JOURNAL_PATH.relative_to(DATA_DIR.parent)}: "
          f"{len(journal['journal'])} signals "
          f"({len(scored)} scored, net {net_pts:+.1f} pts)")
    print(f"Seeded {TRADES_PATH.relative_to(DATA_DIR.parent)}: "
          f"capital ₹{book['capital']:,}, "
          f"{len(book['open'])} open, {len(book['history'])} closed")


if __name__ == "__main__":
    main()
