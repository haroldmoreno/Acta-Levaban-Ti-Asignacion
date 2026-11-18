/* ============================================================
   server.js | Acta de Tecnología - Levapan
   ------------------------------------------------------------
   Servidor HTTP nativo (sin Express) que:

   1) Sirve la interfaz (index.html, css, js, imágenes, video).
   2) Consulta el inventario de la Lista de SharePoint por Placa
      usando Microsoft Graph (Client Credentials + msal-node).
   3) Genera el PDF oficial CORP-TEC-FR-002 con pdf-lib, lo sube a la
      carpeta compartida de SharePoint (NubeLevapan) con Microsoft
      Graph y, en Windows, además deja una copia en
      C:\Actas-Levapan\Actas_Guardadas\. En la nube (Linux) no hay disco
      persistente: solo se usa os.tmpdir() mientras dura la subida.
      Power Automate queda como respaldo opcional.
   4) Expone el estado del servicio y la búsqueda de equipos.

   Usa Microsoft Graph para el inventario y para archivar las actas.
   ============================================================ */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import axios from "axios";

// Debe importarse antes que graph.js: carga el archivo .env.
import "./server/config.js";
import {
  buscarEquipoGraph,
  buscarEquiposGraph,
  configGraph,
  contarEquiposGraph,
  listarEquiposGraph,
  normalizarTipo,
  normalizarMarca,
  subirActaCarpetaCompartida,
  verificarDestinoActas,
} from "./server/graph.js";
import { generarActaPdf } from "./server/acta-pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = __dirname;

