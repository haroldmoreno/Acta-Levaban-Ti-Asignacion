/* ============================================================
   server.js | Acta de Tecnología - Levapan (Supabase Edition)
   ------------------------------------------------------------
   Servidor HTTP nativo (sin Express):
     · PostgreSQL  → inventario, actas e historial (Supabase)
     · Auth        → JWT de Supabase validado con SERVICE_ROLE_KEY
     · Storage     → PDFs privados en el bucket "actas-pdf"
     · pdf-lib     → plantilla oficial CORP-TEC-FR-002
   Sin Microsoft Entra ID, Microsoft Graph ni SharePoint.
   ============================================================ */

import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import multer from "multer";
import XLSX from "xlsx";

import {
  supabaseAdmin,
  configSupabase,
  contarEquipos,
  autenticarToken,
  mensajeConfiguracionIncompleta,
  BUCKET_ACTAS,
} from "./server/supabase.js";
import { generarActaPdf } from "./server/acta-pdf.js";
import {
  LOTE_EQUIPOS,
  mapearFila,
  mapearFilaSharepoint,
  renombrarEncabezados,
  CAMPOS_SHAREPOINT,
} from "./server/normalizar.js";
import { extraerTextoPdf } from "./server/extraer-texto-pdf.js";
import {
  BUCKET_BOVEDA,
  calcularSha256,
  configAlmacenamiento,
  descargarObjeto,
  estadoAlmacenamiento,
  firmarObjeto,
  rutaDocumento,
  subirObjeto,
} from "./services/storageVault.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = __dirname;

const PORT = process.env.PORT || 3000;
const PUERTO = Number(PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const LIMITE_CUERPO = 40 * 1024 * 1024;
const CONFIG = configSupabase();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/* ------------------------------------------------------------
   Utilidades HTTP
   ------------------------------------------------------------ */

function enviarJson(res, estado, datos) {
  const cuerpo = JSON.stringify(datos);
  res.writeHead(estado, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(cuerpo),
    "Cache-Control": "no-store",
  });
  res.end(cuerpo);
}

function enviarBinario(res, bytes, nombre, tipo) {
  res.writeHead(200, {
    "Content-Type": tipo,
    "Content-Length": bytes.length,
    "Content-Disposition": `attachment; filename="${nombre}"`,
    "Cache-Control": "no-store",
  });
  res.end(bytes);
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let excedido = false;

    req.on("data", (trozo) => {
      if (excedido) return;
      total += trozo.length;
      if (total > LIMITE_CUERPO) {
        excedido = true;
        reject(
          Object.assign(new Error("El archivo enviado es demasiado grande."), {
            status: 413,
          })
        );
        req.destroy();
        return;
      }
      partes.push(trozo);
    });
    req.on("end", () => {
      if (!excedido) resolve(Buffer.concat(partes));
    });
    req.on("error", reject);
  });
}

async function leerJson(req) {
  const cuerpo = await leerCuerpo(req);
  if (!cuerpo.length) return {};
  try {
    return JSON.parse(cuerpo.toString("utf8"));
  } catch {
    throw Object.assign(new Error("El cuerpo de la solicitud no es JSON válido."), {
      status: 400,
    });
  }
}

function fallo(mensaje, status = 400) {
  return Object.assign(new Error(mensaje), { status });
}

function responderError(res, err, contexto = "") {
  const estado = Number(err?.status) || 500;
  console.error(`[ERROR]${contexto ? ` ${contexto}:` : ""}`, err?.message || err);
  if (!res.headersSent) {
    enviarJson(res, estado, {
      ok: false,
      error: err?.message || "Error interno del servidor.",
      ...(err?.detalle ? { detalle: err.detalle } : {}),
    });
  } else {
    res.end();
  }
}

/* ------------------------------------------------------------
   Autenticación: middleware requiereSesion
   ------------------------------------------------------------ */

async function requiereSesion(req) {
  const cabecera = String(req.headers.authorization || "").trim();
  const coincidencia = /^Bearer\s+(.+)$/i.exec(cabecera);
  if (!coincidencia) {
    throw fallo("Debes iniciar sesión para usar esta API.", 401);
  }
  return autenticarToken(coincidencia[1]);
}

/* ------------------------------------------------------------
   Normalizaciones de dominio
   ------------------------------------------------------------ */

