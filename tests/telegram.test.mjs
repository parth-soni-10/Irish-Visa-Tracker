/**
 * Telegram alert channel.
 *
 *   node --test tests/telegram.test.mjs
 *
 * These pin the pieces that can silently regress: configuration detection,
 * chat-id validation before any network call, the Bot API request shape, and
 * the webhook secret check. No test needs a real bot token.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isTelegramConfigured,
  sendTelegram,
  handleTelegramStart,
  handleTelegramWebhook
} from '../functions/telegram.js';

const env = { TELEGRAM_BOT_TOKEN: '123:abc' };

test('configuration requires a bot token', () => {
  assert.equal(isTelegramConfigured(env), true);
  assert.equal(isTelegramConfigured({}), false);
  assert.equal(isTelegramConfigured({ TELEGRAM_BOT_TOKEN: '   ' }), false);
});

test('sendTelegram reports disabled without a token', async () => {
  const result = await sendTelegram({}, '123456789', 'hello');
  assert.equal(result.sent, 0);
  assert.match(result.error, /not configured/);
});

test('sendTelegram rejects a non-numeric chat id before calling Telegram', async () => {
  const result = await sendTelegram(env, 'not-a-chat', 'hello');
  assert.equal(result.sent, 0);
  assert.match(result.error, /chat id/);
});

test('sendTelegram posts to sendMessage with the chat id and text', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
  };
  try {
    const result = await sendTelegram(env, '123456789', 'Visa update');
    assert.deepEqual(result, { sent: 1, message_id: 42 });
    assert.match(request.url, /\/bot123:abc\/sendMessage$/);
    assert.equal(request.options.method, 'POST');
    const body = JSON.parse(request.options.body);
    assert.equal(body.chat_id, '123456789');
    assert.equal(body.text, 'Visa update');
  } finally {
    globalThis.fetch = original;
  }
});

test('sendTelegram reports API errors without leaking the token', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 });
  try {
    const result = await sendTelegram(env, '123456789', 'hello');
    assert.equal(result.sent, 0);
    assert.match(result.error, /chat not found/);
    assert.doesNotMatch(result.error, /123:abc/);
  } finally {
    globalThis.fetch = original;
  }
});

test('start link rejects a bad application number', async () => {
  const request = new Request('https://tracker.test/api/telegram/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application_number: '123', embassy: 'new-delhi' })
  });
  const response = await handleTelegramStart(request, { DB: {} });
  assert.equal(response.status, 400);
});

test('start link reports that Telegram is not configured', async () => {
  const request = new Request('https://tracker.test/api/telegram/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application_number: '12345678', embassy: 'new-delhi' })
  });
  const response = await handleTelegramStart(request, { DB: {} });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /not configured/);
});

test('webhook rejects a wrong secret', async () => {
  const request = new Request('https://tracker.test/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': 'wrong'
    },
    body: '{}'
  });
  const response = await handleTelegramWebhook(request, {
    DB: {},
    TELEGRAM_WEBHOOK_SECRET: 'right'
  });
  assert.equal(response.status, 401);
});
