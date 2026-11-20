/**
 * E2E Tests with Playwright
 *
 * The Irish Visa Tracker is a single-page application served from index.html.
 * All tracking, local watchlists and alerts are anonymous. Search/predict/
 * checklist are JSON API endpoints consumed by the page.
 */

import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

async function openPreferences(page) {
  const prefs = page.locator('details.sitebar-prefs');
  if (!(await prefs.evaluate((el) => el.open))) {
    await prefs.locator('summary').click();
  }
}

async function seriousA11yViolations(page, selector) {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target),
    }));
}

test.describe.configure({ retries: 1 });

// Service-worker fetches bypass page.route(). The suite tests the application
// paths rather than the SW cache itself, so block it to keep data mocks exact.
test.use({ serviceWorkers: 'block' });

test.describe('SPA shell', () => {
  test('loads the landing page', async ({ page }) => {
    await gotoHome(page);
    await expect(page.locator('h1').first()).toContainText('Check your Irish visa decision');
    await expect(page.locator('.tracker-card')).toHaveCount(3);
  });

  test('switches to the visa tracker and shows the Search tab', async ({ page }) => {
    await openVisaTracker(page);
    await expect(page.locator('#home-search')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.navpill[data-tab="saved"]')).toBeVisible();
    await expect(page.locator('#account-btn')).toHaveCount(0);
  });

  test('searches by application number on Search', async ({ page }) => {
    await openVisaTracker(page);
    const search = page.locator('#home-search');
    await search.fill('IRL2023981083');
    await search.press('Enter');
    await page.waitForTimeout(1000);
    await expect(page.locator('#home-rows')).toBeVisible();
  });

  test('saves and removes a watchlist entry in this browser', async ({ page }) => {
    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
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

  test('matches and removes only the selected office entry', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-02', '48850812', 'Approved']]),
    }));
    await page.route('**/data/embassy-beijing.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ decisions: [] }),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
        { number: '48850812', office: 'beijing' },
      ]));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const delhi = page.locator('#watch-local-rows tr[data-office="new-delhi"][data-watch-number="48850812"]');
    const beijing = page.locator('#watch-local-rows tr[data-office="beijing"][data-watch-number="48850812"]');
    await expect(delhi).toHaveCount(1);
    await expect(delhi).toContainText('Approved');
    await expect(beijing).toHaveCount(1);
    await expect(beijing).toContainText('No decision found');

    await beijing.locator('[data-watch-remove]').click();
    await expect(beijing).toHaveCount(0);
    await expect(delhi).toContainText('Approved');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved).toHaveLength(1);
    expect(saved[0].office).toBe('new-delhi');
  });

  test('shows decision changes since the previous visit', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-03', '48850812', 'Approved']]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
      ]));
      localStorage.setItem('visa-watchlist-seen', JSON.stringify({
        'new-delhi|48850812': {
          signature: 'new-delhi|Refused|2026-01-02',
          decision: 'Refused',
          date: '2026-01-02',
          seen_at: '2026-01-02T10:00:00.000Z',
        },
      }));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const row = page.locator('#watch-local-rows tr[data-office="new-delhi"][data-watch-number="48850812"]');
    await expect(row).toContainText('Approved');
    await expect(row.locator('.watch-change-badge')).toHaveText('New since your last visit');
    await expect(row.locator('.watch-change-detail')).toContainText('Previously Refused');
    await expect(page.locator('#watch-change-summary')).toContainText('1 saved application changed since your last visit');

    const baseline = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist-seen') || '{}'));
    expect(baseline['new-delhi|48850812'].decision).toBe('Approved');
    expect(baseline['new-delhi|48850812'].signature).toBe('new-delhi|Approved|2026-01-03');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.navpill[data-tab="saved"]').click();
    await expect(page.locator('#watch-local-rows tr[data-office="new-delhi"][data-watch-number="48850812"]')).toContainText('Approved');
    await expect(page.locator('#watch-local-rows .watch-change-badge')).toHaveCount(0);
    await expect(page.locator('#watch-change-summary')).toContainText('No changes since your last visit');
  });

  test('loads the latest decision from a watched office archive', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    }));
    await page.route('**/data/embassy-beijing.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        decisions: [{ date: '2026-01-03', number: '44078322', decision: 'Refused' }],
      }),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '44078322', office: 'beijing' },
      ]));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const beijing = page.locator('#watch-local-rows tr[data-office="beijing"][data-watch-number="44078322"]');
    await expect(beijing).toContainText('Refused');
    await expect(beijing).toContainText('3 Jan 2026');
  });

  test('shows when an office archive cannot be loaded', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    }));
    await page.route('**/data/embassy-beijing.json', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unavailable' }),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '44078322', office: 'beijing' },
      ]));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const beijing = page.locator('#watch-local-rows tr[data-office="beijing"]');
    await expect(beijing).toContainText('Office data unavailable');
  });

  test('migrates a legacy string watchlist entry to New Delhi', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-02', '48850812', 'Approved']]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify(['48850812']));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const delhi = page.locator('#watch-local-rows tr[data-office="new-delhi"][data-watch-number="48850812"]');
    await expect(delhi).toContainText('Approved');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved[0].office).toBe('new-delhi');
  });

  test('reports a watchlist storage failure instead of claiming success', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'visa-watchlist') throw new Error('storage blocked');
        return original.call(this, key, value);
      };
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    await page.fill('#watch-add-form input[name="application_number"]', '48850812');
    await page.selectOption('#watch-add-form select[name="embassy_slug"]', 'new-delhi');
    await page.click('#watch-add-btn');
    await expect(page.locator('#watch-add-status')).toContainText('Could not save this watchlist');
  });

  test('syncs watchlist changes across tabs', async ({ context }) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    await openVisaTracker(pageA);
    await openVisaTracker(pageB);
    await pageB.locator('.navpill[data-tab="saved"]').click();
    await expect(pageB.locator('#watch-local-status')).toContainText('No saved applications');

    await pageA.evaluate(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
      ]));
    });
    await expect(pageB.locator('#watch-local-rows')).toContainText('48850812');
    await pageA.close();
    await pageB.close();
  });

  test('exports and restores a watchlist backup', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
        { number: '44078322', office: 'beijing' },
      ]));
    });
    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();

    const downloadPromise = page.waitForEvent('download');
    await page.click('#watch-export-btn');
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^irish-visa-watchlist-/);
    const path = await download.path();
    expect(path).toBeTruthy();
    const payload = JSON.parse(await fs.readFile(String(path), 'utf8'));
    expect(payload.watchlist).toHaveLength(2);

    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('#watch-import-input').setInputFiles({
      name: 'watchlist.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ watchlist: [
        { number: '11112222', office: 'new-delhi', nickname: 'Restored' },
      ] })),
    });
    await expect(page.locator('#watch-backup-status')).toContainText('Imported 1 application');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved).toHaveLength(1);
    expect(saved[0].number).toBe('11112222');
  });

  test('does not show a heads-up for a different office', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-02', '48850812', 'Approved']]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'beijing' },
      ]));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    await expect(page.locator('#watch-local-rows')).toContainText('Beijing');
    await expect(page.locator('#watch-local-rows .pub-live')).toHaveCount(0);
  });

  test('explains the limit when adding from Saved', async ({ page }) => {
    await page.addInitScript(() => {
      const items = Array.from({ length: 10 }, (_, index) => ({
        number: String(10000000 + index),
        office: 'new-delhi',
      }));
      localStorage.setItem('visa-watchlist', JSON.stringify(items));
    });
    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    await page.fill('#watch-add-form input[name="application_number"]', '99999999');
    await page.selectOption('#watch-add-form select[name="embassy_slug"]', 'new-delhi');
    await page.click('#watch-add-btn');
    await expect(page.locator('#watch-add-status')).toContainText('up to 10 applications');
  });
});

