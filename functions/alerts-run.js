/**
 * Decision alert runner.
 *
 * This is the missing "check again" half of the alert pipeline. It is called by
 * a scheduler with X-Cron-Secret, loads the published decision files, matches
 * verified subscriptions against the current office snapshots, sends at most
 * one email per decision date, and records last_alert_sent so a retry is
 * idempotent.
 *
 * It never returns email addresses or tokens.
 */

import { ensureEmailSchema } from './email4.js';
import { isEmailConfigured, sendEmail } from './email-send.js';
import { loadReportData } from './report-data.js';
import { createNotification } from './notifications.js';
import { ensurePortalSchema } from './portal-schema.js';
import { isChannelConfigured, sendChannel } from './notify-channels.js';

const MAX_ALERTS = 250;
const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';

function normalizeNumber(value) {
  return String(value || '').replace(/\s+/g, '').replace(/^IRL/i, '').toUpperCase();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

function unsubscribeUrl(env, token) {
  const base = String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  return token
    ? base + '/api/unsubscribe?token=' + encodeURIComponent(token)
    : base + '/contact';
}

function alertEmail(env, alert, decision) {
  const app = escapeHtml(alert.application_number);
  const office = escapeHtml(alert.embassy);
  const status = escapeHtml(decision.decision);
  const date = escapeHtml(decision.date);
  const unsub = escapeHtml(unsubscribeUrl(env, alert.unsubscribe_token));
  const subject = 'Visa ' + decision.decision + ' for ' + alert.application_number;
  const html = [
    '<h2 style="color:' + (decision.decision === 'Approved' ? '#047857' : '#b91c1c') + '">Application ' + status + '</h2>',
    '<p><strong>Application:</strong> ' + app + '</p>',
    '<p><strong>Office:</strong> ' + office + '</p>',
    '<p><strong>Published date:</strong> ' + date + '</p>',
    '<p><strong>Outcome:</strong> ' + status + '</p>',
    '<p><a href="https://www.irishimmigration.ie/visa-decisions/" style="background:#059669;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View official decisions</a></p>',
    '<p style="color:#666;font-size:12px;">This is a convenience alert over a published decision. Confirm it on the official source before acting on it.</p>',
    '<hr><p style="color:#999;font-size:11px;"><a href="' + unsub + '">Unsubscribe from this alert</a></p>'
  ].join('');
  const text = [
    'Application ' + alert.application_number + ' was ' + decision.decision + '.',
    'Office: ' + alert.embassy,
    'Published date: ' + decision.date,
    'Official source: https://www.irishimmigration.ie/visa-decisions/',
    'Unsubscribe: ' + unsubscribeUrl(env, alert.unsubscribe_token)
  ].join('\n');
  return { subject, html, text };
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
             MAX(last_alert_sent) AS last_alert_sent,
             GROUP_CONCAT(DISTINCT user_id) AS user_ids
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
      for (const userId of String(row.user_ids || '').split(',').filter(Boolean)) {
        await createNotification(env, {
          userId,
          type: 'decision',
          title: 'Visa ' + decision.decision + ': ' + row.application_number,
          body: 'Published ' + decision.date + ' for ' + row.embassy + '.',
          url: '/?tab=home&q=' + encodeURIComponent(row.application_number)
        });
      }
    } else {
      failed += 1;
    }
  }

  return { checked: rows.length, matched, sent, skipped, failed, would_send: wouldSend };
}

