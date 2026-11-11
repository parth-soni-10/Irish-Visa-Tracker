/**
 * Authenticated product API for the workspace.
 *
 * Everything here is private to the signed-in user except public community
 * reads and organization branding. The removed `/api/v1` surface is not
 * recreated: export tokens only authorize one private export download.
 */

import {
  createAPIToken,
  createVerificationToken,
  validateAPIToken,
  validateSession
} from './auth.js';
import { ensurePortalSchema } from './portal-schema.js';
import { loadReportData } from './report-data.js';
import { buildAnalytics } from './analytics.js';
import { quoteFees, scanDocument } from './assistant.js';
import { isChannelConfigured, sendChannelTest } from './notify-channels.js';
import { buildExport, createExportJob, nextRunAt, safeFormat } from './export-service.js';
import { isEmailConfigured, sendAccountVerificationEmail, sendEmail } from './email-send.js';

const DEFAULT_BASE = 'https://irishvisaupdatetracker.pages.dev';
const MAX_BODY = 64 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function text(body, status = 200, type = 'text/plain; charset=utf-8', extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra }
  });
}

function baseUrl(env) {
  return String(env.APP_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function sessionIdFromCookie(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== 'session_id') continue;
    const value = rest.join('=');
    // The normal auth cookie is `userId:sessionId`; SSO creates a bare id.
    return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  }
  return null;
}

async function currentUser(request, env) {
  const sessionId = sessionIdFromCookie(request);
  if (!sessionId || !env.DB) return null;
  try {
    return await validateSession(env, sessionId);
  } catch {
    return null;
  }
}

function prefs(session) {
  try { return JSON.parse(session && session.preferences || '{}'); } catch { return {}; }
}

function displayName(user) {
  const name = String(user && user.name || '').trim();
  if (!name) return 'Applicant';
  return name.split(/\s+/)[0].slice(0, 40);
}

function cleanText(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function validPhone(value) {
  return /^\+[1-9]\d{7,14}$/.test(String(value || '').replace(/[\s()-]/g, ''));
}

function normalizePhone(value) {
  return String(value || '').trim().replace(/^whatsapp:/i, '').replace(/[\s()-]/g, '');
}

function slugify(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY) throw new Error('Request body is too large');
  return request.json();
}

async function safeRows(env, sql, params = []) {
  try {
    const result = await env.DB.prepare(sql).bind(...params).all();
    return result.results || [];
  } catch {
    return [];
  }
}

async function safeFirst(env, sql, params = []) {
  try {
    return await env.DB.prepare(sql).bind(...params).first();
  } catch {
    return null;
  }
}

async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) return { user: null, response: json({ error: 'Sign in required' }, 401) };
  return { user, response: null };
}

async function ensureProduct(env) {
  if (!env.DB) throw new Error('Database not configured');
  await ensurePortalSchema(env);
}

async function membership(env, userId) {
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

function publicOrg(org) {
  if (!org) return null;
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    brand_name: org.brand_name || org.name,
    brand_color: org.brand_color || '#047857',
    logo_url: org.logo_url || null,
    plan: org.plan || 'team',
    sso_domain: org.sso_domain || null,
    sso_required: Boolean(org.sso_required)
  };
}

async function createReferralCode(env, userId) {
  const existing = await safeFirst(env, 'SELECT code FROM referral_codes WHERE user_id = ?', [userId]);
  if (existing && existing.code) return existing.code;
  let code = 'ref-' + String(userId).replace(/-/g, '').slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);
  for (let attempt = 0; attempt < 4; attempt++) {
    const collision = await safeFirst(env, 'SELECT code FROM referral_codes WHERE code = ?', [code]);
    if (!collision) break;
    code = 'ref-' + Math.random().toString(36).slice(2, 10);
  }
  await env.DB.prepare('INSERT INTO referral_codes (user_id, code) VALUES (?, ?)')
    .bind(userId, code).run();
  return code;
}

