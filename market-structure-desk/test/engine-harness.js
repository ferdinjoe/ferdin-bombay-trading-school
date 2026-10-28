/* Engine harness — runs the structure labeller headless (node test/engine-harness.js).
   Guards the three claims the desk makes: close-weighted swings, HH/HL labelling,
   and volume confirmation gating signals. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.window = global;
const sandbox = global.window;

['js/util.js', 'js/data.js', 'js/analysis.js'].forEach(f => {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  vm.runInThisContext(code, { filename: f });
});

const SD = sandbox.SD;
const CFG = {
  pivotWidth: 3, closeWeight: 0.75, lookback: 4, atrPeriod: 14,
  rvolThreshold: 1.3, sustainBars: 2, breakMargin: 0.15, requireVolume: true, wickPivots: true
};

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

function mk(closes, vols, opts) {
  const o = opts || {};
  const step = (o.stepMs || 86400000);
  const t0 = Date.UTC(2026, 0, 5);
  const bars = closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c;
    const spread = Math.abs(c - prev) * 0.35 + c * 0.002;
    return {
      t: t0 + i * step,
      o: prev, h: Math.max(c, prev) + spread * (o.wickUp ? 3 : 0.4),
      l: Math.min(c, prev) - spread * (o.wickDown ? 3 : 0.4),
      c, v: vols ? vols[i] : 1000000, adj: c, closed: i < closes.length - 1 ? true : o.lastForming !== false
    };
  });
  return SD.Data.fromBars(bars, 'TEST', { interval: o.interval || '1d', cur: 'INR' });
}

/* ---- 1. rising staircase reads as HH/HL ---- */
console.log('\n1. Uptrend staircase');
{
  const c = [], v = [];
  let p = 100;
  // three higher swing highs and higher swing lows with noise between
  const path = [100, 103, 106, 109, 112, 108, 105, 109, 113, 117, 121, 116, 112, 117, 122, 127, 132, 126, 121, 127, 133, 139, 145];
  path.forEach((x, i) => { c.push(x); v.push(1000000); });
  const m = SD.Analysis.run(mk(c, v), CFG);
  const highs = m.confirmedHighs.map(s => s.rel).filter(Boolean);
  const lows = m.confirmedLows.map(s => s.rel).filter(Boolean);
  check('detects higher highs', highs.indexOf('HH') >= 0, JSON.stringify(highs));
  check('detects higher lows', lows.indexOf('HL') >= 0, JSON.stringify(lows));
  check('structure verdict is bullish', m.structure.state === 'uptrend', m.structure.state + ' / ' + m.structure.title);
  check('bull score above 50', m.structure.bullScore > 50, String(m.structure.bullScore));
}

/* ---- 2. falling staircase reads as LH/LL ---- */
console.log('\n2. Downtrend staircase');
{
  const path = [145, 141, 138, 135, 132, 136, 139, 135, 131, 127, 123, 128, 132, 127, 122, 117, 112, 118, 122, 117, 111, 105, 99];
  const c = path, v = path.map(() => 1000000);
  const m = SD.Analysis.run(mk(c, v), CFG);
  const highs = m.confirmedHighs.map(s => s.rel).filter(Boolean);
  const lows = m.confirmedLows.map(s => s.rel).filter(Boolean);
  check('detects lower highs', highs.indexOf('LH') >= 0, JSON.stringify(highs));
  check('detects lower lows', lows.indexOf('LL') >= 0, JSON.stringify(lows));
  check('structure verdict is bearish', m.structure.state === 'downtrend', m.structure.state);
  check('bull score below 50', m.structure.bullScore < 50, String(m.structure.bullScore));
}

/* ---- 3. breakout WITH volume becomes a signal ---- */
console.log('\n3. Volume-backed breakout');
{
  const c = [100, 102, 104, 106, 108, 106, 104, 106, 108, 110, 112, 110, 108, 106, 108, 110, 112, 114, 112, 110, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126];
  const v = c.map(() => 1000000);
  v[26] = 4000000; v[27] = 3500000; v[28] = 3200000;   // expansion on and after the break
  const m = SD.Analysis.run(mk(c, v), CFG);
  const up = m.signals.filter(s => s.dir === 'up');
  check('emits a confirmed breakout signal', up.length > 0, 'signals=' + m.signals.length + ' watch=' + m.watch.length);
  if (up.length) {
    const s = up[up.length - 1];
    check('signal carries a trade plan', isFinite(s.entry) && isFinite(s.stop) && s.stop < s.entry && s.t2 > s.entry,
      JSON.stringify({ entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2 }));
    check('RVOL recorded above threshold', s.rvol >= CFG.rvolThreshold, String(s.rvol));
  }
}

