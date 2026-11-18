/* ============================================================
   config.js | Carga de variables de entorno
   ------------------------------------------------------------
   Lee el archivo .env de la raíz del proyecto sin depender de
   dotenv. Se importa como efecto secundario al inicio de
   server.js, antes de que cualquier módulo consulte process.env.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVO_ENV = path.join(RAIZ, ".env");

/** Parser mínimo para Node sin `process.loadEnvFile` (Node < 20.12). */
function cargarManual(archivo) {
  const contenido = fs.readFileSync(archivo, "utf8");

  for (const linea of contenido.split(/\r?\n/)) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith("#")) continue;

    const separador = limpia.indexOf("=");
    if (separador <= 0) continue;

    const clave = limpia.slice(0, separador).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(clave)) continue;

    // Las variables ya definidas en el sistema tienen prioridad.
    if (process.env[clave] !== undefined) continue;

    let valor = limpia.slice(separador + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    process.env[clave] = valor;
  }
}

try {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(ARCHIVO_ENV);
  } else if (fs.existsSync(ARCHIVO_ENV)) {
    cargarManual(ARCHIVO_ENV);
  }
} catch (err) {
  // ENOENT es normal: el proyecto puede configurarse solo con variables
  // de entorno del sistema (por ejemplo, en un servidor corporativo).
  if (err?.code !== "ENOENT") {
    console.warn(`[CONFIG] No se pudo leer ${ARCHIVO_ENV}: ${err.message}`);
  }
}

export const RUTA_RAIZ = RAIZ;
export const RUTA_ENV = ARCHIVO_ENV;

/** Devuelve una variable de entorno limpia (sin espacios sobrantes). */
export function variable(nombre, respaldo = "") {
  const valor = process.env[nombre];
  return String(valor ?? respaldo).trim();
}
