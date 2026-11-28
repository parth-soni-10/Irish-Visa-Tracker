import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const read = (name) => readFile(new URL(name, ROOT), 'utf8');

test('the homepage answers the query in visible copy and keeps freshness current', async () => {
  const html = await read('index.html');
  assert.match(html, /What this page answers/);
  assert.match(html, /<strong>Is my number published\?<\/strong>/);
  assert.match(html, /data-freshness-line/);
  assert.match(html, /Next expected New Delhi update/);
  assert.match(html, /Last checked/);
});

test('primary search forms keep the office selector behind an optional disclosure', async () => {
  const script = await read('scripts/index.js');
  const homeForm = script.slice(script.indexOf('home-lookup-form'), script.indexOf('home-search-options'));
  const landingForm = script.slice(script.indexOf('landing-search'), script.indexOf('landing-search-options'));
  assert.ok(homeForm.length > 0 && landingForm.length > 0);
  assert.doesNotMatch(homeForm, /id="home-office"/);
  assert.doesNotMatch(landingForm, /id="landing-office"/);
  assert.match(script, /<details class="search-options" id="home-search-options">/);
  assert.match(script, /<details class="search-options landing-search-options">/);
  assert.match(script, /All six offices are searched by default/);
});

test('funnel events carry device and office dimensions', async () => {
  const script = await read('scripts/index.js');
  assert.match(script, /trackConversion\('homepage_view', 'landing'\)/);
  assert.match(script, /trackConversion\('search_started', 'landing'\)/);
  assert.match(script, /device: \(document\.body/);
  assert.match(script, /payload\.office = selectedOffice/);
});
