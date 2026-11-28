#!/usr/bin/env node
/**
 * Weekly search-coverage snapshot.
 *
 * Reads Search Console Search Analytics, URL Inspection and sitemap status,
 * Bing Webmaster crawl data and Cloudflare Web Analytics (RUM) traffic when the
 * matching credentials are reachable. Writes a noindex dashboard and a small
 * JSON snapshot. Each source is measured independently: a source without
 * credentials keeps its seeded section and records a warning, so one reachable
 * credential still produces a fresh snapshot instead of discarding the rest.
 *
 * Credentials (never checked in) come from the environment first, then the
 * gitignored `.dev.vars` / `.env` files used by the other tools:
 *   GSC_ACCESS_TOKEN                 short-lived OAuth token, or
 *   GSC_SERVICE_ACCOUNT_JSON         service-account JSON, or
 *   GSC_SERVICE_ACCOUNT_JSON_FILE    path to that JSON
 *   GSC_SITE_URL                     default https://irishvisaupdatetracker.pages.dev/
 *   BING_WEBMASTER_API_KEY
 *   CLOUDFLARE_API_TOKEN             Account -> Account Analytics -> Read
 *   CLOUDFLARE_ACCOUNT_ID            required when the token is account-scoped
 *
 *   node tools/coverage-dashboard.mjs [--sources=gsc,bing,cloudflare] [--days=28]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGES, spliceChrome } from './site-chrome.mjs';
import { SITE_ORIGIN } from './site-config.mjs';
import { eligibleDecisionDates } from './indexnow.mjs';
import { buildReport as cloudflareReport, readLocalEnv } from './cloudflare-analytics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = SITE_ORIGIN;
const DATA_FILE = path.join(ROOT, 'data', 'search-coverage.json');
const HTML_FILE = path.join(ROOT, 'search-coverage.html');
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OFFICE_SLUGS = ['new-delhi', 'beijing', 'abu-dhabi', 'abuja', 'ankara', 'dublin'];

/** The weekly sample: core pages, every office hub, report hubs, the newest
 *  report per office, the newest monthly report and the newest date view. */
