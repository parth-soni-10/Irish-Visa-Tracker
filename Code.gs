/**
 * Irish Visa Decision Tracker — Apps Script backend
 * ---------------------------------------------------
 * Deploy: paste into Apps Script bound to your Sheet (Extensions > Apps Script).
 * Enable Advanced Drive Service: Services (+) > Drive API > Add.
 * Run fetchAndAppendVisaData once manually, authorize, check Raw tab.
 * Scheduling (deliberately NOT set up yet, per request) — when ready:
 *   Triggers (clock icon) > Add Trigger > fetchAndAppendVisaData > Time-driven > Day timer.
 * Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone
 *   -> copy the /exec URL into dashboard.html WEB_APP_URL.
 *
 * Sheet rotation: Google Sheets caps a spreadsheet at MAX_CELLS_PER_SPREADSHEET
 * cells (10M). The Raw tab is 3 columns wide, so once it approaches ~95% of that
 * budget (~3.17M rows) this script automatically creates the next tab (Raw2,
 * Raw3, ...) and starts appending there. All Raw* tabs are treated as one
 * logical dataset: dedupe, placeholder cleanup, and the dashboard's JSON all
 * read across every Raw tab in order, so history is never split or lost.
 */

// ---------------- CONFIG ----------------
const SHEET_ID   = '16wCHAUP1l9Gaehmai6GTkjzPhYafV7fyOtGm2y2tb_I';
const PAGE_URL   = 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/';
const RAW_TAB    = 'Raw';
const RAW_HEADERS  = ['Date', 'Application Number', 'Decision'];

// Capacity limits — Google Sheets allows 10,000,000 cells per spreadsheet.
// The Raw tab uses RAW_HEADERS.length columns, so its practical row budget is
// (MAX_CELLS * CAPACITY_WARN_PCT) / columns. When the active Raw tab reaches
// that many rows, the next Raw tab (Raw2, Raw3, ...) is created automatically.
const MAX_CELLS_PER_SPREADSHEET = 10000000;
const CAPACITY_WARN_PCT = 0.95; // rotate at 95% of the cell budget
const ROW_CAPACITY = Math.floor((MAX_CELLS_PER_SPREADSHEET * CAPACITY_WARN_PCT) / RAW_HEADERS.length);
// -----------------------------------------

/** Entry point — run manually or via trigger later. */
function fetchAndAppendVisaData() {
  const odsUrl = findOdsLink_();
  if (!odsUrl) throw new Error('Could not find .ods link on page — site markup may have changed.');

  const fileName = decodeURIComponent(odsUrl.split('/').pop().split('?')[0]);
  const fetchDate = parseDateFromFilename_(fileName);

  const rows = parseOdsRows_(odsUrl, fileName);
  const { appNumberCol, decisionCol } = detectColumns_(rows[0]);
  if (appNumberCol === -1 || decisionCol === -1) {
    throw new Error('Could not detect IRL/Decision columns. Headers seen: ' + JSON.stringify(rows[0]));
  }

  const sheet = ensureRawCapacity_();
  const existingIrl = getExistingIrlSet_();

  const toAppend = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const irl = String(r[appNumberCol] || '').trim();
    const decision = String(r[decisionCol] || '').trim();
    if (!irl || existingIrl.has(irl)) continue; // skip blank / already-recorded, no dupes
    if (looksLikeHeader_(irl, decision)) continue; // guard against header row leaking in as data
    toAppend.push([fetchDate, irl, decision]);
    existingIrl.add(irl);
  }

  if (toAppend.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, RAW_HEADERS.length).setValues(toAppend);
  }
  Logger.log('Appended ' + toAppend.length + ' new rows (source file: ' + fileName + ')');
  return toAppend.length;
}

// ---------------- RAW SHEET ROTATION ----------------

/** Names of every Raw* tab in order: 'Raw', 'Raw2', 'Raw3', ... */
function getRawSheetNames_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const names = [];
  let i = 0;
  while (true) {
    const name = i === 0 ? RAW_TAB : RAW_TAB + (i + 1);
    if (!ss.getSheetByName(name)) break;
    names.push(name);
    i++;
  }
  return names;
}

