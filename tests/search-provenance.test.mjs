import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { onRequestPost } from '../functions/api/search.js';
import { loadFreshness } from '../tools/freshness.mjs';

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
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
  return response.json();
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

async function readJson(relative) {
  return JSON.parse(await fs.readFile(path.join(ROOT, relative), 'utf8'));
}

test('search results distinguish tracker observations from official report rows', async () => {
  const freshness = loadFreshness(ROOT);
  const newDelhi = freshness.bySlug['new-delhi'];
  const tracker = await readJson('data/visa_decisions.json');
  const trackerRow = tracker.find((row) =>
    Array.isArray(row) && row[0] > newDelhi.official_data_through &&
    /^(approved|refused)$/i.test(String(row[2])));
  assert.ok(trackerRow, 'fixture needs a New Delhi tracker observation newer than the official file');

  const trackerPayload = await search({ query: digits(trackerRow[1]), mode: 'fuzzy', limit: 100 });
  const trackerResult = trackerPayload.results.find((row) => digits(row.number) === digits(trackerRow[1]));
  assert.ok(trackerResult, 'tracker row should be returned by search');
  assert.equal(trackerResult.source, 'tracker');
  assert.equal(trackerResult.source_kind, 'tracker');
  assert.equal(trackerResult.source_label, 'Tracker observation');
  assert.equal(trackerResult.report_date, null, 'tracker rows must not inherit the official report date');
  assert.equal(trackerResult.official_report_date, newDelhi.official_data_through);
  assert.equal(trackerResult.observed_date, trackerRow[0]);
  assert.equal(trackerResult.observed_at, trackerRow[0]);
  assert.equal(trackerResult.freshness_status, 'official');
  assert.equal(trackerResult.official_data_through, newDelhi.official_data_through);
  assert.equal(trackerResult.source_file, null);
  assert.ok(trackerResult.source_url);
  assert.equal(trackerResult.last_success_label, newDelhi.last_success_label);
  assert.equal(trackerResult.stale, false);
  assert.equal(trackerResult.office_status_label, 'Official');

  assert.equal(trackerPayload.offices['new-delhi'].last_success_label, newDelhi.last_success_label);
  assert.equal(trackerPayload.offices['new-delhi'].stale, false);

  const official = await readJson('data/embassy-new-delhi.json');
  const officialRow = (official.decisions || []).find((row) => row.date === newDelhi.official_data_through);
  assert.ok(officialRow, 'fixture needs an official New Delhi row');
  const officialPayload = await search({ query: digits(officialRow.number), mode: 'fuzzy', limit: 100 });
  const officialResult = officialPayload.results.find((row) => digits(row.number) === digits(officialRow.number));
  assert.ok(officialResult, 'official row should be returned by search');
  assert.equal(officialResult.source, 'official');
  assert.equal(officialResult.source_kind, 'official');
  assert.equal(officialResult.source_label, 'Official report');
  assert.equal(officialResult.report_date, newDelhi.official_data_through);
  assert.equal(officialResult.source_file, official.source_file);
  assert.equal(officialResult.last_success_label, newDelhi.last_success_label);
});

test('search exposes the last successful check and freshness state for each office', async () => {
  const beijing = await readJson('data/embassy-beijing.json');
  const beijingRow = (beijing.decisions || []).find((row) => /^(Approved|Refused)$/i.test(String(row.decision)));
  assert.ok(beijingRow, 'fixture needs a Beijing decision row');

  // Search must report the same freshness the site publishes for the office,
  // whatever state that office is in; the rendering of the failed-refresh copy
  // itself is covered by the synthetic office in freshness-client.test.mjs.
  const freshness = await readJson('data/freshness.json');
  const published = freshness.offices.find((entry) => entry.slug === 'beijing');
  assert.ok(published, 'freshness.json should carry Beijing');

  const payload = await search({ query: digits(beijingRow.number), mode: 'fuzzy', limit: 100 });
  const result = payload.results.find((row) => row.embassy === 'beijing' && digits(row.number) === digits(beijingRow.number));
  assert.ok(result, 'Beijing row should be returned by search');
  assert.equal(result.office_status, beijing.data_status);
  assert.equal(result.freshness_status, published.status);
  assert.equal(result.freshness_status_label, published.status_label);
  assert.equal(result.office_attention, published.attention);
  assert.equal(result.stale, published.stale);
  assert.equal(result.last_success_label, published.last_success_label);

  const office = payload.offices.beijing;
  assert.equal(office.status, published.status);
  assert.equal(office.attention, published.attention);
  assert.equal(office.last_success_label, published.last_success_label);
  assert.ok(office.official_data_through);
  assert.ok(office.observed_data_through);
});