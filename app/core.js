/* Data, state and maths for the Irish Visa Tracker.
 *
 * Nothing in here touches the DOM. It is the same data the previous app read —
 * the scraper-owned JSON files, unchanged shapes — with the same rules that
 * matter: placeholder notice rows are not applications, official averages
 * exclude the first partial day, and the Stamp 1G projection is the measured
 * least-squares fit rather than an invented estimate.
 *
 * Kept as a module so the render layer can be read on its own: `app.js` asks
 * for numbers, `components.js` turns them into markup.
 */

export const VISA_DATA_URL = 'data/visa_decisions.json';
export const VISA_META_URL = 'data/visa_meta.json';
export const G1_URL = 'data/stamp_1g.json';
export const PERMITS_URL = 'data/work_permits.json';
export const COMMUNITY_URL = 'data/community_timelines.json';

/** The scraper's first complete day; the partial first upload is excluded. */
export const TRACKING_STARTED = '2026-07-13';
export const EXCLUDE_FROM_AVERAGES = '2026-07-12';
export const NO_UPLOAD_MESSAGE = "Visa office hasn't uploaded any sheet until now, check back later, or come back tomorrow";
export const WEEKEND_MESSAGE = 'Saturday/Sunday, Visa Office is closed';
const CACHE_FRESH_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ state -- */

export const KNOWN_TABS = ['home', 'daily', 'past', 'suggest'];
export const KNOWN_TRACKERS = ['home', 'visa', '1g', 'permits'];

const params = new URLSearchParams(location.search);

export const state = {
  tracker: resolveTracker(params),
  tab: KNOWN_TABS.includes(params.get('tab')) ? params.get('tab') : 'home',
  q: (params.get('q') || '').slice(0, 200),
  date: (params.get('date') || '').slice(0, 10),
  admin: params.get('admin') === '1',
  theme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  decisionFilter: 'all',
  groupWeek: false,
  hideWeekends: false,
  alertGap: 14,
  g1Category: '1G',
  permitsCategory: '',
  pastSub: 'overview',
  watchlist: seedWatchlist(params),
  recent: readRecent(),
  primaryTracker: readPrimary(),
  estimatorDate: readStored('stamp1g-apply-date'),
  estimatorMode: readStored('stamp1g-apply-mode') === 'plan' ? 'plan' : 'applied',
  expiry: readStored('stamp1g-expiry'),
  decidedBefore: false,
};

function resolveTracker(search) {
  const tracker = search.get('tracker');
  if (tracker && KNOWN_TRACKERS.includes(tracker)) return tracker;
  // Old shared links carry only ?tab=…; those belong to the embassy tracker.
  if (KNOWN_TABS.includes(search.get('tab'))) return 'visa';
  return 'home';
}

/** Replace the query string without a history entry — search/date keystrokes. */
export function syncUrl(mode = 'replace') {
  const next = new URLSearchParams();
  if (state.tracker === 'visa') {
    next.set('tracker', 'visa');
    next.set('tab', state.tab);
    if (state.q) next.set('q', state.q);
    if (state.date) next.set('date', state.date);
  } else if (state.tracker === '1g' || state.tracker === 'permits') {
    next.set('tracker', state.tracker);
  }
  if (state.admin) next.set('admin', '1');
  const qs = next.toString();
  history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', location.pathname + (qs ? '?' + qs : ''));
}

/* ------------------------------------------------------------ localStorage -- */

