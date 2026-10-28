/* Structure Desk — Books view: fundamentals, financial statements and a Screener-style query.
   One free keyless endpoint carries the whole book: Yahoo's fundamentals-timeseries answers
   annual + quarterly + trailing magnitudes in a single request, verified live on 2026-10-28
   (RELIANCE.NS returned 16 statement types in INR; quoteSummary/v7 quote are crumb-gated 401).
   Nothing here invents a number — a missing statement line stays "—". */
SD.Fund = (function () {
  'use strict';

  const U = SD.U;
  const TS_BASE = 'https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/';
  const MAG = 1e7;                       // one crore, the unit every magnitude in a query uses
  const TTL = 7 * 24 * 3600 * 1000;      // statements move quarterly; a week is generous

  const ANNUAL = [
    'annualTotalRevenue', 'annualTotalExpenses', 'annualOperatingIncome', 'annualGrossProfit',
    'annualPretaxIncome', 'annualNetIncome', 'annualInterestExpense',
    'annualDepreciationAndAmortization', 'annualBasicEPS', 'annualDilutedEPS',
    'annualDilutedAverageShares', 'annualCapitalExpenditure',
    'annualOperatingCashFlow', 'annualInvestingCashFlow', 'annualFinancingCashFlow',
    'annualChangesInCash', 'annualFreeCashFlow', 'annualCashDividendsPaid',
    'annualTotalAssets', 'annualStockholdersEquity', 'annualMinorityInterest',
    'annualCurrentAssets', 'annualCurrentLiabilities', 'annualTotalLiabilitiesNetMinorityInterest',
    'annualTotalDebt', 'annualLongTermDebt', 'annualCashAndCashEquivalents',
    'annualGoodwill', 'annualInventory', 'annualAccountsReceivable', 'annualCapitalStock'
  ];
  const QUARTERLY = [
    'quarterlyTotalRevenue', 'quarterlyTotalExpenses', 'quarterlyOperatingIncome',
    'quarterlyNetIncome', 'quarterlyDilutedEPS'
  ];
  const TRAILING = ['trailingMarketCap', 'trailingEnterpriseValue'];

  /* ------------------------------------------------------------------ fetch */
  function timeseriesUrl(symbol, types) {
    const p2 = Math.floor(Date.now() / 1000) + 3600;
    const p1 = p2 - 12 * 365 * 86400;
    return TS_BASE + encodeURIComponent(symbol) +
      '?symbol=' + encodeURIComponent(symbol) +
      '&type=' + encodeURIComponent(types.join(',')) +
      '&period1=' + p1 + '&period2=' + p2;
  }

  function looksLikeTimeseries(txt) {
    return !!txt && txt.indexOf('"timeseries"') >= 0;
  }

  /* Yahoo answers one result block per type that actually has data, so a missing statement line
     simply never appears — which is the difference between "no data" and zero. */
  function parseTimeseries(payload, symbol) {
    const res = payload && payload.timeseries && payload.timeseries.result;
    if (!Array.isArray(res) || !res.length) throw new Error('no fundamentals for ' + symbol);
    const series = {};
    const currencies = {};
    let currency = null;
    res.forEach(block => {
      const type = block.meta && block.meta.type && block.meta.type[0];
      if (!type) return;
      const arr = block[type] || [];
      const pts = [];
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (!p || !p.reportedValue || !isFinite(p.reportedValue.raw)) continue;
        pts.push({ asOf: p.asOfDate, raw: p.reportedValue.raw, fmt: p.reportedValue.fmt, currency: p.currencyCode });
        if (!currency) currency = p.currencyCode || null;
      }
      if (pts.length) {
        series[type] = pts;
        currencies[type] = modalCurrency(pts);
      }
    });
    if (!Object.keys(series).length) throw new Error('fundamentals empty for ' + symbol);
    return { series, currencies, currency };
  }

  /* A US-listed Indian company can report statements in USD while its market cap is quoted in INR,
     so every type carries its own currency and the two are only allowed to meet after a check. */
  function modalCurrency(pts) {
    const seen = {};
    let best = null, n = 0;
    pts.forEach(p => {
      const c = p.currency || null;
      if (!c) return;
      seen[c] = (seen[c] || 0) + 1;
      if (seen[c] > n) { n = seen[c]; best = c; }
    });
    return best;
  }

  function cacheKey(sym) { return 'fund:' + sym; }

  function cached(sym, maxAge) {
    const hit = U.store.get(cacheKey(sym), null);
    if (!hit || !hit.b || !hit.t) return null;
    if ((maxAge || TTL) <= 0) return hit;
    return Date.now() - hit.t < (maxAge || TTL) ? hit : null;
  }

  /* ------------------------------------------------------------------ statements */
  /* Rows are keyed by fiscal period so a P&L table can print one column per year the way
     Screener does, oldest first. */
  function periodMap(list) {
    const m = {};
    (list || []).forEach(p => { m[p.asOf] = p.raw; });
    return m;
  }

  /* The feed's type names are `annualTotalRevenue`; the row fields are camelCase without the
     prefix. Deriving one from the other by hand keeps the two in step with no table to forget. */
  function fieldOf(type) {
    const bare = String(type).replace(/^(annual|quarterly|trailing)/, '');
    return bare.charAt(0).toLowerCase() + bare.slice(1);
  }

  function buildBook(symbol, parsed, quote) {
    const s = parsed.series;
    const annualTypes = ANNUAL.filter(t => s[t]);
    const qTypes = QUARTERLY.filter(t => s[t]);
    const tTypes = TRAILING.filter(t => s[t]);
    if (!annualTypes.length && !qTypes.length) throw new Error('no statements for ' + symbol);

    const fiscalYears = [];
    annualTypes.forEach(t => s[t].forEach(p => { if (fiscalYears.indexOf(p.asOf) < 0) fiscalYears.push(p.asOf); }));
    fiscalYears.sort();

    const quarters = [];
    qTypes.forEach(t => s[t].forEach(p => { if (quarters.indexOf(p.asOf) < 0) quarters.push(p.asOf); }));
    quarters.sort();

    const maps = {};
    annualTypes.forEach(t => { maps[fieldOf(t)] = periodMap(s[t]); });
    const qmaps = {};
    qTypes.forEach(t => { qmaps[fieldOf(t)] = periodMap(s[t]); });

    const trailing = {};
    tTypes.forEach(t => { const list = s[t]; trailing[fieldOf(t)] = list[list.length - 1].raw; });
    const mcapHist = s.trailingMarketCap || [];

    const get = (row, key) => {
      const m = maps[key];
      if (!m) return null;
      const v = m[row.asOf];
      return v === undefined ? null : v;
    };

    const years = fiscalYears.map(fy => {
      const row = { asOf: fy, label: fyLabel(fy), currency: parsed.currency };
      Object.keys(maps).forEach(k => { row[k] = maps[k][fy] === undefined ? null : maps[k][fy]; });
      return deriveYear(row);
    }).filter(y => y.sales !== null || y.netProfit !== null);

    const qtr = quarters.map(q => {
      const row = { asOf: q, label: qLabel(q), currency: parsed.currency };
      Object.keys(qmaps).forEach(k => { row[k] = qmaps[k][q] === undefined ? null : qmaps[k][q]; });
      return deriveYear(row);
    }).filter(y => y.sales !== null || y.netProfit !== null);

    const last = years[years.length - 1] || null;
    const prev = years[years.length - 2] || null;
    const shares = last && last.dilutedAverageShares ? last.dilutedAverageShares : null;

    /* The tables are in the currency the statements were filed in. Market cap is quoted separately,
       and for an Indian IT name on the NSE the two disagree — USD books against an INR valuation.
       A ratio built by dividing one by the other is a number with no meaning at all. */
    const cur = parsed.currencies || {};
    const stmtCur = cur.annualTotalRevenue || parsed.currency || '';
    const mcapCur = cur.trailingMarketCap || stmtCur;
    const fx = stmtCur && mcapCur && stmtCur !== mcapCur ? stmtCur + '/' + mcapCur : null;

    return {
      symbol, currency: stmtCur, mcapCurrency: mcapCur, fxMismatch: fx,
      requestedSymbol: quote && quote.requestedSymbol || null,
      fetchedAt: Date.now(),
      years: years, quarters: qtr,
      types: { annual: annualTypes, quarterly: qTypes, trailing: tTypes },
      trailing: trailing, mcapHist: mcapHist,
      price: quote && quote.price != null ? quote.price : null,
      prevClose: quote && quote.prevClose != null ? quote.prevClose : null,
      high52: quote && quote.high52 != null ? quote.high52 : null,
      low52: quote && quote.low52 != null ? quote.low52 : null,
      manual: manualFor(symbol),
      summary: summaryOf(years, trailing, shares, !!fx)
    };
  }

  /* The Screener column set: OPM/interest/depreciation and the balance-sheet splits are derived
     from what the feed does carry, never guessed. */
  function deriveYear(r) {
    const out = Object.assign({}, r);
    out.sales = num(r.totalRevenue);
    out.expenses = num(r.totalExpenses);
    out.netProfit = num(r.netIncome);
    out.pretax = num(r.pretaxIncome);
    out.opProfit = firstNum(r.operatingIncome, r.totalRevenue != null && r.totalExpenses != null ? r.totalRevenue - r.totalExpenses : null);
    out.grossProfit = num(r.grossProfit);
    out.interest = num(r.interestExpense);
    out.depreciation = num(r.depreciationAndAmortization);
    out.eps = firstNum(r.dilutedEPS, r.basicEPS);
    out.shares = num(r.dilutedAverageShares);
    out.capex = num(r.capitalExpenditure);
    out.ocf = num(r.operatingCashFlow);
    out.icf = num(r.investingCashFlow);
    out.financingCash = num(r.financingCashFlow);
    out.changeInCash = num(r.changesInCash);
    out.freeCashFlow = firstNum(r.freeCashFlow, out.ocf != null && out.capex != null ? out.ocf + out.capex : null);
    out.dividends = num(r.cashDividendsPaid);
    out.totalAssets = num(r.totalAssets);
    /* Quarterly blocks carry no equity series, so ROE on a quarter has no honest denominator —
     it stays null rather than borrowing a stale balance sheet. */
    out.equity = num(r.stockholdersEquity);
    out.minority = num(r.minorityInterest);
    out.currentAssets = num(r.currentAssets);
    out.currentLiabilities = num(r.currentLiabilities);
    out.totalLiabilities = num(r.totalLiabilitiesNetMinorityInterest);
    out.debt = num(r.totalDebt);
    out.ltDebt = num(r.longTermDebt);
    out.cash = num(r.cashAndCashEquivalents);
    out.goodwill = num(r.goodwill);
    out.inventory = num(r.inventory);
    out.receivables = num(r.accountsReceivable);
    out.capitalStock = num(r.capitalStock);
    out.otherIncome = out.pretax != null && out.opProfit != null && out.interest != null && out.depreciation != null
      ? out.pretax - out.opProfit + out.interest + out.depreciation : null;
    out.taxPct = out.pretax != null && out.netProfit != null && out.pretax > 0
      ? 100 * (out.pretax - out.netProfit) / out.pretax : null;
    out.opmPct = out.opProfit != null && out.sales > 0 ? 100 * out.opProfit / out.sales : null;
    out.npmPct = out.netProfit != null && out.sales > 0 ? 100 * out.netProfit / out.sales : null;
    out.gmPct = out.grossProfit != null && out.sales > 0 ? 100 * out.grossProfit / out.sales : null;
    /* Capital employed = total assets − current liabilities, so ROCE ignores payables financing. */
    out.capitalEmployed = out.totalAssets != null && out.currentLiabilities != null ? out.totalAssets - out.currentLiabilities : null;
    out.rocePct = out.opProfit != null && out.capitalEmployed > 0 ? 100 * out.opProfit / out.capitalEmployed : null;
    out.roePct = out.netProfit != null && out.equity > 0 ? 100 * out.netProfit / out.equity : null;
    out.debtToEquity = out.debt != null && out.equity > 0 ? out.debt / out.equity : null;
    out.currentRatio = out.currentAssets != null && out.currentLiabilities > 0 ? out.currentAssets / out.currentLiabilities : null;
    out.interestCover = out.opProfit != null && out.interest > 0 ? out.opProfit / out.interest : null;
    out.bookValuePs = out.equity != null && out.shares > 0 ? out.equity / out.shares : null;
    out.divPs = out.dividends != null && out.shares > 0 ? Math.abs(out.dividends) / out.shares : null;
    out.ocfPs = out.ocf != null && out.shares > 0 ? out.ocf / out.shares : null;
    out.pledges = null;                    // no free source; manual override only
    return out;
  }

  function summaryOf(years, trailing, shares, fxMismatch) {
    const last = years[years.length - 1] || null;
    const mcap = trailing.marketCap != null ? trailing.marketCap : null;
    const sameMoney = !fxMismatch;
    const out = {
      mcap: mcap,
      ev: mcap != null && sameMoney && trailing.enterpriseValue != null ? trailing.enterpriseValue : null,
      // Stock P/E on market cap over net profit is the same ratio price/EPS gives, and does not
      // need a live quote, so it still reads on a weekend.
      pe: sameMoney && mcap != null && last && last.netProfit > 0 ? mcap / last.netProfit : null,
      pbv: sameMoney && mcap != null && last && last.equity > 0 ? mcap / last.equity : null,
      ps: sameMoney && mcap != null && last && last.sales > 0 ? mcap / last.sales : null,
      divYield: sameMoney && mcap != null && last && last.dividends != null ? 100 * Math.abs(last.dividends) / mcap : null,
      faceValue: null,
      promoterHolding: null,
      debtToEquity: last ? last.debtToEquity : null,
      roce: last ? last.rocePct : null,
      roe: last ? last.roePct : null,
      opm: last ? last.opmPct : null,
      npm: last ? last.npmPct : null,
      salesCr: last && last.sales != null ? last.sales / MAG : null,
      profitCr: last && last.netProfit != null ? last.netProfit / MAG : null,
      fcfCr: last && last.freeCashFlow != null ? last.freeCashFlow / MAG : null,
      debtCr: last && last.debt != null ? last.debt / MAG : null,
      networthCr: last && last.equity != null ? last.equity / MAG : null,
      eps: last ? last.eps : null,
      bookValue: last ? last.bookValuePs : null,
      sharesCr: shares ? shares / MAG : null
    };
    return out;
  }

  /* ------------------------------------------------------------------ display units
     A NSE trader reads crores and a Nasdaq trader reads billions, and the same table has to serve
     both. Magnitudes stay absolute in the file; only the rendering divides. */
  const UNITS = {
    INR: { div: 1e7, label: 'Cr', sub: 'L' },
    IDR: { div: 1e7, label: 'Cr', sub: 'L' },
    KRW: { div: 1e7, label: 'Cr', sub: 'L' },
    VND: { div: 1e7, label: 'Cr', sub: 'L' }
  };
  function unitFor(currency) {
    return UNITS[currency] || { div: 1e6, label: 'Mn', sub: 'k' };
  }

  /* Quarter-over-quarter is noise; what a reader wants is the same quarter last year, which is how
     Screener labels its quarterly growth. If the year-ago quarter is not in the feed, say nothing
     rather than comparing against a random earlier quarter. */
  function qGrowth(quarters, key) {
    const list = (quarters || []).filter(r => r[key] != null && r[key] !== 0);
    if (list.length < 2) return null;
    const newest = list[list.length - 1];
    const month = String(newest.asOf).slice(5, 7);
    const year = +String(newest.asOf).slice(0, 4);
    const prior = list.filter(r => String(r.asOf).slice(5, 7) === month && +String(r.asOf).slice(0, 4) === year - 1)[0];
    if (!prior || !(prior[key] > 0) || !(newest[key] > 0)) return null;
    return 100 * (newest[key] / prior[key] - 1);
  }

  function firstNum() {
    for (let i = 0; i < arguments.length; i++) if (isFinite(arguments[i])) return arguments[i];
    return null;
  }
  function num(v) { return isFinite(v) ? v : null; }

  function fyLabel(iso) {
    const p = String(iso || '').split('-');
    if (p.length < 3) return iso || '—';
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+p[1] - 1] + ' ' + p[0];
  }
  function qLabel(iso) {
    const p = String(iso || '').split('-');
    if (p.length < 3) return iso || '—';
    const q = Math.ceil(+p[1] / 3);
    return 'Q' + q + ' ' + p[0];
  }

  /* ------------------------------------------------------------------ growth over the series */
  function growthPct(list, key, back) {
    const vals = (list || []).filter(r => r[key] != null && r[key] !== 0);
    if (vals.length < 2) return null;
    const n = Math.max(1, back || 1);
    const newest = vals[vals.length - 1][key];
    const oldest = vals[Math.max(0, vals.length - 1 - n)][key];
    if (!(oldest > 0) || !(newest > 0)) return null;
    if (n === 1) return 100 * (newest / oldest - 1);
    return 100 * (Math.pow(newest / oldest, 1 / n) - 1);
  }

  function latest(list, key) {
    for (let i = (list || []).length - 1; i >= 0; i--) if (list[i][key] != null) return list[i][key];
    return null;
  }

  /* ------------------------------------------------------------------ manual overrides
     Screener shows face value, promoter holding and pledges; Yahoo publishes none of them, so
     these come from the user's own entry and are saved per symbol. Anything typed here is what a
     query sees — a manual number always beats the derived one. */
  function manualFor(symbol) {
    const all = U.store.get('fundManual', {});
    const k = symKey(symbol);
    return all[k] || all[String(symbol || '')] || {};
  }

  function setManual(symbol, patch) {
    const all = U.store.get('fundManual', {});
    const k = symKey(symbol);
    all[k] = Object.assign({}, all[k] || {}, patch);
    U.store.set('fundManual', all);
    return all[k];
  }

  function symKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9.]/g, ''); }

  function applyManual(book) {
    if (!book) return book;
    const m = book.manual || {};
    if (m.faceValue != null) book.summary.faceValue = +m.faceValue;
    if (m.promoter != null) book.summary.promoterHolding = +m.promoter;
    if (m.pledged != null) book.summary.pledgedPct = +m.pledged;
    if (m.pe != null) book.summary.pe = +m.pe;
    if (m.mcap != null) book.summary.mcap = +m.mcap * MAG;
    // A face value lets the desk read the premium; Screener traders look at it before anything else.
    book.summary.premium = (m.faceValue > 0 && book.price) ? book.price / (+m.faceValue) : null;
    return book;
  }

  /* ------------------------------------------------------------------ query language
     Fields are dotted or space separated, magnitudes are in crore, percents are plain numbers,
     and `and`/`or`/parentheses nest. `avg|min|max` and `N years` work over the statement series. */
  const FIELDS = {
    'sales': { unit: 'cr', get: b => lastMag(b, 'sales') },
    /* "Sales growth 5years" is the 5-year CAGR and bare "sales growth" is last year over the
     year before, which is exactly how Screener's two forms behave. */
    'sales growth': { unit: '%', get: (b, n) => growthPct(b.years, 'sales', n || 1) },
    'sales cagr': { unit: '%', get: (b, n) => growthPct(b.years, 'sales', n || 3) },
    'profit': { unit: 'cr', get: b => lastMag(b, 'netProfit') },
    'net profit': { unit: 'cr', get: b => lastMag(b, 'netProfit') },
    'profit growth': { unit: '%', get: (b, n) => growthPct(b.years, 'netProfit', n || 1) },
    'profit cagr': { unit: '%', get: (b, n) => growthPct(b.years, 'netProfit', n || 3) },
    'op profit': { unit: 'cr', get: b => lastMag(b, 'opProfit') },
    'oppm': { unit: '%', get: b => latest(b.years, 'opmPct') },
    'opm': { unit: '%', get: b => latest(b.years, 'opmPct') },
    'opm growth': { unit: '%', get: b => growthPct(b.years, 'opmPct', 1) },
    'npm': { unit: '%', get: b => latest(b.years, 'npmPct') },
    'gm': { unit: '%', get: b => latest(b.years, 'gmPct') },
    'roce': { unit: '%', get: b => latest(b.years, 'rocePct') },
    'roe': { unit: '%', get: b => latest(b.years, 'roePct') },
    'debt': { unit: 'cr', get: b => lastMag(b, 'debt') },
    'debt to equity': { unit: 'x', get: b => latest(b.years, 'debtToEquity') },
    'net worth': { unit: 'cr', get: b => lastMag(b, 'equity') },
    'current ratio': { unit: 'x', get: b => latest(b.years, 'currentRatio') },
    'interest coverage': { unit: 'x', get: b => latest(b.years, 'interestCover') },
    /* Capex arrives negative from the feed. A screen reads "capex < ocf" as spend out of
     operations, so the field is the amount of the spend, not its signed cash effect. */
    'capex': { unit: 'cr', get: b => { const v = latest(b.years, 'capex'); return v == null ? null : Math.abs(v) / MAG; } },
    'fcf': { unit: 'cr', get: b => lastMag(b, 'freeCashFlow') },
    'ocf': { unit: 'cr', get: b => lastMag(b, 'ocf') },
    'dividends': { unit: 'cr', get: b => { const v = latest(b.years, 'dividends'); return v == null ? null : Math.abs(v) / MAG; } },
    'dividend yield': { unit: '%', get: b => b.summary.divYield },
    'dividend per share': { unit: 'x', get: b => latest(b.years, 'divPs') },
    'market cap': { unit: 'cr', get: b => b.summary.mcap != null ? b.summary.mcap / MAG : null },
    'pe': { unit: 'x', get: b => b.summary.pe },
    'pbv': { unit: 'x', get: b => b.summary.pbv },
    'ps': { unit: 'x', get: b => b.summary.ps },
    'eps': { unit: 'x', get: b => latest(b.years, 'eps') },
    'book value': { unit: 'x', get: b => latest(b.years, 'bookValuePs') },
    'price': { unit: 'x', get: b => b.price },
    '52 week high': { unit: 'x', get: b => b.high52 },
    '52 week low': { unit: 'x', get: b => b.low52 },
    'face value': { unit: 'x', get: b => b.summary.faceValue },
    'promoter holding': { unit: '%', get: b => b.summary.promoterHolding },
    'pledged': { unit: '%', get: b => b.summary.pledgedPct },
    'cash': { unit: 'cr', get: b => lastMag(b, 'cash') },
    'inventory': { unit: 'cr', get: b => lastMag(b, 'inventory') },
    'receivables': { unit: 'cr', get: b => lastMag(b, 'receivables') },
    'tax ratio': { unit: '%', get: b => latest(b.years, 'taxPct') },
    'years': { unit: 'n', get: b => b.years.length },
    'quarters': { unit: 'n', get: b => b.quarters.length },
    'q sales': { unit: 'cr', get: b => mag(b.quarters, 'sales') },
    'q sales growth': { unit: '%', get: b => qGrowth(b.quarters, 'sales') },
    'q profit': { unit: 'cr', get: b => mag(b.quarters, 'netProfit') },
    'q profit growth': { unit: '%', get: b => qGrowth(b.quarters, 'netProfit') },
    'q npm': { unit: '%', get: b => latest(b.quarters, 'npmPct') },
    'q roce': { unit: '%', get: b => latest(b.quarters, 'rocePct') }
  };

  function lastMag(b, key) {
    const v = latest(b.years, key);
    return v == null ? null : v / MAG;
  }
  function mag(list, key) {
    for (let i = list.length - 1; i >= 0; i--) if (list[i][key] != null) return list[i][key] / MAG;
    return null;
  }

  const ALIASES = (function () {
    const map = {};
    Object.keys(FIELDS).forEach(f => { map[f] = f; });
    // Traders type these with spaces, slashes, or no spaces at all.
    ['marketcap', 'mcap', 'mktcap'].forEach(a => map[a] = 'market cap');
    ['stockpe', 'pe ratio', 'p/e'].forEach(a => map[a] = 'pe');
    ['debt/equity', 'd/e', 'de'].forEach(a => map[a] = 'debt to equity');
    ['opprofit', 'operating profit', 'ebit'].forEach(a => map[a] = 'op profit');
    ['netprofit', 'profit after tax', 'pat'].forEach(a => map[a] = 'profit');
    ['netmargin', 'net margin', 'netprofitmargin'].forEach(a => map[a] = 'npm');
    ['operatingmargin', 'operating margin'].forEach(a => map[a] = 'opm');
    ['return on equity'].forEach(a => map[a] = 'roe');
    ['return on capital employed'].forEach(a => map[a] = 'roce');
    ['freecashflow', 'free cash flow'].forEach(a => map[a] = 'fcf');
    ['divyield', 'div yield'].forEach(a => map[a] = 'dividend yield');
    ['bookvalue', 'bvps'].forEach(a => map[a] = 'book value');
    ['promoter', 'promoterholding'].forEach(a => map[a] = 'promoter holding');
    ['interestcover'].forEach(a => map[a] = 'interest coverage');
    ['tax', 'tax rate', 'taxpercent'].forEach(a => map[a] = 'tax ratio');
    return map;
  })();
  // Longest first: "sales growth" must not be read as "sales" followed by junk.
  const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

  /* Tokens: a field, optionally preceded by an aggregate the way Screener writes it
     ("Average Roce 5years"), optionally followed by "N years", then an operator and a number that
     may carry a cr or lakh suffix. */
  function tokenize(src) {
    const out = [];
    const s = String(src || '').toLowerCase().replace(/\s+/g, ' ').trim();
    let i = 0;
    const spaces = () => { while (s[i] === ' ') i++; };
    while (i < s.length) {
      spaces();
      if (i >= s.length) break;
      const c = s[i];
      if (c === '(') { out.push({ t: 'lp' }); i++; continue; }
      if (c === ')') { out.push({ t: 'rp' }); i++; continue; }
      if (/^and(\s|\()/i.test(s.slice(i))) { out.push({ t: 'and' }); i += 3; continue; }
      if (/^or(\s|\()/i.test(s.slice(i))) { out.push({ t: 'or' }); i += 2; continue; }
      if (/^not(\s|\()/i.test(s.slice(i))) { out.push({ t: 'not' }); i += 3; continue; }
      const m2 = /^(>=|<=|!=)/.exec(s.slice(i));
      if (m2) { out.push({ t: 'op', v: m2[1] }); i += 2; continue; }
      if (c === '>' || c === '<' || c === '=' || c === '~') { out.push({ t: 'op', v: c }); i++; continue; }
      /* A bare magnitude reads as crore, the way Screener's own query box does. A suffix makes it
         absolute in the instrument's currency, which is how a US name gets written at all. */
      const num = /^([0-9]+(?:\.[0-9]+)?)(cr|lakh|mn|bn|%)?/.exec(s.slice(i));
      if (num) {
        const n = parseFloat(num[1]);
        out.push({ t: 'num', n: n, suffix: num[2] || null, v: n * ({ cr: MAG, lakh: 1e5, mn: 1e6, bn: 1e9 }[num[2]] || 1) });
        i += num[0].length;
        continue;
      }
      /* Screener writes the aggregate in front — "Average Roce 5years > 20" — so consume it before
         the field name, then normalise average/avg and min/minimum onto one keyword. */
      const aggM = /^(avg|average|min|minimum|max|maximum|sum|latest)\s+/.exec(s.slice(i));
      if (aggM) i += aggM[0].length;
      const agg = aggM ? (/^a/.test(aggM[1]) ? 'avg' : /^mi/.test(aggM[1]) ? 'min' : /^ma/.test(aggM[1]) ? 'max' : aggM[1]) : null;
      let hit = null;
      // Longest matching field name wins, so "sales growth" is not read as "sales".
      for (let k = 0; k < ALIAS_KEYS.length; k++) {
        const name = ALIAS_KEYS[k];
        if (s.startsWith(name, i)) { hit = ALIASES[name]; i += name.length; break; }
      }
      if (!hit) throw new Error('unknown field near "' + s.slice(aggM ? i - aggM[0].length : i, i + 18) + '"');
      let nYears = null;
      const yrM = /^\s*([0-9]+)\s*years?\b/.exec(s.slice(i));
      if (yrM) { nYears = +yrM[1]; i += yrM[0].length; }
      out.push({ t: 'field', v: hit, agg: agg, n: nYears });
    }
    return out;
  }

  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    function peek() { return toks[p]; }
    function eat(t) { if (toks[p] && toks[p].t === t) return toks[p++]; throw new Error('expected ' + t); }

    function exprOr() {
      let left = exprAnd();
      while (peek() && peek().t === 'or') { p++; left = { op: 'or', a: left, b: exprAnd() }; }
      return left;
    }
    function exprAnd() {
      let left = exprNot();
      while (peek() && peek().t === 'and') { p++; left = { op: 'and', a: left, b: exprNot() }; }
      return left;
    }
    function exprNot() {
      if (peek() && peek().t === 'not') { p++; return { op: 'not', a: exprNot() }; }
      return primary();
    }
    function primary() {
      if (peek() && peek().t === 'lp') { p++; const e = exprOr(); eat('rp'); return e; }
      const f = eat('field');
      const o = eat('op');
      const n = eat('num');
      return { op: o.v, field: f.v, agg: f.agg, n: f.n, value: n.n, suffix: n.suffix, absolute: n.v };
    }
    const ast = exprOr();
    if (p < toks.length) throw new Error('unexpected trailing text');
    return ast;
  }

  /* A literal's unit is decided against the field it is compared to: a bare number on a magnitude
     is crore (Screener's own convention), a suffix is absolute native currency, and a ratio or
     percent field always takes the number as written. */
  function threshold(node, unit) {
    if (!node.suffix || node.suffix === '%') return node.value;
    return unit === 'cr' ? node.absolute / MAG : node.absolute;
  }

  function evalNode(node, book) {
    if (node.op === 'and') return evalNode(node.a, book) && evalNode(node.b, book);
    if (node.op === 'or') return evalNode(node.a, book) || evalNode(node.b, book);
    if (node.op === 'not') return !evalNode(node.a, book);
    const def = FIELDS[node.field];
    if (!def) return false;
    let v;
    if (node.agg === 'avg' || node.agg === 'min' || node.agg === 'max' || node.agg === 'sum') {
      v = aggField(book, node.field, node.agg, node.n);
    } else {
      v = node.n ? def.get(book, node.n) : def.get(book);
    }
    if (v == null || !isFinite(v)) return false;   // no data never satisfies a condition
    const t = threshold(node, def.unit);
    switch (node.op) {
      case '>': return v > t;
      case '<': return v < t;
      case '>=': return v >= t;
      case '<=': return v <= t;
      case '!=': return Math.abs(v - t) > 1e-9;
      default: return Math.abs(v - t) <= 1e-9 || v === t;
    }
  }

  /* Aggregates run over the annual series, not the snapshot: "avg roce 5 years" is a Screener
     staple and needs every year's value, not just the last one. */
  function aggField(book, field, agg, n) {
    const key = SERIES_KEY[field];
    if (key && book.years) {
      let vals = book.years.map(r => r[key]).filter(v => v != null && isFinite(v));
      if (n) vals = vals.slice(-n);
      if (!vals.length) return null;
      if (agg === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
      if (agg === 'sum') return vals.reduce((a, b) => a + b, 0);
      if (agg === 'min') return Math.min.apply(null, vals);
      return Math.max.apply(null, vals);
    }
    // An aggregate over a snapshot field ("avg market cap") has no series to average — saying so is
    // better than quietly returning the latest value as if it were an average.
    return null;
  }

  const SERIES_KEY = {
    'roce': 'rocePct', 'roe': 'roePct', 'opm': 'opmPct', 'oppm': 'opmPct', 'npm': 'npmPct',
    'gm': 'gmPct', 'sales': 'sales', 'profit': 'netProfit', 'net profit': 'netProfit',
    'debt to equity': 'debtToEquity', 'current ratio': 'currentRatio', 'fcf': 'freeCashFlow',
    'op profit': 'opProfit', 'eps': 'eps', 'debt': 'debt'
  };

  /* ------------------------------------------------------------------ preset screens
     Written against the fields this build can actually compute. Each one states its own budget in
     requests so a click never silently hammers a free relay. */
  const PRESETS = [
    { name: 'Quality compounders', q: 'roe > 15 and roce > 15 and sales growth > 8 and debt to equity < 1',
      note: 'Four fiscal years of evidence per name — profit still growing and not levered into the return.' },
    { name: 'Debt-light margin makers', q: 'debt to equity < 0.3 and opm > 20 and fcf > 0',
      note: 'Own-money business: low leverage, pricing power, positive free cash flow.' },
    { name: 'Cheap on earnings', q: 'pe > 0 and pe < 18 and profit growth > 5 and npm > 8',
      note: 'Below-market P/E on trailing market cap over last-fiscal-year net profit.' },
    { name: 'Large stable earners', q: 'market cap > 20000 and avg roce > 12 and max npm > 10 and years > 3',
      note: 'Big, and consistently capable — average over every year the feed returns.' },
    { name: 'Quarterly momentum', q: 'q sales growth > 10 and q profit growth > 15 and q npm > 8',
      note: 'The last five reported quarters only; a read on the current half, not the decade.' },
    { name: 'Smallcap turnaround', q: 'market cap > 1000 and market cap < 10000 and profit growth > 25 and debt to equity < 1',
      note: 'Small, profitable and accelerating, with a balance sheet that can carry the next leg.' },
    { name: 'Cash machines', q: 'ocf > 0 and fcf > 0 and dividends > 0 and debt to equity < 1',
      note: 'Free cash flow is operating cash flow after capex, so a positive figure here already says the spending was funded from operations, not from new debt.' }
  ];

  /* ------------------------------------------------------------------ public read */
  /* A book is one request. The quote is not: price, 52-week range and market cap live in the v8
     chart meta, so the caller hands those in from the tape the Desk already holds when it can. */
  async function load(raw, cfg, o) {
    o = o || {};
    const requested = SD.Data.normaliseSymbol(raw);
    const tries = SD.Data.orderedSymbols(requested, cfg);
    // tries[0] is the remembered resolution when there is one, so a name typed bare and the same
    // name reached as RESOLVED.NS land on one cache entry rather than two books.
    const key = symKey(tries[0] || requested);
    if (!o.force) {
      const hit = cached(key, o.maxAge);
      if (hit) return decorate(hit.b, o.quote);
    }
    const types = o.statementsOnly ? ANNUAL.concat(QUARTERLY) : ANNUAL.concat(QUARTERLY, TRAILING);
    const all = [];
    let lastErr = null;
    for (let i = 0; i < tries.length; i++) {
      try {
        const url = timeseriesUrl(tries[i], types);
        const r = await SD.Data.fetchJson(url, cfg || {}, looksLikeTimeseries, all);
        const parsed = parseTimeseries(r.payload, tries[i]);
        SD.Data.rememberResolution(requested, tries[i]);
        const book = buildBook(tries[i], parsed, o.quote);
        book.via = r.via;
        book.requested = requested;
        remember(book, key);
        return decorate(book, o.quote);
      } catch (e) {
        lastErr = e;
        if (!SD.Data.isNotFound(e) && !/no fundamentals|no statements|fundamentals empty/i.test(String(e.message))) break;
      }
    }
    throw lastErr || new Error('no fundamentals for ' + requested);
  }

  function remember(book, key) {
    const stamp = { t: Date.now(), b: book };
    U.store.set(cacheKey(key), stamp);
    U.store.set(cacheKey(symKey(book.symbol)), stamp);
    if (SD.Tickers) SD.Tickers.rememberBook(book);
  }

  function decorate(book, quote) {
    if (quote) {
      book.price = quote.price != null ? quote.price : book.price;
      book.prevClose = quote.prevClose != null ? quote.prevClose : book.prevClose;
      book.high52 = quote.high52 != null ? quote.high52 : book.high52;
      book.low52 = quote.low52 != null ? quote.low52 : book.low52;
    }
    return applyManual(book);
  }

  /* Screen a list of books against a query. Returns the survivors with the fields the table shows,
     so the caller never has to re-run the parser to paint a row. */
  function screen(querySrc, books) {
    const ast = querySrc && querySrc.trim() ? parse(querySrc) : null;
    const out = [];
    books.forEach(b => {
      if (!b || !b.years || !b.years.length) return;
      const ok = !ast || evalNode(ast, b);
      if (ok) out.push(rowOf(b, ast));
    });
    out.sort((a, b) => (b.f.marketCap || 0) - (a.f.marketCap || 0));
    return out;
  }

  function rowOf(book, ast) {
    const f = {};
    COLS.forEach(c => { f[c.k] = c.get(book); });
    return { symbol: book.symbol, book: book, f: f };
  }

  /* The result table columns, in Screener order. Magnitudes are in the currency the company files
     in, which a mixed India/US/SG universe makes a column of its own rather than a footnote. */
  const COLS = [
    { k: 'symbol', t: 'Company', txt: true, get: b => b.symbol },
    { k: 'cur', t: 'Cur', txt: true, get: b => b.currency },
    { k: 'price', t: 'Price', get: b => b.price },
    { k: 'marketCap', t: 'Mkt Cap Cr', get: b => b.summary.mcap != null ? b.summary.mcap / MAG : null },
    { k: 'pe', t: 'P/E', get: b => b.summary.pe },
    { k: 'sales', t: 'Sales Cr', get: b => lastMag(b, 'sales') },
    { k: 'salesG', t: 'Sales Gr %', get: b => growthPct(b.years, 'sales', 1) },
    { k: 'profit', t: 'Profit Cr', get: b => lastMag(b, 'netProfit') },
    { k: 'profitG', t: 'Profit Gr %', get: b => growthPct(b.years, 'netProfit', 1) },
    { k: 'opm', t: 'OPM %', get: b => latest(b.years, 'opmPct') },
    { k: 'npm', t: 'NPM %', get: b => latest(b.years, 'npmPct') },
    { k: 'roe', t: 'ROE %', get: b => latest(b.years, 'roePct') },
    { k: 'roce', t: 'ROCE %', get: b => latest(b.years, 'rocePct') },
    { k: 'de', t: 'D/E', get: b => latest(b.years, 'debtToEquity') },
    { k: 'debt', t: 'Debt Cr', get: b => lastMag(b, 'debt') },
    { k: 'fcf', t: 'FCF Cr', get: b => lastMag(b, 'freeCashFlow') },
    { k: 'divYield', t: 'Div Yld %', get: b => b.summary.divYield },
    { k: 'pbv', t: 'P/BV', get: b => b.summary.pbv }
  ];

  function clearCache(symbol) {
    if (typeof localStorage === 'undefined') return;
    if (symbol) { localStorage.removeItem('sd:' + cacheKey(symKey(symbol))); return; }
    Object.keys(localStorage).forEach(k => { if (String(k).indexOf('sd:fund:') === 0) localStorage.removeItem(k); });
  }

  return {
    ANNUAL_TYPES: ANNUAL, QUARTERLY_TYPES: QUARTERLY, TRAILING_TYPES: TRAILING,
    FIELDS, ALIASES, COLS, PRESETS, MAG, TTL,
    timeseriesUrl, parseTimeseries, buildBook, deriveYear, growthPct, latest,
    unitFor, qGrowth, cached, load, screen, rowOf, applyManual, manualFor, setManual, symKey,
    tokenize, parse, evalNode, aggField, clearCache,
    fyLabel, qLabel
  };
})();
