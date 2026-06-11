# Handoff Summary — `candlestick-patterns.html`

## 0. Stack note (overrides global user rules)

This project is **vanilla HTML + CSS + JavaScript only** — no Python, no build step, no framework. The user's global rule about "strongly typed Python + functional programming" does not apply here. The functional-style preference *does* still apply: prefer pure helpers, module-level `state` objects, and avoid ad-hoc globals (see §9).

## 0.1 Development rules

**Single source of truth: [`.cursor/rules/trading-context.mdc`](.cursor/rules/trading-context.mdc)** (always-applied Cursor rule). Read it before changing any signal/verdict/risk logic.

In one line: this is a **swing-trade signal app where real capital depends on signal accuracy** — accuracy and robustness beat coverage, when in doubt emit WAIT/no-signal, anchor only on confirmed (non-repainting) data, fail safe on bad data, and respect tick size + market hours + broker (NSE/Upstox) edges.

## 1. Project context

- **What it is**: A single-file static web app + PWA that combines a candlestick / chart-pattern educational reference with a live Nifty 50 chart and a `localStorage`-backed paper-trading sandbox for the Indian options market.
- **Audience**: Indian-market option-buyer beginners. Tone, lot size (Nifty 50 = 65), expiry calendar, IST timezone, and rupee formatting are all India-specific.
- **Stack**: App shell `candlestick-patterns.html` (~19,000 lines, down from ~30,700 after the May 2026 CSS split) + 10 stylesheets under `styles/` (~262 KB total, ~11,600 lines) + 37 lazy-loaded section files in `content/` (~770 KB total) — no build step, no framework, no bundler. Vanilla HTML + CSS custom properties + IIFE JS modules. PWA layer added on top (manifest + service worker + icons). Third-party assets loaded at runtime: Lightweight Charts v5.2.0 from unpkg (chart library, cached by SW), lightweight-charts-drawing v0.1.1 (drawing tools plugin, cached by SW), and protobufjs v7.4.0 from jsdelivr (WebSocket protobuf decoder, lazy-loaded when WS connects, cached by SW). Content sections (single, double, live, chain, faq, etc.) are fetched on first navigation and cached in the DOM forever — see §16 for the contract. Stylesheets are linked via plain `<link rel="stylesheet">` in `<head>` (render-blocking; same cascade order as the original inline `<style>` block) — see §17.
- **How to run**: Open the file directly in a browser (full functionality, no SW), **or** serve it via any static server (full PWA: install to home screen, offline support). No backend.

## 1.1 Repository layout

