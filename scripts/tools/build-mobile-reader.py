"""Build a single self-contained mobile-reader HTML for offline learning.

Output: mobile-reader.html at the project root.

Why a separate build (instead of just copying the main file to a phone):
  - The main app lazy-loads section content via fetch('content/X.html'); that
    fails under file:// because browsers block fetches from the local FS.
  - The main app pulls Lightweight Charts from unpkg, Google Fonts, and the
    Upstox API — none of which work offline.
  - The main app's interactive bits (paper trading, option chain, calculators)
    don't survive the strip pass.

What this build does that earlier versions did NOT:
  - Inlines the FULL original <style> blocks from the main shell. Every card,
    grid, badge, candle SVG, info-box, glossary term, etc. renders identically
    to the main app. (The previous build hand-rolled minimal CSS that styled
    only ~10% of the tokens used by the content.)
  - Adds a thin reader-only override layer that:
      • forces all .sec to be visible (the original hides them by default),
      • hides app-only chrome (`.nav`, `.app-header`, etc.) defensively,
      • adds a `.reader-*` topbar / TOC drawer / back-to-top FAB.

Usage:
    .venv/bin/python scripts/tools/build-mobile-reader.py
    open mobile-reader.html               # or copy to phone via AirDrop / Drive

Adding / removing sections: edit the SECTIONS tuple below. The order in the
tuple is the order in the reader and in the TOC.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Final


# ── Paths ──────────────────────────────────────────────────────────────
ROOT: Final[Path] = Path(__file__).resolve().parent.parent.parent
CONTENT_DIR: Final[Path] = ROOT / "content"
STYLES_DIR: Final[Path] = ROOT / "styles"
MAIN_HTML: Final[Path] = ROOT / "candlestick-patterns.html"
OUTPUT: Final[Path] = ROOT / "mobile-reader.html"


# ── Section manifest ──────────────────────────────────────────────────
@dataclass(frozen=True)
class Section:
    """One reading section in the assembled mobile reader.

    `id` matches the corresponding content/<id>.html filename (or "anatomy"
    which is read out of the main shell because it's the inline default).
    `title` is the human label shown in the TOC + section header.
    `group` is the bucket the section is filed under in the TOC.
    """
    id: str
    title: str
    group: str


# Educational reading sections only. Interactive ones (live paper-trading,
# option chain, bias calculator, position-size calculator) are deliberately
# excluded — they need network APIs and JS modules that don't survive the
# strip pass.
SECTIONS: Final[tuple[Section, ...]] = (
    # Foundation
    Section("anatomy", "Anatomy", "Foundation"),
    # Candle patterns
    Section("single", "Single Candles", "Candles"),
    Section("double", "Double Candles", "Candles"),
    Section("triple", "Triple Candles", "Candles"),
    Section("multi", "Multi-Candle", "Candles"),
    Section("continuation", "Continuation", "Candles"),
    Section("exotic", "Exotic", "Candles"),
    Section("missing", "More Patterns", "Candles"),
    # Chart patterns
    Section("chart", "Chart Patterns", "Patterns"),
    Section("traps", "Traps & Failures", "Patterns"),
    # Analysis
    Section("techanal", "Technical Analysis", "Analysis"),
    Section("snr", "Support & Resistance", "Analysis"),
    Section("breakouts", "Breakouts", "Analysis"),
    Section("retracement", "Retracement", "Analysis"),
    Section("timeframe", "Timeframe", "Analysis"),
    Section("cpr", "CPR & Pivots", "Analysis"),
    Section("strategy", "Master Table", "Analysis"),
    # Indicators
    Section("ind-trend", "Trend Indicators", "Indicators"),
    Section("ind-momentum", "Momentum Indicators", "Indicators"),
    Section("ind-volume", "Volume Indicators", "Indicators"),
    # F&O playbook
    Section("options", "Buying Rules", "F&O Playbook"),
    Section("greeks", "Greeks", "F&O Playbook"),
    Section("exits", "SL & Targets", "F&O Playbook"),
    Section("expiry", "Expiry Day", "F&O Playbook"),
    Section("hedging", "Hedging", "F&O Playbook"),
    Section("scalping", "Scalping", "F&O Playbook"),
    # Strategy
    Section("operators", "Operators", "Strategy"),
    Section("playbook", "Pick Strategy", "Strategy"),
    # Discipline
    Section("behavior", "Behavioral Analysis", "Discipline"),
    Section("risk", "Risk Mgmt", "Discipline"),
    Section("checklist", "Checklist", "Discipline"),
    # Reference
    Section("market", "Indian Market", "Reference"),
    Section("glossary", "Glossary", "Reference"),
    Section("faq", "FAQ", "Reference"),
)


# ── Original-CSS extraction ───────────────────────────────────────────
# Since the May-2026 split, the shell's CSS lives in styles/*.css linked
# via <link rel="stylesheet" href="styles/X.css">. We still scan for inline
# <style> blocks defensively in case any are added back later.
_STYLE_BLOCK_RE: Final[re.Pattern[str]] = re.compile(
    r"<style\b[^>]*>([\s\S]*?)</style>", re.IGNORECASE
)
_STYLE_LINK_RE: Final[re.Pattern[str]] = re.compile(
    r'<link\b[^>]*rel=["\']stylesheet["\'][^>]*href=["\'](styles/[^"\']+\.css)["\'][^>]*>',
    re.IGNORECASE,
)


def extract_main_styles(main_html: str) -> str:
    """Return all CSS referenced by the main shell, concatenated in document order.

    We inline the entire original stylesheet so reader sections render with
    the exact same visual tokens (colors, spacing, badges, candle SVG sizes,
    grids) as the main app. Sources, in cascade order:
      1) styles/*.css files linked via <link rel="stylesheet" href="styles/...">
         (the post-May-2026 split layout)
      2) any remaining inline <style> blocks in the shell
    Each is emitted in the order it appears in the document so the resulting
    cascade matches the live app exactly.
    """
    # Collect (position, label, css_body) tuples, then sort by position so
    # external links and inline blocks interleave in true document order.
    found: list[tuple[int, str, str]] = []

    for match in _STYLE_LINK_RE.finditer(main_html):
        href = match.group(1)
        path = ROOT / href
        if not path.exists():
            raise RuntimeError(
                f"Shell references {href} but {path} is missing — "
                f"run the CSS extractor (or restore styles/ from git) first."
            )
        found.append((match.start(), href, path.read_text(encoding="utf-8")))

    for match in _STYLE_BLOCK_RE.finditer(main_html):
        found.append((match.start(), "<inline style>", match.group(1)))

    if not found:
        raise RuntimeError(
            "No <link rel=stylesheet href=styles/...> tags or <style> blocks "
            "found in candlestick-patterns.html"
        )

    found.sort(key=lambda t: t[0])
    return "\n\n".join(
        f"/* ──────── {label} ──────── */\n{body.rstrip()}"
        for _, label, body in found
    )


