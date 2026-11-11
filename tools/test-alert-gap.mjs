/**
 * Integration check for the new gap-closing endpoints.
 *
 * Assumes a Pages dev server on http://127.0.0.1:8796 with:
 *   EMAIL_WEBHOOK_URL=http://127.0.0.1:8898/
 *   EMAIL_WEBHOOK_SECRET=alerts-test-secret
 *   EMAIL_FROM=...
 *   APP_BASE_URL=http://127.0.0.1:8796
 *   SCRAPER_CRON_SECRET=alerts-test-secret
 *
 * The script starts its own email-webhook stub on 8898.
 */

import http from 'node:http';

const BASE = 'http://127.0.0.1:8796';
const SECRET = 'alerts-test-secret';
const messages = [];
let failures = 0;

function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures += 1;
}

async function call(path, options = {}) {
  const response = await fetch(BASE + path, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: response.status, text, json };
}

const mock = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    try { messages.push(JSON.parse(body)); } catch { messages.push({ raw: body }); }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ id: 'mock-' + messages.length }));
  });
});

await new Promise((resolve) => mock.listen(8898, '127.0.0.1', resolve));
console.log('Gap flow against ' + BASE + ' (email webhook stub on :8898)\n');

try {
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(BASE + '/');
      if (response.ok) { ready = true; break; }
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('Pages server did not become ready');

  const statusPage = await call('/status');
  check('data status page serves', statusPage.status === 200 && /Data status/i.test(statusPage.text), 'HTTP ' + statusPage.status);

  const unauthorized = await call('/api/alerts/run', { method: 'POST' });
  check('alert runner rejects missing secret', unauthorized.status === 401, 'HTTP ' + unauthorized.status);

  const subscribe = await call('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'gap-test@example.com',
      application_number: '48850812',
      embassy: 'new-delhi'
    })
  });
  check('per-application subscribe succeeds', (subscribe.status === 200 || subscribe.status === 201) && subscribe.json && subscribe.json.ok === true, 'HTTP ' + subscribe.status);
  check('confirmation email reaches webhook stub', messages.length === 1, 'captured ' + messages.length);

  const confirmation = messages[0] || {};
  const verifyMatch = String(confirmation.html || '').match(/https?:\/\/[^"']+\/api\/verify\?token=[^"']+/);
  check('confirmation contains verify link', Boolean(verifyMatch));
  if (verifyMatch) {
    const verify = await fetch(verifyMatch[0]);
    check('verification link succeeds', verify.status === 200, 'HTTP ' + verify.status);
  }

  const beforeAlert = messages.length;
  const run = await call('/api/alerts/run', {
    method: 'POST',
    headers: { 'X-Cron-Secret': SECRET }
  });
  check('alert runner succeeds', run.status === 200 && run.json && run.json.sent === 1, JSON.stringify(run.json));
  check('decision email reaches webhook stub', messages.length === beforeAlert + 1, 'captured ' + messages.length);
  const alert = messages[messages.length - 1] || {};
  check('decision email names the outcome', /Visa Approved/i.test(String(alert.subject || '')), String(alert.subject || ''));

  const duplicateRun = await call('/api/alerts/run', {
    method: 'POST',
    headers: { 'X-Cron-Secret': SECRET }
  });
  check('alert runner is idempotent', duplicateRun.status === 200 && duplicateRun.json && duplicateRun.json.sent === 0, JSON.stringify(duplicateRun.json));

  const saved = await call('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: '48850812',
      mode: 'nearest',
      embassy: 'new-delhi',
      save_search: true,
      search_name: 'Gap test search'
    })
  });
  const savedId = saved.json && saved.json.saved_search_id;
  check('saved search is created', saved.status === 200 && Boolean(savedId), 'HTTP ' + saved.status);

  const listed = await call('/api/search?action=list');
  check('saved search list returns the row', listed.status === 200 && listed.json && Array.isArray(listed.json.searches) && listed.json.searches.some((row) => row.id === savedId), 'HTTP ' + listed.status);
  const savedRow = listed.json && Array.isArray(listed.json.searches) ? listed.json.searches.find((row) => row.id === savedId) : null;
  check('saved search query is parsed', Boolean(savedRow && savedRow.params && savedRow.params.query === '48850812'));

  const loaded = await call('/api/search?action=get&id=' + encodeURIComponent(savedId));
  check('saved search can be loaded', loaded.status === 200 && loaded.json && loaded.json.search && loaded.json.search.id === savedId, 'HTTP ' + loaded.status);

  const deleted = await call('/api/search?id=' + encodeURIComponent(savedId), { method: 'DELETE' });
  check('saved search can be deleted', deleted.status === 200 && deleted.json && deleted.json.success === true, 'HTTP ' + deleted.status);

  const config = await call('/api/config');
  check('workspace capability is advertised', config.status === 200 && config.json && config.json.workspace === true, 'HTTP ' + config.status);
  const community = await call('/api/portal/community');
  check('private community surface is mounted', community.status === 200 && community.json && Array.isArray(community.json.posts), 'HTTP ' + community.status);

  console.log('\n' + (failures === 0 ? 'All gap-flow checks passed.' : failures + ' gap-flow check(s) failed.'));
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await new Promise((resolve) => mock.close(resolve));
}
