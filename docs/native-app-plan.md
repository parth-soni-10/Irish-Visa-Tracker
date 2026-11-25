# Native App Plan — Irish Visa Tracker

**Verdict:** build a focused native companion app, not a port of the website. V1 is **Android-only**, built with **Expo + React Native**, and has **no accounts**: watchlists and preferences stay on the device, exactly like the website. The PWA remains the full product. V1 does four jobs: check a decision, watch up to 10 applications locally, receive native push alerts, and show office freshness offline.

**Effort:** ~34–36 focused person-days for Android v1 (counting a person-day as 6 productive hours). That is **7–8 weeks at 30 hours/week**, or **10–12 weeks at 15–20 hours/week**. The first installable Android development build lands in week 2–3; a feature-complete beta around week 9; Android production around week 13. iOS is a separately gated post-launch phase.

---

## 1. What we have been sidelining

The repo defers native mobile in `README.md`, `GAP_ANALYSIS.md`, `CLAUDE.md`, and `COMPLETION_REPORT.md`. The only native plan is section 6 of `IMPLEMENTATION_PLAN.md`, and it cannot be executed as written:

| Old plan assumption | Current reality |
|---|---|
| React/Next web app in a monorepo | Plain HTML/CSS/JS; no React components to share |
| Accounts, sessions, saved searches | Removed by product decision; watchlist is browser-local and anonymous |
| WatermelonDB + Zustand + shared UI package | Overkill for four screens; `expo-sqlite` + React state is enough |
| 13 weeks with 2.75 FTE | Solo project; the scope has to be smaller |
| Expo managed → bare workflow | Stay managed; eject only if a native module forces it |
| Placeholder Apple IDs and team IDs | Real developer accounts and bundle IDs are prerequisites |

The current app already has the hard parts: a search API, six-office data, a compact offline index, a local watchlist format, and D1-backed alert delivery. The native app should reuse those, not duplicate them.

---

## 2. V1 scope

### In

- Search by application number across all six offices.
- Result card: decision, published date, office, source link, freshness/provenance.
- Local watchlist of up to 10 applications, with nickname support.
- No accounts: the same anonymous, device-local model as the website.
- Native push per watched application, with deep link to the result.
- Offline exact/prefix lookup from a downloaded decision index.
- Office status: last successful publication, stale warnings, official source link.
- Import/export the same watchlist JSON the website already uses.
- Clear “unofficial” labelling and a link to the full website.

### Out of V1

- Accounts, sign-in, server-side watchlists, saved searches.
- iOS/App Store release (post-launch, separately gated).
- Full parity with charts, monthly reports, admin, corrections, community timelines.
- Telegram bot management inside the app (link out instead).
- Ads, in-app purchases, ATT/tracking, third-party analytics SDKs.
- Home-screen widgets, Live Activities, iPad layout, EAS Update.

Those last items are V1.1 candidates, not launch blockers.

---

## 3. Stack decision

| Option | Fit | Why |
|---|---|---|
| **Expo + React Native** | **Recommended** | Real native UI, `expo-notifications` + Expo Push Service, EAS builds from Windows (including iOS), one codebase |
| Capacitor shell | Fastest reuse | A WebView wrapper risks App Store guideline 4.2; native push needs FCM/APNs plumbing; harder to argue “native value” |
| PWA only | Zero extra cost | No store presence; keep it as the full product, not the app strategy |
| Flutter | Poor fit | No code or design reuse; new language and toolchain for a solo maintainer |

**Decision locked:** Android v1 uses the Expo managed workflow, TypeScript, Expo Router, `expo-sqlite`, and `expo-notifications`. There is no account system and no server-side watchlist. Do not introduce a monorepo, Redux/Zustand, WatermelonDB, or a shared UI package. iOS reuses the same codebase later; it is not part of the Android v1 milestone.

Expo Push Service is the key simplification: the app gets an Expo push token; the Worker posts to `https://exp.host/--/api/v2/push/send`; Expo delivers through APNs and FCM. The Worker never needs Apple or Firebase credentials. EAS holds the build credentials.

---

## 4. Architecture

