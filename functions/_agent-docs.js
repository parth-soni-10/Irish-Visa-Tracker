/* ---------------------------------------------------------------------------
 * The site's agent-facing documents, in one place.
 *
 * `_router.js` serves these; nothing here touches a request or a data file, so
 * the negotiation and the copy can be tested with `node --test` without a
 * Pages runtime.
 *
 * The Markdown is written here rather than scraped from index.html at request
 * time: the dashboard renders its tables, counts and trackers from JavaScript,
 * so a DOM scrape would hand an agent the loading shell. This copy is the
 * stable description - what the tracker records, where the JSON lives, and
 * what the numbers do not mean.
 * ------------------------------------------------------------------------- */

export const SITE = "https://irishvisaupdatetracker.pages.dev";
export const EMAIL = "soni.soni.parth@gmail.com";

const lines = (...parts) => parts.join("\n").trim() + "\n";

export const HOME_MARKDOWN = lines(
  "# Irish Visa Decision Tracker",
  "",
  "An independent, unofficial tracker for visa decisions published by the **Embassy of Ireland",
  "in New Delhi**, plus Stamp 1G and employment-permit processing dates. It turns the embassy's",
  "daily flat spreadsheet into a searchable history with daily approved/refused summaries, and",
  "keeps a public record of the processing queues published by ISD and DETE.",
  "",
  "- **Live site:** https://irishvisaupdatetracker.pages.dev/",
  "- **Maintainer:** Parth Soni, Data Analyst, Dublin, Ireland",
  "- **Contact:** soni.soni.parth@gmail.com",
  "- **Code and data:** https://github.com/parth-soni-10/Irish-Visa-Tracker",
  "",
  "## What it tracks",
  "",
  "### Embassy visa decisions",
  "",
  "Every business day the Embassy of Ireland in New Delhi publishes a spreadsheet of visa",
  "decisions. The tracker records each application number, the date it was published and whether",
  "it was approved or refused. On the site you can search by application number, see the latest",
  "decisions, browse daily summaries and look at trends. The same rows are in",
  "`/data/visa_decisions.json` as `[date, application number, decision]` arrays.",
  "",
  "### Daily summaries",
  "",
  "For each published day the dashboard shows how many applications were approved and refused,",
  "and can expand a day to list the applications behind those counts. A day with no embassy file",
  "is shown as a closure or placeholder rather than counted as a decision.",
  "",
  "### Stamp 1G processing",
  "",
  "The Stamp 1G tracker records the application date ISD is currently processing, the lag in days",
  "and weeks, and how that lag has moved. Observations are in `/data/stamp_1g.json` with",
  "`run_date`, `processing_date`, `lag_days`, `lag_weeks` and `category` fields.",
  "",
  "### Employment permits",
  "",
  "The employment-permit tracker records the processing date reached for each published permit",
  "category, with lags and trends. Observations are in `/data/work_permits.json` with `run_date`,",
  "`category`, `processing_date`, `lag_days` and `lag_weeks` fields.",
  "",
  "### Community timelines",
  "",
  "Visitors can share the dates and outcome of their own application. Those rows are stored in",
  "the site's D1 database, merged nightly into `/data/community_timelines.json`, and exposed",
  "without names at `GET /api/community-submissions` for the sync. They are anecdotes, not a",
  "statistical sample, and the public file may be empty.",
  "",
  "## Data endpoints",
  "",
  "All are public, read-only and same-origin:",
  "",
  "- `GET /data/visa_decisions.json` - `[ [date, application, \"Approved\" | \"Refused\"], … ]`.",
  "- `GET /data/visa_meta.json` - scraper health: `lastRunAt`, `sheetRows`, `newRows`, `fileDate`,",
  "  `fileRows`, `ok`, `closureDates`.",
  "- `GET /data/stamp_1g.json` - Stamp 1G observations.",
  "- `GET /data/work_permits.json` - employment-permit observations.",
  "- `GET /data/community_timelines.json` - merged public community rows (shape may change; read",
  "  the file rather than assuming).",
  "- `GET /api/community-submissions` - `{ submissions: [ { form, fields, created_at } ] }` for the",
  "  two timeline forms. Never the private suggestions form.",
  "",
  "There is no per-application lookup endpoint. To answer a question about one application,",
  "fetch `/data/visa_decisions.json` and search the array; it is a few megabytes, so cache it",
  "within a run.",
  "",
  "## How fresh is the data?",
  "",
  "A scheduled Python scraper on GitHub Actions fetches the embassy file, handles weekends and",
  "public holidays, and commits new rows to the public repository. The site reads those committed",
  "files, so a run appears without a redeploy. GitHub's scheduled runs can land late, and the",
  "embassy does not publish on weekends or public holidays. Read `lastRunAt` and `ok` in",
  "`/data/visa_meta.json` before describing the data as current.",
  "",
  "## What this is not",
  "",
  "This is an unofficial project. It is not affiliated with the Embassy of Ireland, ISD, DETE or",
  "any Irish government body. It does not give immigration advice, predict an individual outcome,",
  "expedite an application or see private case data. Community timelines and projections are",
  "estimates. For a decision on a real case, contact the official body handling it.",
  "",
  "## Pages",
  "",
  "- [About](https://irishvisaupdatetracker.pages.dev/about) - sources, method and limits.",
  "- [Contact](https://irishvisaupdatetracker.pages.dev/contact) - corrections, bugs and scope.",
  "- [Privacy](https://irishvisaupdatetracker.pages.dev/privacy) - browser storage and form data.",
  "- [Daily summaries](https://irishvisaupdatetracker.pages.dev/daily-summaries) - approved and refused counts by published day.",
  "- [Stamp 1G processing dates](https://irishvisaupdatetracker.pages.dev/stamp-1g-processing-dates) - the queue date ISD has reached and the lag.",
  "- [Sitemap](https://irishvisaupdatetracker.pages.dev/sitemap.xml)",
  "- [Agent guide](https://irishvisaupdatetracker.pages.dev/llms.txt)",
  ""
);

