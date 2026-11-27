/**
 * Irish Visa Tracker - the routing half of this site's Pages Function.
 *
 * Pages compiles this directory (see `functions/[[path]].js`, the catch-all
 * route) and it imports this file, so the site's whole server side is here. The
 * `_` prefix keeps it out of the routing table: the only route is the catch-all
 * route beside it, which is also why nothing here has to think about a path pattern.
 *
 * This replaces Netlify Forms. The page's forms (`suggestions`, `corrections`,
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

const FORM_NAMES = new Set(["suggestions", "corrections", "timelines-visa", "timelines-1g", "timelines"]);
const TIMELINE_FORMS = ["timelines-visa", "timelines-1g", "timelines"];
const CORRECTION_OFFICES = new Set(["new-delhi", "beijing", "dublin", "abu-dhabi", "abuja", "ankara"]);
const CORRECTION_ISSUES = new Set(["wrong_decision", "missing_row", "wrong_date", "wrong_office", "other"]);
// Read-only feed for the nightly community sync. Deliberately narrow: only the
// three timeline form names are ever returned, never `suggestions`, which holds
// a visitor's name and free text.
const SUBMISSIONS_PATH = "/api/community-submissions";
const MAX_TIMELINE_ROWS = 5000;
const PUSH_PATHS = new Set(["/api/push/subscribe", "/api/push/unsubscribe"]);
const TELEGRAM_PATHS = new Set(["/api/telegram/start", "/api/telegram/webhook"]);
const ADMIN_PATHS = new Set(["/api/admin/health", "/api/admin/quality", "/api/admin/metrics", "/api/admin/errors", "/api/admin/trigger", "/api/admin/tokens"]);
const PREDICT_PATH = "/api/predict";
const PREDICT_FEEDBACK_PATH = "/api/predict/feedback";
const TELEGRAM_BROADCAST_PATH = "/api/telegram/broadcast";
const CALENDAR_PATH = "/api/calendar/next-update.ics";
const OFFICES_CALENDAR_PATH = "/api/calendar/offices.ics";
const OFFICIAL_FEED_PATHS = new Set(["/feed.xml", "/official-file-feed.json"]);
const CHECKLIST_PATH = "/api/checklist";
const VFS_APPOINTMENTS_PATH = "/api/vfs/appointments";
const SEARCH_PATH = "/api/search";
const ALERTS_PATH = "/api/alerts/run";

const CONFIG_PATH = "/api/config";
const EVENTS_PATH = "/api/events";
const REPORT_PATHS = new Set([
  "/api/reports/monthly", "/api/reports/changes", "/api/reports/corrections", "/api/digest/preview",
  "/api/digest/send"
]);

const MAX_BODY = 16 * 1024;
const NOT_FOUND_PATHS = new Set(["/404", "/404/", "/404.html"]);
// Pages that moved or were retired. The Pages Function owns these paths, so
// the redirect must live here rather than only in a static _redirects file.
const LEGACY_REDIRECTS = new Map([
  ["/comparison", "/about#method"],
  ["/comparison.html", "/about#method"],
  ["/vac-transit", "/help#vac"],
  ["/vac-transit.html", "/help#vac"],
]);

// The dashboard's data files are written by the GitHub Actions job
// to the repository root. We serve them from the Pages asset bucket
// (which is the repo root at build time) so they're at known paths.
const REPO_RAW = "https://raw.githubusercontent.com/parth-soni/irish-visa-tracker/main";

// A deployment must be visible on the next request. Never let a browser, a
// CDN, or a stale service worker reuse a response from an earlier build.
const NO_STORE = "no-store, no-cache, must-revalidate, max-age=0";
const HTML_CACHE = "no-cache, must-revalidate, max-age=0";
// The homepage is the one page with enough traffic to benefit from an edge
// copy. The browser still revalidates, so a deploy is visible on the next
// navigation; only the CDN may reuse the HTML for a minute.
const SHARED_HTML_CACHE = "no-cache, must-revalidate, max-age=0";
const SHARED_HTML_CDN = "public, s-maxage=60, stale-while-revalidate=300";
const ASSET_CACHE = "public, max-age=31536000, immutable";
const STATIC_CACHE = "public, max-age=3600, must-revalidate";
const IMMUTABLE_ROOTS = new Set([
  "/analytics-chart.css",
  "/analytics-chart.js",
  "/pages.css",
  "/site-chrome.css",
  "/site-chrome.js",
  "/icon.svg",
  "/apple-touch-icon.png",
]);
// These URLs control deployment and service-worker updates. They must never
// be reused from an HTTP cache, even though /scripts/* is otherwise immutable.
const NO_STORE_ASSETS = new Set(["/sw.js", "/scripts/index-sw.js"]);

function setNoStore(headers) {
  headers.set("Cache-Control", NO_STORE);
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", "no-store");
  return headers;
}

/** Homepage only: a browser revalidates a cached copy before using it, while
 *  the edge may serve its minute-old copy without a round trip. */
