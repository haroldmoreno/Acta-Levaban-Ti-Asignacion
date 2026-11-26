/* Levapan TI PWA — Network-First para estáticos, Network-Only para Supabase/Auth. */
const CACHE = "levapan-ti-v21-fullwidth-boxes-accordion";
const SHELL = ["./", "./index.html", "./css/styles.css", "./js/config.js", "./js/app.js", "./js/asistente-ti.js", "./js/acta-pdf.js", "./template.pdf", "./manifest.json", "./assets/icon.svg", "./assets/logo.svg", "./assets/fondo.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((claves) => Promise.all(claves.filter((c) => c !== CACHE).map((c) => caches.delete(c)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // OAuth / Supabase / Microsoft: jamás se interceptan ni se sirven desde caché.
  if (
    url.searchParams.has("code") ||
    url.searchParams.has("error") ||
    url.hash.includes("access_token") ||
    url.hostname.endsWith("supabase.co") ||
    url.hostname.endsWith("login.microsoftonline.com") ||
    url.pathname.includes("/auth/") ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copia = resp.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copia));
          }
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
  }
});
