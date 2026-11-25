import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectHomeLatestReports } from "../tools/deploy-pages.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

test("homepage latest-report block links the newest permalink and office page for every office", async (t) => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  const archive = JSON.parse(await readFile(path.join(ROOT, "data", "reports", "index.json"), "utf8"));
  assert.ok(Array.isArray(manifest.offices));
  assert.ok(archive.offices);

  const temp = await mkdtemp(path.join(os.tmpdir(), "homepage-latest-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const assets = path.join(temp, "assets");
  const dist = path.join(temp, "dist");
  const data = path.join(assets, "data");
  await mkdir(path.join(data, "reports"), { recursive: true });
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(data, "data_manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(data, "reports", "index.json"), JSON.stringify(archive));
  await writeFile(
    path.join(dist, "index.html"),
    '<section class="latest-official"><ul data-latest-official-list><li>STALE-report</li></ul></section>',
  );

  const expected = [];
  for (const office of manifest.offices) {
    const dates = (archive.offices[office.slug] || [])
      .map((entry) => String(entry.report_date).slice(0, 10))
      .sort((a, b) => b.localeCompare(a));
    const latest = dates[0];
    assert.ok(latest, `${office.slug} has a dated report`);
    await mkdir(path.join(dist, "reports", office.slug), { recursive: true });
    await writeFile(path.join(dist, "reports", office.slug, `${latest}.html`), "report");
    await writeFile(path.join(dist, `${office.slug}-visa-decisions.html`), "office");
    expected.push({ office, latest });
  }

  injectHomeLatestReports({ assetsRootDir: assets, distDir: dist });

  const html = await readFile(path.join(dist, "index.html"), "utf8");
  assert.doesNotMatch(html, /STALE-report/);
  for (const { office, latest } of expected) {
    assert.match(html, new RegExp(`data-latest-office="${office.slug}"`), office.slug);
    assert.ok(html.includes(`href="/reports/${office.slug}/${latest}"`), `${office.slug} latest report link`);
    assert.ok(html.includes(`href="/${office.slug}-visa-decisions"`), `${office.slug} office link`);
  }
});

test("homepage latest block keeps today and VFS links and the footer links the all-pages index", async () => {
  const homepage = await readFile(path.join(ROOT, "index.html"), "utf8");
  const block = homepage.match(/<section class="latest-official"[\s\S]*?<\/section>/);
  assert.ok(block, "latest official reports block is missing");
  assert.match(block[0], /Latest official reports/);
  assert.match(block[0], /href="\/irish-visa-decisions-today"/);
  assert.match(block[0], /href="\/vfs-tracking"/);
  for (const slug of ["new-delhi", "beijing", "abu-dhabi", "abuja", "ankara", "dublin"]) {
    assert.match(block[0], new RegExp(`href="\/${slug}-visa-decisions"`), slug);
  }
  const footer = homepage.match(/<!-- site-footer:start -->[\s\S]*?<!-- site-footer:end -->/);
  assert.ok(footer, "shared footer is missing");
  assert.match(footer[0], /All pages index:/);
  assert.match(footer[0], /href="\/all-pages"/);
  assert.match(footer[0], /href="\/sitemap\.xml"/);
});