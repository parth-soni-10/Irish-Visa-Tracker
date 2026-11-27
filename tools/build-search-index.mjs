#!/usr/bin/env node
/**
 * Build the compact index the search API scores against.
 *
 * The API used to fetch all six office files plus the New Delhi tracker on
 * every cold isolate (about 13.6 MB) before it could answer one number. This
 * index keeps only the fields a lookup needs, so a cold search reads a few
 * hundred KB instead. Provenance stays explicit: tracker observations are a
 * different source code from official report rows.
 *
 *   node tools/build-search-index.mjs --write
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'search_index.json');

const SOURCE_OFFICIAL = 0;
const SOURCE_UNVERIFIED = 1;
const SOURCE_TRACKER = 2;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function digits(value) {
  return String(value == null ? '' : value).replace(/\D/g, '').replace(/^0+/, '');
}

function normalizeNumber(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const only = digits(raw);
  if (only.length < 6) return '';
  if (/NO_FILE|CLOSED|UPLOAD|SATURDAY|SUNDAY|EMBASSY/i.test(raw)) return '';
  return only;
}

function normalizeDecision(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'approved' || v === 'granted') return 'A';
  if (v === 'refused' || v === 'rejected') return 'R';
  return '';
}

function isoDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

export function buildSearchIndex({ root = ROOT, outFile = OUT } = {}) {
  const dataDir = path.join(root, 'data');
  const manifest = readJson(path.join(dataDir, 'data_manifest.json'), {}) || {};
  const officeList = (Array.isArray(manifest.offices) ? manifest.offices : [])
    .map((office) => String(office && office.slug || ''))
    .filter(Boolean);
  const byKey = new Map();

  function addRow(slug, number, date, decision, reportDate, source) {
    const key = slug + '|' + number;
    const row = [slug, number, date, decision, reportDate || '', source];
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      return;
    }
    // A newer decision for the same number wins; on the same date the
    // official report wins over a tracker observation.
    if (date > existing[2] || (date === existing[2] && source < existing[5])) {
      byKey.set(key, row);
    }
  }

  for (const slug of officeList) {
    const office = readJson(path.join(dataDir, 'embassy-' + slug + '.json'));
    if (!office || !Array.isArray(office.decisions)) continue;
    const reportDate = isoDate(office.report_date || office.as_of);
    const source = office.data_status === 'official' || office.status === 'official'
      ? SOURCE_OFFICIAL
      : SOURCE_UNVERIFIED;
    for (const row of office.decisions) {
      if (!row || typeof row !== 'object') continue;
      const number = normalizeNumber(row.number);
      const decision = normalizeDecision(row.decision);
      const date = isoDate(row.date);
      if (!number || !decision || !date) continue;
      addRow(slug, number, date, decision, isoDate(row.report_date) || reportDate, source);
    }
  }

  // New Delhi tracker observations are dated rows that are not necessarily in
  // the latest official file; keep them as their own source.
  const tracker = readJson(path.join(dataDir, 'visa_decisions.json'));
  if (Array.isArray(tracker)) {
    for (const row of tracker) {
      if (!Array.isArray(row)) continue;
      const number = normalizeNumber(row[1]);
      const decision = normalizeDecision(row[2]);
      const date = isoDate(row[0]);
      if (!number || !decision || !date) continue;
      addRow('new-delhi', number, date, decision, '', SOURCE_TRACKER);
    }
  }

  const ordered = [...byKey.values()]
    .sort((a, b) => officeList.indexOf(a[0]) - officeList.indexOf(b[0]) ||
      a[1].localeCompare(b[1], 'en', { numeric: true }));

  const rows = ordered.map(([slug, number, date, decision, reportDate, source]) => [
    officeList.indexOf(slug), number, date, decision, reportDate, source,
  ]);
  // A build that finds the same rows should not dirty the committed file by
  // rewriting its timestamp. Keeping generated_at stable keeps the deploy
  // content hash (and git status) stable on data-free rebuilds.
  const previous = readJson(outFile, null);
  const unchanged = previous && Array.isArray(previous.rows) &&
    previous.generated_at &&
    JSON.stringify(previous.offices) === JSON.stringify(officeList) &&
    JSON.stringify(previous.rows) === JSON.stringify(rows);
  const payload = {
    generated_at: unchanged ? previous.generated_at : new Date().toISOString(),
    offices: officeList,
    rows,
  };
  fs.writeFileSync(outFile, JSON.stringify(payload) + '\n');
  return {
    path: outFile,
    bytes: fs.statSync(outFile).size,
    rows: payload.rows.length,
    offices: officeList.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildSearchIndex();
  console.log(
    `Search index: ${result.rows} rows, ${result.offices} offices, ` +
    `${(result.bytes / 1024).toFixed(0)} KB -> ${path.relative(ROOT, result.path)}`
  );
}
