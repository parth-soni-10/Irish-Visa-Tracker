#!/usr/bin/env node
/**
 * Operational growth pages that sit on top of the existing tracker data.
 *
 * The pages are deliberately plain HTML with a small amount of progressive
 * JavaScript: the all-pages hub is a crawl path, the date archive is gated to
 * weekdays with real published data, and the guides are source-linked so a
 * search visitor can move from a decision to the right next step without
 * creating thin pages or legal advice.
 *
 *   node tools/growth-pages.mjs --write   # refresh checked-in source pages
 *   node tools/growth-pages.mjs           # build into .pages-dist
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES, spliceChrome } from './site-chrome.mjs';
import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const EDITORIAL_DATE = '2026-11-24';
const OFFICES = ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin'];
const OFFICE_META = {
  'new-delhi': {
    name: 'New Delhi',
    route: '/new-delhi-visa-decisions',
    countries: 'India, Bangladesh, Nepal and Sri Lanka',
    source: 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
  },
  beijing: {
    name: 'Beijing',
    route: '/beijing-visa-decisions',
    countries: 'China, Hong Kong, Macau and Mongolia',
    source: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
  },
  'abu-dhabi': {
    name: 'Abu Dhabi',
    route: '/abu-dhabi-visa-decisions',
    countries: 'UAE, Qatar, Gulf states and North Africa',
    source: 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
  },
  abuja: {
    name: 'Abuja',
    route: '/abuja-visa-decisions',
    countries: 'Nigeria, Ghana, Côte d’Ivoire and Senegal',
    source: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
  },
  ankara: {
    name: 'Ankara',
    route: '/ankara-visa-decisions',
    countries: 'Türkiye, Azerbaijan and Saudi residents',
    source: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/',
  },
  dublin: {
    name: 'Dublin',
    route: '/dublin-visa-decisions',
    countries: 'Pakistan and applications transferred to Dublin',
    source: 'https://www.irishimmigration.ie/visa-decisions/',
  },
};
const DATA_FILES = [
  ['/data/search_preview.json', 'Homepage preview rows'],
  ['/data/data_manifest.json', 'Latest file metadata for every office'],
  ['/data/freshness.json', 'Check times and stale/overdue state'],
  ['/data/reports/index.json', 'Official report archive metadata'],
  ['/data/visa_decisions.json', 'New Delhi tracker observations'],
  ['/data/stamp_1g.json', 'Stamp 1G queue observations'],
  ['/data/work_permits.json', 'Employment-permit queue observations'],
];

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const num = (value) => (Number(value) || 0).toLocaleString('en-IE');
const pct = (part, total) => (total ? `${((part / total) * 100).toFixed(1)}%` : '0.0%');
const iso = (value) => String(value || '').slice(0, 10);
const longDate = (value) => {
  const [year, month, day] = iso(value).split('-');
  const monthName = MONTHS[Number(month) - 1];
  return year && monthName && day ? `${Number(day)} ${monthName} ${year}` : '';
};
const shortDate = (value) => {
  const [year, month, day] = iso(value).split('-');
  const monthName = MONTHS[Number(month) - 1];
  return year && monthName && day ? `${Number(day)} ${monthName.slice(0, 3)} ${year}` : '';
};
const httpUrl = (value) => {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try { return new URL(raw).href; } catch { return ''; }
};
const weekday = (value) => {
  const date = new Date(`${iso(value)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
};

function pageDescriptor(route) {
  return PAGES.find((candidate) => candidate.route === route)
    || { route, current: null, skip: 'content' };
}

// Routes that also answer Markdown at `<route>.md`. The alternate link lets a
// crawler or agent find the Markdown copy without guessing the URL.
const MARKDOWN_ROUTES = new Set([
  '/after-approval',
  '/after-refusal',
  '/missing-decision',
  '/find-my-office'
]);

function shell({ route, title, description, body, jsonLd, robots, extraHead = '', extraScripts = '' }) {
  const ld = jsonLd
    ? `  <script type="application/ld+json">\n${JSON.stringify(jsonLd, null, 2)}\n  </script>\n`
    : '';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${route}">
${MARKDOWN_ROUTES.has(route) ? `  <link rel="alternate" type="text/markdown" href="${route}.md">\n` : ''}
${robots ? `  <meta name="robots" content="${esc(robots)}">\n` : ''}  <link rel="manifest" href="/manifest.json">
  <link rel="describedby" href="/llms.txt" type="text/plain">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${SITE}${route}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/pages.css">
  <link rel="stylesheet" href="/site-chrome.css">
  <link rel="stylesheet" href="/styles/blueprint.css">
${extraHead}${ld}</head>
<body>
  <!-- site-chrome:start -->
  <!-- site-chrome:end -->
  <main id="main-content" tabindex="-1" class="page">
${body}
  </main>
  <!-- site-footer:start -->
  <!-- site-footer:end -->
  <script src="/scripts/time-mode.js" defer></script>
  <script src="/site-chrome.js" defer></script>
${extraScripts}</body>
</html>
`;
  return spliceChrome(html, pageDescriptor(route));
}

export function loadGrowthData(assetsRoot = ROOT) {
  const dataDir = path.join(assetsRoot, 'data');
  const manifest = readJson(path.join(dataDir, 'data_manifest.json'), { offices: [] });
  const reports = readJson(path.join(dataDir, 'reports', 'index.json'), { offices: {} });
  const freshness = readJson(path.join(dataDir, 'freshness.json'), { offices: [] });
  const meta = readJson(path.join(dataDir, 'visa_meta.json'), {});
  const bySlug = new Map();
  for (const slug of OFFICES) {
    const record = (Array.isArray(manifest.offices) ? manifest.offices : [])
      .find((office) => office && office.slug === slug) || {};
    bySlug.set(slug, { ...OFFICE_META[slug], ...record, slug });
  }
  const freshBySlug = new Map();
  for (const office of Array.isArray(freshness.offices) ? freshness.offices : []) {
    if (office && office.slug) freshBySlug.set(office.slug, office);
  }
  const reportEntries = [];
  const generatedReportEntries = [];
  for (const slug of OFFICES) {
    const entries = reports && reports.offices && reports.offices[slug];
    const kept = [];
    let previous = '';
    for (const entry of (Array.isArray(entries) ? entries : [])
      .slice()
      .sort((a, b) => String(b && b.report_date).localeCompare(String(a && a.report_date)))) {
      const date = iso(entry && entry.report_date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      reportEntries.push({ slug, date, entry });
      // Match the report-page generator: repeated checks of an unchanged
      // list collapse to one permalink so the hub never links a 404.
      const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
      if (key === previous) continue;
      previous = key;
      kept.push({ slug, date, entry });
    }
    generatedReportEntries.push(...kept);
  }
  const dates = reportEntries.map((item) => item.date).sort();
  const asOf = String(meta.fileDate || dates.at(-1) || '').slice(0, 10);
  // The hub describes all six offices, not only New Delhi. Track the newest
  // publication separately so its dateModified does not lag a newer Dublin or
  // weekly report that is already linked on the page.
  const latestPublication = [asOf, dates.at(-1) || '']
    .filter(Boolean)
    .sort()
    .at(-1) || '';
  return { manifest, reports, freshness, meta, bySlug, freshBySlug, reportEntries, generatedReportEntries, asOf, latestPublication };
}

function reportDatesFor(data, slug) {
  const dates = new Set();
  for (const item of data.generatedReportEntries) {
    if (item.slug === slug) dates.add(item.date);
  }
  return [...dates].sort().reverse();
}

function buildDateArchives(data) {
  const grouped = new Map();
  for (const item of data.generatedReportEntries) {
    if (!weekday(item.date)) continue;
    if (!grouped.has(item.date)) grouped.set(item.date, new Map());
    const byOffice = grouped.get(item.date);
    const decisions = Number(item.entry.decisions) || 0;
    if (!byOffice.has(item.slug) || decisions > (Number(byOffice.get(item.slug).entry.decisions) || 0)) {
      byOffice.set(item.slug, item);
    }
  }
  return [...grouped.entries()].map(([date, byOffice]) => {
    const reports = [...byOffice.values()];
    const total = reports.reduce((sum, item) => sum + (Number(item.entry.decisions) || 0), 0);
    const approved = reports.reduce((sum, item) => sum + (Number(item.entry.approved) || 0), 0);
    const refused = reports.reduce((sum, item) => sum + (Number(item.entry.refused) || 0), 0);
    return { date, reports, total, approved, refused };
  }).filter((archive) => archive.total >= 10)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function allPagesPage(data, archives) {
  const reportGroups = OFFICES.map((slug) => {
    const office = data.bySlug.get(slug);
    const dates = reportDatesFor(data, slug);
    const links = dates.length
      ? dates.map((date) => `<li><a href="/reports/${slug}/${date}">${esc(longDate(date))}</a></li>`).join('')
      : '<li>No dated report in the archive yet.</li>';
    return `<section>
      <h2>${esc(office.name)}</h2>
      <p><a href="${office.route}">${esc(office.name)} visa decisions</a> &middot;
        <a href="/reports/${slug}">${esc(office.name)} report index</a> &middot;
        <a href="${esc(office.source)}" rel="noopener">official source</a></p>
      <p class="small-note">${esc(office.countries)}. ${num(dates.length)} dated report${dates.length === 1 ? '' : 's'} in the archive.</p>
      <ul class="report-office-list">${links}</ul>
    </section>`;
  }).join('\n');

  const dateLinks = archives.length
    ? archives.map((archive) => `<li><a href="/decisions/${archive.date}">${esc(longDate(archive.date))}</a> <span class="small-note">${num(archive.total)} decisions</span></li>`).join('')
    : '<li>No date page clears the minimum data threshold yet.</li>';

  const officeLinks = OFFICES.map((slug) => {
    const office = data.bySlug.get(slug);
    return `<li><a href="${office.route}"><strong>${esc(office.name)} visa decisions</strong><span>${esc(office.countries)}</span></a></li>`;
  }).join('\n        ');

  const body = `    <p class="page-kicker">Site map</p>
    <h1>All pages on the Irish Visa Decision Tracker</h1>
    <p class="page-lede">This is a plain HTML index for readers and crawlers. Every office, official report, data page and guide has a direct link here, outside the collapsed navigation menu.</p>

    <div class="study-grid">
      <div class="study-stat"><span class="status-kicker">Offices</span><strong>6</strong><span>Independent published files</span></div>
      <div class="study-stat"><span class="status-kicker">Archived reports</span><strong>${num(data.generatedReportEntries.length)}</strong><span>One link per published list</span></div>
      <div class="study-stat"><span class="status-kicker">Date pages</span><strong>${num(archives.length)}</strong><span>Weekdays with at least 10 decisions</span></div>
      <div class="study-stat"><span class="status-kicker">Latest publication</span><strong>${esc(shortDate(data.latestPublication))}</strong><span>Across the six offices</span></div>
    </div>

    <section>
      <h2>Six visa office pages</h2>
      <p>These are the primary landing pages for the six published decision files. Each one links to its office report archive, official source and application search.</p>
      <ul class="office-directory-list">
        ${officeLinks}
      </ul>
    </section>

    <section>
      <h2>Start here</h2>
      <ul class="study-list">
        <li><a href="/">Search the tracker</a> — check an application number across all six offices.</li>
        <li><a href="/irish-visa-decisions-today">Latest Irish visa decisions today</a> — the newest file from each office, and <a href="/irish-visa-decisions-today#changes">what changed since the previous report</a>.</li>
        <li><a href="/find-my-office">Find my visa office</a> — country, category and application date.</li>
        <li><a href="/after-approval">After approval</a> and <a href="/after-refusal">after refusal</a> — what to check next.</li>
        <li><a href="/missing-decision">Missing or changed office</a> — what a missing number does and does not mean.</li>
        <li><a href="/bulk-tools">Bulk application check</a> — for agents and advisers checking several numbers.</li>
      </ul>
    </section>

    <section>
      <h2>Decisions and data</h2>
      <ul class="study-list">
        <li><a href="/daily-summaries">New Delhi daily counts</a> — every published day and its counts.</li>
        <li><a href="/monthly-report">Monthly report</a> — dated decisions by month, with a publishable <a href="/monthly-report#story-package">story package</a>.</li>
        <li><a href="/reports">Official report archive</a> — every report and snapshot check.</li>
        <li><a href="/data">Open data</a> — JSON, CSV, definitions and citation terms.</li>
        <li><a href="/data-study">Data study</a> — approval shares, volume and limits.</li>
        <li><a href="/status">Data status</a> — last successful check and stale/overdue offices.</li>
        <li><a href="/when-are-visa-decisions-published">Publication schedule</a> — expected, not guaranteed.</li>
        <li><a href="/visa-processing-times">Processing times</a> — current queues, with caveats.</li>
        <li><a href="/stamp-1g-processing-dates">Stamp 1G dates</a> and <a href="/employment-permit-processing-dates">employment permits</a>.</li>
        <li><a href="/decisions">Decisions by date</a> — the quality-gated date archive.</li>
      </ul>
    </section>

    <section>
      <h2>Every office</h2>
      ${reportGroups}
    </section>

    <section>
      <h2>Decisions by publication date</h2>
      <p>These pages exist only for weekdays with at least 10 published decisions. Weekends and no-publication days are deliberately absent.</p>
      <ul class="report-office-list">${dateLinks}</ul>
    </section>

    <section>
      <h2>Guides and tools</h2>
      <ul class="study-list">
        <li><a href="/about">About the tracker</a> and <a href="/about#method">method and sources</a>.</li>
        <li><a href="/help">Help and FAQ</a> — number formats, missing results and status checks.</li>
        <li><a href="/vfs-tracking">VFS tracking</a> — what the VFS reference can and cannot tell you.</li>
        <li><a href="/community-timelines">Community timelines</a> — privacy-gated aggregates.</li>
        <li><a href="/press">Press and citation kit</a> and <a href="/embed">embeddable latest-file badge</a>.</li>
        <li><a href="/contact">Contact and corrections</a> and <a href="/corrections">correction ledger</a>.</li>
        <li><a href="/privacy">Privacy</a> and <a href="/terms">terms</a>.</li>
        <li><a href="/search-coverage">Search coverage dashboard</a> — internal weekly GSC/Bing snapshot (noindex).</li>
      </ul>
    </section>

    <section>
      <h2>Open data files</h2>
      <ul class="study-list">
        ${DATA_FILES.map(([href, label]) => `<li><a href="${href}">${href}</a> — ${esc(label)}</li>`).join('\n        ')}
      </ul>
    </section>

    <section>
      <h2>Prediction guardrail</h2>
      <p>The expected-date estimator is a separate prototype with a zero-sample gate. It is not part of the decision lookup, is not presented as advice, and must not be treated as an official processing time. The source-linked <a href="/visa-processing-times">processing-times page</a> is the place to check published queues.</p>
    </section>

    <section>
      <h2>Crawl and indexing notes</h2>
      <p>The canonical index is <a href="/sitemap.xml">/sitemap.xml</a>; <a href="/robots.txt">robots.txt</a> allows the whole public site. Report permalinks, monthly archives and date pages are also linked from their office pages and from this hub.</p>
      <p>Requesting indexing is a signed-in Search Console action under <strong>URL Inspection</strong>. The Search Console API can inspect a URL but cannot press “Request indexing”; this site does not pretend otherwise. IndexNow submissions cover Bing and other participating engines and do not replace Google's sitemap or Search Console path.</p>
    </section>`;

  return shell({
    route: '/all-pages',
    title: 'All pages | Irish Visa Decision Tracker',
    description: 'A plain HTML index of every office page, official report, data page and guide on the Irish Visa Decision Tracker.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      url: `${SITE}/all-pages`,
      name: 'All pages on the Irish Visa Decision Tracker',
      description: 'Crawlable index of office pages, official reports, data pages and guides.',
      inLanguage: 'en',
      dateModified: data.latestPublication || EDITORIAL_DATE,
      isPartOf: { '@id': `${SITE}/#website` },
      hasPart: OFFICES.map((slug) => {
        const office = data.bySlug.get(slug);
        return {
          '@type': 'WebPage',
          name: `${office.name} visa decisions`,
          url: `${SITE}${office.route}`,
        };
      }),
    },
  });
}

function archiveLead(archive, data) {
  const largest = archive.reports
    .slice()
    .sort((a, b) => (Number(b.entry.decisions) || 0) - (Number(a.entry.decisions) || 0))[0];
  const largestOffice = largest ? data.bySlug.get(largest.slug) : null;
  if (archive.reports.length === 1 && largestOffice) {
    return `${num(archive.total)} decisions in the ${esc(largestOffice.name)} report, ${pct(archive.approved, archive.total)} approved.`;
  }
  return `${num(archive.total)} decisions across ${archive.reports.length} offices, ${pct(archive.approved, archive.total)} approved` +
    (largestOffice ? `; ${esc(largestOffice.name)} led with ${num(Number(largest.entry.decisions) || 0)}` : '') + '.';
}

function monthLabel(key) {
  const [year, month] = String(key).split('-');
  return `${MONTHS[Number(month) - 1] || month} ${year}`;
}

function decisionsIndexPage(data, archives) {
  const months = new Map();
  for (const archive of archives) {
    const key = archive.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(archive);
  }
  const monthSections = [...months.entries()].map(([key, list]) => {
    const items = list.map((archive) => `<li><a href="/decisions/${archive.date}">${esc(longDate(archive.date))}</a> — ${archiveLead(archive, data)}</li>`).join('\n');
    return `<section>
      <h2>${esc(monthLabel(key))}</h2>
      <p class="small-note">${list.length} date page${list.length === 1 ? '' : 's'}, newest ${esc(longDate(list[0].date))}.</p>
      <ul class="study-list">${items}</ul>
    </section>`;
  }).join('\n    ');
  const body = `    <p class="page-kicker">Date archive</p>
    <h1>Irish visa decisions by date</h1>
    <p class="page-meta">Weekdays only &bull; At least 10 published decisions &bull; Six offices</p>
    <p class="page-lede">One page per weekday where the six offices' public files contain at least 10 decisions. Irish visa decisions by date is the archive view: it answers what was published on a given day, which offices published it, and how many of those decisions were approved or refused. Each date page links to the exact report page and the office's official file, so a count can be checked at source. Weekends and days with no publication are deliberately not generated; a date is the report's own publication date, not the date an individual application was decided. Use the month sections below to move from a date to the offices that published that day, or open an office page for its full report history and latest file.</p>
    ${monthSections || '<section><h2>Dates in the archive</h2><p>No date currently clears the minimum data threshold.</p></section>'}
    <section>
      <h2>Why some dates are missing</h2>
      <p>A date page is only published for a weekday with at least 10 decisions in the archived reports. That prevents thousands of thin pages for weekends, bank holidays and days when an office did not publish. The absence of a date page is not a statement about any application.</p>
      <p class="page-nav"><a href="/reports">Official report archive</a> &middot; <a href="/daily-summaries">Ireland visa decisions by date</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>`;
  return shell({
    route: '/decisions',
    title: 'Irish visa decisions by date | Tracker',
    description: 'Quality-gated date archive of published Irish visa decisions across the six offices, with office counts, source reports and publication context.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      url: `${SITE}/decisions`,
      name: 'Irish visa decisions by date',
      inLanguage: 'en',
      dateModified: archives[0] ? archives[0].date : data.asOf || EDITORIAL_DATE,
      isPartOf: { '@id': `${SITE}/#website` },
    },
  });
}

function dateArchivePage(data, archive, archives) {
  const index = archives.findIndex((item) => item.date === archive.date);
  const newer = index > 0 ? archives[index - 1] : null;
  const older = index >= 0 && index < archives.length - 1 ? archives[index + 1] : null;
  const rows = OFFICES.map((slug) => {
    const item = archive.reports.find((report) => report.slug === slug);
    const office = data.bySlug.get(slug);
    if (!item) return `<tr><th scope="row">${esc(office.name)}</th><td>—</td><td>—</td><td>—</td><td>No dated report</td></tr>`;
    const entry = item.entry;
    const decisions = Number(entry.decisions) || 0;
    const approved = Number(entry.approved) || 0;
    const refused = Number(entry.refused) || 0;
    const source = httpUrl(entry.source_file);
    return `<tr>
      <th scope="row"><a href="/${slug}-visa-decisions">${esc(office.name)}</a></th>
      <td>${num(decisions)}</td>
      <td>${num(approved)}</td>
      <td>${num(refused)}</td>
      <td><a href="/reports/${slug}/${archive.date}">Report page</a>${source ? ` &middot; <a href="${esc(source)}" rel="noopener">official file</a>` : ''}</td>
    </tr>`;
  }).join('\n');
  const body = `    <p class="page-kicker">Decisions by date</p>
    <h1>Irish visa decisions published on ${esc(longDate(archive.date))}</h1>
    <p class="page-meta">${num(archive.total)} decisions &bull; ${num(archive.approved)} approved &bull; ${num(archive.refused)} refused &bull; ${esc(pct(archive.approved, archive.total))} approved share</p>
    <p class="page-lede"><strong>On ${esc(longDate(archive.date))}, ${archiveLead(archive, data)}</strong> This page groups the official reports whose own publication date is ${esc(longDate(archive.date))}. It exists because the date is a weekday with at least 10 published decisions. Counts are published rows, not applications received; a number that is absent from one file may be in another office's file or still awaiting publication.</p>
    <section>
      <h2>All office counts</h2>
      <div class="table-wrap" role="region" aria-label="Office counts for ${esc(longDate(archive.date))}" tabindex="0">
        <table class="office-table stack-table">
          <caption>Published rows by office; “No dated report” means no file dated that day, not zero applications</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Decisions</th><th scope="col">Approved</th><th scope="col">Refused</th><th scope="col">Source</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>What this date page can and cannot tell you</h2>
      <ul class="study-list">
        <li><strong>It can</strong> show which reports are dated that day and the counts printed in them.</li>
        <li><strong>It can</strong> link to the exact report page and the office's official file.</li>
        <li><strong>It cannot</strong> tell you that your application was decided on this date, or why a decision was made.</li>
        <li><strong>It cannot</strong> stand in for your decision letter. A missing number is not a refusal.</li>
      </ul>
      <p class="page-nav">
        ${newer ? `<a href="/decisions/${newer.date}">Newer: ${esc(longDate(newer.date))}</a>` : 'Newer date: none'}
        &middot; <a href="/decisions">All dates</a> &middot;
        ${older ? `<a href="/decisions/${older.date}">Older: ${esc(longDate(older.date))}</a>` : 'Older date: none'}
      </p>
      <p class="page-nav"><a href="/reports">Official report archive</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>`;
  return shell({
    route: `/decisions/${archive.date}`,
    title: `Irish visa decisions — ${longDate(archive.date)} | Tracker`,
    description: `${num(archive.total)} Irish visa decisions in official reports dated ${longDate(archive.date)}: ${num(archive.approved)} approved and ${num(archive.refused)} refused.`,
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Article',
          '@id': `${SITE}/decisions/${archive.date}#article`,
          headline: `Irish visa decisions published on ${longDate(archive.date)}`,
          description: `${num(archive.total)} decisions across ${archive.reports.length} official reports dated ${longDate(archive.date)}.`,
          url: `${SITE}/decisions/${archive.date}`,
          datePublished: archive.date,
          dateModified: archive.date,
          inLanguage: 'en',
          isPartOf: { '@id': `${SITE}/#website` },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Tracker', item: `${SITE}/` },
            { '@type': 'ListItem', position: 2, name: 'Decisions by date', item: `${SITE}/decisions` },
            { '@type': 'ListItem', position: 3, name: longDate(archive.date), item: `${SITE}/decisions/${archive.date}` },
          ],
        },
      ],
    },
  });
}

function afterApprovalPage(data) {
  const asOf = data.asOf || EDITORIAL_DATE;
  const body = `    <p class="page-kicker">After approval</p>
    <h1>Approved: what happens after an Irish visa decision</h1>
    <p class="page-meta">General information &bull; Not legal advice &bull; Reviewed ${esc(longDate(asOf))}</p>
    <p class="page-lede">An approval in a published decision file means the visa office granted the application. It is not the same as a residence permission, and it does not guarantee entry at the border. The decision letter and the visa in your passport are the authoritative documents.</p>

    <section>
      <h2>1. Wait for the passport and the decision letter</h2>
      <p>The office or its visa application centre will tell you how to submit or collect your passport. Do not book non-refundable travel until your passport is back and you have checked the visa. A published decision can appear before the passport is returned.</p>
      <p>Keep the decision letter. It identifies the application, the visa type and any conditions. If the letter has not arrived, contact the office or VFS centre that handled the application, not the tracker.</p>
    </section>

    <section>
      <h2>2. Check the visa before you travel</h2>
      <ul class="study-list">
        <li><strong>Identity details</strong> — your name and passport number must match the passport you will travel on.</li>
        <li><strong>Validity</strong> — check the “from” and “until” dates and whether the visa is single or multiple entry.</li>
        <li><strong>Conditions</strong> — the visa may be tied to a course, employer, sponsor or purpose of travel.</li>
        <li><strong>Transit</strong> — a separate transit visa may be needed if you travel through another country.</li>
      </ul>
      <p>If anything is wrong, contact the issuing office before travelling. The tracker cannot change a visa or correct a decision.</p>
    </section>

    <section>
      <h2>3. Registration and arrival</h2>
      <p>Some visa types require registration or an appointment after arrival; others do not. The requirement depends on your permission and length of stay, so check the <a href="https://www.irishimmigration.ie/" rel="noopener">Immigration Service Delivery</a> guidance for your category. A visa permits you to seek entry; the border officer decides whether you may enter.</p>
      <p>Carry your decision letter, passport, insurance and the documents you used in the application. Do not rely on a screenshot of this tracker at the border.</p>
    </section>

    <section>
      <h2>Official sources</h2>
      <ul class="study-list">
        <li><a href="https://www.irishimmigration.ie/visa-decisions/" rel="noopener">ISD visa decisions</a> — what happens after an application is decided.</li>
        <li><a href="https://www.irishimmigration.ie/" rel="noopener">Immigration Service Delivery</a> — permission types, registration and arrival guidance.</li>
        <li><a href="https://visa.vfsglobal.com/" rel="noopener">VFS Global</a> — passport return and collection at the centre that handled the application.</li>
        <li><a href="/${data.offices ? '' : ''}status">Tracker data status</a> — last successful check for each office.</li>
      </ul>
      <p class="small-note">This page is general information, not immigration or legal advice. If your circumstances are complex, use a qualified adviser or the official office that issued the decision.</p>
      <p class="page-nav"><a href="/after-refusal">After a refusal</a> &middot; <a href="/find-my-office">Find my office</a> &middot; <a href="/missing-decision">Missing number</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>`;
  return shell({
    route: '/after-approval',
    title: 'Approved: what happens after an Irish visa decision',
    description: 'What an approved Irish visa decision means, how passport return usually works, what to check on the visa, and which official sources to use before booking travel.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        ['Does an approved decision mean I can enter Ireland?', 'No. A visa permits you to seek entry; the border officer decides whether you may enter. Check the visa and carry your decision letter and supporting documents.'],
        ['Can I book travel before my passport is returned?', 'Wait until your passport is back and you have checked the visa. A published decision can appear before passport return.'],
        ['Is the tracker my official decision?', 'No. The decision letter and the visa are authoritative. The tracker is an independent record of published decision files.'],
      ].map(([question, answer]) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    },
  });
}

function afterRefusalPage(data) {
  const asOf = data.asOf || EDITORIAL_DATE;
  const body = `    <p class="page-kicker">After a refusal</p>
    <h1>Refused: appeal, review or reapply for an Irish visa</h1>
    <p class="page-meta">General information &bull; Not legal advice &bull; Reviewed ${esc(longDate(asOf))}</p>
    <p class="page-lede">A refusal is a decision on one application, not a permanent ban. The refusal letter should give the reasons and say whether you have a right of appeal. Read that letter first: appeal routes and deadlines depend on the visa type and the office that decided the application.</p>

    <section>
      <h2>1. Read the refusal letter before doing anything else</h2>
      <p>The letter identifies the reasons and any available remedy. Do not rely on a generic internet template, and do not assume that a missing application number in a published file is a refusal. The tracker records published decisions; it does not decide appeals or hold your file.</p>
      <p>If the letter has not arrived, contact the visa office or VFS centre that handled the application. Keep the envelope, email and any reference numbers.</p>
    </section>

    <section>
      <h2>2. Check whether an appeal is available</h2>
      <p><strong>Short-stay visas:</strong> from 1 June 2026, applicants can no longer appeal the refusal of a short-stay visa application, except where the application was made under the EU Free Movement Directive (2004/38/EC). Check the <a href="https://www.irishimmigration.ie/appeal-a-negative-decision/" rel="noopener">ISD appeal guidance</a> and your letter for the current rule.</p>
      <p><strong>Other visa categories:</strong> the letter will say whether an appeal is available and how to submit it. Appeal deadlines are strict. Address every reason given in the refusal; additional documents must usually be submitted with the appeal. An appeal is not a guarantee of a different outcome.</p>
      <p>Office-specific instructions can differ. Check the <a href="https://www.irishimmigration.ie/visa-offices/" rel="noopener">ISD visa offices</a> page and the office that issued the decision. If you are unsure about a deadline, contact that office rather than waiting.</p>
    </section>

    <section>
      <h2>3. Reapplying is a new application</h2>
      <p>If you reapply, you will usually need a new application, a new fee and a new decision. Address the reasons in the earlier refusal and provide the evidence that was missing or unclear. Do not submit false or altered documents. A new application does not automatically preserve an appeal right or a place in a queue.</p>
      <p>If your circumstances have changed, explain the change with evidence. The tracker cannot tell you whether a new application will succeed.</p>
    </section>

    <section>
      <h2>Office differences</h2>
      <p>Appeals and queries are handled by the office that decided the application. These pages link to each office's published decisions and official source:</p>
      <ul class="report-office-list">
        ${OFFICES.map((slug) => {
          const office = data.bySlug.get(slug);
          return `<li><a href="${office.route}">${esc(office.name)} visa decisions</a> <span class="small-note">${esc(office.countries)}</span></li>`;
        }).join('')}
      </ul>
    </section>

    <section>
      <h2>Official sources</h2>
      <ul class="study-list">
        <li><a href="https://www.irishimmigration.ie/appeal-a-negative-decision/" rel="noopener">ISD: appeal a negative decision</a> — who can appeal, how to submit and what happens next.</li>
        <li><a href="https://www.irishimmigration.ie/visa-decisions/" rel="noopener">ISD visa decisions</a> — processing and decision information.</li>
        <li><a href="https://www.irishimmigration.ie/visa-offices/" rel="noopener">ISD visa offices</a> — the office that handles your country or application.</li>
        <li><a href="/visa-processing-times">Tracker processing times</a> — current published queues, with caveats.</li>
      </ul>
      <p class="small-note">This page is general information, not immigration or legal advice. Appeal deadlines and rights are set by the official decision and the applicable rules; confirm them with the issuing office.</p>
      <p class="page-nav"><a href="/after-approval">After approval</a> &middot; <a href="/missing-decision">Missing number</a> &middot; <a href="/find-my-office">Find my office</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>`;
  return shell({
    route: '/after-refusal',
    title: 'Refused: appeal, review or reapply for an Irish visa',
    description: 'What to check after an Irish visa refusal: appeal rights and deadlines, the 2026 short-stay rule, and how to reapply with better evidence.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        ['Can I appeal every Irish visa refusal?', 'No. Appeal rights depend on the visa type and the decision. From 1 June 2026, short-stay visa refusals no longer carry a right of appeal except for applications under the EU Free Movement Directive. The refusal letter states whether an appeal is available.'],
        ['How long do I have to appeal?', 'Deadlines are set by the applicable rules and the decision letter. They are strict, so check the letter and the official ISD guidance immediately. This page cannot give a deadline for your case.'],
        ['Does a refusal ban me from reapplying?', 'A refusal is a decision on one application, not automatically a permanent ban. A new application is a new decision with a new fee, and you must address the reasons for the earlier refusal.'],
      ].map(([question, answer]) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    },
  });
}

function missingDecisionPage(data) {
  const body = `    <p class="page-kicker">Missing or changed office</p>
    <h1>My Irish visa number is missing or changed office</h1>
    <p class="page-meta">Published decisions only &bull; Not a status check &bull; Not legal advice</p>
    <p class="page-lede">A missing number in the tracker usually means the decision has not been published in a file the tracker holds, the application is with a different office, or the number was entered differently. It is <strong>not</strong> a refusal and it is <strong>not</strong> proof that no decision exists.</p>

    <section>
      <h2>1. Check the number format</h2>
      <ul class="study-list">
        <li>Use the <strong>8-digit application number</strong> on your receipt or decision email, usually prefixed with <strong>IRL</strong>.</li>
        <li>Do not use a VFS reference, passport number, transaction number or the number from a different application.</li>
        <li>Spaces, dashes and the IRL prefix are optional in the tracker search. Leading zeros are preserved.</li>
      </ul>
      <p><a href="/help#find-number">More help with finding the number</a></p>
    </section>

    <section>
      <h2>2. Allow for publication lag</h2>
      <p>Offices publish on different schedules. A decision can be made before its file is published, and a file can be delayed, published late or corrected. Check the office's latest report date on <a href="/status">Data status</a> and the <a href="/when-are-visa-decisions-published">publication schedule</a>.</p>
    </section>

    <section>
      <h2>3. Check whether the file moved office</h2>
      <p>Some applications are transferred between visa offices. If your receipt names one office but the decision appears under another, search <strong>all six offices</strong> rather than only the one on the receipt. The <a href="https://www.irishimmigration.ie/visa-offices/" rel="noopener">ISD visa offices</a> page explains which office handles which countries, and <a href="/find-my-office">Find my office</a> can narrow the likely office from the country and category.</p>
      <p>If the office has changed, contact the office that now holds the file. The tracker cannot transfer a file or confirm where it is.</p>
    </section>

    <section>
      <h2>4. If the official report has the number</h2>
      <p>Open the office page and its latest <a href="/reports">official report</a>. If the number is in the official file but not in the tracker's results, send a correction with the number, office and report date. Do not post the number publicly.</p>
      <p><a href="/contact#feedback">Send a correction</a></p>
    </section>

    <section>
      <h2>What not to conclude</h2>
      <ul class="study-list">
        <li><strong>Not a refusal.</strong> A missing number is not a decision outcome.</li>
        <li><strong>Not an official status check.</strong> The tracker only reads published files; it cannot see a live application.</li>
        <li><strong>Not a reason to miss a deadline.</strong> Use the official office or your decision letter for anything time-sensitive.</li>
      </ul>
      <p class="page-nav"><a href="/">Search all six offices</a> &middot; <a href="/find-my-office">Find my office</a> &middot; <a href="/help">Help</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>`;
  return shell({
    route: '/missing-decision',
    title: 'My Irish visa number is missing or changed office',
    description: 'What to check when an Irish visa application number is not in the published decisions, including number format, publication lag, office transfers and corrections.',
    body,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: [
        ['Does a missing application number mean refusal?', 'No. It means the number is not in the published files the tracker could check. The decision may not be published yet, may be with another office, or the number may be formatted differently.'],
        ['Can an application move to another office?', 'Some applications are transferred between Irish visa offices. Search all six offices and check the office that now holds the file; the tracker cannot confirm a transfer.'],
        ['What if the official report lists my number?', 'Open the office report page and send a correction with the number, office and report date. Do not post the number publicly.'],
      ].map(([question, answer]) => ({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      })),
    },
  });
}

function findMyOfficePage(data) {
  const countryOptions = [
    ['india', 'India', 'new-delhi'], ['bangladesh', 'Bangladesh', 'new-delhi'],
    ['nepal', 'Nepal', 'new-delhi'], ['sri-lanka', 'Sri Lanka', 'new-delhi'],
    ['china', 'China', 'beijing'], ['hong-kong', 'Hong Kong', 'beijing'],
    ['macau', 'Macau', 'beijing'], ['mongolia', 'Mongolia', 'beijing'],
    ['uae', 'United Arab Emirates', 'abu-dhabi'], ['qatar', 'Qatar', 'abu-dhabi'],
    ['saudi-arabia', 'Saudi Arabia (residents)', 'ankara'],
    ['bahrain', 'Bahrain', 'abu-dhabi'], ['kuwait', 'Kuwait', 'abu-dhabi'],
    ['oman', 'Oman', 'abu-dhabi'], ['nigeria', 'Nigeria', 'abuja'],
    ['ghana', 'Ghana', 'abuja'], ['cote-divoire', 'Côte d’Ivoire', 'abuja'],
    ['senegal', 'Senegal', 'abuja'], ['turkiye', 'Türkiye', 'ankara'],
    ['azerbaijan', 'Azerbaijan', 'ankara'], ['pakistan', 'Pakistan', 'dublin'],
    ['other', 'Other / not listed', ''],
  ];
  const categories = [
    ['study', 'Study (Stamp 2 / 2A)'], ['work', 'Work (employment / critical skills)'],
    ['family', 'Join family / dependant'], ['visit', 'Short stay / visit'],
    ['transit', 'Transit'], ['other', 'Other or not sure'],
  ];
  const tableRows = OFFICES.map((slug) => {
    const office = data.bySlug.get(slug);
    const fresh = data.freshBySlug.get(slug);
    return `<tr><th scope="row"><a href="${office.route}">${esc(office.name)}</a></th><td>${esc(office.countries)}</td><td>${esc(fresh && fresh.report_date ? longDate(fresh.report_date) : 'Not recorded')}</td></tr>`;
  }).join('');
  const body = `    <p class="page-kicker">Office finder</p>
    <h1>Find my Irish visa office</h1>
    <p class="page-meta">Country + category + application date &bull; Official links &bull; Not a prediction</p>
    <p class="page-lede">Irish visa applications are handled by different offices depending on the country and application type. This helper narrows the likely office and shows the latest published file. It does not know where your individual file is and cannot estimate your decision date.</p>

    <form id="office-finder" class="estimator-form">
      <div class="est-field"><label for="office-country">Country you applied from</label>
        <select id="office-country" name="country" required><option value="">Choose a country</option>${countryOptions.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select></div>
      <div class="est-field"><label for="office-category">Visa category</label>
        <select id="office-category" name="category" required><option value="">Choose a category</option>${categories.map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select></div>
      <div class="est-field"><label for="office-applied">Application date <span class="small-note">(optional)</span></label>
        <input type="date" id="office-applied" name="applied" max="${esc(data.latestPublication || EDITORIAL_DATE)}"></div>
      <div class="est-submit"><button class="btn" type="submit">Show likely office</button></div>
    </form>
    <div id="office-finder-result" class="small-note" role="status" aria-live="polite"></div>

    <section>
      <h2>Likely office by country</h2>
      <div class="table-wrap" role="region" aria-label="Visa offices and countries" tabindex="0">
        <table class="office-table stack-table">
          <caption>Official office coverage; some applications are transferred, and the receipt is the final check</caption>
          <thead><tr><th scope="col">Office</th><th scope="col">Countries and applicants</th><th scope="col">Latest published file</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>

    <section>
      <h2>What the public file can tell you about timing</h2>
      <p>The decision files list decisions already made. They do not publish an application-date queue for every office, so this page does not invent an expected decision date. Use the office's official processing page, the latest report date, and your receipt. The <a href="/visa-processing-times">processing-times page</a> explains the published queues and their limits.</p>
      <p class="small-note">Transfers happen: if the receipt names an office but no decision appears there, <a href="/missing-decision">search all six offices</a> before assuming anything. This is general information, not immigration advice.</p>
    </section>

    <section>
      <h2>Official sources</h2>
      <ul class="study-list">
        <li><a href="https://www.irishimmigration.ie/visa-offices/" rel="noopener">ISD visa offices</a> — which office handles which countries.</li>
        <li><a href="https://www.irishimmigration.ie/visa-decisions/" rel="noopener">ISD visa decisions</a> — processing dates and decision information.</li>
        <li><a href="/all-pages">All tracker pages</a> — office pages, reports and data.</li>
      </ul>
    </section>`;
  return shell({
    route: '/find-my-office',
    title: 'Find my Irish visa office | Tracker',
    description: 'Use country, visa category and date to identify the Irish visa office that likely handles a file, with links to official processing and decision pages.',
    body,
    extraScripts: '  <script src="/scripts/find-office.js" defer></script>\n',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Find my Irish visa office',
      url: `${SITE}/find-my-office`,
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: 'Any',
      isAccessibleForFree: true,
      description: 'A country-and-category helper that identifies the likely Irish visa office and links to official sources.',
    },
  });
}

function bulkToolsPage() {
  const body = `    <p class="page-kicker">For agents and advisers</p>
    <h1>Bulk application check</h1>
    <p class="page-meta">Up to 100 numbers &bull; Checked in this browser &bull; Nothing uploaded &bull; CSV export</p>
    <p class="page-lede">Paste application numbers from a spreadsheet or one per line. The page loads the compact fallback index only when you press check, matches each number across the six offices, and lets you filter and export the dated results. Application numbers are never sent to a server by this page.</p>

    <form id="bulk-form" class="bulk-form" novalidate>
      <div class="bulk-field">
        <label for="bulk-numbers">Application numbers <span class="small-note">(one per line; optional office after a comma)</span></label>
        <textarea id="bulk-numbers" name="numbers" rows="10" spellcheck="false" autocomplete="off" placeholder="IRL2026123456&#10;2026123457,new-delhi&#10;2026123458,beijing"></textarea>
      </div>
      <div class="bulk-actions">
        <button class="btn" type="submit" id="bulk-check">Check applications</button>
        <button class="btn secondary" type="button" id="bulk-clear">Clear</button>
        <span class="small-note" id="bulk-status" role="status" aria-live="polite">Nothing checked yet.</span>
      </div>
    </form>

    <section id="bulk-results-section" hidden>
      <h2>Results</h2>
      <div class="bulk-filters">
        <label>Office <select id="bulk-filter-office"><option value="all">All offices</option>${OFFICES.map((slug) => `<option value="${slug}">${esc(OFFICE_META[slug].name)}</option>`).join('')}</select></label>
        <label>Outcome <select id="bulk-filter-decision"><option value="all">All outcomes</option><option value="Approved">Approved</option><option value="Refused">Refused</option><option value="missing">Not found</option></select></label>
        <label>From <input type="date" id="bulk-filter-from"></label>
        <label>To <input type="date" id="bulk-filter-to"></label>
        <button class="btn secondary" type="button" id="bulk-export">Export CSV</button>
      </div>
      <div class="table-wrap" role="region" aria-label="Bulk application results" tabindex="0">
        <table class="office-table stack-table" id="bulk-results-table">
          <caption>Published decisions only; “Not found” is not a refusal</caption>
          <thead><tr><th scope="col">Application</th><th scope="col">Office</th><th scope="col">Outcome</th><th scope="col">Decision date</th><th scope="col">Report date</th><th scope="col">Source</th><th scope="col">Last checked</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="small-note" id="bulk-summary" role="status" aria-live="polite"></p>
    </section>

    <section>
      <h2>How this works</h2>
      <ul class="study-list">
        <li><strong>On demand.</strong> The compact fallback index is fetched only after you press check; the homepage does not load it on first paint.</li>
        <li><strong>Local.</strong> The pasted list and results stay in this browser tab. No account, upload or public result page is created.</li>
        <li><strong>Limited.</strong> Up to 100 numbers per check. For more, split the list or use the <a href="/data">open data files</a>.</li>
        <li><strong>Not a status service.</strong> “Not found” means the number is not in the files this page could read; it is not a refusal.</li>
        <li><strong>CSV export</strong> includes the decision date and source report date so an adviser can keep a dated record.</li>
      </ul>
      <p class="page-nav"><a href="/">Tracker</a> &middot; <a href="/missing-decision">Missing number</a> &middot; <a href="/find-my-office">Find my office</a> &middot; <a href="/all-pages">All pages</a></p>
    </section>
    <noscript><p class="callout">This tool needs JavaScript to read the public index and match numbers. The <a href="/">main tracker</a> and the <a href="/reports">report archive</a> still work without it.</p></noscript>`;
  return shell({
    route: '/bulk-tools',
    title: 'Bulk application check for agents and advisers | Tracker',
    description: 'Check up to 100 Irish visa application numbers against the published decision files in one browser session, then export a dated CSV. Nothing is uploaded.',
    body,
    extraHead: '  <link rel="stylesheet" href="/styles/bulk.css">\n',
    extraScripts: '  <script src="/scripts/bulk.js" defer></script>\n',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebApplication',
      name: 'Bulk Irish visa application check',
      url: `${SITE}/bulk-tools`,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Any',
      isAccessibleForFree: true,
      description: 'A browser-only bulk check of published Irish visa decision files with CSV export.',
    },
  });
}

function appendSitemap(distDir, additions) {
  const file = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(file)) return 0;
  let xml = fs.readFileSync(file, 'utf8');
  const pathOf = (loc) => {
    try { return new URL(loc).pathname.replace(/\/$/, '') || '/'; } catch { return String(loc || '').replace(/\/$/, '') || '/'; }
  };
  const present = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => pathOf(match[1])));
  const blocks = additions
    .filter((item) => item && item.loc && !present.has(pathOf(item.loc)))
    .map((item) => `  <url>\n    <loc>${esc(item.loc)}</loc>\n${item.lastmod ? `    <lastmod>${esc(item.lastmod)}</lastmod>\n` : ''}  </url>`);
  if (!blocks.length) return 0;
  xml = xml.replace('</urlset>', `${blocks.join('\n')}\n</urlset>`);
  fs.writeFileSync(file, xml);
  return blocks.length;
}

/**
 * Write the growth pages and the quality-gated date archive.
 * `writeSource` updates the checked-in copies instead of the build directory.
 * `only` is used by the one-off source refresh so it does not rewrite the
 * existing data-study/report pages.
 */
