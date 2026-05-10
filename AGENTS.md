# Handoff Summary — `candlestick-patterns.html`

## 0. Stack note (overrides global user rules)

This project is **vanilla HTML + CSS + JavaScript only** — no Python, no build step, no framework. The user's global rule about "strongly typed Python + functional programming" does not apply here. The functional-style preference *does* still apply: prefer pure helpers, module-level `state` objects, and avoid ad-hoc globals (see §9).

## 1. Project context

- **What it is**: A single-file static web app + PWA that combines a candlestick / chart-pattern educational reference with a live Nifty 50 chart and a `localStorage`-backed paper-trading sandbox for the Indian options market.
- **Audience**: Indian-market option-buyer beginners. Tone, lot size (Nifty 50 = 65), expiry calendar, IST timezone, and rupee formatting are all India-specific.
- **Stack**: App shell `candlestick-patterns.html` (~9,700 lines) + 37 lazy-loaded section files in `content/` (~770 KB total) — no build step, no framework, no bundler. Vanilla HTML + CSS custom properties + IIFE JS modules. PWA layer added on top (manifest + service worker + icons). The only third-party asset loaded at runtime is Lightweight Charts v4.2.2 from unpkg (loaded lazily when the user opens the live chart, and cached by the SW after first load). Content sections (single, double, live, chain, faq, etc.) are fetched on first navigation and cached in the DOM forever — see §16 for the contract.
- **How to run**: Open the file directly in a browser (full functionality, no SW), **or** serve it via any static server (full PWA: install to home screen, offline support). No backend.

## 1.1 Repository layout

```
candle-stick-pattern/
├── AGENTS.md                               # this file — durable context for AI agents
├── candlestick-patterns.html               # THE APP SHELL — ~9.7K lines (was 24K before split)
├── candlestick-patterns.html.before-split  # safety backup of pre-split monolith — DO NOT EDIT, do not ship
├── mobile-reader.html                      # OFFLINE READER — single-file build for phones (~800 KB, generated)
├── manifest.webmanifest                    # PWA manifest (must stay at root for scope)
├── sw.js                                   # service worker (must stay at root for scope)
├── content/                                # 37 lazy-loaded section files (~770 KB total)
│   ├── single.html                         # one file per section id
│   ├── double.html                         #   - corresponds to <div class="sec" id="X">
│   ├── … (35 more)                         #   - fetched + injected by show() on first visit
│   └── faq.html                            #   - cached by SW (stale-while-revalidate)
├── scripts/
│   ├── split-content.py                    # one-shot extractor (already run); idempotent — see §16
│   ├── generate-icons.py                   # logo + favicon + OG-card raster pipeline (Pillow) — see §15
│   └── build-mobile-reader.py              # assembles mobile-reader.html from anatomy + content/*.html
├── docs/
│   ├── history/
│   │   └── 2026-05-09-chat-transcript.md   # archived chat — read on-demand only (see §14)
│   └── legacy/                             # superseded design prototypes — NOT served, NOT referenced
│       ├── README.md                       # explains what's here and why
│       ├── candlestick-patterns.topnav-backup.html
│       ├── font-preview.html
│       ├── header-preview.html
│       └── logo-preview.html
└── pwa/
    ├── icons/
    │   ├── icon-{192,512}.svg              # vector primary, used by manifest + apple-touch fallbacks
    │   ├── icon-maskable-512.svg           # Android adaptive-icon (80% safe zone)
    │   ├── icon-{192,512}.png              # raster fallback (some Android launchers prefer PNG)
    │   ├── icon-maskable-512.png           # raster maskable fallback
    │   ├── apple-touch-icon.png            # iOS home-screen icon (180×180, the modern standard)
    │   ├── favicon-{16,32,48}.png          # PNG favicons (16/32 are referenced from <head>)
    │   ├── favicon.ico                     # multi-size legacy favicon (16/32/48)
    │   ├── logo-transparent-{512,1024}.png # transparent BG variants for slides/marketing
    │   ├── og-image.png                    # 1200×630 Open Graph / Twitter summary_large_image
    │   └── social-square.png               # 1080×1080 Instagram / square sharing
    └── offline.html                        # fallback when network + cache both miss
```

The PNG variants are generated from a single source-of-truth Python script
(`scripts/generate-icons.py`) that draws the candle geometry directly with
Pillow. To re-render after a logo change: `.venv/bin/python scripts/generate-icons.py`.
The script and the SVG sources MUST be edited in lockstep — see §15.

**Never put the manifest or `sw.js` in a subfolder** — service-worker scope is bounded by the directory the SW is served from, so anywhere else would scope it incorrectly and the PWA would stop intercepting requests for the main app.

**Never put `content/` in a subfolder either** — paths in `loadSectionContent()` are relative to the document (`content/X.html`). Moving the directory means updating the `fetch` URL and the SW caching rules.

