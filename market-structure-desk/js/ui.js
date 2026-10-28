/* Structure Desk — UI wiring, timeline control, live polling and output panels. */
SD = window.SD;
SD.boot = (function () {
  'use strict';

  const U = SD.U;
  const $ = U.$, $$ = U.$$;

  const DEFAULTS = {
    pivotWidth: 3, closeWeight: 0.75, lookback: 4, atrPeriod: 14,
    rvolThreshold: 1.3, sustainBars: 2, breakMargin: 0.15, requireVolume: true,
    poll: 20, tick: 5,
    base: 'https://query1.finance.yahoo.com/v8/finance/chart/',
    proxy: '', chain: true, prePost: true,
    currency: 'native', home: 'US', wickPivots: true
  };

  const CUR_SYM = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥', CNY: '¥', HKD: 'HK$', SGD: 'S$', AUD: 'A$', NZD: 'NZ$', CAD: 'C$', MYR: 'RM', IDR: 'Rp', KRW: '₩', TRY: '₺', CHF: 'CHF', BRL: 'R$', NOK: 'kr', SEK: 'kr', DKK: 'kr', PLN: 'zł', ILS: '₪', PHP: '₱', VND: '₫', MXN: 'MX$' };

  /* The indices a class actually compares a scrip against, in the order the desk reads them: home
     market first, then the benches the tape is priced off. Every symbol here answered the quote
     endpoint on 2026-10-26, and a chip costs one relay per click — it loads a tape, it does not poll.
     The label is what fits on a chip; the tooltip carries the venue's own name and currency. */
  const MARKET_CHIPS = [
    { sym: '^NSEI', label: 'NIFTY' },
    { sym: '^BSESN', label: 'SENSEX' },
    { sym: '^NSEBANK', label: 'BANK NIFTY' },
    { sym: '^CNXIT', label: 'NIFTY IT' },
    { sym: '^MIDCPNIFTY', label: 'MIDCAP' },
    { sym: '^INDIAVIX', label: 'INDIA VIX' },
    { sym: '^GSPC', label: 'S&P 500' },
    { sym: '^IXIC', label: 'NASDAQ' },
    { sym: '^DJI', label: 'DOW' },
    { sym: '^N225', label: 'NIKKEI' },
    { sym: '^HSI', label: 'HANG SENG' },
    { sym: '^STI', label: 'STI' }
  ];

  const S = {
    cfg: Object.assign({}, DEFAULTS),
    symbol: 'AAPL',
    series: null,
    model: null,
    timeline: { kind: 'live', label: 'Live (auto)' },
    liveTimer: null,
    tickTimer: null,
    tickSpec: null,
    tickBusy: false,
    tickFail: 0,
    tickNext: 0,
    pollSpec: null,
    inFlight: false,
    pollBusy: false,
    gen: 0,
    seeded: false,
    knownSignals: {},
    mouseY: undefined,
    hoverI: -1,
    view: 'desk',
    resumeLive: false,
    studies: [],
    studySel: [],
    replay: null,
    alerts: [],
    chartOpts: { mode: 'candles', volume: true, structure: true, levels: true, trend: true, log: false, vwap: true, poc: true, events: true, fib: false }
  };

  /* ------------------------------------------------------------------ boot */
  function boot() {
    SD.Chart.init($('#chart'));
    loadCfg();
    loadChartView();
    loadAlerts();
    hydrateCfgForm();
    buildMarketStrip();
    bindControls();
    hydrateChartView();
    bindChart();
    bindSettings();
    bindViews();
    bindAlerts();
    renderStudyBar();
    paintAlerts();
    buildHelpNote();
    const remembered = U.store.get('symbol', null);
    S.symbol = remembered || 'AAPL';
    $('#symbolInput').value = S.symbol;
    if (remembered) loadCurrent({ first: true });
    else demoFallback('Loading a synthetic tape so the structure labeller is visible before the first quote.');
    const watchBridge = { cfg: () => S.cfg, chartOpts: () => S.chartOpts, studySel: () => S.studySel, fetchCfg: cfgForFetch, openSymbol };
    SD.Tickers.init();
    SD.Watch.init(watchBridge);
    SD.Scan.init(watchBridge);
    SD.Books.init(watchBridge);
    setView(U.store.get('view', 'desk'), { quiet: true });
    U.toast('Structure Desk ready. Pick a timeline, or leave it on Live.', '', 5200);
  }

  /* ------------------------------------------------------------------ views */
  function bindViews() {
    $$('#viewTabs .vt-btn').forEach(b => U.on(b, 'click', () => setView(b.dataset.view)));
  }

  const VIEWS = ['desk', 'watch', 'scan', 'books'];

  function setView(name, o) {
    o = o || {};
    const next = VIEWS.indexOf(name) >= 0 ? name : 'desk';
    if (!o.quiet && next === S.view) return;
    S.view = next;
    document.body.dataset.view = S.view;
    SD.Tickers.closeAll();                   // a fixed suggestion list must not float over the next tab
    $$('#viewTabs .vt-btn').forEach(b => {
      const on = b.dataset.view === S.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#deskView').hidden = S.view !== 'desk';
    $('#watchView').hidden = S.view !== 'watch';
    $('#scanView').hidden = S.view !== 'scan';
    $('#booksView').hidden = S.view !== 'books';
    U.store.set('view', S.view);

    // One poller at a time — the Desk loop and a stack of rows would compete for the same relays.
    if (S.view !== 'desk' && S.liveTimer) { clearLive(); S.resumeLive = true; }
    if (S.view === 'watch') SD.Watch.activate(); else SD.Watch.deactivate();
    if (S.view === 'scan') SD.Scan.activate();
    // Books speaks to the relays once per company, so the price loops stay asleep while it is open.
    if (S.view === 'books') SD.Books.activate(); else SD.Books.deactivate();
    if (S.view === 'desk') {
      // Resume whatever window was polling — Live or a fixed range that reaches the present.
      if (S.resumeLive && S.pollSpec) { S.resumeLive = false; startPolling(S.pollSpec); }
      if (S.model) draw();                       // the canvas measured nothing while it was hidden
    }
  }

  /* Load a name on the single-symbol Desk, from wherever it was clicked. */
  function openSymbol(raw) {
    const d = SD.Data.describeSymbol(raw);
    if (!d.symbol) return;
    S.symbol = d.symbol;
    $('#symbolInput').value = d.symbol;
    U.store.set('symbol', d.symbol);
    showHint(d);
    resetBaseline();
    setView('desk');
    loadCurrent({ first: true });
  }

  function loadCfg() {
    const saved = U.store.get('cfg', {});
    Object.keys(DEFAULTS).forEach(k => { if (saved[k] !== undefined) S.cfg[k] = saved[k]; });
  }
  function saveCfg() { U.store.set('cfg', S.cfg); }

  /* ------------------------------------------------------------------ market strip */
  function buildMarketStrip() {
    const host = $('#marketChips');
    host.innerHTML = '';
    MARKET_CHIPS.forEach(c => {
      const v = SD.Data.INDEX_VENUES[c.sym.slice(1)] || {};
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip ms-chip';
      b.dataset.sym = c.sym;
      b.textContent = c.label;
      b.title = (v.name || c.sym) + ' · ' + c.sym + (v.cur ? ' · ' + v.cur : '') + (v.tz ? ' · ' + v.tz : '') +
        ' — load the market chart';
      U.on(b, 'click', () => openSymbol(c.sym));
      host.appendChild(b);
    });
  }

  // Highlighted off the tape actually on screen, not off what the box says: a name typed without its
  // caret still lands on ^NSEI, and the chip should light when it does.
  function paintMarketStrip() {
    const on = (S.series && S.series.symbol) || S.symbol;
    $$('#marketChips .ms-chip').forEach(b => b.classList.toggle('is-on', b.dataset.sym === on));
  }

  /* ------------------------------------------------------------------ controls */
  function bindControls() {
    $('#symbolForm').addEventListener('submit', e => {
      e.preventDefault();
      openSymbol($('#symbolInput').value);
    });

    $('#symbolInput').addEventListener('input', () => {
      const raw = $('#symbolInput').value.trim();
      if (raw.length < 2) { $('#symbolHint').hidden = true; return; }
      const d = SD.Data.describeSymbol(raw);
      showHint(d);
    });

    // Suggestions come from the directory the desk keeps filling as it reads tapes, seeded by the
    // NSE listing file; Enter only picks a row when the list is up, otherwise it loads as typed.
    SD.Tickers.attach($('#symbolInput'), {
      cfg: cfgForFetch,
      onPick: it => { $('#symbolInput').value = it.symbol; openSymbol(it.symbol); }
    });

    $$('#timelineBar .chip[data-tl]').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#timelineBar .chip[data-tl]').forEach(b => b.classList.remove('is-on'));
        btn.classList.add('is-on');
        S.timeline = { kind: btn.dataset.tl, interval: btn.dataset.interval, range: btn.dataset.range, label: btn.textContent.trim() };
        clearLive();
        resetBaseline();
        loadCurrent();
      });
    });

    $('#liveGo').addEventListener('click', () => {
      $$('#timelineBar .chip[data-tl]').forEach(b => b.classList.remove('is-on'));
      $('#customFrom').value = ''; $('#customTo').value = '';
      S.timeline = { kind: 'live', label: 'Live (auto)' };
      resetBaseline();
      loadCurrent();
    });

    $('#customGo').addEventListener('click', () => {
      const f = $('#customFrom').value, t = $('#customTo').value;
      if (!f || !t) { U.toast('Pick both ends of the window.', 'warn'); return; }
      const from = Date.parse(f + 'T00:00:00'), to = Date.parse(t + 'T23:59:59');
      if (!(to > from)) { U.toast('End date must follow the start date.', 'err'); return; }
      $$('#timelineBar .chip[data-tl]').forEach(b => b.classList.remove('is-on'));
      S.timeline = {
        kind: 'custom', interval: $('#customInterval').value,
        period1: from, period2: to,
        label: U.isoDate(from) + ' → ' + U.isoDate(to) + ' · ' + $('#customInterval').value
      };
      clearLive();
      resetBaseline();
      loadCurrent();
    });

    U.on($('#chartType'), 'change', e => {
      S.chartOpts.mode = e.target.value;
      saveChartView();
      draw();
    });

    const toggles = { tglVolume: 'volume', tglStructure: 'structure', tglLevels: 'levels', tglTrend: 'trend', tglLog: 'log', tglFib: 'fib' };
    Object.keys(toggles).forEach(id => {
      U.on($('#' + id), 'change', e => { S.chartOpts[toggles[id]] = e.target.checked; saveChartView(); draw(); });
    });
    U.on($('#pngExport'), 'click', exportPng);
    U.on($('#replayToggle'), 'click', replayStart);
    U.on($('#replayPrev'), 'click', () => replayStep(-1));
    U.on($('#replayNext'), 'click', () => replayStep(1));
    U.on($('#replayExit'), 'click', replayStop);
    U.on($('#tglCloseWeight'), 'change', e => {
      S.cfg.closeWeight = e.target.checked ? U.store.get('closeWeightSlider', 0.75) : 0.5;
      saveCfg(); refresh();
    });

    U.on($('#settingsBtn'), 'click', () => { $('#settingsDrawer').hidden = false; });
    U.on($('#settingsClose'), 'click', closeDrawer);
    U.on($('#settingsDrawer'), 'click', e => { if (e.target.id === 'settingsDrawer') closeDrawer(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('#settingsDrawer').hidden = true; $('#symbolHint').hidden = true; }
      if (e.key === '/' && document.activeElement !== $('#symbolInput')) { e.preventDefault(); $('#symbolInput').focus(); $('#symbolInput').select(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { /* let reload happen */ }
    });

    $$('[data-export]').forEach(b => U.on(b, 'click', () => exportAs(b.dataset.export)));
    $$('[data-copy]').forEach(b => U.on(b, 'click', () => copyTable(b.dataset.copy)));

    U.on($('#csvApply'), 'click', () => {
      try {
        const bars = SD.Data.parseCsv($('#csvBox').value);
        useManual(bars, 'manual/paste');
      } catch (e) { U.toast('Could not parse: ' + e.message, 'err', 6000); }
    });
    U.on($('#csvFileBtn'), 'click', () => $('#csvFile').click());
    U.on($('#csvFile'), 'change', async e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const bars = SD.Data.parseCsv(await f.text());
        $('#csvBox').value = '';
        useManual(bars, f.name);
      } catch (err) { U.toast('CSV error: ' + err.message, 'err', 6000); }
    });
    U.on($('#csvSample'), 'click', () => demoFallback('Demo tape — deterministic, so the labels are reproducible.'));

    window.addEventListener('resize', () => { if (S.model) draw(); });
  }

  function closeDrawer() { $('#settingsDrawer').hidden = true; collectCfg(); saveCfg(); refresh(); }

  /* ------------------------------------------------------------------ chart view & studies */
  const VIEW_KEYS = ['mode', 'volume', 'structure', 'levels', 'trend', 'log', 'fib'];

  function loadChartView() {
    const v = U.store.get('chartView', null) || {};
    VIEW_KEYS.forEach(k => { if (v[k] !== undefined) S.chartOpts[k] = v[k]; });
    const saved = Array.isArray(v.studies) ? v.studies.filter(id => SD.Ind.byId(id)) : [];
    // A saved selection may predate the two-pane cap; keep the order and drop only what cannot draw.
    let panes = 0;
    S.studySel = saved.filter(id => SD.Ind.byId(id).kind !== 'pane' || ++panes <= SD.Chart.MAX_PANES);
  }
  function saveChartView() { U.store.set('chartView', Object.assign({}, S.chartOpts, { studies: S.studySel })); }

  function hydrateChartView() {
    $('#chartType').value = S.chartOpts.mode;
    const map = { tglVolume: 'volume', tglStructure: 'structure', tglLevels: 'levels', tglTrend: 'trend', tglLog: 'log', tglFib: 'fib' };
    Object.keys(map).forEach(id => { $('#' + id).checked = !!S.chartOpts[map[id]]; });
  }

  function renderStudyBar() {
    const host = $('#studyBar');
    if (!host) return;
    host.innerHTML = '<span class="sb-label">Studies</span>' + SD.Ind.LIBRARY.map(s => {
      const on = S.studySel.indexOf(s.id) >= 0;
      return '<button class="study-chip' + (on ? ' is-on' : '') + '" type="button" data-study="' + s.id +
        '" aria-pressed="' + on + '" title="' + (s.kind === 'pane' ? 'Own pane under the price' : 'Overlay on the price') + '">' +
        U.escapeHtml(s.label) + '</button>';
    }).join('') + '<button class="study-chip sb-clear" type="button" data-study="none" title="Hide every study">none</button>';
    $$('#studyBar .study-chip').forEach(b => U.on(b, 'click', () => toggleStudy(b.dataset.study)));
  }

  function toggleStudy(id) {
    if (id === 'none') { S.studySel = []; saveChartView(); renderStudyBar(); draw(); return; }
    const spec = SD.Ind.byId(id);
    if (!spec) return;
    const at = S.studySel.indexOf(id);
    if (at >= 0) S.studySel.splice(at, 1);
    else {
      const paneSel = S.studySel.filter(x => (SD.Ind.byId(x) || {}).kind === 'pane');
      if (spec.kind === 'pane' && paneSel.length >= SD.Chart.MAX_PANES) {
        U.toast('Two study panes is the cap on this canvas — switch one off first.', 'warn', 6000);
        return;
      }
      S.studySel.push(id);
    }
    saveChartView(); renderStudyBar(); draw();
  }

  /* ------------------------------------------------------------------ snapshot */
  function exportPng() {
    if (!S.series) return;
    const src = $('#chart');
    const out = document.createElement('canvas');
    out.width = src.width; out.height = src.height;
    const g = out.getContext('2d');
    // The canvas itself is transparent; a PNG dropped into a deck needs the panel behind it.
    g.fillStyle = getComputedStyle(document.body).backgroundColor || '#0a0d12';
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(src, 0, 0);
    out.toBlob(blob => {
      if (!blob) { U.toast('The browser could not encode this chart.', 'err'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (S.series.symbol || 'chart').replace(/[^\w.]/g, '-') + '_' + S.series.granularity + '_' + U.isoDate(Date.now()) + '.png';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 900);
      U.toast('Chart image downloaded.', 'ok');
    }, 'image/png');
  }

  /* ------------------------------------------------------------------ bar replay
     Replay truncates the tape and re-runs the engine on the truncated series, so the verdict, the
     swing labels and the tooltip are all computed from what was knowable at that bar — not a
     marker sliding over a finished chart. Polling stops for the duration. */
  function replayStart() {
    if (S.replay) return;
    if (!S.series || !S.model) { U.toast('Load a tape first.', 'warn'); return; }
    if (S.demo) { U.toast('Replay needs a real tape — the demo series is synthetic.', 'warn', 6000); return; }
    const n = S.series.bars.length;
    if (n < 45) { U.toast('Replay needs at least 45 bars; this window has ' + n + '.', 'warn', 6000); return; }
    clearLive();
    S.isLive = false;
    S.replay = { k: Math.max(30, n - 20), total: n, full: S.series };
    replayApply();
    syncReplayUi();
    U.toast('Replay started at bar ' + S.replay.k + ' of ' + n + ' — step with ◀ ▶.', '', 6000);
  }

  function replayApply() {
    const r = S.replay;
    if (!r) return;
    S.series = Object.assign({}, r.full, { bars: r.full.bars.slice(0, r.k) });
    S.model = SD.Analysis.run(S.series, S.cfg);
    renderQuote(); draw(); renderPanels();
    setStatus('Replay · bar ' + r.k + ' of ' + r.total + ' · ' +
      U.fmtBarTime(S.series.bars[r.k - 1].t, S.series.granularity, S.series.timezone) + ' · polling paused');
  }

  function replayStep(d) {
    const r = S.replay;
    if (!r) return;
    const k = U.clamp(r.k + d, 30, r.total);
    if (k === r.k) return;
    r.k = k;
    replayApply(); syncReplayUi();
  }

  function replayStop() {
    const r = S.replay;
    if (!r) return;
    S.replay = null;
    S.series = r.full;
    S.model = SD.Analysis.run(S.series, S.cfg);
    S.isLive = !!S.pollSpec;
    renderQuote(); draw(); renderPanels();
    setStatus(tapeStatus(S.isLive ? 'Live · ' : (S.manual ? 'Manual feed. ' : 'Loaded ')));
    if (S.pollSpec && S.view === 'desk') startPolling(S.pollSpec);
    syncReplayUi();
    U.toast('Back to the full tape' + (S.pollSpec ? ' — polling resumed.' : '.'), 'ok');
  }

  // A new symbol or timeline replaces the tape, so replay has nothing left to rewind.
  function dropReplay() {
    if (!S.replay) return;
    S.replay = null;
    syncReplayUi();
  }

  function syncReplayUi() {
    const r = S.replay;
    const nav = $('#replayNav');
    if (nav) nav.hidden = !r;
    const btn = $('#replayToggle');
    if (btn) { btn.classList.toggle('is-on', !!r); btn.textContent = r ? 'Replay on' : 'Replay'; }
    if (r) $('#replayPos').textContent = 'bar ' + r.k + ' / ' + r.total;
  }

  /* ------------------------------------------------------------------ alerts
     Evaluated on every load and poll, so they only fire while this tab is open — the keyless
     relays have no server-side watcher. A price alert fires on the crossing, never on a level
     that was already behind the price when it was armed. */
  function loadAlerts() {
    const saved = U.store.get('alerts', []);
    S.alerts = (Array.isArray(saved) ? saved : []).filter(a => a && a.id && a.symbol &&
      (a.kind === 'price' ? isFinite(a.price) && (a.op === 'above' || a.op === 'below')
                          : a.kind === 'structure' && (a.op === 'breakout' || a.op === 'breakdown')));
  }
  function saveAlerts() {
    S.alerts = S.alerts.slice(-20);
    U.store.set('alerts', S.alerts);
  }

  function bindAlerts() {
    U.on($('#alertAdd'), 'click', armAlert);
    U.on($('#alertOp'), 'change', () => {
      const structural = $('#alertOp').value === 'breakout' || $('#alertOp').value === 'breakdown';
      $('#alertPrice').disabled = structural;
      if (structural) $('#alertPrice').value = '';
    });
    U.on($('#alertClear'), 'click', () => {
      S.alerts = S.alerts.filter(a => !a.fired);
      saveAlerts(); paintAlerts();
    });
    const notify = $('#alertNotify');
    if (!('Notification' in window)) { notify.disabled = true; notify.title = 'This browser has no Notification API.'; }
    else notify.checked = !!U.store.get('alertNotify', false);
    U.on(notify, 'change', () => {
      U.store.set('alertNotify', notify.checked);
      if (!notify.checked || !('Notification' in window) || Notification.permission === 'granted') return;
      try {
        Notification.requestPermission().then(p => {
          if (p === 'granted') return;
          notify.checked = false; U.store.set('alertNotify', false);
          U.toast('Desktop notifications were blocked — in-app alerts still fire.', 'warn');
        });
      } catch (e) { notify.checked = false; }
    });
  }

  function armAlert() {
    if (!S.model || !S.series) { U.toast('Load a symbol before arming an alert.', 'warn'); return; }
    const op = $('#alertOp').value;
    const kind = op === 'above' || op === 'below' ? 'price' : 'structure';
    const price = parseFloat($('#alertPrice').value);
    if (kind === 'price' && (!isFinite(price) || price <= 0)) { U.toast('Enter a price for the alert to cross.', 'warn'); return; }
    const m = S.model;
    S.alerts.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      symbol: S.series.symbol, kind, op,
      price: kind === 'price' ? price : null,
      note: kind === 'price' ? '' : 'waits for volume-confirmed acceptance',
      armedAt: Date.now(), fired: null,
      since: m.bars[m.bars.length - 1].t,
      known: m.signals.filter(x => x.dir === (op === 'breakout' ? 'up' : 'down')).map(x => x.t + '|' + x.dir),
      was: kind === 'price' ? (op === 'above' ? m.last.c >= price : m.last.c <= price) : false
    });
    saveAlerts(); paintAlerts();
    $('#alertPrice').value = '';
    U.toast('Armed: ' + S.series.symbol + ' ' + (kind === 'price' ? op + ' ' + U.fmtPrice(price, m.dec) : op) +
      '. Fires while this tab is open.', 'ok', 6000);
  }

  function evalAlerts() {
    if (!S.model || S.replay || !S.alerts.length) return;
    const m = S.model, sym = S.series && S.series.symbol;
    let dirty = false;
    for (const a of S.alerts) {
      if (a.fired || a.symbol !== sym) continue;
      if (a.kind === 'price') {
        const pos = a.op === 'above' ? m.last.c >= a.price : m.last.c <= a.price;
        if (pos && a.was === false) fireAlert(a, m.last.c, m);
        if (a.was !== pos) { a.was = pos; dirty = true; }
      } else {
        const want = a.op === 'breakout' ? 'up' : 'down';
        // The signals present when the alert was armed are the baseline; a break that completes
        // later on the *same* bar is a new event and must fire.
        const sig = m.signals.find(x => x.dir === want && !(a.known || []).includes(x.t + '|' + x.dir));
        if (sig) fireAlert(a, sig.level, m, sig);
      }
    }
    if (dirty) saveAlerts();
  }

  function fireAlert(a, price, m, sig) {
    a.fired = Date.now();
    saveAlerts(); paintAlerts();
    const head = a.symbol + ' ' + (a.kind === 'price'
      ? (a.op === 'above' ? 'crossed above ' : 'crossed below ') + U.fmtPrice(a.price, m.dec)
      : 'confirmed ' + a.op + (sig ? ' @ ' + U.fmtPrice(price, m.dec) + ' · RVOL ' + rvolTxt(sig.rvol) : ''));
    const bearish = a.op === 'below' || a.op === 'breakdown';
    U.toast('Alert · ' + head, bearish ? 'err' : 'ok', 12000);
    if (U.store.get('alertNotify', false) && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Structure Desk · ' + a.symbol, { body: head }); } catch (e) { /* constructor can throw on some platforms */ }
    }
  }

  function paintAlerts() {
    const host = $('#alertList');
    if (!host) return;
    const sym = S.series && S.series.symbol;
    $('#alertCount').textContent = S.alerts.filter(a => !a.fired).length;
    if (!S.alerts.length) { host.innerHTML = '<p class="muted">No alerts armed.</p>'; return; }
    host.innerHTML = S.alerts.slice().reverse().map(a => {
      const what = a.kind === 'price'
        ? (a.op === 'above' ? '↑ above ' : '↓ below ') + U.fmtPrice(a.price, 2)
        : (a.op === 'breakout' ? '↑ confirmed breakout' : '↓ confirmed breakdown');
      const when = a.fired ? 'fired ' + U.fmtClock(a.fired, 'UTC') + 'Z'
        : 'armed ' + U.fmtClock(a.armedAt, 'UTC') + 'Z' + (a.symbol !== sym ? ' · not on screen' : '');
      return '<div class="alert-row' + (a.fired ? ' fired' : '') + '">' +
        '<div class="ar-main"><b>' + U.escapeHtml(a.symbol) + '</b> ' + U.escapeHtml(what) +
        (a.note ? '<div class="ar-when">' + U.escapeHtml(a.note) + '</div>' : '') +
        '<div class="ar-when">' + when + '</div></div>' +
        '<button class="ar-x" type="button" aria-label="Remove alert" data-rm="' + a.id + '">×</button></div>';
    }).join('');
    $$('#alertList [data-rm]').forEach(b => U.on(b, 'click', () => {
      S.alerts = S.alerts.filter(a => String(a.id) !== b.dataset.rm);
      saveAlerts(); paintAlerts();
    }));
  }


  function showHint(d) {
    const el = $('#symbolHint');
    /* Name first, and the venue the listing file actually implies — a bare "TATACHEM" is an NSE scrip,
       not whatever a suffix-less guess would default to. */
    const board = SD.Tickers.boardSymbol(d.symbol);
    const view = board && board !== d.symbol ? SD.Data.describeSymbol(board) : d;
    const full = SD.Tickers.nameOf(view.symbol);
    el.textContent = (full ? full + ' — ' : '') + view.hint;
    el.hidden = false;
    clearTimeout(showHint.t);
    showHint.t = setTimeout(() => { el.hidden = true; }, 5200);
  }

  /* ------------------------------------------------------------------ settings form */
  function hydrateCfgForm() {
    $('#setPivotWidth').value = S.cfg.pivotWidth;
    $('#setCloseWeight').value = Math.round(S.cfg.closeWeight * 100);
    $('#setLookback').value = S.cfg.lookback;
    $('#setAtrPeriod').value = S.cfg.atrPeriod;
    $('#setRvol').value = S.cfg.rvolThreshold;
    $('#setSustain').value = S.cfg.sustainBars;
    $('#setMargin').value = S.cfg.breakMargin;
    $('#setRequireVol').checked = S.cfg.requireVolume;
    $('#setPoll').value = S.cfg.poll;
    $('#setTick').value = S.cfg.tick;
    $('#setBase').value = S.cfg.base;
    $('#setProxy').value = S.cfg.proxy;
    $('#setChain').checked = S.cfg.chain;
    $('#setPrePost').checked = S.cfg.prePost;
    $('#setCurrency').value = S.cfg.currency;
    $('#setHome').value = S.cfg.home;
    $('#setWickPivots').checked = S.cfg.wickPivots;
    syncOutputs();
  }

  function bindSettings() {
    const live = ['setPivotWidth', 'setCloseWeight', 'setLookback', 'setAtrPeriod', 'setRvol', 'setSustain', 'setMargin', 'setPoll', 'setTick'];
    live.forEach(id => {
      U.on($('#' + id), 'input', syncOutputs);
      U.on($('#' + id), 'change', () => {
        collectCfg(); saveCfg(); refresh();
        // A new cadence takes effect on the next beat, not after the next page load.
        if (id === 'setTick' && S.tickTimer) startTicking(S.pollSpec);
      });
    });
    ['setRequireVol', 'setChain', 'setPrePost', 'setCurrency', 'setHome', 'setWickPivots', 'setBase', 'setProxy'].forEach(id => {
      U.on($('#' + id), 'change', () => { collectCfg(); saveCfg(); refresh(); });
    });
    U.on($('#setClearSym'), 'click', () => {
      SD.Data.clearResolutions();
      U.toast('Ticker matches forgotten. The next lookup probes every venue again.', 'ok', 6000);
    });
    U.on($('#setReset'), 'click', () => {
      S.cfg = Object.assign({}, DEFAULTS);
      hydrateCfgForm(); saveCfg(); refresh();
      U.toast('Engine settings reset.', 'ok');
    });
  }

  function syncOutputs() {
    $('#setPivotWidth').nextElementSibling.textContent = $('#setPivotWidth').value;
    $('#setCloseWeight').nextElementSibling.textContent = $('#setCloseWeight').value + '%';
    $('#setLookback').nextElementSibling.textContent = $('#setLookback').value;
  }

  function collectCfg() {
    S.cfg.pivotWidth = +$('#setPivotWidth').value;
    S.cfg.closeWeight = +$('#setCloseWeight').value / 100;
    S.cfg.lookback = +$('#setLookback').value;
    S.cfg.atrPeriod = +$('#setAtrPeriod').value;
    S.cfg.rvolThreshold = +$('#setRvol').value;
    S.cfg.sustainBars = +$('#setSustain').value;
    S.cfg.breakMargin = +$('#setMargin').value;
    S.cfg.requireVolume = $('#setRequireVol').checked;
    S.cfg.poll = U.clamp(+$('#setPoll').value || 20, 5, 300);
    S.cfg.tick = U.clamp(+$('#setTick').value || 5, 3, 120);
    S.cfg.base = $('#setBase').value.trim() || DEFAULTS.base;
    S.cfg.proxy = $('#setProxy').value.trim();
    S.cfg.chain = $('#setChain').checked;
    S.cfg.prePost = $('#setPrePost').checked;
    S.cfg.currency = $('#setCurrency').value;
    S.cfg.home = $('#setHome').value;
    S.cfg.wickPivots = $('#setWickPivots').checked;
    U.store.set('closeWeightSlider', S.cfg.closeWeight);
  }

  /* ------------------------------------------------------------------ loading */
  function specForTimeline() {
    const t = S.timeline;
    const pre = t.kind === 'intraday' || t.kind === 'live' ? S.cfg.prePost : false;
    if (t.kind === 'custom') return { symbol: S.symbol, interval: t.interval, period1: t.period1, period2: t.period2, prePost: false };
    return { symbol: S.symbol, interval: t.interval, range: t.range, prePost: pre };
  }

  function resetBaseline() { S.seeded = false; S.knownSignals = {}; }

  /* Every preset range is fetched up to the present, so its newest bar is still forming and the
     chart has to keep asking for it — that is what makes a fixed 6-month window move like Live.
     A custom window that ends in the past is history: polling it would re-read a closed record
     every few seconds and never change a pixel. */
  function reachesNow(spec) {
    if (!spec) return false;
    if (spec.period2) {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      return spec.period2 >= start.getTime();
    }
    return true;
  }

  async function loadCurrent(opts) {
    opts = opts || {};
    dropReplay();                              // a new tape has nothing left to rewind
    S.gen++;                                   // any intentional load invalidates in-flight work
    if (S.timeline.kind === 'live') return loadLive(opts);
    const spec = specForTimeline();
    return fetchAndBuild(spec, { live: false });
  }

  /* Live = no timeline chosen. Poll the tape, repaint when the traded value moves. */
  async function loadLive(opts) {
    clearLive();
    const prefs = [['1m', '1d'], ['5m', '1d'], ['15m', '5d'], ['1d', '6mo']];
    let lastErr = null;
    showVeil(true, 'Requesting ' + S.symbol + ' live tape…');
    for (let p = 0; p < prefs.length; p++) {
      const spec = { symbol: S.symbol, interval: prefs[p][0], range: prefs[p][1], prePost: S.cfg.prePost };
      try {
        const series = await SD.Data.fetchSeries(spec, cfgForFetch());
        if (!series.bars || series.bars.length < 12) { lastErr = new Error(prefs[p][0] + ' window too thin'); continue; }
        S.timeline = Object.assign(S.timeline, { interval: spec.interval, range: spec.range });
        applySeries(series, { live: true, spec });
        startPolling(spec);
        showVeil(false);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    showVeil(false);
    liveFailed(lastErr || new Error('no window returned enough bars'));
  }

  function liveFailed(err) {
    if (S.cfg.demoFallback !== false) {
      demoFallback('Live feed unavailable (' + shortErr(err) + '). Showing a synthetic tape — load a timeline chip or paste OHLCV for real data.');
    } else {
      setStatus('Live feed failed: ' + shortErr(err));
      U.toast('Live feed failed: ' + shortErr(err), 'err', 7000);
    }
  }

  function cfgForFetch() {
    return {
      base: S.cfg.base,
      proxy: S.cfg.proxy,
      chain: S.cfg.chain ? SD.Data.DEFAULT_PROXY_CHAIN : [S.cfg.proxy],
      home: S.cfg.home,
      timeout: 15000
    };
  }

  async function fetchAndBuild(spec, o) {
    if (S.inFlight) return;
    S.inFlight = true;
    const gen = S.gen;
    showVeil(true, 'Requesting ' + spec.symbol + ' · ' + spec.interval + ' · ' + (spec.range || 'window'));
    try {
      const series = await SD.Data.fetchSeries(spec, cfgForFetch());
      if (gen !== S.gen) return;                       // superseded by a newer load or a manual feed
      // Preset ranges always span weeks; a near-empty payload is a relay fault, not a market.
      if (spec.range && (!series.bars || series.bars.length < 12)) throw new Error('relay returned only ' + (series.bars ? series.bars.length : 0) + ' bars');
      applySeries(series, { live: reachesNow(spec), spec });
      // A window that reaches the present is a live window, whatever chip produced it.
      if (reachesNow(spec)) startPolling(spec);
      else { S.pollSpec = null; clearLive(); }
    } catch (e) {
      if (gen !== S.gen) return;
      setStatus('Feed error: ' + shortErr(e));
      U.toast('Feed error: ' + shortErr(e) + ' — try a timeline chip, change the relay in Settings, or paste OHLCV.', 'err', 8000);
      if (!S.model) demoFallback('No live data. Demo tape loaded so the engine stays inspectable.');
    } finally {
      if (gen === S.gen) { S.inFlight = false; showVeil(false); }
    }
  }

  function useManual(bars, label) {
    const cur = SD.Data.venueFor(S.symbol).meta.cur;
    const series = SD.Data.fromBars(bars, S.symbol, { interval: guessInterval(bars), cur });
    series.symbol = S.symbol;
    S.gen++;                                   // a pasted tape outranks whatever the feed is doing
    S.pollSpec = null;
    dropReplay();
    clearLive();
    S.timeline = { kind: 'manual', interval: series.granularity, label: 'Manual OHLCV' };
    applySeries(series, { live: false, manual: true, spec: { symbol: S.symbol, interval: series.granularity } });
    U.toast('Using ' + bars.length + ' bars from ' + label + '.', 'ok');
  }

  function guessInterval(bars) {
    if (bars.length < 2) return '1d';
    const d = bars[1].t - bars[0].t;
    if (d < 120000) return '1m';
    if (d < 30 * 60000) return '5m';
    if (d < 4 * 3600000) return '60m';
    if (d < 4 * 86400000) return '1d';
    if (d < 20 * 86400000) return '1wk';
    return '1mo';
  }

  function demoFallback(msg) {
    clearLive();
    S.pollSpec = null;
    dropReplay();
    const iv = S.timeline.interval || '1d';
    const series = SD.Data.demoSeries(S.symbol, 260, iv === '1mo' || iv === '1wk' || iv === '1d' ? iv : '1d');
    series.symbol = S.symbol;
    S.timeline = { kind: 'demo', interval: series.granularity, label: 'Demo tape' };
    applySeries(series, { live: false, demo: true, spec: { symbol: S.symbol, interval: series.granularity } });
    U.toast(msg, 'warn', 7000);
  }

  function tapeStatus(prefix) {
    return prefix + S.series.symbol + ' · ' + S.series.granularity + ' · ' + S.series.bars.length + ' bars.';
  }

  function applySeries(series, o) {
    S.series = series;
    S.spec = o.spec;
    S.isLive = !!o.live;
    S.demo = !!o.demo;
    S.manual = !!o.manual;
    paintMarketStrip();
    // A clean tape read proves the relays are answering, so the tick's backoff can lift.
    if (o.live && S.tickTimer) {
      S.tickFail = 0; S.tickNext = 0;
      const dot = $('#qsDot');
      dot.classList.add('is-on'); dot.classList.remove('is-wait'); dot.title = 'Price tick is live';
    }
    S.model = SD.Analysis.run(series, S.cfg);
    renderQuote();
    draw();
    renderPanels();
    setStatus(tapeStatus(o.demo ? 'Demo tape. ' : o.manual ? 'Manual feed. ' : o.live ? 'Live · ' : 'Loaded '));
    $('#liveBadge').classList.toggle('is-off', !S.isLive);
    $('#updatedText').textContent = 'updated ' + U.fmtClock(Date.now(), 'UTC') + 'Z';
    // Only a live repaint mid-session announces; the first pass just seeds the known set.
    const announce = S.isLive && S.seeded;
    noteNewSignals(!announce);
    S.seeded = true;
    // Alerts read the same model the panels do, so an armed level fires on the bar that crosses it.
    if (!o.demo) evalAlerts();
    $('#alertPrice').placeholder = U.fmtPrice(S.model.last.c, S.model.dec);
    paintAlerts();
  }

  function refresh() {
    // Rows share the engine settings and cached series; the scan table scores off those same rows.
    if (SD.Watch) SD.Watch.reload();
    if (SD.Scan) SD.Scan.reload();
    if (!S.series) return;
    S.model = SD.Analysis.run(S.series, S.cfg);
    draw();
    renderPanels();
  }

  /* ------------------------------------------------------------------ polling */
  function startPolling(spec) {
    clearLive();
    S.pollSpec = spec;
    const ms = Math.max(5, S.cfg.poll) * 1000;
    const gen = S.gen;
    S.liveTimer = setInterval(async () => {
      if (S.inFlight || S.pollBusy || document.hidden) return;
      if (gen !== S.gen) { clearInterval(S.liveTimer); S.liveTimer = null; return; }
      S.pollBusy = true;
      try {
        const series = await SD.Data.fetchSeries(spec, cfgForFetch());
        if (gen !== S.gen) return;             // superseded by a chip load or a pasted tape
        // A relay that truncates the payload must never replace a good tape with a stub.
        if (!series.bars || series.bars.length < 12) throw new Error('relay returned only ' + (series.bars ? series.bars.length : 0) + ' bars');
        const prev = S.series && S.series.bars.length ? S.series.bars[S.series.bars.length - 1] : null;
        const last = series.bars[series.bars.length - 1];
        const changed = !prev || last.t !== prev.t || last.c !== prev.c;
        if (!changed) { $('#updatedText').textContent = 'unchanged ' + U.fmtClock(Date.now(), 'UTC') + 'Z'; return; }
        applySeries(series, { live: true, spec, silent: false });
      } catch (e) {
        setStatus('Poll failed: ' + shortErr(e));
        $('#liveBadge').classList.add('is-off');
      } finally {
        S.pollBusy = false;
      }
    }, ms);
    $('#liveBadge').classList.remove('is-off');
    startTicking(spec);
  }

  function clearLive() {
    if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = null; }
    stopTicking();
    $('#liveBadge').classList.add('is-off');
  }

  /* ------------------------------------------------------------ price tick
     The tape poll rebuilds the whole model, so it is deliberately slow. The price a moomoo
     screen moves on is a much smaller read: the quote endpoint's own last price against the
     previous close. That read runs on its own clock, repaints the quote, the forming bar and
     the chart's last-price tag, and never touches the verdict — the structure engine still
     only re-reads the tape on the poll, so a tick can move the price but cannot invent a signal. */
  function startTicking(spec) {
    stopTicking();
    if (!S.series || S.demo || S.manual) return;
    S.tickSpec = {
      symbol: S.series.symbol,
      interval: '5m', range: '1d',
      prePost: !!(spec && spec.prePost)
    };
    const ms = U.clamp(+S.cfg.tick || 5, 3, 120) * 1000;
    S.tickFail = 0; S.tickNext = 0;
    S.tickTimer = setInterval(tickQuote, ms);
    const dot = $('#qsDot');
    dot.classList.add('is-on');
    dot.title = 'Price tick is live';
    tickQuote();
  }

  function stopTicking() {
    if (S.tickTimer) { clearInterval(S.tickTimer); S.tickTimer = null; }
    S.tickSpec = null;
    S.tickBusy = false;
    S.tickFail = 0;
    S.tickNext = 0;
    const dot = $('#qsDot');
    if (dot) { dot.classList.remove('is-on', 'is-wait'); dot.title = 'Price tick is idle'; }
  }

  async function tickQuote() {
    if (!S.tickSpec || S.tickBusy || S.inFlight || S.pollBusy) return;
    if (Date.now() < S.tickNext) return;
    if (document.hidden || S.view !== 'desk' || S.replay || !S.isLive || !S.series || !S.model) return;
    // A watchlist scan already owns the relays; a price tick must not compete with it.
    const prog = SD.Watch && SD.Watch.scanProgress ? SD.Watch.scanProgress() : null;
    if (prog && prog.busy) return;
    const gen = S.gen, sym = S.series.symbol, tickSpec = S.tickSpec;
    S.tickBusy = true;
    try {
      const series = await SD.Data.fetchSeries(tickSpec, cfgForFetch());
      if (gen !== S.gen || !S.series || S.series.symbol !== sym || S.replay) return;
      if (S.view !== 'desk' || !S.isLive) return;
      const px = isFinite(series.lastPrice) && series.lastPrice > 0
        ? series.lastPrice
        : (series.bars && series.bars.length ? series.bars[series.bars.length - 1].c : NaN);
      if (!isFinite(px) || px <= 0) return;
      S.tickFail = 0; S.tickNext = 0;
      const dot = $('#qsDot');
      dot.classList.add('is-on'); dot.classList.remove('is-wait'); dot.title = 'Price tick is live';
      applyTick(px, series.prevClose, series.marketState, series.regularMarketTime);
    } catch (e) {
      // Free relays rate-limit. Back off instead of hammering the chain: a quiet tick is
      // better than a locked-out feed, and the tape poll still owns the error badge.
      const base = U.clamp(+S.cfg.tick || 5, 3, 120);
      S.tickFail = Math.min(4, S.tickFail + 1);
      const wait = Math.min(120, base * Math.pow(3, S.tickFail - 1));
      S.tickNext = Date.now() + wait * 1000;
      const dot = $('#qsDot');
      if (dot) {
        dot.classList.remove('is-on'); dot.classList.add('is-wait');
        dot.title = 'Relay cooling down — next price tick in ~' + Math.round(wait) + 's';
      }
    } finally {
      S.tickBusy = false;
    }
  }

  function applyTick(px, prevClose, marketState, marketTime) {
    const s = S.series, m = S.model;
    if (!s || !m) return;
    const prev = isFinite(s.lastPrice) && s.lastPrice > 0 ? s.lastPrice : m.last.c;
    // A slow tick must not overwrite a newer print the tape poll already applied.
    if (marketTime && s.regularMarketTime && marketTime < s.regularMarketTime - 1000) return;
    const base = prevClose && prevClose > 0 ? prevClose : s.prevClose;
    s.lastPrice = px;
    if (base > 0) s.prevClose = base;
    if (marketState) s.marketState = marketState;
    if (marketTime) s.regularMarketTime = marketTime;

    m.last = Object.assign({}, m.last, { c: px });
    const lastBar = m.bars[m.bars.length - 1];
    // Put the print on the forming bar only when that bar really covers this moment; a new
    // session's first print must not move yesterday's candle while the tape poll catches up.
    if (lastBar && barCovers(lastBar.t, marketTime || Date.now())) {
      lastBar.c = px;
      if (px > lastBar.h) lastBar.h = px;
      if (px < lastBar.l) lastBar.l = px;
    }
    paintTick(px, prev, base);
    S._studyModel = null;                    // overlays read closes, and the last close just moved
    draw();
    $('#updatedText').textContent = 'ticked ' + U.fmtClock(Date.now(), 'UTC') + 'Z';
    $('#alertPrice').placeholder = U.fmtPrice(px, m.dec);
    // A crossed price level is a fact of this print, not of the next tape rebuild.
    evalAlerts();
  }

  function barCovers(barT, t) {
    const gran = S.series && S.series.granularity;
    const sec = (SD.Data.INTERVAL_SECONDS && SD.Data.INTERVAL_SECONDS[gran]) || 0;
    if (!sec) return false;
    if (sec >= 86400) {
      if (gran === '1d') return U.dayKey(t, S.series.timezone) === U.dayKey(barT, S.series.timezone);
      return true;                                  // weekly/monthly bars hold today's print
    }
    return t - barT < sec * 1000 * 1.5;
  }

  function paintTick(px, prev, base) {
    const el = $('#qsLast');
    const cur = CUR_SYM[S.series.currency] || (S.series.currency + ' ');
    const dir = px > prev ? 'up' : px < prev ? 'down' : '';
    tweenPrice(el, prev, px, cur, S.model.dec);
    el.classList.toggle('pos', base > 0 && px >= base);
    el.classList.toggle('neg', base > 0 && px < base);
    el.dataset.dir = dir || 'flat';
    el.dataset.ticks = String((+el.dataset.ticks || 0) + 1);
    if (dir) {
      const cell = el.closest('.qs-cell');
      cell.classList.remove('tick-up', 'tick-down');
      void cell.offsetWidth;                        // restart the flash on back-to-back prints
      cell.classList.add(dir === 'up' ? 'tick-up' : 'tick-down');
      clearTimeout(paintTick.timer);
      paintTick.timer = setTimeout(() => cell.classList.remove('tick-up', 'tick-down'), 900);
    }
    if (base > 0) {
      const pct = 100 * (px - base) / base;
      const chg = $('#qsChg');
      chg.textContent = U.fmtPct(pct) + ' (' + U.fmtPrice(px - base, S.model.dec) + ')';
      chg.className = 'qs-v ' + (pct >= 0 ? 'pos' : 'neg');
    }
    $('#qsSession').textContent = sessionText(S.series);
  }

  function tweenPrice(el, from, to, prefix, dec) {
    if (el._tweenRaf) cancelAnimationFrame(el._tweenRaf);
    clearTimeout(el._tweenTimer);
    const settle = () => {
      clearTimeout(el._tweenTimer);
      el.textContent = prefix + U.fmtPrice(to, dec);
      el._tweenRaf = 0;
    };
    if (!isFinite(from) || from === to || document.hidden || !window.requestAnimationFrame) { settle(); return; }
    const t0 = performance.now(), dur = 420;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const v = from + (to - from) * (1 - Math.pow(1 - k, 3));
      el.textContent = prefix + U.fmtPrice(v, dec);
      if (k < 1) el._tweenRaf = requestAnimationFrame(step);
      else settle();
    };
    el._tweenRaf = requestAnimationFrame(step);
    // A throttled tab can starve rAF; the number must still land on the real print.
    el._tweenTimer = setTimeout(settle, dur + 160);
  }

  function noteNewSignals(silent) {
    if (!S.model) return;
    const keys = {};
    for (const s of S.model.signals) {
      const k = s.t + '|' + s.dir + '|' + U.round(s.level, 4);
      keys[k] = true;
      if (!S.knownSignals[k] && !silent) {
        U.toast((s.dir === 'up' ? 'Confirmed breakout' : 'Confirmed breakdown') + ' on ' + S.model.series.symbol + ' @ ' + U.fmtPrice(s.level) + ' · RVOL ' + rvolTxt(s.rvol), s.dir === 'up' ? 'ok' : 'err', 9000);
      }
    }
    S.knownSignals = keys;
  }

  /* ------------------------------------------------------------------ drawing */
  function draw() {
    if (!S.model) return;
    S.studies = studiesFor(S.model);
    SD.Chart.render(S.model, Object.assign({}, S.chartOpts, {
      tz: S.series.timezone,
      interval: S.series.granularity,
      live: S.isLive && !S.replay,
      mouseY: S.mouseY,
      studies: S.studies,
      replay: S.replay ? { total: S.replay.total } : null
    }));
    renderLegend();
  }

  /* The same tape and the same selection always produce the same study arrays, and this runs on
     every hover frame — so resolve once per (model, selection) instead of once per mouse move. */
  function studiesFor(model) {
    const sel = S.studySel.join(',');
    if (S._studyModel === model && S._studySel === sel) return S._studies;
    S._studyModel = model; S._studySel = sel;
    S._studies = SD.Ind.studies(model, S.studySel);
    return S._studies;
  }

  /* The legend is the read-out for whatever studies are switched on: the value at the hovered
     bar while the cursor is over the chart, the latest value otherwise. It also says when the
     series is a display transform (Heikin Ashi) or when a Fib grid is drawn over the price. */
  function renderLegend() {
    const host = $('#chartLegend');
    if (!host) return;
    const i = S.hoverI >= 0 ? S.hoverI : S.model.bars.length - 1;
    const items = S.studies.map(s => {
      const v = s.line && isFinite(s.line[i]) ? s.line[i] : NaN;
      const txt = isFinite(v) ? (s.scale ? v.toFixed(1) : U.fmtPrice(v, 2)) : '—';
      return '<span class="lg"><i style="background:' + s.color + '"></i>' + U.escapeHtml(s.label) + ' <b>' + txt + '</b></span>';
    });
    if (S.chartOpts.mode === 'heikin') {
      items.push('<span class="lg"><i style="background:#8c9cb0"></i>Heikin Ashi <b>marks raw tape</b></span>');
    }
    if (S.chartOpts.fib) {
      const leg = SD.Ind.fibLeg(S.model);
      if (leg) {
        items.push('<span class="lg"><i style="background:#f2b53c"></i>Fib <b>' + leg.dir + ' ' +
          U.fmtPrice(leg.lo, S.model.dec) + '→' + U.fmtPrice(leg.hi, S.model.dec) + '</b></span>');
      }
    }
    if (!items.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.innerHTML = items.join('');
    host.hidden = false;
  }

  function bindChart() {
    // The rail can change height and steal width back, so track the box, not just the window.
    if (window.ResizeObserver) new ResizeObserver(() => { if (S.model) draw(); }).observe($('#chartWrap'));

    const cv = $('#chart');
    const tip = $('#tooltip');
    let raf = 0;
    cv.addEventListener('mousemove', e => {
      if (!S.model) return;
      const rect = cv.getBoundingClientRect();
      S.mouseY = e.clientY - rect.top;
      const i = SD.Chart.indexAt(e.clientX, S.model);
      SD.Chart.setHover(i);
      S.hoverI = i;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
        paintTip(i, e.clientX - rect.left, e.clientY - rect.top, rect);
      });
    });
    cv.addEventListener('mouseleave', () => {
      SD.Chart.setHover(-1); S.mouseY = undefined; S.hoverI = -1;
      tip.hidden = true; draw();
    });

    function paintTip(i, x, y, rect) {
      const m = S.model, b = m.bars[i];
      if (!b) { tip.hidden = true; return; }
      const prev = m.bars[i - 1];
      const chg = prev ? 100 * (b.c - prev.c) / prev.c : 0;
      const swing = m.swings.find(s => s.i === i);
      const ev = m.events.find(e2 => e2.i === i);
      const rows = [
        ['O', U.fmtPrice(b.o, m.dec)], ['H', U.fmtPrice(b.h, m.dec)],
        ['L', U.fmtPrice(b.l, m.dec)], ['C', U.fmtPrice(b.c, m.dec)],
        ['Chg', U.fmtPct(chg)], ['Vol', U.fmtVolume(b.v)],
        ['RVOL', rvolTxt(rvolAt(m, i))],
        ['ATR', U.fmtPrice(m.atr[i], 3)]
      ];
      let html = '<div class="tt-h">' + U.fmtBarTime(b.t, m.series.granularity, m.series.timezone) + (b.closed ? '' : ' · forming') + '</div>';
      html += rows.map(r => '<div class="r"><span>' + r[0] + '</span><b>' + r[1] + '</b></div>').join('');
      if (swing) html += '<div class="note">' + swing.rel + ' ' + (swing.closeBacked ? 'close-backed' : 'wick only') + '</div>';
      if (ev) html += '<div class="note">' + eventLabel(ev) + (ev.confirmed ? '' : ' · ' + ev.reasons[0]) + '</div>';
      tip.innerHTML = html;
      tip.hidden = false;
      const tw = tip.offsetWidth || 190, th = tip.offsetHeight || 140;
      tip.style.left = U.clamp(x + 14, 4, rect.width - tw - 6) + 'px';
      tip.style.top = U.clamp(y - th - 10, 4, rect.height - th - 6) + 'px';
    }
  }

  function rvolAt(m, i) {
    const med = U.median(m.bars.slice(Math.max(0, i - 20), i).map(b => b.v));
    return med > 0 ? m.bars[i].v / med : NaN;
  }

  /* ------------------------------------------------------------------ panels */
  function renderQuote() {
    const s = S.series, m = S.model;
    const resolved = s.resolvedFrom ? s.symbol + '  ← ' + s.resolvedFrom : s.symbol;
    /* The class reads a ticker aloud, so the company it belongs to must be on the screen next to it. */
    const full = SD.Tickers.nameOf(s.symbol) || SD.Tickers.nameOf(s.resolvedFrom || '');
    $('#qsName').innerHTML = (full ? '<span class="qs-full">' + U.escapeHtml(full) + '</span><br>' : '') +
      U.escapeHtml(s.symbol) + ' <span class="muted">· ' + U.escapeHtml(s.exchange) + '</span>' +
      (s.resolvedFrom ? '<br><span class="qs-sub">matched from ' + U.escapeHtml(s.resolvedFrom) +
        (s.triedSymbols && s.triedSymbols.length > 1 ? ' (tried ' + U.escapeHtml(s.triedSymbols.join(', ')) + ')' : '') + '</span>' : '');
    $('#qsName').title = resolved + ' · ' + s.timezone;
    const cur = CUR_SYM[s.currency] || (s.currency + ' ');
    const lastEl = $('#qsLast');
    if (lastEl._tweenRaf) { cancelAnimationFrame(lastEl._tweenRaf); lastEl._tweenRaf = 0; }
    lastEl.textContent = cur + U.fmtPrice(m.last.c, m.dec);
    const base = s.prevClose && s.prevClose > 0 ? s.prevClose : m.bars[Math.max(0, m.bars.length - 2)].c;
    const pct = base ? 100 * (m.last.c - base) / base : 0;
    lastEl.classList.toggle('pos', pct > 0);
    lastEl.classList.toggle('neg', pct < 0);
    const chgEl = $('#qsChg');
    chgEl.textContent = U.fmtPct(pct) + ' (' + U.fmtPrice(m.last.c - base, m.dec) + ')';
    chgEl.className = 'qs-v ' + (pct >= 0 ? 'pos' : 'neg');
    $('#qsSession').textContent = sessionText(s);
    $('#qsRvol').textContent = rvolTxt(m.volume.rvol);
    $('#barCount').textContent = m.bars.length + ' bars';
    $('#spanLabel').textContent = S.timeline.label + ' · ' + s.granularity + ' · via ' + (s.via || '—') + ' · ' + s.currency;
    $('#liveBadge').classList.toggle('is-off', !S.isLive);
    $('#liveBadge').textContent = S.isLive ? 'LIVE' : 'STATIC';
  }

  function sessionText(s) {
    const venue = s.venue ? s.venue.meta : { sessions: [[0, 1440]] };
    if (s.marketState === 'MANUAL' || (venue.sessions && venue.sessions[0][0] === 0 && venue.sessions[0][1] === 1440)) return 'manual feed';
    const tz = s.timezone || venue.tz;
    const local = U.inZone(new Date(), tz);
    const dow = local.getUTCDay();
    const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    const hhmm = m2 => String(Math.floor(m2 / 60)).padStart(2, '0') + ':' + String(m2 % 60).padStart(2, '0');
    for (const [a, b] of venue.sessions) {
      if (mins >= a && mins < b) return 'open · ' + hhmm(mins) + ' → ' + hhmm(b) + ' ' + tz.split('/').pop();
    }
    let next = null;
    for (const [a] of venue.sessions) if (a > mins) { next = a; break; }
    if (dow === 0 || dow === 6) return 'weekend · reopens ' + (next !== null ? hhmm(venue.sessions[0][0]) : '09:15') + ' ' + tz.split('/').pop();
    const first = venue.sessions[0];
    if (mins < first[0]) return 'pre-open · ' + (S.cfg.prePost ? 'ext. hours on' : 'regular only') + ' · opens ' + hhmm(first[0]);
    return 'closed · reopens ' + hhmm(first[0]) + ' ' + tz.split('/').pop();
  }

  function renderPanels() {
    const m = S.model;
    renderVerdict(m);
    renderSignals(m);
    renderWatch(m);
    renderLevels(m);
    renderSwingTable(m);
    renderEventTable(m);
    renderQuality(m);
  }

  function renderVerdict(m) {
    const st = m.structure;
    const card = $('#verdictCard');
    card.className = 'verdict-card ' + (st.tone === 'bull' ? 't-bull' : st.tone === 'bear' ? 't-bear' : st.tone === 'range' ? 't-range' : '');
    $('#vcTitle').textContent = st.title;
    $('#vcSub').textContent = st.sub + (m.divergence ? ' ' + m.divergence.txt : '');
    const sc = $('#vcScore');
    const readable = isFinite(st.bullScore);
    sc.textContent = readable ? st.bullScore + '/100' : 'n/a';
    sc.style.color = !readable ? 'var(--ink-mute)'
      : st.bullScore > 62 ? 'var(--up)' : st.bullScore < 38 ? 'var(--down)' : 'var(--accent)';
    sc.title = readable ? 'close-weighted swing deltas, bounded' : 'needs two close-backed swings on each side';
    const res = st.resistance, sup = st.support;
    $('#vcHighs').textContent = res ? U.fmtPrice(res.price, m.dec) + (isFinite(st.distRes) ? '  +' + U.round(st.distRes, 1) + '%' : '') : 'above range';
    $('#vcLows').textContent = sup ? U.fmtPrice(sup.price, m.dec) + (isFinite(st.distSup) ? '  −' + U.round(st.distSup, 1) + '%' : '') : 'below range';
    $('#vcRun').textContent = st.runBars + ' bars';
    $('#vcBias').textContent = U.round(100 * m.posInRange, 0) + '% of range';
    $('#vcRun').title = 'last confirmed swing was ' + st.runBars + ' bars ago';

    const plan = $('#vcPlan');
    const sig = m.signals[0];
    if (sig) {
      plan.hidden = false;
      plan.innerHTML =
        '<div class="h">' + (sig.dir === 'up' ? 'Long plan · accepted breakout' : 'Short plan · accepted breakdown') + '</div>' +
        kvRow('Entry', U.fmtPrice(sig.entry, m.dec)) +
        kvRow('Stop (' + sig.stopSrc + ')', U.fmtPrice(sig.stop, m.dec)) +
        kvRow('Risk', U.round(sig.riskPct, 2) + '% of price') +
        kvRow('T1 (1.5R)', U.fmtPrice(sig.t1, m.dec)) +
        kvRow('T2 (measured)', U.fmtPrice(sig.t2, m.dec)) +
        kvRow('R:R to T2', U.round(sig.rr, 2) + ' : 1' + (sig.rr < 1.5 ? ' · thin, skip' : '')) +
        '<div style="margin-top:5px;color:var(--ink-dim)">' + U.escapeHtml(sig.plan) + '</div>';
    } else {
      plan.hidden = true;
      plan.innerHTML = '';
    }
  }

  function kvRow(k, v) {
    return '<div style="display:flex;justify-content:space-between;gap:10px"><span style="color:var(--ink-mute)">' + k + '</span><b>' + v + '</b></div>';
  }

  function renderSignals(m) {
    const host = $('#signalList');
    $('#signalCount').textContent = m.signals.length;
    if (!m.signals.length) { host.innerHTML = '<p class="muted">No confirmed signals. A break needs volume, a close on the right side of the bar and sustained acceptance.</p>'; return; }
    host.innerHTML = m.signals.slice(0, 8).map(sig => {
      const bull = sig.dir === 'up';
      return '<div class="sig ' + (bull ? 'bull' : 'bear') + '" data-i="' + sig.i + '">' +
        '<div class="sig-h">' + (bull ? '▲ Breakout accepted' : '▼ Breakdown accepted') +
        ' <span class="pill ' + (bull ? 'up' : 'down') + '">' + U.fmtPrice(sig.level, m.dec) + '</span>' +
        '<time>' + U.fmtBarTime(sig.t, m.series.granularity, m.series.timezone) + '</time></div>' +
        '<div class="sig-b">' + U.escapeHtml(sig.plan) + '</div>' +
        '<div class="sig-m"><span>RVOL <b>' + rvolTxt(sig.rvol) + '</b></span>' +
        '<span>sustain <b>' + sig.sustain + '</b></span>' +
        '<span>stop <b>' + U.fmtPrice(sig.stop, m.dec) + '</b></span>' +
        '<span>R:R <b>' + U.round(sig.rr, 2) + '</b></span>' +
        (sig.wickOnly ? '<span style="color:var(--accent)">level from a wick</span>' : '') +
        '</div></div>';
    }).join('');
    $$('#signalList .sig').forEach(el => U.on(el, 'click', () => focusBar(+el.dataset.i)));
  }

  function renderWatch(m) {
    const host = $('#watchList');
    const list = m.watch.filter(e => !e.failed);
    const fails = m.watch.filter(e => e.failed);
    $('#watchCount').textContent = list.length + fails.length;
    let html = '';
    html += fails.map(ev =>
      '<div class="sig warn" data-i="' + ev.i + '"><div class="sig-h">⚠ Failed break — trap' +
      '<time>' + U.fmtBarTime(ev.t, m.series.granularity, m.series.timezone) + '</time></div>' +
      '<div class="sig-b">' + U.escapeHtml(ev.reasons[0]) + ' at ' + U.fmtPrice(ev.level, m.dec) + '. That level is now a target, not a floor/ceiling.</div></div>'
    ).join('');
    html += list.map(ev =>
      '<div class="sig ' + (ev.pending ? 'warn' : ev.dir === 'up' ? 'bull' : 'bear') + '" data-i="' + ev.i + '">' +
      '<div class="sig-h">' + (ev.pending ? '○ Pressing level' : ev.dir === 'up' ? '○ High taken' : '○ Low taken') +
      ' <span class="pill flat">' + U.fmtPrice(ev.level, m.dec) + '</span>' +
      '<time>' + U.fmtBarTime(ev.t, m.series.granularity, m.series.timezone) + '</time></div>' +
      '<div class="sig-b">' + U.escapeHtml(ev.reasons.join('; ')) + '</div>' +
      '<div class="sig-m"><span>RVOL ' + rvolTxt(ev.rvol) + '</span>' +
      '<span>close ' + U.fmtPrice(ev.price, m.dec) + '</span>' +
      '<span>accept ' + (ev.acceptance ? 'yes' : 'no') + '</span>' +
      '<span style="color:var(--accent)">not a signal</span></div></div>'
    ).join('');
    host.innerHTML = html || '<p class="muted">Nothing pending.</p>';
    $$('#watchList .sig').forEach(el => U.on(el, 'click', () => focusBar(+el.dataset.i)));
  }

  function renderLevels(m) {
    const rows = m.readouts.map(r =>
      '<tr><td>' + U.escapeHtml(r.k) + '</td><td>' + U.escapeHtml(r.v) + '</td></tr>' +
      (r.note ? '<tr><td></td><td class="muted" style="font-family:var(--sans);font-size:10.5px">' + U.escapeHtml(r.note) + '</td></tr>' : '')
    ).join('');
    $('#levelTable').querySelector('tbody').innerHTML = rows;
  }

  function renderSwingTable(m) {
    const cols = ['Label', 'Side', 'Price', 'Bar', 'RVOL', 'Close accept', 'Weight'];
    const list = m.swings.slice().filter(s => s.rel).reverse().slice(0, 40);
    $('#swingTable').querySelector('thead').innerHTML = '<tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>';
    $('#swingTable').querySelector('tbody').innerHTML = list.map(s => {
      const cls = s.rel === 'HH' || s.rel === 'HL' ? 'up' : s.rel === 'LH' || s.rel === 'LL' ? 'down' : s.rel[0] === 'E' ? 'warn' : 'flat';
      return '<tr data-i="' + s.i + '"><td><span class="pill ' + cls + '">' + s.rel + '</span></td>' +
        '<td>' + s.side + '</td><td class="num">' + U.fmtPrice(s.price, m.dec) + '</td>' +
        '<td>' + U.fmtBarTime(s.t, m.series.granularity, m.series.timezone) + '</td>' +
        '<td class="num">' + rvolTxt(s.rvol) + '</td>' +
        '<td class="num">' + U.round(100 * s.quality, 0) + '%</td>' +
        '<td class="num">' + (s.closeBacked ? '<span class="pill up">close</span>' : '<span class="pill flat">wick</span>') + ' ' + U.round(s.strength, 2) + '</td></tr>';
    }).join('');
    $$('#swingTable tbody tr').forEach(tr => U.on(tr, 'click', () => focusBar(+tr.dataset.i)));
  }

  function eventLabel(ev) {
    if (ev.failed) return 'Failed break';
    if (ev.pending) return 'Level under test';
    return (ev.dir === 'up' ? 'High taken' : 'Low taken') + (ev.confirmed ? ' — confirmed' : ' — unconfirmed');
  }

  function renderEventTable(m) {
    const cols = ['Bar', 'Event', 'Level', 'Close', 'RVOL', 'Sustain', 'Status', 'Why'];
    $('#eventTable').querySelector('thead').innerHTML = '<tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>';
    const list = m.events.slice().reverse().slice(0, 60);
    $('#eventTable').querySelector('tbody').innerHTML = list.map(ev => {
      const status = ev.confirmed ? '<span class="pill up">signal</span>' : ev.failed ? '<span class="pill warn">trap</span>' : '<span class="pill flat">watch</span>';
      return '<tr data-i="' + ev.i + '"><td>' + U.fmtBarTime(ev.t, m.series.granularity, m.series.timezone) + '</td>' +
        '<td>' + eventLabel(ev) + '</td><td class="num">' + U.fmtPrice(ev.level, m.dec) + '</td>' +
        '<td class="num">' + U.fmtPrice(ev.price, m.dec) + '</td>' +
        '<td class="num">' + (isFinite(ev.rvol) ? U.round(ev.rvol, 2) + '×' : '—') + '</td>' +
        '<td class="num">' + ev.sustain + '</td><td>' + status + '</td>' +
        '<td class="muted" style="white-space:normal">' + U.escapeHtml(ev.reasons.join('; ') || (ev.confirmed ? 'volume + acceptance + sustain' : '')) + '</td></tr>';
    }).join('') || '<tr><td colspan="8" class="muted">No level events in this window.</td></tr>';
    $$('#eventTable tbody tr').forEach(tr => { if (tr.dataset.i) U.on(tr, 'click', () => focusBar(+tr.dataset.i)); });
  }

  function renderQuality(m) {
    const host = $('#qualityNotes');
    const notes = m.quality.slice();
    if (m.series.resolvedFrom) notes.unshift({ lvl: 'info', txt: m.series.resolvedFrom + ' carries no series on this feed; loaded as ' + m.series.symbol + ' instead. That mapping is cached, so later polls ask it directly.' });
    if (m.cfg.requireVolume) notes.push({ lvl: 'info', txt: 'Strict mode ON: unconfirmed breaks are never promoted to signals.' });
    if (S.demo) notes.unshift({ lvl: 'warn', txt: 'Synthetic demo tape — structure logic is real, prices are not.' });
    if (S.manual) notes.unshift({ lvl: 'info', txt: 'Manual OHLCV in use. Live polling is off until a timeline chip is picked.' });
    if (S.replay) notes.unshift({ lvl: 'info', txt: 'Bar replay stops at ' + U.fmtBarTime(m.bars[m.bars.length - 1].t, m.series.granularity, m.series.timezone) + ' — swings, trend labels and the verdict are computed from that truncated tape, i.e. from what was knowable then.' });
    host.innerHTML = notes.map(x => '<li class="' + (x.lvl === 'warn' ? 'warn' : '') + '">' + U.escapeHtml(x.txt) + '</li>').join('') || '<li class="muted">Feed clean.</li>';
  }

  function buildHelpNote() {
    $('#axisNote').innerHTML =
      '<b>Read:</b> filled triangle = close-backed swing (drives the trend label) · hollow = wick-only probe (level, never a trend leg) · ' +
      'filled arrow = volume-confirmed acceptance · outline + <code>?</code> = unconfirmed break, observation only · dashed amber = level under test · ' +
      'dotted grey = VWAP · amber dotted = POC · dashed box = bar still forming. ' +
      '<b>Studies</b> are descriptive: an MA or an oscillator never overrides the structure gate, and warm-up bars are left blank rather than faked. ' +
      'Fibonacci is measured across the two newest confirmed swings. Replay re-runs the whole engine on a truncated tape. ' +
      '<b>Quote tick:</b> the last price is re-read on its own fast clock and repaints the forming bar; the verdict, signals and score only move when the full tape is re-read, so a tick can move the price but never mint a signal. ' +
      '<b>Market row:</b> a chip loads that index\'s own tape, and the same names work typed in the box — NIFTY, SENSEX, BANKNIFTY, SPX — each reaching its series before any scrip guess is tried.';
  }

  /* ------------------------------------------------------------------ misc ui */
  function focusBar(i) {
    SD.Chart.setHover(i);
    S.hoverI = i;
    S.mouseY = undefined;
    draw();
    const m = S.model;
    U.toast('Bar ' + U.fmtBarTime(m.bars[i].t, m.series.granularity, m.series.timezone) + ' · C ' + U.fmtPrice(m.bars[i].c, m.dec) +
      ' · RVOL ' + rvolTxt(rvolAt(m, i)), '', 5000);
  }

  function showVeil(on, txt) {
    $('#loadingVeil').hidden = !on;
    if (on && txt) $('#loadingTxt').textContent = txt;
  }

  function setStatus(t) { $('#statusText').textContent = t; $('#feedText').textContent = 'feed: ' + (S.series ? S.series.via : '—'); }

  function shortErr(e) {
    const m = String(e && e.message || e);
    return m.length > 160 ? m.slice(0, 160) + '…' : m;
  }

  // Indices and thin venues report near-zero volume; '0.00×' reads as a bug, so show it honestly.
  function rvolTxt(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 0.01) return '<0.01×';
    return U.round(v, 2) + '×';
  }

  function exportAs(kind) {
    if (!S.model) return;
    const m = S.model;
    if (kind === 'events-csv') {
      const rows = m.events.map(ev => ({
        symbol: m.series.symbol, interval: m.series.granularity,
        bar_utc: new Date(ev.t).toISOString(), event: eventLabel(ev), side: ev.side,
        level: U.round(ev.level, 6), close: U.round(ev.price, 6),
        rvol: isFinite(ev.rvol) ? U.round(ev.rvol, 3) : '', sustain: ev.sustain,
        confirmed: ev.confirmed ? 'YES' : 'no', reasons: ev.reasons.join(' | ')
      }));
      if (!rows.length) { U.toast('No events to export.', 'warn'); return; }
      U.download(m.series.symbol.replace(/[^\w.]/g, '-') + '_events.csv', U.toCsv(rows), 'text/csv');
    } else {
      const snap = {
        generated_utc: new Date().toISOString(),
        symbol: m.series.symbol, exchange: m.series.exchange, currency: m.series.currency,
        timezone: m.series.timezone, interval: m.series.granularity, timeline: S.timeline.label,
        bars: m.bars.length, settings: S.cfg,
        structure: {
          state: m.structure.state, title: m.structure.title, bullScore: m.structure.bullScore,
          lastConfirmedHigh: m.structure.lastHigh ? { price: m.structure.lastHigh.price, bar_utc: new Date(m.structure.lastHigh.t).toISOString() } : null,
          lastConfirmedLow: m.structure.lastLow ? { price: m.structure.lastLow.price, bar_utc: new Date(m.structure.lastLow.t).toISOString() } : null,
          trendlines: {
            highs: m.trend.high ? trendOut(m.trend.high) : null,
            lows: m.trend.low ? trendOut(m.trend.low) : null
          },
          divergence: m.divergence
        },
        signals: m.signals.map(s => ({ bar_utc: new Date(s.t).toISOString(), dir: s.dir, level: s.level, entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2, rvol: s.rvol, rr: s.rr })),
        unconfirmed: m.watch.map(e => ({ bar_utc: new Date(e.t).toISOString(), dir: e.dir, level: e.level, reasons: e.reasons })),
        readouts: m.readouts
      };
      U.download(m.series.symbol.replace(/[^\w.]/g, '-') + '_structure.json', JSON.stringify(snap, null, 2), 'application/json');
    }
    U.toast('Export written.', 'ok');

    function trendOut(t) {
      return {
        side: t.side, anchors: t.anchors, r2: U.round(t.fit, 3),
        slope_price_per_bar: U.round(t.slope, 6),
        slope_atr_per_bar: isFinite(t.slopeAtr) ? U.round(t.slopeAtr, 4) : null,
        value_at_last_bar: U.round(t.atLast, 6)
      };
    }
  }

  function copyTable(kind) {
    const table = kind === 'swings' ? $('#swingTable') : $('#eventTable');
    const txt = Array.from(table.querySelectorAll('tr')).map(tr =>
      Array.from(tr.children).map(td => td.textContent.trim()).join('\t')
    ).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(() => U.toast('Copied to clipboard.', 'ok'), () => U.toast('Clipboard blocked by the browser.', 'err'));
    } else {
      U.toast('Clipboard API unavailable over file://.', 'warn');
    }
  }

  return boot;
})();
