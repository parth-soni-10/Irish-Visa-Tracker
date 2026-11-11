import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decisionChecksum } from '../tools/embassy-checksum.mjs';
import { verifyEmbassyChecksums } from '../tools/verify-embassy-checksums.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const reportIndex = JSON.parse(fs.readFileSync(path.join(DATA, 'reports', 'index.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'data_manifest.json'), 'utf8'));
const offices = fs
  .readdirSync(DATA)
  .filter((file) => /^embassy-.*\.json$/.test(file))
  .map((file) => JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')));
const otherOffices = offices.filter((office) => office.office !== 'ankara');

test('every non-Ankara office checksum matches its decision rows', () => {
  assert.ok(otherOffices.length > 0);
  for (const office of otherOffices) {
    assert.equal(
      office.checksum,
      decisionChecksum(office.decisions),
      `${office.office} office checksum`
    );
  }
});

test('every non-Ankara report-index checksum matches its current report', () => {
  for (const office of otherOffices) {
    const current = office.decisions.filter((row) => row.date === office.report_date);
    const entry = reportIndex.offices[office.office].find(
      (candidate) => candidate.report_date === office.report_date
    );
    assert.ok(entry, `${office.office} report-index entry`);
    assert.equal(entry.decisions, current.length, `${office.office} current-report count`);
    assert.equal(entry.checksum, decisionChecksum(current), `${office.office} report-index checksum`);
  }
});

test('the verifier accepts all checked-in embassy files', () => {
  assert.deepEqual(verifyEmbassyChecksums(offices, reportIndex), []);
});

test('the verifier rejects duplicate and empty report-index entries', () => {
  const duplicateIndex = structuredClone(reportIndex);
  const template = duplicateIndex.offices.ankara.find((entry) => entry.decisions > 0);
  duplicateIndex.offices.ankara.push({ ...template });
  const duplicateErrors = verifyEmbassyChecksums(offices, duplicateIndex);
  assert.ok(
    duplicateErrors.some((error) => error.includes('duplicate report-index entry')),
    duplicateErrors.join('\n')
  );

  const emptyIndex = structuredClone(reportIndex);
  emptyIndex.offices.ankara.push({
    ...template,
    report_date: '2026-11-09',
    decisions: 0,
    approved: 0,
    refused: 0,
    checksum: '0'.repeat(16)
  });
  const emptyErrors = verifyEmbassyChecksums(offices, emptyIndex);
  assert.ok(
    emptyErrors.some((error) => error.includes('invalid decisions 0')),
    emptyErrors.join('\n')
  );
});

test('manifest archive report dates reconcile to archived rows', () => {
  for (const office of manifest.offices) {
    assert.ok(Array.isArray(office.archive_reports), `${office.slug} archive_reports`);
    assert.ok(office.archive_reports.length > 0, `${office.slug} archive report dates`);
    const dates = new Set();
    let total = 0;
    for (const report of office.archive_reports) {
      assert.match(report.report_date, /^\d{4}-\d{2}-\d{2}$/, `${office.slug} report date`);
      assert.ok(!dates.has(report.report_date), `${office.slug} duplicate report date ${report.report_date}`);
      dates.add(report.report_date);
      total += Number(report.decisions) || 0;
    }
    assert.equal(total, Number(office.archive_decisions), `${office.slug} archived row total`);
  }
});

test('office archives have unique application numbers and valid dated rows', () => {
  for (const office of offices) {
    const numbers = new Set();
    assert.ok(office.decisions.length > 0, `${office.office} has decisions`);
    for (const row of office.decisions) {
      assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/, `${office.office} date`);
      assert.match(String(row.number), /^\d{6,}$/, `${office.office} number`);
      assert.ok(row.decision === 'Approved' || row.decision === 'Refused', `${office.office} decision`);
      assert.ok(!numbers.has(String(row.number)), `${office.office} duplicate number ${row.number}`);
      numbers.add(String(row.number));
    }
  }
});

test('the verifier rejects a stale checksum for every non-Ankara office', () => {
  for (const office of otherOffices) {
    const stale = structuredClone(office);
    stale.checksum = '0'.repeat(16);
    const errors = verifyEmbassyChecksums([stale], reportIndex);
    assert.ok(
      errors.some((error) => error.startsWith(`${office.office}: checksum `)),
      errors.join('\n')
    );
  }
});
