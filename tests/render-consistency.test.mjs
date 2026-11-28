import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadFreshness } from '../tools/freshness.mjs';
import { NDVO_SOURCE_PAGE, RETIRED_NDVO_SOURCE_URLS } from '../tools/report-sources.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PAGES = path.resolve(ROOT, process.env.SITE_HTML_BASE || '.pages-dist');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

const freshness = loadFreshness(ROOT);

async function page(name) {
  const file = path.join(PAGES, name);
  assert.ok(existsSync(file), `missing ${name} under ${PAGES}; run npm run build first`);
  return readFile(file, 'utf8');
}

test('the homepage office cards agree with data/freshness.json', async () => {
  const html = await page('index.html');
  for (const office of freshness.offices) {
    const label = office.snapshot ? 'snapshot' : 'file';
    const expected = `${office.decisions.toLocaleString('en-IE')} decisions in the ${longDate(office.report_date)} ${label}`;
    assert.ok(
      html.includes(expected),
      `${office.slug} card says something else; expected "${expected}"`,
    );
  }
});

test('the homepage summary, status table and office pages use the same latest dates', async () => {
  const index = await page('index.html');
  const delhi = freshness.bySlug['new-delhi'];
  assert.ok(
    index.includes(`${delhi.decisions.toLocaleString('en-IE')} New Delhi decisions`),
    'homepage summary count disagrees with freshness.json',
  );
  assert.ok(
    index.includes(longDate(delhi.report_date)),
    'homepage summary report date disagrees with freshness.json',
  );

  const status = await page('status.html');
  for (const office of freshness.offices) {
    assert.ok(
      status.includes(`datetime="${office.report_date}"`),
      `${office.slug} is missing its latest report date on status.html`,
    );
  }

  for (const office of freshness.offices) {
    const html = await page(`${office.slug}-visa-decisions.html`);
    assert.ok(
      html.includes(`data-office="decisions">${office.decisions.toLocaleString('en-IE')}<`),
      `${office.slug} office page count disagrees with freshness.json`,
    );
    assert.ok(
      html.includes(`data-office="latest-date">${longDate(office.report_date)}<`),
      `${office.slug} office page report date disagrees with freshness.json`,
    );
  }
});

test('the status table names each office searchable window', async () => {
  const html = await page('status.html');
  assert.ok(html.includes('Searchable in tracker'));
  for (const office of freshness.offices) {
    const from = longDate(office.search_from);
    assert.ok(
      html.includes(from),
      `${office.slug} search window missing from status.html (${from})`,
    );
  }
});

test('office pages offer the office-publication link and the today page its snapshot marker', async () => {
  for (const office of freshness.offices) {
    const html = await page(`${office.slug}-visa-decisions.html`);
    assert.ok(
      html.includes(`data-office-alerts="${office.slug}"`),
      `${office.slug} has no new-file update link`,
    );
  }
  const today = await page('irish-visa-decisions-today.html');
  assert.match(today, /data-snapshot-day="\d{4}-\d{2}-\d{2}"/);
  assert.ok(today.includes('Snapshot day:'));
});

test('office pages state their searchable window and the monthly report keeps its anchor', async () => {
  for (const office of freshness.offices) {
    const html = await page(`${office.slug}-visa-decisions.html`);
    assert.ok(
      html.includes('A search matches') && html.includes(longDate(office.search_from)),
      `${office.slug} office page does not state its search window`,
    );
  }
  const monthly = await page('monthly-report.html');
  assert.ok(monthly.includes('id="story-package"'), 'monthly report lost its story-package anchor');
  assert.ok(!monthly.includes('1 more dated decisions'), 'story package pluralisation regressed');
});

test('every social image has alt text and office titles fit a search result', async () => {
  const files = readdirSync(PAGES).filter((file) => file.endsWith('.html'));
  assert.ok(files.length > 30, 'run npm run build before this check');
  for (const file of files) {
    const html = await page(file);
    if (!html.includes('property="og:image"')) continue;
    assert.ok(html.includes('property="og:image:alt"'), `${file} has an og:image without alt text`);
  }
  for (const office of freshness.offices) {
    const html = await page(`${office.slug}-visa-decisions.html`);
    const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    assert.ok(title.length <= 65, `${office.slug} title is ${title.length} characters: ${title}`);
  }
});

