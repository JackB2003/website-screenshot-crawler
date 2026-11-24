'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../lib/config');
const { createGuard } = require('../lib/netguard');
const { createApp } = require('../lib/app');

function startApp(envOverrides = {}, scannerImpl) {
  const config = loadConfig({ SCREENSHOTS_DIR: require('node:os').tmpdir() + '/wsc-test', ...envOverrides });
  const guard = createGuard({
    allowPrivate: config.allowPrivateUrls,
    lookup: async (host) => [{ address: host === 'public.example' ? '93.184.216.34' : '127.0.0.1', family: 4 }],
  });
  const scanner = scannerImpl || { run: () => new Promise(() => {}), pushEvent() {} };
  const { app, shutdown } = createApp({ config, scanner, guard });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => {
          shutdown();
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

const post = (base, body, headers = {}) =>
  fetch(`${base}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('serves the UI with security headers', async () => {
  const s = await startApp();
  try {
    const res = await fetch(`${s.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-powered-by'), null);
  } finally {
    s.close();
  }
});

test('rejects missing, oversize and non-web URLs', async () => {
  const s = await startApp();
  try {
    assert.equal((await post(s.base, {})).status, 400);
    assert.equal((await post(s.base, { url: 'x'.repeat(3000) })).status, 400);
    assert.equal((await post(s.base, { url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await post(s.base, { url: 'ftp://public.example/' })).status, 400);
  } finally {
    s.close();
  }
});

test('blocks internal addresses by default and says how to allow them', async () => {
  const s = await startApp();
  try {
    for (const url of ['http://localhost:3000', '127.0.0.1', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.1']) {
      const res = await post(s.base, { url });
      assert.equal(res.status, 400, url);
      assert.match((await res.json()).error, /ALLOW_PRIVATE_URLS/);
    }
  } finally {
    s.close();
  }
});

test('allows local addresses when ALLOW_PRIVATE_URLS is on', async () => {
  const s = await startApp({ ALLOW_PRIVATE_URLS: 'true' });
  try {
    const res = await post(s.base, { url: 'http://localhost:3000' });
    assert.equal(res.status, 200);
    assert.match((await res.json()).jobId, /^[0-9a-f-]{36}$/);
  } finally {
    s.close();
  }
});

test('caps max pages and ignores unknown viewports', async () => {
  let seen;
  const s = await startApp({ MAX_PAGES_LIMIT: '10' }, { run: async (job) => { seen = job; }, pushEvent() {} });
  try {
    const res = await post(s.base, { url: 'public.example', maxPages: 9999, viewports: ['mobile', 'bogus', 'mobile'] });
    assert.equal(res.status, 200);
    assert.equal(seen.maxPages, 10);
    assert.deepEqual(seen.viewports, ['mobile']);
    assert.equal(seen.url, 'https://public.example/');
  } finally {
    s.close();
  }
});

test('limits concurrent scans', async () => {
  const s = await startApp({ MAX_CONCURRENT_SCANS: '1' });
  try {
    assert.equal((await post(s.base, { url: 'public.example' })).status, 200);
    const second = await post(s.base, { url: 'public.example' });
    assert.equal(second.status, 429);
    assert.ok(second.headers.get('retry-after'));
  } finally {
    s.close();
  }
});

test('rate limits scans per client', async () => {
  const s = await startApp({ SCANS_PER_HOUR_PER_CLIENT: '2', MAX_CONCURRENT_SCANS: '10' });
  try {
    assert.equal((await post(s.base, { url: 'public.example' })).status, 200);
    assert.equal((await post(s.base, { url: 'public.example' })).status, 200);
    assert.equal((await post(s.base, { url: 'public.example' })).status, 429);
  } finally {
    s.close();
  }
});

test('requires the token when AUTH_TOKEN is set', async () => {
  const s = await startApp({ AUTH_TOKEN: 'correct horse battery staple' });
  try {
    const none = await fetch(`${s.base}/`);
    assert.equal(none.status, 401);
    assert.match(none.headers.get('www-authenticate'), /Basic/);
    const wrong = await fetch(`${s.base}/`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);
    const bearer = await fetch(`${s.base}/`, { headers: { Authorization: 'Bearer correct horse battery staple' } });
    assert.equal(bearer.status, 200);
    const basic = Buffer.from('anyone:correct horse battery staple').toString('base64');
    assert.equal((await fetch(`${s.base}/api/config`, { headers: { Authorization: `Basic ${basic}` } })).status, 200);
    assert.equal((await post(s.base, { url: 'public.example' })).status, 401);
  } finally {
    s.close();
  }
});

test('file routes reject traversal and unknown jobs', async () => {
  const s = await startApp();
  try {
    assert.equal((await fetch(`${s.base}/api/scan/not-a-uuid/zip`)).status, 404);
    assert.equal((await fetch(`${s.base}/api/scan/00000000-0000-4000-8000-000000000000/events`)).status, 404);
    const id = (await (await post(s.base, { url: 'public.example' })).json()).jobId;
    assert.equal((await fetch(`${s.base}/api/scan/${id}/shots/..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/scan/${id}/shots/evil.png`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/scan/${id}/shots/..%5C..%5Cpasswd`)).status, 400);
    assert.equal((await fetch(`${s.base}/api/scan/${id}/shots/001-home--desktop.png`)).status, 404);
  } finally {
    s.close();
  }
});

test('rejects malformed JSON without leaking details', async () => {
  const s = await startApp();
  try {
    const res = await fetch(`${s.base}/api/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
  } finally {
    s.close();
  }
});
