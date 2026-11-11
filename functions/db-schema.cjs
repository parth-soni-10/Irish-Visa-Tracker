/**
 * Database schema utilities
 * Shared between router and API modules
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_form ON submissions(form);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let schemaReady = false;

async function ensureSchema(db) {
  if (schemaReady) return;
  
  const statements = SCHEMA
    .split(';')
    .map(s => s.replace(/^\s*--.*$/gm, '').trim())
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
  schemaReady = true;
}

module.exports.SCHEMA = SCHEMA;
module.exports.ensureSchema = ensureSchema;