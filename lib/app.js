'use strict';

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { ZipArchive } = require('archiver');
const { BlockedUrlError } = require('./netguard');
const { createRateLimiter } = require('./ratelimit');
const { createAuth } = require('./auth');
const { VIEWPORTS } = require('./scanner');

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHOT_FILE = /^\d{3}-[a-z0-9-]+--(desktop|tablet|mobile)\.png$/;
const DEFAULT_MAX_PAGES = 50;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
}

/** Turns what a user typed into a full URL string, or throws BlockedUrlError. */
function normalizeInput(raw) {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (!/^https?:\/\//i.test(text)) throw new BlockedUrlError('Only http and https URLs can be scanned');
    return text;
  }
  return `https://${text}`;
}

function createApp({ config, scanner, guard }) {
  const app = express();
  const jobs = new Map();
  const limiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: config.scansPerHourPerClient });
  const publicDir = path.join(__dirname, '..', 'public');
  const screenshotsRoot = config.screenshotsDir || path.join(__dirname, '..', 'screenshots');

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);
  app.use(securityHeaders);
  app.use(createAuth(config.authToken));
  app.use(express.json({ limit: '10kb' }));
  app.use(express.static(publicDir, { dotfiles: 'ignore', index: 'index.html' }));

  app.get('/api/config', (req, res) => {
    res.json({
      maxPagesLimit: config.maxPagesLimit,
      defaultMaxPages: Math.min(DEFAULT_MAX_PAGES, config.maxPagesLimit),
      allowPrivateUrls: config.allowPrivateUrls,
    });
  });

  function runningCount() {
    let n = 0;
    for (const job of jobs.values()) if (job.status === 'running') n++;
    return n;
  }

  function removeJob(id) {
    const job = jobs.get(id);
    if (!job) return;
    fs.rm(job.dir, { recursive: true, force: true }, () => {});
    jobs.delete(id);
  }

  function evictOldJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.status !== 'running' && now - job.createdAt > config.jobTtlMs) removeJob(id);
    }
    while (jobs.size > config.maxStoredJobs) {
      const oldest = [...jobs.values()].find((j) => j.status !== 'running');
      if (!oldest) break;
      removeJob(oldest.id);
    }
  }

  app.post('/api/scan', async (req, res) => {
    const body = req.body || {};
    if (!body.url || typeof body.url !== 'string' || body.url.length > 2048) {
      return res.status(400).json({ error: 'URL is required' });
    }

    let url;
    try {
      url = (await guard.assertAllowedUrl(normalizeInput(body.url))).toString();
    } catch (err) {
      if (err instanceof BlockedUrlError) return res.status(400).json({ error: err.message });
      throw err;
    }

    const limit = limiter.take(req.ip);
    if (!limit.ok) {
      res.set('Retry-After', String(limit.retryAfterSec));
      return res.status(429).json({ error: 'Too many scans from this address. Try again later.' });
    }
    if (runningCount() >= config.maxConcurrentScans) {
      res.set('Retry-After', '30');
      return res.status(429).json({ error: 'The server is busy with other scans. Try again in a moment.' });
    }

    const maxPages = Math.min(Math.max(parseInt(body.maxPages, 10) || DEFAULT_MAX_PAGES, 1), config.maxPagesLimit);
    let viewports = Array.isArray(body.viewports) ? body.viewports.filter((v) => typeof v === 'string' && VIEWPORTS[v]) : [];
    viewports = viewports.length ? [...new Set(viewports)] : ['desktop'];

    const id = crypto.randomUUID();
    const dir = path.join(screenshotsRoot, id);
    fs.mkdirSync(dir, { recursive: true });

    const job = {
      id,
      url,
      maxPages,
      viewports,
      dir,
      events: [],
      emitter: new EventEmitter(),
      status: 'running',
      aborted: false,
      results: [],
      captureCounter: 0,
      totalCaptures: 0,
      createdAt: Date.now(),
    };
    job.emitter.setMaxListeners(50);
    jobs.set(id, job);
    evictOldJobs();
    res.json({ jobId: id });

    scanner.run(job).catch((err) => {
      scanner.pushEvent(job, { type: 'fatal', message: String((err && err.message) || err).split('\n')[0].slice(0, 200) });
    });
  });

  function findJob(req, res) {
    const job = JOB_ID.test(req.params.id) ? jobs.get(req.params.id) : null;
    if (!job) res.status(404).json({ error: 'Scan not found or expired' });
    return job;
  }

  app.get('/api/scan/:id/events', (req, res) => {
    const job = findJob(req, res);
    if (!job) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    for (const evt of job.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    if (job.status !== 'running') return res.end();

    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    const cleanup = () => {
      clearInterval(heartbeat);
      job.emitter.off('event', onEvent);
    };
    const onEvent = (evt) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
      if (evt.type === 'done' || evt.type === 'fatal') {
        cleanup();
        res.end();
      }
    };
    job.emitter.on('event', onEvent);
    req.on('close', cleanup);
  });

  app.get('/api/scan/:id/shots/:file', (req, res) => {
    const job = findJob(req, res);
    if (!job) return;
    if (!SHOT_FILE.test(req.params.file)) return res.status(400).json({ error: 'Invalid file name' });
    res.sendFile(req.params.file, { root: job.dir, dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  app.get('/api/scan/:id/zip', (req, res) => {
    const job = findJob(req, res);
    if (!job) return;
    res.attachment(`screenshots-${job.id}.zip`);
    const archive = new ZipArchive();
    archive.on('error', (err) => {
      console.error('zip error', err);
      res.end();
    });
    archive.pipe(res);
    archive.directory(job.dir, false);
    archive.finalize();
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  const sweep = setInterval(evictOldJobs, 60 * 60 * 1000);
  sweep.unref();

  function shutdown() {
    clearInterval(sweep);
    limiter.stop();
  }

  return { app, jobs, shutdown };
}

module.exports = { createApp, normalizeInput };
