/**
 * Historical Backfill Script
 * Fetches older years' data from archived ODS/PDF URLs
 * Run once to populate historical data
 *
 * Usage:
 *   node backfill-historical.js                 # all enabled offices
 *   node backfill-historical.js --office ankara # Ankara only
 *   node backfill-historical.js --ankara        # shorthand for Ankara only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { parseODSCumulative, discoverODSUrl } from './functions/parsers/ods-cumulative.js';
import { parseHTMLPaginated } from './functions/parsers/html-paginated.js';
import { ocrPdfBuffer, parseOcrDecisionText, parseReportPeriodEnd } from './tools/ankara-ocr.mjs';
import { decisionChecksum } from './tools/embassy-checksum.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve('.', 'data');

const REPO_RAW = 'https://raw.githubusercontent.com/parth-soni-10/Irish-Visa-Tracker/main';

const embassyConfig = JSON.parse(readFileSync('./embassy-config.json', 'utf-8'));

const args = process.argv.slice(2);
function argValue(flag) {
  const index = args.indexOf(flag);
  if (index !== -1) {
    const value = args[index + 1];
    return value && !value.startsWith('--') ? value : null;
  }
  const prefix = `${flag}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || null;
}

const officeArg = argValue('--office');
if (args.includes('--office') && !officeArg) {
  console.error('Usage: node backfill-historical.js --office ankara');
  process.exit(1);
}
const ONLY_OFFICE = officeArg || (args.includes('--ankara') ? 'ankara' : null);
if (ONLY_OFFICE && !embassyConfig.embassies.some((office) => office.slug === ONLY_OFFICE)) {
  console.error(`Unknown office: ${ONLY_OFFICE}`);
  process.exit(1);
}

// Historical URL patterns for each embassy
const HISTORICAL_URLS = {
  'new-delhi': {
    baseUrl: 'https://www.ireland.ie/en/india/newdelhi/services/visas/processing-times-and-decisions/',
    // ODS files follow pattern: YYYYMMDD_NDVO_Visa_Decisions.ods
    // Archive pages may list older files
  },
  'beijing': {
    baseUrl: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
    // Pattern: YYYYMMDD_BVO_visa_decisions.ods
  },
  'dublin': {
    baseUrl: 'https://www.irishimmigration.ie/visa-decisions/',
    // Paginated HTML table - may have year filter
  },
  'abu-dhabi': {
    baseUrl: 'https://www.ireland.ie/en/uae/abudhabi/services/visas/weekly-decision-reports/',
    // PDF archives
  },
  'abuja': {
    baseUrl: 'https://www.ireland.ie/en/nigeria/abuja/services/visas/weekly-decision-reports/',
    // PDF archives
  },
  'ankara': {
    baseUrl: 'https://www.ireland.ie/en/turkiye/ankara/services/visas/weekly-decision-report/',
    // PDF archives (scanned/vector-path; use the Ankara OCR path)
  }
};

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
  const localPath = resolve(DATA_DIR, `embassy-${slug}.json`);
  if (existsSync(localPath)) {
    try {
      const data = JSON.parse(readFileSync(localPath, 'utf8'));
      return data.decisions || [];
    } catch (error) {
      console.warn(`[${slug}] Could not read local data: ${error.message}`);
    }
  }

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

async function discoverAllODSUrls(baseUrl) {
  // Try to find all ODS links on the page (including older ones)
  const response = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  const html = await response.text();
  
  // Look for all ODS links
  const odsMatches = html.match(/href="([^"]*\.ods)"/g);
  if (!odsMatches) return [];
  
  return odsMatches
    .map(m => m.replace(/href="([^"]*)"/, '$1'))
    .filter(h => h.includes('Visa_Decision') || h.includes('visa_decisions'))
    .map(h => new URL(h, baseUrl).href);
}

async function discoverAllPDFUrls(baseUrl) {
  const response = await fetch(baseUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  const html = await response.text();
  
  const pdfMatches = html.match(/href="([^"]*\.pdf)"/g);
  if (!pdfMatches) return [];
  
  return pdfMatches
    .map(m => m.replace(/href="([^"]*)"/, '$1'))
    .filter(h => h)
    .map(h => new URL(h, baseUrl).href);
}

async function parseAnkaraHistoricalPdf(buffer) {
  const ocr = await ocrPdfBuffer(buffer);
  const decisions = parseOcrDecisionText(ocr.text);
  if (!decisions.length) throw new Error('OCR found no decision rows');
  const date = parseReportPeriodEnd(ocr.text);
  return decisions.map((row) => ({
    ...row,
    date,
    embassy: 'ankara',
    date_basis: date ? 'report_period_end' : null,
  }));
}

async function scrapeEmbassyHistorical(embassy, year = null) {
  console.log(`[${embassy.slug}] Starting historical scrape...`);

  try {
    let decisions = [];

    if (embassy.parser === 'ods-cumulative') {
      // Try to discover all ODS URLs (current + historical)
      const odsUrls = await discoverAllODSUrls(embassy.url);
      console.log(`[${embassy.slug}] Found ${odsUrls.length} ODS URLs`);
      
      for (const odsUrl of odsUrls) {
        try {
          console.log(`[${embassy.slug}] Fetching ${odsUrl}`);
          const buffer = await fetchWithCache(odsUrl);
          const parsed = await parseODSCumulative(buffer, embassy.slug);
          decisions = mergeDecisions(decisions, parsed);
        } catch (e) {
          console.warn(`[${embassy.slug}] Failed to parse ${odsUrl}: ${e.message}`);
        }
      }
    } else if (embassy.parser === 'html-paginated') {
      decisions = await parseHTMLPaginated(embassy.url, embassy.slug);
    } else if (embassy.parser === 'pdf-weekly') {
      const pdfUrls = await discoverAllPDFUrls(embassy.url);
      console.log(`[${embassy.slug}] Found ${pdfUrls.length} PDF URLs`);

      // Ankara's page lists newest first. Process oldest first so the newest
      // official row wins if a number appears in overlapping reports.
      if (embassy.slug === 'ankara') pdfUrls.reverse();

      for (const pdfUrl of pdfUrls) {
        try {
          console.log(`[${embassy.slug}] Fetching ${pdfUrl}`);
          let parsed;
          if (embassy.slug === 'ankara') {
            const buffer = Buffer.from(await fetchWithCache(pdfUrl));
            parsed = await parseAnkaraHistoricalPdf(buffer);
            console.log(`[${embassy.slug}] OCR extracted ${parsed.length} decisions`);
          } else {
            // Load lazily: the generic PDF parser needs native canvas for its
            // OCR fallback, which Ankara's dedicated OCR path does not use.
            const { parsePDFWeekly } = await import('./functions/parsers/pdf-weekly.js');
            parsed = await parsePDFWeekly(pdfUrl, embassy.slug);
          }
          decisions = mergeDecisions(decisions, parsed);
        } catch (e) {
          console.warn(`[${embassy.slug}] Failed to parse ${pdfUrl}: ${e.message}`);
        }
      }
    }

    // Load existing and merge
    const existing = await loadExistingDecisions(embassy.slug);
    const merged = mergeDecisions(existing, decisions);

    console.log(`[${embassy.slug}] ${decisions.length} parsed, ${merged.length} total`);
    return merged;
  } catch (error) {
    console.error(`[${embassy.slug}] Historical scrape failed:`, error);
    return [];
  }
}

async function runHistoricalBackfill() {
  const label = ONLY_OFFICE ? `${ONLY_OFFICE} only` : 'all embassies';
  console.log(`Starting historical backfill for ${label}...`);

  const enabled = embassyConfig.embassies.filter(e => e.enabled && (!ONLY_OFFICE || e.slug === ONLY_OFFICE));
  if (!enabled.length) {
    console.error(`No enabled office matched ${ONLY_OFFICE || 'the configuration'}.`);
    process.exitCode = 1;
    return;
  }
  const results = {};

  for (const embassy of enabled) {
    const decisions = await scrapeEmbassyHistorical(embassy);
    results[embassy.slug] = decisions;
  }

  // Write to files
  if (!existsSync('data')) {
    mkdirSync('data', { recursive: true });
  }

  for (const [slug, decisions] of Object.entries(results)) {
    const config = embassyConfig.embassies.find(e => e.slug === slug);
    const filePath = resolve('data', `embassy-${slug}.json`);
    let output;
    if (existsSync(filePath)) {
      output = JSON.parse(readFileSync(filePath, 'utf8'));
    } else {
      output = {
        office: slug,
        name: config?.name || slug,
        source_url: config?.url || '',
        decisions: [],
      };
    }
    output.office = output.office || slug;
    output.checksum = decisionChecksum(decisions);
    output.decisions = decisions;
    writeFileSync(filePath, JSON.stringify(output, null, 2));
    console.log(`Wrote data/embassy-${slug}.json (${decisions.length} decisions)`);
  }

  console.log('Historical backfill completed!');
}

runHistoricalBackfill().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});