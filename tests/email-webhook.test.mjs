import test from 'node:test';
import assert from 'node:assert/strict';
import { handleEmailWebhook } from '../functions/email-webhook.js';

function request(body) {
  return new Request('https://example.test/api/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const env = {
  EMAIL_WEBHOOK_SECRET: 'fixture-webhook-secret',
  RESEND_API_KEY: 're_fixture',
  EMAIL_FROM: 'Irish Visa Tracker <alerts@example.test>'
};

test('email webhook translates the provider-neutral payload for Resend', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ id: 'email_fixture' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const response = await handleEmailWebhook(request({
    secret: env.EMAIL_WEBHOOK_SECRET,
    from: env.EMAIL_FROM,
    to: 'applicant@example.test',
    subject: 'Visa decision',
    html: '<p>Approved</p>',
    text: 'Approved'
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, id: 'email_fixture' });
  assert.equal(captured.url, 'https://api.resend.com/emails');
  assert.equal(captured.init.headers.Authorization, 'Bearer re_fixture');
  assert.deepEqual(JSON.parse(captured.init.body), {
    from: env.EMAIL_FROM,
    to: ['applicant@example.test'],
    subject: 'Visa decision',
    html: '<p>Approved</p>',
    text: 'Approved'
  });
});

test('email webhook rejects a wrong secret before calling the provider', async () => {
  const response = await handleEmailWebhook(request({
    secret: 'wrong',
    to: 'applicant@example.test',
    subject: 'Visa decision'
  }), env);
  assert.equal(response.status, 401);
});

test('email webhook stays disabled when provider credentials are absent', async () => {
  const response = await handleEmailWebhook(request({
    secret: env.EMAIL_WEBHOOK_SECRET,
    to: 'applicant@example.test',
    subject: 'Visa decision'
  }), { ...env, RESEND_API_KEY: '' });
  assert.equal(response.status, 503);
});
