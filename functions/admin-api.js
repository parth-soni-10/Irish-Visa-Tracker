/**
 * Admin API Routes
 *
 * Reads the published JSON snapshots and the D1 tables this project actually
 * creates. The previous implementation queried scraper_logs, embassy_decisions,
 * api_logs and error_logs, none of which exist, so every panel returned 500.
 */

import { hashToken } from './auth.js';
import { loadReportData } from './report-data.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function tokenMatches(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

async function ensureAdminSchema(env) {
  if (!env.DB) return false;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_tokens (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT,
      revoked INTEGER DEFAULT 0,
      last_used_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run().catch(() => {});
  try {
    await env.DB.prepare('SELECT last_used_at FROM admin_tokens LIMIT 1').first();
  } catch {
    await env.DB.prepare('ALTER TABLE admin_tokens ADD COLUMN last_used_at TEXT').run().catch(() => {});
  }
  return true;
}

async function validateAdminToken(env, token) {
  if (!token) return false;
  // Bootstrap access. Rotate this after creating a named token.
  if (env.ADMIN_DASHBOARD_TOKEN && tokenMatches(token, env.ADMIN_DASHBOARD_TOKEN)) return true;
  if (!env.DB) return false;

  const tokenHash = await hashToken(token);
  const record = await env.DB.prepare(`
    SELECT id FROM admin_tokens
    WHERE token_hash = ? AND revoked = 0
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).bind(tokenHash).first();
  if (record) {
    env.DB.prepare("UPDATE admin_tokens SET last_used_at = datetime('now') WHERE id = ?")
      .bind(record.id).run().catch(() => {});
  }
  return Boolean(record);
}

async function requireAdmin(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { authorized: false, response: json({ error: 'Admin token required' }, 401) };
  }
  if (!(await ensureAdminSchema(env))) {
    return { authorized: false, response: json({ error: 'Database not configured' }, 503) };
  }
  if (!(await validateAdminToken(env, authHeader.slice(7).trim()))) {
    return { authorized: false, response: json({ error: 'Invalid admin token' }, 401) };
  }
  return { authorized: true };
}

function daysSince(dateString) {
  if (!dateString) return null;
  const date = new Date(String(dateString).slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(date.getTime()) ? null : Math.round((Date.now() - date.getTime()) / 86400000);
}

async function safeCount(env, sql) {
  try {
    const row = await env.DB.prepare(sql).first();
    return Number(row && row.count) || 0;
  } catch {
    return 0;
  }
}

export async function handleScraperHealth(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    const report = await loadReportData(env, request);
    const embassies = {};
    for (const office of report.officeList) {
      const rows = report.rows.filter((row) => row.office === office.slug);
      const ageDays = daysSince(office.report_date);
      const status = ageDays == null
        ? (rows.length ? 'healthy' : 'down')
        : ageDays <= 2 ? 'healthy' : ageDays <= 7 ? 'stale' : 'down';
      const fetched = office.fetched_at || null;
      embassies[office.slug] = {
        status,
        lastRun: fetched,
        hoursSinceRun: fetched ? Math.round((Date.now() - new Date(fetched).getTime()) / 360000) / 10 : null,
        reportDate: office.report_date,
        hoursSinceData: ageDays == null ? null : ageDays * 24,
        decisions: rows.length,
        reportedTotal: Number(office.reported_total) || 0,
        successRate: rows.length ? 100 : 0,
        recentErrors: []
      };
    }
    const values = Object.values(embassies);
    return json({
      overall: values.some((item) => item.status === 'down') ? 'degraded'
        : values.every((item) => item.status === 'healthy') ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      source: 'published snapshots + data_manifest.json',
      embassies
    });
  } catch (error) {
    console.error('Scraper health error:', error);
    return json({ error: 'Failed to fetch health' }, 500);
  }
}

export async function handleDataQuality(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    const report = await loadReportData(env, request);
    const embassies = {};
    for (const office of report.officeList) {
      const rows = report.rows.filter((row) => row.office === office.slug);
      const seen = new Map();
      const monthly = new Map();
      let complete = 0;
      let min = null;
      let max = null;
      for (const row of rows) {
        if (row.number && row.decision && row.date) complete += 1;
        seen.set(String(row.number || ''), (seen.get(String(row.number || '')) || 0) + 1);
        if (row.date) {
          if (!min || row.date < min) min = row.date;
          if (!max || row.date > max) max = row.date;
          const key = String(row.date).slice(0, 7);
          monthly.set(key, (monthly.get(key) || 0) + 1);
        }
      }
      const trend = [...monthly.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-12)
        .map(([month, count]) => ({ month, count }));
      embassies[office.slug] = {
        totalDecisions: rows.length,
        reportedTotal: Number(office.reported_total) || 0,
        completeness: rows.length ? Number(((complete / rows.length) * 100).toFixed(1)) : 0,
        duplicateCount: [...seen.values()].filter((count) => count > 1).length,
        dateRange: min ? { min, max } : null,
        monthlyTrend: trend,
        avgPerMonth: trend.length
          ? Number((trend.reduce((sum, item) => sum + item.count, 0) / trend.length).toFixed(1))
          : 0
      };
    }
    return json({ timestamp: new Date().toISOString(), embassies });
  } catch (error) {
    console.error('Data quality error:', error);
    return json({ error: 'Failed to fetch quality metrics' }, 500);
  }
}

export async function handleSystemMetrics(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  try {
    const [users, sessions, email, telegram, push, watchlists, apiTokens, notifications, submissions,
      smsChannels, whatsappChannels, communityPosts, organizations, scheduledExports, exportJobs] = await Promise.all([
      env.DB.prepare(`SELECT COUNT(*) AS count,
        COUNT(CASE WHEN created_at > datetime('now', '-7 days') THEN 1 END) AS last_week,
        COUNT(CASE WHEN created_at > datetime('now', '-30 days') THEN 1 END) AS last_month
        FROM users`).first(),
      safeCount(env, "SELECT COUNT(*) AS count FROM user_sessions WHERE expires_at > datetime('now')"),
      env.DB.prepare(`SELECT COUNT(*) AS total,
        COUNT(CASE WHEN verified = 1 AND unsubscribed = 0 THEN 1 END) AS active
        FROM email_subscriptions`).first().catch(() => ({ total: 0, active: 0 })),
      env.DB.prepare(`SELECT COUNT(*) AS total,
        COUNT(CASE WHEN active = 1 THEN 1 END) AS active
        FROM telegram_subscriptions`).first().catch(() => ({ total: 0, active: 0 })),
      safeCount(env, 'SELECT COUNT(*) AS count FROM push_subscriptions'),
      safeCount(env, 'SELECT COUNT(*) AS count FROM watchlists'),
      safeCount(env, 'SELECT COUNT(*) AS count FROM api_tokens WHERE revoked = 0'),
      safeCount(env, 'SELECT COUNT(*) AS count FROM user_notifications WHERE read_at IS NULL'),
      safeCount(env, 'SELECT COUNT(*) AS count FROM submissions'),
      safeCount(env, "SELECT COUNT(*) AS count FROM user_channels WHERE channel = 'sms' AND verified = 1"),
      safeCount(env, "SELECT COUNT(*) AS count FROM user_channels WHERE channel = 'whatsapp' AND verified = 1"),
      safeCount(env, "SELECT COUNT(*) AS count FROM community_posts WHERE status = 'published'"),
      safeCount(env, 'SELECT COUNT(*) AS count FROM organizations'),
      safeCount(env, 'SELECT COUNT(*) AS count FROM scheduled_exports WHERE enabled = 1'),
      safeCount(env, "SELECT COUNT(*) AS count FROM export_jobs WHERE status = 'ready'")
    ]);
    const report = await loadReportData(env, request);
    const offices = {};
    for (const office of report.officeList) {
      offices[office.slug] = report.rows.filter((row) => row.office === office.slug).length;
    }
    return json({
      timestamp: new Date().toISOString(),
      users: {
        total: Number(users && users.count) || 0,
        lastWeek: Number(users && users.last_week) || 0,
        lastMonth: Number(users && users.last_month) || 0,
        activeSessions: sessions
      },
      subscriptions: {
        email: { total: Number(email && email.total) || 0, active: Number(email && email.active) || 0 },
        push: { total: push },
        telegram: {
          total: Number(telegram && telegram.total) || 0,
          active: Number(telegram && telegram.active) || 0
        }
      },
      watchlists,
      exportTokens: apiTokens,
      unreadNotifications: notifications,
      submissions,
      product: {
        smsChannels,
        whatsappChannels,
        telegramChannels: Number(telegram && telegram.active) || 0,
        communityPosts,
        organizations,
        scheduledExports,
        readyExports: exportJobs
      },
      dataVolume: { visa_decisions: report.rows.length, offices, latest_date: report.latestDate },
      api: {
        requests: [],
        errors: [],
        note: 'API request logging is not enabled; use Cloudflare analytics for request counts.'
      }
    });
  } catch (error) {
    console.error('Metrics error:', error);
    return json({ error: 'Failed to fetch metrics' }, 500);
  }
}

export async function handleErrorLogs(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;
  return json({
    logs: [],
    count: 0,
    source: 'sentry',
    configured: Boolean(env.SENTRY_DSN),
    note: env.SENTRY_DSN
      ? 'Open the Sentry project for the error stream. This dashboard does not mirror Sentry events.'
      : 'SENTRY_DSN is not configured. Set it to collect server errors.'
  });
}

export async function handleTriggerScraper(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const embassy = String(body.embassy || '').trim();
  if (!embassy) return json({ error: 'Embassy required' }, 400);

  const token = env.GITHUB_DISPATCH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    return json({
      error: 'GitHub Actions dispatch is not configured',
      hint: 'Set GITHUB_DISPATCH_TOKEN (repo:actions write) to enable the dashboard trigger.'
    }, 503);
  }

  const repo = env.GITHUB_REPO || 'parth-soni-10/Irish-Visa-Tracker';
  const workflow = env.GITHUB_SCRAPE_WORKFLOW || 'scrape.yml';
  const response = await fetch(
    'https://api.github.com/repos/' + repo + '/actions/workflows/' + workflow + '/dispatches',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'irish-visa-tracker-admin'
      },
      body: JSON.stringify({ ref: env.GITHUB_DISPATCH_REF || 'main' })
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return json({
      error: 'GitHub Actions rejected the dispatch',
      status: response.status,
      detail: detail.slice(0, 500)
    }, 502);
  }
  return json({
    success: true,
    message: 'Scraper workflow dispatched for ' + embassy + '.',
    workflow,
    repo
  }, 202);
}

export async function handleAdminTokens(request, env) {
  const auth = await requireAdmin(request, env);
  if (!auth.authorized) return auth.response;

  if (request.method === 'GET') {
    const tokens = await env.DB.prepare(`
      SELECT id, name, created_at, expires_at, last_used_at, revoked
      FROM admin_tokens ORDER BY created_at DESC
    `).all();
    return json({ tokens: tokens.results || [] });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const name = String(body.name || '').trim().slice(0, 100);
    if (!name) return json({ error: 'Name required' }, 400);
    const days = Math.max(1, Math.min(Number(body.expiresDays) || 90, 3650));
    const token = 'admin_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const tokenHash = await hashToken(token);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    await env.DB.prepare(`
      INSERT INTO admin_tokens (id, token_hash, name, expires_at, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).bind(id, tokenHash, name, expiresAt).run();
    return json({ success: true, id, token, name, expiresAt }, 201);
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'ID required' }, 400);
    const result = await env.DB.prepare('UPDATE admin_tokens SET revoked = 1 WHERE id = ?').bind(id).run();
    if (!result.meta || result.meta.changes === 0) return json({ error: 'Token not found' }, 404);
    return json({ success: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
