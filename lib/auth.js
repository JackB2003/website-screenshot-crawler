'use strict';

const crypto = require('node:crypto');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

/**
 * Optional shared-token protection. When AUTH_TOKEN is set, every request must
 * carry it as the password of HTTP Basic auth (any username) or as a Bearer
 * token. Browsers show their own login prompt and then remember it, so the
 * web UI, the event stream and image requests all keep working.
 */
function createAuth(token) {
  if (!token) return (req, res, next) => next();
  const expected = digest(token);

  function supplied(header) {
    if (!header) return '';
    const space = header.indexOf(' ');
    const scheme = space === -1 ? header : header.slice(0, space);
    const value = space === -1 ? '' : header.slice(space + 1);
    if (/^bearer$/i.test(scheme)) return value;
    if (/^basic$/i.test(scheme)) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      return decoded.slice(decoded.indexOf(':') + 1);
    }
    return '';
  }

  return (req, res, next) => {
    const given = supplied(req.headers.authorization);
    if (given && crypto.timingSafeEqual(digest(given), expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Website Screenshot Crawler", charset="UTF-8"');
    return res.status(401).json({ error: 'Authentication required' });
  };
}

module.exports = { createAuth };
