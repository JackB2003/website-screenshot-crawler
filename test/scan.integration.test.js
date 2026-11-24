'use strict';

// End-to-end test against a real headless Chromium and the bundled demo site.
// Skipped automatically when Chromium is not installed (npx playwright install chromium).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config');
const { createGuard } = require('../lib/netguard');
const { createScanner } = require('../lib/scanner');
const { createBrowserManager } = require('../lib/browser');
const { createApp } = require('../lib/app');
const { createDemoServer } = require('../examples/demo-site/serve');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** Starts the real browser path (including the guard proxy). Returns null when Chromium is missing. */
async function startBrowser(config, guard) {
  const manager = createBrowserManager({ config, guard });
  try {
    await manager.getBrowser();
    return manager;
  } catch {
    return null;
  }
}

async function waitForDone(base, jobId) {
  const res = await fetch(`${base}/api/scan/${jobId}/events`);
  const text = await res.text(); // the stream ends when the scan finishes
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

test('crawls the demo site and captures every page at two viewports', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-int-'));
  const config = loadConfig({ ALLOW_PRIVATE_URLS: 'true', SCREENSHOTS_DIR: dir, CHROMIUM_SANDBOX: process.env.CHROMIUM_SANDBOX });
  const guard = createGuard({ allowPrivate: true });
  const browsers = await startBrowser(config, guard);
  if (!browsers) return t.skip('Chromium is not installed');
  const demo = createDemoServer();
  const demoPort = await listen(demo);
  const scanner = createScanner({ getBrowser: browsers.getBrowser, guard, config });
  const { app, shutdown } = createApp({ config, scanner, guard });
  const api = app.listen(0, '127.0.0.1');
  await new Promise((r) => api.once('listening', r));
  const base = `http://127.0.0.1:${api.address().port}`;

  try {
    const res = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `http://127.0.0.1:${demoPort}/`, maxPages: 20, viewports: ['desktop', 'mobile'] }),
    });
    assert.equal(res.status, 200);
    const { jobId } = await res.json();
    const events = await waitForDone(base, jobId);

    const done = events.find((e) => e.type === 'done');
    assert.ok(done, 'scan finished');
    assert.equal(done.pages, 7, 'home, menu, about, journal, visit and two articles');
    assert.equal(done.captured, 14);
    assert.equal(events.filter((e) => e.type === 'error').length, 0);

    const files = fs.readdirSync(path.join(dir, jobId));
    assert.equal(files.length, 14);
    assert.ok(files.includes('001-home--desktop.png'));
    assert.ok(files.some((f) => f.endsWith('--mobile.png')));
    const png = fs.readFileSync(path.join(dir, jobId, '001-home--desktop.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    const shot = await fetch(`${base}/api/scan/${jobId}/shots/001-home--desktop.png`);
    assert.equal(shot.status, 200);
    assert.equal(shot.headers.get('content-type'), 'image/png');

    const zip = await fetch(`${base}/api/scan/${jobId}/zip`);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.equal((await zip.arrayBuffer()).byteLength > 10000, true);
  } finally {
    shutdown();
    api.closeAllConnections();
    api.close();
    demo.close();
    await browsers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the browser itself refuses private addresses when private scanning is off', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-int-'));
  const config = loadConfig({ SCREENSHOTS_DIR: dir, CHROMIUM_SANDBOX: process.env.CHROMIUM_SANDBOX });
  const guard = createGuard({ allowPrivate: false });
  const browsers = await startBrowser(config, guard);
  if (!browsers) return t.skip('Chromium is not installed');
  const demo = createDemoServer();
  const demoPort = await listen(demo);
  const scanner = createScanner({ getBrowser: browsers.getBrowser, guard, config });
  const { EventEmitter } = require('node:events');
  const job = {
    id: 'x', url: `http://127.0.0.1:${demoPort}/`, maxPages: 5, viewports: ['desktop'], dir,
    events: [], emitter: new EventEmitter(), status: 'running', aborted: false, results: [],
    captureCounter: 0, totalCaptures: 0, createdAt: Date.now(),
  };

  try {
    await scanner.run(job);
    assert.equal(job.results.length, 0, 'nothing was captured');
    const err = job.events.find((e) => e.type === 'error');
    assert.ok(err, 'the blocked request was reported as an error');
    assert.match(err.message, /blocked/i);
  } finally {
    demo.close();
    await browsers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('redirects and subresources that point at a blocked address are not followed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-int-'));
  const config = loadConfig({ SCREENSHOTS_DIR: dir, CHROMIUM_SANDBOX: process.env.CHROMIUM_SANDBOX });
  const guard = createGuard({ allowPrivate: false, isBlocked: (ip) => ip === '127.0.0.1' });
  const browsers = await startBrowser(config, guard);
  if (!browsers) return t.skip('Chromium is not installed');
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  const demo = createDemoServer();
  const demoPort = await listen(demo);

  // A "public" server on 127.0.0.2 that redirects to the "internal" demo site on 127.0.0.1.
  const hits = [];
  const redirector = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<h1>public page</h1><img src="http://127.0.0.1:${demoPort}/style.css?probe=img">`);
    }
    res.writeHead(302, { Location: `http://127.0.0.1:${demoPort}/` });
    res.end();
  });
  const redirPort = await new Promise((resolve) => redirector.listen(0, '127.0.0.2', () => resolve(redirector.address().port)));
  demo.on('request', (req) => hits.push(req.url));

  const scanner = createScanner({ getBrowser: browsers.getBrowser, guard, config });
  const newJob = (url) => ({
    id: 'x', url, maxPages: 1, viewports: ['desktop'], dir, events: [], emitter: new EventEmitter(),
    status: 'running', aborted: false, results: [], captureCounter: 0, totalCaptures: 0, createdAt: Date.now(),
  });

  try {
    const redirected = newJob(`http://127.0.0.2:${redirPort}/`);
    await scanner.run(redirected);
    assert.equal(redirected.results.length, 0, 'the redirect to the blocked address was not captured');
    assert.deepEqual(hits.filter((u) => u === '/'), [], 'the blocked address never received the redirected request');

    const withImage = newJob(`http://127.0.0.2:${redirPort}/page`);
    await scanner.run(withImage);
    assert.equal(withImage.results.length, 1, 'the public page itself is captured');
    assert.deepEqual(hits.filter((u) => u.includes('probe=img')), [], 'the blocked subresource was never requested');
  } finally {
    redirector.close();
    demo.close();
    await browsers.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
