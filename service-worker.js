"use strict";

const APP_CACHE = "luach-dashboard-shell-v2";
const DATA_CACHE = "luach-dashboard-data-v1";

const APP_SHELL = [
  "./",
  "./index.html",
  "./dashboard.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith("luach-dashboard-") && ![APP_CACHE, DATA_CACHE].includes(key))
        .map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Hebcal data: prefer fresh network data, but preserve the exact last
  // successful response for the same URL as an offline fallback.
  if (url.origin === "https://www.hebcal.com") {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Navigation requests: use the network when available so deployed updates
  // appear promptly, then fall back to the cached app shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(APP_CACHE);
            cache.put("./index.html", response.clone());
          }
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Static app assets: prefer the network so deployed updates appear promptly,
  // while retaining the cached copy for offline use.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request, APP_CACHE));
  }
});
