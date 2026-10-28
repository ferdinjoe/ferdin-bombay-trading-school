/* Structure Desk — market data access.
   Public no-key quote endpoint (Yahoo v8 chart) reached through a CORS-proxy failover chain,
   plus manual CSV override so the desk never goes dark when a feed is rate-limited. */
SD.Data = (function () {
  'use strict';

  /* ---------------------------------------------------------------- venues
     Exchange is inferred from the ticker suffix/prefix so one input covers NSE, BSE,
     US listings and the major global venues. Session clocks drive "is this bar closed?". */
  const VENUES = {
    NS:  { name: 'NSE India',        tz: 'Asia/Kolkata',     cur: 'INR', sessions: [[555, 930]],   tag: 'in' },
    BO:  { name: 'BSE India',        tz: 'Asia/Kolkata',     cur: 'INR', sessions: [[555, 930]],   tag: 'in' },
    DEFAULT_US: { name: 'US equities', tz: 'America/New_York', cur: 'USD', sessions: [[570, 960]], prePost: true, tag: 'us' },
    L:   { name: 'London SE',        tz: 'Europe/London',    cur: 'GBP', sessions: [[480, 990]],   tag: 'eu' },
    DE:  { name: 'Xetra Frankfurt',  tz: 'Europe/Berlin',    cur: 'EUR', sessions: [[540, 1050]],  tag: 'eu' },
    MU:  { name: 'Tradegate',        tz: 'Europe/Berlin',    cur: 'EUR', sessions: [[510, 1230]],  tag: 'eu' },
    PA:  { name: 'Euronext Paris',   tz: 'Europe/Paris',     cur: 'EUR', sessions: [[540, 1020]],  tag: 'eu' },
    AS:  { name: 'Euronext Amsterdam', tz: 'Europe/Amsterdam', cur: 'EUR', sessions: [[540, 1020]], tag: 'eu' },
    MI:  { name: 'Borsa Milano',     tz: 'Europe/Rome',      cur: 'EUR', sessions: [[540, 960]],   tag: 'eu' },
    MC:  { name: 'BME Madrid',       tz: 'Europe/Madrid',    cur: 'EUR', sessions: [[540, 990]],   tag: 'eu' },
    SW:  { name: 'SIX Switzerland',  tz: 'Europe/Zurich',    cur: 'CHF', sessions: [[540, 1170]],  tag: 'eu' },
    HE:  { name: 'Helsinki',         tz: 'Europe/Helsinki',  cur: 'EUR', sessions: [[600, 1020]],  tag: 'eu' },
    ST:  { name: 'Stockholm',        tz: 'Europe/Stockholm', cur: 'SEK', sessions: [[540, 1020]],  tag: 'eu' },
    OL:  { name: 'Oslo',             tz: 'Europe/Oslo',      cur: 'NOK', sessions: [[540, 1020]],  tag: 'eu' },
    CO:  { name: 'Copenhagen',       tz: 'Europe/Copenhagen',cur: 'DKK', sessions: [[540, 1020]],  tag: 'eu' },
    TB:  { name: 'Borsa Istanbul',   tz: 'Europe/Istanbul',  cur: 'TRY', sessions: [[570, 1080]],  tag: 'eu' },
    TA:  { name: 'Tel Aviv',         tz: 'Asia/Jerusalem',   cur: 'ILS', sessions: [[600, 930]],   tag: 'me' },
    SI:  { name: 'Singapore (SGX)',  tz: 'Asia/Singapore',   cur: 'SGD', sessions: [[540, 750], [825, 1035]], tag: 'as' },
    HK:  { name: 'HKEX',             tz: 'Asia/Hong_Kong',   cur: 'HKD', sessions: [[570, 720], [780, 960]], tag: 'as' },
    T:   { name: 'Tokyo (TSE)',      tz: 'Asia/Tokyo',       cur: 'JPY', sessions: [[540, 690], [750, 900]], tag: 'as' },
    KS:  { name: 'KRX Korea',        tz: 'Asia/Seoul',       cur: 'KRW', sessions: [[540, 930]],   tag: 'as' },
    SS:  { name: 'Shanghai',         tz: 'Asia/Shanghai',    cur: 'CNY', sessions: [[555, 690], [780, 900]], tag: 'as' },
    SZ:  { name: 'Shenzhen',         tz: 'Asia/Shanghai',    cur: 'CNY', sessions: [[555, 690], [780, 900]], tag: 'as' },
    JK:  { name: 'IDX Jakarta',      tz: 'Asia/Jakarta',     cur: 'IDR', sessions: [[510, 720]],   tag: 'as' },
    BK:  { name: 'IDX Jakarta',      tz: 'Asia/Jakarta',     cur: 'IDR', sessions: [[510, 720]],   tag: 'as' },
    KL:  { name: 'Bursa Malaysia',   tz: 'Asia/Kuala_Lumpur',cur: 'MYR', sessions: [[540, 720], [855, 1110]], tag: 'as' },
    AX:  { name: 'ASX Sydney',       tz: 'Australia/Sydney', cur: 'AUD', sessions: [[600, 960]],   tag: 'oc' },
    NZ:  { name: 'NZX',              tz: 'Pacific/Auckland', cur: 'NZD', sessions: [[600, 960]],   tag: 'oc' },
    SA:  { name: 'B3 São Paulo',     tz: 'America/Sao_Paulo',cur: 'BRL', sessions: [[570, 960]],   tag: 'am' },
    MX:  { name: 'BMV Mexico',       tz: 'America/Mexico_City', cur: 'MXN', sessions: [[545, 1055]], tag: 'am' },
    TO:  { name: 'Toronto',          tz: 'America/Toronto',  cur: 'CAD', sessions: [[570, 960]],   tag: 'na' },
    VN:  { name: 'HOSE',             tz: 'Asia/Ho_Chi_Minh', cur: 'VND', sessions: [[510, 660], [780, 900]], tag: 'as' },
    PH:  { name: 'Philippine SE',    tz: 'Asia/Manila',      cur: 'PHP', sessions: [[540, 960]],   tag: 'as' }
  };

  /* `alias` is every other spelling a trader uses for the same series — Yahoo stores BANKNIFTY as
     ^NSEBANK and SPX as ^GSPC, so without a table the desk would 404 through scrip guesses while the
     chart the class actually needs sits one caret away. Only names answered by the feed are here. */
  const INDEX_VENUES = {
    NSEI: { name: 'NIFTY 50', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY', 'CNX NIFTY'] },
    BSESN: { name: 'SENSEX', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['SENSEX', 'BSENSEX', 'BSE 30', 'BSE SENSEX'] },
    NIFTYNXT50: { name: 'NIFTY NEXT 50', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY NEXT 50', 'NEXT 50'] },
    MIDCPNIFTY: { name: 'NIFTY Midcap', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY MIDCAP'] },
    INDIAVIX: { name: 'INDIA VIX', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['INDIA VIX'] },
    'S&PX': { name: 'S&P CNX', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['S&P CNX'] },
    /* Sectoral + broad NSE indices. Each entry here was confirmed live against the quote
       endpoint on 2026-10-26; anything not listed is labelled "Global index" and will 404. */
    NSEBANK: { name: 'NIFTY BANK', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['BANKNIFTY', 'BANK NIFTY', 'NIFTY BANK'] },
    CNXIT: { name: 'NIFTY IT', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY IT'] },
    CNXAUTO: { name: 'NIFTY AUTO', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY AUTO'] },
    CNXFMCG: { name: 'NIFTY FMCG', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY FMCG'] },
    CNXPHARMA: { name: 'NIFTY PHARMA', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY PHARMA'] },
    CNXMETAL: { name: 'NIFTY METAL', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY METAL'] },
    CNXENERGY: { name: 'NIFTY ENERGY', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY ENERGY'] },
    CNXMEDIA: { name: 'NIFTY MEDIA', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY MEDIA'] },
    CNX100: { name: 'NIFTY 100', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY 100'] },
    NSEMDCP50: { name: 'NIFTY Midcap 50', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['NIFTY MIDCAP 50', 'MIDCAP 50'] },
    STI: { name: 'Straits Times Index', tz: 'Asia/Singapore', cur: 'SGD', sessions: [[540, 750], [825, 1035]], tag: 'as',
      alias: ['STI', 'Straits Times'] },
    GSPC: { name: 'S&P 500', tz: 'America/New_York', cur: 'USD', sessions: [[510, 960]], tag: 'us',
      alias: ['SPX', 'S&P 500'] },
    IXIC: { name: 'Nasdaq Composite', tz: 'America/New_York', cur: 'USD', sessions: [[510, 960]], tag: 'us',
      alias: ['NASDAQ', 'NASCOM', 'NASDAQ COMPOSITE'] },
    NDX: { name: 'Nasdaq 100', tz: 'America/New_York', cur: 'USD', sessions: [[510, 960]], tag: 'us',
      alias: ['NASDAQ 100', 'NAS100'] },
    DJI: { name: 'Dow Jones', tz: 'America/New_York', cur: 'USD', sessions: [[570, 960]], tag: 'us',
      /* No bare "DOW" — that is Dow Inc., a listed equity, and the desk must not steal it. */
      alias: ['DOW JONES', 'DJIA', 'DOW 30'] },
    RUT: { name: 'Russell 2000', tz: 'America/New_York', cur: 'USD', sessions: [[570, 960]], tag: 'us',
      alias: ['RUSSELL', 'RUSSELL 2000'] },
    VIX: { name: 'CBOE VIX', tz: 'America/Chicago', cur: 'USD', sessions: [[510, 960]], tag: 'us',
      alias: ['CBOE VIX', 'FEAR GAUGE'] },
    FTSE: { name: 'FTSE 100', tz: 'Europe/London', cur: 'GBP', sessions: [[480, 990]], tag: 'eu',
      alias: ['FTSE 100', 'FOOTSE'] },
    STOXX50E: { name: 'EURO STOXX 50', tz: 'Europe/Paris', cur: 'EUR', sessions: [[540, 1020]], tag: 'eu',
      alias: ['EURO STOXX 50', 'STOXX 50'] },
    N225: { name: 'Nikkei 225', tz: 'Asia/Tokyo', cur: 'JPY', sessions: [[540, 690], [750, 900]], tag: 'as',
      alias: ['NIKKEI', 'NIKKEI 225'] },
    HSI: { name: 'Hang Seng', tz: 'Asia/Hong_Kong', cur: 'HKD', sessions: [[570, 720], [780, 960]], tag: 'as',
      alias: ['HANG SENG', 'HSI'] },
    KOSPI: { name: 'KOSPI', tz: 'Asia/Seoul', cur: 'KRW', sessions: [[540, 930]], tag: 'as',
      alias: ['KOSPI'] },
    AS51: { name: 'ASX 200', tz: 'Australia/Sydney', cur: 'AUD', sessions: [[600, 960]], tag: 'oc',
      alias: ['ASX 200'] },
    '000300.SS': { name: 'CSI 300', tz: 'Asia/Shanghai', cur: 'CNY', sessions: [[555, 690], [780, 900]], tag: 'as',
      alias: ['CSI 300'] },
    STOI: { name: 'STOXX India', tz: 'Asia/Kolkata', cur: 'INR', sessions: [[555, 930]], tag: 'in',
      alias: ['STOXX INDIA'] }
  };

  /* Flat lookup: every alias and every display name, spaces and punctuation removed, so "NIFTY 50",
     "nifty50" and "NIFTY-50" all reach ^NSEI. First writer wins — NSEI is listed before the others
     because "NIFTY" alone means the 50, not the sectoral or the midcap. */
  const INDEX_ALIASES = (function () {
    const m = {};
    Object.keys(INDEX_VENUES).forEach(k => {
      const v = INDEX_VENUES[k];
      [v.name].concat(v.alias || []).forEach(a => {
        const flat = String(a).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (flat && !m[flat]) m[flat] = '^' + k;
      });
    });
    return m;
  })();

  const INDIA_HINTS = /^(RELIANCE|TATA|INFY|HCLTECH|SBIN|HDFC|ICICIBANK|AXISBANK|ITC|LT|BHARTIARTL|ASIANPAINT|MARUTI|SUNPHARMA|TITAN|WIPRO|BAJFINANCE|ADANIENT|ZOMATO|PAYTM|DLF|JSWSTEEL|TATAMOTORS|NTPC|POWERGRID|ONGC|COALINDIA|HAL|BEL|IRCTC|VEDL|TATASTEEL|JINDALSTEL|HINDALCO|URBANCLAVE|PAGEIND|ZOMATO)/i;

  const INTERVAL_SECONDS = {
    '1m': 60, '2m': 120, '5m': 300, '15m': 900, '30m': 1800, '60m': 3600, '1h': 3600,
    '90m': 5400, '2h': 7200, '4h': 14400, '1d': 86400, '5d': 432000, '1wk': 604800,
    '1mo': 2592000, '3mo': 7776000
  };

  /* Free, key-less CORS relays. Verified live on 2026-10-26: r.jina.ai answers keyless;
     corsproxy.io now demands an API key (401) and allorigins/codetabs/cors.lol were down or
     rate-limited, so they stay as fallbacks rather than the first try. Direct is last: the quote
     endpoint sends no Access-Control-Allow-Origin, so a browser call to it always fails. */
  const DEFAULT_PROXY_CHAIN = [
    'https://r.jina.ai/{url}',
    'https://api.allorigins.win/raw?url={url}',
    'https://api.codetabs.com/v1/proxy?quest={url}',
    'https://api.cors.lol/?url={url}',
    'https://thingproxy.freeboard.io/fetch/{url}',
    'https://corsproxy.io/?url={url}',
    ''
  ];

  /* ---------------------------------------------------------------- symbols
     Yahoo has no way to tell from a bare name which Indian venue carries the scrip —
     CROPSTER exists only as CROPSTER.BO while RELIANCE is live on both .NS and .BO — so a
     bare name becomes an ordered candidate list and the loader tries them until one answers. */
  const EXCHANGE_TOKENS = { NSE: '.NS', NSEI: '.NS', NS: '.NS', BSE: '.BO', BO: '.BO', NYSE: '', NASDAQ: '' };
  const RES_TTL = 12 * 3600 * 1000;

  function isBareName(s) {
    return s[0] !== '^' && s.indexOf('.') < 0 && s.indexOf('-') < 0 && s.indexOf('=') < 0 && /^[A-Z0-9&]{2,10}$/.test(s);
  }

  function symbolCandidates(raw, cfg) {
    const s = normaliseSymbol(raw);
    if (!s) return [];
    // BSE script codes are numeric (500325); NSE never uses them, so BSE goes first.
    if (/^\d{5,6}$/.test(s)) return [s + '.BO', s + '.NS', s];
    /* A spoken index name is not a scrip guess: "NIFTY" means ^NSEI, and trying NIFTY.NS first
       would spend three relays and land on an unrelated equity if one ever took the name.
       Only a bare, unpunctuated word qualifies — a typed caret or suffix already says the venue. */
    if (isBareName(s)) {
      const ix = INDEX_ALIASES[s.replace(/[^A-Z0-9]/g, '')];
      if (ix) {
        const known = cachedResolution(s);
        // A resolution this machine already read beats a name match — it is evidence, not a guess.
        return (known ? [known, ix, s] : [ix, s]).filter((v, i, a) => a.indexOf(v) === i);
      }
    }
    if (!isBareName(s)) return [s];
    /* A bare name carries no venue, and Yahoo splits India across two suffixes with no rule that
       predicts either: CROPSTER lives on BSE only, RELIANCE is live on both, AAPL on neither. So try the
       ordered guesses and keep whichever answered — including the plain name, which is cached the
       same way, so a US ticker under an Indian home costs the extra 404s exactly once. */
    const indiaFirst = INDIA_HINTS.test(s) || (cfg && cfg.home === 'IN');
    const order = indiaFirst ? ['.NS', '.BO', ''] : ['', '.NS', '.BO'];
    const out = order.map(sfx => s + sfx);
    const cached = cachedResolution(s);
    if (cached) out.unshift(cached);
    return out.filter((v, i, a) => a.indexOf(v) === i);
  }

  function resCache() {
    const c = SD.U.store.get('symResolution', {});
    const now = Date.now();
    Object.keys(c).forEach(k => { if (!c[k] || !c[k].s || now - c[k].t > RES_TTL) delete c[k]; });
    return c;
  }
  function cachedResolution(raw) {
    const s = normaliseSymbol(raw);
    const hit = s && resCache()[s];
    return hit ? hit.s : null;
  }
  function rememberResolution(raw, resolved) {
    if (!raw || !resolved) return;
    const c = resCache();
    c[normaliseSymbol(raw)] = { s: resolved, t: Date.now() };
    SD.U.store.set('symResolution', c);
  }
  function forgetResolution(raw) {
    const c = resCache();
    delete c[normaliseSymbol(raw)];
    SD.U.store.set('symResolution', c);
  }
  function clearResolutions() { SD.U.store.set('symResolution', {}); }

  function orderedSymbols(raw, cfg) {
    return symbolCandidates(raw, cfg);
  }

  /* A dead relay and a missing scrip need opposite handling: the first must abort the whole
     poll, the second only disqualify the one candidate that answered 404. */
  function isNotFound(e) {
    return /404|not found|no bars returned|unrecognised payload|chart api v8|no data found|may be delisted|invalid symbol/i.test(String(e && e.message || e));
  }

  function normaliseSymbol(raw) {
    const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!s) return null;
    if (s.startsWith('^') || s.startsWith('=') || s.startsWith('USDINR') || s.indexOf('-') > 0) return s;
    // "NSE:RELIANCE", "RELIANCE:NSE", "CROPSTER:BO" — the exchange word can sit on either side
    const colon = s.split(':');
    if (colon.length === 2) {
      const head = EXCHANGE_TOKENS[colon[0]];
      const tail = EXCHANGE_TOKENS[colon[1]];
      if (head !== undefined) return colon[1] + head;
      if (tail !== undefined) return colon[0] + tail;
    }
    // ".NSE"/".BSE" are how brokers write it, ".NS"/".BO" is how Yahoo stores it
    return s.replace(/\.(NSE|BSE)$/, m => m === '.NSE' ? '.NS' : '.BO');
  }

  function venueFor(symbol) {
    if (!symbol) return { id: 'DEFAULT_US', meta: VENUES.DEFAULT_US, resolved: symbol };
    if (symbol[0] === '^') {
      const key = symbol.slice(1);
      const dot = symbol.lastIndexOf('.');
      const k2 = dot > 1 ? symbol.slice(1, dot) + symbol.slice(dot) : key;
      const hit = INDEX_VENUES[k2] || INDEX_VENUES[key];
      if (hit) return { id: key, meta: hit, resolved: symbol };
      // ^XYZ.DE etc
      const suf = symbol.split('.').pop();
      if (VENUES[suf]) return { id: suf, meta: VENUES[suf], resolved: symbol };
      return { id: 'GLOBAL', meta: { name: 'Global index', tz: 'UTC', cur: 'USD', sessions: [[0, 1440]], tag: 'ix' }, resolved: symbol };
    }
    const parts = symbol.split('.');
    if (parts.length > 1) {
      const suf = parts[parts.length - 1].toUpperCase();
      if (VENUES[suf]) return { id: suf, meta: VENUES[suf], resolved: symbol };
    }
    /* A name this table already knows is an index reads as that index before a quote ever confirms
       it, so the hint under the typing box says "NIFTY 50 · INR" instead of a US default. */
    if (isBareName(symbol)) {
      const ix = INDEX_ALIASES[symbol.replace(/[^A-Z0-9]/g, '')];
      if (ix) return venueFor(ix);
    }
    // Bare names are resolved by the candidate chain in fetchSeries, not guessed here.
    return { id: 'US', meta: VENUES.DEFAULT_US, resolved: symbol };
  }

  function describeSymbol(raw, cfg) {
    const n = normaliseSymbol(raw);
    const cached = cachedResolution(n);
    const v = venueFor(cached || n);
    const intraday = v.meta.cur + ' · ' + v.meta.name + ' · ' + v.meta.tz;
    const from = cached || (n !== v.resolved ? n : null);
    const parts = [v.meta.name, v.meta.tz, v.meta.cur];
    if (from && from !== v.resolved) parts.unshift(from + ' → ' + v.resolved);
    else if (cached) parts.unshift(v.resolved);
    return { symbol: v.resolved, venue: v.meta, hint: parts.join(' · '), cached: cached, candidates: symbolCandidates(n, cfg) };
  }

  function intervalSeconds(iv, bars) {
    if (bars && bars.length > 2) {
      // Trust the feed's own cadence over the requested label (weekly/monthly buckets vary).
      const deltas = [];
      for (let i = 1; i < Math.min(bars.length, 30); i++) deltas.push(bars[i].t - bars[i - 1].t);
      const med = SD.U.median(deltas) / 1000;
      if (isFinite(med) && med >= 30) return med;
    }
    return INTERVAL_SECONDS[iv] || 86400;
  }

  /* ---------------------------------------------------------------- relay walk
     The chain, the per-request budget and the JSON extraction are the same job whatever endpoint
     is behind the relay, so the fundamentals loader reuses this instead of re-implementing
     failover. `validator` decides whether a body is worth parsing — a relay that answers HTML for
     a JSON URL is a failed path, not a response. A validator returns `true` to accept a body or a
     message to record for that path, so each endpoint keeps its own wording in the attempt log. */
  async function fetchThroughChain(url, cfg, validator, attempts) {
    const log = attempts || [];
    const chain = Array.isArray(cfg.chain) && cfg.chain.length ? cfg.chain : (cfg.proxy ? [cfg.proxy] : ['']);
    const budget = cfg.budget || 22000;
    const t0 = Date.now();
    let lastErr = null;
    for (const tpl of chain) {
      const left = budget - (Date.now() - t0);
      if (left < 1500) break;
      const full = proxied(url, tpl);
      try {
        const txt = await fetchText(full, Math.min(cfg.timeout || 8000, left));
        if (validator) {
          const ok = validator(txt);
          if (ok !== true) throw new Error(ok || 'relay returned no payload');
        }
        return { payload: extractJson(txt), via: tpl ? String(tpl).split('/')[2] : 'direct' };
      } catch (e) {
        lastErr = e;
        log.push((tpl || 'direct') + ': ' + e.message);
      }
    }
    const err = new Error('no relay returned data (' + log.length + ' of ' + chain.length + ' paths failed: ' + log.slice(0, 3).join('; ') + ')');
    err.relayAttempts = log;
    err.lastErr = lastErr;
    throw err;
  }

  /* ---------------------------------------------------------------- request */
  function buildUrl(base, symbol, spec) {
    const q = [];
    if (spec.period1 && spec.period2) {
      q.push('period1=' + Math.floor(spec.period1 / 1000));
      q.push('period2=' + Math.ceil(spec.period2 / 1000));
    } else if (spec.range) {
      q.push('range=' + encodeURIComponent(spec.range));
    }
    q.push('interval=' + encodeURIComponent(spec.interval));
    q.push('events=div%2Csplit');
    if (spec.prePost) q.push('includePrePost=true');
    return base + encodeURIComponent(symbol) + '?' + q.join('&');
  }

  function proxied(url, template) {
    if (!template) return url;
    return template.replace('{url}', encodeURIComponent(url));
  }

  async function fetchText(url, ms) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), ms || 8000);
    try {
      const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'Accept': 'application/json,text/plain;q=0.9,*/*;q=0.8' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } catch (e) {
      if (e && (e.name === 'AbortError')) throw new Error('timeout after ' + ms + 'ms');
      throw e;
    } finally {
      clearTimeout(to);
    }
  }

  function looksLikeChartPayload(txt) {
    if (!txt) return false;
    return txt.indexOf('"chart"') >= 0 || txt.indexOf('"indicators"') >= 0 || txt.indexOf('quote') >= 0;
  }

  /* Yahoo answers with a JSON body, but some relays wrap it in HTML or prefix it with noise. */
  function extractJson(txt) {
    if (!txt) throw new Error('empty response');
    const t = txt.trim();
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    const start = t.indexOf('{"chart"');
    const s2 = start >= 0 ? start : t.indexOf('{');
    if (s2 < 0) throw new Error('non-JSON relay response');
    // Balanced-brace scan beats a greedy regex on wrapped bodies.
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = s2; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') { depth++; }
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) throw new Error('truncated payload');
    return JSON.parse(t.slice(s2, end + 1));
  }

  /* ---------------------------------------------------------------- parse */
  function parseChart(payload, spec, venue) {
    // r.jina.ai answers an Accept: application/json request by wrapping the body in data.content.
    if (payload && payload.data && typeof payload.data.content === 'string') {
      try { payload = JSON.parse(payload.data.content); } catch (e) { /* leave as-is */ }
    }
    const chart = payload && payload.chart ? payload.chart : payload;
    if (chart && chart.error) {
      // A wrong venue suffix can come back as an error body ("No data found, symbol may be
      // delisted") rather than a bare 404. The candidate chain must read that as "this scrip is
      // not here" and keep probing, never as a dead relay.
      const desc = chart.error.description || chart.error.code;
      throw new Error('Feed: ' + (chart.error.code ? chart.error.code + ' — ' : '') + desc);
    }
    const result = chart && chart.result ? chart.result[0] : null;
    if (!result) throw new Error('unrecognised payload shape');
    const ts = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote) ? result.indicators.quote[0] : {};
    const adj = (result.indicators && result.indicators.adjclose) ? (result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose) : null;
    const meta = result.meta || {};
    const bars = [];
    const now = Date.now();
    const stepSec = INTERVAL_SECONDS[spec.interval] || 86400;
    for (let i = 0; i < ts.length; i++) {
      const c = q.close ? q.close[i] : null;
      if (c === null || c === undefined || !(c > 0)) continue;
      const t = ts[i] * 1000;
      const o = q.open ? (q.open[i] == null ? c : q.open[i]) : c;
      const h = q.high ? (q.high[i] == null ? Math.max(o, c) : q.high[i]) : Math.max(o, c);
      const l = q.low ? (q.low[i] == null ? Math.min(o, c) : q.low[i]) : Math.min(o, c);
      const v = q.volume ? (q.volume[i] == null ? 0 : q.volume[i]) : 0;
      bars.push({
        t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v,
        adj: adj && adj[i] != null ? adj[i] : c,
        closed: (t + stepSec * 1000) <= now
      });
    }
    if (!bars.length) throw new Error('no bars returned for this window');
    /* In a user-specified window chartPreviousClose is the close *before* period1, not the bar
       the last print follows, so "Chg" would read as the whole-window move. Use the prior bar. */
    const ranged = !!(spec.period1 && spec.period2);
    const priorBar = bars.length > 1 ? bars[bars.length - 2].c : null;
    return {
      bars, meta, venue,
      symbol: meta.symbol || spec.symbol,
      currency: meta.currency || venue.meta.cur,
      exchange: meta.fullExchangeName || meta.exchangeName || venue.meta.name,
      timezone: meta.exchangeTimezoneName || venue.meta.tz,
      lastPrice: meta.regularMarketPrice != null ? meta.regularMarketPrice : bars[bars.length - 1].c,
      prevClose: ranged ? priorBar
        : meta.chartPreviousClose != null ? meta.chartPreviousClose
        : meta.previousClose != null ? meta.previousClose : priorBar,
      marketState: meta.regularMarketState || meta.marketState || '',
      regularMarketTime: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
      granularity: meta.dataGranularity || spec.interval,
      span: bars[bars.length - 1].t - bars[0].t,
      events: result.events || null
    };
  }

  /* 1m data is capped at ~7 days per call, 5m–90m at ~60 days. Long intraday
     custom windows therefore need chunked requests stitched back together. */
  function chunkLimitSec(interval) {
    if (interval === '1m') return 7 * 86400;
    if (interval === '2m' || interval === '5m' || interval === '15m' || interval === '30m' || interval === '60m' || interval === '90m' || interval === '1h' || interval === '2h' || interval === '4h') return 60 * 86400;
    return Infinity;
  }

  /* BSE publishes its own quote API, but it is not reachable from a browser (no CORS headers,
     and it blocks non-browser agents), so BSE-only instruments come through Yahoo's .BO series. */
  async function fetchSeries(spec, cfg) {
    cfg = cfg || {};
    const requested = normaliseSymbol(spec.symbol);
    const tries = orderedSymbols(requested, cfg);
    const misses = [];
    for (let i = 0; i < tries.length; i++) {
      try {
        const merged = await fetchOne(Object.assign({}, spec, { symbol: tries[i] }), cfg);
        merged.requestedSymbol = requested;
        merged.resolvedFrom = tries[i] === requested ? null : requested;
        // Remember what the bare name actually resolved to — including itself, so a US ticker
        // found on the first probe never repeats the search on the next poll.
        if (tries.length > 1) rememberResolution(requested, tries[i]);
        merged.triedSymbols = tries.slice(0, i + 1);
        if (SD.Tickers) SD.Tickers.rememberSeries(merged);   // every tape read teaches the dropdown
        return merged;
      } catch (e) {
        if (!isNotFound(e)) throw e;
        misses.push(tries[i] + ': ' + shortMsg(e));
        if (i === 0 && tries.length > 1 && cachedResolution(requested)) forgetResolution(requested);
      }
    }
    throw new Error(nothFoundMessage(requested, tries, misses));
  }

  function shortMsg(e) {
    const m = String(e && e.message || e);
    const code = m.match(/HTTP \d\d\d|Not Found|no data found|may be delisted|no bars returned|timeout|fetch failed|relay returned no quote payload/i);
    return code ? code[0] : m.slice(0, 48);
  }

  /* Say what was actually ruled out. A ^BSE* symbol is the common trap: the venue exists,
     the series does not, and only SENSEX is carried. */
  function nothFoundMessage(raw, tries, misses) {
    const s = normaliseSymbol(raw);
    let lead = '';
    if (/^\^BSE(?!SN)/.test(s)) {
      lead = 'This feed carries no BSE sectoral index series — only ^BSESN (SENSEX) exists on Yahoo, and BSE\'s own API is not browser-reachable. ';
    } else if (/^\d{5,6}$/.test(s)) {
      lead = 'Yahoo does not index BSE numeric script codes; use the scrip name with .BO (or .NS). ';
    }
    const scope = tries.length > 1 ? 'any of ' + tries.join(', ') : s;
    return lead + 'no data for ' + scope + ' (' + misses.join('; ') + ')';
  }

  async function fetchOne(spec, cfg) {
    const venue = venueFor(spec.symbol);
    const base = cfg.base || 'https://query1.finance.yahoo.com/v8/finance/chart/';
    const chain = Array.isArray(cfg.chain) && cfg.chain.length ? cfg.chain : (cfg.proxy ? [cfg.proxy] : ['']);
    // One attempt log for the whole spec: a chunked window is one request stream, not N unrelated
    // ones, and the failure message has to say how many paths the desk actually walked.
    const attempts = [];

    const needsChunks = spec.period1 && spec.period2 && isFinite(chunkLimitSec(spec.interval));
    const windows = [];
    if (needsChunks) {
      let p = spec.period1;
      while (p < spec.period2) {
        const end = Math.min(p + chunkLimitSec(spec.interval) * 1000, spec.period2);
        windows.push({ period1: p, period2: end });
        p = end + 1000;
      }
    } else {
      windows.push({ range: spec.range });
    }

    const out = [];
    let metaRef = null;
    let src = null;
    let lastVia = null;
    for (const w of windows) {
      const one = Object.assign({}, spec, w);
      const url = buildUrl(base, venue.resolved, one);
      let hop;
      try {
        hop = await fetchThroughChain(url, cfg, txt => looksLikeChartPayload(txt) || 'relay returned no quote payload', attempts);
      } catch (e) {
        continue;                                  // this window got nothing; the others may still fill
      }
      const parsed = parseChart(hop.payload, one, venue);
      metaRef = parsed.meta || metaRef;
      for (const b of parsed.bars) if (!out.length || b.t > out[out.length - 1].t) out.push(b);
      // Later chunks are the most recent window, so their meta carries the live price.
      src = parsed;
      if (hop.via) lastVia = hop.via;
    }

    if (!out.length) {
      const where = attempts.slice(0, 3).join('; ');
      throw new Error('no relay returned data (' + attempts.length + ' of ' + chain.length + ' paths failed: ' + where + ')');
    }
    // Re-derive closed flags over the merged series and return the richest envelope.
    const step = intervalSeconds(spec.interval, out);
    const now = Date.now();
    for (const b of out) b.closed = (b.t + step * 1000) <= now;
    const merged = {
      bars: out,
      meta: metaRef,
      venue,
      symbol: (src && src.symbol) || venue.resolved,
      currency: (src && src.currency) || venue.meta.cur,
      exchange: (src && src.exchange) || venue.meta.name,
      timezone: (src && src.timezone) || venue.meta.tz,
      lastPrice: src ? src.lastPrice : out[out.length - 1].c,
      prevClose: src ? src.prevClose : null,
      marketState: src ? src.marketState : '',
      regularMarketTime: src ? src.regularMarketTime : null,
      granularity: (src && src.granularity) || spec.interval,
      span: out[out.length - 1].t - out[0].t,
      via: lastVia || 'unknown',
      events: src ? src.events : null,
      intervalSeconds: step
    };
    return merged;
  }

  /* ---------------------------------------------------------------- timeline specs */
  function specFromTimeline(interval, range, prePost) {
    return { symbol: null, interval, range: range || null, prePost: !!prePost };
  }

  function specFromRange(interval, fromMs, toMs, prePost) {
    return { symbol: null, interval, period1: fromMs, period2: toMs, prePost: !!prePost };
  }

  /* ---------------------------------------------------------------- manual CSV */
  function parseCsv(text) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('nothing to parse');
    let start = 0;
    const head = lines[0].toLowerCase();
    const hasHeader = /(date|time|open|high|low|close|volume)/.test(head) && isNaN(parseFloat(lines[0].replace(/[-\/]/g, '').split(',')[0] || 'x'));
    const idx = { date: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 };
    if (hasHeader) {
      const cols = lines[0].split(/[,;\t]/).map(c => c.trim().toLowerCase());
      const find = names => { for (let i = 0; i < cols.length; i++) if (names.some(n => cols[i].indexOf(n) === 0)) return i; return -1; };
      ['date', 'open', 'high', 'low', 'close', 'volume'].forEach((k, n) => {
        const names = k === 'date' ? ['date', 'time', 'dt'] : [k, k.slice(0, 3), 'adj ' + k];
        const f = find(names);
        if (f >= 0) idx[k] = f; else if (cols.length > n) idx[k] = n;
      });
      start = 1;
    }
    const bars = [];
    for (let i = start; i < lines.length; i++) {
      const p = lines[i].split(/[,;\t]/);
      if (p.length < 4) continue;
      const t = Date.parse((p[idx.date] || '').trim());
      if (isNaN(t)) continue;
      const num = j => {
        const v = parseFloat(String(p[j] == null ? '' : p[j]).replace(/[^0-9.\-]/g, ''));
        return isFinite(v) ? v : null;
      };
      const c = num(idx.close);
      if (c === null || !(c > 0)) continue;
      const o = num(idx.open) === null ? c : num(idx.open);
      const h = num(idx.high) === null ? Math.max(o, c) : num(idx.high);
      const l = num(idx.low) === null ? Math.min(o, c) : num(idx.low);
      const v = num(idx.volume) === null ? 0 : num(idx.volume);
      bars.push({ t, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v, adj: c, closed: true });
    }
    bars.sort((a, b) => a.t - b.t);
    if (!bars.length) throw new Error('no valid OHLC rows');
    return bars;
  }

  function fromBars(bars, label, opts) {
    const o = opts || {};
    return {
      bars, meta: null, venue: { id: 'MANUAL', meta: { name: o.exchange || 'Manual feed', tz: o.tz || 'UTC', cur: o.cur || 'USD', sessions: [[0, 1440]], tag: 'mn' } },
      symbol: label, currency: o.cur || 'USD', exchange: o.exchange || 'Manual / uploaded',
      timezone: o.tz || 'UTC', lastPrice: bars[bars.length - 1].c,
      prevClose: bars.length > 1 ? bars[bars.length - 2].c : null,
      marketState: 'MANUAL', regularMarketTime: bars[bars.length - 1].t,
      granularity: o.interval || '1d', span: bars[bars.length - 1].t - bars[0].t,
      via: 'manual', intervalSeconds: intervalSeconds(o.interval || '1d', bars)
    };
  }

  /* ---------------------------------------------------------------- demo data
     A deterministic GBM + regime switch so the structure labeller can be eyeballed
     offline (seeded: the same ticker always paints the same tape). */
  function demoSeries(symbol, bars_wanted, interval) {
    let seed = 0;
    for (let i = 0; i < (symbol || 'DEMO').length; i++) seed = (seed * 131 + symbol.charCodeAt(i)) % 2147483647;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const stepMs = (INTERVAL_SECONDS[interval] || 86400) * 1000;
    const n = bars_wanted || 260;
    const now = Date.now();
    let price = 240 * (0.6 + rnd());
    let drift = 0.0012;
    const bars = [];
    for (let i = 0; i < n; i++) {
      if (i % 45 === 0) drift = (rnd() - 0.42) * 0.005;
      const vol = 0.011 * (0.6 + rnd());
      const o = price;
      const ret = drift + gauss() * vol;
      const c = Math.max(0.5, o * (1 + ret));
      const h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.6);
      const l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.6);
      const baseV = 900000;
      const v = Math.round(baseV * (0.55 + Math.abs(ret) / vol) * (0.6 + rnd() * 1.5) * (rnd() > 0.9 ? 2.4 : 1));
      bars.push({ t: now - (n - i) * stepMs, o, h, l, c, v, adj: c, closed: true });
      price = c;
    }
    return fromBars(bars, (symbol || 'DEMO') + ' (demo)', { interval: interval || '1d', cur: 'INR', exchange: 'Synthetic demo tape' });
  }

  return {
    VENUES, INDEX_VENUES, INDEX_ALIASES, INTERVAL_SECONDS, DEFAULT_PROXY_CHAIN,
    normaliseSymbol, venueFor, describeSymbol, intervalSeconds,
    symbolCandidates, orderedSymbols, cachedResolution, rememberResolution, forgetResolution, clearResolutions, isNotFound,
    buildUrl, fetchSeries, parseChart, parseCsv, fromBars, demoSeries,
    specFromTimeline, specFromRange,
    fetchJson: fetchThroughChain, extractJson, proxied
  };
})();
