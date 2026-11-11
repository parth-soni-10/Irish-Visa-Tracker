import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { isPushConfigured, sendPushToUser, webPush } from '../functions/push.js';

test('push requires both VAPID keys', () => {
  assert.equal(isPushConfigured({}), false);
  assert.equal(isPushConfigured({ VAPID_PUBLIC_KEY: 'public-only' }), false);
  assert.equal(isPushConfigured({ VAPID_PRIVATE_KEY: 'private-only' }), false);
  assert.equal(isPushConfigured({ VAPID_PUBLIC_KEY: 'public', VAPID_PRIVATE_KEY: 'private' }), true);
});

test('sendPushToUser sends the encrypted push through fetch', async () => {
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
    const result = await sendPushToUser({
      DB: db,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:test@example.com'
    }, 'user-1', { title: 'Test', body: 'Push body' });
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
