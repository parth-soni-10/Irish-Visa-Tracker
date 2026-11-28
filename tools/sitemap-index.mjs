#!/usr/bin/env node
/**
 * Split the built sitemap into page families.
 *
 * One 130-URL sitemap cannot show which family is failing: a report permalink
 * and a trust page look the same in Search Console and Bing diagnostics. The
 * build still assembles one urlset (every generator appends to it), then this
 * module writes four family sitemaps and a sitemap index at /sitemap.xml, so
 * "office pages are indexed, report permalinks are not" is visible per family.
 *
 * The index stays the single URL in robots.txt, so nothing else has to change.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

// Ordered by crawl priority, not alphabetically: the office hubs and the date
// archive are the pages that need discovery first. Report permalinks stay in
// the index, but last, so they do not lead the queue for a site whose hubs are
// still unknown to Google.
export const SITEMAP_FAMILIES = ['offices', 'decisions', 'pages', 'reports'];

const XMLEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => XMLEscapes[char]);

function pathnameOf(loc) {
  try { return new URL(loc).pathname.replace(/\/$/, '') || '/'; } catch { return String(loc || '').replace(/\/$/, '') || '/'; }
}

/**
 * Family for a sitemap path.
 *   reports   - dated report permalinks (/reports/<office>/<date>)
 *   offices   - the six office landing pages and their report indexes
 *   decisions - the date archive, including monthly archives
 *   pages     - everything else (trust, guides, data, tools)
 */
export function sitemapFamily(pathname) {
  const route = pathnameOf(pathname);
  if (/^\/reports\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(route)) return 'reports';
  if (/^\/reports(\/[^/]+)?$/.test(route)) return 'offices';
  if (/^\/[a-z0-9-]+-visa-decisions$/.test(route)) return 'offices';
  if (route === '/decisions' || /^\/decisions\/\d{4}-\d{2}-\d{2}$/.test(route)) return 'decisions';
  if (route === '/monthly-report' || /^\/monthly-report\/\d{4}-\d{2}$/.test(route)) return 'decisions';
  return 'pages';
}

function parseEntries(xml) {
  const entries = [];
  for (const match of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)) {
    const lastmod = (match[2].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || '';
    entries.push({ loc: match[1], lastmod });
  }
  return entries;
}

function latestDate(values) {
  return values
    .map((value) => String(value || '').slice(0, 10))
    .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
    .sort()
    .pop() || '';
}

function urlset(entries) {
  const blocks = entries.map((entry) => `  <url>\n    <loc>${esc(entry.loc)}</loc>\n${entry.lastmod ? `    <lastmod>${esc(entry.lastmod)}</lastmod>\n` : ''}  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${entries.length} URL(s). One family of the split sitemap; see /sitemap.xml. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${blocks.join('\n')}
</urlset>
`;
}

function sitemapIndex(families, siteOrigin) {
  const blocks = families.map(({ family, count, lastmod }) => `  <sitemap>
    <loc>${esc(`${siteOrigin}/sitemap-${family}.xml`)}</loc>${lastmod ? `\n    <lastmod>${esc(lastmod)}</lastmod>` : ''}
    <!-- ${count} URL(s) -->
  </sitemap>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Sitemap index. The build writes one sitemap per page family so indexing
     diagnostics can be read per family instead of one 130-URL total. -->
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${blocks.join('\n')}
</sitemapindex>
`;
}

/**
 * Rewrite `<distDir>/sitemap.xml` as an index plus four family sitemaps.
 * An already-split file is left alone, so the function is safe to rerun.
 */
export function splitSitemap(distDir, { siteOrigin = SITE_ORIGIN } = {}) {
  const file = path.resolve(distDir, 'sitemap.xml');
  if (!fs.existsSync(file)) {
    return { split: false, reason: 'missing sitemap.xml', counts: {}, total: 0 };
  }
  const xml = fs.readFileSync(file, 'utf8');
  if (/<sitemapindex\b/.test(xml)) {
    const counts = {};
    for (const family of SITEMAP_FAMILIES) {
      const child = path.resolve(distDir, `sitemap-${family}.xml`);
      counts[family] = fs.existsSync(child) ? parseEntries(fs.readFileSync(child, 'utf8')).length : 0;
    }
    return { split: false, reason: 'already split', counts, total: Object.values(counts).reduce((sum, value) => sum + value, 0) };
  }

  const entries = parseEntries(xml);
  const grouped = new Map(SITEMAP_FAMILIES.map((family) => [family, []]));
  for (const entry of entries) {
    grouped.get(sitemapFamily(entry.loc)).push(entry);
  }

  const families = [];
  const counts = {};
  for (const family of SITEMAP_FAMILIES) {
    const list = grouped.get(family) || [];
    // An empty family would be a 404 or an empty sitemap; skip it instead.
    if (!list.length) {
      counts[family] = 0;
      continue;
    }
    fs.writeFileSync(path.resolve(distDir, `sitemap-${family}.xml`), urlset(list));
    families.push({ family, count: list.length, lastmod: latestDate(list.map((entry) => entry.lastmod)) });
    counts[family] = list.length;
  }

  fs.writeFileSync(file, sitemapIndex(families, siteOrigin));
  return { split: true, counts, total: entries.length, families };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const distArg = process.argv.find((arg) => arg.startsWith('--dist='));
  const dist = distArg ? distArg.slice('--dist='.length) : path.resolve(process.cwd(), '.pages-dist');
  const result = splitSitemap(dist);
  const summary = Object.entries(result.counts).map(([family, count]) => `${family} ${count}`).join(', ');
  console.log(`Sitemap index: ${result.total} URL(s) — ${summary}${result.reason ? ` (${result.reason})` : ''}.`);
}
