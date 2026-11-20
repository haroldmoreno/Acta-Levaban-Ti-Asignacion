/* ============================================================
   graph.js | Microsoft Graph + SharePoint
   ------------------------------------------------------------
   Autenticación "Client Credentials" con @azure/msal-node y
   consultas a la Lista de SharePoint que contiene el inventario.

   Variables de entorno:
     TENANT_ID          Directorio (tenant) de Microsoft Entra ID
     CLIENT_ID          App registration con permiso de aplicación
     CLIENT_SECRET      Secreto de la app registration
     SITE_ID            ID del sitio de SharePoint
     SHAREPOINT_LIST_ID Nombre o ID de la lista de inventario
                        (por defecto "Inventario")
   ============================================================ */

import { ConfidentialClientApplication } from "@azure/msal-node";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = ["https://graph.microsoft.com/.default"];
const ESPERA_MAXIMA_MS = 20000;

/* ------------------------------------------------------------
   Configuración (se lee en cada llamada para respetar .env)
   ------------------------------------------------------------ */

function texto(valor) {
  return String(valor ?? "").trim();
}

export function configGraph() {
  const tenantId = texto(process.env.TENANT_ID || process.env.AZURE_TENANT_ID);
  const clientId = texto(process.env.CLIENT_ID || process.env.AZURE_CLIENT_ID);
  const clientSecret = texto(
    process.env.CLIENT_SECRET || process.env.AZURE_CLIENT_SECRET
  );
  const siteId = texto(process.env.SITE_ID || process.env.SHAREPOINT_SITE_ID);
  const listId =
    texto(
      process.env.SHAREPOINT_LIST_ID ||
        process.env.GRAPH_LIST_ID ||
        process.env.LIST_ID
    ) || "Inventario";

  const faltantes = [
    ["TENANT_ID", tenantId],
    ["CLIENT_ID", clientId],
    ["CLIENT_SECRET", clientSecret],
    ["SITE_ID", siteId],
  ]
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);

  return {
    tenantId,
    clientId,
    clientSecret,
    siteId,
    listId,
    configurado: faltantes.length === 0,
    faltantes,
  };
}

/* ------------------------------------------------------------
   Token de aplicación (se reutiliza hasta 1 minuto antes de vencer)
   ------------------------------------------------------------ */

let clienteMsal = null;
let clienteMsalClave = "";
let tokenActual = { valor: "", expira: 0 };

function obtenerCliente(config) {
  const clave = `${config.tenantId}|${config.clientId}`;
  if (clienteMsal && clienteMsalClave === clave) return clienteMsal;

  clienteMsal = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
  });
  clienteMsalClave = clave;
  tokenActual = { valor: "", expira: 0 };
  return clienteMsal;
}

function errorHttp(mensaje, status, extra = {}) {
  return Object.assign(new Error(mensaje), { status }, extra);
}

async function obtenerToken({ forzar = false } = {}) {
  const config = configGraph();
  if (!config.configurado) {
    throw errorHttp(
      `Microsoft Graph no está configurado. Faltan: ${config.faltantes.join(", ")}.`,
      503
    );
  }

  if (!forzar && tokenActual.valor && Date.now() < tokenActual.expira - 60000) {
    return tokenActual.valor;
  }

  const cliente = obtenerCliente(config);
  let resultado;
  try {
    resultado = await cliente.acquireTokenByClientCredential({
      scopes: SCOPES,
      skipCache: forzar,
    });
  } catch (err) {
    throw errorHttp(
      `No se pudo autenticar con Microsoft Entra ID: ${
        err?.errorMessage || err?.message || "error desconocido"
      }`,
      502,
      { causa: "autenticacion" }
    );
  }

  if (!resultado?.accessToken) {
    throw errorHttp(
      "Microsoft Entra ID no devolvió un token de acceso. Revisa los permisos de aplicación (Sites.Read.All / Sites.ReadWrite.All) y su consentimiento.",
      502,
      { causa: "autenticacion" }
    );
  }

  tokenActual = {
    valor: resultado.accessToken,
    expira: resultado.expiresOn
      ? resultado.expiresOn.getTime()
      : Date.now() + 5 * 60 * 1000,
  };
  return tokenActual.valor;
}

/* ------------------------------------------------------------
   Llamadas a Graph con reintentos y tiempo límite
   ------------------------------------------------------------ */

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function detalleError(respuesta) {
  try {
    const cuerpo = await respuesta.json();
    const mensaje =
      cuerpo?.error?.message || cuerpo?.error_description || cuerpo?.message;
    if (mensaje) return String(mensaje).slice(0, 300);
  } catch {
    /* La respuesta no era JSON. */
  }
  return respuesta.statusText || `HTTP ${respuesta.status}`;
}

