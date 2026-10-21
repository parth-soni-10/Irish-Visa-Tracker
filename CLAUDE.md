# Irish Visa Decision Tracker — Project Instructions

## Overview
Tracks daily visa decisions published by the Embassy of Ireland in New Delhi. A GitHub Actions Python scraper fetches the embassy's `.ods` file and upserts rows into `data/visa_decisions.json` (+ `data/visa_meta.json` health object), committing them back to the repo; the dashboard (embassy-decisions tracker plus Stamp 1G, employment-permit trackers and community timelines) reads those files as one SPA. The only optional repo secret is `ALERT_WEBHOOK_URL` (gap-alert webhook); everything else runs unattended. (The old Google Sheet / Apps Script layer was removed; see git history for `Code.gs`.)

### Where the data on the page comes from
`data/*.json` is written by the GitHub Actions jobs, never by hand. The Worker
serves those five files from the repository (short edge cache, bundled asset as
fallback — see the data-proxy block in `functions/_router.js`), so a pipeline commit shows
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
- Hosting: **Cloudflare Pages, one host** — `irishvisaupdatetracker.pages.dev`. Pages compiles `functions/` as the site's function (the catch-all `functions/[[path]].js` reaches `functions/_router.js`), which handles the three forms (POSTs land in D1, binding `DB`), serves the timeline rows back at `GET /api/community-submissions` for the nightly sync, and proxies `data/*.json` from the repo; everything else comes from the static assets staged from the repository root, with response headers in `_headers` (the only copy — the old `netlify.toml` is deleted, since Cloudflare ignored it).

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
functions/[[path]].js → the catch-all Pages Function: hands every request to the router
functions/_router.js  → form POSTs → D1, /api/community-submissions (timeline rows) for the
                      nightly sync, data/ proxied from the repo, else static assets
wrangler.toml       → bundle input for the Pages build only (name, main, compatibility date)
wrangler.dev.toml   → local `wrangler dev` only (assets = repo root, D1 binding `DB`)
wrangler.toml       → the site's one config: its Pages project, plus the D1 binding it runs on
schema.sql          → reference copy of the `submissions` table the handler creates lazily
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
- Deploy: a push to `main` deploys it — the repo is connected to the **Cloudflare Pages** project `irishvisaupdatetracker` (production branch `main`, preview builds off). Pages compiles `functions/`, and the build command stages the upload into `.pages-dist`, with the D1 binding coming from `wrangler.toml`. **At the cutover that command is `node tools/build-app.mjs --out .pages-dist`** (it stages `app/` plus `data/`, `fonts/`, the icons and the crawl files); until that line is changed the project keeps staging the repository root through `.assetsignore` (`node tools/deploy-pages.mjs --assets . --out .pages-dist`), which is the rollback. A `data/*` commit therefore republishes the site, which is what keeps `data/` current: the deployment serves those files from its own upload. Nothing is deployed from a shell, and local testing is `npx wrangler pages dev . --d1 DB=irish-visa-tracker-submissions` — measured: `pages dev` did not pick this site's D1 binding up from `wrangler.toml`, so the flag is what makes the local run bind the store it writes to (the deployed project's binding is configured on the project, and the config is what a deploy reads it from).

## Cutover build (`app/`, cutover commit 2026-10-20)
- **The cutover is committed; the deployment still serves the root app until the Pages build command is switched.** `node tools/build-app.mjs --out .pages-dist` stages `app/` as the document root and copies in what it reads but does not own: `data/` (scraper-owned, read-only), `fonts/`, `icon.svg`/`apple-touch-icon.png`/`og-image.png`, and `robots.txt`/`sitemap.xml` (missing crawl files are a build failure, not a silent omission). Reverting the build command to `node tools/deploy-pages.mjs --assets . --out .pages-dist` restores the old app byte for byte: the root `index.html` and the root `_headers` are deliberately still here as the rollback, so the two header policies never fight over one upload — the staged `_headers` always comes from `app/`, and the root one only takes effect if the old app is served again.
- `app/` is class-only and strict-CSP: `script-src 'self'`, `style-src 'self'`. No inline `<script>`, `<style>` or `style=` in served markup, and no runtime style injection. Run `node tools/build-app.mjs` then the shared `verify-csp.ts --dist .pages-dist` before any deploy review.
- Keep `data/**` read-only. `tools/build-app.mjs` copies it into the upload; nothing in it may be rewritten by the app.
- Keep the URL contract: `?tracker=(home|visa|1g|permits)&tab=(home|daily|past|suggest)&q=&date=`. Tab/tracker changes push history, search/date replace it, and `popstate` restores all four. `?watch=<digits,…>` seeds the watchlist (documented addition) and `?admin=1` shows the read-only submissions preview.
- Keep the forms: `suggestions` (name, suggestion, `bot-field`), `timelines-visa` and `timelines-1g` (applied, decided, outcome, tracker, `bot-field`), all POSTed to this origin.
- `tools/serve-app.mjs` + `VISA_BASE_URL=… node tools/verify-visa.mjs` is the local gate: 8 routes at 375/768/1280, both themes, axe, CSP console, keyboard, URL contract, reduced motion, worker update prompt.

## Hairline figure (overview empty state)
`app/hairline/` holds the Hairline engine (`kernel.js`), a bench-free mount adapter (`mount.js`) and one figure (`runway.js`, wrapped in an IIFE so its destructured `HL` names cannot collide with another figure). It renders only when `data/visa_decisions.json` is empty, inside the `Awaiting data…` card on the overview, and the words stay: the card's heading and hint are the accessible content, the stage is `role="img"` with the figure's own `aria-label`, and the small read-out (`rest` / `gate 1…3`) is `aria-live="polite"`.
- **CSP:** the engine's `HL.inject()` is never called; its stylesheet is copied into `app/styles.css` with the palette mapped to this site's tokens (`--hairline-*`). Three external `<script defer>` files, nothing inline.
- **Shape:** the stage must keep a 5:4 box (`width: min(100%, 400px)`), because the kernel maps pointer coordinates against the element's rect and assumes the viewBox fills it.
- **Rebuild note:** the figure was authored and validated with the `hairline-create` skill (`build.mjs` / `validate.mjs`), and the mounted result was checked in a browser with the real `_headers` CSP enforced. If the figure changes, rebuild it on the bench first, then copy it here.
## The design-system component layer

The site is now built on the shared design-system rather than on hand-written
markup, and the change is visible in the source.

- **The 27 components** from `design-system/` are the base for this site's
  controls. Every integrated instance renders `data-component="<slug>"`, and
  that attribute is what the coverage verifier reads - it is the contract, not
  a comment.
- **The component layer** is `components.js`, and it is idempotent: it
  re-runs on a debounced MutationObserver after each route render, and it
  installs each part inside its own try/catch, so a component that cannot
  install logs once and shows up as a missing marker rather than as a broken
  page.
- **The tokens** are the site's own stylesheet, so a spacing, colour or
  motion value is set in one place and read by everything. The motion
  durations are the four tiers (`--motion-duration-micro`, `-standard`,
  `-complex`, `-page`) and the three easing curves; a duration is never
  written into a rule.
- **The strict CSP is not negotiable**: no inline `<script>`, no `<style>`
  element, no `style=""` attribute in served HTML. `tools/check-csp-inline.py`
  (or the shared `verify-csp.ts`) fails the build if one appears.
