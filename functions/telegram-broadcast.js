/**
 * Announce newly published official files in a Telegram channel.
 *
 * This is intentionally separate from per-application alerts: it contains no
 * applicant rows and posts at most one message per office report. The first
 * run seeds the current history without backfilling the channel; later runs post
 * only entries that have not been announced.
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID. The channel id can be a
 * numeric -100... id or an @channelusername. The route is protected by the same
 * cron secret as the alert runner.
 */

import { ensureTelegramSchema, isTelegramConfigured, sendTelegramChannel } from './telegram.js';
import { buildOfficialFeed } from './official-feed.js';

const CHANNEL_SCHEMA = `
CREATE TABLE IF NOT EXISTS telegram_official_announcements (
  entry_id TEXT PRIMARY KEY,
  announced_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;
const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const BATCH_SIZE = 8;

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

async function ensureAnnouncementSchema(env) {
  await ensureTelegramSchema(env);
  const statements = CHANNEL_SCHEMA.split(';').map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

async function loadJson(env, request, path) {
  const url = new URL(path, request.url);
  try {
    if (env && env.ASSETS) {
      const response = await env.ASSETS.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
      if (response.ok) return await response.json();
    }
  } catch (error) {
    console.warn(`Broadcast asset read failed for ${path}:`, error.message);
  }
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn(`Broadcast fetch failed for ${path}:`, error.message);
  }
  return null;
}

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-IE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  });
}

export function buildAnnouncement(entry, baseUrl) {
  const source = entry.source_file || entry.source_page;
  const lines = [
    'New official file — ' + entry.office_name,
    '',
    formatDate(entry.report_date) + ' · ' + entry.decisions.toLocaleString('en-IE') + ' decisions',
    'Approved ' + entry.approved.toLocaleString('en-IE') + ' · Refused ' + entry.refused.toLocaleString('en-IE')
  ];
  if (entry.added) lines.push('Added since previous report: ' + entry.added.toLocaleString('en-IE'));
  if (entry.removed) lines.push('Removed since previous report: ' + entry.removed.toLocaleString('en-IE'));
  if (entry.corrections) lines.push('Corrected rows: ' + entry.corrections.toLocaleString('en-IE'));
  lines.push(
    '',
    'Official file: ' + source,
    'Tracker: ' + String(baseUrl).replace(/\/+$/, '') + '/status#office-coverage'
  );
  return lines.join('\n');
}

export async function handleTelegramBroadcast(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const expected = env.ALERTS_CRON_SECRET || env.SCRAPER_CRON_SECRET;
  if (!expected) return json({ error: 'Broadcast secret is not configured' }, 503);
  if (suppliedSecret(request) !== expected) return json({ error: 'Invalid or missing cron secret' }, 401);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  if (!isTelegramConfigured(env) || !String(env.TELEGRAM_CHANNEL_ID || '').trim()) {
    return json({ ok: true, skipped: 'telegram_channel_not_configured', seeded: 0, sent: 0 });
  }

  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry_run') === '1';
  const baseUrl = String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  try {
    const [reports, manifest] = await Promise.all([
      loadJson(env, request, '/data/reports/index.json'),
      loadJson(env, request, '/data/data_manifest.json')
    ]);
    const feed = buildOfficialFeed(reports, {
      manifest,
      baseUrl,
      channelUrl: env.TELEGRAM_CHANNEL_URL
    });
    await ensureAnnouncementSchema(env);

    const existing = (await env.DB.prepare('SELECT entry_id FROM telegram_official_announcements').all()).results || [];
    const announced = new Set(existing.map((row) => String(row.entry_id)));

    // First run: mark the existing history as already known. A new channel
    // should not receive fifty historical files, and the next genuinely new
    // file will be the first post.
    if (!announced.size && feed.entries.length) {
      if (dryRun) return json({ ok: true, dry_run: true, seeded: feed.entries.length, sent: 0 });
      for (const entry of feed.entries) {
        await env.DB.prepare('INSERT OR IGNORE INTO telegram_official_announcements (entry_id) VALUES (?)')
          .bind(entry.id).run();
      }
      return json({ ok: true, seeded: feed.entries.length, sent: 0 });
    }

    const candidates = feed.entries
      .filter((entry) => !announced.has(entry.id))
      .sort((a, b) => a.report_date.localeCompare(b.report_date) || a.fetched_at.localeCompare(b.fetched_at))
      .slice(0, BATCH_SIZE);
    if (!candidates.length) return json({ ok: true, seeded: 0, sent: 0, would_send: 0 });
    if (dryRun) return json({ ok: true, dry_run: true, seeded: 0, sent: 0, would_send: candidates.length });

    let sent = 0;
    const failed = [];
    for (const entry of candidates) {
      const result = await sendTelegramChannel(env, env.TELEGRAM_CHANNEL_ID, buildAnnouncement(entry, baseUrl));
      if (!result.sent) {
        failed.push({ id: entry.id, error: result.error || 'send failed' });
        continue;
      }
      await env.DB.prepare('INSERT OR IGNORE INTO telegram_official_announcements (entry_id) VALUES (?)')
        .bind(entry.id).run();
      sent += 1;
    }
    return json({ ok: failed.length === 0, seeded: 0, sent, failed });
  } catch (error) {
    console.error('Official file broadcast failed:', error.message);
    return json({ error: 'Official file broadcast failed' }, 500);
  }
}
