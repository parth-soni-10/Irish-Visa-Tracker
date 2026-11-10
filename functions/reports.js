/**
 * Public report endpoints and the monthly email digest.
 *
 * Monthly and weekly figures are derived from the same public decision files
 * the tracker serves. The digest is opt-in, double-opt-in and includes a
 * one-click unsubscribe link; no address is sent without verification.
 */

import { sendViaResend } from './email-send.js';
import { sha256 } from './crypto.js';
import { loadReportData, buildMonthlyReport, buildWeeklyChanges } from './report-data.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache }
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function baseUrl(env) {
  return String(env.APP_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title, message) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:16px/1.6 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;color:#14231d}a{color:#067a57}</style>' +
    '</head><body><h1>' + escapeHtml(title) + '</h1><p>' + message + '</p>' +
    '<p><a href="/monthly-report">Open the monthly report</a> &middot; <a href="/">Back to the tracker</a></p></body></html>';
}

async function ensureDigestSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS digest_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    email_hash TEXT NOT NULL UNIQUE,
    verified INTEGER NOT NULL DEFAULT 0,
    verify_token TEXT,
    verify_expires_at TEXT,
    unsubscribe_token TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_sent_at TEXT
  )`).run();
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_email ON digest_subscriptions(email_hash)').run();
}

function buildDigestEmail(report, changes, unsubscribeUrl, base) {
  const subject = 'Irish visa decisions — ' + report.label + ' monthly report';
  const officeRows = report.offices.map((office) =>
    '<tr><td>' + escapeHtml(office.name) + '</td><td style="text-align:right">' + office.total +
    '</td><td style="text-align:right">' + (office.reported_total || 0) +
    '</td><td style="text-align:right">' + escapeHtml(office.report_date || '—') + '</td></tr>'
  ).join('');
  const changeRows = changes.offices.filter((office) => office.total > 0).map((office) =>
    '<tr><td>' + escapeHtml(office.name) + '</td><td style="text-align:right">' + office.total +
    '</td><td style="text-align:right">' + office.approved + '</td><td style="text-align:right">' +
    office.refused + '</td></tr>'
  ).join('');

  const htmlBody = '<!doctype html><html><body style="margin:0;background:#f4f7f5;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#14231d">' +
    '<div style="max-width:720px;margin:0 auto;padding:24px">' +
    '<p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#067a57;margin:0 0 8px">Irish Visa Decision Tracker</p>' +
    '<h1 style="margin:0 0 8px;font-size:28px">' + escapeHtml(report.label) + ' monthly report</h1>' +
    '<p style="margin:0 0 24px;color:#4c6258">Dated decisions recorded in the public embassy files, plus the latest cumulative report from each office. Generated ' +
    escapeHtml(report.generated_at.slice(0, 10)) + '.</p>' +
    '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9e4de;border-radius:8px;overflow:hidden">' +
    '<tr style="background:#eaf4ef"><th style="text-align:left;padding:10px">Metric</th><th style="text-align:right;padding:10px">This month (dated)</th><th style="text-align:right;padding:10px">Previous</th></tr>' +
    '<tr><td style="padding:10px;border-top:1px solid #e5ece8">Dated decisions</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.totals.total + '</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.previous_totals.total + '</td></tr>' +
    '<tr><td style="padding:10px;border-top:1px solid #e5ece8">Approved</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.totals.approved + '</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.previous_totals.approved + '</td></tr>' +
    '<tr><td style="padding:10px;border-top:1px solid #e5ece8">Refused</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.totals.refused + '</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.previous_totals.refused + '</td></tr>' +
    '<tr><td style="padding:10px;border-top:1px solid #e5ece8">Approval rate</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.totals.approval_rate + '%</td><td style="text-align:right;padding:10px;border-top:1px solid #e5ece8">' + report.previous_totals.approval_rate + '%</td></tr>' +
    '</table>' +
    '<h2 style="font-size:18px;margin:28px 0 8px">What changed this week</h2>' +
    '<p style="margin:0 0 12px">' + escapeHtml(changes.headline) + ' (' + escapeHtml(changes.window.start) + ' to ' + escapeHtml(changes.window.end) + ').</p>' +
    '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9e4de">' +
    '<tr style="background:#eaf4ef"><th style="text-align:left;padding:8px">Office</th><th style="text-align:right;padding:8px">Total</th><th style="text-align:right;padding:8px">Approved</th><th style="text-align:right;padding:8px">Refused</th></tr>' +
    (changeRows || '<tr><td colspan="4" style="padding:10px">No decisions in this window.</td></tr>') + '</table>' +
    '<h2 style="font-size:18px;margin:28px 0 8px">By office</h2>' +
    '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #d9e4de">' +
    '<tr style="background:#eaf4ef"><th style="text-align:left;padding:8px">Office</th><th style="text-align:right;padding:8px">Dated</th><th style="text-align:right;padding:8px">Latest report</th><th style="text-align:right;padding:8px">Report date</th></tr>' +
    officeRows + '</table>' +
    '<p style="font-size:12px;color:#6b7f75;margin:8px 0 0">Only New Delhi currently publishes decision-level dates. “Latest report” is the size of each office’s latest cumulative file and is not a monthly count.</p>' +
    '<p style="margin:24px 0"><a href="' + escapeHtml(base + '/monthly-report?month=' + report.month) + '" style="background:#067a57;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Read the full report</a></p>' +
    '<p style="font-size:12px;color:#6b7f75">This is an independent, unofficial tracker. It is not affiliated with the Embassy of Ireland, ISD or DETE. Counts are based on the published files and may change when an office corrects a report.</p>' +
    '<p style="font-size:12px;color:#6b7f75"><a href="' + escapeHtml(unsubscribeUrl) + '" style="color:#6b7f75">Unsubscribe from monthly reports</a></p>' +
    '</div></body></html>';

  const text = [
    'Irish visa decisions — ' + report.label + ' monthly report',
    '',
    'Dated decisions: ' + report.totals.total + ' (previous month ' + report.previous_totals.total + ')',
    'Approved: ' + report.totals.approved,
    'Refused: ' + report.totals.refused,
    'Approval rate: ' + report.totals.approval_rate + '%',
    '',
    'What changed this week: ' + changes.headline,
    'Window: ' + changes.window.start + ' to ' + changes.window.end,
    'Only New Delhi currently publishes decision-level dates; other offices are cumulative report snapshots.',
    '',
    'Read the full report: ' + base + '/monthly-report?month=' + report.month,
    '',
    'Unsubscribe: ' + unsubscribeUrl
  ].join('\n');

  return { subject, html: htmlBody, text };
}

function authorized(request, env) {
  const provided = request.headers.get('X-Cron-Secret') ||
    new URL(request.url).searchParams.get('secret') ||
    '';
  const admin = request.headers.get('Authorization') || '';
  return Boolean(
    (env.SCRAPER_CRON_SECRET && provided === env.SCRAPER_CRON_SECRET) ||
    (env.ADMIN_TOKEN && admin === 'Bearer ' + env.ADMIN_TOKEN)
  );
}

async function monthlyResponse(request, env) {
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const requested = url.searchParams.get('month') || (data.latestDate ? data.latestDate.slice(0, 7) : '');
  if (!MONTH_RE.test(requested)) return json({ error: 'month must be YYYY-MM' }, 400);
  const report = buildMonthlyReport(data.rows, requested, data.officeList);
  return json({ success: true, report }, 200, 'public, max-age=300, stale-while-revalidate=3600');
}

async function changesResponse(request, env) {
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const days = Number(url.searchParams.get('days') || 7);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, days);
  return json({ success: true, changes }, 200, 'public, max-age=300, stale-while-revalidate=3600');
}

async function subscribeResponse(request, env) {
  await ensureDigestSchema(env.DB);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Valid email required' }, 400);
  if (!env.RESEND_API_KEY) {
    return json({ error: 'Email delivery is not configured on this deployment' }, 503);
  }

  const emailHash = await sha256(email);
  const verifyToken = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();
  // Store in SQLite's datetime format so the expiry compare below is not a
  // lexicographic comparison between "2026-11-11T09:00:00.000Z" and
  // "2026-11-11 18:00:00" (where 'T' sorts after the space).
  const verifyExpires = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');
  await env.DB.prepare(`INSERT INTO digest_subscriptions
      (email, email_hash, verified, verify_token, verify_expires_at, unsubscribe_token)
      VALUES (?, ?, 0, ?, ?, ?)
      ON CONFLICT(email_hash) DO UPDATE SET
        email = excluded.email,
        verified = 0,
        verify_token = excluded.verify_token,
        verify_expires_at = excluded.verify_expires_at,
        unsubscribe_token = excluded.unsubscribe_token`)
    .bind(email, emailHash, verifyToken, verifyExpires, unsubscribeToken).run();

  const base = baseUrl(env);
  const verifyUrl = base + '/api/digest/verify?token=' + encodeURIComponent(verifyToken);
  const unsubscribeUrl = base + '/api/digest/unsubscribe?token=' + encodeURIComponent(unsubscribeToken);
  try {
    await sendViaResend(env, {
      to: email,
      subject: 'Confirm your Irish visa monthly report',
      html: '<p>Confirm that you want the monthly Irish visa decision report by email.</p>' +
        '<p><a href="' + escapeHtml(verifyUrl) + '" style="background:#067a57;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Confirm subscription</a></p>' +
        '<p style="font-size:12px;color:#6b7f75">The link expires in 24 hours. If you did not request this, ignore this email.</p>' +
        '<p style="font-size:12px;color:#6b7f75"><a href="' + escapeHtml(unsubscribeUrl) + '">Unsubscribe</a></p>',
      text: 'Confirm your Irish visa monthly report: ' + verifyUrl
    });
  } catch (error) {
    console.error('Digest verification email failed:', error.message);
    return json({ error: 'Could not send the confirmation email' }, 502);
  }
  return json({ success: true, message: 'Check your inbox to confirm the monthly report.' }, 201);
}

async function verifyResponse(request, env) {
  await ensureDigestSchema(env.DB);
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return html(page('Invalid link', 'That confirmation link is missing a token.'), 400);
  const row = await env.DB.prepare('SELECT email FROM digest_subscriptions WHERE verify_token = ? AND datetime(verify_expires_at) > datetime(\'now\')')
    .bind(token).first();
  if (!row) return html(page('Invalid or expired link', 'Request a new monthly report subscription from the report page.'), 400);
  await env.DB.prepare('UPDATE digest_subscriptions SET verified = 1, verify_token = NULL, verify_expires_at = NULL WHERE verify_token = ?')
    .bind(token).run();
  return html(page('Monthly report confirmed', 'You will receive the next monthly report at <strong>' + escapeHtml(row.email) + '</strong>.'));
}

async function unsubscribeResponse(request, env) {
  await ensureDigestSchema(env.DB);
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return html(page('Invalid link', 'That unsubscribe link is missing a token.'), 400);
  const result = await env.DB.prepare('DELETE FROM digest_subscriptions WHERE unsubscribe_token = ?').bind(token).run();
  if (!result.meta || !result.meta.changes) {
    return html(page('Invalid or already used link', 'That unsubscribe link is no longer valid. You may have already unsubscribed.'), 400);
  }
  return html(page('Unsubscribed', 'You will no longer receive the monthly report.'));
}

async function previewResponse(request, env) {
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const month = url.searchParams.get('month') || (data.latestDate ? data.latestDate.slice(0, 7) : '');
  if (!MONTH_RE.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
  const report = buildMonthlyReport(data.rows, month, data.officeList);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, 7);
  const email = buildDigestEmail(report, changes, baseUrl(env) + '/api/digest/unsubscribe?token=preview', baseUrl(env));
  if (url.searchParams.get('format') === 'html') return html(email.html);
  return json({ success: true, subject: email.subject, html: email.html, text: email.text, report, changes }, 200, 'public, max-age=300');
}

async function sendResponse(request, env) {
  if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
  await ensureDigestSchema(env.DB);
  let body = {};
  try { body = await request.json(); } catch { /* query string below is enough */ }
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const month = body.month || url.searchParams.get('month') || (data.latestDate ? data.latestDate.slice(0, 7) : '');
  if (!MONTH_RE.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
  const report = buildMonthlyReport(data.rows, month, data.officeList);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, 7);
  const dryRun = body.dry_run === true || url.searchParams.get('dry_run') === '1';
  const subscribers = await env.DB.prepare('SELECT email, unsubscribe_token FROM digest_subscriptions WHERE verified = 1').all();
  const recipients = subscribers.results || [];

  if (dryRun) {
    const email = buildDigestEmail(report, changes, baseUrl(env) + '/api/digest/unsubscribe?token=preview', baseUrl(env));
    return json({ success: true, dry_run: true, recipients: recipients.length, subject: email.subject });
  }
  if (!env.RESEND_API_KEY) return json({ error: 'Email delivery is not configured on this deployment' }, 503);

  let sent = 0;
  const failed = [];
  for (const subscriber of recipients) {
    const unsubscribeUrl = baseUrl(env) + '/api/digest/unsubscribe?token=' + encodeURIComponent(subscriber.unsubscribe_token);
    const email = buildDigestEmail(report, changes, unsubscribeUrl, baseUrl(env));
    try {
      await sendViaResend(env, { to: subscriber.email, subject: email.subject, html: email.html, text: email.text });
      sent += 1;
      await env.DB.prepare('UPDATE digest_subscriptions SET last_sent_at = datetime(\'now\') WHERE email_hash = ?')
        .bind(await sha256(subscriber.email.toLowerCase())).run();
    } catch (error) {
      failed.push(subscriber.email);
      console.error('Digest send failed for ' + subscriber.email + ': ' + error.message);
    }
  }
  return json({ success: failed.length === 0, sent, failed: failed.length, recipients: recipients.length });
}

export async function handleReports(request, env) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/reports/monthly' && request.method === 'GET') return monthlyResponse(request, env);
  if (pathname === '/api/reports/changes' && request.method === 'GET') return changesResponse(request, env);
  if (pathname === '/api/digest/preview' && request.method === 'GET') return previewResponse(request, env);
  if (pathname === '/api/digest/subscribe' && request.method === 'POST') return subscribeResponse(request, env);
  if (pathname === '/api/digest/verify' && request.method === 'GET') return verifyResponse(request, env);
  if (pathname === '/api/digest/unsubscribe' && request.method === 'GET') return unsubscribeResponse(request, env);
  if (pathname === '/api/digest/send' && request.method === 'POST') return sendResponse(request, env);
  return json({ error: 'Not found' }, 404);
}
