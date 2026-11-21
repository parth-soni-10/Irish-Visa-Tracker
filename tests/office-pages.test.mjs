import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const SITE = "https://irishvisaupdatetracker.pages.dev";

const PAGES = [
  { file: "new-delhi-visa-decisions.html", route: "/new-delhi-visa-decisions", slug: "new-delhi", name: "New Delhi" },
  { file: "beijing-visa-decisions.html", route: "/beijing-visa-decisions", slug: "beijing", name: "Beijing" },
  { file: "abu-dhabi-visa-decisions.html", route: "/abu-dhabi-visa-decisions", slug: "abu-dhabi", name: "Abu Dhabi" },
  { file: "abuja-visa-decisions.html", route: "/abuja-visa-decisions", slug: "abuja", name: "Abuja" },
  { file: "ankara-visa-decisions.html", route: "/ankara-visa-decisions", slug: "ankara", name: "Ankara" },
  { file: "dublin-visa-decisions.html", route: "/dublin-visa-decisions", slug: "dublin", name: "Dublin" },
];

async function read(name) {
  return readFile(new URL(name, ROOT), "utf8");
}

test("office pages carry unique crawl metadata and working schema", async () => {
  for (const page of PAGES) {
    const html = await read(page.file);
    assert.match(html, new RegExp(`<title>[^<]*${page.name}[^<]*</title>`), page.file);
    assert.match(html, new RegExp(`<h1>[^<]*${page.name}[^<]*</h1>`), page.file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}${page.route}">`), page.file);
    assert.doesNotMatch(html, /<meta name="robots"[^>]*noindex/i, page.file);
    assert.doesNotMatch(html, /X-Robots-Tag/i, page.file);
    assert.match(html, /"@type": "Dataset"/);
    assert.match(html, /"@type": "FAQPage"/);
    assert.match(html, /"@type": "BreadcrumbList"/);
    assert.match(html, /data-office="decisions"/);
    assert.match(html, /data-office="latest-date"/);
    assert.match(html, /data-office="source-file"/);
    assert.match(html, /Recent report history/);
    assert.match(html, new RegExp(`<tbody[^>]*data-report-history="${page.slug}"`), page.file);
    assert.match(html, /Approval rate/);
    assert.match(html, /Official source/);
    assert.match(html, /At most 8 rows are shown; consecutive unchanged snapshots are collapsed into one row\./);
    assert.doesNotMatch(html, /undefined|\[object Object\]/, page.file);
    assert.match(html, /src="\/scripts\/time-mode.js"/, page.file);
    assert.doesNotMatch(html, /src="\/time-mode.js"/, page.file);
  }
});

test("New Delhi separates the official-file day from later tracker rows", async () => {
  const html = await read("new-delhi-visa-decisions.html");
  assert.match(html, /Latest official-file day/);
  assert.match(html, /19 November 2026: 183 decisions \(143 approved, 40 refused\)/);
  assert.match(html, /Tracker’s latest day/);
  assert.match(html, /20 November 2026: 65 decisions/);
  assert.match(html, /partial day, not in the latest official file/);
});

test("each office page links the tracker, all other offices and its CTA", async () => {
  for (const page of PAGES) {
    const html = await read(page.file);
    assert.match(html, new RegExp(`\\?tracker=visa&amp;tab=search&amp;office=${page.slug}`, "i"), page.file);
    for (const other of PAGES) {
      if (other.file === page.file) continue;
      assert.match(html, new RegExp(`href="${other.route}"`), `${page.file} is missing ${other.route}`);
    }
    assert.match(html, /href="\/visa-processing-times"/, page.file);
    assert.match(html, /href="\/daily-summaries"/, page.file);
    assert.match(html, /href="\/help"/, page.file);
    assert.match(html, /Searchable history/);
    assert.match(html, /class="table-wrap"[^>]*role="region"[^>]*tabindex="0"/);
    assert.match(html, /<section id="report-history">/);
    assert.match(html, /aria-label="Recent [^"]+ report history"/);

    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    for (const other of PAGES) {
      assert.match(footer, new RegExp(`href="${other.route}"`), `${page.file} footer is missing ${other.route}`);
    }
  }
});

test("the sitemap lists every office page with a lastmod", async () => {
  const sitemap = await read("sitemap.xml");
  for (const page of PAGES) {
    assert.match(sitemap, new RegExp(`<loc>${SITE}${page.route}</loc>`), page.file);
    const block = sitemap.match(new RegExp(`<url>\\s*<loc>${SITE}${page.route}</loc>[\\s\\S]*?</url>`));
    assert.ok(block, `${page.file} is missing a sitemap entry`);
    assert.match(block[0], /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, page.file);
  }
});
