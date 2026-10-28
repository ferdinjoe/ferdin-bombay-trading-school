/* Symbol harness — resolves ticker text to a live series without asking the user to know
   which venue Yahoo happens to carry (node test/symbol-harness.js).
   Covers: exchange-word parsing, candidate ordering, the not-found vs dead-relay split,
   and the 12-hour resolution cache that keeps the second poll to one request. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

['js/util.js', 'js/data.js'].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
});

const SD = global.SD;
const D = SD.Data;
const CFG = { base: 'https://q.test/v8/finance/chart/', chain: [''], home: 'IN', timeout: 100, budget: 900000 };

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- 1. what the user types ---- */
console.log('\n1. Exchange words and shapes');
{
  const cases = [
    ['CROPSTER:BO', 'CROPSTER.BO'], ['BSE:CROPSTER', 'CROPSTER.BO'],
    ['NSE:RELIANCE', 'RELIANCE.NS'], ['RELIANCE:NSE', 'RELIANCE.NS'],
    ['reliance.nse', 'RELIANCE.NS'],
    ['NYSE:IBM', 'IBM'], ['NASDAQ:MSFT', 'MSFT'],
    ['^NSEI', '^NSEI'], ['^BSESN', '^BSESN'], ['BRK.B', 'BRK.B'],
    ['USDINR.NS', 'USDINR.NS'], ['  reliance  ', 'RELIANCE']
  ];
  cases.forEach(([raw, want]) => check('normalise ' + JSON.stringify(raw), D.normaliseSymbol(raw) === want, D.normaliseSymbol(raw)));
}

/* ---- 2. candidate order ---- */
console.log('\n2. Candidate chain');
{
  check('bare Indian name tries NSE then BSE then bare',
    eq(D.symbolCandidates('CROPSTER', CFG), ['CROPSTER.NS', 'CROPSTER.BO', 'CROPSTER']),
    JSON.stringify(D.symbolCandidates('CROPSTER', CFG)));
  check('US home still reaches BSE-only scrips',
    eq(D.symbolCandidates('CROPSTER', { home: 'US' }), ['CROPSTER', 'CROPSTER.NS', 'CROPSTER.BO']),
    JSON.stringify(D.symbolCandidates('CROPSTER', { home: 'US' })));
  check('known Indian scrip prefers NSE even for a US home',
    D.symbolCandidates('RELIANCE', { home: 'US' })[0] === 'RELIANCE.NS',
    JSON.stringify(D.symbolCandidates('RELIANCE', { home: 'US' })));
  check('an Indian home tries NSE first even for a US ticker',
    eq(D.symbolCandidates('AAPL', CFG), ['AAPL.NS', 'AAPL.BO', 'AAPL']),
    JSON.stringify(D.symbolCandidates('AAPL', CFG)));
  check('a US home tries the plain name first',
    eq(D.symbolCandidates('AAPL', { home: 'US' }), ['AAPL', 'AAPL.NS', 'AAPL.BO']),
    JSON.stringify(D.symbolCandidates('AAPL', { home: 'US' })));
  check('BSE numeric code tries .BO first',
    eq(D.symbolCandidates('500325', CFG), ['500325.BO', '500325.NS', '500325']),
    JSON.stringify(D.symbolCandidates('500325', CFG)));
  check('an explicit suffix is never second-guessed',
    eq(D.symbolCandidates('CROPSTER.BO', CFG), ['CROPSTER.BO']),
    JSON.stringify(D.symbolCandidates('CROPSTER.BO', CFG)));
  check('indices get no chain', eq(D.symbolCandidates('^BSESN', CFG), ['^BSESN']));
}

