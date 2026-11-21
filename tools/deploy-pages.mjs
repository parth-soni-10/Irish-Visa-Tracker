/**
 * Deploy Pages Build Script
 * Builds the static assets and copies them to .pages-dist for Cloudflare Pages deployment
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildSearchFallback } from './build-search-fallback.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse command line arguments
const args = process.argv.slice(2);
let assetsDir = '.';
let outDir = '.pages-dist';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--assets' && i + 1 < args.length) {
    assetsDir = args[i + 1];
    i++;
  } else if (args[i] === '--out' && i + 1 < args.length) {
    outDir = args[i + 1];
    i++;
  }
}

const rootDir = path.resolve(__dirname, '..');
const assetsRootDir = path.resolve(rootDir, assetsDir);
const distDir = path.resolve(rootDir, outDir);

// Files and directories to copy to .pages-dist
// Only includes files that actually exist
const assetsToCopy = [
  'index.html',
  '404.html',
  'about.html',
  'help.html',
  'comparison.html',
  'status.html',
  'contact.html',
  'corrections.html',
  'daily-summaries.html',
  'new-delhi-visa-decisions.html',
  'beijing-visa-decisions.html',
  'abu-dhabi-visa-decisions.html',
  'abuja-visa-decisions.html',
  'ankara-visa-decisions.html',
  'dublin-visa-decisions.html',
  'employment-permit-processing-dates.html',
  'privacy.html',
  'terms.html',
  'admin.html',
  'monthly-report.html',

  'stamp-1g-processing-dates.html',
  'vac-transit.html',
  'visa-processing-times.html',
  '_headers',
  'manifest.json',
  'sw.js',
  'icon-72.png',
  'icon-96.png',
  'icon-128.png',
  'icon-144.png',
  'icon-152.png',
  'icon-192.png',
  'icon-384.png',
  'icon-512.png',
  'icon.svg',
  'apple-touch-icon.png',
  'og-image.png',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  // JS modules
  'analytics-chart.js',
  'lucide.min.js',
  'site-chrome.js',
  // CSS files
  'analytics-chart.css',
  'pages.css',
  'site-chrome.css',
  // Data files
  'data/embassy-abu-dhabi.json',
  'data/embassy-abuja.json',
  'data/embassy-ankara.json',
  'data/embassy-beijing.json',
  'data/embassy-dublin.json',
  'data/embassy-new-delhi.json',
  'data/visa_meta.json',
  'data/visa_decisions.json',
  'data/stamp_1g.json',
  'data/work_permits.json',
  'data/community_timelines.json',
  'data/training_data.json',
];

// Directories to copy recursively
const dirsToCopy = [
  'data',
  'fonts',
  'scripts',
  'styles',
];

async function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied: ${path.relative(rootDir, src)} -> ${path.relative(rootDir, dest)}`);
    return true;
  } else {
    console.warn(`Warning: File not found: ${path.relative(rootDir, src)}`);
    return false;
  }
}

async function copyDir(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
        console.log(`Copied: ${path.relative(rootDir, srcPath)} -> ${path.relative(rootDir, destPath)}`);
      } else {
        console.warn(`Warning: File not found: ${path.relative(rootDir, srcPath)}`);
      }
    }
  }
}

function buildCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// Keep the checked-in page modular for local development, but serve a single
// stylesheet and script in production. This removes 35 render/fetch requests
// from the tracker's first load without adding a framework or bundler.
function bundleIndexAssets() {
  const indexPath = path.resolve(distDir, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const cssFiles = [];
  let cssInserted = false;
  html = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi, (tag) => {
    const match = tag.match(/\bhref="([^"]+)"/i);
    const file = localDistPath(match && match[1]);
    if (!file || !fs.existsSync(file)) return tag;
    cssFiles.push(file);
    if (cssInserted) return '';
    cssInserted = true;
    return '<link rel="stylesheet" href="/styles/index-bundle.css">';
  });
  if (cssFiles.length) {
    fs.writeFileSync(
      path.resolve(distDir, 'styles', 'index-bundle.css'),
      cssFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    );
  }

  const scriptFiles = [];
  let scriptInserted = false;
  html = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/gi, (tag, href) => {
    const file = localDistPath(href);
    if (!file || !fs.existsSync(file)) return tag;
    scriptFiles.push(file);
    if (scriptInserted) return '';
    scriptInserted = true;
    return '<script src="/scripts/index-bundle.js" defer></script>';
  });
  if (scriptFiles.length) {
    fs.writeFileSync(
      path.resolve(distDir, 'scripts', 'index-bundle.js'),
      scriptFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n;\n')
    );
  }
  fs.writeFileSync(indexPath, html);
  console.log(`Bundled ${cssFiles.length} stylesheets and ${scriptFiles.length} scripts for index.html`);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function formatLongDate(iso) {
  const parts = String(iso || '').slice(0, 10).split('-');
  const month = MONTHS[Number(parts[1]) - 1];
  if (parts.length !== 3 || !month) return '';
  return `${Number(parts[2])} ${month} ${parts[0]}`;
}

function summarizeByDate(rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || !row[0]) continue;
    const date = String(row[0]).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { total: 0, approved: 0, refused: 0 });
    const bucket = byDate.get(date);
    bucket.total += 1;
    if (/^approved/i.test(String(row[2]))) bucket.approved += 1;
    else bucket.refused += 1;
  }
  return byDate;
}

function replaceFields(html, attribute, values) {
  const re = new RegExp(`(<([a-z0-9]+)[^>]*\\b${attribute}="([^"]+)"[^>]*>)[\\s\\S]*?(</\\2>)`, 'gi');
  return html.replace(re, (match, open, tag, key, close) =>
    Object.prototype.hasOwnProperty.call(values, key) ? open + values[key] + close : match);
}

const REPORT_HISTORY_LIMIT = 8;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => HTML_ESCAPES[char]);

function httpUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    return new URL(raw).href;
  } catch {
    return '';
  }
}

function loadReportArchive(assetsRoot) {
  const file = path.resolve(assetsRoot, 'data', 'reports', 'index.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.warn('Warning: data/reports/index.json is not valid JSON; keeping office report-history fallbacks');
    return null;
  }
}

function summarizeOfficeDecisions(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row && row.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDate.has(date)) byDate.set(date, { total: 0, approved: 0, refused: 0 });
    const bucket = byDate.get(date);
    bucket.total += 1;
    if (/^approved/i.test(String(row.decision || ''))) bucket.approved += 1;
    else bucket.refused += 1;
  }
  return byDate;
}

function loadOfficeDecisionSummary(assetsRoot, slug) {
  const file = path.resolve(assetsRoot, 'data', `embassy-${slug}.json`);
  if (!fs.existsSync(file)) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return summarizeOfficeDecisions(parsed && parsed.decisions);
  } catch {
    console.warn(`Warning: data/embassy-${slug}.json is not valid JSON; using archive counts without row outcomes`);
    return new Map();
  }
}

/**
 * Rows for the office page's report-history table, newest first.
 *
 * The report index supplies report-specific outcomes where they were recorded.
 * The manifest's archive_reports supplies every archived report date, including
 * older reports whose outcomes are absent from the report index. For those
 * dates, approved/refused counts come from the office's own decision file,
 * grouped by report-period date. A date links to a report permalink only when
 * that permalink exists in the report index. Consecutive entries with the same
 * counts and source are one unchanged snapshot checked again (Dublin's list)
 * and are collapsed into one row.
 */
