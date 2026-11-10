// Resend only accepts a sender on a domain verified in the account. The
// pages.dev host cannot be verified, so allow a verified address to be set
// per deployment; onboarding@resend.dev is Resend's sandbox sender for local
// tests (it only delivers to the account owner's address).
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SANDBOX_FROM = 'Irish Visa Tracker <onboarding@resend.dev>';

export async function sendViaResend(env, { to, subject, html, text }) {
  const response = await fetch(env.RESEND_API_URL || RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || SANDBOX_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error('Resend failed: ' + response.status + ' ' + err);
  }
  return response.json();
}

export async function sendVerificationEmail(env, email, token, appNum, embassy) {
  const verifyUrl = env.APP_BASE_URL + '/api/verify?token=' + token;
  const unsubUrl = env.APP_BASE_URL + '/api/unsubscribe?token=' + token;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Irish Visa Tracker <alerts@irishvisaupdatetracker.pages.dev>',
      to: [email],
      subject: 'Verify your email for Irish Visa Tracker alerts (' + appNum + ')',
      html: '<p>You requested alerts for application <strong>' + appNum + '</strong> at the <strong>' + embassy + '</strong> visa office.</p><p><a href="' + verifyUrl + '" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Verify Email & Enable Alerts</a></p><p style="color:#666;font-size:12px;">This link expires in 24 hours. If you didn\'t request this, ignore this email.</p><hr><p style="color:#999;font-size:11px;"><a href="' + env.APP_BASE_URL + '/api/unsubscribe?token=' + token + '">Unsubscribe</a></p>',
      text: 'Verify your email for Irish Visa Tracker alerts (' + appNum + '): ' + verifyUrl
    }),
  });
}

export async function sendConfirmedEmail(env, email, appNum, embassy) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Irish Visa Tracker <alerts@irishvisaupdatetracker.pages.dev>',
      to: [email],
      subject: 'Alerts enabled for ' + appNum + ' (' + embassy + ')',
      html: '<p>You\'re now subscribed to alerts for <strong>' + appNum + '</strong> at <strong>' + embassy + '</strong>.</p><p>We\'ll email you when this application number appears in the published decision list.</p>',
    }),
  });
}

export async function sendDecisionAlert(env, email, appNum, embassy, decision) {
  const status = decision.decision;
  const date = decision.date;
  const subject = 'Visa ' + status + ': ' + appNum + ' (' + embassy + ')';
  const html = '<h2 style="color:' + (status === 'Approved' ? '#059669' : '#dc2626') + '">Application ' + status + '</h2><p><strong>Application:</strong> ' + appNum + '</p><p><strong>Office:</strong> ' + embassy + '</p><p><strong>Decision Date:</strong> ' + date + '</p><p><strong>Outcome:</strong> ' + status + '</p><p><a href="https://www.ireland.ie" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View Official Source</a></p><hr><p style="color:#999;font-size:11px;">You received this because you subscribed to alerts for ' + appNum + '.</p>';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Irish Visa Tracker <alerts@irishvisaupdatetracker.pages.dev>', to: [email], subject: subject, html: html }),
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