export function priorityRoutes(root = ROOT) {
  const routes = [
    '/', '/irish-visa-decisions-today', '/vfs-tracking', '/reports', '/monthly-report',
    '/all-pages', '/decisions', '/data-study',
  ];
  const manifest = readJson(path.join(root, 'data', 'data_manifest.json'), { offices: [] });
  const slugs = [...new Set([
    ...OFFICE_SLUGS,
    ...(Array.isArray(manifest.offices) ? manifest.offices.map((office) => office.slug) : []),
  ].filter(Boolean))];
  for (const slug of slugs) {
    routes.push(`/${slug}-visa-decisions`);
    routes.push(`/reports/${slug}`);
  }

  const reports = readJson(path.join(root, 'data', 'reports', 'index.json'), { offices: {} });
  for (const slug of slugs) {
    const entries = Array.isArray(reports.offices && reports.offices[slug]) ? reports.offices[slug] : [];
    const sorted = entries
      .filter((entry) => entry && /^\d{4}-\d{2}-\d{2}/.test(String(entry.report_date || '')))
      .slice()
      .sort((a, b) => String(b.report_date).localeCompare(String(a.report_date)));
    let previous = '';
    for (const entry of sorted) {
      const key = [entry.decisions, entry.approved, entry.refused, entry.source_file].join('|');
      if (key === previous) continue;
      previous = key;
      const date = String(entry.report_date).slice(0, 10);
      routes.push(`/reports/${slug}/${date}`);
      break;
    }
  }

  try {
    const monthly = fs.readdirSync(path.join(root, 'monthly-report'))
      .map((file) => file.match(/^(\d{4}-\d{2})\.html$/)?.[1] || '')
      .filter(Boolean)
      .sort()
      .pop();
    if (monthly) routes.push(`/monthly-report/${monthly}`);
  } catch { /* no monthly archive */ }
  const latestDate = eligibleDecisionDates(root)[0];
  if (latestDate) routes.push(`/decisions/${latestDate}`);
  return [...new Set(routes)];
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const esc = (value) => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const pct = (value) => `${((Number(value) || 0) * 100).toFixed(2)}%`;
const num = (value) => (Number(value) || 0).toLocaleString('en-IE');
const day = (value) => String(value || '').slice(0, 10);

function pageDescriptor(route) {
  return PAGES.find((candidate) => candidate.route === route) || { route, current: null, skip: 'content' };
}

function dayRange(days = 28) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`);
  return body ? JSON.parse(body) : {};
}

function serviceAccount(credential) {
  const raw = credential('GSC_SERVICE_ACCOUNT_JSON');
  if (raw) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  const file = credential('GSC_SERVICE_ACCOUNT_JSON_FILE');
  if (file && fs.existsSync(file)) return readJson(file, null);
  return null;
}

async function accessToken(credential) {
  const direct = credential('GSC_ACCESS_TOKEN');
  if (direct) return direct;
  const account = serviceAccount(credential);
  if (!account || !account.client_email || !account.private_key) return '';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: account.client_email,
    scope: GSC_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), account.private_key).toString('base64url');
  const result = await requestJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });
  return result.access_token || '';
}

async function gscSnapshot(site, token, priority = []) {
  const period = dayRange(28);
  const base = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}`;
  const analytics = await requestJson(`${base}/searchAnalytics/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startDate: period.start,
      endDate: period.end,
      dimensions: ['query', 'page'],
      rowLimit: 100,
    }),
  });
  const rows = Array.isArray(analytics.rows) ? analytics.rows : [];
  const totals = rows.reduce((acc, row) => {
    acc.clicks += Number(row.clicks) || 0;
    acc.impressions += Number(row.impressions) || 0;
    acc.positionWeighted += (Number(row.position) || 0) * (Number(row.impressions) || 0);
    return acc;
  }, { clicks: 0, impressions: 0, positionWeighted: 0 });
  const pageMap = new Map();
  for (const row of rows) {
    const page = row.keys && row.keys[1] ? row.keys[1] : '';
    if (!page) continue;
    if (!pageMap.has(page)) pageMap.set(page, { page, clicks: 0, impressions: 0, positionWeighted: 0 });
    const item = pageMap.get(page);
    item.clicks += Number(row.clicks) || 0;
    item.impressions += Number(row.impressions) || 0;
    item.positionWeighted += (Number(row.position) || 0) * (Number(row.impressions) || 0);
  }
  const pages = [...pageMap.values()].map((item) => ({
    page: item.page,
    clicks: item.clicks,
    impressions: item.impressions,
    ctr: item.impressions ? item.clicks / item.impressions : 0,
    position: item.impressions ? item.positionWeighted / item.impressions : 0,
  })).sort((a, b) => b.impressions - a.impressions);

  const sitemapsPayload = await requestJson(`${base}/sitemaps`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const sitemaps = (Array.isArray(sitemapsPayload.sitemap) ? sitemapsPayload.sitemap : []).map((item) => ({
    path: item.path,
    lastSubmitted: item.lastSubmitted || '',
    isPending: Boolean(item.isPending),
    errors: Number(item.errors) || 0,
    warnings: Number(item.warnings) || 0,
    contents: Array.isArray(item.contents) ? item.contents : [],
  }));

  const priorityUrls = [];
  for (const route of priority) {
    const inspectionUrl = `${SITE}${route}`;
    try {
      const inspected = await requestJson('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl, siteUrl: site }),
      });
      const result = inspected.inspectionResult && inspected.inspectionResult.indexStatusResult;
      priorityUrls.push({
        url: route,
        coverageState: result && result.coverageState || 'No inspection result',
        indexingState: result && result.indexingState || '',
        lastCrawlTime: result && result.lastCrawlTime || '',
        pageFetchState: result && result.pageFetchState || '',
        googleCanonical: result && result.googleCanonical || '',
        userCanonical: result && result.userCanonical || '',
        verdict: result && result.verdict || '',
      });
    } catch (error) {
      priorityUrls.push({ url: route, coverageState: `Inspection failed: ${error.message}`, indexingState: '', lastCrawlTime: '' });
    }
  }

  return {
    site,
    period,
    totals: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
      position: totals.impressions ? totals.positionWeighted / totals.impressions : 0,
    },
    pages,
    priorityUrls,
    sitemaps,
  };
}

async function bingSnapshot(key, site) {
  if (!key) return { configured: false, status: 'BING_WEBMASTER_API_KEY is not set.', crawlStats: null, urlInfo: [], issues: [] };
  const base = 'https://ssl.bing.com/webmaster/api.svc/json';
  const call = (method, params = {}) => {
    const query = new URLSearchParams({ apikey: key, siteUrl: site, ...params });
    return requestJson(`${base}/${method}?${query.toString()}`);
  };
  const crawlStats = await call('GetCrawlStats').catch((error) => ({ error: error.message }));
  const issues = await call('GetCrawlIssues').catch((error) => ({ error: error.message }));
  return { configured: true, status: 'Connected', crawlStats, issues };
}

const SOURCE_NAMES = ['gsc', 'bing', 'cloudflare'];

/** Map the RUM report onto the snapshot section. The keys here are the
 *  snapshot schema; the renderer and the checked-in seed both read them. */
function cloudflareSnapshot(report) {
  return {
    source: 'Cloudflare Web Analytics (RUM)',
    window: report.window,
    totals: report.totals,
    traffic: report.traffic,
    // The seeded snapshot records the ten busiest paths; keep that shape.
    top_pages: report.topPages.slice(0, 10),
    countries: report.countries,
    web_vitals: report.webVitals,
  };
}

export async function refreshCoverage({
  root = ROOT,
  site,
  env,
  envFiles = true,
  sources,
  days = 28,
} = {}) {
  const seed = readJson(path.join(root, 'data', 'search-coverage.json'), {});
  const runtime = env || process.env;
  const local = envFiles ? readLocalEnv() : {};
  const credential = (name) => String(runtime[name] || local[name] || '').trim();
  const resolvedSite = site || credential('GSC_SITE_URL') || `${SITE}/`;
  const host = new URL(SITE).host;
  const wanted = new Set((sources && sources.length ? sources : SOURCE_NAMES)
    .filter((name) => SOURCE_NAMES.includes(name)));
  const next = { ...seed, generated_at: seed.generated_at || '', source: 'seed', errors: [] };
  const measured = [];

  if (wanted.has('gsc')) {
    const token = await accessToken(credential).catch((error) => {
      next.errors.push(`Search Console token: ${error.message}`);
      return '';
    });
    if (token) {
      try {
        next.gsc = await gscSnapshot(resolvedSite, token, priorityRoutes(root));
        measured.push('gsc');
      } catch (error) {
        next.errors.push(`Search Console: ${error.message}`);
      }
    } else if (seed.gsc) {
      next.errors.push('Search Console credentials were not provided; the seeded Search Console section was kept.');
    } else {
      next.errors.push('Search Console credentials were not provided and no seed exists.');
    }
  }

  if (wanted.has('bing')) {
    const key = credential('BING_WEBMASTER_API_KEY');
    if (key) {
      try {
        next.bing = await bingSnapshot(key, resolvedSite);
        measured.push('bing');
      } catch (error) {
        next.errors.push(`Bing: ${error.message}`);
      }
    } else if (seed.bing && seed.bing.configured) {
      next.errors.push('Bing Webmaster credentials were not provided; the seeded Bing section was kept.');
    } else {
      next.bing = { configured: false, status: 'BING_WEBMASTER_API_KEY is not set.', crawlStats: null, urlInfo: [], issues: [] };
      next.errors.push('Bing Webmaster credentials were not provided and no seed exists.');
    }
  }

  if (wanted.has('cloudflare')) {
    const token = credential('CLOUDFLARE_API_TOKEN');
    if (token) {
      try {
        const report = await cloudflareReport(token, credential('CLOUDFLARE_ACCOUNT_ID'), host, days);
        next.cloudflare = cloudflareSnapshot(report);
        measured.push('cloudflare');
      } catch (error) {
        next.errors.push(`Cloudflare Web Analytics: ${error.message}`);
      }
    } else if (seed.cloudflare) {
      next.errors.push('CLOUDFLARE_API_TOKEN is not set; the seeded Cloudflare section was kept.');
    } else {
      next.errors.push('CLOUDFLARE_API_TOKEN is not set and no seeded Cloudflare section exists.');
    }
  }

  // A run that measured nothing keeps the seed's timestamp: it did not produce
  // a fresh snapshot, and the dashboard and workflow both read this field.
  if (measured.length) {
    next.source = measured.join('+');
    next.generated_at = new Date().toISOString();
  } else if (!next.errors.length) {
    next.errors.push('No source was reachable; showing the checked-in seed snapshot.');
  }
  return next;
}

function coverageClass(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('unknown') || text.includes('not indexed') || text.includes('failed')) return 'coverage-bad';
  if (text.includes('indexed') || text.includes('submitted')) return 'coverage-good';
  return 'coverage-warn';
}

export function renderCoverageDashboard(data) {
  const gsc = data.gsc || {};
  const totals = gsc.totals || {};
  const urls = Array.isArray(gsc.priorityUrls) ? gsc.priorityUrls : [];
  const indexed = urls.filter((item) => /indexed/i.test(item.coverageState || '') && !/not indexed/i.test(item.coverageState || '')).length;
  const unknown = urls.filter((item) => /unknown/i.test(item.coverageState || '')).length;
  const sitemaps = Array.isArray(gsc.sitemaps) ? gsc.sitemaps : [];
  const pending = sitemaps.filter((item) => item.isPending).length;
  const perf = data.performance || {};
  const perfAfter = perf.after || {};
  const perfBefore = perf.before || {};
  const issues = Array.isArray(data.errors) ? data.errors : [];
  const priorityRows = urls.map((item) => `<tr>
    <td><a href="${esc(item.url)}">${esc(item.url)}</a></td>
    <td><span class="coverage-pill ${coverageClass(item.coverageState)}">${esc(item.coverageState || 'No data')}</span></td>
    <td>${esc(item.indexingState || '—')}</td>
    <td>${item.lastCrawlTime ? `<time datetime="${esc(item.lastCrawlTime)}">${esc(day(item.lastCrawlTime))}</time>` : '—'}</td>
    <td>${esc(item.pageFetchState || '—')}</td>
    <td>${esc(item.verdict || '—')}</td>
  </tr>`).join('');
  const pageRows = (Array.isArray(gsc.pages) ? gsc.pages : []).map((item) => `<tr>
    <td><a href="${esc(item.page)}">${esc(item.page.replace(SITE, '/'))}</a></td>
    <td>${num(item.clicks)}</td><td>${num(item.impressions)}</td><td>${pct(item.ctr)}</td><td>${(Number(item.position) || 0).toFixed(1)}</td>
  </tr>`).join('');
  const sitemapRows = sitemaps.map((item) => `<tr>
    <td><a href="${esc(item.path)}">${esc(item.path)}</a></td>
    <td>${item.lastSubmitted ? esc(day(item.lastSubmitted)) : '—'}</td>
    <td>${item.isPending ? 'Pending' : 'Processed'}</td>
    <td>${num(item.errors)}</td><td>${num(item.warnings)}</td>
  </tr>`).join('');
  const bing = data.bing || {};
  const cloudflare = data.cloudflare || null;
  const cfTotals = (cloudflare && cloudflare.totals) || {};
  const cfTraffic = (cloudflare && cloudflare.traffic) || null;
  const cfWindow = (cloudflare && cloudflare.window) || null;
  const cfPages = cloudflare && Array.isArray(cloudflare.top_pages) ? cloudflare.top_pages : [];
  const cfCountries = cloudflare && Array.isArray(cloudflare.countries) ? cloudflare.countries : [];
  const cfVitals = cloudflare && Array.isArray(cloudflare.web_vitals) ? cloudflare.web_vitals : [];
  const mobileVitals = cfVitals.find((item) => /mobile/i.test(String(item.device || ''))) || null;
  const count = (value) => (value == null ? '—' : num(value));
  const ms = (value) => (value == null ? '—' : `${num(value)} ms`);
  const humanShare = (value) => (cfTraffic && cfTraffic.humanPageviews
    ? pct(Number(value || 0) / cfTraffic.humanPageviews)
    : '—');
  const cfPageRows = cfPages.map((item) => `<tr>
    <td><a href="${esc(item.path)}">${esc(item.path)}</a></td>
    <td>${num(item.pageviews)}</td><td>${num(item.visits)}</td>
  </tr>`).join('');
  const cfCountryRows = cfCountries.map((item) => `<tr>
    <th scope="row">${esc(item.country)}</th><td>${num(item.pageviews)}</td>
  </tr>`).join('');
  const cfVitalRows = cfVitals.map((item) => `<tr>
    <th scope="row">${esc(item.device)}</th>
    <td>${num(item.samples)}</td>
    <td>${ms(item.lcp_ms)}</td><td>${ms(item.inp_ms)}</td><td>${item.cls == null ? '—' : esc(item.cls)}</td>
    <td>${ms(item.fcp_ms)}</td><td>${ms(item.ttfb_ms)}</td>
  </tr>`).join('');
  const cloudflareSection = cloudflare ? `<section id="cloudflare-analytics">
      <h2>Cloudflare Web Analytics</h2>
      <p><strong>${esc(cloudflare.source || 'Cloudflare Web Analytics (RUM)')}</strong>${cfWindow ? `, ${esc(cfWindow.since)} to ${esc(cfWindow.until)} (${num(cfWindow.days)} days)` : ''}. These are sampled browser beacons, not server logs: visitors who block the beacon are missing, so read them as trends.</p>
      <div class="study-grid">
        <div class="study-stat"><span class="status-kicker">Pageviews</span><strong>${num(cfTotals.pageviews)}</strong><span>${num(cfTotals.visits)} visits</span></div>
        <div class="study-stat"><span class="status-kicker">Human pageviews</span><strong>${count(cfTraffic && cfTraffic.humanPageviews)}</strong><span>${count(cfTraffic && cfTraffic.botPageviews)} from bots</span></div>
        <div class="study-stat"><span class="status-kicker">Subpage share</span><strong>${humanShare(cfTraffic && cfTraffic.subpagePageviews)}</strong><span>${count(cfTraffic && cfTraffic.homepagePageviews)} homepage pageviews</span></div>
        <div class="study-stat"><span class="status-kicker">Mobile LCP (p75)</span><strong>${ms(mobileVitals && mobileVitals.lcp_ms)}</strong><span>${count(mobileVitals && mobileVitals.samples)} samples</span></div>
      </div>
      ${cfPageRows ? `<h3>Top pages</h3>
      <div class="table-wrap" role="region" aria-label="Cloudflare pageviews by path" tabindex="0">
        <table class="office-table stack-table">
          <caption>Pageviews and visits by path, RUM window</caption>
          <thead><tr><th scope="col">Path</th><th scope="col">Pageviews</th><th scope="col">Visits</th></tr></thead>
          <tbody>${cfPageRows}</tbody>
        </table>
      </div>` : '<p class="small-note">No top-page rows in this snapshot.</p>'}
      ${cfVitalRows ? `<h3>Core Web Vitals (p75, human traffic)</h3>
      <div class="table-wrap" role="region" aria-label="Cloudflare Core Web Vitals" tabindex="0">
        <table class="office-table stack-table">
          <caption>Field p75 by device; — means too few samples</caption>
          <thead><tr><th scope="col">Device</th><th scope="col">Samples</th><th scope="col">LCP</th><th scope="col">INP</th><th scope="col">CLS</th><th scope="col">FCP</th><th scope="col">TTFB</th></tr></thead>
          <tbody>${cfVitalRows}</tbody>
        </table>
      </div>
      <p class="small-note">Google "good" thresholds: LCP &le; 2500 ms, INP &le; 200 ms, CLS &le; 0.1.</p>` : '<p class="small-note">No Web Vitals samples in this snapshot.</p>'}
      ${cfCountryRows ? `<h3>Top countries</h3>
      <div class="table-wrap" role="region" aria-label="Cloudflare pageviews by country" tabindex="0">
        <table class="office-table stack-table">
          <caption>Pageviews by country</caption>
          <thead><tr><th scope="col">Country</th><th scope="col">Pageviews</th></tr></thead>
          <tbody>${cfCountryRows}</tbody>
        </table>
      </div>` : ''}
    </section>` : `<section id="cloudflare-analytics">
      <h2>Cloudflare Web Analytics</h2>
      <p>No Cloudflare RUM section in this snapshot. Set <code>CLOUDFLARE_API_TOKEN</code> and <code>CLOUDFLARE_ACCOUNT_ID</code>, then run the refresh.</p>
    </section>`;
  const scorecard = data.indexing_scorecard || null;
  const scoreEngines = scorecard && Array.isArray(scorecard.engines) ? scorecard.engines : [];
  const scoreFamilies = scorecard && Array.isArray(scorecard.families) ? scorecard.families : [];
  const metric = (value) => value === 0 || value ? (typeof value === 'number' ? num(value) : esc(value)) : '—';
  const scoreEngineRows = scoreEngines.map((item) => `<tr>
    <th scope="row">${esc(item.engine)}</th>
    <td>${metric(item.submitted)}</td>
    <td>${metric(item.discovered)}</td>
    <td>${metric(item.crawled)}</td>
    <td>${metric(item.indexed)}</td>
    <td>${metric(item.excluded)}</td>
    <td>${item.last_crawl ? `<time datetime="${esc(item.last_crawl)}">${esc(day(item.last_crawl))}</time>` : '—'}</td>
    <td>${metric(item.sitemap_status)}</td>
  </tr>`).join('');
  const scoreFamilyRows = scoreFamilies.map((item) => {
    const google = item.google || {};
    const bingFamily = item.bing || {};
    return `<tr>
    <th scope="row">${esc(item.family)}</th>
    <td>${metric(item.submitted)}</td>
    <td>${metric(google.inspected)}</td>
    <td><span class="coverage-pill ${Number(google.indexed) ? 'coverage-good' : 'coverage-bad'}">${metric(google.indexed)}</span></td>
    <td><span class="coverage-pill ${Number(google.unknown) ? 'coverage-bad' : 'coverage-good'}">${metric(google.unknown)}</span></td>
    <td>${google.last_crawl ? `<time datetime="${esc(google.last_crawl)}">${esc(day(google.last_crawl))}</time>` : '—'}</td>
    <td>${metric(bingFamily.inspected)}</td>
    <td>${metric(bingFamily.discovered)}</td>
    <td>${metric(bingFamily.crawled)}</td>
    <td>${bingFamily.last_crawl ? `<time datetime="${esc(bingFamily.last_crawl)}">${esc(day(bingFamily.last_crawl))}</time>` : '—'}</td>
    <td>${metric(item.yandex)}</td>
  </tr>`;
  }).join('');
  const scorecardSection = scorecard ? `<section id="indexing-scorecard">
      <h2>Indexing scorecard by engine</h2>
      <p>Checked ${esc(day(scorecard.checked_at))}. ${esc(scorecard.sample_note || '')}</p>
      <div class="table-wrap" role="region" aria-label="Indexing scorecard by engine" tabindex="0">
        <table class="office-table stack-table">
          <caption>Submitted, discovered, crawled and indexed by search engine</caption>
          <thead><tr><th scope="col">Engine</th><th scope="col">Submitted</th><th scope="col">Discovered</th><th scope="col">Crawled</th><th scope="col">Indexed</th><th scope="col">Exclusions</th><th scope="col">Last crawl</th><th scope="col">Sitemap</th></tr></thead>
          <tbody>${scoreEngineRows}</tbody>
        </table>
      </div>
      <p class="small-note">${esc(scorecard.manual_note || '')}</p>
      ${scoreFamilyRows ? `<h3>By page family</h3>
      <div class="table-wrap" role="region" aria-label="Indexing scorecard by page family" tabindex="0">
        <table class="office-table stack-table">
          <caption>Representative URL inspections by page family</caption>
          <thead><tr><th scope="col">Family</th><th scope="col">Submitted</th><th scope="col">Google inspected</th><th scope="col">Google indexed</th><th scope="col">Google unknown</th><th scope="col">Google last crawl</th><th scope="col">Bing inspected</th><th scope="col">Bing discovered</th><th scope="col">Bing crawled</th><th scope="col">Bing last crawl</th><th scope="col">Yandex</th></tr></thead>
          <tbody>${scoreFamilyRows}</tbody>
        </table>
      </div>` : ''}
    </section>` : '';
  const body = `    <p class="page-kicker">Operations · noindex</p>
    <h1>Search coverage dashboard</h1>
    <p class="page-meta">Weekly snapshot &bull; ${esc(day(data.generated_at))} &bull; Source: ${esc(data.source || 'seed')} &bull; This page is not indexed.</p>
    <p class="page-lede">The dashboard answers one question: are the pages we published actually discoverable, and does anyone arrive? It separates Google Search Console indexing and query data from Bing/IndexNow crawl data and Cloudflare Web Analytics traffic, and records the measurement instead of relying on a screenshot or a memory of a dashboard.</p>

    <div class="study-grid">
      <div class="study-stat"><span class="status-kicker">Clicks (28d)</span><strong>${num(totals.clicks)}</strong><span>${num(totals.impressions)} impressions</span></div>
      <div class="study-stat"><span class="status-kicker">CTR</span><strong>${pct(totals.ctr)}</strong><span>Average position ${(Number(totals.position) || 0).toFixed(1)}</span></div>
      <div class="study-stat"><span class="status-kicker">Priority URLs indexed</span><strong>${indexed}/${urls.length}</strong><span>${unknown} unknown to Google</span></div>
      <div class="study-stat"><span class="status-kicker">Sitemap</span><strong>${pending ? 'Pending' : (sitemaps.length ? 'Processed' : 'None')}</strong><span>${sitemaps.length} submitted</span></div>
    </div>

    ${issues.length ? `<section class="callout"><h2>Refresh warnings</h2><ul>${issues.map((issue) => `<li>${esc(issue)}</li>`).join('')}</ul><p>The seed data is shown where a request failed. Fix the credential or quota and rerun; do not read a stale dashboard as fresh.</p></section>` : ''}

    <section>
      <h2>Priority URLs</h2>
      <p>The sample covers core pages, all six office hubs, report hubs, the newest report per office and the newest dated views. A page can be submitted without being discovered, crawled or indexed; the scorecard below keeps those states separate.</p>
      ${priorityRows ? `<div class="table-wrap" role="region" aria-label="Search Console URL inspection" tabindex="0">
        <table class="office-table stack-table">
          <caption>Search Console URL Inspection, one row per priority URL</caption>
          <thead><tr><th scope="col">URL</th><th scope="col">Coverage</th><th scope="col">Indexing</th><th scope="col">Last crawl</th><th scope="col">Fetch</th><th scope="col">Verdict</th></tr></thead>
          <tbody>${priorityRows}</tbody>
        </table>
      </div>` : '<p>No URL inspection rows. Run the refresh with Search Console credentials.</p>'}
    </section>

    ${scorecardSection}

    <section>
      <h2>Queries and pages</h2>
      ${pageRows ? `<div class="table-wrap" role="region" aria-label="Search performance by page" tabindex="0">
        <table class="office-table stack-table">
          <caption>Search Analytics, ${esc(gsc.period ? `${gsc.period.start} to ${gsc.period.end}` : 'last 28 days')}</caption>
          <thead><tr><th scope="col">Page</th><th scope="col">Clicks</th><th scope="col">Impressions</th><th scope="col">CTR</th><th scope="col">Position</th></tr></thead>
          <tbody>${pageRows}</tbody>
        </table>
      </div>` : '<p>No Search Analytics rows in the snapshot.</p>'}
    </section>

    <section>
      <h2>Sitemap status</h2>
      ${sitemapRows ? `<div class="table-wrap" role="region" aria-label="Sitemap status" tabindex="0">
        <table class="office-table stack-table">
          <caption>Submitted sitemaps and their processing state</caption>
          <thead><tr><th scope="col">Sitemap</th><th scope="col">Last submitted</th><th scope="col">State</th><th scope="col">Errors</th><th scope="col">Warnings</th></tr></thead>
          <tbody>${sitemapRows}</tbody>
        </table>
      </div>` : '<p>No sitemap data. Submit /sitemap.xml in Search Console.</p>'}
    </section>

    <section>
      <h2>Bing and IndexNow</h2>
      <p><strong>Status:</strong> ${esc(bing.status || (bing.configured ? 'Connected' : 'Not configured'))}. IndexNow submits new report permalinks, monthly pages and date pages; Google does not consume IndexNow, so this is a complement, not a substitute.</p>
      ${bing.crawlStats ? `<pre class="coverage-json" tabindex="0" role="region" aria-label="Bing crawl statistics">${esc(JSON.stringify(bing.crawlStats, null, 2))}</pre>` : '<p class="small-note">No Bing crawl statistics in this snapshot.</p>'}
${bing.issues && bing.issues.error ? `<p class="small-note">Bing crawl issues request: ${esc(bing.issues.error)}</p>` : ''}
    </section>

    ${cloudflareSection}

    <section>
      <h2>Performance scorecard</h2>
      <p><strong>${esc(perf.profile || 'Lab profile not recorded')}</strong></p>
      <ul class="study-list">
        <li>Before: LCP ${perfBefore.lcp || '—'}s, CLS ${perfBefore.cls ?? '—'}.</li>
        <li>After: LCP ${perfAfter.lcp || '—'}s, CLS ${perfAfter.cls ?? '—'}.</li>
        <li>Mobile: LCP ${perf.mobile && perf.mobile.lcp ? `${perf.mobile.lcp}s` : '—'} on ${esc(perf.mobile && perf.mobile.profile || 'not recorded')}.</li>
        <li>${esc(perf.notes || '')}</li>
      </ul>
    </section>

    <section>
      <h2>What still needs a human</h2>
      <ul class="study-list">
        <li><strong>Request indexing</strong> is a signed-in Search Console action under URL Inspection. The API can inspect a URL; it cannot press the button.</li>
        <li><strong>Search Console sitemap processing</strong> can remain pending for days. Use the status column rather than assuming submission equals indexing.</li>
        <li><strong>Bing</strong> needs a verified site and API key. If that key is absent, the dashboard says so instead of showing an empty success.</li>
        <li><strong>Cloudflare RUM</strong> is sampled field data from browsers that load the beacon; it excludes visitors who block it, so use it for trends rather than absolute totals.</li>
        <li><strong>Core Web Vitals</strong> need field data; the lab number here is a regression guard, not a field measurement.</li>
      </ul>
    </section>

    <section>
      <h2>Refresh</h2>
      <p>Run <code>npm run coverage:dashboard</code> with the credentials listed in the script header, or restrict a run to the sources you have (<code>--sources=cloudflare</code>). Credentials are read from the environment, then from the gitignored <code>.dev.vars</code>/<code>.env</code>. A source without credentials keeps its seeded section and adds a warning above. The weekly workflow does the same and commits the snapshot. This page is deliberately excluded from the sitemap and carries <code>noindex, follow</code>.</p>
      <p class="page-nav"><a href="/status">Data status</a> &middot; <a href="/all-pages">All pages</a> &middot; <a href="/reports">Report archive</a></p>
    </section>`;
  const descriptor = pageDescriptor('/search-coverage');
  return spliceChrome(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Search coverage dashboard | Irish Visa Decision Tracker</title>
  <meta name="description" content="Internal weekly Search Console, Bing and Core Web Vitals snapshot for the Irish Visa Decision Tracker.">
  <link rel="canonical" href="${SITE}/search-coverage">
  <meta name="robots" content="noindex, follow">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/pages.css">
  <link rel="stylesheet" href="/site-chrome.css">
  <link rel="stylesheet" href="/styles/blueprint.css">
  <link rel="stylesheet" href="/styles/coverage.css">
</head>
<body>
  <!-- site-chrome:start -->
  <!-- site-chrome:end -->
  <main id="main-content" tabindex="-1" class="page">
${body}
  </main>
  <!-- site-footer:start -->
  <!-- site-footer:end -->
  <script src="/scripts/time-mode.js" defer></script>
  <script src="/site-chrome.js" defer></script>
</body>
</html>
`, descriptor);
}

export async function writeCoverageDashboard({ root = ROOT, ...options } = {}) {
  const data = await refreshCoverage({ root, ...options });
  const dataFile = path.join(root, 'data', 'search-coverage.json');
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'search-coverage.html'), renderCoverageDashboard(data));
  return data;
}

function cliOptions(argv = process.argv.slice(2)) {
  const value = (name) => {
    const prefix = `--${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : '';
  };
  const days = Math.max(1, Math.min(90, Number(value('days')) || 28));
  const sources = value('sources').split(',').map((name) => name.trim()).filter(Boolean);
  return { days, ...(sources.length ? { sources } : {}) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  writeCoverageDashboard(cliOptions()).then((data) => {
    console.log(`Coverage snapshot written: source=${data.source}, errors=${data.errors.length}.`);
    if (data.errors.length) for (const error of data.errors) console.warn(`Warning: ${error}`);
  }).catch((error) => {
    console.error('Coverage dashboard failed:', error.message);
    process.exit(1);
  });
}
