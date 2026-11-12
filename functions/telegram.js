/**
 * Telegram decision alerts.
 *
 * Telegram needs no sending domain and no business verification: a bot created
 * with BotFather can message anyone who presses Start. Subscriptions are
 * anonymous, like the email alert list, and are linked through a single-use
 * token so the site never asks a visitor for a chat id.
 */

import { EMBASSIES, json } from './email-utils.js';

const API_BASE = 'https://api.telegram.org/bot';
const LINK_TTL_MS = 15 * 60 * 1000;
const MAX_TEXT = 4000;

// One getMe per worker isolate is enough; the username never changes.
let cachedUsername = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
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
`;

const HELP_TEXT = [
  'Irish Visa Decision Tracker',
  '',
  'Open the tracker, enter your application number and press “Get alerts on Telegram”, then press Start here.',
  '',
  '/status - list linked applications',
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
}

function cleanChatId(value) {
  const id = String(value == null ? '' : value).trim();
  return /^-?\d{5,20}$/.test(id) ? id : '';
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
    await env.DB.prepare(`
      INSERT INTO telegram_subscriptions (chat_id, application_number, embassy, active)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(chat_id, application_number, embassy) DO UPDATE SET active = 1
    `).bind(id, link.application_number, link.embassy).run();
    await env.DB.prepare('DELETE FROM telegram_links WHERE token = ?').bind(argument).run();
    await reply(
      env,
      id,
      'Alerts enabled for ' + link.application_number + ' (' + link.embassy + ').\n' +
        'I will message you when a decision is published. Send /stop to turn alerts off.'
    );
    return json({ ok: true });
  }

  if (command === '/stop') {
    await env.DB.prepare('UPDATE telegram_subscriptions SET active = 0 WHERE chat_id = ?').bind(id).run();
    await reply(env, id, 'Telegram alerts are off for this chat.');
    return json({ ok: true });
  }

  if (command === '/status') {
    const rows = (await env.DB.prepare(
      'SELECT application_number, embassy FROM telegram_subscriptions WHERE chat_id = ? AND active = 1 ORDER BY created_at'
    ).bind(id).all()).results || [];
    await reply(
      env,
      id,
      rows.length
        ? 'Linked applications:\n' + rows.map((row) => '- ' + row.application_number + ' (' + row.embassy + ')').join('\n')
        : 'No applications linked. Open the tracker and press “Get alerts on Telegram”.'
    );
    return json({ ok: true });
  }

  await reply(env, id, HELP_TEXT);
  return json({ ok: true });
}