test('status and help advertise their Markdown alternates', async () => {
  const status = await page('status.html');
  assert.match(status, /<link rel="alternate" type="text\/markdown" href="\/status\.md"/);
  assert.match(status, /<a href="\/status\.md">this page as Markdown<\/a>/);
  assert.match(status, /<a href="\/data\/freshness\.json">freshness\.json<\/a>/);
  const help = await page('help.html');
  assert.match(help, /<link rel="alternate" type="text\/markdown" href="\/help\.md"/);
  assert.ok(help.includes('Office updates:'), 'help does not explain office-level alerts');
});

test('the data page documents the lookup index and the Markdown status', async () => {
  const data = await page('data.html');
  assert.ok(data.includes('/data/search_index.json'), 'lookup index missing from the data page');
  assert.ok(data.includes('/status.md'), 'data page does not link the Markdown status');
});

test('status offers office updates and the 404 page can recover with a search', async () => {
  const status = await page('status.html');
  for (const office of freshness.offices) {
    assert.ok(status.includes(`data-office-alerts="${office.slug}"`), `${office.slug} update link missing`);
    assert.ok(
      status.includes(`aria-label="Get updates: ${office.name} publication updates on Telegram"`),
      `${office.slug} update link has no distinct accessible name`,
    );
    const officePage = await page(`${office.slug}-visa-decisions.html`);
    assert.ok(
      officePage.includes(`aria-label="Get ${office.name} publication updates on Telegram"`),
      `${office.slug} office update button has no distinct accessible name`,
    );
  }
  assert.ok(status.includes('public-channel.js'), 'status page does not load the config-driven links');

  const notFound = await page('404.html');
  assert.match(notFound, /<form class="notfound-search" action="\/" method="get" role="search">/);
  assert.match(notFound, /name="q"/);
  assert.match(notFound, /name="tracker" value="visa"/);
});

test('archived New Delhi source links use the live official page', async () => {
  assert.equal(RETIRED_NDVO_SOURCE_URLS.size, 12);

  const files = new Set();
  const walk = (dir, skip) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, skip);
      else if (entry.isFile() && entry.name.endsWith('.html')) files.add(file);
    }
  };
  walk(PAGES, new Set());
  walk(ROOT, new Set(['.git', 'node_modules', '.pages-dist', '.wrangler']));

  for (const file of files) {
    const html = await readFile(file, 'utf8');
    for (const retired of RETIRED_NDVO_SOURCE_URLS) {
      assert.ok(!html.includes(retired), `${path.relative(ROOT, file)} still links retired ${retired}`);
    }
  }

  const growthCsv = await readFile(path.join(ROOT, 'data', 'study', 'new-delhi-file-growth.csv'), 'utf8');
  for (const retired of RETIRED_NDVO_SOURCE_URLS) {
    assert.ok(!growthCsv.includes(retired), `growth CSV still links retired ${retired}`);
  }

  const archived = await page('reports/new-delhi/2026-11-25.html');
  assert.ok(archived.includes(NDVO_SOURCE_PAGE), 'retired New Delhi report does not link the official page');
});

test('every page keeps its meta description within a search result', async () => {
  const { readdir } = await import('node:fs/promises');
  const names = (await readdir(PAGES)).filter((name) => name.endsWith('.html'));
  for (const name of names) {
    const html = await page(name);
    const match = /<meta name="description" content="([^"]*)"/.exec(html);
    if (!match) continue;
    assert.ok(
      match[1].length <= 170,
      `${name} description is ${match[1].length} characters`,
    );
  }
});

test('freshness.json publishes the searchable window for every office', async () => {
  const saved = JSON.parse(await readFile(path.join(ROOT, 'data', 'freshness.json'), 'utf8'));
  for (const office of saved.offices) {
    assert.match(office.search_from, /^\d{4}-\d{2}-\d{2}$/, `${office.slug} search_from`);
    assert.match(office.search_through, /^\d{4}-\d{2}-\d{2}$/, `${office.slug} search_through`);
    assert.ok(office.search_from <= office.search_through, `${office.slug} window order`);
    assert.ok(office.search_scope, `${office.slug} search_scope`);
  }
});
