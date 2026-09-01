/**
 * Irish Visa Decision Tracker — Apps Script backend
 * ---------------------------------------------------
 * The sheet is fed by scraper.py (GitHub Actions), which fetches the embassy's
 * daily .ods file and pushes new rows here through the web app's POST endpoints.
 * This file owns the sheet (append/dedupe/placeholder/meta) and the health-card
 * meta. It never fetches the embassy itself.
 *
 * Deploy: paste into Apps Script bound to your Sheet (Extensions > Apps Script),
 * set VISA_WRITE_SECRET in Script Properties (same value as the VISAS_WRITE_SECRET
 * GitHub secret), then Deploy > New deployment > Web app > Execute as: Me > Who
 * has access: Anyone. Copy the /exec URL into the frontend's WEB_APP_URL and the
 * GitHub Actions WEB_APP_URL secret. No extra services (Drive API etc.) needed.
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

// ---------------- WRITE AUTHORIZATION ----------------
// Reads stay public; all writes require a shared secret the scraper sends.
// Set VISA_WRITE_SECRET in Apps Script Script properties and the identical
// value as the VISAS_WRITE_SECRET secret in GitHub Actions. Writes fail
// closed until a secret is configured.
const WRITE_SECRET_PROPERTY = 'VISA_WRITE_SECRET';
const WRITE_ACTIONS = ['append_rows', 'set_no_file_placeholder', 'clear_no_file_placeholder', 'update_meta'];
// Run-status object the scraper stores after every run; the dashboard reads it
// via ?action=meta for the health card, reconciliation line and closure calendar.
const META_PROPERTY = 'VISA_META';

function constantTimeEqual_(left, right) {
  left = String(left || '');
  right = String(right || '');
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) {
    result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return result === 0;
}

function authorizeWrite_(payload) {
  const expected = String(PropertiesService.getScriptProperties().getProperty(WRITE_SECRET_PROPERTY) || '').trim();
  if (!expected) return false;
  return constantTimeEqual_(String((payload && payload.writeSecret) || '').trim(), expected);
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
  } else if (action === 'meta') {
    const raw = PropertiesService.getScriptProperties().getProperty(META_PROPERTY);
    payload = raw ? JSON.parse(raw) : {};
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
  if (WRITE_ACTIONS.includes(body.action) && !authorizeWrite_(body)) {
    return jsonOut_({ ok: false, error: 'unauthorized' });
  }
  if (body.action === 'append_rows') return handleAppendRows_(body.rows || []);
  if (body.action === 'set_no_file_placeholder') return handleSetNoFilePlaceholder_(body.date, body.message);
  if (body.action === 'clear_no_file_placeholder') return handleClearNoFilePlaceholder_(body.date);  if (body.action === 'update_meta') return handleUpdateMeta_(body.meta);
  return jsonOut_({ ok: false, error: 'unknown action' });
}


/** Stores the scraper's run-status object (health card / reconciliation / closures). */
function handleUpdateMeta_(meta) {
  if (!meta || typeof meta !== 'object') {
    return jsonOut_({ ok: false, error: 'meta object required' });
  }
  PropertiesService.getScriptProperties().setProperty(
    META_PROPERTY, JSON.stringify({ updatedAt: new Date().toISOString(), ...meta }));
  return jsonOut_({ ok: true });
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

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

