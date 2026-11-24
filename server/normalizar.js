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

export function normalizarEstado(valor) {
  const k = clave(valor);
  if (!k) return "Disponible";
  return ESTADOS[k] || "Disponible";
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
