/**
 * Product-layer schema.
 *
 * These tables are created lazily so the existing Pages deployment keeps
 * working without a manual migration step. Every statement is additive and
 * safe to re-run.
 */

let schemaReady = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["export"]',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy_slug TEXT NOT NULL,
  nickname TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_push INTEGER DEFAULT 1,
  last_alert_sent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique ON watchlists(user_id, application_number, embassy_slug);

CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'question',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  office TEXT,
  visa_type TEXT,
  outcome TEXT,
  rating INTEGER,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_community_posts_kind ON community_posts(kind, created_at);

CREATE TABLE IF NOT EXISTS community_answers (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_community_answers_post ON community_answers(post_id, created_at);

CREATE TABLE IF NOT EXISTS referral_codes (
  user_id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code TEXT NOT NULL,
  invited_email TEXT,
  referred_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_referrals_user ON referrals(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);

CREATE TABLE IF NOT EXISTS referral_rewards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  referral_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT 'accepted_referral',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_referral_rewards_user ON referral_rewards(user_id, created_at);

CREATE TABLE IF NOT EXISTS scheduled_exports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv',
  frequency TEXT NOT NULL DEFAULT 'weekly',
  filters TEXT NOT NULL DEFAULT '{}',
  next_run_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_exports_due ON scheduled_exports(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  row_count INTEGER NOT NULL DEFAULT 0,
  download_token_hash TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON export_jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  brand_name TEXT,
  brand_color TEXT DEFAULT '#047857',
  logo_url TEXT,
  plan TEXT NOT NULL DEFAULT 'team',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

CREATE TABLE IF NOT EXISTS org_invites (
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assistant_scans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  document_type TEXT,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_scans_user ON assistant_scans(user_id, created_at);
`;

export async function ensurePortalSchema(env) {
  if (!env || !env.DB) throw new Error('Database not configured');
  if (schemaReady) return;
  const statements = SCHEMA
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      await env.DB.prepare(statement).run();
    } catch (error) {
      if (!/already exists|duplicate/i.test(String(error.message || ''))) throw error;
    }
  }

  // Additive column for older deployments. ALTER TABLE has no IF NOT EXISTS
  // in SQLite, so a duplicate-column error is expected on subsequent runs.
  for (const statement of [
    'ALTER TABLE watchlists ADD COLUMN last_alert_sent TEXT'
  ]) {
    try {
      await env.DB.prepare(statement).run();
    } catch (error) {
      if (!/duplicate column|already exists/i.test(String(error.message || ''))) throw error;
    }
  }

  schemaReady = true;
}
