/**
 * Watchlist CRUD and the email-alert mirror.
 *
 * Kept apart from account/auth routes so the watchlist can be tested and
 * changed without loading registration, session and profile code.
 */
import { hashEmail, validateSession } from './auth.js';
import { ensureEmailSchema } from './email4.js';
import { getSessionIdFromCookie, sanitizeInput } from './user-http.js';

// Mirror a watchlist entry into the email-subscription table so the alert
// pipeline can find it by address even if the user later signs out.
async function upsertEmailAlert(env, session, applicationNumber, embassySlug) {
  if (!session || !session.email) return;
  try {
    await ensureEmailSchema(env);
    const emailHash = await hashEmail(session.email.toLowerCase());
    const unsubscribeToken = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare(`
      INSERT OR REPLACE INTO email_subscriptions
        (user_id, email_hash, email, application_number, embassy, verified, unsubscribed, unsubscribe_token)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?)
    `).bind(session.id, emailHash, session.email, applicationNumber, embassySlug, unsubscribeToken).run();
  } catch (error) {
    console.warn('Email alert mirror failed:', error.message);
  }
}

async function disableEmailAlert(env, session, applicationNumber, embassySlug) {
  if (!session || !session.email) return;
  try {
    const emailHash = await hashEmail(session.email.toLowerCase());
    await env.DB.prepare(`
      UPDATE email_subscriptions SET unsubscribed = 1
      WHERE email_hash = ? AND application_number = ? AND embassy = ?
    `).bind(emailHash, applicationNumber, embassySlug).run();
  } catch (error) {
    console.warn('Email alert disable failed:', error.message);
  }
}

// Watchlist handlers
export async function handleGetWatchlist(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const results = await env.DB.prepare(`
    SELECT id, application_number, embassy_slug, nickname, notify_email, notify_push, created_at
    FROM watchlists WHERE user_id = ?
    ORDER BY created_at DESC
  `).bind(session.id).all();

  return new Response(JSON.stringify({ 
    success: true, 
    watchlist: results.results || [] 
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleAddToWatchlist(request, env) {
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

  const { application_number, embassy_slug, nickname, notify_email, notify_push } = body;
  if (!application_number || !embassy_slug) {
    return new Response(JSON.stringify({ error: 'application_number and embassy_slug required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO watchlists (user_id, application_number, embassy_slug, nickname, notify_email, notify_push)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(
      session.id,
      application_number,
      embassy_slug,
      nickname || null,
      notify_email !== false ? 1 : 0,
      notify_push !== false ? 1 : 0
    ).first();

    if (notify_email !== false) {
      await upsertEmailAlert(env, session, application_number, embassy_slug);
    }

    return new Response(JSON.stringify({ success: true, id: inserted && inserted.id }), {
      status: 201, headers: { 'Content-Type': 'application/json' } 
    });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return new Response(JSON.stringify({ error: 'Already in watchlist' }), { 
        status: 409, headers: { 'Content-Type': 'application/json' } 
      });
    }
    console.error('Watchlist add error:', error);
    return new Response(JSON.stringify({ error: 'Failed to add to watchlist' }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}

export async function handleRemoveFromWatchlist(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];

  const result = await env.DB.prepare(`
    DELETE FROM watchlists WHERE id = ? AND user_id = ?
  `).bind(id, session.id).run();

  if (result.changes === 0) {
    return new Response(JSON.stringify({ error: 'Not found' }), { 
      status: 404, headers: { 'Content-Type': 'application/json' } 
    });
  }

  return new Response(JSON.stringify({ success: true }), { 
    headers: { 'Content-Type': 'application/json' } 
  });
}

export async function handleUpdateWatchlist(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const url = new URL(request.url);
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 1];

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const existing = await env.DB.prepare(
    'SELECT * FROM watchlists WHERE id = ? AND user_id = ?'
  ).bind(id, session.id).first();

  if (!existing) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' }
    });
  }

  const updates = [];
  const params = [];
  if (body.nickname !== undefined) {
    updates.push('nickname = ?');
    params.push(body.nickname ? sanitizeInput(body.nickname) : null);
  }
  if (body.notify_email !== undefined) {
    updates.push('notify_email = ?');
    params.push(body.notify_email ? 1 : 0);
  }
  if (body.notify_push !== undefined) {
    updates.push('notify_push = ?');
    params.push(body.notify_push ? 1 : 0);
  }
  if (!updates.length) {
    return new Response(JSON.stringify({ error: 'No supported fields' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  params.push(id, session.id);
  await env.DB.prepare(
    'UPDATE watchlists SET ' + updates.join(', ') + ' WHERE id = ? AND user_id = ?'
  ).bind(...params).run();

  if (body.notify_email !== undefined) {
    if (body.notify_email) {
      await upsertEmailAlert(env, session, existing.application_number, existing.embassy_slug);
    } else {
      await disableEmailAlert(env, session, existing.application_number, existing.embassy_slug);
    }
  }

  const updated = await env.DB.prepare(
    'SELECT * FROM watchlists WHERE id = ? AND user_id = ?'
  ).bind(id, session.id).first();

  return new Response(JSON.stringify({ success: true, watchlist: updated }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

// Bulk watchlist add for agencies, families and employers.
export async function handleBulkAddToWatchlist(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const applications = Array.isArray(body.applications) ? body.applications : [];
  if (!applications.length) {
    return new Response(JSON.stringify({ error: 'applications array required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (applications.length > 50) {
    return new Response(JSON.stringify({ error: 'Maximum 50 applications per request' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const offices = new Set(['new-delhi', 'beijing', 'dublin', 'abu-dhabi', 'abuja', 'ankara']);
  const notifyEmail = body.notify_email !== false;
  const notifyPush = body.notify_push !== false;
  let added = 0, skipped = 0;
  const rejected = [];

  for (const entry of applications) {
    const applicationNumber = String(entry && (entry.application_number || entry.number) || '').trim().toUpperCase();
    const embassy = offices.has(entry && entry.embassy_slug) ? entry.embassy_slug : 'new-delhi';
    if (!/^[A-Z0-9-]{6,20}$/.test(applicationNumber)) {
      rejected.push({ application_number: applicationNumber || null, reason: 'invalid application number' });
      continue;
    }
    const nickname = entry && entry.nickname ? sanitizeInput(entry.nickname) : null;
    try {
      const result = await env.DB.prepare(
        'INSERT OR IGNORE INTO watchlists (user_id, application_number, embassy_slug, nickname, notify_email, notify_push) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(session.id, applicationNumber, embassy, nickname, notifyEmail ? 1 : 0, notifyPush ? 1 : 0).run();
      const changed = (result.meta && result.meta.changes) || result.changes || 0;
      if (changed) {
        added++;
        if (notifyEmail) await upsertEmailAlert(env, session, applicationNumber, embassy);
      } else {
        skipped++;
      }
    } catch (error) {
      rejected.push({ application_number: applicationNumber, reason: 'database error' });
    }
  }

  return new Response(JSON.stringify({ success: true, added, skipped, rejected }), {
    status: 201, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}
