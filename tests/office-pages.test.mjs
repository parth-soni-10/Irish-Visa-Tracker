import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const ROOT = new URL("../", import.meta.url);
const SITE = "https://irishvisaupdatetracker.pages.dev";

const COUNTRY_INTENT = {
  "new-delhi": /India, Bangladesh, Nepal and Sri Lanka/,
  beijing: /China, Hong Kong, Macau and Mongolia/,
  "abu-dhabi": /UAE, Afghanistan, Algeria/,
  abuja: /Nigeria, Côte d’Ivoire, Ghana and Senegal/,
  ankara: /Türkiye, Azerbaijan and visa-required nationals resident in Saudi Arabia/,
  dublin: /Pakistan[^.]*transferred|transferred[^.]*Pakistan/s,
};

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
    assert.match(html, new RegExp(`<title>${page.name} Ireland Visa Decisions .*— \\d{1,2} [A-Z][a-z]+ \\d{4}`), page.file);
    assert.match(html, new RegExp(`<h1>[^<]*${page.name}[^<]*</h1>`), page.file);
    assert.match(html, /<section class="page-answer"/, page.file);
    assert.match(html, /What this page answers/, page.file);
    assert.match(html, /What it cannot tell you/, page.file);
    assert.match(html, /<h1>[^<]*Irish visa decisions<\/h1>/, page.file);
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] || "";
    assert.ok(description.length > 80 && description.length <= 160, `${page.file}: description is ${description.length} chars`);
    assert.match(html, new RegExp(`<link rel="canonical" href="${SITE}${page.route}">`), page.file);
    assert.doesNotMatch(html, /<meta name="robots"[^>]*noindex/i, page.file);
    assert.doesNotMatch(html, /X-Robots-Tag/i, page.file);
    assert.match(html, /"@type": "Dataset"/);
    assert.match(html, /"@type": "FAQPage"/);
    assert.match(html, /"@type": "BreadcrumbList"/);
    assert.match(html, COUNTRY_INTENT[page.slug], `${page.file}: country intent missing from visible copy`);
    assert.match(html, new RegExp(`<link rel="alternate" type="text/markdown" href="${page.route}\\.md"`), page.file);
    assert.match(html, new RegExp(`og:image" content="${SITE}/assets/social/office-${page.slug}\\.png"`), page.file);
    assert.match(html, /href="\/monthly-report\?utm_source=office_page/, page.file);
    assert.doesNotMatch(html, /by email/i, page.file);
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
  assert.match(html, /href="\/daily-summaries">New Delhi decisions by date<\/a>/);
  assert.match(html, /Latest official-file day/);
  assert.match(
    html,
    /data-office="latest-day">\d{1,2} [A-Z][a-z]+ \d{4}: [\d,]+ decisions? \([\d,]+ approved, [\d,]+ refused\)/,
  );
  assert.match(html, /Tracker’s latest day/);
  assert.match(
    html,
    /data-office="tracker-latest">\d{1,2} [A-Z][a-z]+ \d{4}: [\d,]+ decisions \([\d,]+ approved, [\d,]+ refused; partial day, not in the .* official file\)/,
  );
  assert.match(html, /partial day, not in the .* official file/);
});

test("each office page links the tracker, all other offices and its CTA", async () => {
  for (const page of PAGES) {
    const html = await read(page.file);
    assert.match(html, new RegExp(`\\?tracker=visa&amp;tab=search&amp;office=${page.slug}`, "i"), page.file);
    assert.match(html, /<label[^>]*>Search by application number<\/label>/, page.file);
    assert.match(html, /Cite this page:/, page.file);
    for (const other of PAGES) {
      if (other.file === page.file) continue;
      assert.match(html, new RegExp(`href="${other.route}"`), `${page.file} is missing ${other.route}`);
      const anchor = other.slug === "new-delhi"
        ? "New Delhi Irish visa decisions"
        : `Irish visa decisions in ${other.name}`;
      assert.match(html, new RegExp(`>${anchor}<\/a>`), `${page.file} is missing a descriptive ${other.name} anchor`);
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

test("Abu Dhabi excludes Pakistan and cross-links Dublin instead", async () => {
  const html = await read("abu-dhabi-visa-decisions.html");
  assert.doesNotMatch(html, /<title>[^<]*Pakistan/);
  assert.doesNotMatch(html, /Pakistan,/);
  assert.match(html, /Abu Dhabi’s published country list does not include Pakistan/);
  assert.match(html, /<a href="\/dublin-visa-decisions">Dublin Visa Office<\/a>/);

  const config = JSON.parse(await read("embassy-config.json"));
  const abuDhabi = config.embassies.find((office) => office.slug === "abu-dhabi");
  const dublin = config.embassies.find((office) => office.slug === "dublin");
  assert.ok(abuDhabi, "Abu Dhabi office is missing from embassy-config.json");
  assert.ok(dublin, "Dublin office is missing from embassy-config.json");
  assert.ok(!abuDhabi.countries.includes("Pakistan"));
  assert.ok(dublin.countries.includes("Pakistan"));

  const generator = await read("tools/office-pages.mjs");
  const abuDhabiSource = generator.slice(
    generator.indexOf("slug: 'abu-dhabi'"),
    generator.indexOf("slug: 'abuja'"),
  );
  assert.doesNotMatch(abuDhabiSource, /title: '[^']*Pakistan/);
  assert.doesNotMatch(abuDhabiSource, /description: '[^']*Pakistan/);
  assert.doesNotMatch(abuDhabiSource, /coverage: \[[^\]]*Pakistan/);
  assert.match(abuDhabiSource, /href="\/dublin-visa-decisions"/);

  const agentDocs = await read("functions/_agent-docs.js");
  const abuDhabiDocs = agentDocs.slice(
    agentDocs.indexOf("export const ABU_DHABI_MARKDOWN"),
    agentDocs.indexOf("export const ABUJA_MARKDOWN"),
  );
  assert.doesNotMatch(abuDhabiDocs, /title: "[^"]*Pakistan/);
  assert.doesNotMatch(abuDhabiDocs, /countries: "[^"]*Pakistan/);
  assert.match(abuDhabiDocs, /\[Dublin Visa Office\]\(https:\/\/irishvisaupdatetracker\.pages\.dev\/dublin-visa-decisions\)/);
});
