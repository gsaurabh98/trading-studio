/**
 * Trading Studio — Upstox API proxy (Cloudflare Worker)
 *
 * Deployed to Cloudflare Workers (free tier: 100,000 requests/day, plenty
 * for a personal trading app). Routes /api/v2/* and /api/v3/* to
 * api.upstox.com from Cloudflare's edge IPs.
 *
 * Why this and not the local server.py?
 * ─────────────────────────────────────
 *   • api.upstox.com sits behind Cloudflare's bot/rate-limit protection.
 *   • When you hammer V3 historical-candle from a residential IP (e.g.
 *     during rapid timeframe switches with VOL aggregation enabled),
 *     Cloudflare returns Error 1015 — "rate-limited by the website
 *     owner" — for that IP for ~10–15 minutes.
 *   • A local proxy still uses YOUR IP, so it can't help.
 *   • Cloudflare Workers run on Cloudflare's own network. The IPs are
 *     trusted by Cloudflare's rate-limiter (it's the same company).
 *     Per-IP throttling effectively never triggers.
 *
 * Deploy in 3 commands:
 * ─────────────────────
 *   1. npm install -g wrangler        (one-time, installs CF CLI)
 *   2. wrangler login                  (one-time, opens browser)
 *   3. wrangler deploy cloudflare-worker.js --name trading-studio-proxy
 *
 * You'll get a URL like:
 *   https://trading-studio-proxy.<your-cf-username>.workers.dev
 *
 * Then in the browser DevTools console of the app:
 *   localStorage.setItem('cf_worker_url',
 *     'https://trading-studio-proxy.<your-username>.workers.dev');
 *   location.reload();
 *
 * From that point on, every Upstox call goes through the worker. The
 * "Failed to fetch" / "rate-limited" / "1015" / "1010" error class is
 * structurally gone — same-origin call from the browser to the worker,
 * worker calls Upstox from a trusted IP that never gets throttled.
 *
 * Free tier ceiling: 100,000 requests/day. A trading session at 2s
 * polling for 6.5 hours = ~12,000 requests. You will not hit the cap.
 */

const UPSTOX = 'https://api.upstox.com';

// Mirrors the local proxy's backoff: 4 attempts at 0/0.4s/1.2s/2.8s.
// Server-side retry that's invisible to the browser — wifi blips and
// transient 5xxs from Upstox are absorbed here.
const RETRY_BACKOFFS_MS = [0, 400, 1200, 2800];

// Browser-like User-Agent so Cloudflare's bot fingerprinter doesn't
// return Error 1010. Same UA as server.py.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight — answer it ourselves so the browser doesn't have
    // to round-trip a real OPTIONS to Upstox (which it would reject).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // We only handle /api/v2/* and /api/v3/* — anything else is a 404.
    const match = url.pathname.match(/^\/api\/(v[23])\/(.+)$/);
    if (!match) {
      return jsonResponse({ error: 'not found', hint: 'try /api/v2/... or /api/v3/...' }, 404, request);
    }

    const upstreamUrl = `${UPSTOX}/${match[1]}/${match[2]}${url.search}`;

    // Build outbound headers: forward only what Upstox needs. Strips
    // cookies, Sec-* headers, and anything else that might trip
    // Cloudflare's heuristics.
    const headers = new Headers();
    headers.set('User-Agent', BROWSER_UA);
    headers.set('Accept', request.headers.get('Accept') || 'application/json');
    headers.set('Accept-Language', 'en-US,en;q=0.9');
    const auth = request.headers.get('Authorization');
    if (auth) headers.set('Authorization', auth);

    // Retry loop. 4xx/5xx responses are passed through unchanged — the
    // app's existing error UI knows how to surface 401, 429, etc. Only
    // genuine network errors (TypeError from fetch) get retried.
    let lastErr = null;
    for (const delay of RETRY_BACKOFFS_MS) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        const upstreamResp = await fetch(upstreamUrl, {
          method: 'GET',
          headers,
          // Don't let CF's edge cache pollute live market data.
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        // Read body once, replay it with our CORS + cache-control headers.
        const body = await upstreamResp.arrayBuffer();
        const respHeaders = new Headers(corsHeaders(request));
        respHeaders.set(
          'Content-Type',
          upstreamResp.headers.get('Content-Type') || 'application/json',
        );
        respHeaders.set('Cache-Control', 'no-store');
        return new Response(body, { status: upstreamResp.status, headers: respHeaders });
      } catch (e) {
        lastErr = e;
        // Continue to next backoff — only TypeErrors land here, and only
        // for network-level failures.
      }
    }

    return jsonResponse(
      {
        proxy_error: 'upstream unreachable after retries',
        detail: String(lastErr || 'unknown'),
      },
      502,
      request,
    );
  },
};

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Accept, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(payload, status, request) {
  const headers = new Headers(corsHeaders(request));
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(payload), { status, headers });
}
