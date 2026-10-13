-- D1 schema for the Irish Visa Tracker submission store.
--
-- The Worker creates this table lazily on its first write (CREATE TABLE IF
-- NOT EXISTS in worker.js), so this file is the reference copy rather than a
-- required migration step. To apply it by hand:
--
--   npx wrangler d1 execute irish-visa-tracker-submissions --remote --file schema.sql
--
-- To read what has been submitted:
--
--   npx wrangler d1 execute irish-visa-tracker-submissions --remote \
--     --command "SELECT id, form, created_at, fields FROM submissions ORDER BY id DESC LIMIT 20"

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form TEXT NOT NULL,
  fields TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
