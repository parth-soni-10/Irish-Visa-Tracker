#!/usr/bin/env node
/**
 * Static monthly report pages.
 *
 * The interactive `/monthly-report` page is a JavaScript shell: a crawler or a
 * reader without JavaScript sees "Loading…". This module builds the same
 * figures into that shell and publishes every completed month at a stable,
 * self-canonical URL:
 *
 *   /monthly-report/2026-10
 *
 * The numbers come from the same `functions/report-data.js` helpers the live
 * API uses, so a static page cannot disagree with the JSON endpoint.
 *
 *   node tools/monthly-pages.mjs --write   # refresh the checked-in latest page
 *   node tools/monthly-pages.mjs           # build archive pages into .pages-dist
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMonthlyReport,
  buildWeeklyChanges,
  loadReportData,
} from '../functions/report-data.js';
import { spliceChrome } from './site-chrome.mjs';
import { OFFICE_SERIES_KIND } from './office-analysis.mjs';
import { SITE_ORIGIN } from './site-config.mjs';
import { loadFreshness, timeHTML } from './freshness.mjs';
import { freshnessFooterHTML } from './freshness-ui.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
// The monthly report is one of the places a search visitor lands without ever
// seeing the homepage, so it links every office page by its descriptive name.
const OFFICE_PAGES = [
  ['new-delhi', 'New Delhi visa decisions'],
  ['beijing', 'Beijing visa decisions'],
  ['abu-dhabi', 'Abu Dhabi visa decisions'],
  ['abuja', 'Abuja visa decisions'],
  ['ankara', 'Ankara visa decisions'],
  ['dublin', 'Dublin visa decisions'],
];
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
const num = (value) => Number(value || 0).toLocaleString('en-IE');
const pct = (value) => `${Number(value || 0).toFixed(1)}%`;

function longDate(iso) {
  const raw = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const [year, month, day] = raw.split('-');
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

function monthLabel(month) {
  const [year, number] = String(month || '').split('-');
  const index = Number(number) - 1;
  return MONTHS[index] ? `${MONTHS[index]} ${year}` : month;
}

function monthName(month) {
  const [, number] = String(month || '').split('-');
  return MONTHS[Number(number) - 1] || month;
}

function monthEnd(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
}

function isPartialMonth(report) {
  const latest = String(report.latest_date || '').slice(0, 10);
  if (!latest || !report.month) return false;
  // Only the newest month with data can be partial. A completed month whose
  // last decision happened before the calendar end is still complete.
  const newest = Array.isArray(report.available_months) && report.available_months[0];
  if (newest && newest !== report.month) return false;
  return latest < monthEnd(report.month);
}

function localAssets(rootDir) {
  return {
    ASSETS: {
      async fetch(request) {
        const url = new URL(request.url);
        const file = path.resolve(rootDir, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
        if (!file.startsWith(path.resolve(rootDir)) || !fs.existsSync(file)) {
          return new Response('', { status: 404 });
        }
        return new Response(fs.readFileSync(file), {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      },
    },
  };
}

export async function loadMonthlyData(assetsRootDir = ROOT) {
  return loadReportData(localAssets(assetsRootDir), new Request('https://local.invalid/'));
}

function summaryCards(report) {
  const change = report.change;
  const sign = change.total > 0 ? '+' : '';
  const comparison = `${isPartialMonth(report) ? `${monthName(report.month)} to date` : monthLabel(report.month)} vs ${monthLabel(report.previous_month)}`;
  return `<div class="card"><div class="label">Dated decisions</div><div class="value">${num(report.totals.total)}</div><div class="hint">${sign}${num(change.total)} · ${esc(comparison)}</div></div>
      <div class="card"><div class="label">Approved</div><div class="value">${num(report.totals.approved)}</div><div class="hint">${pct(report.totals.approval_rate)} approved share · ${num(report.totals.total)} dated decisions</div></div>
      <div class="card"><div class="label">Refused</div><div class="value">${num(report.totals.refused)}</div><div class="hint">${sign}${num(change.refused)} vs previous month</div></div>
      <div class="card"><div class="label">Busiest day</div><div class="value small">${report.busiest_day ? esc(longDate(report.busiest_day.date)) : 'No data'}</div><div class="hint">${report.busiest_day ? `${num(report.busiest_day.total)} decisions` : ''}</div></div>`;
}

function officeRows(report) {
  if (!report.offices.length) return '<tr><td colspan="5" class="empty">No office data for this month.</td></tr>';
  return report.offices.map((office) => {
    const status = office.status === 'ocr_required' ? ' <span class="pill missing">OCR required</span>' : '';
    // A cumulative list or a snapshot has no dated rows for the month, so its
    // dated cells stay empty and the latest-file column carries the figure. A
    // period office with no report that month keeps its real zero but still
    // gets no share, because a rate over no rows means nothing.
    const dated = Number(office.total) || 0;
    const periodOffice = (OFFICE_SERIES_KIND[office.slug] || 'weekly') === 'weekly';
    return `<tr><td data-label="Office"><strong>${esc(office.name)}</strong>${status}</td>
          <td class="num" data-label="Dated">${periodOffice ? num(dated) : '&mdash;'}</td>
          <td class="num" data-label="Dated approval">${dated ? pct(office.approval_rate) : '&mdash;'}</td>
          <td class="num" data-label="Latest report">${num(office.reported_total)}</td>
          <td class="num" data-label="Report date">${esc(office.report_date ? longDate(office.report_date) : '—')}</td></tr>`;
  }).join('\n        ');
}

function dailyRows(report) {
  const daily = Array.isArray(report.daily) ? report.daily : [];
  if (!daily.length) return '<tr><td colspan="4" class="empty">No decisions in this month.</td></tr>';
  return daily.slice().reverse().map((day) => `<tr><td data-label="Date"><time datetime="${esc(day.date)}">${esc(longDate(day.date))}</time></td><td class="num" data-label="Decisions">${num(day.total)}</td><td class="num" data-label="Approved">${num(day.approved)}</td><td class="num" data-label="Refused">${num(day.refused)}</td></tr>`).join('\n        ');
}

function changesHtml(changes) {
  if (!changes) return '<p class="empty">The weekly change summary is available on the latest report.</p>';
  const updates = (changes.office_updates || []).filter((office) => office.report_date);
  return `<p><strong>${esc(changes.headline)}</strong></p>
      <p class="note">Window: ${esc(longDate(changes.window.start))} to ${esc(longDate(changes.window.end))}.</p>
      <p class="note">Headline counts cover dated decisions; office totals are cumulative.</p>
      ${updates.length ? `<h3>Office reports</h3><ul class="feed">${updates.map((office) => `<li><strong>${esc(office.name)}</strong> <span class="pill">latest</span><span class="meta">Report date ${esc(longDate(office.report_date))}</span></li>`).join('')}</ul>` : ''}`;
}

/**
 * The press package for a month.
 *
 * A reporter does not need another table; they need one defensible finding, a
 * ready-to-publish sentence, the method behind it and a way to check it. Every
 * number here comes from the same monthly report rendered on the page, so the
 * pitch cannot drift from the data.
 */
