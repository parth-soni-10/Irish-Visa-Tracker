# Irish Visa Tracker — Current Gap Register

Updated 2026-11-12. The earlier “accounts/API/notifications missing” analysis is
obsolete; those surfaces are implemented. This file now records only gaps that
still exist after the current tree and release checks.

## Closed gaps

- Accounts, sessions, password change and profile settings: implemented.
  Account email verification and password reset were removed by product
  decision; subscriber alert verification remains.
- Saved watchlists, multiple applications, cross-device sync, private exports
  and export tokens: implemented.
- Account-scoped saved searches: implemented with owner-scoped list/get/delete.
- In-app notifications, alert runner and browser push: implemented.
- SMS/WhatsApp delivery was removed by product decision; no channel code,
  credentials or UI remain. Existing production rows were left untouched.
- Referral acceptance and one-credit reward accounting: implemented.
- Monthly report, email digest and double opt-in: implemented.
- Scheduled export jobs and delivery endpoint: implemented.
- Search, fuzzy/nearest filters, sorting, pagination, checklist, fee estimator,
  document field extraction and workspace: implemented.
- Archived and latest report row counts are exposed in the data manifest and
  status page.
- ML training artifacts and Worker tree-ensemble export: implemented and
  tracked.
- Accessibility and agent-facing Markdown surfaces: implemented and tested.
- First-run activation: the New Delhi dashboard now has prominent email and
  Telegram CTAs, a persisted three-step checklist, and privacy-light conversion
  events at `/api/events`. The funnel does not store email, IP, cookie or free
  text; delivery still ends at the existing double opt-in or Telegram `/start`.
- Per-isolate API/auth limits: replaced by the D1 `rate_limits` fixed-window
  counter, with an in-memory fallback only when D1 or the table is unavailable.
- Admin API coverage: metrics, bearer-token rejection, named-token hashing,
  listing and immediate revocation are covered by `tests/admin-api.test.mjs`.
- Inline dashboard assets and CSP: HTML now loads `/scripts/*.js` and
  `/styles/*.css`; the CSP forbids inline executable scripts and `<style>`
  elements. Inline style attributes remain only for generated chart/table
  geometry.
- Dead-export and served-JavaScript syntax gates run in CI. The base schema,
  portal helpers and user watchlist/push routes are separate modules; the three
  original API files remain large but no longer own those concerns.
- Error monitoring: Sentry was removed. Pages Functions emit structured JSON
  request/error logs and expose a D1+asset readiness endpoint; a separate
  cron-only Worker provides Workers Logs/Logpush eligibility for persisted
  uptime checks; an external GitHub Actions probe checks health and data
  freshness; failed scheduled runs forward to the shared alert webhook.
- Schedulers for decisions, digest and exports: workflows added. The release
  commit is on `origin/main`, and the repository `SCRAPER_CRON_SECRET` Actions
  secret is configured.

## Open operational gaps

| Gap | Impact | Resolution |
|---|---|---|
| Resend key was exposed in an earlier terminal session | The key should be treated as compromised | Rotate it in Resend, update the Pages `RESEND_API_KEY` secret, and redeploy |
| Monitoring Worker and Logpush job are not deployed | Persisted Workers Logs and Logpush export stay inactive until the Worker is deployed and an account-level Logpush job is created | Run the commands in `docs/monitoring.md`; Logpush needs the Workers Paid plan and a destination |
| VFS Ireland-India slots are behind VFS sign-in | The public checker can report page state but cannot monitor or guarantee slots | Use the official VFS sign-in; integrate a supported VFS API/partner feed before promising slot alerts |

## Product decision

Native iOS/Android apps are deferred. The installable PWA is the mobile product;
it already covers offline shell, account sync, push and alerts. Revisit native
only after a measured mobile acquisition/retention need justifies a second
client and release pipeline.

Structured Pages Function logs, the readiness endpoint, the separate Workers
Logs/Logpush monitor and the admin error endpoint are the supported server error
surfaces.
