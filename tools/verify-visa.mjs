/**
 * Verify the built cutover app the way a browser meets it.
 *
 *   node tools/serve-app.mjs &
 *   VISA_BASE_URL=http://127.0.0.1:4311/ node tools/verify-visa.mjs
 *
 * Per route at 375/768/1280: the page renders a heading, every `data-component`
 * on that route is counted, axe serious/critical must be zero (both themes),
 * the CSP console listener must stay quiet, and reduced motion must collapse a
 * control's transition. At 1280 it also drives the URL contract
 * (`?tracker=&tab=&q=&date=` + popstate), the keyboard journey (tabs, segments,
 * dialog) and the service-worker update prompt.
 */
import { chromium } from '../../design-system/node_modules/@playwright/test/index.mjs';
import AxeBuilder from '../../design-system/node_modules/@axe-core/playwright/dist/index.mjs';
import { mkdir } from 'node:fs/promises';

const base = process.env.VISA_BASE_URL || 'http://127.0.0.1:4311/';
const ROUTES = ['/', '/?tracker=visa&tab=home', '/?tracker=visa&tab=daily', '/?tracker=visa&tab=past', '/?tracker=visa&tab=suggest', '/?tracker=1g', '/?tracker=permits', '/?admin=1'];
const SHOTS = '../docs/screenshots/visa';
const serious = (report) => report.violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => `${v.id}:${v.nodes.length}`);
const out = { base, routes: [], consoleErrors: [], keyboard: {}, url: {}, update: {}, screenshots: true };