function storyPackage(report, route = '/monthly-report') {
  const totals = report.totals || {};
  const change = report.change || {};
  const total = Number(totals.total) || 0;
  const approved = Number(totals.approved) || 0;
  const refused = Number(totals.refused) || 0;
  const rate = Number(totals.approval_rate) || 0;
  const changeTotal = Number(change.total) || 0;
  const partial = isPartialMonth(report);
  const monthLabelText = partial ? `${monthLabel(report.month)} to date` : monthLabel(report.month);
  const earlier = monthLabel(report.previous_month);
  const direction = changeTotal > 0 ? 'rose' : changeTotal < 0 ? 'fell' : 'was unchanged';
  const changeCopy = changeTotal === 0
    ? `unchanged from ${earlier}`
    : `${num(Math.abs(changeTotal))} ${changeTotal > 0 ? 'more' : 'fewer'} dated decisions than ${earlier}`;
  const offices = Array.isArray(report.offices) ? report.offices : [];
  const busiest = offices.slice().sort((a, b) => (Number(b.total) || 0) - (Number(a.total) || 0))[0];
  // The newest month lives at /monthly-report; completed months get their own
  // permalink. Linking a month page that this build does not emit is a 404.
  const permalink = `${SITE}${route}`;
  const summary = `In ${monthLabelText}, the official Irish visa decision files recorded ${num(total)} dated decisions: ${num(approved)} approved (${pct(rate)}) and ${num(refused)} refused. That is ${changeCopy}.`
    + (busiest && Number(busiest.total) > 0 ? ` ${busiest.name} accounted for the largest published share, with ${num(busiest.total)} dated decisions.` : '')
    + ' The figures count decisions published in official files, not applications received, and they do not describe any individual application.';
  const subject = `Data: ${monthLabelText} Irish visa decisions — ${num(total)} decisions, ${pct(rate)} approved`;

  return `<section class="panel" id="story-package" aria-labelledby="story-package-heading">
      <h2 id="story-package-heading">Story package: ${esc(monthLabelText)}</h2>
      <p class="note">One finding, one paragraph, the method and the files. Use it in a student paper, a data-journalism class or a newsroom; attribution and a link are the only conditions.</p>
      <p class="story-headline"><strong>${esc(monthLabelText)}: ${num(total)} dated decisions, ${pct(rate)} approved.</strong>
        Published volume ${direction} ${changeTotal === 0 ? 'against' : `by ${num(Math.abs(changeTotal))} against`} ${esc(earlier)}.</p>
      <div class="story-summary">
        <p>${esc(summary)}</p>
      </div>
      <p class="note"><strong>Method.</strong> Counts come from dated official reports: Abu Dhabi, Abuja and Ankara publish reporting periods, New Delhi's cumulative file is tracked by observation date and excluded from dated totals, and Beijing and Dublin publish snapshots shown separately. A correction by an office can change a month after publication. Full method: <a href="/about#method">/about#method</a>. Corrections: <a href="/corrections">correction ledger</a>.</p>
      <h3>Pitch ready to send</h3>
      <div class="story-pitch">
        <p><strong>Subject:</strong> ${esc(subject)}</p>
        <p>I maintain the Irish Visa Decision Tracker, an independent record of the decision files published by the six Irish visa offices. ${esc(monthLabelText)} recorded ${num(total)} dated decisions, ${pct(rate)} of them approvals — ${esc(changeCopy)}. The month's report, the office breakdown and the underlying CSV are free and linkable: ${permalink}. I can send a chart or a cut of the data for your audience, and I am happy to answer questions about what the files do and do not show.</p>
      </div>
      <p class="study-downloads">
        <a class="button" href="${esc(route)}">Month permalink</a>
        <a class="button" href="/api/reports/monthly?month=${esc(report.month)}">Monthly JSON</a>
        <a class="button" href="/data/study/office-summary.csv">Office summary CSV</a>
        <a class="button" href="/data/study/monthly-volume.csv">Monthly volume CSV</a>
        <a class="button" href="/embed">Embeddable badge</a>
        <a class="button" href="/press">Press and citation kit</a>
      </p>
      <p class="note"><strong>Office pages:</strong> ${OFFICE_PAGES.map(([slug, label]) => `<a href="/${slug}-visa-decisions">${label}</a>`).join(' · ')}. <a href="/all-pages">All pages</a>.</p>
      <p class="note">Check the figures against this page before publishing: the month is rebuilt from the latest official files, so a number quoted from an earlier copy can change. The sentence above is safe to reuse verbatim with attribution to the Irish Visa Decision Tracker.</p>
    </section>`;
}

