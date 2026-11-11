/**
 * Analytics depth for the workspace.
 *
 * Kept as pure functions over the already-normalised report rows so the
 * dashboard and tests do not need a database or a browser. Forecasts are
 * explicitly labelled projections, not official processing promises.
 */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value, places = 0) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function summarize(rows) {
  let approved = 0;
  let refused = 0;
  for (const row of rows || []) {
    if (row.decision === 'Approved') approved += 1;
    else if (row.decision === 'Refused') refused += 1;
  }
  const total = approved + refused;
  return {
    total,
    approved,
    refused,
    approval_rate: total ? round((approved / total) * 100, 1) : 0
  };
}

function addDays(dateString, days) {
  const date = new Date(String(dateString).slice(0, 10) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function weekdayOf(dateString) {
  return new Date(String(dateString).slice(0, 10) + 'T00:00:00Z').getUTCDay();
}

function monthKey(dateString) {
  return String(dateString || '').slice(0, 7);
}

function filterRows(rows, options = {}) {
  const office = options.office && options.office !== 'all' ? String(options.office) : '';
  const from = String(options.from || '').slice(0, 10);
  const to = String(options.to || '').slice(0, 10);
  return (rows || []).filter((row) => {
    if (!row || !row.number || !row.date || !row.decision) return false;
    if (office && row.office !== office) return false;
    if (from && row.date < from) return false;
    if (to && row.date > to) return false;
    return true;
  });
}

function dailySeries(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.date)) {
      map.set(row.date, { date: row.date, total: 0, approved: 0, refused: 0, offices: {} });
    }
    const day = map.get(row.date);
    day.total += 1;
    if (row.decision === 'Approved') day.approved += 1;
    if (row.decision === 'Refused') day.refused += 1;
    day.offices[row.office] = (day.offices[row.office] || 0) + 1;
  }
  return [...map.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      approval_rate: day.total ? round((day.approved / day.total) * 100, 1) : 0
    }));
}

function monthlySeries(rows) {
  const map = new Map();
  for (const row of rows) {
    const month = monthKey(row.date);
    if (!month) continue;
    if (!map.has(month)) map.set(month, { month, total: 0, approved: 0, refused: 0 });
    const item = map.get(month);
    item.total += 1;
    if (row.decision === 'Approved') item.approved += 1;
    if (row.decision === 'Refused') item.refused += 1;
  }
  return [...map.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((item) => ({
      ...item,
      approval_rate: item.total ? round((item.approved / item.total) * 100, 1) : 0
    }));
}

function dayCountsMap(daily) {
  return new Map(daily.map((day) => [day.date, day.total]));
}

function buildForecast(daily, horizon = 14) {
  if (daily.length < 7) {
    return {
      available: false,
      method: 'not enough dated history',
      horizon_days: horizon,
      points: []
    };
  }
  const window = daily.slice(-28);
  const xs = window.map((_, index) => index);
  const ys = window.map((day) => day.total);
  const meanX = sum(xs) / xs.length;
  const meanY = sum(ys) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < xs.length; i++) {
    numerator += (xs[i] - meanX) * (ys[i] - meanY);
    denominator += (xs[i] - meanX) ** 2;
  }
  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  const residuals = window.map((day, index) => day.total - (intercept + slope * index));
  const sigma = Math.sqrt(sum(residuals.map((value) => value ** 2)) / Math.max(1, residuals.length - 2));
  const weekdayTotals = Array.from({ length: 7 }, () => ({ count: 0, days: 0 }));
  for (const day of daily.slice(-84)) {
    const slot = weekdayTotals[weekdayOf(day.date)];
    slot.count += day.total;
    slot.days += 1;
  }
  const factors = weekdayTotals.map((slot) => {
    if (!slot.days || !meanY) return 1;
    return Math.max(0.35, Math.min(2.5, (slot.count / slot.days) / meanY));
  });

  const lastDate = daily[daily.length - 1].date;
  const points = [];
  for (let step = 1; step <= horizon; step++) {
    const date = addDays(lastDate, step);
    const raw = intercept + slope * (window.length - 1 + step);
    const predicted = Math.max(0, raw * factors[weekdayOf(date)]);
    points.push({
      date,
      weekday: WEEKDAYS[weekdayOf(date)],
      total: Math.max(0, Math.round(predicted)),
      lower: Math.max(0, Math.round(predicted - 1.5 * sigma)),
      upper: Math.max(0, Math.round(predicted + 1.5 * sigma))
    });
  }
  return {
    available: true,
    method: 'least-squares trend with weekday adjustment',
    horizon_days: horizon,
    slope_per_day: round(slope, 2),
    sigma: round(sigma, 2),
    history_days: window.length,
    points
  };
}

