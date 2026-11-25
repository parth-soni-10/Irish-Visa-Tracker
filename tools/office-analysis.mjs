#!/usr/bin/env node
/**
 * Per-office analysis of the published report series.
 *
 * The office pages already carry a static "recent report history" table. This
 * module adds the part a data table cannot say by itself: how often the office
 * publishes, how much of the file is approved over the whole archived run, how
 * concentrated publication is, and - most importantly - what the file cannot
 * tell a reader. Every sentence is built from the archived reports, so a thin
 * series (a single Beijing snapshot) says so instead of inventing a trend.
 *
 * The output is injected at build time into `data-office-analysis="<slug>"`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** How each office's file accumulates. This decides which arithmetic is
 *  honest: summing cumulative New Delhi files would multiply the same rows. */
export const OFFICE_SERIES_KIND = {
  'new-delhi': 'cumulative',
  beijing: 'snapshot',
  'abu-dhabi': 'weekly',
  abuja: 'weekly',
  ankara: 'weekly',
  dublin: 'snapshot',
};

const iso = (value) => String(value || '').slice(0, 10);
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const num = (value) => (Number(value) || 0).toLocaleString('en-IE');
const pct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '0.0%');
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function longDate(value) {
  const raw = iso(value);
  if (!isDate(raw)) return '';
  const [year, month, day] = raw.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${iso(to)}T00:00:00Z`) - Date.parse(`${iso(from)}T00:00:00Z`)) / DAY);

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!list.length) return 0;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

/** One row per published file date. Repeated checks of an unchanged file
 *  collapse to the largest row for that date, mirroring the report archive. */
export function seriesFromEntries(entries) {
  const byDate = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const date = iso(entry.report_date);
    if (!isDate(date)) continue;
    const decisions = Number(entry.decisions);
    if (!Number.isFinite(decisions) || decisions < 0) continue;
    const row = {
      date,
      decisions,
      approved: Number(entry.approved),
      refused: Number(entry.refused),
      source: String(entry.source_file || entry.source_url || ''),
    };
    const existing = byDate.get(date);
    if (!existing || row.decisions > existing.decisions) byDate.set(date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function shareRange(rows) {
  const shares = rows
    .filter((row) => row.decisions > 0 && Number.isFinite(row.approved))
    .map((row) => (row.approved / row.decisions) * 100);
  if (!shares.length) return { low: null, high: null };
  return { low: Math.min(...shares), high: Math.max(...shares) };
}

function cadence(rows) {
  if (rows.length < 2) return { days: 0, label: 'one published file' };
  const gaps = [];
  for (let index = 1; index < rows.length; index += 1) {
    const gap = daysBetween(rows[index - 1].date, rows[index].date);
    if (gap > 0) gaps.push(gap);
  }
  const days = median(gaps);
  let label;
  if (days <= 3) label = 'about every one to two days';
  else if (days <= 8) label = 'about weekly';
  else if (days <= 16) label = 'about fortnightly';
  else if (days <= 45) label = 'about monthly';
  else label = 'irregularly';
  return { days, label };
}

/**
 * Build the analysis object for one office. All arithmetic follows the file
 * kind so a cumulative list is never summed and a single snapshot never
 * pretends to be a series.
 */
export function officeAnalysis(slug, entries, { checkedDate = '' } = {}) {
  const kind = OFFICE_SERIES_KIND[slug] || 'weekly';
  const rows = seriesFromEntries(entries);
  const first = rows[0] || null;
  const last = rows[rows.length - 1] || null;
  const outcomes = rows.filter((row) =>
    Number.isFinite(row.approved) && Number.isFinite(row.refused) && row.decisions > 0);
  const { low, high } = shareRange(outcomes);
  const cadenceInfo = cadence(rows);

  let totalDecisions = 0;
  let totalApproved = 0;
  let totalRefused = 0;
  let average = 0;
  let largest = null;
  let smallest = null;
  let change = null;
  let staleDays = 0;

  if (kind === 'cumulative' && last) {
    totalDecisions = last.decisions;
    totalApproved = Number.isFinite(last.approved) ? last.approved : 0;
    totalRefused = Number.isFinite(last.refused) ? last.refused : 0;
    average = rows.length ? totalDecisions / rows.length : 0;
    largest = last;
    smallest = first;
    const previous = rows[rows.length - 2] || null;
    if (previous) {
      const added = last.decisions - previous.decisions;
      const days = Math.max(1, daysBetween(previous.date, last.date));
      if (added >= 0) {
        change = {
          added,
          days,
          perDay: added / days,
          from: previous.date,
          to: last.date,
        };
      }
    }
  } else if (kind === 'weekly') {
    totalDecisions = rows.reduce((sum, row) => sum + row.decisions, 0);
    totalApproved = outcomes.reduce((sum, row) => sum + row.approved, 0);
    totalRefused = outcomes.reduce((sum, row) => sum + row.refused, 0);
    average = rows.length ? totalDecisions / rows.length : 0;
    const published = rows.filter((row) => row.decisions > 0);
    if (published.length) {
      largest = published.reduce((best, row) => (row.decisions > best.decisions ? row : best));
      smallest = published.reduce((best, row) => (row.decisions < best.decisions ? row : best));
    }
  } else {
    totalDecisions = last ? last.decisions : 0;
    totalApproved = last && Number.isFinite(last.approved) ? last.approved : 0;
    totalRefused = last && Number.isFinite(last.refused) ? last.refused : 0;
    average = totalDecisions;
    largest = last;
    smallest = last;
    if (last && isDate(iso(checkedDate)) && iso(checkedDate) > last.date) {
      staleDays = daysBetween(last.date, iso(checkedDate));
    }
  }

  const approvalShare = totalDecisions ? (totalApproved / totalDecisions) * 100 : 0;

  return {
    slug,
    kind,
    rows: rows.length,
    first: first ? first.date : '',
    last: last ? last.date : '',
    cadenceDays: cadenceInfo.days,
    cadenceLabel: cadenceInfo.label,
    outcomes: outcomes.length,
    totalDecisions,
    totalApproved,
    totalRefused,
    approvalShare,
    shareLow: low,
    shareHigh: high,
    average,
    largest,
    smallest,
    change,
    staleDays,
  };
}

function cannotTell(kind) {
  const common = [
    'It cannot tell you that your application was decided on a particular day, or why a decision was made. The files carry an outcome, not a reason.',
    'It does not publish an application-date queue, nationality, visa category or applicant demographics. Any statement about those is unsupported by this data.',
    'A number that is absent is not a refusal. It may be unpublished, in another office’s file, or written differently on your receipt.',
  ];
  if (kind === 'cumulative') {
    return [
      'A cumulative file is a running total. The size of the file is not the number of decisions made that day, and the growth between two files is publication output, not demand.',
      ...common,
    ];
  }
  if (kind === 'snapshot') {
    return [
      'A single published snapshot cannot show a trend. The tracker holds one list, not a dated archive, so a comparison over time would be invented.',
      ...common,
    ];
  }
  return [
    'A weekly report is dated at the end of its reporting period. That date is not the date of an individual decision inside the period.',
    'Reports are periods, not a queue: the count shows published decisions, not how many applications are waiting.',
    ...common,
  ];
}

function interpretation(analysis) {
  const { kind } = analysis;
  if (!analysis.rows) {
    return 'The tracker holds no archived report for this office yet, so this section makes no claim about its publication pattern.';
  }
  if (kind === 'cumulative') {
    const growth = analysis.change
      ? ` Between the previous file (${longDate(analysis.change.from)}) and the latest (${longDate(analysis.change.to)}) the list grew by ${num(analysis.change.added)} decisions, about ${num(Math.round(analysis.change.perDay))} a day.`
      : '';
    return `The archived report files run from ${longDate(analysis.first)} to ${longDate(analysis.last)}, ${analysis.cadenceLabel}. Because the file is cumulative, the latest file total (${num(analysis.totalDecisions)}) is the current published count, not a sum of the archive.${growth} The daily growth is publication output, not the number of applications received. This section uses the report files that carry their own totals; the page’s searchable history includes every dated decision row and can be wider than the file count here.`;
  }
  if (kind === 'snapshot') {
    const age = analysis.staleDays > 1
      ? ` The snapshot was ${num(analysis.staleDays)} days old at the last successful tracker check, which is why a missing number may simply be unpublished.`
      : '';
    return `The tracker holds ${analysis.rows === 1 ? 'one published list' : `${analysis.rows} published lists`}, most recently dated ${longDate(analysis.last)}. A snapshot describes that file only, so this page does not claim a trend across time.${age}`;
  }
  return `Across ${analysis.rows} archived report${analysis.rows === 1 ? '' : 's'} (${longDate(analysis.first)} to ${longDate(analysis.last)}, ${analysis.cadenceLabel}) the office published ${num(analysis.totalDecisions)} decisions, an average of ${num(Math.round(analysis.average))} per report. Summing separate reporting periods is valid here because each report covers its own period; the period-end date is still not an individual decision date.`;
}

export function officeAnalysisHtml(analysis, { name = '' } = {}) {
  if (!analysis || !analysis.rows) {
    return `<p class="small-note">No archived report is available for ${esc(name || 'this office')} yet, so this section makes no claim about its publication pattern.</p>`;
  }
  const label = name || analysis.slug;
  const stats = `<div class="study-grid">
        <div class="study-stat"><span class="status-kicker">Archived report files</span><strong>${num(analysis.rows)}</strong><span>${esc(longDate(analysis.first))} to ${esc(longDate(analysis.last))}</span></div>
        <div class="study-stat"><span class="status-kicker">${analysis.kind === 'cumulative' ? 'Latest file' : 'Decisions in archive'}</span><strong>${num(analysis.totalDecisions)}</strong><span>${analysis.kind === 'cumulative' ? 'Cumulative, not a daily count' : 'Published rows'}</span></div>
        <div class="study-stat"><span class="status-kicker">Approved share</span><strong>${pct(analysis.totalApproved, analysis.totalDecisions)}</strong><span>${num(analysis.totalApproved)} approved, ${num(analysis.totalRefused)} refused</span></div>
        <div class="study-stat"><span class="status-kicker">Publication cadence</span><strong>${esc(analysis.cadenceLabel)}</strong><span>${analysis.cadenceDays ? `Median ${num(analysis.cadenceDays)} day${analysis.cadenceDays === 1 ? '' : 's'} between files` : 'Single file'}</span></div>
      </div>`;

  const rows = [
    ['File kind', analysis.kind === 'cumulative' ? 'Cumulative list, republished' : analysis.kind === 'snapshot' ? 'Snapshot of one list' : 'Separate reporting periods'],
    ['Archived report files', `${num(analysis.rows)} (${esc(longDate(analysis.first))} to ${esc(longDate(analysis.last))})`],
    ['Decisions', `${num(analysis.totalDecisions)}${analysis.kind === 'cumulative' ? ' in the latest file' : ' across the archived reports'}`],
    ['Approved / refused', `${num(analysis.totalApproved)} / ${num(analysis.totalRefused)}`],
    ['Approval share', pct(analysis.totalApproved, analysis.totalDecisions)],
    ['Approval share range', analysis.shareLow == null ? 'Not available in the archived rows' : `${pct(analysis.shareLow, 100)} to ${pct(analysis.shareHigh, 100)} across file dates`],
    ['Median decisions per file', num(Math.round(analysis.average))],
    ['Largest file', analysis.largest ? `${esc(longDate(analysis.largest.date))}: ${num(analysis.largest.decisions)} decisions` : 'Not available'],
    ['Smallest file', analysis.smallest ? `${esc(longDate(analysis.smallest.date))}: ${num(analysis.smallest.decisions)} decisions` : 'Not available'],
  ];

  return `${stats}
      <p>${esc(interpretation(analysis))}</p>
      <div class="table-wrap" role="region" aria-label="${esc(label)} publication analysis" tabindex="0">
        <table class="office-table">
          <caption>Computed from the ${esc(label)} reports in the tracker’s public archive. A missing file is a gap, not a zero.</caption>
          <thead><tr><th scope="col">Measure</th><th scope="col">Value</th></tr></thead>
          <tbody>${rows.map(([key, value]) => `<tr><th scope="row">${esc(key)}</th><td>${value}</td></tr>`).join('\n            ')}</tbody>
        </table>
      </div>
      <h3>What this file cannot tell you</h3>
      <ul>${cannotTell(analysis.kind).map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      <p class="small-note">Approval share is approved published rows divided by published rows. It describes the file, not the chance that any particular application will be approved. <a href="/about#method">Method and sources</a> · <a href="/corrections">Correction ledger</a> · <a href="/data-study">Data study</a></p>`;
}

export function loadOfficeAnalysis(slug, assetsRoot = ROOT) {
  const file = path.join(assetsRoot, 'data', 'reports', 'index.json');
  let reports = {};
  try { reports = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { reports = {}; }
  const manifestPath = path.join(assetsRoot, 'data', 'data_manifest.json');
  let manifest = { offices: [] };
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = { offices: [] }; }
  const office = (Array.isArray(manifest.offices) ? manifest.offices : []).find((item) => item && item.slug === slug) || {};
  const checkedDate = iso(office.last_success_at || office.as_of || office.fetched_at || '');
  return officeAnalysis(slug, (reports.offices && reports.offices[slug]) || [], { checkedDate });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const [slug, kind] of Object.entries(OFFICE_SERIES_KIND)) {
    const analysis = loadOfficeAnalysis(slug);
    console.log(`${slug} (${kind}): ${analysis.rows} file date(s), ${analysis.totalDecisions} decisions, ${pct(analysis.totalApproved, analysis.totalDecisions)} approved`);
  }
}
