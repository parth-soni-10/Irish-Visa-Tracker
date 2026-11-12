/* ---------------------------------------------------------------------------
 * The Pages Function this site is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request arrives here, and the router it imports -
 * `_router.js` - does the work: it records the three forms' POSTs in D1,
 * serves the timeline rows back at `GET /api/community-submissions`, proxies
 * `data/` from the repository, and hands everything else to `env.ASSETS`.
 * ------------------------------------------------------------------------ */
import router from './_router.js';

export const onRequest = (context) => router.fetch(context.request, context.env, context);
