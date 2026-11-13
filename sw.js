// SPDX-License-Identifier: GPL-3.0-only
// FM-1 Lite's service worker: the app works offline, and every firmware played once is kept for offline use.
// App files: cache first, refreshed in the background. Firmwares and the catalogue: network first, cache when offline.
const SHELL = "fm1lite-shell-v2", FW = "fm1lite-firmware";
const FILES = ["./", "index.html", "style.css", "app.js", "worklet.js", "catalog.json", "manifest.webmanifest", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL && k !== FW).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req.url, r.clone());
    return r;
  } catch {
    const hit = await c.match(req.url);
    if (hit) return hit;
    throw new Error("offline");
  }
}
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.endsWith(".wasm")) { e.respondWith(networkFirst(e.request, FW)); return; }
  if (url.origin !== location.origin) return;
  if (url.pathname.endsWith("catalog.json")) { e.respondWith(networkFirst(e.request, SHELL)); return; }
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => null);
    return hit || (await net) || Response.error();
  }));
});
