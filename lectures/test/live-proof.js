/* Proof that the lecture deck's live tape really moves on real data.
   Load it in the page (main world) from the served origin, then read the JSON it writes to
   document.body.dataset.liveProof:

     const s = document.createElement('script');
     s.src = '/lectures/test/live-proof.js?' + Date.now();
     document.body.appendChild(s);

   It needs http:// (file:// works too but the relays prefer an origin). Allow ~45s. */
(function () {
  'use strict';
  var cv = document.getElementById('liveCv');
  var out = { ok: false, steps: [], fail: function (m) { this.error = m; finish(this); } };
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function txt(id) { var e = document.getElementById(id); return e ? e.textContent.trim() : ''; }
  function px(id) { return txt(id); }
  function ink(data) { var n = 0; for (var i = 0; i < data.length; i += 4) { if (data[i] !== 10 || data[i + 1] !== 13 || data[i + 2] !== 18) n++; } return n; }
  function snap() { return cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data; }
  function diff(a, b) { var n = 0; for (var i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 6 || Math.abs(a[i + 1] - b[i + 1]) > 6 || Math.abs(a[i + 2] - b[i + 2]) > 6) n++; } return n; }
  function sum(data) { var s = 0; for (var i = 0; i < data.length; i += 40) s += data[i] + data[i + 1] + data[i + 2]; return s; }
  function stat() { return txt('liveStat').replace(/\s+/g, ' '); }
  function num(re) { var m = stat().match(re); return m ? Number(m[1]) : null; }

  function finish(r) {
    r.ok = !r.error && r.priceValues >= 2 && r.framesDiffer >= 1 && r.pollsEnd > r.pollsStart;
    document.body.dataset.liveProof = JSON.stringify(r);
    console.log('LIVE_PROOF ' + JSON.stringify(r));
  }

  var r = { started: new Date().toISOString(), canvasCss: [cv.clientWidth, cv.clientHeight],
    canvasDev: [cv.width, cv.height] };

  (async function () {
    await sleep(1500);
    r.statAtStart = stat();
    r.pollsStart = num(/polls (\d+)/);
    r.okStart = num(/successful (\d+)/);
    if (!r.okStart) { await sleep(12000); r.statAfterWait = stat(); r.okStart = num(/successful (\d+)/); }
    if (!r.okStart) { r.fail('no successful pull after 13s - relay unreachable? ' + r.statAfterWait); return; }

    var f1 = snap();
    r.inkPixels = ink(f1);
    r.sum1 = sum(f1);
    r.last1 = px('liveLast');

    /* watch 24 seconds of natural polling: prices and canvas frames must both change */
    var prices = [r.last1], frameDiffs = [], prev = f1, checks = 0;
    for (var t = 0; t < 24; t++) {
      await sleep(1000);
      var p = px('liveLast');
      if (prices[prices.length - 1] !== p) prices.push(p);
      if (t % 4 === 3) { var f = snap(); frameDiffs.push(diff(prev, f)); prev = f; checks++; }
    }
    r.priceValues = prices.length;
    r.priceSeries = prices.slice(0, 8);
    r.frameDiffs = frameDiffs;
    r.framesDiffer = frameDiffs.filter(function (d) { return d > 200; }).length;
    r.pollsEnd = num(/polls (\d+)/);
    r.changes = num(/price changes (\d+)/);
    r.relay = (stat().match(/relay ([^ ]+)/) || [])[1];
    r.readouts = { last: px('liveLast'), chg: px('liveChg'), range: px('liveHi'), vol: px('liveVol'),
      piv: px('livePiv'), state: px('liveState'), meta: px('liveMeta') };
    r.tick = { sym: px('tickSym'), price: px('tickPrice'), age: px('tickAge'),
      sparkPts: (document.getElementById('tickLine').getAttribute('points') || '').split(' ').length };

    /* the symbol control must re-pull on a different venue */
    document.getElementById('liveSym').value = 'RELIANCE.NS';
    document.getElementById('liveIv').value = '5m';
    document.getElementById('liveGo').click();
    await sleep(14000);
    r.afterSymbolSwitch = { stat: stat(), meta: px('liveMeta'), last: px('liveLast'), piv: px('livePiv') };
    r.switchOk = /RELIANCE/.test(px('liveMeta')) && px('liveLast') !== '--';

    /* pause has to stop the timer, not just the repaint */
    document.getElementById('livePause').click();
    var paused = num(/polls (\d+)/);
    await sleep(13000);
    r.pauseHeld = num(/polls (\d+)/) === paused;
    r.pausedAt = paused;
    document.getElementById('livePause').click();

    /* layout must not overflow, and must survive a phone width */
    r.layout = { docScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      hudRight: Math.round(document.getElementById('tick').getBoundingClientRect().right),
      canvasW: cv.clientWidth, statWraps: document.getElementById('liveStat').getClientRects().length };
    try {
      await new Promise(function (resolve) {
        var fr = document.createElement('iframe');
        fr.style.cssText = 'width:390px;height:844px;border:0;position:fixed;left:0;top:0;z-index:9999;background:#000';
        fr.src = location.pathname + '?ph#' + (document.querySelectorAll('.slide.is-on').length ? 24 : 24);
        fr.onload = function () { setTimeout(function () {
          try {
            var d = fr.contentDocument, c = d.getElementById('liveCv');
            r.phone = { innerW: d.documentElement.clientWidth, scrollW: d.documentElement.scrollWidth,
              canvasW: c.clientWidth, canvasH: c.clientHeight,
              readoutCols: d.querySelectorAll('.live-read > div').length,
              firstReadoutW: Math.round(d.querySelector('.live-read > div').getBoundingClientRect().width),
              hudOverflow: Math.round(d.getElementById('tick').getBoundingClientRect().right) > d.documentElement.clientWidth };
          } catch (e) { r.phoneError = e.message; }
          fr.remove(); resolve();
        }, 4000); };
        document.body.appendChild(fr);
      });
    } catch (e) { r.phoneError = e.message; }

    finish(r);
  })().catch(function (e) { r.fail(String(e && e.message || e)); });
})();
