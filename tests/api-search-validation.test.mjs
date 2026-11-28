import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { onRequestGet, onRequestPost } from '../functions/api/search.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function testEnv() {
  const db = {
    prepare() {
      return { async run() {} };
    },
  };
  return {
    DB: db,
    ASSETS: {
      async fetch(request) {
        const relative = new URL(request.url).pathname.replace(/^\/+/, '');
        try {
          const body = await fs.readFile(path.join(ROOT, relative));
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch {
          return new Response('missing', { status: 404 });
        }
      },
    },
  };
}

async function post(rawBody) {
  const request = new Request('https://tracker.test/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody),
  });
  return onRequestPost({ request, env: testEnv() });
}

async function expectInvalid(rawBody, pattern) {
  const response = await post(rawBody);
  assert.equal(response.status, 400);
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  const data = await response.json();
  assert.equal(data.success, false);
  if (pattern) assert.match(data.error, pattern);
  return data;
}

test('search rejects a body that is not a JSON object', async () => {
  await expectInvalid('null', /JSON object/);
  await expectInvalid([1, 2], /JSON object/);
  await expectInvalid('"query"', /JSON object/);
  await expectInvalid(5, /JSON object/);
});

test('search rejects an unknown sort instead of returning an arbitrary order', async () => {
  const data = await expectInvalid({ sort: 'newest-first' }, /Unknown sort/);
  assert.ok(data.sort_options.includes('date_desc'));
  assert.ok(data.sort_options.includes('relevance'));
});

test('search validates the query type and length', async () => {
  await expectInvalid({ query: 12345 }, /query must be a string/);
  const data = await expectInvalid({ query: 'a'.repeat(201) }, /at most 200 characters/);
  assert.equal(data.max_length, 200);
});

test('search normalizes the decision filter and rejects an unknown value', async () => {
  const response = await post({ mode: 'filter', filters: { decision: 'approved' }, limit: 1 });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.filters.decision, 'Approved');
  assert.ok(data.results.length > 0);
  assert.equal(data.results[0].decision, 'Approved');

  const invalid = await expectInvalid({ filters: { decision: 'maybe' } }, /Unknown decision/);
  assert.deepEqual(invalid.decisions, ['Approved', 'Refused']);
});

test('search echoes only the filters it reads', async () => {
  const response = await post({
    mode: 'filter',
    filters: { embassy: 'beijing', unexpected: 'value', nested: { a: 1 } },
    limit: 1,
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.filters.embassy, 'beijing');
  assert.equal('unexpected' in data.filters, false);
  assert.equal('nested' in data.filters, false);
});

test('the search capability document describes what the endpoint now accepts', async () => {
  const response = await onRequestGet({ env: testEnv() });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.decisions, ['Approved', 'Refused']);
  assert.equal(data.pagination.limit_default, 20);
  assert.equal(data.pagination.limit_max, 100);
  assert.ok(data.sort_options.includes('number_desc'));
  for (const field of [
    'source_name',
    'office_status_label',
    'freshness_status_label',
    'office_warning',
    'official_data_through',
    'observed_data_through',
  ]) {
    assert.ok(data.provenance.includes(field), field);
  }
});
