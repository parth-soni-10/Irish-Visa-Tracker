# Irish Visa Tracker — Current Completion Record

Updated 2026-11-12 (UTC). The current repository HEAD is `d2401ab`, matching
`origin/main`. Release commit `54a0598` was verified locally and deployed to
Cloudflare Pages production; this record includes those live post-deploy checks.

## Verified data

| Item | Count |
|---|---:|
| Latest official report rows across six offices | 61,154 |
| Dated rows across all official archive files | 65,977 |
| New Delhi official snapshot | 42,621 decisions (2026-11-11) |
| New Delhi daily tracker | 42,670 rows = 42,621 decisions + 49 dated placeholders |
| Beijing latest snapshot | 13,724 decisions (2026-11-01) |
| Abu Dhabi archive | 2,386 rows / 9 dated reports |
| Abuja archive | 2,284 rows / 27 dated reports |
| Ankara archive | 627 rows / 4 dated reports |
| Dublin latest snapshot | 4,335 decisions (2026-11-12) |
| ML training data | 35,839 synthetic records |

All six office files are `official`; every application number is unique in each
archive. The verified archive checksum run covers **65,977 decisions**.

The Abuja **31 August–6 September 2026** report is present in the archive
(57 decisions), sourced from the office's own
`ApplicationDecisionReport_30.08__06.09.pdf`. No rows were inferred.

## Verification

| Check | Result |
|---|---|
| Node product/domain suite (`tests/*.test.mjs`) | **127 passed, 0 failed** |
| Embassy checksum verifier | **passed, 6 files / 65,977 decisions** |
| Ankara verifier | **passed** |
| Python suites | **98 passed, 6 subtests passed** |
| Playwright Chromium suite | **19 passed** (11 + 8 clean-server runs; combined run hit a Windows worker crash) |
| Build | passed; 78 files staged |
| Pages deployment | **Production** on `main`; latest `712d1e8f` |
| Post-deploy smoke | **16/16 passed** |
| Live archive comparison | **8/8 files byte-identical** |
| Production email bridge | **HTTP 200** through Resend (verified in the prior release; path unchanged) |

## Local engineering pass (2026-11-12, not deployed)

The following changes are present in the working tree and verified locally, but
have not been committed or redeployed:

- **Activation path:** the New Delhi dashboard now opens with prominent email
  and Telegram CTAs, a persisted three-step first-run checklist (find, watch,
  choose a channel), and privacy-light `/api/events` conversion tracking. The
  event table accepts only a fixed vocabulary and stores no email, IP, cookie or
  free text.
- **Durable limits:** API and auth limits use the shared D1 `rate_limits`
  table; the in-memory limiter remains only as a degraded fallback when D1 is
  unavailable.
- **Admin coverage:** metrics, auth rejection, token hashing/listing and
  immediate revocation are covered by `tests/admin-api.test.mjs`; conversion
  storage and the limiter have their own tests.
- **Asset and CSP split:** `index.html` is now 338 lines; its JavaScript lives
  in `scripts/` and its CSS in `styles/`. All served HTML pages were extracted,
  the calendar component's runtime `<style>` injection moved to a static file,
  and the CSP no longer permits inline executable scripts or `<style>` elements.
  The only inline script left is the non-executable JSON-LD data block. Inline
  style attributes remain for generated chart/table geometry only.
- **Backend modularisation:** the base D1 schema moved to `db-schema.js`, portal
  response/session helpers to `portal-helpers.js`, and user watchlist/push routes
  to `user-watchlist.js` / `user-push.js`. The router and API files remain large
  but no longer own those concerns.
- **CI quality gates:** `check-js-syntax.mjs` parses served JavaScript,
  `check-dead-code.mjs` rejects unused named exports, and
  `check_html_scripts.py` rejects inline assets that the CSP would block.
- **Monitoring replacement:** Sentry remains removed. Pages Functions emit
  structured JSON request/error logs and `/api/health` now verifies D1 plus a
  real static asset. A separate cron-only Worker enables Workers
  Logs/Logpush, `uptime.yml` checks health and data freshness from outside
  Cloudflare, and `cron-failure-alerts.yml` forwards failed scheduled runs to
  `ALERT_WEBHOOK_URL`.

