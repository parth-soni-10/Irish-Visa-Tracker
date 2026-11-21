/**
 * Chrome interaction tests for the shared header.
 *
 * The only coverage of site-chrome.js was an `openPreferences()` helper used
 * by tracker tests. These assert the behaviour users rely on: one current page
 * per nav, Escape/outside-click closing, focus return, theme persistence, and
 * a mobile sheet that stays on screen (including a landscape phone).
 */

import { test, expect } from '@playwright/test';

test.describe('shared header semantics', () => {
  for (const [route, currentHref] of [
    ['/', '/'],
    ['/about', '/about'],
    ['/privacy', '/privacy'],
    ['/contact', '/contact'],
    ['/corrections', '/corrections'],
  ]) {
    test(`marks exactly one current page on ${route}`, async ({ page }) => {
      await page.goto(route);
      const nav = page.locator('nav.sitebar-nav');
      const current = nav.locator('[aria-current="page"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute('href', currentHref);

      // The disclosure summary is a control, not the page. Marking it current
      // made assistive tech announce two current pages inside one nav.
      const summary = page.locator('details.sitebar-more > summary');
      expect(await summary.getAttribute('aria-current')).toBeNull();
    });
  }
});

test.describe('shared header interaction', () => {
  // These exercise the desktop disclosures. The mobile project has its own
  // menu button and its own sheet test below.
  test.use({ viewport: { width: 1280, height: 800 } });

  test('Escape closes the panel and returns focus to its summary', async ({ page }) => {
    await page.goto('/');
    const more = page.locator('details.sitebar-more');
    const summary = more.locator('summary');
    await summary.click();
    await expect(more).toHaveAttribute('open', '');

    await page.keyboard.press('Escape');
    await expect(more).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
  });

  test('clicking outside closes an open panel', async ({ page }) => {
    await page.goto('/');
    const prefs = page.locator('details.sitebar-prefs');
    await prefs.locator('summary').click();
    await expect(prefs).toHaveAttribute('open', '');

    await page.locator('h1').first().click();
    await expect(prefs).not.toHaveAttribute('open', '');
  });

  test('opening Preferences closes More', async ({ page }) => {
    await page.goto('/');
    const more = page.locator('details.sitebar-more');
    const prefs = page.locator('details.sitebar-prefs');
    await more.locator('summary').click();
    await expect(more).toHaveAttribute('open', '');

    await prefs.locator('summary').click();
    await expect(prefs).toHaveAttribute('open', '');
    await expect(more).not.toHaveAttribute('open', '');
  });

  test('theme choice persists and does not leak onto trust pages', async ({ page }) => {
    await page.goto('/');
    await page.locator('details.sitebar-prefs > summary').click();
    await page.locator('details.sitebar-prefs [data-theme-toggle]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.goto('/about');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.locator('details.sitebar-more > summary').click();
    const panel = page.locator('details.sitebar-more .sitebar-more-panel');
    const animation = await panel.evaluate((element) => getComputedStyle(element).animationName);
    expect(animation).toBe('none');
  });
});

test.describe('mobile sheet on a short viewport', () => {
  test.use({ viewport: { width: 667, height: 375 } });

  test('stays inside a landscape phone and scrolls its overflow', async ({ page }) => {
    await page.goto('/privacy');
    await page.locator('details.sitebar-mobile > summary').click();
    const panel = page.locator('details.sitebar-mobile .sitebar-mobile-panel');
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(376);

    const scrollable = await panel.evaluate((element) => element.scrollHeight > element.clientHeight);
    expect(scrollable).toBe(true);
  });
});
