# Earning links without spamming

The site has more crawlable pages than it has external reasons to crawl them.
Sitemaps and IndexNow tell engines what exists; a link tells them someone else
vouches for it. This file is the repeatable, low-volume version of that work.

## 1. Reclaim mentions first (cheapest, highest conversion)

`tools/link-reclamation.mjs` checks pages that already name the project but may
not link it.

Baseline, 25 November 2026: Bing Webmaster Tools reported **no known inbound
links**. Reclamation therefore has nothing to fix yet; the list below stays
empty until a mention is found, and the work in sections 2–4 is what creates
the first mentions worth reclaiming.

```bash
# 1. Find candidates: search for the exact name, the study title and the host.
#    Add only pages you have opened and seen mention the project.
#    Example searches: "Irish Visa Decision Tracker", "Irish Visa Update Tracker",
#    "irishvisaupdatetracker.pages.dev", "published visa decisions by office"

# 2. Record them in data/link-reclamation.json
#    { "candidates": ["https://example.org/article"] }

npm run audit:links
npm run audit:links -- --out=link-report.json
```

Statuses:

- `linked` — nothing to do.
- `unlinked` — the page names the project without a link. This is the only
  status worth an email, and the email is short: quote the sentence, give the
  exact URL, offer a correction if the figure is wrong.
- `unreachable` — never treat as a missing link; retry later.
- `none` — the candidate list is wrong or the page changed. Remove it.

Candidates are added by hand on purpose. The tool cannot find mentions itself,
and a scraped list of unrelated pages would produce exactly the mass mailing
that damages a project like this.

## 2. Editorial links, one finding at a time

The office pages now carry an analysis section (publication cadence, approval
share across the archived series, largest and smallest file, and what the file
cannot tell you). Lead with one sentence from it:

> New Delhi's cumulative file grew by N decisions between 20 and 23 November,
> while Beijing's only published snapshot is dated 1 November.

Targets, in order of fit:

1. University international offices and student unions with Ireland pages.
2. Immigration solicitors and advisers who already publish processing-time
   guides and need a source for decision volume.
3. Student newspapers and data-journalism classes covering Irish study visas.
4. Migration researchers who need a citable record of published decision files.

Rules that keep it honest:

- One email per recipient, and only where the page already covers Irish visas
  or immigration data.
- Never describe the tracker as official, and never offer a prediction for an
  individual application.
- Offer the badge (`/embed`) or a chart, not a "please link to us" request.
- If a page already links the site, do not ask again.

## 3. Monthly story package

`/monthly-report` carries a package for the current month: a headline finding, a
publication-ready paragraph, the method note, the pitch text and the CSV links.
One pitch per month to a small list is enough; sending the same package weekly
turns a data source into noise.

The package is rebuilt from the latest official files, so quote it from the page
rather than from an old email. The monthly permalink
(`/monthly-report/YYYY-MM`) is the stable URL once the month closes.

## 4. Partner with a class or student newsroom

Offer the dataset, the method note and a named contact. Ask for a source
citation, not copy approval. A published student analysis is a relevant link
and a third-party description of the data in one step.

## 5. What not to do

- No paid links, link networks or reciprocal-link schemes.
- No comment spam, forum drop-links or unsolicited bulk email.
- No "SEO guest post" offers that require a keyword-stuffed article.
- No claim that a link was earned until it is live and checked.

## Measure

Track only what the tools can see:

- `npm run audit:discovery` — sitemap families, report permalinks, date pages.
- Search Console / Bing — per-family indexed counts (the split sitemaps make
  this readable).
- `npm run audit:links` — linked vs unlinked mentions over time.

Referral traffic and brand-search volume are the outcomes; a link count is not.
