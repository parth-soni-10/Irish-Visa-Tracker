/**
 * Post-deploy smoke check.
 *
 * Verifies the deployed origin serves the Functions API, manifest, service
 * worker and the legacy redirects - the things a stale or failed Pages upload
 * silently drops. Exits non-zero so a broken deploy fails its workflow.
 *
 *   node tools/smoke-deploy.mjs
 *   SMOKE_BASE_URL=http://127.0.0.1:8788 node tools/smoke-deploy.mjs
 */

const BASE = String(process.env.SMOKE_BASE_URL || 'https://irishvisaupdatetracker.pages.dev').replace(/\/+$/, '');
const MONTH = process.env.SMOKE_MONTH || '2026-11';
const EXPECT_COMMIT = String(process.env.SMOKE_EXPECT_COMMIT || '').trim();
let failures = 0;
let requestNumber = 0;

async function get(path, options = {}) {
  // Each probe gets a unique query so an old edge cache entry cannot make a
  // removed route look present (or a new asset look stale).
  const url = new URL(BASE + path);
  url.searchParams.set('__smoke', String(++requestNumber) + '-' + Date.now().toString(36));
  const response = await fetch(url, { redirect: 'follow', ...options });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html or js */ }
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    cacheControl: response.headers.get('cache-control') || '',
    location: response.headers.get('location'),
    text,
    json
  };
}

function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
  if (!ok) failures += 1;
}

console.log('Smoke-testing ' + BASE + '\n');

const home = await get('/');
check('homepage serves', home.status === 200 && /Irish Visa/i.test(home.text), 'HTTP ' + home.status);
check('homepage is HTML', home.type.includes('text/html'), home.type);
check('homepage is never cached', /no-store/i.test(home.cacheControl), home.cacheControl);

const comparisonRoute = await get('/comparison', { redirect: 'manual' });
check('comparison route redirects to method section', comparisonRoute.status === 301 && /\/about#method/.test(comparisonRoute.location), 'HTTP ' + comparisonRoute.status);

const vacRoute = await get('/vac-transit', { redirect: 'manual' });
check('vac-transit route redirects to help', vacRoute.status === 301 && /\/help#vac/.test(vacRoute.location), 'HTTP ' + vacRoute.status);

const statusPage = await get('/status');
check('data status page serves', statusPage.status === 200 && /Data status/i.test(statusPage.text), 'HTTP ' + statusPage.status);

const authStatus = await get('/api/auth/me');
check('removed auth route is not served', authStatus.status === 404, 'HTTP ' + authStatus.status);

const workspace = await get('/workspace');
check('removed workspace route is not served', workspace.status === 404, 'HTTP ' + workspace.status);

const missing = await get('/__smoke_missing_page__');
check('unknown route returns the custom 404 body', missing.status === 404 && /Page not found/i.test(missing.text), 'HTTP ' + missing.status + ', ' + missing.text.length + ' bytes');
check('custom 404 does not redirect', !missing.location, missing.location || 'no Location');

const reserved404 = await get('/404.html');
check('reserved 404 path still returns the custom body', reserved404.status === 404 && /Page not found/i.test(reserved404.text), 'HTTP ' + reserved404.status + ', ' + reserved404.text.length + ' bytes');

const buildInfo = await get('/build-info.json');
check('build marker serves', buildInfo.status === 200 && buildInfo.json && typeof buildInfo.json.commit === 'string', 'HTTP ' + buildInfo.status);
if (EXPECT_COMMIT) {
  check('build marker matches this commit', buildInfo.json && buildInfo.json.commit === EXPECT_COMMIT, buildInfo.json && buildInfo.json.commit);
}

const manifest = await get('/manifest.json');
check('manifest serves', manifest.status === 200 && manifest.json && Array.isArray(manifest.json.icons) && manifest.json.icons.length > 0, 'HTTP ' + manifest.status);

const sw = await get('/sw.js');
check('service worker serves', sw.status === 200 && /addEventListener/.test(sw.text), 'HTTP ' + sw.status);
check('service worker is JavaScript', sw.type.includes('javascript'), sw.type);
check('service worker has no fetch cache', !/caches\.open|respondWith/.test(sw.text), 'no Cache Storage use');
check('service worker is never cached', /no-store/i.test(sw.cacheControl), sw.cacheControl);

const appScript = await get('/scripts/index-sw.js');
check('app script is never cached', appScript.status === 200 && /no-store/i.test(appScript.cacheControl), appScript.cacheControl);

const icon = await get('/icon-192.png');
check('manifest icon serves', icon.status === 200 && icon.type.includes('image/png'), 'HTTP ' + icon.status + ' ' + icon.type);

const search = await get('/api/search');
check('search API serves', search.status === 200 && search.json && Array.isArray(search.json.modes), 'HTTP ' + search.status);
check('search API is never cached', /no-store/i.test(search.cacheControl), search.cacheControl);

const report = await get('/api/reports/monthly?month=' + encodeURIComponent(MONTH));
check('monthly report API serves', report.status === 200 && report.json && report.json.success === true, 'HTTP ' + report.status);

const preview = await get('/api/digest/preview?month=' + encodeURIComponent(MONTH));
check('digest preview API serves', preview.status === 200 && preview.json && preview.json.success === true, 'HTTP ' + preview.status);

const data = await get('/data/data_manifest.json');
check('data manifest serves', data.status === 200 && data.json && Array.isArray(data.json.offices), 'HTTP ' + data.status);
check('data manifest is never cached', /no-store/i.test(data.cacheControl), data.cacheControl);

const openData = await get('/data');
check('open data landing page serves', openData.status === 200 && /Reuse and citation/i.test(openData.text) && /"@type": "Dataset"/.test(openData.text), 'HTTP ' + openData.status);

const monthly = await get('/monthly-report');
check('monthly report serves static figures', monthly.status === 200 && /id="summary-cards"/.test(monthly.text) && !/Loading the official files/.test(monthly.text), 'HTTP ' + monthly.status);

const archive = await get('/monthly-report/2026-10');
check('monthly archive serves', archive.status === 200 && /Monthly report archive/i.test(archive.text), 'HTTP ' + archive.status);

console.log('\n' + (failures === 0 ? 'Post-deploy smoke check passed.' : failures + ' post-deploy check(s) failed.'));
process.exitCode = failures === 0 ? 0 : 1;
