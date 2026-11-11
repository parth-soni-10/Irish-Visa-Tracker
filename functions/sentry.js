/**
 * Sentry Error Tracking for Cloudflare Workers.
 *
 * The DSN is a deployment secret. When it is absent the SDK is not initialized
 * and every helper is a cheap no-op; when it is present the real SDK captures
 * exceptions and messages. Do not log the DSN itself.
 */

import * as Sentry from '@sentry/cloudflare';
import { isInitialized } from '@sentry/cloudflare';

let sentryInitialized = false;
let sentryFailed = false;

/**
 * The Pages entry point wraps the router with Sentry.withSentry, which is the
 * supported Cloudflare initialization path (this package intentionally does
 * not export a Node-style init()). This helper only mirrors that state so the
 * router's capture helpers know whether a client exists.
 */
export function initSentry(env) {
  if (sentryInitialized) return true;
  if (sentryFailed) return false;
  if (isInitialized()) { sentryInitialized = true; return true; }

  const dsn = env && env.SENTRY_DSN;
  if (!dsn || dsn.includes('dummy') || !/^https?:\/\//.test(dsn)) {
    // A missing DSN is an expected local/CI state, not a per-request warning.
    // `/api/config` exposes whether error tracking is configured.
    sentryFailed = true;
    return false;
  }
  // A real DSN is present but the entry wrapper has not initialized yet;
  // do not pretend to have a client.
  return false;
}

export function captureException(error, context = {}) {
  if (!sentryInitialized) {
    console.error('[Sentry disabled]', error && error.message, context);
    return;
  }
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) scope.setExtra(key, value);
    Sentry.captureException(error);
  });
}

export function captureMessage(message, level = 'info', context = {}) {
  if (!sentryInitialized) return;
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context)) scope.setExtra(key, value);
    Sentry.captureMessage(message, level);
  });
}

export function setUserContext(user) {
  if (!sentryInitialized || !user) return;
  Sentry.setUser({ id: user.id });
}

export function addBreadcrumb(category, message, data = {}) {
  if (!sentryInitialized) return;
  Sentry.addBreadcrumb({ category, message, data });
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