function setSharedHtmlCache(headers) {
  headers.set("Cache-Control", SHARED_HTML_CACHE);
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", SHARED_HTML_CDN);
  return headers;
}

/** HTML revalidates on every visit, so a deploy is visible immediately while
 *  ETag/Last-Modified still avoid re-sending an unchanged page. */
function setHtmlCache(headers) {
  headers.set("Cache-Control", HTML_CACHE);
  headers.set("Pragma", "no-cache");
  headers.set("Expires", "0");
  headers.set("CDN-Cache-Control", "no-cache");
  return headers;
}

function isImmutableAsset(pathname) {
  return pathname.startsWith("/styles/")
    || pathname.startsWith("/scripts/")
    || pathname.startsWith("/fonts/")
    || pathname.startsWith("/assets/")
    || IMMUTABLE_ROOTS.has(pathname);
}

function setAssetCache(headers) {
  headers.set("Cache-Control", ASSET_CACHE);
  headers.set("CDN-Cache-Control", ASSET_CACHE);
  headers.delete("Pragma");
  headers.delete("Expires");
  return headers;
}

function setStaticCache(headers) {
  headers.set("Cache-Control", STATIC_CACHE);
  headers.set("CDN-Cache-Control", STATIC_CACHE);
  headers.delete("Pragma");
  headers.delete("Expires");
  return headers;
}

import { INLINE_STYLE_SHA256S } from './_csp-inline-style.js';

