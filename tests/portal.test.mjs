import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAnalytics, summarize } from '../functions/analytics.js';
import { quoteFees, scanDocument } from '../functions/assistant.js';
import { buildExport, nextRunAt } from '../functions/export-service.js';

const rows = [
  { number: 'IRL10000001', date: '2026-01-01', decision: 'Approved', office: 'new-delhi', source: 'official', report_date: '2026-01-02' },
  { number: 'IRL10000002', date: '2026-01-01', decision: 'Refused', office: 'new-delhi', source: 'official', report_date: '2026-01-02' },
  { number: 'IRL10000003', date: '2026-01-02', decision: 'Approved', office: 'beijing', source: 'official', report_date: '2026-01-03' },
  { number: 'IRL10000004', date: '2026-01-03', decision: 'Approved', office: 'new-delhi', source: 'official', report_date: '2026-01-04' },
  { number: 'IRL10000005', date: '2026-02-01', decision: 'Refused', office: 'new-delhi', source: 'official', report_date: '2026-02-02' }
];

test('analytics summary counts only approved and refused decisions', () => {
  assert.deepEqual(summarize([...rows, { decision: 'Pending' }]), {
    total: 5,
    approved: 3,
    refused: 2,
    approval_rate: 60
  });
});

test('analytics filters, cohorts, heatmap and drill-down share the selected rows', () => {
  const result = buildAnalytics(rows, {
    office: 'new-delhi',
    from: '2026-01-01',
    to: '2026-01-31',
    date: '2026-01-01',
    horizon: 7
  });
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.approved, 2);
  assert.equal(result.filter.office, 'new-delhi');
  assert.equal(result.cohorts.length, 1);
  assert.equal(result.cohorts[0].cohort, '2026-01');
  assert.equal(result.heatmap.offices.length, 1);
  assert.equal(result.drilldown.length, 2);
  assert.equal(result.forecast.horizon_days, 7);
});

test('fee quotes are explicit EUR estimates with optional VFS fees', () => {
  const withVfs = quoteFees({ office: 'new-delhi', entry_type: 'single', entries: 2, vfs: true });
  assert.equal(withVfs.total, 161);
  assert.equal(withVfs.currency, 'EUR');
  assert.ok(withVfs.line_items.some((item) => /VFS/.test(item.label)));
  const withoutVfs = quoteFees({ office: 'dublin', entry_type: 'multi', entries: 1, vfs: false });
  assert.equal(withoutVfs.total, 100);
});

test('document extraction finds conservative fields and warns about missing data', () => {
  const result = scanDocument('Application IRL12345678 was approved on 12 January 2026 for a study visa at New Delhi.');
  assert.equal(result.fields.application_number, '12345678');
  assert.equal(result.fields.decision, 'Approved');
  assert.equal(result.fields.date, '2026-01-12');
  assert.equal(result.fields.office, 'new-delhi');
  assert.equal(result.fields.visa_type, 'study');
  assert.ok(result.confidence >= 80);

  const sparse = scanDocument('No useful fields here');
  assert.ok(sparse.warnings.length > 0);
  assert.equal(sparse.fields.application_number, '');
});

test('exports escape CSV cells and honour office and date filters', () => {
  const csv = buildExport([
    ...rows,
    { number: 'A,"quoted"', date: '2026-01-04', decision: 'Approved', office: 'new-delhi', source: 'x,y', report_date: '2026-01-05' }
  ], { format: 'csv', office: 'new-delhi', from: '2026-01-01', to: '2026-01-31' });
  assert.equal(csv.row_count, 4);
  assert.match(csv.body, /"A,""quoted"""/);
  assert.ok(csv.body.split('\r\n')[0].startsWith('date,application_number,decision'));

  const json = buildExport(rows, { format: 'json', office: 'beijing' });
  assert.equal(json.row_count, 1);
  assert.equal(JSON.parse(json.body).filter.office, 'beijing');
  assert.equal(JSON.parse(json.body).count, 1);
});

test('schedule helper always returns a future ISO time', () => {
  const now = new Date('2026-01-01T06:00:00Z');
  for (const frequency of ['daily', 'weekly', 'monthly']) {
    const next = new Date(nextRunAt(frequency, now));
    assert.ok(next.getTime() > now.getTime(), frequency + ' should be in the future');
    assert.equal(next.getUTCHours(), 7);
  }
});
