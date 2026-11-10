/**
 * Post-deploy smoke check.
 *
 * Verifies the deployed origin serves the Functions API, manifest, service
 * worker and comparison page - the four things a stale or failed Pages upload
 * silently drops. Exits non-zero so a broken deploy fails its workflow.
 *
 *   node tools/smoke-deploy.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:8788 node tools/smoke-deploy.mjs
 */

const BASE = String(process.env.SMOKE_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
const MONTH = process.env.SMOKE_MONTH || '2026-11';
let failures = 0;

async function get(path, options = {}) {
  const response = await fetch(BASE + path, { redirect: 'follow', ...options });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or js */ }
  return { status: response.status, type: response.headers.get('content-type') || '', text, json };
}

function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures += 1;
}

console.log('Smoke-testing ' + BASE + '\n');

const home = await get('/');
check('homepage serves', home.status === 200 && /Irish Visa/i.test(home.text), 'HTTP ' + home.status);
check('homepage is HTML', home.type.includes('text/html'), home.type);

const comparisonRoute = await get('/comparison');
check('comparison route serves', comparisonRoute.status === 200 && /comparison/i.test(comparisonRoute.text), 'HTTP ' + comparisonRoute.status);

const comparisonFile = await get('/comparison.html');
check('comparison asset serves', comparisonFile.status === 200 && /comparison/i.test(comparisonFile.text), 'HTTP ' + comparisonFile.status);

const manifest = await get('/manifest.json');
check('manifest serves', manifest.status === 200 && manifest.json && Array.isArray(manifest.json.icons) && manifest.json.icons.length > 0, 'HTTP ' + manifest.status);

const sw = await get('/sw.js');
check('service worker serves', sw.status === 200 && /CACHE_NAME/.test(sw.text), 'HTTP ' + sw.status);
check('service worker is JavaScript', sw.type.includes('javascript'), sw.type);

const icon = await get('/icon-192.png');
check('manifest icon serves', icon.status === 200 && icon.type.includes('image/png'), 'HTTP ' + icon.status + ' ' + icon.type);

const search = await get('/api/search');
check('search API serves', search.status === 200 && search.json && Array.isArray(search.json.modes), 'HTTP ' + search.status);

const report = await get('/api/reports/monthly?month=' + encodeURIComponent(MONTH));
check('monthly report API serves', report.status === 200 && report.json && report.json.success === true, 'HTTP ' + report.status);

const preview = await get('/api/digest/preview?month=' + encodeURIComponent(MONTH));
check('digest preview API serves', preview.status === 200 && preview.json && preview.json.success === true, 'HTTP ' + preview.status);

const me = await get('/api/auth/me');
check('auth API is mounted', me.status === 401 || me.status === 200, 'HTTP ' + me.status);

const data = await get('/data/data_manifest.json');
check('data manifest serves', data.status === 200 && data.json && Array.isArray(data.json.offices), 'HTTP ' + data.status);

console.log('\n' + (failures === 0 ? 'Post-deploy smoke check passed.' : failures + ' post-deploy check(s) failed.'));
process.exitCode = failures === 0 ? 0 : 1;
