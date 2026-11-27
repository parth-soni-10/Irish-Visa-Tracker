/**
 * Digest schedule safety.
 *
 *   node --test tests/digest-schedule.test.mjs
 *
 * The digest workflow runs from its monthly cron, a next-day retry and every
 * scrape run, so the endpoint must announce a month at most once. Without this
 * guard a fallback trigger would post the monthly report again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleReports } from '../functions/reports.js';

/** D1 stand-in: `announced` lists the months already in digest_broadcasts. */
function stubDB({ announced = [] } = {}) {
  return {
    prepare(sql) {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: [] }),
        first: async () => (String(sql).includes('digest_broadcasts') && announced.length
          ? { month: announced[0] }
          : null),
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

test('digest stays green and says why without a Telegram channel', async () => {
  const response = await handleReports(sendRequest('secret'), {
    DB: stubDB(),
    SCRAPER_CRON_SECRET: 'secret'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.sent, 0);
  assert.equal(body.skipped, 'telegram_channel_not_configured');
});

test('digest announces a month at most once', async () => {
  const response = await handleReports(sendRequest('secret'), {
    DB: stubDB({ announced: ['2026-10'] }),
    SCRAPER_CRON_SECRET: 'secret',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHANNEL_ID: '-1001234567890'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.sent, 0);
  assert.equal(body.skipped, 'already_sent_this_month');
});
