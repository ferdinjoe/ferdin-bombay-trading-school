/* Fundamentals harness — runs headless: node test/fund-harness.js
   Guards the two things the Books tab can be wrong about: the ratio arithmetic (a wrong ROCE is
   worse than no ROCE) and the query parser (a screen that silently passes nothing is a screen nobody
   trusts). Fixtures are real Yahoo fundamentals-timeseries payloads captured 2026-10-28. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;

/* localStorage shim: the module must run with no browser, and the store has to behave like a map. */
const LS = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v); },
  removeItem: k => { delete LS[k]; },
  key: i => Object.keys(LS)[i],
  get length() { return Object.keys(LS).length; }
};
Object.keys(LS).length;

['js/util.js', 'js/data.js', 'js/fundamentals.js'].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
});

const SD = global.window.SD;
const F = SD.Fund;
const U = SD.U;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}
function near(a, b, tol) { return isFinite(a) && isFinite(b) && Math.abs(a - b) <= (tol === undefined ? 0.01 : tol); }

function fixture(sym) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', sym + '-fund.json'), 'utf8'));
}

/* -------------------------------------------------------------- parse + build */
console.log('\n[1] payload parsing');
const relPayload = fixture('RELIANCE.NS');
const parsed = F.parseTimeseries(relPayload, 'RELIANCE.NS');
check('timeseries exposes per-type arrays', Object.keys(parsed.series).length >= 25, Object.keys(parsed.series).length + ' types');
check('currency read from the payload', parsed.currency === 'INR', parsed.currency);
check('a type the feed did not answer is absent, not zero', parsed.series.annualEbitda === undefined);
check('quarterly blocks parse alongside annuals', !!parsed.series.quarterlyTotalRevenue && parsed.series.quarterlyTotalRevenue.length >= 4);
check('trailing market cap is present', !!parsed.series.trailingMarketCap && parsed.series.trailingMarketCap.length > 0);
let threw = false;
try { F.parseTimeseries({ timeseries: { result: [] } }, 'XYZ'); } catch (e) { threw = /no fundamentals/.test(e.message); }
check('an empty result set throws instead of building a blank book', threw);

const book = F.buildBook('RELIANCE.NS', parsed, { price: 1420.5, prevClose: 1431, requestedSymbol: 'RELIANCE' });
const y = book.years;
console.log('\n[2] statement rows');
check('four fiscal years of history', y.length === 4, y.length);
check('rows are oldest first', y[0].asOf < y[y.length - 1].asOf, y[0].asOf + ' → ' + y[y.length - 1].asOf);
check('year labels use the Screener month-year form', /^[A-Z][a-z]{2} \d{4}$/.test(y[0].label), y[0].label);
check('quarter rows carry a Q label', /^Q\d \d{4}$/.test(book.quarters[book.quarters.length - 1].label), book.quarters[book.quarters.length - 1].label);
const last = y[y.length - 1];

/* Every raw figure below was pulled straight from the fixture so the expectation is independent of
   the code under test. */
function raw(type, asOf) {
  const list = parsed.series[type] || [];
  const hit = list.filter(p => p.asOf === asOf)[0];
  return hit ? hit.raw : null;
}
const fy = last.asOf;
const s = raw('annualTotalRevenue', fy), e = raw('annualTotalExpenses', fy), oi = raw('annualOperatingIncome', fy);
const ni = raw('annualNetIncome', fy), ta = raw('annualTotalAssets', fy), cl = raw('annualCurrentLiabilities', fy);
const seq = raw('annualStockholdersEquity', fy), td = raw('annualTotalDebt', fy), sh = raw('annualDilutedAverageShares', fy);
const ca = raw('annualCurrentAssets', fy), pretax = raw('annualPretaxIncome', fy), intr = raw('annualInterestExpense', fy);
const dep = raw('annualDepreciationAndAmortization', fy), divp = raw('annualCashDividendsPaid', fy);
const ocf = raw('annualOperatingCashFlow', fy), capex = raw('annualCapitalExpenditure', fy);

