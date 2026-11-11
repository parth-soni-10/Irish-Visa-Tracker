import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePdfReport } from '../tools/scrape-embassies.mjs';

/**
 * Build a small text-layer PDF fixture. The content stream is intentionally
 * minimal; it is enough for PDFParse to exercise the same path as the real
 * weekly embassy PDFs.
 */
function fixturePdf({ mission, periodStart, periodEnd, rows = [] }) {
  const lines = [
    'Application Decisions',
    `Decisions for period from ${periodStart} to ${periodEnd}`,
    `Mission: ${mission}`,
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

test('Abuja text PDF extraction uses the PDF text layer without OCR', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => {
    const number = String(20000000 + index);
    return [number, index % 2 === 0 ? 'Approved' : 'Refused'];
  });
  let ocrCalls = 0;
  const parsed = await parsePdfReport(
    fixturePdf({
      mission: 'Abuja',
      periodStart: '12/10/2026',
      periodEnd: '18/10/2026',
      rows: rows.map(([number, decision]) => `${number} ${decision}`)
    }),
    {
      ocr: false,
      ocrImpl: async () => {
        ocrCalls++;
        return { text: '', pages: 1, dpi: 300, engine: 'should-not-run' };
      }
    }
  );

  assert.equal(ocrCalls, 0);
  assert.equal(parsed.ocrUsed, false);
  assert.equal(parsed.ocrError, null);
  assert.match(parsed.text, /Mission: Abuja/);
  assert.deepEqual(
    parsed.decisions,
    rows.map(([number, decision]) => ({ number, decision }))
  );
});

test('Ankara scanned PDF falls back to OCR and deduplicates its rows', async () => {
  const ocrText = [
    'Application Decisions:',
    'Decisions for period from 17/10/2026 to 25/10/2026',
    'Application Number Decision',
    '| 30000001 | Approved |',
    '30000002 Refused',
    '30000003 Approved',
    '30000004 Refused',
    '30000005 Approved',
    '30000006 Refused',
    '30000007 Approved',
    '30000008 Refused',
    '30000009 Approved',
    '30000010 Refused',
    '30000010 Approved'
  ].join('\n');
  let receivedBuffer;
  const parsed = await parsePdfReport(
    fixturePdf({
      mission: 'Ankara',
      periodStart: '17/10/2026',
      periodEnd: '25/10/2026'
    }),
    {
      ocr: true,
      slug: 'ankara',
      ocrImpl: async (buffer) => {
        receivedBuffer = buffer;
        return { text: ocrText, pages: 2, dpi: 300, engine: 'fixture-ocr' };
      }
    }
  );

  assert.ok(Buffer.isBuffer(receivedBuffer));
  assert.equal(parsed.ocrUsed, true);
  assert.equal(parsed.ocrError, null);
  assert.match(parsed.note, /fixture-ocr.*300 DPI.*2 pages/);
  assert.match(parsed.text, /25\/10\/2026/);
  assert.equal(parsed.decisions.length, 10);
  assert.deepEqual(
    parsed.decisions.find((row) => row.number === '30000010'),
    { number: '30000010', decision: 'Approved' }
  );
});

test('Ankara OCR failure is surfaced without discarding extracted text', async () => {
  const parsed = await parsePdfReport(
    fixturePdf({
      mission: 'Ankara',
      periodStart: '17/10/2026',
      periodEnd: '25/10/2026'
    }),
    {
      ocr: true,
      slug: 'ankara',
      ocrImpl: async () => ({ text: 'OCR found no rows', pages: 1, dpi: 300, engine: 'fixture-ocr' })
    }
  );

  assert.equal(parsed.ocrUsed, false);
  assert.ok(parsed.ocrError instanceof Error);
  assert.match(parsed.note, /OCR failed: OCR found only 0 decision rows/);
  assert.match(parsed.text, /Mission: Ankara/);
  assert.deepEqual(parsed.decisions, []);
});
