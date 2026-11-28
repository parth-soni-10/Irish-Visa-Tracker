/**
 * Public report endpoints and the monthly digest announcement.
 *
 * Monthly and weekly figures are derived from the same public decision files
 * the tracker serves. The digest is announced in the Telegram channel, which a
 * reader opts into by following it; there is no address to collect, verify or
 * unsubscribe, and nothing is emailed.
 */

import { loadReportData, buildMonthlyReport, buildWeeklyChanges, buildCorrectionLedger } from './report-data.js';
import { MAX_JSON_BODY_BYTES, readJsonBody } from './_json-body.js';
import { isTelegramConfigured, sendTelegramChannel } from './telegram.js';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function json(body, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache }
  });
}


function baseUrl(env) {
  return String(env.APP_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function displayDate(value) {
  const raw = String(value || '').slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return '';
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/**
 * The monthly digest is one Telegram post, so it carries the figures a reader
 * opens the report for plus the link. Telegram caps a message at 4096
 * characters, and the office list is trimmed well inside that ceiling.
 */
function buildDigestMessage(report, changes, base) {
  const reportUrl = base + '/monthly-report?month=' + encodeURIComponent(report.month);
  const lines = [
    'Irish visa decisions — ' + report.label + ' monthly report',
    ''
  ];
  const dataThrough = displayDate(report.data_through || report.latest_date);
  if (dataThrough) lines.push('Data to ' + dataThrough + '.');
  lines.push(
    'Dated decisions: ' + report.totals.total + ' (' + report.totals.approved + ' approved, ' +
      report.totals.refused + ' refused)',
    'Approved share: ' + report.totals.approval_rate + '%',
    'Previous month: ' + report.previous_totals.total + ' dated (' +
      report.previous_totals.approval_rate + '% approved)'
  );
  const offices = (report.offices || []).filter((office) => office.total || office.reported_total);
  if (offices.length) {
    lines.push('', 'By office:');
    for (const office of offices) {
      lines.push('• ' + office.name + ': ' + (office.total || 0) + ' dated' +
        (office.report_date ? ' · report ' + office.report_date : ''));
    }
  }
  // Three offices publish a cumulative snapshot rather than monthly dated
  // decisions; without the note a row of zeros reads like missing data.
  lines.push('', 'New Delhi, Beijing and Dublin publish a cumulative snapshot, not monthly dated decisions.');
  if (changes && changes.headline) {
    lines.push('', 'What changed this week: ' + changes.headline);
    if (changes.window) lines.push('Window: ' + changes.window.start + ' to ' + changes.window.end);
  }
  lines.push('', 'Full report: ' + reportUrl);
  return lines.join('\n').slice(0, 3900);
}

const DIGEST_BROADCASTS = `CREATE TABLE IF NOT EXISTS digest_broadcasts (
  month TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** One announcement per calendar month, however often the workflow runs. */
async function digestAlreadySent(env, month) {
  await env.DB.prepare(DIGEST_BROADCASTS).run();
  const row = await env.DB
    .prepare('SELECT month FROM digest_broadcasts WHERE month = ?')
    .bind(month)
    .first();
  return Boolean(row);
}

async function recordDigestSent(env, month) {
  await env.DB.prepare('INSERT OR IGNORE INTO digest_broadcasts (month) VALUES (?)').bind(month).run();
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
  return json({ success: true, report });
}

async function changesResponse(request, env) {
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const days = Number(url.searchParams.get('days') || 7);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, days);
  return json({ success: true, changes });
}

async function correctionsResponse(request, env) {
  const data = await loadReportData(env, request);
  const ledger = buildCorrectionLedger(data.reports, {
    manifest: data.manifest,
    officeList: data.officeList
  });
  return json({ success: true, ledger });
}


async function previewResponse(request, env) {
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const month = url.searchParams.get('month') || (data.latestDate ? data.latestDate.slice(0, 7) : '');
  if (!MONTH_RE.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
  const report = buildMonthlyReport(data.rows, month, data.officeList);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, 7);
  const text = buildDigestMessage(report, changes, baseUrl(env));
  if (url.searchParams.get('format') === 'text') {
    return new Response(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  return json({ success: true, month, text, report, changes });
}

async function sendResponse(request, env) {
  if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401);
  if (!env.DB) return json({ error: 'Database is not configured' }, 503);
  const parsedBody = await readJsonBody(request);
  if (parsedBody.tooLarge) return json({ error: `Body must be at most ${MAX_JSON_BODY_BYTES} bytes` }, 413);
  // No body or a malformed one is fine here: the query string below is enough.
  const body = parsedBody.body || {};
  const url = new URL(request.url);
  const data = await loadReportData(env, request);
  const month = body.month || url.searchParams.get('month') || (data.latestDate ? data.latestDate.slice(0, 7) : '');
  if (!MONTH_RE.test(month)) return json({ error: 'month must be YYYY-MM' }, 400);
  const report = buildMonthlyReport(data.rows, month, data.officeList);
  const changes = buildWeeklyChanges(data.rows, data.latestDate, data.officeList, data.reports, 7);
  const text = buildDigestMessage(report, changes, baseUrl(env));
  const dryRun = body.dry_run === true || url.searchParams.get('dry_run') === '1';
  if (dryRun) return json({ success: true, dry_run: true, channel: 'telegram', month, text });

  // Without a channel the digest has nowhere to go. That is a configuration
  // gap, not a failed delivery, so it stays green and says why.
  if (!isTelegramConfigured(env) || !String(env.TELEGRAM_CHANNEL_ID || '').trim()) {
    console.warn('Monthly digest skipped: TELEGRAM_CHANNEL_ID is not configured.');
    return json({ success: true, sent: 0, skipped: 'telegram_channel_not_configured' });
  }
  // The workflow runs from its monthly cron, a retry, and every scrape run, so
  // this guard makes a re-run a no-op instead of a second announcement.
  if (await digestAlreadySent(env, month)) {
    return json({ success: true, sent: 0, skipped: 'already_sent_this_month' });
  }
  const result = await sendTelegramChannel(env, env.TELEGRAM_CHANNEL_ID, text);
  if (!result.sent) {
    console.error('Monthly digest failed: ' + (result.error || 'unknown error'));
    return json({ success: false, sent: 0, error: 'Telegram rejected the digest' }, 502);
  }
  await recordDigestSent(env, month);
  return json({ success: true, sent: 1, channel: 'telegram', month });
}

export async function handleReports(request, env) {
  const pathname = new URL(request.url).pathname;
  if (pathname === '/api/reports/monthly' && request.method === 'GET') return monthlyResponse(request, env);
  if (pathname === '/api/reports/changes' && request.method === 'GET') return changesResponse(request, env);
  if (pathname === '/api/reports/corrections' && request.method === 'GET') return correctionsResponse(request, env);
  if (pathname === '/api/digest/preview' && request.method === 'GET') return previewResponse(request, env);
  if (pathname === '/api/digest/send' && request.method === 'POST') return sendResponse(request, env);
  return json({ error: 'Not found' }, 404);
}
