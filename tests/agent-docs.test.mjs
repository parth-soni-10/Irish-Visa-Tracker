/**
 * Agent-surface tests: content negotiation, Markdown documents, the 404
 * contract, and the metadata/structured data a crawler reads from index.html.
 *
 *   node --test tests/agent-docs.test.mjs
 *
 * These run without Wrangler: `_router.js` takes `env` as an argument, so a
 * fetch stub is enough to exercise the real routing decisions. Python's
 * scraper suites stay in pytest.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ABOUT_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCUMENTS,
  HOME_MARKDOWN,
  MARKDOWN_ALIASES,
  PRIVACY_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "../functions/_agent-docs.js";
import router from "../functions/_router.js";

const ROOT = new URL("../", import.meta.url);

async function read(name) {
  return readFile(new URL(name, ROOT), "utf8");
}

/** Text a crawler sees with scripts, styles and tags removed. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/" || path === "/index.html") {
      return new Response("<!doctype html><h1>Irish Visa Decision Tracker</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/about" || path === "/about.html") {
      return new Response("<!doctype html><h1>About</h1>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response("<!doctype html><h1>Not found</h1>", {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

const env = { ASSETS };
const call = (path, accept, method = "GET") =>
  router.fetch(
    new Request(`https://irishvisaupdatetracker.pages.dev${path}`, {
      method,
      headers: accept ? { Accept: accept } : {},
    }),
    env
  );

test("negotiate: an explicit Markdown request wins", () => {
  assert.equal(negotiate("text/markdown"), "markdown");
  assert.equal(negotiate("text/markdown, text/html;q=0.9"), "markdown");
  assert.equal(negotiate("text/markdown;q=0.9, text/html;q=0.8"), "markdown");
});

test("negotiate: browsers and wildcards still get HTML", () => {
  assert.equal(negotiate("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), "html");
  assert.equal(negotiate("text/html"), "html");
  assert.equal(negotiate("*/*"), "html");
  assert.equal(negotiate(null), "html");
  assert.equal(negotiate(""), "html");
});