```text
┌──────────────────────────────────────────────┐
│ Expo app (Android first, iOS second)         │
│  • Expo Router tabs                          │
│  • expo-sqlite: watchlist + cached decisions │
│  • expo-notifications → ExpoPushToken        │
│  • API client → production Pages origin      │
│  • deep link irishvisatracker://result?...   │
└──────────────────────┬───────────────────────┘
                       │ HTTPS
┌──────────────────────▼───────────────────────┐
│ Cloudflare Pages Functions (existing)        │
│  POST /api/search                 (existing) │
│  GET  /data/search_fallback.json  (existing) │
│  GET  /data/freshness.json        (existing) │
│  POST /api/push/native/register   (new)      │
│  POST /api/push/native/unregister (new)      │
│  POST /api/alerts/run             (extended) │
└──────────────────────┬───────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │ D1                          │
        │  native_push_tokens (new)   │
        │  push_subscriptions         │
        │  rate_limits, events        │
        └──────────────┬──────────────┘
                       │ hourly GitHub Action
                       ▼
              Expo Push API → APNs / FCM
```

No new server, no new host, no accounts. The app is another client of the existing public API.

---

## 5. Backend work

### 5.1 D1 table

Add to `schema.sql` for reference and create lazily from `functions/native-push.js`, following the existing `ensurePushSchema` pattern.

```sql
CREATE TABLE IF NOT EXISTS native_push_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  installation_id TEXT NOT NULL,
  application_number TEXT NOT NULL DEFAULT '',
  embassy_slug TEXT NOT NULL DEFAULT '',
  last_alert_sent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_native_push_identity
  ON native_push_tokens(token, application_number, embassy_slug);

CREATE INDEX IF NOT EXISTS idx_native_push_application
  ON native_push_tokens(application_number, embassy_slug);
```

One row per token per watched application. Empty strings, not `NULL`, keep the unique index reliable.

### 5.2 Endpoints

Add a `NATIVE_PUSH_PATHS` set in `functions/_router.js`; keep the handlers in `functions/native-push.js` and the sender in the same module.

```http
POST /api/push/native/register
Content-Type: application/json

{
  "token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "android",
  "installation_id": "uuid-v4",
  "application_number": "12345678",
  "embassy": "new-delhi"
}
```

Returns `200 { "ok": true }`; `400` for an invalid token/platform/number/office; `429` when the tighter native-push bucket is exhausted.

```http
POST /api/push/native/unregister
Content-Type: application/json

{
  "token": "ExponentPushToken[...]",
  "installation_id": "uuid-v4",
  "application_number": "12345678",
  "embassy": "new-delhi"
}
```

Also accept `{ "installation_id": "...", "all": true }` so “clear all” and token rotation can remove every row for that installation.

Validation rules:

- Token: `/^(Exponent|Expo)PushToken\[[^\]]{10,200}\]$/`.
- Platform: `ios` or `android`.
- Installation ID: UUID v4 or 16–64 safe characters.
- Application number: 6–12 digits, reusing the existing office set.
- Office: one of `new-delhi`, `beijing`, `dublin`, `abu-dhabi`, `abuja`, `ankara`.
- Rate limit: separate `native-push` bucket, 30 requests/minute/IP, on top of the existing API limiter.
- Log only a token suffix, never the full token.

### 5.3 Expo sender

`functions/native-push.js` exports:

- `ensureNativePushSchema(env)`
- `registerNativeToken(env, input)`
- `unregisterNativeToken(env, input)`
- `sendNativeDecisionPush(env, applicationNumber, decision, embassy)`

The sender queries matching rows, batches up to 100 messages per Expo request, and posts:

```json
[{
  "to": "ExponentPushToken[...]",
  "title": "Visa decision published",
  "body": "A watched application has a new decision.",
  "sound": "default",
  "priority": "high",
  "channelId": "decisions",
  "data": {
    "url": "irishvisatracker://result?number=12345678&office=new-delhi"
  }
}]
```

Headers: `Accept: application/json`, `Content-Type: application/json`, and `Authorization: Bearer ${EXPO_ACCESS_TOKEN}` when the secret is set. Add `EXPO_ACCESS_TOKEN` to `docs/services.md` and the Pages secrets list; it is server-side only.

Handle tickets:

- `status: "ok"` → update `last_alert_sent` for that token row.
- `details.error === "DeviceNotRegistered"` → delete the row.
- Other errors → leave the row, log a bounded message, count a failure.
- Prune rows untouched for 180 days during the alert run.

V1 handles immediate ticket errors. A daily receipt check (`/--/api/v2/push/getReceipts`) is a V1.1 hardening item; until then, invalid tokens are pruned on the next send failure.

### 5.4 Alert runner

Extend `runPushAlerts` in `functions/alerts-run.js` with a native branch that reuses the existing `findDecision` and `shouldSend` helpers. Keep web push and native push independent so one failing channel does not suppress the other.