## 2. File layout

Approximate line ranges in `candlestick-patterns.html` (post content-split). The section content itself is no longer in this file — see `content/<id>.html`.

| Range | Section | Notes |
|---|---|---|
| 1–46 | `<head>` meta, theme bootstrap, inline favicon, font preconnect/stylesheet links | Theme is read from `localStorage('theme')` before paint to avoid FOUC. Fonts are loaded via `<link rel=preconnect>` + `<link rel=stylesheet>` (not `@import`) so they don't block first paint. |
| ~51–~5475 | `<style>` block | All CSS — design tokens (incl. `--bull-tint`, `--bear-tint`, `--bull-hover`, `--bear-hover` for both themes), components, paper-trade UI, chart shell, modals, responsive media queries |
| ~5491–5519 | Affiliate `<script>` | `window.AFF`, `window.aff`, `window.affClick` — broker referral handling |
| ~6089 | `<main id="content">` opens | Landmark for screen readers / "skip to content" |
| ~6092–6266 | `<div class="sec active" id="anatomy">` | The ONLY content section still inline (default landing page — kept inline so first paint has content without a fetch) |
| ~6268–6370 | 33 placeholder `<div class="sec" id="X" data-content="X"></div>` | Empty stubs — `loadSectionContent()` fetches `content/X.html` on first navigation and injects |
| ~6372 | `</main>` closes | |
| ~6597 | Out-of-`<main>` placeholder: `<div class="sec" id="bias" data-content="bias"></div>` | Pre-existing structural quirk — bias section lives next to its module script |
| ~6600–6877 | `biasModule` | OI-based bias calculator UI logic |
| ~6880–7521 | `liveChartModule` | Lightweight Charts wrapper, Upstox V2/V3 historical + LTP polling, market-hours detection. `state.fetchAbort` / `state.loadSeq` cancel stale loads on rapid TF switches; `istDateKey()` normalizes "today" comparisons. |
| ~7524–8468 | `paperTradeModule` | Paper-trading state, SL/TGT, EOD square-off (with `priceFor → lastPx → entry` fallback), rendering |
| ~8471–8979 | `liveChainModule` | Option chain fetch, OI bias scoring, API token modal (with focus trap + restore focus) |
| ~8981–8987 | 3 more out-of-`<main>` placeholders: `missing`, `glossary`, `faq` | Same pre-existing structural quirk |
| ~8990–9551 | Bootstrap `<script>` | `ORDER`/`LABELS`/`GROUPS` (line ~9076 / ~9155), `loadSectionContent()` (line ~9262), `show()` / `gotoId()` (line ~9289), sidebar collapse, theme toggle, hash routing, palette + shortcuts modals (with focus restore) |
| ~9554–9710 | Footer + Upstox API setup docs | How a user gets a token |

Section content lives in `content/X.html` — each file is the inner HTML (the `<div class="wrap">…</div>` body) of what used to be `<div class="sec" id="X">…</div>`. The placeholder in the shell supplies the outer `<div class="sec" id="X">` wrapper.

## 3. Navigation model

The sidebar is data-driven by three constants in the bootstrap script (around line 23560):

- `ORDER` — flat array of section ids in display order (drives prev/next arrows).
- `LABELS` — id → human label map.
- `GROUPS` — collapsible sidebar groups: `Foundation`, `Candles`, `Patterns`, `Analysis`, `Indicators`, `F&O Playbook`, `Strategy`, `Tools`, `Discipline`, `Practice`, `Reference`.

`show(id, btn)` activates a `<section class="sec" id="...">`, updates the URL hash, and triggers `tvReload()` when entering `live`. To add a new section: write the `<section>`, then append its id to `ORDER`, `LABELS`, and the appropriate `GROUPS` entry — `buildNav()` and `buildJump()` will pick it up.

## 4. Live chart (`liveChartModule`)

- **Library**: Lightweight Charts 4.2.2 (`LWC_SRC` constant, lazy-loaded via injected `<script>`).
- **Instrument**: hardcoded `NSE_INDEX|Nifty 50`.
- **Endpoints**:
  - `GET https://api.upstox.com/v3/historical-candle/{ikey}/{unit}/{interval}/{to}/{from}`
  - `GET https://api.upstox.com/v3/historical-candle/intraday/{ikey}/{unit}/{interval}`
  - `GET https://api.upstox.com/v2/market-quote/ltp?instrument_key=...`
