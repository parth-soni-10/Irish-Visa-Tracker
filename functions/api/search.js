/**
 * Advanced Search API
 * Nearest neighbors, fuzzy matching and filters
 * Fetches data from deployed site's data files
 */

import { ensureSchema } from '../_router.js';
import { MAX_JSON_BODY_BYTES, readJsonBody } from '../_json-body.js';

// Shared cache for decisions data (module-level, survives across requests)
let decisionsCache = null;
let officesCache = null;
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

const OFFICE_SLUGS = OFFICE_FILES.map((file) => file.replace(/^embassy-|\.json$/g, ''));
const SEARCH_MODES = new Set(['fuzzy', 'nearest', 'filter', 'hybrid']);
const DATE_FILTERS = ['date_from', 'date_to', 'application_date_from', 'application_date_to'];
const DECISION_FILTERS = ['Approved', 'Refused'];
const SORT_OPTIONS = ['relevance', 'date_desc', 'date_asc', 'number_asc', 'number_desc', 'embassy', 'decision'];
// Every filter the query code reads. A response echoes only these keys, so an
// arbitrary caller object never comes back in the body.
const FILTER_KEYS = [
  'embassy', 'visa_type', 'decision', 'date_from', 'date_to',
  'application_date_from', 'application_date_to', 'country', 'number_range'
];
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

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

function normalizeSource(value) {
  return value === 'official' || value === 'unverified' ? value : 'unverified';
}

// Add provenance without changing a row's decision fields. Tracker
// observations are not part of the latest official file, so their report_date
// is deliberately null; the official file date is kept separately.
function decorateResult(row, office) {
  const isTracker = row.source === 'tracker';
  row.source_kind = isTracker ? 'tracker' : 'official';
  row.source = isTracker ? 'tracker' : normalizeSource(row.source);
  row.source_label = isTracker
    ? 'Tracker observation'
    : row.source === 'official' ? 'Official report' : 'Unverified report';
  row.source_url = office.source_url || '';
  row.source_file = isTracker ? null : (office.source_file || null);
  row.source_name = office.source_name || '';
  row.official_report_date = office.report_date || null;
  row.observed_date = isTracker ? row.date : null;
  row.observed_at = isTracker ? row.date : (office.last_success_at || null);
  if (isTracker) row.report_date = null;
  row.last_success_at = office.last_success_at || null;
  row.last_success_label = office.last_success_label || '';
  row.stale = Boolean(office.stale);
  row.office_status = office.status || '';
  row.office_status_label = office.status_label || '';
  row.freshness_status = office.status || '';
  row.freshness_status_label = office.status_label || '';
  row.official_data_through = office.official_data_through || null;
  row.observed_data_through = office.observed_data_through || null;
  row.office_attention = Boolean(office.attention);
  row.office_warning = office.warning || '';
  return row;
}

