# Trading Studio — Run Guide

Last updated: May 10, 2026

---

## TL;DR — Run it every day

```bash
cd /Users/saurabh.sharma2/Work/learning/candle-stick-pattern
python3 server.py 8000
```

Then open: **http://localhost:8000/candlestick-patterns.html**

That's the whole daily flow. Everything else below is one-time setup or "why".

---

## The big picture (in plain English)

You're building a chart app in your browser that talks to Upstox to get live market data. Three problems came up:

1. **Browsers are paranoid about who they let your code talk to.** When your JavaScript on `localhost:8000` calls `api.upstox.com`, the browser does a "is this allowed?" handshake first (called CORS preflight). If that handshake fails for any reason — even briefly — your code sees a generic `Failed to fetch` with no idea why.

2. **Upstox rate-limits your IP.** If your code accidentally makes too many requests too fast (which our volume aggregation was doing — 100 stock fetches per timeframe switch), Upstox's bouncer (Cloudflare) blocks your IP for 10–15 minutes.

3. **Switching timeframes was slow.** Every click triggered a fresh round-trip even if you'd just been on that timeframe 2 seconds ago.

We fixed all three by adding **two helpers** that sit between your browser and Upstox:

```
Your browser
    ↓
[server.py]   ← serves the HTML on localhost
    ↓
Your browser code
    ↓
[Cloudflare Worker]   ← absorbs the API calls, uses CF's IP not yours
    ↓
api.upstox.com
```

---

## Component 1 — `server.py` (your local web server)

**What it does:**
- Serves your HTML, JS, CSS files from your laptop on `http://localhost:8000`
- (Also has a backup proxy for `/api/*`, but the Cloudflare Worker takes priority)

**Why you need it:**
Browsers won't load PWAs, service workers, or modules from `file://` URLs — they need an actual web server. `python3 server.py 8000` is that server.

**How to run:**
```bash
cd /Users/saurabh.sharma2/Work/learning/candle-stick-pattern
python3 server.py 8000
```

**To stop:** `Ctrl+C` in that terminal.

---

## Component 2 — Cloudflare Worker (the API proxy)

**What it does:**
A tiny piece of code (`cloudflare-worker.js`, 130 lines) that runs on Cloudflare's global network. When your browser wants to call Upstox, it goes:

```
your browser → cloudflare worker → api.upstox.com → cloudflare worker → your browser
```

**Why you need it:**
Three reasons:

1. **No CORS preflight failures.** Same-origin requests don't trigger the "is this allowed?" handshake at all. When the browser calls `https://trading-studio-proxy.gsaurabh98.workers.dev/api/v3/...` and gets back the data, there's nothing to "fail to fetch."

2. **Bypasses Upstox's per-IP rate limit.** When the worker calls Upstox, it uses Cloudflare's IPs — not yours. Upstox treats every request as coming from a different (trusted) Cloudflare server, so per-IP limits never trip.

3. **Server-side retries.** If a single network blip happens between Cloudflare and Upstox, the worker retries 4 times before giving up. Your browser never sees the blip.

**Cost:** Free. The free tier gives you 100,000 requests/day. You'll use about 15,000.

**Already deployed?** Yes. URL:
```
https://trading-studio-proxy.gsaurabh98.workers.dev
```

You only need to deploy it again if:
- You delete it from your Cloudflare account
- You change `cloudflare-worker.js` and want the new code live

To redeploy:
```bash
cd /Users/saurabh.sharma2/Work/learning/candle-stick-pattern
wrangler deploy
```

---

## How the browser knows to use the worker

When the page loads, this JS runs (in `candlestick-patterns.html`):

```js
var CF_WORKER_URL = localStorage.getItem('cf_worker_url') || '';
```

If localStorage has a value, all Upstox calls go through the worker. If not, falls back to local proxy or direct calls.

**You already set this once** by visiting:
```
http://localhost:8000/candlestick-patterns.html?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev
```

That set the localStorage value permanently. Verify it's working: open DevTools console (Cmd+Opt+I), you should see:
```
[chart] using Cloudflare Worker proxy: https://trading-studio-proxy.gsaurabh98.workers.dev
```

**To turn it off** (e.g. test the local proxy or direct calls):
```
http://localhost:8000/candlestick-patterns.html?cf_worker=clear
```

---

## First-time setup checklist (what we already did)

- [x] Created `server.py` (local web server with backup proxy)
- [x] Created `cloudflare-worker.js` (the production proxy)
- [x] Installed wrangler: `npm install -g wrangler`
- [x] Logged in: `wrangler login`
- [x] Deployed: `wrangler deploy cloudflare-worker.js --name trading-studio-proxy`
- [x] Activated in browser: visited `?cf_worker=https://...`

