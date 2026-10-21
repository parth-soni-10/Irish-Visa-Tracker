/* Irish Visa Tracker — offline shell.
 *
 * The cache name carries a build token that tools/deploy-pages.mjs rewrites to
 * `<token>-<content hash>` when it stages the upload (`--sw-cache visa-app-v1`),
 * so a deploy always supersedes the previous cache. A new worker installs and
 * WAITS: the page shows "Update available → Reload" and only then posts
 * SKIP_WAITING, so a visitor is never swapped onto new code mid-read.
 *
 * Data files are network-first with a cache fallback. They are the point of the
 * site and change every ~30 minutes, so the network is the truth whenever it
 * answers; the cached copy is what keeps the last-known numbers readable when it
 * does not (the page carries its own "showing data from …" banner for that).
 */
var CACHE = 'visa-app-v1';
var SHELL = [
  './',
  './styles.css',
  './app.js',
  './core.js',
  './components.js',
  './hairline/kernel.js',
  './hairline/mount.js',
  './hairline/runway.js',
  './theme-init.js',
  './icon.svg',
  './fonts/inter-latin.woff2',
  './fonts/geist-sans.woff2',
  './fonts/geist-mono.woff2'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return cache.addAll(SHELL).catch(function () { /* a missing font must not fail the install */ });
  }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
      return caches.delete(key);
    }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (event) {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.indexOf('/data/') !== -1) {
    // Numbers change every half hour: network first, cache only as a fallback.
    event.respondWith(fetch(request).then(function (response) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
      return response;
    }).catch(function () {
      return caches.match(request).then(function (hit) {
        return hit || new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      });
    }));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(function () {
      return caches.match('./').then(function (hit) { return hit || caches.match('./index.html'); });
    }));
    return;
  }

  // Fonts are the one thing whose bytes only change when the typeface does, so
  // they are cache-first. Everything else (the app modules, the stylesheet) is
  // network-first with the cache as the offline fallback: a cache-first shell is
  // how a deployed fix keeps being answered by the copy in the visitor's
  // browser — measured here, where an edited module was still served from the
  // previous cache until the worker was unregistered.
  if (url.pathname.indexOf('/fonts/') !== -1) {
    event.respondWith(caches.match(request).then(function (hit) {
      return hit || fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        return response;
      });
    }));
    return;
  }

  event.respondWith(fetch(request).then(function (response) {
    var copy = response.clone();
    caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
    return response;
  }).catch(function () {
    return caches.match(request);
  }));
});
