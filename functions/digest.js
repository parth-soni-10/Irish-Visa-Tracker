/**
 * Shared Telegram digest helpers.
 *
 * The hourly runner and the bot's /digest preview both build the same message
 * from these functions, so a preview cannot describe different applications or
 * a different no-change policy from the scheduled message. Scheduling is local
 * to the chat's chosen IANA timezone: a digest becomes due on the first runner
 * pass at or after the preferred hour on its daily/weekly calendar boundary.
 */

export const DIGEST_INTERVALS = Object.freeze({
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
});

const DEFAULT_DIGEST_HOUR = 9;
const DEFAULT_DIGEST_TIMEZONE = 'UTC';
export const DEFAULT_BASE_URL = 'https://irishvisaupdatetracker.pages.dev';

const OFFICE_NAMES = {
  'new-delhi': 'New Delhi',
  beijing: 'Beijing',
  dublin: 'Dublin',
  'abu-dhabi': 'Abu Dhabi',
  abuja: 'Abuja',
  ankara: 'Ankara'
};

function normalizeNumber(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^IRL/i, '').toUpperCase();
}

/**
 * Find the current published row for a subscription. Office and number are
 * matched independently so a subscriber cannot accidentally receive a New
 * Delhi decision for a Beijing application.
 */
export function findDecision(rows, applicationNumber, embassy) {
  const number = normalizeNumber(applicationNumber);
  const office = String(embassy || '').trim();
  if (!number || !office) return null;
  return (rows || []).find((row) =>
    normalizeNumber(row.number) === number &&
    String(row.office || '').trim() === office
  ) || null;
}

/**
 * A decision date is the alert key. Re-running after a successful send is a
 * no-op; a correction with a newer report date gets one more alert.
 */
export function shouldSend(lastSent, decisionDate) {
  const sent = String(lastSent || '').slice(0, 10);
  const date = String(decisionDate || '').slice(0, 10);
  return Boolean(date) && (!sent || sent < date);
}

/** Parse a preferred delivery hour. Accepts 8, 08 and 08:00; minutes must be :00. */
export function parseDigestHour(value) {
  const match = /^([01]?\d|2[0-3])(?::00)?$/.exec(String(value == null ? '' : value).trim());
  return match ? Number(match[1]) : null;
}

/** Store an hour only when it is a whole 0-23 value; otherwise use the fallback. */
export function normalizeDigestHour(value, fallback = DEFAULT_DIGEST_HOUR) {
  const parsed = parseDigestHour(value);
  if (parsed !== null) return parsed;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 23 ? number : fallback;
}

/** Resolve an IANA timezone name, returning null when the runtime rejects it. */
export function normalizeDigestTimeZone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw.length > 64 || /\s/.test(raw)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function digestTimeZone(value, fallback = DEFAULT_DIGEST_TIMEZONE) {
  return normalizeDigestTimeZone(value) || normalizeDigestTimeZone(fallback) || DEFAULT_DIGEST_TIMEZONE;
}

export function formatDigestHour(hour) {
  return String(normalizeDigestHour(hour)).padStart(2, '0') + ':00';
}

/** Human sentence used by /start, /status and digest confirmations. */
export function describeDigest(frequency, hour, timeZone) {
  if (frequency === 'daily') {
    return 'a daily digest at ' + formatDigestHour(hour) + ' ' + digestTimeZone(timeZone) +
      ' (only when something changes)';
  }
  if (frequency === 'weekly') {
    return 'a weekly digest at ' + formatDigestHour(hour) + ' ' + digestTimeZone(timeZone) +
      ' (including a no-change summary)';
  }
  return 'immediate alerts';
}

function zonedClock(now, timeZone) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  if (!values.year || !values.month || !values.day || !values.hour) return null;
  return {
    date: values.year + '-' + values.month + '-' + values.day,
    hour: Number(values.hour)
  };
}

function calendarDayDifference(fromDate, toDate) {
  const from = Date.parse(fromDate + 'T00:00:00Z');
  const to = Date.parse(toDate + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * True when a digest is due in the chat's timezone.
 *
 * A digest does not fire before the preferred local hour. Daily digests become
 * due when the local calendar date has advanced since the last successful send;
 * weekly digests when seven local calendar dates have passed. Using the local
 * calendar rather than an exact 24-hour stopwatch means the chosen hour is the
 * actual delivery hour even after a late run or a daylight-saving change.
 */
export function dueForDigest(lastSent, frequency, now = Date.now(), options = {}) {
  if (!DIGEST_INTERVALS[frequency]) return false;
  const hour = normalizeDigestHour(options.hour);
  const timeZone = digestTimeZone(options.timeZone);
  const current = zonedClock(now, timeZone);
  if (!current || current.hour < hour) return false;
  if (!lastSent) return true;

  const sentAt = Date.parse(String(lastSent));
  if (!Number.isFinite(sentAt)) return true;
  const sent = zonedClock(new Date(sentAt), timeZone);
  if (!sent) return true;

  const elapsedDays = calendarDayDifference(sent.date, current.date);
  return frequency === 'weekly' ? elapsedDays >= 7 : elapsedDays >= 1;
}

/** Daily digests are suppressed when nothing changed; weekly digests send a
 *  deliberate no-change summary. */
export function shouldSendDigest(frequency, changedCount) {
  if (frequency === 'weekly') return true;
  if (frequency === 'daily') return Number(changedCount) > 0;
  return false;
}

/**
 * Group one chat's linked applications into a single digest message.
 * No-change offices are stated explicitly; a daily digest with no changes at
 * all is suppressed by the caller, while a weekly digest still sends it.
 */
export function buildDigestMessage(chatRows, options = {}) {
  const rows = Array.isArray(chatRows) ? chatRows : [];
  const base = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeZone = digestTimeZone(options.timeZone);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const current = zonedClock(now, timeZone);
  const changed = rows.filter((row) => row.decision);
  const offices = new Map();
  for (const row of rows) {
    const office = String(row.embassy || '').trim();
    if (!offices.has(office)) offices.set(office, []);
    offices.get(office).push(row);
  }

  const lines = [
    'Irish visa decision digest — ' + (current ? current.date : now.toISOString().slice(0, 10)),
    rows.length + ' tracked application' + (rows.length === 1 ? '' : 's') +
      ' · ' + changed.length + ' new decision' + (changed.length === 1 ? '' : 's'),
    ''
  ];

  if (!changed.length) {
    lines.push('No new published decisions for your linked applications.');
  } else {
    for (const [office, officeRows] of offices) {
      const changedRows = officeRows.filter((row) => row.decision);
      const unchanged = officeRows.length - changedRows.length;
      if (!changedRows.length) {
        lines.push((OFFICE_NAMES[office] || office) + ': no change (' + unchanged +
          ' application' + (unchanged === 1 ? '' : 's') + ').');
        continue;
      }
      lines.push((OFFICE_NAMES[office] || office) + ':');
      for (const row of changedRows) {
        lines.push('• ' + row.application_number + ' — ' + row.decision.decision +
          ' (decision ' + row.decision.date + ', published ' + row.decision.report_date + ')');
      }
      if (unchanged > 0) lines.push('  No change for ' + unchanged + ' other application' + (unchanged === 1 ? '' : 's') + '.');
      lines.push('');
    }
  }

  lines.push('View or manage: ' + base + '/?tracker=visa&tab=alerts');
  lines.push('Send /status to review linked applications, /digest off for immediate alerts.');
  return lines.join('\n').slice(0, 4000);
}
