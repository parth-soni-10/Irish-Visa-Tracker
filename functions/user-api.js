/**
 * User API Routes
 * Handles registration, login, profile, preferences and account export.
 * Watchlist and browser-push routes are re-exported from their own modules.
 */

import { 
  hashPassword, 
  verifyPassword, 
  createSession, 
  validateSession, 
  deleteSession,
  hashEmail
} from './auth.js';
import { getSessionIdFromCookie, sanitizeInput } from './user-http.js';

import { ensureSchema } from './db-schema.js';
import { ensurePortalSchema } from './portal-schema.js';
import { ensureEmailSchema } from './email4.js';
import { checkRateLimit } from './rate-limit.js';


// Re-exported so the router keeps one import surface for user routes.
export {
  handleGetWatchlist,
  handleAddToWatchlist,
  handleRemoveFromWatchlist,
  handleUpdateWatchlist,
  handleBulkAddToWatchlist
} from './user-watchlist.js';
export {
  handlePushSubscribe,
  handlePushUnsubscribe,
  handlePushKey,
  handlePushTest
} from './user-push.js';

const AUTH_RATE_LIMIT_MAX = 50; // bounded attempts per client IP per window

async function checkAuthRateLimit(ip, env) {
  const decision = await checkRateLimit(env, {
    bucket: 'auth',
    subject: ip,
    limit: Math.max(1, Number(env?.AUTH_RATE_LIMIT_MAX) || AUTH_RATE_LIMIT_MAX),
    windowSeconds: 15 * 60
  });
  return decision.allowed;
}

// Input validation
function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password);
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
  if (!(await checkAuthRateLimit(ip, env))) {
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
  if (!(await checkAuthRateLimit(ip, env))) {
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
    watchlist: await safeAll('SELECT id, application_number, embassy_slug, nickname, notify_email, notify_push, created_at FROM watchlists WHERE user_id = ? ORDER BY created_at DESC'),
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
