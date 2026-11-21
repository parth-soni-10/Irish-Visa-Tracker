/**
 * Build the small first-paint dataset for the tracker.
 *
 * The full New Delhi history is ~2.3MB. The Search tab only needs the latest
 * rows and the manifest freshness block before the visitor asks for History.
 * Write those ten rows here; the full file is loaded on demand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadFreshness } from './freshness.mjs';

export function buildSearchPreview({ dataDir, outFile }) {
  const manifestPath = path.join(dataDir, 'data_manifest.json');
  const decisionsPath = path.join(dataDir, 'visa_decisions.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const office = (manifest.offices || []).find((item) => item.slug === 'new-delhi') || {};
  let rows = [];
  let allRows = [];
  if (fs.existsSync(decisionsPath)) {
    const parsed = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
    if (Array.isArray(parsed)) {
      allRows = parsed;
      rows = parsed
        .filter((row) => Array.isArray(row) && /^(approved|refused)$/i.test(String(row[2] || '').trim()))
        .sort((a, b) => String(b[0]).localeCompare(String(a[0])) || String(b[1]).localeCompare(String(a[1])))
        .slice(0, 10);
    }
  }
  const freshness = loadFreshness(path.dirname(path.resolve(dataDir)));
  const latest = freshness.bySlug['new-delhi'] || {};
  const latestDay = String(office.report_date || latest.report_date || '').slice(0, 10);
  const latestDecisionDay = String(latest.latest_decision_date || latestDay).slice(0, 10);
  const latestDayTotal = allRows.filter((row) => Array.isArray(row) && String(row[0]) === latestDecisionDay).length;
  const payload = {
    generated_at: new Date().toISOString(),
    total: Number(office.decisions) || 0,
    tracker_rows: allRows.length,
    latest_day: latestDecisionDay,
    latest_day_total: latestDayTotal,
    rows,
    office: {
      name: office.name || 'New Delhi',
      report_date: latestDay,
      decisions: Number(office.decisions) || 0,
      fetched_at: office.fetched_at || '',
      source_url: office.source_url || '',
    },
  };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload));
  return { rows: rows.length, bytes: Buffer.byteLength(JSON.stringify(payload)) };
}