export const ABOUT_MARKDOWN = lines(
  "# About the Irish Visa Decision Tracker",
  "",
  "**Last updated:** 21 October 2026",
  "",
  "The Embassy of Ireland in New Delhi publishes a spreadsheet of visa decisions every business",
  "day - one flat file with no history, no search and no trends. This independent project keeps a",
  "running, searchable record of those decisions and tracks the processing queues that matter",
  "alongside them.",
  "",
  "## What it tracks",
  "",
  "- Embassy visa decisions: application number, decision date and approved/refused outcome,",
  "  searchable by application number.",
  "- Daily summaries: approved and refused counts for each published day, with the applications",
  "  behind those counts available on demand.",
  "- Stamp 1G processing: the application date ISD is currently processing, the lag, and how it",
  "  has moved.",
  "- Employment permits: the processing date reached for each permit category, with trends.",
  "- Community timelines: waits shared by visitors, merged nightly. Anecdotes, not a sample.",
  "",
  "## Where the data comes from",
  "",
  "The decision rows come from the embassy's published spreadsheet. A scheduled Python scraper",
  "fetches the file, handles weekends and public holidays, and commits new rows to the public",
  "GitHub repository. Stamp 1G and employment-permit figures come from the processing dates",
  "published by ISD and DETE. The site reads the committed JSON files, so a pipeline run appears",
  "without a redeploy.",
  "",
  "Read the same files: `/data/visa_decisions.json`, `/data/visa_meta.json`,",
  "`/data/stamp_1g.json`, `/data/work_permits.json`, `/data/community_timelines.json`.",
  "",
  "## Who runs it",
  "",
  "Parth Soni, a data analyst in Dublin, built it as a way to answer one question - has my",
  "application been decided yet? - without opening a different spreadsheet every morning. The",
  "code and the pipeline are public at https://github.com/parth-soni-10/Irish-Visa-Tracker.",
  "",
  "## What it is not",
  "",
  "It is unofficial and not affiliated with the Embassy of Ireland, ISD, DETE or any Irish",
  "government body. It does not give immigration advice, cannot speed up an application, and",
  "cannot guarantee an outcome. For a decision on a real case, use the official channels; the",
  "tracker only reflects what has already been published.",
  "",
  "Corrections: email soni.soni.parth@gmail.com or open an issue in the repository with the date",
  "and source. Contact: https://irishvisaupdatetracker.pages.dev/contact",
  ""
);

