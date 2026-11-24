#!/usr/bin/env node
/**
 * Give each sitemap URL a lastmod that reflects its own data, not the build
 * clock. Static trust pages do not get a lastmod: a build date is not evidence
 * that their content changed, and an inaccurate lastmod is worse than none.
 *
 *   node tools/sitemap-lastmod.mjs --write        # update checked-in sitemap
 *   node tools/sitemap-lastmod.mjs --dist         # update .pages-dist copy
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

const dateOnly = (value) => String(value || '').slice(0, 10);
const maxDate = (values) => values.map(dateOnly).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort().pop() || '';

function monthEnd(month) {
  const [year, number] = String(month).split('-').map(Number);
  if (!year || !number) return '';
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

export function buildLastmodMap(assetsRoot = ROOT) {
  const dataDir = path.join(assetsRoot, 'data');
  const meta = readJson(path.join(dataDir, 'visa_meta.json'), {});
  const manifest = readJson(path.join(dataDir, 'data_manifest.json'), { offices: [] });
  const reports = readJson(path.join(dataDir, 'reports', 'index.json'), { offices: {} });
  const contentDates = readJson(path.join(dataDir, 'content-dates.json'), { pages: {} });
  const stampRows = readJson(path.join(dataDir, 'stamp_1g.json'), []);
  const permitRows = readJson(path.join(dataDir, 'work_permits.json'), []);
  const officeDates = new Map();
  const reportDates = new Map();
  const latestReportDates = [];
  for (const office of Array.isArray(manifest.offices) ? manifest.offices : []) {
    if (!office || !office.slug) continue;
    const date = dateOnly(office.report_date || office.as_of);
    if (date) officeDates.set(office.slug, date);
    latestReportDates.push(date);
  }
  for (const [slug, entries] of Object.entries((reports && reports.offices) || {})) {
    const dates = (Array.isArray(entries) ? entries : [])
      .map((entry) => dateOnly(entry && entry.report_date))
      .filter(Boolean)
      .sort();
    if (dates.length) {
      reportDates.set(slug, dates[dates.length - 1]);
      latestReportDates.push(dates[dates.length - 1]);
    }
  }
  const latest = maxDate([
    meta.fileDate,
    meta.lastRunAt,
    ...latestReportDates,
  ]);
  const latestMonth = latest ? latest.slice(0, 7) : '';

  const map = new Map();
  for (const office of Array.isArray(manifest.offices) ? manifest.offices : []) {
    const date = officeDates.get(office.slug);
    if (date) map.set(`/${office.slug}-visa-decisions`, date);
  }
  for (const [slug, date] of reportDates) {
    map.set(`/reports/${slug}`, date);
  }
  for (const [slug, entries] of Object.entries((reports && reports.offices) || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const date = dateOnly(entry && entry.report_date);
      if (date) map.set(`/reports/${slug}/${date}`, date);
    }
  }

  if (latest) {
    for (const route of [
      '/',
      '/daily-summaries',
      '/irish-visa-decisions-today',
      '/data',
      '/data-study',
      '/status',
      '/monthly-report',
      '/press',
      '/embed',
      '/when-are-visa-decisions-published',
      '/reports',
    ]) {
      map.set(route, latest);
    }
  }

  for (const [route, date] of Object.entries((contentDates && contentDates.pages) || {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) map.set(route, String(date));
  }
  const latestRun = (rows) => maxDate((Array.isArray(rows) ? rows : []).map((row) => row && row.run_date));
  const stampDate = latestRun(stampRows);
  const permitDate = latestRun(permitRows);
  if (stampDate) map.set('/stamp-1g-processing-dates', stampDate);
  if (permitDate) map.set('/employment-permit-processing-dates', permitDate);
  if (stampDate || permitDate) {
    map.set('/visa-processing-times', maxDate([stampDate, permitDate]));
  }

  const monthlyDir = path.join(assetsRoot, 'monthly-report');
  if (latestMonth) map.set(`/monthly-report/${latestMonth}`, latest);
  if (fs.existsSync(monthlyDir)) {
    for (const file of fs.readdirSync(monthlyDir)) {
      const match = file.match(/^(\d{4}-\d{2})\.html$/);
      if (!match) continue;
      const month = match[1];
      if (month === latestMonth) continue;
      map.set(`/monthly-report/${month}`, monthEnd(month));
    }
  }
  return map;
}

export function updateSitemap(file, map) {
  if (!fs.existsSync(file)) return { updated: 0, removed: 0 };
  let xml = fs.readFileSync(file, 'utf8');
  let updated = 0;
  let removed = 0;
  xml = xml.replace(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g, (block, loc, rest) => {
    const pathname = (() => {
      try { return new URL(loc).pathname; } catch { return loc; }
    })();
    const lastmod = map.get(pathname);
    let body = rest.replace(/\s*<lastmod>[^<]*<\/lastmod>/, '');
    if (lastmod) {
      body = `${body.replace(/\s*$/, '')}\n    <lastmod>${lastmod}</lastmod>\n  `;
    } else {
      removed += 1;
    }
    updated += 1;
    return `<url>\n    <loc>${loc}</loc>${body}</url>`;
  });
  fs.writeFileSync(file, xml);
  return { updated, removed };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dist = process.argv.includes('--dist');
  const assetsRoot = dist ? ROOT : ROOT;
  const file = dist
    ? path.join(ROOT, '.pages-dist', 'sitemap.xml')
    : path.join(ROOT, 'sitemap.xml');
  const map = buildLastmodMap(assetsRoot);
  const result = updateSitemap(file, map);
  console.log(`Sitemap lastmod: ${result.updated} URL(s), ${result.removed} static URL(s) without lastmod.`);
}
