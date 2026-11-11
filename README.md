# Irish Visa Decision Tracker

A public, unofficial tracker for Irish visa decisions, with a searchable archive, community processing timelines, private watchlists, reports, alerts, and a workspace for applicants.

**Live:** https://irishvisaupdatetracker.pages.dev

## What it tracks

- **New Delhi, Beijing, Abu Dhabi, Abuja, Ankara and Dublin** official decision publications.
- **61,005 latest-report rows** across the six offices; the dated archives contain **65,773 rows**.
- New Delhi’s daily tracker contains **42,472 decisions plus 50 dated placeholders**.
- Weekly PDF offices keep their historical report dates: Abu Dhabi has 9 dated reports, Abuja 26 and Ankara 4.
- Only official public files are ingested. A missing official file is left as a gap, never filled with inferred decisions.

The one known unavailable report is Abuja **31 August–6 September 2026**. The official copy cannot be found on the embassy page, the asset archive or Wayback; the archive therefore jumps from 30 August to 13 September.

## Product surface

- Application lookup, daily summaries, monthly reports and historical trends.
- PWA install, service worker and offline shell.
- Accounts, sessions, private watchlists and an in-app notification inbox.
- Email webhook, browser push and optional Twilio SMS/WhatsApp delivery.
- Monthly email digest with double opt-in and one-click unsubscribe.
- Private workspace: analytics, document checklist, fee quotes, file OCR, scheduled CSV/JSON exports and private export tokens.
- ML decision-time estimate from a committed synthetic-data XGBoost model (illustrative, not a guarantee).
- Agent-facing HTML/Markdown negotiation, `/llms.txt`, sitemap and accessible trust pages.

## Services and configuration

The app degrades explicitly when a service is absent. See [`docs/services.md`](docs/services.md) for the complete list, Cloudflare commands and current configuration status.

The important variables are:

- `APP_BASE_URL`, `SCRAPER_CRON_SECRET`
- `EMAIL_WEBHOOK_URL`, `EMAIL_WEBHOOK_SECRET`, `EMAIL_FROM`
- `SENTRY_DSN`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`
- `OCR_SPACE_API_KEY`
- `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`

The email path is provider-neutral: the app posts to `EMAIL_WEBHOOK_URL`, and this deployment’s secret-protected `/api/email/send` bridge translates that contract to the existing Resend account. No mail credential ever reaches the browser.

## Development and verification

```bash
npm ci
python -m pytest test_scraper.py test_track_1g.py test_permits.py test_timelines.py -q
node --test tests/*.test.mjs
python tools/check_html_scripts.py
npx playwright test --project=chromium --timeout=120000
npm run build
```

The archive-specific checks are:

```bash
node tools/verify-embassy-checksums.mjs
node tools/verify-ankara.mjs
```

## Deployment

The site is a Cloudflare Pages project (`irishvisaupdatetracker`). Pages compiles `functions/` and serves the assets staged in `.pages-dist` by `tools/deploy-pages.mjs`.

```bash
npm run build
npx wrangler pages deploy .pages-dist --project-name=irishvisaupdatetracker --branch=main
node tools/smoke-deploy.mjs
```

Scheduled GitHub Actions cover scraping, community timelines, Stamp 1G and permit snapshots, decision alerts, monthly digests and due exports. Pages Functions cannot define Cloudflare cron triggers, so these workflows call the authenticated endpoints.

## Scope decision: mobile

The native iOS/Android app is **deferred**. The supported mobile product is the installable PWA, which keeps one codebase, one deployment and the existing push/notification path. The detailed native plan in `IMPLEMENTATION_PLAN.md` is retained as a future option only.

## Notes

- Unofficial; always confirm a decision on the official source.
- Community timelines are submissions, not official decisions.
- A run that finds no new publication fails loudly and can post to an optional alert webhook.
