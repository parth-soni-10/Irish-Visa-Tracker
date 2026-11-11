/**
 * Fail the ingestion job if Ankara's published file is still empty or if the
 * OCR output and provenance files disagree.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decisionChecksum } from './embassy-checksum.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OFFICE_FILE = path.join(DATA, 'embassy-ankara.json');
const MANIFEST_FILE = path.join(DATA, 'data_manifest.json');
const REPORT_INDEX_FILE = path.join(DATA, 'reports', 'index.json');

export function verifyAnkaraData(office, manifest, reportIndex) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!office) {
    fail('embassy-ankara.json is unavailable');
    return errors;
  }
  if (!manifest) fail('data_manifest.json is unavailable');
  if (!reportIndex) fail('data/reports/index.json is unavailable');

  const decisions = Array.isArray(office.decisions) ? office.decisions : [];
  if (office.office !== 'ankara') fail('embassy-ankara.json is not for Ankara');
  if (office.data_status !== 'official') fail(`data_status is ${office.data_status}, expected official`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(office.report_date || ''))) {
    fail(`invalid report_date: ${office.report_date}`);
  }
  if (!String(office.source_file || '').toLowerCase().endsWith('.pdf')) {
    fail('source_file is not a PDF');
  }
  if (decisions.length < 10) fail(`only ${decisions.length} decisions extracted`);
  const currentReport = decisions.filter((row) => row.date === office.report_date);
  if (currentReport.length < 10) {
    fail(`only ${currentReport.length} current-report decisions extracted`);
  }

  const seen = new Set();
  let approved = 0;
  let refused = 0;
  for (const row of decisions) {
    const number = String(row.number || '');
    if (!/^\d{7,10}$/.test(number)) fail(`invalid application number: ${number}`);
    if (row.decision !== 'Approved' && row.decision !== 'Refused') {
      fail(`invalid decision for ${number}: ${row.decision}`);
    }
    if (row.embassy !== 'ankara') fail(`wrong embassy for ${number}: ${row.embassy}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || ''))) {
      fail(`invalid date for ${number}: ${row.date}`);
    }
    if (row.date > office.report_date) fail(`date is after report date for ${number}: ${row.date}`);
    if (row.date_basis !== 'report_period_end') fail(`wrong date basis for ${number}: ${row.date_basis}`);
    if (seen.has(number)) fail(`duplicate application number: ${number}`);
    seen.add(number);
    if (row.date === office.report_date) {
      if (row.decision === 'Approved') approved += 1;
      else refused += 1;
    }
  }

  const checksum = decisionChecksum(decisions);
  if (!/^[0-9a-f]{16}$/.test(String(office.checksum || ''))) {
    fail(`invalid checksum: ${office.checksum}`);
  } else if (office.checksum !== checksum) {
    fail(`checksum ${office.checksum} does not match ${checksum} for ${decisions.length} decisions`);
  }

  const manifestOffice = Array.isArray(manifest && manifest.offices)
    ? manifest.offices.find((entry) => entry.slug === 'ankara')
    : null;
  if (!manifestOffice) fail('Ankara is missing from data_manifest.json');
  else {
    if (manifestOffice.status !== 'official') fail(`manifest status is ${manifestOffice.status}, expected official`);
    if (manifestOffice.decisions !== currentReport.length) {
      fail(`manifest decisions ${manifestOffice.decisions} != current-report decisions ${currentReport.length}`);
    }
    if (manifestOffice.approved !== approved) fail(`manifest approved ${manifestOffice.approved} != ${approved}`);
    if (manifestOffice.refused !== refused) fail(`manifest refused ${manifestOffice.refused} != ${refused}`);
    if (manifestOffice.report_date !== office.report_date) fail('manifest report_date differs from office file');
  }

  const latest = reportIndex && reportIndex.offices && Array.isArray(reportIndex.offices.ankara)
    ? reportIndex.offices.ankara[0]
    : null;
  if (!latest) fail('Ankara is missing from data/reports/index.json');
  else {
    if (latest.decisions !== currentReport.length) fail('report index decisions differ from current-report decisions');
    if (latest.approved !== approved) fail('report index approved count differs from office file');
    if (latest.refused !== refused) fail('report index refused count differs from office file');
    if (latest.report_date !== office.report_date) fail('report index report_date differs from office file');
    const currentChecksum = decisionChecksum(currentReport);
    if (latest.checksum !== currentChecksum) {
      fail(
        `report index checksum ${latest.checksum} does not match ${currentChecksum} ` +
          `for ${currentReport.length} current-report decisions`
      );
    }
  }

  return errors;
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Ankara verification failed: could not read ${path.relative(ROOT, file)}: ${error.message}`);
    return null;
  }
}

function main() {
  const office = readJSON(OFFICE_FILE);
  const manifest = readJSON(MANIFEST_FILE);
  const reportIndex = readJSON(REPORT_INDEX_FILE);
  const errors = verifyAnkaraData(office, manifest, reportIndex);

  if (errors.length) {
    for (const error of errors) console.error(`Ankara verification failed: ${error}`);
    process.exitCode = 1;
    return;
  }

  const decisions = office.decisions;
  const currentReport = decisions.filter((row) => row.date === office.report_date);
  const approved = currentReport.filter((row) => row.decision === 'Approved').length;
  const refused = currentReport.length - approved;
  const historical = decisions.length - currentReport.length;
  console.log(
    `Ankara verification passed: ${currentReport.length} current decisions ` +
      `(${approved} approved, ${refused} refused), ${historical} historical rows, report ${office.report_date}.`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