function reportHistoryHtml(office, reports, decisionSummary = new Map()) {
  const entries = reports && reports.offices && Array.isArray(reports.offices[office.slug])
    ? reports.offices[office.slug]
    : [];
  const indexed = new Map();
  for (const entry of entries) {
    if (!entry || !/^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || ''))) continue;
    indexed.set(String(entry.report_date).slice(0, 10), entry);
  }

  const archived = new Map();
  for (const report of Array.isArray(office.archive_reports) ? office.archive_reports : []) {
    if (!report || !/^\d{4}-\d{2}-\d{2}/.test(String(report.report_date || ''))) continue;
    const date = String(report.report_date).slice(0, 10);
    if (!archived.has(date)) archived.set(date, report);
  }

  const dates = [...new Set([...indexed.keys(), ...archived.keys()])]
    .sort((a, b) => b.localeCompare(a));
  const rows = [];
  let previous = '';
  for (const date of dates) {
    const report = indexed.get(date);
    const archiveReport = archived.get(date);
    const summary = decisionSummary.get(date);
    const decisions = Math.max(0,
      Number(report && report.decisions) ||
      Number(archiveReport && archiveReport.decisions) ||
      Number(summary && summary.total) || 0);

    let approved = report ? Number(report.approved) : NaN;
    let refused = report ? Number(report.refused) : NaN;
    let hasOutcomes = Boolean(report) && Number.isFinite(approved) && Number.isFinite(refused) &&
      (approved + refused > 0 || decisions === 0);
    if (!hasOutcomes && summary) {
      approved = Math.max(0, Number(summary.approved) || 0);
      refused = Math.max(0, Number(summary.refused) || 0);
      hasOutcomes = true;
    }
    if (!Number.isFinite(approved)) approved = 0;
    if (!Number.isFinite(refused)) refused = 0;

    const sourceFile = String(
      (report && (report.source_file || report.source_url)) ||
      (archiveReport && (archiveReport.source_file || archiveReport.source_url)) ||
      (date === String(office.report_date || '').slice(0, 10) ? office.source_file : '') ||
      ''
    );
    const row = {
      reportDate: date,
      decisions,
      approved: Math.max(0, approved),
      refused: Math.max(0, refused),
      sourceFile,
      hasReportPage: Boolean(report),
      hasOutcomes,
    };
    const key = [
      row.decisions, row.approved, row.refused, row.sourceFile, row.hasReportPage, row.hasOutcomes,
    ].join('|');
    if (key === previous) continue;
    previous = key;
    rows.push(row);
    if (rows.length >= REPORT_HISTORY_LIMIT) break;
  }

  // An office missing from both public archives still gets its latest manifest report.
  if (!rows.length && /^\d{4}-\d{2}-\d{2}/.test(String(office.report_date || ''))) {
    const reportDate = String(office.report_date).slice(0, 10);
    rows.push({
      reportDate,
      decisions: Math.max(0, Number(office.decisions) || 0),
      approved: Math.max(0, Number(office.approved) || 0),
      refused: Math.max(0, Number(office.refused) || 0),
      sourceFile: String(office.source_file || office.source_url || ''),
      hasReportPage: indexed.has(reportDate),
      hasOutcomes: Number.isFinite(Number(office.approved)) && Number.isFinite(Number(office.refused)),
    });
  }

  if (!rows.length) return '<tr><td colspan="6">No dated reports are recorded yet.</td></tr>';

  return rows.map((row) => {
    const rate = row.hasOutcomes && row.decisions
      ? `${((row.approved / row.decisions) * 100).toFixed(1)}%`
      : '—';
    const href = httpUrl(row.sourceFile) || httpUrl(office.source_url);
    const source = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Official source</a>`
      : '—';
    const dateCell = row.hasReportPage
      ? `<a href="/reports/${office.slug}/${row.reportDate}"><time datetime="${row.reportDate}">${escapeHtml(formatLongDate(row.reportDate))}</time></a>`
      : `<time datetime="${row.reportDate}">${escapeHtml(formatLongDate(row.reportDate))}</time>`;
    return `<tr><td>${dateCell}</td>` +
      `<td>${row.decisions.toLocaleString('en-IE')}</td>` +
      `<td>${row.approved.toLocaleString('en-IE')}</td>` +
      `<td>${row.refused.toLocaleString('en-IE')}</td>` +
      `<td>${rate}</td>` +
      `<td>${source}</td></tr>`;
  }).join('\n            ');
}

/**
 * The home page and daily summaries are static HTML. Write the latest New
 * Delhi count and report date into that text at build time so readers without
 * JavaScript - and AI tools that do not execute it - see the same fresh
 * figures as the dashboard. The checked-in HTML carries the same sentence as
 * a fallback for local development.
 */
function injectLiveSummary() {
  const metaPath = path.resolve(assetsRootDir, 'data', 'visa_meta.json');
  if (!fs.existsSync(metaPath)) return;
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    console.warn('Warning: visa_meta.json is not valid JSON; keeping static summary text');
    return;
  }
  if (!meta || typeof meta.sheetRows !== 'number' || !meta.fileDate) return;

  const fileDate = formatLongDate(meta.fileDate);
  if (!fileDate) return;
  const checked = formatLongDate(meta.lastRunAt) || fileDate;
  const count = meta.sheetRows.toLocaleString('en-IE');
  const summary = `${count} New Delhi decisions on record. Latest list: ${fileDate}. Checked ${checked}.`;

  for (const page of ['index.html', 'daily-summaries.html']) {
    const file = path.resolve(distDir, page);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8').replace(
      /(<p[^>]*data-live-summary[^>]*>)[\s\S]*?(<\/p>)/,
      `$1${summary}$2`
    );
    fs.writeFileSync(file, html);
  }

  // Keep the daily summaries freshness line fresh for no-JavaScript readers too.
  const dailyPath = path.resolve(distDir, 'daily-summaries.html');
  if (fs.existsSync(dailyPath)) {
    const iso = String(meta.lastRunAt || meta.fileDate).slice(0, 10);
    const daily = fs.readFileSync(dailyPath, 'utf8')
      .replace(/(<time id="visa-as-of" datetime=")[^"]*(">)[\s\S]*?(<\/time>)/, `$1${iso}$2${checked}$3`)
      .replace(/(<span id="visa-rows">)[\s\S]*?(<\/span>)/, `$1${count}$2`);
    fs.writeFileSync(dailyPath, daily);
  }

  console.log(`Live summary: ${summary}`);
}

export function injectOfficePages(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const manifestPath = path.resolve(assetsRoot, 'data', 'data_manifest.json');
  if (!fs.existsSync(manifestPath)) return;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    console.warn('Warning: data_manifest.json is not valid JSON; keeping office fallbacks');
    return;
  }
  if (!Array.isArray(manifest.offices)) return;

  const reports = loadReportArchive(assetsRoot);

  const decisionsPath = path.resolve(assetsRoot, 'data', 'visa_decisions.json');
  let visaRows = [];
  if (fs.existsSync(decisionsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
      if (Array.isArray(parsed)) visaRows = parsed;
    } catch {
      console.warn('Warning: visa_decisions.json is not valid JSON; using manifest counts');
    }
  }

  const byDate = summarizeByDate(visaRows);
  const allDates = [...byDate.keys()].sort();

  for (const office of manifest.offices) {
    const file = `${office.slug}-visa-decisions.html`;
    const pagePath = path.resolve(dist, file);
    if (!fs.existsSync(pagePath)) continue;
    const decisionSummary = loadOfficeDecisionSummary(assetsRoot, office.slug);

    const decisions = Number(office.decisions) || 0;
    const approved = Number(office.approved) || 0;
    const refused = Number(office.refused) || 0;
    const approvalShare = decisions ? `${((approved / decisions) * 100).toFixed(1)}%` : '0.0%';
    const refusedShare = decisions ? `${((refused / decisions) * 100).toFixed(1)}%` : '0.0%';
    const latest = formatLongDate(office.report_date);
    const checked = formatLongDate(office.as_of || office.fetched_at);
    const reportCount = Array.isArray(office.archive_reports) && office.archive_reports.length
      ? office.archive_reports.length
      : 1;
    const isSnapshot = office.slug === 'beijing' || office.slug === 'dublin';
    const history = office.slug === 'new-delhi'
      ? `${allDates.length} published days`
      : isSnapshot ? 'the latest snapshot' : `${reportCount} weekly reports`;
    const archiveTotal = Number(office.archive_decisions) || decisions;
    const firstHistoryDate = allDates.length ? formatLongDate(allDates[0]) : '';
    const archive = office.slug === 'new-delhi'
      ? `${allDates.length} published days${firstHistoryDate ? ` from ${firstHistoryDate}` : ''}`
      : isSnapshot
        ? `1 snapshot · ${archiveTotal.toLocaleString('en-IE')} decisions`
        : `${reportCount} weekly reports · ${archiveTotal.toLocaleString('en-IE')} decisions`;

    const fields = {
      'latest-date': latest,
      'checked-date': checked,
      decisions: decisions.toLocaleString('en-IE'),
      approved: approved.toLocaleString('en-IE'),
      refused: refused.toLocaleString('en-IE'),
      'approval-share': approvalShare,
      'refused-share': refusedShare,
      history,
      archive,
    };

    if (office.slug === 'new-delhi' && byDate.size) {
      const eligible = allDates.filter((date) => date <= String(office.report_date).slice(0, 10));
      const latestDay = eligible[eligible.length - 1];
      if (latestDay) {
        const bucket = byDate.get(latestDay);
        fields['latest-day'] = `${formatLongDate(latestDay)}: ${bucket.total.toLocaleString('en-IE')} decisions ` +
          `(${bucket.approved.toLocaleString('en-IE')} approved, ${bucket.refused.toLocaleString('en-IE')} refused)`;

        // The official file date is the cutoff for the latest published file.
        // New Delhi rows can exist after that date; show them separately and
        // label them as a partial tracker day rather than calling them the
        // latest official-file day.
        const trackerLatestDay = allDates[allDates.length - 1];
        const trackerBucket = trackerLatestDay ? byDate.get(trackerLatestDay) : null;
        const officialDate = String(latestDay).slice(0, 10);
        fields['tracker-latest'] = trackerLatestDay && trackerLatestDay > officialDate && trackerBucket
          ? `${formatLongDate(trackerLatestDay)}: ${trackerBucket.total.toLocaleString('en-IE')} decisions ` +
            `(${trackerBucket.approved.toLocaleString('en-IE')} approved, ${trackerBucket.refused.toLocaleString('en-IE')} refused; ` +
            `partial day, not in the ${formatLongDate(latestDay)} official file)`
          : 'No later tracker rows beyond the latest official file.';
      }
    }

    let html = replaceFields(fs.readFileSync(pagePath, 'utf8'), 'data-office', fields);
    html = replaceFields(html, 'data-report-history', {
      [office.slug]: reportHistoryHtml(office, reports, decisionSummary),
    });

    if (office.source_file) {
      html = html.replace(
        /(<a[^>]*data-office="source-file"[^>]*href=")[^"]*(")/i,
        (match, open, close) => open + String(office.source_file).replace(/"/g, '&quot;') + close,
      );
    }
    if (office.as_of) {
      html = html.replace(/"dateModified":\s*"\d{4}-\d{2}-\d{2}"/g, `"dateModified": "${String(office.as_of).slice(0, 10)}"`);
    }
    fs.writeFileSync(pagePath, html);
  }
  console.log('Office pages: injected latest manifest data.');
}

function injectDailyToday() {
  const decisionsPath = path.resolve(assetsRootDir, 'data', 'visa_decisions.json');
  const metaPath = path.resolve(assetsRootDir, 'data', 'visa_meta.json');
  const pagePath = path.resolve(distDir, 'daily-summaries.html');
  if (!fs.existsSync(decisionsPath) || !fs.existsSync(pagePath)) return;
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(rows) || !rows.length) return;
  const byDate = summarizeByDate(rows);
  if (!byDate.size) return;
  let cutoff = '';
  if (fs.existsSync(metaPath)) {
    try {
      cutoff = String(JSON.parse(fs.readFileSync(metaPath, 'utf8')).fileDate || '').slice(0, 10);
    } catch {
      cutoff = '';
    }
  }
  const eligibleDates = [...byDate.keys()].filter((date) => !cutoff || date <= cutoff).sort();
  const latest = eligibleDates[eligibleDates.length - 1];
  if (!latest) return;
  const bucket = byDate.get(latest);
  const html = replaceFields(fs.readFileSync(pagePath, 'utf8'), 'data-today', {
    date: formatLongDate(latest),
    total: bucket.total.toLocaleString('en-IE'),
    approved: bucket.approved.toLocaleString('en-IE'),
    refused: bucket.refused.toLocaleString('en-IE'),
  });
  fs.writeFileSync(pagePath, html);
  console.log(`Daily summary: latest day ${latest} (${bucket.total} decisions).`);
}

function localDistPath(href) {
  if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('data:')) return null;
  const pathname = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^\/+/, '');
  return path.resolve(distDir, pathname);
}

async function main() {
  console.log('Building for Cloudflare Pages...');
  
  // Clean and create .pages-dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  
  // Copy individual files
  let copied = 0;
  for (const file of assetsToCopy) {
    const src = path.resolve(assetsRootDir, file);
    const dest = path.resolve(distDir, file);
    if (fs.existsSync(src)) {
      await copyFile(src, dest);
      copied++;
    } else {
      console.warn(`Warning: File not found: ${file}`);
    }
  }
  
  // Record exactly which commit this tree represents. The post-deploy
  // verifier waits for this marker before comparing the live assets.
  fs.writeFileSync(
    path.resolve(distDir, 'build-info.json'),
    JSON.stringify({ commit: buildCommit(), built_at: new Date().toISOString() }, null, 2) + '\n'
  );

  // Cloudflare reserves /404.html and redirects it to /404. Keep that file
  // for Pages' own fallback, and publish an internal copy the Worker can
  // fetch without triggering the reserved-path redirect.
  if (await copyFile(path.resolve(assetsRootDir, '404.html'), path.resolve(distDir, '404-internal.html'))) {
    copied++;
  }

  // Copy directories
  for (const dir of dirsToCopy) {
    const src = path.resolve(assetsRootDir, dir);
    const dest = path.resolve(distDir, dir);
    if (fs.existsSync(src)) {
      await copyDir(src, dest);
    } else {
      console.warn(`Warning: Directory not found: ${dir}`);
    }
  }

  injectLiveSummary();
  injectOfficePages();
  injectDailyToday();
  bundleIndexAssets();
  
  const fallback = buildSearchFallback({
    dataDir: path.resolve(assetsRootDir, 'data'),
    manifestPath: path.resolve(assetsRootDir, 'data', 'data_manifest.json'),
    outFile: path.resolve(distDir, 'data', 'search_fallback.json')
  });
  console.log(`Search fallback: ${fallback.rows} rows (${(fallback.bytes / 1024 / 1024).toFixed(2)} MiB)`);

  console.log(`Build complete! Copied ${copied} files to ${outDir}`);
  console.log(`Output directory: ${distDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}