// The compact index is built from the same office files at deploy time. It
// keeps the fields a lookup needs (office, number, date, decision, report date
// and source) so a cold isolate reads one small file instead of every archive.
// If the index is missing, the full-file path below remains the fallback.
async function loadIndexedDecisions(request, env) {
  const index = await loadJson(env, request, '/data/search_index.json');
  if (!index || !Array.isArray(index.offices) || !Array.isArray(index.rows) || !index.rows.length) {
    return null;
  }
  const [manifest, freshness] = await Promise.all([
    loadJson(env, request, '/data/data_manifest.json'),
    loadJson(env, request, '/data/freshness.json')
  ]);
  if (!manifest || !Array.isArray(manifest.offices)) return null;

  const freshBySlug = Object.create(null);
  for (const office of (freshness && freshness.offices) || []) {
    if (office && office.slug) freshBySlug[office.slug] = office;
  }
  const offices = Object.create(null);
  for (const entry of manifest.offices) {
    if (!entry || !entry.slug) continue;
    const fresh = freshBySlug[entry.slug] || {};
    offices[entry.slug] = {
      slug: entry.slug,
      name: entry.name || '',
      source_url: entry.source_url || '',
      source_file: entry.source_file || '',
      source_name: entry.source_name || '',
      report_date: entry.report_date || fresh.report_date || null,
      official_data_through: fresh.official_data_through || entry.report_date || null,
      observed_data_through: fresh.observed_data_through || null,
      last_success_at: fresh.last_success_at || entry.fetched_at || entry.as_of || null,
      last_success_label: fresh.last_success_label || '',
      stale: Boolean(fresh.stale),
      attention: Boolean(fresh.attention || fresh.status === 'error'),
      status: fresh.status || entry.status || entry.data_status || '',
      status_label: fresh.status_label || '',
      warning: fresh.warning || '',
      freshness: Object.keys(fresh).length ? fresh : null
    };
  }
  if (!Object.keys(offices).length) return null;

  const decisions = [];
  for (const row of index.rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const slug = index.offices[row[0]];
    if (!slug) continue;
    const decision = {
      date: isoDate(row[2]),
      number: String(row[1] || ''),
      decision: row[3] === 'A' ? 'Approved' : row[3] === 'R' ? 'Refused' : null,
      embassy: slug,
      source: row[5] === 2 ? 'tracker' : row[5] === 1 ? 'unverified' : 'official',
      report_date: row[4] || null
    };
    if (!decision.date || !decision.number || !decision.decision) continue;
    decorateResult(decision, offices[slug] || {});
    decisions.push(decision);
  }
  if (!decisions.length) return null;
  decisions.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { decisions, offices };
}

