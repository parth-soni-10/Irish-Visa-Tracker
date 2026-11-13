import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleHealthCheck } from '../functions/health.js';

function healthRequest(method = 'GET') {
  return new Request('https://tracker.test/api/health', { method });
}

function healthyEnv() {
  return {
    CF_PAGES_COMMIT_SHA: 'abcdef1234567890',
    DB: {
      prepare() {
        return { first: async () => ({ 1: 1 }) };
      }
    },
    ASSETS: {
      fetch: async () => new Response(null, { status: 200 })
    }
  };
}

test('health succeeds only when D1 and a real asset respond', async () => {
  const response = await handleHealthCheck(healthyEnv(), healthRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.status, 'healthy');
  assert.equal(body.services.database, 'healthy');
  assert.equal(body.services.storage, 'healthy');
  assert.equal(body.commit, 'abcdef123456');
});

test('health returns 503 when a dependency is missing', async () => {
  const response = await handleHealthCheck({}, healthRequest());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'degraded');
  assert.equal(body.services.database, 'unhealthy');
  assert.equal(body.services.storage, 'not configured');
});

test('health supports HEAD without a body', async () => {
  const response = await handleHealthCheck(healthyEnv(), healthRequest('HEAD'));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
