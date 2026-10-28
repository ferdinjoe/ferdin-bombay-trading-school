/* Indicator harness — the studies library is arithmetic the trader will read a decision off,
   so every function here is checked against a hand-computed value, not against itself.
   Run: node test/indicator-harness.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const sandbox = global.window;
['js/util.js', 'js/data.js', 'js/analysis.js', 'js/indicators.js'].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), { filename: f });
});
const SD = sandbox.SD;
const I = SD.Ind;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
const near = (a, b, tol) => isFinite(a) && Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);
function nanFree(a) { return a.filter(v => isFinite(v)).length; }

/* ---------------------------------------------------------------- 1. moving averages */
check('SMA 3 of 1..5 starts at the third bar and equals the window mean',
  JSON.stringify(I.sma([1, 2, 3, 4, 5], 3)) === '[null,null,2,3,4]' ||
  (isNaN(I.sma([1, 2, 3, 4, 5], 3)[0]) && near(I.sma([1, 2, 3, 4, 5], 3)[2], 2) && near(I.sma([1, 2, 3, 4, 5], 3)[4], 4)),
  JSON.stringify(I.sma([1, 2, 3, 4, 5], 3)));

const flat = new Array(40).fill(7.5);
check('SMA of a flat tape is that price', near(I.lastVal(I.sma(flat, 20)), 7.5));
check('EMA of a flat tape is that price', near(I.lastVal(I.ema(flat, 20)), 7.5));
check('EMA is SMA-seeded, not first-price-seeded',
  (() => { const e = I.ema([1, 2, 3, 4, 5], 3); return isNaN(e[1]) && near(e[2], 2) && near(e[3], 3) && near(e[4], 4); })(),
  JSON.stringify(I.ema([1, 2, 3, 4, 5], 3)));
check('EMA lags the ramp, SMA tracks its centre',
  (() => { const r = []; for (let i = 1; i <= 30; i++) r.push(i); return I.lastVal(I.ema(r, 10)) < I.lastVal(I.sma(r, 10)) + 1; })());
check('warm-up bars stay NaN instead of inventing a value',
  (() => { const e = I.ema([1, 2, 3], 10); return e.length === 3 && e.every(v => !isFinite(v)); })());

/* ---------------------------------------------------------------- 2. RSI */
const up = []; for (let i = 0; i < 40; i++) up.push(100 + i);
const dn = []; for (let i = 0; i < 40; i++) dn.push(100 - i);
check('RSI of an unbroken advance is 100', near(I.lastVal(I.rsi(up, 14)), 100));
check('RSI of an unbroken decline is 0', near(I.lastVal(I.rsi(dn, 14)), 0));
check('RSI of an unchanged tape is the neutral 50', near(I.lastVal(I.rsi(flat, 14)), 50));
check('RSI never leaves 0..100', (() => {
  const r = I.rsi(up.concat(dn).concat(up), 14);
  return r.every(v => !isFinite(v) || (v >= 0 && v <= 100));
})());

/* Closes 44 … 46.28, length 14. The 14 changes sum to gains 3.68 / losses 1.40,
   so avgG 0.2628571, avgL 0.1 → RS 2.6285714 → RSI 100 − 100/(1+RS) = 72.44094. */
const sc = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28];
const r14 = I.rsi(sc, 14);
check('RSI matches the hand-computed Wilder value (72.44094) on the reference series',
  isNaN(r14[13]) && near(r14[14], 72.44094, 1e-3), 'first=' + r14[13] + ' got=' + r14[14]);

