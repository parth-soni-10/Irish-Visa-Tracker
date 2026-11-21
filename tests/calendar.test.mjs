import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildNewDelhiCalendar,
  buildOfficeCalendar,
  nextNewDelhiUpdate,
  officesCalendarResponse
} from '../functions/calendar.js';

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-11-16T04:00:00Z');
const OFFICE_SLUGS = ['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara'];
const MANIFEST = {
  offices: [
    { slug: 'new-delhi', name: 'New Delhi', source_url: 'https://www.ireland.ie/new-delhi/' },
    { slug: 'beijing', name: 'Beijing', source_url: 'https://www.ireland.ie/beijing/' },
    { slug: 'dublin', name: 'Dublin', source_url: 'https://www.ireland.ie/dublin/' },
    { slug: 'abu-dhabi', name: 'Abu Dhabi', source_url: 'https://www.ireland.ie/abu-dhabi/' },
    { slug: 'abuja', name: 'Abuja', source_url: 'https://www.ireland.ie/abuja/' },
    { slug: 'ankara', name: 'Ankara', source_url: 'https://www.ireland.ie/ankara/' }
  ]
};

function report(date) {
  return {
    report_date: date,
    fetched_at: date + 'T12:00:00Z',
    decisions: 10,
    approved: 7,
    refused: 3,
    source_file: 'https://www.ireland.ie/files/' + date + '.pdf'
  };
}

function fixtureReports() {
  return {
    offices: {
      'new-delhi': [report('2026-11-16'), report('2026-11-13')],
      beijing: [report('2026-11-16'), report('2026-11-09')],
      dublin: [report('2026-11-10')],
      'abu-dhabi': [report('2026-11-13')],
      // Older than the lookback: the latest report must still be published.
      abuja: [report('2026-10-18')],
      ankara: [report('2026-11-15')]
    }
  };
}

function uidLines(ics) {
  return [...ics.matchAll(/^UID:([^\r\n]+)/gm)].map((match) => match[1]);
}

test('all-office calendar uses stable expected and published UIDs for all six offices', () => {
  const ics = buildOfficeCalendar(NOW, { reports: fixtureReports(), manifest: MANIFEST });
  const uids = uidLines(ics);
  const expected = uids.filter((uid) => uid.startsWith('expected-'));
  const published = uids.filter((uid) => uid.startsWith('published-'));

  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /X-WR-CALNAME:Irish visa office updates/);
  assert.match(ics, /REFRESH-INTERVAL;VALUE=DURATION:PT1H/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.equal(new Set(uids).size, uids.length, 'every UID must be unique');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, uids.length);
  assert.equal((ics.match(/END:VEVENT/g) || []).length, uids.length);

  // Every office with a fixed schedule gets a rolling expected event, even
  // where today's window was replaced by a published report. Beijing is
  // irregular, so the calendar deliberately invents no expected date for it.
  for (const slug of OFFICE_SLUGS.filter((slug) => slug !== 'beijing')) {
    assert.ok(expected.some((uid) => uid.startsWith('expected-' + slug + '-')), 'missing expected UID for ' + slug);
    assert.match(ics, new RegExp('X-IRISH-VISA-OFFICE:' + slug));
  }
  assert.ok(!expected.some((uid) => uid.startsWith('expected-beijing-')), 'Beijing has no fixed expected window');
  // A report published on an expected date replaces that day's expected event.
  assert.ok(published.includes('published-new-delhi-20261116@irishvisaupdatetracker.pages.dev'));
  assert.ok(published.includes('published-beijing-20261116@irishvisaupdatetracker.pages.dev'));
  assert.ok(!expected.includes('expected-new-delhi-20261116@irishvisaupdatetracker.pages.dev'));
  assert.ok(!expected.includes('expected-beijing-20261116@irishvisaupdatetracker.pages.dev'));

  assert.match(ics, /UID:published-new-delhi-20261113@irishvisaupdatetracker\.pages\.dev/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261113/);
  assert.match(ics, /SUMMARY:Published: New Delhi official decisions/);
  assert.match(ics, /URL:https:\/\/www\.ireland\.ie\/files\/2026-11-13\.pdf/);
  assert.match(ics, /STATUS:CONFIRMED/);
  assert.match(ics, /X-IRISH-VISA-EVENT:published/);
  assert.match(ics, /SUMMARY:Expected: New Delhi update window/);
  assert.match(ics, /STATUS:TENTATIVE/);
  assert.match(ics, /X-IRISH-VISA-EVENT:expected/);
  assert.match(ics, /UID:published-abuja-20261018@irishvisaupdatetracker\.pages\.dev/);

  const second = buildOfficeCalendar(NOW, { reports: fixtureReports(), manifest: MANIFEST });
  assert.deepEqual(uidLines(second), uids, 'the same calendar inputs must keep the same UIDs');
});

