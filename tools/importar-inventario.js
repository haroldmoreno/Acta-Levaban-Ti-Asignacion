import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import {
  db,
  estadisticas,
  registrarImportacion,
  upsertEquipo,
} from "../server/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(__dirname, "..");

function resolverRuta(argumento) {
  if (argumento) return path.resolve(process.cwd(), argumento);
  const ods = path.join(raiz, "data", "inventario.ods");
  if (fs.existsSync(ods)) return ods;
  return path.join(raiz, "data", "inventario.json");
}

async function leerRegistros(ruta) {
  const extension = path.extname(ruta).toLowerCase();

  if (!fs.existsSync(ruta)) {
    throw new Error(`No existe el archivo: ${ruta}`);
  }

  if (extension === ".json") {
    const contenido = JSON.parse(fs.readFileSync(ruta, "utf8"));
    return Array.isArray(contenido) ? contenido : contenido.datos || [];
  }

  if (![".ods", ".xlsx", ".xls", ".csv"].includes(extension)) {
    throw new Error(
      `Formato no soportado (${extension}). Usa .ods, .xlsx, .xls, .csv o .json.`
    );
  }

  const libro = XLSX.readFile(ruta, { cellDates: false });
  const nombreHoja = libro.SheetNames[0];
  const hoja = libro.Sheets[nombreHoja];
  const filas = XLSX.utils.sheet_to_json(hoja, {
    defval: "",
    raw: false,
  });

  console.log(`Hoja leída: ${nombreHoja} (${filas.length} filas)`);
  if (filas[0]) {
    console.log("Encabezados detectados:", Object.keys(filas[0]).join(" | "));
  }
  return filas;
}

async function main() {
  const ruta = resolverRuta(process.argv[2]);
  console.log("Importando inventario desde:", ruta);

  const registros = await leerRegistros(ruta);
  if (!registros.length) {
    throw new Error("El archivo no contiene filas para importar.");
  }

  let insertados = 0;
  let actualizados = 0;
  let omitidos = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const fila of registros) {
      const resultado = upsertEquipo(fila);
      if (resultado.omitido) omitidos += 1;
      else if (resultado.insertado) insertados += 1;
      else actualizados += 1;
    }

    registrarImportacion(ruta, registros.length, insertados, actualizados);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const estado = estadisticas();
  console.log("----------------------------------------------");
  console.log(`Importación completada: ${registros.length} filas`);
  console.log(`  Nuevos:       ${insertados}`);
  console.log(`  Actualizados: ${actualizados}`);
  console.log(`  Omitidos:     ${omitidos}`);
  console.log(`  Total en SQL: ${estado.totalEquipos}`);
  console.log(`  Base:         ${estado.dbPath}`);
  console.log("----------------------------------------------");
}

main().catch((err) => {
  console.error("ERROR al importar el inventario:", err.message);
  process.exitCode = 1;
});