export const CONTACT_MARKDOWN = lines(
  "# Contact and corrections",
  "",
  "This is a personal project, so there is no support desk and no guaranteed response time.",
  "Corrections that can be checked against the published source are usually fixed quickly.",
  "",
  "## Where to send it",
  "",
  "- **Email:** soni.soni.parth@gmail.com - best for data corrections, missing rows or a privacy",
  "  question.",
  "- **GitHub issues:** https://github.com/parth-soni-10/Irish-Visa-Tracker/issues - best for a",
  "  reproducible bug in the dashboard or the scrapers.",
  "- **Suggestion form:** https://irishvisaupdatetracker.pages.dev/?tab=suggest - best for a",
  "  feature request or a general note. It is stored in the site's D1 database.",
  "",
  "## What makes a correction actionable",
  "",
  "Include the application number and decision date, the page or file where you saw it, the",
  "tracker and category for a processing-date issue, and what the tracker currently shows versus",
  "what you believe it should show.",
  "",
  "## What not to send",
  "",
  "Do not email passport scans, application receipts, payment details, PPS numbers or other",
  "personal documents. Nothing on this site needs them. For an individual immigration case,",
  "contact the Embassy of Ireland in New Delhi, ISD or a qualified immigration adviser - this",
  "site cannot give advice and cannot see a case file.",
  "",
  "## Privacy",
  "",
  "Email is processed by Gmail. Suggestion-form submissions are stored in D1 and are not",
  "published. Timeline submissions are published in the public community data after the nightly",
  "sync. Full details: https://irishvisaupdatetracker.pages.dev/privacy",
  ""
);

export const PRIVACY_MARKDOWN = lines(
  "# Privacy notice - Irish Visa Decision Tracker",
  "",
  "**Last updated:** 21 October 2026",
  "",
  "The tracker has no accounts, no sign-in, no advertising and no analytics product. This page",
  "explains the small amount of data it handles: preferences in your browser, the two kinds of",
  "form submissions, hosting logs and email.",
  "",
  "## What is stored in your browser",
  "",
  "The dashboard uses `localStorage`, not cookies. None of it is sent to the server unless you",
  "submit a form. The keys are `visa-theme` (light/dark), `visa-last-visit` (the last-visit line),",
  "`visa-snapshot-gz` / `visa-snapshot-plain` (the last successful decision download, for offline",
  "rendering), `visa-recent-searches` and `visa-watchlist` (application numbers you looked up or",
  "chose to watch), and `stamp1g-category`, `stamp1g-apply-date`, `stamp1g-apply-mode`,",
  "`stamp1g-expiry` and `permits-category` (filters and dates in the estimators). Clearing site",
  "data removes all of it. There is no cross-site tracker and no cookie to consent to.",
  "",
  "## Form submissions",
  "",
  "**Timeline submissions** (`timelines-visa`, `timelines-1g`) store the application date,",
  "decision date, outcome and tracker. These rows are public by design: they are merged into",
  "`/data/community_timelines.json` and served without names at `GET /api/community-submissions`",
  "for the nightly sync. The form does not ask for a name; do not include personal details.",
  "",
  "**Suggestions** (`suggestions`) store the name and free text entered. They are used to improve",
  "the tracker, are not published, and are not served by the public submissions endpoint.",
  "",
  "Rows carry a creation timestamp and are kept until they are no longer useful or removal is",
  "requested. There is no automatic expiry. Bot-field honeypot submissions are discarded.",
  "",
  "## Hosting and server logs",
  "",
  "The site runs on Cloudflare Pages with a Pages Function and a D1 database. Cloudflare",
  "processes the request needed to serve a page or accept a form - including IP address, requested",
  "URL, user agent and timestamp - under its own privacy terms, and may keep security and",
  "operational logs. Parth does not run an analytics product over those logs, does not build",
  "visitor profiles and does not sell or share them.",
  "",
  "The decision, Stamp 1G and permit figures are public records read from the project's GitHub",
  "repository and the official publishers. The site does not collect anything about the people",
  "named in those public files.",
  "",
  "## Email",
  "",
  "Email to soni.soni.parth@gmail.com is processed by Gmail so it can be delivered and answered.",
  "It is used to reply and keep a record of the conversation; it is not added to a marketing list",
  "and is not sold. Ask for a message to be deleted and it will be, unless a legal obligation",
  "requires it to be kept.",
  "",
  "## Your rights",
  "",
  "Under the GDPR you can ask what personal data is held about you, request a copy, ask for",
  "correction or erasure, or object to processing. Use soni.soni.parth@gmail.com. You also have",
  "the right to complain to the Irish Data Protection Commission",
  "(https://www.dataprotection.ie/).",
  "",
  "## Changes and contact",
  "",
  "If this page changes, the date at the top changes with it. Privacy questions:",
  "soni.soni.parth@gmail.com. General corrections:",
  "https://irishvisaupdatetracker.pages.dev/contact",
  ""
);

