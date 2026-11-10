/**
 * Advanced Search API
 * Nearest neighbors, fuzzy matching, filters, saved searches
 * Fetches data from deployed site's data files
 */

import { ensureSchema } from '../_router.js';

// Shared cache for decisions data (module-level, survives across requests)
let decisionsCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const OFFICE_FILES = [
  'embassy-new-delhi.json',
  'embassy-beijing.json',
  'embassy-dublin.json',
  'embassy-abu-dhabi.json',
  'embassy-abuja.json',
  'embassy-ankara.json'
];

function normalizeDecision(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'approved' || v === 'granted') return 'Approved';
  if (v === 'refused' || v === 'rejected') return 'Refused';
  return null;
}

function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.replace(/\D/g, '').length < 6) return '';
  if (/NO_FILE|CLOSED|UPLOAD|SATURDAY|SUNDAY|EMBASSY/i.test(raw)) return '';
  return raw;
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeRow(row, fallbackEmbassy, source, reportDate) {
  if (Array.isArray(row)) {
    return {
      date: isoDate(row[0]),
      number: normalizeNumber(row[1]),
      decision: normalizeDecision(row[2]),
      embassy: fallbackEmbassy,
      source,
      report_date: reportDate || null
    };
  }
  if (!row || typeof row !== 'object') return null;
  return {
    ...row,
    date: isoDate(row.date),
    number: normalizeNumber(row.number),
    decision: normalizeDecision(row.decision),
    embassy: row.embassy || fallbackEmbassy,
    source: row.source || source,
    report_date: row.report_date || reportDate || null
  };
}

async function loadJson(env, request, file) {
  const url = new URL(file, request.url);
  try {
    if (env && env.ASSETS) {
      const response = await env.ASSETS.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
      if (response.ok) return await response.json();
      console.warn('ASSETS ' + file + ' -> ' + response.status);
    }
  } catch (error) {
    console.warn('ASSETS fetch failed for ' + file + ': ' + error.message);
  }
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn('Direct fetch failed for ' + file + ': ' + error.message);
  }
  return null;
}

async function loadAllDecisions(request, env) {
  const now = Date.now();
  if (decisionsCache && (now - cacheTimestamp) < CACHE_TTL) {
    return decisionsCache;
  }

  const byKey = new Map();

  const tasks = [
    loadJson(env, request, '/data/visa_decisions.json')
      .then((data) => ({ kind: 'tracker', data }))
      .catch(() => null),
    ...OFFICE_FILES.map((file) =>
      loadJson(env, request, '/data/' + file)
        .then((data) => ({ kind: 'office', file, data }))
        .catch(() => null)
    )
  ];

  const results = (await Promise.all(tasks)).filter(Boolean);

  // Build the report-date map first so tracker rows (which do not carry a
  // report date themselves) can still show New Delhi's latest official date.
  const reportDates = new Map();
  for (const result of results) {
    if (result.kind !== 'office' || !result.data) continue;
    const slug = String(result.data.office || result.file.replace(/^embassy-|\.json$/g, ''));
    reportDates.set(slug, result.data.report_date || result.data.as_of || null);
  }

  for (const result of results) {
    if (result.kind === 'tracker') {
      const rows = Array.isArray(result.data) ? result.data : [];
      for (const row of rows) {
        const normalized = normalizeRow(row, 'new-delhi', 'tracker', reportDates.get('new-delhi') || null);
        if (!normalized || !normalized.number || !normalized.decision || !normalized.date) continue;
        const key = normalized.embassy + '|' + normalized.number;
        const existing = byKey.get(key);
        if (!existing || normalized.date >= existing.date) {
          if (existing && !normalized.report_date) normalized.report_date = existing.report_date;
          byKey.set(key, normalized);
        }
      }
      continue;
    }

    const data = result.data || {};
    const slug = String(data.office || result.file.replace(/^embassy-|\.json$/g, ''));
    const reportDate = data.report_date || data.as_of || null;
    const source = data.data_status === 'official' ? 'official' : 'unverified';
    for (const row of data.decisions || []) {
      const normalized = normalizeRow(row, slug, source, reportDate);
      if (!normalized || !normalized.number || !normalized.decision || !normalized.date) continue;
      const key = normalized.embassy + '|' + normalized.number;
      const existing = byKey.get(key);
      if (!existing || normalized.date >= existing.date) {
        if (existing && !normalized.report_date) normalized.report_date = existing.report_date;
        byKey.set(key, normalized);
      }
    }
  }

  const allDecisions = [...byKey.values()];
  allDecisions.sort((a, b) => new Date(b.date) - new Date(a.date));

  decisionsCache = allDecisions;
  cacheTimestamp = Date.now();
  return allDecisions;
}

