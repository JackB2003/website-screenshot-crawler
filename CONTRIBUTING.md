# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Set up

```bash
git clone https://github.com/JackB2003/website-screenshot-crawler.git
cd website-screenshot-crawler
npm install
npx playwright install --only-shell chromium
npm test
```

If Chromium cannot start its sandbox on your machine, run `CHROMIUM_SANDBOX=false npm test`.

## Guidelines

- Keep it dependency-light. The app has three runtime dependencies on purpose.
- Add a test for behaviour you change. Anything touching `lib/netguard.js`, `lib/proxy.js` or request handling needs one.
- No build step for the front end: plain HTML, CSS and JavaScript.
- Match the style of the surrounding code and keep changes focused.
- Security reports go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

Describe what changed and why, and confirm `npm test` passes. Small pull requests are reviewed faster.
