import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { addVersion, shouldVersion, versionAssets } from '../tools/version-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('only local static assets are versioned', () => {
  assert.equal(shouldVersion('/styles/index.css'), true);
  assert.equal(shouldVersion('/scripts/index-bundle.js?v=old'), true);
  assert.equal(shouldVersion('/fonts/inter-latin.woff2'), true);
  assert.equal(shouldVersion('/assets/social/report.png'), true);
  assert.equal(shouldVersion('/data/decisions.json'), false);
  assert.equal(shouldVersion('/about'), false);
  assert.equal(shouldVersion('/index.html'), false);
  assert.equal(shouldVersion('https://example.test/styles/index.css'), false);
  assert.equal(addVersion('/styles/index.css', 'abc123'), '/styles/index.css?v=abc123');
});

test('HTML and CSS references get one stable build version', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.tmp-version-assets-'));
  try {
    fs.mkdirSync(path.join(dir, 'styles'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.writeFileSync(path.join(dir, 'styles', 'a.css'), 'body{background:url("/fonts/a.woff2")}');
    fs.writeFileSync(path.join(dir, 'scripts', 'a.js'), 'console.log("a")');
    fs.writeFileSync(path.join(dir, 'fonts', 'a.woff2'), 'font');
    fs.writeFileSync(path.join(dir, 'index.html'), [
      '<link rel="stylesheet" href="/styles/a.css">',
      '<script src="/scripts/a.js"></script>',
      '<a href="/about">About</a>',
      '<a href="/data/x.json">Data</a>',
    ].join('\n'));

    const first = versionAssets(dir);
    assert.match(first.version, /^[a-f0-9]{10}$/);
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /\/styles\/a\.css\?v=[a-f0-9]{10}/);
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /\/scripts\/a\.js\?v=[a-f0-9]{10}/);
    assert.match(fs.readFileSync(path.join(dir, 'styles', 'a.css'), 'utf8'), /\/fonts\/a\.woff2\?v=[a-f0-9]{10}/);
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /href="\/about"/);
    assert.match(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /href="\/data\/x\.json"/);

    const second = versionAssets(dir);
    assert.equal(second.version, first.version);
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.equal((html.match(/\?v=/g) || []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
