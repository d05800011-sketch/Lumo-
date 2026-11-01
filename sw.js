// Lumo — service worker.
// Нужен для установки как приложения (PWA) и для показа системных уведомлений.
// Фоновые push-сообщения при закрытом приложении здесь не настроены (см. README).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Клик по уведомлению: открыть или сфокусировать окно Lumo
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chatId = event.notification.data && event.notification.data.chatId;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.postMessage({ type: "open-chat", chatId });
          return client.focus();
        }
      }
      return self.clients.openWindow("./");
    })
  );
});
