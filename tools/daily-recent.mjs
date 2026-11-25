#!/usr/bin/env node
/**
 * Static "recent days" table for /daily-summaries.
 *
 * The page is indexed for day-by-day New Delhi counts, but the numbers lived
 * only in the interactive History tab, which a crawler never sees. This module
 * renders the last ten observed days into plain HTML at build time (and can
 * refresh the checked-in copy), so the counts are in the initial response.
 *
 *   node tools/daily-recent.mjs --write   # refresh daily-summaries.html
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const iso = (value) => String(value || '').slice(0, 10);
const num = (value) => (Number(value) || 0).toLocaleString('en-IE');
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function longDate(value) {
  const raw = iso(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [year, month, day] = raw.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

/**
 * Group New Delhi decision rows by tracker-observed day.
 * Notice rows such as `NO_FILE_2026-11-21` are closures, not decisions, and are
 * dropped exactly as the office page and daily summary drop them.
 */
export function recentDays(rows, limit = 10) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row)) continue;
    const date = iso(row[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const decision = String(row[2] || '').trim().toLowerCase();
    if (decision !== 'approved' && decision !== 'refused') continue;
    if (!byDate.has(date)) byDate.set(date, { date, approved: 0, refused: 0 });
    const bucket = byDate.get(date);
    bucket[decision] += 1;
  }
  return [...byDate.values()]
    .map((bucket) => ({ ...bucket, decisions: bucket.approved + bucket.refused }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Math.max(1, limit));
}

/**
 * Render the table. `fileExists` decides whether a row can link its dated
 * report page; a link to a page the build did not emit would be a 404.
 */
export function recentDaysHtml(days, { fileExists = () => false } = {}) {
  if (!days.length) {
    return '<p class="small-note">No tracker-observed day is available yet. A day with no file is a closure, not a day with zero decisions.</p>';
  }
  const rows = days.map((day) => {
    const date = `<time datetime="${day.date}">${esc(longDate(day.date))}</time>`;
    const linked = fileExists(day.date)
      ? `<a href="/reports/new-delhi/${day.date}">${date}</a>`
      : date;
    return `<tr>
          <th scope="row">${linked}</th>
          <td data-label="Decisions">${num(day.decisions)}</td>
          <td data-label="Approved">${num(day.approved)}</td>
          <td data-label="Refused">${num(day.refused)}</td>
        </tr>`;
  }).join('\n        ');
  const newest = days[0];
  const oldest = days[days.length - 1];
  return `<div data-daily-recent><div class="table-wrap" role="region" aria-label="Recent New Delhi decision days" tabindex="0">
        <table class="office-table stack-table">
          <caption>Recent tracker-observed New Delhi days, newest first: ${esc(longDate(oldest.date))} to ${esc(longDate(newest.date))}</caption>
          <thead><tr><th scope="col">File date</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th></tr></thead>
          <tbody>
        ${rows}
          </tbody>
        </table>
      </div>
      <p class="small-note">These are the days the tracker recorded, not a claim that every application was decided. A date with no official file is a closure or a gap; the newest day can be partial. Full history: <a href="/?tracker=visa&amp;tab=history">the interactive History tab</a>.</p>
      </div><!-- /data-daily-recent -->`;
}

export function injectDailyRecent(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || ROOT);
  const targetDir = path.resolve(options.distDir || options.outDir || ROOT);
  const pagePath = path.join(targetDir, 'daily-summaries.html');
  if (!fs.existsSync(pagePath)) return { written: false, reason: 'missing page' };
  let rows = [];
  try {
    rows = JSON.parse(fs.readFileSync(path.join(assetsRoot, 'data', 'visa_decisions.json'), 'utf8'));
  } catch {
    return { written: false, reason: 'missing data' };
  }
  const days = recentDays(rows, 10);
  if (!days.length) return { written: false, reason: 'no dated rows' };
  const fileExists = (date) => {
    if (assetsRoot !== ROOT) return fs.existsSync(path.join(targetDir, 'reports', 'new-delhi', `${date}.html`));
    return fs.existsSync(path.join(assetsRoot, 'reports', 'new-delhi', `${date}.html`));
  };
  const html = fs.readFileSync(pagePath, 'utf8');
  // Replace the whole marked block, not up to the first </div>: the table is
  // wrapped in its own div, so the lazy pattern used to leave the note behind
  // and append a duplicate every run.
  const marked = /<div[^>]*data-daily-recent[^>]*>[\s\S]*?<!--\s*\/data-daily-recent\s*-->/i;
  const legacy = /(<div[^>]*data-daily-recent[^>]*>)[\s\S]*?<\/div>/i;
  if (!marked.test(html) && !legacy.test(html)) return { written: false, reason: 'missing placeholder' };
  const block = recentDaysHtml(days, { fileExists });
  const next = marked.test(html) ? html.replace(marked, block) : html.replace(legacy, block);
  if (next === html) return { written: false, reason: 'unchanged', days: days.length };
  fs.writeFileSync(pagePath, next);
  return { written: true, days: days.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = injectDailyRecent({ outDir: ROOT });
  console.log(result.written
    ? `Daily recent table: ${result.days} day(s).`
    : `Daily recent table unchanged: ${result.reason}.`);
}
