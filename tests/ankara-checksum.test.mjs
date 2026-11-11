import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decisionChecksum } from '../tools/embassy-checksum.mjs';
import { verifyAnkaraData } from '../tools/verify-ankara.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const office = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'embassy-ankara.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'data_manifest.json'), 'utf8'));
const reportIndex = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'reports', 'index.json'), 'utf8'));

test('Ankara checksum covers every recorded decision and the current report', () => {
  assert.equal(office.checksum, decisionChecksum(office.decisions));
  const current = office.decisions.filter((row) => row.date === office.report_date);
  assert.equal(reportIndex.offices.ankara[0].checksum, decisionChecksum(current));
});

test('decision checksum is independent of row order and last duplicate wins', () => {
  const rows = [
    { number: '1234567', decision: 'Approved' },
    { number: '7654321', decision: 'Refused' },
    { number: '5555555', decision: 'Approved' },
  ];
  assert.equal(decisionChecksum(rows), decisionChecksum([...rows].reverse()));
  assert.equal(
    decisionChecksum([...rows, { number: '1234567', decision: 'Refused' }]),
    decisionChecksum([
      { number: '1234567', decision: 'Refused' },
      { number: '7654321', decision: 'Refused' },
      { number: '5555555', decision: 'Approved' },
    ])
  );
});

test('changed decisions fail checksum verification', () => {
  const changed = structuredClone(office);
  const row = changed.decisions.find((entry) => entry.date !== changed.report_date) || changed.decisions[0];
  row.decision = row.decision === 'Approved' ? 'Refused' : 'Approved';

  const errors = verifyAnkaraData(changed, manifest, reportIndex);
  assert.ok(errors.some((error) => error.startsWith('checksum ')), errors.join('\n'));
});

test('a stale office checksum fails verification', () => {
  const stale = structuredClone(office);
  stale.checksum = '0'.repeat(16);

  const errors = verifyAnkaraData(stale, manifest, reportIndex);
  assert.ok(errors.some((error) => error.startsWith('checksum ')), errors.join('\n'));
});

test('a stale report-index checksum fails verification', () => {
  const stale = structuredClone(reportIndex);
  stale.offices.ankara[0].checksum = '0'.repeat(16);

  const errors = verifyAnkaraData(office, manifest, stale);
  assert.ok(errors.some((error) => error.startsWith('report index checksum ')), errors.join('\n'));
});

test('the checked-in Ankara data passes verification', () => {
  assert.deepEqual(verifyAnkaraData(office, manifest, reportIndex), []);
});
