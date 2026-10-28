/* Structure Desk — ticker directory and suggestion dropdown.
   Two jobs. First, remember every listed name this machine has actually touched — a chart load, a
   fundamentals book, a watch list entry, a search — so the next time the same ticker is half-typed
   it comes back instantly with the right exchange suffix. Second, seed the Indian board from the
   NSE's own listing file (data/nse-listed.csv, vendored, no request at run time) so typing "20MIC"
   finds 20MICRONS.NS even on a machine that has never seen it.
   Everything else — Nasdaq, NYSE, SGX — is learned from the search endpoint on demand, one relay per
   distinct fragment per half day, and never when the local directory already has enough to offer. */
SD.Tickers = (function () {
  'use strict';

  const U = SD.U, D = SD.Data;
  const $ = U.$;

  const DIR_KEY = 'tickerDir';
  const SUG_KEY = 'tickerSuggest';
  const SEED_PATH = 'data/nse-listed.csv';
  const SUG_TTL = 12 * 3600e3;         // a fragment costs one relay per half day
  const DIR_TTL = 180 * 86400e3;       // then a name nobody has quoted for six months is dropped
  const MAX_DIR = 4000;
  const MIN_CHARS = 2;
  const DEBOUNCE = 380;
  const MAX_SHOW = 12;
  /* EQ is the main board, BE and BZ are the same equity under a different settlement series, SM is
     the SME platform. Anything else in that column is a voucher, a derivative or an index. */
  const SERIES_KIND = { EQ: 'equity', BE: 'equity', BZ: 'equity', SM: 'sme' };
  const SEARCH_BASE = 'https://query1.finance.yahoo.com/v1/finance/search';

  let dir = null;
  let seed = [];                       // parsed rows of the listing file, in memory only
  let seedPromise = null;

  /* ------------------------------------------------------------------ symbols */
  function leafOf(sym) {
    const s = String(sym || '').toUpperCase();
    return (s[0] === '^' ? s.slice(1) : s).replace(/\.[A-Z]{1,4}$/, '');
  }

  /* Suggestions are about the fragment under the cursor, never the tokens already committed to the
     left of it. A batch box splits on whitespace too; the desk box must not, or a two-word company
     name would search for its last word only. */
  function fragmentOf(v, tokens) {
    const parts = String(v || '').split(tokens ? /[,;\s]+/ : /[,;]+/);
    return (parts[parts.length - 1] || '').trim();
  }

  /* Query text can arrive as "NSE:RELIANCE", "reliance.ns", "^nsei" — match on the letters only,
     but keep the typed venue so a suffix the user wrote is respected rather than second-guessed. */
  function parseQuery(raw) {
    const typed = String(raw || '').trim().toUpperCase();
    const n = D.normaliseSymbol(typed) || typed;
    const q = leafOf(n).replace(/[^A-Z0-9^]/g, '');
    const forced = /\.([A-Z]{1,4})$/.test(n) ? n.split('.').pop() : null;
    return { typed, norm: n, q, forced, carets: n[0] === '^' || typed[0] === '^' };
  }

  /* ------------------------------------------------------------------ directory */
  function loadDir() {
    if (!dir) dir = U.store.get(DIR_KEY, {}) || {};
    return dir;
  }

  function saveDir() {
    const d = loadDir(), now = Date.now();
    Object.keys(d).forEach(k => {
      const e = d[k];
      if (!e || now - (e.t || 0) > DIR_TTL) { delete d[k]; return; }
      /* A bare token with no name, exchange or currency behind it teaches nothing the typed text does
         not already say — and it is what a mistyped ticker leaves behind. A suffixed or caret symbol
         states its own venue, so it stays. */
      if (!e.n && !e.x && !e.c && e.s[0] !== '^' && e.s.indexOf('.') < 0) delete d[k];
    });
    const keys = Object.keys(d);
    if (keys.length > MAX_DIR) {
      keys.sort((a, b) => (d[a].t || 0) - (d[b].t || 0)).slice(0, keys.length - MAX_DIR).forEach(k => delete d[k]);
    }
    U.store.set(DIR_KEY, d);
  }

  /* A later sighting must not erase a name or a currency an earlier one proved. */
  function remember(entry) {
    if (!entry || !entry.s) return null;
    if (isContract(entry.s, entry.type)) return null;
    let key = String(entry.s).toUpperCase();
    /* A bare name the desk has already resolved is filed under the listing it actually is —
       otherwise "RELIANCE" would be offered as a US ticker with no exchange suffix. */
    if (key[0] !== '^' && key.indexOf('.') < 0) {
      const r = D.cachedResolution(key);
      if (r) key = String(r).toUpperCase();
    }
    const d = loadDir(), old = d[key] || {};
    d[key] = {
      s: key,
      n: entry.name || old.n || '',
      x: entry.exchange || old.x || '',
      c: entry.currency || old.c || '',
      q: entry.type || old.q || '',
      t: Date.now(),
      h: (old.h || 0) + (entry.hit ? 1 : 0)
    };
    saveDir();
    return d[key];
  }

  /* Called from the one funnel every live tape passes through. */
  function rememberSeries(series) {
    if (!series || !series.symbol) return;
    const meta = series.meta || {};
    remember({
      s: series.symbol,
      name: meta.longName || meta.shortName || series.shortName || '',
      exchange: meta.exchangeName || (D.venueFor(series.symbol) || {}).id || '',
      currency: series.currency || '',
      type: meta.quoteType || (/^\^/.test(series.symbol) ? 'INDEX' : '')
    });
  }

  function rememberBook(book) {
    if (!book || !book.symbol) return;
    remember({ s: book.symbol, currency: book.currency, exchange: (D.venueFor(book.symbol) || {}).id || '' });
  }

  function clearDir() { U.store.set(DIR_KEY, {}); dir = null; }

  /* ------------------------------------------------------------------ seed file */
  function parseSeed(csv) {
    const out = [];
    String(csv || '').split(/\r?\n/).forEach((line, i) => {
      if (!i || !line) return;
      const f = line.split(',');
      if (f.length < 3) return;
      const kind = SERIES_KIND[(f[2] || '').trim().toUpperCase()];
      const sym = (f[0] || '').trim().toUpperCase();
      if (!kind || !/^[A-Z0-9^&-]{2,}$/.test(sym)) return;
      out.push({ s: sym + '.NS', leaf: sym, name: (f[1] || '').trim(), series: (f[2] || '').trim().toUpperCase(), kind,
        face: Number(f[7]) || Number(f[4]) || null });
    });
    return out;
  }

  function loadSeed(force) {
    if (seed.length && !force) return Promise.resolve(seed);
    if (seedPromise && !force) return seedPromise;
    seedPromise = fetch(SEED_PATH)
      .then(r => (r && r.ok) ? r.text() : '')
      .then(t => { seed = parseSeed(t); return seed; })
      .catch(() => { seed = []; return seed; });     // file:// or a missing refresh: learn as we go
    return seedPromise;
  }

  function seedFace(symbol) {
    const hit = seed.filter(r => r.s === String(symbol).toUpperCase())[0];
    return hit ? hit.face : null;
  }

  /* The full company name behind a ticker, or '' when this machine has never actually seen one —
     a blank label is honest, an invented one would end up in a lecture. Searched in the order the
     desk trusts: a quote that named it, the listing file, then the index series. */
  function nameOf(symbol) {
    const raw = String(symbol || '').trim().toUpperCase();
    if (!raw) return '';
    const known = D.cachedResolution(raw);
    const sym = (raw[0] === '^' || raw.indexOf('.') > 0 || !known) ? raw : String(known).toUpperCase();
    const e = loadDir()[sym];
    if (e && e.n) return e.n;
    const board = seed.filter(r => r.s === sym || (sym === raw && r.leaf === raw.replace(/\.[A-Z]{1,4}$/, '')))[0];
    if (board && board.name) return board.name;
    const ix = D.INDEX_VENUES[sym[0] === '^' ? sym.slice(1) : sym];
    if (ix && ix.name) return ix.name;
    /* A name typed without its caret is still that index — the alias table is what says so. */
    const asIx = sym[0] === '^' ? null : D.INDEX_ALIASES[sym.replace(/[^A-Z0-9]/g, '')];
    if (asIx) {
      const v = D.INDEX_VENUES[asIx.slice(1)];
      if (v && v.name) return v.name;
    }
    /* A tape can be read before its name is remembered, so the suffixed sibling is worth one look. */
    const alt = loadDir()[sym + '.NS'] || loadDir()[sym + '.BO'];
    return (alt && alt.n) || '';
  }

  /* The vendored board answers "is this leaf an Indian listing?" with no request, which is what the
     hint needs before the desk has resolved anything — a bare "TATACHEM" is not a US ticker. */
  function boardSymbol(sym) {
    const raw = String(sym || '').trim().toUpperCase();
    if (!raw || raw[0] === '^' || raw.indexOf('.') > 0) return '';
    const hit = seed.filter(r => r.leaf === raw)[0];
    return hit ? hit.s : '';
  }

  /* ------------------------------------------------------------------ ranking */
  /* A typed query has its spaces stripped by normaliseSymbol, so compare the name both ways: words
     for "starts with a word", flattened so "HDFCBANK" still matches "HDFC Bank Limited". */
  function flatName(name) {
    return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function nameHit(q, name) {
    const raw = String(name || '').toUpperCase();
    if (!raw) return 0;
    const flat = flatName(raw);
    if (flat.startsWith(q)) return 32;
    const words = raw.split(/[^A-Z0-9]+/);
    for (let i = 0; i < words.length; i++) if (words[i].startsWith(q)) return 30 - Math.min(8, i);
    return flat.indexOf(q) >= 0 ? 18 : 0;
  }

  /* 2 when the typed fragment is one of an index's own spellings, 1 when it opens one.
     Without this, "NIFTY" puts ^NIFTYNXT50 first because its leaf starts with the word, and
     "BANKNIFTY" finds nothing at all — the series is stored as ^NSEBANK, "NIFTY BANK". */
  function aliasTier(q, pick) {
    const al = pick.al;
    if (!al || !al.length || q.q.length < 3) return 0;
    let part = 0;
    for (let i = 0; i < al.length; i++) {
      const flat = flatName(al[i]);
      if (flat === q.q) return 2;
      if (!part && flat.indexOf(q.q) === 0) part = 1;
    }
    return part;
  }

  function subseq(q, s) {
    let i = 0;
    for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
    return i === q.length;
  }

  /* A derivative or a currency pair is a contract, not a listed stock: the search endpoint returns
     plenty of both, and one that reaches the directory would keep coming back for months. */
  function isContract(sym, type) {
    const s = String(sym || '').toUpperCase();
    if (type === 'OPTION' || type === 'FUTURE' || type === 'FUTURES' || type === 'FOREX' ||
        type === 'CURRENCY' || type === 'CRYPTOCURRENCY') return true;
    if (s.indexOf('=') >= 0) return true;                 // Yahoo's own FX and futures suffix
    return /[A-Z]\d{6}[CP]\d+$/.test(s);                  // OCC option contract, dotted or bare
  }

  /* One scoring rule for every source, so a suggestion the user clicked can never be ranked by a
     different yardstick than one the directory produced. */
  function scoreEntry(pick, q) {
    if (!q) return 0;
    const sym = pick.s, leaf = pick.leaf || leafOf(sym);
    if (isContract(sym, pick.q)) return 0;
    let s = 0;
    const al = aliasTier(q, pick);
    if (sym === q.norm || sym === q.typed) s = 140;
    else if (leaf === q.q) s = 118;
    /* An index named the way the class says it — "nifty" for ^NSEI, "banknifty" for ^NSEBANK.
       Ahead of the name tiers because the alternative is a scrip that merely carries the word. */
    else if (al === 2) s = 130;
    /* A listing whose whole name is what the user typed — "sensex" for SENSEX, "nifty 50" for
       NIFTY 50 — is the answer, not one of the scrips that merely carry the word in their ticker. */
    else if (q.q.length > 2 && flatName(pick.n) === q.q) s = 105;
    /* A prefix match is worth more the less the user has left to type: ^NSEI should beat ^NSEBANK
       for "NSE", and a two-letter scrip should beat a twenty-letter one. */
    else if (leaf.startsWith(q.q)) s = 92 + Math.min(10, (q.q.length - 1) * 2) - Math.min(14, leaf.length - q.q.length);
    else if (sym.startsWith(q.q)) s = 74 - Math.min(10, sym.length - q.q.length);
    /* The start of an index's own spelling: "dow" for ^DJI ("Dow Jones"), "hang" for ^HSI. */
    else if (al === 1) s = 84;
    else if (leaf.indexOf(q.q) >= 0) s = 52;
    else {
      const nm = nameHit(q.q, pick.n || pick.name);
      s = nm || (subseq(q.q, leaf) ? 12 : 0);
    }
    if (!s) return 0;
    // A typed caret means the user wants a series, not a scrip whose name happens to contain it.
    if (q.carets && sym[0] !== '^') return 0;
    if (q.carets) s += 25;
    const id = (pick.x || (D.venueFor(sym) || {}).id || '').toUpperCase();
    if (q.forced) return (id.indexOf(q.forced) >= 0 || sym.endsWith('.' + q.forced)) ? s : 0;
    if (pick.h) s += Math.min(6, pick.h) * 4;
    if (pick.t && Date.now() - pick.t < 21 * 86400e3) s += 7;
    if (pick.kind === 'sme') s -= 6;
    /* A token somebody typed is only a guess until a quote or the listing file puts a company name on
       it, so it is capped below any real scrip that matches the same fragment. */
    return (!pick.n && sym[0] !== '^') ? Math.min(s, 40) : s;
  }

  /* Local candidates: everything learned, plus the seeded board, plus the index series the data
     layer already knows — those are in no listing file, and "^BSE" is a thing worth typing. */
  function candidates(q) {
    const d = loadDir();
    const map = {};
    Object.keys(d).forEach(k => { const e = d[k]; if (e && e.s) map[e.s] = e; });
    seed.forEach(r => {
      const old = map[r.s] || {};
      map[r.s] = { s: r.s, n: r.name, leaf: r.leaf, x: 'NS', q: 'EQUITY', kind: r.kind, face: r.face,
        t: old.t, h: old.h, src: old.n ? 'both' : 'seed' };
    });
    Object.keys(D.INDEX_VENUES).forEach(k => {
      const sym = '^' + k, v = D.INDEX_VENUES[k], old = map[sym] || {};
      map[sym] = { s: sym, n: v.name, leaf: leafOf(sym), x: k.indexOf('.') > 0 ? k.split('.').pop() : '',
        c: v.cur, q: 'INDEX', al: [v.name].concat(v.alias || []), t: old.t, h: old.h };
    });
    return Object.keys(map).map(k => map[k]);
  }

  /* A row from the relay has no alias list, so an index it discovered would rank only by its display
     name. Look the venue table up so both paths are scored by the same yardstick. */
  function withAlias(p) {
    if (p.al || p.s[0] !== '^') return p;
    const v = D.INDEX_VENUES[p.s.slice(1)];
    return v ? Object.assign({}, p, { al: [v.name].concat(v.alias || []) }) : p;
  }

  function rank(q, picks, limit) {
    const out = [];
    for (let i = 0; i < picks.length; i++) {
      const p = withAlias(picks[i]), s = scoreEntry(p, q);
      if (s > 0) out.push({ p: p, s: s });
    }
    out.sort((a, b) => b.s - a.s || a.p.s.localeCompare(b.p.s));
    return out.slice(0, limit || MAX_SHOW).map(o => shape(o.p, o.s));
  }

  function shape(p, s) {
    const v = D.venueFor(p.s) || {};
    return {
      symbol: p.s,
      name: p.n || p.name || '',
      currency: p.c || (v.meta && v.meta.cur) || '',
      exchange: (v.meta && v.meta.name) || p.x || '',
      tag: p.x || (v.id || ''),
      type: p.q || p.kind || '',
      face: p.face || null,
      hits: p.h || 0,
      score: s
    };
  }

  function search(raw, o) {
    o = o || {};
    const q = parseQuery(raw);
    if (q.q.length < (o.min || MIN_CHARS)) return [];
    return rank(q, candidates(q));
  }

  /* ------------------------------------------------------------------ relayed suggestions
     The search endpoint answers with the exchange's own spelling, so it is the only way to discover
     a listing this machine has never quoted. It is spent only when the local answer is thin. */
  function parseSearch(payload) {
    const quotes = (payload && payload.quotes) || [];
    const out = [];
    quotes.forEach(x => {
      if (!x || !x.symbol) return;
      /* A currency pair is not a scrip, and an option contract is not a listing the desk can chart —
         offering one invites a watch row that will never fill. */
      if (x.quoteType === 'FOREX' || x.quoteType === 'OPTION') return;
      out.push({ s: String(x.symbol).toUpperCase(), name: x.longname || x.shortname || '',
        exchange: x.exchDisp || x.exchange || '', x: x.exchange || '', c: x.currency || '', type: x.quoteType || '' });
    });
    return out;
  }

  async function suggest(raw, cfg) {
    const q = parseQuery(raw);
    if (q.q.length < MIN_CHARS) return [];
    const cache = U.store.get(SUG_KEY, {}) || {};
    const k = q.q;
    if (cache[k] && Date.now() - cache[k].t < SUG_TTL) {
      return rank(q, cache[k].r.map(r => Object.assign({ t: cache[k].t }, r)));
    }
    const url = SEARCH_BASE + '?q=' + encodeURIComponent(q.typed) + '&quotesCount=12&newsCount=0&enableFuzzyQuery=false';
    let res;
    try {
      res = await D.fetchJson(url, cfg || {}, looksLikeSearch);
    } catch (e) {
      return [];                                          // a dead relay must not eat the dropdown
    }
    const rows = parseSearch(res.payload);
    cache[k] = { t: Date.now(), r: rows.map(r => ({ s: r.s, n: r.name, x: r.exchange, c: r.c, q: r.type })) };
    U.store.set(SUG_KEY, cache);
    rows.forEach(r => remember({ s: r.s, name: r.name, currency: r.c, type: r.type, exchange: r.exchange }));
    return rank(q, cache[k].r.map(r => Object.assign({ t: cache[k].t }, r)));
  }

  function looksLikeSearch(txt) {
    if (!txt) return 'empty body';
    if (txt.indexOf('"quotes"') < 0) return 'search returned no quotes array';
    return true;
  }

  function clearSuggest() { U.store.set(SUG_KEY, {}); }

  /* ------------------------------------------------------------------ dropdown */
  let openCtrl = null;                                     // one dropdown at a time, always

  function popupEl() {
    let el = document.getElementById('tkPop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tkPop';
      el.setAttribute('role', 'listbox');
      el.setAttribute('aria-label', 'Ticker suggestions');
      document.body.appendChild(el);
    }
    return el;
  }

  function rowLabel(it) {
    return '<span class="tk-sym">' + U.escapeHtml(it.symbol) + '</span>' +
      '<span class="tk-name">' + U.escapeHtml(it.name || '—') + '</span>' +
      '<span class="tk-where">' + U.escapeHtml(it.tag || it.type || '') + (it.currency ? ' · ' + U.escapeHtml(it.currency) : '') + '</span>';
  }

  function attach(input, o) {
    o = o || {};
    const pop = popupEl();
    let items = [], act = -1, timer = 0, seq = 0, mine = 0;

    /* The popup element is shared by every ticker box, so ownership decides whose rows a click hits:
       only the owner may paint or clear it. */
    function close() {
      if (openCtrl === ctrl) { pop.hidden = true; pop.innerHTML = ''; openCtrl = null; }
      items = []; act = -1;
      input.removeAttribute('aria-expanded');
      input.removeAttribute('aria-activedescendant');
    }

    function place() {
      const r = input.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const w = Math.max(Math.min(r.width, vw - 16), 240);
      pop.style.width = w + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
      const below = vh - r.bottom;
      if (below < 170 && r.top > 220) {
        pop.style.top = 'auto';
        pop.style.bottom = Math.round(vh - r.top + 4) + 'px';
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = Math.round(r.bottom + 4) + 'px';
        pop.style.maxHeight = Math.min(320, Math.max(140, below - 12)) + 'px';
      }
    }

    /* Scrolling must not throw the list away — a watch stack re-laying itself out is not the user
       leaving the box. Follow the input while it is on screen, drop the list once it is not. */
    function refresh() {
      if (openCtrl !== ctrl || pop.hidden) return;
      const r = input.getBoundingClientRect();
      if (!input.offsetParent || r.width === 0 || r.bottom < 4 || r.top > document.documentElement.clientHeight - 4) close();
      else place();
    }

    function paint(list, note) {
      items = list;
      // A box inside a hidden view has nothing to anchor to; it must not steal the shared popup.
      if (!input.offsetParent) { close(); return; }
      if (!list.length && !note) { close(); return; }
      openCtrl = ctrl;
      pop.innerHTML = list.map((it, i) =>
        '<div class="tk-row' + (i === act ? ' is-on' : '') + '" role="option" id="tkOpt' + i + '"' +
        ' aria-selected="' + (i === act ? 'true' : 'false') + '" data-i="' + i + '"' +
        (it.name ? ' title="' + U.escapeHtml(it.name) + '"' : '') + '>' + rowLabel(it) + '</div>').join('') +
        (note ? '<p class="tk-note">' + U.escapeHtml(note) + '</p>' : '');
      pop.hidden = false;
      place();
      input.setAttribute('aria-expanded', 'true');
      if (act >= 0) input.setAttribute('aria-activedescendant', 'tkOpt' + act);
    }

    function run(raw, cfg) {
      const local = search(raw);
      mine = ++seq;
      loadSeed().then(() => {
        if (mine !== seq || !input.offsetParent || document.activeElement !== input) return;
        paint(local, local.length ? '' : 'No listing matches that yet.');
        // The desk carries its own index table, so a caret query never needs the relay.
        if (local.length >= 5 || parseQuery(raw).carets) return;
        suggest(raw, cfg).then(remote => {
          if (mine !== seq || !input.offsetParent || document.activeElement !== input) return;
          const seen = {};
          const merged = local.concat(remote).filter(x => !seen[x.symbol] && (seen[x.symbol] = true));
          paint(merged.slice(0, MAX_SHOW), '');
        });
      });
    }

    function pick(i) {
      const it = items[i];
      if (!it) return false;
      remember({ s: it.symbol, name: it.name, currency: it.currency, type: it.type, hit: true });
      close();
      if (o.onPick) o.onPick(it, input); else input.value = it.symbol;
      return true;
    }

    U.on(input, 'input', () => {
      clearTimeout(timer);
      const raw = fragmentOf(input.value, o.tokens);
      if (raw.length < MIN_CHARS) { close(); return; }
      timer = setTimeout(() => run(raw, o.cfg && o.cfg()), DEBOUNCE);
    });

    U.on(input, 'keydown', e => {
      const shown = openCtrl === ctrl && !pop.hidden;
      if (e.key === 'Escape') { if (shown) { close(); e.stopPropagation(); } return; }
      if (!shown) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        act = (act + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paint(items, '');
        const row = pop.children[act];
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && act >= 0) {
        e.preventDefault(); e.stopPropagation(); pick(act);
      }
    });

    U.on(pop, 'mousedown', e => {
      if (openCtrl !== ctrl) return;                       // the other box's rows are not ours to pick
      const row = e.target.closest && e.target.closest('.tk-row');
      if (!row) return;
      e.preventDefault();                                  // beat the input's blur
      pick(Number(row.dataset.i));
    });

    U.on(input, 'blur', () => setTimeout(() => {
      if (openCtrl === ctrl && document.activeElement !== input) close();
    }, 140));
    U.on(input, 'focus', () => {
      const raw = fragmentOf(input.value, o.tokens);
      if (raw.length >= MIN_CHARS) run(raw, o.cfg && o.cfg());
    });

    const ctrl = { close, pick, refresh, get items() { return items; }, input };
    return ctrl;
  }

  /* Whatever the desk already knows about — every basket of the watch list, from the saved store so
     this works before any row has been drawn. A watch list can hold a name the user typed bare, so
     it goes through the resolution cache first: a bare "RELIANCE" is not a listing, and offering it
     above RELIANCE.NS with a guessed US venue would be a lie. */
  function learnFromWatchlists() {
    const wl = U.store.get('watchlist', {});
    const baskets = (wl && wl.baskets) || {};
    Object.keys(baskets).forEach(k => (baskets[k] || []).forEach(s => {
      const sym = D.cachedResolution(s) || D.normaliseSymbol(s);
      if (sym) remember({ s: sym });
    }));
  }

  /* Whoever is switching the view out from under a focused ticker box must clear its list — the
     popup is fixed, so it would otherwise float over the next tab. */
  function closeAll() { if (openCtrl) openCtrl.close(); }

  function init() {
    /* Scrolling must not throw the list away — a watch stack re-laying itself out is not the user
       leaving the box. The owner follows its own input and closes only when that leaves the screen. */
    const follow = () => { if (openCtrl) openCtrl.refresh(); };
    window.addEventListener('resize', follow);
    document.addEventListener('scroll', follow, true);
    learnFromWatchlists();
    loadSeed();
  }

  return {
    init, attach, closeAll, search, suggest, rank, parseQuery, parseSearch, parseSeed,
    remember, rememberSeries, rememberBook, learnFromWatchlists, loadSeed, seedFace,
    get seedCount() { return seed.length; },
    get dirCount() { return Object.keys(loadDir()).length; },
    leafOf, fragmentOf, isContract, nameOf, boardSymbol, clearDir, clearSuggest
  };
})();
