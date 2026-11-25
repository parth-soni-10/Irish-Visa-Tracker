import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessBotResponse,
  auditSearchBots,
  findMissingLinks,
  officeRoutes,
  requiredInternalLinks,
} from '../tools/audit-search-bots.mjs';

test('a normal HTML response passes the bot check', () => {
  const result = assessBotResponse({
    pathname: '/irish-visa-decisions-today',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    cfMitigated: '',
    body: '<!doctype html><html><body>Decisions</body></html>',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
});

test('a Cloudflare challenge is a failure, not a successful fetch', () => {
  const result = assessBotResponse({
    pathname: '/',
    status: 403,
    contentType: 'text/html',
    cfMitigated: 'challenge',
    body: '<html><title>Just a moment...</title></html>',
  });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('Cloudflare challenge')));
});

test('a malformed sitemap or wrong key is a failure', () => {
  const sitemap = assessBotResponse({
    pathname: '/sitemap.xml',
    status: 200,
    contentType: 'text/html',
    cfMitigated: '',
    body: '<html>not a sitemap</html>',
  });
  assert.equal(sitemap.ok, false);
  assert.ok(sitemap.issues.some((issue) => issue.includes('content type')));
  assert.ok(sitemap.issues.some((issue) => issue.includes('urlset')));

  const key = assessBotResponse({
    pathname: '/abc123.txt',
    status: 200,
    contentType: 'text/plain',
    cfMitigated: '',
    body: 'wrong-key\n',
    key: 'abc123',
  });
  assert.equal(key.ok, false);
  assert.ok(key.issues.some((issue) => issue.includes('does not match')));
});

test('a redirect is reported even when the final response is 200', async () => {
  const report = await auditSearchBots({
    base: 'https://example.test',
    paths: ['/'],
    bots: [{ name: 'Bingbot', userAgent: 'test-bingbot' }],
    key: '',
    fetchImpl: async () => {
      const response = new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: 'https://elsewhere.test/' });
      return response;
    },
  });
  assert.equal(report.failures.length, 1);
  assert.ok(report.failures[0].issues.some((issue) => issue.includes('redirected to https://elsewhere.test/')));
});

test('office links must be in the served HTML, not injected later', () => {
  const routes = ['/new-delhi-visa-decisions', '/beijing-visa-decisions'];
  assert.deepEqual(requiredInternalLinks('/', routes), routes);
  assert.deepEqual(
    requiredInternalLinks('/new-delhi-visa-decisions', routes),
    ['/beijing-visa-decisions', '/irish-visa-decisions-today'],
  );
  assert.deepEqual(requiredInternalLinks('/about', routes), []);
  assert.deepEqual(requiredInternalLinks('/', []), []);

  const html = '<a href="/new-delhi-visa-decisions">New Delhi</a>';
  assert.deepEqual(findMissingLinks(html, routes), ['/beijing-visa-decisions']);
  // The markdown alternate is not the page link Googlebot needs to follow.
  assert.equal(findMissingLinks('<a href="/new-delhi-visa-decisions.md">md</a>', ['/new-delhi-visa-decisions']).length, 1);
});

test('a page whose office links only exist after JavaScript fails the audit', async () => {
  const report = await auditSearchBots({
    base: 'https://example.test',
    paths: ['/'],
    bots: [{ name: 'Googlebot', userAgent: 'test-googlebot' }],
    key: '',
    routes: ['/new-delhi-visa-decisions'],
    fetchImpl: async () => new Response(
      '<html><body><script>const links=["/new-delhi-visa-decisions"]</script></body></html>',
      { status: 200, headers: { 'content-type': 'text/html' } },
    ),
  });
  assert.equal(report.failures.length, 1);
  assert.ok(report.failures[0].issues.some((issue) => issue.includes('missing crawlable link to /new-delhi-visa-decisions')));
  assert.deepEqual(report.failures[0].missingLinks, ['/new-delhi-visa-decisions']);
});

test('the audited office list comes from the manifest', () => {
  assert.deepEqual(officeRoutes(), [
    '/new-delhi-visa-decisions',
    '/beijing-visa-decisions',
    '/abu-dhabi-visa-decisions',
    '/abuja-visa-decisions',
    '/ankara-visa-decisions',
    '/dublin-visa-decisions',
  ]);
});

test('the audit checks every bot and path with that bot user agent', async () => {
  const seen = [];
  const report = await auditSearchBots({
    base: 'https://example.test',
    paths: ['/', '/sitemap.xml'],
    bots: [
      { name: 'Bingbot', userAgent: 'test-bingbot' },
      { name: 'YandexBot', userAgent: 'test-yandexbot' },
    ],
    key: '',
    fetchImpl: async (url, options) => {
      seen.push({ url, userAgent: options.headers['user-agent'] });
      if (url.endsWith('/sitemap.xml')) {
        return new Response('<urlset><url><loc>https://example.test/</loc></url></urlset>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      }
      return new Response('<html><body>ok</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  assert.equal(report.failures.length, 0);
  assert.equal(report.results.length, 4);
  assert.deepEqual(seen.map((item) => item.userAgent), ['test-bingbot', 'test-bingbot', 'test-yandexbot', 'test-yandexbot']);
});