```
candle-stick-pattern/
├── AGENTS.md                               # this file — durable context for AI agents
├── candlestick-patterns.html               # THE APP SHELL — ~19K lines (was 30.7K before the May-2026 CSS split)
├── candlestick-patterns-before-split.html  # safety backup of the pre-content-split monolith — DO NOT EDIT, do not ship
├── mobile-reader.html                      # OFFLINE READER — single-file build for phones (~1.2 MB, generated)
├── manifest.webmanifest                    # PWA manifest (must stay at root for scope)
├── sw.js                                   # service worker (must stay at root for scope)
├── styles/                                 # 10 CSS files split from the inline <style> (May 2026) — see §17
│   ├── base.css                            #   tokens + theme + reset + header/nav/sections/grid/card/anatomy/table (~1.8K lines)
│   ├── swing-analyzer.css                  #   swing TF analyzer (~1.2K lines)
│   ├── intraday-analyzer.css               #   intraday multi-TF recommendation (~2.3K lines)
│   ├── paper-trading.css                   #   paper trading shell + May-2026 visual redesign (~2.3K lines)
│   ├── live-chart.css                      #   LWC toolbar / indicators / layouts (~1.0K lines)
│   ├── option-chain.css                    #   Upstox option chain 3-col grid (~0.9K lines)
│   ├── api-modal.css                       #   Chart toolbar API gear + connection modal (~0.1K lines)
│   ├── marketing.css                       #   Affiliate cards + UX enhancements (~0.8K lines)
│   ├── sidebar-nav.css                     #   Sidebar + next/prev + jump-to + inline icons (~1.0K lines)
│   └── bias.css                            #   Bias calculator + Pine-script copy button (~0.2K lines)
├── content/                                # 37 lazy-loaded section files (~770 KB total)
│   ├── single.html                         # one file per section id
│   ├── double.html                         #   - corresponds to <div class="sec" id="X">
│   ├── … (35 more)                         #   - fetched + injected by show() on first visit
│   └── faq.html                            #   - cached by SW (stale-while-revalidate)
├── scripts/                                # browser runtime JS (loaded by the shell) + tooling
│   ├── *.js                                # 12 runtime IIFE modules: swing-analyzer, intraday-analyzer,
│   │                                       #   indicator-math, live-chart, live-chain, paper-trade, … (see §18)
│   ├── backtest/                           # Node .mjs backtest + regression-guard harness (vm sandbox via lib.mjs)
│   └── tools/                              # Python build/data tooling — ALWAYS run from repo root:
│       ├── split-content.py                #   one-shot content extractor (already run); idempotent — see §16
│       ├── generate-icons.py               #   logo + favicon + OG-card raster pipeline (Pillow) — see §15
│       ├── build-mobile-reader.py          #   assembles mobile-reader.html from anatomy + content/*.html + styles/*.css
│       └── … (10 more .py)                 #   generate-sectors, extract-js-module, prune-universe-by-price, …
├── rules/                                  # rule books (single source of truth) — see note below
│   ├── swing-rules.json                  #   swing Fib/ZOI verdict engine — FETCHED AT RUNTIME by swing-analyzer.js + precached in sw.js
│   └── intraday-rules.json                 #   intraday Setup/Trade-plan + auto-trade rule book — DOC/SPEC only (not fetched; logic is in scripts/intraday-trade.js)
├── docs/
│   ├── scenarios/                          # 11 *-verdict-scenarios.md reference tables (fib / zoi / candle / chart)
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
(`scripts/tools/generate-icons.py`) that draws the candle geometry directly with
Pillow. To re-render after a logo change: `.venv/bin/python scripts/tools/generate-icons.py`.
The script and the SVG sources MUST be edited in lockstep — see §15.

**Never put the manifest or `sw.js` in a subfolder** — service-worker scope is bounded by the directory the SW is served from, so anywhere else would scope it incorrectly and the PWA would stop intercepting requests for the main app.

**Never put `content/` in a subfolder either** — paths in `loadSectionContent()` are relative to the document (`content/X.html`). Moving the directory means updating the `fetch` URL and the SW caching rules.

**`rules/` is the home for rule books** (moved here from root + `data/` on 2026-06-07). Two files live here: `swing-rules.json` is the swing Fib/ZOI verdict engine and is **fetched at runtime** (`fetch('rules/swing-rules.json')` in `scripts/swing-analyzer.js`, precached in `sw.js`, and read by the two Python tools `generate-fib-zoi-combinations.py` / `expand-zoi-momentum-combined.py`) — moving or renaming it again means updating ALL of those references + bumping `CACHE_VERSION`. `intraday-rules.json` is a **doc/spec only** (nothing fetches it; the live logic is hardcoded in `scripts/intraday-trade.js` and guarded by `scripts/backtest/it-setup-smoke.mjs`). The backtest sandbox rejects `fetch`, so the swing guard uses the inline fallback rules and does NOT read `swing-rules.json` from disk.

**Never move `styles/` or rename the CSS files** — the shell's `<head>` links them by relative path and [scripts/tools/build-mobile-reader.py](scripts/tools/build-mobile-reader.py) discovers them by scanning those `<link>` tags. Moving the directory or renaming a file breaks both the live app AND the mobile-reader build. To add a new stylesheet: drop it under `styles/`, add a `<link rel="stylesheet">` in the shell's `<head>` in the correct cascade position (see §17), then bump `CACHE_VERSION` in `sw.js`.

## 2. File layout

Approximate line ranges in `candlestick-patterns.html` (post content-split AND post-May-2026 CSS split). All CSS now lives under `styles/` — the shell is HTML + JS only. The section content itself is also no longer in this file — see `content/<id>.html`.

| Range | Section | Notes |
|---|---|---|
| 1–19 | `<head>` meta, viewport, PWA manifest link, iOS standalone hints | |
| 20–84 | Inline `<script>` — pre-paint theme bootstrap + service-worker registration with auto-update | Theme is read from `localStorage('theme')` synchronously before paint to avoid FOUC. SW registers only on http(s); silent on `file://`. |
| 85–117 | Favicon stack (inline SVG + PNG fallbacks), Open Graph / Twitter Card meta, `<title>` | |
| 118–121 | Google Fonts `<link rel=preconnect>` + `<link rel=preload>` + `<link rel=stylesheet>` | Loaded as parallel resources, not `@import`, so they don't render-block the critical path twice. |
| 122–132 | `<link rel="stylesheet" href="styles/*.css">` × 10 | The May-2026 CSS split. See §17 for the cascade contract. |
| 134–146 | Affiliate / partner config HTML comment | One-place documentation for broker referral codes. |
| 148–176 | Inline `<script>` — `window.AFF` / `window.aff` / `window.affClick` broker referral handling | |
| 178 | `</head>` | |
| 180 | `<body class="has-sidebar">` | |
| 263–281 | `<header>` | Brand + theme toggle + section nav trigger |
| 755 | `<main id="content">` opens | Landmark for screen readers / "skip to content" |
| 758–~1042 | `<div class="sec active" id="anatomy">` + 33 placeholder `<div class="sec" id="X" data-content="X">` siblings | `anatomy` is the only inline section (landing page); the rest are empty stubs that `loadSectionContent()` fetches from `content/X.html` on first navigation. |
| 1044 | `</main>` closes | |
| 1045–1115 | Small bootstrap `<script>` (`window.seedCalcOutputs` and friends) | |
| 1117–1119 | `<!-- BIAS CALCULATOR + PINE SCRIPT -->` comment + out-of-`<main>` placeholder `<div class="sec" id="bias" data-content="bias">` | Pre-existing structural quirk — bias section lives next to its module script. |
| 1121–1398 | `biasModule` IIFE | OI-based bias calculator UI logic. |
| 1401–5526 | `liveChartModule` IIFE (~4.1K lines) | Lightweight Charts v5.2.0 wrapper, Upstox V3 WebSocket real-time feed (protobuf) + V2/V3 historical candle fetch + HTTP LTP polling (fallback), market-hours detection, indicators / drawings / layouts, self-diagnostic for failed fetches. `processSpotLtp(ltp)` shared by WS and HTTP paths. `state.fetchAbort` / `state.loadSeq` cancel stale loads on rapid TF switches; `istDateKey()` normalizes "today" comparisons. |
| 5329–7671 | `paperTradeModule` IIFE (~2.3K lines) | Paper-trading state, SL/TGT, pending LIMIT/STOP orders, EOD square-off (with `priceFor → lastPx → entry` fallback), card-based rendering for open / pending / history. |
| 7679–10753 | Swing-trade analyzer + indicator math library + utility IIFEs (~3.1K lines) | Stock universe loader, ADX / Supertrend / Stochastic / OBV / candle-pattern-detection library, lookback pattern detection, per-TF analyzer, trade-plan generator, stock picker, renderer, swing-chart polling. |
| 10764–17033 | Intraday multi-TF recommendation module (~6.3K lines, the single largest IIFE) | SCALP-only engine (May 2026 — SWING removed), session-phase classifier (PRE_OPEN / OR_FORMING / OR_SETTLED / PRIME / LATE_MORN / LUNCH_CHOP / AFTERNOON / LATE_PUSH / LATE_SCALP / NO_NEW / POST_CLOSE / WEEKEND), India-VIX + Bank Nifty intraday fetches, VWAP / FHR / ORH-ORL / PDH-PDL, RSI divergence detector, auto-discovered S/R, intraday-flavoured per-TF analysis, intraday plan grid + S/R ladder rendering, live tick re-pricing. |
| 17036–18198 | `liveChainModule` IIFE (~1.2K lines) | Option chain fetch, OI bias scoring, support/resistance wall visualisation, API token modal (with focus trap + restore focus). |
| 18209–18863 | Bootstrap `<script>` — `sectionNav` IIFE (~650 lines) | `ORDER` / `LABELS` / `GROUPS` constants drive `buildNav()` and `buildJump()`; `loadSectionContent()` fetches lazily; `show()` / `gotoId()` activate sections + update hash; sidebar collapse; theme toggle; hash routing; palette + shortcuts modals (with focus restore). |
| 18865–18960 | `<footer>` + Upstox API setup docs | How a user obtains a token. |
| 18960–19042 | `</body>` / `</html>` close | |

Section content lives in `content/X.html` — each file is the inner HTML (the `<div class="wrap">…</div>` body) of what used to be `<div class="sec" id="X">…</div>`. The placeholder in the shell supplies the outer `<div class="sec" id="X">` wrapper.

Stylesheets live under `styles/<name>.css` — see §17 for the split contract.

## 3. Navigation model

