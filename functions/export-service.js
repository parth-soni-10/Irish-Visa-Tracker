/**
 * Private data export service.
 *
 * This is deliberately not a public API. Tokens are scoped to one user's
 * export and are only accepted by the authenticated product routes. Scheduled
 * exports create a short-lived, unguessable download token that is emailed to
 * the account owner.
 */

import { hashToken } from './auth.js';
import { ensurePortalSchema } from './portal-schema.js';
import { loadReportData } from './report-data.js';
import { isEmailConfigured, sendEmail } from './email-send.js';

const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const EXPORT_DAYS = 7;

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function filterRows(rows, filters = {}) {
  const office = filters.office && filters.office !== 'all' ? String(filters.office) : '';
  const from = String(filters.from || '').slice(0, 10);
  const to = String(filters.to || '').slice(0, 10);
  return (rows || []).filter((row) => {
    if (!row || !row.number || !row.date || !row.decision) return false;
    if (office && row.office !== office) return false;
    if (from && row.date < from) return false;
    if (to && row.date > to) return false;
    return true;
  });
}

export function buildExport(rows, { format = 'csv', office = 'all', from = '', to = '' } = {}) {
  const selected = filterRows(rows, { office, from, to });
  const type = format === 'json' ? 'json' : 'csv';
  const effectiveOffice = office && office !== 'all' ? office : 'all';
  if (type === 'json') {
    const body = JSON.stringify({
      exported_at: new Date().toISOString(),
      service: 'Irish Visa Decision Tracker',
      filter: { office: effectiveOffice, from: from || null, to: to || null },
      count: selected.length,
      decisions: selected
    }, null, 2);
    return {
      format: type,
      body,
      contentType: 'application/json; charset=utf-8',
      filename: 'irish-visa-decisions-' + new Date().toISOString().slice(0, 10) + '.json',
      row_count: selected.length
    };
  }
  const lines = ['date,application_number,decision,office,source,report_date'];
  for (const row of selected) {
    lines.push([
      row.date,
      row.number,
      row.decision,
      row.office,
      row.source || '',
      row.report_date || ''
    ].map(csvCell).join(','));
  }
  return {
    format: type,
    body: lines.join('\r\n'),
    contentType: 'text/csv; charset=utf-8',
    filename: 'irish-visa-decisions-' + new Date().toISOString().slice(0, 10) + '.csv',
    row_count: selected.length
  };
}

export function safeFormat(value) {
  return value === 'json' ? 'json' : 'csv';
}

export function nextRunAt(frequency, now = new Date()) {
  const date = new Date(now.getTime());
  date.setUTCSeconds(0, 0);
  date.setUTCHours(7, 0, 0, 0);
  if (frequency === 'daily') {
    if (date <= now) date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString();
  }
  if (frequency === 'monthly') {
    date.setUTCDate(1);
    if (date <= now) date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  }
  const day = date.getUTCDay();
  const untilMonday = (8 - day) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + untilMonday);
  if (date <= now) date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString();
}

function baseUrl(env) {
  return String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

export async function createExportJob(env, { userId, format, filters, rowCount }) {
  await ensurePortalSchema(env);
  const id = crypto.randomUUID();
  const token = 'ex_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + EXPORT_DAYS * 86400000).toISOString();
  await env.DB.prepare(`
    INSERT INTO export_jobs (id, user_id, format, status, row_count, download_token_hash, expires_at, completed_at)
    VALUES (?, ?, ?, 'ready', ?, ?, ?, datetime('now'))
  `).bind(id, userId, safeFormat(format), Number(rowCount) || 0, tokenHash, expiresAt).run();
  return { id, token, expiresAt };
}

export async function sendExportEmail(env, { to, format, link, rowCount }) {
  if (!isEmailConfigured(env)) {
    return { sent: false, disabled: true };
  }
  await sendEmail(env, {
    from: env.EMAIL_FROM,
    to,
    subject: 'Your Irish Visa Tracker ' + safeFormat(format).toUpperCase() + ' export is ready',
    html: '<p>Your scheduled export is ready: <strong>' + Number(rowCount) + '</strong> rows.</p>' +
      '<p><a href="' + link + '" style="background:#047857;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">Download export</a></p>' +
      '<p style="color:#666;font-size:12px;">The link is private and expires in ' + EXPORT_DAYS + ' days. If you did not request this, you can ignore it.</p>',
    text: 'Your scheduled export is ready (' + Number(rowCount) + ' rows): ' + link
  });
  return { sent: true, disabled: false };
}

function suppliedSecret(request) {
  const url = new URL(request.url);
  return request.headers.get('X-Cron-Secret') || url.searchParams.get('secret') || '';
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function handleExportRun(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const expected = env.EXPORTS_CRON_SECRET || env.ALERTS_CRON_SECRET || env.SCRAPER_CRON_SECRET;
  if (!expected) return json({ error: 'Export runner secret is not configured' }, 503);
  if (suppliedSecret(request) !== expected) return json({ error: 'Invalid or missing cron secret' }, 401);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);

  try {
    await ensurePortalSchema(env);
    const due = await env.DB.prepare(`
      SELECT s.id, s.user_id, s.format, s.frequency, s.filters, u.email
      FROM scheduled_exports s
      JOIN users u ON u.id = s.user_id
      WHERE s.enabled = 1 AND datetime(s.next_run_at) <= datetime('now')
      ORDER BY s.next_run_at
      LIMIT 25
    `).all();
    const schedules = due.results || [];
    const report = await loadReportData(env, request);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const schedule of schedules) {
      try {
        let filters = {};
        try { filters = JSON.parse(schedule.filters || '{}'); } catch {}
        const data = buildExport(report.rows, { format: schedule.format, ...filters });
        const job = await createExportJob(env, {
          userId: schedule.user_id,
          format: schedule.format,
          filters,
          rowCount: data.row_count
        });
        const link = baseUrl(env) + '/api/portal/exports/download?token=' + encodeURIComponent(job.token);
        const mail = await sendExportEmail(env, {
          to: schedule.email,
          format: schedule.format,
          link,
          rowCount: data.row_count
        });
        if (mail.sent) sent += 1;
        else skipped += 1;
        await env.DB.prepare('UPDATE scheduled_exports SET next_run_at = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(nextRunAt(schedule.frequency), schedule.id).run();
      } catch (error) {
        failed += 1;
        console.error('Scheduled export failed:', error.message);
        await env.DB.prepare('UPDATE scheduled_exports SET next_run_at = ?, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(nextRunAt(schedule.frequency), schedule.id).run().catch(() => {});
      }
    }

    return json({ ok: failed === 0, checked: schedules.length, sent, skipped, failed });
  } catch (error) {
    console.error('Export runner failed:', error);
    return json({ error: 'Export runner failed' }, 500);
  }
}
