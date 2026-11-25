import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Every @font-face body in a stylesheet, so rules can be inspected one by one. */
function faceRules(source) {
  return [...source.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]);
}

function unicodeRanges(rule) {
  const declared = rule.match(/unicode-range:\s*([^;]+);/);
  return declared ? declared[1].split(',').map((range) => range.trim()) : [];
}

test('the latin-ext subset stays behind its own unicode-range', () => {
  const faces = faceRules(read('styles/index.css'));
  const latin = faces.find((rule) => rule.includes("'/fonts/inter-latin.woff2'"));
  const latinExt = faces.find((rule) => rule.includes("'/fonts/inter-latin-ext.woff2'"));

  assert.ok(latin, 'the latin subset is declared');
  assert.ok(latinExt, 'the latin-ext subset is declared');

  // ASCII and the Latin-1 punctuation the site writes must be served by the
  // 48 KB file; if either range leaked, every page would fetch both.
  assert.ok(unicodeRanges(latin).includes('U+0000-00FF'));
  assert.ok(!unicodeRanges(latin).includes('U+0100-02BA'));
  assert.ok(unicodeRanges(latinExt).includes('U+0100-02BA'));
  assert.ok(!unicodeRanges(latinExt).includes('U+0000-00FF'));
});

test('only the latin subset is ever preloaded, and never on the homepage', () => {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === '.wrangler') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) pages.push(full);
    }
  };
  walk(ROOT);
  assert.ok(pages.length > 0, 'page files were found');

  const preloads = pages.flatMap((file) => {
    const html = fs.readFileSync(file, 'utf8');
    return [...html.matchAll(/<link[^>]+rel=["']preload["'][^>]+href=["']([^"']*\/fonts\/[^"']*)["'][^>]*>/gi)]
      .map((match) => ({ file: path.relative(ROOT, file).replace(/\\/g, '/'), href: match[1] }));
  });

  // The 85 KB extended subset is demand-loaded; preloading it would charge every
  // visitor for glyphs no page uses.
  const extended = preloads.filter((preload) => /inter-latin-ext\.woff2/.test(preload.href));
  assert.deepEqual(extended, []);

  // The dashboard deliberately has no font preload: its LCP is a text heading
  // and the preload competed with the stylesheet (see the discovery audit).
  const homepage = preloads.filter((preload) => /^(\.pages-dist\/)?index\.html$/.test(preload.file));
  assert.deepEqual(homepage, []);
});

test('pages that render no latin-ext text only reference the latin file', () => {
  // The trust pages and the shared site chrome carry no latin-ext text, so they
  // declare one face instead of two. Only the dashboard stylesheet knows the
  // extended subset, and its unicode-range keeps it unloaded until it is needed.
  for (const file of ['pages.css', 'site-chrome.css']) {
    const source = read(file);
    assert.ok(source.includes('/fonts/inter-latin.woff2'), `${file} uses the latin subset`);
    assert.ok(!source.includes('/fonts/inter-latin-ext.woff2'), `${file} does not reference the latin-ext subset`);
    assert.ok(!source.includes('unicode-range'), `${file} declares no ranged faces to evaluate`);
  }
});
