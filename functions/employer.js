/**
 * Employer compliance workspace.
 *
 * An organisation has one owner, optional admins and viewers. Owners manage
 * people; owners and admins manage employee permit/IRP records; viewers can
 * only read. Every query is scoped by org_id and checked against the caller's
 * membership, so a client-supplied org id never grants access on its own.
 */

import { validateSession, hashEmail } from './auth.js';

const ROLES = new Set(['owner', 'admin', 'viewer']);
const WRITE_ROLES = new Set(['owner', 'admin']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

function sessionIdFromCookie(request) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  const cookie = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('session_id='));
  if (!cookie) return null;
  const value = cookie.slice('session_id='.length);
  return value.includes(':') ? value.split(':').slice(1).join(':') : value;
}

async function ensureEmployerSchema(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS employer_orgs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS employer_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    org_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (org_id, user_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS employer_employees (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT,
    job_title TEXT,
    permit_type TEXT,
    permit_expiry TEXT,
    irp_expiry TEXT,
    notes TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_employer_members_org ON employer_members(org_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_employer_employees_org ON employer_employees(org_id)').run();
}

async function requireSession(request, env) {
  const sessionId = sessionIdFromCookie(request);
  if (!sessionId) return null;
  return validateSession(env, sessionId);
}

async function membership(env, orgId, userId) {
  return env.DB.prepare('SELECT role FROM employer_members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, userId).first();
}

function clean(value, max = 300) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, max) : null;
}

function validDate(value) {
  if (!value) return true;
  if (!DATE_RE.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function daysUntil(dateString, today = new Date().toISOString().slice(0, 10)) {
  if (!dateString) return null;
  const target = Date.parse(dateString + 'T00:00:00Z');
  const start = Date.parse(today + 'T00:00:00Z');
  if (Number.isNaN(target) || Number.isNaN(start)) return null;
  return Math.ceil((target - start) / 86400000);
}

function expiryState(dateString) {
  const days = daysUntil(dateString);
  if (days === null) return { date: null, days_left: null, key: 'missing', label: 'Not set' };
  if (days < 0) return { date: dateString, days_left: days, key: 'expired', label: 'Expired' };
  if (days <= 30) return { date: dateString, days_left: days, key: 'critical', label: days + ' days' };
  if (days <= 60) return { date: dateString, days_left: days, key: 'warning', label: days + ' days' };
  if (days <= 90) return { date: dateString, days_left: days, key: 'notice', label: days + ' days' };
  return { date: dateString, days_left: days, key: 'ok', label: days + ' days' };
}

const SEVERITY = { expired: 5, critical: 4, warning: 3, notice: 2, ok: 1, missing: 0 };

function employeeState(employee) {
  const permit = expiryState(employee.permit_expiry);
  const irp = expiryState(employee.irp_expiry);
  const states = [permit, irp].filter((state) => state.date);
  const worst = states.length
    ? states.reduce((best, state) => (SEVERITY[state.key] > SEVERITY[best.key] ? state : best), states[0])
    : permit;
  const sorted = states.slice().sort((a, b) => a.days_left - b.days_left);
  return {
    ...employee,
    permit_status: permit,
    irp_status: irp,
    next_expiry: sorted[0] ? sorted[0].date : null,
    next_days_left: sorted[0] ? sorted[0].days_left : null,
    status: worst.key,
    status_label: worst.label
  };
}

function summarizeEmployees(employees) {
  const summary = { total: employees.length, expired: 0, due_30: 0, due_60: 0, due_90: 0, ok: 0, missing: 0 };
  for (const employee of employees) {
    if (employee.status === 'expired') summary.expired += 1;
    else if (employee.status === 'critical') summary.due_30 += 1;
    else if (employee.status === 'warning') summary.due_60 += 1;
    else if (employee.status === 'notice') summary.due_90 += 1;
    else if (employee.status === 'ok') summary.ok += 1;
    else summary.missing += 1;
  }
  return summary;
}

async function orgPayload(env, org, role, userId) {
  const members = await env.DB.prepare(`SELECT u.id, u.email, u.name, m.role, m.created_at
    FROM employer_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.email`)
    .bind(org.id).all();
  const employeeRows = await env.DB.prepare(`SELECT id, name, email, job_title, permit_type,
      permit_expiry, irp_expiry, notes, created_at, updated_at
    FROM employer_employees WHERE org_id = ? ORDER BY name COLLATE NOCASE`)
    .bind(org.id).all();
  const employees = (employeeRows.results || []).map(employeeState)
    .sort((a, b) => {
      if (a.next_days_left === null && b.next_days_left === null) return a.name.localeCompare(b.name);
      if (a.next_days_left === null) return 1;
      if (b.next_days_left === null) return -1;
      return a.next_days_left - b.next_days_left;
    });
  return {
    org: { id: org.id, name: org.name, created_at: org.created_at },
    role,
    permissions: {
      can_manage_employees: WRITE_ROLES.has(role),
      can_manage_members: role === 'owner'
    },
    members: members.results || [],
    employees,
    summary: summarizeEmployees(employees),
    viewer_user_id: userId
  };
}

async function workspace(request, env, session) {
  const orgs = await env.DB.prepare(`SELECT o.id, o.name, o.owner_user_id, o.created_at, m.role
    FROM employer_orgs o JOIN employer_members m ON m.org_id = o.id
    WHERE m.user_id = ? ORDER BY o.created_at DESC`).bind(session.id).all();
  return json({ success: true, organizations: orgs.results || [] });
}

async function createOrg(request, env, session) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const name = clean(body.name, 120);
  if (!name) return json({ error: 'Organisation name required' }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO employer_orgs (id, name, owner_user_id) VALUES (?, ?, ?)')
    .bind(id, name, session.id).run();
  await env.DB.prepare("INSERT INTO employer_members (org_id, user_id, role) VALUES (?, ?, 'owner')")
    .bind(id, session.id).run();
  return json({ success: true, org: { id, name, role: 'owner' } }, 201);
}

async function getOrg(request, env, session, orgId) {
  const member = await membership(env, orgId, session.id);
  if (!member) return json({ error: 'Not found' }, 404);
  const org = await env.DB.prepare('SELECT id, name, owner_user_id, created_at FROM employer_orgs WHERE id = ?')
    .bind(orgId).first();
  if (!org) return json({ error: 'Not found' }, 404);
  return json({ success: true, ...(await orgPayload(env, org, member.role, session.id)) });
}

async function addMember(request, env, session, orgId) {
  const member = await membership(env, orgId, session.id);
  if (!member || member.role !== 'owner') return json({ error: 'Only the owner can manage members' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  const role = String(body.role || 'viewer');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Valid email required' }, 400);
  if (!ROLES.has(role) || role === 'owner') return json({ error: 'Role must be admin or viewer' }, 400);
  const user = await env.DB.prepare('SELECT id, email, name FROM users WHERE email_hash = ?')
    .bind(await hashEmail(email)).first();
  if (!user) return json({ error: 'That person needs an account first' }, 404);
  try {
    await env.DB.prepare('INSERT INTO employer_members (org_id, user_id, role) VALUES (?, ?, ?)')
      .bind(orgId, user.id, role).run();
  } catch (error) {
    return json({ error: 'That person is already a member' }, 409);
  }
  return json({ success: true, member: { ...user, role } }, 201);
}

async function updateMember(request, env, session, orgId, targetUserId) {
  const member = await membership(env, orgId, session.id);
  if (!member || member.role !== 'owner') return json({ error: 'Only the owner can manage members' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const role = String(body.role || '');
  if (!ROLES.has(role) || role === 'owner') return json({ error: 'Role must be admin or viewer' }, 400);
  const target = await membership(env, orgId, targetUserId);
  if (!target) return json({ error: 'Not found' }, 404);
  if (target.role === 'owner') return json({ error: 'The owner role cannot be changed' }, 400);
  await env.DB.prepare('UPDATE employer_members SET role = ? WHERE org_id = ? AND user_id = ?')
    .bind(role, orgId, targetUserId).run();
  return json({ success: true });
}

async function removeMember(request, env, session, orgId, targetUserId) {
  const member = await membership(env, orgId, session.id);
  if (!member || member.role !== 'owner') return json({ error: 'Only the owner can manage members' }, 403);
  const target = await membership(env, orgId, targetUserId);
  if (!target) return json({ error: 'Not found' }, 404);
  if (target.role === 'owner') return json({ error: 'The owner cannot be removed' }, 400);
  await env.DB.prepare('DELETE FROM employer_members WHERE org_id = ? AND user_id = ?')
    .bind(orgId, targetUserId).run();
  return json({ success: true });
}

function employeeFields(body) {
  const fields = {
    name: clean(body.name, 160),
    email: body.email ? String(body.email).trim().toLowerCase().slice(0, 254) : null,
    job_title: clean(body.job_title, 160),
    permit_type: clean(body.permit_type, 120),
    permit_expiry: body.permit_expiry ? String(body.permit_expiry).trim() : null,
    irp_expiry: body.irp_expiry ? String(body.irp_expiry).trim() : null,
    notes: clean(body.notes, 1000)
  };
  return fields;
}

function validateEmployee(fields) {
  if (!fields.name) return 'Employee name required';
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return 'Invalid employee email';
  if (!validDate(fields.permit_expiry)) return 'permit_expiry must be YYYY-MM-DD';
  if (!validDate(fields.irp_expiry)) return 'irp_expiry must be YYYY-MM-DD';
  return null;
}

async function addEmployee(request, env, session, orgId) {
  const member = await membership(env, orgId, session.id);
  if (!member || !WRITE_ROLES.has(member.role)) return json({ error: 'Read-only access' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const fields = employeeFields(body);
  const invalid = validateEmployee(fields);
  if (invalid) return json({ error: invalid }, 400);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO employer_employees
      (id, org_id, name, email, job_title, permit_type, permit_expiry, irp_expiry, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, orgId, fields.name, fields.email, fields.job_title, fields.permit_type,
      fields.permit_expiry, fields.irp_expiry, fields.notes, session.id).run();
  return json({ success: true, id }, 201);
}

async function updateEmployee(request, env, session, orgId, employeeId) {
  const member = await membership(env, orgId, session.id);
  if (!member || !WRITE_ROLES.has(member.role)) return json({ error: 'Read-only access' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const existing = await env.DB.prepare('SELECT * FROM employer_employees WHERE id = ? AND org_id = ?')
    .bind(employeeId, orgId).first();
  if (!existing) return json({ error: 'Not found' }, 404);
  const fields = employeeFields({ ...existing, ...body });
  const invalid = validateEmployee(fields);
  if (invalid) return json({ error: invalid }, 400);
  await env.DB.prepare(`UPDATE employer_employees SET
      name = ?, email = ?, job_title = ?, permit_type = ?, permit_expiry = ?, irp_expiry = ?,
      notes = ?, updated_at = datetime('now') WHERE id = ? AND org_id = ?`)
    .bind(fields.name, fields.email, fields.job_title, fields.permit_type,
      fields.permit_expiry, fields.irp_expiry, fields.notes, employeeId, orgId).run();
  return json({ success: true });
}

async function deleteEmployee(request, env, session, orgId, employeeId) {
  const member = await membership(env, orgId, session.id);
  if (!member || !WRITE_ROLES.has(member.role)) return json({ error: 'Read-only access' }, 403);
  const result = await env.DB.prepare('DELETE FROM employer_employees WHERE id = ? AND org_id = ?')
    .bind(employeeId, orgId).run();
  const changed = (result.meta && result.meta.changes) || result.changes || 0;
  if (!changed) return json({ error: 'Not found' }, 404);
  return json({ success: true });
}

export async function handleEmployer(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);
  await ensureEmployerSchema(env.DB);
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  // /api/employer/workspace
  if (parts.length === 3 && parts[2] === 'workspace' && request.method === 'GET') {
    return workspace(request, env, session);
  }
  // /api/employer/orgs
  if (parts.length === 3 && parts[2] === 'orgs' && request.method === 'POST') {
    return createOrg(request, env, session);
  }
  if (parts[2] !== 'orgs' || !parts[3]) return json({ error: 'Not found' }, 404);
  const orgId = decodeURIComponent(parts[3]);
  if (parts.length === 4 && request.method === 'GET') return getOrg(request, env, session, orgId);
  if (parts.length === 5 && parts[4] === 'members' && request.method === 'POST') {
    return addMember(request, env, session, orgId);
  }
  if (parts.length === 6 && parts[4] === 'members' && request.method === 'PATCH') {
    return updateMember(request, env, session, orgId, decodeURIComponent(parts[5]));
  }
  if (parts.length === 6 && parts[4] === 'members' && request.method === 'DELETE') {
    return removeMember(request, env, session, orgId, decodeURIComponent(parts[5]));
  }
  if (parts.length === 5 && parts[4] === 'employees' && request.method === 'POST') {
    return addEmployee(request, env, session, orgId);
  }
  if (parts.length === 6 && parts[4] === 'employees' && request.method === 'PATCH') {
    return updateEmployee(request, env, session, orgId, decodeURIComponent(parts[5]));
  }
  if (parts.length === 6 && parts[4] === 'employees' && request.method === 'DELETE') {
    return deleteEmployee(request, env, session, orgId, decodeURIComponent(parts[5]));
  }
  return json({ error: 'Not found' }, 404);
}
