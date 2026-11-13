import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRateLimit } from '../functions/rate-limit.js';

function counterDB() {
  const counts = new Map();
  return {
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { return { success: true }; },
        async first() {
          if (/INSERT INTO rate_limits/.test(sql)) {
            const key = this.args.slice(0, 3).join('|');
            const count = (counts.get(key) || 0) + 1;
            counts.set(key, count);
            return { count };
          }
          return null;
        }
      };
      return statement;
    }
  };
}

test('the D1 limiter counts a shared fixed window and blocks over the limit', async () => {
  const env = { DB: counterDB() };
  const options = {
    bucket: 'test-api',
    subject: '203.0.113.10',
    limit: 2,
    windowSeconds: 60
  };

  const first = await checkRateLimit(env, options);
  const second = await checkRateLimit(env, options);
  const third = await checkRateLimit(env, options);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(third.durable, true);
  assert.ok(third.retryAfter >= 1);
});

test('different buckets do not share a counter', async () => {
  const env = { DB: counterDB() };
  const base = { subject: '203.0.113.11', limit: 1, windowSeconds: 60 };
  assert.equal((await checkRateLimit(env, { ...base, bucket: 'api' })).allowed, true);
  assert.equal((await checkRateLimit(env, { ...base, bucket: 'auth' })).allowed, true);
  assert.equal((await checkRateLimit(env, { ...base, bucket: 'api' })).allowed, false);
});

test('a missing database falls back to a local limiter instead of failing open', async () => {
  const options = {
    bucket: 'fallback-test',
    subject: '203.0.113.12',
    limit: 1,
    windowSeconds: 60
  };
  const first = await checkRateLimit({}, options);
  const second = await checkRateLimit({}, options);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.durable, false);
});
