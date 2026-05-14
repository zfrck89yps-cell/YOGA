const CACHE = "continuum-yoga-hike-shell-v4";
const RUNTIME = "continuum-yoga-hike-runtime-v4";

const SHELL = [
  "./",
  "./index.html",
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

// Data files use network-first so the app always gets fresh paths/content.
const DATA = [
  "./data/pose_meta.json",
  "./data/asset_index.json",
];

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
        keys.filter((key) => ![CACHE, RUNTIME].includes(key)).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || req.method !== "GET") return;

  // Network-first for data JSON files — never serve stale paths from cache.
  if (DATA.some((p) => url.pathname.endsWith(p.replace(".", "")))) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (app shell + images).
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