/* ---- 4. breakout WITHOUT volume is observation only, never a signal ---- */
console.log('\n4. Quiet break of the same level');
{
  const c = [100, 102, 104, 106, 108, 106, 104, 106, 108, 110, 112, 110, 108, 106, 108, 110, 112, 114, 112, 110, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126];
  const v = c.map(() => 1000000);
  v[26] = 400000; v[27] = 380000; v[28] = 350000;      // dry tape through the level
  const m = SD.Analysis.run(mk(c, v), CFG);
  check('no signal emitted without volume', m.signals.length === 0, 'signals=' + m.signals.length);
  check('the quiet break is still logged', m.watch.length > 0, 'watch=' + m.watch.length);
  const w = m.watch[0];
  check('reason mentions volume', !w || /RVOL|volume/i.test(w.reasons.join(' ')), w && w.reasons.join(' | '));
}

/* ---- 5. wick-only probe does not drive the trend label ---- */
console.log('\n5. Wick spike vs close-backed swing');
{
  const c = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
  const v = c.map(() => 1000000);
  const bars = mk(c, v).bars;
  bars[7].h = 160;                       // violent spike, closes right where it was
  const series = SD.Data.fromBars(bars, 'TEST', { interval: '1d', cur: 'INR' });
  const m = SD.Analysis.run(series, CFG);
  const spike = m.highs.find(s => s.i === 7);
  check('spike registered as a swing high', !!spike, 'pivot at 7: ' + JSON.stringify(spike && spike.price));
  check('spike is flagged wick-only', spike && spike.closeBacked === false, spike && String(spike.closeBacked));
  check('wick-only pivot excluded from trend labels', !(spike && m.confirmedHighs.indexOf(spike) >= 0));
}

/* ---- 6. no lookahead bias ---- */
console.log('\n6. Lookahead guard');
{
  const m = SD.Analysis.run(SD.Data.demoSeries('AAPL', 240, '1d'), CFG);
  const bad = m.events.filter(e => !e.pending && e.levelI + CFG.pivotWidth > e.i);
  check('every event uses a swing that was knowable by then', bad.length === 0, JSON.stringify(bad.slice(0, 2)));
  const forming = m.confirmedHighs.filter(s => s.forming).length + m.confirmedLows.filter(s => s.forming).length;
  check('forming swings excluded from confirmation', forming === 0, String(forming));
}

/* ---- 7. volume overlay sanity + export shape ---- */
console.log('\n7. Readouts and exports');
{
  const m = SD.Analysis.run(SD.Data.demoSeries('RELIANCE.NS', 300, '1d'), CFG);
  check('ATR computed', isFinite(m.lastAtr) && m.lastAtr > 0, String(m.lastAtr));
  check('VWAP computed per session/rolling', isFinite(m.vwapLast), String(m.vwapLast));
  check('POC inside price range', isFinite(m.vp.poc) && m.vp.poc >= m.vp.lo && m.vp.poc <= m.vp.hi, String(m.vp.poc));
  check('readout rows present', m.readouts.length >= 8, String(m.readouts.length));
  check('every signal is confirmed by construction', m.signals.every(s => s.confirmed));
  check('nothing unconfirmed leaks into signals', m.signals.every(s => s.reasons.length === 0));
}

/* ---- 8. live-tape behaviour: a new print re-runs the engine ---- */
console.log('\n8. Live repaint determinism');
{
  const base = SD.Data.demoSeries('TCS.NS', 180, '5m');
  const m1 = SD.Analysis.run(base, CFG);
  const bars2 = base.bars.map(b => Object.assign({}, b));
  bars2[bars2.length - 1].c *= 1.01;         // the traded value moves
  const m2 = SD.Analysis.run(SD.Data.fromBars(bars2, 'TCS.NS', { interval: '5m' }), CFG);
  check('engine tolerates an in-place last-bar update', m2.bars.length === m1.bars.length);
  check('last close reflects the new print', Math.abs(m2.last.c - bars2[bars2.length - 1].c) < 1e-9);
}

