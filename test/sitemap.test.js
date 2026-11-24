'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractLocs, getSitemapUrls } = require('../lib/sitemap');

test('extractLocs reads and decodes loc entries', () => {
  const xml = '<urlset><url><loc> https://a.test/x?a=1&amp;b=2 </loc></url><url><loc>https://a.test/y</loc></url></urlset>';
  assert.deepEqual(extractLocs(xml), ['https://a.test/x?a=1&b=2', 'https://a.test/y']);
});

function fakeGuard(files) {
  return {
    async safeGet(url) {
      return url in files ? { status: 200, body: files[url] } : { status: 404, body: '' };
    },
  };
}

test('getSitemapUrls keeps only same-host URLs and removes duplicates', async () => {
  const guard = fakeGuard({
    'https://a.test/sitemap.xml':
      '<urlset><url><loc>https://a.test/</loc></url><url><loc>https://a.test/</loc></url>' +
      '<url><loc>http://169.254.169.254/latest</loc></url><url><loc>https://evil.test/x</loc></url></urlset>',
  });
  assert.deepEqual(await getSitemapUrls('https://a.test', guard), ['https://a.test/']);
});

test('getSitemapUrls follows a sitemap index but not child sitemaps on other hosts', async () => {
  const guard = fakeGuard({
    'https://a.test/sitemap.xml':
      '<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap><sitemap><loc>https://other.test/s2.xml</loc></sitemap></sitemapindex>',
    'https://a.test/s1.xml': '<urlset><url><loc>https://a.test/one</loc></url></urlset>',
    'https://other.test/s2.xml': '<urlset><url><loc>https://a.test/two</loc></url></urlset>',
  });
  assert.deepEqual(await getSitemapUrls('https://a.test', guard), ['https://a.test/one']);
});

test('getSitemapUrls returns null when there is no sitemap', async () => {
  assert.equal(await getSitemapUrls('https://a.test', fakeGuard({})), null);
});
