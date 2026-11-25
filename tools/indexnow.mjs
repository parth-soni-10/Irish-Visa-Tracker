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
 *   node tools/indexnow.mjs --send --changed
 *   node tools/indexnow.mjs --send --only=irish-visa-decisions-today,help
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SITE = SITE_ORIGIN;
export const INDEXNOW_STATE_VERSION = 1;
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

export function defaultIndexNowStateFile(root = ROOT) {
  return path.join(root, '.cache', 'indexnow-state.json');
}

export function emptyIndexNowState() {
  return { version: INDEXNOW_STATE_VERSION, urls: {} };
}

/** Load a state file, ignoring an old or malformed file rather than treating
 *  every URL as permanently unchanged. */
export function loadIndexNowState(file = defaultIndexNowStateFile()) {
  const parsed = readJson(file, null);
  if (!parsed || parsed.version !== INDEXNOW_STATE_VERSION ||
      !parsed.urls || typeof parsed.urls !== 'object' || Array.isArray(parsed.urls)) {
    return emptyIndexNowState();
  }
  const urls = {};
  for (const [url, fingerprint] of Object.entries(parsed.urls)) {
    if (/^https?:\/\//i.test(url) && typeof fingerprint === 'string' && /^[a-f0-9]{64}$/i.test(fingerprint)) {
      urls[url] = fingerprint;
    }
  }
  return { version: INDEXNOW_STATE_VERSION, urls };
}

export function saveIndexNowState(file, state) {
  const urls = Object.fromEntries(Object.entries(state && state.urls || {})
    .filter(([url, fingerprint]) => /^https?:\/\//i.test(url) && typeof fingerprint === 'string')
    .sort(([left], [right]) => left.localeCompare(right)));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ version: INDEXNOW_STATE_VERSION, urls }, null, 2) + '\n');
  fs.renameSync(temp, file);
}

/** Remove build-only noise before hashing a page. A deploy changes the asset
 *  version and check/build timestamps on almost every page; those are not
 *  content changes and must not trigger IndexNow. */
export function normalizeIndexNowHtml(html) {
  return String(html || '')
    .replace(/\r\n/g, '\n')
    .replace(/\?v=[a-f0-9]+/gi, '?v=ASSET')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, 'TIMESTAMP')
    .replace(/"dateModified":\s*"\d{4}-\d{2}-\d{2}"/g, '"dateModified": "DATE"')
    .replace(/<time\b[^>]*\bdata-iv-time\b[^>]*>[\s\S]*?<\/time>/gi, '<time data-iv-time></time>')
    .replace(/<time\b[^>]*\bid="latest-reports-generated"[^>]*>[\s\S]*?<\/time>/gi, '<time id="latest-reports-generated"></time>')
    .replace(/<time\b[^>]*>\d{1,2} [A-Z][a-z]+ \d{4} at \d{2}:\d{2}<\/time>/g, '<time>BUILD_TIME</time>')
    .replace(/<time\b[^>]*>\d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC<\/time>/g, '<time>TIMESTAMP</time>')
    .replace(/\b\d{1,2} [A-Z][a-z]+ \d{4}, \d{2}:\d{2} UTC\b/g, 'TIMESTAMP')
    .replace(/\bas of \d{1,2} [A-Z][a-z]+ \d{4}\b/gi, 'as of DATE')
    .replace(/\b(offices last successfully checked|last successfully checked|checked)\s+\d{1,2} [A-Z][a-z]+ \d{4}(?:\s+to\s+\d{1,2} [A-Z][a-z]+ \d{4})?/gi, '$1 CHECKED')
    .replace(/\bPage built:\s*\d{1,2} [A-Z][a-z]+ \d{4}(?: at \d{2}:\d{2})?/gi, 'Page built: DATE');
}

export function fingerprintIndexNowHtml(html) {
  return createHash('sha256').update(normalizeIndexNowHtml(html)).digest('hex');
}

/** Map a public URL to the built HTML file this deploy may serve. */
export function indexNowFilePath(url, distDir = path.resolve(ROOT, '.pages-dist')) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const route = pathname.replace(/^\/+/, '').replace(/\.html$/i, '');
  const file = path.resolve(distDir, route ? `${route}.html` : 'index.html');
  const root = path.resolve(distDir);
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

export function collectIndexNowFingerprints(urls, distDir) {
  const fingerprints = {};
  const missing = [];
  for (const url of urls) {
    const file = indexNowFilePath(url, distDir);
    if (!file || !fs.existsSync(file)) {
      missing.push(url);
      continue;
    }
    fingerprints[url] = fingerprintIndexNowHtml(fs.readFileSync(file, 'utf8'));
  }
  return { fingerprints, missing };
}

