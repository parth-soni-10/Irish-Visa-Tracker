/**
 * Real Irish visa decision ingestion.
 *
 * Replaces the old 500-row synthetic `data/embassy-*.json` fixtures with the
 * latest official publication for each office:
 *
 *   new-delhi  ireland.ie ODS        (cumulative year-to-date)
 *   beijing    ireland.ie ODS        (cumulative year-to-date)
 *   abu-dhabi  ireland.ie PDF        (weekly)
 *   abuja      ireland.ie PDF        (weekly)
 *   ankara     ireland.ie PDF        (weekly, scanned - OCR needed)
 *   dublin     irishimmigration.ie   (HTML table, updated weekly)
 *
 * It also records provenance (report date, source file, checksum, change log)
 * in data/data_manifest.json + data/reports/index.json, and scrapes the Dublin
 * visa queue and the IRP renewal queue.
 *
 * Usage:
 *   node tools/scrape-embassies.mjs
 *   node tools/scrape-embassies.mjs --office dublin
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import { ocrPdfBuffer, parseOcrDecisionText } from './ankara-ocr.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const REPORTS = path.join(DATA, 'reports');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const OFFICES = {
  'new-delhi': {
    name: 'New Delhi',
    page: 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
    kind: 'ods',
    official: 'Embassy of Ireland, New Delhi',
  },
  beijing: {
    name: 'Beijing',
    page: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
    kind: 'ods',
    official: 'Embassy of Ireland, Beijing',
  },
  'abu-dhabi': {
    name: 'Abu Dhabi',
    page: 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
    kind: 'pdf',
    official: 'Embassy of Ireland, Abu Dhabi',
  },
  abuja: {
    name: 'Abuja',
    page: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
    kind: 'pdf',
    official: 'Embassy of Ireland, Abuja',
  },
  ankara: {
    name: 'Ankara',
    page: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/',
    kind: 'pdf',
    ocr: true,
    official: 'Embassy of Ireland, Ankara',
  },
  dublin: {
    name: 'Dublin',
    page: 'https://www.irishimmigration.ie/visa-decisions/',
    kind: 'html',
    official: 'Immigration Service Delivery, Dublin Visa Office',
  },
};

const DUBLIN_QUEUE_URL =
  'https://www.irishimmigration.ie/visa-decisions/';
const IRP_QUEUE_URL =
  'https://www.irishimmigration.ie/registering-your-immigration-permission/how-to-renew-your-current-permission/renewing-your-registration-permission-if-you-live-in-the-republic-of-ireland/';

const args = process.argv.slice(2);
const only = args.includes('--office') ? args[args.indexOf('--office') + 1] : null;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

async function fetchText(url, referer = 'https://www.ireland.ie/') {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: referer,
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res;
}

async function fetchBuffer(url, referer) {
  const res = await fetchText(url, referer);
  return Buffer.from(await res.arrayBuffer());
}

function absolute(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function parseDMY(text) {
  const m = String(text).match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/g);
  return m || [];
}

function toISOFromDMY(value) {
  const m = String(value).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  const day = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toISOFromLongDate(value) {
  const m = String(value).trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = months.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function periodEnd(text) {
  const dates = parseDMY(text);
  if (dates.length) {
    const isos = dates.map(toISOFromDMY).filter(Boolean).sort();
    if (isos.length) return isos[isos.length - 1];
  }
  return null;
}

function validDecision(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'approved' || v === 'granted') return 'Approved';
  if (v === 'refused' || v === 'rejected') return 'Refused';
  return null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function decisionMap(rows) {
  const map = new Map();
  for (const row of rows) {
    const number = String(row.number || '').trim();
    const decision = validDecision(row.decision);
    if (number && decision) map.set(number, decision);
  }
  return map;
}

function diffDecisions(previous, next) {
  const before = decisionMap(previous);
  const after = decisionMap(next);
  const changed = [];
  let added = 0;
  let removed = 0;
  for (const [number, decision] of after) {
    if (!before.has(number)) added++;
    else if (before.get(number) !== decision) changed.push({ number, from: before.get(number), to: decision });
  }
  for (const number of before.keys()) if (!after.has(number)) removed++;
  return { added, removed, changed };
}

/* ------------------------------------------------------------------ */
/* Source parsing                                                      */
/* ------------------------------------------------------------------ */

