import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anyChannelConfigured,
  isChannelConfigured,
  sendChannel,
  sendChannelTest
} from '../functions/notify-channels.js';

const env = {
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'token_test',
  TWILIO_SMS_FROM: '+15550001111',
  TWILIO_WHATSAPP_FROM: 'whatsapp:+15550002222'
};

test('SMS and WhatsApp configuration requires SID, token and a sender', () => {
  assert.equal(isChannelConfigured(env, 'sms'), true);
  assert.equal(isChannelConfigured(env, 'whatsapp'), true);
  assert.equal(anyChannelConfigured(env), true);
  assert.equal(isChannelConfigured({ TWILIO_ACCOUNT_SID: 'AC' }, 'sms'), false);
  assert.equal(anyChannelConfigured({}), false);
});

test('sendChannel returns an explicit disabled result without credentials', async () => {
  const result = await sendChannel({}, 'sms', '+353871234567', 'hello');
  assert.equal(result.sent, 0);
  assert.equal(result.disabled, true);
  assert.match(result.error, /not configured/);
});

test('sendChannel validates international recipients before calling Twilio', async () => {
  const result = await sendChannel(env, 'whatsapp', '0871234567', 'hello');
  assert.equal(result.sent, 0);
  assert.equal(result.disabled, false);
  assert.match(result.error, /international phone number/);
});

test('sendChannel posts a Twilio message and normalizes the WhatsApp sender', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ sid: 'SM_test' }), { status: 201 });
  };
  try {
    const result = await sendChannel(env, 'whatsapp', 'whatsapp:+353871234567', 'Visa update');
    assert.deepEqual(result, { sent: 1, disabled: false, sid: 'SM_test' });
    assert.match(request.url, /\/Accounts\/AC_test\/Messages\.json$/);
    assert.equal(request.options.method, 'POST');
    assert.match(request.options.headers.Authorization, /^Basic /);
    const body = new URLSearchParams(request.options.body);
    assert.equal(body.get('To'), 'whatsapp:+353871234567');
    assert.equal(body.get('From'), 'whatsapp:+15550002222');
    assert.equal(body.get('Body'), 'Visa update');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendChannel reports Twilio errors without claiming delivery', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('invalid number', { status: 400 });
  try {
    const result = await sendChannel(env, 'sms', '+353871234567', 'hello');
    assert.equal(result.sent, 0);
    assert.equal(result.disabled, false);
    assert.match(result.error, /Twilio rejected the message \(400\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendChannelTest uses the configured channel and a compliance message', async () => {
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => {
    body = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ sid: 'SM_test' }), { status: 201 });
  };
  try {
    const result = await sendChannelTest(env, 'sms', '+353871234567');
    assert.equal(result.sent, 1);
    assert.match(body.get('Body'), /Irish Visa Tracker test/);
    assert.match(body.get('Body'), /STOP/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