/** Compare current built pages with the last successfully submitted state. */
export function selectChangedIndexNowUrls({ urls, distDir, state }) {
  const { fingerprints, missing } = collectIndexNowFingerprints(urls, distDir);
  if (missing.length) {
    throw new Error(`Cannot fingerprint ${missing.length} URL(s) from the build: ${missing.slice(0, 3).join(', ')}`);
  }
  const previous = state && state.urls && typeof state.urls === 'object' ? state.urls : {};
  return {
    changed: urls.filter((url) => previous[url] !== fingerprints[url]),
    fingerprints,
  };
}

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
  const urls = new Set([
    '/', '/status', '/reports', '/monthly-report', '/data', '/data-study',
    '/daily-summaries', '/press', '/embed', '/when-are-visa-decisions-published',
    '/about', '/all-pages', '/decisions',
  ]);
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
  for (const route of [
    '/after-approval',
    '/after-refusal',
    '/missing-decision',
    '/find-my-office',
    '/bulk-tools',
    '/irish-visa-decisions-today',
    '/vfs-tracking',
    '/help',
  ]) {
    urls.add(route);
  }

  return [...urls].map((url) => `${site}${url}`);
}

/** Restrict a full URL set to the paths changed in this deploy. Accepts
 *  routes with or without a leading slash, .html suffix or absolute URL. */
export function filterIndexNowUrls(urls, paths) {
  const wanted = new Set((Array.isArray(paths) ? paths : [paths])
    .map((value) => {
      const raw = String(value || '').trim();
      if (!raw) return '';
      try {
        const pathname = new URL(raw, DEFAULT_SITE).pathname;
        return pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/';
      } catch {
        return raw.replace(/\.html$/, '').replace(/\/$/, '') || '/';
      }
    })
    .filter(Boolean));
  return urls.filter((url) => {
    try {
      return wanted.has(new URL(url).pathname.replace(/\.html$/, '').replace(/\/$/, '') || '/');
    } catch {
      return false;
    }
  });
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
  const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((value) => value.trim()).filter(Boolean) : [];
  const stateArg = process.argv.find((arg) => arg.startsWith('--state='));
  const stateFile = path.resolve(
    process.cwd(),
    stateArg ? stateArg.slice('--state='.length) : (process.env.INDEXNOW_STATE_FILE || defaultIndexNowStateFile()),
  );
  const changedMode = process.argv.includes('--changed');
  const send = process.argv.includes('--send');
  const allUrls = buildIndexNowUrls();
  const urls = only.length ? filterIndexNowUrls(allUrls, only) : allUrls;
  if (!key) {
    console.log('IndexNow skipped: no key file or INDEXNOW_KEY configured.');
    process.exit(0);
  }
  if (changedMode) {
    try {
      const state = loadIndexNowState(stateFile);
      const { changed, fingerprints } = selectChangedIndexNowUrls({ urls, distDir: path.resolve(ROOT, '.pages-dist'), state });
      const reportCount = changed.filter((url) => /\/(?:reports|decisions|monthly-report)(?:\/|$)/.test(new URL(url).pathname)).length;
      if (!send) {
        console.log(`IndexNow changed dry run (${changed.length} new/changed of ${urls.length} URL(s); ${reportCount} report, ${changed.length - reportCount} priority):`);
        for (const url of changed) console.log(`  ${url}`);
        console.log(`State: ${path.relative(process.cwd(), stateFile)}`);
        process.exit(0);
      }
      if (!changed.length) {
        if (!only.length && Object.keys(state.urls).some((url) => !fingerprints[url])) {
          saveIndexNowState(stateFile, { version: INDEXNOW_STATE_VERSION, urls: fingerprints });
          console.log(`IndexNow state pruned to ${Object.keys(fingerprints).length} current URL(s).`);
        }
        console.log(`IndexNow: no new or changed URLs (${urls.length} checked); nothing submitted.`);
        process.exit(0);
      }
      const result = await submitIndexNow({ urls: changed, key });
      const nextUrls = only.length ? { ...state.urls } : {};
      if (only.length) {
        for (const url of urls) nextUrls[url] = fingerprints[url];
      } else {
        Object.assign(nextUrls, fingerprints);
      }
      saveIndexNowState(stateFile, { version: INDEXNOW_STATE_VERSION, urls: nextUrls });
      console.log(`IndexNow accepted ${changed.length} new/changed URL(s) (${reportCount} report, ${changed.length - reportCount} priority; HTTP ${result.status}).`);
      console.log(`IndexNow state: ${path.relative(process.cwd(), stateFile)} (${Object.keys(nextUrls).length} URL(s)).`);
    } catch (error) {
      console.error('IndexNow change submission failed:', error.message);
      process.exit(1);
    }
  } else if (!send) {
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
