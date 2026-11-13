/**
 * Community timeline submissions feed.
 *
 *   node --test tests/community-submissions.test.mjs
 *
 * `sync_timelines.py` reads GET /api/community-submissions every night. The
 * route was dropped from the router in a refactor, which turned the sync job
 * red with a 404, so this pins the contract: JSON, read-only, and generated
 * rows only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import router from "../functions/_router.js";

const ROW = {
  form: "timelines-visa",
  fields: '{"tracker":"visa","applied":"2026-01-02","decided":"2026-03-04","outcome":"granted"}',
  created_at: "2026-03-05 09:00:00",
};

function envWith(rows, inserts = []) {
  const statement = {
    sql: '',
    args: [],
    bind: (...args) => { statement.args = args; return statement; },
    all: async () => ({ results: rows }),
    run: async () => {
      if (/INSERT INTO submissions/.test(statement.sql)) inserts.push(statement.args);
      return { success: true };
    },
    first: async () => null,
  };
  return {
    DB: { prepare: (sql) => { statement.sql = sql; return statement; }, batch: async () => [] },
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  };
}

test("serves timeline submissions as JSON", async () => {
  const response = await router.fetch(
    new Request("https://tracker.test/api/community-submissions"),
    envWith([ROW]),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).submissions, [ROW]);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("HEAD returns the same status without a body", async () => {
  const response = await router.fetch(
    new Request("https://tracker.test/api/community-submissions", { method: "HEAD" }),
    envWith([ROW]),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});

test("rejects writes", async () => {
  const response = await router.fetch(
    new Request("https://tracker.test/api/community-submissions", { method: "POST", body: "x" }),
    envWith([]),
  );
  assert.equal(response.status, 405);
});

test("accepts the fields the current timeline forms submit", async () => {
  const inserts = [];
  const response = await router.fetch(
    new Request("https://tracker.test/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "form-name": "timelines-visa",
        tracker: "visa",
        applied: "2026-01-02",
        decided: "2026-03-04",
        outcome: "granted",
      }).toString(),
    }),
    envWith([], inserts),
  );
  assert.equal(response.status, 200);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][0], "timelines-visa");
  assert.match(inserts[0][1], /"applied":"2026-01-02"/);
});

test("rejects a timeline without valid dates", async () => {
  const inserts = [];
  const response = await router.fetch(
    new Request("https://tracker.test/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "form-name": "timelines-visa",
        tracker: "visa",
        applied: "",
        decided: "2026-03-04",
        outcome: "granted",
      }).toString(),
    }),
    envWith([], inserts),
  );
  assert.equal(response.status, 400);
  assert.equal(inserts.length, 0);
});