/* ---------------------------------------------------------------- 3. MACD */
const ramp = []; for (let i = 1; i <= 80; i++) ramp.push(i * 2);
const mUp = I.macd(ramp, 12, 26, 9);
check('MACD line is 0 on a flat tape', (() => { const m = I.macd(flat, 12, 26, 9); return near(I.lastVal(m.line), 0, 1e-9) && near(I.lastVal(m.hist), 0, 1e-9); })());
check('MACD is positive when the fast average runs above the slow one', I.lastVal(mUp.line) > 0, I.lastVal(mUp.line));
check('MACD line starts on bar 26 (slow length), not before', I.lastIdx(mUp.line) === mUp.line.length - 1 &&
  (() => { let first = -1; for (let i = 0; i < mUp.line.length; i++) if (isFinite(mUp.line[i])) { first = i; break; } return first === 25; })());
check('signal line starts 9 usable bars after the line', (() => {
  let f = -1; for (let i = 0; i < mUp.signal.length; i++) if (isFinite(mUp.signal[i])) { f = i; break; } return f === 25 + 8; })(), 'first signal ' + mUp.signal.findIndex(isFinite));
check('histogram is exactly line − signal wherever both exist', (() => {
  for (let i = 0; i < mUp.line.length; i++) {
    if (!isFinite(mUp.hist[i])) continue;
    if (!near(mUp.hist[i], mUp.line[i] - mUp.signal[i], 1e-9)) return false;
  }
  return nanFree(mUp.hist) > 40;
})());

/* ---------------------------------------------------------------- 4. Bollinger + ATR band */
const wob = []; for (let i = 0; i < 60; i++) wob.push(100 + Math.sin(i / 3) * 5);
const bb = I.bbands(wob, 20, 2);
check('Bollinger mid IS the 20 SMA', (() => {
  const s = I.sma(wob, 20);
  for (let i = 19; i < wob.length; i++) if (!near(bb.mid[i], s[i], 1e-9)) return false;
  return true;
})());
check('bands are symmetric about the mid', (() => {
  for (let i = 25; i < wob.length; i++) if (!near(bb.upper[i] - bb.mid[i], bb.mid[i] - bb.lower[i], 1e-9)) return false;
  return true;
})());
check('a flat tape collapses the channel to a single line', (() => {
  const f = I.bbands(flat, 20, 2);
  return near(f.upper[39], 7.5) && near(f.lower[39], 7.5) && near(f.sd[39], 0);
})());
check('width is 2·mult·population sigma', (() => {
  const i = 40, w = wob.slice(i - 19, i + 1), mean = bb.mid[i];
  const sd = Math.sqrt(w.reduce((a, v) => a + (v - mean) * (v - mean), 0) / 20);
  return near(bb.upper[i] - bb.lower[i], 4 * sd, 1e-9);
})());

const CFG = { pivotWidth: 3, closeWeight: 0.75, lookback: 4, atrPeriod: 14, rvolThreshold: 1.3, sustainBars: 2, breakMargin: 0.15, requireVolume: true, wickPivots: true };
const model = SD.Analysis.run(SD.Data.demoSeries('PROOF', 180, '1d'), CFG);
const ab = I.atrBand(model.bars.map(b => b.c), model.atr, 2);
check('ATR band is the close ± 2·the engine\'s own ATR', (() => {
  const i = model.bars.length - 1;
  return near(ab.upper[i], model.bars[i].c + 2 * model.atr[i], 1e-9) && near(ab.lower[i], model.bars[i].c - 2 * model.atr[i], 1e-9);
})(), 'got ' + ab.upper[ab.upper.length - 1]);

/* ---------------------------------------------------------------- 5. Heikin Ashi */
const ha1 = I.heikinAshi([{ t: 0, o: 1, h: 2, l: 1, c: 2, v: 10 }]);
check('HA close is (O+H+L+C)/4 and the first open is the bar midpoint',
  near(ha1[0].c, 1.5) && near(ha1[0].o, 1.5), JSON.stringify(ha1[0]));
