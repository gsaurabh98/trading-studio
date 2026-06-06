// Paper-trading module — localStorage-backed sandbox: capital, SL/TGT,
// pending LIMIT/STOP orders, EOD square-off, option-price polling, and the
// card-based open / pending / history renderers.
//
// Extracted verbatim from an inline <script> in candlestick-patterns.html
// (May 2026 JS module split — AGENTS.md §18). Loaded via a plain <script
// src> in the SAME document position (classic script), so the pt* /
// paperTradeTick window.* exposures stay global for the inline handlers in
// content/live.html, with unchanged init timing. Cross-module references
// (chart / chain / intraday) are call-time only.
// ---8<--- extracted verbatim from candlestick-patterns.html ---8<---

(function paperTradeModule() {
  var STORAGE_KEY = 'paper_trade_state_v1';
  var START_CAPITAL = 100000;
  var LOT_SIZE_NIFTY = 65;
  var MAX_LOTS = 20;

  // Auto square-off time in IST. 15:25 gives a 5-min buffer before the
  // 15:30 close to avoid last-minute liquidity / slippage issues.
  var EOD_HOUR = 15, EOD_MINUTE = 25;

  // API base URL for Upstox v2 calls (LTP polling, etc.). Mirrors the
  // routing logic used by the chart and option-chain modules:
  //   CF Worker (if user configured one) > local proxy on localhost > direct.
  // We MUST declare this here because paperTradeModule is its own IIFE
  // and cannot see the BASE declared inside liveChainModule. Earlier this
  // was the silent root cause of "FLAT trades" and "SL/TGT not firing":
  // pollOptionPrices and fetchFreshOptionPrice referenced an undefined
  // BASE, which threw a ReferenceError swallowed by the surrounding
  // try/catch — so the LTP cache never updated.
  var BASE = (function () {
    try {
      var cfUrl = (localStorage.getItem('cf_worker_url') || '').trim().replace(/\/+$/, '');
      if (cfUrl) return cfUrl + '/api/v2';
      var h = (location.hostname || '').toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.endsWith('.local')) return '/api/v2';
    } catch (_) { /* fall through to direct */ }
    return 'https://api.upstox.com/v2';
  })();
  console.log('[paper-trade] init: BASE =', BASE);

  // How long the option-LTP poll loop is allowed to be "quiet" (no
  // successful Upstox response) before the watchdog tears it down and
  // restarts it. Picked at 8s = 8 expected ticks; smaller than that
  // and a single slow round-trip would falsely trip the watchdog,
  // larger than that and the user notices the freeze.
  var WATCHDOG_STALL_MS = 8000;

  // ── Options API pause toggle ──
  // User-controlled master switch that prevents the paper-trade +
  // option-chain modules from making ANY Upstox API calls (option
  // LTP polling, chain auto-refresh, manual chain fetch). Mirrors
  // the swing analyzer's pause toggle. While paused: open positions
  // still render with their last-known prices, EOD square-off still
  // fires (uses cached lastPx → entry fallback), but no fresh HTTP
  // goes out. The user explicitly resumes when ready.
  var PT_API_PAUSED_KEY = 'pt_api_paused_v1';

  // Default-paused: the Upstox API stays OFF unless the user has EXPLICITLY
  // resumed it (stored '0'). A missing key — fresh load, cleared cookies /
  // localStorage, or private-mode read failure — means PAUSED, so no live
  // HTTP/WS goes out until the user opts in. Only an explicit '0' resumes.
  function ptIsApiPaused() {
    try { return localStorage.getItem(PT_API_PAUSED_KEY) !== '0'; }
    catch (_) { return true; }
  }

  function ptSetApiPaused(flag) {
    try { localStorage.setItem(PT_API_PAUSED_KEY, flag ? '1' : '0'); }
    catch (_) {}
  }

  // Exposed on window so the chain module can check it too.
  window.ptIsApiPaused = ptIsApiPaused;

  var state = {
    capital: START_CAPITAL,
    open: [],   // option: { id, kind:'OPT', side:'BUY', optType:'CE'|'PE', strike, expiry, instrumentKey,
    //           qty, entry, entryTs, lastPx, sl, tgt, slSpot, tgtSpot, entrySpot }
    //   sl       = absolute premium price below which we auto-exit (null = no SL)
    //   tgt      = absolute premium price at or above which we auto-exit (null = no TGT)
    //   slSpot   = NIFTY SPOT level below (CE) / above (PE) which we auto-exit at LIVE premium
    //   tgtSpot  = NIFTY SPOT level above (CE) / below (PE) which we auto-exit at LIVE premium
    //   entrySpot = NIFTY SPOT at the moment of entry (for chart anchoring + diagnostics)
    // ─── Engine-supplied spot triggers (one-shot prime) ──────────
    // The intraday analyzer engine populates these via
    // paperBridgeModule.primeSpotTriggers(...) just before
    // calling ptBuyCE / ptBuyPE. They're consumed once on the
    // next BUY and then cleared so a subsequent manual BUY
    // doesn't inherit stale levels from an old signal. Indexed
    // by optType ('CE' / 'PE') so CE and PE can carry
    // independent triggers if both sides are armed.
    engineSlSpotPrime:    {},
    engineTgtSpotPrime:   {},
    engineEntrySpotPrime: {},
    history: [],   // { ...open, exit, exitTs, pnl, pts, exitReason: 'MANUAL'|'SL'|'TGT'|'EOD' }
    // ── Pending orders (LIMIT / STOP not yet filled) ─────────────────
    // Schema (option pending): { id, kind:'OPT', side:'BUY', optType:'CE'|'PE',
    //   orderType:'LIMIT'|'STOP', triggerPrice, strike, expiry, symbol,
    //   instrumentKey, qty, sl, tgt, placedTs }
    // LIMIT fires when polled premium <= triggerPrice (you're waiting
    //   to buy LOWER — pullback entry).
    // STOP  fires when polled premium >= triggerPrice (you're waiting
    //   to buy HIGHER — breakout entry).
    // Optional sl / tgt are copied onto the resulting OPEN position
    // verbatim, so "set SL+Target at order placement" works exactly
    // like Upstox's GTT One-Cancels-Other attachment.
    pending: [],
    qtyCE: 1,    // lots for BUY CE (independent of PE)
    qtyPE: 1,    // lots for BUY PE (independent of CE)
    // ── Per-side order ticket form state (transient, NOT persisted) ──
    // Drives the MARKET/LIMIT/STOP segmented selector + trigger input +
    // attached-SL/Target inputs in each CE/PE card. Kept in `state` so
    // setBtnState() / button-label updates / placeOpt() can all read a
    // single source of truth instead of repeatedly DOM-poking the inputs.
    orderTypeCE: 'MARKET',    // 'MARKET' | 'LIMIT' | 'STOP'
    orderTypePE: 'MARKET',
    triggerPxCE: null,        // number or null
    triggerPxPE: null,
    attachedSlCE: null,
    attachedSlPE: null,
    attachedTgtCE: null,
    attachedTgtPE: null,
    lastLTP: null, // last Nifty spot LTP (from chart's pollTick)
    optPrices: {},   // map: instrumentKey -> latest premium
    optPollTimer: null,
    optPollWatchdog: null, // separate timer that revives optPollTimer if it goes quiet
    lastPollSuccessTs: 0,  // touched on every successful poll round-trip
    pollInFlight: false,   // reentry guard so 1s ticks don't pile up if one round-trip is slow
    eodTimer: null,  // checks every 30s if it's past EOD cutoff
    selectedStrike: null,  // currently picked strike (number) — single source of truth
    strikeFilter: '',    // search input filter
    // ── Live Option Chain table piggyback ──
    // Set every time renderChainTable() runs. pollOptionPrices() merges
    // these instrument_keys into its existing 1-second LTP poll so the
    // table's LTP cells tick like Upstox without burning a separate
    // polling loop. Cleared only when section becomes inactive — so a
    // backgrounded tab or a switch to Anatomy stops polling them.
    chainTableLtpKeys: [],
    // Last wall-clock ms a successful chain-LTP poll updated table cells.
    // Drives the "LIVE · 3s ago" pill above the chain table.
    chainLastLtpTickTs: 0,
    // setInterval id for the 1s "Xs ago" label refresh. Single-shot
    // (started on first chain render, cleared by stopChainLiveTicker).
    chainLiveTickerTimer: null
  };

  function $(id) { return document.getElementById(id); }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && typeof s === 'object') {
        if (typeof s.capital === 'number') state.capital = s.capital;
        if (Array.isArray(s.open)) state.open = s.open;
        if (Array.isArray(s.history)) state.history = s.history;
        // Pending orders survive reloads exactly like open positions,
        // so a LIMIT/STOP queued before the user closes the laptop
        // resumes triggering as soon as the chart re-connects.
        if (Array.isArray(s.pending)) state.pending = s.pending;
        // Migrate legacy single qty → seed both CE and PE with it.
        if (typeof s.qtyCE === 'number') state.qtyCE = clampLots(s.qtyCE);
        else if (typeof s.qty === 'number') state.qtyCE = clampLots(s.qty);
        if (typeof s.qtyPE === 'number') state.qtyPE = clampLots(s.qtyPE);
        else if (typeof s.qty === 'number') state.qtyPE = clampLots(s.qty);
      }
    } catch (e) { }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        capital: state.capital,
        open: state.open,
        history: state.history,
        pending: state.pending,
        qtyCE: state.qtyCE,
        qtyPE: state.qtyPE
      }));
    } catch (e) { }
  }

  function clampLots(n) { return Math.max(1, Math.min(MAX_LOTS, parseInt(n, 10) || 1)); }

  function fmtINR(n) {
    var sign = n < 0 ? '-' : '';
    var abs = Math.abs(n);
    return sign + '\u20B9' + Math.round(abs).toLocaleString('en-IN');
  }
  function fmtPts(n) { return (n >= 0 ? '+' : '') + (+n).toFixed(2); }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
  }
  function fmtDur(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  // For OPTION positions: P&L = (current premium - entry premium) × lot × qty (BUY only — long premium)
  // For INDEX positions: P&L = direction-adjusted (LTP - entry) × lot × qty
  function pnlOf(pos, currentPx) {
    if (!isFinite(currentPx) || currentPx <= 0) return { pts: 0, inr: 0 };
    var pts;
    if (pos.kind === 'OPT') {
      pts = currentPx - pos.entry;
    } else {
      pts = pos.side === 'LONG' ? (currentPx - pos.entry) : (pos.entry - currentPx);
    }
    return { pts: pts, inr: pts * LOT_SIZE_NIFTY * pos.qty };
  }

  // Returns the relevant current price for a position (index spot OR option premium)
  function priceFor(pos) {
    if (pos.kind === 'OPT') {
      return state.optPrices[pos.instrumentKey] || pos.lastPx || null;
    }
    return state.lastLTP;
  }

  // side = 'ce' or 'pe' — sets the lot count for that side independently.
  // (Legacy: omitting side defaults to CE for backward-compat with old calls.)
  function setQty(n, side) {
    var v = clampLots(n);
    var which = (side === 'pe') ? 'pe' : 'ce';
    if (which === 'pe') state.qtyPE = v; else state.qtyCE = v;
    var inp = $('pt-qty-' + which);
    if (inp && +inp.value !== v) inp.value = v;
    save();
  }

  function incQty(d, side) {
    var which = (side === 'pe') ? 'pe' : 'ce';
    var cur = which === 'pe' ? state.qtyPE : state.qtyCE;
    setQty(cur + d, which);
  }

  // ── Place an INDEX direction trade (LONG / SHORT Nifty) ──
  function place(side) {
    var ltp = state.lastLTP;
    if (!ltp) { alert('Live chart not running yet.\nConnect your Upstox token and start the chart first.'); return; }
    state.open.push({
      id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
      kind: 'IDX',
      symbol: 'NIFTY',
      side: side,
      qty: state.qtyCE,
      entry: ltp,
      entryTs: Date.now()
    });
    save();
    renderAll();
  }

  // ── Place an OPTION trade (BUY CE / BUY PE at chosen strike) ──
  // Branches on the user's selected order type for this side:
  //   MARKET → original flow: fresh LTP fetch + immediate fill into state.open
  //   LIMIT  → queue into state.pending; auto-fill when polled premium <= triggerPrice
  //   STOP   → queue into state.pending; auto-fill when polled premium >= triggerPrice
  // The market-order code path below is unchanged from the pre-limit-orders
  // version — same fresh-LTP fetch, same chain-cache fallback, same UI
  // disable-during-round-trip behaviour. The LIMIT/STOP path adds NO
  // network call (the trigger fires off the already-running 1s LTP poll).
  async function placeOpt(optType) {
    if (ptIsApiPaused()) {
      alert('Upstox API is paused. Click Resume on the banner at the top of the Options Trading tab.');
      return;
    }
    var chain = window.optionChainData;
    if (!chain) {
      alert('Option chain not loaded yet. Make sure the chart is started; strikes load automatically once the live chart connects.');
      return;
    }
    if (state.selectedStrike == null) {
      alert('Select a strike first.\n\nClick the strike picker to choose one.');
      return;
    }
    var strike = state.selectedStrike;
    var row = chain.strikes.filter(function (s) { return s.strike_price === strike; })[0];
    if (!row) { alert('Strike not found in chain. Refresh the chain.'); return; }
    var leg = optType === 'CE' ? row.call_options : row.put_options;
    if (!leg || !leg.market_data) { alert('No data available for ' + optType + ' at ' + strike + '.'); return; }
    var cachedPremium = +leg.market_data.ltp;
    if (!isFinite(cachedPremium) || cachedPremium <= 0) {
      alert('Premium for ' + strike + ' ' + optType + ' is zero / not available right now.\n\nTry a different strike or click "REFRESH STRIKES" to update prices.');
      return;
    }
    var ikey = leg.instrument_key;

    // ── LIMIT / STOP branch ────────────────────────────────────────
    // Pure state mutation — no network call. Validation done up front
    // so the user sees a clear reason if the trigger is missing or
    // doesn't make sense for the chosen side. The fill is handled by
    // checkPendingTriggers() running off the existing LTP poll.
    var orderType = optType === 'CE' ? state.orderTypeCE : state.orderTypePE;
    if (orderType === 'LIMIT' || orderType === 'STOP') {
      var trigger = optType === 'CE' ? state.triggerPxCE : state.triggerPxPE;
      if (trigger == null || !isFinite(trigger) || trigger <= 0) {
        alert('Enter a trigger price first.\n\nLIMIT orders fire when the premium drops to your price.\nSTOP orders fire when the premium rises to your price.');
        return;
      }
      // Sanity-check trigger vs current premium so the user doesn't
      // accidentally place an order that would fire on the very next
      // tick (almost certainly a typo). We warn but allow it through —
      // some traders do place near-LTP triggers intentionally.
      if (orderType === 'LIMIT' && trigger >= cachedPremium) {
        var okL = await confirmModal({
          title: 'LIMIT trigger above current premium',
          message: 'LIMIT BUY trigger \u20B9' + trigger.toFixed(2) +
            ' is at or above current premium \u20B9' + cachedPremium.toFixed(2) + '.\n\n' +
            'LIMIT orders are meant to wait for the premium to DROP to a lower price. ' +
            'This order will fill on the next tick.',
          confirmLabel: 'PLACE ANYWAY',
          cancelLabel: 'CANCEL'
        });
        if (!okL) return;
      }
      if (orderType === 'STOP' && trigger <= cachedPremium) {
        var okS = await confirmModal({
          title: 'STOP trigger below current premium',
          message: 'STOP BUY trigger \u20B9' + trigger.toFixed(2) +
            ' is at or below current premium \u20B9' + cachedPremium.toFixed(2) + '.\n\n' +
            'STOP orders are meant to wait for the premium to RISE to a higher price (breakout entry). ' +
            'This order will fill on the next tick.',
          confirmLabel: 'PLACE ANYWAY',
          cancelLabel: 'CANCEL'
        });
        if (!okS) return;
      }
      var qtyLot = (optType === 'CE') ? state.qtyCE : state.qtyPE;
      var attachedSl = optType === 'CE' ? state.attachedSlCE : state.attachedSlPE;
      var attachedTgt = optType === 'CE' ? state.attachedTgtCE : state.attachedTgtPE;
      state.pending.push({
        id: 'pp' + Date.now() + Math.floor(Math.random() * 1000),
        kind: 'OPT',
        side: 'BUY',
        optType: optType,
        orderType: orderType,
        triggerPrice: trigger,
        strike: strike,
        expiry: chain.expiry,
        symbol: chain.symbol,
        instrumentKey: ikey,
        qty: qtyLot,
        sl: attachedSl,
        tgt: attachedTgt,
        placedTs: Date.now(),
        placedAtPremium: cachedPremium  // for audit / hint in the table
      });
      // Seed the price cache so the Pending Orders row immediately
      // shows the live LTP + distance instead of a blank tick.
      state.optPrices[ikey] = cachedPremium;
      console.log('[paper-trade] PENDING placed', {
        id: state.pending[state.pending.length - 1].id,
        type: orderType, side: optType + ' BUY', strike: strike,
        trigger: trigger, currentPremium: cachedPremium,
        sl: attachedSl, tgt: attachedTgt, qty: qtyLot
      });
      showToast('limit', orderType + ' ORDER PLACED',
        '<b>' + strike + ' ' + optType + '</b> ' + orderType +
        ' BUY queued at \u20B9' + trigger.toFixed(2) +
        ' <span style="opacity:.7">(current premium \u20B9' + cachedPremium.toFixed(2) +
        ')</span>');
      // Reset the order ticket so the user can place another. Order
      // type stays the same (likely placing several LIMITs in a row);
      // trigger + attached SL/TGT clear because they're order-specific.
      resetOrderTicket(optType.toLowerCase());
      save();
      renderAll();
      // Force an immediate trigger-check in case the trigger is already
      // satisfied (e.g. LIMIT @150 placed when premium is already 145 —
      // we don't want to make the user wait 1s for the next poll tick).
      checkPendingTriggers();
      return;
    }
    // ── End LIMIT / STOP branch — MARKET flow continues below ──

    // Disable BOTH buy buttons during the fresh-LTP round-trip and show
    // a "PLACING…" hint on the active one, so a fast double-click can't
    // open two positions on the same instrument. setBtnState() (called
    // inside renderAll) restores the correct enabled state on success;
    // the catch branch handles failure paths.
    var ceBtn = $('pt-buy-ce-btn'), peBtn = $('pt-buy-pe-btn');
    var activeBtn = optType === 'CE' ? ceBtn : peBtn;
    var prevText = activeBtn ? activeBtn.textContent : '';
    if (ceBtn) ceBtn.disabled = true;
    if (peBtn) peBtn.disabled = true;
    if (activeBtn) activeBtn.textContent = 'PLACING\u2026';

    try {
      // Fetch fresh LTP at click-time. This is the single most important
      // factor in entry-price accuracy — the chain cache is too stale.
      var freshPx = await fetchFreshOptionPrice(ikey, 'BUY');
      var premium = (freshPx != null) ? freshPx : cachedPremium;
      var priceSource = (freshPx != null) ? 'fresh-fetch' : 'chain-cache-fallback';
      console.log('[paper-trade] BUY entry resolved', {
        instrument: strike + ' ' + optType,
        cachedFromChain: cachedPremium,
        freshFromQuote: freshPx,
        entryUsed: premium,
        priceSource: priceSource
      });

      // Use the side-specific lot count so CE and PE can be sized independently.
      var qty = (optType === 'CE') ? state.qtyCE : state.qtyPE;
      // SL / Target start as null — fully optional. User sets and updates them
      // per-position via the inline inputs in the Open Positions table. The
      // user can edit the SL at any time during the trade (e.g. trail it up
      // manually as the premium moves in their favor).
      // Pull engine-supplied spot triggers if the bridge populated
      // them on the buy ticket (May 2026 spot-first refactor). The
      // analyzer engine emits entry/SL/T1 in SPOT terms — that's
      // what every indicator is measured on, and that's what the
      // user can actually watch on the chart. The premium-based
      // sl/tgt fields below stay for backward compat (manual
      // inline edits in the Open Positions table still write
      // there), but for engine-driven trades the spot fields
      // are the source of truth — checkSpotRiskTriggers fires
      // exits when spot crosses slSpot/tgtSpot, filling at the
      // live option premium at the moment of crossing.
      var engineSlSpot  = (state.engineSlSpotPrime  && state.engineSlSpotPrime[optType])  || null;
      var engineTgtSpot = (state.engineTgtSpotPrime && state.engineTgtSpotPrime[optType]) || null;
      var engineEntrySpot = (state.engineEntrySpotPrime && state.engineEntrySpotPrime[optType]) || null;
      state.open.push({
        id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
        kind: 'OPT',
        side: 'BUY',
        optType: optType,
        strike: strike,
        expiry: chain.expiry,
        symbol: chain.symbol,
        instrumentKey: ikey,
        qty: qty,
        entry: premium,
        entryTs: Date.now(),
        lastPx: premium,
        sl: null,
        tgt: null,
        // Spot-based triggers (May 2026 spot-first). Null when
        // the user clicks BUY directly from the paper-trade
        // panel without the engine populating triggers; in
        // that case the legacy premium-based sl/tgt fields
        // remain the only exit mechanism (inline-editable in
        // the Open Positions table). When BOTH are set,
        // whichever fires first wins (spot ticks every ~1s,
        // option premium polls every 2s).
        slSpot:    engineSlSpot,
        tgtSpot:   engineTgtSpot,
        entrySpot: engineEntrySpot
      });
      // Consume the one-shot engine prime so the next manual BUY
      // doesn't pick up stale triggers from a previous signal.
      if (state.engineSlSpotPrime)    delete state.engineSlSpotPrime[optType];
      if (state.engineTgtSpotPrime)   delete state.engineTgtSpotPrime[optType];
      if (state.engineEntrySpotPrime) delete state.engineEntrySpotPrime[optType];
      state.optPrices[ikey] = premium;
      save();
      // Restore active button text BEFORE renderAll so setBtnState sees
      // a clean baseline; renderAll → setBtnState() then sets the proper
      // disabled state for both buttons.
      if (activeBtn && prevText) activeBtn.textContent = prevText;
      renderAll();
      // Kick off polling immediately so the LTP column starts ticking.
      pollOptionPrices();
    } catch (e) {
      // Fetch / state mutation threw — restore the UI so the user can retry.
      console.error('[paper-trade] BUY threw — restoring buttons', e && e.message);
      if (activeBtn && prevText) activeBtn.textContent = prevText;
      if (ceBtn) ceBtn.disabled = false;
      if (peBtn) peBtn.disabled = false;
      alert('Could not place the trade right now: ' + (e && e.message ? e.message : 'unknown error') + '\n\nPlease retry.');
    }
  }

  // Exit one position. `reason` defaults to 'MANUAL' (user-initiated via EXIT button).
  // Auto exits (SL/TGT/EOD) pass a pre-resolved exit price so the same tick that
  // triggered the auto-exit is recorded in history — no race with the next poll.
  // Manual exits do a one-shot fresh LTP fetch first to capture the latest tick
  // (the 1s poll cache could still be up to 1s stale at the moment of click).
  async function exit(id, reason, exitPxOverride) {
    var pos = state.open.filter(function (p) { return p.id === id; })[0];
    if (!pos) return;

    var px = null;
    var priceSource = 'unknown';
    if (typeof exitPxOverride === 'number' && isFinite(exitPxOverride) && exitPxOverride > 0) {
      px = exitPxOverride;
      priceSource = 'override (' + (reason || 'auto') + ')';
    } else if (!reason || reason === 'MANUAL') {
      // Manual exit: try a fresh fetch first for accuracy. Fall back to
      // cache (priceFor) if the network fetch fails or returns nothing.
      var fresh = pos.kind === 'OPT' ? await fetchFreshOptionPrice(pos.instrumentKey, 'EXIT') : null;
      if (fresh) { px = fresh; priceSource = 'fresh-fetch'; }
      else { px = priceFor(pos); priceSource = 'cached-fallback'; }
    } else {
      px = priceFor(pos);
      priceSource = 'cache';
    }
    console.log('[paper-trade] EXIT result', {
      instrument: pos.symbol + ' ' + pos.strike + ' ' + pos.optType,
      entry: pos.entry,
      exit: px,
      priceSource: priceSource,
      delta: px != null ? +(px - pos.entry).toFixed(2) : null,
      reason: reason || 'MANUAL'
    });
    // If the exit price equals the entry price exactly AND we used the
    // cached fallback, something is wrong — the cache was likely never
    // refreshed. Surface a visible warning so the user notices instead
    // of silently recording a FLAT trade.
    if (px != null && px === pos.entry && priceSource === 'cached-fallback') {
      console.warn('[paper-trade] FLAT trade with cached-fallback price — LTP poll likely failing. Check earlier [paper-trade] warnings in console.');
    }

    if (!px) {
      if (!reason || reason === 'MANUAL') {
        alert('Live price not available yet for this position. Wait for the next tick.');
      }
      return;
    }
    var calc = pnlOf(pos, px);
    state.open = state.open.filter(function (p) { return p.id !== id; });
    state.history.unshift(Object.assign({}, pos, {
      exit: px,
      exitTs: Date.now(),
      pts: calc.pts,
      pnl: calc.inr,
      exitReason: reason || 'MANUAL'
    }));
    state.capital += calc.inr;
    save();
    renderAll();
  }

  function exitAll() {
    if (!state.open.length) return;
    // Single position: just exit straight away (no confirmation noise).
    if (state.open.length === 1) {
      state.open.slice().forEach(function (p) { exit(p.id); });
      return;
    }
    var n = state.open.length;
    confirmModal({
      title: 'Exit all open positions?',
      message: 'Square off all ' + n + ' open positions at current market price.',
      confirmLabel: 'EXIT ALL',
      cancelLabel: 'CANCEL',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.open.slice().forEach(function (p) { exit(p.id); });
    });
  }

  // ─── Auto SPOT-based SL / Target trigger check (May 2026) ───────
  // Called from every paperTradeTick(ltp), i.e. every Nifty spot
  // poll (~1s while market is open). Iterates open OPT positions
  // that have engine-supplied slSpot / tgtSpot fields and exits
  // at the LIVE option premium when spot crosses the trigger.
  //
  // Why spot-based (not premium-based) triggers are correct here:
  //   1. Every indicator (RSI, EMA, VWAP, S/R, ADX) is computed
  //      on Nifty spot — the trader watches the chart in spot,
  //      so the exit trigger should match.
  //   2. Option premium drifts with IV crush + theta in ways
  //      that make "exit when premium hits ₹85" both unwatchable
  //      AND inaccurate (delta-projected premiums are wrong
  //      ±5-15% even on a quiet day).
  //   3. The exit FILL is at the live premium at the moment of
  //      crossing — that's the actual broker reality (you sell
  //      at whatever the premium is when spot prints the SL).
  //
  // Direction logic — long premium (BUY CE/PE) only:
  //   CE position: SL hits when spot <= slSpot (spot dropped)
  //                TGT hits when spot >= tgtSpot (spot rose)
  //   PE position: SL hits when spot >= slSpot (spot rose)
  //                TGT hits when spot <= tgtSpot (spot dropped)
  //
  // Exit price uses the cached option LTP (state.optPrices). The
  // option poll runs at 2s, spot ticks at ~1s, so the LTP is at
  // worst 2s stale — close enough to real-time for paper P&L.
  // Falls back to pos.lastPx → pos.entry if cache is empty
  // (same fallback chain as EOD square-off).
  function checkSpotRiskTriggers(spot) {
    if (!state.open.length) return;
    if (!isFinite(spot) || spot <= 0) return;
    state.open.slice().forEach(function (p) {
      if (p.kind !== 'OPT') return;
      if (p.slSpot == null && p.tgtSpot == null) return;
      var isCE = p.optType === 'CE';
      var slHit  = (p.slSpot  != null) && (isCE ? spot <= p.slSpot  : spot >= p.slSpot);
      var tgtHit = (p.tgtSpot != null) && (isCE ? spot >= p.tgtSpot : spot <= p.tgtSpot);
      if (!slHit && !tgtHit) return;
      // Resolve exit price — live premium first, fall back to
      // last known premium, then entry (so a stale cache can
      // never leave a position stuck open).
      var exitPx = state.optPrices[p.instrumentKey];
      if (!isFinite(exitPx) || exitPx <= 0) exitPx = p.lastPx;
      if (!isFinite(exitPx) || exitPx <= 0) exitPx = p.entry;
      var reason = slHit ? 'SL' : 'TGT';
      var triggerSpot = slHit ? p.slSpot : p.tgtSpot;
      console.log('[paper-trade] SPOT trigger fired', {
        instrument: p.strike + p.optType,
        reason: reason,
        spot: spot, triggerSpot: triggerSpot,
        exitPremium: exitPx, entryPremium: p.entry
      });
      exit(p.id, reason, exitPx);
      var dirArrow = isCE
        ? (slHit ? 'Nifty dropped to ' : 'Nifty rose to ')
        : (slHit ? 'Nifty rose to ' : 'Nifty dropped to ');
      var toastKind = slHit ? 'sl' : 'tgt';
      var toastTitle = slHit ? 'STOP LOSS HIT (spot)' : 'TARGET HIT (spot)';
      var fmtSpot = function (n) { return (n != null && isFinite(n)) ? Math.round(n).toLocaleString('en-IN') : '?'; };
      showToast(toastKind, toastTitle,
        '<b>' + p.strike + ' ' + p.optType + '</b> ' + dirArrow + '\u20B9' + fmtSpot(spot)
        + ' (trigger \u20B9' + fmtSpot(triggerSpot) + ')'
        + ' \u2014 exited at \u20B9' + (exitPx != null ? exitPx.toFixed(2) : '?') + ' live premium');
    });
  }

  // ─── Auto SL / Target trigger check (PREMIUM-BASED, legacy) ─────
  // Called after every option-price poll. Iterates open OPT positions and
  // exits any whose latest premium has crossed SL or Target. The exit price
  // recorded in history is the SL/TGT level the user set (NOT the tick
  // that crossed it) — clean "no-slippage" simulation that matches what
  // most paper-trading tools (TradingView etc.) do.
  //
  // Still active alongside checkSpotRiskTriggers because users can
  // manually edit the legacy premium sl/tgt fields inline in the
  // Open Positions table (e.g. for manual trailing). When BOTH a
  // spot trigger and a premium trigger are set on the same
  // position, whichever fires first wins.
  function checkRiskTriggers() {
    if (!state.open.length) return;
    state.open.slice().forEach(function (p) {
      if (p.kind !== 'OPT') return;
      var px = state.optPrices[p.instrumentKey];
      // Diagnostic: surface why an SL/TGT didn't trigger. Logs only
      // when the user has actually set a threshold, otherwise quiet.
      if (p.sl != null || p.tgt != null) {
        if (!isFinite(px) || px <= 0) {
          console.warn('[paper-trade] checkRiskTriggers: skipping ' + p.strike + p.optType
            + ' — no live price in cache (sl=' + p.sl + ', tgt=' + p.tgt + ')');
        } else {
          console.log('[paper-trade] checkRiskTriggers: ' + p.strike + p.optType
            + ' px=' + px + ' sl=' + p.sl + ' tgt=' + p.tgt
            + ' slHit=' + (p.sl != null && px <= p.sl)
            + ' tgtHit=' + (p.tgt != null && px >= p.tgt));
        }
      }
      if (!isFinite(px) || px <= 0) return;
      // Long-premium positions only — SL is a floor, TGT is a ceiling.
      // Exit AT the SL/TGT level the user set, not at the tick that crossed it
      // (no-slippage convention — matches what backtests / TradingView paper trade do).
      if (p.sl != null && px <= p.sl) {
        exit(p.id, 'SL', p.sl);
        showToast('sl', 'STOP LOSS HIT',
          '<b>' + p.strike + ' ' + p.optType + '</b> auto-exited at \u20B9' + p.sl.toFixed(2) +
          ' <span style="opacity:.7">(price tick: \u20B9' + px.toFixed(2) + ')</span>');
        return;
      }
      if (p.tgt != null && px >= p.tgt) {
        exit(p.id, 'TGT', p.tgt);
        showToast('tgt', 'TARGET HIT',
          '<b>' + p.strike + ' ' + p.optType + '</b> auto-exited at \u20B9' + p.tgt.toFixed(2) +
          ' <span style="opacity:.7">(price tick: \u20B9' + px.toFixed(2) + ')</span>');
        return;
      }
    });
  }

  // ─── Auto LIMIT / STOP trigger check ─────────────────────────────
  // Called after every option-price poll. Iterates pending orders and
  // fills any whose trigger has been reached:
  //   LIMIT BUY → fills when live premium <= triggerPrice  (pullback)
  //   STOP BUY  → fills when live premium >= triggerPrice  (breakout)
  // Fill convention: entry recorded at the triggerPrice (NOT the tick
  // that crossed it). Same no-slippage assumption the existing SL/TGT
  // exit uses — keeps simulated outcomes deterministic and matches
  // how TradingView paper trade fills GTC orders.
  // After fill, the order moves from state.pending → state.open with
  // the optional attached sl/tgt copied verbatim (OCO semantics: when
  // either sl or tgt later hits, the existing checkRiskTriggers handles
  // the exit and removes the position from state.open — no separate
  // OCO bookkeeping required).
  function checkPendingTriggers() {
    if (!state.pending.length) return;
    var anyFilled = false;
    state.pending.slice().forEach(function (p) {
      if (p.kind !== 'OPT') return;
      var px = state.optPrices[p.instrumentKey];
      if (!isFinite(px) || px <= 0) {
        // No live price yet — pollOptionPrices will fetch it because
        // checkPendingTriggers's keys are merged into the poll set
        // (see pollOptionPrices). Skip this tick.
        return;
      }
      var fired = false;
      if (p.orderType === 'LIMIT' && px <= p.triggerPrice) fired = true;
      if (p.orderType === 'STOP'  && px >= p.triggerPrice) fired = true;
      if (!fired) return;

      // Remove from pending, add to open. Entry = triggerPrice (no-slip).
      state.pending = state.pending.filter(function (q) { return q.id !== p.id; });
      var openPos = {
        id: 'p' + Date.now() + Math.floor(Math.random() * 1000),
        kind: 'OPT',
        side: 'BUY',
        optType: p.optType,
        strike: p.strike,
        expiry: p.expiry,
        symbol: p.symbol,
        instrumentKey: p.instrumentKey,
        qty: p.qty,
        entry: p.triggerPrice,
        entryTs: Date.now(),
        lastPx: px,
        sl: (p.sl != null) ? p.sl : null,
        tgt: (p.tgt != null) ? p.tgt : null,
        // Audit-trail fields so trade history can show that this came
        // from a LIMIT/STOP order rather than a market click.
        _filledFromPendingId: p.id,
        _filledOrderType: p.orderType,
        _filledTriggerPrice: p.triggerPrice
      };
      state.open.push(openPos);
      anyFilled = true;
      console.log('[paper-trade] PENDING filled', {
        pendingId: p.id, openId: openPos.id, orderType: p.orderType,
        trigger: p.triggerPrice, tickPx: px,
        instrument: p.strike + ' ' + p.optType
      });
      showToast('limit', p.orderType + ' ORDER FILLED',
        '<b>' + p.strike + ' ' + p.optType + '</b> ' + p.orderType +
        ' BUY filled at \u20B9' + p.triggerPrice.toFixed(2) +
        ' <span style="opacity:.7">(tick: \u20B9' + px.toFixed(2) + ')</span>' +
        (openPos.sl != null || openPos.tgt != null
          ? '<br><span style="font-size:10.5px;opacity:.85">Attached: ' +
            (openPos.sl != null ? 'SL \u20B9' + openPos.sl.toFixed(2) : '') +
            (openPos.sl != null && openPos.tgt != null ? ' \u00B7 ' : '') +
            (openPos.tgt != null ? 'TGT \u20B9' + openPos.tgt.toFixed(2) : '') +
            '</span>'
          : ''));
    });
    if (anyFilled) {
      save();
      renderAll();
      // Immediately check the freshly-opened position against its own
      // attached SL/TGT — covers the (rare) case where a violently fast
      // move took out both trigger AND sl/tgt within the same poll tick.
      checkRiskTriggers();
    }
  }

  // ─── Cancel a single pending order (user-initiated) ─────────────
  // Removes the order from state.pending; no other side effects (the
  // order was never filled, so nothing in state.open or capital changes).
  function cancelPending(id) {
    var p = state.pending.filter(function (q) { return q.id === id; })[0];
    if (!p) return;
    state.pending = state.pending.filter(function (q) { return q.id !== id; });
    console.log('[paper-trade] PENDING cancelled', {
      id: id, orderType: p.orderType,
      instrument: p.strike + ' ' + p.optType, trigger: p.triggerPrice
    });
    showToast('limit', 'ORDER CANCELLED',
      '<b>' + p.strike + ' ' + p.optType + '</b> ' + p.orderType +
      ' BUY \u20B9' + p.triggerPrice.toFixed(2) + ' cancelled.');
    save();
    renderAll();
  }

  // Bulk cancel — used by the CANCEL ALL toolbar button and by the EOD
  // square-off path. `silent` skips the confirm + toast (used by EOD).
  function cancelAllPending(silent) {
    if (!state.pending.length) return;
    // EOD / silent path skips the dialog entirely.
    if (silent) {
      doBulkCancel(true);
      return;
    }
    // Single pending order: just cancel it (no dialog noise).
    if (state.pending.length === 1) {
      doBulkCancel(false);
      return;
    }
    var n = state.pending.length;
    confirmModal({
      title: 'Cancel all pending orders?',
      message: 'Remove all ' + n + ' queued LIMIT / STOP orders.\n\nOpen positions and trade history are not affected.',
      confirmLabel: 'CANCEL ALL',
      cancelLabel: 'KEEP',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doBulkCancel(false);
    });
  }

  function doBulkCancel(silent) {
    var n = state.pending.length;
    state.pending = [];
    console.log('[paper-trade] PENDING bulk-cancelled', { count: n, silent: !!silent });
    if (!silent) {
      showToast('limit', 'ALL ORDERS CANCELLED',
        n + ' pending order' + (n === 1 ? '' : 's') + ' cancelled.');
    }
    save();
    renderAll();
  }

  // ─── Auto square-off at market close ────────────────────────────
  // Runs every 30s. Once IST time passes EOD cutoff (15:25), closes all
  // open positions. Per the project's "EOD is unconditional" invariant
  // (AGENTS.md §9), we MUST never leave a position open past cutoff —
  // so prices fall back through: live cache → pos.lastPx → pos.entry.
  // The day-guard is set only after state.open is actually empty; if
  // anything slipped through (it shouldn't with the fallback chain),
  // the next 30s tick retries instead of latching success forever.
  var eodFiredFor = null; // YYYY-MM-DD string of last day we squared off
  function checkEodSquareOff() {
    // Early-exit when nothing to do. Pending orders also count — an
    // unfilled LIMIT/STOP queued at 14:55 must be auto-cancelled at
    // 15:25 along with the open-position square-off (matches Upstox's
    // DAY-order convention: any order not filled by market close is
    // cancelled by the exchange).
    if (!state.open.length && !state.pending.length) return;
    var d = new Date();
    var ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    var dayKey = ist.getFullYear() + '-' + (ist.getMonth() + 1) + '-' + ist.getDate();
    var hh = ist.getHours(), mm = ist.getMinutes();
    var pastCutoff = (hh > EOD_HOUR) || (hh === EOD_HOUR && mm >= EOD_MINUTE);
    var dow = ist.getDay();
    if (dow === 0 || dow === 6) return;
    if (!pastCutoff) return;
    if (eodFiredFor === dayKey) return;

    var beforeOpen = state.open.length;
    var beforePending = state.pending.length;
    state.open.slice().forEach(function (p) {
      var px;
      if (p.kind === 'OPT') {
        px = state.optPrices[p.instrumentKey] || p.lastPx || p.entry;
      } else {
        px = state.lastLTP || p.lastPx || p.entry;
      }
      exit(p.id, 'EOD', px);
    });
    // Auto-cancel all unfilled pending orders (silent — toast below
    // already covers the EOD event, no need for a second one).
    if (state.pending.length) cancelAllPending(true);

    var closed = beforeOpen - state.open.length;
    var cancelled = beforePending - state.pending.length;
    if (state.open.length === 0 && state.pending.length === 0) {
      eodFiredFor = dayKey;
    }
    if (closed > 0 || cancelled > 0) {
      var bits = [];
      if (closed > 0) bits.push(closed + ' position' + (closed === 1 ? '' : 's') + ' closed');
      if (cancelled > 0) bits.push(cancelled + ' pending order' + (cancelled === 1 ? '' : 's') + ' cancelled');
      showToast('eod', 'AUTO SQUARE-OFF',
        bits.join(' \u00B7 ') + ' at <b>' +
        EOD_HOUR + ':' + (EOD_MINUTE < 10 ? '0' : '') + EOD_MINUTE + ' IST</b> (market close).');
    }
  }

  function startEodTimer() {
    if (state.eodTimer) return;
    state.eodTimer = setInterval(checkEodSquareOff, 30000);
    // Run once immediately so reopening the page after 15:25 with stale
    // positions still triggers a square-off (using last known prices).
    checkEodSquareOff();
  }

  // ─── Toast notification (auto-dismiss) ──────────────────────────
  function ensureToastHost() {
    var host = document.getElementById('pt-toast-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'pt-toast-host';
    host.className = 'pt-toast-host';
    document.body.appendChild(host);
    return host;
  }
  function showToast(kind, title, html) {
    var host = ensureToastHost();
    var t = document.createElement('div');
    t.className = 'pt-toast ' + kind;
    t.innerHTML = '<div class="pt-toast-title">' + title + '</div>' +
      '<div class="pt-toast-body">' + html + '</div>';
    host.appendChild(t);
    setTimeout(function () { t.classList.add('fade'); }, 4500);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4900);
  }

  // ── In-app confirm modal (replaces window.confirm) ─────────────
  // Promise-based API:
  //   confirmModal({title, message, confirmLabel, cancelLabel, danger})
  //     -> Promise<boolean>   (resolves true on Confirm, false on Cancel/ESC)
  //
  // - `message` may contain "\n\n" for paragraph breaks; rendered as
  //   one <p> per paragraph. Text is set via textContent so callers
  //   don't need to HTML-escape.
  // - `danger:true` paints the OK button red, swaps the head icon to
  //   the red trash glyph, and defaults focus to Cancel (safer for
  //   destructive ops like Reset / Clear History / Exit All).
  // - ESC dismisses (resolves false). ENTER confirms (resolves true).
  //   TAB cycles focus between Cancel and Confirm (focus trap).
  // - Restores focus to the launching element on close (accessibility).
  // - Falls back to native confirm() if the modal markup hasn't been
  //   injected yet (defensive; should never happen in practice).
  function confirmModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = document.getElementById('pt-confirm-modal');
      if (!modal) {
        resolve(window.confirm(opts.message || opts.title || 'Are you sure?'));
        return;
      }
      var titleEl  = document.getElementById('pt-confirm-title');
      var msgEl    = document.getElementById('pt-confirm-msg');
      var okBtn    = document.getElementById('pt-confirm-ok');
      var cancelBtn = document.getElementById('pt-confirm-cancel');
      var iconEl   = document.getElementById('pt-confirm-icon');

      titleEl.textContent = opts.title || 'Are you sure?';
      okBtn.textContent     = opts.confirmLabel || 'CONFIRM';
      cancelBtn.textContent = opts.cancelLabel  || 'CANCEL';

      // Render message — split on blank lines into <p> blocks.
      msgEl.textContent = '';
      var paras = (opts.message || '').split(/\n\s*\n/);
      paras.forEach(function (p) {
        var pEl = document.createElement('p');
        pEl.textContent = p;
        msgEl.appendChild(pEl);
      });

      // Danger styling for destructive ops
      var danger = !!opts.danger;
      okBtn.classList.toggle('danger', danger);
      iconEl.classList.toggle('danger', danger);
      // Swap icon glyph: warning triangle (default) ↔ trash (danger)
      iconEl.innerHTML = danger
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          + 'stroke-linecap="round" stroke-linejoin="round">'
          +   '<polyline points="3,6 5,6 21,6" />'
          +   '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />'
          +   '<path d="M10 11v6M14 11v6" />'
          +   '<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />'
          + '</svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          + 'stroke-linecap="round" stroke-linejoin="round">'
          +   '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />'
          +   '<line x1="12" y1="9" x2="12" y2="13" />'
          +   '<line x1="12" y1="17" x2="12.01" y2="17" />'
          + '</svg>';

      var prevFocus = document.activeElement;

      function cleanup() {
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKey, true);
        okBtn.removeEventListener('click', onOk);
        modal.removeEventListener('click', onModalClick);
        if (prevFocus && typeof prevFocus.focus === 'function') {
          try { prevFocus.focus(); } catch (_) { /* element gone */ }
        }
      }
      function onOk()     { cleanup(); resolve(true); }
      function onCancel() { cleanup(); resolve(false); }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter') {
          if (e.target && e.target.tagName === 'BUTTON') return; // let click fire
          e.preventDefault(); onOk();
        } else if (e.key === 'Tab') {
          // 2-element focus trap
          var focusables = [cancelBtn, okBtn];
          var idx = focusables.indexOf(document.activeElement);
          if (e.shiftKey) {
            if (idx <= 0) { e.preventDefault(); okBtn.focus(); }
          } else {
            if (idx === focusables.length - 1 || idx === -1) {
              e.preventDefault(); cancelBtn.focus();
            }
          }
        }
      }
      function onModalClick(e) {
        // Backdrop click + Cancel button both carry data-pt-confirm-cancel
        if (e.target && e.target.hasAttribute &&
            e.target.hasAttribute('data-pt-confirm-cancel')) onCancel();
      }

      okBtn.addEventListener('click', onOk);
      modal.addEventListener('click', onModalClick);
      document.addEventListener('keydown', onKey, true);

      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      // Default focus on Cancel for destructive ops (less risk of
      // accidental ENTER-confirm), OK for benign / sanity-check.
      setTimeout(function () {
        (danger ? cancelBtn : okBtn).focus();
      }, 30);
    });
  }

  // ─── Per-position SL / Target inline edit ──────────────────────
  // The user types the absolute premium price (e.g. "165") in the SL or
  // Target input on an open position row. Empty / 0 clears the trigger so
  // the position stays open until manual exit or the 15:25 IST square-off.
  // The SL can be edited at any time during the trade — e.g. raise it from
  // 100 to 105 once the premium has moved up, to lock in some profit.
  function updatePosRisk(id, which, raw) {
    var pos = state.open.filter(function (p) { return p.id === id; })[0];
    if (!pos) return;
    var v = parseFloat(raw);
    var cleared = (raw === '' || !isFinite(v) || v <= 0);
    if (cleared) {
      if (which === 'sl') pos.sl = null;
      else pos.tgt = null;
    } else {
      v = +v.toFixed(2);
      if (which === 'sl') pos.sl = v;
      else pos.tgt = v;
    }
    save();
    renderOpen();
    checkRiskTriggers();
  }

  // Build a friendly instrument label, e.g. "NIFTY" or "24150 CE / 13-May"
  function instrumentLabel(p) {
    if (p.kind === 'OPT') {
      var dt = '';
      try {
        dt = new Date(p.expiry).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });
      } catch (e) { dt = p.expiry; }
      var cls = p.optType === 'CE' ? 'ce' : 'pe';
      return '<span class="pt-inst-tag ' + cls + '">' + p.strike + ' ' + p.optType + '</span>'
        + '<span style="font-size:10.5px;color:var(--muted);font-family:monospace;margin-left:6px">' + dt + '</span>';
    }
    return '<span class="pt-inst-tag idx">' + (p.symbol || 'NIFTY') + '</span>';
  }

  function sideLabel(p) {
    if (p.kind === 'OPT') {
      return '<span class="pt-side-tag ' + (p.optType === 'CE' ? 'long' : 'short') + '">BUY ' + p.optType + '</span>';
    }
    return '<span class="pt-side-tag ' + (p.side === 'LONG' ? 'long' : 'short') + '">' + p.side + '</span>';
  }

  function reset() {
    confirmModal({
      title: 'Reset options trading?',
      message: 'This clears all open positions, pending orders, and trade history, and resets capital to \u20B91,00,000.\n\nThis cannot be undone.',
      confirmLabel: 'RESET ALL',
      cancelLabel: 'CANCEL',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.capital = START_CAPITAL;
      state.open = [];
      state.history = [];
      state.pending = [];
      state.qtyCE = 1;
      state.qtyPE = 1;
      save();
      renderAll();
    });
  }

  function clearHistory() {
    if (!state.history.length) return;
    var n = state.history.length;
    confirmModal({
      title: 'Clear trade history?',
      message: 'Remove ' + n + ' closed trade' + (n === 1 ? '' : 's') + ' from history.\n\nThis does NOT affect open positions or capital.',
      confirmLabel: 'CLEAR HISTORY',
      cancelLabel: 'KEEP',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      state.history = [];
      save();
      renderAll();
    });
  }

  // ── Renderers ──
  // ── Open Positions: tabular layout ─────────────────────────────
  // 11 columns: Instrument / Side / Lots / Entry / Time / LTP / Pts /
  // P&L / Stop Loss / Target / [EXIT button]. data-pos-id + the
  // .pt-c-ltp / .pt-c-pts / .pt-c-pnl class hooks are preserved so
  // updateOpenRows() keeps doing zero-flicker in-place updates on
  // each tick — same contract as the previous card renderer, just a
  // denser, more scannable visual.
  function renderOpen() {
    var tb = $('pt-open-tbody');
    if (!tb) return;
    if (!state.open.length) {
      tb.innerHTML = '<tr><td colspan="11" class="pt-empty">No open positions. Pick a strike from the dropdown \u2192 click <b>BUY CE</b> or <b>BUY PE</b> to open one.</td></tr>';
    } else {
      tb.innerHTML = state.open.map(function (p) {
        var px = priceFor(p);
        var calc = px ? pnlOf(p, px) : { pts: 0, inr: 0 };
        var color = px ? (calc.inr >= 0 ? 'var(--bull)' : 'var(--bear)') : 'var(--muted)';
        // Lots column: option positions show the lot count (P&L math
        // multiplies by LOT_SIZE_NIFTY in pnlOf); index positions
        // store raw shares.
        var lotStr = (p.kind === 'OPT')
          ? (p.qty + ' \u00D7 ' + LOT_SIZE_NIFTY)
          : String(p.qty);

        // Risk inputs (only for option positions). Autofill /
        // password-manager opt-out attributes (autocomplete=off,
        // data-1p-ignore, data-lpignore, data-bwignore) prevent
        // Chrome / 1Password / LastPass / Bitwarden from offering a
        // "Save password?" prompt on SL/Target fields.
        var slCell, tgtCell;
        if (p.kind === 'OPT') {
          var slVal = (p.sl != null) ? p.sl.toFixed(2) : '';
          var tgtVal = (p.tgt != null) ? p.tgt.toFixed(2) : '';
          var posLabel = p.strike + ' ' + p.optType;
          slCell = '<td class="pt-c-sl">'
            + '<input class="pt-risk-input pt-risk-input-sl" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" '
            +   'value="' + slVal + '" placeholder="set price" '
            +   'name="pt_risk_sl_' + p.id + '" '
            +   'autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore '
            +   'aria-label="Stop loss premium for ' + posLabel + '" '
            +   'title="Stop Loss \u2014 type the premium price at which to auto-exit (e.g. bought at 160, set 150). Leave empty for no auto-exit." '
            +   'onchange="ptUpdatePosRisk(\'' + p.id + '\',\'sl\',this.value)" '
            +   'onclick="this.select()">'
            + '</td>';
          tgtCell = '<td class="pt-c-tgt">'
            + '<input class="pt-risk-input pt-risk-input-tgt" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" '
            +   'value="' + tgtVal + '" placeholder="set price" '
            +   'name="pt_risk_tgt_' + p.id + '" '
            +   'autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore '
            +   'aria-label="Target premium for ' + posLabel + '" '
            +   'title="Target \u2014 type the premium price at which to auto-exit (e.g. bought at 160, set 180). Leave empty for no auto-exit." '
            +   'onchange="ptUpdatePosRisk(\'' + p.id + '\',\'tgt\',this.value)" '
            +   'onclick="this.select()">'
            + '</td>';
        } else {
          slCell = '<td class="pt-c-sl"><span class="pt-c-na">\u2014</span></td>';
          tgtCell = '<td class="pt-c-tgt"><span class="pt-c-na">\u2014</span></td>';
        }

        return '<tr data-pos-id="' + p.id + '">'
          + '<td>' + instrumentLabel(p) + '</td>'
          + '<td>' + sideLabel(p) + '</td>'
          + '<td>' + lotStr + '</td>'
          + '<td>' + p.entry.toFixed(2) + '</td>'
          + '<td>' + fmtTime(p.entryTs) + '</td>'
          + '<td class="pt-c-ltp">' + (px ? px.toFixed(2) : '\u2014') + '</td>'
          + '<td class="pt-c-pts" style="color:' + color + '">' + (px ? fmtPts(calc.pts) : '\u2014') + '</td>'
          + '<td class="pt-c-pnl" style="color:' + color + ';font-weight:600">' + (px ? fmtINR(calc.inr) : '\u2014') + '</td>'
          + slCell
          + tgtCell
          + '<td><button class="pt-exit-btn" type="button" onclick="ptExit(\'' + p.id + '\')">EXIT</button></td>'
          + '</tr>';
      }).join('');
    }
    $('pt-open-cnt').textContent = '(' + state.open.length + ')';
  }

  // ── Pending Orders: card layout ────────────────────────────────
  // Mirrors the Open Positions card shape. Header has instrument tag +
  // order-type pill + lots + placed-time. A 3-up metric row shows
  // Trigger / Live LTP / Distance-to-Fire (the big "how close?" answer).
  // Footer carries the attached SL/Target as colored chips and the
  // CANCEL button. data-pending-id and .pt-c-pending-ltp /
  // .pt-c-pending-dist are preserved for updatePendingRows().
  function renderPending() {
    var tb = $('pt-pending-cards');
    var cnt = $('pt-pending-cnt');
    if (!tb) return;
    if (cnt) cnt.textContent = '(' + state.pending.length + ')';
    if (!state.pending.length) {
      tb.innerHTML = '<div class="pt-empty pt-empty-card">'
        + 'No pending orders. Pick <b>LIMIT</b> or <b>STOP</b> in the CE/PE '
        + 'card above, enter your trigger price, then click <b>PLACE LIMIT / STOP BUY</b> '
        + 'to queue one.</div>';
      return;
    }
    tb.innerHTML = state.pending.map(function (p) {
      var px = state.optPrices[p.instrumentKey];
      var pxText = (isFinite(px) && px > 0) ? '\u20B9' + px.toFixed(2) : '\u2014';
      var dist = '\u2014', distColor = 'var(--muted)';
      if (isFinite(px) && px > 0) {
        var pct = ((px - p.triggerPrice) / p.triggerPrice) * 100;
        // For LIMIT BUY (waiting to drop), "distance to fire" means how
        // much further the premium needs to fall — a NEGATIVE pct means
        // the trigger is below current → distance = magnitude. For STOP
        // BUY (waiting to rise) it's the opposite. We show absolute %
        // with an arrow so the user instantly sees direction-to-fire.
        var needsToFall = (p.orderType === 'LIMIT' && px > p.triggerPrice);
        var needsToRise = (p.orderType === 'STOP'  && px < p.triggerPrice);
        if (needsToFall) {
          dist = '\u25BC ' + Math.abs(pct).toFixed(2) + '%';
          distColor = 'var(--bear)';
        } else if (needsToRise) {
          dist = '\u25B2 ' + Math.abs(pct).toFixed(2) + '%';
          distColor = 'var(--bull)';
        } else {
          dist = 'firing\u2026';
          distColor = 'var(--info)';
        }
      }
      var typeCls = p.orderType.toLowerCase();
      var typeTag = '<span class="pt-pending-tag ' + typeCls + '">'
        + p.orderType + ' BUY</span>';
      var slChip = (p.sl != null)
        ? '<span class="pt-pend-risk-chip sl" title="Attached stop-loss after fill">SL \u20B9' + p.sl.toFixed(2) + '</span>'
        : '<span class="pt-pend-risk-chip empty" title="No attached stop-loss">SL \u2014</span>';
      var tgtChip = (p.tgt != null)
        ? '<span class="pt-pend-risk-chip tgt" title="Attached target after fill">TGT \u20B9' + p.tgt.toFixed(2) + '</span>'
        : '<span class="pt-pend-risk-chip empty" title="No attached target">TGT \u2014</span>';
      var lotStr = p.qty + ' lot' + (p.qty === 1 ? '' : 's') + ' \u00B7 '
                 + (p.qty * LOT_SIZE_NIFTY) + ' qty';
      return '<div class="pt-pend-card ' + typeCls + '" data-pending-id="' + p.id + '">'
        + '<div class="pt-pos-head">'
        +   instrumentLabel(p)
        +   typeTag
        +   '<span class="pt-pos-lots">' + lotStr + '</span>'
        +   '<span class="pt-pos-time">placed ' + fmtTime(p.placedTs) + '</span>'
        + '</div>'
        + '<div class="pt-pend-prices">'
        +   '<div class="pt-pos-m"><span class="pt-pos-m-lbl">Trigger</span><span class="pt-pos-m-val">\u20B9' + p.triggerPrice.toFixed(2) + '</span></div>'
        +   '<div class="pt-pos-m"><span class="pt-pos-m-lbl">Live LTP</span><span class="pt-pos-m-val pt-c-pending-ltp">' + pxText + '</span></div>'
        +   '<div class="pt-pend-dist-card">'
        +     '<span class="pt-pos-m-lbl">Distance to Fire</span>'
        +     '<span class="pt-pend-dist-val pt-c-pending-dist" style="color:' + distColor + '">' + dist + '</span>'
        +   '</div>'
        + '</div>'
        + '<div class="pt-pend-foot">'
        +   slChip + tgtChip
        +   '<button class="pt-cancel-btn" type="button" onclick="ptCancelPending(\''
        +     p.id + '\')">CANCEL</button>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  // In-place tick update for pending-orders LTP + Distance cells.
  // Cheap — same pattern as updateOpenRows; only touches the two cells
  // that need a refresh per row, no full table rebuild.
  function updatePendingRows() {
    if (!state.pending.length) return;
    state.pending.forEach(function (p) {
      var row = document.querySelector('[data-pending-id="' + p.id + '"]');
      if (!row) return;
      var px = state.optPrices[p.instrumentKey];
      if (!isFinite(px) || px <= 0) return;
      var ltpC = row.querySelector('.pt-c-pending-ltp');
      var distC = row.querySelector('.pt-c-pending-dist');
      if (ltpC) ltpC.textContent = '\u20B9' + px.toFixed(2);
      if (distC) {
        var pct = ((px - p.triggerPrice) / p.triggerPrice) * 100;
        var needsToFall = (p.orderType === 'LIMIT' && px > p.triggerPrice);
        var needsToRise = (p.orderType === 'STOP'  && px < p.triggerPrice);
        if (needsToFall) {
          distC.textContent = '\u25BC ' + Math.abs(pct).toFixed(2) + '%';
          distC.style.color = 'var(--bear)';
        } else if (needsToRise) {
          distC.textContent = '\u25B2 ' + Math.abs(pct).toFixed(2) + '%';
          distC.style.color = 'var(--bull)';
        } else {
          distC.textContent = 'firing\u2026';
          distC.style.color = 'var(--info)';
        }
      }
    });
  }

  // ── Trade History: timeline rows ──────────────────────────────
  // Each closed trade is one row with a coloured left-edge strip
  // (green=win, red=loss, gray=flat). Lead column has result + reason
  // badges, centre column has instrument + entry→exit flow, right
  // column has the big P&L value + points (color-coded). All 10
  // original data fields are preserved: result, instrument tag,
  // BUY CE/PE side, lots (inside instrument line), entry price+time,
  // exit price+time, points, P&L, hold duration, exit reason.
  function renderHistory() {
    var tb = $('pt-hist-tbody');
    if (!tb) return;
    if (!state.history.length) {
      tb.innerHTML = '<tr><td colspan="9" class="pt-empty">No closed trades yet. Trade history will appear here after you EXIT a position.</td></tr>';
    } else {
      tb.innerHTML = state.history.map(function (h) {
        var color  = h.pnl > 0 ? 'var(--bull)' : (h.pnl < 0 ? 'var(--bear)' : 'var(--muted)');
        var resTag = h.pnl > 0 ? 'win' : (h.pnl < 0 ? 'loss' : 'flat');
        var resTxt = h.pnl > 0 ? 'PROFIT' : (h.pnl < 0 ? 'LOSS' : 'FLAT');
        var reason = (h.exitReason || 'MANUAL').toLowerCase();
        var reasonTxt = h.exitReason === 'SL'  ? 'SL HIT'
                      : h.exitReason === 'TGT' ? 'TARGET'
                      : h.exitReason === 'EOD' ? 'EOD'
                      :                          'MANUAL';
        var reasonPill = '<span class="pt-reason-tag ' + reason + '" title="Exit trigger">' + reasonTxt + '</span>';
        var resultPill = '<span class="pt-result-tag ' + resTag + '">' + resTxt + '</span>';
        return '<tr>'
          + '<td>' + resultPill + '<br><span style="display:inline-block;margin-top:4px">' + reasonPill + '</span></td>'
          + '<td>' + instrumentLabel(h) + '</td>'
          + '<td>' + sideLabel(h) + '</td>'
          + '<td>' + h.qty + '</td>'
          + '<td>' + h.entry.toFixed(2) + '<br><span style="font-size:10.5px;color:var(--muted);font-family:monospace">' + fmtTime(h.entryTs) + '</span></td>'
          + '<td>' + h.exit.toFixed(2)  + '<br><span style="font-size:10.5px;color:var(--muted);font-family:monospace">' + fmtTime(h.exitTs)  + '</span></td>'
          + '<td style="color:' + color + '">' + fmtPts(h.pts) + '</td>'
          + '<td style="color:' + color + ';font-weight:600">' + fmtINR(h.pnl) + '</td>'
          + '<td>' + fmtDur(h.exitTs - h.entryTs) + '</td>'
          + '</tr>';
      }).join('');
    }
    var cntEl = $('pt-hist-cnt');
    if (cntEl) cntEl.textContent = '(' + state.history.length + ')';
  }

  function renderStats() {
    var n = state.history.length;
    if (!n) {
      // Early-return path: same DOM-safety guards as the populated
      // path below (these elements live in content/live.html which
      // is lazy-loaded; first call from DOMContentLoaded sees null).
      var elN0 = $('pt-stat-n');     if (elN0) elN0.textContent = '0';
      var elWr0 = $('pt-stat-wr');   if (elWr0) elWr0.innerHTML = '\u2014';
      var elAvg0 = $('pt-stat-avg'); if (elAvg0) elAvg0.innerHTML = '\u2014';
      var elBest0 = $('pt-stat-best'); if (elBest0) elBest0.innerHTML = '\u2014';
      var elWorst0 = $('pt-stat-worst'); if (elWorst0) elWorst0.innerHTML = '\u2014';
      return;
    }
    // FLAT trades (P&L exactly 0 — entry == exit) are excluded from the
    // win-rate denominator so they don't pull the rate down. Industry
    // convention: only winning vs losing trades count toward the rate.
    //
    // Best Trade  → max P&L among WINNING trades only (null if no wins)
    // Worst Trade → min P&L among LOSING  trades only (null if no losses)
    //
    // This keeps the labels honest: "Best Trade" never shows a negative
    // number, "Worst Trade" never shows a positive number. When there's
    // nothing of that sign in the history we just render a dash —
    // far less misleading than calling a -₹1,336 outcome the "best".
    var wins = 0, decided = 0, sum = 0;
    var bestProfit = null, worstLoss = null;
    state.history.forEach(function (h) {
      if (h.pnl > 0) {
        wins++; decided++;
        if (bestProfit === null || h.pnl > bestProfit) bestProfit = h.pnl;
      } else if (h.pnl < 0) {
        decided++;
        if (worstLoss === null || h.pnl < worstLoss) worstLoss = h.pnl;
      }
      sum += h.pnl;
    });
    var wr = decided > 0 ? (wins / decided) * 100 : null;
    var avg = sum / n;
    // DOM-safety: these elements live inside content/live.html which
    // is lazy-loaded. renderStats is called from DOMContentLoaded
    // (via renderAll) BEFORE the live section has been injected, so
    // every $() may return null on the first call. Guard each write
    // so a missing element silently no-ops instead of throwing —
    // renderAll will be re-run later once content/live.html is in.
    var elN = $('pt-stat-n');
    if (elN) elN.textContent = n;
    var elWr = $('pt-stat-wr');
    if (elWr) {
      if (wr === null) {
        elWr.innerHTML = '<span style="color:var(--muted)" title="No decided trades yet (only flat trades). Win rate excludes flat trades.">\u2014</span>';
      } else {
        elWr.innerHTML = '<span style="color:' + (wr >= 50 ? 'var(--bull)' : 'var(--bear)') + '">' + wr.toFixed(0) + '%</span>';
      }
    }
    var elAvg = $('pt-stat-avg');
    if (elAvg) elAvg.innerHTML = '<span style="color:' + (avg >= 0 ? 'var(--bull)' : 'var(--bear)') + '">' + fmtINR(avg) + '</span>';
    var elBest = $('pt-stat-best');
    if (elBest) elBest.innerHTML = (bestProfit !== null)
      ? '<span style="color:var(--bull)">' + fmtINR(bestProfit) + '</span>'
      : '<span style="color:var(--muted)" title="No winning trades yet.">\u2014</span>';
    var elWorst = $('pt-stat-worst');
    if (elWorst) elWorst.innerHTML = (worstLoss !== null)
      ? '<span style="color:var(--bear)">' + fmtINR(worstLoss) + '</span>'
      : '<span style="color:var(--muted)" title="No losing trades yet.">\u2014</span>';
  }

  // ── Today's realized P&L (trades closed today, IST) ─────────
  // Uses Asia/Kolkata day boundary regardless of user's locale.
  function istDayKey(ts) {
    var d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function renderTodayPnL() {
    var el = $('pt-pnl-today');
    var sub = $('pt-pnl-today-sub');
    if (!el || !sub) return;
    var todayKey = istDayKey(Date.now());
    var todays = state.history.filter(function (h) { return istDayKey(h.exitTs) === todayKey; });
    var sum = todays.reduce(function (a, h) { return a + (h.pnl || 0); }, 0);
    el.textContent = fmtINR(sum);
    el.style.color = sum > 0 ? 'var(--bull)' : (sum < 0 ? 'var(--bear)' : 'var(--text)');
    sub.textContent = todays.length + (todays.length === 1 ? ' trade' : ' trades');
  }

  function renderEquity() {
    var floating = 0;
    state.open.forEach(function (p) {
      var px = priceFor(p);
      if (px) floating += pnlOf(p, px).inr;
    });
    var total = state.capital + floating;
    var pct = ((total - START_CAPITAL) / START_CAPITAL) * 100;
    // DOM-safety: same lazy-load null guard as renderStats —
    // content/live.html may not be injected yet on the first
    // DOMContentLoaded renderAll, so $() can return null.
    var eqEl = $('pt-equity');
    if (eqEl) eqEl.textContent = fmtINR(total);
    var pctEl = $('pt-equity-pct');
    if (pctEl) {
      pctEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      pctEl.style.color = pct >= 0 ? 'var(--bull)' : 'var(--bear)';
    }

    // Open P&L stat cell
    var pnlEl = $('pt-pnl-open');
    var pnlPctEl = $('pt-pnl-open-pct');
    if (pnlEl) {
      pnlEl.textContent = fmtINR(floating);
      pnlEl.style.color = floating >= 0 ? 'var(--bull)' : 'var(--bear)';
    }
    if (pnlPctEl) {
      var pctFloat = state.capital > 0 ? (floating / state.capital) * 100 : 0;
      pnlPctEl.textContent = (pctFloat >= 0 ? '+' : '') + pctFloat.toFixed(2) + '%';
      pnlPctEl.style.color = floating >= 0 ? 'var(--bull)' : 'var(--bear)';
    }
  }

  function renderSpot() {
    var el = $('pt-spot');
    if (!el) return;
    if (state.lastLTP) {
      el.textContent = state.lastLTP.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else {
      el.textContent = '\u2014';
    }
    // Subtitle reflects live tick rate during market hours, "Last close" otherwise.
    var sub = $('pt-spot-sub');
    if (sub) {
      var marketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
      sub.textContent = marketOpen ? 'Live (1s)' : 'Last close';
    }
  }

  function setBtnState() {
    var idxDisabled = !state.lastLTP;
    var b = $('pt-buy-btn'), s = $('pt-sell-btn');
    if (b) { b.disabled = idxDisabled; b.title = idxDisabled ? 'Connect Upstox token and start the chart first' : 'Long Nifty at current LTP'; }
    if (s) { s.disabled = idxDisabled; s.title = idxDisabled ? 'Connect Upstox token and start the chart first' : 'Short Nifty at current LTP'; }

    // Option buttons require a strike with a real premium
    var ceBtn = $('pt-buy-ce-btn'), peBtn = $('pt-buy-pe-btn');
    var trigger = $('pt-strike-trigger');
    var hasChain = !!window.optionChainData;
    var hasStrike = hasChain && state.selectedStrike != null;
    if (trigger) { trigger.disabled = !hasChain; }
    if (ceBtn) {
      ceBtn.disabled = !hasStrike;
      ceBtn.textContent = orderButtonLabel('CE');
      ceBtn.title = hasStrike
        ? orderButtonTooltip('CE')
        : 'Strikes will load when chart starts';
    }
    if (peBtn) {
      peBtn.disabled = !hasStrike;
      peBtn.textContent = orderButtonLabel('PE');
      peBtn.title = hasStrike
        ? orderButtonTooltip('PE')
        : 'Strikes will load when chart starts';
    }
  }

  // Compose the BUY button label based on the current order type. Keeps
  // the visual mapping crystal-clear:
  //   MARKET → "BUY CE" / "BUY PE"   (unchanged; what users always saw)
  //   LIMIT  → "PLACE LIMIT BUY CE" / "PLACE LIMIT BUY PE"
  //   STOP   → "PLACE STOP BUY CE"  / "PLACE STOP BUY PE"
  function orderButtonLabel(optType) {
    var orderType = optType === 'CE' ? state.orderTypeCE : state.orderTypePE;
    if (orderType === 'MARKET') return 'BUY ' + optType;
    return 'PLACE ' + orderType + ' BUY ' + optType;
  }
  function orderButtonTooltip(optType) {
    var orderType = optType === 'CE' ? state.orderTypeCE : state.orderTypePE;
    if (orderType === 'MARKET') return 'Buy ' + optType + ' at the live premium right now';
    if (orderType === 'LIMIT') return 'Queue a LIMIT BUY \u2014 will fill when the premium DROPS to your trigger price (pullback entry)';
    return 'Queue a STOP BUY \u2014 will fill when the premium RISES to your trigger price (breakout entry)';
  }

  // ─── Order-ticket form handlers ─────────────────────────────────
  // Toggle MARKET / LIMIT / STOP for a given side. Mutates state, then
  // updates the segmented selector's active pill, shows/hides the
  // trigger + risk inputs, refreshes the button label.
  function setOrderType(sideLower, orderType) {
    if (sideLower !== 'ce' && sideLower !== 'pe') return;
    if (['MARKET', 'LIMIT', 'STOP'].indexOf(orderType) === -1) return;
    if (sideLower === 'ce') state.orderTypeCE = orderType;
    else state.orderTypePE = orderType;

    // Sync segmented selector visuals
    document.querySelectorAll('.pt-ot-pill[data-side="' + sideLower + '"]')
      .forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-type') === orderType);
      });

    // Show/hide trigger + risk inputs. MARKET clears any stale values
    // so the next switch to LIMIT/STOP starts from a blank slate.
    var trig = $('pt-ot-trigger-' + sideLower);
    var risk = $('pt-ot-risk-' + sideLower);
    var hint = $('pt-ot-hint-' + sideLower);
    var isAdvanced = (orderType === 'LIMIT' || orderType === 'STOP');
    if (trig) trig.hidden = !isAdvanced;
    if (risk) risk.hidden = !isAdvanced;
    if (hint) hint.hidden = !isAdvanced;
    if (!isAdvanced) {
      if (trig) trig.value = '';
      if (risk) {
        var inputs = risk.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) inputs[i].value = '';
      }
      if (sideLower === 'ce') {
        state.triggerPxCE = null;
        state.attachedSlCE = null;
        state.attachedTgtCE = null;
      } else {
        state.triggerPxPE = null;
        state.attachedSlPE = null;
        state.attachedTgtPE = null;
      }
    }
    refreshOrderHint(sideLower);
    setBtnState();
  }

  // Persist the typed trigger price into state. Empty / non-positive
  // resolves to null (placeOpt's LIMIT/STOP branch will block submit
  // with a clear message). Plain text input, not type=number, so the
  // user can clear by deleting characters one at a time without the
  // browser snapping to 0.
  function setTriggerPrice(sideLower, raw) {
    var v = parseFloat(raw);
    var cleared = (raw === '' || !isFinite(v) || v <= 0);
    var px = cleared ? null : +v.toFixed(2);
    if (sideLower === 'ce') state.triggerPxCE = px;
    else state.triggerPxPE = px;
    refreshOrderHint(sideLower);
  }

  // Persist attached SL/TGT for the order ticket. Same null-on-empty
  // semantics as setTriggerPrice. These are OPTIONAL — leaving them
  // empty places a "naked" LIMIT/STOP that fills with no auto-exit.
  function setAttachedRisk(sideLower, which, raw) {
    var v = parseFloat(raw);
    var cleared = (raw === '' || !isFinite(v) || v <= 0);
    var px = cleared ? null : +v.toFixed(2);
    if (sideLower === 'ce') {
      if (which === 'sl') state.attachedSlCE = px;
      else state.attachedTgtCE = px;
    } else {
      if (which === 'sl') state.attachedSlPE = px;
      else state.attachedTgtPE = px;
    }
    refreshOrderHint(sideLower);
  }

  // Live hint string below the order ticket. Reads current premium,
  // trigger, and order type and tells the user in plain English what
  // will happen. Reactive to every keystroke AND every LTP poll tick
  // (via refreshOrderHintsLive below) so the "X% from current ₹Y"
  // copy never goes stale — important because a stale hint would
  // imply the order is far from firing when in reality it's about to.
  function refreshOrderHint(sideLower) {
    var hint = $('pt-ot-hint-' + sideLower);
    if (!hint) return;
    var orderType = sideLower === 'ce' ? state.orderTypeCE : state.orderTypePE;
    if (orderType === 'MARKET') { hint.hidden = true; hint.innerHTML = ''; return; }
    var trig = sideLower === 'ce' ? state.triggerPxCE : state.triggerPxPE;
    // Prefer the 1-second-fresh state.optPrices over the slower
    // chain.market_data.ltp (refreshed every 30s by upFetchChain).
    // Without this the hint would show the 30s-old chain price while
    // the dashboard premium card right above shows the 1s-fresh one,
    // which is confusing and can be downright misleading on a fast
    // move (hint says "▼ 0.05% from ₹103.05" while the actual ₹101.85
    // already crossed the trigger).
    var chain = window.optionChainData;
    var curPremium = null;
    if (chain && state.selectedStrike != null) {
      var row = chain.strikes.filter(function (s) {
        return s.strike_price === state.selectedStrike;
      })[0];
      if (row) {
        var leg = sideLower === 'ce' ? row.call_options : row.put_options;
        if (leg && leg.instrument_key) {
          var fresh = state.optPrices[leg.instrument_key];
          if (isFinite(fresh) && fresh > 0) curPremium = fresh;
        }
        if (curPremium == null && leg && leg.market_data && +leg.market_data.ltp > 0) {
          curPremium = +leg.market_data.ltp;
        }
      }
    }
    hint.hidden = false;
    if (trig == null) {
      hint.innerHTML = 'Will fire when premium ' +
        (orderType === 'LIMIT' ? 'DROPS to' : 'RISES to') +
        ' your trigger price.';
      return;
    }
    var rel = '';
    if (curPremium != null) {
      var diff = trig - curPremium;
      var pct = (diff / curPremium) * 100;
      var arrow = diff >= 0 ? '\u25B2' : '\u25BC';
      rel = ' \u00B7 ' + arrow + ' ' + Math.abs(pct).toFixed(2) +
        '% from current <b>\u20B9' + curPremium.toFixed(2) + '</b>';
    }
    hint.innerHTML = 'Fires when premium <b>' +
      (orderType === 'LIMIT' ? '\u2264' : '\u2265') +
      ' \u20B9' + trig.toFixed(2) + '</b>' + rel;
  }

  // Re-paint both order-ticket hints on each LTP poll tick so the
  // "% from current premium" text stays in lock-step with the live
  // CE/PE Premium cards. No-op when both sides are MARKET (hint is
  // hidden in that case so refreshOrderHint short-circuits cheaply).
  function refreshOrderHintsLive() {
    refreshOrderHint('ce');
    refreshOrderHint('pe');
  }

  // Clear the order ticket for one side after a successful place.
  // Order TYPE stays the same (likely placing several LIMITs in a row);
  // only the order-specific fields (trigger + attached SL/TGT) reset.
  function resetOrderTicket(sideLower) {
    var trig = $('pt-ot-trigger-' + sideLower);
    var slEl = $('pt-ot-sl-' + sideLower);
    var tgtEl = $('pt-ot-tgt-' + sideLower);
    if (trig) trig.value = '';
    if (slEl) slEl.value = '';
    if (tgtEl) tgtEl.value = '';
    if (sideLower === 'ce') {
      state.triggerPxCE = null;
      state.attachedSlCE = null;
      state.attachedTgtCE = null;
    } else {
      state.triggerPxPE = null;
      state.attachedSlPE = null;
      state.attachedTgtPE = null;
    }
    refreshOrderHint(sideLower);
  }

  // ─── Custom Strike Picker ───────────────────────────────────────

  // Compute ATM strike (closest to spot)
  function atmStrike(chain) {
    var atm = chain.strikes[0].strike_price, minDiff = Infinity;
    chain.strikes.forEach(function (s) {
      var d = Math.abs(s.strike_price - chain.spot);
      if (d < minDiff) { minDiff = d; atm = s.strike_price; }
    });
    return atm;
  }

  // Side-aware moneyness label for a given strike vs ATM.
  //   side === 'CE'  → call is ITM when strike < ATM, OTM when strike > ATM
  //   side === 'PE'  → put  is ITM when strike > ATM, OTM when strike < ATM
  // Equal strikes are ATM regardless of side.
  function moneyness(strike, atm, side) {
    if (strike === atm) return 'ATM';
    if (side === 'CE') return strike < atm ? 'ITM' : 'OTM';
    return strike > atm ? 'ITM' : 'OTM';
  }

  // Build the list rows inside the picker popup
  function renderStrikeList() {
    var chain = window.optionChainData;
    var list = $('pt-strike-list');
    if (!list) return;
    if (!chain) {
      list.innerHTML = '<div class="pt-strike-empty">Strikes load automatically when chart starts.</div>';
      return;
    }
    var atm = atmStrike(chain);
    var q = (state.strikeFilter || '').trim();
    var rows = chain.strikes.filter(function (s) {
      return q === '' || String(s.strike_price).indexOf(q) >= 0;
    });
    if (!rows.length) {
      list.innerHTML = '<div class="pt-strike-empty">No strikes match "' + q + '"</div>';
      return;
    }
    // Upstox-style row layout: CE on the left, STRIKE in the middle,
    // PE on the right. Each side carries its own ATM/ITM/OTM chip
    // facing the central strike (CE chip on the left of the price,
    // PE chip on the right of the price) so the layout reads
    // symmetrically toward the strike.
    list.innerHTML = rows.map(function (s) {
      var k = s.strike_price;
      var ce = (s.call_options && s.call_options.market_data) ? +s.call_options.market_data.ltp : 0;
      var pe = (s.put_options && s.put_options.market_data) ? +s.put_options.market_data.ltp : 0;
      var ceMon = moneyness(k, atm, 'CE');
      var peMon = moneyness(k, atm, 'PE');
      var ceTagHtml = '<span class="pt-strike-item-tag ' + ceMon.toLowerCase() + '">' + ceMon + '</span>';
      var peTagHtml = '<span class="pt-strike-item-tag ' + peMon.toLowerCase() + '">' + peMon + '</span>';
      var clsAtm = (k === atm) ? ' atm' : '';
      var clsSel = (k === state.selectedStrike) ? ' selected' : '';
      var ceTxt = ce > 0 ? '\u20B9' + ce.toFixed(2) : '\u2014';
      var peTxt = pe > 0 ? '\u20B9' + pe.toFixed(2) : '\u2014';
      var ceDim = ce > 0 ? '' : ' dim';
      var peDim = pe > 0 ? '' : ' dim';
      return '<div class="pt-strike-item' + clsAtm + clsSel + '" data-strike="' + k + '">' +
        '<span class="pt-strike-item-ce">' +
          ceTagHtml +
          '<span class="pt-strike-item-price' + ceDim + '">' + ceTxt + '</span>' +
        '</span>' +
        '<span class="pt-strike-item-strike">' + k + '</span>' +
        '<span class="pt-strike-item-pe">' +
          '<span class="pt-strike-item-price' + peDim + '">' + peTxt + '</span>' +
          peTagHtml +
        '</span>' +
        '</div>';
    }).join('');
    // Bind click handlers (delegation)
    Array.prototype.forEach.call(list.querySelectorAll('.pt-strike-item'), function (el) {
      el.addEventListener('click', function () {
        var k = +el.getAttribute('data-strike');
        selectStrike(k);
        closeStrikes();
      });
    });
    // Auto-scroll selected (or ATM) into view
    var target = list.querySelector('.pt-strike-item.selected') || list.querySelector('.pt-strike-item.atm');
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
  }

  // Helper: paint a moneyness chip element with the right label + class.
  // Works for both `.pt-money-tag` (premium cards) and `.pt-strike-trigger-tag`
  // (trigger button). Pass null label to hide the chip entirely.
  function setMoneyTag(el, label, baseClass) {
    if (!el) return;
    var cls = baseClass || 'pt-money-tag';
    if (!label) {
      el.hidden = true;
      el.textContent = '';
      el.className = cls;
      return;
    }
    el.hidden = false;
    el.textContent = label;
    el.className = cls + ' ' + label.toLowerCase();
  }

  // Format a delta value with explicit sign so the negative-for-PE
  // convention is visually obvious. Returns '—' if missing / NaN.
  // Two decimals matches what every other option-chain UI shows.
  function fmtDelta(d) {
    if (!isFinite(d)) return '\u2014';
    var s = d.toFixed(2);
    return d >= 0 ? '+' + s : s;
  }

  // Implied volatility comes from Upstox as a percentage already
  // (e.g. 30.22 for "30.22% IV") for current contracts. Show it with
  // a trailing % and one decimal — more precision is noise on an IV
  // that's already moving ±0.2% per minute on a busy day.
  function fmtIV(iv) {
    if (!isFinite(iv) || iv <= 0) return '\u2014';
    return iv.toFixed(1) + '%';
  }

  // OI numbers are in the millions on Nifty weeklies. Compress to
  // "X.XL" (lakhs) or "X.XCr" (crore) so they fit in the cramped
  // greek pills without truncation. Threshold cuts: < 100k → raw,
  // < 1 Cr → lakhs (1 lakh = 100,000), >= 1 Cr → crores.
  function fmtOI(oi) {
    if (!isFinite(oi) || oi <= 0) return '\u2014';
    if (oi >= 1e7)   return (oi / 1e7).toFixed(2) + 'Cr';
    if (oi >= 1e5)   return (oi / 1e5).toFixed(2) + 'L';
    if (oi >= 1000)  return (oi / 1000).toFixed(1) + 'K';
    return String(oi);
  }

  // Update the trigger button label + CE/PE premium displays based on state.selectedStrike
  function applySelectedStrike() {
    var chain = window.optionChainData;
    var trigEl = $('pt-strike-current');
    // The "atm" in the id is historical — this element now shows ATM/ITM/OTM
    // depending on the selected strike's relation to ATM (CE convention).
    var trigMonEl = $('pt-strike-atm-tag');
    var ceEl = $('pt-opt-ce-val'), peEl = $('pt-opt-pe-val');
    var ceMonEl = $('pt-opt-ce-money'), peMonEl = $('pt-opt-pe-money');
    // Greek pills (Delta / IV / OI). Same lookups for CE + PE sides.
    var ceDeltaEl = $('pt-ce-delta'), ceIvEl = $('pt-ce-iv'), ceOiEl = $('pt-ce-oi');
    var peDeltaEl = $('pt-pe-delta'), peIvEl = $('pt-pe-iv'), peOiEl = $('pt-pe-oi');

    // Local helper — sets the three greek pills for one side at once.
    // `g` is the option_greeks object from the chain row (or null),
    // `md` is the matching market_data (for OI). Tolerates either
    // half being missing so a partial-payload response still renders.
    function setGreeks(deltaEl, ivEl, oiEl, g, md) {
      if (deltaEl) deltaEl.textContent = g && isFinite(+g.delta) ? fmtDelta(+g.delta) : '\u2014';
      if (ivEl)    ivEl.textContent    = g && isFinite(+g.iv)    ? fmtIV(+g.iv)       : '\u2014';
      if (oiEl)    oiEl.textContent    = md && isFinite(+md.oi)  ? fmtOI(+md.oi)      : '\u2014';
    }

    if (!chain || state.selectedStrike == null) {
      if (trigEl) trigEl.textContent = '\u2014';
      setMoneyTag(trigMonEl, null, 'pt-strike-trigger-tag');
      if (ceEl) ceEl.textContent = '\u2014';
      if (peEl) peEl.textContent = '\u2014';
      setMoneyTag(ceMonEl, null);
      setMoneyTag(peMonEl, null);
      setGreeks(ceDeltaEl, ceIvEl, ceOiEl, null, null);
      setGreeks(peDeltaEl, peIvEl, peOiEl, null, null);
      setBtnState();
      return;
    }

    var atm = atmStrike(chain);
    var k = state.selectedStrike;
    var row = chain.strikes.filter(function (s) { return s.strike_price === k; })[0];

    if (trigEl) trigEl.textContent = String(k);
    // Trigger only flags ATM — that's the only label that's unambiguous
    // for a strike. Side-aware ITM/OTM live on the CE/PE Premium cards
    // below where the leg context is clear.
    setMoneyTag(trigMonEl, k === atm ? 'ATM' : null, 'pt-strike-trigger-tag');

    var cePx = row && row.call_options && row.call_options.market_data ? +row.call_options.market_data.ltp : 0;
    var pePx = row && row.put_options && row.put_options.market_data ? +row.put_options.market_data.ltp : 0;
    if (ceEl) ceEl.textContent = cePx > 0 ? '\u20B9' + cePx.toFixed(2) : '\u2014';
    if (peEl) peEl.textContent = pePx > 0 ? '\u20B9' + pePx.toFixed(2) : '\u2014';

    // Side-aware moneyness next to each premium label so the trader can
    // see that, say, picking 24050 makes the CE leg ITM and the PE leg OTM.
    setMoneyTag(ceMonEl, moneyness(k, atm, 'CE'));
    setMoneyTag(peMonEl, moneyness(k, atm, 'PE'));

    // Greeks come from /option/chain which refreshes every 30s; LTP/OI
    // is also patched in by the 1s LTP poll via syncSelectedStrikePremiumDisplay,
    // but delta/IV move slowly enough that 30s is fine — the trader's
    // not making decisions on micro-vol changes inside a single second.
    setGreeks(
      ceDeltaEl, ceIvEl, ceOiEl,
      row && row.call_options ? row.call_options.option_greeks : null,
      row && row.call_options ? row.call_options.market_data   : null
    );
    setGreeks(
      peDeltaEl, peIvEl, peOiEl,
      row && row.put_options  ? row.put_options.option_greeks  : null,
      row && row.put_options  ? row.put_options.market_data    : null
    );

    setBtnState();
  }

  function selectStrike(k) {
    state.selectedStrike = +k;
    applySelectedStrike();
    // A freshly-picked strike → start the 1s poller so CE/PE Premium
    // cards begin ticking immediately (don't wait for next renderAll).
    // The poller dedupes keys so this is safe to call repeatedly.
    startOptionPolling();
    pollOptionPrices();
    // Notify the intraday analyzer so its plan card re-renders SL/
    // T1/T2/T3 using THIS strike's premium + delta (not the ATM
    // strike's). Without this hook, switching from 23800 (ATM) to
    // 23900 (OTM) would leave the analyzer projecting against the
    // ATM premium, which is 30-60% off for OTM strikes.
    try {
      if (typeof window.intradayOnStrikeChange === 'function') {
        window.intradayOnStrikeChange(state.selectedStrike);
      }
    } catch (_) {}
  }

  // Outside-click listener that's only attached while the picker is open.
  // Lifecycle: openStrikes attaches it (after a 0-tick defer so the very
  // click that opened the picker doesn't immediately close it again);
  // closeStrikes detaches it. This avoids races with the bubble path of
  // the opening click and keeps `document` clean when the picker is idle.
  var _outsideHandler = null;

  function openStrikes() {
    var pick = $('pt-strike-picker');
    var pop = $('pt-strike-pop');
    var search = $('pt-strike-search');
    if (!pick || !pop) return;
    pop.hidden = false;
    pick.classList.add('open');
    state.strikeFilter = '';
    if (search) { search.value = ''; setTimeout(function () { search.focus(); }, 30); }
    renderStrikeList();

    // Defer-then-attach: lets the current click event fully drain before
    // we start listening, so the opening click can't satisfy the
    // "outside" check on its own bubble.
    if (_outsideHandler) {
      document.removeEventListener('pointerdown', _outsideHandler, true);
      document.removeEventListener('mousedown', _outsideHandler, true);
    }
    _outsideHandler = function (ev) {
      var pickEl = $('pt-strike-picker');
      if (!pickEl) return;
      if (!pickEl.contains(ev.target)) closeStrikes();
    };
    setTimeout(function () {
      document.addEventListener('pointerdown', _outsideHandler, true);
      // mousedown is a fallback for any environment that doesn't fire
      // pointer events (e.g. very old WebViews, some testing tools).
      document.addEventListener('mousedown', _outsideHandler, true);
    }, 0);
  }

  function closeStrikes() {
    var pick = $('pt-strike-picker');
    var pop = $('pt-strike-pop');
    if (!pick || !pop) return;
    pop.hidden = true;
    pick.classList.remove('open');
    if (_outsideHandler) {
      document.removeEventListener('pointerdown', _outsideHandler, true);
      document.removeEventListener('mousedown', _outsideHandler, true);
      _outsideHandler = null;
    }
  }

  function toggleStrikes(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    var pop = $('pt-strike-pop');
    if (!pop) return;
    if (pop.hidden) openStrikes(); else closeStrikes();
  }
  function strikeSearch(q) {
    state.strikeFilter = q || '';
    renderStrikeList();
  }

  // ─── Live freshness indicator ───────────────────────────────────
  // Tracks when the option chain was last fetched and shows a relative
  // "just now / 12s ago / 1m ago" label so users know data is fresh.
  var lastChainFetch = 0;
  var liveAgoTimer = null;

  function updateLastFetch(ts) {
    lastChainFetch = ts || Date.now();
    refreshLiveAgoLabel();
    if (!liveAgoTimer) {
      liveAgoTimer = setInterval(refreshLiveAgoLabel, 1000);
    }
  }

  function refreshLiveAgoLabel() {
    var tag = $('pt-live-tag');
    var ago = $('pt-live-ago');
    if (!tag || !ago) return;
    if (!lastChainFetch) {
      tag.hidden = true;
      return;
    }
    tag.hidden = false;
    var marketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
    // Market closed → premiums are last-traded values, not live ticks.
    // Show "CLOSED · last close" instead of misleading "LIVE Ns ago".
    if (!marketOpen) {
      tag.classList.remove('stale');
      tag.classList.add('closed');
      ago.textContent = 'last close';
      return;
    }
    tag.classList.remove('closed');
    var secs = Math.max(0, Math.round((Date.now() - lastChainFetch) / 1000));
    var label;
    if (secs < 5) label = 'just now';
    else if (secs < 60) label = secs + 's ago';
    else if (secs < 3600) label = Math.floor(secs / 60) + 'm ago';
    else label = Math.floor(secs / 3600) + 'h ago';
    ago.textContent = label;
    // Mark stale if data is older than 90 seconds (auto-refresh runs every 30s,
    // so > 90s means refresh has been failing — token expired, network down).
    tag.classList.toggle('stale', secs > 90);
  }

  // Called from liveChainModule after the option chain is fetched
  function onChainLoaded() {
    var chain = window.optionChainData;
    if (!chain || !chain.strikes || !chain.strikes.length) return;

    // Sort + de-duplicate just in case
    chain.strikes.sort(function (a, b) { return a.strike_price - b.strike_price; });

    // Default to ATM if no strike is currently selected (or if previous selection isn't in this chain)
    var validStrikes = chain.strikes.map(function (s) { return s.strike_price; });
    if (state.selectedStrike == null || validStrikes.indexOf(state.selectedStrike) === -1) {
      state.selectedStrike = atmStrike(chain);
    }

    // Update Expiry stat-cell
    var info = $('pt-expiry');
    if (info) {
      var dt = '';
      try { dt = new Date(chain.expiry).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' }); }
      catch (e) { dt = chain.expiry; }
      info.textContent = dt;
    }

    applySelectedStrike();
    renderStrikeList();
    // Chain just landed (with a strike auto-selected to ATM) → start the
    // 1s poller so the Premium cards start ticking right away.
    startOptionPolling();
    pollOptionPrices();
  }

  // Poll latest premiums for all open OPT positions in one batch call.
  //
  // Hardened against the "LTP suddenly stops updating" symptom:
  //  (a) AbortController with a 3s timeout so a hung TCP connection
  //      (mobile network roam, server slow path, etc.) is killed
  //      instead of letting the request linger for 30-60s while the
  //      1s interval keeps stacking new pending fetches behind it.
  //  (b) state.lastPollSuccessTs is touched on every success — the
  //      watchdog in startOptionPolling() reads this and restarts
  //      the timer if too much time has passed without progress.
  //  (c) state.pollInFlight reentry guard — if the previous poll is
  //      still in-flight when the next 1s tick fires, we skip this
  //      tick instead of piling up parallel requests. Cleared in
  //      the finally so a thrown abort can't leave it pinned true.
  async function pollOptionPrices() {
    if (state.pollInFlight) return;
    // Market-hours + has-anything-to-poll gate (May 2026 fix). Without
    // this guard the 2s setInterval below would still spam Upstox
    // every weekend / overnight because the intraday analyzer caches
    // its last BUY_CE/BUY_PE verdict (from Friday's close) and the
    // `intradayGetAtmInstrumentKeys()` source kept returning the CE+PE
    // keys for the cached ATM strike — so this poller had work to do
    // even at 01:00 IST on a Sunday. ~900 wasted calls per 30-min
    // window against Upstox's 2000-call budget, raising real risk of
    // tripping the 429 gate the moment the market opens Monday.
    // `shouldPollOptions()` already implements the correct gate (see
    // line ~8210); the watchdog has always used it but the main entry
    // path was missing the check. Re-using the same helper keeps
    // behaviour consistent — when market opens at 09:15 IST the next
    // 2s tick (or rAF heartbeat) automatically resumes polling.
    if (!shouldPollOptions()) return;
    // Rate-limit gate — shared with chart pollTick. If Upstox recently
    // returned HTTP 429, both pollers sit out the cooldown so we don't
    // dig the hole deeper with retry storms.
    if (typeof window._upstoxIsThrottled === 'function' && window._upstoxIsThrottled()) return;
    var token = (localStorage.getItem('upstox_token') || '').trim();
    if (!token) return;

    // Build the set of instrument keys to fetch in this poll:
    //   1. All open OPT positions   → needed for LTP column / SL-TGT triggers
    //   2. The currently-selected strike's CE & PE legs
    //      → needed for the CE Premium / PE Premium dashboard cards.
    //        Without (2), those cards only refresh every 30s with the
    //        heavy option-chain payload — which is why they appeared frozen.
    //   3. All pending LIMIT/STOP orders' instruments → so the live LTP
    //      column in the Pending Orders table ticks, AND so the trigger
    //      check has fresh prices to compare against. Without (3) a
    //      pending order on a strike the user isn't currently viewing
    //      would never fire because we'd have no live data for it.
    var keys = [];
    var optPositions = state.open.filter(function (p) { return p.kind === 'OPT'; });
    optPositions.forEach(function (p) { if (p.instrumentKey) keys.push(p.instrumentKey); });
    state.pending.forEach(function (p) { if (p.instrumentKey) keys.push(p.instrumentKey); });

    var chain = window.optionChainData;
    if (chain && state.selectedStrike != null) {
      var rowSel = chain.strikes.filter(function (s) { return s.strike_price === state.selectedStrike; })[0];
      if (rowSel) {
        if (rowSel.call_options && rowSel.call_options.instrument_key) keys.push(rowSel.call_options.instrument_key);
        if (rowSel.put_options && rowSel.put_options.instrument_key) keys.push(rowSel.put_options.instrument_key);
      }
    }

    // Intraday analyzer's recommended ATM strike — include its CE+PE
    // legs so the live plan-card pricing (entry/SL/TGT cells) refreshes
    // every 2s like everything else, not every 30s when the option
    // chain auto-refreshes. Without this, the user sees a stale entry
    // price for up to 30s — long enough for the premium to swing 10%
    // on a fast-moving Nifty bar.
    if (typeof window.intradayGetAtmInstrumentKeys === 'function') {
      try {
        var iaKeys = window.intradayGetAtmInstrumentKeys();
        for (var iak = 0; iak < iaKeys.length; iak++) keys.push(iaKeys[iak]);
      } catch (_) { /* non-fatal */ }
    }

    // Live Option Chain table — only poll its keys when the user is
    // actively looking at it (Live section visible AND tab in foreground).
    // Skipping in background avoids burning ~60 keys/sec on a hidden tab.
    if (state.chainTableLtpKeys && state.chainTableLtpKeys.length) {
      var liveSec = document.getElementById('live');
      var sectionActive = liveSec && liveSec.classList.contains('active');
      if (sectionActive && !document.hidden) {
        for (var ci = 0; ci < state.chainTableLtpKeys.length; ci++) {
          keys.push(state.chainTableLtpKeys[ci]);
        }
      }
    }

    // Dedupe (the user might be holding the same strike they've now picked,
    // and the same strike will likely also be in the chain-table key list)
    keys = keys.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!keys.length) return;
    // Global budget gate — skip this tick if budget exhausted (retries in 2s)
    if (window._upstoxBucket && !window._upstoxBucket.tryAcquire()) return;
    state.pollInFlight = true;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () {
      try { ctrl.abort(); } catch (_) {}
      console.warn('[paper-trade] option LTP poll timed out (3s) — aborting and waiting for next tick');
    }, 3000) : null;
    try {
      var url = BASE + '/market-quote/ltp?instrument_key=' + keys.map(encodeURIComponent).join(',');
      var r = await fetch(url, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
        signal: ctrl ? ctrl.signal : undefined
      });
      if (r.status === 429) {
        // Upstox 30-min budget tripped. Trip the shared gate so the
        // chart poll backs off too; consecutive 429s extend the
        // cooldown exponentially (5s → 90s) per _upstoxNote429.
        if (window._upstoxNote429) window._upstoxNote429('option-poll');
        // Stamp lastPollSuccessTs to "now" so the watchdog doesn't
        // immediately tear down + restart the timer (which would just
        // queue another doomed call the moment the cooldown expires).
        state.lastPollSuccessTs = Date.now();
        return;
      }
      if (!r.ok) {
        console.warn('[paper-trade] option LTP poll failed', r.status, await r.text().catch(function () { return ''; }));
        return;
      }
      var d = await r.json();
      if (!d || !d.data) {
        console.warn('[paper-trade] option LTP poll returned empty data');
        return;
      }
      // Successful round-trip — clear the rate-limit gate's success
      // counter so back-off resets after 2 in a row.
      if (window._upstoxNoteOk) window._upstoxNoteOk();
      // d.data is keyed by symbol like "NSE_FO:NIFTY26MAY24150CE" → { last_price, instrument_token, ... }
      var matchedCount = 0;
      var unmatched = [];
      Object.values(d.data).forEach(function (rec) {
        if (!rec) return;
        var px = +rec.last_price;
        if (!isFinite(px) || px <= 0) return;
        var matchedKey = rec.instrument_key || null;
        if (!matchedKey) {
          var tk = String(rec.instrument_token || '');
          for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(tk) >= 0) { matchedKey = keys[i]; break; }
          }
        }
        if (matchedKey) {
          state.optPrices[matchedKey] = px;
          state.open.forEach(function (p) { if (p.instrumentKey === matchedKey) p.lastPx = px; });
          matchedCount++;
        } else {
          unmatched.push(rec);
        }
      });
      // One-time-per-poll diagnostic: if we got data but couldn't
      // match it back to our position keys, the response shape is
      // different than expected. This is the silent killer for
      // FLAT trades — log it loudly so we can fix the matcher.
      if (matchedCount === 0) {
        console.warn('[paper-trade] poll: 0 of ' + keys.length + ' positions matched. keys=', keys, ' raw response=', d.data, ' unmatched recs=', unmatched);
      } else if (state.lastMatchedCount !== matchedCount) {
        console.log('[paper-trade] poll: matched ' + matchedCount + '/' + keys.length + ' positions');
        state.lastMatchedCount = matchedCount;
      }
      save();
      updateOpenRows();
      updatePendingRows();
      renderEquity();
      checkRiskTriggers();
      checkPendingTriggers();
      // Keep the order-ticket "fires when … from current ₹X" hint in
      // lock-step with the live LTP card above it (would otherwise lag
      // by up to 30s — confusing the user about how close their
      // trigger is to firing).
      refreshOrderHintsLive();
      // Mirror fresh CE/PE LTPs into the chain cache + Premium cards so the
      // dashboard ticks at 1s instead of waiting for the next 30s chain
      // refresh. Cheap — no-op if no strike selected or no values changed.
      syncSelectedStrikePremiumDisplay();
      // Push fresh LTPs into the visible Live Option Chain table cells
      // (no-op if the table isn't on screen — the function bails fast).
      if (typeof updateChainTableLtps === 'function') {
        try { updateChainTableLtps(); } catch (_) {}
      }
      // Watchdog heartbeat — successful round-trip happened. Any value
      // here that's < (now - WATCHDOG_STALL_MS) tells startOptionPolling
      // the timer's gone silent and needs reviving.
      state.lastPollSuccessTs = Date.now();
    } catch (e) {
      // AbortError is expected when our 3s timeout above fires — don't
      // pollute the console with it, the timeout already logged a warn.
      if (e && e.name === 'AbortError') {
        // intentionally silent
      } else {
        console.warn('[paper-trade] option LTP poll threw', e && e.message);
      }
    } finally {
      if (timer) clearTimeout(timer);
      state.pollInFlight = false;
    }
  }

  // Push freshly-fetched LTPs (already living in state.optPrices) into the
  // selected strike's chain row so applySelectedStrike() displays them.
  // Doing it this way also keeps the chain cache fresh between 30s
  // auto-refreshes — beneficial for the chain-cache fallback path in BUY.
  function syncSelectedStrikePremiumDisplay() {
    var chain = window.optionChainData;
    if (!chain || state.selectedStrike == null) return;
    var row = chain.strikes.filter(function (s) { return s.strike_price === state.selectedStrike; })[0];
    if (!row) return;
    var changed = false;
    if (row.call_options && row.call_options.instrument_key && row.call_options.market_data) {
      var newCe = state.optPrices[row.call_options.instrument_key];
      if (isFinite(newCe) && newCe > 0 && newCe !== row.call_options.market_data.ltp) {
        row.call_options.market_data.ltp = newCe;
        changed = true;
      }
    }
    if (row.put_options && row.put_options.instrument_key && row.put_options.market_data) {
      var newPe = state.optPrices[row.put_options.instrument_key];
      if (isFinite(newPe) && newPe > 0 && newPe !== row.put_options.market_data.ltp) {
        row.put_options.market_data.ltp = newPe;
        changed = true;
      }
    }
    if (changed) applySelectedStrike();
  }

  // One-shot fresh LTP fetch for a single position. Used by manual EXIT
  // so the exit price reflects the very latest tick, even if the regular
  // 1s poll cache is a moment stale. Returns null on failure; caller
  // should fall back to the cached price. Logs every step verbosely so
  // FLAT trades can be diagnosed by inspecting the console.
  // One-shot fresh LTP fetch for a single instrument. Used by both BUY
  // (so entry price reflects the moment of click, not the up-to-5s-stale
  // option-chain cache) and manual EXIT (so exit price reflects the
  // moment of click, not the up-to-1s-stale poll cache).
  // `caller` is just a log prefix — pass 'BUY' or 'EXIT' for clarity.
  async function fetchFreshOptionPrice(instrumentKey, caller) {
    if (ptIsApiPaused()) return null;
    var tag = '[paper-trade] ' + (caller || 'FRESH') + ':';
    if (!instrumentKey) {
      console.warn(tag, 'no instrumentKey — skipping fresh fetch');
      return null;
    }
    var token = (localStorage.getItem('upstox_token') || '').trim();
    if (!token) {
      console.warn(tag, 'no token — skipping fresh fetch');
      return null;
    }
    var url = BASE + '/market-quote/ltp?instrument_key=' + encodeURIComponent(instrumentKey);
    console.log(tag, 'fetching fresh LTP', { instrumentKey: instrumentKey, url: url });
    try {
      var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
      if (!r.ok) {
        var body = await r.text().catch(function () { return ''; });
        console.warn(tag, 'fresh LTP HTTP', r.status, body.slice(0, 300));
        return null;
      }
      var d = await r.json();
      console.log(tag, 'fresh LTP raw response', d);
      if (!d || !d.data) {
        console.warn(tag, 'fresh LTP returned no .data');
        return null;
      }
      var rec = Object.values(d.data)[0];
      if (!rec) {
        console.warn(tag, 'fresh LTP .data was empty object');
        return null;
      }
      var px = +rec.last_price;
      if (!isFinite(px) || px <= 0) {
        console.warn(tag, 'fresh LTP last_price invalid', rec.last_price);
        return null;
      }
      var cached = state.optPrices[instrumentKey];
      console.log(tag, 'fresh price', px, 'cached was', cached);
      state.optPrices[instrumentKey] = px;
      state.open.forEach(function (p) { if (p.instrumentKey === instrumentKey) p.lastPx = px; });
      return px;
    } catch (e) {
      console.warn(tag, 'fresh LTP threw', e && e.message);
      return null;
    }
  }

  function startOptionPolling() {
    stopOptionPolling();
    // Poll at 1s to stay in lock-step with the spot chart polling.
    //   - Existing reason: EXIT reads from this cache, so a faster
    //     cadence means a more accurate exit price for short-held trades.
    //   - New reason: the selected strike's CE & PE legs are ALSO included
    //     in each poll batch, so the CE Premium / PE Premium dashboard
    //     cards update every 1s instead of every 30s.
    // 2 s baseline (was 1 s). Each tick is one batched call carrying
    // ALL needed keys (open positions + selected strike + chain table),
    // so total req rate is bounded by this interval. 2 s ⇒ ~1 800 calls
    // per 30-min, well under Upstox's 2 000-call ceiling; combined with
    // the shared 429 back-off gate, sustained polling no longer drifts
    // into rate-limit territory.
    console.log('[paper-trade] startOptionPolling — 2s cadence');
    state.lastPollSuccessTs = Date.now();
    state.pollInFlight = false;
    state.optPollTimer = setInterval(pollOptionPrices, 2000);
    // Watchdog: every 5s, if the last successful poll was more than
    // WATCHDOG_STALL_MS ago, tear down the timer and re-create it.
    // Catches the "interval silently died" class of bug (background
    // tab throttling that doesn't recover, an unhandled rejection that
    // somehow stopped the loop, etc.) and the "fetch is succeeding
    // every time but we're not updating state" class of bug (no-op
    // network response). Cheap — 1 timer + 1 timestamp compare every
    // 5s, no allocation on the steady-state happy path.
    state.optPollWatchdog = setInterval(function () {
      if (!shouldPollOptions()) return; // nothing to poll = nothing to watchdog
      // Rate-limit gate respected. If Upstox is throttling us, the
      // freeze is intentional — restarting the timer just queues
      // another doomed fetch the instant the cooldown expires.
      if (typeof window._upstoxIsThrottled === 'function' && window._upstoxIsThrottled()) return;
      var since = Date.now() - (state.lastPollSuccessTs || 0);
      if (since > WATCHDOG_STALL_MS) {
        console.warn('[paper-trade] watchdog: no successful poll in ' + since + 'ms — restarting timer');
        // Restart through the full path so AbortControllers / in-flight
        // guards reset cleanly. The recursive call is bounded (the
        // watchdog only fires every 5s) so there's no infinite loop risk.
        startOptionPolling();
        pollOptionPrices();
      }
    }, 5000);
    // rAF-based heartbeat: the setInterval watchdog above is great EXCEPT
    // when the browser idle-throttles all timers (Chrome's "Intensive
    // Wake-up Throttling" kicks in after ~5 min of no user input even on
    // foreground tabs, slowing setInterval down to 1/min or worse — both
    // poller AND watchdog throttle together so the watchdog can't rescue
    // itself). requestAnimationFrame is NOT subject to the same throttling
    // for visible-and-painting tabs, and our pulsing LIVE dot guarantees
    // continuous paint. We piggy-back on it: every frame (~60Hz) check if
    // a poll is overdue and fire one. Internal 1Hz throttle keeps cost
    // negligible (a single Date.now() compare per frame).
    startRafHeartbeat();
  }
  function stopOptionPolling() {
    if (state.optPollTimer) { clearInterval(state.optPollTimer); state.optPollTimer = null; }
    if (state.optPollWatchdog) { clearInterval(state.optPollWatchdog); state.optPollWatchdog = null; }
    state.pollInFlight = false;
    stopRafHeartbeat();
  }

  // ---- rAF heartbeat (idle-throttle-proof poll driver) ----
  // Why we need this in addition to the setInterval watchdog above:
  // modern browsers (Chrome 87+, Safari, Firefox) throttle setInterval
  // for tabs that haven't seen user input for ~5 min, even when the tab
  // is foreground and visible. The throttle slows BOTH the poller and
  // the watchdog by the same factor, so the watchdog can't restart the
  // poller — it's also throttled. requestAnimationFrame, however, runs
  // at vsync (~60Hz) for any tab that's painting, and our pulsing LIVE
  // dot CSS animation guarantees continuous paint. So rAF fires reliably
  // even when setInterval has been throttled to 1/min.
  function rafHeartbeat() {
    // 1Hz internal throttle — we don't need to do anything 60 times a
    // second, just enough to keep the LTP fresh and the LIVE label moving.
    var now = Date.now();
    if (now - (state._lastHeartbeatTickTs || 0) >= 950) {
      state._lastHeartbeatTickTs = now;
      // Rate-limit gate honored — during a cooldown we DO NOT pump
      // additional rescue polls into Upstox, because doing so just
      // extends the cooldown when the next 429 lands.
      var throttled = typeof window._upstoxIsThrottled === 'function' && window._upstoxIsThrottled();
      // Fire a poll if we have positions/strike to poll AND the regular
      // setInterval poller has gone quiet (>4s since last success — was
      // 2s, bumped to match the new 2s baseline so a single dropped
      // tick doesn't immediately trigger a rescue fetch).
      if (!throttled && shouldPollOptions() && now - (state.lastPollSuccessTs || 0) > 4000) {
        pollOptionPrices();
      }
      // Same idea for the chart's live-candle poll: if pollTick hasn't
      // run in >4s (typically because the browser throttled setInterval
      // after a long idle period), poke it directly. pollTick self-guards
      // when there's no chart loaded or market is closed, so this is a
      // safe no-op when there's nothing to do. pollTick lives in a
      // different scope; window._lastPollTickTs is the cross-scope bridge.
      if (!throttled && typeof window.pollTick === 'function' &&
          now - (window._lastPollTickTs || 0) > 4000) {
        try { window.pollTick(); } catch (_) {}
      }
      // Keep the "LIVE Xs ago" label honest even when setInterval is
      // throttled — same throttling logic applies to the label's own
      // 1s interval in startChainLiveTicker.
      if (typeof updateChainLiveLabel === 'function') {
        try { updateChainLiveLabel(); } catch (_) {}
      }
    }
    state._rafHeartbeatId = requestAnimationFrame(rafHeartbeat);
  }
  function startRafHeartbeat() {
    if (state._rafHeartbeatId) return; // already running — idempotent
    state._lastHeartbeatTickTs = 0;
    state._rafHeartbeatId = requestAnimationFrame(rafHeartbeat);
  }
  function stopRafHeartbeat() {
    if (state._rafHeartbeatId) {
      cancelAnimationFrame(state._rafHeartbeatId);
      state._rafHeartbeatId = null;
    }
  }

  // True if we have anything worth polling: either an open OPT position
  // (needs LTP for P&L / SL-TGT triggers) or a strike selected with the
  // chain loaded (needs CE/PE for the dashboard Premium cards).
  //
  // Market-hours gate: once 15:30 IST passes, premiums no longer move
  // (LTP stays frozen at the last traded price), so polling the API is
  // pure waste — wakes the network, burns request quota, and lights up
  // the "PRICES LIVE" UX even though nothing is live. The EOD square-off
  // timer is independent and uses the cached lastPx → entry fallback,
  // so after-hours positions still get auto-closed correctly.
  function shouldPollOptions() {
    if (ptIsApiPaused()) return false;
    var marketOpen = (typeof window.isMarketOpen === 'function') ? window.isMarketOpen() : true;
    if (!marketOpen) return false;
    if (state.open.some(function (p) { return p.kind === 'OPT'; })) return true;
    // Pending LIMIT/STOP orders need live ticks too — otherwise their
    // trigger checks (checkPendingTriggers) starve and the order
    // never fills even when the market reaches the trigger price.
    if (state.pending.some(function (p) { return p.kind === 'OPT'; })) return true;
    if (window.optionChainData && state.selectedStrike != null) return true;
    // Intraday analyzer has an active BUY recommendation — keep polling
    // so its plan-card entry/SL/target cells re-price live (otherwise
    // the displayed levels go stale the moment the user stops touching
    // a strike, even though the recommendation is "BUY now").
    if (typeof window.intradayGetAtmInstrumentKeys === 'function') {
      try {
        var iaKeys = window.intradayGetAtmInstrumentKeys();
        if (iaKeys && iaKeys.length) return true;
      } catch (_) { /* non-fatal */ }
    }
    return false;
  }

  // Update each open card's LTP / pts / P&L cells in place (no redraw flicker).
  // Also refreshes the P&L hero-strip tint (.pt-pos-pnl-strip pos|neg) so
  // the card background reflects the current sign without a full rebuild.
  function updateOpenRows() {
    state.open.forEach(function (p) {
      var row = document.querySelector('[data-pos-id="' + p.id + '"]');
      if (!row) return;
      var px = priceFor(p);
      if (!px) return;
      var calc = pnlOf(p, px);
      var color = calc.inr >= 0 ? 'var(--bull)' : 'var(--bear)';
      var ltpC = row.querySelector('.pt-c-ltp');
      var ptsC = row.querySelector('.pt-c-pts');
      var pnlC = row.querySelector('.pt-c-pnl');
      if (ltpC) ltpC.textContent = px.toFixed(2);
      if (ptsC) { ptsC.textContent = fmtPts(calc.pts); ptsC.style.color = color; }
      if (pnlC) { pnlC.textContent = fmtINR(calc.inr); pnlC.style.color = color; }
    });
  }

  function renderAll() {
    var qiCE = $('pt-qty-ce');
    var qiPE = $('pt-qty-pe');
    if (qiCE && +qiCE.value !== state.qtyCE) qiCE.value = state.qtyCE;
    if (qiPE && +qiPE.value !== state.qtyPE) qiPE.value = state.qtyPE;
    renderPending();
    renderOpen();
    renderHistory();
    renderStats();
    renderEquity();
    renderTodayPnL();
    renderSpot();
    setBtnState();
    // Kick off (or stop) the 1s LTP poller. Polls when we have OPEN OPT
    // positions OR when a strike is selected (so CE/PE Premium cards tick).
    if (shouldPollOptions()) {
      startOptionPolling();
      pollOptionPrices();
    } else {
      stopOptionPolling();
    }
    // EOD square-off timer always runs (cheap — 30s interval, no-ops when no positions)
    startEodTimer();
  }

  // Called from liveChartModule on each chart tick (Nifty spot LTP)
  function tick(ltp) {
    if (!isFinite(ltp) || ltp <= 0) return;
    state.lastLTP = ltp;
    setBtnState();
    updateOpenRows();
    renderEquity();
    renderSpot();
    // SPOT-based auto-exit check (May 2026 spot-first refactor).
    // Fires AT MOST ~1×/s (the spot poll rate). Wrapped in try
    // so a logic bug here can't disable downstream consumers.
    try { checkSpotRiskTriggers(ltp); } catch (e) {
      console.error('[paper-trade] checkSpotRiskTriggers threw:', e && e.message);
    }
    // Push spot to the intraday analyzer so it can re-price the plan
    // card (entry/SL/target) from the CURRENT premium AND run the
    // spot-invalidation safety check (big red banner if Nifty crosses
    // the trip-line). The intraday module reads option premium from
    // window.optionChainData internally — no extra fetch here.
    if (typeof window.intradayLiveTick === 'function') {
      try { window.intradayLiveTick(ltp); } catch (_) {}
    }
  }

  // Convenience: trigger the option-chain fetch from inside paper-trade panel
  function loadStrikes() {
    if (typeof window.upFetchChain !== 'function') {
      alert('Option chain module not ready. Reload the page.');
      return;
    }
    var btn = $('pt-load-strikes-btn');
    if (btn) {
      var orig = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '&#8635; REFRESHING...';
      var done = false;
      var prev = window.ptOnChainLoaded;
      window.ptOnChainLoaded = function () {
        done = true;
        if (typeof prev === 'function') prev();
        btn.disabled = false;
        btn.innerHTML = '&#8635; REFRESH';
      };
      setTimeout(function () {
        if (!done) { btn.disabled = false; btn.innerHTML = orig; }
      }, 8000);
    }
    window.upFetchChain();
  }

  // Global Esc-to-close. Outside-click is now handled inside openStrikes /
  // closeStrikes via a per-instance listener (see `_outsideHandler` above)
  // because the global pattern was racy with the opening click's bubble.
  function bindGlobalPickerHandlers() {
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        var pop = $('pt-strike-pop');
        if (pop && !pop.hidden) closeStrikes();
      }
    });
    // Tab-visibility recovery: when the user comes back to a backgrounded
    // tab, Chrome / Firefox / Safari throttle setInterval to 1/min (or
    // even pause it), so the LTP poll may have effectively died while
    // the tab was hidden. Force an immediate refresh on visibility-back
    // so the UI is fresh within ~200ms of the user returning instead of
    // waiting for the next interval tick + Upstox round-trip. Same
    // logic for full window focus as a belt-and-brace.
    function kickPollIfStale() {
      if (document.visibilityState !== 'visible') return;
      if (!shouldPollOptions()) return;
      // Don't add to Upstox's pain during a rate-limit cooldown — the
      // 2 s setInterval will resume on its own once the gate clears,
      // and the next successful poll will paint fresh LTPs anyway.
      if (typeof window._upstoxIsThrottled === 'function' && window._upstoxIsThrottled()) return;
      // If we have an active timer it'll keep ticking — just fire an
      // immediate poll on top. If the timer's gone (rare — only if
      // shouldPollOptions flipped back to true), restart it cleanly.
      if (!state.optPollTimer) startOptionPolling();
      pollOptionPrices();
    }
    document.addEventListener('visibilitychange', kickPollIfStale);
    window.addEventListener('focus', kickPollIfStale);

    // User-activity recovery: when setInterval is idle-throttled by
    // the browser, ANY user interaction event fires immediately and
    // is not throttled. Hooking these gives us an instant unstuck the
    // moment the user wiggles the mouse, clicks anything, presses a
    // key, scrolls, or touches the screen. Rate-limited to 2Hz so
    // we don't fire a poll on every pixel of mousemove.
    var _lastActivityKickTs = 0;
    function onUserActivity() {
      var now = Date.now();
      if (now - _lastActivityKickTs < 500) return; // 2Hz cap
      _lastActivityKickTs = now;
      // Only do work if we're actually overdue — sidesteps fetch spam
      // when the user is actively interacting and polls are flowing.
      // 3 s is the new threshold (was 1.5 s) to align with the 2 s
      // baseline cadence; otherwise EVERY mouse move would queue a
      // duplicate poll on top of the regular interval.
      if (now - (state.lastPollSuccessTs || 0) > 3000) {
        kickPollIfStale();
      }
    }
    ['mousemove', 'pointermove', 'click', 'keydown', 'scroll', 'touchstart', 'touchmove']
      .forEach(function (evt) {
        document.addEventListener(evt, onUserActivity, { passive: true, capture: true });
      });
  }

  // Expose API
  window.ptBuy = function () { place('LONG'); };
  window.ptSell = function () { place('SHORT'); };
  window.ptBuyCE = function () { placeOpt('CE'); };
  window.ptBuyPE = function () { placeOpt('PE'); };
  window.ptExit = function (id) { exit(id, 'MANUAL'); };
  window.ptExitAll = exitAll;
  window.ptReset = reset;
  window.ptClearHistory = clearHistory;
  // Shared in-app confirm modal (replaces window.confirm). Exposed
  // so other modules (live chart, option chain, etc.) can reuse it.
  window.confirmModal = confirmModal;
  window.ptIncQty = incQty;
  window.ptSetQty = setQty;
  // Order-ticket form handlers (LIMIT / STOP)
  window.ptSetOrderType = setOrderType;
  window.ptSetTriggerPrice = setTriggerPrice;
  window.ptSetAttachedRisk = setAttachedRisk;
  window.ptCancelPending = cancelPending;
  window.ptCancelAllPending = function () { cancelAllPending(false); };
  window.ptLoadStrikes = loadStrikes;
  window.ptOnChainLoaded = onChainLoaded;
  window.ptToggleStrikes = toggleStrikes;
  window.ptStrikeSearch = strikeSearch;
  window.ptUpdateLastFetch = updateLastFetch;
  window.ptUpdatePosRisk = updatePosRisk;
  // ── Spot-trigger prime (May 2026 spot-first refactor) ────────
  // paperBridgeModule calls this BEFORE invoking ptBuyCE / ptBuyPE
  // so the about-to-be-opened position carries the engine's
  // spot-based SL/T1/entry levels. The next placeOpt() reads the
  // prime, copies values onto the new open position, and clears
  // the prime so a subsequent manual BUY (without engine context)
  // doesn't inherit stale triggers.
  //
  // optType  - 'CE' | 'PE' (matches the BUY button about to be clicked)
  // slSpot   - Nifty spot level for auto-exit SL (null = no SL)
  // tgtSpot  - Nifty spot level for auto-exit T1   (null = no TGT)
  // entrySpot- Nifty spot at the moment the engine fired (chart anchor)
  window.ptPrimeSpotTriggers = function (optType, slSpot, tgtSpot, entrySpot) {
    if (!optType) return;
    if (slSpot    != null && isFinite(slSpot))    state.engineSlSpotPrime[optType]    = +slSpot;
    if (tgtSpot   != null && isFinite(tgtSpot))   state.engineTgtSpotPrime[optType]   = +tgtSpot;
    if (entrySpot != null && isFinite(entrySpot)) state.engineEntrySpotPrime[optType] = +entrySpot;
  };
  window.paperTradeTick = tick;
  // ── Bridge accessors for paperBridgeModule (P2-A, May 2026) ──
  // Two minimal exposures so the Quick-Trade strip can drive paper
  // execution from the HUD without scrolling. Both are pure pass-
  // throughs of existing internal functions — they neither mutate
  // module state nor change paperTradeModule's behaviour, just
  // surface the read/setter the bridge needs.
  //
  //   ptSelectStrike(k)   — same as a manual strike-picker click.
  //                         Sets state.selectedStrike, runs the
  //                         normal apply + poll + analyzer-notify
  //                         pipeline. Idempotent.
  //   ptGetPosition(id)   — read-only snapshot of an open OR
  //                         history position by id. Returned object
  //                         carries an extra `_where: 'open'
  //                         | 'history'` so the caller can tell at
  //                         a glance which list it came from. Used
  //                         by the bridge poller to detect when a
  //                         taken paper position has auto-exited
  //                         (SL/TGT/EOD) and write the outcome back
  //                         to the signal journal automatically.
  window.ptSelectStrike = selectStrike;
  window.ptGetPosition = function (id) {
    if (id == null) return null;
    var s = id + '';
    var p = state.open.filter(function (x) { return x.id === s; })[0];
    if (p) return Object.assign({}, p, { _where: 'open' });
    var h = state.history.filter(function (x) { return x.id === s; })[0];
    if (h) return Object.assign({}, h, { _where: 'history' });
    return null;
  };
  // Live Nifty 50 spot LTP — last value pushed via paperTradeTick.
  // Exposed so the intraday analyzer's renderAll can prefer the
  // authoritative LTP over result.tf5.lastClose (which can trail
  // by a tick — particularly when market is closed). Falls back
  // gracefully (returns null) if no tick has fired yet.
  window.paperTradeGetLastSpot = function () {
    var v = state.lastLTP;
    return (isFinite(v) && v > 0) ? v : null;
  };
  // Exposed so the lazy section loader can re-render once content/live.html
  // has been injected (the initial DOMContentLoaded renderAll silently
  // no-ops because the paper-trade DOM elements don't exist yet).
  window.ptRenderAll = renderAll;
  window.ptRenderPauseBanner = renderPtApiPauseBanner;
  // Exposed so the intraday analyzer can kick the option-LTP poller
  // the moment its verdict flips to BUY CE / BUY PE — otherwise the
  // poller might be idle (no open positions, no selected strike) and
  // the plan-card live pricing would stay null until the user picks
  // a strike manually.
  window.paperTradeKickOptionPolling = function () {
    if (shouldPollOptions()) {
      if (!state.optPollTimer) startOptionPolling();
      pollOptionPrices(); // immediate one-shot, don't wait 2s for the next tick
    }
  };
  // Live option-price getter — intraday analyzer reads this to get
  // a 2s-fresh premium for its recommended ATM strike (the option-
  // chain's market_data.ltp only refreshes every 30s, which is too
  // stale for live plan-card pricing).
  // Strike currently picked by the user in the dropdown (null if
  // they haven't picked anything yet → analyzer falls back to its
  // recommended ATM strike). Used by the intraday analyzer to
  // re-anchor SL/T1/T2/T3 to the strike the user is actually
  // planning to trade.
  window.paperTradeGetSelectedStrike = function () {
    return (state.selectedStrike != null) ? +state.selectedStrike : null;
  };
  window.paperTradeGetOptionPrice = function (instrumentKey) {
    if (!instrumentKey) return null;
    var px = state.optPrices[instrumentKey];
    return (isFinite(px) && px > 0) ? px : null;
  };

  // ── Options API pause banner renderer + toggle ──
  function renderPtApiPauseBanner() {
    var host = document.getElementById('pt-api-pause-banner');
    if (!host) return;
    var paused = ptIsApiPaused();
    host.dataset.state = paused ? 'paused' : 'active';
    var dotCls = paused ? 'pt-api-pause-dot-paused' : 'pt-api-pause-dot-active';
    var statusTxt = paused ? 'Upstox API: PAUSED' : 'Upstox API: ACTIVE';
    var hintTxt = paused
      ? 'ALL Upstox calls stopped — chart, option polling, chain refresh, intraday analyzer. Open positions render with last-known prices. EOD square-off still fires.'
      : 'Chart polling, option LTP, chain refresh, and intraday analyzer are all active. Pause to stop every Upstox API call instantly.';
    var btnTxt = paused ? 'Resume' : 'Pause';
    host.innerHTML = ''
      + '<div class="pt-api-pause-meta">'
      +   '<span class="pt-api-pause-dot ' + dotCls + '" aria-hidden="true"></span>'
      +   '<span class="pt-api-pause-status">' + statusTxt + '</span>'
      +   '<span class="pt-api-pause-hint">' + hintTxt + '</span>'
      + '</div>'
      + '<button type="button" class="pt-api-pause-btn"'
      +   ' onclick="ptToggleApiPause()"'
      +   ' aria-pressed="' + (paused ? 'true' : 'false') + '">'
      +   btnTxt
      + '</button>';
  }

  window.ptToggleApiPause = function () {
    var now = !ptIsApiPaused();
    ptSetApiPaused(now);
    renderPtApiPauseBanner();
    if (now) {
      stopOptionPolling();
      if (typeof window.tvState === 'object' && window.tvState) {
        try {
          var st = window.tvState;
          if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
        } catch (_) {}
      }
    } else {
      if (shouldPollOptions()) {
        startOptionPolling();
        pollOptionPrices();
      }
      if (typeof window.tvReload === 'function') {
        try { window.tvReload(); } catch (_) {}
      }
    }
    return now;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { load(); renderAll(); renderPtApiPauseBanner(); bindGlobalPickerHandlers(); });
  } else {
    load();
    renderAll();
    renderPtApiPauseBanner();
    bindGlobalPickerHandlers();
  }
})();
