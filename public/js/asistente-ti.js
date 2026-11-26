/* ============================================================
   asistente-ti.js | Copiloto TI inteligente (PWA Levapan)
   ------------------------------------------------------------
   Conectado directo a Supabase. Carga el inventario completo
   paginando bloques de 1.000 y mantiene memoria conversacional.
   ============================================================ */

(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const APP = window.LevapanApp;
  if (!APP) return;

  const sb = APP.sb;
  const MEMORIA = { historial: [], ultimaPlaca: null, ultimaPersona: null, ultimaSede: null, activos: [] };

  function norm(texto) {
    return String(texto ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[°º]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapar(valor) {
    return String(valor ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fechaHora(valor) {
    if (!valor) return "—";
    return new Date(valor).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
  }

  function diasHasta(valor) {
    if (!valor) return null;
    const fecha = new Date(valor);
    if (Number.isNaN(fecha.getTime())) return null;
    return Math.ceil((fecha.getTime() - Date.now()) / 86400000);
  }

  function autoScroll() {
    requestAnimationFrame(() => {
      const area = byId("chatMensajes");
      if (area) area.scrollTop = area.scrollHeight;
    });
  }

  function burbuja(texto, quien, clase) {
    const area = byId("chatMensajes");
    if (!area) return null;
    const el = document.createElement("div");
    const claseRol = quien === "usuario" ? "msg-user" : quien === "asistente" ? "msg-bot msg-assistant" : "";
    el.className = `burbuja-ai ${claseRol} ${quien}`.trim() + (clase ? ` ${clase}` : "");
    el.innerHTML = String(texto).replace(/\n/g, "<br>");
    area.appendChild(el);
    autoScroll();
    return el;
  }

  const LISTAS = {};
  let contadorListas = 0;

  function burbujaLista(titulo, filas) {
    const el = burbuja("", "asistente");
    const id = `lista-ai-${++contadorListas}`;
    LISTAS[id] = { filas, indice: 8 };

    const dibujar = () => {
      const lista = LISTAS[id];
      if (!lista) return;
      const visibles = lista.filas.slice(0, lista.indice).map((f) => `<div class="fila-lista">${f}</div>`).join("");
      el.innerHTML =
        `<strong>${escapar(titulo)}</strong>` +
        `<div class="lista-meta">${lista.filas.length} resultado(s) · mostrando ${Math.min(lista.indice, lista.filas.length)}</div>` +
        `<div class="filas-lista">${visibles}</div>`;

      if (lista.indice < lista.filas.length) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "boton mini ver-mas";
        boton.dataset.verMas = id;
        boton.textContent = "Ver 10 más";
        el.appendChild(boton);
      } else if (lista.filas.length > 8) {
        const nota = document.createElement("div");
        nota.className = "lista-meta";
        nota.textContent = "Mostrando todos. Filtra por placa o sede para reducir la lista.";
        el.appendChild(nota);
      }
      autoScroll();
    };

    dibujar();
    return el;
  }

  function burbujaConAcciones(texto, botones) {
    const el = burbuja(texto, "asistente");
    if (!el || !botones?.length) return el;
    const fila = document.createElement("div");
    fila.className = "acciones-ai";
    fila.innerHTML = botones.map((b) => `<button type="button" data-ai-accion="${b.accion}" class="boton mini">${escapar(b.etiqueta)}</button>`).join("");
    el.appendChild(fila);
    return el;
  }

  function typing() {
    const el = burbuja('<span class="puntos"><i></i><i></i><i></i></span>', "asistente", "typing");
    return el;
  }

  function recordar(equipo) {
    if (!equipo) return;
    MEMORIA.ultimaPlaca = equipo.placa || MEMORIA.ultimaPlaca;
    if (equipo.responsable) MEMORIA.ultimaPersona = equipo.responsable;
    if (equipo.sede) MEMORIA.ultimaSede = equipo.sede;
  }

  function responderContexto(pregunta) {
    const q = norm(pregunta);
    if (/quien lo tiene|quien tiene|responsable|dueño|dueno/.test(q) && MEMORIA.ultimaPersona) {
      return `La última persona consultada es ${MEMORIA.ultimaPersona}.`;
    }
    if (/sede|ubicacion|ubicación/.test(q) && MEMORIA.ultimaSede) {
      return `La última sede en contexto es ${MEMORIA.ultimaSede}.`;
    }
    return null;
  }

  async function cargarActivos() {
    if (MEMORIA.activos.length) return MEMORIA.activos;
    try {
      MEMORIA.activos = await APP.cargarTodos("vista_veredicto_360", "*");
    } catch {
      MEMORIA.activos = await APP.cargarTodos("equipos", "*");
    }
    return MEMORIA.activos;
  }

  function coincide(equipo, terminos) {
    const texto = norm([
      equipo.placa, equipo.serial, equipo.nombre_red, equipo.responsable, equipo.cedula,
      equipo.empresa, equipo.sede, equipo.ceco, equipo.area, equipo.marca,
      equipo.modelo, equipo.proveedor, equipo.num_contrato, equipo.estado, equipo.tipo_equipo,
      equipo.veredicto_estado, equipo.veredicto_detalle, equipo.upn_usuario, equipo.device_name,
    ].join(" "));
    return terminos.every((t) => texto.includes(t));
  }

  function terminosDe(pregunta) {
    const stop = new Set(["busca","buscar","muestra","muéstrame","muestrame","dame","consulta","consulta el","que","que tiene","tiene","el","la","los","las","de","del","en","por","para","cual","cuales","cuál","cuáles","estan","están","con","sin","los","una","un","equipo","equipos","placa","serial","sedes","sede","contrato","contratos","resumen","cuantos","cuántos","hay","por favor"]);
    return norm(pregunta).split(/\s+/).filter((p) => p.length >= 2 && !stop.has(p));
  }

  async function buscarEquipos(pregunta) {
    const activos = await cargarActivos();
    const terminos = terminosDe(pregunta);
    if (!terminos.length) return [];
    return activos.filter((e) => coincide(e, terminos)).slice(0, 40);
  }

  function tarjetaEquipo(equipo) {
    const datos = [
      ["Placa", equipo.placa], ["Nombre en Red", equipo.nombre_red], ["Serial", equipo.serial],
      ["Responsable", equipo.responsable], ["Cédula", equipo.cedula], ["Empresa", equipo.empresa],
      ["Sede", equipo.sede], ["CECO", equipo.ceco], ["Área", equipo.area], ["Estado", equipo.estado],
      ["Marca/Modelo", [equipo.marca, equipo.modelo].filter(Boolean).join(" ")],
      ["Contrato", equipo.num_contrato], ["Vence", equipo.fecha_vencimiento_contrato],
    ];
    return `<div class="tarjeta-ai">
      <h4>${escapar(equipo.placa || "Equipo")}</h4>
      <dl>${datos.map(([k, v]) => `<div><dt>${escapar(k)}</dt><dd>${escapar(v || "—")}</dd></div>`).join("")}</dl>
    </div>`;
  }

  async function consultarContratos(pregunta) {
    const activos = await cargarActivos();
    const match = norm(pregunta).match(/(\d{1,3})\s*(dias|días)/);
    const horizonte = match ? Number(match[1]) : 30;
    const filas = activos
      .filter((e) => e.fecha_vencimiento_contrato)
      .map((e) => ({ ...e, dias: diasHasta(e.fecha_vencimiento_contrato) }))
      .filter((e) => e.dias != null && e.dias <= horizonte)
      .sort((a, b) => a.dias - b.dias);
    if (!filas.length) return { titulo: "Contratos por vencer", filas: [] };
    return {
      titulo: `Contratos que vencen en ≤ ${horizonte} días`,
      filas: filas.map((e) => `${escapar(e.placa)} · ${escapar(e.num_contrato || "—")} · ${escapar(e.proveedor || "—")} · ${escapar(e.fecha_vencimiento_contrato)} (${e.dias} d)`),
    };
  }

  async function resumenGeneral(pregunta) {
    const activos = await cargarActivos();
    const porSede = {};
    const porEstado = {};
    let sinResponsable = 0;
    let sinSerial = 0;
    activos.forEach((e) => {
      if (e.sede) porSede[e.sede] = (porSede[e.sede] || 0) + 1;
      if (e.estado) porEstado[e.estado] = (porEstado[e.estado] || 0) + 1;
      if (!e.responsable) sinResponsable += 1;
      if (!e.serial) sinSerial += 1;
    });
    const ordenar = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (/sin responsable|sin serial|faltan/.test(norm(pregunta))) {
      return `Sin responsable: ${sinResponsable}. Sin serial: ${sinSerial}. Total activos: ${activos.length}.`;
    }
    return `Resumen real (${activos.length} activos)\nEstados: ${ordenar(porEstado)}\nSedes: ${ordenar(porSede)}\nSin responsable: ${sinResponsable} · Sin serial: ${sinSerial}`;
  }

  function esSaludo(q) {
    return /^(hola|buenos dias|buenas tardes|buenas noches|que tal|hey|saludos|gracias|muchas gracias|excelente|listo|quien eres|que puedes hacer|ayuda)/.test(q);
  }

  function respuestaSaludo(q) {
    const nombre = (window.LevapanApp.ESTADO.perfil?.nombre_completo || "colega").split(" ")[0];
    const hora = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Bogota", hour: "2-digit", hour12: false }).format(new Date()));
    const saludo = hora < 12 ? "Buenos días" : hora < 19 ? "Buenas tardes" : "Buenas noches";
    if (/gracias|excelente|listo/.test(q)) return `Con gusto, ${nombre}.`;
    if (/quien eres|ayuda|que puedes hacer/.test(q)) {
      return `${saludo}, ${nombre}. Soy el Asistente Integral TI Levapan. Puedo buscar por placa, serial, responsable, sede, CECO o contrato; dar resúmenes ejecutivos; alertar vencimientos; y ejecutar acciones como asignar, auditar o generar actas.\nEjemplos: «contratos por vencer en 60 días», «equipos sin serial», «resumen por sede».`;
    }
    return `${saludo}, ${nombre}! ¿Qué activo o sistema revisamos?`;
  }

  async function procesar(texto) {
    const q = norm(texto);
    MEMORIA.historial.push({ rol: "usuario", texto, fecha: new Date().toISOString() });

    if (esSaludo(q)) return burbuja(respuestaSaludo(q), "asistente");

    if (/limpiar|borrar conversacion|borrar conversación/.test(q)) {
      byId("chatMensajes").innerHTML = "";
      MEMORIA.historial = [];
      return burbuja("Conversación limpiada. ¿En qué puedo ayudarte?", "asistente");
    }

    const espera = typing();

    try {
      if (/discrepancia|microsoft 365|entra|veredicto|telemetria|telemetría/.test(q)) {
        espera.remove();
        const activos = await cargarActivos();
        const filas = activos.filter((e) => {
          const v = norm(e.veredicto_estado || "");
          return /discrepancia|retirado|sin_reporte|solo_inventario/.test(v);
        });
        if (!filas.length) return burbuja("No hay activos con discrepancias de identidad o telemetría en este momento.", "asistente");
        return burbujaLista(
          "Discrepancias Microsoft 365 / telemetría",
          filas.map((e) => `${escapar(e.placa)} · ${escapar(e.veredicto_estado)} · ${escapar(e.veredicto_detalle || "")}`)
        );
      }

      if (/sin serial|sin responsable/.test(q)) {
        espera.remove();
        const activos = await cargarActivos();
        const faltaSerial = /sin serial/.test(q);
        const filas = activos.filter((e) => (faltaSerial ? !e.serial : !e.responsable));
        if (!filas.length) return burbuja(`No hay equipos ${faltaSerial ? "sin serial" : "sin responsable"}.`, "asistente");
        return burbujaLista(
          faltaSerial ? "Equipos sin serial" : "Equipos sin responsable",
          filas.map((e) => `${escapar(e.placa)} · ${escapar(e.nombre_red || "—")} · ${escapar(e.sede || "—")}`)
        );
      }

      if (/disponible|en stock|en bodega|libres|sin asignar/.test(q)) {
        espera.remove();
        const activos = await cargarActivos();
        const filas = activos.filter((e) => {
          const estado = norm(e.estado || "");
          return /DISPONIBLE|STOCK|BODEGA/.test(estado) || !e.responsable;
        });
        if (!filas.length) return burbuja("No hay equipos disponibles o sin asignar en el inventario.", "asistente");
        return burbujaLista(
          "Equipos disponibles / en bodega",
          filas.map((e) =>
            `${escapar(e.placa)} · ${escapar(e.tipo_equipo || "—")} · ${escapar([e.marca, e.modelo].filter(Boolean).join(" ") || "—")} · ${escapar(e.serial || "—")} · ${escapar(e.sede || "—")}`
          )
        );
      }

      if (/resumen|cuantos|cuántos|estadistica|estadística|por sede/.test(q)) {
        espera.remove();
        return burbuja(await resumenGeneral(texto), "asistente");
      }

      if (/venc|contrato|renovac/.test(q)) {
        espera.remove();
        const resultado = await consultarContratos(texto);
        if (!resultado.filas.length) return burbuja(`No hay contratos que venzan en los próximos ${norm(texto).match(/(\d{1,3})/)?.[1] || 30} días.`, "asistente");
        return burbujaLista(resultado.titulo, resultado.filas);
      }

      const contexto = responderContexto(texto);
      let pregunta = texto;
      if (contexto && !/\d{3,}/.test(texto)) {
        pregunta = MEMORIA.ultimaPlaca || MEMORIA.ultimaPersona || MEMORIA.ultimaSede || texto;
      }

      const resultados = await buscarEquipos(pregunta);
      espera.remove();

      if (!resultados.length) {
        return burbuja(`No encontré coincidencias con «${texto}». Prueba con placa, serial, responsable, sede o CECO.`, "asistente");
      }

      const equipo = resultados[0];
      recordar(equipo);

      if (resultados.length > 1) {
        burbujaLista(
          `Equipos encontrados`,
          resultados.map((e) => `${escapar(e.placa)} · ${escapar(e.nombre_red || "—")} · ${escapar(e.sede || "—")} · ${escapar(e.estado || "—")}`)
        );
      }

      const botones = [
        { accion: "ficha", etiqueta: "Ver Ficha 360°" },
        { accion: "acta", etiqueta: "Acta FR-002" },
        { accion: "qr", etiqueta: "Etiqueta QR" },
        { accion: "asignar", etiqueta: "Asignar / Devolver" },
        { accion: "nota", etiqueta: "Agregar nota" },
        { accion: "verificado", etiqueta: "Marcar verificado" },
      ];
      burbuja(tarjetaEquipo(equipo), "asistente");
      return burbujaConAcciones(`Contexto activo: ${equipo.placa}. ¿Qué deseas hacer?`, botones);
    } catch (err) {
      espera?.remove();
      return burbuja(`Error ${err.status || ""}: ${err.message}`, "asistente", "error");
    }
  }

  async function ejecutarAccion(boton) {
    const accion = boton.dataset.aiAccion;
    const equipo = (MEMORIA.activos || []).find((e) => e.placa === MEMORIA.ultimaPlaca);
    if (!equipo) return burbuja("No hay un equipo en contexto.", "asistente", "error");

    if (accion === "ficha") {
      APP.irAVista("placas");
      APP.mostrarFichaPlaca(equipo);
    } else if (accion === "acta") {
      APP.abrirActa(equipo, "ASIGNACIÓN");
    } else if (accion === "qr") {
      const sistema = (APP.ESTADO.sistemas || []).find((s) => s.id === equipo.sistema_id);
      const datos = JSON.stringify({ placa: equipo.placa, serial: equipo.serial, ecosistema: sistema?.codigo || null });
      const src = await window.QRCode.toDataURL(datos, { width: 320 });
      const ventana = window.open("", "_blank");
      ventana?.document.write(`<body style="text-align:center;font-family:Arial;padding:24px"><h2>${equipo.placa}</h2><img src="${src}" width="280"><button onclick="window.print()">Imprimir</button></body>`);
    } else if (accion === "asignar") {
      APP.abrirActa(equipo, "ASIGNACIÓN");
    } else if (accion === "nota") {
      const nota = window.prompt("Observación para la bitácora:");
      if (!nota) return;
      const bitacora = `${equipo.bitacora || ""}\n${fechaHora(new Date())} · ${nota}`.trim();
      await sb.from("equipos").update({ bitacora }).eq("id", equipo.id);
      await APP.registrarHistorial(equipo, "EDICIÓN", `Nota rápida: ${nota}`, {});
      equipo.bitacora = bitacora;
      burbuja(`Nota agregada a la bitácora de ${equipo.placa}.`, "asistente");
    } else if (accion === "verificado") {
      await sb.from("equipos").update({ estado: "VERIFICADO", modificado_por: APP.ESTADO.perfil?.nombre_completo || "sistema" }).eq("id", equipo.id);
      await APP.registrarHistorial(equipo, "EDICIÓN", "Verificado en Auditoría Física", {});
      equipo.estado = "VERIFICADO";
      burbuja(`${equipo.placa} marcado como verificado en auditoría.`, "asistente");
    }
  }

  function alternar(abrir) {
    const panel = byId("panelAsistente");
    if (!panel) return;
    if (abrir && window.innerWidth <= 900) {
      byId("sidebar")?.classList.remove("abierto");
      const fondo = byId("drawerFondo");
      if (fondo) fondo.hidden = true;
    }
    panel.hidden = !abrir;
    panel.style.display = abrir ? "flex" : "none";
    panel.classList.toggle("open", abrir);
    panel.setAttribute("aria-hidden", String(!abrir));

    const disparador = byId("btnAsistente");
    if (disparador) {
      disparador.hidden = abrir;
      disparador.style.display = abrir ? "none" : "inline-flex";
    }

    if (abrir) byId("chatInput")?.focus();
  }

  function instalar() {
    if (!byId("btnAsistente")) return;

    byId("btnAsistente").addEventListener("click", (e) => { e.stopPropagation(); alternar(byId("panelAsistente").hidden); });
    byId("cerrarAsistente")?.addEventListener("click", () => alternar(false));
    byId("formChat")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const entrada = byId("chatInput");
      const texto = entrada.value;
      entrada.value = "";
      if (!texto.trim()) return;
      burbuja(texto, "usuario");
      await procesar(texto);
    });

    document.addEventListener("click", (e) => {
      const mas = e.target.closest("[data-ver-mas]");
      if (mas) {
        const id = mas.dataset.verMas;
        const lista = LISTAS[id];
        if (lista) {
          lista.indice += 10;
          const burbujaPadre = mas.closest(".burbuja-ai");
          if (burbujaPadre) {
            const visibles = lista.filas.slice(0, lista.indice).map((f) => `<div class="fila-lista">${f}</div>`).join("");
            burbujaPadre.querySelector(".filas-lista").innerHTML = visibles;
            burbujaPadre.querySelector(".lista-meta").textContent =
              `${lista.filas.length} resultado(s) · mostrando ${Math.min(lista.indice, lista.filas.length)}`;
            if (lista.indice >= lista.filas.length) mas.remove();
            autoScroll();
          }
        }
        return;
      }
     const boton = e.target.closest("[data-ai-accion]");
      if (boton) {
        e.stopPropagation();
        ejecutarAccion(boton);
        return;
      }
      const chip = e.target.closest("[data-ai-chip]");
      if (chip) {
        const texto = chip.dataset.aiChip;
        burbuja(texto, "usuario");
        procesar(texto);
      }
    });

    burbuja("¡Hola! Soy tu Asistente Integral TI. Consulta placas, contratos, sedes o pide un resumen ejecutivo.", "asistente");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", instalar, { once: true });
  else instalar();

  window.AsistenteTILevapan = { procesar, alternar };
})();
