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

import json
import sys
import threading
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Final
from urllib import request as urlreq
from urllib.error import HTTPError, URLError

UPSTOX_HOST: Final[str] = "https://api.upstox.com"
PROXY_PREFIX: Final[str] = "/api"
# Angel One SmartAPI — proxied so the browser never has to deal with CORS or
# hold the API key. Stage-1 use is read-only market data (historical candles).
ANGEL_HOST: Final[str] = "https://apiconnect.angelone.in"
ANGEL_PREFIX: Final[str] = "/angel"
ANGEL_CREDS_PATH: Final[Path] = Path(__file__).resolve().parent / "data" / "angel-one-creds.json"
# ── Local persistence (intraday paper-trading book) ──────────────────────────
# The intraday paper-trading sandbox mirrors its book to a JSON file on disk so
# it survives a browser "clear cache / storage" (localStorage alone would be
# wiped). GET reads it back on load; POST overwrites it on every save. This is a
# DEV-only durability layer — it only works while server.py is running locally;
# a deployed static PWA has no server and falls back to localStorage.
LOCAL_PREFIX: Final[str] = "/local"
_DATA_DIR: Final[Path] = Path(__file__).resolve().parent / "data"
# Allow-list of durable local JSON stores: request path -> on-disk file. Only
# these exact paths are readable/writable via /local/* (no arbitrary file write).
LOCAL_FILES: Final[dict[str, Path]] = {
    "/local/intraday-trades": _DATA_DIR / "intraday-paper-trades.json",
    "/local/intraday-journal": _DATA_DIR / "intraday-signal-journal.json",
    "/local/intraday-journal-archive": _DATA_DIR / "intraday-journal-archive.json",
}
# Reject absurdly large bodies (a corrupt/looping client) — a paper book is tiny.
MAX_LOCAL_BODY_BYTES: Final[int] = 2_000_000
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
    """Immutable response payload returned to the browser.

    ``retry_after`` is the upstream ``Retry-After`` header in **seconds** (0 if
    absent). Cloudflare returns it alongside its ``429 error code: 1015`` edge
    rate-limit page on the ``/v3/historical-candle/`` path; the historical-candle
    gate (see below) honours it so we stop re-arming the penalty window.
    """

    status: int
    content_type: str
    body: bytes
    retry_after: int = 0


def _parse_retry_after(raw: str | None) -> int:
    """Parse a ``Retry-After`` header value into whole seconds.

    Cloudflare sends a plain integer (e.g. ``66``). The HTTP-date form is not
    used by Cloudflare's rate-limit page, so we only handle the integer form and
    fall back to 0 on anything unparseable.
    """
    if not raw:
        return 0
    try:
        return max(0, int(raw.strip()))
    except (ValueError, AttributeError):
        return 0


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
                retry_after=_parse_retry_after(e.headers.get("Retry-After") if e.headers else None),
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


