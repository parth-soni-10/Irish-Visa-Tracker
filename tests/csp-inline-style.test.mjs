import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The content pages inline their stylesheet, but the site's CSP refuses inline
// <style> elements unless the exact text is allowed. These checks cover the
// three ways that allowance has broken before: the hash drifts from the text,
// the source is emitted without the quotes CSP requires, and a Windows checkout
// hashes CRLF while the browser parses LF.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('the build writes a single well-formed inline stylesheet hash', () => {
  const module = read('functions/_csp-inline-style.js');
  const hash = module.match(/INLINE_STYLE_SHA256 = "([^"]+)"/);
  assert.ok(hash, 'the generated module exports INLINE_STYLE_SHA256');
  assert.match(hash[1], /^sha256-[A-Za-z0-9+/]{43}=$/, 'the value is a base64 SHA-256 digest');
});

test('the CSP adds that hash as a quoted style-src-elem source', () => {
  const router = read('functions/_router.js');
  assert.match(
    router,
    /"style-src-elem 'self' '" \+ INLINE_STYLE_SHA256 \+ "'; "/,
    "a CSP hash source must be single-quoted, or the browser ignores it",
  );
  assert.doesNotMatch(router, /style-src-elem 'self' 'unsafe-inline'/);
});

test('the inliner normalises line endings before hashing', () => {
  const build = read('tools/deploy-pages.mjs');
  assert.match(build, /\.replace\(\/\\r\\n\?\/g, '\\n'\)/, 'CRLF from a Windows checkout would change the hash');
});