/* Render y Azure App Service inyectan el puerto en process.env.PORT. */
const PORT = process.env.PORT || 3000;
const PUERTO = Number(PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const HTTP_WEBHOOK_URL = () => String(process.env.HTTP_WEBHOOK_URL || "").trim();

/* En Linux (Render / Azure) no existen C:\Actas-Levapan ni disco persistente. */
const ES_NUBE =
  process.platform !== "win32" || process.env.CLOUD_MODE === "true";

/** Ruta lógica dentro de SharePoint: 2026/11-Noviembre */
const CARPETA_ACTAS = String(process.env.ACTA_CARPETA_BASE || "").trim();

/**
 * Copia del PDF en disco:
 *  - Windows local: C:\Actas-Levapan\Actas_Guardadas (copia obligatoria).
 *  - Nube (Linux o CLOUD_MODE=true): os.tmpdir(), solo temporal.
 */
const DIR_ACTAS_LOCAL = ES_NUBE
  ? path.join(os.tmpdir(), "acta-levapan")
  : path.resolve(
      String(process.env.ACTA_DIR_LOCAL || "").trim() ||
        path.join(RAIZ, "..", "Actas_Guardadas")
    );

/** Tamaño máximo del cuerpo: el PDF puede incluir fotos del equipo. */
const LIMITE_CUERPO = 40 * 1024 * 1024;

const MESES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

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

/** Deja un nombre de archivo seguro conservando tildes y espacios simples. */
function sanitizarNombreArchivo(texto, respaldo = "ACTA.pdf") {
  const limpio = String(texto ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\r\n\t]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();
  return limpio || respaldo;
}

/** Carpeta lógica del acta dentro de SharePoint: "2026/11-Noviembre". */
function carpetaFecha(fecha) {
  const anio = String(fecha.getFullYear());
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const relativa = `${anio}/${mes}-${MESES[fecha.getMonth()]}`;
  return CARPETA_ACTAS ? `${CARPETA_ACTAS}/${relativa}` : relativa;
}

/** Evita sobrescribir actas del mismo equipo el mismo día. */
function nombreConSello(nombre, fecha, copia = 0) {
  const extension = path.extname(nombre);
  const base = path.basename(nombre, extension);
  if (copia === 0 && /_\d{8}-\d{6}$/.test(base)) return nombre;

  const sello = [
    String(fecha.getFullYear()),
    String(fecha.getMonth() + 1).padStart(2, "0"),
    String(fecha.getDate()).padStart(2, "0"),
    "-",
    String(fecha.getHours()).padStart(2, "0"),
    String(fecha.getMinutes()).padStart(2, "0"),
    String(fecha.getSeconds()).padStart(2, "0"),
  ].join("");

  const sufijo = copia > 0 ? `-${copia}` : "";
  return `${base}_${sello}${sufijo}${extension || ".pdf"}`;
}

/** true solo si HTTP_WEBHOOK_URL es una URL http(s) real (no el placeholder). */
function webhookConfigurado() {
  const url = HTTP_WEBHOOK_URL();
  if (!url || !/^https?:\/\//i.test(url)) return false;
  return !/tu-url-de-webhook|tu-url|cambia-esta-url|example\.com/i.test(url);
}

/**
 * Guarda el PDF en DIR_ACTAS_LOCAL (sin subcarpetas y sin archivos
 * adicionales). En Windows es la copia definitiva en
 * C:\Actas-Levapan\Actas_Guardadas; en la nube es un temporal en
 * os.tmpdir() que se borra después de subirlo a SharePoint. Si el nombre ya
 * existe añade un sello para no perder actas anteriores.
 */
function guardarPdfLocal(bytes, nombre, fecha) {
  fs.mkdirSync(DIR_ACTAS_LOCAL, { recursive: true });

  let destino = path.join(DIR_ACTAS_LOCAL, nombre);
  if (fs.existsSync(destino)) {
    destino = path.join(DIR_ACTAS_LOCAL, nombreConSello(nombre, fecha));
    let copia = 1;
    while (fs.existsSync(destino)) {
      destino = path.join(DIR_ACTAS_LOCAL, nombreConSello(nombre, fecha, copia));
      copia += 1;
      if (copia > 20) break;
    }
  }

  fs.writeFileSync(destino, bytes);
  return { destino, directorio: DIR_ACTAS_LOCAL };
}

/**
 * Nombre consistente con la carpeta de SharePoint:
 * "<Serial_o_Placa>_<Nombre_Usuario>_<tipo_acta>.pdf".
 * Se quitan tildes y caracteres no admitidos por SharePoint.
 */
function nombreActaCompartida(datos = {}) {
  const limpiar = (valor, respaldo) => {
    const texto = String(valor ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return (
      sanitizarNombreArchivo(texto, respaldo).replace(/[#%&{}$!'@+`=]/g, "") ||
      respaldo
    );
  };

  const equipo =
    limpiar(datos.serial, "") || limpiar(datos.placa, "") || "EQUIPO";
  const usuario = limpiar(datos.nombre, "") || "SIN_USUARIO";
  const tipo = limpiar(datos.tipoActa, "") || "Asignacion";

  return `${equipo}_${usuario}_${tipo}.pdf`;
}

/** "Asignación" → false · "Devolución" → true (sin distinguir tildes). */
function esDevolucion(tipoActa) {
  return String(tipoActa ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase() === "devolucion";
}

/** Equipo actualizado a partir de los datos del acta (sin consultar Graph). */
function equipoDesdeActa(datos, estado, fecha) {
  const usuario = esDevolucion(datos.tipoActa)
    ? ""
    : String(datos.nombre ?? "").trim();
  const cedula = esDevolucion(datos.tipoActa)
    ? ""
    : String(datos.documento ?? "").trim();

  return {
    placa: String(datos.placa ?? "").trim(),
    serial: String(datos.serial ?? "").trim(),
    tipo: normalizarTipo(datos.tipo),
    marca: normalizarMarca(datos.marca),
    modelo: String(datos.modelo ?? "").trim(),
    estado,
    usuario_actual: usuario,
    cedula_usuario: cedula,
    accesorios: String(datos.accesorios ?? "").trim(),
    software: String(datos.software ?? "").trim(),
    procesador: String(datos.procesador ?? "").trim(),
    ram: String(datos.ram ?? "").trim(),
    disco: String(datos.disco ?? "").trim(),
    hostname: String(datos.hostname ?? "").trim(),
    observaciones: String(datos.observaciones ?? "").trim(),
    fecha_actualizacion: fecha.toISOString(),
    nombreusuario: usuario,
    cedula,
  };
}

function ipv4Locales() {
  const resultados = [];
  const interfaces = os.networkInterfaces();

  for (const [nombre, direcciones] of Object.entries(interfaces)) {
    for (const direccion of direcciones || []) {
      if (direccion.family !== "IPv4" || direccion.internal) continue;
      resultados.push({ interfaz: nombre, ip: direccion.address });
    }
  }

  const prioridad = (ip) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;

  return resultados.sort((a, b) => prioridad(a.ip) - prioridad(b.ip));
}

/* ------------------------------------------------------------
   Archivos estáticos
   ------------------------------------------------------------ */

/* Solo se publican los archivos de la interfaz. El inventario fuente,
   el código del servidor y la carpeta .git quedan fuera del alcance web. */
const ARCHIVOS_PUBLICOS = new Set([
  "/index.html",
  "/manifest.json",
  "/sw.js",
  "/data/inventario.json",
]);
const CARPETAS_PUBLICAS = ["/css/", "/js/", "/images/", "/icons/", "/media/"];

async function servirEstatico(req, res, rutaUrl) {
  let relativa;
  try {
    // Se normaliza antes de validar para impedir rutas como /js/../server/db.js
    relativa = path.posix.normalize(
      decodeURIComponent(rutaUrl.pathname).replace(/\\/g, "/")
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

  // Soporte de rangos para el video de fondo.
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
   API
   ------------------------------------------------------------ */

async function manejarEstado(res) {
  const config = configGraph();
  const ips = ipv4Locales();

  const base = {
    ok: true,
    servidor: "Acta de Tecnología Levapan",
    puerto: PUERTO,
    ips: ips.map((item) => item.ip),
    enlaceRed: ips.length
      ? `http://${ips[0].ip}:${PUERTO}`
      : `http://localhost:${PUERTO}`,
    totalEquipos: 0,
    ultimaImportacion: null,
    dbPath: null,
    pdfDir: ES_NUBE
      ? "SharePoint (carpeta compartida NubeLevapan) · sin copia local en la nube"
      : "SharePoint (carpeta compartida NubeLevapan) + respaldo local Actas_Guardadas",
    modoNube: ES_NUBE,
    fechaServidor: new Date().toISOString(),
    graph: {
      configurado: config.configurado,
      sitio: config.siteId || null,
      lista: config.listId || null,
    },
  };

  if (!config.configurado) {
    return enviarJson(res, 503, {
      ...base,
      ok: false,
      error:
        "Microsoft Graph no está configurado. Faltan las variables: " +
        `${config.faltantes.join(", ")}.`,
    });
  }

  try {
    base.totalEquipos = await contarEquiposGraph();
  } catch (err) {
    console.error("[GRAPH] No se pudo leer el inventario:", err.message);
    return enviarJson(res, 503, {
      ...base,
      ok: false,
      error: `No se pudo consultar el inventario en SharePoint: ${err.message}`,
    });
  }

  return enviarJson(res, 200, base);
}

/* ------------------------------------------------------------
   Entrega del PDF a Power Automate
   ------------------------------------------------------------ */

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const httpAutomate = axios.create({
  timeout: 60000,
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  headers: { "Content-Type": "application/json" },
});

function esErrorReintentable(estado) {
  return !estado || estado === 408 || estado === 429 || estado >= 500;
}

function describirRespuesta(datos, respaldo) {
  if (!datos) return respaldo;
  if (typeof datos === "string") return datos.slice(0, 300);
  try {
    return JSON.stringify(datos).slice(0, 300);
  } catch {
    return respaldo;
  }
}

/**
 * Envía el PDF en base64 al flujo de Power Automate, que lo guarda en
 * SharePoint. Reintenta ante cortes de red, 429 y errores 5xx.
 */
async function enviarActaAPowerAutomate({ nombre, carpeta, datos, base64 }) {
  const url = HTTP_WEBHOOK_URL();
  if (!url) {
    throw Object.assign(
      new Error(
        "HTTP_WEBHOOK_URL no está configurada. Define la URL del flujo de Power Automate en el archivo .env."
      ),
      { status: 503 }
    );
  }

  const cuerpo = {
    origen: "acta-levapan",
    nombreArchivo: nombre,
    archivoBase64: base64,
    contentType: "application/pdf",
    carpeta,
    placa: String(datos.placa ?? "").trim(),
    tipoActa: String(datos.tipoActa || "Asignación").trim(),
    fecha: String(datos.fecha || new Date().toISOString()),
    colaborador: String(datos.nombre ?? "").trim(),
    documento: String(datos.documento ?? "").trim(),
    agenteTi: String(datos.agenteTi ?? "").trim(),
    documentoTi: String(datos.documentoTi ?? "").trim(),
    equipo: {
      tipo: String(datos.tipo ?? "").trim(),
      marca: String(datos.marca ?? "").trim(),
      modelo: String(datos.modelo ?? "").trim(),
      serial: String(datos.serial ?? "").trim(),
    },
    observaciones: String(datos.observaciones ?? "").trim(),
  };

  let ultimoError = null;

  for (let intento = 1; intento <= 3; intento += 1) {
    try {
      const respuesta = await httpAutomate.post(url, cuerpo);
      return { estado: respuesta.status, cuerpo: respuesta.data };
    } catch (err) {
      ultimoError = err;
      const estado = err?.response?.status;
      if (!esErrorReintentable(estado) || intento === 3) break;

      const espera =
        Number(err?.response?.headers?.["retry-after"]) * 1000 ||
        500 * 2 ** (intento - 1);
      await esperar(Math.min(espera, 5000));
    }
  }

  const estado = ultimoError?.response?.status;
  const detalle = describirRespuesta(
    ultimoError?.response?.data,
    ultimoError?.message || "sin detalle"
  );

  throw Object.assign(
    new Error(
      `Power Automate no recibió el acta${
        estado ? ` (HTTP ${estado})` : ""
      }: ${detalle}`
    ),
    { status: 502 }
  );
}

/**
 * Guarda un acta: genera el PDF oficial con pdf-lib a partir de template.pdf
 * (o acepta un PDF ya generado por un cliente antiguo), lo escribe SIEMPRE en
 * C:\Actas-Levapan\Actas_Guardadas\<archivo>.pdf y lo sube a la carpeta
 * compartida exacta de SharePoint (NubeLevapan). Si SharePoint rechaza la
 * escritura por permisos (403), Power Automate queda como respaldo opcional.
 */
async function manejarGuardarActa(req, res) {
  const cuerpo = await leerJson(req);
  const datos = cuerpo.datos || {};
  const placa = String(datos.placa ?? "").trim();

  if (!placa) {
    return enviarJson(res, 400, {
      ok: false,
      error: "La placa del equipo es obligatoria.",
    });
  }

  let bytes;
  let generadoEnServidor = false;

  if (cuerpo.pdfBase64) {
    /* Compatibilidad con clientes anteriores que enviaban el PDF armado. */
    const base64 = String(cuerpo.pdfBase64 || "").split(",").pop() || "";
    bytes = Buffer.from(base64, "base64");
  } else {
    generadoEnServidor = true;
    try {
      const pdf = await generarActaPdf({
        datos,
        fotos: cuerpo.fotos || {},
        firmas: cuerpo.firmas || datos.firmas || {},
        plantilla: path.join(RAIZ, "template.pdf"),
      });
      bytes = Buffer.from(pdf);
    } catch (err) {
      console.error("[ACTA PDF] Error al generar el formato oficial:", err);
      throw Object.assign(
        new Error(
          `No se pudo generar el PDF oficial: ${err?.message || "error desconocido"}`
        ),
        { status: 500 }
      );
    }
  }

  if (!bytes || bytes.length < 200) {
    return enviarJson(res, 400, {
      ok: false,
      error: "El PDF generado está vacío o dañado.",
    });
  }

  const ahora = new Date();
  const carpeta = carpetaFecha(ahora);

  /* Nombre uniforme en la copia local y en SharePoint. */
  const nombre = nombreActaCompartida(datos);

  /* 1) Copia local obligatoria: no depende de la red. */
  let local = null;
  let avisoLocal = "";
  try {
    local = guardarPdfLocal(bytes, nombre, ahora);
    console.log(`[ACTA LOCAL] ${local.destino}`);
  } catch (err) {
    avisoLocal = `No se pudo guardar la copia local: ${err.message}`;
    console.error("[ACTA LOCAL]", avisoLocal);
  }

  /* 2) Carpeta compartida exacta de SharePoint (enlace /:f:/ de NubeLevapan). */
  const sharepoint = await subirActaCarpetaCompartida({
    nombreArchivo: nombre,
    pdfBuffer: bytes,
  });

  if (sharepoint.ok) {
    console.log(`[ACTA SHAREPOINT] ${sharepoint.webUrl || sharepoint.name}`);
  } else {
    console.warn(
      `[ACTA] SharePoint rechazó el acta (HTTP ${sharepoint.status}): ${sharepoint.error}`
    );
  }

  /* En la nube el disco es temporal: SharePoint es el almacenamiento real,
     así que la copia de os.tmpdir() se elimina en cuanto se intenta subir. */
  if (ES_NUBE && local?.destino) {
    try {
      fs.unlinkSync(local.destino);
      console.log(`[ACTA NUBE] Temporal eliminado: ${local.destino}`);
    } catch (err) {
      console.warn(
        `[ACTA NUBE] No se pudo eliminar el temporal: ${err.message}`
      );
    } finally {
      local = null;
    }
  }

  /* 3) Respaldo: Power Automate solo si SharePoint falló por permisos (403). */
  const enviarFlujo = webhookConfigurado();
  const respaldoWebhook =
    sharepoint.ok === false && sharepoint.status === 403 && enviarFlujo;

  let envio = null;
  let errorWebhook = "";

  if (respaldoWebhook) {
    try {
      envio = await enviarActaAPowerAutomate({
        nombre,
        carpeta,
        datos,
        base64: bytes.toString("base64"),
      });
    } catch (err) {
      errorWebhook = err?.message || "error desconocido";
      console.warn("[ACTA] Power Automate no recibió el acta:", errorWebhook);
    }
  }

  const estadoEquipo = esDevolucion(datos.tipoActa) ? "Disponible" : "Asignado";
  const equipo = equipoDesdeActa(datos, estadoEquipo, ahora);

  const respuestaFlujo =
    envio?.cuerpo && typeof envio.cuerpo === "object" ? envio.cuerpo : {};

  const enlaceDirecto =
    typeof envio?.cuerpo === "string" && /^https?:\/\//i.test(envio.cuerpo.trim())
      ? envio.cuerpo.trim()
      : "";

  const rutaRespaldo = String(
    enlaceDirecto ||
      respuestaFlujo.webUrl ||
      respuestaFlujo.ruta ||
      respuestaFlujo.url ||
      respuestaFlujo.link ||
      ""
  ).trim();

  const ruta =
    (sharepoint.ok ? sharepoint.webUrl : "") ||
    rutaRespaldo ||
    local?.destino ||
    nombre;

  console.log(
    `[ACTA] ${ahora.toISOString()} | ${placa} | ${
      datos.tipoActa || "Asignación"
    } | ${nombre} | local: ${local?.destino || "ERROR"} | SharePoint: ${
      sharepoint.ok ? sharepoint.webUrl || "subido" : `falló (HTTP ${sharepoint.status})`
    } | Power Automate: ${
      respaldoWebhook ? (envio ? `HTTP ${envio.estado}` : "falló") : "omitido"
    }`
  );

  return enviarJson(res, 201, {
    ok: true,
    archivo: nombre,
    ruta,
    rutaLocal: local?.destino || null,
    sharepoint,
    webUrl: sharepoint.ok ? sharepoint.webUrl || null : null,
    pdfBase64: bytes.toString("base64"),
    generadoEnServidor,
    historialId: null,
    estadoEquipo,
    equipo,
    guardadoLocal: Boolean(local),
    avisoLocal: avisoLocal || undefined,
    modoNube: ES_NUBE,
    almacenamiento: ES_NUBE
      ? "SharePoint (Nube Levapan)"
      : "Copia local + SharePoint (Nube Levapan)",
    powerAutomate: {
      configurado: enviarFlujo,
      usadoComoRespaldo: respaldoWebhook,
      estado: envio?.estado ?? null,
      recibido: Boolean(envio),
      error: errorWebhook || undefined,
    },
  });
}

async function manejarApi(req, res, url) {
  const ruta = url.pathname;

  if (ruta === "/api/estado" && req.method === "GET") {
    return await manejarEstado(res);
  }

  if (ruta === "/api/equipos/buscar" && req.method === "GET") {
    // Búsqueda en vivo contra Microsoft Graph: nunca se sirve de caché.
    // Se normalizan los espacios para que "ML- 217050" encuentre "ML-217050".
    const consulta = (url.searchParams.get("q") || "")
      .trim()
      .replace(/\s+/g, " ");
    const { equipos, modo } = await buscarEquiposGraph(consulta);
    return enviarJson(res, 200, {
      ok: true,
      q: consulta,
      modo,
      total: equipos.length,
      equipos,
    });
  }

  if (ruta === "/api/equipos" && req.method === "GET") {
    const placa = url.searchParams.get("placa");
    if (placa) {
      const equipo = await buscarEquipoGraph(placa);
      if (!equipo) {
        return enviarJson(res, 404, {
          ok: false,
          encontrado: false,
          error: "La placa no está registrada en el inventario.",
        });
      }
      return enviarJson(res, 200, { ok: true, encontrado: true, equipo });
    }

    const consulta = (url.searchParams.get("q") || "")
      .trim()
      .replace(/\s+/g, " ");
    const limite = url.searchParams.get("limite") || 20;
    const equipos = consulta
      ? (await buscarEquiposGraph(consulta)).equipos
      : await listarEquiposGraph(limite);

    return enviarJson(res, 200, {
      ok: true,
      total: equipos.length,
      equipos,
    });
  }

  if (ruta === "/api/historial" && req.method === "GET") {
    /* El historial ya no vive en el servidor: Power Automate lo registra
       en SharePoint. Se responde de forma explícita para no simular datos. */
    return enviarJson(res, 501, {
      ok: false,
      actas: [],
      error:
        "El historial de actas ahora se consulta en la Lista de SharePoint. " +
        "Este servidor ya no mantiene una base de datos local.",
    });
  }

  if (ruta === "/api/actas/destino" && req.method === "GET") {
    // Diagnóstico: siteId de NubeLevapan, driveId de DATAFILE y carpeta de actas.
    try {
      const destino = await verificarDestinoActas();
      return enviarJson(res, 200, { ok: true, ...destino });
    } catch (err) {
      console.error("[SHAREPOINT] No se pudo verificar el destino:", err.message);
      return enviarJson(res, err.status || 502, {
        ok: false,
        error: err.message || "No se pudo verificar el destino de actas.",
      });
    }
  }

  if (
    (ruta === "/api/guardar-acta" ||
      ruta === "/api/actas" ||
      ruta === "/api/actas/guardar") &&
    req.method === "POST"
  ) {
    return manejarGuardarActa(req, res);
  }

  return enviarJson(res, 404, {
    ok: false,
    error: `Ruta no encontrada: ${req.method} ${ruta}`,
  });
}

/* ------------------------------------------------------------
   Servidor
   ------------------------------------------------------------ */

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      return await manejarApi(req, res, url);
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      return enviarJson(res, 405, { ok: false, error: "Método no permitido." });
    }

    return await servirEstatico(req, res, url);
  } catch (err) {
    const estado = Number(err?.status) || 500;
    console.error(`[ERROR] ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) {
      enviarJson(res, estado, {
        ok: false,
        error: err?.message || "Error interno del servidor.",
      });
    } else {
      res.end();
    }
  }
});

servidor.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nNo se pudo iniciar: el puerto ${PUERTO} ya está en uso.\n` +
        "Cierra la otra ventana del servidor o define otro puerto con: set PORT=3001\n"
    );
  } else {
    console.error("Error del servidor:", err);
  }
  process.exitCode = 1;
});

servidor.listen(PORT, HOST, () => {
  const config = configGraph();
  const webhook = Boolean(HTTP_WEBHOOK_URL());
  const ips = ipv4Locales();
  const linea = "=".repeat(58);

  console.log(`\n${linea}`);
  console.log("  ACTA DE TECNOLOGÍA · LEVAPAN");
  console.log(linea);
  console.log("  Arquitectura          : Microsoft 365 (Graph + Power Automate)");
  console.log(
    `  Inventario SharePoint : ${
      config.configurado
        ? `lista "${config.listId}"`
        : "NO CONFIGURADO"
    }`
  );
  console.log(
    `  Power Automate        : ${webhook ? "configurado" : "NO CONFIGURADO"}`
  );
  console.log("  Acceso                : público (sin contraseña)");
  console.log(linea);
  console.log("  Abre la aplicación en:");
  console.log(`    http://localhost:${PUERTO}`);
  if (ips.length) {
    console.log("\n  Comparte este enlace con la oficina:");
    ips.forEach((item) => console.log(`    http://${item.ip}:${PUERTO}`));
  } else {
    console.log("\n  No se detectó una red local activa.");
  }

  if (!config.configurado) {
    console.log(linea);
    console.log(
      `  [!] Microsoft Graph sin configurar. Faltan: ${config.faltantes.join(", ")}`
    );
    console.log("      Revisa .env.example y define las credenciales.");
  }
  if (!webhook) {
    console.log(linea);
    console.log("  [!] HTTP_WEBHOOK_URL no está configurada.");
    console.log("      Las actas no podrán guardarse hasta definirla.");
  }

  console.log(linea);
  console.log("  Deja esta ventana abierta. Ctrl+C para detener.");
  console.log(`${linea}\n`);
});

function detener(senal) {
  console.log(`\nCerrando servidor (${senal})...`);
  servidor.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => detener("SIGINT"));
process.on("SIGTERM", () => detener("SIGTERM"));
