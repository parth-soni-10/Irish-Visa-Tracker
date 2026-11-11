/**
 * Verify that every embassy data file and its current report-index entry carry
 * the checksum of the rows they describe.
 *
 * Weekly PDF offices keep historical rows in their office files, so an office
 * checksum covers the full archive while its report-index checksum covers only
 * the current report. The same current-report rule is applied to every office.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { decisionChecksum } from './embassy-checksum.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const REPORT_INDEX_FILE = path.join(DATA, 'reports', 'index.json');
const CHECKSUM_PATTERN = /^[0-9a-f]{16}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function verifyEmbassyChecksums(offices, reportIndex) {
  const errors = [];
  const list = Array.isArray(offices) ? offices : [];

  if (!list.length) errors.push('no embassy data files found');

  for (const office of list) {
    const slug = office && office.office ? String(office.office) : '(unknown office)';
    const decisions = office && Array.isArray(office.decisions) ? office.decisions : null;
    if (!decisions) {
      errors.push(`${slug}: decisions are missing`);
      continue;
    }

    const checksum = decisionChecksum(decisions);
    if (!CHECKSUM_PATTERN.test(String(office.checksum || ''))) {
      errors.push(`${slug}: invalid checksum ${office.checksum}`);
    } else if (office.checksum !== checksum) {
      errors.push(`${slug}: checksum ${office.checksum} does not match ${checksum} for ${decisions.length} decisions`);
    }

    const currentReport = decisions.filter((row) => row.date === office.report_date);
    const entries = reportIndex && reportIndex.offices ? reportIndex.offices[slug] : null;
    if (!Array.isArray(entries) || !entries.length) {
      errors.push(`${slug}: missing report-index entries`);
      continue;
    }

    const seenDates = new Set();
    for (const [index, entry] of entries.entries()) {
      const date = String((entry && entry.report_date) || '');
      if (!DATE_PATTERN.test(date)) {
        errors.push(`${slug}: report-index entry ${index} has invalid report_date ${entry && entry.report_date}`);
      } else if (seenDates.has(date)) {
        errors.push(`${slug}: duplicate report-index entry for report_date ${date}`);
      } else {
        seenDates.add(date);
        if (date > office.report_date) {
          errors.push(`${slug}: report-index entry ${date} is newer than office report_date ${office.report_date}`);
        }
      }

      if (!Number.isInteger(entry && entry.decisions) || entry.decisions <= 0) {
        errors.push(`${slug}: report-index entry ${date || '(unknown date)'} has invalid decisions ${entry && entry.decisions}`);
      }
      if (!CHECKSUM_PATTERN.test(String((entry && entry.checksum) || ''))) {
        errors.push(`${slug}: report-index entry ${date || '(unknown date)'} has invalid checksum ${entry && entry.checksum}`);
      }
      if (!/^https?:\/\//.test(String((entry && entry.source_file) || ''))) {
        errors.push(`${slug}: report-index entry ${date || '(unknown date)'} is missing a source_file`);
      }
    }

    const currentEntry = entries.find((entry) => entry.report_date === office.report_date);
    if (!currentEntry) {
      errors.push(`${slug}: no report-index entry for report_date ${office.report_date}`);
      continue;
    }
    if (currentEntry.decisions !== currentReport.length) {
      errors.push(
        `${slug}: report-index decisions ${currentEntry.decisions} != current-report decisions ${currentReport.length}`
      );
    }

    const currentChecksum = decisionChecksum(currentReport);
    if (!CHECKSUM_PATTERN.test(String(currentEntry.checksum || ''))) {
      errors.push(`${slug}: invalid report-index checksum ${currentEntry.checksum}`);
    } else if (currentEntry.checksum !== currentChecksum) {
      errors.push(
        `${slug}: report-index checksum ${currentEntry.checksum} does not match ${currentChecksum} ` +
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
    console.error(`Embassy checksum verification failed: could not read ${path.relative(ROOT, file)}: ${error.message}`);
    return null;
  }
}

function main() {
  const officeFiles = fs
    .readdirSync(DATA)
    .filter((file) => /^embassy-.*\.json$/.test(file))
    .sort();
  const offices = officeFiles.map((file) => readJSON(path.join(DATA, file))).filter(Boolean);
  const reportIndex = readJSON(REPORT_INDEX_FILE);
  if (!reportIndex || offices.length !== officeFiles.length) {
    process.exitCode = 1;
    return;
  }

  const errors = verifyEmbassyChecksums(offices, reportIndex);
  if (errors.length) {
    for (const error of errors) console.error(`Embassy checksum verification failed: ${error}`);
    process.exitCode = 1;
    return;
  }

  const decisions = offices.reduce((total, office) => total + office.decisions.length, 0);
  console.log(`Embassy checksum verification passed: ${offices.length} files, ${decisions} decisions.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