check('HA body chain: bar 2 opens at the midpoint of bar 1', (() => {
  const h = I.heikinAshi([{ t: 0, o: 1, h: 3, l: 1, c: 2, v: 1 }, { t: 1, o: 2, h: 4, l: 2, c: 3, v: 1 }]);
  return near(h[1].o, (h[0].o + h[0].c) / 2);
})());
check('HA range contains the raw range (never hides a wick)', model.bars.every((b, i) => {
  const h = I.heikinAshi(model.bars)[i];
  return h.h >= b.h - 1e-9 && h.l <= b.l + 1e-9;
}));

/* ---------------------------------------------------------------- 6. Fibonacci */
const fu = I.fib(50, 100, 100, 50);
check('up leg: 0% is the swing high and 100% the swing low',
  near(fu[0].price, 100) && near(fu[6].price, 50));
check('up leg: 61.8% retracement sits at 69.1', near(fu[4].price, 69.1, 1e-6), fu[4].price);
const fd = I.fib(100, 50, 100, 50);
check('down leg: 0% is the swing low and the ratios run upward',
  near(fd[0].price, 50) && near(fd[4].price, 80.9, 1e-6), fd[4].price);
check('the 38.2/50/61.8 trio is flagged as the working levels',
  fu.filter(l => l.key).map(l => l.label).join(',') === '38.2%,50.0%,61.8%', fu.map(l => l.label + ':' + l.key).join(' '));

/* ---------------------------------------------------------------- 7. Stochastic */
const st = I.stoch(model.bars, 14, 3);
check('%K stays inside 0..100', st.k.every(v => !isFinite(v) || (v >= 0 && v <= 100)));
check('%K pins 100 on a bar that closes at the window high', (() => {
  const bars = []; for (let i = 0; i < 20; i++) bars.push({ t: i, o: i, h: i + 1, l: i, c: i + 1, v: 1 });
  return near(I.stoch(bars, 14, 3).k[19], 100);
})());
check('%D is the 3-bar mean of %K once both exist', (() => {
  const i = st.lastIdx || 0;
  const k = st.k, d = st.d;
  for (let j = 20; j < k.length; j++) if (isFinite(d[j]) && !near(d[j], (k[j] + k[j - 1] + k[j - 2]) / 3, 1e-9)) return false;
  return true;
})());

/* ---------------------------------------------------------------- 8. studies() wiring */
const sel = ['sma20', 'rsi', 'macd', 'not-a-study'];
const list = I.studies(model, sel);
check('studies() resolves the selection and drops unknown ids', list.length === 3 && list.map(s => s.id).join(',') === 'sma20,rsi,macd', list.map(s => s.id).join(','));
check('every study series is bar-aligned', list.every(s => !s.line || s.line.length === model.bars.length));
check('kind drives placement: RSI and MACD are panes, SMA is an overlay',
  list[0].kind === 'overlay' && list[1].kind === 'pane' && list[2].kind === 'pane');
check('RSI pane declares its fixed 0-100 scale and the 30/70 guides',
  list[1].scale[0] === 0 && list[1].scale[1] === 100 && list[1].bands.join(',') === '30,70');
check('MACD pane asks for a zero rail', list[2].zero === true && isFinite(I.lastVal(list[2].hist)));
check('a Bollinger selection carries both edges', (() => {
  const b = I.studies(model, ['bb'])[0];
  return b.band && b.upper && b.lower && isFinite(I.lastVal(b.upper)) && I.lastVal(b.upper) > I.lastVal(b.line || b.upper);
})());

/* ---------------------------------------------------------------- 9. technical rating */
const rt = I.rating(model);
check('rating gathers the oscillator group', rt && rt.count >= 4, rt && rt.count);
check('rating label is one of the three TV verdicts', ['Buy', 'Sell', 'Neutral'].indexOf(rt.label) >= 0, rt.label);
check('bull + bear votes equal the vote count', rt.bull + rt.bear === rt.count);
check('a tape under 30 bars gives no rating instead of a fake one',
  I.rating(SD.Analysis.run(SD.Data.demoSeries('TINY', 20, '1d'), CFG)) === null);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
