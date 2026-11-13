# Services and secrets

This page is the operational record for the optional integrations. Values are
never stored in this repository and must not be pasted into chat or committed.

## Cloudflare Pages project

- Project: `irishvisaupdatetracker`
- Production origin: `https://irishvisaupdatetracker.pages.dev`
- D1 binding: `DB`
- Existing production secrets (names only): `APP_BASE_URL`, `RESEND_API_KEY`,
  `EMAIL_WEBHOOK_URL`, `EMAIL_WEBHOOK_SECRET`, `EMAIL_FROM`,
  `SCRAPER_CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.
- Optional monitoring secret: `ALERT_WEBHOOK_URL` (GitHub Actions and the
  separate monitoring Worker).

Set or rotate a Pages secret with a local value file. The value is piped to
Wrangler and is not printed by the command:

```bash
npx wrangler pages secret put NAME --project-name=irishvisaupdatetracker < path/to/value
```

D1 also stores the operational counters and the activation funnel:

- `rate_limits` — shared fixed-window API/auth counters (`bucket`, `subject`,
  `window_start`, `count`). Old rows are pruned opportunistically; losing this
  table only degrades the limiter to a per-isolate fallback.
- `conversion_events` — fixed-vocabulary funnel events (`alert_cta_view`,
  email/Telegram click and submit, watchlist add, search, activation step, PWA
  install). It stores no email address, IP address, cookie or free text.

## Current status

| Variable | State | Effect when absent |
|---|---|---|
| `APP_BASE_URL` | Configured | Links fall back to the production origin |
| `ALERT_WEBHOOK_URL` | Optional shared alert destination | External uptime and cron-failure alerts have no out-of-band delivery |
| `SCRAPER_CRON_SECRET` | Configured | `/api/alerts/run`, `/api/digest/send`, `/api/exports/run` return 503 |
| `EMAIL_WEBHOOK_URL` | Configured to the deployment’s `/api/email/send` bridge | Email delivery is disabled |
| `EMAIL_WEBHOOK_SECRET` | Configured (deployment secret) | Email bridge rejects requests |
| `EMAIL_FROM` | Configured from the existing Resend sender | Resend bridge cannot choose a sender |
| `RESEND_API_KEY` | Existing production secret | Resend bridge returns 503 |
| `TELEGRAM_BOT_TOKEN` | Configured (deployment secret) | Telegram alerts report disabled |
| `TELEGRAM_WEBHOOK_SECRET` | Configured (deployment secret) | The Telegram webhook rejects every update with 503 |
| `TELEGRAM_BOT_USERNAME` | Optional | The worker calls `getMe` to resolve the bot handle |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Configured | Browser push reports disabled |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` | Optional | VFS checks use a direct HTTP request and report VFS's bot challenge |

## VFS appointment check

`GET /api/vfs/appointments?office=<vac-slug>` reads the official VFS
Ireland-India booking page. VFS does not expose that booking calendar publicly:
it requires an account sign-in and usually answers unauthenticated requests
with a Cloudflare challenge. The endpoint therefore reports only `available`,
`unavailable`, `login_required`, `challenge`, `maintenance` or `unknown`, plus
the official booking/login links. It never stores VFS credentials, signs in, or
claims a slot.

If `CF_ACCOUNT_ID` and `CF_API_TOKEN` are set, the checker renders the page with
Cloudflare Browser Rendering before classifying it. Without those optional
secrets it uses a direct request; a `403` is reported as a challenge, not as
unavailable. VFS slot monitoring through its authenticated API is not
implemented because it needs a user's VFS session and would bypass the portal's
access controls.

## Telegram alerts

Telegram is the only alert channel that needs neither a sending domain nor
business verification. Create a bot with [@BotFather](https://t.me/BotFather),
then set the deployment secrets:

- `TELEGRAM_BOT_TOKEN` — the token BotFather returns.
- `TELEGRAM_WEBHOOK_SECRET` — any high-entropy string; Telegram echoes it in
  `X-Telegram-Bot-Api-Secret-Token` and the webhook rejects mismatches. If the
  secret is unset, the webhook fails closed and processes nothing.
- `TELEGRAM_BOT_USERNAME` — optional; when absent the worker calls `getMe`.

```bash
npx wrangler pages secret put TELEGRAM_BOT_TOKEN --project-name=irishvisaupdatetracker < path/to/token
npx wrangler pages secret put TELEGRAM_WEBHOOK_SECRET --project-name=irishvisaupdatetracker < path/to/secret
TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node tools/setup-telegram-webhook.mjs set
```

After adding or rotating `TELEGRAM_WEBHOOK_SECRET`, re-run
`node tools/setup-telegram-webhook.mjs set` with the new value so Telegram is
told about it. If you skip that step, Telegram keeps sending the old secret (or
no secret header), and the webhook rejects every update with 401.

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

## Monitoring

Sentry was removed by product decision on 2026-11-12. The supported stack is:

- `GET /api/health` — D1 and static-asset readiness, `200` or `503`.
- `functions/monitoring.js` — structured JSON request/error logs for Pages
  Functions (live tail and dashboard Functions view).
- `monitoring/wrangler.toml` — a separate Worker with Workers Logs and
  `logpush = true`; it checks `/api/health` every ten minutes. Deploy it with
  `npx wrangler deploy --config monitoring/wrangler.toml` and set its
  `ALERT_WEBHOOK_URL` secret.
- `.github/workflows/uptime.yml` — an external, independent readiness and data
  freshness check every 15 minutes.
- `.github/workflows/cron-failure-alerts.yml` — posts failed scheduled scraper,
  alert, digest, export, ML and data workflows to `ALERT_WEBHOOK_URL`.

Cloudflare Pages Functions do not persist logs and cannot use Workers Logs or
Workers Logpush. App errors therefore use the live structured stream; the
separate monitoring Worker is the persisted Workers Logs/Logpush path. Logpush
requires a Workers Paid plan and an account-level Logpush job with an R2/S3 or
log-provider destination.

See [`docs/monitoring.md`](monitoring.md) for deployment and verification
commands.

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

Scheduled failures are forwarded to the shared alert webhook by
`cron-failure-alerts.yml`. The external uptime and freshness check does not use
`SCRAPER_CRON_SECRET`; it only reads public endpoints.