// Security headers
function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // Inline executable scripts and <style> elements are extracted. Inline
  // style attributes remain for generated geometry, so only that attribute
  // source keeps unsafe-inline; script attributes are disabled entirely. The
  // content pages inline one identical stylesheet block and the homepage
  // inlines its own bundle; the build writes both hashes into
  // _csp-inline-style.js so exactly those blocks are allowed.
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com; " +
    "script-src-attr 'none'; " +
    "style-src 'self'; " +
    "style-src-attr 'unsafe-inline'; " +
    "style-src-elem 'self'" + INLINE_STYLE_SHA256S.map((hash) => ` '${hash}'`).join("") + "; " +
    "font-src 'self' data:; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' https://fcm.googleapis.com https://cloudflareinsights.com; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self' https://visa.vfsglobal.com; " +
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
  if (formName === "corrections") {
    if (!fields.name || fields.name.length > 200) return "name";
    if (!CORRECTION_OFFICES.has(fields.office)) return "office";
    if (!isISODate(fields.report_date)) return "report_date";
    const today = new Date().toISOString().slice(0, 10);
    if (fields.report_date < "2020-01-01" || fields.report_date > today) return "report_date";
    if (String(fields.source_url || "").length > 1000 || !isHttpUrl(fields.source_url)) return "source_url";
    if (!CORRECTION_ISSUES.has(fields.issue)) return "issue";
    if (fields.application_number && !/^\d{8}$/.test(fields.application_number)) return "application_number";
    if (!fields.details || fields.details.length > 5000) return "details";
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

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const json = (body, status = 200) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  setNoStore(headers);
  return addSecurityHeaders(new Response(JSON.stringify(body), { status, headers }));
};

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
  // The homepage is the deployment entry point: it must be fetched new so the
  // next build's versioned assets and service-worker registration are visible
  // immediately. Other HTML revalidates; versioned CSS/JS is cached by the
  // asset rules.
  if (document.sharedCache) setSharedHtmlCache(headers);
  else if (document.noStore) setNoStore(headers);
  else setHtmlCache(headers);
  mergeVary(headers);
  return addSecurityHeaders(new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

async function notFoundPage(env, request) {
  let response = null;
  // Cloudflare Pages reserves /404.html and /404: requesting either one makes
  // the assets layer redirect to /404 with an empty body. The build writes the
  // same page to an internal clean URL that is served normally, so fetch that
  // first and keep the inline page as a last-resort fallback. Using the clean
  // URL avoids Pages' .html -> extensionless redirect as well.
  try {
    response = await env.ASSETS.fetch(new Request(new URL("/404-internal", request.url), request));
  } catch {
    // Fall through to the inline page below if the assets binding is unavailable.
  }

  if (!response || !response.ok || response.headers.has("Location")) {
    response = new Response(
      "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>Page not found | Irish Visa Decision Tracker</title><link rel=\"stylesheet\" href=\"/pages.css\"></head><body><main class=\"notfound\" id=\"main-content\"><p class=\"notfound-code\">404 &bull; Nothing at this address</p><h1>Page not found</h1><p>This page has moved, or the link was mistyped. The tracker itself is still at the home page, and the published pages are listed in the sitemap.</p><div class=\"notfound-links\"><a href=\"/\">Back to the tracker</a><a href=\"/sitemap.xml\">Sitemap</a><a href=\"/llms.txt\">Agent guide</a><a href=\"/about\">About</a></div></main></body></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const headers = new Headers(response.headers);
  headers.delete("Location");
  headers.set("Content-Type", "text/html; charset=utf-8");
  setNoStore(headers);
  headers.set("X-Robots-Tag", "noindex");
  mergeVary(headers);
  return addSecurityHeaders(new Response(request.method === "HEAD" ? null : response.body, {
    status: 404,
    statusText: "Not Found",
    headers,
  }));
}

async function notFoundResponse(request, env, pathname) {
  const choice = negotiate(request.headers.get("Accept"));
  const requestOrigin = String(env.APP_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
  if (choice === "markdown") {
    return markdownResponse(notFoundMarkdown(pathname), 404, request.method, requestOrigin);
  }
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method, requestOrigin);
  }
  return notFoundPage(env, request);
}

async function agentDocumentResponse(request, env, document, origin = "") {
  const choice = negotiate(request.headers.get("Accept"));
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method, origin);
  }
  if (choice === "markdown") {
    return markdownResponse(document.markdown, 200, request.method, origin);
  }
  return fetchDocument(env, request, {
    file: document.file,
    alternate: document.alternate,
    noStore: document.noStore,
    sharedCache: document.sharedCache,
  });
}

