'use strict';

const path = require('node:path');
const { getSitemapUrls } = require('./sitemap');

const NAV_TIMEOUT_MS = 30000;
const MAX_CAPTURE_WORKERS = 3;
const MENU_BUTTONS_TO_TRY = 10;
const USER_AGENT =
  'Mozilla/5.0 (compatible; WebsiteScreenshotCrawler/1.0; +https://github.com/JackB2003/website-screenshot-crawler)';

const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|svg|webp|bmp|css|js|mjs|json|xml|zip|rar|7z|gz|mp4|mp3|avi|mov|wmv|woff2?|ttf|eot|ico|csv|docx?|xlsx?|pptx?)(\?|#|$)/i;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 375, height: 812 },
};

function isCandidateLink(href, originHost) {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (u.host !== originHost) return false;
    return !SKIP_EXT.test(u.pathname);
  } catch {
    return false;
  }
}

function normalizeUrl(href) {
  const u = new URL(href);
  u.hash = '';
  let s = u.toString();
  if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

function slugFor(url, index, viewport) {
  let slug = 'page';
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '') || '/';
    slug =
      p === '/'
        ? 'home'
        : p
            .replace(/^\//, '')
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/(^-|-$)/g, '')
            .toLowerCase();
  } catch {
    // keep the fallback slug
  }
  slug = (slug || 'page').slice(0, 80);
  return `${String(index + 1).padStart(3, '0')}-${slug}--${viewport}.png`;
}