function readStored(key) {
  try { return (localStorage.getItem(key) || '').slice(0, 10); } catch (e) { return ''; }
}
function readWatchlist() {
  try {
    const raw = JSON.parse(localStorage.getItem('visa-watchlist') || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string' && x).slice(0, 10) : [];
  } catch (e) { return []; }
}

/**
 * `?watch=<numbers>` seeds the watchlist from a link.
 *
 * The list normally lives in localStorage, which a link cannot reach — so a
 * shared "here is what I am following" view and an automated check of the rows
 * that only exist once something is watched both had nothing to start from.
 * Existing keys are untouched: the parameter is merged, capped at ten.
 */
function seedWatchlist(search) {
  const saved = readWatchlist();
  const seeded = (search.get('watch') || '')
    .split(',')
    .map((term) => term.replace(/\s+/g, ''))
    .filter((term) => /^\d{4,12}$/.test(term));
  if (!seeded.length) return saved;
  return [...new Set([...seeded, ...saved])].slice(0, 10);
}
export function saveWatchlist(list) {
  state.watchlist = list.slice(0, 10);
  try { localStorage.setItem('visa-watchlist', JSON.stringify(state.watchlist)); } catch (e) { /* private mode */ }
}
function readRecent() {
  try {
    const raw = JSON.parse(localStorage.getItem('visa-recent-searches') || '[]');
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').slice(0, 5) : [];
  } catch (e) { return []; }
}
export function saveRecentSearch(term) {
  const norm = String(term || '').replace(/\s+/g, '').toUpperCase();
  if (!norm) return;
  state.recent = [norm, ...state.recent.filter((x) => x !== norm)].slice(0, 5);
  try { localStorage.setItem('visa-recent-searches', JSON.stringify(state.recent)); } catch (e) { /* private mode */ }
}
function readPrimary() {
  try {
    const value = localStorage.getItem('visa-primary-tracker');
    return ['visa', '1g', 'permits'].includes(value) ? value : 'visa';
  } catch (e) { return 'visa'; }
}
export function savePrimary(id) {
  state.primaryTracker = id;
  try { localStorage.setItem('visa-primary-tracker', id); } catch (e) { /* private mode */ }
}
export function storeValue(key, value) {
  try { value ? localStorage.setItem(key, value) : localStorage.removeItem(key); } catch (e) { /* private mode */ }
  if (key === 'stamp1g-apply-date') state.estimatorDate = value;
  if (key === 'stamp1g-apply-mode') state.estimatorMode = value === 'plan' ? 'plan' : 'applied';
  if (key === 'stamp1g-expiry') state.expiry = value;
}

/* ------------------------------------------------------------------ format -- */

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const pctFmt = new Intl.NumberFormat('en-GB', { style: 'percent', maximumFractionDigits: 1 });
export const fmtPct = (n) => (Number.isFinite(n) ? pctFmt.format(n) : '—');
const numFmt = new Intl.NumberFormat('en-GB');
export const fmtNum = (n) => (Number.isFinite(n) ? numFmt.format(n) : '—');
export const fmtSigned = (n) => (Number.isFinite(n) && n !== 0 ? (n > 0 ? '+' : '−') + numFmt.format(Math.abs(n)) : '0');

export function parseISO(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}
export function fmtDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '—';
  return parseISO(iso).toLocaleDateString('en-GB', { ...opts, timeZone: 'UTC' });
}
export const fmtShort = (iso) => (iso ? fmtDate(iso, { day: 'numeric', month: 'short' }) : '—');
export const fmtLong = (iso) => (iso ? fmtDate(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '—');
export function weekdayShort(iso) { return parseISO(iso).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }); }

export function istNow() {
  // IST is UTC+5:30; shifting the clock makes toISOString read as IST wall time.
  return new Date(Date.now() + 330 * 60000);
}
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function shiftISO(iso, days) {
  return new Date(parseISO(iso).getTime() + days * 86400000).toISOString().slice(0, 10);
}
export const dayNumber = (iso) => parseISO(iso).getTime() / 86400000;

/* -------------------------------------------------------------------- rows -- */

export function classify(decision) {
  const s = String(decision || '').toLowerCase();
  if (/(approv|grant|accept|issu)/.test(s)) return 'accepted';
  if (/(refus|reject|deny|denied)/.test(s)) return 'rejected';
  return 'other';
}

/** A notice row for a day the office published nothing — not an application. */
export function isPlaceholder(r) {
  const irl = String(r.irl || '').trim();
  const decision = String(r.decision || '').trim();
  if (irl.startsWith('NO_FILE_')) return true;
  if (decision === NO_UPLOAD_MESSAGE || decision === WEEKEND_MESSAGE) return true;
  return decision.startsWith('Embassy is closed');
}

export const realRows = (rows) => (rows || []).filter((r) => !r.placeholder);
export const decisionLabel = (r) => (r.placeholder ? 'Notice' : r.decision || '—');
export const decisionTone = (r) => (r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'bad' : 'warn');

export function normalizeRows(raw) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((r) => (Array.isArray(r) ? { date: r[0], irl: r[1], decision: r[2] } : r))
    .filter((r) => r && r.date)
    .map((r) => {
      const row = { date: String(r.date).slice(0, 10), irl: String(r.irl ?? ''), decision: String(r.decision ?? '') };
      row.status = classify(row.decision);
      row.placeholder = isPlaceholder(row);
      return row;
    });
  list.sort((a, b) => b.date.localeCompare(a.date) || String(a.irl).localeCompare(String(b.irl)));
  return list;
}

export const data = {
  rows: [],
  meta: null,
  g1: [],
  permits: [],
  community: [],
  fetchedAt: 0,
  staleAt: 0,
  loaded: false,
};

let rowsPromise = null;

