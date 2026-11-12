/**
 * Digest schedule safety.
 *
 *   node --test tests/digest-schedule.test.mjs
 *
 * The digest workflow runs from both its monthly cron and every scrape run, so
 * the endpoint must be idempotent per calendar month. Without this guard a
 * fallback trigger would mail every subscriber again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleReports } from '../functions/reports.js';

function stubDB(rows = []) {
  return {
    prepare() {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: rows }),
        first: async () => null,
        run: async () => ({ success: true })
      };
      return statement;
    }
  };
}

function sendRequest(secret) {
  return new Request('https://tracker.test/api/digest/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
    body: JSON.stringify({ month: '2026-10' })
  });
}

test('digest rejects a wrong cron secret', async () => {
  const response = await handleReports(sendRequest('wrong'), {
    DB: stubDB(),
    SCRAPER_CRON_SECRET: 'right'
  });
  assert.equal(response.status, 401);
});

test('digest skips subscribers already sent this month', async () => {
  const response = await handleReports(sendRequest('secret'), {
    DB: stubDB([]),
    SCRAPER_CRON_SECRET: 'secret',
    EMAIL_WEBHOOK_URL: 'https://tracker.test/api/email/send',
    EMAIL_WEBHOOK_SECRET: 'webhook-secret',
    EMAIL_FROM: 'reports@tracker.test'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.sent, 0);
  assert.equal(body.recipients, 0);
  assert.equal(body.skipped, 'already_sent_this_month');
});
