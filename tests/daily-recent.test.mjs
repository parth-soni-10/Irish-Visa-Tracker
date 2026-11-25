import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectDailyRecent, recentDays, recentDaysHtml } from "../tools/daily-recent.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const ROWS = [
  ["2026-11-24", "IRL2026000001", "Approved"],
  ["2026-11-24", "IRL2026000002", "Refused"],
  ["2026-11-24", "IRL2026000003", "approved"],
  ["2026-11-20", "IRL2026000004", "Approved"],
  ["NO_FILE_2026-11-21", "", ""],
  ["2026-11-21", "NO_FILE_2026-11-21", "Notice"],
  ["2026-11-19", "IRL2026000005", "Refused"],
];

test("recent days count approved and refused and drop closure notices", () => {
  const days = recentDays(ROWS, 10);
  assert.deepEqual(days.map((day) => day.date), ["2026-11-24", "2026-11-20", "2026-11-19"]);
  assert.deepEqual(days[0], { date: "2026-11-24", approved: 2, refused: 1, decisions: 3 });
  assert.equal(days.length, 3, "a closure notice is not a decision day");
});

test("the limit keeps the newest days", () => {
  assert.deepEqual(recentDays(ROWS, 1).map((day) => day.date), ["2026-11-24"]);
});

test("the table is static HTML with one row per day", () => {
  const html = recentDaysHtml(recentDays(ROWS), { fileExists: () => false });
  assert.equal((html.match(/<tr>/g) || []).length, 4, "one header row and three day rows");
  assert.match(html, /<th scope="row"><time datetime="2026-11-24">24 November 2026<\/time><\/th>/);
  assert.match(html, /<td data-label="Decisions">3<\/td>/);
  assert.match(html, /A date with no official file is a closure or a gap/);
});

test("a day links its report page only when that page exists", () => {
  const linked = recentDaysHtml(recentDays(ROWS), { fileExists: (date) => date === "2026-11-24" });
  assert.match(linked, /<a href="\/reports\/new-delhi\/2026-11-24"><time datetime="2026-11-24">/);
  assert.doesNotMatch(linked, /href="\/reports\/new-delhi\/2026-11-20"/);
});

test("the build injection fills the placeholder and the checked-in page is filled", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "daily-recent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "daily-summaries.html"),
    '<main><div data-daily-recent><p>placeholder</p></div></main>\n');
  const result = injectDailyRecent({ assetsRootDir: ROOT, distDir: dir });
  assert.equal(result.written, true);
  const html = await readFile(path.join(dir, "daily-summaries.html"), "utf8");
  assert.doesNotMatch(html, /placeholder/);
  assert.match(html, /<table class="office-table stack-table">/);

  const source = await readFile(path.join(ROOT, "daily-summaries.html"), "utf8");
  assert.match(source, /<section id="recent-days">/);
  assert.doesNotMatch(source, /Recent-day counts are added at build time/);
});
