/**
 * Build a compact all-office search index for the degraded search path.
 *
 * The live search API reads the full office archives on the server. That is
 * the right source when it is available, but it leaves the primary task dead
 * during an API outage. This file keeps only the fields needed for
 * an application-number lookup and is small enough to cache in one request.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return '';
  if (/NO_FILE|CLOSED|UPLOAD|SATURDAY|SUNDAY|EMBASSY/i.test(raw)) return '';
  return digits.replace(/^0+/, '');
}

function normalizeDecision(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'approved' || v === 'granted') return 'Approved';
  if (v === 'refused' || v === 'rejected') return 'Refused';
  return '';
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function buildSearchFallback({ dataDir, manifestPath, outFile }) {
  const manifest = readJson(manifestPath);
  let freshness = null;
  try {
    freshness = readJson(path.join(dataDir, 'freshness.json'));
  } catch {
    freshness = null;
  }
  const freshBySlug = new Map(
    ((freshness && freshness.offices) || []).map((office) => [office.slug, office])
  );
  const manifestOffices = new Map(
    ((manifest && manifest.offices) || []).map((office) => [office.slug, office])
  );
  const offices = {};
  const byKey = new Map();

  for (const manifestOffice of manifestOffices.values()) {
    const slug = String(manifestOffice.slug || '').trim();
    if (!slug) continue;
    const file = path.join(dataDir, 'embassy-' + slug + '.json');
    let payload = null;
    try {
      payload = readJson(file);
    } catch {
      continue;
    }
    const meta = { ...manifestOffice, ...payload };
    const fresh = freshBySlug.get(slug) || null;
    offices[slug] = {
      source_url: meta.source_url || '',
      source_file: meta.source_file || '',
      source_name: meta.source_name || '',
      report_date: meta.report_date || '',
      as_of: meta.as_of || '',
      fetched_at: meta.fetched_at || '',
      last_success_at: (fresh && fresh.last_success_at) || meta.fetched_at || meta.as_of || '',
      last_success_label: (fresh && fresh.last_success_label) || '',
      stale: Boolean(fresh && fresh.stale),
      attention: Boolean(fresh && (fresh.stale || fresh.attention)),
      status: (fresh && fresh.status) || meta.status || meta.data_status || '',
      status_label: (fresh && fresh.status_label) || '',
      warning: (fresh && fresh.warning) || '',
      freshness: fresh,
      note: meta.note || ''
    };

    for (const row of payload.decisions || []) {
      if (!row || typeof row !== 'object') continue;
      const number = normalizeNumber(row.number);
      const date = isoDate(row.date);
      const decision = normalizeDecision(row.decision);
      if (!number || !date || !decision) continue;
      const key = slug + '|' + number;
      const existing = byKey.get(key);
      if (!existing || date > existing[2]) byKey.set(key, [slug, number, date, decision]);
    }
  }

  // Columnar form. A row used to repeat the office slug, a full ISO date and
  // the word Approved/Refused, which cost about 48 bytes each. The office is
  // now the key, dates live in one shared table, numbers are stored as
  // ascending deltas and the outcome is a 0/1 flag.
  // Row order is kept exactly as the source files produced it, because the
  // lookup sorts by score and date only: equal hits keep their file order.
  const rows = [...byKey.values()]
    .map(([slug, number, date, decision]) => ({ slug, number, date, decision }));
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const dateIndex = new Map(dates.map((date, index) => [date, index]));
  const series = {};
  let previousSlug = '';
  let previousNumber = 0;
  for (const row of rows) {
    if (!series[row.slug]) {
      series[row.slug] = { number_deltas: [], date_index: [], approved: [] };
      previousNumber = 0;
    }
    const number = Number(row.number);
    series[row.slug].number_deltas.push(previousSlug === row.slug ? number - previousNumber : number);
    series[row.slug].date_index.push(dateIndex.get(row.date));
    series[row.slug].approved.push(row.decision === 'Approved' ? 1 : 0);
    previousSlug = row.slug;
    previousNumber = number;
  }
  // number_deltas[0] is the first number itself; every later entry is that
  // number minus the one before it in the file (it can be negative), so a
  // reader accumulates to recover it.
  const output = {
    generated_at: new Date().toISOString(),
    version: 2,
    dates,
    offices,
    rows: series
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const text = JSON.stringify(output) + '\n';
  fs.writeFileSync(outFile, text);
  return { rows: rows.length, bytes: Buffer.byteLength(text) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = buildSearchFallback({
    dataDir: path.join(root, 'data'),
    manifestPath: path.join(root, 'data', 'data_manifest.json'),
    outFile: path.join(root, 'data', 'search_fallback.json')
  });
  console.log(`Search fallback: ${result.rows} rows, ${(result.bytes / 1024 / 1024).toFixed(2)} MiB`);
}
