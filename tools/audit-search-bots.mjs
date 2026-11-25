#!/usr/bin/env node
/**
 * Check that search-engine crawlers can fetch the public site.
 *
 * A browser 200 does not prove Bingbot or YandexBot is allowed through
 * Cloudflare. This sends the real crawler user agents to the homepage, the
 * sitemap, robots.txt, priority pages and the IndexNow key, then reports a
 * challenge, redirect, wrong content type or malformed response.
 *
 *   node tools/audit-search-bots.mjs
 *   node tools/audit-search-bots.mjs --json
 *   node tools/audit-search-bots.mjs --base=https://example.ie
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findIndexNowKey } from './indexnow.mjs';
import { SITE_ORIGIN } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BOT_PROFILES = [
  {
    name: 'Googlebot',
    userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  },
  {
    name: 'Bingbot',
    userAgent: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  },
  {
    name: 'YandexBot',
    userAgent: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  },
];

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The office list comes from the manifest, so a seventh office is audited
 *  without a second list to keep in sync. */
export function officeRoutes(root = ROOT) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'data', 'data_manifest.json'), 'utf8'));
    return (Array.isArray(manifest.offices) ? manifest.offices : [])
      .filter((office) => office && office.slug)
      .map((office) => `/${office.slug}-visa-decisions`);
  } catch {
    return [];
  }
}

/** Googlebot does not run the site's JavaScript for navigation. The homepage
 *  has to link every office in the served HTML, and each office page has to
 *  link its peers and the today page, or those pages depend on the sitemap
 *  alone for discovery. */
export function requiredInternalLinks(pathname, routes = []) {
  if (!Array.isArray(routes) || !routes.length) return [];
  const route = String(pathname || '/').replace(/\.html$/i, '').replace(/\/$/, '') || '/';
  if (route === '/') return [...routes];
  if (routes.includes(route)) return [...routes.filter((item) => item !== route), '/irish-visa-decisions-today'];
  return [];
}

export function findMissingLinks(body, required = []) {
  return required.filter((route) => !new RegExp(`href=["']${escapeRegExp(route)}(?:["'?#])`, 'i').test(String(body || '')));
}

export function defaultAuditPaths(key = findIndexNowKey()) {
  const paths = [
    '/',
    '/sitemap.xml',
    '/sitemap-offices.xml',
    '/sitemap-reports.xml',
    '/sitemap-decisions.xml',
    '/robots.txt',
    '/irish-visa-decisions-today',
    '/vfs-tracking',
    '/all-pages',
  ];
  paths.push(...officeRoutes());
  if (key) paths.push(`/${key}.txt`);
  return paths;
}

function expectedType(pathname) {
  if (pathname.endsWith('.xml')) return { pattern: /xml/i, label: 'XML' };
  if (pathname.endsWith('.txt')) return { pattern: /text\/plain/i, label: 'text/plain' };
  return { pattern: /text\/html/i, label: 'HTML' };
}

const CHALLENGE_PATTERN = /just a moment|cf-chl-|attention required|verify you are human|checking your browser/i;

/**
 * Classify one response. Exported so the checks can be tested without making a
 * live request. `body` is the decoded response text.
 */