Add counters to the `/api/alerts/run` response:

```json
"native_push": { "checked": 0, "matched": 0, "sent": 0, "skipped": 0, "failed": 0, "pruned": 0 }
```

Update existing alert-runner tests for the new shape. Add `tests/native-push.test.mjs` covering registration, validation, upsert, unregister-all, ticket success, `DeviceNotRegistered`, chunking, and `last_alert_sent` idempotency.

### 5.5 Backend acceptance

- `node --test tests/*.test.mjs` passes, including the new suite.
- A real development-build Android device receives a test push sent through the Worker path. Use Expo's notification tool for the first device check, then a local `tools/test-native-push.mjs` (token read from the environment) to exercise the same sender; do not add a public test endpoint.
- Registering the same token/app twice does not create a duplicate row.
- Removing an app stops later sends; an invalid token is pruned.
- `/api/alerts/run` in dry-run mode reports native counters without sending.

---

## 6. Mobile app structure

```text
mobile/
├── app/
│   ├── _layout.tsx                 # theme, notification handler, deep links
│   ├── (tabs)/
│   │   ├── _layout.tsx             # Check / Saved / Alerts / About
│   │   ├── index.tsx               # search + latest decisions
│   │   ├── saved.tsx               # watchlist
│   │   ├── alerts.tsx              # push status + preferences
│   │   └── about.tsx               # status, provenance, privacy, version
│   └── result/[number].tsx         # decision detail
├── src/
│   ├── api.ts                      # typed client, timeouts, error mapping
│   ├── db.ts                       # expo-sqlite schema + migrations
│   ├── search.ts                   # online API + offline fallback lookup
│   ├── watchlist.ts                # max 10, import/export, nicknames
│   ├── push.ts                     # permission, token, register/unregister
│   ├── notifications.ts            # handler, tap routing, channel setup
│   ├── theme.ts                    # existing green/red/amber semantics
│   └── types.ts
├── assets/                         # icon, splash, store screenshots
├── app.config.ts
├── eas.json
└── package.json
```

### Data flow

1. On first launch, download `data/search_fallback.json` (about 0.6 MB raw; the file is columnar - `version: 2`, a shared `dates` table, and one `{number_deltas, date_index, approved}` series per office - so decode it to rows before inserting) and `data/freshness.json`.
2. Decode each office series to rows `[office, number, date, decision]` (accumulate `number_deltas`, resolve `date_index` against `dates`, map `approved` 1/0 to Approved/Refused) and insert them into SQLite in one transaction.
3. On later launches, compare `data_manifest.json` / `generated_at`; only re-download when it changes.
4. Online search uses `POST /api/search` with the same payload as the website:
   ```json
   { "query": "12345678", "mode": "fuzzy", "filters": { "embassy": "new-delhi" }, "limit": 100, "sort": "date_desc" }
   ```
5. If the API fails or the device is offline, search the local index. Exact number first, then prefix; fuzzy only online.
6. Show a stale banner with the cached timestamp and a retry action.

### Watchlist

- SQLite table keyed by `(application_number, embassy)`, max 10.
- Import/export the existing web shape:
  ```json
  { "version": 1, "exported_at": "...", "watchlist": [{ "number": "12345678", "office": "new-delhi", "nickname": "" }] }
  ```
- On add: save locally, then register the push token if permission is granted.
- On remove: unregister that token/app, then delete locally.
- On launch: refresh the Expo token. If it rotated, unregister the old installation (`installation_id`, `all: true`) and re-register every watched app with the new token.
- If permission is denied, keep the watchlist working and show “Enable notifications in Settings” rather than a dead end.

### Notifications

- Create an Android channel `decisions` with high importance.
- Explain the value before the OS permission prompt; do not prompt on first launch.
- Foreground notifications show an in-app banner; tapping opens `result/[number]`.
- Cold start reads `getLastNotificationResponseAsync()` and routes to the result.
- Default notification body should not reveal the outcome on the lock screen; add a “Show outcome in notification” toggle in Alerts. This is a small privacy win for a sensitive document status.
- Test push delivery with a development build, not Expo Go (remote push is not supported there).

### Website compatibility

- Keep the app’s API calls absolute (`EXPO_PUBLIC_API_BASE=https://irishvisaupdatetracker.pages.dev`). React Native’s networking is not a browser, so no CORS changes are needed.
- For local device testing, point the app at the LAN address of `npx wrangler pages dev .` (Android emulator: `http://10.0.2.2:8788`).
- Link “Open full website” for reports, guides, monthly reports, and corrections.

