/* Structure Desk — studies library.
   TradingView's chart is useful because a price series can be read against the standard toolkit:
   moving averages, a channel, an oscillator below it. None of that is a second opinion on the
   structure — the HH/HL labeller and the volume gate still decide the trade — so every study here
   is deliberately *descriptive*. Pure functions, no dependencies, aligned index-for-index with the
   tape so a renderer can never draw a study one bar out of step.

   Convention: an undefined value is NaN, never 0 and never a truncated array. Warm-up bars exist
   and are shown as gaps, which is what a real terminal does. */
SD.Ind = (function () {
  'use strict';

  const NaNs = n => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = NaN; return a; };

  function sma(vals, len) {
    const out = NaNs(vals.length);
    if (!(len > 0)) return out;
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i];
      if (i >= len) sum -= vals[i - len];
      if (i >= len - 1) out[i] = sum / len;
    }
    return out;
  }

  /* Seed with the SMA of the first `len` values, then the standard multiplier. Seeding matters:
     an EMA started from the first price drifts for dozens of bars and disagrees with every
     terminal on the same window. */
  function ema(vals, len) {
    const out = NaNs(vals.length);
    if (!(len > 0) || vals.length < len) return out;
    let seed = 0;
    for (let i = 0; i < len; i++) seed += vals[i];
    out[len - 1] = seed / len;
    const k = 2 / (len + 1);
    for (let i = len; i < vals.length; i++) out[i] = vals[i] * k + out[i - 1] * (1 - k);
    return out;
  }

  /* Wilder's RSI: simple mean of the first `len` changes, then recursive smoothing. */
  function rsi(closes, len) {
    const L = len || 14;
    const out = NaNs(closes.length);
    if (closes.length <= L) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= L; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) gain += d; else loss -= d;
    }
    let ag = gain / L, al = loss / L;
    out[L] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    for (let i = L + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (L - 1) + (d > 0 ? d : 0)) / L;
      al = (al * (L - 1) + (d < 0 ? -d : 0)) / L;
      out[i] = al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al);
    }
    return out;
  }

  /* MACD over the values it is actually defined on — the signal line must not average the NaN
     warm-up away or the histogram starts 26 bars early. */
  function macd(closes, fast, slow, sig) {
    const f = fast || 12, s = slow || 26, g = sig || 9;
    const ef = ema(closes, f), es = ema(closes, s);
    const line = NaNs(closes.length);
    for (let i = 0; i < closes.length; i++) line[i] = isFinite(ef[i]) && isFinite(es[i]) ? ef[i] - es[i] : NaN;
    const first = line.findIndex(v => isFinite(v));
    const signal = NaNs(closes.length), hist = NaNs(closes.length);
    if (first >= 0) {
      const tail = line.slice(first);
      const st = ema(tail, g);
      for (let i = 0; i < tail.length; i++) signal[first + i] = st[i];
      for (let i = 0; i < closes.length; i++) if (isFinite(line[i]) && isFinite(signal[i])) hist[i] = line[i] - signal[i];
    }
    return { line, signal, hist };
  }

  /* Bollinger: population deviation over the window (that is the convention the bands are quoted
     against), mid is the same SMA, so a chart can show mid == band centre and be checked by eye. */
  function bbands(closes, len, mult) {
    const L = len || 20, M = mult === undefined ? 2 : mult;
    const mid = sma(closes, L);
    const upper = NaNs(closes.length), lower = NaNs(closes.length);
    for (let i = L - 1; i < closes.length; i++) {
      let s = 0;
      for (let j = i - L + 1; j <= i; j++) { const d = closes[j] - mid[i]; s += d * d; }
      const sd = Math.sqrt(s / L);
      upper[i] = mid[i] + M * sd;
      lower[i] = mid[i] - M * sd;
    }
    return { mid, upper, lower, sd: upper.map((u, i) => isFinite(u) ? (u - mid[i]) / M : NaN) };
  }

  /* ATR channel: the desk already carries Wilder ATR per bar, so the band is honest about which
     dispersion it is quoting and never re-derives a second one. */
  function atrBand(closes, atr, mult) {
    const M = mult === undefined ? 2 : mult;
    const upper = NaNs(closes.length), lower = NaNs(closes.length);
    for (let i = 0; i < closes.length; i++) {
      if (!isFinite(atr[i])) continue;
      upper[i] = closes[i] + M * atr[i];
      lower[i] = closes[i] - M * atr[i];
    }
    return { mid: closes.slice(), upper, lower };
  }

  /* Heikin Ashi is a display transform: the same tape, averaged bodies. Structure annotations
     stay on the raw bars — the labeller's claims are about the prices that actually traded. */
  function heikinAshi(bars) {
    const out = [];
    let po = 0, pc = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const c = (b.o + b.h + b.l + b.c) / 4;
      const o = i === 0 ? (b.o + b.c) / 2 : (po + pc) / 2;
      out.push({ t: b.t, o, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c), c, v: b.v, closed: b.closed });
      po = o; pc = c;
    }
    return out;
  }

  /* Fibonacci retracement measured across the leg the structure is currently in: up legs retrace
     downward from the swing high, down legs bounce upward from the swing low. */
  const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  function fib(from, to, hi, lo) {
    const up = to >= from;
    const span = up ? hi - lo : hi - lo;
    return FIB_RATIOS.map(r => ({
      r,
      price: up ? hi - span * r : lo + span * r,
      label: (r * 100).toFixed(r === 0 || r === 1 ? 0 : 1) + '%',
      key: r === 0.382 || r === 0.5 || r === 0.618
    }));
  }

  /* Stochastic %K/%D and CCI round out the oscillator shelf without pretending to be new
     information — both are read off the same high/low/close the engine already uses. */
  function stoch(bars, kLen, dLen) {
    const K = kLen || 14, D = dLen || 3;
    const k = NaNs(bars.length);
    for (let i = K - 1; i < bars.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - K + 1; j <= i; j++) { if (bars[j].h > hh) hh = bars[j].h; if (bars[j].l < ll) ll = bars[j].l; }
      k[i] = hh > ll ? 100 * (bars[i].c - ll) / (hh - ll) : 50;
    }
    const first = k.findIndex(v => isFinite(v));
    const d = NaNs(bars.length);
    if (first >= 0) { const t = sma(k.slice(first), D); for (let i = 0; i < t.length; i++) d[first + i] = t[i]; }
    return { k, d };
  }

  /* The leg a retracement is measured across: the two most recent *confirmed* opposite swings.
     Wick-only pivots are excluded because the engine itself refuses to trade on them, and a
     forming swing would move the levels under the user's cursor. Returns null rather than a
     retracement of the whole window, which is how a flat or one-sided tape should read. */
  function fibLeg(model) {
    if (!model || !model.swings) return null;
    const sw = model.swings.filter(s => s.closeBacked && !s.forming && isFinite(s.price));
    if (sw.length < 2) return null;
    const a = sw[sw.length - 1];
    let b = null;
    for (let i = sw.length - 2; i >= 0; i--) if (sw[i].side !== a.side) { b = sw[i]; break; }
    if (!b) return null;
    const hi = Math.max(a.price, b.price), lo = Math.min(a.price, b.price);
    if (!(hi > lo)) return null;
    const up = a.price > b.price;
    return {
      dir: up ? 'up' : 'down', from: b.price, to: a.price, hi, lo, span: hi - lo,
      fromI: b.i, toI: a.i, start: Math.min(a.i, b.i), end: Math.max(a.i, b.i),
      pct: b.price > 0 ? 100 * (a.price - b.price) / b.price : NaN,
      levels: fib(b.price, a.price, hi, lo)
    };
  }

  /* ------------------------------------------------------------------ catalogue
     A study is declared once. The renderer and the legend both read this, so a chip the user
     switches on can never disagree with the line that gets drawn. */
  const LIBRARY = [
    { id: 'sma20', label: 'SMA 20', kind: 'overlay', color: '#4ba3d8', build: c => ({ line: sma(c, 20) }) },
    { id: 'sma50', label: 'SMA 50', kind: 'overlay', color: '#f2b53c', build: c => ({ line: sma(c, 50) }) },
    { id: 'ema9', label: 'EMA 9', kind: 'overlay', color: '#9d7fd8', build: c => ({ line: ema(c, 9) }) },
    { id: 'ema200', label: 'EMA 200', kind: 'overlay', color: '#e34f5c', build: c => ({ line: ema(c, 200) }) },
    { id: 'bb', label: 'Bollinger 20,2', kind: 'overlay', color: '#8c9cb0', band: true, build: c => bbands(c, 20, 2) },
    { id: 'atrb', label: 'ATR band 2×', kind: 'overlay', color: '#5f7085', band: true, build: (c, m) => atrBand(c, m.atr, 2) },
    { id: 'rsi', label: 'RSI 14', kind: 'pane', color: '#4ba3d8', scale: [0, 100], bands: [30, 70], build: (c, m) => ({ line: rsi(c, 14) }) },
    { id: 'macd', label: 'MACD 12,26,9', kind: 'pane', color: '#4ba3d8', zero: true,
      build: c => { const x = macd(c, 12, 26, 9); return { line: x.line, line2: x.signal, hist: x.hist, color2: '#f2b53c' }; } },
    { id: 'stoch', label: 'Stoch 14,3', kind: 'pane', color: '#4ba3d8', scale: [0, 100], bands: [20, 80],
      build: (c, m) => { const s = stoch(m.bars, 14, 3); return { line: s.k, line2: s.d, color2: '#f2b53c' }; } }
  ];

  function byId(id) { return LIBRARY.filter(s => s.id === id)[0] || null; }

  /* Resolve the active selection into drawable series. Unknown ids are dropped rather than
     defaulted, so a stale saved selection cannot invent a line. */
  function studies(model, selected) {
    if (!model) return [];
    const closes = model.bars.map(b => b.c);
    const out = [];
    (selected || []).forEach(id => {
      const spec = byId(id);
      if (!spec) return;
      const d = spec.build(closes, model) || {};
      out.push({
        id: spec.id, label: spec.label, kind: spec.kind, color: spec.color,
        band: !!spec.band, zero: !!spec.zero, scale: spec.scale || null,
        bands: spec.bands || [], line: d.line || d.mid || null, line2: d.line2 || null,
        upper: d.upper || null, lower: d.lower || null, hist: d.hist || null,
        color2: d.color2 || spec.color, bars: model.bars.length
      });
    });
    return out;
  }

  /* The one-number summary each study is quoted as, for the legend and the scan table. */
  function lastVal(arr) {
    if (!arr) return NaN;
    for (let i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return arr[i];
    return NaN;
  }

  function slopeOf(arr, over) {
    const w = over || 5;
    const a = lastIdx(arr);
    if (a < w) return NaN;
    return arr[a] - arr[a - w];
  }
  function lastIdx(arr) {
    if (!arr) return -1;
    for (let i = arr.length - 1; i >= 0; i--) if (isFinite(arr[i])) return i;
    return -1;
  }

  /* TV's "Technical Rating" gauge is the arithmetic mean of its oscillator group. Same idea, but
     the inputs are named so the desk can say which vote moved it. */
  function rating(model) {
    if (!model || model.bars.length < 30) return null;
    const c = model.bars.map(b => b.c);
    const votes = [];
    const r = lastVal(rsi(c, 14));
    if (isFinite(r)) votes.push({ k: 'RSI 14', v: r, bull: r > 50, txt: r.toFixed(1) });
    const m = macd(c, 12, 26, 9);
    const h = lastVal(m.hist);
    if (isFinite(h)) votes.push({ k: 'MACD hist', v: h, bull: h > 0, txt: h.toFixed(2) });
    const s20 = lastVal(sma(c, 20)), s50 = lastVal(sma(c, 50)), last = c[c.length - 1];
    if (isFinite(s20)) votes.push({ k: 'vs SMA 20', v: s20, bull: last > s20, txt: SD.U.fmtPrice(s20) });
    if (isFinite(s50)) votes.push({ k: 'vs SMA 50', v: s50, bull: last > s50, txt: SD.U.fmtPrice(s50) });
    const st = stoch(model.bars, 14, 3), sk = lastVal(st.k);
    if (isFinite(sk)) votes.push({ k: 'Stoch %K', v: sk, bull: sk > 50, txt: sk.toFixed(1) });
    const bullCount = votes.filter(v => v.bull).length;
    return { votes, bull: bullCount, bear: votes.length - bullCount, count: votes.length,
      label: bullCount / Math.max(1, votes.length) >= 0.67 ? 'Buy' : bullCount / Math.max(1, votes.length) <= 0.33 ? 'Sell' : 'Neutral' };
  }

  return {
    sma, ema, rsi, macd, bbands, atrBand, heikinAshi, fib, fibLeg, stoch, studies, byId, lastVal, lastIdx, slopeOf, rating,
    LIBRARY, FIB_RATIOS
  };
})();
