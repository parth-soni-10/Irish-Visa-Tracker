import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

import { buildMonthlyPages } from "../tools/monthly-pages.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SITE = "https://irishvisaupdatetracker.pages.dev";

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
  assert.equal(result.latestMonth, "2026-11");
  assert.ok(result.pages >= 10, "expected the latest page and prior months");

  const html = await readFile(path.join(dist, "monthly-report.html"), "utf8");
  assert.match(html, /class="cards" id="summary-cards"/);
  assert.match(html, /<div class="value">1,201<\/div>/);
  assert.match(html, /class="month-nav"/);
  assert.match(html, /href="\/monthly-report\/2026-10"/);
  assert.match(html, /id="report-month"[^>]*value="2026-11"/);
  assert.match(html, /id="report-data-through">Data to 20 November 2026\. November 2026 is a partial month/);
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
});

test("prior months are self-canonical archive pages without a duplicate current month", async (t) => {
  const { dist } = await build(t);
  const archive = await readFile(path.join(dist, "monthly-report", "2026-10.html"), "utf8");
  assert.match(archive, /Data to 30 October 2026/);
  assert.doesNotMatch(archive, /October 2026 is a partial month/);
  assert.match(archive, /<title>Irish visa decisions — October 2026 \| Monthly report<\/title>/);
  assert.match(archive, new RegExp(`<link rel="canonical" href="${SITE}/monthly-report/2026-10">`));
  assert.match(archive, /assets\/social\/month-2026-10\.png/);
  assert.doesNotMatch(archive, /href="\/monthly-report\/2026-11"/);
  assert.match(archive, /By visa office/);
  assert.match(archive, /Daily dated decisions/);
  assert.doesNotMatch(archive, /Loading/);
  assert.match(archive, /href="\/monthly-report\/2026-09"/);

  await assert.rejects(
    stat(path.join(dist, "monthly-report", "2026-11.html")),
    /ENOENT/,
    "the current month belongs on /monthly-report, not a duplicate archive URL",
  );

  const sitemap = await readFile(path.join(dist, "sitemap.xml"), "utf8");
  assert.match(sitemap, new RegExp(`${SITE}/monthly-report/2026-10`));
  assert.doesNotMatch(sitemap, new RegExp(`${SITE}/monthly-report/2026-11<`));
});
