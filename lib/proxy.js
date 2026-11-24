'use strict';

const http = require('node:http');
const net = require('node:net');

/**
 * A small forward proxy that Chromium is forced through. It is the one place
 * that sees every connection the browser makes: page loads, redirects,
 * subresources, iframes, workers and WebSockets. Each destination is resolved
 * and checked here, and the connection is made to the checked address, so
 * neither a redirect nor a DNS trick can reach an internal service.
 *
 * HTTPS is tunnelled (CONNECT) without being decrypted.
 */

const HOP_HEADERS = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade',
]);
const IDLE_TIMEOUT_MS = 60000;

function parseHostPort(target, defaultPort) {
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) || /^([^:]+)(?::(\d+))?$/.exec(target);
  if (!m) return null;
  return { host: m[1], port: m[2] ? parseInt(m[2], 10) : defaultPort };
}

function createGuardProxy(guard) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:') throw new Error('unsupported');
    } catch {
      res.writeHead(400);
      return res.end('Bad proxy request');
    }
    let target;
    try {
      target = await guard.resolveAllowed(url.hostname);
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'X-Crawler-Blocked': '1' });
      return res.end('Blocked by the crawler network guard');
    }

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(name)) headers[name] = value;
    }
    const upstream = http.request(
      {
        host: target.address,
        family: target.family,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        timeout: IDLE_TIMEOUT_MS,
      },
      (up) => {
        const out = {};
        for (const [name, value] of Object.entries(up.headers)) {
          if (!HOP_HEADERS.has(name)) out[name] = value;
        }
        res.writeHead(up.statusCode || 502, out);
        up.pipe(res);
      }
    );
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const parsed = parseHostPort(req.url, 443);
    if (!parsed) return clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    let target;
    try {
      target = await guard.resolveAllowed(parsed.host);
    } catch {
      return clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
    const upstream = net.connect({ host: target.address, family: target.family, port: parsed.port }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(IDLE_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
  });

  return {
    /** Starts listening on a random loopback port and returns its URL. */
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
      });
    },
    stop() {
      server.closeAllConnections();
      server.close();
    },
  };
}

module.exports = { createGuardProxy };
