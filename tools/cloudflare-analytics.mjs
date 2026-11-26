#!/usr/bin/env node
/**
 * Read Cloudflare Web Analytics (RUM) for the tracker's deployed origin.
 *
 * The GraphQL Analytics API accepts API tokens only, so this needs a token with
 * Account -> Account Analytics -> Read. A Wrangler OAuth login (what
 * `wrangler pages deploy` uses) is not accepted by that endpoint.
 *
 * The token is read from `.dev.vars` (gitignored and in `.assetsignore`) or
 * `CLOUDFLARE_API_TOKEN` in the environment. It is never logged, and no value
 * from the env file is printed.
 *
 *   node tools/cloudflare-analytics.mjs --check
 *   node tools/cloudflare-analytics.mjs --days=7
 *   node tools/cloudflare-analytics.mjs --days=28 --json
 *   node tools/cloudflare-analytics.mjs --days=7 --host=irishvisatracker.com
 *
 * `--check` verifies the token, lists the accounts it can read and the Web
 * Analytics sites in them, then exits. It writes nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { siteOrigin } from './site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.cloudflare.com/client/v4';
const GRAPHQL = `${API}/graphql`;
const USAGE = 'Usage: node tools/cloudflare-analytics.mjs [--check] [--days=7] [--host=host] [--site-tag=tag] [--json]';

/** Local secret files, in precedence order; `.dev.vars` wins over `.env`. */
function readLocalEnv() {
  const values = {};
  for (const name of ['.dev.vars', '.env']) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match || values[match[1]]) continue;
      let value = match[2].trim();
      if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      values[match[1]] = value;
    }
  }
  return values;
}

function readArgument(args, name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function request(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!response.ok || (body && body.success === false)) {
    const detail = body && Array.isArray(body.errors) && body.errors.length
      ? body.errors.map((error) => `${error.code ? `${error.code} ` : ''}${error.message || 'unknown error'}`).join('; ')
      : `HTTP ${response.status}`;
    throw new Error(detail.slice(0, 400));
  }
  return body;
}

