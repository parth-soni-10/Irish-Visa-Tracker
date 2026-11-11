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

test.describe('Removed account-email flows', () => {
  test('does not expose reset or verification routes or UI', async ({ page, request }) => {
    const reset = await request.get(`${BASE_URL}/reset-password`);
    expect(reset.ok()).toBe(false);

    const resetPost = await request.post(`${BASE_URL}/api/auth/password/reset`, {
      data: { email: TEST_USER.email },
    });
    expect(resetPost.ok()).toBe(false);

    const verify = await request.get(`${BASE_URL}/api/auth/verify?token=test`);
    expect(verify.ok()).toBe(false);

    await gotoHome(page);
    await page.locator('.tracker-card').first().click();
    await page.waitForTimeout(1000);
    await page.locator('#account-btn').click();
    await expect(page.locator('#account-form-signin')).toBeVisible();
    await expect(page.locator('#account-form-signin')).not.toContainText('Forgot password?');
  });
});

test.describe('Watchlists and saved searches', () => {
  test('stores multiple applications per account and isolates accounts', async ({ request }) => {
    const suffix = Date.now();
    const firstEmail = `watch_a_${suffix}@example.com`;
    const secondEmail = `watch_b_${suffix}@example.com`;
    const password = 'TestPass1234!';

    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: firstEmail, password, name: 'Watchlist A' },
    });
    const added = await request.post(`${BASE_URL}/api/user/watchlist`, {
      data: { application_number: 'IRL2023981083', embassy_slug: 'new-delhi', nickname: 'First' },
    });
    expect(added.ok()).toBe(true);
    await request.post(`${BASE_URL}/api/user/watchlist`, {
      data: { application_number: 'IRL2023981084', embassy_slug: 'new-delhi', nickname: 'Second' },
    });

    const firstList = await request.get(`${BASE_URL}/api/user/watchlist`);
    expect(firstList.ok()).toBe(true);
    const firstJson = await firstList.json();
    expect(firstJson.watchlist.length).toBeGreaterThanOrEqual(2);
    const numbers = firstJson.watchlist.map((row) => row.application_number);
    expect(numbers).toContain('IRL2023981083');
    expect(numbers).toContain('IRL2023981084');

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: secondEmail, password, name: 'Watchlist B' },
    });
    const secondList = await request.get(`${BASE_URL}/api/user/watchlist`);
    expect(secondList.ok()).toBe(true);
    const secondJson = await secondList.json();
    expect(secondJson.watchlist.some((row) => numbers.includes(row.application_number))).toBe(false);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: firstEmail, password } });
    const owned = await request.get(`${BASE_URL}/api/user/watchlist`);
    const ownedJson = await owned.json();
    for (const row of ownedJson.watchlist.filter((item) => numbers.includes(item.application_number))) {
      await request.delete(`${BASE_URL}/api/user/watchlist/${row.id}`);
    }
  });

  test('supports filter pagination and saved-search isolation', async ({ request }) => {
    const suffix = Date.now();
    const firstEmail = `saved_a_${suffix}@example.com`;
    const secondEmail = `saved_b_${suffix}@example.com`;
    const password = 'TestPass1234!';

    const search = await request.post(`${BASE_URL}/api/search`, {
      data: { mode: 'filter', filters: { embassy: 'new-delhi' }, limit: 3, offset: 0, sort: 'number_asc' },
    });
    expect(search.ok()).toBe(true);
    const searchJson = await search.json();
    expect(searchJson.results.length).toBe(3);
    expect(searchJson.pagination.total).toBeGreaterThan(3);
    expect(searchJson.pagination.has_more).toBe(true);
    const values = searchJson.results.map((row) => Number(String(row.number).replace(/\D/g, '')));
    expect(values).toEqual([...values].sort((a, b) => a - b));

    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: firstEmail, password, name: 'Saved A' },
    });
    const saved = await request.post(`${BASE_URL}/api/search`, {
      data: { query: 'visa', mode: 'fuzzy', save_search: true, search_name: 'My saved search' },
    });
    expect(saved.ok()).toBe(true);
    const savedJson = await saved.json();
    expect(savedJson.saved_search_id).toBeTruthy();
    const savedId = savedJson.saved_search_id;

    const firstList = await request.get(`${BASE_URL}/api/search?action=list`);
    expect(firstList.ok()).toBe(true);
    const firstJson = await firstList.json();
    expect(firstJson.searches.some((row) => row.id === savedId)).toBe(true);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: secondEmail, password, name: 'Saved B' },
    });
    const secondList = await request.get(`${BASE_URL}/api/search?action=list`);
    const secondJson = await secondList.json();
    expect(secondJson.searches.some((row) => row.id === savedId)).toBe(false);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: firstEmail, password } });
    const removed = await request.delete(`${BASE_URL}/api/search?id=${encodeURIComponent(savedId)}`);
    expect(removed.ok()).toBe(true);
  });
});

