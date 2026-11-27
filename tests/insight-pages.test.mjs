import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildInsightPages, publicationDateCopy } from "../tools/insight-pages.mjs";
import { loadFreshness } from "../tools/freshness.mjs";
import { OFFICE_SERIES_KIND } from "../tools/office-analysis.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = "https://irishvisaupdatetracker.pages.dev";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

function weekdayLongDate(value) {
  const raw = String(value).slice(0, 10);
  const day = new Date(`${raw}T00:00:00Z`);
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return `${names[day.getUTCDay()]} ${longDate(raw)}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("citations use the range of last successful office checks", () => {
  const range = publicationDateCopy({
    offices: [{ report_date: "2026-11-01" }, { report_date: "2026-11-21" }],
    freshness: {
      as_of: "2026-11-21",
      offices: [
        { checked_at: "2026-11-21T09:59:37.599Z" },
        { checked_at: "2026-11-18T06:01:42.341Z" },
      ],
    },
  });
  assert.equal(
    range,
    "latest office publications dated 1 November 2026 to 21 November 2026; offices last successfully checked 18 November 2026 to 21 November 2026",
  );
  assert.doesNotMatch(range, /data checked 21 November 2026/);

  const sameDay = publicationDateCopy({
    offices: [{ report_date: "2026-11-21" }],
    freshness: {
      as_of: "2026-11-21",
      offices: [{ checked_at: "2026-11-21T09:59:37.599Z" }],
    },
  });
  assert.match(sameDay, /; data checked 21 November 2026$/);
});

async function build(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "insight-pages-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = path.join(temp, "dist");
  await mkdir(dist, { recursive: true });
  await copyFile(path.join(ROOT, "sitemap.xml"), path.join(dist, "sitemap.xml"));
  const result = buildInsightPages({ assetsRootDir: ROOT, distDir: dist });
  return { dist, result };
}

test("build renders the study, schedule, press, embed and community pages from the live data", async (t) => {
  const { dist } = await build(t);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  const total = manifest.offices.reduce((sum, office) => sum + (Number(office.decisions) || 0), 0);
  const freshness = loadFreshness(ROOT);
  const checkDates = freshness.offices
    .map((office) => String(office.last_success_at).slice(0, 10))
    .sort();
  // The footer copy cites one check day, or the range when the offices were
  // read on different days.
  const checkRange =
    checkDates[0] === checkDates[checkDates.length - 1]
      ? `offices last successfully checked ${longDate(checkDates[0])}`
      : `offices last successfully checked ${longDate(checkDates[0])} to ${longDate(checkDates[checkDates.length - 1])}`;

  const study = await readFile(path.join(dist, "data-study.html"), "utf8");
  assert.match(study, /What the published Irish visa decisions show/);
  // A cumulative list or snapshot is not comparable with one week of a period
  // report, so the study reports the latest-file rows by basis instead of
  // headlining a sum of both.
  const weeklyTotal = manifest.offices
    .filter((office) => (OFFICE_SERIES_KIND[office.slug] || "weekly") === "weekly")
    .reduce((sum, office) => sum + (Number(office.decisions) || 0), 0);
  const seriesTotal = total - weeklyTotal;
  assert.match(study, new RegExp(`${weeklyTotal.toLocaleString("en-IE")} dated decisions in the latest weekly reports`));
  assert.match(study, new RegExp(`${seriesTotal.toLocaleString("en-IE")} rows in the cumulative and snapshot files`));
  assert.doesNotMatch(study, new RegExp(`${total.toLocaleString("en-IE")} decisions in the latest official files`));
  // The study no longer repeats the site-wide summary cards; the live
  // per-office approval table still carries each office's rate.
  const newDelhi = manifest.offices.find((office) => office.slug === "new-delhi");
  assert.match(study, new RegExp(`${((newDelhi.approved / newDelhi.decisions) * 100).toFixed(1)}%`));
  assert.match(study, /Approval rates by office/);
  assert.match(study, /Method and limits/);
  assert.match(study, /office-summary.csv/);
  assert.doesNotMatch(study, /official reports through/);
  assert.match(study, /latest office publications dated [^)]+; (?:data checked|offices last successfully checked) [^)]+/);
  assert.doesNotMatch(study, /<style[\s>]/i);
  assert.doesNotMatch(study, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)/i);

  const schedule = await readFile(path.join(dist, "when-are-visa-decisions-published.html"), "utf8");
  assert.match(schedule, /Expected next publication by office/);
  assert.match(schedule, /Expected, not guaranteed/);
  // The page renders the windows the freshness model derives, so check the copy
  // against the data this build read instead of a date that moves with it.
  for (const office of freshness.offices) {
    if (!office.due_at) continue;
    const expected = office.due_at >= freshness.as_of ? office.due_at : office.next_due_at;
    assert.ok(schedule.includes(weekdayLongDate(expected)), `${office.slug} expected window`);
    if (office.overdue) {
      assert.ok(schedule.includes(`Due since ${weekdayLongDate(office.due_at)} — not yet published`), `${office.slug} missed window`);
      assert.ok(schedule.includes(`Next expected ${weekdayLongDate(office.next_due_at)}`), `${office.slug} next window`);
    }
  }
  assert.match(schedule, /Check health/);
  assert.match(schedule, /Last successful/);
  assert.match(schedule, /Observation history/);
  assert.match(schedule, /Dates and provenance/);
  assert.match(schedule, /What these dates mean/);
  assert.match(schedule, /api\/calendar\/offices\.ics/);

  const press = await readFile(path.join(dist, "press.html"), "utf8");
  assert.match(press, /Press and citation kit/);
  assert.match(press, new RegExp(`${SITE}/data-study`));
  assert.match(press, /DOI/);
  assert.doesNotMatch(press, /official reports through/);
  // The press kit compares approval shares within a file kind and never sums a
  // one-week report with a year-long cumulative list into one decision total.
  assert.match(press, /Latest period reports/);
  assert.match(press, /Cumulative &amp; snapshot files/);
  assert.doesNotMatch(press, /Latest-file decisions/);
  assert.doesNotMatch(press, /The latest files range from/);
  assert.match(press, /The latest weekly reports run from \d+\.\d% to \d+\.\d% approved/);
  assert.match(press, /and each describes a whole list rather than one week/);
  assert.match(press, /latest office publications dated [^)]+; (?:data checked|offices last successfully checked) [^)]+/);

  const embed = await readFile(path.join(dist, "embed.html"), "utf8");
  assert.match(embed, /Embed the latest official file/);
  assert.match(embed, new RegExp(`${SITE}/badges/new-delhi.svg`));

  const community = await readFile(path.join(dist, "community-timelines.html"), "utf8");
  assert.match(community, /Not enough data to publish an aggregate yet/);
  assert.match(community, /<meta name="robots" content="noindex, follow">/);
  assert.doesNotMatch(community, /Median wait/);

  const openData = await readFile(path.join(dist, "data.html"), "utf8");
  assert.match(openData, /"@type": "Dataset"/);
  assert.match(openData, /"contentUrl": "https:\/\/irishvisaupdatetracker\.pages\.dev\/data\/visa_decisions\.json"/);
  assert.match(openData, /"license": "https:\/\/irishvisaupdatetracker\.pages\.dev\/terms"/);
  assert.match(openData, /"@type": "DataDownload"/);
  assert.match(openData, /<link rel="alternate" type="text\/markdown" href="\/data\.md">/);
  assert.doesNotMatch(openData, /ends with the latest official file/);
  assert.match(openData, /newest office publication is dated/);
  assert.match(openData, /Office dates differ; see the manifest/);
  assert.match(openData, /latest office publications dated [^)]+; (?:data checked|offices last successfully checked) [^)]+/);
  assert.match(openData, new RegExp(`six offices — latest publications dated [^·]+ · ${escapeRegExp(checkRange)}`));

  for (const file of ["data", "data-study", "when-are-visa-decisions-published", "press", "embed", "community-timelines"]) {
    const html = await readFile(path.join(dist, `${file}.html`), "utf8");
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}/`), file);
    assert.match(html, /<main id="main-content"/, file);
    assert.doesNotMatch(html, /style="/i, `${file}: inline style attribute`);
  }
});

