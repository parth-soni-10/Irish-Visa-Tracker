#!/usr/bin/env node
/**
 * Notify IndexNow (Bing, Yandex and other participants) after a deploy.
 *
 * Google ignores IndexNow; this is a complement to the sitemap, not a
 * replacement for Search Console. The key is public by design and must be
 * served at /<key>.txt. The checked-in key file is copied into the build.
 *
 *   node tools/indexnow.mjs --dry-run
 *   node tools/indexnow.mjs --send
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const KEY = findKey() || String(process.env.INDEXNOW_KEY || '').trim();

function findKey() {
  try {
    const candidate = fs.readdirSync(ROOT).find((file) => /^[a-f0-9]{32}\.txt$/i.test(file));
    return candidate ? candidate.replace(/\.txt$/i, '') : '';
  } catch {
    return '';
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function changedUrls() {
  const manifest = readJson(path.join(ROOT, 'data', 'data_manifest.json'), { offices: [] });
  const urls = new Set(['/', '/status', '/reports', '/monthly-report', '/data']);
  for (const office of manifest.offices || []) {
    if (office && office.slug) urls.add(`/${office.slug}-visa-decisions`);
  }
  const latest = (manifest.offices || [])
    .map((office) => String(office.report_date || '').slice(0, 10))
    .filter(Boolean)
    .sort()
    .pop();
  if (latest) {
    urls.add('/data-study');
    urls.add('/when-are-visa-decisions-published');
  }
  return [...urls].map((url) => `${SITE}${url}`);
}

const urls = changedUrls();
if (!KEY) {
  console.log('IndexNow skipped: no key file or INDEXNOW_KEY configured.');
  process.exit(0);
}
if (!process.argv.includes('--send')) {
  console.log(`IndexNow dry run (${urls.length} URL(s)):`);
  for (const url of urls) console.log(`  ${url}`);
  console.log(`Key location: ${SITE}/${KEY}.txt`);
  process.exit(0);
}

try {
  const response = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE).host,
      key: KEY,
      keyLocation: `${SITE}/${KEY}.txt`,
      urlList: urls,
    }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    console.error(`IndexNow failed: HTTP ${response.status} ${body}`.trim());
    process.exit(1);
  }
  console.log(`IndexNow accepted ${urls.length} URL(s) (HTTP ${response.status}).`);
} catch (error) {
  console.error('IndexNow request failed:', error.message);
  process.exit(1);
}
