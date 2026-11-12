/**
 * Provider-neutral email delivery.
 *
 * The app no longer contains a vendor-specific email client. Configure
 * EMAIL_WEBHOOK_URL and EMAIL_WEBHOOK_SECRET with any HTTPS endpoint that
 * accepts the JSON contract below and delivers the message with its own email
 * provider. See docs/email-webhook.md for a no-new-account Gmail option.
 *
 * Request:
 *   { secret, to, from, subject, html, text }
 * Response:
 *   any 2xx response; JSON is returned when available.
 */

export function isEmailConfigured(env) {
  return Boolean(env && env.EMAIL_WEBHOOK_URL && env.EMAIL_WEBHOOK_SECRET);
}

export async function sendEmail(env, { to, subject, html, text, from }) {
  if (!isEmailConfigured(env)) throw new Error('Email webhook is not configured');
  if (!to || !subject) throw new Error('Email recipient and subject are required');

  const response = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.EMAIL_WEBHOOK_SECRET,
      to: String(to),
      from: from || env.EMAIL_FROM || '',
      subject: String(subject),
      html: String(html || ''),
      text: String(text || ''),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('Email webhook failed: ' + response.status + (detail ? ' ' + detail.slice(0, 300) : ''));
  }

  if (String(response.headers.get('Content-Type') || '').includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return { ok: true };
    }
  }
  return { ok: true };
}
