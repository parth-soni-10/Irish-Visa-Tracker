/* ---------------------------------------------------------------------------
 * The Pages Function this site is served by.
 *
 * Pages is this site's only host. `functions/[[path]].js` is the catch-all
 * route, so every request arrives here, and the router does the work: it
 * records the three forms' POSTs in D1, serves the timeline rows back at
 * `GET /api/community-submissions`, proxies `data/` from the repository, and
 * hands everything else to `env.ASSETS`.
 * ------------------------------------------------------------------------ */

// Dynamic import for CommonJS router module
let router;

export const onRequest = async (context) => {
  if (!router) {
    const routerModule = await import('./_router.js');
    router = routerModule.default || routerModule;
  }
  return router.fetch(context.request, context.env, context);
};
