import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ingestOffice } from '../tools/scrape-embassies.mjs';

/**
 * Minimal text-layer PDF fixture, the same shape the real weekly and
 * cumulative reports use: a period sentence followed by "number decision"
 * lines, which is what PDFParse hands back for both.
 */
function fixturePdf({ periodStart, periodEnd, rows }) {
  const lines = [
    'Application Decisions',
    `Decisions for period from ${periodStart} to ${periodEnd}`,
    'Application Number Decision',
    ...rows.map(([number, decision]) => `${number} ${decision}`)
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

function rows(count, start = 40000000) {
  return Array.from({ length: count }, (_, index) => [
    String(start + index),
    index % 2 === 0 ? 'Approved' : 'Refused'
  ]);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irish-visa-office-sources-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true });
  return {
    dir,
    dataDir,
    manifest: { generated_at: null, offices: [] },
    reportIndex: { offices: {} },
    manifestBySlug: new Map()
  };
}

function context(state, html, files) {
  return {
    dataDir: state.dataDir,
    manifest: state.manifest,
    reportIndex: state.reportIndex,
    manifestBySlug: state.manifestBySlug,
    fetchPage: async () => ({ text: async () => html }),
    fetchFile: async (url) => {
      if (!files[url]) throw new Error(`unexpected file request: ${url}`);
      return files[url];
    }
  };
}

const BEIJING = {
  name: 'Beijing',
  page: 'https://example.test/beijing/visa-decisions/',
  kind: 'cumulative',
  official: 'Embassy of Ireland, Beijing'
};

const ABUJA = {
  name: 'Abuja',
  page: 'https://example.test/abuja/weekly-decision-reports/',
  kind: 'pdf',
  preserveHistory: true,
  probeCandidates: true,
  official: 'Embassy of Ireland, Abuja'
};

test('Beijing ingests the cumulative PDF it switched to from ODS', async () => {
  const state = setup();
  const pdfUrl = 'https://example.test/files/Beijing_Visa_Decisions_01_January_to_22_November_2026.pdf';
  const html =
    `<html><body><a href="/files/Beijing_Visa_Decisions_01_January_to_22_November_2026.pdf">` +
    'Beijing Visa Decisions 01 January to 22 November 2026</a></body></html>';
  const files = {
    [pdfUrl]: fixturePdf({ periodStart: '01/01/2026', periodEnd: '22/11/2026', rows: rows(12) })
  };

  try {
    const summary = await ingestOffice('beijing', BEIJING, context(state, html, files));

    assert.equal(summary.status, 'official');
    assert.equal(summary.report_date, '2026-11-22', 'report date comes from the PDF period');
    assert.equal(summary.decisions, 12);
    assert.match(summary.source_file, /\.pdf$/);

    const stored = JSON.parse(fs.readFileSync(path.join(state.dataDir, 'embassy-beijing.json'), 'utf8'));
    assert.equal(stored.decisions.length, 12);
    assert.equal(stored.decisions[0].date, '2026-11-22');
    assert.equal(stored.data_status, 'official');
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});

test('Beijing still prefers a spreadsheet when the office publishes one', async () => {
  const state = setup();
  const html =
    '<html><body>' +
    '<a href="/files/beijing.pdf">Beijing Visa Decisions 22 November 2026</a>' +
    '<a href="/files/beijing.xlsx">Beijing Visa Decisions spreadsheet</a>' +
    '</body></html>';
  const files = {
    'https://example.test/files/beijing.pdf': fixturePdf({
      periodStart: '01/01/2026',
      periodEnd: '22/11/2026',
      rows: rows(12)
    })
  };

  try {
    // The spreadsheet is chosen, so the ingest fails on the fixture's missing
    // xlsx rather than silently falling back to the PDF.
    await assert.rejects(
      () => ingestOffice('beijing', BEIJING, context(state, html, files)),
      /unexpected file request: .*beijing\.xlsx/
    );
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});

test('Abuja keeps the file content date when an upload is mislabelled', async () => {
  const state = setup();
  const newerLabelUrl = 'https://example.test/5331/decision_01_to_07_novem.pdf';
  const otherUrl = 'https://example.test/5336/decision_01_to_07_novem_QqUA2e5.pdf';
  const html =
    '<html><body>' +
    `<a href="/5331/decision_01_to_07_novem.pdf">Abuja Visa Decisions 08 November to 14 November 2026</a>` +
    `<a href="/5336/decision_01_to_07_novem_QqUA2e5.pdf">Abuja Visa Decisions 01 November to 07 November 2026</a>` +
    '</body></html>';
  // Both uploads contain the 01-07 November week, exactly as the office
  // published them in November 2026.
  const week = fixturePdf({ periodStart: '01/11/2026', periodEnd: '07/11/2026', rows: rows(11) });
  const files = { [newerLabelUrl]: week, [otherUrl]: week };

  try {
    const summary = await ingestOffice('abuja', ABUJA, context(state, html, files));

    assert.equal(summary.report_date, '2026-11-07', 'the file period wins over the label');
    assert.equal(summary.decisions, 11);
    assert.match(summary.note, /labelled up to 2026-11-14/);
    assert.match(summary.note, /covers up to 2026-11-07/);
    assert.equal(summary.status, 'official');
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});

test('Abuja picks a later week even when it is not the first link', async () => {
  const state = setup();
  const olderUrl = 'https://example.test/5331/decision_01_to_07_novem.pdf';
  const newerUrl = 'https://example.test/5340/decision_08_to_14_novem.pdf';
  const html =
    '<html><body>' +
    `<a href="/5331/decision_01_to_07_novem.pdf">Abuja Visa Decisions 01 November to 07 November 2026</a>` +
    `<a href="/5340/decision_08_to_14_novem.pdf">Abuja Visa Decisions 08 November to 14 November 2026</a>` +
    '</body></html>';
  const files = {
    [olderUrl]: fixturePdf({ periodStart: '01/11/2026', periodEnd: '07/11/2026', rows: rows(11) }),
    [newerUrl]: fixturePdf({ periodStart: '08/11/2026', periodEnd: '14/11/2026', rows: rows(13, 50000000) })
  };

  try {
    const summary = await ingestOffice('abuja', ABUJA, context(state, html, files));

    assert.equal(summary.report_date, '2026-11-14');
    assert.equal(summary.decisions, 13);
    assert.equal(summary.source_file, newerUrl);
    assert.equal(summary.note, null);
  } finally {
    fs.rmSync(state.dir, { recursive: true, force: true });
  }
});
