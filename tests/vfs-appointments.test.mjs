import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OFFICES,
  checkVFSAppointment,
  classify,
  handleVFSAppointments,
  normalizeOffice
} from '../functions/vfs-appointments.js';

const LOGIN_HTML = `
  <html><body>
    <h1>Sign in</h1>
    <p>Enter your email and password to continue.</p>
    <a href="https://visa.vfsglobal.com/ind/en/irl/login">Book now</a>
  </body></html>`;

const BOOKING_HTML = `
  <html><body>
    <h1>Book an appointment</h1>
    <p>If you're ready to arrange your visa application appointment, see below.</p>
    <a href="https://visa.vfsglobal.com/ind/en/irl/login">Book now</a>
  </body></html>`;

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

test('VFS office names normalize to the supported VAC slugs', () => {
  assert.equal(normalizeOffice('New Delhi'), 'new-delhi');
  assert.equal(normalizeOffice('  bengaluru '), 'bengaluru');
  assert.equal(normalizeOffice(''), 'new-delhi');
  assert.equal(normalizeOffice('not-a-vac'), null);
  assert.ok(OFFICES['chandigarh']);
  assert.ok(OFFICES.cochin);
});

test('VFS classifier distinguishes login, challenge, maintenance and slots', () => {
  assert.equal(classify(LOGIN_HTML, 200).availability, 'login_required');
  assert.equal(classify(BOOKING_HTML, 200).availability, 'login_required');
  assert.equal(classify('Just a moment...', 403).availability, 'challenge');
  assert.equal(classify('Service temporarily unavailable', 200).availability, 'maintenance');
  assert.equal(classify('No appointments are currently available', 200).availability, 'unavailable');
  assert.equal(classify('Select a date and time for your appointment', 200).availability, 'available');
  assert.equal(classify('Welcome to VFS Global', 200).availability, 'unknown');
});

test('check reports login-required without pretending a slot exists', async () => {
  const result = await checkVFSAppointment({
    office: 'new-delhi',
    fetchImpl: async () => htmlResponse(LOGIN_HTML)
  });

  assert.equal(result.success, true);
  assert.equal(result.availability, 'login_required');
  assert.equal(result.requires_login, true);
  assert.equal(result.calendar_visible, false);
  assert.equal(result.public_slots, false);
  assert.equal(result.source, 'http');
  assert.match(result.disclaimer, /does not publish/i);
  assert.ok(result.checked_at);
  assert.equal(result.login_url, 'https://visa.vfsglobal.com/ind/en/irl/login');
});

test('check uses Browser Rendering when credentials are present', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: LOGIN_HTML }), { status: 200 });
  };

  const result = await checkVFSAppointment({
    office: 'mumbai',
    env: { CF_ACCOUNT_ID: 'account-id', CF_API_TOKEN: 'token' },
    fetchImpl
  });

  assert.equal(result.success, true);
  assert.equal(result.source, 'browser-rendering');
  assert.equal(result.availability, 'login_required');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /browser-rendering\/content$/);
});

test('a bot challenge remains a distinct state rather than unavailable', async () => {
  const result = await checkVFSAppointment({
    office: 'chennai',
    fetchImpl: async () => htmlResponse('Just a moment...', 403)
  });

  assert.equal(result.success, true);
  assert.equal(result.availability, 'challenge');
  assert.equal(result.http_status, 403);
  assert.equal(result.requires_login, false);
  assert.equal(result.public_slots, false);
});

test('network failure is an explicit unknown, never an invented slot state', async () => {
  const result = await checkVFSAppointment({
    office: 'kolkata',
    fetchImpl: async () => {
      throw new Error('network down');
    }
  });

  assert.equal(result.success, false);
  assert.equal(result.availability, 'unknown');
  assert.equal(result.http_status, null);
  assert.match(result.error, /Could not reach/i);
});

test('unknown offices and unsupported methods are rejected', async () => {
  const unknown = await handleVFSAppointments(
    new Request('https://tracker.test/api/vfs/appointments?office=not-a-vac'),
    {}
  );
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.error, 'Unknown VFS office');

  const post = await handleVFSAppointments(
    new Request('https://tracker.test/api/vfs/appointments?office=new-delhi', { method: 'POST' }),
    {}
  );
  assert.equal(post.status, 405);
});

test('valid handler request returns the normalized VFS result', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => htmlResponse(LOGIN_HTML);
  try {
    const response = await handleVFSAppointments(
      new Request('https://tracker.test/api/vfs/appointments?office=New%20Delhi&visa_type=study'),
      {}
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.office, 'new-delhi');
    assert.equal(body.visa_type, 'study');
    assert.equal(body.availability, 'login_required');
    assert.equal(body.public_slots, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
