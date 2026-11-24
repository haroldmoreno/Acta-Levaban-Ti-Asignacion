/* ============================================================
   migrar-inventario.js | Migración inicial Excel/ODS/CSV → Supabase
   ------------------------------------------------------------
   Uso:
     node scripts/migrar-inventario.js [ruta/opcional/inventario.xlsx]

   Sin argumento busca automáticamente el archivo de inventario en
   el proyecto (.xlsx, .xls, .ods, .csv) y como último recurso usa
   data/inventario.json. Hace upsert por placa en lotes de 200 y
   deja constancia en historial_movimientos.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

import { supabaseAdmin, configSupabase } from "../server/supabase.js";
import {
  LOTE_EQUIPOS,
  mapearFila,
  renombrarEncabezados,
} from "../server/normalizar.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, "..");
const EXTENSIONES = [".xlsx", ".xls", ".ods", ".csv", ".json"];

/* ------------------------------------------------------------
   Localización automática del archivo
   ------------------------------------------------------------ */

function candidatosEn(directorio, profundidad = 0) {
  if (profundidad > 3) return [];
  let entradas = [];
  try {
    entradas = fs.readdirSync(directorio, { withFileTypes: true });
  } catch {
    return [];
  }

  const salida = [];
  for (const entrada of entradas) {
    if (
      entrada.name.startsWith(".") ||
      entrada.name === "node_modules" ||
      entrada.name === "Actas_Guardadas"
    ) {
      continue;
    }
    const completa = path.join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      salida.push(...candidatosEn(completa, profundidad + 1));
    } else if (EXTENSIONES.includes(path.extname(entrada.name).toLowerCase())) {
      salida.push(completa);
    }
  }
  return salida;
}

function resolverRuta(argumento) {
  if (argumento) {
    const ruta = path.resolve(process.cwd(), argumento);
    if (!fs.existsSync(ruta)) throw new Error(`No existe el archivo: ${ruta}`);
    return ruta;
  }

  const archivos = candidatosEn(RAIZ);
  const preferidos = archivos.filter((archivo) =>
    /inventario|equipo|activo|activos/i.test(path.basename(archivo))
  );
  const lista = preferidos.length ? preferidos : archivos;

  const hoja = lista.find((archivo) => !archivo.endsWith(".json"));
  if (hoja) return hoja;

  const json = path.join(RAIZ, "data", "inventario.json");
  if (fs.existsSync(json)) return json;
  if (lista.length) return lista[0];

  throw new Error(
    "No se encontró ningún archivo de inventario (.xlsx, .xls, .ods, .csv o .json). " +
      "Indica la ruta: node scripts/migrar-inventario.js ruta/al/archivo.xlsx"
  );
}

async function leerRegistros(ruta) {
  const extension = path.extname(ruta).toLowerCase();

  if (extension === ".json") {
    const contenido = JSON.parse(fs.readFileSync(ruta, "utf8"));
    const filas = Array.isArray(contenido) ? contenido : contenido.datos || [];
    return renombrarEncabezados(filas);
  }

  const libro = XLSX.readFile(ruta, { cellDates: true });
  const hoja = libro.Sheets[libro.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(hoja, { defval: "", raw: false });
  console.log(`Hoja leída: ${libro.SheetNames[0]} (${filas.length} filas)`);
  return renombrarEncabezados(filas);
}

/* ------------------------------------------------------------
   Ejecución
   ------------------------------------------------------------ */

async function main() {
  const config = configSupabase();
  if (!config.configurado) {
    throw new Error(
      "Faltan variables de Supabase: " +
        config.faltantes.join(", ") +
        ". Copia .env.example como .env antes de migrar."
    );
  }

  const ruta = resolverRuta(process.argv[2]);
  console.log("Migrando inventario desde:", ruta);

  const filas = await leerRegistros(ruta);
  const totalLeidos = filas.length;
  const registros = [];
  let errores = 0;

  for (const fila of filas) {
    const mapeado = mapearFila(fila);
    if (!mapeado) {
      errores += 1;
      continue;
    }
    registros.push(mapeado);
  }

  let procesados = 0;

  for (let inicio = 0; inicio < registros.length; inicio += LOTE_EQUIPOS) {
    const lote = registros.slice(inicio, inicio + LOTE_EQUIPOS);

    const { data, error } = await supabaseAdmin
      .from("equipos")
      .upsert(lote, { onConflict: "placa" })
      .select("id, placa");

    if (error) {
      errores += lote.length;
      console.error(`Error en lote ${inicio / LOTE_EQUIPOS + 1}: ${error.message}`);
      continue;
    }

    procesados += data?.length || 0;

    const eventos = (data || []).map((equipo) => ({
      equipo_id: equipo.id,
      placa: equipo.placa,
      accion: "Importacion Lote",
      detalle: `Migración inicial desde ${path.basename(ruta)}`,
      realizado_por: "migracion-inicial",
    }));

    if (eventos.length) {
      const { error: errorHistorial } = await supabaseAdmin
        .from("historial_movimientos")
        .insert(eventos);
      if (errorHistorial) {
        console.error(
          `No se pudo registrar el historial del lote: ${errorHistorial.message}`
        );
      }
    }

    console.log(`  Lote ${inicio / LOTE_EQUIPOS + 1}: ${data?.length || 0} equipos`);
  }

  console.log("\nRESUMEN DE MIGRACIÓN");
  console.log(JSON.stringify({ totalLeidos, procesados, errores }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nLa migración falló:", err.message);
    process.exit(1);
  });