console.log('\n[3] ratio arithmetic against hand-computed values');
check('sales mapped from totalRevenue', last.sales === s, last.sales + ' vs ' + s);
check('operating profit kept from the feed', last.opProfit === oi);
check('OPM = operating profit / sales', near(last.opmPct, 100 * oi / s, 0.001), last.opmPct);
check('ROE = net profit / equity', near(last.roePct, 100 * ni / seq, 0.001), last.roePct);
check('ROCE uses capital employed (assets − current liabilities)', near(last.rocePct, 100 * oi / (ta - cl), 0.001), last.rocePct);
check('debt to equity = total debt / equity', near(last.debtToEquity, td / seq, 0.0001), last.debtToEquity);
check('current ratio = current assets / current liabilities', near(last.currentRatio, ca / cl, 0.0001), last.currentRatio);
check('effective tax from pretax over net profit', near(last.taxPct, 100 * (pretax - ni) / pretax, 0.001), last.taxPct);
check('book value per share = equity / diluted shares', near(last.bookValuePs, seq / sh, 0.01), last.bookValuePs);
check('dividend per share from the paid figure (which arrives negative)', near(last.divPs, Math.abs(divp) / sh, 0.01), last.divPs);
check('interest coverage = operating profit / interest', near(last.interestCover, oi / intr, 0.001), last.interestCover);
check('other income balances the pretax line', near(last.otherIncome, pretax - oi + intr + dep, 1), last.otherIncome);
check('free cash flow matches the feed where the feed has it',
  near(last.freeCashFlow, raw('annualFreeCashFlow', fy), Math.abs(raw('annualFreeCashFlow', fy)) * 0.02), last.freeCashFlow);
check('derived FCF = operating cash flow + capex', near(last.ocf + last.capex, last.freeCashFlow, Math.abs(last.freeCashFlow) * 0.001));

console.log('\n[4] magnitudes in crore');
check('summary sales in crore', near(book.summary.salesCr, s / 1e7, 0.01), book.summary.salesCr);
check('summary profit in crore', near(book.summary.profitCr, ni / 1e7, 0.01), book.summary.profitCr);
check('market cap carried from the trailing series in crore',
  near(book.summary.mcap / 1e7, parsed.series.trailingMarketCap.slice(-1)[0].raw / 1e7, 0.01));
check('stock P/E = market cap / last-year net profit', near(book.summary.pe, book.summary.mcap / ni, 0.01), book.summary.pe);
check('P/BV = market cap / equity', near(book.summary.pbv, book.summary.mcap / seq, 0.01), book.summary.pbv);
check('dividend yield = dividends paid / market cap',
  near(book.summary.divYield, 100 * Math.abs(divp) / book.summary.mcap, 0.01), book.summary.divYield);
/* Reliance is a ~₹10.5 lakh crore revenue business; a crore/lakh mix-up shows up instantly here. */
check('sales land in the expected lakh-crore band', book.summary.salesCr > 900000 && book.summary.salesCr < 1200000, book.summary.salesCr);
check('P/E is a sane number, not a unit error', book.summary.pe > 5 && book.summary.pe < 60, book.summary.pe);

console.log('\n[5] growth over the series');
const prev = y[y.length - 2];
check('YoY sales growth uses the last two years',
  near(F.growthPct(y, 'sales', 1), 100 * (last.sales / prev.sales - 1), 0.001));
check('3-year CAGR compounds rather than averages', (() => {
  const g = F.growthPct(y, 'sales', 3);
  return near(g, 100 * (Math.pow(y[3].sales / y[0].sales, 1 / 3) - 1), 0.001);
})(), F.growthPct(y, 'sales', 3));
check('growth on a series too short returns null, not a fake zero', F.growthPct([y[0]], 'sales', 1) === null);
check('growth from a loss-making base returns null',
  F.growthPct([{ sales: 1 }, { sales: -2 }], 'sales', 1) === null);

console.log('\n[6] US fixture keeps its own currency');
const ap = F.parseTimeseries(fixture('AAPL'), 'AAPL');
const ab = F.buildBook('AAPL', ap, null);
check('AAPL reports in USD', ab.currency === 'USD', ab.currency);
check('AAPL rows built', ab.years.length >= 3, ab.years.length);
check('AAPL book value per share in dollars, not crores', ab.years[ab.years.length - 1].bookValuePs > 1 &&
  ab.years[ab.years.length - 1].bookValuePs < 200, ab.years[ab.years.length - 1].bookValuePs);

/* -------------------------------------------------------------- query language */
console.log('\n[7] tokenizer and parser');
function q(src) { return F.evalNode(F.parse(src), book); }
check('single condition parses', !!F.parse('roce > 15'));
check('field aliases resolve', F.ALIASES['debt/equity'] === 'debt to equity' && F.ALIASES['mcap'] === 'market cap' &&
  F.ALIASES['pat'] === 'profit');
