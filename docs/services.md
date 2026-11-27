# Services and secrets

This page is the operational record for the optional integrations. Values are
never stored in this repository and must not be pasted into chat or committed.

## Cloudflare Pages project

- Project: `irishvisaupdatetracker`
- Production origin: `https://irishvisaupdatetracker.pages.dev`
- D1 binding: `DB`
- Existing production secrets (names only): `APP_BASE_URL`,
  `SCRAPER_CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`. Channel settings:
  `TELEGRAM_CHANNEL_ID` (monthly digest and official-file announcements),
  `TELEGRAM_CHANNEL_URL`.
  Optional custom-domain cutover setting: `PAGES_DEV_REDIRECT_ORIGIN` (the new
  `https://` origin; absent means no old-host redirect).
- Optional monitoring secret: `ALERT_WEBHOOK_URL` (GitHub Actions and the
  separate monitoring Worker).

## Cloudflare analytics (read-only)

Traffic figures for the deployed origin come from Cloudflare Web Analytics
(RUM) through the GraphQL Analytics API.

- Token name: `freebuff-analytics-readonly`. Permissions
  **Account → Account Analytics → Read** (the Web Analytics/RUM datasets) and
  **Account → Account Settings → Read** (required by the Web Analytics site
  API: without it `/rum/site_info/list` returns `10000 Authentication error`).
  Account-scoped to this account only, no other permissions.
- It lives only in the local, gitignored `.dev.vars`
  (`CLOUDFLARE_API_TOKEN`, plus the non-secret `CLOUDFLARE_ACCOUNT_ID`). It is
  never a Pages secret, a GitHub secret or a site asset.
- The GraphQL endpoint accepts API tokens only; the Wrangler OAuth login used
  for `wrangler pages deploy` is rejected there.

```bash
node tools/cloudflare-analytics.mjs --check   # token, accounts, Web Analytics sites
node tools/cloudflare-analytics.mjs --days=7  # daily pageviews, top pages, countries, CWV
```

`--json` returns the same figures plus a `webVitals` array. Two traps when
querying the RUM datasets directly: web vitals live in
`rumWebVitalsEventsAdaptiveGroups`, not the pageload dataset, and their
`quantiles` arrive in **microseconds** with `-1` meaning "no sample for this
metric" (shown as `n/a`). The query filters `bot: 0`, so the CWV table is human
traffic only.

The report also splits human from bot pageviews and homepage `/` from every
other subpage. Cloudflare does not support excluding an individual IP address
from Web Analytics, and Web Analytics Rules (hostname/path include-exclude) only
exist for zones proxied through Cloudflare, so `.pages.dev` has neither. The
human series plus the subpage share is the supported way to read growth; do not
read the raw homepage total as demand.

Set or rotate a Pages secret with a local value file. The value is piped to
Wrangler and is not printed by the command:

```bash
npx wrangler pages secret put NAME --project-name=irishvisaupdatetracker < path/to/value
```

D1 also stores the operational counters and the activation funnel:

- `rate_limits` — shared fixed-window API counters (`bucket`, `subject`,
  `window_start`, `count`). The subject is the client IP for the general API
  bucket; `predict-feedback` is a separate, stricter bucket. Old rows are pruned
  opportunistically; losing this table only degrades the limiter to a
  per-isolate fallback.
- `conversion_events` — fixed-vocabulary funnel events (`alert_cta_view`,
  Telegram click and open, watchlist add, search, activation step, PWA install).
  It stores no email address, IP address, cookie or free text.

## Current status

| Variable | State | Effect when absent |
|---|---|---|
| `APP_BASE_URL` | Configured | Links fall back to the production origin |
| `PAGES_DEV_REDIRECT_ORIGIN` | Optional until a custom domain is live | The old `pages.dev` host returns no redirect |
| `ALERT_WEBHOOK_URL` | Optional shared alert destination | External uptime and cron-failure alerts have no out-of-band delivery |
| `SCRAPER_CRON_SECRET` | Configured | `/api/alerts/run` and `/api/digest/send` return 503 |
| `TELEGRAM_BOT_TOKEN` | Configured (deployment secret) | Telegram alerts report disabled |
| `TELEGRAM_WEBHOOK_SECRET` | Configured (deployment secret) | The Telegram webhook rejects every update with 503 |
| `TELEGRAM_BOT_USERNAME` | Optional | The worker calls `getMe` to resolve the bot handle; `/api/config` publishes it for office deep links |
| `TELEGRAM_CHANNEL_ID` | Optional | `/api/telegram/broadcast` skips without posting to a public channel |
| `TELEGRAM_CHANNEL_URL` | Optional | The Data status page does not show a public channel link |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Configured | Browser push reports disabled |

