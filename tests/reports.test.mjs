import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildMonthlyReport, buildWeeklyChanges, dateOffset, loadReportData } from '../functions/report-data.js';

const rows = [
  { date: '2026-09-28', number: 'A1', decision: 'Approved', office: 'new-delhi' },
  { date: '2026-10-02', number: 'A2', decision: 'Refused', office: 'new-delhi' },
  { date: '2026-10-29', number: 'A3', decision: 'Approved', office: 'new-delhi' },
  { date: '2026-11-01', number: 'A4', decision: 'Approved', office: 'new-delhi' },
  { date: '2026-11-05', number: 'A5', decision: 'Refused', office: 'dublin' },
  { date: '2026-11-10', number: 'A6', decision: 'Approved', office: 'dublin' }
];
const offices = [
  { slug: 'new-delhi', name: 'New Delhi', status: 'official', report_date: '2026-11-05' },
  { slug: 'dublin', name: 'Dublin', status: 'official', report_date: '2026-11-10' }
];
const reports = {
  offices: {
    dublin: [{ report_date: '2026-11-10', fetched_at: '2026-11-10T12:00:00Z', added: 2, removed: 0, changed: [] }]
  }
};

test('monthly report counts the month and compares with the previous month', () => {
  const report = buildMonthlyReport(rows, '2026-11', offices);
  assert.equal(report.totals.total, 3);
  assert.equal(report.totals.approved, 2);
  assert.equal(report.totals.refused, 1);
  assert.equal(report.totals.approval_rate, 66.7);
  assert.equal(report.previous_totals.total, 2);
  assert.equal(report.change.total, 1);
  assert.equal(report.daily.length, 3);
  assert.equal(report.offices.find((office) => office.slug === 'dublin').total, 2);
  assert.equal(report.busiest_day.date, '2026-11-10');
});

test('weekly changes use a rolling window ending on the latest data date', () => {
  const changes = buildWeeklyChanges(rows, '2026-11-10', offices, reports, 7);
  assert.equal(changes.window.start, '2026-11-04');
  assert.equal(changes.window.end, '2026-11-10');
  assert.equal(changes.totals.total, 2);
  assert.equal(changes.previous_totals.total, 2);
  assert.equal(changes.change.total, 0);
  assert.equal(changes.headline, '2 dated decisions this week, unchanged vs the previous week');
  assert.equal(changes.office_updates.find((office) => office.slug === 'dublin').is_this_week, true);
});

test('cumulative office snapshots are not counted as dated decisions', () => {
  const snapshot = { date: '2026-11-01', number: 'B1', decision: 'Refused', office: 'beijing', dated: false };
  const report = buildMonthlyReport([...rows, snapshot], '2026-11', [
    ...offices,
    { slug: 'beijing', name: 'Beijing', status: 'official', report_date: '2026-11-01', reported_total: 100, reported_approved: 80, reported_refused: 20 }
  ]);
  assert.equal(report.totals.total, 3);
  assert.equal(report.offices.find((office) => office.slug === 'beijing').total, 0);
  assert.equal(report.offices.find((office) => office.slug === 'beijing').reported_total, 100);
  assert.equal(report.reported_totals.total, 100);
});

test('weekly updates use the newest non-empty report entry', () => {
  const reportHistory = {
    offices: {
      dublin: [
        { report_date: '2026-11-11', decisions: 0, fetched_at: '2026-11-11T12:00:00Z', added: 0, removed: 0, changed: [] },
        { report_date: '2026-11-10', decisions: 2, fetched_at: '2026-11-10T12:00:00Z', added: 2, removed: 0, changed: [] },
        { report_date: '2026-11-03', decisions: 1, fetched_at: '2026-11-03T12:00:00Z', added: 1, removed: 0, changed: [] }
      ]
    }
  };
  const changes = buildWeeklyChanges(rows, '2026-11-10', offices, reportHistory, 7);
  const dublin = changes.office_updates.find((office) => office.slug === 'dublin');
  assert.equal(dublin.report_date, '2026-11-10');
  assert.equal(dublin.added, 2);
  assert.equal(dublin.is_this_week, true);
});

test('loadReportData keeps dated history for the weekly PDF offices', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        const file = path.join(root, pathname.replace(/^\//, ''));
        try {
          return new Response(fs.readFileSync(file));
        } catch {
          return new Response('missing', { status: 404 });
        }
      }
    }
  };
  const data = await loadReportData(env, new Request('https://tracker.test/'));
  for (const slug of ['abu-dhabi', 'abuja', 'ankara']) {
    const officeRows = data.rows.filter((row) => row.office === slug);
    assert.ok(officeRows.length > 0, `${slug} rows`);
    assert.ok(new Set(officeRows.map((row) => row.date)).size > 1, `${slug} dated history`);
    assert.ok(officeRows.every((row) => row.dated === true), `${slug} dated flag`);
  }
});

test('dateOffset crosses month boundaries in UTC', () => {
  assert.equal(dateOffset('2026-11-01', -1), '2026-10-31');
  assert.equal(dateOffset('2026-02-28', 1), '2026-03-01');
});