/* ---- 2b. an index named the way the class says it ---- */
console.log('\n2b. Index names reach their own tape');
{
  check('"NIFTY" means ^NSEI, with the plain word kept as fallback',
    eq(D.symbolCandidates('NIFTY', CFG), ['^NSEI', 'NIFTY']),
    JSON.stringify(D.symbolCandidates('NIFTY', CFG)));
  check('"nifty 50" without the caret still finds it',
    D.symbolCandidates('nifty 50', CFG)[0] === '^NSEI',
    JSON.stringify(D.symbolCandidates('nifty 50', CFG)));
  check('"banknifty" finds the series stored as NIFTY BANK',
    eq(D.symbolCandidates('BANKNIFTY', CFG), ['^NSEBANK', 'BANKNIFTY']),
    JSON.stringify(D.symbolCandidates('BANKNIFTY', CFG)));
  check('"sensex" finds ^BSESN whatever the home market is',
    D.symbolCandidates('SENSEX', { home: 'US' })[0] === '^BSESN' &&
    D.symbolCandidates('SENSEX', CFG)[0] === '^BSESN');
  check('"SPX" is the S&P 500, not an Indian equity guess',
    D.symbolCandidates('SPX', CFG)[0] === '^GSPC', JSON.stringify(D.symbolCandidates('SPX', CFG)));
  check('"hang seng" reaches ^HSI', D.symbolCandidates('hang seng', CFG)[0] === '^HSI',
    JSON.stringify(D.symbolCandidates('hang seng', CFG)));
  /* Dow Inc. is a listed equity and trades as DOW — the desk must not hand that name to the index. */
  check('"DOW" stays a scrip guess', !String(D.symbolCandidates('DOW', CFG)[0]).startsWith('^'),
    JSON.stringify(D.symbolCandidates('DOW', CFG)));
  check('"AUTO" stays a scrip guess', !String(D.symbolCandidates('AUTO', CFG)[0]).startsWith('^'),
    JSON.stringify(D.symbolCandidates('AUTO', CFG)));
  check('a fund that carries the word is not the index',
    eq(D.symbolCandidates('NIFTYBEES', CFG), ['NIFTYBEES.NS', 'NIFTYBEES.BO', 'NIFTYBEES']),
    JSON.stringify(D.symbolCandidates('NIFTYBEES', CFG)));
  check('an index word labelled before any quote reads its own venue',
    D.venueFor('NIFTY').meta.name === 'NIFTY 50' && D.venueFor('NIFTY').meta.cur === 'INR',
    JSON.stringify(D.venueFor('NIFTY').meta.name));
  check('a typed caret is never re-aliased', eq(D.symbolCandidates('^NSEI', CFG), ['^NSEI']));
}

/* ---- 3. venue labelling ---- */
console.log('\n3. Venue labelling');
{
  check('.BO reads as BSE India', D.venueFor('CROPSTER.BO').meta.name === 'BSE India');
  check('.NS reads as NSE India', D.venueFor('CROPSTER.NS').meta.name === 'NSE India');
  ['NSEBANK', 'CNXIT', 'CNXAUTO', 'CNXFMCG', 'CNXPHARMA', 'CNXMETAL', 'CNXENERGY', 'CNX100', 'NSEMDCP50'].forEach(k => {
    check('^' + k + ' labelled as an Indian index', D.venueFor('^' + k).meta.tag === 'in', D.venueFor('^' + k).meta.name);
  });
  check('BSE sectoral index is not claimed', D.venueFor('^BSE100').meta.tag !== 'in');
  check('every index name is spelled without punctuation so spaces cannot matter',
    Object.keys(D.INDEX_ALIASES).every(k => /^[A-Z0-9]+$/.test(k)));
  check('every alias points at a series the venue table actually carries',
    Object.keys(D.INDEX_ALIASES).every(k => !!D.INDEX_VENUES[D.INDEX_ALIASES[k].slice(1)]));
  check('"NIFTY" belongs to the 50, not to a sectoral or a midcap',
    D.INDEX_ALIASES.NIFTY === '^NSEI', D.INDEX_ALIASES.NIFTY);
  check('a name that is also a listed equity is not claimed by an index',
    !D.INDEX_ALIASES.DOW && !D.INDEX_ALIASES.AUTO && !D.INDEX_ALIASES.CNX,
    [D.INDEX_ALIASES.DOW, D.INDEX_ALIASES.AUTO, D.INDEX_ALIASES.CNX].join('/'));
}

/* ---- 4. error classification ---- */
console.log('\n4. Missing scrip vs dead relay');
{
  check('HTTP 404 is a miss', D.isNotFound(new Error('HTTP 404')));
  check('Feed: Not Found is a miss', D.isNotFound(new Error('Feed: Not Found')));
  check('empty window is a miss', D.isNotFound(new Error('no bars returned for this window')));
  check('timeout is NOT a miss', !D.isNotFound(new Error('timeout after 8000ms')));
  check('abort is NOT a miss', !D.isNotFound(new Error('relay returned no quote payload')));
  check('chain failure is NOT a miss', !D.isNotFound(new Error('no relay returned data (3 of 3 paths failed)')));
}