function sinAcentos(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function normalizarTipoActa(valor) {
  const texto = sinAcentos(valor).toLowerCase();
  if (texto.startsWith("devol")) return "Devolucion";
  if (texto.startsWith("prest")) return "Prestamo";
  return "Asignacion";
}

function normalizarEstadoEquipo(valor) {
  // SharePoint manda estados exactos: se conserva el texto original.
  const texto = String(valor ?? "").trim();
  return texto || null;
}

function limpiarBusqueda(valor) {
  return String(valor ?? "")
    .trim()
    .replace(/[%,()\\"']/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 100);
}

function sanitizarPlaca(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "SIN-PLACA";
}

async function registrarMovimiento(movimiento) {
  const usuario = movimiento.usuario || {};
  const registro = {
    ...movimiento,
    tipo_movimiento:
      movimiento.tipo_movimiento || movimiento.accion || "Edición",
    descripcion:
      movimiento.descripcion || movimiento.detalle || "Movimiento registrado",
    usuario_nombre:
      movimiento.usuario_nombre || usuario.nombre_completo || movimiento.realizado_por || "sistema",
    usuario_email: movimiento.usuario_email || usuario.email || null,
    created_at: movimiento.created_at || new Date().toISOString(),
  };
  delete registro.usuario;

  let { error } = await supabaseAdmin
    .from("historial_movimientos")
    .insert([registro]);

  if (error && /does not exist/i.test(error.message)) {
    const legado = {
      equipo_id: registro.equipo_id,
      placa: registro.placa,
      acta_id: registro.acta_id,
      accion: registro.accion || registro.tipo_movimiento,
      detalle: registro.detalle || registro.descripcion,
      realizado_por: registro.realizado_por || registro.usuario_nombre,
      created_at: registro.created_at,
    };
    Object.keys(legado).forEach((clave) => {
      if (legado[clave] === undefined) delete legado[clave];
    });
    ({ error } = await supabaseAdmin.from("historial_movimientos").insert([legado]));
  }

  if (error) console.warn("[HISTORIAL] No se pudo registrar:", error.message);
}

async function idEquipoPorPlaca(placa) {
  const { data } = await supabaseAdmin
    .from("equipos")
    .select("id, placa, estado, usuario_asignado, usuario_cedula, sede")
    .eq("placa", placa)
    .maybeSingle();
  return data || null;
}

/* ------------------------------------------------------------
   Archivos estáticos (interfaz PWA)
   ------------------------------------------------------------ */

const ARCHIVOS_PUBLICOS = new Set([
  "/index.html",
  "/manifest.json",
  "/sw.js",
  "/favicon.ico",
]);
const CARPETAS_PUBLICAS = ["/css/", "/js/", "/images/", "/icons/", "/media/"];

async function servirEstatico(req, res, url) {
  let relativa;
  try {
    relativa = path.posix.normalize(
      decodeURIComponent(url.pathname).replace(/\\/g, "/")
    );
  } catch {
    return enviarJson(res, 400, { ok: false, error: "Ruta inválida." });
  }
  if (relativa === "/" || relativa === "." || relativa === "") {
    relativa = "/index.html";
  }

  const permitido =
    ARCHIVOS_PUBLICOS.has(relativa) ||
    CARPETAS_PUBLICAS.some((prefijo) => relativa.startsWith(prefijo));
  if (!permitido) {
    return enviarJson(res, 404, { ok: false, error: "Archivo no encontrado." });
  }

  const destino = path.resolve(RAIZ, `.${relativa}`);
  if (destino !== RAIZ && !destino.startsWith(RAIZ + path.sep)) {
    return enviarJson(res, 403, { ok: false, error: "Acceso denegado." });
  }

  let stats;
  try {
    stats = await fsp.stat(destino);
  } catch {
    return enviarJson(res, 404, { ok: false, error: "Archivo no encontrado." });
  }
  if (stats.isDirectory()) {
    return enviarJson(res, 404, { ok: false, error: "Archivo no encontrado." });
  }

  const extension = path.extname(destino).toLowerCase();
  const esCodigo = [".html", ".js", ".css", ".json"].includes(extension);
  const cabeceras = {
    "Content-Type": MIME[extension] || "application/octet-stream",
    "Content-Length": stats.size,
    "Cache-Control": esCodigo ? "no-cache" : "public, max-age=3600",
    "Accept-Ranges": "bytes",
  };

  const rango = req.headers.range;
  if (rango && extension === ".mp4") {
    const coincidencia = /bytes=(\d*)-(\d*)/.exec(rango);
    if (coincidencia) {
      const inicio = coincidencia[1] ? Number(coincidencia[1]) : 0;
      const fin = coincidencia[2] ? Number(coincidencia[2]) : stats.size - 1;
      if (inicio >= stats.size || fin >= stats.size || inicio > fin) {
        res.writeHead(416, { "Content-Range": `bytes */${stats.size}` });
        return res.end();
      }
      res.writeHead(206, {
        ...cabeceras,
        "Content-Length": fin - inicio + 1,
        "Content-Range": `bytes ${inicio}-${fin}/${stats.size}`,
      });
      return fs.createReadStream(destino, { start: inicio, end: fin }).pipe(res);
    }
  }

  res.writeHead(200, cabeceras);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(destino).pipe(res);
}

/* ------------------------------------------------------------
   Health / Estado (conexión real a PostgreSQL)
   ------------------------------------------------------------ */

async function manejarHealth(res) {
  try {
    const totalEquipos = await contarEquipos();
    return enviarJson(res, 200, {
      ok: true,
      servicio: "acta-levapan",
      modo: "cloud-supabase",
      totalEquipos,
      fecha: new Date().toISOString(),
    });
  } catch (err) {
    return enviarJson(res, 503, {
      ok: false,
      modo: "cloud-supabase",
      error: err.message,
      fecha: new Date().toISOString(),
    });
  }
}

async function manejarEstado(res) {
  try {
    const totalEquipos = await contarEquipos();
    return enviarJson(res, 200, {
      ok: true,
      modo: "cloud-supabase",
      totalEquipos,
      supabase: {
        configurado: CONFIG.configurado,
        url: CONFIG.url || null,
        bucket: BUCKET_ACTAS,
      },
      almacenamiento: estadoAlmacenamiento(),
      servidor: "Acta de Tecnología Levapan · Supabase",
      fechaServidor: new Date().toISOString(),
    });
  } catch (err) {
    return enviarJson(res, 503, {
      ok: false,
      modo: "cloud-supabase",
      totalEquipos: 0,
      error: err.message,
      ...(CONFIG.configurado ? {} : { detalle: mensajeConfiguracionIncompleta(CONFIG) }),
    });
  }
}

/* ------------------------------------------------------------
   EQUIPOS
   ------------------------------------------------------------ */

async function buscarEquiposSugeridos(res, url) {
  const consulta = limpiarBusqueda(url.searchParams.get("q"));
  if (consulta.length < 2) {
    return enviarJson(res, 200, {
      ok: true,
      q: consulta,
      modo: "supabase-ilike",
      total: 0,
      equipos: [],
    });
  }

  const filtro = `placa.ilike.%${consulta}%,serial.ilike.%${consulta}%,usuario_asignado.ilike.%${consulta}%`;
  const { data, error } = await supabaseAdmin
    .from("equipos")
    .select("id, placa, tipo, marca, modelo, serial, estado, sede, usuario_asignado, usuario_cedula")
    .or(filtro)
    .order("updated_at", { ascending: false })
    .limit(15);

  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  return enviarJson(res, 200, {
    ok: true,
    q: consulta,
    modo: "supabase-ilike",
    total: data.length,
    equipos: data,
  });
}

async function contarCon(base, estado) {
  let consulta = supabaseAdmin.from("equipos").select("id", { count: "exact", head: true });
  if (base.q) {
    consulta = consulta.or(
      `placa.ilike.%${base.q}%,serial.ilike.%${base.q}%,usuario_asignado.ilike.%${base.q}%`
    );
  }
  if (base.sede) consulta = consulta.eq("sede", base.sede);
  if (base.tipo) consulta = consulta.eq("tipo", base.tipo);
  if (base.ceco) consulta = consulta.eq("ceco", base.ceco);
  if (base.empresa) consulta = consulta.eq("empresa", base.empresa);
  if (base.sistema) consulta = consulta.eq("sistema_id", base.sistema);
  if (estado) consulta = consulta.eq("estado", estado);

  const { count, error } = await consulta;
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  return Number(count) || 0;
}

async function listarEquipos(res, url) {
  const base = {
    q: limpiarBusqueda(url.searchParams.get("q")),
    sede: String(url.searchParams.get("sede") || "").trim(),
    tipo: String(url.searchParams.get("tipo") || "").trim(),
    ceco: String(url.searchParams.get("ceco") || "").trim(),
    empresa: String(url.searchParams.get("empresa") || "").trim(),
    sistema: String(url.searchParams.get("sistema") || "").trim(),
  };
  const estado = String(url.searchParams.get("estado") || "").trim();
  const pagina = Math.max(1, Number(url.searchParams.get("pagina")) || 1);
  const limite = Math.min(200, Math.max(1, Number(url.searchParams.get("limite")) || 25));

  const total = await contarCon(base, "");

  const construirConsultaEstados = () => {
    let consulta = supabaseAdmin.from("equipos").select("estado");
    if (base.q) {
      consulta = consulta.or(
        `placa.ilike.%${base.q}%,serial.ilike.%${base.q}%,usuario_asignado.ilike.%${base.q}%`
      );
    }
    if (base.sede) consulta = consulta.eq("sede", base.sede);
    if (base.tipo) consulta = consulta.eq("tipo", base.tipo);
    if (base.ceco) consulta = consulta.eq("ceco", base.ceco);
    if (base.empresa) consulta = consulta.eq("empresa", base.empresa);
    if (base.sistema) consulta = consulta.eq("sistema_id", base.sistema);
    if (estado) consulta = consulta.eq("estado", estado);
    return consulta;
  };

  const filasEstado = [];
  let desdeEstados = 0;
  while (desdeEstados <= 50000) {
    const { data: lote, error: errorEstados } = await construirConsultaEstados()
      .order("placa", { ascending: true })
      .range(desdeEstados, desdeEstados + 999);
    if (errorEstados) throw Object.assign(new Error(errorEstados.message), { status: 502 });
    filasEstado.push(...(lote || []));
    if ((lote || []).length < 1000) break;
    desdeEstados += 1000;
  }

  const porEstado = {};
  for (const fila of filasEstado || []) {
    const clave = String(fila.estado || "Sin estado");
    porEstado[clave] = (porEstado[clave] || 0) + 1;
  }

  let consulta = supabaseAdmin
    .from("equipos")
    .select("*, sistemas(id, codigo, nombre, criticidad)", { count: "exact" });
  if (base.q) {
    consulta = consulta.or(
      `placa.ilike.%${base.q}%,serial.ilike.%${base.q}%,usuario_asignado.ilike.%${base.q}%`
    );
  }
  if (base.sede) consulta = consulta.eq("sede", base.sede);
  if (base.tipo) consulta = consulta.eq("tipo", base.tipo);
  if (base.ceco) consulta = consulta.eq("ceco", base.ceco);
  if (base.empresa) consulta = consulta.eq("empresa", base.empresa);
  if (base.sistema) consulta = consulta.eq("sistema_id", base.sistema);
  if (estado) consulta = consulta.eq("estado", estado);

  const { data, error, count } = await consulta
    .order("updated_at", { ascending: false })
    .range((pagina - 1) * limite, pagina * limite - 1);

  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  return enviarJson(res, 200, {
    ok: true,
    equipos: data || [],
    pagina,
    limite,
    total: Number(count) || total,
    resumen: { total, disponibles: porEstado.Disponible || 0, asignados: porEstado.Asignado || 0, mantenimiento: porEstado["En Mantenimiento"] || 0, porEstado },
  });
}

async function crearEquipo(req, res, usuario) {
  const cuerpo = await leerJson(req);
  const placa = String(cuerpo.placa || "").trim();
  if (!placa) throw fallo("La placa es obligatoria.");

  const existente = await idEquipoPorPlaca(placa);
  if (existente) throw fallo("Ya existe un equipo con esa placa.", 409);

  const registro = {
    placa,
    tipo: cuerpo.tipo || null,
    marca: cuerpo.marca || null,
    modelo: cuerpo.modelo || null,
    serial: cuerpo.serial || null,
    estado: normalizarEstadoEquipo(cuerpo.estado),
    sede: cuerpo.sede || null,
    usuario_asignado: cuerpo.usuario_asignado || null,
    usuario_cedula: cuerpo.usuario_cedula || null,
    garantia_hasta: cuerpo.garantia_hasta || null,
    observaciones: cuerpo.observaciones || null,
    sistema_id: cuerpo.sistema_id || null,
    ...mapearFilaSharepoint(cuerpo),
  };

  let insercion = await supabaseAdmin.from("equipos").insert([registro]).select().single();

  if (insercion.error && /does not exist/i.test(insercion.error.message)) {
    const legado = {
      placa,
      tipo: registro.tipo,
      marca: registro.marca,
      modelo: registro.modelo,
      serial: registro.serial,
      estado: registro.estado,
      sede: registro.sede,
      usuario_asignado: registro.usuario_asignado,
      usuario_cedula: registro.usuario_cedula,
      garantia_hasta: registro.garantia_hasta,
      observaciones: registro.observaciones,
      sistema_id: registro.sistema_id,
    };
    insercion = await supabaseAdmin.from("equipos").insert([legado]).select().single();
  }

  if (insercion.error) throw Object.assign(new Error(insercion.error.message), { status: 502 });
  const data = insercion.data;

  await registrarMovimiento({
    equipo_id: data.id,
    placa,
    accion: "Creacion",
    tipo_movimiento: "Creación",
    detalle: `Equipo creado con estado ${data.estado}${data.sede ? ` · sede ${data.sede}` : ""}`,
    realizado_por: usuario.nombre_completo,
    usuario,
  });

  return enviarJson(res, 201, { ok: true, equipo: data });
}

const CAMPOS_EDITABLES = [
  "tipo",
  "marca",
  "modelo",
  "serial",
  "estado",
  "sede",
  "usuario_asignado",
  "usuario_cedula",
  "garantia_hasta",
  "observaciones",
  "sistema_id",
  ...CAMPOS_SHAREPOINT.filter(
    (campo) => campo !== "placa" && campo !== "serial" && campo !== "sede" && campo !== "estado"
  ),
];

async function editarEquipo(req, res, usuario, id) {
  const cuerpo = await leerJson(req);
  const { data: anterior, error: errorAnterior } = await supabaseAdmin
    .from("equipos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (errorAnterior) throw Object.assign(new Error(errorAnterior.message), { status: 502 });
  if (!anterior) throw fallo("No se encontró el equipo.", 404);

  const cambios = {};
  for (const campo of CAMPOS_EDITABLES) {
    if (!Object.hasOwn(cuerpo, campo)) continue;
    let valor = cuerpo[campo];
    if (campo === "estado") valor = normalizarEstadoEquipo(valor);
    if (typeof valor === "string") valor = valor.trim() || null;
    cambios[campo] = valor;
  }
  if (!Object.keys(cambios).length) throw fallo("No se enviaron cambios.");

  let respuesta = await supabaseAdmin
    .from("equipos")
    .update(cambios)
    .eq("id", id)
    .select()
    .single();

  if (respuesta.error && /does not exist/i.test(respuesta.error.message)) {
    const camposLegado = new Set([
      "tipo", "marca", "modelo", "serial", "estado", "sede",
      "usuario_asignado", "usuario_cedula", "garantia_hasta", "observaciones", "sistema_id",
    ]);
    const cambiosLegado = Object.fromEntries(
      Object.entries(cambios).filter(([clave]) => camposLegado.has(clave))
    );
    respuesta = await supabaseAdmin
      .from("equipos")
      .update(cambiosLegado)
      .eq("id", id)
      .select()
      .single();
  }

  if (respuesta.error) throw Object.assign(new Error(respuesta.error.message), { status: 502 });
  const data = respuesta.data;

  const detalle = Object.keys(cambios)
    .map((campo) => `${campo}: ${anterior[campo] ?? "—"} → ${data[campo] ?? "—"}`)
    .join(" · ")
    .slice(0, 900);

  await registrarMovimiento({
    equipo_id: id,
    placa: data.placa,
    accion: "Edicion",
    tipo_movimiento: "Edición",
    detalle,
    realizado_por: usuario.nombre_completo,
    usuario,
  });

  return enviarJson(res, 200, { ok: true, equipo: data });
}

async function registrarNovedadEquipo(req, res, usuario, id) {
  const cuerpo = await leerJson(req);
  const observacion = String(cuerpo.observacion || "").trim();
  if (!observacion) throw fallo("La observación es obligatoria.");

  const { data: equipo, error } = await supabaseAdmin
    .from("equipos")
    .select("id, placa")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!equipo) throw fallo("No se encontró el equipo.", 404);

  const permite =
    usuario.rol === "admin" || usuario.permisos?.puede_crear_editar_equipos !== false;
  if (!permite) throw fallo("Tu perfil no tiene permiso para registrar novedades.", 403);

  const tipo = String(cuerpo.tipo || "Novedad");
  const tipoMovimiento = /mantenim/i.test(tipo)
    ? "Mantenimiento"
    : /reparac/i.test(tipo)
      ? "Mantenimiento"
      : /accesorio/i.test(tipo)
        ? "Edición"
        : "Novedad";
  const fecha = cuerpo.fecha ? new Date(cuerpo.fecha).toISOString() : new Date().toISOString();

  await registrarMovimiento({
    equipo_id: equipo.id,
    placa: equipo.placa,
    accion: "Edicion",
    tipo_movimiento: tipoMovimiento,
    descripcion: `${tipo}: ${observacion}`,
    detalle: `${tipo}: ${observacion}`,
    realizado_por: usuario.nombre_completo,
    usuario,
    created_at: fecha,
  });

  return enviarJson(res, 201, {
    ok: true,
    mensaje: "Novedad registrada en la hoja de vida.",
    equipo_id: equipo.id,
    placa: equipo.placa,
  });
}

async function construirHojaVida(res, equipo) {
  if (!equipo) throw fallo("No se encontró el equipo.", 404);

  const [movimientos, porEquipo, porPlaca, vinculos] = await Promise.all([
    supabaseAdmin
      .from("historial_movimientos")
      .select("*")
      .eq("equipo_id", equipo.id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("actas")
      .select("*")
      .eq("equipo_id", equipo.id)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("actas")
      .select("*")
      .eq("placa", equipo.placa)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("documento_vinculos")
      .select("documento_id, boveda_documentos(id, titulo, categoria, fecha_documento, created_at)")
      .or(`equipo_id.eq.${equipo.id},placa.eq.${equipo.placa}`),
  ]);

  const error =
    movimientos.error || porEquipo.error || porPlaca.error || vinculos.error;
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const actasMap = new Map();
  [...(porEquipo.data || []), ...(porPlaca.data || [])].forEach((acta) =>
    actasMap.set(acta.id, acta)
  );
  const actas = [...actasMap.values()].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  const documentosMap = new Map();
  for (const vinculo of vinculos.data || []) {
    const documento = vinculo.boveda_documentos;
    if (documento) documentosMap.set(documento.id, documento);
  }
  const documentos = [...documentosMap.values()].sort(
    (a, b) => new Date(b.created_at) - new Date(a.created_at)
  );

  const lineaTiempo = [
    ...(movimientos.data || []).map((movimiento) => ({
      tipo: "movimiento",
      fecha: movimiento.created_at,
      data: movimiento,
    })),
    ...actas.map((acta) => ({ tipo: "acta", fecha: acta.created_at, data: acta })),
    ...documentos.map((documento) => ({
      tipo: "documento",
      fecha: documento.created_at,
      data: documento,
    })),
  ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  return enviarJson(res, 200, {
    ok: true,
    equipo,
    historial: movimientos.data || [],
    actas,
    documentos,
    lineaTiempo,
  });
}

async function historialEquipo(res, id) {
  const { data: equipo, error } = await supabaseAdmin
    .from("equipos")
    .select("id, placa, nombre_equipo_red, serial, marca, modelo, responsable, usuario_asignado, cedula_responsable, usuario_cedula, sede, ceco, area, estado, sistema_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  return construirHojaVida(res, equipo);
}

async function historialPorPlaca(res, placa) {
  const { data: equipo, error } = await supabaseAdmin
    .from("equipos")
    .select("id, placa, nombre_equipo_red, serial, marca, modelo, responsable, usuario_asignado, cedula_responsable, usuario_cedula, sede, ceco, area, estado, sistema_id")
    .ilike("placa", String(placa || "").trim())
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  return construirHojaVida(res, equipo);
}

/* ------------------------------------------------------------
   Importación masiva (multer en memoria)
   ------------------------------------------------------------ */

const subidaMemoria = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
});

function recibirArchivo(req) {
  return new Promise((resolve, reject) => {
    subidaMemoria.single("archivo")(req, {}, (err) => {
      if (err) {
        reject(fallo(err.message || "No se pudo leer el archivo.", 400));
        return;
      }
      if (!req.file) {
        reject(fallo("Selecciona un archivo .xlsx o .csv."));
        return;
      }
      resolve(req.file);
    });
  });
}

/** Igual que recibirArchivo pero devuelve también los campos del formulario. */
function recibirFormulario(req, campo = "archivo") {
  return new Promise((resolve, reject) => {
    subidaMemoria.single(campo)(req, {}, (err) => {
      if (err) {
        reject(fallo(err.message || "No se pudo leer el archivo.", 400));
        return;
      }
      resolve({ archivo: req.file || null, campos: req.body || {} });
    });
  });
}

async function importarEquipos(req, res, usuario) {
  const archivo = await recibirArchivo(req);
  const extension = path.extname(archivo.originalname || "").toLowerCase();
  if (![".xlsx", ".xls", ".csv", ".ods"].includes(extension)) {
    throw fallo("Formato no soportado. Usa .xlsx, .xls, .csv u .ods.");
  }

  const libro = XLSX.read(archivo.buffer, { type: "buffer", cellDates: true });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: "", raw: false });
  const registros = filas
    .map((fila) => {
      const legado = mapearFila(fila) || {};
      const sharepoint = mapearFilaSharepoint(fila);
      const registro = { ...legado, ...sharepoint };
      return registro.placa || registro.serial ? registro : null;
    })
    .filter(Boolean);

  const totalLeidos = filas.length;
  let errores = totalLeidos - registros.length;
  let procesados = 0;

  const grupos = [
    { clave: "placa", filas: registros.filter((registro) => registro.placa) },
    { clave: "serial", filas: registros.filter((registro) => !registro.placa && registro.serial) },
  ];

  for (const grupo of grupos) {
    for (let inicio = 0; inicio < grupo.filas.length; inicio += LOTE_EQUIPOS) {
      const lote = grupo.filas.slice(inicio, inicio + LOTE_EQUIPOS);
      const { data, error } = await supabaseAdmin
        .from("equipos")
        .upsert(lote, { onConflict: grupo.clave })
        .select("id, placa");
    if (error) {
      errores += lote.length;
      console.error("[IMPORTAR] Error en lote:", error.message);
      continue;
    }
    procesados += data?.length || 0;

    const eventos = (data || []).map((equipo) => ({
      equipo_id: equipo.id,
      placa: equipo.placa,
      accion: "Importacion Lote",
      tipo_movimiento: "Sincronización",
      detalle: `Importación masiva desde ${archivo.originalname}`,
      realizado_por: usuario.nombre_completo,
      usuario,
    }));
    for (const evento of eventos) {
      await registrarMovimiento(evento);
    }
    }
  }

  return enviarJson(res, 200, {
    ok: true,
    totalLeidos,
    procesados,
    errores,
  });
}

/* ------------------------------------------------------------
   ACTAS: PDF CORP-TEC-FR-002 + Storage + auditoría
   ------------------------------------------------------------ */

/** Archiva el PDF del acta en la Bóveda y lo vincula a placa y sistema. */
async function registrarActaEnBoveda({ acta, bytes, rutaStorage, equipo, usuario }) {
  try {
    const hash = calcularSha256(bytes);
    const { data: existente } = await supabaseAdmin
      .from("boveda_documentos")
      .select("id")
      .eq("sha256_hash", hash)
      .maybeSingle();

    let documento = existente;
    if (!documento) {
      const resumen = [
        `Acta ${acta.tipo_acta} CORP-TEC-FR-002 N.º ${acta.consecutivo}`,
        `Placa ${acta.placa}`,
        `Colaborador ${acta.colaborador_nombre}`,
        `Cédula ${acta.colaborador_cedula}`,
        `Sede ${acta.sede}`,
        acta.agente_ti_nombre ? `Agente TI ${acta.agente_ti_nombre}` : "",
        Array.isArray(acta.accesorios) && acta.accesorios.length
          ? `Accesorios ${acta.accesorios.join(", ")}`
          : "",
        Array.isArray(acta.software) && acta.software.length
          ? `Software ${acta.software.join(", ")}`
          : "",
        acta.observaciones || "",
      ]
        .filter(Boolean)
        .join(". ");

      const { data, error } = await supabaseAdmin
        .from("boveda_documentos")
        .insert([
          {
            titulo: `ACTA-${acta.consecutivo} · ${acta.placa} · ${acta.colaborador_nombre}`,
            categoria: "Acta",
            proveedor: "Levapan TI",
            numero_referencia: `ACTA-${acta.consecutivo}`,
            fecha_documento: new Date().toISOString().slice(0, 10),
            storage_provider: "supabase",
            storage_bucket: BUCKET_ACTAS,
            storage_path: rutaStorage,
            mime_type: "application/pdf",
            tamano_bytes: bytes.length,
            sha256_hash: hash,
            contenido_texto: resumen,
            subido_por: usuario?.nombre_completo || "sistema",
          },
        ])
        .select()
        .single();

      if (error) {
        console.warn("[BOVEDA] No se pudo archivar el acta:", error.message);
        return null;
      }
      documento = data;
    }

    await crearVinculos(
      documento,
      [acta.placa],
      equipo?.sistema_id ? [equipo.sistema_id] : []
    );
    return documento;
  } catch (err) {
    console.warn("[BOVEDA] Archivo del acta:", err.message);
    return null;
  }
}

async function guardarActa(req, res, usuario) {
  const cuerpo = await leerJson(req);
  const datos = cuerpo.datos || {};
  const placa = String(datos.placa || "").trim();
  const colaborador = String(datos.nombre || "").trim();
  const documento = String(datos.documento || "").trim();
  const sede = String(datos.sede || "").trim();

  if (!placa) throw fallo("La placa del equipo es obligatoria.");
  if (!colaborador) throw fallo("El nombre del colaborador es obligatorio.");
  if (!documento) throw fallo("La cédula del colaborador es obligatoria.");
  if (!sede) throw fallo("La Sede Levapan es obligatoria.");

  let bytes;
  if (cuerpo.pdfBase64) {
    bytes = Buffer.from(String(cuerpo.pdfBase64).split(",").pop() || "", "base64");
  } else {
    const pdf = await generarActaPdf({
      datos,
      fotos: cuerpo.fotos || datos.fotos || {},
      firmas: cuerpo.firmas || datos.firmas || {},
      plantilla: path.join(RAIZ, "template.pdf"),
    });
    bytes = Buffer.from(pdf);
  }
  if (!bytes || bytes.length < 200) throw fallo("El PDF generado está vacío o dañado.");

  const tipoActa = normalizarTipoActa(datos.tipoActa);
  const equipo = await idEquipoPorPlaca(placa);

  const { data: acta, error: errorActa } = await supabaseAdmin
    .from("actas")
    .insert([
      {
        tipo_acta: tipoActa,
        equipo_id: equipo?.id || null,
        placa,
        colaborador_nombre: colaborador,
        colaborador_cedula: documento,
        sede,
        agente_ti_id: usuario.id,
        agente_ti_nombre: String(datos.agenteTi || usuario.nombre_completo || ""),
        agente_ti_cedula: String(datos.documentoTi || usuario.cedula || ""),
        accesorios: Array.isArray(datos.accesorios) ? datos.accesorios : [],
        software: Array.isArray(datos.software) ? datos.software : [],
        observaciones: datos.observaciones || null,
      },
    ])
    .select()
    .single();

  if (errorActa) throw Object.assign(new Error(errorActa.message), { status: 502 });

  const ahora = new Date();
  const anio = String(ahora.getFullYear());
  const mes = String(ahora.getMonth() + 1).padStart(2, "0");
  const nombre = `ACTA-${acta.consecutivo}-${sanitizarPlaca(placa)}.pdf`;
  const rutaStorage = `${anio}/${mes}/${nombre}`;

  const { error: errorSubida } = await supabaseAdmin.storage
    .from(BUCKET_ACTAS)
    .upload(rutaStorage, bytes, {
      contentType: "application/pdf",
      cacheControl: "3600",
      upsert: false,
    });
  if (errorSubida) {
    throw Object.assign(
      new Error(`No se pudo subir el PDF a Supabase Storage: ${errorSubida.message}`),
      { status: 502 }
    );
  }

  await supabaseAdmin
    .from("actas")
    .update({ pdf_storage_path: rutaStorage })
    .eq("id", acta.id);

  const documentoBoveda = await registrarActaEnBoveda({
    acta,
    bytes,
    rutaStorage,
    equipo,
    usuario,
  });

  // Actualización automática del inventario según el tipo de acta.
  let estadoEquipo = "Asignado";
  const cambiosEquipo = {};
  if (tipoActa === "Devolucion") {
    estadoEquipo = "Disponible";
    cambiosEquipo.estado = "Disponible";
    cambiosEquipo.usuario_asignado = null;
    cambiosEquipo.usuario_cedula = null;
  } else if (tipoActa === "Prestamo") {
    estadoEquipo = "Prestamo";
    cambiosEquipo.estado = "Prestamo";
    cambiosEquipo.usuario_asignado = colaborador;
    cambiosEquipo.usuario_cedula = documento;
    cambiosEquipo.sede = sede;
  } else {
    cambiosEquipo.estado = "Asignado";
    cambiosEquipo.usuario_asignado = colaborador;
    cambiosEquipo.usuario_cedula = documento;
    cambiosEquipo.sede = sede;
  }
  if (equipo?.id) {
    const { error: errorEquipo } = await supabaseAdmin
      .from("equipos")
      .update(cambiosEquipo)
      .eq("id", equipo.id);
    if (errorEquipo) console.warn("[ACTA] No se pudo actualizar el equipo:", errorEquipo.message);
  }

  await registrarMovimiento({
    equipo_id: equipo?.id || null,
    acta_id: acta.id,
    placa,
    accion: tipoActa,
    tipo_movimiento: "Acta Emitida",
    detalle: `Acta CORP-TEC-FR-002 N.º ${acta.consecutivo} · ${colaborador} · ${sede} · ${nombre}`,
    realizado_por: usuario.nombre_completo,
    usuario,
  });

  const { data: firmada, error: errorFirma } = await supabaseAdmin.storage
    .from(BUCKET_ACTAS)
    .createSignedUrl(rutaStorage, 120);

  return enviarJson(res, 201, {
    ok: true,
    consecutivo: acta.consecutivo,
    acta: { ...acta, pdf_storage_path: rutaStorage },
    archivo: nombre,
    ruta: rutaStorage,
    url: firmada?.signedUrl || "",
    urlFirmada: firmada?.signedUrl || "",
    pdfBase64: bytes.toString("base64"),
    generadoEnServidor: !cuerpo.pdfBase64,
    estadoEquipo,
    equipo: equipo ? { ...equipo, ...cambiosEquipo } : null,
    documentoBovedaId: documentoBoveda?.id || null,
    modo: "cloud-supabase",
    ...(errorFirma ? { aviso: `No se pudo crear la URL firmada: ${errorFirma.message}` } : {}),
  });
}

async function listarActas(res, url) {
  const consulta = limpiarBusqueda(url.searchParams.get("q"));
  const limite = Math.min(200, Math.max(1, Number(url.searchParams.get("limite")) || 100));

  let query = supabaseAdmin.from("actas").select("*").order("created_at", { ascending: false });
  if (consulta) {
    const filtros = [
      `placa.ilike.%${consulta}%`,
      `colaborador_nombre.ilike.%${consulta}%`,
    ];
    if (/^\d+$/.test(consulta)) filtros.push(`consecutivo.eq.${Number(consulta)}`);
    query = query.or(filtros.join(","));
  }
  const { data, error } = await query.limit(limite);
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  return enviarJson(res, 200, { ok: true, total: data.length, actas: data });
}

async function urlPdfActa(res, id) {
  const { data: acta, error } = await supabaseAdmin
    .from("actas")
    .select("id, consecutivo, placa, pdf_storage_path")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!acta) throw fallo("No se encontró el acta.", 404);
  if (!acta.pdf_storage_path) throw fallo("Esta acta aún no tiene PDF archivado.", 404);

  const { data, error: errorFirma } = await supabaseAdmin.storage
    .from(BUCKET_ACTAS)
    .createSignedUrl(acta.pdf_storage_path, 120);
  if (errorFirma) {
    throw Object.assign(new Error(errorFirma.message), { status: 502 });
  }

  return enviarJson(res, 200, {
    ok: true,
    url: data.signedUrl,
    expiraEn: 120,
    acta,
  });
}

/* ------------------------------------------------------------
   Exportación gerencial a Excel (3 hojas)
   ------------------------------------------------------------ */

async function exportarExcel(res) {
  const [equipos, actas, historial] = await Promise.all([
    supabaseAdmin.from("equipos").select("*").order("created_at", { ascending: false }).limit(10000),
    supabaseAdmin.from("actas").select("*").order("created_at", { ascending: false }).limit(10000),
    supabaseAdmin
      .from("historial_movimientos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10000),
  ]);

  const error = equipos.error || actas.error || historial.error;
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.json_to_sheet(equipos.data || []),
    "Inventario_Actual"
  );
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.json_to_sheet(actas.data || []),
    "Actas_Emitidas"
  );
  XLSX.utils.book_append_sheet(
    libro,
    XLSX.utils.json_to_sheet(historial.data || []),
    "Historial_Movimientos"
  );

  const bytes = XLSX.write(libro, { type: "buffer", bookType: "xlsx" });
  const nombre = `Respaldo_Levapan_${new Date().toISOString().slice(0, 10)}.xlsx`;
  return enviarBinario(
    res,
    bytes,
    nombre,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

/* ------------------------------------------------------------
   USUARIOS CORPORATIVOS @levapan.com
   ------------------------------------------------------------ */

function correoCorporativoValido(valor) {
  return /^[A-Za-z0-9._%+-]+@levapan\.com$/i.test(String(valor || "").trim());
}

function exigirAdmin(usuario) {
  if (usuario?.rol !== "admin") {
    throw fallo("Esta acción solo está disponible para administradores TI.", 403);
  }
}

const PERMISOS_TI = [
  "puede_crear_editar_equipos",
  "puede_emitir_actas",
  "puede_sincronizar_importar",
  "puede_gestionar_boveda",
  "puede_eliminar_registros",
  "puede_administrar_usuarios",
];

function normalizarPermisos(valor) {
  const permisos = {
    puede_crear_editar_equipos: true,
    puede_emitir_actas: true,
    puede_sincronizar_importar: false,
    puede_gestionar_boveda: true,
    puede_eliminar_registros: false,
    puede_administrar_usuarios: false,
  };
  if (valor && typeof valor === "object" && !Array.isArray(valor)) {
    for (const clave of PERMISOS_TI) {
      if (Object.hasOwn(valor, clave)) permisos[clave] = Boolean(valor[clave]);
    }
  }
  return permisos;
}

/** Crea el usuario en Supabase Auth y su perfil TI operativo. */
async function crearUsuarioCorporativo(cuerpo, rol = "tecnico") {
  const nombreCompleto = String(cuerpo.nombre_completo || "").trim();
  const cedula = String(cuerpo.cedula || "").trim();
  const email = String(cuerpo.email || "").trim().toLowerCase();
  const password = String(cuerpo.password || "");
  const rolFinal = rol === "admin" ? "admin" : "tecnico";

  if (!nombreCompleto) throw fallo("El nombre completo es obligatorio.");
  if (!cedula) throw fallo("La cédula es obligatoria.");
  if (!correoCorporativoValido(email)) {
    throw fallo("El correo corporativo debe terminar estrictamente en @levapan.com.");
  }
  if (password.length < 6) throw fallo("La contraseña debe tener al menos 6 caracteres.");

  const { data: repetido, error: errorRepetido } = await supabaseAdmin
    .from("perfiles_ti")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (errorRepetido) throw Object.assign(new Error(errorRepetido.message), { status: 502 });
  if (repetido) throw fallo("Ya existe un perfil con ese correo corporativo.", 409);

  const { data: creado, error: errorAuth } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { nombre_completo: nombreCompleto, cedula },
  });
  if (errorAuth) {
    const duplicado = /already|exists|registered/i.test(errorAuth.message);
    throw Object.assign(
      new Error(
        duplicado
          ? "Ese correo ya está registrado en Supabase Auth."
          : `No se pudo crear el usuario: ${errorAuth.message}`
      ),
      { status: duplicado ? 409 : 502 }
    );
  }

  let insercion = await supabaseAdmin
    .from("perfiles_ti")
    .insert([
      {
        id: creado.user.id,
        nombre_completo: nombreCompleto,
        cedula,
        email,
        rol: rolFinal,
        activo: true,
        sede_asignada: String(cuerpo.sede_asignada || "").trim() || null,
        sistema_asignado: cuerpo.sistema_asignado || null,
        permisos: normalizarPermisos(cuerpo.permisos),
      },
    ])
    .select()
    .single();

  if (insercion.error && /does not exist/i.test(insercion.error.message)) {
    insercion = await supabaseAdmin
      .from("perfiles_ti")
      .insert([
        {
          id: creado.user.id,
          nombre_completo: nombreCompleto,
          cedula,
          email,
          rol: rolFinal,
          activo: true,
        },
      ])
      .select()
      .single();
  }

  if (insercion.error) {
    await supabaseAdmin.auth.admin.deleteUser(creado.user.id).catch(() => {});
    throw Object.assign(
      new Error(`No se pudo crear el perfil TI: ${insercion.error.message}`),
      { status: 502 }
    );
  }

  return insercion.data;
}

