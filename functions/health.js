/**
 * Health check endpoint
 */

export async function handleHealthCheck(env) {
  const checks = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    services: {
      database: 'unknown',
      storage: 'unknown',
    }
  };

  // Check database connectivity
  try {
    await env.DB.prepare('SELECT 1').first();
    checks.services.database = 'healthy';
  } catch (error) {
    checks.services.database = 'unhealthy';
    checks.status = 'degraded';
  }

  // Check if we can access R2/KV (storage)
  try {
    // Just check if the binding exists
    if (env.ASSETS) {
      checks.services.storage = 'healthy';
    } else {
      checks.services.storage = 'not configured';
    }
  } catch (error) {
    checks.services.storage = 'unhealthy';
    checks.status = 'degraded';
  }

  const statusCode = checks.status === 'healthy' ? 200 : 503;
  return new Response(JSON.stringify(checks, null, 2), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}