import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);

async function read(name) {
  return readFile(new URL(name, ROOT), 'utf8');
}

// Split on blank lines so a block is never cut at the first line break and the
// result does not depend on the file's line endings.
function blocks(headers) {
  const map = new Map();
  for (const chunk of headers.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    // A block may be preceded by comment lines, so the selector is the first
    // line that starts with a slash rather than always the first line.
    const lines = chunk.split('\n').map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => line.startsWith('/'));
    if (index === -1) continue;
    map.set(lines[index], lines.slice(index + 1).join('\n'));
  }
  return map;
}

test('the static layer treats the root icons as immutable, like the router does', async () => {
  const headers = blocks(await read('_headers'));
  const router = await read('functions/_router.js');
  for (const path of ['/icon.svg', '/apple-touch-icon.png']) {
    // The router lists both in IMMUTABLE_ROOTS; if _headers disagreed, the same
    // URL would be immutable through one layer and revalidated through the other.
    assert.ok(router.includes(`"${path}"`), `${path} missing from IMMUTABLE_ROOTS`);
    const rules = headers.get(path);
    assert.ok(rules, `${path} block missing from _headers`);
    assert.match(rules, /Cache-Control: public, max-age=31536000, immutable/, path);
    assert.match(rules, /CDN-Cache-Control: public, max-age=31536000, immutable/, path);
  }
});

test('the error and internal pages are excluded from the index under every name', async () => {
  const headers = blocks(await read('_headers'));

  for (const selector of ['/search-coverage', '/search-coverage.html']) {
    const rules = headers.get(selector);
    assert.ok(rules, `${selector} block missing`);
    assert.match(rules, /X-Robots-Tag: noindex/, selector);
  }

  for (const selector of ['/404-internal', '/404-internal.html', '/404.html']) {
    const rules = headers.get(selector);
    assert.ok(rules, `${selector} block missing`);
    assert.match(rules, /X-Robots-Tag: noindex/, selector);
  }
  assert.match(headers.get('/404.html'), /Cache-Control: no-store/);
});

test('no selector block is declared twice', async () => {
  const headers = await read('_headers');
  const selectors = headers
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/') && !line.startsWith('/*') && !line.includes(' '));
  const seen = new Set();
  for (const selector of selectors) {
    assert.equal(seen.has(selector), false, `${selector} is declared twice`);
    seen.add(selector);
  }
});