async function graphGet(ruta, { intentos = 3, avanzado = false } = {}) {
  const config = configGraph();
  await asegurarSiteIdInventario();

  if (!config.configurado) {
    throw errorHttp(
      `Microsoft Graph no está configurado. Faltan: ${config.faltantes.join(", ")}.`,
      503
    );
  }

  const cabeceras = {
    Accept: "application/json",
    Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
  };
  if (avanzado) cabeceras.ConsistencyLevel = "eventual";

  let ultimoError = null;

  for (let intento = 1; intento <= intentos; intento += 1) {
    let respuesta;
    try {
      const token = await obtenerToken({
        forzar: intento > 1 && ultimoError?.grafoStatus === 401,
      });

      // @odata.nextLink llega como URL absoluta; las rutas propias se
      // resuelven contra la raíz de Graph.
      const url = /^https?:\/\//i.test(ruta) ? ruta : `${GRAPH}${ruta}`;
      respuesta = await fetch(url, {
        method: "GET",
        headers: {
          ...cabeceras,
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
        },
        signal: AbortSignal.timeout(ESPERA_MAXIMA_MS),
      });
    } catch (err) {
      // Errores de configuración o de autenticación: no se reintentan.
      if (err?.status) throw err;

      // Errores de red o tiempo de espera: se reintentan.
      ultimoError = errorHttp(
        `No se pudo contactar Microsoft Graph: ${err.message}`,
        502,
        { causa: "red" }
      );
      if (intento === intentos) break;
      await dormir(400 * intento);
      continue;
    }

    if (respuesta.status === 429 || respuesta.status >= 500) {
      const espera =
        Number(respuesta.headers.get("retry-after")) * 1000 || 500 * intento;
      ultimoError = errorHttp(
        `Microsoft Graph no está disponible (HTTP ${respuesta.status}).`,
        502,
        { grafoStatus: respuesta.status }
      );
      if (intento === intentos) break;
      await dormir(Math.min(espera, 5000));
      continue;
    }

    if (!respuesta.ok) {
      const detalle = await detalleError(respuesta);
      throw errorHttp(
        `Microsoft Graph rechazó la consulta (HTTP ${respuesta.status}): ${detalle}`,
        respuesta.status === 404 ? 404 : 502,
        { grafoStatus: respuesta.status }
      );
    }

    return await respuesta.json();
  }

  throw (

  throw (
    ultimoError ||
    errorHttp("No se pudo consultar Microsoft Graph.", 502, { causa: "red" })
  );
}

/* ------------------------------------------------------------
   Construcción de rutas OData
   ------------------------------------------------------------ */

function escaparOdata(valor) {
  // En OData una comilla simple se escapa duplicándola.
  return String(valor ?? "").replace(/'/g, "''");
}

/* Nombres internos confirmados en la lista "Inventario 2020 PC".
   Se piden explícitamente porque $expand=fields sin $select solo
   devuelve los campos de persona como ...LookupId. */
const CAMPOS_ITEMS = [
  "Title",
  "Placa",
  "Serial_x0020_del_x0020_equipo",
  "Tipo_x0020_de_x0020_Equipo",
  "Marca",
  "Modelo",
  "Estado",
  "Nombre_x0020_del_x0020_responsab",
  "Cedula_x0020_del_x0020_responsab",
  "Accesorios_x0020_entregados",
  "Bitacora_x0020_del_x0020_Equipo",
  "Procesador",
  "Memoria_x0020_RAM",
  "Tama_x00f1_o_x0020_en_x0020_Disc",
  "CECO",
  "Empresa",
  "Sede",
  "Proveedor",
  "Modified",
].join(",");

function rutaItems({ filtro, top = 30, avanzado = false, orden = "" }) {
  const { siteId, listId } = configGraph();
  const parametros = [
    `$expand=fields($select=${CAMPOS_ITEMS})`,
    `$top=${Math.max(1, Number(top) || 30)}`,
  ];
  if (filtro) parametros.push(`$filter=${encodeURIComponent(filtro)}`);
  if (orden) parametros.push(`$orderby=${encodeURIComponent(orden)}`);
  // if (avanzado) parametros.push("$count=true");

  return `/sites/${encodeURI(siteId)}/lists/${encodeURIComponent(
    listId
  )}/items?${parametros.join("&")}`;
}

/* ------------------------------------------------------------
   Normalización de campos de SharePoint
   ------------------------------------------------------------ */

/* Mismo criterio que server/db.js para que el frontend reciba
   exactamente los mismos valores que antes. */
/* SharePoint codifica los espacios y caracteres especiales de los nombres
   internos como _x0020_, _x00f1_, etc. Se decodifican antes de normalizar
   para que "Serial_x0020_del_x0020_equipo" equivalga a "serialdelequipo". */
function decodificarNombreSharePoint(valor) {
  return String(valor ?? "").replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

export function normalizarClave(valor) {
  return decodificarNombreSharePoint(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIAS = {
  placa: [
    "placa",
    "placaequipo",
    "activofijo",
    "codigoactivo",
    "codigo",
    "title",
  ],
  serial: [
    "serial",
    "serialdelequipo",
    "serialequipo",
    "serie",
    "numeroserie",
    "numerodeserial",
    "nserie",
    "sn",
  ],
  tipo: [
    "tipo",
    "tipoequipo",
    "tipodeequipo",
    "tipodelequipo",
    "categoria",
    "tipologia",
  ],
  marca: ["marca", "fabricante"],
  modelo: ["modelo"],
  estado: ["estado", "estadoequipo", "estatus"],
  sede: ["sede", "sedelebapan", "ubicacion", "planta", "ciudad"],
  usuario_actual: [
    "usuarioactual",
    "usuario",
    "colaborador",
    "asignadoa",
    "responsable",
    "nombreusuario",
    "nombre",
    "nombredelresponsable",
    "nombredelresponsab",
  ],
  cedula_usuario: [
    "cedulausuario",
    "cedula",
    "documento",
    "cc",
    "identificacion",
    "cedulacolaborador",
    "ceduladelresponsable",
    "ceduladelresponsab",
  ],
  accesorios: [
    "accesorios",
    "accesoriosentregados",
    "accesorio",
    "perifericos",
    "elementos",
  ],
  software: ["software", "programas", "aplicaciones"],
  procesador: ["procesador", "cpu"],
  ram: ["ram", "memoria", "memoriaram"],
  disco: [
    "disco",
    "hdd",
    "ssd",
    "almacenamiento",
    "discoduro",
    "tamanoendisc",
  ],
  hostname: [
    "title",
    "hostname",
    "host",
    "nombrepc",
    "nombreequipo",
    "nombreequipoenred",
  ],
  observaciones: [
    "observaciones",
    "observacion",
    "notas",
    "comentarios",
    "bitacora",
    "bitacoradelequipo",
  ],
  fecha_actualizacion: [
    "fechaactualizacion",
    "modified",
    "fechamodificacion",
    "ultimaactualizacion",
  ],
};

function valorTexto(valor) {
  if (valor === null || valor === undefined) return "";
  if (Array.isArray(valor)) {
    return valor.map(valorTexto).filter(Boolean).join(", ");
  }
  if (typeof valor === "object") {
    // Columnas de persona, búsqueda, taxonomía o hipervínculo.
    for (const clave of [
      "LookupValue",
      "DisplayName",
      "Label",
      "Description",
      "Email",
      "Title",
      "Url",
      "Value",
      "Text",
    ]) {
      if (valor[clave] !== undefined && valor[clave] !== null) {
        const textoValor = valorTexto(valor[clave]);
        if (textoValor) return textoValor;
      }
    }
    return "";
  }
  return String(valor).trim();
}

/** Convierte "Mouse;#Teclado;#Base" en "Mouse, Teclado, Base". */
function normalizarLista(valor) {
  const contenido = valorTexto(valor);
  if (!contenido) return "";
  const partes = contenido
    .split(/[;,|#\n]/)
    .map((parte) => parte.replace(/^#+/, "").trim())
    .filter(Boolean);
  return [...new Set(partes)].join(", ");
}

const TIPOS_CANONICOS = new Map(
  [
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
  ].map(([clave, valor]) => [normalizarClave(clave), valor])
);

const MARCAS_CANONICAS = new Map(
  [
    ["hewlett-packard hp", "HP"],
    ["hewlett packard", "HP"],
    ["hewlett-packard", "HP"],
    ["hp", "HP"],
    ["aruba", "Aruba"],
    ["mac", "Apple"],
    ["otras", "Otras"],
  ].map(([clave, valor]) => [normalizarClave(clave), valor])
);

export function normalizarTipo(valor) {
  const contenido = texto(valor);
  if (!contenido) return "";
  return TIPOS_CANONICOS.get(normalizarClave(contenido)) || contenido;
}

export function normalizarMarca(valor) {
  const contenido = texto(valor);
  if (!contenido) return "";
  return MARCAS_CANONICAS.get(normalizarClave(contenido)) || contenido;
}

/** Convierte un item de SharePoint al JSON que ya consumía el frontend. */
export function mapearItem(item) {
  const campos = item?.fields || {};
  const indice = new Map(
    Object.entries(campos).map(([clave, valor]) => [normalizarClave(clave), valor])
  );

  const leer = (campo) => {
    for (const alias of ALIAS[campo]) {
      const valor = indice.get(alias);
      if (valor !== undefined && valor !== null) {
        const contenido = valorTexto(valor);
        if (contenido) return contenido;
      }
    }
    return "";
  };

  const equipo = {};
  for (const campo of Object.keys(ALIAS)) equipo[campo] = leer(campo);

  equipo.placa = equipo.placa || texto(campos.Title);
  equipo.tipo = normalizarTipo(equipo.tipo);
  equipo.marca = normalizarMarca(equipo.marca);
  equipo.accesorios = normalizarLista(equipo.accesorios);
  equipo.software = normalizarLista(equipo.software);
  equipo.fecha_actualizacion =
    equipo.fecha_actualizacion || texto(item?.lastModifiedDateTime);

  // Alias heredados que el frontend usa como respaldo.
  equipo.nombreusuario = equipo.usuario_actual;
  equipo.cedula = equipo.cedula_usuario;

  return equipo;
}

/* ------------------------------------------------------------
   Consultas de inventario
   ------------------------------------------------------------ */

/* ------------------------------------------------------------
   Búsqueda en vivo contra Microsoft Graph (sin caché)
   ------------------------------------------------------------ */

const CAMPO_PLACA = "fields/Placa";
const CAMPO_SERIAL = "fields/Serial_x0020_del_x0020_equipo";
const CAMPO_TITLE = "fields/Title";
const ORDEN_RECIENTES = "fields/Modified desc";

/** Compara placas ignorando espacios, guiones, puntos y barras. */
function compactarPlaca(valor) {
  return texto(valor)
    .normalize("NFC")
    .toUpperCase()
    .replace(/[\s.\-_/]+/g, "");
}

/**
 * Normaliza lo que escribe el usuario en Placa o Serial: mayúsculas y sin
 * espacios ni guiones. "ml-199865" → "ML199865"; "199865" → "199865".
 */
export function normalizarTextoBusqueda(valor) {
  return texto(valor).toUpperCase().replace(/[\s-]+/g, "");
}

/**
 * Variantes con las que se consulta Graph: el texto original, el normalizado,
 * la versión sin prefijo "ML" y, cuando el usuario escribe solo dígitos, la
 * placa completa con prefijo ("199865" → "ML-199865").
 */
function variantesBusqueda(valor) {
  const normalizado = normalizarTextoBusqueda(valor);
  const sinPrefijo = normalizado.replace(/^ML/, "");

  const candidatos = [texto(valor), normalizado, sinPrefijo];
  if (/^\d+$/.test(sinPrefijo)) {
    candidatos.push(`ML-${sinPrefijo}`, `ML${sinPrefijo}`);
  }

  const vistos = new Set();
  return candidatos.filter((candidato) => {
    const clave = candidato.toUpperCase();
    if (!clave || vistos.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
}

/** Prefijo seguro para localizar "ML-217050" aunque venga "ML- 217050". */
function prefijoPlaca(valor) {
  const compacta = texto(valor).replace(/\s+/g, "");
  const coincidencia = compacta.match(/^(\D*\d{0,2})/);
  return coincidencia?.[1] || compacta.slice(0, 3);
}

/** Filtro OData: prefijo en Placa, Serial o nombre en red (Title). */
function filtroPrefijo(termino) {
  const valor = escaparOdata(termino);
  return [
    `startswith(${CAMPO_PLACA},'${valor}')`,
    `startswith(${CAMPO_SERIAL},'${valor}')`,
    `startswith(${CAMPO_TITLE},'${valor}')`,
  ].join(" or ");
}

/** Filtro OData: coincidencia en cualquier posición de Placa, Serial o Title. */
function filtroContiene(termino) {
  const valor = escaparOdata(termino);
  return [
    `contains(${CAMPO_PLACA},'${valor}')`,
    `contains(${CAMPO_SERIAL},'${valor}')`,
    `contains(${CAMPO_TITLE},'${valor}')`,
  ].join(" or ");
}

/**
 * GET a la lista con orden por fecha de modificación. SharePoint no siempre
 * admite $orderby sobre fields/*, así que se reintenta sin orden y el
 * resultado se ordena en memoria.
 */
async function graphGetItems(opciones = {}) {
  const { avanzado = false } = opciones;
  await asegurarSiteIdInventario();
  try {
    return await graphGet(rutaItems(opciones), { avanzado });
  } catch (err) {
    if (opciones.orden && (err?.grafoStatus === 400 || err?.status === 400)) {
      return await graphGet(rutaItems({ ...opciones, orden: "" }), { avanzado });
    }
    throw err;
  }
}

/** Items ya ordenados por "Modified" descendente (o sin orden si falla). */
async function itemsRecientes({ filtro, top = 200, avanzado = false } = {}) {
  const datos = await graphGetItems({
    filtro,
    top,
    avanzado,
    orden: ORDEN_RECIENTES,
  });
  return datos.value || [];
}

const CAMPOS_BUSQUEDA = [CAMPO_PLACA, CAMPO_SERIAL, CAMPO_TITLE];

/** OR de startswith/contains/eq para varias variantes en los campos dados. */
function filtroVariantes(campos, variantes, operador) {
  return variantes
    .flatMap((variante) =>
      campos.map((campo) => {
        const valor = escaparOdata(variante);
        return operador === "eq"
          ? `${campo} eq '${valor}'`
          : `${operador}(${campo},'${valor}')`;
      })
    )
    .join(" or ");
}

/**
 * Consulta Placa/Serial/Title con todas las variantes del término
 * ("199865" incluido "ML-199865"). Si Graph rechaza el filtro combinado,
 * itemsConFiltros reintenta columna por columna.
 */
function itemsPorVariantes(termino, operador, top = 200) {
  const variantes = variantesBusqueda(termino);

  return itemsConFiltros(
    [
      filtroVariantes(CAMPOS_BUSQUEDA, variantes, operador),
      ...CAMPOS_BUSQUEDA.map((campo) =>
        filtroVariantes([campo], variantes, operador)
      ),
    ],
    top
  );
}

/** Prefijo en Placa/Serial/Title, escriba el usuario "ML-199865" o "199865". */
function itemsPorPrefijo(termino, top = 200) {
  return itemsPorVariantes(termino, "startswith", top);
}

/** Coincidencia en cualquier posición, con respaldo columna por columna. */
function itemsPorContiene(termino, top = 200) {
  return itemsPorVariantes(termino, "contains", top);
}

/**
 * Prueba primero el filtro combinado y, si Graph lo rechaza (HTTP 400),
 * consulta columna por columna. Así la búsqueda nunca se cae por una
 * limitación de OData en SharePoint.
 */
async function itemsConFiltros(filtros, top = 200) {
  const [combinado, ...porCampo] = filtros;

  try {
    return await itemsRecientes({ filtro: combinado, top, avanzado: true });
  } catch (err) {
    if (err?.grafoStatus !== 400) throw err;
  }

  const filas = [];
  for (const filtro of porCampo) {
    try {
      const parcial = await itemsRecientes({ filtro, top, avanzado: true });
      if (parcial.length) filas.push(...parcial);
    } catch (err) {
      if (err?.grafoStatus !== 400) throw err;
    }
  }
  return filas;
}

/** Fecha de modificación en milisegundos (0 si no se puede interpretar). */
function tiempoModificado(equipo) {
  const valor = Date.parse(equipo?.fecha_actualizacion || "");
  return Number.isFinite(valor) ? valor : 0;
}

/** Más recientes primero; ante empate, placa ascendente. */
function ordenarPorRecientes(equipos) {
  return equipos.sort((a, b) => {
    const diferencia = tiempoModificado(b) - tiempoModificado(a);
    if (diferencia) return diferencia;
    return a.placa.localeCompare(b.placa, "es", {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/** Todos los tokens deben aparecer en Placa, Serial o nombre en red. */
function coincideConTokens(equipo, tokens) {
  const heno = [
    compactarPlaca(equipo.placa),
    compactarPlaca(equipo.serial),
    compactarPlaca(equipo.hostname),
  ].join("|");
  return tokens.every((token) => heno.includes(token));
}

/**
 * GET /api/equipos/buscar?q=
 * Consulta Microsoft Graph en vivo (sin caché). Busca por prefijo y, si no
 * hay resultados, por coincidencia en Placa, Serial o nombre en red. Ignora
 * espacios/guiones extra y prioriza los registros modificados más recientemente.
 */
export async function buscarEquiposGraph(consulta = "") {
  const q = texto(consulta).replace(/\s+/g, " ").slice(0, 100);
  if (!q) return { equipos: [], modo: "vacio" };

  const tokens = q.split(" ").map(compactarPlaca).filter(Boolean);
  const primero = q.split(" ")[0];
  const modos = [];
  let filas = [];

  // 1) Prefijo en Placa, Serial o Title (la consulta más barata).
  filas = await itemsPorPrefijo(primero);
  if (filas.length) modos.push("prefijo");

  // 2) Coincidencia en cualquier posición (equipo nuevo con placa rara).
  if (!filas.length) {
    filas = await itemsPorContiene(primero);
    if (filas.length) modos.push("contiene");
  }

  // 3) Respaldo: prefijo recortado ("ML- 217050" → "ML-21").
  if (!filas.length) {
    const recorte = prefijoPlaca(primero);
    if (recorte && recorte !== primero) {
      filas = await itemsPorPrefijo(recorte);
      if (filas.length) modos.push("prefijo-recortado");
    }
  }

  const equipos = ordenarPorRecientes(
    filas
      .map(mapearItem)
      .filter((equipo) => equipo.placa && coincideConTokens(equipo, tokens))
  ).slice(0, 30);

  return { equipos, modo: modos.join("+") || "sin-resultados" };
}

/**
 * true si la Placa, el Serial o el nombre en red del registro equivalen al
 * texto buscado ignorando espacios, guiones y el prefijo "ML-".
 * Así "199865" encuentra "ML-199865" y viceversa.
 */
function coincideExacto(fila, objetivo) {
  if (!objetivo) return false;

  const sinPrefijo = objetivo.replace(/^ML/, "");
  const claves = new Set([objetivo, sinPrefijo, `ML${sinPrefijo}`]);
  const campos = fila?.fields || {};

  return [
    campos.Placa,
    campos.Serial_x0020_del_x0020_equipo,
    campos.Title,
  ].some((valorCampo) => {
    const compacto = compactarPlaca(valorCampo);
    if (!compacto) return false;
    return claves.has(compacto) || compacto.replace(/^ML/, "") === sinPrefijo;
  });
}

/**
 * Busca un equipo exacto por Placa y, como respaldo, por Serial o nombre en
 * red. Acepta la placa con o sin prefijo "ML-" ("199865" = "ML-199865") y
 * compara valores compactos (sin espacios ni guiones).
 */
export async function buscarEquipoGraph(placa) {
  const valor = texto(placa).slice(0, 100);
  if (!valor) return null;

  // Al validar una placa se fuerza que el contador superior se refresque.
  invalidarConteo();

  const objetivo = normalizarTextoBusqueda(valor);
  const variantes = variantesBusqueda(valor);

  // 1) Coincidencia exacta en Placa/Serial/Title con todas las variantes.
  try {
    const datos = await graphGetItems({
      filtro: filtroVariantes(CAMPOS_BUSQUEDA, variantes, "eq"),
      top: 10,
      orden: ORDEN_RECIENTES,
    });
    const item = (datos.value || []).find((fila) =>
      coincideExacto(fila, objetivo)
    );
    if (item) return mapearItem(item);
  } catch (err) {
    if (err?.grafoStatus !== 400) throw err;
  }

  // 2) Respaldo: prefijo de cada variante y comparación compacta.
  for (const variante of variantes) {
    const candidatos = await itemsPorPrefijo(variante);
    const item = candidatos.find((fila) => coincideExacto(fila, objetivo));
    if (item) return mapearItem(item);
  }

  return null;
}

/** Lista acotada de equipos (respaldo de GET /api/equipos?q=). */
export async function listarEquiposGraph(limite = 20) {
  const tope = Math.min(100, Math.max(1, Number(limite) || 20));
  const datos = await graphGetItems({ top: tope, orden: ORDEN_RECIENTES });

  return ordenarPorRecientes(
    (datos.value || []).map(mapearItem).filter((equipo) => equipo.placa)
  ).slice(0, tope);
}

let cacheConteo = { valor: null, expira: 0 };

/* El contador superior debe reflejar equipos nuevos con rapidez: 60 segundos. */
const TTL_CONTEO_MS = 60 * 1000;

/** Total de equipos de la lista (se cachea 60 segundos). */
export async function contarEquiposGraph() {
  if (cacheConteo.valor !== null && cacheConteo.expira > Date.now()) {
    return cacheConteo.valor;
  }

  await asegurarSiteIdInventario();
  const { siteId, listId } = configGraph();

  // La API de listas de SharePoint no admite $count=true ("$count is not
  // supported on this API"). Por eso se pagina con @odata.nextLink y
  // $select=id para traer solo los identificadores.
  let ruta = `/sites/${encodeURI(siteId)}/lists/${encodeURIComponent(
    listId
  )}/items?$select=id&$top=999`;

  let total = 0;
  let paginas = 0;

  while (ruta && paginas < 200) {
    const datos = await graphGet(ruta);
    total += Array.isArray(datos.value) ? datos.value.length : 0;
    ruta = datos["@odata.nextLink"] || "";
    paginas += 1;
  }

  cacheConteo = {
    valor: total,
    expira: Date.now() + TTL_CONTEO_MS,
  };
  return cacheConteo.valor;
}

/** Fuerza una nueva lectura del total en la próxima consulta. */
export function invalidarConteo() {
  cacheConteo = { valor: null, expira: 0 };
}

/* ------------------------------------------------------------
   Biblioteca de actas en SharePoint (NubeLevapan / DATAFILE)
   ------------------------------------------------------------ */

/* Ruta del sitio tal como la acepta Microsoft Graph. */
const SITIO_ACTAS = "colevapan.sharepoint.com:/sites/NubeLevapan";

/* ------------------------------------------------------------
   Sitio del inventario (lista de equipos)
   ------------------------------------------------------------
   SITE_ID debe llegar completo desde el entorno. Si la variable se
   copió incompleta (pasa en paneles en la nube), se resuelve sola
   con la ruta del sitio para que el inventario siga funcionando.
   ------------------------------------------------------------ */
const SITIO_INVENTARIO =
  texto(process.env.SHAREPOINT_SITE_PATH) || "/sites/Informatica_Tecnologia";

const RE_SITE_ID =
  /^[^,]+,[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12},[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function asegurarSiteIdInventario() {
  const actual = texto(process.env.SITE_ID || process.env.SHAREPOINT_SITE_ID);
  if (RE_SITE_ID.test(actual)) return actual;

  const host = texto(process.env.SHAREPOINT_HOST) || "colevapan.sharepoint.com";
  const datos = await graphGet(`/sites/${host}:${SITIO_INVENTARIO}`);
  const siteId = texto(datos?.id);

  if (!siteId) {
    throw new Error(
      "Microsoft Graph no devolvió el siteId del sitio del inventario."
    );
  }

  process.env.SITE_ID = siteId;
  console.warn(
    `[GRAPH] SITE_ID incompleto (${actual.length} caracteres). ` +
      `Se resolvió automáticamente como ${siteId}.`
  );
  return siteId;
}

/* Biblioteca de documentos donde se archivan los PDF. */
const BIBLIOTECA_ACTAS = "DATAFILE";

/* Carpeta interna (relativa a la raíz de la biblioteca). Se resuelve contra
   los nombres reales de SharePoint, que llevan tilde: "Tecnología". */
const SEGMENTOS_CARPETA_ACTAS = [
  "Informatica y Tecnologia",
  "Equipo Infraestructura",
  "Actas de equipos",
];

/* El siteId, el driveId y la carpeta cambian muy poco: se cachean 30 min. */
const TTL_DESTINO_ACTAS_MS = 30 * 60 * 1000;
let cacheSitioActas = { siteId: "", expira: 0 };
let cacheDriveActas = {
  driveId: "",
  nombre: "",
  webUrl: "",
  expira: 0,
};
let cacheCarpetaActas = { ruta: "", expira: 0 };

/** Compara nombres ignorando tildes, mayúsculas y espacios extra. */
function normalizarSegmento(valor) {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Codifica una ruta relativa sin perder las barras separadoras. */
function codificarRuta(ruta) {
  return String(ruta ?? "")
    .split("/")
    .filter((parte) => parte !== "")
    .map(encodeURIComponent)
    .join("/");
}

/** GET /sites/colevapan.sharepoint.com:/sites/NubeLevapan → siteId. */
export async function obtenerSiteIdActas() {
  if (cacheSitioActas.siteId && cacheSitioActas.expira > Date.now()) {
    return cacheSitioActas.siteId;
  }

  const datos = await graphGet(`/sites/${SITIO_ACTAS}`);
  const siteId = texto(datos?.id);
  if (!siteId) {
    throw errorHttp(
      "Microsoft Graph no devolvió el siteId del sitio NubeLevapan.",
      502,
      { causa: "sharepoint" }
    );
  }

  cacheSitioActas = {
    siteId,
    expira: Date.now() + TTL_DESTINO_ACTAS_MS,
  };
  return siteId;
}

/** Localiza el driveId de la biblioteca "DATAFILE" dentro del sitio. */
export async function obtenerDriveActas(siteId = "") {
  if (cacheDriveActas.driveId && cacheDriveActas.expira > Date.now()) {
    return cacheDriveActas;
  }

  const idSitio = texto(siteId) || (await obtenerSiteIdActas());
  const datos = await graphGet(
    `/sites/${encodeURI(idSitio)}/drives?$select=id,name,webUrl,driveType`
  );
  const drives = Array.isArray(datos?.value) ? datos.value : [];
  const objetivo = BIBLIOTECA_ACTAS.toLowerCase();

  const drive =
    drives.find((item) => texto(item.name).toLowerCase() === objetivo) ||
    drives.find((item) =>
      texto(item.webUrl).toLowerCase().endsWith(`/${objetivo}`)
    );

  if (!drive?.id) {
    const disponibles = drives
      .map((item) => texto(item.name))
      .filter(Boolean)
      .join(", ");
    throw errorHttp(
      `No se encontró la biblioteca "${BIBLIOTECA_ACTAS}" en NubeLevapan. ` +
        `Bibliotecas visibles: ${disponibles || "ninguna"}. ` +
        "Verifica el permiso Sites.ReadWrite.All de la aplicación.",
      404,
      { causa: "sharepoint" }
    );
  }

  cacheDriveActas = {
    driveId: texto(drive.id),
    nombre: texto(drive.name),
    webUrl: texto(drive.webUrl),
    expira: Date.now() + TTL_DESTINO_ACTAS_MS,
  };
  return cacheDriveActas;
}

/** PUT del PDF con reintentos (429, 5xx y cortes de red). */
async function graphPutArchivo(ruta, bytes) {
  const config = configGraph();
  if (!config.configurado) {
    throw errorHttp(
      `Microsoft Graph no está configurado. Faltan: ${config.faltantes.join(", ")}.`,
      503
    );
  }

  const intentos = 3;
  let ultimoError = null;

  for (let intento = 1; intento <= intentos; intento += 1) {
    let respuesta;
    try {
      const token = await obtenerToken({
        forzar: intento > 1 && ultimoError?.grafoStatus === 401,
      });

      respuesta = await fetch(`${GRAPH}${ruta}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/pdf",
          Accept: "application/json",
        },
        body: bytes,
        // La subida puede tardar más que una consulta normal.
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      if (err?.status) throw err;

      ultimoError = errorHttp(
        `No se pudo contactar Microsoft Graph: ${err.message}`,
        502,
        { causa: "red" }
      );
      if (intento === intentos) break;
      await dormir(600 * intento);
      continue;
    }

    if (respuesta.status === 429 || respuesta.status >= 500) {
      const espera =
        Number(respuesta.headers.get("retry-after")) * 1000 || 800 * intento;
      ultimoError = errorHttp(
        `Microsoft Graph no está disponible (HTTP ${respuesta.status}).`,
        502,
        { grafoStatus: respuesta.status }
      );
      if (intento === intentos) break;
      await dormir(Math.min(espera, 8000));
      continue;
    }

    if (!respuesta.ok) {
      const detalle = await detalleError(respuesta);
      throw errorHttp(
        `Microsoft Graph rechazó la subida del acta (HTTP ${respuesta.status}): ${detalle}`,
        respuesta.status === 404 ? 404 : 502,
        { grafoStatus: respuesta.status }
      );
    }

    return await respuesta.json();
  }

  throw (
    ultimoError ||
    errorHttp("No se pudo subir el acta a SharePoint.", 502, { causa: "red" })
  );
}

/**
 * Recorre la biblioteca y devuelve la ruta real de la carpeta de actas.
 * SharePoint guarda "Informatica y Tecnología" con tilde, así que cada
 * segmento se compara ignorando tildes y mayúsculas.
 */
async function resolverCarpetaActas(driveId) {
  if (cacheCarpetaActas.ruta && cacheCarpetaActas.expira > Date.now()) {
    return cacheCarpetaActas.ruta;
  }

  const partes = [];
  let rutaActual = "";

  for (const segmento of SEGMENTOS_CARPETA_ACTAS) {
    let real = segmento;

    try {
      const base = rutaActual
        ? `/drives/${encodeURIComponent(driveId)}/root:/${codificarRuta(
            rutaActual
          )}:/children`
        : `/drives/${encodeURIComponent(driveId)}/root/children`;
      const datos = await graphGet(
        `${base}?$select=name,folder&$top=200`
      );
      const carpetas = (Array.isArray(datos?.value) ? datos.value : []).filter(
        (item) => item.folder
      );
      const encontrada = carpetas.find(
        (item) =>
          normalizarSegmento(item.name) === normalizarSegmento(segmento)
      );
      if (encontrada?.name) real = encontrada.name;
    } catch (err) {
      // Si la carpeta aún no existe se conserva el nombre configurado y
      // Microsoft Graph la crea al subir el primer PDF.
      if (err?.grafoStatus !== 404 && err?.status !== 404) throw err;
    }

    partes.push(real);
    rutaActual = partes.join("/");
  }

  cacheCarpetaActas = {
    ruta: rutaActual,
    expira: Date.now() + TTL_DESTINO_ACTAS_MS,
  };
  return cacheCarpetaActas.ruta;
}

/** true si ya existe un archivo o carpeta en esa ruta del drive. */
async function existeEnDrive(driveId, ruta) {
  try {
    await graphGet(
      `/drives/${encodeURIComponent(driveId)}/root:/${codificarRuta(ruta)}`
    );
    return true;
  } catch (err) {
    if (err?.grafoStatus === 404 || err?.status === 404) return false;
    throw err;
  }
}

/** Añade "_AAAAMMDD-HHMMSS" si el nombre ya existe (no sobrescribe actas). */
async function nombreLibre(driveId, carpeta, nombre) {
  if (!(await existeEnDrive(driveId, `${carpeta}/${nombre}`))) return nombre;

  const punto = nombre.lastIndexOf(".");
  const base = punto > 0 ? nombre.slice(0, punto) : nombre;
  const extension = punto > 0 ? nombre.slice(punto) : ".pdf";
  const sello = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");

  let candidato = `${base}_${sello}${extension}`;
  let sufijo = 1;
  while (await existeEnDrive(driveId, `${carpeta}/${candidato}`)) {
    candidato = `${base}_${sello}-${sufijo}${extension}`;
    sufijo += 1;
    if (sufijo > 9) break;
  }
  return candidato;
}

/**
 * Sube un acta PDF a
 * NubeLevapan > DATAFILE > Informatica y Tecnologia > Equipo Infraestructura
 * > Actas de equipos.
 *
 * @param {{ nombreArchivo: string, pdfBuffer: Buffer|Uint8Array,
 *           evitarSobrescritura?: boolean }} opciones
 * @returns {Promise<{webUrl: string, id: string, name: string}>}
 */
export async function subirActaSharePoint({
  nombreArchivo,
  pdfBuffer,
  evitarSobrescritura = true,
} = {}) {
  const nombre = texto(nombreArchivo);
  if (!nombre) {
    throw errorHttp("Falta el nombre del archivo del acta.", 400);
  }

  const bytes = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer
    : Buffer.from(pdfBuffer || []);
  if (!bytes.length) {
    throw errorHttp("El PDF del acta está vacío.", 400);
  }

  const siteId = await obtenerSiteIdActas();
  const drive = await obtenerDriveActas(siteId);
  const carpeta = await resolverCarpetaActas(drive.driveId);

  const destino = evitarSobrescritura
    ? await nombreLibre(drive.driveId, carpeta, nombre)
    : nombre;

  const ruta = codificarRuta(`${carpeta}/${destino}`);
  const subida = await graphPutArchivo(
    `/drives/${encodeURIComponent(drive.driveId)}/root:/${ruta}:/content`,
    bytes
  );

  return {
    webUrl: texto(subida?.webUrl),
    id: texto(subida?.id),
    name: texto(subida?.name) || destino,
    siteId,
    driveId: drive.driveId,
    biblioteca: drive.nombre,
    carpeta,
  };
}

/**
 * Diagnóstico del destino de actas: siteId, driveId de DATAFILE y si la
 * carpeta "Actas de equipos" existe. Se usa en GET /api/actas/destino.
 */
export async function verificarDestinoActas() {
  const siteId = await obtenerSiteIdActas();
  const drive = await obtenerDriveActas(siteId);
  const carpeta = await resolverCarpetaActas(drive.driveId);

  let existeCarpeta = false;
  let errorCarpeta = "";

  try {
    const datos = await graphGet(
      `/drives/${encodeURIComponent(drive.driveId)}/root:/${codificarRuta(
        carpeta
      )}`
    );
    existeCarpeta = Boolean(datos?.id || datos?.name);
  } catch (err) {
    errorCarpeta = err?.message || "error desconocido";
  }

  return {
    siteId,
    driveId: drive.driveId,
    biblioteca: drive.nombre,
    webUrlBiblioteca: drive.webUrl,
    carpeta,
    carpetaSolicitada: SEGMENTOS_CARPETA_ACTAS.join("/"),
    existeCarpeta,
    errorCarpeta: errorCarpeta || undefined,
  };
}

/* ------------------------------------------------------------
   Carpeta compartida exacta (enlace /:f:/ de SharePoint)
   ------------------------------------------------------------ */

const SHARE_URL =
  "https://colevapan.sharepoint.com/:f:/s/NubeLevapan/IgBGCATbRKM-Q59DFGf3cUEwAQTDOT0uF1zX-5lrhhd8NPg";

/* Codificación oficial de Microsoft Graph para enlaces compartidos. */
const SHARE_ID =
  "u!" +
  Buffer.from(SHARE_URL, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\//g, "_")
    .replace(/\+/g, "-");

/* El driveId/itemId de una carpeta compartida no cambia: caché de 30 min. */
let cacheCarpetaCompartida = {
  driveId: "",
  itemId: "",
  nombre: "",
  webUrl: "",
  carpeta: "",
  expira: 0,
};

/**
 * GET /shares/{shareId}/driveItem → { driveId, itemId } de la carpeta exacta
 * del enlace compartido. Se cachea en memoria para no repetir la consulta.
 */
export async function resolverCarpetaCompartida({ forzar = false } = {}) {
  if (
    !forzar &&
    cacheCarpetaCompartida.driveId &&
    cacheCarpetaCompartida.expira > Date.now()
  ) {
    return cacheCarpetaCompartida;
  }

  const datos = await graphGet(`/shares/${SHARE_ID}/driveItem`);
  const driveId = texto(datos?.parentReference?.driveId);
  const itemId = texto(datos?.id);

  if (!driveId || !itemId) {
    throw errorHttp(
      "Microsoft Graph no devolvió la carpeta del enlace compartido.",
      502,
      { causa: "sharepoint" }
    );
  }

  const rutaPadre = texto(datos?.parentReference?.path);
  cacheCarpetaCompartida = {
    driveId,
    itemId,
    nombre: texto(datos?.name),
    webUrl: texto(datos?.webUrl),
    carpeta: rutaPadre
      ? `${rutaPadre}/${texto(datos?.name)}`.replace(/\/+/g, "/")
      : texto(datos?.name),
    expira: Date.now() + TTL_DESTINO_ACTAS_MS,
  };
  return cacheCarpetaCompartida;
}

/**
 * Sube el PDF dentro de la carpeta exacta del enlace compartido:
 *   PUT /drives/{driveId}/items/{itemId}:/{nombreArchivo}:/content
 *
 * Nunca lanza una excepción por errores de Graph: devuelve
 * { ok: false, status, error } para que el servidor pueda seguir
 * guardando la copia local (y usar Power Automate como respaldo).
 *
 * @param {{ nombreArchivo: string, pdfBuffer: Buffer|Uint8Array }} opciones
 * @returns {Promise<{ok: boolean, webUrl?: string, id?: string, name?: string,
 *           carpeta?: string, status?: number, error?: string}>}
 */
export async function subirActaCarpetaCompartida({
  nombreArchivo,
  pdfBuffer,
} = {}) {
  const nombre = texto(nombreArchivo);
  if (!nombre) {
    return { ok: false, status: 400, error: "Falta el nombre del archivo del acta." };
  }

  const bytes = Buffer.isBuffer(pdfBuffer)
    ? pdfBuffer
    : Buffer.from(pdfBuffer || []);
  if (!bytes.length) {
    return { ok: false, status: 400, error: "El PDF del acta está vacío." };
  }

  try {
    const destino = await resolverCarpetaCompartida();
    const subida = await graphPutArchivo(
      `/drives/${encodeURIComponent(destino.driveId)}/items/${encodeURIComponent(
        destino.itemId
      )}:/${encodeURIComponent(nombre)}:/content`,
      bytes
    );

    return {
      ok: true,
      webUrl: texto(subida?.webUrl),
      id: texto(subida?.id),
      name: texto(subida?.name) || nombre,
      carpeta: texto(subida?.parentReference?.path) || destino.carpeta,
      driveId: destino.driveId,
      itemId: destino.itemId,
    };
  } catch (err) {
    const status = err?.grafoStatus || err?.status || 502;
    const mensaje = err?.message || "error desconocido";
    console.warn(
      `[ACTA] La carpeta compartida rechazó la subida (HTTP ${status}): ${mensaje}`
    );
    return {
      ok: false,
      status,
      error: mensaje,
      carpeta: cacheCarpetaCompartida.carpeta || undefined,
    };
  }
}

