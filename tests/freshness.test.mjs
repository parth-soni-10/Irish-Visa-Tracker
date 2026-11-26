import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadFreshness } from "../tools/freshness.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Page assertions read the build output when a caller provides it. The scrape
// job sets SITE_HTML_BASE=.pages-dist: it rebuilds the data, so the checked-in
// root pages are a snapshot from before that refresh. Data files always come
// from the repository root.
const PAGES = path.resolve(ROOT, process.env.SITE_HTML_BASE || ".");
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

async function readPage(name) {
  return readFile(path.join(PAGES, name), "utf8");
}

assert.ok(fs.existsSync(path.join(PAGES, "status.html")), `missing status.html under ${PAGES}`);

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

  // Every office is attempted on each run. When the latest attempt failed, its
  // timestamp and label must stay separate from the last successful check; no
  // office should report a stale success as if it were today's read.
  for (const office of freshness.offices) {
    assert.equal(
      String(office.last_attempt_at).slice(0, 10),
      freshness.as_of,
      `${office.slug}: the latest attempt belongs to the data date`,
    );
    if (office.status === "error") {
      assert.notEqual(
        office.last_success_label,
        office.last_attempt_label,
        `${office.slug}: a failed attempt must not read as a successful check`,
      );
    }
  }

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
  assert.ok(
    Number.isInteger(freshness.bySlug.beijing.observation_lag.sample_size),
    "Beijing keeps an observation-lag record",
  );
});

test("official surfaces keep their data-through separate from tracker observation", async () => {
  const [status, home, office, dataPage] = await Promise.all([
    readPage("status.html"),
    readPage("index.html"),
    readPage("new-delhi-visa-decisions.html"),
    readPage("data.html"),
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
  // The source office page reads "latest official report: <date>"; the build
  // replaces that line with the canonical "report <date> · N decisions" one.
  // Both facts are what matters, so accept either rendering.
  assert.match(
    office,
    new RegExp(`(?:latest official report: |report )${longDate(newDelhi.report_date)}`),
  );
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
  const first = checkDates[0];
  const last = checkDates[checkDates.length - 1];
  // A single check day cites that day; a spread cites the whole range and must
  // not pass the newest check off as if it were the oldest.
  const copy =
    first === last
      ? `offices last successfully checked ${longDate(first)}`
      : `offices last successfully checked ${longDate(first)} to ${longDate(last)}`;
  for (const file of ["data.html", "data-study.html", "press.html"]) {
    const html = await readPage(file);
    assert.ok(html.includes(copy), `${file} should cite the office check date(s)`);
    if (first !== last) {
      assert.doesNotMatch(html, new RegExp(`data checked ${longDate(last)}`), file);
    }
  }
  const dataPage = await readPage("data.html");
  const attention = freshness.offices
    .filter((office) => office.status === "error" || office.overdue)
    .map((office) => office.name);
  if (attention.length) {
    const copy = `${attention.length} office${attention.length === 1 ? "" : "s"} need${attention.length === 1 ? "s" : ""} attention: ${attention.join(", ")}`;
    assert.ok(dataPage.includes(copy), `data.html should name the offices that need attention (${copy})`);
  } else {
    assert.doesNotMatch(dataPage, /offices? needs? attention:/);
  }
});

test("the daily page separates official file, observed day and decision date", async () => {
  const html = await readPage("daily-summaries.html");
  assert.match(html, /<strong>Official file day<\/strong>/);
  assert.match(html, /<strong>Tracker-observed day<\/strong>/);
  assert.match(html, /<strong>Decision date<\/strong>/);
  assert.match(html, /partial observation; not in the official file/);
  assert.doesNotMatch(html, /Published day<\/strong> - the date the embassy published the file/);
  assert.match(html, /Latest official file:/);
  assert.match(html, /Last successful check:/);
});

test("the latest monthly page states its data-through date and partial month", async () => {
  const html = await readPage("monthly-report.html");
  assert.match(html, /id="report-data-through">Data to \d{1,2} [A-Z][a-z]+ \d{4}\./);
  assert.match(html, /November 2026 is a partial month: totals cover dated decisions recorded so far\./);
});
