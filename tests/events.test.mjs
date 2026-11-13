import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleEvents } from '../functions/events.js';

function request(body, method = 'POST') {
  return new Request('https://tracker.test/api/events', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
}

function eventDB() {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (/INSERT INTO conversion_events/.test(sql)) inserts.push(this.args);
          return { success: true };
        }
      };
    }
  };
}

test('conversion events accept only the fixed vocabulary', async () => {
  const env = { DB: eventDB() };
  const accepted = await handleEvents(request({ event: 'alert_email_click', source: 'home' }), env);
  assert.equal(accepted.status, 202);
  assert.deepEqual(env.DB.inserts, [['alert_email_click', 'home', null]]);

  const rejected = await handleEvents(request({ event: 'pasted-free-text', source: 'home' }), env);
  assert.equal(rejected.status, 400);
  assert.equal(env.DB.inserts.length, 1);
});

test('application numbers are stored only when they are public eight-digit values', async () => {
  const env = { DB: eventDB() };
  await handleEvents(request({
    event: 'application_search',
    source: 'home',
    application_number: '12345678'
  }), env);
  await handleEvents(request({
    event: 'application_search',
    source: 'home',
    application_number: '1234'
  }), env);
  assert.deepEqual(env.DB.inserts, [
    ['application_search', 'home', '12345678'],
    ['application_search', 'home', null]
  ]);
});

test('the event endpoint rejects non-POST requests and a missing database', async () => {
  const get = await handleEvents(request({}, 'GET'), { DB: eventDB() });
  assert.equal(get.status, 405);

  const noDb = await handleEvents(request({ event: 'alert_cta_view' }), {});
  assert.equal(noDb.status, 503);
});
