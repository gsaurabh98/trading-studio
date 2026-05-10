"""Generate PNG variants of the Trading Studio logo from a single source-of-truth.

This is the canonical raster pipeline for the brand. Editing the candle geometry
here re-renders every PWA icon, favicon, transparent logo, and social card via:

    .venv/bin/python scripts/generate-icons.py

Outputs land in pwa/icons/. The SVG sources in pwa/icons/icon-{192,512,maskable-512}.svg
must be edited in lockstep so in-app SVG and PWA PNG fallbacks stay aligned.

Design notes
- Logical coordinates are in [0, 1] so the same composition scales to any canvas.
- Composition: bear (red, low top) → doji (gold) → bull (green, high top), ascending
  wick tops with a dashed gold trend line and a faint gold "studio floor" baseline.
- Fonts: HelveticaNeue from /System/Library/Fonts (macOS-only; safe fallback to
  Pillow's bundled bitmap font if missing).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Final

from PIL import Image, ImageDraw, ImageFont


# ── Color palette (mirrors --bull/--bear/--neutral CSS tokens) ─────────────
BEAR_RED: Final[tuple[int, int, int, int]] = (201, 31, 58, 255)      # #c91f3a
DOJI_GOLD: Final[tuple[int, int, int, int]] = (212, 148, 26, 255)    # #d4941a
BULL_GREEN: Final[tuple[int, int, int, int]] = (9, 168, 110, 255)    # #09a86e
BG_NAVY: Final[tuple[int, int, int, int]] = (7, 9, 15, 255)          # #07090f
INK_WHITE: Final[tuple[int, int, int, int]] = (236, 240, 247, 255)
INK_DIM: Final[tuple[int, int, int, int]] = (140, 152, 175, 255)
INK_ACCENT: Final[tuple[int, int, int, int]] = (212, 148, 26, 255)

TREND_LINE_ALPHA: Final[int] = 140    # ≈ 0.55 opacity
BASELINE_ALPHA: Final[int] = 90       # ≈ 0.35 opacity


# ── Logo geometry in logical [0, 1] space ────────────────────────────────
@dataclass(frozen=True)
class Candle:
    """A single candle drawn as wick + body + wick.

    All coordinates are fractions of canvas size (0..1). Render functions
    multiply by the target canvas size.
    """
    cx: float          # body center x
    top_wick: float    # upper wick top
    body_top: float    # body top
    body_bot: float    # body bottom
    bot_wick: float    # lower wick bottom
    half_w: float      # body half-width
    color: tuple[int, int, int, int]
    wick_w: float      # wick stroke width


# Composition mirrors pwa/icons/icon-512.svg exactly (in 512 space → / 512).
LOGO_BEAR: Final[Candle] = Candle(
    cx=0.229, top_wick=0.416, body_top=0.479, body_bot=0.688,
    bot_wick=0.738, half_w=0.0625, color=BEAR_RED, wick_w=0.0313,
)
LOGO_DOJI: Final[Candle] = Candle(
    cx=0.500, top_wick=0.313, body_top=0.520, body_bot=0.551,
    bot_wick=0.738, half_w=0.0625, color=DOJI_GOLD, wick_w=0.0254,
)
LOGO_BULL: Final[Candle] = Candle(
    cx=0.771, top_wick=0.209, body_top=0.272, body_bot=0.688,
    bot_wick=0.738, half_w=0.0625, color=BULL_GREEN, wick_w=0.0313,
)
LOGO_CANDLES: Final[tuple[Candle, ...]] = (LOGO_BEAR, LOGO_DOJI, LOGO_BULL)

BASELINE_Y: Final[float] = 0.807
BASELINE_X1: Final[float] = 0.166
BASELINE_X2: Final[float] = 0.834

OUT_DIR: Final[Path] = Path(__file__).resolve().parent.parent / "pwa" / "icons"
SYSTEM_FONT_PATH: Final[str] = "/System/Library/Fonts/HelveticaNeue.ttc"


# ── Pure rendering primitives ────────────────────────────────────────────
def _project(value: float, size: int, padding: float) -> float:
    """Project a logical [0, 1] coordinate to the canvas, with even padding."""
    inner = size * (1.0 - 2.0 * padding)
    return size * padding + value * inner


def _draw_candle(d: ImageDraw.ImageDraw, c: Candle, size: int, padding: float) -> None:
    cx = _project(c.cx, size, padding)
    top_wick = _project(c.top_wick, size, padding)
    body_top = _project(c.body_top, size, padding)
    body_bot = _project(c.body_bot, size, padding)
    bot_wick = _project(c.bot_wick, size, padding)
    half_w = c.half_w * size * (1.0 - 2.0 * padding)
    wick_w = max(1, int(round(c.wick_w * size * (1.0 - 2.0 * padding))))
    body_radius = max(1.0, half_w * 0.42)

    d.rounded_rectangle(
        [cx - half_w, body_top, cx + half_w, body_bot],
        radius=body_radius, fill=c.color,
    )
    d.line([cx, top_wick, cx, body_top], fill=c.color, width=wick_w)
    d.line([cx, body_bot, cx, bot_wick], fill=c.color, width=wick_w)


def _draw_trend_line(d: ImageDraw.ImageDraw, size: int, padding: float) -> None:
    """Dashed gold line from bear's wick top to bull's wick top."""
    x1 = _project(LOGO_BEAR.cx, size, padding)
    y1 = _project(LOGO_BEAR.top_wick, size, padding)
    x2 = _project(LOGO_BULL.cx, size, padding)
    y2 = _project(LOGO_BULL.top_wick, size, padding)
    color = (DOJI_GOLD[0], DOJI_GOLD[1], DOJI_GOLD[2], TREND_LINE_ALPHA)
    width = max(1, int(round(size * 0.012 * (1.0 - 2.0 * padding))))

    n_dashes = 14
    dash_fraction = 0.55  # 55% on / 45% off
    for i in range(n_dashes):
        t1 = i / n_dashes
        t2 = (i + dash_fraction) / n_dashes
        sx, sy = x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1
        ex, ey = x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2
        d.line([sx, sy, ex, ey], fill=color, width=width)


def _draw_baseline(d: ImageDraw.ImageDraw, size: int, padding: float) -> None:
    x1 = _project(BASELINE_X1, size, padding)
    x2 = _project(BASELINE_X2, size, padding)
    y = _project(BASELINE_Y, size, padding)
    color = (DOJI_GOLD[0], DOJI_GOLD[1], DOJI_GOLD[2], BASELINE_ALPHA)
    width = max(1, int(round(size * 0.012 * (1.0 - 2.0 * padding))))
    d.line([x1, y, x2, y], fill=color, width=width)


# ── Composition functions ─────────────────────────────────────────────────
def render_logo(
    size: int,
    *,
    bg: tuple[int, int, int, int] | None = BG_NAVY,
    rounded: bool = True,
    padding: float = 0.0,
    show_trend_line: bool = True,
    show_baseline: bool = True,
) -> Image.Image:
    """Render a square logo image at the given pixel size.

    Args:
        size: Width and height in pixels.
        bg: Solid background color, or None for transparent.
        rounded: Clip the background to a rounded square (PWA convention).
        padding: Outer margin as a fraction of size; use 0.10 for maskable icons.
        show_trend_line: Draw the dashed gold trend line above the candles.
        show_baseline: Draw the gold "studio floor" baseline below the candles.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img, "RGBA")

    if bg is not None:
        if rounded:
            d.rounded_rectangle([0, 0, size, size], radius=int(size * 0.187), fill=bg)
        else:
            d.rectangle([0, 0, size, size], fill=bg)

    if show_trend_line and size >= 64:
        _draw_trend_line(d, size, padding)

    for candle in LOGO_CANDLES:
        _draw_candle(d, candle, size, padding)

    if show_baseline and size >= 64:
        _draw_baseline(d, size, padding)

    return img


