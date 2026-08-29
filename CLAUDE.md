# Irish Visa Decision Tracker — Project Instructions

## Overview
Tracks daily visa decisions published by the Embassy of Ireland in New Delhi. A GitHub Actions Python scraper fetches the embassy's `.ods` file and upserts rows into a Google Sheet; an Apps Script Web App (`Code.gs`) exposes an HTTP API that the Netlify dashboard's four tabs (Home, Daily Summary, Past Results, Suggestions) read.

## Tech Stack
- Frontend: `index.html` — one self-contained file (inline CSS + inline SPA render). Geist fonts self-hosted in `fonts/`.
- Icons: Lucide via vendored `lucide.min.js`. Wired with a `MutationObserver` that re-runs `lucide.createIcons()` after any render.
- Backend/API: `Code.gs` (Google Apps Script Web App) over the Google-Sheet database.
- Scraper: `scraper.py` (Python: requests, pandas, odfpy, python-dateutil) run by GitHub Actions cron.
- Hosting: Netlify (static publish = `.`), Netlify Forms for Suggestions.

## Files
```
index.html      → the whole SPA (chrome, nav pills, hero, four tabs, suggestion form)
scraper.py      → daily visa-file scraper (weekend / public-holiday handling)
test_scraper.py → scraper unit tests (pytest)
Code.gs         → Apps Script HTTP API over the Sheet
requirements.txt
netlify.toml    → static publish config + security headers
```

## Code Style / Conventions
- SPA is JS-rendered into `#visa-dash`: nav pills, hero, and stat-card labels are template strings inside functions like `render()`, `renderHomeLayout()`, `renderDailySummary()`, `renderPastLayout()`.
- Icons: add `<i data-lucide="name"></i>` in static markup or render templates — the MutationObserver converts them to inline SVGs automatically (no manual createIcons calls). Size via the `.navpill .lucide` / `.card .label .lucide` rules.
- Color is intentional: green/red/amber are reserved for decision states; only `--green` is used for decoration. Keep that split.
- The dashboard must render gracefully with no data ("Awaiting data…") — don't assume rows exist.

## Testing
- Scraper: `pytest test_scraper.py`.
- Frontend: serve the folder (geist fonts + lucide are local) and exercise all four tabs; inline scripts must pass `node --check` if touched.

## Build & Run
- Scraper: `pip install -r requirements.txt`; runs in GitHub Actions (secret: `WEB_APP_URL`).
- Deploy: Netlify, publish = `.`; no build step.