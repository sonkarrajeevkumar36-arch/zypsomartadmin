// Zypso Mart Service Worker - Offline Caching & PWA Support
const CACHE_NAME = 'zypsomart-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  '/logo.jpg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/new_order_alarm.mp3',
];

// Install event - precache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('[SW] Core precache partial fallback:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate event - purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - cache first for static assets, network first for navigation, skip Firebase & API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Exclude API calls and Firebase auth/firestore endpoints from service worker caching
  if (
    url.pathname.startsWith('/api/') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('identitytoolkit.googleapis.com') ||
    url.hostname.includes('securetoken.googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Handle SPA navigation
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match('/index.html') || caches.match('/');
      })
    );
    return;
  }

  // Cache-first for images, fonts, icons, stylesheets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached and fetch in background to update
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || (networkResponse.type !== 'basic' && networkResponse.type !== 'cors')) {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => {
        // Offline fallback if applicable
        if (event.request.destination === 'image') {
          return caches.match('/logo.png');
        }
      });
    })
  );
});

// Push notification listener for background/closed app state
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const raw = event.data.json();
    const notification = raw.notification || {};
    const data = raw.data || raw;

    const title = notification.title || data.title || "🚨 NEW ZYPSOMART ORDER";
    const orderId = data.orderId || "";
    const customer = data.customerName || "Customer";
    const total = data.total ? `₹${data.total}` : "";

    const body = notification.body || data.body || `Order #${orderId} • ${customer} • ${total}`;

    const options = {
      body: body,
      icon: '/pwa-192x192.png',
      badge: '/favicon.png',
      tag: `new-order-${orderId || Date.now()}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [300, 150, 300, 150, 600],
      data: {
        url: data.url || `/?orderId=${orderId}&tab=orders`,
        orderId: orderId,
        customerName: customer,
        total: data.total
      },
      actions: [
        { action: 'view', title: '👀 View Order' },
        { action: 'accept', title: '✅ Accept Order' }
      ]
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    event.waitUntil(
      self.registration.showNotification("🚨 NEW ZYPSOMART ORDER", {
        body: event.data.text() || "New order received! Open dashboard to view.",
        icon: '/pwa-192x192.png',
        badge: '/favicon.png',
        tag: 'new-order-alert',
        requireInteraction: true,
        vibrate: [300, 150, 300, 150, 600]
      })
    );
  }
});

// Notification click handling
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || '/?tab=orders';

  if (event.action === 'accept' && notificationData.orderId) {
    const acceptPromise = fetch(`/api/orders/${encodeURIComponent(notificationData.orderId)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'accepted',
        notes: 'Accepted directly from background push notification'
      })
    })
      .catch((err) => console.error('[SW] Direct accept error:', err))
      .then(() => openOrFocusClient(targetUrl));

    event.waitUntil(acceptPromise);
  } else {
    event.waitUntil(openOrFocusClient(targetUrl));
  }
});

function openOrFocusClient(urlToOpen) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    for (const client of windowClients) {
      if ('focus' in client) {
        if ('navigate' in client) {
          client.navigate(urlToOpen);
        }
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(urlToOpen);
    }
  });
}

