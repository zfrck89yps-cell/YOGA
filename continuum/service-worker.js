const CACHE = "continuum-yoga-hike-shell-v5";
const RUNTIME = "continuum-yoga-hike-runtime-v5";

// Never cache the HTML document — always fetch fresh so Vite's injected
// HMR script tags don't get locked in and break the app after a server restart.
const SHELL = [
  "./styles.css",
  "./app.js",
  "./utils/assets.js",
  "./logic/decision-engine.js",
  "./logic/flow-engine.js",
  "./logic/progression-engine.js",
  "./logic/safety-guards.js",
  "./logic/stage-profiles.v1.js",
  "./logic/transition-engine.js",
  "./logic/transition-flows.v1.js",
  "./assets/icons/yoga-home-background.jpeg",
  "./assets/icons/yoga-session-background.jpeg",
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/icon-512.png"
];

// Data files: network-first so image paths are always up to date.
const DATA_SUFFIXES = ["/data/pose_meta.json", "/data/asset_index.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs.
  if (url.origin !== location.origin || req.method !== "GET") return;

  // Let HTML navigation go straight to network — never serve cached HTML.
  if (req.destination === "document" || url.pathname === "/" || url.pathname.endsWith(".html")) return;

  // Network-first for JSON data files.
  if (DATA_SUFFIXES.some((s) => url.pathname.endsWith(s))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res?.ok) caches.open(RUNTIME).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for JS, CSS, images.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res?.ok) caches.open(RUNTIME).then((c) => c.put(req, res.clone()));
        return res;
      });
    })
  );
});
