/* Browser-side trendline overlay proof. Load in the page's main world:
     var s = document.createElement('script');
     s.src = '/test/trend-pixel-proof.js';
     document.body.appendChild(s);
   Then read document.body.dataset.trendProof (or the console line).

   It toggles #tglTrend off and back on, diffs the chart canvas, and fits a
   straight line to each stroke it finds. draw() coalesces through
   requestAnimationFrame, so in a hidden automation tab rAF must be shimmed
   first (the script does that itself).                                                        */
(function () {
  'use strict';

  window.requestAnimationFrame = function (cb) {
    return setTimeout(function () { cb(performance.now()); }, 0);
  };

  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function px(data, i) { return [data[i], data[i + 1], data[i + 2]]; }

  function lineFit(points) {
    if (points.length < 4) return null;
    var n = points.length, sx = 0, sy = 0, sxy = 0, sxx = 0, j;
    for (j = 0; j < n; j++) { sx += points[j][0]; sy += points[j][1]; sxy += points[j][0] * points[j][1]; sxx += points[j][0] * points[j][0]; }
    var slope = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1);
    var intercept = (sy - slope * sx) / n, meanY = sy / n, sst = 0, sse = 0;
    for (j = 0; j < n; j++) { sst += Math.pow(points[j][1] - meanY, 2); sse += Math.pow(points[j][1] - (intercept + slope * points[j][0]), 2); }
    return { slope: Math.round(slope * 1e4) / 1e4, r2: Math.round((1 - sse / (sst || 1)) * 1e4) / 1e4, columns: n };
  }

  (async function run() {
    var canvas = document.getElementById('chart');
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var toggle = document.getElementById('tglTrend');
    if (!canvas || !toggle) { report({ error: 'chart canvas or #tglTrend missing' }); return; }

    var snapshot = function () { return Array.prototype.slice.call(ctx.getImageData(0, 0, W, H).data); };
    var diff = function (a, b) {
      var out = [];
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var i = (y * W + x) * 4, p = px(a, i), q = px(b, i);
          if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 8) out.push([x, y]);
        }
      }
      return out;
    };

    var on = snapshot();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    var off = snapshot();
    var ink = diff(on, off);

    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(500);
    var back = snapshot();

    var leftover = 0;
    for (var i = 0; i < on.length; i += 4) {
      var p = px(on, i), q = px(back, i);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 8) leftover++;
    }

    var byColumn = {};
    ink.forEach(function (pt) { (byColumn[pt[0]] = byColumn[pt[0]] || []).push(pt[1]); });
    var columns = Object.keys(byColumn).map(Number).sort(function (a, b) { return a - b; });
    var strokes = [[], []];
    columns.forEach(function (x) {
      if (x > W - 46) return;
      var ys = byColumn[x].sort(function (a, b) { return a - b; });
      var groups = [];
      ys.forEach(function (y) {
        var top = groups[groups.length - 1];
        if (top && y - top[top.length - 1] <= 2) top.push(y); else groups.push([y]);
      });
      if (groups.length < 2) return;
      [0, groups.length - 1].forEach(function (gi, slot) {
        var g = groups[gi];
        strokes[slot].push([x, g.reduce(function (a, b) { return a + b; }, 0) / g.length]);
      });
    });

    report({
      canvas: [W, H],
      trendInkPixels: ink.length,
      columnsInked: columns.length,
      restoreLeftoverPixels: leftover,
      strokeTop: lineFit(strokes[0]),
      strokeBottom: lineFit(strokes[1]),
      toggleRestored: toggle.checked === true
    });
  })();

  function report(result) {
    var txt = JSON.stringify(result);
    document.body.dataset.trendProof = txt;
    console.log('TREND_PROOF ' + txt);
  }
})();
