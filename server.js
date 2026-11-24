'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, isLoopbackHost } = require('./lib/config');
const { createGuard } = require('./lib/netguard');
const { createScanner } = require('./lib/scanner');
const { createBrowserManager } = require('./lib/browser');
const { createApp } = require('./lib/app');

const config = loadConfig();

// Refuse to expose an unauthenticated crawler to the network by accident.
if (!isLoopbackHost(config.host) && !config.authToken && !config.allowUnauthenticated) {
  console.error(
    `Refusing to listen on ${config.host} without authentication.\n` +
      'Set AUTH_TOKEN to a long random value (for example: openssl rand -hex 24),\n' +
      'or set ALLOW_UNAUTHENTICATED=true if something else in front of this app handles access.'
  );
  process.exit(1);
}
if (config.allowPrivateUrls && !isLoopbackHost(config.host) && !config.authToken) {
  console.warn('Warning: ALLOW_PRIVATE_URLS is on and the app is reachable from the network without a token.');
}

const guard = createGuard({ allowPrivate: config.allowPrivateUrls });
const browsers = createBrowserManager({ config, guard });
const scanner = createScanner({ getBrowser: browsers.getBrowser, guard, config });
const { app, shutdown } = createApp({ config, scanner, guard });

fs.mkdirSync(config.screenshotsDir || path.join(__dirname, 'screenshots'), { recursive: true });

const server = app.listen(config.port, config.host, () => {
  console.log(`Website Screenshot Crawler listening on http://${config.host}:${config.port}`);
  if (config.allowPrivateUrls) console.log('Private and local addresses are allowed (ALLOW_PRIVATE_URLS=true).');
});

async function stop() {
  shutdown();
  server.close();
  await browsers.close();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
