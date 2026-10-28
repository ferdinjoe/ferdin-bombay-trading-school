/* Structure Desk — Watch view: one list per market, each ticker's chart painted one below the other.
   Reuses the Desk's engine settings, chart options and relay configuration, so a row reads
   exactly the way the same symbol would read on the single-symbol tab. */
SD.Watch = (function () {
  'use strict';

  const U = SD.U;
  const $ = U.$, $$ = U.$$;
  const CUR_SYM = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥', CHF: 'CHF', SGD: 'S$', AUD: 'A$', MYR: 'RM' };

  /* Every seed below was answered by the live feed on 2026-10-26 — ^STI.SI, C31.SI, C6S.SI and
     A17F.SI were not, so they do not appear here. A basket that opens on 404s teaches nothing. */
  const MARKETS = [
    { id: 'US', name: 'United States', hint: 'NYSE / Nasdaq',
      seed: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'SPY', 'QQQ', '^GSPC', '^IXIC'] },
    { id: 'IN', name: 'India', hint: 'NSE / BSE',
      seed: ['^NSEI', '^BSESN', 'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'CROPSTER'] },
    { id: 'SG', name: 'Singapore', hint: 'SGX',
      seed: ['^STI', 'D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'S63.SI'] }
  ];
  const POOL = 2;              // two in-flight requests: relays throttle harder in parallel
  const SEEN_MS = 4000;
  const RANK = { '1d': 1, '5d': 2, '1mo': 3, '3mo': 4, '6mo': 5, '1y': 6, '5y': 7 };
  const RANGE_FOR = { '1m': '1d', '5m': '5d', '15m': '5d', '60m': '1mo', '1d': '6mo', '1wk': '1y', '1mo': '5y' };

  let api = null;              // bridge to the desk, wired in ui.js boot()
  let book = {};               // market id -> { rows: [row] }  (rows survive a basket switch detached)
  let rows = [];               // the open basket's array — same reference, so all mutators stay local
  let timer = null;
  let active = false;
  let busy = false;
  let clearArmed = 0;
  // Eight names on 5-minute bars is eight requests every tick; a stack is for scanning, so it
  // defaults to the daily read and leaves intraday to the single-symbol Desk.
  const state = { basket: 'US', interval: '1d', range: '6mo', auto: true };

  /* ------------------------------------------------------------------ boot */
  function init(bridge) {
    api = bridge;
    const saved = U.store.get('watchlist', null);
    if (saved && saved.baskets) {
      if (MARKETS.some(m => m.id === saved.basket)) state.basket = saved.basket;
      state.interval = saved.interval || state.interval;
      state.range = saved.range || state.range;
      state.auto = saved.auto !== false;
    }
    const want = RANGE_FOR[state.interval];
    if (want && RANK[state.range] < RANK[want]) state.range = want;
    $('#watchInterval').value = state.interval;
    $('#watchRange').value = state.range;
    $('#watchAuto').checked = state.auto;

    book = {};
    MARKETS.forEach(m => {
      book[m.id] = { rows: [] };
      const list = saved && saved.baskets && Array.isArray(saved.baskets[m.id]) ? saved.baskets[m.id] : m.seed;
      rows = book[m.id].rows;
      list.forEach(k => appendRow(k, true, m.id));
    });
    rows = book[state.basket].rows;
    buildChips();
    bind();
    save();
    mount();
    // Rows stay unrequested until the tab is actually opened — boot must not spend the relay budget.
  }

  function market(id) { return MARKETS.filter(m => m.id === id)[0]; }

  function buildChips() {
    const host = $('#watchMarkets');
    host.innerHTML = '';
    MARKETS.forEach(m => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wm-btn';
      b.dataset.basket = m.id;
      b.title = m.hint + ' — ' + m.seed.length + ' seeded names';
      b.setAttribute('role', 'tab');
      b.innerHTML = U.escapeHtml(m.name) + '<span class="wm-n"></span>';
      U.on(b, 'click', () => setBasket(m.id));
      host.appendChild(b);
    });
  }

  /* Swapping lists detaches the old rows rather than discarding them: their series and canvas
     stay warm, so returning to a basket repaints instantly instead of re-requesting. */
  function setBasket(id) {
    if (!book[id] || id === state.basket) return;
    stopPoll();
    rows = book[id].rows;
    state.basket = id;
    save();
    mount();
    paintAll();
    if (active) { if (!rows.some(r => r.series)) refreshAll(); else startPoll(); }
  }

  function mount() {
    const host = $('#watchStack');
    host.textContent = '';
    rows.forEach(r => host.appendChild(r.el));
    $('#watchEmpty').hidden = rows.length > 0;
    syncChips();
  }

  function syncChips() {
    $$('#watchMarkets .wm-btn').forEach(b => {
      const on = b.dataset.basket === state.basket;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      $('.wm-n', b).textContent = book[b.dataset.basket].rows.length;
    });
    const n = $('#watchTabCount');
    if (n) n.textContent = rows.length;
    // The Scan badge counts the whole book, not the open list — that is what a scan ranks.
    const sc = $('#scanTabCount');
    if (sc) sc.textContent = MARKETS.reduce((a, m) => a + (book[m.id] ? book[m.id].rows.length : 0), 0);
  }

  function bind() {
    U.on($('#watchForm'), 'submit', e => {
      e.preventDefault();
      add($('#watchInput').value);
      $('#watchInput').value = '';
    });
    // A picked ticker is appended, not submitted: this box takes a whole list in one go.
    SD.Tickers.attach($('#watchInput'), {
      cfg: () => api.fetchCfg(),
      tokens: true,                                   // space-separated batches are valid input here
      onPick: (it, input) => {
        const parts = String(input.value).split(/[,;\s]+/).filter(Boolean);
        const last = (parts[parts.length - 1] || '').toUpperCase();
        /* The half-typed fragment is what the pick was reaching for, so it is replaced — leaving it
           behind would submit a ticker that does not exist. */
        if (last && (SD.Tickers.leafOf(it.symbol).indexOf(last) === 0 || it.symbol.indexOf(last) === 0)) parts.pop();
        parts.push(it.symbol);
        input.value = parts.join(', ') + ' ';
        input.focus();
      }
    });
    U.on($('#watchInterval'), 'change', e => {
      state.interval = e.target.value;
      // A 1-day bar inside a 5-day window is five candles — no structure fits in that.
      const want = RANGE_FOR[state.interval];
      if (want && RANK[state.range] < RANK[want]) {
        state.range = want;
        $('#watchRange').value = want;
        U.toast('Window widened to ' + want + ' so ' + state.interval + ' bars have enough history.', '', 6000);
      }
      save(); refreshAll();
    });
    U.on($('#watchRange'), 'change', e => { state.range = e.target.value; save(); refreshAll(); });
    U.on($('#watchAuto'), 'change', e => { state.auto = e.target.checked; save(); state.auto ? startPoll() : stopPoll(); });
    U.on($('#watchRefresh'), 'click', () => refreshAll());
    U.on($('#watchClear'), 'click', clearList);

    // Rows live and die on the stack's width, not the window's.
    if (window.ResizeObserver) {
      let raf = 0;
      new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; paintAll(); });
      }).observe($('#watchStack'));
    }
  }

  function save() {
    const baskets = {};
    MARKETS.forEach(m => { baskets[m.id] = book[m.id].rows.map(r => r.key); });
    U.store.set('watchlist', { baskets: baskets, basket: state.basket, interval: state.interval, range: state.range, auto: state.auto });
    syncChips();
  }

  /* ------------------------------------------------------------------ rows */
  function appendRow(key, silent, basketId) {
    const tpl = document.createElement('template');
    tpl.innerHTML =
      '<section class="wl-row">' +
      '<header class="wl-head">' +
      '<button class="wl-key" type="button" title="Open this symbol on the Desk tab"></button>' +
      '<span class="wl-name"></span>' +
      '<span class="wl-venue"></span><span class="grow"></span>' +
      '<span class="wl-price">—</span><span class="wl-chg"></span><span class="wl-rvol"></span>' +
      '<span class="wl-verdict"></span><span class="wl-sigs"></span><span class="wl-time"></span>' +
      '<span class="wl-tools">' +
      '<button class="ghost-btn sm wl-up" type="button" title="Move up">↑</button>' +
      '<button class="ghost-btn sm wl-dn" type="button" title="Move down">↓</button>' +
      '<button class="ghost-btn sm wl-re" type="button" title="Reload this row">↻</button>' +
      '<button class="ghost-btn sm wl-open" type="button" title="Open on the Desk tab">Desk</button>' +
      '<button class="ghost-btn sm wl-del" type="button" title="Remove">✕</button>' +
      '</span></header>' +
      '<div class="wl-chart"><canvas></canvas></div>' +
      '<div class="wl-note"></div></section>';
    const el = tpl.content.firstElementChild;
    const row = { key, el, basket: basketId || state.basket, canvas: $('.wl-chart canvas', el), chart: null, series: null, model: null, error: '', loading: false, seen: null };
    row.chart = SD.Chart.make(row.canvas);
    el.dataset.key = key;
    $('.wl-key', el).textContent = key;
    // Named the moment the row exists: a row whose tape fails still has to say what it was meant to be.
    $('.wl-name', el).textContent = SD.Tickers.nameOf(key);
    setNote(row, 'queued — ' + state.interval + ' · ' + state.range);

    U.on($('.wl-key', el), 'click', () => openInDesk(row));
    U.on($('.wl-open', el), 'click', () => openInDesk(row));
    U.on($('.wl-del', el), 'click', () => remove(row));
    U.on($('.wl-re', el), 'click', () => loadRow(row));
    U.on($('.wl-up', el), 'click', () => move(row, -1));
    U.on($('.wl-dn', el), 'click', () => move(row, 1));

    rows.push(row);
    $('#watchStack').appendChild(el);
    $('#watchEmpty').hidden = rows.length > 0;
    if (!silent) save();
    return row;
  }

  function add(raw) {
    const parts = String(raw || '').split(/[\s,;]+/).filter(Boolean);
    let added = 0, dupe = 0;
    parts.forEach(p => {
      const norm = SD.Data.normaliseSymbol(p);
      if (!norm) return;
      if (rows.some(r => r.key === norm)) { dupe++; return; }
      /* The directory only takes listings the desk can actually name: a token the user guessed would
         otherwise come back as a suggestion carrying an exchange nobody proved. The row is loaded
         below, and a tape read that resolves files it properly. */
      const known = SD.Data.cachedResolution(norm);
      if (known) SD.Tickers.remember({ s: known, hit: true });
      const row = appendRow(norm);
      added++;
      loadRow(row);
    });
    if (!added) U.toast(dupe ? 'Already on this list.' : 'Nothing readable to add.', 'warn');
    save();
    startPoll();
    return added;
  }

  function remove(row) {
    const i = rows.indexOf(row);
    if (i < 0) return;
    rows.splice(i, 1);
    row.el.parentNode && row.el.parentNode.removeChild(row.el);
    $('#watchEmpty').hidden = rows.length > 0;
    save();
  }

  function move(row, delta) {
    const i = rows.indexOf(row), j = i + delta;
    if (j < 0 || j >= rows.length) return;
    rows.splice(i, 1); rows.splice(j, 0, row);
    const host = $('#watchStack');
    host.appendChild(row.el);                       // rebuild order from the array
    rows.forEach(r => host.appendChild(r.el));
    save();
  }

  function clearList() {
    if (!rows.length) return;
    if (!clearArmed) {
      clearArmed = Date.now();
      $('#watchClear').textContent = 'Press again to clear';
      setTimeout(() => {
        if (Date.now() - clearArmed >= SEEN_MS - 200) { clearArmed = 0; $('#watchClear').textContent = 'Clear list'; }
      }, SEEN_MS);
      return;
    }
    clearArmed = 0;
    $('#watchClear').textContent = 'Clear list';
    rows.slice().forEach(remove);
    save();
    U.toast(market(state.basket).name + ' list cleared — the other two are untouched.', 'ok');
  }

  function openInDesk(row) {
    if (api.openSymbol) api.openSymbol(row.key);
  }

  /* ------------------------------------------------------------------ loading */
  function specFor(key) {
    return { symbol: key, interval: state.interval, range: state.range, prePost: api.cfg().prePost };
  }

  /* Ownership is per basket, not per open list: the Scan tab fills rows that are detached from the
     stack, and a reply for a name the user deleted mid-flight must still be dropped. */
  function owned(row) {
    const b = book[row.basket];
    return !!b && b.rows.indexOf(row) >= 0;
  }

  async function loadRow(row) {
    if (row.loading) return false;
    row.loading = true;
    row.el.className = 'wl-row is-busy';
    if (!row.series) setNote(row, 'requesting ' + row.key + ' · ' + state.interval + ' · ' + state.range);
    try {
      const series = await SD.Data.fetchSeries(specFor(row.key), api.fetchCfg());
      if (!owned(row)) return false;                            // removed while in flight
      row.series = series;
      row.spec = state.interval + '|' + state.range;      // which bar size this tape actually is
      row.model = SD.Analysis.run(series, api.cfg());
      row.error = '';
      paintRow(row);
      announce(row);
      return true;
    } catch (e) {
      if (!owned(row)) return false;
      row.error = shortErr(e);
      row.el.className = 'wl-row is-err';
      setNote(row, row.error);
      return false;
    } finally {
      row.loading = false;
    }
  }

  async function refreshAll(o) {
    o = o || {};
    if (busy) return;
    const queue = rows.slice();
    if (!queue.length) { setStatus('Nothing to refresh.'); return; }
    busy = true;
    const name = market(state.basket).name;
    setStatus('refreshing ' + name + ' · ' + queue.length + ' row(s)…');
    const r = await pump(queue);
    busy = false;
    setStatus(name + ' · ' + r.ok + ' loaded · ' + r.bad + ' failed · ' + U.fmtClock(Date.now(), 'UTC') + 'Z');
    // A silent background poll must not nag; an intentional load announces a failure once.
    if (r.bad && o.poll !== true) U.toast(r.bad + ' of ' + (r.ok + r.bad) + ' rows failed — the reason is printed on each row.', 'warn', 7000);
  }

  /* Two in-flight requests at a time, whatever the queue. Progress is reported per row so a
     21-name scan can paint itself as it fills rather than appearing all at once. */
  async function pump(queue, o) {
    o = o || {};
    let ok = 0, bad = 0, done = 0;
    const total = queue.length;
    const workers = [];
    for (let i = 0; i < Math.min(POOL, total); i++) {
      workers.push((async () => {
        while (queue.length) {
          const row = queue.shift();
          if (await loadRow(row)) ok++; else bad++;
          done++;
          if (o.onRow) o.onRow(row, done, total);
        }
      })());
    }
    await Promise.all(workers);
    return { ok, bad, total };
  }

  /* ------------------------------------------------------------------ scan feed */
  /* Every basket in the book, open or not. The Scan tab reads this and drives scanAll() below;
     rows are shared objects, so a name fetched for the scan is already warm when its list is
     opened on the Watch tab, and the other way round. */
  function lists() {
    return MARKETS.map(m => ({ id: m.id, name: m.name, hint: m.hint, rows: book[m.id] ? book[m.id].rows : [] }));
  }

  async function scanAll(o) {
    o = o || {};
    if (busy) return null;
    const queue = [];
    const want = state.interval + '|' + state.range;
    MARKETS.forEach(m => {
      const b = book[m.id];
      if (!b) return;
      // A tape fetched under a different bar size is not the same book — re-read it, don't rank it.
      b.rows.forEach(r => { if (o.force || !r.series || r.spec !== want) queue.push(r); });
    });
    if (!queue.length) { o.onDone && o.onDone({ ok: 0, bad: 0, total: 0 }); return { ok: 0, bad: 0, total: 0 }; }
    busy = true;
    const r = await pump(queue, o);
    busy = false;
    if (o.onDone) o.onDone(r);
    return r;
  }

  /* How many names the book holds versus how many already carry a tape. */
  function scanProgress() {
    let all = 0, ready = 0;
    MARKETS.forEach(m => (book[m.id] ? book[m.id].rows : []).forEach(r => { all++; if (r.model) ready++; }));
    return { all, ready, busy };
  }

  /* Six names read at once is a scan, not a stare — a row that newly confirms a break has to
     say so. The first pass only seeds the baseline, so loading a list never fires a wall of toasts. */
  function announce(row) {
    const cur = {};
    row.model.signals.forEach(s => { cur[s.t + '|' + s.dir + '|' + U.round(s.level, 4)] = s; });
    const prev = row.seen;
    row.seen = cur;
    if (!prev || !active) return;
    const fresh = Object.keys(cur).filter(k => !prev[k]);
    fresh.slice(0, 3).forEach(k => {
      const s = cur[k];
      U.toast(row.key + ' · ' + (s.dir === 'up' ? 'confirmed breakout' : 'confirmed breakdown') + ' @ ' +
        U.fmtPrice(s.level, row.model.dec) + ' · RVOL ' + rvolTxt(s.rvol), s.dir === 'up' ? 'ok' : 'err', 9000);
    });
    if (fresh.length > 3) U.toast(row.key + ' · ' + (fresh.length - 3) + ' more confirmed breaks on this symbol.', '', 7000);
  }

  function startPoll() {
    stopPoll();
    if (!state.auto || !active) return;
    const ms = Math.max(5, api.cfg().poll || 20) * 1000;
    timer = setInterval(() => {
      if (busy || document.hidden || !active) return;
      refreshAll({ poll: true });
    }, ms);
  }
  function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

  function activate() {
    active = true;
    paintAll();
    if (!rows.some(r => r.series)) refreshAll();
    // Starting the loop is separate from the first load: skipping it left the tab static forever.
    startPoll();
  }
  function deactivate() { active = false; stopPoll(); }

  /* ------------------------------------------------------------------ painting */
  function paintRow(row) {
    const m = row.model, s = row.series, el = row.el;
    if (!m) return;
    el.className = 'wl-row' + (s.resolvedFrom ? ' is-matched' : '');
    const cur = CUR_SYM[s.currency] || (s.currency + ' ');
    const base = s.prevClose && s.prevClose > 0 ? s.prevClose : m.bars[Math.max(0, m.bars.length - 2)].c;
    const pct = base ? 100 * (m.last.c - base) / base : 0;

    $('.wl-key', el).textContent = s.resolvedFrom ? s.resolvedFrom : s.symbol;
    $('.wl-key', el).title = 'Open ' + s.symbol + ' on the Desk tab';
    const nm = SD.Tickers.nameOf(s.symbol) || SD.Tickers.nameOf(row.key);
    if (nm) $('.wl-name', el).textContent = nm;
    $('.wl-venue', el).innerHTML = U.escapeHtml(s.symbol === s.resolvedFrom ? '' : s.symbol) +
      '<span class="muted"> · ' + U.escapeHtml(s.exchange || '') + ' · ' + U.escapeHtml(s.currency) + '</span>';
    $('.wl-price', el).textContent = cur + U.fmtPrice(m.last.c, m.dec);
    const chg = $('.wl-chg', el);
    chg.textContent = U.fmtPct(pct);
    chg.className = 'wl-chg ' + (pct >= 0 ? 'pos' : 'neg');

    const noVol = m.bars.every(b => !(b.v > 0));
    $('.wl-rvol', el).textContent = noVol ? 'no volume series' : 'RVOL ' + rvolTxt(m.volume.rvol);

    const st = m.structure;
    const tone = st.tone === 'bull' ? 'up' : st.tone === 'bear' ? 'down' : st.tone === 'range' ? 'warn' : 'flat';
    $('.wl-verdict', el).innerHTML = '<span class="pill ' + tone + '">' + U.escapeHtml(shortTitle(st.title)) + '</span>' +
      (isFinite(st.bullScore) ? '<span class="muted wl-score">' + st.bullScore + '/100</span>' : '');

    const confirmed = m.signals.length;
    $('.wl-sigs', el).innerHTML = confirmed
      ? '<span class="pill ' + (m.signals[0].dir === 'up' ? 'up' : 'down') + '">' + confirmed + ' signal' + (confirmed > 1 ? 's' : '') + '</span>'
      : '<span class="pill flat">no signal</span>';
    $('.wl-time', el).textContent = s.bars.length + ' bars · ' + s.granularity + ' · via ' + (s.via || '—');

    const res = st.resistance, sup = st.support;
    let note = (res ? 'resistance ' + U.fmtPrice(res.price, m.dec) : 'no overhead swing') +
      '  ·  ' + (sup ? 'support ' + U.fmtPrice(sup.price, m.dec) : 'no floor swing');
    if (noVol) note += '  ·  nothing here can be volume-confirmed, so no break is tradeable';
    else if (m.trend.resistanceBroken) note += '  ·  resistance trendline broken this bar';
    else if (m.trend.supportBroken) note += '  ·  support trendline broken this bar';
    if (s.bars.length < 40) note += '  ·  only ' + s.bars.length + ' bars in this window — widen it before trusting the read';
    setNote(row, note);

    chartForRow(row);
  }

  function shortTitle(t) {
    return String(t || 'no read').replace('Structure · ', '').replace(/\s·\s.*/, '');
  }

  function chartForRow(row) {
    const cv = row.canvas;
    if (!cv.clientWidth || !cv.clientHeight) return;      // hidden view: nothing to measure yet
    const sel = api.studySel ? api.studySel() : [];
    row.chart.render(row.model, Object.assign({}, api.chartOpts(), {
      tz: row.series.timezone, interval: row.series.granularity,
      live: true, vwap: true, poc: true, events: false,
      // Overlays carry over from the Desk; a sub-pane would squeeze a 230px row, so the renderer
      // drops any pane it cannot fit and no row has to know about the cap.
      studies: SD.Ind.studies(row.model, sel)
    }));
  }

  function paintAll() { rows.forEach(r => { if (r.model) paintRow(r); }); }

  // Engine settings changed on the Desk tab: recompute from the cached series, no new requests.
  // Every basket is recomputed, not just the open one, because the Scan tab reads closed lists too.
  function reload() {
    if (!api) return;
    MARKETS.forEach(m => {
      const b = book[m.id];
      if (!b) return;
      b.rows.forEach(r => {
        if (!r.series) return;
        r.model = SD.Analysis.run(r.series, api.cfg());
        if (r.basket === state.basket) paintRow(r);
      });
    });
  }

  function setNote(row, txt) { const n = $('.wl-note', row.el); if (n) n.textContent = txt; }

  function rvolTxt(v) {
    if (!isFinite(v) || v <= 0) return '—';
    if (v < 0.01) return '<0.01×';
    return U.round(v, 2) + '×';
  }

  function shortErr(e) {
    const m = String(e && e.message || e);
    return m.length > 220 ? m.slice(0, 220) + '…' : m;
  }

  function setStatus(t) {
    const el = $('#watchStatus');
    if (el) el.textContent = t;
  }

  /* One bar size and window for both views. A stack and a scan that disagreed about the interval
     would be two different books, and every name would have to be fetched twice. */
  function setSpec(o) {
    if (!o || !o.interval) return false;
    const want = RANGE_FOR[o.interval];
    const range = o.range && (!want || RANK[o.range] >= RANK[want]) ? o.range : want;
    if (state.interval === o.interval && (!range || state.range === range)) return false;
    state.interval = o.interval;
    if (range) state.range = range;
    $('#watchInterval').value = state.interval;
    $('#watchRange').value = state.range;
    // The Scan tab mirrors these two selects; a stale mirror would promise bars the rows don't hold.
    if ($('#scanInterval')) $('#scanInterval').value = state.interval;
    if ($('#scanRange')) $('#scanRange').value = state.range;
    save();
    return true;
  }

  function spec() { return { interval: state.interval, range: state.range, basket: state.basket }; }

  return { init, add, activate, deactivate, refreshAll, reload, stopPoll, startPoll, lists, scanAll, scanProgress, spec, setSpec };
})();
