/* ============================================================
   migrar-csv-inicial.js | Carga única desde CSV/Excel/ODS
   ------------------------------------------------------------
   Uso: node scripts/migrar-csv-inicial.js [archivo]
   Normaliza 27 columnas, clasifica en ecosistemas y hace upsert
   en public.equipos (esquema arquitectura_inversa_prod.sql).
   ============================================================ */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const service = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
if (!url || !service) throw new Error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");

const h = {
  apikey: service,
  Authorization: `Bearer ${service}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const ARCHIVOS = ["data/inventario.ods", "data/inventario.xlsx", "data/inventario.csv"];
const ruta = process.argv[2] || ARCHIVOS.find((archivo) => fs.existsSync(archivo));
if (!ruta || !fs.existsSync(ruta)) throw new Error("No se encontró archivo de inventario");

const ORDEN_MAESTRO = [
  ["Nombre equipo en Red", "nombre_red"], ["Serial del equipo", "serial"],
  ["Nombre del responsable", "responsable"], ["Cedula del responsable", "cedula"],
  ["Empresa", "empresa"], ["Sede", "sede"], ["CECO", "ceco"], ["Estado", "estado"],
  ["Proveedor", "proveedor"], ["N° Contrato", "num_contrato"], ["Tipo de Contrato", "tipo_contrato"],
  ["Tipo de Equipo", "tipo_equipo"], ["Marca", "marca"], ["Modelo", "modelo"], ["Placa", "placa"],
  ["Procesador", "procesador"], ["Memoria RAM", "ram"], ["Tamaño en Disco", "disco"],
  ["Bitacora del Equipo", "bitacora"], ["Creado por", "creado_por"],
  ["Modificado por", "modificado_por"], ["Accesorios entregados", "accesorios"],
  ["Modificado", "updated_at"], ["Area", "area"],
  ["Fecha de Vencimiento Contrato", "fecha_vencimiento_contrato"],
  ["Tipo de elemento", "tipo_elemento"], ["Ruta de acceso", "ruta_acceso"],
];
const COLUMNAS = Object.fromEntries(ORDEN_MAESTRO);

function clasificar(registro) {
  const texto = `${registro.tipo_equipo || ""} ${registro.nombre_red || ""} ${registro.area || ""}`.toLowerCase();
  if (/sap|erp|finanzas|contab/.test(texto)) return "ERP-SAP";
  if (/handheld|impresora|planta|producci|panader/.test(texto)) return "INFRA-PLANTA";
  if (/office|m365|correo|teams|portátil|portatil|pc|monitor/.test(texto)) return "M365";
  if (/caja|pos|punto de venta|terminal/.test(texto)) return "POS-CAJAS";
  if (/switch|servidor|red|ups|access point|router/.test(texto)) return "REDES-SRV";
  return null;
}

const libro = XLSX.readFile(ruta, { cellDates: true });
const hoja = libro.Sheets[libro.SheetNames[0]];
const filas = XLSX.utils.sheet_to_json(hoja, { defval: "", raw: false });

const respuestaSistemas = await fetch(`${url}/rest/v1/sistemas?select=id,codigo`, { headers: h });
const sistemas = await respuestaSistemas.json();
const porCodigo = Object.fromEntries((sistemas || []).map((s) => [s.codigo, s.id]));

const registros = [];
for (const fila of filas) {
  const registro = {};
  for (const [encabezado, columna] of Object.entries(COLUMNAS)) {
    if (!Object.hasOwn(fila, encabezado)) continue;
    const valor = String(fila[encabezado] ?? "").trim();
    registro[columna] = valor || null;
  }
  if (!registro.placa) continue;
  const codigo = clasificar(registro);
  if (codigo && porCodigo[codigo]) registro.sistema_id = porCodigo[codigo];
  registro.modificado_por = "migracion-inicial";
  registros.push(registro);
}

let procesados = 0;
for (let i = 0; i < registros.length; i += 200) {
  const lote = registros.slice(i, i + 200);
  const r = await fetch(`${url}/rest/v1/equipos?on_conflict=placa`, {
    method: "POST",
    headers: { ...h, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(lote),
  });
  if (!r.ok) throw new Error(`Error en lote ${i / 200 + 1}: ${(await r.text()).slice(0, 200)}`);
  procesados += (await r.json()).length;
}

console.log(JSON.stringify({ archivo: path.basename(ruta), totalLeidos: filas.length, procesados, errores: filas.length - procesados }, null, 2));
