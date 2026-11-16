import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OFFICES,
  checkVFSAppointment,
  handleVFSAppointments,
  normalizeOffice
} from '../functions/vfs-appointments.js';

const BOOKING_URL = 'https://visa.vfsglobal.com/ind/en/irl/book-an-appointment';
const LOGIN_URL = 'https://visa.vfsglobal.com/ind/en/irl/login';
const TRACKING_URL = 'https://visa.vfsglobal.com/ind/en/irl/track-application';

test('VFS office names normalize to the supported VAC slugs', () => {
  assert.equal(normalizeOffice('New Delhi'), 'new-delhi');
  assert.equal(normalizeOffice('  bengaluru '), 'bengaluru');
  assert.equal(normalizeOffice(''), 'new-delhi');
  assert.equal(normalizeOffice('not-a-vac'), null);
  assert.ok(OFFICES.chandigarh);
  assert.ok(OFFICES.cochin);
});

test('the handoff never calls VFS and never claims a slot', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('VFS must not be called');
  };

  try {
    const result = await checkVFSAppointment({
      office: 'new-delhi',
      visaType: 'study'
    });

    assert.equal(calls, 0);
    assert.equal(result.success, true);
    assert.equal(result.office, 'new-delhi');
    assert.equal(result.availability, 'login_required');
    assert.equal(result.requires_login, true);
    assert.equal(result.public_slots, false);
    assert.equal(result.calendar_visible, false);
    assert.equal(result.visa_type, 'study');
    assert.equal(result.official_url, BOOKING_URL);
    assert.equal(result.booking_url, BOOKING_URL);
    assert.equal(result.login_url, LOGIN_URL);
    assert.equal(result.tracking_url, TRACKING_URL);
    assert.match(result.message, /only after signing in/i);
    assert.match(result.message, /cannot see, hold, or book a slot/i);
    assert.equal('source' in result, false);
    assert.equal('checked_at' in result, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the compatibility handler returns the static handoff', async () => {
  const response = await handleVFSAppointments(
    new Request('https://tracker.test/api/vfs/appointments?office=New%20Delhi&visa_type=study')
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.office, 'new-delhi');
  assert.equal(body.office_name, 'New Delhi');
  assert.equal(body.visa_type, 'study');
  assert.equal(body.availability, 'login_required');
  assert.equal(body.requires_login, true);
  assert.equal(body.public_slots, false);
  assert.equal(body.calendar_visible, false);
  assert.equal(body.booking_url, BOOKING_URL);
  assert.equal(body.login_url, LOGIN_URL);
  assert.equal(body.tracking_url, TRACKING_URL);
  assert.match(body.message, /cannot see, hold, or book a slot/i);
});

test('unknown offices and unsupported methods are rejected', async () => {
  const unknown = await handleVFSAppointments(
    new Request('https://tracker.test/api/vfs/appointments?office=not-a-vac')
  );
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error, 'Unknown VFS office');

  const post = await handleVFSAppointments(
    new Request('https://tracker.test/api/vfs/appointments?office=new-delhi', { method: 'POST' })
  );
  assert.equal(post.status, 405);
});

test('an unknown office is rejected by the shared check function', async () => {
  const result = await checkVFSAppointment({ office: 'not-a-vac' });
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
  assert.equal(result.error, 'Unknown VFS office');
});
