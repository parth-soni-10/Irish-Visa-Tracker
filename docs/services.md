# Services and secrets

This page is the operational record for the optional integrations. Values are
never stored in this repository and must not be pasted into chat or committed.

## Cloudflare Pages project

- Project: `irishvisaupdatetracker`
- Production origin: `https://irishvisaupdatetracker.pages.dev`
- D1 binding: `DB`
- Existing production secrets (names only): `APP_BASE_URL`, `RESEND_API_KEY`,
  `SCRAPER_CRON_SECRET`, `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`,
  `VAPID_SUBJECT`.

Set or rotate a Pages secret with a local value file. The value is piped to
Wrangler and is not printed by the command:

```bash
npx wrangler pages secret put NAME --project-name=irishvisaupdatetracker < path/to/value
```

## Current status

| Variable | State | Effect when absent |
|---|---|---|
| `APP_BASE_URL` | Configured | Links fall back to the production origin |
| `SCRAPER_CRON_SECRET` | Configured | `/api/alerts/run`, `/api/digest/send`, `/api/exports/run` return 503 |
| `EMAIL_WEBHOOK_URL` | Configured to the deployment’s `/api/email/send` bridge | Email delivery is disabled |
| `EMAIL_WEBHOOK_SECRET` | Configured (deployment secret) | Email bridge rejects requests |
| `EMAIL_FROM` | Configured from the existing Resend sender | Resend bridge cannot choose a sender |
| `RESEND_API_KEY` | Existing production secret | Resend bridge returns 503 |
| `SENTRY_DSN` | **Not configured** — no Sentry project/DSN supplied | Sentry is a no-op |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_FROM` / `TWILIO_WHATSAPP_FROM` | **Not configured** — no Twilio account supplied | SMS and WhatsApp channels report disabled |
| `TELEGRAM_BOT_TOKEN` | **Not configured** — create a bot with @BotFather | Telegram alerts report disabled |
| `TELEGRAM_WEBHOOK_SECRET` | **Not configured** | The Telegram webhook accepts unsigned updates |
| `TELEGRAM_BOT_USERNAME` | Optional | The worker calls `getMe` to resolve the bot handle |
| `OCR_SPACE_API_KEY` | **Not configured** — no OCR.space key supplied | File OCR returns a clear “not configured” error |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | **Not configured** — no identity provider supplied | Password auth works; SSO status reports disabled |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Configured | Browser push reports disabled |

The unconfigured groups require account-specific credentials or a provider
project. They cannot be invented safely.

## Telegram alerts

Telegram is the only alert channel that needs neither a sending domain nor
business verification. Create a bot with [@BotFather](https://t.me/BotFather),
then set the deployment secrets:

- `TELEGRAM_BOT_TOKEN` — the token BotFather returns.
- `TELEGRAM_WEBHOOK_SECRET` — any high-entropy string; Telegram echoes it in
  `X-Telegram-Bot-Api-Secret-Token` and the webhook rejects mismatches.
- `TELEGRAM_BOT_USERNAME` — optional; when absent the worker calls `getMe`.

```bash
npx wrangler pages secret put TELEGRAM_BOT_TOKEN --project-name=irishvisaupdatetracker < path/to/token
npx wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=irishvisaupdatetracker < path/to/secret
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node tools/setup-telegram-webhook.mjs set
```

A visitor enters an application number on the tracker and presses “Get alerts on
Telegram”. The site creates a single-use token that expires in 15 minutes and
opens `https://t.me/<bot>?start=<token>`; pressing Start stores that chat id
against the application. The hourly alert runner then sends one message per
published decision date, updating `last_alert_sent` so retries are idempotent.
`/stop` disables the chat and `/status` lists its linked applications. No email
address or phone number is collected, so there is no domain verification,
opt-in review or per-message fee.

## Email bridge

The app deliberately speaks one provider-neutral webhook contract. The bridge at
`POST /api/email/send` validates `EMAIL_WEBHOOK_SECRET` and sends through Resend
using the server-side `RESEND_API_KEY`. `EMAIL_WEBHOOK_URL` therefore points at:

```
https://irishvisaupdatetracker.pages.dev/api/email/send
```

The bridge is exempt from the public per-IP API limiter because a digest may
legitimately send more than 60 messages; the high-entropy webhook secret is its
authentication boundary. It pins the sender to `EMAIL_FROM` when that value is
set and never returns provider details or credentials.

`onboarding@resend.dev` can only deliver to the Resend account owner. For
arbitrary recipients, verify a sending domain in Resend and update `EMAIL_FROM`
before relying on production mail.

The production bridge was exercised on 2026-11-11: missing/wrong secrets
returned 401, an invalid recipient returned 400, and a real message returned
200 with a Resend message id. Pages binds secrets at deployment time, so after
adding or changing one, redeploy the Functions bundle before testing.

## Schedulers

Pages Functions do not support Cloudflare cron triggers. The GitHub Actions
workflows provide them:

- `.github/workflows/alerts.yml` — hourly decision-alert safety net.
- `.github/workflows/digest.yml` — monthly digest on the first of the month.
- `.github/workflows/exports.yml` — daily due-export delivery.

All three call the corresponding `/api/*` endpoint with `X-Cron-Secret` and skip
with a workflow warning when the repository’s `SCRAPER_CRON_SECRET` secret is
absent. Add that repository secret (Actions → Secrets and variables → Actions)
with the same value as the Pages secret, then run each workflow once with
`workflow_dispatch` to verify it.

## Sentry

When a project and DSN are available, set `SENTRY_DSN` as a Pages secret and
optionally `SENTRY_ENVIRONMENT`. The existing `/api/config` exposes the DSN to the
browser bundle only when it is a valid HTTPS/HTTP DSN. Do not use a dummy value.

## Twilio

Set all four Twilio values. SMS requires `TWILIO_SMS_FROM`; WhatsApp requires a
sender in the `whatsapp:+...` form in `TWILIO_WHATSAPP_FROM`. Add a recipient via
the workspace and use the “send test” action before relying on alerts.

## OCR.space

Set `OCR_SPACE_API_KEY` to enable `POST /api/portal/scan` for PDFs and images up
to 5 MB. Text extraction still works without the provider by pasting text.

## OIDC / SSO

Set all three OIDC values and register this callback with the provider:

```
https://irishvisaupdatetracker.pages.dev/api/auth/sso/callback
```

Password authentication remains available when SSO is not configured.
