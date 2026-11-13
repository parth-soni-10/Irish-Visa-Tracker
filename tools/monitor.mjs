/**
 * External uptime and data-freshness check.
 *
 * Runs from GitHub Actions (outside Cloudflare), so it still detects a broken
 * Pages deployment when the Worker monitor itself cannot run. It is deliberately
 * dependency-free and read-only: GET /api/health plus the public data manifest.
 *
 *   node tools/monitor.mjs
 *   MONITOR_BASE_URL=http://127.0.0.1:8788 node tools/monitor.mjs
 *
 * A failure sends ALERT_WEBHOOK_URL when configured and exits 1. Without a
 * webhook the failed workflow itself is the alert (GitHub notifies the
 * workflow's owner).
 */
import process from 'node:process';

import { sendAlert } from './alert-webhook.mjs';

const BASE_URL = String(process.env.MONITOR_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
const configuredMaxAge = Number(process.env.MAX_DATA_AGE_HOURS);
const MAX_DATA_AGE_HOURS = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 72;
const failures = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(path, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(BASE_URL + path, {
        headers: { Accept: 'application/json', 'User-Agent': 'Irish-Visa-Tracker-Uptime/1.0' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15000)
      });
      return { response, text: await response.text() };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(2000);
    }
  }
  throw lastError || new Error('request failed');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function checkHealth() {
  try {
    const { response, text } = await get('/api/health');
    const health = parseJson(text);
    const services = health && health.services ? health.services : {};
    const healthy = response.status === 200
      && health
      && health.status === 'healthy'
      && services.database === 'healthy'
      && services.storage === 'healthy';
    if (!healthy) {
      failures.push(`health: HTTP ${response.status}, status=${health && health.status ? health.status : 'unknown'}, database=${services.database || 'unknown'}, storage=${services.storage || 'unknown'}`);
      return null;
    }
    console.log(`PASS health (HTTP ${response.status}, commit ${health.commit || 'unknown'})`);
    return health;
  } catch (error) {
    failures.push(`health: ${String(error.message || error).slice(0, 300)}`);
    return null;
  }
}

async function checkFreshness() {
  try {
    const { response, text } = await get('/data/data_manifest.json');
    const manifest = parseJson(text);
    const generatedAt = manifest && Date.parse(manifest.generated_at);
    if (response.status !== 200 || !manifest || !Number.isFinite(generatedAt)) {
      failures.push(`data manifest: HTTP ${response.status}, missing generated_at`);
      return;
    }
    const ageHours = (Date.now() - generatedAt) / 3600000;
    if (ageHours > MAX_DATA_AGE_HOURS) {
      failures.push(`data: last generated ${Math.round(ageHours)}h ago (limit ${MAX_DATA_AGE_HOURS}h)`);
      return;
    }
    console.log(`PASS data manifest (generated ${Math.round(ageHours)}h ago)`);
  } catch (error) {
    failures.push(`data manifest: ${String(error.message || error).slice(0, 300)}`);
  }
}

await checkHealth();
await checkFreshness();

if (failures.length) {
  const message = [
    'Irish Visa Tracker external monitor FAILED',
    `Origin: ${BASE_URL}`,
    ...failures.map((failure) => `- ${failure}`)
  ].join('\n');
  console.error(message);
  if (process.env.ALERT_WEBHOOK_URL) {
    try {
      await sendAlert(process.env.ALERT_WEBHOOK_URL, message);
    } catch (error) {
      console.error(`Alert webhook failed: ${String(error.message || error).slice(0, 300)}`);
    }
  } else {
    console.error('ALERT_WEBHOOK_URL is not configured; relying on the failed workflow notification.');
  }
  process.exitCode = 1;
} else {
  console.log('External monitor passed.');
}
