/**
 * Failure-alert receiver for GitHub Actions.
 *
 * `cron-failure-alerts.yml` posts the provider-neutral `{ text }` payload that
 * `tools/alert-webhook.mjs` builds for generic endpoints. This route is that
 * endpoint: it authenticates the call with a dedicated token and emails the
 * alert through the same server-side Resend key the app already uses, so
 * failure alerts need no third-party webhook service.
 *
 * The token travels in the query string because the webhook payload contract is
 * fixed; request logs record only the pathname, never the query.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const MAX_BODY = 8 * 1024;
const MAX_TEXT = 4000;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** `Name <address>` is a valid sender; validate the address, keep the label. */
function addressOf(value) {
  const text = String(value || '').trim();
  return text.match(/<([^>]+)>$/)?.[1] || text;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

/** Compare without leaking where the first difference is. */
function tokenMatches(given, expected) {
  const candidate = String(given || '');
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < candidate.length; index += 1) {
    difference |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[character]));
}

export async function handleFailureAlert(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = String(env.ALERT_ENDPOINT_SECRET || '');
  const to = String(env.ALERT_EMAIL_TO || '').trim();
  const from = String(env.EMAIL_FROM || '').trim();
  if (!expected) return json({ error: 'Failure alerts are not configured' }, 503);
  if (!env.RESEND_API_KEY || !EMAIL.test(addressOf(to)) || !EMAIL.test(addressOf(from))) {
    return json({ error: 'Email delivery for failure alerts is not configured' }, 503);
  }

  const token = new URL(request.url).searchParams.get('token') || '';
  if (!tokenMatches(token, expected)) return json({ error: 'Unauthorized' }, 401);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return json({ error: 'Payload too large' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const text = String((body && body.text) || '').trim().slice(0, MAX_TEXT);
  if (!text) return json({ error: 'A text message is required' }, 400);

  const subject = `[Irish Visa Tracker] ${text.split('\n')[0].slice(0, 180)}`;
  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
      html: `<pre style="font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`
    })
  });

  if (!response.ok) {
    // Never echo the provider body: it can contain account details.
    console.error('Failure alert email rejected: HTTP ' + response.status);
    return json({ error: 'Email provider rejected the alert' }, 502);
  }
  const result = await response.json().catch(() => ({}));
  return json({ ok: true, id: result.id || null });
}
