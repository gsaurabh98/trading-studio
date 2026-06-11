// Intraday option-chain dashboard — fully self-contained, INDEPENDENT of the
// Options Trading tab. Reads the intraday-owned chain store (window.itOptionChainData,
// populated by scripts/intraday-trade.js fetchChainDirect) and renders a stats grid,
// the live CE|STRIKE|PE table, an OI bar chart, support/resistance walls, and a
// bias verdict into itc-* DOM ids. Reuses the up-* CSS classes (app-level styling
// in styles/option-chain.css) but has NO runtime dependency on liveChainModule —
// so the Options tab can be removed later without breaking this view.
//
// The pure render/scoring functions (computeMaxPain, scoreBias, wallStrength,
// wallTranslation, renderChainTable, renderChart) are ported verbatim from
// scripts/live-chain.js so the numbers match what the Options tab shows; only the
// DOM wiring + data source differ. No live 1Hz LTP patch here — the table refreshes
// on the 30s chain re-fetch (intraday is a 2-30 min scalp tool, not a tick terminal).

(function intradayChainModule() {
  function $(id) { return document.getElementById(id); }

  // Market-hours / next-open via the intraday-owned helpers ONLY (exposed by
  // scripts/intraday-trade.js). Self-contained IST fallback so this module has
  // ZERO reference to the Options-tab globals (window.isMarketOpen / nextOpenLabel)
  // — it keeps working if the Options tab is removed.
  var IST_OFF_SEC = 5.5 * 3600;
  function marketOpen() {
    if (typeof window.itIsMarketOpen === 'function') return window.itIsMarketOpen();
    var ist = new Date(Date.now() + IST_OFF_SEC * 1000);
    var dow = ist.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    var mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
  }
  function nextOpen() {
    if (typeof window.itNextOpenLabel === 'function') return window.itNextOpenLabel();
    return 'next session';
  }
  function apiPaused() {
    return (typeof window.itIsApiPaused === 'function') && window.itIsApiPaused();
  }

  // ── Pure formatters (verbatim from live-chain.js) ──
  function fmt(n, d) { d = (d === undefined) ? 0 : d; return Number(n).toFixed(d); }
  function compactCr(n) {
    if (n >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
    if (n >= 1e5) return (n / 1e5).toFixed(1) + 'L';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }
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

  // Max Pain = settlement strike minimising combined option-writer payout.
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

  function wallStrength(wallOI, sideTotal) {
    if (!sideTotal || sideTotal <= 0) return { pct: 0, label: 'MILD', cls: 's-mild' };
    var pct = wallOI / sideTotal * 100;
    if (pct >= 25) return { pct: pct, label: 'VERY STRONG', cls: 's-very' };
    if (pct >= 12) return { pct: pct, label: 'STRONG', cls: 's-strong' };
    return { pct: pct, label: 'MILD', cls: 's-mild' };
  }

  function wallTranslation(side, dir, distancePts, strengthLabel) {
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

  // Bias scoring (5-input multi-factor model — verbatim from live-chain.js).
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
    return { total: total, verdict: verdict, badge: badge, color: color, action: action };
  }
  // ── Live Option Chain table (Calls | Strike | Puts) ──
  // Ported from live-chain.js but with the 1Hz LTP-poller hooks removed: the
  // table is rebuilt on each 30s chain re-fetch; no per-cell live patch.
  function renderChainTable(strikes, spot, peWallStrike, ceWallStrike, expiry, symbol, totCE, totPE, pcr) {
    if (!strikes || !strikes.length) return '<div style="padding:18px;color:var(--muted)">No option-chain data.</div>';

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

    var half = 15;
    var lo = Math.max(0, spotIdx - half);
    var hi = Math.min(strikes.length, spotIdx + half + 1);
    if (peWallIdx >= 0) { lo = Math.min(lo, peWallIdx); hi = Math.max(hi, peWallIdx + 1); }
    if (ceWallIdx >= 0) { lo = Math.min(lo, ceWallIdx); hi = Math.max(hi, ceWallIdx + 1); }
    var view = strikes.slice(lo, hi);

    var maxOI = 1;
    view.forEach(function (s) {
      var ce = (s.call_options && s.call_options.market_data) ? (+s.call_options.market_data.oi || 0) : 0;
      var pe = (s.put_options && s.put_options.market_data) ? (+s.put_options.market_data.oi || 0) : 0;
      if (ce > maxOI) maxOI = ce;
      if (pe > maxOI) maxOI = pe;
    });

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
    function oiCell(oi, side) {
      if (!isFinite(+oi) || +oi <= 0) return '<span style="color:var(--muted)">\u2014</span>';
      var pct = Math.min(100, Math.round((+oi / maxOI) * 100));
      var barW = Math.max(2, Math.min(40, Math.round(pct * 0.4)));
      var barHtml = '<span class="up-oi-bar is-' + side + '" style="width:' + barW + 'px"></span>';
      return '<span class="up-oi-bar-wrap"><span>' + fmtOiCompact(+oi) + '</span>' + barHtml + '</span>';
    }

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

    var rowsHtml = '';
    view.forEach(function (s, i) {
      var k = s.strike_price;
      var ce = s.call_options || {};
      var pe = s.put_options || {};
      var ceMd = ce.market_data || {};
      var peMd = pe.market_data || {};
      var ceG = ce.option_greeks || {};
      var peG = pe.option_greeks || {};

      var isCallItm = k <= spot;
      var isPutItm = k >= spot;
      var ceItmCls = isCallItm ? ' is-itm-call' : '';
      var peItmCls = isPutItm ? ' is-itm-put' : '';

      var ceOiD = fmtOiDelta(ceMd.oi, ceMd.prev_oi);
      var peOiD = fmtOiDelta(peMd.oi, peMd.prev_oi);

      var rowClass = '';
      if (k === ceWallStrike) rowClass = 'is-ce-wall';
      else if (k === peWallStrike) rowClass = 'is-pe-wall';
      else if (i === (spotIdx - lo)) rowClass = 'is-atm';

      rowsHtml +=
        '<tr class="' + rowClass + '">' +
          '<td class="' + ceItmCls.trim() + '">' + fmtIvLocal(ceG.iv) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.vega) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.gamma) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmt4(ceG.theta) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + fmtDeltaSigned(ceG.delta) + '</td>' +
          '<td class="' + ceItmCls.trim() + '">' + oiCell(ceMd.oi, 'call') + '</td>' +
          '<td class="' + ceItmCls.trim() + ' ' + ceOiD.cls + '">' + ceOiD.txt + '</td>' +
          '<td class="col-ltp is-call' + ceItmCls + '">' + fmtLtpLocal(ceMd.ltp) + '</td>' +
          '<td class="col-strike">' + k + '</td>' +
          '<td class="col-ltp is-put' + peItmCls + '">' + fmtLtpLocal(peMd.ltp) + '</td>' +
          '<td class="' + peItmCls.trim() + ' ' + peOiD.cls + '">' + peOiD.txt + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + oiCell(peMd.oi, 'put') + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmtDeltaSigned(peG.delta) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.theta) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.gamma) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmt4(peG.vega) + '</td>' +
          '<td class="' + peItmCls.trim() + '">' + fmtIvLocal(peG.iv) + '</td>' +
        '</tr>';

      if (spotBeforeIdx >= 0 && spotAfterIdx >= 0 && spotBeforeIdx !== spotAfterIdx && (i + lo) === spotBeforeIdx) {
        rowsHtml +=
          '<tr class="is-spot-marker">' +
            '<td colspan="17">\u2190 SPOT ' + (+spot).toLocaleString('en-IN', { maximumFractionDigits: 2 }) + ' \u2192</td>' +
          '</tr>';
      }
    });

    var mpStrike = computeMaxPain(strikes);
    var mpDeltaTxt = '';
    if (isFinite(+mpStrike) && isFinite(+spot) && +spot > 0) {
      var diff = (+mpStrike) - (+spot);
      var pctd = (diff / +spot) * 100;
      var sgn = diff > 0 ? '+' : (diff < 0 ? '\u2212' : '');
      var arrow = diff > 0 ? '\u2191' : (diff < 0 ? '\u2193' : '');
      mpDeltaTxt = ' <span style="color:var(--muted);font-weight:500">(' + arrow + ' ' + sgn + Math.abs(diff).toFixed(0) + ' \u00b7 ' + Math.abs(pctd).toFixed(2) + '%)</span>';
    }

    var open = marketOpen();
    var freshLabel = open ? 'LIVE' : ('CLOSED' + (nextOpen() ? ' \u00b7 ' + nextOpen() : ''));
    var freshDot = open ? 'up-live-dot' : 'up-live-dot is-stale';

    var summary = '' +
      '<div class="up-chain-table-summary">' +
        '<span class="up-chain-live"><span class="' + freshDot + '"></span><span class="up-live-label">' + freshLabel + '</span></span>' +
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
        '<span>Max Pain <b style="color:var(--amber)">' + (isFinite(+mpStrike) ? mpStrike : '\u2014') + '</b>' + mpDeltaTxt + '</span>' +
      '</div>';

    return summary +
      '<div class="up-chain-table-scroll">' +
        '<table class="up-chain-table">' + head + '<tbody>' + rowsHtml + '</tbody></table>' +
      '</div>';
  }
  // ── SVG OI bar chart (verbatim from live-chain.js) ──
  function renderChart(strikes, spot, peWallStrike, ceWallStrike) {
    var spotIdx = 0, minDiff = Infinity;
    strikes.forEach(function (s, i) {
      var d = Math.abs(s.strike_price - spot);
      if (d < minDiff) { minDiff = d; spotIdx = i; }
    });
    var peWallIdx = -1, ceWallIdx = -1;
    strikes.forEach(function (s, i) {
      if (s.strike_price === peWallStrike) peWallIdx = i;
      if (s.strike_price === ceWallStrike) ceWallIdx = i;
    });
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

    var W = 800, H = 320, padL = 56, padR = 20, padT = 46, padB = 100;
    var plotH = H - padT - padB;
    var n = slice.length;
    var groupW = (W - padL - padR) / n;
    var barW = Math.max(3, Math.min(14, (groupW - 4) / 2));

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;display:block;font-variant-numeric:tabular-nums" aria-label="Live OI Chart">';
    svg += '<defs>'
      + '<linearGradient id="itcGradPE" x1="0" y1="0" x2="0" y2="1">'
      +   '<stop offset="0%" stop-color="#19d196"/><stop offset="100%" stop-color="#078a5b"/>'
      + '</linearGradient>'
      + '<linearGradient id="itcGradCE" x1="0" y1="0" x2="0" y2="1">'
      +   '<stop offset="0%" stop-color="#f4546e"/><stop offset="100%" stop-color="#b21832"/>'
      + '</linearGradient>'
      + '</defs>';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (t) {
      var y = padT + plotH * (1 - t);
      svg += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(128,128,128,' + (t === 0 ? '0.28' : '0.10') + ')" stroke-width="1"' + (t === 0 ? '' : ' stroke-dasharray="2,4"') + '/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (y + 4) + '" text-anchor="end" fill="var(--muted)" font-size="10" font-family="\'IBM Plex Sans\',system-ui,sans-serif">' + compactKM(maxOI * t) + '</text>';
    });

    var peSliceIdx = -1, ceSliceIdx = -1, spotSliceIdx = -1;
    var spotBeforeIdx = -1, spotAfterIdx = -1;
    slice.forEach(function (s, i) {
      if (s.strike_price === peWallStrike) peSliceIdx = i;
      if (s.strike_price === ceWallStrike) ceSliceIdx = i;
      if (Math.abs(s.strike_price - spot) < minDiff + 0.001) spotSliceIdx = i;
      if (s.strike_price <= spot) spotBeforeIdx = i;
      if (s.strike_price >= spot && spotAfterIdx === -1) spotAfterIdx = i;
    });

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
      var peIsWall = (i === peSliceIdx);
      var ceIsWall = (i === ceSliceIdx);
      var rx = Math.min(3, barW / 2);
      svg += '<rect x="' + (cx - barW - 1) + '" y="' + peY + '" width="' + barW + '" height="' + Math.max(0, peH) + '" rx="' + rx + '" fill="url(#itcGradPE)" opacity="' + (peIsWall ? '1' : '0.6') + '"' + (peIsWall ? ' stroke="#19d196" stroke-width="1"' : '') + '/>';
      svg += '<rect x="' + (cx + 1) + '" y="' + ceY + '" width="' + barW + '" height="' + Math.max(0, ceH) + '" rx="' + rx + '" fill="url(#itcGradCE)" opacity="' + (ceIsWall ? '1' : '0.6') + '"' + (ceIsWall ? ' stroke="#f4546e" stroke-width="1"' : '') + '/>';
      var isWallStrike = peIsWall || ceIsWall;
      var labelWeight = isWallStrike ? '700' : '400';
      var labelFill = isWallStrike ? 'var(--text)' : 'var(--muted)';
      var lx = cx;
      var ly = padT + plotH + 8;
      svg += '<text x="' + lx + '" y="' + ly + '"'
        + ' transform="rotate(-90 ' + lx + ' ' + ly + ')"'
        + ' text-anchor="end" dominant-baseline="middle"'
        + ' fill="' + labelFill + '" font-size="10.5" font-weight="' + labelWeight + '" font-family="\'IBM Plex Sans\',system-ui,sans-serif">'
        + s.strike_price + '</text>';
      if (i === peSliceIdx) svg += '<text x="' + cx + '" y="' + (peY - 6) + '" text-anchor="middle" fill="#09a86e" font-size="10" font-weight="700" font-family="\'IBM Plex Sans\',system-ui,sans-serif" letter-spacing="0.5">PE WALL</text>';
      if (i === ceSliceIdx) svg += '<text x="' + cx + '" y="' + (ceY - 6) + '" text-anchor="middle" fill="#c91f3a" font-size="10" font-weight="700" font-family="\'IBM Plex Sans\',system-ui,sans-serif" letter-spacing="0.5">CE WALL</text>';
    });

    svg += '<line x1="' + spotX + '" y1="' + padT + '" x2="' + spotX + '" y2="' + (padT + plotH) + '" stroke="var(--info)" stroke-width="1.5" stroke-dasharray="5,4"/>';
    var spotLbl = 'SPOT ' + fmt(spot, 2);
    var lblW = spotLbl.length * 6.4 + 16;
    var lblX = Math.max(padL, Math.min(W - padR - lblW, spotX - lblW / 2));
    svg += '<rect x="' + lblX + '" y="2" width="' + lblW + '" height="18" rx="9" fill="var(--info)" opacity="0.16"/>';
    svg += '<text x="' + (lblX + lblW / 2) + '" y="14.5" text-anchor="middle" fill="var(--info)" font-size="11" font-weight="700" font-family="\'IBM Plex Sans\',system-ui,sans-serif" letter-spacing="0.5">' + spotLbl + '</text>';

    var legY = H - 24, legTextY = H - 20;
    svg += '<rect x="' + padL + '" y="' + (H - 30) + '" width="12" height="12" fill="url(#itcGradPE)" rx="3"/>';
    svg += '<text x="' + (padL + 18) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="\'IBM Plex Sans\',system-ui,sans-serif">Put OI</text>';
    svg += '<rect x="' + (padL + 90) + '" y="' + (H - 30) + '" width="12" height="12" fill="url(#itcGradCE)" rx="3"/>';
    svg += '<text x="' + (padL + 108) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="\'IBM Plex Sans\',system-ui,sans-serif">Call OI</text>';
    var spotLegX = padL + 180;
    svg += '<line x1="' + spotLegX + '" y1="' + legY + '" x2="' + (spotLegX + 26) + '" y2="' + legY + '" stroke="var(--info)" stroke-width="1.6" stroke-dasharray="5,4" stroke-linecap="round"/>';
    svg += '<text x="' + (spotLegX + 32) + '" y="' + legTextY + '" fill="var(--text-soft)" font-size="11" font-family="\'IBM Plex Sans\',system-ui,sans-serif">Spot</text>';
    svg += '</svg>';
    return svg;
  }

  // ── Dashboard orchestrator — derives metrics + walls from itOptionChainData ──
  function renderDashboard(strikes, spot, totCE, totPE, pcr, peWall, ceWall, peDir, ceDir, expiry, symbol) {
    // NOTE: the old "Live Snapshot" stats strip (Spot / PCR / Max Pain / OI Bias /
    // Total Call OI / Total Put OI) was removed — that data is already surfaced by
    // the Intraday Context cards (renderCards() in intraday-trade.js). This
    // dashboard now shows only the non-duplicated views: chain table, OI chart,
    // walls, and verdict.
    var host = $('itc-dashboard');
    if (host) host.style.display = 'block';

    var chainTableEl = $('itc-chain-table-wrap');
    if (chainTableEl) {
      chainTableEl.innerHTML = renderChainTable(strikes, spot, peWall.strike, ceWall.strike, expiry, symbol, totCE, totPE, pcr);
      var doCentreOnSpot = function () {
        var newScroll = chainTableEl.querySelector('.up-chain-table-scroll');
        if (!newScroll) return;
        // Bail when the table isn't laid out (tab inactive OR the chain accordion
        // is collapsed → display:none). Prevents an infinite 60ms retry loop on a
        // zero-height scroll container.
        if (newScroll.offsetParent === null) return;
        var spotRow = newScroll.querySelector('tr.is-spot-marker') || newScroll.querySelector('tr.is-atm');
        if (!spotRow) return;
        var thead = newScroll.querySelector('thead');
        var headH = thead ? thead.offsetHeight : 0;
        var rowTop = spotRow.offsetTop;
        var rowH = spotRow.offsetHeight;
        var viewH = newScroll.clientHeight;
        if (viewH <= 0 || rowTop <= 0) { setTimeout(doCentreOnSpot, 60); return; }
        var avail = Math.max(rowH * 2, viewH - headH);
        newScroll.scrollTop = Math.max(0, rowTop - headH - (avail / 2) + (rowH / 2));
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(doCentreOnSpot);
      else setTimeout(doCentreOnSpot, 0);
    }

    if ($('itc-chart-wrap')) $('itc-chart-wrap').innerHTML = renderChart(strikes, spot, peWall.strike, ceWall.strike);

    var distFloor = Math.max(0, spot - peWall.strike);
    var distCeil = Math.max(0, ceWall.strike - spot);
    var peDelta = peWall.oi - peWall.prev_oi;
    var ceDelta = ceWall.oi - ceWall.prev_oi;
    var peStr = wallStrength(peWall.oi, totPE);
    var ceStr = wallStrength(ceWall.oi, totCE);
    var pePosWord = spot >= peWall.strike ? 'below spot' : 'above spot';
    var cePosWord = spot <= ceWall.strike ? 'above spot' : 'below spot';
    var peTrans = wallTranslation('floor', peDir, distFloor, peStr.label);
    var ceTrans = wallTranslation('ceiling', ceDir, distCeil, ceStr.label);
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
    if ($('itc-walls-grid')) $('itc-walls-grid').innerHTML = wallsHtml;

    // NOTE: the OI "VERDICT · SCORE" bias card was removed by request — the
    // intraday tab's own setup/trade-plan engine owns the trade verdict, so a
    // second OI-only verdict here was redundant/confusing. The walls + chart
    // still convey the OI structure descriptively.
    if ($('itc-dashboard-title')) $('itc-dashboard-title').innerHTML = 'Live Snapshot &mdash; <span style="color:var(--info);font-weight:500">' + symbol + ' &middot; expiry ' + expiry + '</span>';
  }

  // Read the intraday-owned chain store, derive walls/dirs, and render. Safe to
  // call repeatedly (on chain-loaded + 30s refresh + section activate).
  function render() {
    var chain = window.itOptionChainData;
    var host = $('itc-dashboard');
    if (!chain || !chain.strikes || !chain.strikes.length) {
      if (host) host.style.display = 'none';
      return;
    }
    var strikes = chain.strikes.slice().sort(function (a, b) { return a.strike_price - b.strike_price; });
    var spot = chain.spot;
    if (!isFinite(+spot) && strikes[0]) spot = strikes[0].underlying_spot_price;

    var totCE = 0, totPE = 0;
    strikes.forEach(function (s) {
      if (s.call_options && s.call_options.market_data) totCE += (s.call_options.market_data.oi || 0);
      if (s.put_options && s.put_options.market_data) totPE += (s.put_options.market_data.oi || 0);
    });
    var pcrField = strikes[0] ? strikes[0].pcr : null;
    var pcr = (typeof pcrField === 'number' && pcrField > 0) ? pcrField : (totCE > 0 ? totPE / totCE : 1.0);

    var ceWall = { strike: 0, oi: 0, prev_oi: 0 };
    var peWall = { strike: 0, oi: 0, prev_oi: 0 };
    strikes.forEach(function (s) {
      if (s.call_options && s.call_options.market_data) {
        var ceOi = s.call_options.market_data.oi || 0;
        if (ceOi > ceWall.oi) ceWall = { strike: s.strike_price, oi: ceOi, prev_oi: s.call_options.market_data.prev_oi || 0 };
      }
      if (s.put_options && s.put_options.market_data) {
        var peOi = s.put_options.market_data.oi || 0;
        if (peOi > peWall.oi) peWall = { strike: s.strike_price, oi: peOi, prev_oi: s.put_options.market_data.prev_oi || 0 };
      }
    });

    var ceDir = direction(ceWall.oi, ceWall.prev_oi);
    var peDir = direction(peWall.oi, peWall.prev_oi);

    renderDashboard(strikes, spot, totCE, totPE, pcr, peWall, ceWall, peDir, ceDir, chain.expiry || '\u2014', chain.symbol || 'NIFTY');
    wireTooltips();
  }

  function wireTooltips() {
    try {
      var host = $('itc-dashboard');
      if (host && typeof window.itWireTooltips === 'function') window.itWireTooltips(host);
    } catch (_) {}
  }

  function setStatus(msg, type) {
    var el = $('itc-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.className = 'up-status up-status-' + (type || 'neutral');
    el.innerHTML = msg || '';
  }

  // Manual fetch (Fetch / Refresh button). Uses the intraday-owned fetch only.
  function fetchChain(force) {
    if (apiPaused()) { setStatus('Intraday API is paused \u2014 resume it from the banner to load the option chain.', 'err'); return; }
    if (typeof window.itFetchChain !== 'function') { setStatus('Chain fetch unavailable.', 'err'); return; }
    var btn = $('itc-fetch-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'FETCHING\u2026'; }
    setStatus('Fetching option chain\u2026', 'info');
    Promise.resolve(window.itFetchChain(force)).then(function () {
      render();
      var have = window.itOptionChainData && window.itOptionChainData.strikes && window.itOptionChainData.strikes.length;
      setStatus(have ? '' : 'No option chain returned \u2014 check your token / market hours, then retry.', have ? 'ok' : 'err');
    }).catch(function (e) {
      setStatus('\u2717 ' + ((e && e.message) || 'Fetch failed'), 'err');
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'FETCH / REFRESH CHAIN'; }
    });
  }

  // 30s silent refresh — only while the intraday tab is active, market is open,
  // API isn't paused, and the page is visible. fetchChainDirect fires
  // window.itcOnChainLoaded → render(), so we just trigger the fetch here.
  var refreshTimer = null;
  function startAutoRefresh() {
    if (refreshTimer) return;
    refreshTimer = setInterval(function () {
      if (document.hidden) return;
      var sec = document.getElementById('intraday-trade');
      if (!sec || !sec.classList.contains('active')) return;
      if (!marketOpen() || apiPaused()) return;
      if (typeof window.itFetchChain === 'function') Promise.resolve(window.itFetchChain(true)).then(render).catch(function () {});
    }, 30000);
  }

  // ── Exposed API (intraday-owned namespace) ──
  window.itcRender = render;
  window.itcOnChainLoaded = function () { try { render(); } catch (_) {} };
  window.itcFetchChain = function () { fetchChain(true); };
  window.itcActivate = function () {
    render();
    startAutoRefresh();
    if (!window.itOptionChainData || !window.itOptionChainData.strikes || !window.itOptionChainData.strikes.length) {
      if (!apiPaused() && typeof window.itFetchChain === 'function') {
        Promise.resolve(window.itFetchChain(false)).then(render).catch(function () {});
      }
    }
  };
})();
