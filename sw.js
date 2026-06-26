// SPACE — минимальный service worker.
// Нужен только для того, чтобы браузер считал сайт «устанавливаемым»
// (PWA-критерии большинства браузеров требуют зарегистрированный SW
// для появления предложения «Установить на рабочий стол»).
// Кэширования и офлайн-режима здесь намеренно нет — приложению всегда
// нужны свежие данные из Firestore.

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// Прозрачный проход всех запросов напрямую в сеть.
self.addEventListener('fetch', () => {});
