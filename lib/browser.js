'use strict';

const { chromium } = require('playwright');
const { createGuardProxy } = require('./proxy');

/**
 * Owns the single shared Chromium. Unless private scanning was enabled, the
 * browser is forced through the guard proxy, so every request it makes is
 * checked (see proxy.js). `--proxy-bypass-list=<-loopback>` makes Chromium
 * send even localhost traffic through the proxy instead of skipping it.
 */
function createBrowserManager({ config, guard }) {
  let browserPromise;
  let proxy;

  async function launch() {
    const options = { headless: true, chromiumSandbox: config.chromiumSandbox };
    if (!config.allowPrivateUrls) {
      proxy = proxy || createGuardProxy(guard);
      options.proxy = { server: await proxy.start() };
      options.args = ['--proxy-bypass-list=<-loopback>'];
    }
    try {
      const browser = await chromium.launch(options);
      browser.on('disconnected', () => {
        browserPromise = undefined;
        if (proxy) proxy.stop();
        proxy = undefined;
      });
      return browser;
    } catch (err) {
      if (proxy) proxy.stop();
      proxy = undefined;
      console.error(err.message);
      throw new Error(
        'Could not start Chromium. Run "npx playwright install --only-shell chromium". ' +
          'If the log mentions sandboxing, set CHROMIUM_SANDBOX=false (see the README).'
      );
    }
  }

  return {
    getBrowser() {
      if (!browserPromise) {
        browserPromise = launch();
        browserPromise.catch(() => {
          browserPromise = undefined;
        });
      }
      return browserPromise;
    },
    async close() {
      if (!browserPromise) return;
      const pending = browserPromise;
      browserPromise = undefined;
      await (await pending.catch(() => null))?.close().catch(() => {});
      if (proxy) proxy.stop();
      proxy = undefined;
    },
  };
}

module.exports = { createBrowserManager };