You don't need to repeat any of these unless something breaks.

---

## Daily workflow

### Morning (start trading session)

```bash
cd /Users/saurabh.sharma2/Work/learning/candle-stick-pattern
python3 server.py 8000
```

Open http://localhost:8000/candlestick-patterns.html in your browser. Done.

### Evening (close the session)

`Ctrl+C` in the terminal running `server.py`. Done.

### Refresh the Upstox token (every morning at ~3:30 AM IST when it expires)

Upstox tokens die daily. When you see "Token expired" in the chart:

1. Get a new token from https://api.upstox.com (their developer portal)
2. Click the gear icon in the chart toolbar → paste new token → Save
3. Chart resumes

The token is stored in your browser's localStorage. The CF Worker forwards it to Upstox; the worker itself never stores it.

---

## Phone setup (optional)

Want the chart on your phone too?

### Option A — Same wifi as your laptop

```bash
# Find your Mac's IP
ipconfig getifaddr en0
# Example output: 192.168.1.42
```

On phone (same wifi), open:
```
http://192.168.1.42:8000/candlestick-patterns.html?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev
```

The `?cf_worker=...` part configures the phone to use your CF Worker too. After first load, you can drop the query param.

### Option B — Anywhere (deploy the chart itself to the cloud)

If you want the chart accessible from anywhere (mobile data, hotel wifi, etc) without your laptop being on, you'd need to host the HTML somewhere too. Options:
- **GitHub Pages** (free) — push your repo to GitHub, enable Pages
- **Cloudflare Pages** (free) — connect your repo, auto-deploys

Not set up yet. Ask if you want to do this.

---

## Troubleshooting

### "Failed to fetch" or "1015" or "1010"

Means the CF Worker didn't pick up the call. Check:

1. Console says `[chart] using Cloudflare Worker proxy: ...`?  
   - **No** → run `?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev` URL again
   - **Yes** → continue

2. Visit your worker URL directly: https://trading-studio-proxy.gsaurabh98.workers.dev — should respond (not necessarily with valid content, but not "site unreachable")
   - **Unreachable** → run `wrangler deploy` to re-publish
   - **Responds** → token issue, regenerate Upstox token

### "Loading Charts" stuck forever

- Token expired (most common — Upstox tokens die at 03:30 IST daily)
- Click the gear icon, regenerate, paste, save

### Constituent volume 400 errors in console

- Pre-existing issue with Upstox V3 not accepting some stock keys
- Doesn't break the chart, only affects volume bars
- Now silenced after one probe so you only see one log line, not 100

### Port 8000 already in use

```bash
# Find what's using it
lsof -i :8000
# Kill it (replace PID with the actual number from above)
kill <PID>
# Or just pick a different port
python3 server.py 9000
```

---

## File reference (what each file is for)

| File | What it does | When to edit |
|---|---|---|
| `candlestick-patterns.html` | The whole app | Adding features, fixing bugs |
| `content/*.html` | Lazy-loaded section content | Adding/editing educational content |
| `sw.js` | Service worker for offline / PWA | Cache strategy changes |
| `manifest.webmanifest` | PWA manifest | Icon / branding changes |
| `server.py` | Local dev server + backup proxy | Almost never |
| `cloudflare-worker.js` | Production API proxy | Almost never |
| `wrangler.jsonc` | Cloudflare deploy config | Auto-managed |
| `mobile-reader.html` | Standalone mobile reading view | Adding offline content |

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR LAPTOP                                                │
│                                                             │
│  ┌──────────────────┐         ┌─────────────────────────┐  │
│  │  python3         │  serves │  Browser                │  │
│  │  server.py 8000  │────────▶│  (the chart app)        │  │
│  │  (local HTTP)    │  HTML   │                         │  │
│  └──────────────────┘         └────────────┬────────────┘  │
│                                            │                │
└────────────────────────────────────────────┼────────────────┘
                                             │
                                             │ Upstox API calls
                                             │ (same-origin → no CORS)
                                             ▼
