import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildGrowthPages } from '../tools/growth-pages.mjs';
import { buildIndexNowUrls, eligibleDecisionDates, filterIndexNowUrls } from '../tools/indexnow.mjs';
import { renderCoverageDashboard } from '../tools/coverage-dashboard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the growth hub has a plain link path and a quality-gated date archive', async (t) => {
  const dist = await mkdtemp(path.join(tmpdir(), 'iv-growth-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const result = buildGrowthPages({ assetsRootDir: ROOT, outDir: dist });
  assert.equal(result.pages.length, 7);
  assert.ok(result.datePages >= 1);
  const allPages = await readFile(path.join(dist, 'all-pages.html'), 'utf8');
  assert.match(allPages, /All pages on the Irish Visa Decision Tracker/);
  assert.match(allPages, /Six visa office pages/);
  for (const slug of ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin']) {
    assert.ok(allPages.includes(`href="/${slug}-visa-decisions"`), `all-pages links ${slug}`);
  }
  assert.match(allPages, /"@type": "CollectionPage"/);
  // The hub's dateModified is the newest publication across the six offices,
  // not a fixed date: pinning it made every data commit fail this test.
  const reports = JSON.parse(await readFile(path.join(ROOT, "data", "reports", "index.json"), "utf8"));
  const newest = Object.values(reports.offices || {})
    .flat()
    .map((entry) => String(entry && entry.report_date || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort()
    .at(-1);
  assert.match(allPages, new RegExp(`"dateModified": "${newest}"`));
  assert.match(allPages, /"hasPart":/);
  assert.match(allPages, /\/reports\/new-delhi/);
  assert.match(allPages, /\/reports\/new-delhi\/2026-11-23/);
  assert.match(allPages, /\/decisions\/2026-11-23/);
  assert.match(allPages, /\/bulk-tools/);
  assert.match(allPages, /\/after-refusal/);
  assert.match(allPages, /\/find-my-office/);
  assert.match(allPages, /\/search-coverage/);
  assert.doesNotMatch(allPages, /\/reports\/dublin\/2026-11-22/);

  const decision = await readFile(path.join(dist, 'decisions', '2026-11-23.html'), 'utf8');
  assert.match(decision, /Irish visa decisions published on 23 November 2026/);
  assert.match(decision, /Official report/);
  assert.match(decision, /approved share/i);
  assert.match(decision, /not a refusal|not a statement about any application/i);
  assert.doesNotMatch(decision, /<meta name="robots" content="noindex"/);

  const index = await readFile(path.join(dist, 'decisions.html'), 'utf8');
  assert.match(index, /Weekdays only/);
  assert.match(index, /2026-11-23/);
  assert.doesNotMatch(index, /2026-11-22/);
});

test('after-decision and bulk pages keep the official-source caveat', async (t) => {
  const dist = await mkdtemp(path.join(tmpdir(), 'iv-growth-copy-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  buildGrowthPages({ assetsRootDir: ROOT, outDir: dist });
  const refusal = await readFile(path.join(dist, 'after-refusal.html'), 'utf8');
  assert.match(refusal, /1 June 2026/);
  assert.match(refusal, /EU Free Movement Directive/);
  assert.match(refusal, /not legal advice/i);
  assert.match(refusal, /appeal-a-negative-decision/);
  const approval = await readFile(path.join(dist, 'after-approval.html'), 'utf8');
  assert.match(approval, /not the same as a residence permission/i);
  assert.match(approval, /passport/i);
  const bulk = await readFile(path.join(dist, 'bulk-tools.html'), 'utf8');
  assert.match(bulk, /Nothing uploaded/);
  assert.match(bulk, /Up to 100/);
  assert.match(bulk, /scripts\/bulk\.js/);
  const finder = await readFile(path.join(dist, 'find-my-office.html'), 'utf8');
  assert.match(finder, /not a prediction/i);
  assert.match(finder, /scripts\/find-office\.js/);
});

test('IndexNow covers report permalinks, date pages and growth pages without duplicates', () => {
  const urls = buildIndexNowUrls(ROOT);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.some((url) => /\/reports\/new-delhi\/2026-11-23$/.test(url)));
  assert.ok(urls.some((url) => /\/decisions\/2026-11-23$/.test(url)));
  assert.ok(urls.includes('https://irishvisaupdatetracker.pages.dev/all-pages'));
  assert.ok(urls.includes('https://irishvisaupdatetracker.pages.dev/bulk-tools'));
  assert.ok(urls.includes('https://irishvisaupdatetracker.pages.dev/irish-visa-decisions-today'));
  assert.ok(urls.includes('https://irishvisaupdatetracker.pages.dev/vfs-tracking'));
  assert.ok(urls.includes('https://irishvisaupdatetracker.pages.dev/help'));
  for (const slug of ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin']) {
    assert.ok(urls.includes(`https://irishvisaupdatetracker.pages.dev/${slug}-visa-decisions`), `IndexNow includes ${slug}`);
  }
  assert.ok(urls.every((url) => url.startsWith('https://irishvisaupdatetracker.pages.dev/')));
  assert.ok(eligibleDecisionDates(ROOT).every((date) => new Date(`${date}T00:00:00Z`).getUTCDay() !== 0 && new Date(`${date}T00:00:00Z`).getUTCDay() !== 6));
});

test('IndexNow can announce only the URLs changed in a deploy', () => {
  const urls = buildIndexNowUrls(ROOT);
  const filtered = filterIndexNowUrls(urls, [
    '/irish-visa-decisions-today',
    '/help.html',
    'https://irishvisaupdatetracker.pages.dev/daily-summaries',
    '/not-a-public-page',
  ]);
  assert.deepEqual(filtered.sort(), [
    'https://irishvisaupdatetracker.pages.dev/daily-summaries',
    'https://irishvisaupdatetracker.pages.dev/help',
    'https://irishvisaupdatetracker.pages.dev/irish-visa-decisions-today',
  ]);
});

test('the coverage dashboard renders the seed without pretending it is fresh', async () => {
  const seed = JSON.parse(await readFile(path.join(ROOT, 'data', 'search-coverage.json'), 'utf8'));
  const html = renderCoverageDashboard(seed);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /Search coverage dashboard/);
  assert.match(html, /URL is unknown to Google/);
  assert.match(html, /Pending/);
  assert.match(html, /Bing and IndexNow/);
  assert.match(html, /Indexing scorecard by engine/);
  assert.match(html, /By page family/);
  assert.match(html, /Request indexing/);
  assert.match(html, /search-coverage/);
});
