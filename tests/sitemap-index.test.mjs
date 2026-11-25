import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sitemapFamily, splitSitemap } from "../tools/sitemap-index.mjs";

const SITE = "https://irishvisaupdatetracker.pages.dev";

const URLS = [
  ["/", "2026-11-24"],
  ["/new-delhi-visa-decisions", "2026-11-25"],
  ["/reports/new-delhi", "2026-11-23"],
  ["/reports/new-delhi/2026-11-23", "2026-11-23"],
  ["/reports/beijing/2026-11-01", "2026-11-01"],
  ["/decisions", "2026-11-24"],
  ["/decisions/2026-11-24", "2026-11-24"],
  ["/monthly-report/2026-10", "2026-10-31"],
  ["/all-pages", "2026-11-25"],
];

test("routes are classified into four page families", () => {
  assert.equal(sitemapFamily("/"), "pages");
  assert.equal(sitemapFamily("/new-delhi-visa-decisions"), "offices");
  assert.equal(sitemapFamily("/reports/abuja"), "offices");
  assert.equal(sitemapFamily("/reports/abuja/2026-11-07"), "reports");
  assert.equal(sitemapFamily("/decisions"), "decisions");
  assert.equal(sitemapFamily("/decisions/2026-11-24"), "decisions");
  assert.equal(sitemapFamily("/monthly-report/2026-10"), "decisions");
  assert.equal(sitemapFamily("/all-pages"), "pages");
});

test("the split writes one urlset per family and an index at /sitemap.xml", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sitemap-split-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const blocks = URLS.map(([loc, lastmod]) => `  <url>\n    <loc>${SITE}${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`);
  await writeFile(path.join(dir, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${blocks.join("\n")}\n</urlset>\n`);

  const result = splitSitemap(dir, { siteOrigin: SITE });
  assert.equal(result.split, true);
  assert.deepEqual(result.counts, { pages: 2, offices: 2, reports: 2, decisions: 3 });
  assert.equal(result.total, 9);

  const index = await readFile(path.join(dir, "sitemap.xml"), "utf8");
  assert.match(index, /<sitemapindex/);
  for (const family of ["pages", "offices", "reports", "decisions"]) {
    assert.match(index, new RegExp(`<loc>${SITE}/sitemap-${family}\\.xml</loc>`));
    const child = await readFile(path.join(dir, `sitemap-${family}.xml`), "utf8");
    assert.match(child, /<urlset/);
    assert.doesNotMatch(child, /<sitemapindex/);
  }
  const reports = await readFile(path.join(dir, "sitemap-reports.xml"), "utf8");
  assert.match(reports, /<loc>https:\/\/irishvisaupdatetracker\.pages\.dev\/reports\/new-delhi\/2026-11-23<\/loc>/);
  assert.doesNotMatch(reports, /\/reports\/new-delhi</, "an office report index belongs to the office family");

  // Rerunning must not nest indexes.
  const again = splitSitemap(dir, { siteOrigin: SITE });
  assert.equal(again.split, false);
  assert.equal(again.reason, "already split");
  assert.equal(again.total, 9);
});

test("a missing sitemap is reported, not guessed", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sitemap-missing-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const result = splitSitemap(dir);
  assert.equal(result.split, false);
  assert.equal(result.total, 0);
});