- **Auth**: `Bearer ` + `localStorage.getItem('upstox_token')`. No refresh-token flow — user pastes a daily token via the API modal.
- **Timeframes**: `1m, 3m, 5m, 15m, 30m, 1h, 1d` — `TF` map at the top of the module defines bucket size + history window per TF.
- **Polling**: `state.pollIntervalMs = 2000` while market is open; throttled to ~60s outside market hours.
- **Market-hours**: `isMarketOpen()` and `nextOpenLabel()` are exported on `window` so paper-trading and chain modules share the same notion of "open".
- **Exposed globals**: `window.tvReload`, `window.tvSetTimeframe`, `window.tvToggleFullscreen`, `window.tvState`, `window.isMarketOpen`, `window.nextOpenLabel`.
- **Tick fan-out**: every chart tick calls `window.paperTradeTick(ltp)` so paper trading stays in sync without its own poller for spot.

## 5. Paper trading (`paperTradeModule`)

### Storage

- `localStorage` key: `paper_trade_state_v1`.
- Persisted shape: `{ capital, open, history, qtyCE, qtyPE }`.
- `START_CAPITAL = 100000`, `LOT_SIZE_NIFTY = 65`, `MAX_LOTS = 20`.
- Migration: legacy `qty` is split into `qtyCE` / `qtyPE` on load.

### Position shape

```js
// Open OPT position
{ id, kind:'OPT', side:'BUY', optType:'CE'|'PE', strike, expiry,
  instrumentKey, qty, entry, entryTs, lastPx, sl, tgt }

// Closed position adds: exit, exitTs, pnl, pts,
//                     exitReason: 'MANUAL'|'SL'|'TGT'|'EOD'
```

- `sl` and `tgt` are **absolute premium prices** (not %, not offsets). `null` = disabled.
- `kind:'IDX'` exists for direct LONG/SHORT Nifty (legacy code path; the UI primarily exposes options trading).

### Auto-exits

- `checkRiskTriggers()` runs on every option-price poll. Long-premium logic only: exits when `px <= sl` or `px >= tgt`. Uses the same tick price as the exit fill (no slippage simulation).
- `checkEodSquareOff()` runs every 30s via `state.eodTimer`. Closes everything once IST clock crosses `EOD_HOUR=15, EOD_MINUTE=25` on Mon–Fri. Guarded by `eodFiredFor` (YYYY-MM-DD) so it fires once per session/day. It also runs once on first call after page load — re-opening the page after 15:25 with stale positions still squares them off using last known prices.
- Both paths route through `exit(id, reason, exitPxOverride)` and surface a toast via `showToast()`.

### Per-position SL / TGT editing

- `updatePosRisk(id, which, raw)` accepts the absolute premium typed inline in the Open Positions table. Empty / 0 / non-numeric clears the trigger. SL can be raised mid-trade to lock in profit (manual trailing).

### Lots

- Per-side: `state.qtyCE` and `state.qtyPE` — separate steppers live inside the BUY CE and BUY PE cards.
- `setQty(n, side)` / `incQty(d, side)` accept `'ce'|'pe'`; legacy callers without `side` default to CE.

### Renderers

