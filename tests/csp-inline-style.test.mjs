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

test('the build writes well-formed inline stylesheet hashes for every inlined page', () => {
  const module = read('functions/_csp-inline-style.js');
  const match = module.match(/INLINE_STYLE_SHA256S = (\[[^\]]*\])/);
  assert.ok(match, 'the generated module exports INLINE_STYLE_SHA256S');
  const hashes = JSON.parse(match[1]);
  assert.ok(hashes.length >= 2, 'the homepage and the content pages each have a hash');
  for (const hash of hashes) {
    assert.match(hash, /^sha256-[A-Za-z0-9+/]{43}=$/, 'the value is a base64 SHA-256 digest');
  }
});

test('the CSP adds every hash as a quoted style-src-elem source', () => {
  const router = read('functions/_router.js');
  assert.match(router, /import \{ INLINE_STYLE_SHA256S \} from '\.\/_csp-inline-style\.js'/);
  assert.match(
    router,
    /INLINE_STYLE_SHA256S\.map\(\(hash\) => ` '\$\{hash\}'`\)\.join\(""\)/,
    'a CSP hash source must be single-quoted, or the browser ignores it',
  );
  assert.doesNotMatch(router, /style-src-elem 'self' 'unsafe-inline'/);
});

test('the inliner normalises line endings before hashing', () => {
  const build = read('tools/deploy-pages.mjs');
  assert.match(build, /\.replace\(\/\\r\\n\?\/g, '\\n'\)/, 'CRLF from a Windows checkout would change the hash');
});
