/**
 * Report data helpers for the monthly report and weekly change feed.
 *
 * The source files are the same public JSON files the tracker uses. Nothing
 * here is a synthetic estimate: every count comes from a dated decision row.
 */

const OFFICE_FILES = [
  { file: 'embassy-new-delhi.json', slug: 'new-delhi' },
  { file: 'embassy-beijing.json', slug: 'beijing' },
  { file: 'embassy-dublin.json', slug: 'dublin' },
  { file: 'embassy-abu-dhabi.json', slug: 'abu-dhabi' },
  { file: 'embassy-abuja.json', slug: 'abuja' },
  { file: 'embassy-ankara.json', slug: 'ankara' }
];

const CACHE_TTL = 5 * 60 * 1000;
let decisionsCache = null;
let cacheTimestamp = 0;

const FALLBACK_NAMES = {
  'new-delhi': 'New Delhi',
  beijing: 'Beijing',
  dublin: 'Dublin',
  'abu-dhabi': 'Abu Dhabi',
  abuja: 'Abuja',
  ankara: 'Ankara'
};

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function normalizeDecision(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'approved' || v === 'granted') return 'Approved';
  if (v === 'refused' || v === 'rejected') return 'Refused';
  return null;
}

function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/\d{4}/.test(raw)) return '';
  if (/NO_FILE|CLOSED|UPLOAD|SATURDAY|SUNDAY|EMBASSY/i.test(raw)) return '';
  return raw;
}

function addNormalizedRow(map, row) {
  if (!row || !row.number || !row.decision || !row.date || !row.office) return;
  const key = row.office + '|' + row.number;
  const existing = map.get(key);
  if (!existing) {
    map.set(key, row);
    return;
  }
  if (row.priority > existing.priority) {
    map.set(key, row);
    return;
  }
  if (row.priority === existing.priority && row.date >= existing.date) {
    map.set(key, row);
  }
}

async function loadJson(env, request, path) {
  const url = new URL(path, request.url);
  try {
    if (env && env.ASSETS) {
      const response = await env.ASSETS.fetch(new Request(url, { headers: { Accept: 'application/json' } }));
      if (response.ok) return await response.json();
    }
  } catch (error) {
    console.warn('Report asset read failed for ' + path + ': ' + error.message);
  }
  try {
    const response = await fetch(url);
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn('Report fetch failed for ' + path + ': ' + error.message);
  }
  return null;
}

export async function loadReportData(env, request) {
  const now = Date.now();
  if (decisionsCache && now - cacheTimestamp < CACHE_TTL) return decisionsCache;

  const [tracker, manifest, reports, ...officeFiles] = await Promise.all([
    loadJson(env, request, '/data/visa_decisions.json'),
    loadJson(env, request, '/data/data_manifest.json'),
    loadJson(env, request, '/data/reports/index.json'),
    ...OFFICE_FILES.map((office) => loadJson(env, request, '/data/' + office.file))
  ]);

  const map = new Map();

  for (const row of Array.isArray(tracker) ? tracker : []) {
    const date = isoDate(Array.isArray(row) ? row[0] : row && row.date);
    const number = normalizeNumber(Array.isArray(row) ? row[1] : row && row.number);
    const decision = normalizeDecision(Array.isArray(row) ? row[2] : row && row.decision);
    addNormalizedRow(map, {
      date,
      number,
      decision,
      office: 'new-delhi',
      source: 'tracker',
      dated: true,
      report_date: date,
      priority: 2
    });
  }

  OFFICE_FILES.forEach((office, index) => {
    const data = officeFiles[index];
    if (!data || !Array.isArray(data.decisions)) return;
    const slug = data.office || office.slug;
    const reportDate = isoDate(data.report_date || data.as_of);
    for (const row of data.decisions) {
      const date = isoDate(row && row.date) || reportDate;
      const number = normalizeNumber(row && row.number);
      const decision = normalizeDecision(row && row.decision);
      addNormalizedRow(map, {
        date,
        number,
        decision,
        office: slug,
        source: 'official',
        dated: false,
        report_date: reportDate,
        priority: slug === 'new-delhi' ? 0 : 1
      });
    }
  });

  const rows = [...map.values()];
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.number).localeCompare(String(a.number));
  });
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  const latestDate = dates.length ? dates[dates.length - 1] : null;

  const officeList = Array.isArray(manifest && manifest.offices) && manifest.offices.length
    ? manifest.offices.map((office) => ({
        slug: office.slug,
        name: office.name || FALLBACK_NAMES[office.slug] || office.slug,
        status: office.status || 'official',
        report_date: office.report_date || null,
        fetched_at: office.fetched_at || null,
        decisions: office.decisions || 0,
        reported_total: office.decisions || 0,
        reported_approved: office.approved || 0,
        reported_refused: office.refused || 0
      }))
    : Object.keys(FALLBACK_NAMES).map((slug) => ({
        slug,
        name: FALLBACK_NAMES[slug],
        status: 'official',
        report_date: null,
        fetched_at: null,
        decisions: 0
      }));

  decisionsCache = {
    rows,
    officeList,
    manifest: manifest || {},
    reports: reports || { offices: {} },
    latestDate
  };
  cacheTimestamp = Date.now();
  return decisionsCache;
}

