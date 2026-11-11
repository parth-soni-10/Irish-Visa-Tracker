# Irish Visa Tracker — Current Gap Register

Updated 2026-11-11. The earlier “accounts/API/notifications missing” analysis is
obsolete; those surfaces are implemented. This file now records only gaps that
still exist after the current tree and release checks.

## Closed gaps

- Accounts, sessions, password change and profile settings: implemented.
  Account email verification and password reset were removed by product
  decision; subscriber alert verification remains.
- Saved watchlists, multiple applications, cross-device sync, private exports
  and export tokens: implemented.
- Account-scoped saved searches: implemented with owner-scoped list/get/delete.
- In-app notifications, alert runner, browser push and Twilio channel code:
  implemented.
- Referral acceptance and one-credit reward accounting: implemented.
- Monthly report, email digest and double opt-in: implemented.
- Scheduled export jobs and delivery endpoint: implemented.
- Search, fuzzy/nearest filters, sorting, pagination, checklist, fee estimator,
  OCR scan and workspace: implemented.
- Archived and latest report row counts are exposed in the data manifest and
  status page.
- ML training artifacts and Worker tree-ensemble export: implemented and
  tracked.
- Accessibility and agent-facing Markdown surfaces: implemented and tested.
- Schedulers for decisions, digest and exports: workflows added.

## Open operational gaps

| Gap | Impact | Resolution |
|---|---|---|
| Sentry project/DSN absent | Server/browser exceptions are not remotely tracked | Create a Sentry project and set `SENTRY_DSN` |
| Twilio credentials absent | SMS/WhatsApp alerts are disabled | Set the four Twilio variables and test one recipient |
| OCR.space key absent | Uploaded-document OCR is disabled | Set `OCR_SPACE_API_KEY` |
| OIDC credentials absent | SSO is disabled; password auth still works | Register an OIDC client and set the three variables |
| GitHub Actions secret not yet set | Scheduled digest/exports/alerts skip safely | Add `SCRAPER_CRON_SECRET` to the repository |
| Commit not pushed | Schedules and the repository deployment workflow are not live | Push the release commit after the local deploy is verified |
| Resend key was exposed in an earlier terminal session | The key should be treated as compromised | Rotate it in Resend, update the Pages `RESEND_API_KEY` secret, and redeploy |
| Abuja 31 Aug–6 Sep 2026 PDF unavailable | One historical week has no rows | Ingest only if the official PDF is recovered |

## Product decision

Native iOS/Android apps are deferred. The installable PWA is the mobile product;
it already covers offline shell, account sync, push and alerts. Revisit native
only after a measured mobile acquisition/retention need justifies a second
client and release pipeline.
