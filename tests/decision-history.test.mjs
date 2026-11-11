import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decisionChecksum } from '../tools/embassy-checksum.mjs';
import { mergeDecisionHistory } from '../tools/decision-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDF_OFFICES = ['ankara', 'abu-dhabi', 'abuja'];
const offices = PDF_OFFICES.map((slug) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `embassy-${slug}.json`), 'utf8'))
);

test('re-merging the current weekly report preserves every archived row', () => {
  for (const office of offices) {
    const currentReport = office.decisions.filter((row) => row.date === office.report_date);
    const merged = mergeDecisionHistory(office.decisions, currentReport);

    assert.equal(merged.length, office.decisions.length, `${office.office} row count`);
    assert.equal(decisionChecksum(merged), office.checksum, `${office.office} checksum`);
    assert.ok(
      new Set(office.decisions.map((row) => row.date)).size > 1,
      `${office.office} has historical report dates`
    );
  }
});

test('a new weekly report appends rows without dropping older report dates', () => {
  for (const office of offices) {
    const currentReport = office.decisions.filter((row) => row.date === office.report_date);
    const historical = {
      ...office.decisions[0],
      number: '88888888',
      date: '2026-10-01',
      decision: 'Approved'
    };
    const fresh = {
      ...currentReport[0],
      number: '99999999',
      date: '2026-11-08',
      decision: 'Approved'
    };
    const merged = mergeDecisionHistory([historical, ...office.decisions], [fresh]);

    assert.equal(merged.length, office.decisions.length + 2, `${office.office} row count`);
    assert.ok(
      merged.some((row) => row.number === '88888888' && row.date === '2026-10-01'),
      `${office.office} historical row`
    );
    assert.ok(
      merged.some((row) => row.number === '99999999' && row.date === '2026-11-08'),
      `${office.office} new row`
    );
  }
});

test('a repeated application number is refreshed in place', () => {
  for (const office of offices) {
    const target = office.decisions[0];
    const merged = mergeDecisionHistory(office.decisions, [{
      ...target,
      date: '2026-11-08',
      decision: 'Refused'
    }]);

    assert.equal(merged.length, office.decisions.length, `${office.office} row count`);
    assert.equal(
      merged.find((row) => row.number === target.number).date,
      '2026-11-08',
      `${office.office} refreshed date`
    );
    assert.equal(
      merged.find((row) => row.number === target.number).decision,
      'Refused',
      `${office.office} refreshed decision`
    );
  }
});
