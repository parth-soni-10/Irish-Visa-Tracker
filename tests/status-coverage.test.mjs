import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function columns(section) {
  return [...section.matchAll(/<th scope="col">([^<]+)<\/th>/g)]
    .map((match) => match[1].trim());
}

test("status page has one static coverage table with check provenance", async () => {
  const [html, manifestSource, freshnessSource] = await Promise.all([
    read("status.html"),
    read("data/data_manifest.json"),
    read("data/freshness.json"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const freshness = JSON.parse(freshnessSource);

  const section = html.match(/<section id="office-coverage">[\s\S]*?<\/thead>/)?.[0] || "";
  const coverageColumns = columns(section);
  assert.equal(coverageColumns.length, 9);
  assert.ok(coverageColumns.includes("Last successful check"));
  assert.ok(coverageColumns.includes("Last attempt"));
  assert.equal((html.match(/<section id="office-coverage">/g) || []).length, 1);
  assert.doesNotMatch(html, /id="latest-report-by-office"/);

  const body = html.match(/<tbody[^>]*data-latest-reports[^>]*>([\s\S]*?)<\/tbody>/)?.[1] || "";
  const rows = [...body.matchAll(/<tr\b[\s\S]*?<\/tr>/g)].map((match) => match[0]);
  assert.equal(rows.length, manifest.offices.length);
  for (const row of rows) {
    assert.equal((row.match(/<td\b/g) || []).length, 9, row);
  }

  const beijing = freshness.offices.find((office) => office.slug === "beijing");
  const newDelhi = freshness.offices.find((office) => office.slug === "new-delhi");
  const beijingRow = rows.find((row) => row.includes(">Beijing<"));
  assert.ok(beijingRow, "Beijing row should render");
  assert.ok(beijingRow.includes(beijing.last_success_label), "Beijing last successful check");
  assert.ok(beijingRow.includes(beijing.last_attempt_label), "Beijing last attempt");
  assert.ok(beijingRow.includes("is-error"), "Beijing should keep its error state");
  const newDelhiRow = rows.find((row) => row.includes(">New Delhi<"));
  assert.ok(newDelhiRow, "New Delhi row should render");
  assert.ok(newDelhiRow.includes("19 November 2026"), "New Delhi official data-through date");
  assert.match(
    newDelhiRow,
    /data-observation="tracker">Tracker observed through 20 November 2026/,
    "New Delhi tracker observation is labelled separately",
  );
  assert.ok(newDelhiRow.includes(newDelhi.decisions.toLocaleString("en-IE")), "New Delhi decisions");
});
