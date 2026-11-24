import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import router from '../functions/_router.js';

const ROOT = new URL('../', import.meta.url);

async function read(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}

function assetsEnv() {
  return {
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/' || path === '/index.html') {
          return new Response('<!doctype html><h1>Tracker</h1>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        if (path === '/scripts/app.js') {
          return new Response('console.log("app")', {
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
          });
        }
        if (path === '/data/test.json') {
          return new Response('{"ok":true}', {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response('missing', { status: 404 });
      }
    }
  };
}

const env = assetsEnv();
const ctx = { waitUntil() {}, passThroughOnException() {} };

test('HTML revalidates, versioned assets are immutable and data is never cached', async () => {
  const document = await router.fetch(new Request('https://tracker.test/'), env, ctx);
  assert.equal(document.status, 200);
  assert.match(document.headers.get('Cache-Control'), /no-cache/);
  assert.doesNotMatch(document.headers.get('Cache-Control'), /no-store/);
  assert.match(document.headers.get('Pragma'), /no-cache/);
  assert.equal(document.headers.get('Expires'), '0');

  const asset = await router.fetch(new Request('https://tracker.test/scripts/app.js'), env, ctx);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

  const data = await router.fetch(new Request('https://tracker.test/data/test.json'), env, ctx);
  assert.equal(data.status, 200);
  assert.match(data.headers.get('Cache-Control'), /no-store/);
  assert.match(data.headers.get('Pragma'), /no-cache/);
  assert.equal(data.headers.get('Expires'), '0');
});

test('static headers revalidate HTML and cache versioned asset paths', async () => {
  const headers = await read('_headers');
  const html = headers.match(/\/\*\.html[\s\S]*?(?=\n\/|$)/);
  assert.ok(html, 'HTML _headers block is missing');
  assert.match(html[0], /Cache-Control: no-cache, must-revalidate/);
  assert.match(html[0], /Pragma: no-cache/);
  assert.match(html[0], /Expires: 0/);
  assert.match(headers, /\/styles\/\*[\s\S]*?Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\/pages\.css[\s\S]*?Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\/data\/\*[\s\S]*?Cache-Control: no-store/);
  // A broad cache rule would be merged with the asset rule by Cloudflare.
  const global = headers.match(/^\/\*\r?\n([\s\S]*?)(?=\r?\n\r?\n)/m);
  assert.ok(global, 'global security block is missing');
  assert.doesNotMatch(global[1], /Cache-Control/);
});


test('the old pages.dev host redirects to the configured custom origin', async () => {
  const redirectEnv = { ...env, PAGES_DEV_REDIRECT_ORIGIN: 'https://tracker.example' };
  const oldHost = await router.fetch(
    new Request('https://irishvisaupdatetracker.pages.dev/about?ref=old'),
    redirectEnv,
    ctx,
  );
  assert.equal(oldHost.status, 301);
  assert.equal(oldHost.headers.get('Location'), 'https://tracker.example/about?ref=old');

  const customHost = await router.fetch(
    new Request('https://tracker.example/'),
    redirectEnv,
    ctx,
  );
  assert.equal(customHost.status, 200);
});

test('the service worker has no fetch cache and clears old caches', async () => {
  const worker = await read('sw.js');
  assert.doesNotMatch(worker, /caches\.open/);
  assert.doesNotMatch(worker, /event\.respondWith/);
  assert.doesNotMatch(worker, /addEventListener\(['"]fetch['"]/);
  assert.match(worker, /caches\.keys\(\)/);
  assert.match(worker, /caches\.delete/);
});

test('registration forces an update check and reloads after a worker change', async () => {
  const registration = await read('scripts/index-sw.js');
  assert.match(registration, /updateViaCache:\s*'none'/);
  assert.match(registration, /registration\.update\(\)/);
  assert.match(registration, /controllerchange/);
});

test('API responses that can carry deploy data are no-store', async () => {
  for (const name of ['functions/api/search.js', 'functions/reports.js', 'functions/vfs-appointments.js']) {
    const source = await read(name);
    assert.doesNotMatch(source, /public,\s*max-age/, name);
  }
});
