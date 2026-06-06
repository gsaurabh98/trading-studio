// API-setup panel — Upstox / Angel One token save/clear + data-source switch.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split). Loaded via a plain <script src> in the SAME
// document position (classic script), so window.apiSetup* / _apiSetupRefresh
// stay global for the inline handlers in content/api-setup.html, and the
// hashchange listener + initial #api-setup check fire with unchanged timing.
// References to window.tvReload / window._swUpdateApiPill are call-time only.

(function () {
  function _apiSetupChip(id, connected) {
    var chip = document.getElementById(id);
    if (!chip) return;
    chip.classList.toggle('api-setup-chip--ok', connected);
    chip.textContent = connected ? 'Connected' : 'Not connected';
  }

  function _apiSetupRefresh() {
    var hero  = document.getElementById('api-setup-status');
    var label = document.getElementById('api-setup-label');
    var sub   = document.getElementById('api-setup-sub');
    var inp   = document.getElementById('api-setup-token');
    if (!hero) return;
    var tok = '', angel = '';
    try { tok   = (localStorage.getItem('upstox_token')   || '').trim(); } catch (_) {}
    try { angel = (localStorage.getItem('angel_one_token') || '').trim(); } catch (_) {}
    // Hero reflects the PRIMARY (Upstox) data source — that's what powers live data.
    if (tok) {
      hero.classList.add('api-setup-hero--ok');
      if (label) label.textContent = 'Connected';
      if (sub)   sub.textContent   = 'Upstox token saved \u2014 all tabs are using live data.';
      if (inp && !inp.value) inp.value = tok;
    } else {
      hero.classList.remove('api-setup-hero--ok');
      if (label) label.textContent = 'Not Connected';
      if (sub)   sub.textContent   = 'Enter your Upstox access token below.';
    }
    _apiSetupChip('api-setup-up-chip', !!tok);
    _apiSetupChip('api-setup-angel-chip', !!angel);
    var angelInp = document.getElementById('api-setup-angel-token');
    if (angelInp && !angelInp.value && angel) angelInp.value = angel;
    _apiSetupRenderSource();
  }

  function _apiSetupCurrentSource() {
    try {
      return (localStorage.getItem('data_source') || 'upstox').toLowerCase() === 'angel'
        ? 'angel' : 'upstox';
    } catch (_) { return 'upstox'; }
  }

  function _apiSetupRenderSource() {
    var src = _apiSetupCurrentSource();
    var up = document.getElementById('api-src-upstox');
    var an = document.getElementById('api-src-angel');
    if (up) up.classList.toggle('api-setup-source-btn--active', src === 'upstox');
    if (an) an.classList.toggle('api-setup-source-btn--active', src === 'angel');
    var chip = document.getElementById('api-setup-src-chip');
    if (chip) chip.textContent = src === 'angel' ? 'Angel One' : 'Upstox';
  }

  function _apiSetupMsg(text, type, elId) {
    var el = document.getElementById(elId || 'api-setup-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'api-setup-msg api-setup-msg--' + (type || 'neutral');
    clearTimeout(el._tid);
    if (type === 'ok') {
      el._tid = setTimeout(function () { el.textContent = ''; el.className = 'api-setup-msg'; }, 5000);
    }
  }

  window.apiSetupSave = function () {
    var inp = document.getElementById('api-setup-token');
    if (!inp) return;
    var t = (inp.value || '').trim();
    if (!t) { _apiSetupMsg('Enter a token first.', 'err'); return; }
    try {
      localStorage.setItem('upstox_token', t);
    } catch (e) {
      _apiSetupMsg('Could not save \u2014 browser may be in private mode.', 'err');
      return;
    }
    _apiSetupMsg('\u2713 Token saved. All tabs will use live data now.', 'ok');
    _apiSetupRefresh();
    var modalInp = document.getElementById('up-token');
    if (modalInp) modalInp.value = t;
    if (typeof window._swUpdateApiPill === 'function') window._swUpdateApiPill();
  };

  window.apiSetupClear = function () {
    try { localStorage.removeItem('upstox_token'); } catch (_) {}
    var inp = document.getElementById('api-setup-token');
    if (inp) inp.value = '';
    _apiSetupMsg('Token cleared.', 'neutral');
    _apiSetupRefresh();
    var modalInp = document.getElementById('up-token');
    if (modalInp) modalInp.value = '';
    if (typeof window._swUpdateApiPill === 'function') window._swUpdateApiPill();
  };

  window.apiSetupSaveAngel = function () {
    var inp = document.getElementById('api-setup-angel-token');
    if (!inp) return;
    var t = (inp.value || '').trim();
    if (!t) { _apiSetupMsg('Enter a token first.', 'err', 'api-setup-angel-msg'); return; }
    try {
      localStorage.setItem('angel_one_token', t);
    } catch (e) {
      _apiSetupMsg('Could not save \u2014 browser may be in private mode.', 'err', 'api-setup-angel-msg');
      return;
    }
    _apiSetupMsg('\u2713 Angel One token saved.', 'ok', 'api-setup-angel-msg');
    _apiSetupRefresh();
  };

  window.apiSetupClearAngel = function () {
    try { localStorage.removeItem('angel_one_token'); } catch (_) {}
    var inp = document.getElementById('api-setup-angel-token');
    if (inp) inp.value = '';
    _apiSetupMsg('Token cleared.', 'neutral', 'api-setup-angel-msg');
    _apiSetupRefresh();
  };

  window.apiSetupSetSource = function (src) {
    src = (src === 'angel') ? 'angel' : 'upstox';
    try { localStorage.setItem('data_source', src); } catch (_) {}
    _apiSetupRenderSource();
    if (src === 'angel') {
      var angel = '';
      try { angel = (localStorage.getItem('angel_one_token') || '').trim(); } catch (_) {}
      if (!angel) {
        _apiSetupMsg('Switched to Angel One, but no Angel token saved yet \u2014 save one above.', 'err', 'api-setup-source-msg');
      } else {
        _apiSetupMsg('\u2713 Charts now use Angel One (experimental). Requires running via server.py.', 'ok', 'api-setup-source-msg');
      }
    } else {
      _apiSetupMsg('\u2713 Charts now use Upstox.', 'ok', 'api-setup-source-msg');
    }
    // Reload the live chart so the switch takes effect immediately.
    if (typeof window.tvReload === 'function') { try { window.tvReload(); } catch (_) {} }
  };

  window.apiSetupCopyConfig = function () {
    var t = '', angel = '';
    try { t     = (localStorage.getItem('upstox_token')   || '').trim(); } catch (_) {}
    try { angel = (localStorage.getItem('angel_one_token') || '').trim(); } catch (_) {}
    var json = JSON.stringify({ upstox_token: t, angel_one_token: angel }, null, 2) + '\n';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () {
        _apiSetupMsg('\u2713 Copied! Paste into data/config.json', 'ok');
      }).catch(function () {
        _apiSetupMsg('Copy failed \u2014 manually copy from the box above.', 'err');
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = json;
      ta.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); _apiSetupMsg('\u2713 Copied! Paste into data/config.json', 'ok'); }
      catch (_) { _apiSetupMsg('Copy failed.', 'err'); }
      ta.remove();
    }
  };

  window.apiSetupToggleEye = function () {
    var inp = document.getElementById('api-setup-token');
    if (!inp) return;
    var m = inp.classList.toggle('masked');
    var btn = document.getElementById('api-setup-eye');
    if (!btn) return;
    btn.setAttribute('aria-label', m ? 'Show token' : 'Hide token');
    btn.setAttribute('title', m ? 'Show token' : 'Hide token');
    var on  = btn.querySelector('.api-setup-eye-on');
    var off = btn.querySelector('.api-setup-eye-off');
    if (on)  on.hidden  = !m;
    if (off) off.hidden = m;
  };

  window.apiSetupToggleEyeAngel = function () {
    var inp = document.getElementById('api-setup-angel-token');
    if (!inp) return;
    var m = inp.classList.toggle('masked');
    var btn = document.getElementById('api-setup-angel-eye');
    if (!btn) return;
    btn.setAttribute('aria-label', m ? 'Show token' : 'Hide token');
    btn.setAttribute('title', m ? 'Show token' : 'Hide token');
    var on  = btn.querySelector('.api-setup-eye-on');
    var off = btn.querySelector('.api-setup-eye-off');
    if (on)  on.hidden  = !m;
    if (off) off.hidden = m;
  };

  window._apiSetupRefresh = _apiSetupRefresh;

  window.addEventListener('hashchange', function () {
    if (location.hash === '#api-setup') setTimeout(_apiSetupRefresh, 150);
  });
  if (location.hash === '#api-setup') setTimeout(_apiSetupRefresh, 300);
})();
