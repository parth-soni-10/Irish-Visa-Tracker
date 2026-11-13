/**
 * Authenticated browser-push subscription routes.
 *
 * These share the session-cookie helpers with the rest of the user API but do
 * not need any of its account or watchlist code.
 */
import { validateSession } from './auth.js';
import { getSessionIdFromCookie, tokenResponse } from './user-http.js';

// Push subscription handlers
export async function handlePushSubscribe(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, headers: { 'Content-Type': 'application/json' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { endpoint, p256dh, auth, application_number, embassy_slug } = body;
  if (!endpoint || !p256dh || !auth || !application_number || !embassy_slug) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO push_subscriptions (user_id, endpoint, p256dh, auth, application_number, embassy_slug)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(session.id, endpoint, p256dh, auth, application_number, embassy_slug).run();

    return new Response(JSON.stringify({ success: true }), { 
      status: 201, headers: { 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    console.error('Push subscribe error:', error);
    return new Response(JSON.stringify({ error: 'Failed to subscribe' }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}

export async function handlePushUnsubscribe(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const url = new URL(request.url);
  const endpoint = url.searchParams.get('endpoint');

  if (!endpoint) {
    return new Response(JSON.stringify({ error: 'endpoint required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  await env.DB.prepare(`
    DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?
  `).bind(session.id, endpoint).run();

  return new Response(JSON.stringify({ success: true }), { 
    headers: { 'Content-Type': 'application/json' } 
  });
}

export async function handlePushKey(request, env) {
  return new Response(JSON.stringify({
    success: true,
    publicKey: env.VAPID_PUBLIC_KEY || ''
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }
  });
}

export async function handlePushTest(request, env) {
  const session = await validateSession(env, getSessionIdFromCookie(request));
  if (!session) return tokenResponse({ error: 'Unauthorized' }, 401);
  const { sendPushToUser } = await import('./push.js');
  const result = await sendPushToUser(env, session.id, {
    title: 'Irish Visa Tracker test',
    body: 'Push notifications are connected for this account.',
    url: '/?tab=watchlist'
  });
  if (result.disabled) return tokenResponse({ error: 'Push notifications are not configured', ...result }, 503);
  if (!result.sent) return tokenResponse({ error: 'No active push subscription. Enable browser notifications on a watched application first.', ...result }, 409);
  return tokenResponse({ success: true, ...result });
}
