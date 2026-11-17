/**
 * Telegram channel announcements for new official files.
 *
 *   node --test tests/telegram-broadcast.test.mjs
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAnnouncement, handleTelegramBroadcast } from '../functions/telegram-broadcast.js';

const entry = {
  office_name: 'New Delhi',
  report_date: '2026-11-16',
  decisions: 43152,
  approved: 36357,
  refused: 6795,
  added: 120,
  removed: 2,
  corrections: 1,
  source_file: 'https://example.test/new-delhi.csv'
};

test('announcement names the office, report facts and official source', () => {
  const message = buildAnnouncement(entry, 'https://tracker.test/');
  assert.match(message, /New official file — New Delhi/);
  assert.match(message, /16 November 2026/);
  assert.match(message, /43,152 decisions/);
  assert.match(message, /Added since previous report: 120/);
  assert.match(message, /Official file: https:\/\/example\.test\/new-delhi\.csv/);
  assert.match(message, /Tracker: https:\/\/tracker\.test\/status#office-coverage/);
});

test('broadcast rejects a wrong cron secret', async () => {
  const response = await handleTelegramBroadcast(
    new Request('https://tracker.test/api/telegram/broadcast', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'wrong' }
    }),
    { ALERTS_CRON_SECRET: 'right', DB: {} }
  );
  assert.equal(response.status, 401);
});

test('broadcast skips cleanly when no channel is configured', async () => {
  const response = await handleTelegramBroadcast(
    new Request('https://tracker.test/api/telegram/broadcast', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'right' }
    }),
    {
      ALERTS_CRON_SECRET: 'right',
      TELEGRAM_BOT_TOKEN: '123:abc',
      DB: {}
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.skipped, 'telegram_channel_not_configured');
  assert.equal(body.sent, 0);
});
