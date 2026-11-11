/**
 * Measures the homepage with the performance attributes present and a temporary
 * copy with them removed. Both are served by the same Worker, so compression is
 * identical; each run uses a fresh cache-disabled browser context.
 * Usage: node tools/measure-performance.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://127.0.0.1:8788';
const baselineFile = 'perf-baseline.html';
let html = fs.readFileSync('index.html', 'utf8');
html = html
  .replace(/\s*<link rel="preload" href="\/fonts\/[^"]+"[^>]*>/g, '')
  .replace('<script src="lucide.min.js" defer></script>', '<script src="lucide.min.js"></script>');
fs.writeFileSync(baselineFile, html);

const browser = await chromium.launch({ headless: true });
const runs = { optimized: [], baseline: [] };

async function measure(label, path) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.addInitScript(() => {
    window.__lcp = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__lcp = entry.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
  });
  await page.goto(base + path, { waitUntil: 'load', timeout: 45000 });
  await page.waitForSelector('h1', { timeout: 15000 });
  await page.waitForTimeout(400);
  const nav = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] || {};
    return {
      domContentLoaded: Math.round(entry.domContentLoadedEventEnd || 0),
      load: Math.round(entry.loadEventEnd || 0),
      transferSize: entry.transferSize || 0,
      lcp: Math.round(window.__lcp || 0)
    };
  });
  await context.close();
  runs[label].push(nav);
}

try {
  for (let i = 0; i < 3; i++) {
    await measure('baseline', '/' + baselineFile);
    await measure('optimized', '/');
  }
} finally {
  await browser.close();
  fs.unlinkSync(baselineFile);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const output = {};
for (const [label, values] of Object.entries(runs)) {
  output[label] = {
    domContentLoaded: median(values.map((v) => v.domContentLoaded)),
    load: median(values.map((v) => v.load)),
    transferSize: median(values.map((v) => v.transferSize)),
    lcp: median(values.map((v) => v.lcp)),
    samples: values
  };
}
console.log(JSON.stringify(output, null, 2));