async function registroCorporativo(req, res) {
  const cuerpo = await leerJson(req);
  const perfil = await crearUsuarioCorporativo(cuerpo, "tecnico");
  return enviarJson(res, 201, {
    ok: true,
    mensaje: "Cuenta corporativa creada. Ya puedes iniciar sesión.",
    perfil: {
      id: perfil.id,
      email: perfil.email,
      nombre_completo: perfil.nombre_completo,
      rol: perfil.rol,
      activo: perfil.activo,
    },
  });
}

async function seleccionarPerfilesAdmin() {
  const camposCompletos =
    "id, nombre_completo, cedula, email, rol, activo, sede_asignada, sistema_asignado, permisos, created_at";
  const camposBasicos = "id, nombre_completo, cedula, email, rol, activo, created_at";

  let respuesta = await supabaseAdmin
    .from("perfiles_ti")
    .select(camposCompletos)
    .order("created_at", { ascending: false });
  if (respuesta.error && /does not exist/i.test(respuesta.error.message)) {
    respuesta = await supabaseAdmin
      .from("perfiles_ti")
      .select(camposBasicos)
      .order("created_at", { ascending: false });
  }
  if (respuesta.error) {
    throw Object.assign(new Error(respuesta.error.message), { status: 502 });
  }
  return (respuesta.data || []).map((perfil) => ({
    ...perfil,
    sede_asignada: perfil.sede_asignada ?? null,
    sistema_asignado: perfil.sistema_asignado ?? null,
    permisos: perfil.permisos ?? normalizarPermisos(null),
  }));
}

