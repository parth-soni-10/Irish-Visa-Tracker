import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decisionChecksum } from '../tools/embassy-checksum.mjs';
import { verifyEmbassyChecksums } from '../tools/verify-embassy-checksums.mjs';
import { runBackfill } from '../tools/backfill-weekly-history.mjs';

function fixturePdf(periodStart, periodEnd, rows) {
  const lines = [
    'Application Decisions',
    `Decisions for period from ${periodStart} to ${periodEnd}`,
    'Mission: Abu Dhabi',
    ...rows
  ];
  const text = lines.map((line) => `(${line}) Tj T*`).join('\n');
  const stream = `BT\n/F1 10 Tf\n72 720 Td\n12 TL\n${text}\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`
  ];
  const header = '%PDF-1.4\n';
  let body = '';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(header + body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(header + body);
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  return Buffer.from(
    header +
      body +
      xref +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );
}

function reportRows(date, entries) {
  return entries.map(([number, decision]) => ({
    date,
    number,
    decision,
    embassy: 'abu-dhabi',
    date_basis: 'report_period_end'
  }));
}

test('weekly PDF backfill is dry-run safe and keeps current/archive checksum boundaries', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visa-backfill-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const pageUrl = 'https://fixture.test/abu-dhabi/weekly-decision-reports/';
  const report23Url = 'https://fixture.test/decisions-2026-10-23.pdf';
  const report16Url = 'https://fixture.test/decisions-2026-10-16.pdf';

  const currentRows = reportRows('2026-11-06', [
    ['10000001', 'Approved'],
    ['10000002', 'Refused']
  ]);
  const archivedRows = reportRows('2026-10-30', [
    ['10000003', 'Approved'],
    ['10000004', 'Refused']
  ]);
  const report23Entries = [
    ['10000001', 'Refused'],
    ['10000003', 'Refused'],
    ['10000010', 'Approved'],
    ['10000011', 'Refused'],
    ['10000012', 'Approved'],
    ['10000013', 'Refused'],
    ['10000014', 'Approved'],
    ['10000015', 'Refused'],
    ['10000016', 'Approved'],
    ['10000017', 'Refused']
  ];
  const report16Entries = [
    ['10000003', 'Approved'],
    ['10000010', 'Refused'],
    ['10000020', 'Approved'],
    ['10000021', 'Refused'],
    ['10000022', 'Approved'],
    ['10000023', 'Refused'],
    ['10000024', 'Approved'],
    ['10000025', 'Refused'],
    ['10000026', 'Approved'],
    ['10000027', 'Refused']
  ];
  const report23Rows = reportRows('2026-10-23', report23Entries);
  const report16Rows = reportRows('2026-10-16', report16Entries);
  const currentChecksum = decisionChecksum(currentRows);
  const archiveChecksum = decisionChecksum([...currentRows, ...archivedRows]);
  assert.notEqual(currentChecksum, archiveChecksum);
  const expectedRows = [
    ...currentRows,
    ...archivedRows,
    ...report23Rows.filter((row) => !['10000001', '10000003'].includes(row.number)),
    ...report16Rows.filter((row) => !['10000003', '10000010'].includes(row.number))
  ];

  const officeFile = {
    office: 'abu-dhabi',
    name: 'Abu Dhabi',
    source_url: pageUrl,
    source_file: 'https://fixture.test/current.pdf',
    source_name: 'Embassy of Ireland, Abu Dhabi',
    report_date: '2026-11-06',
    as_of: '2026-11-10',
    fetched_at: '2026-11-10T12:00:00.000Z',
    data_status: 'official',
    date_basis: 'report_period_end',
    note: null,
    checksum: archiveChecksum,
    decisions: [...currentRows, ...archivedRows]
  };
  const reportIndex = {
    offices: {
      'abu-dhabi': [
        {
          report_date: '2026-11-06',
          fetched_at: '2026-11-10T12:00:00.000Z',
          decisions: currentRows.length,
          approved: 1,
          refused: 1,
          source_file: 'https://fixture.test/current.pdf',
          checksum: currentChecksum,
          added: currentRows.length,
          removed: 0,
          changed: []
        }
      ]
    }
  };
  const officePath = path.join(dataDir, 'embassy-abu-dhabi.json');
  const indexPath = path.join(reportsDir, 'index.json');
  fs.writeFileSync(officePath, JSON.stringify(officeFile, null, 2) + '\n');
  fs.writeFileSync(indexPath, JSON.stringify(reportIndex, null, 2) + '\n');

  const pdfs = new Map([
    [report23Url, fixturePdf('16/10/2026', '23/10/2026', report23Entries.map(([number, decision]) => `${number} ${decision}`))],
    [report16Url, fixturePdf('11/10/2026', '16/10/2026', report16Entries.map(([number, decision]) => `${number} ${decision}`))]
  ]);
  const fetchImpl = async (url) => {
    if (url === pageUrl) {
      return new Response(`<html><body><a href="${report23Url}">23 Oct</a><a href="${report16Url}">16 Oct</a></body></html>`, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    if (pdfs.has(url)) {
      return new Response(pdfs.get(url), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' }
      });
    }
    return new Response('missing', { status: 404 });
  };
  const options = {
    dataDir,
    offices: {
      'abu-dhabi': { page: pageUrl, extraPdfs: [] }
    },
    fetchImpl,
    now: () => new Date('2026-11-11T00:00:00.000Z'),
    log: () => {},
    warn: () => {}
  };

  const beforeOffice = fs.readFileSync(officePath, 'utf8');
  const beforeIndex = fs.readFileSync(indexPath, 'utf8');
  const dryRun = await runBackfill({ ...options, dryRun: true });

  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.results.length, 1);
  assert.equal(fs.readFileSync(officePath, 'utf8'), beforeOffice, 'dry run leaves office file unchanged');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), beforeIndex, 'dry run leaves report index unchanged');
  assert.deepEqual(
    dryRun.results[0].office.decisions.map((row) => row.number).sort(),
    expectedRows.map((row) => row.number).sort()
  );
  assert.equal(dryRun.results[0].office.checksum, decisionChecksum(expectedRows));
  assert.notEqual(dryRun.results[0].office.checksum, archiveChecksum);

  const dryEntries = dryRun.results[0].reportIndex;
  assert.equal(dryEntries[0].report_date, '2026-11-06');
  assert.equal(dryEntries[0].checksum, currentChecksum);
  assert.equal(dryEntries.find((entry) => entry.report_date === '2026-10-23').checksum, decisionChecksum(report23Rows));
  assert.equal(dryEntries.find((entry) => entry.report_date === '2026-10-16').checksum, decisionChecksum(report16Rows));
  assert.equal(dryEntries.find((entry) => entry.report_date === '2026-10-23').decisions, report23Rows.length);
  assert.equal(dryEntries.find((entry) => entry.report_date === '2026-10-16').decisions, report16Rows.length);

  const written = await runBackfill({ ...options, dryRun: false });
  assert.equal(written.dryRun, false);
  const writtenOffice = JSON.parse(fs.readFileSync(officePath, 'utf8'));
  const writtenIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  assert.equal(writtenOffice.report_date, '2026-11-06');
  assert.equal(writtenOffice.source_file, 'https://fixture.test/current.pdf');
  assert.equal(writtenOffice.decisions.length, expectedRows.length);
  assert.equal(writtenOffice.checksum, decisionChecksum(expectedRows));
  assert.equal(writtenIndex.offices['abu-dhabi'][0].checksum, currentChecksum);
  assert.notEqual(writtenOffice.checksum, writtenIndex.offices['abu-dhabi'][0].checksum);
  assert.equal(
    writtenIndex.offices['abu-dhabi'].find((entry) => entry.report_date === '2026-10-23').checksum,
    decisionChecksum(report23Rows)
  );
  assert.equal(
    writtenIndex.offices['abu-dhabi'].find((entry) => entry.report_date === '2026-10-16').checksum,
    decisionChecksum(report16Rows)
  );
  assert.deepEqual(verifyEmbassyChecksums([writtenOffice], writtenIndex), []);
  assert.equal(
    writtenOffice.decisions.find((row) => row.number === '10000001').decision,
    'Approved',
    'the newer current report wins over an older duplicate'
  );
  assert.equal(
    writtenOffice.decisions.find((row) => row.number === '10000010').date,
    '2026-10-23',
    'the newer historical report wins over an older duplicate'
  );
});