function findLatestFileLink($, pageUrl, kind) {
  const pattern = kind === 'ods' ? /\.ods(\?|$)/i : /\.pdf(\?|$)/i;
  let found = null;
  $('a').each((_, el) => {
    if (found) return;
    const href = $(el).attr('href') || '';
    if (!pattern.test(href)) return;
    found = {
      url: absolute(href, pageUrl),
      text: $(el).text().replace(/\s+/g, ' ').trim(),
    };
  });
  return found;
}

function parseOds(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => /application\s*(number|no|id)/i.test(String(cell)))
  );
  if (headerIndex < 0) throw new Error('ODS header not found');
  const header = rows[headerIndex];
  const numberCol = header.findIndex((cell) => /application\s*(number|no|id)/i.test(String(cell)));
  const decisionCol = header.findIndex((cell) => /^decision$/i.test(String(cell).trim()));
  if (numberCol < 0 || decisionCol < 0) throw new Error('ODS columns not found');

  const decisions = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const number = String(rows[i][numberCol] || '').trim();
    const decision = validDecision(rows[i][decisionCol]);
    if (/^\d{6,}$/.test(number) && decision) decisions.push({ number, decision });
  }
  return decisions;
}

function parsePdfText(text) {
  const decisions = [];
  const re = /^\s*(\d{6,})\s+(Approved|Refused)\s*$/gim;
  let match;
  while ((match = re.exec(text))) {
    decisions.push({ number: match[1], decision: match[2] });
  }
  return decisions;
}

async function parsePdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return { text: result.text || '', decisions: parsePdfText(result.text || '') };
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function parseDublin(html) {
  const $ = cheerio.load(html);
  const tables = $('table');
  let decisions = [];
  let queue = [];

  tables.each((index, table) => {
    const firstRow = $(table).find('tr').first().text().replace(/\s+/g, ' ').trim();
    if (/Application\s*Decision/i.test(firstRow)) {
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 2) return;
        const number = $(cells[0]).text().replace(/\s+/g, '').trim();
        const decision = validDecision($(cells[1]).text());
        if (/^\d{6,}$/.test(number) && decision) decisions.push({ number, decision });
      });
    } else if (/Visa type.*applications received/i.test(firstRow)) {
      $(table).find('tr').each((_, tr) => {
        const cells = $(tr).find('td');
        if (cells.length < 2) return;
        const category = $(cells[0]).text().replace(/\s+/g, ' ').trim();
        const received = toISOFromLongDate($(cells[1]).text().replace(/\s+/g, ' ').trim());
        const appeals = cells[2]
          ? toISOFromLongDate($(cells[2]).text().replace(/\s+/g, ' ').trim())
          : null;
        if (category && received) queue.push({ category, applications_received: received, appeals_received: appeals });
      });
    }
  });

  return { decisions, queue };
}

function parseIrpQueue(html) {
  const $ = cheerio.load(html);
  const categories = [];
  $('table').each((_, table) => {
    const header = $(table).find('tr').first().text().replace(/\s+/g, ' ').trim();
    if (!/stamp category.*submission date/i.test(header)) return;
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 2) return;
      const stamp = $(cells[0]).text().replace(/\s+/g, ' ').trim();
      const received = toISOFromDMY($(cells[1]).text().replace(/\s+/g, ' ').trim());
      if (stamp && received) categories.push({ stamp, received_date: received });
    });
  });
  return categories;
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

