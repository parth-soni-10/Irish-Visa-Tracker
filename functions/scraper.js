/**
 * Multi-Embassy Scraper
 * 
 * Orchestrates scraping for all embassies defined in embassy-config.json.
 * Writes decisions to data/embassy-{slug}.json files.
 */

import embassyConfig from '../embassy-config.json';
import { parseODSCumulative } from './parsers/ods-cumulative.js';
import { parseHTMLPaginated } from './parsers/html-paginated.js';
import { parsePDFWeekly, discoverLatestPDF } from './parsers/pdf-weekly.js';

const REPO_RAW = 'https://raw.githubusercontent.com/parth-soni-10/Irish-Visa-Tracker/main';

async function fetchWithCache(url) {
  const response = await fetch(url, {
    headers: { 'Accept': 'application/octet-stream' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

async function loadExistingDecisions(slug) {
  try {
    const response = await fetch(`${REPO_RAW}/data/embassy-${slug}.json`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.decisions || [];
  } catch {
    return [];
  }
}

function mergeDecisions(existing, incoming) {
  const seen = new Map();
  for (const d of existing) seen.set(d.number, d);
  for (const d of incoming) seen.set(d.number, d);
  return Array.from(seen.values()).sort((a, b) => b.number.localeCompare(a.number));
}

async function scrapeEmbassy(embassy) {
  console.log(`[${embassy.slug}] Starting scrape...`);

  try {
    let decisions = [];

    if (embassy.parser === 'ods-cumulative') {
      const buffer = await fetchWithCache(embassy.url);
      decisions = await parseODSCumulative(buffer, embassy.slug);
    } else if (embassy.parser === 'html-paginated') {
      decisions = await parseHTMLPaginated(embassy.url, embassy.slug);
    } else if (embassy.parser === 'pdf-weekly') {
      const pdfUrl = await discoverLatestPDF(embassy.url, embassy.slug);
      if (!pdfUrl) {
        console.warn(`[${embassy.slug}] No PDF found`);
        return [];
      }
      decisions = await parsePDFWeekly(pdfUrl, embassy.slug);
    }

    // Load existing and merge
    const existing = await loadExistingDecisions(embassy.slug);
    const merged = mergeDecisions(existing, decisions);

    console.log(`[${embassy.slug}] ${decisions.length} new, ${merged.length} total`);
    return merged;
  } catch (error) {
    console.error(`[${embassy.slug}] Scrape failed:`, error);
    return [];
  }
}

export async function runAllScrapers() {
  const enabled = embassyConfig.embassies.filter(e => e.enabled);
  const results = {};

  for (const embassy of enabled) {
    const decisions = await scrapeEmbassy(embassy);
    results[embassy.slug] = decisions;
  }

  return results;
}

export async function writeDecisionsToFiles(results) {
  // This would be run in GitHub Actions to commit the JSON files
  // The Worker serves from GitHub raw, so we just need the files committed
  for (const [slug, decisions] of Object.entries(results)) {
    const output = {
      embassy: slug,
      lastUpdated: new Date().toISOString(),
      decisions
    };
    // In GitHub Actions, write to data/embassy-{slug}.json
    console.log(`Would write data/embassy-${slug}.json (${decisions.length} decisions)`);
  }
}