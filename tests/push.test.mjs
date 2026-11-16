import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  ensurePushSchema,
  isPushConfigured,
  sendDecisionPush,
  subscribeToPush,
  unsubscribeFromPush,
  webPush
} from '../functions/push.js';

/** Adapt the synchronous SQLite API to the small D1 surface push.js uses. */
function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async first() { return statement.get(...bound) || null; },
        async all() { return { results: statement.all(...bound) }; },
        async run() { statement.run(...bound); return { success: true }; }
      };
    }
  };
}

test('push requires both VAPID keys', () => {
  assert.equal(isPushConfigured({}), false);
  assert.equal(isPushConfigured({ VAPID_PUBLIC_KEY: 'public-only' }), false);
  assert.equal(isPushConfigured({ VAPID_PRIVATE_KEY: 'private-only' }), false);
  assert.equal(isPushConfigured({ VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' }), true);
});

test('migrates push subscriptions and keeps both offices for one application', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      application_number TEXT,
      embassy TEXT,
      embassy_slug TEXT,
      last_alert_sent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_push_endpoint_app
      ON push_subscriptions(endpoint, application_number);
    INSERT INTO push_subscriptions
      (endpoint, p256dh, auth, application_number, embassy, embassy_slug)
    VALUES
      ('https://push.example/subscription', 'p256dh', 'auth', '48850812', 'new-delhi', NULL);
  `);

  const vapid = webPush.generateVAPIDKeys();
  const env = {
    DB: sqliteD1(sqlite),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: 'mailto:test@example.com'
  };
  const endpoint = 'https://push.example/subscription';
  const subscription = { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } };

  assert.equal(await ensurePushSchema(env), true);
  const migrated = sqlite.prepare(
    'SELECT embassy, embassy_slug FROM push_subscriptions WHERE application_number = ?'
  ).get('48850812');
  assert.equal(migrated.embassy, 'new-delhi');
  assert.equal(migrated.embassy_slug, 'new-delhi');
  const indexes = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_push_endpoint%'"
  ).all().map((row) => row.name);
  assert.deepEqual(indexes, ['idx_push_endpoint_app_office']);

  assert.equal((await subscribeToPush(env, subscription, '48850812', 'new-delhi')).success, true);
  assert.equal((await subscribeToPush(env, subscription, '48850812', 'beijing')).success, true);
  let rows = sqlite.prepare(
    'SELECT embassy_slug FROM push_subscriptions WHERE endpoint = ? ORDER BY embassy_slug'
  ).all(endpoint);
  assert.deepEqual(rows.map((row) => row.embassy_slug), ['beijing', 'new-delhi']);

  assert.equal((await unsubscribeFromPush(env, endpoint, '48850812', 'beijing')).success, true);
  rows = sqlite.prepare(
    'SELECT embassy_slug FROM push_subscriptions WHERE endpoint = ? ORDER BY embassy_slug'
  ).all(endpoint);
  assert.deepEqual(rows.map((row) => row.embassy_slug), ['new-delhi']);
});

test('unsubscribeFromPush can still remove the whole browser endpoint', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      const call = { sql, args: [] };
      calls.push(call);
      return {
        bind(...args) { call.args = args; return this; },
        async run() { return { success: true }; }
      };
    }
  };
  const result = await unsubscribeFromPush({ DB: db }, 'https://push.example/subscription');
  assert.equal(result.success, true);
  assert.doesNotMatch(calls[0].sql, /application_number/);
  assert.deepEqual(calls[0].args, ['https://push.example/subscription']);
});

test('sendDecisionPush sends the encrypted push through fetch', async () => {
  const vapid = webPush.generateVAPIDKeys();
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rawPublicKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(-65);
  const endpoint = 'https://wns2-db5p.notify.windows.com/w/?token=test';
  const p256dh = rawPublicKey.toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() { return {}; },
        async all() { return { results: [{ endpoint, p256dh, auth }] }; },
        async run() { return { success: true }; }
      };
    }
  };
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response('', { status: 201 });
  };
  try {
    const result = await sendDecisionPush({
      DB: db,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.com'
    }, 'IRL2026123456', 'Approved', 'new-delhi');
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(captured.url, endpoint);
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['Content-Encoding'], 'aes128gcm');
    assert.match(captured.options.headers.Authorization, /^vapid t=/);
    assert.ok(captured.options.body instanceof Uint8Array);
    assert.ok(captured.options.body.byteLength > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
