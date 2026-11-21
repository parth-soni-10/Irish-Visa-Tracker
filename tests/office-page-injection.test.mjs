import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectOfficePages } from "../tools/deploy-pages.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const PAGE_FILES = {
  "new-delhi": "new-delhi-visa-decisions.html",
  beijing: "beijing-visa-decisions.html",
  "abu-dhabi": "abu-dhabi-visa-decisions.html",
  abuja: "abuja-visa-decisions.html",
  ankara: "ankara-visa-decisions.html",
  dublin: "dublin-visa-decisions.html",
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function replaceOfficeField(html, key, value) {
  const re = new RegExp(`(<([a-z0-9]+)[^>]*data-office="${key}"[^>]*>)[\\s\\S]*?(</\\2>)`, "gi");
  return html.replace(re, `$1${value}$3`);
}

function assertOfficeField(html, key, value, file) {
  assert.match(
    html,
    new RegExp(`data-office="${key}"[^>]*>${escapeRegExp(value)}<`),
    `${file}: expected data-office="${key}" to be "${value}"`,
  );
}

test("deploy office-page injection writes current manifest data into a temporary build", async (t) => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "data", "data_manifest.json"), "utf8"));
  assert.ok(Array.isArray(manifest.offices), "data_manifest.json must contain offices");

  const temp = await mkdtemp(path.join(os.tmpdir(), "office-page-injection-"));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const assets = path.join(temp, "assets");
  const dist = path.join(temp, "dist");
  const data = path.join(assets, "data");
  await mkdir(data, { recursive: true });
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(data, "data_manifest.json"), JSON.stringify(manifest));

  const delhi = manifest.offices.find((office) => office.slug === "new-delhi");
  assert.ok(delhi, "data_manifest.json must contain New Delhi");
  // Exercise the dated-history branch without copying the full decisions file.
  await writeFile(path.join(data, "visa_decisions.json"), JSON.stringify([
    [delhi.report_date, "10000001", "Approved"],
    [delhi.report_date, "10000002", "Refused"],
  ]));

  const staleFields = [
    "latest-date",
    "checked-date",
    "decisions",
    "approved",
    "refused",
    "approval-share",
    "refused-share",
    "history",
    "archive",
    "latest-day",
    "tracker-latest",
  ];

  for (const office of manifest.offices) {
    const file = PAGE_FILES[office.slug];
    assert.ok(file, `No office page fixture for manifest office ${office.slug}`);

    const source = await readFile(path.join(ROOT, file), "utf8");
    let stale = source;
    for (const key of staleFields) stale = replaceOfficeField(stale, key, `STALE-${key}`);
    stale = stale.replace(
      /(<a[^>]*data-office="source-file"[^>]*href=")[^"]*(")/i,
      "$1https://stale.invalid/source$2",
    );
    await writeFile(path.join(dist, file), stale);
  }

  injectOfficePages({ assetsRootDir: assets, distDir: dist });

  for (const office of manifest.offices) {
    const file = PAGE_FILES[office.slug];
    const html = await readFile(path.join(dist, file), "utf8");

    assert.doesNotMatch(html, /STALE-/, `${file}: injector left a stale field`);
    assertOfficeField(html, "decisions", Number(office.decisions).toLocaleString("en-IE"), file);
    assertOfficeField(html, "approved", Number(office.approved).toLocaleString("en-IE"), file);
    assertOfficeField(html, "refused", Number(office.refused).toLocaleString("en-IE"), file);

    const approvalShare = office.decisions
      ? `${((office.approved / office.decisions) * 100).toFixed(1)}%`
      : "0.0%";
    const refusedShare = office.decisions
      ? `${((office.refused / office.decisions) * 100).toFixed(1)}%`
      : "0.0%";
    assertOfficeField(html, "approval-share", approvalShare, file);
    assertOfficeField(html, "refused-share", refusedShare, file);

    const sourceLink = html.match(/<a[^>]*data-office="source-file"[^>]*href="([^"]+)"/i);
    assert.ok(sourceLink, `${file}: missing source-file link`);
    assert.equal(
      sourceLink[1].replace(/&amp;/g, "&"),
      office.source_file,
      `${file}: source-file link does not match the manifest`,
    );

    assert.match(
      html,
      new RegExp(`href="/\\?tracker=visa&amp;tab=search&amp;office=${escapeRegExp(office.slug)}"`),
      `${file}: missing office-preselected Search CTA`,
    );
  }
});
