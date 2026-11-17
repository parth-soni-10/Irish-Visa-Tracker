/**
 * Calendar export for the next expected New Delhi update.
 *
 * New Delhi publishes on weekdays at about 11:00 IST. This is an expected
 * window, not a guarantee: public holidays and late files happen. The event is
 * fixed to the IST schedule and exported in UTC so calendar clients do not
 * have to understand the time zone.
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
