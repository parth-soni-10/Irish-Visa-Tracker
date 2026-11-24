import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const SITE = "https://irishvisaupdatetracker.pages.dev";

function collectDatasets(node, found = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectDatasets(item, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  if (node["@type"] === "Dataset") found.push(node);
  for (const value of Object.values(node)) collectDatasets(value, found);
  return found;
}

test("every Dataset declares the site Organization as creator and the terms licence", async () => {
  const files = (await readdir(ROOT))
    .filter((name) => name.endsWith(".html"))
    .sort();
  let count = 0;

  for (const file of files) {
    const html = await readFile(new URL(file, ROOT), "utf8");
    for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      const datasets = collectDatasets(JSON.parse(match[1]));
      for (const dataset of datasets) {
        count += 1;
        assert.deepEqual(dataset.creator, { "@id": `${SITE}/#organization` }, `${file}: Dataset creator`);
        assert.equal(dataset.license, `${SITE}/terms`, `${file}: Dataset license`);
      }
    }
  }

  assert.ok(count >= 14, `expected at least 14 Dataset nodes, found ${count}`);
});

test("the homepage title and description target the dominant query language", async () => {
  const html = await readFile(new URL("index.html", ROOT), "utf8");
  assert.match(html, /<title>Ireland Visa Decisions: New Delhi &amp; 5 Offices<\/title>/);
  assert.match(html, /<meta name="description" content="Search today’s published Irish visa decisions from six offices/);
});