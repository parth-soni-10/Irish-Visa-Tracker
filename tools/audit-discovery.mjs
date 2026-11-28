#!/usr/bin/env node
/**
 * Discovery audit for the built site.
 *
 * This is intentionally about crawl paths, not rankings. It checks that every
 * report permalink has a plain HTML link, that the sitemap's lastmod values
 * describe the page rather than the build clock, and that the performance
 * regressions we fixed (font preload, full fallback on first paint) stay fixed.
 *
 *   node tools/audit-discovery.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const read = (file) => fs.readFileSync(file, 'utf8');
const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const pathnameOf = (loc) => {
  try { return new URL(loc).pathname.replace(/\/$/, '') || '/'; } catch { return String(loc || '').replace(/\/$/, '') || '/'; }
};
const iso = (value) => String(value || '').slice(0, 10);
const SITE_HOST_ORIGIN = new URL(SITE).origin;

function routeFromHref(href) {
  if (!href || href.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(href)) return '';
  let url;
  try { url = new URL(href, SITE); } catch { return ''; }
  if (url.origin !== SITE_HOST_ORIGIN) return '';
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return ''; }
  pathname = pathname.replace(/\/+$/, '') || '/';
  if (pathname.endsWith('.html')) pathname = pathname.slice(0, -5) || '/';
  return pathname;
}

function fileForRoute(route, distDir) {
  if (route === '/') return path.join(distDir, 'index.html');
  const clean = route.replace(/^\//, '');
  for (const candidate of [
    path.join(distDir, `${clean}.html`),
    path.join(distDir, clean, 'index.html'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function clickDepth(entries, distDir) {
  const routeFiles = new Map();
  for (const entry of entries) {
    const file = fileForRoute(entry.pathname, distDir);
    if (file) routeFiles.set(entry.pathname, file);
  }
  const depths = new Map([['/', 0]]);
  const queue = ['/'];
  while (queue.length) {
    const route = queue.shift();
    const file = routeFiles.get(route);
    if (!file) continue;
    const html = read(file);
    for (const match of html.matchAll(/\bhref="([^"]+)"/g)) {
      const target = routeFromHref(match[1]);
      if (!target || !routeFiles.has(target) || depths.has(target)) continue;
      depths.set(target, depths.get(route) + 1);
      queue.push(target);
    }
  }
  const unreachable = entries
    .map((entry) => entry.pathname)
    .filter((route) => !depths.has(route));
  const tooDeep = entries
    .map((entry) => entry.pathname)
    .filter((route) => depths.has(route) && depths.get(route) > 3);
  return {
    unreachable,
    tooDeep,
    maxDepth: depths.size ? Math.max(...depths.values()) : 0,
  };
}

export function auditDiscovery({ distDir = path.join(ROOT, '.pages-dist'), root = ROOT } = {}) {
  const failures = [];
  const warnings = [];
  const sitemapFile = path.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(sitemapFile)) {
    return { failures: [`missing ${path.relative(root, sitemapFile)}; run npm run build first`], warnings, checked: 0 };
  }
  const sitemap = read(sitemapFile);
  // The build publishes a sitemap index with one child per page family. Read
  // every child so the crawl-path checks still see the full URL set.
  const sitemapDocuments = [];
  if (/<sitemapindex\b/.test(sitemap)) {
    for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const childName = path.basename(pathnameOf(match[1]));
      const childFile = path.join(distDir, childName);
      if (!fs.existsSync(childFile)) {
        failures.push(`sitemap index references a missing child: ${childName}`);
        continue;
      }
      sitemapDocuments.push(read(childFile));
    }
    if (!sitemapDocuments.length) failures.push('sitemap index has no readable child sitemap');
  } else {
    sitemapDocuments.push(sitemap);
  }
  const entries = sitemapDocuments.flatMap((document) => [...document.matchAll(/<url>\s*<loc>([^<]+)<\/loc>([\s\S]*?)<\/url>/g)]
    .map((match) => ({
      loc: match[1],
      pathname: pathnameOf(match[1]),
      lastmod: (match[2].match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || '',
    })));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.pathname)) failures.push(`sitemap duplicates ${entry.pathname}`);
    seen.add(entry.pathname);
    if (!entry.loc.startsWith(SITE)) failures.push(`sitemap URL is not on ${SITE}: ${entry.loc}`);
    if (!entry.lastmod) warnings.push(`sitemap has no lastmod: ${entry.pathname}`);
  }

  const crawl = clickDepth(entries, distDir);
  for (const route of crawl.unreachable) {
    failures.push(`sitemap URL is unreachable from /: ${route}`);
  }
  for (const route of crawl.tooDeep) {
    failures.push(`sitemap URL is more than three clicks from /: ${route}`);
  }

  const reports = readJson(path.join(root, 'data', 'reports', 'index.json'), { offices: {} });
  const perOffice = {};
  for (const [slug, list] of Object.entries(reports.offices || {})) {
    const sorted = (Array.isArray(list) ? list : [])
      .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || '')))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    const dates = [];
    let previous = '';
    for (const entry of sorted) {
      const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
      if (key === previous) continue;
      previous = key;
      dates.push(iso(entry.report_date));
    }
    perOffice[slug] = dates;
    for (const date of dates) {
      if (!seen.has(`/reports/${slug}/${date}`)) failures.push(`report permalink missing from sitemap: /reports/${slug}/${date}`);
    }
  }

  const allPagesFile = path.join(distDir, 'all-pages.html');
  if (!fs.existsSync(allPagesFile)) {
    failures.push('missing all-pages.html (the plain crawl path)');
  } else {
    const allPages = read(allPagesFile);
    const htmlLinks = [...allPages.matchAll(/href="(\/[^"#?]*)"/g)].map((match) => match[1]);
    for (const href of new Set(htmlLinks)) {
      const reportLink = href.match(/^\/reports\/([a-z0-9-]+)\/(\d{4}-\d{2}-\d{2})$/);
      if (reportLink && !fs.existsSync(path.join(distDir, 'reports', reportLink[1], `${reportLink[2]}.html`))) {
        failures.push(`all-pages links a missing report file: ${href}`);
      }
      const dateLink = href.match(/^\/decisions\/(\d{4}-\d{2}-\d{2})$/);
      if (dateLink && !fs.existsSync(path.join(distDir, 'decisions', `${dateLink[1]}.html`))) {
        failures.push(`all-pages links a missing date file: ${href}`);
      }
    }
    for (const slug of Object.keys(reports.offices || {})) {
      if (!allPages.includes(`/reports/${slug}`)) failures.push(`all-pages does not link /reports/${slug}`);
      for (const date of perOffice[slug]) {
        if (!allPages.includes(`/reports/${slug}/${date}`)) failures.push(`all-pages does not link /reports/${slug}/${date}`);
      }
      const officeFile = path.join(distDir, `${slug}-visa-decisions.html`);
      if (!fs.existsSync(officeFile)) {
        failures.push(`missing office page: ${slug}-visa-decisions.html`);
      } else {
        const office = read(officeFile);
        if (!office.includes(`/reports/${slug}`)) failures.push(`${slug} office page does not link its report index`);
        const latest = perOffice[slug][0];
        if (latest && !office.includes(`/reports/${slug}/${latest}`)) {
          failures.push(`${slug} office page does not link its latest report permalink (${latest})`);
        }
      }
    }
  }

  for (const entry of entries) {
    if (!entry.pathname.startsWith('/decisions/')) continue;
    const date = entry.pathname.slice('/decisions/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      failures.push(`invalid date archive URL: ${entry.pathname}`);
      continue;
    }
    const day = new Date(`${date}T00:00:00Z`);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) failures.push(`date archive is a weekend: ${date}`);
    if (entry.lastmod !== date) failures.push(`date archive lastmod ${entry.lastmod} does not match ${date}`);
    if (!fs.existsSync(path.join(distDir, 'decisions', `${date}.html`))) failures.push(`date archive file missing: ${date}`);
  }

  for (const entry of entries) {
    const match = entry.pathname.match(/^\/reports\/[a-z0-9-]+\/(\d{4}-\d{2}-\d{2})$/);
    if (match && entry.lastmod !== match[1]) failures.push(`report lastmod ${entry.lastmod} does not match ${match[1]}`);
  }

  const indexFile = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    failures.push('missing built index.html');
  } else {
    const index = read(indexFile);
    if (/rel=["']preload["'][^>]+font/i.test(index)) failures.push('homepage preloads a font again');
    if (/search_fallback\.json/i.test(index)) failures.push('homepage references search_fallback.json on first paint');

    if (!index.includes('/all-pages')) failures.push('homepage does not link the all-pages hub');
  }

  const robots = path.join(distDir, 'robots.txt');
  if (!fs.existsSync(robots)) failures.push('missing robots.txt');
  else if (!read(robots).includes('Sitemap:')) failures.push('robots.txt has no Sitemap line');

  const reportPermalinks = entries.filter((entry) => /^\/reports\/[^/]+\/\d{4}-\d{2}-\d{2}$/.test(entry.pathname)).length;
  const datePages = entries.filter((entry) => /^\/decisions\/\d{4}-\d{2}-\d{2}$/.test(entry.pathname)).length;
  return {
    failures,
    warnings,
    checked: entries.length,
    reportPermalinks,
    datePages,
    sitemapDocuments: sitemapDocuments.length,
    maxDepth: crawl.maxDepth,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = auditDiscovery();
  console.log(`Discovery audit: ${result.checked} sitemap URLs, ${result.reportPermalinks} report permalinks, ${result.datePages} date pages, max crawl depth ${result.maxDepth}.`);
  for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`FAIL: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('Discovery audit passed.');
  }
}