---

## 7. Milestones

| # | Milestone | Effort | Deliverable | Exit criteria |
|---|---|---:|---|---|
| M0 | Accounts and foundation | 2–3 days | Expo project, EAS profiles, bundle IDs, icons, development build | App opens on a physical Android device |
| M1 | Native push backend | 5 days | D1 table, register/unregister routes, Expo sender, alert-runner branch, tests | Real device receives a test push; suite passes |
| M2 | Lookup and data | 8 days | Tabs, API client, search, result screen, offline index, freshness | Search works online and offline; result matches website |
| M3 | Watchlist and alerts | 7 days | SQLite watchlist, max 10, permission flow, token registration, deep links, import/export | Save 10; 11th blocked; push opens the right result; remove stops alerts |
| M4 | Offline and polish | 4 days | Stale/empty/error states, status screen, dark mode, accessibility, safe areas | Airplane-mode search and save work; no P1 issues |
| M5 | Android beta | 5 days + test window | AAB, Play Console listing, closed testing, feedback fixes | 12 testers / 14 days (current rule for new personal accounts); no P1 crashes |
| M6 | Android launch | 2 days + monitoring | Staged rollout, website store link, dashboards | Play Store live; 7 days of clean monitoring |
| M7 | iOS (post-v1) | 6 days + review | Deferred; same codebase, TestFlight, App Store listing | Only after the Android 30-day retention gate |

**Total:** ~34–36 person-days for Android v1, excluding the 14-day closed-test window. The iOS phase adds ~6 days later.

### Suggested calendar (part-time)

| Week | Work |
|---|---|
| 1 | M0 accounts, project, first development build |
| 2–3 | M1 native push backend |
| 4–6 | M2 lookup, result, offline index |
| 7–8 | M3 watchlist, push, deep links |
| 9 | M4 polish; feature-complete beta |
| 10 | M5 Android build; start closed test |
| 11–12 | Closed-test window and fixes |
| 13 | Android production |
| Post-launch | iOS phase, only after the Android retention gate |

At 30+ productive hours/week, compress Android v1 to roughly 6–7 weeks.

---

## 8. Cost

| Item | Cost | Notes |
|---|---:|---|
| Google Play developer account | $25 one-time | Required for Android v1 |
| Expo EAS | $0–99/month | Free tier is enough to start; pay only if build queues block you |
| Cloudflare Pages / D1 / Expo Push | ~$0 incremental | Existing project; token rows are tiny |
| Apple Developer Program | $99/year | Only when the iOS phase starts |
| **Minimum Android first year** | **~$25** | Plus optional EAS priority; iOS adds $99/year |

No new database or server. Expo Push Service is the only new external dependency, and it is covered by the Expo plan.

---

## 9. Store readiness

Android v1 ships on Google Play only. The Apple checklist below is retained for the later iOS phase.

### Both stores

- Display name: **Irish Visa Tracker**; subtitle/description must say **unofficial**.
- No Government of Ireland, embassy, or VFS logos; use the project’s own icon and colours.
- No accounts, so no account-deletion flow is required.
- Privacy policy URL: the existing `/privacy` page, updated with a native section covering the push token, platform, installation ID, application number, office, and last alert date.
- Support URL: existing `/contact` or `/about`.
- No ads, no IAP, no cross-app tracking, no ATT prompt.
- Category: Utilities / Travel (choose the closest; do not claim government services).

### Apple (post-v1 only)

- Bundle ID: `com.parthsoni.irishvisatracker` (or `ie.irishvisatracker.app`).
- App Store Connect SKU, privacy nutrition labels, age rating 4+.
- Explain encryption: HTTPS only; answer the export-compliance questions accordingly.
- Screenshots: 6.9" and 6.5" iPhone sizes; show native search, result, saved list, and notification.
- Review notes: no login; data is public; give a sample published application number and explain that any number can be searched.
- Position against guideline 4.2: native UI, offline database, native push, local watchlist, deep links — not a website wrapper.
- TestFlight internal build first; plan for one rejection cycle.

### Google

- Package: `com.parthsoni.irishvisatracker`.
- AAB with Play App Signing; current target API level required by Play.
- Data safety: device/other IDs (push token), app interactions if anonymous events are enabled; no location, contacts, financial info, or health data.
- Content rating questionnaire; no user-generated content in V1.
- Closed testing with 12 testers for 14 days if the account is a new personal account (confirm the current rule at signup). Start this early; it is the longest fixed wait.
- Screenshots, feature graphic, short/full description, privacy URL.

