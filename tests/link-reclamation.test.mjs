import assert from "node:assert/strict";
import { test } from "node:test";

import { auditMentions, classifyMention } from "../tools/link-reclamation.mjs";

const SITE = "https://irishvisaupdatetracker.pages.dev";

test("an anchor to the site is a link, not just a mention", () => {
  const html = '<p>Source: <a href="https://irishvisaupdatetracker.pages.dev/data-study">the tracker</a></p>';
  assert.equal(classifyMention(html, SITE).status, "linked");
});

test("a mention without a link is unlinked", () => {
  const html = "<p>According to the Irish Visa Decision Tracker, approvals rose.</p>";
  const result = classifyMention(html, SITE);
  assert.equal(result.status, "unlinked");
  assert.equal(result.detail, "Irish Visa Decision Tracker");
});

test("a bare host in prose counts as an unlinked mention", () => {
  const html = "<p>Data from irishvisaupdatetracker.pages.dev shows 43,800 decisions.</p>";
  assert.equal(classifyMention(html, SITE).status, "unlinked");
});

test("an unrelated page is none, not a missing link", () => {
  assert.equal(classifyMention("<p>Irish visa processing times explained.</p>", SITE).status, "none");
});

test("an unreachable page is reported separately from an unlinked one", async () => {
  const report = await auditMentions([
    "https://example.test/ok",
    "https://example.test/down",
    "not-a-url",
  ], {
    origin: SITE,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/down")) throw new Error("ECONNRESET");
      return new Response("<p>Mentioned the Irish Visa Decision Tracker</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.equal(report.checked, 3);
  assert.equal(report.unlinked, 1);
  assert.equal(report.unreachable, 1);
  assert.equal(report.linked, 0);
  assert.equal(report.rows.find((row) => row.status === "invalid").detail, "not an http(s) URL");
});

test("a non-HTML response is not treated as a page without a link", async () => {
  const report = await auditMentions(["https://example.test/file.pdf"], {
    origin: SITE,
    fetchImpl: async () => new Response("%PDF", {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }),
  });
  assert.equal(report.rows[0].status, "unreachable");
  assert.match(report.rows[0].detail, /not HTML/);
});
