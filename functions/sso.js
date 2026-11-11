/**
 * Generic OIDC single sign-on.
 *
 * The deployment supplies the issuer/client. This module uses Authorization
 * Code + PKCE, a one-time state row and the provider's userinfo endpoint. It
 * never stores ID tokens, access tokens or client secrets in D1.
 */

import { createSession, hashEmail, hashPassword, validateSession } from './auth.js';
import { ensurePortalSchema } from './portal-schema.js';

const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const STATE_TTL = 10 * 60 * 1000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function baseUrl(env, request) {
  return String(env.APP_BASE_URL || new URL(request.url).origin || DEFAULT_BASE).replace(/\/+$/, '');
}

function cookieValue(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function sessionCookie(env, sessionId) {
  const secure = String(env.APP_BASE_URL || '').startsWith('https') ? '; Secure' : '';
  return 'session_id=' + encodeURIComponent(sessionId) + '; HttpOnly' + secure + '; SameSite=Lax; Path=/; Max-Age=2592000';
}

function stateCookie(value) {
  return 'sso_state=' + encodeURIComponent(value) + '; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/sso; Max-Age=600';
}

function randomUrl(bytes = 32) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function stateError(message) {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function redirectError(env, request, message) {
  const url = new URL('/workspace', baseUrl(env, request));
  url.searchParams.set('sso', 'error');
  url.searchParams.set('message', String(message || 'SSO sign-in failed').slice(0, 180));
  return Response.redirect(url.toString(), 303);
}

async function discover(env) {
  const issuer = String(env.OIDC_ISSUER || '').replace(/\/+$/, '');
  if (!issuer) throw new Error('OIDC_ISSUER is not configured');
  const response = await fetch(issuer + '/.well-known/openid-configuration', {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('OIDC discovery failed (' + response.status + ')');
  const data = await response.json();
  if (!data.authorization_endpoint || !data.token_endpoint || !data.userinfo_endpoint) {
    throw new Error('OIDC discovery is missing required endpoints');
  }
  return data;
}

export function ssoConfigured(env) {
  return Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID);
}

export async function handleSsoStatus(request, env) {
  return json({
    enabled: ssoConfigured(env),
    provider: ssoConfigured(env) ? String(env.OIDC_ISSUER) : null,
    login_url: ssoConfigured(env) ? '/api/auth/sso/start' : null,
    label: env.OIDC_BUTTON_LABEL || 'Continue with single sign-on'
  });
}

export async function handleSsoStart(request, env) {
  if (!ssoConfigured(env)) return json({ error: 'Single sign-on is not configured' }, 503);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  try {
    await ensurePortalSchema(env);
    const discovery = await discover(env);
    const state = randomUrl(32);
    const verifier = randomUrl(48);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const redirectUri = baseUrl(env, request) + '/api/auth/sso/callback';
    const org = String(new URL(request.url).searchParams.get('org') || '').slice(0, 80);
    await env.DB.prepare(`
      INSERT INTO sso_states (state, org_slug, code_verifier, redirect_uri, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(state, org || null, verifier, redirectUri, new Date(Date.now() + STATE_TTL).toISOString()).run();

    const authorize = new URL(discovery.authorization_endpoint);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', String(env.OIDC_CLIENT_ID));
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('scope', String(env.OIDC_SCOPES || 'openid email profile'));
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    if (org) authorize.searchParams.set('login_hint', '');
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorize.toString(),
        'Set-Cookie': stateCookie(state),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return json({ error: String(error.message || 'SSO start failed') }, 503);
  }
}

function decodeIdToken(token) {
  try {
    const payload = String(token || '').split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export async function handleSsoCallback(request, env) {
  if (!ssoConfigured(env)) return json({ error: 'Single sign-on is not configured' }, 503);
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  const url = new URL(request.url);
  const state = String(url.searchParams.get('state') || '');
  const code = String(url.searchParams.get('code') || '');
  const cookieState = cookieValue(request, 'sso_state');
  if (!state || !code) return stateError('Missing SSO state or code');
  if (cookieState && cookieState !== state) return stateError('SSO state mismatch');

  try {
    await ensurePortalSchema(env);
    const stored = await env.DB.prepare(`
      SELECT * FROM sso_states WHERE state = ? AND datetime(expires_at) > datetime('now')
    `).bind(state).first();
    if (!stored) return stateError('SSO state expired or was already used');
    await env.DB.prepare('DELETE FROM sso_states WHERE state = ?').bind(state).run();

    const discovery = await discover(env);
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: stored.redirect_uri,
      client_id: String(env.OIDC_CLIENT_ID),
      code_verifier: stored.code_verifier
    });
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    };
    if (env.OIDC_CLIENT_SECRET) {
      headers.Authorization = 'Basic ' + btoa(String(env.OIDC_CLIENT_ID) + ':' + String(env.OIDC_CLIENT_SECRET));
    }
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers,
      body: tokenBody.toString(),
      signal: AbortSignal.timeout(12000)
    });
    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => '');
      throw new Error('Token exchange failed (' + tokenResponse.status + '): ' + detail.slice(0, 120));
    }
    const tokens = await tokenResponse.json();
    let profile = null;
    try {
      const profileResponse = await fetch(discovery.userinfo_endpoint, {
        headers: { Authorization: 'Bearer ' + tokens.access_token, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (profileResponse.ok) profile = await profileResponse.json();
    } catch {}
    if (!profile) profile = decodeIdToken(tokens.id_token);
    if (!profile || !profile.sub) throw new Error('The identity provider returned no subject');
    const email = String(profile.email || '').trim().toLowerCase();
    if (!email) throw new Error('The identity provider returned no email address');
    const subject = String(profile.sub);
    const provider = String(env.OIDC_ISSUER).replace(/\/+$/, '');
    const identity = await env.DB.prepare(
      'SELECT user_id FROM sso_identities WHERE provider = ? AND subject = ?'
    ).bind(provider, subject).first();

    let userId = identity && identity.user_id;
    if (!userId) {
      const existing = await env.DB.prepare('SELECT id FROM users WHERE email_hash = ?')
        .bind(await hashEmail(email)).first();
      userId = existing && existing.id;
    }
    if (!userId) {
      userId = crypto.randomUUID();
      const passwordHash = await hashPassword('sso-' + randomUrl(32));
      await env.DB.prepare(`
        INSERT INTO users (id, email, email_hash, password_hash, name, preferences, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `).bind(
        userId,
        email,
        await hashEmail(email),
        passwordHash,
        String(profile.name || email.split('@')[0]).slice(0, 120),
        JSON.stringify({
          theme: 'light',
          language: 'en',
          sso: true,
          notifications: { email: true, push: false }
        })
      ).run();
    }
    await env.DB.prepare(`
      INSERT OR IGNORE INTO sso_identities (id, provider, subject, user_id, email)
      VALUES (?, ?, ?, ?, ?)
    `).bind(crypto.randomUUID(), provider, subject, userId, email).run();

    if (stored.org_slug) {
      const org = await env.DB.prepare('SELECT id FROM organizations WHERE slug = ?').bind(stored.org_slug).first();
      if (org) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')
        `).bind(org.id, userId).run();
      }
    } else if (email.includes('@')) {
      // Domain-based organization linking: an organization can claim a domain
      // for SSO. Membership is additive and never grants admin rights.
      const domain = email.split('@').pop();
      const org = await env.DB.prepare(
        'SELECT id FROM organizations WHERE sso_domain = ? LIMIT 1'
      ).bind(domain).first();
      if (org) {
        await env.DB.prepare(`
          INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, 'member')
        `).bind(org.id, userId).run();
      }
    }

    const sessionId = await createSession(env, userId);
    const target = new URL('/workspace', baseUrl(env, request));
    target.searchParams.set('sso', 'ok');
    return new Response(null, {
      status: 303,
      headers: {
        Location: target.toString(),
        'Set-Cookie': sessionCookie(env, sessionId),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    console.error('SSO callback failed:', error.message);
    return redirectError(env, request, error.message);
  }
}