test('Abuja calendar expected and due dates match the publication schedule page', async () => {
  const reports = JSON.parse(await readFile(path.join(ROOT, 'data/reports/index.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'data/data_manifest.json'), 'utf8'));
  const schedulePage = await readFile(path.join(ROOT, 'when-are-visa-decisions-published.html'), 'utf8');
  const ics = buildOfficeCalendar(new Date('2026-11-21T14:54:06Z'), { reports, manifest });

  assert.match(schedulePage, /Due since Saturday 14 November 2026/);
  assert.match(schedulePage, /Next expected Saturday 28 November 2026/);
  assert.match(ics, /X-IRISH-VISA-DUE-DATE:20261114/);
  assert.match(ics, /X-IRISH-VISA-NEXT-DUE-DATE:20261128/);
  assert.match(ics, /UID:expected-abuja-20261128@irishvisaupdatetracker\.pages\.dev/);
  assert.doesNotMatch(ics, /UID:expected-abuja-2026112[12]@/);
});

test('all-office calendar still has expected events for every fixed-schedule office without report data', () => {
  const ics = buildOfficeCalendar(NOW, { reports: { offices: {} }, manifest: MANIFEST });
  const uids = uidLines(ics);
  assert.ok(uids.every((uid) => uid.startsWith('expected-')));
  assert.equal((ics.match(/STATUS:CONFIRMED/g) || []).length, 0);
  for (const slug of OFFICE_SLUGS.filter((slug) => slug !== 'beijing')) {
    assert.ok(uids.some((uid) => uid.startsWith('expected-' + slug + '-')), 'missing expected UID for ' + slug);
  }
  assert.ok(!uids.some((uid) => uid.startsWith('expected-beijing-')));
});

test('the offices endpoint returns a folded webcal feed with stable subscriptions', async () => {
  const files = {
    '/data/reports/index.json': fixtureReports(),
    '/data/data_manifest.json': MANIFEST
  };
  const env = {
    APP_BASE_URL: 'https://tracker.test',
    ASSETS: {
      fetch: async (request) => {
        const body = files[new URL(request.url).pathname];
        return body
          ? new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
          : new Response('not found', { status: 404 });
      }
    }
  };
  const response = await officesCalendarResponse(
    env,
    new Request('https://tracker.test/api/calendar/offices.ics'),
    NOW
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/calendar; charset=utf-8');
  assert.match(response.headers.get('Content-Disposition'), /irish-visa-offices\.ics/);
  assert.match(response.headers.get('Cache-Control'), /max-age=300/);
  const body = await response.text();
  assert.match(body, /SOURCE;VALUE=URI:https:\/\/tracker\.test\/api\/calendar\/offices\.ics/);
  assert.match(body, /UID:expected-dublin-20261117@irishvisaupdatetracker\.pages\.dev/);
  for (const line of body.split('\r\n')) {
    assert.ok(line.length <= 75, 'ICS line exceeds 75 characters: ' + line);
  }

  const head = await officesCalendarResponse(
    env,
    new Request('https://tracker.test/api/calendar/offices.ics', { method: 'HEAD' }),
    NOW
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
