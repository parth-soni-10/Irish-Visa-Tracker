/**
 * Multi-Embassy Scraper Runner
 * Runs scrapers for all embassies and saves data to data/embassy-{slug}.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parseODSCumulative, discoverODSUrl } from './functions/parsers/ods-cumulative.js';
import { parseHTMLPaginated } from './functions/parsers/html-paginated.js';
import { parsePDFWeekly, discoverLatestPDF } from './functions/parsers/pdf-weekly.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const embassyConfig = JSON.parse(readFileSync('./embassy-config.json', 'utf-8'));

async function fetchWithCache(url) {
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/octet-stream',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.ireland.ie/',
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.arrayBuffer();
}

async function loadExistingDecisions(slug) {
  try {
    const response = await fetch(`https://raw.githubusercontent.com/parth-soni-10/Irish-Visa-Tracker/main/data/embassy-${slug}.json`);
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
      const odsUrl = await discoverODSUrl(embassy.url, embassy.slug);
      if (!odsUrl) {
        console.warn(`[${embassy.slug}] No ODS URL found`);
        return [];
      }
      const buffer = await fetchWithCache(odsUrl);
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

    const existing = await loadExistingDecisions(embassy.slug);
    const merged = mergeDecisions(existing, decisions);

    console.log(`[${embassy.slug}] ${decisions.length} new, ${merged.length} total`);
    return merged;
  } catch (error) {
    console.error(`[${embassy.slug}] Scrape failed:`, error);
    return [];
  }
}

async function runAllScrapers() {
  const enabled = embassyConfig.embassies.filter(e => e.enabled);
  const results = {};

  for (const embassy of enabled) {
    const decisions = await scrapeEmbassy(embassy);
    results[embassy.slug] = decisions;
  }

  return results;
}

async function writeDecisionsToFiles(results) {
  if (!existsSync('data')) {
    mkdirSync('data', { recursive: true });
  }

  for (const [slug, decisions] of Object.entries(results)) {
    const output = {
      embassy: slug,
      lastUpdated: new Date().toISOString(),
      sourceUrl: embassyConfig.embassies.find(e => e.slug === slug)?.url || '',
      decisions
    };
    const filePath = resolve('data', `embassy-${slug}.json`);
    writeFileSync(filePath, JSON.stringify(output, null, 2));
    console.log(`Wrote data/embassy-${slug}.json (${decisions.length} decisions)`);
  }
}

async function main() {
  console.log('Starting multi-embassy scrape...');
  const results = await runAllScrapers();
  await writeDecisionsToFiles(results);
  console.log('All scrapers completed!');
}

main().catch(console.error);