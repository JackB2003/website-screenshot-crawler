'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuard, isBlockedIp, BlockedUrlError } = require('../lib/netguard');

test('blocks private, loopback, link-local and reserved IPv4 addresses', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255', '198.18.0.1',
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('allows ordinary public IPv4 addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('blocks private and reserved IPv6 addresses, including mapped and tunnelled IPv4', () => {
  for (const ip of [
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:169.254.169.254', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1',
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('allows public IPv6 addresses', () => {
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('2001:4860:4860::8888'), false);
});

test('fails closed on anything that is not an IP', () => {
  assert.equal(isBlockedIp('not-an-ip'), true);
  assert.equal(isBlockedIp(''), true);
});

function guardWith(map, opts = {}) {
  return createGuard({
    ...opts,
    lookup: async (host) => {
      if (!(host in map)) throw new Error('ENOTFOUND');
      return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
}

test('rejects non-http schemes and embedded credentials', async () => {
  const guard = guardWith({});
  await assert.rejects(guard.assertAllowedUrl('file:///etc/passwd'), BlockedUrlError);
  await assert.rejects(guard.assertAllowedUrl('ftp://example.com/'), BlockedUrlError);
  await assert.rejects(guard.assertAllowedUrl('javascript:alert(1)'), BlockedUrlError);
  await assert.rejects(guard.assertAllowedUrl('https://user:pass@example.com/'), BlockedUrlError);
  await assert.rejects(guard.assertAllowedUrl('not a url'), BlockedUrlError);
});

test('rejects IP literals that point at private ranges, in every spelling', async () => {
  const guard = guardWith({});
  for (const u of [
    'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/',
  ]) {
    await assert.rejects(guard.assertAllowedUrl(u), BlockedUrlError, u);
  }
});

test('rejects hostnames that resolve to a private address, even if one record is public', async () => {
  const guard = guardWith({
    'localtest.example': ['127.0.0.1'],
    'mixed.example': ['93.184.216.34', '10.0.0.8'],
    'good.example': ['93.184.216.34'],
  });
  await assert.rejects(guard.assertAllowedUrl('http://localtest.example/'), BlockedUrlError);
  await assert.rejects(guard.assertAllowedUrl('http://mixed.example/'), BlockedUrlError);
  const ok = await guard.assertAllowedUrl('https://good.example/path?x=1');
  assert.equal(ok.hostname, 'good.example');
});

test('rejects hostnames that do not resolve', async () => {
  await assert.rejects(guardWith({}).assertAllowedUrl('http://nope.example/'), /Could not resolve/);
});

test('the error for a blocked address explains how to opt in', async () => {
  await assert.rejects(guardWith({}).assertAllowedUrl('http://10.1.2.3/'), /ALLOW_PRIVATE_URLS/);
});

test('allowPrivate lets local addresses through but still enforces scheme rules', async () => {
  const guard = guardWith({}, { allowPrivate: true });
  const url = await guard.assertAllowedUrl('http://127.0.0.1:3000/');
  assert.equal(url.port, '3000');
  await assert.rejects(guard.assertAllowedUrl('file:///etc/passwd'), BlockedUrlError);
});
