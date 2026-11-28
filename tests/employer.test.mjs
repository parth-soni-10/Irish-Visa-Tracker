import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequest } from '../functions/employer.js';

test('the employer route answers with a private, uncacheable 404', async () => {
  const response = onRequest();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex');
  assert.equal(await response.text(), 'Not found');
});

test('the employer route never returns HTML that could be mistaken for a page', async () => {
  const body = await onRequest().text();
  assert.doesNotMatch(body, /<html|<body|<main/i);
});