# ── Extraction + sanitisation ─────────────────────────────────────────
def extract_inline_section(main_html: str, section_id: str) -> str:
    """Pull the inner HTML of <div class="sec ... id="{section_id}"> from the shell.

    Done with a small <div>-depth tracker because the section contains nested
    divs. Regex alone would be fragile; an HTML parser is overkill for one well-
    formed block we control end-to-end.
    """
    open_pattern = re.compile(
        rf'<div class="sec[^"]*"\s+id="{re.escape(section_id)}">',
        re.IGNORECASE,
    )
    match = open_pattern.search(main_html)
    if not match:
        raise RuntimeError(f"Could not find inline section '{section_id}' in main HTML")

    start = match.end()
    depth = 1
    cursor = start
    div_re = re.compile(r"<(/?)div\b", re.IGNORECASE)
    while cursor < len(main_html) and depth > 0:
        tag_match = div_re.search(main_html, cursor)
        if not tag_match:
            raise RuntimeError(f"Section '{section_id}' has no matching closing </div>")
        depth += -1 if tag_match.group(1) else 1
        cursor = tag_match.end()
    end = cursor - len("</div>")
    return main_html[start:end].strip()


# Strip JS event handlers and pseudo-button affordances. The reader has no JS
# modules to handle these, and leaving role="button" on a non-interactive <div>
# would mislead screen readers.
_STRIP_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r'\s+onclick="[^"]*"'),
    re.compile(r'\s+onkeydown="[^"]*"'),
    re.compile(r'\s+onmouseover="[^"]*"'),
    re.compile(r'\s+role="button"'),
    re.compile(r'\s+tabindex="0"'),
)


