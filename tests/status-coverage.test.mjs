import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function read(relativePath) {
  return readFile(path.join(ROOT, relativePath), "utf8");
}

function columns(section) {
  return [...section.matchAll(/<th scope="col">([^<]+)<\/th>/g)]
    .map((match) => match[1].trim());
}

test("dynamic office coverage uses the static latest-report columns and attempt time", async () => {
  const [html, scriptSource, manifestSource, freshnessSource] = await Promise.all([
    read("status.html"),
    read("scripts/status-1.js"),
    read("data/data_manifest.json"),
    read("data/freshness.json"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const freshness = JSON.parse(freshnessSource);
  const elements = {
    "status-summary": { innerHTML: "" },
    "status-rows": { innerHTML: "" },
    "archive-history-rows": { innerHTML: "" },
  };
  const context = {
    window: {},
    document: {
      getElementById(id) {
        return elements[id] || null;
      },
    },
    async fetch(url) {
      if (url === "/data/data_manifest.json") {
        return { ok: true, json: async () => manifest };
      }
      if (url === "/data/freshness.json") {
        return { ok: true, json: async () => freshness };
      }
      if (url === "/api/config") {
        return { ok: false, json: async () => ({}) };
      }
      throw new Error("unexpected fetch: " + url);
    },
    console,
  };
  vm.runInNewContext(scriptSource, context, { filename: "scripts/status-1.js" });
  await new Promise((resolve) => setImmediate(resolve));

  const staticSection = html.match(/<section id="latest-report-by-office">[\s\S]*?<\/thead>/)?.[0] || "";
  const dynamicSection = html.match(/<section id="office-coverage">[\s\S]*?<\/thead>/)?.[0] || "";
  const staticColumns = columns(staticSection);
  const dynamicColumns = columns(dynamicSection);
  assert.equal(staticColumns.length, 9);
  assert.deepEqual(dynamicColumns, staticColumns);
  assert.ok(dynamicColumns.includes("Last successful check"));
  assert.ok(dynamicColumns.includes("Last attempt"));

  const rows = [...elements["status-rows"].innerHTML.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
    .map((match) => match[1]);
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
  assert.ok(newDelhiRow.includes("19 November 2026"), "New Delhi official data-through date");
  assert.match(
    newDelhiRow,
    /data-observation="tracker">Tracker observed through 20 November 2026/,
    "New Delhi tracker observation is labelled separately",
  );
  assert.ok(newDelhiRow.includes("20 November 2026"), "New Delhi tracker observation date");
  assert.ok(newDelhiRow.includes(newDelhi.decisions.toLocaleString("en-IE")), "New Delhi decisions");
});