## VFS appointment handoff

`GET /api/vfs/appointments?office=<vac-slug>` returns a static handoff to the
official VFS Ireland-India booking portal. VFS does not publish the appointment
calendar publicly; availability is visible only after signing in. The endpoint
makes no outbound request and returns `login_required`, `requires_login: true`,
`public_slots: false`, the official booking/login/tracking links and a message
stating that the tracker cannot see, hold or book a slot.

VFS slot monitoring is intentionally not implemented. It would need a user's
authenticated VFS session and would bypass the portal's access controls.

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
New links store the application's currently published decision date as their
baseline, so an already-published decision does not alert; only a later report
does. `/stop` disables the chat and `/status` lists its linked applications and
any office updates.

`/office <office>` subscribes the chat to one message each time that office
publishes a new decisions file, even when the reader's own number is not in it —
the common case during a long wait. The first subscription records the office's
current report date as its baseline, so an already-published file does not
alert; `/office off <office>` removes it and `/office` lists what is on. A deep
link of the form `t.me/<bot>?start=office_new-delhi` does the same from a site
button.
Chat members can switch to `/digest daily`, `/digest weekly` or `/digest off`; a
digest groups the linked applications by office and includes a no-change line
for each office. Add an optional preferred hour and IANA timezone, for example
`/digest daily 8 Europe/Dublin`; the hourly runner waits for that local hour
before sending. `/digest status` shows the frequency, delivery hour, timezone
and last actual delivery, while `/digest preview` shows the next content without
marking anything sent or moving the schedule; a daily no-change preview says
the scheduled digest would be skipped. Daily digests are suppressed when nothing
changed; weekly digests include an explicit no-change summary.
`/immediate <number>` returns one application to immediate mode.
`/digest <number>` returns one to digest mode, and `/remove <number>` stops one
application without affecting the rest of the chat. The digest is
Telegram-only: applications saved only in the browser watchlist are local and
are never uploaded, so they are delivered by browser push rather than the
digest. No email address or phone number is collected, so there is no domain
verification, opt-in review or per-message fee.

For a public low-noise channel, add the bot as a channel administrator and set
`TELEGRAM_CHANNEL_ID` (numeric `-100...` id or `@channelusername`) plus the public
`TELEGRAM_CHANNEL_URL`. After a verified production deploy, the deploy workflow
calls `/api/telegram/broadcast`; its first run seeds existing history rather than
backfilling the channel, and later runs post one message per new official file.
The feed itself is available at `/feed.xml` and `/official-file-feed.json`.

## Calendar subscription

`GET /api/calendar/offices.ics` is the public rolling webcal feed for all six
offices. It is generated from `data/reports/index.json`, uses stable UIDs for
each expected window and report date, marks expected windows `TENTATIVE` and
published reports `CONFIRMED`, and links each event to the official source.
The feed covers eight weeks of expected windows and recent published reports
(plus the latest report for every office). Calendar clients can subscribe with
`webcal://irishvisaupdatetracker.pages.dev/api/calendar/offices.ics`; the older
`/api/calendar/next-update.ics` remains as a single New Delhi event.

## Monthly digest

The monthly report is announced in the Telegram channel, not by email.
`POST /api/digest/send` builds one message from the same figures the report
page uses and posts it with the bot token; a reader opts in by following the
channel, so there is no address to collect, verify or unsubscribe.

`digest_broadcasts` records the month once the post succeeds, so the workflow's
monthly cron, its next-day retry and the per-scrape fallback can all call the
endpoint without a second announcement. When `TELEGRAM_CHANNEL_ID` is not set
the endpoint returns `{"success": true, "skipped":
"telegram_channel_not_configured"}` and the workflow stays green: a missing
channel is a configuration gap, not a failed delivery.

`GET /api/digest/preview?month=YYYY-MM` returns the same text (add
`&format=text` for the message alone), so the wording can be checked before a
month is announced.

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
  alert, digest, ML and data workflows to `ALERT_WEBHOOK_URL`.

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

Both call the corresponding `/api/*` endpoint with `X-Cron-Secret` and skip
with a workflow warning when the repository’s `SCRAPER_CRON_SECRET` secret is
absent. Add that repository secret (Actions → Secrets and variables → Actions)
with the same value as the Pages secret, then run each workflow once with
`workflow_dispatch` to verify it.

Failed runs of those workflows are forwarded to the shared alert webhook by
`cron-failure-alerts.yml`, whatever triggered them. The external uptime and freshness check does not use
`SCRAPER_CRON_SECRET`; it only reads public endpoints.
