'use strict';

/** Fixed-window request counter keyed by client address. In memory, no dependencies. */
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.min(windowMs, 60 * 1000));
  cleanup.unref();

  return {
    /** Records a hit. Returns { ok, retryAfterSec }. */
    take(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      if (entry.count >= max) {
        return { ok: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
      }
      entry.count++;
      return { ok: true, retryAfterSec: 0 };
    },
    stop() {
      clearInterval(cleanup);
    },
  };
}

module.exports = { createRateLimiter };
