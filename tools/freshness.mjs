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
 *   New Delhi — report 19 November 2026 · 43,599 decisions · checked
 *   21 Nov 2026, 14:53 UTC
 *   Tracker observed decisions dated through 20 November 2026; these are not
 *   in the 19 November 2026 official file.
 *
 * The generated JSON is also written to data/freshness.json so the SPA and
 * scripts can read the same values without re-deriving them. The official
 * count is paired only with official_data_through; latest_decision_date and
 * decisions_through remain the tracker-observed dates for older clients.
 *
 *   node tools/freshness.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expectedAfter,
  expectedDate,
  expectedRule,
  isWeekend,
  scheduleFor,
} from '../shared/publication-schedule.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SNAPSHOT_OFFICES = new Set(['beijing', 'dublin']);

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

function readOfficeRows(file) {
  const payload = readJson(file);
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const rows = payload.rows || payload.decisions || payload.data;
  return Array.isArray(rows) ? rows : [];
}

// The latest official office file. Its rows are the source of the official
// decision count and the official data-through date.
function officialRows(assetsRoot, slug) {
  return readOfficeRows(path.join(assetsRoot, 'data', `embassy-${slug}.json`));
}

// New Delhi's tracker file can contain partial observations dated after the
// latest official file. Other offices keep their observations in the official
// file, so the two sources are the same for them.
function trackerRows(assetsRoot, slug) {
  if (slug !== 'new-delhi') return officialRows(assetsRoot, slug);
  return readOfficeRows(path.join(assetsRoot, 'data', 'visa_decisions.json'));
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

function ageLabel(age) {
  return Number.isFinite(age) ? `${age} day${age === 1 ? '' : 's'} old` : '';
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
}

/** Render a timestamp with an honest UTC fallback that the time-mode helper can
 *  switch in place. Date-only values stay date-only and are not treated as a
 *  clock time. */
export function timeHTML(value, preset = 'full') {
  const raw = String(value || '');
  if (!raw) return '<span class="not-recorded">Not recorded</span>';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `<time datetime="${escapeHtml(raw)}">${escapeHtml(shortDate(raw))}</time>`;
  }
  const label = checkedStamp(raw);
  return `<time datetime="${escapeHtml(raw)}" data-iv-time="${escapeHtml(raw)}" data-iv-time-format="${escapeHtml(preset)}">${escapeHtml(label || raw)}</time>`;
}

function freshnessText(office) {
  const kind = office.snapshot ? 'snapshot' : 'report';
  const parts = [
    `${office.name} — ${kind} ${longDate(office.report_date)}`,
    `${office.decisions.toLocaleString('en-IE')} decisions`,
  ];
  const through = longDate(office.official_data_through);
  if (through && office.official_data_through !== office.report_date) {
    parts.push(`official decisions dated through ${through}`);
  }
  if (office.age_label) parts.push(office.age_label);
  const checked = checkedStamp(office.checked_at);
  if (checked) parts.push(`checked ${checked}`);
  return parts.join(' · ');
}

// A separate sentence, never mixed into the official summary: tracker rows can
// be newer than the latest official file, but they are not part of its count.
function observationText(office) {
  const observed = longDate(office.observed_data_through);
  const official = longDate(office.report_date);
  if (!observed || !official || office.observed_data_through <= office.official_data_through) return '';
  return `Tracker observed decisions dated through ${observed}; these are not in the ${official} official file.`;
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
    return `This office report is ${office.age_label}; a newer decision may not appear here yet.`;
  }
  return '';
}

/**
 * First observation of each archived report. The archive can contain repeated
 * checks of one report date (Dublin especially); only the earliest check is the
 * observation lag, and backfilled history is excluded from the lag sample
 * because its fetch time is the backfill time, not a publication observation.
 */
