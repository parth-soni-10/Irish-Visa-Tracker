/**
 * Decision alert runner.
 *
 * Called by a scheduler with X-Cron-Secret. It loads the published decision
 * files, matches subscribed applications against the current office snapshots,
 * sends at most one alert per decision date for each enabled channel, and
 * records last_alert_sent so a retry is idempotent.
 *
 * Telegram also supports a chat-level digest. In digest mode one message groups
 * every linked application by office, says which ones have no change, and is
 * sent at most once per day/week. An individual application can opt back into
 * immediate delivery with /immediate <number>.
 */

import { loadReportData } from './report-data.js';
import { isTelegramConfigured, ensureTelegramSchema, sendTelegram } from './telegram.js';

const MAX_ALERTS = 500;
const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const DIGEST_INTERVALS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};
const OFFICE_NAMES = {
  'new-delhi': 'New Delhi',
  beijing: 'Beijing',
  dublin: 'Dublin',
  'abu-dhabi': 'Abu Dhabi',
  abuja: 'Abuja',
  ankara: 'Ankara'
};

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

/** True when a chat's digest is due, measured from the last successfully sent digest. */
export function dueForDigest(lastSent, frequency, now = Date.now()) {
  if (!DIGEST_INTERVALS[frequency]) return false;
  if (!lastSent) return true;
  const sentAt = Date.parse(String(lastSent));
  if (!Number.isFinite(sentAt)) return true;
  return now - sentAt >= DIGEST_INTERVALS[frequency];
}

function emptyCounters() {
  return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, would_send: 0 };
}