function archiveNav(months, current, latest) {
  return `<nav class="month-nav" aria-label="Monthly report archive">
      <a href="/monthly-report"${current === latest ? ' aria-current="page"' : ''}>Latest report</a>
      ${months.filter((month) => month !== latest).map((month) => `<a href="/monthly-report/${month}"${month === current ? ' aria-current="page"' : ''}>${esc(monthLabel(month))}</a>`).join('\n      ')}
    </nav>`;
}

function monthlySchema(report, route, title, description) {
  const datePublished = `${report.month}-01`;
  const dateModified = String(report.latest_date || report.report_date || monthEnd(report.month)).slice(0, 10);
  const pageUrl = `${SITE}${route}`;
  const items = [
    { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
    { '@type': 'ListItem', position: 2, name: 'Monthly report', item: `${SITE}/monthly-report` },
  ];
  if (route !== '/monthly-report') {
    items.push({ '@type': 'ListItem', position: 3, name: report.label, item: pageUrl });
  }
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${pageUrl}#article`,
        headline: title,
        description,
        url: pageUrl,
        mainEntityOfPage: { '@id': pageUrl },
        datePublished,
        dateModified,
        inLanguage: 'en',
        isAccessibleForFree: true,
        image: `${SITE}/assets/social/month-${report.month}.png`,
        author: {
          '@type': 'Person',
          name: 'Parth Soni',
          url: `${SITE}/about`,
        },
        publisher: {
          '@type': 'Organization',
          name: 'Irish Visa Decision Tracker',
          logo: {
            '@type': 'ImageObject',
            url: `${SITE}/icon-512.png`,
            width: 512,
            height: 512,
          },
        },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${pageUrl}#breadcrumb`,
        itemListElement: items,
      },
    ],
  };
}

