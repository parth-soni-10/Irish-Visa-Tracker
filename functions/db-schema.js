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
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  application_number TEXT,
  embassy TEXT,
  embassy_slug TEXT,
  last_alert_sent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint_app_office ON push_subscriptions(endpoint, application_number, embassy_slug);
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

CREATE TABLE IF NOT EXISTS admin_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked INTEGER DEFAULT 0,
  last_used_at TEXT,
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

-- Anonymous, finished-application dates used only to calibrate the published
-- timeline baseline. No application number, email, IP or free text is stored.
CREATE TABLE IF NOT EXISTS prediction_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_version TEXT NOT NULL,
  source_submission_id INTEGER,
  office TEXT NOT NULL,
  visa_type TEXT NOT NULL,
  application_date TEXT NOT NULL,
  decision_date TEXT NOT NULL,
  actual_days INTEGER NOT NULL,
  baseline_days INTEGER NOT NULL,
  baseline_error INTEGER NOT NULL,
  within_14_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prediction_feedback_model ON prediction_feedback(model_version, created_at);
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

  // Existing deployments created prediction_feedback before it carried the
  // community-timeline link. Add the column in place; a fresh table already has
  // it. The unique index makes one community timeline count at most once, while
  // leaving legacy unverified rows (NULL) readable but outside the gate.
  try {
    await db.prepare('ALTER TABLE prediction_feedback ADD COLUMN source_submission_id INTEGER').run();
  } catch (error) {
    if (!/duplicate column|already exists/i.test(String(error.message))) throw error;
  }
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_prediction_feedback_source ON prediction_feedback(source_submission_id)').run();

  schemaReady = true;
}
