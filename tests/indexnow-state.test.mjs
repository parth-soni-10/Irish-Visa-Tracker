import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultIndexNowStateFile,
  emptyIndexNowState,
  fingerprintIndexNowHtml,
  indexNowFilePath,
  loadIndexNowState,
  normalizeIndexNowHtml,
  saveIndexNowState,
  selectChangedIndexNowUrls,
} from "../tools/indexnow.mjs";

const HTML = (asset, asOf, checked, buildTime, ivTime, modified) => `<!doctype html>
<link rel="stylesheet" href="/styles/index-bundle.css?v=${asset}">
<script type="application/ld+json">{"dateModified":"${modified}"}</script>
<p>As of ${asOf}, the newest official office publication is dated 24 November 2026.</p>
<p>offices last successfully checked ${checked} · New Delhi official decisions through 23 November 2026</p>
<strong>Page built:</strong> <time datetime="2026-11-25T00:09:03.613Z">${buildTime}</time> Dublin time
<time datetime="2026-11-24T16:07:08.184Z" data-iv-time="2026-11-24T16:07:08.184Z">${ivTime}</time>
<p>Approved: 32</p>`;

test("IndexNow fingerprints ignore asset versions and generated times", () => {
  const first = HTML("abc123", "25 November 2026", "18 November 2026 to 24 November 2026", "25 November 2026 at 00:09", "24 Nov 2026, 16:07 UTC", "2026-11-24");
  const second = HTML("def456", "26 November 2026", "19 November 2026 to 25 November 2026", "26 November 2026 at 00:11", "25 Nov 2026, 16:09 UTC", "2026-11-25");
  assert.equal(fingerprintIndexNowHtml(first), fingerprintIndexNowHtml(second));
  assert.doesNotMatch(normalizeIndexNowHtml(first), /abc123|25 November 2026 at/);

  const changed = second.replace("Approved: 32", "Approved: 33");
  assert.notEqual(fingerprintIndexNowHtml(first), fingerprintIndexNowHtml(changed));
});

test("IndexNow selects only new or changed pages and round-trips its state", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "indexnow-state-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const dist = path.join(temp, "dist");
  await mkdir(path.join(dist, "reports", "new-delhi"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), HTML("abc123", "25 November 2026", "18 November 2026 to 24 November 2026", "25 November 2026 at 00:09", "24 Nov 2026, 16:07 UTC", "2026-11-24"));
  await writeFile(path.join(dist, "help.html"), "<h1>Help</h1>");
  await writeFile(path.join(dist, "reports", "new-delhi", "2026-11-23.html"), "<h1>Report</h1>");
  const urls = [
    "https://irishvisaupdatetracker.pages.dev/",
    "https://irishvisaupdatetracker.pages.dev/help",
    "https://irishvisaupdatetracker.pages.dev/reports/new-delhi/2026-11-23",
  ];
  assert.equal(indexNowFilePath(urls[0], dist), path.join(dist, "index.html"));
  assert.equal(indexNowFilePath(urls[2], dist), path.join(dist, "reports", "new-delhi", "2026-11-23.html"));

  const first = selectChangedIndexNowUrls({ urls, distDir: dist, state: emptyIndexNowState() });
  assert.deepEqual(first.changed.sort(), urls.slice().sort());
  const state = { version: 1, urls: first.fingerprints };
  const unchanged = selectChangedIndexNowUrls({ urls, distDir: dist, state });
  assert.deepEqual(unchanged.changed, []);

  await writeFile(path.join(dist, "help.html"), "<h1>Help changed</h1>");
  const changed = selectChangedIndexNowUrls({ urls, distDir: dist, state });
  assert.deepEqual(changed.changed, [urls[1]]);

  const stateFile = path.join(temp, ".cache", "indexnow-state.json");
  saveIndexNowState(stateFile, state);
  assert.deepEqual(loadIndexNowState(stateFile), state);
  assert.match(await readFile(stateFile, "utf8"), /"version": 1/);
  assert.deepEqual(loadIndexNowState(path.join(temp, "missing.json")), emptyIndexNowState());
  assert.ok(defaultIndexNowStateFile().endsWith(path.join(".cache", "indexnow-state.json")));
});

test("IndexNow rejects an incomplete build instead of silently skipping URLs", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "indexnow-missing-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, "index.html"), "home");
  assert.throws(
    () => selectChangedIndexNowUrls({
      urls: ["https://irishvisaupdatetracker.pages.dev/", "https://irishvisaupdatetracker.pages.dev/help"],
      distDir: temp,
      state: emptyIndexNowState(),
    }),
    /Cannot fingerprint 1 URL/,
  );
});