# ─── Historical-candle gate (Cloudflare 1015 avoidance) ────────────────────
# WHY THIS EXISTS
# ----------------
# api.upstox.com sits behind Cloudflare. The ``/v3/historical-candle/`` path
# has a STRICT per-CLIENT-IP edge rate limit that is far tighter than Upstox's
# documented API budget (50/s, 500/min). When the app loads, several modules
# (live chart, swing scanner, intraday analyzer, India-VIX) each fire a burst
# of candle requests within ~1s. That burst trips Cloudflare's rule, which
# replies ``429  error code: 1015  Retry-After: 66`` — and because the block is
# keyed by IP (not by the Upstox token), switching accounts/tokens does NOTHING.
# Worse: every request sent DURING the 66s penalty RE-ARMS the timer, so it
# never clears and the user sees a permanent "rate limited" wall.
#
# This gate is the single funnel (all modules proxy through here on localhost),
# so fixing it here fixes every caller at once. Three mechanisms:
#   1. CACHE  — closed/old candle ranges are immutable; fetch once, reuse.
#               This collapses the load-time burst of identical requests.
#   2. SPACE the DISPATCHES — successive candle requests are released to Upstox
#               at least ``HIST_MIN_GAP_SEC`` apart, so a burst becomes a steady
#               trickle that stays under Cloudflare's per-second edge rule. The
#               spacing lock is held ONLY across the tiny gap-sleep, NOT across
#               the (slow) upstream round-trip — so the network calls themselves
#               overlap. Holding it across the whole round-trip (the original
#               behaviour) made every request wait for the previous one's full
#               network latency, turning a multi-timeframe page load into a 20s+
#               crawl. What Cloudflare rate-limits is the SEND rate, not how many
#               calls are concurrently in flight, so spacing-only is both safe
#               and far faster.
#   3. NON-RE-ARMING COOLDOWN — on a 429 we honour ``Retry-After`` and send NO
#               further candle requests upstream until it expires (serving the
#               last-known cached answer instead). That lets the window actually
#               clear instead of constantly resetting it.
#
# Scope: ONLY ``/v3/historical-candle/``. Live-price (V2 market-quote/ltp),
# option-chain, and contract calls are unaffected — they were never the problem
# (they returned 200 throughout) and stay on the plain ``fetch_upstream`` path.
HIST_PREFIX: Final[str] = "/v3/historical-candle/"
# Minimum gap between two candle requests actually sent upstream. ~0.34s ≈ 3/s
# sustained — comfortably under Cloudflare's edge rule while still loading a
# multi-timeframe page in a few seconds (caching collapses most duplicates).
HIST_MIN_GAP_SEC: Final[float] = 0.34
# Clamp a (possibly hostile / absurd) Retry-After into a sane band so a bad
# upstream value can neither stall us for an hour nor be effectively ignored.
HIST_COOLDOWN_MIN_SEC: Final[float] = 5.0
HIST_COOLDOWN_MAX_SEC: Final[float] = 120.0
HIST_COOLDOWN_FALLBACK_SEC: Final[float] = 66.0  # used if a 429 omits Retry-After
# Cache TTLs. Immutable = the range ends before today (IST): those candles can
# never change, so cache them for the whole session. A range that ends TODAY
# still has a forming last bar — cache it briefly to absorb the load burst, but
# refresh within a minute. The signal engines anchor on CONFIRMED bars only and
# drop the forming candle, so a sub-minute-stale last bar can't shift a verdict.
HIST_TTL_IMMUTABLE_SEC: Final[float] = 6 * 3600.0
HIST_TTL_TODAY_SEC: Final[float] = 45.0
HIST_TTL_INTRADAY_SEC: Final[float] = 6.0

_IST: Final[timezone] = timezone(timedelta(hours=5, minutes=30))

# Shared mutable state — guarded by the locks below. ``_hist_state_lock`` is
# held only for fast dict/field reads + writes; ``_hist_send_lock`` is held
# across the actual upstream call so candle requests serialize to one-at-a-time.
_hist_state_lock: Final[threading.Lock] = threading.Lock()
_hist_send_lock: Final[threading.Lock] = threading.Lock()
_hist_blocked_until: float = 0.0   # wall-clock ts; no candle call may go out before this
_hist_last_sent: float = 0.0       # wall-clock ts of the last upstream candle send
# path -> (expires_at_ts, result). We keep the entry even after it expires so a
# cooldown can serve the last-known answer as a graceful fallback (stale beats a
# hard error, and only ever a slightly-stale forming bar — see TTL note above).
_hist_cache: Final[dict[str, tuple[float, UpstreamResult]]] = {}


def _ist_today() -> date:
    """Today's date in Indian Standard Time (the market's timezone)."""
    return datetime.now(_IST).date()


def _hist_ttl_sec(upstream_path: str) -> float:
    """Cache TTL for a historical-candle path (0 = do not cache).

    Two URL shapes from Upstox V3::

        /v3/historical-candle/intraday/{key}/{unit}/{interval}        (forming)
        /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}     (dated)

    The dated form is immutable when ``{to}`` is before today (IST). Unknown
    shapes are not cached (TTL 0) — fail safe rather than serve a guess.
    """
    parts = upstream_path.split("/")
    # parts[0] == '' (leading slash); parts[1]='v3'; parts[2]='historical-candle'
    if len(parts) >= 4 and parts[3] == "intraday":
        return HIST_TTL_INTRADAY_SEC
    try:
        to_seg = parts[-2]
        to_d = datetime.strptime(to_seg, "%Y-%m-%d").date()
    except (ValueError, IndexError):
        return 0.0
    return HIST_TTL_IMMUTABLE_SEC if to_d < _ist_today() else HIST_TTL_TODAY_SEC


