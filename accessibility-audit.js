/**
 * Accessibility audit (WCAG 2.1 AA) for the whole site.
 *
 * It used to cover three pages at three widths in the light theme, which left
 * the shared header unaudited on the other fourteen pages and never exercised
 * the dashboard's dark theme. This walks every page at four widths, plus the
 * dark theme on the pages that actually implement one.
 *
 *   AUDIT_BASE_URL=http://127.0.0.1:8788 node accessibility-audit.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { PAGES } from './tools/site-chrome.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.AUDIT_BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY || 3);

const VIEWPORTS = [
  { width: 1280, height: 900, name: 'desktop' },
  { width: 960, height: 900, name: 'tablet-wide' },
  { width: 760, height: 900, name: 'tablet' },
  { width: 375, height: 667, name: 'mobile' },
];

// site-chrome.js applies the stored theme only where the dashboard exists;
// every other page is deliberately forced light, so a dark pass there would
// just repeat the light result.
const THEMED_PAGES = new Set(['index.html']);

const pages = PAGES.filter((page) => page.route && page.layout !== false);

function buildMatrix() {
  const matrix = [];
  for (const page of pages) {
    for (const viewport of VIEWPORTS) matrix.push({ page, viewport, theme: 'light' });
  }
  for (const page of pages.filter((candidate) => THEMED_PAGES.has(candidate.file))) {
    for (const viewport of VIEWPORTS.filter((candidate) => candidate.name === 'desktop' || candidate.name === 'mobile')) {
      matrix.push({ page, viewport, theme: 'dark' });
    }
  }
  return matrix;
}

async function runAudit(browser, job) {
  const context = await browser.newContext({
    viewport: { width: job.viewport.width, height: job.viewport.height },
    colorScheme: job.theme === 'dark' ? 'dark' : 'light',
  });
  if (job.theme === 'dark') {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('visa-theme', 'dark');
      } catch (error) {
        /* private mode */
      }
    });
  }
  const page = await context.newPage();
  try {
    await page.goto(BASE_URL + job.page.route, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
    await page.waitForTimeout(250);

    if (job.theme === 'dark') {
      const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (applied !== 'dark') throw new Error(`dark theme was not applied (data-theme=${applied})`);
    }

    const results = await new AxeBuilder({ page }).analyze();
    return {
      violations: results.violations,
      incomplete: results.incomplete,
      passes: results.passes.length,
    };
  } finally {
    await context.close();
  }
}

function violationReport(violation) {
  const nodes = violation.nodes
    .slice(0, 8)
    .map((node) => `  - \`${node.html}\``)
    .join('\n');
  return `### ${violation.id} (${violation.impact} impact)\n${violation.help}\n${nodes}\n`;
}

async function main() {
  console.log('Accessibility audit (WCAG 2.1 AA)');
  console.log('='.repeat(60));

  try {
    const response = await fetch(BASE_URL + '/');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`Dev server not responding on ${BASE_URL} (${error.message})`);
    console.log('Run: npx wrangler pages dev . --port ' + (new URL(BASE_URL).port || '8788'));
    process.exit(1);
  }

  const matrix = buildMatrix();
  const browser = await chromium.launch();
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < matrix.length) {
      const job = matrix[cursor++];
      const label = `${job.page.file} @ ${job.viewport.name}${job.theme === 'dark' ? ' (dark)' : ''}`;
      try {
        const audit = await runAudit(browser, job);
        results.push({ ...job, ...audit });
        console.log(
          `  ${audit.violations.length ? 'FAIL' : 'ok  '} ${label}: ${audit.violations.length} violation(s), ${audit.incomplete.length} incomplete`
        );
      } catch (error) {
        results.push({ ...job, error: error.message });
        console.error(`  FAIL ${label}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, matrix.length) }, worker));
  await browser.close();

  const failures = results.filter((result) => result.error);
  const violations = results.filter((result) => result.violations && result.violations.length);
  const violationCount = violations.reduce((total, result) => total + result.violations.length, 0);
  const incompleteCount = results.reduce((total, result) => total + (result.incomplete ? result.incomplete.length : 0), 0);

  const sections = violations.map(
    (result) =>
      `## ${result.page.file} — ${result.viewport.name}${result.theme === 'dark' ? ' (dark)' : ''}\n\n` +
      result.violations.map(violationReport).join('\n')
  );

  const report = `# Accessibility Audit Report (WCAG 2.1 AA)

**Generated:** ${new Date().toISOString()}
**Pages:** ${pages.length} | **Combinations:** ${results.length} | **Total violations:** ${violationCount}
**Total incomplete (manual review):** ${incompleteCount}

${sections.length ? sections.join('\n---\n\n') : 'No violations found.'}

## Summary

${violationCount === 0 ? '✅ **No violations found.**' : `❌ **${violationCount} violations found** — fix required for WCAG 2.1 AA compliance.`}
${failures.length ? `\n❌ ${failures.length} combination(s) could not be audited.` : ''}
`;

  fs.writeFileSync(path.join(__dirname, 'accessibility-report.md'), report);

  console.log('\n' + '='.repeat(60));
  console.log(`Pages: ${pages.length}; combinations: ${results.length}; violations: ${violationCount}; incomplete: ${incompleteCount}`);
  for (const failure of failures) console.error(`Audit error: ${failure.page.file} ${failure.viewport.name}: ${failure.error}`);
  for (const result of violations) {
    console.error(`${result.page.file} ${result.viewport.name}: ${result.violations.map((violation) => violation.id).join(', ')}`);
  }
  console.log('Report: accessibility-report.md');

  if (violationCount > 0 || failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
