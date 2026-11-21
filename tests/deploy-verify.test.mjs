import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isIgnored, normaliseAsset, stripCloudflareAnalytics } from '../tools/verify-deploy.mjs';

const VERIFY_SCRIPT = fileURLToPath(new URL('../tools/verify-deploy.mjs', import.meta.url));

function makeDist(commit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-verify-'));
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ commit, built_at: '2026-11-17T11:00:00Z' }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>same</h1>\n');
  fs.writeFileSync(path.join(dir, 'asset.txt'), 'same\n');
  return dir;
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close();
    }
  };
}

function runVerifier(base, dist, commit, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VERIFY_SCRIPT], {
      env: {
        ...process.env,
        VERIFY_BASE_URL: base,
        VERIFY_DIST_DIR: dist,
        VERIFY_COMMIT: commit,
        VERIFY_TIMEOUT_MS: '4000',
        VERIFY_INTERVAL_MS: '25',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('verifier timed out in test'));
    }, 10000);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

test('deploy verifier removes only the Pages analytics injection', () => {
  const local = '<!doctype html><html><body><h1>Tracker</h1>\n</body></html>\n';
  const live =
    '<!doctype html><html><body><h1>Tracker</h1>\n' +
    "<!-- Cloudflare Pages Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{\"token\":\"test\"}'></script><!-- Cloudflare Pages Analytics -->" +
    '</body></html>\n';
  assert.equal(stripCloudflareAnalytics(live), local);
  assert.equal(normaliseAsset('index.html', Buffer.from(live)).toString('utf8'), local);
});

test('deploy verifier normalises CRLF for text but not binary files', () => {
  const html = Buffer.from('<p>line</p>\r\n<p>next</p>\r\n');
  assert.equal(normaliseAsset('page.html', html).toString('utf8'), '<p>line</p>\n<p>next</p>\n');

  const binary = Buffer.from([0, 1, 2, 13, 10, 255]);
  assert.deepEqual(normaliseAsset('icon.png', binary), binary);
});

test('deploy verifier ignores the generated timestamp in the search indexes', () => {
  const first = Buffer.from(JSON.stringify({ generated_at: '2026-11-17T10:00:00Z', rows: [['x']] }));
  const second = Buffer.from(JSON.stringify({ generated_at: '2026-11-17T11:00:00Z', rows: [['x']] }));
  for (const name of ['data/search_fallback.json', 'data/search_preview.json']) {
    assert.deepEqual(normaliseAsset(name, first), normaliseAsset(name, second), name);
  }
});

test('deploy verifier skips Pages-consumed platform files', () => {
  assert.equal(isIgnored('_redirects'), true);
  assert.equal(isIgnored('_headers'), true);
  assert.equal(isIgnored('404.html'), true);
  assert.equal(isIgnored('index.html'), false);
});

test('deploy verifier retries a transient edge mismatch', async (t) => {
  const commit = 'a'.repeat(40);
  const dist = makeDist(commit);
  let assetRequests = 0;
  const { base, close } = await startServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/build-info.json') return send(res, 200, 'application/json', JSON.stringify({ commit }));
    if (pathname === '/asset.txt') {
      assetRequests += 1;
      return send(res, 200, 'text/plain', assetRequests === 1 ? 'stale\n' : 'same\n');
    }
    if (pathname === '/index.html') return send(res, 200, 'text/html', '<h1>same</h1>\n');
    return send(res, 404, 'text/plain', '');
  });
  t.after(() => {
    close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const result = await runVerifier(base, dist, commit);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Deployment verified/);
  assert.match(result.stdout, /after 2 attempts/);
  assert.ok(assetRequests >= 2, `expected a retry, saw ${assetRequests} asset request(s)`);
});

test('deploy verifier accepts a newer deployment taking over', async (t) => {
  const commit = 'b'.repeat(40);
  const newer = 'c'.repeat(40);
  const dist = makeDist(commit);
  const outputPath = path.join(os.tmpdir(), `deploy-verify-${process.pid}-${Date.now()}`);
  let infoRequests = 0;
  const { base, close } = await startServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/build-info.json') {
      infoRequests += 1;
      return send(res, 200, 'application/json', JSON.stringify({ commit: infoRequests === 1 ? commit : newer }));
    }
    if (pathname === '/asset.txt') return send(res, 200, 'text/plain', 'stale\n');
    if (pathname === '/index.html') return send(res, 200, 'text/html', '<h1>same</h1>\n');
    return send(res, 404, 'text/plain', '');
  });
  t.after(() => {
    close();
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(outputPath, { force: true });
  });

  const result = await runVerifier(base, dist, commit, { GITHUB_OUTPUT: outputPath });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /Deployment superseded/);
  assert.match(result.stdout, new RegExp(newer.slice(0, 12)));
  assert.match(fs.readFileSync(outputPath, 'utf8'), /superseded=true/);
});

test('deploy verifier still fails on persistent content differences', async (t) => {
  const commit = 'd'.repeat(40);
  const dist = makeDist(commit);
  const { base, close } = await startServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/build-info.json') return send(res, 200, 'application/json', JSON.stringify({ commit }));
    if (pathname === '/asset.txt') return send(res, 200, 'text/plain', 'different\n');
    if (pathname === '/index.html') return send(res, 200, 'text/html', '<h1>same</h1>\n');
    return send(res, 404, 'text/plain', '');
  });
  t.after(() => {
    close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  const result = await runVerifier(base, dist, commit);
  assert.equal(result.code, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /artifacts still differ/);
  assert.match(result.stderr, /asset\.txt: content differs/);
});
