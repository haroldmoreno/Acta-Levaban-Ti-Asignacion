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
    boveda: "Bóveda PDF",
    admin: "Administración TI",
  };

  const COLUMNAS = {
    "Placa": "placa",
    "Nombre equipo en red": "nombre_red",
    "Serial del equipo": "serial",
    "Nombre del responsable": "responsable",
    "Cedula del responsable": "cedula",
    "Empresa": "empresa",
    "Sede": "sede",
    "CECO": "ceco",
    "Estado": "estado",
    "Proveedor": "proveedor",
    "N° Contrato": "num_contrato",
    "Tipo de Contrato": "tipo_contrato",
    "Fecha de Vencimiento Contrato": "fecha_vencimiento_contrato",
    "Tipo de Equipo": "tipo_equipo",
    "Marca": "marca",
    "Modelo": "modelo",
    "Procesador": "procesador",
    "Memoria RAM": "ram",
    "Tamaño en Disco": "disco",
    "Bitacora del Equipo": "bitacora",
    "Creado por": "modificado_por",
    "Modificado por": "modificado_por",
    "Accesorios entregados": "accesorios",
    "Area": "area",
    "Tipo de elemento": "tipo_equipo",
    "Ruta de acceso": "bitacora",
  };

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
      options: { scopes: "email profile openid", redirectTo: location.origin + "/" },
    });
    if (error) throw error;
  }

  async function cargarSesion() {
    const { data } = await sb.auth.getSession();
    const sesion = data?.session;
    if (!sesion) {
      byId("pantallaLogin").hidden = false;
      byId("app").hidden = true;
      return;
    }

    const email = String(sesion.user.email || "").toLowerCase();
    if (!email.endsWith("@levapan.com")) {
      await sb.auth.signOut();
      throw new Error("Solo se permiten correos corporativos @levapan.com");
    }

    let { data: perfil } = await sb.from("usuarios_corporativos").select("*").eq("id", sesion.user.id).maybeSingle();
    if (!perfil) {
      const rol = email === "admin@levapan.com" ? "ADMINISTRADOR_TI" : "TECNICO_TI";
      const respuesta = await sb.from("usuarios_corporativos").insert([
        { id: sesion.user.id, email, nombre_completo: sesion.user.user_metadata?.nombre_completo || email.split("@")[0], rol, activo: true },
      ]).select().maybeSingle();
      perfil = respuesta.data;
    }
    if (!perfil?.activo) {
      await sb.auth.signOut();
      throw new Error("Tu cuenta TI está inactiva");
    }

    ESTADO.perfil = perfil;
    byId("pantallaLogin").hidden = true;
    byId("app").hidden = false;
    byId("usuarioNombre").textContent = perfil.nombre_completo || email;
    byId("usuarioRol").textContent = perfil.rol === "ADMINISTRADOR_TI" ? "ADMINISTRADOR TI" : "TECNICO TI";
    byId("estadoConexion").textContent = "En vivo · Supabase";
    document.querySelectorAll("[data-admin]").forEach((el) => { el.hidden = perfil.rol !== "ADMINISTRADOR_TI"; });

    await Promise.all([cargarSistemas(), cargarEquipos(), cargarBoveda(), cargarUsuarios()]);
    irAVista("sistemas");
    suscribirRealtime();
  }

  async function cerrarSesion() {
    await sb.auth.signOut();
    ESTADO.perfil = null;
    byId("app").hidden = true;
    byId("pantallaLogin").hidden = false;
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
    if (vista === "sistemas") cargarSistemas();
    if (vista === "equipos") cargarEquipos();
    if (vista === "placas") cargarPlacas();
    if (vista === "boveda") cargarBoveda();
    if (vista === "admin") cargarUsuarios();
  }

  /* ---------------- Ecosistemas ---------------- */

  async function cargarSistemas() {
    const [sistemas, equipos, documentos] = await Promise.all([
      sb.from("sistemas").select("*").order("nombre"),
      sb.from("equipos").select("id, sistema_id, placa"),
      sb.from("boveda_documentos").select("id, placa"),
    ]);

    ESTADO.sistemas = sistemas.data || [];
    const placasPorSistema = {};
    (equipos.data || []).forEach((e) => {
      if (e.sistema_id) placasPorSistema[e.sistema_id] = (placasPorSistema[e.sistema_id] || 0) + 1;
    });
    const docsPorPlaca = {};
    (documentos.data || []).forEach((d) => {
      if (d.placa) docsPorPlaca[d.placa] = (docsPorPlaca[d.placa] || 0) + 1;
    });

    byId("gridSistemas").innerHTML = ESTADO.sistemas.map((s) => {
      const placas = placasPorSistema[s.id] || 0;
      const docs = (equipos.data || []).filter((e) => e.sistema_id === s.id).reduce((n, e) => n + (docsPorPlaca[e.placa] || 0), 0);
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
    return "id, sistema_id, placa, nombre_red, serial, responsable, cedula, empresa, sede, ceco, estado, proveedor, num_contrato, tipo_contrato, fecha_vencimiento_contrato, tipo_equipo, marca, modelo, procesador, ram, disco, bitacora, accesorios, area, modificado_por";
  }

  async function cargarEquipos() {
    let consulta = sb.from("equipos").select(columnasVisibles()).order("placa").limit(2000);
    const q = byId("buscarEquipo")?.value.trim();
    const sede = byId("filtroSede")?.value;
    const ceco = byId("filtroCeco")?.value;
    const estado = byId("filtroEstado")?.value;
    if (q) consulta = consulta.or(`placa.ilike.%${q}%,serial.ilike.%${q}%,responsable.ilike.%${q}%,nombre_red.ilike.%${q}%`);
    if (sede) consulta = consulta.eq("sede", sede);
    if (ceco) consulta = consulta.eq("ceco", ceco);
    if (estado) consulta = consulta.eq("estado", estado);

    const { data, error } = await consulta;
    if (error) { byId("tablaEquipos").innerHTML = `<p class="vacio">${escapar(error.message)}</p>`; return; }
    ESTADO.equipos = data || [];
    actualizarFiltros(ESTADO.equipos);
    byId("tablaEquipos").innerHTML = `<table>
      <thead><tr><th>Placa</th><th>Nombre en red</th><th>Equipo</th><th>Serial</th><th>Responsable</th><th>Sede / CECO</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${ESTADO.equipos.map((e) => `<tr>
        <td class="mono">${escapar(e.placa)}</td>
        <td>${escapar(e.nombre_red || "—")}</td>
        <td>${escapar([e.tipo_equipo, e.marca, e.modelo].filter(Boolean).join(" · ") || "—")}</td>
        <td class="mono">${escapar(e.serial || "—")}</td>
        <td>${escapar(e.responsable || "—")}${e.cedula ? " · " + escapar(e.cedula) : ""}</td>
        <td>${escapar(e.sede || "—")} · ${escapar(e.ceco || "—")}</td>
        <td>${escapar(e.estado || "—")}</td>
        <td>
          <button class="boton" data-equipo="editar" data-id="${escapar(e.id)}">Editar</button>
          <button class="boton" data-equipo="asignar" data-id="${escapar(e.id)}">Asignar</button>
          <button class="boton" data-equipo="devolver" data-id="${escapar(e.id)}">Devolver</button>
          <button class="boton" data-equipo="baja" data-id="${escapar(e.id)}">Baja</button>
          <button class="boton" data-equipo="hoja" data-id="${escapar(e.id)}">Hoja</button>
          <button class="boton" data-equipo="qr" data-id="${escapar(e.id)}">QR</button>
        </td>
      </tr>`).join("")}</tbody></table>` || '<p class="vacio">Sin equipos.</p>';
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
    ].forEach(([id, campo]) => poner(id, equipo?.[campo]));
    byId("eqSistema").innerHTML = '<option value="">Sin ecosistema</option>' + ESTADO.sistemas.map((s) => `<option value="${escapar(s.id)}">${escapar(s.nombre)}</option>`).join("");
    byId("eqSistema").value = equipo?.sistema_id || "";
    byId("tituloModalEquipo").textContent = equipo ? "Editar ficha técnica" : "Registrar equipo";
    byId("modalEquipo").hidden = false;
  }

  async function guardarEquipo(evento) {
    evento.preventDefault();
    const id = byId("eqId").value;
    const valor = (idCampo) => byId(idCampo)?.value.trim() || null;
    const registro = {
      placa: valor("eqPlaca"), nombre_red: valor("eqNombreRed"), serial: valor("eqSerial"),
      tipo_equipo: valor("eqTipoEquipo"), marca: valor("eqMarca"), modelo: valor("eqModelo"),
      procesador: valor("eqProcesador"), ram: valor("eqRam"), disco: valor("eqDisco"),
      responsable: valor("eqResponsable"), cedula: valor("eqCedula"), empresa: valor("eqEmpresa"),
      sede: valor("eqSede"), ceco: valor("eqCeco"), estado: valor("eqEstado"),
      proveedor: valor("eqProveedor"), num_contrato: valor("eqContrato"),
      tipo_contrato: valor("eqTipoContrato"), fecha_vencimiento_contrato: valor("eqVencimiento"),
      sistema_id: valor("eqSistema"), accesorios: valor("eqAccesorios"), bitacora: valor("eqBitacora"),
      area: valor("eqArea"), modificado_por: ESTADO.perfil?.nombre_completo || "sistema",
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

    const url = await generarYSubirActa(actualizado, tipo, responsable, cedula, sede, observaciones);
    await registrarHistorial(actualizado, tipo, `Acta CORP-TEC-FR-002 · ${placa} · ${responsable || "devolución"}`, {
      responsable_anterior: equipo.responsable,
      responsable_nuevo: cambios.responsable,
      sede_nueva: sede,
      acta_pdf_url: url,
    });
    byId("modalActa").hidden = true;
    cargarEquipos();
  }

  async function generarYSubirActa(equipo, tipo, responsable, cedula, sede, observaciones) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(16); doc.setTextColor(139, 30, 36);
    doc.text("LEVAPAN S.A.S. — CORP-TEC-FR-002", 18, 22);
    doc.setFontSize(11); doc.setTextColor(28, 28, 28);
    doc.text(`Acta de ${tipo === "DEVOLUCIÓN" ? "devolución" : "asignación"} de activo`, 18, 34);
    const lineas = [
      `Placa: ${equipo.placa}`,
      `Nombre en red: ${equipo.nombre_red || "—"}`,
      `Serial: ${equipo.serial || "—"}`,
      `Equipo: ${[equipo.tipo_equipo, equipo.marca, equipo.modelo].filter(Boolean).join(" · ")}`,
      `Responsable: ${responsable || "—"}`,
      `Cédula: ${cedula || "—"}`,
      `Sede: ${sede || "—"} · CECO: ${equipo.ceco || "—"}`,
      `Estado: ${equipo.estado || "—"}`,
      `Observaciones: ${observaciones || "—"}`,
      "",
      "El colaborador declara recibir el activo en buen estado y se compromete a su custodia.",
      "",
      "______________________________     ______________________________",
      "Firma colaborador                 Firma Tecnología e Infraestructura",
    ];
    lineas.forEach((linea, i) => doc.text(linea, 18, 50 + i * 9));
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
    const { data } = await sb.from("historial_movimientos").select("*").eq("equipo_id", equipo.id).order("fecha_colombia", { ascending: false }).limit(30);
    const lineas = (data || []).map((m) => `<div class="tarjeta" style="margin-bottom:8px"><strong>${escapar(m.tipo_movimiento)}</strong><p>${escapar(m.observaciones || "—")}</p><small>${fechaHora(m.fecha_colombia)} · ${escapar(m.tecnico_responsable || "sistema")}</small></div>`).join("");
    const ventana = window.open("", "_blank");
    ventana.document.write(`<title>Hoja de Vida · ${equipo.placa}</title><body style="font-family:Inter,sans-serif;padding:24px"><h1>${equipo.placa}</h1><p>${escapar(equipo.nombre_red || "")}</p>${lineas || "<p>Sin movimientos</p>"}</body>`);
  }

  /* ---------------- Placas y QR ---------------- */

  async function cargarPlacas() {
    const { data } = await sb.from("equipos").select(columnasVisibles()).order("placa").limit(2000);
    byId("listaPlacas").innerHTML = `<div class="grid-sistemas">${(data || []).map((e) => `<article class="tarjeta">
      <span class="codigo mono">${escapar(e.placa)}</span>
      <h3>${escapar(e.nombre_red || "Sin nombre en red")}</h3>
      <p>${escapar(e.sede || "—")} · ${escapar(e.ceco || "—")}</p>
      <button class="boton" data-equipo="qr" data-id="${escapar(e.id)}">Generar QR</button>
    </article>`).join("")}</div>`;
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
      const registros = [];
      for (const fila of filas) {
        const registro = {};
        for (const [encabezado, columna] of Object.entries(COLUMNAS)) {
          if (Object.hasOwn(fila, encabezado)) registro[columna] = String(fila[encabezado] ?? "").trim() || null;
        }
        if (!registro.placa) continue;
        const codigo = clasificarEcosistema(registro);
        if (codigo) {
          const sistema = ESTADO.sistemas.find((s) => s.codigo === codigo);
          if (sistema) registro.sistema_id = sistema.id;
        }
        registro.modificado_por = ESTADO.perfil?.nombre_completo || "migración";
        registros.push(registro);
      }
      for (let i = 0; i < registros.length; i += 200) {
        const { error } = await sb.from("equipos").upsert(registros.slice(i, i + 200), { onConflict: "placa" });
        if (error) throw error;
      }
      mensaje(`${registros.length} equipos migrados y clasificados.`, "ok");
      await cargarEquipos();
    } catch (err) {
      mensaje("Error: " + err.message, "error");
    }
  }

  async function exportarExcel() {
    const { data } = await sb.from("equipos").select(columnasVisibles()).order("placa").limit(5000);
    const hoja = window.XLSX.utils.json_to_sheet(data || []);
    const libro = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(libro, hoja, "Inventario");
    window.XLSX.writeFile(libro, `Levapan_Inventario_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  /* ---------------- Asistente TI ---------------- */

  function burbuja(texto, quien, clase) {
    const el = document.createElement("div");
    el.className = "burbuja " + quien + (clase ? " " + clase : "");
    el.textContent = texto;
    byId("chatMensajes").appendChild(el);
    byId("chatMensajes").scrollTop = byId("chatMensajes").scrollHeight;
    return el;
  }

  function extraerTermino(mensaje) {
    const numerico = mensaje.match(/(?:ML-?)?\d{3,}/i);
    if (numerico) return numerico[0];
    const stop = new Set(["busca", "buscar", "muestra", "dame", "equipos", "de", "del", "la", "el", "los", "en", "con", "que", "tiene", "por", "para", "cuándo", "cuando", "vence", "contrato"]);
    return mensaje.toLowerCase().replace(/[?¿.,!]/g, " ").split(/\s+/).filter((p) => p.length >= 3 && !stop.has(p)).slice(-3).join(" ") || mensaje;
  }

  async function buscarEquipo(termino) {
    let consulta = sb.from("equipos").select(columnasVisibles());
    const t = extraerTermino(termino);
    consulta = consulta.or(`placa.ilike.%${t}%,serial.ilike.%${t}%,responsable.ilike.%${t}%,cedula.ilike.%${t}%,ceco.ilike.%${t}%,sede.ilike.%${t}%,nombre_red.ilike.%${t}%,num_contrato.ilike.%${t}%`);
    const { data } = await consulta.limit(5);
    return data?.[0] || null;
  }

  async function responderChat(texto) {
    const mensaje = texto.trim();
    const bajo = mensaje.toLowerCase();
    const nombre = (ESTADO.perfil?.nombre_completo || "colega").split(" ")[0];

    if (/^(hola|buenos días|buenas tardes|buenas noches|qué tal|hey|saludos|gracias|ayuda|quién eres)/.test(bajo)) {
      if (/gracias/.test(bajo)) return burbuja(`Con gusto, ${nombre}.`, "asistente");
      if (/ayuda|quién eres/.test(bajo)) return burbuja(`${saludo()}, ${nombre}. Soy el Asistente Integral TI. Puedo buscar placas, asignar equipos, ver contratos próximos a vencer, mostrar la hoja de vida y generar actas. Ejemplo: «muéstrame la hoja de vida de 01882».`, "asistente");
      return burbuja(`${saludo()}, ${nombre}! ¿Qué activo revisamos?`, "asistente");
    }

    const usaContexto = /su |suyo|lo tiene|historial|cuándo vence|cuando vence|vincúlalo|vinculalo/.test(bajo);
    const termino = usaContexto && ESTADO.ultimaPlaca ? ESTADO.ultimaPlaca : mensaje;
    const equipo = await buscarEquipo(termino);

    if (!equipo) return burbuja(`No encontré un equipo con «${extraerTermino(termino)}». Prueba con una placa, serial o cédula.`, "asistente");

    ESTADO.ultimaPlaca = equipo.placa;

    if (/historial|qué se le ha hecho|que se le ha hecho/.test(bajo)) {
      const { data } = await sb.from("historial_movimientos").select("*").eq("equipo_id", equipo.id).order("fecha_colombia", { ascending: false }).limit(8);
      const lineas = (data || []).map((m) => `• ${fechaHora(m.fecha_colombia)} · ${m.tipo_movimiento}: ${m.observaciones || "—"}`).join("\n");
      return burbuja(`Hoja de vida de ${equipo.placa}:\n${lineas || "Sin movimientos"}`, "asistente");
    }

    if (/quién lo tiene|quien lo tiene|responsable/.test(bajo)) {
      return burbuja(`El equipo ${equipo.placa} está a cargo de ${equipo.responsable || "sin responsable"}${equipo.sede ? ` en ${equipo.sede}` : ""}.`, "asistente");
    }

    if (/vence|contrato/.test(bajo)) {
      return burbuja(`${equipo.placa} · Contrato ${equipo.num_contrato || "—"} (${equipo.tipo_contrato || "—"}), vence ${equipo.fecha_vencimiento_contrato || "sin fecha"}.`, "asistente");
    }

    if (/cambia el estado|cámbiale el estado|cambiale el estado|pon .*en/.test(bajo)) {
      const valor = mensaje.match(/\ba\s+([A-Za-zÁÉÍÓÚÑ\s]+)$/i)?.[1]?.trim() || (bajo.includes("disponible") ? "DISPONIBLE" : null);
      if (!valor) return burbuja("Indica el estado nuevo, por ejemplo: «cambia el estado de 01882 a DISPONIBLE».", "asistente");
      await sb.from("equipos").update({ estado: valor.toUpperCase() }).eq("id", equipo.id);
      await registrarHistorial(equipo, "EDICIÓN", `Asistente TI: estado → ${valor}`, {});
      return burbuja(`Listo, ${nombre}. Actualicé ${equipo.placa} a ${valor.toUpperCase()}.`, "asistente");
    }

    const escribiendo = burbuja("", "asistente", "typing");
    escribiendo.innerHTML = "<span></span><span></span><span></span>";
    setTimeout(() => {
      escribiendo.className = "burbuja asistente";
      escribiendo.textContent = `${equipo.placa} · ${equipo.nombre_red || "sin nombre"} · ${equipo.responsable || "sin responsable"} · ${equipo.sede || "sin sede"} · CECO ${equipo.ceco || "—"} · Estado ${equipo.estado || "—"}`;
    }, 500);
  }

  /* ---------------- Eventos ---------------- */

  function alternarAsistente(abrir) {
    const panel = byId("panelAsistente");
    panel.hidden = !abrir;
    if (abrir) byId("chatInput").focus();
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
    byId("btnSalir").addEventListener("click", cerrarSesion);

    document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => irAVista(b.dataset.vista)));
    document.querySelectorAll("[data-cerrar]").forEach((b) => b.addEventListener("click", () => { byId(b.dataset.cerrar).hidden = true; }));

    byId("formSistema").addEventListener("submit", guardarSistema);
    byId("formEquipo").addEventListener("submit", guardarEquipo);
    byId("formActa").addEventListener("submit", guardarActa);

    document.addEventListener("click", (evento) => {
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
      if (accion === "exportar") return exportarExcel();
      if (accion === "importar" || accion === "migrar") return byId("archivoImportar").click();
    });

    byId("archivoImportar").addEventListener("change", async (evento) => {
      const archivo = evento.target.files?.[0];
      if (archivo) await migrarArchivo(archivo);
      evento.target.value = "";
    });

    byId("btnAsistente").addEventListener("click", () => alternarAsistente(byId("panelAsistente").hidden));
    byId("cerrarAsistente").addEventListener("click", () => alternarAsistente(false));
    byId("formChat").addEventListener("submit", async (evento) => {
      evento.preventDefault();
      const texto = byId("chatInput").value;
      byId("chatInput").value = "";
      if (!texto.trim()) return;
      burbuja(texto, "usuario");
      try { await responderChat(texto); } catch (err) { burbuja("Error: " + err.message, "asistente", "error"); }
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

    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  async function iniciar() {
    instalarEventos();
    try { await cargarSesion(); }
    catch (err) {
      const error = byId("loginError");
      error.textContent = err.message;
      error.hidden = false;
    }
    sb.auth.onAuthStateChange((_evento) => cargarSesion());
  }

  iniciar();
})();
