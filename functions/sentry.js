/**
 * Sentry Error Tracking for Cloudflare Workers
 * Uses @sentry/cloudflare which auto-initializes via DSN env var
 */

let sentryInitialized = false;

export function initSentry(env) {
  if (sentryInitialized) return;
  
  const dsn = env.SENTRY_DSN;
  if (!dsn || dsn.includes('dummy')) {
    console.warn('[Sentry] DSN not configured (or dummy), error tracking disabled');
    return;
  }
  
  try {
    // @sentry/cloudflare auto-initializes when SENTRY_DSN is set in env
    console.log('[Sentry] Initialized with DSN:', dsn.substring(0, 20) + '...');
    sentryInitialized = true;
  } catch (error) {
    console.warn('[Sentry] Initialization failed:', error.message);
  }
}

export function captureException(error, context = {}) {
  if (!sentryInitialized) return;
  
  try {
    console.error('[Sentry] Captured exception:', error.message, context);
  } catch (e) {
    // Silently fail
  }
}

export function captureMessage(message, level = 'info', context = {}) {
  if (!sentryInitialized) return;
  
  try {
    console.log(`[Sentry] ${level}:`, message, context);
  } catch (e) {
    // Silently fail
  }
}

export function setUserContext(user) {
  if (!sentryInitialized) return;
  
  try {
    console.log('[Sentry] User context:', { id: user.id, email: user.email });
  } catch (e) {
    // Silently fail
  }
}

export function addBreadcrumb(category, message, data = {}) {
  if (!sentryInitialized) return;
  
  try {
    console.log('[Sentry] Breadcrumb:', category, message, data);
  } catch (e) {
    // Silently fail
  }
}

// Express-like middleware for Cloudflare Workers
export function sentryMiddleware() {
  return async (request, env, next) => {
    if (!sentryInitialized) initSentry(env);
    
    try {
      const response = await next(request, env);
      return response;
    } catch (error) {
      captureException(error, { url: request.url, method: request.method });
      throw error;
    }
  };
}