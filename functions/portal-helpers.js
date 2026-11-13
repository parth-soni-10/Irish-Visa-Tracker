/** Shared response, session and small validation helpers for product routes. */

import { validateSession } from './auth.js';
import { ensurePortalSchema } from './portal-schema.js';

const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const MAX_BODY = 64 * 1024;

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function text(body, status = 200, type = 'text/plain; charset=utf-8', extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }
  });
}

export function baseUrl(env) {
  return String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

export function sessionIdFromCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== 'session_id') continue;
    const value = rest.join('=');
    // The auth cookie is `userId:sessionId`.
    return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  }
  return null;
}

export async function currentUser(request, env) {
  const sessionId = sessionIdFromCookie(request);
  if (!sessionId || !env.DB) return null;
  try {
    return await validateSession(env, sessionId);
  } catch {
    return null;
  }
}

export function prefs(session) {
  try { return JSON.parse(session && session.preferences || '{}'); } catch { return {}; }
}

export function displayName(user) {
  const name = String(user && user.name || '').trim();
  if (!name) return 'Applicant';
  return name.split(/\s+/)[0].slice(0, 40);
}

export function cleanText(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

export function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

export function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new Error('Request body is too large');
  return request.json();
}

export async function safeRows(env, sql, params = []) {
  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch {
    return [];
  }
}

export async function safeFirst(env, sql, params = []) {
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch {
    return null;
  }
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { user: null, response: json({ error: 'Sign in required' }, 401) };
  return { user, response: null };
}

export async function ensureProduct(env) {
  if (!env.DB) throw new Error('Database not configured');
  await ensurePortalSchema(env);
}

export async function membership(env, userId) {
  const member = await safeFirst(env, `
    SELECT o.*, m.role
    FROM org_members m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ?
    ORDER BY m.created_at LIMIT 1
  `, [userId]);
  if (!member) return null;
  const members = await safeRows(env, `
    SELECT m.user_id, m.role, m.created_at, u.email, u.name
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY m.created_at
  `, [member.id]);
  return { ...member, members };
}

export function publicOrg(org) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    brand_name: org.brand_name || org.name,
    brand_color: org.brand_color || '#047857',
    logo_url: org.logo_url || null,
    plan: org.plan || 'team'
  };
}
