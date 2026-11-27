import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleFailureAlert } from '../functions/alert-endpoint.js';

const ENV = {
  ALERT_ENDPOINT_SECRET: 'test-token-12345',
  ALERT_EMAIL_TO: 'owner@example.test',
  EMAIL_FROM: 'tracker@example.test',
  RESEND_API_KEY: 're_test_key'
};

const MESSAGE = [
  'Irish Visa Tracker workflow failed: Scrape Visa Decisions',
  'Conclusion: failure',
  'Triggered by: schedule',
  'Run: https://github.com/o/r/actions/runs/1'
].join('\n');

function post({ token = ENV.ALERT_ENDPOINT_SECRET, body = { text: MESSAGE }, method = 'POST' } = {}) {
  const url = 'https://tracker.test/api/alert/failure' + (token === null ? '' : `?token=${encodeURIComponent(token)}`);
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

/** Replace fetch for one call and hand back what the endpoint sent. */
async function withFetch(t, respond, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond();
  };
  t.after(() => { globalThis.fetch = original; });
  const response = await run();
  const payload = calls[0] ? JSON.parse(calls[0].init.body) : null;
  return { response, calls, payload };
}

test('rejects a missing or wrong token', async () => {
  const missing = await handleFailureAlert(post({ token: null }), ENV);
  assert.equal(missing.status, 401);
  const wrong = await handleFailureAlert(post({ token: 'not-the-token' }), ENV);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, 'Unauthorized');
});

test('refuses to run without its configuration', async () => {
  const noToken = await handleFailureAlert(post(), { ...ENV, ALERT_ENDPOINT_SECRET: '' });
  assert.equal(noToken.status, 503);
  const noEmail = await handleFailureAlert(post(), { ...ENV, ALERT_EMAIL_TO: '' });
  assert.equal(noEmail.status, 503);
  const noKey = await handleFailureAlert(post(), { ...ENV, RESEND_API_KEY: '' });
  assert.equal(noKey.status, 503);
});

test('only accepts POST', async () => {
  assert.equal((await handleFailureAlert(post({ method: 'GET' }), ENV)).status, 405);
});

test('requires a text message', async () => {
  assert.equal((await handleFailureAlert(post({ body: { text: '   ' } }), ENV)).status, 400);
  assert.equal((await handleFailureAlert(post({ body: {} }), ENV)).status, 400);
});

test('emails the alert through Resend with no credential in the body', async (t) => {
  const { response, payload, calls } = await withFetch(
    t,
    () => new Response(JSON.stringify({ id: 'mail_1' }), { status: 200 }),
    () => handleFailureAlert(post(), ENV)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: 'mail_1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
  assert.equal(payload.from, 'tracker@example.test');
  assert.deepEqual(payload.to, ['owner@example.test']);
  assert.match(payload.subject, /^\[Irish Visa Tracker\] Irish Visa Tracker workflow failed: Scrape Visa Decisions$/);
  assert.equal(payload.text, MESSAGE);
  assert.match(payload.html, /<pre/);
  assert.ok(!JSON.stringify(payload).includes('re_test_key'), 'the API key never enters the payload');
});

test('reports a provider rejection without leaking its body', async (t) => {
  const { response } = await withFetch(
    t,
    () => new Response('{"message":"domain not verified"}', { status: 403 }),
    () => handleFailureAlert(post(), ENV)
  );
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'Email provider rejected the alert');
  assert.ok(!JSON.stringify(body).includes('domain not verified'));
});
