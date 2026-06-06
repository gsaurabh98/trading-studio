// Live option-chain module — Upstox chain fetch, OI bias scoring,
// support/resistance wall visualisation, 1Hz LTP poller, API token modal.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script
// src> in the SAME document position (classic script), so the chain's
// window.* exposures stay global for the inline handlers in content/chain.html
// + the API modal, with unchanged init timing. References to other modules
// (paper-trade / chart) are call-time only.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

(function liveChainModule() {
  function $(id) { return document.getElementById(id); }

  // Chain module-local state. Holds the running set of keys that the
  // 1Hz LTP poller is watching, plus the "last LTP tick at" timestamp
  // and the setInterval handle that drives the LIVE pill's "Xs ago"
  // label. These fields are referenced ungated throughout this IIFE
  // (renderChain, pollOptionPrices, startChainLiveTicker, etc.) so
  // they MUST exist before any code path runs — otherwise we get
  // ReferenceError: state is not defined. The values are mutated in
  // place; never reassigned.
  var state = {
    chainTableLtpKeys: [],
    chainLastLtpTickTs: 0,
    chainLiveTickerTimer: null
  };

  var INSTRUMENT_KEYS = {
    'NIFTY': 'NSE_INDEX|Nifty 50',
    'BANKNIFTY': 'NSE_INDEX|Nifty Bank',
    'SENSEX': 'BSE_INDEX|SENSEX'
  };
  // Mirror the same routing logic used by the chart module:
  // CF Worker (if configured) > local proxy (on localhost) > direct.
  // See the chart module for the full explanation.
  var BASE = (function () {
    try {
      var cfUrl = (localStorage.getItem('cf_worker_url') || '').trim().replace(/\/+$/, '');
      if (cfUrl) return cfUrl + '/api/v2';
      var h = (location.hostname || '').toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return '/api/v2';
    } catch (_) { /* fall through to direct */ }
    return 'https://api.upstox.com/v2';
  })();

  function setStatus(msg, type) {
    var el = $('up-status');
    if (!el) return;
    el.style.display = 'block';
    el.className = 'up-status up-status-' + (type || 'neutral');
    el.innerHTML = msg;
  }

  function loadToken() {
    try {
      var t = localStorage.getItem('upstox_token');
      if (t && $('up-token')) $('up-token').value = t;
    } catch (_) { /* private mode / storage disabled — silently noop */ }
  }

  function saveToken() {
    var t = ($('up-token').value || '').trim();
    if (!t) { setStatus('Enter a token first.', 'err'); return; }
    try {
      localStorage.setItem('upstox_token', t);
      setStatus('&#10003; Token saved to your browser. Will persist across visits until you click CLEAR.', 'ok');
    } catch (e) {
      setStatus('Could not save token \u2014 your browser may be in private mode or storage is disabled. Token will work for this session only.', 'err');
    }
    if (typeof window._swUpdateApiPill === 'function') window._swUpdateApiPill();
    if (typeof window._apiSetupRefresh === 'function') window._apiSetupRefresh();
    var setupInp = document.getElementById('api-setup-token');
    if (setupInp) setupInp.value = t;
  }

  function clearTok() {
    try { localStorage.removeItem('upstox_token'); } catch (_) { }
    if ($('up-token')) $('up-token').value = '';
    setStatus('Token cleared from your browser.', 'neutral');
    if (typeof window._swUpdateApiPill === 'function') window._swUpdateApiPill();
    if (typeof window._apiSetupRefresh === 'function') window._apiSetupRefresh();
    var setupInp = document.getElementById('api-setup-token');
    if (setupInp) setupInp.value = '';
  }

  function fmt(n, d) { d = (d === undefined) ? 0 : d; return Number(n).toFixed(d); }

  function compactCr(n) {
    if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
    if (n >= 1e5) return (n / 1e5).toFixed(1) + 'L';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  // International compact format (K / M / B) — used for chart axes
  // where K/M reads more naturally than the Indian L/Cr convention.
  function compactKM(n) {
    var sign = n < 0 ? '-' : '';
    var v = Math.abs(n);
    if (v >= 1e9) return sign + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return sign + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return sign + (v / 1e3).toFixed(1) + 'K';
    return sign + String(Math.round(v));
  }

  function direction(curr, prev) {
    if (!prev || prev <= 0) return 'stable';
    var change = curr - prev;
    var pct = Math.abs(change) / prev * 100;
    if (pct < 3) return 'stable';
    return change > 0 ? 'grow' : 'shrink';
  }

  function dirLabel(d) {
    if (d === 'grow') return '<span class="up-tag grow">Growing</span>';
    if (d === 'shrink') return '<span class="up-tag shrink">Shrinking</span>';
    return '<span class="up-tag stable">Stable</span>';
  }

  // Max Pain = strike at which the *writers* of all CE+PE contracts
  // would lose the LEAST money if expiry settled there.
  // For each candidate settlement strike S, sum:
  //   - For every strike K with CE OI: max(S - K, 0) * ceOI  (call writer loss)
  //   - For every strike K with PE OI: max(K - S, 0) * peOI  (put  writer loss)
  // The S with minimum total = Max Pain.
  function computeMaxPain(strikes) {
    if (!strikes || !strikes.length) return null;
    var minPain = Infinity, mpStrike = null;
    for (var i = 0; i < strikes.length; i++) {
      var settle = strikes[i].strike_price;
      var pain = 0;
      for (var j = 0; j < strikes.length; j++) {
        var k = strikes[j].strike_price;
        var ceOI = (strikes[j].call_options && strikes[j].call_options.market_data) ? (strikes[j].call_options.market_data.oi || 0) : 0;
        var peOI = (strikes[j].put_options && strikes[j].put_options.market_data) ? (strikes[j].put_options.market_data.oi || 0) : 0;
        if (settle > k) pain += (settle - k) * ceOI;
        if (settle < k) pain += (k - settle) * peOI;
      }
      if (pain < minPain) { minPain = pain; mpStrike = settle; }
    }
    return mpStrike;
  }

  // Wall strength = % share of that side's total OI sitting at the wall strike
  function wallStrength(wallOI, sideTotal) {
    if (!sideTotal || sideTotal <= 0) return { pct: 0, label: 'MILD', cls: 's-mild' };
    var pct = wallOI / sideTotal * 100;
    if (pct >= 25) return { pct: pct, label: 'VERY STRONG', cls: 's-very' };
    if (pct >= 12) return { pct: pct, label: 'STRONG', cls: 's-strong' };
    return { pct: pct, label: 'MILD', cls: 's-mild' };
  }

  // Plain-English explanation of a wall row, dynamically composed
  // from side / direction / distance / strength.
  function wallTranslation(side, dir, distancePts, strengthLabel, strike) {
    var role = side === 'floor' ? 'Put-writers' : 'Call-writers';
    var defendsAs = side === 'floor' ? '<b>support</b>' : '<b>resistance</b>';
    var hardness;
    if (strengthLabel === 'VERY STRONG') {
      hardness = 'A huge stack of OI sits here &mdash; treat this as a <b>hard ' + (side === 'floor' ? 'floor' : 'ceiling') + '</b>.';
    } else if (strengthLabel === 'STRONG') {
      hardness = 'A meaningful chunk of OI sits here &mdash; expect price to <b>react</b> at this level.';
    } else {
      hardness = 'OI concentration here is small &mdash; treat as a <b>soft</b> level rather than a hard wall.';
    }
    var trend;
    if (dir === 'grow') {
      trend = role + ' are <b>adding more</b> contracts &mdash; the wall is getting <b>stronger</b>.';
    } else if (dir === 'shrink') {
      trend = role + ' are <b>covering</b> their positions &mdash; the wall is <b>weakening</b>, a break is more likely.';
    } else {
      trend = role + ' are holding their position &mdash; the wall is <b>steady</b>.';
    }
    var dist;
    if (distancePts > 0) {
      dist = 'Currently <b>' + Math.round(distancePts) + ' pts</b> from spot, so price still has room to ' + (side === 'floor' ? 'fall' : 'rally') + ' before testing it.';
    } else {
      dist = 'Spot is <b>right at this level</b> &mdash; the test is happening now.';
    }
    return hardness + ' ' + trend + ' ' + dist + ' Acts as ' + defendsAs + '.';
  }

  // Bias scoring (5-input multi-factor model)
  function scoreBias(input) {
    var spot = input.spot, peStrike = input.peStrike, ceStrike = input.ceStrike;
    var peSize = input.peSize, ceSize = input.ceSize;
    var peDir = input.peDir, ceDir = input.ceDir, pcr = input.pcr;
    var distFloor = Math.max(0, spot - peStrike);
    var distCeil = Math.max(0, ceStrike - spot);

    var asymScore = 0;
    if (distFloor > 0 && distCeil > 0) {
      var ratio = distFloor / distCeil;
      if (ratio >= 3) asymScore = -2;
      else if (ratio >= 1.5) asymScore = -1;
      else if (ratio <= 0.33) asymScore = +2;
      else if (ratio <= 0.67) asymScore = +1;
    } else if (distFloor === 0) asymScore = -2;
    else if (distCeil === 0) asymScore = +2;

    var sizeScore = 0;
    if (peSize > ceSize * 1.3) sizeScore = +1;
    else if (ceSize > peSize * 1.3) sizeScore = -1;

    var peDirScore = peDir === 'shrink' ? -2 : (peDir === 'grow' ? +1 : 0);
    var ceDirScore = ceDir === 'shrink' ? +2 : (ceDir === 'grow' ? -1 : 0);

    var pcrScore = (pcr > 1.3) ? +1 : (pcr < 0.7 ? -1 : 0);

    var total = asymScore + sizeScore + peDirScore + ceDirScore + pcrScore;

    var verdict, badge, color, action;
    if (ceDir === 'shrink' && total >= 1) {
      verdict = 'CE SQUEEZE — BREAKOUT IN PROGRESS';
      badge = 'BUY CE AGGRESSIVELY';
      color = 'var(--bull)';
      action = 'Call writers are covering at <b>' + ceStrike + '</b>. The wall is breaking. <b>BUY CE</b>. Target = next CE-OI cluster above. SL = a 5-min close back below <b>' + ceStrike + '</b>.';
    } else if (peDir === 'shrink' && total <= -1) {
      verdict = 'PE BREAKDOWN — FLOOR FAILING';
      badge = 'BUY PE AGGRESSIVELY';
      color = 'var(--bear)';
      action = 'Put writers are covering at <b>' + peStrike + '</b>. The floor is failing. <b>BUY PE</b>. Target = next PE-OI cluster below. SL = a 5-min close back above <b>' + peStrike + '</b>.';
    } else if (total >= 4) {
      verdict = 'STRONG CE BIAS';
      badge = 'BUY CE on dip';
      color = 'var(--bull)';
      action = 'Multiple inputs aligned bullish. <b>BUY CE</b> on dip toward <b>' + peStrike + '</b>. Target = <b>' + ceStrike + '</b>. SL = below <b>' + peStrike + '</b>.';
    } else if (total >= 1) {
      verdict = 'CE BIAS';
      badge = 'BUY CE small / wait for confirmation';
      color = 'var(--bull)';
      action = 'Mild bullish edge. <b>Half-size CE</b> on dip toward <b>' + peStrike + '</b>. Wait for a rejection candle before entry.';
    } else if (total === 0) {
      verdict = 'NO TRADE';
      badge = 'WAIT — no edge';
      color = 'var(--neutral)';
      action = 'Inputs are balanced. The market has no clear bias right now. <b>Stand aside</b>. Re-fetch in 30 minutes.';
    } else if (total >= -3) {
      verdict = 'PE BIAS';
      badge = 'BUY PE small / wait for confirmation';
      color = 'var(--bear)';
      action = 'Mild bearish edge. <b>Half-size PE</b> on rally toward <b>' + ceStrike + '</b>. Wait for a rejection candle before entry.';
    } else {
      verdict = 'STRONG PE BIAS';
      badge = 'BUY PE on rally';
      color = 'var(--bear)';
      action = 'Multiple inputs aligned bearish. <b>BUY PE</b> on rally toward <b>' + ceStrike + '</b>. Target = <b>' + peStrike + '</b>. SL = above <b>' + ceStrike + '</b>.';
    }

    return {
      total: total, verdict: verdict, badge: badge, color: color, action: action,
      distFloor: distFloor, distCeil: distCeil
    };
  }

  // ── Live Option Chain table (Upstox / Sensibull style) ─────────────
  // Renders the same data the OI bar chart shows, but as a row-per-strike
  // table with Calls on the left, Strike pinned in the middle, Puts on
  // the right. Each row exposes the eight metrics traders actually scan:
  //
  //   IV · Vega · Gamma · Theta · Delta · OI(L) · OI Δ · LTP   |  STRIKE  |  LTP · OI Δ · OI(L) · Delta · Theta · Gamma · Vega · IV
  //
  // Highlighting:
  //   • ITM cells get a soft tint (Upstox convention — calls left of
  //     spot are ITM, puts right of spot are ITM).
  //   • ATM strike row gets a blue underline.
  //   • PE-wall strike row gets a green tint.
  //   • CE-wall strike row gets a red tint.
  //   • A dashed "← SPOT 23,415.95 →" band floats between the two
  //     strikes that bracket spot, so the trader sees exactly where
  //     price sits in the book.
  //
  // Window: ±15 strikes around spot (30 rows). Always extended to
  // include both walls (matching renderChart()'s policy) so a
  // far-out wall doesn't disappear.
  function renderChainTable(strikes, spot, peWallStrike, ceWallStrike, expiry, symbol, totCE, totPE, pcr) {
    if (!strikes || !strikes.length) return '<div style="padding:18px;color:var(--muted)">No option-chain data.</div>';

    // Find spot index and bracketing strikes (for the SPOT marker row).
    var spotIdx = 0, minDiff = Infinity;
    strikes.forEach(function (s, i) {
      var d = Math.abs(s.strike_price - spot);
      if (d < minDiff) { minDiff = d; spotIdx = i; }
    });
    var spotBeforeIdx = -1, spotAfterIdx = -1;
    strikes.forEach(function (s, i) {
      if (s.strike_price <= spot) spotBeforeIdx = i;
      if (s.strike_price >= spot && spotAfterIdx === -1) spotAfterIdx = i;
    });

    var peWallIdx = -1, ceWallIdx = -1;
    strikes.forEach(function (s, i) {
      if (s.strike_price === peWallStrike) peWallIdx = i;
      if (s.strike_price === ceWallStrike) ceWallIdx = i;
    });

    // ±15 around spot, but stretch to include both walls.
    var half = 15;
    var lo = Math.max(0, spotIdx - half);
    var hi = Math.min(strikes.length, spotIdx + half + 1);
    if (peWallIdx >= 0) { lo = Math.min(lo, peWallIdx); hi = Math.max(hi, peWallIdx + 1); }
    if (ceWallIdx >= 0) { lo = Math.min(lo, ceWallIdx); hi = Math.max(hi, ceWallIdx + 1); }
    var view = strikes.slice(lo, hi);

    // Max OI in the visible window — used to scale the inline OI bar
    // inside each cell so the eye can compare strike-to-strike size.
    var maxOI = 1;
    view.forEach(function (s) {
      var ce = (s.call_options && s.call_options.market_data) ? (+s.call_options.market_data.oi || 0) : 0;
      var pe = (s.put_options && s.put_options.market_data) ? (+s.put_options.market_data.oi || 0) : 0;
      if (ce > maxOI) maxOI = ce;
      if (pe > maxOI) maxOI = pe;
    });

    // ── Number formatters (local, tight, all defensive against missing greeks) ──
    var fmt2 = function (n) { return isFinite(+n) ? (+n).toFixed(2) : '\u2014'; };
    var fmt4 = function (n) { return isFinite(+n) ? (+n).toFixed(4) : '\u2014'; };
    var fmtIvLocal = function (n) { return (isFinite(+n) && +n > 0) ? (+n).toFixed(2) + '%' : '\u2014'; };
    var fmtLtpLocal = function (n) { return (isFinite(+n) && +n > 0) ? (+n).toFixed(2) : '\u2014'; };
    var fmtOiCompact = function (oi) {
      if (!isFinite(+oi) || +oi <= 0) return '\u2014';
      oi = +oi;
      if (oi >= 1e7) return (oi / 1e7).toFixed(2) + 'Cr';
      if (oi >= 1e5) return (oi / 1e5).toFixed(2) + 'L';
      if (oi >= 1000) return (oi / 1000).toFixed(1) + 'K';
      return String(oi);
    };
    var fmtOiDelta = function (cur, prev) {
      if (!isFinite(+cur) || !isFinite(+prev)) return { txt: '\u2014', cls: '' };
      var d = +cur - +prev;
      if (d === 0) return { txt: '0', cls: '' };
      var sign = d > 0 ? '+' : '\u2212';
      var mag = Math.abs(d);
      var txt;
      if (mag >= 1e7) txt = sign + (mag / 1e7).toFixed(2) + 'Cr';
      else if (mag >= 1e5) txt = sign + (mag / 1e5).toFixed(2) + 'L';
      else if (mag >= 1000) txt = sign + (mag / 1000).toFixed(1) + 'K';
      else txt = sign + mag;
      return { txt: txt, cls: d > 0 ? 'oi-up' : 'oi-down' };
    };
    var fmtDeltaSigned = function (n) {
      if (!isFinite(+n)) return '\u2014';
      var s = (+n).toFixed(4);
      return n >= 0 ? '+' + s : s;
    };

    // OI cell builder — number plus a mini horizontal bar scaled to maxOI.
    // Side controls the bar colour and which way the cell visually flows.
    function oiCell(oi, side) {
      if (!isFinite(+oi) || +oi <= 0) return '<span style="color:var(--muted)">\u2014</span>';
      var pct = Math.min(100, Math.round((+oi / maxOI) * 100));
      var barW = Math.max(2, Math.min(40, Math.round(pct * 0.4))); // px
      var barHtml = '<span class="up-oi-bar is-' + side + '" style="width:' + barW + 'px"></span>';
      return '<span class="up-oi-bar-wrap">' +
        '<span>' + fmtOiCompact(+oi) + '</span>' + barHtml + '</span>';
    }

    // ── Build header row ──
    var head =
      '<thead>' +
        '<tr>' +
          '<th class="up-grp is-call" colspan="8">CALLS (CE)</th>' +
          '<th class="up-grp is-strike">STRIKE</th>' +
          '<th class="up-grp is-put" colspan="8">PUTS (PE)</th>' +
        '</tr>' +
        '<tr>' +
          '<th>IV</th><th>Vega</th><th>Gamma</th><th>Theta</th><th>Delta</th>' +
          '<th>OI</th><th>OI \u0394</th><th>LTP</th>' +
          '<th class="col-strike-h">Strike</th>' +
          '<th>LTP</th><th>OI \u0394</th><th>OI</th>' +
          '<th>Delta</th><th>Theta</th><th>Gamma</th><th>Vega</th><th>IV</th>' +
        '</tr>' +
      '</thead>';

    // ── Build body rows ──
    // ltpKeys collects every visible CE+PE instrument_key so pollOptionPrices
    // can poll them at 1Hz and updateChainTableLtps() can patch the LTP
    // cells in place without a full table rerender.
    var rowsHtml = '';
    var ltpKeys = [];
    view.forEach(function (s, i) {
      var k = s.strike_price;
      var ce = s.call_options || {};
      var pe = s.put_options || {};
      var ceMd = ce.market_data || {};
      var peMd = pe.market_data || {};
      var ceG = ce.option_greeks || {};
      var peG = pe.option_greeks || {};
      var ceKey = ce.instrument_key || '';
      var peKey = pe.instrument_key || '';
      if (ceKey) ltpKeys.push(ceKey);
      if (peKey) ltpKeys.push(peKey);

      var isCallItm = k <= spot;   // call is ITM when strike <= spot
      var isPutItm  = k >= spot;   // put is ITM when strike >= spot
      var ceItmCls = isCallItm ? ' is-itm-call' : '';
      var peItmCls = isPutItm ? ' is-itm-put' : '';

      var ceOiD = fmtOiDelta(ceMd.oi, ceMd.prev_oi);
      var peOiD = fmtOiDelta(peMd.oi, peMd.prev_oi);

      var rowClass = '';
      if (k === ceWallStrike) rowClass = 'is-ce-wall';
      else if (k === peWallStrike) rowClass = 'is-pe-wall';
      else if (i === (spotIdx - lo)) rowClass = 'is-atm';

      // data-up-ltp-key on each LTP cell lets updateChainTableLtps()
      // find and patch them every 1s without rebuilding the row.
      var ceLtpAttr = ceKey ? ' data-up-ltp-key="' + ceKey + '"' : '';
      var peLtpAttr = peKey ? ' data-up-ltp-key="' + peKey + '"' : '';

      rowsHtml +=
        '<tr class="' + rowClass + '">' +
          '<td class="' + ceItmCls.trim() + '">' + fmtIvLocal(ceG.iv) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.vega) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.gamma) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.theta) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmtDeltaSigned(ceG.delta) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + oiCell(ceMd.oi, 'call') + '</td>' +
          '<td class="' + ceItmCls.trim() + ' ' + ceOiD.cls + '">' + ceOiD.txt + '</td>' +
          '<td class="col-ltp is-call' + ceItmCls + '"' + ceLtpAttr + '>' + fmtLtpLocal(ceMd.ltp) + '</td>' +
          '<td class="col-strike">' + k + '</td>' +
          '<td class="col-ltp is-put' + peItmCls + '"' + peLtpAttr + '>' + fmtLtpLocal(peMd.ltp) + '</td>' +
          '<td class="' + peItmCls.trim() + ' ' + peOiD.cls + '">' + peOiD.txt + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + oiCell(peMd.oi, 'put') + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmtDeltaSigned(peG.delta) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.theta) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.gamma) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.vega) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmtIvLocal(peG.iv) + '</td>' +
        '</tr>';

      // Insert a SPOT marker row between the two bracketing strikes, so
      // it visually appears exactly where price sits in the book.
      if (spotBeforeIdx >= 0 && spotAfterIdx >= 0
          && spotBeforeIdx !== spotAfterIdx
          && (i + lo) === spotBeforeIdx) {
        rowsHtml +=
          '<tr class="is-spot-marker">' +
            '<td colspan="17">\u2190 SPOT ' + (+spot).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' \u2192</td>' +
          '</tr>';
      }
    });

    // Hand the visible-row keys off to the 1Hz LTP poller. Treat the
    // 30s table rebuild as a fresh "tick" too — anchors the live ticker
    // so the pill says "just now" instead of stale seconds-ago.
    try {
      if (typeof state !== 'undefined' && state) {
        state.chainTableLtpKeys = ltpKeys;
        state.chainLastLtpTickTs = Date.now();
      }
    } catch (_) {}

    // Max Pain: strike at which option writers (CE + PE combined) bear
    // the lowest payout if price settles there at expiry. Heuristic
    // gravitational level — many traders watch spot's drift towards it
    // into expiry. Computed off the FULL strikes list (not the
    // ±15-around-spot window) so a distant max pain isn't missed.
    var mpStrike = (typeof computeMaxPain === 'function') ? computeMaxPain(strikes) : null;
    var mpDeltaTxt = '';
    if (isFinite(+mpStrike) && isFinite(+spot) && +spot > 0) {
      var diff = (+mpStrike) - (+spot);
      var pct = (diff / +spot) * 100;
      var sign = diff > 0 ? '+' : (diff < 0 ? '\u2212' : '');
      var arrow = diff > 0 ? '\u2191' : (diff < 0 ? '\u2193' : '');
      mpDeltaTxt = ' <span style="color:var(--muted);font-weight:500">(' + arrow + ' ' + sign + Math.abs(diff).toFixed(0) + ' \u00b7 ' + Math.abs(pct).toFixed(2) + '%)</span>';
    }

    // ── Compact summary header above the scrolling table ──
    // Includes a LIVE pill (pulsing dot + "Xs ago" label) — the dot
    // pulses green while LTPs are being patched at 1Hz by
    // pollOptionPrices(), and goes muted/gray after 5s of silence.
    // OI / Greeks / OI Δ continue to refresh on the 30s schedule
    // (full rerender of this header).
    // Initial pill state. The 1s ticker (updateChainLiveLabel) will
    // overwrite this on its first run, but rendering the right state
    // up-front avoids the "LIVE · just now" flash on a closed market.
    var initMarketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
    var initLabel = initMarketOpen
      ? 'LIVE \u00b7 just now'
      : ('CLOSED' + ((typeof window.nextOpenLabel === 'function') ? ' \u00b7 ' + window.nextOpenLabel() : ''));
    var initDotClass = initMarketOpen ? 'up-live-dot' : 'up-live-dot is-stale';

    var summary = '' +
      '<div class="up-chain-table-summary">' +
        '<span class="up-chain-live" id="up-chain-live" title="LTPs tick every 1s when the market is open. OI / Greeks refresh every 30s.">' +
          '<span class="' + initDotClass + '"></span>' +
          '<span class="up-live-label" id="up-chain-live-label">' + initLabel + '</span>' +
        '</span>' +
        '<span class="sep">|</span>' +
        '<span><b>' + (symbol || 'NIFTY') + '</b> \u00b7 expiry <b>' + (expiry || '\u2014') + '</b></span>' +
        '<span class="sep">|</span>' +
        '<span>Spot <b style="color:var(--info)">' + (+spot).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + '</b></span>' +
        '<span class="sep">|</span>' +
        '<span>PCR <b>' + (isFinite(+pcr) ? (+pcr).toFixed(2) : '\u2014') + '</b></span>' +
        '<span class="sep">|</span>' +
        '<span>Total CE OI <b>' + fmtOiCompact(totCE) + '</b></span>' +
        '<span class="sep">|</span>' +
        '<span>Total PE OI <b>' + fmtOiCompact(totPE) + '</b></span>' +
        '<span class="sep">|</span>' +
        '<span title="Max Pain: settlement strike where combined option-writer payout is minimised. Many traders watch spot drift toward this level into expiry.">' +
          'Max Pain <b style="color:var(--amber)">' + (isFinite(+mpStrike) ? mpStrike : '\u2014') + '</b>' + mpDeltaTxt +
        '</span>' +
      '</div>';

    // Schedule the 1s "Xs ago" ticker. Idempotent — won't double-start.
    // Microtask defers until after the parent innerHTML assignment
    // finishes inserting the new pill into the DOM.
    try {
      if (typeof startChainLiveTicker === 'function') {
        Promise.resolve().then(startChainLiveTicker);
      }
    } catch (_) {}

    return summary +
      '<div class="up-chain-table-scroll">' +
        '<table class="up-chain-table">' + head + '<tbody>' + rowsHtml + '</tbody></table>' +
      '</div>';
  }

  // ── 1Hz LTP patcher for the visible chain-table ──
  // Reads state.optPrices (populated by pollOptionPrices) and writes
  // the latest LTP into every chain-table cell tagged with
  // data-up-ltp-key. Bails fast if the table isn't on screen so it's
  // safe to call from every poll cycle.
  function updateChainTableLtps() {
    var wrap = document.getElementById('up-chain-table-wrap');
    if (!wrap || !wrap.firstChild) return;
    var cells = wrap.querySelectorAll('[data-up-ltp-key]');
    if (!cells.length) return;
    var optPrices = (typeof state !== 'undefined' && state) ? state.optPrices : null;
    if (!optPrices) return;
    var changedAny = 0;
    cells.forEach(function (el) {
      var k = el.getAttribute('data-up-ltp-key');
      if (!k) return;
      var px = optPrices[k];
      if (!isFinite(+px) || +px <= 0) return;
      var newTxt = (+px).toFixed(2);
      if (el.textContent !== newTxt) {
        el.textContent = newTxt;
        changedAny++;
      }
    });
    if (changedAny > 0) {
      state.chainLastLtpTickTs = Date.now();
      updateChainLiveLabel();
    }
  }

  // ── "LIVE · 3s ago" label refresh ──
  // Ticks once a second to walk the seconds-ago counter forward. Goes
  // muted/gray after 5s of silence (poll likely stalled / network
  // dropped); flips back to green pulsing on the next successful poll.
  // Outside market hours we don't poll for LTPs at all, so showing
  // "LIVE" would be a lie — flip the pill to a muted "CLOSED" badge.
  function updateChainLiveLabel() {
    var lblEl = document.getElementById('up-chain-live-label');
    if (!lblEl) return;
    var dotEl = document.querySelector('#up-chain-live .up-live-dot');
    var marketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
    if (!marketOpen) {
      var nextLabel = (typeof window.nextOpenLabel === 'function') ? window.nextOpenLabel() : '';
      lblEl.textContent = 'CLOSED' + (nextLabel ? ' \u00b7 ' + nextLabel : '');
      if (dotEl) dotEl.classList.add('is-stale');
      return;
    }
    if (!state.chainLastLtpTickTs) {
      lblEl.textContent = 'LIVE \u00b7 waiting for first tick';
      if (dotEl) dotEl.classList.add('is-stale');
      return;
    }
    var ago = Math.max(0, Math.floor((Date.now() - state.chainLastLtpTickTs) / 1000));
    var label = ago < 1 ? 'just now' : ago + 's ago';
    lblEl.textContent = 'LIVE \u00b7 ' + label;
    if (dotEl) dotEl.classList.toggle('is-stale', ago > 5);
  }

  function startChainLiveTicker() {
    if (state.chainLiveTickerTimer) return;
    // Render once immediately so the pill doesn't show stale text in
    // the gap between table render and the first 1s tick.
    updateChainLiveLabel();
    state.chainLiveTickerTimer = setInterval(updateChainLiveLabel, 1000);
  }
  function stopChainLiveTicker() {
    if (state.chainLiveTickerTimer) {
      clearInterval(state.chainLiveTickerTimer);
      state.chainLiveTickerTimer = null;
    }
  }
  // Expose so an external stop (e.g. on logout / token clear) is possible
  window.stopChainLiveTicker = stopChainLiveTicker;

  // SVG bar chart of OI. Renders ±5 strikes around spot at minimum,
  // and always extends to include both wall strikes so they render
  // as real bars with a "PE WALL" / "CE WALL" label above them.
  function renderChart(strikes, spot, peWallStrike, ceWallStrike) {
    var spotIdx = 0, minDiff = Infinity;
    strikes.forEach(function (s, i) {
      var d = Math.abs(s.strike_price - spot);
      if (d < minDiff) { minDiff = d; spotIdx = i; }
    });

    // Find the wall strikes so we can guarantee they're visible. The
    // "Walls Detected" cards below the chart name specific strikes —
    // it was confusing UX to mention strike 23500 in a card while the
    // chart only showed 23950–24450.
    var peWallIdx = -1, ceWallIdx = -1;
    strikes.forEach(function (s, i) {
      if (s.strike_price === peWallStrike) peWallIdx = i;
      if (s.strike_price === ceWallStrike) ceWallIdx = i;
    });

    // Default window is ±5 strikes around spot; always extend to
    // include both walls (with one-strike buffer beyond each) so
    // the user can see them with the same "PE WALL" / "CE WALL"
    // label rendered above the bar — no off-chart fallbacks.
    var half = 5;
    var lo = Math.max(0, spotIdx - half);
    var hi = Math.min(strikes.length, spotIdx + half + 1);
    if (peWallIdx >= 0) lo = Math.min(lo, Math.max(0, peWallIdx - 1));
    if (ceWallIdx >= 0) hi = Math.max(hi, Math.min(strikes.length, ceWallIdx + 2));

    var slice = strikes.slice(lo, hi);
    if (!slice.length) return '<div style="color:var(--muted)">No strikes near spot.</div>';

    var maxOI = 0;
    slice.forEach(function (s) {
      var ce = s.call_options ? (s.call_options.market_data.oi || 0) : 0;
      var pe = s.put_options ? (s.put_options.market_data.oi || 0) : 0;
      if (ce > maxOI) maxOI = ce;
      if (pe > maxOI) maxOI = pe;
    });
    if (maxOI === 0) maxOI = 1;

    // padB is generous so vertical (rotated 90°) strike labels fit
    // below the bars without being clipped or overlapping the
    // legend row. padT is generous so the SPOT label gets a
    // dedicated top row, well above any "CE WALL" / "PE WALL"
    // text that sits just above its bar top (which can reach
    // padT itself when the wall bar is at maxOI).
    var W = 800, H = 320, padL = 56, padR = 20, padT = 46, padB = 100;
    var plotH = H - padT - padB;
    var n = slice.length;
    var groupW = (W - padL - padR) / n;
    // Keep PE/CE bars side-by-side with at least a 1px gap; at high
    // n (extended-range view) the groups are narrow, so we floor the
    // bar width at 3px so something is always visible.
    var barW = Math.max(3, Math.min(14, (groupW - 4) / 2));

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block" aria-label="Live OI Chart">';

    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var y = padT + plotH * (1 - t);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(128,128,128,0.12)" stroke-width="1"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--muted)" font-size="10" font-family="monospace">' + compactKM(maxOI * t) + '</text>';
    });

    // Slice-relative indices of the walls and spot; used to bold the
    // wall strike labels on the axis. spotSliceIdx is the *nearest*
    // strike to spot — still used for bolding the strike axis label.
    // The dashed line and SPOT label, however, are placed at the
    // *interpolated* x between the two bracketing strikes so they
    // don't snap onto a wall column (which is what was causing the
    // "SPOT" / "CE WALL" text overlap).
    var peSliceIdx = -1, ceSliceIdx = -1, spotSliceIdx = -1;
    var spotBeforeIdx = -1, spotAfterIdx = -1;
    slice.forEach(function (s, i) {
      if (s.strike_price === peWallStrike) peSliceIdx = i;
      if (s.strike_price === ceWallStrike) ceSliceIdx = i;
      if (Math.abs(s.strike_price - spot) < minDiff + 0.001) spotSliceIdx = i;
      if (s.strike_price <= spot) spotBeforeIdx = i;
      if (s.strike_price >= spot && spotAfterIdx === -1) spotAfterIdx = i;
    });

    // Compute spotX up-front via linear interpolation between the
    // two bracketing strikes (if they're different). Falls back to
    // the nearest-strike column when spot is outside the slice
    // window or exactly on a strike.
    var spotX = 0;
    if (spotBeforeIdx >= 0 && spotAfterIdx >= 0 && spotBeforeIdx !== spotAfterIdx) {
      var bStrike = slice[spotBeforeIdx].strike_price;
      var aStrike = slice[spotAfterIdx].strike_price;
      var bX = padL + groupW * spotBeforeIdx + groupW / 2;
      var aX = padL + groupW * spotAfterIdx + groupW / 2;
      var frac = (aStrike === bStrike) ? 0 : (spot - bStrike) / (aStrike - bStrike);
      spotX = bX + (aX - bX) * Math.max(0, Math.min(1, frac));
    } else if (spotSliceIdx >= 0) {
      spotX = padL + groupW * spotSliceIdx + groupW / 2;
    } else {
      spotX = padL + (W - padL - padR) / 2;
    }
    spotX = Math.max(padL + 2, Math.min(W - padR - 2, spotX));

    slice.forEach(function (s, i) {
      var cx = padL + groupW * i + groupW / 2;
      var ce = s.call_options ? (s.call_options.market_data.oi || 0) : 0;
      var pe = s.put_options ? (s.put_options.market_data.oi || 0) : 0;
      var ceH = plotH * (ce / maxOI);
      var peH = plotH * (pe / maxOI);
      var ceY = padT + plotH - ceH;
      var peY = padT + plotH - peH;

      svg += '<rect x="' + (cx - barW - 1) + '" y="' + peY + '" width="' + barW + '" height="' + peH + '" fill="#09a86e" opacity="0.85"/>';
      svg += '<rect x="' + (cx + 1) + '" y="' + ceY + '" width="' + barW + '" height="' + ceH + '" fill="#c91f3a" opacity="0.85"/>';

      // Every strike gets a label, rotated 90° so they never collide
      // even with 40+ bars. Walls are bolded; everything else uses
      // the muted axis color.
      var isWallStrike = (i === peSliceIdx) || (i === ceSliceIdx);
      var labelWeight = isWallStrike ? '700' : '400';
      var labelFill = isWallStrike ? 'var(--text)' : 'var(--muted)';
      var lx = cx;
      var ly = padT + plotH + 8;
      svg += '<text x="' + lx + '" y="' + ly + '"'
        + ' transform="rotate(-90 ' + lx + ' ' + ly + ')"'
        + ' text-anchor="end" dominant-baseline="middle"'
        + ' fill="' + labelFill + '" font-size="10.5" font-weight="' + labelWeight + '" font-family="monospace">'
        + s.strike_price + '</text>';

      if (i === peSliceIdx) svg += '<text x="' + cx + '" y="' + (peY - 6) + '" text-anchor="middle" fill="#09a86e" font-size="10" font-weight="700">PE WALL</text>';
      if (i === ceSliceIdx) svg += '<text x="' + cx + '" y="' + (ceY - 6) + '" text-anchor="middle" fill="#c91f3a" font-size="10" font-weight="700">CE WALL</text>';
    });

    // SPOT line + label. The label is pinned to a fixed top row
    // (y=14) so it never collides with CE/PE WALL labels — those
    // sit at most at (padT - 6) = 40, leaving ~26px clearance.
    svg += '<line x1="' + spotX + '" y1="' + padT + '" x2="' + spotX + '" y2="' + (padT + plotH) + '" stroke="var(--info)" stroke-width="1.5" stroke-dasharray="5,4"/>';
    svg += '<text x="' + spotX + '" y="14" text-anchor="middle" fill="var(--info)" font-size="11" font-weight="600" font-family="monospace">SPOT ' + fmt(spot, 2) + '</text>';

    // ── Legend (Put OI swatch · Call OI swatch · dashed Spot line) ──
    var legY = H - 24;          // vertical center of swatches
    var legTextY = H - 20;      // baseline of legend text

    svg += '<rect x="' + padL + '" y="' + (H - 30) + '" width="12" height="12" fill="#09a86e" rx="2"/>';
    svg += '<text x="' + (padL + 18) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="monospace">Put OI</text>';

    svg += '<rect x="' + (padL + 90) + '" y="' + (H - 30) + '" width="12" height="12" fill="#c91f3a" rx="2"/>';
    svg += '<text x="' + (padL + 108) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="monospace">Call OI</text>';

    var spotLegX = padL + 180;
    svg += '<line x1="' + spotLegX + '" y1="' + legY + '" x2="' + (spotLegX + 26) + '" y2="' + legY + '" stroke="var(--info)" stroke-width="1.6" stroke-dasharray="5,4" stroke-linecap="round"/>';
    svg += '<text x="' + (spotLegX + 32) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="monospace">Spot</text>';

    svg += '</svg>';
    return svg;
  }

  function renderDashboard(strikes, spot, totCE, totPE, pcr, peWall, ceWall, peDir, ceDir, expiry, symbol) {
    // ── Derived metrics ───────────────────────────────────────────────
    var pcrLean = pcr > 1.2
      ? { sub: 'Bullish lean', cls: 'is-bull' }
      : (pcr < 0.8 ? { sub: 'Bearish lean', cls: 'is-bear' } : { sub: 'Neutral', cls: 'is-neutral' });

    var maxPain = computeMaxPain(strikes);
    var mpDelta = (maxPain != null) ? (maxPain - spot) : 0;
    var mpSub;
    if (maxPain == null) {
      mpSub = '\u2014';
    } else if (Math.abs(mpDelta) < 1) {
      mpSub = 'AT spot';
    } else if (mpDelta > 0) {
      mpSub = '+' + Math.round(mpDelta) + ' pts above spot';
    } else {
      mpSub = Math.round(mpDelta) + ' pts below spot';
    }

    var oiBiasPct = (totCE + totPE) > 0 ? (totPE - totCE) / (totCE + totPE) * 100 : 0;
    var biasLabel, biasCls;
    if (oiBiasPct > 8) { biasLabel = 'Put-heavy \u00b7 bullish'; biasCls = 'is-bull'; }
    else if (oiBiasPct < -8) { biasLabel = 'Call-heavy \u00b7 bearish'; biasCls = 'is-bear'; }
    else { biasLabel = 'Balanced'; biasCls = 'is-neutral'; }
    var biasVal = (oiBiasPct >= 0 ? '+' : '') + oiBiasPct.toFixed(1) + '%';

    // ── Stats grid (6 cards with hover-tooltips) ──────────────────────
    var stats = [
      {
        lbl: 'Spot', val: fmt(spot, 2), sub: symbol, cls: 'is-neutral',
        tip: 'Last traded price of the underlying index. Everything else on this page is referenced to this number.'
      },
      {
        lbl: 'PCR', val: fmt(pcr, 2), sub: pcrLean.sub, cls: pcrLean.cls,
        tip: 'Put / Call Ratio = total Put OI \u00f7 total Call OI. Above 1.2 = bullish lean (writers expect support). Below 0.8 = bearish lean. Around 1 = neutral.'
      },
      {
        lbl: 'Max Pain', val: maxPain != null ? maxPain : '\u2014', sub: mpSub, cls: 'is-warn',
        tip: 'The strike at which option-writers (the big players) would lose the LEAST money if expiry settled there. Price tends to drift toward this level, especially on expiry day.'
      },
      {
        lbl: 'OI Bias', val: biasVal, sub: biasLabel, cls: biasCls,
        tip: '(Put OI \u2212 Call OI) \u00f7 total. Positive = put-heavy book, writers expect a floor (bullish). Negative = call-heavy book, writers expect a ceiling (bearish).'
      },
      {
        lbl: 'Total Call OI', val: compactCr(totCE), sub: 'resistance side \u00b7 all strikes', cls: 'is-bear',
        tip: 'Sum of all open call contracts across every strike. Higher = more sellers betting on a ceiling above.'
      },
      {
        lbl: 'Total Put OI', val: compactCr(totPE), sub: 'support side \u00b7 all strikes', cls: 'is-bull',
        tip: 'Sum of all open put contracts across every strike. Higher = more sellers betting on a floor below.'
      }
    ];

    var statsHtml = '';
    stats.forEach(function (s) {
      var tipAttr = (s.tip || '').replace(/"/g, '&quot;');
      statsHtml +=
        '<div class="up-stat ' + (s.cls || '') + '">' +
          '<div class="up-stat-row">' +
            '<span class="up-stat-lbl">' + s.lbl + '</span>' +
            (s.tip ? '<span class="up-info" tabindex="0" data-tip="' + tipAttr + '">i</span>' : '') +
          '</div>' +
          '<div class="up-stat-val">' + s.val + '</div>' +
          '<div class="up-stat-sub">' + s.sub + '</div>' +
        '</div>';
    });
    $('up-stats').innerHTML = statsHtml;

    // ── REVEAL the dashboard NOW (before chain table render) ──
    // Critical for first-load scroll-centering: layout dimensions
    // (offsetTop / clientHeight / offsetHeight) all return 0 while
    // the parent container is display:none. Setting display:block
    // here means the chain table's centering math BELOW can read
    // real pixel measurements on the very first render, not just
    // on the 30s refresh once the dashboard happens to be visible.
    $('up-dashboard').style.display = 'block';

    // ── Live option chain table (Calls | Strike | Puts) ───────────────
    // Renders BEFORE the OI bar chart so the user sees the same data
    // they'd see on Upstox / Sensibull (greeks, OI, OI Δ, LTP per strike)
    // before the higher-level visualisation.
    //
    // Scroll behaviour: ALWAYS centre the spot row on every render
    // (including the 30s refresh). This is the user's primary mental
    // anchor — losing it on a refresh is the single biggest "feels
    // wrong" moment of this view. If a user wants to inspect far-OTM
    // strikes without being yanked back, they can scroll on the page
    // (the table itself stays anchored on spot).
    var chainTableEl = $('up-chain-table-wrap');
    if (chainTableEl) {
      chainTableEl.innerHTML = renderChainTable(
        strikes, spot, peWall.strike, ceWall.strike,
        expiry, symbol, totCE, totPE, pcr
      );

      // Defer the centering math one animation frame — even with the
      // dashboard now display:block, the browser still hasn't computed
      // layout for the freshly inserted rows in the SAME microtask.
      // Reading offsetTop / clientHeight too early returns 0 and the
      // calc collapses to scrollTop=0 (the original "stuck at top of
      // chain" bug). One rAF guarantees layout is committed.
      var doCentreOnSpot = function () {
        var newScroll = chainTableEl.querySelector('.up-chain-table-scroll');
        if (!newScroll) return;
        var spotRow = newScroll.querySelector('tr.is-spot-marker') ||
                      newScroll.querySelector('tr.is-atm');
        if (!spotRow) return;
        var thead = newScroll.querySelector('thead');
        var headH = thead ? thead.offsetHeight : 0;
        var rowTop = spotRow.offsetTop;
        var rowH = spotRow.offsetHeight;
        var viewH = newScroll.clientHeight;
        // Defensive: if layout STILL hasn't happened (rare; e.g. tab
        // backgrounded so rAF was throttled), bail and try once more
        // a tick later rather than scrolling to 0.
        if (viewH <= 0 || rowTop <= 0) {
          setTimeout(doCentreOnSpot, 60);
          return;
        }
        var avail = Math.max(rowH * 2, viewH - headH);
        newScroll.scrollTop = Math.max(0,
          rowTop - headH - (avail / 2) + (rowH / 2));
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(doCentreOnSpot);
      } else {
        setTimeout(doCentreOnSpot, 0);
      }
    }

    // ── OI bar chart (unchanged) ──────────────────────────────────────
    $('up-chart-wrap').innerHTML = renderChart(strikes, spot, peWall.strike, ceWall.strike);

    // ── Walls (rich card grid with plain-English translation) ─────────
    var distFloor = Math.max(0, spot - peWall.strike);
    var distCeil = Math.max(0, ceWall.strike - spot);
    var peDelta = peWall.oi - peWall.prev_oi;
    var ceDelta = ceWall.oi - ceWall.prev_oi;

    var peStr = wallStrength(peWall.oi, totPE);
    var ceStr = wallStrength(ceWall.oi, totCE);

    var pePosWord = spot >= peWall.strike ? 'below spot' : 'above spot';
    var cePosWord = spot <= ceWall.strike ? 'above spot' : 'below spot';

    var peTrans = wallTranslation('floor', peDir, distFloor, peStr.label, peWall.strike);
    var ceTrans = wallTranslation('ceiling', ceDir, distCeil, ceStr.label, ceWall.strike);

    var peDeltaStr = (peDelta >= 0 ? '+' : '\u2212') + compactCr(Math.abs(peDelta));
    var ceDeltaStr = (ceDelta >= 0 ? '+' : '\u2212') + compactCr(Math.abs(ceDelta));

    var wallsHtml = ''
      + '<div class="up-wall-card is-floor">'
      +   '<div class="up-wall-head">'
      +     '<span class="up-wall-title">PE Wall \u00b7 Floor</span>'
      +     '<span class="up-strength ' + peStr.cls + '">' + peStr.label + '</span>'
      +     dirLabel(peDir)
      +     '<span class="up-wall-strike">' + peWall.strike + '</span>'
      +   '</div>'
      +   '<div class="up-wall-rows">'
      +     '<div class="up-wall-row"><span class="k">Open Interest</span><span class="v">' + compactCr(peWall.oi) + '<small>' + peStr.pct.toFixed(1) + '% of all PE OI</small></span></div>'
      +     '<div class="up-wall-row"><span class="k">OI \u0394 vs prev session</span><span class="v">' + peDeltaStr + '</span></div>'
      +     '<div class="up-wall-row"><span class="k">Distance from spot</span><span class="v">' + fmt(distFloor, 0) + ' pts <small>' + pePosWord + '</small></span></div>'
      +   '</div>'
      +   '<div class="up-wall-translation">' + peTrans + '</div>'
      + '</div>'
      + '<div class="up-wall-card is-ceiling">'
      +   '<div class="up-wall-head">'
      +     '<span class="up-wall-title">CE Wall \u00b7 Ceiling</span>'
      +     '<span class="up-strength ' + ceStr.cls + '">' + ceStr.label + '</span>'
      +     dirLabel(ceDir)
      +     '<span class="up-wall-strike">' + ceWall.strike + '</span>'
      +   '</div>'
      +   '<div class="up-wall-rows">'
      +     '<div class="up-wall-row"><span class="k">Open Interest</span><span class="v">' + compactCr(ceWall.oi) + '<small>' + ceStr.pct.toFixed(1) + '% of all CE OI</small></span></div>'
      +     '<div class="up-wall-row"><span class="k">OI \u0394 vs prev session</span><span class="v">' + ceDeltaStr + '</span></div>'
      +     '<div class="up-wall-row"><span class="k">Distance from spot</span><span class="v">' + fmt(distCeil, 0) + ' pts <small>' + cePosWord + '</small></span></div>'
      +   '</div>'
      +   '<div class="up-wall-translation">' + ceTrans + '</div>'
      + '</div>';

    $('up-walls-grid').innerHTML = wallsHtml;

    // ── Verdict (unchanged scoring model) ─────────────────────────────
    var bias = scoreBias({
      spot: spot, peStrike: peWall.strike, ceStrike: ceWall.strike,
      peSize: peWall.oi / 100000, ceSize: ceWall.oi / 100000,
      peDir: peDir, ceDir: ceDir, pcr: pcr
    });

    $('up-verdict-card').innerHTML = ''
      + '<div class="up-verdict-lbl">VERDICT &middot; SCORE ' + (bias.total >= 0 ? '+' : '') + bias.total + '</div>'
      + '<div class="up-verdict-text" style="color:' + bias.color + '">' + bias.verdict + '</div>'
      + '<div class="up-verdict-badge" style="background:' + bias.color + '22;color:' + bias.color + '">' + bias.badge + '</div>'
      + '<div style="margin-top:14px;padding:12px 14px;background:rgba(255,255,255,0.03);border-left:3px solid ' + bias.color + ';border-radius:5px;font-size:13.5px;line-height:1.65">' + bias.action + '</div>';

    $('up-dashboard-title').innerHTML = 'Live Snapshot &mdash; <span style="color:var(--info);font-weight:500">' + symbol + ' &middot; expiry ' + expiry + '</span>';
    // up-dashboard was already revealed BEFORE the chain table render
    // so the centering math could read real layout dimensions on first
    // load; just reveal the "next steps" card here.
    $('up-next').style.display = 'block';
  }

  // Auto-refresh timer for the option chain (silent re-fetch every 30s)
  var autoRefreshTimer = null;

  async function fetchChain(silent) {
    if (typeof window.ptIsApiPaused === 'function' && window.ptIsApiPaused()) {
      if (!silent) setStatus('Upstox API is paused. Click Resume on the banner at the top of the Options Trading tab.', 'err');
      return;
    }
    // #up-token lives inside content/chain.html which is lazily loaded.
    // If the user is on the live section and hasn't visited the chain
    // section yet, the DOM input doesn't exist — fall back to localStorage.
    var tokenEl = $('up-token');
    var token = (tokenEl ? tokenEl.value : (localStorage.getItem('upstox_token') || '')).trim();
    if (!token) {
      if (!silent) setStatus('Enter your Upstox access token first.', 'err');
      return;
    }
    // ── Off-hours guard (May 2026) ──
    // OI snapshots are frozen after market close (no new orders are
    // matched), so refetching is a 100% wasted call that risks the
    // Cloudflare 429 we hit on weekends. Allow ONE fetch if we have
    // no data at all (so the user sees the last session's OI on a
    // weekend visit); otherwise skip on closed-market silent calls.
    var marketOpenChn = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
    if (!marketOpenChn && silent && window.optionChainData) {
      return;
    }
    // Symbol dropdown was removed (Nifty 50 is the only supported symbol).
    // Read from element if it still exists for backward compatibility,
    // otherwise default to NIFTY.
    var symbolEl = $('up-symbol');
    var symbol = (symbolEl && symbolEl.value) ? symbolEl.value : 'NIFTY';
    var ikey = INSTRUMENT_KEYS[symbol];

    var headers = {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    };

    var btn = $('up-fetch-btn');
    if (!silent) {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'FETCHING...';
      }
      setStatus('Step 1/2 &mdash; Fetching expiry list...', 'info');
    }

    try {
      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var ec = await fetch(BASE + '/option/contract?instrument_key=' + encodeURIComponent(ikey), { headers: headers });
      if (!ec.ok) {
        var t1 = await ec.text();
        throw new Error('Expiry API ' + ec.status + ': ' + t1.slice(0, 280));
      }
      var ed = await ec.json();
      var expiries = Array.from(new Set((ed.data || []).map(function (c) { return c.expiry; }))).filter(Boolean).sort();
      if (!expiries.length) throw new Error('No expiries returned. Check the symbol or your token permissions.');
      var nearestExpiry = expiries[0];

      if (!silent) setStatus('Step 2/2 &mdash; Fetching option chain for <b>' + nearestExpiry + '</b>...', 'info');

      if (window._upstoxBucket) await window._upstoxBucket.acquire();
      var cu = BASE + '/option/chain?instrument_key=' + encodeURIComponent(ikey) + '&expiry_date=' + nearestExpiry;
      var cr = await fetch(cu, { headers: headers });
      if (!cr.ok) {
        var t2 = await cr.text();
        throw new Error('Chain API ' + cr.status + ': ' + t2.slice(0, 280));
      }
      var cd = await cr.json();
      var strikes = cd.data || [];
      if (!strikes.length) throw new Error('Option chain is empty. Try BANKNIFTY or check expiry.');

      strikes.sort(function (a, b) { return a.strike_price - b.strike_price; });
      var spot = strikes[0].underlying_spot_price;

      var totCE = 0, totPE = 0;
      strikes.forEach(function (s) {
        if (s.call_options && s.call_options.market_data) totCE += (s.call_options.market_data.oi || 0);
        if (s.put_options && s.put_options.market_data) totPE += (s.put_options.market_data.oi || 0);
      });
      var pcrField = strikes[0].pcr;
      var pcr = (typeof pcrField === 'number' && pcrField > 0) ? pcrField : (totCE > 0 ? totPE / totCE : 1.0);

      var ceWall = { strike: 0, oi: 0, prev_oi: 0 };
      var peWall = { strike: 0, oi: 0, prev_oi: 0 };
      strikes.forEach(function (s) {
        if (s.call_options && s.call_options.market_data) {
          var ceOi = s.call_options.market_data.oi || 0;
          if (ceOi > ceWall.oi) {
            ceWall = { strike: s.strike_price, oi: ceOi, prev_oi: s.call_options.market_data.prev_oi || 0 };
          }
        }
        if (s.put_options && s.put_options.market_data) {
          var peOi = s.put_options.market_data.oi || 0;
          if (peOi > peWall.oi) {
            peWall = { strike: s.strike_price, oi: peOi, prev_oi: s.put_options.market_data.prev_oi || 0 };
          }
        }
      });

      var ceDir = direction(ceWall.oi, ceWall.prev_oi);
      var peDir = direction(peWall.oi, peWall.prev_oi);

      renderDashboard(strikes, spot, totCE, totPE, pcr, peWall, ceWall, peDir, ceDir, nearestExpiry, symbol);

      // Expose chain to paper-trade module so option strikes can be picked
      var now = Date.now();
      window.optionChainData = {
        symbol: symbol, expiry: nearestExpiry, spot: spot,
        strikes: strikes, fetchedAt: now
      };
      if (typeof window.ptOnChainLoaded === 'function') window.ptOnChainLoaded();
      if (typeof window.ptUpdateLastFetch === 'function') window.ptUpdateLastFetch(now);

      // Show the success / live status only on manual fetches; auto-refreshes
      // are silent so the screen doesn't blink with "loaded successfully"
      // every 30 seconds.
      if (!silent) {
        setStatus('&#10003; Option chain loaded. Auto-refreshing every 30s &mdash; CE/PE prices will stay in sync with the market.', 'ok');
      }

      // Kick off the auto-refresh loop (only after the first successful fetch)
      startAutoRefresh();
    } catch (e) {
      var msg = e && e.message ? e.message : 'Unknown error';
      var hint = '';
      if (/CORS|Failed to fetch|NetworkError/i.test(msg)) {
        hint = '<br><span style="font-size:11.5px">Possible CORS error. Run the page via a local HTTP server (<code>python -m http.server 8000</code>) instead of opening as <code>file://</code>. Upstox API supports CORS for browser calls but some browsers block <code>file://</code> origin.</span>';
      } else if (/401|403|Unauthorized/.test(msg)) {
        hint = '<br><span style="font-size:11.5px">Token rejected. Upstox tokens expire daily at 3:30 AM IST &mdash; regenerate it (steps 4&ndash;7 in the help section above).</span>';
      } else if (/429/.test(msg)) {
        hint = '<br><span style="font-size:11.5px">Rate-limited by Upstox. Wait 60 seconds before retrying.</span>';
      }
      // Auto-refresh failures are silent (most common cause: token expired,
      // user already sees the chart turning OFFLINE). Manual failures show
      // the full error so the user can act.
      if (!silent) setStatus('&#10007; ' + msg + hint, 'err');
    } finally {
      if (!silent && btn) {
        btn.disabled = false;
        btn.textContent = 'FETCH OPTION CHAIN';
      }
    }
  }

  function startAutoRefresh() {
    if (autoRefreshTimer) return;          // already running — don't double-schedule
    autoRefreshTimer = setInterval(function () {
      // Skip when tab is in background (don't burn API quota on a hidden page)
      if (document.hidden) return;
      // Only refresh when the live tab is visible (uses .active class)
      var liveSec = document.getElementById('live');
      if (!liveSec || !liveSec.classList.contains('active')) return;
      // Market-hours gate: after 15:30 IST the chain is frozen — every
      // re-fetch returns the same closing snapshot, so polling is pure
      // API noise. fetchChain() also tolerates being skipped here; the
      // last cached payload remains in window.optionChainData for the
      // UI to keep rendering against.
      var marketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
      if (!marketOpen) return;
      fetchChain(true);
    }, 30000);
  }
  function stopAutoRefresh() {
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  }

  // Save token + start chart streaming. If invoked from the modal, close it.
  function saveAndStart() {
    var t = ($('up-token').value || '').trim();
    if (!t) { setStatus('Enter a token first.', 'err'); return; }
    saveToken();
    var btn = $('up-start-btn');
    var orig = btn ? btn.textContent : '';
    if (btn) {
      btn.textContent = 'SAVING...';
      btn.disabled = true;
    }
    setTimeout(function () {
      if (typeof window.tvReload === 'function') {
        window.tvReload();
      }
      // Also kick the intraday analyzer immediately — otherwise the user
      // sees the "paste your token" empty banner for up to 30 seconds
      // while the chart already shows data (chart has its own 2s poll,
      // the analyzer only runs on the 30s tickWatcher cycle).
      if (typeof window.intradayRefresh === 'function') {
        try { window.intradayRefresh(); } catch (_) {}
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = orig;
      }
      setStatus('&#10003; Token saved. Streaming live data now.', 'ok');
      // Auto-close the modal so the user immediately sees the chart loading
      setTimeout(function () {
        if (typeof window.apiCloseModal === 'function') {
          window.apiCloseModal();
        }
      }, 600);
    }, 200);
  }

  window.upFetchChain = fetchChain;
  window.upSaveToken = saveToken;
  window.upClearToken = clearTok;
  window.upSaveAndStart = saveAndStart;

  // ── API CONNECTION modal: focus trap + restore focus ─────────────
  // Tab inside the modal cycles between the modal's focusable controls.
  // On close we restore focus to whichever element opened the modal
  // (gear button, sidebar link, etc.) so keyboard users land back where
  // they were instead of on <body>.
  var apiPrevFocus = null;
  function focusableInModal(m) {
    return Array.prototype.slice.call(m.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }
  function trapApiTab(e) {
    if (e.key !== 'Tab') return;
    var m = document.getElementById('api-modal');
    if (!m || !m.classList.contains('open')) return;
    var f = focusableInModal(m);
    if (!f.length) { e.preventDefault(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  }
  function openApiModal() {
    var m = document.getElementById('api-modal');
    if (!m) return;
    apiPrevFocus = document.activeElement;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', trapApiTab);
    setTimeout(function () {
      var inp = document.getElementById('up-token');
      if (inp) inp.focus();
    }, 80);
  }
  function closeApiModal() {
    var m = document.getElementById('api-modal');
    if (!m) return;
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    document.removeEventListener('keydown', trapApiTab);
    if (apiPrevFocus && typeof apiPrevFocus.focus === 'function') {
      try { apiPrevFocus.focus(); } catch (_) { }
    }
    apiPrevFocus = null;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var m = document.getElementById('api-modal');
    if (m && m.classList.contains('open')) closeApiModal();
  });
  window.apiOpenModal = function () {
    if (typeof show === 'function') show('api-setup');
  };
  window.apiCloseModal = closeApiModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadToken);
  } else {
    loadToken();
  }
})();
