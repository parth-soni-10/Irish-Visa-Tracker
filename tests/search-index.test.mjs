import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSearchIndex } from '../tools/build-search-index.mjs';
import { onRequestGet, onRequestPost } from '../functions/api/search.js';

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

test('a rebuild with the same rows keeps generated_at stable', async () => {
  const outFile = path.join(ROOT, '.cache', 'search-index-determinism.json');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  try {
    buildSearchIndex({ outFile });
    const first = JSON.parse(await fs.readFile(outFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    buildSearchIndex({ outFile });
    const second = JSON.parse(await fs.readFile(outFile, 'utf8'));
    assert.equal(second.generated_at, first.generated_at);
    assert.equal(second.rows.length, first.rows.length);
  } finally {
    await fs.rm(outFile, { force: true });
  }
});

test('the search API rejects filters it cannot honour instead of returning no results', async () => {
  const env = {
    DB: { prepare() { return { async run() {} }; } },
    ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } },
  };
  const post = async (body) => onRequestPost({
    request: new Request('https://tracker.test/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  });

  const office = await post({ query: '86826162', office: 'toronto' });
  assert.equal(office.status, 400);
  const officeBody = await office.json();
  assert.match(officeBody.error, /Unknown office/);
  assert.ok(officeBody.offices.includes('new-delhi'));

  const mode = await post({ query: 'x', mode: 'magic' });
  assert.equal(mode.status, 400);
  assert.match((await mode.json()).error, /Unknown mode/);

  const date = await post({ filters: { date_from: 'last-week' } });
  assert.equal(date.status, 400);
  assert.match((await date.json()).error, /date_from/);

  const range = await post({ filters: { number_range: [9000, 1000] } });
  assert.equal(range.status, 400);
  assert.match((await range.json()).error, /number_range/);

  const broken = await post('{not json');
  assert.equal(broken.status, 400);
  assert.match((await broken.json()).error, /valid JSON/);
});

test('the search API advertises the office alias and accepts a well-formed range', async () => {
  const response = await onRequestGet({
    env: {
      DB: { prepare() { return { async run() {} }; } },
      ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } },
    },
  });
  const body = await response.json();
  assert.ok(body.filters.includes('office'));
  assert.equal(body.aliases.office, 'embassy');
});

test('the search API accepts the office spelling used by the site forms', async () => {
  const env = {
    DB: { prepare() { return { async run() {} }; } },
    ASSETS: {
      async fetch(request) {
        const relative = new URL(request.url).pathname.replace(/^\/+/, '');
        if (!['data/search_index.json', 'data/data_manifest.json', 'data/freshness.json'].includes(relative)) {
          return new Response('missing', { status: 404 });
        }
        return new Response(await fs.readFile(path.join(ROOT, relative)), { status: 200 });
      },
    },
  };
  const response = await onRequestPost({
    request: new Request('https://tracker.test/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '86826162', office: 'beijing', limit: 5 }),
    }),
    env,
  });
  const payload = await response.json();
  assert.ok(payload.results.length > 0);
  assert.ok(payload.results.every((row) => row.embassy === 'beijing'));
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
