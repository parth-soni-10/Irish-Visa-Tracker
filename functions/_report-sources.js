/**
 * Resolve the public link for an archived report.
 *
 * New Delhi republishes one cumulative file and removes the previous file from
 * the same path. The historical file URLs remain useful provenance in
 * data/reports/index.json, but they now return 404. For those retired files,
 * link readers to the office's live source page instead of a dead document.
 */

export const NDVO_SOURCE_PAGE = 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/';

// The New Delhi files that have already been replaced by a newer cumulative
// report. Keep the historical URL in the archive; only the public link changes.
export const RETIRED_NDVO_SOURCE_URLS = new Set([
  'https://www.ireland.ie/5301/20261105_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5308/20261110_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5311/20261111_NDVO_Visa_Decisions.xlsx',
  'https://www.ireland.ie/5314/20261112_NDVO_Visa_Decisions.xlsx',
  'https://www.ireland.ie/5315/20261115_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5324/20261116_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5325/20261117_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5330/20261118_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5346/20261119_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5351/20261123_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5355/20261124_NDVO_Visa_Decisions.ods',
  'https://www.ireland.ie/5358/20261125_NDVO_Visa_Decisions.ods',
]);

const NDVO_FILE_URL = /^https:\/\/www\.ireland\.ie\/\d+\/\d{8}_NDVO_Visa_Decisions\.(?:ods|xlsx)$/i;

function isRetiredNdvoSource(entry, office) {
  if (String(office && office.slug || '') !== 'new-delhi') return false;
  const sourceFile = String(entry && entry.source_file || '').trim();
  if (RETIRED_NDVO_SOURCE_URLS.has(sourceFile)) return true;

  // A future cumulative file will follow the same URL shape. Once it is older
  // than the office's latest report, it is no longer safe to link directly.
  if (!NDVO_FILE_URL.test(sourceFile)) return false;
  const reportDate = String(entry && entry.report_date || '').slice(0, 10);
  const latestDate = String(office && office.report_date || '').slice(0, 10);
  return Boolean(reportDate && latestDate && reportDate < latestDate);
}

export function reportSource(entry = {}, office = {}) {
  const sourceFile = String(entry && entry.source_file || '').trim();
  const retired = isRetiredNdvoSource(entry, office);
  const fallbackPage = String(office && office.slug || '') === 'new-delhi' ? NDVO_SOURCE_PAGE : '';
  const href = retired
    ? String(office.source_url || fallbackPage)
    : (sourceFile || String(office.source_url || fallbackPage));
  return {
    href,
    retired,
    label: retired || !sourceFile ? 'Official page' : 'Official source',
  };
}
