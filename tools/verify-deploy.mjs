/**
 * Verify that the public deployment is serving the build that CI just made.
 *
 * Cloudflare Pages deploys through its Git integration, so a push does not
 * return a deployment id to GitHub Actions. The build writes build-info.json
 * containing the commit SHA; this script waits for that marker, then downloads
 * every file in .pages-dist and compares it with the built artifact.
 *
 *   node tools/verify-deploy.mjs
 *   VERIFY_BASE_URL=https://... VERIFY_DIST_DIR=.pages-dist node tools/verify-deploy.mjs
 *
 * Cloudflare injects its Pages Analytics snippet into HTML and may normalise
 * CRLF line endings. Those are the only differences treated as noise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = String(
  process.env.VERIFY_BASE_URL || process.env.SMOKE_BASE_URL || 'https://irishvisaupdatetracker.pages.dev'
).replace(/\/+$/, '');
const DIST = path.resolve(process.env.VERIFY_DIST_DIR || '.pages-dist');
const COMMIT = String(process.env.VERIFY_COMMIT || process.env.GITHUB_SHA || '').trim();
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 300000);
const INTERVAL_MS = Number(process.env.VERIFY_INTERVAL_MS || 10000);

function walk(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

export function stripCloudflareAnalytics(html) {
  return html
    .replace(/<!-- Cloudflare Pages Analytics -->[\s\S]*?<!-- Cloudflare Pages Analytics -->/g, '')
    .replace(/\r\n?/g, '\n');
}

export function normaliseAsset(name, bytes) {
  if (/\.(?:html?|css|js|json|xml|txt|md|svg)$/i.test(name)) {
    const text = stripCloudflareAnalytics(bytes.toString('utf8'));
    return Buffer.from(text.replace(/\r\n?/g, '\n'));
  }
  return bytes;
}

function isIgnored(name) {
  // These are platform files, not served as ordinary static assets.
  return name === '_headers' || name === '404.html';
}

async function fetchAsset(name) {
  const url = new URL(BASE + '/' + name.split('/').map(encodeURIComponent).join('/'));
  url.searchParams.set('__deploy_check', Date.now().toString(36));
  const response = await fetch(url, { cache: 'no-store', redirect: 'manual' });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function waitForCommit(commit) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const url = new URL(BASE + '/build-info.json');
      url.searchParams.set('__deploy_check', Date.now().toString(36));
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) {
        const info = await response.json();
        if (!commit || info.commit === commit) return info;
        last = `live build is ${String(info.commit || 'unknown').slice(0, 12)}, waiting for ${commit.slice(0, 12)}`;
      } else {
        last = `build-info.json returned HTTP ${response.status}`;
      }
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
  throw new Error('deployment did not become current: ' + last);
}

async function compareAll(files, info) {
  const failures = [];
  const checked = [];
  for (const name of files) {
    if (isIgnored(name)) continue;
    const local = fs.readFileSync(path.join(DIST, name));
    checked.push(name);
    // Kept for a useful failure message if a request itself throws.
    // eslint-disable-next-line no-await-in-loop
    const remote = await fetchAsset(name);
    if (remote.response.status !== 200) {
      failures.push(name + ': HTTP ' + remote.response.status);
      continue;
    }
    const expected = normaliseAsset(name, local);
    const actual = normaliseAsset(name, remote.bytes);
    if (!expected.equals(actual)) {
      failures.push(name + ': content differs (' + expected.length + ' local vs ' + actual.length + ' live bytes)');
    }
  }
  if (failures.length) {
    throw new Error(
      `serving ${info.commit.slice(0, 12)} but ${failures.length}/${checked.length} artifacts differ:\n- ` +
        failures.slice(0, 30).join('\n- ')
    );
  }
  return checked.length;
}

async function main() {
  if (!fs.existsSync(DIST)) throw new Error('build directory does not exist: ' + DIST);
  const files = walk(DIST);
  const info = await waitForCommit(COMMIT);
  if (COMMIT && info.commit !== COMMIT) throw new Error('build-info commit does not match');
  const count = await compareAll(files, info);
  console.log(`Deployment verified: ${count} artifacts match build ${String(info.commit).slice(0, 12)} at ${BASE}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('Deployment verification failed: ' + error.message);
    process.exit(1);
  });
}
