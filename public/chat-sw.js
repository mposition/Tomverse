/* Cache only the public offline shell. Account pages, API results and files stay on the network. */
const CACHE = "tomverse-chat-shell-v1";
const SHELL = ["/chat-offline.html", "/chat-offline.js", "/chat-offline.css", "/pwa/icon-192.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("tomverse-chat-shell-") && key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((cached) => cached || fetch(event.request)));
  } else if (event.request.mode === "navigate" && /^\/(?:[a-z]{2}\/)?chat(?:\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.open(CACHE).then((cache) => cache.match("/chat-offline.html"))));
  }
});
