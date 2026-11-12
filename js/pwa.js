/* ============================================================
   pwa.js | Instalación y service worker · Acta de Tecnología
   ============================================================ */

(() => {
  const esContextoSeguro =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

  function mostrarBotonInstalar(visible) {
    const boton = document.getElementById("btnInstalarApp");
    if (boton) boton.hidden = !visible;
  }

  function estaInstalada() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  /* ---------------- Service Worker ---------------- */

  if ("serviceWorker" in navigator && esContextoSeguro) {
    window.addEventListener("load", async () => {
      try {
        const registro = await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          updateViaCache: "none",
        });
        console.log("Service Worker registrado:", registro.scope);
      } catch (err) {
        console.warn("No se pudo registrar el Service Worker:", err);
      }
    });
  }

  /* ---------------- Instalación ---------------- */

  let promptDiferido = null;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    promptDiferido = event;
    if (!estaInstalada()) mostrarBotonInstalar(true);
  });

  window.addEventListener("appinstalled", () => {
    promptDiferido = null;
    mostrarBotonInstalar(false);
    console.log("Acta de Tecnología instalada como aplicación.");
  });

  document.addEventListener("click", async (event) => {
    const boton = event.target.closest("#btnInstalarApp");
    if (!boton) return;

    if (!promptDiferido) {
      alert(
        "Para instalar la aplicación abre esta página en Chrome o Edge desde " +
          "http://localhost:3000 y usa el botón de instalar del navegador."
      );
      return;
    }

    promptDiferido.prompt();
    const eleccion = await promptDiferido.userChoice.catch(() => ({}));
    if (eleccion.outcome === "accepted") {
      mostrarBotonInstalar(false);
    }
    promptDiferido = null;
  });

  if (estaInstalada()) mostrarBotonInstalar(false);

  // Si el navegador no ofrece instalación (por ejemplo HTTP en red), el
  // botón permanece oculto y la app se usa normalmente en el navegador.
})();