async function graphql(token, query, variables) {
  const body = await request(GRAPHQL, token, { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (body && Array.isArray(body.errors) && body.errors.length) {
    throw new Error(body.errors.map((error) => error.message || 'GraphQL error').join('; ').slice(0, 400));
  }
  return body;
}

async function listAccounts(token) {
  const body = await request(`${API}/accounts`, token);
  return (body && body.result) || [];
}

async function listRumSites(token, accountId) {
  try {
    const body = await request(`${API}/accounts/${accountId}/rum/site_info/list?per_page=50`, token);
    return (body && body.result) || [];
  } catch (error) {
    console.log(`  Web Analytics sites: unavailable (${error.message})`);
    return [];
  }
}

function hostOfSite(site) {
  const rule = site && Array.isArray(site.rules) ? site.rules.find((entry) => entry && entry.host) : null;
  const value = String((site && site.host) || (rule && rule.host) || '');
  // The list endpoint reports the host as an anchored regex, e.g.
  // "(irishvisaupdatetracker.pages.dev)$".
  return value.replace(/^\(/, '').replace(/\)?\$$/, '').replace(/^\^/, '');
}

const PROBE_QUERY = `query Probe($account: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(limit: 1, filter: { datetime_geq: $since, datetime_lt: $until }) { count }
    }
  }
}`;

function groupsOf(body) {
  const accounts = body && body.data && body.data.viewer ? body.data.viewer.accounts : null;
  const account = Array.isArray(accounts) ? accounts[0] : null;
  return (account && account.rumPageloadEventsAdaptiveGroups) || [];
}

async function runCheck(token, envAccountId) {
  const verify = await request(`${API}/user/tokens/verify`, token);
  const status = verify && verify.result ? verify.result.status : 'unknown';
  console.log(`Token: ${status === 'active' ? 'active' : status}`);
  if (status !== 'active') {
    console.error('The token is not active. Create a new one; Cloudflare does not re-show a token value.');
    return false;
  }

  // An account-scoped token cannot list accounts, so the configured id is used
  // directly; listing accounts is only the discovery fallback.
  const accounts = envAccountId ? [{ id: envAccountId, name: 'configured' }] : await listAccounts(token);
  if (!accounts.length) {
    console.error('Set CLOUDFLARE_ACCOUNT_ID: an account-scoped token cannot list accounts.');
    return false;
  }

  const untilDate = new Date().toISOString().slice(0, 10);
  const sinceDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let ok = true;
  for (const account of accounts) {
    console.log(`Account: ${account.name || 'unnamed'} ${account.id}`);
    console.log('  Permitted: Account Analytics: Read (RUM datasets) + Account Settings: Read (Web Analytics site API)');

    // Web Analytics site management endpoint: proves the Web Analytics surface,
    // not just the GraphQL RUM dataset.
    try {
      const sites = await listRumSites(token, account.id);
      console.log(`  Web Analytics sites: ${sites.length} site(s)`);
      for (const site of sites) {
        console.log(`    host=${hostOfSite(site) || 'unknown'} site_tag=${site.site_tag || 'unknown'}`);
      }
      if (!sites.length) {
        console.log('    No Web Analytics site is registered (dashboard -> Web Analytics -> Add a site).');
      }
    } catch (error) {
      ok = false;
    }

    try {
      const body = await graphql(token, PROBE_QUERY, {
        account: account.id,
        since: `${sinceDate}T00:00:00Z`,
        until: `${untilDate}T00:00:00Z`,
      });
      console.log(`  RUM query: OK (${groupsOf(body).length} daily group(s) in the last day)`);
    } catch (error) {
      console.error(`  RUM query: FAILED (${error.message})`);
      ok = false;
    }
  }
  return ok;
}

function printTable(title, headers, rows) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (!rows.length) {
    console.log('No rows.');
    return;
  }
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index]).length)));
  const line = (cells) => cells.map((cell, index) => String(cell).padStart(widths[index])).join('  ');
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

const PAGE_QUERY = `query Pageviews($account: String!, $host: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 100
        filter: { datetime_geq: $since, datetime_lt: $until, requestHost: $host }
        orderBy: [date_ASC]
      ) {
        count
        sum { visits }
        dimensions { date }
      }
    }
  }
}`;

const TOP_PAGES_QUERY = `query TopPages($account: String!, $host: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 15
        filter: { datetime_geq: $since, datetime_lt: $until, requestHost: $host }
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions { requestPath }
      }
    }
  }
}`;

const COUNTRY_QUERY = `query Countries($account: String!, $host: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $since, datetime_lt: $until, requestHost: $host }
        orderBy: [count_DESC]
      ) {
        count
        sum { visits }
        dimensions { countryName }
      }
    }
  }
}`;

// Homepage pageviews mostly track direct and repeat visits, so growth is read
// from human pageviews on every other path. `bot: 0` is the only server-side
// filter the RUM dataset offers; Web Analytics cannot exclude an IP address.
const PATH_MIX_QUERY = `query PathMix($account: String!, $host: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 1000
        filter: { datetime_geq: $since, datetime_lt: $until, requestHost: $host, bot: 0 }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { requestPath }
      }
    }
  }
}`;

const WEB_VITALS_QUERY = `query WebVitals($account: String!, $host: String!, $since: Time!, $until: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      rumWebVitalsEventsAdaptiveGroups(
        limit: 10
        filter: { datetime_geq: $since, datetime_lt: $until, requestHost: $host, bot: 0 }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { deviceType }
        quantiles {
          largestContentfulPaintP75
          interactionToNextPaintP75
          cumulativeLayoutShiftP75
          firstContentfulPaintP75
          timeToFirstByteP75
        }
      }
    }
  }
}`;

/** Web vitals P75 values arrive in microseconds; -1 means "no sample". */
function microToMs(value) {
  return typeof value === 'number' && value > 0 ? Math.round(value / 100) / 10 : null;
}

