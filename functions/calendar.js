/**
 * Calendar exports: the legacy next-New-Delhi event and the rolling all-office
 * webcal feed.
 *
 * New Delhi publishes on weekdays at about 11:00 IST. This is an expected
 * window, not a guarantee: public holidays and late files happen. The event is
 * fixed to the IST schedule and exported in UTC so calendar clients do not
 * have to understand the time zone. The all-office feed adds explicit published
 * report events alongside the expected windows for all six offices.
 */

const IST_OFFSET_MINUTES = 330; // UTC+05:30, no daylight saving.
const UPDATE_HOUR = 11;
const UPDATE_MINUTE = 0;
const WINDOW_MINUTES = 60;

function shiftedDate(now) {
  return new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
}

function isWeekday(day) {
  return day >= 1 && day <= 5;
}

/**
 * Return the next weekday 11:00 IST window. If today's window has already
 * started, skip to the next weekday. Weekends roll to Monday.
 */
export function nextNewDelhiUpdate(now = new Date()) {
  const local = shiftedDate(now);
  let year = local.getUTCFullYear();
  let month = local.getUTCMonth();
  let day = local.getUTCDate();
  let candidate = new Date(Date.UTC(year, month, day, UPDATE_HOUR - 6, UPDATE_MINUTE + 30, 0, 0));

  if (!isWeekday(new Date(Date.UTC(year, month, day)).getUTCDay()) || candidate.getTime() <= now.getTime()) {
    do {
      const next = new Date(Date.UTC(year, month, day + 1));
      year = next.getUTCFullYear();
      month = next.getUTCMonth();
      day = next.getUTCDate();
      candidate = new Date(Date.UTC(year, month, day, UPDATE_HOUR - 6, UPDATE_MINUTE + 30, 0, 0));
    } while (!isWeekday(new Date(Date.UTC(year, month, day)).getUTCDay()));
  }

  return {
    start: candidate,
    end: new Date(candidate.getTime() + WINDOW_MINUTES * 60 * 1000)
  };
}

