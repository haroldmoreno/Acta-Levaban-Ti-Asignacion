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
  renombrarEncabezados,
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

const ESTADOS_PERMITIDOS = [
  "Disponible",
  "Asignado",
  "En Mantenimiento",
  "Prestamo",
  "Dado de Baja",
];

function normalizarEstadoEquipo(valor) {
  const texto = sinAcentos(valor).toLowerCase().replace(/\s+/g, " ");
  const mapa = {
    disponible: "Disponible",
    "disponible para asignar": "Disponible",
    asignado: "Asignado",
    prestamo: "Prestamo",
    mantenimiento: "En Mantenimiento",
    "en mantenimiento": "En Mantenimiento",
    "dado de baja": "Dado de Baja",
  };
  return mapa[texto] || (ESTADOS_PERMITIDOS.includes(valor) ? valor : "Disponible");
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
  const { error } = await supabaseAdmin
    .from("historial_movimientos")
    .insert([movimiento]);
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
    sistema: String(url.searchParams.get("sistema") || "").trim(),
  };
  const estado = String(url.searchParams.get("estado") || "").trim();
  const pagina = Math.max(1, Number(url.searchParams.get("pagina")) || 1);
  const limite = Math.min(200, Math.max(1, Number(url.searchParams.get("limite")) || 25));

  const [total, disponibles, asignados, mantenimiento] = await Promise.all([
    contarCon(base, ""),
    contarCon(base, "Disponible"),
    contarCon(base, "Asignado"),
    contarCon(base, "En Mantenimiento"),
  ]);

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
    resumen: { total, disponibles, asignados, mantenimiento },
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
    estado: normalizarEstadoEquipo(cuerpo.estado || "Disponible"),
    sede: cuerpo.sede || null,
    usuario_asignado: cuerpo.usuario_asignado || null,
    usuario_cedula: cuerpo.usuario_cedula || null,
    garantia_hasta: cuerpo.garantia_hasta || null,
    observaciones: cuerpo.observaciones || null,
    sistema_id: cuerpo.sistema_id || null,
  };

  const { data, error } = await supabaseAdmin
    .from("equipos")
    .insert([registro])
    .select()
    .single();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  await registrarMovimiento({
    equipo_id: data.id,
    placa,
    accion: "Creacion",
    detalle: `Equipo creado con estado ${data.estado}${data.sede ? ` · sede ${data.sede}` : ""}`,
    realizado_por: usuario.nombre_completo,
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

  const { data, error } = await supabaseAdmin
    .from("equipos")
    .update(cambios)
    .eq("id", id)
    .select()
    .single();
  if (error) throw Object.assign(new Error(error.message), { status: 502 });

  const detalle = Object.keys(cambios)
    .map((campo) => `${campo}: ${anterior[campo] ?? "—"} → ${data[campo] ?? "—"}`)
    .join(" · ")
    .slice(0, 900);

  await registrarMovimiento({
    equipo_id: id,
    placa: data.placa,
    accion: "Edicion",
    detalle,
    realizado_por: usuario.nombre_completo,
  });

  return enviarJson(res, 200, { ok: true, equipo: data });
}

async function historialEquipo(res, id) {
  const { data: equipo, error: errorEquipo } = await supabaseAdmin
    .from("equipos")
    .select("id, placa")
    .eq("id", id)
    .maybeSingle();
  if (errorEquipo) throw Object.assign(new Error(errorEquipo.message), { status: 502 });
  if (!equipo) throw fallo("No se encontró el equipo.", 404);

  const [movimientos, porEquipo, porPlaca] = await Promise.all([
    supabaseAdmin
      .from("historial_movimientos")
      .select("*")
      .eq("equipo_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("actas")
      .select("*")
      .eq("equipo_id", id)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("actas")
      .select("*")
      .eq("placa", equipo.placa)
      .order("created_at", { ascending: false }),
  ]);

  if (movimientos.error || porEquipo.error || porPlaca.error) {
    throw Object.assign(
      new Error(movimientos.error?.message || porEquipo.error?.message || porPlaca.error.message),
      { status: 502 }
    );
  }

  const actasMap = new Map();
  [...(porEquipo.data || []), ...(porPlaca.data || [])].forEach((acta) =>
    actasMap.set(acta.id, acta)
  );

  return enviarJson(res, 200, {
    ok: true,
    equipo,
    historial: movimientos.data || [],
    actas: [...actasMap.values()].sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    ),
  });
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
  const registros = renombrarEncabezados(filas)
    .map(mapearFila)
    .filter(Boolean);

  const totalLeidos = filas.length;
  let errores = totalLeidos - registros.length;
  let procesados = 0;

  for (let inicio = 0; inicio < registros.length; inicio += LOTE_EQUIPOS) {
    const lote = registros.slice(inicio, inicio + LOTE_EQUIPOS);
    const { data, error } = await supabaseAdmin
      .from("equipos")
      .upsert(lote, { onConflict: "placa" })
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
      detalle: `Importación masiva desde ${archivo.originalname}`,
      realizado_por: usuario.nombre_completo,
    }));
    if (eventos.length) {
      const { error: errorHistorial } = await supabaseAdmin
        .from("historial_movimientos")
        .insert(eventos);
      if (errorHistorial) console.warn("[IMPORTAR] Historial:", errorHistorial.message);
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
    detalle: `Acta CORP-TEC-FR-002 N.º ${acta.consecutivo} · ${colaborador} · ${sede} · ${nombre}`,
    realizado_por: usuario.nombre_completo,
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
   RESPALDO TOTAL (solo administradores TI)
   ------------------------------------------------------------ */

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