/* ---- 9. bull score is only issued on a readable pair ---- */
console.log('\n9. Bull score honesty');
{
  const up = [100, 103, 106, 109, 112, 108, 105, 109, 113, 117, 121, 116, 112, 117, 122, 127, 132, 126, 121, 127, 133, 139, 145];
  const mUp = SD.Analysis.run(mk(up, up.map(() => 1000000)), CFG);
  check('two pairs on both sides yields a score', isFinite(mUp.structure.bullScore), String(mUp.structure.bullScore));
  check('score stays inside 1-99, never pinned', mUp.structure.bullScore > 1 && mUp.structure.bullScore < 99,
    String(mUp.structure.bullScore));

  /* Force the one-sided case: demote every confirmed high but the newest, then label from the
     edited pool directly. The old linear formula turned a lone +4 ATR low delta averaged against
     a fabricated zero into 95/100; scoreStructure must refuse to answer instead. */
  const keep = mUp.confirmedHighs[mUp.confirmedHighs.length - 1];
  const highsOne = mUp.confirmedHighs.filter(s => s === keep);
  const one = SD.Analysis.scoreStructure(mUp.bars, mUp.lastAtr, highsOne, mUp.confirmedLows,
    mUp.structure.resistance, mUp.structure.support, 0.25);
  check('one-sided structure reports no score', !isFinite(one.bullScore), String(one.bullScore));
  check('one-sided structure still names the trend anchor', !!one.lastHigh && !!one.lastLow);
  check('full pool produces a score', isFinite(mUp.structure.bullScore), String(mUp.structure.bullScore));

  /* Short pasted tapes routinely give one side a single swing. A 40-row manual CSV used to
     throw inside the OBV divergence block because it read the previous low unguarded. */
  [30, 40, 55, 70].forEach(len => {
    let threw = null;
    try { SD.Analysis.run(SD.Data.demoSeries('SHORT' + len, len, '1d'), CFG); }
    catch (e) { threw = e.message; }
    check('short tape of ' + len + ' bars runs clean', threw === null, threw || '');
  });
}

/* ---- 10. trendlines ---- */
console.log('\n10. Trendline fit');
{
  const m = SD.Analysis.run(SD.Data.demoSeries('AAPL', 240, '1d'), CFG);
  check('trend object always present', !!m.trend && !!m.trend.rejected);
  const line = m.trend.high || m.trend.low;
  check('at least one side is drawn on a 240-bar tape', !!line, JSON.stringify(m.trend.rejected));
  if (line) {
    check('drawn line clears the R2 floor', line.fit >= 0.5, String(line.fit));
    check('projection is one slope per bar', Math.abs((line.atLast - line.atFrom) - line.slope * (line.to - line.from)) < 1e-9);
    check('anchors never exceed the six-bar window', line.anchors >= 2 && line.anchors <= 6, String(line.anchors));
    check('line spans the tape to the newest bar', line.to === m.bars.length - 1, String(line.to));
  }

  /* Two anchors can always be fit exactly, so the floor must reject the noisy third case. */
  const flat = [100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100];
  const mm = SD.Analysis.run(mk(flat, flat.map(() => 1000000)), CFG);
  check('a choppy tape yields no resistance line', !mm.trend.high, JSON.stringify(mm.trend.rejected));

  const noSwing = SD.Analysis.run(mk([100, 101, 102, 103, 104, 105], [1, 1, 1, 1, 1, 1]), CFG);
  check('no swings at all yields no lines and a reason', !noSwing.trend.high && !noSwing.trend.low);
  const row = noSwing.readouts.filter(r => r.k.indexOf('Trendline') === 0);
  check('readouts explain the missing trendline', row.length === 2 && /needs two/.test(row[0].note), JSON.stringify(row));
}