function icsEscape(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function icsDate(value) {
  return value.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function buildNewDelhiCalendar(now = new Date()) {
  const window = nextNewDelhiUpdate(now);
  const dateKey = window.start.toISOString().slice(0, 10).replace(/-/g, '');
  const description = [
    'The official New Delhi visa decisions file usually appears around 11:00 IST on weekdays.',
    'This is an expected update window, not a guarantee. Public holidays and late files can move it.',
    'Check the official source and the tracker after the window.',
    'https://irishvisaupdatetracker.pages.dev/status'
  ].join('\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Irish Visa Decision Tracker//Official file window//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:new-delhi-update-${dateKey}@irishvisaupdatetracker.pages.dev`,
    `DTSTAMP:${icsDate(now)}`,
    `DTSTART:${icsDate(window.start)}`,
    `DTEND:${icsDate(window.end)}`,
    'SUMMARY:Irish visa update expected — New Delhi',
    `DESCRIPTION:${icsEscape(description)}`,
    'URL:https://irishvisaupdatetracker.pages.dev/status',
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
    'END:VCALENDAR',
    ''
  ].join('\r\n');
}

export function calendarResponse(now = new Date(), head = false) {
  return new Response(head ? null : buildNewDelhiCalendar(now), {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="irish-visa-next-update.ics"',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

// ---------------------------------------------------------------------------
// Rolling all-office webcal feed
// ---------------------------------------------------------------------------

const UID_DOMAIN = 'irishvisaupdatetracker.pages.dev';
const DEFAULT_BASE_URL = 'https://irishvisaupdatetracker.pages.dev';
const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_DAYS = 56;
const LOOKBACK_DAYS = 28;

// Publication days come from embassy-config.json. Times are deliberately
// described as expected windows: offices publish on local schedules, and the
// tracker cannot guarantee a file will appear at a particular minute.
const OFFICE_SCHEDULES = Object.freeze({
  'new-delhi': {
    name: 'New Delhi',
    cadence: 'weekdays',
    weekday: null,
    hourUtc: 5,
    minuteUtc: 30,
    durationMinutes: 60,
    scheduleLabel: 'weekdays around 11:00 IST (05:30 UTC)'
  },
  beijing: {
    name: 'Beijing',
    cadence: 'weekly',
    weekday: 1,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Mondays (06:00 UTC)'
  },
  dublin: {
    name: 'Dublin',
    cadence: 'weekly',
    weekday: 2,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Tuesdays (06:00 UTC)'
  },
  'abu-dhabi': {
    name: 'Abu Dhabi',
    cadence: 'weekly',
    weekday: 5,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Fridays (06:00 UTC)'
  },
  abuja: {
    name: 'Abuja',
    cadence: 'weekly',
    weekday: 0,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Sundays (06:00 UTC)'
  },
  ankara: {
    name: 'Ankara',
    cadence: 'weekly',
    weekday: 0,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Sundays (06:00 UTC)'
  }
});

const OFFICE_PAGES = {
  'new-delhi': 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
  beijing: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
  dublin: 'https://www.irishimmigration.ie/visa-decisions/',
  'abu-dhabi': 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
  abuja: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
  ankara: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/'
};

function safeHttpUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 1000) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function dateLabel(value) {
  const date = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function atUtc(date, hour, minute) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0, 0));
}

function nextWeekdayWindow(now, schedule) {
  let start = atUtc(now, schedule.hourUtc, schedule.minuteUtc);
  while (!isWeekday(start.getUTCDay()) || start.getTime() <= now.getTime()) {
    start = addUtcDays(start, 1);
  }
  return {
    start,
    end: new Date(start.getTime() + schedule.durationMinutes * 60 * 1000)
  };
}

function nextWeeklyWindow(now, schedule) {
  const today = atUtc(now, schedule.hourUtc, schedule.minuteUtc);
  const delta = (schedule.weekday - today.getUTCDay() + 7) % 7;
  let start = addUtcDays(today, delta);
  if (start.getTime() <= now.getTime()) start = addUtcDays(start, 7);
  return {
    start,
    end: new Date(start.getTime() + schedule.durationMinutes * 60 * 1000)
  };
}

function firstExpectedWindow(now, schedule) {
  return schedule.cadence === 'weekly'
    ? nextWeeklyWindow(now, schedule)
    : nextWeekdayWindow(now, schedule);
}

function expectedWindows(now, schedule) {
  const first = firstExpectedWindow(now, schedule);
  const endLimit = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
  const windows = [];
  let start = first.start;
  while (start.getTime() <= endLimit.getTime()) {
    windows.push({ start, end: new Date(start.getTime() + schedule.durationMinutes * 60 * 1000) });
    if (schedule.cadence === 'weekly') {
      start = addUtcDays(start, 7);
    } else {
      start = addUtcDays(start, 1);
      while (!isWeekday(start.getUTCDay())) start = addUtcDays(start, 1);
    }
  }
  return windows;
}

function icsDateOnly(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function foldIcsLine(line) {
  const text = String(line);
  if (text.length <= 75) return text;
  let folded = text.slice(0, 75);
  let rest = text.slice(75);
  while (rest.length) {
    folded += '\r\n ' + rest.slice(0, 74);
    rest = rest.slice(74);
  }
  return folded;
}

function icsDocument(lines) {
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

function officeName(slug, manifest) {
  const offices = Array.isArray(manifest && manifest.offices) ? manifest.offices : [];
  const match = offices.find((office) => office && office.slug === slug);
  return (match && match.name) || OFFICE_SCHEDULES[slug].name || slug;
}

function officePage(slug, manifest) {
  const offices = Array.isArray(manifest && manifest.offices) ? manifest.offices : [];
  const match = offices.find((office) => office && office.slug === slug);
  return safeHttpUrl(match && match.source_url) || safeHttpUrl(OFFICE_PAGES[slug]);
}

function publishedEvent(slug, name, sourcePage, report, now) {
  const reportDate = isoDate(report.report_date);
  if (!reportDate) return null;
  const start = new Date(reportDate + 'T00:00:00Z');
  const end = addUtcDays(start, 1);
  const source = safeHttpUrl(report.source_file) || sourcePage;
  const decisions = Math.max(0, Number(report.decisions) || 0);
  const approved = Math.max(0, Number(report.approved) || 0);
  const refused = Math.max(0, Number(report.refused) || 0);
  const fetched = report.fetched_at ? new Date(report.fetched_at) : null;
  const lastModified = fetched && !Number.isNaN(fetched.getTime()) ? fetched : now;
  const summary = 'Published: ' + name + ' official decisions — ' + dateLabel(reportDate);
  const description = [
    'A published official decision report recorded by the tracker.',
    'Office: ' + name,
    'Report date: ' + reportDate,
    'Decisions: ' + decisions.toLocaleString('en-IE') + ' (approved ' + approved.toLocaleString('en-IE') + ', refused ' + refused.toLocaleString('en-IE') + ')',
    source ? 'Official source: ' + source : 'Official source not recorded.',
    'This event confirms a published file; expected windows are separate events.'
  ].join('\n');
  const lines = [
    'BEGIN:VEVENT',
    'UID:published-' + slug + '-' + reportDate.replace(/-/g, '') + '@' + UID_DOMAIN,
    'DTSTAMP:' + icsDate(now),
    'LAST-MODIFIED:' + icsDate(lastModified),
    'SEQUENCE:0',
    'DTSTART;VALUE=DATE:' + icsDateOnly(start),
    'DTEND;VALUE=DATE:' + icsDateOnly(end),
    'SUMMARY:' + icsEscape(summary),
    'DESCRIPTION:' + icsEscape(description),
    source ? 'URL:' + source : '',
    'STATUS:CONFIRMED',
    'CATEGORIES:Published report',
    'X-IRISH-VISA-EVENT:published',
    'X-IRISH-VISA-OFFICE:' + slug,
    'TRANSP:TRANSPARENT',
    'END:VEVENT'
  ].filter(Boolean);
  return { start, lines };
}

function expectedEvent(slug, name, sourcePage, window, schedule, now) {
  const dateKey = isoDate(window.start.toISOString().slice(0, 10));
  const summary = 'Expected: ' + name + ' update window — ' + dateLabel(dateKey);
  const description = [
    'Expected update window for ' + name + ' official decisions:',
    'Expected schedule: ' + schedule.scheduleLabel + '.',
    'This is not a published report and is not a guarantee. Public holidays, late files and office changes can move it.',
    'When the office file is recorded, a separate “Published:” event appears and this window is omitted if it falls on the same report date.',
    sourcePage ? 'Office page: ' + sourcePage : 'Office page not recorded.'
  ].join('\n');
  return {
    start: window.start,
    lines: [
      'BEGIN:VEVENT',
      'UID:expected-' + slug + '-' + dateKey.replace(/-/g, '') + '@' + UID_DOMAIN,
      'DTSTAMP:' + icsDate(now),
      'DTSTART:' + icsDate(window.start),
      'DTEND:' + icsDate(window.end),
      'SUMMARY:' + icsEscape(summary),
      'DESCRIPTION:' + icsEscape(description),
      sourcePage ? 'URL:' + sourcePage : '',
      'STATUS:TENTATIVE',
      'CATEGORIES:Expected update',
      'X-IRISH-VISA-EVENT:expected',
      'X-IRISH-VISA-OFFICE:' + slug,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    ].filter(Boolean)
  };
}

/**
 * Build a rolling all-office webcal feed. Expected windows run from now for
 * HORIZON_DAYS; published reports run back LOOKBACK_DAYS. Published dates are
 * excluded from the expected events for that office, so a calendar client sees
 * one explicit confirmation rather than an expected event beside it.
 */
export function buildOfficeCalendar(now = new Date(), options = {}) {
  const current = now instanceof Date ? now : new Date(now);
  const reportsDoc = options.reports || {};
  const manifest = options.manifest || {};
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const reports = reportsDoc.offices && typeof reportsDoc.offices === 'object' ? reportsDoc.offices : {};
  const lookbackStart = new Date(current.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
  const horizonEnd = new Date(current.getTime() + HORIZON_DAYS * DAY_MS).toISOString().slice(0, 10);
  const events = [];

  for (const [slug, schedule] of Object.entries(OFFICE_SCHEDULES)) {
    const name = officeName(slug, manifest);
    const sourcePage = officePage(slug, manifest);
    const officeReports = Array.isArray(reports[slug]) ? reports[slug] : [];
    const publishedDates = new Set();
    const reportsByDate = new Map();
    for (const report of officeReports) {
      if (!report) continue;
      const reportDate = isoDate(report.report_date);
      if (!reportDate) continue;
      publishedDates.add(reportDate);
      const existing = reportsByDate.get(reportDate);
      if (!existing || String(report.fetched_at || '') > String(existing.fetched_at || '')) {
        reportsByDate.set(reportDate, report);
      }
    }

    const latestReportDate = [...reportsByDate.keys()].sort().at(-1) || '';
    for (const [reportDate, report] of reportsByDate) {
      // Keep the latest report for every office even when its archive is older
      // than the rolling lookback, so the calendar always states what is
      // published as well as what is expected.
      if (reportDate > horizonEnd) continue;
      if (reportDate < lookbackStart && reportDate !== latestReportDate) continue;
      const event = publishedEvent(slug, name, sourcePage, report, current);
      if (event) events.push(event);
    }

    for (const window of expectedWindows(current, schedule)) {
      const dateKey = window.start.toISOString().slice(0, 10);
      if (publishedDates.has(dateKey)) continue;
      events.push(expectedEvent(slug, name, sourcePage, window, schedule, current));
    }
  }

  events.sort((a, b) => a.start.getTime() - b.start.getTime() || a.lines.join('\n').localeCompare(b.lines.join('\n')));
  return icsDocument([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Irish Visa Decision Tracker//All office updates//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Irish visa office updates',
    'X-WR-CALDESC:Expected and published decision reports for all six Irish visa offices. Expected windows are not guarantees.',
    'X-WR-TIMEZONE:UTC',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'SOURCE;VALUE=URI:' + baseUrl + '/api/calendar/offices.ics',
    ...events.flatMap((event) => event.lines),
    'END:VCALENDAR'
  ]);
}

async function loadJson(env, request, path) {
  const url = new URL(path, request.url);
  try {
    if (env && env.ASSETS) {
      const response = await env.ASSETS.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
      if (response.ok) return await response.json();
    }
  } catch (error) {
    console.warn('Calendar asset read failed for ' + path + ': ' + error.message);
  }
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn('Calendar fetch failed for ' + path + ': ' + error.message);
  }
  return null;
}

export async function officesCalendarResponse(env, request, now = new Date()) {
  const [reports, manifest] = await Promise.all([
    loadJson(env, request, '/data/reports/index.json'),
    loadJson(env, request, '/data/data_manifest.json')
  ]);
  const baseUrl = env && env.APP_BASE_URL ? env.APP_BASE_URL : new URL(request.url).origin;
  const body = buildOfficeCalendar(now, { reports, manifest, baseUrl });
  return new Response(request.method === 'HEAD' ? null : body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="irish-visa-offices.ics"',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
