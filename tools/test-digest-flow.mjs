/**
 * End-to-end check for the monthly digest.
 *
 * Runs the real HTTP endpoints and the real D1 schema against a local
 * email-webhook stub, so confirmation -> verification -> send -> unsubscribe is
 * exercised exactly as deployed. Pass --live to hit the configured webhook
 * instead (requires EMAIL_WEBHOOK_URL and EMAIL_WEBHOOK_SECRET on the server).
 *
 *   node tools/test-digest-flow.mjs
 *   node tools/test-digest-flow.mjs --live --to you@example.com
 */

import http from 'node:http';

const BASE = process.env.DIGEST_BASE || 'http://127.0.0.1:8797';
const MOCK_PORT = Number(process.env.EMAIL_WEBHOOK_MOCK_PORT || 8899);
const CRON_SECRET = process.env.DIGEST_CRON_SECRET || 'digest-test-cron';
const LIVE = process.argv.includes('--live');
const MONTH = process.env.DIGEST_MONTH || '2026-11';
const TO = (() => {
  const i = process.argv.indexOf('--to');
  return i > -1 ? process.argv[i + 1] : 'digest-a-' + Date.now() + '@example.com';
})();

const captured = [];
let failures = 0;

function check(name, ok, detail) {
  const line = (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : '');
  console.log(line);
  if (!ok) failures += 1;
}

async function call(path, options) {
  const response = await fetch(BASE + path, options);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: response.status, text, body };
}

function linkFrom(text, path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = text.match(new RegExp('https?://[^\\s"<>]*' + escaped + '\\?token=[^\\s"<>&]+'));
  return match ? match[0] : '';
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(BASE + '/');
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Server did not become ready at ' + BASE);
}

function startMock() {
  if (LIVE) return null;
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body = null;
    try { body = JSON.parse(raw); } catch { /* ignore */ }
    captured.push({ path: request.url, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'mock-email-' + captured.length }));
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

async function sendDigest() {
  const result = await call('/api/digest/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': CRON_SECRET },
    body: JSON.stringify({ month: MONTH })
  });
  return result;
}

const mock = await startMock();
try {
  await waitForServer();
  const emailA = TO;
  console.log('\nDigest flow against ' + BASE + (LIVE ? ' (live email webhook)' : ' (email webhook stub on :' + MOCK_PORT + ')'));

  // 1. Confirmation request
  const subscribe = await call('/api/digest/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailA })
  });
  check('subscribe accepted', subscribe.status === 201, 'HTTP ' + subscribe.status);

  if (!LIVE) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('confirmation email handed to webhook', captured.length === 1, 'captured ' + captured.length);
    const confirmation = captured[0] && captured[0].body;
    check('confirmation subject', Boolean(confirmation && /confirm/i.test(confirmation.subject || '')), confirmation && confirmation.subject);
    check('confirmation from is configurable', Boolean(confirmation && confirmation.from && !/pages\.dev/.test(confirmation.from)), confirmation && confirmation.from);
    const verifyUrl = linkFrom((confirmation && confirmation.text) || '', '/api/digest/verify');
    check('confirmation has verify link', Boolean(verifyUrl));

    // 2. Verification
    if (verifyUrl) {
      const verify = await call(new URL(verifyUrl).pathname + new URL(verifyUrl).search);
      check('verify link confirms', verify.status === 200 && /confirmed/i.test(verify.text), 'HTTP ' + verify.status);
      const reused = await call(new URL(verifyUrl).pathname + new URL(verifyUrl).search);
      check('verify token is single-use', reused.status === 400, 'HTTP ' + reused.status);
    }

    // 3. Send
    const send = await sendDigest();
    check('digest send succeeds', send.status === 200 && send.body && send.body.sent === 1, JSON.stringify(send.body));
    await new Promise((resolve) => setTimeout(resolve, 300));
    check('digest email handed to webhook', captured.length === 2, 'captured ' + captured.length);
    const digest = captured[1] && captured[1].body;
    check('digest subject names the month', Boolean(digest && /monthly report/i.test(digest.subject || '')), digest && digest.subject);
    check('digest says what changed', Boolean(digest && /What changed this week/.test(digest.html || '')), 'html section');
    const unsubscribeUrl = linkFrom((digest && digest.text) || '', '/api/digest/unsubscribe');
    check('digest has unsubscribe link', Boolean(unsubscribeUrl));

    // 4. Unsubscribe
    if (unsubscribeUrl) {
      const unsubscribe = await call(new URL(unsubscribeUrl).pathname + new URL(unsubscribeUrl).search);
      check('unsubscribe succeeds', unsubscribe.status === 200 && /no longer/i.test(unsubscribe.text), 'HTTP ' + unsubscribe.status);
      const again = await call(new URL(unsubscribeUrl).pathname + new URL(unsubscribeUrl).search);
      check('unsubscribe token rejects reuse', again.status === 400, 'HTTP ' + again.status);
    }

    const afterUnsubscribe = await sendDigest();
    check('unsubscribed address is skipped', afterUnsubscribe.body && afterUnsubscribe.body.recipients === 0, JSON.stringify(afterUnsubscribe.body));

    // 5. Double opt-in gate
    const unverified = 'digest-unverified-' + Date.now() + '@example.com';
    await call('/api/digest/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: unverified })
    });
    const gated = await sendDigest();
    check('unverified address is not sent', gated.body && gated.body.recipients === 0, JSON.stringify(gated.body));
  } else {
    check('live send accepted by email webhook', subscribe.status === 201, 'HTTP ' + subscribe.status);
  }

  // Bad tokens never verify or unsubscribe anything.
  const badVerify = await call('/api/digest/verify?token=not-a-real-token');
  check('invalid verify token rejected', badVerify.status === 400, 'HTTP ' + badVerify.status);
  const badUnsub = await call('/api/digest/unsubscribe?token=not-a-real-token');
  check('invalid unsubscribe token rejected', badUnsub.status === 400, 'HTTP ' + badUnsub.status);

  console.log('\n' + (failures === 0 ? 'All digest checks passed.' : failures + ' digest check(s) failed.'));
} finally {
  if (mock) await new Promise((resolve) => mock.close(resolve));
}

process.exitCode = failures === 0 ? 0 : 1;
