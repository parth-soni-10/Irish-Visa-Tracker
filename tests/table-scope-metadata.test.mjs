import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function read(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}

const TABLE_PAGES = [
  'new-delhi-visa-decisions.html',
  'beijing-visa-decisions.html',
  'abu-dhabi-visa-decisions.html',
  'abuja-visa-decisions.html',
  'ankara-visa-decisions.html',
  'dublin-visa-decisions.html',
  'monthly-report.html',
  'visa-processing-times.html',
];

test('status and terms carry Open Graph and Twitter card metadata', async () => {
  for (const name of ['status.html', 'terms.html']) {
    const html = await read(name);
    for (const property of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image']) {
      assert.match(html, new RegExp(`property="${property}" content="[^"]+"`), `${name} ${property}`);
    }
    assert.match(html, /name="twitter:card" content="summary_large_image"/, name);
    assert.match(html, /name="twitter:title" content="[^"]+"/, name);
  }
});

test('every table header on a generated page declares its scope', async () => {
  for (const name of TABLE_PAGES) {
    const html = await read(name);
    assert.doesNotMatch(html, /<th>/, `${name} has a <th> without scope`);
    assert.doesNotMatch(html, /<th\s+class="[^"]*">/, `${name} has a classed <th> without scope`);
  }
});
