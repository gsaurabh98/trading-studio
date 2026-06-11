#!/usr/bin/env python3
"""One-shot generator: clone the Live-tab paper-trading module + UI for the
Intraday Trade tab as an INDEPENDENT book.

Why a generator (run once) rather than a maintained tool: the intraday clone is
meant to DIVERGE from the original (separate localStorage key, server-JSON
persistence, intraday pause source, its own chain/tick wiring). After this
script produces the files they are hand-patched and live independently — do not
re-run blindly or the hand-patches are lost. It exists for provenance / audit.

Transforms (behaviour-preserving namespacing):

* Element ids — every *book* element is read via ``$('pt-...')`` while every
  *shared singleton* (toast host, confirm modal, api-pause banner) uses
  ``document.getElementById('pt-...')``. So renaming only ``$('pt-`` -> ``$('itp-``
  namespaces the book and leaves the shared hosts AND the ``.pt-*`` CSS classes
  untouched (the clone reuses the same stylesheet).
* Function / handler names — whole-word ``\\bpt([A-Z]...)`` -> ``itp\\1`` keeps
  declarations, internal calls, ``window.*`` exposures and the ``onclick="pt...()"``
  strings the renderers emit all coherent. It can never hit ``pt-`` (hyphen)
  class strings.
* ``paperTrade*`` exposures -> ``itpPaperTrade*``.
* Storage key + pause key + IIFE/log tags get intraday-specific names.

Outputs:
  scripts/intraday-paper-trade.js          (the cloned module)
  /tmp/itp-paper-trade-block.html          (the transformed UI fragment)
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Final

ROOT: Final[Path] = Path(__file__).resolve().parent.parent.parent
SRC_JS: Final[Path] = ROOT / "scripts" / "paper-trade.js"
OUT_JS: Final[Path] = ROOT / "scripts" / "intraday-paper-trade.js"
SRC_HTML: Final[Path] = ROOT / "content" / "live.html"
OUT_HTML_FRAGMENT: Final[Path] = Path("/tmp/itp-paper-trade-block.html")

_PT_NAME: Final[re.Pattern[str]] = re.compile(r"\bpt([A-Z]\w*)")
_PAPERTRADE_NAME: Final[re.Pattern[str]] = re.compile(r"\bpaperTrade([A-Za-z]\w*)")
_DOLLAR_ID: Final[re.Pattern[str]] = re.compile(r"\$\((['\"])pt-")


def transform_js(src: str) -> str:
    """Namespace the paper-trade module into an independent intraday clone."""
    out = src
    out = out.replace("paperTradeModule", "intradayPaperTradeModule")
    out = out.replace("[paper-trade]", "[intraday-paper-trade]")
    out = out.replace("paper_trade_state_v1", "intraday_paper_trade_state_v1")
    out = out.replace("pt_api_paused_v1", "itp_api_paused_v1")
    # Element-id lookups (book-specific) — leave getElementById() singletons alone.
    out = _DOLLAR_ID.sub(lambda m: "$(" + m.group(1) + "itp-", out)
    # paperTrade* BEFORE pt* (paperTrade does not start with 'pt', order is safe
    # either way, but keep it explicit).
    out = _PAPERTRADE_NAME.sub(lambda m: "itpPaperTrade" + m.group(1), out)
    out = _PT_NAME.sub(lambda m: "itp" + m.group(1), out)
    # Header banner so the file announces its provenance.
    header = (
        "// Intraday paper-trading module — INDEPENDENT clone of scripts/paper-trade.js\n"
        "// (generated once by scripts/tools/clone-intraday-paper-trade.py, then\n"
        "// hand-patched). Separate book: localStorage key 'intraday_paper_trade_state_v1'\n"
        "// + server-JSON mirror (data/intraday-paper-trades.json via /local/intraday-trades)\n"
        "// so the book survives a browser storage clear. All book element ids are\n"
        "// 'itp-*'; window handlers are 'itp*'; shared toast/confirm hosts ('pt-*') are\n"
        "// reused. Do NOT regenerate blindly — hand-patches (persistence + intraday\n"
        "// pause + chain/tick wiring) would be lost.\n"
    )
    return header + out


def extract_html_block(src: str) -> str:
    """Slice the <div class="pt-shell">...</div> paper-trading block from live.html."""
    start = src.index('<div class="pt-shell">')
    end = src.index("<!-- \u2500\u2500\u2500 4. OPTION CHAIN", start)
    return src[start:end].rstrip()


def transform_html(block: str) -> str:
    """Namespace ids/for + handler names; keep .pt-* classes for shared CSS."""
    out = block
    out = out.replace('id="pt-', 'id="itp-')
    out = out.replace('for="pt-', 'for="itp-')
    out = _PT_NAME.sub(lambda m: "itp" + m.group(1), out)
    out = out.replace(
        "Paper Trading &mdash; Nifty 50", "Intraday Paper Trading &mdash; Nifty 50"
    )
    return out


def main() -> None:
    OUT_JS.write_text(transform_js(SRC_JS.read_text()))
    block = transform_html(extract_html_block(SRC_HTML.read_text()))
    OUT_HTML_FRAGMENT.write_text(block)
    print(f"wrote {OUT_JS.relative_to(ROOT)} ({OUT_JS.read_text().count(chr(10))} lines)")
    print(f"wrote {OUT_HTML_FRAGMENT} ({block.count(chr(10))} lines)")


if __name__ == "__main__":
    main()
