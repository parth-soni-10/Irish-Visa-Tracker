/**
 * Authentication Module
 * Handles user registration, login, session management and private export tokens
 */

import { sha256 } from './crypto.js';

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

// Private export tokens use a deterministic SHA-256 digest so a presented token can be
// looked up without storing it. Passwords must not use this helper: those use
// PBKDF2 with a random salt above.
async function hashToken(token) {
  return sha256(String(token || ''));
}

// Create a token for API v1. The plaintext value is returned exactly once.
async function createAPIToken(env, userId, name, scopes = ['read'], expiresDays = 365) {
  const token = 'vt_' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const tokenHash = await hashToken(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO api_tokens (id, token_hash, user_id, name, scopes, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(id, tokenHash, userId, name, JSON.stringify(scopes), expiresAt).run();

  return { id, token, name, scopes, expiresAt };
}

async function validateAPIToken(env, token) {
  if (!token || !/^vt_[A-Za-z0-9]+$/.test(token)) return null;
  const tokenHash = await hashToken(token);
  const record = await env.DB.prepare(`
    SELECT t.id, t.user_id, t.name, t.scopes, t.expires_at, u.email, u.name AS user_name
    FROM api_tokens t
    JOIN users u ON t.user_id = u.id
    WHERE t.token_hash = ?
      AND (t.expires_at IS NULL OR datetime(t.expires_at) > datetime('now'))
      AND t.revoked = 0
  `).bind(tokenHash).first();

  if (record) {
    await env.DB.prepare('UPDATE api_tokens SET last_used_at = datetime("now") WHERE id = ?').bind(record.id).run();
    let scopes = ['read'];
    try { scopes = JSON.parse(record.scopes || '["read"]'); } catch {}
    return { id: record.id, userId: record.user_id, email: record.email, name: record.user_name, scopes };
  }
  return null;
}

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
  hashToken
};