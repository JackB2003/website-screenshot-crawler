# Changelog

## 1.1.0

- One-command start: `npx github:JackB2003/website-screenshot-crawler` downloads Chromium on first run, picks a free port and opens the browser
- Command-line options: `--port`, `--allow-private`, `--no-open`, `--no-sandbox`

## 1.0.0

First release.

- Full-site discovery from the sitemap, with a rendered-DOM link crawl as the fallback
- Full-page capture at desktop, tablet and mobile sizes
- Live progress over Server-Sent Events, gallery and ZIP export
- Secure by default: private and internal addresses blocked on every request including redirects, localhost-only listening, optional token, rate and concurrency limits, scan time limit
- Docker support, configuration through environment variables, bundled demo site