function observationHistory(assetsRoot, slug) {
  const reportDoc = readJson(path.join(assetsRoot, 'data', 'reports', 'index.json')) || {};
  const entries = reportDoc.offices && Array.isArray(reportDoc.offices[slug])
    ? reportDoc.offices[slug]
    : [];
  const firstByDate = new Map();
  for (const entry of entries) {
    const reportDate = String(entry && entry.report_date || '').slice(0, 10);
    const observedAt = String(entry && entry.fetched_at || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate) || !observedAt) continue;
    const existing = firstByDate.get(reportDate);
    if (!existing || observedAt < existing.observed_at) {
      firstByDate.set(reportDate, {
        report_date: reportDate,
        observed_at: observedAt,
        backfilled: Boolean(entry.backfilled),
        lag_days: daysBetween(reportDate, observedAt),
      });
    }
  }
  const history = [...firstByDate.values()]
    .sort((a, b) => b.report_date.localeCompare(a.report_date));
  const lags = history
    .filter((entry) => !entry.backfilled && entry.lag_days != null)
    .map((entry) => entry.lag_days)
    .sort((a, b) => a - b);
  const median = lags.length
    ? (lags.length % 2 ? lags[Math.floor(lags.length / 2)] : Math.round((lags[lags.length / 2 - 1] + lags[lags.length / 2]) / 2))
    : null;
  return {
    sample_size: lags.length,
    min_days: lags.length ? lags[0] : null,
    max_days: lags.length ? lags[lags.length - 1] : null,
    median_days: median,
    latest_report_date: history[0] ? history[0].report_date : '',
    latest_observed_at: history[0] ? history[0].observed_at : '',
    history: history.slice(0, 6),
  };
}

/** Build the canonical freshness record from the manifest + published rows. */
export function loadFreshness(assetsRoot = ROOT) {
  const manifest = readJson(path.join(assetsRoot, 'data', 'data_manifest.json')) || {};
  const asOf = String(manifest.generated_at || '').slice(0, 10);
  const offices = (Array.isArray(manifest.offices) ? manifest.offices : []).map((office) => {
    const slug = office.slug;
    const reportDate = String(office.report_date || '').slice(0, 10);
    const officialDates = officialRows(assetsRoot, slug).filter(isDecisionRow).map(rowDate).filter(Boolean).sort();
    const observedDates = trackerRows(assetsRoot, slug).filter(isDecisionRow).map(rowDate).filter(Boolean).sort();
    const officialThrough = officialDates[officialDates.length - 1] || reportDate;
    const observedThrough = observedDates[observedDates.length - 1] || officialThrough;
    // Keep the historical decisions-through fields on the tracker-observed
    // date for API compatibility. Official-facing tables use
    // official_data_through instead.
    const through = observedThrough;
    const snapshot = SNAPSHOT_OFFICES.has(slug);
    const age = daysBetween(reportDate, asOf || reportDate);
    const schedule = scheduleFor(slug);
    const cadence = schedule ? schedule.cadenceDays : 14;
    const status = String(office.status || 'official');
    // fetched_at is the last successful read of this office's file; the
    // manifest's generated_at is the latest pipeline run, which may have
    // failed for this office. Keep the two times separate so status and
    // citations do not imply a failed run was a successful check.
    const successAt = office.fetched_at || office.as_of || '';
    const attemptAt = manifest.generated_at || office.as_of || successAt;
    const stale = age !== null && age > cadence;
    const ageLabelAtBuild = ageLabel(age) ? `${ageLabel(age)} at last build` : '';
    const dueAt = expectedDate(reportDate, slug);
    const nextDueAt = expectedAfter(reportDate, slug, asOf);
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
      official_data_through: officialThrough,
      observed_data_through: observedThrough,
      observation_scope: observedThrough > officialThrough ? 'tracker' : 'official',
      // Legacy tracker-observed fields retained for existing JSON clients.
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
      age_label_at_build: ageLabelAtBuild,
      cadence_days: cadence,
      expected_rule: expectedRule(slug),
      due_at: dueAt,
      next_due_at: nextDueAt,
      overdue_days: overdue ? daysBetween(dueAt, asOf) : 0,
      overdue,
      due_label: dueLabel,
      due_short_label: overdue ? `Due since ${shortDate(dueAt)}` : '',
      next_due_label: nextDueLabel,
      observation_lag: observationHistory(assetsRoot, slug),
    };
  });

  // Every rendered surface reads these instead of rebuilding the sentence,
  // warning or status-chip class from the raw manifest fields.
  for (const office of offices) {
    office.observation_note = observationText(office);
    // The generated JSON is also a static fallback. Its human-readable labels
    // must say they are build-time values; browser clients recompute them from
    // the absolute report/due dates before rendering.
    const atBuild = { ...office, age_label: office.age_label_at_build };
    office.summary_at_build = freshnessText(atBuild);
    office.warning_at_build = freshnessWarning(atBuild);
    office.summary = office.summary_at_build;
    office.warning = office.warning_at_build;
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
