/**
 * Backfill older Abu Dhabi and Abuja weekly PDF reports into the cumulative
 * office archives. Existing rows are retained; a decision number is refreshed
 * only when a newer report contains it.
 *
 * Usage:
 *   node tools/backfill-weekly-history.mjs --dry-run
 *   node tools/backfill-weekly-history.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { PDFParse } from 'pdf-parse';
import { decisionChecksum } from './embassy-checksum.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const REPORT_INDEX_FILE = path.join(DATA, 'reports', 'index.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// The embassy pages only keep the four newest reports. These older URLs were
// recovered from the previous page rotation and Ireland.ie's document archive.
const OFFICES = {
  'abu-dhabi': {
    page: 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
    extraPdfs: [
      'https://assets.ireland.ie/documents/Decisions_for_period_from_13-09-2026_to_18-09-2026.pdf',
      'https://www.ireland.ie/5232/Decisions_for_period_from_04-10-2026_to_09-10-2026.pdf',
      'https://www.ireland.ie/5219/Decisions_for_period_from_27-09-2026_to_02-10-2026.pdf',
      'https://assets.ireland.ie/documents/Decisions_for_period_from_20-09-2026_to_25-09-2026.pdf',
      'https://assets.ireland.ie/documents/4th_Sep_to_11th_Sep.pdf'
    ]
  },
  abuja: {
    page: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
    extraPdfs: [
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_42.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_40.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_37.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_35.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_30.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_29.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_27.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_26.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_25.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_24.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_23.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_21.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_20.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_5.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_2.pdf',
      'https://www.ireland.ie/5151/ApplicationDecisionReport_14.09_to_20.09.pdf',
      'https://www.ireland.ie/5126/ApplicationDecisionReport_07.09_13.09.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_44.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_45_2.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_46.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport_47.pdf',
      'https://assets.ireland.ie/documents/ApplicationDecisionReport__24.08.pdf'
    ]
  }
};

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, value) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const newline = existing.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, JSON.stringify(value, null, 2).replace(/\n/g, newline) + newline);
}

function archiveReports(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row || !row.date) continue;
    counts.set(row.date, (counts.get(row.date) || 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([report_date, decisions]) => ({ report_date, decisions }));
}

function periodEnd(text) {
  const matches = String(text).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/g) || [];
  const dates = matches
    .map((value) => {
      const match = value.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
      if (!match) return null;
      const day = Number(match[1]);
      const month = Number(match[2]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    })
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function parseRows(text, reportDate, slug) {
  const rows = new Map();
  const re = /^\s*(\d{6,})\s+(Approved|Refused)\s*$/gim;
  let match;
  while ((match = re.exec(String(text)))) {
    rows.set(match[1], {
      date: reportDate,
      number: match[1],
      decision: match[2],
      embassy: slug,
      date_basis: 'report_period_end'
    });
  }
  return [...rows.values()];
}

async function fetchPage(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      Referer: 'https://www.ireland.ie/'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function parseReport(url, slug, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/pdf',
      Referer: 'https://www.ireland.ie/'
    },
    redirect: 'follow'
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    const text = result.text || '';
    const reportDate = periodEnd(text);
    if (!reportDate) throw new Error('could not determine report period end');
    const rows = parseRows(text, reportDate, slug);
    if (rows.length < 10) throw new Error(`only ${rows.length} decision rows extracted`);
    return { url, reportDate, rows };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function mergeRows(existing, incoming) {
  const byNumber = new Map();
  for (const row of existing) {
    byNumber.set(String(row.number), row);
  }
  for (const row of incoming) {
    const number = String(row.number);
    const previous = byNumber.get(number);
    if (!previous || row.date >= previous.date) byNumber.set(number, row);
  }
  return [...byNumber.values()].sort(
    (a, b) => b.date.localeCompare(a.date) || a.number.localeCompare(b.number)
  );
}

function historyEntry(report, now) {
  const approved = report.rows.filter((row) => row.decision === 'Approved').length;
  return {
    report_date: report.reportDate,
    fetched_at: now().toISOString(),
    decisions: report.rows.length,
    approved,
    refused: report.rows.length - approved,
    source_file: report.url,
    checksum: decisionChecksum(report.rows),
    added: report.rows.length,
    removed: 0,
    changed: [],
    backfilled: true
  };
}

async function discoverPdfs(config, fetchImpl) {
  const html = await fetchPage(config.page, fetchImpl);
  const $ = cheerio.load(html);
  const urls = new Set(config.extraPdfs);
  $('a').each((_, element) => {
    const href = $(element).attr('href') || '';
    if (/\.pdf(\?|$)/i.test(href)) urls.add(new URL(href, config.page).href);
  });
  return [...urls];
}

export async function runBackfill(options = {}) {
  const dataDir = options.dataDir || DATA;
  const reportIndexFile = options.reportIndexFile || path.join(dataDir, 'reports', 'index.json');
  const offices = options.offices || OFFICES;
  const fetchImpl = options.fetchImpl || fetch;
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : process.argv.includes('--dry-run');
  const now = options.now || (() => new Date());
  const log = options.log || console.log;
  const warn = options.warn || console.warn;
  const reportIndex = readJSON(reportIndexFile);
  if (!reportIndex.offices) reportIndex.offices = {};
  const manifestFile = options.manifestFile || path.join(dataDir, 'data_manifest.json');
  const manifest = fs.existsSync(manifestFile) ? readJSON(manifestFile) : null;
  const results = [];

  for (const [slug, config] of Object.entries(offices)) {
    const office = readJSON(path.join(dataDir, `embassy-${slug}.json`));
    const pdfs = await discoverPdfs(config, fetchImpl);
    const reports = [];

    for (const url of pdfs) {
      try {
        const report = await parseReport(url, slug, fetchImpl);
        if (report.reportDate >= office.report_date) {
          log(`[${slug}] skip current/newer ${report.reportDate} ${url}`);
          continue;
        }
        reports.push(report);
        log(`[${slug}] ${report.reportDate} ${report.rows.length} rows ${url}`);
      } catch (error) {
        warn(`[${slug}] skipped ${url}: ${error.message}`);
      }
    }

    const historical = reports.flatMap((report) => report.rows);
    const merged = mergeRows(office.decisions, historical);
    const dates = [...new Set(merged.map((row) => row.date))].sort().reverse();
    log(
      `[${slug}] ${office.decisions.length} existing + ${historical.length} parsed -> ${merged.length} unique rows; ` +
        `${dates.length} report dates`
    );

    if (dates.length < 2) {
      warn(`[${slug}] no older report dates found; leaving data unchanged`);
      continue;
    }

    const nextOffice = { ...office, checksum: decisionChecksum(merged), decisions: merged };
    const entries = Array.isArray(reportIndex.offices[slug]) ? reportIndex.offices[slug] : [];
    for (const report of reports) {
      const entry = historyEntry(report, now);
      const existing = entries.find((item) => item.report_date === report.reportDate);
      if (existing) Object.assign(existing, entry);
      else entries.push(entry);
    }
    entries.sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    reportIndex.offices[slug] = entries.slice(0, 100);

    if (manifest && Array.isArray(manifest.offices)) {
      const summary = manifest.offices.find((officeSummary) => officeSummary.slug === slug);
      if (summary) {
        summary.archive_decisions = merged.length;
        summary.historical_decisions = Math.max(
          0,
          merged.length - (Number(summary.decisions) || 0)
        );
        summary.archive_reports = archiveReports(merged);
      }
    }

    results.push({ slug, office: nextOffice, reportIndex: reportIndex.offices[slug] });
  }

  if (!results.length) {
    log('No older reports found; nothing written.');
    return { dryRun, results };
  }

  if (dryRun) {
    for (const result of results) {
      const dates = [...new Set(result.office.decisions.map((row) => row.date))].sort().reverse();
      log(`DRY RUN ${result.slug}: ${dates.join(', ')}`);
    }
    return { dryRun, results };
  }

  for (const result of results) {
    writeJSON(path.join(dataDir, `embassy-${result.slug}.json`), result.office);
  }
  writeJSON(reportIndexFile, reportIndex);
  if (manifest) writeJSON(manifestFile, manifest);
  log('Backfill written.');
  return { dryRun, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackfill().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