test.describe('Time zone toggle', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('switches every freshness clock between UTC and local time', async ({ page }) => {
    await page.route('**/data/visa_meta.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        lastRunAt: '2026-11-17T16:50:57',
        sheetRows: 2,
        newRows: 1,
        fileDate: '2026-11-17',
        fileRows: 2,
        ok: true,
        closureDates: [],
      }),
    }));
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        ['2026-11-17', '12345678', 'Approved'],
        ['2026-11-16', '87654321', 'Refused'],
      ]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-last-visit', String(Date.UTC(2026, 10, 16, 22, 15)));
    });

    await gotoHome(page);
    await openPreferences(page);
    const toggle = page.locator('[data-time-mode-toggle]');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('data-mode', 'utc');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#stat-updated')).toContainText('17 Nov 2026, 11:20 UTC');
    const zonedTimestamp = await page.evaluate(() =>
      window.IVTimeMode.newDelhiNode('2026-11-17T12:17:53.093Z', 'short')
    );
    expect(zonedTimestamp).toContain('12:17 UTC');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'local');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#stat-updated')).toContainText('03:20');
    await expect(page.locator('#stat-updated')).not.toContainText('UTC');

    await page.goto(`${BASE_URL}/?tracker=visa&tab=search`, { waitUntil: 'networkidle' });
    await expect(page.locator('#home-search')).toBeVisible({ timeout: 15000 });
    await openPreferences(page);
    await expect(toggle).toHaveAttribute('data-mode', 'local');
    await expect(page.locator('#meta-box')).toContainText('03:20');
    await expect(page.locator('#meta-box')).not.toContainText('UTC');
    await expect(page.locator('.home-freshness-details')).toContainText('21:30');

    await toggle.click();
    await expect(toggle).toHaveAttribute('data-mode', 'utc');
    await expect(page.locator('#meta-box')).toContainText('11:20 UTC');
    await expect(page.locator('.home-freshness-details')).toContainText('05:30 UTC');
  });
});