export function notFoundMarkdown(pathname) {
  const path = pathname && pathname !== "/" ? pathname : "this address";
  return lines(
    "# Page not found",
    "",
    `Nothing is published at \`${path}\` on irishvisaupdatetracker.pages.dev. The page may have`,
    "moved, or the link may be mistyped.",
    "",
    "Start from the [tracker home page](https://irishvisaupdatetracker.pages.dev/). Every",
    "published page is listed in the",
    "[sitemap](https://irishvisaupdatetracker.pages.dev/sitemap.xml), and",
    "[llms.txt](https://irishvisaupdatetracker.pages.dev/llms.txt) explains what the site",
    "contains and when to use it.",
    ""
  );
}

export const NOT_ACCEPTABLE_MARKDOWN = lines(
  "# Not acceptable",
  "",
  "This site publishes HTML and Markdown. The request's `Accept` header excludes both, so no",
  "representation can be returned.",
  "",
  "Ask for `text/html` or `text/markdown`. The Markdown home page is at",
  "https://irishvisaupdatetracker.pages.dev/index.md, and",
  "https://irishvisaupdatetracker.pages.dev/llms.txt describes the site.",
  ""
);

/* ---------------------------------------------------------------------------
 * Content negotiation (RFC 9110 §12.5.1).
 *
 * A request is served Markdown only when `text/markdown` was named explicitly
 * and its quality is at least the quality of `text/html`; a browser's
 * `text/html, …, *` (wildcard) header therefore still gets HTML, and curl's
 * default wildcard does too. Wildcards contribute quality but never select
 * Markdown on their own. `text/markdown;q=0` is a refusal, not a request.
 * ------------------------------------------------------------------------- */

function parseAccept(header) {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.trim().split(";");
      const [type, subtype] = rawType.trim().toLowerCase().split("/");
      if (!type || !subtype) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key && key.trim().toLowerCase() === "q") {
          const parsed = Number.parseFloat(value);
          q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
        }
      }
      return { type, subtype, q };
    })
    .filter(Boolean);
}

function qualityFor(type, subtype, ranges) {
  let best = null;
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best ? best.q : 0;
}

/**
 * @param {string | null} header the request's Accept header
 * @returns {"markdown" | "html" | "not-acceptable"}
 */
