/* ============================================================
   server.js | Acta de Tecnología - Levapan
   ------------------------------------------------------------
   Servidor HTTP nativo (sin Express) que:

   1) Sirve la interfaz (index.html, css, js, imágenes, video).
   2) Consulta el inventario SQLite por Placa.
   3) Recibe el PDF generado en el navegador, lo guarda en
      C:\Actas-Levapan\Actas_Guardadas\AAAA\MM-Mes\ y registra
      el acta + actualiza el responsable del equipo.
   4) Expone el historial de actas.
   ============================================================ */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buscarEquipo,
  buscarEquipos,
  buscarEquiposPorPrefijo,
  cerrarDB,
  estadisticas,
  historial,
  registrarActa,
} from "./server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = __dirname;

/* Credenciales locales (.env) para publicar la app en internet.
   Si ACTA_CLAVE queda vacía, el acceso queda abierto (uso en la oficina). */
try {
  process.loadEnvFile?.(path.join(RAIZ, ".env"));
} catch {
  /* Sin .env: se usan las variables de entorno del sistema. */
}

const CLAVE_ACCESO = String(process.env.ACTA_CLAVE || "").trim();

const PUERTO = Number(process.env.PORT || process.env.ACTA_PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PDF_DIR =
  process.env.ACTA_PDF_DIR || "C:\\Actas-Levapan\\Actas_Guardadas";

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

/** Rutas con datos o interfaz: requieren contraseña cuando está configurada. */
function esRutaProtegida(pathname) {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/data/")
  );
}