test.describe('Status page clocks', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('switches the last ingest time between UTC and local time', async ({ page }) => {
    await page.route('**/data/data_manifest.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        offices: [{
          slug: 'new-delhi',
          name: 'New Delhi',
          status: 'official',
          report_date: '2026-11-17',
          as_of: '2026-11-17',
          fetched_at: '2026-11-17T16:50:57Z',
          decisions: 2,
          archive_decisions: 2,
          archive_reports: [],
        }],
      }),
    }));

    await page.goto(`${BASE_URL}/status`, { waitUntil: 'networkidle' });
    await expect(page.locator('#status-summary')).toContainText('17 Nov 2026, 16:50 UTC');
    await openPreferences(page);

    const toggle = page.locator('[data-time-mode-toggle]');
    await toggle.click();
    await expect(page.locator('#status-summary')).toContainText('17 Nov 2026, 08:50');
    await expect(page.locator('#status-summary')).not.toContainText('UTC');
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
    expect(json.prediction.inference).toBe('transparent-baseline');
    expect(json.prediction.confidence_interval).toBeNull();
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
    await expect(page.locator('h1').first()).toContainText('Check your Irish visa decision');
    await expect(page.locator('.tracker-card')).toHaveCount(3);
  });

  test('keeps a changed saved row readable instead of collapsing the metadata column', async ({ page }) => {
    await page.route('**/data/visa_decisions.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([['2026-01-03', '48850812', 'Approved']]),
    }));
    await page.addInitScript(() => {
      localStorage.setItem('visa-watchlist', JSON.stringify([
        { number: '48850812', office: 'new-delhi' },
      ]));
      localStorage.setItem('visa-watchlist-seen', JSON.stringify({
        'new-delhi|48850812': {
          signature: 'new-delhi|Refused|2026-01-02',
          decision: 'Refused',
          date: '2026-01-02',
          seen_at: '2026-01-02T10:00:00.000Z',
        },
      }));
    });

    await openVisaTracker(page);
    await page.locator('.navpill[data-tab="saved"]').click();
    const row = page.locator('#watch-local-rows tr[data-office="new-delhi"][data-watch-number="48850812"]');
    await expect(row.locator('.watch-change-badge')).toHaveText('New since your last visit');

    const layout = await row.evaluate((element) => {
      const cells = [...element.children].map((cell) => cell.getBoundingClientRect());
      return {
        widths: cells.map((cell) => cell.width),
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    // Every metadata column must remain wide enough for a date or a nickname;
    // the change badge must not squeeze the first column to one glyph per line.
    expect(Math.min(...layout.widths.slice(0, 5))).toBeGreaterThan(70);
    expect(layout.overflow).toBeLessThanOrEqual(2);
  });
});