async function listarUsuariosCorporativos(res) {
  const usuarios = await seleccionarPerfilesAdmin();
  return enviarJson(res, 200, { ok: true, total: usuarios.length, usuarios });
}

async function actualizarUsuarioCorporativo(req, res, id) {
  const cuerpo = await leerJson(req);
  const cambios = {};
  if (Object.hasOwn(cuerpo, "activo")) cambios.activo = Boolean(cuerpo.activo);
  if (Object.hasOwn(cuerpo, "rol")) {
    if (!["admin", "tecnico"].includes(cuerpo.rol)) throw fallo("Rol no válido.");
    cambios.rol = cuerpo.rol;
  }
  if (Object.hasOwn(cuerpo, "sede_asignada")) {
    cambios.sede_asignada = String(cuerpo.sede_asignada || "").trim() || null;
  }
  if (Object.hasOwn(cuerpo, "sistema_asignado")) {
    cambios.sistema_asignado = cuerpo.sistema_asignado || null;
  }
  if (Object.hasOwn(cuerpo, "permisos")) {
    cambios.permisos = normalizarPermisos(cuerpo.permisos);
  }
  if (!Object.keys(cambios).length) throw fallo("No se enviaron cambios.");

  let respuesta = await supabaseAdmin
    .from("perfiles_ti")
    .update(cambios)
    .eq("id", id)
    .select("id, nombre_completo, cedula, email, rol, activo, sede_asignada, sistema_asignado, permisos, created_at")
    .maybeSingle();

  if (respuesta.error && /does not exist/i.test(respuesta.error.message)) {
    const cambiosBasicos = { activo: cambios.activo, rol: cambios.rol };
    Object.keys(cambiosBasicos).forEach((clave) => {
      if (cambiosBasicos[clave] === undefined) delete cambiosBasicos[clave];
    });
    respuesta = await supabaseAdmin
      .from("perfiles_ti")
      .update(cambiosBasicos)
      .eq("id", id)
      .select("id, nombre_completo, cedula, email, rol, activo, created_at")
      .maybeSingle();
  }

  if (respuesta.error) throw Object.assign(new Error(respuesta.error.message), { status: 502 });
  if (!respuesta.data) throw fallo("No se encontró el usuario.", 404);
  return enviarJson(res, 200, { ok: true, usuario: respuesta.data });
}

async function crearUsuarioCorporativoAdmin(req, res, usuario) {
  exigirAdmin(usuario);
  const cuerpo = await leerJson(req);
  const perfil = await crearUsuarioCorporativo(cuerpo, cuerpo.rol || "tecnico");
  return enviarJson(res, 201, { ok: true, usuario: perfil });
}

async function desactivarUsuarioCorporativo(req, res, url, id, usuario) {
  exigirAdmin(usuario);
  const eliminar = url.searchParams.get("modo") === "eliminar";

  const { data: perfil, error } = await supabaseAdmin
    .from("perfiles_ti")
    .select("id, email")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!perfil) throw fallo("No se encontró el usuario.", 404);

  if (eliminar) {
    const { error: errorBorrado } = await supabaseAdmin
      .from("perfiles_ti")
      .delete()
      .eq("id", id);
    if (errorBorrado) throw Object.assign(new Error(errorBorrado.message), { status: 502 });
    await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
    return enviarJson(res, 200, { ok: true, eliminado: id, mensaje: "Acceso eliminado." });
  }

  const { data, error: errorUpdate } = await supabaseAdmin
    .from("perfiles_ti")
    .update({ activo: false })
    .eq("id", id)
    .select("id, nombre_completo, email, rol, activo")
    .maybeSingle();
  if (errorUpdate) throw Object.assign(new Error(errorUpdate.message), { status: 502 });
  return enviarJson(res, 200, {
    ok: true,
    usuario: data,
    mensaje: "Acceso desactivado. El usuario ya no puede iniciar sesión.",
  });
}

const TABLAS_RESPALDO = [
  "sistemas",
  "equipos",
  "perfiles_ti",
  "actas",
  "historial_movimientos",
  "boveda_documentos",
];

