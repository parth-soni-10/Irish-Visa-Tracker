import assert from 'node:assert/strict';
import { test } from 'node:test';

import { onRequestGet, onRequestPost } from '../functions/api/checklist.js';

function post(body) {
  return onRequestPost({
    request: new Request('https://tracker.test/api/checklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  });
}

function assertNoStore(response) {
  assert.match(response.headers.get('Cache-Control') || '', /no-store/);
}

test('checklist answers a malformed body with 400, not 500', async () => {
  const response = await post('{');
  assert.equal(response.status, 400);
  assertNoStore(response);
  const data = await response.json();
  assert.match(data.error, /valid JSON/);
});

test('checklist keeps its personalized response out of every cache', async () => {
  const response = await post({ visa_type: 'study', embassy: 'new-delhi', age: 17 });
  assert.equal(response.status, 200);
  assertNoStore(response);
  const data = await response.json();
  assert.equal(data.success, true);
  assert.equal(data.checklist.embassy, 'new-delhi');
  const parental = data.checklist.conditional.find((doc) => doc.id === 'parental_consent');
  assert.equal(parental.applicable, true);

  const invalid = await post({ visa_type: 'nope', embassy: 'new-delhi' });
  assert.equal(invalid.status, 400);
  assertNoStore(invalid);
});

test('checklist copies only the profile fields it reads', async () => {
  const response = await post({
    visa_type: 'study',
    embassy: 'new-delhi',
    applicant_profile: { age: 30, nationality: 'India', tracer: 'unexpected' },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.checklist.applicant_profile.age, 30);
  assert.equal(data.checklist.applicant_profile.nationality, 'India');
  assert.equal('tracer' in data.checklist.applicant_profile, false);
});

test('checklist info lists the profile fields it accepts', async () => {
  const response = await onRequestGet({});
  assert.equal(response.status, 200);
  const data = await response.json();
  for (const field of ['age', 'nationality', 'duration_months', 'purpose']) {
    assert.ok(data.profile_fields.includes(field), field);
  }
  assert.ok(data.visa_types.some((entry) => entry.type === 'study'));
});
