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

import {
  PUBLICATION_SCHEDULES,
  expectedDate,
} from '../shared/publication-schedule.js';
import { reportSource } from './_report-sources.js';

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

// Times are deliberately described as expected windows: offices publish on
// local schedules, and the tracker cannot guarantee a file will appear at a
// particular minute. The dates themselves come from the shared schedule module.
const OFFICE_SCHEDULES = PUBLICATION_SCHEDULES;

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

function windowForDate(dateKey, schedule) {
  const start = atUtc(new Date(dateKey + 'T00:00:00Z'), schedule.hourUtc, schedule.minuteUtc);
  return {
    start,
    end: new Date(start.getTime() + schedule.durationMinutes * 60 * 1000)
  };
}

/** Find the next scheduled window after `now` when no report date is known. */
function nextScheduledWindow(now, schedule) {
  if (schedule.kind === 'irregular') return null;
  const today = new Date(now.getTime());
  for (let offset = 0; offset < 15; offset += 1) {
    const candidateDate = addUtcDays(today, offset);
    const day = candidateDate.getUTCDay();
    if (schedule.kind === 'weekday' && schedule.weekday == null && (day === 0 || day === 6)) continue;
    if (schedule.weekday != null && day !== schedule.weekday) continue;
    const window = windowForDate(candidateDate.toISOString().slice(0, 10), schedule);
    if (window.start.getTime() > now.getTime()) return window;
  }
  return null;
}

/** First expected window at or after now, based on the latest report date. */
function firstExpectedWindow(now, schedule, latestReportDate, slug) {
  const latest = isoDate(latestReportDate);
  if (schedule.kind === 'irregular') return null;
  if (!latest) return nextScheduledWindow(now, schedule);
  let date = expectedDate(latest, slug);
  let window = date ? windowForDate(date, schedule) : null;
  while (window && window.start.getTime() <= now.getTime()) {
    date = expectedDate(date, slug);
    window = date ? windowForDate(date, schedule) : null;
  }
  return window;
}

function expectedWindows(now, schedule, latestReportDate = '', slug) {
  const first = firstExpectedWindow(now, schedule, latestReportDate, slug);
  if (!first) return [];
  const endLimit = new Date(now.getTime() + HORIZON_DAYS * DAY_MS);
  const windows = [];
  let date = first.start.toISOString().slice(0, 10);
  while (windowForDate(date, schedule).start.getTime() <= endLimit.getTime()) {
    const window = windowForDate(date, schedule);
    windows.push(window);
    date = expectedDate(date, slug);
    if (!date) break;
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

function publishedEvent(slug, name, sourcePage, report, now, latestReportDate) {
  const reportDate = isoDate(report.report_date);
  if (!reportDate) return null;
  const start = new Date(reportDate + 'T00:00:00Z');
  const end = addUtcDays(start, 1);
  const source = safeHttpUrl(reportSource(
    { source_file: report.source_file, report_date: reportDate },
    { slug, source_url: sourcePage, report_date: latestReportDate },
  ).href) || sourcePage;
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
    report.fetched_at ? 'Tracker observed: ' + String(report.fetched_at) : '',
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

function expectedEvent(slug, name, sourcePage, window, schedule, now, dueDate, freshness) {
  const dateKey = isoDate(window.start.toISOString().slice(0, 10));
  const dueIso = isoDate(dueDate);
  const dueKey = dueIso ? dueIso.replace(/-/g, '') : '';
  const summary = 'Expected: ' + name + ' update window — ' + dateLabel(dateKey);
  const fresh = freshness || {};
  const description = [
    'Expected update window for ' + name + ' official decisions:',
    'Expected schedule: ' + schedule.scheduleLabel + '.',
    dueIso && dueIso !== dateKey
      ? 'The earlier expected window was ' + dateLabel(dueIso) + '; this is the next expected window.'
      : '',
    fresh.status_label ? 'Office check status: ' + fresh.status_label + '.' : '',
    fresh.last_success_at ? 'Last successful check: ' + String(fresh.last_success_at) + '.' : '',
    fresh.last_attempt_at ? 'Last attempt: ' + String(fresh.last_attempt_at) + '.' : '',
    fresh.overdue
      ? 'The expected window has passed without a newer file; this is the next expected window.'
      : '',
    'This is not a published report and is not a guarantee. Public holidays, late files and office changes can move it.',
    'When the office file is recorded, a separate “Published:” event appears and this window is omitted if it falls on the same report date.',
    sourcePage ? 'Office page: ' + sourcePage : 'Office page not recorded.'
  ].filter(Boolean).join('\n');
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
      dueKey ? 'X-IRISH-VISA-DUE-DATE:' + dueKey : '',
      'X-IRISH-VISA-NEXT-DUE-DATE:' + dateKey.replace(/-/g, ''),
      fresh.status ? 'X-IRISH-VISA-CHECK-STATUS:' + String(fresh.status) : '',
      fresh.last_success_at ? 'X-IRISH-VISA-LAST-SUCCESS:' + String(fresh.last_success_at) : '',
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
  const freshness = options.freshness && options.freshness.bySlug
    ? options.freshness.bySlug
    : Object.fromEntries(((options.freshness && options.freshness.offices) || [])
      .filter((office) => office && office.slug)
      .map((office) => [office.slug, office]));
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
      const event = publishedEvent(slug, name, sourcePage, report, current, latestReportDate);
      if (event) events.push(event);
    }

    const due = expectedDate(latestReportDate, slug);
    for (const window of expectedWindows(current, schedule, latestReportDate, slug)) {
      const dateKey = window.start.toISOString().slice(0, 10);
      if (publishedDates.has(dateKey)) continue;
      events.push(expectedEvent(slug, name, sourcePage, window, schedule, current, due, freshness[slug]));
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
  const [reports, manifest, freshness] = await Promise.all([
    loadJson(env, request, '/data/reports/index.json'),
    loadJson(env, request, '/data/data_manifest.json'),
    loadJson(env, request, '/data/freshness.json')
  ]);
  const baseUrl = env && env.APP_BASE_URL ? env.APP_BASE_URL : new URL(request.url).origin;
  const body = buildOfficeCalendar(now, { reports, manifest, freshness, baseUrl });
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
