import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadFreshness } from "../tools/freshness.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function read(name) {
  return readFile(path.join(ROOT, name), "utf8");
}

test("freshness.json makes every date role explicit and keeps success separate from attempts", async () => {
  const freshness = loadFreshness(ROOT);
  const saved = JSON.parse(await read("data/freshness.json"));
  assert.equal(saved.generated_at, freshness.generated_at);
  assert.equal(saved.as_of, freshness.as_of);
  assert.deepEqual(saved.offices, freshness.offices);

  for (const office of freshness.offices) {
    assert.equal(office.published_at, office.report_date, office.slug);
    assert.equal(office.decisions_through, office.latest_decision_date, office.slug);
    assert.equal(office.checked_at, office.last_success_at, office.slug);
    assert.ok(office.checked_label, `${office.slug} needs a checked label`);
    assert.match(office.age_label, /^\d+ days? old$/, office.slug);
    assert.equal(typeof office.overdue, "boolean", office.slug);
    if (office.due_at) assert.ok(office.due_label, `${office.slug} needs a due/expected label`);
    else assert.equal(office.due_label, "", `${office.slug} has no fixed publication window`);
    if (office.last_success_at && office.last_attempt_at) {
      assert.ok(
        Date.parse(office.last_success_at) <= Date.parse(office.last_attempt_at),
        `${office.slug}: a successful check cannot be later than the last attempt`,
      );
    }
  }

  const beijing = freshness.bySlug.beijing;
  assert.equal(beijing.last_success_at.slice(0, 10), "2026-11-18");
  assert.equal(beijing.last_attempt_at.slice(0, 10), "2026-11-21");
  assert.equal(beijing.status, "error");
});

test("missed publication windows stay visible instead of rolling forward", () => {
  const freshness = loadFreshness(ROOT);
  const abuja = freshness.bySlug.abuja;
  assert.equal(abuja.due_at, "2026-11-14");
  assert.equal(abuja.overdue, true);
  assert.match(abuja.due_label, /Due since 14 November 2026 — not yet published/);
  assert.match(abuja.next_due_label, /Next expected 28 November 2026/);
  assert.equal(abuja.status_tone, "warn");

  const newDelhi = freshness.bySlug["new-delhi"];
  assert.equal(newDelhi.due_at, "2026-11-20");
  assert.equal(newDelhi.overdue, false, "a Friday file is not overdue on a Saturday");
  assert.match(newDelhi.due_label, /Expected 23 November 2026/);
});

test("citation pages use the oldest office check, not the newest build date", async () => {
  for (const file of ["data.html", "data-study.html", "press.html"]) {
    const html = await read(file);
    assert.match(
      html,
      /offices last successfully checked 18 November 2026 to 21 November 2026/,
      file,
    );
    assert.doesNotMatch(html, /data checked 21 November 2026/, file);
  }
  const dataPage = await read("data.html");
  assert.match(dataPage, /2 offices need attention: Beijing, Abuja/);
});

test("the daily page separates official file, observed day and decision date", async () => {
  const html = await read("daily-summaries.html");
  assert.match(html, /<strong>Official file day<\/strong>/);
  assert.match(html, /<strong>Tracker-observed day<\/strong>/);
  assert.match(html, /<strong>Decision date<\/strong>/);
  assert.match(html, /partial observation; not in the official file/);
  assert.doesNotMatch(html, /Published day<\/strong> - the date the embassy published the file/);
  assert.match(html, /Latest official file:/);
  assert.match(html, /Last successful check:/);
});

test("the latest monthly page states its data-through date and partial month", async () => {
  const html = await read("monthly-report.html");
  assert.match(html, /id="report-data-through">Data to \d{1,2} [A-Z][a-z]+ \d{4}\./);
  assert.match(html, /November 2026 is a partial month: totals cover dated decisions recorded so far\./);
});
