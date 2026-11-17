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
    offices[slug] = {
      source_url: meta.source_url || '',
      source_file: meta.source_file || '',
      source_name: meta.source_name || '',
      report_date: meta.report_date || '',
      as_of: meta.as_of || '',
      fetched_at: meta.fetched_at || '',
      status: meta.status || meta.data_status || '',
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

  const rows = [...byKey.values()];
  const output = {
    generated_at: new Date().toISOString(),
    offices,
    rows
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output) + '\n');
  return { rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(output)) };
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
