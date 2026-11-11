/**
 * In-app notification inbox.
 *
 * Email and Web Push remain the delivery channels. This module only stores the
 * durable inbox copy so a signed-in user can see an alert even if a browser
 * notification was missed or a mail provider was temporarily unavailable.
 */

import { validateSession } from './auth.js';

function sessionIdFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.split(';').map((part) => part.trim())
    .find((part) => part.startsWith('session_id='));
  if (!match) return null;
  const value = match.slice('session_id='.length);
  return value.includes(':') ? value.split(':')[1] : value;
}

async function currentUser(request, env) {
  return validateSession(env, sessionIdFromCookie(request));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function createNotification(env, { userId, type = 'decision', title, body = '', url = '' }) {
  if (!env || !env.DB || !userId || !title) return false;
  try {
    await env.DB.prepare(`
      INSERT INTO user_notifications (id, user_id, type, title, body, url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(crypto.randomUUID(), userId, type, String(title).slice(0, 300), String(body).slice(0, 2000), String(url).slice(0, 1000)).run();
    return true;
  } catch (error) {
    // Notification persistence must never make the alert delivery fail.
    console.warn('In-app notification store failed:', error.message);
    return false;
  }
}

export async function handleListNotifications(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
  try {
    const [rows, unread] = await Promise.all([
      env.DB.prepare(`
        SELECT id, type, title, body, url, read_at, created_at
        FROM user_notifications WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).bind(user.id, limit).all(),
      env.DB.prepare('SELECT COUNT(*) AS count FROM user_notifications WHERE user_id = ? AND read_at IS NULL')
        .bind(user.id).first()
    ]);
    return json({
      success: true,
      unread: unread?.count || 0,
      notifications: rows.results || []
    });
  } catch (error) {
    console.error('Notification list failed:', error);
    return json({ error: 'Could not load notifications' }, 500);
  }
}

export async function handleMarkNotificationsRead(request, env) {
  const user = await currentUser(request, env);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  let body = {};
  try { body = await request.json(); } catch {}
  try {
    if (body.id) {
      await env.DB.prepare(`
        UPDATE user_notifications SET read_at = datetime('now')
        WHERE id = ? AND user_id = ? AND read_at IS NULL
      `).bind(body.id, user.id).run();
    } else {
      await env.DB.prepare(`
        UPDATE user_notifications SET read_at = datetime('now')
        WHERE user_id = ? AND read_at IS NULL
      `).bind(user.id).run();
    }
    return json({ success: true });
  } catch (error) {
    console.error('Notification read update failed:', error);
    return json({ error: 'Could not update notifications' }, 500);
  }
}
