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
import {
  DIGEST_INTERVALS,
  buildDigestMessage,
  dueForDigest,
  findDecision,
  shouldSend,
  shouldSendDigest
} from './digest.js';

// Kept as named exports because the alert-runner tests and other callers use
// the runner as the entry point for digest behavior.
export { buildDigestMessage, dueForDigest, findDecision, shouldSend, shouldSendDigest };

// D1's result size is bounded, so every scan is paged instead of silently
// stopping after the first 500 subscriptions.
const PAGE_SIZE = 500;
const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';

async function readRowsPaged(fetchPage) {
  const rows = [];
  let offset = 0;
  let previousPageKey = null;
  while (true) {
    const page = await fetchPage(offset);
    // Some test doubles ignore OFFSET. Stop rather than looping forever when
    // the same page comes back twice; real D1 pages advance normally.
    const pageKey = page.length
      ? JSON.stringify([page[0], page[page.length - 1]])
      : '';
    if (offset > 0 && pageKey && pageKey === previousPageKey) break;
    previousPageKey = pageKey;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
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
    rows = await readRowsPaged(async (offset) => {
      const result = await env.DB.prepare(`
        SELECT application_number,
               COALESCE(embassy_slug, embassy) AS embassy,
               MAX(last_alert_sent) AS last_alert_sent
        FROM push_subscriptions
        WHERE application_number IS NOT NULL AND application_number <> ''
        GROUP BY application_number, COALESCE(embassy_slug, embassy)
        ORDER BY application_number, embassy
        LIMIT ? OFFSET ?
      `).bind(PAGE_SIZE, offset).all();
      return result.results || [];
    });
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
  return readRowsPaged(async (offset) => {
    const result = await env.DB.prepare(`
      SELECT s.id, s.chat_id, s.application_number, s.embassy, s.last_alert_sent,
             COALESCE(s.immediate, 1) AS immediate,
             COALESCE(p.digest_frequency, 'off') AS digest_frequency,
             p.last_digest_sent,
             p.digest_started_at,
             COALESCE(p.digest_hour, 9) AS digest_hour,
             COALESCE(p.digest_timezone, 'UTC') AS digest_timezone
      FROM telegram_subscriptions s
      LEFT JOIN telegram_preferences p ON p.chat_id = s.chat_id
      WHERE s.active = 1
      ORDER BY s.id
      LIMIT ? OFFSET ?
    `).bind(PAGE_SIZE, offset).all();
    return result.results || [];
  });
}

// Backwards-compatible query for a deployment whose digest migration has not
// run yet. The schema migrator normally adds `immediate` before this is used.
async function legacyTelegramRows(env) {
  const rows = await readRowsPaged(async (offset) => {
    const result = await env.DB.prepare(`
      SELECT id, chat_id, application_number, embassy, last_alert_sent
      FROM telegram_subscriptions WHERE active = 1 ORDER BY id LIMIT ? OFFSET ?
    `).bind(PAGE_SIZE, offset).all();
    return result.results || [];
  });
  return rows.map((row) => ({
    ...row,
    immediate: 1,
    digest_frequency: 'off',
    last_digest_sent: null,
    digest_started_at: null,
    digest_hour: 9,
    digest_timezone: 'UTC'
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

// One message per office publication, not per application. This is the
// subscription for the long wait: the office has published a new file, even
// when the reader's own number is not in it yet.
async function runOfficeAlerts(env, report, dryRun) {
  if (!isTelegramConfigured(env)) return emptyCounters();
  await ensureTelegramSchema(env);
  let rows = [];
  try {
    rows = await readRowsPaged(async (offset) => {
      const result = await env.DB.prepare(`
        SELECT chat_id, office, last_report_date FROM office_subscriptions
        ORDER BY chat_id, office LIMIT ? OFFSET ?
      `).bind(PAGE_SIZE, offset).all();
      return result.results || [];
    });
  } catch (error) {
    console.warn('Office subscription query failed:', error.message);
    return emptyCounters();
  }
  if (!rows.length) return emptyCounters();

  const latestByOffice = new Map();
  const nameByOffice = new Map();
  for (const office of report.offices || []) {
    if (!office || !office.slug) continue;
    const date = String(office.report_date || '').slice(0, 10);
    if (date) latestByOffice.set(office.slug, date);
    nameByOffice.set(office.slug, office.name || office.slug);
  }
  const base = String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  let checked = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let wouldSend = 0;

  for (const row of rows) {
    const office = String(row.office || '');
    const latest = latestByOffice.get(office);
    if (!latest) {
      skipped += 1;
      continue;
    }
    checked += 1;
    if (row.last_report_date && latest <= String(row.last_report_date)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      wouldSend += 1;
      continue;
    }
    const result = await sendTelegram(
      env,
      row.chat_id,
      'New ' + (nameByOffice.get(office) || office) + ' decisions file published (' + latest + ').\n' +
        'Open the updated office page: ' + base + '/' + office + '-visa-decisions\n\n' +
        'Send /office off ' + office + ' to stop these office updates.'
    );
    if (!result.sent) {
      failed += 1;
      continue;
    }
    sent += 1;
    await env.DB.prepare(
      'UPDATE office_subscriptions SET last_report_date = ? WHERE chat_id = ? AND office = ?'
    ).bind(latest, row.chat_id, office).run().catch(() => {});
  }
  return { checked, matched: sent, sent, skipped, failed, would_send: wouldSend };
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
    // Applications opted back into immediate mode are handled by
    // runTelegramAlerts and must not appear in (or trigger) the chat digest.
    const digestRows = chatRows.filter((row) => Number(row.immediate) === 0);
    if (!digestRows.length) {
      skipped += 1;
      continue;
    }
    const schedule = {
      hour: chatRows[0].digest_hour,
      timeZone: chatRows[0].digest_timezone
    };
    const digestAnchor = [chatRows[0].last_digest_sent, chatRows[0].digest_started_at]
      .filter(Boolean).sort().pop() || null;
    if (!dueForDigest(digestAnchor, frequency, Date.now(), schedule)) {
      skipped += 1;
      continue;
    }

    checked += digestRows.length;
    const states = digestRows.map((row) => {
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
    if (!shouldSendDigest(frequency, changes.length)) {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      wouldSend += 1;
      continue;
    }

    const result = await sendTelegram(env, chatId, buildDigestMessage(states, {
      baseUrl: env.APP_BASE_URL || DEFAULT_BASE,
      timeZone: schedule.timeZone
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
    const offices = await runOfficeAlerts(env, report, dryRun);
    const digests = await runTelegramDigests(env, report, dryRun);
    return json({
      ok: push.failed === 0 && telegram.failed === 0 && offices.failed === 0 && digests.failed === 0,
      checked: push.checked + telegram.checked + offices.checked + digests.checked,
      matched: push.matched + telegram.matched + offices.matched + digests.matched,
      sent: push.sent + telegram.sent + offices.sent + digests.sent,
      skipped: push.skipped + telegram.skipped + offices.skipped + digests.skipped,
      failed: push.failed + telegram.failed + offices.failed + digests.failed,
      would_send: push.would_send + telegram.would_send + offices.would_send + digests.would_send,
      push_checked: push.checked,
      push_sent: push.sent,
      telegram_checked: telegram.checked,
      telegram_sent: telegram.sent,
      office_checked: offices.checked,
      office_sent: offices.sent,
      digest_checked: digests.checked,
      digest_sent: digests.sent,
      dry_run: dryRun
    });
  } catch (error) {
    console.error('Alert runner failed:', error);
    return json({ error: 'Alert runner failed' }, 500);
  }
}