// Search endpoint - supports multiple search modes
export async function onRequestPost(context) {
  const { request, env } = context;
  
  try {
    await ensureSchema(env.DB);
    
    const body = await request.json();
    const query = body.query; // Text query for fuzzy matching
    const mode = body.mode || 'hybrid'; // 'fuzzy', 'nearest', 'filter', 'hybrid'

    // Accept both { filters: { embassy } } and the flat fields posted by the
    // advanced-search form. Before this, the office/decision selects were
    // silently ignored by the API.
    const suppliedFilters = body.filters && typeof body.filters === 'object' ? body.filters : {};
    const filters = { ...suppliedFilters };
    for (const key of [
      'embassy', 'visa_type', 'decision', 'country',
      'date_from', 'date_to', 'application_date_from', 'application_date_to'
    ]) {
      if (body[key]) filters[key] = body[key];
    }
    if (body.number_range) filters.number_range = body.number_range;

    // FormData values are strings; parse pagination or `0 + "20"` turns into
    // "020" and the Load more button never reports another page.
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 20));
    const offset = Math.max(0, Number(body.offset) || 0);
    const sort = body.sort || 'date_desc';
    const save_search = body.save_search === true;
    const search_name = body.search_name || '';
    
    // Load all decisions
    const allDecisions = await loadAllDecisions(request, env);
    
    // Build search results based on mode
    let results = [];
    const hasQuery = Boolean(query && query.trim());
    
    if (mode === 'fuzzy' || mode === 'hybrid') {
      if (hasQuery) {
        results = fuzzySearch(allDecisions, query, limit * 2, filters);
      }
    }
    
    if (mode === 'nearest' || mode === 'hybrid') {
      if (hasQuery) {
        const nearestResults = nearestNeighborSearch(allDecisions, query, limit * 2, filters);
        // Merge with fuzzy results, deduplicate
        results = mergeResults(results, nearestResults);
      }
    }
    
    // A filter-only search (or a filter with no query) returns every match so
    // pagination.total is the real number of matches. With a query, the fuzzy
    // and nearest passes already apply the filters; merging every filtered row
    // here would drown the query results in unrelated decisions.
    if (mode === 'filter' || (!hasQuery && Object.keys(filters).length > 0)) {
      results = filterSearch(allDecisions, filters);
    }
    
    // If no query or filters, return latest
    if (!hasQuery && Object.keys(filters).length === 0) {
      results = allDecisions;
    }
    
    // Apply sorting
    results = applySorting(results, sort);
    
    // Get total count for pagination
    const total = results.length;
    
    // Apply pagination
    const paginated = results.slice(offset, offset + limit);
    
    // Save search if requested
    let savedSearchId = null;
    if (save_search && search_name && query) {
      savedSearchId = await saveSearch(env.DB, search_name, { query, mode, filters, sort });
    }
    
    return new Response(JSON.stringify({
      success: true,
      results: paginated,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + limit < total
      },
      saved_search_id: savedSearchId,
      query,
      mode,
      filters,
      sort
    }), { 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300'
      } 
    });
    
  } catch (error) {
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: 'Search failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Fuzzy text search
function fuzzySearch(decisions, query, limit, filters) {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  
  // Apply filters first
  let filtered = applyFilters(decisions, filters);
  
  // Score each decision based on term matches
  const scored = filtered.map(decision => {
    let score = 0;
    const searchableText = [
      decision.number || '',
      decision.decision || '',
      decision.embassy || '',
      decision.visa_type || '',
      decision.country || '',
      decision.application_date || ''
    ].join(' ').toLowerCase();
    
    for (const term of terms) {
      if (searchableText.includes(term)) {
        score += 1;
        // Bonus for exact matches in number
        if (decision.number && decision.number.toLowerCase().includes(term)) score += 2;
        if (decision.decision && decision.decision.toLowerCase().includes(term)) score += 1;
      }
    }
    
    return { ...decision, _search_score: score };
  });
  
  // Sort by score descending, then by date
  return scored
    .filter(d => d._search_score > 0)
    .sort((a, b) => b._search_score - a._search_score || new Date(b.date) - new Date(a.date));
}

// Nearest neighbor search using application number proximity
function nearestNeighborSearch(decisions, query, limit, filters) {
  // Try to extract application number from query
  const appNumMatch = query.match(/(\d{6,})/);
  if (!appNumMatch) return [];
  
  const targetNum = parseInt(appNumMatch[1]);
  const range = 10000; // Search within ±10000
  
  // Apply filters first
  let filtered = applyFilters(decisions, filters);
  
  // Calculate distance for each decision
  const withDistance = filtered.map(decision => {
    // Extract numeric part from number (e.g., "IRL2020123456" -> 2020123456)
    const numMatch = decision.number.match(/(\d{6,})/);
    const num = numMatch ? parseInt(numMatch[1]) : 0;
    const distance = Math.abs(num - targetNum);
    return { ...decision, _distance: distance };
  });
  
  // Sort by distance
  return withDistance
    .filter(d => d._distance <= range)
    .sort((a, b) => a._distance - b._distance);
}

// Filter-based search
function filterSearch(decisions, filters) {
  return applyFilters(decisions, filters);
}

// Apply filters to decisions
function applyFilters(decisions, filters) {
  return decisions.filter(decision => {
    if (filters.embassy && decision.embassy !== filters.embassy) return false;
    if (filters.visa_type && decision.visa_type !== filters.visa_type) return false;
    if (filters.decision && decision.decision !== filters.decision) return false;
    if (filters.country && decision.country !== filters.country) return false;
    
    if (filters.date_from && new Date(decision.date) < new Date(filters.date_from)) return false;
    if (filters.date_to && new Date(decision.date) > new Date(filters.date_to)) return false;
    if (filters.application_date_from && decision.application_date && new Date(decision.application_date) < new Date(filters.application_date_from)) return false;
    if (filters.application_date_to && decision.application_date && new Date(decision.application_date) > new Date(filters.application_date_to)) return false;
    
    if (filters.number_range) {
      const num = parseInt(decision.number) || 0;
      if (num < filters.number_range[0] || num > filters.number_range[1]) return false;
    }
    
    return true;
  });
}

// Merge and deduplicate results
function mergeResults(results1, results2) {
  const seen = new Set();
  const merged = [];
  
  for (const r of [...results1, ...results2]) {
    const key = `${r.date}|${r.number}|${r.embassy}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }
  
  return merged;
}

// Apply sorting
function applySorting(results, sort) {
  const sorted = [...results];
  
  switch (sort) {
    case 'date_asc':
      return sorted.sort((a, b) => new Date(a.date) - new Date(b.date));
    case 'date_desc':
      return sorted.sort((a, b) => new Date(b.date) - new Date(a.date));
    case 'number_asc':
      return sorted.sort((a, b) => parseInt(a.number) - parseInt(b.number));
    case 'number_desc':
      return sorted.sort((a, b) => parseInt(b.number) - parseInt(a.number));
    case 'embassy':
      return sorted.sort((a, b) => a.embassy.localeCompare(b.embassy));
    case 'decision':
      return sorted.sort((a, b) => a.decision.localeCompare(b.decision));
    default:
      return results;
  }
}

// Save search to database
async function saveSearch(db, name, searchParams) {
  const id = crypto.randomUUID();
  await db.prepare(`
    INSERT INTO saved_searches (id, name, params, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).bind(id, name, JSON.stringify(searchParams)).run();
  return id;
}

// GET - Retrieve saved searches
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  try {
    await ensureSchema(env.DB);
    
    const action = url.searchParams.get('action');
    
    if (action === 'list') {
      const stmt = await env.DB.prepare(`
        SELECT id, name, params, created_at
        FROM saved_searches
        ORDER BY created_at DESC
      `).all();
      
      return new Response(JSON.stringify({
        success: true,
        searches: stmt.results || []
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    if (action === 'get' && url.searchParams.get('id')) {
      const id = url.searchParams.get('id');
      const stmt = await env.DB.prepare(`
        SELECT id, name, params, created_at
        FROM saved_searches
        WHERE id = ?
      `).bind(id).first();
      
      return new Response(JSON.stringify({
        success: true,
        search: stmt
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    
    // Return search capabilities
    return new Response(JSON.stringify({
      modes: ['fuzzy', 'nearest', 'filter', 'hybrid'],
      filters: [
        'embassy', 'visa_type', 'decision', 'date_from', 'date_to',
        'application_date_from', 'application_date_to', 'country', 'number_range'
      ],
      sort_options: ['date_desc', 'date_asc', 'number_asc', 'number_desc', 'embassy', 'decision'],
      endpoints: {
        search: 'POST /api/search',
        saved_searches: 'GET /api/search?action=list',
        get_saved: 'GET /api/search?action=get&id=<id>'
      }
    }), { headers: { 'Content-Type': 'application/json' } });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to get search info' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

// DELETE - Delete saved search
export async function onRequestDelete(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  try {
    await ensureSchema(env.DB);
    
    const id = url.searchParams.get('id');
    if (!id) {
      return new Response(JSON.stringify({ error: 'Search ID required' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    
    await env.DB.prepare('DELETE FROM saved_searches WHERE id = ?').bind(id).run();
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to delete search' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet, DELETE: onRequestDelete };