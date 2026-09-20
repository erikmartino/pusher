const CACHE_NAME = 'pusher-v5';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/favicon.ico',
  './icons/favicon-16x16.png',
  './icons/favicon-32x32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  './icons/icon-maskable-192x192.png',
  './icons/icon-maskable-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Fetch fresh copy in background to update cache
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    }).catch(() => caches.match('./index.html'))
  );
});

// Push notification received (Pure PWA grouping & aggregation)
self.addEventListener('push', (event) => {
  let data = { title: 'Pusher 🔴', body: 'The button was pushed!' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  const tag = data.tag || 'dk.profundo.pusher.push';

  event.waitUntil(
    self.registration.getNotifications({ tag }).then((notifications) => {
      let count = 1;
      let history = [];

      if (notifications && notifications.length > 0) {
        const active = notifications[0];
        if (active.data && typeof active.data.count === 'number') {
          count = active.data.count + 1;
        } else {
          count = 2;
        }
        if (active.data && Array.isArray(active.data.history)) {
          history = [...active.data.history];
        }
      }

      if (data.body) {
        history.push(data.body);
      }
      if (history.length > 3) {
        history = history.slice(-3);
      }

      let title = data.title || 'Pusher 🔴';
      let body = data.body;

      if (count > 1) {
        title = `Pusher 🔴 (${count} pushes)`;
        body = history.join('\n');
      }

      return self.registration.showNotification(title, {
        body: body,
        icon: './icons/icon-192x192.png',
        badge: './icons/favicon-32x32.png',
        tag: tag,
        renotify: data.renotify !== undefined ? data.renotify : true,
        timestamp: data.timestamp || Date.now(),
        vibrate: [150, 50, 150],
        data: {
          url: data.url || './',
          count: count,
          history: history
        }
      });
    })
  );
});

// User clicked the notification
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || './';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(urlToOpen);
    })
  );
});
