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

test('start link accepts the same formatted application numbers as site search', async () => {
  for (const [input, expected] of [
    ['IRL85444062', '85444062'],
    ['8544 4062', '85444062'],
    ['8544-4062', '85444062'],
    ['08544062', '8544062']
  ]) {
    const { db, linkRows } = makeTelegramDb();
    const response = await handleTelegramStart(new Request('https://tracker.test/api/telegram/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_number: input, embassy: 'new-delhi' })
    }), {
      DB: db,
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_BOT_USERNAME: 'Visa_Tracker_test_bot'
    });
    assert.equal(response.status, 200, input + ' should be accepted');
    const token = (await response.json()).url.split('start=')[1];
    assert.equal(linkRows.get(token).application_number, expected);
  }
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

test('start link returns a t.me URL and stores a 15-minute link', async () => {
  const { db, linkRows } = makeTelegramDb();
  const before = Date.now();
  const request = new Request('https://tracker.test/api/telegram/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application_number: '85444062', embassy: 'new-delhi' })
  });

  const response = await handleTelegramStart(request, {
    DB: db,
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_BOT_USERNAME: '@Visa_Tracker_test_bot'
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.match(body.url, /^https:\/\/t\.me\/Visa_Tracker_test_bot\?start=[0-9a-f-]{36}$/);

  const token = body.url.split('start=')[1];
  assert.deepEqual(linkRows.get(token), {
    token,
    application_number: '85444062',
    embassy: 'new-delhi',
    expires_at: body.expires_at
  });

  const ttl = new Date(body.expires_at).getTime() - before;
  assert.ok(ttl > 14 * 60 * 1000 && ttl <= 16 * 60 * 1000, 'link TTL should be about 15 minutes');
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

test('webhook fails closed when the webhook secret is not configured', async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const request = new Request('https://tracker.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 1,
        message: { message_id: 1, chat: { id: 123456789, type: 'private' }, text: '/start forged-token' }
      })
    });
    const response = await handleTelegramWebhook(request, {
      DB: {
        prepare() {
          throw new Error('the database must not be touched without a webhook secret');
        }
      }
    });

    assert.equal(response.status, 503);
    assert.match(await response.text(), /not configured/);
    assert.equal(fetchCalls, 0, 'no bot message may be sent for an unauthenticated update');
  } finally {
    globalThis.fetch = original;
  }
});

test('webhook rejects an unsigned update when a secret is configured', async () => {
  const request = new Request('https://tracker.test/api/telegram/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 1, chat: { id: 123456789, type: 'private' }, text: '/stop' }
    })
  });
  const response = await handleTelegramWebhook(request, {
    DB: {},
    TELEGRAM_WEBHOOK_SECRET: 'right'
  });
  assert.equal(response.status, 401);
});

test('webhook digest commands explain the grouped mode and per-application immediate opt-in', async () => {
  const { db } = makeTelegramDb({
    subscriptions: [
      { chat_id: '123456789', application_number: '85444062', embassy: 'new-delhi', active: 1 }
    ]
  });
  const api = stubTelegramApi();
  try {
    const daily = await handleTelegramWebhook(webhookRequest(123456789, '/digest daily'), telegramEnv(db));
    assert.equal(daily.status, 200);
    assert.match(api.sent[0].text, /Digest on/);
    assert.match(api.sent[0].text, /daily/);
    assert.match(api.sent[0].text, /linked to this chat/);
    assert.match(api.sent[0].text, /browser watchlist entries stay on the device/);

    const immediate = await handleTelegramWebhook(webhookRequest(123456789, '/immediate 85444062'), telegramEnv(db));
    assert.equal(immediate.status, 200);
    assert.match(api.sent[1].text, /Immediate alerts enabled for 85444062/);

    const invalid = await handleTelegramWebhook(webhookRequest(123456789, '/digest sometimes'), telegramEnv(db));
    assert.equal(invalid.status, 200);
    assert.match(api.sent[2].text, /Choose a digest frequency/);
    assert.match(api.sent[2].text, /linked to this chat/);

    const missing = await handleTelegramWebhook(webhookRequest(123456789, '/immediate 99999999'), telegramEnv(db));
    assert.equal(missing.status, 200);
    assert.match(api.sent[3].text, /No active alert is linked/);
  } finally {
    api.restore();
  }
});

