# Irish Visa Tracker — Current Completion Record

Updated 2026-11-11 (UTC). This is the working-tree record before the final commit
and Pages deployment; any live deployment verification is appended after the
deploy.

## Verified data

| Item | Count |
|---|---:|
| Latest official report rows across six offices | 61,005 |
| Dated rows across all official archive files | 65,773 |
| New Delhi official snapshot | 42,472 decisions (2026-11-10) |
| New Delhi daily tracker | 42,522 rows = 42,472 decisions + 50 dated placeholders |
| Beijing latest snapshot | 13,724 decisions (2026-11-01) |
| Abu Dhabi archive | 2,386 rows / 9 dated reports |
| Abuja archive | 2,229 rows / 26 dated reports |
| Ankara archive | 627 rows / 4 dated reports |
| Dublin latest snapshot | 4,335 decisions (2026-11-10) |
| ML training data | 35,839 synthetic records |

All six office files are `official`; every application number is unique in each
archive. The verified archive checksum run covers **65,773 decisions**.

The Abuja **31 August–6 September 2026** report remains unavailable from official
sources. No rows were inferred for that week.

## Verification

| Check | Result |
|---|---|
| Node product/domain suite (`tests/*.test.mjs`) | **82 passed, 0 failed** |
| New email bridge tests | **3 passed** |
| Embassy checksum verifier | **passed, 6 files / 65,773 decisions** |
| Ankara verifier | **passed** |
| Python suites | **98 passed, 6 subtests passed** |
| Playwright Chromium suite | **14 passed** (120s timeout) |
| Build | `npm run build` stages `.pages-dist` |
| Pages deployment | pending release step |
| Post-deploy smoke | pending release step |

## Shipped product surfaces

- Six-office official decision archives and the New Delhi daily tracker.
- Account registration/login, private watchlists, sessions and profile settings.
- In-app notification inbox and decision alert runner.
- Browser push via VAPID.
- Provider-neutral email with the new secret-protected Resend bridge.
- Monthly report, email digest and double opt-in/unsubscribe.
- Private workspace: analytics, document checklist, fees, OCR scan, scheduled
  exports and private export tokens.
- Advanced search, community timelines, referral/org models and admin endpoints.
- ML predictor served from the committed XGBoost tree ensemble; training data,
  scripts and artifacts are now tracked.
- Accessibility and agent-facing Markdown surfaces.

## External services

Configured: `APP_BASE_URL`, `SCRAPER_CRON_SECRET`, VAPID keys, existing
`RESEND_API_KEY`, plus the new email bridge URL/secret and `EMAIL_FROM`.

Still blocked on account-specific values: **Sentry DSN/project**, **Twilio SMS
and WhatsApp**, **OCR.space key**, and **OIDC provider/client credentials**. The
application reports these as disabled instead of simulating success. See
`docs/services.md`.

## Schedulers and ML

- Decision alerts: hourly GitHub Actions workflow.
- Monthly digest: first of the month.
- Scheduled exports: daily after the 07:00 UTC due time.
- All three require the repository `SCRAPER_CRON_SECRET` Actions secret.
- Monthly ML retraining now regenerates both `models/` and the served
  `functions/api/model-trees.js`; the training scripts, synthetic data and model
  artifacts are committed, so the workflow is no longer a dangling reference.

## Mobile decision

Native iOS/Android is **deferred**. The PWA is the supported mobile product; the
native plan remains a future option only. This avoids maintaining a second
client, a second auth surface and duplicate notification infrastructure without
a current product need.

## Remaining real gaps

1. Four external service groups need credentials/accounts listed above.
2. GitHub scheduled workflows only become active after the commit is pushed to
   the repository and the Actions secret is set.
3. The Abuja missing week cannot be reconstructed without the official report.
4. Native mobile is deliberately out of scope.