def strip_interactive(html: str) -> str:
    """Remove inline event handlers + button affordances from non-button elements."""
    for pat in _STRIP_PATTERNS:
        html = pat.sub("", html)
    return html


# When an anchor in the source content points to an interactive section that
# the reader excludes, redirect it to the nearest topical alternative so taps
# don't dead-end. Chosen by hand based on what the original section was about:
EXCLUDED_REDIRECTS: Final[dict[str, str]] = {
    "chain": "options",   # option chain reading → buying rules (next-best advanced read)
    "bias": "options",    # OI bias calculator → buying rules
    "calc": "exits",      # position-size calculator → SL & targets (where sizing is discussed)
    "live": "playbook",   # paper-trading sandbox → pick-strategy playbook
}


def redirect_dead_anchors(html: str) -> str:
    """Rewrite href="#X" where X is an excluded section id to its alternative."""
    def sub(match: re.Match[str]) -> str:
        target = match.group(1)
        if target in EXCLUDED_REDIRECTS:
            return f'href="#{EXCLUDED_REDIRECTS[target]}"'
        return match.group(0)
    return re.sub(r'href="#([a-zA-Z][\w-]*)"', sub, html)


def strip_affiliate_cards(html: str) -> str:
    """Remove <div class="aff-card">…</div> blocks entirely.

    Affiliate buttons fire JS that builds a tracked broker URL — that JS isn't
    in the reader, so the buttons would just dead-link to '#'. Easier to drop
    the whole card; offline learners don't need the broker referral pitch.
    """
    open_re = re.compile(r'<div class="aff-card[^"]*">')
    out: list[str] = []
    cursor = 0
    while True:
        m = open_re.search(html, cursor)
        if not m:
            out.append(html[cursor:])
            return "".join(out)
        out.append(html[cursor:m.start()])
        depth = 1
        i = m.end()
        div_re = re.compile(r"<(/?)div\b", re.IGNORECASE)
        while i < len(html) and depth > 0:
            tag = div_re.search(html, i)
            if not tag:
                raise RuntimeError("Unbalanced aff-card div")
            depth += -1 if tag.group(1) else 1
            i = tag.end()
        cursor = i


def rewrite_path_cards(html: str) -> str:
    """Convert the home-page learning-path <div class="path-card"> blocks into
    real <a href="#section"> links so they still navigate inside the reader.

    The originals fired paletteSelect('id') on click. That JS doesn't exist in
    the reader, so we capture the target id from the original `onclick` BEFORE
    `strip_interactive` runs and emit a wrapping anchor.
    """
    return re.sub(
        r'<div class="path-card([^"]*)" onclick="paletteSelect\(\'([^\']+)\'\)"[^>]*>',
        lambda m: f'<a class="path-card{m.group(1)}" href="#{m.group(2)}">',
        html,
    )


def close_path_cards(html: str) -> str:
    """Close the <a> wrappers we opened for path cards.

    Counts opens and matches the corresponding `</div>` that closes each card
    block. Because path-cards never nest, a simple anchor-by-anchor scan works.
    """
    out: list[str] = []
    cursor = 0
    open_re = re.compile(r'<a class="path-card[^"]*" href="#[^"]+">')
    while True:
        m = open_re.search(html, cursor)
        if not m:
            out.append(html[cursor:])
            break
        out.append(html[cursor:m.end()])
        depth = 1
        i = m.end()
        div_re = re.compile(r"<(/?)div\b", re.IGNORECASE)
        while i < len(html) and depth > 0:
            tag = div_re.search(html, i)
            if not tag:
                raise RuntimeError("Unbalanced path-card div")
            depth += -1 if tag.group(1) else 1
            i = tag.end()
        out.append(html[m.end():i - len("</div>")])
        out.append("</a>")
        cursor = i
    return "".join(out)


