import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { injectOfficePages } from "../tools/deploy-pages.mjs";
import { OFFICE_SEO, officeTitle } from "../tools/office-seo.mjs";

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
  const archive = JSON.parse(await readFile(path.join(ROOT, "data", "reports", "index.json"), "utf8"));
  assert.ok(archive.offices, "data/reports/index.json must contain offices");

  const temp = await mkdtemp(path.join(os.tmpdir(), "office-page-injection-"));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const assets = path.join(temp, "assets");
  const dist = path.join(temp, "dist");
  const data = path.join(assets, "data");
  await mkdir(path.join(data, "reports"), { recursive: true });
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(data, "data_manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(data, "reports", "index.json"), JSON.stringify(archive));
  // Ankara has archived report dates missing from the report index; the
  // injector must read its decision file to fill those rows.
  await copyFile(path.join(ROOT, "data", "embassy-ankara.json"), path.join(data, "embassy-ankara.json"));

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
    "check-copy",
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
    stale = stale.replace(
      /(<tbody[^>]*data-report-history="[^"]*"[^>]*>)[\s\S]*?(<\/tbody>)/i,
      "$1<tr><td>STALE-history</td></tr>$2",
    );
    await writeFile(path.join(dist, file), stale);
  }

  injectOfficePages({ assetsRootDir: assets, distDir: dist });

  for (const office of manifest.offices) {
    const file = PAGE_FILES[office.slug];
    const html = await readFile(path.join(dist, file), "utf8");

    assert.doesNotMatch(html, /STALE-/, `${file}: injector left a stale field`);
    assert.match(
      html,
      new RegExp(`<title>${escapeRegExp(officeTitle(office.slug, office.report_date).replace(/&/g, "&amp;"))}<\\/title>`),
      `${file}: title is not the office intent title`,
    );
    assert.match(
      html,
      new RegExp(`<meta name="description" content="${escapeRegExp(OFFICE_SEO[office.slug].description)}"`),
      `${file}: description is not the office intent description`,
    );
    if (office.slug === "beijing" && office.status === "error") {
      assert.match(html, /The last successful check on [^<]+ found no newer decision-file link than the 1 November 2026 snapshot\./);
      assert.match(html, /The tracker's latest check on [^<]+ failed \(No decision file link found\)/);
      assert.doesNotMatch(html, /The last check on [^<]+ found no newer/);
    }
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

    const history = html.match(
      new RegExp(`<tbody[^>]*data-report-history="${escapeRegExp(office.slug)}"[^>]*>([\\s\\S]*?)<\\/tbody>`),
    );
    assert.ok(history, `${file}: missing report-history table body`);
    const rows = history[1];
    assert.doesNotMatch(rows, /STALE/, `${file}: report history was not regenerated`);

    const entries = (archive.offices[office.slug] || [])
      .filter((entry) => /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || "")))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    assert.ok(entries.length, `${office.slug}: report archive has no dated entries`);
    const latest = entries[0];
    assert.match(rows, new RegExp(`<time datetime="${latest.report_date}">`), file);
    assert.match(
      rows,
      new RegExp(`<td>${escapeRegExp(Number(latest.decisions).toLocaleString("en-IE"))}</td>`),
      `${file}: report history is missing the latest decision count`,
    );
    const rate = `${((Number(latest.approved) / Number(latest.decisions)) * 100).toFixed(1)}%`;
    assert.match(rows, new RegExp(`<td>${escapeRegExp(rate)}</td>`), `${file}: report history is missing the approval rate`);
    assert.match(
      rows,
      new RegExp(`href="${escapeRegExp(String(latest.source_file).replace(/&/g, "&amp;"))}"`),
      `${file}: report history is missing the official source link`,
    );
    assert.ok((rows.match(/<tr>/g) || []).length <= 8, `${file}: report history should list at most 8 reports`);
    if (office.slug === "ankara") {
      assert.equal(
        (rows.match(/<tr>/g) || []).length,
        office.archive_reports.length,
        `${file}: every archived Ankara report date should be listed`,
      );
      for (const report of office.archive_reports) {
        assert.match(rows, new RegExp(`<time datetime="${report.report_date}">`), `${file}: missing ${report.report_date}`);
      }
      assert.match(
        rows,
        /<td>167<\/td><td>142<\/td><td>25<\/td><td>85\.0%<\/td>/,
        `${file}: missing OCR-derived outcomes for the 11 October 2026 report`,
      );
      assert.doesNotMatch(
        rows,
        /href="\/reports\/ankara\/2026-10-11"/,
        `${file}: dates without a report permalink must not link to a missing page`,
      );
    }
    if (office.slug === "dublin") {
      // Dublin checks one published list repeatedly; identical consecutive
      // snapshots collapse, but each distinct published list keeps a row.
      const distinct = entries.filter((entry, index) => index === 0 || [
        entry.decisions, entry.approved, entry.refused, entry.source_file,
      ].join("|") !== [
        entries[index - 1].decisions, entries[index - 1].approved,
        entries[index - 1].refused, entries[index - 1].source_file,
      ].join("|"));
      assert.equal(
        (rows.match(/<tr>/g) || []).length,
        Math.min(distinct.length, 8),
        `${file}: repeated identical Dublin snapshots should collapse to one row each`,
      );
    }
  }
});