def _hist_cooldown_result(remaining_sec: float) -> UpstreamResult:
    """A fast local 429 returned during a Cloudflare cooldown (no network hit).

    The browser's shared rate-limit gate (``_upstoxNote429``) already knows how
    to back off on a 429, so this keeps the client in step without our ever
    touching Cloudflare and re-arming its penalty timer.
    """
    rem = max(1, int(remaining_sec + 0.999))
    body = (
        b'{"proxy_rate_limit":"historical-candle cooldown",'
        b'"detail":"upstream (Cloudflare) rate-limited this IP; holding off to let it clear",'
        b'"retry_after":' + str(rem).encode("ascii") + b"}"
    )
    return UpstreamResult(status=429, content_type="application/json", body=body, retry_after=rem)


def fetch_hist(upstream_path: str, auth: str | None, accept: str) -> UpstreamResult:
    """Fetch a historical-candle range through the cache + throttle + cooldown gate.

    Order of operations (cheapest / safest first):

    1. **Fresh cache hit** → return immediately, no lock contention with sends.
    2. **In cooldown** → never call upstream. Serve a cached answer (even if
       expired) if we have one, else a fast local 429.
    3. **Reserve a dispatch slot** (under ``_hist_send_lock``, only across the
       gap-sleep): re-check cache + cooldown (a queued sibling may have filled /
       armed them), then space this send ``HIST_MIN_GAP_SEC`` after the previous
       one and record the DISPATCH time. The lock is then RELEASED.
    4. **Make the upstream call with the lock released** so concurrent
       round-trips overlap (the spacing already bounds the send rate). On 429 →
       arm the cooldown from ``Retry-After`` (only if not already cooling, so a
       burst of in-flight requests can't keep re-arming it) and fall back to any
       cached answer. On 200 → cache it.
    """
    global _hist_blocked_until, _hist_last_sent

    ttl = _hist_ttl_sec(upstream_path)
    now = time.time()

    # 1) Fresh cache.
    if ttl > 0:
        with _hist_state_lock:
            ent = _hist_cache.get(upstream_path)
            if ent is not None and ent[0] > now:
                return ent[1]

    # 2) Cooldown fast-path — do NOT hit upstream.
    with _hist_state_lock:
        if time.time() < _hist_blocked_until:
            ent = _hist_cache.get(upstream_path)
            remaining = _hist_blocked_until - time.time()
            return ent[1] if ent is not None else _hist_cooldown_result(remaining)

    # 3) Reserve a spaced dispatch slot. The send lock is held ONLY across the
    #    gap-sleep + timestamp write — NOT across the upstream round-trip — so
    #    candle requests are released to Cloudflare >= HIST_MIN_GAP_SEC apart
    #    while their (slow) network calls still overlap.
    gap = 0.0
    with _hist_send_lock:
        with _hist_state_lock:
            ent = _hist_cache.get(upstream_path)
            if ttl > 0 and ent is not None and ent[0] > time.time():
                return ent[1]  # a queued sibling already fetched this range
            now = time.time()
            if now < _hist_blocked_until:
                return ent[1] if ent is not None else _hist_cooldown_result(_hist_blocked_until - now)
            gap = _hist_last_sent + HIST_MIN_GAP_SEC - now
        if gap > 0:
            time.sleep(gap)
        # Record the DISPATCH time (before the call returns), so the NEXT queued
        # thread spaces off when we sent, not when we finished.
        with _hist_state_lock:
            _hist_last_sent = time.time()

    # 4) Upstream call with the send lock RELEASED → round-trips overlap.
    res = fetch_upstream(upstream_path, auth, accept)

    with _hist_state_lock:
        if res.status == 429:
            # Only ARM the cooldown if we aren't already cooling. The handful of
            # requests that were already in flight when the first 429 landed
            # would otherwise each re-arm the timer and it would never clear.
            if time.time() >= _hist_blocked_until:
                cool = res.retry_after or HIST_COOLDOWN_FALLBACK_SEC
                cool = min(max(float(cool), HIST_COOLDOWN_MIN_SEC), HIST_COOLDOWN_MAX_SEC)
                _hist_blocked_until = time.time() + cool
            stale = _hist_cache.get(upstream_path)
            if stale is not None:
                return stale[1]  # serve last-known instead of a hard error
        elif res.status == 200 and ttl > 0:
            _hist_cache[upstream_path] = (time.time() + ttl, res)
    return res


# ─── Angel One SmartAPI proxy ──────────────────────────────────────────────


