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
  assert.deepEqual(payload.rows, [
    ['beijing', '44078322', '2026-11-01', 'Refused'],
    ['new-delhi', '48850812', '2026-11-16', 'Approved'],
  ]);
});
