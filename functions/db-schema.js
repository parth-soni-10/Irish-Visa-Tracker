/**
 * The tracker's base D1 schema and idempotent bootstrap.
 *
 * Kept out of the router so schema changes are reviewable on their own and
 * can be imported by tests or one-off maintenance scripts without pulling in
 * request routing.
 */

// Database schema
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  email TEXT,
  application_number TEXT,
  embassy TEXT,
  embassy_slug TEXT,
  last_alert_sent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint_app ON push_subscriptions(endpoint, application_number);
CREATE INDEX IF NOT EXISTS idx_push_app_embassy ON push_subscriptions(application_number, embassy);

CREATE TABLE IF NOT EXISTS embassy_config (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  flag TEXT,
  countries TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  schedule TEXT NOT NULL,
  parser TEXT NOT NULL,
  decision_cols TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS visa_type_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visa_type TEXT NOT NULL,
  subtype TEXT,
  min_app_num INTEGER NOT NULL,
  max_app_num INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  embassy_slug TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_visa_type_range ON visa_type_rules(min_app_num, max_app_num);

CREATE TABLE IF NOT EXISTS vac_transit_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  embassy_slug TEXT NOT NULL,
  vac_city TEXT NOT NULL,
  vac_address TEXT NOT NULL,
  vac_hours TEXT,
  vac_phone TEXT,
  vac_email TEXT,
  required_docs TEXT NOT NULL,
  processing_time TEXT,
  fee TEXT,
  transit_visa_required INTEGER DEFAULT 0,
  transit_exempt_countries TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vac_embassy ON vac_transit_rules(embassy_slug);

CREATE TABLE IF NOT EXISTS email_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  email_hash TEXT NOT NULL,
  email TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  verification_expires TEXT,
  unsubscribe_token TEXT,
  unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_alert_sent TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sub_unique ON email_subscriptions(email_hash, application_number, embassy);
CREATE INDEX IF NOT EXISTS idx_email_pending ON email_subscriptions(verified, unsubscribed);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  email_hash TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  preferences TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS admin_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked INTEGER DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Private export tokens. Only a SHA-256 digest is stored; the plaintext
-- token is shown once and can only download that user's export.
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["read"]',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens(token_hash);

-- In-app notification inbox. Delivery channels (email/push) remain separate.
CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'decision',
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON user_notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy_slug TEXT NOT NULL,
  nickname TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_push INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique ON watchlists(user_id, application_number, embassy_slug);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlists(user_id);

-- Saved searches for advanced search
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  params TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Shared fixed-window counters. A row is keyed by bucket, subject and the
-- window's UTC epoch milliseconds, so every edge isolate sees the same count.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (bucket, subject, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Conversion funnel. Deliberately contains no email, IP, cookie or free text.
CREATE TABLE IF NOT EXISTS conversion_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  source TEXT,
  application_number TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversion_events_event ON conversion_events(event, created_at);
`;

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  
  // Strip full-line SQL comments BEFORE splitting on semicolons. Splitting
  // first lets a semicolon inside a comment become a bogus SQL statement.
  const statements = SCHEMA
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0);
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      await db.prepare(stmt).run();
    } catch (error) {
      // Ignore "already exists" errors
      if (!error.message.includes('already exists') && !error.message.includes('duplicate')) {
        console.error(`Schema statement ${i} failed:`, stmt.substring(0, 300));
        console.error('Error:', error.message);
        throw error;
      }
    }
  }
  // Saved searches created before account scoping were global. Leave those
  // unowned rather than guessing which account they belonged to.
  for (const statement of [
    "ALTER TABLE saved_searches ADD COLUMN user_id TEXT",
    "CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id, created_at)"
  ]) {
    try {
      await db.prepare(statement).run();
    } catch (error) {
      if (!error.message.includes("duplicate") && !error.message.includes("already exists")) throw error;
    }
  }
  schemaReady = true;
}