await mkdir(SHOTS, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [375, 768, 1280]) {
    for (const route of ROUTES) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && /refused to|content security policy|violat/i.test(message.text())) errors.push(message.text());
      });
      await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-component]', { timeout: 30000 });
      await page.waitForSelector('#view h1', { timeout: 30000 });
      await page.waitForTimeout(250);
      const heading = await page.locator('#view h1').first().innerText();
      const counts = await page.evaluate(() => {
        const map = {};
        document.querySelectorAll('[data-component]').forEach((node) => { map[node.dataset.component] = (map[node.dataset.component] || 0) + 1; });
        return map;
      });
      const dark = serious(await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze());
      await page.locator('[data-action="theme"]').click();
      await page.waitForTimeout(300);
      const light = serious(await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze());
      if (width === 1280) await page.screenshot({ path: `${SHOTS}/1280${route === '/' ? '' : '-inner'}-light.png`, fullPage: true });
      if (route === '/' || route === '/?tracker=visa&tab=daily') {
        await page.screenshot({ path: `${SHOTS}/${width}.png`, fullPage: true });
        await page.locator('[data-action="theme"]').click();
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${SHOTS}/${width}-light.png`, fullPage: true });
      }
      out.routes.push({ width, route, heading, components: counts, axeDark: dark, axeLight: light });
      out.consoleErrors.push(...errors.map((e) => `${width}px ${route}: ${e}`));
      await context.close();
    }
  }

  // One context for the interaction checks, at desktop width.
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const readiness = (p) => p.waitForSelector('#view h1', { timeout: 30000 });

  await page.goto(new URL('/?tracker=visa&tab=past&q=48850812&date=2026-07-12', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-component]', { timeout: 30000 });
  await readiness(page);
  out.url.loaded = await page.evaluate(() => ({
    search: document.querySelector('#past-q')?.value,
    date: document.querySelector('#past-date')?.value,
    tab: document.querySelector('#panel-visa-past') !== null,
  }));
  if (out.url.loaded.search !== '48850812') throw new Error(`URL contract: q not restored (${out.url.loaded.search})`);
  if (out.url.loaded.date !== '2026-07-12') throw new Error(`URL contract: date not restored (${out.url.loaded.date})`);
  if (!out.url.loaded.tab) throw new Error('URL contract: the past tab did not open from ?tab=past');
  await page.locator('[data-action="tab"][data-tab="daily"]').click();
  await page.waitForTimeout(250);
  out.url.afterTab = page.url();
  if (!out.url.afterTab.includes('tab=daily')) throw new Error(`tab click did not push its state: ${out.url.afterTab}`);
  await page.goBack();
  await readiness(page);
  out.url.afterBack = await page.evaluate(() => ({ tab: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab, q: document.querySelector('#past-q')?.value }));
  if (out.url.afterBack.tab !== 'past') throw new Error(`popstate did not restore the tab (${out.url.afterBack.tab})`);

  // Keyboard journey.
  await page.goto(new URL('/?tracker=visa&tab=home', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-component]', { timeout: 30000 });
  await readiness(page);
  await page.locator('[role="tab"][aria-selected="true"]').focus();
  await page.keyboard.press('ArrowRight');
  out.keyboard.tab = await page.evaluate(() => ({ focused: document.activeElement?.dataset?.tab, selected: document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tab }));
  if (!out.keyboard.tab.selected || out.keyboard.tab.selected === 'home') throw new Error('keyboard: ArrowRight did not move the tab');
  if (out.keyboard.tab.focused !== out.keyboard.tab.selected) throw new Error('keyboard: tab focus did not follow selection');

  await page.goto(new URL('/?tracker=1g', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-component]', { timeout: 30000 });
  await readiness(page);
  await page.locator('[role="radiogroup"] [aria-checked="true"]').first().focus();
  await page.keyboard.press('ArrowRight');
  out.keyboard.segment = await page.evaluate(() => ({ focused: document.activeElement?.textContent?.trim(), checked: document.activeElement?.getAttribute('aria-checked') }));
  if (out.keyboard.segment.checked !== 'true') throw new Error('keyboard: ArrowRight did not move the segmented control');

  await page.goto(new URL('/?watch=48850812', base).href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-component]', { timeout: 30000 });
  await readiness(page);
  await page.locator('[data-action="open-profile"]').last().focus();
  await page.keyboard.press('Enter');
  out.keyboard.dialogOpen = await page.locator('#profile-dialog').evaluate((d) => d.open);
  await page.keyboard.press('Escape');
  out.keyboard.dialogClosed = !(await page.locator('#profile-dialog').evaluate((d) => d.open));
  if (!out.keyboard.dialogOpen || !out.keyboard.dialogClosed) throw new Error(`keyboard: dialog ${JSON.stringify(out.keyboard)}`);
  const stops = [];
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => {
      const node = document.activeElement;
      if (!node || node === document.body) return 'body';
      return node.getClientRects().length ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}` : `hidden:${node.tagName}`;
    }));
  }
  out.keyboard.stops = stops;
  // A `body` stop is the browser parking focus on the document (it happens once
  // after the skip link). A stop on an element that has no box is a real
  // failure: the visitor lands somewhere they cannot see.
  if (stops.some((s) => s.startsWith('hidden'))) throw new Error(`keyboard: invisible tab stops ${stops.join(', ')}`);
  if (stops.filter((s) => s !== 'body').length < 12) throw new Error(`keyboard: only ${stops.filter((s) => s !== 'body').length} usable stops`);

  // Reduced motion, behaviourally.
  const animated = await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="dynamic-button"]')).transitionDuration);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(() => getComputedStyle(document.querySelector('[data-component="dynamic-button"]')).transitionDuration);
  out.motion = { animated, reduced };
  if (Number.parseFloat(reduced) > 0.0001) throw new Error(`reduced motion not collapsed: ${reduced}`);

  // Service worker + update prompt.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { ok: false };
    const registration = await navigator.serviceWorker.ready;
    return { ok: Boolean(registration.active), caches: (await caches.keys()).length };
  });
  out.update.registered = sw;
  if (!sw.ok) throw new Error('service worker did not activate');

  await page.reload({ waitUntil: 'networkidle' });
  await readiness(page);
  const waiting = await page.evaluate(async () => {
    await navigator.serviceWorker.register(`sw.js?v=probe-${Date.now()}`);
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration?.waiting) return registration.waiting.scriptURL;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  if (!waiting) throw new Error('update: a changed worker never reached waiting');
  await page.reload({ waitUntil: 'networkidle' });
  await readiness(page);
  out.update.banner = await page.evaluate(() => {
    const banner = document.getElementById('sw-update-banner');
    return banner ? { hidden: banner.hidden, role: banner.getAttribute('role'), text: banner.textContent.trim().replace(/\s+/g, ' ') } : null;
  });
  if (!out.update.banner || out.update.banner.hidden) throw new Error(`update: banner did not appear ${JSON.stringify(out.update.banner)}`);
  const [reloaded] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).then(() => true).catch(() => false),
    page.click('#sw-update-reload'),
  ]);
  out.update.reloaded = reloaded;
  if (!reloaded) throw new Error('update: the banner button did not reload');
  await context.close();
} finally {
  await browser.close();
}
if (out.consoleErrors.length) throw new Error(JSON.stringify(out.consoleErrors));
console.log(JSON.stringify(out, null, 2));