function buildAnomalies(daily) {
  const anomalies = [];
  for (let i = 7; i < daily.length; i++) {
    const previous = daily.slice(Math.max(0, i - 14), i).map((day) => day.total);
    const mean = sum(previous) / previous.length;
    const variance = sum(previous.map((value) => (value - mean) ** 2)) / previous.length;
    const std = Math.sqrt(variance);
    if (!std) continue;
    const z = (daily[i].total - mean) / std;
    if (Math.abs(z) >= 2) {
      anomalies.push({
        date: daily[i].date,
        total: daily[i].total,
        expected: round(mean, 1),
        z_score: round(z, 2),
        direction: z > 0 ? 'spike' : 'drop',
        severity: Math.abs(z) >= 3 ? 'high' : 'medium'
      });
    }
  }
  return anomalies.slice(-12).reverse();
}

function buildHeatmap(rows) {
  const offices = [...new Set(rows.map((row) => row.office).filter(Boolean))].sort();
  return {
    weekdays: WEEKDAYS,
    max: Math.max(0, ...offices.map((office) => {
      const counts = rows.filter((row) => row.office === office).map((row) => row.date);
      return counts.length;
    })),
    offices: offices.map((office) => {
      const cells = WEEKDAYS.map((label, weekday) => {
        const matching = rows.filter((row) => row.office === office && weekdayOf(row.date) === weekday);
        const stats = summarize(matching);
        return {
          weekday,
          label,
          total: stats.total,
          approval_rate: stats.approval_rate
        };
      });
      return {
        office,
        total: sum(cells.map((cell) => cell.total)),
        cells
      };
    })
  };
}

function buildCohorts(rows) {
  const map = new Map();
  for (const row of rows) {
    const cohort = monthKey(row.date);
    if (!cohort) continue;
    if (!map.has(cohort)) map.set(cohort, []);
    map.get(cohort).push(row);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-18)
    .map(([cohort, cohortRows]) => {
      const stats = summarize(cohortRows);
      const offices = {};
      for (const row of cohortRows) offices[row.office] = (offices[row.office] || 0) + 1;
      return {
        cohort,
        ...stats,
        offices
      };
    });
}

function buildDrilldown(rows, options) {
  const date = String(options.date || '').slice(0, 10);
  const month = String(options.month || '').slice(0, 7);
  let selected = rows;
  if (date) selected = selected.filter((row) => row.date === date);
  if (month) selected = selected.filter((row) => row.date.startsWith(month));
  return selected
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || String(b.number).localeCompare(String(a.number)))
    .slice(0, 250)
    .map((row) => ({
      date: row.date,
      number: row.number,
      decision: row.decision,
      office: row.office,
      source: row.source,
      report_date: row.report_date
    }));
}

export function buildAnalytics(rows, options = {}) {
  const filtered = filterRows(rows, options);
  const dated = filtered.filter((row) => row.dated !== false);
  const daily = dailySeries(filtered);
  const monthly = monthlySeries(filtered);
  const stats = summarize(filtered);
  const latest = daily.length ? daily[daily.length - 1].date : null;
  return {
    generated_at: new Date().toISOString(),
    filter: {
      office: options.office || 'all',
      from: options.from || null,
      to: options.to || null,
      date: options.date || null,
      month: options.month || null
    },
    summary: stats,
    latest_date: latest,
    offices: [...new Set(filtered.map((row) => row.office).filter(Boolean))].sort(),
    monthly,
    daily: daily.slice(-120),
    forecast: buildForecast(daily, Math.min(30, Math.max(7, Number(options.horizon) || 14))),
    anomalies: buildAnomalies(daily),
    heatmap: buildHeatmap(filtered),
    cohorts: buildCohorts(dated),
    drilldown: buildDrilldown(filtered, options),
    count: filtered.length
  };
}
