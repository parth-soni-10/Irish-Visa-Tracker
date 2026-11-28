/**
 * Public correction ledger and structured error reports.
 *
 *   node --test tests/corrections.test.mjs
 *
 * The ledger must keep the source URL on every diff, and a correction report
 * must identify an office, report date and source rather than relying on a
 * free-text message alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCorrectionLedger } from '../functions/report-data.js';
import router from '../functions/_router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const REPORT = {
  office: 'new-delhi',
  office_name: 'New Delhi',
  report_date: '2026-11-10',
  fetched_at: '2026-11-11T21:57:50.852Z',
  decisions: 42472,
  approved: 35852,
  refused: 6620,
  checksum: 'a957be3118d7f874',
  source_file: 'https://www.ireland.ie/5308/20261110_NDVO_Visa_Decisions.ods',
  added: 103,
  removed: 1,
  changed: [{ number: '83289482', from: 'Refused', to: 'Approved' }]
};

function envWith({ inserts = [], rows = [] } = {}) {
  const statement = {
    sql: '',
    args: [],
    bind(...args) { statement.args = args; return statement; },
    all: async () => ({ results: rows }),
    first: async () => null,
    run: async () => {
      if (/INSERT INTO submissions/.test(statement.sql)) inserts.push(statement.args);
      return { success: true };
    }
  };
  return {
    DB: { prepare: (sql) => { statement.sql = sql; return statement; }, batch: async () => [] },
    ASSETS: {
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        const file = path.join(ROOT, pathname.replace(/^\//, ''));
        try {
          return new Response(fs.readFileSync(file));
        } catch {
          return new Response('missing', { status: 404 });
        }
      }
    }
  };
}

function correctionBody(overrides = {}) {
  return new URLSearchParams({
    'form-name': 'corrections',
    name: 'Test Reporter',
    office: 'new-delhi',
    report_date: '2026-11-10',
    source_url: 'https://www.ireland.ie/5308/20261110_NDVO_Visa_Decisions.ods',
    issue: 'wrong_decision',
    application_number: '83289482',
    details: 'This row now shows Approved in the official file.',
    ...overrides
  }).toString();
}

test('ledger keeps office, report date, source URL and changed rows', () => {
  const ledger = buildCorrectionLedger({
    offices: {
      'new-delhi': [REPORT],
      dublin: [{
        report_date: '2026-11-01',
        source_file: 'https://www.ireland.ie/5288/20261101_BVO_visa_decisions.ods',
        added: 0,
        removed: 0,
        changed: []
      }]
    }
  }, {
    manifest: {
      offices: [{
        slug: 'new-delhi',
        name: 'New Delhi',
        source_url: 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/'
      }]
    }
  });

  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.totals.reports, 1);
  assert.equal(ledger.totals.added, 103);
  assert.equal(ledger.totals.removed, 1);
  assert.equal(ledger.totals.changed, 1);
  assert.equal(ledger.entries[0].office, 'new-delhi');
  assert.equal(ledger.entries[0].office_name, 'New Delhi');
  assert.equal(ledger.entries[0].report_date, '2026-11-10');
  assert.equal(
    ledger.entries[0].source_file,
    'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
  );
  assert.equal(ledger.entries[0].source_url, ledger.entries[0].source_file);
  assert.deepEqual(ledger.entries[0].changed, REPORT.changed);
});

test('ledger falls back to the office page when a file URL is absent', () => {
  const ledger = buildCorrectionLedger({
    offices: {
      ankara: [{
        report_date: '2026-11-15',
        source_file: '',
        added: 2,
        removed: 0,
        changed: []
      }]
    }
  }, {
    manifest: {
      offices: [{
        slug: 'ankara',
        name: 'Ankara',
        source_url: 'https://www.ireland.ie/en/turkey/ankara/services/visas/'
      }]
    }
  });

  assert.equal(ledger.entries[0].source_file, null);
  assert.equal(ledger.entries[0].source_page, 'https://www.ireland.ie/en/turkey/ankara/services/visas/');
  assert.equal(ledger.entries[0].source_url, ledger.entries[0].source_page);
});

test('GET /api/reports/corrections returns a no-store public ledger', async () => {
  const response = await router.fetch(
    new Request('https://tracker.test/api/reports/corrections'),
    envWith()
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.success, true);
  assert.ok(body.ledger.entries.length > 0);
  const changedEntry = body.ledger.entries.find((entry) => entry.changed.length > 0);
  assert.ok(changedEntry, 'the real report index has at least one changed row');
  assert.match(changedEntry.report_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(changedEntry.source_url, /^https:\/\/www\.ireland\.ie\//);
  assert.ok(changedEntry.office_name);
});

test('serves the public correction ledger page', async () => {
  const response = await router.fetch(
    new Request('https://tracker.test/corrections'),
    envWith()
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Correction ledger<\/h1>/);
  assert.match(html, /\/api\/reports\/corrections/);
  assert.match(html, /href="\/contact#report-error"/);
});

test('structured correction reports are validated and stored', async () => {
  const inserts = [];
  const response = await router.fetch(
    new Request('https://tracker.test/contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: correctionBody()
    }),
    envWith({ inserts })
  );

  assert.equal(response.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], 'corrections');
  const fields = JSON.parse(inserts[0][1]);
  assert.equal(fields.office, 'new-delhi');
  assert.equal(fields.report_date, '2026-11-10');
  assert.equal(fields.source_url, REPORT.source_file);
  assert.equal(fields.issue, 'wrong_decision');
  assert.equal(fields.application_number, '83289482');
});

test('a correction report without the required office, date or source is rejected', async () => {
  for (const [overrides, field] of [
    [{ office: '' }, 'office'],
    [{ report_date: '2026-02-31' }, 'report_date'],
    [{ source_url: 'javascript:alert(1)' }, 'source_url'],
    [{ issue: 'made_up' }, 'issue'],
    [{ details: '' }, 'details'],
    [{ application_number: '123' }, 'application_number']
  ]) {
    const inserts = [];
    const response = await router.fetch(
      new Request('https://tracker.test/contact', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json'
        },
        body: correctionBody(overrides)
      }),
      envWith({ inserts })
    );
    assert.equal(response.status, 400, field);
    assert.equal(inserts.length, 0, field);
  }
});
