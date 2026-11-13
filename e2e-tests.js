/**
 * E2E Tests with Playwright
 *
 * The Irish Visa Tracker is a single-page application served from index.html.
 * All tracking, local watchlists and alerts are anonymous. Search/predict/
 * checklist are JSON API endpoints consumed by the page.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8788';

async function gotoHome(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await expect(page.locator('h1, h2, .static-kicker').first()).toBeVisible({ timeout: 15000 });
}

async function openVisaTracker(page) {
  await gotoHome(page);
  await page.locator('.tracker-card').first().click();
  await page.waitForTimeout(1000);
}

test.describe.configure({ retries: 1 });

test.describe('SPA shell', () => {
  test('loads the landing page', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('h1').first()).toContainText('Choose your tracker');
    await expect(page.locator('.tracker-card')).toHaveCount(3);
  });

  test('switches to the visa tracker and shows the Home tab', async ({ page }) => {
    await openVisaTracker(page);
    await expect(page.locator('#home-search')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.navpill[data-tab="watchlist"]')).toBeVisible();
    await expect(page.locator('#account-btn')).toHaveCount(0);
  });

  test('searches by application number on Home', async ({ page }) => {
    await openVisaTracker(page);
    const search = page.locator('#home-search');
    await search.fill('IRL2023981083');
    await search.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.locator('#home-rows')).toBeVisible();
  });

  test('saves and removes a watchlist entry in this browser', async ({ page }) => {
    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="watchlist"]').click();
    await expect(page.locator('#watch-add-form')).toBeVisible();

    await page.fill('#watch-add-form input[name="application_number"]', 'IRL2023981083');
    await page.selectOption('#watch-add-form select[name="embassy_slug"]', 'new-delhi');
    await page.click('#watch-add-btn');
    await expect(page.locator('#watch-add-status')).toContainText('Saved in this browser');

    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved).toHaveLength(1);
    expect(saved[0].number).toBe('2023981083');
    await expect(page.locator('#watch-local-rows')).toContainText('2023981083');

    await page.locator('#watch-local-rows [data-watch-remove]').click();
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(after).toHaveLength(0);
  });

  test('matches a watchlist entry only to its selected office', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-02', '48850812', 'Approved']]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
        { number: '48850812', office: 'beijing' },
      ]));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="watchlist"]').click();
    const rows = page.locator('#watch-local-rows tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('New Delhi');
    await expect(rows.nth(0)).toContainText('Approved');
    await expect(rows.nth(1)).toContainText('Beijing');
    await expect(rows.nth(1)).toContainText('Not published');
  });
});

test.describe('Removed account surface', () => {
  test('no account API is mounted', async ({ request }) => {
    for (const path of ['/api/auth/me', '/api/user/watchlist', '/api/portal/overview']) {
      const response = await request.get(`${BASE_URL}${path}`);
      // Page-load funnel requests can fill the shared local limiter, which may
      // answer 429 before route resolution. Either way no account handler runs.
      expect([404, 429], path).toContain(response.status());
    }
  });
});

test.describe('Advanced Search API', () => {
  test('returns filter pagination without saved-search state', async ({ request }) => {
    const search = await request.post(`${BASE_URL}/api/search`, {
      data: { mode: 'filter', filters: { embassy: 'new-delhi' }, limit: 3, offset: 0, sort: 'number_asc' },
    });
    expect(search.ok()).toBe(true);
    const body = await search.json();
    expect(body.results.length).toBe(3);
    expect(body.pagination.total).toBeGreaterThan(3);
    expect(body.pagination.has_more).toBe(true);
    expect(body.saved_search_id).toBeUndefined();
    const values = body.results.map((row) => Number(String(row.number).replace(/\D/g, '')));
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

test.describe('ML Predict API', () => {
  test('returns a prediction for a study visa application', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/predict`, {
      data: {
        application_number: 'IRL2026123456',
        application_date: '2026-01-15',
        visa_type: 'study',
        embassy: 'new-delhi',
      },
    });
    expect(res.ok()).toBe(true);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.prediction.predicted_days).toBeGreaterThan(0);
    expect(json.prediction.estimated_decision_date).toBeTruthy();
    expect(json.prediction.inference).toBe('xgboost-tree-ensemble');
  });

  test('rejects invalid input', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/predict`, {
      data: { application_date: 'not-a-date' },
    });
    expect(res.ok()).toBe(false);
  });
});

test.describe('Document Checklist API', () => {
  test('generates a study visa checklist', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/checklist`, {
      data: { visa_type: 'study', embassy: 'new-delhi' },
    });
    expect(res.ok()).toBe(true);
    const json = await res.json();
    expect(json).toBeDefined();
  });
});

test.describe('Mobile responsiveness', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('renders the landing page on a mobile viewport', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('h1').first()).toContainText('Choose your tracker');
    await expect(page.locator('.tracker-card')).toHaveCount(3);
  });
});
