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

test('documents, app scripts and data are never cached by the router', async () => {
  for (const path of ['/', '/scripts/app.js', '/data/test.json']) {
    const response = await router.fetch(new Request('https://tracker.test' + path), env, ctx);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('Cache-Control'), /no-store/, path);
    assert.match(response.headers.get('Pragma'), /no-cache/, path);
    assert.equal(response.headers.get('Expires'), '0', path);
  }
});

test('every static path gets the no-store policy', async () => {
  const headers = await read('_headers');
  const global = headers.match(/\/\*[\s\S]*?(?=\n\/|$)/);
  assert.ok(global, 'global _headers block is missing');
  assert.match(global[0], /Cache-Control: no-store/);
  assert.match(global[0], /Pragma: no-cache/);
  assert.match(global[0], /Expires: 0/);
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
