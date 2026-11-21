# Monthly Search Console feedback loop

The verification tag is already in the site. This is a monthly content review,
not an indexing campaign.

## Once a month

1. **Performance → Search results → Export.**
   - Date range: the last 28 days (or the last 3 months for a quarterly view).
   - Tabs: Queries, Pages. Export each as CSV.
2. **Run the review helper.**
   ```bash
   node tools/search-console-review.mjs --file queries.csv
   node tools/search-console-review.mjs --file queries.csv --json > review.json
   ```
   It surfaces high-impression/low-CTR queries, striking-distance queries
   (positions 5–20) and country/office terms.
3. **Compare the query wording with the page.**
   - Does the title, H1 and first paragraph answer the query in the same words?
   - Is the page the right office/country page, or should it link to one?
   - Is the page's snippet being rewritten because the description is vague?
   - For a report-date query, does a dated `/reports/...` page exist?
4. **Check Pages → Indexing.**
   - Confirm the six office pages are indexed.
   - Look for 404s, soft 404s and “Crawled – currently not indexed”.
   - A page that is not indexed yet does not need a mass indexing request.
5. **Make one meaningful change per page.** Update copy, a title, an internal
   link or a missing dated report. Rebuild, run the link and accessibility
   checks, then deploy.
6. **Only after the change**, use URL Inspection for that URL and request
   indexing if it is appropriate. Do not use URL Inspection as a batch tool,
   and do not request indexing for pages you did not change.

## What not to do

- Do not mass-request indexing or submit the same URL repeatedly.
- Do not create city doorway pages for country queries. Extend the existing
  office page, which already carries the country scope.
- Do not change a title only to chase a query if the page does not answer it.
- Do not treat impressions as demand for a new page; check whether the
  existing page is simply unclear.

## Bing and IndexNow

Google ignores IndexNow; Bing, Copilot and Yandex use it. The deploy workflow
runs `tools/indexnow.mjs` after a successful build, using the public key file
`5ba7cee4d0b7816bb7950443892c3b7d.txt`. It submits only the changes in the
latest data set (home, status, reports, monthly report, open data and the six
office pages). Dry-run it locally first:

```bash
node tools/indexnow.mjs --dry-run
```

Submitting a sitemap to Bing Webmaster Tools and verifying the property need
the maintainer's Microsoft account; this repository cannot do either. Once
verified, submit `https://irishvisaupdatetracker.pages.dev/sitemap.xml` (or the
custom-domain equivalent) once and let IndexNow announce later changes. Never
run the live IndexNow command without a deploy authorisation.

## Record the result

Keep a short note per month: query, page, change made, date deployed, and the
next month's clicks/CTR. The repository's `data-study` and `press` pages are
the durable assets; Search Console tells you which of them need clearer copy.
