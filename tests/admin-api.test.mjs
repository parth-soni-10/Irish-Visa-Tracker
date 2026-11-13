/**
 * Admin API contract tests.
 *
 *   node --test tests/admin-api.test.mjs
 *
 * The admin surface is deliberately separate from user auth: a bearer token is
 * required, named tokens are hashed at rest, revocation is immediate, and the
 * metrics endpoint never throws when an optional table is absent.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  handleAdminTokens,
  handleErrorLogs,
  handleSystemMetrics
} from '../functions/admin-api.js';
import { hashToken } from '../functions/auth.js';

const ROOT = new URL('../', import.meta.url);
const BOOTSTRAP = 'bootstrap-admin-token';

function request(path, options = {}) {
  return new Request('https://tracker.test' + path, options);
}

function authHeader(token) {
  return { Authorization: 'Bearer ' + token };
}

/** Small stateful D1 stand-in for the admin tables and metric queries. */
function adminDB() {
  const tokens = new Map();
  return {
    tokens,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/SELECT last_used_at FROM admin_tokens/.test(sql)) return { last_used_at: null };
          if (/FROM users/.test(sql)) return { count: 1, last_week: 1, last_month: 1 };
          if (/FROM email_subscriptions/.test(sql)) return { total: 2, active: 1 };
          if (/FROM telegram_subscriptions/.test(sql)) return { total: 3, active: 2 };
          if (/FROM admin_tokens\s+WHERE token_hash/.test(sql)) {
            const record = [...tokens.values()].find((item) => item.token_hash === this.args[0]);
            return record && !record.revoked ? { id: record.id } : null;
          }
          return { count: 0 };
        },
        async all() {
          if (/FROM admin_tokens ORDER BY created_at DESC/.test(sql)) {
            return { results: [...tokens.values()].map(({ token_hash, ...rest }) => rest) };
          }
          if (/FROM conversion_events/.test(sql)) {
            return { results: [{ event: 'alert_email_click', count: 2 }, { event: 'alert_email_submitted', count: 1 }] };
          }
          return { results: [] };
        },
        async run() {
          if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/.test(sql)) return { success: true };
          if (/INSERT INTO admin_tokens/.test(sql)) {
            const [id, token_hash, name, expires_at] = this.args;
            tokens.set(id, { id, token_hash, name, expires_at, revoked: 0, last_used_at: null });
            return { success: true };
          }
          if (/UPDATE admin_tokens SET last_used_at/.test(sql)) return { success: true };
          if (/UPDATE admin_tokens SET revoked = 1/.test(sql)) {
            const record = tokens.get(this.args[0]);
            if (record) record.revoked = 1;
            return { meta: { changes: record ? 1 : 0 } };
          }
          return { success: true };
        }
      };
      return statement;
    }
  };
}

/** Serve the committed data files without a network request. */
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const raw = input instanceof URL ? input.href : (typeof input === 'string' ? input : input.url);
    const url = new URL(raw, 'https://tracker.test');
    try {
      const body = await readFile(new URL('.' + url.pathname, ROOT), 'utf8');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  return () => { globalThis.fetch = original; };
}

function env(extra = {}) {
  return { ADMIN_DASHBOARD_TOKEN: BOOTSTRAP, DB: adminDB(), ...extra };
}

test('admin endpoints reject a missing or invalid bearer token', async () => {
  const missing = await handleSystemMetrics(request('/api/admin/metrics'), env());
  assert.equal(missing.status, 401);

  const wrong = await handleSystemMetrics(
    request('/api/admin/metrics', { headers: authHeader('wrong') }),
    env()
  );
  assert.equal(wrong.status, 401);

  const noDb = await handleSystemMetrics(
    request('/api/admin/metrics', { headers: authHeader(BOOTSTRAP) }),
    { ADMIN_DASHBOARD_TOKEN: BOOTSTRAP }
  );
  assert.equal(noDb.status, 503);
});

test('metrics expose subscription counts and conversion events', async () => {
  const restore = stubFetch();
  try {
    const response = await handleSystemMetrics(
      request('/api/admin/metrics', { headers: authHeader(BOOTSTRAP) }),
      env()
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.users.total, 1);
    assert.equal(body.subscriptions.email.active, 1);
    assert.equal(body.subscriptions.telegram.active, 2);
    assert.equal(body.product.conversions.alert_email_click, 2);
    assert.equal(body.product.conversions.alert_email_submitted, 1);
    assert.ok(body.dataVolume.visa_decisions > 0);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  } finally {
    restore();
  }
});

test('named admin tokens are hashed, listed, and revoked immediately', async () => {
  const restore = stubFetch();
  try {
    const environment = env();
    const createdResponse = await handleAdminTokens(
      request('/api/admin/tokens', {
        method: 'POST',
        headers: { ...authHeader(BOOTSTRAP), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'on-call laptop', expiresDays: 30 })
      }),
      environment
    );
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.match(created.token, /^admin_[a-z0-9]+$/);
    assert.notEqual(environment.DB.tokens.get(created.id).token_hash, created.token);
    assert.equal(environment.DB.tokens.get(created.id).token_hash, await hashToken(created.token));

    const listedResponse = await handleAdminTokens(
      request('/api/admin/tokens', { headers: authHeader(created.token) }),
      environment
    );
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.equal(listed.tokens.length, 1);
    assert.equal(listed.tokens[0].name, 'on-call laptop');

    const revokedResponse = await handleAdminTokens(
      request('/api/admin/tokens?id=' + encodeURIComponent(created.id), {
        method: 'DELETE',
        headers: authHeader(created.token)
      }),
      environment
    );
    assert.equal(revokedResponse.status, 200);

    const afterRevoke = await handleSystemMetrics(
      request('/api/admin/metrics', { headers: authHeader(created.token) }),
      environment
    );
    assert.equal(afterRevoke.status, 401);
  } finally {
    restore();
  }
});

test('the error endpoint is explicit about the absent external tracker', async () => {
  const response = await handleErrorLogs(
    request('/api/admin/errors', { headers: authHeader(BOOTSTRAP) }),
    env()
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.logs, []);
});
