/* ============================================================
   normalizar.js | Normalización compartida de filas de inventario
   Usado por scripts/migrar-inventario.js y por POST /api/equipos/importar.
   ============================================================ */

export const LOTE_EQUIPOS = 200;

/** Normaliza un encabezado: sin tildes, sin espacios, sin símbolos. */
export function clave(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export const ALIAS = {
  placa: ["placa", "placaequipo", "codigo", "codequipo", "activo", "numeroplaca"],
  tipo: ["tipo", "tipoequipo", "clase", "categoria", "tipodeequipo"],
  marca: ["marca", "fabricante", "brand"],
  modelo: ["modelo", "referencia"],
  serial: ["serial", "serie", "numerodeserie", "nserial", "serialnumber"],
  estado: ["estado", "situacion", "condicion"],
  sede: ["sede", "sedeclevapan", "ubicacion", "ciudad", "localizacion"],
  usuario: ["usuario", "usuarioasignado", "responsable", "nombreusuario", "asignadoa", "nombre"],
  cedula: ["cedula", "documento", "cc", "identificacion", "cedulausuario", "doc"],
};

const ESTADOS = {
  disponible: "Disponible",
  disponibleparaasignar: "Disponible",
  asignado: "Asignado",
  prestamo: "Prestamo",
  prestado: "Prestamo",
  mantenimiento: "En Mantenimiento",
  enmantenimiento: "En Mantenimiento",
  enlaboratoriodepruebas: "En Mantenimiento",
  enlaboratorioparadarbaja: "En Mantenimiento",
  paraddevolucionaproveedor: "En Mantenimiento",
  paradvolucionaproveedor: "En Mantenimiento",
  dadodebaja: "Dado de Baja",
  baja: "Dado de Baja",
};

/** Respeta el valor exacto del inventario; nunca inventa "Disponible". */
export function normalizarEstado(valor) {
  return textoCelda(valor) || null;
}

export function textoCelda(valor) {
  if (valor == null) return "";
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).trim();
}

export function renombrarEncabezados(filas) {
  return filas.map((fila) => {
    const salida = {};
    for (const [encabezado, valor] of Object.entries(fila)) {
      salida[clave(encabezado)] = valor;
    }
    return salida;
  });
}

/** Columnas exactas del inventario SharePoint. */
export const CAMPOS_SHAREPOINT = [
  "placa",
  "nombre_equipo_red",
  "serial",
  "responsable",
  "cedula_responsable",
  "empresa",
  "sede",
  "ceco",
  "area",
  "estado",
  "proveedor",
  "numero_contrato",
  "tipo_contrato",
  "fecha_vencimiento_contrato",
  "tipo_equipo",
  "marca",
  "modelo",
  "procesador",
  "memoria_ram",
  "tamano_disco",
  "accesorios_entregados",
  "bitacora_equipo",
  "creado_por",
  "modificado_por",
  "modificado_fecha",
  "tipo_elemento",
  "ruta_acceso",
];

/** Encabezados oficiales de SharePoint → columnas internas. */
export const SHAREPOINT_ALIAS = {
  placa: "placa",
  nombreequipoenred: "nombre_equipo_red",
  serialdelequipo: "serial",
  nombredelresponsable: "responsable",
  ceduladelresponsable: "cedula_responsable",
  empresa: "empresa",
  sede: "sede",
  ceco: "ceco",
  estado: "estado",
  proveedor: "proveedor",
  ncontrato: "numero_contrato",
  numerocontrato: "numero_contrato",
  tipodecontrato: "tipo_contrato",
  tipodeequipo: "tipo_equipo",
  marca: "marca",
  modelo: "modelo",
  procesador: "procesador",
  memoriaram: "memoria_ram",
  tamanoendisco: "tamano_disco",
  bitacoradelequipo: "bitacora_equipo",
  creadopor: "creado_por",
  modificadopor: "modificado_por",
  accesoriosentregados: "accesorios_entregados",
  modificado: "modificado_fecha",
  area: "area",
  fechadevencimientocontrato: "fecha_vencimiento_contrato",
  tipodeelemento: "tipo_elemento",
  rutadeacceso: "ruta_acceso",
};

const CAMPOS_FECHA = new Set(["fecha_vencimiento_contrato", "modificado_fecha"]);

function fechaSharepoint(valor, campo) {
  const texto = textoCelda(valor);
  if (!texto) return "";
  if (/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(texto)) {
    return campo === "modificado_fecha" ? texto.slice(0, 10) + "T00:00:00-05:00" : texto.slice(0, 10);
  }
  const partes = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (partes) {
    const [, dia, mes, anio, hora = "00", minuto = "00"] = partes;
    if (campo === "modificado_fecha") {
      return `${anio}-${mes}-${dia}T${hora}:${minuto}:00-05:00`;
    }
    return `${anio}-${mes}-${dia}`;
  }
  return texto;
}

/** Convierte una fila de SharePoint (nombres exactos) en registro de equipos. */
export function mapearFilaSharepoint(fila) {
  const normalizada = renombrarEncabezados([fila])[0] || {};
  const registro = {};

  for (const [encabezado, campo] of Object.entries(SHAREPOINT_ALIAS)) {
    if (!Object.hasOwn(normalizada, encabezado)) continue;
    const valorOriginal = normalizada[encabezado];
    // Se conserva el texto exacto: "" sigue siendo "" y nunca se inventa un estado.
    const valor = CAMPOS_FECHA.has(campo)
      ? fechaSharepoint(valorOriginal, campo)
      : textoCelda(valorOriginal);
    registro[campo] = valor;
  }

  // Compatibilidad con filas que ya vienen con nombres internos.
  for (const campo of CAMPOS_SHAREPOINT) {
    if (Object.hasOwn(registro, campo)) continue;
    const k = clave(campo);
    if (!Object.hasOwn(normalizada, k)) continue;
    registro[campo] = CAMPOS_FECHA.has(campo)
      ? fechaSharepoint(normalizada[k], campo)
      : textoCelda(normalizada[k]);
  }

  // Espejos hacia los campos históricos que usa la aplicación.
  if (registro.responsable) registro.usuario_asignado = registro.responsable;
  if (registro.cedula_responsable) registro.usuario_cedula = registro.cedula_responsable;
  if (registro.tipo_equipo && !registro.tipo) registro.tipo = registro.tipo_equipo;

  return registro;
}

/** Convierte una fila ya normalizada en un registro de la tabla equipos. */
export function mapearFila(fila) {
  const valor = (campo) => {
    for (const alias of ALIAS[campo]) {
      if (Object.hasOwn(fila, alias)) return textoCelda(fila[alias]);
    }
    return "";
  };

  const placa = valor("placa");
  if (!placa) return null;

  return {
    placa,
    tipo: valor("tipo") || null,
    marca: valor("marca") || null,
    modelo: valor("modelo") || null,
    serial: valor("serial") || null,
    estado: normalizarEstado(valor("estado")),
    sede: valor("sede") || null,
    usuario_asignado: valor("usuario") || null,
    usuario_cedula: valor("cedula") || null,
  };
}
