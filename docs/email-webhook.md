# Email delivery

Email uses a provider-neutral webhook so the application never depends on a
particular mail vendor:

- `EMAIL_WEBHOOK_URL` — the HTTPS endpoint that accepts a message.
- `EMAIL_WEBHOOK_SECRET` — a long random value sent in the JSON body.
- `EMAIL_FROM` — optional sender hint; the receiver can pin its own sender.

The app sends:

```json
{
  "secret": "...",
  "to": "applicant@example.com",
  "from": "alerts@example.com",
  "subject": "Visa Approved: 12345678",
  "html": "<p>...</p>",
  "text": "..."
}
```

The receiver must return a 2xx response after handing the message to its mail
provider. Until the URL and secret are configured, email delivery is disabled
and the app reports it as unavailable.

## Deployed bridge

This deployment uses its own authenticated bridge:

```
POST https://irishvisaupdatetracker.pages.dev/api/email/send
```

`functions/email-webhook.js` validates `EMAIL_WEBHOOK_SECRET`, pins the sender to
`EMAIL_FROM` when set, and calls Resend with the server-side `RESEND_API_KEY`.
The worker URL is therefore the production `EMAIL_WEBHOOK_URL`; the browser
never receives the webhook or Resend secret.

The bridge is intentionally outside the public per-IP API limiter because a
monthly digest legitimately sends more than the normal per-minute limit. The
high-entropy webhook secret is its authentication boundary.

`onboarding@resend.dev` only delivers to the Resend account owner. To send to
arbitrary recipients, verify a sending domain in Resend and update `EMAIL_FROM`.

The production bridge was exercised on 2026-11-11: missing/wrong secrets returned
401, invalid recipients returned 400, and a real message returned 200.

## Alternative receivers

The same contract works with Cloudflare Email Service (paid plan plus an
onboarded domain), a transactional provider such as Resend or Postmark behind a
small Worker, or a personal Google Apps Script endpoint. Browser push remains
available with no email provider at all.

## Pages secret propagation

Pages binds secrets when a deployment is uploaded. After adding or changing an
email variable, redeploy the Functions bundle before testing; an existing
deployment does not start seeing a newly added secret automatically.