export async function loadVisa({ force = false } = {}) {
  if (!force && data.loaded && Date.now() - data.fetchedAt < CACHE_FRESH_MS) return data.rows;
  if (rowsPromise) return rowsPromise;
  rowsPromise = (async () => {
    try {
      const res = await fetch(VISA_DATA_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) throw new Error('bad payload');
      data.rows = normalizeRows(raw);
      data.fetchedAt = Date.now();
      data.staleAt = 0;
      persistSnapshot(raw);
    } catch (error) {
      console.warn('visa data fetch failed:', error);
      const snap = await restoreSnapshot();
      if (snap) {
        data.rows = normalizeRows(snap.rows);
        data.fetchedAt = snap.fetchedAt;
        data.staleAt = snap.fetchedAt;
      } else if (!data.rows.length) {
        data.rows = [];
        data.staleAt = 0;
      }
    } finally {
      data.loaded = true;
      rowsPromise = null;
    }
    return data.rows;
  })();
  return rowsPromise;
}

/* Last-known-good snapshot, gzipped with the platform's CompressionStream: the
 * history file is ~2 MB and grows daily, so a plain localStorage copy would
 * brush the ~5 MB quota and then fail silently for ever. */
const SNAPSHOT_GZ_KEY = 'visa-cache-gz';
const SNAPSHOT_PLAIN_KEY = 'visa-cache';

async function persistSnapshot(raw) {
  const json = JSON.stringify({ fetchedAt: Date.now(), rows: raw });
  try {
    if (typeof CompressionStream !== 'undefined') {
      const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
      localStorage.setItem(SNAPSHOT_GZ_KEY, bytesToBase64(new Uint8Array(buf)));
      localStorage.removeItem(SNAPSHOT_PLAIN_KEY);
    } else {
      localStorage.setItem(SNAPSHOT_PLAIN_KEY, json);
    }
  } catch (error) {
    console.warn('snapshot not stored — keeping the previous copy:', error);
  }
}