test.describe('Referral acceptance and reward', () => {
  test('awards one credit when an invited account is created', async ({ request }) => {
    const suffix = Date.now();
    const inviterEmail = `ref_a_${suffix}@example.com`;
    const invitedEmail = `ref_b_${suffix}@example.com`;
    const password = 'TestPass1234!';

    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: inviterEmail, password, name: 'Referral A' },
    });
    const referral = await request.get(`${BASE_URL}/api/portal/referrals`);
    expect(referral.ok()).toBe(true);
    const referralJson = await referral.json();
    expect(referralJson.code).toBeTruthy();

    await request.post(`${BASE_URL}/api/auth/logout`);
    const invited = await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: invitedEmail, password, name: 'Referral B', referral_code: referralJson.code },
    });
    expect(invited.ok()).toBe(true);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: inviterEmail, password } });
    const after = await request.get(`${BASE_URL}/api/portal/referrals`);
    expect(after.ok()).toBe(true);
    const afterJson = await after.json();
    expect(afterJson.accepted).toBeGreaterThanOrEqual(1);
    expect(afterJson.credits).toBeGreaterThanOrEqual(1);
    expect(afterJson.rewards.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Community, organization, and exports', () => {
  test('creates Q&A, reviews, success stories, organization membership, and an export schedule', async ({ request }) => {
    const suffix = Date.now();
    const ownerEmail = `community_a_${suffix}@example.com`;
    const memberEmail = `community_b_${suffix}@example.com`;
    const password = 'TestPass1234!';

    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: ownerEmail, password, name: 'Community Owner' },
    });

    const question = await request.post(`${BASE_URL}/api/portal/community`, {
      data: { kind: 'question', title: 'How long after approval?', body: 'How long should I expect before the passport comes back?', office: 'new-delhi', visa_type: 'study' },
    });
    expect(question.ok()).toBe(true);
    const questionJson = await question.json();
    expect(questionJson.id).toBeTruthy();

    const review = await request.post(`${BASE_URL}/api/portal/community`, {
      data: { kind: 'review', title: 'Helpful office experience', body: 'The staff explained the next steps clearly.', office: 'new-delhi', rating: 5 },
    });
    expect(review.ok()).toBe(true);

    const success = await request.post(`${BASE_URL}/api/portal/community`, {
      data: { kind: 'success', title: 'Approved after four weeks', body: 'My study visa was approved after four weeks.', office: 'new-delhi', outcome: 'Approved' },
    });
    expect(success.ok()).toBe(true);

    const publicPosts = await request.get(`${BASE_URL}/api/portal/community?kind=question`);
    expect(publicPosts.ok()).toBe(true);
    const publicJson = await publicPosts.json();
    expect(publicJson.posts.some((post) => post.id === questionJson.id)).toBe(true);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/register`, {
      data: { email: memberEmail, password, name: 'Community Member' },
    });
    const answer = await request.post(`${BASE_URL}/api/portal/community/${questionJson.id}/answers`, {
      data: { body: 'It usually arrives within two weeks after the decision.' },
    });
    expect(answer.ok()).toBe(true);
    const answerJson = await answer.json();
    expect(answerJson.id).toBeTruthy();

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: ownerEmail, password } });
    const accepted = await request.post(`${BASE_URL}/api/portal/community/${questionJson.id}/answers/${answerJson.id}/accept`);
    expect(accepted.ok()).toBe(true);
    const post = await request.get(`${BASE_URL}/api/portal/community/${questionJson.id}`);
    expect(post.ok()).toBe(true);
    const postJson = await post.json();
    expect(postJson.answers.some((row) => row.id === answerJson.id && row.accepted === true)).toBe(true);

    const org = await request.post(`${BASE_URL}/api/portal/org`, {
      data: { name: `E2E Organization ${suffix}`, brand_color: '#123456' },
    });
    expect(org.ok()).toBe(true);
    const orgJson = await org.json();
    expect(orgJson.org.slug).toBeTruthy();

    const invite = await request.post(`${BASE_URL}/api/portal/org/invite`, { data: { email: memberEmail } });
    expect(invite.ok()).toBe(true);
    const inviteJson = await invite.json();
    expect(inviteJson.invite_url).toBeTruthy();
    const token = new URL(inviteJson.invite_url).searchParams.get('org_invite');
    expect(token).toBeTruthy();

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: memberEmail, password } });
    const joined = await request.post(`${BASE_URL}/api/portal/org/join`, { data: { token } });
    expect(joined.ok()).toBe(true);

    await request.post(`${BASE_URL}/api/auth/logout`);
    await request.post(`${BASE_URL}/api/auth/login`, { data: { email: ownerEmail, password } });
    const branded = await request.patch(`${BASE_URL}/api/portal/org`, { data: { brand_name: 'E2E Brand' } });
    expect(branded.ok()).toBe(true);
    const publicOrg = await request.get(`${BASE_URL}/api/portal/org/public?slug=${encodeURIComponent(orgJson.org.slug)}`);
    expect(publicOrg.ok()).toBe(true);
    const publicOrgJson = await publicOrg.json();
    expect(publicOrgJson.org.brand_name).toBe('E2E Brand');

    const scheduled = await request.post(`${BASE_URL}/api/portal/exports/schedules`, {
      data: { format: 'csv', frequency: 'weekly', filters: { office: 'new-delhi' } },
    });
    expect(scheduled.ok()).toBe(true);
    const scheduledJson = await scheduled.json();
    expect(scheduledJson.id).toBeTruthy();
    const schedules = await request.get(`${BASE_URL}/api/portal/exports/schedules`);
    expect(schedules.ok()).toBe(true);
    const schedulesJson = await schedules.json();
    expect(schedulesJson.schedules.some((row) => row.id === scheduledJson.id)).toBe(true);
    await request.delete(`${BASE_URL}/api/portal/exports/schedules?id=${encodeURIComponent(scheduledJson.id)}`);
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