async function overview(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  const user = auth.user;
  const [watchlists, channels, schedules, posts, referrals, jobs] = await Promise.all([
    safeRows(env, 'SELECT application_number, embassy_slug, nickname, created_at FROM watchlists WHERE user_id = ? ORDER BY created_at DESC', [user.id]),
    safeRows(env, 'SELECT channel, address, verified, consent_at, updated_at FROM user_channels WHERE user_id = ?', [user.id]),
    safeRows(env, 'SELECT id, format, frequency, next_run_at, enabled FROM scheduled_exports WHERE user_id = ? ORDER BY created_at DESC', [user.id]),
    safeRows(env, 'SELECT id, kind, title, created_at FROM community_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [user.id]),
    safeRows(env, 'SELECT code, status, invited_email, created_at FROM referrals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [user.id]),
    safeRows(env, 'SELECT id, format, status, row_count, created_at FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5', [user.id])
  ]);
  const notificationRows = await safeRows(env, 'SELECT id, title, body, url, read_at, created_at FROM user_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 8', [user.id]);
  const org = await membership(env, user.id);
  const preferences = prefs(user);
  return json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at,
      preferences,
      email_verified: Boolean(preferences.email_verified)
    },
    watchlists,
    channels,
    schedules,
    posts,
    referrals,
    jobs,
    notifications: notificationRows,
    unread_notifications: notificationRows.filter((item) => !item.read_at).length,
    org: org ? publicOrg(org) : null,
    capabilities: {
      email: isEmailConfigured(env),
      push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      sms: isChannelConfigured(env, 'sms'),
      whatsapp: isChannelConfigured(env, 'whatsapp'),
      ocr: Boolean(env.OCR_SPACE_API_KEY),
      sso: Boolean(env.OIDC_ISSUER && env.OIDC_CLIENT_ID)
    }
  });
}

async function profile(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  const user = auth.user;
  if (request.method === 'GET') {
    return json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        preferences: prefs(user)
      }
    });
  }
  if (request.method !== 'PATCH' && request.method !== 'PUT') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const updates = [];
  const params = [];
  if (body.name !== undefined) {
    const name = cleanText(body.name, 120);
    if (!name) return json({ error: 'Name cannot be empty' }, 400);
    updates.push('name = ?');
    params.push(name);
  }
  if (body.preferences !== undefined) {
    if (!body.preferences || typeof body.preferences !== 'object' || Array.isArray(body.preferences)) {
      return json({ error: 'Preferences must be an object' }, 400);
    }
    const allowed = ['theme', 'language', 'timezone', 'notifications', 'digest', 'profile_visibility'];
    const merged = { ...prefs(user) };
    for (const key of allowed) {
      if (body.preferences[key] !== undefined) merged[key] = body.preferences[key];
    }
    if (merged.notifications && typeof merged.notifications !== 'object') merged.notifications = {};
    if (merged.notifications) {
      merged.notifications = {
        email: Boolean(merged.notifications.email),
        push: Boolean(merged.notifications.push),
        sms: Boolean(merged.notifications.sms),
        whatsapp: Boolean(merged.notifications.whatsapp),
        digest: Boolean(merged.notifications.digest)
      };
    }
    if (merged.theme && !['light', 'dark', 'system'].includes(merged.theme)) return json({ error: 'Invalid theme' }, 400);
    if (merged.language && !/^[a-z]{2}(-[A-Z]{2})?$/.test(String(merged.language))) return json({ error: 'Invalid language' }, 400);
    if (merged.timezone && String(merged.timezone).length > 80) return json({ error: 'Invalid timezone' }, 400);
    updates.push('preferences = ?');
    params.push(JSON.stringify(merged));
  }
  if (!updates.length) return json({ error: 'No profile fields to update' }, 400);
  params.push(new Date().toISOString(), user.id);
  await env.DB.prepare('UPDATE users SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').bind(...params).run();
  return json({ success: true });
}

