import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditDiscovery } from '../tools/audit-discovery.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGES = path.resolve(ROOT, process.env.SITE_HTML_BASE || '.pages-dist');
const OFFICES = ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin'];

async function page(name) {
  const file = path.join(PAGES, name);
  assert.ok(existsSync(file), `missing ${name} under ${PAGES}; run npm run build first`);
  return readFile(file, 'utf8');
}

test('office pages expose a visible breadcrumb and a related-pages path', async () => {
  for (const slug of OFFICES) {
    const html = await page(`${slug}-visa-decisions.html`);
    assert.match(html, /<nav class="breadcrumbs" aria-label="Breadcrumb">/, `${slug}: no visible breadcrumb`);
    assert.ok(html.includes('href="/all-pages#visa-offices"'), `${slug}: no office-hub breadcrumb link`);
    assert.ok(html.includes('aria-current="page"'), `${slug}: breadcrumb has no current page`);
    assert.ok(html.includes('aria-label="Related pages"'), `${slug}: no related-pages landmark`);
    assert.ok(html.includes(`href="/reports/${slug}"`), `${slug}: related pages do not link the report archive`);
    assert.ok(html.includes('"@type": "BreadcrumbList"'), `${slug}: missing BreadcrumbList schema`);
  }
});

test('report index and report pages expose breadcrumbs and prior/next navigation', async () => {
  const index = await page('reports/new-delhi.html');
  assert.match(index, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.ok(index.includes('href="/reports"'));
  assert.ok(index.includes('"@type": "BreadcrumbList"'));

  const report = await page('reports/new-delhi/2026-11-24.html');
  assert.match(report, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.match(report, /aria-label="Report navigation"/);
  assert.ok(report.includes('Newer report: 25 November 2026'));
  assert.ok(report.includes('Older report: 23 November 2026'));
  assert.ok(report.includes('href="/reports/new-delhi/2026-11-25"'));
  assert.ok(report.includes('href="/reports/new-delhi/2026-11-23"'));
  assert.ok(report.includes('aria-label="Related pages"'));
});

test('date and monthly pages expose a visible breadcrumb', async () => {
  const date = await page('decisions/2026-11-24.html');
  assert.match(date, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.ok(date.includes('href="/decisions"'));

  const month = await page('monthly-report/2026-10.html');
  assert.match(month, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.ok(month.includes('href="/monthly-report"'));

  const latest = await page('monthly-report.html');
  assert.match(latest, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
});

test('the rendered homepage keeps task-first links after hydration', async () => {
  const js = await page('scripts/index.js');
  assert.match(js, /class="home-task-strip"/);
  for (const href of [
    '/irish-visa-decisions-today',
    '/new-delhi-visa-decisions',
    '/help#check-status',
    '/reports',
    '/help',
  ]) {
    assert.ok(js.includes(`href="${href}"`), `homepage task strip is missing ${href}`);
  }
});

test('every sitemap URL is reachable from the homepage within three clicks', () => {
  const result = auditDiscovery({ distDir: PAGES });
  assert.deepEqual(result.failures, []);
  assert.ok(result.maxDepth <= 3, `crawl depth is ${result.maxDepth}`);
  assert.ok(result.checked > 100, 'the audit did not read the full sitemap');
});
