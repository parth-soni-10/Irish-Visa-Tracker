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

import { CONTENT_DATES } from "./_content-dates.js";

const lines = (...parts) => parts.join("\n").trim() + "\n";

export const HOME_MARKDOWN = lines(
  "# Irish Visa Decision Tracker",
  "",
  "An independent, unofficial tracker for visa decisions published by **six Irish visa offices**",
  "- New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin - plus Stamp 1G and",
  "employment-permit processing dates. It turns the offices' flat reports into a searchable",
  "history with daily approved/refused summaries, and keeps a public record of the processing",
  "queues published by ISD and DETE.",
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
  "On most weekdays the Embassy of Ireland in New Delhi publishes a spreadsheet of visa",
  "decisions. The tracker records each application number, the tracker-observed date and whether",
  "it was approved or refused. On the site you can search by application number, see the latest",
  "decisions, browse daily summaries and look at trends. The same rows are in",
  "`/data/visa_decisions.json` as `[date, application number, decision]` arrays.",
  "",
  "### Daily summaries",
  "",
  "For each tracker-observed day the dashboard shows how many applications were approved and refused,",
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
  "  three timeline forms (`timelines-visa`, `timelines-1g`, `timelines`). Never the private",
  "  suggestions form.",
  "- `GET /api/calendar/offices.ics` - a rolling webcal feed for all six offices. Stable UIDs;",
  "  expected windows are tentative and published report events are confirmed with source links.",
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
  "- [Correction ledger](https://irishvisaupdatetracker.pages.dev/corrections) - source-linked file diffs and changed rows.",
  "- [Privacy](https://irishvisaupdatetracker.pages.dev/privacy) - browser storage and form data.",
  "- [Daily summaries](https://irishvisaupdatetracker.pages.dev/daily-summaries) - approved and refused counts by tracker-observed day.",
  "- [Stamp 1G processing dates](https://irishvisaupdatetracker.pages.dev/stamp-1g-processing-dates) - the queue date ISD has reached and the lag.",
  "- [Sitemap](https://irishvisaupdatetracker.pages.dev/sitemap.xml)",
  "- [Agent guide](https://irishvisaupdatetracker.pages.dev/llms.txt)",
  ""
);

export const ABOUT_MARKDOWN = lines(
  "# About the Irish Visa Decision Tracker",
  "",
  `**Last updated:** ${CONTENT_DATES["/about"] || "Not recorded"}`,
  "",
  "Six Irish visa offices - New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin - publish",
  "visa decision files and totals: flat lists with no history, no search and no trends. This",
  "independent project keeps a running, searchable record of those decisions and tracks the",
  "processing queues that matter alongside them.",
  "",
  "## What it tracks",
  "",
  "- Embassy visa decisions: application number, decision date and approved/refused outcome,",
  "  searchable by application number.",
  "- Daily summaries: approved and refused counts for each tracker-observed day, with the applications",
  "  behind those counts available on demand.",
  "- Stamp 1G processing: the application date ISD is currently processing, the lag, and how it",
  "  has moved.",
  "- Employment permits: the processing date reached for each permit category, with trends.",
  "- Community timelines: waits shared by visitors, merged nightly. Anecdotes, not a sample.",
  "",
  "## Where the data comes from",
  "",
  "The decision rows come from the published reports of six Irish visa offices: New Delhi,",
  "Beijing, Abu Dhabi, Abuja, Ankara and Dublin. A scheduled Python scraper fetches the files,",
  "handles weekends and public holidays, and commits new rows to the public GitHub repository.",
  "Stamp 1G and employment-permit figures come from the processing dates published by ISD and",
  "DETE. The site reads the committed JSON files, so a pipeline run appears without a redeploy.",
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
  "- **Structured error report:** https://irishvisaupdatetracker.pages.dev/contact#report-error -",
  "  office, report date, official source URL, issue type and description. Stored privately.",
  "- **Feedback form:** https://irishvisaupdatetracker.pages.dev/contact#feedback - best for a",
  "  feature request or a general note. It is stored in the site's D1 database.",
  "- **Timeline form:** https://irishvisaupdatetracker.pages.dev/contact#share-timeline - share",
  "  applied and decided dates for an embassy visa application.",
  "- **Correction ledger:** https://irishvisaupdatetracker.pages.dev/corrections - public,",
  "  source-linked differences between consecutive official files.",
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
  "Email is processed by Gmail. Feedback-form submissions are stored in D1 and are not",
  "published. Timeline submissions are published in the public community data after the nightly",
  "sync. Full details: https://irishvisaupdatetracker.pages.dev/privacy",
  ""
);