---

## 10. Testing and release gates

### Backend

- `node --test tests/*.test.mjs` — full suite, including the new native-push tests.
- Local Worker: `npx wrangler pages dev .`, then `curl` register/unregister and inspect D1 rows.
- Mocked Expo API in unit tests; one real device push through the deployed Worker path.
- Verify a `DeviceNotRegistered` ticket deletes the token and does not break the alert run.

### Mobile

- `npx tsc --noEmit`
- `npx expo lint`
- `npx expo export --platform android` (catches bundle/config errors)
- Maestro smoke flow: launch → search → open result → save → enable push → remove.
- Manual matrix: Android 10/13/15, iOS 17/18, small screen, large font, dark mode, offline, cold-start notification, token rotation, 10-item limit.

### Release gates

- No P1/P2 open bugs.
- Push delivery verified on a physical Android device (and a physical iPhone when the iOS phase starts).
- Offline search verified in airplane mode after one successful sync.
- Store listings and privacy policy reviewed.
- `/api/health`, alert run, and existing website tests still pass after the backend change.

---

## 11. Success metrics and stop rule

Instrument only anonymous, fixed-vocabulary events through the existing `/api/events` endpoint (no free text, no email, no IP stored):

- app open
- search completed
- result opened
- watchlist add/remove
- push permission granted/denied
- notification opened

Targets for the first 90 days:

| Metric | Target |
|---|---:|
| Install → first completed search | ≥ 60% |
| Search → watchlist save | ≥ 25% |
| Watchers → push opt-in | ≥ 50% |
| D30 retention | ≥ 15% |
| Crash-free sessions | ≥ 99.5% |
| Store rating | ≥ 4.3 |

**Stop rule:** if after 90 days D30 retention is below 8% and installs are below 500, stop adding native features. Keep the app on maintenance and put effort back into the PWA. This prevents a second client from becoming permanent overhead without evidence.

---

## 12. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Apple rejects as a website wrapper (4.2) | Medium | Native UI, offline data, push, watchlist, deep links; no WebView |
| Push delivery is unreliable | Medium | Expo receipts, prune invalid tokens, in-app last-checked state, Telegram fallback |
| Data looks real-time when it is not | Medium | Reuse the website’s freshness/provenance language; stale banner; source links |
| Scope creep into full parity | High | V1 is lookup + watchlist + push + status; link out for everything else |
| Google’s 14-day closed test delays launch | High | Start the test as soon as the first AAB exists, in parallel with iOS work |
| Solo maintenance burden | Medium | One codebase, managed Expo, no monorepo, contract tests, no custom native modules |
| Token abuse or spam registrations | Low | Format validation, tighter rate limit, Expo rejects invalid tokens, prune on failure |
| Sensitive outcome on lock screen | Medium | Default generic notification body; opt-in “show outcome” setting |
| Offline index download fails on first launch | Low | Explicit empty state with retry; never show invented data |
| Store account approval delays | Medium | Create Google Play account in week 1; Apple before M6 |

---

## 13. First 10 tasks

1. Confirm the name, bundle IDs, and Android-first sequence.
2. Create the Expo account/project and `mobile/` app; commit `app.config.ts` and `eas.json`.
3. Create the Google Play developer account now (approval can take days).
4. Add `native_push_tokens` to `schema.sql` and `ensureNativePushSchema` to `functions/native-push.js`.
5. Add the register/unregister routes, validation, and the tighter rate-limit bucket.
6. Add the Expo sender and the native branch in `functions/alerts-run.js`.
7. Write `tests/native-push.test.mjs`; run the full Node suite.
8. Deploy the backend and register a token from a development build; send one real test push.
9. Build the app shell: tabs, API client, search, result screen.
10. Add SQLite watchlist and push registration; test on a physical Android device.

---

## 14. Decisions locked

- **Platform:** Android v1 only; iOS is a post-launch phase.
- **Stack:** Expo + React Native (managed), TypeScript, Expo Router, `expo-sqlite`, `expo-notifications`.
- **Accounts:** none. Watchlists, nicknames and preferences are device-local, matching the website.
- **Assumed defaults:** “Irish Visa Tracker” / `com.parthsoni.irishvisatracker`; generic lock-screen text with an in-app opt-in to show the outcome.

M0 and M1 can start immediately. M1 ships independently and is the highest-risk integration to de-risk first.
