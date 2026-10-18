/**
 * Stage the cutover app for a Pages upload.
 *
 *   node tools/build-app.mjs [--out .pages-dist]
 *
 * `app/` becomes the document root. The three things it reads but does not own
 * are copied in beside it — `data/` (scraper-owned, read-only here), `fonts/`
 * and the icon/OG images — because the Pages upload is one directory and a
 * relative `data/visa_decisions.json` has to resolve inside it.
 *
 * `--sw-cache visa-app-v1` lets deploy-pages tie the worker's cache name to the
 * staged bytes, so every deploy supersedes the previous offline cache.
 */
import { cp, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outIndex = process.argv.indexOf('--out');
const out = resolve(repo, outIndex >= 0 ? process.argv[outIndex + 1] : '.pages-dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

execFileSync(process.execPath, [
  join(repo, 'tools', 'deploy-pages.mjs'),
  '--assets', join(repo, 'app'),
  '--out', out,
  '--sw-cache', 'visa-app-v1',
], { stdio: 'inherit' });

await cp(join(repo, 'data'), join(out, 'data'), { recursive: true });
await cp(join(repo, 'fonts'), join(out, 'fonts'), { recursive: true });
for (const file of ['icon.svg', 'apple-touch-icon.png', 'og-image.png']) {
  if (existsSync(join(repo, file))) await cp(join(repo, file), join(out, file));
}

// The Workers/Functions router is not part of the upload — Pages compiles
// `functions/` from the repository — but a copy of the staging list is useful
// when someone asks what the deploy actually contained.
const files = (await readdir(out, { withFileTypes: true })).map((entry) => entry.name).sort();
console.log(`build-app: staged ${files.length} top-level entries in ${out}`);