export function buildGrowthPages(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || ROOT);
  const distDir = path.resolve(options.outDir || path.join(ROOT, '.pages-dist'));
  const writeSource = Boolean(options.writeSource);
  const outDir = writeSource ? assetsRoot : distDir;
  const only = options.only ? new Set(options.only) : null;
  const data = loadGrowthData(assetsRoot);
  const archives = buildDateArchives(data);
  const pages = {
    'all-pages.html': allPagesPage(data, archives),
    'after-approval.html': afterApprovalPage(data),
    'after-refusal.html': afterRefusalPage(data),
    'missing-decision.html': missingDecisionPage(data),
    'find-my-office.html': findMyOfficePage(data),
    'bulk-tools.html': bulkToolsPage(data),
    'decisions.html': decisionsIndexPage(data, archives),
  };
  const shouldWrite = (file) => !only || only.has(file) || only.has('all');
  for (const [file, html] of Object.entries(pages)) {
    if (!shouldWrite(file)) continue;
    fs.mkdirSync(path.dirname(path.join(outDir, file)), { recursive: true });
    fs.writeFileSync(path.join(outDir, file), html);
  }

  let datePages = 0;
  if (!only || only.has('decisions') || only.has('all')) {
    for (const archive of archives) {
      const file = path.join(outDir, 'decisions', `${archive.date}.html`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, dateArchivePage(data, archive, archives));
      datePages += 1;
    }
  }

  let sitemapAdded = 0;
  if (!writeSource) {
    const additions = [
      ...Object.keys(pages).map((file) => ({
        loc: `${SITE}/${file.replace(/\.html$/, '')}`,
        lastmod: EDITORIAL_DATE,
      })),
      ...archives.map((archive) => ({
        loc: `${SITE}/decisions/${archive.date}`,
        lastmod: archive.date,
      })),
    ];
    sitemapAdded = appendSitemap(distDir, additions);
  }

  return {
    outDir,
    pages: Object.keys(pages).filter(shouldWrite),
    datePages,
    archives: archives.length,
    sitemapAdded,
    asOf: data.asOf,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 && args[onlyIndex + 1]
    ? args[onlyIndex + 1].split(',').map((value) => value.trim()).filter(Boolean)
    : null;
  const result = buildGrowthPages({ writeSource: write, only });
  console.log(`Growth pages ${write ? 'written' : 'built'}: ${result.pages.length} page(s), ${result.datePages} date page(s), ${result.archives} eligible date(s)` +
    (result.sitemapAdded ? `, ${result.sitemapAdded} sitemap entries` : '') + '.');
}
