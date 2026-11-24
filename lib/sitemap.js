'use strict';

const MAX_CHILD_SITEMAPS = 20;

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Returns every <loc> value in a sitemap or sitemap index document. */
function extractLocs(xml) {
  return [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1].trim()));
}

function sameHost(url, host) {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/**
 * Looks for /sitemap.xml and /sitemap_index.xml (including nested indexes) and
 * returns the page URLs on the same host, or null when no sitemap is usable.
 */
async function getSitemapUrls(origin, guard) {
  const host = new URL(origin).host;
  for (const candidate of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
    try {
      const res = await guard.safeGet(candidate);
      if (res.status < 200 || res.status >= 300) continue;
      let urls = [];
      if (/<sitemapindex/i.test(res.body)) {
        for (const child of extractLocs(res.body).filter((l) => sameHost(l, host)).slice(0, MAX_CHILD_SITEMAPS)) {
          try {
            const cr = await guard.safeGet(child);
            if (cr.status >= 200 && cr.status < 300) urls.push(...extractLocs(cr.body));
          } catch {
            // skip an unreachable child sitemap
          }
        }
      } else if (/<urlset/i.test(res.body) || /<loc>/i.test(res.body)) {
        urls = extractLocs(res.body);
      }
      urls = [...new Set(urls.filter((u) => sameHost(u, host)))];
      if (urls.length) return urls;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

module.exports = { extractLocs, getSitemapUrls };
