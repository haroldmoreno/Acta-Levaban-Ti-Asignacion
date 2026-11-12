import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/* ------------------------------------------------------------
   Rutas configurables por variables de entorno.
   ------------------------------------------------------------ */
export const DB_PATH =
  process.env.ACTA_DB_PATH || "C:\\Actas-Levapan\\database\\inventario.db";
export const PDF_DIR =
  process.env.ACTA_PDF_DIR || "C:\\Actas-Levapan\\Actas_Guardadas";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(PDF_DIR, { recursive: true });

/* ------------------------------------------------------------
   Conexión y esquema
   ------------------------------------------------------------ */
export const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec(`
  CREATE TABLE IF NOT EXISTS equipos (
    placa TEXT PRIMARY KEY,
    serial TEXT NOT NULL DEFAULT '',
    tipo TEXT NOT NULL DEFAULT '',
    marca TEXT NOT NULL DEFAULT '',
    modelo TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT '',
    usuario_actual TEXT NOT NULL DEFAULT '',
    cedula_usuario TEXT NOT NULL DEFAULT '',
    accesorios TEXT NOT NULL DEFAULT '',
    software TEXT NOT NULL DEFAULT '',
    procesador TEXT NOT NULL DEFAULT '',
    ram TEXT NOT NULL DEFAULT '',
    disco TEXT NOT NULL DEFAULT '',
    hostname TEXT NOT NULL DEFAULT '',
    observaciones TEXT NOT NULL DEFAULT '',
    fecha_actualizacion TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_equipos_placa_nocase
    ON equipos(placa COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS historial_actas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    placa TEXT NOT NULL,
    nombre_colaborador TEXT NOT NULL DEFAULT '',
    cedula_colaborador TEXT NOT NULL DEFAULT '',
    agente_ti TEXT NOT NULL DEFAULT '',
    cedula_ti TEXT NOT NULL DEFAULT '',
    tipo_acta TEXT NOT NULL DEFAULT '',
    tipo_equipo TEXT NOT NULL DEFAULT '',
    marca TEXT NOT NULL DEFAULT '',
    modelo TEXT NOT NULL DEFAULT '',
    serial TEXT NOT NULL DEFAULT '',
    accesorios TEXT NOT NULL DEFAULT '',
    software TEXT NOT NULL DEFAULT '',
    observaciones TEXT NOT NULL DEFAULT '',
    archivo TEXT NOT NULL DEFAULT '',
    ruta_pdf TEXT NOT NULL DEFAULT '',
    creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_historial_placa
    ON historial_actas(placa COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_historial_fecha
    ON historial_actas(fecha);

  CREATE TABLE IF NOT EXISTS importaciones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    archivo TEXT NOT NULL DEFAULT '',
    total INTEGER NOT NULL DEFAULT 0,
    insertados INTEGER NOT NULL DEFAULT 0,
    actualizados INTEGER NOT NULL DEFAULT 0
  );
`);

/* ------------------------------------------------------------
   Mapeo flexible de encabezados (incluye los del archivo ODS)
   ------------------------------------------------------------ */
const ALIAS = {
  placa: ["placa", "activofijo", "activo", "codigoactivo", "codigo", "fixedasset", "asset"],
  serial: [
    "serial",
    "serialdelequipo",
    "serie",
    "numeroserie",
    "nserie",
    "sn",
  ],
  tipo: ["tipo", "tipoequipo", "tipodeequipo", "tipodelequipo", "categoria", "tipologia"],
  marca: ["marca", "fabricante"],
  modelo: ["modelo"],
  estado: ["estado", "estadoequipo", "estatus"],
  usuario_actual: [
    "usuarioactual",
    "usuario",
    "colaborador",
    "asignadoa",
    "responsable",
    "nombreusuario",
    "nombre",
    "nombredelresponsable",
  ],
  cedula_usuario: [
    "cedulausuario",
    "cedula",
    "documento",
    "cc",
    "identificacion",
    "cedulacolaborador",
    "ceduladelresponsable",
  ],
  accesorios: ["accesorios", "accesoriosentregados", "accesorio", "perifericos", "elementos"],
  software: ["software", "programas", "aplicaciones"],
  procesador: ["procesador", "cpu"],
  ram: ["ram", "memoria", "memoriaram"],
  disco: ["disco", "hdd", "ssd", "almacenamiento", "discoduro", "tamanoendisco"],
  hostname: [
    "hostname",
    "host",
    "nombrepc",
    "nombreequipo",
    "nombreequipoenred",
    "nombredelequipo",
  ],
  observaciones: ["observaciones", "observacion", "notas", "comentarios", "bitacora", "bitacoradelequipo"],
};