function summarize(rows) {
  let approved = 0;
  let refused = 0;
  for (const row of rows) {
    if (row.decision === 'Approved') approved += 1;
    else if (row.decision === 'Refused') refused += 1;
  }
  const total = approved + refused;
  return {
    total,
    approved,
    refused,
    approval_rate: total ? Math.round((approved / total) * 1000) / 10 : 0
  };
}

function shiftMonth(month, delta) {
  const [year, monthNumber] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

function monthLabel(month) {
  const date = new Date(month + '-01T00:00:00Z');
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleString('en-IE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function dateOffset(dateString, days) {
  const date = new Date(dateString + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function percentageChange(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function dailyBreakdown(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.date)) map.set(row.date, { date: row.date, total: 0, approved: 0, refused: 0 });
    const day = map.get(row.date);
    day.total += 1;
    if (row.decision === 'Approved') day.approved += 1;
    if (row.decision === 'Refused') day.refused += 1;
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function buildMonthlyReport(rows, month, officeList = []) {
  const datedRows = rows.filter((row) => row.dated !== false);
  const monthRows = datedRows.filter((row) => row.date.startsWith(month));
  const previousMonth = shiftMonth(month, -1);
  const previousRows = datedRows.filter((row) => row.date.startsWith(previousMonth));
  const current = summarize(monthRows);
  const previous = summarize(previousRows);
  const daily = dailyBreakdown(monthRows);
  const busiest = daily.reduce((best, day) => (!best || day.total >= best.total ? day : best), null);
  const availableMonths = [...new Set(datedRows.map((row) => row.date.slice(0, 7)))].sort().reverse();
  const offices = officeList.map((office) => {
    const officeRows = monthRows.filter((row) => row.office === office.slug);
    return {
      ...office,
      ...summarize(officeRows),
      month,
      reported_total: Number(office.reported_total) || 0,
      reported_approved: Number(office.reported_approved) || 0,
      reported_refused: Number(office.reported_refused) || 0
    };
  });
  const reportedTotals = officeList.reduce((totals, office) => {
    totals.total += Number(office.reported_total) || 0;
    totals.approved += Number(office.reported_approved) || 0;
    totals.refused += Number(office.reported_refused) || 0;
    return totals;
  }, { total: 0, approved: 0, refused: 0 });
  reportedTotals.approval_rate = reportedTotals.total
    ? Math.round((reportedTotals.approved / reportedTotals.total) * 1000) / 10
    : 0;
  const reportedLatestDate = officeList.reduce((latest, office) =>
    office.report_date && (!latest || office.report_date > latest) ? office.report_date : latest, null);

  return {
    month,
    label: monthLabel(month),
    previous_month: previousMonth,
    generated_at: new Date().toISOString(),
    latest_date: datedRows.length ? datedRows[0].date : null,
    totals: current,
    previous_totals: previous,
    reported_totals: reportedTotals,
    reported_latest_date: reportedLatestDate,
    change: {
      total: current.total - previous.total,
      approved: current.approved - previous.approved,
      refused: current.refused - previous.refused,
      total_pct: percentageChange(current.total, previous.total),
      approval_rate: current.approval_rate - previous.approval_rate
    },
    offices,
    daily,
    busiest_day: busiest,
    active_days: daily.length,
    available_months: availableMonths
  };
}

export function buildWeeklyChanges(rows, endDate, officeList = [], reports = {}, days = 7) {
  const windowDays = [7, 14, 30].includes(Number(days)) ? Number(days) : 7;
  const datedRows = rows.filter((row) => row.dated !== false);
  const end = endDate || (datedRows[0] && datedRows[0].date) || new Date().toISOString().slice(0, 10);
  const start = dateOffset(end, -(windowDays - 1));
  const previousEnd = dateOffset(start, -1);
  const previousStart = dateOffset(previousEnd, -(windowDays - 1));
  const currentRows = datedRows.filter((row) => row.date >= start && row.date <= end);
  const previousRows = datedRows.filter((row) => row.date >= previousStart && row.date <= previousEnd);
  const current = summarize(currentRows);
  const previous = summarize(previousRows);
  const daily = dailyBreakdown(currentRows);
  const offices = officeList.map((office) => ({
    ...office,
    ...summarize(currentRows.filter((row) => row.office === office.slug))
  }));

  const recent = currentRows.slice(0, 30).map((row) => ({
    date: row.date,
    number: row.number,
    decision: row.decision,
    office: row.office
  }));

  const officeUpdates = officeList.map((office) => {
    const entries = reports && reports.offices && Array.isArray(reports.offices[office.slug])
      ? reports.offices[office.slug]
      : [];
    const latest = entries[entries.length - 1] || null;
    return {
      slug: office.slug,
      name: office.name,
      status: office.status,
      report_date: latest ? latest.report_date : office.report_date,
      fetched_at: latest ? latest.fetched_at : office.fetched_at,
      source_file: latest ? latest.source_file : null,
      added: latest ? latest.added : null,
      removed: latest ? latest.removed : null,
      corrections: latest ? (latest.changed || []).length : 0,
      is_this_week: Boolean(latest && latest.report_date >= start && latest.report_date <= end)
    };
  });

  const corrections = [];
  for (const [slug, entries] of Object.entries((reports && reports.offices) || {})) {
    for (const entry of entries || []) {
      for (const change of entry.changed || []) {
        corrections.push({
          office: slug,
          report_date: entry.report_date,
          ...change
        });
      }
    }
  }

  const direction = current.total === previous.total
    ? 'unchanged'
    : current.total > previous.total ? 'up' : 'down';
  const absoluteChange = Math.abs(current.total - previous.total);

  return {
    window: { start, end, days: windowDays },
    previous_window: { start: previousStart, end: previousEnd, days: windowDays },
    generated_at: new Date().toISOString(),
    latest_date: datedRows.length ? datedRows[0].date : end,
    totals: current,
    previous_totals: previous,
    change: {
      total: current.total - previous.total,
      approved: current.approved - previous.approved,
      refused: current.refused - previous.refused,
      total_pct: percentageChange(current.total, previous.total)
    },
    headline: current.total + ' dated decision' + (current.total === 1 ? '' : 's') + ' this week, ' +
      direction + (direction === 'unchanged' ? '' : ' ' + absoluteChange) + ' vs the previous week',
    offices,
    daily,
    recent,
    office_updates: officeUpdates,
    corrections
  };
}

export { monthLabel, dateOffset, summarize };
