import test from 'node:test';
import assert from 'node:assert/strict';
import { createAPIToken, hashToken, validateAPIToken } from '../functions/auth.js';

function tokenDb(record = null) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { calls.push({ sql, args: this.args }); return { success: true }; },
        async first() {
          calls.push({ sql, args: this.args });
          return record;
        }
      };
      return statement;
    }
  };
}

test('Private export token hashing is deterministic and does not store the plaintext', async () => {
  const first = await hashToken('vt_example-token');
  const second = await hashToken('vt_example-token');
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, 'vt_example-token');
});

test('createAPIToken returns the private token once and stores only its digest', async () => {
  const db = tokenDb();
  const created = await createAPIToken({ DB: db }, 'user-1', 'dashboard', ['read'], 30);
  assert.match(created.token, /^vt_[a-z0-9]+$/);
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  const insert = db.calls.find((call) => /INSERT INTO api_tokens/.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.args[1], await hashToken(created.token));
  assert.notEqual(insert.args[1], created.token);
});

test('validateAPIToken rejects unknown and malformed tokens', async () => {
  assert.equal(await validateAPIToken({ DB: tokenDb(null) }, 'not-a-token'), null);
  assert.equal(await validateAPIToken({ DB: tokenDb(null) }, 'vt_missing'), null);
});

test('validateAPIToken returns scopes and touches last_used_at', async () => {
  const db = tokenDb({
    id: 'token-1',
    user_id: 'user-1',
    name: 'dashboard',
    scopes: '["read"]',
    expires_at: '2099-01-01',
    email: 'user@example.com',
    user_name: 'User'
  });
  const record = await validateAPIToken({ DB: db }, 'vt_abc123');
  assert.equal(record.userId, 'user-1');
  assert.deepEqual(record.scopes, ['read']);
  assert.ok(db.calls.some((call) => /UPDATE api_tokens SET last_used_at/.test(call.sql)));
});
