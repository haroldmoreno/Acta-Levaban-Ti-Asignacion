/* ============================================================
   asistente-ti.js | Copiloto TI · Levapan
   ------------------------------------------------------------
   Widget flotante autónomo: obtiene el token exactamente igual
   que el resto del frontend (Supabase Auth + almacenamiento),
   consulta /api/asistente-ti y refleja los cambios en pantalla.
   ============================================================ */

(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);

  function escapar(valor) {
    return String(valor ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fecha(valor) {
    if (!valor) return "—";
    const d = new Date(valor);
    return Number.isNaN(d.getTime())
      ? "—"
      : d.toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "2-digit" });
  }

  function almacenSeguro(nombre) {
    try {
      return window[nombre] || null;
    } catch (err) {
      console.warn(`[Asistente TI] Acceso bloqueado a ${nombre}:`, err?.message || err);
      return null;
    }
  }

  function leerAlmacen(almacen, clave) {
    try {
      return almacen?.getItem(clave) || null;
    } catch (err) {
      console.warn(`[Asistente TI] lectura bloqueada de ${clave}:`, err?.message || err);
      return null;
    }
  }

  async function tokenDeAuthLevapan() {
    try {
      const token = await window.AuthLevapan?.token?.();
      if (token) return token;
    } catch (err) {
      console.warn("[Asistente TI] AuthLevapan.token() no disponible:", err?.message || err);
    }
    try {
      const cliente = window.AuthLevapan?.cliente;
      const { data } = await cliente?.auth?.getSession();
      if (data?.session?.access_token) return data.session.access_token;
    } catch (err) {
      console.warn("[Asistente TI] getSession() no disponible:", err?.message || err);
    }
    return "";
  }

  async function obtenerToken() {
    const token = await tokenDeAuthLevapan();
    if (token) return token;

    const almacenes = [almacenSeguro("localStorage"), almacenSeguro("sessionStorage")];
    const claves = ["acta-levapan-auth", "supabase.auth.token", "sb:token"];
    for (const almacen of almacenes) {
      for (const clave of claves) {
        let crudo = null;
        try {
          crudo = leerAlmacen(almacen, clave);
        } catch (err) {
          console.warn(`[Asistente TI] ${clave}:`, err?.message || err);
          continue;
        }
        if (!crudo) continue;
        try {
          const datos = JSON.parse(crudo);
          const tokenGuardado =
            datos?.access_token ||
            datos?.session?.access_token ||
            datos?.currentSession?.access_token;
          if (tokenGuardado) return tokenGuardado;
        } catch (err) {
          console.warn(`[Asistente TI] ${clave} no es JSON:`, err?.message || err);
        }
      }
    }
    return "";
  }

  async function api(ruta, opciones = {}) {
    const token = await obtenerToken();
    let respuesta;
    try {
      respuesta = await fetch(ruta, {
        cache: "no-store",
        credentials: "same-origin",
        ...opciones,
        headers: {
          Accept: "application/json",
          ...(opciones.headers || {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
    } catch (err) {
      const error = new Error(`RED: no se pudo conectar (${err?.message || err})`);
      error.status = 0;
      console.error("[Asistente TI] Error de red:", err);
      throw error;
    }

    const texto = await respuesta.text().catch(() => "");
    let datos = {};
    try {
      datos = texto ? JSON.parse(texto) : {};
    } catch {
      datos = { raw: texto };
    }

    if (!respuesta.ok || datos.ok === false) {
      const mensaje = datos.error || datos.message || texto || "sin detalle";
      const error = new Error(`HTTP ${respuesta.status}: ${mensaje}`);
      error.status = respuesta.status;
      error.detalle = datos;
      console.error(`[Asistente TI] ${ruta} → ${respuesta.status}`, datos);
      throw error;
    }
    return datos;
  }

  function burbuja(texto, quien) {
    const contenedor = byId("wsAsistenteMensajes");
    if (!contenedor) return null;
    const elemento = document.createElement("div");
    elemento.className = `ws-chat-burbuja ${quien}`;
    elemento.textContent = texto;
    contenedor.appendChild(elemento);
    contenedor.scrollTop = contenedor.scrollHeight;
    return elemento;
  }

  function tarjetaEquipo(equipo) {
    const tarjeta = document.createElement("div");
    tarjeta.className = "ws-chat-tarjeta";
    const placa = equipo.placa || equipo.serial || "—";
    const dato = (valor) => escapar(valor || "—");
    tarjeta.innerHTML = `
      <h4>${escapar(placa)}</h4>
      <dl>
        <dt>Nombre en red</dt><dd>${dato(equipo.nombre_equipo_red)}</dd>
        <dt>Responsable</dt><dd>${dato(equipo.responsable || equipo.usuario_asignado)}</dd>
        <dt>Cédula</dt><dd class="ws-mono">${dato(equipo.cedula_responsable || equipo.usuario_cedula)}</dd>
        <dt>Empresa</dt><dd>${dato(equipo.empresa)}</dd>
        <dt>Sede</dt><dd>${dato(equipo.sede)}</dd>
        <dt>CECO</dt><dd class="ws-mono">${dato(equipo.ceco)}</dd>
        <dt>Área</dt><dd>${dato(equipo.area)}</dd>
        <dt>Estado</dt><dd>${dato(equipo.estado)}</dd>
        <dt>Equipo</dt><dd>${dato([equipo.tipo_equipo || equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · "))}</dd>
        <dt>Serial</dt><dd class="ws-mono">${dato(equipo.serial)}</dd>
        <dt>Contrato</dt><dd class="ws-mono">${dato(equipo.numero_contrato)}</dd>
        <dt>Bitácora</dt><dd>${dato(equipo.bitacora_equipo)}</dd>
      </dl>
      <div class="ws-chat-acciones">
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="historial" data-chat-id="${escapar(equipo.id || "")}" data-chat-placa="${escapar(placa)}">Ver Hoja de Vida</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="disponible" data-chat-placa="${escapar(placa)}">Marcar Disponible</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="vincular" data-chat-placa="${escapar(placa)}">Vincular Sistema</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="abrir-acta" data-chat-placa="${escapar(placa)}">Acta FR-002</button>
      </div>`;
    return tarjeta;
  }

  function tarjetaHistorial(movimientos) {
    if (!movimientos?.length) return null;
    const tarjeta = document.createElement("div");
    tarjeta.className = "ws-chat-tarjeta";
    tarjeta.innerHTML = `
      <h4>Últimos movimientos</h4>
      <div class="ws-linea-tiempo">
        ${movimientos
          .map(
            (mov) => `
            <div class="ws-evento">
              <strong>${escapar(mov.tipo_movimiento || mov.accion || "Movimiento")}</strong>
              <span>${escapar(mov.descripcion || mov.detalle || "—")}</span><br />
              <time>${new Date(mov.created_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })} · ${escapar(
                mov.usuario_nombre || mov.realizado_por || "sistema"
              )}</time>
            </div>`
          )
          .join("")}
      </div>`;
    return tarjeta;
  }

  function tarjetaDocumentos(documentos) {
    if (!documentos?.length) return null;
    const tarjeta = document.createElement("div");
    tarjeta.className = "ws-chat-tarjeta";
    tarjeta.innerHTML = `
      <h4>Documentos vinculados</h4>
      <div class="ws-linea-tiempo">
        ${documentos
          .map(
            (documento) => `
            <div class="ws-evento">
              <strong>${escapar(documento.titulo)}</strong>
              <span>${escapar(documento.categoria)} · ${fecha(documento.fecha_documento)}</span>
              <button type="button" class="ws-boton ws-boton-mini" data-doc="${escapar(documento.id)}">Abrir PDF</button>
            </div>`
          )
          .join("")}
      </div>`;
    return tarjeta;
  }

  function refrescarVistas() {
    window.dispatchEvent(new CustomEvent("ti-datos-actualizados"));
  }

  async function enviar(texto) {
    const mensaje = String(texto || "").trim();
    if (!mensaje) return;
    const contenedor = byId("wsAsistenteMensajes");
    burbuja(mensaje, "usuario");

    const espera = burbuja("", "asistente");
    if (espera) {
      espera.classList.add("ws-chat-typing");
      espera.setAttribute("aria-label", "El asistente está escribiendo");
      espera.innerHTML = '<span></span><span></span><span></span>';
    }
    try {
      const datos = await api("/api/asistente-ti", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje }),
      });

      if (espera) {
        espera.classList.remove("ws-chat-typing");
        espera.textContent = "";
        espera.textContent = datos.mensaje || "Listo.";
      }
      const contenedorMensajes = byId("wsAsistenteMensajes");

      if (datos.equipo) contenedorMensajes?.appendChild(tarjetaEquipo(datos.equipo));
      const historial = tarjetaHistorial(datos.movimientos);
      if (historial) contenedorMensajes?.appendChild(historial);
      const documentos = tarjetaDocumentos(datos.documentos);
      if (documentos) contenedorMensajes?.appendChild(documentos);

      if (datos.tipo === "accion_acta" && datos.placa) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "ws-boton ws-boton-rojo";
        boton.dataset.chatAccion = "abrir-acta";
        boton.dataset.chatPlaca = datos.placa;
        boton.textContent = "Abrir acta con datos precargados";
        contenedorMensajes?.appendChild(boton);
      }

      if (["modificacion", "vinculacion", "resumen", "accion_acta"].includes(datos.tipo)) {
        refrescarVistas();
        burbuja("Tabla y contadores actualizados automáticamente.", "asistente");
      }
    } catch (err) {
      console.error("[Asistente TI] Fallo en la consulta:", {
        mensaje: err?.message,
        status: err?.status ?? null,
        detalle: err?.detalle ?? null,
      });
      if (espera) {
        espera.classList.remove("ws-chat-typing");
        espera.textContent = "";
        espera.textContent = `Error ${err?.status ?? "RED"}: ${err?.message || "fallo desconocido"}`;
        espera.classList.add("ws-chat-error");
      }
    } finally {
      if (contenedor) contenedor.scrollTop = contenedor.scrollHeight;
    }
  }

  function alternar(debeAbrir) {
    const panel = byId("wsAsistentePanel");
    if (!panel) return;
    const abrir = Boolean(debeAbrir);
    panel.hidden = !abrir;
    panel.style.display = abrir ? "flex" : "none";
    panel.style.pointerEvents = abrir ? "auto" : "none";
    panel.setAttribute("aria-hidden", String(!abrir));
    if (abrir) {
      byId("wsAsistenteInput")?.focus();
    }
  }

  function accionRapida(boton) {
    const tipo = boton.dataset.chatAccion;
    const placa = boton.dataset.chatPlaca || "";
    if (tipo === "ficha") {
      window.dispatchEvent(new CustomEvent("ti-abrir-placa", { detail: { placa } }));
    } else if (tipo === "historial") {
      window.dispatchEvent(
        new CustomEvent("ti-abrir-historial", {
          detail: { id: boton.dataset.chatId, placa },
        })
      );
    } else if (tipo === "disponible") {
      enviar(`cambia el estado de ${placa} a Disponible`);
    } else if (tipo === "asignar") {
      const entrada = byId("wsAsistenteInput");
      if (entrada) {
        entrada.value = `asigna ${placa} a `;
        entrada.focus();
      }
    } else if (tipo === "vincular") {
      const entrada = byId("wsAsistenteInput");
      if (entrada) {
        entrada.value = `Vincula ${placa} al sistema `;
        entrada.focus();
      }
    } else if (tipo === "abrir-acta") {
      alternar(false);
      window.dispatchEvent(new CustomEvent("ti-abrir-acta", { detail: { placa } }));
    }
  }

  function iniciar() {
    if (!byId("wsAsistentePanel")) return;

    const disparador = byId("btnAsistente");
    const panel = byId("wsAsistentePanel");
    const raiz = byId("wsAsistente");
    raiz?.style.setProperty("z-index", "999999");
    raiz?.style.setProperty("pointer-events", "none");

    disparador?.addEventListener("click", (evento) => {
      evento.preventDefault();
      evento.stopPropagation();
      alternar(Boolean(panel?.hidden));
    });
    byId("btnCerrarAsistente")?.addEventListener("click", (evento) => {
      evento.preventDefault();
      evento.stopPropagation();
      alternar(false);
    });

    byId("wsAsistenteForm")?.addEventListener("submit", (evento) => {
      evento.preventDefault();
      const entrada = byId("wsAsistenteInput");
      const texto = entrada?.value || "";
      if (entrada) entrada.value = "";
      enviar(texto);
    });

    document.querySelectorAll("[data-chat-sugerencia]").forEach((boton) => {
      boton.addEventListener("click", () => {
        const sugerencia = boton.dataset.chatSugerencia || "";
        const entrada = byId("wsAsistenteInput");
        if (sugerencia === "Buscar placa" || sugerencia === "Vincular a sistema") {
          if (entrada) {
            entrada.value =
              sugerencia === "Buscar placa" ? "Buscar placa " : "Vincula ML-194291 al sistema M365";
            entrada.focus();
          }
        } else {
          enviar(sugerencia);
        }
      });
    });

    document.addEventListener("click", (evento) => {
      const boton = evento.target.closest("[data-chat-accion]");
      if (boton) {
        evento.stopPropagation();
        accionRapida(boton);
        return;
      }
      const documento = evento.target.closest("[data-doc]");
      if (documento) {
        window.dispatchEvent(new CustomEvent("ti-abrir-documento", { detail: { id: documento.dataset.doc } }));
      }
    });

    window.AsistenteTI = { enviar, alternar, obtenerToken };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar, { once: true });
  } else {
    iniciar();
  }
})();