async function resendVerification(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  if (prefs(auth.user).email_verified) return json({ success: true, message: 'Email is already verified' });
  if (!isEmailConfigured(env)) return json({ error: 'Email delivery is not configured' }, 503);
  try {
    const token = await createVerificationToken(env, auth.user.email, 'registration');
    await sendAccountVerificationEmail(env, auth.user.email, token);
    return json({ success: true, message: 'Verification email sent' });
  } catch (error) {
    return json({ error: String(error.message || 'Could not send verification email') }, 502);
  }
}

async function channels(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  if (request.method === 'GET') {
    return json({
      channels: await safeRows(env, 'SELECT channel, address, verified, consent_at, updated_at FROM user_channels WHERE user_id = ? ORDER BY channel', [auth.user.id]),
      configured: {
        sms: isChannelConfigured(env, 'sms'),
        whatsapp: isChannelConfigured(env, 'whatsapp')
      }
    });
  }
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (request.method === 'DELETE') {
    const channel = String(body.channel || '');
    if (!['sms', 'whatsapp'].includes(channel)) return json({ error: 'Invalid channel' }, 400);
    await env.DB.prepare('DELETE FROM user_channels WHERE user_id = ? AND channel = ?').bind(auth.user.id, channel).run();
    return json({ success: true });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const channel = String(body.channel || '');
  if (!['sms', 'whatsapp'].includes(channel)) return json({ error: 'Invalid channel' }, 400);
  const address = normalizePhone(body.address);
  if (!validPhone(address)) return json({ error: 'Use an international number such as +353871234567' }, 400);
  if (body.consent !== true) return json({ error: 'Consent is required before enabling messages' }, 400);
  await env.DB.prepare(`
    INSERT INTO user_channels (id, user_id, channel, address, verified, consent_at, updated_at)
    VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, channel) DO UPDATE SET address = excluded.address, verified = 1,
      consent_at = datetime('now'), updated_at = datetime('now')
  `).bind(crypto.randomUUID(), auth.user.id, channel, address).run();
  return json({ success: true, configured: isChannelConfigured(env, channel), channel, address });
}

async function testChannel(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const channel = String(body.channel || '');
  if (!['sms', 'whatsapp'].includes(channel)) return json({ error: 'Invalid channel' }, 400);
  const row = await safeFirst(env, 'SELECT address FROM user_channels WHERE user_id = ? AND channel = ?', [auth.user.id, channel]);
  if (!row) return json({ error: 'Add and consent to this channel first' }, 404);
  if (!isChannelConfigured(env, channel)) return json({ error: channel + ' delivery is not configured by this deployment' }, 503);
  const result = await sendChannelTest(env, channel, row.address);
  return json(result, result.sent ? 200 : 502);
}

async function analytics(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  const params = new URL(request.url).searchParams;
  const report = await loadReportData(env, request);
  return json(buildAnalytics(report.rows, {
    office: params.get('office') || 'all',
    from: params.get('from') || '',
    to: params.get('to') || '',
    date: params.get('date') || '',
    month: params.get('month') || '',
    horizon: Number(params.get('horizon') || 14)
  }));
}

async function exportDownload(request, env) {
  const params = new URL(request.url).searchParams;
  const token = String(params.get('token') || '');
  if (!token) return json({ error: 'Export token required' }, 401);
  const record = await validateAPIToken(env, token);
  if (!record) return json({ error: 'Invalid or expired export token' }, 401);
  if (!Array.isArray(record.scopes) || (!record.scopes.includes('export') && !record.scopes.includes('read'))) {
    return json({ error: 'This token cannot export data' }, 403);
  }
  const report = await loadReportData(env, request);
  const data = buildExport(report.rows, {
    format: params.get('format') || 'csv',
    office: params.get('office') || 'all',
    from: params.get('from') || '',
    to: params.get('to') || ''
  });
  return text(data.body, 200, data.contentType, {
    'Content-Disposition': 'attachment; filename="' + data.filename + '"'
  });
}

async function exports(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  const url = new URL(request.url);
  const params = url.searchParams;
  if (request.method === 'GET' && url.pathname.endsWith('/download')) {
    return exportDownload(request, env);
  }
  if (request.method === 'GET') {
    const report = await loadReportData(env, request);
    const data = buildExport(report.rows, {
      format: params.get('format') || 'csv',
      office: params.get('office') || 'all',
      from: params.get('from') || '',
      to: params.get('to') || ''
    });
    return text(data.body, 200, data.contentType, {
      'Content-Disposition': 'attachment; filename="' + data.filename + '"'
    });
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function schedules(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  if (request.method === 'GET') {
    const rows = await safeRows(env, 'SELECT id, format, frequency, filters, next_run_at, enabled, created_at FROM scheduled_exports WHERE user_id = ? ORDER BY created_at DESC', [auth.user.id]);
    return json({ schedules: rows.map((row) => { try { return { ...row, filters: JSON.parse(row.filters || '{}') }; } catch { return row; } }) });
  }
  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    await env.DB.prepare('DELETE FROM scheduled_exports WHERE id = ? AND user_id = ?').bind(id, auth.user.id).run();
    return json({ success: true });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const format = safeFormat(body.format);
  const frequency = ['daily', 'weekly', 'monthly'].includes(body.frequency) ? body.frequency : 'weekly';
  const filters = body.filters && typeof body.filters === 'object' ? body.filters : {};
  if (filters.office) filters.office = String(filters.office).slice(0, 40);
  if (filters.from) filters.from = isoDate(filters.from);
  if (filters.to) filters.to = isoDate(filters.to);
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO scheduled_exports (id, user_id, format, frequency, filters, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, auth.user.id, format, frequency, JSON.stringify(filters), nextRunAt(frequency)).run();
  return json({ success: true, id, format, frequency, next_run_at: nextRunAt(frequency) }, 201);
}

async function exportTokens(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  if (request.method === 'GET') {
    const rows = await safeRows(env, `
      SELECT id, name, scopes, expires_at, created_at, last_used_at
      FROM api_tokens WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC
    `, [auth.user.id]);
    return json({ tokens: rows.map((row) => { let scopes = ['export']; try { scopes = JSON.parse(row.scopes || '[]'); } catch {} return { ...row, scopes }; }) });
  }
  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'id required' }, 400);
    const result = await env.DB.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ? AND user_id = ?').bind(id, auth.user.id).run();
    if (!result.meta || !result.meta.changes) return json({ error: 'Token not found' }, 404);
    return json({ success: true });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const name = cleanText(body.name, 80);
  if (name.length < 2) return json({ error: 'Give the token a name' }, 400);
  const days = Math.max(1, Math.min(3650, Number(body.expires_days) || 365));
  const created = await createAPIToken(env, auth.user.id, name, ['export'], days);
  return json({
    success: true,
    token: created.token,
    id: created.id,
    name: created.name,
    scopes: created.scopes,
    expires_at: created.expiresAt,
    note: 'This private token can only download your own export. It is shown once.'
  }, 201);
}

async function jobList(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  const jobs = await safeRows(env, 'SELECT id, format, status, row_count, created_at, completed_at FROM export_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 25', [auth.user.id]);
  return json({ jobs });
}

async function fees(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  const params = new URL(request.url).searchParams;
  return json(quoteFees({
    office: params.get('office') || 'new-delhi',
    entry_type: params.get('entry_type') || 'single',
    entries: Number(params.get('entries') || 1),
    vfs: params.get('vfs') !== '0',
    biometrics: params.get('biometrics') !== '0',
    postal: params.get('postal') === '1'
  }));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function ocrFile(env, file) {
  if (!env.OCR_SPACE_API_KEY) {
    return { error: 'OCR provider is not configured. Paste the text instead, or set OCR_SPACE_API_KEY.', disabled: true };
  }
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > 5 * 1024 * 1024) return { error: 'File must be 5 MB or smaller' };
  const mime = file.type || 'application/octet-stream';
  const base64 = bytesToBase64(new Uint8Array(buffer));
  const form = new URLSearchParams();
  form.set('apikey', env.OCR_SPACE_API_KEY);
  form.set('language', 'eng');
  form.set('isOverlayRequired', 'false');
  form.set('scale', 'true');
  form.set('base64Image', 'data:' + mime + ';base64,' + base64);
  if (mime.includes('pdf')) form.set('filetype', 'PDF');
  const response = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) return { error: 'OCR provider rejected the file (' + response.status + ')' };
  const data = await response.json().catch(() => null);
  if (!data || data.IsErroredOnProcessing) {
    return { error: String(data && data.ErrorMessage && data.ErrorMessage[0] || 'OCR could not read this file') };
  }
  const text = (data.ParsedResults || []).map((item) => item.ParsedText || '').join('\n');
  if (!text.trim()) return { error: 'OCR returned no readable text' };
  return { text };
}

