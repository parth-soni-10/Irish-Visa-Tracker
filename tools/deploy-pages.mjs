/**
 * Deploy Pages Build Script
 * Builds the static assets and copies them to .pages-dist for Cloudflare Pages deployment
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildSearchFallback } from './build-search-fallback.mjs';
import { buildSearchPreview } from './build-search-preview.mjs';
import { buildInsightPages } from './insight-pages.mjs';
import { buildGrowthPages } from './growth-pages.mjs';
import { buildMonthlyPages } from './monthly-pages.mjs';
import { buildSocialCards } from './social-cards.mjs';
import { buildLastmodMap, updateSitemap } from './sitemap-lastmod.mjs';
import { splitSitemap } from './sitemap-index.mjs';
import { officeAnalysis, officeAnalysisHtml } from './office-analysis.mjs';
import { injectDailyRecent } from './daily-recent.mjs';
import { loadFreshness, writeFreshness, longDate, checkedStamp, timeHTML, SNAPSHOT_OFFICES } from './freshness.mjs';
import { freshnessFooterHTML, freshnessHistoryHTML } from './freshness-ui.mjs';
import { versionAssets } from './version-assets.mjs';
import { auditDiscovery } from './audit-discovery.mjs';
import { OFFICE_SEO } from './office-seo.mjs';

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
  'vfs-tracking.html',
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
  'monthly-report.html',
  'all-pages.html',
  'after-approval.html',
  'after-refusal.html',
  'missing-decision.html',
  'find-my-office.html',
  'bulk-tools.html',
  'decisions.html',
  'search-coverage.html',

  'stamp-1g-processing-dates.html',
  'visa-processing-times.html',
  '_headers',
  '_redirects',
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
  '5ba7cee4d0b7816bb7950443892c3b7d.txt',
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  // JS modules
  'analytics-chart.js',
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
  'assets',
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

import { SITE_ORIGIN, DEFAULT_SITE_ORIGIN } from './site-config.mjs';

/** Rewrite every generated public URL when a custom origin is configured. */
function rewriteSiteOrigin() {
  if (SITE_ORIGIN === DEFAULT_SITE_ORIGIN) return;
  const extensions = new Set(['.html', '.xml', '.txt', '.js', '.css', '.md']);
  let changed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const before = fs.readFileSync(file, 'utf8');
      const defaultHost = new URL(DEFAULT_SITE_ORIGIN).host;
      const nextHost = new URL(SITE_ORIGIN).host;
      const after = before
        .split(DEFAULT_SITE_ORIGIN).join(SITE_ORIGIN)
        .split(`webcal://${defaultHost}`).join(`webcal://${nextHost}`);
      if (after !== before) {
        fs.writeFileSync(file, after);
        changed += 1;
      }
    }
  };
  walk(distDir);
  console.log(`Site origin: rewrote ${changed} generated file(s) to ${SITE_ORIGIN}.`);
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

// Office, Today and the daily summaries linked two small stylesheets, so the
// document laid out once while the CSS was in flight and again after it landed,
// and the font request could not start until the CSS had been parsed. Inlining
// both sheets and preloading the one webfont they use removes that pass.
// Measured on the throttled mobile profile (1.6 Mbps, 150 ms RTT, 4x CPU):
// office LCP 2140 -> 1288 ms, Today 1904 -> 1100 ms, daily summaries
// 1424 -> 916 ms, a date page 1352 -> 884 ms.
//
// The CSP refuses inline <style> elements, so the build hashes the exact text it
// inlines and writes functions/_csp-inline-style.js; the router adds that one
// source to style-src-elem. Every targeted page must inline identical text, or
// the hash cannot match and that page would render unstyled.
const INLINE_STYLE_PAGES = [
  /^[a-z0-9-]+-visa-decisions\.html$/,
  /^irish-visa-decisions-today\.html$/,
  /^daily-summaries\.html$/,
  /^(about|contact|privacy|terms)\.html$/,
];

const INLINE_STYLE_MODULE = path.resolve(rootDir, 'functions', '_csp-inline-style.js');

function inlineStyleHash(css) {
  return 'sha256-' + createHash('sha256').update(css, 'utf8').digest('base64');
}

/** The homepage and the content pages inline different stylesheet text, so the
 *  CSP has to allow both hashes; the router adds each one as a quoted source. */
function writeInlineStyleHashes(hashes) {
  const list = [...new Set(hashes.filter(Boolean))].sort();
  const source = '// Generated by tools/deploy-pages.mjs from the stylesheet text it inlines\n' +
    '// into the content pages and the homepage. Do not edit by hand; the build\n' +
    '// rewrites it.\n' +
    `export const INLINE_STYLE_SHA256S = ${JSON.stringify(list)};\n`;
  if (!fs.existsSync(INLINE_STYLE_MODULE) || fs.readFileSync(INLINE_STYLE_MODULE, 'utf8') !== source) {
    fs.writeFileSync(INLINE_STYLE_MODULE, source);
  }
  return list;
}