async function runChannelAlerts(env, report, dryRun) {
  const configuredChannels = ['sms', 'whatsapp'].filter((channel) => isChannelConfigured(env, channel));
  if (!configuredChannels.length) {
    return { checked: 0, matched: 0, sent: 0, skipped: 0, failed: 0, would_send: 0 };
  }
  await ensurePortalSchema(env);
  let rows = [];
  try {
    const placeholders = configuredChannels.map(() => '?').join(', ');
    const result = await env.DB.prepare(`
      SELECT w.user_id, w.application_number, w.embassy_slug AS embassy,
             w.last_alert_sent, c.channel, c.address
      FROM watchlists w
      JOIN user_channels c ON c.user_id = w.user_id
      WHERE c.verified = 1 AND c.consent_at IS NOT NULL
        AND c.channel IN (${placeholders})
        AND ((c.channel = 'sms' AND w.notify_sms = 1)
          OR (c.channel = 'whatsapp' AND w.notify_whatsapp = 1))
      ORDER BY w.id LIMIT ?
    `).bind(...configuredChannels, MAX_ALERTS).all();
    rows = result.results || [];
  } catch (error) {
    console.warn('Channel alert query failed:', error.message);
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
      '/?tab=home&q=' + encodeURIComponent(row.application_number);
    const result = await sendChannel(env, row.channel, row.address, message);
    if (!result.sent) {
      failed += 1;
      continue;
    }
    sent += 1;
    await env.DB.prepare(`
      UPDATE watchlists SET last_alert_sent = ?
      WHERE user_id = ? AND application_number = ? AND embassy_slug = ?
    `).bind(decision.date, row.user_id, row.application_number, row.embassy).run().catch(() => {});
    await createNotification(env, {
      userId: row.user_id,
      type: 'decision',
      title: 'Visa ' + decision.decision + ': ' + row.application_number,
      body: 'Published ' + decision.date + ' for ' + row.embassy + '.',
      url: '/?tab=home&q=' + encodeURIComponent(row.application_number)
    });
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
  const emailConfigured = isEmailConfigured(env);
  const pushConfigured = isPushConfigured(env);
  const channelConfigured = anyChannelConfigured(env);
  if (!emailConfigured && !pushConfigured && !channelConfigured) {
    return json({ error: 'No alert delivery channel is configured' }, 503);
  }

  const dryRun = new URL(request.url).searchParams.get('dry_run') === '1';
  try {
    let alerts = [];
    if (emailConfigured) {
      await ensureEmailSchema(env);
      const result = await env.DB.prepare(`
        SELECT id, user_id, email, application_number, embassy, unsubscribe_token, last_alert_sent
        FROM email_subscriptions
        WHERE verified = 1
          AND unsubscribed = 0
          AND application_number <> ''
        ORDER BY id
        LIMIT ?
      `).bind(MAX_ALERTS).all();
      alerts = result.results || [];
    }

    const report = await loadReportData(env, request);
    let matched = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let wouldSend = 0;

    for (const alert of alerts) {
      const decision = findDecision(report.rows, alert.application_number, alert.embassy);
      if (!decision) {
        skipped += 1;
        continue;
      }
      matched += 1;
      if (!shouldSend(alert.last_alert_sent, decision.date)) {
        skipped += 1;
        continue;
      }
      if (dryRun) {
        wouldSend += 1;
        continue;
      }

      try {
        const mail = alertEmail(env, alert, decision);
        await sendEmail(env, {
          from: env.EMAIL_FROM,
          to: alert.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text
        });
        await env.DB.prepare('UPDATE email_subscriptions SET last_alert_sent = ? WHERE id = ?')
          .bind(decision.date, alert.id).run();
        sent += 1;

        if (alert.user_id) {
          await createNotification(env, {
            userId: alert.user_id,
            type: 'decision',
            title: 'Visa ' + decision.decision + ': ' + alert.application_number,
            body: 'Published ' + decision.date + ' for ' + alert.embassy + '.',
            url: '/?tab=home&q=' + encodeURIComponent(alert.application_number)
          });
        }

      } catch (error) {
        failed += 1;
        console.error('Decision alert failed for application', alert.application_number, error.message);
      }
    }

    const push = await runPushAlerts(env, report, dryRun);
    const channels = await runChannelAlerts(env, report, dryRun);
    return json({
      ok: failed === 0 && push.failed === 0 && channels.failed === 0,
      checked: alerts.length + push.checked + channels.checked,
      matched: matched + push.matched + channels.matched,
      sent: sent + channels.sent,
      skipped: skipped + push.skipped + channels.skipped,
      failed: failed + push.failed + channels.failed,
      would_send: wouldSend + push.would_send + channels.would_send,
      push_checked: push.checked,
      push_sent: push.sent,
      channel_checked: channels.checked,
      channel_sent: channels.sent,
      dry_run: dryRun
    });
  } catch (error) {
    console.error('Alert runner failed:', error);
    return json({ error: 'Alert runner failed' }, 500);
  }
}
