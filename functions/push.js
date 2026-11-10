/**
 * Web Push Notifications for Decision Alerts
 * Uses VAPID keys for authentication with push services
 */

import * as webPush from 'web-push';

// VAPID keys should be generated once and stored in Cloudflare secrets
// Generate with: npx web-push generate-vapid-keys
// Store in Cloudflare Pages secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT

let vapidConfigured = false;

export function configureVapid(env) {
  if (vapidConfigured) return;
  
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT || 'mailto:soni.soni.parth@gmail.com';
  
  if (!publicKey || !privateKey) {
    console.warn('[WebPush] VAPID keys not configured, push notifications disabled');
    return false;
  }
  
  webPush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
  return true;
}

/**
 * Subscribe a user to push notifications
 */
export async function subscribeToPush(env, subscription, email, applicationNumber, embassy) {
  if (!configureVapid(env)) {
    return { success: false, error: 'Push notifications not configured' };
  }
  
  try {
    // Store subscription in D1
    await env.DB.prepare(`
      INSERT OR REPLACE INTO push_subscriptions 
      (endpoint, p256dh, auth, email, application_number, embassy, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      subscription.endpoint,
      subscription.keys.p256dh,
      subscription.keys.auth,
      email,
      applicationNumber,
      embassy
    ).run();
    
    return { success: true };
  } catch (error) {
    console.error('[WebPush] Subscription failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send push notification for a decision
 */
export async function sendDecisionPush(env, applicationNumber, decision, embassy) {
  if (!configureVapid(env)) return;
  
  try {
    // Get all subscriptions for this application number
    const { results } = await env.DB.prepare(`
      SELECT endpoint, p256dh, auth 
      FROM push_subscriptions 
      WHERE application_number = ? AND embassy = ?
    `).bind(applicationNumber, embassy).all();
    
    if (!results || results.length === 0) return;
    
    const payload = JSON.stringify({
      title: `Visa Decision: ${decision}`,
      body: `Application ${applicationNumber} (${embassy}) was ${decision.toLowerCase()}.`,
      icon: '/icon-192.png',
      badge: '/icon-72.png',
      data: {
        applicationNumber,
        decision,
        embassy,
        url: `/?tab=home&q=${applicationNumber}`
      },
      actions: [
        { action: 'view', title: 'View Details' },
        { action: 'dismiss', title: 'Dismiss' }
      ],
      requireInteraction: true
    });
    
    // Send to all subscriptions in parallel
    const sendPromises = results.map(sub => 
      webPush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      ).catch(err => {
        // If subscription is invalid (410 Gone), remove it
        if (err.statusCode === 410) {
          env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
            .bind(sub.endpoint).run();
        }
        console.warn('[WebPush] Send failed:', err.message);
      })
    );
    
    await Promise.all(sendPromises);
    console.log(`[WebPush] Sent ${results.length} notifications for ${applicationNumber}`);
  } catch (error) {
    console.error('[WebPush] Send error:', error);
  }
}

/**
 * Unsubscribe from push notifications
 */
export async function unsubscribeFromPush(env, endpoint) {
  try {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
      .bind(endpoint).run();
    return { success: true };
  } catch (error) {
    console.error('[WebPush] Unsubscribe failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle push subscription from the client
 */
export async function handlePushSubscribe(request, env) {
  try {
    const { subscription, email, application_number, embassy } = await request.json();
    
    if (!subscription || !email || !application_number || !embassy) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const result = await subscribeToPush(env, subscription, email, application_number, embassy);
    
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle push unsubscribe
 */
export async function handlePushUnsubscribe(request, env) {
  try {
    const url = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint');
    
    if (!endpoint) {
      return new Response(JSON.stringify({ error: 'Missing endpoint' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const result = await unsubscribeFromPush(env, endpoint);
    
    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Send push notification for decision (called from email check)
 */
export async function notifyDecisionPush(env, applicationNumber, decision, embassy) {
  await sendDecisionPush(env, applicationNumber, decision, embassy);
}

export { webPush };