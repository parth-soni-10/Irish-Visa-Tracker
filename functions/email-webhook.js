/**
 * Secret-protected email webhook used by the app's provider-neutral mailer.
 *
 * The existing Resend key stays server-side: `sendEmail()` posts the same
 * provider-neutral payload to this route, and this route translates it to the
 * Resend API. Keeping the key here means the mailer contract remains stable and
 * no provider credential is shipped to the browser.
 */

const RESEND_URL = 'https://api.resend.com/emails';
const MAX_BODY = 100 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function validEmail(value) {
  const text = String(value || '').trim();
  const address = text.match(/<([^>]+)>$/)?.[1] || text;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address);
}

export async function handleEmailWebhook(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const expected = String(env.EMAIL_WEBHOOK_SECRET || '');
  if (!expected) return json({ error: 'Email webhook secret is not configured' }, 503);
  if (!env.RESEND_API_KEY) return json({ error: 'RESEND_API_KEY is not configured' }, 503);

  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) return json({ error: 'Payload too large' }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // The webhook is only called by the app; the secret is the authentication
  // boundary. Do not return details about a failed comparison.
  if (String(body.secret || '') !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim();
  const from = String(env.EMAIL_FROM || body.from || '').trim();
  if (!validEmail(to) || !validEmail(from) || !subject) {
    return json({ error: 'A valid from, to and subject are required' }, 400);
  }
  if (body.from && env.EMAIL_FROM && String(body.from).trim() !== String(env.EMAIL_FROM).trim()) {
    return json({ error: 'Sender does not match EMAIL_FROM' }, 400);
  }

  const html = String(body.html || '').slice(0, MAX_BODY);
  const text = String(body.text || '').slice(0, MAX_BODY);
  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: subject.slice(0, 300),
      html,
      text
    })
  });

  if (!response.ok) {
    // Resend may include details, but never echo the API key or raw response.
    console.error('Email provider rejected a message: HTTP ' + response.status);
    return json({ error: 'Email provider rejected the message' }, 502);
  }

  const result = await response.json().catch(() => ({}));
  return json({ ok: true, id: result.id || null });
}