const manifest = readJSON(path.join(DATA, 'data_manifest.json'), { generated_at: null, offices: [] });
const reportIndex = readJSON(path.join(REPORTS, 'index.json'), { offices: {} });
const manifestBySlug = new Map((manifest.offices || []).map((o) => [o.slug, o]));

async function ingestOffice(slug, config) {
  const previous = readJSON(path.join(DATA, `embassy-${slug}.json`), { decisions: [] });
  const fetchedAt = new Date().toISOString();
  const pageResponse = await fetchText(config.page);
  const html = await pageResponse.text();
  const $ = cheerio.load(html);

  let decisions = [];
  let sourceFile = null;
  let reportDate = null;
  let status = 'official';
  let note = null;

  if (config.kind === 'html') {
    const parsed = parseDublin(html);
    decisions = parsed.decisions;
    // The Dublin table is a live snapshot; ISD updates it weekly but the page
    // does not expose a report date, so record when we fetched it.
    reportDate = fetchedAt.slice(0, 10);
    sourceFile = config.page;
    if (!decisions.length) throw new Error('Dublin decision table empty');
    const queue = {
      as_of: fetchedAt.slice(0, 10),
      source_url: DUBLIN_QUEUE_URL,
      categories: parsed.queue,
    };
    writeJSON(path.join(DATA, 'dublin_queues.json'), queue);
    manifest.dublin_queue = {
      as_of: queue.as_of,
      source_url: queue.source_url,
      categories: queue.categories.length,
    };
  } else {
    const link = findLatestFileLink($, config.page, config.kind);
    if (!link) throw new Error('No decision file link found');
    sourceFile = link.url;
    const buffer = await fetchBuffer(link.url, config.page);

    if (config.kind === 'ods') {
      decisions = parseOds(buffer);
      const periodText = (XLSX.read(buffer, { type: 'buffer' }) && '') || '';
      // Re-read the first rows for the period sentence (cheap, already in memory).
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      const periodRow = rows.find((row) => row.some((cell) => /decisions?\s+for\s+period/i.test(String(cell))));
      const periodText2 = periodRow ? periodRow.join(' ') : '';
      reportDate = periodEnd(periodText2) || periodEnd(link.text) || fetchedAt.slice(0, 10);
    } else {
      const parsed = await parsePdf(buffer);
      decisions = parsed.decisions;
      let text = parsed.text;
      let ocrNote = null;

      if (decisions.length < 10 && config.ocr) {
        try {
          const ocr = await ocrPdfBuffer(buffer);
          const ocrDecisions = parseOcrDecisionText(ocr.text);
          if (ocrDecisions.length < 10) {
            throw new Error(`OCR found only ${ocrDecisions.length} decision rows`);
          }
          decisions = ocrDecisions;
          text = ocr.text;
          ocrNote = `Scanned PDF extracted with ${ocr.engine} at ${ocr.dpi} DPI (${ocr.pages} pages).`;
          console.log(`[${slug}] OCR extracted ${decisions.length} decisions with ${ocr.engine}`);
        } catch (error) {
          status = 'ocr_required';
          note = `The published PDF is scanned; OCR failed: ${error.message}`;
          console.error(`[${slug}] OCR failed: ${error.message}`);
        }
      }

      reportDate = periodEnd(text) || periodEnd(link.text) || fetchedAt.slice(0, 10);
      if (decisions.length < 10) {
        status = 'ocr_required';
        note = note || 'The published PDF is scanned; text extraction found no decision rows. OCR is required.';
      } else if (ocrNote) {
        note = ocrNote;
      }
    }
  }

  // Normalize + dedupe (a number may appear twice; last wins).
  const byNumber = new Map();
  for (const row of decisions) {
    const number = String(row.number).replace(/\D/g, '');
    const decision = validDecision(row.decision);
    if (number.length >= 6 && decision) byNumber.set(number, decision);
  }
  const rows = [...byNumber.entries()].map(([number, decision]) => ({
    date: reportDate,
    number,
    decision,
    embassy: slug,
    date_basis: config.kind === 'html' ? 'fetched' : 'report_period_end',
  }));

  const approved = rows.filter((r) => r.decision === 'Approved').length;
  const diff = diffDecisions(previous.decisions || [], rows);
  const checksum = sha256(JSON.stringify([...byNumber.entries()].sort()));

  const officeFile = {
    office: slug,
    name: config.name,
    source_url: config.page,
    source_file: sourceFile,
    source_name: config.official,
    report_date: reportDate,
    as_of: fetchedAt.slice(0, 10),
    fetched_at: fetchedAt,
    data_status: status,
    date_basis: config.kind === 'html' ? 'fetched' : 'report_period_end',
    note,
    checksum,
    decisions: rows,
  };
  writeJSON(path.join(DATA, `embassy-${slug}.json`), officeFile);

  // Provenance / corrections log.
  const entries = reportIndex.offices[slug] || [];
  entries.unshift({
    report_date: reportDate,
    fetched_at: fetchedAt,
    decisions: rows.length,
    approved,
    refused: rows.length - approved,
    source_file: sourceFile,
    checksum,
    added: diff.added,
    removed: diff.removed,
    changed: diff.changed.slice(0, 200),
  });
  reportIndex.offices[slug] = entries.slice(0, 24);

  const summary = {
    slug,
    name: config.name,
    source_url: config.page,
    source_file: sourceFile,
    source_name: config.official,
    report_date: reportDate,
    as_of: fetchedAt.slice(0, 10),
    fetched_at: fetchedAt,
    status,
    note,
    decisions: rows.length,
    approved,
    refused: rows.length - approved,
    corrections: diff.changed.length,
    added: diff.added,
  };
  manifestBySlug.set(slug, summary);
  console.log(
    `${slug.padEnd(11)} ${String(rows.length).padStart(6)} decisions  ` +
      `report ${reportDate}  ${status}` +
      (diff.changed.length ? `  ${diff.changed.length} correction(s)` : '')
  );
  return summary;
}

