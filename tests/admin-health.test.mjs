/**
 * Admin health and quality contract tests.
 *
 *   node --test tests/admin-health.test.mjs
 *
 * Both handlers read the committed JSON snapshots through `loadReportData`, so
 * the fetch stub below serves the repository's real data files without a
 * network request.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { handleDataQuality, handleScraperHealth } from '../functions/admin-api.js';

const ROOT = new URL('../', import.meta.url);
const BOOTSTRAP = 'bootstrap-admin-token';

function request(path, options = {}) {
  return new Request('https://tracker.test' + path, options);
}

function authHeader(token) {
  return { Authorization: 'Bearer ' + token };
}

function adminDB() {
  return {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/SELECT last_used_at FROM admin_tokens/.test(sql)) return { last_used_at: null };
          // A named-token lookup must miss, or the bootstrap check would pass
          // for any bearer value.
          if (/FROM admin_tokens\s+WHERE token_hash/.test(sql)) return null;
          return { count: 0 };
        },
        async all() { return { results: [] }; },
        async run() { return { success: true }; }
      };
    }
  };
}

function env() {
  return { ADMIN_DASHBOARD_TOKEN: BOOTSTRAP, DB: adminDB() };
}

function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const raw = input instanceof URL ? input.href : (typeof input === 'string' ? input : input.url);
    const url = new URL(raw, 'https://tracker.test');
    try {
      const body = await readFile(new URL('.' + url.pathname, ROOT), 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return () => { globalThis.fetch = original; };
}

test('health and quality reject a missing or invalid token', async () => {
  for (const handler of [handleScraperHealth, handleDataQuality]) {
    const missing = await handler(request('/api/admin/health'), env());
    assert.equal(missing.status, 401);

    const wrong = await handler(
      request('/api/admin/health', { headers: authHeader('wrong') }),
      env()
    );
    assert.equal(wrong.status, 401);

    const noDb = await handler(
      request('/api/admin/health', { headers: authHeader(BOOTSTRAP) }),
      { ADMIN_DASHBOARD_TOKEN: BOOTSTRAP }
    );
    assert.equal(noDb.status, 503);
  }
});

test('scraper health reports every office from the published snapshots', async () => {
  const restore = stubFetch();
  try {
    const response = await handleScraperHealth(
      request('/api/admin/health', { headers: authHeader(BOOTSTRAP) }),
      env()
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.ok(['healthy', 'degraded'].includes(body.overall), body.overall);
    assert.deepEqual(
      Object.keys(body.embassies).sort(),
      ['abu-dhabi', 'abuja', 'ankara', 'beijing', 'dublin', 'new-delhi']
    );
    for (const [slug, office] of Object.entries(body.embassies)) {
      assert.ok(['healthy', 'stale', 'down'].includes(office.status), `${slug} status`);
      assert.equal(typeof office.decisions, 'number', `${slug} decisions`);
      assert.ok('reportDate' in office, `${slug} report date`);
      assert.ok(Array.isArray(office.recentErrors), `${slug} recentErrors`);
    }
  } finally {
    restore();
  }
});

test('data quality reports completeness and a monthly trend per office', async () => {
  const restore = stubFetch();
  try {
    const response = await handleDataQuality(
      request('/api/admin/quality', { headers: authHeader(BOOTSTRAP) }),
      env()
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(Object.keys(body.embassies).length, 6);
    for (const [slug, office] of Object.entries(body.embassies)) {
      assert.ok(office.completeness >= 0 && office.completeness <= 100, `${slug} completeness`);
      assert.ok(office.duplicateCount >= 0, `${slug} duplicates`);
      assert.ok(office.monthlyTrend.length <= 12, `${slug} trend length`);
      if (office.dateRange) {
        assert.ok(office.dateRange.min <= office.dateRange.max, `${slug} date range order`);
      }
    }
  } finally {
    restore();
  }
});