async function scan(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  const contentType = request.headers.get('Content-Type') || '';
  let rawText = '';
  let documentType = 'pasted-text';
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      rawText = String(form.get('text') || '');
      const file = form.get('file');
      if (!rawText && file && typeof file.arrayBuffer === 'function') {
        documentType = file.name || file.type || 'upload';
        if (String(file.type || '').startsWith('text/') || /\.(txt|csv)$/i.test(file.name || '')) {
          rawText = await file.text();
        } else {
          const ocr = await ocrFile(env, file);
          if (ocr.error) return json({ error: ocr.error, disabled: Boolean(ocr.disabled) }, ocr.disabled ? 503 : 422);
          rawText = ocr.text;
        }
      }
    } else {
      const body = await readJson(request);
      rawText = String(body.text || '');
    }
  } catch (error) {
    return json({ error: 'Could not read the submitted document' }, 400);
  }
  if (!rawText.trim()) return json({ error: 'Paste the document text or upload a text/image/PDF file' }, 400);
  const result = scanDocument(rawText);
  if (result.confidence > 0) {
    await env.DB.prepare(`
      INSERT INTO assistant_scans (id, user_id, document_type, fields) VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), auth.user.id, documentType.slice(0, 120), JSON.stringify(result.fields)).run().catch(() => {});
  }
  return json({ success: true, ...result, document_type: documentType });
}

function communitySummary(post) {
  return {
    id: post.id,
    kind: post.kind,
    title: post.title,
    body: post.body,
    office: post.office,
    visa_type: post.visa_type,
    outcome: post.outcome,
    rating: post.rating,
    created_at: post.created_at,
    author: post.author_name ? displayName({ name: post.author_name }) : 'Applicant',
    answer_count: Number(post.answer_count) || 0,
    is_owner: Boolean(post.is_owner)
  };
}

async function community(request, env) {
  const user = await currentUser(request, env);
  await ensureProduct(env);
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET') {
    const id = path.match(/^\/api\/portal\/community\/([^/]+)$/);
    if (id) {
      const post = await safeFirst(env, `
        SELECT p.*, u.name AS author_name,
          (SELECT COUNT(*) FROM community_answers a WHERE a.post_id = p.id) AS answer_count
        FROM community_posts p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.id = ? AND p.status = 'published'
      `, [id[1]]);
      if (!post) return json({ error: 'Post not found' }, 404);
      const answers = await safeRows(env, `
        SELECT a.id, a.body, a.accepted, a.created_at, u.name AS author_name, u.id AS user_id
        FROM community_answers a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.post_id = ? ORDER BY a.accepted DESC, a.created_at ASC
      `, [post.id]);
      return json({
        post: communitySummary({ ...post, is_owner: user && user.id === post.user_id }),
        answers: answers.map((answer) => ({
          id: answer.id,
          body: answer.body,
          accepted: Boolean(answer.accepted),
          created_at: answer.created_at,
          author: displayName({ name: answer.author_name }),
          is_owner: Boolean(user && user.id === answer.user_id)
        }))
      });
    }
    const kind = String(url.searchParams.get('kind') || '');
    const office = String(url.searchParams.get('office') || '');
    const rows = await safeRows(env, `
      SELECT p.*, u.name AS author_name,
        (SELECT COUNT(*) FROM community_answers a WHERE a.post_id = p.id) AS answer_count
      FROM community_posts p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.status = 'published'
        AND (? = '' OR p.kind = ?)
        AND (? = '' OR p.office = ?)
      ORDER BY p.created_at DESC LIMIT 80
    `, [kind, kind, office, office]);
    return json({
      posts: rows.map((post) => communitySummary({ ...post, is_owner: Boolean(user && user.id === post.user_id) })),
      can_post: Boolean(user)
    });
  }
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (request.method === 'POST' && /\/community\/[^/]+\/answers\/[^/]+\/accept$/.test(path)) {
    const parts = path.split('/');
    const postId = parts[4];
    const answerId = parts[6];
    const post = await safeFirst(env, 'SELECT user_id FROM community_posts WHERE id = ?', [postId]);
    if (!post || post.user_id !== user.id) return json({ error: 'Only the post author can accept an answer' }, 403);
    await env.DB.prepare('UPDATE community_answers SET accepted = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE post_id = ?').bind(answerId, postId).run();
    return json({ success: true });
  }
  if (request.method === 'POST' && /\/community\/[^/]+\/answers$/.test(path)) {
    const postId = path.split('/')[4];
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const value = cleanText(body.body, 4000);
    if (value.length < 2) return json({ error: 'Answer is too short' }, 400);
    const post = await safeFirst(env, 'SELECT id FROM community_posts WHERE id = ? AND status = \'published\'', [postId]);
    if (!post) return json({ error: 'Post not found' }, 404);
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO community_answers (id, post_id, user_id, body) VALUES (?, ?, ?, ?)').bind(id, postId, user.id, value).run();
    return json({ success: true, id }, 201);
  }
  if (request.method === 'POST' && path === '/api/portal/community') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const kind = ['question', 'review', 'success'].includes(body.kind) ? body.kind : 'question';
    const title = cleanText(body.title, 140);
    const value = cleanText(body.body, 6000);
    if (title.length < 4 || value.length < 10) return json({ error: 'Add a title and a little more detail' }, 400);
    const rating = kind === 'review' ? Math.max(1, Math.min(5, Number(body.rating) || 5)) : null;
    const outcome = kind === 'success' && ['Approved', 'Refused'].includes(body.outcome) ? body.outcome : null;
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO community_posts (id, user_id, kind, title, body, office, visa_type, outcome, rating)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, user.id, kind, title, value, cleanText(body.office, 40) || null, cleanText(body.visa_type, 40) || null, outcome, rating).run();
    return json({ success: true, id }, 201);
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function referrals(request, env) {
  const auth = await requireUser(request, env);
  if (!auth.user) return auth.response;
  await ensureProduct(env);
  const code = await createReferralCode(env, auth.user.id);
  if (request.method === 'GET') {
    const rows = await safeRows(env, 'SELECT invited_email, status, created_at, accepted_at FROM referrals WHERE user_id = ? AND code = ? ORDER BY created_at DESC', [auth.user.id, code]);
    return json({
      code,
      link: baseUrl(env) + '/workspace?ref=' + encodeURIComponent(code),
      invited: rows,
      accepted: rows.filter((row) => row.status === 'accepted').length
    });
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  let body;
  try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const email = cleanText(body.email, 200).toLowerCase();
  if (!validEmail(email)) return json({ error: 'A valid invite email is required' }, 400);
  const existing = await safeFirst(env, 'SELECT id FROM referrals WHERE code = ? AND invited_email = ?', [code, email]);
  if (existing) return json({ success: true, message: 'This email is already invited' });
  await env.DB.prepare('INSERT INTO referrals (id, user_id, code, invited_email, status) VALUES (?, ?, ?, ?, \'invited\')')
    .bind(crypto.randomUUID(), auth.user.id, code, email).run();
  let sent = false;
  if (isEmailConfigured(env)) {
    try {
      await sendEmail(env, {
        from: env.EMAIL_FROM,
        to: email,
        subject: 'You were invited to Irish Visa Tracker',
        html: '<p>Join the Irish Visa Tracker workspace with this invite link:</p><p><a href="' + baseUrl(env) + '/workspace?ref=' + encodeURIComponent(code) + '">Open workspace</a></p>',
        text: baseUrl(env) + '/workspace?ref=' + code
      });
      sent = true;
    } catch {}
  }
  return json({ success: true, sent, code }, 201);
}

async function orgs(request, env) {
  const user = await currentUser(request, env);
  await ensureProduct(env);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === '/api/portal/org/public') {
    const slug = String(url.searchParams.get('slug') || '');
    const org = await safeFirst(env, 'SELECT * FROM organizations WHERE slug = ?', [slug]);
    return org ? json({ org: publicOrg(org) }) : json({ error: 'Organization not found' }, 404);
  }
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (request.method === 'GET' && url.pathname === '/api/portal/org') {
    return json({ org: await membership(env, user.id) });
  }
  if (request.method === 'POST' && url.pathname === '/api/portal/org') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const name = cleanText(body.name, 120);
    if (name.length < 2) return json({ error: 'Organization name is required' }, 400);
    if (await membership(env, user.id)) return json({ error: 'You already belong to an organization' }, 409);
    const baseSlug = slugify(name) || 'workspace';
    let slug = baseSlug;
    for (let i = 2; i < 10; i++) {
      if (!await safeFirst(env, 'SELECT id FROM organizations WHERE slug = ?', [slug])) break;
      slug = baseSlug + '-' + i;
    }
    const id = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO organizations (id, name, slug, brand_name, brand_color, plan)
      VALUES (?, ?, ?, ?, ?, 'team')
    `).bind(id, name, slug, name, cleanText(body.brand_color, 20) || '#047857').run();
    await env.DB.prepare('INSERT INTO org_members (org_id, user_id, role) VALUES (?, ?, \'owner\')').bind(id, user.id).run();
    return json({ success: true, org: publicOrg(await safeFirst(env, 'SELECT * FROM organizations WHERE id = ?', [id])) }, 201);
  }
  if (request.method === 'PATCH' && url.pathname === '/api/portal/org') {
    const member = await membership(env, user.id);
    if (!member) return json({ error: 'Organization not found' }, 404);
    if (!['owner', 'admin'].includes(member.role)) return json({ error: 'Owner or admin access required' }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const updates = [];
    const params = [];
    for (const [key, max] of [['name', 120], ['brand_name', 120], ['brand_color', 20], ['logo_url', 500], ['sso_domain', 180]]) {
      if (body[key] !== undefined) {
        updates.push(key + ' = ?');
        params.push(cleanText(body[key], max));
      }
    }
    if (body.sso_required !== undefined) {
      updates.push('sso_required = ?');
      params.push(body.sso_required ? 1 : 0);
    }
    if (!updates.length) return json({ error: 'No fields to update' }, 400);
    params.push(new Date().toISOString(), member.id);
    await env.DB.prepare('UPDATE organizations SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').bind(...params).run();
    return json({ success: true, org: publicOrg(await safeFirst(env, 'SELECT * FROM organizations WHERE id = ?', [member.id])) });
  }
  if (request.method === 'POST' && url.pathname === '/api/portal/org/invite') {
    const member = await membership(env, user.id);
    if (!member) return json({ error: 'Organization not found' }, 404);
    if (!['owner', 'admin'].includes(member.role)) return json({ error: 'Owner or admin access required' }, 403);
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const email = cleanText(body.email, 200).toLowerCase();
    if (!validEmail(email)) return json({ error: 'Valid email required' }, 400);
    const token = crypto.randomUUID();
    await env.DB.prepare(`
      INSERT INTO org_invites (token, org_id, email, role, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+7 days'))
    `).bind(token, member.id, email, 'member').run();
    let sent = false;
    if (isEmailConfigured(env)) {
      try {
        await sendEmail(env, {
          from: env.EMAIL_FROM,
          to: email,
          subject: 'Join ' + (member.brand_name || member.name) + ' on Irish Visa Tracker',
          html: '<p>You are invited to the workspace.</p><p><a href="' + baseUrl(env) + '/workspace?org_invite=' + encodeURIComponent(token) + '">Join workspace</a></p>',
          text: baseUrl(env) + '/workspace?org_invite=' + token
        });
        sent = true;
      } catch {}
    }
    return json({ success: true, invite_url: baseUrl(env) + '/workspace?org_invite=' + encodeURIComponent(token), sent }, 201);
  }
  if (request.method === 'POST' && url.pathname === '/api/portal/org/join') {
    let body;
    try { body = await readJson(request); } catch { return json({ error: 'Invalid JSON' }, 400); }
    const token = String(body.token || '').trim();
    const invite = await safeFirst(env, 'SELECT * FROM org_invites WHERE token = ? AND datetime(expires_at) > datetime(\'now\')', [token]);
    if (!invite) return json({ error: 'Invite is invalid or expired' }, 404);
    if (invite.email && invite.email.toLowerCase() !== String(user.email || '').toLowerCase()) {
      return json({ error: 'This invite belongs to a different email' }, 403);
    }
    await env.DB.prepare('INSERT OR IGNORE INTO org_members (org_id, user_id, role) VALUES (?, ?, ?)').bind(invite.org_id, user.id, invite.role || 'member').run();
    await env.DB.prepare('DELETE FROM org_invites WHERE token = ?').bind(token).run();
    return json({ success: true, org: publicOrg(await safeFirst(env, 'SELECT * FROM organizations WHERE id = ?', [invite.org_id])) });
  }
  return json({ error: 'Method not allowed' }, 405);
}