/** Autenticación básica con una sola contraseña (ACTA_CLAVE). */
function accesoAutorizado(req) {
  if (!CLAVE_ACCESO) return true;

  const cabecera = String(req.headers.authorization || "");
  const [esquema, valor] = cabecera.split(" ");
  if (!/^basic$/i.test(esquema || "") || !valor) return false;

  let credenciales = "";
  try {
    credenciales = Buffer.from(valor, "base64").toString("utf8");
  } catch {
    return false;
  }

  const separador = credenciales.indexOf(":");
  const clave = separador >= 0 ? credenciales.slice(separador + 1) : "";
  const recibida = Buffer.from(clave, "utf8");
  const esperada = Buffer.from(CLAVE_ACCESO, "utf8");

  return (
    recibida.length === esperada.length &&
    crypto.timingSafeEqual(recibida, esperada)
  );
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

function nombreUnico(carpeta, nombre) {
  const extension = path.extname(nombre);
  const base = path.basename(nombre, extension);
  let candidato = nombre;
  let numero = 2;

  while (fs.existsSync(path.join(carpeta, candidato))) {
    candidato = `${base}_${numero}${extension}`;
    numero += 1;
  }
  return candidato;
}

function rutaCarpetaFecha(fecha) {
  const anio = String(fecha.getFullYear());
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  return path.join(PDF_DIR, anio, `${mes}-${MESES[fecha.getMonth()]}`);
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
  "/manifest.webmanifest",
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

function datosServidor() {
  const estado = estadisticas();
  const ips = ipv4Locales();
  return {
    ok: true,
    servidor: "Acta de Tecnología Levapan",
    puerto: PUERTO,
    ips: ips.map((item) => item.ip),
    enlaceRed: ips.length ? `http://${ips[0].ip}:${PUERTO}` : `http://localhost:${PUERTO}`,
    totalEquipos: estado.totalEquipos,
    ultimaImportacion: estado.ultimaImportacion,
    dbPath: estado.dbPath,
    pdfDir: estado.pdfDir || PDF_DIR,
    fechaServidor: new Date().toISOString(),
  };
}

async function manejarApi(req, res, url) {
  const ruta = url.pathname;

  if (ruta === "/api/estado" && req.method === "GET") {
    return enviarJson(res, 200, datosServidor());
  }

  if (ruta === "/api/equipos/buscar" && req.method === "GET") {
    const consulta = (url.searchParams.get("q") || "").trim();
    const { equipos, modo } = buscarEquiposPorPrefijo(consulta);
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
      const equipo = buscarEquipo(placa);
      if (!equipo) {
        return enviarJson(res, 404, {
          ok: false,
          encontrado: false,
          error: "La placa no está registrada en el inventario.",
        });
      }
      return enviarJson(res, 200, { ok: true, encontrado: true, equipo });
    }

    const consulta = url.searchParams.get("q") || "";
    const limite = url.searchParams.get("limite") || 20;
    const equipos = buscarEquipos(consulta, limite);
    return enviarJson(res, 200, {
      ok: true,
      total: equipos.length,
      equipos,
    });
  }

  if (ruta === "/api/historial" && req.method === "GET") {
    const placa = url.searchParams.get("placa") || "";
    const limite = url.searchParams.get("limite") || 50;
    return enviarJson(res, 200, {
      ok: true,
      actas: historial(placa, limite),
    });
  }

  if (ruta === "/api/actas" && req.method === "POST") {
    const cuerpo = await leerJson(req);
    const datos = cuerpo.datos || {};
    const placa = String(datos.placa ?? "").trim();

    if (!placa) {
      return enviarJson(res, 400, {
        ok: false,
        error: "La placa del equipo es obligatoria.",
      });
    }

    const base64 = String(cuerpo.pdfBase64 || "").split(",").pop() || "";
    let bytes;
    try {
      bytes = Buffer.from(base64, "base64");
    } catch {
      bytes = Buffer.alloc(0);
    }
    if (bytes.length < 200) {
      return enviarJson(res, 400, {
        ok: false,
        error: "El PDF recibido está vacío o dañado.",
      });
    }

    const ahora = new Date();
    const carpeta = rutaCarpetaFecha(ahora);
    await fsp.mkdir(carpeta, { recursive: true });

    let nombre = sanitizarNombreArchivo(
      cuerpo.archivo || `ACTA_${placa}.pdf`,
      `ACTA_${placa}.pdf`
    );
    if (!/\.pdf$/i.test(nombre)) nombre += ".pdf";
    nombre = nombreUnico(carpeta, nombre);

    const rutaPdf = path.join(carpeta, nombre);
    await fsp.writeFile(rutaPdf, bytes);

    let registro;
    try {
      registro = registrarActa(datos, nombre, rutaPdf);
    } catch (err) {
      await fsp.rm(rutaPdf, { force: true });
      throw err;
    }

    console.log(
      `[ACTA] ${ahora.toISOString()} | ${placa} | ${datos.tipoActa || "Asignación"} | ${nombre}`
    );

    return enviarJson(res, 201, {
      ok: true,
      archivo: nombre,
      ruta: rutaPdf,
      carpeta,
      historialId: registro.id,
      estadoEquipo: registro.estado,
      equipo: buscarEquipo(placa),
    });
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
    if (CLAVE_ACCESO && esRutaProtegida(url.pathname) && !accesoAutorizado(req)) {
      res.writeHead(401, {
        "WWW-Authenticate": 'Basic realm="Acta de Tecnologia Levapan", charset="UTF-8"',
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(
        "Acceso restringido. Ingresa la contraseña de Acta de Tecnología Levapan."
      );
    }

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

/** Primer arranque en un equipo nuevo: importa el ODS si la base está vacía. */
function asegurarInventarioInicial() {
  if (estadisticas().totalEquipos > 0) return;

  const fuente = path.join(RAIZ, "data", "inventario.ods");
  if (!fs.existsSync(fuente)) return;

  console.log("La base está vacía. Importando el inventario inicial...");
  try {
    execFileSync(
      process.execPath,
      [path.join(RAIZ, "tools", "importar-inventario.js"), fuente],
      { cwd: RAIZ, stdio: "inherit" }
    );
  } catch (err) {
    console.error("No se pudo importar el inventario inicial:", err.message);
  }
}

asegurarInventarioInicial();

servidor.listen(PUERTO, HOST, () => {
  const estado = estadisticas();
  const ips = ipv4Locales();
  const linea = "=".repeat(58);

  console.log(`\n${linea}`);
  console.log("  ACTA DE TECNOLOGÍA · LEVAPAN");
  console.log(linea);
  console.log(`  Equipos en inventario : ${estado.totalEquipos}`);
  console.log(`  Base de datos         : ${estado.dbPath}`);
  console.log(`  Carpeta de actas      : ${PDF_DIR}`);
  console.log(
    `  Acceso                : ${
      CLAVE_ACCESO ? "protegido con contrasena" : "sin contrasena (red local)"
    }`
  );
  console.log(linea);
  console.log("  Abre la aplicación en:");
  console.log(`    http://localhost:${PUERTO}`);
  if (ips.length) {
    console.log("\n  Comparte este enlace con la oficina:");
    ips.forEach((item) => console.log(`    http://${item.ip}:${PUERTO}`));
  } else {
    console.log("\n  No se detectó una red local activa.");
  }
  console.log(linea);
  console.log("  Deja esta ventana abierta. Ctrl+C para detener.");
  console.log(`${linea}\n`);
});

function detener(senal) {
  console.log(`\nCerrando servidor (${senal})...`);
  servidor.close(() => {
    cerrarDB();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => detener("SIGINT"));
process.on("SIGTERM", () => detener("SIGTERM"));