The sidebar is data-driven by three constants in the bootstrap script (around line 23560):

- `ORDER` — flat array of section ids in display order (drives prev/next arrows).
- `LABELS` — id → human label map.
- `GROUPS` — collapsible sidebar groups: `Foundation`, `Candles`, `Patterns`, `Analysis`, `Indicators`, `F&O Playbook`, `Strategy`, `Tools`, `Discipline`, `Practice`, `Reference`.

`show(id, btn)` activates a `<section class="sec" id="...">`, updates the URL hash, and triggers `tvReload()` when entering `live`. To add a new section: write the `<section>`, then append its id to `ORDER`, `LABELS`, and the appropriate `GROUPS` entry — `buildNav()` and `buildJump()` will pick it up.

## 4. Live chart (`liveChartModule`)

- **Library**: Lightweight Charts 5.2.0 (`LWC_SRC` constant, lazy-loaded via injected `<script>`), with `lightweight-charts-drawing@0.1.1` plugin for interactive drawing tools (`DRAWING_SRC` constant).
- **Instrument**: hardcoded `NSE_INDEX|Nifty 50`.
- **Endpoints**:
  - `GET https://api.upstox.com/v3/historical-candle/{ikey}/{unit}/{interval}/{to}/{from}`
  - `GET https://api.upstox.com/v3/historical-candle/intraday/{ikey}/{unit}/{interval}`
  - `GET https://api.upstox.com/v2/market-quote/ltp?instrument_key=...`
- **Auth**: `Bearer ` + `localStorage.getItem('upstox_token')`. No refresh-token flow — user pastes a daily token via the API modal.
- **Timeframes**: `1m, 3m, 5m, 15m, 30m, 1h, 1d` — `TF` map at the top of the module defines bucket size + history window per TF.
- **Data feed**: primary is Upstox V3 WebSocket (`ltpc` mode, protobuf-encoded binary, sub-second latency). Falls back to HTTP polling (`/v2/market-quote/ltp` every 2s) when WS is unavailable. Both paths feed `processSpotLtp(ltp)` which updates the current candle, calls `updateLTP()`, `paperTradeTick(ltp)`, and `updateAuthSpotPriceLine()`.
- **WebSocket lifecycle**: `startWebSocket()` → authorize (`/v3/feed/market-data-feed/authorize`) → connect (`wss://`) → subscribe (`ltpc` mode) → decode (`protobufjs`) → `processSpotLtp()`. Auto-reconnect with exponential backoff. On connect, HTTP polling stops; a 60s `silentRefetch()` sync timer provides authoritative OHLCV. On disconnect, HTTP polling resumes.
- **Polling (fallback)**: `state.pollIntervalMs = 2000` while market is open; throttled to ~60s outside market hours. `pollTick()` short-circuits when `state.wsConnected` is true.
- **Market-hours**: `isMarketOpen()` and `nextOpenLabel()` are exported on `window` so paper-trading and chain modules share the same notion of "open".
- **Exposed globals**: `window.tvReload`, `window.tvSetTimeframe`, `window.tvToggleFullscreen`, `window.tvState`, `window.isMarketOpen`, `window.nextOpenLabel`, `window.tvWebSocketReconnect`.
- **Tick fan-out**: every chart tick (WS or HTTP) calls `window.paperTradeTick(ltp)` so paper trading stays in sync without its own poller for spot.

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

00000000. **WebSocket real-time feed** (2026-05-27): Replaced HTTP LTP polling (2s interval, `/v2/market-quote/ltp`) with a persistent Upstox V3 WebSocket connection for sub-second spot price updates — matching TradingView / Upstox's own terminal latency. Architecture: (1) `loadProtobuf()` lazy-loads `protobufjs@7.4.0` from jsdelivr CDN (72KB, cached by SW); (2) Upstox V3 `MarketDataFeed.proto` schema is embedded inline as JS string array, parsed once via `protobuf.parse()` into a `FeedResponse` type; (3) `startWebSocket()` calls `GET /v3/feed/market-data-feed/authorize` for a one-time `wss://` URL, opens a WebSocket, subscribes to `NSE_INDEX|Nifty 50` in `ltpc` mode; (4) binary protobuf messages are decoded and fed to `processSpotLtp(ltp)` — a new shared function extracted from the old `pollTick` — which handles candle bucket update, `updateLTP()`, `paperTradeTick(ltp)`, `updateAuthSpotPriceLine()`, and status pill/footer updates; (5) auto-reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s max); (6) on WS connect: HTTP polling stops, a 60s `silentRefetch()` sync timer replaces it for authoritative OHLCV; on WS disconnect: HTTP polling resumes as fallback. State fields: `state.ws`, `state.wsConnected`, `state.wsReconnectTimer`, `state.wsReconnectAttempt`, `state.wsFeedResponseType`, `state.wsSyncTimer`. Exposed: `window.tvWebSocketReconnect()`. Status pill shows "WS LIVE" when connected. `pollTick()` short-circuits when `state.wsConnected` is true (still updates `_lastPollTickTs` for the rAF heartbeat). SW bumped to `v505-2026-05-27-ws-realtime-feed`; added `cdn.jsdelivr.net` to cache-first rules.

0000000. **Full Upstox API pause toggle** (2026-05-27): User-controlled master kill-switch that prevents ALL Upstox API calls across every module — chart spot LTP (`pollTick`), historical candle fetch (`fetchHistorical`), aggregated volume fetch, authoritative spot fetch, option-price LTP polling (`pollOptionPrices`), fresh option price fetch, chain auto-refresh, manual chain fetch (`fetchChain`), trade placement (`placeOpt`), intraday analyzer fetch (`fetchOneTf`, `analyze`). Mirrors the swing analyzer's pause toggle design. localStorage key: `pt_api_paused_v1`. Helpers: `ptIsApiPaused()` / `ptSetApiPaused(flag)` in `paperTradeModule`, `window.ptIsApiPaused` exposed on window so `liveChartModule`, `liveChainModule`, and the intraday analyzer can all check it. Guard points: (a) `pollTick()` — chart spot LTP polling; (b) `fetchHistorical()` — throws `API_PAUSED`; (c) `fetchAggregatedHistoricalVolume()` — returns null; (d) `fetchAuthoritativeSpot()` — returns; (e) `shouldPollOptions()` returns false — stops the 2s option LTP poll, watchdog, and rAF heartbeat; (f) `fetchFreshOptionPrice()` — returns null; (g) `placeOpt()` — blocks with alert; (h) `fetchChain()` in `liveChainModule` — short-circuits; (i) `fetchOneTf()` in intraday analyzer — throws `API_PAUSED`; (j) intraday `analyze()` — returns silently. EOD square-off still fires using cached `lastPx → entry` fallback. UI: `#pt-api-pause-banner` at the **top** of `content/live.html` (above the chart, first thing in the section), rendered by `renderPtApiPauseBanner()` and toggled by `window.ptToggleApiPause()`. On pause: also kills chart `pollTimer`. On resume: re-triggers `tvReload()` + `startOptionPolling()` + `pollOptionPrices()`. CSS in `styles/paper-trading.css` (`.pt-api-pause-*` classes). SW bumped to `v469-2026-05-27-full-api-pause`.

