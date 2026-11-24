#!/usr/bin/env node
'use strict';

// One-command launcher: sets up Chromium on first run, starts the server on a
// free port and opens the page in your browser.
//   npx github:JackB2003/website-screenshot-crawler

const { spawnSync, spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const pkg = require('../package.json');

const HELP = `Website Screenshot Crawler ${pkg.version}

Usage: website-screenshot-crawler [options]

Options:
  --port <n>        Port to listen on (default 3012, or the next free one)
  --allow-private   Allow scanning localhost and private network addresses
  --no-open         Do not open the browser automatically
  --no-sandbox      Start Chromium without its sandbox (needed in some containers)
  -v, --version     Print the version
  -h, --help        Show this help

Settings can also be given as environment variables. See the README.`;

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has('-h') || has('--help')) {
  console.log(HELP);
  process.exit(0);
}
if (has('-v') || has('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

function flagValue(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

function installChromium() {
  // Idempotent: does nothing when the browser is already installed.
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  // Playwright prints a confusing warning when it detects it was started through npx.
  const env = { ...process.env };
  delete env.npm_command;
  delete env.npm_lifecycle_event;
  const result = spawnSync(process.execPath, [cli, 'install', '--only-shell', 'chromium'], { stdio: 'inherit', env });
  if (result.status !== 0) {
    console.error('\nCould not download the Chromium browser. Check your internet connection and try again.');
    process.exit(1);
  }
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  const [cmd, cmdArgs] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // opening the browser is a convenience only
  }
}

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/api/config`);
      if (res.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (parseInt(process.versions.node, 10) < 20) {
    console.error(`Node.js 20 or newer is required (you have ${process.versions.node}).`);
    process.exit(1);
  }

  console.log('Checking for the Chromium browser (first run downloads about 130 MB)...');
  installChromium();

  let port = parseInt(flagValue('--port') || process.env.PORT || '3012', 10);
  if (!flagValue('--port') && !process.env.PORT) {
    for (let p = port; p < port + 20; p++) {
      if (await isPortFree(p)) {
        port = p;
        break;
      }
    }
  }

  process.env.PORT = String(port);
  if (has('--allow-private')) process.env.ALLOW_PRIVATE_URLS = 'true';
  if (has('--no-sandbox')) process.env.CHROMIUM_SANDBOX = 'false';
  if (!process.env.SCREENSHOTS_DIR) {
    process.env.SCREENSHOTS_DIR = path.join(os.homedir(), '.website-screenshot-crawler', 'screenshots');
  }

  require('../server.js');

  const url = `http://localhost:${port}`;
  if (await waitForServer(`http://127.0.0.1:${port}`)) {
    console.log(`\nReady. Open ${url} (press Ctrl+C to stop)`);
    if (!has('--no-open')) openBrowser(url);
  }
})();