function inlineContentPageStyles() {
  const sheets = new Map();
  for (const name of ['pages.css', 'site-chrome.css']) {
    const file = path.resolve(distDir, name);
    if (fs.existsSync(file)) sheets.set(name, fs.readFileSync(file, 'utf8'));
  }
  if (!sheets.size) return 0;

  const sheetFor = (tag) => {
    const href = (tag.match(/\bhref="([^"]+)"/i) || [])[1] || '';
    return sheets.get(href.split('?')[0].replace(/^\//, '')) || null;
  };
  const isStylesheetLink = (tag) => /\brel="stylesheet"/i.test(tag) && sheetFor(tag);

  const targets = [];
  for (const name of fs.readdirSync(distDir)) {
    if (name.endsWith('.html') && INLINE_STYLE_PAGES.some((pattern) => pattern.test(name))) {
      targets.push(path.resolve(distDir, name));
    }
  }
  const decisionsDir = path.resolve(distDir, 'decisions');
  if (fs.existsSync(decisionsDir)) {
    for (const name of fs.readdirSync(decisionsDir)) {
      if (/^[0-9-]+\.html$/.test(name)) targets.push(path.resolve(decisionsDir, name));
    }
  }

  let canonical = null;
  let inlined = 0;
  for (const file of targets) {
    const html = fs.readFileSync(file, 'utf8');
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => match[0]).filter(isStylesheetLink);
    if (!links.length) continue;
    // The comments and indentation that make the shared sheets readable would
    // ride along in every page, so the copy that ships in the document is
    // stripped of them; the standalone files keep their comments.
    // Line endings are normalised to LF because the browser parses the style
    // text that way; a Windows checkout would otherwise hash CRLF and the CSP
    // hash would not match.
    const css = links.map(sheetFor).join('\n')
      .replace(/\r\n?/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\n[ \t]+/g, '\n');
    if (canonical === null) canonical = css;
    if (css !== canonical) {
      throw new Error(`${path.basename(file)}: inlined styles differ from the other content pages, so the CSP hash would not match`);
    }
    const fontUrl = (css.match(/url\('?([^')]*inter-latin\.woff2[^')]*)'?\)/) || [])[1];
    const replacement = (fontUrl
      ? `<link rel="preload" href="${fontUrl}" as="font" type="font/woff2" crossorigin>\n`
      : '') + `<style>${css}</style>`;
    let inserted = false;
    const next = html.replace(/<link\b[^>]*>/gi, (tag) => {
      if (!isStylesheetLink(tag)) return tag;
      if (inserted) return '';
      inserted = true;
      return replacement;
    });
    fs.writeFileSync(file, next);
    inlined += 1;
  }
  return { pages: inlined, hash: canonical !== null ? inlineStyleHash(canonical) : null };
}

/**
 * The homepage links one ~200 KiB stylesheet bundle. Inlining it removes the
 * last render-blocking request from the page that carries the traffic: the
 * combined brotli payload is unchanged (HTML and CSS compress to the same
 * total either way), and the browser no longer waits a round trip for the CSS
 * before first paint. The bundle file stays on disk because an HTML copy that
 * a browser or edge cached just before this deploy still references it.
 */
