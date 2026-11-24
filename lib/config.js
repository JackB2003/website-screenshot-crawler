'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function parseInt10(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

/**
 * Reads configuration from environment variables. Defaults are chosen so a
 * plain `npm start` is safe: loopback only, no private-network scanning, and
 * conservative limits.
 */
function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: parseInt10(env.PORT, 3012, 1, 65535),
    authToken: env.AUTH_TOKEN || '',
    allowUnauthenticated: parseBool(env.ALLOW_UNAUTHENTICATED, false),
    allowPrivateUrls: parseBool(env.ALLOW_PRIVATE_URLS, false),
    allowInvalidCerts: parseBool(env.ALLOW_INVALID_CERTS, false),
    chromiumSandbox: parseBool(env.CHROMIUM_SANDBOX, true),
    trustProxy: parseBool(env.TRUST_PROXY, false),
    maxPagesLimit: parseInt10(env.MAX_PAGES_LIMIT, 200, 1, 2000),
    maxConcurrentScans: parseInt10(env.MAX_CONCURRENT_SCANS, 2, 1, 20),
    scansPerHourPerClient: parseInt10(env.SCANS_PER_HOUR_PER_CLIENT, 20, 1, 10000),
    maxStoredJobs: parseInt10(env.MAX_STORED_JOBS, 50, 1, 5000),
    jobTtlMs: parseInt10(env.JOB_TTL_HOURS, 24, 1, 720) * 60 * 60 * 1000,
    scanTimeoutMs: parseInt10(env.SCAN_TIMEOUT_MINUTES, 30, 1, 600) * 60 * 1000,
    screenshotsDir: env.SCREENSHOTS_DIR || '',
  };
}

module.exports = { loadConfig, isLoopbackHost, parseBool };
