/**
 * Stage the cutover app for a Pages upload.
 *
 *   node tools/build-app.mjs [--out .pages-dist]
 *
 * `app/` becomes the document root. The things it reads but does not own are
 * copied in beside it — `data/` (scraper-owned, read-only here), `fonts/`, the
 * icon/OG images, and the two crawl files (`robots.txt`, `sitemap.xml`) —
 * because the Pages upload is one directory and a relative
 * `data/visa_decisions.json` has to resolve inside it. Dropping the crawl files
 * would have been a silent SEO regression: the old root app served them, and a
 * cutover that forgets them is a site that stops being crawlable while every
 * page still renders.
 *
 * The root `_headers` and the root `404.html` are deliberately NOT copied:
 * `app/_headers` is the new policy (deploy-pages keeps a staged `_headers` as a
 * directive), and the shared stager generates a CSP-safe 404 that links
 * `404.css` when the assets carry none. The root `_headers` stays in the
 * repository as the rollback's policy — reverting the build command must bring
 * the old app's headers back with it, not leave the old app bare.
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
for (const file of ['icon.svg', 'apple-touch-icon.png', 'og-image.png', 'robots.txt', 'sitemap.xml']) {
  if (!existsSync(join(repo, file))) throw new Error(`build-app: ${file} is part of the published site but is missing from the repository root`);
  await cp(join(repo, file), join(out, file));
}

// The Workers/Functions router is not part of the upload — Pages compiles
// `functions/` from the repository — but a copy of the staging list is useful
// when someone asks what the deploy actually contained.
const files = (await readdir(out, { withFileTypes: true })).map((entry) => entry.name).sort();
console.log(`build-app: staged ${files.length} top-level entries in ${out}`);
