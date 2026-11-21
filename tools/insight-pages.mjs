#!/usr/bin/env node
/**
 * Insight and archive pages.
 *
 * Builds the original data study, the publication-schedule explainer, the
 * official-report archive and permalinks, the press/citation kit, embeddable
 * latest-file badges and the privacy-safe community aggregate. Everything is
 * derived from the public JSON files that already ship with the site; nothing
 * here estimates an individual applicant's chance of approval.
 *
 *   node tools/insight-pages.mjs --write   # refresh checked-in pages/assets
 *   node tools/insight-pages.mjs           # build all outputs into .pages-dist
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES, spliceChrome } from './site-chrome.mjs';
import { SITE_ORIGIN } from './site-config.mjs';
import { loadFreshness, SNAPSHOT_OFFICES, timeHTML } from './freshness.mjs';
import { expectedAfter, expectedDate } from '../shared/publication-schedule.js';
import { freshnessFooterHTML, freshnessHistoryHTML } from './freshness-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MIN_COMMUNITY_SAMPLE = 10;
const OFFICE_ORDER = ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin'];

const OFFICE_META = {
  'new-delhi': {
    short: 'New Delhi',
    route: '/new-delhi-visa-decisions',
    cadence: 'Each weekday morning, usually by about 11:00 IST',
    next: 'weekday',
    basis: 'Cumulative official file',
  },
  beijing: {
    short: 'Beijing',
    route: '/beijing-visa-decisions',
    cadence: 'Irregular snapshots; no fixed publication schedule',
    next: null,
    basis: 'Cumulative snapshot',
  },
  'abu-dhabi': {
    short: 'Abu Dhabi',
    route: '/abu-dhabi-visa-decisions',
    cadence: 'Weekly report, usually with a Friday period end',
    next: 7,
    basis: 'Weekly report',
  },
  abuja: {
    short: 'Abuja',
    route: '/abuja-visa-decisions',
    cadence: 'Weekly report; publication dates vary',
    next: 7,
    basis: 'Weekly report',
  },
  ankara: {
    short: 'Ankara',
    route: '/ankara-visa-decisions',
    cadence: 'Weekly report, usually with a Sunday period end',
    next: 7,
    basis: 'Weekly report (OCR-extracted)',
  },
  dublin: {
    short: 'Dublin',
    route: '/dublin-visa-decisions',
    cadence: 'Every Tuesday',
    next: 'tuesday',
    basis: 'Decision snapshot',
  },
};

const CONTENT_PAGES = [
  {
    file: 'data.html',
    route: '/data',
    title: 'Open data: Irish visa decisions | Irish Visa Decision Tracker',
    description: 'Download the public JSON and CSV files behind the Irish Visa Decision Tracker, with coverage, definitions, update cadence, reuse terms and citation details.',
  },
  {
    file: 'data-study.html',
    route: '/data-study',
    title: 'What Irish visa decisions show: a data study | Irish Visa Decision Tracker',
    description: 'An original study of published Irish visa decisions across six offices: approval rates, publication volume, New Delhi file growth, closures and method.',
  },
  {
    file: 'when-are-visa-decisions-published.html',
    route: '/when-are-visa-decisions-published',
    title: 'When are Irish visa decisions published? | Irish Visa Decision Tracker',
    description: 'Expected publication windows for the six Irish visa offices, recent tracker observations, public-holiday closures and calendar subscriptions.',
  },
  {
    file: 'press.html',
    route: '/press',
    title: 'Press & citation kit | Irish Visa Decision Tracker',
    description: 'Key statistics, methodology, reusable charts, licence terms and a citation snippet for the Irish Visa Decision Tracker.',
  },
  {
    file: 'embed.html',
    route: '/embed',
    title: 'Embed the latest official file badge | Irish Visa Decision Tracker',
    description: 'A small, static SVG badge showing the latest official file date and decision count for each Irish visa office.',
  },
  {
    file: 'community-timelines.html',
    route: '/community-timelines',
    title: 'Community processing timelines: aggregate view | Irish Visa Decision Tracker',
    description: 'Privacy-safe aggregate of community-reported processing timelines, published only when a group has enough submissions to protect anonymity.',
  },
  {
    file: 'reports.html',
    route: '/reports',
    title: 'Official report archive | Irish Visa Decision Tracker',
    description: 'Every official report and snapshot check in the tracker archive, with decision counts, approval rates, checksums and links to the published source file.',
  },
];

const CSV_HEADER = '<!DOCTYPE html>';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadInsightData(assetsRoot = ROOT) {
  const dataDir = path.join(assetsRoot, 'data');
  const manifest = readJson(path.join(dataDir, 'data_manifest.json'), { offices: [] });
  const reports = readJson(path.join(dataDir, 'reports', 'index.json'), { offices: {} });
  const meta = readJson(path.join(dataDir, 'visa_meta.json'), {});
  const community = readJson(path.join(dataDir, 'community_timelines.json'), []);
  const officeFiles = {};
  for (const slug of OFFICE_ORDER) {
    officeFiles[slug] = readJson(path.join(dataDir, `embassy-${slug}.json`), null);
  }

  const offices = OFFICE_ORDER.map((slug) => {
    const record = (Array.isArray(manifest.offices) ? manifest.offices : []).find((office) => office.slug === slug) || {};
    const metaForOffice = OFFICE_META[slug];
    return {
      ...metaForOffice,
      ...record,
      slug,
      name: record.name || metaForOffice.short,
      route: metaForOffice.route,
      cadence: metaForOffice.cadence,
      next: metaForOffice.next,
      basis: metaForOffice.basis,
    };
  });
  const bySlug = new Map(offices.map((office) => [office.slug, office]));

  return {
    manifest,
    reports,
    meta,
    // One canonical per-office freshness record, written by the build before
    // the insight pages are rendered.
    freshness: loadFreshness(assetsRoot),
    community: Array.isArray(community) ? community : [],
    officeFiles,
    offices,
    bySlug,
  };
}

/** A compact six-office freshness line for pages whose scope is all offices,
 *  not just New Delhi. It uses the same publication and check ranges the
 *  citation kit shows rather than leading with one office. */
function canonicalFreshness(data) {
  const offices = (data.freshness && data.freshness.offices) || [];
  if (!offices.length) return '';
  const reports = offices
    .map((office) => String(office.report_date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const checks = offices
    .map((office) => String(office.last_success_at || office.checked_at || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  if (!reports.length) return '';
  const firstReport = longDate(reports[0]);
  const lastReport = longDate(reports[reports.length - 1]);
  const publication = firstReport === lastReport
    ? `latest publications dated ${firstReport}`
    : `latest publications dated ${firstReport} to ${lastReport}`;
  const firstCheck = longDate(checks[0]);
  const lastCheck = longDate(checks[checks.length - 1]);
  const checkCopy = !checks.length
    ? ''
    : firstCheck === lastCheck
      ? `offices last successfully checked ${firstCheck}`
      : `offices last successfully checked ${firstCheck} to ${lastCheck}`;
  const newDelhi = data.freshness.bySlug && data.freshness.bySlug['new-delhi'];
  const through = newDelhi && longDate(newDelhi.official_data_through);
  const observed = newDelhi && longDate(newDelhi.observed_data_through);
  const observation = observed && newDelhi.observed_data_through > newDelhi.official_data_through
    ? ` · tracker observed through ${observed} (not in the official file)`
    : '';
  const attention = offices.filter((office) => office.attention).map((office) => office.name);
  const attentionCopy = attention.length
    ? ` · ${attention.length} office${attention.length === 1 ? '' : 's'} ${attention.length === 1 ? 'needs' : 'need'} attention: ${attention.join(', ')}`
    : '';
  return `six offices — ${publication}` + (checkCopy ? ` · ${checkCopy}` : '') +
    (through ? ` · New Delhi official decisions through ${through}` : '') + observation + attentionCopy;
}

/** Citation date copy. The newest office publication is not a shared
 *  decisions-through date, and the offices are not all checked on the same
 *  day, so cite the publication range and the range of last successful
 *  office checks instead of a single "data checked" date. */
export function publicationDateCopy(data) {
  const dates = data.offices
    .map((office) => String(office.report_date || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const checks = ((data.freshness && data.freshness.offices) || [])
    .map((office) => String(office.checked_at || '').slice(0, 10))
    .filter(Boolean)
    .sort();
  const firstCheck = checks[0] || '';
  const lastCheck = checks[checks.length - 1] ||
    String((data.freshness && data.freshness.as_of) || last || '').slice(0, 10);
  if (!last) return lastCheck ? `data checked ${longDate(lastCheck)}` : 'data date not recorded';
  const publications = first && first !== last
    ? `latest office publications dated ${longDate(first)} to ${longDate(last)}`
    : `latest office publication dated ${longDate(last)}`;
  if (!lastCheck) return publications;
  if (firstCheck && firstCheck !== lastCheck) {
    return `${publications}; offices last successfully checked ${longDate(firstCheck)} to ${longDate(lastCheck)}`;
  }
  return `${publications}; data checked ${longDate(lastCheck)}`;
}

export function officeEntries(data, slug) {
  const entries = data.reports && data.reports.offices && data.reports.offices[slug];
  return Array.isArray(entries) ? entries : [];
}

/**
 * Reports newest first, with repeated checks of an unchanged snapshot
 * collapsed. Dublin re-checks the same list daily, so its ten checks resolve
 * to two distinct published lists rather than ten identical pages.
 */
export function distinctReports(entries) {
  const sorted = entries
    .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || '')))
    .slice()
    .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
  const out = [];
  let previous = '';
  for (const entry of sorted) {
    const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
    if (key === previous) continue;
    previous = key;
    out.push(entry);
  }
  return out;
}

/** Newest-first reports paired with the prior distinct report. */
export function reportHistory(entries) {
  const newest = distinctReports(entries);
  const oldest = [...newest].reverse();
  const prior = new Map();
  oldest.forEach((entry, index) => prior.set(entry, oldest[index - 1] || null));
  return newest.map((entry) => ({ entry, prior: prior.get(entry) || null }));
}

export function latestStats(data) {
  const offices = data.offices.filter((office) => Number(office.decisions) > 0);
  const decisions = offices.reduce((sum, office) => sum + (Number(office.decisions) || 0), 0);
  const approved = offices.reduce((sum, office) => sum + (Number(office.approved) || 0), 0);
  const refused = offices.reduce((sum, office) => sum + (Number(office.refused) || 0), 0);
  const archive = offices.reduce((sum, office) => sum + (Number(office.archive_decisions) || Number(office.decisions) || 0), 0);
  const dates = offices.map((office) => String(office.report_date || '').slice(0, 10)).filter(Boolean).sort();
  return {
    offices,
    decisions,
    approved,
    refused,
    archive,
    rate: decisions ? (approved / decisions) * 100 : 0,
    latestDate: dates[dates.length - 1] || '',
    earliestDate: dates[0] || '',
  };
}

/** Monthly publication volume from dated report rows plus New Delhi file growth. */
export function monthlyVolume(data) {
  const months = new Map();
  const bump = (month, slug, count) => {
    if (!/^\d{4}-\d{2}$/.test(month) || !count) return;
    if (!months.has(month)) months.set(month, { month, byOffice: {}, total: 0 });
    const bucket = months.get(month);
    bucket.byOffice[slug] = (bucket.byOffice[slug] || 0) + count;
    bucket.total += count;
  };

  for (const slug of ['abu-dhabi', 'abuja', 'ankara']) {
    const file = data.officeFiles[slug];
    for (const row of (file && Array.isArray(file.decisions) ? file.decisions : [])) {
      bump(String(row && row.date || '').slice(0, 7), slug, 1);
    }
  }

  // New Delhi publishes a cumulative file, so the honest dated measure is how
  // much the file grew between two archived file dates, not the scrape rows.
  const oldest = distinctReports(officeEntries(data, 'new-delhi')).reverse();
  let previous = null;
  for (const entry of oldest) {
    if (previous) {
      const delta = Number(entry.decisions) - Number(previous.decisions);
      if (delta > 0) bump(String(entry.report_date).slice(0, 7), 'new-delhi', delta);
    }
    previous = entry;
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((bucket) => ({
      ...bucket,
      label: `${MONTHS[Number(bucket.month.slice(5, 7)) - 1]} ${bucket.month.slice(0, 4)}`,
    }));
}

export function newDelhiFileGrowth(data) {
  const oldest = distinctReports(officeEntries(data, 'new-delhi')).reverse();
  return oldest.map((entry, index) => {
    const prior = oldest[index - 1] || null;
    const decisions = Number(entry.decisions) || 0;
    return {
      report_date: String(entry.report_date).slice(0, 10),
      decisions,
      approved: Number(entry.approved) || 0,
      refused: Number(entry.refused) || 0,
      rate: decisions ? ((Number(entry.approved) || 0) / decisions) * 100 : 0,
      added: prior ? decisions - (Number(prior.decisions) || 0) : null,
      prior_date: prior ? String(prior.report_date).slice(0, 10) : '',
      source_file: entry.source_file || '',
      checksum: entry.checksum || '',
    };
  });
}

export function reportArchiveStats(data) {
  const histories = OFFICE_ORDER.flatMap((slug) => reportHistory(officeEntries(data, slug))
    .map(({ entry }) => ({ slug, entry })));
  const dates = histories.map(({ entry }) => String(entry.report_date).slice(0, 10)).sort();
  const dated = histories.filter(({ slug }) => !SNAPSHOT_OFFICES.has(slug));
  const datedDates = dated.map(({ entry }) => String(entry.report_date).slice(0, 10)).sort();
  const snapshots = histories.filter(({ slug }) => SNAPSHOT_OFFICES.has(slug));
  const snapshotDates = snapshots.map(({ entry }) => String(entry.report_date).slice(0, 10)).sort();
  return {
    rows: histories,
    count: histories.length,
    earliest: dates[0] || '',
    latest: dates[dates.length - 1] || '',
    datedCount: dated.length,
    datedEarliest: datedDates[0] || '',
    datedLatest: datedDates[datedDates.length - 1] || '',
    snapshotCount: snapshots.length,
    snapshotLatest: snapshotDates[snapshotDates.length - 1] || '',
  };
}

export function communityAggregates(rows) {
  const clean = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || !row.applied || !row.decided) return false;
    const applied = new Date(`${String(row.applied).slice(0, 10)}T00:00:00Z`);
    const decided = new Date(`${String(row.decided).slice(0, 10)}T00:00:00Z`);
    return !Number.isNaN(applied.getTime()) && !Number.isNaN(decided.getTime()) && decided >= applied;
  });
  const groups = new Map();
  for (const row of clean) {
    const tracker = row.tracker === '1g' ? 'Stamp 1G' : 'Embassy visa';
    const outcome = String(row.outcome || 'unknown').toLowerCase();
    const key = `${tracker}|${outcome}`;
    if (!groups.has(key)) groups.set(key, { tracker, outcome, days: [] });
    const applied = new Date(`${String(row.applied).slice(0, 10)}T00:00:00Z`);
    const decided = new Date(`${String(row.decided).slice(0, 10)}T00:00:00Z`);
    groups.get(key).days.push(Math.round((decided - applied) / 86400000));
  }
  return [...groups.values()].map((group) => {
    const sorted = group.days.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return {
      tracker: group.tracker,
      outcome: group.outcome,
      count: sorted.length,
      enough: sorted.length >= MIN_COMMUNITY_SAMPLE,
      median: sorted.length
        ? (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2))
        : null,
    };
  }).sort((a, b) => a.tracker.localeCompare(b.tracker) || a.outcome.localeCompare(b.outcome));
}

