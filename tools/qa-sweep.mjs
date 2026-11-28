#!/usr/bin/env node
/**
 * Full-route production QA sweep.
 *
 * The hand-run QA pass covered every sitemap route at desktop and mobile. This
 * script makes that pass repeatable: it reads the sitemap index and family
 * sitemaps, visits every route at both widths, and checks:
 *
 *   - axe accessibility violations
 *   - console errors and uncaught page errors
 *   - horizontal overflow and the shared header/footer shell
 *   - every internal link found on a visited page
 *
 * It runs against a local built tree by default. For a production spot check:
 *
 *   QA_BASE_URL=https://irishvisaupdatetracker.pages.dev node tools/qa-sweep.mjs
 *
 *   node tools/qa-sweep.mjs --base http://127.0.0.1:8796
 */

import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE = argValue('--base', process.env.QA_BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const BASE_ORIGIN = new URL(BASE).origin;
const WORKERS = Math.max(1, Number(process.env.QA_WORKERS || 4));
const REQUEST_TIMEOUT = Number(process.env.QA_REQUEST_TIMEOUT || 30000);
const LINK_TIMEOUT = Number(process.env.QA_LINK_TIMEOUT || 15000);

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 667 },
];

function routePath(loc) {
  try {
    const url = new URL(loc, BASE);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return pathname;
  } catch {
    return '';
  }
}

function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1].trim()).filter(Boolean);
}

async function fetchText(path) {
  const response = await fetch(BASE + path, {
    redirect: 'follow',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

async function sitemapRoutes() {
  const index = await fetchText('/sitemap.xml');
  const locations = sitemapLocs(index);
  if (!locations.length) throw new Error('/sitemap.xml has no <loc> entries');

  let pageLocations = locations;
  if (/<sitemapindex\b/i.test(index)) {
    pageLocations = [];
    for (const child of locations) {
      const childPath = routePath(child);
      if (!childPath) continue;
      const xml = await fetchText(childPath);
      pageLocations.push(...sitemapLocs(xml));
    }
  }

  const routes = [...new Set(pageLocations.map(routePath).filter(Boolean))];
  if (!routes.length) throw new Error('sitemap contains no page routes');
  return routes;
}

function linkTarget(href, currentRoute) {
  if (!href || href.startsWith('#')) return null;
  let url;
  try {
    url = new URL(href, BASE + currentRoute);
  } catch {
    return null;
  }
  if (url.origin !== BASE_ORIGIN) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // A hash is not sent to the server; the page target is what can be checked.
  return url.pathname + url.search;
}

function axeNodeSummary(node) {
  return {
    target: Array.isArray(node.target) ? node.target.join(' ') : String(node.target || ''),
    html: String(node.html || '').slice(0, 220),
    failureSummary: String(node.failureSummary || '').split('\n')[0],
  };
}

async function runJob(page, route, viewport) {
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  const onPageError = (error) => pageErrors.push(error.message);

  page.removeAllListeners('console');
  page.removeAllListeners('pageerror');
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const response = await page.goto(BASE + route, {
      waitUntil: 'domcontentloaded',
      timeout: REQUEST_TIMEOUT,
    });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(300);
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

    const layout = await page.evaluate(() => {
      const header = document.querySelectorAll('header.sitebar').length;
      const footer = document.querySelectorAll('footer.sitebar-footer').length;
      const main = document.querySelectorAll('main').length;
      return {
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body ? document.body.scrollWidth : 0,
        viewportWidth: window.innerWidth,
        header,
        footer,
        main,
      };
    });

    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map((anchor) => anchor.getAttribute('href'))
      .filter(Boolean));

    const axe = await new AxeBuilder({ page }).analyze();

    return {
      route,
      viewport: viewport.name,
      status: response ? response.status() : 0,
      consoleErrors,
      pageErrors,
      layout,
      links,
      violations: axe.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.slice(0, 4).map(axeNodeSummary),
      })),
      incomplete: axe.incomplete.length,
    };
  } finally {
    page.removeListener('console', onConsole);
    page.removeListener('pageerror', onPageError);
  }
}

async function checkLinks(linksByTarget) {
  const targets = [...linksByTarget.keys()].sort();
  const failures = [];
  let cursor = 0;

  async function worker() {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      try {
        const response = await fetch(BASE + target, {
          redirect: 'follow',
          signal: AbortSignal.timeout(LINK_TIMEOUT),
        });
        if (response.status >= 400) {
          failures.push(`${target}: HTTP ${response.status} (linked from ${[...linksByTarget.get(target)].slice(0, 4).join(', ')})`);
        }
      } catch (error) {
        failures.push(`${target}: request failed (${error.message.split('\n')[0]})`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(8, targets.length) }, worker));
  return { checked: targets.length, failures };
}