function monthlySchemaBlock(report, route, title, description) {
  return `<script type="application/ld+json" data-monthly-schema>\n${JSON.stringify(monthlySchema(report, route, title, description), null, 2)}\n</script>`;
}

function archivePage(report, months, latestMonth, freshness) {
  const route = `/monthly-report/${report.month}`;
  const title = `Irish visa decisions — ${report.label} | Monthly report`;
  const description = `Irish visa decisions published in ${report.label}: ${num(report.totals.total)} dated decisions, ${num(report.totals.approved)} approved and ${num(report.totals.refused)} refused. Independent and unofficial.`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${SITE}${route}">
  <link rel="manifest" href="/manifest.json">
  <link rel="describedby" href="/llms.txt" type="text/plain">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${SITE}${route}">
  <meta property="og:image" content="${SITE}/assets/social/month-${report.month}.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${SITE}/assets/social/month-${report.month}.png">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/styles/monthly-report.css">
  <link rel="stylesheet" href="/site-chrome.css">
${monthlySchemaBlock(report, route, title, description)}
</head>
<body>
  <!-- site-chrome:start -->
  <!-- site-chrome:end -->
  <main id="main-content" tabindex="-1" class="wrap">
    <p class="kicker">Monthly report archive</p>
    <h1>Irish visa decisions — ${esc(report.label)}</h1>
    <p class="lede">Dated decisions recorded in the public embassy files for ${esc(report.label)}, plus the latest cumulative report from each office. Independent and unofficial; not immigration advice.</p>
    <p class="note">Data to ${esc(longDate(report.latest_date || report.report_date))}.${isPartialMonth(report) ? ` ${esc(monthLabel(report.month))} is a partial month: totals cover dated decisions recorded so far.` : ''} Monthly totals can change if an office republishes or corrects its list.</p>
    ${archiveNav(months, report.month, latestMonth)}
    <div class="cards">${summaryCards(report)}</div>
    <div class="grid">
      <section class="panel" aria-labelledby="office-heading">
        <h2 id="office-heading">By visa office</h2>
        <div class="table-wrap" role="region" aria-label="Visa office report table" tabindex="0"><table>
          <thead><tr><th>Office</th><th class="num">Dated</th><th class="num">Dated approval</th><th class="num">Latest report</th><th class="num">Report date</th></tr></thead>
          <tbody>${officeRows(report)}</tbody>
        </table></div>
        <p class="note">Dated approval uses the Dated count in the same row. Dated counts use official report-period dates for Abu Dhabi, Abuja and Ankara. New Delhi tracker additions are observation-dated and excluded from dated monthly totals. New Delhi, Beijing and Dublin are shown under “Latest report” only; that column is the size of each file, not a month count. Their dated cells stay empty because a cumulative list or snapshot has no dated rows to divide; a period office with no report that month shows 0 dated and no share.</p>
      </section>
      <section class="panel" aria-labelledby="changes-heading">
        <h2 id="changes-heading">What changed this week</h2>
        ${changesHtml(report.changes)}
      </section>
    </div>
    <section class="panel" aria-labelledby="activity-heading">
      <h2 id="activity-heading">Daily dated decisions</h2>
      <p class="note note-tight">Abu Dhabi, Abuja and Ankara publish official report-period dates. New Delhi’s tracker records additions when they are scraped, not their official decision dates; Beijing and Dublin publish running totals. The latest cumulative totals are shown separately in the office table.</p>
      <div class="table-wrap" role="region" aria-label="Daily dated decisions table" tabindex="0"><table>
        <thead><tr><th>Date</th><th class="num">Decisions</th><th class="num">Approved</th><th class="num">Refused</th></tr></thead>
        <tbody>${dailyRows(report)}</tbody>
      </table></div>
    </section>
    ${storyPackage(report, route)}
    <section class="panel" aria-labelledby="digest-heading">
      <h2 id="digest-heading">Get the monthly report by email</h2>
      <p class="note">One email a month with the report and the week’s change summary. Double opt-in; unsubscribe from every email.</p>
      <p><a class="button" href="/monthly-report?utm_source=monthly_archive&amp;utm_medium=referral&amp;utm_campaign=monthly_email#digest-heading">Subscribe on the latest report</a></p>
    </section>
    <p class="note"><a href="/monthly-report">Latest monthly report</a> · <a href="/api/reports/monthly?month=${report.month}">Download this month’s JSON</a> · <a href="/data">Open data</a></p>
    ${freshnessFooterHTML(freshness)}
  </main>
  <!-- site-footer:start -->
  <!-- site-footer:end -->
  <script src="/scripts/public-channel.js" defer></script>
  <script src="/scripts/time-mode.js" defer></script>
  <script src="/site-chrome.js" defer></script>
</body>
</html>
`;
  return spliceChrome(html, {
    route,
    current: '/monthly-report',
    skip: 'content',
  });
}

function injectLatest(shell, report, months, latestMonth, freshness) {
  const title = `Irish visa decisions — ${report.label} | Monthly report`;
  const description = `Irish visa decisions published in ${report.label}: ${num(report.totals.total)} dated decisions, ${num(report.totals.approved)} approved and ${num(report.totals.refused)} refused. Independent and unofficial.`;
  let html = shell;
  html = html.replace(/<script type="application\/ld\+json" data-monthly-schema>[\s\S]*?<\/script>\s*/g, '');
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = html.replace(/(<meta name="description" content=")[^"]*(">)/, `$1${esc(description)}$2`);
  html = html.replace(/\n\s*<meta (?:property="og:[^"]+"|name="twitter:[^"]+")[^>]*>/g, '');
  html = html.replace('</head>', `  <meta property="og:type" content="article">\n  <meta property="og:title" content="${esc(title)}">\n  <meta property="og:description" content="${esc(description)}">\n  <meta property="og:url" content="${SITE}/monthly-report">\n  <meta property="og:image" content="${SITE}/assets/social/month-${report.month}.png">\n  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">\n  <meta name="twitter:card" content="summary_large_image">\n  <meta name="twitter:title" content="${esc(title)}">\n  <meta name="twitter:description" content="${esc(description)}">\n  <meta name="twitter:image" content="${SITE}/assets/social/month-${report.month}.png">\n${monthlySchemaBlock(report, '/monthly-report', title, description)}\n</head>`);
  html = html.replace('<input id="report-month" type="month" aria-label="Report month">', `<input id="report-month" type="month" aria-label="Report month" value="${report.month}">`);
  html = html.replace('id="download-json" href="/api/reports/monthly"', `id="download-json" href="/api/reports/monthly?month=${report.month}"`);
  const dataThrough = report.latest_date ? longDate(report.latest_date) : '';
  const latestCheck = (freshness.offices || []).map((office) => office.last_success_at).filter(Boolean).sort().at(-1) || '';
  const dataThroughCopy = dataThrough
    ? `Data to ${esc(dataThrough)}.${isPartialMonth(report) ? ` ${esc(monthLabel(report.month))} is a partial month: totals cover dated decisions recorded so far.` : ''}` +
      (latestCheck ? ` Last successful tracker check: ${timeHTML(latestCheck)}.` : '')
    : '';
  html = html.replace(/(<p class="note" id="report-data-through">)[\s\S]*?(<\/p>)/, `$1${dataThroughCopy}$2`);
  html = html.replace(/(<div class="cards" id="summary-cards"[^>]*>)[\s\S]*?(<\/div>\s*<div class="grid">)/, `$1${summaryCards(report)}$2`);
  html = html.replace(/(<tbody id="office-rows">)[\s\S]*?(<\/tbody>)/, `$1${officeRows(report)}$2`);
  html = html.replace(/(<tbody id="daily-rows">)[\s\S]*?(<\/tbody>)/, `$1${dailyRows(report)}$2`);
  html = html.replace(/<div id="changes-body">[\s\S]*?<\/div>/, `<div id="changes-body">${changesHtml(report.changes)}</div>`);
  // The story package is regenerated each build; drop an earlier copy first so
  // the checked-in shell cannot accumulate one per month.
  html = html.replace(/<section class="panel" id="story-package"[\s\S]*?<\/section>\s*/g, '');
  html = html.replace(/(\s*<section class="panel" aria-labelledby="digest-heading">)/, `\n    ${storyPackage(report)}$1`);
  html = html.replace(/<nav class="month-nav"[\s\S]*?<\/nav>\s*/g, '');
  html = html.replace('  <div class="cards" id="summary-cards"', `  ${archiveNav(months, report.month, latestMonth)}\n\n  <div class="cards" id="summary-cards"`);
  // The interactive shell is also a checked-in generated page, so a previous
  // build may already carry a footer. Replace it rather than stacking copies.
  html = html.replace(/<section class="freshness-footer"[\s\S]*?<\/section>/g, '');
  html = html.replace('</main>', `${freshnessFooterHTML(freshness)}</main>`);
  if (!html.includes('src="/scripts/public-channel.js"')) {
    html = html.replace('<script src="/scripts/monthly-report-1.js" defer></script>', '<script src="/scripts/public-channel.js" defer></script>\n  <script src="/scripts/monthly-report-1.js" defer></script>');
  }
  return html;
}

