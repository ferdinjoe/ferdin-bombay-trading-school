/* Structure Desk — shared helpers. No build step, no deps. */
window.SD = window.SD || {};
SD.U = (function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  /* ---- numbers ---- */
  function round(n, d) {
    if (!isFinite(n)) return n;
    const p = Math.pow(10, d);
    return Math.round(n * p) / p;
  }

  // Price precision adapts to magnitude: cheap contracts need more decimals.
  function priceDecimals(p) {
    const a = Math.abs(p);
    if (!isFinite(a) || a === 0) return 2;
    if (a < 1) return 4;
    if (a < 10) return 3;
    if (a < 1000) return 2;
    return 2;
  }

  function fmtPrice(p, decimals) {
    if (p === null || p === undefined || !isFinite(p)) return '—';
    const d = decimals === undefined ? priceDecimals(p) : decimals;
    return p.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtNum(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString('en-IN', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  }

  // Indian-locale crore/lakh phrasing; a NSE trader reads volumes this way.
  function fmtVolume(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e7) return round(v / 1e7, 2) + ' Cr';
    if (a >= 1e5) return round(v / 1e5, 2) + ' L';
    if (a >= 1e3) return round(v / 1e3, 1) + 'k';
    return String(Math.round(v));
  }

  function fmtPct(n, d) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    const s = n > 0 ? '+' : '';
    return s + round(n, d === undefined ? 2 : d) + '%';
  }

  /* ---- dates ---- */
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function tzOffsetMinutes(tzName, atDate) {
    // Intl-derived offset: sessions are defined in exchange-local time, not the viewer's.
    try {
      const d = atDate || new Date();
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      const parts = {};
      fmt.formatToParts(d).forEach(p => { parts[p.type] = p.value; });
      let hh = parseInt(parts.hour, 10);
      if (hh === 24) hh = 0;
      const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hh, +parts.minute, +parts.second);
      return Math.round((asUTC - Math.floor(d.getTime() / 1000) * 1000) / 60000);
    } catch (e) {
      return null;
    }
  }

  // Render an epoch in an exchange's own clock (bars arrive UTC-anchored).
  function inZone(date, tzName) {
    const off = tzOffsetMinutes(tzName, date);
    if (off === null) return date;
    return new Date(date.getTime() + off * 60000); // shifted so UTC getters read local wall clock
  }

  function fmtBarTime(ms, interval, tzName) {
    const raw = new Date(ms);
    const d = tzName ? inZone(raw, tzName) : raw;
    const intraday = /[mhw]$/.test(interval) && interval !== '1mo';
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mon = MONTHS[d.getUTCMonth()];
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    if (!interval || interval === '1d' || interval === '1wk' || interval === '1mo') return dd + ' ' + mon + ' ' + d.getUTCFullYear();
    return dd + ' ' + mon + ' ' + hh + ':' + mi + (intraday ? '' : '');
  }

  function fmtClock(ms, tzName) {
    const d = tzName ? inZone(new Date(ms), tzName) : new Date(ms);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
  }

  function dayKey(ms, tzName) {
    const d = tzName ? inZone(new Date(ms), tzName) : new Date(ms);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function isoDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---- misc ---- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function median(arr) {
    const a = arr.filter(v => isFinite(v)).slice().sort((x, y) => x - y);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem('sd:' + key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('sd:' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
    setMany(obj) { Object.keys(obj).forEach(k => store.set(k, obj[k])); }
  };

  let toastSeq = 0;
  function toast(msg, kind, ms) {
    const host = $('#toasts');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    host.appendChild(el);
    const id = ++toastSeq;
    setTimeout(() => {
      el.style.transition = 'opacity .3s';
      el.style.opacity = '0';
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, ms || 4200);
    return id;
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }

  function toCsv(rows) {
    if (!rows.length) return '';
    const cols = Object.keys(rows[0]);
    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n');
  }

  return {
    $, $$, on, round, priceDecimals, fmtPrice, fmtNum, fmtVolume, fmtPct,
    tzOffsetMinutes, inZone, fmtBarTime, fmtClock, dayKey, isoDate,
    clamp, median, escapeHtml, store, toast, download, toCsv
  };
})();
