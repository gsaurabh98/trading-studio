#!/usr/bin/env python3
"""Byte-exact extractor for inline <script> blocks in candlestick-patterns.html.

Part of the May-2026 JS module split (see AGENTS.md §18). Moves a single inline
``<script>`` IIFE block out of the shell into ``scripts/<name>.js`` and replaces
it with a plain ``<script src="...">`` tag in the SAME document position — a
classic (non-module) script, so global functions / ``window.*`` exposures and
inline event-handler resolution are preserved exactly.

Why a script instead of hand-editing: the remaining blocks are large (up to
~14K lines) and the app drives real-money signals, so a transcription error is
unacceptable. This tool extracts verbatim and PROVES losslessness: it asserts
that re-indenting the written file body reproduces the original inline block
byte-for-byte before it writes anything to disk.

Usage::

    python3 scripts/tools/extract-js-module.py <key>     # extract one registered block
    python3 scripts/tools/extract-js-module.py --list     # show the registry

Pure stdlib. Idempotent only in the sense that re-running after a successful
extraction fails loudly (the anchor no longer matches an inline block), which
is the safe behaviour.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Final

SHELL: Final[Path] = Path(__file__).resolve().parent.parent.parent / "candlestick-patterns.html"
OPEN_TAG: Final[str] = "  <script>"
CLOSE_TAG: Final[str] = "  </script>"
SRC_INDENT: Final[str] = "  "
# Sentinel ending every generated header comment; the verifier splits on it to
# recover the pure extracted body for the byte-exact round-trip check.
SENTINEL: Final[str] = "// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---"


@dataclass(frozen=True)
class ExtractSpec:
    """One inline block to extract.

    anchor: a substring that appears on exactly one line inside exactly one
            inline <script> block — used to locate that block unambiguously.
    out:    output JS path, relative to the repo root.
    header: human-readable lines (without the leading '// ') placed atop the
            new file before the SENTINEL.
    html_comment: lines of an HTML comment placed above the <script src> tag.
    """

    key: str
    anchor: str
    out: str
    header: tuple[str, ...]
    html_comment: tuple[str, ...]


REGISTRY: Final[dict[str, ExtractSpec]] = {
    "navigation": ExtractSpec(
        key="navigation",
        anchor="function toggleTheme()",
        out="scripts/navigation.js",
        header=(
            "Navigation + UI bootstrap — theme toggle, sidebar drawer, section",
            "nav (ORDER/LABELS/GROUPS, prev/next, jump grid), keyboard shortcuts,",
            "lazy section-content loader, hash routing, palette + shortcuts modals.",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script",
            "src> in the SAME document position (classic script), so window.show /",
            "toggleTheme / toggleSidebar / gotoId / loadSectionContent /",
            "buildSectionChrome and the rest stay global for the inline handlers in",
            "the shell header + content/*.html, with unchanged DOMContentLoaded / hash",
            "routing timing.",
        ),
        html_comment=(
            "Navigation + UI bootstrap (theme / sidebar / section-nav / lazy content",
            "loader / hash routing / palette) — extracted to scripts/navigation.js in",
            "the May-2026 JS module split. Plain <script src> (classic) preserves the",
            "global functions used by inline handlers and the original init timing.",
        ),
    ),
    "live-chain": ExtractSpec(
        key="live-chain",
        anchor="function liveChainModule()",
        out="scripts/live-chain.js",
        header=(
            "Live option-chain module — Upstox chain fetch, OI bias scoring,",
            "support/resistance wall visualisation, 1Hz LTP poller, API token modal.",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script",
            "src> in the SAME document position (classic script), so the chain's",
            "window.* exposures stay global for the inline handlers in content/chain.html",
            "+ the API modal, with unchanged init timing. References to other modules",
            "(paper-trade / chart) are call-time only.",
        ),
        html_comment=(
            "Live option-chain + API token modal — extracted to scripts/live-chain.js",
            "in the May-2026 JS module split. Plain <script src> (classic) preserves",
            "the global exposures used by inline handlers and the original init timing.",
        ),
    ),
    "paper-trade": ExtractSpec(
        key="paper-trade",
        anchor="function paperTradeModule()",
        out="scripts/paper-trade.js",
        header=(
            "Paper-trading module — localStorage-backed sandbox: capital, SL/TGT,",
            "pending LIMIT/STOP orders, EOD square-off, option-price polling, and the",
            "card-based open / pending / history renderers.",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script",
            "src> in the SAME document position (classic script), so the pt* /",
            "paperTradeTick window.* exposures stay global for the inline handlers in",
            "content/live.html, with unchanged init timing. Cross-module references",
            "(chart / chain / intraday) are call-time only.",
        ),
        html_comment=(
            "Paper-trading sandbox (positions / SL-TGT / EOD square-off / option-price",
            "poll / renderers) — extracted to scripts/paper-trade.js in the May-2026 JS",
            "module split. Plain <script src> (classic) preserves the global exposures",
            "used by inline handlers and the original init timing.",
        ),
    ),
    "live-chart": ExtractSpec(
        key="live-chart",
        anchor="function liveChartModule()",
        out="scripts/live-chart.js",
        header=(
            "Live chart module — Lightweight Charts v5 wrapper, Upstox V3 WebSocket",
            "real-time feed (protobuf) + V2/V3 historical fetch + HTTP LTP fallback,",
            "market-hours detection, indicators / drawings / layouts, self-diagnostics.",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script",
            "src> in the SAME document position (classic script), so tvReload /",
            "tvSetTimeframe / isMarketOpen / nextOpenLabel / processSpotLtp and the",
            "rest stay global for the inline handlers in content/live.html, with",
            "unchanged init timing. Cross-module references (paper-trade / chain) are",
            "call-time only.",
        ),
        html_comment=(
            "Live chart (Lightweight Charts + Upstox WS/HTTP feed / indicators /",
            "drawings / market-hours) — extracted to scripts/live-chart.js in the",
            "May-2026 JS module split. Plain <script src> (classic) preserves the",
            "global exposures used by inline handlers and the original init timing.",
        ),
    ),
    "swing-analyzer": ExtractSpec(
        key="swing-analyzer",
        anchor="function swingModule()",
        out="scripts/swing-analyzer.js",
        header=(
            "Swing-trade analyzer — stock-universe loader, indicator-math library",
            "(ADX / Supertrend / Stochastic / OBV / candle patterns / zigzag / fib),",
            "per-TF analysis, trade-plan generator, stock picker, sector + fib scanner,",
            "renderers, and the swing live chart. ONE module-level IIFE (swingModule);",
            "~70 window.* exposures + ~170 closure-private helpers share its scope, so",
            "it is NOT internally splittable without rewriting signal logic — extracted",
            "whole (over the 1K cap by necessity; see AGENTS.md §18).",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split). Loaded via a plain <script src> in the SAME",
            "document position (classic script), so window.swing* / fibScan* / swSector*",
            "and the rest stay global for the inline handlers in content/swing.html,",
            "with unchanged init timing. Cross-module refs are call-time only.",
        ),
        html_comment=(
            "Swing-trade analyzer (universe + indicator math + per-TF analysis + plan",
            "generator + sector/fib scanner + renderers + swing chart) — extracted to",
            "scripts/swing-analyzer.js in the May-2026 JS module split. Single IIFE,",
            "not internally splittable without a signal-logic rewrite (AGENTS.md §18).",
            "Plain <script src> (classic) preserves global exposures + init timing.",
        ),
    ),
    "intraday-analyzer": ExtractSpec(
        key="intraday-analyzer",
        anchor="function intradayAnalyzerModule()",
        out="scripts/intraday-analyzer.js",
        header=(
            "Intraday multi-TF recommendation engine (SCALP-only) — session-phase",
            "classifier, India-VIX + Bank Nifty fetches, VWAP / ORH-ORL / PDH-PDL,",
            "RSI divergence, auto S/R, plan grid + ladder renderers, live re-pricing,",
            "plus the signal journal (sj*), event calendar (ia*Event), confirm modal",
            "(appConfirm*), backtest (bt* / runTrendBacktest), and paper-bridge. ONE",
            "module-level IIFE (intradayAnalyzerModule); ~70 window.* exposures + ~145",
            "closure-private helpers share its scope, so it is NOT internally splittable",
            "without rewriting signal logic — extracted whole (over the 1K cap by",
            "necessity; see AGENTS.md §18).",
            "",
            "Extracted verbatim from an inline <script> in candlestick-patterns.html",
            "(May 2026 JS module split). Loaded via a plain <script src> in the SAME",
            "document position (classic script), so window.intraday* / sj* / ia* / bt* /",
            "appConfirm* stay global for the inline handlers in content/live.html, with",
            "unchanged init timing. Cross-module refs are call-time only.",
        ),
        html_comment=(
            "Intraday analyzer (SCALP engine + signal journal + event calendar +",
            "confirm modal + backtest + paper-bridge) — extracted to",
            "scripts/intraday-analyzer.js in the May-2026 JS module split. Single IIFE,",
            "not internally splittable without a signal-logic rewrite (AGENTS.md §18).",
            "Plain <script src> (classic) preserves global exposures + init timing.",
        ),
    ),
}


def read_lines(path: Path) -> list[str]:
    """Return file content split on '\\n' WITHOUT keeping line endings."""
    return path.read_text(encoding="utf-8").split("\n")


def find_blocks(lines: list[str]) -> list[tuple[int, int]]:
    """Pair canonical '  <script>' / '  </script>' tag lines (they never nest).

    Only exact tag lines count — a literal '<script>' inside a JS comment or
    string is mid-line and is ignored, so it can't confuse the pairing.
    """
    blocks: list[tuple[int, int]] = []
    open_idx: int | None = None
    for i, line in enumerate(lines):
        if line == OPEN_TAG:
            if open_idx is not None:
                raise ValueError(f"nested {OPEN_TAG!r} at line {i + 1}")
            open_idx = i
        elif line == CLOSE_TAG and open_idx is not None:
            blocks.append((open_idx, i))
            open_idx = None
    if open_idx is not None:
        raise ValueError(f"unclosed {OPEN_TAG!r} at line {open_idx + 1}")
    return blocks


def locate(lines: list[str], blocks: list[tuple[int, int]], anchor: str) -> tuple[int, int]:
    """Return the unique block whose inner body contains `anchor`."""
    hits = [
        (o, c)
        for (o, c) in blocks
        if any(anchor in lines[k] for k in range(o + 1, c))
    ]
    if len(hits) != 1:
        raise ValueError(f"anchor {anchor!r} matched {len(hits)} blocks (need exactly 1)")
    return hits[0]


def min_indent(inner: list[str]) -> int:
    """Smallest leading-space count among non-blank lines (the dedent amount)."""
    widths = [len(ln) - len(ln.lstrip(" ")) for ln in inner if ln.strip() != ""]
    return min(widths) if widths else 0


def dedent(inner: list[str], n: int) -> list[str]:
    """Remove n leading spaces from non-blank lines; pass blank lines through
    VERBATIM (preserving any original whitespace) so the round-trip is byte-exact.

    n is the min indent over non-blank lines, so every non-blank line has >= n
    leading spaces and survives the strip losslessly. Blank lines (whitespace-only)
    are left untouched here and by reindent(), which is what makes monster blocks
    that contain trailing-whitespace blank lines extract losslessly."""
    return [(ln if ln.strip() == "" else ln[n:]) for ln in inner]


def reindent(body: list[str], n: int) -> list[str]:
    """Inverse of dedent: re-add n leading spaces to non-blank lines; blank lines
    pass through verbatim (mirrors dedent so the round-trip is the identity)."""
    pad = " " * n
    return [(ln if ln.strip() == "" else pad + ln) for ln in body]


def build_file(spec: ExtractSpec, body: list[str]) -> str:
    head = [f"// {h}".rstrip() for h in spec.header]
    return "\n".join(head + [SENTINEL, ""] + body) + "\n"


def body_from_file(text: str) -> list[str]:
    """Recover the extracted body from a generated file (everything after the
    SENTINEL + its trailing blank line), dropping the single trailing newline."""
    lines = text.split("\n")
    idx = lines.index(SENTINEL)
    rest = lines[idx + 2 :]  # skip SENTINEL and the blank line after it
    if rest and rest[-1] == "":
        rest = rest[:-1]
    return rest


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        print("Registered keys:", ", ".join(sorted(REGISTRY)))
        return 0
    if argv[0] == "--list":
        for k, s in sorted(REGISTRY.items()):
            print(f"{k:14s} anchor={s.anchor!r:34s} -> {s.out}")
        return 0

    key = argv[0]
    spec = REGISTRY.get(key)
    if spec is None:
        print(f"unknown key {key!r}; try --list", file=sys.stderr)
        return 2

    lines = read_lines(SHELL)
    o, c = locate(lines, find_blocks(lines), spec.anchor)
    inner = lines[o + 1 : c]
    n = min_indent(inner)
    body = dedent(inner, n)

    # ── Byte-exact safety gate: refuse to write unless lossless ──
    if reindent(body, n) != inner:
        print("ABORT: dedent/reindent is not lossless for this block", file=sys.stderr)
        return 3
    file_text = build_file(spec, body)
    if reindent(body_from_file(file_text), n) != inner:
        print("ABORT: on-disk round-trip does not reproduce the block", file=sys.stderr)
        return 3

    # Build the new HTML: drop lines [o..c], insert the HTML comment + <script src>.
    src_basename = spec.out
    comment = [f"{SRC_INDENT}<!-- {spec.html_comment[0]}"] + [
        f"{SRC_INDENT}     {ln}" for ln in spec.html_comment[1:]
    ]
    comment[-1] = comment[-1] + " -->"
    src_line = f'{SRC_INDENT}<script src="{src_basename}"></script>'
    new_lines = lines[:o] + comment + [src_line] + lines[c + 1 :]

    out_path = SHELL.parent / spec.out
    out_path.write_text(file_text, encoding="utf-8")
    SHELL.write_text("\n".join(new_lines), encoding="utf-8")

    print(f"✓ extracted block (shell lines {o + 1}-{c + 1}, {c - o + 1} lines)")
    print(f"  → {spec.out} ({len(body)} body lines, dedent={n})")
    print(f"  shell now {len(new_lines)} lines (was {len(lines)})")
    print("  byte-exact round-trip: VERIFIED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