test.describe('Six-tab deep links', () => {
  const tabs = [
    { tab: 'search', ready: '#home-search' },
    { tab: 'history', ready: '[data-history-view="daily"]' },
    { tab: 'alerts', ready: '#alert-form' },
    { tab: 'saved', ready: '#watch-add-form' },
    { tab: 'tools', ready: '#checklist-form' },
    { tab: 'analytics', ready: '#chart-monthly' },
  ];

  test('loads each tab from its own URL', async ({ page }) => {
    for (const item of tabs) {
      await page.goto(`${BASE_URL}/?tracker=visa&tab=${item.tab}`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('.navpill')).toHaveCount(6);
      const active = page.locator(`.navpill[data-tab="${item.tab}"]`);
      await expect(active).toHaveClass(/active/);
      await expect(active).toHaveAttribute('aria-current', 'page');
      await expect(page.locator(item.ready)).toBeVisible({ timeout: 15000 });
    }
  });

  test('keeps keyboard tab switches current and all six tabs inside the mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`${BASE_URL}/?tracker=visa&tab=search`, { waitUntil: 'domcontentloaded' });
    const tabs = ['search', 'history', 'alerts', 'saved', 'tools', 'analytics'];
    for (const tab of tabs) {
      const button = page.locator(`.navpill[data-tab="${tab}"]`);
      await button.scrollIntoViewIfNeeded();
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(button).toHaveClass(/active/);
      await expect(button).toHaveAttribute('aria-current', 'page');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `horizontal overflow on ${tab}`).toBeLessThanOrEqual(2);
    }
  });
});

