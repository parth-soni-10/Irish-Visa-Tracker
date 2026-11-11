import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotification } from '../functions/notifications.js';

test('createNotification stores a bounded inbox entry', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { calls.push({ sql, args: this.args }); return { success: true }; }
      };
    }
  };
  const saved = await createNotification({ DB: db }, {
    userId: 'user-1',
    title: 'Visa Approved: 12345678',
    body: 'Published 2026-11-11',
    url: '/?q=12345678'
  });
  assert.equal(saved, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO user_notifications/);
  assert.equal(calls[0].args[1], 'user-1');
  assert.equal(calls[0].args[3], 'Visa Approved: 12345678');
});

test('createNotification is best-effort when persistence fails', async () => {
  const db = { prepare() { return { bind() { return this; }, async run() { throw new Error('D1 down'); } }; } };
  assert.equal(await createNotification({ DB: db }, { userId: 'u', title: 'x' }), false);
});
