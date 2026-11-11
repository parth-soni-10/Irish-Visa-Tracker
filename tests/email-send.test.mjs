import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmailConfigured, sendEmail } from '../functions/email-send.js';

test('email delivery requires both a webhook URL and secret', () => {
  assert.equal(isEmailConfigured({}), false);
  assert.equal(isEmailConfigured({ EMAIL_WEBHOOK_URL: 'https://example.test/hook' }), false);
  assert.equal(isEmailConfigured({ EMAIL_WEBHOOK_SECRET: 'secret' }), false);
  assert.equal(
    isEmailConfigured({
      EMAIL_WEBHOOK_URL: 'https://example.test/hook',
      EMAIL_WEBHOOK_SECRET: 'secret'
    }),
    true
  );
});

test('sendEmail posts the message contract to the configured webhook', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const result = await sendEmail(
      {
        EMAIL_WEBHOOK_URL: 'https://example.test/hook',
        EMAIL_WEBHOOK_SECRET: 'webhook-secret',
        EMAIL_FROM: 'alerts@example.test'
      },
      {
        to: 'applicant@example.test',
        subject: 'Visa decision',
        html: '<p>Approved</p>',
        text: 'Approved'
      }
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(request.url, 'https://example.test/hook');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {
      secret: 'webhook-secret',
      to: 'applicant@example.test',
      from: 'alerts@example.test',
      subject: 'Visa decision',
      html: '<p>Approved</p>',
      text: 'Approved'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendEmail rejects a non-2xx webhook response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('not configured', { status: 503 });

  try {
    await assert.rejects(
      sendEmail(
        {
          EMAIL_WEBHOOK_URL: 'https://example.test/hook',
          EMAIL_WEBHOOK_SECRET: 'webhook-secret'
        },
        { to: 'applicant@example.test', subject: 'Visa decision', text: 'Approved' }
      ),
      /Email webhook failed: 503/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
