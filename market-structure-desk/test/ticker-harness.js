/* Ticker harness — runs headless: node test/ticker-harness.js
   The suggestion dropdown is only trustworthy if the ranking is predictable: the scrip the user
   meant must come first, an explicitly typed exchange must never be second-guessed, and one typed
   fragment must cost at most one relay. Fixture is a real Yahoo finance/search payload for RELIANCE
   captured 2026-10-28; the seed is the NSE listing file shipped in data/. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;

const LS = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v); },
  removeItem: k => { delete LS[k]; },
  key: i => Object.keys(LS)[i],
  get length() { return Object.keys(LS).length; }
};

const CSV = fs.readFileSync(path.join(__dirname, '..', 'data', 'nse-listed.csv'), 'utf8');
global.fetch = async () => ({ ok: true, text: async () => CSV });

['js/util.js', 'js/data.js', 'js/tickers.js'].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
});

const SD = global.window.SD;
const T = SD.Tickers, D = SD.Data, U = SD.U;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}
const syms = list => list.map(x => x.symbol);

console.log('\n[1] the vendored NSE listing parses into a usable board');
let seedRows = null;
T.loadSeed();
// loadSeed is promise-backed; parse directly too so a broken file fails here rather than in the UI.
seedRows = T.parseSeed(CSV);
check('the header row is not treated as a listing', seedRows.every(r => r.s !== 'SYMBOL.NS'));
check('more than two thousand listed equities are readable', seedRows.length > 2000, seedRows.length);
check('every seeded row carries an NSE suffix', seedRows.every(r => /\.NS$/.test(r.s)));
check('every seeded row has a company name', seedRows.every(r => r.name && r.name.length > 1));
check('non-equity series are dropped', seedRows.every(r => ['EQ', 'BE', 'BZ', 'SM'].indexOf(r.series) >= 0));
const mic = seedRows.filter(r => r.s === '20MICRONS.NS')[0];
check('face value survives from the listing file', mic && mic.face === 5, mic && mic.face);

console.log('\n[2] local search ranks what the user meant first');
(async () => {
  await T.loadSeed();
  check('the directory reports the seeded board', T.seedCount > 2000, T.seedCount);
  const r = T.search('20MIC');
  check('a five-letter fragment finds the obscure scrip', r.length && r[0].symbol === '20MICRONS.NS', syms(r));
  check('one character never opens a list', T.search('R').length === 0);
  check('blank input is not a query', T.search('').length === 0);

  const rel = T.search('RELIANCE');
  check('the ticker itself outranks a name that merely contains it',
    rel.length > 0 && rel[0].symbol === 'RELIANCE.NS', syms(rel).slice(0, 3));
  check('a seeded name carries the exchange for the row label', rel[0].tag === 'NS', rel[0].tag);

  check('a company name typed with a space still matches',
    syms(T.search('hdfc bank')).indexOf('HDFCBANK.NS') >= 0, syms(T.search('hdfc bank')).slice(0, 3));
  check('a name typed without the space matches the same way',
    syms(T.search('HDFCBANK')).indexOf('HDFCBANK.NS') >= 0);
  check('letters out of order fall back to a subsequence, not a rejection',
    syms(T.search('RLNCE')).indexOf('RELIANCE.NS') >= 0, syms(T.search('RLNCE')).slice(0, 3));
  const rl = T.search('RLNCE');
  check('a perfect prefix still beats that subsequence',
    T.search('RELIAN')[0].score > rl.filter(x => x.symbol === 'RELIANCE.NS')[0].score);

  /* An ETF called Invesco India BSE Sensex matches "sensex" inside its ticker; the index the user
     actually meant is the one whose whole name is the word. */
  check('a name typed in full is the top row, not a scrip that contains it',
    syms(T.search('sensex'))[0] === '^BSESN', syms(T.search('sensex')).slice(0, 3));
  check('the same holds for an index typed with a space',
    syms(T.search('nifty 50'))[0] === '^NSEI', syms(T.search('nifty 50')).slice(0, 3));

  console.log('\n[3] an exchange the user typed is obeyed, not guessed');
  // Only a listing this machine has actually seen can be offered on that exchange.
  T.remember({ s: 'RELIANCE.BO', name: 'Reliance Industries Ltd', exchange: 'BO', currency: 'INR' });
  const bse = T.search('BSE:RELIANCE');
  check('BSE: keeps only the BSE listing', bse.length > 0 && bse.every(x => /\.BO$/.test(x.symbol)), syms(bse));
  check('the NSE listing is excluded once an exchange is stated',
    syms(bse).indexOf('RELIANCE.NS') < 0, syms(bse));
  const nse = T.search('reliance.ns');
  check('a typed .NS keeps only the NSE listing', nse.length > 0 && nse.every(x => /\.NS$/.test(x.symbol)), syms(nse));
  const idx = T.search('^NSE');
  check('a caret keeps only index series', idx.length > 0 && idx.every(x => x.symbol[0] === '^'), syms(idx));
  check('the index the desk knows by name comes first', idx[0] && idx[0].symbol === '^NSEI', syms(idx).slice(0, 3));
  check('an index is offered without ever having been quoted',
    syms(T.search('sensex')).indexOf('^BSESN') >= 0, syms(T.search('sensex')).slice(0, 3));

  console.log('\n[4] the directory learns and never forgets a proven field');
  T.clearDir();
  T.remember({ s: 'AAPL', name: 'Apple Inc.', currency: 'USD', exchange: 'NasdaqGM', type: 'EQUITY' });
  T.remember({ s: 'AAPL', currency: 'USD' });
  const stored = U.store.get('tickerDir', {})['AAPL'];
  check('a later sighting without a name does not erase the old one', stored.n === 'Apple Inc.', stored.n);
  check('a second sighting counts as a use', stored.h >= 0 && typeof stored.h === 'number');
  T.rememberSeries({ symbol: 'MSFT', currency: 'USD', meta: { longName: 'Microsoft Corporation', exchangeName: 'NasdaqGS' } });
  check('a fetched tape is stored by its resolved symbol', !!U.store.get('tickerDir', {})['MSFT']);
  check('the tape supplies the company name', U.store.get('tickerDir', {})['MSFT'].n === 'Microsoft Corporation');
  const ms = T.search('MSFT');
  check('a learned ticker is suggested without the seed file', ms.length && ms[0].symbol === 'MSFT', syms(ms));

  check('a bare name the desk already resolved is filed under its real listing', (() => {
    D.rememberResolution('TATAMOTORS', 'TATAMOTORS.NS');
    T.remember({ s: 'TATAMOTORS' });
    const d = U.store.get('tickerDir', {});
    return !!d['TATAMOTORS.NS'] && !d['TATAMOTORS'];
  })());
  check('a name nobody has quoted for six months is dropped on the next write', (() => {
    T.clearDir();
    U.store.set('tickerDir', { ANCIENT: { s: 'ANCIENT', t: Date.now() - 400 * 86400e3 } });
    T.remember({ s: 'FRESH', currency: 'USD' });
    const after = U.store.get('tickerDir', {});
    return !after.ANCIENT && !!after.FRESH;
  })());
  check('a bare token that names nothing is dropped on the next write', (() => {
    T.remember({ s: 'JUSTTYPED' });
    T.remember({ s: 'KEEPME.NS' });                          // a suffixed symbol states its own venue
    const after = U.store.get('tickerDir', {});
    return !after.JUSTTYPED && !!after['KEEPME.NS'];
  })());

  console.log('\n[5] the search endpoint is parsed and paid for once');
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reliance-search.json'), 'utf8'));
  const rows = T.parseSearch(payload);
  check('every quote becomes a candidate', rows.length === payload.quotes.length, rows.length);
  check('the exchange display comes through for the row label', rows[0].exchange === 'NSE', rows[0].exchange);
  const onlyFx = T.parseSearch({ quotes: [{ symbol: 'USDINR=X', quoteType: 'FOREX' }, { symbol: 'TCS.NS', quoteType: 'EQUITY' }] });
  check('a currency pair is not offered as a scrip', onlyFx.length === 1 && onlyFx[0].s === 'TCS.NS', onlyFx.length);
  const noOpts = T.parseSearch({ quotes: [{ symbol: 'INFY261120C00014000', quoteType: 'OPTION' }, { symbol: 'TCS.NS', quoteType: 'EQUITY' }] });
  check('an option contract is not offered as a listing', noOpts.length === 1 && noOpts[0].s === 'TCS.NS', noOpts.length);
  check('a payload with no quotes array is empty, not a crash', T.parseSearch({}).length === 0);

  let calls = 0;
  D.fetchJson = async () => { calls++; return { payload: payload, via: 'test-relay' }; };
  const first = await T.suggest('reliance');
  check('the relay is spent on a fragment nobody has searched', calls === 1, calls);
  check('NYSE and NSE listings both come back', first.filter(x => x.symbol === 'RS').length === 1 &&
    first.filter(x => x.symbol === 'RELIANCE.NS').length === 1, syms(first));
  await T.suggest('RELIANCE');
  check('typing the same fragment again costs nothing', calls === 1, calls);
  await T.suggest('rel');
  check('a different fragment does spend one call', calls === 2, calls);
  check('search hits land in the directory for next time', !!U.store.get('tickerDir', {})['RPOWER.NS']);

  D.fetchJson = async () => { throw new Error('no relay returned data (0 of 1 paths failed)'); };
  T.clearSuggest();
  const dead = await T.suggest('nobodyknowsthis');
  check('a dead relay returns an empty list instead of throwing', Array.isArray(dead) && dead.length === 0);

  console.log('\n[6] face value lookup');
  check('a seeded scrip reports its listed face value', T.seedFace('20MICRONS.NS') === 5, T.seedFace('20MICRONS.NS'));
  await T.loadSeed(true);
  check('the loaded seed answers the same question', T.seedCount > 2000);

  console.log('\n[7] a batch box only queries the fragment under the cursor');
  check('the token after the last comma is the query', T.fragmentOf('AAPL, INF', true) === 'INF', T.fragmentOf('AAPL, INF', true));
  check('a space-separated batch splits the same way', T.fragmentOf('AAPL INF', true) === 'INF', T.fragmentOf('AAPL INF', true));
  check('a committed token is never part of the query', T.fragmentOf('INFY.NS, ', true) === '', T.fragmentOf('INFY.NS, ', true));
  check('the desk box keeps a two-word company name whole',
    T.fragmentOf('TATA STEEL', false) === 'TATA STEEL', T.fragmentOf('TATA STEEL', false));
  check('a caret query survives the fragment cut', T.fragmentOf('^NSE', false) === '^NSE');

  const batch = T.search('AAPL, INF');
  const frag = T.search(T.fragmentOf('AAPL, INF', true));
  check('the flattened batch string is not a usable query', batch.length === 0 || batch[0].symbol !== 'INFY.NS', syms(batch).slice(0, 3));
  check('the fragment alone finds the second ticker', frag.length > 0 && frag[0].symbol === 'INFY.NS', syms(frag).slice(0, 3));

  console.log('\n[8] a contract is never offered as a listing');
  check('an OCC option is a contract', T.isContract('INFY261120C00014000', 'OPTION') === true);
  check('a dotted option is a contract', T.isContract('AAPL261218C00200000', '') === true);
  check('a currency pair is a contract', T.isContract('USDINR=X', '') === true);
  check('a crypto pair is a contract', T.isContract('BTC-USD', 'CRYPTOCURRENCY') === true);
  check('an ordinary scrip is not', T.isContract('INFY.NS', 'EQUITY') === false && T.isContract('^NSEI', 'INDEX') === false);
  // One already stored by an older build must not keep coming back from the directory.
  T.remember({ s: 'INFY261120C00014000', name: 'INFY Nov 2026 14.000 call', exchange: 'OPR', currency: 'USD', type: 'OPTION' });
  check('a contract is refused entry to the directory', !U.store.get('tickerDir', {})['INFY261120C00014000']);
  T.clearDir();
  U.store.set('tickerDir', {
    INFY261120C00014000: { s: 'INFY261120C00014000', n: 'INFY Nov 2026 14.000 call', x: 'OPR', c: 'USD', q: 'OPTION', t: Date.now(), h: 3 },
    INFY: { s: 'INFY.NS', n: 'Infosys Limited', x: 'NS', c: 'INR', q: 'EQUITY', t: Date.now(), h: 1 }
  });
  T.remember({ s: 'AAPL' });                              // forces the module to re-read the injected board
  check('a contract already in the directory is scored out', syms(T.search('INFY26')).indexOf('INFY261120C00014000') < 0,
    syms(T.search('INFY26')));
  check('the scrip beside it is still offered', syms(T.search('INFY'))[0] === 'INFY.NS', syms(T.search('INFY')).slice(0, 3));

  T.clearDir();
  U.store.set('tickerDir', {
    INF: { s: 'INF', x: '', c: 'USD', t: Date.now(), h: 5 },
    'INFY.NS': { s: 'INFY.NS', n: 'Infosys Limited', x: 'NS', c: 'INR', q: 'EQUITY', t: Date.now(), h: 1 }
  });
  T.remember({ s: 'AAPL' });                              // forces the module to re-read the injected board
  check('a nameless guess never outranks a scrip that matches', syms(T.search('INF'))[0] === 'INFY.NS',
    syms(T.search('INF')).slice(0, 3));

  console.log('\n[9] the full company name behind a chosen ticker');
  check('the listing file names a seeded scrip', T.nameOf('TATACHEM.NS') === 'Tata Chemicals Limited', T.nameOf('TATACHEM.NS'));
  check('a bare ticker without its suffix still names it', T.nameOf('INFY') === 'Infosys Limited', T.nameOf('INFY'));
  check('a lower-case ticker names it the same way', T.nameOf('20microns') === '20 Microns Limited', T.nameOf('20microns'));
  check('an index names its series', T.nameOf('^BSESN') === 'SENSEX' && T.nameOf('^NSEI') === 'NIFTY 50',
    T.nameOf('^BSESN') + '/' + T.nameOf('^NSEI'));
  T.rememberSeries({ symbol: 'AAPL', currency: 'USD', meta: { longName: 'Apple Inc.', exchangeName: 'NasdaqGS' } });
  check('a fetched tape names what the listing file does not carry', T.nameOf('AAPL') === 'Apple Inc.', T.nameOf('AAPL'));
  check('nothing known means nothing claimed', T.nameOf('ZZZNOTALISTING') === '', JSON.stringify(T.nameOf('ZZZNOTALISTING')));
  check('an empty ticker is not a name', T.nameOf('') === '' && T.nameOf(null) === '');
  check('the board turns a bare leaf into its Indian listing', T.boardSymbol('TATACHEM') === 'TATACHEM.NS', T.boardSymbol('TATACHEM'));
  check('a symbol that already carries a venue is left alone', T.boardSymbol('TATACHEM.NS') === '' && T.boardSymbol('^NSEI') === '',
    JSON.stringify(T.boardSymbol('TATACHEM.NS')));
  check('a leaf the board does not know has no Indian listing', T.boardSymbol('AAPL') === '', JSON.stringify(T.boardSymbol('AAPL')));

  console.log('\n[10] an index answers to the name the class says out loud');
  {
    const n = T.search('NIFTY');
    check('"nifty" is the 50, not the next-50 or a midcap', n[0].symbol === '^NSEI', syms(n).slice(0, 4));
    check('"nifty" without a caret is still labelled as an index row',
      n[0].type === 'INDEX' && n[0].exchange === 'NIFTY 50', n[0].type + '/' + n[0].exchange);
    const bn = T.search('BANKNIFTY');
    check('"banknifty" finds the series the feed calls NIFTY BANK', bn.length === 1 && bn[0].symbol === '^NSEBANK', syms(bn));
    check('"bank nifty" with the space gives the same single answer',
      T.search('BANK NIFTY').length === 1 && T.search('BANK NIFTY')[0].symbol === '^NSEBANK',
      syms(T.search('BANK NIFTY')));
    check('"sensex" is ^BSESN and says so in rupees',
      T.search('SENSEX')[0].symbol === '^BSESN' && T.search('SENSEX')[0].currency === 'INR',
      T.search('SENSEX')[0].currency);
    check('"bse 30" is the same series', T.search('BSE 30')[0].symbol === '^BSESN', T.search('BSE 30')[0].symbol);
    check('"spx" is the S&P 500, not the Indian S&P CNX',
      T.search('SPX')[0].symbol === '^GSPC', syms(T.search('SPX')).slice(0, 3));
    check('"dow" puts the Dow Jones above scrips that merely carry the letters',
      T.search('DOW')[0].symbol === '^DJI', syms(T.search('DOW')).slice(0, 3));
    check('"nikkei" reaches ^N225 with yen behind it',
      T.search('nikkei')[0].symbol === '^N225' && T.search('nikkei')[0].currency === 'JPY');
    check('"hang seng" reaches ^HSI', T.search('hang seng')[0].symbol === '^HSI');
    check('"nasdaq" is the composite before the 100',
      T.search('NASDAQ')[0].symbol === '^IXIC' && T.search('NASDAQ')[1].symbol === '^NDX',
      syms(T.search('NASDAQ')).slice(0, 2));
    check('a sectoral index is still offered under the broad one',
      syms(T.search('NIFTY IT')).indexOf('^CNXIT') === 0, syms(T.search('NIFTY IT')));
    check('an ETF that carries the word does not outrank the index',
      syms(T.search('NIFTY')).indexOf('^NSEI') < syms(T.search('NIFTY')).indexOf('NIFTYBEES.NS') ||
      syms(T.search('NIFTY')).indexOf('NIFTYBEES.NS') < 0, syms(T.search('NIFTY')).slice(0, 5));
    check('a bare index name is labelled with its series name',
      T.nameOf('NIFTY') === 'NIFTY 50' && T.nameOf('BANKNIFTY') === 'NIFTY BANK',
      T.nameOf('NIFTY') + '/' + T.nameOf('BANKNIFTY'));
    check('a typed caret still beats the alias', T.search('^NSEI')[0].symbol === '^NSEI');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('harness crashed: ' + e.stack); process.exit(1); });
