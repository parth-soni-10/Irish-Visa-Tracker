const CACHE_NAME = 'irish-visa-tracker-v3';
const STATIC_ASSETS = [
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .catch(error => console.warn('[SW] Static cache skipped:', error && error.message))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never cache API responses: auth, watchlists and decision data must always
  // come from the network, and a cached /api/auth/me would leak one account's
  // session state into another page load.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  // Decision data changes every scrape; never serve a cached copy.
  if (url.pathname.startsWith('/data/')) return;

  // Navigations are network-first so a deploy is visible immediately; the
  // cached shell is only the offline fallback.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put('/', copy));
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        event.waitUntil(
          fetch(event.request)
            .then(response => {
              if (response.ok) {
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
              }
            })
            .catch(() => {})
        );
        return cached;
      }

      return fetch(event.request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => new Response('Offline', { status: 503, statusText: 'Service Unavailable' }));
    })
  );
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Irish Visa Tracker';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'A watched application has an update.',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    data: data.data || { url: '/' },
    actions: Array.isArray(data.actions) ? data.actions : [],
    requireInteraction: Boolean(data.requireInteraction),
    tag: data.tag || 'irish-visa-decision'
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url === target && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', event => {
  // The page re-subscribes and POSTs the fresh endpoint when it next opens.
  event.waitUntil(Promise.resolve());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
