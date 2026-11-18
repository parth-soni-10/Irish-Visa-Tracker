#!/usr/bin/env node
/**
 * Layout invariants for the shared header.
 *
 * The regression this guards against is structural, not pixel-level: on
 * 2024-11 the nav was given width:100% and flex:1 children, so it dropped to a
 * second row and stretched — but only on pages whose CSS reset caused a
 * different box height. No screenshot baseline would have caught that
 * reliably; these measurements do.
 *
 * For every page and every width: one header, one footer, a stable header
 * height across pages, no page-level horizontal overflow, brand and nav on one
 * row whenever they are supposed to be, and disclosure panels inside the
 * viewport (including a short landscape window).
 *
 *   node tools/check-chrome-layout.mjs --base http://127.0.0.1:8788
 */

import { chromium } from 'playwright';
import { PAGES } from './site-chrome.mjs';

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE = argValue('--base', process.env.LAYOUT_BASE_URL || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const WORKERS = Number(process.env.LAYOUT_WORKERS || 4);

const WIDTHS = [
  { width: 1280, height: 900 },
  { width: 1000, height: 900 },
  { width: 961, height: 900 },
  { width: 960, height: 900 },
  { width: 760, height: 900 },
  { width: 390, height: 844 },
  { width: 667, height: 375 },
];

async function measure(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const header = document.querySelector('header.sitebar');
    const brand = document.querySelector('header.sitebar .brand');
    const nav = document.querySelector('header.sitebar .sitebar-nav');
    const footer = document.querySelector('footer.sitebar-footer');
    return {
      header: header ? rect(header) : null,
      brand: brand ? rect(brand) : null,
      nav: nav ? rect(nav) : null,
      navScrollWidth: nav ? nav.scrollWidth : 0,
      navClientWidth: nav ? nav.clientWidth : 0,
      headers: document.querySelectorAll('header.sitebar').length,
      footers: document.querySelectorAll('footer.sitebar-footer').length,
      current: document.querySelectorAll('header.sitebar .sitebar-nav [aria-current="page"]').length,
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      footerPresent: Boolean(footer),
    };
  });
}

async function panelState(page, selector) {
  return page.evaluate((pattern) => {
    const details = document.querySelector(pattern);
    if (!details) return { missing: true };
    details.open = true;
    const panel = details.querySelector('.sitebar-more-panel');
    const box = panel.getBoundingClientRect();
    const style = getComputedStyle(panel);
    const state = {
      top: box.top,
      bottom: box.bottom,
      height: box.height,
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      scrollHeight: panel.scrollHeight,
      clientHeight: panel.clientHeight,
      viewportHeight: window.innerHeight,
    };
    details.open = false;
    return state;
  }, selector);
}

async function main() {
  const pages = PAGES.filter((page) => page.route && page.layout !== false);
  const jobs = [];
  for (const width of WIDTHS) for (const page of pages) jobs.push({ width, page });

  const browser = await chromium.launch();
  const failures = [];
  const heights = new Map(); // width -> Map(file -> height)
  let cursor = 0;

  async function worker() {
    const page = await browser.newPage();
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const label = `${job.page.file} @ ${job.width.width}x${job.width.height}`;
      try {
        await page.setViewportSize({ width: job.width.width, height: job.width.height });
        await page.goto(BASE + job.page.route, { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve()));
        const result = await measure(page);

        if (!result.header) {
          failures.push(`${label}: no header.sitebar`);
          continue;
        }
        if (result.headers !== 1) failures.push(`${label}: ${result.headers} header.sitebar elements`);
        if (!result.footerPresent) failures.push(`${label}: no footer`);
        if (result.footers !== 1) failures.push(`${label}: ${result.footers} footer elements`);
        if (result.documentWidth > result.viewportWidth + 1) {
          failures.push(`${label}: page overflows horizontally (${result.documentWidth}px document, ${result.viewportWidth}px viewport)`);
        }
        if (result.header.top < -1) failures.push(`${label}: header starts above the viewport`);

        const expectedCurrent = job.page.current ? 1 : 0;
        if (result.current !== expectedCurrent) {
          failures.push(`${label}: ${result.current} current nav item(s), expected ${expectedCurrent}`);
        }

        if (job.width.width >= 961) {
          const sameRow = result.nav.top < result.brand.bottom - 2 && result.brand.top < result.nav.bottom - 2;
          if (!sameRow) failures.push(`${label}: brand and nav are not on one row at desktop width`);
          if (result.header.height > 100) failures.push(`${label}: header is ${Math.round(result.header.height)}px tall on one row`);
        }

        const bucket = heights.get(job.width.width) || new Map();
        bucket.set(job.page.file, result.header.height);
        heights.set(job.width.width, bucket);

        if (job.width.width === 390 || job.width.width === 667) {
          for (const [pattern, name] of [
            ['.sitebar-more', 'More'],
            ['.sitebar-prefs', 'Preferences'],
          ]) {
            const panel = await panelState(page, pattern);
            if (panel.missing) {
              failures.push(`${label}: ${name} panel missing`);
              continue;
            }
            if (panel.top < -1 || panel.bottom > panel.viewportHeight + 1) {
              failures.push(
                `${label}: ${name} panel is off-screen (top ${Math.round(panel.top)}, bottom ${Math.round(panel.bottom)}, viewport ${panel.viewportHeight})`
              );
            }
            if (panel.maxHeight === 'none') failures.push(`${label}: ${name} panel has no max-height at mobile width`);
            if (panel.overflowY !== 'auto' && panel.overflowY !== 'scroll') {
              failures.push(`${label}: ${name} panel cannot scroll (overflow-y: ${panel.overflowY})`);
            }
          }
        }
      } catch (error) {
        failures.push(`${label}: ${error.message.split('\n')[0]}`);
      }
    }
    await page.close();
  }

  await Promise.all(Array.from({ length: Math.min(WORKERS, jobs.length) }, worker));
  await browser.close();

  for (const [width, bucket] of heights) {
    const values = [...bucket.values()];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min > 2) {
      const outliers = [...bucket.entries()]
        .filter(([, height]) => Math.abs(height - min) > 2)
        .map(([file, height]) => `${file} ${Math.round(height)}px`)
        .join(', ');
      failures.push(`width ${width}: header height varies ${Math.round(min)}–${Math.round(max)}px (${outliers})`);
    }
  }

  if (failures.length) {
    console.error(failures.join('\n'));
    console.error(`${failures.length} chrome layout problem(s) found.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Header layout OK: ${pages.length} pages × ${WIDTHS.length} widths, identical header height per width.`);
}

main().catch((error) => {
  console.error('Chrome layout check failed: ' + error.message);
  process.exitCode = 1;
});
