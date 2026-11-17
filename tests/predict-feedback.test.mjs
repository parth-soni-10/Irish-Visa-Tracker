import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequestGet, onRequestPost } from '../functions/api/predict-feedback.js';

function post(body) {
  return onRequestPost({
    request: new Request('https://tracker.test/api/predict/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }),
    env: { DB: feedbackDB() }
  });
}

function feedbackDB(samples = 0, mae = null, within = null) {
  const inserts = [];
  return {
    inserts,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (/INSERT INTO prediction_feedback/.test(sql)) inserts.push(this.args);
          return { success: true };
        },
        async first() {
          if (/FROM prediction_feedback/.test(sql)) {
            return {
              samples,
              baseline_mae: mae,
              within_14_day_share: within,
              first_at: samples ? '2026-11-01 00:00:00' : null,
              last_at: samples ? '2026-11-17 00:00:00' : null
            };
          }
          return null;
        }
      };
      return statement;
    }
  };
}

test('feedback stores anonymous dates and computes the baseline error', async () => {
  const db = feedbackDB();
  const response = await onRequestPost({
    request: new Request('https://tracker.test/api/predict/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embassy: 'new-delhi',
        visa_type: 'visit',
        application_date: '2026-01-01',
        decision_date: '2026-02-01'
      })
    }),
    env: { DB: db }
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.actual_days, 31);
  assert.equal(body.baseline_days, 40);
  assert.equal(body.baseline_error_days, 9);
  assert.equal(body.within_14_days, true);
  assert.equal(db.inserts.length, 1);
  assert.deepEqual(db.inserts[0].slice(1, 5), ['new-delhi', 'visit', '2026-01-01', '2026-02-01']);
});

test('feedback rejects invalid dates, offices and visa types', async () => {
  const invalid = await post({
    embassy: 'nowhere',
    visa_type: 'visit',
    application_date: '2026-01-01',
    decision_date: '2026-02-01'
  });
  assert.equal(invalid.status, 400);
  const reversed = await post({
    embassy: 'new-delhi',
    visa_type: 'visit',
    application_date: '2026-02-01',
    decision_date: '2026-01-01'
  });
  assert.equal(reversed.status, 400);
});

test('calibration metrics stay behind the minimum sample gate', async () => {
  const response = await onRequestGet({ env: { DB: feedbackDB(12, 7.4, 0.55) } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.calibration.meets_minimum_samples, false);
  assert.equal(body.calibration.baseline_mae, null);
  assert.equal(body.calibration.within_14_day_share, null);
  assert.match(body.calibration.note, /200/);
});

test('calibration metrics are exposed once the gate is met', async () => {
  const response = await onRequestGet({ env: { DB: feedbackDB(240, 7.42, 0.61) } });
  const body = await response.json();
  assert.equal(body.calibration.meets_minimum_samples, true);
  assert.equal(body.calibration.baseline_mae, 7.42);
  assert.equal(body.calibration.within_14_day_share, 61);
});
