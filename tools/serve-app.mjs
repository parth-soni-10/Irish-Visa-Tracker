/**
 * Serve the cutover app the way the cutover will.
 *
 *   node tools/serve-app.mjs            → http://127.0.0.1:4311
 *   PORT=4312 node tools/serve-app.mjs
 *
 * `app/` is the document root, and `data/`, `fonts/` and the icon/OG images are
 * served from the repository root, which is exactly what the cutover build will
 * copy into the upload. The `_headers` policy from `app/_headers` is applied for
 * real — a local server without the CSP would let a runtime style attribute or
 * an inline script "pass" here and fail on the deployment, which is the one
 * failure this file exists to prevent.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const appRoot = join(repo, 'app');
const port = Number(process.env.PORT || 4311);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const headersFile = await readFile(join(appRoot, '_headers'), 'utf8');
const cspLine = headersFile.split(/\r?\n/).find((line) => line.trim().startsWith('Content-Security-Policy:'));
const csp = cspLine ? cspLine.split(':').slice(1).join(':').trim() : '';

/** Shared assets live above `app/` until the cutover build copies them in. */
function candidatePaths(urlPath) {
  // Strip the leading slash BEFORE normalising: on Windows `normalize('/data/x')`
  // returns `\data\x`, and joining that to the app root escapes the root.
  const clean = normalize(decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '')).replace(/^(\.\.[/\\])+/, '');
  const list = [join(appRoot, clean)];
  if (/^(data|fonts)[/\\]/.test(clean) || /^(icon\.svg|apple-touch-icon\.png|og-image\.png)$/.test(clean)) list.push(join(repo, clean));
  return list;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const headers = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
  };

  if (req.method === 'POST') {
    // The forms post to this origin; the local server acknowledges them so the
    // UI's success path is exercisable without a D1 binding.
    await new Promise((done) => { req.on('data', () => {}); req.on('end', done); });
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, local: true }));
    return;
  }

  if (url.pathname === '/api/community-submissions') {
    // Read-only preview of the Worker route the admin surface reads. The real
    // deployment answers from D1; locally it is genuinely empty, not mocked.
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end('[]');
    return;
  }

  let path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (path === '/index.html') {
    // probe both roots for the document
  }
  for (const candidate of candidatePaths(path)) {
    if (!existsSync(candidate)) continue;
    const info = await stat(candidate);
    if (info.isDirectory()) {
      const index = join(candidate, 'index.html');
      if (!existsSync(index)) continue;
      res.writeHead(200, { ...headers, 'Content-Type': types['.html'] });
      res.end(await readFile(index));
      return;
    }
    const type = types[extname(candidate)] || 'application/octet-stream';
    res.writeHead(200, { ...headers, 'Content-Type': type });
    res.end(await readFile(candidate));
    return;
  }
  res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`visa app on http://127.0.0.1:${port}/  (CSP from app/_headers)`);
});
