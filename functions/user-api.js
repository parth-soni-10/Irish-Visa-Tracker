/**
 * User API Routes
 * Handles registration, login, profile, preferences and watchlists
 */

import { 
  hashPassword, 
  verifyPassword, 
  createSession, 
  validateSession, 
  deleteSession,
  hashEmail
} from './auth.js';

import { ensureSchema } from './_router.js';
import { ensurePortalSchema } from './portal-schema.js';
import { ensureEmailSchema } from './email4.js';

// Rate limiting for auth endpoints
const authRateLimitStore = new Map();
const AUTH_RATE_LIMIT_MAX = 50; // bounded attempts per client IP per window

function checkAuthRateLimit(ip, env) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  const max = Math.max(1, Number(env?.AUTH_RATE_LIMIT_MAX) || AUTH_RATE_LIMIT_MAX);
  
  if (!authRateLimitStore.has(ip)) {
    authRateLimitStore.set(ip, []);
  }
  
  const requests = authRateLimitStore.get(ip).filter(t => t > windowStart);
  authRateLimitStore.set(ip, requests);
  
  if (requests.length >= max) {
    return false;
  }
  
  requests.push(now);
  return true;
}

// Input validation
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password);
}

function sanitizeInput(input) {
  return String(input).slice(0, 1000).replace(/[<>]/g, '');
}

// Helper to extract session from cookie
function getSessionIdFromCookie(request) {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;
  
  const cookies = cookieHeader.split(';').map(c => c.trim());
  const sessionCookie = cookies.find(c => c.startsWith('session_id='));
  if (!sessionCookie) return null;
  
  const value = sessionCookie.split('=')[1];
  // Format: userId:sessionId or just sessionId
  return value.includes(':') ? value.split(':')[1] : value;
}

