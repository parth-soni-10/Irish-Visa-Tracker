import assert from "node:assert/strict";
import { test } from "node:test";

import { officeAnalysis, officeAnalysisHtml, seriesFromEntries } from "../tools/office-analysis.mjs";

const weekly = [
  { report_date: "2026-11-01", decisions: 100, approved: 60, refused: 40 },
  { report_date: "2026-11-08", decisions: 200, approved: 150, refused: 50 },
  { report_date: "2026-11-15", decisions: 50, approved: 20, refused: 30 },
];

test("one row per file date keeps the largest published row", () => {
  const rows = seriesFromEntries([
    { report_date: "2026-11-08", decisions: 120, approved: 70, refused: 50 },
    { report_date: "2026-11-08", decisions: 200, approved: 150, refused: 50 },
    { report_date: "2026-11-01", decisions: 100, approved: 60, refused: 40 },
    { report_date: "not-a-date", decisions: 999 },
  ]);
  assert.deepEqual(rows.map((row) => row.date), ["2026-11-01", "2026-11-08"]);
  assert.equal(rows[1].decisions, 200);
});

test("weekly reports are summed because each covers its own period", () => {
  const analysis = officeAnalysis("abuja", weekly);
  assert.equal(analysis.kind, "weekly");
  assert.equal(analysis.rows, 3);
  assert.equal(analysis.totalDecisions, 350);
  assert.equal(analysis.totalApproved, 230);
  assert.equal(analysis.totalRefused, 120);
  assert.equal(analysis.approvalShare.toFixed(1), "65.7");
  assert.equal(analysis.cadenceDays, 7);
  assert.equal(analysis.largest.decisions, 200);
  assert.equal(analysis.smallest.decisions, 50);
});

test("a cumulative file is never summed and reports growth between files", () => {
  const analysis = officeAnalysis("new-delhi", [
    { report_date: "2026-11-20", decisions: 43600, approved: 36700, refused: 6900 },
    { report_date: "2026-11-23", decisions: 43800, approved: 36932, refused: 6868 },
  ]);
  assert.equal(analysis.kind, "cumulative");
  assert.equal(analysis.totalDecisions, 43800, "the latest cumulative total, not 87,400");
  assert.equal(analysis.change.added, 200);
  assert.equal(analysis.change.days, 3);
  assert.ok(analysis.change.perDay > 66 && analysis.change.perDay < 67);
  const html = officeAnalysisHtml(analysis, { name: "New Delhi" });
  assert.match(html, /Cumulative, not a daily count/);
  assert.match(html, /not 87,400|43,800/);
  assert.match(html, /What this file cannot tell you/);
  assert.match(html, /publication output, not demand/);
});

test("a single snapshot shows only measures that mean something", () => {
  const analysis = officeAnalysis("beijing", [
    { report_date: "2026-11-01", decisions: 13724, approved: 11373, refused: 2351 },
  ], { checkedDate: "2026-11-21" });
  assert.equal(analysis.kind, "snapshot");
  assert.equal(analysis.rows, 1);
  assert.equal(analysis.staleDays, 20);
  const html = officeAnalysisHtml(analysis, { name: "Beijing" });
  assert.match(html, /does not claim a trend across time/);
  assert.match(html, /20 days old/);
  assert.doesNotMatch(html, /Median .* between files/);

  // One list has no spread: a range of 82.9% to 82.9% or a largest file equal
  // to the smallest is filler, not analysis.
  assert.doesNotMatch(html, /Approval share range/);
  assert.doesNotMatch(html, /Largest (file|list)/);
  assert.doesNotMatch(html, /Smallest (file|list)/);
  assert.doesNotMatch(html, /% to 82\.9%/);
  assert.doesNotMatch(html, /Median decisions per/);
  assert.match(html, /Age at last successful check/);
  assert.match(html, /Snapshot of one list/);
  assert.match(html, /82\.9%|<strong>82\.9%<\/strong>|82\.9%<\/strong>/);

  // The cards follow the file kind too: age, not a cadence, for a snapshot.
  assert.match(html, /Age at last check/);
  assert.doesNotMatch(html, /Publication cadence/);
  assert.match(html, /Snapshot, not a series/);
});

test("a cumulative office compares its files without a median-per-file nonsense", () => {
  const analysis = officeAnalysis("new-delhi", [
    { report_date: "2026-11-20", decisions: 43600, approved: 36700, refused: 6900 },
    { report_date: "2026-11-23", decisions: 43800, approved: 36932, refused: 6868 },
  ]);
  const html = officeAnalysisHtml(analysis, { name: "New Delhi" });
  assert.match(html, /First file in the archive/);
  assert.match(html, /Latest file/);
  assert.match(html, /Growth since previous file/);
  assert.match(html, /200 decisions over 3 days/);
  // A median of running totals would describe the archive's length, not the office.
  assert.doesNotMatch(html, /Median decisions per/);
  assert.doesNotMatch(html, /Largest file|Smallest file/);
});

test("comparable weekly reports keep the range and the extremes", () => {
  const html = officeAnalysisHtml(officeAnalysis("abuja", weekly), { name: "Abuja" });
  assert.match(html, /Approval share range/);
  assert.match(html, /Median decisions per report/);
  assert.match(html, /Largest report/);
  assert.match(html, /Smallest report/);
});

test("an empty series makes no claim", () => {
  const analysis = officeAnalysis("dublin", []);
  const html = officeAnalysisHtml(analysis, { name: "Dublin" });
  assert.match(html, /No archived report is available/);
});
