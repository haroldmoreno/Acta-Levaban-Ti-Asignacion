/* Levapan TI — PWA directa a Supabase (sin servidor intermedio). */
(function () {
  "use strict";

  const CFG = window.LEVAPAN_CONFIG;
  const byId = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  });

  const ESTADO = {
    perfil: null,
    vista: "sistemas",
    sistemas: [],
    equipos: [],
    ultimaPlaca: null,
    fotosComprimidas: {},
    equiposLimite: 40,
    placasLimite: 40,
    contratosLimite: 40,
  };

  const TITULOS = {
    sistemas: "Ecosistemas de TI",
    placas: "Placas & QR",
    equipos: "Equipos",
    contratos: "Contratos y Garantías",
    acta: "Acta de Asignación",
    boveda: "Bóveda PDF",
    admin: "Administración TI",
  };

  const ORDEN_MAESTRO = [
    ["Nombre equipo en Red", "nombre_red"],
    ["Serial del equipo", "serial"],
    ["Nombre del responsable", "responsable"],
    ["Cedula del responsable", "cedula"],
    ["Empresa", "empresa"],
    ["Sede", "sede"],
    ["CECO", "ceco"],
    ["Estado", "estado"],
    ["Proveedor", "proveedor"],
    ["N° Contrato", "num_contrato"],
    ["Tipo de Contrato", "tipo_contrato"],
    ["Tipo de Equipo", "tipo_equipo"],
    ["Marca", "marca"],
    ["Modelo", "modelo"],
    ["Placa", "placa"],
    ["Procesador", "procesador"],
    ["Memoria RAM", "ram"],
    ["Tamaño en Disco", "disco"],
    ["Bitacora del Equipo", "bitacora"],
    ["Creado por", "creado_por"],
    ["Modificado por", "modificado_por"],
    ["Accesorios entregados", "accesorios"],
    ["Modificado", "updated_at"],
    ["Area", "area"],
    ["Fecha de Vencimiento Contrato", "fecha_vencimiento_contrato"],
    ["Tipo de elemento", "tipo_elemento"],
    ["Ruta de acceso", "ruta_acceso"],
  ];
  const COLUMNAS = Object.fromEntries(ORDEN_MAESTRO);

  const ALIAS_IMPORT = {
    "nombre equipo en red": "nombre_red",
    "serial del equipo": "serial",
    "nombre del responsable": "responsable",
    "cedula del responsable": "cedula",
    empresa: "empresa",
    sede: "sede",
    ceco: "ceco",
    estado: "estado",
    proveedor: "proveedor",
    "n° contrato": "num_contrato",
    "no contrato": "num_contrato",
    "numero contrato": "num_contrato",
    "nro contrato": "num_contrato",
    "num contrato": "num_contrato",
    "tipo de contrato": "tipo_contrato",
    "tipo de equipo": "tipo_equipo",
    marca: "marca",
    modelo: "modelo",
    placa: "placa",
    procesador: "procesador",
    "memoria ram": "ram",
    "tamaño en disco": "disco",
    "tamano en disco": "disco",
    "bitacora del equipo": "bitacora",
    "creado por": "creado_por",
    "modificado por": "modificado_por",
    "accesorios entregados": "accesorios",
    area: "area",
    "fecha de vencimiento contrato": "fecha_vencimiento_contrato",
    "tipo de elemento": "tipo_elemento",
    "ruta de acceso": "ruta_acceso",
  };

  function normalizarEncabezado(texto) {
    return String(texto ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[°º]/g, " ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fechaDesdeExcel(valor) {
    if (valor == null || valor === "") return null;
    if (valor instanceof Date && !Number.isNaN(valor.getTime())) return valor.toISOString().slice(0, 10);
    const texto = String(valor).trim();
    if (!texto) return null;
    if (/^\d+(\.\d+)?$/.test(texto)) {
      const dias = Number(texto);
      if (dias > 20000 && dias < 80000) {
        return new Date(Date.UTC(1899, 11, 30) + Math.floor(dias) * 86400000).toISOString().slice(0, 10);
      }
    }
    const partes = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (partes) return `${partes[3]}-${partes[2].padStart(2, "0")}-${partes[1].padStart(2, "0")}`;
    if (/^\d{4}-\d{2}-\d{2}/.test(texto)) return texto.slice(0, 10);
    return null;
  }

  function escapar(valor) {
    return String(valor ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fechaHora(valor) {
    if (!valor) return "—";
    return new Date(valor).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
      year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  }

  function horaBogota() {
    return new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", hour12: false }).format(new Date());
  }

  function saludo() {
    const h = Number(horaBogota());
    return h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
  }

  function mensaje(texto, tipo) {
    const area = byId("mensajeMigracion");
    if (area) {
      area.textContent = texto || "";
      area.className = "mensaje" + (tipo ? " " + tipo : "");
    }
  }

  /* ---------------- Autenticación ---------------- */

  async function iniciarSesion(correo, clave) {
    const { error } = await sb.auth.signInWithPassword({ email: correo.trim().toLowerCase(), password: clave });
    if (error) throw error;
    await cargarSesion();
  }

  function ocultarLogin() {
    const modal = byId("pantallaLogin");
    if (modal) {
      modal.hidden = true;
      modal.style.display = "none";
      modal.classList.remove("activo", "visible", "abierto");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  function mostrarLogin() {
    const modal = byId("pantallaLogin");
    if (modal) {
      modal.hidden = false;
      modal.style.display = "grid";
      modal.classList.remove("activo", "visible", "abierto");
      modal.setAttribute("aria-hidden", "false");
    }
    byId("app").hidden = true;
    document.body.dataset.sesion = "inactiva";
  }

  async function sincronizarPerfil(sesion) {
    const email = String(sesion.user.email || "").toLowerCase();
    if (!email.endsWith("@levapan.com")) {
      await sb.auth.signOut();
      throw new Error("Solo se permiten correos corporativos @levapan.com");
    }

    const id = sesion.user.id;
    let { data: perfil } = await sb.from("usuarios_corporativos").select("*").eq("id", id).maybeSingle();

    if (!perfil) {
      const rol = email === "admin@levapan.com" ? "ADMINISTRADOR_TI" : "TECNICO_TI";
      const nombre = sesion.user.user_metadata?.nombre_completo || sesion.user.user_metadata?.full_name || email.split("@")[0];
      const respuesta = await sb.from("usuarios_corporativos").insert([
        { id, email, nombre_completo: nombre, rol, activo: true },
      ]).select().maybeSingle();
      perfil = respuesta.data;
    } else {
      // Nunca degradamos un perfil ADMINISTRADOR_TI existente.
      const cambios = { email, activo: true };
      if (sesion.user.user_metadata?.nombre_completo || sesion.user.user_metadata?.full_name) {
        cambios.nombre_completo = sesion.user.user_metadata.nombre_completo || sesion.user.user_metadata.full_name;
      }
      const respuesta = await sb.from("usuarios_corporativos").update(cambios).eq("id", id).select().maybeSingle();
      perfil = respuesta.data || { ...perfil, ...cambios };
    }

    if (!perfil?.activo) {
      await sb.auth.signOut();
      throw new Error("Tu cuenta TI está inactiva");
    }
    return perfil;
  }

  async function cargarSesion(sesionParam, evento) {
    let sesion = sesionParam;
    if (sesion === undefined) {
      const { data } = await sb.auth.getSession();
      sesion = data?.session;
    }

    if (!sesion?.user) {
      if (evento === "SIGNED_OUT") {
        ESTADO.perfil = null;
        window.__ultimoUsuarioCargado = null;
      }
      mostrarLogin();
      return;
    }

    // Cierre inmediato del overlay en cuanto hay sesión válida.
    ocultarLogin();
    document.body.dataset.sesion = "activa";

    const perfil = await sincronizarPerfil(sesion);
    ESTADO.perfil = perfil;
    byId("app").hidden = false;
    byId("usuarioNombre").textContent = perfil.nombre_completo || sesion.user.email;
    byId("usuarioRol").textContent = perfil.rol === "ADMINISTRADOR_TI" ? "ADMINISTRADOR TI" : "TECNICO TI";
    document.querySelectorAll("[data-admin]").forEach((el) => { el.hidden = perfil.rol !== "ADMINISTRADOR_TI"; });

    const conteo = await sb.from("equipos").select("id", { count: "exact", head: true });
    const total = Number(conteo.count || 0).toLocaleString("es-CO");
    byId("estadoConexion").textContent = `Supabase en vivo · ${total} equipos`;

    // En un refresh de token no recargamos toda la interfaz innecesariamente.
    if (evento === "TOKEN_REFRESHED" && window.__ultimoUsuarioCargado === sesion.user.id) return;
    window.__ultimoUsuarioCargado = sesion.user.id;

    await cargarSistemas();
    await Promise.all([cargarEquipos(), cargarBoveda(), cargarUsuarios()]);
    irAVista("sistemas");
    suscribirRealtime();
  }

  async function cerrarSesion() {
    await sb.auth.signOut();
    ESTADO.perfil = null;
    window.__ultimoUsuarioCargado = null;
    mostrarLogin();
  }

  /* ---------------- Realtime ---------------- */

  function suscribirRealtime() {
    if (window.__realtimeLevapan) return;
    let temporizador = null;
    const actualizar = () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(() => recargarVista(), 400);
    };
    window.__realtimeLevapan = sb
      .channel("levapan-ti")
      .on("postgres_changes", { event: "*", schema: "public", table: "sistemas" }, actualizar)
      .on("postgres_changes", { event: "*", schema: "public", table: "equipos" }, actualizar)
      .on("postgres_changes", { event: "*", schema: "public", table: "historial_movimientos" }, actualizar)
      .subscribe();
  }

  async function recargarVista() {
    if (!ESTADO.perfil) return;
    if (ESTADO.vista === "sistemas") await cargarSistemas();
    if (ESTADO.vista === "equipos") await cargarEquipos();
    if (ESTADO.vista === "contratos") await cargarContratos();
    if (ESTADO.vista === "placas") await cargarPlacas();
    if (ESTADO.vista === "boveda") await cargarBoveda();
    if (ESTADO.vista === "admin") await cargarUsuarios();
  }

  /* ---------------- Navegación ---------------- */

  function irAVista(vista) {
    ESTADO.vista = vista;
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("activo", b.dataset.vista === vista));
    document.querySelectorAll(".vista").forEach((s) => { s.hidden = s.id !== "vista-" + vista; });
    byId("tituloVista").textContent = TITULOS[vista] || "";
    cerrarDrawer();
    if (vista === "sistemas") cargarSistemas();
    if (vista === "equipos") cargarEquipos();
    if (vista === "contratos") cargarContratos();
    if (vista === "placas") cargarPlacas();
    if (vista === "boveda") cargarBoveda();
    if (vista === "admin") cargarUsuarios();
    if (vista === "acta") setTimeout(redimensionarFirmas, 60);
  }

  /* ---------------- Ecosistemas ---------------- */

  async function cargarSistemas() {
    const [sistemas, equipos, documentos] = await Promise.all([
      sb.from("sistemas").select("*").order("nombre"),
      cargarTodos("equipos", "id, sistema_id, placa"),
      cargarTodos("boveda_documentos", "id, placa"),
    ]);

    ESTADO.sistemas = sistemas.data || [];
    const placasPorSistema = {};
    equipos.forEach((e) => {
      if (e.sistema_id) placasPorSistema[e.sistema_id] = (placasPorSistema[e.sistema_id] || 0) + 1;
    });
    const docsPorPlaca = {};
    documentos.forEach((d) => {
      if (d.placa) docsPorPlaca[d.placa] = (docsPorPlaca[d.placa] || 0) + 1;
    });

    byId("gridSistemas").innerHTML = ESTADO.sistemas.map((s) => {
      const placas = placasPorSistema[s.id] || 0;
      const docs = equipos.filter((e) => e.sistema_id === s.id).reduce((n, e) => n + (docsPorPlaca[e.placa] || 0), 0);
      return `<article class="tarjeta" data-sistema="${escapar(s.id)}" tabindex="0">
        <button type="button" class="boton-eliminar" data-accion="eliminar-sistema" data-id="${escapar(s.id)}" data-nombre="${escapar(s.nombre)}" title="Eliminar ecosistema" aria-label="Eliminar ecosistema">🗑</button>
        <span class="codigo">${escapar(s.codigo)} · ${escapar(s.criticidad)}</span>
        <h3>${escapar(s.nombre)}</h3>
        <p>${escapar(s.descripcion || "Sin descripción")}${s.responsable_sistema ? " · " + escapar(s.responsable_sistema) : ""}</p>
        <div class="conteos"><div><strong>${placas}</strong><span>Placas reales</span></div><div><strong>${docs}</strong><span>Documentos</span></div></div>
      </article>`;
    }).join("") || '<p class="vacio">Sin ecosistemas registrados.</p>';
  }

  function abrirModalSistema(sistema) {
    byId("sisId").value = sistema?.id || "";
    byId("sisCodigo").value = sistema?.codigo || "";
    byId("sisNombre").value = sistema?.nombre || "";
    byId("sisCriticidad").value = sistema?.criticidad || "MEDIA";
    byId("sisResponsable").value = sistema?.responsable_sistema || "";
    byId("sisDescripcion").value = sistema?.descripcion || "";
    byId("modalSistema").hidden = false;
  }

  async function guardarSistema(evento) {
    evento.preventDefault();
    const id = byId("sisId").value;
    const registro = {
      codigo: byId("sisCodigo").value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-"),
      nombre: byId("sisNombre").value.trim(),
      criticidad: byId("sisCriticidad").value,
      responsable_sistema: byId("sisResponsable").value.trim() || null,
      descripcion: byId("sisDescripcion").value.trim() || null,
    };
    let respuesta;
    if (id) respuesta = await sb.from("sistemas").update(registro).eq("id", id);
    else respuesta = await sb.from("sistemas").insert([registro]);
    if (respuesta.error) return alert(respuesta.error.message);
    byId("modalSistema").hidden = true;
    cargarSistemas();
  }

  /* ---------------- Equipos ---------------- */

  function columnasVisibles() {
    return ["id", "sistema_id", ...ORDEN_MAESTRO.map(([, columna]) => columna)].join(", ");
  }

  async function cargarTodos(tabla, columnas, aplicarFiltros) {
    const todo = [];
    for (let desde = 0; desde <= 50000; desde += 1000) {
      let consulta = sb.from(tabla).select(columnas).range(desde, desde + 999);
      if (aplicarFiltros) consulta = aplicarFiltros(consulta);
      const { data, error } = await consulta;
      if (error) throw error;
      todo.push(...(data || []));
      if ((data || []).length < 1000) break;
    }
    return todo;
  }

  async function cargarEquipos() {
    try {
      await cargarEquiposInterno();
    } catch (err) {
      byId("tablaEquipos").innerHTML = `<p class="vacio">${escapar(err.message || "Error al cargar equipos")}</p>`;
    }
  }

  async function cargarEquiposInterno() {
    const q = byId("buscarEquipo")?.value.trim();
    const sede = byId("filtroSede")?.value;
    const ceco = byId("filtroCeco")?.value;
    const estado = byId("filtroEstado")?.value;
    const firmaFiltros = JSON.stringify([q, sede, ceco, estado]);
    if (ESTADO.equiposFirma !== firmaFiltros) {
      ESTADO.equiposLimite = 40;
      ESTADO.equiposFirma = firmaFiltros;
    }

    const todos = await cargarTodos("equipos", columnasVisibles(), (consulta) => {
      let c = consulta;
      if (q) c = c.or(`placa.ilike.%${q}%,serial.ilike.%${q}%,responsable.ilike.%${q}%,nombre_red.ilike.%${q}%`);
      if (sede) c = c.eq("sede", sede);
      if (ceco) c = c.eq("ceco", ceco);
      if (estado) c = c.eq("estado", estado);
      return c;
    });

    const { count: totalReal } = await sb.from("equipos").select("id", { count: "exact", head: true });
    const total = Number(totalReal || 0);
    const normalizar = (valor) => String(valor || "").trim().toUpperCase();
    const porEstado = (prefijo) => todos.filter((e) => normalizar(e.estado).startsWith(prefijo)).length;
    byId("metricaTotal").textContent = total.toLocaleString("es-CO");
    byId("metricaAsignado").textContent = porEstado("ASIGNADO").toLocaleString("es-CO");
    byId("metricaDisponible").textContent = porEstado("DISPONIBLE").toLocaleString("es-CO");
    byId("metricaPrestamo").textContent = (porEstado("PRÉSTAMO") + porEstado("PRESTAMO")).toLocaleString("es-CO");
    byId("estadoConexion").textContent = `Supabase en vivo · ${total.toLocaleString("es-CO")} equipos`;

    ESTADO.equipos = todos;
    const limiteEquipos = ESTADO.equiposLimite || 40;
    const visiblesEquipos = ESTADO.equipos.slice(0, limiteEquipos);
    actualizarFiltros(todos);
    const sistemasPorId = Object.fromEntries(ESTADO.sistemas.map((s) => [s.id, s]));
    const estadoBadge = (valor) => {
      const texto = String(valor || "—");
      const clase = /asign/i.test(texto) ? "asignado" : /dispon/i.test(texto) ? "disponible" : /pr[eé]stamo/i.test(texto) ? "prestamo" : "neutro";
      return `<span class="estado-badge ${clase}">${escapar(texto)}</span>`;
    };

    byId("tablaEquipos").innerHTML = `<table class="tabla-inventario">
      <colgroup>
        <col style="width:115px" /><col style="width:23%" /><col style="width:20%" />
        <col style="width:17%" /><col style="width:20%" /><col style="width:11%" /><col style="width:150px" />
      </colgroup>
      <thead><tr><th>Placa</th><th>Equipo y Red</th><th>Responsable</th><th>Ubicación</th><th>Contrato</th><th>Estado</th><th class="acciones-col">Acciones</th></tr></thead>
      <tbody>${visiblesEquipos.map((e) => {
        const sistema = sistemasPorId[e.sistema_id];
        return `<tr>
          <td data-etiqueta="Placa"><span class="placa-badge mono">${escapar(e.placa)}</span></td>
          <td class="celda-doble" data-etiqueta="Equipo y Red">
            <span class="principal">${escapar([e.tipo_equipo, e.marca, e.modelo].filter(Boolean).join(" · ") || "—")}</span>
            <span class="secundario mono">${escapar(e.serial || "S/N —")} · ${escapar(e.nombre_red || "Sin nombre en red")}${sistema ? ` · ${escapar(sistema.codigo)}` : ""}</span>
          </td>
          <td class="celda-doble" data-etiqueta="Responsable">
            <span class="principal">${escapar(e.responsable || "—")}</span>
            <span class="secundario">${escapar(e.cedula || "—")} · ${escapar(e.empresa || "—")}</span>
          </td>
          <td class="celda-doble" data-etiqueta="Ubicación">
            <span class="principal">${escapar(e.sede || "—")}</span>
            <span class="secundario">${escapar(e.ceco || "—")} · ${escapar(e.area || "—")}</span>
          </td>
          <td class="celda-doble" data-etiqueta="Contrato">
            <span class="principal">${escapar(e.proveedor || "—")} · ${escapar(e.num_contrato || "—")}</span>
            <span class="secundario">${escapar(e.tipo_contrato || "—")} · ${escapar(e.fecha_vencimiento_contrato || "—")}</span>
          </td>
          <td data-etiqueta="Estado">${estadoBadge(e.estado)}</td>
          <td class="acciones-col" data-etiqueta="Acciones">
            <div class="acciones-fila">
              <button class="boton mini" data-equipo="editar" data-id="${escapar(e.id)}" title="Editar ficha técnica">Editar</button>
              <button class="boton mini" data-equipo="hoja" data-id="${escapar(e.id)}" title="Hoja de vida y acta PDF">Hoja</button>
            </div>
          </td>
        </tr>`;
      }).join("")}</tbody></table>
      ${ESTADO.equipos.length > limiteEquipos
        ? `<button type="button" class="boton ver-mas" data-ver-mas="equipos">Ver más (${ESTADO.equipos.length - limiteEquipos} equipos)</button>`
        : ""}` || '<p class="vacio">Sin equipos.</p>';
  }

  function actualizarFiltros(equipos) {
    const llenar = (id, campo) => {
      const select = byId(id);
      if (!select) return;
      const actual = select.value;
      const valores = [...new Set(equipos.map((e) => e[campo]).filter(Boolean))].sort();
      const etiqueta = id === "filtroSede" ? "Todas las sedes" : id === "filtroCeco" ? "Todos los CECO" : "Todos los estados";
      select.innerHTML = `<option value="">${etiqueta}</option>` + valores.map((v) => `<option value="${escapar(v)}">${escapar(v)}</option>`).join("");
      select.value = actual;
    };
    llenar("filtroSede", "sede");
    llenar("filtroCeco", "ceco");
    llenar("filtroEstado", "estado");
  }

  function abrirModalEquipo(equipo) {
    const poner = (id, valor) => { const el = byId(id); if (el) el.value = valor ?? ""; };
    byId("eqId").value = equipo?.id || "";
    [
      ["eqPlaca", "placa"], ["eqNombreRed", "nombre_red"], ["eqSerial", "serial"],
      ["eqTipoEquipo", "tipo_equipo"], ["eqMarca", "marca"], ["eqModelo", "modelo"],
      ["eqProcesador", "procesador"], ["eqRam", "ram"], ["eqDisco", "disco"],
      ["eqResponsable", "responsable"], ["eqCedula", "cedula"], ["eqEmpresa", "empresa"],
      ["eqSede", "sede"], ["eqCeco", "ceco"], ["eqEstado", "estado"], ["eqProveedor", "proveedor"],
      ["eqContrato", "num_contrato"], ["eqTipoContrato", "tipo_contrato"],
      ["eqVencimiento", "fecha_vencimiento_contrato"], ["eqAccesorios", "accesorios"],
      ["eqBitacora", "bitacora"], ["eqArea", "area"], ["eqSistema", "sistema_id"],
      ["eqCreadoPor", "creado_por"], ["eqModificadoPor", "modificado_por"],
      ["eqTipoElemento", "tipo_elemento"], ["eqRutaAcceso", "ruta_acceso"],
    ].forEach(([id, campo]) => poner(id, equipo?.[campo]));
    if (equipo?.updated_at) byId("eqModificado").value = String(equipo.updated_at).slice(0, 16);
    byId("eqSistema").innerHTML = '<option value="">Sin ecosistema</option>' + ESTADO.sistemas.map((s) => `<option value="${escapar(s.id)}">${escapar(s.nombre)}</option>`).join("");
    byId("eqSistema").value = equipo?.sistema_id || "";
    byId("tituloModalEquipo").textContent = equipo ? "Editar ficha técnica" : "Registrar equipo";
    byId("modalEquipo").hidden = false;
  }

  async function guardarEquipo(evento) {
    evento.preventDefault();
    const id = byId("eqId").value;
    const valor = (idCampo) => byId(idCampo)?.value.trim() || null;
    let equipoAnterior = null;
    if (id) {
      const anterior = await sb.from("equipos").select("creado_por").eq("id", id).maybeSingle();
      equipoAnterior = anterior.data;
    }
    const registro = {
      placa: valor("eqPlaca"), nombre_red: valor("eqNombreRed"), serial: valor("eqSerial"),
      tipo_equipo: valor("eqTipoEquipo"), marca: valor("eqMarca"), modelo: valor("eqModelo"),
      procesador: valor("eqProcesador"), ram: valor("eqRam"), disco: valor("eqDisco"),
      responsable: valor("eqResponsable"), cedula: valor("eqCedula"), empresa: valor("eqEmpresa"),
      sede: valor("eqSede"), ceco: valor("eqCeco"), estado: valor("eqEstado"),
      proveedor: valor("eqProveedor"), num_contrato: valor("eqContrato"),
      tipo_contrato: valor("eqTipoContrato"), fecha_vencimiento_contrato: valor("eqVencimiento"),
      sistema_id: valor("eqSistema"), accesorios: valor("eqAccesorios"), bitacora: valor("eqBitacora"),
      area: valor("eqArea"),
      creado_por: valor("eqCreadoPor") || equipoAnterior?.creado_por || ESTADO.perfil?.nombre_completo || null,
      modificado_por: ESTADO.perfil?.nombre_completo || valor("eqModificadoPor") || "sistema",
      tipo_elemento: valor("eqTipoElemento"), ruta_acceso: valor("eqRutaAcceso"),
      updated_at: byId("eqModificado")?.value ? new Date(byId("eqModificado").value).toISOString() : new Date().toISOString(),
    };
    if (!registro.placa) return alert("La placa es obligatoria");

    let respuesta;
    if (id) respuesta = await sb.from("equipos").update(registro).eq("id", id).select().single();
    else respuesta = await sb.from("equipos").insert([registro]).select().single();
    if (respuesta.error) return alert(respuesta.error.message);

    await registrarHistorial(respuesta.data, id ? "EDICIÓN" : "ALTA", `${id ? "Edición de ficha" : "Alta de equipo"} · ${registro.placa}`);
    byId("modalEquipo").hidden = true;
    cargarEquipos();
  }

  async function registrarHistorial(equipo, tipo, observaciones, extra) {
    await sb.from("historial_movimientos").insert([{
      equipo_id: equipo?.id || null,
      placa: equipo?.placa || null,
      tipo_movimiento: tipo,
      responsable_anterior: extra?.responsable_anterior || null,
      responsable_nuevo: extra?.responsable_nuevo || null,
      sede_nueva: extra?.sede_nueva || null,
      ceco_nuevo: extra?.ceco_nuevo || null,
      observaciones: observaciones || null,
      tecnico_responsable: ESTADO.perfil?.nombre_completo || "sistema",
      acta_pdf_url: extra?.acta_pdf_url || null,
      fecha_colombia: new Date().toISOString(),
    }]);
  }

  /* ---------------- Check-in / Check-out y actas ---------------- */

  async function datosActaPorPlaca(placa) {
    const texto = String(placa || "").trim();
    if (!texto) return null;
    try {
      const { data } = await sb.from("vista_veredicto_360").select("*").eq("placa", texto).maybeSingle();
      if (data) return data;
    } catch { /* vista aún no creada */ }
    const { data } = await sb.from("equipos").select("*").eq("placa", texto).maybeSingle();
    return data || null;
  }

  async function documentoAgenteTi() {
    try {
      const { data: usuario } = await sb.auth.getUser();
      if (!usuario?.user?.id) return "";
      const { data } = await sb
        .from("perfiles_ti")
        .select("cedula")
        .eq("id", usuario.user.id)
        .maybeSingle();
      return data?.cedula || "";
    } catch {
      return "";
    }
  }

  function archivoADataUrl(archivo) {
    return new Promise((resolver, rechazar) => {
      if (!archivo) return resolver(null);
      const lector = new FileReader();
      lector.onload = () => resolver(String(lector.result || ""));
      lector.onerror = () => rechazar(lector.error);
      lector.readAsDataURL(archivo);
    });
  }

  // Reduce fotos de cámara (8-15 MB) a JPEG < 180 KB antes de incrustarlas/subirlas.
  async function comprimirImagenMovil(file, maxLado = 1024, calidad = 0.72) {
    if (!file || !String(file.type || "").startsWith("image/")) return null;
    const origen = await archivoADataUrl(file);
    const imagen = new Image();
    await new Promise((resolver, rechazar) => {
      imagen.onload = resolver;
      imagen.onerror = () => rechazar(new Error("No se pudo leer la imagen capturada"));
      imagen.src = origen;
    });

    let ancho = Math.max(1, Math.round(imagen.naturalWidth || imagen.width));
    let alto = Math.max(1, Math.round(imagen.naturalHeight || imagen.height));
    const escalaInicial = Math.min(1, maxLado / Math.max(ancho, alto));
    ancho = Math.max(1, Math.round(ancho * escalaInicial));
    alto = Math.max(1, Math.round(alto * escalaInicial));

    const lienzo = document.createElement("canvas");
    const contexto = lienzo.getContext("2d");
    const dibujar = () => {
      lienzo.width = ancho;
      lienzo.height = alto;
      contexto.drawImage(imagen, 0, 0, ancho, alto);
    };
    dibujar();

    const limite = Math.round(180 * 1024 * 4 / 3); // base64 ≈ 4/3 del tamaño binario
    let calidadActual = calidad;
    let resultado = lienzo.toDataURL("image/jpeg", calidadActual);

    while (resultado.length > limite && calidadActual > 0.35) {
      calidadActual = Math.max(0.35, calidadActual - 0.08);
      resultado = lienzo.toDataURL("image/jpeg", calidadActual);
    }
    while (resultado.length > limite && Math.max(ancho, alto) > 480) {
      ancho = Math.max(1, Math.round(ancho * 0.85));
      alto = Math.max(1, Math.round(alto * 0.85));
      dibujar();
      resultado = lienzo.toDataURL("image/jpeg", calidadActual);
    }
    return resultado;
  }

  async function fotoParaActa(id) {
    const archivo = byId(id)?.files?.[0];
    if (!archivo) return null;
    return ESTADO.fotosComprimidas[id] || (await comprimirImagenMovil(archivo));
  }

  async function llenarFormActa(ficha, tipo) {
    const poner = (id, valor) => {
      const campo = byId(id);
      if (campo) campo.value = valor ?? "";
    };
    poner("actaEquipoId", ficha?.id);
    poner("actaPlaca", ficha?.placa);
    poner("actaNombre", ficha?.responsable || ficha?.usuario_asignado || "");
    poner("actaDocumento", ficha?.cedula || ficha?.usuario_cedula || "");
    poner("actaSede", ficha?.sede || "");
    poner("actaTipoEquipo", ficha?.tipo_equipo || ficha?.tipo);
    poner("actaMarca", ficha?.marca);
    poner("actaModelo", ficha?.modelo);
    poner("actaSerial", ficha?.serial);
    poner("actaObs", ficha?.bitacora || "");

    const pill = byId("actaEstadoPill");
    if (pill) pill.textContent = ficha?.estado || "—";

    const tipoActa = (tipo || "Asignación").toLowerCase().startsWith("dev") ? "Devolución" : "Asignación";
    document.querySelectorAll('input[name="tipoActa"]').forEach((radio) => {
      radio.checked = radio.value === tipoActa;
    });

    const agente = ESTADO.perfil?.nombre_completo || localStorage.getItem("levapan_agente_ti_nombre") || "";
    poner("actaAgenteTi", agente);
    const cedulaTi = await documentoAgenteTi();
    poner("actaDocumentoTi", cedulaTi || localStorage.getItem("levapan_agente_ti_cedula") || "");

    const tecnico = byId("firmaTecnicoNombre");
    if (tecnico) tecnico.textContent = agente || "Agente TI";
    instalarFirmas();
    limpiarFirma("firmaColaborador");
    limpiarFirma("firmaTecnico");
    ["fotoEncendido", "fotoFrontal", "fotoPosterior"].forEach((id) => {
      const campo = byId(id);
      if (campo) campo.value = "";
      delete ESTADO.fotosComprimidas[id];
      const vistaPrevia = byId(`preview${id.charAt(0).toUpperCase()}${id.slice(1)}`);
      if (vistaPrevia) {
        vistaPrevia.removeAttribute("src");
        vistaPrevia.hidden = true;
      }
    });
    ["placaSugerencias", "serialSugerencias", "nombreSugerencias"].forEach((id) => {
      const caja = byId(id);
      if (caja) caja.hidden = true;
    });
    [["actaOtroAccesorioChk", "actaOtroAccesorio"], ["actaOtroSoftwareChk", "actaOtroSoftware"]].forEach(([checkId, inputId]) => {
      const casilla = byId(checkId);
      const campo = byId(inputId);
      if (casilla) casilla.checked = false;
      if (campo) {
        campo.value = "";
        campo.hidden = true;
      }
    });
  }

  async function abrirActa(equipo, tipo) {
    const ficha = equipo || (await datosActaPorPlaca(byId("actaPlaca")?.value));
    ESTADO.actaEquipo = ficha || null;
    ESTADO.actaTipo = tipo || "Asignación";
    await llenarFormActa(ficha, ESTADO.actaTipo);
    irAVista("acta");
  }

  function mostrarEstadoGuardado(mensaje, tipo) {
    let estado = byId("estadoGuardadoActa");
    if (!estado) {
      estado = document.createElement("p");
      estado.id = "estadoGuardadoActa";
      estado.className = "estado-guardado";
      estado.setAttribute("role", "status");
      const form = byId("formActa");
      if (form) form.insertBefore(estado, form.querySelector(".form-pie") || null);
    }
    estado.textContent = mensaje;
    estado.className = `estado-guardado ${tipo || ""}`;
    estado.hidden = false;
  }

  function descargarActa(blob, nombreArchivo) {
    const urlLocal = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = urlLocal;
    enlace.download = nombreArchivo;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(urlLocal), 60000);
  }

  async function guardarActa(evento) {
    evento.preventDefault();
    const boton = byId("formActa")?.querySelector('button[type="submit"]');
    const textoOriginal = boton?.textContent || "Generar acta PDF CORP-TEC-FR-002";
    if (boton) {
      boton.disabled = true;
      boton.textContent = "Guardando acta en Bóveda...";
    }
    try {
      const placa = byId("actaPlaca").value.trim();
      if (!placa) throw new Error("Indica la placa del equipo");

      let equipo = ESTADO.actaEquipo;
      if (!equipo || equipo.placa !== placa) {
        const { data } = await sb.from("equipos").select("*").eq("placa", placa).maybeSingle();
        equipo = data;
      }
      if (!equipo) throw new Error("No se encontró la placa");

      const tipo = document.querySelector('input[name="tipoActa"]:checked')?.value || "Asignación";
      const esDevolucion = tipo.toLowerCase().startsWith("dev");
      const responsable = byId("actaNombre").value.trim();
      const cedula = byId("actaDocumento").value.trim();
      const sede = byId("actaSede").value.trim();
      const observaciones = byId("actaObs").value.trim();
      const agenteTi = byId("actaAgenteTi").value.trim();
      const documentoTi = byId("actaDocumentoTi").value.trim();

      if (documentoTi) localStorage.setItem("levapan_agente_ti_cedula", documentoTi);
      if (agenteTi) localStorage.setItem("levapan_agente_ti_nombre", agenteTi);

      const accesorios = [...document.querySelectorAll("[data-accesorio]")]
        .filter((casilla) => casilla.checked)
        .map((casilla) => casilla.dataset.accesorio);
      const otroAccesorio = byId("actaOtroAccesorio")?.value.trim();
      if (otroAccesorio) accesorios.push(`Otro: ${otroAccesorio}`);

      const software = [...document.querySelectorAll("[data-software]")]
        .filter((casilla) => casilla.checked)
        .map((casilla) => casilla.dataset.software);
      const otroSoftware = byId("actaOtroSoftware")?.value.trim();
      if (otroSoftware) software.push(`Otro: ${otroSoftware}`);

      const fotos = {
        encendido: await fotoParaActa("fotoEncendido"),
        frontal: await fotoParaActa("fotoFrontal"),
        posterior: await fotoParaActa("fotoPosterior"),
      };

      const cambios = {
        responsable: esDevolucion ? null : responsable,
        cedula: esDevolucion ? null : cedula,
        sede: sede || null,
        estado: esDevolucion ? "DISPONIBLE" : "ASIGNADO",
        modificado_por: agenteTi || ESTADO.perfil?.nombre_completo || "sistema",
      };

      // Primero se genera, se sube y se registra; después se toca el inventario.
      const guardado = await generarYSubirActa(
        {
          ...equipo,
          ...cambios,
          nombre: responsable,
          documento: cedula,
          agenteTi,
          documentoTi,
          tipoActa: tipo,
        },
        fotos,
        datosFirmas(),
        { accesorios, software, observaciones, sede }
      );

      const { data: actualizado, error } = await sb.from("equipos").update(cambios).eq("id", equipo.id).select().single();
      if (error) throw error;

      await registrarHistorial(equipo, tipo.toUpperCase(), `Acta CORP-TEC-FR-002 · ${placa} · ${responsable || "devolución"}`, {
        responsable_anterior: equipo.responsable,
        responsable_nuevo: cambios.responsable,
        sede_nueva: sede,
        acta_pdf_url: guardado.url,
      });

      ESTADO.actaEquipo = actualizado;
      descargarActa(guardado.blob, guardado.nombreArchivo);
      mostrarEstadoGuardado("Acta guardada correctamente en Bóveda PDF", "ok");
      cargarBoveda();
      cargarEquipos();
    } catch (err) {
      mostrarEstadoGuardado(`Error al guardar el acta: ${err?.message || String(err)}`, "error");
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.textContent = textoOriginal;
      }
    }
  }

  async function generarYSubirActa(datos, fotos, firmas, extras) {
    const generador = window.ActaPdfLevapan;
    if (!generador) throw new Error("El generador del acta oficial no está disponible");

    const pdfBytes = await generador.generarActaPdf({
      datos: {
        nombre: datos.nombre,
        documento: datos.documento,
        tipo: datos.tipo_equipo || datos.tipo,
        marca: datos.marca,
        modelo: datos.modelo,
        serial: datos.serial,
        placa: datos.placa,
        observaciones: extras?.observaciones || "",
        sede: extras?.sede || datos.sede,
        fecha: new Date().toISOString(),
        agenteTi: datos.agenteTi,
        documentoTi: datos.documentoTi || "",
        tipoActa: datos.tipoActa,
        accesorios: extras?.accesorios || [],
        software: extras?.software || [],
      },
      fotos,
      firmas,
    });

    if (!pdfBytes || pdfBytes.length < 1000) throw new Error("El PDF oficial quedó vacío");
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const nombreArchivo = `CORP-TEC-FR-002_${String(datos.placa || "acta").replace(/[^\w-]/g, "_")}.pdf`;
    const ruta = `actas/${datos.placa}/${Date.now()}.pdf`;

    const subida = await sb.storage.from(CFG.bucket).upload(ruta, blob, { contentType: "application/pdf", upsert: false });
    if (subida.error) throw new Error(`Storage (PDF): ${subida.error.message}`);
    const firmada = await sb.storage.from(CFG.bucket).createSignedUrl(ruta, 3600);
    const url = firmada.data?.signedUrl || null;

    const { error: errorBoveda } = await sb.from("boveda_documentos").insert([{
      titulo: `ACTA ${datos.tipoActa} · ${datos.placa}`, categoria: "Acta", equipo_id: datos.id,
      placa: datos.placa, storage_path: ruta, url, mime_type: "application/pdf",
    }]);
    if (errorBoveda) throw new Error(`Bóveda PDF: ${errorBoveda.message}`);

    const esDevolucion = String(datos.tipoActa || "").toLowerCase().startsWith("dev");
    const { error: errorActa } = await sb.from("actas").insert([{
      tipo_acta: esDevolucion ? "Devolucion" : "Asignacion",
      equipo_id: datos.id || null,
      placa: datos.placa,
      colaborador_nombre: datos.nombre || (esDevolucion ? "Devolución" : "Sin responsable"),
      colaborador_cedula: datos.documento || "N/A",
      sede: datos.sede || "N/A",
      agente_ti_nombre: datos.agenteTi || null,
      agente_ti_cedula: datos.documentoTi || null,
      accesorios: extras?.accesorios || [],
      software: extras?.software || [],
      observaciones: extras?.observaciones || null,
      pdf_storage_path: ruta,
    }]);
    if (errorActa) throw new Error(`Tabla actas: ${errorActa.message}`);

    return { url, blob, nombreArchivo };
  }

  async function accionEquipo(accion, id) {
    const equipo = ESTADO.equipos.find((e) => e.id === id);
    if (!equipo) return;
    if (accion === "editar") return abrirModalEquipo(equipo);
    if (accion === "asignar") return abrirActa(equipo, "ASIGNACIÓN");
    if (accion === "devolver") return abrirActa(equipo, "DEVOLUCIÓN");
    if (accion === "qr") return mostrarQR(equipo);
    if (accion === "hoja") return mostrarHojaVida(equipo);
    if (accion === "baja") {
      if (!confirm(`¿Dar de baja la placa ${equipo.placa}?`)) return;
      const { error } = await sb.from("equipos").update({ estado: "BAJA" }).eq("id", id);
      if (error) return alert(error.message);
      await registrarHistorial(equipo, "BAJA", `Baja de ${equipo.placa}`);
      cargarEquipos();
    }
  }

  async function mostrarHojaVida(equipo) {
    abrirModalEquipo(equipo);
    byId("tituloModalEquipo").textContent = `Hoja de Vida · ${equipo.placa}`;
    const area = byId("historialEquipo");
    if (!area) return;
    area.innerHTML = '<p class="vacio">Cargando historial…</p>';

    const { data } = await sb.from("historial_movimientos").select("*").eq("equipo_id", equipo.id).order("fecha_colombia", { ascending: false }).limit(30);
    const lineas = (data || []).map((m) => `<div class="linea-historial">
      <span class="codigo">${escapar(m.tipo_movimiento)}</span>
      <strong>${escapar(m.observaciones || "—")}</strong>
      <small>${fechaHora(m.fecha_colombia)} · ${escapar(m.tecnico_responsable || "sistema")}${m.acta_pdf_url ? ` · <a href="${escapar(m.acta_pdf_url)}" target="_blank" rel="noopener">Acta PDF</a>` : ""}</small>
    </div>`).join("");
    area.innerHTML = `<h3>Hoja de vida cronológica</h3>${lineas || '<p class="vacio">Sin movimientos registrados.</p>'}
      <div class="form-pie"><button class="boton" data-accion="generar-acta-placa" data-placa="${escapar(equipo.placa)}">Generar acta PDF</button></div>`;
  }

  /* ---------------- Placas y QR ---------------- */

  function acordeonSet(clave) {
    ESTADO.acordeones = ESTADO.acordeones || {};
    return ESTADO.acordeones[clave] || (ESTADO.acordeones[clave] = new Set());
  }

  function actualizarBotonAcordeon(idBoton, clave, grupos, setsExtra = []) {
    const boton = byId(idBoton);
    if (!boton) return;
    const abiertos = acordeonSet(clave);
    const extras = setsExtra.map((s) => ({ clave: s.clave, grupos: s.grupos || [], set: acordeonSet(s.clave) }));
    const total = grupos.length + extras.reduce((n, s) => n + s.grupos.length, 0);
    const abiertas = grupos.filter((g) => abiertos.has(g.indice)).length +
      extras.reduce((n, s) => n + s.grupos.filter((g) => s.set.has(g.indice)).length, 0);
    boton.textContent = total > 0 && abiertas === total ? "Recoger todo" : "Desplegar todo";
  }

  function actualizarBotonPlacas() {
    actualizarBotonAcordeon("btnTogglePlacas", "placas", ESTADO.placasGrupos || []);
  }

  function alternarTodoAcordeon(clave, grupos, recargar, setsExtra = []) {
    const abiertos = acordeonSet(clave);
    const extras = setsExtra.map((s) => ({ clave: s.clave, grupos: s.grupos || [], set: acordeonSet(s.clave) }));
    const todos = grupos.length > 0 &&
      grupos.every((g) => abiertos.has(g.indice)) &&
      extras.every((s) => s.grupos.every((g) => s.set.has(g.indice)));
    grupos.forEach((g) => { if (todos) abiertos.delete(g.indice); else abiertos.add(g.indice); });
    extras.forEach((s) => s.grupos.forEach((g) => { if (todos) s.set.delete(g.indice); else s.set.add(g.indice); }));
    recargar();
  }

  function configuracionAcordeon(vista) {
    if (vista === "placas") {
      return {
        contenedor: "listaPlacas",
        boton: "btnTogglePlacas",
        grupos: [{ clave: "placas", grupos: () => ESTADO.placasGrupos || [] }],
        actualizar: actualizarBotonPlacas,
      };
    }
    return {
      contenedor: "listaContratos",
      boton: "btnToggleContratos",
      grupos: [
        { clave: "contratos", grupos: () => ESTADO.contratosGrupos || [] },
        { clave: "contratos-sub", grupos: () => ESTADO.contratosSubgrupos || [] },
      ],
      actualizar: actualizarBotonContratos,
    };
  }

  // Abre o cierra TODAS las cortinas de una vista (grupos, subniveles y <details>).
  function aplicarCortinas(vista, abrir) {
    const config = configuracionAcordeon(vista);
    const contenedor = byId(config.contenedor);
    if (!contenedor) return;
    contenedor.querySelectorAll("details, .accordion-item, .curtain-group, .acordeon-grupo").forEach((el) => {
      el.open = abrir;
      el.classList.toggle("is-open", abrir);
      el.classList.toggle("abierto", abrir);
      el.querySelectorAll(".accordion-body, .acordeon-cuerpo").forEach((body) => {
        body.style.display = abrir ? "block" : "";
        body.style.maxHeight = abrir ? "none" : "";
        body.style.opacity = abrir ? "1" : "";
      });
      const cabecera = el.querySelector("[data-toggle-grupo], [data-toggle-subgrupo], summary, .acordeon-cabecera");
      if (cabecera) {
        cabecera.setAttribute("aria-expanded", String(abrir));
        const flecha = cabecera.querySelector(".acordeon-flecha");
        if (flecha) flecha.textContent = "▸";
      }
    });
    config.grupos.forEach(({ clave, grupos }) => {
      const set = acordeonSet(clave);
      if (abrir) grupos().forEach((g) => set.add(g.indice));
      else set.clear();
    });
    config.actualizar();
  }

  async function cargarPlacas() {
    const [data, sistemas] = await Promise.all([
      cargarTodos("equipos", columnasVisibles()),
      cargarTodos("sistemas", "id, nombre, codigo"),
    ]);
    ESTADO.placas = data || [];
    const nombreSistema = new Map((sistemas || []).map((s) => [s.id, s.nombre || s.codigo]));
    const texto = byId("buscarPlaca")?.value.trim().toLocaleLowerCase("es") || "";
    const filtrados = ESTADO.placas.filter((e) =>
      !texto || [e.placa, e.serial, e.responsable, e.ceco, e.nombre_red]
        .some((valor) => String(valor || "").toLocaleLowerCase("es").includes(texto))
    );

    const mapa = new Map();
    filtrados.forEach((e) => {
      const eco = nombreSistema.get(e.sistema_id) || e.sistema || "Sin ecosistema";
      const sede = e.sede || "Sin sede";
      const tipo = e.tipo_equipo || "Sin tipo";
      const clave = `${eco} · ${sede} · ${tipo}`;
      if (!mapa.has(clave)) mapa.set(clave, { eco, sede, tipo, items: [] });
      mapa.get(clave).items.push(e);
    });

    ESTADO.placasGrupos = [...mapa.entries()].map(([clave, grupo], indice) => ({ ...grupo, clave, indice }));
    const abiertos = acordeonSet("placas");
    if (ESTADO.placasFiltro !== texto) {
      abiertos.clear();
      ESTADO.placasLimite = 40;
      ESTADO.placasFiltro = texto;
    }
    const limitePlacas = ESTADO.placasLimite || 40;

    const html = ESTADO.placasGrupos.map((g) => {
      const abierto = abiertos.has(g.indice);
      const tarjetas = g.items.slice(0, limitePlacas).map((e) => `<button type="button" class="tarjeta placa-item mono" data-placa-ficha="${escapar(e.id)}">
        <strong>${escapar(e.placa)}</strong>
        <small>${escapar(e.nombre_red || "Sin nombre en red")} · ${escapar(e.sede || "—")}</small>
      </button>`).join("");
      const masPlacas = g.items.length > limitePlacas
        ? `<button type="button" class="boton mini ver-mas" data-ver-mas="placas">Ver más (${g.items.length - limitePlacas})</button>`
        : "";
      return `<section class="acordeon-grupo accordion-item curtain-group${abierto ? " abierto is-open" : ""}" data-grupo="${g.indice}">
        <header class="acordeon-cabecera" data-toggle-grupo data-acordeon="placas" data-indice="${g.indice}" role="button" tabindex="0" aria-expanded="${abierto}">
          <span class="acordeon-flecha">▸</span>
          <span class="acordeon-titulo"><strong>${escapar(g.eco)}</strong><small>${escapar(g.sede)} · ${escapar(g.tipo)}</small></span>
          <span class="acordeon-conteo">${g.items.length} placas</span>
        </header>
        <div class="acordeon-cuerpo accordion-body"><div class="acordeon-inner"><div class="grid-placas">${tarjetas}</div>${masPlacas}</div></div>
      </section>`;
    }).join("");

    byId("listaPlacas").innerHTML = html
      ? `<div class="acordeon-placas">${html}</div>`
      : '<p class="vacio">Sin placas registradas.</p>';
    actualizarBotonPlacas();
    if (filtrados[0]) mostrarFichaPlaca(filtrados[0]);
  }

  function normTexto(valor) {
    return String(valor ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
  }

  function veredictoDe(fila) {
    if (fila.usuario_activo_m365 === false) return { estado: "USUARIO_RETIRADO_M365", detalle: "Usuario deshabilitado en Microsoft 365", color: "rojo" };
    if (!fila.device_id && !fila.device_name) return { estado: "SOLO_INVENTARIO", detalle: "Sin reporte de Entra ID ni HP WXP", color: "ambar" };
    if (fila.ultima_actividad && (Date.now() - new Date(fila.ultima_actividad).getTime()) / 86400000 > 30) {
      return { estado: "SIN_REPORTE_TELEMETRIA", detalle: "Sin actividad de telemetría en más de 30 días", color: "rojo" };
    }
    if (fila.upn_usuario && fila.responsable && normTexto(fila.upn_usuario) !== normTexto(fila.responsable)) {
      return { estado: "DISCREPANCIA_USUARIO", detalle: "El usuario activo en M365 difiere del responsable registrado en el acta", color: "ambar" };
    }
    return { estado: "VERIFICADO", detalle: fila.veredicto_detalle || "Inventario, identidad y telemetría coincidentes", color: "verde" };
  }

  async function mostrarFichaPlaca(equipo) {
    const contenedor = byId("fichaPlaca");
    if (!contenedor || !equipo) return;

    let cruce = null;
    try {
      const { data } = await sb.from("vista_veredicto_360").select("*").eq("placa", equipo.placa).maybeSingle();
      cruce = data || null;
    } catch {
      cruce = null;
    }
    const vista = { ...equipo, ...(cruce || {}) };
    const veredicto = veredictoDe(vista);
    const sistema = ESTADO.sistemas.find((s) => s.id === equipo.sistema_id);
    const grupos = [
      ["Identificación y Red", [["Placa", "placa"], ["Nombre equipo en Red", "nombre_red"], ["Serial del equipo", "serial"], ["Estado", "estado"], ["Ecosistema", null]]],
      ["Responsable", [["Nombre del responsable", "responsable"], ["Cedula del responsable", "cedula"], ["Empresa", "empresa"]]],
      ["Ubicación", [["Sede", "sede"], ["CECO", "ceco"], ["Area", "area"], ["Ruta de acceso", "ruta_acceso"]]],
      ["Hardware", [["Tipo de Equipo", "tipo_equipo"], ["Marca", "marca"], ["Modelo", "modelo"], ["Procesador", "procesador"], ["Memoria RAM", "ram"], ["Tamaño en Disco", "disco"], ["Tipo de elemento", "tipo_elemento"]]],
      ["Contrato y Proveedor", [["Proveedor", "proveedor"], ["N° Contrato", "num_contrato"], ["Tipo de Contrato", "tipo_contrato"], ["Fecha de Vencimiento Contrato", "fecha_vencimiento_contrato"]]],
      ["Trazabilidad", [["Accesorios entregados", "accesorios"], ["Bitacora del Equipo", "bitacora"], ["Creado por", "creado_por"], ["Modificado por", "modificado_por"], ["Modificado", "updated_at"]]],
    ];
    const filas = (campos) => campos.map(([etiqueta, columna]) => {
      const valor = columna ? (vista[columna] ?? "—") : (sistema?.codigo || "—");
      return `<div><dt>${escapar(etiqueta)}</dt><dd class="${["Placa", "Serial del equipo", "N° Contrato", "CECO"].includes(etiqueta) ? "mono" : ""}">${escapar(valor)}</dd></div>`;
    }).join("");

    const entra = [
      ["Usuario en red", "upn_usuario"], ["Nombre Entra", "nombre_usuario_entra"],
      ["Cuenta M365", "usuario_activo_m365"], ["Sistema operativo", "sistema_operativo"],
      ["Versión OS", "version_os"], ["Última actividad", "ultima_actividad"], ["Cumplimiento", "cumplimiento"],
    ];
    const hp = [
      ["Dispositivo HP", "device_name"], ["Modelo HP", "modelo_hp"], ["BIOS", "bios_version"],
      ["Salud batería %", "salud_bateria_pct"], ["Estado disco", "estado_disco"],
      ["Estado conexión", "estado_conexion"], ["Último usuario HP", "ultimo_usuario_hp"],
      ["Última conexión HP", "ultima_conexion_hp"],
    ];

    contenedor.innerHTML = `<article class="tarjeta ficha-completa">
      <header class="ficha-cab">
        <div><span class="codigo mono">FICHA DEL EQUIPO</span><h3>${escapar(equipo.placa)}</h3></div>
        <div class="acciones-fila">
          <button class="boton mini" data-equipo="qr" data-id="${escapar(equipo.id)}">QR</button>
          <button class="boton mini" data-equipo="editar" data-id="${escapar(equipo.id)}">Editar</button>
          <button class="boton mini" data-equipo="hoja" data-id="${escapar(equipo.id)}">Hoja</button>
        </div>
      </header>

      <div class="veredicto-banner ${veredicto.color}">
        <div><strong>Veredicto Cruzado 360°</strong><span>${escapar(veredicto.estado)}</span></div>
        <p>${escapar(veredicto.detalle)}</p>
      </div>

      <div class="bloques-360">
        <section class="bloque-360">
          <h4>Bloque 1 · Datos Maestros Levapan (27 campos)</h4>
          <div class="ficha-grupos">${grupos.map(([titulo, campos]) => `<section class="ficha-grupo"><h5>${titulo}</h5><dl>${filas(campos)}</dl></section>`).join("")}</div>
        </section>
        <section class="bloque-360">
          <h4>Bloque 2 · Identidad Microsoft Entra ID</h4>
          <div class="ficha-grupo"><dl>${filas(entra)}</dl></div>
        </section>
        <section class="bloque-360">
          <h4>Bloque 3 · Telemetría HP WXP</h4>
          <div class="ficha-grupo"><dl>${filas(hp)}</dl></div>
        </section>
      </div>
    </article>`;
  }

  async function mostrarQR(equipo) {
    const sistema = ESTADO.sistemas.find((s) => s.id === equipo.sistema_id);
    const contenido = JSON.stringify({
      placa: equipo.placa, serial: equipo.serial,
      ecosistema: sistema?.codigo || null,
      url: `${location.origin}/?placa=${encodeURIComponent(equipo.placa)}`,
    });
    const src = await window.QRCode.toDataURL(contenido, { width: 360, margin: 1 });
    const ventana = window.open("", "_blank");
    ventana.document.write(`<title>QR · ${equipo.placa}</title><body style="text-align:center;font-family:Arial;padding:30px"><h2>${equipo.placa}</h2><img src="${src}" width="280"/><p>${escapar(equipo.nombre_red || "")}</p><button onclick="window.print()">Imprimir etiqueta</button></body>`);
  }

  /* ---------------- Contratos y Garantías ---------------- */

  function clasificarVencimiento(dias) {
    if (dias == null) return { texto: "Sin fecha", clase: "verde" };
    if (dias < 0) return { texto: `Vencido (${Math.abs(dias)} d)`, clase: "vencido" };
    if (dias <= 30) return { texto: `≤ 30 días (${dias} d)`, clase: "rojo" };
    if (dias <= 60) return { texto: `31–60 días (${dias} d)`, clase: "ambar" };
    if (dias <= 90) return { texto: `61–90 días (${dias} d)`, clase: "azul" };
    return { texto: `Vigente (${dias} d)`, clase: "verde" };
  }

  function actualizarBotonContratos() {
    actualizarBotonAcordeon("btnToggleContratos", "contratos", ESTADO.contratosGrupos || [], [
      { clave: "contratos-sub", grupos: ESTADO.contratosSubgrupos || [] },
    ]);
  }

  async function cargarContratos() {
    const activos = await cargarTodos("equipos", "*");
    const llenar = (id, campo) => {
      const select = byId(id);
      if (!select) return;
      const actual = select.value;
      const valores = [...new Set(activos.map((e) => e[campo]).filter(Boolean))].sort();
      select.innerHTML = `<option value="">${id.includes("Proveedor") ? "Todos los proveedores" : id.includes("Sede") ? "Todas las sedes" : "Todos los CECO"}</option>` +
        valores.map((v) => `<option value="${escapar(v)}">${escapar(v)}</option>`).join("");
      select.value = actual;
    };
    llenar("filtroProveedor", "proveedor");
    llenar("filtroSedeContrato", "sede");
    llenar("filtroCecoContrato", "ceco");

    const filtros = {
      proveedor: byId("filtroProveedor")?.value,
      sede: byId("filtroSedeContrato")?.value,
      ceco: byId("filtroCecoContrato")?.value,
      semaforo: byId("filtroSemacoro")?.value,
    };

    const filas = activos
      .filter((e) => e.fecha_vencimiento_contrato)
      .map((e) => ({ ...e, dias: Math.ceil((new Date(e.fecha_vencimiento_contrato).getTime() - Date.now()) / 86400000) }))
      .filter((e) => !filtros.proveedor || e.proveedor === filtros.proveedor)
      .filter((e) => !filtros.sede || e.sede === filtros.sede)
      .filter((e) => !filtros.ceco || e.ceco === filtros.ceco)
      .filter((e) => {
        if (!filtros.semaforo) return true;
        if (filtros.semaforo === "vencido") return e.dias < 0;
        if (filtros.semaforo === "vigente") return e.dias > 90;
        const limite = Number(filtros.semaforo);
        return e.dias >= 0 && e.dias <= limite;
      })
      .sort((a, b) => a.dias - b.dias);

    const firmaFiltros = JSON.stringify(filtros);
    if (ESTADO.contratosFirma !== firmaFiltros) {
      acordeonSet("contratos").clear();
      acordeonSet("contratos-sub").clear();
      ESTADO.contratosLimite = 40;
      ESTADO.contratosFirma = firmaFiltros;
    }
    const limiteContratos = ESTADO.contratosLimite || 40;

    const filaContrato = (e) => {
      const semaforo = clasificarVencimiento(e.dias);
      return `<tr>
        <td class="mono">${escapar(e.placa)}</td>
        <td>${escapar(e.nombre_red || [e.marca, e.modelo].filter(Boolean).join(" ") || "—")}</td>
        <td>${escapar(e.proveedor || "—")}</td>
        <td class="mono">${escapar(e.num_contrato || "—")}</td>
        <td>${escapar(e.tipo_contrato || "—")}</td>
        <td>${escapar(e.fecha_vencimiento_contrato)}</td>
        <td><span class="semaforo ${semaforo.clase}">${escapar(semaforo.texto)}</span></td>
        <td><button class="boton mini" data-equipo="hoja" data-id="${escapar(e.id)}">Hoja</button></td>
      </tr>`;
    };
    const cabeceraTabla = `<thead><tr><th>Placa</th><th>Equipo</th><th>Proveedor</th><th>N° Contrato</th><th>Tipo</th><th>Vencimiento</th><th>Semáforo</th><th></th></tr></thead>`;

    const porProveedor = new Map();
    filas.forEach((e) => {
      const proveedor = e.proveedor || "Sin proveedor";
      const sub = `${e.sede || "Sin sede"} · ${e.tipo_contrato || "Sin tipo"}`;
      if (!porProveedor.has(proveedor)) porProveedor.set(proveedor, new Map());
      const subMapa = porProveedor.get(proveedor);
      if (!subMapa.has(sub)) subMapa.set(sub, []);
      subMapa.get(sub).push(e);
    });

    ESTADO.contratosGrupos = [];
    ESTADO.contratosSubgrupos = [];
    let indice = 0;
    const html = [...porProveedor.entries()].map(([proveedor, subMapa]) => {
      const i = indice;
      indice += 1;
      const proveedorAbierto = acordeonSet("contratos").has(i);
      const total = [...subMapa.values()].reduce((n, lista) => n + lista.length, 0);
      ESTADO.contratosGrupos.push({ indice: i, count: total });

      const subHtml = [...subMapa.entries()].map(([sub, lista], j) => {
        const claveSub = `${i}-${j}`;
        const subAbierto = acordeonSet("contratos-sub").has(claveSub);
        ESTADO.contratosSubgrupos.push({ indice: claveSub, count: lista.length });
        return `<section class="acordeon-grupo acordeon-sub accordion-item curtain-group${subAbierto ? " abierto is-open" : ""}">
          <header class="acordeon-cabecera" data-toggle-subgrupo data-acordeon="contratos-sub" data-indice="${claveSub}" role="button" tabindex="0" aria-expanded="${subAbierto}">
            <span class="acordeon-flecha">▸</span>
            <span class="acordeon-titulo"><strong>${escapar(sub)}</strong></span>
            <span class="acordeon-conteo">${lista.length} contratos</span>
          </header>
          <div class="acordeon-cuerpo accordion-body"><div class="acordeon-inner"><table class="tabla-inventario">
            ${cabeceraTabla}<tbody>${lista.slice(0, limiteContratos).map(filaContrato).join("")}</tbody>
          </table>
          ${lista.length > limiteContratos
            ? `<button type="button" class="boton mini ver-mas" data-ver-mas="contratos">Ver más (${lista.length - limiteContratos} contratos)</button>`
            : ""}</div></div>
        </section>`;
      }).join("");

      return `<section class="acordeon-grupo accordion-item curtain-group${proveedorAbierto ? " abierto is-open" : ""}">
        <header class="acordeon-cabecera" data-toggle-grupo data-acordeon="contratos" data-indice="${i}" role="button" tabindex="0" aria-expanded="${proveedorAbierto}">
          <span class="acordeon-flecha">▸</span>
          <span class="acordeon-titulo"><strong>${escapar(proveedor)}</strong><small>Vencimientos y garantías</small></span>
          <span class="acordeon-conteo">${total} contratos</span>
        </header>
        <div class="acordeon-cuerpo accordion-body"><div class="acordeon-inner"><div class="acordeon-subgrupos">${subHtml}</div></div></div>
      </section>`;
    }).join("");

    byId("listaContratos").innerHTML = html
      ? `<div class="acordeon-placas">${html}</div>`
      : '<p class="vacio">Sin contratos con esos filtros.</p>';
    actualizarBotonContratos();
  }

  async function exportarContratos() {
    const activos = await cargarTodos("equipos", "*");
    const cabeceras = ["Placa", "Nombre equipo en Red", "Proveedor", "N° Contrato", "Tipo de Contrato", "Sede", "CECO", "Fecha Vencimiento", "Días", "Semáforo"];
    const filas = activos.filter((e) => e.fecha_vencimiento_contrato).map((e) => {
      const dias = Math.ceil((new Date(e.fecha_vencimiento_contrato).getTime() - Date.now()) / 86400000);
      return [e.placa, e.nombre_red, e.proveedor, e.num_contrato, e.tipo_contrato, e.sede, e.ceco, e.fecha_vencimiento_contrato, dias, clasificarVencimiento(dias).texto];
    });
    const hoja = window.XLSX.utils.aoa_to_sheet([cabeceras, ...filas]);
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, "Renovaciones");
    window.XLSX.writeFile(libro, `Levapan_Renovaciones_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  /* ---------------- Escáner QR / código de barras ---------------- */

  function abrirEscanner() {
    const capa = document.createElement("div");
    capa.className = "modal";
    capa.id = "modalEscanner";
    capa.innerHTML = `<div class="modal-caja pequeno">
      <header><h2>Escanear QR / Placa</h2><button class="cerrar" data-cerrar="modalEscanner">×</button></header>
      <div style="padding:14px">
        <div id="lectorQR" style="width:100%;min-height:260px"></div>
        <p class="mensaje" id="mensajeScanner">Apunta la cámara a la etiqueta del activo…</p>
      </div>
    </div>`;
    document.body.appendChild(capa);

    const resolver = async (texto) => {
      const placa = String(texto || "").trim();
      capa.remove();
      let equipo = null;
      try {
        const { data } = await sb.from("equipos").select("*").or(`placa.ilike.%${placa}%,serial.ilike.%${placa}%`).limit(1);
        equipo = data?.[0];
      } catch { /* ignore */ }
      if (equipo) {
        irAVista("placas");
        mostrarFichaPlaca(equipo);
      } else {
        alert(`No se encontró un activo para «${placa}»`);
      }
    };

    if ("BarcodeDetector" in window) {
      const detector = new window.BarcodeDetector({ formats: ["qr_code", "code_128", "code_39", "ean_13", "upc_a"] });
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then((stream) => {
        const video = document.createElement("video");
        video.srcObject = stream;
        video.play();
        capa.querySelector("#lectorQR").appendChild(video);
        const bucle = async () => {
          if (!capa.isConnected) { stream.getTracks().forEach((t) => t.stop()); return; }
          try {
            const codigos = await detector.detect(video);
            if (codigos?.[0]?.rawValue) return resolver(codigos[0].rawValue);
          } catch { /* sigue */ }
          setTimeout(bucle, 350);
        };
        bucle();
      }).catch(() => cargarHtml5Qrcode());
    } else {
      cargarHtml5Qrcode();
    }

    function cargarHtml5Qrcode() {
      if (window.Html5Qrcode) return iniciarHtml5();
      const script = document.createElement("script");
      script.src = "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js";
      script.onload = iniciarHtml5;
      script.onerror = () => { byId("mensajeScanner").textContent = "No se pudo cargar el lector. Verifica la conexión."; };
      document.head.appendChild(script);
    }

    function iniciarHtml5() {
      try {
        const escanner = new window.Html5Qrcode("lectorQR");
        window.__lectorActivo = escanner;
        escanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 260 }, resolver, () => {});
      } catch (err) {
        byId("mensajeScanner").textContent = err.message;
      }
    }
  }

  /* ---------------- Modo Auditoría Física ---------------- */

  async function modoAuditoria() {
    let panel = byId("panelAuditoria");
    if (!panel) {
      const admin = byId("vista-admin");
      panel = document.createElement("div");
      panel.id = "panelAuditoria";
      panel.className = "modo-auditoria";
      admin.insertBefore(panel, admin.firstChild);
    }
    const activos = await cargarTodos("equipos", "id, placa, nombre_red, sede, estado, bitacora");
    const verificados = activos.filter((e) => /verificado/i.test(e.estado || ""));
    panel.innerHTML = `<strong>Modo Auditoría Física activo</strong>
      <p>${verificados.length} de ${activos.length} activos verificados. Usa el botón «Marcar verificado» del copiloto o escanea etiquetas con «Escanear QR / Placa».</p>
      <div class="acciones-fila">
        <button class="boton mini" id="btnConciliar">Exportar acta de conciliación</button>
        <button class="boton mini" id="btnSalirAuditoria">Salir del modo</button>
      </div>`;
    byId("btnConciliar").addEventListener("click", () => {
      const cabeceras = ["Placa", "Nombre en Red", "Sede", "Estado", "Resultado"];
      const filas = activos.map((e) => [e.placa, e.nombre_red, e.sede, e.estado, /verificado/i.test(e.estado || "") ? "VERIFICADO" : "PENDIENTE"]);
      const hoja = window.XLSX.utils.aoa_to_sheet([cabeceras, ...filas]);
      const libro = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(libro, hoja, "Conciliacion");
      window.XLSX.writeFile(libro, `Acta_Conciliacion_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    byId("btnSalirAuditoria").addEventListener("click", () => panel.remove());
  }

  /* ---------------- Firmas táctiles ---------------- */

  function installFirma(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111";
    let activo = false;
    const punto = (evento) => {
      const rect = canvas.getBoundingClientRect();
      const escalaX = canvas.width / rect.width;
      const escalaY = canvas.height / rect.height;
      return { x: (evento.clientX - rect.left) * escalaX, y: (evento.clientY - rect.top) * escalaY };
    };
    canvas.addEventListener("pointerdown", (e) => {
      activo = true;
      canvas.setPointerCapture(e.pointerId);
      const p = punto(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!activo) return;
      e.preventDefault();
      const p = punto(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((evt) => canvas.addEventListener(evt, () => { activo = false; }));
  }

  function instalarFirmas() {
    ["firmaColaborador", "firmaTecnico"].forEach((id) => {
      const canvas = byId(id);
      if (canvas && !canvas.dataset.listo) {
        installFirma(canvas);
        canvas.dataset.listo = "1";
      }
    });
    redimensionarFirmas();
  }

  function limpiarFirma(id) {
    const canvas = byId(id);
    if (!canvas) return;
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }

  function datosFirmas() {
    return {
      colaborador: byId("firmaColaborador")?.toDataURL("image/png") || null,
      tecnico: byId("firmaTecnico")?.toDataURL("image/png") || null,
    };
  }

  const PREVIEWS_FOTO = [
    ["fotoEncendido", "previewFotoEncendido"],
    ["fotoFrontal", "previewFotoFrontal"],
    ["fotoPosterior", "previewFotoPosterior"],
  ];

  function instalarPreviewsFotos() {
    PREVIEWS_FOTO.forEach(([inputId, previewId]) => {
      const input = byId(inputId);
      if (!input || input.dataset.previewListo) return;
      input.dataset.previewListo = "1";
      input.addEventListener("change", async () => {
        const vistaPrevia = byId(previewId);
        if (!vistaPrevia) return;
        const archivo = input.files?.[0];
        if (!archivo) {
          delete ESTADO.fotosComprimidas[inputId];
          vistaPrevia.removeAttribute("src");
          vistaPrevia.hidden = true;
          return;
        }
        try {
          const comprimida = await comprimirImagenMovil(archivo);
          ESTADO.fotosComprimidas[inputId] = comprimida;
          vistaPrevia.src = comprimida;
        } catch {
          vistaPrevia.src = await archivoADataUrl(archivo);
        }
        vistaPrevia.hidden = false;
      });
    });
  }

  // Recalibra el canvas al ancho visible (rotación, apertura en móvil o resize).
  function redimensionarFirma(canvas) {
    if (!canvas) return;
    const ancho = Math.round(canvas.getBoundingClientRect().width);
    if (ancho < 10) return;
    const alto = window.innerWidth <= 768 ? 150 : 110;
    if (canvas.width === ancho && canvas.height === alto) return;
    const copia = document.createElement("canvas");
    copia.width = canvas.width;
    copia.height = canvas.height;
    copia.getContext("2d").drawImage(canvas, 0, 0);
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111111";
    ctx.drawImage(copia, 0, 0, ancho, alto);
  }

  function redimensionarFirmas() {
    ["firmaColaborador", "firmaTecnico"].forEach((id) => redimensionarFirma(byId(id)));
  }

  async function sincronizarEntraAhora(boton) {
    const aviso = byId("mensajeMigracion");
    const original = boton?.textContent || "Sincronizar Entra ID ahora";
    if (aviso) {
      aviso.textContent = "Sincronizando Microsoft Entra ID e Intune… Esto puede tardar unos segundos.";
      aviso.className = "mensaje";
    }
    if (boton) {
      boton.disabled = true;
      boton.textContent = "Sincronizando…";
    }

    try {
      const { data, error } = await sb.functions.invoke("sync-telemetria-360");
      if (error) throw error;
      if (data?.ok === false) throw new Error(data.error || "La función respondió un error");

      let cruzados = 0;
      try {
        const { count } = await sb
          .from("vista_veredicto_360")
          .select("id", { count: "exact", head: true })
          .neq("veredicto_estado", "SOLO_INVENTARIO");
        cruzados = Number(count) || 0;
      } catch { /* vista aún no ejecutada */ }

      await Promise.all([cargarEquipos(), cargarSistemas(), cargarBoveda()]);
      if (aviso) {
        aviso.textContent =
          `Entra ID: ${Number(data?.total_entra_leidos || 0).toLocaleString("es-CO")} leídos · ` +
          `${Number(data?.total_sincronizados || 0).toLocaleString("es-CO")} sincronizados · ` +
          `${cruzados.toLocaleString("es-CO")} equipos cruzados en la vista 360°. ` +
          `Usuarios retirados: ${Number(data?.usuarios_retirados_detectados || 0)}.`;
        aviso.className = "mensaje ok";
      }
    } catch (err) {
      if (aviso) {
        aviso.textContent = `No se pudo sincronizar: ${err.message}`;
        aviso.className = "mensaje error";
      }
    } finally {
      if (boton) {
        boton.disabled = false;
        boton.textContent = original;
      }
    }
  }

  const HP_ENCABEZADOS = {
    "serial number": "serial",
    "numero de serie": "serial",
    "número de serie": "serial",
    serial: "serial",
    "device name": "device_name",
    "nombre del dispositivo": "device_name",
    hostname: "device_name",
    model: "modelo_hp",
    modelo: "modelo_hp",
    "product name": "modelo_hp",
    "bios version": "bios_version",
    "versión de bios": "bios_version",
    "version de bios": "bios_version",
    "battery health": "salud_bateria_pct",
    "salud de la batería": "salud_bateria_pct",
    "salud de la bateria": "salud_bateria_pct",
    "disk health": "estado_disco",
    "estado del disco": "estado_disco",
    "storage status": "estado_disco",
    "connection status": "estado_conexion",
    "estado de conexión": "estado_conexion",
    "estado de conexion": "estado_conexion",
    status: "estado_conexion",
    "last user": "ultimo_usuario_hp",
    "último usuario": "ultimo_usuario_hp",
    "ultimo usuario": "ultimo_usuario_hp",
    "user name": "ultimo_usuario_hp",
    "last seen": "ultima_conexion_hp",
    "última conexión": "ultima_conexion_hp",
    "ultima conexion": "ultima_conexion_hp",
    "última vez visto": "ultima_conexion_hp",
    "ultima vez visto": "ultima_conexion_hp",
  };

  function normalizarEncabezadoHp(texto) {
    return String(texto ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .replace(/[^a-z0-9 ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fechaHpIso(valor) {
    if (valor == null || valor === "") return null;
    if (valor instanceof Date && !Number.isNaN(valor.getTime())) return valor.toISOString();
    const texto = String(valor).trim();
    if (!texto) return null;
    const dias = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (dias) {
      const fecha = new Date(
        Number(dias[3]), Number(dias[2]) - 1, Number(dias[1]),
        Number(dias[4] || 0), Number(dias[5] || 0)
      );
      return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
    }
    const fecha = new Date(texto);
    return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
  }

  function enteroHp(valor) {
    const coincidencia = String(valor ?? "").match(/\d+/);
    return coincidencia ? Number(coincidencia[0]) : null;
  }

  async function importarCsvHp(archivo) {
    const aviso = byId("mensajeMigracion");
    if (aviso) {
      aviso.textContent = "Leyendo archivo HP WXP…";
      aviso.className = "mensaje";
    }
    try {
      const buffer = await archivo.arrayBuffer();
      const nombre = String(archivo.name || "").toLowerCase();
      let libro;
      if (nombre.endsWith(".csv")) {
        const texto = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "");
        const primeraLinea = texto.split(/\r?\n/)[0] || "";
        const separador = (primeraLinea.match(/;/g) || []).length > (primeraLinea.match(/,/g) || []).length ? ";" : ",";
        libro = window.XLSX.read(texto, { type: "string", FS: separador, cellDates: true });
      } else {
        libro = window.XLSX.read(buffer, { type: "array", cellDates: true });
      }

      const hoja = libro.Sheets[libro.SheetNames[0]];
      const filas = window.XLSX.utils.sheet_to_json(hoja, { defval: "", raw: false });
      const totalFilas = filas.length;
      const porSerial = new Map();
      let descartadas = 0;

      for (const fila of filas) {
        const registro = {};
        for (const [encabezado, valor] of Object.entries(fila)) {
          const columna = HP_ENCABEZADOS[normalizarEncabezadoHp(encabezado)];
          if (!columna) continue;
          const texto = String(valor ?? "").trim();
          if (!texto) continue;
          if (columna === "serial") registro.serial = texto.toUpperCase().replace(/\s+/g, "");
          else if (columna === "salud_bateria_pct") registro.salud_bateria_pct = enteroHp(texto);
          else if (columna === "ultima_conexion_hp") registro.ultima_conexion_hp = fechaHpIso(texto);
          else registro[columna] = texto;
        }

        if (!registro.serial) {
          descartadas += 1;
          continue;
        }
        porSerial.set(registro.serial, { ...registro, synced_at: new Date().toISOString() });
      }

      const registros = [...porSerial.values()];
      if (!registros.length) throw new Error("No se encontraron filas con serial válido");

      for (let i = 0; i < registros.length; i += 500) {
        const { error } = await sb
          .from("sync_hp_wxp")
          .upsert(registros.slice(i, i + 500), { onConflict: "serial" });
        if (error) throw error;
      }

      try {
        await APP_RELOAD_VISTA360();
      } catch { /* la vista puede no existir aún */ }
      await cargarEquipos();

      if (aviso) {
        aviso.textContent =
          `${registros.length} equipos HP únicos sincronizados · ` +
          `${totalFilas - descartadas - registros.length} duplicados eliminados · ${descartadas} filas sin serial descartadas.`;
        aviso.className = "mensaje ok";
      }
    } catch (err) {
      if (aviso) {
        aviso.textContent = `No se pudo importar HP WXP: ${err.message}`;
        aviso.className = "mensaje error";
      }
    }
  }

  async function APP_RELOAD_VISTA360() {
    await cargarTodos("vista_veredicto_360", "id");
  }

  async function exportarRespaldoMaestro() {
    const tablas = ["sistemas", "equipos", "historial_movimientos", "usuarios_corporativos", "boveda_documentos", "sync_entra_dispositivos", "sync_hp_wxp"];
    const datos = {};
    for (const tabla of tablas) {
      try {
        datos[tabla] = await cargarTodos(tabla, "*");
      } catch {
        datos[tabla] = [];
      }
    }
    const fecha = new Date().toISOString();
    const json = JSON.stringify({ aplicacion: "Levapan TI 360°", generadoEn: fecha, datos }, null, 2);
    const urlBlob = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const enlace = document.createElement("a");
    enlace.href = urlBlob;
    enlace.download = `Levapan_Respaldo_360_${fecha.slice(0, 10)}.json`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    setTimeout(() => URL.revokeObjectURL(urlBlob), 5000);

    const libro = window.XLSX.utils.book_new();
    for (const [tabla, filas] of Object.entries(datos)) {
      const hoja = window.XLSX.utils.json_to_sheet(filas.length ? filas : [{}]);
      window.XLSX.utils.book_append_sheet(libro, hoja, tabla.slice(0, 31));
    }
    window.XLSX.writeFile(libro, `Levapan_Respaldo_360_${fecha.slice(0, 10)}.xlsx`);
  }

  /* ---------------- Bóveda ---------------- */

  async function cargarBoveda() {
    const { data } = await sb.from("boveda_documentos").select("id, titulo, categoria, placa, storage_path, url, created_at").order("created_at", { ascending: false }).limit(200);
    byId("listaBoveda").innerHTML = (data || []).map((d) => `<article class="tarjeta">
      <button type="button" class="boton-eliminar" data-accion="eliminar-doc" data-id="${escapar(d.id)}" data-path="${escapar(d.storage_path || "")}" data-titulo="${escapar(d.titulo)}" title="Eliminar acta" aria-label="Eliminar acta">🗑</button>
      <span class="codigo">${escapar(d.categoria)} · ${escapar(d.placa || "—")}</span>
      <h3>${escapar(d.titulo)}</h3>
      <p>${fechaHora(d.created_at)}</p>
      ${d.url ? `<a class="boton" href="${escapar(d.url)}" target="_blank" rel="noopener">Abrir PDF</a>` : `<a class="boton" href="#" data-doc="${escapar(d.id)}">Preparar enlace</a>`}
    </article>`).join("") || '<p class="vacio">Sin documentos.</p>';
  }

  async function abrirDocumento(id) {
    const { data } = await sb.from("boveda_documentos").select("storage_path").eq("id", id).maybeSingle();
    if (!data) return;
    const firmada = await sb.storage.from(CFG.bucket).createSignedUrl(data.storage_path, 3600);
    if (firmada.data?.signedUrl) window.open(firmada.data.signedUrl, "_blank");
  }

  async function eliminarDocumento(boton) {
    const titulo = boton.dataset.titulo || "esta acta";
    if (!window.confirm(`¿Eliminar esta acta de la Bóveda PDF?\n\n${titulo}`)) return;
    const { error } = await sb.from("boveda_documentos").delete().eq("id", boton.dataset.id);
    if (error) return alert(error.message);
    const ruta = boton.dataset.path;
    if (ruta) {
      const { error: errorStorage } = await sb.storage.from(CFG.bucket).remove([ruta]);
      if (errorStorage) console.warn("[BÓVEDA] No se pudo borrar el PDF del bucket:", errorStorage.message);
    }
    await cargarBoveda();
  }

  async function eliminarSistema(boton) {
    const nombre = boton.dataset.nombre || "este ecosistema";
    if (!window.confirm(`¿Eliminar el ecosistema «${nombre}»?\n\nLas placas quedarán sin ecosistema asignado.`)) return;
    const { error } = await sb.from("sistemas").delete().eq("id", boton.dataset.id);
    if (error) return alert(error.message);
    await cargarSistemas();
  }

  /* ---------------- Administración y migración ---------------- */

  async function cargarUsuarios() {
    const { data } = await sb.from("usuarios_corporativos").select("id, email, nombre_completo, rol, activo").order("email");
    byId("listaUsuarios").innerHTML = `<table><thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Activo</th></tr></thead><tbody>${(data || []).map((u) => `<tr><td>${escapar(u.email)}</td><td>${escapar(u.nombre_completo)}</td><td>${escapar(u.rol)}</td><td>${u.activo ? "Sí" : "No"}</td></tr>`).join("")}</tbody></table>`;
  }

  function clasificarEcosistema(fila) {
    const texto = `${fila.tipo_equipo || ""} ${fila.nombre_red || ""} ${fila.area || ""}`.toLowerCase();
    if (/sap|erp|finanzas|contab/.test(texto)) return "ERP-SAP";
    if (/handheld|impresora|planta|producci|panader/.test(texto)) return "INFRA-PLANTA";
    if (/office|m365|correo|teams|portátil|portatil|pc|monitor/.test(texto)) return "M365";
    if (/caja|pos|punto de venta|terminal/.test(texto)) return "POS-CAJAS";
    if (/switch|servidor|red|ups|access point|router/.test(texto)) return "REDES-SRV";
    return null;
  }

  async function migrarArchivo(archivo) {
    mensaje("Leyendo archivo…");
    try {
      const buffer = await archivo.arrayBuffer();
      const libro = window.XLSX.read(buffer, { type: "array", cellDates: true });
      const hoja = libro.Sheets[libro.SheetNames[0]];
      const filas = window.XLSX.utils.sheet_to_json(hoja, { defval: "", raw: false, FS: ",", RS: "\n" });
      const existentes = await cargarTodos("equipos", "*");
      const porPlaca = new Map(existentes.map((equipo) => [String(equipo.placa || "").trim(), equipo]));
      const registros = [];
      let sinCambios = 0;

      for (const fila of filas) {
        const cambios = {};
        for (const [encabezado, valor] of Object.entries(fila)) {
          const columna = ALIAS_IMPORT[normalizarEncabezado(encabezado)];
          if (!columna) continue;
          if (valor == null || String(valor).trim() === "") continue;
          cambios[columna] = columna === "fecha_vencimiento_contrato"
            ? fechaDesdeExcel(valor)
            : String(valor).trim();
        }

        const placa = cambios.placa || "";
        if (!placa) continue;

        const anterior = porPlaca.get(placa) || {};
        const registro = { ...anterior, ...cambios };
        delete registro.id;

        if (!registro.sistema_id) {
          const codigo = clasificarEcosistema(registro);
          const sistema = codigo ? ESTADO.sistemas.find((s) => s.codigo === codigo) : null;
          if (sistema) registro.sistema_id = sistema.id;
        }
        registro.modificado_por = ESTADO.perfil?.nombre_completo || "migración";
        if (Object.keys(cambios).length === 1) sinCambios += 1;
        registros.push(registro);
      }
      for (let i = 0; i < registros.length; i += 200) {
        const { error } = await sb.from("equipos").upsert(registros.slice(i, i + 200), { onConflict: "placa" });
        if (error) throw error;
      }
      mensaje(`${registros.length} equipos procesados · ${sinCambios} sin cambios nuevos · celdas vacías conservadas.`, "ok");
      await cargarEquipos();
    } catch (err) {
      mensaje("Error: " + err.message, "error");
    }
  }

  async function exportarExcel() {
    const data = await cargarTodos("equipos", columnasVisibles());
    const encabezados = ORDEN_MAESTRO.map(([header]) => header);
    const filas = data.map((equipo) => ORDEN_MAESTRO.map(([, columna]) => equipo[columna] ?? ""));
    const hoja = window.XLSX.utils.aoa_to_sheet([encabezados, ...filas]);
    hoja["!cols"] = ORDEN_MAESTRO.map(([header]) => ({ wch: Math.min(28, Math.max(12, header.length + 4)) }));
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, "Inventario");
    window.XLSX.writeFile(libro, `Levapan_Inventario_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  /* ---------------- Eventos ---------------- */

  function alternarAsistente(abrir) {
    const panel = byId("panelAsistente");
    panel.hidden = !abrir;
    if (abrir) byId("chatInput").focus();
  }

  function cerrarDrawer() {
    byId("sidebar")?.classList.remove("abierto");
    byId("app")?.classList.remove("movil-abierto");
    ["drawerFondo", "fondoCajon"].forEach((id) => {
      const fondo = byId(id);
      if (fondo) fondo.hidden = true;
    });
  }

  async function autocompletarActaDesde(campo, valor) {
    const texto = String(valor || "").trim();
    if (texto.length < 3) return;
    let datos = null;
    try {
      const consulta = sb.from("vista_veredicto_360").select("*");
      const { data } = await consulta.or(`placa.ilike.%${texto}%,serial.ilike.%${texto}%,responsable.ilike.%${texto}%,nombre_red.ilike.%${texto}%`).limit(1);
      datos = data?.[0];
    } catch { /* respaldo */ }
    if (!datos) {
      const { data } = await sb
        .from("equipos")
        .select("*")
        .or(`placa.ilike.%${texto}%,serial.ilike.%${texto}%,responsable.ilike.%${texto}%,usuario_asignado.ilike.%${texto}%`)
        .limit(1);
      datos = data?.[0];
    }
    if (!datos) return;
    if (byId("actaPlaca")) byId("actaPlaca").value = datos.placa || "";
    if (campo !== "actaColaborador" && byId("actaColaborador")) {
      byId("actaColaborador").value = datos.responsable || datos.usuario_asignado || "";
    }
    if (byId("actaCedula")) byId("actaCedula").value = datos.cedula || datos.usuario_cedula || "";
    if (byId("actaSede")) byId("actaSede").value = datos.sede || "";
    if (byId("actaObs") && !byId("actaObs").value) byId("actaObs").value = datos.bitacora || "";
  }

  function instalarEventos() {
    new MutationObserver(() => {
      document
        .querySelectorAll("td, .tarjeta strong, .ws-doc-info strong, .placa-item small")
        .forEach((elemento) => {
          if (!elemento.title) elemento.title = elemento.textContent.trim();
        });
    }).observe(document.body, { childList: true, subtree: true });

    byId("formLogin").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const error = byId("loginError");
      error.hidden = true;
      try {
        await iniciarSesion(byId("loginEmail").value, byId("loginPassword").value);
      } catch (err) {
        error.textContent = err.message || "No se pudo iniciar sesión";
        error.hidden = false;
      }
    });
    byId("btnSalir").addEventListener("click", cerrarSesion);

    document.querySelectorAll(".nav-item").forEach((b) => {
      b.title = b.querySelector(".nav-texto")?.textContent?.trim() || b.textContent.trim();
      b.addEventListener("click", () => {
        irAVista(b.dataset.vista);
        cerrarDrawer();
      });
    });

    const actualizarTituloBoton = (abierto) => {
      const boton = byId("btnToggleSidebar");
      if (!boton) return;
      boton.title = abierto ? "Expandir menú" : "Contraer menú";
      boton.setAttribute("aria-label", boton.title);
    };

    const alternarSidebar = () => {
      const app = byId("app");
      if (!app) return;
      // En celular el ≡ abre/cierra un cajón flotante; el riel de 46 px nunca se ensancha.
      if (window.innerWidth <= 768) {
        const abierto = app.classList.toggle("movil-abierto");
        const fondo = byId("fondoCajon");
        if (fondo) fondo.hidden = !abierto;
        actualizarTituloBoton(abierto);
        return;
      }
      // En PC se conserva el comportamiento de 210 px / 54 px.
      const colapsado = app.classList.toggle("sidebar-collapsed");
      localStorage.setItem("levapan_sidebar_collapsed", colapsado ? "1" : "0");
      actualizarTituloBoton(!colapsado);
      setTimeout(posicionarIndicador, 100);
      redimensionarFirmas();
    };

    // Delegación global: el ≡ funciona siempre y tocar fuera cierra el cajón móvil.
    document.addEventListener("click", (evento) => {
      if (evento.target.closest("#btnToggleSidebar")) {
        alternarSidebar();
        return;
      }
      if (evento.target.closest("#fondoCajon")) return cerrarDrawer();
      if (byId("app")?.classList.contains("movil-abierto") && !evento.target.closest("#sidebar")) cerrarDrawer();
    });

    // En celular la barra SIEMPRE arranca como riel de 46 px.
    const appShell = byId("app");
    if (window.innerWidth <= 768) {
      appShell?.classList.remove("sidebar-collapsed");
      appShell?.classList.remove("movil-abierto");
      const fondo = byId("fondoCajon");
      if (fondo) fondo.hidden = true;
      actualizarTituloBoton(false);
    } else if (localStorage.getItem("levapan_sidebar_collapsed") === "1") {
      appShell?.classList.add("sidebar-collapsed");
      actualizarTituloBoton(false);
    }
    window.addEventListener("resize", () => {
      if (window.innerWidth > 768) cerrarDrawer();
      redimensionarFirmas();
    });
    window.addEventListener("orientationchange", () => setTimeout(redimensionarFirmas, 250));
    document.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", () => { byId(b.dataset.cerrar).hidden = true; }));

    byId("formSistema").addEventListener("submit", guardarSistema);
    byId("formEquipo").addEventListener("submit", guardarEquipo);
    byId("formActa").addEventListener("submit", guardarActa);
    instalarPreviewsFotos();

    let temporizadorPlacaActa = null;
    let temporizadorNombreActa = null;

    const buscarSugerenciasActa = async (texto, caja) => {
      const filtros =
        `placa.ilike.%${texto}%,serial.ilike.%${texto}%,` +
        `responsable.ilike.%${texto}%,nombre_red.ilike.%${texto}%`;
      let resultados = [];
      try {
        const { data } = await sb.from("vista_veredicto_360").select("*").or(filtros).limit(8);
        resultados = data || [];
      } catch {
        const { data } = await sb.from("equipos").select("*").or(filtros).limit(8);
        resultados = data || [];
      }
      if (!caja) return;
      if (!resultados.length) {
        caja.innerHTML = '<button type="button" disabled>Sin coincidencias</button>';
        caja.hidden = false;
        return;
      }
      caja.innerHTML = resultados
        .map(
          (e) =>
            `<button type="button" data-sugerencia-placa="${escapar(e.id)}">` +
            `<strong>${escapar(e.placa)}</strong> · ${escapar(e.serial || "—")} · ` +
            `${escapar([e.marca, e.modelo].filter(Boolean).join(" ") || "—")} · ` +
            `${escapar(e.responsable || e.usuario_asignado || "—")}</button>`
        )
        .join("");
      caja.hidden = false;
    };

    [["actaPlaca", "placaSugerencias"], ["actaSerial", "serialSugerencias"]].forEach(([campoId, cajaId]) => {
      byId(campoId)?.addEventListener("input", (evento) => {
        clearTimeout(temporizadorPlacaActa);
        const texto = evento.target.value.trim();
        const caja = byId(cajaId);
        if (texto.length < 2) {
          if (caja) caja.hidden = true;
          return;
        }
        temporizadorPlacaActa = setTimeout(() => buscarSugerenciasActa(texto, caja), 300);
      });
    });

    byId("actaNombre")?.addEventListener("input", (evento) => {
      clearTimeout(temporizadorNombreActa);
      const texto = evento.target.value.trim();
      const cajaNombre = byId("nombreSugerencias");
      if (texto.length < 2) {
        if (cajaNombre) cajaNombre.hidden = true;
        return;
      }
      temporizadorNombreActa = setTimeout(async () => {
        if (!cajaNombre) return;
        try {
          const { data } = await sb
            .from("vista_veredicto_360")
            .select("responsable, cedula, sede")
            .ilike("responsable", `%${texto}%`)
            .limit(8);
          const nombres = [...new Set((data || []).map((f) => f.responsable).filter(Boolean))];
          const { data: usuarios } = await sb
            .from("usuarios_corporativos")
            .select("nombre_completo, email")
            .or(`nombre_completo.ilike.%${texto}%,email.ilike.%${texto}%`)
            .limit(8);
          const extras = (usuarios || []).map((u) => u.nombre_completo).filter(Boolean);
          const todos = [...new Set([...nombres, ...extras])];
          if (!todos.length) {
            cajaNombre.innerHTML = '<button type="button" disabled>Sin coincidencias</button>';
          } else {
            cajaNombre.innerHTML = todos
              .map((nombre) => `<button type="button" data-sugerencia-nombre="${escapar(nombre)}">${escapar(nombre)}</button>`)
              .join("");
          }
          cajaNombre.hidden = false;
        } catch {
          cajaNombre.hidden = true;
        }
      }, 320);
    });

    [["actaOtroAccesorioChk", "actaOtroAccesorio"], ["actaOtroSoftwareChk", "actaOtroSoftware"]].forEach(([checkId, inputId]) => {
      byId(checkId)?.addEventListener("change", (evento) => {
        const campo = byId(inputId);
        if (!campo) return;
        campo.hidden = !evento.target.checked;
        if (evento.target.checked) campo.focus();
        else campo.value = "";
      });
    });

    byId("btnLimpiarActa")?.addEventListener("click", () => llenarFormActa(null, "Asignación"));

    document.addEventListener("click", async (evento) => {
      const sugerenciaNombre = evento.target.closest("[data-sugerencia-nombre]");
      if (sugerenciaNombre) {
        const nombre = sugerenciaNombre.dataset.sugerenciaNombre;
        byId("actaNombre").value = nombre;
        byId("nombreSugerencias").hidden = true;
        try {
          const { data } = await sb
            .from("vista_veredicto_360")
            .select("cedula, sede")
            .eq("responsable", nombre)
            .limit(1);
          if (data?.[0]) {
            if (data[0].cedula) byId("actaDocumento").value = data[0].cedula;
            if (data[0].sede) byId("actaSede").value = data[0].sede;
          }
        } catch { /* datos parciales */ }
        return;
      }
      const sugerencia = evento.target.closest("[data-sugerencia-placa]");
      if (sugerencia) {
        const id = sugerencia.dataset.sugerenciaPlaca;
        let ficha = null;
        try {
          const { data } = await sb.from("vista_veredicto_360").select("*").eq("id", id).maybeSingle();
          ficha = data;
        } catch {
          const { data } = await sb.from("equipos").select("*").eq("id", id).maybeSingle();
          ficha = data;
        }
        if (ficha) {
          ESTADO.actaEquipo = ficha;
          await llenarFormActa(ficha, "Asignación");
        }
        return;
      }
      if (evento.target && !evento.target.closest(".acta-campo-placa, .acta-campo-serial")) {
        ["placaSugerencias", "serialSugerencias"].forEach((id) => {
          const caja = byId(id);
          if (caja) caja.hidden = true;
        });
      }
    });

    document.addEventListener("click", async (evento) => {
      // Botón maestro: delegación global, funciona tras recargas y filtros.
      const maestro = evento.target.closest("#btnTogglePlacas, #btnToggleContratos");
      if (maestro) {
        const vista = maestro.id === "btnTogglePlacas" ? "placas" : "contratos";
        aplicarCortinas(vista, maestro.textContent.trim() !== "Recoger todo");
        return;
      }
      if (evento.target.closest("[data-accion]")) return;

      const cabecera = evento.target.closest("[data-toggle-grupo], [data-toggle-subgrupo]");
      if (cabecera) {
        const clave = cabecera.dataset.acordeon || "placas";
        const indiceBruto = cabecera.dataset.indice;
        const indice = /^\d+$/.test(indiceBruto) ? Number(indiceBruto) : indiceBruto;
        const abiertos = acordeonSet(clave);
        if (abiertos.has(indice)) abiertos.delete(indice);
        else abiertos.add(indice);
        const abierto = abiertos.has(indice);
        const grupo = cabecera.closest(".acordeon-grupo, .accordion-item, .curtain-group, details");
        if (grupo) {
          grupo.classList.toggle("abierto", abierto);
          grupo.classList.toggle("is-open", abierto);
          if ("open" in grupo) grupo.open = abierto;
        }
        cabecera.setAttribute("aria-expanded", String(abierto));
        const flecha = cabecera.querySelector(".acordeon-flecha");
        if (flecha) flecha.textContent = "▸";
        if (clave.startsWith("contratos")) actualizarBotonContratos();
        else actualizarBotonPlacas();
        return;
      }

      const ficha = evento.target.closest("[data-placa-ficha]");
      if (ficha) {
        const equipo = (ESTADO.placas || []).find((e) => e.id === ficha.dataset.placaFicha);
        if (equipo) mostrarFichaPlaca(equipo);
        return;
      }
      const botonEquipo = evento.target.closest("[data-equipo]");
      if (botonEquipo) return accionEquipo(botonEquipo.dataset.equipo, botonEquipo.dataset.id);
      const tarjeta = evento.target.closest("[data-sistema]");
      if (tarjeta) {
        const sistema = ESTADO.sistemas.find((s) => s.id === tarjeta.dataset.sistema);
        irAVista("equipos");
        byId("buscarEquipo").value = sistema?.codigo || "";
        cargarEquipos();
      }
      const doc = evento.target.closest("[data-doc]");
      if (doc) abrirDocumento(doc.dataset.doc);
    });

    byId("buscarEquipo").addEventListener("input", () => cargarEquipos());
    ["filtroSede", "filtroCeco", "filtroEstado"].forEach((id) => byId(id)?.addEventListener("change", cargarEquipos));
    byId("buscarPlaca").addEventListener("input", () => cargarPlacas());
    document.addEventListener("click", (evento) => {
      const verMas = evento.target.closest("[data-ver-mas]");
      if (!verMas) return;
      const tipo = verMas.dataset.verMas;
      if (tipo === "equipos") {
        ESTADO.equiposLimite = (ESTADO.equiposLimite || 40) + 40;
        cargarEquipos();
      } else if (tipo === "placas") {
        ESTADO.placasLimite = (ESTADO.placasLimite || 40) + 40;
        cargarPlacas();
      } else if (tipo === "contratos") {
        ESTADO.contratosLimite = (ESTADO.contratosLimite || 40) + 40;
        cargarContratos();
      }
    });
    document.addEventListener("keydown", (evento) => {
      if (!["Enter", " "].includes(evento.key)) return;
      const cabecera = evento.target.closest?.("[data-toggle-grupo], [data-toggle-subgrupo]");
      if (!cabecera) return;
      evento.preventDefault();
      cabecera.click();
    });

    document.addEventListener("click", (evento) => {
      const accion = evento.target.closest("[data-accion]")?.dataset.accion;
      if (!accion) return;
      if (accion === "nuevo-sistema") return abrirModalSistema(null);
      if (accion === "nuevo-equipo") return abrirModalEquipo(null);
      if (accion === "nueva-acta") return abrirActa(null, "ASIGNACIÓN");
      if (accion === "generar-acta-placa") {
        const equipo = ESTADO.equipos.find((e) => e.placa === byId("actaPlaca")?.dataset.placa) || ESTADO.equipos.find((e) => e.placa === evento.target.dataset.placa);
        return abrirActa(equipo || null, "ASIGNACIÓN");
      }
      if (accion === "exportar") return exportarExcel();
      if (accion === "exportar-contratos") return exportarContratos();
      if (accion === "importar" || accion === "migrar") return byId("archivoImportar").click();
      if (accion === "importar-hp") return byId("archivoHpWxp").click();
      if (accion === "modo-auditoria") return modoAuditoria();
      if (accion === "respaldo-maestro") return exportarRespaldoMaestro();
      if (accion === "sync-entra") return sincronizarEntraAhora(evento.target.closest("[data-accion]"));
      if (accion === "eliminar-doc") return eliminarDocumento(evento.target.closest("[data-accion]"));
      if (accion === "eliminar-sistema") return eliminarSistema(evento.target.closest("[data-accion]"));
    });

    byId("archivoHpWxp")?.addEventListener("change", async (evento) => {
      const archivo = evento.target.files?.[0];
      if (archivo) await importarCsvHp(archivo);
      evento.target.value = "";
    });

    byId("btnEscanear")?.addEventListener("click", abrirEscanner);
    ["filtroProveedor", "filtroSedeContrato", "filtroCecoContrato", "filtroSemacoro"].forEach((id) => {
      byId(id)?.addEventListener("change", cargarContratos);
    });

    document.addEventListener("click", (evento) => {
      const limpiar = evento.target.closest("[data-limpiar-firma]");
      if (limpiar) limpiarFirma(limpiar.dataset.limpiarFirma);
      const cerrarScanner = evento.target.closest('[data-cerrar="modalEscanner"]');
      if (cerrarScanner) {
        byId("modalEscanner")?.remove();
        window.__lectorActivo?.stop?.().catch(() => {});
        window.__lectorActivo = null;
      }
    });

    byId("btnLimpiarChat")?.addEventListener("click", () => {
      const area = byId("chatMensajes");
      if (area) area.innerHTML = "";
    });

    byId("archivoImportar").addEventListener("change", async (evento) => {
      const archivo = evento.target.files?.[0];
      if (archivo) await migrarArchivo(archivo);
      evento.target.value = "";
    });

    let installPrompt = null;
    const botonInstalar = byId("btnInstalar");
    const yaInstalada = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
    if (botonInstalar) {
      botonInstalar.hidden = yaInstalada;
      botonInstalar.title = "Instalar la PWA Levapan TI en este equipo";
      botonInstalar.addEventListener("click", async () => {
        if (installPrompt) {
          try {
            installPrompt.prompt();
            await installPrompt.userChoice;
          } catch (err) {
            alert(`No se pudo abrir el instalador: ${err.message}`);
            return;
          }
          installPrompt = null;
          botonInstalar.hidden = true;
          return;
        }
        const agente = navigator.userAgent || "";
        const esApple = /iPad|iPhone|iPod/.test(agente) ||
          (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
        const guia = esApple
          ? "Para instalar Levapan TI en iPhone/iPad:\n1) Pulsa Compartir.\n2) Elige «Agregar a pantalla de inicio».\n3) Confirma «Agregar»."
          : "Para instalar Levapan TI:\n1) Abre el menú del navegador (⋮).\n2) Elige «Instalar aplicación» o «Guardar y compartir → Instalar página».\n3) Confirma la instalación.";
        alert(guia);
      });
    }
    window.addEventListener("beforeinstallprompt", (evento) => {
      evento.preventDefault();
      installPrompt = evento;
      if (botonInstalar) botonInstalar.hidden = false;
    });
    window.addEventListener("appinstalled", () => {
      installPrompt = null;
      if (botonInstalar) botonInstalar.hidden = true;
    });

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  async function iniciar() {
    instalarEventos();

    sb.auth.onAuthStateChange((evento, sesion) => {
      if (sesion?.user && ["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(evento)) {
        ocultarLogin();
      }
      if (evento === "SIGNED_OUT") {
        ocultarLogin();
        window.__ultimoUsuarioCargado = null;
      }
      cargarSesion(sesion, evento).catch((err) => {
        const error = byId("loginError");
        if (error) {
          error.textContent = err.message || "No se pudo iniciar sesión";
          error.hidden = false;
        }
        if (evento === "SIGNED_OUT") mostrarLogin();
      });
    });

    try {
      await cargarSesion();
    } catch (err) {
      const error = byId("loginError");
      if (error) {
        error.textContent = err.message;
        error.hidden = false;
      }
    }
  }

  window.LevapanApp = { sb, ESTADO, cargarTodos, irAVista, abrirModalEquipo, mostrarFichaPlaca, abrirActa, generarYSubirActa, registrarHistorial, ORDEN_MAESTRO };

  iniciar();
})();