function inlineIndexStyles() {
  const pagePath = path.resolve(distDir, 'index.html');
  const bundlePath = path.resolve(distDir, 'styles', 'index-bundle.css');
  if (!fs.existsSync(pagePath) || !fs.existsSync(bundlePath)) return null;
  const html = fs.readFileSync(pagePath, 'utf8');
  const linkPattern = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/styles\/index-bundle\.css(?:\?[^"]*)?"[^>]*>/i;
  if (!linkPattern.test(html)) return null;
  const css = fs.readFileSync(bundlePath, 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n[ \t]+/g, '\n');
  if (/<\/style/i.test(css)) {
    throw new Error('index-bundle.css contains a closing </style> sequence and cannot be inlined');
  }
  fs.writeFileSync(pagePath, html.replace(linkPattern, `<style>${css}</style>`));
  return { hash: inlineStyleHash(css), bytes: Buffer.byteLength(css, 'utf8') };
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

function replaceMetaContent(html, attribute, value) {
  const pattern = new RegExp(`(<meta ${attribute} content=")[^"]*(")`, 'i');
  return html.replace(pattern, (match, open, close) => open + escapeHtml(value) + close);
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
      ? `<a href="/reports/${office.slug}/${row.reportDate}"><time datetime="${row.reportDate}">${escapeHtml(longDate(row.reportDate))}</time></a>`
      : `<time datetime="${row.reportDate}">${escapeHtml(longDate(row.reportDate))}</time>`;
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
export function injectLiveSummary(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  // visa_meta.fileDate is null on a weekend/holiday run (the scraper
  // deliberately preserves the last file date), which used to leave the
  // checked-in "19 November / checked 20 November" sentence frozen in the
  // build. Read the manifest instead: it carries the report date, the count
  // and the actual fetch time for every office.
  const freshness = loadFreshness(assetsRoot);
  const office = freshness.bySlug['new-delhi'];
  if (!office || !office.report_date) return;

  const fileDate = longDate(office.report_date);
  const checked = office.checked_at ? timeHTML(office.checked_at) : fileDate;
  // Plain text for the <time> element itself: timeHTML() already returns a
  // complete <time> element, so nesting it inside #visa-as-of appended one
  // stray </time> per build.
  const checkedText = office.checked_label || fileDate;
  const count = office.decisions.toLocaleString('en-IE');
  const through = longDate(office.official_data_through);
  const observation = office.observation_note ? ` ${office.observation_note}` : '';
  const summary = `${count} New Delhi decisions in the latest official file (report ${fileDate}` +
    (through && through !== fileDate ? `; official decisions dated through ${through}` : '') +
    `). Checked ${checked}.${observation}`;

  for (const page of ['index.html', 'daily-summaries.html']) {
    const file = path.resolve(dist, page);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8').replace(
      /(<p[^>]*data-live-summary[^>]*>)[\s\S]*?(<\/p>)/,
      `$1${summary}$2`
    );
    fs.writeFileSync(file, html);
  }

  // Keep the daily summaries freshness line fresh for no-JavaScript readers too.
  const dailyPath = path.resolve(dist, 'daily-summaries.html');
  if (fs.existsSync(dailyPath)) {
    const iso = String(office.checked_at || office.report_date).slice(0, 10);
    const daily = fs.readFileSync(dailyPath, 'utf8')
      .replace(/(<time id="visa-as-of" datetime=")[^"]*(">)[\s\S]*?(<\/time>)/, `$1${iso}$2${checkedText}$3`)
      .replace(/(<span id="visa-rows">)[\s\S]*?(<\/span>)/, `$1${count}$2`);
    fs.writeFileSync(dailyPath, daily);
  }

  console.log(`Live summary: ${summary}`);
}

/** The date in Dublin, so a build near midnight UTC does not label the
 *  homepage with yesterday's date. */
function dublinTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Write the "as of today" line into the homepage. The title now says
 * "today"; the line states which official publication is newest and whether
 * any office published a newer file today, so the claim is checkable rather
 * than an undated freshness badge.
 */
export function injectTodayLine(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'index.html');
  if (!fs.existsSync(pagePath)) return;
  const freshness = loadFreshness(assetsRoot);
  const dates = freshness.offices
    .map((office) => String(office.report_date || '').slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const latest = dates[dates.length - 1];
  if (!latest) return;
  const today = dublinTodayISO();
  const copy = latest === today
    ? `As of ${longDate(today)}, an official decision file dated today has been published.`
    : `As of ${longDate(today)}, the newest official office publication is dated ${longDate(latest)}. No office has published a newer decision file today.`;
  const html = fs.readFileSync(pagePath, 'utf8').replace(
    /(<p[^>]*data-today-line[^>]*>)[\s\S]*?(<\/p>)/,
    `$1${copy}$2`,
  );
  fs.writeFileSync(pagePath, html);
  console.log(`Today line: ${copy}`);
}

/**
 * Homepage search snippet. "ireland visa decisions today" is the query with
 * the most impressions and it currently lands on `/`, so the snippet has to
 * state the newest official file date and its decision count; a generic
 * "search all 6 offices" title gives a searcher nothing to click. The same
 * figures are also the India-first entry point, because New Delhi is the file
 * that query is about.
 */
export function injectHomepageSeo(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'index.html');
  if (!fs.existsSync(pagePath)) return;
  const office = loadFreshness(assetsRoot).bySlug['new-delhi'];
  if (!office || !office.report_date) return;
  const decisions = Number(office.decisions) || 0;
  if (!decisions) return;

  const reportDate = String(office.report_date).slice(0, 10);
  const short = checkedStamp(reportDate) || longDate(reportDate);
  const count = decisions.toLocaleString('en-IE');
  const approved = (Number(office.approved) || 0).toLocaleString('en-IE');
  const refused = (Number(office.refused) || 0).toLocaleString('en-IE');
  // "ireland visa decisions", "ireland visa decisions today" and "ireland visa
  // decision new delhi" already sit on page one at a ~2% CTR, so the snippet
  // leads with the query word ("Ireland", not only "Irish"), keeps the count
  // and file date that no official page states, and stays inside the ~60
  // characters a desktop result shows before it truncates.
  const title = `Ireland Visa Decisions Today: ${count} Decided (${short})`;
  const description = `Ireland visa decisions, ${longDate(reportDate)}: ${count} decided in the latest New Delhi file — ${approved} approved, ${refused} refused. Search an application number.`;
  const indiaLine = `<strong>India:</strong> <a href="/new-delhi-visa-decisions">New Delhi Irish visa decisions</a> — latest official file ${longDate(reportDate)}, ${count} decisions.`;

  let html = fs.readFileSync(pagePath, 'utf8');
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);
  html = replaceMetaContent(html, 'name="description"', description);
  html = replaceMetaContent(html, 'property="og:title"', title);
  html = replaceMetaContent(html, 'property="og:description"', description);
  html = replaceMetaContent(html, 'name="twitter:title"', title);
  html = replaceMetaContent(html, 'name="twitter:description"', description);
  html = html.replace(
    /(<p[^>]*data-india-line[^>]*>)[\s\S]*?(<\/p>)/,
    `$1${indiaLine}$2`,
  );
  fs.writeFileSync(pagePath, html);
  console.log(`Homepage snippet: ${title}`);
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
  const freshness = loadFreshness(assetsRoot);

  const decisionsPath = path.resolve(assetsRoot, 'data', 'visa_decisions.json');
  let visaRows = [];
  if (fs.existsSync(decisionsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
      // Notice rows such as "NO_FILE_2026-11-21 — Visa Office is closed" are
      // not decisions. Counting one as a published day made the office page
      // claim 129 days of history and a 21 Nov decision date.
      if (Array.isArray(parsed)) {
        visaRows = parsed.filter((row) => Array.isArray(row) && /^(approved|refused)$/i.test(String(row[2] || '').trim()));
      }
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
    const canonical = freshness.bySlug[office.slug];

    const decisions = canonical ? canonical.decisions : Number(office.decisions) || 0;
    const approved = canonical ? canonical.approved : Number(office.approved) || 0;
    const refused = canonical ? canonical.refused : Number(office.refused) || 0;
    const approvalShare = decisions ? `${((approved / decisions) * 100).toFixed(1)}%` : '0.0%';
    const refusedShare = decisions ? `${((refused / decisions) * 100).toFixed(1)}%` : '0.0%';
    const latest = longDate(canonical ? canonical.report_date : office.report_date);
    const isSnapshot = canonical ? canonical.snapshot : SNAPSHOT_OFFICES.has(office.slug);
    const checked = canonical
      ? checkedStamp(canonical.checked_at) || latest
      : longDate(office.as_of || office.fetched_at);
    const successLabel = canonical
      ? canonical.last_success_label || checkedStamp(canonical.checked_at) || latest
      : checked;
    const attemptLabel = canonical
      ? canonical.last_attempt_label || checkedStamp(canonical.last_attempt_at) || successLabel
      : successLabel;
    const attemptIsLater = Boolean(canonical && canonical.last_attempt_at && canonical.last_success_at &&
      Date.parse(canonical.last_attempt_at) > Date.parse(canonical.last_success_at));
    const checkFailure = canonical && canonical.warning ? ` (${escapeHtml(canonical.warning)})` : '';
    const checkCopy = canonical && canonical.status === 'error'
      ? (attemptIsLater
        ? `The last successful check on ${escapeHtml(successLabel)} found no newer decision-file link than the ${escapeHtml(latest)} snapshot. The tracker's latest check on ${escapeHtml(attemptLabel)} failed${checkFailure}, so this snapshot may be older than the office's current file. That does not mean no decisions have been made since; it means the tracker has not yet found a newer published file.`
        : `The last successful check on ${escapeHtml(successLabel)} found no newer decision-file link than the ${escapeHtml(latest)} snapshot. The tracker's latest check failed${checkFailure}, so this snapshot may be older than the office's current file. That does not mean no decisions have been made since; it means the tracker has not yet found a newer published file.`)
      : `The last check on ${escapeHtml(successLabel)} found no newer decision-file link than the ${escapeHtml(latest)} snapshot. That does not mean no decisions have been made since; it means the tracker has not found a newer published file.`;
    const reportCount = Array.isArray(office.archive_reports) && office.archive_reports.length
      ? office.archive_reports.length
      : 1;
    const history = office.slug === 'new-delhi'
      ? `${allDates.length} days with published decisions`
      : isSnapshot ? 'the latest snapshot' : `${reportCount} weekly reports`;
    const archiveTotal = Number(office.archive_decisions) || decisions;
    const firstHistoryDate = allDates.length ? longDate(allDates[0]) : '';
    const archive = office.slug === 'new-delhi'
      ? `${allDates.length} days with published decisions${firstHistoryDate ? `, from ${firstHistoryDate}` : ''}`
      : isSnapshot
        ? `1 snapshot · ${archiveTotal.toLocaleString('en-IE')} decisions`
        : `${reportCount} weekly reports · ${archiveTotal.toLocaleString('en-IE')} decisions`;

    const checkedHTML = canonical
      ? timeHTML(canonical.last_success_at || canonical.checked_at)
      : escapeHtml(checked);
    const fields = {
      'latest-date': latest,
      'checked-date': checkedHTML,
      decisions: decisions.toLocaleString('en-IE'),
      approved: approved.toLocaleString('en-IE'),
      refused: refused.toLocaleString('en-IE'),
      'approval-share': approvalShare,
      'refused-share': refusedShare,
      'check-copy': checkCopy,
      history,
      archive,
    };

    if (office.slug === 'new-delhi' && byDate.size) {
      const eligible = allDates.filter((date) => date <= String(office.report_date).slice(0, 10));
      const latestDay = eligible[eligible.length - 1];
      if (latestDay) {
        const bucket = byDate.get(latestDay);
        fields['latest-day'] = `${longDate(latestDay)}: ${bucket.total.toLocaleString('en-IE')} ${bucket.total === 1 ? 'decision' : 'decisions'} ` +
          `(${bucket.approved.toLocaleString('en-IE')} approved, ${bucket.refused.toLocaleString('en-IE')} refused)`;

        // The official file date is the cutoff for the latest published file.
        // New Delhi rows can exist after that date; show them separately and
        // label them as a partial tracker day rather than calling them the
        // latest official-file day.
        const trackerLatestDay = allDates[allDates.length - 1];
        const trackerBucket = trackerLatestDay ? byDate.get(trackerLatestDay) : null;
        const officialDate = String(latestDay).slice(0, 10);
        fields['tracker-latest'] = trackerLatestDay && trackerLatestDay > officialDate && trackerBucket
          ? `${longDate(trackerLatestDay)}: ${trackerBucket.total.toLocaleString('en-IE')} ${trackerBucket.total === 1 ? 'decision' : 'decisions'} ` +
            `(${trackerBucket.approved.toLocaleString('en-IE')} approved, ${trackerBucket.refused.toLocaleString('en-IE')} refused; ` +
            `partial day, not in the ${latest} official file)`
          : 'No later tracker rows beyond the latest official file.';
      }
    }

    let html = replaceFields(fs.readFileSync(pagePath, 'utf8'), 'data-office', fields);
    html = replaceFields(html, 'data-report-history', {
      [office.slug]: reportHistoryHtml(office, reports, decisionSummary),
    });
    // The analysis section is rebuilt from the whole archived series so an
    // office page never shows a stale cadence or a summed cumulative file.
    const analysis = officeAnalysis(
      office.slug,
      (reports && reports.offices && reports.offices[office.slug]) || [],
      { checkedDate: String(canonical && (canonical.last_success_at || canonical.checked_at) || '').slice(0, 10) },
    );
    html = replaceFields(html, 'data-office-analysis', {
      [office.slug]: officeAnalysisHtml(analysis, { name: office.name }),
    });

    // Every office page gets a current-fact snippet: the named office query,
    // the latest official publication date, the countries covered and the
    // application-number action. New Delhi, Abu Dhabi and Ankara are the first
    // priority for CTR, but the same template keeps all six consistent.
    const seoCoverage = {
      'new-delhi': 'India, Bangladesh, Nepal and Sri Lanka',
      beijing: 'China, Hong Kong, Macau and Mongolia',
      'abu-dhabi': 'the UAE, Afghanistan, Algeria, Bahrain, Jordan, Kuwait, Lebanon, Libya, Morocco, Oman, Qatar, Sudan, Syria and Tunisia',
      abuja: 'Nigeria, Ghana, Côte d’Ivoire and Senegal',
      ankara: 'Türkiye, Azerbaijan and Saudi residents',
      dublin: 'Pakistan and transferred applications',
    }[office.slug] || 'its published applications';
    const officeSeo = OFFICE_SEO[office.slug];
    const seoTitle = (officeSeo && officeSeo.title) || `${office.name} Visa Decisions — Latest ${latest}`;
    const seoDescription = (officeSeo && officeSeo.description) || `Search Irish visa decisions for ${seoCoverage}. Latest official ${isSnapshot ? 'snapshot' : 'report'}: ${latest} — ${decisions.toLocaleString('en-IE')} decisions. Search by application number.`;
    html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(seoTitle)}</title>`);
    html = replaceMetaContent(html, 'property="og:title"', seoTitle);
    html = replaceMetaContent(html, 'name="twitter:title"', seoTitle);
    html = replaceMetaContent(html, 'name="description"', seoDescription);
    html = replaceMetaContent(html, 'property="og:description"', seoDescription);
    html = replaceMetaContent(html, 'name="twitter:description"', seoDescription);

    if (office.source_file) {
      html = html.replace(
        /(<a[^>]*data-office="source-file"[^>]*href=")[^"]*(")/i,
        (match, open, close) => open + String(office.source_file).replace(/"/g, '&quot;') + close,
      );
    }
    // The page changes when its own file is successfully read, not when the
    // shared pipeline last ran. Using the manifest's build date let Beijing
    // claim 21 Nov on a page whose visible last check was 18 Nov.
    const modifiedAt = canonical
      ? String(canonical.last_success_at || canonical.checked_at || canonical.report_date || '').slice(0, 10)
      : String(office.as_of || office.fetched_at || office.report_date || '').slice(0, 10);
    if (modifiedAt) {
      html = html.replace(/"dateModified":\s*"\d{4}-\d{2}-\d{2}"/g, `"dateModified": "${modifiedAt}"`);
    }
    fs.writeFileSync(pagePath, html);
  }
  console.log('Office pages: injected latest manifest data.');
}

/** The homepage's compact latest-report block. One newest dated permalink per
 *  office, next to that office's landing page, outside the hydrating dashboard
 *  so it stays in the initial HTML for readers and crawlers. */
export function injectHomeLatestReports(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'index.html');
  if (!fs.existsSync(pagePath)) return;

  const manifestPath = path.resolve(assetsRoot, 'data', 'data_manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    console.warn('Warning: data_manifest.json is not valid JSON; keeping homepage latest-report fallbacks');
    return;
  }
  if (!Array.isArray(manifest.offices) || !manifest.offices.length) return;

  const reports = loadReportArchive(assetsRoot);
  const rows = manifest.offices.map((office) => {
    const slug = String(office.slug || '');
    const name = String(office.name || slug);
    if (!slug || !name) return '';
    const entries = reports && reports.offices && Array.isArray(reports.offices[slug])
      ? reports.offices[slug]
      : [];
    const dates = entries
      .map((entry) => String(entry && entry.report_date || '').slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort((a, b) => b.localeCompare(a));
    // Only link a permalink this build actually emitted; otherwise the office
    // page is still useful and the row must not become a 404.
    const latest = dates.find((date) =>
      fs.existsSync(path.resolve(dist, 'reports', slug, `${date}.html`)));
    const reportLink = latest
      ? `<a class="latest-official-report" href="/reports/${escapeHtml(slug)}/${latest}"><strong>${escapeHtml(name)}</strong> <time datetime="${latest}">${escapeHtml(longDate(latest))}</time></a>`
      : `<span class="latest-official-report"><strong>${escapeHtml(name)}</strong> <span class="latest-official-missing">No dated report page yet</span></span>`;
    const officeLink = fs.existsSync(path.resolve(dist, `${slug}-visa-decisions.html`))
      ? `<a class="latest-official-office" href="/${escapeHtml(slug)}-visa-decisions">${escapeHtml(name)} decisions</a>`
      : '';
    return `<li data-latest-office="${escapeHtml(slug)}">${reportLink}${officeLink}</li>`;
  }).filter(Boolean);

  if (!rows.length) return;
  const html = fs.readFileSync(pagePath, 'utf8');
  const updated = html.replace(
    /(<ul[^>]*data-latest-official-list[^>]*>)[\s\S]*?(<\/ul>)/i,
    `$1\n        ${rows.join('\n        ')}\n      $2`,
  );
  if (updated === html) return;
  fs.writeFileSync(pagePath, updated);
  console.log(`Homepage latest reports: ${rows.length} office links.`);
}

/** Homepage office cards: the six descriptive anchors already exist, and this
 *  adds the one fact a reader deciding where to click needs - the size and date
 *  of that office's latest published file. Built from freshness.json so the
 *  card cannot disagree with the office page's own header. */
export function injectHomeOfficeCards(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'index.html');
  if (!fs.existsSync(pagePath)) return;
  const freshness = loadFreshness(assetsRoot);
  if (!freshness.offices.length) return;
  let html = fs.readFileSync(pagePath, 'utf8');
  let changed = 0;
  for (const office of freshness.offices) {
    if (!office || !office.slug) continue;
    const route = `/${office.slug}-visa-decisions`;
    if (!fs.existsSync(path.resolve(dist, `${office.slug}-visa-decisions.html`))) continue;
    const decisions = Number(office.decisions) || 0;
    const date = String(office.report_date || '').slice(0, 10);
    if (!decisions || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const label = office.snapshot ? 'snapshot' : 'file';
    const stat = `${decisions.toLocaleString('en-IE')} decisions in the ${longDate(date)} ${label}`;
    const pattern = new RegExp(
      `(<li><a href="${route.replace(/[/-]/g, (char) => `\\${char}`)}"><strong>([^<]+)</strong><span>([^<]*)</span>)</a></li>`,
    );
    if (!pattern.test(html)) continue;
    html = html.replace(pattern, (match, open, name, countries) =>
      `${open}<span class="office-directory-stat">${escapeHtml(stat)}</span></a></li>`);
    changed += 1;
  }
  if (!changed) return;
  fs.writeFileSync(pagePath, html);
  console.log(`Homepage office cards: ${changed} latest-file counts.`);
}

/** The status page's static latest-report table. Kept separate from the
 *  JavaScript coverage table so a no-JS reader still gets the six offices and
 *  one internal link to each office page. */
export function injectLatestReports(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'status.html');
  if (!fs.existsSync(pagePath)) return;
  const freshness = loadFreshness(assetsRoot);
  if (!freshness.offices.length) return;
  const rows = freshness.offices.map((office) => {
    const decisions = Number(office.decisions) || 0;
    const approved = Number(office.approved) || 0;
    const rate = decisions ? `${((approved / decisions) * 100).toFixed(1)}%` : '—';
    const statusLabel = office.status === 'error' ? "Couldn't refresh" :
      office.overdue ? 'Report overdue' : (office.status_label || 'Published');
    const statusClass = office.status_tone ? ` is-${office.status_tone}` : '';
    const statusTitle = office.status === 'error'
      ? office.warning_at_build
      : office.snapshot ? 'This office publishes a live snapshot, not a dated report.'
        : office.warning_at_build;
    const reportDate = String(office.report_date || '').slice(0, 10);
    const officialThrough = String(office.official_data_through || office.report_date || '').slice(0, 10);
    const observedThrough = String(office.observed_data_through || '').slice(0, 10);
    const successAt = office.last_success_at || office.checked_at || '';
    const attemptAt = office.last_attempt_at || freshness.generated_at || successAt;
    const ageNote = [office.age_label_at_build, office.due_short_label].filter(Boolean).join(' · ');
    const observationNote = observedThrough && officialThrough && observedThrough > officialThrough
      ? `<br><span class="small-note" data-observation="tracker">Tracker observed through ${escapeHtml(longDate(observedThrough))} — not in this official file</span>`
      : '';
    const reportLabel = reportDate ? escapeHtml(longDate(reportDate)) : '';
    const missing = ' A decision published after that may not appear in a search yet.';
    let impact;
    if (office.status === 'error') {
      impact = `We couldn't refresh ${office.name} this time.` +
        (reportLabel ? ` The latest official report is ${reportLabel}.` : '') + missing;
    } else if (office.overdue) {
      impact = `The ${office.name} report is overdue` +
        (office.due_at ? ` (expected since ${escapeHtml(longDate(office.due_at))})` : '') + '.' +
        (reportLabel ? ` The latest official report is ${reportLabel}.` : '') + missing;
    } else if (office.stale) {
      impact = `The latest ${office.name} report is ${escapeHtml(office.age_label || 'older than expected')}.` +
        (reportLabel ? ` It is dated ${reportLabel}.` : '') + missing;
    } else if (office.snapshot) {
      impact = 'Live snapshot. A search covers the latest published list.';
    } else {
      impact = 'Current. A search covers the latest official report.';
    }
    const lag = office.observation_lag;
    const lagText = lag && lag.sample_size
      ? `Median ${lag.median_days} day${lag.median_days === 1 ? '' : 's'} (range ${lag.min_days}–${lag.max_days}; ${lag.sample_size} report${lag.sample_size === 1 ? '' : 's'})`
      : 'Not enough observations yet';
    const timeCell = (value, label) => value
      ? `<td data-label="${label}">${timeHTML(value)}</td>`
      : `<td data-label="${label}">—</td>`;
    return `<tr data-freshness-slug="${office.slug}" data-freshness-view="status">` +
      `<td><a href="/${office.slug}-visa-decisions"><strong>${escapeHtml(office.name)}</strong></a><br>` +
      `<span class="status-pill${statusClass}" data-freshness-status${statusTitle ? ` title="${escapeHtml(statusTitle)}"` : ''}>${escapeHtml(statusLabel)}</span></td>` +
      `<td data-label="What this means for your search"><span data-freshness-impact>${escapeHtml(impact)}</span>` +
      (ageNote ? `<br><span class="small-note" data-freshness-age>${escapeHtml(ageNote)}</span>` : '') + `</td>` +
      `<td data-label="Latest official report">${reportDate ? `<time datetime="${reportDate}">${escapeHtml(longDate(reportDate))}</time>` : '—'}${observationNote}</td>` +
      timeCell(successAt, 'Last successful check') +
      `<td data-label="Details"><details><summary>Provenance and counts</summary><dl class="status-details">` +
      `<dt>Official data through</dt><dd>${officialThrough ? escapeHtml(longDate(officialThrough)) : '—'}</dd>` +
      `<dt>Last successful check</dt><dd>${successAt ? timeHTML(successAt) : '—'}</dd>` +
      `<dt>Last attempt</dt><dd>${attemptAt ? timeHTML(attemptAt) : '—'}</dd>` +
      `<dt>Decisions in report</dt><dd>${decisions.toLocaleString('en-IE')}</dd>` +
      `<dt>Approved share</dt><dd>${rate}</dd>` +
      `<dt>Observation lag</dt><dd>${escapeHtml(lagText)}</dd></dl></details></td></tr>`;
  }).join('\n            ');
  let html = fs.readFileSync(pagePath, 'utf8').replace(
    /(<tbody[^>]*data-latest-reports[^>]*>)[\s\S]*?(<\/tbody>)/i,
    `$1${rows}$2`,
  );
  // The table is assembled now, not when the scraper last ran. Keep the build
  // time distinct from the manifest/pipeline timestamp.
  const generatedAt = new Date().toISOString();
  if (generatedAt) {
    html = html.replace(
      /<time[^>]*id="latest-reports-generated"[^>]*>[\s\S]*?<\/time>/i,
      `<time id="latest-reports-generated" datetime="${escapeHtml(generatedAt)}" data-iv-time="${escapeHtml(generatedAt)}" data-iv-time-format="full">${escapeHtml(checkedStamp(generatedAt))}</time>`,
    );
  }
  fs.writeFileSync(pagePath, html);
}

/** Write the one canonical official report-date / data-through / checked line
 *  into each office page. A tracker observation, when newer, is appended as a
 *  separate labelled sentence so it is never paired with the official count. */
export function injectOfficeFreshness(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const freshness = loadFreshness(assetsRoot);
  for (const office of freshness.offices) {
    const pagePath = path.resolve(dist, `${office.slug}-visa-decisions.html`);
    if (!fs.existsSync(pagePath)) continue;
    const statusClass = office.status_tone ? ` is-${office.status_tone}` : '';
    const summary = escapeHtml(office.summary_at_build).replace(
      `checked ${escapeHtml(office.checked_label)}`,
      office.checked_at ? `checked ${timeHTML(office.checked_at)}` : `checked ${escapeHtml(office.checked_label)}`,
    );
    const block = `<p class="office-freshness" data-freshness="${office.slug}">` +
      `<span class="freshness-chip${statusClass}">${escapeHtml(office.status_label)}</span> ` +
      `${summary}` +
      (office.observation_note ? ` <span class="office-freshness-observation">${escapeHtml(office.observation_note)}</span>` : '') +
      (office.last_attempt_at ? ` <span class="office-freshness-attempt">Last attempt ${timeHTML(office.last_attempt_at)}</span>` : '') +
      (office.warning_at_build ? ` <span class="office-freshness-warning">${escapeHtml(office.warning_at_build)}</span>` : '') +
      `</p>`;
    const html = fs.readFileSync(pagePath, 'utf8').replace(
      new RegExp(`(<p[^>]*class="office-freshness"[^>]*data-freshness="${office.slug}"[^>]*>)[\\s\\S]*?(<\\/p>)`, 'i'),
      block,
    );
    fs.writeFileSync(pagePath, html);
  }
  const statusPath = path.resolve(dist, 'status.html');
  if (fs.existsSync(statusPath)) {
    let html = fs.readFileSync(statusPath, 'utf8');
    const history = freshnessHistoryHTML(freshness);
    const footer = freshnessFooterHTML(freshness);
    html = html.replace(
      /(<!-- freshness-history:start -->)[\s\S]*?(<!-- freshness-history:end -->)/i,
      `$1${history}$2`,
    );
    html = html.replace(
      /(<!-- freshness-footer:start -->)[\s\S]*?(<!-- freshness-footer:end -->)/i,
      `$1${footer}$2`,
    );
    fs.writeFileSync(statusPath, html);
  }
  console.log('Office pages: injected canonical freshness lines.');
}

function writeContentDatesModule() {
  const source = path.resolve(assetsRootDir, 'data', 'content-dates.json');
  const target = path.resolve(rootDir, 'functions', '_content-dates.js');
  if (!fs.existsSync(source)) return;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch {
    console.warn('Warning: content-dates.json is not valid JSON; keeping the agent-doc dates');
    return;
  }
  const labels = {};
  for (const [route, date] of Object.entries(payload.pages || {})) {
    const label = longDate(date);
    if (label) labels[route] = label;
  }
  const body = '// Generated by tools/deploy-pages.mjs from data/content-dates.json.\n' +
    '// Do not edit by hand; edit the JSON and rebuild.\n' +
    `export const CONTENT_DATES = ${JSON.stringify(labels, null, 2)};\n`;
  fs.writeFileSync(target, body);
}

export function injectDailyToday(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const decisionsPath = path.resolve(assetsRoot, 'data', 'visa_decisions.json');
  const pagePath = path.resolve(dist, 'daily-summaries.html');
  if (!fs.existsSync(decisionsPath) || !fs.existsSync(pagePath)) return;
  let rows;
  try {
    rows = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(rows) || !rows.length) return;
  // Notice rows such as "NO_FILE_2026-11-21" are closures, not tracker
  // observations. Counting one as the latest observed day made the page claim
  // rows on a day the embassy was closed.
  const decisionRows = rows.filter((row) => Array.isArray(row) &&
    /^(approved|refused)$/i.test(String(row[2] || '').trim()));
  const byDate = summarizeByDate(decisionRows);
  if (!byDate.size) return;
  // The latest published New Delhi day is the official report date, not the
  // newest tracker row: the 20 Nov rows are a partial day that is not in the
  // 19 Nov file, and calling them "latest published" contradicted every other
  // surface on the site.
  const freshness = loadFreshness(assetsRoot);
  const newDelhi = freshness.bySlug['new-delhi'];
  const cutoff = String(newDelhi?.report_date || '').slice(0, 10);
  const eligibleDates = [...byDate.keys()].filter((date) => !cutoff || date <= cutoff).sort();
  const latest = eligibleDates[eligibleDates.length - 1];
  if (!latest) return;
  const allDates = [...byDate.keys()].sort();
  const observed = allDates[allDates.length - 1] || latest;
  const official = cutoff || latest;
  const observedCopy = observed > official
    ? `${longDate(observed)} (partial observation; not in the official file)`
    : longDate(observed);
  const checkedAt = String(newDelhi?.last_success_at || freshness.generated_at || '');
  const checkedLabel = newDelhi?.last_success_label || checkedStamp(checkedAt) || longDate(checkedAt);
  let html = fs.readFileSync(pagePath, 'utf8');
  html = html.replace(
    /(<time[^>]*id="visa-as-of"[^>]*datetime=")[^"]*(">)[\s\S]*?(<\/time>)/i,
    `$1${official}$2${longDate(official)}$3`,
  );
  html = html.replace(
    /(<span[^>]*id="visa-observed"[^>]*>)[\s\S]*?(<\/span>)/i,
    `$1${observedCopy}$2`,
  );
  if (checkedAt) {
    html = html.replace(
      /(<time[^>]*id="visa-checked"[^>]*datetime=")[^"]*(">)[\s\S]*?(<\/time>)/i,
      `$1${checkedAt}$2${checkedLabel}$3`,
    );
  }
  html = html.replace(
    /(<span[^>]*id="visa-status"[^>]*>)[\s\S]*?(<\/span>)/i,
    `$1${escapeHtml(newDelhi?.status_label || 'OK')}$2`,
  );
  fs.writeFileSync(pagePath, html);
  console.log(`Daily summary: official file ${official}; latest observation ${observed}.`);
}

function latestDataDate(assetsRoot, fileName, key = 'run_date') {
  const file = path.resolve(assetsRoot, 'data', fileName);
  if (!fs.existsSync(file)) return '';
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(payload) ? payload : payload.rows || payload.data || [];
    return rows
      .map((row) => String((row && row[key]) || '').slice(0, 10))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .sort()
      .pop() || '';
  } catch {
    return '';
  }
}

function setDatasetDateModified(html, id, date) {
  if (!date) return html;
  const pattern = new RegExp(`("@id":\\s*"[^"]*#${id}"[\\s\\S]*?"dateModified":\\s*")[^"]*(")`);
  return html.replace(pattern, `$1${date}$2`);
}

/** Keep the homepage's three Dataset dateModified values tied to their own
 *  data files instead of a hand-written date that drifts behind the build. */
export function injectHomepageDates(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || assetsRootDir);
  const dist = path.resolve(options.distDir || distDir);
  const pagePath = path.resolve(dist, 'index.html');
  if (!fs.existsSync(pagePath)) return;
  const freshness = loadFreshness(assetsRoot);
  const visaDate = String(
    freshness.bySlug['new-delhi']?.last_success_at || freshness.as_of || '',
  ).slice(0, 10);
  const stampDate = latestDataDate(assetsRoot, 'stamp_1g.json');
  const permitDate = latestDataDate(assetsRoot, 'work_permits.json');
  let html = fs.readFileSync(pagePath, 'utf8');
  html = setDatasetDateModified(html, 'dataset-visa-decisions', visaDate);
  html = setDatasetDateModified(html, 'dataset-stamp-1g', stampDate);
  html = setDatasetDateModified(html, 'dataset-work-permits', permitDate);
  fs.writeFileSync(pagePath, html);
}

function localDistPath(href) {
  if (!href || /^(?:[a-z]+:)?\/\//i.test(href) || href.startsWith('data:')) return null;
  const pathname = decodeURIComponent(href.split(/[?#]/)[0]).replace(/^\/+/, '');
  return path.resolve(distDir, pathname);
}

async function main() {
  console.log('Building for Cloudflare Pages...');

  // One canonical per-office freshness record, written before data/ is copied
  // so the SPA and the static pages read exactly the same dates and counts.
  writeFreshness(assetsRootDir);
  // The agent-facing Markdown is served from functions/, not copied into the
  // static tree, so keep its editorial dates generated from the same JSON the
  // HTML sitemap uses.
  writeContentDatesModule();
  const preview = buildSearchPreview({
    dataDir: path.resolve(assetsRootDir, 'data'),
    outFile: path.resolve(assetsRootDir, 'data', 'search_preview.json'),
  });
  console.log(`Search preview: ${preview.rows} rows (${(preview.bytes / 1024).toFixed(1)} KiB)`);
  
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

  // /admin is deliberately not deployed. Remove its client assets too so the
  // public bundle contains no token form or scraper controls to discover.
  for (const file of ['scripts/admin-1.js', 'styles/admin.css']) {
    fs.rmSync(path.resolve(distDir, file), { force: true });
  }

  injectLiveSummary();
  injectOfficePages();
  injectOfficeFreshness();
  injectLatestReports();
  injectDailyToday();
  const dailyRecent = injectDailyRecent({ assetsRootDir, distDir });
  console.log(`Daily recent table: ${dailyRecent.written ? `${dailyRecent.days} day(s)` : dailyRecent.reason}.`);
  injectTodayLine();
  injectHomepageSeo();
  bundleIndexAssets();
  injectHomepageDates();
  
  const fallback = buildSearchFallback({
    dataDir: path.resolve(assetsRootDir, 'data'),
    manifestPath: path.resolve(assetsRootDir, 'data', 'data_manifest.json'),
    outFile: path.resolve(distDir, 'data', 'search_fallback.json')
  });
  console.log(`Search fallback: ${fallback.rows} rows (${(fallback.bytes / 1024 / 1024).toFixed(2)} MiB)`);

  const insights = buildInsightPages({ assetsRootDir, distDir });
  console.log(`Insight pages: ${insights.pages.length} pages, ${insights.reportPages} report permalinks, ${insights.badges} badges` +
    (insights.sitemapAdded ? `, ${insights.sitemapAdded} sitemap entries` : '') + '.');

  const growth = buildGrowthPages({ assetsRootDir, distDir });
  console.log(`Growth pages: ${growth.pages.length} pages, ${growth.datePages} date pages, ${growth.archives} eligible date(s)` +
    (growth.sitemapAdded ? `, ${growth.sitemapAdded} sitemap entries` : '') + '.');

  // Run after the report permalinks exist so a row never points at a page this
  // build did not emit.
  injectHomeLatestReports();
  injectHomeOfficeCards();

  const monthly = await buildMonthlyPages({ assetsRootDir, distDir });
  console.log(`Monthly report: ${monthly.pages} pages, latest ${monthly.latestMonth}, ${monthly.months.length} archived month(s).`);

  const cards = await buildSocialCards({
    assetsRootDir,
    outDir: path.resolve(distDir, 'assets', 'social'),
  });
  console.log(`Social cards: ${cards.count} PNG(s)` +
    (cards.skipped ? `, ${cards.skipped} skipped (canvas not installed)` : '') + '.');

  const lastmod = updateSitemap(
    path.resolve(distDir, 'sitemap.xml'),
    buildLastmodMap(assetsRootDir),
  );
  console.log(`Sitemap lastmod: ${lastmod.updated} URL(s), ${lastmod.removed} static URL(s) without lastmod.`);

  const sitemapIndex = splitSitemap(distDir, { siteOrigin: SITE_ORIGIN });
  console.log(`Sitemap index: ${sitemapIndex.total} URL(s) — `
    + `${Object.entries(sitemapIndex.counts).map(([family, count]) => `${family} ${count}`).join(', ')}.`);

  rewriteSiteOrigin();
  const assetVersion = versionAssets(distDir);
  console.log(`Asset version: ${assetVersion.version} (${assetVersion.htmlFiles} HTML, ${assetVersion.cssFiles} CSS files).`);

  const contentStyles = inlineContentPageStyles();
  console.log(`Inlined styles + font preload: ${contentStyles.pages} content page(s).`);
  const indexStyles = inlineIndexStyles();
  if (indexStyles) {
    console.log(`Inlined homepage styles: ${(indexStyles.bytes / 1024).toFixed(1)} KiB (one render-blocking request removed).`);
  }
  const inlineHashes = writeInlineStyleHashes([contentStyles.hash, indexStyles && indexStyles.hash]);
  console.log(`CSP inline style hashes: ${inlineHashes.length}.`);

  const discovery = auditDiscovery({ assetsRootDir, distDir });
  console.log(`Discovery audit: ${discovery.checked} sitemap URLs, ${discovery.reportPermalinks} report permalinks, ${discovery.datePages} date pages` +
    (discovery.failures.length ? `, ${discovery.failures.length} failure(s)` : '') + '.');
  if (discovery.failures.length) {
    throw new Error(`Discovery audit failed:\n${discovery.failures.join('\n')}`);
  }

  console.log(`Build complete! Copied ${copied} files to ${outDir}`);
  console.log(`Output directory: ${distDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error('Build failed:', err);
    process.exit(1);
  });
}