@lru_cache(maxsize=1)
def _angel_api_key() -> str | None:
    """Read the SmartAPI key from data/angel-one-creds.json (cached).

    SmartAPI requires ``X-PrivateKey: <api_key>`` on every authenticated call —
    not just the JWT. We inject it server-side so the key never reaches the
    browser. Returns ``None`` if the creds file is missing / malformed, in
    which case the proxy responds 400 with a clear message.
    """
    try:
        raw = json.loads(ANGEL_CREDS_PATH.read_text())
        key = str(raw.get("api_key", "")).strip()
        return key or None
    except Exception:
        return None


def _build_angel_request(
    upstream_path: str, auth: str | None, method: str, body: bytes
) -> urlreq.Request:
    """Construct a SmartAPI Request with the mandatory header set.

    The browser only sends ``Authorization: Bearer <JWT>``; we add the API key
    + the fixed SmartAPI headers here. Client IP / MAC are placeholders (the
    same ones the login script uses) — SmartAPI accepts them for personal use.
    """
    headers: dict[str, str] = {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": "127.0.0.1",
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": _angel_api_key() or "",
    }
    if auth:
        headers["Authorization"] = auth
    data = body if method == "POST" else None
    return urlreq.Request(
        ANGEL_HOST + upstream_path, data=data, headers=headers, method=method
    )


def fetch_angel(
    upstream_path: str, auth: str | None, method: str, body: bytes
) -> UpstreamResult:
    """Forward a GET/POST to Angel One SmartAPI with backoff retry.

    Mirrors :func:`fetch_upstream`: 4xx/5xx pass through untouched, connection
    errors retry. A missing API key short-circuits to a 400 so the UI can tell
    the user to create ``data/angel-one-creds.json`` and run the auth script.
    """
    if not _angel_api_key():
        return UpstreamResult(
            status=400,
            content_type="application/json",
            body=(
                b'{"proxy_error":"missing Angel One API key",'
                b'"detail":"create data/angel-one-creds.json with an api_key '
                b'and run scripts/angel-one-auth.py"}'
            ),
        )

    last_err: Exception | None = None
    for delay in RETRY_BACKOFFS_SEC:
        if delay > 0:
            time.sleep(delay)
        req = _build_angel_request(upstream_path, auth, method, body)
        try:
            with urlreq.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
                return UpstreamResult(
                    status=resp.status,
                    content_type=resp.headers.get("Content-Type", "application/json"),
                    body=resp.read(),
                )
        except HTTPError as e:
            try:
                eb = e.read()
            except Exception:
                eb = b'{"error":"upstream returned an error response"}'
            return UpstreamResult(
                status=e.code,
                content_type=e.headers.get("Content-Type", "application/json")
                if e.headers
                else "application/json",
                body=eb,
            )
        except URLError as e:
            last_err = e
            continue
        except Exception as e:
            last_err = e
            break

    msg = str(last_err) if last_err is not None else "unknown error"
    detail = (
        b'{"proxy_error":"angel upstream unreachable after retries","detail":'
        + repr(msg).encode("utf-8", errors="replace")
        + b"}"
    )
    return UpstreamResult(status=502, content_type="application/json", body=detail)


# ─── Local intraday paper-trade persistence ────────────────────────────────


def read_local(target: Path) -> UpstreamResult:
    """Return a durable local JSON store as JSON.

    Missing file → ``200 {}`` (a fresh store, not an error). A read failure is a
    500 but never blocks the app — the browser degrades to localStorage.
    """
    try:
        raw = target.read_bytes()
        return UpstreamResult(status=200, content_type="application/json", body=raw)
    except FileNotFoundError:
        return UpstreamResult(status=200, content_type="application/json", body=b"{}")
    except OSError as e:
        body = (
            b'{"local_error":"failed to read local store","detail":'
            + repr(str(e)).encode("utf-8", errors="replace")
            + b"}"
        )
        return UpstreamResult(status=500, content_type="application/json", body=body)


