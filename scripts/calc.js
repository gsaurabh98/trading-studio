// Position-size / R:R / stop-loss / lot-value calculators.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split). Loaded via a plain <script src> in the SAME
// document position, so it stays a classic (non-module) script: the top-level
// function declarations (calcPosSize / calcRR / calcSL / calcLotValue / fmtINR)
// remain global, exactly as before, so the inline oninput/onchange handlers in
// content/calc.html resolve against them at event time. seedCalcOutputs stays
// on window because the lazy-content loader calls it after content/calc.html
// is injected (the inputs don't exist on initial paint).

function fmtINR(n) { if (!isFinite(n)) return '&mdash;'; var s = Math.abs(n) >= 10000000 ? ('&#8377;' + (n / 10000000).toFixed(2) + ' Cr') : Math.abs(n) >= 100000 ? ('&#8377;' + (n / 100000).toFixed(2) + ' L') : ('&#8377;' + Math.round(n).toLocaleString('en-IN')); return s; }

function calcPosSize() {
  var cap = +document.getElementById('ps-cap').value || 0;
  var risk = +document.getElementById('ps-risk').value || 0;
  var sl = +document.getElementById('ps-sl').value || 0;
  var lot = +document.getElementById('ps-lot').value || 1;
  var maxLoss = cap * risk / 100;
  var perLotRisk = sl * lot;
  var maxLots = perLotRisk > 0 ? Math.floor(maxLoss / perLotRisk) : 0;
  var actualRisk = maxLots * perLotRisk;
  var out = document.getElementById('ps-out');
  if (maxLots < 1) {
    out.innerHTML = '<b class="neg">0 lots possible</b> &middot; SL too wide for risk budget<br><span class="muted">Max loss budget: ' + fmtINR(maxLoss) + ' &middot; Risk per lot: ' + fmtINR(perLotRisk) + '<br>Fix: tighten SL, raise capital, or skip the trade</span>';
  } else {
    out.innerHTML = '<b>' + maxLots + ' lot' + (maxLots > 1 ? 's' : '') + '</b> maximum<br><span class="muted">Max loss budget: ' + fmtINR(maxLoss) + ' &middot; Actual risk at ' + maxLots + ' lots: ' + fmtINR(actualRisk) + ' &middot; Shares exposure: ' + (maxLots * lot).toLocaleString('en-IN') + '</span>';
  }
}

function calcRR() {
  var e = +document.getElementById('rr-e').value || 0;
  var s = +document.getElementById('rr-s').value || 0;
  var t = +document.getElementById('rr-t').value || 0;
  var dir = document.getElementById('rr-dir').value;
  var risk = dir === 'long' ? (e - s) : (s - e);
  var reward = dir === 'long' ? (t - e) : (e - t);
  var out = document.getElementById('rr-out');
  if (risk <= 0) { out.innerHTML = '<b class="neg">Invalid SL</b><br><span class="muted">For ' + dir + ', SL must be ' + (dir === 'long' ? 'below' : 'above') + ' entry</span>'; return; }
  if (reward <= 0) { out.innerHTML = '<b class="neg">Invalid target</b><br><span class="muted">For ' + dir + ', target must be ' + (dir === 'long' ? 'above' : 'below') + ' entry</span>'; return; }
  var rr = reward / risk;
  var verdict = rr >= 2.5 ? '<b><svg class="ico ico-ok" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5 11 15l4.5-6"/></svg> EXCELLENT</b> &mdash; take it' : rr >= 2 ? '<b><svg class="ico ico-ok" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5 11 15l4.5-6"/></svg> PASSES 1:2 RULE</b>' : rr >= 1.5 ? '<b class="neu"><svg class="ico ico-warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> MARGINAL</b> &mdash; skip or tighten SL' : '<b class="neg"><svg class="ico ico-err" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/></svg> REJECT</b> &mdash; does not clear 1:2 minimum';
  out.innerHTML = 'Risk: <b>&#8377;' + risk.toFixed(2) + '</b> &nbsp;|&nbsp; Reward: <b>&#8377;' + reward.toFixed(2) + '</b><br>R:R ratio <b>1 : ' + rr.toFixed(2) + '</b><br>' + verdict;
}

function calcSL() {
  var p = +document.getElementById('sl-p').value || 0;
  var pct = +document.getElementById('sl-pct').value || 0;
  var lots = +document.getElementById('sl-lots').value || 0;
  var lot = +document.getElementById('sl-lot').value || 1;
  var slPrice = p * (1 - pct / 100);
  var lossPerLot = (p - slPrice) * lot;
  var totalRisk = lossPerLot * lots;
  var advisory = pct < 25 ? '<span class="muted neg">Too tight &mdash; spread alone will trigger it</span>' : pct > 50 ? '<span class="muted neg">Too loose &mdash; losses compound fast</span>' : '<span class="muted">Within recommended 30&ndash;40% range</span>';
  document.getElementById('sl-out').innerHTML = 'SL premium: <b>&#8377;' + slPrice.toFixed(2) + '</b><br>Risk per lot: <b>' + fmtINR(lossPerLot) + '</b> &middot; Total risk (' + lots + ' lot' + (lots > 1 ? 's' : '') + '): <b>' + fmtINR(totalRisk) + '</b><br>' + advisory;
}

function calcLotValue() {
  var p = +document.getElementById('lv-p').value || 0;
  var lots = +document.getElementById('lv-lots').value || 0;
  var lot = +document.getElementById('lv-lot').value || 1;
  var fee = +document.getElementById('lv-fee').value || 0;
  var premiumCost = p * lot * lots;
  var feesTotal = fee * lots * 2;
  var breakeven = p + (feesTotal / (lot * lots));
  document.getElementById('lv-out').innerHTML = 'Premium cost: <b>' + fmtINR(premiumCost) + '</b> &middot; Round-trip fees: <b>' + fmtINR(feesTotal) + '</b><br>Total blocked: <b>' + fmtINR(premiumCost + feesTotal) + '</b><br>Breakeven premium: <b>&#8377;' + breakeven.toFixed(2) + '</b> <span class="muted">(sell here to cover costs)</span>';
}

// Seed all four calculator output panels once the calc inputs exist.
// Exposed on window because the lazy-content loader (loadSectionContent → show()
// callback) calls this AFTER content/calc.html has been injected — the inputs
// don't exist on initial page paint, so we can't just run on DOMContentLoaded.
window.seedCalcOutputs = function () {
  if (!document.getElementById('ps-cap')) return; // calc section not loaded yet
  try { calcPosSize(); } catch (_) { }
  try { calcRR(); } catch (_) { }
  try { calcSL(); } catch (_) { }
  try { calcLotValue(); } catch (_) { }
};
document.addEventListener('DOMContentLoaded', window.seedCalcOutputs);
