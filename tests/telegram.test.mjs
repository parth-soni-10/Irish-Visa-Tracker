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

const WEBHOOK_SECRET = 'webhook-secret';

/**
 * Minimal D1 stand-in for the two tables the linking flow touches. It
 * interprets the handful of statements handleTelegramWebhook issues rather
 * than pretending to be SQL, so the assertions can inspect the rows directly.
 */
function makeTelegramDb({ links = [], subscriptions = [] } = {}) {
  const linkRows = new Map(links.map((link) => [link.token, { ...link }]));
  const subscriptionRows = subscriptions.map((row) => ({ ...row }));

  const db = {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async run() {
          if (/INSERT INTO telegram_subscriptions/i.test(sql)) {
            const [chatId, applicationNumber, embassy] = statement.args;
            const existing = subscriptionRows.find(
              (row) =>
                row.chat_id === chatId &&
                row.application_number === applicationNumber &&
                row.embassy === embassy
            );
            if (existing) existing.active = 1;
            else {
              subscriptionRows.push({
                chat_id: chatId,
                application_number: applicationNumber,
                embassy,
                active: 1
              });
            }
          } else if (/UPDATE telegram_subscriptions SET active = 0 WHERE chat_id = \?/i.test(sql)) {
            for (const row of subscriptionRows) {
              if (row.chat_id === statement.args[0]) row.active = 0;
            }
          } else if (/DELETE FROM telegram_links WHERE token = \?/i.test(sql)) {
            linkRows.delete(statement.args[0]);
          }
          return { success: true };
        },
        async first() {
          if (/FROM telegram_links WHERE token = \?/i.test(sql)) {
            const link = linkRows.get(statement.args[0]);
            if (!link) return null;
            if (new Date(link.expires_at).getTime() <= Date.now()) return null;
            return { application_number: link.application_number, embassy: link.embassy };
          }
          return null;
        },
        async all() {
          if (/FROM telegram_subscriptions WHERE chat_id = \?/i.test(sql)) {
            const results = subscriptionRows
              .filter((row) => row.chat_id === statement.args[0] && row.active)
              .map((row) => ({ application_number: row.application_number, embassy: row.embassy }));
            return { results };
          }
          return { results: [] };
        }
      };
      return statement;
    }
  };

  return { db, linkRows, subscriptionRows };
}

function telegramEnv(db) {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET
  };
}

function webhookRequest(chatId, text) {
  return new Request('https://tracker.test/api/telegram/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text }
    })
  });
}

function stubTelegramApi() {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    if (String(url).endsWith('/sendMessage')) {
      sent.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };
  return {
    sent,
    restore() {
      globalThis.fetch = original;
    }
  };
}

function futureLink(token) {
  return {
    token,
    application_number: '85444062',
    embassy: 'new-delhi',
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString()
  };
}

test('webhook /start consumes a valid token and links the chat', async () => {
  const { db, linkRows, subscriptionRows } = makeTelegramDb({ links: [futureLink('valid-token')] });
  const api = stubTelegramApi();
  try {
    const response = await handleTelegramWebhook(
      webhookRequest(123456789, '/start valid-token'),
      telegramEnv(db)
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(linkRows.has('valid-token'), false);
    assert.deepEqual(subscriptionRows, [
      { chat_id: '123456789', application_number: '85444062', embassy: 'new-delhi', active: 1 }
    ]);
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].chat_id, '123456789');
    assert.match(api.sent[0].text, /Alerts enabled for 85444062 \(new-delhi\)/);
  } finally {
    api.restore();
  }
});

test('webhook /start rejects an expired token and leaves the link untouched', async () => {
  const expired = {
    ...futureLink('expired-token'),
    expires_at: new Date(Date.now() - 60 * 1000).toISOString()
  };
  const { db, linkRows, subscriptionRows } = makeTelegramDb({ links: [expired] });
  const api = stubTelegramApi();
  try {
    const response = await handleTelegramWebhook(
      webhookRequest(123456789, '/start expired-token'),
      telegramEnv(db)
    );

    assert.equal(response.status, 200);
    assert.equal(subscriptionRows.length, 0);
    assert.equal(linkRows.has('expired-token'), true);
    assert.equal(api.sent.length, 1);
    assert.match(api.sent[0].text, /invalid or has expired/);
  } finally {
    api.restore();
  }
});

test('webhook /stop deactivates and /start re-links the same subscription', async () => {
  const { db, linkRows, subscriptionRows } = makeTelegramDb({
    links: [futureLink('relink-token')],
    subscriptions: [
      {
        chat_id: '123456789',
        application_number: '85444062',
        embassy: 'new-delhi',
        active: 1
      }
    ]
  });
  const api = stubTelegramApi();
  try {
    const stopped = await handleTelegramWebhook(webhookRequest(123456789, '/stop'), telegramEnv(db));
    assert.equal(stopped.status, 200);
    assert.equal(subscriptionRows[0].active, 0);
    assert.match(api.sent[0].text, /alerts are off for this chat/i);

    const relinked = await handleTelegramWebhook(
      webhookRequest(123456789, '/start relink-token'),
      telegramEnv(db)
    );
    assert.equal(relinked.status, 200);
    assert.equal(subscriptionRows.length, 1, 're-linking must not duplicate the subscription');
    assert.equal(subscriptionRows[0].active, 1);
    assert.equal(linkRows.has('relink-token'), false);
    assert.match(api.sent[1].text, /Alerts enabled for 85444062/);
  } finally {
    api.restore();
  }
});
