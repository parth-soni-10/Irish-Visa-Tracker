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

const FORM_NAMES = new Set(["suggestions", "timelines-visa", "timelines-1g", "timelines"]);
const TIMELINE_FORMS = ["timelines-visa", "timelines-1g", "timelines"];
const SUBSCRIBE_PATHS = new Set(["/api/subscribe", "/api/verify", "/api/unsubscribe"]);
const PUSH_PATHS = new Set(["/api/push/subscribe", "/api/push/unsubscribe"]);
const USER_PUSH_PATHS = new Set(["/api/user/push/subscribe", "/api/user/push/unsubscribe", "/api/user/push/key"]);
const AUTH_PATHS = new Set(["/api/auth/register", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/profile", "/api/auth/password", "/api/auth/delete", "/api/auth/verify", "/api/auth/password/reset", "/api/auth/password/reset/confirm"]);
const ADMIN_PATHS = new Set(["/api/admin/health", "/api/admin/quality", "/api/admin/metrics", "/api/admin/errors", "/api/admin/trigger", "/api/admin/tokens"]);
const USER_PATHS = new Set(["/api/user/profile", "/api/user/watchlist", "/api/user/alerts"]);
const USER_PREFIXES = ["/api/user/watchlist/"];
const PREDICT_PATH = "/api/predict";
const CHECKLIST_PATH = "/api/checklist";
const VFS_APPOINTMENTS_PATH = "/api/vfs/appointments";
const SEARCH_PATH = "/api/search";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY = 16 * 1024;

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_verifications (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  application_number TEXT NOT NULL,
  embassy_slug TEXT NOT NULL,
  nickname TEXT,
  notify_email INTEGER DEFAULT 1,
  notify_push INTEGER DEFAULT 1,
  notify_whatsapp INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_unique ON watchlists(user_id, application_number, embassy_slug);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlists(user_id);

-- Saved searches for advanced search
CREATE TABLE IF NOT EXISTS saved_searches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  params TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

let schemaReady = false;
export async function ensureSchema(db) {
  if (schemaReady) return;
  
  const statements = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
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

// The dashboard's data files are written by the GitHub Actions job
// to the repository root. We serve them from the Pages asset bucket
// (which is the repo root at build time) so they're at known paths.
const REPO_RAW = "https://raw.githubusercontent.com/parth-soni/irish-visa-tracker/main";

// In-memory rate limit store (per-instance, not durable across restarts)
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 60; // 60 requests per minute per IP

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
    "connect-src 'self' https://api.resend.com https://fcm.googleapis.com https://*.sentry.io; " +
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

/** Fetch a negotiated HTML document, falling back to its .html file if the
 *  assets layer does not resolve the clean URL itself. */
async function fetchDocument(env, request, document) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && document.file) {
    const url = new URL(request.url);
    url.pathname = document.file;
    response = await env.ASSETS.fetch(new Request(url, request));
  }
  const headers = new Headers(response.headers);
  // Cache HTML for 5 minutes, stale-while-revalidate 1 hour
  if (headers.get("Content-Type")?.includes("text/html")) {
    headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  }
  // JS/CSS assets get longer cache
  if (headers.get("Content-Type")?.includes("javascript") || headers.get("Content-Type")?.includes("css")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  mergeVary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Main request handler with error tracking
async function handleRequest(request, env, captureException) {
  const { pathname } = new URL(request.url);

  // Health check endpoint (no rate limiting)
  if (pathname === '/api/health' || pathname === '/health') {
    return handleHealthCheck(env);
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

  // Auth routes (register, login, logout, me, profile, password, delete)
  if (AUTH_PATHS.has(pathname)) {
    const { handleRegister, handleLogin, handleLogout, handleMe, 
            handleUpdateProfile, handleChangePassword, handleDeleteAccount,
            handleVerifyEmail, handlePasswordResetRequest, handlePasswordResetConfirm } = await import("./user-api.js");
    
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
    if (pathname === '/api/auth/verify' && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleVerifyEmail(request, env);
    }
    if (pathname === '/api/auth/password/reset' && request.method === 'POST') {
      return handlePasswordResetRequest(request, env);
    }
    if (pathname === '/api/auth/password/reset/confirm' && request.method === 'POST') {
      return handlePasswordResetConfirm(request, env);
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
            handleUpdateWatchlist, handleGetAlerts, handlePushSubscribe,
            handlePushUnsubscribe, handlePushKey } = await import("./user-api.js");

    if (pathname === '/api/user/profile' && request.method === 'GET') {
      return handleMe(request, env);
    }
    if (pathname === '/api/user/profile' && (request.method === 'PUT' || request.method === 'PATCH')) {
      return handleUserUpdateProfile(request, env);
    }
    if (pathname === '/api/user/watchlist' && request.method === 'GET') {
      return handleGetWatchlist(request, env);
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
    if (pathname === '/api/user/push/key' && request.method === 'GET') {
      return handlePushKey(request, env);
    }
    if (pathname === '/api/user/push/subscribe' && request.method === 'POST') {
      return handlePushSubscribe(request, env);
    }
    if (pathname === '/api/user/push/unsubscribe' && (request.method === 'DELETE' || request.method === 'POST')) {
      return handlePushUnsubscribe(request, env);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  if (request.method === "POST") {
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


  // Static assets and SPA fallback
  const documents = [
    { path: "/", file: "index.html" },
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

  // Not found
  const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
  mergeVary(headers);
  return addSecurityHeaders(new Response("Not Found", {
    status: 404,
    statusText: "Not Found",
    headers,
  }));
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
          const { parseODS } = await import("./parsers/ods.js");
          decisions = await parseODS(embassy.url, embassy.slug);
        } else if (embassy.parser === "html") {
          const { parseHTML } = await import("./parsers/html.js");
          decisions = await parseHTML(embassy.url, embassy.slug);
        } else if (embassy.parser === "pdf") {
          const { parsePDFWeekly } = await import("./parsers/pdf.js");
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