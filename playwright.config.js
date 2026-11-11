/**
 * Playwright Configuration for E2E Tests
 */

import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:8788';
const port = new URL(baseURL).port || '8788';

export default defineConfig({
  testDir: '.',
  testMatch: 'e2e-tests.js',
  
  // Run tests in parallel
  fullyParallel: true,
  
  // Fail the build on CI if you accidentally left test.only in the source code
  forbidOnly: !!process.env.CI,
  
  // Retry on CI only
  retries: process.env.CI ? 2 : 1,
  
  // Opt out of parallel tests on CI
  workers: process.env.CI ? 1 : 2,
  
  // Reporter
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    ['json', { outputFile: 'test-results.json' }]
  ],
  
  // Shared settings
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },
  
  // Projects for different browsers
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    
    // Mobile viewports
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    },
  ],
  
  // Global setup - start dev server
  webServer: {
    command: `npx wrangler pages dev . --port ${port}`,
    url: baseURL + '/',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  
  // Global timeout
  timeout: 60000,
  expect: {
    timeout: 10000,
  }
});