export const PRIVACY_MARKDOWN = lines(
  "# Privacy notice - Irish Visa Decision Tracker",
  "",
  `**Last updated:** ${CONTENT_DATES["/privacy"] || "Not recorded"}`,
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
  "**Feedback** (`suggestions`) stores the name and free text entered. It is used to improve",
  "the tracker, is not published, and is not served by the public submissions endpoint.",
  "",
  "**Data error reports** (`corrections`) store a name, office, report date, official source URL,",
  "issue type, optional application number and description. They are private review inputs and are",
  "not published. The public `/corrections` page lists file-level additions, removals and changed",
  "outcomes with a source link; it does not expose the submitted report text.",
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

const DAILY_SUMMARIES_MARKDOWN = lines(
  "# Daily visa decision summaries",
  "",
  "Approved and refused counts for each day the Embassy of Ireland in New Delhi has published",
  "visa decisions, drawn from the tracker's running record of those decisions.",
  "",
  "- **Data freshness:** read `/data/visa_meta.json` for the current `lastRunAt` - this text describes the page, it is not a dated snapshot",
  "- **Decisions on record:** read `/data/visa_meta.json` for the current `sheetRows`; this page",
  "  describes the views rather than repeating a count that changes",
  "- **Source data:** `/data/visa_decisions.json`, rows shaped `[date, application number, decision]`",
  "- **Unofficial:** not affiliated with the Embassy of Ireland, ISD or DETE, and not immigration",
  "  advice",
  "",
  "## How to read the counts",
  "",
  "- **Approved** / **Refused** - the outcome the embassy published for that application number.",
  "- **Official file day** - the report date printed on the office's file; not necessarily the",
  "  date the decision was made on a case.",
  "- **Tracker-observed day** - the date the tracker first recorded a row. The newest observed",
  "  day can be partial and may not yet be in the official file.",
  "- **Decision date** - the date attached to an individual application, which can differ from",
  "  the report date for weekly files.",
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
  "every tracker-observed day in one record is what makes those comparisons possible.",
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

const STAMP_1G_MARKDOWN = lines(
  "# Stamp 1G processing dates - Ireland",
  "",
  "The Stamp 1G application date that ISD (Immigration Service Delivery) is currently processing,",
  "the lag in days and weeks, and how that lag has moved. The observations are in",
  "`/data/stamp_1g.json`.",
  "",
  "- **Data freshness:** read `/data/visa_meta.json` for the current `lastRunAt` - this text describes the page, it is not a dated snapshot",
  "- **Latest observation (category 1G):** ISD processing applications received on",
  "  25 September 2026, a lag of 56 days, observed on 20 November 2026 - read",
  "  `/data/stamp_1g.json` for the current values",
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

const EMPLOYMENT_PERMITS_MARKDOWN = lines(
  "# Employment permit processing dates - Ireland",
  "",
  "The processing date reached in each employment-permit category published by DETE",
  "(Department of Enterprise, Tourism and Employment), with the lag in days and weeks. The",
  "observations are in `/data/work_permits.json`.",
  "",
  "- **Data freshness:** read `/data/visa_meta.json` for the current `lastRunAt` - this text describes the page, it is not a dated snapshot",
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

const PROCESSING_TIMES_MARKDOWN = lines(
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

function officeMarkdown({ title, route, latest, decisions, approved, refused, countries, source, data, note, extra }) {
  return lines(
    `# ${title}`,
    "",
    "An independent, unofficial page in the Irish Visa Decision Tracker. It records what the",
    "office has already published; it is not immigration advice and cannot see a private case.",
    "",
    `- **Canonical HTML:** https://irishvisaupdatetracker.pages.dev${route}`,
    `- **Latest official file:** ${latest}`,
    `- **Decisions in that file:** ${decisions} (${approved} approved, ${refused} refused)`,
    `- **Countries / scope:** ${countries}`,
    `- **Official source:** ${source}`,
    `- **Machine-readable data:** https://irishvisaupdatetracker.pages.dev${data}`,
    "",
    "## Read the counts correctly",
    "",
    note,
    ...(extra && extra.length ? ["", ...extra] : []),
    "",
    "A missing application number is not a refusal. It may be unpublished, handled by another",
    "office, absent from a snapshot, or misread by OCR where the office publishes scanned files.",
    "Confirm every row against the official source before relying on it.",
    "",
    "## Related pages",
    "",
    "- [Tracker](https://irishvisaupdatetracker.pages.dev/) - search an application number.",
    "- [All six offices](https://irishvisaupdatetracker.pages.dev/about#method) - method, coverage and limits.",
    "- [Data status](https://irishvisaupdatetracker.pages.dev/status) - freshness and known gaps.",
    "- [Report archive](https://irishvisaupdatetracker.pages.dev/reports) - dated source-linked reports.",
    "- [Open data](https://irishvisaupdatetracker.pages.dev/data) - JSON files and definitions.",
    "",
  );
}

const NEW_DELHI_MARKDOWN = officeMarkdown({
  title: "New Delhi visa decisions for India, Bangladesh, Nepal and Sri Lanka",
  route: "/new-delhi-visa-decisions",
  latest: "19 November 2026",
  decisions: "43,599",
  approved: "36,769",
  refused: "6,830",
  countries: "India, Bangladesh, Nepal and Sri Lanka",
  source: "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/",
  data: "/data/visa_decisions.json",
  note: "New Delhi publishes a cumulative file each business morning. The count is the total in that file, not the number added that day. Read `/data/visa_meta.json` for the current `fileDate`, `sheetRows` and `lastRunAt`. The tracker’s dated rows are observation-dated, so they are excluded from official dated monthly totals.",
});

const BEIJING_MARKDOWN = officeMarkdown({
  title: "Beijing visa decisions for China, Hong Kong, Macau and Mongolia",
  route: "/beijing-visa-decisions",
  latest: "1 November 2026",
  decisions: "13,724",
  approved: "11,373",
  refused: "2,351",
  countries: "China, Hong Kong, Macau and Mongolia",
  source: "https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/",
  data: "/data/embassy-beijing.json",
  note: "Beijing publishes a cumulative decision file rather than a dated daily history. The tracker holds the latest snapshot it could find; a newer official file may exist. Read `/data/data_manifest.json` before describing this snapshot as current.",
});

export const ABU_DHABI_MARKDOWN = officeMarkdown({
  title: "Abu Dhabi visa decisions for the UAE, Gulf and North Africa",
  route: "/abu-dhabi-visa-decisions",
  latest: "20 November 2026 (week ending)",
  decisions: "232",
  approved: "161",
  refused: "71",
  countries: "United Arab Emirates, Afghanistan, Algeria, Bahrain, Jordan, Kuwait, Lebanon, Libya, Morocco, Oman, Qatar, Sudan, Syria and Tunisia",
  source: "https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/",
  data: "/data/embassy-abu-dhabi.json",
  note: "Abu Dhabi publishes weekly PDF reports. The report date is the end of the reporting period, not the date of an individual decision. The tracker keeps each dated report it has ingested; read the report archive for earlier periods. Abu Dhabi's published country list does not include Pakistan; join-family applications from residents of Pakistan are considered by the [Dublin Visa Office](https://irishvisaupdatetracker.pages.dev/dublin-visa-decisions).",
});

export const ABUJA_MARKDOWN = officeMarkdown({
  title: "Abuja visa decisions for Nigeria, Ghana, Côte d’Ivoire and Senegal",
  route: "/abuja-visa-decisions",
  latest: "7 November 2026 (week ending)",
  decisions: "99",
  approved: "34",
  refused: "65",
  countries: "Nigeria, Côte d’Ivoire, Ghana and Senegal",
  source: "https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/",
  data: "/data/embassy-abuja.json",
  note: "Abuja publishes weekly PDF reports. The report date is the end of the reporting period, not the date of an individual decision. A number may appear in an earlier or later report, so search the office history before treating a missing row as unpublished.",
});

const ANKARA_MARKDOWN = officeMarkdown({
  title: "Ankara visa decisions for Türkiye, Azerbaijan and Saudi residents",
  route: "/ankara-visa-decisions",
  latest: "15 November 2026 (week ending)",
  decisions: "165",
  approved: "128",
  refused: "37",
  countries: "Türkiye, Azerbaijan and visa-required nationals resident in Saudi Arabia",
  source: "https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/",
  data: "/data/embassy-ankara.json",
  note: "Ankara publishes weekly PDF reports; some are scanned. Rows are OCR-extracted at 300 DPI, so a character can be missed or misread. The official PDF remains the authority. The report date is the end of the reporting period.",
});

const DUBLIN_MARKDOWN = officeMarkdown({
  title: "Dublin visa decisions for Pakistan and transferred applications",
  route: "/dublin-visa-decisions",
  latest: "20 November 2026",
  decisions: "4,475",
  approved: "2,624",
  refused: "1,851",
  countries: "Join-family applications from Pakistan, applications transferred from overseas offices and specified categories, including EU Free Movement family, certain Join Family categories, Minister of Religion and Volunteer",
  source: "https://www.irishimmigration.ie/visa-decisions/",
  data: "/data/embassy-dublin.json",
  note: "The Dublin Visa Office publishes decisions every Tuesday and a separate processing queue by category. The tracker holds the latest decision snapshot; the queue is shown on the processing-times page and is not an individual decision list.",
});

// The static documents above are a fallback for a deployment whose assets are
// unavailable. The served Markdown is built from data/data_manifest.json, so a
// reader never sees last week's count on a page whose HTML shows this week's.
const OFFICE_MARKDOWN_META = {
  "new-delhi": {
    title: "New Delhi visa decisions for India, Bangladesh, Nepal and Sri Lanka",
    route: "/new-delhi-visa-decisions",
    countries: "India, Bangladesh, Nepal and Sri Lanka",
    source: "https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/",
    data: "/data/visa_decisions.json",
    note: "New Delhi publishes a cumulative file each business morning. The count is the total in that file, not the number added that day. Read `/data/visa_meta.json` for the current `fileDate`, `sheetRows` and `lastRunAt`. The tracker’s dated rows are observation-dated, so they are excluded from official dated monthly totals.",
    fallback: NEW_DELHI_MARKDOWN,
  },
  beijing: {
    title: "Beijing visa decisions for China, Hong Kong, Macau and Mongolia",
    route: "/beijing-visa-decisions",
    countries: "China, Hong Kong, Macau and Mongolia",
    source: "https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/",
    data: "/data/embassy-beijing.json",
    note: "Beijing publishes a cumulative decision file rather than a dated daily history. The tracker holds the latest snapshot it could find; a newer official file may exist. Read `/data/data_manifest.json` before describing this snapshot as current.",
    fallback: BEIJING_MARKDOWN,
  },
  "abu-dhabi": {
    title: "Abu Dhabi visa decisions for the UAE, Gulf and North Africa",
    route: "/abu-dhabi-visa-decisions",
    countries: "United Arab Emirates, Afghanistan, Algeria, Bahrain, Jordan, Kuwait, Lebanon, Libya, Morocco, Oman, Qatar, Sudan, Syria and Tunisia",
    source: "https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/",
    data: "/data/embassy-abu-dhabi.json",
    note: "Abu Dhabi publishes weekly PDF reports. The report date is the end of the reporting period, not the date of an individual decision. The tracker keeps each dated report it has ingested; read the report archive for earlier periods. Abu Dhabi's published country list does not include Pakistan; join-family applications from residents of Pakistan are considered by the [Dublin Visa Office](https://irishvisaupdatetracker.pages.dev/dublin-visa-decisions).",
    fallback: ABU_DHABI_MARKDOWN,
    weekly: true,
  },
  abuja: {
    title: "Abuja visa decisions for Nigeria, Ghana, Côte d’Ivoire and Senegal",
    route: "/abuja-visa-decisions",
    countries: "Nigeria, Ghana, Côte d’Ivoire, Senegal",
    source: "https://www.ireland.ie/en/nigeria/abuja/services/visas/visa-decisions/",
    data: "/data/embassy-abuja.json",
    note: "Abuja publishes weekly PDF reports. The report date is the end of the reporting period, and the decisions are period totals, not a cumulative file. Some rows are OCR-extracted, so a character can be missed or misread; the official PDF remains the authority.",
    fallback: ABUJA_MARKDOWN,
    weekly: true,
  },
  ankara: {
    title: "Ankara visa decisions for Türkiye, Azerbaijan and Saudi residents",
    route: "/ankara-visa-decisions",
    countries: "Türkiye, Azerbaijan and residents of Saudi Arabia",
    source: "https://www.ireland.ie/en/turkiye/ankara/services/visas/visa-decisions/",
    data: "/data/embassy-ankara.json",
    note: "Ankara publishes weekly PDF reports; some are scanned. Rows are OCR-extracted at 300 DPI, so a character can be missed or misread. The official PDF remains the authority. The report date is the end of the reporting period.",
    fallback: ANKARA_MARKDOWN,
    weekly: true,
  },
  dublin: {
    title: "Dublin visa decisions for Pakistan and transferred applications",
    route: "/dublin-visa-decisions",
    countries: "Join-family applications from Pakistan, applications transferred from overseas offices and specified categories, including EU Free Movement family, certain Join Family categories, Minister of Religion and Volunteer",
    source: "https://www.irishimmigration.ie/visa-decisions/",
    data: "/data/embassy-dublin.json",
    note: "The Dublin Visa Office publishes decisions every Tuesday and a separate processing queue by category. The tracker holds the latest decision snapshot; the queue is shown on the processing-times page and is not an individual decision list.",
    fallback: DUBLIN_MARKDOWN,
  },
};

/** Both the canonical route and its .md alias, mapped to the office slug. */
export const OFFICE_MARKDOWN_PATHS = new Map();
for (const [slug, meta] of Object.entries(OFFICE_MARKDOWN_META)) {
  OFFICE_MARKDOWN_PATHS.set(meta.route, slug);
  OFFICE_MARKDOWN_PATHS.set(`${meta.route}.md`, slug);
}

function formatLongDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!match) return "";
  const months = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1]} ${match[1]}`;
}

async function readJsonAsset(env, request, pathname) {
  try {
    const base = request && request.url ? request.url : "https://irishvisaupdatetracker.pages.dev/";
    const response = await env.ASSETS.fetch(new Request(new URL(pathname, base).toString()));
    if (!response || !response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Office Markdown computed from the current manifest, not frozen constants. */
export async function liveOfficeMarkdown(env, slug, request, origin) {
  const meta = OFFICE_MARKDOWN_META[slug];
  if (!meta) return "";
  const manifest = await readJsonAsset(env, request, "/data/data_manifest.json");
  const office = manifest && Array.isArray(manifest.offices)
    ? manifest.offices.find((item) => item && item.slug === slug)
    : null;
  if (!office || !office.report_date) return meta.fallback;
  const freshness = await readJsonAsset(env, request, "/data/freshness.json");
  const fresh = freshness && Array.isArray(freshness.offices)
    ? freshness.offices.find((item) => item && item.slug === slug) || {}
    : {};
  const through = String(fresh.search_through || "").slice(0, 10);
  const from = String(fresh.search_from || "").slice(0, 10);
  const window = from
    ? `${formatLongDate(from)}${through && through !== from ? ` to ${formatLongDate(through)}` : ""}` +
      (fresh.search_scope ? ` (${fresh.search_scope})` : "")
    : "the latest published file only";
  return officeMarkdown({
    title: meta.title,
    route: meta.route,
    latest: `${formatLongDate(office.report_date)}${meta.weekly ? " (week ending)" : ""}`,
    decisions: (Number(office.decisions) || 0).toLocaleString("en-IE"),
    approved: (Number(office.approved) || 0).toLocaleString("en-IE"),
    refused: (Number(office.refused) || 0).toLocaleString("en-IE"),
    countries: meta.countries,
    source: meta.source,
    data: meta.data,
    note: meta.note,
    extra: [`- **Searchable in this tracker:** ${window}`],
  });
}

const HELP_MARKDOWN = lines(
  "# How to check an Irish visa application",
  "",
  "The Irish Visa Decision Tracker searches the decision files the six Irish visa offices",
  "publish. It is independent and unofficial, and it cannot see an application that has not",
  "been published.",
  "",
  "- **Canonical HTML:** https://irishvisaupdatetracker.pages.dev/help",
  "- **Search:** https://irishvisaupdatetracker.pages.dev/?tracker=visa&tab=search",
  "- **Data status:** https://irishvisaupdatetracker.pages.dev/status",
  "",
  "## Find the application number",
  "",
  "Use the application number on the receipt, acknowledgement email or decision email. It is",
  "usually eight digits; an IRL prefix, spaces and dashes are optional. Do not use a VFS",
  "reference, passport number, payment reference or courier tracking number.",
  "",
  "## What a result means",
  "",
  "- **Approved** means the published file records an approval. It is not the visa itself and",
  "  does not say when a passport will be returned.",
  "- **Refused** means the published file records a refusal. The file gives no reason; the",
  "  decision letter does, with any review or appeal deadline.",
  "- **Tracker observation** rows are dated when the tracker read them, not necessarily the",
  "  official decision date. The office file remains the authority.",
  "",
  "## When the number is not listed",
  "",
  "A missing number is not a refusal. It may be unpublished, handled by another office,",
  "absent from a snapshot, or misread by OCR where the office publishes scanned files.",
  "Check `/status` for each office's searchable window before concluding anything, and search",
  "all six offices.",
  "",
  "## Alerts",
  "",
  "Telegram and browser push can send one message when a watched number appears in a later",
  "published file. There are no accounts; subscriptions are anonymous. A Telegram `/office`",
  "subscription sends one message when an office publishes a new file, even when the reader's",
  "own number is not in it.",
  "",
  "## Official sources",
  "",
  "- ISD visa decisions: https://www.irishimmigration.ie/visa-decisions/",
  "- ISD visa offices: https://www.irishimmigration.ie/visa-offices/",
  "- Each office page links its own official source and latest file.",
  "",
  "## Related pages",
  "",
  "- [Find my office](https://irishvisaupdatetracker.pages.dev/find-my-office)",
  "- [After approval](https://irishvisaupdatetracker.pages.dev/after-approval)",
  "- [After refusal](https://irishvisaupdatetracker.pages.dev/after-refusal)",
  "- [Missing decision](https://irishvisaupdatetracker.pages.dev/missing-decision)",
  "- [Data status](https://irishvisaupdatetracker.pages.dev/status)",
  "",
);

/** /status and /status.md are served from the live manifest, not a constant. */
export const STATUS_MARKDOWN_PATHS = new Set(["/status", "/status.md"]);

export async function liveStatusMarkdown(env, request, origin) {
  const manifest = await readJsonAsset(env, request, "/data/data_manifest.json");
  const freshness = await readJsonAsset(env, request, "/data/freshness.json");
  const offices = manifest && Array.isArray(manifest.offices) ? manifest.offices : [];
  if (!offices.length) {
    return lines(
      "# Irish visa decision data status",
      "",
      "The current manifest could not be read. The machine-readable source is",
      "`/data/data_manifest.json`.",
      "",
    );
  }
  const freshBySlug = new Map();
  for (const office of (freshness && freshness.offices) || []) {
    if (office && office.slug) freshBySlug.set(office.slug, office);
  }
  const rows = offices.map((office) => {
    const fresh = freshBySlug.get(office.slug) || {};
    const counts = `${(Number(office.decisions) || 0).toLocaleString("en-IE")} decisions` +
      ` (${(Number(office.approved) || 0).toLocaleString("en-IE")} approved, ` +
      `${(Number(office.refused) || 0).toLocaleString("en-IE")} refused)`;
    const window = fresh.search_from
      ? `${formatLongDate(fresh.search_from)}` +
        (fresh.search_through && fresh.search_through !== fresh.search_from
          ? ` to ${formatLongDate(fresh.search_through)}` : "") +
        (fresh.search_scope ? ` (${fresh.search_scope})` : "")
      : "latest file only";
    // The introduction promises the last read time, so each row carries it;
    // an office in a warning state also says so instead of always reading
    // "status official".
    const checked = fresh.last_success_at
      ? ` \u00b7 checked ${formatLongDate(fresh.last_success_at)}`
      : "";
    const warning = fresh.attention || fresh.status === "error"
      ? ` \u00b7 warning: ${fresh.warning || fresh.status_label || "data needs attention"}`
      : "";
    const page = `https://irishvisaupdatetracker.pages.dev/${office.slug}-visa-decisions`;
    return `- **[${office.name || office.slug}](${page})** \u2014 latest official report ${formatLongDate(office.report_date)}` +
      ` \u00b7 ${counts} \u00b7 status ${office.status || "official"}${checked}` +
      ` \u00b7 a search matches ${window}${warning}`;
  });
  return lines(
    "# Irish visa decision data status",
    "",
    "What each of the six offices has published, when the tracker last read it, and the window",
    "a search can actually match. Read the JSON below for exact timestamps.",
    "",
    manifest.generated_at
      ? `Manifest generated ${formatLongDate(manifest.generated_at)}.`
      : "",
    "",
    ...rows,
    "",
    "## How to read these figures",
    "",
    "Counts are the published rows in each office's newest file, not applications received.",
    "A snapshot office (Beijing, Dublin) has no dated history beyond the snapshot it holds; a",
    "dated office keeps each report it has ingested. A missing application number is not a",
    "refusal.",
    "",
    "## Machine-readable",
    "",
    "- `/data/data_manifest.json` \u2014 report dates, counts and source links.",
    "- `/data/freshness.json` \u2014 status plus `search_from`, `search_through`, `search_scope`.",
    "- `/data/reports/index.json` \u2014 the dated report archive.",
    "- `/data/search_index.json` \u2014 the compact lookup index; `/api/search` serves it.",
    "",
    "## Related pages",
    "",
    "- [Tracker](https://irishvisaupdatetracker.pages.dev/) \u2014 search an application number.",
    "- [Reports](https://irishvisaupdatetracker.pages.dev/reports) \u2014 every report with its source.",
    "- [Open data](https://irishvisaupdatetracker.pages.dev/data) \u2014 JSON and CSV files.",
    "",
  );
}

