#!/usr/bin/env node
/**
 * One canonical freshness model for the whole site.
 *
 * Every surface used to phrase "latest" differently: the SPA called the
 * newest decision date the "latest file", the office pages used the manifest
 * report date, and the status/report pages counted Dublin's live snapshot as a
 * dated report. This module derives one record per office from the manifest and
 * the published rows, and formats the single line every page can show:
 *
 *   New Delhi — report 19 November 2026 · 43,599 decisions · decisions dated
 *   through 20 November 2026 · checked 21 Nov 2026, 14:53 UTC · Official
 *
 * The generated JSON is also written to data/freshness.json so the SPA and
 * scripts can read the same values without re-deriving them.
 *
 *   node tools/freshness.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SNAPSHOT_OFFICES = new Set(['beijing', 'dublin']);
const CADENCE_DAYS = {
  'new-delhi': 3,
  beijing: 35,
  dublin: 7,
  'abu-dhabi': 14,
  abuja: 14,
  ankara: 14,
};

// Staleness uses a deliberately generous cadence: a weekly office can skip a
// week without its file being wrong. Due dates use the actual publication
// rhythm instead, so a missed weekly window is visible rather than rolled
// forward to the next one.
const EXPECTED_INTERVAL_DAYS = {
  'new-delhi': 1,
  beijing: null,
  dublin: 7,
  'abu-dhabi': 7,
  abuja: 7,
  ankara: 7,
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function longDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

function shortDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function checkedStamp(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return shortDate(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23',
  }) + ' UTC';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function officeRows(assetsRoot, slug) {
  const file = slug === 'new-delhi'
    ? path.join(assetsRoot, 'data', 'visa_decisions.json')
    : path.join(assetsRoot, 'data', `embassy-${slug}.json`);
  const payload = readJson(file);
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const rows = payload.rows || payload.decisions || payload.data;
  return Array.isArray(rows) ? rows : [];
}

function rowDate(row) {
  if (Array.isArray(row)) return String(row[0] || '').slice(0, 10);
  return String((row && (row.date || row.decision_date)) || '').slice(0, 10);
}

// The tracker carries notice rows such as "NO_FILE_2026-11-21 — Visa Office is
// closed". They are not decisions and must not move the "decisions through"
// date or be counted as a publication day.
function isDecisionRow(row) {
  const decision = Array.isArray(row) ? row[2] : (row && row.decision);
  return /^(approved|refused|accepted|rejected)$/i.test(String(decision || '').trim());
}

function daysBetween(from, to) {
  const start = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86400000));
}

function addDays(value, days) {
  const base = Date.parse(`${String(value || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(base)) return '';
  return new Date(base + days * 86400000).toISOString().slice(0, 10);
}

function weekday(value) {
  const base = Date.parse(`${String(value || '').slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(base) ? new Date(base).getUTCDay() : -1;
}

function nextWeekday(value) {
  let date = addDays(value, 1);
  for (let i = 0; date && i < 8; i += 1) {
    const day = weekday(date);
    if (day !== 0 && day !== 6) return date;
    date = addDays(date, 1);
  }
  return date;
}

function nextExpectedDate(reportDate, slug) {
  const interval = EXPECTED_INTERVAL_DAYS[slug];
  if (!reportDate || interval == null) return '';
  return slug === 'new-delhi' ? nextWeekday(reportDate) : addDays(reportDate, interval);
}

function nextExpectedAfter(reportDate, slug, asOf) {
  let date = nextExpectedDate(reportDate, slug);
  for (let i = 0; date && asOf && date <= asOf && i < 60; i += 1) {
    date = slug === 'new-delhi' ? nextWeekday(date) : addDays(date, EXPECTED_INTERVAL_DAYS[slug]);
  }
  return date;
}

function isWeekend(value) {
  const day = weekday(value);
  return day === 0 || day === 6;
}

function ageLabel(age) {
  return Number.isFinite(age) ? `${age} day${age === 1 ? '' : 's'} old` : '';
}

function freshnessText(office) {
  const kind = office.snapshot ? 'snapshot' : 'report';
  const parts = [
    `${office.name} — ${kind} ${longDate(office.report_date)}`,
    `${office.decisions.toLocaleString('en-IE')} decisions`,
  ];
  const through = longDate(office.latest_decision_date);
  if (through && office.latest_decision_date !== office.report_date) {
    parts.push(`decisions dated through ${through}`);
  }
  if (office.age_label) parts.push(office.age_label);
  const checked = checkedStamp(office.checked_at);
  if (checked) parts.push(`checked ${checked}`);
  return parts.join(' · ');
}

function freshnessWarning(office) {
  if (office.status === 'error') {
    return office.note || 'The tracker could not read a newer official file for this office.';
  }
  if (office.overdue) {
    return `This office report is overdue: expected since ${longDate(office.due_at)}.` +
      (office.next_due_label ? ` ${office.next_due_label}.` : '');
  }
  if (office.stale) {
    return `This office report is ${office.age_days} days old; a newer decision may not appear here yet.`;
  }
  return '';
}

/** Build the canonical freshness record from the manifest + published rows. */
export function loadFreshness(assetsRoot = ROOT) {
  const manifest = readJson(path.join(assetsRoot, 'data', 'data_manifest.json')) || {};
  const asOf = String(manifest.generated_at || '').slice(0, 10);
  const offices = (Array.isArray(manifest.offices) ? manifest.offices : []).map((office) => {
    const slug = office.slug;
    const rows = officeRows(assetsRoot, slug).filter(isDecisionRow);
    const dates = rows.map(rowDate).filter(Boolean).sort();
    const through = dates[dates.length - 1] || String(office.report_date || '').slice(0, 10);
    const snapshot = SNAPSHOT_OFFICES.has(slug);
    const reportDate = String(office.report_date || '').slice(0, 10);
    const age = daysBetween(reportDate, asOf || reportDate);
    const cadence = CADENCE_DAYS[slug] || 14;
    const status = String(office.status || 'official');
    // fetched_at is the last successful read of this office's file; the
    // manifest's generated_at is the latest pipeline run, which may have
    // failed for this office. Keep the two times separate so status and
    // citations do not imply a failed run was a successful check.
    const successAt = office.fetched_at || office.as_of || '';
    const attemptAt = manifest.generated_at || office.as_of || successAt;
    const stale = age !== null && age > cadence;
    const dueAt = nextExpectedDate(reportDate, slug);
    const nextDueAt = nextExpectedAfter(reportDate, slug, asOf);
    // New Delhi publishes on weekdays. A Friday file is not overdue just
    // because the build ran on Saturday, so suppress that weekend-only gap.
    const overdue = Boolean(dueAt && asOf && dueAt < asOf && !(slug === 'new-delhi' && isWeekend(asOf)));
    const dueLabel = dueAt
      ? overdue
        ? `Due since ${longDate(dueAt)} — not yet published`
        : `Expected ${longDate(dueAt >= asOf ? dueAt : nextDueAt)}`
      : '';
    const nextDueLabel = overdue && nextDueAt ? `Next expected ${longDate(nextDueAt)}` : '';
    const statusTone = status === 'error'
      ? 'error'
      : status !== 'official' || stale || overdue ? 'warn' : '';
    return {
      slug,
      name: office.name || slug,
      published_at: reportDate,
      report_date: reportDate,
      decisions_through: through,
      latest_decision_date: through,
      decisions: Number(office.decisions) || 0,
      approved: Number(office.approved) || 0,
      refused: Number(office.refused) || 0,
      checked_at: successAt,
      checked_label: checkedStamp(successAt),
      last_success_at: successAt,
      last_attempt_at: attemptAt,
      last_success_label: checkedStamp(successAt),
      last_attempt_label: checkedStamp(attemptAt),
      status,
      status_label: status === 'error' ? 'Error' : snapshot ? 'Snapshot' : status.charAt(0).toUpperCase() + status.slice(1),
      status_tone: statusTone,
      attention: Boolean(statusTone),
      note: office.note || '',
      snapshot,
      stale,
      age_days: age,
      age_label: ageLabel(age),
      cadence_days: cadence,
      due_at: dueAt,
      next_due_at: nextDueAt,
      overdue_days: overdue ? daysBetween(dueAt, asOf) : 0,
      overdue,
      due_label: dueLabel,
      due_short_label: overdue ? `Due since ${shortDate(dueAt)}` : '',
      next_due_label: nextDueLabel,
    };
  });

  // Every rendered surface reads these instead of rebuilding the sentence,
  // warning or status-chip class from the raw manifest fields.
  for (const office of offices) {
    office.summary = freshnessText(office);
    office.warning = freshnessWarning(office);
  }

  return {
    generated_at: manifest.generated_at || '',
    as_of: asOf,
    offices,
    bySlug: Object.fromEntries(offices.map((office) => [office.slug, office])),
  };
}

export function writeFreshness(assetsRoot = ROOT) {
  const data = loadFreshness(assetsRoot);
  const out = path.join(assetsRoot, 'data', 'freshness.json');
  fs.writeFileSync(out, JSON.stringify({
    generated_at: data.generated_at,
    as_of: data.as_of,
    offices: data.offices,
  }, null, 2) + '\n');
  return { path: out, data };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { path: out, data } = writeFreshness();
  console.log(`Freshness: ${data.offices.length} offices -> ${path.relative(ROOT, out)}`);
}