- `renderAll()` orchestrates: `renderSpot`, `renderEquity`, `renderStats`, `renderTodayPnL`, `renderOpen`, `renderHistory`.
- `renderTodayPnL()` filters `state.history` by IST day key (today's realized P&L stat cell).
- `renderOpen()` outputs the table rows including the dedicated **Stop Loss** and **Target** columns with inline `<input>` elements wired to `window.ptUpdatePosRisk`.

### Exposed globals

`window.ptBuy`, `ptSell`, `ptBuyCE`, `ptBuyPE`, `ptExit`, `ptExitAll`, `ptReset`, `ptClearHistory`, `ptIncQty`, `ptSetQty`, `ptLoadStrikes`, `ptOnChainLoaded`, `ptToggleStrikes`, `ptStrikeSearch`, `ptUpdateLastFetch`, `ptUpdatePosRisk`, `paperTradeTick`.

## 6. Option chain (`liveChainModule`)

- Endpoints: `GET /v2/option/contract?instrument_key=...` (to find nearest expiry), then `GET /v2/option/chain?instrument_key=...&expiry_date=...`.
- Stores the result on `window.optionChainData = { spot, strikes }` and notifies paper-trading via `window.ptOnChainLoaded()`.
- `scoreBias(...)` in this module is a 5-input multi-factor OI bias scorer (asymmetry / size / direction / PCR) that powers the bias calculator UI.
- `INSTRUMENT_KEYS` map supports `NIFTY`, `BANKNIFTY`, `SENSEX` although only Nifty is wired into the paper-trade flow.

## 7. Auth / API modal

- Single Upstox bearer token in `localStorage('upstox_token')`.
- Modal in DOM with `apiOpenModal()` / `apiCloseModal()` (Escape to close).
- Token-acquisition steps documented inline in the footer (around lines 24080+): create app on Upstox developer portal, run authorization-code flow, paste the resulting `access_token`.

## 8. Theming

- Two themes: dark (default) and light (`data-theme="light"` on `<html>`).
- Pre-paint script (top of `<head>`) reads `localStorage('theme')` (or `prefers-color-scheme`) to set the attribute synchronously.
- A `MutationObserver` in the chart module re-applies chart colors when the theme changes.
- All colors flow through CSS custom properties in `:root` and `[data-theme="light"]`. Key tokens: `--bg`, `--card`, `--text`, `--muted`, `--bull` (CE / green), `--bear` (PE / red), `--info`, plus surfaces and borders.

## 9. Conventions in force (important for future edits)

- **CE / PE colors depend on context — there are two valid mappings, do not "fix" one to match the other.**
  - **Trade / position context** (BUY CE button, position tags, side labels, P&L colors, `.pt-inst-tag.ce/.pe`, `.pt-side-tag.long/.short`, `.action.ce/.pe`): **CE = `var(--bull)` (green); PE = `var(--bear)` (red).** The color reflects the trader's directional bet — buying a call is bullish, buying a put is bearish.
  - **Open-interest context** (OI bar chart, support/resistance walls in `liveChainModule.renderChart` and the walls table): **PE Wall = `var(--bull)` (green, support / floor); CE Wall = `var(--bear)` (red, resistance / ceiling).** The color reflects the spot-direction implied by OI build-up — heavy PE OI defends a level (bullish for spot), heavy CE OI caps a level (bearish for spot). This matches every standard OI dashboard (Sensibull, Opstra, etc.).
  - The trade-context mapping was inverted at five separate places earlier and corrected. Keep the trade mapping when adding new BUY CE / BUY PE / position UI; keep the OI mapping when adding new option-chain visualizations.
- **Functional style**: state lives in module-level objects (`state`); helpers are pure where possible (`pnlOf`, `priceFor`, `clampLots`, formatters). Avoid adding ad-hoc globals — extend the existing module's `state` object and `save()` / `load()` instead.
- **No JS escapes inside HTML attributes / static markup**: use `&#8377;` for ₹ (or omit), not `\u20B9` — `\u20B9` works only in JS string literals.
- **Persistence versioning**: when the storage shape changes incompatibly, bump the key (`paper_trade_state_v1` → `_v2`) and add migration in `load()`.
- **Lots display**: hint reads "Nifty 50 · 1 lot = 65 qty"; lots are now per-side (no global stepper).
- **EOD square-off is unconditional** — do not gate it behind a checkbox; the user explicitly rejected that in earlier iterations.
- **SL / Target are absolute premium prices, optional, edited inline only** (no pre-trade percentage / offset inputs). `null` = disabled.
- **No trailing SL feature** — was implemented and explicitly removed; manual SL adjustment via the inline input covers that use case.

## 10. Recent feature history (most recent → older)

000. **Mobile-reader build** (2026-05-10): New `scripts/build-mobile-reader.py` produces `mobile-reader.html` — a single self-contained ~800 KB HTML for offline phone reading. Inlines `anatomy` (extracted from main shell) + every educational `content/*.html` (skips interactive sections: `live`, `bias`, `calc`, `chain`). Stripped at build: inline `onclick`/`onkeydown`, `role="button"`/`tabindex="0"` on `<div>`s, affiliate `aff-card` blocks (need broker-tracking JS that doesn't ship). Rewrote home-page `<div class="path-card" onclick="paletteSelect('X')">` → `<a class="path-card" href="#X">`. Dead anchors to excluded sections redirected via `EXCLUDED_REDIRECTS` map (chain → options, bias → options, calc → exits, live → playbook). Output bundles a mobile-first stylesheet (system fonts, dark/light, responsive grids, scrollable tables, print stylesheet) + tiny vanilla-JS layer for theme toggle, slide-in TOC drawer, back-to-top FAB, and IntersectionObserver-driven active-link highlighting in TOC. Zero external deps — opens correctly under `file://`. The main app + content files are NOT modified by this build (read-only).
00. **Branding pass + logo v2 + raster pipeline** (2026-05-10): App renamed `PatternLab → Trading Studio` (manifest, `<title>`, all meta tags, SVG `aria-label`, footer copy, UTM source, SW cache names). Logo redesigned: 3 ascending candles (bear/doji/bull) with dashed gold trend line connecting wick tops + faint gold "studio floor" baseline; new design shipped to all 3 inline SVGs (header / sidebar / footer) and 3 PWA SVG icons. Sidebar `.ms-bear/.ms-star/.ms-bull` animation classes preserved. New `scripts/generate-icons.py` (Pillow, strongly typed, functional) renders 12 PNG variants from one source-of-truth `Candle` definition: PWA fallbacks, favicons (16/32/48 + .ico), apple-touch-icon (180), transparent logos (512/1024), Open Graph card (1200×630), Instagram square (1080×1080). HTML `<head>` got proper static `<link>` favicon stack + Open Graph + Twitter Card meta — replacing the old runtime `buildFavicon()` JS hack. Manifest extended with PNG icon entries. SW bumped through `v5 → v6 → v7 → v8 → v9-2026-05-10-png-pack`. Sidebar brand text changed to single-line `TRADING STUDIO` (was `TRADING<br>STUDIO`); hero swapped (header now says brand, hero says category).
0. **Content split** (post-PWA): `candlestick-patterns.html` shrunk from **24,314 → 9,711 lines (-72.7%)** by extracting all 37 non-default sections into `content/<id>.html`. `loadSectionContent(id, done)` in the bootstrap script fetches on first navigation, caches in DOM forever, and shows a `LOADING…` placeholder + retry button on failure. The `live` section's `tvReload()` auto-start now runs inside the load callback so DOM elements (`#tv-chart-container` etc.) exist before init. Race-protected via `contentInflight` map. SW bumped to `v2-2026-05-09-content-split`. Backup at `candlestick-patterns.html.before-split` (do not ship). Splitter at `scripts/split-content.py` is idempotent. See §16.
1. **Code-review pass** (post-handoff) addressed 1 critical + 3 high + 8 medium + several low-severity issues:
   - **EOD square-off** now falls back through `state.optPrices[k] → pos.lastPx → pos.entry` so a stale poll cannot leave a position stuck open after market close. The `eodFiredFor` day-guard is set only after `state.open` is empty, and the toast reports the actual closed count.
   - **Two-context CE/PE color rule** documented in §9 (trade vs OI contexts).
   - **`.pt-btn.pt-buy/.pt-sell`** switched from hardcoded hex to `var(--bull)` / `var(--bear)` with new `--bull-hover` / `--bear-hover` and `--bull-tint(-strong)` / `--bear-tint(-strong)` tokens defined for both themes. Bias buckets and tag tints now use the new tokens.
   - **`<main id="content">`** landmark now wraps all sections.
   - **`liveChartModule.updateLTP`** uses an IST date key (`istDateKey()`) instead of `toISOString().slice(0,10)` so the change/% display stays correct between 00:00 and 09:15 IST.
   - **`fetchHistorical(signal)`** accepts an `AbortSignal`; `loadAndRender` aborts in-flight requests + uses a `loadSeq` guard to discard stale results on rapid TF switches.
   - **`show('live')`** auto-start now gates on `tvState.chartReady` (not `pollTimer`, which is cleared on `visibilitychange:hidden`) — no more redundant chart reload when returning from a hidden tab.
   - **`liveChainModule.saveToken/loadToken/clearTok`** wrap `localStorage` access in try/catch with an inline error toast for private-mode / quota-exceeded.
   - **API modal**: focus trap (Tab cycles inside modal) + restore focus to the launching element on close. **Palette** and **Shortcuts** modals also restore focus on close. Mobile sidebar drawer also closes on Escape.
   - **Labels wired** to inputs (`for="up-token"`, `for="pt-strike-trigger"`, `for="pt-qty-ce"`, `for="pt-qty-pe"`); dynamic SL/TGT inputs in `renderOpen()` now have `aria-label="Stop loss premium for {strike} {CE/PE}"`.
   - **Google Fonts** moved from `@import` (render-blocking) to `<link rel=preconnect>` + `<link rel=stylesheet>` for parallel loading.
   - **`.path-card`**: `onkeydown` Enter/Space handlers added so keyboard users can activate them.
   - **`.pt-table th`**: `position: sticky; top: 0` so headers stay visible when the table scrolls.
   - **`.pt-qty.pt-qty-mini`**: media query `(hover: none) and (pointer: coarse)` enlarges to 40px height + 32px buttons on touch devices.
2. Hint text condensed to "Nifty 50 · 1 lot = 65 qty".
3. Per-card lots stepper for BUY CE and BUY PE replaced the global stepper.
4. SL / Target inputs sized to match the EXIT button.
5. Dedicated **Stop Loss** and **Target** columns in the Open Positions table (replacing an in-row sub-section).
6. Today's realized P&L stat cell (IST day-key filter on history).
7. Trailing SL added — then removed by request.
8. Auto square-off pill (amber) moved to the right of the section header.
9. CE / PE color-inversion bug fixed across 5 CSS / JS sites (trade context only — see §9).
10. SL / Target moved from percentages → rupee offsets → absolute inline premium prices (final design).
11. EOD auto square-off at 15:25 IST + toast notifications introduced alongside SL / TGT.

## 11. Common operations

- **Edit existing section content**: open `content/<id>.html` directly. The file is the inner `<div class="wrap">…</div>` of the section. No build step — just save and refresh. The SW serves stale-while-revalidate, so a hard reload (or bumping `CACHE_VERSION` in `sw.js`) is the safest way to see edits in a registered PWA.
- **Add a brand-new content section**:
  1. Create `content/newid.html` containing the inner markup (start with `<div class="wrap">…</div>`, no outer `<div class="sec">`).
  2. In `candlestick-patterns.html`, add the placeholder near the other ones (around line 6268 inside `<main>`, or near the end if it belongs with the modules):
     ```html
     <div class="sec" id="newid" data-content="newid"></div>
     ```
  3. Add `'newid'` to `ORDER`, `LABELS['newid'] = 'New Title'`, and append to a `GROUPS` entry — `buildNav()` and `buildJump()` will pick it up.
  4. Bump `CACHE_VERSION` in `sw.js` so existing PWA installs invalidate.
- **Make a section load eagerly instead of lazily** (e.g. promote to landing page): cut the contents of `content/<id>.html` back into the placeholder element in `candlestick-patterns.html`, then drop the `data-content` attribute. `loadSectionContent` short-circuits when there's no `data-content` and never fetches.
- **Re-run the splitter** (rare — only if you want to extract `anatomy` too, or re-shape the file): edit `KEEP_INLINE` in `scripts/split-content.py`, restore from `candlestick-patterns.html.before-split`, then `python3 scripts/split-content.py`.
- **Change the logo or rebrand**: edit the `Candle` constants and color palette at the top of `scripts/generate-icons.py`, then `.venv/bin/python scripts/generate-icons.py` to re-render all 12 PNG variants. Mirror the geometry change in (a) the three SVG files in `pwa/icons/`, (b) the inline SVGs in `candlestick-patterns.html` (header line ~5661, sidebar line ~5685, footer line ~9608), (c) the inline SVG data URI in the favicon `<link>` (line ~42), then bump `CACHE_VERSION` in `sw.js`. If the rebrand changes the wordmark on the OG card, also edit the title strings in `_render_landscape_card` / `_render_square_card`.
- **Set up the icon-generator venv** (one-time, after fresh clone): `python3 -m venv .venv && .venv/bin/pip install pillow`. The `.venv/` lives in the workspace root and is intentionally not committed (no git) — it's just a sandbox for the Pillow install.
- **Rebuild the mobile reader** (after editing any `content/*.html` or the inline `anatomy` section): `.venv/bin/python scripts/build-mobile-reader.py`. Output is `mobile-reader.html` at the project root. The script is read-only against the main files — it never modifies `candlestick-patterns.html` or `content/*.html`.
- **Add / remove a section from the mobile reader**: edit the `SECTIONS` tuple at the top of `scripts/build-mobile-reader.py`. Order in the tuple is the order in the reader and TOC. To exclude an interactive section (one that depends on JS modules / network), just leave it out and add an entry to `EXCLUDED_REDIRECTS` so any incoming `href="#that-id"` is rewritten to a valid alternative.
- **Transfer the mobile reader to a phone**: AirDrop the file (Mac → iPhone, opens via Files → tap → "Open in Safari"); or email-to-self → tap attachment in Mail → Safari icon; or upload to iCloud Drive / Google Drive / Dropbox and open from the corresponding mobile app. The file is fully self-contained, so no internet is needed once on the phone.
- **Change Nifty lot size** (e.g. SEBI revision): update `LOT_SIZE_NIFTY` in `paperTradeModule` (around line 21346) and the lot hint text near the BUY CE / PE cards.
- **Move EOD time**: edit `EOD_HOUR` / `EOD_MINUTE` (around line 21351). Day-of-week guard already excludes Sat / Sun.
- **Add a new auto-exit reason** (e.g. trailing): extend the `exitReason` union, branch in `checkRiskTriggers`, and add a new `pt-toast` kind class + CSS. If the reason should be unconditional like EOD, mirror the `priceFor → lastPx → entry` fallback chain so the position can never be left stuck open.
- **Add a new stat cell**: insert `<div class="pt-stat-cell">` inside `pt-stats-strip`, write a `renderXxx()`, call it from `renderAll()`, and bump the responsive grid `@media` rules accordingly.
- **Swap broker (chart / chain data)**: replace the V2 / V3 base URLs and adapt request / response shapes inside `liveChartModule` and `liveChainModule`. The rest of the app reads only `window.optionChainData`, the chart series, and `window.paperTradeTick(ltp)`.

## 12. Known limitations / quirks

- **No slippage / no brokerage simulation** in paper trading. Exit = trigger tick price.
- **Spot tick rate** is whatever the chart polls (default 2s); the chart drives paper-trading P&L for IDX positions, while OPT positions use a separate option-quote poll for premiums.
- **Token is plain in localStorage** — fine for personal use, not safe in shared browsers. The footer doc warns the user.
- **Single-symbol paper trading**: only Nifty 50 is wired end-to-end despite `INSTRUMENT_KEYS` containing BankNifty / Sensex.
- **No equity curve / journal / CSV export** yet — listed below as backlog candidates.
- **`liveChainModule` and `liveChartModule` overlap on the API modal** — both reference `window.apiOpenModal` / `apiCloseModal`. Keep the modal-owning module unchanged when refactoring.
- **Lightweight Charts is loaded from unpkg CDN** — no offline fallback; the chart shows an error state if the script fails to load.

## 13. Backlog candidates (discussed, not implemented)

Brokerage simulation, trade journal / notes, daily loss limit, partial exits, pre-trade risk preview, equity curve, trade tags, bracket orders, multi-symbol support, limit orders, CSV export, streak indicators, drawdown tracking.

## 14. Pointer files

- **Source of truth**: `candlestick-patterns.html` (single-file app, ~24K lines).
- **Deep history (do NOT auto-load)**: `docs/history/2026-05-09-chat-transcript.md` is the raw exported chat transcript (~92KB, ~2030 lines) from the project's previous iteration in another workspace. It contains every back-and-forth, dead-ends, and reverted attempts. **Read it on demand only** — when answering a "why was this decided?" / "what was tried before?" / "what did we explicitly reject?" question that this `AGENTS.md` doesn't already cover. Do not pull it into context for routine edits — this file (`AGENTS.md`) already distills its conclusions.

## 15. PWA setup

The app is now installable as a Progressive Web App. Files involved:

- **`manifest.webmanifest`** (root): name, icons, theme color, scope, `display: standalone`, three `shortcuts` (Live Chart, Bias, Option Chain) so long-pressing the home-screen icon offers section quick-links.
- **`sw.js`** (root): service worker. Caching strategies by request type:
  - `api.upstox.com` → **never intercepted** (live market data must stay fresh; offline-error UI is the existing one)
  - `unpkg.com` (Lightweight Charts) → **cache-first** (versioned URL is immutable)
  - `fonts.googleapis.com` / `fonts.gstatic.com` → **cache-first** (font CSS + woff2)
  - Same-origin navigations → **network-first** with cache fallback, then `pwa/offline.html`
  - Other same-origin → **stale-while-revalidate**
  - Bump `CACHE_VERSION` to invalidate clients on deploy.
- **`pwa/icons/`**: brand-mark assets. The composition is **bear (red, lowest top) → doji (gold) → bull (green, highest top)** with a dashed gold trend line above and a faint gold "studio floor" baseline. Three sources of truth that MUST stay aligned:
  1. **SVG vector sources** (`icon-{192,512}.svg`, `icon-maskable-512.svg`) — primary, used by manifest + apple-touch fallback links + inline favicon data URI.
  2. **PNG raster pipeline** (`scripts/generate-icons.py` + Pillow) — generates 12 raster outputs (`icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-{16,32,48}.png`, `favicon.ico`, `logo-transparent-{512,1024}.png`, `og-image.png`, `social-square.png`). Edit logo geometry in the `Candle` constants at the top, then run `.venv/bin/python scripts/generate-icons.py`.
  3. **Inline SVG markup** in `candlestick-patterns.html` (header logo line ~5661, sidebar `.sidebar-brand-logo` line ~5685, footer line ~9608) — these use the same composition but the sidebar version retains `.ms-bear/.ms-star/.ms-bull` classes for the staggered scale-in animation (CSS at line ~4602).
  When the logo changes, edit ALL THREE in lockstep, then bump `CACHE_VERSION` in `sw.js`.
- **`pwa/offline.html`**: dark/light-aware fallback shown when both network and cache miss.
- **HTML head additions**:
  - `<link rel="manifest" href="manifest.webmanifest">`
  - `<meta name="apple-mobile-web-app-capable" content="yes">` + `apple-mobile-web-app-status-bar-style="black-translucent"` + `apple-mobile-web-app-title="Studio"` (the iOS home-screen icon label — kept short to fit under the icon; full brand is "Trading Studio")
  - `viewport-fit=cover` to opt into iPhone notch / safe areas
  - Favicon stack: inline SVG data URI (instant, zero-fetch) → `favicon-32.png` → `favicon-16.png` → `favicon.ico` (legacy)
  - `<link rel="apple-touch-icon">` chain: 180×180 (modern iOS standard) → 192×192 PNG → 512×512 PNG
  - **Open Graph + Twitter Card meta** for link previews (Facebook, LinkedIn, Slack, Discord, WhatsApp, Twitter): `og:title`, `og:description`, `og:image` (→ `og-image.png` 1200×630), `og:image:width`/`height`, `twitter:card="summary_large_image"`, etc.
  - SW registration block at the bottom of the pre-paint `<script>` — silent failure on `file://` so dev flow stays unchanged.
- **CSS additions** (early in the main `<style>` block):
  - `body { min-height: 100dvh; overscroll-behavior-y: contain; padding: env(safe-area-inset-*) }` — handles iOS Safari URL-bar collapse, blocks pull-to-refresh interfering with chart polling, respects notch / home-indicator.
  - `button, a, [role="button"], .tab { touch-action: manipulation; -webkit-tap-highlight-color: transparent }` — kills the 300ms tap delay and Android grey-flash.
  - `@media all and (display-mode: standalone) { ... }` — extra top padding when launched from home screen.

**Local mobile testing**: `python3 -m http.server 8000`, then on the same Wi-Fi open `http://<your-mac-ip>:8000/candlestick-patterns.html` from your phone. Service workers won't register over plain HTTP from a remote host on iOS, but most other PWA features will still work for visual testing. For full SW testing, deploy to Cloudflare Pages / Vercel (HTTPS required).

**Versioning convention**: when shipping any change that should bust the SW cache (HTML edits, icon changes, manifest changes), bump `CACHE_VERSION` in `sw.js` (the date-stamped `v1-YYYY-MM-DD` format makes drift obvious).

## 16. Lazy-content load contract

The single most important architectural change after PWA. Read this before touching `show()`, `content/`, or anything that depends on section DOM.

### Shape

In `candlestick-patterns.html`, every section except `anatomy` is an empty placeholder:

```html
<div class="sec" id="single" data-content="single"></div>
```

The matching `content/single.html` holds the inner markup (starts with `<div class="wrap">`, no outer `.sec` wrapper).

### Runtime

`loadSectionContent(id, done)` (bootstrap script, ~line 9262):

1. Resolves `done()` immediately if the target has no `data-content` (inline section like `anatomy`) or already has children (loaded once).
2. If a fetch is already in flight for this id (rapid clicks), chains onto the existing promise via the `contentInflight` map — no duplicate requests.
3. Otherwise renders an inline `LOADING…` placeholder, fetches `content/<id>.html` with `credentials: 'omit'`, injects on success, calls `done()`.
4. On failure renders a Retry button that re-invokes `loadSectionContent(id)`. The error message includes the underlying `err.message` (e.g. `HTTP 404`).

`show(id, btn)` activates the section (CSS + URL + scroll) **synchronously**, then calls `loadSectionContent` to fill the body. The `live`-chart auto-start is moved INSIDE the load callback because `tvReload()` reads DOM elements that live in `content/live.html`.

### Invariants — do NOT break

- **Never make `show()` itself async** — too many callers (sidebar, tabs, hash routing, palette, footer links) expect fire-and-forget. Keep activation sync; do all post-load work inside the `loadSectionContent` callback.
- **Never use `target.innerHTML = …` directly outside `loadSectionContent`** to populate a section — bypasses the in-flight guard and the SW cache contract.
- **Never inline-attach content to a section that has `data-content`** — the next click will short-circuit because of `firstElementChild` and your content sticks; that's actually fine, but then the placeholder drift will confuse the splitter if re-run. If you want a section permanently inline, **remove `data-content`** from its placeholder.
- **`content/<id>.html` must NOT contain a `<script>` that depends on globals defined later in the shell** — the file is injected via `innerHTML`, which does NOT execute `<script>` tags. If you need init logic for a section, put a hook inside `show()` after `loadSectionContent` resolves.
- **Inline event handlers (`onclick="…"`) inside `content/*.html` files are fine** — they bind when the HTML is parsed via `innerHTML` and resolve against `window.*` at click time.
- **Never break the `data-content="<same id>"` convention** — the splitter and `loadSectionContent` both assume the file basename matches the section id. Do not point one section at another's content file.

### Splitter (`scripts/split-content.py`)

- One-shot transform from a monolithic HTML to shell + `content/`. Reads `candlestick-patterns.html`, writes `content/<id>.html` per section, replaces each section in the HTML with a placeholder.
- `KEEP_INLINE = {"anatomy"}` controls which sections stay embedded.
- Re-running on an already-split file is a no-op (no `<div class="sec" id="X">` openings to match — only placeholders, which the regex doesn't match because placeholders have a `data-content` attribute breaking the `id="X">` end anchor).
- If you want a clean re-split: `cp candlestick-patterns.html.before-split candlestick-patterns.html && rm -rf content/ && python3 scripts/split-content.py`.

### Service worker

`content/*.html` files fall through to the same-origin **stale-while-revalidate** rule in `sw.js` — they're cached on first fetch, served from cache instantly thereafter, and refreshed in the background. They are intentionally **NOT precached** during SW install (would push install size from ~50 KB to ~830 KB; users who only visit a few sections shouldn't pay for that). Bump `CACHE_VERSION` after any content edit so existing PWA installs pick up the change.