# ── Build ─────────────────────────────────────────────────────────────
def build() -> str:
    """Assemble the final mobile-reader HTML string."""
    main_html = MAIN_HTML.read_text(encoding="utf-8")
    main_styles = extract_main_styles(main_html)

    sections_html: list[str] = []
    skipped: list[str] = []
    for sec in SECTIONS:
        if sec.id == "anatomy":
            inner = extract_inline_section(main_html, "anatomy")
        else:
            path = CONTENT_DIR / f"{sec.id}.html"
            if not path.exists():
                skipped.append(sec.id)
                continue
            inner = path.read_text(encoding="utf-8")

        inner = strip_affiliate_cards(inner)
        inner = rewrite_path_cards(inner)
        inner = strip_interactive(inner)
        inner = close_path_cards(inner)
        inner = redirect_dead_anchors(inner)

        # Note: we do NOT add a separate eyebrow div because the original .shead
        # already gives each section a strong title. Adding our own would
        # double up. The TOC group label is enough context.
        sections_html.append(
            f'<section id="{sec.id}" class="sec">\n{inner}\n</section>'
        )

    if skipped:
        print(f"  SKIPPED (file missing): {', '.join(skipped)}")

    toc_html = _build_toc(SECTIONS)
    body = "\n\n".join(sections_html)
    total = str(len(SECTIONS) - len(skipped))
    # Use plain .replace() instead of .format() because the template contains
    # thousands of literal `{` / `}` from CSS rules and JS blocks. Sentinels
    # below are picked to be unique strings that can't appear naturally.
    return (
        _TEMPLATE
        .replace("__MAIN_STYLES__", main_styles)
        .replace("__TOC_HTML__", toc_html)
        .replace("__BODY_HTML__", body)
        .replace("__TOTAL_COUNT__", total)
    )


def _build_toc(sections: tuple[Section, ...]) -> str:
    """Render the grouped TOC markup. Group order follows first-seen order."""
    groups: dict[str, list[Section]] = {}
    for s in sections:
        groups.setdefault(s.group, []).append(s)
    parts: list[str] = []
    for gname, items in groups.items():
        parts.append(f'<div class="reader-toc-group">{gname}</div>')
        for s in items:
            parts.append(f'<a class="reader-toc-link" href="#{s.id}">{s.title}</a>')
    return "\n      ".join(parts)


def main() -> None:
    OUTPUT.write_text(build(), encoding="utf-8")
    size_kb = OUTPUT.stat().st_size / 1024
    print(f"\n✓ Wrote {OUTPUT.name}  {size_kb:,.1f} KB")
    print(f"  Open locally:   open {OUTPUT}")
    print(f"  Phone transfer: AirDrop / Email / Drive — opens in any mobile browser")


