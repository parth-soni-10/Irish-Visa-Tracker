import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet, onRequestPost } from '../functions/api/predict.js';

function post(body) {
  return onRequestPost({
    request: new Request('https://example.test/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  });
}

test('predict returns a bounded estimate from the exported tree ensemble', async () => {
  const response = await post({
    application_number: 'IRL2026123456',
    application_date: '2026-01-15',
    visa_type: 'study',
    embassy: 'new-delhi'
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.prediction.inference, 'xgboost-tree-ensemble');
  assert.ok(data.prediction.predicted_days >= 5 && data.prediction.predicted_days <= 180);
  assert.match(data.prediction.estimated_decision_date, /^2026-\d{2}-\d{2}$/);
  assert.ok(data.prediction.confidence_interval.lower <= data.prediction.predicted_days);
});

test('predict rejects missing dates and unknown embassies', async () => {
  const missing = await post({ application_date: '', visa_type: 'visit', embassy: 'new-delhi' });
  assert.equal(missing.status, 400);
  const unknown = await post({ application_date: '2026-01-15', visa_type: 'visit', embassy: 'nowhere' });
  assert.equal(unknown.status, 400);
});

test('predict metadata describes a synthetic prototype, not a guarantee', async () => {
  const response = await onRequestGet();
  const data = await response.json();
  assert.equal(data.model.training_data, 'synthetic-illustrative');
  assert.match(data.model.disclaimer, /Illustrative estimate/);
});
