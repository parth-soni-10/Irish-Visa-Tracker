import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSearchIndex } from '../tools/build-search-index.mjs';
import { onRequestPost } from '../functions/api/search.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('the compact index covers every office and keeps tracker rows distinct', async () => {
  const outFile = path.join(ROOT, '.cache', 'search-index-test.json');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  try {
    const result = buildSearchIndex({ outFile });
    const payload = JSON.parse(await fs.readFile(outFile, 'utf8'));
    assert.deepEqual(payload.offices.sort(), ['abu-dhabi', 'abuja', 'ankara', 'beijing', 'dublin', 'new-delhi']);
    assert.ok(result.rows > 50000, 'index should hold the full published archive');
    for (const row of payload.rows) {
      assert.equal(row.length, 6);
      assert.ok(Number.isInteger(row[0]));
      assert.match(String(row[2]), /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(['A', 'R'].includes(row[3]));
    }
    const trackerRows = payload.rows.filter((row) => row[5] === 2);
    assert.ok(trackerRows.length > 0, 'New Delhi tracker observations must stay in the index');
    const officialRows = payload.rows.filter((row) => row[5] === 0);
    assert.ok(officialRows.length > 0, 'official report rows must stay in the index');
  } finally {
    await fs.rm(outFile, { force: true });
  }
});

test('the search API answers from the compact index without the full archives', async () => {
  const env = {
    DB: { prepare() { return { async run() {} }; } },
    ASSETS: {
      async fetch(request) {
        const relative = new URL(request.url).pathname.replace(/^\/+/, '');
        // Only the compact index and its two small companions are available;
        // every full office archive deliberately 404s.
        if (!['data/search_index.json', 'data/data_manifest.json', 'data/freshness.json'].includes(relative)) {
          return new Response('missing', { status: 404 });
        }
        const body = await fs.readFile(path.join(ROOT, relative));
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    },
  };
  const request = new Request('https://tracker.test/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '86826162', limit: 5 }),
  });
  const response = await onRequestPost({ request, env });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.results[0].number, '86826162');
  assert.equal(payload.results[0].embassy, 'new-delhi');
  assert.equal(payload.results[0].source, 'tracker');
});
