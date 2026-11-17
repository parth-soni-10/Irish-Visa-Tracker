/**
 * Telegram decision alerts.
 *
 * Telegram needs no sending domain and no business verification: a bot created
 * with BotFather can message anyone who presses Start. Subscriptions are
 * anonymous and linked through a single-use token so the site never asks a
 * visitor for a chat id.
 *
 * Chats can choose a consolidated daily or weekly digest. Immediate alerts are
 * the default; in digest mode every linked application is grouped, with
 * `/immediate <number>` available for one application that should still arrive
 * as soon as it is published.
 */

import { EMBASSIES, json } from './email-utils.js';
import { loadReportData } from './report-data.js';
import {
  DEFAULT_BASE_URL,
  buildDigestMessage,
  describeDigest,
  digestTimeZone,
  findDecision,
  formatDigestHour,
  normalizeDigestHour,
  normalizeDigestTimeZone,
  parseDigestHour,
  shouldSend
} from './digest.js';

const API_BASE = 'https://api.telegram.org/bot';
const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_TEXT = 4000;
const DIGEST_FREQUENCIES = new Set(['off', 'daily', 'weekly']);

// One getMe per worker isolate is enough; the username never changes.
let cachedUsername = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  immediate INTEGER NOT NULL DEFAULT 1,
  last_alert_sent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(chat_id, application_number, embassy)
);
CREATE INDEX IF NOT EXISTS idx_telegram_active ON telegram_subscriptions(active);
CREATE TABLE IF NOT EXISTS telegram_links (
  token TEXT PRIMARY KEY,
  application_number TEXT NOT NULL,
  embassy TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS telegram_preferences (
  chat_id TEXT PRIMARY KEY,
  digest_frequency TEXT NOT NULL DEFAULT 'off',
  last_digest_sent TEXT,
  digest_hour INTEGER NOT NULL DEFAULT 9,
  digest_timezone TEXT NOT NULL DEFAULT 'UTC',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const HELP_TEXT = [
  'Irish Visa Decision Tracker',
  '',
  'Open the tracker, enter your application number and press “Get alerts on Telegram”, then press Start here.',
  '',
  '/status - list linked applications and their alert mode',
  '/digest daily [hour timezone] - one grouped update a day, only when something changes',
  '/digest weekly [hour timezone] - one weekly summary, including “no change”',
  '/digest status - show your frequency, delivery hour, timezone and last send',
  '/digest preview - send what the next digest would contain now; changes nothing',
  '/digest off - back to immediate alerts',
  'Example: /digest daily 8 Europe/Dublin',
  '/immediate 12345678 - keep one application immediate while the chat is in digest mode',
  '/stop - turn off every Telegram alert for this chat'
].join('\n');

export function isTelegramConfigured(env) {
  return Boolean(env && String(env.TELEGRAM_BOT_TOKEN || '').trim());
}

export async function ensureTelegramSchema(env) {
  if (!env || !env.DB) throw new Error('Database not configured');
  const statements = SCHEMA.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }

  // Existing deployments created these tables before digest mode and preferred
  // delivery hours. Add each column once; D1/SQLite reports a duplicate-column
  // error on rerun.
  await addColumnIfMissing(env, 'telegram_subscriptions', 'immediate', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(env, 'telegram_preferences', 'digest_hour', 'INTEGER NOT NULL DEFAULT 9');
  await addColumnIfMissing(env, 'telegram_preferences', 'digest_timezone', "TEXT NOT NULL DEFAULT 'UTC'");
}

async function addColumnIfMissing(env, table, column, definition) {
  try {
    const info = await env.DB.prepare('PRAGMA table_info(' + table + ')').all();
    const columns = Array.isArray(info && info.results) ? info.results : [];
    if (!columns.some((entry) => String(entry.name || '').toLowerCase() === column.toLowerCase())) {
      await env.DB.prepare('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition).run();
    }
  } catch (error) {
    if (!/duplicate|already exists/i.test(String(error && error.message || error))) {
      throw error;
    }
  }
}

function cleanChatId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^-?\d{5,20}$/.test(id) ? id : '';
}

function cleanChannelTarget(value) {
  const id = String(value == null ? '' : value).trim();
  return /^-?\d{5,20}$/.test(id) || /^@[A-Za-z0-9_]{3,64}$/.test(id) ? id : '';
}

async function telegramApi(env, method, payload) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) throw new Error('Telegram bot token is not configured');
  const response = await fetch(API_BASE + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(10000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    // Never include the request URL: it contains the bot token.
    throw new Error(
      'Telegram ' + method + ' failed (' + response.status + '): ' +
        String(data.description || '').slice(0, 160)
    );
  }
  return data;
}

export async function sendTelegram(env, chatId, body) {
  if (!isTelegramConfigured(env)) {
    return { sent: 0, error: 'Telegram delivery is not configured' };
  }
  const id = cleanChatId(chatId);
  if (!id) return { sent: 0, error: 'A numeric Telegram chat id is required' };
  const text = String(body || '').trim().slice(0, MAX_TEXT);
  if (!text) return { sent: 0, error: 'Message body is empty' };
  try {
    const data = await telegramApi(env, 'sendMessage', {
      chat_id: id,
      text,
      disable_web_page_preview: true
    });
    return { sent: 1, message_id: (data.result && data.result.message_id) || null };
  } catch (error) {
    return { sent: 0, error: String(error.message || error).slice(0, 200) };
  }
}

/** Public channel posts use the same Bot API but accept a numeric id or @handle. */
export async function sendTelegramChannel(env, channelId, body) {
  if (!isTelegramConfigured(env)) {
    return { sent: 0, error: 'Telegram delivery is not configured' };
  }
  const id = cleanChannelTarget(channelId);
  if (!id) return { sent: 0, error: 'A numeric channel id or @channel handle is required' };
  const text = String(body || '').trim().slice(0, MAX_TEXT);
  if (!text) return { sent: 0, error: 'Message body is empty' };
  try {
    const data = await telegramApi(env, 'sendMessage', {
      chat_id: id,
      text,
      disable_web_page_preview: true
    });
    return { sent: 1, message_id: (data.result && data.result.message_id) || null };
  } catch (error) {
    return { sent: 0, error: String(error.message || error).slice(0, 200) };
  }
}

async function reply(env, chatId, text) {
  await sendTelegram(env, chatId, text);
}

async function botUsername(env) {
  const configured = String(env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  if (configured) return configured;
  if (cachedUsername) return cachedUsername;
  const data = await telegramApi(env, 'getMe', {});
  cachedUsername = (data.result && data.result.username) || null;
  return cachedUsername;
}

async function chatPreferences(env, chatId) {
  try {
    return await env.DB.prepare(
      'SELECT digest_frequency, last_digest_sent, digest_hour, digest_timezone FROM telegram_preferences WHERE chat_id = ?'
    ).bind(chatId).first();
  } catch {
    return null;
  }
}

function preferenceParts(preference) {
  const frequency = preference && DIGEST_FREQUENCIES.has(preference.digest_frequency)
    ? preference.digest_frequency : 'off';
  return {
    frequency,
    hour: normalizeDigestHour(preference && preference.digest_hour),
    timeZone: digestTimeZone(preference && preference.digest_timezone),
    lastSent: preference && preference.last_digest_sent ? String(preference.last_digest_sent) : null
  };
}

function digestStatus(frequency, hour, timeZone) {
  return describeDigest(frequency, hour, timeZone);
}

function formatDigestSentAt(value) {
  if (!value) return 'not sent yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-IE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(date) + ' UTC';
}

function digestStatusMessage(preference, linkedCount) {
  const { frequency, hour, timeZone, lastSent } = preferenceParts(preference);
  const lines = [];
  if (frequency === 'off') {
    lines.push('Digest: off — immediate alerts are on for linked applications.');
    lines.push('Preferred delivery hour when enabled: ' + formatDigestHour(hour) + ' ' + timeZone + '.');
  } else {
    lines.push('Digest: ' + digestStatus(frequency, hour, timeZone) + '.');
    lines.push('Last digest: ' + formatDigestSentAt(lastSent) + '.');
  }
  lines.push('Linked applications: ' + linkedCount + '.');
  lines.push('Telegram-only: browser watchlist entries stay on the device and are not included.');
  lines.push('Send /digest preview to see the next message without changing the schedule.');
  return lines.join('\n');
}

async function chatDigestRows(env, chatId) {
  const result = await env.DB.prepare(
    'SELECT application_number, embassy, last_alert_sent FROM telegram_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY created_at'
  ).bind(chatId).all();
  return (result && result.results) || [];
}

async function buildDigestPreview(env, request, chatId, preference) {
  const rows = await chatDigestRows(env, chatId);
  if (!rows.length) {
    return 'No applications linked. Open the tracker and press “Get alerts on Telegram”.';
  }

  let report;
  try {
    report = await loadReportData(env, request);
  } catch (error) {
    console.error('Telegram digest preview data failed:', error.message);
    return 'Could not build a digest preview right now. Try again later.';
  }

  const { timeZone } = preferenceParts(preference);
  const states = rows.map((row) => {
    const decision = findDecision(report.rows, row.application_number, row.embassy);
    return {
      ...row,
      decision: decision && shouldSend(row.last_alert_sent, decision.date) ? decision : null
    };
  });
  return 'Digest preview — nothing was sent and the schedule is unchanged.\n\n' +
    buildDigestMessage(states, {
      baseUrl: env.APP_BASE_URL || DEFAULT_BASE_URL,
      timeZone
    });
}

/**
 * Create a 15-minute, single-use deep link for one application. The bot's
 * /start handler consumes the token and records the chat id, so the browser
 * never sees or supplies a chat id.
 */
export async function handleTelegramStart(request, env) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Malformed body' }, 400); }
  const applicationNumber = String(body.application_number || '').trim();
  const embassy = String(body.embassy || '').trim();
  if (!/^\d{8}$/.test(applicationNumber)) {
    return json({ error: 'application_number must be 8 digits' }, 400);
  }
  if (!EMBASSIES.has(embassy)) return json({ error: 'Invalid embassy' }, 400);
  if (!isTelegramConfigured(env)) {
    return json({ error: 'Telegram alerts are not configured on this deployment' }, 503);
  }

  let username = null;
  try {
    username = await botUsername(env);
  } catch (error) {
    console.error('Telegram getMe failed:', error.message);
  }
  if (!username || !/^[A-Za-z0-9_]{3,64}$/.test(username)) {
    return json({ error: 'Telegram bot username is unavailable' }, 503);
  }

  await ensureTelegramSchema(env);
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
  await env.DB.prepare("DELETE FROM telegram_links WHERE datetime(expires_at) <= datetime('now')").run().catch(() => {});
  await env.DB.prepare(
    'INSERT INTO telegram_links (token, application_number, embassy, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(token, applicationNumber, embassy, expiresAt).run();

  return json({
    ok: true,
    url: 'https://t.me/' + username + '?start=' + token,
    expires_at: expiresAt
  });
}

/**
 * Telegram webhook. Always answer 200 for updates we ignore so Telegram does
 * not retry them; only a bad secret is rejected.
 */
export async function handleTelegramWebhook(request, env) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  const secret = String(env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  // Fail closed: without a secret there is no way to tell Telegram from an
  // arbitrary caller, so refuse every update instead of trusting the body.
  if (!secret) {
    console.error('Telegram webhook rejected: TELEGRAM_WEBHOOK_SECRET is not configured');
    return json({ error: 'Telegram webhook is not configured' }, 503);
  }
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let update;
  try { update = await request.json(); } catch { return json({ ok: true }); }
  const message = update && update.message;
  const chatId = message && message.chat ? message.chat.id : null;
  const text = String((message && message.text) || '').trim();
  if (!chatId || !text) return json({ ok: true });

  const id = String(chatId);
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase().split('@')[0];
  const argument = parts[1] || '';
  await ensureTelegramSchema(env);

  if (command === '/start') {
    if (!argument) {
      await reply(env, id, HELP_TEXT);
      return json({ ok: true });
    }
    const link = await env.DB.prepare(
      "SELECT application_number, embassy FROM telegram_links WHERE token = ? AND datetime(expires_at) > datetime('now')"
    ).bind(argument).first();
    if (!link) {
      await reply(env, id, 'That link is invalid or has expired. Open the tracker and press “Get alerts on Telegram” again.');
      return json({ ok: true });
    }
    const preference = await chatPreferences(env, id);
    const current = preferenceParts(preference);
    const frequency = current.frequency;
    const immediate = frequency === 'off' ? 1 : 0;
    await env.DB.prepare(`
      INSERT INTO telegram_subscriptions (chat_id, application_number, embassy, active, immediate)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(chat_id, application_number, embassy) DO UPDATE SET active = 1, immediate = excluded.immediate
    `).bind(id, link.application_number, link.embassy, immediate).run();
    await env.DB.prepare('DELETE FROM telegram_links WHERE token = ?').bind(argument).run();
    await reply(
      env,
      id,
      'Alerts enabled for ' + link.application_number + ' (' + link.embassy + ').\n' +
        'This chat uses ' + digestStatus(frequency, current.hour, current.timeZone) + '.\n' +
        'Send /status to see every linked application.'
    );
    return json({ ok: true });
  }

  if (command === '/digest') {
    const action = String(argument || '').toLowerCase();

    if (action === 'status') {
      const preference = await chatPreferences(env, id);
      const linked = await chatDigestRows(env, id);
      await reply(env, id, digestStatusMessage(preference, linked.length));
      return json({ ok: true });
    }

    if (action === 'preview') {
      const preference = await chatPreferences(env, id);
      await reply(env, id, await buildDigestPreview(env, request, id, preference));
      return json({ ok: true });
    }

    if (!DIGEST_FREQUENCIES.has(action)) {
      await reply(
        env,
        id,
        'Choose a digest frequency or option for applications linked to this chat:\n' +
          '/digest daily [hour timezone]\n' +
          '/digest weekly [hour timezone]\n' +
          '/digest status\n' +
          '/digest preview\n' +
          '/digest off\n' +
          'Example: /digest daily 8 Europe/Dublin'
      );
      return json({ ok: true });
    }

    const current = preferenceParts(await chatPreferences(env, id));
    let hour = current.hour;
    let timeZone = current.timeZone;
    if (parts[2]) {
      const parsedHour = parseDigestHour(parts[2]);
      if (parsedHour === null) {
        await reply(env, id, 'Use a delivery hour from 0 to 23, for example:\n/digest daily 8 Europe/Dublin');
        return json({ ok: true });
      }
      hour = parsedHour;
    }
    if (parts[3]) {
      const parsedZone = normalizeDigestTimeZone(parts[3]);
      if (!parsedZone) {
        await reply(env, id, 'That timezone is not recognized. Use an IANA name such as Europe/Dublin or America/New_York.');
        return json({ ok: true });
      }
      timeZone = parsedZone;
    }
    if (parts[4]) {
      await reply(env, id, 'Use /digest daily 8 Europe/Dublin or /digest weekly 18:00 America/New_York.');
      return json({ ok: true });
    }

    const frequency = action;
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO telegram_preferences (chat_id, digest_frequency, last_digest_sent, digest_hour, digest_timezone, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(chat_id) DO UPDATE SET
        digest_frequency = excluded.digest_frequency,
        last_digest_sent = excluded.last_digest_sent,
        digest_hour = excluded.digest_hour,
        digest_timezone = excluded.digest_timezone,
        updated_at = datetime('now')
    `).bind(id, frequency, frequency === 'off' ? null : now, hour, timeZone).run();
    await env.DB.prepare('UPDATE telegram_subscriptions SET immediate = ? WHERE chat_id = ?')
      .bind(frequency === 'off' ? 1 : 0, id).run();
    await reply(
      env,
      id,
      frequency === 'off'
        ? 'Digest off. Each linked application will send immediately when its decision is published.\n' +
          'Preferred delivery hour kept for later: ' + formatDigestHour(hour) + ' ' + timeZone + '.'
        : 'Digest on: ' + digestStatus(frequency, hour, timeZone) + '.\n' +
          'Only applications linked to this chat are included; browser watchlist entries stay on the device.\n' +
          'Immediate alerts are off for this chat. Use /immediate 12345678 to keep one application immediate.\n' +
          (frequency === 'daily'
            ? 'Daily digests are sent only when something changes.'
            : 'Weekly digests include a no-change summary.')
    );
    return json({ ok: true });
  }

  if (command === '/immediate') {
    if (!/^\d{8}$/.test(argument)) {
      await reply(env, id, 'Use /immediate followed by the 8-digit application number, for example:\n/immediate 12345678');
      return json({ ok: true });
    }
    const linked = await env.DB.prepare(
      'SELECT 1 AS linked FROM telegram_subscriptions WHERE chat_id = ? AND application_number = ? AND active = 1'
    ).bind(id, argument).first();
    if (!linked) {
      await reply(env, id, 'No active alert is linked to ' + argument + '. Use /status to see your linked applications.');
      return json({ ok: true });
    }
    await env.DB.prepare(
      'UPDATE telegram_subscriptions SET immediate = 1 WHERE chat_id = ? AND application_number = ? AND active = 1'
    ).bind(id, argument).run();
    await reply(
      env,
      id,
      'Immediate alerts enabled for ' + argument + '. Other linked applications stay in the digest.'
    );
    return json({ ok: true });
  }

  if (command === '/stop') {
    await env.DB.prepare('UPDATE telegram_subscriptions SET active = 0 WHERE chat_id = ?').bind(id).run();
    await env.DB.prepare("UPDATE telegram_preferences SET digest_frequency = 'off', last_digest_sent = NULL WHERE chat_id = ?")
      .bind(id).run().catch(() => {});
    await reply(env, id, 'Telegram alerts are off for this chat.');
    return json({ ok: true });
  }

  if (command === '/status') {
    const rows = (await env.DB.prepare(
      'SELECT application_number, embassy, COALESCE(immediate, 1) AS immediate FROM telegram_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY created_at'
    ).bind(id).all()).results || [];
    const preference = await chatPreferences(env, id);
    const current = preferenceParts(preference);
    await reply(
      env,
      id,
      rows.length
        ? 'Linked applications:\n' + rows.map((row) => {
            const mode = Number(row.immediate) === 0 ? 'digest' : 'immediate';
            return '- ' + row.application_number + ' (' + row.embassy + ') — ' + mode;
          }).join('\n') + '\n\nChat mode: ' + digestStatus(current.frequency, current.hour, current.timeZone) +
          '\nDelivery hour: ' + formatDigestHour(current.hour) + ' ' + current.timeZone
        : 'No applications linked. Open the tracker and press “Get alerts on Telegram”.'
    );
    return json({ ok: true });
  }

  await reply(env, id, HELP_TEXT);
  return json({ ok: true });
}
