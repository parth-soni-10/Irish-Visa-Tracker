import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { buildSearchFallback } from '../tools/build-search-fallback.mjs';

test('search fallback keeps valid, deduplicated office rows and metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visa-fallback-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const manifestPath = path.join(dataDir, 'data_manifest.json');
  fs.writeFileSync(path.join(dataDir, 'freshness.json'), JSON.stringify({
    offices: [
      {
        slug: 'beijing',
        last_success_at: '2026-11-18T06:01:42.341Z',
        last_success_label: '18 Nov 2026, 06:01 UTC',
        stale: true,
        attention: true,
        status: 'official',
        status_label: 'Official',
        warning: 'Report is overdue',
      },
    ],
  }));
  fs.writeFileSync(manifestPath, JSON.stringify({
    offices: [
      {
        slug: 'beijing',
        source_url: 'https://example.test/beijing',
        source_file: 'https://example.test/beijing.ods',
        source_name: 'Beijing office',
        report_date: '2026-11-01',
        status: 'official',
      },
      {
        slug: 'new-delhi',
        source_url: 'https://example.test/delhi',
        report_date: '2026-11-16',
        status: 'official',
      },
    ],
  }));
  fs.writeFileSync(path.join(dataDir, 'embassy-beijing.json'), JSON.stringify({
    decisions: [
      { date: '2026-10-01', number: 'IRL 44-078-322', decision: 'Refused' },
      { date: '2026-11-01', number: '44078322', decision: 'Refused' },
      { date: '2026-11-01', number: 'NO_FILE', decision: 'Approved' },
      { date: 'not-a-date', number: '12345678', decision: 'Approved' },
    ],
  }));
  fs.writeFileSync(path.join(dataDir, 'embassy-new-delhi.json'), JSON.stringify({
    decisions: [
      { date: '2026-11-16', number: '048850812', decision: 'Approved' },
    ],
  }));

  const outFile = path.join(dir, 'out', 'search_fallback.json');
  const result = buildSearchFallback({ dataDir, manifestPath, outFile });
  assert.equal(result.rows, 2);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(payload.offices.beijing.source_file, 'https://example.test/beijing.ods');
  assert.equal(payload.offices.beijing.last_success_label, '18 Nov 2026, 06:01 UTC');
  assert.equal(payload.offices.beijing.stale, true);
  assert.equal(payload.offices.beijing.attention, true);
  // Columnar: one series per office, a shared date table and ascending deltas.
  assert.equal(payload.version, 2);
  assert.deepEqual(payload.dates, ['2026-11-01', '2026-11-16']);
  assert.deepEqual(payload.rows.beijing, { number_deltas: [44078322], date_index: [0], approved: [0] });
  assert.deepEqual(payload.rows['new-delhi'], { number_deltas: [48850812], date_index: [1], approved: [1] });
});

function decodeRows(payload) {
  const rows = [];
  for (const [slug, series] of Object.entries(payload.rows)) {
    let running = 0;
    series.number_deltas.forEach((delta, index) => {
      running += Number(delta) || 0;
      rows.push([slug, String(running), payload.dates[series.date_index[index]], series.approved[index] ? 'Approved' : 'Refused']);
    });
  }
  return rows.sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

test('columnar rows decode back to the same application-number rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visa-fallback-deltas-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const manifestPath = path.join(dataDir, 'data_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    offices: [{ slug: 'abuja', report_date: '2026-11-07', status: 'official' }],
  }));
  fs.writeFileSync(path.join(dataDir, 'embassy-abuja.json'), JSON.stringify({
    decisions: [
      { date: '2026-11-07', number: '90000011', decision: 'Approved' },
      { date: '2026-11-07', number: '90000003', decision: 'Refused' },
      { date: '2026-10-31', number: '90000007', decision: 'Approved' },
    ],
  }));

  const outFile = path.join(dir, 'out', 'search_fallback.json');
  buildSearchFallback({ dataDir, manifestPath, outFile });
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  // File order is preserved (the lookup keeps equal hits in file order), so a
  // delta is simply the next number minus the previous one and can go negative.
  assert.deepEqual(payload.rows.abuja.number_deltas, [90000011, -8, 4]);
  // The shared date table is sorted, so 2026-10-31 is index 0 and 2026-11-07 is 1.
  assert.deepEqual(payload.rows.abuja.date_index, [1, 1, 0]);
  assert.deepEqual(payload.rows.abuja.approved, [1, 0, 1]);
  assert.deepEqual(decodeRows(payload), [
    ['abuja', '90000003', '2026-11-07', 'Refused'],
    ['abuja', '90000007', '2026-10-31', 'Approved'],
    ['abuja', '90000011', '2026-11-07', 'Approved'],
  ]);
});