// Registration endpoint
export async function handleRegister(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  // Ensure database schema exists
  try {
    await ensureSchema(env.DB);
  } catch (error) {
    console.error('Schema initialization failed:', error);
    return new Response(JSON.stringify({ error: 'Database initialization failed' }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkAuthRateLimit(ip, env)) {
    return new Response(JSON.stringify({ error: 'Too many attempts, try again later' }), { 
      status: 429, 
      headers: { 'Content-Type': 'application/json', 'Retry-After': '900' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { email, password, name, referral_code } = body;
  
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Email and password required' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  if (!validateEmail(email)) {
    return new Response(JSON.stringify({ error: 'Invalid email format' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  if (!validatePassword(password)) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters with uppercase, lowercase, and number' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const sanitizedName = name ? sanitizeInput(name) : null;
  const emailHash = await hashEmail(email.toLowerCase());

  try {
    // Check if user exists
    const existing = await env.DB.prepare(
      'SELECT id FROM users WHERE email_hash = ?'
    ).bind(emailHash).first();

    if (existing) {
      return new Response(JSON.stringify({ error: 'Account already exists' }), { 
        status: 409, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO users (id, email, email_hash, password_hash, name, preferences, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `    ).bind(
      userId,
      email.toLowerCase(),
      emailHash,
      passwordHash,
      sanitizedName,
      JSON.stringify({ 
        theme: 'light', 
        language: 'en', 
        notifications: { email: true, push: true },
        timezone: 'UTC'
      }),
      new Date().toISOString(),
      new Date().toISOString()
    ).run();

    // Credit a referral only when the code belongs to another account. A bad
    // code must never prevent the new account from being created.
    if (referral_code) {
      try {
        await ensurePortalSchema(env);
        const inviter = await env.DB.prepare('SELECT user_id FROM referral_codes WHERE code = ?')
          .bind(String(referral_code).slice(0, 80)).first();
        if (inviter && inviter.user_id !== userId) {
          const code = String(referral_code).slice(0, 80);
          const invite = await env.DB.prepare(
            'SELECT id FROM referrals WHERE code = ? AND invited_email = ?'
          ).bind(code, email.toLowerCase()).first();
          let referralId;
          if (invite) {
            referralId = invite.id;
            await env.DB.prepare(`
              UPDATE referrals SET referred_user_id = ?, status = 'accepted', accepted_at = datetime('now')
              WHERE id = ?
            `).bind(userId, invite.id).run();
          } else {
            referralId = crypto.randomUUID();
            await env.DB.prepare(`
              INSERT INTO referrals (id, user_id, code, referred_user_id, status, accepted_at)
              VALUES (?, ?, ?, ?, 'accepted', datetime('now'))
            `).bind(referralId, inviter.user_id, code, userId).run();
          }
          // A successful signup with an invite code earns one tracked credit.
          // The unique referral_id makes the award idempotent on retries.
          await env.DB.prepare(`
            INSERT OR IGNORE INTO referral_rewards (id, user_id, referral_id, credits, reason)
            VALUES (?, ?, ?, 1, 'accepted_referral')
          `).bind(crypto.randomUUID(), inviter.user_id, referralId).run();
        }
      } catch (referralError) {
        console.warn('Referral credit skipped:', referralError.message);
      }
    }

    // Create initial session
    const sessionId = await createSession(env, userId);
    
    // Set secure cookie
    const cookie = `session_id=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`; // 30 days

    return new Response(JSON.stringify({ 
      success: true, 
      user: { 
        id: userId, 
        email, 
        name: sanitizedName,
        preferences: { theme: 'light', language: 'en', notifications: { email: true, push: true } }
      }
    }), { 
      status: 201, 
      headers: { 
        'Content-Type': 'application/json',
        'Set-Cookie': cookie
      } 
    });
  } catch (error) {
    console.error('Registration error:', error);
    return new Response(JSON.stringify({ error: 'Registration failed' }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

// Login endpoint
export async function handleLogin(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!checkAuthRateLimit(ip, env)) {
    return new Response(JSON.stringify({ error: 'Too many attempts, try again later' }), { 
      status: 429, 
      headers: { 'Content-Type': 'application/json', 'Retry-After': '900' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { email, password, remember } = body;
  
  if (!email || !password) {
    return new Response(JSON.stringify({ error: 'Email and password required' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const emailHash = await hashEmail(email.toLowerCase());

  try {
    const user = await env.DB.prepare(`
      SELECT id, email, name, password_hash, preferences, created_at
      FROM users WHERE email_hash = ?
    `).bind(emailHash).first();

    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), { 
        status: 401, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    const sessionId = await createSession(env, user.id);
    const maxAge = remember ? 31536000 : 2592000; // 1 year or 30 days
    const cookie = `session_id=${user.id}:${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

    return new Response(JSON.stringify({ 
      success: true, 
      user: { 
        id: user.id, 
        email: user.email, 
        name: user.name,
        preferences: JSON.parse(user.preferences || '{}')
      }
    }), { 
      status: 200, 
      headers: { 
        'Content-Type': 'application/json',
        'Set-Cookie': cookie
      } 
    });
  } catch (error) {
    console.error('Login error:', error);
    return new Response(JSON.stringify({ error: 'Login failed' }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

// Logout endpoint
export async function handleLogout(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  if (sessionId) {
    await deleteSession(env, sessionId);
  }

  const cookie = 'session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
  return new Response(JSON.stringify({ success: true }), { 
    status: 200, 
    headers: { 
      'Content-Type': 'application/json',
      'Set-Cookie': cookie
    } 
  });
}

// Get current user
export async function handleMe(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  if (!sessionId) {
    return new Response(JSON.stringify({ authenticated: false }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ authenticated: false }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  return new Response(JSON.stringify({ 
    authenticated: true, 
    user: { 
      id: session.id, 
      email: session.email, 
      name: session.name,
      preferences: JSON.parse(session.preferences || '{}'),
      createdAt: session.created_at
    }
  }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

// Update profile
export async function handleUpdateProfile(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { name, preferences } = body;
  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(sanitizeInput(name));
  }

  if (preferences !== undefined) {
    try {
      const merged = { ...JSON.parse(session.preferences || '{}'), ...preferences };
      updates.push('preferences = ?');
      params.push(JSON.stringify(merged));
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid preferences' }), { 
        status: 400, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }
  }

  if (updates.length === 0) {
    return new Response(JSON.stringify({ error: 'No valid fields to update' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  params.push(new Date().toISOString(), session.id);
  await env.DB.prepare(`UPDATE users SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`).bind(...params).run();

  return new Response(JSON.stringify({ success: true }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

// Change password
export async function handleChangePassword(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const { currentPassword, newPassword } = body;
  
  if (!currentPassword || !newPassword) {
    return new Response(JSON.stringify({ error: 'Current and new password required' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  if (!validatePassword(newPassword)) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters with uppercase, lowercase, and number' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const user = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(session.id).first();
  const valid = await verifyPassword(currentPassword, user.password_hash);
  
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Current password incorrect' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .bind(newHash, new Date().toISOString(), session.id).run();

  // Invalidate all other sessions
  await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = ? AND session_id != ?')
    .bind(session.id, getSessionIdFromCookie(request)).run();

  return new Response(JSON.stringify({ success: true }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

// Delete account
export async function handleDeleteAccount(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(session.id).run();
  await deleteSession(env, getSessionIdFromCookie(request));

  const cookie = 'session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
  return new Response(JSON.stringify({ success: true }), { 
    status: 200, 
    headers: { 
      'Content-Type': 'application/json',
      'Set-Cookie': cookie
    } 
  });
}

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
    SELECT id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, notify_sms, created_at
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

  const { application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, notify_sms } = body;
  if (!application_number || !embassy_slug) {
    return new Response(JSON.stringify({ error: 'application_number and embassy_slug required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO watchlists (user_id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, notify_sms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(
      session.id,
      application_number,
      embassy_slug,
      nickname || null,
      notify_email !== false ? 1 : 0,
      notify_push !== false ? 1 : 0,
      notify_whatsapp === true ? 1 : 0,
      notify_sms === true ? 1 : 0
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
  if (body.notify_whatsapp !== undefined) {
    updates.push('notify_whatsapp = ?');
    params.push(body.notify_whatsapp ? 1 : 0);
  }
  if (body.notify_sms !== undefined) {
    updates.push('notify_sms = ?');
    params.push(body.notify_sms ? 1 : 0);
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
  const notifySms = body.notify_sms === true;
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
        'INSERT OR IGNORE INTO watchlists (user_id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, notify_sms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(session.id, applicationNumber, embassy, nickname, notifyEmail ? 1 : 0, notifyPush ? 1 : 0, 0, notifySms ? 1 : 0).run();
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

// GDPR-style export of the signed-in user's account data.
export async function handleExportAccountData(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const safeAll = async (sql) => {
    try { const result = await env.DB.prepare(sql).bind(session.id).all(); return result.results || []; }
    catch (error) { return []; }
  };

  let profile = null;
  try {
    profile = await env.DB.prepare(
      'SELECT id, email, name, preferences, created_at, updated_at, last_login_at FROM users WHERE id = ?'
    ).bind(session.id).first();
  } catch (error) { profile = null; }

  const payload = {
    exported_at: new Date().toISOString(),
    service: 'Irish Visa Decision Tracker',
    account: profile || {
      id: session.id, email: session.email, name: session.name || null,
      preferences: session.preferences || '{}', created_at: session.created_at || null
    },
    watchlist: await safeAll('SELECT id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, notify_sms, created_at FROM watchlists WHERE user_id = ? ORDER BY created_at DESC'),
    email_alerts: await safeAll('SELECT application_number, embassy, verified, unsubscribed, created_at, last_alert_sent FROM email_subscriptions WHERE user_id = ? ORDER BY created_at DESC')
  };

  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="irish-visa-tracker-export.json"',
      'Cache-Control': 'no-store'
    }
  });
}

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

// Alerts handler (placeholder for email/push alerts)
export async function handleGetAlerts(request, env) {
  const sessionId = getSessionIdFromCookie(request);
  const session = await validateSession(env, sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
      status: 401, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const results = await env.DB.prepare(`
    SELECT * FROM email_subscriptions WHERE user_id = ? AND unsubscribed = 0
  `).bind(session.id).all();

  return new Response(JSON.stringify({ 
    success: true, 
    alerts: results.results || [] 
  }), { headers: { 'Content-Type': 'application/json' } });
}

function tokenResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}