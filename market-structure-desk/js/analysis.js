/* Structure Desk — market structure engine.
   Design stance (quant book, IN + US):
   1. The close carries the information. Pivots are detected on a close-weighted price and a swing
      that only exists in the wick is never allowed to drive a trend label.
   2. A level break is a hypothesis. It becomes a signal only with volume expansion + close
      acceptance. Everything else is logged as an observation, explicitly not tradeable.
   3. Structure is a state machine over the last two confirmed highs and lows, so a single bar can't
      flip the read. */
SD.Analysis = (function () {
  'use strict';

  const R = SD.U.round;

  /* ------------------------------------------------------------------ helpers */
  function atr(bars, period, idx) {
    // Wilder ATR, cached per run. idx optional: compute only up to that bar.
    const n = bars.length;
    const out = new Array(n).fill(NaN);
    let prev = null, sum = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const tr = prev === null ? (b.h - b.l)
        : Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
      if (i < period) { sum += tr; cnt++; prev = b; out[i] = sum / Math.max(cnt, 1); continue; }
      out[i] = (out[i - 1] * (period - 1) + tr) / period;
      prev = b;
    }
    return out;
  }

  function closeQuality(b) {
    // 1 = closed on the extreme of the bar, 0 = closed at the opposite end.
    const rng = b.h - b.l;
    if (!(rng > 0)) return 0.5;
    return (b.c - b.l) / rng;
  }

  function wavg(b, cw) {
    // Close-weighted bar price: the body carries the read, the extremes are discounted.
    const typical = (b.h + b.l + b.c) / 3;
    return { high: cw * b.h + (1 - cw) * typical, low: cw * b.l + (1 - cw) * typical, close: b.c };
  }

  /* ------------------------------------------------------------- swing detection */
  function findPivots(bars, cfg, atrArr) {
    const w = cfg.pivotWidth;
    const cw = cfg.closeWeight;
    const highs = [], lows = [];
    const n = bars.length;

    const wh = new Array(n), wl = new Array(n), wc = new Array(n);
    for (let i = 0; i < n; i++) { const x = wavg(bars[i], cw); wh[i] = x.high; wl[i] = x.low; wc[i] = bars[i].c; }

    for (let i = w; i < n - w; i++) {
      let isH = true, isL = true;
      for (let k = 1; k <= w; k++) {
        if (!(wh[i] > wh[i - k] && wh[i] > wh[i + k])) isH = false;
        if (!(wl[i] < wl[i - k] && wl[i] < wl[i + k])) isL = false;
        if (!isH && !isL) break;
      }
      if (isH) highs.push(i);
      if (isL) lows.push(i);
    }

    // A swing that also prints the best *close* in its window is close-backed.
    // Anything else is a wick — a probe into liquidity, useful as a level, not as a trend leg.
    function closeBacked(i, side) {
      for (let k = -w; k <= w; k++) {
        if (k === 0) continue;
        if (side === 'high' && wc[i] < wc[i + k]) return false;
        if (side === 'low' && wc[i] > wc[i + k]) return false;
      }
      return true;
    }

    function build(idxs, side) {
      const res = [];
      for (const i of idxs) {
        const b = bars[i];
        const price = side === 'high' ? b.h : b.l;
        const wprice = side === 'high' ? wh[i] : wl[i];
        const backed = closeBacked(i, side);
        const a = atrArr[i];
        const volMed = SD.U.median(volWindow(bars, i, 20));
        const rvol = volMed > 0 ? b.v / volMed : NaN;
        // Strength: separation from neighbours, in ATR, plus participation at the swing.
        let sep = 0;
        for (let k = 1; k <= w; k++) sep += side === 'high' ? (wprice - wh[i - k]) + (wprice - wh[i + k]) : (wl[i - k] - wprice) + (wl[i + k] - wprice);
        sep /= (2 * w);
        const strength = isFinite(a) && a > 0 ? SD.U.clamp(sep / a, 0, 3) : 0;
        res.push({
          i, t: b.t, side, price, wprice, close: b.c,
          closeBacked: backed,
          quality: side === 'high' ? closeQuality(b) : 1 - closeQuality(b),
          rvol, strength,
          forming: i >= n - w           // right side of the window is still unfinished
        });
      }
      // Non-max suppression: within w bars keep the most extreme so labels don't stack.
      const kept = [];
      for (const p of res) {
        const last = kept[kept.length - 1];
        if (!last || p.i - last.i > w) { kept.push(p); continue; }
        const better = p.side === 'high' ? p.price > last.price : p.price < last.price;
        if (better) kept[kept.length - 1] = p;
      }
      return kept;
    }

    return { highs: build(highs, 'high'), lows: build(lows, 'low') };
  }

  function volWindow(bars, i, len) {
    const out = [];
    for (let k = Math.max(0, i - len); k < i; k++) out.push(bars[k].v);
    return out;
  }

  /* ------------------------------------------------------------------ labelling */
  function label(pivots, side, atrRef, tol) {
    const seq = pivots.filter(p => p.closeBacked); // trend labels use close-backed swings only
    let prev = null;
    for (const p of seq) {
      if (prev) {
        const d = p.price - prev.price;
        const near = isFinite(atrRef) && atrRef > 0 && Math.abs(d) <= tol * atrRef;
        if (near) p.rel = side === 'high' ? 'EQH' : 'EQL';
        else if (side === 'high') p.rel = d > 0 ? 'HH' : 'LH';
        else p.rel = d > 0 ? 'HL' : 'LL';
        p.delta = d;
        p.deltaAtr = isFinite(atrRef) && atrRef > 0 ? d / atrRef : NaN;
      } else {
        p.rel = side === 'high' ? 'H' : 'L';
      }
      prev = p;
    }
    return seq;
  }

  /* ------------------------------------------------------------------ volume */
  function volumeStats(bars, i, cfg) {
    const med = SD.U.median(volWindow(bars, i, 20));
    const b = bars[i];
    const prior = bars[i - 1];
    const dir = prior ? (b.c > prior.c ? 1 : b.c < prior.c ? -1 : 0) : 0;
    return { med, rvol: med > 0 ? b.v / med : NaN, dir };
  }

  function obv(bars) {
    const out = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].c - bars[i - 1].c;
      out[i] = out[i - 1] + (d > 0 ? bars[i].v : d < 0 ? -bars[i].v : 0);
    }
    return out;
  }

  function sessionVwap(bars, tz, isDaily) {
    // Intraday: VWAP anchored to each exchange-local session. Daily: 20-bar rolling anchor VWAP.
    const out = new Array(bars.length).fill(NaN);
    if (isDaily) {
      let pv = 0, vv = 0;
      const buf = [];
      for (let i = 0; i < bars.length; i++) {
        const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
        buf.push({ pv: tp * bars[i].v, v: bars[i].v });
        if (buf.length > 20) buf.shift();
        pv = 0; vv = 0;
        for (const x of buf) { pv += x.pv; vv += x.v; }
        out[i] = vv > 0 ? pv / vv : bars[i].c;
      }
      return out;
    }
    let cumPV = 0, cumV = 0, key = null;
    for (let i = 0; i < bars.length; i++) {
      const k = SD.U.dayKey(bars[i].t, tz);
      if (k !== key) { key = k; cumPV = 0; cumV = 0; }
      const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
      cumPV += tp * bars[i].v; cumV += bars[i].v;
      out[i] = cumV > 0 ? cumPV / cumV : bars[i].c;
    }
    return out;
  }

  function volumeProfile(bars, bins) {
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!isFinite(lo) || !(hi > lo)) return { poc: NaN, lo, hi, hist: [] };
    const size = (hi - lo) / bins;
    const hist = new Array(bins).fill(0);
    for (const b of bars) {
      const tp = (b.h + b.l + b.c) / 3;
      const k = SD.U.clamp(Math.floor((tp - lo) / size), 0, bins - 1);
      hist[k] += b.v;
    }
    let best = 0;
    for (let i = 1; i < bins; i++) if (hist[i] > hist[best]) best = i;
    return { poc: lo + (best + 0.5) * size, lo, hi, hist, size };
  }

  /* ------------------------------------------------------------------ trendline
     Least squares through the close-weighted swing prices of one side. Wicks are deliberately
     left out: a line drawn through spikes describes where liquidity was hunted, not the trend
     the closes actually made. The recent leg only (max 6 anchors) keeps the slope current. */
  function fitTrendline(pool, bars, lastAtr) {
    const pts = pool.slice();
    if (pts.length < 2) return null;
    const use = pts.slice(-Math.min(6, pts.length));
    const m = use.length;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const p of use) { sx += p.i; sy += p.wprice; sxy += p.i * p.wprice; sxx += p.i * p.i; }
    const den = m * sxx - sx * sx;
    if (!isFinite(den) || den === 0) return null;
    const slope = (m * sxy - sx * sy) / den;
    const intercept = (sy - slope * sx) / m;

    // R^2 over the anchors themselves: how much of the swing scatter the line explains.
    const meanY = sy / m;
    let sst = 0, sse = 0;
    for (const p of use) {
      const f = intercept + slope * p.i;
      sst += (p.wprice - meanY) * (p.wprice - meanY);
      sse += (p.wprice - f) * (p.wprice - f);
    }
    const fit = sst > 0 ? 1 - sse / sst : 1;
    const n = bars.length;
    const at = i => intercept + slope * i;
    return {
      side: use[0].side, anchors: m, from: use[0].i, lastAnchor: use[m - 1].i, to: n - 1,
      slope, slopeAtr: isFinite(lastAtr) && lastAtr > 0 ? slope / lastAtr : NaN,
      atFrom: at(use[0].i), atLast: at(n - 1), fit
    };
  }

  /* Two points always make a line, so a low-fit line is noise, not a trend. 0.5 is the level at
     which the line explains more of the scatter than the flat mean does. */
  const TREND_FIT_MIN = 0.5;

  function trendlines(confirmedHighs, confirmedLows, bars, lastAtr) {
    const hi = fitTrendline(confirmedHighs, bars, lastAtr);
    const lo = fitTrendline(confirmedLows, bars, lastAtr);
    const out = {
      high: hi && hi.fit >= TREND_FIT_MIN ? hi : null,
      low: lo && lo.fit >= TREND_FIT_MIN ? lo : null,
      rejected: { high: hi ? hi.fit : NaN, low: lo ? lo.fit : NaN }
    };
    const n = bars.length;
    if (out.low) {
      const linePrev = out.low.atLast - out.low.slope;
      out.supportHeld = bars[n - 1].c >= out.low.atLast;
      // A break only counts when the bar before it was still standing on the line.
      out.supportBroken = !out.supportHeld && n > 1 && bars[n - 2].c >= linePrev;
    }
    if (out.high) {
      const linePrev = out.high.atLast - out.high.slope;
      out.resistanceHeld = bars[n - 1].c <= out.high.atLast;
      out.resistanceBroken = !out.resistanceHeld && n > 1 && bars[n - 2].c <= linePrev;
    }
    return out;
  }

  /* ------------------------------------------------------------------ main */
  /* Structure read from the confirmed swing pairs, plus the levels that actually bind price.
     Kept separate from run() so a one-sided pool can be labelled without a live feed. */
  function scoreStructure(bars, lastAtr, confirmedHighs, confirmedLows, overhead, floor, tol) {
    const n = bars.length;
    const last = bars[n - 1];
    const h2 = confirmedHighs[confirmedHighs.length - 1];
    const h1 = confirmedHighs[confirmedHighs.length - 2];
    const l2 = confirmedLows[confirmedLows.length - 1];
    const l1 = confirmedLows[confirmedLows.length - 2];
    const oh = overhead ? overhead.price : null;
    const fl = floor ? floor.price : null;
    let structure = { state: 'insufficient', title: 'Not enough confirmed swings', tone: 'flat',
      sub: 'Widen the window or lower the pivot width; structure needs at least two close-backed swings on each side.',
      bullScore: NaN, runBars: 0, dH: NaN, dL: NaN, equalHighs: false, equalLows: false };

    if (h2 && l2) {
      const dH = isFinite(lastAtr) && lastAtr > 0 && h1 ? (h2.price - h1.price) / lastAtr : 0;
      const dL = isFinite(lastAtr) && lastAtr > 0 && l1 ? (l2.price - l1.price) / lastAtr : 0;
      const upLeg = h1 ? h2.price > h1.price + tol * lastAtr : false;
      const downLeg = h1 ? h2.price < h1.price - tol * lastAtr : false;
      const upLow = l1 ? l2.price > l1.price + tol * lastAtr : false;
      const downLow = l1 ? l2.price < l1.price - tol * lastAtr : false;
      const eqH = h1 ? Math.abs(h2.price - h1.price) <= tol * lastAtr : false;
      const eqL = l1 ? Math.abs(l2.price - l1.price) <= tol * lastAtr : false;

      let st, title, sub, tone;
      if (upLeg && upLow) { st = 'uptrend'; tone = 'bull'; title = 'Bullish structure · higher highs & higher lows';
        sub = 'Buyers are defending each pullback and paying for each push. Continuation needs acceptance above ' +
          SD.U.fmtPrice(oh === null ? h2.price : oh) + '.'; }
      else if (downLeg && downLow) { st = 'downtrend'; tone = 'bear'; title = 'Bearish structure · lower highs & lower lows';
        sub = 'Each rally is sold into a lower print. Continuation needs acceptance below ' +
          SD.U.fmtPrice(fl === null ? l2.price : fl) + '.'; }
      else if (upLeg && downLow) { st = 'expanding'; tone = 'range';
        title = 'Expanding range · higher high and lower low';
        sub = 'Both sides are taking liquidity and the range is widening. No directional edge — trade the edges or wait for contraction.'; }
      else if (downLeg && upLow) { st = 'compression'; tone = 'range';
        title = 'Contracting range · lower high and higher low';
        sub = 'Trades are overlapping inside the prior range and energy is building. Wait for the accepted break; do not pre-empt it.'; }
      else { st = 'neutral'; tone = 'range'; title = 'Mixed sequence · no clean structure';
        sub = 'The last swings do not form a readable pair on both sides. Widen the window or raise the pivot width before acting.'; }

      if (eqH) { st = 'eqh'; tone = 'range'; title = 'Equal highs under the tape'; sub = 'Twin highs at ' + SD.U.fmtPrice(h2.price) + ' pool resting stops. Expect a sweep before any true move.'; }
      if (eqL && st === 'eqh') { title = 'Equal highs and equal lows'; sub = 'A bracketed range: both extremes are liquidity, neither is information yet.'; }
      else if (eqL) { st = 'eql'; tone = 'range'; title = 'Equal lows under the tape'; sub = 'Twin lows at ' + SD.U.fmtPrice(l2.price) + ' pool resting stops. Expect a sweep before any true move.'; }

      // Run length: bars since the last confirmed swing of either type flipped the read.
      const runBars = n - 1 - Math.max(h2.i, l2.i);

      /* Score only when both sides carry a readable pair. A one-sided delta averaged against a
         fabricated zero invents conviction, and a linear ATR scale saturates on daily+ data, so
         the mean delta is pushed through a bounded tanh. */
      const both = !!(h1 && l1) && isFinite(dH) && isFinite(dL);
      const bullScore = both
        ? SD.U.clamp(Math.round(50 + 40 * Math.tanh(((dH + dL) / 2) / 4)), 1, 99)
        : NaN;

      structure = {
        state: st, title, sub, tone,
        bullScore, runBars, dH, dL, equalHighs: eqH, equalLows: eqL,
        lastHigh: h2, lastLow: l2, prevHigh: h1, prevLow: l1,
        resistance: overhead, support: floor
      };
    }

    const rangeLo = floor ? floor.price : Math.min.apply(null, bars.map(b => b.l));
    const rangeHi = overhead ? overhead.price : Math.max.apply(null, bars.map(b => b.h));
    structure.rangeLo = rangeLo;
    structure.rangeHi = rangeHi;
    structure.posInRange = rangeHi > rangeLo ? SD.U.clamp((last.c - rangeLo) / (rangeHi - rangeLo), 0, 1) : 0.5;
    structure.resistance = overhead || structure.resistance || null;
    structure.support = floor || structure.support || null;
    structure.distRes = overhead && last.c > 0 ? 100 * (overhead.price - last.c) / last.c : NaN;
    structure.distSup = floor && last.c > 0 ? 100 * (last.c - floor.price) / last.c : NaN;
    return structure;
  }

  function run(series, cfg) {
    const bars = series.bars;
    const n = bars.length;
    series.decimals = SD.U.priceDecimals(bars[n - 1].c);
    const isDaily = (series.intervalSeconds || 86400) >= 86400;
    const atrArr = atr(bars, cfg.atrPeriod);
    const { highs, lows } = findPivots(bars, cfg, atrArr);

    const lastAtr = atrArr[n - 1];
    const tol = 0.25;
    label(highs, 'high', lastAtr, tol);
    label(lows, 'low', lastAtr, tol);

    const swings = highs.concat(lows).sort((a, b) => a.i - b.i);
    const confirmedHighs = highs.filter(p => p.closeBacked && !p.forming);
    const confirmedLows = lows.filter(p => p.closeBacked && !p.forming);
    const last = bars[n - 1];

    // Nearest unbroken swing on each side of the last close — the levels that actually bind.
    const overhead = confirmedHighs.filter(p => p.price > last.c).sort((a, b) => a.price - b.price)[0] || null;
    const floor = confirmedLows.filter(p => p.price < last.c).sort((a, b) => b.price - a.price)[0] || null;

    const structure = scoreStructure(bars, lastAtr, confirmedHighs, confirmedLows, overhead, floor, tol);
    const rangeLo = structure.rangeLo, rangeHi = structure.rangeHi, posInRange = structure.posInRange;
    const trend = trendlines(confirmedHighs, confirmedLows, bars, lastAtr);

    /* ---- volume overlays ---- */
    const obvArr = obv(bars);
    const vwapArr = sessionVwap(bars, series.timezone, isDaily);
    const vp = volumeProfile(bars.slice(Math.max(0, n - 160)), 44);
    const vs = volumeStats(bars, n - 1, cfg);
    const upVolShare = (() => {
      const look = Math.min(cfg.lookback * 12, n - 1, 60);
      let up = 0, tot = 0;
      for (let i = n - look; i < n; i++) {
        if (i < 1) continue;
        tot += bars[i].v;
        if (bars[i].c > bars[i - 1].c) up += bars[i].v;
      }
      return tot > 0 ? up / tot : NaN;
    })();
    const obvSlope = (() => {
      const m = Math.min(20, n - 1);
      if (m < 4) return NaN;
      const a = obvArr[n - m], b2 = obvArr[n - 1];
      const av = SD.U.median(volWindow(bars, n - 1, m)) || 1;
      return (b2 - a) / (av * m);
    })();

    /* ---- OBV vs price divergence on the confirmed swings ---- */
    let divergence = null;
    const h2 = structure.lastHigh, h1 = structure.prevHigh, l2 = structure.lastLow, l1 = structure.prevLow;
    if (h2 && h1 && l2) {
      const o2 = obvArr[h2.i], o1 = obvArr[h1.i];
      const priceUp = h2.price > h1.price;
      const obvDown = o2 < o1 * 0.999;
      if (priceUp && obvDown) divergence = { kind: 'bearish', txt: 'Price made a higher high but OBV made a lower high — participation did not expand with the move.' };
      const l2v = obvArr[l2.i], l1v = l1 ? obvArr[l1.i] : NaN;
      if (l1 && l2.price > l1.price && l2v > l1v * 1.001 && priceUp) divergence = null;
      const priceDown = h1 && h2.price < h1.price;
      if (priceDown && obvArr[h2.i] > obvArr[h1.i]) divergence = { kind: 'bullish', txt: 'Price made a lower high while OBV improved — distribution is not confirming the fade.' };
    }

    /* ---- events: breakouts / breakdowns / failures ---- */
    const events = detectBreaks(bars, swings, atrArr, cfg, series);

    /* ---- signals: only confirmed events, with a plan ---- */
    const signals = [];
    const watch = [];
    for (const ev of events) {
      if (ev.confirmed) { signals.push(buildPlan(ev, swings, bars, atrArr, cfg)); }
      else watch.push(ev);
    }
    signals.sort((a, b) => b.i - a.i);
    watch.sort((a, b) => b.i - a.i);

    /* ---- quality notes ---- */
    const quality = [];
    const zeroVol = bars.filter(b => b.v === 0).length;
    if (zeroVol > n * 0.2) quality.push({ lvl: 'warn', txt: (100 * zeroVol / n).toFixed(0) + '% of bars carry no volume. Volume confirmation is unavailable on this feed — treat all breaks as unconfirmed.' });
    if (cfg.requireVolume && zeroVol > n * 0.2) quality.push({ lvl: 'warn', txt: 'Strict mode is on, so nothing here is flagged tradeable. Load a volume-bearing feed or paste OHLCV.' });
    const gaps = (() => { let g = 0; const step = series.intervalSeconds * 1000; for (let i = 1; i < n; i++) if (bars[i].t - bars[i - 1].t > step * 4) g++; return g; })();
    if (gaps) quality.push({ lvl: 'info', txt: gaps + ' session gap(s) inside the window. Weekly/monthly buckets are calendar-based, so swing spacing is uneven.' });
    if (!last.closed) quality.push({ lvl: 'info', txt: 'Last bar is still forming and is excluded from pivot confirmation — its close is not yet a fact.' });
    if (confirmedHighs.length < 2 || confirmedLows.length < 2) quality.push({ lvl: 'warn', txt: 'Fewer than two close-backed swings on one side. Structure read is weak; widen the window.' });
    const stale = series.via !== 'manual' && series.regularMarketTime ? (Date.now() - series.regularMarketTime) / 3600000 : null;
    if (stale !== null && stale > 6) quality.push({ lvl: 'info', txt: 'Quote is ' + R(stale, 1) + 'h old — venue is outside its session. Levels are valid, freshness is not.' });

    return {
      series, bars, cfg, swings, highs, lows, confirmedHighs, confirmedLows,
      atr: atrArr, lastAtr, obv: obvArr, vwap: vwapArr, vwapLast: vwapArr[n - 1],
      vp, volume: { rvol: vs.rvol, med20: vs.med, upVolShare, obvSlope },
      structure, trend, posInRange, rangeLo, rangeHi, events, signals, watch, quality, divergence,
      last, dec: SD.U.priceDecimals(last.c),
      readouts: buildReadouts(bars, structure, cfg, vs, vp, series, lastAtr, posInRange, vwapArr[n - 1], upVolShare, obvSlope, trend)
    };
  }

  /* ------------------------------------------------------------------ breaks
     No lookahead: a swing at bar p is only usable from bar p+width onward, because its
     right-hand window has to finish before the market tells you it was a swing. */
  function detectBreaks(bars, swings, atrArr, cfg, series) {
    const events = [];
    const n = bars.length;
    const w = cfg.pivotWidth;

    const rvolAt = i => {
      const med = SD.U.median(volWindow(bars, i, 20));
      return med > 0 ? bars[i].v / med : NaN;
    };

    for (const side of ['high', 'low']) {
      const pool = swings.filter(s => s.side === side && (s.closeBacked || cfg.wickPivots)).sort((a, b) => a.i - b.i);
      let ptr = 0;
      let level = null;
      let ep = null;                 // one observation per level visit
      let confirmedLevel = null;     // for causal failure detection

      const above = (b, lv, m) => side === 'high' ? b.c > lv.price + m : b.c < lv.price - m;
      const holds = (b, lv) => side === 'high' ? b.c > lv.price : b.c < lv.price;

      for (let i = 0; i < n; i++) {
        while (ptr < pool.length && pool[ptr].i + w <= i) {
          level = pool[ptr]; ep = null; confirmedLevel = null; ptr++;
        }
        if (!level || i <= level.i + w) continue;

        const b = bars[i];
        const at = isFinite(atrArr[i]) ? atrArr[i] : level.price * 0.002;
        const unit = at > 0 ? at : level.price * 0.002;
        const margin = (cfg.breakMargin || 0) * unit;

        // A close back through a level we already accepted is the trap print, not a new signal.
        if (confirmedLevel && holdsAgainst(b, side, confirmedLevel.price)) {
          events.push({
            i, t: b.t, side, dir: 'fail', level: confirmedLevel.price, levelI: confirmedLevel.levelI,
            price: b.c, atr: at, rvol: rvolAt(i), sustain: 0, acceptance: false, confirmed: false,
            failed: true, brokenFrom: confirmedLevel.i, wickOnly: !!confirmedLevel.wickOnly,
            reasons: ['price reclaimed the level — the accepted break was a trap']
          });
          confirmedLevel = null;
          level = null; ep = null;
          continue;
        }

        if (!above(b, level, margin)) { ep = null; continue; }   // pullback: allow a fresh observation

        const cq = closeQuality(b);
        const acceptance = side === 'high' ? cq >= 0.58 : cq <= 0.42;
        const rvol = rvolAt(i);
        const volOk = isFinite(rvol) && rvol >= cfg.rvolThreshold;

        // Causal sustain: the acceptance run must already be in the tape behind this bar.
        let held = 1;
        for (let k = 1; k < cfg.sustainBars; k++) {
          const j = i - k;
          if (j <= level.i + w) break;
          if (!holds(bars[j], level)) break;
          const rv = rvolAt(j);
          if (isFinite(rv) && rv >= cfg.rvolThreshold * 0.75) held++;
        }
        const sustainOk = held >= cfg.sustainBars;

        const confirmed = volOk && acceptance && sustainOk;
        if (confirmed && ep && ep.confirmed) continue;
        if (!confirmed && ep && ep.observed) continue;

        const reasons = [];
        if (!volOk) reasons.push(isFinite(rvol) ? 'RVOL ' + U2(rvol) + '× vs ' + U2(cfg.rvolThreshold) + '× required' : 'volume unavailable on this feed');
        if (!acceptance) reasons.push('closed in the ' + (side === 'high' ? 'lower' : 'upper') + ' half of the bar — a wick probe, not acceptance');
        if (!sustainOk) reasons.push('acceptance run ' + held + ' of ' + cfg.sustainBars + ' bars');

        events.push({
          i, t: b.t, side, dir: side === 'high' ? 'up' : 'down',
          level: level.price, levelI: level.i, levelCloseBacked: !!level.closeBacked,
          price: b.c, atr: at, rvol, sustain: held, acceptance, confirmed, reasons,
          wickOnly: !level.closeBacked, dist: Math.abs(b.c - level.price) / unit
        });
        ep = { observed: true, confirmed };
        if (confirmed) confirmedLevel = { price: level.price, levelI: level.i, i, wickOnly: !level.closeBacked };
      }

      if (level && !confirmedLevel) {
        const b = bars[n - 1];
        const dist = side === 'high' ? (level.price - b.c) / b.c : (b.c - level.price) / b.c;
        if (dist >= 0 && dist <= 0.03) {
          events.push({
            i: n - 1, t: b.t, side, dir: 'test', level: level.price, levelI: level.i,
            price: b.c, atr: isFinite(atrArr[n - 1]) ? atrArr[n - 1] : b.c * 0.005,
            rvol: rvolAt(n - 1), sustain: 0, acceptance: false, confirmed: false, pending: true, dist,
            levelCloseBacked: !!level.closeBacked, wickOnly: !level.closeBacked,
            reasons: ['pressing the level with no close through it yet']
          });
        }
      }
    }
    events.sort((a, b) => a.i - b.i);
    return events;
  }

  function holdsAgainst(b, side, price) {
    return side === 'high' ? b.c < price : b.c > price;
  }
  function U2(v) { return SD.U.round(v, 2); }

  /* ------------------------------------------------------------------ plan */
  function buildPlan(ev, swings, bars, atrArr, cfg) {
    const i = ev.i;
    const at = atrArr[i];
    const entry = ev.price;
    let stop = null, stopSrc = '';
    if (ev.side === 'high') {
      const lows = swings.filter(s => s.side === 'low' && s.closeBacked && s.i <= i && s.price < entry).sort((a, b) => b.price - a.price);
      if (lows.length) { stop = lows[0].price; stopSrc = 'swing low ' + SD.U.fmtBarTime(lows[0].t, '', null); }
    } else {
      const highs = swings.filter(s => s.side === 'high' && s.closeBacked && s.i <= i && s.price > entry).sort((a, b) => a.price - b.price);
      if (highs.length) { stop = highs[0].price; stopSrc = 'swing high ' + SD.U.fmtBarTime(highs[0].t, '', null); }
    }
    // A structural stop hugging the entry is noise, not risk: widen to 1.5× ATR.
    if (stop === null || Math.abs(entry - stop) < 0.6 * at) {
      stop = ev.side === 'high' ? entry - 1.5 * at : entry + 1.5 * at;
      stopSrc = '1.5× ATR fallback';
    }
    const risk = Math.abs(entry - stop);
    const priorLeg = Math.abs(ev.level - (ev.side === 'high'
      ? Math.min.apply(null, bars.slice(Math.max(0, ev.levelI - 40), ev.levelI + 1).map(b => b.l))
      : Math.max.apply(null, bars.slice(Math.max(0, ev.levelI - 40), ev.levelI + 1).map(b => b.h))));
    const t1 = ev.side === 'high' ? entry + 1.5 * risk : entry - 1.5 * risk;
    const t2 = ev.side === 'high' ? entry + priorLeg : entry - priorLeg;
    return Object.assign({}, ev, {
      entry, stop, stopSrc, risk,
      riskPct: 100 * risk / entry,
      t1, t2,
      rr: risk > 0 ? Math.abs(t2 - entry) / risk : NaN,
      targetKind: 'measured move from the prior leg',
      plan: ev.side === 'high'
        ? 'Long acceptance above ' + SD.U.fmtPrice(ev.level) + '. Invalidate on a close back under the level, not on an intraday dip.'
        : 'Short acceptance below ' + SD.U.fmtPrice(ev.level) + '. Invalidate on a close back above the level.'
    });
  }

  /* ------------------------------------------------------------------ readouts */
  function buildReadouts(bars, structure, cfg, vs, vp, series, lastAtr, posInRange, vwap, upVolShare, obvSlope, trend) {
    const last = bars[bars.length - 1];
    const rows = [];
    const push = (k, v, note) => rows.push({ k, v, note: note || '' });
    push('Last close', SD.U.fmtPrice(last.c, series.decimals || 2), last.closed ? 'bar closed' : 'bar forming');
    push('ATR(' + cfg.atrPeriod + ')', SD.U.fmtPrice(lastAtr, 4), isFinite(lastAtr) ? R(100 * lastAtr / last.c, 2) + '% of price' : '');
    push('RVOL of last bar', isFinite(vs.rvol) && vs.rvol > 0 ? R(vs.rvol, 2) + '×' : '—', 'median 20-bar vol ' + SD.U.fmtVolume(vs.med));
    push('VWAP', SD.U.fmtPrice(vwap), (series.intervalSeconds >= 86400 ? '20-bar rolling' : 'session anchored') + (isFinite(vwap) && last.c > vwap ? ' · price above' : ' · price below'));
    push('Volume POC', SD.U.fmtPrice(vp.poc), 'highest-volume bin in window');
    push('Up-volume share', isFinite(upVolShare) ? R(100 * upVolShare, 1) + '%' : '—', upVolShare > 0.55 ? 'accumulating' : upVolShare < 0.45 ? 'distributing' : 'balanced');
    push('OBV slope', isFinite(obvSlope) ? R(obvSlope, 3) : '—', obvSlope > 0 ? 'buying pressure' : obvSlope < 0 ? 'selling pressure' : '');
    push('Range position', R(100 * posInRange, 0) + '%', 'of ' + SD.U.fmtPrice(structure.rangeLo || 0) + ' → ' + SD.U.fmtPrice(structure.rangeHi || 0));
    if (structure.resistance) push('Nearest resistance', SD.U.fmtPrice(structure.resistance.price),
      (isFinite(structure.distRes) ? R(structure.distRes, 2) + '% · ' + (isFinite(lastAtr) ? R((structure.resistance.price - last.c) / lastAtr, 1) + '× ATR' : '') : 'at price') + ' · ' + (structure.resistance.rel || 'H'));
    if (structure.support) push('Nearest support', SD.U.fmtPrice(structure.support.price),
      (isFinite(structure.distSup) ? R(structure.distSup, 2) + '% below · ' + (isFinite(lastAtr) ? R((last.c - structure.support.price) / lastAtr, 1) + '× ATR' : '') : 'at price') + ' · ' + (structure.support.rel || 'L'));
    push('Bars in current leg', String(structure.runBars || 0), '');
    pushTrend(trend, 'Trendline · highs');
    pushTrend(trend, 'Trendline · lows');
    push('Confirm bar', cfg.rvolThreshold + '× vol · ' + cfg.sustainBars + '-bar sustain · ' + cfg.breakMargin + '× ATR margin', cfg.requireVolume ? 'strict: no volume, no signal' : 'volume optional');

    function pushTrend(t, label) {
      const line = label.indexOf('highs') >= 0 ? t.high : t.low;
      if (!line) {
        const f = t.rejected[label.indexOf('highs') >= 0 ? 'high' : 'low'];
        push(label, 'none', isFinite(f) ? 'swing scatter fits a line at R2 ' + R(f, 2) + ' · too noisy to draw' : 'needs two close-backed swings');
        return;
      }
      const dir = line.slope > 0 ? 'rising' : line.slope < 0 ? 'falling' : 'flat';
      push(label, SD.U.fmtPrice(line.atLast), dir + ' · ' + (isFinite(line.slopeAtr) ? R(Math.abs(line.slopeAtr), 3) + ' ATR/bar' : 'slope n/a') +
        ' · ' + line.anchors + ' anchors · R2 ' + R(line.fit, 2));
    }
    return rows;
  }

  /* ------------------------------------------------------------------ call
     One number a book can rank on, built only from evidence the engine has already proven.
     Five weighted components, each signed on its own axis, so a bullish swing sequence and a
     falling trendline are allowed to disagree instead of being averaged into a fake middle.
     5/10 is "no edge"; the gates never downgrade to a sell — missing evidence means no position,
     not a short. */
  const CALL_W = { structure: 3, trend: 2.5, confirm: 2, risk: 1.5, flow: 1 };
  const SLOPE_FULL = 0.12;   // ATR per bar at which a fitted trendline counts as fully committed
  const BUY_ABOVE = 6.5, SELL_BELOW = 3.5;
  const STALE_BARS = 40;     // an accepted break older than this is history, not an entry

  function call(model, opts) {
    const o = opts || {};
    const h = SD.U.clamp(Math.round(o.horizon || 5), 1, 60);
    const st = model.structure, tr = model.trend, vol = model.volume, cfg = model.cfg;
    const bars = model.bars, n = bars.length, last = model.last, at = model.lastAtr;
    const C = SD.U.clamp;

    const noVolume = !isFinite(vol.med20) || vol.med20 <= 0 || bars.every(b => !(b.v > 0));

    /* A one-sided swing pool has no structure score at all. Anything built on top of it would be
       invented conviction, so this is reported as "no read" rather than a mid-range number. */
    if (!isFinite(st.bullScore)) {
      return {
        ok: false, score: NaN, action: 'NO READ', trend: 'no read', stance: 'unknown',
        confidence: NaN, gated: true, drivers: [], notes: [], projection: null,
        blockers: [confirmedCount(model) === 0
          ? 'Fewer than two close-backed swings on one side — there is no HH/HL or LH/LL pair to score.'
          : 'Structure pair is one-sided; the engine refuses to average a missing side against zero.']
      };
    }

    const sig = model.signals[0] || null;
    const drivers = [], blockers = [], notes = [];
    const p = (k, pts, txt) => drivers.push({ k, pts: SD.U.round(pts, 2), txt });

    // 1 · the swing sequence itself
    const cStruct = CALL_W.structure * (st.bullScore - 50) / 50;
    p('Structure', cStruct, st.title.replace('Structure · ', '') + ' — sequence score ' + st.bullScore + '/100, ' + st.runBars + ' bars since the last confirmed swing');

    // 2 · the fitted trendlines (null unless R2 >= TREND_FIT_MIN, so a noisy line can't vote)
    const slopes = [];
    if (tr.high && isFinite(tr.high.slopeAtr)) slopes.push(tr.high.slopeAtr);
    if (tr.low && isFinite(tr.low.slopeAtr)) slopes.push(tr.low.slopeAtr);
    const slope = slopes.length ? slopes.reduce((a, b) => a + b, 0) / slopes.length : NaN;
    const cTrend = isFinite(slope) ? CALL_W.trend * C(slope / SLOPE_FULL, -1, 1) : 0;
    p('Trendlines', cTrend, isFinite(slope)
      ? R3(slope) + ' ATR/bar across ' + slopes.length + ' fitted line(s), ' + anchorTxt(tr)
      : 'No line clears the R2 ' + TREND_FIT_MIN + ' floor — the swing scatter is noise, not a trend');

    // 3 · the last accepted break, scaled by how loudly volume printed it
    const thr = cfg.rvolThreshold || 1.5;
    let cConfirm = 0;
    if (sig) {
      const strength = isFinite(sig.rvol) ? C(sig.rvol / thr - 1, 0, 1) : 0;
      cConfirm = CALL_W.confirm * (0.6 + 0.4 * strength) * (sig.dir === 'up' ? 1 : -1);
    }
    const fail = model.events.filter(e => e.dir === 'fail').slice(-1)[0];
    const failFresh = !!fail && (n - 1 - fail.i) <= 3;
    if (failFresh) cConfirm = C(cConfirm - CALL_W.confirm * 0.75, -CALL_W.confirm, CALL_W.confirm);
    p('Confirmation', cConfirm, sig
      ? 'Accepted ' + (sig.dir === 'up' ? 'breakout' : 'breakdown') + ' of ' + SD.U.fmtPrice(sig.level) +
        ' at RVOL ' + R2(sig.rvol) + '× (' + (n - 1 - sig.i) + ' bars ago)' +
        (failFresh ? ' — then reclaimed: a trap print' : '')
      : 'No volume-accepted break in this window — ' + model.watch.length + ' unconfirmed test(s) only');

    // 4 · where price sits between the two binding levels
    let cRisk = 0, riskTxt;
    if (sig && isFinite(sig.rr)) {
      cRisk = CALL_W.risk * C(sig.rr / 3, 0, 1) * (sig.dir === 'up' ? 1 : -1);
      riskTxt = 'Plan pays ' + R2(sig.rr) + 'R to the measured move';
    } else {
      const up = st.resistance && isFinite(at) && at > 0 ? (st.resistance.price - last.c) / at : NaN;
      const dn = st.support && isFinite(at) && at > 0 ? (last.c - st.support.price) / at : NaN;
      cRisk = isFinite(up) && isFinite(dn) ? CALL_W.risk * C((up - dn) / 4, -1, 1) : 0;
      riskTxt = isFinite(up) && isFinite(dn)
        ? R1(up) + '× ATR of room up vs ' + R1(dn) + '× ATR down to the floor'
        : 'Only one binding level, so the reward-risk axis has nothing to measure against';
    }
    p('Reward-risk', cRisk, riskTxt);

    // 5 · participation: who is actually putting the money in
    const pUp = !noVolume && isFinite(vol.upVolShare) ? C((vol.upVolShare - 0.5) / 0.15, -1, 1) : 0;
    const pObv = !noVolume && isFinite(vol.obvSlope) ? C(vol.obvSlope / 0.25, -1, 1) : 0;
    const pDiv = model.divergence ? (model.divergence.kind === 'bearish' ? -1 : 1) : 0;
    const cFlow = CALL_W.flow * (0.4 * pUp + 0.4 * pObv + 0.2 * pDiv);
    p('Participation', cFlow, noVolume
      ? 'Volume-blind feed — the flow axis is deliberately scored flat'
      : 'Up-volume share ' + R1(vol.upVolShare * 100) + '%, OBV slope ' + R3(vol.obvSlope) +
        (model.divergence ? ', ' + model.divergence.kind + ' OBV/price divergence' : ', no OBV divergence'));

    const raw = cStruct + cTrend + cConfirm + cRisk + cFlow;
    const score = SD.U.round(C(5 + raw / 2, 0, 10), 1);

    /* Gates. Every one of these says the same thing in a different voice: the evidence for an
       entry is not there, and "not there" is a flat book, not a directional bet. */
    if (noVolume) blockers.push('No volume series on this feed — nothing printed here can be confirmed, so no break is tradeable.');
    if (n < 40) blockers.push('Only ' + n + ' bars in the window — swings are not two-sided evidence yet. Widen it.');
    if (cfg.requireVolume && !sig) blockers.push('Strict volume mode: ' + model.watch.length + ' break(s) tested, none accepted. An unconfirmed move is not a signal.');
    else if (!sig) blockers.push('No accepted break in this window, so there is no entry to recommend — the structure alone is a stance, not a position.');
    if (failFresh) blockers.push('The last accepted break was reclaimed within 3 bars — that print is a trap, not a trend.');
    /* Age only blocks while the move has been abandoned. Price still holding on the right side of
       the level the break created means the trend is intact, which is the trend-following case, not
       a chase. */
    if (sig && n - 1 - sig.i > STALE_BARS) {
      const holding = sig.dir === 'up' ? last.c > sig.level : last.c < sig.level;
      if (!holding) blockers.push('The accepted break is ' + (n - 1 - sig.i) + ' bars old and price has since come back through the level — that move is finished.');
      else notes.push('The break is ' + (n - 1 - sig.i) + ' bars old, but price has held its side of the level: a trend continuation, not a fresh entry.');
    }
    const gated = blockers.length > 0;

    const action = gated ? 'HOLD' : score >= BUY_ABOVE ? 'BUY' : score <= SELL_BELOW ? 'SELL' : 'HOLD';
    const stance = score >= 6.5 ? 'constructive' : score <= 3.5 ? 'defensive' : 'neutral';

    /* Projection walks the *close* forward at the fitted rate, not at the line's own level — a
       resistance line drawn above the tape is the target, not a forecast of where the close goes.
       The rate is capped where the trendline component itself saturates, so a parabolic fit can
       never print a 20% five-bar call, and the band grows with the square root of the horizon. */
    const dir = st.tone === 'bull' ? 'up' : st.tone === 'bear' ? 'down' : 'side';
    /* Prefer the line whose slope actually agrees with the read: a bullish sequence fitted with a
       falling support line must not be projected downward by that line. */
    const rising = x => !!x && isFinite(x.slope) && x.slope > 0;
    const falling = x => !!x && isFinite(x.slope) && x.slope < 0;
    const line = dir === 'up' ? (rising(tr.low) ? tr.low : rising(tr.high) ? tr.high : (tr.low || tr.high))
      : dir === 'down' ? (falling(tr.high) ? tr.high : falling(tr.low) ? tr.low : (tr.high || tr.low))
        : (tr.high || tr.low);
    if (line && dir === 'up' && line.slope < 0) notes.push('The structure is bullish but every fitted line is falling, so the forecast drifts down until a close takes out the level above.');
    if (line && dir === 'down' && line.slope > 0) notes.push('The structure is bearish but every fitted line is rising, so the forecast drifts up until a close loses the level below.');
    const unit = isFinite(at) && at > 0 ? at : last.c * 0.02;
    const rateCap = SLOPE_FULL * unit;
    let rate = 0, rateSrc = 'last close (no fitted line)';
    if (line) {
      rate = C(line.slope, -rateCap, rateCap);
      rateSrc = (line.side === 'high' ? 'high' : 'low') + ' trendline' +
        (Math.abs(line.slope) > rateCap ? ' (rate capped)' : '');
    }
    const to = last.c + rate * h;
    const band = unit * Math.sqrt(h);
    const invalid = dir === 'up'
      ? (st.support ? st.support.price : last.c - 2 * band)
      : dir === 'down'
        ? (st.resistance ? st.resistance.price : last.c + 2 * band)
        : (st.support ? st.support.price : last.c - band);
    /* A fitted support line that price is still standing above is the trend break; once the close
       has dropped under it, that line is no longer the invalidation — the swing floor is. */
    const lineFwd = line && isFinite(line.atLast) && isFinite(line.slope) ? line.atLast + line.slope * h : NaN;
    const invalidAt = dir === 'up'
      ? (isFinite(lineFwd) && lineFwd < last.c ? lineFwd : invalid)
      : dir === 'down'
        ? (isFinite(lineFwd) && lineFwd > last.c ? lineFwd : invalid)
        : invalid;
    const projection = {
      horizon: h, dir, from: last.c, to, lo: to - band, hi: to + band,
      pct: last.c > 0 ? 100 * (to - last.c) / last.c : NaN,
      source: rateSrc, rate,
      target: dir === 'up' ? (st.resistance ? st.resistance.price : NaN)
        : dir === 'down' ? (st.support ? st.support.price : NaN) : NaN,
      invalid, invalidAt
    };

    let conf = 35 + 30 * Math.abs(score - 5) / 5;
    if (sig) conf += 10;
    if (tr.high && tr.low) conf += 6;
    conf += n >= 120 ? 6 : n >= 60 ? 3 : 0;
    if (!noVolume) conf += 5;
    if (gated) conf -= 15;
    const confidence = SD.U.round(C(conf, 5, 92), 0);

    const trendLabel = dir === 'up' ? 'Higher' : dir === 'down' ? 'Lower' : 'Sideways';
    const trendTxt = trendLabel + (isFinite(slope)
      ? ' · ' + (slope > 0.0005 ? 'rising' : slope < -0.0005 ? 'falling' : 'flat') + ' trendline at ' + R3(slope) + ' ATR/bar'
      : ' · no fitted trendline');

    return {
      ok: true, score, action, gated, stance, trend: trendLabel, trendTxt,
      confidence, drivers, blockers, notes, projection, signal: sig ? { dir: sig.dir, level: sig.level, ago: n - 1 - sig.i, rr: sig.rr } : null,
      summary: trendLabel + ' · ' + score + '/10 · ' + action + (gated ? ' (gated)' : '') + ' · ' + confidence + '% confidence'
    };
  }

  function confirmedCount(model) { return model.confirmedHighs.length + model.confirmedLows.length; }
  function anchorTxt(tr) {
    const a = [];
    if (tr.high) a.push(tr.high.anchors + ' on the highs');
    if (tr.low) a.push(tr.low.anchors + ' on the lows');
    return a.length ? a.join(' + ') : 'zero usable lines';
  }
  function R1(v) { return isFinite(v) ? SD.U.round(v, 1) : '—'; }
  function R2(v) { return isFinite(v) ? SD.U.round(v, 2) : '—'; }
  function R3(v) { return isFinite(v) ? SD.U.round(v, 3) : '—'; }

  return { run, atr, findPivots, closeQuality, volumeProfile, scoreStructure, fitTrendline, trendlines, call };
})();