const OPEN_DATA_MARKDOWN = lines(
  "# Irish visa decision open data",
  "",
  "The tracker publishes the public JSON and CSV files behind its pages. Read",
  "`/data/visa_meta.json` for freshness and `/data/data_manifest.json` for coverage.",
  "",
  "- **Canonical HTML:** https://irishvisaupdatetracker.pages.dev/data",
  "- **New Delhi rows:** `/data/visa_decisions.json` - `[date, application number, \"Approved\" | \"Refused\"]`",
  "- **Office snapshots:** `/data/embassy-<office>.json` for new-delhi, beijing, abu-dhabi, abuja, ankara and dublin",
  "- **Coverage:** `/data/data_manifest.json`",
  "- **Report archive:** `/data/reports/index.json`",
  "- **Freshness and search window:** `/data/freshness.json` gives each office's report date and the earliest and latest date a search can match.",
  "- **Search index:** `/data/search_index.json` is the trimmed index behind `/api/search`; `/data/search_fallback.json` is the browser fallback.",
  "- **Study tables:** `/data/study/office-summary.csv`, `/data/study/monthly-volume.csv` and `/data/study/new-delhi-file-growth.csv`",
  "- **Feeds:** `/official-file-feed.json` and `/feed.xml`",
  "",
  "Underlying decisions remain the publications of the Irish embassies and the Immigration",
  "Service Delivery. The tracker’s compilation, charts and tables may be reused with",
  "attribution and a link to `/data`. The source code is MIT licensed. Not immigration advice.",
  "",
);

