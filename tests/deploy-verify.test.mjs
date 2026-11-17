import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normaliseAsset, stripCloudflareAnalytics } from '../tools/verify-deploy.mjs';

test('deploy verifier removes only the Pages analytics injection', () => {
  const local = '<!doctype html><html><body><h1>Tracker</h1>\n</body></html>\n';
  const live =
    '<!doctype html><html><body><h1>Tracker</h1>\n' +
    "<!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{\"token\":\"test\"}'></script><!-- Cloudflare Pages Analytics -->" +
    '</body></html>\n';
  assert.equal(stripCloudflareAnalytics(live), local);
  assert.equal(normaliseAsset('index.html', Buffer.from(live)).toString('utf8'), local);
});

test('deploy verifier normalises CRLF for text but not binary files', () => {
  const html = Buffer.from('<p>line</p>\r\n<p>next</p>\r\n');
  assert.equal(normaliseAsset('page.html', html).toString('utf8'), '<p>line</p>\n<p>next</p>\n');

  const binary = Buffer.from([0, 1, 2, 13, 10, 255]);
  assert.deepEqual(normaliseAsset('icon.png', binary), binary);
});
