/* Levapan TI — PWA directa a Supabase (sin servidor intermedio). */
(function () {
  "use strict";

  const CFG = window.LEVAPAN_CONFIG;
  const byId = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const ESTADO = {
    perfil: null,
    vista: "sistemas",
    sistemas: [],
    equipos: [],
    ultimaPlaca: null,
  };

  const TITULOS = {
    sistemas: "Ecosistemas de TI",
    placas: "Placas & QR",
    equipos: "Equipos",
    contratos: "Contratos y Garantías",
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

  async function iniciarMicrosoft() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: "azure",
      options: { scopes: "openid profile email User.Read", redirectTo: window.location.origin },
    });
    if (error) throw error;
  }

  async function registrarCuenta(nombre, cedula, correo, clave) {
    const email = correo.trim().toLowerCase();
    if (!email.endsWith("@levapan.com")) throw new Error("Solo se permiten correos corporativos @levapan.com");
    if (!nombre.trim() || !cedula.trim()) throw new Error("Nombre completo y cédula son obligatorios");
    if (clave.length < 6) throw new Error("La contraseña debe tener al menos 6 caracteres");

    const { data, error } = await sb.auth.signUp({
      email,
      password: clave,
      options: { data: { nombre_completo: nombre.trim(), cedula: cedula.trim() } },
    });
    if (error) throw error;

    const usuario = data?.user;
    if (usuario) {
      await sb.from("usuarios_corporativos").upsert([{
        id: usuario.id,
        email,
        nombre_completo: nombre.trim(),
        rol: "TECNICO_TI",
        activo: true,
      }], { onConflict: "id" });
    }

    if (!data?.session) {
      throw new Error("Cuenta creada. Confirma tu correo corporativo e ingresa con tu contraseña.");
    }
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

  function limpiarParametrosOAuth() {
    const url = window.location.href;
    if (/[?#](?:code|access_token|error_description|state)=/.test(url)) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
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

    // Cierre inmediato del overlay en cuanto hay sesión válida (OAuth incluido).
    ocultarLogin();
    limpiarParametrosOAuth();
    document.body.dataset.sesion = "activa";

    if (["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(evento)) {
      ocultarLogin();
    }

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
      <tbody>${ESTADO.equipos.map((e) => {
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
      }).join("")}</tbody></table>` || '<p class="vacio">Sin equipos.</p>';
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

  function abrirActa(equipo, tipo) {
    byId("actaPlaca").value = equipo?.placa || "";
    byId("actaColaborador").value = equipo?.responsable || "";
    byId("actaCedula").value = equipo?.cedula || "";
    byId("actaSede").value = equipo?.sede || "";
    byId("actaTipo").value = tipo;
    byId("actaObs").value = "";
    const tecnico = byId("firmaTecnicoNombre");
    if (tecnico) tecnico.textContent = ESTADO.perfil?.nombre_completo || "Técnico TI";
    instalarFirmas();
    limpiarFirma("firmaColaborador");
    limpiarFirma("firmaTecnico");
    byId("modalActa").hidden = false;
  }

  async function guardarActa(evento) {
    evento.preventDefault();
    const placa = byId("actaPlaca").value.trim();
    const { data: equipo } = await sb.from("equipos").select("*").eq("placa", placa).maybeSingle();
    if (!equipo) return alert("No se encontró la placa");

    const tipo = byId("actaTipo").value;
    const responsable = byId("actaColaborador").value.trim();
    const cedula = byId("actaCedula").value.trim();
    const sede = byId("actaSede").value.trim();
    const observaciones = byId("actaObs").value.trim();

    const cambios = {
      responsable: tipo === "DEVOLUCIÓN" ? null : responsable,
      cedula: tipo === "DEVOLUCIÓN" ? null : cedula,
      sede: sede || null,
      estado: tipo === "DEVOLUCIÓN" ? "DISPONIBLE" : "ASIGNADO",
      modificado_por: ESTADO.perfil?.nombre_completo || "sistema",
    };
    const { data: actualizado, error } = await sb.from("equipos").update(cambios).eq("id", equipo.id).select().single();
    if (error) return alert(error.message);

    const url = await generarYSubirActa(actualizado, tipo, responsable, cedula, sede, observaciones, datosFirmas());
    await registrarHistorial(actualizado, tipo, `Acta CORP-TEC-FR-002 · ${placa} · ${responsable || "devolución"}`, {
      responsable_anterior: equipo.responsable,
      responsable_nuevo: cambios.responsable,
      sede_nueva: sede,
      acta_pdf_url: url,
    });
    byId("modalActa").hidden = true;
    cargarEquipos();
  }

  async function generarYSubirActa(equipo, tipo, responsable, cedula, sede, observaciones, firmas) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16); doc.setTextColor(139, 30, 36);
    doc.text("LEVAPAN S.A.S. — CORP-TEC-FR-002", 18, 22);
    doc.setFontSize(8.5); doc.setTextColor(28, 28, 28);
    const lineas = [
      ...ORDEN_MAESTRO.map(([header, columna]) => `${header}: ${equipo[columna] ?? "—"}`),
      "",
      `Responsable del acta: ${responsable || "—"} · Cédula: ${cedula || "—"} · Sede: ${sede || "—"}`,
      `Observaciones: ${observaciones || "—"}`,
      "",
      "El colaborador declara recibir el activo en buen estado y se compromete a su custodia.",
      "",
      "______________________________     ______________________________",
      "Firma colaborador                 Firma Tecnología e Infraestructura",
    ];
    lineas.forEach((linea, i) => doc.text(linea, 18, 44 + i * 6.5));

    const yFirmas = Math.min(262, 48 + lineas.length * 6.5);
    if (firmas?.colaborador) doc.addImage(firmas.colaborador, "PNG", 18, yFirmas, 72, 22);
    if (firmas?.tecnico) doc.addImage(firmas.tecnico, "PNG", 110, yFirmas, 72, 22);
    doc.setFontSize(8);
    doc.text(`Emitida por: ${ESTADO.perfil?.nombre_completo || "sistema"} · ${fechaHora(new Date())}`, 18, yFirmas + 30);
    const blob = doc.output("blob");
    const ruta = `actas/${equipo.placa}/${Date.now()}.pdf`;
    const subida = await sb.storage.from(CFG.bucket).upload(ruta, blob, { contentType: "application/pdf", upsert: false });
    if (subida.error) return null;
    const firmada = await sb.storage.from(CFG.bucket).createSignedUrl(ruta, 3600);
    await sb.from("boveda_documentos").insert([{
      titulo: `ACTA ${tipo} · ${equipo.placa}`, categoria: "Acta", equipo_id: equipo.id,
      placa: equipo.placa, storage_path: ruta, url: firmada.data?.signedUrl || null, mime_type: "application/pdf",
    }]);
    return firmada.data?.signedUrl || null;
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

  async function cargarPlacas() {
    const data = await cargarTodos("equipos", columnasVisibles());
    ESTADO.placas = data;
    byId("listaPlacas").innerHTML = `<div class="grid-placas">${(data || []).map((e) => `<button type="button" class="tarjeta placa-item mono" data-placa-ficha="${escapar(e.id)}">
      <strong>${escapar(e.placa)}</strong>
      <small>${escapar(e.nombre_red || "Sin nombre en red")} · ${escapar(e.sede || "—")}</small>
    </button>`).join("")}</div>` || '<p class="vacio">Sin placas registradas.</p>';
    if (data?.[0]) mostrarFichaPlaca(data[0]);
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

    byId("listaContratos").innerHTML = `<table class="tabla-inventario">
      <thead><tr><th>Placa</th><th>Equipo</th><th>Proveedor</th><th>N° Contrato</th><th>Tipo</th><th>Vencimiento</th><th>Semáforo</th><th></th></tr></thead>
      <tbody>${filas.map((e) => {
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
      }).join("")}</tbody></table>` || '<p class="vacio">Sin contratos con esos filtros.</p>';
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
    const fondo = byId("drawerFondo");
    if (fondo) fondo.hidden = true;
  }

  function instalarEventos() {
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
    byId("btnMicrosoft").addEventListener("click", async () => {
      try { await iniciarMicrosoft(); } catch (err) { alert(err.message); }
    });

    byId("tabLogin").addEventListener("click", () => {
      byId("formLogin").hidden = false;
      byId("formRegistro").hidden = true;
      byId("tabLogin").classList.add("activa");
      byId("tabRegistro").classList.remove("activa");
      byId("tabLogin").setAttribute("aria-selected", "true");
      byId("tabRegistro").setAttribute("aria-selected", "false");
    });

    byId("tabRegistro").addEventListener("click", () => {
      byId("formRegistro").hidden = false;
      byId("formLogin").hidden = true;
      byId("tabRegistro").classList.add("activa");
      byId("tabLogin").classList.remove("activa");
      byId("tabRegistro").setAttribute("aria-selected", "true");
      byId("tabLogin").setAttribute("aria-selected", "false");
    });

    byId("formRegistro").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const error = byId("registroError");
      error.hidden = true;
      try {
        await registrarCuenta(
          byId("regNombre").value,
          byId("regCedula").value,
          byId("regCorreo").value,
          byId("regClave").value
        );
      } catch (err) {
        error.textContent = err.message || "No se pudo crear la cuenta";
        error.hidden = false;
      }
    });

    byId("btnSalir").addEventListener("click", cerrarSesion);

    document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => {
      irAVista(b.dataset.vista);
      cerrarDrawer();
    }));

    byId("btnMenuMovil")?.addEventListener("click", (evento) => {
      evento.stopPropagation();
      byId("sidebar")?.classList.toggle("abierto");
      byId("drawerFondo").hidden = !byId("sidebar")?.classList.contains("abierto");
    });
    byId("drawerFondo")?.addEventListener("click", cerrarDrawer);
    document.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", () => { byId(b.dataset.cerrar).hidden = true; }));

    byId("formSistema").addEventListener("submit", guardarSistema);
    byId("formEquipo").addEventListener("submit", guardarEquipo);
    byId("formActa").addEventListener("submit", guardarActa);

    document.addEventListener("click", (evento) => {
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
      if (accion === "modo-auditoria") return modoAuditoria();
      if (accion === "respaldo-maestro") return exportarRespaldoMaestro();
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
    window.addEventListener("beforeinstallprompt", (evento) => {
      evento.preventDefault();
      installPrompt = evento;
      byId("btnInstalar").hidden = false;
    });
    byId("btnInstalar").addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      byId("btnInstalar").hidden = true;
    });

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  async function iniciar() {
    instalarEventos();
    try { await cargarSesion(); }
    catch (err) {
      const error = byId("loginError");
      error.textContent = err.message;
      error.hidden = false;
    }
    sb.auth.onAuthStateChange((evento, sesion) => {
      if (sesion?.user && ["SIGNED_IN", "INITIAL_SESSION", "TOKEN_REFRESHED"].includes(evento)) {
        ocultarLogin();
        limpiarParametrosOAuth();
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
  }

  window.LevapanApp = { sb, ESTADO, cargarTodos, irAVista, abrirModalEquipo, mostrarFichaPlaca, abrirActa, generarYSubirActa, registrarHistorial, ORDEN_MAESTRO };

  iniciar();
})();
