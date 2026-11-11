# Email delivery

The previous provider-specific sender has been removed. Email reminders now use one provider-neutral webhook:

- `EMAIL_WEBHOOK_URL` — an HTTPS endpoint you control.
- `EMAIL_WEBHOOK_SECRET` — a long random value sent in the request body.
- `EMAIL_FROM` — optional sender hint; the webhook can ignore it.

The app sends this JSON body:

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

The endpoint must return a 2xx response after handing the message to its email
provider. Until both variables are set, email delivery is disabled and the app
reports email as not configured.

## No-new-account option: existing Gmail + Google Apps Script

This uses a Google account you already have, not a new email-service signup.
It is suitable for low-volume personal reminders, not bulk or marketing mail.

1. Open <https://script.google.com> and create a new project.
2. Paste a script like this, replacing the secret with a long random value:

```javascript
const SECRET = 'replace-with-a-long-random-secret';

function doPost(e) {
  const data = JSON.parse((e.postData && e.postData.contents) || '{}');
  if (data.secret !== SECRET) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false }));
  }

  const to = String(data.to || '').trim();
  const subject = String(data.subject || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || !subject) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false }));
  }

  MailApp.sendEmail({
    to: to,
    subject: subject,
    htmlBody: String(data.html || data.text || ''),
    body: String(data.text || ''),
    name: 'Irish Visa Tracker'
  });

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

3. Deploy it as **Web app**, execute as **Me**, and allow **Anyone** to access it.
4. Copy the deployment URL into `EMAIL_WEBHOOK_URL`, and put the same secret in
   `EMAIL_WEBHOOK_SECRET` in the Cloudflare Pages environment.
5. Test one reminder from the app before relying on it.

Apps Script redirects POST requests before running `doPost`. Cloudflare `fetch`
follows redirects by default, but verify the endpoint returns a successful
response. Consumer Gmail accounts have a low daily recipient quota (about 100
recipients/day; Workspace accounts are higher), and Gmail deliverability is not
the same as a dedicated transactional email service.

## Other options

- **Cloudflare Email Service** uses the Cloudflare account already hosting this
  site, but sending to arbitrary recipients requires the Workers Paid plan and
  an onboarded sending domain. Put a small Worker in front of it and use that
  Worker URL as `EMAIL_WEBHOOK_URL`.
- **Any transactional provider** can be used behind the same webhook. Those
  providers still require creating an account and verifying a sender domain.
- **Browser push** remains available with no email provider at all.