export function assessBotResponse({ pathname, status, contentType, cfMitigated, body, key = '' }) {
  const issues = [];
  const type = expectedType(pathname);
  if (status !== 200) issues.push(`HTTP ${status}`);
  if (cfMitigated) issues.push(`Cloudflare challenge (${cfMitigated})`);
  if (CHALLENGE_PATTERN.test(body) && (status >= 400 || cfMitigated)) {
    issues.push('challenge page content');
  }
  if (!type.pattern.test(contentType)) {
    issues.push(`content type ${contentType || 'missing'}, expected ${type.label}`);
  }
  if (!body.trim()) issues.push('empty response body');

  if (pathname.endsWith('.xml')) {
    // /sitemap.xml is a sitemap index; each family child must stay a urlset.
    const isIndex = /<sitemapindex\b/i.test(body);
    const isUrlset = /<urlset\b/i.test(body);
    if (!isIndex && !isUrlset) issues.push('not a sitemap urlset');
    if (isIndex && pathname !== '/sitemap.xml') issues.push('child sitemap is an index, not a urlset');
    if (isIndex && pathname === '/sitemap.xml' && !/<sitemap>\s*<loc>/i.test(body)) {
      issues.push('sitemap index has no child <sitemap> entries');
    }
    if (!/<loc>\s*https?:\/\//i.test(body)) issues.push('sitemap has no absolute <loc>');
  } else if (pathname === '/robots.txt') {
    if (!/^User-agent:\s*\*/im.test(body)) issues.push('robots.txt has no User-agent: *');
    if (!/^Sitemap:\s*https?:\/\//im.test(body)) issues.push('robots.txt has no Sitemap line');
  } else if (pathname.endsWith('.txt') && key) {
    if (body.trim() !== key) issues.push('IndexNow key body does not match the filename');
  } else if (!/<html\b/i.test(body)) {
    issues.push('not an HTML document');
  }

  return { ok: issues.length === 0, issues };
}

export async function auditSearchBots({
  base = SITE_ORIGIN,
  paths = defaultAuditPaths(),
  bots = BOT_PROFILES,
  key = findIndexNowKey(),
  routes = [],
  fetchImpl = fetch,
  timeoutMs = 20000,
} = {}) {
  const origin = new URL(base).origin;
  const results = [];
  for (const bot of bots) {
    for (const route of paths) {
      const url = `${origin}${route}`;
      const started = Date.now();
      try {
        const response = await fetchImpl(url, {
          redirect: 'follow',
          headers: {
            'user-agent': bot.userAgent,
            'cache-control': 'no-cache',
            pragma: 'no-cache',
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        const body = await response.text();
        const headers = response.headers;
        const assessment = assessBotResponse({
          pathname: route,
          status: response.status,
          contentType: headers.get('content-type') || '',
          cfMitigated: headers.get('cf-mitigated') || '',
          body,
          key,
        });
        const redirected = Boolean(response.redirected && response.url && response.url !== url);
        if (redirected) assessment.issues.push(`redirected to ${response.url}`);
        const required = /text\/html/i.test(headers.get('content-type') || '')
          ? requiredInternalLinks(route, routes)
          : [];
        const missingLinks = findMissingLinks(body, required);
        for (const link of missingLinks) assessment.issues.push(`missing crawlable link to ${link}`);
        // assessBotResponse reports ok from the issues it saw; the redirect and
        // link checks add issues afterwards, so ok is decided here.
        const ok = assessment.issues.length === 0 && !redirected;
        results.push({
          bot: bot.name,
          path: route,
          status: response.status,
          ok,
          issues: assessment.issues,
          contentType: headers.get('content-type') || '',
          cacheControl: headers.get('cache-control') || '',
          cfMitigated: headers.get('cf-mitigated') || '',
          cfCacheStatus: headers.get('cf-cache-status') || '',
          redirected,
          missingLinks,
          bytes: Buffer.byteLength(body),
          elapsedMs: Date.now() - started,
        });
      } catch (error) {
        results.push({
          bot: bot.name,
          path: route,
          status: 0,
          ok: false,
          issues: [`request failed: ${error.message}`],
          contentType: '',
          cacheControl: '',
          cfMitigated: '',
          cfCacheStatus: '',
          redirected: false,
          bytes: 0,
          elapsedMs: Date.now() - started,
        });
      }
    }
  }
  const failures = results.filter((result) => !result.ok);
  return { base: origin, checkedAt: new Date().toISOString(), results, failures };
}

function printReport(report) {
  console.log(`Search-bot fetch audit ${report.checkedAt}`);
  console.log(report.base);
  for (const result of report.results) {
    const state = result.ok ? 'OK  ' : 'FAIL';
    console.log(`${state} ${result.bot.padEnd(9)} ${String(result.status).padEnd(3)} ${result.path}  ${result.contentType || 'no content-type'}  ${result.bytes}B ${result.elapsedMs}ms${result.cfCacheStatus ? `  cf-cache: ${result.cfCacheStatus}` : ''}`);
    for (const issue of result.issues) console.log(`     ${issue}`);
    if (result.ok && result.path === '/') {
      console.log(`     cache-control: ${result.cacheControl || 'not set'}`);
    }
  }
  console.log(`${report.results.length - report.failures.length}/${report.results.length} checks passed.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const baseArg = process.argv.find((value) => value.startsWith('--base='));
  const key = findIndexNowKey();
  const base = baseArg ? baseArg.slice('--base='.length) : (process.env.SITE_ORIGIN || SITE_ORIGIN);
  const json = process.argv.includes('--json');
  const report = await auditSearchBots({ base, key, routes: officeRoutes() });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
  if (report.failures.length) process.exitCode = 1;
}
