#!/usr/bin/env node
/**
 * Notify IndexNow (Bing, Yandex and other participants) after a deploy.
 *
 * Google ignores IndexNow; this complements the sitemap and Search Console.
 * Every public report permalink, monthly archive and quality-gated date page is
 * included, not just the six office URLs. The key is public by design and must
 * be served at /<key>.txt.
 *
 *   node tools/indexnow.mjs --dry-run
 *   node tools/indexnow.mjs --send
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SITE = SITE_ORIGIN;
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export function findIndexNowKey(root = ROOT) {
  try {
    const candidate = fs.readdirSync(root).find((file) => /^[a-f0-9]{32}\.txt$/i.test(file));
    return candidate ? candidate.replace(/\.txt$/i, '') : '';
  } catch {
    return '';
  }
}

function weekday(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
}

export function eligibleDecisionDates(root = ROOT) {
  const reports = readJson(path.join(root, 'data', 'reports', 'index.json'), { offices: {} });
  const byDate = new Map();
  for (const [slug, entries] of Object.entries(reports.offices || {})) {
    const sorted = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || '')))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    let previous = '';
    for (const entry of sorted) {
      const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
      if (key === previous) continue;
      previous = key;
      const date = String(entry && entry.report_date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekday(date)) continue;
      if (!byDate.has(date)) byDate.set(date, new Map());
      const offices = byDate.get(date);
      const decisions = Number(entry.decisions) || 0;
      if (!offices.has(slug) || decisions > (Number(offices.get(slug)) || 0)) offices.set(slug, decisions);
    }
  }
  return [...byDate.entries()]
    .map(([date, offices]) => ({ date, total: [...offices.values()].reduce((sum, value) => sum + value, 0) }))
    .filter((item) => item.total >= 10)
    .map((item) => item.date)
    .sort()
    .reverse();
}

export function buildIndexNowUrls(root = ROOT, site = DEFAULT_SITE) {
  const urls = new Set(['/', '/status', '/reports', '/monthly-report', '/data', '/all-pages', '/decisions']);
  const manifest = readJson(path.join(root, 'data', 'data_manifest.json'), { offices: [] });
  for (const office of Array.isArray(manifest.offices) ? manifest.offices : []) {
    if (office && office.slug) urls.add(`/${office.slug}-visa-decisions`);
  }

  const reports = readJson(path.join(root, 'data', 'reports', 'index.json'), { offices: {} });
  for (const [slug, entries] of Object.entries(reports.offices || {})) {
    urls.add(`/reports/${slug}`);
    const sorted = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || '')))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    let previous = '';
    for (const entry of sorted) {
      const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
      if (key === previous) continue;
      previous = key;
      const date = String(entry && entry.report_date || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) urls.add(`/reports/${slug}/${date}`);
    }
  }

  const monthlyDir = path.join(root, 'monthly-report');
  if (fs.existsSync(monthlyDir)) {
    for (const file of fs.readdirSync(monthlyDir)) {
      const match = file.match(/^(\d{4}-\d{2})\.html$/);
      if (match) urls.add(`/monthly-report/${match[1]}`);
    }
  }

  for (const date of eligibleDecisionDates(root)) urls.add(`/decisions/${date}`);
  for (const route of ['/after-approval', '/after-refusal', '/missing-decision', '/find-my-office', '/bulk-tools']) {
    urls.add(route);
  }

  return [...urls].map((url) => `${site}${url}`);
}

export async function submitIndexNow({ urls, key, site = DEFAULT_SITE, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(site).host,
      key,
      keyLocation: `${site}/${key}.txt`,
      urlList: urls,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new Error(`HTTP ${response.status} ${body}`.trim());
  return { status: response.status, body };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const key = findIndexNowKey() || String(process.env.INDEXNOW_KEY || '').trim();
  const urls = buildIndexNowUrls();
  if (!key) {
    console.log('IndexNow skipped: no key file or INDEXNOW_KEY configured.');
    process.exit(0);
  }
  if (!process.argv.includes('--send')) {
    console.log(`IndexNow dry run (${urls.length} URL(s)):`);
    for (const url of urls) console.log(`  ${url}`);
    console.log(`Key location: ${DEFAULT_SITE}/${key}.txt`);
  } else {
    try {
      const result = await submitIndexNow({ urls, key });
      console.log(`IndexNow accepted ${urls.length} URL(s) (HTTP ${result.status}).`);
    } catch (error) {
      console.error('IndexNow request failed:', error.message);
      process.exit(1);
    }
  }
}