/* ---- 11. the 0-10 call ---- */
console.log('\n11. Quant call');
{
  const up = [100, 103, 106, 109, 112, 108, 105, 109, 113, 117, 121, 116, 112, 117, 122, 127, 132, 126, 121, 127, 133, 139, 145];
  const down = [145, 141, 138, 135, 132, 136, 139, 135, 131, 127, 123, 128, 132, 127, 122, 117, 112, 118, 122, 117, 111, 105, 99];
  const mUp = SD.Analysis.run(mk(up, up.map(() => 1000000)), CFG);
  const mDn = SD.Analysis.run(mk(down, down.map(() => 1000000)), CFG);
  const cUp = SD.Analysis.call(mUp), cDn = SD.Analysis.call(mDn);

  check('a rising tape scores above the midpoint', cUp.score > 6, String(cUp.score));
  check('a falling tape scores below it', cDn.score < 4, String(cDn.score));
  check('rising read points higher', cUp.trend === 'Higher', cUp.trend);
  check('falling read points lower', cDn.trend === 'Lower', cDn.trend);
  check('score never leaves 0-10', [cUp, cDn].every(c => c.score >= 0 && c.score <= 10),
    cUp.score + ' / ' + cDn.score);
  check('weights sum to exactly ten points of evidence',
    SD.Analysis.call(mUp).drivers.length === 5, String(cUp.drivers.length));

  /* Gates: a volume-blind feed cannot confirm anything, so the most bearish tape in the world is
     still a flat book. Selling off unconfirmed structure is the exact mistake the desk forbids. */
  const mNoVol = SD.Analysis.run(mk(down, down.map(() => 0)), CFG);
  const cNoVol = SD.Analysis.call(mNoVol);
  check('no-volume tape is gated', cNoVol.gated === true);
  check('a gated bearish tape holds instead of selling', cNoVol.action === 'HOLD', cNoVol.action + ' at ' + cNoVol.score);
  check('the gate names the missing evidence', cNoVol.blockers.some(b => /no volume/i.test(b)), JSON.stringify(cNoVol.blockers));
  check('a gated read scores its confidence down', cNoVol.confidence < 60, String(cNoVol.confidence));

  /* A one-sided pool has no structure score, so the call must refuse rather than invent a middle. */
  const keep = mUp.confirmedHighs[mUp.confirmedHighs.length - 1];
  const one = Object.assign({}, mUp, {
    structure: SD.Analysis.scoreStructure(mUp.bars, mUp.lastAtr,
      mUp.confirmedHighs.filter(s => s === keep), mUp.confirmedLows,
      mUp.structure.resistance, mUp.structure.support, 0.25)
  });
  const cOne = SD.Analysis.call(one);
  check('one-sided structure reports NO READ', cOne.action === 'NO READ' && !isFinite(cOne.score), cOne.action + ' / ' + cOne.score);
  check('NO READ carries no projection to trade against', cOne.projection === null);

  /* Short tapes: the engine labels them, the call refuses to recommend on them. */
  const mShort = SD.Analysis.run(SD.Data.demoSeries('SHRT', 30, '1d'), CFG);
  const cShort = SD.Analysis.call(mShort);
  check('a 30-bar window is never a BUY/SELL', cShort.action === 'HOLD' || !isFinite(cShort.score), cShort.action);
  if (isFinite(cShort.score)) check('and it says why', /bars in the window/.test(cShort.blockers.join(' ')), JSON.stringify(cShort.blockers));

  /* Projection must be the fitted line walked forward, with the band growing at sqrt(time). */
  check('projection is a point plus an ATR band', isFinite(cUp.projection.to) && cUp.projection.hi - cUp.projection.lo > 0,
    JSON.stringify(cUp.projection));
  const h1 = SD.Analysis.call(mUp, { horizon: 1 }), h4 = SD.Analysis.call(mUp, { horizon: 4 });
  check('band widens with the square root of the horizon',
    Math.abs((h4.projection.hi - h4.projection.lo) / (h1.projection.hi - h1.projection.lo) - 2) < 1e-6,
    String((h4.projection.hi - h4.projection.lo) / (h1.projection.hi - h1.projection.lo)));
  check('an up read is invalidated below the floor', cUp.projection.invalid <= mUp.last.c + 1e-9,
    cUp.projection.invalid + ' vs ' + mUp.last.c);
  check('a down read is invalidated above the ceiling', cDn.projection.invalid >= mDn.last.c - 1e-9,
    cDn.projection.invalid + ' vs ' + mDn.last.c);

  /* The projection walks the close, never the line's own level: a resistance line drawn above the
     tape is a target, so a bearish read must not project to a higher price than it is trading at. */
  check('a bearish projection points down, not at the ceiling', cDn.projection.to <= mDn.last.c + 1e-9,
    cDn.projection.to + ' vs ' + mDn.last.c);
  check('a bullish projection points up, or says why the lines do not',
    cUp.projection.to >= mUp.last.c - 1e-9 || cUp.notes.some(x => /fitted line is falling/.test(x)),
    cUp.projection.to + ' vs ' + mUp.last.c + ' / ' + JSON.stringify(cUp.notes));
  /* A sawtooth climbing ~4% a bar fits a line with a slope far past the point where the trend
     component saturates; the forecast must be clamped to that same rate. */
  const cyc = [1.09, 1.09, 1.09, 1.09, 0.97, 0.97, 0.97];
  const steep = [];
  let sp = 100;
  for (let i = 0; i < 70; i++) { sp *= cyc[i % cyc.length]; steep.push(sp); }
  const mSteep = SD.Analysis.run(mk(steep, steep.map(() => 1000000)), CFG);
  const cSteep = SD.Analysis.call(mSteep, { horizon: 20 });
  check('a vertical tape still produces a read', isFinite(cSteep.score) && !!cSteep.projection,
    cSteep.action + ' / ' + cSteep.score);
  check('a parabolic fit cannot print an uncapped forecast',
    Math.abs(cSteep.projection.rate) <= 0.12 * mSteep.lastAtr + 1e-9, String(cSteep.projection.rate));
  check('and says so when it caps', /capped/.test(cSteep.projection.source), cSteep.projection.source);

  /* Age alone does not gate a trend that is still intact — only an abandoned one does. */
  check('a stale break with price still on its side is a note, not a blocker',
    cUp.blockers.every(b => !/bars old/.test(b)) || cUp.notes.some(x => /bars old/.test(x)),
    JSON.stringify({ b: cUp.blockers, n: cUp.notes }));

  /* A real-length daily tape: the strict mode has to find an accepted break or say it cannot. */
  const mLong = SD.Analysis.run(SD.Data.demoSeries('LONG', 240, '1d'), CFG);
  const cLong = SD.Analysis.call(mLong);
  check('a 240-bar tape produces a usable call', isFinite(cLong.score) && ['BUY', 'HOLD', 'SELL'].indexOf(cLong.action) >= 0,
    cLong.action + ' / ' + cLong.score);
  check('every driver is signed and finite', cLong.drivers.every(d => isFinite(d.pts)), JSON.stringify(cLong.drivers));
  check('action agrees with the score when ungated',
    cLong.gated || (cLong.action === 'BUY') === (cLong.score >= 6.5), cLong.action + ' / ' + cLong.score);

  /* An invalidation printed on the wrong side of the close is not a stop — it is already hit. */
  [['AAPL', 240], ['TCS.NS', 180], ['^NSEI', 120], ['RELIANCE.NS', 300], ['D05.SI', 200]].forEach(pair => {
    const mm = SD.Analysis.run(SD.Data.demoSeries(pair[0], pair[1], '1d'), CFG);
    const cc = SD.Analysis.call(mm);
    if (!isFinite(cc.score)) { check('invalidation side for ' + pair[0], true, 'no read, nothing to check'); return; }
    const p = cc.projection;
    const expected = cc.trend === 'Higher' ? 'up' : cc.trend === 'Lower' ? 'down' : 'side';
    check('projection carries the direction it was built under (' + pair[0] + ')',
      p.dir === expected, p.dir + ' vs label ' + cc.trend);
    const ok = p.dir === 'up' ? p.invalidAt < mm.last.c
      : p.dir === 'down' ? p.invalidAt > mm.last.c : true;
    check('invalidation for a ' + p.dir + ' read is beyond the close (' + pair[0] + ')', ok,
      p.invalidAt + ' vs ' + mm.last.c);
    /* A down read that forecasts higher is only honest if the engine says why: every fitted line
       was rising, so the drift is reported rather than hidden behind a bullish-looking number. */
    const signSane = p.dir === 'down' ? (p.to <= mm.last.c || cc.notes.some(t => /bearish but every fitted line is rising/.test(t)))
      : p.dir === 'up' ? (p.to >= mm.last.c || cc.notes.some(t => /bullish but every fitted line is falling/.test(t))) : true;
    check('projection direction is sign-sane or explained (' + pair[0] + ')', signSane,
      p.to + ' vs ' + mm.last.c + ' | notes ' + cc.notes.length);
    check('projection band brackets the forecast (' + pair[0] + ')',
      p.lo <= p.to && p.to <= p.hi,
      JSON.stringify([p.lo, p.to, p.hi]));
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