test("negotiate: a refusal of both formats is 406, not Markdown", () => {
  assert.equal(negotiate("application/json"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0, text/html;q=0"), "not-acceptable");
});

test("negotiate: Markdown with HTML refused is still Markdown", () => {
  assert.equal(negotiate("text/markdown, text/html;q=0"), "markdown");
});

test("documents are substantial and start with a single H1", () => {
  const docs = {
    home: HOME_MARKDOWN,
    about: ABOUT_MARKDOWN,
    contact: CONTACT_MARKDOWN,
    privacy: PRIVACY_MARKDOWN,
  };
  for (const [name, body] of Object.entries(docs)) {
    assert.ok(body.trim().length > 500, `${name} Markdown is too short`);
    const headings = body.split("\n").filter((line) => /^#{1,6} /.test(line));
    assert.equal(headings.filter((line) => line.startsWith("# ")).length, 1, `${name} needs one H1`);
    assert.ok(headings[0].startsWith("# "), `${name} must start its heading outline at H1`);
  }
});

test("home Markdown names the queues an agent comes for", () => {
  for (const phrase of ["Embassy of Ireland", "visa decisions", "Stamp 1G", "employment", "community"]) {
    assert.match(HOME_MARKDOWN, new RegExp(phrase, "i"));
  }
  assert.match(HOME_MARKDOWN, /\/data\/visa_decisions\.json/);
  assert.match(HOME_MARKDOWN, /\/llms\.txt/);
});

test("404 Markdown explains the miss and links the way back", () => {
  const body = notFoundMarkdown("/__ora-404-probe");
  assert.ok(body.length > 20);
  assert.match(body, /__ora-404-probe/);
  assert.match(body, /sitemap\.xml/);
  assert.match(body, /llms\.txt/);
});

test("router: homepage negotiates Markdown with the right headers", async () => {
  const response = await call("/", "text/markdown");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  assert.match(await response.text(), /^# Irish Visa Decision Tracker/);
});

test("router: homepage still serves HTML to a browser with Vary", async () => {
  const response = await call("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary"), /Accept/);
  assert.match(response.headers.get("Link"), /rel="alternate"/);
  assert.match(await response.text(), /<h1>/);
});

test("router: .md aliases always answer Markdown", async () => {
  for (const [path, body] of MARKDOWN_ALIASES) {
    const response = await call(path, "text/html");
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8", path);
    assert.match(await response.text(), new RegExp(`^# ${body.split("\n")[0].slice(2)}`), path);
  }
});

test("router: a missing path is a Markdown 404 when Markdown is requested", async () => {
  const response = await call("/__ora-404-probe-c88mv9ow", "text/markdown");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.match(body, /__ora-404-probe-c88mv9ow/);
  assert.match(body, /llms\.txt/);
});

test("router: the same missing path keeps the HTML 404 for browsers", async () => {
  const response = await call("/__ora-404-probe-c88mv9ow", "text/html");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary"), /Accept/);
});

test("router: 406 when neither format is acceptable", async () => {
  const response = await call("/", "application/json");
  assert.equal(response.status, 406);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
});

test("router: HEAD has no body but keeps the Markdown contract", async () => {
  const response = await call("/about.md", null, "HEAD");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(await response.text(), "");
});

test("markdownResponse: body-free for HEAD, Vary preserved on merge", () => {
  const head = markdownResponse("# Hi", 200, "HEAD");
  assert.equal(head.headers.get("Vary"), "Accept");
  assert.equal(markdownResponse("x").headers.get("Content-Type"), "text/markdown; charset=utf-8");

  const headers = new Headers({ Vary: "Accept-Encoding" });
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
});

test("every page title the app sets carries the brand", async () => {
  const html = await read("index.html");
  const titles = [...html.matchAll(/document\.title = '([^']+)'/g)].map((match) => match[1]);
  assert.ok(titles.length >= 4, "expected the app's four titles");
  for (const title of titles) assert.match(title, /Irish Visa Decision Tracker/);
});

test("homepage HTML has content without JavaScript", async () => {
  const html = await read("index.html");
  assert.match(html, /<html lang="en">/);
  const article = html.match(/<article class="static-fallback">([\s\S]*?)<\/article>/);
  assert.ok(article, "static fallback article is missing");
  const text = visibleText(article[1]);
  assert.ok(text.length > 500, `static homepage text is only ${text.length} chars`);
  assert.match(text, /Irish Visa Decision Tracker/);
  assert.match(text, /Embassy of Ireland/);
  assert.match(text, /Stamp 1G/);
  assert.match(text, /\/about|About the project/);
});

test("homepage metadata and structured data are complete", async () => {
  const html = await read("index.html");
  assert.match(html, /<link rel="canonical" href="https:\/\/irishvisaupdatetracker\.pages\.dev\/">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/irishvisaupdatetracker\.pages\.dev\/og-image\.png">/);
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/index\.md"/);

  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, "expected exactly one JSON-LD block");
  const data = JSON.parse(blocks[0][1]);
  const nodes = data["@graph"];
  const organization = nodes.find((node) => node["@type"] === "Organization");
  const app = nodes.find((node) => node["@type"] === "SoftwareApplication");
  const site = nodes.find((node) => node["@type"] === "WebSite");
  assert.ok(organization, "Organization node missing");
  assert.ok(app, "SoftwareApplication node missing");
  assert.ok(site, "WebSite node missing");
  assert.equal(organization.contactPoint["@type"], "ContactPoint");
  assert.ok(organization.contactPoint.email);
  assert.ok(organization.contactPoint.contactType);
  assert.equal(organization.address["@type"], "PostalAddress");
  assert.ok(organization.address.addressLocality);
  assert.equal(app.offers.price, "0");
  assert.ok(app.featureList.length >= 3);
});

test("trust pages are real pages with the expected content", async () => {
  for (const [file, needles] of [
    ["about.html", ["About the Irish Visa Decision Tracker", "What it tracks", "What it is not"]],
    ["contact.html", ["Contact and corrections", "Where to send it", "soni.soni.parth@gmail.com"]],
    ["privacy.html", ["Privacy notice", "localStorage", "Form submissions"]],
  ]) {
    const html = await read(file);
    const text = visibleText(html);
    assert.ok(text.length > 500, `${file} has only ${text.length} chars`);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<link rel="canonical"/);
    for (const needle of needles) assert.match(text, new RegExp(needle));
  }
});

test("sitemap, robots and llms.txt point at the published pages", async () => {
  const sitemap = await read("sitemap.xml");
  for (const path of ["/", "/about", "/contact", "/privacy"]) {
    assert.match(sitemap, new RegExp(`<loc>https://irishvisaupdatetracker\\.pages\\.dev${path}</loc>`));
  }
  const robots = await read("robots.txt");
  assert.match(robots, /Sitemap: https:\/\/irishvisaupdatetracker\.pages\.dev\/sitemap\.xml/);
  const llms = await read("llms.txt");
  assert.match(llms, /## When to use this/);
  assert.match(llms, /Accept: text\/markdown/);
});

test("every negotiated document maps to a Markdown alternate and an HTML file", () => {
  for (const [path, doc] of DOCUMENTS) {
    assert.ok(doc.markdown.length > 500, path);
    assert.ok(doc.alternate.endsWith(".md"), path);
    assert.ok(MARKDOWN_ALIASES.has(doc.alternate), path);
    assert.ok(doc.file.endsWith(".html"), path);
  }
});
