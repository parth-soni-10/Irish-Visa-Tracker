import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingestOffice } from '../tools/scrape-embassies.mjs';

const CONFIG = {
  name: 'Ankara',
  page: 'https://example.test/ankara-decisions/',
  kind: 'pdf',
  ocr: true,
  preserveHistory: true,
  official: 'Embassy of Ireland, Ankara'
};

const HTML = '<html><body><a href="/files/ankara-2026-11-12.pdf">Weekly decision report</a></body></html>';

/**
 * A valid PDF with a single blank page and no text layer, standing in for a
 * scanned report that Tesseract cannot read. It parses through the real
 * pdf-parse path, so the test exercises the same flow as production.
 */
function scannedPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream'
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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irish-visa-ocr-guard-'));
  const dataDir = path.join(dir, 'data');
  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const previous = {
    office: 'ankara',
    name: 'Ankara',
    report_date: '2026-11-05',
    decisions: [
      { date: '2026-11-05', number: '11111111', decision: 'Approved', embassy: 'ankara', date_basis: 'report_period_end' },
      { date: '2026-11-05', number: '22222222', decision: 'Refused', embassy: 'ankara', date_basis: 'report_period_end' }
    ]
  };
  const officePath = path.join(dataDir, 'embassy-ankara.json');
  fs.writeFileSync(officePath, JSON.stringify(previous, null, 2) + '\n');

  const reportIndex = {
    offices: {
      ankara: [
        {
          report_date: '2026-11-05',
          decisions: 2,
          approved: 1,
          refused: 1,
          source_file: 'https://example.test/files/ankara-2026-11-05.pdf',
          checksum: 'previous-checksum'
        }
      ]
    }
  };
  const indexPath = path.join(reportsDir, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(reportIndex, null, 2) + '\n');

  return {
    dir,
    dataDir,
    officePath,
    indexPath,
    previous,
    reportIndex,
    manifest: { generated_at: null, offices: [] },
    manifestBySlug: new Map()
  };
}

function context(state, ocrImpl) {
  return {
    dataDir: state.dataDir,
    manifest: state.manifest,
    reportIndex: state.reportIndex,
    manifestBySlug: state.manifestBySlug,
    fetchPage: async () => ({ text: async () => HTML }),
    fetchFile: async () => scannedPdf(),
    ocrImpl
  };
}

test('unreadable scanned Ankara PDF keeps the previous snapshot and report index', async () => {
  const state = setup();
  const beforeOffice = fs.readFileSync(state.officePath);
  const beforeIndex = fs.readFileSync(state.indexPath);

  try {
    const summary = await ingestOffice(
      'ankara',
      CONFIG,
      context(state, async () => {
        throw new Error('pdftoppm produced no page images');
      })
    );

    assert.equal(summary.status, 'ocr_required');
    assert.equal(summary.preserved_from, '2026-11-05');
    assert.equal(summary.report_date, '2026-11-05');
    assert.equal(summary.decisions, 2);
    assert.match(summary.note, /Kept the previous snapshot/);

    assert.deepEqual(fs.readFileSync(state.officePath), beforeOffice, 'office snapshot was overwritten');
    assert.deepEqual(fs.readFileSync(state.indexPath), beforeIndex, 'report index was rewritten');

    assert.equal(state.reportIndex.offices.ankara.length, 1);
    assert.equal(state.reportIndex.offices.ankara[0].report_date, '2026-11-05');
    assert.equal(state.manifestBySlug.get('ankara'), summary);
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});

test('readable OCR output is ingested and recorded in the report index', async () => {
  const state = setup();
  const ocrText = [
    'Application Decisions:',
    'Decisions for period from 07/11/2026 to 12/11/2026',
    'Application Number Decision',
    ...Array.from({ length: 10 }, (_, index) => `${40000001 + index} ${index % 2 === 0 ? 'Approved' : 'Refused'}`)
  ].join('\n');

  try {
    const summary = await ingestOffice(
      'ankara',
      CONFIG,
      context(state, async () => ({ text: ocrText, pages: 1, dpi: 300, engine: 'fixture-ocr' }))
    );

    assert.equal(summary.status, 'official');
    assert.equal(summary.report_date, '2026-11-12');
    assert.equal(summary.decisions, 10);
    assert.equal(summary.archive_decisions, 12);

    const office = JSON.parse(fs.readFileSync(state.officePath, 'utf8'));
    assert.equal(office.decisions.length, 12);
    assert.equal(office.decisions.filter((row) => row.date === '2026-11-12').length, 10);

    const latest = state.reportIndex.offices.ankara.find((entry) => entry.report_date === '2026-11-12');
    assert.ok(latest, 'report index entry for the OCR report is missing');
    assert.equal(latest.decisions, 10);
    assert.match(latest.checksum, /^[0-9a-f]{16}$/);
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});
