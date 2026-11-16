/**
 * Decision alert runner.
 *
 * Called by a scheduler with X-Cron-Secret. It loads the published decision
 * files, matches subscribed applications against the current office snapshots,
 * sends at most one alert per decision date for each enabled channel, and
 * records last_alert_sent so a retry is idempotent.
 *
 * Telegram and browser push are the supported channels. Email alerts are not
 * implemented and are deliberately not part of this runner.
 */

import { loadReportData } from './report-data.js';
import { isTelegramConfigured, ensureTelegramSchema, sendTelegram } from './telegram.js';

const MAX_ALERTS = 250;
const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';

function normalizeNumber(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^IRL/i, '').toUpperCase();
}

/**
 * Find the current published row for a subscription. Office and number are
 * matched independently so a subscriber cannot accidentally receive a New
 * Delhi decision for a Beijing application.
 */
export function findDecision(rows, applicationNumber, embassy) {
  const number = normalizeNumber(applicationNumber);
  const office = String(embassy || '').trim();
  if (!number || !office) return null;
  return (rows || []).find((row) =>
    normalizeNumber(row.number) === number &&
    String(row.office || '').trim() === office
  ) || null;
}

/**
 * A decision date is the alert key. Re-running after a successful send is a
 * no-op; a correction with a newer report date gets one more alert.
 */
export function shouldSend(lastSent, decisionDate) {
  const sent = String(lastSent || '').slice(0, 10);
  const date = String(decisionDate || '').slice(0, 10);
  return Boolean(date) && (!sent || sent < date);
}

async function runPushAlerts(env, report, dryRun) {
  const { isPushConfigured, ensurePushSchema, sendDecisionPush } = await import('./push.js');
  if (!isPushConfigured(env)) {
    return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, would_send: 0 };
  }

  await ensurePushSchema(env);
  let rows = [];
  try {
    const result = await env.DB.prepare(`
      SELECT application_number,
             COALESCE(embassy_slug, embassy) AS embassy,
             MAX(last_alert_sent) AS last_alert_sent
      FROM push_subscriptions
      WHERE application_number IS NOT NULL AND application_number <> ''
      GROUP BY application_number, COALESCE(embassy_slug, embassy)
      LIMIT ?
    `).bind(MAX_ALERTS).all();
    rows = result.results || [];
  } catch (error) {
    console.warn('Push alert query failed:', error.message);
    return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 1, would_send: 0 };
  }

  let matched = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let wouldSend = 0;

  for (const row of rows) {
    const decision = findDecision(report.rows, row.application_number, row.embassy);
    if (!decision) {
      skipped += 1;
      continue;
    }
    matched += 1;
    if (!shouldSend(row.last_alert_sent, decision.date)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      wouldSend += 1;
      continue;
    }

    const result = await sendDecisionPush(env, row.application_number, decision.decision, row.embassy);
    if (result.sent > 0) {
      sent += 1;
      await env.DB.prepare(`
        UPDATE push_subscriptions SET last_alert_sent = ?
        WHERE application_number = ? AND (embassy_slug = ? OR embassy = ?)
      `).bind(decision.date, row.application_number, row.embassy, row.embassy).run().catch(() => {});
    } else {
      failed += 1;
    }
  }

  return { checked: rows.length, matched, sent, skipped, failed, would_send: wouldSend };
}

async function runTelegramAlerts(env, report, dryRun) {
  if (!isTelegramConfigured(env)) {
    return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, would_send: 0 };
  }
  await ensureTelegramSchema(env);
  let rows = [];
  try {
    const result = await env.DB.prepare(`
      SELECT id, chat_id, application_number, embassy, last_alert_sent
      FROM telegram_subscriptions
      WHERE active = 1
      ORDER BY id
      LIMIT ?
    `).bind(MAX_ALERTS).all();
    rows = result.results || [];
  } catch (error) {
    console.warn('Telegram alert query failed:', error.message);
    return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 1, would_send: 0 };
  }

  let matched = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let wouldSend = 0;
  for (const row of rows) {
    const decision = findDecision(report.rows, row.application_number, row.embassy);
    if (!decision) {
      skipped += 1;
      continue;
    }
    matched += 1;
    if (!shouldSend(row.last_alert_sent, decision.date)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      wouldSend += 1;
      continue;
    }
    const message = 'Visa ' + decision.decision + ' for ' + row.application_number +
      ' at ' + row.embassy + ' (published ' + decision.date + '). View: ' +
      String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '') +
      '/?tab=home&q=' + encodeURIComponent(row.application_number) +
      '\n\nSend /stop to turn these alerts off.';
    const result = await sendTelegram(env, row.chat_id, message);
    if (!result.sent) {
      failed += 1;
      continue;
    }
    sent += 1;
    await env.DB.prepare('UPDATE telegram_subscriptions SET last_alert_sent = ? WHERE id = ?')
      .bind(decision.date, row.id).run().catch(() => {});
  }
  return { checked: rows.length, matched, sent, skipped, failed, would_send: wouldSend };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function suppliedSecret(request) {
  const url = new URL(request.url);
  return request.headers.get('X-Cron-Secret') || url.searchParams.get('secret') || '';
}

export async function handleAlertsRun(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const expected = env.ALERTS_CRON_SECRET || env.SCRAPER_CRON_SECRET;
  if (!expected) {
    return json({ error: 'Alert runner secret is not configured' }, 503);
  }
  if (suppliedSecret(request) !== expected) {
    return json({ error: 'Invalid or missing cron secret' }, 401);
  }
  if (!env.DB) {
    return json({ error: 'Database not configured' }, 503);
  }

  const { isPushConfigured } = await import('./push.js');
  const pushConfigured = isPushConfigured(env);
  const telegramConfigured = isTelegramConfigured(env);
  if (!pushConfigured && !telegramConfigured) {
    return json({ error: 'No alert delivery channel is configured' }, 503);
  }

  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1';
  try {
    const report = await loadReportData(env, request);
    const push = await runPushAlerts(env, report, dryRun);
    const telegram = await runTelegramAlerts(env, report, dryRun);
    return json({
      ok: push.failed === 0 && telegram.failed === 0,
      checked: push.checked + telegram.checked,
      matched: push.matched + telegram.matched,
      sent: push.sent + telegram.sent,
      skipped: push.skipped + telegram.skipped,
      failed: push.failed + telegram.failed,
      would_send: push.would_send + telegram.would_send,
      push_checked: push.checked,
      push_sent: push.sent,
      telegram_checked: telegram.checked,
      telegram_sent: telegram.sent,
      dry_run: dryRun
    });
  } catch (error) {
    console.error('Alert runner failed:', error);
    return json({ error: 'Alert runner failed' }, 500);
  }
}