async function ingestIrpQueue() {
  const html = await (await fetchText(IRP_QUEUE_URL)).text();
  const categories = parseIrpQueue(html);
  const file = {
    as_of: todayISO(),
    source_url: IRP_QUEUE_URL,
    categories,
  };
  writeJSON(path.join(DATA, 'irp_queues.json'), file);
  manifest.irp_queue = {
    as_of: file.as_of,
    source_url: file.source_url,
    categories: categories.length,
  };
  console.log(`irp-queue   ${String(categories.length).padStart(6)} categories  as of ${file.as_of}`);
}

async function main() {
  ensureDir(DATA);
  ensureDir(REPORTS);

  const targets = only ? [[only, OFFICES[only]]] : Object.entries(OFFICES);
  for (const [slug, config] of targets) {
    if (!config) throw new Error(`Unknown office: ${slug}`);
    try {
      await ingestOffice(slug, config);
    } catch (error) {
      const previous = manifestBySlug.get(slug) || { slug, name: config.name, source_url: config.page };
      manifestBySlug.set(slug, {
        ...previous,
        status: 'error',
        note: String(error.message || error),
        as_of: todayISO(),
      });
      console.error(`${slug}: ${error.message}`);
      if (!only) continue;
      process.exitCode = 1;
    }
  }

  if (!only) {
    try {
      await ingestIrpQueue();
    } catch (error) {
      console.error(`irp-queue: ${error.message}`);
    }
  }

  manifest.generated_at = new Date().toISOString();
  manifest.offices = Object.keys(OFFICES)
    .map((slug) => manifestBySlug.get(slug))
    .filter(Boolean);
  writeJSON(path.join(DATA, 'data_manifest.json'), manifest);
  writeJSON(path.join(REPORTS, 'index.json'), reportIndex);

  console.log(`\nWrote data/data_manifest.json and data/reports/index.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
