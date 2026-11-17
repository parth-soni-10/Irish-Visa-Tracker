#!/usr/bin/env node
/**
 * Ask production to announce any newly published official files in the
 * Telegram channel. Called after the production build check, so the feed being
 * read is the deployment this commit just verified.
 *
 * The Cloudflare deployment owns TELEGRAM_CHANNEL_ID and the bot token. This
 * script only needs the cron secret GitHub already uses for scheduled work.
 * When no channel is configured the endpoint returns a normal skipped response
 * and this step stays green.
 */

const base = String(process.env.OFFICIAL_FEED_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
const secret = String(process.env.BROADCAST_SECRET || '').trim();

if (!secret) {
  console.log('Official-file broadcast skipped: BROADCAST_SECRET is not configured.');
  process.exit(0);
}

try {
  const response = await fetch(base + '/api/telegram/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cron-Secret': secret
    },
    body: '{}',
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Official-file broadcast failed: HTTP ' + response.status + ' ' + JSON.stringify(body));
    process.exit(1);
  }
  if (body.skipped) {
    console.log('Official-file broadcast skipped: ' + body.skipped);
  } else if (body.seeded) {
    console.log('Official-file broadcast seeded ' + body.seeded + ' existing entries; no backfill messages sent.');
  } else {
    console.log('Official-file broadcast sent ' + (body.sent || 0) + ' new item(s).');
  }
} catch (error) {
  console.error('Official-file broadcast request failed:', error.message);
  process.exit(1);
}
