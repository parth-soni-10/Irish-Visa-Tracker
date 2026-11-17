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

import { buildDigestMessage, dueForDigest, handleAlertsRun } from "../functions/alerts-run.js";

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
  assert.equal(dueForDigest("2026-11-10T12:00:00Z", "weekly", now), true);
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
