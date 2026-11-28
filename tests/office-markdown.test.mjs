/**
 * Office Markdown is built from the current manifest, so an agent reading
 * /new-delhi-visa-decisions.md sees the same report date as the HTML page.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import router from '../functions/_router.js';

function assetsWith(manifest, freshness) {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/data/data_manifest.json') {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (path === '/data/freshness.json') {
        return new Response(JSON.stringify(freshness), { status: 200 });
      }
      return new Response('missing', { status: 404 });
    },
  };
}

const MANIFEST = {
  generated_at: '2026-11-27T12:00:00Z',
  offices: [{
    slug: 'new-delhi',
    name: 'New Delhi',
    report_date: '2026-11-26',
    decisions: 44284,
    approved: 37290,
    refused: 6994,
    status: 'official',
  }],
};

const FRESHNESS = {
  offices: [{
    slug: 'new-delhi',
    search_from: '2026-07-12',
    search_through: '2026-11-27',
    search_scope: 'daily tracker',
    last_success_at: '2026-11-27T12:10:00Z',
  }],
};

test('office Markdown uses the manifest report date and counts', async () => {
  const response = await router.fetch(new Request('https://tracker.test/new-delhi-visa-decisions.md'),
    { ASSETS: assetsWith(MANIFEST, FRESHNESS) });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /\*\*Latest official file:\*\* 26 November 2026/);
  assert.match(body, /\*\*Decisions in that file:\*\* 44,284 \(37,290 approved, 6,994 refused\)/);
  assert.match(body, /Searchable in this tracker:\*\* 12 July 2026 to 27 November 2026 \(daily tracker\)/);
  assert.doesNotMatch(body, /19 November/);
});

test('office Markdown is negotiated from the clean URL too', async () => {
  const response = await router.fetch(new Request('https://tracker.test/new-delhi-visa-decisions', {
    headers: { Accept: 'text/markdown' },
  }), { ASSETS: assetsWith(MANIFEST, FRESHNESS) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /44,284/);
});

test('status Markdown is built from the manifest and freshness files', async () => {
  const response = await router.fetch(new Request('https://tracker.test/status.md'),
    { ASSETS: assetsWith(MANIFEST, FRESHNESS) });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /# Irish visa decision data status/);
  assert.match(body, /New Delhi.*latest official report 26 November 2026/);
  assert.match(body, /44,284 decisions \(37,290 approved, 6,994 refused\)/);
  assert.match(body, /12 July 2026 to 27 November 2026 \(daily tracker\)/);
  assert.match(body, /data\/search_index\.json/);
  assert.match(body, /\[New Delhi\]\(https:\/\/tracker\.test\/new-delhi-visa-decisions\)/);
  assert.match(body, /checked 27 November 2026/);
  assert.match(body, /Manifest generated 27 November 2026/);
});

test('help Markdown answers the common questions without assets', async () => {
  const response = await router.fetch(new Request('https://tracker.test/help.md'),
    { ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /# How to check an Irish visa application/);
  assert.match(body, /A missing number is not a refusal/);
  assert.match(body, /\/office/);
});

test('office Markdown falls back to the static document without assets', async () => {
  const response = await router.fetch(new Request('https://tracker.test/beijing-visa-decisions.md'),
    { ASSETS: { async fetch() { return new Response('missing', { status: 404 }); } } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Beijing visa decisions for China/);
});

test('config publishes a validated Telegram bot username for office deep links', async () => {
  const response = await router.fetch(new Request('https://tracker.test/api/config'),
    { TELEGRAM_BOT_USERNAME: '@IrishVisaTrackerBot', ASSETS: assetsWith(MANIFEST, FRESHNESS) });
  const config = await response.json();
  assert.equal(config.telegram_bot_username, 'IrishVisaTrackerBot');

  const invalid = await router.fetch(new Request('https://tracker.test/api/config'),
    { TELEGRAM_BOT_USERNAME: 'not a username', ASSETS: assetsWith(MANIFEST, FRESHNESS) });
  assert.equal((await invalid.json()).telegram_bot_username, '');
});

test('config resolves the bot handle through getMe when no username is configured', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/getMe$/);
    return new Response(JSON.stringify({ ok: true, result: { username: 'ResolvedVisaBot' } }), { status: 200 });
  };
  try {
    const response = await router.fetch(new Request('https://tracker.test/api/config'),
      { TELEGRAM_BOT_TOKEN: '1:token', ASSETS: assetsWith(MANIFEST, FRESHNESS) });
    assert.equal((await response.json()).telegram_bot_username, 'ResolvedVisaBot');
  } finally {
    globalThis.fetch = original;
  }
});
