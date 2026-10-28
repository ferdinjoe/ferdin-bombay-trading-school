/* Structure Desk — canvas renderer.
   Hand-written so structure annotations (HH/HL/LH/LL, accepted vs wick-only breaks) are first-class
   rather than fighting a charting library's plugin API. No CDN, no build.
   One renderer per canvas: SD.Chart.make(el) for a row, SD.Chart.render(...) for the desk's own.

   opts this renderer understands:
     mode      'candles' | 'line' | 'both' | 'bars' | 'hollow' | 'heikin' | 'area'
     volume    price pane + volume pane
     structure swing triangles · levels · trend · events · vwap · poc · fib
     studies   SD.Ind.studies() output — kind 'overlay' draws in the price pane, 'pane' gets its own
     log       log price scale
     replay    {total, label} — paints the replay cursor instead of pretending the tape is live
     tz, interval, live, mouseY  as before  */
SD.Chart = (function () {
  'use strict';

  const COL = {
    grid: '#161d28', gridStrong: '#202a38',
    axis: '#8c9cb0', axisDim: '#5f7085',
    up: '#26b376', down: '#e34f5c',
    upFill: 'rgba(38,179,118,.85)', downFill: 'rgba(227,79,92,.85)',
    line: '#4ba3d8', lineFill: 'rgba(75,163,216,.12)',
    volUp: 'rgba(38,179,118,.42)', volDown: 'rgba(227,79,92,.42)',
    vwap: 'rgba(150,166,186,.65)', poc: 'rgba(242,181,60,.5)',
    levelUp: 'rgba(38,179,118,.75)', levelDown: 'rgba(227,79,92,.75)',
    wickLevel: 'rgba(140,156,176,.45)',
    fibKey: 'rgba(242,181,60,.55)', fibMinor: 'rgba(140,156,176,.30)',
    cross: 'rgba(216,226,238,.35)',
    labelBull: '#26b376', labelBear: '#e34f5c', labelFlat: '#8c9cb0', warn: '#f2b53c'
  };

  // Two sub-panes is the honest ceiling for a desk-sized canvas: a third leaves the price pane
  // too short to read the swings, which are the whole point of this app.
  const MAX_PANES = 2;
  const PERBAR = { candles: 1, both: 1, hollow: 1, heikin: 1, bars: 1 };
  const LINEY = { line: 1, area: 1, both: 1 };

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const norm = raw / mag;
    const step = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    return step * mag;
  }

  function activeLevels(model) {
    const out = [];
    const st = model.structure;
    if (st && st.resistance) out.push({ price: st.resistance.price, at: st.resistance.i, color: COL.levelUp, solid: true, kind: 'resistance' });
    if (st && st.support) out.push({ price: st.support.price, at: st.support.i, color: COL.levelDown, solid: true, kind: 'support' });
    if (st && st.lastHigh && (!st.resistance || st.lastHigh.i !== st.resistance.i)) out.push({ price: st.lastHigh.price, at: st.lastHigh.i, color: COL.wickLevel, solid: false, kind: 'trend high' });
    if (st && st.lastLow && (!st.support || st.lastLow.i !== st.support.i)) out.push({ price: st.lastLow.price, at: st.lastLow.i, color: COL.wickLevel, solid: false, kind: 'trend low' });
    for (const ev of model.events) {
      if (ev.pending) out.push({ price: ev.level, at: ev.levelI, color: COL.warn, solid: false, kind: 'test' });
    }
    return out;
  }

  function drawTriangle(c, x, y, side, col, filled) {
    c.beginPath();
    if (side === 'high') { c.moveTo(x, y - 4); c.lineTo(x - 4.5, y + 2.5); c.lineTo(x + 4.5, y + 2.5); }
    else { c.moveTo(x, y + 4); c.lineTo(x - 4.5, y - 2.5); c.lineTo(x + 4.5, y - 2.5); }
    c.closePath();
    c.strokeStyle = col; c.lineWidth = 1.1;
    if (filled) { c.fillStyle = col; c.fill(); } else { c.stroke(); }
  }

  function tagRight(c, x, y, text, bg, fg, padR) {
    c.font = '10px ' + mono();
    c.fillStyle = bg;
    c.fillRect(x + 3, y - 7, padR - 6, 14);
    c.fillStyle = fg;
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, x + 6, y);
  }

  /* Oscillators live on scales the price formatter would round away — MACD on a ₹200 stock is a
     two-decimal number, RSI needs one. So the pane formatters its own numbers. */
  function fmtNum(v) {
    if (!isFinite(v)) return '—';
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(2) : v.toFixed(3);
  }

  function fmtTick(p, dec) {
    return SD.U.fmtPrice(p, dec === undefined ? SD.U.priceDecimals(p) : dec);
  }

  function mono() {
    return '"SFMono-Regular","Cascadia Mono","JetBrains Mono",ui-monospace,Consolas,monospace';
  }

  /* ------------------------------------------------------------------ instance */
  function make(el) {
    let canvas = el, ctx = el.getContext('2d'), hover = -1;

    function fit() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function render(model, opts) {
      if (!canvas) return;
      const bars = model.bars;
      if (!bars || bars.length < 2) { clear('Need at least two bars.'); return; }
      const { w, h } = fit();
      ctx.clearRect(0, 0, w, h);

      const padR = 64, padL = 6, padT = 10, padB = 22;
      const plotW = w - padL - padR;
      const n = bars.length;
      const slot = plotW / n;
      const cw = Math.max(1, Math.min(slot * 0.72, 15));

      // ---- vertical layout: price, then studies, then volume pinned to the bottom ----
      const studies = opts.studies || [];
      const overlays = studies.filter(s => s.kind === 'overlay');
      const requested = studies.filter(s => s.kind === 'pane');
      const panes = requested.slice(0, MAX_PANES);
      const volH = opts.volume ? Math.max(52, Math.round(h * 0.19)) : 0;
      const volGap = opts.volume ? 8 : 0;
      const paneH = h >= 420 ? 78 : 64;
      const paneGap = 6;
      /* A sub-pane is only allowed while it leaves the price pane tall enough to read the swings.
         This is what silently disables panes on a watchlist row without the row needing to know. */
      while (panes.length && h - padB - volH - volGap - padT - panes.length * (paneH + paneGap) < 110) panes.pop();
      const panesH = panes.length ? panes.length * (paneH + paneGap) : 0;
      const priceTop = padT;
      const priceBot = h - padB - volH - volGap - panesH;

      const xFor = i => padL + (i + 0.5) * slot;
      const inPrice = y => y >= priceTop - 2 && y <= priceBot + 2;

      // ---- scale ----
      let lo = Infinity, hi = -Infinity;
      for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
      if (opts.levels) {
        for (const lv of activeLevels(model)) { if (lv.price > 0) { lo = Math.min(lo, lv.price); hi = Math.max(hi, lv.price); } }
      }
      // A channel that runs off-canvas is worse than a slightly airy scale, so overlays set the range too.
      for (const s of overlays) {
        for (const arr of [s.line, s.upper, s.lower]) {
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
        }
      }
      if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { const m = lo || 1; lo = m * 0.98; hi = m * 1.02; }
      const pad = (hi - lo) * 0.08;
      lo -= pad; hi += pad;
      if (opts.log && lo <= 0) lo = hi * 0.0005;

      const lgLo = Math.log(lo), lgHi = Math.log(hi);
      function yFor(p) {
        const t = opts.log ? (Math.log(Math.max(p, 1e-9)) - lgLo) / (lgHi - lgLo) : (p - lo) / (hi - lo);
        return priceBot - t * (priceBot - priceTop);
      }

      // ---- grid + price axis ----
      ctx.font = '10px ' + mono();
      ctx.textBaseline = 'middle';
      const step = niceStep(hi - lo, Math.max(3, Math.floor((priceBot - priceTop) / 46)));
      const start = Math.ceil(lo / step) * step;
      for (let p = start; p <= hi; p += step) {
        const y = yFor(p);
        if (y < priceTop - 1 || y > priceBot + 1) continue;
        ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, Math.round(y) + .5); ctx.lineTo(padL + plotW, Math.round(y) + .5); ctx.stroke();
        ctx.fillStyle = COL.axisDim; ctx.textAlign = 'left';
        ctx.fillText(fmtTick(p, model.dec), padL + plotW + 6, y);
      }

      // ---- time axis ----
      const lblEvery = Math.max(1, Math.round(n / Math.max(2, Math.floor(plotW / 92))));
      ctx.textAlign = 'center';
      for (let i = 0; i < n; i += lblEvery) {
        const x = xFor(i);
        ctx.strokeStyle = COL.grid;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, priceTop); ctx.lineTo(Math.round(x) + .5, h - padB); ctx.stroke();
        ctx.fillStyle = COL.axisDim;
        ctx.fillText(SD.U.fmtBarTime(bars[i].t, opts.interval, opts.tz), x, h - padB / 2);
      }

      // ---- session separators (intraday) ----
      if (opts.interval !== '1d' && opts.interval !== '1wk' && opts.interval !== '1mo') {
        let prevKey = null;
        for (let i = 0; i < n; i++) {
          const k = SD.U.dayKey(bars[i].t, opts.tz);
          if (prevKey && k !== prevKey) {
            const x = Math.round(xFor(i) - slot / 2) + .5;
            ctx.strokeStyle = COL.gridStrong; ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(x, priceTop); ctx.lineTo(x, h - padB); ctx.stroke();
            ctx.setLineDash([]);
          }
          prevKey = k;
        }
      }

      // ---- volume pane ----
      let maxV = 0;
      for (const b of bars) if (b.v > maxV) maxV = b.v;
      const volTop = h - padB - volH;
      if (opts.volume) {
        ctx.strokeStyle = COL.grid;
        ctx.beginPath(); ctx.moveTo(padL, volTop + .5); ctx.lineTo(padL + plotW, volTop + .5); ctx.stroke();
        for (let i = 0; i < n; i++) {
          const b = bars[i];
          const bh = maxV > 0 ? (b.v / maxV) * (volH - 6) : 0;
          ctx.fillStyle = b.c >= b.o ? COL.volUp : COL.volDown;
          ctx.fillRect(xFor(i) - cw / 2, volTop + volH - bh, cw, Math.max(bh, 0.6));
        }
        // 20-bar median volume reference
        const med = SD.U.median(bars.slice(Math.max(0, n - 20), n).map(b => b.v));
        if (med > 0 && maxV > 0) {
          const y = volTop + volH - (med / maxV) * (volH - 6);
          ctx.strokeStyle = 'rgba(140,156,176,.5)'; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = COL.axisDim; ctx.textAlign = 'left';
          ctx.fillText('med vol ' + SD.U.fmtVolume(med), padL + 4, y - 6);
        }
        ctx.fillStyle = COL.axisDim; ctx.textAlign = 'left';
        ctx.fillText('V ' + SD.U.fmtVolume(maxV), padL + 4, volTop + 8);
      }

      // ---- price series ----
      /* Heikin Ashi is a display transform only: every annotation below still sits at the raw
         price, so the labeller's claims stay about the values that actually traded. */
      const disp = opts.mode === 'heikin' && SD.Ind ? SD.Ind.heikinAshi(bars) : bars;

      if (PERBAR[opts.mode] || !opts.mode) {
        const hollow = opts.mode === 'hollow';
        for (let i = 0; i < n; i++) {
          const b = disp[i];
          const up = b.c >= b.o;
          const x = xFor(i);
          const yO = yFor(b.o), yC = yFor(b.c), yH = yFor(b.h), yL = yFor(b.l);
          if (opts.mode === 'bars') {
            // Classic OHLC: the vertical is the range, open ticks left of the stem, close right.
            ctx.strokeStyle = up ? COL.up : COL.down; ctx.lineWidth = cw > 4 ? 1.4 : 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + .5, yH); ctx.lineTo(Math.round(x) + .5, yL);
            ctx.moveTo(x - cw / 2, Math.round(yO) + .5); ctx.lineTo(Math.round(x) + .5, Math.round(yO) + .5);
            ctx.moveTo(Math.round(x) + .5, Math.round(yC) + .5); ctx.lineTo(x + cw / 2, Math.round(yC) + .5);
            ctx.stroke();
            if (!b.closed && opts.live) {
              ctx.strokeStyle = COL.warn; ctx.setLineDash([2, 2]);
              ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yH - 3); ctx.lineTo(Math.round(x) + .5, yL + 3); ctx.stroke();
              ctx.setLineDash([]);
            }
            continue;
          }
          ctx.strokeStyle = up ? COL.up : COL.down;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, yH); ctx.lineTo(Math.round(x) + .5, yL); ctx.stroke();
          const top = Math.min(yO, yC), bh = Math.max(1, Math.abs(yC - yO));
          if (hollow && up) {
            ctx.fillStyle = '#0b0f14';
            ctx.fillRect(x - cw / 2, top, cw, bh);
            ctx.strokeRect(Math.round(x - cw / 2) + .5, Math.round(top) + .5, Math.round(cw) - 1, Math.max(1, Math.round(bh) - 1));
          } else {
            ctx.fillStyle = up ? COL.upFill : COL.downFill;
            ctx.fillRect(x - cw / 2, top, cw, bh);
          }
          if (!b.closed && opts.live) {
            ctx.strokeStyle = COL.warn; ctx.setLineDash([2, 2]);
            ctx.strokeRect(x - cw / 2 - 1.5, top - 1.5, cw + 3, bh + 3);
            ctx.setLineDash([]);
          }
        }
      }
      if (LINEY[opts.mode]) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const x = xFor(i), y = yFor(disp[i].c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
        ctx.strokeStyle = opts.mode === 'both' ? 'rgba(75,163,216,.9)' : COL.line;
        ctx.lineWidth = opts.mode === 'both' ? 1.1 : 1.5;
        ctx.stroke();
        if (opts.mode === 'line' || opts.mode === 'area') {
          ctx.lineTo(xFor(n - 1), priceBot); ctx.lineTo(xFor(0), priceBot); ctx.closePath();
          if (opts.mode === 'area') {
            const g = ctx.createLinearGradient(0, priceTop, 0, priceBot);
            g.addColorStop(0, 'rgba(75,163,216,.30)'); g.addColorStop(1, 'rgba(75,163,216,.03)');
            ctx.fillStyle = g;
          } else ctx.fillStyle = COL.lineFill;
          ctx.fill();
        }
      }

      // ---- overlays: moving averages and channels ----
      for (const s of overlays) {
        if (s.band && s.upper && s.lower) {
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < n; i++) { if (!isFinite(s.upper[i]) || !isFinite(s.lower[i])) { pen = false; continue; }
            pen ? ctx.lineTo(xFor(i), yFor(s.upper[i])) : (ctx.moveTo(xFor(i), yFor(s.upper[i])), pen = true); }
          for (let i = n - 1; i >= 0; i--) { if (!isFinite(s.upper[i]) || !isFinite(s.lower[i])) continue; ctx.lineTo(xFor(i), yFor(s.lower[i])); }
          ctx.closePath();
          ctx.fillStyle = 'rgba(140,156,176,.10)'; ctx.fill();
        }
        for (const key of ['line', 'upper', 'lower']) {
          const arr = s[key];
          if (!arr) continue;
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < n; i++) {
            if (!isFinite(arr[i])) { pen = false; continue; }
            const x = xFor(i), y = yFor(arr[i]);
            pen ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), pen = true);
          }
          ctx.strokeStyle = key === 'line' ? s.color : 'rgba(140,156,176,.55)';
          ctx.lineWidth = key === 'line' ? 1.2 : 1;
          ctx.setLineDash(key === 'line' ? [] : [3, 3]);
          ctx.stroke(); ctx.setLineDash([]);
        }
      }

      // ---- VWAP + POC references ----
      if (opts.vwap && model.vwap) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = model.vwap[i];
          if (!isFinite(v)) continue;
          const x = xFor(i), y = yFor(v);
          started ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), started = true);
        }
        ctx.strokeStyle = COL.vwap; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
      if (opts.poc && model.vp && isFinite(model.vp.poc)) {
        const y = yFor(model.vp.poc);
        if (inPrice(y)) {
          ctx.strokeStyle = COL.poc; ctx.setLineDash([1, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = COL.poc; ctx.textAlign = 'right';
          ctx.fillText('POC', padL + plotW - 4, y - 6);
        }
      }

      // ---- Fibonacci retracement across the leg the structure is in ----
      if (opts.fib && SD.Ind) {
        const leg = SD.Ind.fibLeg(model);
        if (leg) {
          const x0 = xFor(Math.max(0, leg.start));
          for (const L of leg.levels) {
            const y = yFor(L.price);
            if (!inPrice(y)) continue;
            ctx.strokeStyle = L.key ? COL.fibKey : COL.fibMinor;
            ctx.lineWidth = L.key ? 1.1 : 1;
            ctx.setLineDash(L.key ? [5, 3] : [2, 5]);
            ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = L.key ? COL.warn : COL.axisDim; ctx.textAlign = 'left';
            ctx.fillText(L.label, x0 + 4, y - 6);
            if (L.key) tagRight(ctx, padL + plotW, y, fmtTick(L.price, model.dec), '#141b26', COL.warn, padR);
          }
          // The measured leg itself, so the reader can see which two swings the grid came from.
          ctx.strokeStyle = 'rgba(242,181,60,.85)'; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.moveTo(xFor(leg.fromI), yFor(leg.from)); ctx.lineTo(xFor(leg.toI), yFor(leg.to)); ctx.stroke();
        }
      }

      // ---- swing levels ----
      if (opts.levels) {
        for (const lv of activeLevels(model)) {
          const y = yFor(lv.price);
          if (!inPrice(y)) continue;
          ctx.strokeStyle = lv.color;
          ctx.lineWidth = lv.solid ? 1.4 : 1;
          ctx.setLineDash(lv.solid ? [6, 4] : [2, 4]);
          ctx.beginPath(); ctx.moveTo(xFor(lv.at), y); ctx.lineTo(padL + plotW, y); ctx.stroke();
          ctx.setLineDash([]);
          tagRight(ctx, padL + plotW, y, fmtTick(lv.price, model.dec), '#141b26', lv.color, padR);
        }
      }

      // ---- trendlines fitted through the close-weighted swings ----
      if (opts.trend && model.trend) {
        for (const line of [model.trend.high, model.trend.low]) {
          if (!line) continue;
          const col = line.side === 'high' ? COL.levelDown : COL.levelUp;
          const yAt = i => yFor(line.atLast - line.slope * (line.to - i));
          const y0 = yAt(line.from), y1 = yAt(line.lastAnchor), yEnd = yAt(line.to);
          if (!inPrice(y0) && !inPrice(y1) && !inPrice(yEnd)) continue;
          ctx.save();
          ctx.beginPath(); ctx.rect(padL, priceTop, plotW, priceBot - priceTop); ctx.clip();
          ctx.strokeStyle = col; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(xFor(line.from), y0); ctx.lineTo(xFor(line.lastAnchor), y1); ctx.stroke();
          // Past the newest anchor the line is a projection, not history, so it stops being solid.
          ctx.setLineDash([3, 4]);
          ctx.beginPath(); ctx.moveTo(xFor(line.lastAnchor), y1); ctx.lineTo(padL + plotW, yEnd); ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
          if (inPrice(y1)) drawTriangle(ctx, xFor(line.lastAnchor), y1, line.side, col, false);
          if (inPrice(yEnd)) tagRight(ctx, padL + plotW, yEnd, fmtTick(line.atLast, model.dec), '#141b26', col, padR);
        }
      }

      // ---- structure markers ----
      if (opts.structure) {
        const shown = model.swings.filter(s => s.i > n - Math.max(60, n * 0.6));
        for (const s of shown) {
          if (!s.rel) continue;
          const bull = s.rel === 'HH' || s.rel === 'HL';
          const bear = s.rel === 'LH' || s.rel === 'LL';
          const col = s.rel[0] === 'E' ? COL.warn : bull ? COL.labelBull : bear ? COL.labelBear : COL.labelFlat;
          const x = xFor(s.i);
          const y = yFor(s.price);
          if (!inPrice(y)) continue;
          drawTriangle(ctx, x, y, s.side, col, s.closeBacked && !s.forming);
          ctx.font = '700 9px ' + mono();
          ctx.textAlign = 'center';
          ctx.fillStyle = col;
          ctx.globalAlpha = s.forming ? .55 : 1;
          ctx.fillText(s.rel, x, s.side === 'high' ? y - 15 : y + 16);
          ctx.globalAlpha = 1;
        }
      }

      // ---- events ----
      if (opts.events) {
        for (const ev of model.events) {
          if (ev.pending) continue;
          const x = xFor(ev.i);
          const b = bars[ev.i];
          const y = ev.side === 'high' ? yFor(b.h) : yFor(b.l);
          const col = ev.failed ? COL.warn : ev.confirmed ? (ev.side === 'high' ? COL.up : COL.down) : COL.labelFlat;
          const dir = ev.failed ? (ev.side === 'high' ? 1 : -1) : (ev.side === 'high' ? -1 : 1);
          const off = dir * (ev.confirmed || ev.failed ? 20 : 14);
          if (!inPrice(y + off + dir * 7)) continue;
          ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, y + off);
          ctx.lineTo(x - 4, y + off + dir * 7);
          ctx.lineTo(x + 4, y + off + dir * 7);
          ctx.closePath();
          if (ev.confirmed || ev.failed) ctx.fill(); else { ctx.stroke(); }
          if (!ev.confirmed && !ev.failed) {
            ctx.font = '9px ' + mono(); ctx.textAlign = 'center';
            ctx.fillText('?', x, y + off + dir * 15);
          }
        }
      }

      // ---- study panes ----
      panes.forEach((p, idx) => drawPane(p, priceBot + idx * (paneH + paneGap) + paneGap, paneH, idx));

      // ---- last price line ----
      const lastB = bars[n - 1];
      const yLast = yFor(lastB.c);
      const lastUp = lastB.c >= lastB.o;
      if (inPrice(yLast)) {
        ctx.strokeStyle = lastUp ? COL.up : COL.down;
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, yLast); ctx.lineTo(padL + plotW, yLast); ctx.stroke();
        ctx.setLineDash([]);
        tagRight(ctx, padL + plotW, yLast, fmtTick(lastB.c, model.dec), lastUp ? COL.up : COL.down, '#0b0f14', padR);
      }

      // ---- replay cursor ----
      /* In replay the rightmost bar is a chosen moment, not the present, so the tape gets a rail
         and a caption rather than letting a historical close wear the live price tag. */
      if (opts.replay) {
        const x = Math.round(xFor(n - 1) + slot / 2) + .5;
        ctx.strokeStyle = 'rgba(242,181,60,.7)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, priceTop); ctx.lineTo(x, h - padB); ctx.stroke();
        const txt = 'REPLAY · ' + bars.length + '/' + (opts.replay.total || '?') + ' bars · ' +
          SD.U.fmtBarTime(lastB.t, opts.interval, opts.tz);
        ctx.font = '10px ' + mono(); ctx.textAlign = 'left';
        const tw = ctx.measureText(txt).width + 12;
        ctx.fillStyle = 'rgba(242,181,60,.14)';
        ctx.fillRect(padL + 2, priceBot - 20, tw, 16);
        ctx.fillStyle = COL.warn;
        ctx.fillText(txt, padL + 8, priceBot - 12);
      }

      // ---- crosshair ----
      if (hover >= 0 && hover < n) {
        const x = xFor(hover);
        ctx.strokeStyle = COL.cross; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(Math.round(x) + .5, priceTop); ctx.lineTo(Math.round(x) + .5, h - padB); ctx.stroke();
        if (opts.mouseY !== undefined && opts.mouseY > priceTop && opts.mouseY < priceBot) {
          ctx.beginPath(); ctx.moveTo(padL, Math.round(opts.mouseY) + .5); ctx.lineTo(padL + plotW, Math.round(opts.mouseY) + .5); ctx.stroke();
          const p = opts.log
            ? Math.exp(lgLo + (priceBot - opts.mouseY) / (priceBot - priceTop) * (lgHi - lgLo))
            : lo + (priceBot - opts.mouseY) / (priceBot - priceTop) * (hi - lo);
          ctx.setLineDash([]);
          tagRight(ctx, padL + plotW, opts.mouseY, fmtTick(p, model.dec), '#1b2331', COL.axis, padR);
        }
        ctx.setLineDash([]);
      }

      /* One pane: its own scale, frame, guides and last-value tag. Fixed scales (RSI, Stoch) keep
         their 0-100 so oversold means the same thing on every symbol; MACD floats with the tape. */
      function drawPane(p, top, hh, idx) {
        const bot = top + hh;
        ctx.strokeStyle = COL.gridStrong; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, Math.round(top) + .5); ctx.lineTo(padL + plotW, Math.round(top) + .5); ctx.stroke();

        let plo = Infinity, phi = -Infinity;
        if (p.scale) { plo = p.scale[0]; phi = p.scale[1]; }
        else {
          [p.line, p.line2, p.hist].forEach(a => {
            if (!a) return;
            for (let i = 0; i < a.length; i++) { const v = a[i]; if (isFinite(v)) { if (v < plo) plo = v; if (v > phi) phi = v; } }
          });
          if (!isFinite(plo) || !isFinite(phi)) { plo = 0; phi = 1; }
          // MACD is read against zero, so zero stays on the pane even when the whole window is
          // one-sided; otherwise the histogram would be drawn from the floor and mislead.
          if (p.zero) { plo = Math.min(plo, 0); phi = Math.max(phi, 0); }
          if (plo === phi) { plo -= 1; phi += 1; }
          const pd = (phi - plo) * 0.12; plo -= pd; phi += pd;
        }
        const yP = v => bot - (v - plo) / (phi - plo) * hh;

        ctx.save();
        ctx.beginPath(); ctx.rect(padL, top, plotW, hh); ctx.clip();

        if (p.zero) {
          const y0 = yP(0);
          ctx.strokeStyle = 'rgba(140,156,176,.45)'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0); ctx.stroke(); ctx.setLineDash([]);
        }
        for (const b of (p.bands || [])) {
          const y = yP(b);
          ctx.strokeStyle = 'rgba(140,156,176,.28)'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = COL.axisDim; ctx.font = '9px ' + mono(); ctx.textAlign = 'right';
          ctx.fillText(String(b), padL + plotW - 4, y - 5);
        }
        if (p.hist) {
          const base = yP(Math.max(plo, Math.min(phi, 0)));
          for (let i = 0; i < n; i++) {
            const v = p.hist[i];
            if (!isFinite(v)) continue;
            const y = yP(v);
            ctx.fillStyle = v >= 0 ? COL.volUp : COL.volDown;
            ctx.fillRect(xFor(i) - cw / 2, Math.min(y, base), cw, Math.max(0.8, Math.abs(y - base)));
          }
        }
        for (const arr of [p.line, p.line2]) {
          if (!arr) continue;
          ctx.beginPath();
          let pen = false;
          for (let i = 0; i < n; i++) {
            if (!isFinite(arr[i])) { pen = false; continue; }
            const x = xFor(i), y = yP(arr[i]);
            pen ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), pen = true);
          }
          ctx.strokeStyle = arr === p.line ? p.color : (p.color2 || p.color);
          ctx.lineWidth = 1.1; ctx.stroke();
        }
        ctx.restore();

        ctx.font = '9px ' + mono(); ctx.textAlign = 'left'; ctx.fillStyle = COL.axisDim;
        /* A selection the layout had to drop is said out loud rather than left as a missing line —
           on a short canvas the panes are the first thing sacrificed. */
        const off = requested.length - panes.length;
        ctx.fillText(p.label + (idx === panes.length - 1 && off > 0 ? '  · ' + off + ' pane(s) hidden: chart too short' : ''), padL + 4, top + 9);
        const lv = SD.Ind ? SD.Ind.lastVal(p.line) : NaN;
        if (isFinite(lv)) tagRight(ctx, padL + plotW, SD.U.clamp(yP(lv), top + 7, bot - 7),
          p.scale ? lv.toFixed(1) : fmtNum(lv), '#141b26', p.color, padR);
      }

      return { xFor, yFor, slot, n, padL, plotW, priceTop, priceBot, panes: panes.length };
    }

    function clear(msg) {
      if (!canvas) return;
      const { w, h } = fit();
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = COL.axisDim; ctx.font = '12px ' + mono(); ctx.textAlign = 'center';
      ctx.fillText(msg || '', w / 2, h / 2);
    }

    function indexAt(px, model) {
      const rect = canvas.getBoundingClientRect();
      const padR = 64, padL = 6;
      const plotW = rect.width - padL - padR;
      const n = model.bars.length;
      const slot = plotW / n;
      const x = px - rect.left;
      return SD.U.clamp(Math.floor((x - padL) / slot), 0, n - 1);
    }

    return {
      render, clear, indexAt,
      setHover(i) { hover = i; },
      getHover() { return hover; },
      element() { return canvas; }
    };
  }

  /* ------------------------------------------------------------------ desk singleton
     The main chart keeps the historical module-level API so ui.js needs no knowledge of
     instances; every call forwards to the one canvas handed to init(). */
  let desk = null;
  function init(el) { desk = make(el); }
  function api(name, fallback) {
    return function () {
      if (!desk) return fallback;
      return desk[name].apply(desk, arguments);
    };
  }

  return { make, init, COL, activeLevels, MAX_PANES, render: api('render'), clear: api('clear'), indexAt: api('indexAt'), setHover: api('setHover'), getHover: api('getHover') };
})();
