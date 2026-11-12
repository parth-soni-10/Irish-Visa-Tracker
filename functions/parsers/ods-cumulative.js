/**
 * ODS Cumulative Parser
 * 
 * Handles embassies that publish a single cumulative ODS spreadsheet
 * (New Delhi, Beijing). The file is replaced on each update with the
 * full year's data. We parse all rows and deduplicate by application number.
 */

import * as XLSX from 'xlsx';
import * as cheerio from 'cheerio';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (DATE_RE.test(s)) return s;
  // Try Excel serial date
  const num = Number(s);
  if (!isNaN(num) && num > 25569 && num < 50000) {
    const date = XLSX.SSF.parse_date_code(num);
    return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
  }
  return null;
}

function parseDecision(val) {
  if (!val) return null;
  const s = String(val).trim().toLowerCase();
  if (s.includes('approv') || s.includes('grant') || s.includes('accept') || s.includes('issu')) return 'Approved';
  if (s.includes('refus') || s.includes('reject') || s.includes('deny')) return 'Refused';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export async function parseODSCumulative(buffer, embassySlug) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 12) return [];

  // Extract date from period row (row 2): "Decisions for period from DD/MM/YYYY to DD/MM/YYYY"
  let periodEndDate = null;
  const periodRow = rows[2]?.[0] || '';
  const periodMatch = periodRow.match(/to\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (periodMatch) {
    const [dd, mm, yyyy] = periodMatch[1].split('/');
    periodEndDate = `${yyyy}-${mm}-${dd}`;
  }

  // Header is at row 9: ["", "Application Number", "Decision"]
  const headerRowIdx = 9;
  const headers = rows[headerRowIdx].map(h => String(h).trim().toLowerCase());
  
  // Column 1 = Application Number, Column 2 = Decision
  const numberCol = 1;
  const decisionCol = 2;
  const dateCol = -1; // No date column in data

  const dataRows = rows.slice(headerRowIdx + 2); // Skip header + duplicate header
  const decisions = [];
  const seen = new Set();

  for (const row of dataRows) {
    const num = String(row[numberCol] || '').trim();
    const decision = parseDecision(row[decisionCol]);

    if (!num || !/^\d{7,10}$/.test(num.replace(/\D/g, ''))) continue;
    const cleanNum = num.replace(/\D/g, '');
    if (seen.has(cleanNum)) continue;
    seen.add(cleanNum);

    decisions.push({
      number: cleanNum,
      decision,
      date: periodEndDate || new Date().toISOString().slice(0, 10),
      embassy: embassySlug
    });
  }

  return decisions;
}

export async function discoverODSUrl(baseUrl, embassySlug) {
  const response = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  const html = await response.text();
  const $ = cheerio.load(html);

  // Spreadsheet links: .ods historically, .xlsx since November 2026.
  const odsLinks = $('a').toArray()
    .map(a => $(a).attr('href'))
    .filter(h => h && /\.(?:ods|xlsx)(\?|$)/i.test(h));
  
  const visaOdsLinks = odsLinks.filter(h => h.includes('visa-decision') || h.includes('Visa_Decision') || h.includes('visa_decisions'));

  if (visaOdsLinks.length === 0) {
    if (odsLinks.length > 0) return new URL(odsLinks[0], baseUrl).href;
    return null;
  }

  return new URL(visaOdsLinks[0], baseUrl).href;
}