def write_local(target: Path, body: bytes) -> UpstreamResult:
    """Persist a durable local JSON store to disk (atomic replace).

    The body must be valid JSON (parsed to reject garbage before it clobbers a
    good store). Written via a temp file + ``os.replace`` so a crash mid-write
    can never leave a truncated, unparseable file on disk.
    """
    if len(body) > MAX_LOCAL_BODY_BYTES:
        return UpstreamResult(
            status=413,
            content_type="application/json",
            body=b'{"local_error":"payload too large"}',
        )
    try:
        json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        body_err = (
            b'{"local_error":"body is not valid JSON","detail":'
            + repr(str(e)).encode("utf-8", errors="replace")
            + b"}"
        )
        return UpstreamResult(status=400, content_type="application/json", body=body_err)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".json.tmp")
        tmp.write_bytes(body)
        tmp.replace(target)
        return UpstreamResult(
            status=200, content_type="application/json", body=b'{"ok":true}'
        )
    except OSError as e:
        body_err = (
            b'{"local_error":"failed to write local store","detail":'
            + repr(str(e)).encode("utf-8", errors="replace")
            + b"}"
        )
        return UpstreamResult(status=500, content_type="application/json", body=body_err)


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

    def end_headers(self) -> None:
        # Dev server: never let the browser's HTTP cache hold a stale static
        # asset. Forces revalidation so edits to the HTML shell, JS, CSS,
        # sw.js and content/*.html show up on the next reload — and so the
        # service worker's network-first navigation + its 60s update check
        # always pull fresh bytes instead of a cached shell. API responses
        # set their own Cache-Control (no-store) in do_GET below; don't
        # clobber that, so we only inject for static files.
        if not self.path.startswith(PROXY_PREFIX + "/"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _write_result(self, res: UpstreamResult) -> None:
        """Send an UpstreamResult back to the browser (proxy responses)."""
        self.send_response(res.status)
        self.send_header("Content-Type", res.content_type)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(res.body)
        except (BrokenPipeError, ConnectionResetError):
            # The browser aborted the request before we finished writing
            # (normal when the app cancels a stale fetch on a rapid
            # timeframe / stock switch). Nothing to recover — swallow it
            # so the terminal isn't flooded with misleading tracebacks.
            pass

    def _read_body(self) -> bytes:
        """Read the full request body (for proxied POSTs)."""
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def do_GET(self) -> None:
        local_file = LOCAL_FILES.get(self.path)
        if local_file is not None:
            self._write_result(read_local(local_file))
            return
        if self.path.startswith(ANGEL_PREFIX + "/"):
            self._write_result(
                fetch_angel(
                    self.path[len(ANGEL_PREFIX):],
                    auth=self.headers.get("Authorization"),
                    method="GET",
                    body=b"",
                )
            )
            return
        if self.path.startswith(PROXY_PREFIX + "/"):
            upstream_path = self.path[len(PROXY_PREFIX):]
            auth = self.headers.get("Authorization")
            accept = self.headers.get("Accept", "application/json")
            # Candle history goes through the cache/throttle/cooldown gate that
            # avoids Cloudflare's per-IP 1015 edge limit; everything else (live
            # quotes, option chain, contracts) takes the plain pass-through path.
            if upstream_path.startswith(HIST_PREFIX):
                self._write_result(fetch_hist(upstream_path, auth, accept))
            else:
                self._write_result(fetch_upstream(upstream_path, auth, accept))
            return
        super().do_GET()

    def do_POST(self) -> None:
        # Durable local JSON stores (intraday paper book + signal journal).
        local_file = LOCAL_FILES.get(self.path)
        if local_file is not None:
            self._write_result(write_local(local_file, self._read_body()))
            return
        # Only the Angel One proxy needs POST (SmartAPI getCandleData et al.).
        # Upstox's endpoints we use are all GET, so anything else is rejected.
        if self.path.startswith(ANGEL_PREFIX + "/"):
            self._write_result(
                fetch_angel(
                    self.path[len(ANGEL_PREFIX):],
                    auth=self.headers.get("Authorization"),
                    method="POST",
                    body=self._read_body(),
                )
            )
            return
        self.send_error(405, "Method Not Allowed")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(("", port), _StudioHandler)
    print(f"Trading Studio dev server on http://localhost:{port}")
    print(f"  Static files:  ./")
    print(f"  API proxy:     /api/v2/* -> https://api.upstox.com/v2/*")
    print(f"                 /api/v3/* -> https://api.upstox.com/v3/*")
    angel_ready = "ready" if _angel_api_key() else "NO api_key (see data/angel-one-creds.json)"
    print(f"  Angel proxy:   /angel/*  -> https://apiconnect.angelone.in/*  [{angel_ready}]")
    for _lp, _lf in LOCAL_FILES.items():
        print(f"  Local store:   {_lp}  <-> data/{_lf.name}")
    print(f"  Stop:          Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
