import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { injectHomeOfficeCards } from '../tools/deploy-pages.mjs';

const OFFICES = [
  { slug: 'new-delhi', name: 'New Delhi', title: 'New Delhi visa decisions', countries: 'India, Bangladesh, Nepal and Sri Lanka' },
  { slug: 'beijing', name: 'Beijing', title: 'Beijing visa decisions', countries: 'China, Hong Kong, Macau and Mongolia' },
  { slug: 'abu-dhabi', name: 'Abu Dhabi', title: 'Abu Dhabi visa decisions', countries: 'UAE, Gulf and North Africa' },
  { slug: 'abuja', name: 'Abuja', title: 'Abuja visa decisions', countries: 'Nigeria, Ghana, Côte d’Ivoire and Senegal' },
  { slug: 'ankara', name: 'Ankara', title: 'Ankara visa decisions', countries: 'Türkiye, Azerbaijan and Saudi residents' },
  { slug: 'dublin', name: 'Dublin', title: 'Dublin visa decisions', countries: 'Pakistan and transferred applications' },
];

function manifest(count, date) {
  return {
    generated_at: `${date}T12:00:00.000Z`,
    offices: OFFICES.map((office) => ({
      slug: office.slug,
      name: office.name,
      report_date: date,
      decisions: count,
      approved: count - 1,
      refused: 1,
      fetched_at: `${date}T12:00:00.000Z`,
      status: 'official',
    })),
  };
}

function cardMarkup(withStat) {
  return OFFICES.map((office) => {
    const stat = withStat
      ? `<span class="office-directory-stat">STALE-${office.slug}</span>`
      : '';
    return `<li><a href="/${office.slug}-visa-decisions"><strong>${office.title}</strong>` +
      `<span>${office.countries}</span>${stat}</a></li>`;
  }).join('\n');
}

async function fixture(base, offices, html) {
  const data = path.join(base, 'assets', 'data');
  const dist = path.join(base, 'dist');
  await mkdir(data, { recursive: true });
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(data, 'data_manifest.json'), JSON.stringify(offices));
  await mkdir(path.join(data, 'reports'), { recursive: true });
  await writeFile(path.join(data, 'reports', 'index.json'), JSON.stringify({ offices: {} }));
  for (const office of (offices.offices || [])) {
    await writeFile(
      path.join(data, `embassy-${office.slug}.json`),
      JSON.stringify({
        office: office.slug,
        report_date: office.report_date,
        decisions: [{ date: office.report_date, number: '12345678', decision: 'Approved' }],
      }),
    );
  }
  for (const office of (offices.offices || [])) {
    await writeFile(path.join(dist, `${office.slug}-visa-decisions.html`), 'office');
  }
  await writeFile(path.join(dist, 'index.html'), html);
  return dist;
}

test('homepage office cards update on the second build too', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-cards-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  // First build: plain anchors with no stat span, as the checked-in page had
  // before any injection.
  const dist = await fixture(temp, manifest(1000, '2026-11-01'), cardMarkup(false));
  injectHomeOfficeCards({ assetsRootDir: path.join(temp, 'assets'), distDir: dist });

  // Second build: the page now contains the stat span the first build wrote.
  await writeFile(path.join(temp, 'assets', 'data', 'data_manifest.json'), JSON.stringify(manifest(2500, '2026-11-27')));
  for (const office of OFFICES) {
    await writeFile(
      path.join(temp, 'assets', 'data', `embassy-${office.slug}.json`),
      JSON.stringify({
        office: office.slug,
        report_date: '2026-11-27',
        decisions: [{ date: '2026-11-27', number: '12345678', decision: 'Approved' }],
      }),
    );
  }
  injectHomeOfficeCards({ assetsRootDir: path.join(temp, 'assets'), distDir: dist });

  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  const snapshot = new Set(['beijing', 'dublin']);
  for (const office of OFFICES) {
    const label = snapshot.has(office.slug) ? 'snapshot' : 'file';
    assert.match(
      html,
      new RegExp(`office-directory-stat">2,500 decisions in the 27 November 2026 ${label}`),
      office.slug,
    );
  }
  assert.equal(
    (html.match(/office-directory-stat">/g) || []).length,
    OFFICES.length,
    'exactly one stat span per card',
  );
  assert.doesNotMatch(html, /STALE-/);
});

test('homepage office cards replace an existing stat span in the checked-in markup', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'office-cards-existing-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = await fixture(temp, manifest(4242, '2026-11-27'), cardMarkup(true));
  injectHomeOfficeCards({ assetsRootDir: path.join(temp, 'assets'), distDir: dist });
  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /STALE-/);
  assert.match(html, /4,242 decisions in the 27 November 2026 (file|snapshot)/);
});