async function loadAllDecisions(request, env) {
  const now = Date.now();
  if (decisionsCache && (now - cacheTimestamp) < CACHE_TTL) {
    return { decisions: decisionsCache, offices: officesCache };
  }

  const indexed = await loadIndexedDecisions(request, env);
  if (indexed) {
    decisionsCache = indexed.decisions;
    officesCache = indexed.offices;
    cacheTimestamp = Date.now();
    return indexed;
  }

  const byKey = new Map();

  const tasks = [
    loadJson(env, request, '/data/visa_decisions.json')
      .then((data) => ({ kind: 'tracker', data }))
      .catch(() => null),
    loadJson(env, request, '/data/freshness.json')
      .then((data) => ({ kind: 'freshness', data }))
      .catch(() => null),
    ...OFFICE_FILES.map((file) =>
      loadJson(env, request, '/data/' + file)
        .then((data) => ({ kind: 'office', file, data }))
        .catch(() => null)
    )
  ];

  const results = (await Promise.all(tasks)).filter(Boolean);
  const freshnessBySlug = Object.create(null);
  for (const result of results) {
    if (result.kind !== 'freshness' || !result.data) continue;
    for (const office of result.data.offices || []) {
      if (office && office.slug) freshnessBySlug[office.slug] = office;
    }
  }

  // Keep the office-level source and check provenance beside the rows. This
  // is also returned as a top-level `offices` map so clients can render a
  // source/check cell without repeating metadata on every result.
  const offices = Object.create(null);
  for (const result of results) {
    if (result.kind !== 'office' || !result.data) continue;
    const data = result.data;
    const slug = String(data.office || result.file.replace(/^embassy-|\.json$/g, ''));
    const fresh = freshnessBySlug[slug] || {};
    const reportDate = data.report_date || data.as_of || null;
    const lastSuccessAt = fresh.last_success_at || data.fetched_at || data.as_of || null;
    offices[slug] = {
      slug,
      name: data.name || data.office_name || '',
      source_url: data.source_url || '',
      source_file: data.source_file || '',
      source_name: data.source_name || '',
      report_date: reportDate,
      official_data_through: fresh.official_data_through || reportDate,
      observed_data_through: fresh.observed_data_through || null,
      last_success_at: lastSuccessAt,
      last_success_label: fresh.last_success_label || '',
      stale: Boolean(fresh.stale),
      attention: Boolean(fresh.attention || fresh.status === 'error'),
      status: fresh.status || data.status || data.data_status || '',
      status_label: fresh.status_label || '',
      warning: fresh.warning || '',
      // Absolute dates and the raw freshness record let browser clients
      // recompute relative age and overdue state instead of trusting a label
      // that was true when the deployment was built.
      freshness: Object.keys(fresh).length ? fresh : null
    };
  }

  for (const result of results) {
    if (result.kind === 'tracker') {
      const rows = Array.isArray(result.data) ? result.data : [];
      for (const row of rows) {
        const normalized = normalizeRow(row, 'new-delhi', 'tracker', null);
        if (!normalized || !normalized.number || !normalized.decision || !normalized.date) continue;
        decorateResult(normalized, offices['new-delhi'] || {});
        const key = normalized.embassy + '|' + normalized.number;
        const existing = byKey.get(key);
        if (!existing || normalized.date >= existing.date) {
          byKey.set(key, normalized);
        }
      }
      continue;
    }

    if (result.kind !== 'office') continue;
    const data = result.data || {};
    const slug = String(data.office || result.file.replace(/^embassy-|\.json$/g, ''));
    const reportDate = data.report_date || data.as_of || null;
    const source = data.data_status === 'official' || data.status === 'official'
      ? 'official'
      : 'unverified';
    for (const row of data.decisions || []) {
      const normalized = normalizeRow(row, slug, source, reportDate);
      if (!normalized || !normalized.number || !normalized.decision || !normalized.date) continue;
      decorateResult(normalized, offices[slug] || {});
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
  officesCache = offices;
  cacheTimestamp = Date.now();
  return { decisions: allDecisions, offices };
}

// Search endpoint - supports multiple search modes
export async function onRequestPost(context) {
  const { request, env } = context;
  
  // A bad filter used to return an empty 200, which reads as "no such
  // decision" instead of "your filter was wrong". Say which value is wrong
  // and what the API accepts.
  const invalid = (message, extra = {}, status = 400) => new Response(JSON.stringify({
    success: false,
    error: message,
    ...extra,
  }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  try {
    await ensureSchema(env.DB);

    const parsedBody = await readJsonBody(request);
    if (parsedBody.tooLarge) {
      return invalid(`Body must be at most ${MAX_JSON_BODY_BYTES} bytes.`, { max_bytes: MAX_JSON_BODY_BYTES }, 413);
    }
    if (parsedBody.invalid) return invalid('Body must be valid JSON.');
    const body = parsedBody.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return invalid('Body must be a JSON object.');
    }
    const query = body.query; // Text query for fuzzy matching
    // A string query is echoed back and split into terms; anything else would
    // be coerced to "[object Object]" and silently match nothing.
    if (query !== undefined && query !== null && typeof query !== 'string') {
      return invalid('query must be a string.');
    }
    if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
      return invalid(`query must be at most ${MAX_QUERY_LENGTH} characters.`, { max_length: MAX_QUERY_LENGTH });
    }
    const mode = body.mode || 'hybrid'; // 'fuzzy', 'nearest', 'filter', 'hybrid'
    const hasQuery = Boolean(query && String(query).trim());

    if (!SEARCH_MODES.has(mode)) {
      return invalid(`Unknown mode "${String(mode).slice(0, 24)}".`, { modes: [...SEARCH_MODES] });
    }

    // Accept both { filters: { embassy } } and the flat fields posted by the
    // advanced-search form. Before this, the office/decision selects were
    // silently ignored by the API.
    const suppliedFilters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)
      ? body.filters : {};
    // Copy only the filters this endpoint reads; echoing an arbitrary caller
    // object back would put unvalidated keys in the response body.
    const filters = {};
    for (const key of FILTER_KEYS) {
      if (suppliedFilters[key] !== undefined && suppliedFilters[key] !== null && suppliedFilters[key] !== '') {
        filters[key] = suppliedFilters[key];
      }
    }
    for (const key of [
      'embassy', 'visa_type', 'decision', 'country',
      'date_from', 'date_to', 'application_date_from', 'application_date_to'
    ]) {
      if (body[key]) filters[key] = body[key];
    }
    if (body.number_range) filters.number_range = body.number_range;
    // The site calls the office select "office" in its own forms; accept that
    // spelling at the API edge so a caller copying the form fields is not
    // silently given results from every office.
    if (body.office && !filters.embassy) filters.embassy = body.office;

    if (filters.embassy && !OFFICE_SLUGS.includes(String(filters.embassy))) {
      return invalid(`Unknown office "${String(filters.embassy).slice(0, 32)}".`, { offices: OFFICE_SLUGS });
    }
    for (const key of DATE_FILTERS) {
      if (!filters[key]) continue;
      if (!/^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.Z+-]+)?$/.test(String(filters[key]).trim())) {
        return invalid(`${key} must be a YYYY-MM-DD date.`);
      }
    }
    if (filters.number_range) {
      const range = filters.number_range;
      const numbers = Array.isArray(range) && range.length === 2 ? range.map(Number) : null;
      if (!numbers || !numbers.every(Number.isFinite) || numbers[0] > numbers[1]) {
        return invalid('number_range must be [from, to] with two numbers and from <= to.');
      }
      filters.number_range = numbers;
    }

    if (filters.decision) {
      // The rows store "Approved" / "Refused"; a form may send any spelling
      // the tracker itself accepts, and an unknown value returned an empty 200.
      const decision = normalizeDecision(filters.decision);
      if (!decision) {
        return invalid(`Unknown decision "${String(filters.decision).slice(0, 24)}".`, { decisions: DECISION_FILTERS });
      }
      filters.decision = decision;
    }

    // FormData values are strings; parse pagination or `0 + "20"` turns into
    // "020" and the Load more button never reports another page.
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(body.offset) || 0);
    // A text query is ranked by relevance unless the caller asks for a
    // specific order; a filter-only request keeps the historical date order.
    const sort = body.sort || (hasQuery ? 'relevance' : 'date_desc');
    // applySorting() falls back to the list as built for an unknown key, which
    // reads as a successful search in arbitrary order. Reject it instead.
    if (!SORT_OPTIONS.includes(sort)) {
      return invalid(`Unknown sort "${String(sort).slice(0, 24)}".`, { sort_options: SORT_OPTIONS });
    }
    
    // Load all decisions and their office-level provenance
    const loaded = await loadAllDecisions(request, env);
    const allDecisions = loaded.decisions;
    const offices = loaded.offices;
    
    // Build search results based on mode
    let results = [];
    
    if (mode === 'fuzzy' || mode === 'hybrid') {
      if (hasQuery) {
        results = fuzzySearch(allDecisions, query, filters);
      }
    }
    
    if (mode === 'nearest' || mode === 'hybrid') {
      if (hasQuery) {
        const nearestResults = nearestNeighborSearch(allDecisions, query, filters);
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
    
    // Apply pagination. Ranking fields are internal-only, so they never reach
    // the response body.
    const paginated = results.slice(offset, offset + limit).map(publicResult);
    
    return new Response(JSON.stringify({
      success: true,
      results: paginated,
      offices,
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + limit < total
      },
      query,
      mode,
      filters,
      sort
    }), { 
      headers: { 
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0'
      } 
    });
    
  } catch (error) {
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: 'Search failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
}