000000. **Off-hours option-LTP polling gate** (2026-05-24): Bug fix — `paperTradeModule.pollOptionPrices()` was firing the Upstox `market-quote/ltp` batch fetch every 2s **even on weekends / overnight**, because the intraday analyzer caches its last BUY_CE / BUY_PE verdict (from Friday's close) and `intradayGetAtmInstrumentKeys()` kept returning the CE+PE keys for the cached ATM strike — so the poller had work to do at 01:00 IST on a Sunday. Burned ~900 wasted calls per 30-min window against Upstox's 2 000-call budget and risked tripping the 429 gate at Monday's open. Fix: added `if (!shouldPollOptions()) return;` at the top of `pollOptionPrices`. The `shouldPollOptions()` helper has always had the correct gate (market-open + has-something-to-poll), and the WATCHDOG branch was already using it — but the main entry path was missing the check. Re-using the same helper keeps behaviour consistent; the rAF heartbeat, watchdog restart, and ~6 manual fire-and-forget call sites all flow through `pollOptionPrices`, so the one-line guard catches every entry point. When the market opens at 09:15 IST the next 2s tick (or rAF heartbeat) automatically resumes polling — nothing to clean up after market close. SW bumped to `v281-2026-05-24-offhours-poll-gate`.

00000. **Structure-room pill purge** (2026-05-24, immediately after the SCALP-only refactor below): Follow-up noise sweep — removed the now-orphaned STRUCTURE ROOM pill end-to-end. After SWING came out, the pill was a `pill.hidden = true` stub with no data path; the engine wasn't reading `plan.structure` anywhere, but the DOM, CSS rules, tooltip handler, two red-flag chips, and the `renderStructurePill` stub itself were still on disk. Deleted: the pill DOM block + comment in `content/live.html` (~22 lines), all `.ia-struct-*` CSS rules + grid overrides in `styles/intraday-analyzer.css` (~110 lines), the AT-WALL and R:R<1.0 red-flag chips in the HUD red-flag block, the `'ia-struct-pill'` tooltip handler (~35 lines), `'ia-struct-pill'` from the pill-IDs array in the tap-for-detail wiring, the dead `structCETight` / `structPETight` snapshot computation in `generateVerdict`, the unused `st` local in `shortBlockReason`, the dead `plan.structure` field on the plan object, the `an5LastClose` helper (only the pill read it), and the `renderStructurePill` call site + function. Replaced the only remaining `plan.structure.ceTight.atr` read (CPR pill ATR fallback) with `plan.volatility.atrPoints` so nothing reads the dead field. The upstream `collectStructuralSr` + `computeStructureRoom` helpers still run (the WIDE variant still feeds the per-TF card score with +/- 1-2 pts of structural-room contribution — that's score input, not a SWING-style veto, and works for SCALP too). SW bumped to `v280-2026-05-24-structure-pill-purge`. Net delta: another ~200 LOC out (90 from HTML, 110 from CSS), making the combined SCALP-only + pill-purge cleanup ~650 LOC simpler than the pre-refactor tree.

0000. **SCALP-only refactor** (2026-05-24): Ripped out SWING mode entirely. The intraday analyzer used to support two trading-mode lenses (SCALP / SWING) with a segmented toggle at the top of the result block; in practice the tool is built for a single trader doing 2-30 min scalping with 15k INR capital, and the SWING path added cognitive overhead, a toggle UI surface, ~150 LOC of `isScalp ? A : B` branches across the verdict + risk plan engine, and a real bug (mode toggle on weekends re-fired `analyze` and overwrote the cached verdict with a contradictory "WAIT 12/12 TIED"). Removed: (a) the `.ia-mode-toggle` segmented control from `content/live.html`; (b) all `.ia-mode-*` CSS rules in `styles/intraday-analyzer.css`; (c) `setTradingMode` / `renderModeToggle` / `TRADING_MODE_KEY` helpers + the three `window.intraday*TradingMode*` exposures in `candlestick-patterns.html`. Kept: a stub `getTradingMode()` that returns the constant `'SCALP'` so the dozens of downstream call sites (journal entries that persist `plan.mode`, `plan.session.mode`, pill tooltips) keep working without a sweeping signature refactor. Engine simplifications: dropped the SWING branches of `classifySessionPhase` / `sessionPhaseLabel` / `sessionPhaseClass` / `phaseEndMin` / `phaseVerdict` / `phaseImpact` (phase set is now WEEKEND / PRE_OPEN / OR_FORMING 09:15-09:20 / OR_SETTLED / PRIME / LATE_MORN / LUNCH_CHOP / AFTERNOON / LATE_PUSH (full HIGH) / LATE_SCALP (LOW) / NO_NEW (last 5 min only) / POST_CLOSE — `LUNCH` and `THETA_DANGER` are gone). Inside `generateVerdict`: dropped the structural-room veto and structural-R:R confidence demote (both gated on `!isScalp` — measured day-walls R:R, wrong yardstick for a 4-5 pt scalp); collapsed the LATE_MORN / LUNCH / LATE_PUSH SKIP-IF ternaries; collapsed the QUIET-day demote ternary; folded the structural-timid retest-entry SKIP-IF. Inside `computeRiskPlan`: collapsed `minT1Dist` / `minSpacing` / `nearLadder` / `farLadder` / `fallbackStep` / `minSlDist` / SL fallback ternaries to their SCALP path. `renderStructurePill` body deleted (~80 lines) — pill is now always hidden since it measured SWING-style R:R against daily walls. SW bumped to `v279-2026-05-24-scalp-only`. Net delta on `candlestick-patterns.html`: roughly −250 LOC of branching + helpers + dead render code, +commented stubs documenting what was removed and why. The journal data model still stores `plan.mode`, so historical entries (including any pre-refactor `'SWING'` rows) render correctly.

