// Affiliate / partner links — one-place config.
//
// Extracted verbatim from the inline <head> <script> in
// candlestick-patterns.html (May 2026 JS module split). Loaded via a plain
// <script src> in the same <head> position, so it still runs synchronously
// before the body scripts and exposes window.AFF / aff / affClick globally —
// the inline CTA handlers in content/*.html resolve against these at click time.
//
// Once your broker partner accounts are approved, paste your tracking code
// into the placeholder ('YOUR_*_CODE') below. Every CTA reads from window.AFF.
// The aff() helper appends utm_campaign automatically based on the section the
// click happened in, so the dashboard shows which section converts best.

window.AFF = {
  enabled: false,      // set to true once you've replaced placeholder codes
  upstox: 'https://upstox.com/open-account/?f=YOUR_UPSTOX_CODE',
  dhan: 'https://dhan.co/open-account/?ref=YOUR_DHAN_CODE',
  angel: 'https://angelone.in/open-demat-account?rfid=YOUR_ANGEL_CODE',
  sensibull: 'https://web.sensibull.com/?ref=YOUR_SENSIBULL_CODE',
  tradingview: 'https://www.tradingview.com/?aff_id=YOUR_TV_CODE',
  zerodha: 'https://zerodha.com/open-account?c=YOUR_ZERODHA_CODE'
};

// Build affiliate URL with utm_campaign auto-appended for analytics
window.aff = function (broker, campaign) {
  var base = (window.AFF && window.AFF[broker]) || '#';
  var sep = base.indexOf('?') === -1 ? '?' : '&';
  return base + sep + 'utm_source=tradingstudio&utm_medium=app&utm_campaign=' + encodeURIComponent(campaign || 'general');
};

// Click tracker — fires Google Analytics event if gtag is present, otherwise no-op
window.affClick = function (broker, campaign) {
  try {
    if (typeof gtag === 'function') {
      gtag('event', 'aff_click', { broker: broker, campaign: campaign });
    }
    if (typeof console !== 'undefined') console.log('[aff]', broker, campaign);
  } catch (e) { }
  return true;
};
