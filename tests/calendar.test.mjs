import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNewDelhiCalendar, nextNewDelhiUpdate } from '../functions/calendar.js';

test('calendar uses the next weekday 11:00 IST window before the update', () => {
  // Monday 16 Nov 2026, 04:00 UTC = 09:30 IST.
  const window = nextNewDelhiUpdate(new Date('2026-11-16T04:00:00Z'));
  assert.equal(window.start.toISOString(), '2026-11-16T05:30:00.000Z');
  assert.equal(window.end.toISOString(), '2026-11-16T06:30:00.000Z');
});

test('calendar rolls to the next weekday after 11:00 IST and over weekends', () => {
  // Monday 06:00 UTC = 11:30 IST.
  assert.equal(
    nextNewDelhiUpdate(new Date('2026-11-16T06:00:00Z')).start.toISOString(),
    '2026-11-17T05:30:00.000Z'
  );
  // Saturday 08:00 UTC rolls to Monday.
  assert.equal(
    nextNewDelhiUpdate(new Date('2026-11-21T08:00:00Z')).start.toISOString(),
    '2026-11-23T05:30:00.000Z'
  );
});

test('calendar export is a valid one-event ICS with a caveat', () => {
  const ics = buildNewDelhiCalendar(new Date('2026-11-16T04:00:00Z'));
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:new-delhi-update-20261116@irishvisaupdatetracker\.pages\.dev/);
  assert.match(ics, /DTSTART:20261116T053000Z/);
  assert.match(ics, /SUMMARY:Irish visa update expected/);
  assert.match(ics, /not a guarantee/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
});
