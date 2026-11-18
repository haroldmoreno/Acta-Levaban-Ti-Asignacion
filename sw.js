/* ============================================================
   sw.js | Service Worker · Acta de Tecnología Levapan
   ------------------------------------------------------------
   Permite instalar la aplicación y abrirla sin conexión con el
   último código descargado. Las consultas /api/ siempre van a la
   red: el inventario y las actas necesitan el servidor local.
   ============================================================ */

const CACHE = "acta-levapan-v10";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/style.css",
  "/js/inventario-storage.js",
  "/js/firmas.js",
  "/js/pdf-lib.min.js",
  "/js/pwa.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/images/ico-levadesk.ico",
  "/images/logo-levadesk.png",
  "/images/fondo-poster.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((claves) =>
        Promise.all(
          claves.filter((clave) => clave !== CACHE).map((clave) => caches.delete(clave))
        )
      )
      .then(() => self.clients.claim())
  );
});

/** Red primero: mantiene el código actualizado y cachea para uso offline. */
async function redPrimero(request) {
  try {
    const respuesta = await fetch(request);
    if (respuesta && respuesta.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, respuesta.clone());
    }
    return respuesta;
  } catch (err) {
    const cache = await caches.open(CACHE);
    const guardada =
      (await cache.match(request)) ||
      (await cache.match("/index.html")) ||
      (await cache.match("/"));
    if (guardada) return guardada;
    throw err;
  }
}

/** Caché primero para imágenes y recursos estáticos. */
async function cachePrimero(request) {
  const cache = await caches.open(CACHE);
  const guardada = await cache.match(request);
  if (guardada) return guardada;

  const respuesta = await fetch(request);
  if (respuesta && respuesta.ok) cache.put(request, respuesta.clone());
  return respuesta;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // La API y el video siempre van directo a la red (el video usa Range).
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    return;
  }

  const esNavegacion = request.mode === "navigate";
  const esCodigo =
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css") ||
    url.pathname === "/";

  event.respondWith(
    esNavegacion || esCodigo ? redPrimero(request) : cachePrimero(request)
  );
});