async function respaldoCompleto(res, url, usuario) {
  if (usuario?.rol !== "admin") {
    throw fallo("Esta acción solo está disponible para administradores TI.", 403);
  }

  const consultas = await Promise.all(
    TABLAS_RESPALDO.map((tabla) =>
      supabaseAdmin.from(tabla).select("*").order("created_at", { ascending: false }).limit(100000)
    )
  );
  const error = consultas.find((consulta) => consulta.error)?.error;
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const datos = {};
  const resumen = {};
  TABLAS_RESPALDO.forEach((tabla, indice) => {
    datos[tabla] = consultas[indice].data || [];
    resumen[tabla] = datos[tabla].length;
  });

  const fecha = new Date().toISOString();
  const nombreBase = `Respaldo_Levapan_${fecha.slice(0, 10)}`;
  const formato = String(url.searchParams.get("formato") || "json").toLowerCase();

  if (formato === "xlsx") {
    const libro = XLSX.utils.book_new();
    TABLAS_RESPALDO.forEach((tabla) => {
      const filas = datos[tabla];
      const hoja = XLSX.utils.json_to_sheet(filas.length ? filas : [{ sin_registros: true }]);
      XLSX.utils.book_append_sheet(libro, hoja, tabla.slice(0, 31));
    });
    const bytes = XLSX.write(libro, { type: "buffer", bookType: "xlsx" });
    return enviarBinario(
      res,
      bytes,
      `${nombreBase}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  }

  const contenido = JSON.stringify(
    {
      aplicacion: "Acta Levapan · Arquitectura Inversa de TI",
      formato: "CORP-TEC-FR-002",
      generadoEn: fecha,
      generadoPor: usuario.nombre_completo || "admin",
      resumen,
      tablas: datos,
    },
    null,
    2
  );
  return enviarBinario(
    res,
    Buffer.from(contenido, "utf8"),
    `${nombreBase}.json`,
    "application/json; charset=utf-8"
  );
}

/* ------------------------------------------------------------
   SISTEMAS (arquitectura inversa)
   ------------------------------------------------------------ */

const CATEGORIAS_DOCUMENTO = ["Acta", "Contrato", "Factura", "Garantia", "Manual", "Licencia"];
const CRITICIDADES = ["Critica", "Alta", "Media", "Baja"];
const CAMPOS_SISTEMA = ["codigo", "nombre", "categoria", "criticidad", "responsable", "descripcion"];

function normalizarCriticidad(valor) {
  const texto = sinAcentos(valor).toLowerCase();
  const mapa = {
    critica: "Critica",
    crítica: "Critica",
    alta: "Alta",
    media: "Media",
    baja: "Baja",
  };
  return mapa[texto] || "Media";
}

function normalizarCategoriaDocumento(valor, porDefecto = "Contrato") {
  const texto = sinAcentos(valor).toLowerCase();
  const mapa = {
    acta: "Acta",
    contrato: "Contrato",
    factura: "Factura",
    garantia: "Garantia",
    manual: "Manual",
    licencia: "Licencia",
  };
  return mapa[texto] || porDefecto;
}

function codigoSistema(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function listaDesde(valor) {
  if (Array.isArray(valor)) return valor.map((item) => String(item).trim()).filter(Boolean);
  return String(valor ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function listarSistemas(res) {
  const [sistemas, equipos, vinculos] = await Promise.all([
    supabaseAdmin.from("sistemas").select("*").order("nombre", { ascending: true }),
    supabaseAdmin.from("equipos").select("sistema_id"),
    supabaseAdmin.from("documento_vinculos").select("sistema_id"),
  ]);

  const error = sistemas.error || equipos.error || vinculos.error;
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const contarEquipos = new Map();
  for (const equipo of equipos.data || []) {
    if (!equipo.sistema_id) continue;
    contarEquipos.set(equipo.sistema_id, (contarEquipos.get(equipo.sistema_id) || 0) + 1);
  }

  const contarDocumentos = new Map();
  for (const vinculo of vinculos.data || []) {
    if (!vinculo.sistema_id) continue;
    contarDocumentos.set(
      vinculo.sistema_id,
      (contarDocumentos.get(vinculo.sistema_id) || 0) + 1
    );
  }

  return enviarJson(res, 200, {
    ok: true,
    total: (sistemas.data || []).length,
    sistemas: (sistemas.data || []).map((sistema) => ({
      ...sistema,
      total_equipos: contarEquipos.get(sistema.id) || 0,
      total_documentos: contarDocumentos.get(sistema.id) || 0,
    })),
  });
}

async function guardarSistema(req, res, id = null) {
  const cuerpo = await leerJson(req);
  const registro = {};

  for (const campo of CAMPOS_SISTEMA) {
    if (!Object.hasOwn(cuerpo, campo)) continue;
    let valor = cuerpo[campo];
    if (typeof valor === "string") valor = valor.trim() || null;
    registro[campo] = valor;
  }

  if (Object.hasOwn(registro, "codigo")) registro.codigo = codigoSistema(registro.codigo);
  if (Object.hasOwn(registro, "criticidad")) {
    registro.criticidad = normalizarCriticidad(registro.criticidad);
  }

  if (id) {
    if (!Object.keys(registro).length) throw fallo("No se enviaron cambios.");
    const { data, error } = await supabaseAdmin
      .from("sistemas")
      .update(registro)
      .eq("id", id)
      .select()
      .single();
    if (error) throw Object.assign(new Error(error.message), { status: 502 });
    return enviarJson(res, 200, { ok: true, sistema: data });
  }

  if (!registro.codigo) throw fallo("El código del sistema es obligatorio.");
  if (!registro.nombre) throw fallo("El nombre del sistema es obligatorio.");
  registro.criticidad = registro.criticidad || "Media";

  const { data, error } = await supabaseAdmin
    .from("sistemas")
    .insert([registro])
    .select()
    .single();
  if (error) {
    const duplicado = /duplicate|unique/i.test(error.message);
    throw Object.assign(
      new Error(
        duplicado
          ? `Ya existe un sistema con el código ${registro.codigo}.`
          : error.message
      ),
      { status: duplicado ? 409 : 502 }
    );
  }
  return enviarJson(res, 201, { ok: true, sistema: data });
}

async function eliminarSistema(res, id) {
  const { data, error } = await supabaseAdmin
    .from("sistemas")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!data) throw fallo("No se encontró el sistema.", 404);
  return enviarJson(res, 200, { ok: true, eliminado: data.id });
}

/* ------------------------------------------------------------
   VISTA 360° INVERSA: /api/placas/:placa
   Sistema → Placa → Equipo → Actas / Contratos
   ------------------------------------------------------------ */

async function vistaPlaca(res, placa) {
  const buscada = String(placa || "").trim();
  if (!buscada) throw fallo("Indica la placa a consultar.");

  const { data: equipo, error } = await supabaseAdmin
    .from("equipos")
    .select("*, sistemas(id, codigo, nombre, categoria, criticidad, responsable, descripcion)")
    .ilike("placa", buscada)
    .maybeSingle();

  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!equipo) throw fallo(`No se encontró la placa ${buscada}.`, 404);

  const [historial, actas, vinculosPlaca] = await Promise.all([
    supabaseAdmin
      .from("historial_movimientos")
      .select("*")
      .eq("placa", equipo.placa)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("actas")
      .select("*")
      .eq("placa", equipo.placa)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("documento_vinculos")
      .select("*, boveda_documentos(*)")
      .eq("placa", equipo.placa),
  ]);

  if (historial.error || actas.error || vinculosPlaca.error) {
    throw Object.assign(
      new Error(
        historial.error?.message || actas.error?.message || vinculosPlaca.error?.message
      ),
      { status: 502 }
    );
  }

  let vinculosEquipo = [];
  if (equipo.id) {
    const { data } = await supabaseAdmin
      .from("documento_vinculos")
      .select("*, boveda_documentos(*)")
      .eq("equipo_id", equipo.id);
    vinculosEquipo = data || [];
  }

  // También se muestran los documentos del sistema padre (contratos marco).
  let documentosSistema = [];
  if (equipo.sistema_id) {
    const { data } = await supabaseAdmin
      .from("documento_vinculos")
      .select("*, boveda_documentos(*)")
      .eq("sistema_id", equipo.sistema_id);
    documentosSistema = data || [];
  }

  const documentos = new Map();
  [...(vinculosPlaca.data || []), ...vinculosEquipo, ...documentosSistema].forEach((vinculo) => {
    const documento = vinculo.boveda_documentos;
    if (!documento) return;
    documentos.set(documento.id, {
      ...documento,
      vinculo: {
        placa: vinculo.placa,
        equipo_id: vinculo.equipo_id,
        sistema_id: vinculo.sistema_id,
      },
    });
  });

  return enviarJson(res, 200, {
    ok: true,
    placa: equipo.placa,
    equipo,
    sistema: equipo.sistemas || null,
    historial: historial.data || [],
    actas: actas.data || [],
    documentos: [...documentos.values()],
  });
}

/* ------------------------------------------------------------
   BÓVEDA DOCUMENTAL: subida, Full-Text Search y vínculos
   ------------------------------------------------------------ */

async function vinculosDeDocumentos(ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabaseAdmin
    .from("documento_vinculos")
    .select("documento_id, equipo_id, placa, sistema_id")
    .in("documento_id", ids);
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const mapa = new Map();
  for (const vinculo of data || []) {
    if (!mapa.has(vinculo.documento_id)) mapa.set(vinculo.documento_id, []);
    mapa.get(vinculo.documento_id).push(vinculo);
  }
  return mapa;
}

async function listarBoveda(res, url) {
  const q = limpiarBusqueda(url.searchParams.get("q"));
  const categoria = String(url.searchParams.get("categoria") || "").trim();
  const placa = String(url.searchParams.get("placa") || "").trim();
  const sistema = String(url.searchParams.get("sistema") || "").trim();
  const limite = Math.min(200, Math.max(1, Number(url.searchParams.get("limite")) || 100));

  let idsFiltrados = null;
  if (placa || sistema) {
    let consulta = supabaseAdmin.from("documento_vinculos").select("documento_id");
    if (placa) consulta = consulta.ilike("placa", placa);
    if (sistema) consulta = consulta.eq("sistema_id", sistema);
    const { data, error } = await consulta.limit(2000);
    if (error) throw Object.assign(new Error(error.message), { status: 502 });
    idsFiltrados = [...new Set((data || []).map((fila) => fila.documento_id))];
    if (!idsFiltrados.length) {
      return enviarJson(res, 200, { ok: true, total: 0, documentos: [] });
    }
  }

  const base = () => {
    let consulta = supabaseAdmin.from("boveda_documentos").select("*", { count: "exact" });
    if (categoria) consulta = consulta.eq("categoria", categoria);
    if (idsFiltrados) consulta = consulta.in("id", idsFiltrados);
    return consulta;
  };

  let data = [];
  let count = 0;

  if (q) {
    const busqueda = await base()
      .textSearch("texto_indexado", q, { config: "spanish", type: "websearch" })
      .order("created_at", { ascending: false })
      .limit(limite);
    if (!busqueda.error) {
      data = busqueda.data || [];
      count = Number(busqueda.count) || data.length;
    } else {
      const respaldo = await base()
        .or(
          `titulo.ilike.%${q}%,proveedor.ilike.%${q}%,numero_referencia.ilike.%${q}%,contenido_texto.ilike.%${q}%`
        )
        .order("created_at", { ascending: false })
        .limit(limite);
      if (respaldo.error) throw Object.assign(new Error(respaldo.error.message), { status: 502 });
      data = respaldo.data || [];
      count = Number(respaldo.count) || data.length;
    }
  } else {
    const listado = await base().order("created_at", { ascending: false }).limit(limite);
    if (listado.error) throw Object.assign(new Error(listado.error.message), { status: 502 });
    data = listado.data || [];
    count = Number(listado.count) || data.length;
  }

  const mapaVinculos = await vinculosDeDocumentos(data.map((documento) => documento.id));

  return enviarJson(res, 200, {
    ok: true,
    total: count,
    busqueda: q,
    categoria: categoria || null,
    documentos: data.map((documento) => ({
      ...documento,
      texto_indexado: undefined,
      vinculos: mapaVinculos.get(documento.id) || [],
    })),
  });
}

async function crearVinculos(documento, placas, sistemas) {
  const filas = [];
  const vistos = new Set();

  const agregar = (fila) => {
    const llave = [fila.equipo_id || "", fila.placa || "", fila.sistema_id || ""].join("|");
    if (vistos.has(llave)) return;
    vistos.add(llave);
    filas.push({ documento_id: documento.id, ...fila });
  };

  if (placas.length) {
    const { data: equipos, error } = await supabaseAdmin
      .from("equipos")
      .select("id, placa, sistema_id")
      .in("placa", placas);
    if (error) throw Object.assign(new Error(error.message), { status: 502 });
    for (const equipo of equipos || []) {
      agregar({
        equipo_id: equipo.id,
        placa: equipo.placa,
        sistema_id: equipo.sistema_id || null,
      });
    }
  }

  for (const sistemaId of sistemas) {
    agregar({ equipo_id: null, placa: null, sistema_id: sistemaId });
  }

  if (!filas.length) return [];

  const { data: existentes, error: errorExistentes } = await supabaseAdmin
    .from("documento_vinculos")
    .select("equipo_id, placa, sistema_id")
    .eq("documento_id", documento.id);
  if (errorExistentes) {
    throw Object.assign(new Error(errorExistentes.message), { status: 502 });
  }

  const yaEstan = new Set(
    (existentes || []).map((fila) =>
      [fila.equipo_id || "", fila.placa || "", fila.sistema_id || ""].join("|")
    )
  );

  const nuevas = filas.filter(
    (fila) => !yaEstan.has([fila.equipo_id || "", fila.placa || "", fila.sistema_id || ""].join("|"))
  );
  if (!nuevas.length) return [];

  const { data, error } = await supabaseAdmin
    .from("documento_vinculos")
    .insert(nuevas)
    .select();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  return data || [];
}

async function subirDocumentoBoveda(req, res, usuario) {
  const { archivo, campos } = await recibirFormulario(req);
  if (!archivo || !archivo.buffer?.length) {
    throw fallo("Selecciona el archivo que deseas archivar en la Bóveda.");
  }

  const categoria = normalizarCategoriaDocumento(campos.categoria);
  const titulo =
    String(campos.titulo || "").trim() ||
    String(archivo.originalname || "Documento").replace(/\.[^.]+$/, "").slice(0, 160);

  const hash = calcularSha256(archivo.buffer);
  const cfg = configAlmacenamiento();

  const { data: existente, error: errorBusqueda } = await supabaseAdmin
    .from("boveda_documentos")
    .select("*")
    .eq("sha256_hash", hash)
    .maybeSingle();
  if (errorBusqueda) throw Object.assign(new Error(errorBusqueda.message), { status: 502 });

  let documento = existente;

  if (!documento) {
    const ruta = rutaDocumento({ hash, nombre: archivo.originalname || `${titulo}.pdf` });
    await subirObjeto({
      buffer: archivo.buffer,
      ruta,
      contentType: archivo.mimetype || "application/octet-stream",
      bucket: cfg.bucketBoveda,
    });

    const esPdf =
      String(archivo.mimetype || "").toLowerCase().includes("pdf") ||
      /\.pdf$/i.test(archivo.originalname || "");

    let textoExtraido = "";
    if (esPdf) {
      try {
        textoExtraido = extraerTextoPdf(archivo.buffer);
      } catch (err) {
        console.warn("[BOVEDA] No se pudo extraer texto del PDF:", err.message);
      }
    }

    const contenido = [String(campos.contenido_texto || "").trim(), textoExtraido]
      .filter(Boolean)
      .join("\n")
      .slice(0, 200_000);

    const { data, error } = await supabaseAdmin
      .from("boveda_documentos")
      .insert([
        {
          titulo,
          categoria,
          proveedor: String(campos.proveedor || "").trim() || null,
          numero_referencia: String(campos.numero_referencia || "").trim() || null,
          fecha_documento: campos.fecha_documento || null,
          fecha_vencimiento: campos.fecha_vencimiento || null,
          storage_provider: "supabase",
          storage_bucket: cfg.bucketBoveda,
          storage_path: ruta,
          mime_type: archivo.mimetype || "application/octet-stream",
          tamano_bytes: archivo.size || archivo.buffer.length,
          sha256_hash: hash,
          contenido_texto: contenido || null,
          subido_por: usuario?.nombre_completo || "sistema",
        },
      ])
      .select()
      .single();

    if (error) {
      if (/duplicate|unique/i.test(error.message)) {
        const { data: repetido } = await supabaseAdmin
          .from("boveda_documentos")
          .select("*")
          .eq("sha256_hash", hash)
          .maybeSingle();
        documento = repetido;
      } else {
        throw Object.assign(new Error(error.message), { status: 502 });
      }
    } else {
      documento = data;
    }
  }

  if (!documento) throw fallo("No se pudo registrar el documento en la Bóveda.", 502);

  const placas = listaDesde(campos.placas);
  const sistemas = listaDesde(campos.sistemas);
  const vinculos = await crearVinculos(documento, placas, sistemas);

  return enviarJson(res, 201, {
    ok: true,
    duplicado: Boolean(existente),
    documento: { ...documento, texto_indexado: undefined },
    vinculos,
    mensaje: existente
      ? "El archivo ya existía: se reutilizó y solo se añadieron los nuevos vínculos."
      : "Documento archivado en la Bóveda.",
  });
}

async function urlDocumentoBoveda(res, id) {
  const { data: documento, error } = await supabaseAdmin
    .from("boveda_documentos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!documento) throw fallo("No se encontró el documento.", 404);

  const url = await firmarObjeto({
    bucket: documento.storage_bucket || BUCKET_BOVEDA,
    ruta: documento.storage_path,
    segundos: 300,
    descarga: documento.titulo ? `${documento.titulo}.pdf` : undefined,
  });

  return enviarJson(res, 200, {
    ok: true,
    url,
    expiraEn: 300,
    documento: { ...documento, texto_indexado: undefined },
  });
}

async function vincularDocumento(req, res, id) {
  const cuerpo = await leerJson(req);
  const { data: documento, error } = await supabaseAdmin
    .from("boveda_documentos")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!documento) throw fallo("No se encontró el documento.", 404);

  const placas = listaDesde(cuerpo.placas);
  const sistemas = listaDesde(cuerpo.sistemas);
  if (!placas.length && !sistemas.length) {
    throw fallo("Indica al menos una placa o un sistema para vincular.");
  }

  const vinculos = await crearVinculos(documento, placas, sistemas);
  return enviarJson(res, 200, { ok: true, vinculos });
}

async function eliminarDocumentoBoveda(res, id) {
  const { data: documento, error } = await supabaseAdmin
    .from("boveda_documentos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!documento) throw fallo("No se encontró el documento.", 404);

  const { error: errorBorrado } = await supabaseAdmin
    .from("boveda_documentos")
    .delete()
    .eq("id", id);
  if (errorBorrado) throw Object.assign(new Error(errorBorrado.message), { status: 502 });

  const { count } = await supabaseAdmin
    .from("boveda_documentos")
    .select("id", { count: "exact", head: true })
    .eq("storage_path", documento.storage_path);

  if (!count) {
    try {
      await supabaseAdmin.storage
        .from(documento.storage_bucket || BUCKET_BOVEDA)
        .remove([documento.storage_path]);
    } catch (err) {
      console.warn("[BOVEDA] No se pudo borrar el objeto físico:", err.message);
    }
  }

  return enviarJson(res, 200, { ok: true, eliminado: id });
}

/** Reindexa el texto de un PDF ya archivado (utilidad de administración). */
async function reindexarDocumento(res, id) {
  const { data: documento, error } = await supabaseAdmin
    .from("boveda_documentos")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });
  if (!documento) throw fallo("No se encontró el documento.", 404);

  const bytes = await descargarObjeto({
    bucket: documento.storage_bucket || BUCKET_BOVEDA,
    ruta: documento.storage_path,
  });
  const texto = extraerTextoPdf(bytes);

  const { error: errorActualizar } = await supabaseAdmin
    .from("boveda_documentos")
    .update({ contenido_texto: texto || documento.contenido_texto || null })
    .eq("id", id);
  if (errorActualizar) {
    throw Object.assign(new Error(errorActualizar.message), { status: 502 });
  }

  return enviarJson(res, 200, {
    ok: true,
    caracteres: (texto || "").length,
    indexado: Boolean(texto),
  });
}

/* ------------------------------------------------------------
   ASISTENTE TI · consulta y modificación en lenguaje natural
   ------------------------------------------------------------ */

function extraerIdentificadorAsistente(texto) {
  const mensaje = String(texto || "");
  const numerico = mensaje.match(/(?:ML-?)?\d{3,}/i);
  if (numerico) return numerico[0];

  const stopwords = new Set([
    "busca", "buscar", "muestra", "muéstrame", "muestrame", "consulta", "dame",
    "equipo", "equipos", "de", "del", "la", "el", "los", "las", "en", "con",
    "que", "tiene", "serial", "ceco", "sede", "area", "área", "por", "para",
    "cambia", "cambiale", "cámbiale", "estado", "vincular", "vincúlalo",
  ]);

  const limpio = mensaje
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[?¿.,!;:]/g, " ")
    .trim();

  const palabras = limpio
    .split(/\s+/)
    .filter((palabra) => palabra.length >= 3 && !stopwords.has(palabra.toLowerCase()));

  return palabras.slice(-3).join(" ") || limpio;
}

async function buscarEquipoAsistente(texto) {
  const identificador = extraerIdentificadorAsistente(texto);
  const termino = limpiarBusqueda(identificador).slice(0, 80);
  if (!termino) return null;

  const filtrosCompletos = [
    `placa.ilike.%${termino}%`,
    `nombre_equipo_red.ilike.%${termino}%`,
    `serial.ilike.%${termino}%`,
    `responsable.ilike.%${termino}%`,
    `usuario_asignado.ilike.%${termino}%`,
    `cedula_responsable.ilike.%${termino}%`,
    `usuario_cedula.ilike.%${termino}%`,
    `ceco.ilike.%${termino}%`,
    `sede.ilike.%${termino}%`,
    `area.ilike.%${termino}%`,
    `marca.ilike.%${termino}%`,
    `modelo.ilike.%${termino}%`,
    `proveedor.ilike.%${termino}%`,
    `numero_contrato.ilike.%${termino}%`,
    `estado.ilike.%${termino}%`,
  ];

  let respuesta = await supabaseAdmin
    .from("equipos")
    .select("*")
    .or(filtrosCompletos.join(","))
    .limit(1);

  if (respuesta.error && /does not exist/i.test(respuesta.error.message)) {
    const filtrosBasicos = [
      `placa.ilike.%${termino}%`,
      `serial.ilike.%${termino}%`,
      `usuario_asignado.ilike.%${termino}%`,
      `usuario_cedula.ilike.%${termino}%`,
    ];
    respuesta = await supabaseAdmin
      .from("equipos")
      .select("*")
      .or(filtrosBasicos.join(","))
      .limit(1);
  }

  if (respuesta.error) throw Object.assign(new Error(respuesta.error.message), { status: 502 });
  return respuesta.data?.[0] || null;
}

function interpretarCambioAsistente(texto) {
  const mensaje = String(texto || "").trim();
  if (!mensaje) return null;

  const id = extraerIdentificadorAsistente(mensaje);
  if (!id || !/\d/.test(id)) return null;

  const cambios = {};

  const estado = mensaje.match(/\bestado\b[^.]*?\ba\s+([^,;.]+)/i)?.[1];
  if (estado) cambios.estado = estado.trim();

  const ceco = mensaje.match(/\bceco\b[^.]*?\ba\s+([A-Za-z0-9-]+)/i)?.[1];
  if (ceco) cambios.ceco = ceco.trim();

  const cedula = mensaje.match(/\bcedula\b\s*(\d{6,})/i)?.[1];
  if (cedula) {
    cambios.cedula_responsable = cedula;
    cambios.usuario_cedula = cedula;
  }

  const sede = mensaje.match(/\bsede\b\s+([^,;.]+)/i)?.[1];
  if (sede) cambios.sede = sede.trim();

  const area = mensaje.match(/\barea\b\s+([^,;.]+)/i)?.[1];
  if (area) cambios.area = area.trim();

  if (/\basigna|\basignar/i.test(mensaje)) {
    const nombre = mensaje
      .match(/\ba\s+([A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+){0,3})(?=\s+cedula|\s+sede|\s+ceco|\s+area|$)/i)?.[1];
    if (nombre) {
      cambios.responsable = nombre.trim();
      cambios.usuario_asignado = nombre.trim();
      cambios.estado = cambios.estado || "Asignado";
    }
  }

  if (/\bdisponible\b/i.test(mensaje) && !cambios.estado) {
    cambios.estado = "Disponible";
  }

  const bitacora = mensaje.match(/\bbitacora\b[^:]*:\s*(.+)$/i)?.[1];
  if (bitacora) cambios.bitacora_equipo = bitacora.trim();

  if (/\bvincula|\bvincular|\basigna\b.*\bsistema\b/i.test(mensaje)) {
    const sistema = mensaje.match(/(?:al\s+sistema|sistema)\s+([A-Za-z0-9_-]+)/i)?.[1];
    if (sistema) cambios.sistema_codigo = sistema;
  }

  return Object.keys(cambios).length ? { id, cambios } : null;
}

const memoriaChat = new Map();

function primerNombreChat(nombre) {
  return String(nombre || "")
    .trim()
    .split(/\s+/)[0] || "colega";
}

function saludoPorHora() {
  const hora = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Bogota",
      hour: "2-digit",
      hour12: false,
    }).format(new Date())
  );
  if (hora < 12) return "Buenos días";
  if (hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

function esSaludoChat(texto) {
  return /^(hola|buenos días|buenas tardes|buenas noches|qué tal|como estas|cómo estás|hey|saludos|gracias|muchas gracias|excelente|listo|quién eres|que puedes hacer|qué puedes hacer|ayuda)\b/i.test(
    String(texto || "").trim()
  );
}

function respuestaSaludo(texto, usuario) {
  const nombre = primerNombreChat(usuario?.nombre_completo);
  const saludo = saludoPorHora();
  const mensaje = String(texto || "").trim().toLowerCase();

  if (/gracias|excelente|listo/.test(mensaje)) {
    return `Con gusto, ${nombre}. Quedo atento si necesitas otra consulta.`;
  }
  if (/quién eres|quien eres/.test(mensaje)) {
    return `Soy tu Asistente Integral de TI Levapan, ${nombre}. Estoy conectado a Sistemas, Placas, Equipos, Actas y Bóveda PDF.`;
  }
  if (/ayuda|qué puedes hacer|que puedes hacer/.test(mensaje)) {
    return `${saludo}, ${nombre}. Soy tu Asistente Integral de TI Levapan. Puedo ayudarte con:\n` +
      "• Buscar una placa, serial, cédula, CECO, sede o responsable.\n" +
      "• Cambiar estado, responsable, sede, CECO, área o bitácora de un equipo.\n" +
      "• Vincular placas a sistemas (ERP-SAP, M365, INFRA-PLANTA, POS-CAJAS, REDES-SRV).\n" +
      "• Ver su Hoja de Vida y preparar actas CORP-TEC-FR-002.\n" +
      "Ejemplo: «cambia el estado de 01882 a Disponible».";
  }
  return `${saludo}, ${nombre}! Soy tu Asistente Integral de TI Levapan. ¿Qué equipo o sistema revisamos hoy?`;
}

function recordarPlacaChat(usuario, placa) {
  if (!placa || !usuario?.id) return;
  const actual = memoriaChat.get(usuario.id) || {};
  memoriaChat.set(usuario.id, {
    ...actual,
    ultimaPlaca: placa,
    actualizadaEn: new Date().toISOString(),
  });
}

function placaContextual(usuario, mensaje) {
  const directa = extraerIdentificadorAsistente(mensaje);
  if (/\d{3,}/.test(String(mensaje))) {
    if (directa) recordarPlacaChat(usuario, directa);
    return directa;
  }
  const usaContexto =
    /cámbiale|cambiale|su |suyo|sus |vincúlalo|vinculalo|muéstrame su|muestrame su|genera su|historial|qué se le ha hecho|que se le ha hecho|quien lo tiene|quién lo tiene|quién tiene|quien tiene|ese equipo|eso\b/i.test(
      String(mensaje)
    );
  if (!usaContexto) return null;
  return memoriaChat.get(usuario?.id)?.ultimaPlaca || null;
}

async function asistenteTi(req, res, usuario) {
  const cuerpo = await leerJson(req);
  const mensaje = String(cuerpo.mensaje || "").trim();
  if (!mensaje) throw fallo("Escribe una consulta o una orden para el asistente.");

  if (esSaludoChat(mensaje)) {
    return enviarJson(res, 200, {
      ok: true,
      tipo: "conversacion",
      mensaje: respuestaSaludo(mensaje, usuario),
    });
  }

  const placaContexto = placaContextual(usuario, mensaje);
  const mensajeEfectivo = placaContexto && !/\d{3,}/.test(mensaje)
    ? `${placaContexto} · ${mensaje}`
    : mensaje;

  // Hoja de vida desde el chat.
  if (/historial|qué se le ha hecho|que se le ha hecho|hoja de vida/i.test(mensaje)) {
    const equipoHistorial = await buscarEquipoAsistente(mensajeEfectivo);
    if (!equipoHistorial) {
      return enviarJson(res, 200, {
        ok: true,
        tipo: "sin_resultados",
        mensaje: "No tengo una placa en memoria. Dime de qué equipo quieres ver el historial.",
      });
    }
    const { data: movimientos, error } = await supabaseAdmin
      .from("historial_movimientos")
      .select("*")
      .eq("equipo_id", equipoHistorial.id)
      .order("created_at", { ascending: false })
      .limit(12);
    if (error) throw Object.assign(new Error(error.message), { status: 502 });
    const detalle = (movimientos || [])
      .map(
        (mov) =>
          `• ${new Date(mov.created_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })} · ${
            mov.tipo_movimiento || mov.accion
          }: ${mov.descripcion || mov.detalle || "—"}`
      )
      .join("\n");
    return enviarJson(res, 200, {
      ok: true,
      tipo: "historial",
      mensaje: `Estos son los últimos movimientos de ${equipoHistorial.placa}:\n${detalle || "Sin movimientos registrados."}`,
      equipo: equipoHistorial,
      movimientos: movimientos || [],
    });
  }

  // ¿Quién lo tiene?
  if (/quién lo tiene|quien lo tiene|quién tiene|quien tiene|responsable de/i.test(mensaje)) {
    const equipoResponsable = await buscarEquipoAsistente(mensajeEfectivo);
    if (equipoResponsable) {
      recordarPlacaChat(usuario, equipoResponsable.placa || equipoResponsable.serial);
      return enviarJson(res, 200, {
        ok: true,
        tipo: "busqueda",
        mensaje: `El equipo ${equipoResponsable.placa || equipoResponsable.serial} está a cargo de ${
          equipoResponsable.responsable || equipoResponsable.usuario_asignado || "sin responsable registrado"
        }${equipoResponsable.sede ? `, en ${equipoResponsable.sede}` : ""}.`,
        equipo: equipoResponsable,
      });
    }
  }

  // a) Acta lista para firmar: devuelve acción directa con los datos de la placa.
  if (/generar acta|preparar acta/i.test(mensajeEfectivo)) {
    const equipoActa = await buscarEquipoAsistente(mensajeEfectivo);
    if (!equipoActa) {
      return enviarJson(res, 200, {
        ok: true,
        tipo: "sin_resultados",
        mensaje: "No encontré esa placa para preparar el acta.",
      });
    }
    return enviarJson(res, 200, {
      ok: true,
      tipo: "accion_acta",
      mensaje: `Acta CORP-TEC-FR-002 lista para ${equipoActa.placa || equipoActa.serial}. Los 27 datos están precargados.`,
      placa: equipoActa.placa,
      equipo: equipoActa,
    });
  }

  // d) Bóveda documental vinculada a la placa.
  if (/(buscar|muestra|listar|ver).*(contrato|acta|documento|pdf|boveda)/i.test(mensajeEfectivo) || /(contratos|actas) de/i.test(mensajeEfectivo)) {
    const identificador = extraerIdentificadorAsistente(mensajeEfectivo);
    const vinculos = await supabaseAdmin
      .from("documento_vinculos")
      .select("documento_id")
      .ilike("placa", identificador)
      .limit(50);
    let documentos = [];
    if (!vinculos.error && vinculos.data?.length) {
      const ids = vinculos.data.map((vinculo) => vinculo.documento_id);
      const consultaDocs = await supabaseAdmin
        .from("boveda_documentos")
        .select("id, titulo, categoria, fecha_documento")
        .in("id", ids)
        .order("created_at", { ascending: false });
      documentos = consultaDocs.data || [];
    }
    return enviarJson(res, 200, {
      ok: true,
      tipo: "documentos",
      mensaje: `${documentos.length} documento(s) vinculado(s) a ${identificador}.`,
      documentos,
    });
  }

  // c) Sistemas: listado y equipos por sistema.
  if (/listar sistemas|sistemas disponibles/i.test(mensajeEfectivo)) {
    const { data, error } = await supabaseAdmin
      .from("sistemas")
      .select("id, codigo, nombre, criticidad")
      .order("nombre", { ascending: true });
    if (error) throw Object.assign(new Error(error.message), { status: 502 });
    return enviarJson(res, 200, {
      ok: true,
      tipo: "resumen",
      mensaje: `${data.length} sistema(s) mapeados: ${data.map((s) => `${s.codigo} · ${s.nombre}`).join(" | ")}.`,
      sistemas: data,
    });
  }

  const mencionSistema = mensajeEfectivo.match(/(?:sistema|en)\s+([A-Za-z0-9_-]+)(?:\s|$)/i);
  if (mencionSistema && /\bsistemas?\b|equipos en/i.test(mensajeEfectivo) && !/vincula/i.test(mensajeEfectivo)) {
    const buscado = mencionSistema[1];
    const { data: sistemas } = await supabaseAdmin
      .from("sistemas")
      .select("id, codigo, nombre")
      .or(`codigo.ilike.%${buscado}%,nombre.ilike.%${buscado}%`)
      .limit(1);
    if (sistemas?.length) {
      const { count } = await supabaseAdmin
        .from("equipos")
        .select("id", { count: "exact", head: true })
        .eq("sistema_id", sistemas[0].id);
      return enviarJson(res, 200, {
        ok: true,
        tipo: "resumen",
        mensaje: `${sistemas[0].nombre} (${sistemas[0].codigo}) tiene ${Number(count) || 0} equipo(s).`,
        sistema: sistemas[0],
        total: Number(count) || 0,
      });
    }
  }

  // a) Consultas agregadas sin placa concreta.
  const esAgregado =
    /(cuántos|cuantos|resumen|disponibles|mantenimiento|por sede|equipos en|ceco)/i.test(mensajeEfectivo) &&
    !/\d{4,}/.test(mensajeEfectivo);
  if (esAgregado) {
    let filas = [];
    let desde = 0;
    while (desde <= 50000) {
      const { data: lote, error } = await supabaseAdmin
        .from("equipos")
        .select("estado, sede, ceco")
        .order("placa", { ascending: true })
        .range(desde, desde + 999);
      if (error) throw Object.assign(new Error(error.message), { status: 502 });
      filas = filas.concat(lote || []);
      if ((lote || []).length < 1000) break;
      desde += 1000;
    }

    const porEstado = {};
    const porSede = {};
    const porCeco = {};
    for (const fila of filas || []) {
      if (fila.estado) porEstado[fila.estado] = (porEstado[fila.estado] || 0) + 1;
      if (fila.sede) porSede[fila.sede] = (porSede[fila.sede] || 0) + 1;
      if (fila.ceco) porCeco[fila.ceco] = (porCeco[fila.ceco] || 0) + 1;
    }
    const principales = (objeto) =>
      Object.entries(objeto)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([clave, total]) => `${clave}: ${total}`)
        .join(" · ");

    let respuesta = `Total: ${(filas || []).length} equipos. Por estado: ${principales(porEstado) || "sin datos"}.`;
    if (/sede/i.test(mensajeEfectivo)) respuesta += ` Por sede: ${principales(porSede) || "sin datos"}.`;
    if (/ceco/i.test(mensajeEfectivo)) respuesta += ` Por CECO: ${principales(porCeco) || "sin datos"}.`;
    return enviarJson(res, 200, {
      ok: true,
      tipo: "resumen",
      mensaje: respuesta,
      resumen: { total: (filas || []).length, porEstado, porSede, porCeco },
    });
  }

  const intencion = interpretarCambioAsistente(mensajeEfectivo);
  const equipo = await buscarEquipoAsistente(intencion ? intencion.id : mensajeEfectivo);
  if (equipo) recordarPlacaChat(usuario, equipo.placa || equipo.serial);

  if (!equipo) {
    return enviarJson(res, 200, {
      ok: true,
      tipo: "sin_resultados",
      mensaje: "No encontré un equipo con esos datos. Prueba con la placa, serial, cédula o CECO exactos.",
    });
  }

  if (!intencion) {
    return enviarJson(res, 200, {
      ok: true,
      tipo: "busqueda",
      mensaje: `Equipo ${equipo.placa || equipo.serial || "encontrado"} localizado.`,
      equipo,
    });
  }

  const permiteEditar =
    usuario.rol === "admin" || usuario.permisos?.puede_crear_editar_equipos !== false;
  if (!permiteEditar) {
    throw fallo("Tu perfil no tiene permiso para modificar equipos.", 403);
  }

  const cambios = { ...intencion.cambios };
  let tipoResultado = "modificacion";
  if (cambios.sistema_codigo) {
    const codigoSistema = cambios.sistema_codigo;
    delete cambios.sistema_codigo;
    const { data: sistemas } = await supabaseAdmin
      .from("sistemas")
      .select("id, codigo, nombre")
      .or(`codigo.ilike.%${codigoSistema}%,nombre.ilike.%${codigoSistema}%`)
      .limit(1);
    if (!sistemas?.length) throw fallo(`No encontré el sistema ${codigoSistema}.`, 404);
    cambios.sistema_id = sistemas[0].id;
    tipoResultado = "vinculacion";
  }
  Object.keys(cambios).forEach((clave) => {
    if (cambios[clave] === "") cambios[clave] = null;
  });

  let respuesta = await supabaseAdmin
    .from("equipos")
    .update(cambios)
    .eq("id", equipo.id)
    .select()
    .maybeSingle();

  if (respuesta.error && /does not exist/i.test(respuesta.error.message)) {
    const legado = {};
    if (Object.hasOwn(cambios, "estado")) legado.estado = cambios.estado;
    if (Object.hasOwn(cambios, "sede")) legado.sede = cambios.sede;
    if (Object.hasOwn(cambios, "responsable")) legado.usuario_asignado = cambios.responsable;
    if (Object.hasOwn(cambios, "usuario_asignado")) legado.usuario_asignado = cambios.usuario_asignado;
    if (Object.hasOwn(cambios, "cedula_responsable")) legado.usuario_cedula = cambios.cedula_responsable;
    if (Object.hasOwn(cambios, "usuario_cedula")) legado.usuario_cedula = cambios.usuario_cedula;
    respuesta = await supabaseAdmin
      .from("equipos")
      .update(legado)
      .eq("id", equipo.id)
      .select()
      .maybeSingle();
  }

  if (respuesta.error) throw Object.assign(new Error(respuesta.error.message), { status: 502 });

  const detalle = `Asistente TI: ${Object.entries(cambios)
    .map(([clave, valor]) => `${clave} → ${valor ?? "—"}`)
    .join(" · ")
    .slice(0, 900)}`;

  const tipoMovimiento = /mantenim|reparac/i.test(mensajeEfectivo)
    ? "Mantenimiento"
    : /estado/i.test(mensajeEfectivo)
      ? "Cambio de Estado"
      : /asigna|responsable/i.test(mensajeEfectivo)
        ? "Asignación"
        : tipoResultado === "vinculacion"
          ? "Edición"
          : "Edición";

  await registrarMovimiento({
    equipo_id: equipo.id,
    placa: equipo.placa || "",
    accion: "Edicion",
    tipo_movimiento: tipoMovimiento,
    detalle,
    realizado_por: usuario.nombre_completo || "asistente-ti",
    usuario,
  });

  return enviarJson(res, 200, {
    ok: true,
    tipo: tipoResultado,
    mensaje: `Listo. Actualicé ${Object.keys(cambios).join(", ")} del equipo ${equipo.placa || equipo.serial}.`,
    equipo: respuesta.data,
    cambios,
  });
}

/* ------------------------------------------------------------
   Router de API
   ------------------------------------------------------------ */

async function manejarApi(req, res, url) {
  const ruta = url.pathname;
  const metodo = req.method;

  if (ruta === "/api/config-publica" && metodo === "GET") {
    return enviarJson(res, 200, {
      ok: true,
      supabaseUrl: CONFIG.url,
      supabaseAnonKey: CONFIG.anonKey,
      bucket: BUCKET_ACTAS,
    });
  }

  // Registro público de cuentas corporativas @levapan.com.
  if (ruta === "/api/registro-corporativo" && metodo === "POST") {
    return registroCorporativo(req, res);
  }

  // Todas las demás rutas requieren JWT válido y perfil TI activo.
  const usuario = await requiereSesion(req);

  if ((ruta === "/api/perfil" || ruta === "/api/me") && metodo === "GET") {
    return enviarJson(res, 200, {
      ok: true,
      ...usuario,
      nombre: usuario.nombre_completo,
      name: usuario.nombre_completo,
    });
  }

  if (ruta === "/api/asistente-ti" && metodo === "POST") {
    return asistenteTi(req, res, usuario);
  }

  /* ---------------- Sistemas ---------------- */
  if (ruta === "/api/sistemas" && metodo === "GET") {
    return listarSistemas(res);
  }
  if (ruta === "/api/sistemas" && metodo === "POST") {
    return guardarSistema(req, res);
  }
  const coincideSistema = /^\/api\/sistemas\/([^/]+)$/.exec(ruta);
  if (coincideSistema && metodo === "PUT") {
    return guardarSistema(req, res, coincideSistema[1]);
  }
  if (coincideSistema && metodo === "DELETE") {
    return eliminarSistema(res, coincideSistema[1]);
  }

  /* ---------------- Vista 360° por placa ---------------- */
  const coincidePlaca = /^\/api\/placas\/([^/]+)$/.exec(ruta);
  if (coincidePlaca && metodo === "GET") {
    return vistaPlaca(res, decodeURIComponent(coincidePlaca[1]));
  }

  /* ---------------- Bóveda documental ---------------- */
  if (ruta === "/api/boveda" && metodo === "GET") {
    return listarBoveda(res, url);
  }
  if (ruta === "/api/boveda" && metodo === "POST") {
    return subirDocumentoBoveda(req, res, usuario);
  }

  const coincideUrlBoveda = /^\/api\/boveda\/([^/]+)\/url$/.exec(ruta);
  if (coincideUrlBoveda && metodo === "GET") {
    return urlDocumentoBoveda(res, coincideUrlBoveda[1]);
  }

  const coincideVinculos = /^\/api\/boveda\/([^/]+)\/vinculos$/.exec(ruta);
  if (coincideVinculos && metodo === "POST") {
    return vincularDocumento(req, res, coincideVinculos[1]);
  }

  const coincideReindexar = /^\/api\/boveda\/([^/]+)\/reindexar$/.exec(ruta);
  if (coincideReindexar && metodo === "POST") {
    return reindexarDocumento(res, coincideReindexar[1]);
  }

  const coincideDocumento = /^\/api\/boveda\/([^/]+)$/.exec(ruta);
  if (coincideDocumento && metodo === "DELETE") {
    return eliminarDocumentoBoveda(res, coincideDocumento[1]);
  }

  if (ruta === "/api/equipos/buscar" && metodo === "GET") {
    return buscarEquiposSugeridos(res, url);
  }

  if (
    (ruta === "/api/equipos/importar" || ruta === "/api/equipos/importar-excel") &&
    metodo === "POST"
  ) {
    return importarEquipos(req, res, usuario);
  }

  if (ruta === "/api/equipos" && metodo === "GET") {
    return listarEquipos(res, url);
  }
  if (ruta === "/api/equipos" && metodo === "POST") {
    return crearEquipo(req, res, usuario);
  }

  const coincideNovedad = /^\/api\/equipos\/([^/]+)\/novedades$/.exec(ruta);
  if (coincideNovedad && metodo === "POST") {
    return registrarNovedadEquipo(req, res, usuario, coincideNovedad[1]);
  }

  const coincideHistorialPlaca = /^\/api\/equipos\/placa\/([^/]+)\/historial$/.exec(ruta);
  if (coincideHistorialPlaca && metodo === "GET") {
    return historialPorPlaca(res, decodeURIComponent(coincideHistorialPlaca[1]));
  }

  const coincideHistorial = /^\/api\/equipos\/([^/]+)\/historial$/.exec(ruta);
  if (coincideHistorial && metodo === "GET") {
    return historialEquipo(res, coincideHistorial[1]);
  }

  const coincideEquipo = /^\/api\/equipos\/([^/]+)$/.exec(ruta);
  if (coincideEquipo && metodo === "PUT") {
    return editarEquipo(req, res, usuario, coincideEquipo[1]);
  }

  if (
    (ruta === "/api/actas" ||
      ruta === "/api/guardar-acta" ||
      ruta === "/api/actas/guardar") &&
    metodo === "POST"
  ) {
    return guardarActa(req, res, usuario);
  }
  if (ruta === "/api/actas" && metodo === "GET") {
    return listarActas(res, url);
  }

  const coincidePdf = /^\/api\/actas\/([^/]+)\/pdf$/.exec(ruta);
  if (coincidePdf && metodo === "GET") {
    return urlPdfActa(res, coincidePdf[1]);
  }

  if (ruta === "/api/exportar/excel" && metodo === "GET") {
    return exportarExcel(res);
  }

  /* ---------------- Usuarios corporativos (admin) ---------------- */
  if (ruta === "/api/admin/usuarios" && metodo === "GET") {
    exigirAdmin(usuario);
    return listarUsuariosCorporativos(res);
  }
  if (ruta === "/api/admin/usuarios" && metodo === "POST") {
    return crearUsuarioCorporativoAdmin(req, res, usuario);
  }
  const coincideUsuario = /^\/api\/admin\/usuarios\/([^/]+)$/.exec(ruta);
  if (coincideUsuario && metodo === "PATCH") {
    exigirAdmin(usuario);
    return actualizarUsuarioCorporativo(req, res, coincideUsuario[1]);
  }
  if (coincideUsuario && metodo === "DELETE") {
    return desactivarUsuarioCorporativo(req, res, url, coincideUsuario[1], usuario);
  }

  /* ---------------- Respaldo total (admin) ---------------- */
  if (ruta === "/api/admin/respaldo-completo" && metodo === "GET") {
    return respaldoCompleto(res, url, usuario);
  }

  return enviarJson(res, 404, {
    ok: false,
    error: `Ruta no encontrada: ${metodo} ${ruta}`,
  });
}

/* ------------------------------------------------------------
   Servidor
   ------------------------------------------------------------ */

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const ruta = url.pathname;

  try {
    if (ruta === "/api/health" && (req.method === "GET" || req.method === "HEAD")) {
      return await manejarHealth(res);
    }
    if (ruta === "/api/estado" && (req.method === "GET" || req.method === "HEAD")) {
      return await manejarEstado(res);
    }
    if (ruta.startsWith("/api/")) {
      return await manejarApi(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return enviarJson(res, 405, { ok: false, error: "Método no permitido." });
    }
    return await servirEstatico(req, res, url);
  } catch (err) {
    return responderError(res, err, `${req.method} ${ruta}`);
  }
});

servidor.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nNo se pudo iniciar: el puerto ${PUERTO} ya está en uso.\n` +
        "Cierra la otra ventana o define otro puerto con: set PORT=3001\n"
    );
  } else {
    console.error("Error del servidor:", err);
  }
  process.exitCode = 1;
});