const pct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '0.0%');
const num = (value) => (Number(value) || 0).toLocaleString('en-IE');

function longDate(iso) {
  const [year, month, day] = String(iso || '').slice(0, 10).split('-');
  const name = MONTHS[Number(month) - 1];
  return year && name && day ? `${Number(day)} ${name} ${year}` : '';
}

function shortDate(iso) {
  const [year, month, day] = String(iso || '').slice(0, 10).split('-');
  const name = MONTHS[Number(month) - 1];
  return year && name && day ? `${Number(day)} ${name.slice(0, 3)} ${year}` : '';
}

function weekdayDate(iso) {
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  return `${WEEKDAYS[date.getUTCDay()]} ${longDate(iso)}`;
}

function addDays(iso, days) {
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);

function csvCell(value) {
  const raw = String(value == null ? '' : value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function csv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function shell({ route, title, description, body, jsonLd, markdown }) {
  const page = PAGES.find((candidate) => candidate.route === route)
    || { route, current: route.startsWith('/reports') ? '/reports' : null, skip: 'content' };
  const ld = jsonLd
    ? `  <script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n  </script>\n`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${route}">
${markdown ? `  <link rel="alternate" type="text/markdown" href="${markdown}">\n` : ''}  <link rel="manifest" href="/manifest.json">
  <link rel="describedby" href="/llms.txt" type="text/plain">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${SITE}${route}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/pages.css">
  <link rel="stylesheet" href="/site-chrome.css">
${ld}</head>
<body>
  <!-- site-chrome:start -->
  <!-- site-chrome:end -->
  <main id="main-content" tabindex="-1" class="page">
${body}
  </main>
  <!-- site-footer:start -->
  <!-- site-footer:end -->
  <script src="/scripts/time-mode.js" defer></script>
  <script src="/site-chrome.js" defer></script>
</body>
</html>
`;
  return spliceChrome(html, page);
}

function svgBarChart({ id, title, rows, barFill = '#059669', valueWidth = 70 }) {
  const rowHeight = 32;
  const top = 34;
  const height = top + rows.length * rowHeight + 8;
  const barX = 160;
  const barWidth = 430;
  const max = Math.max(1, ...rows.map((row) => Number(row.value) || 0));
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const width = Math.max(0, Math.round((Math.max(0, Number(row.value) || 0) / max) * barWidth));
    return `<g>
      <text x="0" y="${y + 11}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="13" fill="#4b5563">${esc(row.label)}</text>
      <rect x="${barX}" y="${y}" width="${barWidth}" height="14" rx="7" fill="#f1f5f9"/>
      <rect x="${barX}" y="${y}" width="${width}" height="14" rx="7" fill="${barFill}"/>
      <text x="${barX + barWidth + 14}" y="${y + 11}" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="13" font-weight="600" fill="#111827">${esc(row.display)}</text>
    </g>`;
  }).join('\n');
  return `<svg class="study-chart" viewBox="0 0 ${barX + barWidth + valueWidth} ${height}" role="img" aria-labelledby="${id}-title">
  <title id="${id}-title">${esc(title)}</title>
${bars}
</svg>`;
}

// The page uses a semantic meter list rather than the SVG: the labels stay
// readable at 320px without shipping a second chart, and the SVG files remain
// the downloadable assets. Bar lengths are relative to the largest value, as
// in the SVG.
function barList({ title, rows, neutral = false }) {
  const max = Math.max(1, ...rows.map((row) => Number(row.value) || 0));
  const items = rows.map((row) => `        <li class="study-bar"><span class="study-bar-label">${esc(row.label)}</span><meter min="0" max="${max}" value="${Math.max(0, Number(row.value) || 0)}" aria-hidden="true"></meter><span class="study-bar-value">${esc(row.display)}</span></li>`).join('\n');
  return `<ul class="study-bars${neutral ? ' study-bars--neutral' : ''}" aria-label="${esc(title)}">
${items}
      </ul>`;
}

function approvalRows(data) {
  return data.offices
    .filter((office) => Number(office.decisions) > 0)
    .map((office) => {
      const decisions = Number(office.decisions) || 0;
      const approved = Number(office.approved) || 0;
      return { label: office.name, value: decisions ? +((approved / decisions) * 100).toFixed(1) : 0, display: pct(approved, decisions) };
    });
}

function approvalChart(data) {
  return svgBarChart({ id: 'approval-chart', title: 'Approval rate by office in the latest published file', rows: approvalRows(data) });
}

function approvalBars(data) {
  return barList({ title: 'Approval rate by office in the latest published file', rows: approvalRows(data) });
}

function volumeRows(monthly) {
  return monthly.map((bucket) => ({ label: bucket.label, value: bucket.total, display: num(bucket.total) }));
}

function volumeChart(monthly) {
  return svgBarChart({ id: 'volume-chart', title: 'Dated decisions published by month', rows: volumeRows(monthly), barFill: '#6b7280', valueWidth: 62 });
}

function volumeBars(monthly) {
  return barList({ title: 'Dated decisions published by month', rows: volumeRows(monthly), neutral: true });
}

function firstMonthLabel(monthly, slug) {
  const bucket = monthly.find((item) => item.byOffice[slug]);
  return bucket ? bucket.label : '';
}

function studyPage(data) {
  const stats = latestStats(data);
  const monthly = monthlyVolume(data);
  const growth = newDelhiFileGrowth(data);
  const archive = reportArchiveStats(data);
  const datedTotal = monthly.reduce((sum, bucket) => sum + bucket.total, 0);
  const growthTotal = growth.reduce((sum, row) => sum + Math.max(0, row.added || 0), 0);
  const asOf = stats.latestDate || String(data.meta.fileDate || '').slice(0, 10);
  const closing = Array.isArray(data.meta.closureDates) ? data.meta.closureDates.slice() : [];

  const rateRows = data.offices
    .filter((office) => Number(office.decisions) > 0)
    .map((office) => {
      const decisions = Number(office.decisions) || 0;
      const approved = Number(office.approved) || 0;
      const refused = Number(office.refused) || 0;
      return `<tr>
          <th scope="row"><a href="${office.route}">${esc(office.name)}</a></th>
          <td>${esc(office.basis)}</td>
          <td>${num(decisions)}</td>
          <td>${num(approved)}</td>
          <td>${num(refused)}</td>
          <td>${pct(approved, decisions)}</td>
        </tr>`;
    }).join('\n        ');

  const monthRows = monthly.map((bucket) => `<tr>
          <th scope="row">${esc(bucket.label)}</th>
          <td>${num(bucket.byOffice['abu-dhabi'] || 0)}</td>
          <td>${num(bucket.byOffice.abuja || 0)}</td>
          <td>${num(bucket.byOffice.ankara || 0)}</td>
          <td>${num(bucket.byOffice['new-delhi'] || 0)}</td>
          <td><strong>${num(bucket.total)}</strong></td>
        </tr>`).join('\n        ');

  const growthRows = growth.map((row) => `<tr>
          <th scope="row"><a href="/reports/new-delhi/${esc(row.report_date)}">${esc(longDate(row.report_date))}</a></th>
          <td>${num(row.decisions)}</td>
          <td>${row.added == null ? '—' : `+${num(row.added)}`}</td>
          <td>${pct(row.approved, row.decisions)}</td>
        </tr>`).join('\n        ');

  const sourceRows = data.offices.map((office) => {
    const count = reportHistory(officeEntries(data, office.slug)).length;
    return `<tr>
          <th scope="row">${esc(office.name)}</th>
          <td>${esc(office.basis)}</td>
          <td>${count ? num(count) : '—'}</td>
          <td><a href="${esc(office.source_url || office.route)}" target="_blank" rel="noopener noreferrer">Official page</a></td>
        </tr>`;
  }).join('\n        ');

  const body = `    <p class="page-kicker">Data study</p>
    <h1>What the published Irish visa decisions show</h1>
    <p class="page-meta">2026 edition &bull; ${num(stats.decisions)} decisions in the latest official files &bull; Independent and unofficial</p>
    <p class="page-freshness small-note"><strong>Data freshness:</strong> ${esc(canonicalFreshness(data))}. <a href="/status">All six offices</a>.</p>

    <p class="page-lede">Six Irish visa offices publish decision files, each in a different shape: New Delhi a cumulative daily spreadsheet, three embassies weekly PDF reports, Dublin a Tuesday snapshot and Beijing an irregular cumulative file. This study measures what those files actually contain — published decisions, not the probability that any one application will be approved.</p>

    <p class="small-note">This study uses the same six-office files as the tracker. For the live New Delhi count and checked time, see <a href="/status">Data status</a>; to query the underlying rows, use <a href="/?tracker=visa&amp;tab=history">History</a>.</p>

    <section>
      <h2>Approval rates by office</h2>
      <p>The approval share is the number of <strong>approved</strong> rows divided by all decided rows in the latest file the office published. It describes the file, not the applicant. The offices publish different things: New Delhi's file is cumulative, so its rate covers every decision in the file, while Abu Dhabi's latest PDF covers one reporting period.</p>
      ${approvalBars(data)}
      <div class="table-wrap" role="region" aria-label="Approval rate by office" tabindex="0">
        <table class="office-table">
          <caption>Latest official file by office</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Report basis</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th><th scope="col">Approval rate</th></tr></thead>
          <tbody>
        ${rateRows}
          </tbody>
        </table>
      </div>
      <p class="small-note">A high or low rate is a property of the published rows. It is not an approval probability and does not control for visa category, nationality or application date, because those fields are not in the public files.</p>
    </section>

    <section>
      <h2>How much each office publishes</h2>
      <p>Only three offices publish decisions with a genuine decision or reporting-period date: Abu Dhabi, Abuja and Ankara. The chart adds New Delhi's measured file growth between archived official-file dates. Dublin and Beijing publish snapshots, so counting their rows by month would double-count the same decisions and is excluded here.</p>
      ${monthly.length ? volumeBars(monthly) : '<p class="callout">No dated report volume is available yet.</p>'}
      ${monthly.length ? `<div class="table-wrap" role="region" aria-label="Dated decisions by month" tabindex="0">
        <table class="office-table">
          <caption>Dated decisions by month and office</caption>
          <thead><tr><th scope="col">Month</th><th scope="col">Abu Dhabi</th><th scope="col">Abuja</th><th scope="col">Ankara</th><th scope="col">New Delhi file growth</th><th scope="col">Total</th></tr></thead>
          <tbody>
        ${monthRows}
          </tbody>
        </table>
      </div>` : ''}
      <p class="small-note">Dated reports currently cover ${num(datedTotal)} decisions. New Delhi's figure is the increase in the cumulative file between two archived file dates, so a gap between file dates combines several days. Abu Dhabi's dated archive begins in ${esc(firstMonthLabel(monthly, 'abu-dhabi') || 'September 2026')}, Ankara's in ${esc(firstMonthLabel(monthly, 'ankara') || 'October 2026')} and Abuja's in ${esc(firstMonthLabel(monthly, 'abuja') || 'January 2026')}, so the monthly series is not a complete year.</p>
    </section>

    <section>
      <h2>What ${num(growth.length ? growth[growth.length - 1].decisions : 0)} New Delhi decisions show</h2>
      <p>New Delhi's file is cumulative: every morning's spreadsheet contains every 2026 decision to date. The archive holds ${growth.length} file dates, which makes the file's growth measurable even though the tracker's searchable rows are stamped with the date the tracker saw them.</p>
      <div class="table-wrap" role="region" aria-label="New Delhi official file growth" tabindex="0">
        <table class="office-table">
          <caption>New Delhi cumulative file, archived dates</caption>
          <thead><tr><th scope="col">Official file date</th><th scope="col">Cumulative decisions</th><th scope="col">Added since prior file</th><th scope="col">Approval rate</th></tr></thead>
          <tbody>
        ${growthRows || '<tr><td colspan="4">No archived New Delhi file dates yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <p class="small-note">Across the archived file dates the cumulative total grew by ${num(growthTotal)} decisions. The first archived file is the initial import, so it is shown as a level rather than a one-day increase.</p>
    </section>

    <section>
      <h2>Closures and seasonal reading</h2>
      <p>The tracker records ${closing.length} Irish public-holiday closure dates for 2026. Embassies also observe local holidays, so a missing file on a working day in Ireland can still be a closure abroad. Treat the monthly series as publication volume, not demand: a short month can mean a holiday, a missing report or a publication gap.</p>
      <ul class="study-list">
        ${closing.map((date) => `<li>${esc(weekdayDate(date))}</li>`).join('\n        ')}
      </ul>
      <p class="small-note">There is not enough complete-year history to claim a stable seasonal pattern. The honest finding is coverage: publication is continuous for the dated offices where reports exist, with visible gaps where a report was not available.</p>
    </section>

    <section>
      <h2>Method and limits</h2>
      <ul class="study-list">
        <li><strong>Latest-file counts</strong> come from each office's most recent published file, as recorded in <a href="/data/data_manifest.json">data_manifest.json</a>.</li>
        <li><strong>Dated counts</strong> come from the dated rows in the office JSON files, plus New Delhi file growth between archived file dates in <a href="/data/reports/index.json">the report archive</a>.</li>
        <li><strong>Approval rate</strong> is approved rows divided by approved plus refused rows. The files do not include visa category, nationality or refusal reason.</li>
        <li><strong>No personal data</strong> is used. Application numbers are searchable on the tracker but are not included in this study's aggregates.</li>
        <li><strong>Not predictive.</strong> Nothing here estimates an individual application's chance of approval or its processing time.</li>
      </ul>
      <div class="table-wrap" role="region" aria-label="Study sources by office" tabindex="0">
        <table class="office-table">
          <caption>Sources and archive coverage</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Report basis</th><th scope="col">Archived report dates</th><th scope="col">Source</th></tr></thead>
          <tbody>
        ${sourceRows}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Download and cite</h2>
      <p>The study is rebuilt from the public data files whenever the site is built, so the figures follow the latest official files. The current 2026 edition is refreshed continuously; the dated snapshot under <code>/data/snapshots/</code> is the citable version for a quarter or year. Download the tables, or cite the study with its data date.</p>
      <p class="study-downloads">
        <a class="btn" href="/data/study/office-summary.csv">Office summary CSV</a>
        <a class="btn" href="/data/study/monthly-volume.csv">Monthly volume CSV</a>
        <a class="btn" href="/data/study/new-delhi-file-growth.csv">New Delhi growth CSV</a>
        <a class="btn" href="/data/study/approval-rates.svg">Approval chart SVG</a>
        <a class="btn" href="/data/study/monthly-volume.svg">Volume chart SVG</a>
      </p>
      <p class="small-note">Citation: Parth Soni. (2026). <em>Irish Visa Decision Tracker: published visa decisions by office</em> (${esc(publicationDateCopy(data))}) [Data set]. ${SITE}/data-study &middot; See the <a href="/press">press and citation kit</a> for licence terms and a versioned snapshot.</p>
      <p class="page-nav"><a href="/reports">Official report archive</a> &middot; <a href="/when-are-visa-decisions-published">Publication schedule</a> &middot; <a href="/press">Press &amp; citation</a> &middot; <a href="/status">Data status</a></p>
    </section>`;

  return shell({
    route: '/data-study',
    title: CONTENT_PAGES.find((page) => page.route === '/data-study').title,
    description: CONTENT_PAGES.find((page) => page.route === '/data-study').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: `${SITE}/data-study`,
      name: 'What the published Irish visa decisions show',
      description: 'An original data study of published Irish visa decisions by office.',
      inLanguage: 'en',
      dateModified: asOf,
      isPartOf: { '@id': `${SITE}/#website` },
      about: { '@type': 'Dataset', name: 'Irish visa decision files', url: `${SITE}/data/data_manifest.json` },
    },
  });
}

