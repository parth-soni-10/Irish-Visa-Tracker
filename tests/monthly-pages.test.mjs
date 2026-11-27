import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

import { buildMonthlyPages, loadMonthlyData } from "../tools/monthly-pages.mjs";
import { buildMonthlyReport } from "../functions/report-data.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = "https://irishvisaupdatetracker.pages.dev";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

function monthKey(value) {
  return String(value).slice(0, 7);
}

function monthLabel(month) {
  const [year, index] = month.split("-");
  return `${MONTHS[Number(index) - 1]} ${year}`;
}

function shiftMonth(month, delta) {
  const [year, index] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

// The current month is the month of the newest dated decision, never a literal:
// on the first of a month the page must follow the data, not the calendar.
async function monthly() {
  const data = await loadMonthlyData(ROOT);
  const latestMonth = monthKey(data.latestDate);
  return {
    data,
    latestMonth,
    previousMonth: shiftMonth(latestMonth, -1),
    report: buildMonthlyReport(data.rows, latestMonth, data.officeList),
  };
}

async function build(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "monthly-pages-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = path.join(temp, "dist");
  await mkdir(dist, { recursive: true });
  await copyFile(path.join(ROOT, "sitemap.xml"), path.join(dist, "sitemap.xml"));
  const result = await buildMonthlyPages({ assetsRootDir: ROOT, distDir: dist });
  return { dist, result };
}

test("the latest monthly report is static and keeps the interactive shell", async (t) => {
  const { dist, result } = await build(t);
  const { latestMonth, previousMonth, report } = await monthly();
  assert.equal(result.latestMonth, latestMonth);
  assert.match(result.latestMonth, /^\d{4}-\d{2}$/);
  // The cards print the selected month's totals, so read them from the same
  // builder the page uses rather than pinning one day's figure.
  const datedTotal = report.totals.total.toLocaleString("en-IE");
  const dataThrough = longDate(report.latest_date);
  const partialCopy = report.partial_month
    ? ` ${monthLabel(latestMonth)} is a partial month: totals cover dated decisions recorded so far.`
    : "";
  assert.ok(result.pages >= 10, "expected the latest page and prior months");

  const html = await readFile(path.join(dist, "monthly-report.html"), "utf8");
  assert.match(html, /class="cards" id="summary-cards"/);
  assert.ok(html.includes(`<div class="value">${datedTotal}</div>`), `the dated-decisions card shows ${datedTotal}`);
  assert.match(html, /class="month-nav"/);
  assert.ok(html.includes(`href="/monthly-report/${previousMonth}"`), `the month nav links the previous month, ${previousMonth}`);
  assert.match(html, new RegExp(`id="report-month"[^>]*value="${latestMonth}"`));
  assert.ok(html.includes(`id="report-data-through">Data to ${dataThrough}.${partialCopy}`), "the report states the data-through date it was built from");
  if (report.partial_month) {
    assert.match(html, new RegExp(`${monthLabel(latestMonth)} is a partial month`));
  } else {
    assert.doesNotMatch(html, /is a partial month/);
  }
  assert.match(html, /id="digest-form"/);
  assert.match(html, /src="\/scripts\/monthly-report-1\.js"/);
  assert.doesNotMatch(html, /Loading the official files/);
  assert.doesNotMatch(html, /Loading this week's changes/);

  const $ = cheerio.load(html);
  assert.equal($('#changes-body').length, 1);
  assert.equal($('#changes-body > ul.feed').length, 1);
  assert.equal($('#changes-body > ul.feed > li').length, 6);
  assert.equal($('#changes-body li').length, 6, "weekly changes should render once");
  assert.equal($('nav.month-nav').length, 1);
  assert.equal($('#summary-cards > .card').length, 4);
  assert.equal($('#summary-cards .grid').length, 0, "the summary cards must close before the office grid");
  assert.equal($('#summary-cards').nextAll('.grid').length, 1);
  assert.equal($('meta[property="og:image"]').length, 1);
  assert.equal($('meta[name="twitter:image"]').length, 1);
  assert.equal($('script[src="/scripts/public-channel.js"]').length, 1);
  assert.equal($('script[data-monthly-schema]').length, 1);
  const monthlyGraph = JSON.parse($('script[data-monthly-schema]').text())['@graph'];
  const article = monthlyGraph.find((node) => node['@type'] === 'Article');
  const breadcrumb = monthlyGraph.find((node) => node['@type'] === 'BreadcrumbList');
  assert.ok(article, 'latest monthly report needs Article schema');
  assert.equal(article.datePublished, `${latestMonth}-01`);
  assert.equal(article.author.name, 'Parth Soni');
  assert.equal(article.publisher.logo.url, `${SITE}/icon-512.png`);
  assert.equal(breadcrumb.itemListElement.length, 2);
});

test("offices with no dated rows leave their dated cells empty", async (t) => {
  const { dist } = await build(t);
  const html = await readFile(path.join(dist, "monthly-report.html"), "utf8");
  const $ = cheerio.load(html);
  const cells = (name) => {
    const row = $('#office-rows tr').filter((_, el) => $(el).find('strong').first().text() === name);
    return {
      dated: row.find('td[data-label="Dated"]').text().trim(),
      approval: row.find('td[data-label="Dated approval"]').text().trim(),
      latest: row.find('td[data-label="Latest report"]').text().trim(),
    };
  };

  // A cumulative list or snapshot has no dated rows this month. Printing 0 and
  // 0.0% there would be a rate divided by nothing.
  for (const name of ['New Delhi', 'Beijing', 'Dublin']) {
    const office = cells(name);
    assert.equal(office.dated, '—', `${name} has no dated rows`);
    assert.equal(office.approval, '—', `${name} has no dated share to report`);
    assert.notEqual(office.latest, '—', `${name} still reports its latest file size`);
  }
  const dated = cells('Abu Dhabi');
  assert.match(dated.dated, /\d/);
  assert.match(dated.approval, /^\d+\.\d%$/);

  // A period office with no report in a month is a real gap, not a file kind:
  // it keeps its zero but still has no rows to divide.
  const january = cheerio.load(await readFile(path.join(dist, "monthly-report", "2026-01.html"), "utf8"));
  const januaryRow = (name) => january('tr').filter((_, el) => january(el).find('td[data-label="Office"] strong').first().text() === name);
  assert.equal(januaryRow('Abu Dhabi').find('td[data-label="Dated"]').text().trim(), '0');
  assert.equal(januaryRow('Abu Dhabi').find('td[data-label="Dated approval"]').text().trim(), '—');
  assert.notEqual(januaryRow('Abuja').find('td[data-label="Dated approval"]').text().trim(), '—');
});

test("prior months are self-canonical archive pages without a duplicate current month", async (t) => {
  const { dist } = await build(t);
  const { data, latestMonth, previousMonth } = await monthly();
  const archiveReport = buildMonthlyReport(data.rows, previousMonth, data.officeList);
  const before = shiftMonth(previousMonth, -1);
  const archive = await readFile(path.join(dist, "monthly-report", `${previousMonth}.html`), "utf8");
  assert.ok(archive.includes(`Data to ${longDate(archiveReport.latest_date)}`), "the archive states its own data-through date");
  assert.doesNotMatch(archive, new RegExp(`${monthLabel(previousMonth)} is a partial month`));
  assert.ok(archive.includes(`<title>Irish visa decisions — ${monthLabel(previousMonth)} | Monthly report</title>`));
  assert.ok(archive.includes(`<link rel="canonical" href="${SITE}/monthly-report/${previousMonth}">`));
  assert.ok(archive.includes(`assets/social/month-${previousMonth}.png`));
  assert.ok(!archive.includes(`href="/monthly-report/${latestMonth}"`), "the archive must not advertise the current month as an archive");
  assert.match(archive, /By visa office/);
  assert.match(archive, /Daily dated decisions/);
  assert.doesNotMatch(archive, /Loading/);
  assert.ok(archive.includes(`href="/monthly-report/${before}"`), `the archive links the month before it, ${before}`);
  const archive$ = cheerio.load(archive);
  const archiveGraph = JSON.parse(archive$('script[data-monthly-schema]').text())['@graph'];
  assert.ok(archiveGraph.some((node) => node['@type'] === 'Article'));
  const archiveBreadcrumb = archiveGraph.find((node) => node['@type'] === 'BreadcrumbList');
  assert.equal(archiveBreadcrumb.itemListElement.length, 3);
  assert.equal(archiveBreadcrumb.itemListElement[2].name, monthLabel(previousMonth));

  await assert.rejects(
    stat(path.join(dist, "monthly-report", `${latestMonth}.html`)),
    /ENOENT/,
    "the current month belongs on /monthly-report, not a duplicate archive URL",
  );

  const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  assert.ok(sitemap.includes(`${SITE}/monthly-report/${previousMonth}`), "the archive is in the sitemap");
  assert.ok(!sitemap.includes(`${SITE}/monthly-report/${latestMonth}<`), "the current month is not duplicated in the sitemap");
});