export function normalizarClave(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function valorTexto(valor) {
  if (Array.isArray(valor)) {
    return valor.map((v) => String(v).trim()).filter(Boolean).join(", ");
  }
  if (valor && typeof valor === "object") return "";
  return String(valor ?? "").trim();
}

/* ------------------------------------------------------------
   Normalización de valores del inventario
   El ODS usa variantes ("Portatil", "Pantalla", "Hewlett-Packard HP")
   que deben coincidir con el catálogo de la interfaz.
   ------------------------------------------------------------ */
/** Crea un mapa cuyas claves se normalizan igual que los datos de entrada. */
function mapaCanonico(entradas) {
  return new Map(
    entradas.map(([clave, valor]) => [normalizarClave(clave), valor])
  );
}

const TIPOS_CANONICOS = mapaCanonico([
  ["portatil", "Portátil"],
  ["laptop", "Portátil"],
  ["desktop", "CPU"],
  ["cpu", "CPU"],
  ["computador", "CPU"],
  ["pantalla", "Monitor"],
  ["monitor", "Monitor"],
  ["videobeam", "Proyector"],
  ["proyector", "Proyector"],
  ["impresora zebra", "Impresora"],
  ["impresora", "Impresora"],
  ["impresora portatil", "Impresora portátil"],
  ["handheld", "Handheld"],
  ["tablet", "Tablet"],
  ["jabra", "Jabra"],
  ["ups", "UPS"],
  ["switch", "Switch"],
  ["terminal", "Terminal"],
  ["ap aruba", "Access Point"],
  ["access point", "Access Point"],
  ["cuna para baterias", "Cuna para Baterías"],
  ["base decarga terminales", "Base de Carga Terminales"],
  ["base de carga terminales", "Base de Carga Terminales"],
  ["modem", "Módem"],
  ["apuntador", "Apuntador"],
]);

const MARCAS_CANONICAS = mapaCanonico([
  ["hewlett-packard hp", "HP"],
  ["hewlett packard", "HP"],
  ["hewlett-packard", "HP"],
  ["hp", "HP"],
  ["aruba", "Aruba"],
  ["mac", "Apple"],
  ["otras", "Otras"],
]);

export function normalizarTipo(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return "";
  const clave = normalizarClave(texto);
  return TIPOS_CANONICOS.get(clave) || texto;
}

export function normalizarMarca(valor) {
  const texto = String(valor ?? "").trim();
  if (!texto) return "";
  const clave = normalizarClave(texto);
  return MARCAS_CANONICAS.get(clave) || texto;
}

/** Convierte listas tipo "Mouse;#Teclado;#Base" en "Mouse, Teclado, Base". */
function normalizarLista(valor) {
  const texto = valorTexto(valor);
  if (!texto) return "";
  const partes = texto
    .split(/[;,|#\n]/)
    .map((parte) => parte.replace(/^#+/, "").trim())
    .filter(Boolean);
  return [...new Set(partes)].join(", ");
}

export function mapearFila(fila) {
  const plano = {};
  Object.entries(fila || {}).forEach(([clave, valor]) => {
    plano[normalizarClave(clave)] = valor;
  });

  const salida = {};
  Object.entries(ALIAS).forEach(([campo, alias]) => {
    let valor = "";
    for (const nombre of alias) {
      if (plano[nombre] !== undefined && plano[nombre] !== null) {
        valor = valorTexto(plano[nombre]);
        if (valor) break;
      }
    }
    salida[campo] = valor;
  });

  salida.tipo = normalizarTipo(salida.tipo);
  salida.marca = normalizarMarca(salida.marca);
  salida.accesorios = normalizarLista(salida.accesorios);
  salida.software = normalizarLista(salida.software);
  return salida;
}

/* ------------------------------------------------------------
   Importación
   ------------------------------------------------------------ */
const insertarEquipo = db.prepare(`
  INSERT INTO equipos (
    placa, serial, tipo, marca, modelo, estado, usuario_actual,
    cedula_usuario, accesorios, software, procesador, ram, disco,
    hostname, observaciones, fecha_actualizacion
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(placa) DO UPDATE SET
    serial = excluded.serial,
    tipo = excluded.tipo,
    marca = excluded.marca,
    modelo = excluded.modelo,
    estado = CASE
      WHEN EXISTS (
        SELECT 1 FROM historial_actas h
         WHERE h.placa = equipos.placa COLLATE NOCASE
      ) THEN equipos.estado
      ELSE COALESCE(NULLIF(excluded.estado, ''), equipos.estado)
    END,
    usuario_actual = CASE
      WHEN EXISTS (
        SELECT 1 FROM historial_actas h
         WHERE h.placa = equipos.placa COLLATE NOCASE
      ) THEN equipos.usuario_actual
      ELSE COALESCE(NULLIF(excluded.usuario_actual, ''), equipos.usuario_actual)
    END,
    cedula_usuario = CASE
      WHEN EXISTS (
        SELECT 1 FROM historial_actas h
         WHERE h.placa = equipos.placa COLLATE NOCASE
      ) THEN equipos.cedula_usuario
      ELSE COALESCE(NULLIF(excluded.cedula_usuario, ''), equipos.cedula_usuario)
    END,
    accesorios = excluded.accesorios,
    software = excluded.software,
    procesador = excluded.procesador,
    ram = excluded.ram,
    disco = excluded.disco,
    hostname = excluded.hostname,
    observaciones = excluded.observaciones,
    fecha_actualizacion = excluded.fecha_actualizacion
`);

const buscarPlaca = db.prepare(
  "SELECT placa FROM equipos WHERE placa = ? COLLATE NOCASE"
);

export function upsertEquipo(fila) {
  const equipo = mapearFila(fila);
  if (!equipo.placa) {
    return { insertado: false, actualizado: false, omitido: true };
  }

  const existente = buscarPlaca.get(equipo.placa);
  const placaFinal = existente ? existente.placa : equipo.placa;
  const fecha = new Date().toISOString();

  insertarEquipo.run(
    placaFinal,
    equipo.serial,
    equipo.tipo,
    equipo.marca,
    equipo.modelo,
    equipo.estado,
    equipo.usuario_actual,
    equipo.cedula_usuario,
    equipo.accesorios,
    equipo.software,
    equipo.procesador,
    equipo.ram,
    equipo.disco,
    equipo.hostname,
    equipo.observaciones,
    fecha
  );

  return {
    insertado: !existente,
    actualizado: Boolean(existente),
    omitido: false,
  };
}

export function registrarImportacion(archivo, total, insertados, actualizados) {
  db.prepare(
    `INSERT INTO importaciones (fecha, archivo, total, insertados, actualizados)
     VALUES (?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), archivo, total, insertados, actualizados);
}

/* ------------------------------------------------------------
   Consultas y actas
   ------------------------------------------------------------ */
export function buscarEquipo(placa) {
  const valor = String(placa ?? "").trim();
  if (!valor) return null;

  const fila = db
    .prepare("SELECT * FROM equipos WHERE placa = ? COLLATE NOCASE")
    .get(valor);
  if (!fila) return null;

  return {
    ...fila,
    nombreusuario: fila.usuario_actual,
    cedula: fila.cedula_usuario,
  };
}

/* Búsqueda para el desplegable de Placa: primero por prefijo y, si no hay
   coincidencias, por cualquier parte de la placa. */
const buscarPorPrefijo = db.prepare(
  `SELECT * FROM equipos
    WHERE UPPER(TRIM(placa)) LIKE UPPER(TRIM(?))
    ORDER BY placa ASC
    LIMIT 30`
);

export function buscarEquiposPorPrefijo(consulta = "") {
  const texto = String(consulta ?? "").trim();
  if (!texto) return { equipos: [], modo: "prefijo" };

  const porPrefijo = buscarPorPrefijo.all(`${texto}%`);
  if (porPrefijo.length) return { equipos: porPrefijo, modo: "prefijo" };

  return { equipos: buscarPorPrefijo.all(`%${texto}%`), modo: "contiene" };
}

export function buscarEquipos(consulta = "", limite = 20) {
  const texto = String(consulta ?? "").trim();
  const tope = Math.min(100, Math.max(1, Number(limite) || 20));

  if (!texto) {
    return db.prepare("SELECT * FROM equipos ORDER BY placa LIMIT ?").all(tope);
  }

  return db
    .prepare(
      `SELECT * FROM equipos
        WHERE instr(lower(placa), lower(?)) > 0
           OR instr(lower(serial), lower(?)) > 0
           OR instr(lower(usuario_actual), lower(?)) > 0
           OR instr(lower(cedula_usuario), lower(?)) > 0
        ORDER BY placa
        LIMIT ?`
    )
    .all(texto, texto, texto, texto, tope);
}

export function estadisticas() {
  const total = db.prepare("SELECT COUNT(*) AS total FROM equipos").get();
  const ultima = db
    .prepare("SELECT * FROM importaciones ORDER BY id DESC LIMIT 1")
    .get();

  return {
    totalEquipos: Number(total?.total || 0),
    ultimaImportacion: ultima || null,
    dbPath: DB_PATH,
    pdfDir: PDF_DIR,
  };
}

function listaTexto(valor) {
  if (Array.isArray(valor)) return valor.join(", ");
  return String(valor ?? "").trim();
}

export function registrarActa(datos, archivo, rutaPdf) {
  const placa = String(datos.placa ?? "").trim();
  if (!placa) throw new Error("La placa es obligatoria");

  const fecha = new Date().toISOString();
  const tipoActa = String(datos.tipoActa || "Asignación").trim();
  const esDevolucion = normalizarClave(tipoActa) === "devolucion";
  const estadoNuevo = esDevolucion ? "Disponible" : "Asignado";
  const usuario = esDevolucion ? "" : String(datos.nombre ?? "").trim();
  const cedula = esDevolucion ? "" : String(datos.documento ?? "").trim();

  const existente = buscarPlaca.get(placa);
  const placaFinal = existente ? existente.placa : placa;

  const insertarHistorial = db.prepare(`
    INSERT INTO historial_actas (
      fecha, placa, nombre_colaborador, cedula_colaborador, agente_ti,
      cedula_ti, tipo_acta, tipo_equipo, marca, modelo, serial,
      accesorios, software, observaciones, archivo, ruta_pdf
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /* En Asignación los accesorios entregados pasan a ser los del equipo.
     En Devolución se conserva el histórico de accesorios. */
  const accesoriosFinales = esDevolucion ? null : listaTexto(datos.accesorios);

  const actualizarEquipo = db.prepare(`
    UPDATE equipos
       SET estado = ?, usuario_actual = ?, cedula_usuario = ?,
           accesorios = COALESCE(?, accesorios),
           fecha_actualizacion = ?
     WHERE placa = ?
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    const info = insertarHistorial.run(
      fecha,
      placaFinal,
      String(datos.nombre ?? "").trim(),
      String(datos.documento ?? "").trim(),
      String(datos.agenteTi ?? "").trim(),
      String(datos.documentoTi ?? "").trim(),
      tipoActa,
      String(datos.tipo ?? "").trim(),
      String(datos.marca ?? "").trim(),
      String(datos.modelo ?? "").trim(),
      String(datos.serial ?? "").trim(),
      listaTexto(datos.accesorios),
      listaTexto(datos.software),
      String(datos.observaciones ?? "").trim(),
      archivo,
      rutaPdf
    );

    let actualizado = 0;
    if (existente) {
      actualizado = actualizarEquipo.run(
        estadoNuevo,
        usuario,
        cedula,
        accesoriosFinales,
        fecha,
        placaFinal
      ).changes;
    } else {
      insertarEquipo.run(
        placaFinal,
        String(datos.serial ?? "").trim(),
        normalizarTipo(datos.tipo),
        normalizarMarca(datos.marca),
        String(datos.modelo ?? "").trim(),
        estadoNuevo,
        usuario,
        cedula,
        listaTexto(datos.accesorios),
        listaTexto(datos.software),
        "",
        "",
        "",
        "",
        "",
        fecha
      );
      actualizado = 1;
    }

    db.exec("COMMIT");
    return {
      id: Number(info.lastInsertRowid),
      estado: estadoNuevo,
      actualizado,
    };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function historial(placa = "", limite = 50) {
  const tope = Math.min(500, Math.max(1, Number(limite) || 50));

  if (placa) {
    return db
      .prepare(
        `SELECT * FROM historial_actas
          WHERE placa = ? COLLATE NOCASE
          ORDER BY id DESC LIMIT ?`
      )
      .all(String(placa).trim(), tope);
  }

  return db
    .prepare("SELECT * FROM historial_actas ORDER BY id DESC LIMIT ?")
    .all(tope);
}

export function cerrarDB() {
  try {
    db.close();
  } catch (err) {
    console.warn("No se pudo cerrar la base de datos:", err.message);
  }
}