/* ---- 5. the chain actually loads a BSE-only scrip ---- */
console.log('\n5. fetchSeries against a stubbed feed');
{
  const seen = [];
  function payloadFor(sym, n) {
    const ts = [], q = { close: [], open: [], high: [], low: [], volume: [] };
    const day = 86400, t0 = Math.floor(Date.now() / 1000) - n * day;
    for (let i = 0; i < n; i++) {
      ts.push(t0 + i * day);
      const c = 1.2 + i * 0.01;
      q.close.push(c); q.open.push(c - 0.005); q.high.push(c + 0.02); q.low.push(c - 0.02); q.volume.push(50000 + i);
    }
    return JSON.stringify({
      chart: {
        result: [{
          timestamp: ts, indicators: { quote: [q] },
          meta: { symbol: sym, currency: 'INR', fullExchangeName: 'BSE', exchangeTimezoneName: 'Asia/Kolkata',
            regularMarketPrice: q.close[n - 1], chartPreviousClose: q.close[n - 2], dataGranularity: '1d' }
        }], error: null
      }
    });
  }
  global.fetch = async url => {
    seen.push(decodeURIComponent(url));
    const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
    if (sym === 'CROPSTER.BO' || sym === 'AAPL' || sym === 'BODYFAIL.BO') return { ok: true, status: 200, text: async () => payloadFor(sym, 40) };
    // A wrong venue can answer 200 with an error body instead of a status, so the chain must
    // still disqualify only that candidate and keep probing.
    if (sym === 'BODYFAIL.NS') return { ok: true, status: 200, text: async () => '{"chart":{"result":[],"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}' };
    return { ok: false, status: 404, text: async () => '{"chart":{"result":[],"error":{"code":"Not Found","description":"Not Found"}}}' };
  };

  const run = async () => {
    let threw = null, merged = null;
    try { merged = await D.fetchSeries({ symbol: 'CROPSTER', interval: '1d', range: '3mo' }, CFG); }
    catch (e) { threw = e; }
    check('CROPSTER loads through the chain', !!merged && merged.symbol === 'CROPSTER.BO', threw ? threw.message : merged && merged.symbol);
    check('the chain reports what was tried', !!merged && eq(merged.triedSymbols, ['CROPSTER.NS', 'CROPSTER.BO']), merged && JSON.stringify(merged.triedSymbols));
    check('the chain reports the typed name', !!merged && merged.resolvedFrom === 'CROPSTER', merged && merged.resolvedFrom);
    check('BSE venue metadata follows the resolved symbol', !!merged && merged.venue.meta.name === 'BSE India', merged && merged.venue.meta.name);
    check('bars came back', !!merged && merged.bars.length === 40, merged && String(merged.bars.length));
    check('the cache remembers the mapping', D.cachedResolution('CROPSTER') === 'CROPSTER.BO', String(D.cachedResolution('CROPSTER')));

    seen.length = 0;
    const again = await D.fetchSeries({ symbol: 'CROPSTER', interval: '1d', range: '3mo' }, CFG);
    check('the next poll is a single request', seen.length === 1 && seen[0].indexOf('CROPSTER.BO') > 0, JSON.stringify(seen));
    check('and it still resolves', again.symbol === 'CROPSTER.BO');
    check('a cached match is still labelled as one', again.resolvedFrom === 'CROPSTER', String(again.resolvedFrom));
    check('a cached match does not re-probe the dead venues', eq(again.triedSymbols, ['CROPSTER.BO']), JSON.stringify(again.triedSymbols));

    seen.length = 0;
    const us1 = await D.fetchSeries({ symbol: 'AAPL', interval: '1d', range: '3mo' }, CFG);
    check('a US ticker under an Indian home is found by falling through', us1.symbol === 'AAPL', us1 && us1.symbol);
    check('the first pass pays for every venue', seen.length === 3, JSON.stringify(seen));
    check('a full search leaves no bogus match note', !us1.resolvedFrom, String(us1.resolvedFrom));
    seen.length = 0;
    await D.fetchSeries({ symbol: 'AAPL', interval: '1d', range: '3mo' }, CFG);
    check('the second pass is one request', seen.length === 1 && seen[0].indexOf('/chart/AAPL?') > 0, JSON.stringify(seen));

    seen.length = 0;
    const bf = await D.fetchSeries({ symbol: 'BODYFAIL', interval: '1d', range: '3mo' }, CFG);
    check('a 200 carrying an error body is only a venue miss', bf && bf.symbol === 'BODYFAIL.BO', bf && bf.symbol);
    check('the chain kept probing past it', eq(bf.triedSymbols, ['BODYFAIL.NS', 'BODYFAIL.BO']), JSON.stringify(bf.triedSymbols));
    check('an error body is cached like any other miss-to-hit', D.cachedResolution('BODYFAIL') === 'BODYFAIL.BO', String(D.cachedResolution('BODYFAIL')));

    let err = null;
    try { await D.fetchSeries({ symbol: '^BSE100', interval: '1d', range: '1y' }, { base: CFG.base, chain: [''], home: 'IN', timeout: 100 }); }    catch (e) { err = e; }
    check('a BSE sectoral index explains the feed limit', !!err && /no BSE sectoral index/.test(err.message), err && err.message);

    let relayErr = null, deadCalls = 0;
    global.fetch = async () => { deadCalls++; throw new Error('fetch failed'); };
    try { await D.fetchSeries({ symbol: 'NEWNAME', interval: '1d', range: '1mo' }, CFG); }
    catch (e) { relayErr = e; }
    check('a dead relay is reported as a relay failure', !!relayErr && /no relay returned data/.test(relayErr.message), relayErr && relayErr.message);
    check('a dead relay stops the chain instead of trying every venue', deadCalls === 1, String(deadCalls));
  };

  run().then(() => {
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  }).catch(e => { console.error('harness crashed:', e.stack); process.exit(1); });
}
