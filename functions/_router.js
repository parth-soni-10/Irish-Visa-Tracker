/**
 * Irish Visa Tracker - the routing half of this site's Pages Function.
 *
 * Pages compiles this directory (see `functions/[[path]].js`, the catch-all
 * route) and it imports this file, so the site's whole server side is here. The
 * `_` prefix keeps it out of the routing table: the only route is the catch-all
 * route beside it, which is also why nothing here has to think about a path pattern.
 *
 * This replaces Netlify Forms. The page's three forms (`suggestions`,
 * `timelines-visa`, `timelines-1g`) already POST urlencoded bodies to their own
 * path with a `form-name` field - Netlify used to intercept those posts and
 * record them. Nothing in the page changes: the same bodies arrive here.
 *
 * Behaviour, at parity with what the page's script expects:
 *   * The page's own AJAX submit only checks `res.ok`, then shows its success
 *     card - it gets a 200 JSON ack.
 *   * A no-JavaScript submit gets a 303 back to the tracker instead.
 *   * A filled `bot-field` honeypot is answered exactly like a stored
 *     submission but records nothing.
 *   * Submissions land in the `submissions` table, keyed by form name.
 */

import { handleHealthCheck } from "./health.js";
import {
  DOCUMENTS,
  MARKDOWN_ALIASES,
  NOT_ACCEPTABLE_MARKDOWN,
  markdownResponse,
  negotiate,
  notFoundMarkdown,
} from "./_agent-docs.js";

