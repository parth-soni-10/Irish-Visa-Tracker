/**
 * Standalone uptime monitor Worker.
 *
 * This is intentionally separate from the Pages project: Pages Functions only
 * offer live tail logs, while a Worker can persist logs in Workers Logs and
 * export them through Workers Logpush. The Worker checks the Pages readiness
 * endpoint on a cron, records a structured result, and posts to the same
 * provider-neutral alert webhook used by the GitHub workflows.
 */
import { logEvent } from '../functions/monitoring.js';
import { sendAlert } from '../tools/alert-webhook.mjs';

const DEFAULT_BASE_URL = 'https://irishvisaupdatetracker.pages.dev';

function baseUrl(env) {
  return String((env && env.APP_BASE_URL) || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

async function probe(env) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(baseUrl(env) + '/api/health', {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Irish-Visa-Tracker-Monitor/1.0' },
      cf: { cacheTtl: 0 },
      signal: controller.signal
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON response */ }
    const services = (payload && payload.services) || {};
    const healthy = response.ok
      && payload
      && payload.status === 'healthy'
      && services.database === 'healthy'
      && services.storage === 'healthy';
    return {
      ok: Boolean(healthy),
      status_code: response.status,
      status: payload && payload.status ? payload.status : 'unknown',
      database: services.database || 'unknown',
      storage: services.storage || 'unknown',
      commit: payload && payload.commit ? payload.commit : undefined
    };
  } catch (error) {
    return {
      ok: false,
      status_code: 0,
      status: 'unreachable',
      error: String(error && error.message ? error.message : error).slice(0, 300)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run(env) {
  const startedAt = Date.now();
  const result = await probe(env);
  logEvent(result.ok ? 'info' : 'error', 'monitor_check', {
    ...result,
    duration_ms: Date.now() - startedAt
  });

  if (!result.ok) {
    const message = [
      'Irish Visa Tracker uptime check FAILED',
      `HTTP ${result.status_code || 'no response'} (${result.status})`,
      `database=${result.database || 'unknown'} storage=${result.storage || 'unknown'}`
    ].join(' | ');
    if (env && env.ALERT_WEBHOOK_URL) {
      try {
        await sendAlert(env.ALERT_WEBHOOK_URL, message);
      } catch (error) {
        logEvent('error', 'monitor_alert_error', {
          error: String(error && error.message ? error.message : error).slice(0, 300)
        });
      }
    } else {
      logEvent('warn', 'monitor_alert_skipped', { reason: 'ALERT_WEBHOOK_URL is not configured' });
    }
  }

  return result;
}

export default {
  async scheduled(controller, env) {
    return run(env);
  }
};
