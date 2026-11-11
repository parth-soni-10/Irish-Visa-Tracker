import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlertLinks } from '../functions/email4.js';

test('verification and unsubscribe links carry their own exact tokens', () => {
  const links = buildAlertLinks({ APP_BASE_URL: 'https://example.test/' }, 'verify-123', 'unsub-456');
  assert.equal(links.verify, 'https://example.test/api/verify?token=verify-123');
  assert.equal(links.unsubscribe, 'https://example.test/api/unsubscribe?token=unsub-456');
  assert.notEqual(links.verify, links.unsubscribe);
});

test('tokens are URL-encoded and base URL is normalised', () => {
  const links = buildAlertLinks({ APP_BASE_URL: 'https://example.test/base/' }, 'a b&c', 'd/e');
  assert.equal(links.verify, 'https://example.test/base/api/verify?token=a%20b%26c');
  assert.equal(links.unsubscribe, 'https://example.test/base/api/unsubscribe?token=d%2Fe');
});

test('a missing base URL falls back to the production origin', () => {
  const links = buildAlertLinks({}, 'v', 'u');
  assert.match(links.verify, /^https:\/\/irishvisaupdatetracker\.pages\.dev\/api\/verify\?token=v$/);
});
