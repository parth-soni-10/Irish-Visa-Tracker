import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadFreshness } from "../tools/freshness.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

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
    assert.equal(office.decisions_through, office.observed_data_through, office.slug);
    assert.ok(office.official_data_through, `${office.slug} needs an official data-through date`);
    assert.ok(
      office.observed_data_through >= office.official_data_through,
      `${office.slug}: observation cannot predate the official file`,
    );
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
  assert.equal(beijing.last_attempt_at.slice(0, 10), freshness.as_of);
  assert.equal(beijing.status, "error");

  const newDelhi = freshness.bySlug["new-delhi"];
  assert.equal(newDelhi.official_data_through, newDelhi.report_date);
  assert.ok(newDelhi.observed_data_through > newDelhi.official_data_through);
  assert.equal(newDelhi.observation_scope, "tracker");
  assert.match(
    newDelhi.observation_note,
    new RegExp(`Tracker observed decisions dated through ${longDate(newDelhi.observed_data_through)}; these are not in the ${longDate(newDelhi.official_data_through)} official file\\.`),
  );
  assert.match(newDelhi.summary, new RegExp(`${newDelhi.decisions.toLocaleString("en-IE")} decisions`));
  assert.match(newDelhi.summary, new RegExp(`report ${longDate(newDelhi.report_date)}`));
  assert.doesNotMatch(newDelhi.summary, new RegExp(longDate(newDelhi.observed_data_through)));
  assert.equal(newDelhi.expected_rule.kind, "weekday");
  assert.ok(newDelhi.observation_lag.sample_size > 0);
  assert.equal(newDelhi.observation_lag.median_days, 2);
  assert.ok(newDelhi.observation_lag.history.length > 0);
  assert.equal(freshness.bySlug.beijing.observation_lag.sample_size, 1);
});

test("official surfaces keep their data-through separate from tracker observation", async () => {
  const [status, home, office, dataPage] = await Promise.all([
    read("status.html"),
    read("index.html"),
    read("new-delhi-visa-decisions.html"),
    read("data.html"),
  ]);
  const freshness = loadFreshness(ROOT);
  const newDelhi = freshness.bySlug["new-delhi"];
  const official = longDate(newDelhi.official_data_through);
  const observed = longDate(newDelhi.observed_data_through);
  const count = newDelhi.decisions.toLocaleString("en-IE");

  assert.ok(status.includes(
    `data-label="Official data through"><time datetime="${newDelhi.official_data_through}">${official}</time><br><span class="small-note" data-observation="tracker">Tracker observed through ${observed}`,
  ));
  assert.match(
    home,
    new RegExp(`${count} New Delhi decisions in the latest official file \\(report ${longDate(newDelhi.report_date)}\\)[\\s\\S]*Tracker observed decisions dated through ${observed}`),
  );
  assert.match(office, new RegExp(`${count} decisions`));
  assert.match(office, new RegExp(`report ${longDate(newDelhi.report_date)}`));
  assert.ok(office.includes(
    `office-freshness-observation">Tracker observed decisions dated through ${observed}; these are not in the ${official} official file.`,
  ));
  assert.ok(dataPage.includes(
    `New Delhi official decisions through ${official} · tracker observed through ${observed} (not in the official file)`,
  ));
  assert.match(status, /data-freshness-footer/);
  assert.match(status, /data-freshness-history/);
  assert.ok(status.includes(`data-iv-time="${newDelhi.last_success_at}"`));
  assert.match(status, /What these dates mean/);
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
  assert.ok(newDelhi.due_at >= newDelhi.report_date);
  assert.equal(newDelhi.overdue, false, "the next scheduled file is not overdue before its window closes");
  assert.match(newDelhi.due_label, new RegExp(`Expected ${longDate(newDelhi.due_at)}`));
});

test("citation pages use the oldest office check, not the newest build date", async () => {
  const freshness = loadFreshness(ROOT);
  const checkDates = freshness.offices
    .map((office) => String(office.last_success_at).slice(0, 10))
    .sort();
  const range = `offices last successfully checked ${longDate(checkDates[0])} to ${longDate(checkDates[checkDates.length - 1])}`;
  for (const file of ["data.html", "data-study.html", "press.html"]) {
    const html = await read(file);
    assert.ok(html.includes(range), `${file} should cite the full office check range`);
    assert.doesNotMatch(html, new RegExp(`data checked ${longDate(checkDates[checkDates.length - 1])}`), file);
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
