import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectHomepageDates, injectLatestReports, injectTodayLine } from "../tools/deploy-pages.mjs";
import { loadFreshness } from "../tools/freshness.mjs";
import { DEFAULT_SITE_ORIGIN, siteOrigin } from "../tools/site-config.mjs";
import { buildLastmodMap, updateSitemap } from "../tools/sitemap-lastmod.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

async function latestRunDate(name) {
  const rows = JSON.parse(await readFile(path.join(ROOT, "data", name), "utf8"));
  return rows.map((row) => String(row.run_date).slice(0, 10)).sort().at(-1);
}

test("custom origins are https-only bare origins", () => {
  assert.equal(siteOrigin({}), DEFAULT_SITE_ORIGIN);
  assert.equal(siteOrigin({ SITE_ORIGIN: "https://example.ie" }), "https://example.ie");
  assert.equal(siteOrigin({ SITE_ORIGIN: "https://example.ie/" }), "https://example.ie");
  assert.equal(siteOrigin({ SITE_ORIGIN: "http://example.ie" }), DEFAULT_SITE_ORIGIN);
  assert.equal(siteOrigin({ SITE_ORIGIN: "https://example.ie/path" }), DEFAULT_SITE_ORIGIN);
  assert.equal(siteOrigin({ SITE_ORIGIN: "https://user:pass@example.ie" }), DEFAULT_SITE_ORIGIN);
});

test("status gets a build-time latest-report row for every office", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "status-latest-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await copyFile(path.join(ROOT, "status.html"), path.join(temp, "status.html"));
  injectLatestReports({ assetsRootDir: ROOT, distDir: temp });
  const html = await readFile(path.join(temp, "status.html"), "utf8");
  const freshness = loadFreshness(ROOT);
  const beijing = freshness.bySlug.beijing;
  assert.match(html, /<th scope="col">Last successful check<\/th>/);
  assert.match(html, /<th scope="col">What this means for your search<\/th>/);
  assert.match(html, /<th scope="col">Details<\/th>/);
  assert.match(html, /id="latest-reports-generated"[^>]*datetime="\d{4}-\d{2}-\d{2}T[^"]+Z"/);
  assert.match(html, /id="latest-reports-generated"[^>]*>[^<]*UTC<\/time>/);
  assert.ok(html.includes(beijing.age_label_at_build), "Beijing shows its build-time age");
  if (beijing.due_short_label) assert.ok(html.includes(beijing.due_short_label), "Beijing shows its due label");
  assert.ok(beijing.last_success_label, "Beijing should have a last successful check label");
  assert.ok(html.includes(beijing.last_success_label), "status should show Beijing's last successful check");
  assert.ok(html.includes(beijing.last_attempt_label), "status should show Beijing's last attempt");
  assert.notEqual(beijing.last_success_label, beijing.last_attempt_label, "a failed attempt must not look like a successful check");
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  for (const office of manifest.offices) {
    assert.match(html, new RegExp(`<strong>${office.name}</strong>`), office.slug);
    assert.match(html, new RegExp(`href="/${office.slug}-visa-decisions"`), office.slug);
  }
  assert.ok(html.includes("We couldn't refresh Beijing this time."), "Beijing explains the search impact");
  assert.ok(html.includes("The Abuja report is overdue"), "Abuja explains the search impact");
  const newDelhi = freshness.bySlug["new-delhi"];
  assert.ok(html.includes(`<time datetime="${newDelhi.report_date}">${longDate(newDelhi.report_date)}</time>`));
  const tbody = html.match(/<tbody[^>]*data-latest-reports[^>]*>([\s\S]*?)<\/tbody>/)[1];
  assert.doesNotMatch(tbody, /Loading/);
});

test("the homepage today line is rewritten from the newest publication", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "today-line-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await copyFile(path.join(ROOT, "index.html"), path.join(temp, "index.html"));
  injectTodayLine({ assetsRootDir: ROOT, distDir: temp });
  const html = await readFile(path.join(temp, "index.html"), "utf8");
  assert.match(
    html,
    /As of [^<]+, (?:the newest official office publication is dated [^<]+\. No office has published a newer decision file today\.|an official decision file dated today has been published\.)/,
  );
  assert.match(html, /data-today-line/);
});

test("the homepage Dataset dates come from their own data files", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-dates-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = await readFile(path.join(ROOT, "index.html"), "utf8");
  // Simulate the stale checked-in value the injection must replace.
  const stale = source.replace(/"dateModified": "\d{4}-\d{2}-\d{2}"/g, '"dateModified": "2026-11-07"');
  await writeFile(path.join(temp, "index.html"), stale);
  injectHomepageDates({ assetsRootDir: ROOT, distDir: temp });
  const html = await readFile(path.join(temp, "index.html"), "utf8");
  assert.doesNotMatch(html, /"dateModified": "2026-11-07"/);
  const freshness = loadFreshness(ROOT);
  const visaDate = String(freshness.bySlug["new-delhi"].last_success_at).slice(0, 10);
  const stampDate = await latestRunDate("stamp_1g.json");
  const permitDate = await latestRunDate("work_permits.json");
  assert.match(html, new RegExp(`#dataset-visa-decisions"[\\s\\S]*?"dateModified": "${visaDate}"`));
  assert.match(html, new RegExp(`#dataset-stamp-1g"[\\s\\S]*?"dateModified": "${stampDate}"`));
  assert.match(html, new RegExp(`#dataset-work-permits"[\\s\\S]*?"dateModified": "${permitDate}"`));
});

test("sitemap lastmod follows each page's data, not the build date", async () => {
  const map = buildLastmodMap(ROOT);
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  for (const office of manifest.offices) {
    assert.equal(map.get(`/${office.slug}-visa-decisions`), office.report_date, office.slug);
  }
  assert.equal(map.get("/about"), "2026-11-21");
  assert.equal(map.get("/monthly-report/2026-10"), "2026-10-31");
  assert.ok(map.get("/stamp-1g-processing-dates"));
  assert.ok(map.get("/employment-permit-processing-dates"));

  const temp = await mkdtemp(path.join(os.tmpdir(), "sitemap-lastmod-"));
  try {
    const file = path.join(temp, "sitemap.xml");
    await copyFile(path.join(ROOT, "sitemap.xml"), file);
    const result = updateSitemap(file, map);
    assert.ok(result.updated > 20);
    assert.equal(result.removed, 0);
    const xml = await readFile(file, "utf8");
    for (const [, block] of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
      assert.match(block, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("social cards are 1200x630 PNGs for every office and month", async () => {
  const files = [
    "office-new-delhi.png", "office-beijing.png", "office-abu-dhabi.png",
    "office-abuja.png", "office-ankara.png", "office-dublin.png",
    "month-2026-01.png", "month-2026-10.png", "month-2026-11.png",
  ];
  for (const file of files) {
    const buffer = await readFile(path.join(ROOT, "assets", "social", file));
    assert.equal(buffer.subarray(1, 4).toString(), "PNG", file);
    assert.equal(buffer.readUInt32BE(16), 1200, file);
    assert.equal(buffer.readUInt32BE(20), 630, file);
  }
});