┌─────────────────────────────────────────────────────────────┐
│  CLOUDFLARE'S NETWORK (free, global)                        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  trading-studio-proxy.gsaurabh98.workers.dev          │  │
│  │  (cloudflare-worker.js)                               │  │
│  │                                                       │  │
│  │  • Forwards Authorization header                      │  │
│  │  • Sets browser-like User-Agent                       │  │
│  │  • Retries on transient failure (4x backoff)          │  │
│  │  • Uses Cloudflare's IPs, not yours                   │  │
│  └────────────────────────┬──────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  api.upstox.com                                             │
│  (Upstox's servers, sees a Cloudflare IP)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## What "permanently fixes" what

| Issue | Fix | File |
|---|---|---|
| `Failed to fetch` from CORS preflight | Same-origin via worker | `cloudflare-worker.js` |
| `Failed to fetch` from stale HTTP/2 | CF reuses warm connections | (built into CF) |
| Wifi blip dropping a request | 4-attempt backoff retry | `cloudflare-worker.js` + `server.py` |
| Cloudflare 1010 (bot UA block) | Browser-like User-Agent | `cloudflare-worker.js` + `server.py` |
| Cloudflare 1015 (per-IP rate limit) | CF IPs aren't rate-limited | `cloudflare-worker.js` |
| Self-DDoS via 100 parallel fetches | Concurrency cap (6) + 700ms debounce | `candlestick-patterns.html` |
| Slow timeframe revisits | Per-TF in-memory cache (8s fresh) | `candlestick-patterns.html` |
| SW caching live market data as stale | `/api/*` bypass in service worker | `sw.js` |

---

## Cost summary

| Service | Free tier | Your usage | Cost |
|---|---|---|---|
| Cloudflare Workers | 100k requests/day | ~15k/day | $0 |
| Cloudflare Pages | Unlimited | (not yet using) | $0 |
| Upstox API | Per their plan | Within limits | (per your Upstox plan) |
| GitHub | Unlimited public repos | Future hosting | $0 |

Total monthly cost: **$0**.

---

# Deployment to Cloudflare Pages (host the chart on the web)

This is **optional**. Right now your chart only runs from your laptop (`localhost:8000`). After this section, your chart lives at a public URL like `https://trading-studio.pages.dev/candlestick-patterns.html` and works from any device, anywhere — no laptop needed.

The Cloudflare Worker (which handles the API) keeps doing its job exactly the same — only the HTML/JS/CSS hosting changes.

## Why Cloudflare Pages

| Why | Detail |
|---|---|
| Free | Unlimited bandwidth, unlimited static sites |
| Private repos OK | Unlike GitHub Pages, free tier supports private repos |
| Same dashboard as worker | One Cloudflare account manages both |
| Auto-deploys on push | Every `git push` triggers a build automatically |
| HTTPS by default | No cert setup |
| Custom domain in 30 seconds | If you ever want `chart.yourname.com` |
| Global CDN | Page loads fast from anywhere |

## Prerequisites

- A GitHub account ([sign up](https://github.com/signup) if you don't have one — free)
- The Cloudflare account you already have (`gsaurabh98`)
- ~10 minutes for the first-time setup

---

## Step 1 — Prep the repo

### 1a. Create a `.gitignore`

In the project root, create `.gitignore` with:

```
# macOS
.DS_Store

# Python
.venv/
__pycache__/
*.pyc

# Node / Wrangler
node_modules/
.wrangler/

# Editors
.vscode/
.idea/
*.swp

# Local logs
*.log
```

This keeps junk out of the repo without affecting how the app runs.

### 1b. Initialize git and commit

```bash
cd /Users/saurabh.sharma2/Work/learning/candle-stick-pattern
git init
git add .
git status                # review what's about to be committed
git commit -m "Initial commit — Trading Studio"
```

---

## Step 2 — Push to GitHub

### 2a. Create the repo on GitHub

1. Go to [https://github.com/new](https://github.com/new)
2. Repository name: `trading-studio` (or anything)
3. Visibility: **Private** is fine (Cloudflare Pages handles private repos for free)
4. **Don't** initialize with README/license/gitignore (we already have files locally)
5. Click **Create repository**

### 2b. Push your code

GitHub will show you commands. Use the "push existing repository" set:

```bash
git remote add origin https://github.com/<YOUR_GITHUB_USERNAME>/trading-studio.git
git branch -M main
git push -u origin main
```

If GitHub asks for a password, use a **Personal Access Token** (not your account password):
- [https://github.com/settings/tokens/new](https://github.com/settings/tokens/new)
- Scopes: just `repo`
- Copy the token and paste it as the password

After this push, your code is on GitHub. Verify by visiting `https://github.com/<your-user>/trading-studio` — you should see all the files.

---

## Step 3 — Connect to Cloudflare Pages

1. Open **[https://dash.cloudflare.com/](https://dash.cloudflare.com/)**
2. In the left sidebar, click **Workers & Pages**
3. Click the **Create** button (top right)
4. Click the **Pages** tab
5. Click **Connect to Git**
6. Click **Connect GitHub** (if first time, authorize Cloudflare to read your repos — pick "Only select repositories" and pick `trading-studio`)
7. Pick `trading-studio` from the list, click **Begin setup**

## Step 4 — Build settings

Cloudflare asks for build settings. Since this is plain HTML (no compilation), use:

| Field | Value |
|---|---|
| Project name | `trading-studio` (becomes part of URL) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | (leave **empty**) |
| Build output directory | `/` (or leave empty) |
| Root directory (advanced) | (leave empty) |
| Environment variables | (none needed) |

Click **Save and Deploy**.

## Step 5 — First deploy

Cloudflare clones your repo and "builds" (no-op since there's no build command) — takes ~30–60 seconds. When it finishes, you'll see something like:

```
Success! Your project is live at:
  https://trading-studio.pages.dev
```

Visit that URL — it should serve your project root. To open the chart:

```
https://trading-studio.pages.dev/candlestick-patterns.html
```

## Step 6 — Activate the worker on the new URL

The localStorage entry only exists per-domain. So when you visit `trading-studio.pages.dev` for the first time, it doesn't know about your worker yet. Visit this once (note the `?cf_worker=...` part):

```
https://trading-studio.pages.dev/candlestick-patterns.html?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev
```

The page loads, saves the worker URL to localStorage, strips the query param. Console should show:
```
[chart] using Cloudflare Worker proxy: https://trading-studio-proxy.gsaurabh98.workers.dev
```

After this, just bookmark `https://trading-studio.pages.dev/candlestick-patterns.html` — it's permanently configured.

---

## Subsequent deploys (whenever you change code)

```bash
git add .
git commit -m "describe what you changed"
git push
```

Cloudflare detects the push, rebuilds, and deploys in ~30 seconds. No manual step needed.

You can watch the build in real time at [https://dash.cloudflare.com/](https://dash.cloudflare.com/) → Workers & Pages → trading-studio → Deployments.

## Local dev still works

Deploying doesn't replace local dev. You can keep using:

```bash
python3 server.py 8000
```

`localhost:8000` for development, `trading-studio.pages.dev` for "production" / mobile. Both auto-detect and use your Cloudflare Worker.

---

## Phone / multi-device after deploy

On any new device (your phone, your wife's laptop, an iPad), open this once:

```
https://trading-studio.pages.dev/candlestick-patterns.html?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev
```

Done. From then on the chart works on that device just by visiting the bookmark — no setup needed.

To install as a PWA on your phone (gets a home-screen icon):
- iOS: Safari → Share → Add to Home Screen
- Android: Chrome → menu → Install app

---

## Custom domain (optional, $0–$10/year)

If you ever want `chart.yourname.com` instead of `trading-studio.pages.dev`:

1. Buy a domain (Namecheap, Cloudflare Registrar, etc — typically $10/year)
2. Cloudflare dashboard → trading-studio → Custom domains → Set up a custom domain
3. Follow the DNS instructions (Cloudflare auto-provisions HTTPS)

Not needed for the chart to work — `pages.dev` is permanent and HTTPS already.

---

## Common issues

### "404 Not Found" when visiting `/candlestick-patterns.html`

Build output directory is wrong. Go to Pages → Settings → Build configuration → Build output directory should be `/` or empty.

### Service worker not updating

Service workers cache aggressively. After a deploy:
- Hard refresh: Cmd+Shift+R (twice)
- Or DevTools → Application → Service Workers → Unregister, then reload

### "Token expired" right after deploy

Token is in localStorage which is per-domain. The token you set on `localhost:8000` does NOT carry over to `trading-studio.pages.dev`. Re-paste the token in the gear icon on the deployed URL.

### Worker not picking up calls

Same as above — the `cf_worker_url` in localStorage is per-domain. Re-visit with `?cf_worker=https://trading-studio-proxy.gsaurabh98.workers.dev` once on the new domain.

### Need to roll back a bad deploy

Cloudflare keeps every deployment. Pages → trading-studio → Deployments → click the last good one → **Rollback to this deployment**. Instant.

### Want to delete everything

Cloudflare Pages → trading-studio → Settings → scroll to bottom → Delete project. The worker stays (separate thing). Your GitHub repo stays (separate thing).

---

## Updated component map after deploy

```
USERS (any device, anywhere)
   │
   ▼
trading-studio.pages.dev          ← Cloudflare Pages (free, global CDN)
  • serves HTML / JS / CSS / SW
  • auto-deploys on every git push
   │
   ▼
Browser runs the chart code
   │
   ▼ Upstox API calls
trading-studio-proxy.gsaurabh98.workers.dev   ← Cloudflare Worker
   │
   ▼
api.upstox.com
```

Your laptop is no longer in the picture for serving the chart. It's only used for editing code and `git push`.

---

## What you keep on your laptop after deploy

- The git repo (for editing + pushing)
- `python3 server.py 8000` (still useful for local dev / fast iteration without push-and-wait)
- Wrangler CLI (only if you want to update the worker)

Everything else lives in the cloud and costs $0.