check('longest alias wins: "sales growth" is not read as "sales"', F.tokenize('sales growth > 10')[0].v === 'sales growth');
check('operators all parse', ['>', '<', '>=', '<=', '=', '!='].every(o => !!F.parse('roce ' + o + ' 15')));
check('and/or/not and parentheses nest', !!F.parse('(roce > 15 and roe > 15) or not npm > 30'));
check('percent literal is just a number', F.tokenize('npm > 20%')[2].v === 20);
check('cr multiplier scales a magnitude', F.tokenize('market cap > 5000cr')[2].v === 5000 * 1e7);
check('lakh multiplier scales', F.tokenize('sales > 250lakh')[2].v === 250 * 1e5);
check('aggregate prefix reads Screener-style', F.tokenize('average roce 5years > 20')[0].agg === 'avg' &&
  F.tokenize('average roce 5years > 20')[0].v === 'roce' && F.tokenize('average roce 5years > 20')[0].n === 5);
check('minimum/maximum normalise', F.tokenize('min npm > 5')[0].agg === 'min' && F.tokenize('maximum npm > 5')[0].agg === 'max');
check('"N years" attaches to the field, not the number', F.tokenize('sales growth 5years > 10')[0].n === 5);
check('spacing around tokens is ignored', !!F.parse('  roce>15and  roe<90  '));
let perr = '';
try { F.parse('roceey > 10'); } catch (e) { perr = e.message; }
check('unknown field is a clear error, not a silent no-match', /unknown field/.test(perr), perr);
let terr = '';
try { F.parse('roce > 10 and'); } catch (e) { terr = e.message; }
check('dangling conjunction is rejected', !!terr, terr);
let nerr = '';
try { F.parse('roce'); } catch (e) { nerr = e.message; }
check('a field with no comparison is rejected', !!nerr, nerr);

console.log('\n[8] evaluation against the Reliance book');
check('a condition the book satisfies passes', q('sales > 100000'));
check('a condition the book fails rejects', q('sales > 99999999') === false);
check('debt to equity compares as a multiple', q('debt to equity < 1') === (last.debtToEquity < 1));
check('pe from market cap is testable', q('pe > 0 and pe < 60'));
check('avg over years works', q('avg roce > 0') === (F.aggField(book, 'roce', 'avg') > 0));
check('min roce equals the worst year', (() => {
  const vals = y.map(r => r.rocePct);
  return near(F.aggField(book, 'roce', 'min'), Math.min.apply(null, vals), 0.001);
})(), F.aggField(book, 'roce', 'min'));
check('a missing statement line never satisfies a condition', q('promoter holding > 5') === false);
check('not inverts', q('not npm > 99') === true);
check('or widens', q('roe > 99 or roce > 5') === true);
check('quarterly fields evaluate', q('q sales > 0'));
check('years count is queryable', q('years >= 4'));
check('capex is queried as the size of the spend, not its signed cash effect',
  q('capex > 0') === true && F.evalNode(F.parse('capex > 0'), book));
check('dividends paid is queried as a positive payout', q('dividends > 0') === true);

// A screen typed the way Screener's box works: bare magnitude = crore, a suffix = absolute money.
check('a bare magnitude is read as crore', q('market cap > 1000') === true);
check('a cr suffix agrees with the bare crore reading', q('market cap > 1000cr') === true);
check('a bn suffix is absolute native currency, not crore', q('market cap > 200bn') === true);
check('a bn suffix large enough to dwarf the book rejects', q('market cap > 500000bn') === false);
check('a lakh suffix scales the magnitude', q('sales > 10000000000lakh') === false);
check('a lakh suffix at a readable size accepts', q('sales > 100000lakh') === true);
check('a bare ratio number is taken exactly as written', q('debt to equity < 1') === true);
check('a percent suffix is a no-op on a percent field', q('npm > 1%') === true);
check('a percent suffix on a magnitude still means the bare crore number', q('sales > 1000%') === true);

// Same-quarter-last-year, never the noisy quarter before it.
const qs = book.quarters;
const newest = qs[qs.length - 1];
const qm = String(newest.asOf).slice(5, 7);
const qy = +String(newest.asOf).slice(0, 4);
const yago = qs.filter(r => String(r.asOf).slice(5, 7) === qm && +String(r.asOf).slice(0, 4) === qy - 1)[0];
if (yago && yago.sales > 0) {
  check('q sales growth compares against the same quarter last year',
    near(F.qGrowth(qs, 'sales'), 100 * (newest.sales / yago.sales - 1), 0.001), F.qGrowth(qs, 'sales'));
} else {
  check('a feed with no year-ago quarter must give no q growth', F.qGrowth(qs, 'sales') === null);
}
check('q growth is null for a field the quarters do not carry', F.qGrowth(qs, 'goodwill') === null);
check('one quarter says nothing about growth', F.qGrowth([newest], 'sales') === null);

