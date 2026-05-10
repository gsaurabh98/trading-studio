#!/usr/bin/env python3
"""
split-content.py — Extract each `<div class="sec" id="X">…</div>` section from
`candlestick-patterns.html` into `content/X.html`, leaving a placeholder behind
that the bootstrap script will lazy-load on first navigation.

This is a one-shot transformation. Re-running it on an already-split file is
safe (no sections will match) but will do nothing.

Run from the project root:
    python3 scripts/split-content.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INPUT = ROOT / "candlestick-patterns.html"
OUTPUT_DIR = ROOT / "content"
# Keep the default landing section inline so the very first paint has content
# without waiting for a fetch.
KEEP_INLINE: set[str] = {"anatomy"}

# `<div class="sec" id="X">` or `<div class="sec active" id="X">` — capture id + active flag
SECTION_OPEN_RE = re.compile(r'<div class="sec(?P<active>\s+active)?" id="(?P<id>[\w-]+)">')
# Token-level pattern for balanced-div scanning. `re.DOTALL` not needed; tags don't span lines here.
DIV_TOKEN_RE = re.compile(r"<(?P<close>/)?div\b[^>]*>", re.IGNORECASE)


def find_section_end(text: str, opening: re.Match[str]) -> int:
    """Return the position immediately after the closing `</div>` that matches `opening`."""
    depth = 1
    pos = opening.end()
    while depth > 0:
        m = DIV_TOKEN_RE.search(text, pos)
        if not m:
            raise ValueError(f"Unbalanced <div> for section id='{opening.group('id')}'")
        depth += -1 if m.group("close") else 1
        pos = m.end()
    return pos


def main() -> int:
    if not INPUT.exists():
        print(f"error: {INPUT} not found", file=sys.stderr)
        return 1

    text = INPUT.read_text(encoding="utf-8")
    matches = list(SECTION_OPEN_RE.finditer(text))
    if not matches:
        print("No sections matched. File may already be split.")
        return 0

    OUTPUT_DIR.mkdir(exist_ok=True)

    # Build the new HTML by walking sections in order.
    parts: list[str] = []
    last_end = 0
    extracted: list[str] = []
    kept: list[str] = []

    for m in matches:
        sec_id = m.group("id")
        is_active = bool(m.group("active"))
        start = m.start()
        end = find_section_end(text, m)
        full = text[start:end]
        opening_tag = m.group(0)

        # text before this section, verbatim
        parts.append(text[last_end:start])
        last_end = end

        if sec_id in KEEP_INLINE:
            parts.append(full)
            kept.append(sec_id)
            continue

        # Inner content lives between the opening tag and the trailing `</div>`.
        inner = full[len(opening_tag):-len("</div>")].strip("\n")
        out_file = OUTPUT_DIR / f"{sec_id}.html"
        out_file.write_text(inner + "\n", encoding="utf-8")

        active_attr = " active" if is_active else ""
        placeholder = (
            f'<div class="sec{active_attr}" id="{sec_id}" data-content="{sec_id}"></div>'
        )
        parts.append(placeholder)
        extracted.append(sec_id)

    parts.append(text[last_end:])
    new_text = "".join(parts)
    INPUT.write_text(new_text, encoding="utf-8")

    # Report
    print(f"Sections found: {len(matches)}")
    print(f"  Kept inline ({len(kept)}): {', '.join(kept)}")
    print(f"  Extracted   ({len(extracted)}): {', '.join(extracted)}")
    print()
    print(f"Original size: {len(text):>9,} chars   ({text.count(chr(10)):>6,} lines)")
    print(f"New shell:     {len(new_text):>9,} chars   ({new_text.count(chr(10)):>6,} lines)")
    print(f"Reduction:     {100 * (len(text) - len(new_text)) / len(text):>9.1f}%")

    # Per-section sizes for reference
    print()
    print("content/ files:")
    for sec_id in extracted:
        size = (OUTPUT_DIR / f"{sec_id}.html").stat().st_size
        print(f"  {sec_id:<14}  {size:>7,} bytes")

    return 0


if __name__ == "__main__":
    sys.exit(main())
