/* ============================================================
   panel-empresa.js | Inventario y Historial sobre Supabase
   ------------------------------------------------------------
   Gestiona las pestañas de la aplicación y los paneles:
     · Inventario: métricas, búsqueda, filtros, alta, edición,
       importación, exportación y hoja de vida.
     · Historial: actas emitidas con PDF firmado en Storage.
   ============================================================ */

(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const ESTADOS = ["Disponible", "Asignado", "En Mantenimiento", "Prestamo", "Dado de Baja"];

  function escapar(valor) {
    return String(valor ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  async function api(url, opciones = {}) {
    const respuesta = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json", ...(opciones.headers || {}) },
      ...opciones,
    });
    const datos = await respuesta.json().catch(() => ({}));
    if (!respuesta.ok || datos.ok === false) {
      throw new Error(datos.error || `Error HTTP ${respuesta.status}`);
    }
    return datos;
  }

  function mensaje(id, texto, tipo = "") {
    const el = byId(id);
    if (!el) return;
    el.textContent = texto || "";
    el.className = `mensaje-panel ${tipo}`.trim();
  }

  function abrirModal(id) {
    const modal = byId(id);
    if (modal) modal.hidden = false;
  }

  function cerrarModal(id) {
    const modal = byId(id);
    if (modal) modal.hidden = true;
  }

  /* ------------------------------------------------------------
     Pestañas
     ------------------------------------------------------------ */

  function inicializarTabs() {
    const botones = [...document.querySelectorAll(".tab")];
    botones.forEach((boton) => {
      boton.addEventListener("click", () => {
        const destino = boton.dataset.panel;
        botones.forEach((item) => item.classList.toggle("activa", item === boton));
        document.querySelectorAll(".panel").forEach((panel) => {
          const activo = panel.id === destino;
          panel.classList.toggle("activo", activo);
          panel.hidden = !activo;
        });
        if (destino === "panelInventario") cargarInventario();
        if (destino === "panelHistorial") cargarActas();
      });
    });
  }

  /* ------------------------------------------------------------
     Inventario
     ------------------------------------------------------------ */

  function pintarMetricas(datos) {
    const resumen = datos.resumen || {};
    byId("metricaTotal").textContent = resumen.total ?? datos.total ?? "—";
    byId("metricaDisponibles").textContent = resumen.disponibles ?? "—";
    byId("metricaAsignados").textContent = resumen.asignados ?? "—";
    byId("metricaMantenimiento").textContent = resumen.mantenimiento ?? "—";

    const select = byId("invSede");
    if (!select) return;
    const actual = select.value;
    const sedes = new Set(
      (datos.equipos || []).map((e) => e.sede).filter(Boolean)
    );
    [...select.options].slice(1).forEach((opcion) => opcion.remove());
    [...sedes]
      .sort((a, b) => a.localeCompare(b, "es"))
      .forEach((sede) => {
        const opcion = document.createElement("option");
        opcion.value = sede;
        opcion.textContent = sede;
        select.appendChild(opcion);
      });
    select.value = actual;
  }

  function filasInventario(equipos) {
    if (!equipos.length) {
      return '<p class="tabla-vacia">No hay equipos que coincidan con los filtros.</p>';
    }

    const filas = equipos
      .map(
        (equipo) => `
        <tr>
          <td data-etiqueta="Placa"><strong>${escapar(equipo.placa)}</strong></td>
          <td data-etiqueta="Equipo">${escapar([equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "—")}</td>
          <td data-etiqueta="Serial">${escapar(equipo.serial || "—")}</td>
          <td data-etiqueta="Sede">${escapar(equipo.sede || "—")}</td>
          <td data-etiqueta="Estado"><span class="chip estado-${escapar(equipo.estado || "")}">${escapar(equipo.estado || "—")}</span></td>
          <td data-etiqueta="Usuario">${escapar(equipo.usuario_asignado || "—")}</td>
          <td class="celda-acciones">
            <button type="button" class="btn btn-tabla" data-editar="${escapar(equipo.id)}">Editar</button>
            <button type="button" class="btn btn-tabla" data-hoja="${escapar(equipo.id)}" data-placa="${escapar(equipo.placa)}">Hoja de Vida</button>
          </td>
        </tr>`
      )
      .join("");

    return `
      <table class="tabla-datos">
        <thead>
          <tr>
            <th>Placa</th><th>Equipo</th><th>Serial</th><th>Sede</th>
            <th>Estado</th><th>Usuario</th><th>Acciones</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>`;
  }

  let equiposActuales = [];

  async function cargarInventario() {
    const contenedor = byId("tablaInventario");
    if (!contenedor) return;
    mensaje("inventarioMensaje", "Cargando inventario…");

    const parametros = new URLSearchParams();
    const q = byId("invBuscar")?.value.trim() || "";
    const sede = byId("invSede")?.value || "";
    const estado = byId("invEstado")?.value || "";
    if (q) parametros.set("q", q);
    if (sede) parametros.set("sede", sede);
    if (estado) parametros.set("estado", estado);
    parametros.set("limite", "100");

    try {
      const datos = await api(`/api/equipos?${parametros}`);
      equiposActuales = datos.equipos || [];
      pintarMetricas(datos);
      contenedor.innerHTML = filasInventario(equiposActuales);
      mensaje("inventarioMensaje", `${equiposActuales.length} equipo(s) mostrados.`);
    } catch (err) {
      contenedor.innerHTML = "";
      mensaje("inventarioMensaje", err.message, "error");
    }
  }

  function abrirModalEquipo(equipo) {
    byId("eqId").value = equipo?.id || "";
    byId("eqPlaca").value = equipo?.placa || "";
    byId("eqPlaca").disabled = Boolean(equipo?.id);
    byId("eqTipo").value = equipo?.tipo || "";
    byId("eqMarca").value = equipo?.marca || "";
    byId("eqModelo").value = equipo?.modelo || "";
    byId("eqSerial").value = equipo?.serial || "";
    byId("eqEstado").value = ESTADOS.includes(equipo?.estado) ? equipo.estado : "Disponible";
    byId("eqSede").value = equipo?.sede || "";
    byId("eqUsuario").value = equipo?.usuario_asignado || "";
    byId("eqCedula").value = equipo?.usuario_cedula || "";
    byId("eqGarantia").value = equipo?.garantia_hasta || "";
    byId("eqObservaciones").value = equipo?.observaciones || "";
    byId("modalEquipoTitulo").textContent = equipo ? "Editar equipo" : "Nuevo equipo";
    byId("modalEquipoError").hidden = true;
    abrirModal("modalEquipo");
  }

  async function guardarEquipo(evento) {
    evento.preventDefault();
    const id = byId("eqId").value;
    const cuerpo = {
      placa: byId("eqPlaca").value.trim(),
      tipo: byId("eqTipo").value,
      marca: byId("eqMarca").value.trim(),
      modelo: byId("eqModelo").value.trim(),
      serial: byId("eqSerial").value.trim(),
      estado: byId("eqEstado").value,
      sede: byId("eqSede").value.trim(),
      usuario_asignado: byId("eqUsuario").value.trim(),
      usuario_cedula: byId("eqCedula").value.trim(),
      garantia_hasta: byId("eqGarantia").value || null,
      observaciones: byId("eqObservaciones").value.trim(),
    };

    try {
      await api(id ? `/api/equipos/${id}` : "/api/equipos", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      cerrarModal("modalEquipo");
      await cargarInventario();
    } catch (err) {
      const aviso = byId("modalEquipoError");
      aviso.textContent = err.message;
      aviso.hidden = false;
    }
  }

  async function importarArchivo(archivo) {
    if (!archivo) return;
    mensaje("inventarioMensaje", "Importando archivo…");
    const datosForm = new FormData();
    datosForm.append("archivo", archivo);

    try {
      const resultado = await api("/api/equipos/importar", {
        method: "POST",
        body: datosForm,
      });
      mensaje(
        "inventarioMensaje",
        `Importación terminada · totalLeidos: ${resultado.totalLeidos}, ` +
          `procesados: ${resultado.procesados}, errores: ${resultado.errores}`,
        "ok"
      );
      await cargarInventario();
    } catch (err) {
      mensaje("inventarioMensaje", `No se pudo importar: ${err.message}`, "error");
    }
  }

  async function exportarExcel() {
    mensaje("inventarioMensaje", "Generando respaldo de Excel…");
    try {
      const respuesta = await fetch("/api/exportar/excel", { cache: "no-store" });
      if (!respuesta.ok) {
        const datos = await respuesta.json().catch(() => ({}));
        throw new Error(datos.error || `HTTP ${respuesta.status}`);
      }
      const bytes = await respuesta.arrayBuffer();
      const blob = new Blob([bytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = `Respaldo_Levapan_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      mensaje("inventarioMensaje", "Respaldo gerencial descargado.", "ok");
    } catch (err) {
      mensaje("inventarioMensaje", `No se pudo exportar: ${err.message}`, "error");
    }
  }

  /* ------------------------------------------------------------
     Hoja de vida
     ------------------------------------------------------------ */

  async function verHojaDeVida(id, placa) {
    abrirModal("modalHistorial");
    const contenedor = byId("modalHistorialContenido");
    contenedor.innerHTML = `<p class="mensaje-panel">Cargando trazabilidad de ${escapar(placa)}…</p>`;
    try {
      const datos = await api(`/api/equipos/${id}/historial`);
      const movimientos = (datos.historial || [])
        .map(
          (mov) => `
          <tr>
            <td>${escapar(new Date(mov.created_at).toLocaleString("es-CO"))}</td>
            <td>${escapar(mov.accion)}</td>
            <td>${escapar(mov.detalle || "—")}</td>
            <td>${escapar(mov.realizado_por || "—")}</td>
          </tr>`
        )
        .join("");
      const actas = (datos.actas || [])
        .map(
          (acta) => `
          <li>
            <strong>ACTA-${escapar(acta.consecutivo)}</strong> · ${escapar(acta.tipo_acta)} ·
            ${escapar(acta.colaborador_nombre)} · ${escapar(acta.sede)}
            <button type="button" class="btn btn-tabla" data-pdf="${escapar(acta.id)}">Ver PDF</button>
          </li>`
        )
        .join("");

      contenedor.innerHTML = `
        <h3>${escapar(placa)}</h3>
        <h4>Actas vinculadas</h4>
        <ul class="lista-actas">${actas || "<li>Sin actas registradas.</li>"}</ul>
        <h4>Movimientos</h4>
        <div class="tabla-contenedor">
          <table class="tabla-datos">
            <thead><tr><th>Fecha</th><th>Acción</th><th>Detalle</th><th>Realizado por</th></tr></thead>
            <tbody>${movimientos || '<tr><td colspan="4">Sin movimientos.</td></tr>'}</tbody>
          </table>
        </div>`;
    } catch (err) {
      contenedor.innerHTML = `<p class="mensaje-panel error">${escapar(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------------------
     Historial de actas
     ------------------------------------------------------------ */

  async function abrirPdf(id) {
    try {
      const datos = await api(`/api/actas/${id}/pdf`);
      window.open(datos.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      alert(`No se pudo abrir el PDF: ${err.message}`);
    }
  }

  async function cargarActas() {
    const contenedor = byId("tablaHistorial");
    if (!contenedor) return;
    mensaje("historialMensaje", "Cargando actas…");

    const q = byId("histBuscar")?.value.trim() || "";
    try {
      const datos = await api(`/api/actas?q=${encodeURIComponent(q)}`);
      const actas = datos.actas || [];
      if (!actas.length) {
        contenedor.innerHTML = '<p class="tabla-vacia">No hay actas emitidas.</p>';
      } else {
        contenedor.innerHTML = `
          <table class="tabla-datos">
            <thead><tr>
              <th>Consecutivo</th><th>Tipo</th><th>Placa</th><th>Colaborador</th>
              <th>Sede</th><th>Fecha</th><th>PDF</th>
            </tr></thead>
            <tbody>
              ${actas
                .map(
                  (acta) => `
                <tr>
                  <td data-etiqueta="Consecutivo"><strong>ACTA-${escapar(acta.consecutivo)}</strong></td>
                  <td data-etiqueta="Tipo">${escapar(acta.tipo_acta)}</td>
                  <td data-etiqueta="Placa">${escapar(acta.placa)}</td>
                  <td data-etiqueta="Colaborador">${escapar(acta.colaborador_nombre)}</td>
                  <td data-etiqueta="Sede">${escapar(acta.sede)}</td>
                  <td data-etiqueta="Fecha">${escapar(new Date(acta.created_at).toLocaleDateString("es-CO"))}</td>
                  <td><button type="button" class="btn btn-tabla" data-pdf="${escapar(acta.id)}">Ver / Descargar PDF</button></td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>`;
      }
      mensaje("historialMensaje", `${actas.length} acta(s) encontrada(s).`);
    } catch (err) {
      contenedor.innerHTML = "";
      mensaje("historialMensaje", err.message, "error");
    }
  }

  /* ------------------------------------------------------------
     Eventos globales del panel
     ------------------------------------------------------------ */

  function inicializarEventos() {
    let temporizador = null;
    byId("invBuscar")?.addEventListener("input", () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(cargarInventario, 300);
    });
    byId("invSede")?.addEventListener("change", cargarInventario);
    byId("invEstado")?.addEventListener("change", cargarInventario);

    byId("btnNuevoEquipo")?.addEventListener("click", () => abrirModalEquipo(null));
    byId("btnImportarExcel")?.addEventListener("click", () => byId("archivoImportar")?.click());
    byId("archivoImportar")?.addEventListener("change", (evento) => {
      importarArchivo(evento.target.files?.[0]);
      evento.target.value = "";
    });
    byId("btnExportarExcel")?.addEventListener("click", exportarExcel);
    byId("formEquipo")?.addEventListener("submit", guardarEquipo);

    byId("btnRecargarActas")?.addEventListener("click", cargarActas);
    let temporizadorActas = null;
    byId("histBuscar")?.addEventListener("input", () => {
      clearTimeout(temporizadorActas);
      temporizadorActas = setTimeout(cargarActas, 300);
    });

    document.addEventListener("click", (evento) => {
      const cerrar = evento.target.closest("[data-cerrar]");
      if (cerrar) cerrarModal(cerrar.dataset.cerrar);

      const editar = evento.target.closest("[data-editar]");
      if (editar) {
        const equipo = equiposActuales.find((item) => item.id === editar.dataset.editar);
        if (equipo) abrirModalEquipo(equipo);
      }

      const hoja = evento.target.closest("[data-hoja]");
      if (hoja) verHojaDeVida(hoja.dataset.hoja, hoja.dataset.placa);

      const pdf = evento.target.closest("[data-pdf]");
      if (pdf) abrirPdf(pdf.dataset.pdf);
    });

    document.querySelectorAll(".modal").forEach((modal) => {
      modal.addEventListener("click", (evento) => {
        if (evento.target === modal) cerrarModal(modal.id);
      });
    });

    document.addEventListener("keydown", (evento) => {
      if (evento.key === "Escape") {
        document.querySelectorAll(".modal").forEach((modal) => {
          modal.hidden = true;
        });
      }
    });
  }

  function iniciar() {
    inicializarTabs();
    inicializarEventos();
    if (window.AuthLevapan?.listo) {
      window.AuthLevapan.listo.then((perfil) => {
        if (!perfil) return;
        cargarInventario();
        cargarActas();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar, { once: true });
  } else {
    iniciar();
  }
})();
