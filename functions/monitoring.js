/**
 * Structured logging for the Pages Function.
 *
 * This replaces the removed Sentry SDK with plain JSON lines. Cloudflare Pages
 * exposes these through the dashboard's Functions log view and
 * `wrangler pages deployment tail`; they are intentionally free of request
 * bodies, query strings, IP addresses, cookies and email addresses.
 *
 * Keep the message shape stable: Workers Logs queries and Logpush consumers can
 * rely on `event`, `level`, `request_id`, `path`, `method`, `status` and
 * `duration_ms`.
 */

const SERVICE = 'irish-visa-tracker';

export function getRequestId(request) {
  const supplied = request.headers.get('cf-ray') || request.headers.get('x-request-id') || '';
  return /^[A-Za-z0-9-]{8,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

export function logEvent(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    service: SERVICE,
    ...fields
  };
  const line = JSON.stringify(record);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function redactUrls(value, limit) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
      try {
        const url = new URL(raw);
        url.search = '';
        return url.toString();
      } catch {
        return raw;
      }
    })
    .slice(0, limit);
}

function errorDetails(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error'),
    message: redactUrls(error.message || error, 500),
    stack: error.stack ? redactUrls(error.stack, 2000) : undefined
  };
}

/**
 * Log one request. Static asset successes are deliberately omitted so a normal
 * page load does not drown the API signal. Every 5xx is logged, and API 4xx
 * responses are logged at warn level.
 */
export function logRequest({ request, response, requestId, startedAt, error }) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const durationMs = Math.max(0, Date.now() - startedAt);
  const common = {
    request_id: requestId,
    method,
    path,
    duration_ms: durationMs
  };

  if (error) {
    logEvent('error', 'request_error', {
      ...common,
      status: 500,
      outcome: 'error',
      error: errorDetails(error)
    });
    return;
  }

  const status = response.status;
  if (!path.startsWith('/api/') && status < 500) return;

  logEvent(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'request', {
    ...common,
    status,
    outcome: status >= 500 ? 'error' : status >= 400 ? 'client_error' : 'ok'
  });
}

/** Attach a correlation id without changing the response body or status. */
export function withRequestId(response, requestId, request) {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  if (request) {
    const path = new URL(request.url).pathname;
    const cacheControl = headers.get('Cache-Control') || '';
    // API responses are personalized or dynamic; only an explicitly public
    // response (the VAPID key/config) may keep its cache policy.
    if (path.startsWith('/api/') && !cacheControl.startsWith('public')) {
      headers.set('Cache-Control', 'no-store');
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
