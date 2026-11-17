import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequestGet, onRequestPost } from '../functions/api/predict-feedback.js';

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function feedbackDB({ community = [], feedback = [] } = {}) {
  const state = {
    community,
    feedback,
    inserts: [],
    limits: new Map()
  };

  return {
    state,
    prepare(sql) {
      const statement = {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (/INSERT INTO prediction_feedback/.test(sql)) {
            const [
              modelVersion, sourceSubmissionId, office, visaType,
              applied, decided, actualDays, baselineDays, errorDays, within14
            ] = this.args;
            if (state.feedback.some((row) => row.source_submission_id === sourceSubmissionId)) {
              throw new Error('UNIQUE constraint failed: prediction_feedback.source_submission_id');
            }
            state.feedback.push({
              model_version: modelVersion,
              source_submission_id: sourceSubmissionId,
              office,
              visa_type: visaType,
              application_date: applied,
              decision_date: decided,
              actual_days: actualDays,
              baseline_days: baselineDays,
              baseline_error: errorDays,
              within_14_days: within14,
              created_at: '2026-11-17 12:00:00'
            });
            state.inserts.push(this.args);
          }
          return { success: true };
        },
        async first() {
          if (/INSERT INTO rate_limits/.test(sql)) {
            const key = this.args.slice(0, 3).join('|');
            const count = (state.limits.get(key) || 0) + 1;
            state.limits.set(key, count);
            return { count };
          }
          if (/FROM submissions/.test(sql)) {
            const [applied, decided, office, visaType] = this.args;
            const match = state.community.find((row) => {
              const fields = row.fields;
              return fields.tracker === 'visa'
                && fields.applied === applied
                && fields.decided === decided
                && (!fields.embassy || fields.embassy === office)
                && (!fields.visa_type || fields.visa_type === visaType);
            });
            return match ? { id: match.id } : null;
          }
          if (/WHERE source_submission_id = \?/.test(sql)) {
            const match = state.feedback.find((row) => row.source_submission_id === this.args[0]);
            return match ? { id: match.id || 1 } : null;
          }
          if (/COUNT\(\*\) AS samples/.test(sql)) {
            const verified = state.feedback.filter((row) => row.source_submission_id != null);
            if (!verified.length) {
              return { samples: 0, baseline_mae: null, within_14_day_share: null, first_at: null, last_at: null };
            }
            return {
              samples: verified.length,
              baseline_mae: verified.reduce((sum, row) => sum + row.baseline_error, 0) / verified.length,
              within_14_day_share: verified.reduce((sum, row) => sum + row.within_14_days, 0) / verified.length,
              first_at: verified[0].created_at,
              last_at: verified[verified.length - 1].created_at
            };
          }
          return null;
        }
      };
      return statement;
    }
  };
}

function post(body, { db, ip = '203.0.113.20' } = {}) {
  return onRequestPost({
    request: new Request('https://tracker.test/api/predict/feedback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': ip
      },
      body: JSON.stringify(body)
    }),
    env: { DB: db }
  });
}

function communityRow(id, applied, decided, extra = {}) {
  return {
    id,
    form: 'timelines-visa',
    fields: {
      tracker: 'visa',
      applied,
      decided,
      outcome: 'granted',
      ...extra
    }
  };
}

test('feedback stores anonymous dates only when they match a community timeline', async () => {
  const db = feedbackDB({
    community: [communityRow(11, '2026-01-01', '2026-02-01')]
  });
  const response = await post({
    embassy: 'new-delhi',
    visa_type: 'visit',
    application_date: '2026-01-01',
    decision_date: '2026-02-01'
  }, { db });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.verified, true);
  assert.equal(body.actual_days, 31);
  assert.equal(body.baseline_days, 40);
  assert.equal(body.baseline_error_days, 9);
  assert.equal(body.within_14_days, true);
  assert.equal(db.state.inserts.length, 1);
  assert.equal(db.state.inserts[0][1], 11);
  assert.deepEqual(db.state.inserts[0].slice(2, 6), ['new-delhi', 'visit', '2026-01-01', '2026-02-01']);

  const calibration = await onRequestGet({ env: { DB: db } });
  const calibrationBody = await calibration.json();
  assert.equal(calibrationBody.calibration.samples, 1);
  assert.equal(calibrationBody.calibration.meets_minimum_samples, false);
});