async function runPushAlerts(env, report, dryRun) {
  const { isPushConfigured, ensurePushSchema, sendDecisionPush } = await import('./push.js');
  if (!isPushConfigured(env)) {
    return emptyCounters();
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
    return { ...emptyCounters(), failed: 1 };
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

async function telegramRows(env) {
  const result = await env.DB.prepare(`
    SELECT s.id, s.chat_id, s.application_number, s.embassy, s.last_alert_sent,
           COALESCE(s.immediate, 1) AS immediate,
           COALESCE(p.digest_frequency, 'off') AS digest_frequency,
           p.last_digest_sent
    FROM telegram_subscriptions s
    LEFT JOIN telegram_preferences p ON p.chat_id = s.chat_id
    WHERE s.active = 1
    ORDER BY s.id
    LIMIT ?
  `).bind(MAX_ALERTS).all();
  return result.results || [];
}

// Backwards-compatible query for a deployment whose digest migration has not
// run yet. The schema migrator normally adds `immediate` before this is used.
async function legacyTelegramRows(env) {
  const result = await env.DB.prepare(`
    SELECT id, chat_id, application_number, embassy, last_alert_sent
    FROM telegram_subscriptions WHERE active = 1 ORDER BY id LIMIT ?
  `).bind(MAX_ALERTS).all();
  return (result.results || []).map((row) => ({
    ...row,
    immediate: 1,
    digest_frequency: 'off',
    last_digest_sent: null
  }));
}

async function readTelegramRows(env) {
  try {
    return await telegramRows(env);
  } catch (error) {
    console.warn('Telegram digest query failed, using immediate-only query:', error.message);
    return legacyTelegramRows(env);
  }
}

async function runTelegramAlerts(env, report, dryRun) {
  if (!isTelegramConfigured(env)) {
    return emptyCounters();
  }
  await ensureTelegramSchema(env);
  const rows = await readTelegramRows(env);

  let matched = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let wouldSend = 0;
  for (const row of rows) {
    // Digest mode may leave one application immediate while the rest are grouped.
    if (Number(row.immediate) === 0) {
      skipped += 1;
      continue;
    }
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
      '/?tab=search&q=' + encodeURIComponent(row.application_number) +
      '\n\nToo many messages? Send /digest weekly, or /stop to turn alerts off.';
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

/**
 * Group one chat's linked applications into a single digest message.
 * No-change offices are stated explicitly; a daily digest with no changes at
 * all is suppressed by the caller, while a weekly digest still sends it.
 */
export function buildDigestMessage(chatRows, options = {}) {
  const rows = Array.isArray(chatRows) ? chatRows : [];
  const base = String(options.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const changed = rows.filter((row) => row.decision);
  const offices = new Map();
  for (const row of rows) {
    const office = String(row.embassy || '').trim();
    if (!offices.has(office)) offices.set(office, []);
    offices.get(office).push(row);
  }

  const lines = [
    'Irish visa decision digest — ' + now.toISOString().slice(0, 10),
    rows.length + ' tracked application' + (rows.length === 1 ? '' : 's') +
      ' · ' + changed.length + ' new decision' + (changed.length === 1 ? '' : 's'),
    ''
  ];

  if (!changed.length) {
    lines.push('No new published decisions for your linked applications.');
  } else {
    for (const [office, officeRows] of offices) {
      const changedRows = officeRows.filter((row) => row.decision);
      const unchanged = officeRows.length - changedRows.length;
      if (!changedRows.length) {
        lines.push((OFFICE_NAMES[office] || office) + ': no change (' + unchanged +
          ' application' + (unchanged === 1 ? '' : 's') + ').');
        continue;
      }
      lines.push((OFFICE_NAMES[office] || office) + ':');
      for (const row of changedRows) {
        lines.push('• ' + row.application_number + ' — ' + row.decision.decision +
          ' (decision ' + row.decision.date + ', published ' + row.decision.report_date + ')');
      }
      if (unchanged > 0) lines.push('  No change for ' + unchanged + ' other application' + (unchanged === 1 ? '' : 's') + '.');
      lines.push('');
    }
  }

  lines.push('View or manage: ' + base + '/?tracker=visa&tab=alerts');
  lines.push('Send /status to review linked applications, /digest off for immediate alerts.');
  return lines.join('\n').slice(0, 4000);
}

async function runTelegramDigests(env, report, dryRun) {
  if (!isTelegramConfigured(env)) return emptyCounters();
  await ensureTelegramSchema(env);
  const rows = await readTelegramRows(env);
  const chats = new Map();
  for (const row of rows) {
    const chatId = String(row.chat_id || '');
    if (!chatId) continue;
    if (!chats.has(chatId)) chats.set(chatId, []);
    chats.get(chatId).push(row);
  }

  let checked = 0;
  let matched = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let wouldSend = 0;

  for (const [chatId, chatRows] of chats) {
    const frequency = String(chatRows[0].digest_frequency || 'off');
    if (!DIGEST_INTERVALS[frequency]) {
      skipped += 1;
      continue;
    }
    if (!dueForDigest(chatRows[0].last_digest_sent, frequency)) {
      skipped += 1;
      continue;
    }

    checked += chatRows.length;
    const states = chatRows.map((row) => {
      const decision = findDecision(report.rows, row.application_number, row.embassy);
      return {
        ...row,
        decision: decision && shouldSend(row.last_alert_sent, decision.date) ? decision : null
      };
    });
    const changes = states.filter((state) => state.decision);
    matched += changes.length;

    // A daily "no change" every day is exactly the alert fatigue the digest is
    // meant to reduce. Weekly digests still send the explicit no-change summary.
    if (!changes.length && frequency !== 'weekly') {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      wouldSend += 1;
      continue;
    }

    const result = await sendTelegram(env, chatId, buildDigestMessage(states, {
      baseUrl: env.APP_BASE_URL || DEFAULT_BASE
    }));
    if (!result.sent) {
      failed += 1;
      continue;
    }
    sent += 1;
    for (const state of changes) {
      await env.DB.prepare('UPDATE telegram_subscriptions SET last_alert_sent = ? WHERE id = ?')
        .bind(state.decision.date, state.id).run().catch(() => {});
    }
    await env.DB.prepare('UPDATE telegram_preferences SET last_digest_sent = ? WHERE chat_id = ?')
      .bind(new Date().toISOString(), chatId).run().catch(() => {});
  }

  return { checked, matched, sent, skipped, failed, would_send: wouldSend };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
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
    const digests = await runTelegramDigests(env, report, dryRun);
    return json({
      ok: push.failed === 0 && telegram.failed === 0 && digests.failed === 0,
      checked: push.checked + telegram.checked + digests.checked,
      matched: push.matched + telegram.matched + digests.matched,
      sent: push.sent + telegram.sent + digests.sent,
      skipped: push.skipped + telegram.skipped + digests.skipped,
      failed: push.failed + telegram.failed + digests.failed,
      would_send: push.would_send + telegram.would_send + digests.would_send,
      push_checked: push.checked,
      push_sent: push.sent,
      telegram_checked: telegram.checked,
      telegram_sent: telegram.sent,
      digest_checked: digests.checked,
      digest_sent: digests.sent,
      dry_run: dryRun
    });
  } catch (error) {
    console.error('Alert runner failed:', error);
    return json({ error: 'Alert runner failed' }, 500);
  }
}
