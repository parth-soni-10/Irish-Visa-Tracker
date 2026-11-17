# Irish Visa Decision Tracker

A public, unofficial tracker for Irish visa decisions, with a searchable archive, community processing timelines, local watchlists, reports and anonymous alerts.

**Live:** https://irishvisaupdatetracker.pages.dev

## What it tracks

- **New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin** official decision publications.
- **61,154 latest-report rows** across the six offices; the dated archives contain **65,977 rows**.
- New Delhi’s daily tracker contains **42,621 decisions plus 49 dated placeholders**.
- Weekly PDF offices keep their historical report dates: Abu Dhabi has 9 dated reports, Abuja 27 and Ankara 4.
- Only official public files are ingested. A missing official file is left as a gap, never filled with inferred decisions.

The Abuja **31 August–6 September 2026** report, long listed as missing, was recovered from the office's own asset archive (`ApplicationDecisionReport_30.08__06.09.pdf`) and is now in the history. The dated series runs continuously from 30 August through 13 September.

## Product surface

- Application lookup, daily summaries, monthly reports and historical trends.
- VFS Global appointment handoff for the India/Ireland VACs. VFS shows the booking calendar only after sign-in; the tracker links to the official portal and never claims availability.
- PWA install and push notifications; the service worker keeps no fetch cache, so a fresh deploy is shown on the next load.
- A browser-local watchlist (no account) plus anonymous Telegram and browser-push alerts.
- A first-run activation path on the New Delhi dashboard: a prominent Telegram
  call to action, a persisted three-step checklist, and privacy-light
  conversion events (`/api/events`) that record only a fixed event vocabulary
  and surface name.
- Monthly email digest with double opt-in and one-click unsubscribe.
- Document checklist, public analytics and a transparent decision-time baseline.
- A model card with a minimum-sample calibration gate and anonymous finished-application feedback; the synthetic-data ML tree is paused until it can beat the baseline on real outcomes.
- A public RSS/JSON feed of new official office files, optional Telegram channel announcements, and an .ics export for the next expected New Delhi update.
- Agent-facing HTML/Markdown negotiation, `/llms.txt`, sitemap and accessible trust pages.

## Services and configuration

The app degrades explicitly when a service is absent. See [`docs/services.md`](docs/services.md) for the complete list, Cloudflare commands and current configuration status.

The important variables are:

- `APP_BASE_URL`, `SCRAPER_CRON_SECRET`
- `EMAIL_WEBHOOK_URL`, `EMAIL_WEBHOOK_SECRET`, `EMAIL_FROM`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; optional `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_CHANNEL_URL`
- Optional shared monitoring alert destination: `ALERT_WEBHOOK_URL`

The email path is provider-neutral: the app posts to `EMAIL_WEBHOOK_URL`, and this deployment’s secret-protected `/api/email/send` bridge translates that contract to the existing Resend account. No mail credential ever reaches the browser.

## Development and verification

```bash
npm ci
python -m pytest test_scraper.py test_track_1g.py test_permits.py test_timelines.py -q
node --test tests/*.test.mjs
python tools/check_html_scripts.py
node tools/check-js-syntax.mjs
node tools/check-dead-code.mjs
npx playwright test --project=chromium --timeout=120000
npm run build
```

The archive-specific checks are:

```bash
node tools/verify-embassy-checksums.mjs
node tools/verify-ankara.mjs
```

## Deployment

The site is a Cloudflare Pages project (`irishvisaupdatetracker`). Pages compiles `functions/` and serves the assets staged in `.pages-dist` by `tools/deploy-pages.mjs`. Dashboard and page JavaScript live under `scripts/`; extracted styles live under `styles/`. The strict CSP in `_headers` forbids inline executable scripts and `<style>` elements, so new code must be served from those directories.

```bash
npm run build
npx wrangler pages deploy .pages-dist --project-name=irishvisaupdatetracker --branch=main
node tools/smoke-deploy.mjs
```

Scheduled GitHub Actions cover scraping, community timelines, Stamp 1G and permit snapshots, decision alerts and monthly digests. Pages Functions cannot define Cloudflare cron triggers, so these workflows call the secret-protected endpoints.

## Monitoring

Sentry was removed. `GET /api/health` is a readiness probe for D1 and static assets, and Pages Functions emit privacy-light JSON request/error logs. A separate [monitoring Worker](docs/monitoring.md) enables Workers Logs/Logpush for persisted uptime checks, while `uptime.yml` probes production from GitHub and `cron-failure-alerts.yml` forwards failed scheduled runs to `ALERT_WEBHOOK_URL`.

## Scope decision: mobile

The native iOS/Android app is **deferred**. The supported mobile product is the installable PWA, which keeps one codebase, one deployment and the existing push/notification path. The detailed native plan in `IMPLEMENTATION_PLAN.md` is retained as a future option only.

## Notes

- Unofficial; always confirm a decision on the official source.
- Community timelines are submissions, not official decisions.
- A run that finds no new publication fails loudly and can post to an optional alert webhook.