// Field weights decide what "more relevant" means. Matches in a specific field
// (an application number, an office, a visa type) count for more than a match
// in a label every other row also carries, so "approved beijing" puts Beijing
// approvals above newer approvals from another office.
const FIELD_WEIGHTS = Object.freeze({
  number: 4,
  visa_type: 3,
  embassy: 3,
  country: 3,
  decision: 1,
  application_date: 1
});

const SCORED_FIELDS = Object.keys(FIELD_WEIGHTS);

function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

// An application number a visitor types should outrank a text coincidence.
// Exact digits beat a prefix, a prefix beats the digits appearing mid-number,
// and a longer typed prefix beats a shorter one.
function numberScore(number, queryDigits) {
  const digits = digitsOf(number).replace(/^0+/, '');
  const wanted = queryDigits.replace(/^0+/, '');
  if (!digits || wanted.length < 3) return 0;
  if (digits === wanted) return 100;
  if (digits.startsWith(wanted)) {
    return 60 + Math.round(30 * wanted.length / digits.length);
  }
  if (digits.includes(wanted)) return 30;
  return 0;
}

// Fuzzy text search
function fuzzySearch(decisions, query, filters) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  const queryDigits = digitsOf(query);

  // Apply filters first
  const filtered = applyFilters(decisions, filters);

  // Score each decision on field-weighted term hits plus number proximity
  const scored = [];
  for (const decision of filtered) {
    const fields = {
      number: String(decision.number || '').toLowerCase(),
      visa_type: String(decision.visa_type || '').toLowerCase(),
      embassy: String(decision.embassy || '').toLowerCase(),
      country: String(decision.country || '').toLowerCase(),
      decision: String(decision.decision || '').toLowerCase(),
      application_date: String(decision.application_date || '').toLowerCase()
    };

    let score = 0;
    for (const term of terms) {
      for (const field of SCORED_FIELDS) {
        if (fields[field] && fields[field].includes(term)) score += FIELD_WEIGHTS[field];
      }
    }
    score += numberScore(fields.number, queryDigits);

    if (score > 0) scored.push({ ...decision, _search_score: score });
  }

  return scored.sort(relevanceSort);
}