Local verification after these changes: **127 Node tests pass**, the HTML and
JavaScript syntax gates pass, the dead-export gate passes, and the build stages
**78 files**. Production still serves the prior deployment until these changes
are committed and redeployed.

## Live deployment

- Production: <https://irishvisaupdatetracker.pages.dev>
- Latest deployment: <https://712d1e8f.irishvisaupdatetracker.pages.dev>
- Environment: Production, branch `main`
- Deployment source: release commit `54a0598`
- Live archive counts: Abu Dhabi **2,386** rows (2,136 historical) and Abuja **2,284** rows (2,232 historical); the status page renders an archive total of **65,977**.

The live `data_manifest.json`, New Delhi tracker and all six office archives
matched the committed files byte for byte. The email bridge was exercised with
missing and wrong secrets (401), an invalid recipient (400), and a real Resend
delivery (200). The post-deploy smoke check covered the homepage, comparison,
status, workspace, manifest, service worker, icon, search, monthly
report, digest preview, auth and data manifest.

Pages binds secrets at deployment time. Email secrets were added and the
Functions bundle redeployed; an existing deployment does not automatically see
a newly added secret.

## Shipped product surfaces

- Six-office official decision archives and the New Delhi daily tracker.
- Account registration/login, private multiple-application watchlists, sessions and profile settings.
- Account-scoped saved searches, referral acceptance and one-credit reward accounting.
- Account email verification and password reset were removed by product decision; subscriber alert verification remains.
- In-app notification inbox and decision alert runner.
- Browser push via VAPID.
- Provider-neutral email with the new secret-protected Resend bridge.
- Monthly report, email digest and double opt-in/unsubscribe.
- Private workspace: analytics, document checklist, fees, document field
  extraction, scheduled exports and private export tokens.
- Advanced search, community timelines, referral/org models and admin endpoints.
- ML predictor served from the committed XGBoost tree ensemble; training data,
  scripts and artifacts are now tracked.
- Accessibility and agent-facing Markdown surfaces.
- First-run activation CTAs, checklist and conversion events (local working tree;
  see the engineering pass above).

## External services

Configured: `APP_BASE_URL`, `SCRAPER_CRON_SECRET`, VAPID keys, `RESEND_API_KEY`,
plus the email bridge URL/secret and `EMAIL_FROM`. The production email bridge
was verified with a real delivery on 2026-11-11.

SMS and WhatsApp delivery is not part of this release. The Twilio code, phone
number UI and channel endpoints were removed by product decision; email, browser
push and Telegram remain the supported delivery channels. Existing production
rows were left untouched.

Structured Pages Function logs, the `/api/health` readiness probe, the separate
Workers Logs/Logpush monitor and the admin error endpoint are the supported
server error surfaces. The monitoring Worker and its optional Logpush job still
need a deployment; the application changes remain local to this working tree.

## Schedulers and ML

- Decision alerts: hourly GitHub Actions workflow.
- Monthly digest: first of the month.
- Scheduled exports: daily after the 07:00 UTC due time.
- External uptime and data freshness: every 15 minutes from GitHub Actions.
- Failed scheduled runs: forwarded to `ALERT_WEBHOOK_URL`; without it the
  companion alert workflow fails visibly instead of skipping.
- The three delivery jobs require the repository `SCRAPER_CRON_SECRET` Actions
  secret.
- Monthly ML retraining now regenerates both `models/` and the served
  `functions/api/model-trees.js`; the training scripts, synthetic data and model
  artifacts are committed, so the workflow is no longer a dangling reference.

## Mobile decision

Native iOS/Android is **deferred**. The PWA is the supported mobile product; the
native plan remains a future option only. This avoids maintaining a second
client, a second auth surface and duplicate notification infrastructure without
a current product need.

## Remaining real gaps

1. VFS Ireland-India slots remain behind VFS sign-in; the public checker can
   report page state but cannot monitor or guarantee slots.
2. The Resend key exposed in an earlier terminal session should be rotated.
3. Native mobile is deliberately out of scope.
