/**
 * Web Push Notifications for Decision Alerts
 * Uses VAPID keys for authentication with push services.
 */

import * as webPush from 'web-push';

let vapidConfigured = false;

export function isPushConfigured(env) {
  return Boolean(env && env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function configureVapid(env) {
  if (vapidConfigured) return true;
  if (!isPushConfigured(env)) {
    console.warn('[WebPush] VAPID keys not configured, push notifications disabled');
    return false;
  }
  webPush.setVapidDetails(
    env.VAPID_SUBJECT || 'mailto:soni.soni.parth@gmail.com',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );
  vapidConfigured = true;
  return true;
}

export async function ensurePushSchema(env) {
  if (!env || !env.DB) return false;
  try {
    try {
      await env.DB.prepare('SELECT last_alert_sent FROM push_subscriptions LIMIT 1').first();
    } catch {
      await env.DB.prepare('ALTER TABLE push_subscriptions ADD COLUMN last_alert_sent TEXT')
        .run().catch(() => {});
    }

    const oldIndex = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_push_endpoint_app'"
    ).first();
    const newIndex = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_push_endpoint_app_office'"
    ).first();
    const missingOffice = await env.DB.prepare(
      "SELECT id FROM push_subscriptions WHERE embassy_slug IS NULL OR TRIM(embassy_slug) = '' LIMIT 1"
    ).first();

    if (oldIndex || !newIndex || missingOffice) {
      // Older rows stored the office in `embassy`; fall back to New Delhi when
      // neither office column was populated. Normalise before rebuilding the
      // unique index so the migration cannot create duplicate identities.
      await env.DB.prepare(`
        UPDATE push_subscriptions
        SET embassy_slug = COALESCE(
          NULLIF(TRIM(embassy_slug), ''),
          NULLIF(TRIM(embassy), ''),
          'new-delhi'
        )
        WHERE embassy_slug IS NULL OR TRIM(embassy_slug) = ''
      `).run();
      await env.DB.prepare(`
        UPDATE push_subscriptions
        SET embassy = COALESCE(NULLIF(TRIM(embassy), ''), embassy_slug, 'new-delhi')
        WHERE embassy IS NULL OR TRIM(embassy) = ''
      `).run();
    }

    // Build the replacement before dropping the old index so a failed
    // migration leaves the previous uniqueness guarantee in place.
    if (!newIndex) {
      await env.DB.prepare(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint_app_office
        ON push_subscriptions(endpoint, application_number, embassy_slug)
      `).run();
    }
    if (oldIndex) {
      await env.DB.prepare('DROP INDEX IF EXISTS idx_push_endpoint_app').run();
    }
    return true;
  } catch (error) {
    console.error('[WebPush] Schema migration failed:', error);
    return false;
  }
}

function payloadFor({ applicationNumber, decision, embassy, url }) {
  return JSON.stringify({
    title: decision ? 'Visa decision: ' + decision : 'Irish Visa Tracker',
    body: decision
      ? 'Application ' + applicationNumber + ' (' + embassy + ') was ' + String(decision).toLowerCase() + '.'
      : 'A watched application has an update.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { applicationNumber: applicationNumber || null, decision: decision || null, embassy: embassy || null, url: url || '/' },
    actions: [{ action: 'view', title: 'View details' }],
    requireInteraction: Boolean(decision)
  });
}

async function sendOne(env, subscription, payload) {
  try {
    // web-push's sendNotification() uses Node's https.request, which is not
    // available in Cloudflare Pages Functions. Generate the encrypted request
    // and VAPID headers with web-push, then let Workers' fetch make the call.
    const request = webPush.generateRequestDetails({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth }
    }, payload);
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name, String(value)])
    );
    delete headers['Content-Length'];
    const response = await fetch(request.endpoint, {
      method: request.method,
      headers,
      body: request.body ? new Uint8Array(request.body) : undefined
    });
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
          .bind(subscription.endpoint).run().catch(() => {});
      }
      const detail = await response.text().catch(() => '');
      console.warn('[WebPush] Send failed: HTTP ' + response.status + (detail ? ' ' + detail.slice(0, 200) : ''));
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[WebPush] Send failed:', error.message);
    return false;
  }
}

export async function subscribeToPush(env, subscription, applicationNumber, embassy) {
  if (!configureVapid(env)) return { success: false, error: 'Push notifications not configured' };
  try {
    if (!(await ensurePushSchema(env))) {
      return { success: false, error: 'Push schema unavailable' };
    }
    await env.DB.prepare(`
      INSERT OR REPLACE INTO push_subscriptions
      (endpoint, p256dh, auth, application_number, embassy, embassy_slug, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      applicationNumber,
      embassy,
      embassy
    ).run();
    return { success: true };
  } catch (error) {
    console.error('[WebPush] Subscription failed:', error);
    return { success: false, error: error.message };
  }
}

export async function sendDecisionPush(env, applicationNumber, decision, embassy) {
  if (!configureVapid(env)) return { sent: 0, failed: 0, disabled: true };
  try {
    if (!(await ensurePushSchema(env))) {
      return { sent: 0, failed: 0, error: 'Push schema unavailable' };
    }
    const { results } = await env.DB.prepare(`
      SELECT endpoint, p256dh, auth
      FROM push_subscriptions
      WHERE application_number = ? AND (embassy_slug = ? OR embassy = ?)
    `).bind(applicationNumber, embassy, embassy).all();
    const subscriptions = results || [];
    if (!subscriptions.length) return { sent: 0, failed: 0, disabled: false };
    const payload = payloadFor({ applicationNumber, decision, embassy });
    const outcomes = await Promise.all(subscriptions.map((sub) => sendOne(env, sub, payload)));
    const sent = outcomes.filter(Boolean).length;
    return { sent, failed: outcomes.length - sent, disabled: false };
  } catch (error) {
    console.error('[WebPush] Send error:', error);
    return { sent: 0, failed: 0, error: error.message };
  }
}

export async function unsubscribeFromPush(env, endpoint, applicationNumber, embassy) {
  try {
    let sql = 'DELETE FROM push_subscriptions WHERE endpoint = ?';
    const values = [endpoint];
    if (applicationNumber && embassy) {
      sql += ' AND application_number = ? AND (embassy_slug = ? OR embassy = ?)';
      values.push(applicationNumber, embassy, embassy);
    }
    await env.DB.prepare(sql).bind(...values).run();
    return { success: true };
  } catch (error) {
    console.error('[WebPush] Unsubscribe failed:', error);
    return { success: false, error: error.message };
  }
}

export async function handlePushSubscribe(request, env) {
  try {
    const { subscription, application_number, embassy } = await request.json();
    if (!subscription || !subscription.endpoint || !subscription.keys || !application_number || !embassy) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    const result = await subscribeToPush(env, subscription, application_number, embassy);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export async function handlePushUnsubscribe(request, env) {
  try {
    const params = new URL(request.url).searchParams;
    const endpoint = params.get('endpoint');
    const applicationNumber = params.get('application_number');
    const embassy = params.get('embassy');
    if (!endpoint) {
      return new Response(JSON.stringify({ error: 'Missing endpoint' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    if ((applicationNumber && !embassy) || (!applicationNumber && embassy)) {
      return new Response(JSON.stringify({ error: 'Missing application_number or embassy' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    const result = await unsubscribeFromPush(env, endpoint, applicationNumber, embassy);
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export { webPush };
