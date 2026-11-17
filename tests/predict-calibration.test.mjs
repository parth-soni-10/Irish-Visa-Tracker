import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequestGet as feedbackGet } from '../functions/api/predict-feedback.js';
import { onRequestGet, onRequestPost } from '../functions/api/predict.js';

function calibrationDB({ samples = 0, mae = null, within = null, lastAt = null } = {}) {
  return {
    prepare(sql) {
      const statement = {
        bind() { return statement; },
        async run() { return { success: true }; },
        async first() {
          if (/COUNT\(\*\) AS samples/.test(sql)) {
            return {
              samples,
              baseline_mae: mae,
              within_14_day_share: within,
              first_at: samples ? '2026-11-01 00:00:00' : null,
              last_at: samples ? lastAt || '2026-11-17 12:00:00' : null
            };
          }
          return null;
        }
      };
      return statement;
    }
  };
}

function predictRequest(body = {
  embassy: 'new-delhi',
  visa_type: 'visit',
  application_date: '2026-01-01'
}) {
  return new Request('https://tracker.test/api/predict', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('the prediction API and feedback endpoint share the same zero-sample gate', async () => {
  const env = { DB: calibrationDB() };
  const modelResponse = await onRequestGet({ env });
  const modelBody = await modelResponse.json();
  const feedbackResponse = await feedbackGet({ env });
  const feedbackBody = await feedbackResponse.json();
  const predictionResponse = await onRequestPost({ request: predictRequest(), env });
  const predictionBody = await predictionResponse.json();

  assert.equal(modelBody.calibration.samples, 0);
  assert.equal(modelBody.calibration.meets_minimum_samples, false);
  assert.equal(modelBody.calibration.baseline_mae, null);
  assert.equal(modelBody.calibration.last_calibrated_at, null);
  assert.equal(modelBody.model.validation.real_outcome_samples, 0);
  assert.equal(modelBody.model.validation.meets_minimum_samples, false);
  assert.deepEqual(feedbackBody.calibration, modelBody.calibration);
  assert.deepEqual(predictionBody.calibration, modelBody.calibration);
  assert.equal(predictionBody.prediction.gate.real_outcome_samples, 0);
  assert.equal(predictionBody.prediction.gate.meets_minimum_samples, false);
});

test('below-gate samples keep MAE hidden in both public reads', async () => {
  const env = {
    DB: calibrationDB({
      samples: 12,
      mae: 7.4,
      within: 0.55,
      lastAt: '2026-11-17 09:30:00'
    })
  };
  const modelBody = await (await onRequestGet({ env })).json();
  const feedbackBody = await (await feedbackGet({ env })).json();

  assert.equal(modelBody.calibration.samples, 12);
  assert.equal(modelBody.calibration.meets_minimum_samples, false);
  assert.equal(modelBody.calibration.baseline_mae, null);
  assert.equal(modelBody.calibration.within_14_day_share, null);
  assert.equal(modelBody.calibration.last_calibrated_at, '2026-11-17 09:30:00');
  assert.deepEqual(feedbackBody.calibration, modelBody.calibration);
});

test('at the gate both reads expose the same MAE and last-calibrated date', async () => {
  const env = {
    DB: calibrationDB({
      samples: 240,
      mae: 7.42,
      within: 0.61,
      lastAt: '2026-11-17 12:00:00'
    })
  };
  const modelBody = await (await onRequestGet({ env })).json();
  const feedbackBody = await (await feedbackGet({ env })).json();
  const predictionBody = await (await onRequestPost({ request: predictRequest(), env })).json();

  assert.equal(modelBody.calibration.meets_minimum_samples, true);
  assert.equal(modelBody.calibration.samples, 240);
  assert.equal(modelBody.calibration.baseline_mae, 7.42);
  assert.equal(modelBody.calibration.within_14_day_share, 61);
  assert.equal(modelBody.calibration.last_calibrated_at, '2026-11-17 12:00:00');
  assert.equal(modelBody.model.validation.real_outcome_samples, 240);
  assert.equal(modelBody.model.validation.meets_minimum_samples, true);
  assert.equal(modelBody.model.validation.baseline_mae, 7.42);
  assert.equal(modelBody.model.validation.last_calibrated_at, '2026-11-17 12:00:00');
  assert.deepEqual(feedbackBody.calibration, modelBody.calibration);
  assert.deepEqual(predictionBody.calibration, modelBody.calibration);
  assert.equal(predictionBody.prediction.gate.meets_minimum_samples, true);
  assert.equal(predictionBody.prediction.gate.baseline_mae, 7.42);
  assert.equal(predictionBody.prediction.gate.last_calibrated_at, '2026-11-17 12:00:00');
});