test('feedback rejects dates that were never shared in the community timeline', async () => {
  const db = feedbackDB();
  const response = await post({
    embassy: 'new-delhi',
    visa_type: 'visit',
    application_date: '2026-01-01',
    decision_date: '2026-02-01'
  }, { db });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /community visa timeline/);
  assert.equal(db.state.inserts.length, 0);

  const calibration = await onRequestGet({ env: { DB: db } });
  assert.equal((await calibration.json()).calibration.samples, 0);
});

test('a community timeline can calibrate at most one sample', async () => {
  const db = feedbackDB({
    community: [communityRow(12, '2026-03-01', '2026-04-01')]
  });
  const first = await post({
    embassy: 'new-delhi',
    visa_type: 'study',
    application_date: '2026-03-01',
    decision_date: '2026-04-01'
  }, { db });
  assert.equal(first.status, 201);

  const duplicate = await post({
    embassy: 'beijing',
    visa_type: 'visit',
    application_date: '2026-03-01',
    decision_date: '2026-04-01'
  }, { db });
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /already been used/);
  assert.equal(db.state.inserts.length, 1);
});

test('one client cannot submit enough dates to unlock the calibration gate', async () => {
  const community = [];
  for (let index = 0; index < 200; index += 1) {
    const applied = addDays('2026-01-01', index);
    community.push(communityRow(1000 + index, applied, addDays(applied, 30)));
  }
  const db = feedbackDB({ community });
  const ip = '203.0.113.77';
  const outcomes = [];

  for (let index = 0; index < 200; index += 1) {
    const applied = addDays('2026-01-01', index);
    const response = await post({
      embassy: 'new-delhi',
      visa_type: 'visit',
      application_date: applied,
      decision_date: addDays(applied, 30)
    }, { db, ip });
    outcomes.push(response.status);
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }
  }

  assert.equal(outcomes.filter((status) => status === 201).length, 5);
  assert.equal(outcomes.filter((status) => status === 429).length, 195);
  assert.equal(db.state.inserts.length, 5);

  const calibration = await onRequestGet({ env: { DB: db } });
  const body = await calibration.json();
  assert.equal(body.calibration.samples, 5);
  assert.equal(body.calibration.meets_minimum_samples, false);
  assert.equal(body.calibration.baseline_mae, null);
  assert.equal(body.calibration.within_14_day_share, null);
});

test('legacy unverified feedback rows cannot unlock the metrics gate', async () => {
  const legacy = [];
  for (let index = 0; index < 240; index += 1) {
    legacy.push({
      id: index + 1,
      source_submission_id: null,
      baseline_error: 7,
      within_14_days: 1,
      created_at: '2026-11-01 00:00:00'
    });
  }
  const response = await onRequestGet({ env: { DB: feedbackDB({ feedback: legacy }) } });
  const body = await response.json();
  assert.equal(body.calibration.samples, 0);
  assert.equal(body.calibration.meets_minimum_samples, false);
  assert.equal(body.calibration.baseline_mae, null);
  assert.match(body.calibration.note, /verified community timelines/);
});

test('calibration metrics are exposed once verified samples reach the gate', async () => {
  const verified = [];
  for (let index = 0; index < 240; index += 1) {
    verified.push({
      id: index + 1,
      source_submission_id: 5000 + index,
      baseline_error: index % 2 === 0 ? 7 : 8,
      within_14_days: 1,
      created_at: '2026-11-01 00:00:00'
    });
  }
  const response = await onRequestGet({ env: { DB: feedbackDB({ feedback: verified }) } });
  const body = await response.json();
  assert.equal(body.calibration.samples, 240);
  assert.equal(body.calibration.meets_minimum_samples, true);
  assert.equal(body.calibration.baseline_mae, 7.5);
  assert.equal(body.calibration.within_14_day_share, 100);
});

test('feedback still rejects invalid dates, offices and visa types', async () => {
  const db = feedbackDB({
    community: [communityRow(13, '2026-01-01', '2026-02-01')]
  });
  const invalidOffice = await post({
    embassy: 'nowhere',
    visa_type: 'visit',
    application_date: '2026-01-01',
    decision_date: '2026-02-01'
  }, { db });
  assert.equal(invalidOffice.status, 400);
  const reversed = await post({
    embassy: 'new-delhi',
    visa_type: 'visit',
    application_date: '2026-02-01',
    decision_date: '2026-01-01'
  }, { db });
  assert.equal(reversed.status, 400);
  assert.equal(db.state.inserts.length, 0);
});
