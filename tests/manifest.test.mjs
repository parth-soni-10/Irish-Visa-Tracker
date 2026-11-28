import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);

const manifest = JSON.parse(await readFile(new URL('manifest.json', ROOT), 'utf8'));

test('the web app manifest names an identity and a language', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.lang, 'en');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal('screenshots' in manifest, false, 'an empty screenshots array adds nothing');
});

test('every install shortcut opens a page that exists', async () => {
  // A shortcut that lands on a legacy tab alias resolves elsewhere: `?tab=analytics`
  // used to open the search tab, so the install menu promised charts it never showed.
  // `home` -> search and `daily` -> the daily history view are intended aliases;
  // these four resolve somewhere other than what the shortcut name promises.
  const legacyOnly = ['analytics', 'watchlist', 'suggest', 'suggestions'];
  assert.ok(manifest.shortcuts.length >= 2);
  for (const shortcut of manifest.shortcuts) {
    assert.match(shortcut.url, /^\//, shortcut.name);
    const params = new URLSearchParams(shortcut.url.split('?')[1] || '');
    const tab = params.get('tab');
    if (tab) assert.equal(legacyOnly.includes(tab), false, `${shortcut.name} uses the legacy tab ${tab}`);
    if (shortcut.url === '/status') {
      assert.ok(existsSync(new URL('status.html', ROOT)), '/status needs status.html');
    }
    for (const icon of shortcut.icons || []) {
      assert.ok(existsSync(new URL(icon.src.replace(/^\//, ''), ROOT)), icon.src);
    }
  }
});

test('every declared icon exists and is a PNG of the size it claims', async () => {
  for (const icon of manifest.icons) {
    const src = icon.src.replace(/^\//, '');
    assert.ok(existsSync(new URL(src, ROOT)), src);
    const bytes = await readFile(new URL(src, ROOT));
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    assert.equal(`${width}x${height}`, icon.sizes, src);
  }
});
