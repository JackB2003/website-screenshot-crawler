'use strict';

// Tiny static server for the sample site, so you can try the crawler right away.
// Usage: npm run demo-site   (serves http://127.0.0.1:4100)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function createDemoServer() {
  return http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const name = pathname === '/' ? 'index' : pathname.replace(/^\/|\/$/g, '');
    const candidates = [name, `${name}.html`].map((n) => path.join(ROOT, n));
    const file = candidates.find((f) => f.startsWith(ROOT + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  const port = parseInt(process.env.DEMO_PORT, 10) || 4100;
  createDemoServer().listen(port, '127.0.0.1', () => console.log(`Demo site on http://127.0.0.1:${port}`));
}

module.exports = { createDemoServer };
