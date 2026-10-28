/* Optional local static server — the app also opens straight from file://.
   node tools/serve.js [port] [rootDir]   → http://localhost:8931/
   rootDir defaults to this app's folder; the lectures launcher passes the repo root so the
   course decks are served too (they need an http:// origin for the live quote relays). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 8931);
const root = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const index = fs.existsSync(path.join(root, 'index.html')) ? 'index.html' : 'lectures/week1-day2-dow-theory.html';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.csv': 'text/csv', '.bat': 'text/plain' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || index;
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store' });
    res.end(buf);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('Something already listens on ' + port + ' -- nothing to do here.');
    process.exit(0);
  }
  throw err;
});

server.listen(port, () => console.log(root + ' -> http://localhost:' + port + '/'));