function webVitalsOf(body) {
  const accounts = body && body.data && body.data.viewer ? body.data.viewer.accounts : null;
  const account = Array.isArray(accounts) ? accounts[0] : null;
  return (account && account.rumWebVitalsEventsAdaptiveGroups) || [];
}

async function runReport(token, accountId, host, days, asJson) {
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const variables = { account: accountId, host, since: `${since}T00:00:00Z`, until: `${until}T00:00:00Z` };

  const [dailyBody, pagesBody, countryBody, vitalsBody, mixBody] = await Promise.all([
    graphql(token, PAGE_QUERY, variables),
    graphql(token, TOP_PAGES_QUERY, variables),
    graphql(token, COUNTRY_QUERY, variables),
    // Vitals are only recorded for browsers that report them; a missing or
    // empty dataset must not fail the traffic report.
    graphql(token, WEB_VITALS_QUERY, variables).catch(() => null),
    graphql(token, PATH_MIX_QUERY, variables).catch(() => null),
  ]);
  const groupsOf = (body) => {
    const accounts = body && body.data && body.data.viewer ? body.data.viewer.accounts : null;
    const account = Array.isArray(accounts) ? accounts[0] : null;
    return (account && account.rumPageloadEventsAdaptiveGroups) || [];
  };

  const daily = groupsOf(dailyBody).map((group) => ({
    date: group.dimensions ? group.dimensions.date : '',
    pageviews: group.count || 0,
    visits: group.sum ? group.sum.visits || 0 : 0,
  }));
  const topPages = groupsOf(pagesBody).map((group) => ({
    path: group.dimensions ? group.dimensions.requestPath || '/' : '/',
    pageviews: group.count || 0,
    visits: group.sum ? group.sum.visits || 0 : 0,
  }));
  const countries = groupsOf(countryBody).map((group) => ({
    country: group.dimensions ? group.dimensions.countryName || 'unknown' : 'unknown',
    pageviews: group.count || 0,
  }));
  const pathMix = groupsOf(mixBody).map((group) => ({
    path: group.dimensions ? group.dimensions.requestPath || '/' : '/',
    pageviews: group.count || 0,
  }));
  const humanPageviews = pathMix.reduce((sum, row) => sum + row.pageviews, 0);
  const homepagePageviews = pathMix
    .filter((row) => row.path === '/')
    .reduce((sum, row) => sum + row.pageviews, 0);
  const totalPageviews = daily.reduce((sum, row) => sum + row.pageviews, 0);
  const traffic = mixBody ? {
    humanPageviews,
    botPageviews: Math.max(0, totalPageviews - humanPageviews),
    homepagePageviews,
    subpagePageviews: Math.max(0, humanPageviews - homepagePageviews),
  } : null;

  const webVitals = webVitalsOf(vitalsBody).map((group) => {
    const quantiles = group.quantiles || {};
    const cls = quantiles.cumulativeLayoutShiftP75;
    return {
      device: group.dimensions ? group.dimensions.deviceType || 'unknown' : 'unknown',
      samples: group.count || 0,
      lcp_ms: microToMs(quantiles.largestContentfulPaintP75),
      inp_ms: microToMs(quantiles.interactionToNextPaintP75),
      cls: typeof cls === 'number' && cls >= 0 ? Math.round(cls * 1000) / 1000 : null,
      fcp_ms: microToMs(quantiles.firstContentfulPaintP75),
      ttfb_ms: microToMs(quantiles.timeToFirstByteP75),
    };
  });

  const report = {
    host,
    account_id: accountId,
    window: { since, until, days },
    totals: {
      pageviews: totalPageviews,
      visits: daily.reduce((sum, row) => sum + row.visits, 0),
    },
    traffic,
    daily,
    topPages,
    countries,
    webVitals,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  console.log(`Cloudflare Web Analytics: ${host}, ${since} to ${until} (${days} day(s))`);
  console.log(`Totals: ${report.totals.pageviews.toLocaleString('en-IE')} pageviews, ${report.totals.visits.toLocaleString('en-IE')} visits`);
  if (traffic) {
    const share = (part, whole) => (whole ? `${((part / whole) * 100).toFixed(1)}%` : '0.0%');
    console.log(`\nHuman vs bot traffic (pageviews)`);
    console.log('-'.repeat(30));
    console.log(`human ${traffic.humanPageviews} (${share(traffic.humanPageviews, totalPageviews)} of all)`);
    console.log(`  homepage /   ${traffic.homepagePageviews} (${share(traffic.homepagePageviews, traffic.humanPageviews)} of human)`);
    console.log(`  subpages     ${traffic.subpagePageviews} (${share(traffic.subpagePageviews, traffic.humanPageviews)} of human)`);
    console.log(`bot   ${traffic.botPageviews} (${share(traffic.botPageviews, totalPageviews)} of all)`);
    console.log('Read growth on subpage human pageviews: the homepage is mostly direct and repeat traffic.');
  }
  printTable('Daily pageviews', ['date', 'pageviews', 'visits'], daily.map((row) => [row.date, row.pageviews, row.visits]));
  printTable('Top pages', ['path', 'pageviews', 'visits'], topPages.map((row) => [row.path, row.pageviews, row.visits]));
  printTable('Top countries', ['country', 'pageviews'], countries.map((row) => [row.country, row.pageviews]));
  const vitals = (value, unit = '') => (value === null ? 'n/a' : `${value}${unit}`);
  printTable(
    'Core Web Vitals (p75, human traffic)',
    ['device', 'samples', 'LCP', 'INP', 'CLS', 'FCP', 'TTFB'],
    webVitals.map((row) => [row.device, row.samples, vitals(row.lcp_ms, ' ms'), vitals(row.inp_ms, ' ms'), vitals(row.cls), vitals(row.fcp_ms, ' ms'), vitals(row.ttfb_ms, ' ms')]),
  );
  if (webVitals.length) {
    console.log('Google "good" thresholds: LCP <= 2500 ms, INP <= 200 ms, CLS <= 0.1 (FCP <= 1800 ms, TTFB <= 800 ms).');
    console.log('n/a means too few samples for that metric in this window.');
  }
  if (!daily.length) {
    console.log('\nNo rows. Either the host has no traffic in this window, or Web Analytics is not enabled for it:');
    console.log(`add ${host} under Cloudflare dashboard -> Web Analytics -> Add a site, redeploy, and re-run after a day of traffic.`);
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const env = readLocalEnv();
  const token = String(process.env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  if (!token) {
    console.error('CLOUDFLARE_API_TOKEN is not set. Put it in .dev.vars (gitignored) with:');
    console.error('  CLOUDFLARE_API_TOKEN=<token with Account -> Account Analytics -> Read>');
    console.error('  CLOUDFLARE_ACCOUNT_ID=<32-character account id>');
    process.exitCode = 1;
    return;
  }

  if (args.includes('--check')) {
    const ok = await runCheck(token, accountId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!accountId) {
    const accounts = await listAccounts(token);
    if (accounts.length !== 1) {
      console.error(`CLOUDFLARE_ACCOUNT_ID is required: the token can read ${accounts.length} account(s).`);
      process.exitCode = 1;
      return;
    }
  }
  const resolvedAccount = accountId || (await listAccounts(token))[0].id;
  const days = Math.max(1, Math.min(90, Number(readArgument(args, 'days', '7')) || 7));
  const configuredHost = readArgument(args, 'host', '');
  const host = configuredHost || new URL(siteOrigin()).host;
  const siteTag = readArgument(args, 'site-tag', '');
  const target = siteTag ? `${host} (site_tag ${siteTag})` : host;

  try {
    await runReport(token, resolvedAccount, host, days, args.includes('--json'));
  } catch (error) {
    console.error(`Cloudflare analytics query failed for ${target}: ${error.message}`);
    console.error('Check that the token has Account -> Account Analytics -> Read and that CLOUDFLARE_ACCOUNT_ID is the right account.');
    process.exitCode = 1;
  }
}

await main();
