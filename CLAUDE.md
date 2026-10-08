# Irish Visa Decision Tracker — Project Instructions

## Overview
Tracks daily visa decisions published by the Embassy of Ireland in New Delhi. A GitHub Actions Python scraper fetches the embassy's `.ods` file and upserts rows into `data/visa_decisions.json` (+ `data/visa_meta.json` health object), committing them back to the repo; the Netlify dashboard (embassy-decisions tracker plus Stamp 1G, employment-permit trackers and community timelines) reads those static files as one SPA. No backend. The only optional repo secret is `ALERT_WEBHOOK_URL` (gap-alert webhook); everything else runs unattended. (The old Google Sheet / Apps Script layer was removed; see git history for `Code.gs`.)

## Tech Stack
- Frontend: `index.html` — one self-contained file (inline CSS + inline SPA render). Geist fonts self-hosted in `fonts/`.
- Icons: Lucide via vendored `lucide.min.js`. Wired with a `MutationObserver` that re-runs `lucide.createIcons()` after any render.
- Backend/API: none — static JSON in `data/` (`visa_decisions.json` rows as `[date, irl, decision]` arrays, `visa_meta.json` run-status object).
- Scraper: `scraper.py` (Python: requests, pandas, odfpy, python-dateutil) run by GitHub Actions cron.
- Hosting: Netlify (static publish = `.`), Netlify Forms for Suggestions.

## Files
```
index.html          → the whole SPA (chrome, nav pills, hero, tabs, suggestion form)
scraper.py          → daily visa-file scraper (weekend / holiday handling, JSON persistence, gap alert)
track_1g.py         → Stamp 1G processing-date tracker
track_permits.py    → employment-permit processing-date tracker
sync_timelines.py   → nightly Netlify Forms merge → data/community_timelines.json
test_scraper.py, test_track_1g.py, test_permits.py, test_timelines.py → pytest suites (CI runs all four)
tools/              → make-icons.py, check_html_scripts.py (inline-script syntax check used by CI)
.github/workflows/  → scrape, test, timelines, track_1g, track_permits
data/               → visa_decisions.json, visa_meta.json (scraper-owned), stamp_1g.json,
                      work_permits.json, community_timelines.json
requirements.txt
netlify.toml        → static publish config + security headers
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
- Deploy: Netlify, publish = `.`; no build step.