export function negotiate(header) {
  if (!header || !header.trim()) return "html";
  const ranges = parseAccept(header);
  if (ranges.length === 0) return "html";

  const namedMarkdown = ranges.some(
    (range) => range.type === "text" && range.subtype === "markdown"
  );
  const markdown = qualityFor("text", "markdown", ranges);
  const html = qualityFor("text", "html", ranges);

  if (namedMarkdown && markdown > 0 && markdown >= html) return "markdown";
  if (html > 0) return "html";
  if (!namedMarkdown && markdown > 0) return "markdown";
  return "not-acceptable";
}

export const DAILY_SUMMARIES_MARKDOWN = lines(
  "# Daily visa decision summaries",
  "",
  "Approved and refused counts for each day the Embassy of Ireland in New Delhi has published",
  "visa decisions, drawn from the tracker's running record of those decisions.",
  "",
  "- **Last static build:** 7 November 2026",
  "- **Decisions on record:** 42,382 at that build - read `/data/visa_meta.json` for the current",
  "  count",
  "- **Source data:** `/data/visa_decisions.json`, rows shaped `[date, application number, decision]`",
  "- **Unofficial:** not affiliated with the Embassy of Ireland, ISD or DETE, and not immigration",
  "  advice",
  "",
  "## How to read the counts",
  "",
  "- **Approved** / **Refused** - the outcome the embassy published for that application number.",
  "- **Published day** - the date the embassy published the file, which is not necessarily the",
  "  date the decision was made on a case.",
  "- **Closures** - a day with no embassy file is a closure or placeholder, not a day with zero",
  "  decisions.",
  "",
  "Counts describe what the embassy published. They are not an approval rate for applications",
  "submitted on that day, and they say nothing about a case that has not appeared in a published",
  "file yet.",
  "",
  "## Why the archive matters",
  "",
  "The embassy's file is a single flat list with no history and no totals, so one day's file shows",
  "what was published that day but not how volume has moved or which days were closures. Keeping",
  "every published day in one record is what makes those comparisons possible.",
  "",
  "A missing application number means the decision has not been published yet, the application",
  "sits with a different visa office, or that day's file was not published - not that the",
  "application was refused.",
  "",
  "## Official sources",
  "",
  "- ISD visa decisions: https://www.irishimmigration.ie/visa-decisions/",
  "- ISD visa offices and which office handles which countries:",
  "  https://www.irishimmigration.ie/visa-offices/",
  "- Embassy of Ireland in India: https://www.ireland.ie/india",
  "",
  "If a figure here disagrees with the official page, the official page is correct.",
  "",
  "## Related pages",
  "",
  "- [Tracker](https://irishvisaupdatetracker.pages.dev/) - search an application number.",
  "- [Stamp 1G processing dates](https://irishvisaupdatetracker.pages.dev/stamp-1g-processing-dates)",
  "- [About](https://irishvisaupdatetracker.pages.dev/about) - sources, method and limits.",
  "- [Contact](https://irishvisaupdatetracker.pages.dev/contact) - corrections.",
  ""
);

export const STAMP_1G_MARKDOWN = lines(
  "# Stamp 1G processing dates - Ireland",
  "",
  "The Stamp 1G application date that ISD (Immigration Service Delivery) is currently processing,",
  "the lag in days and weeks, and how that lag has moved. The observations are in",
  "`/data/stamp_1g.json`.",
  "",
  "- **Last static build:** 7 November 2026",
  "- **Latest observation:** ISD processing applications received on 28 September 2026, a lag of",
  "  40 days - read `/data/stamp_1g.json` for the current values",
  "- **Unofficial:** not affiliated with the Embassy of Ireland, ISD or DETE, and not immigration",
  "  advice",
  "",
  "## How to read the lag",
  "",
  "- **Processing date** - the application date ISD says it has reached. Applications received",
  "  after that date have not been reached yet.",
  "- **Lag** - the gap between the processing date and the date ISD published it. It describes",
  "  the queue, not an individual case.",
  "- **Direction** - a growing lag means the queue is falling further behind; a shrinking lag",
  "  means ISD is catching up.",
  "",
  "The queue date is published for the scheme as a whole. It is not a promise about when an",
  "individual application will be decided, and a case can be decided earlier or later than the",
  "published date suggests.",
  "",
  "## Official sources",
  "",
  "- ISD visa decisions and processing times: https://www.irishimmigration.ie/visa-decisions/",
  "- ISD visa offices: https://www.irishimmigration.ie/visa-offices/",
  "- Embassy of Ireland in India: https://www.ireland.ie/india",
  "",
  "If a figure here disagrees with the official page, the official page is correct.",
  "",
  "## Related pages",
  "",
  "- [Tracker](https://irishvisaupdatetracker.pages.dev/) - search an application number.",
  "- [Daily summaries](https://irishvisaupdatetracker.pages.dev/daily-summaries)",
  "- [About](https://irishvisaupdatetracker.pages.dev/about) - sources, method and limits.",
  "- [Contact](https://irishvisaupdatetracker.pages.dev/contact) - corrections.",
  ""
);

