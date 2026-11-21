import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(path.join(ROOT, "scripts", "freshness.js"), "utf8");

function loadClient(documentOverrides = {}) {
  const context = {
    console,
    document: {
      readyState: "complete",
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
      ...documentOverrides,
    },
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "scripts/freshness.js" });
  return context.IVFreshness;
}

function office(overrides = {}) {
  return {
    slug: "abuja",
    name: "Abuja",
    report_date: "2026-11-07",
    official_data_through: "2026-11-07",
    observed_data_through: "2026-11-07",
    decisions: 99,
    approved: 34,
    refused: 65,
    status: "official",
    checked_at: "2026-11-21T14:53:55.506Z",
    checked_label: "21 Nov 2026, 14:53 UTC",
    last_success_at: "2026-11-21T14:53:55.506Z",
    last_success_label: "21 Nov 2026, 14:53 UTC",
    cadence_days: 14,
    ...overrides,
  };
}

test("relative age changes at the UTC midnight boundary", () => {
  const freshness = loadClient();
  const before = freshness.compute(office(), new Date("2026-11-14T23:59:59Z"));
  const after = freshness.compute(office(), new Date("2026-11-15T00:00:00Z"));

  assert.equal(before.age_days, 7);
  assert.equal(before.age_label, "7 days old");
  assert.equal(after.age_days, 8);
  assert.equal(after.age_label, "8 days old");
  assert.equal(freshness.ageLabel(2, true), "2 days old at last build");
});

test("a missed weekly window becomes overdue at UTC midnight", () => {
  const freshness = loadClient();
  const before = freshness.compute(office(), new Date("2026-11-14T23:59:59Z"));
  const after = freshness.compute(office(), new Date("2026-11-15T00:00:00Z"));

  assert.equal(before.overdue, false);
  assert.equal(before.due_at, "2026-11-14");
  assert.match(before.due_label, /Expected 14 November 2026/);
  assert.equal(after.overdue, true);
  assert.match(after.due_label, /Due since 14 November 2026 — not yet published/);
  assert.match(after.next_due_label, /Next expected 21 November 2026/);
});

test("New Delhi weekend boundaries keep a Friday report expected, not overdue", () => {
  const freshness = loadClient();
  const newDelhi = office({
    slug: "new-delhi",
    name: "New Delhi",
    report_date: "2026-11-20",
    official_data_through: "2026-11-20",
    observed_data_through: "2026-11-20",
    cadence_days: 3,
  });

  const saturday = freshness.compute(newDelhi, new Date("2026-11-21T12:00:00Z"));
  const sunday = freshness.compute(newDelhi, new Date("2026-11-22T12:00:00Z"));
  const monday = freshness.compute(newDelhi, new Date("2026-11-23T12:00:00Z"));
  const tuesday = freshness.compute(newDelhi, new Date("2026-11-24T12:00:00Z"));

  assert.equal(saturday.overdue, false);
  assert.equal(sunday.overdue, false);
  assert.equal(monday.overdue, false);
  assert.match(saturday.due_label, /Expected 23 November 2026/);
  assert.match(sunday.due_label, /Expected 23 November 2026/);
  assert.equal(tuesday.overdue, true);
});

test("the browser paint updates tagged static rows from absolute dates", () => {
  const officeBlock = { getAttribute: () => "abuja", innerHTML: "" };
  const age = { textContent: "14 days old at last build · Due since 14 Nov 2026" };
  const pill = {
    className: "status-pill is-warn",
    textContent: "Official",
    setAttribute() {},
    removeAttribute() {},
  };
  const row = {
    getAttribute: () => "abuja",
    querySelector(selector) {
      if (selector === "[data-freshness-age]") return age;
      if (selector === "[data-freshness-status]") return pill;
      return null;
    },
  };
  const freshness = loadClient({
    querySelector() { return officeBlock; },
    querySelectorAll(selector) {
      if (selector === "[data-freshness]") return [officeBlock];
      if (selector.includes('data-freshness-view="status"')) return [row];
      return [];
    },
  });

  freshness.paint({ offices: [office()] }, new Date("2026-11-21T12:00:00Z"));
  assert.match(officeBlock.innerHTML, /14 days old/);
  assert.match(officeBlock.innerHTML, /expected since 14 November 2026/);
  assert.equal(age.textContent, "14 days old · Due since 14 Nov 2026");
  assert.equal(pill.className, "status-pill is-warn");
});

test("a failed refresh explains the failed check, not the office's snapshot format", () => {
  const freshness = loadClient();
  const beijing = office({
    slug: "beijing",
    name: "Beijing",
    status: "error",
    snapshot: true,
    report_date: "2026-11-01",
  });
  const view = freshness.compute(beijing, new Date("2026-11-21T12:00:00Z"));

  assert.equal(view.status, "error");
  assert.match(view.search_impact, /^We couldn't refresh Beijing this time\./);
  assert.match(view.search_impact, /latest official report is 1 November 2026/);
  assert.doesNotMatch(view.search_impact, /Live snapshot/);
});

test("schedule view keeps Dublin on Tuesdays and Abuja on its report cadence", () => {
  const freshness = loadClient();
  const dublin = office({
    slug: "dublin",
    name: "Dublin",
    report_date: "2026-11-21",
    official_data_through: "2026-11-21",
    observed_data_through: "2026-11-21",
  });
  const abuja = office();

  assert.match(
    freshness.scheduleHTML(dublin, new Date("2026-11-21T12:00:00Z")),
    /Tuesday 24 November 2026/,
  );
  assert.match(
    freshness.scheduleHTML(abuja, new Date("2026-11-21T12:00:00Z")),
    /Due since Saturday 14 November 2026/,
  );
  assert.match(
    freshness.scheduleHTML(abuja, new Date("2026-11-21T12:00:00Z")),
    /Next expected Saturday 28 November 2026/,
  );
});
