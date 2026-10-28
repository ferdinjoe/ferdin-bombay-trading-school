/* Structure Desk — Scan view: every name on all three watch lists in one ranked table.
   Nothing here is a second opinion; it is the same engine as the Desk, read across the whole book,
   compressed into one 0-10 number plus the evidence behind it. Rows are shared with the Watchlist
   tab, so a tape fetched for the scan is already warm when that list is opened, and vice versa. */
SD.Scan = (function () {
  'use strict';

  const U = SD.U;
  const $ = U.$, $$ = U.$$;
  const CUR_SYM = { INR: '₹', USD: '$', GBP: '£', EUR: '€', JPY: '¥', CHF: 'CHF', SGD: 'S$', AUD: 'A$', MYR: 'RM' };

  /* Columns are declared once and reused by the sorter, so a header click can never disagree with
     the value the cell prints. */
  const COLS = [
    { k: 'sym', label: 'Symbol', num: false },
    { k: 'last', label: 'Last', num: true },
    { k: 'chg', label: 'Chg %', num: true },
    { k: 'rvol', label: 'RVOL', num: true },
    { k: 'trend', label: 'Trend', num: false },
    { k: 'proj', label: 'Projection', num: true },
    { k: 'score', label: 'Score /10', num: true },
    { k: 'action', label: 'Action', num: false },
    { k: 'why', label: 'Why', num: false }
  ];
  const ACT_RANK = { BUY: 0, HOLD: 1, SELL: 2, 'NO READ': 3 };

  let api = null;
  let entries = [];                       // one per row across all lists, with its call attached
  let open = {};                          // key -> true while its evidence row is expanded
  const st = { sort: 'score', dir: -1, market: 'ALL', action: 'ALL', tech: 'ALL', horizon: 5 };

  function init(bridge) {
    api = bridge;
    const saved = U.store.get('scan', {});
    st.horizon = saved.horizon || st.horizon;
    st.sort = saved.sort || st.sort;
    st.dir = saved.dir === 1 ? 1 : -1;
    st.market = saved.market || st.market;
    st.action = saved.action || st.action;
    st.tech = saved.tech || st.tech;
    bind();
  }

  function bind() {
    U.on($('#scanRun'), 'click', () => run(true));
    U.on($('#scanHorizon'), 'change', e => { st.horizon = Number(e.target.value) || 5; save(); build(); paint(); });
    U.on($('#scanMarket'), 'change', e => { st.market = e.target.value; save(); paint(); });
    U.on($('#scanAction'), 'change', e => { st.action = e.target.value; save(); paint(); });
    U.on($('#scanTech'), 'change', e => { st.tech = e.target.value; save(); paint(); });
    // Bars and window live on the Watch list; the Scan mirrors them and re-reads through it.
    const specChange = () => {
      const changed = SD.Watch.setSpec({ interval: $('#scanInterval').value, range: $('#scanRange').value });
      if (changed) run(true);
    };
    U.on($('#scanInterval'), 'change', specChange);
    U.on($('#scanRange'), 'change', specChange);
    U.on($('#scanHead'), 'click', e => {
      const th = e.target.closest && e.target.closest('th[data-sk]');
      if (!th) return;
      const k = th.dataset.sk;
      if (st.sort === k) st.dir = -st.dir; else { st.sort = k; st.dir = (COLS.filter(c => c.k === k)[0] || {}).num ? -1 : 1; }
      save(); paint();
    });
    // One delegated click handler: rows are rebuilt on every paint, so per-row listeners leak.
    U.on($('#scanBody'), 'click', e => {
      const tr = e.target.closest && e.target.closest('tr.sc-row');
      if (!tr) return;
      const key = tr.dataset.key;
      if (e.target.closest('button.sc-desk')) { const en = find(key); if (en) api.openSymbol(en.row.key); return; }
      open[key] = !open[key];
      paint();
    });
    U.on($('#scanBody'), 'keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tr = e.target.closest && e.target.closest('tr.sc-row');
      if (!tr) return;
      e.preventDefault();
      open[tr.dataset.key] = !open[tr.dataset.key];
      paint();
    });
    U.on(window, 'resize', () => { if (isVisible()) paint(); });
  }

  function save() { U.store.set('scan', { horizon: st.horizon, sort: st.sort, dir: st.dir, market: st.market, action: st.action, tech: st.tech }); }
  function find(key) { return entries.filter(e => e.row.key === key)[0] || null; }
  function isVisible() { const v = $('#scanView'); return v && !v.hidden; }

  /* ------------------------------------------------------------------ collecting */
  /* Recompute every call from the cached models. Cheap enough to redo on each paint, and it keeps
     the table in step with engine settings changed on the Desk without a second cache to stale. */
  function build() {
    entries = [];
    SD.Watch.lists().forEach(list => {
      list.rows.forEach(row => {
        const en = { row, market: list.name, mid: list.id, series: row.series, model: row.model, call: null, chg: NaN, tech: null };
        if (row.model) {
          en.chg = pctChange(row.model, row.series);
          en.tech = tech(row.model);
          try { en.call = SD.Analysis.call(row.model, { horizon: st.horizon }); }
          catch (e) { en.call = null; en.fail = String(e && e.message || e); }
        }
        entries.push(en);
      });
    });
  }

  async function run(force) {
    if (SD.Watch.scanProgress().busy) { setStatus('A scan is already running.'); return; }
    const prog = SD.Watch.scanProgress();
    if (!prog.all) { setStatus('Every list is empty — add names on the Watchlist tab first.'); return; }
    const spec = SD.Watch.spec();
    setStatus((force ? 'requesting all ' : 'filling ' + (prog.all - prog.ready) + ' of ') + prog.all +
      ' name(s) · ' + spec.interval + ' bars · ' + spec.range + ' window…');
    $('#scanRun').disabled = true;
    let done = 0;
    const tick = (row, i, total) => {
      done = i;
      setStatus('scanning ' + i + '/' + total + ' · ' + row.key + (row.error ? ' — no data' : ''));
      build(); paint();
    };
    try {
      const r = await SD.Watch.scanAll({ force: !!force, onRow: tick });
      build(); paint();
      const t = U.fmtClock(Date.now(), 'UTC');
      const tape = spec.interval + ' bars · ' + spec.range + ' window';
      if (!r) setStatus('Scan skipped — the Watchlist tab is using the relays. Press Refresh there, then try again.');
      else if (!r.total) setStatus(prog.all + ' names ranked from cache · ' + U.fmtClock(Date.now(), 'UTC') + 'Z · nothing re-requested, every tape already covers the ' + tape);
      else setStatus(r.ok + ' of ' + r.total + ' names read · ' + t + 'Z · ' + tape +
        (r.bad ? ' · ' + r.bad + ' failed on the free relays — press Scan again to retry just those' : ''));
    } finally {
      $('#scanRun').disabled = false;
    }
  }

  function activate() {
    const spec = SD.Watch.spec();
    $('#scanInterval').value = spec.interval;
    $('#scanRange').value = spec.range;
    $('#scanMarket').value = st.market;
    $('#scanAction').value = st.action;
    $('#scanTech').value = st.tech;
    const prog = SD.Watch.scanProgress();
    build(); paint();
    // Fill only the gaps: names the Watchlist tab already read are ranked from that same tape.
    if (prog.ready < prog.all) run(false);
    else setStatus(prog.ready + ' of ' + prog.all + ' names cached · ' + spec.interval + ' bars · ' + spec.range + ' window');
  }
  function deactivate() { /* the Watch module owns the only timers; nothing to stop here */ }

  /* Desk settings changed: models were rebuilt by Watch.reload(), so just re-score and repaint. */
  function reload() { if (isVisible()) { build(); paint(); } }

  /* ------------------------------------------------------------------ painting */
  function valueOf(en, k) {
    const s = en.series, m = en.model, c = en.call;
    switch (k) {
      case 'sym': return (s && s.symbol || en.row.key).toLowerCase();
      case 'last': return m ? m.last.c : -Infinity;
      case 'chg': return en.chg === undefined ? -Infinity : en.chg;
      case 'rvol': return m && isFinite(m.volume.rvol) ? m.volume.rvol : -Infinity;
      case 'trend': return c && isFinite(c.score) ? c.score : -Infinity;
      case 'proj': return c && c.projection && isFinite(c.projection.pct) ? c.projection.pct : -Infinity;
      case 'score': return c && isFinite(c.score) ? c.score : -Infinity;
      case 'action': return c ? (ACT_RANK[c.action] === undefined ? 9 : ACT_RANK[c.action]) : 9;
      default: return c ? String(c.summary || '') : '';
    }
  }

  function paint() {
    const body = $('#scanBody');
    const rows = entries.filter(passes);
    rows.sort((a, b) => {
      const va = valueOf(a, st.sort), vb = valueOf(b, st.sort);
      if (va === vb) return String(a.row.key).localeCompare(String(b.row.key));
      return va > vb ? st.dir : -st.dir;
    });
    $$('#scanHead th').forEach(th => {
      const on = th.dataset.sk === st.sort;
      th.classList.toggle('is-sort', on);
      th.setAttribute('aria-sort', on ? (st.dir < 0 ? 'descending' : 'ascending') : 'none');
    });

    if (!rows.length) {
      body.innerHTML = '<tr class="sc-none"><td colspan="' + COLS.length + '">' +
        (entries.length ? 'No name matches this filter.' : 'Nothing to scan yet — add tickers on the Watchlist tab, then press Scan every list.') +
        '</td></tr>';
      $('#scanCount').textContent = '0/' + entries.length;
      return;
    }

    const html = [];
    rows.forEach(en => { html.push(rowHtml(en)); if (open[en.row.key]) html.push(detHtml(en)); });
    body.innerHTML = html.join('');
    $('#scanCount').textContent = rows.length + '/' + entries.length;
    const buys = entries.filter(e => e.call && e.call.action === 'BUY').length;
    const sells = entries.filter(e => e.call && e.call.action === 'SELL').length;
    $('#scanTally').textContent = buys + ' BUY · ' + sells + ' SELL · ' +
      (entries.length - buys - sells) + ' HOLD / no read';
  }

  function passes(en) {
    if (st.market !== 'ALL' && en.mid !== st.market) return false;
    if (st.action !== 'ALL' && (!en.call || en.call.action !== st.action)) return false;
    const t = en.tech;
    if (st.tech === 'rsi-os') return !!t && t.rsi <= 30;
    if (st.tech === 'rsi-ob') return !!t && t.rsi >= 70;
    if (st.tech === 'macd-bull') return !!t && t.hist > 0;
    if (st.tech === 'macd-bear') return !!t && t.hist < 0;
    return true;
  }

  /* RSI/MACD context, computed once per row per build. Deliberately outside the score: the score is
     the structure engine's own evidence, and an oscillator reading is not a second opinion on it. */
  function tech(m) {
    if (!m || m.bars.length < 34) return null;
    const closes = m.bars.map(b => b.c);
    return {
      rsi: SD.Ind.lastVal(SD.Ind.rsi(closes, 14)),
      hist: SD.Ind.lastVal(SD.Ind.macd(closes, 12, 26, 9).hist)
    };
  }

  function rowHtml(en) {
    const m = en.model, c = en.call, s = en.series;
    const key = U.escapeHtml(s ? (s.resolvedFrom || en.row.key) : en.row.key);
    const venue = s ? U.escapeHtml(s.symbol) : '';
    const cur = s && CUR_SYM[s.currency] ? CUR_SYM[s.currency] : '';

    const chg = en.chg;

    let last = '—', chgTd = '—', rvol = '—', trend = 'no read', proj = '—', score = '—', action = '<span class="pill flat">waiting</span>', why = '';

    if (en.row.error) { why = '<span class="sc-err">' + U.escapeHtml(en.row.error) + '</span>'; trend = '—'; }
    else if (!m) why = '<span class="muted">not requested yet</span>';

    if (m) {
      last = cur + U.fmtPrice(m.last.c, m.dec);
      chgTd = isFinite(chg) ? '<span class="' + (chg >= 0 ? 'pos' : 'neg') + '">' + U.fmtPct(chg) + '</span>' : '—';
      const noVol = !isFinite(m.volume.med20) || m.volume.med20 <= 0;
      /* An index tape often carries a volume series with the newest bar blank; a literal 0× reads
         as "the market was dead", when what happened is the feed said nothing. */
      rvol = noVol || !(m.volume.rvol > 0)
        ? '<span class="muted">no vol' + (noVol ? ' series' : ' this bar') + '</span>'
        : U.round(m.volume.rvol, 2) + '×';
    }
    if (c) {
      trend = trendTxt(c, m, en.tech);
      proj = projTxt(c, m);
      score = isFinite(c.score)
        ? '<span class="sc-num ' + scoreClass(c.score) + '">' + c.score.toFixed(1) + '</span>' +
          '<span class="sc-bar"><i class="' + scoreClass(c.score) + '" style="width:' + (c.score * 10) + '%"></i></span>'
        : '<span class="muted">no read</span>';
      action = '<span class="pill ' + actPill(c.action) + '" title="' + U.escapeHtml(c.gated ? 'Gated: evidence missing, so the book stays flat' : c.summary) + '">' +
        c.action + (c.gated && isFinite(c.score) ? ' *' : '') + '</span>' +
        '<span class="sc-conf">' + (isFinite(c.confidence) ? c.confidence + '%' : '—') + '</span>';
      why = whyTxt(c);
    }

    const scName = SD.Tickers.nameOf((en.row.series && en.row.series.symbol) || en.row.key);
    const main = '<tr class="sc-row' + (open[en.row.key] ? ' is-open' : '') + '" data-key="' + U.escapeHtml(en.row.key) + '" tabindex="0">' +
      '<td class="sc-sym"><button class="sc-desk" type="button" title="Open ' + U.escapeHtml(en.row.key) + ' on the Desk tab">' + key + '</button>' +
      (scName ? '<span class="sc-name">' + U.escapeHtml(scName) + '</span>' : '') +
      (venue && venue !== key ? '<span class="muted sc-venue">' + venue + '</span>' : '') +
      '<span class="muted sc-mkt">' + U.escapeHtml(en.market) + '</span></td>' +
      '<td class="num">' + last + '</td><td class="num">' + chgTd + '</td><td class="num">' + rvol + '</td>' +
      '<td>' + trend + '</td><td class="num">' + proj + '</td><td class="sc-score">' + score + '</td>' +
      '<td>' + action + '</td><td class="sc-why">' + why + '</td></tr>';
    return main;
  }

  function detHtml(en) {
    const c = en.call, m = en.model;
    if (!m) return '<tr class="sc-det"><td colspan="' + COLS.length + '"><span class="muted">' +
      (en.row.error ? U.escapeHtml(en.row.error) : 'No tape for this name yet — press Scan every list.') + '</span></td></tr>';
    if (!c) return '<tr class="sc-det"><td colspan="' + COLS.length + '"><span class="muted">The scorer refused this tape: ' + U.escapeHtml(en.fail || 'no read') + '</span></td></tr>';
    if (!c.ok) return noReadHtml(en);
    let h = '<tr class="sc-det"><td colspan="' + COLS.length + '"><div class="sc-grid">';
    h += '<div class="sc-col"><h4>Evidence, weighted out of ten</h4><ul>' +
      c.drivers.map(d => '<li><b class="' + (d.pts >= 0 ? 'pos' : 'neg') + '">' + (d.pts >= 0 ? '+' : '') + d.pts + '</b> <span class="sc-dk">' + U.escapeHtml(d.k) + '</span> — ' + U.escapeHtml(d.txt) + '</li>').join('') +
      '</ul></div>';
    h += '<div class="sc-col"><h4>Projection over the next ' + c.projection.horizon + ' bars</h4><ul>' +
      '<li><b>' + U.fmtPrice(c.projection.to, m.dec) + '</b> — ' + U.fmtPct(c.projection.pct) + ' from ' + U.fmtPrice(c.projection.from, m.dec) + ', carried by the ' + U.escapeHtml(c.projection.source) + '</li>' +
      '<li>plausible band ' + U.fmtPrice(c.projection.lo, m.dec) + ' → ' + U.fmtPrice(c.projection.hi, m.dec) + ' (1 ATR scaled by the square root of time)</li>' +
      (isFinite(c.projection.target) ? '<li>level the read is aimed at: ' + U.fmtPrice(c.projection.target, m.dec) + '</li>' : '') +
      '<li>thesis invalid on a close past ' + U.fmtPrice(c.projection.invalidAt, m.dec) + '</li>' +
      (c.signal ? '<li>last accepted break: ' + c.signal.dir + ' through ' + U.fmtPrice(c.signal.level, m.dec) + ', ' + c.signal.ago + ' bars ago' + (isFinite(c.signal.rr) ? ', ' + U.round(c.signal.rr, 2) + 'R to target' : '') + '</li>' : '<li>no accepted break in this window</li>') +
      '</ul></div>';
    h += '<div class="sc-col"><h4>' + (c.blockers.length ? 'What blocks a position' : 'Nothing is blocking this') + '</h4><ul>' +
      (c.blockers.length ? c.blockers.map(b => '<li class="sc-b">' + U.escapeHtml(b) + '</li>').join('') : '<li class="muted">Every gate cleared — the action below is taken on the score alone.</li>') +
      c.notes.map(x => '<li class="muted">' + U.escapeHtml(x) + '</li>').join('') +
      '</ul>' + (c.blockers.length ? '<p class="sc-gate">Gates force Hold. A missing tape, a missing volume series or an unconfirmed break is a flat book, never a short.</p>' : '') + '</div>';
    h += '<div class="sc-col"><h4>Structure notes</h4><ul>' +
      '<li>' + U.escapeHtml(m.structure.title) + ' — ' + U.escapeHtml(m.structure.sub) + '</li>' +
      '<li>confidence ' + (isFinite(c.confidence) ? c.confidence + '%' : '—') + ' · ' + m.bars.length + ' bars · ' + U.escapeHtml(en.series.granularity) + ' · via ' + U.escapeHtml(en.series.via || '—') + '</li>' +
      m.quality.map(q => '<li class="' + (q.lvl === 'warn' ? 'sc-b' : 'muted') + '">' + U.escapeHtml(q.txt) + '</li>').join('') +
      '</ul></div>';
    h += techHtml(m);
    return h + '</div></td></tr>';
  }

  /* The oscillator group TV prints under "Technicals". Shown with the votes spelled out so it can
     be argued with — and labelled as context, because it never moves the action pill. */
  function techHtml(m) {
    const r = SD.Ind.rating(m);
    if (!r) return '<div class="sc-col"><h4>Technical context</h4><ul>' +
      '<li class="muted">Too few bars for the oscillator group — it needs 30.</li></ul></div>';
    return '<div class="sc-col"><h4>Technical context · ' + U.escapeHtml(r.label) + '</h4><ul>' +
      r.votes.map(v => '<li><b class="' + (v.bull ? 'pos' : 'neg') + '">' + (v.bull ? '↑' : '↓') + '</b> ' +
        U.escapeHtml(v.k) + ' <span class="sc-dk">' + U.escapeHtml(v.txt) + '</span></li>').join('') +
      '<li class="muted">' + r.bull + ' of ' + r.count + ' oscillator votes are bullish. Context only — structure, gates and the score decide the action.</li>' +
      '</ul></div>';
  }

  /* A one-sided swing pool gets no score at all, and that refusal is the whole read. It needs its
     own ledger: the shared columns would quote an empty driver list and a null projection. */
  function noReadHtml(en) {
    const c = en.call, m = en.model;
    const nh = m.confirmedHighs.length, nl = m.confirmedLows.length;
    let h = '<tr class="sc-det"><td colspan="' + COLS.length + '"><div class="sc-grid">';
    h += '<div class="sc-col"><h4>Why there is no read</h4><ul>' +
      c.blockers.map(b => '<li class="sc-b">' + U.escapeHtml(b) + '</li>').join('') +
      '<li class="muted">No score, no projection and no action — a missing side is not a zero, and averaging it against one would invent conviction the tape does not support.</li>' +
      '</ul></div>';
    h += '<div class="sc-col"><h4>What the tape does show</h4><ul>' +
      '<li>' + nh + ' confirmed swing high' + (nh === 1 ? '' : 's') + ' · ' + nl + ' confirmed swing low' + (nl === 1 ? '' : 's') + '</li>' +
      '<li>' + m.bars.length + ' bars · ' + U.escapeHtml(m.lastAtr > 0 ? 'ATR ' + U.fmtPrice(m.lastAtr, m.dec) : 'no usable ATR') + '</li>' +
      '<li>last close ' + U.fmtPrice(m.last.c, m.dec) + '</li>' +
      '</ul></div>';
    h += '<div class="sc-col"><h4>Structure notes</h4><ul>' +
      '<li>' + U.escapeHtml(m.structure.title) + ' — ' + U.escapeHtml(m.structure.sub) + '</li>' +
      (en.series ? '<li>' + U.escapeHtml(en.series.granularity) + ' bars · via ' + U.escapeHtml(en.series.via || '—') + '</li>' : '') +
      m.quality.map(q => '<li class="' + (q.lvl === 'warn' ? 'sc-b' : 'muted') + '">' + U.escapeHtml(q.txt) + '</li>').join('') +
      '</ul></div>';
    h += '<div class="sc-col"><h4>What would create a read</h4><ul>' +
      '<li>' + (nh < 2 ? 'A second close-backed swing high.' : 'A second close-backed swing low.') + '</li>' +
      '<li>Widening the window on the Scan bar re-reads every name, which is usually what adds the missing side.</li>' +
      '</ul></div>';
    h += techHtml(m);
    return h + '</div></td></tr>';
  }

  /* ------------------------------------------------------------------ cells */
  function pctChange(m, s) {
    const base = s.prevClose && s.prevClose > 0 ? s.prevClose : (m.bars.length > 1 ? m.bars[m.bars.length - 2].c : 0);
    return base > 0 ? 100 * (m.last.c - base) / base : NaN;
  }

  function trendTxt(c, m, t) {
    const arrow = c.trend === 'Higher' ? '↑' : c.trend === 'Lower' ? '↓' : c.trend === 'no read' ? '·' : '→';
    const tone = c.trend === 'Higher' ? 'pos' : c.trend === 'Lower' ? 'neg' : 'muted';
    const slope = m.trend.high || m.trend.low;
    const osc = t && (isFinite(t.rsi) || isFinite(t.hist))
      ? '<span class="muted sc-sub">RSI ' + (isFinite(t.rsi) ? t.rsi.toFixed(1) : '—') +
        (isFinite(t.hist) ? ' · MACD ' + (t.hist >= 0 ? '+' : '') + t.hist.toFixed(2) : '') + '</span>'
      : '';
    return '<span class="' + tone + '">' + arrow + ' ' + U.escapeHtml(c.trend) + '</span>' +
      (isFinite(m.structure.bullScore) ? '<span class="muted sc-sub">' + m.structure.bullScore + '/100 seq</span>' : '<span class="muted sc-sub">one-sided</span>') +
      (slope ? '<span class="muted sc-sub">' + (slope.slope > 0 ? 'rising' : 'falling') + ' line R2 ' + U.round(slope.fit, 2) + '</span>' : '') +
      osc;
  }

  function projTxt(c, m) {
    if (!c.projection || !isFinite(c.projection.pct)) return '<span class="muted">—</span>';
    const p = c.projection;
    return '<span class="' + (p.pct >= 0 ? 'pos' : 'neg') + '">' + U.fmtPct(p.pct) + '</span>' +
      '<span class="muted sc-sub">to ' + U.fmtPrice(p.to, m.dec) + ' in ' + p.horizon + ' bars</span>';
  }

  function scoreClass(v) { return v >= 6.5 ? 'pos' : v <= 3.5 ? 'neg' : 'mid'; }
  function actPill(a) { return a === 'BUY' ? 'up' : a === 'SELL' ? 'down' : a === 'NO READ' ? 'flat' : 'warn'; }

  function whyTxt(c) {
    const top = c.drivers.slice().sort((a, b) => Math.abs(b.pts) - Math.abs(a.pts))[0];
    const bits = [];
    if (top && isFinite(top.pts)) bits.push(U.escapeHtml(top.k + ': ' + top.txt));
    if (c.blockers.length) bits.push('<span class="sc-b">' + c.blockers.length + ' blocker' + (c.blockers.length > 1 ? 's' : '') + ' — ' + U.escapeHtml(c.blockers[0]) + '</span>');
    if (!bits.length) bits.push('<span class="muted">no evidence either way</span>');
    const hint = c.drivers.length ? 'click the row for all five components' : 'click the row for what the tape does show';
    return bits.join(' · ') + '<span class="muted sc-sub">' + hint + '</span>';
  }

  function setStatus(t) { const el = $('#scanStatus'); if (el) el.textContent = t; }

  return { init, activate, deactivate, reload, run, build };
})();
