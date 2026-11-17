/**
 * Decision alert runner.
 *
 *   node --test tests/alerts-run.test.mjs
 *
 * The runner is the only hourly job that mutates subscription state, so these
 * tests pin its contract: bad secrets are rejected, an unconfigured deployment
 * reports a clean 503 instead of throwing, and a configured run returns the
 * documented counters. A missing import used to throw a ReferenceError here,
 * which the router turned into an opaque 500 on every scheduled run.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildDigestMessage, dueForDigest, handleAlertsRun, shouldSendDigest } from "../functions/alerts-run.js";

const ROOT = new URL("../", import.meta.url);
const SECRET = "test-cron-secret";

function stubDB(rows = []) {
  return {
    prepare() {
      const statement = {
        bind: () => statement,
        all: async () => ({ results: rows }),
        run: async () => ({ success: true }),
        first: async () => null,
      };
      return statement;
    },
  };
}

/** Serve data/*.json from disk so the runner never touches the network. */
function stubFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    // The loader asks for root-relative asset paths, so resolve them against a
    // synthetic origin instead of requiring an absolute URL.
    const url = new URL(typeof input === "string" ? input : input.url, "https://tracker.test");
    try {
      const body = await readFile(new URL("." + url.pathname, ROOT), "utf8");
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  };
  return () => {
    globalThis.fetch = original;
  };
}

function runRequest(secret = SECRET) {
  return new Request("https://tracker.test/api/alerts/run", {
    method: "POST",
    headers: { "X-Cron-Secret": secret },
  });
}

test("rejects a wrong cron secret", async () => {
  const response = await handleAlertsRun(runRequest("nope"), {
    ALERTS_CRON_SECRET: SECRET,
    DB: stubDB(),
  });
  assert.equal(response.status, 401);
});

test("reports a missing delivery channel instead of throwing", async () => {
  const response = await handleAlertsRun(runRequest(), {
    ALERTS_CRON_SECRET: SECRET,
    DB: stubDB(),
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /No alert delivery channel/);
});

test("digest due windows are measured from the last successful digest", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(dueForDigest(null, "off", now), false);
  assert.equal(dueForDigest(null, "daily", now), true);
  assert.equal(dueForDigest("2026-11-17T01:00:00Z", "daily", now), false);
  assert.equal(dueForDigest("2026-11-16T01:00:00Z", "daily", now), true);
  assert.equal(dueForDigest("2026-11-17T01:00:00Z", "weekly", now), false);
  assert.equal(dueForDigest("2026-11-10T12:00:00Z", "weekly", now), true);
});

test("preferred hour and timezone gate the digest window", () => {
  const lastSent = "2026-11-16T09:00:00Z";
  const dublinEarly = Date.parse("2026-11-17T08:30:00Z");
  const dublinOnTime = Date.parse("2026-11-17T09:00:00Z");
  assert.equal(
    dueForDigest(lastSent, "daily", dublinEarly, { hour: 9, timeZone: "Europe/Dublin" }),
    false,
    "08:30 in Dublin is before the preferred 09:00 hour"
  );
  assert.equal(
    dueForDigest(lastSent, "daily", dublinOnTime, { hour: 9, timeZone: "Europe/Dublin" }),
    true
  );

  // 13:00 UTC is 08:00 in New York during standard time.
  assert.equal(
    dueForDigest(lastSent, "daily", Date.parse("2026-11-17T13:00:00Z"), { hour: 9, timeZone: "America/New_York" }),
    false
  );
  assert.equal(
    dueForDigest(lastSent, "daily", Date.parse("2026-11-17T14:00:00Z"), { hour: 9, timeZone: "America/New_York" }),
    true
  );

  // Dublin is UTC+1 in July, so 08:00 UTC is 09:00 local and 07:30 UTC is 08:30.
  assert.equal(
    dueForDigest("2026-07-06T08:00:00Z", "daily", Date.parse("2026-07-07T07:30:00Z"), { hour: 9, timeZone: "Europe/Dublin" }),
    false
  );
  assert.equal(
    dueForDigest("2026-07-06T08:00:00Z", "daily", Date.parse("2026-07-07T08:00:00Z"), { hour: 9, timeZone: "Europe/Dublin" }),
    true
  );

  assert.equal(
    dueForDigest(null, "daily", Date.parse("2026-11-17T08:00:00Z"), { hour: 9, timeZone: "UTC" }),
    false,
    "a new digest waits for the preferred hour"
  );
  assert.equal(
    dueForDigest(null, "daily", Date.parse("2026-11-17T09:00:00Z"), { hour: 9, timeZone: "UTC" }),
    true
  );
});

test("daily sends only changes, weekly sends no-change summaries", () => {
  assert.equal(shouldSendDigest("daily", 0), false);
  assert.equal(shouldSendDigest("daily", 1), true);
  assert.equal(shouldSendDigest("weekly", 0), true);
  assert.equal(shouldSendDigest("weekly", 2), true);
  assert.equal(shouldSendDigest("off", 1), false);
});

test("digest groups by office and states no-change applications", () => {
  const message = buildDigestMessage([
    { application_number: "12345678", embassy: "new-delhi", decision: { decision: "Approved", date: "2026-11-16", report_date: "2026-11-16" } },
    { application_number: "87654321", embassy: "new-delhi", decision: null },
    { application_number: "11112222", embassy: "beijing", decision: null }
  ], { baseUrl: "https://tracker.test", now: new Date("2026-11-17T12:00:00Z") });
  assert.match(message, /3 tracked applications · 1 new decision/);
  assert.match(message, /New Delhi:/);
  assert.match(message, /12345678 — Approved/);
  assert.match(message, /No change for 1 other application/);
  assert.match(message, /Beijing: no change \(1 application\)/);
});

test("a digest with no changes states that explicitly", () => {
  const message = buildDigestMessage([
    { application_number: "12345678", embassy: "new-delhi", decision: null },
    { application_number: "87654321", embassy: "beijing", decision: null }
  ], { baseUrl: "https://tracker.test", now: new Date("2026-11-17T12:00:00Z") });
  assert.match(message, /2 tracked applications · 0 new decisions/);
  assert.match(message, /No new published decisions for your linked applications\./);
});

test("runs with Telegram configured and returns the counters", async () => {
  const restore = stubFetch();
  try {
    const response = await handleAlertsRun(runRequest(), {
      ALERTS_CRON_SECRET: SECRET,
      DB: stubDB(),
      TELEGRAM_BOT_TOKEN: "123456:test-token",
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.checked, 0);
    assert.equal(body.sent, 0);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  } finally {
    restore();
  }
});
