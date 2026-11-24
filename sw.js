/* ============================================================
   sw.js | Service Worker · Acta de Tecnología Levapan
   ------------------------------------------------------------
   Network-First para el código (.js y .html) y las navegaciones:
   cada recarga pide la versión más reciente al servidor y solo
   usa la caché si no hay red. Las imágenes y recursos estáticos
   usan Cache-First. /api/ y /media/ siempre van directo a la red.
   ============================================================ */

const CACHE = "acta-levapan-v22";

const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/css/style.css",
  "/css/workspace.css",
  "/js/auth.js",
  "/js/inventario-storage.js",
  "/js/workspace.js",
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

  // NUNCA se cachea la API: sesión, inventario y actas deben ser en vivo.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/media/")) {
    return;
  }

  // Código y navegaciones: Network-First para reflejar los cambios al recargar.
  const esNavegacion = request.mode === "navigate";
  const esCodigo =
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".css") ||
    url.pathname === "/";

  event.respondWith(
    esNavegacion || esCodigo ? redPrimero(request) : cachePrimero(request)
  );
});
