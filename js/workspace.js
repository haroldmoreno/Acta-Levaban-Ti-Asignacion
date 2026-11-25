/* ============================================================
   workspace.js | Workspace Modular · Arquitectura Inversa de TI
   ------------------------------------------------------------
   Cuatro módulos sobre Supabase:
     · Sistemas  → tarjetas macro con criticidad y conteos
     · Placas    → vista 360° Sistema → Placa → Equipo → Docs
     · Equipos   → inventario con filtros, garantías e importación
     · Bóveda    → documentos con búsqueda Full-Text y visor PDF

   El login y js/auth.js permanecen intactos: este módulo solo
   consume window.AuthLevapan y las rutas /api/ ya protegidas.
   ============================================================ */

(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);

  const estado = {
    perfil: null,
    vista: "sistemas",
    sistemas: [],
    equipos: [],
    pagina: 1,
    total: 0,
    limite: 60,
    placaActiva: null,
    documentoActivo: null,
    documentos: [],
    filtroSistema: "",
    cargado: { sistemas: false, equipos: false, boveda: false },
  };

  const PERMISOS_TI = {
    puede_crear_editar_equipos: "Crear/editar equipos",
    puede_emitir_actas: "Emitir actas",
    puede_sincronizar_importar: "Sincronizar/importar",
    puede_gestionar_boveda: "Gestionar bóveda",
    puede_eliminar_registros: "Eliminar registros",
    puede_administrar_usuarios: "Administrar usuarios",
  };

  const SOLO_CORPORATIVO = /^[A-Za-z0-9._%+-]+@levapan\.com$/i;

  const CRITICIDAD = {
    Critica: { clase: "critica", etiqueta: "Crítica" },
    Alta: { clase: "alta", etiqueta: "Alta" },
    Media: { clase: "media", etiqueta: "Media" },
    Baja: { clase: "baja", etiqueta: "Baja" },
  };

  const ESTADO_EQUIPO = {
    Disponible: "disponible",
    Asignado: "asignado",
    "En Mantenimiento": "mantenimiento",
    Prestamo: "prestamo",
    "Dado de Baja": "baja",
  };

  const CATEGORIA_ICONO = {
    Acta: "§",
    Contrato: "✎",
    Factura: "₱",
    Garantia: "◈",
    Manual: "▤",
    Licencia: "⌘",
  };

  /* ------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------ */

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
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "2-digit" });
  }

  function fechaHora(valor) {
    if (!valor) return "—";
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("es-CO", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function numero(valor) {
    const n = Number(valor);
    return Number.isFinite(n) ? n.toLocaleString("es-CO") : "—";
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

  /* ------------------------------------------------------------
     Autocompletado / autorrelleno de equipos
     ------------------------------------------------------------ */

  function envolverParaAutocomplete(input) {
    if (!input) return null;
    const padre = input.parentElement;
    if (padre?.classList.contains("ws-autocomplete-wrap")) return padre;
    const envoltorio = document.createElement("div");
    envoltorio.className = "ws-autocomplete-wrap";
    padre?.insertBefore(envoltorio, input);
    envoltorio?.appendChild(input);
    return envoltorio;
  }

  /**
   * Busca por placa, serial, tipo, marca, modelo o responsable y permite
   * autorrellenar el resto de campos al elegir una sugerencia.
   */
  function instalarAutocompletado({
    inputId,
    alSeleccionar,
    minChars = 2,
    limite = 12,
    autocompletarExacto = false,
  }) {
    const input = byId(inputId);
    const envoltorio = envolverParaAutocomplete(input);
    if (!input || !envoltorio || input.dataset.autocompletado === "1") return;

    input.dataset.autocompletado = "1";
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");

    const lista = document.createElement("div");
    lista.className = "ws-autocomplete";
    lista.id = `autocomplete-${inputId}`;
    lista.setAttribute("role", "listbox");
    lista.hidden = true;
    envoltorio.appendChild(lista);

    let temporizador = null;
    let equipos = [];
    let indice = -1;

    function ocultar() {
      lista.hidden = true;
      indice = -1;
      input.setAttribute("aria-expanded", "false");
    }

    function elegir(equipo) {
      input.value = equipo.placa || "";
      ocultar();
      alSeleccionar?.(equipo, input);
    }

    function pintar() {
      if (!equipos.length) {
        lista.innerHTML =
          '<p class="ws-auto-vacio">Sin coincidencias. Prueba con otra placa, serial o responsable.</p>';
        lista.hidden = false;
        input.setAttribute("aria-expanded", "true");
        return;
      }

      lista.innerHTML = equipos
        .map(
          (equipo, i) => `
          <button type="button" class="ws-auto-item" role="option" data-indice="${i}">
            <strong>${escapar(equipo.placa)}</strong>
            <span>${escapar(
              [equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "Equipo"
            )}${equipo.serial ? ` · S/N ${escapar(equipo.serial)}` : ""}</span>
            <span>${escapar(equipo.sede || "Sin sede")} · ${escapar(
              equipo.usuario_asignado || "Sin responsable"
            )}</span>
            <span class="ws-auto-pista">${escapar(equipo.sistemas?.nombre || "Sin sistema")}</span>
          </button>`
        )
        .join("");
      lista.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    async function buscar() {
      const consulta = input.value.trim();
      if (consulta.length < minChars) return ocultar();
      try {
        const datos = await api(
          `/api/equipos?q=${encodeURIComponent(consulta)}&limite=${limite}`
        );
        equipos = datos.equipos || [];
        if (autocompletarExacto) {
          const exacto = equipos.find(
            (equipo) => String(equipo.placa || "").toUpperCase() === consulta.toUpperCase()
          );
          if (exacto) return elegir(exacto);
        }
        pintar();
      } catch {
        ocultar();
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(buscar, 230);
    });
    input.addEventListener("focus", () => {
      if (input.value.trim().length >= minChars) buscar();
    });
    input.addEventListener("blur", () => setTimeout(ocultar, 180));

    input.addEventListener("keydown", (evento) => {
      if (lista.hidden) return;
      const items = [...lista.querySelectorAll(".ws-auto-item")];
      if (!items.length) return;

      if (evento.key === "ArrowDown" || evento.key === "ArrowUp") {
        evento.preventDefault();
        indice =
          evento.key === "ArrowDown"
            ? Math.min(items.length - 1, indice + 1)
            : Math.max(0, indice - 1);
        items.forEach((item, i) => item.classList.toggle("activo", i === indice));
        items[indice]?.scrollIntoView({ block: "nearest" });
      } else if (evento.key === "Enter" && indice >= 0) {
        evento.preventDefault();
        elegir(equipos[indice]);
      } else if (evento.key === "Escape") {
        ocultar();
      }
    });

    lista.addEventListener("mousedown", (evento) => {
      const item = evento.target.closest(".ws-auto-item");
      if (!item) return;
      evento.preventDefault();
      elegir(equipos[Number(item.dataset.indice)]);
    });
  }

  function asignarCamposEquipo(equipo) {
    const poner = (id, valor) => {
      const campo = byId(id);
      if (campo) campo.value = valor ?? "";
    };

    poner("eqTipo", equipo.tipo);
    poner("eqMarca", equipo.marca);
    poner("eqModelo", equipo.modelo);
    poner("eqSerial", equipo.serial);
    poner("eqSede", equipo.sede);
    poner("eqUsuario", equipo.usuario_asignado);
    poner("eqCedula", equipo.usuario_cedula);
    poner("eqEstado", ESTADO_EQUIPO[equipo.estado] ? equipo.estado : "Disponible");
    poner("eqGarantia", equipo.garantia_hasta ? String(equipo.garantia_hasta).slice(0, 10) : "");
    poner("eqObservaciones", equipo.observaciones);

    const sistema = byId("eqSistema");
    if (sistema) {
      if (equipo.sistema_id && !sistema.querySelector(`option[value="${equipo.sistema_id}"]`)) {
        cargarSistemas().then(() => {
          sistema.value = equipo.sistema_id || "";
        });
      } else {
        sistema.value = equipo.sistema_id || "";
      }
    }
  }

  /** Autorrellena el formulario del acta cuando la placa coincide exacto. */
  function instalarAutorrellenoActa() {
    const placa = byId("placa");
    if (!placa || placa.dataset.wsAuto === "1") return;
    placa.dataset.wsAuto = "1";

    let temporizador = null;
    placa.addEventListener("input", () => {
      clearTimeout(temporizador);
      const consulta = placa.value.trim();
      if (consulta.length < 4) return;

      temporizador = setTimeout(async () => {
        try {
          const datos = await api(
            `/api/equipos?q=${encodeURIComponent(consulta)}&limite=20`
          );
          const equipo = (datos.equipos || []).find(
            (item) => String(item.placa || "").toUpperCase() === consulta.toUpperCase()
          );
          if (!equipo) return;

          const ponerOpcion = (id, valor) => {
            const select = byId(id);
            if (!select || !valor) return;
            if (![...select.options].some((opcion) => opcion.value === valor)) {
              select.add(new Option(valor, valor));
            }
            if (!select.value) {
              select.value = valor;
              select.dispatchEvent(new Event("change", { bubbles: true }));
            }
          };

          const serial = byId("serial");
          if (serial && !serial.value.trim()) serial.value = equipo.serial || "";
          ponerOpcion("marca", equipo.marca);
          ponerOpcion("modelo", equipo.modelo);

          const estado = byId("estado");
          if (estado) estado.value = equipo.estado || "";
          const info = byId("equipoInfo");
          if (info) info.hidden = false;
          const infoEstado = byId("equipoInfoEstado");
          if (infoEstado) infoEstado.textContent = equipo.estado || "—";
          const infoResponsable = byId("equipoInfoResponsable");
          if (infoResponsable) infoResponsable.textContent = equipo.usuario_asignado || "—";
          const infoAccesorios = byId("equipoInfoAccesorios");
          if (infoAccesorios) infoAccesorios.textContent = "Del inventario";
        } catch {
          /* el desplegable propio del acta ya muestra las sugerencias */
        }
      }, 260);
    });
  }

  function mensaje(id, texto, tipo = "") {
    const el = byId(id);
    if (!el) return;
    el.textContent = texto || "";
    el.className = `ws-mensaje ${tipo}`.trim();
  }

  function abrirModal(id) {
    const modal = byId(id);
    if (modal) modal.hidden = false;
  }

  function cerrarModal(id) {
    const modal = byId(id);
    if (modal) modal.hidden = true;
  }

  function cerrarTodo() {
    document.querySelectorAll(".ws-modal").forEach((modal) => {
      modal.hidden = true;
    });
    const drawer = byId("drawerActa");
    if (drawer) drawer.hidden = true;
    document.body.style.overflow = "";
  }

  /* ------------------------------------------------------------
     Micro-interacciones: brillo radial y onda táctil
     ------------------------------------------------------------ */

  function instalarBrilloRadial() {
    document.addEventListener(
      "pointermove",
      (evento) => {
        const objetivo = evento.target.closest("[data-glow]");
        if (!objetivo) return;
        const caja = objetivo.getBoundingClientRect();
        objetivo.style.setProperty("--mx", `${evento.clientX - caja.left}px`);
        objetivo.style.setProperty("--my", `${evento.clientY - caja.top}px`);
      },
      { passive: true }
    );
  }

  function instalarOnda() {
    document.addEventListener(
      "pointerdown",
      (evento) => {
        const objetivo = evento.target.closest(
          ".ws-boton, .ws-tab, .ws-resultado, .ws-sistema, .ws-doc, .ws-doc-mini, .ws-icono-boton"
        );
        if (!objetivo) return;

        const estilo = window.getComputedStyle(objetivo);
        if (estilo.position === "static") objetivo.style.position = "relative";

        const caja = objetivo.getBoundingClientRect();
        const tamano = Math.max(caja.width, caja.height) * 0.6;
        const onda = document.createElement("span");
        onda.className = "ws-onda";
        onda.style.width = `${tamano}px`;
        onda.style.height = `${tamano}px`;
        onda.style.left = `${evento.clientX - caja.left - tamano / 2}px`;
        onda.style.top = `${evento.clientY - caja.top - tamano / 2}px`;
        objetivo.appendChild(onda);
        setTimeout(() => onda.remove(), 650);
      },
      { passive: true }
    );
  }

  /* ------------------------------------------------------------
     Pestañas
     ------------------------------------------------------------ */

  const TITULOS_VISTA = {
    sistemas: "Ecosistemas de TI",
    placas: "Placas · Vista 360°",
    equipos: "Inventario de equipos",
    boveda: "Bóveda PDF",
    administracion: "Administración TI",
  };

  function posicionarIndicador() {
    const activo = document.querySelector(".ws-tab.activa:not([hidden])");
    const indicador = document.querySelector(".ws-nav-indicador");
    if (!activo || !indicador) return;
    indicador.style.opacity = "1";
    indicador.style.left = "0px";
    indicador.style.top = `${activo.offsetTop + 8}px`;
    indicador.style.width = "3px";
    indicador.style.height = `${Math.max(20, activo.offsetHeight - 16)}px`;
  }

  function irAVista(vista) {
    estado.vista = vista;
    document.querySelectorAll(".ws-tab").forEach((boton) => {
      boton.classList.toggle("activa", boton.dataset.vista === vista);
    });
    document.querySelectorAll(".ws-panel").forEach((panel) => {
      const activo = panel.id === `vista${vista.charAt(0).toUpperCase()}${vista.slice(1)}`;
      panel.hidden = !activo;
      panel.classList.toggle("activo", activo);
    });

    const titulo = byId("wsTituloSeccion");
    if (titulo) titulo.textContent = TITULOS_VISTA[vista] || "";
    byId("wsSidebar")?.classList.remove("abierto");
    posicionarIndicador();

    if (vista === "sistemas" && !estado.cargado.sistemas) cargarSistemas();
    if (vista === "equipos" && !estado.cargado.equipos) cargarEquipos();
    if (vista === "boveda" && !estado.cargado.boveda) cargarBoveda();
    if (vista === "administracion") actualizarAdmin();
    if (vista === "placas") {
      const buscador = byId("placaBuscar");
      if (buscador) setTimeout(() => buscador.focus(), 120);
    }
  }

  /* ------------------------------------------------------------
     SISTEMAS
     ------------------------------------------------------------ */

  function tarjetaSistema(sistema) {
    const criticidad = CRITICIDAD[sistema.criticidad] || CRITICIDAD.Media;
    return `
      <article class="ws-sistema" data-glow data-sistema="${escapar(sistema.id)}" tabindex="0">
        <div class="ws-sistema-cab">
          <div>
            <span class="ws-sistema-codigo">${escapar(sistema.codigo)}</span>
            <h3 class="ws-sistema-nombre">${escapar(sistema.nombre)}</h3>
          </div>
          <span class="ws-criticidad ${criticidad.clase}">${criticidad.etiqueta}</span>
        </div>
        <p class="ws-sistema-desc">${escapar(sistema.descripcion || "Sin descripción registrada.")}</p>
        <div class="ws-sistema-pie">
          <div class="ws-sistema-datos">
            <div class="ws-dato"><strong>${numero(sistema.total_equipos)}</strong><span>Placas</span></div>
            <div class="ws-dato"><strong>${numero(sistema.total_documentos)}</strong><span>Documentos</span></div>
          </div>
          <div class="ws-sistema-acciones">
            <button type="button" class="ws-icono-boton" data-editar-sistema="${escapar(sistema.id)}" title="Editar sistema" aria-label="Editar sistema">✎</button>
            <button type="button" class="ws-icono-boton" data-eliminar-sistema="${escapar(sistema.id)}" title="Eliminar sistema" aria-label="Eliminar sistema">✕</button>
          </div>
        </div>
      </article>`;
  }

  async function cargarSistemas() {
    const contenedor = byId("gridSistemas");
    if (!contenedor) return;
    if (!estado.sistemas.length) {
      contenedor.innerHTML = '<p class="ws-vacio">Cargando ecosistemas…</p>';
    }
    try {
      const datos = await api("/api/sistemas");
      estado.sistemas = datos.sistemas || [];
      estado.cargado.sistemas = true;
      contenedor.innerHTML = estado.sistemas.map(tarjetaSistema).join("") ||
        '<p class="ws-vacio">Aún no hay sistemas. Crea el primero con “+ Nuevo sistema”.</p>';
      sincronizarSelectsSistemas();
      mensaje("mensajeSistemas", `${estado.sistemas.length} sistema(s) en el mapa.`);
    } catch (err) {
      contenedor.innerHTML = `<p class="ws-vacio">${escapar(err.message)}</p>`;
      mensaje("mensajeSistemas", err.message, "error");
    }
  }

  function sincronizarSelectsSistemas() {
    const opciones = estado.sistemas
      .map((s) => `<option value="${escapar(s.id)}">${escapar(s.nombre)}</option>`)
      .join("");

    const eq = byId("eqSistema");
    if (eq) {
      const actual = eq.value;
      eq.innerHTML = `<option value="">Sin sistema</option>${opciones}`;
      eq.value = actual;
    }

    ["bovSistemas", "vinSistemas"].forEach((id) => {
      const select = byId(id);
      if (!select) return;
      const seleccionados = new Set([...select.selectedOptions].map((o) => o.value));
      select.innerHTML = opciones;
      [...select.options].forEach((opcion) => {
        opcion.selected = seleccionados.has(opcion.value);
      });
    });

    const adminSistema = byId("adminUsuSistema");
    if (adminSistema) {
      const actual = adminSistema.value;
      adminSistema.innerHTML = `<option value="">Sin sistema</option>${opciones}`;
      adminSistema.value = actual;
    }

    const filtro = byId("invSistema");
    if (filtro) {
      const actual = filtro.value;
      filtro.innerHTML = `<option value="">Todos los sistemas</option>${opciones}`;
      filtro.value = actual;
    }
  }

  function abrirModalSistema(sistema) {
    byId("sisId").value = sistema?.id || "";
    byId("sisCodigo").value = sistema?.codigo || "";
    byId("sisNombre").value = sistema?.nombre || "";
    byId("sisCategoria").value = sistema?.categoria || "";
    byId("sisCriticidad").value = CRITICIDAD[sistema?.criticidad] ? sistema.criticidad : "Media";
    byId("sisResponsable").value = sistema?.responsable || "";
    byId("sisDescripcion").value = sistema?.descripcion || "";
    byId("modalSistemaTitulo").textContent = sistema ? "Editar sistema" : "Nuevo sistema";
    byId("modalSistemaError").hidden = true;
    abrirModal("modalSistema");
  }

  async function guardarSistema(evento) {
    evento.preventDefault();
    const id = byId("sisId").value;
    const cuerpo = {
      codigo: byId("sisCodigo").value.trim(),
      nombre: byId("sisNombre").value.trim(),
      categoria: byId("sisCategoria").value.trim(),
      criticidad: byId("sisCriticidad").value,
      responsable: byId("sisResponsable").value.trim(),
      descripcion: byId("sisDescripcion").value.trim(),
    };

    try {
      await api(id ? `/api/sistemas/${id}` : "/api/sistemas", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      cerrarModal("modalSistema");
      await cargarSistemas();
    } catch (err) {
      const aviso = byId("modalSistemaError");
      aviso.textContent = err.message;
      aviso.hidden = false;
    }
  }

  async function eliminarSistema(id) {
    const sistema = estado.sistemas.find((s) => s.id === id);
    if (!sistema) return;
    if (!window.confirm(`¿Eliminar el sistema “${sistema.nombre}”? Las placas quedarán sin sistema.`)) {
      return;
    }
    try {
      await api(`/api/sistemas/${id}`, { method: "DELETE" });
      await cargarSistemas();
      await cargarEquipos(true);
    } catch (err) {
      mensaje("mensajeSistemas", err.message, "error");
    }
  }

  async function verPlacasDelSistema(id) {
    const sistema = estado.sistemas.find((s) => s.id === id);
    estado.filtroSistema = id;
    irAVista("placas");
    const contenedor = byId("listaPlacas");
    if (!contenedor) return;
    contenedor.innerHTML = '<p class="ws-vacio">Cargando placas del sistema…</p>';
    try {
      const datos = await api(`/api/equipos?sistema=${encodeURIComponent(id)}&limite=40`);
      renderizarPlacas(datos.equipos || [], sistema ? sistema.nombre : "Sistema");
    } catch (err) {
      contenedor.innerHTML = `<p class="ws-vacio">${escapar(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------------------
     PLACAS · búsqueda y vista 360°
     ------------------------------------------------------------ */

  function renderizarPlacas(equipos, contexto = "") {
    const contenedor = byId("listaPlacas");
    if (!contenedor) return;
    if (!equipos.length) {
      contenedor.innerHTML = `<p class="ws-vacio">Sin resultados${contexto ? ` en ${escapar(contexto)}` : ""}.</p>`;
      return;
    }
    contenedor.innerHTML = equipos
      .map(
        (equipo) => `
        <button type="button" class="ws-resultado${
          estado.placaActiva === equipo.placa ? " activo" : ""
        }" data-placa="${escapar(equipo.placa)}">
          <strong>${escapar(equipo.placa)}</strong>
          <span>${escapar([equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "Sin detalle")}</span>
          <span>${escapar(equipo.sede || "Sin sede")} · ${escapar(equipo.estado || "—")}${
            equipo.sistemas?.nombre ? ` · ${escapar(equipo.sistemas.nombre)}` : ""
          }</span>
        </button>`
      )
      .join("");
  }

  async function buscarPlacas(texto) {
    const consulta = String(texto || "").trim();
    estado.filtroSistema = "";
    if (consulta.length < 2) {
      byId("listaPlacas").innerHTML =
        '<p class="ws-vacio">Escribe al menos 2 caracteres para buscar por placa, serial o responsable.</p>';
      return;
    }
    try {
      const datos = await api(`/api/equipos?q=${encodeURIComponent(consulta)}&limite=30`);
      renderizarPlacas(datos.equipos || [], consulta);
    } catch (err) {
      byId("listaPlacas").innerHTML = `<p class="ws-vacio">${escapar(err.message)}</p>`;
    }
  }

  function nodo({ icono, titulo, detalle, meta, oro = false }) {
    return `
      <div class="ws-nodo${oro ? " ws-nodo-oro" : ""}" data-glow>
        <span class="ws-nodo-icono" aria-hidden="true">${icono}</span>
        <span class="ws-nodo-texto">
          <strong>${escapar(titulo)}</strong>
          <span>${escapar(detalle || "—")}</span>
        </span>
        ${meta ? `<span class="ws-nodo-meta">${escapar(meta)}</span>` : ""}
      </div>`;
  }

  async function abrirPlaca(placa) {
    const contenedor = byId("vista360");
    if (!contenedor) return;
    estado.placaActiva = placa;
    document.querySelectorAll(".ws-resultado").forEach((boton) => {
      boton.classList.toggle("activo", boton.dataset.placa === placa);
    });
    contenedor.innerHTML = `<p class="ws-vacio ws-360-vacio">Abriendo la vista 360° de ${escapar(placa)}…</p>`;

    try {
      const datos = await api(`/api/placas/${encodeURIComponent(placa)}`);
      renderizarVista360(datos);
    } catch (err) {
      contenedor.innerHTML = `<p class="ws-vacio ws-360-vacio">${escapar(err.message)}</p>`;
    }
  }

  function renderizarVista360(datos) {
    const contenedor = byId("vista360");
    const equipo = datos.equipo || {};
    const sistema = datos.sistema || {};
    const actas = datos.actas || [];
    const documentos = datos.documentos || [];
    const historial = datos.historial || [];

    const criticidad = CRITICIDAD[sistema.criticidad]?.etiqueta || "Sin sistema";

    const actasHtml = actas.length
      ? actas
          .map(
            (acta) => `
            <div class="ws-evento">
              <strong>ACTA-${escapar(acta.consecutivo)} · ${escapar(acta.tipo_acta)}</strong>
              <span>${escapar(acta.colaborador_nombre)} · ${escapar(acta.sede)}</span><br />
              <time>${fechaHora(acta.created_at)}</time>
              <button type="button" class="ws-boton ws-boton-mini" data-pdf="${escapar(acta.id)}">PDF</button>
            </div>`
          )
          .join("")
      : '<p class="ws-vacio">Sin actas emitidas.</p>';

    const docsHtml = documentos.length
      ? documentos
          .map(
            (documento) => `
            <button type="button" class="ws-doc-mini" data-doc="${escapar(documento.id)}">
              <span class="ws-doc-icono" style="width:26px;height:26px">${CATEGORIA_ICONO[documento.categoria] || "◫"}</span>
              <strong>${escapar(documento.titulo)}</strong>
              <span>${escapar(documento.categoria)} · ${fecha(documento.fecha_documento)}</span>
            </button>`
          )
          .join("")
      : '<p class="ws-vacio">Sin contratos ni facturas vinculadas.</p>';

    const historialHtml = historial.length
      ? historial
          .map(
            (mov) => `
            <div class="ws-evento">
              <strong>${escapar(mov.accion)}</strong>
              <span>${escapar(mov.detalle || "—")}</span><br />
              <time>${fechaHora(mov.created_at)} · ${escapar(mov.realizado_por || "sistema")}</time>
            </div>`
          )
          .join("")
      : '<p class="ws-vacio">Sin movimientos registrados.</p>';

    contenedor.innerHTML = `
      <div class="ws-360-cab">
        <div class="ws-360-placa">
          <div>
            <h2>${escapar(equipo.placa)}</h2>
            <p>${escapar([equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "Equipo sin detalle")}
              · ${escapar(equipo.sede || "Sin sede")}</p>
          </div>
        </div>
        <div class="ws-360-acciones">
          <button type="button" class="ws-boton ws-boton-rojo" data-accion="nueva-acta" data-placa-acta="${escapar(equipo.placa)}">
            Emitir acta
          </button>
          <button type="button" class="ws-boton ws-boton-oro" data-vincular="${escapar(documentos[0]?.id || "")}" data-placa-vincular="${escapar(equipo.placa)}">
            Vincular contrato
          </button>
          <button type="button" class="ws-boton" data-hoja-id="${escapar(equipo.id)}" data-hoja-placa="${escapar(equipo.placa)}">
            Hoja de vida
          </button>
        </div>
      </div>

      <div class="ws-arbol">
        ${nodo({
          icono: "◈",
          titulo: sistema.nombre || "Sin sistema asignado",
          detalle: sistema.descripcion || "Asigna esta placa a un ecosistema.",
          meta: criticidad,
          oro: true,
        })}
        <div class="ws-conector" aria-hidden="true"></div>
        ${nodo({
          icono: "⬡",
          titulo: equipo.placa,
          detalle: `Serial ${equipo.serial || "—"} · ${equipo.sede || "Sin sede"}`,
          meta: equipo.estado,
        })}
        <div class="ws-conector" aria-hidden="true"></div>
        ${nodo({
          icono: "▤",
          titulo: [equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "Equipo",
          detalle: equipo.usuario_asignado
            ? `Asignado a ${equipo.usuario_asignado}`
            : "Sin responsable asignado",
          meta: equipo.garantia_hasta ? `Garantía ${fecha(equipo.garantia_hasta)}` : "",
        })}
        <div class="ws-conector" aria-hidden="true"></div>
        ${nodo({
          icono: "◫",
          titulo: `${actas.length} acta(s) · ${documentos.length} documento(s)`,
          detalle: "Actas CORP-TEC-FR-002, contratos, facturas y garantías.",
          meta: "Evidencia",
          oro: true,
        })}
      </div>

      <div class="ws-360-grid">
        <div class="ws-bloque">
          <h3>Ficha del equipo</h3>
          <div class="ws-ficha">
            <div class="ws-ficha-item"><span>Estado</span><strong>${escapar(equipo.estado || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Responsable</span><strong>${escapar(equipo.usuario_asignado || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Cédula</span><strong>${escapar(equipo.usuario_cedula || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Serial</span><strong>${escapar(equipo.serial || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Sede</span><strong>${escapar(equipo.sede || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Garantía</span><strong>${fecha(equipo.garantia_hasta)}</strong></div>
            <div class="ws-ficha-item"><span>Nombre.red</span><strong>${escapar(equipo.nombre_equipo_red || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Empresa</span><strong>${escapar(equipo.empresa || "—")}</strong></div>
            <div class="ws-ficha-item"><span>CECO / Área</span><strong>${escapar([equipo.ceco, equipo.area].filter(Boolean).join(" · ") || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Contrato</span><strong>${escapar([equipo.numero_contrato, equipo.tipo_contrato].filter(Boolean).join(" · ") || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Vence contrato</span><strong>${fecha(equipo.fecha_vencimiento_contrato)}</strong></div>
            <div class="ws-ficha-item"><span>Procesador / RAM</span><strong>${escapar([equipo.procesador, equipo.memoria_ram].filter(Boolean).join(" · ") || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Disco</span><strong>${escapar(equipo.tamano_disco || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Proveedor</span><strong>${escapar(equipo.proveedor || "—")}</strong></div>
            <div class="ws-ficha-item"><span>Ruta acceso</span><strong>${escapar(equipo.ruta_acceso || "—")}</strong></div>
          </div>
        </div>
        <div class="ws-bloque">
          <h3>Actas emitidas</h3>
          <div class="ws-linea-tiempo">${actasHtml}</div>
        </div>
        <div class="ws-bloque">
          <h3>Contratos y documentos</h3>
          <div>${docsHtml}</div>
        </div>
        <div class="ws-bloque">
          <h3>Hoja de vida</h3>
          <div class="ws-linea-tiempo">${historialHtml}</div>
        </div>
      </div>`;
  }

  /* ------------------------------------------------------------
     EQUIPOS
     ------------------------------------------------------------ */

  function claseEstado(valor) {
    return ESTADO_EQUIPO[valor] || "baja";
  }

  function celdaGarantia(valor) {
    if (!valor) return '<span class="ws-garantia">—</span>';
    const dias = Math.ceil((new Date(valor).getTime() - Date.now()) / 86400000);
    if (Number.isNaN(dias)) return '<span class="ws-garantia">—</span>';
    if (dias < 0) {
      return `<span class="ws-garantia vencida">Vencida ${fecha(valor)}</span>`;
    }
    if (dias <= 60) {
      return `<span class="ws-garantia proxima">◈ ${fecha(valor)} (${dias} d)</span>`;
    }
    return `<span class="ws-garantia">${fecha(valor)}</span>`;
  }

  function filasEquipos(equipos) {
    if (!equipos.length) {
      return '<p class="ws-vacio">No hay equipos que coincidan con los filtros.</p>';
    }

    return `
      <table class="ws-tabla">
        <thead>
          <tr>
            <th>Placa</th><th>Nombre en Red</th><th>Equipo</th><th>Serial</th>
            <th>Responsable + Cédula</th><th>Empresa</th><th>Sede</th>
            <th>CECO</th><th>Área</th><th>Estado</th><th>Sistema</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${equipos
            .map(
              (equipo) => `
            <tr>
              <td><button type="button" class="ws-placa-link ws-mono" data-placa="${escapar(equipo.placa)}">${escapar(equipo.placa || "—")}</button></td>
              <td>${escapar(equipo.nombre_equipo_red || "—")}</td>
              <td>${escapar([equipo.tipo_equipo || equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ") || "—")}</td>
              <td class="ws-mono">${escapar(equipo.serial || "—")}</td>
              <td>${escapar([equipo.responsable || equipo.usuario_asignado, equipo.cedula_responsable || equipo.usuario_cedula].filter(Boolean).join(" · ") || "—")}</td>
              <td>${escapar(equipo.empresa || "—")}</td>
              <td>${escapar(equipo.sede || "—")}</td>
              <td class="ws-mono">${escapar(equipo.ceco || "—")}</td>
              <td>${escapar(equipo.area || "—")}</td>
              <td><span class="ws-etiqueta ${claseEstado(equipo.estado)}">${escapar(equipo.estado || "—")}</span></td>
              <td>${escapar(equipo.sistemas?.nombre || "—")}</td>
              <td>
                <button type="button" class="ws-boton ws-boton-mini" data-editar-equipo="${escapar(equipo.id)}">Editar</button>
                <button type="button" class="ws-boton ws-boton-mini" data-hoja-id="${escapar(equipo.id)}" data-hoja-placa="${escapar(equipo.placa)}">Hoja</button>
              </td>
            </tr>`
            )
            .join("")}
        </tbody>
      </table>`;
  }

  function pintarMetricas(datos) {
    const resumen = datos.resumen || {};
    byId("metricaTotal").textContent = numero(resumen.total ?? datos.total);

    const porEstado = resumen.porEstado || {};
    const estadosOrdenados = Object.entries(porEstado).sort((a, b) => b[1] - a[1]);
    const destinos = [
      ["metricaDisponibles", "metricaDisponiblesLabel"],
      ["metricaAsignados", "metricaAsignadosLabel"],
      ["metricaMantenimiento", "metricaMantenimientoLabel"],
    ];

    destinos.forEach(([valorId, etiquetaId], indice) => {
      const valor = byId(valorId);
      const etiqueta = byId(etiquetaId);
      const [estado, cantidad] = estadosOrdenados[indice] || ["Sin registros", 0];
      if (valor) valor.textContent = numero(cantidad);
      if (etiqueta) etiqueta.textContent = estado;
    });
  }

  function sedeActualSelect(equipos) {
    const select = byId("invSede");
    if (!select) return;
    const actual = select.value;
    const sedes = new Set([...(datosSedesCache || [])]);
    (equipos || []).forEach((equipo) => equipo.sede && sedes.add(equipo.sede));
    if (!sedes.size) return;
    select.innerHTML =
      '<option value="">Todas las sedes</option>' +
      [...sedes]
        .sort((a, b) => a.localeCompare(b, "es"))
        .map((sede) => `<option value="${escapar(sede)}">${escapar(sede)}</option>`)
        .join("");
    select.value = actual;
  }

  let datosSedesCache = new Set();

  async function cargarEquipos(reiniciar = true) {
    const contenedor = byId("tablaInventario");
    if (!contenedor) return;

    if (reiniciar) {
      estado.pagina = 1;
      estado.equipos = [];
    }

    const parametros = new URLSearchParams();
    const q = byId("invBuscar")?.value.trim() || "";
    const sede = byId("invSede")?.value || "";
    const ceco = byId("invCeco")?.value || "";
    const empresa = byId("invEmpresa")?.value || "";
    const estadoFiltro = byId("invEstado")?.value || "";
    const sistema = byId("invSistema")?.value || "";
    if (q) parametros.set("q", q);
    if (sede) parametros.set("sede", sede);
    if (ceco) parametros.set("ceco", ceco);
    if (empresa) parametros.set("empresa", empresa);
    if (estadoFiltro) parametros.set("estado", estadoFiltro);
    if (sistema) parametros.set("sistema", sistema);
    parametros.set("limite", String(estado.limite));
    parametros.set("pagina", String(estado.pagina));

    mensaje("inventarioMensaje", "Consultando el inventario…");

    try {
      const datos = await api(`/api/equipos?${parametros}`);
      estado.equipos = reiniciar
        ? datos.equipos || []
        : [...estado.equipos, ...(datos.equipos || [])];
      estado.total = Number(datos.total) || estado.equipos.length;
      estado.cargado.equipos = true;

      pintarMetricas(datos);
      const selectorEstado = byId("invEstado");
      if (selectorEstado && datos.resumen?.porEstado) {
        const actualEstado = selectorEstado.value;
        const estados = Object.keys(datos.resumen.porEstado).sort((a, b) => a.localeCompare(b, "es"));
        selectorEstado.innerHTML =
          '<option value="">Todos los estados</option>' +
          estados
            .map((estado) => `<option value="${escapar(estado)}">${escapar(estado)}</option>`)
            .join("");
        selectorEstado.value = actualEstado;
      }
      (datos.equipos || []).forEach((equipo) => {
        if (equipo.sede) datosSedesCache.add(equipo.sede);
      });
      sedeActualSelect(datos.equipos);

      const poblarSelect = (id, valor) => {
        const select = byId(id);
        if (!select || !valor) return;
        const opciones = [...select.options].map((opcion) => opcion.value);
        if (opciones.includes(valor)) return;
        select.add(new Option(valor, valor));
      };
      (datos.equipos || []).forEach((equipo) => {
        poblarSelect("invCeco", equipo.ceco);
        poblarSelect("invEmpresa", equipo.empresa);
      });

      contenedor.innerHTML = filasEquipos(estado.equipos);
      mensaje("inventarioMensaje", `${numero(estado.equipos.length)} de ${numero(estado.total)} equipo(s).`);

      const mas = byId("btnMasEquipos");
      if (mas) mas.hidden = estado.equipos.length >= estado.total;
    } catch (err) {
      contenedor.innerHTML = "";
      mensaje("inventarioMensaje", err.message, "error");
    }
  }

  function abrirModalEquipo(equipo) {
    const poner = (id, valor) => {
      const campo = byId(id);
      if (campo) campo.value = valor ?? "";
    };

    byId("eqId").value = equipo?.id || "";
    byId("eqPlaca").disabled = Boolean(equipo?.id);
    poner("eqPlaca", equipo?.placa);
    poner("eqTipo", equipo?.tipo_equipo || equipo?.tipo);
    poner("eqMarca", equipo?.marca);
    poner("eqModelo", equipo?.modelo);
    poner("eqSerial", equipo?.serial);
    poner("eqEstado", equipo?.estado);
    byId("eqSistema").value = equipo?.sistema_id || "";
    poner("eqSede", equipo?.sede);
    poner("eqUsuario", equipo?.responsable || equipo?.usuario_asignado);
    poner("eqCedula", equipo?.cedula_responsable || equipo?.usuario_cedula);
    poner("eqGarantia", equipo?.garantia_hasta);
    poner("eqObservaciones", equipo?.observaciones);

    poner("eqNombreRed", equipo?.nombre_equipo_red);
    poner("eqEmpresa", equipo?.empresa);
    poner("eqCeco", equipo?.ceco);
    poner("eqArea", equipo?.area);
    poner("eqProveedor", equipo?.proveedor);
    poner("eqNumeroContrato", equipo?.numero_contrato);
    poner("eqTipoContrato", equipo?.tipo_contrato);
    poner("eqFechaVencimiento", equipo?.fecha_vencimiento_contrato);
    poner("eqProcesador", equipo?.procesador);
    poner("eqMemoriaRam", equipo?.memoria_ram);
    poner("eqTamanoDisco", equipo?.tamano_disco);
    poner("eqAccesorios", equipo?.accesorios_entregados);
    poner("eqBitacora", equipo?.bitacora_equipo);
    poner("eqCreadoPor", equipo?.creado_por);
    poner("eqModificadoPor", equipo?.modificado_por);
    poner("eqModificadoFecha", equipo?.modificado_fecha ? String(equipo.modificado_fecha).slice(0, 16) : "");
    poner("eqTipoElemento", equipo?.tipo_elemento);
    poner("eqRutaAcceso", equipo?.ruta_acceso);

    const estados = [...new Set(estado.equipos.map((item) => item.estado).filter(Boolean))];
    const lista = byId("listaEstadosEquipo");
    if (lista) {
      lista.innerHTML = estados
        .sort((a, b) => a.localeCompare(b, "es"))
        .map((estadoValor) => `<option value="${escapar(estadoValor)}"></option>`)
        .join("");
    }

    byId("modalEquipoTitulo").textContent = equipo ? "Editar equipo" : "Nuevo equipo";
    byId("modalEquipoError").hidden = true;
    abrirModal("modalEquipo");
  }

  async function guardarEquipo(evento) {
    evento.preventDefault();
    const id = byId("eqId").value;
    const valor = (idCampo) => byId(idCampo)?.value.trim() || null;

    const tipoEquipo = valor("eqTipo");
    const cuerpo = {
      placa: valor("eqPlaca"),
      tipo: tipoEquipo,
      tipo_equipo: tipoEquipo,
      nombre_equipo_red: valor("eqNombreRed"),
      serial: valor("eqSerial"),
      responsable: valor("eqUsuario"),
      cedula_responsable: valor("eqCedula"),
      empresa: valor("eqEmpresa"),
      sede: valor("eqSede"),
      ceco: valor("eqCeco"),
      area: valor("eqArea"),
      estado: valor("eqEstado"),
      proveedor: valor("eqProveedor"),
      numero_contrato: valor("eqNumeroContrato"),
      tipo_contrato: valor("eqTipoContrato"),
      fecha_vencimiento_contrato: byId("eqFechaVencimiento")?.value || null,
      marca: valor("eqMarca"),
      modelo: valor("eqModelo"),
      procesador: valor("eqProcesador"),
      memoria_ram: valor("eqMemoriaRam"),
      tamano_disco: valor("eqTamanoDisco"),
      accesorios_entregados: valor("eqAccesorios"),
      bitacora_equipo: valor("eqBitacora"),
      creado_por: valor("eqCreadoPor"),
      modificado_por: valor("eqModificadoPor"),
      modificado_fecha: byId("eqModificadoFecha")?.value || null,
      tipo_elemento: valor("eqTipoElemento"),
      ruta_acceso: valor("eqRutaAcceso"),
      usuario_asignado: valor("eqUsuario"),
      usuario_cedula: valor("eqCedula"),
      garantia_hasta: byId("eqGarantia")?.value || null,
      observaciones: valor("eqObservaciones"),
      sistema_id: byId("eqSistema")?.value || null,
    };

    try {
      await api(id ? `/api/equipos/${id}` : "/api/equipos", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      cerrarModal("modalEquipo");
      await Promise.all([cargarEquipos(), cargarSistemas()]);
    } catch (err) {
      const aviso = byId("modalEquipoError");
      aviso.textContent = err.message;
      aviso.hidden = false;
    }
  }

  async function importarArchivo(archivo) {
    if (!archivo) return;
    const cuerpo = new FormData();
    cuerpo.append("archivo", archivo);
    mensaje("inventarioMensaje", "Importando y sincronizando placas…");
    try {
      const resultado = await api("/api/equipos/importar-excel", {
        method: "POST",
        body: cuerpo,
      });
      mensaje(
        "inventarioMensaje",
        `Importación terminada · leídos: ${numero(resultado.totalLeidos)}, ` +
          `procesados: ${numero(resultado.procesados)}, errores: ${numero(resultado.errores)}`,
        "ok"
      );
      await Promise.all([cargarEquipos(), cargarSistemas()]);
    } catch (err) {
      mensaje("inventarioMensaje", `No se pudo importar: ${err.message}`, "error");
    }
  }

  async function descargarRespaldo(formato) {
    const aviso = byId("adminMensaje");
    mensaje("adminMensaje", "Generando respaldo completo…");
    try {
      const respuesta = await fetch(`/api/admin/respaldo-completo?formato=${formato}`, {
        cache: "no-store",
      });
      if (!respuesta.ok) {
        const datos = await respuesta.json().catch(() => ({}));
        throw new Error(datos.error || `Error HTTP ${respuesta.status}`);
      }
      const bytes = await respuesta.blob();
      const disposicion = respuesta.headers.get("content-disposition") || "";
      const coincidencia = /filename="?([^";]+)"?/.exec(disposicion);
      const extension = formato === "xlsx" ? "xlsx" : "json";
      const nombre =
        coincidencia?.[1] || `Respaldo_Levapan_${new Date().toISOString().slice(0, 10)}.${extension}`;

      const url = URL.createObjectURL(bytes);
      const enlace = document.createElement("a");
      enlace.href = url;
      enlace.download = nombre;
      document.body.appendChild(enlace);
      enlace.click();
      enlace.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      mensaje("adminMensaje", `Respaldo descargado: ${nombre}`, "ok");
    } catch (err) {
      mensaje("adminMensaje", `No se pudo generar el respaldo: ${err.message}`, "error");
      if (aviso) aviso.className = "ws-mensaje error";
    }
  }

  async function exportarExcel() {
    mensaje("inventarioMensaje", "Generando respaldo gerencial…");
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
      mensaje("inventarioMensaje", "Respaldo descargado.", "ok");
    } catch (err) {
      mensaje("inventarioMensaje", `No se pudo exportar: ${err.message}`, "error");
    }
  }

  function abrirHojaDeVida(id, placa) {
    abrirModal("modalHistorial");
    const contenedor = byId("modalHistorialContenido");
    contenedor.innerHTML = `<p class="ws-vacio">Cargando trazabilidad de ${escapar(placa)}…</p>`;
    api(`/api/equipos/${id}/historial`)
      .then((datos) => {
        const equipo = datos.equipo || {};
        const datosFicha = [
          ["Placa", equipo.placa],
          ["Nombre en Red", equipo.nombre_equipo_red],
          ["Serial", equipo.serial],
          ["Marca / Modelo", [equipo.marca, equipo.modelo].filter(Boolean).join(" · ")],
          ["Responsable", equipo.responsable || equipo.usuario_asignado],
          ["Cédula", equipo.cedula_responsable || equipo.usuario_cedula],
          ["CECO", equipo.ceco],
          ["Sede", equipo.sede],
          ["Estado", equipo.estado],
        ];

        const eventos = (datos.lineaTiempo || [])
          .map((evento) => {
            const dato = evento.data || {};
            if (evento.tipo === "acta") {
              return `<div class="ws-evento">
                <strong>ACTA-${escapar(dato.consecutivo)} · ${escapar(dato.tipo_acta)}</strong>
                <span>${escapar(dato.colaborador_nombre)} · ${escapar(dato.sede)}</span><br />
                <time>${fechaHora(dato.created_at)}</time>
                <button type="button" class="ws-boton ws-boton-mini" data-pdf="${escapar(dato.id)}">PDF</button>
              </div>`;
            }
            if (evento.tipo === "documento") {
              return `<div class="ws-evento">
                <strong>Documento · ${escapar(dato.categoria)}</strong>
                <span>${escapar(dato.titulo)}</span><br />
                <time>${fechaHora(dato.created_at)}</time>
                <button type="button" class="ws-boton ws-boton-mini" data-doc="${escapar(dato.id)}">Abrir PDF</button>
              </div>`;
            }
            return `<div class="ws-evento">
              <strong>${escapar(dato.tipo_movimiento || dato.accion || "Movimiento")}</strong>
              <span>${escapar(dato.descripcion || dato.detalle || "—")}</span><br />
              <time>${fechaHora(dato.created_at)} · ${escapar(
                dato.usuario_nombre || dato.realizado_por || "sistema"
              )}${dato.usuario_email ? ` · ${escapar(dato.usuario_email)}` : ""}</time>
            </div>`;
          })
          .join("");

        contenedor.innerHTML = `
          <div class="ws-hv-ficha">
            ${datosFicha
              .map(
                ([etiqueta, valor]) => `
              <div class="ws-ficha-item"><span>${escapar(etiqueta)}</span><strong>${escapar(valor || "—")}</strong></div>`
              )
              .join("")}
          </div>

          <form id="formNovedadEquipo" class="ws-hv-form" autocomplete="off">
            <h4>+ Agregar novedad / mantenimiento</h4>
            <div class="ws-hv-form-grid">
              <label>Tipo
                <select id="novedadTipo" name="tipo">
                  <option>Mantenimiento preventivo</option>
                  <option>Reparación</option>
                  <option>Cambio de accesorio</option>
                  <option>Novedad</option>
                </select>
              </label>
              <label>Fecha y hora
                <input type="datetime-local" id="novedadFecha" name="fecha" />
              </label>
              <label class="ws-ancho">Observación
                <textarea id="novedadObservacion" name="observacion" rows="2" required placeholder="Detalle de la novedad"></textarea>
              </label>
            </div>
            <button type="submit" class="ws-boton ws-boton-rojo">Registrar novedad</button>
            <span id="novedadMensaje" class="ws-mensaje"></span>
          </form>

          <h4>Hoja de vida cronológica</h4>
          <div class="ws-linea-tiempo">${eventos || '<p class="ws-vacio">Sin movimientos registrados.</p>'}</div>`;

        const formulario = byId("formNovedadEquipo");
        formulario?.addEventListener("submit", async (evento) => {
          evento.preventDefault();
          const mensaje = byId("novedadMensaje");
          if (mensaje) mensaje.textContent = "Registrando…";
          try {
            await api(`/api/equipos/${id}/novedades`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tipo: byId("novedadTipo")?.value || "Novedad",
                observacion: byId("novedadObservacion")?.value.trim() || "",
                fecha: byId("novedadFecha")?.value || null,
              }),
            });
            window.dispatchEvent(new CustomEvent("ti-datos-actualizados"));
            abrirHojaDeVida(id, placa);
          } catch (err) {
            if (mensaje) {
              mensaje.textContent = err.message;
              mensaje.className = "ws-mensaje error";
            }
          }
        });
      })
      .catch((err) => {
        contenedor.innerHTML = `<p class="ws-vacio">${escapar(err.message)}</p>`;
      });
  }

  async function abrirPdfActa(id) {
    try {
      const datos = await api(`/api/actas/${id}/pdf`);
      window.open(datos.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      window.alert(`No se pudo abrir el PDF: ${err.message}`);
    }
  }

  /* ------------------------------------------------------------
     BÓVEDA
     ------------------------------------------------------------ */

  function tarjetaDocumento(documento) {
    const vinculos = documento.vinculos || [];
    const placas = [...new Set(vinculos.map((v) => v.placa).filter(Boolean))];
    return `
      <article class="ws-doc${estado.documentoActivo === documento.id ? " activo" : ""}" data-glow data-doc="${escapar(documento.id)}">
        <span class="ws-doc-icono" aria-hidden="true">${CATEGORIA_ICONO[documento.categoria] || "◫"}</span>
        <span class="ws-doc-info">
          <strong>${escapar(documento.titulo)}</strong>
          <small>${escapar(documento.proveedor || "Sin proveedor")} · ${fecha(documento.fecha_documento)}</small>
          <small>${placas.length ? `Placas: ${escapar(placas.slice(0, 3).join(", "))}${placas.length > 3 ? "…" : ""}` : "Sin vínculos"}</small>
        </span>
        <span class="ws-doc-cat">${escapar(documento.categoria)}</span>
      </article>`;
  }

  async function cargarBoveda() {
    const contenedor = byId("listaDocumentos");
    if (!contenedor) return;
    if (!estado.documentos.length) {
      contenedor.innerHTML = '<p class="ws-vacio">Cargando documentos…</p>';
    }

    const parametros = new URLSearchParams();
    const q = byId("bovedaBuscar")?.value.trim() || "";
    const categoria = byId("bovedaCategoria")?.value || "";
    if (q) parametros.set("q", q);
    if (categoria) parametros.set("categoria", categoria);

    try {
      const datos = await api(`/api/boveda?${parametros}`);
      estado.documentos = datos.documentos || [];
      estado.cargado.boveda = true;
      contenedor.innerHTML =
        estado.documentos.map(tarjetaDocumento).join("") ||
        '<p class="ws-vacio">La Bóveda está vacía. Sube el primer contrato o factura.</p>';
      mensaje(
        "bovedaMensaje",
        `${numero(datos.total)} documento(s)${q ? ` para “${q}”` : ""}.`,
        "ok"
      );
    } catch (err) {
      contenedor.innerHTML = "";
      mensaje("bovedaMensaje", err.message, "error");
    }
  }

  let temporizadorBoveda = null;

  async function previsualizarDocumento(id) {
    estado.documentoActivo = id;
    document.querySelectorAll(".ws-doc").forEach((doc) => {
      doc.classList.toggle("activo", doc.dataset.doc === id);
    });

    const visor = byId("visorBoveda");
    if (!visor) return;
    visor.innerHTML = '<p class="ws-vacio ws-360-vacio">Firmando URL segura…</p>';

    try {
      const datos = await api(`/api/boveda/${id}/url`);
      const documento = datos.documento || {};
      const esImagen = String(documento.mime_type || "").startsWith("image/");
      const cuerpo = esImagen
        ? `<img src="${escapar(datos.url)}" alt="${escapar(documento.titulo)}" style="width:100%;height:auto" />`
        : `<iframe src="${escapar(datos.url)}" title="${escapar(documento.titulo)}" loading="lazy"></iframe>`;

      visor.innerHTML = `
        <div class="ws-visor-cab">
          <div>
            <h3>${escapar(documento.titulo)}</h3>
            <span>${escapar(documento.categoria)} · ${fecha(documento.fecha_documento)} · ${numero(documento.tamano_bytes)} bytes</span>
          </div>
          <div class="ws-visor-acciones">
            <button type="button" class="ws-boton ws-boton-mini" data-vincular="${escapar(documento.id)}">Vincular</button>
            <a class="ws-boton ws-boton-mini" href="${escapar(datos.url)}" target="_blank" rel="noopener noreferrer">Abrir</a>
            ${
              estado.perfil?.rol === "admin"
                ? `<button type="button" class="ws-boton ws-boton-mini" data-eliminar-doc="${escapar(documento.id)}">Eliminar</button>`
                : ""
            }
          </div>
        </div>
        ${cuerpo}`;
    } catch (err) {
      visor.innerHTML = `<p class="ws-vacio ws-360-vacio">${escapar(err.message)}</p>`;
    }
  }

  async function eliminarDocumento(id) {
    if (!window.confirm("¿Eliminar este documento de la Bóveda? Esta acción no se puede deshacer.")) {
      return;
    }
    try {
      await api(`/api/boveda/${id}`, { method: "DELETE" });
      estado.documentoActivo = null;
      byId("visorBoveda").innerHTML =
        '<p class="ws-vacio ws-360-vacio"><strong>Visor PDF</strong><span>Documento eliminado.</span></p>';
      await cargarBoveda();
    } catch (err) {
      window.alert(`No se pudo eliminar: ${err.message}`);
    }
  }

  function abrirModalVinculo(documentoId, placa) {
    if (!documentoId) {
      window.alert("Selecciona primero un documento de la Bóveda para vincularlo.");
      return;
    }
    byId("vinDocumentoId").value = documentoId;
    byId("vinPlacas").value = placa || "";
    byId("modalVinculoError").hidden = true;
    const select = byId("vinSistemas");
    if (select) [...select.options].forEach((opcion) => (opcion.selected = false));
    abrirModal("modalVinculo");
  }

  async function guardarVinculo(evento) {
    evento.preventDefault();
    const id = byId("vinDocumentoId").value;
    const placas = byId("vinPlacas").value.trim();
    const sistemas = [...(byId("vinSistemas").selectedOptions || [])].map((o) => o.value);

    if (!placas && !sistemas.length) {
      const aviso = byId("modalVinculoError");
      aviso.textContent = "Indica una placa o un sistema.";
      aviso.hidden = false;
      return;
    }

    try {
      await api(`/api/boveda/${id}/vinculos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placas, sistemas }),
      });
      cerrarModal("modalVinculo");
      await cargarBoveda();
      if (estado.placaActiva) await abrirPlaca(estado.placaActiva);
    } catch (err) {
      const aviso = byId("modalVinculoError");
      aviso.textContent = err.message;
      aviso.hidden = false;
    }
  }

  async function subirDocumento(evento) {
    evento.preventDefault();
    const archivo = byId("bovArchivo").files?.[0];
    if (!archivo) return;

    const cuerpo = new FormData();
    cuerpo.append("archivo", archivo);
    cuerpo.append("titulo", byId("bovTitulo").value.trim());
    cuerpo.append("categoria", byId("bovCategoria").value);
    cuerpo.append("proveedor", byId("bovProveedor").value.trim());
    cuerpo.append("numero_referencia", byId("bovReferencia").value.trim());
    cuerpo.append("fecha_documento", byId("bovFecha").value || "");
    cuerpo.append("fecha_vencimiento", byId("bovVence").value || "");
    cuerpo.append("placas", byId("bovPlacas").value.trim());
    cuerpo.append(
      "sistemas",
      [...(byId("bovSistemas").selectedOptions || [])].map((o) => o.value).join(",")
    );

    const aviso = byId("modalBovedaError");
    aviso.hidden = true;
    const boton = evento.target.querySelector('button[type="submit"]');
    if (boton) {
      boton.disabled = true;
      boton.textContent = "Archivando…";
    }

    try {
      const datos = await api("/api/boveda", { method: "POST", body: cuerpo });
      cerrarModal("modalBoveda");
      byId("formBoveda").reset();
      await Promise.all([cargarBoveda(), cargarSistemas()]);
      mensaje("bovedaMensaje", datos.mensaje || "Documento archivado.", "ok");
      if (datos.documento?.id) previsualizarDocumento(datos.documento.id);
    } catch (err) {
      aviso.textContent = err.message;
      aviso.hidden = false;
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.textContent = "Archivar documento";
      }
    }
  }

  /* ------------------------------------------------------------
     CAJÓN DEL ACTA
     ------------------------------------------------------------ */

  function abrirDrawerActa(placa) {
    const drawer = byId("drawerActa");
    if (!drawer) return;
    drawer.hidden = false;
    document.body.style.overflow = "hidden";

    if (placa) {
      const campo = byId("placa");
      if (campo) {
        campo.value = placa;
        campo.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    setTimeout(() => {
      const foco = byId("nombre");
      if (foco) foco.focus({ preventScroll: true });
      const caja = drawer.querySelector(".ws-drawer-cuerpo");
      if (caja) caja.scrollTop = 0;
    }, 220);
  }

  function cerrarDrawerActa() {
    const drawer = byId("drawerActa");
    if (drawer) drawer.hidden = true;
    document.body.style.overflow = "";
  }

  /* ------------------------------------------------------------
     Eventos globales
     ------------------------------------------------------------ */

  function burbujaAsistente(texto, quien) {
    const contenedor = byId("wsAsistenteMensajes");
    if (!contenedor) return;
    const burbuja = document.createElement("div");
    burbuja.className = `ws-chat-burbuja ${quien}`;
    burbuja.textContent = texto;
    contenedor.appendChild(burbuja);
    contenedor.scrollTop = contenedor.scrollHeight;
  }

  function tarjetaEquipoAsistente(equipo) {
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
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="asignar" data-chat-placa="${escapar(placa)}">Asignar</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="disponible" data-chat-placa="${escapar(placa)}">Marcar Disponible</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="ficha" data-chat-placa="${escapar(placa)}">Ver Ficha</button>
        <button type="button" class="ws-boton ws-boton-mini" data-chat-accion="abrir-acta" data-chat-placa="${escapar(placa)}">Generar Acta</button>
      </div>`;
    return tarjeta;
  }

  function tarjetaDocumentosAsistente(documentos) {
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

  async function enviarTextoAsistente(texto) {
    const mensaje = String(texto || "").trim();
    if (!mensaje) return;
    const contenedor = byId("wsAsistenteMensajes");
    burbujaAsistente(mensaje, "usuario");

    const espera = document.createElement("div");
    espera.className = "ws-chat-burbuja asistente";
    espera.textContent = "Consultando el inventario…";
    contenedor?.appendChild(espera);
    if (contenedor) contenedor.scrollTop = contenedor.scrollHeight;

    try {
      const datos = await api("/api/asistente-ti", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mensaje }),
      });
      espera.textContent = datos.mensaje || "Listo.";
      if (datos.equipo) contenedor?.appendChild(tarjetaEquipoAsistente(datos.equipo));
      const tarjetaDocs = tarjetaDocumentosAsistente(datos.documentos);
      if (tarjetaDocs) contenedor?.appendChild(tarjetaDocs);
      if (datos.tipo === "accion_acta" && datos.placa) {
        const boton = document.createElement("button");
        boton.type = "button";
        boton.className = "ws-boton ws-boton-rojo";
        boton.dataset.chatAccion = "abrir-acta";
        boton.dataset.chatPlaca = datos.placa;
        boton.textContent = "Abrir acta con datos precargados";
        contenedor?.appendChild(boton);
      }
      if (["modificacion", "vinculacion", "resumen", "accion_acta"].includes(datos.tipo)) {
        await Promise.all([cargarEquipos(), cargarSistemas()]);
        burbujaAsistente("Tabla y contadores actualizados automáticamente.", "asistente");
      }
    } catch (err) {
      espera.textContent = `No pude completar la orden: ${err.message}`;
    } finally {
      if (contenedor) contenedor.scrollTop = contenedor.scrollHeight;
    }
  }

  function alternarAsistente(abrir) {
    const panel = byId("wsAsistentePanel");
    if (!panel) return;
    panel.hidden = abrir === false ? true : panel.hidden;
    if (!panel.hidden) byId("wsAsistenteInput")?.focus();
  }

  function inicializarEventos() {
    byId("formSistema")?.addEventListener("submit", guardarSistema);
    byId("formEquipo")?.addEventListener("submit", guardarEquipo);
    byId("formBoveda")?.addEventListener("submit", subirDocumento);
    byId("formVinculo")?.addEventListener("submit", guardarVinculo);
    byId("formAdminUsuario")?.addEventListener("submit", crearUsuarioAdmin);

    instalarAutocompletado({
      inputId: "placaBuscar",
      minChars: 2,
      alSeleccionar: (equipo) => {
        estado.filtroSistema = "";
        abrirPlaca(equipo.placa);
      },
    });

    let temporizadorFiltro = null;
    byId("invBuscar")?.addEventListener("input", () => {
      clearTimeout(temporizadorFiltro);
      temporizadorFiltro = setTimeout(() => cargarEquipos(), 340);
    });

    instalarAutocompletado({
      inputId: "invBuscar",
      minChars: 2,
      alSeleccionar: (equipo) => {
        irAVista("placas");
        abrirPlaca(equipo.placa);
      },
    });

    instalarAutocompletado({
      inputId: "eqPlaca",
      minChars: 2,
      autocompletarExacto: true,
      alSeleccionar: (equipo) => asignarCamposEquipo(equipo),
    });

    instalarAutorrellenoActa();

    ["invSede", "invCeco", "invEmpresa", "invEstado", "invSistema"].forEach((id) => {
      byId(id)?.addEventListener("change", () => cargarEquipos());
    });

    byId("bovedaBuscar")?.addEventListener("input", () => {
      clearTimeout(temporizadorBoveda);
      temporizadorBoveda = setTimeout(cargarBoveda, 340);
    });
    byId("bovedaCategoria")?.addEventListener("change", cargarBoveda);

    byId("archivoImportar")?.addEventListener("change", (evento) => {
      importarArchivo(evento.target.files?.[0]);
      evento.target.value = "";
    });

    byId("btnMasEquipos")?.addEventListener("click", () => {
      estado.pagina += 1;
      cargarEquipos(false);
    });

    document.querySelectorAll(".ws-tab").forEach((boton) => {
      boton.addEventListener("click", () => irAVista(boton.dataset.vista));
    });

    byId("btnMenuMovil")?.addEventListener("click", (evento) => {
      evento.stopPropagation();
      byId("wsSidebar")?.classList.toggle("abierto");
    });

    window.addEventListener("resize", posicionarIndicador);

    document.addEventListener("click", (evento) => {
      if (!evento.target.closest("#wsSidebar") && !evento.target.closest("#btnMenuMovil")) {
        byId("wsSidebar")?.classList.remove("abierto");
      }

      const cerrar = evento.target.closest("[data-cerrar]");
      if (cerrar) {
        cerrarModal(cerrar.dataset.cerrar);
        return;
      }

      if (evento.target.closest("[data-cerrar-drawer]")) {
        cerrarDrawerActa();
        return;
      }

      const accion = evento.target.closest("[data-accion]");
      if (accion) {
        const tipo = accion.dataset.accion;
        if (tipo === "nuevo-sistema") return abrirModalSistema(null);
        if (tipo === "nuevo-equipo") return abrirModalEquipo(null);
        if (tipo === "nueva-acta") {
          const placa = accion.dataset.placaActa || estado.placaActiva || "";
          return abrirDrawerActa(placa);
        }
        if (tipo === "importar") return byId("archivoImportar")?.click();
        if (tipo === "exportar") return exportarExcel();
        if (tipo === "respaldo-json") return descargarRespaldo("json");
        if (tipo === "respaldo-excel") return descargarRespaldo("xlsx");
        if (tipo === "subir-documento") {
          byId("modalBovedaError").hidden = true;
          return abrirModal("modalBoveda");
        }
        if (tipo === "vincular-doc") {
          return abrirModalVinculo(accion.dataset.vincular, accion.dataset.placaVincular);
        }
      }

      const editarSistema = evento.target.closest("[data-editar-sistema]");
      if (editarSistema) {
        const sistema = estado.sistemas.find((s) => s.id === editarSistema.dataset.editarSistema);
        return abrirModalSistema(sistema || null);
      }

      const eliminarSis = evento.target.closest("[data-eliminar-sistema]");
      if (eliminarSis) return eliminarSistema(eliminarSis.dataset.eliminarSistema);

      const tarjeta = evento.target.closest("[data-sistema]");
      if (tarjeta && !evento.target.closest("button")) {
        return verPlacasDelSistema(tarjeta.dataset.sistema);
      }

      const vincular = evento.target.closest("[data-vincular]");
      if (vincular) {
        return abrirModalVinculo(
          vincular.dataset.vincular,
          vincular.dataset.placaVincular || estado.placaActiva || ""
        );
      }

      const placa = evento.target.closest("[data-placa]");
      if (placa) {
        if (estado.vista !== "placas") irAVista("placas");
        return abrirPlaca(placa.dataset.placa);
      }

      const doc = evento.target.closest("[data-doc]");
      if (doc) {
        if (estado.vista !== "boveda") irAVista("boveda");
        return previsualizarDocumento(doc.dataset.doc);
      }

      const editarEquipo = evento.target.closest("[data-editar-equipo]");
      if (editarEquipo) {
        const equipo = estado.equipos.find((e) => e.id === editarEquipo.dataset.editarEquipo);
        return abrirModalEquipo(equipo || null);
      }

      const hoja = evento.target.closest("[data-hoja-id]");
      if (hoja) return abrirHojaDeVida(hoja.dataset.hojaId, hoja.dataset.hojaPlaca);

      const pdf = evento.target.closest("[data-pdf]");
      if (pdf) return abrirPdfActa(pdf.dataset.pdf);

      const eliminarDoc = evento.target.closest("[data-eliminar-doc]");
      if (eliminarDoc) return eliminarDocumento(eliminarDoc.dataset.eliminarDoc);

      const guardarUsuario = evento.target.closest("[data-guardar-usuario]");
      if (guardarUsuario) {
        return guardarUsuarioAdmin(
          guardarUsuario.dataset.guardarUsuario,
          guardarUsuario.closest("tr")
        );
      }

      const eliminarUsuario = evento.target.closest("[data-eliminar-usuario]");
      if (eliminarUsuario) return eliminarUsuarioAdmin(eliminarUsuario.dataset.eliminarUsuario);
    });

    document.querySelectorAll(".ws-modal").forEach((modal) => {
      modal.addEventListener("click", (evento) => {
        if (evento.target === modal) modal.hidden = true;
      });
    });

    document.addEventListener("keydown", (evento) => {
      if (evento.key !== "Escape") return;
      const drawer = byId("drawerActa");
      if (drawer && !drawer.hidden) {
        cerrarDrawerActa();
        return;
      }
      document.querySelectorAll(".ws-modal").forEach((modal) => {
        modal.hidden = true;
      });
    });

    window.addEventListener("auth-listo", () => {
      cargarDatosIniciales();
    });

    window.addEventListener("ti-datos-actualizados", () => {
      Promise.all([cargarEquipos(), cargarSistemas(), cargarBoveda()]);
    });
    window.addEventListener("ti-abrir-placa", (evento) => {
      const placa = evento.detail?.placa;
      if (!placa) return;
      irAVista("placas");
      abrirPlaca(placa);
    });
    window.addEventListener("ti-abrir-acta", (evento) => {
      abrirDrawerActa(evento.detail?.placa || "");
    });
    window.addEventListener("ti-abrir-historial", (evento) => {
      abrirHojaDeVida(evento.detail?.id, evento.detail?.placa);
    });
    window.addEventListener("ti-abrir-documento", (evento) => {
      irAVista("boveda");
      previsualizarDocumento(evento.detail?.id);
    });

    // Cuando inventario-storage.js confirma el acta, se refrescan los módulos.
    const envioStatus = byId("envioStatus");
    if (envioStatus) {
      let ultimoAviso = "";
      new MutationObserver(() => {
        const texto = (envioStatus.textContent || "").trim();
        if (!texto || texto === ultimoAviso) return;
        if (!envioStatus.classList.contains("ok") && !/guardad|generad|éxito|exito/i.test(texto)) {
          return;
        }
        ultimoAviso = texto;
        if (estado.cargado.equipos) cargarEquipos();
        if (estado.cargado.boveda) cargarBoveda();
        if (estado.cargado.sistemas) cargarSistemas();
        if (estado.placaActiva) abrirPlaca(estado.placaActiva);
      }).observe(envioStatus, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }
  }

  /* ------------------------------------------------------------
     Arranque
     ------------------------------------------------------------ */

  function opcionesSistemasAdmin(actual) {
    return (
      '<option value="">Sin sistema</option>' +
      estado.sistemas
        .map(
          (s) =>
            `<option value="${escapar(s.id)}"${s.id === actual ? " selected" : ""}>${escapar(s.nombre)}</option>`
        )
        .join("")
    );
  }

  function casillasPermisos(permisos = {}) {
    return Object.entries(PERMISOS_TI)
      .map(
        ([clave, etiqueta]) => `
        <label class="check" style="display:inline-flex;gap:5px;align-items:center">
          <input type="checkbox" data-permiso="${clave}"${permisos[clave] ? " checked" : ""} />
          <span>${escapar(etiqueta)}</span>
        </label>`
      )
      .join("");
  }

  async function cargarUsuariosAdmin() {
    if (estado.perfil?.rol !== "admin") return;
    const contenedor = byId("listaUsuariosAdmin");
    if (!contenedor) return;
    contenedor.innerHTML = '<p class="ws-vacio">Cargando usuarios corporativos…</p>';

    try {
      const datos = await api("/api/admin/usuarios");
      const usuarios = datos.usuarios || [];
      if (!usuarios.length) {
        contenedor.innerHTML = '<p class="ws-vacio">Aún no hay usuarios registrados.</p>';
        return;
      }

      contenedor.innerHTML = `
        <table class="ws-tabla">
          <thead>
            <tr>
              <th>Nombre</th><th>Cédula</th><th>Correo</th><th>Rol</th>
              <th>Sede / Sistema</th><th>Permisos</th><th>Acceso</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${usuarios
              .map(
                (usuario) => `
              <tr data-usuario="${escapar(usuario.id)}">
                <td><strong>${escapar(usuario.nombre_completo)}</strong></td>
                <td>${escapar(usuario.cedula || "—")}</td>
                <td>${escapar(usuario.email || "—")}</td>
                <td>
                  <select class="ws-select" data-rol style="min-width:140px">
                    <option value="tecnico"${usuario.rol === "tecnico" ? " selected" : ""}>Técnico TI</option>
                    <option value="admin"${usuario.rol === "admin" ? " selected" : ""}>Administrador TI</option>
                  </select>
                </td>
                <td>
                  <input class="ws-input" data-sede value="${escapar(usuario.sede_asignada || "")}" placeholder="Sede" style="min-width:130px" />
                  <select class="ws-select" data-sistema style="min-width:150px">
                    ${opcionesSistemasAdmin(usuario.sistema_asignado)}
                  </select>
                </td>
                <td><div class="ws-permisos">${casillasPermisos(usuario.permisos || {})}</div></td>
                <td>
                  <label class="check" style="display:inline-flex;gap:6px;align-items:center">
                    <input type="checkbox" data-activo${usuario.activo ? " checked" : ""} />
                    <span class="${usuario.activo ? "ws-usuario-activo" : "ws-usuario-inactivo"}">${usuario.activo ? "Activo" : "Inactivo"}</span>
                  </label>
                </td>
                <td>
                  <button type="button" class="ws-boton ws-boton-mini" data-guardar-usuario="${escapar(usuario.id)}">Guardar</button>
                  <button type="button" class="ws-boton ws-boton-mini" data-eliminar-usuario="${escapar(usuario.id)}">Eliminar</button>
                </td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>`;
      mensaje("adminUsuariosMensaje", `${numero(usuarios.length)} usuario(s) corporativo(s).`);
    } catch (err) {
      contenedor.innerHTML = "";
      mensaje("adminUsuariosMensaje", err.message, "error");
    }
  }

  async function crearUsuarioAdmin(evento) {
    evento.preventDefault();
    const permisos = {};
    Object.keys(PERMISOS_TI).forEach((clave) => {
      permisos[clave] = clave !== "puede_eliminar_registros" && clave !== "puede_administrar_usuarios";
    });
    if (byId("adminUsuRol")?.value === "admin") {
      permisos.puede_administrar_usuarios = true;
    }

    const cuerpo = {
      nombre_completo: byId("adminUsuNombre")?.value.trim() || "",
      cedula: byId("adminUsuCedula")?.value.trim() || "",
      email: byId("adminUsuCorreo")?.value.trim().toLowerCase() || "",
      password: byId("adminUsuClave")?.value || "",
      rol: byId("adminUsuRol")?.value || "tecnico",
      sede_asignada: byId("adminUsuSede")?.value.trim() || "",
      sistema_asignado: byId("adminUsuSistema")?.value || null,
      permisos,
    };

    if (!SOLO_CORPORATIVO.test(cuerpo.email)) {
      return mensaje("adminUsuariosMensaje", "El correo debe terminar en @levapan.com.", "error");
    }

    try {
      await api("/api/admin/usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo),
      });
      byId("formAdminUsuario")?.reset();
      mensaje("adminUsuariosMensaje", "Usuario corporativo creado con acceso inmediato.", "ok");
      await cargarUsuariosAdmin();
    } catch (err) {
      mensaje("adminUsuariosMensaje", err.message, "error");
    }
  }

  async function guardarUsuarioAdmin(id, fila) {
    const permisos = {};
    fila.querySelectorAll("[data-permiso]").forEach((casilla) => {
      permisos[casilla.dataset.permiso] = Boolean(casilla.checked);
    });

    try {
      await api(`/api/admin/usuarios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rol: fila.querySelector("[data-rol]")?.value,
          activo: Boolean(fila.querySelector("[data-activo]")?.checked),
          sede_asignada: fila.querySelector("[data-sede]")?.value.trim() || "",
          sistema_asignado: fila.querySelector("[data-sistema]")?.value || null,
          permisos,
        }),
      });
      mensaje("adminUsuariosMensaje", "Permisos actualizados.", "ok");
      await cargarUsuariosAdmin();
    } catch (err) {
      mensaje("adminUsuariosMensaje", err.message, "error");
    }
  }

  async function eliminarUsuarioAdmin(id) {
    if (!window.confirm("¿Eliminar el acceso de este usuario corporativo?")) return;
    try {
      await api(`/api/admin/usuarios/${id}?modo=eliminar`, { method: "DELETE" });
      mensaje("adminUsuariosMensaje", "Acceso eliminado.", "ok");
      await cargarUsuariosAdmin();
    } catch (err) {
      mensaje("adminUsuariosMensaje", err.message, "error");
    }
  }

  async function actualizarAdmin() {
    if (estado.perfil?.rol !== "admin") return;
    const poner = (id, texto) => {
      const el = byId(id);
      if (el) el.textContent = texto;
    };
    poner("adminPerfil", estado.perfil.nombre_completo || "—");
    poner(
      "adminPerfilDetalle",
      `${estado.perfil.email || ""} · ${estado.perfil.rol || "admin"}`
    );
    poner("adminInventario", numero(estado.total || 0));
    poner("adminSistemas", numero(estado.sistemas.length));
    try {
      const datos = await api("/api/estado");
      const almacenamiento = datos.almacenamiento || {};
      poner(
        "adminStorage",
        `${almacenamiento.proveedor || "supabase"} · ${almacenamiento.bucketBoveda || "boveda-ti"}`
      );
    } catch {
      poner("adminStorage", "supabase · boveda-ti");
    }
    await cargarUsuariosAdmin();
  }

  async function cargarDatosIniciales() {
    const perfil = window.AuthLevapan?.perfil || (await window.AuthLevapan?.listo);
    if (!perfil) return;
    estado.perfil = perfil;

    const esAdmin = perfil.rol === "admin";
    document.querySelectorAll("[data-solo-admin]").forEach((elemento) => {
      elemento.hidden = !esAdmin;
    });
    if (!esAdmin && estado.vista === "administracion") irAVista("sistemas");

    await Promise.all([cargarSistemas(), cargarEquipos(), cargarBoveda()]);
    if (estado.vista === "placas" && estado.placaActiva) abrirPlaca(estado.placaActiva);
    if (esAdmin) actualizarAdmin();
  }

  function iniciar() {
    instalarBrilloRadial();
    instalarOnda();
    inicializarEventos();
    posicionarIndicador();
    setTimeout(posicionarIndicador, 400);
    cargarDatosIniciales();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar, { once: true });
  } else {
    iniciar();
  }
})();