export async function buildMonthlyPages(options = {}) {
  const assetsRoot = path.resolve(options.assetsRootDir || ROOT);
  const distDir = path.resolve(options.distDir || path.join(ROOT, '.pages-dist'));
  const writeSource = Boolean(options.writeSource);
  const outDir = writeSource ? ROOT : distDir;
  const data = await loadMonthlyData(assetsRoot);
  const freshness = loadFreshness(assetsRoot);
  if (!data.latestDate) {
    console.warn('Monthly pages skipped: no dated decisions in the public files.');
    return { latestMonth: '', months: [], pages: 0 };
  }

  const latestMonth = data.latestDate.slice(0, 7);
  const months = [...new Set(data.rows
    .filter((row) => row.dated !== false && /^\d{4}-\d{2}/.test(row.date))
    .map((row) => row.date.slice(0, 7)))]
    .sort()
    .reverse();
  const reports = new Map();
  for (const month of months) {
    const report = buildMonthlyReport(data.rows, month, data.officeList);
    report.changes = month === latestMonth
      ? buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, 7)
      : null;
    reports.set(month, report);
  }

  const latestReport = reports.get(latestMonth);
  fs.mkdirSync(outDir, { recursive: true });
  const shell = fs.readFileSync(path.join(assetsRoot, 'monthly-report.html'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'monthly-report.html'), injectLatest(shell, latestReport, months, latestMonth, freshness));

  let pages = 1;
  for (const month of months.filter((item) => item !== latestMonth)) {
    const report = reports.get(month);
    fs.mkdirSync(path.join(outDir, 'monthly-report'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'monthly-report', `${month}.html`), archivePage(report, months, latestMonth, freshness));
    pages += 1;
  }

  const sitemapFile = path.join(outDir, 'sitemap.xml');
  if (fs.existsSync(sitemapFile)) {
    let xml = fs.readFileSync(sitemapFile, 'utf8');
    const pathOf = (loc) => {
      try { return new URL(loc).pathname.replace(/\/$/, '') || '/'; }
      catch { return String(loc || '').replace(/\/$/, '') || '/'; }
    };
    const present = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => pathOf(match[1])));
    const blocks = months
      .filter((month) => month !== latestMonth)
      .map((month) => ({ loc: `${SITE}/monthly-report/${month}`, lastmod: monthEnd(month) }))
      .filter((item) => !present.has(pathOf(item.loc)))
      .map((item) => `  <url>\n    <loc>${item.loc}</loc>\n    <lastmod>${item.lastmod}</lastmod>\n  </url>`);
    if (blocks.length) {
      xml = xml.replace('</urlset>', `${blocks.join('\n')}\n</urlset>`);
      fs.writeFileSync(sitemapFile, xml);
    }
  }

  return { latestMonth, months, pages };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  buildMonthlyPages({ writeSource: process.argv.includes('--write') })
    .then((result) => {
      console.log(`Monthly pages: ${result.pages} pages, latest ${result.latestMonth}, ${result.months.length} archived month(s).`);
    })
    .catch((error) => {
      console.error('Monthly pages failed:', error);
      process.exit(1);
    });
}