test("the today page lists every office's newest file with a build stamp", async (t) => {
  const { dist } = await build(t);
  const html = await readFile(path.join(dist, "irish-visa-decisions-today.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  assert.match(html, /<h1>Irish visa decisions today — <time datetime="\d{4}-\d{2}-\d{2}">\d{1,2} [A-Z][a-z]+ \d{4}<\/time><\/h1>/);
  assert.match(html, /<title>Irish Visa Decisions Today — \d{1,2} [A-Z][a-z]+ \d{4}<\/title>/);
  assert.match(html, /<meta name="description" content="Newest official Irish visa decision file from each of the six offices/);
  assert.match(html, /data-snapshot-day="\d{4}-\d{2}-\d{2}"/);
  assert.match(html, /<strong>Last checked:<\/strong> <time datetime="/);
  assert.match(html, /<strong>Newest official file:<\/strong> <time datetime="/);
  assert.match(html, /<strong>Page built:<\/strong> <time datetime="[^"]+">[^<]+<\/time> Dublin time/);
  assert.doesNotMatch(html, /<strong>Last updated:<\/strong>/);
  assert.match(html, /<section id="changes">/);
  assert.match(html, /<section id="latest">/);
  assert.match(html, /<section id="what-today-means">/);
  assert.match(html, /<section id="check">/);
  assert.match(html, /Daily cross-office views:/);
  assert.match(html, /href="\/decisions\/\d{4}-\d{2}-\d{2}">Latest published view:/);
  assert.match(html, /href="\/decisions\/\d{4}-\d{2}-\d{2}">Previous view:/);
  assert.match(html, /Newer view: none yet/);
  assert.match(html, /<section id="dated-views">/);
  const datedLinks = [...html.matchAll(/href="\/decisions\/\d{4}-\d{2}-\d{2}"/g)];
  assert.ok(datedLinks.length >= 10, `expected the dated-view list, found ${datedLinks.length} links`);
  assert.match(html, /href="\/decisions\/\d{4}-\d{2}-\d{2}">\d{1,2} [A-Z][a-z]+ \d{4}<\/a>/);
  assert.match(html, /New file today|No newer file today/);
  assert.match(html, /"@type": "Dataset"/);
  assert.match(html, /"@type": "ItemList"/);
  const tables = [...html.matchAll(/<table class="office-table[^"]*">([\s\S]*?)<\/table>/g)].map((match) => match[1]);
  assert.equal(tables.length, 2);
  const mainTable = tables.find((table) => table.includes("Newest official file from each office")) || "";
  assert.ok(mainTable, "latest-by-office table is missing");
  assert.match(mainTable, /<caption>Newest official file from each office as of \d{1,2} [A-Z][a-z]+ \d{4}<\/caption>/);
  const tbody = mainTable.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const rows = [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  assert.equal(rows.length, manifest.offices.length);
  for (const office of manifest.offices) {
    const reportDate = String(office.report_date || "").slice(0, 10);
    const row = rows.find((candidate) => candidate.includes(`href="/${office.slug}-visa-decisions"`));
    assert.ok(row, `${office.slug} row is missing from the today table`);
    assert.ok(row.includes(`>${office.name} visa decisions</a>`), `${office.slug} name is missing from its table row`);
    assert.ok(reportDate, `${office.slug} report date is missing from the manifest`);
    assert.match(row, new RegExp(`data-label="Latest publication"><time datetime="${reportDate}"`));
    assert.match(row, new RegExp(`data-label="Decisions">${office.decisions.toLocaleString("en-IE")}</td>`));
    assert.match(row, new RegExp(`data-label="Approved">${office.approved.toLocaleString("en-IE")}</td>`));
    assert.match(row, new RegExp(`data-label="Refused">${office.refused.toLocaleString("en-IE")}</td>`));
    assert.match(row, /data-label="Last successful check"><time datetime="/);
  }

  const changeTable = tables.find((table) => table.includes("Latest distinct file from each office")) || "";
  assert.ok(changeTable, "daily change table is missing");
  const changeBody = changeTable.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const changeRows = [...changeBody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
  assert.equal(changeRows.length, manifest.offices.length);
  const archive = JSON.parse(await readFile(path.join(ROOT, "data", "reports", "index.json"), "utf8"));
  const signature = (entry) => [entry.checksum, entry.decisions, entry.approved, entry.refused, entry.source_file].join("|");
  for (const office of manifest.offices) {
    const entries = (archive.offices[office.slug] || [])
      .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || "")))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    const latest = entries[0];
    assert.ok(latest, `${office.slug} has no archived report`);
    const previous = entries.slice(1).find((entry) => signature(entry) !== signature(latest));
    const row = changeRows.find((candidate) => candidate.includes(`href="/${office.slug}-visa-decisions"`));
    assert.ok(row, `${office.slug} row is missing from the change table`);
    assert.match(row, new RegExp(`data-label="Latest file"><time datetime="${String(latest.report_date).slice(0, 10)}"`));
    if (previous) {
      assert.match(row, new RegExp(`data-label="Previous file"><time datetime="${String(previous.report_date).slice(0, 10)}"`));
      const delta = Number(latest.decisions) - Number(previous.decisions);
      const formatted = delta > 0
        ? `+${Math.abs(delta).toLocaleString("en-IE")}`
        : delta < 0
          ? `-${Math.abs(delta).toLocaleString("en-IE")}`
          : "0";
      assert.ok(row.includes(`(${formatted})`), `${office.slug} decision change is missing`);
    } else {
      assert.match(row, /data-label="Previous file">No earlier distinct file/);
      assert.match(row, /data-label="Decisions">[\d,]+ <span class="small-note">\(first file\)<\/span>/);
    }
  }
  const todayIso = html.match(/<strong>Snapshot day:<\/strong> <time datetime="([^"]+)"/)?.[1] || "";
  assert.ok(todayIso, "today stamp is missing");
  const noNew = manifest.offices.filter((office) => String(office.report_date || "").slice(0, 10) !== todayIso);
  const noNewCallout = html.match(/<strong>Nothing new today:<\/strong>([\s\S]*?)<\/p>/)?.[1] || "";
  if (noNew.length) {
    for (const office of noNew) {
      assert.ok(noNewCallout.includes(`${office.name} (latest `), `${office.slug} missing from the nothing-new callout`);
    }
  } else {
    assert.match(noNewCallout, /Every office has a file dated today/);
  }

  assert.match(html, /<link rel="canonical" href="https:\/\/irishvisaupdatetracker\.pages\.dev\/irish-visa-decisions-today">/);
  const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/irishvisaupdatetracker\.pages\.dev\/irish-visa-decisions-today<\/loc>/);
  assert.match(sitemap, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test("every archived report gets a source-linked permalink and no duplicate snapshot pages", async (t) => {
  const { dist, result } = await build(t);
  const archive = JSON.parse(await readFile(path.join(ROOT, "data", "reports", "index.json"), "utf8"));
  const latest = archive.offices["new-delhi"][0];
  const page = await readFile(
    path.join(dist, "reports", "new-delhi", `${latest.report_date}.html`),
    "utf8",
  );
  assert.match(page, new RegExp(latest.decisions.toLocaleString("en-IE")));
  assert.match(page, new RegExp(latest.approved.toLocaleString("en-IE")));
  assert.match(page, new RegExp(latest.checksum));
  assert.match(page, new RegExp(latest.source_file.replace(/&/g, "&amp;")));
  assert.match(page, new RegExp(`${SITE}/reports/new-delhi/${latest.report_date}`));
  assert.match(page, /BreadcrumbList/);
  assert.match(page, /href="\/irish-visa-decisions-today#changes">What changed since the previous report<\/a>/);

  const dublinDates = new Set(
    archive.offices.dublin.map((entry) => `${entry.decisions}|${entry.approved}|${entry.refused}|${entry.source_file}`),
  );
  const dublinFiles = (await readdir(path.join(dist, "reports", "dublin")))
    .filter((name) => name.endsWith(".html"));
  assert.equal(dublinFiles.length, Math.min(dublinDates.size, 8), "repeated identical snapshots should not get duplicate pages");
  assert.ok(result.reportPages > 10);

  const officeIndex = await readFile(path.join(dist, "reports", "new-delhi.html"), "utf8");
  assert.match(officeIndex, /New Delhi official reports/);
  assert.match(officeIndex, new RegExp(`/reports/new-delhi/${latest.report_date}`));

  const reportsIndex = await readFile(path.join(dist, "reports.html"), "utf8");
  assert.match(reportsIndex, /Every official report in the archive/);
  assert.match(reportsIndex, new RegExp(`/reports/new-delhi/${latest.report_date}`));
  assert.match(reportsIndex, /Tracker observed/);
  assert.match(reportsIndex, /Dates and provenance/);
  assert.match(reportsIndex, /href="\/new-delhi-visa-decisions">New Delhi visa decisions<\/a>/);
  assert.match(reportsIndex, /href="\/irish-visa-decisions-today">Latest Irish visa decisions today<\/a>/);
  assert.match(reportsIndex, /href="\/irish-visa-decisions-today#changes">What changed since the previous report<\/a>/);

  // The wide report tables stack on phones, so every value cell needs its
  // column label in the markup and the permalink key/value tables are marked.
  assert.match(reportsIndex, /class="office-table stack-table"/);
  assert.match(reportsIndex, /data-label="Office"/);
  assert.match(reportsIndex, /data-label="Approval rate"/);
  assert.match(officeIndex, /class="office-table stack-table"/);
  assert.match(officeIndex, /data-label="Change"/);
  assert.equal(
    [...reportsIndex.matchAll(/<td(?![^>]*data-label)[^>]*>/g)].length,
    0,
    "every report archive value cell needs a data-label",
  );
  assert.match(page, /class="office-table meta-table"/);
  assert.match(page, /Observed by tracker/);
  assert.match(page, /not the publication time/);
});

test("badges, study exports, snapshots and sitemap entries are generated", async (t) => {
  const { dist, result } = await build(t);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  const delhi = manifest.offices.find((office) => office.slug === "new-delhi");
  const freshness = loadFreshness(ROOT);
  const badge = await readFile(path.join(dist, "badges", "new-delhi.svg"), "utf8");
  assert.match(badge, /^<svg /);
  assert.match(badge, /New Delhi/);
  assert.match(badge, new RegExp(delhi.decisions.toLocaleString("en-IE")));
  assert.match(badge, /role="img"/);
  assert.ok(badge.includes(`Last successful check ${freshness.bySlug["new-delhi"].last_success_label}`));
  assert.match(badge, /Static snapshot, not a live feed/);
  assert.match(badge, /Current|Check status/);
  const allBadge = await readFile(path.join(dist, "badges", "all.svg"), "utf8");
  assert.match(allBadge, /All six offices/);
  assert.match(allBadge, /Current|Check status/);
  const beijingBadge = await readFile(path.join(dist, "badges", "beijing.svg"), "utf8");
  const beijingFreshness = freshness.bySlug.beijing;
  assert.ok(beijingBadge.includes(`Last successful check ${beijingFreshness.last_success_label}`));
  if (beijingFreshness.status === "error") {
    assert.match(beijingBadge, /latest check failed/);
  } else {
    assert.doesNotMatch(beijingBadge, /latest check failed/);
  }

  const summary = await readFile(path.join(dist, "data", "study", "office-summary.csv"), "utf8");
  assert.match(summary, /^office,slug,latest_report_date,decisions,approved,refused/);
  assert.match(summary, /new-delhi/);
  const monthly = await readFile(path.join(dist, "data", "study", "monthly-volume.csv"), "utf8");
  assert.match(monthly, /^month,label,abu_dhabi,abuja,ankara,new_delhi_file_growth,total/);
  const chart = await readFile(path.join(dist, "data", "study", "approval-rates.svg"), "utf8");
  assert.match(chart, /Approval rate by office/);

  const metadata = JSON.parse(
    await readFile(path.join(dist, "data", "snapshots", result.asOf, "metadata.json"), "utf8"),
  );
  assert.equal(metadata.version, result.asOf);
  assert.equal(metadata.offices.length, manifest.offices.length);
  assert.equal(metadata.doi, null);
  assert.equal(metadata.citation_file, `/data/snapshots/${result.asOf}/CITATION.cff`);
  const citation = await readFile(
    path.join(dist, "data", "snapshots", result.asOf, "CITATION.cff"),
    "utf8",
  );
  assert.match(citation, /^cff-version: 1\.2\.0/);
  assert.match(citation, /date-released: "\d{4}-\d{2}-\d{2}"/);
  const zenodo = JSON.parse(await readFile(
    path.join(dist, "data", "snapshots", result.asOf, "zenodo.json"),
    "utf8",
  ));
  assert.equal(zenodo.version, result.asOf);
  assert.equal(zenodo.access_right, "open");

  const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  for (const route of ["/data", "/data-study", "/reports", "/reports/new-delhi", `/reports/new-delhi/${delhi.report_date}`]) {
    assert.match(sitemap, new RegExp(`${SITE}${route}<`), route);
  }
});
