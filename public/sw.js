// Service Worker for Remote Claude
// Handles push notifications (for background delivery) and notification clicks

self.addEventListener('push', (event) => {
  if (!event.data) return;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If any client tab is visible, skip — the page handles it via WebSocket
      const hasVisible = clients.some(c => c.visibilityState === 'visible');
      if (hasVisible) return;

      let payload;
      try {
        payload = event.data.json();
      } catch {
        payload = { title: 'Remote Claude', body: event.data.text() };
      }

      const urgent = !!payload.urgent;
      const icon = urgent ? '\u26A0\uFE0F' : '\u2705';
      const iconUrl =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">' +
        encodeURIComponent(icon) +
        '</text></svg>';

      return self.registration.showNotification(payload.title || 'Remote Claude', {
        body: payload.body || '',
        icon: iconUrl,
        tag: payload.tag || 'rc-push',
        requireInteraction: urgent,
        vibrate: urgent ? [200, 100, 200, 100, 200] : [200],
      });
    })
  );
});

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