servidor.listen(PORT, HOST, () => {
  const linea = "=".repeat(62);
  console.log(`\n${linea}`);
  console.log("  ACTA DE TECNOLOGÍA · LEVAPAN · SUPABASE EDITION");
  console.log(linea);
  console.log(`  Motor           : PostgreSQL + Auth + Storage (Supabase)`);
  console.log(`  URL Supabase    : ${CONFIG.url || "NO CONFIGURADA"}`);
  console.log(`  Bucket actas    : ${BUCKET_ACTAS} (privado)`);
  console.log(`  PDF oficial     : CORP-TEC-FR-002`);
  console.log(`  Acceso          : Supabase Auth + perfiles_ti`);
  console.log(`  Escucha         : http://localhost:${PUERTO}`);
  console.log("  Accesos         : admin@levapan.com / Macos.2025 · tecnico@levapan.com / Tecnico.2025");
  console.log(linea);

  if (!CONFIG.configurado) {
    console.error("  [!] " + mensajeConfiguracionIncompleta(CONFIG));
    console.error(linea);
  }

  contarEquipos()
    .then((total) => {
      console.log(`  Inventario      : ${total} equipos sincronizados\n`);
      if (total === 0) migrarInventarioSiVacio();
    })
    .catch((err) => console.warn(`  Inventario      : sin conexión (${err.message})\n`));
});

/**
 * Si la tabla equipos está vacía, lanza la migración del inventario en un
 * proceso hijo. Es idempotente (upsert por placa), así que se puede repetir.
 * Se puede desactivar con AUTO_MIGRAR_INVENTARIO=false en .env.
 */
function migrarInventarioSiVacio() {
  if (String(process.env.AUTO_MIGRAR_INVENTARIO || "true").toLowerCase() === "false") return;

  const script = path.join(RAIZ, "scripts", "migrar-inventario.js");
  if (!fs.existsSync(script)) return;

  try {
    const hijo = spawn(process.execPath, [script], {
      cwd: RAIZ,
      stdio: "inherit",
      detached: true,
    });
    hijo.on("error", (err) =>
      console.warn(`  Migración      : no se pudo iniciar (${err.message})`)
    );
    hijo.unref?.();
    console.log("  Migración      : inventario vacío, cargando en segundo plano...");
  } catch (err) {
    console.warn(`  Migración      : ${err.message}`);
  }
}

function detener(senal) {
  console.log(`\nCerrando servidor (${senal})...`);
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => detener("SIGINT"));
process.on("SIGTERM", () => detener("SIGTERM"));