export const DOCUMENTS = new Map([
  ["/", { markdown: HOME_MARKDOWN, alternate: "/index.md", file: "/index.html", sharedCache: true }],
  ["/about", { markdown: ABOUT_MARKDOWN, alternate: "/about.md", file: "/about.html" }],
  ["/help", { markdown: HELP_MARKDOWN, alternate: "/help.md", file: "/help.html" }],
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
  ["/new-delhi-visa-decisions", { markdown: NEW_DELHI_MARKDOWN, alternate: "/new-delhi-visa-decisions.md", file: "/new-delhi-visa-decisions.html" }],
  ["/beijing-visa-decisions", { markdown: BEIJING_MARKDOWN, alternate: "/beijing-visa-decisions.md", file: "/beijing-visa-decisions.html" }],
  ["/abu-dhabi-visa-decisions", { markdown: ABU_DHABI_MARKDOWN, alternate: "/abu-dhabi-visa-decisions.md", file: "/abu-dhabi-visa-decisions.html" }],
  ["/abuja-visa-decisions", { markdown: ABUJA_MARKDOWN, alternate: "/abuja-visa-decisions.md", file: "/abuja-visa-decisions.html" }],
  ["/ankara-visa-decisions", { markdown: ANKARA_MARKDOWN, alternate: "/ankara-visa-decisions.md", file: "/ankara-visa-decisions.html" }],
  ["/dublin-visa-decisions", { markdown: DUBLIN_MARKDOWN, alternate: "/dublin-visa-decisions.md", file: "/dublin-visa-decisions.html" }],
  ["/data", { markdown: OPEN_DATA_MARKDOWN, alternate: "/data.md", file: "/data.html" }],
]);

