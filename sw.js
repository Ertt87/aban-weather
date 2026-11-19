const CACHE_NAME = 'aban-weather-v4-shell-v4';

const PRECACHE_ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/physics.js',
  './js/ensemble.js',
  './js/api.js',
  './js/storage.js',
  './js/charts.js',
  './manifest.webmanifest',
  './assets/icon.svg',
];

const WEATHER_API_HOSTS = new Set([
  'weather.googleapis.com',
  'api.open-meteo.com',
  'previous-runs-api.open-meteo.com',
  'ensemble-api.open-meteo.com',
  'seasonal-api.open-meteo.com',
  'archive-api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'api.met.no',
]);

self.addEventListener('install', (event) => {
  // `cache: 'reload'` bypasses the HTTP cache: the ES modules import each other by name, so a
  // precache that mixes fresh and stale files breaks the whole app ("module does not provide an export").
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
  );
  // Controlled update: wait for client SKIP_WAITING message when an active controller exists
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((oldKey) => caches.delete(oldKey))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Skip cross-origin embeds/iframes (Windy) and pass through weather APIs directly
  if (request.destination === 'iframe' || url.hostname.endsWith('windy.com')) {
    return;
  }
  if (WEATHER_API_HOSTS.has(url.hostname) || url.origin !== self.location.origin) {
    return;
  }

  // Same-origin local shell & ES modules: Stale-While-Revalidate
  // Revalidate against the server (not the HTTP cache) so all modules refresh as one consistent set
  const networkPromise = fetch(request, { cache: 'no-cache' })
    .then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  event.waitUntil(networkPromise);

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request, { ignoreSearch: true });
      if (cached) return cached;

      const networkResponse = await networkPromise;
      if (networkResponse) return networkResponse;

      if (request.mode === 'navigate') {
        const fallback = await cache.match('./index.html');
        if (fallback) return fallback;
      }

      return new Response('Офлайн: ресурс не найден в кэше.', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })
  );
});