check('an aggregate over a snapshot-only field is refused, not faked',
  F.aggField(book, 'market cap', 'avg') === null);

console.log('\n[9] presets all parse and run');
F.PRESETS.forEach(p => {
  let ok = true, err = '';
  try { F.screen(p.q, [book]); } catch (e) { ok = false; err = e.message; }
  check('preset "' + p.name + '" parses', ok, err);
});

console.log('\n[10] screening a universe');
const tcs = F.buildBook('TCS.NS', F.parseTimeseries(fixture('TCS.NS'), 'TCS.NS'), null);
const rows = F.screen('roe > 5 and sales > 10000', [book, tcs]);
check('screen returns only the names that satisfy it', rows.length === 2, rows.length);
check('rows carry the display fields', rows[0].f.marketCap > 0 && isFinite(rows[0].f.roe));
check('rows sort by market cap, largest first', rows[0].f.marketCap >= rows[1].f.marketCap);
const none = F.screen('roe > 99', [book, tcs]);
check('an impossible screen is empty, not an error', none.length === 0);
check('a blank query keeps every book', F.screen('', [book, tcs]).length === 2);

console.log('\n[10b] a statement currency that differs from the valuation currency');
const aapl = F.buildBook('AAPL', F.parseTimeseries(fixture('AAPL'), 'AAPL'), null);
check('Apple files and is valued in the same currency', !aapl.fxMismatch, aapl.currency + '/' + aapl.mcapCurrency);
check('so its P/E is allowed', aapl.summary.pe > 0, aapl.summary.pe);
/* Infosys-shaped payload: USD statements, INR market cap. Dividing them is the 1425 P/E bug. */
const mixed = {
  timeseries: { result: [
    { meta: { type: ['annualTotalRevenue'] }, annualTotalRevenue: [{ asOfDate: '2026-03-31', reportedValue: { raw: 2.4e10 }, currencyCode: 'USD' }] },
    { meta: { type: ['annualNetIncome'] }, annualNetIncome: [{ asOfDate: '2026-03-31', reportedValue: { raw: 4.8e9 }, currencyCode: 'USD' }] },
    { meta: { type: ['annualStockholdersEquity'] }, annualStockholdersEquity: [{ asOfDate: '2026-03-31', reportedValue: { raw: 1.9e10 }, currencyCode: 'USD' }] },
    { meta: { type: ['trailingMarketCap'] }, trailingMarketCap: [{ asOfDate: '2026-03-31', reportedValue: { raw: 4.7e13 }, currencyCode: 'INR' }] }
  ] }
};
const clash = F.buildBook('INFY.NS', F.parseTimeseries(mixed, 'INFY.NS'), null);
check('the clash is detected', clash.fxMismatch === 'USD/INR', clash.fxMismatch);
check('statements stay in their own currency', clash.currency === 'USD');
check('market cap keeps the listing currency', clash.mcapCurrency === 'INR');
check('P/E across two currencies is withheld, not computed', clash.summary.pe === null, clash.summary.pe);
check('P/BV is withheld too', clash.summary.pbv === null);
check('dividend yield is withheld', clash.summary.divYield === null);
check('enterprise value is withheld', clash.summary.ev === null);
check('a same-currency ratio still reads', clash.summary.roe > 20, clash.summary.roe);
check('a screen cannot pass a name whose ratio was withheld', F.evalNode(F.parse('pe > 0'), clash) === false);

console.log('\n[11] manual overrides (face value / promoter) feed the query');
F.setManual('RELIANCE.NS', { faceValue: 10, promoter: 50.31 });
const withManual = F.applyManual(F.buildBook('RELIANCE.NS', parsed, { price: 1420.5 }));
check('face value stored and read back', withManual.summary.faceValue === 10);
check('premium computed from price over face value', near(withManual.summary.premium, 142.05, 0.01), withManual.summary.premium);
check('promoter holding becomes queryable', F.evalNode(F.parse('promoter holding > 50'), withManual));
check('a symbol without manual entry simply has null', F.buildBook('TCS.NS', F.parseTimeseries(fixture('TCS.NS'), 'TCS.NS'), null).summary.faceValue === null);

console.log('\n[12] cache contract');
F.clearCache();
check('nothing cached to start', F.cached('RELIANCE.NS') === null);
const store = { cfg: {}, fetchJson: () => { throw new Error('should not be called'); } };
check('the module reads its own store key', U.store.get('fund:NOPE', 'fallback') === 'fallback');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
