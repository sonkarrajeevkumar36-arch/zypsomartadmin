// Scripts for Firebase Cloud Messaging in Service Worker
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Initialize the Firebase app in the service worker
firebase.initializeApp({
  apiKey: "AIzaSyDxztzPoCTCzckaEsvupHJOyCHEhAxr9DU",
  authDomain: "zypso-mart-cd989.firebaseapp.com",
  projectId: "zypso-mart-cd989",
  storageBucket: "zypso-mart-cd989.firebasestorage.app",
  messagingSenderId: "91046649188",
  appId: "1:91046649188:web:0472d26bc617a5396f2e71"
});

const messaging = firebase.messaging();

// Handle background messages when app is in background or completely closed
messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background push message:', payload);
  const data = payload.data || {};
  const notificationTitle = "🚨 NEW ORDER";
  const orderId = data.orderId || "";
  const customerName = data.customerName || "Customer";
  const total = data.total ? `₹${data.total}` : "";

  const bodyText = payload.notification?.body || data.body || 
    `Order #${orderId} • ${customerName} • ${total}`;

  const targetUrl = data.url || `/?orderId=${encodeURIComponent(orderId)}&tab=orders`;

  const notificationOptions = {
    body: bodyText,
    icon: '/pwa-192x192.png',
    badge: '/favicon.png',
    tag: `new-order-${orderId || Date.now()}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500],
    data: {
      url: targetUrl,
      orderId: orderId,
      customerName: customerName,
      total: data.total
    },
    actions: [
      { action: 'view', title: '👀 View Order' },
      { action: 'accept', title: '✅ Accept Order' }
    ]
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Fallback push event handler for direct webpush or custom backend payloads
self.addEventListener('push', (event) => {
  if (!event.data) return;

  try {
    const raw = event.data.json();
    const notification = raw.notification || {};
    const data = raw.data || raw;

    const title = "🚨 NEW ORDER";
    const orderId = data.orderId || "";
    const customer = data.customerName || "Customer";
    const total = data.total ? `₹${data.total}` : "";
    const targetUrl = data.url || `/?orderId=${encodeURIComponent(orderId)}&tab=orders`;

    const body = notification.body || data.body || `Order #${orderId} • ${customer} • ${total}`;

    const options = {
      body: body,
      icon: '/pwa-192x192.png',
      badge: '/favicon.png',
      tag: `new-order-${orderId || Date.now()}`,
      renotify: true,
      requireInteraction: true,
      silent: false,
      vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500],
      data: {
        url: targetUrl,
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
    console.warn('[firebase-messaging-sw.js] Push JSON parse fallback:', err);
    event.waitUntil(
      self.registration.showNotification("🚨 NEW ORDER", {
        body: event.data.text() || "New order received! Open dashboard to view.",
        icon: '/pwa-192x192.png',
        badge: '/favicon.png',
        tag: 'new-order-alert',
        requireInteraction: true,
        vibrate: [500, 200, 500, 200, 1000, 200, 500, 200, 500]
      })
    );
  }
});

// Handle Notification click (View Order or Accept Order)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const targetUrl = notificationData.url || '/?tab=orders';

  if (event.action === 'accept' && notificationData.orderId) {
    // Direct accept action from notification button
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
    // Default click or 'view' action
    event.waitUntil(openOrFocusClient(targetUrl));
  }
});

function openOrFocusClient(urlToOpen) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
    // If a window is already open, focus it and navigate
    for (const client of windowClients) {
      if ('focus' in client) {
        if ('navigate' in client) {
          client.navigate(urlToOpen);
        }
        return client.focus();
      }
    }
    // Otherwise open a new window when app was closed
    if (clients.openWindow) {
      return clients.openWindow(urlToOpen);
    }
  });
}
