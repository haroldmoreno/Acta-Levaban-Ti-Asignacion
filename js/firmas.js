/* ============================================================
   firmas.js | Acta de Tecnología - Levapan
   ------------------------------------------------------------
   Firmas digitales dibujadas con ratón, lápiz o pantalla táctil.

   API pública:
     window.FirmasActa.inicializar()
     window.FirmasActa.limpiar(canvasId)
     window.FirmasActa.limpiarTodas()
     window.FirmasActa.estaVacia(canvasId)
     window.FirmasActa.obtenerDataUrl(canvasId) -> PNG en blanco o null
   ============================================================ */

(function () {
  "use strict";

  const ANCHO = 1000;
  const ALTO = 340;
  const COLOR_TRAZO = "#171b23";
  const GROSOR = 4.5;

  /** Devuelve el canvas y su contenedor visual. */
  function obtenerElementos(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;
    const lienzo = canvas.closest(".lienzo-firma");
    return { canvas, lienzo };
  }

  /** Contexto 2D configurado para trazos suaves. */
  function contexto(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = COLOR_TRAZO;
    ctx.lineWidth = GROSOR;
    return ctx;
  }

  /** Posición del puntero en coordenadas internas del canvas. */
  function posicion(canvas, evento) {
    const rect = canvas.getBoundingClientRect();
    const escalaX = canvas.width / (rect.width || canvas.width);
    const escalaY = canvas.height / (rect.height || canvas.height);
    return {
      x: (evento.clientX - rect.left) * escalaX,
      y: (evento.clientY - rect.top) * escalaY,
    };
  }

  function marcarFirmado(canvas, lienzo, firmado) {
    canvas.dataset.firmado = firmado ? "true" : "false";
    if (lienzo) lienzo.classList.toggle("firmado", firmado);
  }

  function limpiarCanvas(canvas, lienzo) {
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    marcarFirmado(canvas, lienzo, false);
  }

  /** Conecta los eventos de dibujo de un canvas. */
  function prepararCanvas(canvas) {
    if (!canvas || canvas.dataset.firmasListo === "true") return;

    canvas.width = ANCHO;
    canvas.height = ALTO;

    const lienzo = canvas.closest(".lienzo-firma");
    const ctx = contexto(canvas);
    if (!ctx) return;

    let dibujando = false;
    let ultimoPunto = null;

    const iniciar = (evento) => {
      if (evento.button !== undefined && evento.button > 0) return;
      if (evento.pointerType === "mouse" && evento.buttons === 0) return;
      evento.preventDefault();

      dibujando = true;
      ultimoPunto = posicion(canvas, evento);

      if (typeof canvas.setPointerCapture === "function") {
        try {
          canvas.setPointerCapture(evento.pointerId);
        } catch (err) {
          /* Algunos navegadores no permiten capturar el puntero. */
        }
      }
    };

    const trazar = (evento) => {
      if (!dibujando || !ultimoPunto) return;
      evento.preventDefault();

      const punto = posicion(canvas, evento);
      ctx.beginPath();
      ctx.moveTo(ultimoPunto.x, ultimoPunto.y);
      ctx.lineTo(punto.x, punto.y);
      ctx.stroke();
      ultimoPunto = punto;

      if (canvas.dataset.firmado !== "true") marcarFirmado(canvas, lienzo, true);
    };

    const terminar = () => {
      dibujando = false;
      ultimoPunto = null;
    };

    canvas.addEventListener("pointerdown", iniciar);
    canvas.addEventListener("pointermove", trazar);
    canvas.addEventListener("pointerup", terminar);
    canvas.addEventListener("pointercancel", terminar);
    canvas.addEventListener("pointerleave", terminar);
    canvas.addEventListener("contextmenu", (evento) => evento.preventDefault());

    limpiarCanvas(canvas, lienzo);
    canvas.dataset.firmasListo = "true";
  }

  function inicializar() {
    document.querySelectorAll("canvas.canvas-firma").forEach(prepararCanvas);

    document.querySelectorAll("[data-limpiar]").forEach((boton) => {
      if (boton.dataset.limpiarListo === "true") return;
      const destino = boton.getAttribute("data-limpiar");
      boton.addEventListener("click", () => limpiar(destino));
      boton.dataset.limpiarListo = "true";
    });
  }

  function limpiar(canvasId) {
    const elementos = obtenerElementos(canvasId);
    if (!elementos) return;
    limpiarCanvas(elementos.canvas, elementos.lienzo);
  }

  function limpiarTodas() {
    document
      .querySelectorAll("canvas.canvas-firma")
      .forEach((canvas) => limpiarCanvas(canvas, canvas.closest(".lienzo-firma")));
  }

  function estaVacia(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return true;
    return canvas.dataset.firmado !== "true";
  }

  /**
   * Devuelve la firma como PNG con fondo blanco (lista para el PDF) o null
   * cuando el recuadro está vacío.
   */
  function obtenerDataUrl(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas || estaVacia(canvasId)) return null;

    const salida = document.createElement("canvas");
    salida.width = canvas.width;
    salida.height = canvas.height;
    const ctx = salida.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, salida.width, salida.height);
    ctx.drawImage(canvas, 0, 0);

    try {
      return salida.toDataURL("image/png");
    } catch (err) {
      console.warn("No se pudo exportar la firma:", err);
      return null;
    }
  }

  window.FirmasActa = {
    inicializar,
    limpiar,
    limpiarTodas,
    estaVacia,
    obtenerDataUrl,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", inicializar);
  } else {
    inicializar();
  }
})();
