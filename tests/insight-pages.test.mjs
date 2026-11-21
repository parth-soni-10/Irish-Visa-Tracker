import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildInsightPages, publicationDateCopy } from "../tools/insight-pages.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = "https://irishvisaupdatetracker.pages.dev";

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

  const study = await readFile(path.join(dist, "data-study.html"), "utf8");
  assert.match(study, /What the published Irish visa decisions show/);
  assert.match(study, new RegExp(total.toLocaleString("en-IE")));
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
  assert.match(schedule, /Due since Saturday 14 November 2026 — not yet published/);
  assert.match(schedule, /Next expected Saturday 28 November 2026/);
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
  assert.match(press, /latest office publications dated [^)]+; (?:data checked|offices last successfully checked) [^)]+/);

  const embed = await readFile(path.join(dist, "embed.html"), "utf8");
  assert.match(embed, /Embed the latest official file/);
  assert.match(embed, new RegExp(`${SITE}/badges/new-delhi.svg`));

  const community = await readFile(path.join(dist, "community-timelines.html"), "utf8");
  assert.match(community, /Not enough data to publish an aggregate yet/);
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
  assert.match(openData, /six offices — latest publications dated [^·]+ · offices last successfully checked 18 November 2026 to 21 November 2026/);

  for (const file of ["data", "data-study", "when-are-visa-decisions-published", "press", "embed", "community-timelines"]) {
    const html = await readFile(path.join(dist, `${file}.html`), "utf8");
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}/`), file);
    assert.match(html, /<main id="main-content"/, file);
    assert.doesNotMatch(html, /style="/i, `${file}: inline style attribute`);
  }
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
  const badge = await readFile(path.join(dist, "badges", "new-delhi.svg"), "utf8");
  assert.match(badge, /^<svg /);
  assert.match(badge, /New Delhi/);
  assert.match(badge, new RegExp(delhi.decisions.toLocaleString("en-IE")));
  assert.match(badge, /role="img"/);
  assert.match(badge, /Last successful check 21 Nov 2026, \d{2}:\d{2} UTC/);
  assert.match(badge, /Static snapshot, not a live feed/);
  const beijingBadge = await readFile(path.join(dist, "badges", "beijing.svg"), "utf8");
  assert.match(beijingBadge, /Last successful check 18 Nov 2026, 06:01 UTC/);
  assert.match(beijingBadge, /latest check failed/);

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

  const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  for (const route of ["/data", "/data-study", "/reports", "/reports/new-delhi", `/reports/new-delhi/${delhi.report_date}`]) {
    assert.match(sitemap, new RegExp(`${SITE}${route}<`), route);
  }
});
