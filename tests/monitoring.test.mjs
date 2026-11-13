import assert from 'node:assert/strict';
import { test } from 'node:test';

import monitor from '../monitoring/worker.js';
import { buildWebhookPayload, sendAlert } from '../tools/alert-webhook.mjs';
import { getRequestId, logEvent, logRequest, withRequestId } from '../functions/monitoring.js';

test('structured logs are JSON and omit query strings', () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    logEvent('info', 'test_event', { route: '/api/health' });
    logRequest({
      request: new Request('https://tracker.test/api/search?q=private-value', { method: 'GET' }),
      response: new Response('{}', { status: 200 }),
      requestId: 'req-12345678',
      startedAt: Date.now() - 5
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  const second = JSON.parse(lines[1]);
  assert.equal(first.event, 'test_event');
  assert.equal(first.service, 'irish-visa-tracker');
  assert.equal(second.path, '/api/search');
  assert.equal(second.request_id, 'req-12345678');
  assert.doesNotMatch(lines[1], /private-value/);
});

test('request ids prefer a safe CF-Ray and fall back to a UUID', () => {
  const withRay = new Request('https://tracker.test/', { headers: { 'cf-ray': '8a1b2c3d4e5f-SIN' } });
  assert.equal(getRequestId(withRay), '8a1b2c3d4e5f-SIN');
  const withoutRay = new Request('https://tracker.test/');
  assert.match(getRequestId(withoutRay), /^[0-9a-f-]{36}$/);
});

test('private API responses default to no-store while explicit public caching survives', () => {
  const privateResponse = withRequestId(
    new Response('{}'),
    'req-12345678',
    new Request('https://tracker.test/api/auth/me')
  );
  assert.equal(privateResponse.headers.get('Cache-Control'), 'no-store');

  const publicResponse = withRequestId(
    new Response('{}', { headers: { 'Cache-Control': 'public, max-age=3600' } }),
    'req-12345678',
    new Request('https://tracker.test/api/user/push/key')
  );
  assert.equal(publicResponse.headers.get('Cache-Control'), 'public, max-age=3600');
});

test('webhook payloads match the configured provider', () => {
  assert.deepEqual(buildWebhookPayload('https://hooks.slack.com/services/x', 'down'), { text: 'down' });
  assert.deepEqual(buildWebhookPayload('https://discord.com/api/webhooks/x', 'down'), {
    content: 'down',
    username: 'Visa Decision Tracker'
  });
  assert.deepEqual(buildWebhookPayload('https://api.telegram.org/bot1/sendMessage?chat_id=42', 'down'), {
    chat_id: '42',
    text: 'down'
  });
  assert.deepEqual(buildWebhookPayload('https://alerts.example.test/hook', 'down'), { text: 'down' });
});

test('sendAlert reports HTTP failures instead of silently succeeding', async () => {
  const result = await sendAlert('https://alerts.example.test/hook', 'down', {
    fetchImpl: async () => new Response('nope', { status: 500 })
  }).catch((error) => error);
  assert.match(String(result.message), /HTTP 500/);
});

test('monitor Worker records a healthy Pages response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://tracker.test/api/health');
    return new Response(JSON.stringify({
      status: 'healthy',
      services: { database: 'healthy', storage: 'healthy' },
      commit: 'abc123'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await monitor.scheduled({ cron: '*/10 * * * *' }, {
      APP_BASE_URL: 'https://tracker.test'
    });
    assert.equal(result.ok, true);
    assert.equal(result.status_code, 200);
    assert.equal(result.commit, 'abc123');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
