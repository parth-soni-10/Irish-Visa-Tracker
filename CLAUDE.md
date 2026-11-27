# Irish Visa Decision Tracker — Project Instructions

## Architecture

- Frontend: one self-contained SPA in `index.html`, plus `status.html`,
  `monthly-report.html` and the trust pages. Shared styling lives in
  `pages.css` and `site-chrome.css`.
- Hosting: Cloudflare Pages project `irishvisaupdatetracker`.
- Server: `functions/[[path]].js` catches every request and delegates to
  `functions/_router.js`. The Pages app has no separate Worker.
- Monitoring: `monitoring/worker.js` is a separate cron-only Worker for
  persisted Workers Logs/Logpush uptime checks; the app itself uses structured
  Pages Function logs and `/api/health`.
- D1 binding: `DB`, database `irish-visa-tracker-submissions`.
- Static data: `data/*.json`. The Pages assets and the router serve it with a
  short cache; generated decisions are committed by the scraper workflow.
- Digest: the tracker sends no email. The monthly report is announced as one
  post in the Telegram channel (`TELEGRAM_CHANNEL_ID`); per-application alerts
  use Telegram or browser push.
- Scheduled work: GitHub Actions, because Pages Functions do not support cron
  triggers. Alert and digest endpoints require `X-Cron-Secret`.

## Data model

Six official offices: `new-delhi`, `beijing`, `dublin`, `abu-dhabi`, `abuja`,
`ankara`. Weekly PDF archives preserve historical report dates. A missing
official report is a gap; never infer or backfill invented rows.

Current integrity checks:

```bash
node tools/verify-embassy-checksums.mjs
node tools/verify-ankara.mjs
node --test tests/*.test.mjs
```

## Conventions

- Plain HTML/CSS/JS, no frontend framework.
- Green/red/amber are reserved for decision states.
- The dashboard must render an explicit empty state with no data.
- Keep public JSON shapes stable: the New Delhi tracker rows are
  `[date, applicationNumber, decision]` arrays.
- API responses that are personalized must be `Cache-Control: no-store`.
- Never commit `.env`, `.dev.vars`, `.wrangler`, `.pages-dist`, logs, browser
  state, OCR language data or generated test output.

## Services

See `docs/services.md` and `docs/monitoring.md` for variable names, current
status and the safe secret procedure. Do not invent provider credentials.
Telegram and push are the supported alert channels; email is used only for the
monthly report digest. SMS/WhatsApp are not part of the product. `ALERT_WEBHOOK_URL` is the optional shared monitoring
alert destination.

## Workflows

- `scrape.yml`: the Python/Node data ingestion and commit job.
- `test.yml`: Python, Node, accessibility and Chromium E2E checks.
- `alerts.yml`: hourly decision-alert safety net.
- `digest.yml`: monthly digest.
- `ml-retrain.yml`: monthly XGBoost retraining, then regenerates
  `functions/api/model-trees.js` and commits the artifacts.
- `timelines.yml`, `track_1g.yml`, `track_permits.yml`: community and queue data.
- `uptime.yml`: external health and data-freshness probe.
- `cron-failure-alerts.yml`: forwards every failed run to the alert webhook, or opens an issue when it is unset.

## Deploy

```bash
npm run build
npx wrangler pages deploy .pages-dist --project-name=irishvisaupdatetracker --branch=main
node tools/smoke-deploy.mjs
```

The GitHub deployment workflow also deploys on a push to `main`. Do not push,
publish or rotate production secrets without explicit authorization.

## Scope

Native mobile is deferred; the PWA is the supported mobile product. Keep the
native plan in `IMPLEMENTATION_PLAN.md` as a future option, not active work.

## Explicit state machines

`scripts/state-machine.js` names the states the tracker already moves through
and projects them onto the DOM; `scripts/app-machines.js` declares the machines.
Both are observers - they read what `scripts/index.js` writes and never drive it.

| machine | host | states | source of truth |
| --- | --- | --- | --- |
| tab | `#visa-dash` | search, history, alerts, saved, tools | `.navpill.active` |
| alerts | `#visa-dash` | unsupported, default, granted, denied | `Notification.permission` |
| freshness | `#landing-freshness` | unknown, current, stale, error | the landing freshness sentence |

`data-<machine>-state` on the host is the inspection view, a bubbling
`machine:change` event is the runtime view, and `window.StateMachine.snapshot()`
is the agent view.
