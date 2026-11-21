/**
 * Canonical publication schedule for the six Irish visa offices.
 *
 * This module deliberately contains no I/O so the static build, the calendar
 * function and the freshness model can all answer the same question:
 * "when is the next expected file after this report date?"
 *
 * Dates are UTC calendar dates. Beijing is irregular, so it has no derived
 * expected date rather than an invented weekly window.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PUBLICATION_SCHEDULES = Object.freeze({
  'new-delhi': {
    name: 'New Delhi',
    kind: 'weekday',
    weekday: null,
    intervalDays: 1,
    cadenceDays: 3,
    hourUtc: 5,
    minuteUtc: 30,
    durationMinutes: 60,
    scheduleLabel: 'weekdays around 11:00 IST (05:30 UTC)',
  },
  beijing: {
    name: 'Beijing',
    kind: 'irregular',
    weekday: null,
    intervalDays: null,
    cadenceDays: 35,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'irregular snapshots; no fixed publication schedule',
  },
  dublin: {
    name: 'Dublin',
    kind: 'weekday',
    weekday: 2,
    intervalDays: 7,
    cadenceDays: 7,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'Tuesdays (06:00 UTC)',
  },
  'abu-dhabi': {
    name: 'Abu Dhabi',
    kind: 'weekly',
    weekday: 5,
    intervalDays: 7,
    cadenceDays: 14,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'weekly report; window follows the latest report date (06:00 UTC)',
  },
  abuja: {
    name: 'Abuja',
    kind: 'weekly',
    weekday: 6,
    intervalDays: 7,
    cadenceDays: 14,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'weekly report; window follows the latest report date (06:00 UTC)',
  },
  ankara: {
    name: 'Ankara',
    kind: 'weekly',
    weekday: 0,
    intervalDays: 7,
    cadenceDays: 14,
    hourUtc: 6,
    minuteUtc: 0,
    durationMinutes: 120,
    scheduleLabel: 'weekly report; window follows the latest report date (06:00 UTC)',
  },
});

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export function addDays(value, days) {
  const date = isoDate(value);
  if (!date) return '';
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function weekday(value) {
  const date = isoDate(value);
  return date ? new Date(`${date}T00:00:00Z`).getUTCDay() : -1;
}

export function isWeekend(value) {
  const day = weekday(value);
  return day === 0 || day === 6;
}

/** Next weekday strictly after `value`. */
export function nextWeekday(value) {
  let date = addDays(value, 1);
  for (let index = 0; date && index < 8; index += 1) {
    if (!isWeekend(date)) return date;
    date = addDays(date, 1);
  }
  return date;
}

/** Next occurrence of a weekday (0 Sunday ... 6 Saturday) strictly after `value`. */
export function nextWeekdayNumber(value, target) {
  let date = addDays(value, 1);
  for (let index = 0; date && index < 8; index += 1) {
    if (weekday(date) === target) return date;
    date = addDays(date, 1);
  }
  return date;
}

export function scheduleFor(slug) {
  return PUBLICATION_SCHEDULES[slug] || null;
}

/** The machine-readable rule used by browser clients. */
export function expectedRule(slug) {
  const schedule = scheduleFor(slug);
  if (!schedule) return { kind: 'irregular', weekday: null, interval: null };
  return {
    kind: schedule.kind,
    weekday: schedule.weekday,
    interval: schedule.intervalDays,
  };
}

/** First expected file date after the latest report date. */
export function expectedDate(reportDate, slug) {
  const latest = isoDate(reportDate);
  const schedule = scheduleFor(slug);
  if (!latest || !schedule || schedule.kind === 'irregular') return '';
  if (schedule.kind === 'weekday' && schedule.weekday == null) return nextWeekday(latest);
  if (schedule.kind === 'weekday') return nextWeekdayNumber(latest, schedule.weekday);
  return addDays(latest, schedule.intervalDays);
}

/** First expected file date on or after the as-of date. */
export function expectedAfter(reportDate, slug, asOf) {
  let date = expectedDate(reportDate, slug);
  const today = isoDate(asOf);
  for (let index = 0; date && today && date <= today && index < 366; index += 1) {
    date = expectedDate(date, slug);
  }
  return date;
}

/** A compact label for a schedule date. */
export function scheduleLabel(slug) {
  const schedule = scheduleFor(slug);
  return schedule ? schedule.scheduleLabel : '';
}
