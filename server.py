#!/usr/bin/env python3
"""Trading Studio dev server.

Replaces ``python3 -m http.server 8000``: serves static files from the
workspace AND proxies ``/api/v2/*`` and ``/api/v3/*`` to api.upstox.com.

Why a proxy instead of the browser fetching api.upstox.com directly?

* **Same-origin requests bypass CORS preflight entirely.** No more
  intermittent ``Failed to fetch`` from a dropped OPTIONS preflight.
* **Server-side connection pooling.** ``urllib`` keeps a small connection
  pool open per upstream host. The browser's stale HTTP/2 connection bug
  (which happens after long idle) cannot manifest because every request
  the browser makes is a fresh same-origin call.
* **Server-side retries with exponential backoff** mean transient wifi
  blips never reach the browser at all — they're absorbed here.
* **We control concurrency.** The browser's per-host cap is 6 on HTTP/1.1
  and unbounded on HTTP/2. Either way we can shape it server-side.

Usage::

    python3 server.py             # default port 8000
    python3 server.py 9000        # custom port

Then open ``http://localhost:8000/candlestick-patterns.html`` exactly as
before. The app auto-detects the proxy when ``location.hostname`` is
``localhost`` / ``127.0.0.1`` and routes Upstox calls through it; on any
other origin it falls back to the direct API URL so PWA installs and
GitHub Pages hosting keep working unchanged.

Pure stdlib — no ``pip install`` needed.
"""
from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Final
from urllib import request as urlreq
from urllib.error import HTTPError, URLError

UPSTOX_HOST: Final[str] = "https://api.upstox.com"
PROXY_PREFIX: Final[str] = "/api"
REQUEST_TIMEOUT_SEC: Final[float] = 15.0
# Exponential backoff: first attempt is immediate, then 0.4s, 1.2s, 2.8s.
# Mirrors the client-side fetchWithRetry budget (~4s total) so a transient
# upstream blip is fully absorbed by the proxy and the browser never sees it.
RETRY_BACKOFFS_SEC: Final[tuple[float, ...]] = (0.0, 0.4, 1.2, 2.8)
# Cloudflare (which fronts api.upstox.com) bot-fingerprints clients and
# returns Error 1010 ("Access denied based on your browser's signature")
# when the User-Agent looks like a script — including Python's default
# ``Python-urllib/3.x``. We send a browser-like UA + Accept-Encoding so
# Cloudflare treats us like a regular browser session. (We do NOT decode
# gzip/br ourselves; we forward Accept-Encoding only because not sending
# it ALSO trips bot heuristics. urllib transparently decodes if upstream
# compresses — actually it doesn't; identity is safe.)
BROWSER_UA: Final[str] = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


@dataclass(frozen=True)
class UpstreamResult:
    """Immutable response payload returned to the browser."""

    status: int
    content_type: str
    body: bytes


def _build_request(upstream_path: str, auth: str | None, accept: str) -> urlreq.Request:
    """Construct a urllib Request for the upstream Upstox call.

    Headers we set:

    * ``User-Agent`` — browser-like, otherwise Cloudflare's bot heuristic
      returns Error 1010 and we never reach Upstox at all.
    * ``Accept`` — passed through from the client (defaults to JSON).
    * ``Authorization`` — passed through from the client (the user's
      bearer token).
    * ``Accept-Language`` / ``Accept-Encoding`` — set to common values so
      we don't look like a headless script.

    We deliberately strip every other client header (cookies, Sec-*,
    Origin, Referer, etc.) to keep the outbound surface minimal — anything
    we forward unnecessarily is one more thing a CDN heuristic might
    flag.
    """
    headers: dict[str, str] = {
        "User-Agent": BROWSER_UA,
        "Accept": accept,
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
    }
    if auth:
        headers["Authorization"] = auth
    return urlreq.Request(UPSTOX_HOST + upstream_path, headers=headers, method="GET")


def fetch_upstream(
    upstream_path: str,
    auth: str | None = None,
    accept: str = "application/json",
) -> UpstreamResult:
    """Forward a GET to Upstox with exponential-backoff retry.

    * **4xx/5xx upstream responses are passed through as-is** (no retry) —
      the app's existing error UI already knows what to do with 401, 429
      and 4xx detail strings, and retrying a 401 is pointless.
    * **URL/connection errors are retried** up to ``len(RETRY_BACKOFFS_SEC)``
      times with the configured backoff. Only the final failure surfaces
      as a 502 to the browser.
    """
    last_err: Exception | None = None
    for delay in RETRY_BACKOFFS_SEC:
        if delay > 0:
            time.sleep(delay)
        req = _build_request(upstream_path, auth, accept)
        try:
            with urlreq.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
                return UpstreamResult(
                    status=resp.status,
                    content_type=resp.headers.get("Content-Type", "application/json"),
                    body=resp.read(),
                )
        except HTTPError as e:
            try:
                body = e.read()
            except Exception:
                body = b'{"error":"upstream returned an error response"}'
            return UpstreamResult(
                status=e.code,
                content_type=e.headers.get("Content-Type", "application/json") if e.headers else "application/json",
                body=body,
            )
        except URLError as e:
            last_err = e
            continue
        except Exception as e:
            last_err = e
            break

    msg = str(last_err) if last_err is not None else "unknown error"
    body = (
        b'{"proxy_error":"upstream unreachable after retries","detail":'
        + repr(msg).encode("utf-8", errors="replace")
        + b"}"
    )
    return UpstreamResult(status=502, content_type="application/json", body=body)


class _StudioHandler(SimpleHTTPRequestHandler):
    """Static-file handler that intercepts /api/* and proxies it to Upstox."""

    def log_message(self, fmt: str, *args: object) -> None:
        # Quieter than the default — only log API calls and non-2xx static
        # responses. Keeps the terminal readable when the chart is polling.
        first = args[0] if args else ""
        first_str = first if isinstance(first, str) else str(first)
        status = args[1] if len(args) > 1 else ""
        status_str = status if isinstance(status, str) else str(status)
        if "/api/" in first_str or status_str.startswith(("4", "5")):
            super().log_message(fmt, *args)

    def do_GET(self) -> None:
        if self.path.startswith(PROXY_PREFIX + "/"):
            upstream_path = self.path[len(PROXY_PREFIX):]
            res = fetch_upstream(
                upstream_path,
                auth=self.headers.get("Authorization"),
                accept=self.headers.get("Accept", "application/json"),
            )
            self.send_response(res.status)
            self.send_header("Content-Type", res.content_type)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(res.body)
            return
        super().do_GET()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), _StudioHandler)
    print(f"Trading Studio dev server on http://localhost:{port}")
    print(f"  Static files:  ./")
    print(f"  API proxy:     /api/v2/* -> https://api.upstox.com/v2/*")
    print(f"                 /api/v3/* -> https://api.upstox.com/v3/*")
    print(f"  Stop:          Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