export const EMPLOYMENT_PERMITS_MARKDOWN = lines(
  "# Employment permit processing dates - Ireland",
  "",
  "The processing date reached in each employment-permit category published by DETE",
  "(Department of Enterprise, Tourism and Employment), with the lag in days and weeks. The",
  "observations are in `/data/work_permits.json`.",
  "",
  "- **Last static build:** 7 November 2026",
  "- **What is covered:** the seven published categories - Critical Skills, General (New),",
  "  ICT (New), ICT (Renewal), Other New, Renewals and Reviews",
  "- **Current values:** read `/data/work_permits.json` for the latest observation in each",
  "  category rather than trusting a figure quoted here",
  "- **Unofficial:** not affiliated with DETE or any Irish government body, and not immigration",
  "  advice",
  "",
  "## How to read a processing date",
  "",
  "- **Processing date** - the application date DETE says it has reached in that category.",
  "  Applications received after that date have not been reached yet.",
  "- **Lag** - the gap between the processing date and the date the figure was published. It",
  "  describes the queue, not an individual application.",
  "- **Categories move independently** - a fast category and a slow one can be months apart, so",
  "  an average across categories describes nobody.",
  "",
  "The published date is for the category as a whole. It is not a promise about when an",
  "individual application will be decided.",
  "",
  "## Official sources",
  "",
  "- DETE publishes its own employment-permit processing dates on enterprise.gov.ie; no stable",
  "  deep link was verified for this page, so none is given here.",
  "- ISD visa offices, for applications handled outside Ireland:",
  "  https://www.irishimmigration.ie/visa-offices/",
  "",
  "If a figure here disagrees with the official page, the official page is correct.",
  "",
  "## Related pages",
  "",
  "- [Tracker](https://irishvisaupdatetracker.pages.dev/) - search an application number.",
  "- [Stamp 1G processing dates](https://irishvisaupdatetracker.pages.dev/stamp-1g-processing-dates)",
  "- [Irish visa processing times](https://irishvisaupdatetracker.pages.dev/visa-processing-times)",
  "- [Daily summaries](https://irishvisaupdatetracker.pages.dev/daily-summaries)",
  "- [About](https://irishvisaupdatetracker.pages.dev/about) - sources, method and limits.",
  ""
);