function formatViolation(result, violation) {
  const nodes = violation.nodes
    .map((node) => `    - ${node.target}: ${node.failureSummary}`)
    .join('\n');
  return `  ${result.route} @ ${result.viewport}: ${violation.id} (${violation.impact})\n${nodes}`;
}

async function main() {
  console.log('Full-route production QA sweep');
  console.log('='.repeat(60));
  console.log(`Base: ${BASE}`);

  const routes = await sitemapRoutes();
  const jobs = [];
  for (const viewport of VIEWPORTS) {
    for (const route of routes) jobs.push({ route, viewport });
  }

  console.log(`Sitemap routes: ${routes.length}; viewports: ${VIEWPORTS.map((viewport) => viewport.name).join(', ')}; checks: ${jobs.length}`);

  const browser = await chromium.launch();
  const results = [];
  const linksByTarget = new Map();
  let cursor = 0;

  async function worker() {
    const context = await browser.newContext();
    const page = await context.newPage();
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const result = await runJob(page, job.route, job.viewport);
        results.push(result);
        for (const href of result.links) {
          const target = linkTarget(href, job.route);
          if (!target) continue;
          if (!linksByTarget.has(target)) linksByTarget.set(target, new Set());
          linksByTarget.get(target).add(`${job.route} (${job.viewport.name})`);
        }
      } catch (error) {
        results.push({
          route: job.route,
          viewport: job.viewport.name,
          error: error.message.split('\n')[0],
          consoleErrors: [],
          pageErrors: [],
          violations: [],
          links: [],
        });
      }
      if (results.length % 25 === 0 || results.length === jobs.length) {
        console.log(`  checked ${results.length}/${jobs.length}`);
      }
    }
    await context.close();
  }

  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  await browser.close();

  const linkCheck = await checkLinks(linksByTarget);
  const failures = [];
  let accessibilityCount = 0;
  let consoleCount = 0;
  let layoutCount = 0;
  let routeCount = 0;

  for (const result of results) {
    const label = `${result.route} @ ${result.viewport}`;
    if (result.error) {
      failures.push(`${label}: ${result.error}`);
      routeCount += 1;
      continue;
    }
    if (result.status >= 400) {
      failures.push(`${label}: HTTP ${result.status}`);
      routeCount += 1;
    }
    for (const message of result.consoleErrors) {
      failures.push(`${label}: console error: ${message}`);
      consoleCount += 1;
    }
    for (const message of result.pageErrors) {
      failures.push(`${label}: page error: ${message}`);
      consoleCount += 1;
    }
    if (result.layout.documentWidth > result.layout.viewportWidth + 1) {
      failures.push(`${label}: horizontal overflow (${result.layout.documentWidth}px document, ${result.layout.viewportWidth}px viewport)`);
      layoutCount += 1;
    }
    if (result.layout.bodyWidth > result.layout.viewportWidth + 1) {
      failures.push(`${label}: body overflow (${result.layout.bodyWidth}px body, ${result.layout.viewportWidth}px viewport)`);
      layoutCount += 1;
    }
    if (result.layout.header !== 1) {
      failures.push(`${label}: ${result.layout.header} header.sitebar element(s)`);
      layoutCount += 1;
    }
    if (result.layout.footer !== 1) {
      failures.push(`${label}: ${result.layout.footer} footer.sitebar-footer element(s)`);
      layoutCount += 1;
    }
    if (result.layout.main < 1) {
      failures.push(`${label}: no main element`);
      layoutCount += 1;
    }
    for (const violation of result.violations) {
      accessibilityCount += 1;
      failures.push(formatViolation(result, violation));
    }
  }

  for (const failure of linkCheck.failures) failures.push(`link ${failure}`);

  console.log('\n' + '='.repeat(60));
  console.log(`Routes: ${routes.length}; page checks: ${results.length}; internal links checked: ${linkCheck.checked}`);
  console.log(`Accessibility violations: ${accessibilityCount}; console/page errors: ${consoleCount}; layout failures: ${layoutCount}; link failures: ${linkCheck.failures.length}; route failures: ${routeCount}`);
  if (failures.length) {
    console.error('\nFAILURES\n' + failures.join('\n'));
    console.error(`\n${failures.length} QA problem(s) found.`);
    process.exitCode = 1;
  } else {
    console.log('\nQA sweep passed.');
  }
}

main().catch((error) => {
  console.error('QA sweep failed: ' + error.message);
  process.exitCode = 1;
});
