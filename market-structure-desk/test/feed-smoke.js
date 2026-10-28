/* Optional network smoke test — validates venue routing, payload parsing and the engine
   against live quotes. Needs internet; the browser app reaches Yahoo through CORS relays,
   so this harness injects a browser User-Agent for the direct Node call.
     node test/feed-smoke.js [SYMBOL...]                                     */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
['js/util.js', 'js/data.js', 'js/analysis.js'].forEach(f =>
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f }));
const SD = global.window.SD;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const realFetch = global.fetch;
global.fetch = (u, o) => realFetch(u, Object.assign({}, o, { headers: Object.assign({ 'User-Agent': UA, Accept: '*/*' }, (o || {}).headers) }));

const CFG = {
  pivotWidth: 3, closeWeight: 0.75, lookback: 4, atrPeriod: 14,
  rvolThreshold: 1.3, sustainBars: 2, breakMargin: 0.15, requireVolume: true, wickPivots: true
};

const symbols = process.argv.slice(2).length ? process.argv.slice(2) : ['AAPL', 'RELIANCE.NS', 'TCS.NS', '^NSEI', '7203.T', 'BMW.DE'];

(async () => {
  let ok = 0, bad = 0;
  for (const raw of symbols) {
    const d = SD.Data.describeSymbol(raw);
    const spec = { symbol: d.symbol, interval: '1d', range: '1y', prePost: false };
    try {
      const s = await SD.Data.fetchSeries(spec, { base: 'https://query1.finance.yahoo.com/v8/finance/chart/', proxy: '', chain: [''], timeout: 15000, budget: 20000 });
      const m = SD.Analysis.run(s, CFG);
      const st = m.structure;
      console.log(
        'OK   ' + raw.padEnd(13) +
        '→ ' + String(s.symbol).padEnd(13) +
        ('  ' + s.exchange).padEnd(22) +
        String(s.currency).padEnd(4) +
        String(s.bars.length).padStart(4) + ' bars  ' +
        ('ATR ' + SD.U.fmtPrice(m.lastAtr, 3)).padEnd(12) +
        ('RVOL ' + (isFinite(m.volume.rvol) ? SD.U.round(m.volume.rvol, 2) : '—') + 'x').padEnd(11) +
        'score ' + String(st.bullScore).padStart(3) + '  ' + st.state
      );
      console.log('       ' + st.title + (st.lastHigh ? '  |  last high ' + SD.U.fmtPrice(st.lastHigh.price, m.dec) + ' (' + (st.lastHigh.rel || '-') + ')' : '') + (st.lastLow ? '  |  last low ' + SD.U.fmtPrice(st.lastLow.price, m.dec) + ' (' + (st.lastLow.rel || '-') + ')' : ''));
      console.log('       swings: ' + m.confirmedHighs.length + ' close-backed highs, ' + m.confirmedLows.length + ' lows · signals ' + m.signals.length + ' · unconfirmed ' + m.watch.length + ' · quality ' + m.quality.length);
      const tline = (label, t) => !t ? label + ' — none' : label + ' ' + SD.U.fmtPrice(t.atLast, m.dec) +
        ' ' + (t.slope > 0 ? 'rising' : t.slope < 0 ? 'falling' : 'flat') +
        ' · ' + (isFinite(t.slopeAtr) ? SD.U.round(Math.abs(t.slopeAtr), 3) : '—') + ' ATR/bar' +
        ' · ' + t.anchors + ' anchors · R2 ' + SD.U.round(t.fit, 2);
      console.log('       ' + tline('highs', m.trend.high) + '   |   ' + tline('lows', m.trend.low));
      if (m.trend.supportBroken) console.log('       NOTE support trendline broken this bar');
      if (m.trend.resistanceBroken) console.log('       NOTE resistance trendline broken this bar');
      const rej = [];
      if (!m.trend.high && isFinite(m.trend.rejected.high)) rej.push('high R2 ' + SD.U.round(m.trend.rejected.high, 2));
      if (!m.trend.low && isFinite(m.trend.rejected.low)) rej.push('low R2 ' + SD.U.round(m.trend.rejected.low, 2));
      if (rej.length) console.log('       rejected (noisy): ' + rej.join(', '));
      if (m.signals[0]) {
        const g = m.signals[0];
        console.log('       latest plan: ' + g.dir + ' entry ' + SD.U.fmtPrice(g.entry, m.dec) + ' stop ' + SD.U.fmtPrice(g.stop, m.dec) + ' T2 ' + SD.U.fmtPrice(g.t2, m.dec) + ' R:R ' + SD.U.round(g.rr, 2));
      }
      ok++;
    } catch (e) {
      console.log('FAIL ' + raw + '  ' + e.message);
      bad++;
    }
  }
  console.log('\n' + ok + ' loaded, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})();