export const PROCESSING_TIMES_MARKDOWN = lines(
  "# Irish visa processing times - what the published data shows",
  "",
  "There is no single processing time for an Irish visa. What the official publishers release,",
  "and what this tracker records, is a **queue date**: the application date each office or",
  "scheme has reached. The gap between that date and today is the lag.",
  "",
  "This page explains how to read those figures and where each one comes from. The current",
  "numbers live on the tracker pages and in the JSON files, not in this text.",
  "",
  "## The queues the tracker follows",
  "",
  "- **Embassy of Ireland, New Delhi - visa decisions.** Decisions published on business days,",
  "  recorded per application number. See `/data/visa_decisions.json`.",
  "- **Stamp 1G - ISD.** The application date ISD is processing, with the lag. See",
  "  `/data/stamp_1g.json`.",
  "- **Employment permits - DETE.** The date reached in each published permit category. See",
  "  `/data/work_permits.json`.",
  "",
  "## What a queue date does not tell you",
  "",
  "- It does not forecast your own application. A case can be decided before or after the",
  "  published date.",
  "- It does not cover every application type. Some categories are transferred between offices.",
  "- It does not move every day. A queue date can sit unchanged for days and then jump.",
  "- An application missing from a published decision list has not necessarily been refused.",
  "",
  "## Why lags are worth watching",
  "",
  "A single published date says little. Watching the same queue over time shows direction: a",
  "growing lag means the queue is falling further behind, a shrinking one means it is catching",
  "up. That trend is what this tracker records and what the official pages do not keep.",
  "",
  "## Official sources",
  "",
  "- ISD visa decisions and processing times: https://www.irishimmigration.ie/visa-decisions/",
  "- ISD visa offices: https://www.irishimmigration.ie/visa-offices/",
  "- DETE publishes its own employment-permit processing dates on enterprise.gov.ie.",
  "",
  "## Related pages",
  "",
  "- [Daily decision summaries](https://irishvisaupdatetracker.pages.dev/daily-summaries)",
  "- [Stamp 1G processing dates](https://irishvisaupdatetracker.pages.dev/stamp-1g-processing-dates)",
  "- [Employment permit processing dates](https://irishvisaupdatetracker.pages.dev/employment-permit-processing-dates)",
  "- [About](https://irishvisaupdatetracker.pages.dev/about) - sources, method and limits.",
  ""
);

export const DOCUMENTS = new Map([
  ["/", { markdown: HOME_MARKDOWN, alternate: "/index.md", file: "/index.html" }],
  ["/about", { markdown: ABOUT_MARKDOWN, alternate: "/about.md", file: "/about.html" }],
  ["/contact", { markdown: CONTACT_MARKDOWN, alternate: "/contact.md", file: "/contact.html" }],
  ["/privacy", { markdown: PRIVACY_MARKDOWN, alternate: "/privacy.md", file: "/privacy.html" }],
  [
    "/daily-summaries",
    {
      markdown: DAILY_SUMMARIES_MARKDOWN,
      alternate: "/daily-summaries.md",
      file: "/daily-summaries.html",
    },
  ],
  [
    "/stamp-1g-processing-dates",
    {
      markdown: STAMP_1G_MARKDOWN,
      alternate: "/stamp-1g-processing-dates.md",
      file: "/stamp-1g-processing-dates.html",
    },
  ],
  [
    "/employment-permit-processing-dates",
    {
      markdown: EMPLOYMENT_PERMITS_MARKDOWN,
      alternate: "/employment-permit-processing-dates.md",
      file: "/employment-permit-processing-dates.html",
    },
  ],
  [
    "/visa-processing-times",
    {
      markdown: PROCESSING_TIMES_MARKDOWN,
      alternate: "/visa-processing-times.md",
      file: "/visa-processing-times.html",
    },
  ],
]);

export const MARKDOWN_ALIASES = new Map([
  ["/index.md", HOME_MARKDOWN],
  ["/about.md", ABOUT_MARKDOWN],
  ["/contact.md", CONTACT_MARKDOWN],
  ["/privacy.md", PRIVACY_MARKDOWN],
  ["/daily-summaries.md", DAILY_SUMMARIES_MARKDOWN],
  ["/stamp-1g-processing-dates.md", STAMP_1G_MARKDOWN],
  ["/employment-permit-processing-dates.md", EMPLOYMENT_PERMITS_MARKDOWN],
  ["/visa-processing-times.md", PROCESSING_TIMES_MARKDOWN],
]);

/** Add Accept to a Vary header without dropping what is already there. */
export function mergeVary(headers) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Accept");
    return headers;
  }
  if (current.trim() === "*") return headers;
  const values = current.split(",").map((value) => value.trim().toLowerCase());
  if (!values.includes("accept")) headers.set("Vary", `${current}, Accept`);
  return headers;
}

export function markdownResponse(body, status = 200, method = "GET") {
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "Cache-Control": "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
