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
        if (path === '/' || path === '/index.html' || path === '/about') {
          return new Response('<!doctype html><h1>Tracker</h1>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
        if (path === '/sw.js' || path === '/scripts/index-sw.js') {
          return new Response('self.addEventListener("install", () => {})', {
            headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
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

test('the homepage revalidates in the browser but may be edge-cached, while update entry points never cache', async () => {
  // The browser must revalidate before reuse so a deploy is visible; only the
  // edge is allowed a one-minute copy to remove the round trip per visitor.
  for (const path of ['/', '/index.html']) {
    const response = await router.fetch(new Request('https://tracker.test' + path), env, ctx);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('Cache-Control'), 'no-cache, must-revalidate, max-age=0', path);
    assert.doesNotMatch(response.headers.get('Cache-Control'), /no-store|immutable/, path);
    assert.match(response.headers.get('Pragma'), /no-cache/, path);
    assert.equal(response.headers.get('Expires'), '0', path);
    assert.equal(response.headers.get('CDN-Cache-Control'), 'public, s-maxage=60, stale-while-revalidate=300', path);
  }

  for (const path of ['/sw.js', '/scripts/index-sw.js']) {
    const response = await router.fetch(new Request('https://tracker.test' + path), env, ctx);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Cache-Control'), /no-store/, path);
    assert.doesNotMatch(response.headers.get('Cache-Control'), /immutable/, path);
    assert.match(response.headers.get('Pragma'), /no-cache/, path);
    assert.equal(response.headers.get('Expires'), '0', path);
    assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store', path);
  }

  const document = await router.fetch(new Request('https://tracker.test/about'), env, ctx);
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

test('static headers revalidate HTML, cache versioned assets and exempt update entry points', async () => {
  const headers = await read('_headers');
  const html = headers.match(/\/\*\.html[\s\S]*?(?=\n\/|$)/);
  assert.ok(html, 'HTML _headers block is missing');
  assert.match(html[0], /Cache-Control: no-cache, must-revalidate/);
  assert.match(html[0], /Pragma: no-cache/);
  assert.match(html[0], /Expires: 0/);

  for (const [name, path] of [['homepage', '/'], ['index', '/index.html']]) {
    const block = headers.match(new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\r?\\n)', 'm'));
    assert.ok(block, name + ' block is missing');
    assert.match(block[1], /Cache-Control: no-cache, must-revalidate, max-age=0/, name);
    assert.match(block[1], /CDN-Cache-Control: public, s-maxage=60, stale-while-revalidate=300/, name);
    assert.doesNotMatch(block[1], /immutable|no-store/, name);
  }

  const serviceWorker = headers.match(/^\/sw\.js\r?\n([\s\S]*?)(?=\r?\n\r?\n)/m);
  assert.ok(serviceWorker, 'service worker block is missing');
  assert.match(serviceWorker[1], /Cache-Control: no-store/);
  assert.match(serviceWorker[1], /CDN-Cache-Control: no-store/);
  assert.doesNotMatch(serviceWorker[1], /immutable/, 'service worker');

  const appScript = headers.match(/\/scripts\/index-sw\.js\r?\n([\s\S]*?)(?=\r?\n\r?\n)/);
  assert.ok(appScript, 'service-worker registration block is missing');
  assert.match(appScript[1], /! Cache-Control/);
  assert.match(appScript[1], /! CDN-Cache-Control/);
  assert.match(appScript[1], /Cache-Control: no-store/);
  assert.ok(headers.indexOf('/scripts/index-sw.js') > headers.indexOf('/scripts/*'), 'the exception must follow /scripts/*');

  assert.match(headers, /\/styles\/\*[\s\S]*?Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\/scripts\/\*[\s\S]*?Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\/pages\.css[\s\S]*?Cache-Control: public, max-age=31536000, immutable/);
  assert.match(headers, /\/data\/\*[\s\S]*?Cache-Control: no-store/);
  // A broad cache rule would be merged with the asset rule by Cloudflare.
  const global = headers.match(/^\/\*\r?\n([\s\S]*?)(?=\r?\n\r?\n)/m);
  assert.ok(global, 'global security block is missing');
  assert.doesNotMatch(global[1], /Cache-Control/);
});


test('the deploy smoke check asserts the same homepage policy as _headers', async () => {
  const headers = await read('_headers');
  const smoke = await read('tools/smoke-deploy.mjs');

  // The homepage block defines the browser and edge policy the smoke check
  // compares against exactly, not as a substring.
  const homepage = headers.match(/^\/\r?\n([\s\S]*?)(?=\r?\n\r?\n)/m);
  assert.ok(homepage, 'homepage _headers block is missing');
  const browser = (homepage[1].match(/Cache-Control: ([^\r\n]+)/) || [])[1];
  const edge = (homepage[1].match(/CDN-Cache-Control: ([^\r\n]+)/) || [])[1];
  assert.equal(browser, 'no-cache, must-revalidate, max-age=0');
  assert.equal(edge, 'public, s-maxage=60, stale-while-revalidate=300');

  const escapeRe = (value) => value.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(smoke, new RegExp("const SHARED_CACHE = '" + escapeRe(browser) + "';"));
  assert.match(smoke, new RegExp("const SHARED_CDN = '" + escapeRe(edge) + "';"));
  assert.match(smoke, /const NO_STORE = 'no-store, no-cache, must-revalidate, max-age=0';/);

  for (const path of ['/sw.js', '/scripts/index-sw.js']) {
    const block = headers.match(new RegExp('^' + escapeRe(path) + '\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\r?\\n)', 'm'));
    assert.ok(block, path + ' block is missing');
    assert.match(block[1], /Cache-Control: no-store/, path);
    assert.match(block[1], /Pragma: no-cache/, path);
    assert.match(block[1], /Expires: 0/, path);
    assert.match(block[1], /CDN-Cache-Control: no-store/, path);
    assert.doesNotMatch(block[1], /immutable|public, max-age/, path);
  }

  const index = headers.match(/\/index\.html\r?\n([\s\S]*?)(?=\r?\n\r?\n)/);
  assert.ok(index, '/index.html block is missing');
  assert.match(index[1], /! Cache-Control/);
  assert.match(index[1], /! CDN-Cache-Control/);
  assert.match(index[1], new RegExp('Cache-Control: ' + escapeRe(browser)));
  assert.match(index[1], new RegExp('CDN-Cache-Control: ' + escapeRe(edge)));

  // Every entry point covered by that policy is probed on the deploy.
  assert.match(smoke, /checkSharedCache\('homepage', home\)/);
  assert.match(smoke, /checkNoStore\('service worker', sw\)/);
  assert.match(smoke, /get\('\/index\.html', \{ redirect: 'manual' \}\)/);
  assert.match(smoke, /indexTarget\.pathname === '\/'/);
  assert.match(smoke, /checkSharedCache\('index route', indexRoute\)/);
  assert.match(smoke, /get\('\/scripts\/index-sw\.js'\)/);
  assert.match(smoke, /checkNoStore\('app script', appScript\)/);
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
