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
import { getRequestId, logEvent, logRequest, withRequestId } from "./monitoring.js";
import { ensureSchema } from "./db-schema.js";
export { ensureSchema };
import { checkRateLimit, getClientIp } from "./rate-limit.js";
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
const TELEGRAM_PATHS = new Set(["/api/telegram/start", "/api/telegram/webhook"]);
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
const EVENTS_PATH = "/api/events";
const EMAIL_WEBHOOK_PATH = "/api/email/send";
const REPORT_PATHS = new Set([
  "/api/reports/monthly", "/api/reports/changes", "/api/digest/preview",
  "/api/digest/subscribe", "/api/digest/verify", "/api/digest/unsubscribe", "/api/digest/send"
]);

const MAX_BODY = 16 * 1024;
const NOT_FOUND_PATHS = new Set(["/404", "/404/", "/404.html"]);

// The dashboard's data files are written by the GitHub Actions job
// to the repository root. We serve them from the Pages asset bucket
// (which is the repo root at build time) so they're at known paths.
const REPO_RAW = "https://raw.githubusercontent.com/parth-soni/irish-visa-tracker/main";

// Security headers
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Inline executable scripts and <style> elements are extracted. Inline
  // style attributes remain for generated geometry, so only that attribute
  // source keeps unsafe-inline; script attributes are disabled entirely.
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; " +
    "script-src-attr 'none'; " +
    "style-src 'self'; " +
    "style-src-attr 'unsafe-inline'; " +
    "style-src-elem 'self'; " +
    "font-src 'self' data:; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://fcm.googleapis.com https://cloudflareinsights.com; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "object-src 'none';"
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
  if (formName === "timelines-visa" || formName === "timelines-1g" || formName === "timelines") {
    // The current forms submit dates, outcome and tracker. `visa_type` and
    // `embassy` belonged to the old combined form; accept them when present
    // for legacy posts, but do not require them for the split forms.
    if (fields.visa_type && fields.visa_type.length > 100) return "visa_type";
    if (fields.embassy && fields.embassy.length > 100) return "embassy";
    if (!["granted", "refused"].includes(fields.outcome)) return "outcome";
    const expectedTracker = formName === "timelines-visa" ? "visa"
      : formName === "timelines-1g" ? "1g" : "";
    if (expectedTracker ? fields.tracker !== expectedTracker
      : !["visa", "1g"].includes(fields.tracker)) return "tracker";
    if (!isISODate(fields.applied)) return "applied";
    if (!isISODate(fields.decided)) return "decided";
    const today = new Date().toISOString().slice(0, 10);
    if (fields.applied < "2020-01-01" || fields.decided < fields.applied || fields.decided > today) {
      return "decided";
    }
  }
  return null;
}

function isISODate(value) {
  const raw = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(raw + "T00:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw;
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

// Main request handler
async function handleRequest(request, env) {
  const { pathname } = new URL(request.url);

  // Health check endpoint (no rate limiting)
  if (pathname === '/api/health' || pathname === '/health') {
    return handleHealthCheck(env, request);
  }

  // Public browser configuration. Only publishable values belong here; the
  // VAPID private key and every mail secret stay server-side.
  if (pathname === CONFIG_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
    return json({
      vapid_public_key: env.VAPID_PUBLIC_KEY || '',
      brand_name: env.BRAND_NAME || 'Irish Visa Decision Tracker',
      brand_color: env.BRAND_COLOR || '#047857',
      support_email: env.SUPPORT_EMAIL || '',
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

  // Rate limiting for API endpoints. D1 is the shared counter, so one client
  // cannot get a fresh budget by landing on another edge isolate.
  if (pathname.startsWith('/api/')) {
    const decision = await checkRateLimit(env, {
      bucket: 'api',
      subject: getClientIp(request),
      limit: Math.max(1, Number(env.API_RATE_LIMIT_MAX) || 300),
      windowSeconds: 60
    });
    if (!decision.allowed) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(decision.retryAfter || 60)
        }
      });
    }
  }

  // Conversion funnel. Public, anonymous and deliberately narrow; the global
  // API limiter above already throttles it.
  if (pathname === EVENTS_PATH && request.method === 'POST') {
    const { handleEvents } = await import('./events.js');
    return handleEvents(request, env);
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
  // Telegram decision alerts (anonymous subscriptions linked through the bot)
  if (TELEGRAM_PATHS.has(pathname)) {
    const { handleTelegramStart, handleTelegramWebhook } = await import("./telegram.js");
    if (pathname === "/api/telegram/start" && request.method === "POST") {
      return handleTelegramStart(request, env);
    }
    if (pathname === "/api/telegram/webhook" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
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


export default {
  async fetch(request, env, ctx) {
    const startedAt = Date.now();
    const requestId = getRequestId(request);
    try {
      const response = await handleRequest(request, env);
      logRequest({ request, response, requestId, startedAt });
      return withRequestId(response, requestId, request);
    } catch (error) {
      logRequest({ request, requestId, startedAt, error });
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'X-Request-Id': requestId }
      });
    }
  },

  // Scheduled handler for cron triggers (multi-embassy scraping)
  async scheduled(controller, env, ctx) {
    const { cron } = controller;
    const startedAt = Date.now();
    logEvent('info', 'scheduled_start', { cron });

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
      logEvent('error', 'scheduled_config_error', { cron, status: configResp.status });
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
        logEvent('error', 'scheduled_embassy_error', {
          cron,
          embassy: embassy.slug,
          error: { name: String(error.name || 'Error'), message: String(error.message || error).slice(0, 500) }
        });
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

    logEvent('info', 'scheduled_complete', {
      cron,
      duration_ms: Date.now() - startedAt,
      embassies: embassyList.length
    });
  },
};