// Main request handler
async function handleRequest(request, env) {
  const requestUrl = new URL(request.url);
  const { pathname } = requestUrl;

  // After the custom-domain cutover, point the old pages.dev hostname at the
  // branded origin with a permanent redirect. Only GET/HEAD are redirected:
  // POST bodies must not be replayed across origins. Set
  // PAGES_DEV_REDIRECT_ORIGIN=https://your-domain.example in Pages variables.
  if ((request.method === "GET" || request.method === "HEAD")
      && requestUrl.hostname === "irishvisaupdatetracker.pages.dev") {
    let redirectOrigin = "";
    try {
      const configured = new URL(String(env.PAGES_DEV_REDIRECT_ORIGIN || ""));
      if (configured.protocol === "https:") redirectOrigin = configured.origin;
    } catch {
      // Leave pages.dev serving normally when the variable is absent/invalid.
    }
    if (redirectOrigin) {
      return addSecurityHeaders(new Response(null, {
        status: 301,
        headers: { Location: `${redirectOrigin}${requestUrl.pathname}${requestUrl.search}` },
      }));
    }
  }

  if ((request.method === "GET" || request.method === "HEAD") && LEGACY_REDIRECTS.has(pathname)) {
    const target = new URL(LEGACY_REDIRECTS.get(pathname), request.url);
    return addSecurityHeaders(new Response(null, {
      status: 301,
      headers: { Location: target.href },
    }));
  }

  // Health check endpoint (no rate limiting)
  if (pathname === '/api/health' || pathname === '/health') {
    return handleHealthCheck(env, request);
  }

  // Public browser configuration. Only publishable values belong here; the
  // VAPID private key and every mail secret stay server-side.
  if (pathname === CONFIG_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
    const channel = String(env.TELEGRAM_CHANNEL_URL || '').trim();
    return json({
      vapid_public_key: env.VAPID_PUBLIC_KEY || '',
      brand_name: env.BRAND_NAME || 'Irish Visa Decision Tracker',
      brand_color: env.BRAND_COLOR || '#047857',
      support_email: env.SUPPORT_EMAIL || '',
      telegram_channel_url: /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}\/?$/.test(channel) ? channel : '',
      official_feed_url: '/feed.xml',
      official_feed_json_url: '/official-file-feed.json',
      offices_calendar_url: '/api/calendar/offices.ics'
    });
  }

  // Public official-file feeds. These are intentionally outside /api/ so feed
  // readers and aggregators can use them without an API key or CORS dance.
  if (OFFICIAL_FEED_PATHS.has(pathname)) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const { officialFeedResponse } = await import('./official-feed.js');
    return officialFeedResponse(env, request);
  }

  if (pathname === CALENDAR_PATH) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const { calendarResponse } = await import('./calendar.js');
    return calendarResponse(new Date(), request.method === 'HEAD');
  }

  if (pathname === OFFICES_CALENDAR_PATH) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const { officesCalendarResponse } = await import('./calendar.js');
    return officesCalendarResponse(env, request);
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

  // Prediction route (published baseline + model card)
  if (pathname === PREDICT_PATH) {
    const { onRequest } = await import("./api/predict.js");
    const handler = onRequest[request.method] || onRequest.POST;
    return handler({ request, env });
  }

  if (pathname === PREDICT_FEEDBACK_PATH) {
    const { onRequest } = await import("./api/predict-feedback.js");
    const handler = onRequest[request.method];
    if (!handler) return new Response("Method not allowed", { status: 405 });
    return handler({ request, env });
  }

  if (pathname === TELEGRAM_BROADCAST_PATH) {
    const { handleTelegramBroadcast } = await import("./telegram-broadcast.js");
    return handleTelegramBroadcast(request, env);
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
  // should reach the generic form handler below.
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
    const requestOrigin = String(env.APP_BASE_URL || new URL(request.url).origin).replace(/\/+$/, "");
    const alias = MARKDOWN_ALIASES.get(pathname);
    if (alias) return markdownResponse(alias, 200, request.method, requestOrigin);

    if (NOT_FOUND_PATHS.has(pathname)) {
      return notFoundResponse(request, env, pathname);
    }

    const agentDocument = DOCUMENTS.get(pathname);
    if (agentDocument) {
      return agentDocumentResponse(request, env, agentDocument, requestOrigin);
    }
  }

  // Static assets and SPA fallback
  const documents = [
    { path: "/", file: "index.html", sharedCache: true },
    { path: "/about", file: "about.html" },
    { path: "/help", file: "help.html" },
    { path: "/vfs-tracking", file: "vfs-tracking.html" },
    { path: "/contact", file: "contact.html" },
    { path: "/corrections", file: "corrections.html" },
    { path: "/privacy", file: "privacy.html" },
    { path: "/terms", file: "terms.html" },
    { path: "/daily-summaries", file: "daily-summaries.html" },
    { path: "/irish-visa-decisions-today", file: "irish-visa-decisions-today.html" },
    { path: "/new-delhi-visa-decisions", file: "new-delhi-visa-decisions.html" },
    { path: "/beijing-visa-decisions", file: "beijing-visa-decisions.html" },
    { path: "/abu-dhabi-visa-decisions", file: "abu-dhabi-visa-decisions.html" },
    { path: "/abuja-visa-decisions", file: "abuja-visa-decisions.html" },
    { path: "/ankara-visa-decisions", file: "ankara-visa-decisions.html" },
    { path: "/dublin-visa-decisions", file: "dublin-visa-decisions.html" },
    { path: "/stamp-1g-processing-dates", file: "stamp-1g-processing-dates.html" },
    { path: "/employment-permit-processing-dates", file: "employment-permit-processing-dates.html" },
    { path: "/visa-processing-times", file: "visa-processing-times.html" },
    { path: "/monthly-report", file: "monthly-report.html" },
    { path: "/status", file: "status.html" },
    { path: "/data", file: "data.html" },
    { path: "/data-study", file: "data-study.html" },
    { path: "/when-are-visa-decisions-published", file: "when-are-visa-decisions-published.html" },
    { path: "/press", file: "press.html" },
    { path: "/embed", file: "embed.html" },
    { path: "/community-timelines", file: "community-timelines.html" },
    { path: "/reports", file: "reports.html" },
    { path: "/all-pages", file: "all-pages.html" },
    { path: "/after-approval", file: "after-approval.html" },
    { path: "/after-refusal", file: "after-refusal.html" },
    { path: "/missing-decision", file: "missing-decision.html" },
    { path: "/find-my-office", file: "find-my-office.html" },
    { path: "/bulk-tools", file: "bulk-tools.html" },
    { path: "/decisions", file: "decisions.html" },
    { path: "/search-coverage", file: "search-coverage.html" },
  ];

  // Quality-gated date archives live in decisions/<YYYY-MM-DD>.html.
  const decisionDateMatch = pathname.match(/^\/decisions\/(\d{4}-\d{2}-\d{2})$/);
  if (decisionDateMatch) {
    return fetchDocument(env, request, { file: `decisions/${decisionDateMatch[1]}.html` });
  }

  // Report permalinks live in reports/<office>/<date>.html and office report
  // indexes in reports/<office>.html. A generic asset fetch cannot be relied on
  // to resolve both clean-URL shapes, so try the exact HTML file too.
  const reportMatch = pathname.match(/^\/reports\/([a-z0-9-]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (reportMatch) {
    const file = `reports/${reportMatch[1]}${reportMatch[2] ? `/${reportMatch[2]}` : ''}.html`;
    return fetchDocument(env, request, { file });
  }

  // Monthly archive pages live in monthly-report/<YYYY-MM>.html and are
  // self-canonical. The latest report keeps the interactive /monthly-report
  // shell.
  const monthlyMatch = pathname.match(/^\/monthly-report\/(\d{4}-\d{2})$/);
  if (monthlyMatch) {
    return fetchDocument(env, request, { file: `monthly-report/${monthlyMatch[1]}.html` });
  }

  // Serve data files (embassy JSON files) - with cache headers
  if (pathname.startsWith("/data/")) {
    const url = new URL(request.url);
    url.pathname = pathname;
    const response = await env.ASSETS.fetch(new Request(url, request));
    if (response.ok) {
      const headers = new Headers(response.headers);
      // Data is mostly JSON, but generated study CSVs and chart SVGs also live
      // under /data/ and must keep the content type the assets layer assigned.
      if (pathname.endsWith(".json")) headers.set("Content-Type", "application/json; charset=utf-8");
      // Data changes with a deploy or scrape; always read the current files.
      setNoStore(headers);
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
    if (pathname === "/index.html") setSharedHtmlCache(headers);
    else if (NO_STORE_ASSETS.has(pathname)) setNoStore(headers);
    else if (isImmutableAsset(pathname)) setAssetCache(headers);
    else setStaticCache(headers);
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