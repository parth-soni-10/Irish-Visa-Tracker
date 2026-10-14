# Irish Visa Decision Tracker — Project Instructions

## Overview
Tracks daily visa decisions published by the Embassy of Ireland in New Delhi. A GitHub Actions Python scraper fetches the embassy's `.ods` file and upserts rows into `data/visa_decisions.json` (+ `data/visa_meta.json` health object), committing them back to the repo; the dashboard (embassy-decisions tracker plus Stamp 1G, employment-permit trackers and community timelines) reads those files as one SPA. The only optional repo secret is `ALERT_WEBHOOK_URL` (gap-alert webhook); everything else runs unattended. (The old Google Sheet / Apps Script layer was removed; see git history for `Code.gs`.)

### Where the data on the page comes from
`data/*.json` is written by the GitHub Actions jobs, never by hand. The Worker
serves those five files from the repository (short edge cache, bundled asset as
fallback — see the data-proxy block in `worker.js`), so a pipeline commit shows
up on the live site within ~5 minutes with no redeploy. A deploy freezes only
the *fallback* copy; it is not how the dashboard gets its data.

### Scheduled runs
GitHub's scheduled runs on this repo are low priority and routinely land 6-9
hours late (or not at all) — 2026-10-05..10-12 for the 03:00 UTC jobs, and
2026-10-13's Stamp 1G run never fired. `track_1g.yml` / `track_permits.yml`
therefore carry several off-the-hour attempts per day (only the first writes a
row; the rest are no-ops) and their commit steps retry the push on top of a
rebase, because the scrape workflow commits every ~30 minutes and a rejected
push would otherwise drop that day's observation for good.

## Tech Stack
- Frontend: `index.html` — one self-contained file (inline CSS + inline SPA render). Geist fonts self-hosted in `fonts/`.
- Icons: Lucide via vendored `lucide.min.js`. Wired with a `MutationObserver` that re-runs `lucide.createIcons()` after any render.
- Backend/API: none — static JSON in `data/` (`visa_decisions.json` rows as `[date, irl, decision]` arrays, `visa_meta.json` run-status object).
- Scraper: `scraper.py` (Python: requests, pandas, odfpy, python-dateutil) run by GitHub Actions cron.
- Hosting: **Cloudflare Pages, one host** — `irishvisaupdatetracker.pages.dev`. The build bundles `worker.js` into the deployment's `_worker.js`, which handles the three forms (POSTs land in D1, binding `DB`), serves the timeline rows back at `GET /api/community-submissions` for the nightly sync, and proxies `data/*.json` from the repo; everything else comes from the static assets staged from the repository root, with response headers in `_headers` (the only copy — the old `netlify.toml` is deleted, since Cloudflare ignored it).

## Files
```
index.html          → the whole SPA (chrome, nav pills, hero, tabs, suggestion form)
scraper.py          → daily visa-file scraper (weekend / holiday handling, JSON persistence, gap alert)
track_1g.py         → Stamp 1G processing-date tracker
track_permits.py    → employment-permit processing-date tracker
sync_timelines.py   → nightly merge of the Worker's timeline submissions → data/community_timelines.json
                      (reads GET /api/community-submissions on the site itself: no secret, nothing to set up)
test_scraper.py, test_track_1g.py, test_permits.py, test_timelines.py → pytest suites (CI runs all four)
tools/              → make-icons.py, check_html_scripts.py (inline-script syntax check used by CI)
.github/workflows/  → scrape, test, timelines, track_1g, track_permits
data/               → visa_decisions.json, visa_meta.json (scraper-owned), stamp_1g.json,
                      work_permits.json, community_timelines.json
requirements.txt
worker.js           → Cloudflare Worker: form POSTs → D1, /api/community-submissions (timeline rows) for the
                      nightly sync, data/ proxied from the repo, else static assets
wrangler.toml       → bundle input for the Pages build only (name, main, compatibility date)
wrangler.dev.toml   → local `wrangler dev` only (assets = repo root, D1 binding `DB`)
pages/wrangler.toml → the deploy: project name and the D1 binding it runs on
schema.sql          → reference copy of the `submissions` table worker.js creates lazily
_headers            → response headers (the assets layer reads this; the only copy, netlify.toml being deleted)
.assetsignore       → what must never be published (scripts, docs, config, caches)
```

## Code Style / Conventions
- SPA is JS-rendered into `#visa-dash`: nav pills, hero, and stat-card labels are template strings inside functions like `render()`, `renderHomeLayout()`, `renderDailySummary()`, `renderPastLayout()`.
- Icons: add `<i data-lucide="name"></i>` in static markup or render templates — the MutationObserver converts them to inline SVGs automatically (no manual createIcons calls). Size via the `.navpill .lucide` / `.card .label .lucide` rules.
- Color is intentional: green/red/amber are reserved for decision states; only `--green` is used for decoration. Keep that split.
- The dashboard must render gracefully with no data ("Awaiting data…") — don't assume rows exist.

## Testing
- Python: `pytest` — runs all four `test_*.py` suites; the Tests workflow runs them on every push (pushes touching only `data/**` are skipped).
- Frontend: serve the folder (geist fonts + lucide are local) and exercise all tabs; `python tools/check_html_scripts.py` syntax-checks every inline script block (`node --check`) — CI runs it on every push too.

## Build & Run
- Scraper: `pip install -r requirements.txt`; runs in GitHub Actions (no required secrets — `ALERT_WEBHOOK_URL` is optional for the gap-alert webhook); commits `data/*.json` back itself.
- Deploy: a push to `main` deploys it — the repo is connected to the **Cloudflare Pages** project `irishvisaupdatetracker` (production branch `main`, preview builds off). Its build command bundles `worker.js` and stages the repository root through `.assetsignore` as the upload, with the D1 binding coming from the project. A `data/*` commit therefore republishes the site, which is what keeps `data/` current: the deployment serves those files from its own upload. Nothing is deployed from a shell, and local testing is `npx wrangler dev --config wrangler.dev.toml`.