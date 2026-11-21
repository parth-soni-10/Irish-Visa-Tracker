#!/usr/bin/env node
/**
 * Turn a Search Console Performance CSV export into a monthly content review.
 *
 * This reads an export; it does not call the Search Console API and does not
 * request indexing. The output surfaces:
 *   - high-impression, low-CTR queries that may need a clearer title/intro;
 *   - striking-distance queries (positions 5-20);
 *   - country/office terms present in queries, to compare with page copy.
 *
 *   node tools/search-console-review.mjs --file performance.csv
 *   node tools/search-console-review.mjs --file performance.csv --json
 */

import fs from 'node:fs';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function numberValue(value) {
  const cleaned = String(value || '').replace(/[,%]/g, '').trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function main() {
  const args = process.argv.slice(2);
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : '';
  if (!file) {
    console.error('Usage: node tools/search-console-review.mjs --file performance.csv [--json] [--min-impressions 100] [--max-ctr 2]');
    process.exit(2);
  }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (rows.length < 2) {
    console.error('The export has no data rows.');
    process.exit(1);
  }
  const header = rows[0].map(normalizeHeader);
  const index = (name) => header.indexOf(name);
  const queryIndex = index('query') >= 0 ? index('query') : index('top_queries');
  const clicksIndex = index('clicks');
  const impressionsIndex = index('impressions');
  const ctrIndex = index('ctr');
  const positionIndex = index('position');
  if (queryIndex < 0 || impressionsIndex < 0) {
    console.error('Expected columns: Query, Clicks, Impressions, CTR, Position.');
    process.exit(1);
  }

  const minImpressions = Number(args[args.indexOf('--min-impressions') + 1]) || 100;
  const maxCtr = Number(args[args.indexOf('--max-ctr') + 1]) || 2;
  const records = rows.slice(1).map((row) => ({
    query: String(row[queryIndex] || '').trim(),
    clicks: numberValue(row[clicksIndex]),
    impressions: numberValue(row[impressionsIndex]),
    ctr: numberValue(row[ctrIndex]),
    position: numberValue(row[positionIndex]),
  })).filter((row) => row.query && row.impressions > 0);

  const lowCtr = records
    .filter((row) => row.impressions >= minImpressions && row.ctr <= maxCtr)
    .sort((a, b) => b.impressions - a.impressions);
  const striking = records
    .filter((row) => row.position >= 5 && row.position <= 20 && row.impressions >= minImpressions)
    .sort((a, b) => a.position - b.position || b.impressions - a.impressions);
  const intent = records
    .filter((row) => /(india|nigeria|ghana|china|uae|dubai|abu dhabi|türkiye|turkey|azerbaijan|nepal|bangladesh|sri lanka|mongolia|senegal|ivory coast|côte)/i.test(row.query))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30);

  const report = {
    file,
    rows: records.length,
    thresholds: { minImpressions, maxCtr },
    highImpressionsLowCtr: lowCtr.slice(0, 30),
    strikingDistance: striking.slice(0, 30),
    countryIntentQueries: intent,
  };

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const print = (title, items, note) => {
    console.log(`\n${title}`);
    console.log('-'.repeat(title.length));
    if (!items.length) {
      console.log('No rows matched.');
      return;
    }
    for (const item of items) {
      console.log(`${item.impressions.toLocaleString('en-IE').padStart(9)} imp  ${item.ctr.toFixed(1).padStart(5)}% CTR  pos ${item.position.toFixed(1).padStart(5)}  ${item.query}`);
    }
    if (note) console.log(note);
  };

  console.log(`Search Console review: ${records.length} query row(s) from ${file}`);
  print(`High impressions, low CTR (>= ${minImpressions} impressions, <= ${maxCtr}% CTR)`, lowCtr);
  print('Striking distance (positions 5-20)', striking);
  print('Country/office intent in queries', intent);
  console.log('\nNext: compare the query wording with the page title, H1 and opening paragraph. Change the page, then use URL Inspection only for that URL. Do not mass-request indexing.');
}

main();
