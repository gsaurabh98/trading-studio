// CPR Bias Co-Pilot — OI/CPR/VWAP bias calculator + Pine-script copy.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split). Loaded via a plain <script src> in the SAME
// document position (classic script), so window.calcBias / resetBias /
// loadBiasExample / copyPine stay global for the inline handlers in
// content/bias.html, and the DOMContentLoaded init timing is unchanged.

(function biasModule() {
  var PINE_SCRIPT_CODE = ''
    + '//@version=5\n'
    + 'indicator("CPR Bias Co-Pilot v1", overlay=true, max_labels_count=500)\n'
    + '\n'
    + '// ─── INPUTS ───\n'
    + 'showCPR    = input.bool(true,  "Show CPR")\n'
    + 'showVWAP   = input.bool(true,  "Show VWAP")\n'
    + 'showInfo   = input.bool(true,  "Show top-right info box")\n'
    + 'narrowPct  = input.float(0.20, "Narrow CPR % threshold (Nifty=0.20, BNF=0.30)", step=0.05)\n'
    + 'wideMult   = input.float(2.5,  "Wide multiplier (wide = narrow * this)",        step=0.5)\n'
    + 'widePct    = narrowPct * wideMult\n'
    + '\n'
    + '// ─── CPR FROM PREV-DAY OHLC ───\n'
    + 'prevH = request.security(syminfo.tickerid, "D", high[1],  lookahead=barmerge.lookahead_on)\n'
    + 'prevL = request.security(syminfo.tickerid, "D", low[1],   lookahead=barmerge.lookahead_on)\n'
    + 'prevC = request.security(syminfo.tickerid, "D", close[1], lookahead=barmerge.lookahead_on)\n'
    + '\n'
    + 'pp     = (prevH + prevL + prevC) / 3.0\n'
    + 'bcCalc = (prevH + prevL) / 2.0\n'
    + 'tcCalc = pp + (pp - bcCalc)\n'
    + '\n'
    + '// real TC / BC by value (handles inversion)\n'
    + 'tcVal      = math.max(tcCalc, bcCalc)\n'
    + 'bcVal      = math.min(tcCalc, bcCalc)\n'
    + 'isInverted = bcCalc > tcCalc\n'
    + '\n'
    + '// width\n'
    + 'cprWidth    = tcVal - bcVal\n'
    + 'cprWidthPct = (cprWidth / close) * 100\n'
    + 'widthCat    = cprWidthPct < narrowPct ? "NARROW" : cprWidthPct > widePct ? "WIDE" : "MEDIUM"\n'
    + '\n'
    + '// price location\n'
    + 'priceLoc = close > tcVal ? "ABOVE BAND" : close < bcVal ? "BELOW BAND" : "INSIDE BAND"\n'
    + '\n'
    + '// VWAP\n'
    + 'vw = ta.vwap(hlc3)\n'
    + '\n'
    + '// ─── BIAS SCORE ───\n'
    + 'shapeScore = isInverted ? -1 : 1\n'
    + 'locScore   = priceLoc == "ABOVE BAND" ? 2 : priceLoc == "BELOW BAND" ? -2 : 0\n'
    + 'baseScore  = shapeScore + locScore\n'
    + 'widthBoost = widthCat == "NARROW" ? (baseScore > 0 ?  1 : baseScore < 0 ? -1 : 0) : widthCat == "WIDE" ? (baseScore > 0 ? -1 : baseScore < 0 ?  1 : 0) : 0\n'
    + 'vwapScore  = close > vw ? 1 : -1\n'
    + 'score      = baseScore + widthBoost + vwapScore\n'
    + '\n'
    + 'bias = score >=  3 ? "STRONG CE" : score >=  1 ? "CE BIAS" : score <= -3 ? "STRONG PE" : score <= -1 ? "PE BIAS" : "NO TRADE"\n'
    + '\n'
    + 'biasColor = score >=  3 ? color.new(color.green, 0)  : score >=  1 ? color.new(color.green, 30) : score <= -3 ? color.new(color.red,   0)  : score <= -1 ? color.new(color.red,   30) : color.new(color.gray, 30)\n'
    + '\n'
    + '// ─── PLOTS ───\n'
    + 'plot(showCPR  ? pp    : na, "PP",   color=color.new(color.blue,   0), linewidth=2)\n'
    + 'plot(showCPR  ? tcVal : na, "TC",   color=color.new(color.green,  0), linewidth=1)\n'
    + 'plot(showCPR  ? bcVal : na, "BC",   color=color.new(color.red,    0), linewidth=1)\n'
    + 'plot(showVWAP ? vw    : na, "VWAP", color=color.new(color.orange, 0), linewidth=2)\n'
    + '\n'
    + '// ─── INFO LABEL (top-right of last bar) ───\n'
    + 'var label infoLbl = na\n'
    + 'if showInfo and barstate.islast\n'
    + '    label.delete(infoLbl)\n'
    + '    txt = "CPR: "    + (isInverted ? "INVERTED" : "NORMAL") + "\\n" +\n'
    + '          "Width: "  + widthCat + " (" + str.tostring(cprWidthPct, "#.###") + "%)\\n" +\n'
    + '          "Price: "  + priceLoc + "\\n" +\n'
    + '          "VWAP: "   + (close > vw ? "ABOVE" : "BELOW") + "\\n" +\n'
    + '          "─────────\\n" +\n'
    + '          "BIAS: "   + bias + "\\n" +\n'
    + '          "Score: "  + str.tostring(score)\n'
    + '    infoLbl := label.new(bar_index, high, txt, style=label.style_label_lower_left, color=biasColor, textcolor=color.white, size=size.normal)\n';

  function $(id) { return document.getElementById(id); }
  function num(id) { return parseFloat($(id).value) || 0; }

  window.calcBias = function () {
    var prevH = num('bc-prevH'), prevL = num('bc-prevL'), prevC = num('bc-prevC');
    var spot = num('bc-spot'), tH = num('bc-todayH'), tL = num('bc-todayL');
    var vix = num('bc-vix'), pcr = num('bc-pcr');
    var trend = parseFloat($('bc-trend').value);
    var narrowThresh = parseFloat($('bc-inst').value);

    if (!prevH || !prevL || !prevC || !spot) {
      $('bc-result-card').innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted)">Enter Yesterday H, L, C and Current Spot to see the bias</div>';
      return;
    }

    // ── CPR computation ──
    var pp = (prevH + prevL + prevC) / 3;
    var bcRaw = (prevH + prevL) / 2;
    var tcRaw = pp + (pp - bcRaw);
    var tcVal = Math.max(tcRaw, bcRaw);
    var bcVal = Math.min(tcRaw, bcRaw);
    var isInverted = bcRaw > tcRaw;
    var cprW = tcVal - bcVal;
    var widthPct = (cprW / spot) * 100;
    var widthCat = widthPct < narrowThresh ? 'NARROW' : widthPct > narrowThresh * 2.5 ? 'WIDE' : 'MEDIUM';
    var priceLoc = spot > tcVal ? 'ABOVE BAND' : spot < bcVal ? 'BELOW BAND' : 'INSIDE BAND';

    // ── Score components ──
    var scores = [];

    // 1. CPR shape: ±1
    var shapeScore = isInverted ? -1 : 1;
    scores.push({ label: 'CPR shape (' + (isInverted ? 'inverted' : 'normal') + ')', val: shapeScore, range: '\u00b11' });

    // 2. Price location: ±2
    var locScore = priceLoc === 'ABOVE BAND' ? 2 : priceLoc === 'BELOW BAND' ? -2 : 0;
    scores.push({ label: 'Price location (' + priceLoc.toLowerCase() + ')', val: locScore, range: '\u00b12' });

    // 3. CPR width: ±1
    var baseScore = shapeScore + locScore;
    var widthScore = 0;
    if (widthCat === 'NARROW') widthScore = baseScore > 0 ? 1 : baseScore < 0 ? -1 : 0;
    else if (widthCat === 'WIDE') widthScore = baseScore > 0 ? -1 : baseScore < 0 ? 1 : 0;
    scores.push({ label: 'CPR width (' + widthCat.toLowerCase() + ', ' + widthPct.toFixed(3) + '%)', val: widthScore, range: '\u00b11' });

    // 4. VIX: ±1
    var vixScore = 0, vixCat = 'normal';
    if (vix > 0 && vix < 13) { vixCat = 'low'; vixScore = baseScore > 0 ? 1 : baseScore < 0 ? -1 : 0; }
    else if (vix > 20) { vixCat = 'high'; vixScore = -1; }
    scores.push({ label: 'India VIX (' + vixCat + ', ' + vix.toFixed(2) + ')', val: vixScore, range: '\u00b11' });

    // 5. PCR: ±1
    var pcrScore = 0, pcrCat = 'neutral';
    if (pcr > 1.2) { pcrCat = 'bullish'; pcrScore = 1; }
    else if (pcr < 0.8) { pcrCat = 'bearish'; pcrScore = -1; }
    scores.push({ label: 'PCR (' + pcrCat + ', ' + pcr.toFixed(2) + ')', val: pcrScore, range: '\u00b11' });

    // 6. Higher-TF trend: ±2
    scores.push({ label: 'Higher-TF trend', val: trend, range: '\u00b12' });

    var total = scores.reduce(function (s, x) { return s + x.val; }, 0);

    // ── Bias bucket + action ──
    var bucket, bucketClass, action, riskWarnings = [];
    if (total >= 4) {
      bucket = 'STRONG CE'; bucketClass = 'bias-strong-ce';
      action = '<b>High-conviction CE day.</b> Wait for a pullback to <b>TC, PP, or VWAP</b>; require a bullish rejection candle (engulfing/hammer) before entry. <b>SL</b> below BC. <b>Targets:</b> today\'s high &rarr; R1 &rarr; next round number.';
    } else if (total >= 1) {
      bucket = 'CE BIAS'; bucketClass = 'bias-ce';
      action = '<b>CE-favorable framework.</b> Wait for a clean pullback + bullish rejection candle at TC or PP. <b>SL</b> below BC. <b>Targets:</b> today\'s high &rarr; R1.';
    } else if (total <= -4) {
      bucket = 'STRONG PE'; bucketClass = 'bias-strong-pe';
      action = '<b>High-conviction PE day.</b> Wait for a pullback up to <b>TC, PP, or VWAP</b>; require a bearish rejection candle (engulfing/shooting star) before entry. <b>SL</b> above BC. <b>Targets:</b> today\'s low &rarr; S1 &rarr; next round number.';
    } else if (total <= -1) {
      bucket = 'PE BIAS'; bucketClass = 'bias-pe';
      action = '<b>PE-favorable framework.</b> Wait for a clean pullback up + bearish rejection candle at TC or PP. <b>SL</b> above BC. <b>Targets:</b> today\'s low &rarr; S1.';
    } else {
      bucket = 'NO TRADE'; bucketClass = 'bias-no';
      action = '<b>No clear edge.</b> Stand aside until: (a) price breaks the band with volume confirmation, OR (b) a Fibonacci confluence trigger appears at a fresh extreme. Forcing a trade in this state is the #1 way beginners lose money.';
    }

    // ── Risk warnings ──
    if (vix > 20) riskWarnings.push('VIX &gt; 20: reduce position size by 50%, widen SL by 30%');
    if (widthCat === 'WIDE') riskWarnings.push('Wide CPR: range day expected &mdash; option BUYERS struggle. Consider sitting out, or sell premium with a hedge.');
    if (priceLoc === 'INSIDE BAND' && widthCat === 'NARROW') riskWarnings.push('Price inside narrow CPR: choppy open expected. Wait for the first 30-min range break.');
    if (Math.abs(total) >= 4) riskWarnings.push('High-conviction setup &mdash; stick to the plan, do NOT over-size. Risk 1\u20132% of capital, not more.');
    if (priceLoc === 'INSIDE BAND' && widthCat === 'WIDE') riskWarnings.push('Inside wide CPR: lowest-edge state. Stand aside.');

    // ── Render BREAKDOWN (inside <details>) ──
    var breakdownHtml = '<div class="score-row" style="font-weight:600;background:rgba(255,255,255,0.05)">'
      + '<div>SIGNAL</div><div style="text-align:center">CONTRIBUTION</div><div style="text-align:right">SCORE</div></div>';
    scores.forEach(function (s) {
      var cls = s.val > 0 ? 'score-pos' : s.val < 0 ? 'score-neg' : 'score-neu';
      var contrib = s.val > 0 ? 'CE +' + s.val : s.val < 0 ? 'PE ' + s.val : 'neutral';
      var sign = s.val > 0 ? '+' : '';
      breakdownHtml += '<div class="score-row">'
        + '<div>' + s.label + ' <span style="opacity:0.5;font-size:11.5px">[' + s.range + ']</span></div>'
        + '<div style="text-align:center" class="' + cls + '"><b>' + contrib + '</b></div>'
        + '<div style="text-align:right" class="' + cls + '"><b>' + sign + s.val + '</b></div></div>';
    });
    var totalCls = total > 0 ? 'score-pos' : total < 0 ? 'score-neg' : 'score-neu';
    breakdownHtml += '<div class="score-row score-total">'
      + '<div>TOTAL SCORE</div>'
      + '<div style="text-align:center;opacity:0.7">range: -8 to +8</div>'
      + '<div style="text-align:right" class="' + totalCls + '"><b>' + (total >= 0 ? '+' : '') + total + '</b></div></div>';
    $('bc-breakdown').innerHTML = breakdownHtml;

    // ── Render COMBINED RESULT card ──
    var bcDisp = (isInverted ? bcRaw : bcVal).toFixed(2);
    var tcDisp = (isInverted ? tcRaw : tcVal).toFixed(2);
    var shapeBadge = isInverted
      ? '<span style="color:var(--bear);font-weight:600">INVERTED</span>'
      : '<span style="color:var(--bull);font-weight:600">NORMAL</span>';
    var widthBadge = '<b>' + widthCat + '</b> <span style="opacity:0.6;font-size:12px">(' + widthPct.toFixed(3) + '%)</span>';
    var locBadge = priceLoc === 'ABOVE BAND' ? '<b style="color:var(--bull)">ABOVE BAND</b>'
      : priceLoc === 'BELOW BAND' ? '<b style="color:var(--bear)">BELOW BAND</b>'
        : '<b style="color:var(--neutral)">INSIDE BAND</b>';

    var resultHtml = ''
      // Top: bias + score
      + '<div style="text-align:center;padding:28px 20px 22px;background:rgba(255,255,255,0.025);border-bottom:1px solid var(--border)">'
      + '<div style="font-size:11px;letter-spacing:2px;color:var(--muted);font-family:\'IBM Plex Mono\',monospace;margin-bottom:12px">FRAMEWORK BIAS</div>'
      + '<span class="bias-bucket ' + bucketClass + '" style="font-size:24px">' + bucket + '</span>'
      + '<div style="margin-top:14px;font-family:\'IBM Plex Mono\',monospace;font-size:13px;color:var(--muted)">Score <b style="color:var(--text)">' + (total >= 0 ? '+' : '') + total + '</b> &middot; range -8 to +8</div>'
      + '</div>'
      // CPR strip
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;font-family:\'IBM Plex Mono\',monospace;font-size:13.5px;border-bottom:1px solid var(--border)">'
      + '<div style="padding:14px 16px;text-align:center;border-right:1px solid var(--border)"><div style="font-size:11px;color:var(--muted);letter-spacing:1px;margin-bottom:5px">BC</div><b>' + bcDisp + '</b></div>'
      + '<div style="padding:14px 16px;text-align:center;border-right:1px solid var(--border);background:rgba(255,255,255,0.02)"><div style="font-size:11px;color:var(--muted);letter-spacing:1px;margin-bottom:5px">PP</div><b>' + pp.toFixed(2) + '</b></div>'
      + '<div style="padding:14px 16px;text-align:center"><div style="font-size:11px;color:var(--muted);letter-spacing:1px;margin-bottom:5px">TC</div><b>' + tcDisp + '</b></div>'
      + '</div>'
      // Status row
      + '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;font-family:\'IBM Plex Mono\',monospace;font-size:12.5px;border-bottom:1px solid var(--border)">'
      + '<div style="padding:11px 16px;text-align:center;border-right:1px solid var(--border)"><span style="color:var(--muted)">Shape</span><br>' + shapeBadge + '</div>'
      + '<div style="padding:11px 16px;text-align:center;border-right:1px solid var(--border)"><span style="color:var(--muted)">Width</span><br>' + widthBadge + '</div>'
      + '<div style="padding:11px 16px;text-align:center"><span style="color:var(--muted)">Price</span><br>' + locBadge + '</div>'
      + '</div>'
      // Action
      + '<div style="padding:18px 20px;line-height:1.7;font-size:14px">'
      + action
      + '</div>';

    if (riskWarnings.length > 0) {
      resultHtml += '<div style="margin:0 20px 18px;padding:12px 14px;background:rgba(212,148,26,0.08);border-left:3px solid #d4941a;border-radius:5px;font-size:12.5px;line-height:1.7">'
        + '<b>Risk notes:</b><br>'
        + riskWarnings.map(function (w) { return '&bull; ' + w; }).join('<br>')
        + '</div>';
    }
    $('bc-result-card').innerHTML = resultHtml;
  };

  window.resetBias = function () {
    var defaults = { 'bc-prevH': 24400, 'bc-prevL': 24050, 'bc-prevC': 24100, 'bc-spot': 24080, 'bc-vix': 14, 'bc-pcr': 1.05 };
    Object.keys(defaults).forEach(function (id) { if ($(id)) $(id).value = defaults[id]; });
    $('bc-trend').value = '0';
    calcBias();
  };

  window.loadBiasExample = function () {
    // Today's chart we walked through (inverted CPR Nifty day)
    var ex = { 'bc-prevH': 24170, 'bc-prevL': 24125, 'bc-prevC': 24119, 'bc-spot': 24067, 'bc-vix': 14.5, 'bc-pcr': 0.92 };
    Object.keys(ex).forEach(function (id) { if ($(id)) $(id).value = ex[id]; });
    $('bc-trend').value = '-1';
    calcBias();
  };

  window.copyPine = function () {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = PINE_SCRIPT_CODE;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(PINE_SCRIPT_CODE).catch(fallback);
    } else {
      fallback();
    }
    var btn = document.querySelector('.pine-copy-btn');
    if (btn) {
      var orig = btn.textContent;
      btn.textContent = 'COPIED \u2713';
      btn.style.background = 'var(--bull)';
      setTimeout(function () { btn.textContent = orig; btn.style.background = ''; }, 1800);
    }
  };

  // Render Pine code into <pre> once DOM is ready
  function renderPine() {
    var codeEl = document.querySelector('#pine-code code');
    if (codeEl) codeEl.textContent = PINE_SCRIPT_CODE;
  }

  function init() {
    renderPine();
    if ($('bc-prevH')) calcBias();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
