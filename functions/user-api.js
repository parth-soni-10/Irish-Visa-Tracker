/**
 * User API Routes
 * Handles registration, login, profile, preferences, watchlists, API tokens
 */

import { 
  hashPassword, 
  verifyPassword, 
  createSession, 
  validateSession, 
  deleteSession,
  createAPIToken,
  createVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  hashEmail
} from './auth.js';

import { ensureSchema } from './_router.js';

// Rate limiting for auth endpoints
const authRateLimitStore = new Map();
const AUTH_RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const AUTH_RATE_LIMIT_MAX = 10; // 10 attempts per window

function checkAuthRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 15 * 60 * 1000;
  
  if (!authRateLimitStore.has(ip)) {
    authRateLimitStore.set(ip, []);
  }
  
  const requests = authRateLimitStore.get(ip).filter(t => t > windowStart);
  authRateLimitStore.set(ip, requests);
  
  if (requests.length >= 10) {
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
  if (!checkAuthRateLimit(ip)) {
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

  const { email, password, name } = body;
  
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
    const now = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO users (id, email, email_hash, password_hash, name, preferences, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
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
  if (!checkAuthRateLimit(ip)) {
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
    .bind(await hashPassword(newPassword), new Date().toISOString(), session.id).run();

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

// Email verification
export async function handleVerifyEmail(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return new Response(JSON.stringify({ error: 'Missing token' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  const result = await verifyEmailToken(env, token);
  if (!result) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { 
      status: 400, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }

  // Mark email as verified in email_subscriptions
  await env.DB.prepare(`
    UPDATE email_subscriptions SET verified = 1, verification_token = NULL 
    WHERE email = ?
  `).bind(result.email).run();

  // If this was a registration verification, mark user as verified
  await env.DB.prepare(`
    UPDATE users SET preferences = json_set(preferences, '$.email_verified', 1) 
    WHERE email = ?
  `).bind(result.email).run();

  return new Response(JSON.stringify({ success: true, message: 'Email verified successfully' }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

// Password reset request
export async function handlePasswordResetRequest(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, headers: { 'Content-Type': 'application/json' } 
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

  const { email } = body;
  if (!email || !validateEmail(email)) {
    return new Response(JSON.stringify({ error: 'Valid email required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const token = await createPasswordResetToken(env, email.toLowerCase());
  
  // In production, send email with reset link
  // For now, return token in response (remove in production)
  return new Response(JSON.stringify({ 
    success: true, 
    message: 'Password reset email sent',
    // Remove in production:
    reset_token: token,
    reset_url: `${new URL(request.url).origin}/reset-password?token=${token}`
  }), { 
    status: 200, 
    headers: { 'Content-Type': 'application/json' } 
  });
}

// Password reset confirmation
export async function handlePasswordResetConfirm(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
      status: 405, headers: { 'Content-Type': 'application/json' } 
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

  const { token, password } = body;
  
  if (!token || !password) {
    return new Response(JSON.stringify({ error: 'Token and new password required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  if (!validatePassword(password)) {
    return new Response(JSON.stringify({ error: 'Password must be at least 8 characters with uppercase, lowercase, and number' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const result = await verifyPasswordResetToken(env, token);
  if (!result) {
    return new Response(JSON.stringify({ error: 'Invalid or expired token' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  const newHash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?')
    .bind(await hashPassword(password), new Date().toISOString(), result.email).run();

  // Invalidate all sessions
  await env.DB.prepare('DELETE FROM user_sessions WHERE user_id = (SELECT id FROM users WHERE email = ?)')
    .bind(result.email).run();

  return new Response(JSON.stringify({ success: true, message: 'Password reset successful' }), { 
    status: 200, headers: { 'Content-Type': 'application/json' } 
  });
}

// Mirror a watchlist entry into the email-subscription table so the alert
// pipeline can find it by address even if the user later signs out.
async function upsertEmailAlert(env, session, applicationNumber, embassySlug) {
  if (!session || !session.email) return;
  try {
    const emailHash = await hashEmail(session.email.toLowerCase());
    await env.DB.prepare(`
      INSERT OR REPLACE INTO email_subscriptions
        (user_id, email_hash, email, application_number, embassy, verified, unsubscribed)
      VALUES (?, ?, ?, ?, ?, 1, 0)
    `).bind(session.id, emailHash, session.email, applicationNumber, embassySlug).run();
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
    SELECT id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp, created_at
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

  const { application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp } = body;
  if (!application_number || !embassy_slug) {
    return new Response(JSON.stringify({ error: 'application_number and embassy_slug required' }), { 
      status: 400, headers: { 'Content-Type': 'application/json' } 
    });
  }

  try {
    const inserted = await env.DB.prepare(`
      INSERT INTO watchlists (user_id, application_number, embassy_slug, nickname, notify_email, notify_push, notify_whatsapp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `).bind(
      session.id,
      application_number,
      embassy_slug,
      nickname || null,
      notify_email !== false ? 1 : 0,
      notify_push !== false ? 1 : 0,
      notify_whatsapp === true ? 1 : 0
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

// Password reset tokens table schema (moved outside export to avoid wrangler parser issues with colon in "PRIMARY KEY")
export const PASSWORD_RESET_SCHEMA = `CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;