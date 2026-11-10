import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOcrDecisionText, parseReportPeriodEnd } from '../tools/ankara-ocr.mjs';

test('parses the Ankara OCR table and deduplicates application numbers', () => {
  const text = [
    'Application Decisions:',
    'Decisions for period from 24/10/2026 to 01/11/2026',
    'Application Number | Decision',
    '| 74576782 | Approved |',
    '81703362   Refused',
    '85744882 Approved',
    '85744882 Refused',
    'not a decision row',
  ].join('\n');

  assert.deepEqual(parseOcrDecisionText(text), [
    { number: '74576782', decision: 'Approved' },
    { number: '81703362', decision: 'Refused' },
    { number: '85744882', decision: 'Refused' },
  ]);
});

test('finds the report period end in OCR header text', () => {
  assert.equal(
    parseReportPeriodEnd('Decisions for period from 24/10/2026 to 01/11/2026'),
    '2026-11-01'
  );
  assert.equal(parseReportPeriodEnd('Report date 2026-11-01'), '2026-11-01');
});
