#!/usr/bin/env node
/**
 * Register or remove the Telegram webhook for this deployment.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *     node tools/setup-telegram-webhook.mjs set
 *   TELEGRAM_BOT_TOKEN=... node tools/setup-telegram-webhook.mjs info
 *   TELEGRAM_BOT_TOKEN=... node tools/setup-telegram-webhook.mjs delete
 *
 * APP_BASE_URL defaults to the production origin. The bot token is never
 * printed and must come from the environment, never from this repository.
 */

const action = String(process.argv[2] || 'set').toLowerCase();
const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
const base = String(process.env.APP_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

async function call(method, payload) {
  const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    console.error('Telegram ' + method + ' failed (' + response.status + '): ' + String(data.description || ''));
    process.exit(1);
  }
  return data.result;
}

if (action === 'set') {
  if (!secret) {
    console.error('TELEGRAM_WEBHOOK_SECRET is required: without it the webhook rejects every update.');
    process.exit(1);
  }
  const url = base + '/api/telegram/webhook';
  const payload = { url, allowed_updates: ['message'], drop_pending_updates: true, secret_token: secret };
  const result = await call('setWebhook', payload);
  console.log('Webhook set:', url, result && result.description ? '(' + result.description + ')' : '');
} else if (action === 'delete') {
  await call('deleteWebhook', { drop_pending_updates: true });
  console.log('Webhook removed');
} else if (action === 'info') {
  const info = await call('getWebhookInfo', {});
  console.log(JSON.stringify({
    url: info.url || '',
    pending_update_count: info.pending_update_count || 0,
    last_error_message: info.last_error_message || null
  }, null, 2));
} else {
  console.error('Usage: node tools/setup-telegram-webhook.mjs [set|delete|info]');
  process.exit(1);
}
