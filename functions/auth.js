/**
 * Authentication Module
 * Handles user registration, login, session management, JWT tokens
 */

// Password hashing using Web Crypto API (PBKDF2) - randomized with salt
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key,
    256
  );
  const result = new Uint8Array(hash);
  const combined = new Uint8Array(salt.length + result.length);
  combined.set(salt);
  combined.set(result, salt.length);
  return btoa(String.fromCharCode(...combined));
}

async function verifyPassword(password, storedHash) {
  try {
    const combined = new Uint8Array(atob(storedHash).split('').map(c => c.charCodeAt(0)));
    const salt = combined.slice(0, 16);
    const storedResult = combined.slice(16);
    
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    const hash = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key,
      256
    );
    const result = new Uint8Array(hash);
    return result.length === storedResult.length && 
           result.every((val, i) => val === storedResult[i]);
  } catch {
    return false;
  }
}

// Deterministic email hashing (no salt, same input always produces same output)
async function hashEmail(email) {
  const encoder = new TextEncoder();
  const data = encoder.encode(email.toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
}

// Generate secure random token
function generateToken(length = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// Session management
async function createSession(env, userId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  
  await env.DB.prepare(`
    INSERT INTO user_sessions (session_id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(sessionId, userId, expiresAt.toISOString()).run();
  
  return sessionId;
}

async function validateSession(env, sessionId) {
  if (!sessionId) return null;
  
  const session = await env.DB.prepare(`
    SELECT s.*, u.id, u.email, u.name, u.preferences, u.created_at
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.session_id = ? AND s.expires_at > datetime('now')
  `).bind(sessionId).first();
  
  if (session) {
    // Update last activity
    await env.DB.prepare(`
      UPDATE user_sessions SET last_activity = datetime('now') WHERE session_id = ?
    `).bind(sessionId).run();
  }
  
  return session;
}

async function deleteSession(env, sessionId) {
  await env.DB.prepare('DELETE FROM user_sessions WHERE session_id = ?').bind(sessionId).run();
}

async function cleanupExpiredSessions(env) {
  await env.DB.prepare('DELETE FROM user_sessions WHERE expires_at < datetime("now")').run();
}

// JWT token for API access
async function createAPIToken(env, userId, name, scopes = ['read']) {
  const token = 'vt_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await hashPassword(token);
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
  
  await env.DB.prepare(`
    INSERT INTO api_tokens (token_hash, user_id, name, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).bind(tokenHash, userId, name, JSON.stringify(scopes), expiresAt.toISOString()).run();
  
  return token; // Only returned once
}

async function validateAPIToken(env, token) {
  const tokenHash = await hashPassword(token);
  const record = await env.DB.prepare(`
    SELECT t.*, u.id, u.email, u.name
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token_hash = ? AND t.expires_at > datetime('now') AND t.revoked = 0
  `).bind(tokenHash).first();
  
  if (record) {
    await env.DB.prepare('UPDATE api_tokens SET last_used = datetime("now") WHERE id = ?').bind(record.id).run();
    return { userId: record.user_id, email: record.email, name: record.name };
  }
  return null;
}

// Email verification tokens
async function createVerificationToken(env, email, type) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
  
  await env.DB.prepare(`
    INSERT INTO email_verifications (token, email, type, expires_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).bind(token, email.toLowerCase(), type, expiresAt.toISOString()).run();
  
  return token;
}

async function verifyEmailToken(env, token) {
  const record = await env.DB.prepare(`
    SELECT * FROM email_verifications WHERE token = ? AND expires_at > datetime('now')
  `).bind(token).first();
  
  if (!record) return null;
  
  await env.DB.prepare('DELETE FROM email_verifications WHERE token = ?').bind(token).run();
  return { email: record.email, type: record.type };
}

// Password reset tokens
async function createPasswordResetToken(env, email) {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  
  await env.DB.prepare(`
    INSERT INTO password_reset_tokens (token, email, expires_at, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(token, email.toLowerCase(), expiresAt.toISOString()).run();
  
  return token;
}

async function verifyPasswordResetToken(env, token) {
  const record = await env.DB.prepare(`
    SELECT * FROM password_reset_tokens WHERE token = ? AND expires_at > datetime('now')
  `).bind(token).first();
  
  if (!record) return null;
  
  await env.DB.prepare('DELETE FROM password_reset_tokens WHERE token = ?').bind(token).run();
  return { email: record.email };
}

// Password reset tokens table (add to schema if not exists)
const PASSWORD_RESET_SCHEMA = `
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export {
  hashPassword,
  verifyPassword,
  hashEmail,
  createSession,
  validateSession,
  deleteSession,
  cleanupExpiredSessions,
  createAPIToken,
  validateAPIToken,
  createVerificationToken,
  verifyEmailToken,
  createPasswordResetToken,
  verifyPasswordResetToken,
  PASSWORD_RESET_SCHEMA
};