# ─────────────────────────────────────────────────────────────────────
# HTML template.
#
# Structure:
#   1. <style>__MAIN_STYLES__</style>       ← full original CSS, inlined
#   2. <style> reader overrides … </style>  ← thin layer that:
#        - forces .sec visible (originals are display:none until activated)
#        - hides app-only chrome (.nav, .app-header, mobile-bottom-nav, …)
#        - adds .reader-* topbar / TOC drawer / back-to-top FAB
#
# All reader-only chrome is namespaced `.reader-*` so it can never collide
# with the original CSS or content classes.
# ─────────────────────────────────────────────────────────────────────
_TEMPLATE = r"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#07090f" media="(prefers-color-scheme: dark)">
  <meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
  <title>Trading Studio — Reader</title>
  <link rel="icon" type="image/svg+xml"
    href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44'><line x1='9' y1='16' x2='9' y2='20' stroke='%23c91f3a' stroke-width='1.8' stroke-linecap='round'/><rect x='6' y='20' width='6' height='14' fill='%23c91f3a' rx='1.2'/><line x1='9' y1='34' x2='9' y2='38' stroke='%23c91f3a' stroke-width='1.8' stroke-linecap='round'/><line x1='22' y1='13' x2='22' y2='22' stroke='%23d4941a' stroke-width='1.6' stroke-linecap='round'/><rect x='19' y='22' width='6' height='2' fill='%23d4941a' rx='0.6'/><line x1='22' y1='24' x2='22' y2='34' stroke='%23d4941a' stroke-width='1.6' stroke-linecap='round'/><line x1='35' y1='6' x2='35' y2='10' stroke='%2309a86e' stroke-width='1.8' stroke-linecap='round'/><rect x='32' y='10' width='6' height='24' fill='%2309a86e' rx='1.2'/><line x1='35' y1='34' x2='35' y2='38' stroke='%2309a86e' stroke-width='1.8' stroke-linecap='round'/></svg>">

  <!-- ───── Original main-app styles, inlined verbatim ─────
       Anything the content/*.html sections rely on (.card, .pgrid, .badge,
       .shead, candle SVG sizes, .infobox, .glossary-list, .anat-card, …)
       is defined here. Keeping the original CSS verbatim is what makes the
       reader look the same as the live app. -->
  <style>
__MAIN_STYLES__
  </style>

  <!-- ───── Reader-only override layer ───── -->
  <style>
    /* Force every section visible. The original app hides .sec by default
       and only shows .sec.active; in the reader we render them all stacked. */
    body.reader-body section.sec {
      display: block !important;
      position: relative;
      z-index: auto;
    }

    /* Defense-in-depth: even though we never include this markup, hide
       interactive app chrome should anything sneak through a content file. */
    body.reader-body .nav,
    body.reader-body .app-header,
    body.reader-body .sidebar-toggle,
    body.reader-body .sidebar-backdrop,
    body.reader-body .mobile-bottom-nav,
    body.reader-body .modal-backdrop,
    body.reader-body .toast,
    body.reader-body .nseo-bar,
    body.reader-body .pwa-prompt,
    body.reader-body .feedback-fab,
    body.reader-body .live-grid,
    body.reader-body .calc-row,
    body.reader-body .chain-table,
    body.reader-body .bias-form { display: none !important; }

    /* Reader chrome: namespaced under `.reader-*` so it can never collide
       with the original stylesheet. */
    body.reader-body {
      margin: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      overscroll-behavior-y: contain;
    }
    body.reader-body main.reader-main { padding-bottom: 96px; }

    /* Tighten section padding on mobile (the original .wrap is sized for
       a desktop layout). The original .wrap already has horizontal padding;
       we only need to dial down the top/bottom on phones. */
    body.reader-body section.sec + section.sec {
      border-top: 1px solid var(--bd);
    }
    body.reader-body section.sec > .wrap {
      padding-top: 24px;
      padding-bottom: 32px;
    }

    /* Topbar */
    .reader-topbar {
      position: sticky;
      top: 0;
      z-index: 50;
      background: rgba(7, 9, 15, 0.96);
      backdrop-filter: saturate(150%) blur(8px);
      -webkit-backdrop-filter: saturate(150%) blur(8px);
      border-bottom: 1px solid var(--bd);
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
    }
    html[data-theme="light"] .reader-topbar { background: rgba(248, 250, 252, 0.96); }
    .reader-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 0.96rem;
      letter-spacing: 0.04em;
      flex: 1;
      min-width: 0;
      color: var(--text);
    }
    .reader-brand-logo { width: 28px; height: 28px; flex-shrink: 0; }
    .reader-brand-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .reader-brand-text small {
      color: var(--text-dim, #a0b8d8);
      font-weight: 500;
      margin-left: 6px;
      font-size: 0.78rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .reader-btn {
      background: transparent;
      border: 1px solid var(--bd);
      color: var(--text);
      width: 38px;
      height: 38px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, border-color 0.15s;
      -webkit-tap-highlight-color: transparent;
      flex-shrink: 0;
    }
    .reader-btn:hover, .reader-btn:focus-visible {
      background: var(--s2);
      border-color: var(--bull);
      outline: none;
    }
    .reader-btn svg {
      width: 18px; height: 18px;
      stroke: currentColor; fill: none;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
    }

    /* TOC drawer (off-canvas on mobile, fixed sidebar on desktop) */
    .reader-toc-backdrop {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      opacity: 0; visibility: hidden;
      transition: opacity 0.2s, visibility 0.2s;
      z-index: 90;
    }
    .reader-toc-backdrop.open { opacity: 1; visibility: visible; }
    .reader-toc {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      width: min(85vw, 320px);
      background: var(--s1);
      border-right: 1px solid var(--bd);
      transform: translateX(-100%);
      transition: transform 0.24s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 100;
      overflow-y: auto;
      padding: 16px 12px 24px;
      padding-top: calc(16px + env(safe-area-inset-top));
      padding-bottom: calc(24px + env(safe-area-inset-bottom));
      -webkit-overflow-scrolling: touch;
    }
    .reader-toc.open { transform: translateX(0); }
    .reader-toc-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 4px 6px 14px;
      border-bottom: 1px solid var(--bd);
      margin-bottom: 12px;
    }
    .reader-toc-title {
      font-weight: 700; font-size: 0.78rem;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--text-dim, #a0b8d8);
    }
    .reader-toc-group {
      font-size: 0.66rem;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--bull);
      font-weight: 700;
      padding: 14px 8px 6px;
      border-top: 1px solid var(--bd);
      margin-top: 8px;
    }
    .reader-toc-group:first-of-type { border-top: none; margin-top: 0; padding-top: 4px; }
    .reader-toc-link {
      display: block;
      padding: 9px 10px;
      color: var(--text-soft, #c0d4f0);
      font-size: 0.92rem;
      border-radius: 6px;
      text-decoration: none;
      transition: background 0.12s, color 0.12s;
      -webkit-tap-highlight-color: transparent;
    }
    .reader-toc-link:hover, .reader-toc-link:focus-visible {
      background: var(--s2);
      color: var(--bull);
      outline: none;
      text-decoration: none;
    }
    .reader-toc-link.active {
      background: var(--bull-tint);
      color: var(--bull);
      font-weight: 600;
    }

    @media (min-width: 1024px) {
      .reader-toc { transform: translateX(0); width: 280px; }
      .reader-toc-backdrop { display: none; }
      .reader-btn.reader-toc-open { display: none; }
      body.reader-body main.reader-main { margin-left: 280px; }
      .reader-topbar { padding-left: 24px; left: 280px; position: sticky; }
    }

    /* Back-to-top FAB */
    .reader-fab {
      position: fixed;
      right: 16px;
      bottom: calc(16px + env(safe-area-inset-bottom));
      width: 44px; height: 44px;
      background: var(--bull);
      color: white;
      border: none;
      border-radius: 50%;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      opacity: 0; transform: translateY(8px); pointer-events: none;
      transition: opacity 0.18s, transform 0.18s;
      z-index: 60;
      -webkit-tap-highlight-color: transparent;
    }
    .reader-fab.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
    .reader-fab svg {
      width: 22px; height: 22px;
      stroke: white; fill: none;
      stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
    }

    /* Print: hide chrome, single column, ink-friendly */
    @media print {
      .reader-topbar, .reader-toc, .reader-toc-backdrop, .reader-fab { display: none !important; }
      body.reader-body main.reader-main { margin-left: 0; }
      body.reader-body section.sec { page-break-inside: avoid; }
      body { background: white; color: black; }
    }
  </style>
</head>
<body class="reader-body">
  <header class="reader-topbar">
    <button class="reader-btn reader-toc-open" aria-label="Open table of contents" data-action="toc-open">
      <svg viewBox="0 0 24 24"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>
    </button>
    <div class="reader-brand">
      <svg class="reader-brand-logo" viewBox="0 0 44 44" aria-label="Trading Studio logo">
        <line x1="9" y1="16" x2="9" y2="20" stroke="#c91f3a" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="6" y="20" width="6" height="14" fill="#c91f3a" rx="1.2"/>
        <line x1="9" y1="34" x2="9" y2="38" stroke="#c91f3a" stroke-width="1.8" stroke-linecap="round"/>
        <line x1="22" y1="13" x2="22" y2="22" stroke="#d4941a" stroke-width="1.6" stroke-linecap="round"/>
        <rect x="19" y="22" width="6" height="2" fill="#d4941a" rx="0.6"/>
        <line x1="22" y1="24" x2="22" y2="34" stroke="#d4941a" stroke-width="1.6" stroke-linecap="round"/>
        <line x1="35" y1="6" x2="35" y2="10" stroke="#09a86e" stroke-width="1.8" stroke-linecap="round"/>
        <rect x="32" y="10" width="6" height="24" fill="#09a86e" rx="1.2"/>
        <line x1="35" y1="34" x2="35" y2="38" stroke="#09a86e" stroke-width="1.8" stroke-linecap="round"/>
      </svg>
      <span class="reader-brand-text">Trading Studio<small>Reader</small></span>
    </div>
    <button class="reader-btn" aria-label="Toggle theme" data-action="theme">
      <svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
    </button>
  </header>

  <div class="reader-toc-backdrop" data-action="toc-close" aria-hidden="true"></div>

  <nav class="reader-toc" id="reader-toc" aria-label="Table of contents">
    <div class="reader-toc-header">
      <span class="reader-toc-title">Contents · __TOTAL_COUNT__</span>
      <button class="reader-btn" aria-label="Close" data-action="toc-close" style="width:32px;height:32px">
        <svg viewBox="0 0 24 24"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>
      </button>
    </div>
    __TOC_HTML__
  </nav>

  <main class="reader-main">
__BODY_HTML__
  </main>

  <button class="reader-fab" aria-label="Back to top" data-action="top">
    <svg viewBox="0 0 24 24"><polyline points="6,14 12,8 18,14"/></svg>
  </button>

  <script>
    (function () {
      'use strict';

      // ── Theme toggle (persists in localStorage; honours OS preference on first paint) ──
      try {
        var saved = localStorage.getItem('reader-theme');
        var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        if (saved === 'light' || (!saved && prefersLight)) {
          document.documentElement.setAttribute('data-theme', 'light');
        }
      } catch (_) {}

      function toggleTheme() {
        var html = document.documentElement;
        var next = html.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        html.setAttribute('data-theme', next);
        try { localStorage.setItem('reader-theme', next); } catch (_) {}
      }

      // ── TOC drawer ──
      var drawer = document.getElementById('reader-toc');
      var backdrop = document.querySelector('.reader-toc-backdrop');
      function openToc() { drawer.classList.add('open'); backdrop.classList.add('open'); }
      function closeToc() { drawer.classList.remove('open'); backdrop.classList.remove('open'); }

      // ── Back-to-top ──
      var fab = document.querySelector('.reader-fab');
      function onScroll() {
        if (window.scrollY > 400) fab.classList.add('visible');
        else fab.classList.remove('visible');
      }
      window.addEventListener('scroll', onScroll, { passive: true });

      // ── Single delegated click handler for all data-action buttons ──
      document.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-action]');
        if (!btn) return;
        var action = btn.getAttribute('data-action');
        if (action === 'theme') { toggleTheme(); }
        else if (action === 'toc-open') { openToc(); }
        else if (action === 'toc-close') { closeToc(); }
        else if (action === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); }
      });

      // ── Close drawer when a TOC link is tapped (mobile UX) ──
      document.querySelectorAll('.reader-toc-link').forEach(function (a) {
        a.addEventListener('click', function () {
          if (window.innerWidth < 1024) closeToc();
        });
      });

      // ── Active section highlighting ──
      var links = Array.from(document.querySelectorAll('.reader-toc-link'));
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
      if ('IntersectionObserver' in window) {
        var io = new IntersectionObserver(function (entries) {
          entries.forEach(function (entry) {
            var id = entry.target.id;
            var link = byId[id];
            if (!link) return;
            if (entry.isIntersecting) {
              links.forEach(function (l) { l.classList.remove('active'); });
              link.classList.add('active');
              if (window.innerWidth >= 1024) link.scrollIntoView({ block: 'nearest' });
            }
          });
        }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });
        document.querySelectorAll('section.sec[id]').forEach(function (s) { io.observe(s); });
      }

      // ── Esc closes the drawer ──
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeToc();
      });
    })();
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    main()