/** The Raw* tab new rows should be written to (the newest one). Creates it if none exist. */
function getActiveRawSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const names = getRawSheetNames_();
  const activeName = names.length ? names[names.length - 1] : RAW_TAB;
  let sheet = ss.getSheetByName(activeName);
  if (!sheet) {
    sheet = ss.insertSheet(activeName);
    sheet.getRange(1, 1, 1, RAW_HEADERS.length).setValues([RAW_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * If the active Raw* tab is at/near row capacity, spin up the next tab and
 * return it; otherwise return the current active tab. Called before every
 * write so appends always land on a sheet with room to spare.
 */
function ensureRawCapacity_() {
  const sheet = getActiveRawSheet_();
  if (sheet.getLastRow() < ROW_CAPACITY) return sheet;

  const ss = SpreadsheetApp.openById(SHEET_ID);
  const names = getRawSheetNames_();
  const nextName = RAW_TAB + (names.length + 1);
  const next = ss.insertSheet(nextName);
  next.getRange(1, 1, 1, RAW_HEADERS.length).setValues([RAW_HEADERS]).setFontWeight('bold');
  next.setFrozenRows(1);
  Logger.log('Raw tab at capacity (' + sheet.getLastRow() + ' rows) — created ' + nextName);
  return next;
}

// ---------------- SCRAPING HELPERS ----------------

/** Scrape the processing-times page HTML and find the .ods href. */
function findOdsLink_() {
  const resp = UrlFetchApp.fetch(PAGE_URL, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  const code = resp.getResponseCode();
  const html = resp.getContentText();
  Logger.log('HTTP status: ' + code + ' | HTML length: ' + html.length);

  // Try a few patterns — quotes, no-quotes, single vs double.
  let match = html.match(/href\s*=\s*["']([^"']+\.ods)["']/i);
  if (!match) match = html.match(/(https?:\/\/[^\s"'<>]+\.ods)/i);
  if (!match) {
    Logger.log('No .ods pattern matched. First 1500 chars of HTML:\n' + html.substring(0, 1500));
    return null;
  }
  let href = match[1];
  if (href.startsWith('//')) href = 'https:' + href;
  else if (href.startsWith('/')) href = 'https://www.ireland.ie' + href;
  Logger.log('Found ODS link: ' + href);
  return href;
}

/** TEMP DEBUG — run this alone, check the log, then tell Claude what it says. */
function debugFindLink() {
  const link = findOdsLink_();
  Logger.log('Result: ' + link);
}

/** TEMP DEBUG — tests whether the block is on the HTML page, the .ods file, or both. */
function debugTestBlock() {
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.ireland.ie/'
  };

  Logger.log('--- Test 1: HTML page, full browser headers ---');
  try {
    const r1 = UrlFetchApp.fetch(PAGE_URL, { muteHttpExceptions: true, headers: browserHeaders });
    Logger.log('Status: ' + r1.getResponseCode() + ' | Length: ' + r1.getContentText().length);
  } catch (e) { Logger.log('Threw: ' + e); }

  Logger.log('--- Test 2: Direct .ods file, full browser headers ---');
  const directOdsUrl = 'https://www.ireland.ie/4980/20260712_NDVO_Visa_Decisions.ods';
  try {
    const r2 = UrlFetchApp.fetch(directOdsUrl, { muteHttpExceptions: true, headers: browserHeaders });
    Logger.log('Status: ' + r2.getResponseCode() + ' | Bytes: ' + r2.getBlob().getBytes().length);
  } catch (e) { Logger.log('Threw: ' + e); }

  Logger.log('--- Test 3: Direct .ods file, no custom headers at all ---');
  try {
    const r3 = UrlFetchApp.fetch(directOdsUrl, { muteHttpExceptions: true });
    Logger.log('Status: ' + r3.getResponseCode() + ' | Bytes: ' + r3.getBlob().getBytes().length);
  } catch (e) { Logger.log('Threw: ' + e); }
}

/** First 8 chars of filename -> Date. Expects YYYYMMDD prefix. */
function parseDateFromFilename_(fileName) {
  const digits = fileName.replace(/[^0-9]/g, '');
  const stamp = digits.substring(0, 8);
  if (stamp.length !== 8) return new Date(); // fallback: today
  const y = +stamp.substring(0, 4), m = +stamp.substring(4, 6), d = +stamp.substring(6, 8);
  return new Date(y, m - 1, d);
}

/** Download .ods, convert to a temp Google Sheet via Drive API, read values, clean up. */
function parseOdsRows_(odsUrl, fileName) {
  const blob = UrlFetchApp.fetch(odsUrl, { muteHttpExceptions: true }).getBlob().setName(fileName);

  // Requires Advanced Drive Service enabled (Services > Drive API).
  const file = Drive.Files.create(
    { name: 'tmp_import_' + fileName, mimeType: MimeType.GOOGLE_SHEETS },
    blob,
    { fields: 'id' }
  );

  try {
    const ss = SpreadsheetApp.openById(file.id);
    const values = ss.getSheets()[0].getDataRange().getValues();
    return values;
  } finally {
    Drive.Files.remove(file.id); // delete temp converted file
  }
}

/** Fuzzy-match header row to find IRL number column + Decision column. */
function detectColumns_(headerRow) {
  let appNumberCol = -1, decisionCol = -1;
  headerRow.forEach((h, i) => {
    const s = String(h).toLowerCase();
    if (appNumberCol === -1 && (s.includes('irl') || s.includes('application'))) appNumberCol = i;
    if (decisionCol === -1 && (s.includes('decision') || s.includes('outcome'))) decisionCol = i;
  });
  return { appNumberCol, decisionCol };
}


/** Every IRL number already recorded, across ALL Raw* tabs. */
function getExistingIrlSet_() {
  const set = new Set();
  const ss = SpreadsheetApp.openById(SHEET_ID);
  getRawSheetNames_().forEach(name => {
    const sheet = ss.getSheetByName(name);
    const last = sheet.getLastRow();
    if (last < 2) return;
    sheet.getRange(2, 2, last - 1, 1).getValues().forEach(r => { if (r[0]) set.add(String(r[0]).trim()); });
  });
  return set;
}

// ---------------- WEB APP: JSON API for dashboard ----------------

function doGet(e) {
  const action = (e.parameter.action || 'raw');
  let payload;
  if (action === 'raw') {
    payload = getAllRawRows_();
  } else {
    payload = { error: 'unknown action' };
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** All rows from every Raw* tab, concatenated in tab order. */
function getAllRawRows_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const out = [];
  getRawSheetNames_().forEach(name => {
    const sheet = ss.getSheetByName(name);
    const last = sheet.getLastRow();
    if (last < 2) return;
    const values = sheet.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
    for (let i = 0; i < values.length; i++) {
      const r = values[i];
      out.push([isoDate_(r[0]), String(r[1]), String(r[2])]); // [date, irl, decision] — compact array, not object
    }
  });
  return out;
}

/** Fast manual date formatting — avoids Utilities.formatDate's per-call timezone lookup,
 *  which is the main slowdown at thousands of rows. */
function isoDate_(d) {
  if (!(d instanceof Date)) d = new Date(d);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Handles the scraper producers (JSON only):
 *  - real data: JSON POST { action: 'append_rows', rows: [{date, irl, decision}, ...] }
 *  - no-file fallback: JSON POST { action: 'set_no_file_placeholder', date, message }
 *  - placeholder cleanup: JSON POST { action: 'clear_no_file_placeholder', date }
 * Dashboard suggestions no longer post here — they go to Netlify Forms.
 */
function doPost(e) {
  const isJson = e.postData && e.postData.type === 'application/json';
  if (!isJson) return jsonOut_({ ok: false, error: 'json required' });
  const body = JSON.parse(e.postData.contents);
  if (body.action === 'append_rows') return handleAppendRows_(body.rows || []);
  if (body.action === 'set_no_file_placeholder') return handleSetNoFilePlaceholder_(body.date, body.message);
  if (body.action === 'clear_no_file_placeholder') return handleClearNoFilePlaceholder_(body.date);
  return jsonOut_({ ok: false, error: 'unknown action' });
}

/** Bulk append from external scraper. Dedupes against existing IRL numbers server-side too
 *  (across every Raw* tab). Rotates to a new tab first if the active one is near capacity.
 *  Also cleans up any stale "no file yet" placeholder for a date the moment real data lands for it. */
function handleAppendRows_(rows) {
  const sheet = ensureRawCapacity_();
  const existingIrl = getExistingIrlSet_();
  const toAppend = [];
  const datesIncoming = new Set();
  rows.forEach(r => {
    const irl = String(r.irl || '').trim();
    const decision = String(r.decision || '').trim();
    if (!irl || existingIrl.has(irl)) return;
    if (looksLikeHeader_(irl, decision)) return; // guard against header row leaking in as data
    toAppend.push([new Date(r.date), irl, decision]);
    existingIrl.add(irl);
    datesIncoming.add(String(r.date));
  });
  let placeholdersRemoved = 0;
  if (toAppend.length) {
    // Real data just arrived for these dates — remove any "no file yet" placeholder for them first.
    placeholdersRemoved = deleteRowsAcrossRawSheets_((date, irl) =>
      irl.indexOf('NO_FILE_') === 0 && datesIncoming.has(isoDate_(date)));
    sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, RAW_HEADERS.length).setValues(toAppend);
  }
  return jsonOut_({ ok: true, appended: toAppend.length, received: rows.length, placeholdersRemoved });
}

/** Upserts a "no file yet" placeholder row for a date — deletes any prior placeholder for that
 *  same date first (from any Raw* tab), so repeated failed runs on the same day never create
 *  duplicates and the message text always reflects the latest run. Safe to call every run. */
function handleSetNoFilePlaceholder_(date, message) {
  date = String(date || '').trim();
  message = String(message || "The visa office hasn't updated any file until now").trim();
  if (!date) return jsonOut_({ ok: false, error: 'date required' });

  const key = 'NO_FILE_' + date;
  const removed = deleteRowsAcrossRawSheets_((rowDate, irl) => irl === key);
  const sheet = ensureRawCapacity_();
  sheet.appendRow([new Date(date), key, message]);
  return jsonOut_({ ok: true, replaced: removed > 0 });
}

/** Removes a "no file yet" placeholder for a date — called once real data successfully
 *  arrives, since a stale "office hasn't updated" note for a now-superseded date is
 *  just noise at that point. Safe to call even if no placeholder exists (no-op). */
function handleClearNoFilePlaceholder_(date) {
  date = String(date || '').trim();
  if (!date) return jsonOut_({ ok: false, error: 'date required' });
  const key = 'NO_FILE_' + date;
  const removed = deleteRowsAcrossRawSheets_((rowDate, irl) => irl === key);
  return jsonOut_({ ok: true, removed });
}

/** Deletes matching rows from a single sheet (bottom-to-top, so indices don't shift mid-loop). */
function deleteRowsMatching_(sheet, predicateFn) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const values = sheet.getRange(2, 1, last - 1, RAW_HEADERS.length).getValues();
  let deleted = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const [date, irl, decision] = values[i];
    if (predicateFn(date, String(irl), String(decision))) {
      sheet.deleteRow(i + 2); // +1 for header row, +1 for 1-indexing
      deleted++;
    }
  }
  return deleted;
}

/** Deletes matching rows from EVERY Raw* tab, returning the total removed. */
function deleteRowsAcrossRawSheets_(predicateFn) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let deleted = 0;
  getRawSheetNames_().forEach(name => {
    deleted += deleteRowsMatching_(ss.getSheetByName(name), predicateFn);
  });
  return deleted;
}

/** True if a row's values look like column labels rather than real data. */
function looksLikeHeader_(irl, decision) {
  const i = irl.toLowerCase(), d = decision.toLowerCase();
  return i === 'application number' || i === 'irl' || i === 'irl number' ||
         d === 'decision' || d === 'outcome';
}

/** ONE-TIME CLEANUP — run once manually to remove the old "Fetched At" column (D)
 *  from your already-populated Raw sheet. Safe to delete/ignore after running. */
function cleanupDeleteFetchedAtColumn() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(RAW_TAB);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = header.findIndex(h => String(h).trim() === 'Fetched At');
  if (colIdx === -1) {
    Logger.log('No "Fetched At" column found — already clean, or check header text.');
    return;
  }
  sheet.deleteColumn(colIdx + 1); // 1-indexed
  Logger.log('Deleted column ' + (colIdx + 1) + ' ("Fetched At").');
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

