import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleTelegramWebhook } from '../functions/telegram.js';

function fakeDb() {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async run() {
          statements.push({ sql, values: this.values });
          return { success: true };
        },
        async all() {
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
      return statement;
    },
  };
}

async function send(text, db) {
  const replies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    replies.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  };
  try {
    const request = new Request('https://tracker.test/api/telegram/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'secret',
      },
      body: JSON.stringify({ message: { chat: { id: 12345678 }, text } }),
    });
    const response = await handleTelegramWebhook(request, {
      DB: db,
      TELEGRAM_BOT_TOKEN: '1:token',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
    });
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = original;
  }
  return replies;
}

test('/office <slug> subscribes the chat and records a baseline report date', async () => {
  const db = fakeDb();
  const replies = await send('/office new-delhi', db);
  assert.match(replies[0], /Office updates on for New Delhi/);
  assert.match(replies[0], /\/office off new-delhi/);
  const insert = db.statements.find((entry) => /INSERT INTO office_subscriptions/.test(entry.sql));
  assert.ok(insert, 'expected an office_subscriptions insert');
  assert.equal(insert.values[0], '12345678');
  assert.equal(insert.values[1], 'new-delhi');
});

test('/office rejects an unknown office and /office off removes one', async () => {
  const db = fakeDb();
  const invalid = await send('/office atlantis', db);
  assert.match(invalid[0], /Choose an office/);

  const removed = await send('/office off dublin', db);
  assert.match(removed[0], /Office updates off for Dublin/);
  const deleteStatement = db.statements.find((entry) => /DELETE FROM office_subscriptions/.test(entry.sql));
  assert.ok(deleteStatement, 'expected an office_subscriptions delete');
  assert.deepEqual(deleteStatement.values, ['12345678', 'dublin']);
});

test('/office with no argument explains how to subscribe', async () => {
  const db = fakeDb();
  const replies = await send('/office', db);
  assert.match(replies[0], /No office updates/);
  assert.match(replies[0], /\/office new-delhi/);
});
