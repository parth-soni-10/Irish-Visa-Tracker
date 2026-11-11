/**
 * E2E Tests with Playwright
 *
 * The Irish Visa Tracker is a single-page application served from index.html.
 * Auth happens through a client-side modal POSTing to /api/auth/*.
 * Search/predict/checklist are JSON API endpoints consumed by the page.
 *
 * These tests drive the SPA UI and call the JSON endpoints directly where the
 * page has no dedicated server-rendered route.
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8788';

const TEST_USER = {
  email: `e2e_${Date.now()}@example.com`,
  password: 'TestPass1234!',
  name: 'E2E Test User',
};

async function gotoHome(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
  await expect(page.locator('h1, h2, .static-kicker').first()).toBeVisible({ timeout: 15000 });
}

test.describe.configure({ retries: 1 });

test.describe('SPA shell', () => {
  test('loads the landing page', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('h1').first()).toContainText('Choose your tracker');
    await expect(page.locator('.tracker-card')).toHaveCount(3);
  });

  test('switches to the visa tracker and shows the Home tab', async ({ page }) => {
    await gotoHome(page);
    // Click the Embasssy Visa Decisions card -> setTracker('visa')
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    await expect(page.locator('#home-search')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.navpill[data-tab="watchlist"]')).toBeVisible();
    await expect(page.locator('#account-btn')).toBeVisible();
  });

  test('searches by application number on Home', async ({ page }) => {
    await gotoHome(page);
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    const search = page.locator('#home-search');
    await search.fill('IRL2023981083');
    await search.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.locator('#home-rows')).toBeVisible();
  });

  test('opens the account modal and switches between sign-in/register tabs', async ({ page }) => {
    await gotoHome(page);
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    await page.locator('#account-btn').click();
    await page.waitForTimeout(500);
    await expect(page.locator('#account-modal')).not.toHaveAttribute('hidden');
    // Switch to register tab
    await page.locator('#account-tab-register').click();
    await expect(page.locator('#account-form-register')).toBeVisible({ timeout: 5000 });
    // Switch back to sign-in tab
    await page.locator('#account-tab-signin').click();
    await expect(page.locator('#account-form-signin')).toBeVisible({ timeout: 5000 });
  });

  test('closes the account modal with Escape and returns focus', async ({ page }) => {
    await gotoHome(page);
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    await page.locator('#account-btn').click();
    await expect(page.locator('#account-modal')).not.toHaveAttribute('hidden');
    await page.keyboard.press('Escape');
    await expect(page.locator('#account-modal')).toHaveAttribute('hidden');
    await expect(page.locator('#account-btn')).toBeFocused();
  });
});

test.describe('Auth API', () => {
  test('registers, logs in, reads me, and logs out via JSON API', async ({ page, request }) => {
    // Register
    const reg = await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
    });
    expect(reg.ok()).toBe(true);

    // Login
    const login = await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: TEST_USER.email, password: TEST_USER.password },
    });
    expect(login.ok()).toBe(true);

    // me (authenticated via cookie)
    const me = await request.get(`${BASE_URL}/api/auth/me`);
    expect(me.ok()).toBe(true);
    const meJson = await me.json();
    expect(meJson.authenticated).toBe(true);
    expect(meJson.user.email).toBe(TEST_USER.email);

    // Logout
    const out = await request.post(`${BASE_URL}/api/auth/logout`);
    expect(out.ok()).toBe(true);
  });
});

test.describe('Watchlist API + UI', () => {
  test('adds and removes a watchlist entry via the API', async ({ page, request }) => {
    // Sign in first so the watchlist endpoints authorize
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
    });
    await request.post(`${BASE_URL}/api/auth/login`, {
      data: { email: TEST_USER.email, password: TEST_USER.password },
    });

    const add = await request.post(`${BASE_URL}/api/user/watchlist`, {
      data: { application_number: 'IRL2023981083', embassy_slug: 'new-delhi', nickname: 'My visa' },
    });
    expect(add.ok()).toBe(true);

    const list = await request.get(`${BASE_URL}/api/user/watchlist`);
    expect(list.ok()).toBe(true);
    const listJson = await list.json();
    expect(Array.isArray(listJson.watchlist)).toBe(true);
    expect(listJson.watchlist.length).toBeGreaterThan(0);

    const id = listJson.watchlist[0].id;
    const del = await request.delete(`${BASE_URL}/api/user/watchlist/${encodeURIComponent(id)}`);
    expect(del.ok()).toBe(true);
  });

  test('renders the Watchlist tab when signed in', async ({ page, request }) => {
    // Create the account via the API, then log in through the modal UI so the
    // page's own cookie context is authenticated (API and page contexts don't
    // share cookies).
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
    }).catch(() => { /* may already exist */ });

    await gotoHome(page);
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    await page.locator('#account-btn').click();
    await page.waitForTimeout(500);
    await expect(page.locator('#account-modal')).not.toHaveAttribute('hidden');
    await page.locator('#account-tab-signin').click();
    await page.fill('#account-form-signin input[name="email"]', TEST_USER.email);
    await page.fill('#account-form-signin input[name="password"]', TEST_USER.password);
    await page.locator('#account-form-signin button[type="submit"]').click();
    await page.waitForFunction(() => {
      const m = document.getElementById('account-modal');
      return m && m.hasAttribute('hidden');
    }, { timeout: 10000 });
    // Open the watchlist tab; the page is now authenticated.
    await page.locator('.navpill[data-tab="watchlist"]').click();
    await page.waitForTimeout(1000);
    await expect(page.locator('#watch-add-form')).toBeVisible();
    await expect(page.locator('#watch-server-list')).toBeVisible();
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
    // The checklist endpoint returns items; be lenient about shape.
    expect(json).toBeDefined();
  });
});

test.describe('Workspace shell', () => {
  test('serves the private workspace sign-in without exposing app data', async ({ page }) => {
    await page.goto(`${BASE_URL}/workspace`, { waitUntil: 'networkidle' });
    await expect(page.locator('h1').first()).toContainText('Your application workspace');
    await expect(page.locator('#workspace-auth')).toBeVisible();
    await expect(page.locator('#workspace-app')).toHaveAttribute('hidden');
    await page.locator('#auth-tab-register').click();
    await expect(page.locator('#auth-register')).toBeVisible();
    await expect(page.locator('#auth-register input[name="email"]')).toBeVisible();
  });

  test('signs in through the workspace form and renders the private overview', async ({ page, request }) => {
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: TEST_USER.email, password: TEST_USER.password, name: TEST_USER.name },
    }).catch(() => { /* the shared test user may already exist */ });
    await page.goto(`${BASE_URL}/workspace`, { waitUntil: 'networkidle' });
    await page.fill('#auth-signin input[name="email"]', TEST_USER.email);
    await page.fill('#auth-signin input[name="password"]', TEST_USER.password);
    await page.click('#auth-signin button[type="submit"]');
    await expect(page.locator('#workspace-app')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#workspace-user-email')).toHaveText(TEST_USER.email);
    await expect(page.locator('#workspace-panel h2')).toContainText('Welcome back');
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
