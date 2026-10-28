/* Structure Desk — Books view: the fundamentals half of the desk, modelled on Screener.in.
   A book is one request per company (Yahoo's fundamentals-timeseries carries annual, quarterly and
   trailing magnitudes in the same reply), so a twenty-name universe costs twenty requests, not sixty.
   Nothing here fills a gap with a guess: a statement line the free feed does not carry prints "—"
   until the user types it into the manual panel, and the source list on the card says which is which. */
SD.Books = (function () {
  'use strict';

  const U = SD.U;
  const $ = U.$, $$ = U.$$;
  const F = SD.Fund;

  const CUR_SYM = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥', SGD: 'S$', AUD: 'A$', MYR: 'RM', HKD: 'HK$' };

  /* Statement tables. kind: money = divided by the currency's reading unit, pct, per = per-share
     native, x = a bare multiple. `f` derives a line the feed does not publish but the published
     lines fully determine. */
  const SEGMENTS = {
    pl: {
      cols: 'years',
      note: 'One column per fiscal year, oldest first — the same order Screener prints.',
      rows: [
        { t: 'Sales', k: 'sales', kind: 'money' },
        { t: 'Expenses', k: 'expenses', kind: 'money' },
        { t: 'Operating profit', k: 'opProfit', kind: 'money' },
        { t: 'OPM %', k: 'opmPct', kind: 'pct' },
        { t: 'Other income', k: 'otherIncome', kind: 'money' },
        { t: 'Interest', k: 'interest', kind: 'money' },
        { t: 'Depreciation', k: 'depreciation', kind: 'money' },
        { t: 'Profit before tax', k: 'pretax', kind: 'money' },
        { t: 'Tax', kind: 'money', f: r => (r.pretax != null && r.netProfit != null ? r.pretax - r.netProfit : null) },
        { t: 'Tax %', k: 'taxPct', kind: 'pct' },
        { t: 'Net profit', k: 'netProfit', kind: 'money' },
        { t: 'EPS', k: 'eps', kind: 'per' },
        { t: 'Dividend per share', k: 'divPs', kind: 'per' },
        { t: 'Dividend payout %', kind: 'pct', f: r => (r.divPs != null && r.eps > 0 ? 100 * r.divPs / r.eps : null) }
      ]
    },
    bs: {
      cols: 'years',
      note: 'Balance sheet. Gross block and trade loans are not in the free feed, so they are absent rather than estimated.',
      rows: [
        { t: 'Total assets', k: 'totalAssets', kind: 'money' },
        { t: 'Current assets', k: 'currentAssets', kind: 'money' },
        { t: 'Inventory', k: 'inventory', kind: 'money' },
        { t: 'Receivables', k: 'receivables', kind: 'money' },
        { t: 'Cash and equivalents', k: 'cash', kind: 'money' },
        { t: 'Goodwill', k: 'goodwill', kind: 'money' },
        { t: 'Current liabilities', k: 'currentLiabilities', kind: 'money' },
        { t: 'Borrowings', k: 'debt', kind: 'money' },
        { t: 'Long-term debt', k: 'ltDebt', kind: 'money' },
        { t: 'Other liabilities', kind: 'money', f: r => (r.totalLiabilities != null && r.equity != null && r.debt != null ? r.totalLiabilities - r.equity - r.debt : null) },
        { t: 'Total liabilities', k: 'totalLiabilities', kind: 'money' },
        { t: 'Capital stock', k: 'capitalStock', kind: 'money' },
        { t: 'Reserves and surplus', kind: 'money', f: r => (r.equity != null && r.capitalStock != null ? r.equity - r.capitalStock : r.equity) },
        { t: 'Net worth', k: 'equity', kind: 'money' },
        { t: 'Minority interest', k: 'minority', kind: 'money' },
        { t: 'Working capital', kind: 'money', f: r => (r.currentAssets != null && r.currentLiabilities != null ? r.currentAssets - r.currentLiabilities : null) },
        { t: 'Capital employed', k: 'capitalEmployed', kind: 'money' }
      ]
    },
    cf: {
      cols: 'years',
      note: 'Cash flow. Free cash flow is operating cash flow after capex; the figure the feed itself publishes wins when it has one.',
      rows: [
        { t: 'Operating cash flow', k: 'ocf', kind: 'money' },
        { t: 'Capital expenditure', k: 'capex', kind: 'money' },
        { t: 'Free cash flow', k: 'freeCashFlow', kind: 'money' },
        { t: 'Investing cash flow', k: 'icf', kind: 'money' },
        { t: 'Financing cash flow', k: 'financingCash', kind: 'money' },
        { t: 'Cash dividends paid', k: 'dividends', kind: 'money' },
        { t: 'Change in cash', k: 'changeInCash', kind: 'money' },
        { t: 'OCF per share', k: 'ocfPs', kind: 'per' },
        { t: 'FCF as % of sales', kind: 'pct', f: r => (r.freeCashFlow != null && r.sales > 0 ? 100 * r.freeCashFlow / r.sales : null) },
        { t: 'Cash conversion (OCF / net profit)', kind: 'x', f: r => (r.ocf != null && r.netProfit > 0 ? r.ocf / r.netProfit : null) }
      ]
    },
    q: {
      cols: 'quarters',
      note: 'The last five reported quarters. A quarter is a three-month statement, not a rate — compare it to the same quarter last year.',
      rows: [
        { t: 'Sales', k: 'sales', kind: 'money' },
        { t: 'Expenses', k: 'expenses', kind: 'money' },
        { t: 'Operating profit', k: 'opProfit', kind: 'money' },
        { t: 'OPM %', k: 'opmPct', kind: 'pct' },
        { t: 'Net profit', k: 'netProfit', kind: 'money' },
        { t: 'NPM %', k: 'npmPct', kind: 'pct' },
        { t: 'Diluted EPS', k: 'eps', kind: 'per' }
      ]
    },
    ra: {
      cols: 'years',
      note: 'Ratios, all computed here from the statement lines above — no ratio is taken from a third-party quote.',
      rows: [
        { t: 'Gross margin %', k: 'gmPct', kind: 'pct' },
        { t: 'Operating margin %', k: 'opmPct', kind: 'pct' },
        { t: 'Net margin %', k: 'npmPct', kind: 'pct' },
        { t: 'ROE %', k: 'roePct', kind: 'pct' },
        { t: 'ROCE %', k: 'rocePct', kind: 'pct' },
        { t: 'Tax %', k: 'taxPct', kind: 'pct' },
        { t: 'Debt to equity', k: 'debtToEquity', kind: 'x' },
        { t: 'Current ratio', k: 'currentRatio', kind: 'x' },
        { t: 'Interest coverage', k: 'interestCover', kind: 'x' },
        { t: 'Book value per share', k: 'bookValuePs', kind: 'per' },
        { t: 'Dividend per share', k: 'divPs', kind: 'per' },
        { t: 'Sales growth %', kind: 'pct', series: true, prev: 'sales' },
        { t: 'Profit growth %', kind: 'pct', series: true, prev: 'netProfit' },
        { t: 'Net worth growth %', kind: 'pct', series: true, prev: 'equity' }
      ]
    }
  };

  /* The Screener key-metrics box, in its own order. `src` says where the number came from so the
     card can be honest about derived and manual figures. */
  const METRICS = [
    { t: 'Mkt Cap', k: 'mcap', src: 'feed', money: true },
    { t: 'Current Price', k: 'price', src: 'quote', per: true },
    { t: '52W High', k: 'high52', src: 'quote', per: true },
    { t: '52W Low', k: 'low52', src: 'quote', per: true },
    { t: 'Stock P/E', k: 'pe', src: 'calc', x: true },
    { t: 'P / BV', k: 'pbv', src: 'calc', x: true },
    { t: 'Book Value', k: 'bookValue', src: 'calc', per: true },
    { t: 'Dividend Yield', k: 'divYield', src: 'calc', pct: true },
    { t: 'ROCE', k: 'roce', src: 'calc', pct: true },
    { t: 'ROE', k: 'roe', src: 'calc', pct: true },
    { t: 'Face Value', k: 'faceValue', src: 'manual', per: true },
    { t: 'Premium %', k: 'premium', src: 'manual', x: true },
    { t: 'Promoter', k: 'promoterHolding', src: 'manual', pct: true },
    { t: 'Pledged', k: 'pledgedPct', src: 'manual', pct: true },
    { t: 'Debt', k: 'debtCr', src: 'feed', cr: true },
    { t: 'Net worth', k: 'networthCr', src: 'feed', cr: true },
    { t: 'Sales', k: 'salesCr', src: 'feed', cr: true },
    { t: 'Profit', k: 'profitCr', src: 'feed', cr: true },
    { t: 'Free cash flow', k: 'fcfCr', src: 'feed', cr: true },
    { t: 'EPS', k: 'eps', src: 'feed', per: true },
    { t: 'No. of Shares', k: 'sharesCr', src: 'feed', cr: true },
    { t: 'Ent. Value', k: 'ev', src: 'feed', money: true }
  ];

  const MANUAL_FIELDS = [
    { k: 'faceValue', t: 'Face value', ph: 'e.g. 10' },
    { k: 'promoter', t: 'Promoter holding %', ph: 'e.g. 50.31' },
    { k: 'pledged', t: 'Pledged % of promoter', ph: 'e.g. 0' },
    { k: 'pe', t: 'Stock P/E override', ph: 'only if the computed one is wrong' },
    { k: 'mcap', t: 'Market cap override (Cr)', ph: 'only if the feed is stale' }
  ];

  const SRC_LABEL = { feed: 'from the feed', calc: 'computed here', quote: 'from the price tape', manual: 'typed by you' };

  let api = null;
  let books = {};              // symKey -> book
  let order = [];              // load order, drives the company tabs
  let current = null;          // symKey of the open book
  let busy = false;
  let lastRows = [];           // last screener result, kept for CSV
  let st = { scope: 'ALL', seg: 'pl', hideEmpty: true, sort: 'marketCap', dir: -1 };

  function init(bridge) {
    api = bridge;
    const saved = U.store.get('books', {});
    ['scope', 'seg', 'sort'].forEach(k => { if (saved[k]) st[k] = saved[k]; });
    st.dir = saved.dir === 1 ? 1 : -1;
    st.hideEmpty = saved.hideEmpty !== false;
    bind();
    paintPresets();
    paintSaved();
    paintFields();
    $('#bkHideEmpty').checked = st.hideEmpty;
  }

  function save() { U.store.set('books', { scope: st.scope, seg: st.seg, sort: st.sort, dir: st.dir, hideEmpty: st.hideEmpty }); }

  /* ------------------------------------------------------------------ the universe */
  /* Names come from the watch book, because that is the set the user actually follows. A screen
     over four thousand unloved tickers would need a data licence, not a free relay. */
  function universe() {
    const out = [];
    SD.Watch.lists().forEach(list => {
      if (st.scope !== 'ALL' && list.name !== listName(st.scope)) return;
      list.rows.forEach(r => { if (out.indexOf(r.key) < 0) out.push(r.key); });
    });
    return out;
  }
  function listName(id) {
    return ({ US: 'United States', IN: 'India', SG: 'Singapore' })[id] || id;
  }

  /* A cached tape prices the book without spending a request on it. */
  function quoteFor(key) {
    let found = null;
    SD.Watch.lists().forEach(l => l.rows.forEach(r => { if (!found && r.key === key && r.series) found = r.series; }));
    return found ? quoteFromSeries(found) : null;
  }

  function quoteFromSeries(series) {
    const meta = series.meta || {};
    let hi = meta.fiftyTwoWeekHigh, lo = meta.fiftyTwoWeekLow;
    if (hi == null || lo == null) {                       // derive from the window the tape actually holds
      const highs = series.bars.map(b => b.h), lows = series.bars.map(b => b.l);
      if (hi == null) hi = Math.max.apply(null, highs);
      if (lo == null) lo = Math.min.apply(null, lows);
    }
    /* chartPreviousClose on a one-year window is the close a year ago, which would print a whole
       year of move as the day change. On a daily tape the bar before the forming one is yesterday. */
    const bars = series.bars;
    const longWindow = series.granularity === '1d' && bars.length > 6;
    const prev = longWindow && bars.length > 1 ? bars[bars.length - 2].c : series.prevClose;
    return {
      price: series.lastPrice, prevClose: prev,
      high52: hi, low52: lo, currency: series.currency
    };
  }

  /* A book read before the Watch stack ran has no tape to borrow a price from. That is one chart
     request for the company on screen, never one per book: the screener ranks on market cap, which
     the statements already carry, so nothing here waits on a quote. */
  async function ensureQuote(key) {
    const book = books[key];
    if (!book || book.price != null || book.quoteTried) return;
    book.quoteTried = true;
    try {
      const series = await SD.Data.fetchSeries({ symbol: book.pick || book.symbol, interval: '1d', range: '1y', prePost: false }, api.fetchCfg());
      const q = quoteFromSeries(series);
      book.price = q.price; book.prevClose = q.prevClose; book.high52 = q.high52; book.low52 = q.low52;
      // The listing currency is not the filing currency, so it goes beside the book, never over it.
      book.quoteCurrency = q.currency || book.quoteCurrency;
      if (current === key) { paintQuote(book); paintMetrics(book); runScreen(true); }
    } catch (e) {
      if (current === key) paintQuote(book);
    }
  }

  /* ------------------------------------------------------------------ loading */
  async function loadList(force) {
    if (busy) { setStatus('Already loading — one book per company is still one request each.'); return; }
    const keys = universe();
    if (!keys.length) { setStatus('No names on ' + (st.scope === 'ALL' ? 'any list' : listName(st.scope)) + '. Add tickers on the Watchlist tab first.'); return; }
    const todo = keys.filter(k => force || !books[F.symKey(k)]);
    if (!todo.length) { setStatus('All ' + keys.length + ' books are already open. Press Re-read to throw the cached statements away and fetch again.'); return; }
    busy = true;
    $('#bkLoad').disabled = true;
    $('#bkForce').disabled = true;
    let done = 0, ok = 0, bad = 0, lastErr = '';
    const cfg = api.fetchCfg();
    const queue = todo.slice();
    const workers = [];
    const POOL = 2;               // same budget rule the Watch stack follows: relays throttle in parallel
    for (let w = 0; w < POOL; w++) {
      workers.push((async () => {
        while (queue.length) {
          const key = queue.shift();
          done++;
          setStatus('reading ' + done + '/' + todo.length + ' · ' + key + ' — statements, quarters and market cap in one call');
          try {
            const b = await F.load(key, cfg, { force: !!force, quote: quoteFor(key) });
            b.pick = key;                      // the name the user actually typed on the watch list
            books[F.symKey(b.symbol)] = b;
            books[F.symKey(key)] = b;
            if (order.indexOf(F.symKey(b.symbol)) < 0) order.push(F.symKey(b.symbol));
            ok++;
          } catch (e) {
            bad++; lastErr = shortErr(e);
          }
          paintTabs(); paintCount();
        }
      })());
    }
    await Promise.all(workers);
    busy = false;
    $('#bkLoad').disabled = false;
    $('#bkForce').disabled = false;
    if (!current && order.length) select(order[0]);
    setStatus(ok + ' of ' + todo.length + ' books read · ' + new Date().toUTCString().slice(17, 25) + 'Z' +
      (bad ? ' · ' + bad + ' failed' + (lastErr ? ' (' + lastErr + ')' : '') + ' — indexes and dead tickers have no statements' : ''));
    paintTabs(); paintAll();
  }

  function select(key) {
    if (!books[key]) return;
    current = key;
    U.store.set('bookPick', key);
    paintTabs(); paintBook(); runScreen(true);
    ensureQuote(key);
  }

  /* ------------------------------------------------------------------ painting */
  function paintTabs() {
    const host = $('#bkTabs');
    host.innerHTML = '';
    if (!order.length) {
      host.innerHTML = '<span class="bk-none">No book open — press <strong>Load books</strong>.</span>';
      return;
    }
    order.forEach(k => {
      const b = books[k];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bk-tab' + (k === current ? ' is-on' : '');
      btn.dataset.k = k;
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', k === current ? 'true' : 'false');
      btn.textContent = (b && b.requested) || k;
      btn.title = (SD.Tickers.nameOf((b && b.symbol) || k) || '') + ' — ' + k;
      host.appendChild(btn);
    });
  }

  function paintCount() {
    // A book is filed under both the typed name and the resolved one, so count the series, not the keys.
    const n = order.filter(k => books[k]).length;
    $('#bkCount').textContent = n + ' book' + (n === 1 ? '' : 's');
    const badge = $('#booksTabCount');
    if (badge) badge.textContent = n;
  }

  function fmtMoney(v, currency) {
    if (v == null || !isFinite(v)) return '—';
    const u = F.unitFor(currency);
    return U.fmtNum(v / u.div, Math.abs(v / u.div) < 100 ? 1 : 0);
  }
  function unitTag(currency) { return F.unitFor(currency).label; }
  /* Market cap and enterprise value are quoted figures, so they read in the listing currency while
     the statements stay in the filing currency. A book where the two differ says so on the card. */
  function moneyCur(book, key) {
    return (key === 'mcap' || key === 'ev') ? (book.mcapCurrency || book.currency) : book.currency;
  }

  function paintBook() {
    const book = books[current];
    if (!book) return;
    paintQuote(book);
    paintMetrics(book);
    paintCharts(book);
    paintTable(book);
    paintPeers(book);
    paintNote(book);
    paintManual(book);
    paintSource(book);
  }

  function paintQuote(book) {
    const qcur = book.quoteCurrency || book.mcapCurrency || book.currency;
    const cur = CUR_SYM[qcur] || (qcur + ' ');
    const chg = book.price != null && book.prevClose ? 100 * (book.price / book.prevClose - 1) : null;
    const age = Math.round((Date.now() - book.fetchedAt) / 3600000);
    const pos = book.price != null && book.high52 > book.low52
      ? U.clamp(100 * (book.price - book.low52) / (book.high52 - book.low52), 0, 100) : null;
    $('#bkQuote').innerHTML =
      '<div class="bq-id"><strong>' +
      U.escapeHtml(SD.Tickers.nameOf(book.symbol) || SD.Tickers.nameOf(book.requested) || book.requested || book.symbol) +
      '</strong>' +
      '<span class="muted">' + U.escapeHtml(book.symbol) + ' · priced in ' + U.escapeHtml(qcur) +
      ' · files in ' + U.escapeHtml(book.currency) + '</span></div>' +
      '<div class="bq-price">' + (book.price == null ? '<span class="muted">no tape</span>'
        : '<span>' + cur + U.fmtPrice(book.price) + '</span>' +
          '<span class="bq-chg ' + (chg >= 0 ? 'pos' : 'neg') + '">' + U.fmtPct(chg) + '</span>') + '</div>' +
      (pos == null ? '' : '<div class="bq-range" title="Where the last print sits in the 52-week range">' +
        '<span class="bq-lo">' + cur + U.fmtPrice(book.low52) + '</span>' +
        '<span class="bq-bar"><i style="left:' + U.round(pos, 1) + '%"></i></span>' +
        '<span class="bq-hi">' + cur + U.fmtPrice(book.high52) + '</span></div>') +
      '<div class="bq-meta muted">statements ' + book.years.length + ' years · ' + book.quarters.length +
      ' quarters · read ' + (age < 1 ? 'this hour' : age + 'h ago') + ' · via ' + U.escapeHtml(book.via || 'cache') + '</div>' +
      (book.fxMismatch ? '<div class="bq-fx">Files in ' + U.escapeHtml(book.fxMismatch.split('/')[0]) +
        ', valued in ' + U.escapeHtml(book.fxMismatch.split('/')[1]) +
        ' — P/E, P/BV, enterprise value and dividend yield are withheld rather than divided across two currencies.</div>' : '');
  }

  function paintMetrics(book) {
    const s = book.summary;
    $('#bkMetrics').innerHTML = METRICS.map(m => {
      const raw = m.k === 'price' || m.k === 'high52' || m.k === 'low52' ? book[m.k] : s[m.k];
      let txt;
      if (m.money) txt = raw == null ? '—' : fmtMoney(raw, moneyCur(book, m.k)) + ' ' + unitTag(moneyCur(book, m.k));
      else if (m.cr) txt = raw == null ? '—' : U.fmtNum(raw, raw < 100 ? 2 : 0) + ' Cr';
      else if (m.pct) txt = raw == null ? '—' : U.round(raw, 2) + '%';
      else if (m.x) txt = raw == null ? '—' : U.round(raw, 2) + '×';
      else if (m.per) txt = raw == null ? '—' : U.fmtPrice(raw);
      else txt = raw == null ? '—' : String(raw);
      const cls = m.src === 'manual' ? ' bk-manual' : m.src === 'calc' ? ' bk-calc' : '';
      return '<div class="bk-metric' + cls + '" title="' + U.escapeHtml(m.t + ' — ' + SRC_LABEL[m.src]) + '">' +
        '<span class="bk-mk">' + U.escapeHtml(m.t) + '</span>' +
        '<span class="bk-mv">' + U.escapeHtml(txt) + '</span>' +
        '<span class="bk-ms">' + SRC_LABEL[m.src] + '</span></div>';
    }).join('');
  }

  /* ------------------------------------------------------------------ charts
     Inline SVG: it scales with the card, survives a 390px phone, and needs no chart library. */
  function paintCharts(book) {
    const u = F.unitFor(book.currency);
    $('#bkChartUnit').textContent = '· ' + u.label;
    $('#bkChartAnnual').innerHTML = groupChart(book.years.map(y => ({
      label: y.label,
      a: y.sales == null ? null : y.sales / u.div,
      b: y.netProfit == null ? null : y.netProfit / u.div
    })), 'Sales', 'Profit');
    $('#bkChartQuarter').innerHTML = groupChart(book.quarters.map(q => ({
      label: q.label, a: q.sales == null ? null : q.sales / u.div, b: null
    })), 'Sales', null);
  }

  function groupChart(pts, labelA, labelB) {
    if (!pts.length) return '<p class="muted small bk-nodata">No statement series to plot.</p>';
    const W = 760, H = 230, pad = 34, base = H - 34;
    const vals = [];
    pts.forEach(p => { if (p.a != null) vals.push(p.a); if (p.b != null) vals.push(p.b); });
    if (!vals.length) return '<p class="muted small bk-nodata">Nothing numeric to plot.</p>';
    const max = Math.max(0, Math.max.apply(null, vals));
    const min = Math.min(0, Math.min.apply(null, vals));
    const span = (max - min) || 1;
    const y = v => base - (v - min) / span * (base - pad);
    const gw = (W - pad * 2) / pts.length;
    const bw = Math.max(6, gw * (labelB ? 0.3 : 0.5));
    const out = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="bk-svg" role="img" aria-label="' + labelA + ' and profit by period">'];
    out.push('<line x1="' + pad + '" y1="' + y(0) + '" x2="' + (W - pad) + '" y2="' + y(0) + '" class="bk-axis"/>');
    out.push('<text x="4" y="' + (y(0) + 3) + '" class="bk-tick">' + trim(max) + '</text>');
    pts.forEach((p, i) => {
      const cx = pad + gw * i + gw / 2;
      const bars = labelB
        ? [{ v: p.a, cls: 'bk-bar-a', dx: -bw - 2, lab: labelA }, { v: p.b, cls: 'bk-bar-b', dx: 2, lab: labelB }]
        : [{ v: p.a, cls: 'bk-bar-a', dx: -bw / 2, lab: labelA }];
      bars.forEach(bar => {
        if (bar.v == null) return;
        const yy = Math.min(y(bar.v), y(0));
        const hh = Math.max(1, Math.abs(y(bar.v) - y(0)));
        out.push('<rect x="' + (cx + bar.dx) + '" y="' + yy + '" width="' + bw + '" height="' + hh + '" class="' + bar.cls + '"><title>' +
          p.label + ' · ' + bar.lab + ' ' + round2(bar.v) + '</title></rect>');
        out.push('<text x="' + (cx + bar.dx + bw / 2) + '" y="' + (yy - 4) + '" class="bk-val">' + trim(bar.v) + '</text>');
      });
      out.push('<text x="' + cx + '" y="' + (base + 15) + '" class="bk-x">' + U.escapeHtml(p.label) + '</text>');
      if (i > 0 && pts[i - 1].a && p.a != null) {
        const g = 100 * (p.a / pts[i - 1].a - 1);
        out.push('<text x="' + cx + '" y="' + (y(0) + 15) + '" class="bk-gr ' + (g >= 0 ? 'pos' : 'neg') + '">' + U.round(g, 1) + '%</text>');
      }
    });
    out.push('</svg>');
    out.push('<p class="bk-legend"><span class="lk lk-a"></span>' + U.escapeHtml(labelA) +
      (labelB ? '<span class="lk lk-b"></span>' + U.escapeHtml(labelB) : '') +
      '<span class="muted">the number under each group is its growth over the period before</span></p>');
    return out.join('');
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function trim(v) {
    const a = Math.abs(v);
    if (a >= 1000) return U.fmtNum(Math.round(v), 0);
    if (a >= 10) return String(round2(v));
    return String(Math.round(v * 10) / 10);
  }

  /* ------------------------------------------------------------------ statement tables */
  function cellFor(row, list, idx, def, book) {
    if (def.series) {
      const prev = list[idx - 1];
      if (!prev || !prev[def.prev] || list[idx][def.prev] == null) return '—';
      return U.round(100 * (list[idx][def.prev] / prev[def.prev] - 1), 2) + '%';
    }
    const v = def.f ? def.f(row) : row[def.k];
    if (v == null || !isFinite(v)) return '—';
    if (def.kind === 'money') return fmtMoney(v, book.currency);
    if (def.kind === 'pct') return U.round(v, 2);
    if (def.kind === 'per') return U.fmtPrice(v);
    return U.round(v, 2);
  }

  function rowIsEmpty(vals) { return vals.every(v => v === '—'); }

  function paintTable(book) {
    const seg = SEGMENTS[st.seg] || SEGMENTS.pl;
    const list = book[seg.cols] || [];
    const u = F.unitFor(book.currency);
    $('#bkTableNote').textContent = seg.note + (seg.cols === 'years' && u.label === 'Cr'
      ? ' Money rows are in ' + u.label + '; the feed reports ' + book.currency + '.'
      : ' Money rows are in ' + u.label + '; the feed reports ' + book.currency + '.');

    const thead = $('#bkTable thead');
    thead.innerHTML = '<tr><th class="bk-lbl"></th>' + list.map(r => '<th class="num">' + U.escapeHtml(r.label) + '</th>').join('') + '</tr>';
    const body = [];
    seg.rows.forEach(def => {
      const vals = list.map((r, i) => cellFor(r, list, i, def, book));
      if (st.hideEmpty && rowIsEmpty(vals)) return;
      body.push('<tr><th scope="row">' + U.escapeHtml(def.t) + (def.kind === 'money' ? '<span class="muted bk-u">' + u.label + '</span>' : '') +
        '</th>' + vals.map(v => '<td class="num">' + U.escapeHtml(v) + '</td>').join('') + '</tr>');
    });
    $('#bkTable tbody').innerHTML = body.join('') || '<tr><td class="muted">Every row is empty on this feed.</td></tr>';
  }

  /* ------------------------------------------------------------------ peers */
  /* Peers are the other names on the same watch list, not an industry basket — the free feed carries
     no sector table, and an INR-valued IT name is better compared with the rest of the NSE list than
     silently matched on a currency. */
  function paintPeers(book) {
    const own = books[current];
    const home = listKeyOf(own);
    const set = order.filter(k => books[k] && k !== current && listKeyOf(books[k]) === home).map(k => books[k]);
    const heads = ['Peer', 'Files in', 'Mkt Cap', 'P/E', 'Sales', 'Sales Gr', 'Profit', 'Profit Gr', 'OPM', 'NPM', 'ROE', 'ROCE', 'D/E', 'Div Yld', 'P/BV'];
    const cols = F.COLS.filter(c => c.k !== 'symbol' && c.k !== 'cur');
    $('#bkPeers thead').innerHTML = '<tr>' + heads.map((h, i) => '<th' + (i ? ' class="num"' : '') + '>' + h + '</th>').join('') + '</tr>';
    if (!set.length) {
      $('#bkPeers tbody').innerHTML = '<tr><td class="muted" colspan="' + heads.length + '">' +
        'Nothing else from this list has a book open yet. Load the list, then this table fills itself.</td></tr>';
      return;
    }
    set.sort((a, b) => (b.summary.mcap || 0) - (a.summary.mcap || 0));
    $('#bkPeers tbody').innerHTML = set.map(b => {
      const f = {};
      cols.forEach(c => { f[c.k] = c.get(b); });
      const cells = [
        '<td class="bk-peer sym">' + U.escapeHtml(b.requested || b.symbol) + '</td>',
        '<td class="sym">' + U.escapeHtml(b.currency) + '</td>',
        numCell(f.marketCap, 0), numCell(f.pe, 2), numCell(f.sales, 0), pctCell(f.salesG),
        numCell(f.profit, 0), pctCell(f.profitG), pctCell(f.opm), pctCell(f.npm),
        pctCell(f.roe), pctCell(f.roce), numCell(f.de, 2), pctCell(f.divYield), numCell(f.pbv, 2)
      ];
      return '<tr data-peer="' + U.escapeHtml(b.symbol) + '">' + cells.join('') + '</tr>';
    }).join('');
  }

  function listKeyOf(book) {
    const own = F.symKey(book.pick || book.requested || book.symbol);
    let home = null;
    SD.Watch.lists().forEach(l => {
      if (home) return;
      if (l.rows.some(r => F.symKey(r.key) === own)) home = l.name;
    });
    return home;
  }
  function numCell(v, d) { return '<td class="num">' + (v == null || !isFinite(v) ? '—' : U.fmtNum(U.round(v, d), d)) + '</td>'; }
  function pctCell(v) { return '<td class="num">' + (v == null || !isFinite(v) ? '—' : U.round(v, 2) + '%') + '</td>'; }

  /* ------------------------------------------------------------------ notes */
  function noteStore() { return U.store.get('bookNotes', {}); }
  function paintNote(book) {
    const n = noteStore()[current] || { text: '', at: 0 };
    $('#bkNote').value = n.text || '';
    $('#bkNoteSaved').textContent = n.at
      ? 'Last written ' + new Date(n.at).toLocaleString('en-GB', { hour12: false }) + ' on this machine.'
      : 'Notes save as you type — nothing leaves this browser.';
  }
  function saveNote() {
    if (!current) return;
    const all = noteStore();
    all[current] = { text: $('#bkNote').value, at: Date.now() };
    U.store.set('bookNotes', all);
    $('#bkNoteSaved').textContent = 'Saved locally at ' + new Date().toLocaleTimeString('en-GB', { hour12: false }) + '.';
  }

  /* ------------------------------------------------------------------ manual entries */
  function paintManual(book) {
    const m = book.manual || {};
    $('#bkManual').innerHTML = MANUAL_FIELDS.map(f =>
      '<label class="bk-fld"><span>' + U.escapeHtml(f.t) + '</span>' +
      '<input data-mf="' + f.k + '" type="number" step="any" inputmode="decimal" placeholder="' + U.escapeHtml(f.ph) +
      '" value="' + (m[f.k] == null ? '' : U.escapeHtml(m[f.k])) + '"></label>').join('');
  }
  function saveManual(clear) {
    if (!current) return;
    const patch = {};
    if (clear) { MANUAL_FIELDS.forEach(f => { patch[f.k] = null; }); }
    else $$('input[data-mf]', $('#bkManual')).forEach(el => {
      const v = el.value === '' ? null : Number(el.value);
      patch[el.dataset.mf] = v;
    });
    F.setManual(books[current].symbol, patch);
    books[current].manual = F.manualFor(books[current].symbol);
    F.applyManual(books[current]);
    paintBook();
    runScreen(true);
    U.toast(clear ? 'Manual entries cleared.' : 'Manual entries saved — the screen re-reads them at once.', 'ok');
  }

  function paintSource(book) {
    const has = t => (book.types.annual || []).indexOf(t) >= 0;
    const lines = [
      'Statements: ' + book.types.annual.length + ' annual series, ' + book.types.quarterly.length +
      ' quarterly and ' + book.types.trailing.length + ' trailing figures, all from one fundamentals-timeseries call.',
      'Market cap and enterprise value: trailing figures published with the statements — no live quote needed.',
      'Stock P/E, P/BV and dividend yield: computed from market cap over the last fiscal year\'s profit, equity and dividends.',
      'ROCE uses total assets minus current liabilities as capital employed, which is how Screener defines it.',
      has('annualEbitda') ? 'EBITDA is published by this feed and used directly.'
        : 'EBITDA is not published here; operating profit plus depreciation is the honest substitute, so the tables show the two components instead.',
      book.fxMismatch ? 'Currency clash: the statements are in ' + book.currency + ' but the exchange values the shares in ' +
        book.mcapCurrency + ', so every market-cap ratio is withheld. Nothing was converted with an assumed rate.' : 'Currency: statements and valuation agree, so the ratios that mix them are safe.',
      'Not available from any free source: shareholding pattern, pledges, face value, segment revenue, goodwill detail, announcements. Type what you know above.'
    ];
    $('#bkSource').innerHTML = lines.map(l => '<li>' + U.escapeHtml(l) + '</li>').join('');
  }

  /* ------------------------------------------------------------------ screener */
  /* A book belongs to the list its ticker was typed on. Yahoo resolves RELIANCE to RELIANCE.NS, so
     the list is matched on the name the user wrote, never on the resolved symbol. */
  function bookList(scope) {
    const out = [];
    const want = scope && scope !== 'ALL' ? listName(scope) : null;
    order.forEach(k => {
      const b = books[k];
      if (!b) return;
      if (want && !inList(want, b)) return;
      out.push(b);
    });
    return out;
  }
  function inList(name, book) {
    const list = SD.Watch.lists().filter(l => l.name === name)[0];
    if (!list) return false;
    const own = F.symKey(book.pick || book.requested || book.symbol);
    return list.rows.some(r => F.symKey(r.key) === own);
  }

  function runScreen(quiet) {
    const src = $('#bkQuery').value;
    const list = bookList(st.scope);
    let rows = [];
    const err = $('#bkQueryErr');
    err.hidden = true;
    try {
      rows = F.screen(src, list);
    } catch (e) {
      err.hidden = false;
      err.textContent = 'This query does not parse: ' + e.message;
      $('#bkResults tbody').innerHTML = '<tr><td class="muted">Fix the query — a screen that cannot be read never shows a partial answer.</td></tr>';
      $('#bkResultCount').textContent = '0';
      $('#bkResultOf').textContent = '';
      lastRows = [];
      return;
    }
    lastRows = rows;
    paintResults(rows, list.length);
    if (!quiet) U.toast(rows.length + ' of ' + list.length + ' names match.', rows.length ? 'ok' : 'warn');
  }

  function paintResults(rows, universeSize) {
    $('#bkResultOf').textContent = 'of ' + (universeSize || 0) + ' open book' + (universeSize === 1 ? '' : 's');
    $('#bkResultCount').textContent = rows.length;
    const vis = F.COLS;
    $('#bkResults thead').innerHTML = '<tr>' + vis.map(c =>
      '<th data-sk="' + c.k + '"' + (c.txt ? '' : ' class="num"') + '>' + U.escapeHtml(c.t) + '</th>').join('') + '</tr>';
    if (!rows.length) {
      $('#bkResults tbody').innerHTML = '<tr><td class="muted" colspan="' + vis.length + '">Nothing matches. Loosen a condition, or load more names.</td></tr>';
      return;
    }
    const sorted = rows.slice().sort((a, b) => {
      const col = vis.filter(c => c.k === st.sort)[0] || vis[2];
      const va = a.f[col.k], vb = b.f[col.k];
      const na = va == null ? -Infinity : va, nb = vb == null ? -Infinity : vb;
      if (col.txt) return st.dir * String(va || '').localeCompare(String(vb || ''));
      if (na === nb) return 0;
      return (na > nb ? 1 : -1) * st.dir;
    });
    $('#bkResults tbody').innerHTML = sorted.map(r => '<tr data-hit="' + U.escapeHtml(r.symbol) + '">' +
      vis.map(c => '<td class="' + (c.txt ? 'sym' : 'num') + '">' +
        U.escapeHtml(fmtCell(r.f[c.k], c.k)) + '</td>').join('') + '</tr>').join('');
  }

  function fmtCell(v, k) {
    if (v == null || (typeof v === 'number' && !isFinite(v))) return '—';
    if (k === 'price' || k === 'pe' || k === 'de' || k === 'pbv') return U.round(v, 2);
    if (typeof v === 'number') return U.fmtNum(U.round(v, v < 100 ? 2 : 0), v < 100 ? 2 : 0);
    return v;
  }

  function paintPresets() {
    $('#bkPresets').innerHTML = F.PRESETS.map((p, i) =>
      '<button type="button" class="bk-preset" data-px="' + i + '" title="' + U.escapeHtml(p.q) + '">' +
      U.escapeHtml(p.name) + '</button>').join('');
  }

  function savedScreens() { return U.store.get('screens', []); }
  function paintSaved() {
    const list = savedScreens();
    $('#bkSaved').innerHTML = list.length
      ? '<span class="bk-saved-h">Saved screens</span>' + list.map((s, i) =>
        '<span class="bk-saved-item"><button type="button" data-sv="' + i + '">' + U.escapeHtml(s.name) + '</button>' +
        '<button type="button" class="bk-x" data-sx="' + i + '" aria-label="Delete ' + U.escapeHtml(s.name) + '">×</button></span>').join('')
      : '';
  }

  function explain() {
    const box = $('#bkExplainBox');
    const src = $('#bkQuery').value.trim();
    if (!src) { box.hidden = true; return; }
    let ast;
    try { ast = F.parse(src); } catch (e) {
      box.hidden = false; box.textContent = 'Cannot be read: ' + e.message; return;
    }
    box.hidden = false;
    box.textContent = 'A name passes when: ' + say(ast) + '.';
  }
  function say(n) {
    if (n.op === 'and') return say(n.a) + ', and ' + say(n.b);
    if (n.op === 'or') return say(n.a) + ', or else ' + say(n.b);
    if (n.op === 'not') return 'it is not the case that ' + say(n.a);
    const def = F.FIELDS[n.field] || {};
    const unit = n.suffix ? ' ' + n.suffix : (def.unit === 'cr' ? ' crore' : def.unit === '%' ? '%' : '');
    let over = '';
    if (n.agg) over = ', taken as the ' + n.agg + ' over the last ' + (n.n || 'every available') + ' years';
    else if (n.n) over = ', measured across ' + n.n + ' years';
    return 'its ' + n.field + over + ' is ' + cmpWord(n.op) + ' ' + n.value + unit;
  }
  function cmpWord(op) {
    return ({ '>': 'more than', '<': 'less than', '>=': 'at least', '<=': 'at most', '!=': 'not', '=': 'exactly' })[op] || op;
  }

  function paintFields() {
    const keys = Object.keys(F.FIELDS).sort();
    $('#bkFields').innerHTML = keys.map(k =>
      '<span class="bk-f">' + U.escapeHtml(k) + '<em>' + F.FIELDS[k].unit + '</em></span>').join('');
  }

  /* ------------------------------------------------------------------ export */
  function exportBook() {
    const book = books[current];
    if (!book) { U.toast('Open a book first.', 'warn'); return; }
    const out = [];
    Object.keys(SEGMENTS).forEach(sk => {
      const seg = SEGMENTS[sk];
      const list = book[seg.cols] || [];
      const u = F.unitFor(book.currency);
      seg.rows.forEach(def => {
        const row = { statement: sk, line: def.t, unit: def.kind === 'money' ? u.label : def.kind === 'pct' ? '%' : '' };
        list.forEach((r, i) => {
          const v = def.series
            ? (list[i - 1] && list[i - 1][def.prev] && r[def.prev] != null ? U.round(100 * (r[def.prev] / list[i - 1][def.prev] - 1), 2) : null)
            : (def.f ? def.f(r) : r[def.k]);
          row[list[i].label] = v == null ? '' : (def.kind === 'money' ? U.round(v / u.div, 2) : U.round(v, 4));
        });
        out.push(row);
      });
    });
    const ms = {};
    METRICS.forEach(m => { ms[m.t] = book.summary[m.k] == null ? '' : U.round(book.summary[m.k], 4); });
    out.unshift(Object.assign({ statement: 'key metrics', line: '', unit: book.currency }, ms));
    U.download(book.symbol.replace(/[^A-Za-z0-9.]/g, '_') + '-books.csv', U.toCsv(out), 'text/csv;charset=utf-8');
    U.toast('Wrote every statement table for ' + (book.requested || book.symbol) + ' as CSV.', 'ok');
  }

  function exportScreen() {
    if (!lastRows.length) { U.toast('Run a screen with results first.', 'warn'); return; }
    const rows = lastRows.map(r => {
      const o = { Company: r.symbol };
      F.COLS.forEach(c => { if (c.k !== 'symbol') o[c.t] = r.f[c.k] == null ? '' : U.round(r.f[c.k], 4); });
      return o;
    });
    U.download('screen-' + Date.now() + '.csv', U.toCsv(rows), 'text/csv;charset=utf-8');
    U.toast('Exported ' + rows.length + ' screened names.', 'ok');
  }

  /* ------------------------------------------------------------------ wiring */
  function bind() {
    U.on($('#bkLoad'), 'click', () => loadList(false));
    U.on($('#bkForce'), 'click', () => loadList(true));
    U.on($('#bkDrop'), 'click', () => {
      F.clearCache();
      books = {}; order = []; current = null;
      paintTabs(); paintCount();
      $('#bkQuote').innerHTML = $('#bkMetrics').innerHTML = $('#bkTable tbody').innerHTML = '';
      setStatus('Local statements dropped. The next load re-requests every company.');
    });
    U.on($('#bkScope'), 'change', e => { st.scope = e.target.value; save(); if (current) runScreen(true); });
    U.on($('#bkHideEmpty'), 'change', e => { st.hideEmpty = e.target.checked; save(); if (current) paintTable(books[current]); });
    U.on($('#bkDesk'), 'click', () => { if (current && api.openSymbol) api.openSymbol(books[current].requested || books[current].symbol); });
    U.on($('#bkCsv'), 'click', exportBook);
    U.on($('#bkTabs'), 'click', e => {
      const b = e.target.closest && e.target.closest('.bk-tab');
      if (b) select(b.dataset.k);
    });
    U.on($('#bkSeg'), 'click', e => {
      const b = e.target.closest && e.target.closest('.seg-btn');
      if (!b) return;
      st.seg = b.dataset.st; save();
      $$('#bkSeg .seg-btn').forEach(x => {
        const on = x.dataset.st === st.seg;
        x.classList.toggle('is-on', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      if (current) paintTable(books[current]);
    });
    U.on($('#bkPeers'), 'click', e => {
      const tr = e.target.closest && e.target.closest('tr[data-peer]');
      if (tr && books[F.symKey(tr.dataset.peer)]) select(F.symKey(tr.dataset.peer));
    });
    let noteTimer = 0;
    U.on($('#bkNote'), 'input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(saveNote, 700);
    });
    U.on($('#bkManualSave'), 'click', () => saveManual(false));
    U.on($('#bkManualClear'), 'click', () => saveManual(true));
    U.on($('#bkRun'), 'click', () => runScreen(false));
    U.on($('#bkQuery'), 'keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runScreen(false); } });
    U.on($('#bkExplain'), 'click', explain);
    U.on($('#bkCsvScreen'), 'click', exportScreen);
    U.on($('#bkSaveScreen'), 'click', () => {
      const src = $('#bkQuery').value.trim();
      if (!src) { U.toast('Type a query first.', 'warn'); return; }
      const name = window.prompt('Name this screen', 'My screen ' + (savedScreens().length + 1));
      if (!name) return;
      const list = savedScreens();
      list.push({ name: String(name).slice(0, 60), q: src });
      U.store.set('screens', list);
      paintSaved();
    });
    U.on($('#bkPresets'), 'click', e => {
      const b = e.target.closest && e.target.closest('[data-px]');
      if (!b) return;
      const p = F.PRESETS[Number(b.dataset.px)];
      $('#bkQuery').value = p.q;
      U.toast(p.note, '', 6000);
      runScreen(false);
    });
    U.on($('#bkSaved'), 'click', e => {
      const del = e.target.closest && e.target.closest('[data-sx]');
      if (del) {
        const list = savedScreens();
        list.splice(Number(del.dataset.sx), 1);
        U.store.set('screens', list);
        paintSaved();
        return;
      }
      const b = e.target.closest && e.target.closest('[data-sv]');
      if (!b) return;
      $('#bkQuery').value = savedScreens()[Number(b.dataset.sv)].q;
      runScreen(false);
    });
    U.on($('#bkResults'), 'click', e => {
      const th = e.target.closest && e.target.closest('th[data-sk]');
      if (th) {
        const k = th.dataset.sk;
        if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = -1; }
        save();
        paintResults(lastRows, bookList(st.scope).length);
        return;
      }
      const tr = e.target.closest && e.target.closest('tr[data-hit]');
      if (tr) { const k = F.symKey(tr.dataset.hit); if (books[k]) select(k); }
    });
  }

  function setStatus(t) { const el = $('#bkStatus'); if (el) el.textContent = t; }
  function shortErr(e) {
    const m = String(e && e.message || e);
    return m.length > 200 ? m.slice(0, 200) + '…' : m;
  }

  function activate() {
    $$('#bkSeg .seg-btn').forEach(x => {
      const on = x.dataset.st === st.seg;
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('#bkScope').value = st.scope;
    paintTabs(); paintCount();
    if (order.length) { if (!current || !books[current]) current = order[0]; select(current); }
    else if (Object.keys(books).length) { order = Object.keys(books); select(order[0]); }
    else setStatus('Nothing open yet. Press Load books — one request per company, cached for a week.');
  }
  function deactivate() { /* the fundamentals cache is passive; no timer lives here */ }
  function reload() { if (current && books[current]) paintAll(); }
  function paintAll() { if (current && books[current]) paintBook(); }

  return { init, activate, deactivate, reload, universe, loadList, select, bookList, get books() { return books; } };
})();