def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(SYSTEM_FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def _render_landscape_card(width: int, height: int) -> Image.Image:
    """Logo left, two-line wordmark + tagline right. Sized for 1200×630 OG cards."""
    img = Image.new("RGBA", (width, height), BG_NAVY)
    d = ImageDraw.Draw(img, "RGBA")

    logo_size = int(height * 0.78)
    logo = render_logo(logo_size, bg=BG_NAVY, rounded=True)
    logo_x = int(width * 0.05)
    logo_y = (height - logo_size) // 2
    img.alpha_composite(logo, (logo_x, logo_y))

    text_x = logo_x + logo_size + int(width * 0.05)
    title_font_size = int(height * 0.13)
    tagline_font_size = int(height * 0.045)
    title_font = _load_font(title_font_size)
    tagline_font = _load_font(tagline_font_size)
    accent_font = _load_font(int(tagline_font_size * 0.85))

    title_block_y = int(height * 0.3)
    d.text((text_x, title_block_y), "Trading", fill=INK_WHITE, font=title_font)
    d.text((text_x, title_block_y + int(title_font_size * 1.05)), "Studio", fill=INK_WHITE, font=title_font)
    tagline_y = title_block_y + int(title_font_size * 2.4)
    d.text((text_x, tagline_y), "Candlestick & chart pattern encyclopedia", fill=INK_DIM, font=tagline_font)
    d.text((text_x, tagline_y + int(tagline_font_size * 1.6)), "for 2026 option buyers", fill=INK_ACCENT, font=accent_font)

    return img


def _render_square_card(side: int) -> Image.Image:
    """Logo top-center, wordmark stacked below. Sized for 1080×1080 IG-style posts."""
    img = Image.new("RGBA", (side, side), BG_NAVY)
    d = ImageDraw.Draw(img, "RGBA")

    logo_size = int(side * 0.55)
    logo = render_logo(logo_size, bg=BG_NAVY, rounded=True)
    logo_x = (side - logo_size) // 2
    logo_y = int(side * 0.08)
    img.alpha_composite(logo, (logo_x, logo_y))

    title_font_size = int(side * 0.10)
    tagline_font_size = int(side * 0.035)
    title_font = _load_font(title_font_size)
    tagline_font = _load_font(tagline_font_size)
    accent_font = _load_font(int(tagline_font_size * 0.9))

    center_x = side // 2
    title_y = logo_y + logo_size + int(side * 0.05)

    # "Trading Studio" on a single line if it fits, otherwise stack
    full_title = "Trading Studio"
    full_w = d.textlength(full_title, font=title_font)
    if full_w <= side * 0.86:
        d.text((center_x - full_w // 2, title_y), full_title, fill=INK_WHITE, font=title_font)
        title_y += int(title_font_size * 1.2)
    else:
        for line in ("Trading", "Studio"):
            tw = d.textlength(line, font=title_font)
            d.text((center_x - tw // 2, title_y), line, fill=INK_WHITE, font=title_font)
            title_y += int(title_font_size * 1.05)
        title_y += int(side * 0.01)

    tagline = "Candlestick & chart pattern encyclopedia"
    tw = d.textlength(tagline, font=tagline_font)
    d.text((center_x - tw // 2, title_y), tagline, fill=INK_DIM, font=tagline_font)
    accent = "for 2026 option buyers"
    aw = d.textlength(accent, font=accent_font)
    d.text((center_x - aw // 2, title_y + int(tagline_font_size * 1.6)), accent, fill=INK_ACCENT, font=accent_font)

    return img


def render_og_card(width: int = 1200, height: int = 630) -> Image.Image:
    """Dispatch to the right layout based on aspect ratio."""
    if width > height:
        return _render_landscape_card(width, height)
    return _render_square_card(min(width, height))


# ── Variant manifest ──────────────────────────────────────────────────────
@dataclass(frozen=True)
class Variant:
    name: str
    builder: Callable[[], Image.Image]
    note: str


def _favicon_simple(size: int) -> Image.Image:
    """Tiny favicon: drop the trend line + baseline, they're noise at <64px."""
    return render_logo(size, show_trend_line=False, show_baseline=False)


VARIANTS: Final[tuple[Variant, ...]] = (
    # Solid-background app icons (PNG fallbacks for browsers that don't
    # render SVG favicons; some Android launchers prefer PNG too)
    Variant("apple-touch-icon.png", lambda: render_logo(180), "iOS home screen 180px"),
    Variant("icon-192.png", lambda: render_logo(192), "PWA 192px PNG fallback"),
    Variant("icon-512.png", lambda: render_logo(512), "PWA 512px PNG fallback"),
    Variant("icon-maskable-512.png", lambda: render_logo(512, rounded=False, padding=0.10), "Android adaptive icon (full-bleed, 80% safe zone)"),
    # Favicons (small sizes need the simplified composition)
    Variant("favicon-16.png", lambda: _favicon_simple(16), "Browser tab 16px"),
    Variant("favicon-32.png", lambda: _favicon_simple(32), "Browser tab 32px (retina)"),
    Variant("favicon-48.png", lambda: _favicon_simple(48), "Windows taskbar 48px"),
    # Transparent logos for marketing surfaces (slides, light backgrounds, etc.)
    Variant("logo-transparent-512.png", lambda: render_logo(512, bg=None, show_trend_line=False, show_baseline=False), "Logo only on transparent BG, 512px"),
    Variant("logo-transparent-1024.png", lambda: render_logo(1024, bg=None), "Full composition on transparent BG, 1024px"),
    # Social shares
    Variant("og-image.png", lambda: render_og_card(1200, 630), "Open Graph / Twitter (summary_large_image) 1200×630"),
    Variant("social-square.png", lambda: render_og_card(1080, 1080), "Instagram / square sharing 1080×1080"),
)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Writing PNG variants to {OUT_DIR.relative_to(OUT_DIR.parent.parent)}/\n")

    for v in VARIANTS:
        path = OUT_DIR / v.name
        img = v.builder()
        img.save(path, optimize=True)
        kb = path.stat().st_size / 1024
        print(f"  {v.name:<32} {img.width:>4}×{img.height:<4}  {kb:6.1f} KB  — {v.note}")

    # Multi-size .ico for legacy browsers
    ico_path = OUT_DIR / "favicon.ico"
    ico_src = _favicon_simple(64)
    ico_src.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    kb = ico_path.stat().st_size / 1024
    print(f"  {'favicon.ico':<32} {'multi':>9}  {kb:6.1f} KB  — Legacy /favicon.ico (16/32/48)")

    print(f"\nDone. {len(VARIANTS) + 1} files written.")


if __name__ == "__main__":
    main()
