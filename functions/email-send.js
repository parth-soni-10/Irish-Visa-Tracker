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

function appBase(env) {
  return String(env.APP_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
}

export async function sendVerificationEmail(env, email, token, appNum, embassy) {
  const verifyUrl = appBase(env) + '/api/verify?token=' + encodeURIComponent(token);
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Verify your email for Irish Visa Tracker alerts (' + appNum + ')',
    html: '<p>You requested alerts for application <strong>' + appNum + '</strong> at the <strong>' + embassy + '</strong> visa office.</p><p><a href="' + verifyUrl + '" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email &amp; Enable Alerts</a></p><p style="color:#666;font-size:12px;">This link expires in 24 hours. If you did not request this, ignore this email.</p>',
    text: 'Verify your email for Irish Visa Tracker alerts (' + appNum + '): ' + verifyUrl
  });
}

export async function sendConfirmedEmail(env, email, appNum, embassy) {
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Alerts enabled for ' + appNum + ' (' + embassy + ')',
    html: '<p>You are now subscribed to alerts for <strong>' + appNum + '</strong> at <strong>' + embassy + '</strong>.</p><p>We will email you when this application number appears in the published decision list.</p>'
  });
}

export async function sendDecisionAlert(env, email, appNum, embassy, decision) {
  const status = decision.decision;
  const date = decision.date;
  const subject = 'Visa ' + status + ': ' + appNum + ' (' + embassy + ')';
  const html = '<h2 style="color:' + (status === 'Approved' ? '#059669' : '#dc2626') + '">Application ' + status + '</h2><p><strong>Application:</strong> ' + appNum + '</p><p><strong>Office:</strong> ' + embassy + '</p><p><strong>Decision Date:</strong> ' + date + '</p><p><strong>Outcome:</strong> ' + status + '</p><p><a href="https://www.ireland.ie" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View Official Source</a></p><hr><p style="color:#999;font-size:11px;">You received this because you subscribed to alerts for ' + appNum + '.</p>';
  await sendEmail(env, { from: env.EMAIL_FROM, to: email, subject, html });
}

export async function sendAccountVerificationEmail(env, email, token) {
  const verifyUrl = appBase(env) + '/api/auth/verify?token=' + encodeURIComponent(token);
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Verify your Irish Visa Tracker account',
    html: '<p>Confirm your email address to finish setting up your Irish Visa Tracker account.</p><p><a href="' + verifyUrl + '" style="background:#047857;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify email</a></p><p style="color:#666;font-size:12px;">This link expires in 24 hours.</p>',
    text: 'Verify your Irish Visa Tracker account: ' + verifyUrl
  });
}

export async function sendPasswordResetEmail(env, email, token) {
  const resetUrl = appBase(env) + '/reset-password?token=' + encodeURIComponent(token);
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to: email,
    subject: 'Reset your Irish Visa Tracker password',
    html: '<p>Use the link below to choose a new password. It expires in one hour.</p><p><a href="' + resetUrl + '" style="background:#047857;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Reset password</a></p><p style="color:#666;font-size:12px;">If you did not request this, ignore this email.</p>',
    text: 'Reset your Irish Visa Tracker password: ' + resetUrl
  });
}

export async function checkDecision(env, applicationNumber, embassy) {
  try {
    const response = await fetch('https://raw.githubusercontent.com/parth-soni-10/Irish-Visa-Tracker/main/data/embassy-' + embassy + '.json');
    if (!response.ok) return null;
    const data = await response.json();
    return (data.decisions || []).find(d => d.number === applicationNumber) || null;
  } catch { return null; }
}