/** Short, single-line error text that is safe to show in the UI. */
function cleanError(err) {
  const first = String((err && err.message) || err).split('\n')[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

async function autoScroll(page) {
  await page
    .evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const distance = 400;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          total += distance;
          if (total >= document.body.scrollHeight - window.innerHeight || total > 20000) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
      });
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

function createScanner({ getBrowser, guard, config }) {
  function pushEvent(job, evt) {
    evt.ts = Date.now();
    job.events.push(evt);
    if (evt.type === 'done') job.status = 'done';
    if (evt.type === 'fatal') job.status = 'error';
    job.emitter.emit('event', evt);
  }

  async function newContext(job) {
    const browser = await getBrowser();
    const context = await browser.newContext({
      viewport: VIEWPORTS.desktop,
      ignoreHTTPSErrors: config.allowInvalidCerts,
      acceptDownloads: false,
      serviceWorkers: 'block',
      userAgent: USER_AGENT,
    });

    // Network checks happen in the guard proxy the browser is launched with (see browser.js).
    return context;
  }

  async function shoot(page, job, url, index, viewport) {
    await page.setViewportSize(VIEWPORTS[viewport]);
    const response = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    if (response && response.headers()['x-crawler-blocked']) {
      throw new Error('Blocked: the page points to a private or reserved address');
    }
    await guard.assertAllowedUrl(page.url()); // defence in depth: never capture an internal page
    await autoScroll(page);
    const file = slugFor(url, index, viewport);
    await page.screenshot({ path: path.join(job.dir, file), fullPage: true });
    return file;
  }

  async function captureFixed(urls, job, context, viewport) {
    let next = 0;
    const worker = async () => {
      while (next < urls.length && !job.aborted) {
        const index = next++;
        const url = urls[index];
        pushEvent(job, { type: 'visiting', url, viewport });
        const page = await context.newPage();
        try {
          const file = await shoot(page, job, url, index, viewport);
          job.captureCounter++;
          job.results.push({ url, file, viewport });
          pushEvent(job, { type: 'captured', url, file, viewport, index: job.captureCounter, total: job.totalCaptures });
        } catch (e) {
          job.captureCounter++;
          pushEvent(job, {
            type: 'error',
            url,
            viewport,
            message: cleanError(e),
            index: job.captureCounter,
            total: job.totalCaptures,
          });
        } finally {
          await page.close().catch(() => {});
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CAPTURE_WORKERS, urls.length) }, worker));
  }

  // Many modern sites hide real nav links inside dropdown buttons that only
  // render their <a> children once clicked. Click the first few visible
  // nav/header buttons to expand those menus and pick up what they reveal.
  async function discoverLinks(page, originHost) {
    const found = new Set();
    const collect = async () => {
      const links = await page.$$eval('a[href]', (as) => as.map((a) => a.href)).catch(() => []);
      links.forEach((l) => found.add(l));
    };
    await collect();

    const startUrl = page.url();
    const buttons = await page.$$('nav button, header button').catch(() => []);
    for (const btn of buttons.slice(0, MENU_BUTTONS_TO_TRY)) {
      try {
        if (!(await btn.boundingBox())) continue; // hidden, e.g. a mobile-only toggle
        await btn.click({ timeout: 1500 });
        await page.waitForTimeout(200);
        await collect();
        if (page.url() !== startUrl) {
          await page.goto(startUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS }).catch(() => {});
        }
      } catch {
        // ignore click failures (covered, animating, detached)
      }
    }
    return [...found].filter((l) => isCandidateLink(l, originHost));
  }

  async function crawlAndCapture(startUrl, job, context, origin, viewport) {
    const originHost = new URL(origin).host;
    const seen = new Set([normalizeUrl(startUrl)]);
    const queue = [startUrl];
    const captured = [];

    while (queue.length && captured.length < job.maxPages && !job.aborted) {
      const url = queue.shift();
      pushEvent(job, { type: 'visiting', url, viewport });
      const page = await context.newPage();
      try {
        const file = await shoot(page, job, url, captured.length, viewport);
        captured.push(url);
        job.captureCounter++;
        job.results.push({ url, file, viewport });
        pushEvent(job, { type: 'captured', url, file, viewport, index: job.captureCounter, total: job.totalCaptures });

        if (captured.length < job.maxPages) {
          let added = 0;
          for (const link of await discoverLinks(page, originHost)) {
            const key = normalizeUrl(link);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push(link);
            added++;
          }
          if (added) pushEvent(job, { type: 'discovered', count: queue.length, cumulative: true });
        }
      } catch (e) {
        job.captureCounter++;
        pushEvent(job, {
          type: 'error',
          url,
          viewport,
          message: cleanError(e),
          index: job.captureCounter,
          total: job.totalCaptures,
        });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return captured;
  }

  async function run(job) {
    const timer = setTimeout(() => {
      job.aborted = true;
      pushEvent(job, { type: 'status', message: 'Time limit reached, finishing with what was captured so far' });
    }, config.scanTimeoutMs);
    timer.unref();

    let context;
    try {
      pushEvent(job, { type: 'status', message: `Starting scan of ${job.url}` });
      const origin = new URL(job.url).origin;

      pushEvent(job, { type: 'status', message: 'Checking sitemap.xml...' });
      const sitemapUrls = await getSitemapUrls(origin, guard).catch(() => null);

      context = await newContext(job);
      const [firstViewport, ...restViewports] = job.viewports;
      let urls;

      if (sitemapUrls && sitemapUrls.length) {
        urls = sitemapUrls.slice(0, job.maxPages);
        pushEvent(job, { type: 'discovered', count: urls.length, total: sitemapUrls.length, source: 'sitemap' });
        job.totalCaptures = urls.length * job.viewports.length;
        pushEvent(job, { type: 'plan', pages: urls.length, viewports: job.viewports, totalCaptures: job.totalCaptures });
        await captureFixed(urls, job, context, firstViewport);
      } else {
        pushEvent(job, { type: 'status', message: 'No sitemap found, crawling links from the homepage...' });
        // The total is unknown until the discovery pass finishes, so the
        // plan event for a crawled site is sent after that pass.
        urls = await crawlAndCapture(job.url, job, context, origin, firstViewport);
        job.totalCaptures = urls.length * job.viewports.length;
        pushEvent(job, { type: 'plan', pages: urls.length, viewports: job.viewports, totalCaptures: job.totalCaptures });
      }

      for (const viewport of restViewports) {
        await captureFixed(urls, job, context, viewport);
      }

      pushEvent(job, { type: 'done', captured: job.results.length, pages: urls.length, viewports: job.viewports });
    } finally {
      clearTimeout(timer);
      if (context) await context.close().catch(() => {});
    }
  }

  return { run, pushEvent };
}

module.exports = { createScanner, VIEWPORTS, normalizeUrl, slugFor, isCandidateLink };
