import { sha256 } from './crypto.js';
import { isEmailConfigured, sendEmail } from './email-send.js';
import { json, ack, generateToken, invalidSubscription } from './email-utils.js';

export const SUBSCRIBE_PATH = '/api/subscribe';
export const VERIFY_PATH = '/api/verify';
export const UNSUBSCRIBE_PATH = '/api/unsubscribe';
const MAX_BODY = 16 * 1024;

// `email_subscriptions` is shared with the account API, so keep these names in
// sync with `_router.js` / `db-schema.cjs`. Older deployments may have been
// created by this file with the old `verify_token` names; ensureEmailSchema
// adds the shared columns without dropping the table.
const EMAIL_SCHEMA = `CREATE TABLE IF NOT EXISTS email_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  email_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires TEXT,
  unsubscribe_token TEXT,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_alert_sent TEXT,
  UNIQUE(email_hash, application_number, embassy)
)`;

const EMAIL_COLUMNS = [
  ['user_id', 'TEXT'],
  ['verification_token', 'TEXT'],
  ['verification_expires', 'TEXT'],
  ['unsubscribe_token', 'TEXT'],
  ['unsubscribed', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_alert_sent', 'TEXT']
];

export async function ensureEmailSchema(env) {
  await env.DB.prepare(EMAIL_SCHEMA).run();
  for (const [name, type] of EMAIL_COLUMNS) {
    try {
      await env.DB.prepare('SELECT ' + name + ' FROM email_subscriptions LIMIT 1').run();
    } catch {
      await env.DB.prepare('ALTER TABLE email_subscriptions ADD COLUMN ' + name + ' ' + type).run();
    }
  }
}

/** Build both links from the exact tokens stored in D1. */
export function buildAlertLinks(env, verifyToken, unsubscribeToken) {
  const base = String(env.APP_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
  return {
    verify: base + '/api/verify?token=' + encodeURIComponent(verifyToken),
    unsubscribe: base + '/api/unsubscribe?token=' + encodeURIComponent(unsubscribeToken),
  };
}

async function handleSubscribe(request, env) {
  if (String(request.headers.get('Content-Type') || '').includes('application/json')) {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Malformed body' }, 400); }
    return processSubscribe(env, body);
  }
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return json({ error: 'Unsupported content type' }, 415);
  }
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'Malformed body' }, 400); }
  if (String(form.get('bot-field') || '').trim() !== '') return ack(request);
  const fields = {};
  for (const [key, value] of form.entries()) { if (key !== 'bot-field') fields[key] = String(value).slice(0, 4000); }
  return processSubscribe(env, fields);
}

async function processSubscribe(env, fields) {
  const email = String(fields.email || '').trim().toLowerCase();
  const applicationNumber = String(fields.application_number || '').trim();
  const embassy = String(fields.embassy || '').trim();
  const invalid = invalidSubscription('subscribe', fields);
  if (invalid) return json({ error: 'Invalid ' + invalid }, 400);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);

  const emailHash = await sha256(email);
  const verifyToken = generateToken();
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const unsubscribeToken = generateToken();
  try {
    await ensureEmailSchema(env);
    await env.DB.prepare(`INSERT INTO email_subscriptions
      (email, email_hash, application_number, embassy, verification_token, verification_expires, unsubscribe_token, verified, unsubscribed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
      ON CONFLICT(email_hash, application_number, embassy) DO UPDATE SET
        email = excluded.email,
        verification_token = excluded.verification_token,
        verification_expires = excluded.verification_expires,
        unsubscribe_token = excluded.unsubscribe_token,
        verified = 0,
        unsubscribed = 0`)
      .bind(email, emailHash, applicationNumber, embassy, verifyToken, verifyExpires, unsubscribeToken)
      .run();

    if (!isEmailConfigured(env)) {
      return json({ error: 'Email delivery is not configured' }, 503);
    }

    const links = buildAlertLinks(env, verifyToken, unsubscribeToken);
    await sendEmail(env, {
      from: env.EMAIL_FROM,
      to: email,
      subject: 'Verify your email for Irish Visa Tracker alerts (' + applicationNumber + ')',
      html: '<p>You requested alerts for application <strong>' + applicationNumber + '</strong> at the <strong>' + embassy + '</strong> visa office.</p><p><a href="' + links.verify + '" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email &amp; Enable Alerts</a></p><p style="color:#666;font-size:12px;">This link expires in 24 hours. If you did not request this, ignore this email.</p><hr><p style="color:#999;font-size:11px;"><a href="' + links.unsubscribe + '">Unsubscribe</a></p>',
      text: 'Verify your email for Irish Visa Tracker alerts (' + applicationNumber + '): ' + links.verify
    });
    return json({ ok: true, message: 'Verification email sent' });
  } catch (e) {
    console.error('Subscribe failed:', e);
    return json({ error: 'Could not register' }, 500);
  }
}

async function handleVerify(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response('Invalid token', { status: 400 });
  if (!env.DB) return new Response('Database not configured', { status: 503 });
  const results = await env.DB.prepare(
    "SELECT email, application_number, embassy FROM email_subscriptions WHERE verification_token = ? AND datetime(verification_expires) > datetime('now')"
  ).bind(token).all();
  const row = (results.results || [])[0];
  if (!row) return new Response('Invalid or expired token', { status: 400 });
  await env.DB.prepare(
    'UPDATE email_subscriptions SET verified = 1, unsubscribed = 0, verification_token = NULL, verification_expires = NULL WHERE verification_token = ?'
  ).bind(token).run();
  return new Response('Email verified! You will receive alerts for ' + row.application_number, { status: 200 });
}

async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) return new Response('Invalid token', { status: 400 });
  if (!env.DB) return new Response('Database not configured', { status: 503 });
  await env.DB.prepare(
    'UPDATE email_subscriptions SET unsubscribed = 1, unsubscribe_token = NULL WHERE unsubscribe_token = ?'
  ).bind(token).run();
  return new Response('Unsubscribed successfully', { status: 200 });
}

export { handleSubscribe, handleVerify, handleUnsubscribe };
