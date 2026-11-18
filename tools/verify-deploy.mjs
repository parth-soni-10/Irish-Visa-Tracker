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
const ATTEMPTS = Math.max(1, Number(process.env.VERIFY_ATTEMPTS || 3) || 3);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  if (name === 'data/search_fallback.json') {
    // The generator stamps each build. The rows and office metadata are the
    // parts that must match the deployed data.
    try {
      const payload = JSON.parse(bytes.toString('utf8'));
      delete payload.generated_at;
      return Buffer.from(JSON.stringify(payload));
    } catch {
      return bytes;
    }
  }
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
  // Cloudflare Pages redirects /page.html to the clean /page URL. Follow it
  // so the comparison sees the document the browser actually receives.
  const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function fetchBuildInfo() {
  const url = new URL(BASE + '/build-info.json');
  url.searchParams.set('__deploy_check', Date.now().toString(36));
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`build-info.json returned HTTP ${response.status}`);
  return response.json();
}

async function waitForCommit(commit) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const info = await fetchBuildInfo();
      if (!commit || info.commit === commit) return info;
      last = `live build is ${String(info.commit || 'unknown').slice(0, 12)}, waiting for ${commit.slice(0, 12)}`;
    } catch (error) {
      last = error.message;
    }
    await sleep(INTERVAL_MS);
  }
  throw new Error('deployment did not become current: ' + last);
}

async function compareAll(files) {
  const failures = [];
  const checked = [];
  for (const name of files) {
    if (isIgnored(name)) continue;
    // The marker is checked separately; its built_at timestamp is regenerated
    // by Cloudflare's build and is not part of the deployed application.
    if (name === 'build-info.json') continue;
    const local = fs.readFileSync(path.join(DIST, name));
    checked.push(name);
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
  return { checked: checked.length, failures };
}

function readDistCommit() {
  const marker = path.join(DIST, 'build-info.json');
  if (!fs.existsSync(marker)) return null;
  try {
    return String(JSON.parse(fs.readFileSync(marker, 'utf8')).commit || '').trim() || null;
  } catch (error) {
    return null;
  }
}

/**
 * Comparing production against a stale .pages-dist reports phantom mismatches
 * for a deployment that is actually fine. Fail early, with the reason, before
 * downloading 85 artifacts.
 */
async function assertDistIsCurrent() {
  const distCommit = readDistCommit();
  if (!distCommit) return;
  if (COMMIT && distCommit !== COMMIT) {
    throw new Error(
      `.pages-dist was built from ${distCommit.slice(0, 12)} but this run verifies ${COMMIT.slice(0, 12)}; ` +
      'run npm run build first.'
    );
  }
  if (!COMMIT) {
    try {
      const live = await fetchBuildInfo();
      if (live.commit && live.commit !== distCommit) {
        throw new Error(
          `.pages-dist is stale: built from ${distCommit.slice(0, 12)} while production serves ` +
          `${String(live.commit).slice(0, 12)}. Run npm run build before verifying.`
        );
      }
    } catch (error) {
      if (error.message.startsWith('.pages-dist is stale')) throw error;
      console.warn('Could not compare .pages-dist with production yet: ' + error.message);
    }
  }
}

async function main() {
  if (!fs.existsSync(DIST)) throw new Error('build directory does not exist: ' + DIST);
  await assertDistIsCurrent();
  const files = walk(DIST);
  const info = await waitForCommit(COMMIT);

  // build-info can appear before a new asset reaches every edge, and a newer
  // commit can take over while this run is checking. Retry a bounded number
  // of times; if production moves to another commit, this build is superseded
  // and failing the old workflow would be misleading.
  let attempts = 0;
  while (attempts < ATTEMPTS) {
    attempts += 1;
    const result = await compareAll(files);
    if (!result.failures.length) {
      console.log(
        `Deployment verified: ${result.checked} artifacts match build ${String(info.commit).slice(0, 12)} at ${BASE}` +
        (attempts > 1 ? ` after ${attempts} attempts` : '')
      );
      return;
    }

    const detail = result.failures.slice(0, 12).join('\n- ');
    if (attempts >= ATTEMPTS) {
      throw new Error(
        `serving ${String(info.commit).slice(0, 12)} but ${result.failures.length}/${result.checked} artifacts still differ after ` +
        `${attempts} attempts:\n- ${detail}`
      );
    }

    console.warn(
      `Deployment not settled (attempt ${attempts}): ${result.failures.length}/${result.checked} artifacts differ; ` +
      `retrying in ${INTERVAL_MS}ms.\n- ${detail}`
    );
    await sleep(INTERVAL_MS);

    try {
      const latest = await fetchBuildInfo();
      if (latest.commit && latest.commit !== info.commit) {
        console.log(
          `Deployment superseded: production moved from ${String(info.commit).slice(0, 12)} to ` +
          `${String(latest.commit || 'unknown').slice(0, 12)} while verifying. Another push now owns production.`
        );
        if (process.env.GITHUB_OUTPUT) {
          try { fs.appendFileSync(process.env.GITHUB_OUTPUT, 'superseded=true\n'); } catch (error) { /* output is optional */ }
        }
        return;
      }
    } catch (error) {
      console.warn('Could not re-read build-info while retrying: ' + error.message);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error('Deployment verification failed: ' + error.message);
    // Let stdout/stderr drain before the process exits. process.exit() here
    // can trip a libuv assertion on Windows when the output pipe is still open.
    process.exitCode = 1;
  });
}