function schedulePage(data) {
  const stats = latestStats(data);
  const asOf = stats.latestDate;
  const closing = (Array.isArray(data.meta.closureDates) ? data.meta.closureDates : []).slice().sort();
  const upcoming = closing.filter((date) => date >= asOf).slice(0, 8);

  const rows = data.offices.map((office) => {
    const latest = String(office.report_date || '').slice(0, 10);
    const fresh = data.freshness && data.freshness.bySlug && data.freshness.bySlug[office.slug];
    const expected = (fresh && fresh.due_at) || expectedDate(latest, office.slug);
    const nextWindow = (fresh && fresh.next_due_at) || expectedAfter(latest, office.slug, asOf);
    const overdue = Boolean(fresh && fresh.overdue);
    const ageLabel = fresh && (fresh.age_label_at_build || fresh.age_label);
    const age = ageLabel
      ? `<br><span class="small-note" data-freshness-age>${esc(ageLabel)}</span>`
      : '';
    const pastWindow = Boolean(expected && asOf && expected < asOf);
    const window = expected
      ? overdue
        ? `<strong>Due since ${esc(weekdayDate(expected))} — not yet published</strong>` +
          `<br><span class="small-note">Next expected ${esc(weekdayDate(nextWindow))}</span>`
        : `<strong>${esc(weekdayDate(pastWindow ? nextWindow : expected))}</strong>` +
          '<br><span class="small-note">Expected, not guaranteed</span>'
      : 'No fixed date';
    const statusClass = fresh && fresh.status_tone ? ` is-${fresh.status_tone}` : '';
    const checkHealth = fresh
      ? `<span class="status-pill${statusClass}">${esc(fresh.status_label || 'Published')}</span>` +
        `<br><span class="small-note">Last successful ${timeHTML(fresh.last_success_at)}</span>` +
        `<br><span class="small-note">Last attempt ${timeHTML(fresh.last_attempt_at)}</span>` +
        ` <a class="small-note" href="/status#office-coverage">Office coverage</a>`
      : '<span class="small-note">Not recorded</span>';
    return `<tr data-freshness-slug="${esc(office.slug)}" data-freshness-view="schedule">
          <th scope="row"><a href="${office.route}">${esc(office.name)}</a></th>
          <td data-label="Usual pattern">${esc(office.cadence)}</td>
          <td data-label="Latest report">${latest ? `<time datetime="${latest}">${esc(longDate(latest))}</time>${age}` : '—'}</td>
          <td data-label="Expected next file" data-freshness-expected>${window}</td>
          <td data-label="Check health" data-freshness-check>${checkHealth}</td>
        </tr>`;
  }).join('\n        ');

  const observations = data.offices.flatMap((office) => officeEntries(data, office.slug).slice(0, 2).map((entry) => {
    const observed = String(entry.fetched_at || '');
    const when = /^\d{4}-\d{2}-\d{2}T/.test(observed)
      ? timeHTML(observed)
      : '—';
    return `<tr>
          <th scope="row">${esc(office.name)}</th>
          <td data-label="Report date"><time datetime="${String(entry.report_date).slice(0, 10)}">${esc(longDate(entry.report_date))}</time></td>
          <td data-label="Tracker observed">${when}</td>
          <td data-label="Source"><a href="${esc(entry.source_file || office.source_url || office.route)}" target="_blank" rel="noopener noreferrer">Official source</a></td>
        </tr>`;
  })).join('\n        ');

  const body = `    <p class="page-kicker">Publication schedule</p>
    <h1>When are Irish visa decisions published?</h1>
    <p class="page-meta">Expected windows as of ${esc(longDate(asOf))} &bull; Not guaranteed &bull; Independent and unofficial</p>

    <p class="page-lede">Each Irish visa office publishes on its own rhythm. New Delhi updates a cumulative file on weekday mornings, three embassies publish weekly PDF reports, Dublin publishes every Tuesday and Beijing publishes irregular snapshots. This page turns the latest report dates into expected windows so you know when to look again.</p>

    <p class="callout"><strong>Expectations, not promises.</strong> A public holiday, a local closure, a broken file link or a late upload can move any date. The office's own page is always the authority. Where a window has passed without a new file, the table says “due since” and also shows the next expected window; missed windows are not rolled forward.</p>

    <section>
      <h2>Expected next publication by office</h2>
      <div class="table-wrap" role="region" aria-label="Expected publication windows" tabindex="0">
        <table class="office-table stack-table">
          <caption>Usual pattern and the next expected file</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Usual pattern</th><th scope="col">Latest report</th><th scope="col">Expected next file</th><th scope="col">Check health</th></tr></thead>
          <tbody>
        ${rows}
          </tbody>
        </table>
      </div>
      <p class="small-note">Dates are calculated from the latest report date and the office's usual cadence, then rolled forward past the latest data date. New Delhi's next weekday is skipped at weekends; Dublin's next Tuesday is calculated from its last publication.</p>
    </section>

    <section>
      <h2>Recent tracker observations</h2>
      <p>The tracker records when it last saw each report, not the exact moment the office uploaded it. Use these timestamps as an observation window, not as an official publication time.</p>
      <div class="table-wrap" role="region" aria-label="Recent tracker observations" tabindex="0">
        <table class="office-table stack-table">
          <caption>Most recent archived reports per office</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Report date</th><th scope="col">Tracker observed</th><th scope="col">Source</th></tr></thead>
          <tbody>
        ${observations || '<tr><td colspan="4">No archived reports yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Closures that can delay a file</h2>
      <p>The tracker carries ${closing.length} Irish public-holiday dates for 2026. Embassies also close for local holidays, so this list is a starting point rather than the full calendar for each office.</p>
      ${upcoming.length ? `<ul class="study-list">${upcoming.map((date) => `<li>${esc(weekdayDate(date))}</li>`).join('')}</ul>` : '<p class="small-note">No further 2026 closure dates are recorded in the current data.</p>'}
      <p class="small-note">A missing file on a working day in Ireland can still be a public holiday in the office's own country.</p>
    </section>

    <section>
      <h2>Subscribe to expected and published dates</h2>
      <p>The calendar feed marks expected windows as <code>TENTATIVE</code> and published reports as <code>CONFIRMED</code>, with a link to the official source. It covers all six offices.</p>
      <p class="study-downloads">
        <a class="btn" href="/api/calendar/offices.ics">Open the all-office calendar</a>
        <a class="btn" href="webcal://irishvisaupdatetracker.pages.dev/api/calendar/offices.ics">Subscribe in a calendar app</a>
        <a class="btn" href="/status">Data status</a>
      </p>
      <p class="small-note">Calendar clients refresh the subscription themselves. The feed is generated from <a href="/data/reports/index.json">the public report archive</a>.</p>
    </section>

    <section>
      <h2>Why a report can still be missing</h2>
      <ul class="study-list">
        <li><strong>The office has not published yet.</strong> The expected window is a cadence estimate, not a deadline.</li>
        <li><strong>A closure intervened.</strong> Public holidays and local embassy closures interrupt the usual pattern.</li>
        <li><strong>The file link changed.</strong> The tracker reports a gap rather than inventing rows when a link cannot be found.</li>
        <li><strong>The report is a snapshot.</strong> Beijing and Dublin can re-check an unchanged list, so a new observation is not always a new decision.</li>
      </ul>
      <p class="page-nav"><a href="/data-study">Data study</a> &middot; <a href="/reports">Report archive</a> &middot; <a href="/status">Data status</a> &middot; <a href="/help">Help</a></p>
    </section>`;

  return shell({
    route: '/when-are-visa-decisions-published',
    title: CONTENT_PAGES.find((page) => page.route === '/when-are-visa-decisions-published').title,
    description: CONTENT_PAGES.find((page) => page.route === '/when-are-visa-decisions-published').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: `${SITE}/when-are-visa-decisions-published`,
      name: 'When are Irish visa decisions published?',
      description: 'Expected publication windows for the six Irish visa offices, with recent observations and closures.',
      inLanguage: 'en',
      dateModified: asOf,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function dataPage(data) {
  const stats = latestStats(data);
  const archive = reportArchiveStats(data);
  const asOf = stats.latestDate || archive.latest;
  const earliest = archive.earliest || '2026-01-04';
  const files = [
    ['/data/visa_decisions.json', 'New Delhi decision rows', 'JSON array of [date, application number, "Approved" | "Refused"]. The tracker’s dated New Delhi record; observation-dated, not official decision dates.', 'Daily when the embassy publishes'],
    ['/data/embassy-new-delhi.json', 'New Delhi office file', 'Latest official New Delhi snapshot with report metadata and decisions.', 'Each successful scrape'],
    ['/data/embassy-beijing.json', 'Beijing office file', 'Latest Beijing snapshot with report metadata and decisions.', 'When a newer file is found'],
    ['/data/embassy-abu-dhabi.json', 'Abu Dhabi office file', 'Latest Abu Dhabi weekly report with report-period dates.', 'Weekly'],
    ['/data/embassy-abuja.json', 'Abuja office file', 'Latest Abuja weekly report with report-period dates.', 'Weekly'],
    ['/data/embassy-ankara.json', 'Ankara office file', 'Latest Ankara weekly report; some rows are OCR-extracted.', 'Weekly'],
    ['/data/embassy-dublin.json', 'Dublin office file', 'Latest Dublin decision snapshot.', 'Tuesday publication'],
    ['/data/data_manifest.json', 'Coverage manifest', 'One record per office: status, report date, counts, archive dates and source links.', 'Each data refresh'],
    ['/data/reports/index.json', 'Official report archive', 'Dated official reports with counts, approval shares, checksums and source files.', 'Each data refresh'],
    ['/data/study/office-summary.csv', 'Office summary CSV', 'Latest-file totals by office for the data study.', 'Each deploy'],
    ['/data/study/monthly-volume.csv', 'Monthly volume CSV', 'Dated publication volume by office and month.', 'Each deploy'],
    ['/official-file-feed.json', 'Official file feed', 'JSON Feed of newly published official files. No applicant rows.', 'Each data refresh'],
  ];
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    '@id': `${SITE}/data#dataset`,
    name: 'Irish visa decisions published by six Irish visa offices',
    description: 'Decision counts and dated official reports published by the Irish visa offices in New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin, compiled by an independent tracker.',
    url: `${SITE}/data`,
    identifier: `${SITE}/data#dataset`,
    creator: { '@type': 'Person', name: 'Parth Soni', url: `${SITE}/about` },
    license: `${SITE}/terms`,
    isAccessibleForFree: true,
    dateModified: asOf,
    temporalCoverage: `${earliest}/${asOf}`,
    spatialCoverage: 'New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin visa offices',
    keywords: ['Irish visa decisions', 'Ireland visa', 'visa statistics', 'immigration data'],
    distribution: files.filter(([url]) => url.endsWith('.json')).map(([url, name, description]) => ({
      '@type': 'DataDownload',
      name,
      description,
      contentUrl: `${SITE}${url}`,
      encodingFormat: 'application/json',
    })),
  };
  const rows = files.map(([url, name, description, cadence]) => `<tr><th scope="row"><a href="${url}"><code>${url}</code></a><br><span class="small-note">${esc(name)}</span></th><td>${esc(description)}</td><td>${esc(cadence)}</td></tr>`).join('\n          ');
  const newDelhi = data.freshness && data.freshness.bySlug && data.freshness.bySlug['new-delhi'];
  const newDelhiReport = newDelhi && newDelhi.report_date ? longDate(newDelhi.report_date) : '';
  const newDelhiThrough = newDelhi && newDelhi.official_data_through ? longDate(newDelhi.official_data_through) : '';
  const newDelhiObserved = newDelhi && newDelhi.observed_data_through ? longDate(newDelhi.observed_data_through) : '';
  const cutoffNote = newDelhiReport
    ? ` For example, New Delhi's latest file is dated ${esc(newDelhiReport)}` +
      (newDelhiThrough ? ` and its official decisions are dated through ${esc(newDelhiThrough)}` : '') +
      (newDelhiObserved && newDelhi.observed_data_through > newDelhi.official_data_through
        ? `; the tracker has observed decisions dated through ${esc(newDelhiObserved)} in a partial day not in that file`
        : '') + '.'
    : '';
  const body = `
    <p class="page-kicker">Open data</p>
    <h1>Irish visa decision data</h1>
    <p class="page-meta">Independent and unofficial &bull; Six offices</p>
    <p class="page-freshness small-note"><strong>Data freshness:</strong> ${esc(canonicalFreshness(data))}. <a href="/status">All six offices</a>.</p>
    <p class="page-lede">The tracker publishes the public files it uses: dated decision rows, the latest official snapshot for each office, the report archive and a coverage manifest. The files are plain JSON or CSV, need no key and are free to read.</p>

    <div class="status-grid">
      <div class="status-card"><span class="status-kicker">Offices</span><strong>${num(data.offices.length)}</strong><span>New Delhi, Beijing, Abu Dhabi, Abuja, Ankara, Dublin</span></div>
      <div class="status-card"><span class="status-kicker">Latest-file decisions</span><strong>${num(stats.decisions)}</strong><span>Across the latest official files</span></div>
      <div class="status-card"><span class="status-kicker">Dated reports</span><strong>${num(archive.count)}</strong><span>Source-linked official reports</span></div>
      <div class="status-card"><span class="status-kicker">Newest office file</span><strong>${esc(shortDate(asOf))}</strong><span>Office dates differ; see the manifest</span></div>
    </div>

    <section>
      <h2>Files and endpoints</h2>
      <div class="table-wrap" role="region" aria-label="Open data files" tabindex="0">
        <table class="office-table">
          <caption>Public data files, what they contain and how often they change</caption>
          <thead><tr><th scope="col">File</th><th scope="col">Contents</th><th scope="col">Update cadence</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="small-note">Every file is served with <code>Cache-Control: no-store</code>. Read <a href="/status">Data status</a> for the latest successful check, and <a href="/data/data_manifest.json">the manifest</a> for machine-readable coverage.</p>
    </section>

    <section>
      <h2>Definitions</h2>
      <ul class="study-list">
        <li><strong>Published decision.</strong> One application number and the outcome printed in an official file: Approved or Refused. It is not a prediction and not a legal status check.</li>
        <li><strong>Report date.</strong> The date on the official file or the end of its reporting period. It is not necessarily the date an individual decision was made, and each office has its own report date.</li>
        <li><strong>Approval share.</strong> Approved decisions divided by all decisions in the same file or period. It describes published rows, not the chance that a particular application is approved.</li>
        <li><strong>Dated decision.</strong> A row whose office publishes an official decision or report-period date. New Delhi tracker rows are observation-dated and excluded from dated monthly totals; New Delhi, Beijing and Dublin latest files are reported separately.</li>
        <li><strong>Missing row.</strong> A number absent from a file has not necessarily been refused. It may be unpublished, handled by another office, or affected by a file gap or OCR error.</li>
      </ul>
    </section>

    <section>
      <h2>Coverage and freshness</h2>
      <p>Coverage starts with the oldest report currently archived (${esc(longDate(earliest))}). The newest office publication is dated ${esc(longDate(asOf))}, but that is not a shared cutoff.${cutoffNote} The six offices publish on different schedules: New Delhi on business days, Abu Dhabi, Abuja and Ankara weekly, Dublin on Tuesdays and Beijing irregularly. A missing office report is a gap, not a zero. Read <a href="/data/data_manifest.json">the manifest</a> for every office's report date and <a href="/data/freshness.json">freshness.json</a> for its official data-through date and any trailing tracker observation.</p>
      <p>The data is refreshed by a scheduled scraper and committed to the public repository. GitHub Actions can run late; offices do not publish on weekends or public holidays. Read <code>lastRunAt</code> and <code>ok</code> in <a href="/data/visa_meta.json"><code>visa_meta.json</code></a> before describing the data as current.</p>
    </section>

    <section>
      <h2>Reuse and citation</h2>
      <p>The underlying decisions are the publications of the Irish embassies and the Immigration Service Delivery and remain subject to their own re-use terms. The tracker’s compilation, charts and tables may be reused with attribution to the Irish Visa Decision Tracker and a link to this page. The source code is MIT licensed.</p>
      <p><strong>Cite this data:</strong> Parth Soni, <em>Irish Visa Decision Tracker: published Irish visa decisions</em> (${esc(publicationDateCopy(data))}), ${SITE}/data.</p>
      <p>For the full method, limits and downloadable study tables, see <a href="/data-study">the data study</a> and <a href="/about#method">Method &amp; sources</a>. For press use, see the <a href="/press">press and citation kit</a>.</p>
    </section>
  `;
  return shell({
    route: '/data',
    title: 'Open data: Irish visa decisions | Irish Visa Decision Tracker',
    description: 'Download the public JSON and CSV files behind the Irish Visa Decision Tracker, with coverage, definitions, update cadence, reuse terms and citation details.',
    body,
    jsonLd,
    markdown: '/data.md',
  });
}

function pressPage(data) {
  const stats = latestStats(data);
  const archive = reportArchiveStats(data);
  const asOf = stats.latestDate;
  const citation = `Parth Soni. (2026). Irish Visa Decision Tracker: published visa decisions by office (${publicationDateCopy(data)}) [Data set]. ${SITE}/data-study`;
  const archiveCounts = data.offices.map((office) => `${office.name}: ${num(office.decisions)}`).join('; ');

  const body = `    <p class="page-kicker">Press &amp; citation</p>
    <h1>Press and citation kit</h1>
    <p class="page-meta">Six offices &bull; Independent and unofficial</p>
    <p class="page-freshness small-note"><strong>Data freshness:</strong> ${esc(canonicalFreshness(data))}. <a href="/status">All six offices</a>.</p>

    <p class="page-lede">The tracker is an independent, searchable record of the decision files published by six Irish visa offices. It is useful for a story about published decision volume, approval shares or the shape of the official files — never as a prediction for an individual application.</p>

    <div class="study-grid">
      <div class="study-stat"><span class="status-kicker">Latest-file decisions</span><strong>${num(stats.decisions)}</strong><span>${stats.offices.length} offices</span></div>
      <div class="study-stat"><span class="status-kicker">Approved share</span><strong>${stats.rate.toFixed(1)}%</strong><span>Published rows, not odds</span></div>
      <div class="study-stat"><span class="status-kicker">Archived dated reports</span><strong>${num(archive.count)}</strong><span>${esc(shortDate(archive.earliest))} to ${esc(shortDate(archive.latest))}</span></div>
      <div class="study-stat"><span class="status-kicker">Public files</span><strong>JSON</strong><span>No account, no paywall</span></div>
    </div>

    <section>
      <h2>What the tracker records</h2>
      <p>For each office the tracker stores the published application number, decision and the date basis the office uses: a daily cumulative file for New Delhi, weekly report periods for Abu Dhabi, Abuja and Ankara, and dated snapshots for Beijing and Dublin. The latest-file totals are ${esc(archiveCounts)}.</p>
      <p>The files do not contain visa category, nationality, refusal reason or applicant demographics. Any statement about those would be unsupported by this data.</p>
    </section>

    <section>
      <h2>Story angles the data supports</h2>
      <ul class="study-list">
        <li><strong>Approval shares differ sharply by office.</strong> The latest files range from a weekly report where two-thirds were refused to large cumulative files with four-fifths approved; the <a href="/data-study">data study</a> sets out the figures and caveats.</li>
        <li><strong>Publication volume is not demand.</strong> Weekly reports show how many decisions an office published in a period, not how many people applied.</li>
        <li><strong>New Delhi's cumulative file is measurable day by day.</strong> Archived file dates show how the list grew across the run of file dates in November 2026.</li>
        <li><strong>Gaps are visible.</strong> The tracker records missing reports as gaps rather than estimating them.</li>
      </ul>
    </section>

    <section>
      <h2>Cite this data</h2>
      <p>Use the study URL and the data date. The citation is stable; the figures behind it are rebuilt from the latest official files.</p>
      <pre class="press-citation" tabindex="0"><code>${esc(citation)}</code></pre>
      <p class="small-note">A versioned snapshot of the summary tables and metadata is published at <a href="/data/snapshots/${esc(asOf)}/metadata.json">/data/snapshots/${esc(asOf)}/metadata.json</a>.</p>
    </section>

    <section>
      <h2>Reusable assets</h2>
      <p class="study-downloads">
        <a class="btn" href="/data/study/approval-rates.svg">Approval-rate chart (SVG)</a>
        <a class="btn" href="/data/study/monthly-volume.svg">Monthly-volume chart (SVG)</a>
        <a class="btn" href="/data/study/office-summary.csv">Office summary (CSV)</a>
        <a class="btn" href="/data/study/monthly-volume.csv">Monthly volume (CSV)</a>
        <a class="btn" href="/embed">Embeddable badge</a>
      </p>
      <p class="small-note">Charts and tables may be reused with attribution to the Irish Visa Decision Tracker and a link to the study. The underlying decisions remain the publications of the Irish embassies and the Immigration Service Delivery. The site's source code is MIT licensed; the tracker's compilation and charts are offered for reuse with attribution.</p>
    </section>

    <section>
      <h2>DOI-backed snapshots</h2>
      <p>A DOI is minted by depositing a dated snapshot with a repository such as Zenodo; it cannot be created by the site itself. The tracker publishes the snapshot files and citation metadata, so a deposit can point at an immutable version and the study can cite the DOI once it exists.</p>
      <p class="small-note">Publishing the DOI requires the maintainer's repository account. Until then, cite the study URL and the data date above. Corrections are logged in the <a href="/corrections">correction ledger</a>.</p>
    </section>

    <section>
      <h2>Interview and correction requests</h2>
      <p>Use the <a href="/contact">contact page</a> for questions, methodology details or a correction. The tracker cannot comment on an individual application or change a decision.</p>
      <p class="page-nav"><a href="/data-study">Data study</a> &middot; <a href="/reports">Report archive</a> &middot; <a href="/about">About</a> &middot; <a href="/about#method">Method &amp; sources</a></p>
    </section>`;

  return shell({
    route: '/press',
    title: CONTENT_PAGES.find((page) => page.route === '/press').title,
    description: CONTENT_PAGES.find((page) => page.route === '/press').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: `${SITE}/press`,
      name: 'Press and citation kit',
      description: 'Key statistics, methodology and citation guidance for the Irish Visa Decision Tracker.',
      inLanguage: 'en',
      dateModified: asOf,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function badgeAlt(office) {
  return `${office.name}: ${num(office.decisions)} decisions in the latest official file, ${longDate(office.report_date)}`;
}

function embedSnippet(office) {
  return `<a href="${SITE}${office.route}" rel="noopener">
  <img src="${SITE}/badges/${office.slug}.svg"
       alt="${badgeAlt(office)}"
       width="340" height="100" loading="lazy">
</a>`;
}

function embedPage(data) {
  const stats = latestStats(data);
  const asOf = stats.latestDate;
  const cards = data.offices.filter((office) => Number(office.decisions) > 0).map((office) => `<div class="badge-card">
        <img src="/badges/${office.slug}.svg" alt="${esc(badgeAlt(office))}" width="340" height="100" loading="lazy">
        <p class="badge-card-title">${esc(office.name)}</p>
        <p class="small-note">Updates when the site is rebuilt from the latest official file.</p>
        <details class="embed-details">
          <summary>Copy the ${esc(office.name)} snippet</summary>
          <pre class="embed-code" tabindex="0"><code>${esc(embedSnippet(office))}</code></pre>
        </details>
      </div>`).join('\n      ');

  const body = `    <p class="page-kicker">Embedded badge</p>
    <h1>Embed the latest official file</h1>
    <p class="page-meta">Static SVG &bull; No tracking &bull; No application data &bull; Six offices</p>
    <p class="page-freshness small-note"><strong>Data freshness:</strong> ${esc(canonicalFreshness(data))}. <a href="/status">All six offices</a>.</p>

    <p class="page-lede">A small badge for a forum post, student page or resource list. It shows one office's latest report date, decision count and approval share, and links back to that office's tracker page. The image is a static SVG: no script, no cookie and no applicant-level data.</p>

    <p class="callout"><strong>Keep the alt text.</strong> The snippet below includes a descriptive <code>alt</code> attribute, which is what screen readers and search engines see. Change the office name in the snippet, not the data.</p>

    <section>
      <h2>Choose a badge</h2>
      <div class="badge-grid">
      ${cards}
      </div>
    </section>

    <section>
      <h2>Markdown version</h2>
      <p>For a README or Markdown post, replace <code>new-delhi</code> with the office slug you need.</p>
      <pre class="embed-code" tabindex="0"><code>${esc(`[![New Delhi latest official file](${SITE}/badges/new-delhi.svg)](${SITE}/new-delhi-visa-decisions)`)}</code></pre>
      <p class="small-note">Badges inherit the site's no-store policy so a deploy's numbers are never stale. They are rebuilt from the public manifest, so the numbers always match the office page at the time of the last deploy.</p>
    </section>

    <section>
      <h2>What the badge says</h2>
      <ul class="study-list">
        <li><strong>Office and report date</strong> — the latest official file the tracker holds.</li>
        <li><strong>Decisions and approval share</strong> — published rows in that file, not an applicant's odds.</li>
        <li><strong>No personal data</strong> — application numbers never appear in the image or its URL.</li>
      </ul>
      <p class="page-nav"><a href="/data-study">Data study</a> &middot; <a href="/press">Press &amp; citation</a> &middot; <a href="/reports">Report archive</a></p>
    </section>`;

  return shell({
    route: '/embed',
    title: CONTENT_PAGES.find((page) => page.route === '/embed').title,
    description: CONTENT_PAGES.find((page) => page.route === '/embed').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: `${SITE}/embed`,
      name: 'Embed the latest official file badge',
      description: 'Static SVG badges for the latest Irish visa decision files.',
      inLanguage: 'en',
      dateModified: asOf,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function communityPage(data) {
  const groups = communityAggregates(data.community);
  const total = data.community.filter((row) => row && row.applied && row.decided).length;
  const publishable = groups.filter((group) => group.enough);
  const asOf = String(data.meta.lastRunAt || data.meta.fileDate || '').slice(0, 10);

  const rows = groups.map((group) => `<tr>
          <th scope="row">${esc(group.tracker)}</th>
          <td>${esc(group.outcome === 'granted' ? 'Granted' : group.outcome === 'refused' ? 'Refused' : group.outcome)}</td>
          <td>${num(group.count)}</td>
          <td>${group.enough ? `${num(group.median)} days` : 'Not enough data'}</td>
        </tr>`).join('\n        ');

  const body = `    <p class="page-kicker">Community timelines</p>
    <h1>Community processing timelines: the aggregate view</h1>
    <p class="page-meta">Anonymous aggregates only &bull; Minimum group size ${MIN_COMMUNITY_SAMPLE} &bull; Anecdotes, not statistics</p>

    <p class="page-lede">Visitors can share how long their own application took. Those submissions are anecdotes, not a representative sample. This page publishes a group only when it has at least ${MIN_COMMUNITY_SAMPLE} submissions, so no single person's timeline can be identified by subtraction.</p>

    <div class="study-grid">
      <div class="study-stat"><span class="status-kicker">Submissions in the public aggregate</span><strong>${num(total)}</strong><span>All trackers</span></div>
      <div class="study-stat"><span class="status-kicker">Groups large enough to publish</span><strong>${num(publishable.length)}</strong><span>Minimum ${MIN_COMMUNITY_SAMPLE} per group</span></div>
      <div class="study-stat"><span class="status-kicker">Individual timelines shown</span><strong>0</strong><span>Never published</span></div>
    </div>

    <section>
      <h2>What can be published</h2>
      ${publishable.length
        ? `<div class="table-wrap" role="region" aria-label="Community timeline aggregates" tabindex="0">
        <table class="office-table">
          <caption>Median days from application to decision, by group</caption>
          <thead><tr><th scope="col">Tracker</th><th scope="col">Outcome</th><th scope="col">Submissions</th><th scope="col">Median wait</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`
        : `<div class="community-empty">
        <p><strong>Not enough data to publish an aggregate yet.</strong></p>
        <p>The public file currently holds ${num(total)} submission${total === 1 ? '' : 's'}. A group needs at least ${MIN_COMMUNITY_SAMPLE} to be shown, and no individual timeline is ever published.</p>
        <p><a href="/contact#share-timeline">Share your timeline</a> to help the next reader. It is anonymous and appears only in aggregate.</p>
      </div>`}
      ${groups.length && !publishable.length ? `<div class="table-wrap" role="region" aria-label="Community timeline group sizes" tabindex="0">
        <table class="office-table">
          <caption>Current groups and their sample sizes</caption>
          <thead><tr><th scope="col">Tracker</th><th scope="col">Outcome</th><th scope="col">Submissions</th><th scope="col">Status</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : ''}
      <p class="small-note">A median is shown only when the group is large enough. Even then it describes the people who chose to share, not everyone who applied.</p>
    </section>

    <section>
      <h2>Privacy rules</h2>
      <ul class="study-list">
        <li><strong>No individual rows.</strong> The page never lists an application, a date pair or a free-text note on its own.</li>
        <li><strong>No identifiers.</strong> Names, emails, passport numbers and application numbers are not part of the aggregate file.</li>
        <li><strong>Small groups stay hidden.</strong> A group below ${MIN_COMMUNITY_SAMPLE} is suppressed, including when it is the only group.</li>
        <li><strong>Anecdotes are labelled.</strong> Submission is self-selected, so the aggregate can over-represent fast or slow cases.</li>
      </ul>
      <p class="small-note">Source: <a href="/data/community_timelines.json">community_timelines.json</a>. The tracker's own processing-time tracker is separate and based on official queues.</p>
      <p class="page-nav"><a href="/contact#share-timeline">Share a timeline</a> &middot; <a href="/stamp-1g-processing-dates">Stamp 1G dates</a> &middot; <a href="/visa-processing-times">Visa processing times</a> &middot; <a href="/privacy">Privacy</a></p>
    </section>`;

  return shell({
    route: '/community-timelines',
    title: CONTENT_PAGES.find((page) => page.route === '/community-timelines').title,
    description: CONTENT_PAGES.find((page) => page.route === '/community-timelines').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: `${SITE}/community-timelines`,
      name: 'Community processing timelines: aggregate view',
      description: 'Privacy-safe aggregate of community-reported Irish visa and Stamp 1G processing timelines.',
      inLanguage: 'en',
      dateModified: asOf || undefined,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function httpUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    return new URL(raw).href;
  } catch {
    return '';
  }
}

function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${num(number)}` : num(number);
}

function reportTitle(office, entry) {
  return `${office.name} visa decisions — ${longDate(entry.report_date)} | Irish Visa Decision Tracker`;
}

function reportsIndexPage(data) {
  const archive = reportArchiveStats(data);
  const asOf = archive.latest || latestStats(data).latestDate;
  const rows = archive.rows.slice().sort((a, b) =>
    String(b.entry.report_date).localeCompare(String(a.entry.report_date))
    || a.slug.localeCompare(b.slug));

  const tableRows = rows.map(({ slug, entry }) => {
    const office = data.bySlug.get(slug);
    const snapshot = SNAPSHOT_OFFICES.has(slug);
    const decisions = Number(entry.decisions) || 0;
    const approved = Number(entry.approved) || 0;
    const refused = Number(entry.refused) || 0;
    const date = String(entry.report_date).slice(0, 10);
    return `<tr>
          <th scope="row"><a href="/reports/${slug}/${date}">${esc(longDate(date))}</a></th>
          <td data-label="Office"><a href="/reports/${slug}">${esc(office ? office.name : slug)}</a>${snapshot ? ' <span class="small-note">(snapshot)</span>' : ''}</td>
          <td data-label="Decisions">${num(decisions)}</td>
          <td data-label="Approved">${num(approved)}</td>
          <td data-label="Refused">${num(refused)}</td>
          <td data-label="Approval rate">${pct(approved, decisions)}</td>
          <td data-label="Tracker observed">${entry.fetched_at ? timeHTML(entry.fetched_at) : '—'}</td>
        </tr>`;
  }).join('\n        ');

  const officeLinks = data.offices.map((office) => {
    const history = reportHistory(officeEntries(data, office.slug));
    const isSnapshot = SNAPSHOT_OFFICES.has(office.slug);
    return `<li><a href="/reports/${office.slug}">${esc(office.name)}</a> <span class="small-note">${num(history.length)} ${isSnapshot ? 'snapshot' : 'dated report'}${history.length === 1 ? '' : 's'}</span></li>`;
  }).join('\n        ');

  const body = `    <p class="page-kicker">Official report archive</p>
    <h1>Every official report in the archive</h1>
    <p class="page-meta">${num(archive.count)} reports &bull; ${num(archive.datedCount)} dated + ${num(archive.snapshotCount)} snapshot re-checks &bull; ${esc(shortDate(archive.earliest))} to ${esc(shortDate(archive.latest))}</p>

    <p class="page-lede">Each entry is one official report or snapshot check with its decision count, approval share, checksum and the file the office published. There are no empty or duplicate pages: repeated checks of an unchanged snapshot are collapsed into one entry.</p>

    <div class="study-grid">
      <div class="study-stat"><span class="status-kicker">Dated reports</span><strong>${num(archive.datedCount)}</strong><span>Across four dated-report offices</span></div>
      <div class="study-stat"><span class="status-kicker">Earliest report</span><strong>${esc(shortDate(archive.earliest))}</strong><span>Archive start</span></div>
      <div class="study-stat"><span class="status-kicker">Latest dated report</span><strong>${esc(shortDate(archive.datedLatest))}</strong><span>Snapshot re-checks excluded</span></div>
      <div class="study-stat"><span class="status-kicker">Latest snapshot</span><strong>${esc(shortDate(archive.snapshotLatest))}</strong><span>Beijing / Dublin check</span></div>
      <div class="study-stat"><span class="status-kicker">Source links</span><strong>Official</strong><span>Every report page</span></div>
    </div>

    <section>
      <h2>Browse by office</h2>
      <ul class="report-office-list">
        ${officeLinks}
      </ul>
    </section>

    <section>
      <h2>All archived reports</h2>
      <div class="table-wrap" role="region" aria-label="All archived official reports" tabindex="0">
        <table class="office-table stack-table">
          <caption>Newest first; each date opens the report page</caption>
          <thead><tr><th scope="col">Report date</th><th scope="col">Office</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th><th scope="col">Approval rate</th><th scope="col">Tracker observed</th></tr></thead>
          <tbody>
        ${tableRows || '<tr><td colspan="7">No dated reports are archived yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <p class="small-note">The archive records what each office published. A missing date is a publication gap, never a reconstructed report. Beijing and Dublin publish live snapshots: their dates are the day the tracker checked an unchanged list, not a new dated decision report.</p>
      <p class="page-nav"><a href="/data-study">Data study</a> &middot; <a href="/when-are-visa-decisions-published">Publication schedule</a> &middot; <a href="/press">Press &amp; citation</a> &middot; <a href="/status">Data status</a></p>
    </section>`;

  return shell({
    route: '/reports',
    title: CONTENT_PAGES.find((page) => page.route === '/reports').title,
    description: CONTENT_PAGES.find((page) => page.route === '/reports').description,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      url: `${SITE}/reports`,
      name: 'Official report archive',
      description: 'Dated official Irish visa decision reports with counts, approval rates and source links.',
      inLanguage: 'en',
      dateModified: asOf,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function officeReportsPage(data, office) {
  const history = reportHistory(officeEntries(data, office.slug));
  const asOf = history.length ? String(history[0].entry.report_date).slice(0, 10) : String(office.report_date || '').slice(0, 10);
  const rows = history.map(({ entry, prior }) => {
    const decisions = Number(entry.decisions) || 0;
    const approved = Number(entry.approved) || 0;
    const refused = Number(entry.refused) || 0;
    const date = String(entry.report_date).slice(0, 10);
    const delta = prior ? decisions - (Number(prior.decisions) || 0) : null;
    return `<tr>
          <th scope="row"><a href="/reports/${office.slug}/${date}">${esc(longDate(date))}</a></th>
          <td data-label="Decisions">${num(decisions)}</td>
          <td data-label="Approved">${num(approved)}</td>
          <td data-label="Refused">${num(refused)}</td>
          <td data-label="Approval rate">${pct(approved, decisions)}</td>
          <td data-label="Change">${delta == null ? '—' : signed(delta)}</td>
          <td data-label="Tracker observed">${entry.fetched_at ? timeHTML(entry.fetched_at) : '—'}</td>
        </tr>`;
  }).join('\n        ');

  const body = `    <p class="page-kicker">${esc(office.name)} report archive</p>
    <h1>${esc(office.name)} official reports</h1>
    <p class="page-meta">${num(history.length)} ${SNAPSHOT_OFFICES.has(office.slug) ? 'snapshot check' : 'dated report'}${history.length === 1 ? '' : 's'} &bull; ${esc(office.basis)} &bull; Archive through ${esc(longDate(asOf))}</p>

    <p class="page-lede">The ${SNAPSHOT_OFFICES.has(office.slug) ? 'snapshot checks' : 'dated reports'} the tracker holds for ${esc(office.name)}. Each row opens the report page with its decision counts, approval share, checksum and official source. The office page explains what ${esc(office.name)} publishes and how to search an application number.</p>

    <p class="study-downloads">
      <a class="btn primary" href="${office.route}">${esc(office.name)} office page</a>
      <a class="btn" href="/reports">All reports</a>
    </p>

    <section>
      <h2>${SNAPSHOT_OFFICES.has(office.slug) ? 'Snapshot checks' : 'Dated reports'}</h2>
      <div class="table-wrap" role="region" aria-label="${esc(office.name)} dated reports" tabindex="0">
        <table class="office-table stack-table">
          <caption>Newest first; change compares the prior distinct report</caption>
          <thead><tr><th scope="col">Report date</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th><th scope="col">Approval rate</th><th scope="col">Change</th><th scope="col">Tracker observed</th></tr></thead>
          <tbody>
        ${rows || `<tr><td colspan="7">No ${SNAPSHOT_OFFICES.has(office.slug) ? 'snapshot checks' : 'dated reports'} are archived for this office yet.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="small-note">${esc(office.basis)}. The report date is the file's own date or period end, not the date the tracker saw it.</p>
      <p class="page-nav"><a href="${office.route}">${esc(office.name)} decisions</a> &middot; <a href="/reports">All reports</a> &middot; <a href="/data-study">Data study</a></p>
    </section>`;

  return shell({
    route: `/reports/${office.slug}`,
    title: `${office.name} official report archive | Irish Visa Decision Tracker`,
    description: `${SNAPSHOT_OFFICES.has(office.slug) ? 'Snapshot checks' : 'Dated'} ${office.name} Irish visa decision reports with counts, approval rates, checksums and official source links.`,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      url: `${SITE}/reports/${office.slug}`,
      name: `${office.name} official reports`,
      inLanguage: 'en',
      dateModified: asOf || undefined,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function reportDetailPage(data, office, entry, prior) {
  const date = String(entry.report_date).slice(0, 10);
  const decisions = Number(entry.decisions) || 0;
  const approved = Number(entry.approved) || 0;
  const refused = Number(entry.refused) || 0;
  const delta = prior ? decisions - (Number(prior.decisions) || 0) : null;
  const changed = Array.isArray(entry.changed) ? entry.changed.length : 0;
  const sourceFile = httpUrl(entry.source_file);
  const officialPage = httpUrl(office.source_url);
  const route = `/reports/${office.slug}/${date}`;

  const body = `    <p class="page-kicker">Official report</p>
    <h1>${esc(office.name)} visa decisions — ${esc(longDate(date))}</h1>
    <p class="page-meta">${esc(office.basis)} &bull; ${num(decisions)} decisions &bull; Independent and unofficial</p>

    <p class="page-lede">The ${esc(office.name)} official file dated ${esc(longDate(date))} records ${num(decisions)} decisions: ${num(approved)} approved and ${num(refused)} refused. This page preserves the dated report and its source link; it is not an individual decision notice.</p>

    <div class="status-grid">
      <div class="status-card"><span class="status-kicker">Decisions</span><strong>${num(decisions)}</strong><span>In this report</span></div>
      <div class="status-card"><span class="status-kicker">Approved</span><strong>${num(approved)}</strong><span>${pct(approved, decisions)} of decisions</span></div>
      <div class="status-card"><span class="status-kicker">Refused</span><strong>${num(refused)}</strong><span>${pct(refused, decisions)} of decisions</span></div>
      <div class="status-card"><span class="status-kicker">Change</span><strong>${delta == null ? '—' : signed(delta)}</strong><span>${prior ? `vs ${esc(shortDate(prior.report_date))}` : 'Earliest archived report'}</span></div>
    </div>

    <section>
      <h2>Report details</h2>
      <div class="table-wrap" role="region" aria-label="${esc(office.name)} report details" tabindex="0">
        <table class="office-table meta-table">
          <caption>Report identity and provenance</caption>
          <tbody>
            <tr><th>Office</th><td><a href="${office.route}">${esc(office.name)}</a></td></tr>
            <tr><th>Report date</th><td><time datetime="${date}">${esc(longDate(date))}</time></td></tr>
            <tr><th>Observed by tracker</th><td>${entry.fetched_at ? timeHTML(entry.fetched_at) : 'Not recorded'}<br><span class="small-note">When the tracker fetched the file, not the publication time.</span></td></tr>
            <tr><th>Report basis</th><td>${esc(office.basis)}</td></tr>
            <tr><th>Checksum</th><td><code>${esc(entry.checksum || '—')}</code></td></tr>
            <tr><th>Source file</th><td>${sourceFile ? `<a href="${esc(sourceFile)}" target="_blank" rel="noopener noreferrer">Open the official file</a>` : 'No file URL recorded'}</td></tr>
            <tr><th>Official page</th><td>${officialPage ? `<a href="${esc(officialPage)}" target="_blank" rel="noopener noreferrer">${esc(office.name)} official page</a>` : '—'}</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>Change from the prior report</h2>
      ${prior ? `<p>This report follows the ${esc(shortDate(prior.report_date))} report. The decision count ${delta >= 0 ? 'rose' : 'fell'} by ${num(Math.abs(delta))}.${office.basis.startsWith('Cumulative') ? ' For a cumulative file, net growth is the meaningful change; the added/removed counters describe the tracker\'s row diff and can be zero on an initial or cumulative import.' : ''}</p>
      <div class="table-wrap" role="region" aria-label="Change from the prior report" tabindex="0">
        <table class="office-table meta-table">
          <caption>Difference recorded by the tracker</caption>
          <tbody>
            <tr><th>Prior report</th><td><a href="/reports/${office.slug}/${String(prior.report_date).slice(0, 10)}">${esc(longDate(prior.report_date))}</a></td></tr>
            <tr><th>Prior decisions</th><td>${num(prior.decisions)}</td></tr>
            <tr><th>Net change in decisions</th><td>${signed(delta)}</td></tr>
            <tr><th>Added rows (tracker row diff)</th><td>${entry.added == null ? 'Not recorded' : num(entry.added)}</td></tr>
            <tr><th>Removed rows</th><td>${entry.removed == null ? 'Not recorded' : num(entry.removed)}</td></tr>
            <tr><th>Changed outcomes</th><td>${changed ? num(changed) : 'None recorded'}</td></tr>
          </tbody>
        </table>
      </div>` : '<p>This is the earliest archived report for this office, so there is no prior report to compare.</p>'}
    </section>

    <section>
      <h2>How to use this page</h2>
      <p>Use the report counts to verify a published figure, or follow the source file to the office's own document. To check one application number, use <a href="/?tracker=visa&amp;tab=search&amp;office=${office.slug}">office search</a> with the number from your receipt.</p>
      <p>A missing number is not a refusal. The report records decisions, not passport collection, and the official document remains the authority.</p>
      <p class="page-nav"><a href="/reports/${office.slug}">${esc(office.name)} report archive</a> &middot; <a href="${office.route}">${esc(office.name)} office page</a> &middot; <a href="/reports">All reports</a> &middot; <a href="/data-study">Data study</a></p>
    </section>`;

  return shell({
    route,
    title: reportTitle(office, entry),
    description: `The ${office.name} official file dated ${longDate(date)} records ${num(decisions)} decisions: ${num(approved)} approved and ${num(refused)} refused.`,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          '@id': `${SITE}${route}#webpage`,
          url: `${SITE}${route}`,
          name: `${office.name} visa decisions — ${longDate(date)}`,
          description: `${num(decisions)} decisions in the ${office.name} official report dated ${longDate(date)}.`,
          inLanguage: 'en',
          isPartOf: { '@id': `${SITE}/#website` },
          dateModified: date,
        },
        {
          '@type': 'BreadcrumbList',
          '@id': `${SITE}${route}#breadcrumb`,
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Tracker', item: `${SITE}/` },
            { '@type': 'ListItem', position: 2, name: 'Reports', item: `${SITE}/reports` },
            { '@type': 'ListItem', position: 3, name: office.name, item: `${SITE}/reports/${office.slug}` },
            { '@type': 'ListItem', position: 4, name: longDate(date), item: `${SITE}${route}` },
          ],
        },
      ],
    },
  });
}

function badgeSvg(office, fresh) {
  const decisions = Number(office.decisions) || 0;
  const approved = Number(office.approved) || 0;
  const title = badgeAlt(office);
  const checked = fresh && fresh.last_success_label
    ? ` Last successful check ${fresh.last_success_label}.`
    : '';
  const basis = fresh && fresh.status === 'error'
    ? ' The latest check failed, so this is not a live reading.'
    : ' Static snapshot, not a live feed.';
  const desc = `${title}.${checked}${basis}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="100" viewBox="0 0 340 100" role="img" aria-labelledby="badge-title badge-desc">
  <title id="badge-title">${esc(office.name)} latest official visa decision file</title>
  <desc id="badge-desc">${esc(desc)}</desc>
  <rect width="340" height="100" rx="10" fill="#ffffff" stroke="#e2e8f0"/>
  <rect x="0" y="0" width="6" height="100" rx="3" fill="#059669"/>
  <text x="22" y="26" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="9.5" font-weight="700" letter-spacing="1.1" fill="#6b7280">IRISH VISA DECISION TRACKER</text>
  <text x="22" y="50" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="18" font-weight="700" fill="#111827">${esc(office.name)}</text>
  <text x="22" y="71" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="11.5" fill="#4b5563">${esc(shortDate(office.report_date))} &#183; ${num(decisions)} decisions &#183; ${pct(approved, decisions)} approved</text>
  <text x="318" y="88" text-anchor="end" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="9.5" fill="#6b7280">Latest official file</text>
</svg>
`;
}

function officeSummaryCsv(data) {
  const rows = [[
    'office', 'slug', 'latest_report_date', 'decisions', 'approved', 'refused',
    'approval_rate', 'archive_decisions', 'archived_report_dates',
    'earliest_report_date', 'latest_archive_date', 'source_url',
  ]];
  for (const office of data.offices) {
    const history = distinctReports(officeEntries(data, office.slug));
    const dates = history.map((entry) => String(entry.report_date).slice(0, 10)).sort();
    const decisions = Number(office.decisions) || 0;
    const approved = Number(office.approved) || 0;
    rows.push([
      office.name,
      office.slug,
      String(office.report_date || '').slice(0, 10),
      decisions,
      approved,
      Number(office.refused) || 0,
      pct(approved, decisions),
      Number(office.archive_decisions) || decisions,
      history.length,
      dates[0] || '',
      dates[dates.length - 1] || '',
      office.source_url || '',
    ]);
  }
  return csv(rows);
}

function monthlyVolumeCsv(monthly) {
  const rows = [['month', 'label', 'abu_dhabi', 'abuja', 'ankara', 'new_delhi_file_growth', 'total']];
  for (const bucket of monthly) {
    rows.push([
      bucket.month,
      bucket.label,
      bucket.byOffice['abu-dhabi'] || 0,
      bucket.byOffice.abuja || 0,
      bucket.byOffice.ankara || 0,
      bucket.byOffice['new-delhi'] || 0,
      bucket.total,
    ]);
  }
  return csv(rows);
}

function newDelhiGrowthCsv(growth) {
  const rows = [['report_date', 'cumulative_decisions', 'added_since_prior_file', 'approved', 'refused', 'approval_rate', 'source_file', 'checksum']];
  for (const row of growth) {
    rows.push([
      row.report_date,
      row.decisions,
      row.added == null ? '' : row.added,
      row.approved,
      row.refused,
      pct(row.approved, row.decisions),
      row.source_file,
      row.checksum,
    ]);
  }
  return csv(rows);
}

function snapshotMetadata(data, asOf) {
  const stats = latestStats(data);
  return {
    title: 'Irish Visa Decision Tracker: published visa decisions by office',
    version: asOf,
    data_date: asOf,
    generated_from: [
      '/data/data_manifest.json',
      '/data/reports/index.json',
      ...OFFICE_ORDER.map((slug) => `/data/embassy-${slug}.json`),
    ],
    totals: {
      offices: stats.offices.length,
      decisions: stats.decisions,
      approved: stats.approved,
      refused: stats.refused,
      approval_rate: `${stats.rate.toFixed(1)}%`,
    },
    offices: stats.offices.map((office) => ({
      slug: office.slug,
      name: office.name,
      report_date: String(office.report_date || '').slice(0, 10),
      decisions: Number(office.decisions) || 0,
      approved: Number(office.approved) || 0,
      refused: Number(office.refused) || 0,
      approval_rate: pct(office.approved, office.decisions),
      source_url: office.source_url || '',
    })),
    licence: 'Charts and compiled tables may be reused with attribution. Underlying decisions remain the publications of the Irish embassies and the Immigration Service Delivery. Source code is MIT licensed.',
    doi: null,
    doi_note: 'A DOI requires deposit with a repository such as Zenodo using the maintainer\'s account. This snapshot and metadata are the deposit-ready record.',
  };
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sitemapPath(loc) {
  try {
    return new URL(loc).pathname.replace(/\/$/, '') || '/';
  } catch {
    return String(loc || '').replace(/\/$/, '') || '/';
  }
}

function appendSitemap(distDir, additions) {
  const file = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(file)) return 0;
  let xml = fs.readFileSync(file, 'utf8');
  const present = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => sitemapPath(match[1])));
  const blocks = additions
    .filter((item) => item && item.loc && !present.has(sitemapPath(item.loc)))
    .map((item) => `  <url>\n    <loc>${item.loc}</loc>\n${item.lastmod ? `    <lastmod>${item.lastmod}</lastmod>\n` : ''}  </url>`);
  if (!blocks.length) return 0;
  xml = xml.replace('</urlset>', `${blocks.join('\n')}\n</urlset>`);
  fs.writeFileSync(file, xml);
  return blocks.length;
}

/**
 * Write every generated insight page, report permalink, badge and data export.
 * `writeSource` refreshes the checked-in copies in the repository instead of a
 * build directory, which is how the pages stay previewable without a build.
 */
export function buildInsightPages(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || ROOT);
  const distDir = path.resolve(options.distDir || path.join(ROOT, '.pages-dist'));
  const outDir = options.writeSource ? ROOT : distDir;
  const data = loadInsightData(assetsRoot);
  const stats = latestStats(data);
  const asOf = stats.latestDate || String(data.meta.fileDate || '').slice(0, 10);
  const monthly = monthlyVolume(data);
  const growth = newDelhiFileGrowth(data);
  const archive = reportArchiveStats(data);

  const pages = {
    'data.html': dataPage(data),
    'data-study.html': studyPage(data),
    'when-are-visa-decisions-published.html': schedulePage(data),
    'press.html': pressPage(data),
    'embed.html': embedPage(data),
    'community-timelines.html': communityPage(data),
    'reports.html': reportsIndexPage(data),
  };
  const footer = freshnessFooterHTML(data.freshness);
  const history = freshnessHistoryHTML(data.freshness);
  const withFooter = (html, includeHistory = false) => {
    const extra = includeHistory && history
      ? `<section><h2>Observation history</h2>${history}</section>`
      : '';
    return html.replace('</main>', `${extra}${footer}</main>`);
  };
  for (const [file, html] of Object.entries(pages)) {
    writeFile(path.join(outDir, file), withFooter(
      html,
      file === 'when-are-visa-decisions-published.html',
    ));
  }

  let reportPages = 0;
  for (const office of data.offices) {
    const history = reportHistory(officeEntries(data, office.slug));
    writeFile(path.join(outDir, 'reports', `${office.slug}.html`), withFooter(officeReportsPage(data, office)));
    for (const { entry, prior } of history) {
      const date = String(entry.report_date).slice(0, 10);
      writeFile(path.join(outDir, 'reports', office.slug, `${date}.html`), withFooter(reportDetailPage(data, office, entry, prior)));
      reportPages += 1;
    }
  }

  for (const office of data.offices.filter((item) => Number(item.decisions) > 0)) {
    writeFile(path.join(outDir, 'badges', `${office.slug}.svg`), badgeSvg(office, data.freshness.bySlug[office.slug]));
  }

  writeFile(path.join(outDir, 'data', 'study', 'office-summary.csv'), officeSummaryCsv(data));
  writeFile(path.join(outDir, 'data', 'study', 'monthly-volume.csv'), monthlyVolumeCsv(monthly));
  writeFile(path.join(outDir, 'data', 'study', 'new-delhi-file-growth.csv'), newDelhiGrowthCsv(growth));
  writeFile(path.join(outDir, 'data', 'study', 'approval-rates.svg'), approvalChart(data));
  writeFile(path.join(outDir, 'data', 'study', 'monthly-volume.svg'), volumeChart(monthly));

  if (asOf) {
    const snapshotDir = path.join(outDir, 'data', 'snapshots', asOf);
    writeFile(path.join(snapshotDir, 'office-summary.csv'), officeSummaryCsv(data));
    writeFile(path.join(snapshotDir, 'monthly-volume.csv'), monthlyVolumeCsv(monthly));
    writeFile(path.join(snapshotDir, 'metadata.json'), `${JSON.stringify(snapshotMetadata(data, asOf), null, 2)}\n`);
  }

  let sitemapAdded = 0;
  if (!options.writeSource) {
    const additions = [
      // Community timelines stays available but out of the sitemap until its
      // groups clear the minimum sample size again.
      ...CONTENT_PAGES.filter((page) => page.route !== '/community-timelines')
        .map((page) => ({ loc: `${SITE}${page.route}`, lastmod: asOf })),
      { loc: `${SITE}/reports`, lastmod: archive.latest || asOf },
      ...data.offices.map((office) => ({ loc: `${SITE}/reports/${office.slug}`, lastmod: String(office.report_date || asOf).slice(0, 10) })),
      ...archive.rows.map(({ slug, entry }) => ({ loc: `${SITE}/reports/${slug}/${String(entry.report_date).slice(0, 10)}`, lastmod: String(entry.report_date).slice(0, 10) })),
    ];
    sitemapAdded = appendSitemap(distDir, additions);
  }

  return {
    outDir,
    pages: Object.keys(pages),
    reportPages,
    badges: data.offices.filter((office) => Number(office.decisions) > 0).length,
    sitemapAdded,
    asOf,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const writeSource = process.argv.includes('--write');
  const result = buildInsightPages({ writeSource });
  console.log(`Insight pages ${writeSource ? 'written' : 'built'}: ${result.pages.length} pages, ${result.reportPages} report permalinks, ${result.badges} badges` +
    (result.sitemapAdded ? `, ${result.sitemapAdded} sitemap entries` : '') + '.');
}
