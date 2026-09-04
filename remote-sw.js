/* CABLE 82 remote control: the service worker that lets a phone install it.
   Its scope is remote-control and nothing else: the display at / and the
   control room at /config are never controlled by it, so the set's own
   self-update (a reload when the server names a new build) is untouched.
   Network first, always: with the server up the remote is exactly as fresh
   as a browser tab; with the server down the last shell comes out of the
   cache and the status line says the server cannot be reached. The tuner
   bus is never cached: a stale "one set is listening" would be a lie. */
const CACHE = "cable82-remote";
const SHELL = ["remote-control", "remote-control.css", "remote-control.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // live, never cached
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || Response.error()))
  );
});
