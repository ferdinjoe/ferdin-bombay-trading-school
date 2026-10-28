/* Refreshes data/nse-listed.csv — the offline ticker universe the suggestion dropdown is seeded from.
   node tools/refresh-tickers.js
   NSE publishes this file without a key and without a bot wall, so this is the one market universe
   that can ship inside the app. US and Singapore listings are learned from the search endpoint at
   run time instead (tools cannot reach a bulk file for them without a crumb). */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = 'https://archives.nseindia.com/content/equities/EQUITY_L.csv';
const OUT = path.join(__dirname, '..', 'data', 'nse-listed.csv');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

(async () => {
  let body;
  try {
    const res = await fetch(SRC, { headers: { 'User-Agent': UA, 'Accept': 'text/csv,*/*' }, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    body = await res.text();
  } catch (e) {
    console.error('NSE did not answer (' + e.message + '). Keeping the file that is already on disk.');
    process.exit(1);
  }
  const lines = body.split(/\r?\n/).filter(l => l.trim());
  const bad = lines.filter(l => l.split(',').length !== 8).length;
  const rows = lines.length - 1;
  if (!/^SYMBOL,NAME OF COMPANY/i.test(lines[0]) || rows < 1000 || bad) {
    console.error('Unexpected payload (header wrong, ' + rows + ' rows, ' + bad + ' malformed). Refusing to overwrite.');
    process.exit(1);
  }
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log('wrote ' + rows + ' listed equities to ' + path.relative(process.cwd(), OUT));
})();
