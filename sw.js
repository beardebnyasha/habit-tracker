/**
 * sw.js — SERVICE WORKER (офлайн-режим и установка на телефон).
 *
 * Стратегия:
 *   • HTML-навигация  — network-first: пользователь всегда получает свежую
 *     версию, а без сети открывается копия из кэша;
 *   • остальные файлы — cache-first: приложение стартует мгновенно и офлайн.
 *
 * ВАЖНО: при изменении файлов приложения поднимите номер в CACHE_VERSION,
 * иначе браузер продолжит отдавать старые копии из кэша.
 */

const CACHE_VERSION = 'kpd-v1';

/** Оболочка приложения — то, без чего интерфейс не запустится. */
const APP_SHELL = [
  './',
  './index.html',
  './css/styles.css',
  './js/ui.js',
  './js/core.js',
  './js/storage.js',
  './js/notifier.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

/** Установка: складываем оболочку в кэш. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

/** Активация: удаляем кэши прошлых версий и забираем управление страницей. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

/** Перехват запросов. */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // сторонние ресурсы не трогаем

  // Навигация: сначала сеть, при сбое — кэш.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html').then((cached) => cached || caches.match('./'))),
    );
    return;
  }

  // Остальное: сначала кэш, при промахе — сеть (и сразу кладём в кэш).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

/** Напоминания приходят из notifier.js, service worker их не дублирует. */
