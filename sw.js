/*
 * Push notifications only.
 *
 * This worker deliberately has no fetch handler and no Cache Storage: pages,
 * scripts, styles and data always go to the network, so the next deployment is
 * visible on the next load. Older versions cached the shell and assets; those
 * caches are deleted when this version activates.
 */
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(cacheNames => Promise.all(cacheNames.map(name => caches.delete(name))))
      .then(() => self.clients.claim())
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