export const MARKDOWN_ALIASES = new Map([
  ["/index.md", HOME_MARKDOWN],
  ["/about.md", ABOUT_MARKDOWN],
  ["/help.md", HELP_MARKDOWN],
  ["/contact.md", CONTACT_MARKDOWN],
  ["/privacy.md", PRIVACY_MARKDOWN],
  ["/daily-summaries.md", DAILY_SUMMARIES_MARKDOWN],
  ["/stamp-1g-processing-dates.md", STAMP_1G_MARKDOWN],
  ["/employment-permit-processing-dates.md", EMPLOYMENT_PERMITS_MARKDOWN],
  ["/visa-processing-times.md", PROCESSING_TIMES_MARKDOWN],
  ["/new-delhi-visa-decisions.md", NEW_DELHI_MARKDOWN],
  ["/beijing-visa-decisions.md", BEIJING_MARKDOWN],
  ["/abu-dhabi-visa-decisions.md", ABU_DHABI_MARKDOWN],
  ["/abuja-visa-decisions.md", ABUJA_MARKDOWN],
  ["/ankara-visa-decisions.md", ANKARA_MARKDOWN],
  ["/dublin-visa-decisions.md", DUBLIN_MARKDOWN],
  ["/data.md", OPEN_DATA_MARKDOWN],
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

export function markdownResponse(body, status = 200, method = "GET", origin = "") {
  const publicOrigin = String(origin || "").replace(/\/+$/, "");
  const text = publicOrigin
    ? String(body).split("https://irishvisaupdatetracker.pages.dev").join(publicOrigin)
    : body;
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  return new Response(method === "HEAD" ? null : text, { status, headers });
}