test.describe('All-office search result cards', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('shows a Beijing match and its watch, share and alert actions', async ({ page }) => {
    let searchRequest = null;
    await page.addInitScript(() => {
      window.__copiedResultUrl = '';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: function(text) {
            window.__copiedResultUrl = String(text);
            return Promise.resolve();
          },
        },
      });
    });
    await page.route('**/data/data_manifest.json', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        offices: [{
          slug: 'beijing',
          name: 'Beijing',
          source_url: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
          source_file: 'https://www.ireland.ie/5288/20261101_BVO_visa_decisions.ods',
          source_name: 'Embassy of Ireland, Beijing',
          report_date: '2026-11-01',
          as_of: '2026-11-17',
          fetched_at: '2026-11-17T09:31:40.841Z',
          status: 'partial',
          note: 'Test manifest note',
        }],
      }),
    }));
    await page.route('**/api/search', async (route) => {
      searchRequest = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          results: [{
            date: '2026-11-01',
            number: '44078322',
            decision: 'Refused',
            embassy: 'beijing',
            date_basis: 'report_period_end',
            report_date: '2026-11-01',
            source: 'official',
          }],
          pagination: { total: 1, limit: 100, offset: 0, has_more: false },
          query: '44078322',
          mode: 'fuzzy',
          filters: {},
          sort: 'date_desc',
        }),
      });
    });

    await page.goto(`${BASE_URL}/?tracker=visa&tab=search`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#home-search')).toBeVisible();
    await expect(page.locator('#home-office')).toHaveValue('all');
    await page.locator('#home-search').fill('44078322');
    await page.locator('#home-search').press('Enter');

    const card = page.locator('.lookup-result-card').first();
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toHaveAttribute('data-office', 'beijing');
    await expect(card).toContainText('Beijing');
    await expect(card).toContainText('Latest published snapshot');
    await expect(card).toContainText('Decision date');
    await expect(card).toContainText('Report date');
    await expect(card).toContainText('Last checked');
    const checked = card.locator('.lookup-result-fact').filter({ hasText: 'Last checked' });
    await expect(checked).toContainText('09:31 UTC');
    await openPreferences(page);
    await page.locator('[data-time-mode-toggle]').click();
    await expect(checked).toContainText('01:31');
    await expect(checked).not.toContainText('UTC');
    await page.locator('[data-time-mode-toggle]').click();
    await expect(checked).toContainText('09:31 UTC');
    await expect(card).toContainText('Official source');
    await expect(card.locator('.lookup-result-source a[href="https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/"]')).toBeVisible();
    await expect(card.locator('[data-lookup-source-file]')).toHaveAttribute(
      'href',
      'https://www.ireland.ie/5288/20261101_BVO_visa_decisions.ods'
    );
    await expect(card).toContainText('Report freshness');
    await expect(card).toContainText('marks its latest data as "partial"');
    await expect(card).toContainText('Test manifest note');
    await expect(card).toContainText('What to do next');
    await expect(card).toContainText('not legal advice');
    expect(await seriousA11yViolations(page, '.lookup-result-card')).toEqual([]);

    expect(searchRequest).toBeTruthy();
    expect(searchRequest.filters).toEqual({});
    expect(searchRequest.query).toBe('44078322');

    const watch = card.locator('[data-lookup-watch]');
    await watch.click();
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    await expect(watch).toContainText('Watching');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: '44078322', office: 'beijing' }),
    ]));

    await expect(card.locator('.lookup-result-privacy')).toContainText('contains application number 44078322');
    await expect(card.locator('[data-lookup-share]')).toHaveAttribute('aria-describedby', /lookup-share-privacy-44078322-beijing/);
    await card.locator('[data-lookup-share]').click();
    await expect(card.locator('[data-lookup-action-status]')).toContainText('Link copied. It contains the application number');
    const copied = await page.evaluate(() => window.__copiedResultUrl);
    const copiedUrl = new URL(copied);
    expect(copiedUrl.searchParams.get('q')).toBe('44078322');
    expect(copiedUrl.searchParams.get('office')).toBe('beijing');
    expect(copiedUrl.searchParams.get('tab')).toBe('search');

    await card.locator('[data-lookup-alert]').click();
    await expect(page.locator('.navpill[data-tab="alerts"]')).toHaveClass(/active/);
    await expect(page.locator('#alert-form input[name="application_number"]')).toHaveValue('44078322');
    await expect(page.locator('#alert-form select[name="embassy"]')).toHaveValue('beijing');
  });

  test('falls back to the local index when the live search API fails', async ({ browser }) => {
    // The production service worker is intentionally network-first for /data/.
    // Block it here so Playwright can route the fallback index deterministically.
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    try {
      await page.route('**/api/search', (route) => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Search is temporarily unavailable' }),
      }));
      await page.route('**/data/search_fallback.json', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          generated_at: '2026-11-17T09:31:55.082Z',
          offices: {
            beijing: {
              source_url: 'https://www.ireland.ie/en/china/beijing/services/visas/visa-decisions/',
              source_file: 'https://www.ireland.ie/5288/20261101_BVO_visa_decisions.ods',
              source_name: 'Embassy of Ireland, Beijing',
              report_date: '2026-11-01',
              status: 'official',
            },
          },
          rows: [['beijing', '44078322', '2026-11-01', 'Refused']],
        }),
      }));

      await page.goto(`${BASE_URL}/?tracker=visa&tab=search`, { waitUntil: 'domcontentloaded' });
      await page.locator('#home-search').fill('44078322');
      await page.locator('#home-search').press('Enter');
      await expect(page.locator('.home-lookup-fallback')).toContainText('Live search is unavailable');
      const card = page.locator('.lookup-result-card').first();
      await expect(card).toBeVisible({ timeout: 15000 });
      await expect(card).toHaveAttribute('data-office', 'beijing');
      await expect(card).toContainText('Refused');
      await expect(card).toContainText('Report containing this row');
    } finally {
      await context.close();
    }
  });

  test('turns a no-result search into a watch or alert', async ({ page }) => {
    await page.route('**/api/search', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        results: [],
        pagination: { total: 0, limit: 100, offset: 0, has_more: false },
        query: '99999999',
        mode: 'fuzzy',
        filters: {},
        sort: 'date_desc',
      }),
    }));

    await page.goto(`${BASE_URL}/?tracker=visa&tab=search`, { waitUntil: 'domcontentloaded' });
    await page.locator('#home-search').fill('99999999');
    await page.locator('#home-search').press('Enter');
    await expect(page.locator('.home-lookup-empty h3')).toContainText('No published decision found');
    expect(await seriousA11yViolations(page, '.home-lookup-empty')).toEqual([]);

    const watch = page.locator('[data-home-noresult-watch]');
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await page.selectOption('[data-home-noresult-office]', 'beijing');
    await watch.click();
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    await expect(watch).toContainText('Watching');
    await expect(page.locator('[data-home-noresult-status]')).toContainText('Saved');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('visa-watchlist') || '[]'));
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ number: '99999999', office: 'beijing' }),
    ]));

    await page.locator('[data-home-noresult-alert]').click();
    await expect(page.locator('.navpill[data-tab="alerts"]')).toHaveClass(/active/);
    await expect(page.locator('#alert-form input[name="application_number"]')).toHaveValue('99999999');
    await expect(page.locator('#alert-form select[name="embassy"]')).toHaveValue('beijing');
  });
});

