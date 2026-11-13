/**
 * Readiness endpoint for the external uptime check.
 *
 * HTTP 200 means the function can reach D1 and serve a real static asset. Any
 * failed dependency returns 503 so a monitor can alert on the status code
 * without having to understand the body. The response deliberately contains no
 * error messages, credentials or user data.
 */
export async function handleHealthCheck(env, request) {
  const checks = {
    ok: false,
    status: 'degraded',
    service: 'irish-visa-tracker',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      database: 'unknown',
      storage: 'unknown'
    }
  };

  try {
    if (!env.DB) throw new Error('D1 binding missing');
    await env.DB.prepare('SELECT 1').first();
    checks.services.database = 'healthy';
  } catch {
    checks.services.database = 'unhealthy';
  }

  try {
    if (!env.ASSETS) {
      checks.services.storage = 'not configured';
    } else if (request) {
      const assetUrl = new URL('/data/data_manifest.json', request.url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: 'HEAD' }));
      checks.services.storage = asset.ok ? 'healthy' : 'unhealthy';
    } else {
      checks.services.storage = 'healthy';
    }
  } catch {
    checks.services.storage = 'unhealthy';
  }

  const healthy = Object.values(checks.services).every((value) => value === 'healthy');
  checks.ok = healthy;
  checks.status = healthy ? 'healthy' : 'degraded';
  if (env.CF_PAGES_COMMIT_SHA) checks.commit = String(env.CF_PAGES_COMMIT_SHA).slice(0, 12);

  return new Response(request && request.method === 'HEAD' ? null : JSON.stringify(checks, null, 2), {
    status: healthy ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex'
    }
  });
}