000. **Mobile-reader build** (2026-05-10): New `scripts/tools/build-mobile-reader.py` produces `mobile-reader.html` — a single self-contained ~800 KB HTML for offline phone reading. Inlines `anatomy` (extracted from main shell) + every educational `content/*.html` (skips interactive sections: `live`, `bias`, `calc`, `chain`). Stripped at build: inline `onclick`/`onkeydown`, `role="button"`/`tabindex="0"` on `<div>`s, affiliate `aff-card` blocks (need broker-tracking JS that doesn't ship). Rewrote home-page `<div class="path-card" onclick="paletteSelect('X')">` → `<a class="path-card" href="#X">`. Dead anchors to excluded sections redirected via `EXCLUDED_REDIRECTS` map (chain → options, bias → options, calc → exits, live → playbook). Output bundles a mobile-first stylesheet (system fonts, dark/light, responsive grids, scrollable tables, print stylesheet) + tiny vanilla-JS layer for theme toggle, slide-in TOC drawer, back-to-top FAB, and IntersectionObserver-driven active-link highlighting in TOC. Zero external deps — opens correctly under `file://`. The main app + content files are NOT modified by this build (read-only).
00. **Branding pass + logo v2 + raster pipeline** (2026-05-10): App renamed `PatternLab → Trading Studio` (manifest, `<title>`, all meta tags, SVG `aria-label`, footer copy, UTM source, SW cache names). Logo redesigned: 3 ascending candles (bear/doji/bull) with dashed gold trend line connecting wick tops + faint gold "studio floor" baseline; new design shipped to all 3 inline SVGs (header / sidebar / footer) and 3 PWA SVG icons. Sidebar `.ms-bear/.ms-star/.ms-bull` animation classes preserved. New `scripts/tools/generate-icons.py` (Pillow, strongly typed, functional) renders 12 PNG variants from one source-of-truth `Candle` definition: PWA fallbacks, favicons (16/32/48 + .ico), apple-touch-icon (180), transparent logos (512/1024), Open Graph card (1200×630), Instagram square (1080×1080). HTML `<head>` got proper static `<link>` favicon stack + Open Graph + Twitter Card meta — replacing the old runtime `buildFavicon()` JS hack. Manifest extended with PNG icon entries. SW bumped through `v5 → v6 → v7 → v8 → v9-2026-05-10-png-pack`. Sidebar brand text changed to single-line `TRADING STUDIO` (was `TRADING<br>STUDIO`); hero swapped (header now says brand, hero says category).
0. **Content split** (post-PWA): `candlestick-patterns.html` shrunk from **24,314 → 9,711 lines (-72.7%)** by extracting all 37 non-default sections into `content/<id>.html`. `loadSectionContent(id, done)` in the bootstrap script fetches on first navigation, caches in DOM forever, and shows a `LOADING…` placeholder + retry button on failure. The `live` section's `tvReload()` auto-start now runs inside the load callback so DOM elements (`#tv-chart-container` etc.) exist before init. Race-protected via `contentInflight` map. SW bumped to `v2-2026-05-09-content-split`. Backup at `candlestick-patterns-before-split.html` (do not ship). Splitter at `scripts/tools/split-content.py` is idempotent. See §16.
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
- **Re-run the splitter** (rare — only if you want to extract `anatomy` too, or re-shape the file): edit `KEEP_INLINE` in `scripts/tools/split-content.py`, restore from `candlestick-patterns-before-split.html`, then `python3 scripts/tools/split-content.py`.
- **Change the logo or rebrand**: edit the `Candle` constants and color palette at the top of `scripts/tools/generate-icons.py`, then `.venv/bin/python scripts/tools/generate-icons.py` to re-render all 12 PNG variants. Mirror the geometry change in (a) the three SVG files in `pwa/icons/`, (b) the inline SVGs in `candlestick-patterns.html` (header line ~5661, sidebar line ~5685, footer line ~9608), (c) the inline SVG data URI in the favicon `<link>` (line ~42), then bump `CACHE_VERSION` in `sw.js`. If the rebrand changes the wordmark on the OG card, also edit the title strings in `_render_landscape_card` / `_render_square_card`.
- **Set up the icon-generator venv** (one-time, after fresh clone): `python3 -m venv .venv && .venv/bin/pip install pillow`. The `.venv/` lives in the workspace root and is intentionally not committed (no git) — it's just a sandbox for the Pillow install.
- **Rebuild the mobile reader** (after editing any `content/*.html` or the inline `anatomy` section): `.venv/bin/python scripts/tools/build-mobile-reader.py`. Output is `mobile-reader.html` at the project root. The script is read-only against the main files — it never modifies `candlestick-patterns.html` or `content/*.html`.
- **Add / remove a section from the mobile reader**: edit the `SECTIONS` tuple at the top of `scripts/tools/build-mobile-reader.py`. Order in the tuple is the order in the reader and TOC. To exclude an interactive section (one that depends on JS modules / network), just leave it out and add an entry to `EXCLUDED_REDIRECTS` so any incoming `href="#that-id"` is rewritten to a valid alternative.
- **Transfer the mobile reader to a phone**: AirDrop the file (Mac → iPhone, opens via Files → tap → "Open in Safari"); or email-to-self → tap attachment in Mail → Safari icon; or upload to iCloud Drive / Google Drive / Dropbox and open from the corresponding mobile app. The file is fully self-contained, so no internet is needed once on the phone.
- **Change Nifty lot size** (e.g. SEBI revision): update `LOT_SIZE_NIFTY` in `paperTradeModule` (around line 21346) and the lot hint text near the BUY CE / PE cards.
- **Move EOD time**: edit `EOD_HOUR` / `EOD_MINUTE` (around line 21351). Day-of-week guard already excludes Sat / Sun.
- **Add a new auto-exit reason** (e.g. trailing): extend the `exitReason` union, branch in `checkRiskTriggers`, and add a new `pt-toast` kind class + CSS. If the reason should be unconditional like EOD, mirror the `priceFor → lastPx → entry` fallback chain so the position can never be left stuck open.
- **Add a new stat cell**: insert `<div class="pt-stat-cell">` inside `pt-stats-strip`, write a `renderXxx()`, call it from `renderAll()`, and bump the responsive grid `@media` rules accordingly.
- **Swap broker (chart / chain data)**: replace the V2 / V3 base URLs and adapt request / response shapes inside `liveChartModule` and `liveChainModule`. The rest of the app reads only `window.optionChainData`, the chart series, and `window.paperTradeTick(ltp)`.

## 12. Known limitations / quirks

- **No slippage / no brokerage simulation** in paper trading. Exit = trigger tick price.
- **Spot tick rate**: sub-second when WebSocket is connected (real-time Upstox V3 feed); falls back to 2s HTTP polling when WS is unavailable. The chart drives paper-trading P&L for IDX positions, while OPT positions use a separate option-quote HTTP poll for premiums (option WS subscription is not yet implemented).
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
  2. **PNG raster pipeline** (`scripts/tools/generate-icons.py` + Pillow) — generates 12 raster outputs (`icon-{192,512}.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-{16,32,48}.png`, `favicon.ico`, `logo-transparent-{512,1024}.png`, `og-image.png`, `social-square.png`). Edit logo geometry in the `Candle` constants at the top, then run `.venv/bin/python scripts/tools/generate-icons.py`.
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

### Splitter (`scripts/tools/split-content.py`)

- One-shot transform from a monolithic HTML to shell + `content/`. Reads `candlestick-patterns.html`, writes `content/<id>.html` per section, replaces each section in the HTML with a placeholder.
- `KEEP_INLINE = {"anatomy"}` controls which sections stay embedded.
- Re-running on an already-split file is a no-op (no `<div class="sec" id="X">` openings to match — only placeholders, which the regex doesn't match because placeholders have a `data-content` attribute breaking the `id="X">` end anchor).
- If you want a clean re-split: `cp candlestick-patterns-before-split.html candlestick-patterns.html && rm -rf content/ && python3 scripts/tools/split-content.py`.

### Service worker

`content/*.html` files fall through to the same-origin **stale-while-revalidate** rule in `sw.js` — they're cached on first fetch, served from cache instantly thereafter, and refreshed in the background. They are intentionally **NOT precached** during SW install (would push install size from ~50 KB to ~830 KB; users who only visit a few sections shouldn't pay for that). Bump `CACHE_VERSION` after any content edit so existing PWA installs pick up the change.

## 17. Stylesheet split contract

The second-most-important architectural change. Read this before touching `styles/`, `<link rel="stylesheet">` tags in the shell `<head>`, or `scripts/tools/build-mobile-reader.py`.

### Shape

In May 2026 the inline `<style>` block (~11.5K lines, 37% of the shell) was extracted into 10 files under `styles/`. The shell `<head>` now references them via plain `<link rel="stylesheet">` tags (lines `122–132`), in **strict cascade order**:

```html
<link rel="stylesheet" href="styles/base.css">              <!-- tokens + theme + reset + header/nav/sections/grid/card/anatomy/table -->
<link rel="stylesheet" href="styles/swing-analyzer.css">    <!-- .sw-* selectors -->
<link rel="stylesheet" href="styles/intraday-analyzer.css"> <!-- .int-* + reused .sw-* selectors -->
<link rel="stylesheet" href="styles/paper-trading.css">     <!-- .pt-* selectors -->
<link rel="stylesheet" href="styles/live-chart.css">        <!-- .tv-* selectors -->
<link rel="stylesheet" href="styles/option-chain.css">      <!-- .up-* + .oc-* selectors -->
<link rel="stylesheet" href="styles/api-modal.css">         <!-- .tv-api-* + .api-modal selectors -->
<link rel="stylesheet" href="styles/marketing.css">         <!-- .aff-* affiliate + late UX overrides -->
<link rel="stylesheet" href="styles/sidebar-nav.css">       <!-- body.has-sidebar + section-nav + jump + inline icons -->
<link rel="stylesheet" href="styles/bias.css">              <!-- .bias-* + .pine-copy-btn -->
```

### Invariants — do NOT break

- **Cascade order is load order**. Reordering the `<link>` tags WILL silently change which rule wins. `base.css` defines tokens + `[data-theme=light]` overrides, so every later file is allowed to consume `var(--bull)` etc. and to override component-level rules from earlier files. `marketing.css` and `sidebar-nav.css` deliberately ship late because they contain layout overrides that need to win.
- **Never inline a `<style>` block back into the shell `<head>`** without putting it in the exact cascade slot you intended — `extract_main_styles()` in [scripts/tools/build-mobile-reader.py](scripts/tools/build-mobile-reader.py) does interleave inline blocks and `<link>` tags by document position, but the live app's cascade also depends on document position, so the rule is symmetric: put it where it should win.
- **Never strip the 4-space relative indent** of multi-line `/* */` comments inside any CSS file. Some originally had 3-space (line-continuation) indent; the extractor stripped it uniformly. Inserting new comments at a different indent inside a file doesn't break CSS but DOES make grep-and-replace passes harder.
- **Component-prefix discipline**. Each file owns one prefix (or a small documented set):
  - `base.css`: `:root`, `[data-theme=...]`, element selectors (`html`, `body`, `header`, `nav`, `footer`), `.card`, `.anatomy`, `.tbl`, `.tc/.tw/.tp`, `.info`, base media queries.
  - `swing-analyzer.css` + `intraday-analyzer.css`: `.sw-*` (the intraday module reuses ~95% of swing analyzer CSS — keep the shared rules in `swing-analyzer.css` and only intraday-specific overrides in `intraday-analyzer.css`).
  - `paper-trading.css`: `.pt-*`
  - `live-chart.css`: `.tv-*` (LWC toolbar / shell)
  - `option-chain.css`: `.up-*` (Upstox option chain) + `.oc-*`
  - `api-modal.css`: `.tv-api-*` + `.api-modal*`
  - `marketing.css`: `.aff-*` + general UX enhancements (modals, palette, toast styles that aren't section-scoped)
  - `sidebar-nav.css`: `body.has-sidebar`, `.section-nav`, `.jump-*`, `.icon-*`
  - `bias.css`: `.bias-*`, `.pine-*`
- **When adding a brand-new component family** that doesn't fit any existing file: create a new `styles/<family>.css`, add a `<link>` in the shell at the correct cascade slot (later = wins more often; earlier = depends on later cascade), and bump `CACHE_VERSION` in `sw.js`.
- **Service worker doesn't precache `styles/*.css`** — they fall through to the same-origin stale-while-revalidate rule (same as `content/*.html`). First visit fetches all 10 in parallel over HTTP/2 (~50ms on a typical connection, since they total ~262 KB). All subsequent visits serve from cache instantly.

### Mobile-reader build

[scripts/tools/build-mobile-reader.py](scripts/tools/build-mobile-reader.py)'s `extract_main_styles()` walks the shell HTML in document order, resolves every `<link rel="stylesheet" href="styles/...css">` to its file contents, also picks up any remaining inline `<style>` blocks, and concatenates them. The result is inlined under the `__MAIN_STYLES__` sentinel in [mobile-reader.html](mobile-reader.html), preserving the exact same cascade order as the live app.

If you delete or rename a file in `styles/` without updating the shell's `<link>` tag, the mobile-reader build raises `RuntimeError` with the offending href so the breakage is loud.

### Re-running the CSS split

There is no committed extractor script (unlike `scripts/tools/split-content.py`). The May-2026 extraction was a one-shot Python heredoc that:

1. Read the inline `<style>` body from `candlestick-patterns.html` (lines `122–11616` of the pre-split shell).
2. Sliced it at the 9 `/* ═════════ TITLE ═════════ */` banners into `styles/base.css` through `styles/sidebar-nav.css`.
3. Read the second inline `<style>` block (`12602–12762` of the pre-split shell) into `styles/bias.css`.
4. Stripped up to 4 leading spaces per line (the HTML indent) for cleaner external files.
5. Byte-verified that concatenating all 10 outputs (with the same dedent applied) reproduced the original `<style>` bodies exactly.
6. Replaced both inline `<style>` blocks in the shell with the 10 `<link>` tags.

If you ever need to re-split (e.g. break `intraday-analyzer.css` further), start from a clean snapshot of the pre-split shell and reproduce those six steps. Do NOT try to incrementally re-slice the current `styles/*.css` — the per-file ownership has already drifted from pure banner-slicing as new rules have been added directly to the relevant file.

## 18. JavaScript module split contract (COMPLETE — May 2026)

The third structural extraction, mirroring the `content/` (§16) and `styles/` (§17) splits: the inline `<script>` IIFE blocks in the shell were moved into external `scripts/*.js` files. **Done:** the shell went from **37,372 → 1,345 lines (−96.4%)**, with the only remaining inline `<script>` being the pre-paint bootstrap (#1, must stay inline). The 1,000-line cap held for every block except the two single-closure monsters (`swing-analyzer.js`, `intraday-analyzer.js`), which were extracted whole because they cannot be split without rewriting signal logic — see the completion note below.

### Method — behaviour-preserving "move, don't rewrite"

- Each inline `<script>` block is extracted **verbatim** into `scripts/<name>.js` and replaced by a `<script src="scripts/<name>.js"></script>` in the **same document position**.
- The new tags are **classic scripts** (NOT `type="module"`) — top-level `function`/`var` declarations and `window.x = …` assignments stay **global**, so the ~325 `window.*` exposures and the inline `onclick`/`onchange` handlers in the shell + `content/*.html` (which resolve against `window.*` at event time — §16) keep working with zero changes.
- **`defer` was added to all 10 module tags (May 2026, post-migration).** This is safe and correct here because: (a) `defer` preserves **document order** of execution, so the module-evaluation-order dependency (see the `liveChartModule` "fetch resolves after the synchronous module IIFEs evaluate" comment) is intact — the modules still run affiliate→…→navigation; (b) the only remaining inline `<script>` is the top pre-paint bootstrap, which has **no module dependency**, so nothing runs JS that needs a module global during parse; (c) inline handlers fire on user interaction, long after `DOMContentLoaded`, and `defer` scripts always execute **before** `DOMContentLoaded` — so every global is defined before any handler or hash-routed `show()` can fire. Benefit: ~1.96 MB of JS no longer blocks HTML parse / first paint. **Do NOT add `async`** (that WOULD break order). If you add a new module `<script>`, give it `defer` too and keep it in the correct document slot.
- The **pre-paint theme + SW-registration block stays inline** (lines ~20–84). It must run before first paint to avoid FOUC; externalizing it would add a blocking round-trip.
- `scripts/*.js` are **not precached** by the SW — they fall through to the same-origin stale-while-revalidate rule (§17, same as `content/` and `styles/`). Bump `CACHE_VERSION` after each batch.

### Verification standard (real-money app — verify every extraction)

For each module, before moving on: (1) `node --check` the new file; (2) byte-fidelity diff of the new file body vs the still-inline block, whitespace-normalized (the HTML inner body equals the external file body + 4 leading spaces); (3) confirm the inline definition is gone and the `<script src>` is wired in the right slot; (4) **execute the module in a Node `vm` sandbox** with `window`/`document`/`localStorage` shims and assert its real behaviour (e.g. `calcBias` produces the right bucket, `apiSetupSave` writes the token). A live browser smoke test on `server.py` is still the final gate; the Node-shim assertions catch regressions without it.

### Extracted so far (batch 1)

| File | Was inline block | Exposes |
|---|---|---|
| `scripts/affiliate.js` | `<head>` affiliate config | `window.AFF` / `aff` / `affClick` |
| `scripts/calc.js` | position-size / R:R / SL / lot-value calculators | `calcPosSize` / `calcRR` / `calcSL` / `calcLotValue` / `fmtINR` / `window.seedCalcOutputs` |
| `scripts/bias.js` | `biasModule` IIFE | `window.calcBias` / `resetBias` / `loadBiasExample` / `copyPine` |
| `scripts/api-setup.js` | API-setup token panel IIFE | `window.apiSetup*` / `_apiSetupRefresh` + `hashchange` listener |
| `scripts/navigation.js` | nav/UI bootstrap block (#11, 664 lines) | `show` / `toggleTheme` / `toggleSidebar` / `loadSectionContent` / `toggleGroup` / `scrollTop` / palette+shortcuts fns / `window.buildSectionChrome` / `window.gotoId` (added May-2026: `gotoId` was private to the `sectionNav` IIFE but 9 `content/*.html` pages call it via inline `onclick` — a pre-existing latent ReferenceError, now exposed) |
| `scripts/live-chain.js` | `liveChainModule` IIFE + API modal (#9, 1,218 lines) | `window.optionChainData` / `upFetchChain` / `upSaveToken` / `upClearToken` / `upSaveAndStart` / `apiOpenModal` / `apiCloseModal` / `stopChainLiveTicker` |
| `scripts/paper-trade.js` | `paperTradeModule` IIFE (#6, 2,785 lines — over the 1K cap by design; clean single IIFE, no internal cut) | `window.paperTradeTick` / `ptBuy*` / `ptExit*` / `ptReset` / `ptSetQty` / `ptUpdatePosRisk` / `ptOnChainLoaded` / `ptToggleApiPause` / `ptIsApiPaused` + ~20 more `pt*` |
| `scripts/live-chart.js` | `liveChartModule` IIFE (#5, 4,787 lines — over the 1K cap by design; clean single IIFE, no internal cut) | `window.tvReload` / `tvSetTimeframe` / `tvToggleFullscreen` / `tvState` / `isMarketOpen` / `nextOpenLabel` / `tvWebSocketReconnect` / `_upstox*` rate-limit buckets + more |
| `scripts/swing-analyzer.js` | `swingModule` IIFE (#7, 14,227 lines — single closure, see note below) | ~70 exposures: `window.swingAnalyze` / `swingActivate` / `swingWire` / `fibScan*` / `swSector*` / `classifyStructure` / `cappedAtrValue` / `TREND_PARAMS_BY_TF` + more |
| `scripts/intraday-analyzer.js` | `intradayAnalyzerModule` IIFE (#8, 11,814 lines — single closure, see note below) | ~70 exposures: `window.intradayActivate` / `intradayRefresh` / `intradayLiveTick` / `sj*` (journal) / `bt*` + `runTrendBacktest` / `appConfirm*` / `ia*Event` (calendar) / `paperBridgeTick` + more |

Batch 2 onward is produced by the byte-exact extractor `scripts/tools/extract-js-module.py` (run `python3 scripts/tools/extract-js-module.py <key>`), which extracts a registered block verbatim, swaps in the `<script src>`, and refuses to write unless the dedent/reindent round-trip reproduces the original block byte-for-byte. Add new blocks to its `REGISTRY`.

### Split COMPLETE — all 10 module blocks extracted

The shell went from **37,372 → 1,345 lines (−96.4%)**. Every inline `<script>` IIFE
is now an external `scripts/*.js` loaded via a plain `<script src>` in its original
document position. The only inline `<script>` left in the shell is the **pre-paint
bootstrap** (#1, ~64 lines: synchronous theme read + SW registration) — it MUST stay
inline (it runs before first paint to avoid FOUC; externalising it would add a network
round-trip and reintroduce the flash).

#### The two monsters were extracted WHOLE, not internally split — and why

The original plan hoped #7/#8 were clusters of independent IIFEs that could be cut into
sub-1K files (`indicator-math.js`, `journal.js`, `alerts.js`, `confirm-modal.js`, …).
Inspection proved otherwise: **each monster is a single module-level IIFE** (`swingModule`,
`intradayAnalyzerModule`) wrapping ~145–240 nested **function declarations** that share the
one closure's private `state` + helpers. The `sj*`/`bt*`/`appConfirm*`/event-calendar groups
are `function foo(){…}` declarations inside that closure (e.g. `function appConfirm(opts)` at
indent 6), not sibling IIFEs. The deeper `})();` are inline expression-IIFEs computing
constants, not encapsulated modules.

So a byte-exact, behaviour-preserving internal split is **impossible without refactoring the
shared closure into an explicit namespace** — hundreds of call-site rewrites inside
real-money swing/intraday **signal logic**. Per `.cursor/rules/trading-context.mdc` (prefer
behaviour-preserving; don't rewrite risky signal code without strong reason) that refactor was
**explicitly declined** by the user. The safe outcome: extract each whole IIFE verbatim.
`swing-analyzer.js` (14.2K) and `intraday-analyzer.js` (11.8K) intentionally exceed the 1K cap
— each is one coherent, isolated domain. If they ever need internal sub-1K splitting, that is a
separate, test-heavy refactor task (namespace the closure), not a verbatim move.

> **Extractor note:** `dedent()`/`reindent()` pass **blank lines through verbatim** (preserving
> trailing whitespace) — required for the monsters' byte-exact gate, since they contain
> whitespace-only blank lines that an earlier blank→`""` collapse would have lost.

#### Tier-1 sub-split of `swing-analyzer.js` → `scripts/indicator-math.js` (2026-06-05)

The first **internal** carve-out of a monster, done the safe way (NOT the declined
closure-namespace rewrite). `swing-analyzer.js` went **18,714 → 17,400 lines**; the new
`scripts/indicator-math.js` (~1,380 lines) holds the **pure technical-analysis library** that
was lines ~3255–4569 of the swing closure: `ema/sma/rsi/macd/atr/adx/supertrend/stochastic/obv`,
`swingHighs/swingLows`, expected-move bands (`emReturnSigma`/`emBand`), capped-ATR helpers, the
full **candle-pattern library** (`isHammer`, `isBullishEngulfing`, … `detectPatterns`,
`detectLookbackPattern`), and the **zigzag** `classifyStructure`/`_zigzagFrom` + `TREND_PARAMS_BY_TF`.

Why it was safe to move (verified before cutting): the block is **100% pure** — no `STATE`, no DOM,
no `fetch`; its only external references are JS builtins (a free-variable analysis confirmed every
`NAME(` call resolves either inside the block or to `Math`/`Array`/`Date`/`Intl`). So it relocates
without behaviour change.

**Mechanism — namespace + closure-local aliases (no global pollution, no call-site rewrites):**
- `indicator-math.js` is its own classic-script IIFE that publishes `window.IndicatorMath`
  (53 names) **plus** keeps the individual `window.<fn>` globals the block already exported
  (`classifyStructure`, `_zigzagFrom`, `cappedAtrValue`, `cappedAtrSeries`, `getMedian20dATR`,
  `emReturnSigma`, `emBand`, `TREND_PARAMS_BY_TF`) that `intraday-analyzer.js` + the backtest read.
- At the **top of the swing closure** a single alias block re-binds all 53 names
  (`var ema = _IM.ema, …`), so the ~150 existing bare call sites (`analyzeTf`, `generatePlan`,
  the `_tfMath` / `__swingExports` bags, scan verdicts) keep working **unchanged**.
- **Load order matters:** `<script defer src="scripts/indicator-math.js">` sits **immediately
  before** `swing-analyzer.js` in the shell (`defer` = document order), and the backtest
  `scripts/backtest/lib.mjs` runs `indicator-math.js` in the vm sandbox **before** swing so
  `window.IndicatorMath` exists when the alias block binds it. **Do NOT reorder these two tags.**
- This Tier-1 split is the groundwork for `intraday-analyzer.js` to eventually consume the **same**
  shared math instead of its own copy (future Tier-2), killing real duplication.

**Verification done:** `node --check` both files; byte-exact gate on the moved 1,315-line region;
`scripts/backtest/guards.mjs` (1,042 real-candle windows, 25,395 assertions) all green;
browser-order vm load confirms `__swingExports` + the 62-key `_tfMath` are intact. The split was a
verified one-off Python script (anchored on the section banners, auto-generating the namespace +
alias list from the block so the two can't drift). SW bumped to `v931-2026-06-05-indicator-math-tier1-split`.

### Mobile-reader build note

The mobile reader strips interactive JS, so it ignores `<script src>` tags — but verify `scripts/tools/build-mobile-reader.py` still builds after the split (it scans `<link>` tags for CSS; it must not choke on the new script tags).