test.describe('History and Help routes', () => {
  test('shows more daily rows without leaving History', async ({ page }) => {
    await page.goto(`${BASE_URL}/?tracker=visa&tab=history`, { waitUntil: 'domcontentloaded' });
    const rows = page.locator('.daily-table tbody tr:not(.dd-row)');
    await expect(page.locator('.daily-table')).toBeVisible({ timeout: 15000 });
    await expect(rows).toHaveCount(21);
    const more = page.locator('[data-daily-show-more]');
    await expect(more).toBeVisible();
    await more.click();
    await expect(rows).toHaveCount(42);
    await expect(page.locator('.navpill[data-tab="history"]')).toHaveClass(/active/);
  });

  test('serves the Help and FAQ route', async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/help`, { waitUntil: 'domcontentloaded' });
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle(/Help & FAQ/);
    await expect(page.locator('h1')).toContainText('Using the Irish Visa Decision Tracker');
    await expect(page.locator('#find-number')).toBeVisible();
    await expect(page.locator('#checklist')).toBeVisible();
  });

  test('shows work-only checklist fields only for a work visa', async ({ page }) => {
    await page.goto(`${BASE_URL}/?tracker=visa&tab=tools`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#checklist-form')).toBeVisible({ timeout: 15000 });
    const workFields = page.locator('[data-checklist-for="work"]');
    await expect(workFields).toHaveCount(2);
    await expect(workFields.nth(0)).toBeHidden();
    await expect(workFields.nth(1)).toBeHidden();

    await page.selectOption('#cl-visa-type', 'work');
    await expect(workFields.nth(0)).toBeVisible();
    await expect(workFields.nth(1)).toBeVisible();
    await expect(page.locator('label[for="cl-permit-type"]')).toContainText('Work permit type');
    await expect(page.locator('label[for="cl-regulated"]')).toContainText('Regulated profession?');

    await page.selectOption('#cl-visa-type', 'study');
    await expect(workFields.nth(0)).toBeHidden();
    await expect(workFields.nth(1)).toBeHidden();
  });
});
