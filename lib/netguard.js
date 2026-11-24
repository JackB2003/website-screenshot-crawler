'use strict';

const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

/**
 * Network guard: stops the crawler from being used to reach internal
 * services (SSRF). Every URL the tool touches is checked, both the one a user
 * submits and every request the browser makes while rendering a page.
 */

const blocked = new net.BlockList();

const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
];

// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are checked against the IPv4 list.
const BLOCKED_V6 = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

for (const [addr, prefix] of BLOCKED_V4) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of BLOCKED_V6) blocked.addSubnet(addr, prefix, 'ipv6');

class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** True when the literal IP address is private, loopback, link-local or otherwise reserved. */
function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (!family) return true; // not an IP at all: fail closed
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

const PRIVATE_HINT = 'Set ALLOW_PRIVATE_URLS=true to scan local or private sites on your own machine.';

function blockedMessage(host) {
  return `Blocked: ${host} points to a private or reserved address. ${PRIVATE_HINT}`;
}

/**
 * Creates a guard. `lookup` and `isBlocked` can be replaced in tests; by
 * default it uses the system resolver and the built-in address list.
 */
function createGuard({ allowPrivate = false, lookup = dns.promises.lookup, isBlocked = isBlockedIp } = {}) {
  const cache = new Map();
  const CACHE_MS = 5000;

  async function resolveHost(host) {
    const hit = cache.get(host);
    if (hit && hit.expires > Date.now()) return hit.addresses;
    let results;
    try {
      results = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new BlockedUrlError(`Could not resolve host: ${host}`);
    }
    const addresses = results.map((r) => r.address);
    if (!addresses.length) throw new BlockedUrlError(`Could not resolve host: ${host}`);
    cache.set(host, { addresses, expires: Date.now() + CACHE_MS });
    if (cache.size > 500) cache.clear();
    return addresses;
  }

  /** Throws BlockedUrlError unless the URL is safe to request. Returns the parsed URL. */
  async function assertAllowedUrl(input) {
    let url;
    try {
      url = new URL(input);
    } catch {
      throw new BlockedUrlError('That does not look like a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedUrlError('Only http and https URLs can be scanned');
    }
    if (url.username || url.password) {
      throw new BlockedUrlError('URLs with embedded credentials are not allowed');
    }
    if (allowPrivate) return url;

    const host = stripBrackets(url.hostname);
    if (net.isIP(host)) {
      if (isBlocked(host)) throw new BlockedUrlError(blockedMessage(host));
      return url;
    }
    const addresses = await resolveHost(host);
    if (addresses.some(isBlocked)) throw new BlockedUrlError(blockedMessage(host));
    return url;
  }

  /**
   * Resolves a hostname for an outgoing connection and returns one address
   * that has been checked. Connect to this address, not to the hostname, so a
   * DNS answer cannot change between the check and the connection.
   */
  async function resolveAllowed(hostname) {
    const host = stripBrackets(hostname);
    if (net.isIP(host)) {
      if (!allowPrivate && isBlocked(host)) throw new BlockedUrlError(blockedMessage(host));
      return { address: host, family: net.isIP(host) };
    }
    const addresses = await resolveHost(host);
    if (!allowPrivate && addresses.some(isBlocked)) throw new BlockedUrlError(blockedMessage(host));
    return { address: addresses[0], family: net.isIP(addresses[0]) };
  }

  /**
   * A `lookup` function for http(s).request that refuses private addresses.
   * Because the connection uses the address validated here, DNS rebinding
   * cannot swap in an internal IP between the check and the connect.
   */
  function guardedLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!allowPrivate && addresses.some((a) => isBlocked(a.address))) {
        return callback(new BlockedUrlError(blockedMessage(hostname)));
      }
      if (options && options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  }

  /**
   * Minimal GET that validates every redirect hop, pins the validated IP,
   * and caps response size. Used for sitemap files.
   */
  async function safeGet(input, { timeoutMs = 8000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5 } = {}) {
    let current = input;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const url = await assertAllowedUrl(current);
      const res = await requestOnce(url, { timeoutMs, maxBytes, guardedLookup });
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = new URL(res.location, url).toString();
        continue;
      }
      return res;
    }
    throw new Error('Too many redirects');
  }

  return { assertAllowedUrl, resolveAllowed, guardedLookup, safeGet };
}

function requestOnce(url, { timeoutMs, maxBytes, guardedLookup }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(
      url,
      {
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'WebsiteScreenshotCrawler/1.0', Accept: 'application/xml,text/xml,*/*' },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: '' });
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}

module.exports = { createGuard, isBlockedIp, BlockedUrlError };
