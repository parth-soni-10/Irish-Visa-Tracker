import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function longDate(value) {
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1]} ${year}`;
}

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function columns(section) {
  return [...section.matchAll(/<th scope="col">([^<]+)<\/th>/g)]
    .map((match) => match[1].trim());
}

test("status page answers search freshness and keeps provenance in details", async () => {
  const [html, manifestSource, freshnessSource] = await Promise.all([
    read("status.html"),
    read("data/data_manifest.json"),
    read("data/freshness.json"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const freshness = JSON.parse(freshnessSource);

  const section = html.match(/<section id="office-coverage">[\s\S]*?<\/thead>/)?.[0] || "";
  const coverageColumns = columns(section);
  assert.equal(coverageColumns.length, 5);
  assert.deepEqual(coverageColumns, [
    "Office",
    "What this means for your search",
    "Latest official report",
    "Last successful check",
    "Details",
  ]);
  assert.ok(!coverageColumns.includes("Approved share"));
  assert.equal((html.match(/<section id="office-coverage">/g) || []).length, 1);
  assert.doesNotMatch(html, /id="latest-report-by-office"/);

  const body = html.match(/<tbody[^>]*data-latest-reports[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const rows = [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((match) => match[0]);
  assert.equal(rows.length, manifest.offices.length);
  for (const row of rows) {
    assert.equal((row.match(/<td\b/g) || []).length, 5, row);
    assert.ok(row.includes("<details><summary>Provenance and counts</summary>"), row);
    assert.ok(row.includes("Last attempt"), row);
    assert.ok(row.includes("Approved share"), row);
  }

  const beijing = freshness.offices.find((office) => office.slug === "beijing");
  const newDelhi = freshness.offices.find((office) => office.slug === "new-delhi");
  const beijingRow = rows.find((row) => row.includes(">Beijing<"));
  assert.ok(beijingRow, "Beijing row should render");
  assert.ok(beijingRow.includes("Couldn't refresh"), "Beijing status uses plain language");
  assert.ok(beijingRow.includes("We couldn't refresh Beijing this time."), "Beijing explains the search impact");
  assert.ok(beijingRow.includes(beijing.last_success_label), "Beijing last successful check");
  assert.ok(beijingRow.includes(beijing.last_attempt_label), "Beijing last attempt");
  assert.ok(beijingRow.includes("is-error"), "Beijing should keep its error state");
  const newDelhiRow = rows.find((row) => row.includes(">New Delhi<"));
  assert.ok(newDelhiRow, "New Delhi row should render");
  assert.ok(newDelhiRow.includes(longDate(newDelhi.official_data_through)), "New Delhi official data-through date");
  assert.ok(
    newDelhiRow.includes(`data-observation="tracker">Tracker observed through ${longDate(newDelhi.observed_data_through)}`),
    "New Delhi tracker observation is labelled separately",
  );
  assert.ok(newDelhiRow.includes(newDelhi.decisions.toLocaleString("en-IE")), "New Delhi decisions");
  const abuja = freshness.offices.find((office) => office.slug === "abuja");
  const abujaRow = rows.find((row) => row.includes(">Abuja<"));
  assert.ok(abujaRow, "Abuja row should render");
  assert.ok(abujaRow.includes("Report overdue"), "Abuja reports the overdue state plainly");
  assert.ok(abujaRow.includes("may not appear in a search yet"), "Abuja explains the search impact");
  assert.ok(abujaRow.includes(abuja.last_success_label), "Abuja last successful check");
});
