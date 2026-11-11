# Irish Visa Decision Tracker — Project Instructions

## Architecture

- Frontend: one self-contained SPA in `index.html`, plus `workspace.html`,
  `status.html`, `monthly-report.html` and the trust pages. Shared styling lives
  in `pages.css`, `site-chrome.css` and `workspace.css`.
- Hosting: Cloudflare Pages project `irishvisaupdatetracker`.
- Server: `functions/[[path]].js` catches every request and delegates to
  `functions/_router.js`. No separate Worker.
- D1 binding: `DB`, database `irish-visa-tracker-submissions`.
- Static data: `data/*.json`. The Pages assets and the router serve it with a
  short cache; generated decisions are committed by the scraper workflow.
- Email: the app posts a provider-neutral payload to `EMAIL_WEBHOOK_URL`; the
  deployment’s `/api/email/send` bridge authenticates that call and uses the
  server-side Resend key. Never expose mail credentials to the browser.
- Scheduled work: GitHub Actions, because Pages Functions do not support cron
  triggers. Alert, digest and export endpoints require `X-Cron-Secret`.

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

See `docs/services.md` for variable names, current status and the safe secret
procedure. Do not invent values for Sentry, Twilio, OCR.space or OIDC. The app
must report those integrations as disabled rather than claiming delivery.

## Workflows

- `scrape.yml`: the Python/Node data ingestion and commit job.
- `test.yml`: Python, Node, accessibility and Chromium E2E checks.
- `alerts.yml`: hourly decision-alert safety net.
- `digest.yml`: monthly digest.
- `exports.yml`: due scheduled exports.
- `ml-retrain.yml`: monthly XGBoost retraining, then regenerates
  `functions/api/model-trees.js` and commits the artifacts.
- `timelines.yml`, `track_1g.yml`, `track_permits.yml`: community and queue data.

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
