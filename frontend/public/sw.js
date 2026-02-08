// Service Worker for Remote Claude
// Required for notifications on Android Chrome (new Notification() doesn't work there)

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Focus the app window or open it
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })
  );
});

// Activate immediately, claim all clients
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