export async function handlePortal(request, env) {
  if (!env.DB) return json({ error: 'Database not configured' }, 503);
  const url = new URL(request.url);
  try {
    if (url.pathname === '/api/portal/overview' && request.method === 'GET') return overview(request, env);
    if (url.pathname === '/api/portal/profile' && ['GET', 'PATCH', 'PUT'].includes(request.method)) return profile(request, env);
    if (url.pathname === '/api/portal/verify/resend' && request.method === 'POST') return resendVerification(request, env);
    if (url.pathname === '/api/portal/channels' && ['GET', 'POST', 'DELETE'].includes(request.method)) return channels(request, env);
    if (url.pathname === '/api/portal/channels/test' && request.method === 'POST') return testChannel(request, env);
    if (url.pathname === '/api/portal/analytics' && request.method === 'GET') return analytics(request, env);
    if (url.pathname === '/api/portal/exports/download' && request.method === 'GET') return exportDownload(request, env);
    if (url.pathname === '/api/portal/exports' && request.method === 'GET') return exports(request, env);
    if (url.pathname === '/api/portal/exports/schedules' && ['GET', 'POST', 'DELETE'].includes(request.method)) return schedules(request, env);
    if (url.pathname === '/api/portal/exports/jobs' && request.method === 'GET') return jobList(request, env);
    if (url.pathname === '/api/portal/export-tokens' && ['GET', 'POST', 'DELETE'].includes(request.method)) return exportTokens(request, env);
    if (url.pathname === '/api/portal/assistant/fees' && request.method === 'GET') return fees(request, env);
    if (url.pathname === '/api/portal/assistant/scan' && request.method === 'POST') return scan(request, env);
    if (url.pathname.startsWith('/api/portal/community')) return community(request, env);
    if (url.pathname === '/api/portal/referrals' && ['GET', 'POST'].includes(request.method)) return referrals(request, env);
    if (url.pathname.startsWith('/api/portal/org')) return orgs(request, env);
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('Portal API error:', error);
    return json({ error: 'Portal request failed' }, 500);
  }
}

export { currentUser, ensureProduct, membership, publicOrg };
