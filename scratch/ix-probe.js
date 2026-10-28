'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
global.window = global;
const LS = {};
global.localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(LS, k) ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v); }, removeItem: k => { delete LS[k]; },
  key: i => Object.keys(LS)[i], get length() { return Object.keys(LS).length; }
};
const CSV = fs.readFileSync(path.join(__dirname, '..', 'market-structure-desk', 'data', 'nse-listed.csv'), 'utf8');
global.fetch = async () => ({ ok: true, text: async () => CSV });
const root = path.join(__dirname, '..', 'market-structure-desk');
['js/util.js', 'js/data.js', 'js/tickers.js'].forEach(f => vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }));
const T = global.window.SD.Tickers, D = global.window.SD.Data;
(async () => {
  await T.loadSeed();
  const qs = ['NIFTY','NIFTY 50','NIFTY50','BANKNIFTY','BANK NIFTY','NIFTY BANK','SENSEX','BSE 30','NIFTY IT','NIFTY AUTO','MIDCPNIFTY','NIFTY MIDCAP','INDIAVIX','NIFTY PHARMA','^NSEI','Nikkei','S&P 500','SPX','NASDAQ','DOW','FTSE','STI','HANG SENG','KOSPI','VIX','RUSSELL','NIFTY 100','NIFTY FIN','HSI'];
  qs.forEach(raw => {
    const n = D.normaliseSymbol(raw);
    const r = T.search(raw);
    console.log(JSON.stringify(raw).padEnd(16) + ' norm=' + String(n).padEnd(14) + ' top=' + r.slice(0, 4).map(x => x.symbol + '(' + x.score + ')').join(' '));
  });
})();
console.log('\n--- candidates / venue ---');
['NIFTY','nifty 50','BANKNIFTY','SENSEX','SPX','S&P 500','^NSEI','RELIANCE','TATACHEM','NIFTYBEES','DOW','AAPL','HANG SENG'].forEach(r => {
  const d = D.describeSymbol(r, { home: 'IN' });
  console.log(JSON.stringify(r).padEnd(13), JSON.stringify(D.symbolCandidates(r, { home: 'IN' })).padEnd(42), d.symbol.padEnd(11), d.hint);
});