async function restoreSnapshot() {
  try {
    const gz = localStorage.getItem(SNAPSHOT_GZ_KEY);
    if (gz) {
      const text = await new Response(new Blob([base64ToBytes(gz)]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
      const snap = JSON.parse(text);
      if (snap && Array.isArray(snap.rows) && snap.rows.length) return snap;
    }
  } catch (e) { /* corrupted — fall through */ }
  try {
    const snap = JSON.parse(localStorage.getItem(SNAPSHOT_PLAIN_KEY) || 'null');
    if (snap && Array.isArray(snap.rows) && snap.rows.length) return snap;
  } catch (e) { /* corrupted */ }
  return null;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function loadMeta() {
  try {
    const res = await fetch(VISA_META_URL, { cache: 'no-store' });
    if (res.ok) {
      const meta = await res.json();
      if (meta && typeof meta === 'object' && meta.lastRunAt) data.meta = meta;
    }
  } catch (e) { /* health card stays hidden */ }
  return data.meta;
}

async function loadSeries(url, fallbackCategory) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return (Array.isArray(raw) ? raw : [])
      .filter((r) => r && r.run_date && r.processing_date)
      .map((r) => ({
        runDate: String(r.run_date).slice(0, 10),
        processingDate: String(r.processing_date).slice(0, 10),
        category: String(r.category || fallbackCategory),
        lagDays: Number(r.lag_days) || 0,
        lagWeeks: Number(r.lag_weeks) || 0,
      }))
      .sort((a, b) => a.runDate.localeCompare(b.runDate));
  } catch (error) {
    console.warn(`${url} failed:`, error);
    return [];
  }
}

export async function loadTrackers() {
  const [g1, permits, community] = await Promise.all([
    data.g1.length ? data.g1 : loadSeries(G1_URL, '1G'),
    data.permits.length ? data.permits : loadSeries(PERMITS_URL, 'Unknown'),
    data.community.length ? data.community : loadCommunity(),
  ]);
  data.g1 = g1;
  data.permits = permits;
  data.community = community;
  return data;
}

async function loadCommunity() {
  try {
    const res = await fetch(COMMUNITY_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}

/* ------------------------------------------------------------- statistics -- */

export function groupByDate(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.date)) map.set(row.date, []);
    map.get(row.date).push(row);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

export function visaStats(rows) {
  const real = realRows(rows);
  const accepted = real.filter((r) => r.status === 'accepted').length;
  const rejected = real.filter((r) => r.status === 'rejected').length;
  const byDate = groupByDate(rows);
  const realDays = byDate.filter(([, list]) => realRows(list).length && list[0]?.date !== EXCLUDE_FROM_AVERAGES);
  const sum = realDays.reduce((total, [, list]) => total + realRows(list).length, 0);
  const latestReal = byDate.find(([, list]) => realRows(list).length);
  const latestIndex = latestReal ? byDate.indexOf(latestReal) : -1;
  const prevReal = latestIndex >= 0 ? byDate.slice(latestIndex + 1).find(([, list]) => realRows(list).length) : null;
  const latestCount = latestReal ? realRows(latestReal[1]).length : 0;
  const busiest = byDate.reduce((best, entry) => (!best || realRows(entry[1]).length > realRows(best[1]).length ? entry : best), null);
  return {
    total: real.length,
    accepted,
    rejected,
    acceptanceRate: real.length ? accepted / real.length : 0,
    rejectionRate: real.length ? rejected / real.length : 0,
    avgPerDay: realDays.length ? sum / realDays.length : 0,
    byDate,
    days: byDate.length,
    latestDate: latestReal ? latestReal[0] : null,
    latestCount,
    dayDiff: prevReal ? latestCount - realRows(prevReal[1]).length : null,
    prevDate: prevReal ? prevReal[0] : null,
    busiestDate: busiest ? busiest[0] : null,
    busiestCount: busiest ? realRows(busiest[1]).length : 0,
    placeholderDay: byDate.length && !realRows(byDate[0][1]).length ? byDate[0][0] : null,
  };
}

/** Publish-time status line, in IST, exactly as the office publishes. */
export function publishStatus(rows) {
  const ist = istNow();
  const date = ist.toISOString().slice(0, 10);
  const time = ist.toISOString().slice(11, 16);
  const weekday = ist.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { tone: 'quiet', text: `Embassy closed today (${fmtLong(date)}). The next file is expected Monday after 11:00 AM IST.` };
  }
  const todayRows = realRows(rows).filter((r) => r.date === date);
  if (todayRows.length) {
    return { tone: 'live', text: `Today's file: published, ${todayRows.length} decision${todayRows.length === 1 ? '' : 's'} recorded today.` };
  }
  if (time < '11:00') return { tone: 'quiet', text: `Today's file: expected at 11:00 AM IST (now ${time} IST).` };
  return { tone: 'late', text: `Today's file: not published yet. It usually appears by 11:00 AM IST; check back after 11:15.` };
}

/** Decisions that landed since the visitor's previous visit. */
export function sinceLastVisit(rows, lastVisitAt) {
  if (!lastVisitAt) return null;
  const cutoff = new Date(lastVisitAt);
  const cutoffISO = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`;
  const fresh = realRows(rows).filter((r) => r.date > cutoffISO);
  if (!fresh.length) return null;
  return {
    count: fresh.length,
    refused: fresh.filter((r) => r.status === 'rejected').length,
    when: cutoff.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  };
}

/** Mean applications per published day, grouping consecutive days into weeks. */
export function dailySeries(rows, { groupWeek = false, hideWeekends = false } = {}) {
  const byDate = groupByDate(rows).filter(([, list]) => realRows(list).length);
  const points = [];
  const seen = new Map();
  for (const [date, list] of byDate.reverse()) {
    const weekday = parseISO(date).getUTCDay();
    if (hideWeekends && (weekday === 0 || weekday === 6)) continue;
    const count = realRows(list).length;
    const key = groupWeek ? weekKey(date) : date;
    if (groupWeek && seen.has(key)) {
      const point = seen.get(key);
      point.value += count;
      point.days += 1;
      continue;
    }
    const point = { date: key, value: count, days: 1 };
    seen.set(key, point);
    points.push(point);
  }
  return points;
}

export function weekKey(iso) {
  const d = parseISO(iso);
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
  return monday.toISOString().slice(0, 10);
}

/** 14 whole weeks ending this week, Monday-first, with per-day counts. */
export function heatmap(rows, weeks = 14) {
  const counts = new Map();
  for (const row of realRows(rows)) counts.set(row.date, (counts.get(row.date) || 0) + 1);
  const end = parseISO(todayISO());
  const endMonday = new Date(end.getTime() - ((end.getUTCDay() + 6) % 7) * 86400000);
  const start = new Date(endMonday.getTime() - (weeks - 1) * 7 * 86400000);
  const cells = [];
  let max = 0;
  for (let i = 0; i < weeks * 7; i += 1) {
    const iso = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    const count = counts.get(iso) || 0;
    if (count > max) max = count;
    cells.push({ date: iso, count });
  }
  return {
    cells: cells.map((cell) => ({ ...cell, level: cell.count === 0 ? 0 : Math.min(4, Math.ceil((cell.count / (max || 1)) * 4)) })),
    max,
    weeks,
    start: start.toISOString().slice(0, 10),
    end: cells[cells.length - 1].date,
  };
}

/** Least squares of processing date against observation date. */
export function linearFit(points) {
  const n = points.length;
  if (n < 2) return null;
  const sx = points.reduce((t, p) => t + p.x, 0);
  const sy = points.reduce((t, p) => t + p.y, 0);
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * Processing-date projections: the slope is ISD days advanced per calendar day.
 * Overall = every observation; recent = the last ten, which is what the ETA
 * uses because a queue that just stalled should not be described by its
 * six-month average.
 */
export function projections(rows) {
  if (!rows.length) return { ok: false, count: 0 };
  const last = rows[rows.length - 1];
  if (rows.length < 2) {
    const remaining = dayNumber(todayISO()) - dayNumber(last.processingDate);
    const eta = Math.max(0, Math.ceil(remaining));
    return { ok: true, fallback: true, count: 1, latest: last, first: last, rateWeek: 7, recentWeek: 7, remaining, etaDays: eta, etaDate: shiftISO(todayISO(), eta), lagDelta: 0, ahead: [14, 28, 56, 84].map((d) => ({ days: d, date: shiftISO(last.processingDate, d) })) };
  }
  const points = rows.map((r) => ({ x: dayNumber(r.runDate), y: dayNumber(r.processingDate) }));
  const all = linearFit(points);
  const recent = linearFit(points.slice(-Math.min(10, points.length))) || all;
  if (!all || !recent) return { ok: false, count: rows.length };
  const remaining = dayNumber(todayISO()) - dayNumber(last.processingDate);
  const etaDays = recent.slope > 0.005 ? Math.max(0, Math.ceil(remaining / recent.slope)) : null;
  return {
    ok: true,
    count: rows.length,
    first: rows[0],
    latest: last,
    rateWeek: all.slope * 7,
    recentWeek: recent.slope * 7,
    remaining,
    etaDays,
    etaDate: etaDays === null ? null : shiftISO(todayISO(), etaDays),
    lagDelta: last.lagDays - rows[0].lagDays,
    ahead: [14, 28, 56, 84].map((d) => ({ days: d, date: shiftISO(last.processingDate, Math.round(recent.slope * d)) })),
  };
}

/** Weekly mean lag — bins absorb the day-to-day sawtooth without interpolating gaps. */
export function lagByWeek(rows) {
  const bins = new Map();
  for (const row of rows) {
    const key = weekKey(row.runDate);
    const bin = bins.get(key) || { date: key, sum: 0, n: 0 };
    bin.sum += row.lagDays;
    bin.n += 1;
    bins.set(key, bin);
  }
  return [...bins.values()].map((bin) => ({ date: bin.date, value: bin.sum / bin.n })).sort((a, b) => a.date.localeCompare(b.date));
}

export function categories(rows) {
  const seen = [];
  for (const row of rows) if (!seen.includes(row.category)) seen.push(row.category);
  return seen;
}

/** Personal estimator: their date + the current measured lag. */
export function estimate(rows, date, mode) {
  if (!rows.length) return { state: 'no-data' };
  const latest = rows[rows.length - 1];
  if (!date) return { state: 'empty', latest };
  const tentative = shiftISO(date, latest.lagDays);
  return {
    state: date <= latest.processingDate ? 'past' : 'ok',
    latest,
    mode,
    tentative,
    inDays: Math.round(dayNumber(tentative) - dayNumber(todayISO())),
  };
}

/** Renewal window opens 12 weeks (84 days) before the IRP expiry date. */
export function irpWindow(expiry, today = todayISO()) {
  if (!expiry) return '';
  const left = Math.round((parseISO(expiry) - parseISO(today)) / 86400000);
  if (left < 0) return `Expired ${Math.abs(left)} days ago — renew now if you haven't.`;
  if (left <= 84) return `The 12-week window is open — apply now (${left} days left).`;
  return `The 12-week window opens ${fmtDate(shiftISO(expiry, -84))} (${left} days left).`;
}

export function communityStats(rows, tracker) {
  const waits = (rows || [])
    .filter((r) => r && r.tracker === tracker)
    .map((r) => {
      const a = Date.parse(r.applied);
      const b = Date.parse(r.decided);
      return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 86400000 : null;
    })
    .filter((v) => v !== null)
    .sort((a, b) => a - b);
  if (!waits.length) return null;
  const mid = Math.floor(waits.length / 2);
  return { n: waits.length, median: waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2 };
}

/* --------------------------------------------------------------------- CSV -- */

export function toCsv(rows, columns) {
  const escapeCell = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.map((c) => escapeCell(c.label)).join(',')]
    .concat(rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(',')))
    .join('\n');
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
