/* ---------------------------------------------------------------------------
 * The Pages Function this site is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request arrives here, and the router it imports -
 * `_router.js` - does the work: it records the three forms' POSTs in D1, serves
 * the timeline rows back at `GET /api/community-submissions`, proxies `data/`
 * from the repository, and hands everything else to `env.ASSETS`.
 *
 * Sentry is initialized by wrapping the handler with withSentry. The
 * @sentry/cloudflare package deliberately does not expose a Node-style init();
 * its entry-point wrapper owns client setup and request scope.
 * ------------------------------------------------------------------------ */
import { withSentry } from '@sentry/cloudflare';
import router from './_router.js';

const handler = {
  async fetch(request, env, ctx) {
    return router.fetch(request, env, ctx);
  }
};

const wrapped = withSentry((env) => {
  const dsn = env && env.SENTRY_DSN;
  if (!dsn || dsn.includes('dummy') || !/^https?:\/\//.test(dsn)) return undefined;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT || (env.CF_PAGES_BRANCH === 'main' ? 'production' : 'preview'),
    release: env.COMMIT_SHA || env.CF_PAGES_COMMIT_SHA || undefined,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    sendDefaultPii: false,
    beforeSend(event) {
      const value = event.exception && event.exception.values && event.exception.values[0]
        && event.exception.values[0].value;
      if (value && /Network request failed|Failed to fetch/i.test(value)) return null;
      return event;
    }
  };
}, handler);

export const onRequest = (context) => wrapped.fetch(context.request, context.env, context);
