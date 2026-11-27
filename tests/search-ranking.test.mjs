import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { onRequestPost } from '../functions/api/search.js';

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

async function search(body) {
  const request = new Request('https://tracker.test/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await onRequestPost({ request, env: testEnv() });
  assert.equal(response.status, 200);
  return response.json();
}

test('a text query ranks by relevance, not by decision date', async () => {
  // Before relevance ranking, a newer New Delhi approval outranked every
  // Beijing approval because the results were re-sorted by date.
  const payload = await search({ query: 'approved beijing', limit: 10 });
  assert.equal(payload.sort, 'relevance');
  assert.ok(payload.pagination.total > 0);
  for (const row of payload.results) {
    assert.equal(row.embassy, 'beijing');
    assert.equal(row.decision, 'Approved');
  }
});

test('an exact application number ranks first even for an old decision', async () => {
  const office = JSON.parse(await fs.readFile(path.join(ROOT, 'data/embassy-new-delhi.json'), 'utf8'));
  const oldest = (office.decisions || [])
    .filter((row) => /^\d{8}$/.test(String(row.number)))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  assert.ok(oldest, 'fixture needs an eight-digit New Delhi decision');

  // No explicit sort: a number query must default to relevance. This is the
  // path the homepage lookup and the advanced-search form use.
  const payload = await search({ query: oldest.number, limit: 10 });
  assert.equal(payload.sort, 'relevance');
  assert.ok(payload.results.length);
  assert.equal(String(payload.results[0].number), String(oldest.number));
  assert.equal(payload.results[0].embassy, 'new-delhi');
});

test('ranking scores stay internal and an explicit sort is still honoured', async () => {
  const payload = await search({ query: 'approved beijing', limit: 5, sort: 'date_desc' });
  for (const row of payload.results) {
    assert.equal(Object.hasOwn(row, '_search_score'), false);
    assert.equal(Object.hasOwn(row, '_distance'), false);
  }
  const dates = payload.results.map((row) => row.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});