// Nearest neighbor search using application number proximity
// Bounded by the ±range window rather than by the page size, so the pagination
// total stays exact; the old `limit` argument was accepted and never read.
function nearestNeighborSearch(decisions, query, filters) {
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

// Relevance order: scored rows first, then nearest-neighbour rows by distance
// (fuzzy hits carry no distance), then newest, then number.
function relevanceSort(a, b) {
  return ((b._search_score || 0) - (a._search_score || 0)) ||
    (distanceOf(a) - distanceOf(b)) ||
    (new Date(b.date) - new Date(a.date)) ||
    String(a.number || '').localeCompare(String(b.number || ''));
}

function distanceOf(row) {
  return typeof row._distance === 'number' ? row._distance : Infinity;
}

// Drop internal ranking fields so the public row shape is unchanged.
function publicResult(row) {
  if (!row || typeof row !== 'object') return row;
  const { _search_score, _distance, ...rest } = row;
  return rest;
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
    case 'relevance':
      return sorted.sort(relevanceSort);
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

// GET - Return search capabilities
export async function onRequestGet(context) {
  const { env } = context;
  try {
    await ensureSchema(env.DB);
    return new Response(JSON.stringify({
      modes: [...SEARCH_MODES],
      filters: [
        'embassy', 'office', 'visa_type', 'decision', 'date_from', 'date_to',
        'application_date_from', 'application_date_to', 'country', 'number_range'
      ],
      aliases: { office: 'embassy' },
      sort_options: SORT_OPTIONS,
      decisions: DECISION_FILTERS,
      pagination: { limit_default: DEFAULT_LIMIT, limit_max: MAX_LIMIT, offset_min: 0 },
      provenance: [
        'source', 'source_kind', 'source_label', 'source_url', 'source_file',
        'report_date', 'official_report_date', 'observed_date', 'observed_at',
        'last_success_at', 'last_success_label', 'stale', 'office_status', 'office_status_label',
        'freshness_status', 'freshness_status_label', 'office_attention', 'office_warning',
        'source_name', 'official_data_through', 'observed_data_through'
      ],
      endpoints: {
        search: 'POST /api/search'
      }
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Failed to get search info' }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
}

export const onRequest = { POST: onRequestPost, GET: onRequestGet };