test('webhook /digest saves a preferred hour and timezone, reports status and previews without changing state', async () => {
  const { db, preferenceRows, subscriptionRows } = makeTelegramDb({
    subscriptions: [
      { chat_id: '123456789', application_number: '85444062', embassy: 'new-delhi', active: 1 }
    ]
  });
  const api = stubTelegramApi();
  try {
    const set = await handleTelegramWebhook(
      webhookRequest(123456789, '/digest daily 8 Europe/Dublin'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.equal(set.status, 200);
    const preference = preferenceRows.get('123456789');
    assert.equal(preference.digest_frequency, 'daily');
    assert.equal(preference.digest_hour, 8);
    assert.equal(preference.digest_timezone, 'Europe/Dublin');
    assert.equal(preference.last_digest_sent, null, 'enabling a digest must not look like a delivered digest');
    assert.ok(preference.digest_started_at, 'enabling a digest should record its schedule start');
    assert.match(api.sent[0].text, /Digest on: a daily digest at 08:00 Europe\/Dublin/);
    assert.match(api.sent[0].text, /Daily digests are sent only when something changes/);

    const beforePreview = preference.last_digest_sent;
    const status = await handleTelegramWebhook(
      webhookRequest(123456789, '/digest status'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.equal(status.status, 200);
    assert.match(api.sent[1].text, /Digest: a daily digest at 08:00 Europe\/Dublin/);
    assert.match(api.sent[1].text, /Last digest: not sent yet/);
    assert.match(api.sent[1].text, /Telegram-only/);

    const preview = await handleTelegramWebhook(
      webhookRequest(123456789, '/digest preview'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.equal(preview.status, 200);
    assert.match(api.sent[2].text, /Digest preview/);
    assert.match(api.sent[2].text, /1 tracked application · 1 new decision/);
    assert.match(api.sent[2].text, /85444062 — Approved/);
    assert.equal(preference.last_digest_sent, beforePreview, 'preview must not move the next digest');
    assert.equal(subscriptionRows[0].last_alert_sent, undefined, 'preview must not mark a decision as sent');
  } finally {
    api.restore();
  }
});

test('webhook /digest rejects bad hours and timezones without saving preferences', async () => {
  const { db, preferenceRows } = makeTelegramDb({
    subscriptions: [
      { chat_id: '123456789', application_number: '85444062', embassy: 'new-delhi', active: 1 }
    ]
  });
  const api = stubTelegramApi();
  try {
    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest daily 25 UTC'),
      telegramEnv(db)
    );
    assert.match(api.sent[0].text, /delivery hour from 0 to 23/);
    assert.equal(preferenceRows.size, 0);

    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest daily 8 Not/AZone'),
      telegramEnv(db)
    );
    assert.match(api.sent[1].text, /timezone is not recognized/);
    assert.equal(preferenceRows.size, 0);

    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest weekly 18:00 America/New_York'),
      telegramEnv(db)
    );
    const preference = preferenceRows.get('123456789');
    assert.equal(preference.digest_frequency, 'weekly');
    assert.equal(preference.digest_hour, 18);
    assert.equal(preference.digest_timezone, 'America/New_York');
    assert.match(api.sent[2].text, /Weekly digests include a no-change summary/);

    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest off'),
      telegramEnv(db)
    );
    const afterOff = preferenceRows.get('123456789');
    assert.equal(afterOff.digest_frequency, 'off');
    assert.equal(afterOff.digest_hour, 18, 'turning the digest off must keep the preferred hour');
    assert.equal(afterOff.digest_timezone, 'America/New_York');

    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest daily'),
      telegramEnv(db)
    );
    const afterOn = preferenceRows.get('123456789');
    assert.equal(afterOn.digest_frequency, 'daily');
    assert.equal(afterOn.digest_hour, 18);
    assert.equal(afterOn.digest_timezone, 'America/New_York');
  } finally {
    api.restore();
  }
});

test('per-application digest and removal commands leave other links alone', async () => {
  const { db, subscriptionRows } = makeTelegramDb({
    subscriptions: [
      { chat_id: '123456789', application_number: '11111111', embassy: 'new-delhi', active: 1 },
      { chat_id: '123456789', application_number: '22222222', embassy: 'beijing', active: 1 }
    ]
  });
  const api = stubTelegramApi();
  try {
    await handleTelegramWebhook(webhookRequest(123456789, '/digest daily'), telegramEnv(db));
    assert.deepEqual(subscriptionRows.map((row) => row.immediate), [0, 0]);

    await handleTelegramWebhook(webhookRequest(123456789, '/immediate 11111111'), telegramEnv(db));
    assert.deepEqual(subscriptionRows.map((row) => row.immediate), [1, 0]);

    const back = await handleTelegramWebhook(webhookRequest(123456789, '/digest IRL11111111'), telegramEnv(db));
    assert.equal(back.status, 200);
    assert.deepEqual(subscriptionRows.map((row) => row.immediate), [0, 0]);
    assert.match(api.sent.at(-1).text, /Digest mode enabled for 11111111/);

    const removed = await handleTelegramWebhook(webhookRequest(123456789, '/remove 22222222'), telegramEnv(db));
    assert.equal(removed.status, 200);
    assert.deepEqual(subscriptionRows.map((row) => row.active), [1, 0]);
    assert.match(api.sent.at(-1).text, /Alerts removed for 22222222/);

    const missing = await handleTelegramWebhook(webhookRequest(123456789, '/remove 33333333'), telegramEnv(db));
    assert.equal(missing.status, 200);
    assert.match(api.sent.at(-1).text, /No active alert is linked/);
  } finally {
    api.restore();
  }
});

test('daily no-change preview says the scheduled digest would be skipped', async () => {
  const { db } = makeTelegramDb({
    subscriptions: [
      {
        chat_id: '123456789',
        application_number: '85444062',
        embassy: 'new-delhi',
        active: 1,
        immediate: 0,
        last_alert_sent: '2026-11-16'
      }
    ],
    preferences: [{ chat_id: '123456789', digest_frequency: 'daily' }]
  });
  const api = stubTelegramApi();
  try {
    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest preview'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.match(api.sent[0].text, /nothing was sent/);
    assert.match(api.sent[0].text, /would be skipped because there are no new published decisions/);
  } finally {
    api.restore();
  }
});

test('weekly no-change preview groups every office and application', async () => {
  const { db } = makeTelegramDb({
    subscriptions: [
      {
        chat_id: '123456789',
        application_number: '85444062',
        embassy: 'new-delhi',
        active: 1,
        immediate: 0,
        last_alert_sent: '2026-11-16'
      }
    ],
    preferences: [{ chat_id: '123456789', digest_frequency: 'weekly' }]
  });
  const api = stubTelegramApi();
  try {
    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest preview'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.match(api.sent[0].text, /New Delhi: no change \(1 application: 85444062\)/);
    assert.doesNotMatch(api.sent[0].text, /would be skipped/);
  } finally {
    api.restore();
  }
});

test('digest preview ignores applications that are back in immediate mode', async () => {
  const { db } = makeTelegramDb({
    subscriptions: [
      {
        chat_id: '123456789',
        application_number: '85444062',
        embassy: 'new-delhi',
        active: 1,
        immediate: 1
      }
    ],
    preferences: [{ chat_id: '123456789', digest_frequency: 'daily' }]
  });
  const api = stubTelegramApi();
  try {
    await handleTelegramWebhook(
      webhookRequest(123456789, '/digest preview'),
      telegramEnv(db, { ASSETS: reportAssets() })
    );
    assert.match(api.sent[0].text, /All linked applications are set to immediate alerts/);
    assert.doesNotMatch(api.sent[0].text, /85444062 —/);
  } finally {
    api.restore();
  }
});

const WEBHOOK_SECRET = 'webhook-secret';

/**
 * Minimal D1 stand-in for the two tables the linking flow touches. It
 * interprets the handful of statements handleTelegramWebhook issues rather
 * than pretending to be SQL, so the assertions can inspect the rows directly.
 */
function makeTelegramDb({ links = [], subscriptions = [], preferences = [] } = {}) {
  const linkRows = new Map(links.map((link) => [link.token, { ...link }]));
  const subscriptionRows = subscriptions.map((row) => ({ ...row }));
  const preferenceRows = new Map(preferences.map((row) => [String(row.chat_id), {
    digest_frequency: 'off',
    last_digest_sent: null,
    digest_started_at: null,
    digest_hour: 9,
    digest_timezone: 'UTC',
    ...row
  }]));

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
            const [chatId, applicationNumber, embassy, immediate, baseline] = statement.args;
            const existing = subscriptionRows.find(
              (row) =>
                row.chat_id === chatId &&
                row.application_number === applicationNumber &&
                row.embassy === embassy
            );
            if (existing) {
              existing.active = 1;
              existing.immediate = immediate;
            }
            else {
              subscriptionRows.push({
                chat_id: chatId,
                application_number: applicationNumber,
                embassy,
                active: 1,
                immediate,
                last_alert_sent: baseline
              });
            }
          } else if (/UPDATE telegram_subscriptions SET active = 0 WHERE chat_id = \? AND application_number = \?/i.test(sql)) {
            for (const row of subscriptionRows) {
              if (
                row.chat_id === statement.args[0] &&
                row.application_number === statement.args[1] &&
                row.active
              ) row.active = 0;
            }
          } else if (/UPDATE telegram_subscriptions SET active = 0 WHERE chat_id = \?/i.test(sql)) {
            for (const row of subscriptionRows) {
              if (row.chat_id === statement.args[0]) row.active = 0;
            }
          } else if (/UPDATE telegram_subscriptions SET immediate = ([01]) WHERE chat_id = \? AND application_number = \?/i.test(sql)) {
            const immediate = Number(sql.match(/SET immediate = ([01])/i)[1]);
            for (const row of subscriptionRows) {
              if (
                row.chat_id === statement.args[0] &&
                row.application_number === statement.args[1] &&
                row.active
              ) row.immediate = immediate;
            }
          } else if (/UPDATE telegram_subscriptions SET immediate = \? WHERE chat_id = \?/i.test(sql)) {
            for (const row of subscriptionRows) {
              if (row.chat_id === statement.args[1]) row.immediate = Number(statement.args[0]);
            }
          } else if (/INSERT INTO telegram_links/i.test(sql)) {
            const [token, applicationNumber, embassy, expiresAt] = statement.args;
            linkRows.set(token, {
              token,
              application_number: applicationNumber,
              embassy,
              expires_at: expiresAt
            });
          } else if (/INSERT INTO telegram_preferences/i.test(sql)) {
            if (statement.args.length === 5) {
              const [chatId, frequency, startedAt, hour, timeZone] = statement.args;
              const existing = preferenceRows.get(String(chatId));
              preferenceRows.set(String(chatId), {
                chat_id: String(chatId),
                digest_frequency: frequency,
                last_digest_sent: existing ? existing.last_digest_sent : null,
                digest_started_at: startedAt,
                digest_hour: hour,
                digest_timezone: timeZone
              });
            } else {
              const [chatId, hour, timeZone] = statement.args;
              preferenceRows.set(String(chatId), {
                chat_id: String(chatId),
                digest_frequency: 'off',
                last_digest_sent: null,
                digest_started_at: null,
                digest_hour: hour,
                digest_timezone: timeZone
              });
            }
          } else if (/UPDATE telegram_preferences SET digest_frequency = 'off'/i.test(sql)) {
            const preference = preferenceRows.get(String(statement.args[0]));
            if (preference) {
              preference.digest_frequency = 'off';
              preference.last_digest_sent = null;
              preference.digest_started_at = null;
            }
          } else if (/UPDATE telegram_preferences SET last_digest_sent = \?/i.test(sql)) {
            const preference = preferenceRows.get(String(statement.args[1]));
            if (preference) preference.last_digest_sent = statement.args[0];
          } else if (/DELETE FROM telegram_links WHERE token = \?/i.test(sql)) {
            linkRows.delete(statement.args[0]);
          } else if (/DELETE FROM telegram_links WHERE datetime\(expires_at\)/i.test(sql)) {
            for (const [token, link] of linkRows) {
              if (new Date(link.expires_at).getTime() <= Date.now()) linkRows.delete(token);
            }
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
          if (/SELECT 1 AS linked FROM telegram_subscriptions WHERE chat_id = \?/i.test(sql)) {
            return subscriptionRows.some((row) =>
              row.chat_id === statement.args[0] &&
              row.application_number === statement.args[1] &&
              row.active
            ) ? { linked: 1 } : null;
          }
          if (/FROM telegram_preferences WHERE chat_id = \?/i.test(sql)) {
            const preference = preferenceRows.get(String(statement.args[0]));
            return preference ? { ...preference } : null;
          }
          return null;
        },
        async all() {
          if (/FROM telegram_subscriptions WHERE chat_id = \?/i.test(sql)) {
            const results = subscriptionRows
              .filter((row) => row.chat_id === statement.args[0] && row.active)
              .map((row) => ({
                application_number: row.application_number,
                embassy: row.embassy,
                immediate: row.immediate == null ? 1 : row.immediate,
                last_alert_sent: row.last_alert_sent || null
              }));
            return { results };
          }
          return { results: [] };
        }
      };
      return statement;
    }
  };

  return { db, linkRows, subscriptionRows, preferenceRows };
}

