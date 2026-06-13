self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'Coupe du Monde 2026';
  const options = {
    body: data.body || 'N\'oublie pas tes pronostics !',
    icon: 'https://flagcdn.com/w40/us.png',
    badge: 'https://flagcdn.com/w20/us.png',
    tag: 'pronostics-reminder',
    renotify: true,
    data: { url: self.location.origin }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url || '/'));
});