const FORM_NAMES = new Set(["suggestions", "timelines-visa", "timelines-1g", "timelines"]);
const TIMELINE_FORMS = ["timelines-visa", "timelines-1g", "timelines"];
// Read-only feed for the nightly community sync. Deliberately narrow: only the
// three timeline form names are ever returned, never `suggestions`, which holds
// a visitor's name and free text.
const SUBMISSIONS_PATH = "/api/community-submissions";
const MAX_TIMELINE_ROWS = 5000;
const SUBSCRIBE_PATHS = new Set(["/api/subscribe", "/api/verify", "/api/unsubscribe"]);
const PUSH_PATHS = new Set(["/api/push/subscribe", "/api/push/unsubscribe"]);
const USER_PUSH_PATHS = new Set(["/api/user/push/subscribe", "/api/user/push/unsubscribe", "/api/user/push/key", "/api/user/push/test"]);
const AUTH_PATHS = new Set(["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/profile", "/api/auth/password", "/api/auth/delete"]);
const ADMIN_PATHS = new Set(["/api/admin/health", "/api/admin/quality", "/api/admin/metrics", "/api/admin/errors", "/api/admin/trigger", "/api/admin/tokens"]);
const USER_PATHS = new Set(["/api/user/profile", "/api/user/watchlist", "/api/user/alerts", "/api/user/export", "/api/user/notifications", "/api/user/notifications/read"]);
const USER_PREFIXES = ["/api/user/watchlist/"];
const PREDICT_PATH = "/api/predict";
const CHECKLIST_PATH = "/api/checklist";
const VFS_APPOINTMENTS_PATH = "/api/vfs/appointments";
const SEARCH_PATH = "/api/search";
const ALERTS_PATH = "/api/alerts/run";
const EXPORT_RUN_PATH = "/api/exports/run";
const CONFIG_PATH = "/api/config";
const EMAIL_WEBHOOK_PATH = "/api/email/send";
const REPORT_PATHS = new Set([
  "/api/reports/monthly", "/api/reports/changes", "/api/digest/preview",
  "/api/digest/subscribe", "/api/digest/verify", "/api/digest/unsubscribe", "/api/digest/send"
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 16 * 1024;
const NOT_FOUND_PATHS = new Set(["/404", "/404/", "/404.html"]);

// Database schema
const SCHEMA = `
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
  notify_whatsapp INTEGER DEFAULT 0,
  notify_sms INTEGER DEFAULT 0,
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
  // Additive column for deployments created before SMS opt-in existed.
  try {
    await db.prepare("ALTER TABLE watchlists ADD COLUMN notify_sms INTEGER DEFAULT 0").run();
  } catch (error) {
    if (!error.message.includes("duplicate") && !error.message.includes("already exists")) throw error;
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

// The dashboard's data files are written by the GitHub Actions job
// to the repository root. We serve them from the Pages asset bucket
// (which is the repo root at build time) so they're at known paths.
const REPO_RAW = "https://raw.githubusercontent.com/parth-soni/irish-visa-tracker/main";

// In-memory rate limit store (per-instance, not durable across restarts)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 300; // 300 API requests per minute per IP

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW;

  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, []);
  }

  const requests = rateLimitStore.get(ip).filter((t) => t > windowStart);
  rateLimitStore.set(ip, requests);

  if (requests.length >= RATE_LIMIT_MAX) {
    return false;
  }

  requests.push(now);
  return true;
}

// Security headers
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // CSP: allow self, inline scripts/styles for our own code, and specific external resources
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://browser.sentry-cdn.com https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://fcm.googleapis.com https://*.sentry.io; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self';"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mergeVary(headers) {
  const existing = headers.get("Vary");
  const varies = new Set(existing ? existing.split(",").map((v) => v.trim()) : []);
  varies.add("Accept");
  varies.add("Accept-Encoding");
  headers.set("Vary", Array.from(varies).join(", "));
}

function withVary(response) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  return addSecurityHeaders(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

/** Success response shaped for either caller: the page's fetch, or a plain form submit. */
function ack(request) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (wantsHtml) return addSecurityHeaders(Response.redirect(new URL("/", request.url).href, 303));
  return addSecurityHeaders(new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" }
  }));
}

/** Returns the name of the first invalid field, or null when the payload is acceptable. */
function invalidField(formName, fields) {
  if (formName === "suggestions") {
    if (!fields.name || fields.name.length > 200) return "name";
    if (!fields.suggestion || fields.suggestion.length > 5000) return "suggestion";
  }
  if (formName === "timelines-visa" || formName === "timelines-1g") {
    if (!fields.visa_type || fields.visa_type.length > 100) return "visa_type";
    if (!fields.embassy || fields.embassy.length > 100) return "embassy";
    if (!fields.outcome || !["granted", "refused"].includes(fields.outcome)) return "outcome";
  }
  return null;
}

const json = (body, status = 200) =>
  addSecurityHeaders(new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));

/** Serve the timeline rows the sync job reads. No credential: the same rows are
 *  committed to a public data file, so this exposes nothing the pipeline does
 *  not already publish. */
async function serveTimelineSubmissions(env) {
  const placeholders = TIMELINE_FORMS.map(() => "?").join(", ");
  try {
    await ensureSchema(env.DB);
    const { results } = await env.DB
      .prepare(`SELECT form, fields, created_at FROM submissions `
               + `WHERE form IN (${placeholders}) ORDER BY id LIMIT ?`)
      .bind(...TIMELINE_FORMS, MAX_TIMELINE_ROWS)
      .all();
    return json({ submissions: results || [] });
  } catch (error) {
    console.error("timeline submissions read failed:", error);
    return json({ error: "Could not read submissions" }, 500);
  }
}

/** Fetch a negotiated HTML document, falling back to its .html file if the
 *  assets layer does not resolve the clean URL itself. */
async function fetchDocument(env, request, document) {
  let response = await env.ASSETS.fetch(request);
  if ((response.status === 404 || (response.status >= 300 && response.status < 400)) && document.file) {
    const url = new URL(request.url);
    url.pathname = document.file;
    response = await env.ASSETS.fetch(new Request(url, request));
  }
  const headers = new Headers(response.headers);
  if (document.alternate) {
    headers.set("Link", `<${document.alternate}>; rel="alternate"; type="text/markdown"`);
  }
  // Cache HTML for 5 minutes, stale-while-revalidate 1 hour
  if (headers.get("Content-Type")?.includes("text/html")) {
    headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  }
  // JS/CSS assets get longer cache
  if (headers.get("Content-Type")?.includes("javascript") || headers.get("Content-Type")?.includes("css")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  mergeVary(headers);
  return addSecurityHeaders(new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

async function notFoundPage(env, request) {
  let response = null;
  try {
    response = await env.ASSETS.fetch(new Request(new URL("/404.html", request.url), request));
  } catch {
    // Fall through to the inline page below if the assets binding is unavailable.
  }

  if (!response || response.status === 404) {
    response = new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Page not found</title></head><body><h1>Page not found</h1></body></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  mergeVary(headers);
  return addSecurityHeaders(new Response(request.method === "HEAD" ? null : response.body, {
    status: 404,
    statusText: "Not Found",
    headers,
  }));
}

async function notFoundResponse(request, env, pathname) {
  const choice = negotiate(request.headers.get("Accept"));
  if (choice === "markdown") {
    return markdownResponse(notFoundMarkdown(pathname), 404, request.method);
  }
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method);
  }
  return notFoundPage(env, request);
}

async function agentDocumentResponse(request, env, document) {
  const choice = negotiate(request.headers.get("Accept"));
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method);
  }
  if (choice === "markdown") {
    return markdownResponse(document.markdown, 200, request.method);
  }
  return fetchDocument(env, request, { file: document.file, alternate: document.alternate });
}

// Main request handler with error tracking
async function handleRequest(request, env, captureException) {
  const { pathname } = new URL(request.url);

  // Health check endpoint (no rate limiting)
  if (pathname === '/api/health' || pathname === '/health') {
    return handleHealthCheck(env);
  }

  // Public browser configuration. Only publishable values belong here; the
  // VAPID private key and every mail/Sentry secret stay server-side.
  if (pathname === CONFIG_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
    return json({
      sentry_dsn: env.SENTRY_DSN || '',
      sentry_environment: env.SENTRY_ENVIRONMENT || (env.CF_PAGES_BRANCH === 'main' ? 'production' : 'preview'),
      vapid_public_key: env.VAPID_PUBLIC_KEY || '',
      brand_name: env.BRAND_NAME || 'Irish Visa Decision Tracker',
      brand_color: env.BRAND_COLOR || '#047857',
      support_email: env.SUPPORT_EMAIL || '',
      sso_enabled: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID),
      workspace: true
    });
  }

  // The email bridge is called by the worker itself for every outbound mail.
  // Exempt it from the per-client limiter (a digest can legitimately send many
  // messages) and authenticate it with the dedicated webhook secret instead.
  if (pathname === EMAIL_WEBHOOK_PATH && request.method === 'POST') {
    const { handleEmailWebhook } = await import('./email-webhook.js');
    return handleEmailWebhook(request, env);
  }

  // Rate limiting for API endpoints
  if (pathname.startsWith('/api/')) {
    const ip = getClientIp(request);
    if (!checkRateLimit(ip)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '60' }
      });
    }
  }

  // Community timeline rows for the nightly sync job. Public and read-only,
  // like the data files it replaces the need for a credential with.
  if (pathname === SUBMISSIONS_PATH) {
    if (request.method === "HEAD") {
      const head = await serveTimelineSubmissions(env);
      return new Response(null, { status: head.status, headers: head.headers });
    }
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return serveTimelineSubmissions(env);
  }

  // Scheduled decision-alert runner. This is deliberately separate from the
  // public subscription endpoints: it requires X-Cron-Secret and is safe to
  // re-run because each subscription records the decision date it last sent.
  if (pathname === ALERTS_PATH) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const { handleAlertsRun } = await import('./alerts-run.js');
    return handleAlertsRun(request, env);
  }

  // Scheduled private exports. The token is scoped to one account and is
  // accepted only by the download route; this is not a public API.
  if (pathname === EXPORT_RUN_PATH) {
    const { handleExportRun } = await import('./export-service.js');
    return handleExportRun(request, env);
  }

  // Product workspace: private profile, analytics, exports, assistant,
  // community, referrals and organizations.
  if (pathname.startsWith('/api/portal/')) {
    const { handlePortal } = await import('./portal-api.js');
    return handlePortal(request, env);
  }

  // Generic OIDC SSO. Kept separate from password auth so a provider outage
  // cannot break the normal sign-in path.
  if (pathname.startsWith('/api/auth/sso/')) {
    const { handleSsoStatus, handleSsoStart, handleSsoCallback } = await import('./sso.js');
    if (pathname === '/api/auth/sso/status' && (request.method === 'GET' || request.method === 'HEAD')) return handleSsoStatus(request, env);
    if (pathname === '/api/auth/sso/start' && request.method === 'GET') return handleSsoStart(request, env);
    if (pathname === '/api/auth/sso/callback' && request.method === 'GET') return handleSsoCallback(request, env);
    return new Response('Method not allowed', { status: 405 });
  }

  // Auth routes (register, login, logout, me, profile, password, delete)
  if (AUTH_PATHS.has(pathname)) {
    const { handleRegister, handleLogin, handleLogout, handleMe,
            handleUpdateProfile, handleChangePassword, handleDeleteAccount } = await import("./user-api.js");
    
    if (pathname === '/api/auth/register' && request.method === 'POST') {
      return handleRegister(request, env);
    }
    if (pathname === '/api/auth/login' && request.method === 'POST') {
      return handleLogin(request, env);
    }
    if (pathname === '/api/auth/logout' && (request.method === 'POST' || request.method === 'GET')) {
      return handleLogout(request, env);
    }
    if (pathname === '/api/auth/me' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleMe(request, env);
    }
    if (pathname === '/api/auth/profile' && (request.method === 'PUT' || request.method === 'PATCH')) {
      return handleUpdateProfile(request, env);
    }
    if (pathname === '/api/auth/password' && request.method === 'PUT') {
      return handleChangePassword(request, env);
    }
    if (pathname === '/api/auth/delete' && request.method === 'DELETE') {
      return handleDeleteAccount(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // Prediction route (ML timeline predictor)
  if (pathname === PREDICT_PATH) {
    const { onRequest } = await import("./api/predict.js");
    const handler = onRequest[request.method] || onRequest.POST;
    return handler({ request, env });
  }

  // Document Checklist Generator
  if (pathname === CHECKLIST_PATH) {
    const { onRequest } = await import("./api/checklist.js");
    const handler = onRequest[request.method] || onRequest.POST;
    return handler({ request, env });
  }

  // VFS Appointments
  if (pathname === VFS_APPOINTMENTS_PATH) {
    const { handleVFSAppointments } = await import("./vfs-appointments.js");
    return handleVFSAppointments(request, env);
  }

  // Advanced Search
  if (pathname === SEARCH_PATH) {
    const { onRequest } = await import("./api/search.js");
    const handler = onRequest[request.method] || onRequest.POST;
    return handler({ request, env });
  }

  // Web Push subscription routes
  if (PUSH_PATHS.has(pathname)) {
    if (pathname === "/api/push/subscribe" && request.method === "POST") {
      const { handlePushSubscribe } = await import("./push.js");
      return handlePushSubscribe(request, env);
    }
    if (pathname === "/api/push/unsubscribe" && (request.method === "GET" || request.method === "HEAD")) {
      const { handlePushUnsubscribe } = await import("./push.js");
      return handlePushUnsubscribe(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }
  // User routes
  if (USER_PATHS.has(pathname) || USER_PUSH_PATHS.has(pathname) ||
      USER_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const { handleMe, handleUpdateProfile: handleUserUpdateProfile,
            handleGetWatchlist, handleAddToWatchlist, handleRemoveFromWatchlist,
            handleUpdateWatchlist, handleBulkAddToWatchlist, handleExportAccountData, handleGetAlerts, handlePushSubscribe,
            handlePushUnsubscribe, handlePushKey, handlePushTest } = await import("./user-api.js");

    if (pathname === '/api/user/profile' && request.method === 'GET') {
      return handleMe(request, env);
    }
    if (pathname === '/api/user/profile' && (request.method === 'PUT' || request.method === 'PATCH')) {
      return handleUserUpdateProfile(request, env);
    }
    if (pathname === '/api/user/watchlist' && request.method === 'GET') {
      return handleGetWatchlist(request, env);
    }
    if (pathname === '/api/user/watchlist/bulk' && request.method === 'POST') {
      return handleBulkAddToWatchlist(request, env);
    }
    if (pathname === '/api/user/export' && request.method === 'GET') {
      return handleExportAccountData(request, env);
    }
    if (pathname === '/api/user/watchlist' && request.method === 'POST') {
      return handleAddToWatchlist(request, env);
    }
    if (pathname.startsWith('/api/user/watchlist/') && request.method === 'DELETE') {
      return handleRemoveFromWatchlist(request, env);
    }
    if (pathname.startsWith('/api/user/watchlist/') && (request.method === 'PUT' || request.method === 'PATCH')) {
      return handleUpdateWatchlist(request, env);
    }
    if (pathname === '/api/user/alerts' && request.method === 'GET') {
      return handleGetAlerts(request, env);
    }
    if (pathname === '/api/user/notifications' && request.method === 'GET') {
      const { handleListNotifications } = await import('./notifications.js');
      return handleListNotifications(request, env);
    }
    if (pathname === '/api/user/notifications/read' && request.method === 'POST') {
      const { handleMarkNotificationsRead } = await import('./notifications.js');
      return handleMarkNotificationsRead(request, env);
    }
    if (pathname === '/api/user/push/key' && request.method === 'GET') {
      return handlePushKey(request, env);
    }
    if (pathname === '/api/user/push/test' && request.method === 'POST') {
      return handlePushTest(request, env);
    }
    if (pathname === '/api/user/push/subscribe' && request.method === 'POST') {
      return handlePushSubscribe(request, env);
    }
    if (pathname === '/api/user/push/unsubscribe' && (request.method === 'DELETE' || request.method === 'POST')) {
      return handlePushUnsubscribe(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  if (REPORT_PATHS.has(pathname)) {
    const { handleReports } = await import("./reports.js");
    return handleReports(request, env);
  }



  // Cron-friendly scraper trigger (shared secret, no admin auth required)
  // For cron-job.org, EasyCron, etc. Set SCRAPER_CRON_SECRET in Cloudflare Pages env vars
  if (pathname === '/api/scraper/trigger' && request.method === 'POST') {
    const expected = env.SCRAPER_CRON_SECRET;
    if (!expected) {
      return new Response(JSON.stringify({ error: 'Cron secret not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Parse body first to check for secret in body
    let body = {};
    try { body = await request.json(); } catch {}
    const secret = request.headers.get('X-Cron-Secret') || 
                   new URL(request.url).searchParams.get('secret') || 
                   body.secret;
    
    if (secret !== expected) {
      return new Response(JSON.stringify({ error: 'Invalid or missing cron secret' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { embassy } = body; // optional: specific embassy or all

    return new Response(JSON.stringify({
      success: true,
      message: embassy ? `Scraper trigger received for ${embassy}` : 'Scraper trigger received for all embassies',
      note: 'Actual scraping runs via GitHub Actions on schedule; this endpoint acknowledges the cron trigger'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // API routes are handled explicitly above. Only the legacy HTML form posts
  // should reach the generic form handler below; without this guard it also
  // swallowed POST /api/subscribe with a 415 before the email routes ran.
  if (request.method === "POST" && !pathname.startsWith("/api/")) {
    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.includes("application/x-www-form-urlencoded")) {
      return json({ error: "Unsupported content type" }, 415);
    }
    if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY) {
      return json({ error: "Payload too large" }, 413);
    }

    let form;
    try {
      form = await request.formData();
    } catch {
      return json({ error: "Malformed body" }, 400);
    }

    const formName = String(form.get("form-name") || "");
    if (!FORM_NAMES.has(formName)) {
      // Netlify answered 404 for posts that matched no registered form.
      return new Response("Not found", { status: 404 });
    }

    // Spam: same answer as a stored submission, nothing recorded.
    if (String(form.get("bot-field") || "").trim() !== "") return ack(request);

    const fields = {};
    for (const [key, value] of form.entries()) {
      if (key === "bot-field") continue;
      fields[key] = String(value).slice(0, 4000);
    }

    const invalid = invalidField(formName, fields);
    if (invalid) return json({ error: `Invalid ${invalid}` }, 400);

    try {
      const { ensureSchema } = await import("./_router.js");
      await ensureSchema(env.DB);
      await env.DB.prepare("INSERT INTO submissions (form, fields) VALUES (?, ?)")
        .bind(formName, JSON.stringify(fields))
        .run();
    } catch (error) {
      console.error("submission store failed:", error);
      return json({ error: "Could not store submission" }, 500);
    }

    return ack(request);
  }

  // Email subscription routes
  if (SUBSCRIBE_PATHS.has(pathname)) {
    if (pathname === "/api/subscribe" && request.method === "POST") {
      const { handleSubscribe } = await import("./email4.js");
      return handleSubscribe(request, env);
    }
    if (pathname === "/api/verify" && (request.method === "GET" || request.method === "HEAD")) {
      const { handleVerify } = await import("./email4.js");
      return handleVerify(request, env);
    }
    if (pathname === "/api/unsubscribe" && (request.method === "GET" || request.method === "HEAD")) {
      const { handleUnsubscribe } = await import("./email4.js");
      return handleUnsubscribe(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // Admin routes
  if (ADMIN_PATHS.has(pathname)) {
    const { handleScraperHealth, handleDataQuality, handleSystemMetrics, 
            handleErrorLogs, handleTriggerScraper, handleAdminTokens } = await import("./admin-api.js");
    
    if (pathname === '/api/admin/health' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleScraperHealth(request, env);
    }
    if (pathname === '/api/admin/quality' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleDataQuality(request, env);
    }
    if (pathname === '/api/admin/metrics' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleSystemMetrics(request, env);
    }
    if (pathname === '/api/admin/errors' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleErrorLogs(request, env);
    }
    if (pathname === '/api/admin/trigger' && request.method === 'POST') {
      return handleTriggerScraper(request, env);
    }
    if (pathname === '/api/admin/tokens' && (request.method === 'GET' || request.method === 'POST' || request.method === 'DELETE')) {
      return handleAdminTokens(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }


  // Agent-facing representations: explicit Markdown, negotiated documents,
  // and the status-carrying 404 page.
  if (request.method === "GET" || request.method === "HEAD") {
    const alias = MARKDOWN_ALIASES.get(pathname);
    if (alias) return markdownResponse(alias, 200, request.method);

    if (NOT_FOUND_PATHS.has(pathname)) {
      return notFoundResponse(request, env, pathname);
    }

    const agentDocument = DOCUMENTS.get(pathname);
    if (agentDocument) {
      return agentDocumentResponse(request, env, agentDocument);
    }
  }

  // Static assets and SPA fallback
  const documents = [
    { path: "/", file: "index.html" },
    { path: "/about", file: "about.html" },
    { path: "/comparison", file: "comparison.html" },
    { path: "/contact", file: "contact.html" },
    { path: "/privacy", file: "privacy.html" },
    { path: "/terms", file: "terms.html" },
    { path: "/refund", file: "refund.html" },
    { path: "/refunds", file: "refund.html" },
    { path: "/admin", file: "admin.html" },
    { path: "/daily-summaries", file: "daily-summaries.html" },
    { path: "/stamp-1g-processing-dates", file: "stamp-1g-processing-dates.html" },
    { path: "/employment-permit-processing-dates", file: "employment-permit-processing-dates.html" },
    { path: "/visa-processing-times", file: "visa-processing-times.html" },
    { path: "/monthly-report", file: "monthly-report.html" },
    { path: "/status", file: "status.html" },

    { path: "/vac-transit", file: "vac-transit.html" },
  ];

  // Serve data files (embassy JSON files) - with cache headers
  if (pathname.startsWith("/data/")) {
    const url = new URL(request.url);
    url.pathname = pathname;
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "application/json; charset=utf-8");
      // Cache JSON data for 5 minutes, allow stale-while-revalidate for 1 hour
      headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
      mergeVary(headers);
      return addSecurityHeaders(new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }));
    }
  }

  const document = documents.find((d) => d.path === pathname);
  if (document) {
    return fetchDocument(env, request, document);
  }

  // Static files other than the clean-URL documents above (CSS, JS, icons,
  // fonts, images and manifests) also live in the assets binding. Without
  // this fallback the catch-all function returns 404 for them.
  const assetResponse = await env.ASSETS.fetch(request);
  if (assetResponse.status !== 404) {
    const headers = new Headers(assetResponse.headers);
    mergeVary(headers);
    return addSecurityHeaders(new Response(request.method === "HEAD" ? null : assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers,
    }));
  }

  return notFoundResponse(request, env, pathname);
}


// VFS Appointment Availability Scraper
async function scrapeVFSAppointments(embassy) {
  // This is a placeholder - VFS Global uses dynamic JavaScript-heavy pages
  // Real implementation would need Puppeteer/Playwright or API access
  const embassyUrls = {
    'new-delhi': 'https://visa.vfsglobal.com/ind/en/irl',
    'mumbai': 'https://visa.vfsglobal.com/ind/en/irl',
    // ... other VACs
  };
  
  const url = embassyUrls[embassy];
  if (!url) return { error: 'Unknown embassy' };
  
  try {
    // Note: This won't work with simple fetch due to JS rendering
    // Would need Cloudflare Browser Rendering API or external service
    const response = await fetch(url, { 
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IrishVisaTracker/1.0)' }
    });
    const html = await response.text();
    return { html, scraped: true, url };
  } catch (err) {
    return { error: err.message };
  }
}

export async function handleVFSAppointments(request, env) {
  const url = new URL(request.url);
  const embassy = url.searchParams.get('embassy') || 'new-delhi';
  const result = await scrapeVFSAppointments(embassy);
  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }
  });
}

export default {
  async fetch(request, env) {
    // Initialize Sentry
    const { initSentry, captureException } = await import("./sentry.js");
    initSentry(env);
    
    try {
      return await handleRequest(request, env, captureException);
    } catch (error) {
      captureException(error, { url: request.url, method: request.method });
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  },

  // Scheduled handler for cron triggers (multi-embassy scraping)
  async scheduled(controller, env, ctx) {
    const { cron } = controller;
    console.log(`[Scheduled] Cron triggered: ${cron}`);

    // Map cron patterns to embassies
    const cronToEmbassy = {
      "30 5 * * *": "new-delhi",      // Daily at 11:00 IST (05:30 UTC)
      "0 6 * * 1": "beijing",         // Weekly Monday 06:00 UTC
      "0 6 * * 2": "dublin",          // Weekly Tuesday 06:00 UTC
      "0 6 * * 5": "abu-dhabi",       // Weekly Friday 06:00 UTC
      "0 6 * * 0": ["abuja", "ankara"], // Weekly Sunday 06:00 UTC
    };

    const embassies = cronToEmbassy[cron] || [];
    const embassyList = Array.isArray(embassies) ? embassies : [embassies];

    // Load embassy config
    const configResp = await fetch(`${REPO_RAW}/embassy-config.json`);
    if (!configResp.ok) {
      console.error(`[Scheduled] Failed to load embassy config: ${configResp.status}`);
      return;
    }
    const embassyConfig = await configResp.json();

    const scrapeEmbassy = async (embassy) => {
      try {
        let decisions = [];
        
        if (embassy.parser === "ods") {
          const { parseODS } = await import("./parsers/ods-cumulative.js");
          decisions = await parseODS(embassy.url, embassy.slug);
        } else if (embassy.parser === "html") {
          const { parseHTML } = await import("./parsers/html-paginated.js");
          decisions = await parseHTML(embassy.url, embassy.slug);
        } else if (embassy.parser === "pdf") {
          const { parsePDFWeekly } = await import("./parsers/pdf-weekly.js");
          const pdfUrl = await getLatestPDFUrl(embassy.url);
          if (!pdfUrl) return [];
          decisions = await parsePDFWeekly(pdfUrl, embassy.slug);
        }
        
        const existing = await loadExistingDecisions(embassy.slug);
        return mergeDecisions(existing, decisions);
      } catch (error) {
        console.error(`[Scheduled][${embassy.slug}] Scrape failed:`, error);
        return [];
      }
    };

    const getLatestPDFUrl = async (listingUrl) => {
      try {
        const response = await fetch(listingUrl, {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const html = await response.text();
        
        // Find the latest PDF link
        const pdfLinkRegex = /href=["']([^"']+\.pdf)["']/gi;
        let match;
        const pdfLinks = [];
        while ((match = pdfLinkRegex.exec(html)) !== null) {
          pdfLinks.push(match[1]);
        }
        
        if (pdfLinks.length === 0) return null;
        
        // Return the first (latest) PDF link, make it absolute
        const pdfUrl = pdfLinks[0];
        return pdfUrl.startsWith('http') ? pdfUrl : new URL(pdfUrl, listingUrl).href;
      } catch (error) {
        console.error(`[Scheduled] Failed to get PDF URL:`, error);
        return null;
      }
    };

    const loadExistingDecisions = async (slug) => {
      try {
        const response = await fetch(`${REPO_RAW}/data/embassy-${slug}.json`);
        if (!response.ok) return [];
        const data = await response.json();
        return data.decisions || [];
      } catch {
        return [];
      }
    };

    const mergeDecisions = (existing, incoming) => {
      const seen = new Map();
      for (const d of existing) seen.set(d.number, d);
      for (const d of incoming) seen.set(d.number, d);
      return Array.from(seen.values()).sort((a, b) => b.number.localeCompare(a.number));
    };

    for (const embassySlug of embassyList) {
      const embassy = embassyConfig.embassies.find(e => e.slug === embassySlug);
      if (!embassy || !embassy.enabled) continue;

      const decisions = await scrapeEmbassy(embassy);
      console.log(`[Scheduled][${embassySlug}] Scraped ${decisions.length} decisions`);

      // Note: In production, you'd push the updated data to GitHub via API
      // For now, the GitHub Actions workflow will pick up the changes on next run
      // or you can use a GitHub token to commit the updated JSON files
    }

    console.log(`[Scheduled] All scrapers completed for cron: ${cron}`);
  },
};