/**
 * HTML Paginated Table Parser
 * 
 * Handles Dublin visa office which publishes an HTML table on
 * irishimmigration.ie with pagination.
 */

import * as cheerio from 'cheerio';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (DATE_RE.test(s)) return s;
  // Try formats like "07 Nov 2026", "07 November 2026"
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
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

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Irish-Visa-Tracker/1.0 (+https://irishvisaupdatetracker.pages.dev)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

export async function parseHTMLPaginated(baseUrl, embassySlug) {
  const decisions = [];
  const seen = new Set();
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= 50) { // Safety limit
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    const html = await fetchPage(url);
    const $ = cheerio.load(html);

    const rows = $('table tbody tr, table tr').toArray();
    let pageDecisions = 0;

    for (const row of rows) {
      const $row = $(row);
      const cells = $row.find('td, th').toArray().map(c => $(c).text().trim());

      // Skip header rows
      if (cells.some(c => /^(application|number|decision|date|ref)/i.test(c))) continue;
      if (cells.length < 2) continue;

      // Try to find number, decision, date columns
      let number = null, decision = null, date = null;

      for (const cell of cells) {
        const clean = cell.trim();
        if (/^\d{7,10}$/.test(clean.replace(/\D/g, ''))) {
          number = clean.replace(/\D/g, '');
        } else if (/^(approved|refused|granted|refused)$/i.test(clean)) {
          decision = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        } else if (DATE_RE.test(clean) || /^\d{1,2}\s+\w+\s+\d{4}$/i.test(clean)) {
          date = parseDate(clean);
        }
      }

      if (number && decision && !seen.has(number)) {
        seen.add(number);
        decisions.push({
          number,
          decision,
          date: date || new Date().toISOString().slice(0, 10),
          embassy: embassySlug
        });
        pageDecisions++;
      }
    }

    if (pageDecisions === 0) break;

    // Check for next page
    const nextLink = $('a[rel="next"], a:contains("Next"), a:contains("»")').first();
    if (nextLink.length === 0) break;
    page++;
  }

  return decisions;
}