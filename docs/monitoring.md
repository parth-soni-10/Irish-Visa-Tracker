# Monitoring and alerting

Sentry was removed from the application; there is no Sentry DSN, SDK or browser
loader left. Monitoring now has five small pieces, chosen so a monitoring outage
cannot take down the tracker.

## Readiness endpoint

`GET /api/health` (alias `GET /health`) is the probe used by every monitor. It
returns `200` only when both dependencies work:

- D1 answers `SELECT 1`.
- The Pages asset binding serves `/data/data_manifest.json`.

Anything else returns `503` with `status: "degraded"` and no internal error
message. The response is `Cache-Control: no-store` and uses `X-Request-Id` so a
probe can be correlated with the structured logs.

```bash
curl -fsS https://irishvisaupdatetracker.pages.dev/api/health
```

## Application error logs

`functions/monitoring.js` emits one JSON object per API request, failed static
request or uncaught exception. The shape is stable and contains no request
bodies, query strings, IP addresses, cookies or email addresses:

```json
{"timestamp":"...","level":"info","event":"request","service":"irish-visa-tracker","request_id":"...","method":"GET","path":"/api/health","duration_ms":12,"status":200,"outcome":"ok"}
```

View live logs from a deployment:

```bash
npx wrangler pages deployment tail --project-name=irishvisaupdatetracker
```

The Cloudflare dashboard shows the same stream under the deployment's
**View details → Functions** view. Cloudflare Pages Functions logs are live
only: they are not stored and Pages does not support Workers Logs or Workers
Logpush. Persistent Workers Logs/Logpush therefore live in the separate
monitoring Worker below, not in the Pages project.

## Monitoring Worker (Workers Logs and Logpush)

`monitoring/worker.js` is a separate, tiny Worker. Every ten minutes it probes
the Pages readiness endpoint, writes a `monitor_check` JSON record and sends the
alert webhook when the check fails. It has no user data or request-proxying
responsibility.

Deploy it once:

```bash
npx wrangler deploy --config monitoring/wrangler.toml
npx wrangler secret put ALERT_WEBHOOK_URL --config monitoring/wrangler.toml
```

`monitoring/wrangler.toml` enables Workers Logs and `logpush = true`. View the
stored checks under **Workers & Pages → irish-visa-tracker-monitor →
Observability**.

Workers Trace Events Logpush requires the Workers Paid plan and a Logpush job
with an R2/S3/log-provider destination. Create that job in **Analytics & Logs →
Logs** (or through the Logpush API) after deploying; `logpush = true` only marks
the Worker as eligible. No destination credentials belong in this repository.

## External uptime check

`.github/workflows/uptime.yml` runs `tools/monitor.mjs` on GitHub's
infrastructure every 15 minutes. It is independent of Cloudflare, so a Pages
outage cannot suppress it. It checks:

1. `/api/health` returns HTTP 200 with healthy D1 and asset checks.
2. `/data/data_manifest.json` was generated within the last 72 hours.

A failure fails the workflow and posts to `ALERT_WEBHOOK_URL` when the
repository secret is configured. Without the secret, the failed workflow is the
fallback notification. The same endpoint can be used by an external uptime
service (for example, an HTTP monitor every five minutes with the expected body
`"status": "healthy"`); no additional application code is needed.

## Failed cron runs

`.github/workflows/cron-failure-alerts.yml` listens for failed scheduled runs of
the scraper, alerts, digest, exports, ML retraining, community timeline, Stamp
1G and permit workflows. It posts the workflow name and run URL to
`ALERT_WEBHOOK_URL`; if the secret is absent it fails deliberately rather than
silently skipping the alert.

GitHub's native scheduled-workflow notification goes only to the person who
last changed the cron syntax, so the webhook is the shared team alert path.
GitHub does not emit a failure event when a scheduled run is skipped entirely;
the external health and data-freshness probe covers that case.

## Required repository configuration

| Name | Where | Purpose |
|---|---|---|
| `ALERT_WEBHOOK_URL` | GitHub Actions secrets and the monitor Worker secret | Shared Slack/Teams/Discord/Telegram/generic alert destination |
| `APP_BASE_URL` | Optional GitHub Actions repository variable | Overrides the production origin for the external probe |

No secret values are stored in this repository.

## Verification

```bash
node --test tests/health.test.mjs tests/monitoring.test.mjs
node tools/check-js-syntax.mjs
MONITOR_BASE_URL=http://127.0.0.1:8801 node tools/monitor.mjs
npx wrangler deploy --dry-run --config monitoring/wrangler.toml
```