function telegramEnv(db, extra = {}) {
  return {
    DB: db,
    ASSETS: reportAssets(),
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...extra
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

/** Serve the report files from memory so /digest preview never uses the network. */
function reportAssets() {
  const files = new Map([
    ['/data/visa_decisions.json', [{ date: '2026-11-16', number: '85444062', decision: 'Approved' }]],
    ['/data/data_manifest.json', { offices: [] }],
    ['/data/reports/index.json', { offices: {} }]
  ]);
  for (const slug of ['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara']) {
    files.set('/data/embassy-' + slug + '.json', {
      office: slug,
      report_date: '2026-11-16',
      decisions: []
    });
  }
  return {
    async fetch(input) {
      const path = new URL(typeof input === 'string' ? input : input.url).pathname;
      if (!files.has(path)) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(files.get(path)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
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
      {
        chat_id: '123456789',
        application_number: '85444062',
        embassy: 'new-delhi',
        active: 1,
        immediate: 1,
        last_alert_sent: '2026-11-16'
      }
    ]);
    assert.equal(api.sent.length, 1);
    assert.equal(api.sent[0].chat_id, '123456789');
    assert.match(api.sent[0].text, /Alerts enabled for 85444062 \(new-delhi\)/);

    // The token is single-use: replaying it must not create a second link.
    const replay = await handleTelegramWebhook(
      webhookRequest(123456789, '/start valid-token'),
      telegramEnv(db)
    );
    assert.equal(replay.status, 200);
    assert.equal(subscriptionRows.length, 1);
    assert.match(api.sent[1].text, /invalid or has expired/);
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
