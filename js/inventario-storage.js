/* ============================================================
   inventario-storage.js | Acta de Tecnología - Levapan
   ------------------------------------------------------------
   Este archivo contiene toda la lógica de la aplicación:

   1) Consulta del inventario SQLite por Placa a través de
      server.js (/api/equipos) y autorrelleno del formulario.
      Si el servidor no responde, usa ./data/inventario.json.
   2) Envío del acta al servidor (/api/actas), que guarda el PDF
      en Actas_Guardadas, registra el historial y actualiza el
      responsable del equipo en SQLite.
   3) Respaldo local con File System Access API + IndexedDB o
      descarga tradicional si el servidor no está disponible.
   4) Generación de un PDF estructurado con pdf-lib.
   5) Envío opcional del PDF a un webhook de Power Automate.
   ============================================================ */

/* ------------------------------------------------------------
   WEBHOOK (Microsoft Power Automate -> OneDrive/SharePoint)
   Pega aquí la URL del flujo "When an HTTP request is received".
   Payload enviado: { filename, fileBase64 }
   Si se deja vacío (""), no se envía nada.
   ------------------------------------------------------------ */
const WEBHOOK_URL = "";

/* API local (server.js). Si se deja vacío se usa el mismo origen. */
const API_BASE = "";

const DB_NAME = "ActaLevapanDB";
const STORE_CONFIG = "config";
const INVENTARIO_JSON_PATH = "./data/inventario.json";

/* Estado de la conexión con el servidor SQLite. */
let servidorActivo = false;
let infoServidor = null;
let equipoActual = null;

/* ---------------- Utilidades generales ---------------- */

function normalizarTexto(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function normalizarClave(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Deja un texto apto para nombre de archivo. */
function sanitizarArchivo(texto, respaldo = "SIN_DATO") {
  const limpio = String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/[. ]+$/, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return limpio || respaldo;
}

/**
 * Las fuentes estándar de PDF usan WinAnsi: no admiten emojis ni algunos
 * símbolos. Se reemplazan para que la generación nunca falle.
 */
const CARACTERES_NO_WINANSI = /[^\t\n\r\u0020-\u007E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g;

function limpiarTextoPdf(texto) {
  return String(texto ?? "")
    .normalize("NFC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2022/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(CARACTERES_NO_WINANSI, "?");
}

function fechaCorta(fecha) {
  const d = String(fecha.getDate()).padStart(2, "0");
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  return `${d}/${m}/${fecha.getFullYear()}`;
}

function fechaHora(fecha) {
  return fecha.toLocaleString("es-CO", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function leerArchivoComoDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Convierte una firma exportada como data URL PNG a bytes para pdf-lib. */
function dataUrlABytes(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  if (!base64) throw new Error("La firma está vacía");
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) {
    bytes[i] = binario.charCodeAt(i);
  }
  return bytes;
}

/* ---------------- IndexedDB (carpeta destino) ---------------- */

function abrirDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function guardarHandle(handle) {
  const db = await abrirDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CONFIG, "readwrite");
    tx.objectStore(STORE_CONFIG).put(handle, "directorio");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function leerHandle() {
  try {
    const db = await abrirDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_CONFIG, "readonly");
      const req = tx.objectStore(STORE_CONFIG).get("directorio");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn("No se pudo leer la carpeta guardada:", err);
    return null;
  }
}

/* ---------------- Carpeta destino ---------------- */

let carpetaHandle = null;

function soporteFileSystemAccess() {
  return typeof window.showDirectoryPicker === "function";
}

function mostrarEstadoCarpeta(mensaje, tipo = "") {
  const el = document.getElementById("folderStatus");
  if (!el) return;
  el.textContent = mensaje;
  el.className = `estado ${tipo}`.trim();
}

function actualizarEstadoCarpeta(handle) {
  if (servidorActivo && infoServidor?.pdfDir) {
    mostrarEstadoCarpeta(
      handle
        ? `Servidor: ${infoServidor.pdfDir} · Respaldo: ${handle.name}`
        : `Servidor: ${infoServidor.pdfDir}`,
      "ok"
    );
  } else if (handle) {
    mostrarEstadoCarpeta(`Guardando en: ${handle.name}`, "ok");
  } else if (location.protocol === "file:") {
    mostrarEstadoCarpeta("Abre en localhost/HTTPS para guardar en carpeta");
  } else if (!soporteFileSystemAccess()) {
    mostrarEstadoCarpeta("Navegador sin soporte de carpetas");
  } else {
    mostrarEstadoCarpeta("Ninguna carpeta vinculada");
  }
}

async function configurarCarpetaDestino() {
  if (location.protocol === "file:") {
    alert(
      "⚠️ Abriste la página como archivo local (file:///).\n\n" +
        "Para vincular una carpeta y guardar las actas automáticamente, abre la página desde " +
        "http://localhost o https:// (por ejemplo, GitHub Pages).\n\n" +
        "Mientras tanto, el acta se descargará de forma tradicional."
    );
    return;
  }

  if (!soporteFileSystemAccess()) {
    alert(
      "⚠️ Tu navegador no soporta la API de carpetas (File System Access).\n\n" +
        "Usa Google Chrome o Microsoft Edge actualizado y abre la página en " +
        "http://localhost o https://.\n\n" +
        "Mientras tanto, el acta se descargará de forma tradicional."
    );
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    carpetaHandle = handle;
    await guardarHandle(handle);
    actualizarEstadoCarpeta(handle);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.error("Error al seleccionar la carpeta:", err);
    alert("No se pudo vincular la carpeta: " + (err.message || err));
  }
}

/** Garantiza permiso de escritura sobre la carpeta vinculada. */
async function asegurarPermiso(handle) {
  if (!handle || typeof handle.queryPermission !== "function") return false;
  const opciones = { mode: "readwrite" };
  try {
    if ((await handle.queryPermission(opciones)) === "granted") return true;
    if ((await handle.requestPermission(opciones)) === "granted") return true;
  } catch (err) {
    console.warn("No se pudo obtener el permiso de escritura:", err);
  }
  return false;
}

/** Guarda bytes en la raíz de la carpeta vinculada. */
async function guardarBytesEnCarpeta(handle, bytes, nombreArchivo) {
  const fileHandle = await handle.getFileHandle(nombreArchivo, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return nombreArchivo;
}

function descargarArchivo(bytes, nombreArchivo, tipoMime) {
  const blob = new Blob([bytes], { type: tipoMime });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------------- Catálogo de equipos (listas en cascada) ---------------- */

const TIPOS_EQUIPO = [
  "Access Point",
  "Apuntador",
  "Base de Carga Terminales",
  "CPU",
  "Cuna para Baterías",
  "Handheld",
  "Impresora",
  "Impresora portátil",
  "Jabra",
  "Módem",
  "Monitor",
  "Portátil",
  "Proyector",
  "Switch",
  "Tablet",
  "Terminal",
  "UPS",
];

/* Catálogo original de listas.js, integrado aquí para no depender de sus
   referencias al formulario antiguo (nameTi, tipoEquipo, etc.). */
const EQUIPOS_POR_TIPO = {
  CPU: {
    marcas: ["Dell", "HP", "Lenovo", "Acer"],
    modelosPorMarca: {
      Dell: ["OptiPlex 3070", "OptiPlex 3080", "OptiPlex 5070", "OptiPlex 7070", "Vostro 3670"],
      HP: ["EliteDesk 800 G4", "EliteDesk 800 G5", "ProDesk 400 G5", "ProDesk 600 G4"],
      Lenovo: ["ThinkCentre M720", "ThinkCentre M90", "ThinkCentre M710", "IdeaCentre 520"],
      Acer: ["Aspire TC", "Veriton M4620G", "Veriton M480G"],
    },
  },
  Handheld: {
    marcas: ["Zebra", "Honeywell"],
    modelosPorMarca: {
      Zebra: ["TC52", "TC57", "MC3300", "MC9300"],
      Honeywell: ["Dolphin 75e", "Dolphin 99EX", "ScanPal EDA50K"],
    },
  },
  Impresora: {
    marcas: ["HP", "Epson", "Brother", "Canon"],
    modelosPorMarca: {
      HP: ["LaserJet Pro M404n", "LaserJet Enterprise M406", "Color LaserJet Pro M454dn"],
      Epson: ["WorkForce Pro WF-4830", "WorkForce Enterprise WF-M5799"],
      Brother: ["HL-L8360CDW", "MFC-L8610CDW", "HL-L2350DW"],
      Canon: ["imageRUNNER 2425i", "imageCLASS MF445dw"],
    },
  },
  "Impresora portátil": {
    marcas: ["Zebra", "Brother"],
    modelosPorMarca: {
      Zebra: ["ZQ520", "ZQ620", "MC705"],
      Brother: ["RL-700S", "RL-900"],
    },
  },
  Jabra: {
    marcas: ["Jabra"],
    modelosPorMarca: {
      Jabra: ["Evolve 65", "Evolve 85", "Evolve2 85", "Speak 750", "Speak 810"],
    },
  },
  Monitor: {
    marcas: ["Dell", "HP", "LG", "Samsung"],
    modelosPorMarca: {
      Dell: ["U2422H", "U2720Q", "P2423D", "S2722DC"],
      HP: ["E24 G4", "E27 G4", "Z27", "Z32"],
      LG: ["24UP550-W", "27UP550-W", "34UP550-W"],
      Samsung: ["M5 S27BM50", "M7 S32BM70", "ViewFinity S6"],
    },
  },
  Portátil: {
    marcas: ["Dell", "HP", "Lenovo", "Acer", "Asus", "Apple"],
    modelosPorMarca: {
      Dell: ["Latitude 3410", "Latitude 5420", "Latitude 7420", "Inspiron 15 5000"],
      HP: ["ProBook 440 G8", "ProBook 440 G9", "ProBook 440 G10", "ProBook 440 G11", "ProBook 4 G1i 14"],
      Lenovo: ["ThinkPad E14", "ThinkPad E15", "ThinkPad L15", "ThinkPad T14s", "ThinkPad P16v Gen 2"],
      Acer: ["Aspire 5", "TravelMate P4 14", "TravelMate P6 15"],
      Asus: ["VivoBook 15", "ZenBook 14", "ExpertBook B1"],
      Apple: ["MacBook Air M1", "MacBook Air M2", "MacBook Pro m4 Pro"],
    },
  },
  Proyector: {
    marcas: ["Epson", "BenQ"],
    modelosPorMarca: {
      Epson: ["PowerLite E20", "PowerLite E30", "PowerLite 2250U", "EB-2250U"],
      BenQ: ["MW535A", "MX535A", "TH671ST", "LH630"],
    },
  },
  Tablet: {
    marcas: ["Apple", "Samsung", "Lenovo"],
    modelosPorMarca: {
      Apple: ["iPad Air 4", "iPad Air 5", "iPad Pro 11", "iPad Pro 12.9"],
      Samsung: ["Galaxy Tab S6", "Galaxy Tab S7", "Galaxy Tab A7", "Galaxy Tab A"],
      Lenovo: ["Tab P11 Pro", "Tab M10", "Tab P12"],
    },
  },
};

/* Valores del inventario que no existen en el catálogo. Se recuerdan para
   que sigan apareciendo al cambiar de Tipo o Marca. */
const extrasTipos = new Set();
const extrasMarcas = new Map(); // tipoNormalizado -> [marca]
const extrasModelos = new Map(); // tipoNormalizado|marcaNormalizada -> [modelo]

function claveCatalogo(tipo, marca = "") {
  return `${normalizarTexto(tipo)}|${normalizarTexto(marca)}`;
}

/** Une listas de texto sin duplicados (ignorando mayúsculas y tildes). */
function unirValores(...listas) {
  const salida = [];
  listas.flat(Infinity).forEach((valor) => {
    const texto = String(valor ?? "").trim();
    if (!texto) return;
    const yaExiste = salida.some(
      (existente) => normalizarTexto(existente) === normalizarTexto(texto)
    );
    if (!yaExiste) salida.push(texto);
  });
  return salida;
}

function agregarExtraTipo(tipo) {
  const valor = String(tipo ?? "").trim();
  if (!valor) return;
  const yaExiste = TIPOS_EQUIPO.some(
    (base) => normalizarTexto(base) === normalizarTexto(valor)
  );
  if (!yaExiste) extrasTipos.add(valor);
}

function agregarExtraMarca(tipo, marca) {
  const clave = normalizarTexto(tipo);
  const valor = String(marca ?? "").trim();
  if (!clave || !valor) return;

  const base = EQUIPOS_POR_TIPO[tipo]?.marcas || [];
  if (base.some((m) => normalizarTexto(m) === normalizarTexto(valor))) return;

  if (!extrasMarcas.has(clave)) extrasMarcas.set(clave, []);
  const lista = extrasMarcas.get(clave);
  if (!lista.some((m) => normalizarTexto(m) === normalizarTexto(valor))) {
    lista.push(valor);
  }
}

function agregarExtraModelo(tipo, marca, modelo) {
  const clave = claveCatalogo(tipo, marca);
  const valor = String(modelo ?? "").trim();
  if (!clave || !valor) return;

  const base = EQUIPOS_POR_TIPO[tipo]?.modelosPorMarca?.[marca] || [];
  if (base.some((m) => normalizarTexto(m) === normalizarTexto(valor))) return;

  if (!extrasModelos.has(clave)) extrasModelos.set(clave, []);
  const lista = extrasModelos.get(clave);
  if (!lista.some((m) => normalizarTexto(m) === normalizarTexto(valor))) {
    lista.push(valor);
  }
}

function valoresTipos() {
  return unirValores(TIPOS_EQUIPO, [...extrasTipos]);
}

function valoresMarcas(tipo) {
  if (!tipo) return [];
  return unirValores(
    EQUIPOS_POR_TIPO[tipo]?.marcas || [],
    extrasMarcas.get(normalizarTexto(tipo)) || []
  );
}

function valoresModelos(tipo, marca) {
  if (!tipo || !marca) return [];
  return unirValores(
    EQUIPOS_POR_TIPO[tipo]?.modelosPorMarca?.[marca] || [],
    extrasModelos.get(claveCatalogo(tipo, marca)) || []
  );
}

/** Reemplaza las opciones de un select conservando un valor si existe. */
function llenarSelect(select, valores, etiqueta, seleccionado = "") {
  if (!select) return;
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = etiqueta;
  select.appendChild(placeholder);

  valores.forEach((valor) => {
    const option = document.createElement("option");
    option.value = valor;
    option.textContent = valor;
    select.appendChild(option);
  });

  const existe = seleccionado
    ? [...select.options].find(
        (option) =>
          option.value !== "" &&
          normalizarTexto(option.value) === normalizarTexto(seleccionado)
      )
    : null;
  select.value = existe ? existe.value : "";
}

/**
 * Deja seleccionado el valor en un <select>. Si el dato del inventario no
 * existe entre las opciones, crea el <option> en ese momento.
 */
function seleccionarOcrear(select, valor) {
  if (!select) return "";

  const texto = String(valor ?? "").trim();
  if (!texto) {
    select.value = "";
    return "";
  }

  let opcion = [...select.options].find(
    (item) =>
      item.value !== "" &&
      normalizarTexto(item.value) === normalizarTexto(texto)
  );

  if (!opcion) {
    opcion = document.createElement("option");
    opcion.value = texto;
    opcion.textContent = texto;
    select.appendChild(opcion);
  }

  select.value = opcion.value;
  return opcion.value;
}

function actualizarModelos(tipo, marca, modeloSeleccionado = "") {
  llenarSelect(
    document.getElementById("modelo"),
    valoresModelos(tipo, marca),
    "Seleccione el Modelo",
    modeloSeleccionado
  );
}

function actualizarMarcas(tipo, marcaSeleccionada = "") {
  llenarSelect(
    document.getElementById("marca"),
    valoresMarcas(tipo),
    "Seleccione la Marca",
    marcaSeleccionada
  );
  actualizarModelos(tipo, marcaSeleccionada);
}

/** Llena los tres selects y conecta la cascada Tipo -> Marca -> Modelo. */
function inicializarCascada() {
  const selectTipo = document.getElementById("tipo");
  const selectMarca = document.getElementById("marca");
  const selectModelo = document.getElementById("modelo");
  if (!selectTipo || !selectMarca || !selectModelo) return;

  llenarSelect(selectTipo, valoresTipos(), "Seleccione el Tipo");
  actualizarMarcas("");
  actualizarModelos("", "");

  selectTipo.addEventListener("change", () => {
    const tipo = selectTipo.value.trim();
    if (tipo) agregarExtraTipo(tipo);
    actualizarMarcas(tipo);
  });

  selectMarca.addEventListener("change", () => {
    actualizarModelos(selectTipo.value.trim(), selectMarca.value.trim());
  });
}

/* ---------------- Inventario (servidor SQLite + respaldo JSON) ---------------- */

const ALIAS_INVENTARIO = {
  placa: ["placa", "activofijo", "activo", "codigoactivo", "codigo", "fixedasset", "asset"],
  serial: ["serial", "serie", "numeroserie", "nserie", "sn"],
  marca: ["marca", "fabricante"],
  modelo: ["modelo"],
  tipo: ["tipo", "tipoequipo", "tipodeequipo", "categoria", "tipologia"],
  procesador: ["procesador", "cpu"],
  ram: ["ram", "memoria", "memoriaram"],
  disco: ["disco", "hdd", "ssd", "almacenamiento", "discoduro"],
  hostname: ["hostname", "host", "nombrepc", "nombreequipo", "nombredelequipo"],
  nombreusuario: ["nombreusuario", "usuario", "colaborador", "asignadoa", "nombre", "nombredelresponsable"],
  cedula: ["cedula", "cedulausuario", "cedulacolaborador", "ceduladelresponsable", "documento"],
  accesorios: ["accesorios", "accesoriosentregados", "perifericos"],
  estado: ["estado", "estadoequipo"],
};

let inventarioActual = null;

function normalizarFila(fila) {
  const plano = {};
  Object.keys(fila || {}).forEach((clave) => {
    plano[normalizarClave(clave)] = fila[clave];
  });

  const salida = {};
  Object.keys(ALIAS_INVENTARIO).forEach((campo) => {
    let valor = "";
    for (const alias of ALIAS_INVENTARIO[campo]) {
      if (plano[alias] !== undefined && String(plano[alias]).trim() !== "") {
        valor = String(plano[alias]).trim();
        break;
      }
    }
    salida[campo] = valor;
  });
  return salida;
}

function construirInventario(filas) {
  const datos = (filas || [])
    .map((fila) => normalizarFila(fila))
    .filter((equipo) => equipo.placa || equipo.serial);

  return {
    fechaCarga: new Date().toISOString(),
    totalEquipos: datos.length,
    datos,
  };
}

function estadoInventario(mensaje, tipo = "") {
  const el = document.getElementById("inventarioStatus");
  if (!el) return;
  el.textContent = mensaje;
  el.className = `estado estado-inventario ${tipo}`.trim();
}

function estadoServidor(mensaje, tipo = "") {
  const el = document.getElementById("serverStatus");
  if (!el) return;
  el.textContent = mensaje;
  el.className = `estado ${tipo}`.trim();
}

/**
 * Comprueba si server.js está activo. Cuando lo está, el inventario y las
 * actas viven en SQLite; si no, se usa el JSON estático como respaldo.
 */
async function cargarInfoServidor() {
  try {
    const respuesta = await fetch(`${API_BASE}/api/estado`, { cache: "no-store" });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

    const datos = await respuesta.json();
    if (!datos?.ok) throw new Error("Respuesta inválida del servidor");

    servidorActivo = true;
    infoServidor = datos;

    estadoServidor(
      `Servidor conectado · ${Number(datos.totalEquipos).toLocaleString("es-CO")} equipos`,
      "ok"
    );
    estadoInventario(
      `Inventario SQLite listo · ${datos.enlaceRed || location.origin}`
    );
    console.log("Servidor de actas conectado:", datos);
    return true;
  } catch (err) {
    servidorActivo = false;
    infoServidor = null;
    estadoServidor("Servidor no disponible · modo local", "error");
    console.info("Servidor no disponible:", err.message);
    return false;
  }
}

/** Carga ./data/inventario.json solo si el servidor SQLite no responde. */
async function cargarInventarioSilencioso() {
  if (servidorActivo) return;

  try {
    const respuesta = await fetch(INVENTARIO_JSON_PATH, { cache: "no-store" });
    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

    const json = await respuesta.json();
    const filas = Array.isArray(json) ? json : json.datos || [];
    const inventario = construirInventario(filas);

    if (!inventario.datos.length) {
      inventarioActual = null;
      estadoInventario("");
      return;
    }

    inventarioActual = inventario;
    estadoInventario(`Inventario local disponible: ${inventario.totalEquipos} equipos`);
    console.log(`Inventario cargado desde ${INVENTARIO_JSON_PATH}:`, inventario.totalEquipos, "equipos");
  } catch (err) {
    inventarioActual = null;
    estadoInventario("");
    console.info("Inventario no disponible:", err.message);
  }
}

/** Homogeneiza la respuesta de la API y del JSON local. */
function normalizarEquipo(equipo) {
  if (!equipo) return null;

  const texto = (valor) => String(valor ?? "").trim();

  return {
    placa: texto(equipo.placa),
    serial: texto(equipo.serial),
    tipo: texto(equipo.tipo),
    marca: texto(equipo.marca),
    modelo: texto(equipo.modelo),
    estado: texto(equipo.estado),
    usuario_actual: texto(equipo.usuario_actual ?? equipo.nombreusuario),
    cedula_usuario: texto(equipo.cedula_usuario ?? equipo.cedula),
    accesorios: texto(equipo.accesorios),
    software: texto(equipo.software),
    procesador: texto(equipo.procesador),
    ram: texto(equipo.ram),
    disco: texto(equipo.disco),
    hostname: texto(equipo.hostname),
    observaciones: texto(equipo.observaciones),
  };
}

async function buscarEquipoPorPlaca(placa) {
  const valor = String(placa ?? "").trim();
  if (!valor) return null;

  if (servidorActivo) {
    try {
      const respuesta = await fetch(
        `${API_BASE}/api/equipos?placa=${encodeURIComponent(valor)}`,
        { cache: "no-store" }
      );
      if (respuesta.status === 404) return null;
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

      const datos = await respuesta.json();
      return normalizarEquipo(datos.equipo);
    } catch (err) {
      console.warn("Falló la consulta al servidor, se intenta el respaldo local:", err);
    }
  }

  const objetivo = normalizarTexto(valor);
  if (!inventarioActual || !Array.isArray(inventarioActual.datos)) return null;

  const encontrado = inventarioActual.datos.find(
    (equipo) => normalizarTexto(equipo.placa) === objetivo
  );
  return normalizarEquipo(encontrado);
}

function asignarValor(id, valor, forzar = false) {
  const input = document.getElementById(id);
  if (!input) return;
  if (!valor && !forzar) return;
  input.value = valor ?? "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Divide cadenas tipo "Mouse, Teclado" o "Mouse;#Teclado". */
function dividirLista(texto) {
  return String(texto ?? "")
    .split(/[;,|#\n]/)
    .map((parte) => parte.replace(/^#+/, "").trim())
    .filter(Boolean);
}

/** Marca los accesorios que ya venían registrados para el equipo. */
function sincronizarAccesoriosDesdeInventario(texto) {
  const valores = dividirLista(texto);
  const inputs = [...document.querySelectorAll('input[name="accesorios"]')];
  const conocidos = inputs.filter((input) => input.value !== "Otro");
  const mapa = new Map(
    conocidos.map((input) => [normalizarTexto(input.value), input])
  );
  const desconocidos = [];
  const usados = new Set();

  conocidos.forEach((input) => {
    input.checked = false;
    input.disabled = false;
  });

  valores.forEach((valor) => {
    const input = mapa.get(normalizarTexto(valor));
    if (input && !usados.has(input)) {
      input.checked = true;
      usados.add(input);
    } else if (!input) {
      desconocidos.push(valor);
    }
  });

  const otroChk = document.getElementById("otroAccesorioChk");
  const otroInput = document.getElementById("otroAccesorio");
  if (otroChk) otroChk.checked = false;
  if (otroInput) {
    otroInput.value = "";
    otroInput.disabled = true;
  }

  if (desconocidos.length && otroChk && otroInput) {
    otroChk.checked = true;
    otroInput.disabled = false;
    otroInput.value = [...new Set(desconocidos)].join(", ");
  }
}

function mostrarFichaEquipo(equipo) {
  const panel = document.getElementById("equipoInfo");
  if (!panel) return;

  if (!equipo) {
    panel.hidden = true;
    return;
  }

  const estado = document.getElementById("equipoInfoEstado");
  const responsable = document.getElementById("equipoInfoResponsable");
  const accesorios = document.getElementById("equipoInfoAccesorios");

  if (estado) estado.textContent = equipo.estado || "Sin estado";
  if (responsable) {
    responsable.textContent = equipo.usuario_actual
      ? `${equipo.usuario_actual}${equipo.cedula_usuario ? ` · ${equipo.cedula_usuario}` : ""}`
      : "Sin responsable asignado";
  }
  if (accesorios) accesorios.textContent = equipo.accesorios || "Ninguno";

  panel.hidden = false;
}

function limpiarFichaEquipo() {
  equipoActual = null;
  mostrarFichaEquipo(null);
}

/** En Devolución, propone al responsable actual del equipo. */
function autocompletarResponsableActual() {
  if (!equipoActual) return;

  const tipoActa =
    document.querySelector('input[name="tipoActa"]:checked')?.value || "Asignación";
  if (tipoActa !== "Devolución") return;

  const nombre = document.getElementById("nombre");
  const documento = document.getElementById("documento");

  if (nombre && !nombre.value.trim() && equipoActual.usuario_actual) {
    asignarValor("nombre", equipoActual.usuario_actual);
  }
  if (documento && !documento.value.trim() && equipoActual.cedula_usuario) {
    asignarValor("documento", equipoActual.cedula_usuario);
  }
}

function autocompletarEquipo(equipo) {
  if (!equipo) return;
  equipoActual = equipo;

  const tipo = String(equipo.tipo ?? "").trim();
  const marca = String(equipo.marca ?? "").trim();
  const modelo = String(equipo.modelo ?? "").trim();
  const estado = String(equipo.estado ?? "").trim();

  // Registra los valores del inventario que no existen en el catálogo.
  if (tipo) agregarExtraTipo(tipo);
  if (tipo && marca) agregarExtraMarca(tipo, marca);
  if (tipo && marca && modelo) agregarExtraModelo(tipo, marca, modelo);

  const selectTipo = document.getElementById("tipo");
  const selectMarca = document.getElementById("marca");
  const selectModelo = document.getElementById("modelo");

  llenarSelect(selectTipo, valoresTipos(), "Seleccione el Tipo", tipo);
  const tipoFinal = seleccionarOcrear(selectTipo, tipo);

  actualizarMarcas(tipoFinal, marca);
  const marcaFinal = seleccionarOcrear(selectMarca, marca);

  actualizarModelos(tipoFinal, marcaFinal, modelo);
  seleccionarOcrear(selectModelo, modelo);

  // El estado se muestra en su select; si el valor del inventario no está en
  // la lista se agrega como opción nueva.
  seleccionarOcrear(document.getElementById("estado"), estado);

  asignarValor("serial", equipo.serial, true);

  // Responsable y cédula registrados en SQLite, sincronizados con Firmas.
  // Si el equipo no tiene responsable se limpian para no arrastrar datos de
  // una búsqueda anterior.
  asignarValor("nombre", equipo.usuario_actual, true);
  asignarValor("documento", equipo.cedula_usuario, true);

  sincronizarAccesoriosDesdeInventario(equipo.accesorios);
  mostrarFichaEquipo(equipo);

  if (estado) {
    const estadoNormalizado = normalizarTexto(estado);
    let valorRadio = null;
    if (estadoNormalizado.includes("devol")) valorRadio = "Devolución";
    else if (estadoNormalizado.includes("asign")) valorRadio = "Asignación";

    if (valorRadio) {
      const radio = document.querySelector(
        `input[name="tipoActa"][value="${valorRadio}"]`
      );
      if (radio) radio.checked = true;
    }
  }

  autocompletarResponsableActual();
}

/* ---------------- Búsqueda desplegable de Placa ---------------- */

/** Busca equipos por prefijo en SQLite (/api/equipos/buscar) o en el JSON. */
async function buscarEquiposSugeridos(consulta) {
  const texto = String(consulta ?? "").trim();
  if (!texto) return [];

  if (servidorActivo) {
    try {
      const respuesta = await fetch(
        `${API_BASE}/api/equipos/buscar?q=${encodeURIComponent(texto)}`,
        { cache: "no-store" }
      );
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);

      const datos = await respuesta.json();
      if (!datos?.ok) throw new Error("Respuesta inválida del servidor");
      return (datos.equipos || []).map(normalizarEquipo);
    } catch (err) {
      console.warn(
        "No se pudo buscar en el servidor, se usa el respaldo local:",
        err
      );
    }
  }

  if (!inventarioActual || !Array.isArray(inventarioActual.datos)) return [];

  const objetivo = normalizarTexto(texto);
  const porPrefijo = inventarioActual.datos.filter((equipo) =>
    normalizarTexto(equipo.placa).startsWith(objetivo)
  );
  const lista = porPrefijo.length
    ? porPrefijo
    : inventarioActual.datos.filter((equipo) =>
        normalizarTexto(equipo.placa).includes(objetivo)
      );

  return lista.slice(0, 30).map(normalizarEquipo);
}

function describirEquipo(equipo) {
  return (
    [equipo.tipo, equipo.marca, equipo.modelo].filter(Boolean).join(" ") ||
    "Equipo sin descripción"
  );
}

function detalleSugerencia(equipo) {
  const serial = equipo.serial ? ` (Serial: ${equipo.serial})` : "";
  return `— ${describirEquipo(equipo)}${serial}`;
}

function inicializarAutocompletadoPlaca() {
  const placaInput = document.getElementById("placa");
  const contenedor = document.getElementById("placaSugerencias");
  if (!placaInput || !contenedor) return;

  let temporizador = null;
  let indiceActivo = -1;
  let sugerencias = [];
  let turno = 0;

  const cerrar = () => {
    contenedor.hidden = true;
    contenedor.innerHTML = "";
    placaInput.setAttribute("aria-expanded", "false");
    placaInput.removeAttribute("aria-activedescendant");
    indiceActivo = -1;
    sugerencias = [];
  };

  const marcarActiva = (nuevoIndice) => {
    const items = [...contenedor.querySelectorAll(".placa-sugerencia")];
    if (!items.length) return;

    indiceActivo = ((nuevoIndice % items.length) + items.length) % items.length;
    items.forEach((item, indice) => {
      const activa = indice === indiceActivo;
      item.classList.toggle("activa", activa);
      item.setAttribute("aria-selected", activa ? "true" : "false");
    });

    const activo = items[indiceActivo];
    placaInput.setAttribute("aria-activedescendant", activo.id);
    activo.scrollIntoView({ block: "nearest" });
  };

  const marcarValida = () => {
    placaInput.removeAttribute("aria-invalid");
    placaInput.style.borderColor = "#15803d";
  };

  const marcarInvalida = () => {
    placaInput.setAttribute("aria-invalid", "true");
    placaInput.style.borderColor = "#b91c1c";
  };

  /** Aplica el equipo elegido y rellena todo el formulario al instante. */
  const elegir = (equipo) => {
    if (!equipo) return;
    cerrar();
    placaInput.value = equipo.placa;
    marcarValida();
    autocompletarEquipo(equipo);
    estadoInventario(`Equipo seleccionado: ${describirEquipo(equipo)}`, "ok");
  };

  const mostrar = (equipos) => {
    sugerencias = equipos;
    indiceActivo = -1;
    contenedor.innerHTML = "";

    if (!equipos.length) {
      const vacio = document.createElement("div");
      vacio.className = "placa-sugerencias-vacia";
      vacio.textContent = "No se encontraron equipos con esa placa.";
      contenedor.appendChild(vacio);
      contenedor.hidden = false;
      placaInput.setAttribute("aria-expanded", "true");
      placaInput.removeAttribute("aria-activedescendant");
      return;
    }

    equipos.forEach((equipo, indice) => {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.id = `placaSugerencia-${indice}`;
      boton.className = "placa-sugerencia";
      boton.setAttribute("role", "option");
      boton.setAttribute("aria-selected", "false");

      const placa = document.createElement("span");
      placa.className = "placa-sugerencia-placa";
      placa.textContent = equipo.placa;

      const detalle = document.createElement("span");
      detalle.className = "placa-sugerencia-detalle";
      detalle.textContent = detalleSugerencia(equipo);

      boton.append(placa, detalle);
      boton.addEventListener("pointerdown", (evento) => evento.preventDefault());
      boton.addEventListener("click", () => elegir(equipo));
      boton.addEventListener("mouseenter", () => marcarActiva(indice));
      contenedor.appendChild(boton);
    });

    contenedor.hidden = false;
    placaInput.setAttribute("aria-expanded", "true");
  };

  /** Consulta exacta por Placa (Enter, blur o sin sugerencias). */
  const consultarExacta = async (mostrarError) => {
    const valor = placaInput.value.trim();

    if (!valor) {
      limpiarFichaEquipo();
      placaInput.removeAttribute("aria-invalid");
      placaInput.style.borderColor = "";
      return;
    }

    if (!servidorActivo && !inventarioActual) {
      estadoInventario("Sin conexión al inventario. Inicia el servidor.", "error");
      return;
    }

    const actual = ++turno;
    const equipo = await buscarEquipoPorPlaca(valor);
    if (actual !== turno) return;

    if (equipo) {
      placaInput.value = equipo.placa;
      marcarValida();
      autocompletarEquipo(equipo);
      estadoInventario(`Equipo encontrado: ${describirEquipo(equipo)}`, "ok");
    } else if (mostrarError) {
      limpiarFichaEquipo();
      marcarInvalida();
      estadoInventario("Placa no registrada en el inventario", "error");
    }
  };

  /** Consulta en vivo desde el segundo carácter y pinta la lista. */
  const actualizarSugerencias = async () => {
    const valor = placaInput.value.trim();
    const actual = ++turno;

    if (valor.length < 2) {
      cerrar();
      placaInput.removeAttribute("aria-invalid");
      placaInput.style.borderColor = "";
      if (!valor) limpiarFichaEquipo();
      return;
    }

    if (!servidorActivo && !inventarioActual) {
      cerrar();
      estadoInventario("Sin conexión al inventario. Inicia el servidor.", "error");
      return;
    }

    estadoInventario(`Buscando equipos con "${valor}"…`);
    const equipos = await buscarEquiposSugeridos(valor);
    if (actual !== turno) return;

    const exacto = equipos.find(
      (equipo) => normalizarTexto(equipo.placa) === normalizarTexto(valor)
    );
    if (exacto) {
      elegir(exacto);
      return;
    }

    if (equipos.length) {
      placaInput.removeAttribute("aria-invalid");
      placaInput.style.borderColor = "";
      estadoInventario(
        `${equipos.length} equipo(s) encontrado(s). Elige uno de la lista.`,
        "ok"
      );
    } else {
      limpiarFichaEquipo();
      marcarInvalida();
      estadoInventario("Placa no registrada en el inventario", "error");
    }

    mostrar(equipos);
  };

  const programar = () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(actualizarSugerencias, 160);
  };

  placaInput.addEventListener("input", programar);

  placaInput.addEventListener("keydown", (evento) => {
    const abierto = !contenedor.hidden && sugerencias.length > 0;

    if (evento.key === "ArrowDown" && abierto) {
      evento.preventDefault();
      marcarActiva(indiceActivo + 1);
      return;
    }

    if (evento.key === "ArrowUp" && abierto) {
      evento.preventDefault();
      marcarActiva(indiceActivo <= 0 ? sugerencias.length - 1 : indiceActivo - 1);
      return;
    }

    if (evento.key === "Enter") {
      evento.preventDefault();
      clearTimeout(temporizador);

      if (abierto) {
        const elegido = sugerencias[indiceActivo >= 0 ? indiceActivo : 0];
        if (elegido) {
          elegir(elegido);
          return;
        }
      }

      cerrar();
      consultarExacta(true);
      return;
    }

    if (evento.key === "Escape") {
      cerrar();
    }
  });

  placaInput.addEventListener("blur", () => {
    clearTimeout(temporizador);
    // Deja terminar el clic en una sugerencia antes de cerrar la lista.
    setTimeout(() => {
      cerrar();
      consultarExacta(false);
    }, 140);
  });
}

/* ---------------- Agente TI y firmas ---------------- */

const LS_DOCUMENTOS_TI = "actaLevapan.documentosTi";

/* Cédulas confirmadas. Michael Wilson queda pendiente de confirmar. */
const DOCUMENTOS_TI_CONOCIDOS = {
  "Harold Hurtado": "1087778841",
};

function leerDocumentosTi() {
  try {
    const crudo = localStorage.getItem(LS_DOCUMENTOS_TI);
    const datos = crudo ? JSON.parse(crudo) : {};
    return datos && typeof datos === "object" ? datos : {};
  } catch (err) {
    console.warn("No se pudo leer la memoria de cédulas TI:", err);
    return {};
  }
}

function guardarDocumentoTi(agente, documento) {
  if (!agente) return;
  try {
    const datos = leerDocumentosTi();
    if (documento) datos[agente] = documento;
    else delete datos[agente];
    localStorage.setItem(LS_DOCUMENTOS_TI, JSON.stringify(datos));
  } catch (err) {
    console.warn("No se pudo recordar la cédula TI:", err);
  }
}

function sincronizarCampoFirma(id, valor) {
  const campo = document.getElementById(id);
  if (campo) campo.value = valor ?? "";
}

/** Refleja nombre/cédula en los bloques de firma y recuerda la cédula TI. */
function inicializarSincronizacionFirmas() {
  const nombre = document.getElementById("nombre");
  const documento = document.getElementById("documento");
  const agente = document.getElementById("nombreTi");
  const documentoTi = document.getElementById("documentoTi");

  const reflejarColaborador = () => {
    sincronizarCampoFirma("firmaNombreColaborador", nombre?.value.trim());
    sincronizarCampoFirma("firmaDocumentoColaborador", documento?.value.trim());
  };

  const reflejarAgente = () => {
    sincronizarCampoFirma("firmaNombreAgente", agente?.value.trim());
    sincronizarCampoFirma("firmaDocumentoAgente", documentoTi?.value.trim());
  };

  nombre?.addEventListener("input", reflejarColaborador);
  documento?.addEventListener("input", reflejarColaborador);

  agente?.addEventListener("change", () => {
    const recordado = leerDocumentosTi()[agente.value] || "";
    const conocido = DOCUMENTOS_TI_CONOCIDOS[agente.value] || "";
    if (documentoTi) documentoTi.value = recordado || conocido;
    reflejarAgente();
    if (documentoTi && documentoTi.value) {
      guardarDocumentoTi(agente.value, documentoTi.value.trim());
    }
  });

  documentoTi?.addEventListener("input", () => {
    reflejarAgente();
    guardarDocumentoTi(agente?.value, documentoTi.value.trim());
  });

  reflejarColaborador();
  reflejarAgente();
}

/* ---------------- Datos del formulario ---------------- */

function valoresSeleccionados(nombre) {
  return [...document.querySelectorAll(`input[name="${nombre}"]:checked`)].map(
    (input) => input.value
  );
}

/** Etiquetas fijas de las casillas del formulario (sin la opción "Otro"). */
function valoresCasillas(nombre) {
  return [...document.querySelectorAll(`input[name="${nombre}"]`)]
    .map((input) => input.value)
    .filter((valor) => valor !== "Otro");
}

function recolectarDatos() {
  const tipoActa =
    document.querySelector('input[name="tipoActa"]:checked')?.value || "Asignación";

  const otroAccesorio = document.getElementById("otroAccesorio")?.value.trim() || "";
  const otroSoftware = document.getElementById("otroSoftware")?.value.trim() || "";

  const accesorios = valoresSeleccionados("accesorios").map((valor) =>
    valor === "Otro" && otroAccesorio ? `Otro: ${otroAccesorio}` : valor
  );

  const software = valoresSeleccionados("software").map((valor) =>
    valor === "Otro" && otroSoftware ? `Otro: ${otroSoftware}` : valor
  );

  const foto = (id) => document.getElementById(id)?.files?.[0] || null;

  return {
    nombre: document.getElementById("nombre").value.trim(),
    documento: document.getElementById("documento").value.trim(),
    agenteTi: document.getElementById("nombreTi")?.value.trim() || "",
    documentoTi: document.getElementById("documentoTi")?.value.trim() || "",
    tipo: document.getElementById("tipo").value.trim(),
    marca: document.getElementById("marca").value.trim(),
    modelo: document.getElementById("modelo").value.trim(),
    serial: document.getElementById("serial").value.trim(),
    placa: document.getElementById("placa").value.trim(),
    tipoActa,
    accesorios,
    software,
    observaciones: document.getElementById("observaciones").value.trim(),
    fecha: new Date(),
    firmas: {
      colaborador: window.FirmasActa?.obtenerDataUrl("firmaColaborador") || null,
      agente: window.FirmasActa?.obtenerDataUrl("firmaAgente") || null,
    },
    fotos: {
      encendido: foto("fotoEncendido"),
      frontal: foto("fotoFrontal"),
      posterior: foto("fotoPosterior"),
    },
  };
}

function construirNombreArchivo(datos) {
  const placa = sanitizarArchivo(datos.placa, "SIN_PLACA");
  const nombre = sanitizarArchivo(datos.nombre, "SIN_NOMBRE");
  return `ACTA_${placa}_${nombre}.pdf`;
}

/* ---------------- Generación del PDF ---------------- */

async function convertirImagenAJpeg(file) {
  const dataUrl = await leerArchivoComoDataURL(file);
  const imagen = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo leer la imagen"));
    img.src = dataUrl;
  });

  const maximo = 1400;
  const escala = Math.min(1, maximo / Math.max(imagen.width, imagen.height));
  const ancho = Math.max(1, Math.round(imagen.width * escala));
  const alto = Math.max(1, Math.round(imagen.height * escala));

  const canvas = document.createElement("canvas");
  canvas.width = ancho;
  canvas.height = alto;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ancho, alto);
  ctx.drawImage(imagen, 0, 0, ancho, alto);

  const blob = await new Promise((resolve) =>
    canvas.toBlob((resultado) => resolve(resultado), "image/jpeg", 0.9)
  );
  if (!blob) throw new Error("No se pudo procesar la imagen");

  return new Uint8Array(await blob.arrayBuffer());
}

function envolverTexto(texto, fuente, tamano, anchoMaximo) {
  const palabras = limpiarTextoPdf(texto).split(/\s+/).filter(Boolean);
  const lineas = [];
  let linea = "";

  for (const palabra of palabras) {
    const prueba = linea ? `${linea} ${palabra}` : palabra;
    if (fuente.widthOfTextAtSize(prueba, tamano) > anchoMaximo && linea) {
      lineas.push(linea);
      linea = palabra;
    } else {
      linea = prueba;
    }
  }

  if (linea) lineas.push(linea);
  return lineas;
}

async function generarActaPDF(datos) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib || {};
  if (!PDFDocument) {
    throw new Error("La librería pdf-lib no está disponible. Revisa tu conexión a internet.");
  }

  const pdfDoc = await PDFDocument.create();
  const pagina = pdfDoc.addPage([595.28, 841.89]);
  const fuente = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const negrita = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const azul = rgb(0.043, 0.239, 0.569);
  const azulOscuro = rgb(0.027, 0.165, 0.4);
  const azulClaro = rgb(0.909, 0.933, 0.984);
  const rojo = rgb(0.89, 0.024, 0.075);
  const gris = rgb(0.39, 0.45, 0.55);
  const texto = rgb(0.12, 0.16, 0.23);
  const borde = rgb(0.85, 0.88, 0.93);
  const blanco = rgb(1, 1, 1);

  const ancho = pagina.getWidth();
  const alto = pagina.getHeight();
  const margen = 46;
  const anchoUtil = ancho - margen * 2;
  const gap = 16;

  /* --- Cabecera --- */
  pagina.drawRectangle({
    x: 0,
    y: alto - 96,
    width: ancho,
    height: 96,
    color: azul,
  });
  pagina.drawRectangle({
    x: 0,
    y: alto - 100,
    width: ancho,
    height: 4,
    color: rojo,
  });

  pagina.drawText("LEVAPAN", {
    x: margen,
    y: alto - 52,
    size: 24,
    font: negrita,
    color: blanco,
  });
  pagina.drawText("Gestión de Activos de TI", {
    x: margen,
    y: alto - 68,
    size: 8.5,
    font: fuente,
    color: rgb(0.85, 0.9, 0.98),
  });

  const titulo = "ACTA DE TECNOLOGÍA";
  const anchoTitulo = negrita.widthOfTextAtSize(titulo, 14);
  pagina.drawText(titulo, {
    x: ancho - margen - anchoTitulo,
    y: alto - 48,
    size: 14,
    font: negrita,
    color: blanco,
  });
  const fechaTexto = `Fecha: ${fechaCorta(datos.fecha)}`;
  const anchoFecha = fuente.widthOfTextAtSize(fechaTexto, 9);
  pagina.drawText(fechaTexto, {
    x: ancho - margen - anchoFecha,
    y: alto - 66,
    size: 9,
    font: fuente,
    color: rgb(0.85, 0.9, 0.98),
  });

  const dibujarSeccion = (tituloSeccion, yActual) => {
    pagina.drawRectangle({
      x: margen,
      y: yActual - 21,
      width: anchoUtil,
      height: 21,
      color: azulClaro,
    });
    pagina.drawText(tituloSeccion.toUpperCase(), {
      x: margen + 10,
      y: yActual - 15,
      size: 8.5,
      font: negrita,
      color: azulOscuro,
    });
    return yActual - 34;
  };

  const dibujarCampo = (etiqueta, valor, x, yActual, anchoCampo) => {
    pagina.drawText(etiqueta, {
      x,
      y: yActual,
      size: 7.5,
      font: negrita,
      color: gris,
    });
    pagina.drawText(limpiarTextoPdf(valor || "-"), {
      x,
      y: yActual - 14,
      size: 10.5,
      font: fuente,
      color: texto,
      maxWidth: anchoCampo,
    });
    pagina.drawLine({
      start: { x, y: yActual - 19 },
      end: { x: x + anchoCampo, y: yActual - 19 },
      thickness: 0.6,
      color: borde,
    });
  };

  const dibujarCasilla = (x, ySuperior, marcada, etiqueta, tamano = 8.8) => {
    pagina.drawRectangle({
      x,
      y: ySuperior - 9,
      width: 9,
      height: 9,
      borderWidth: 0.8,
      borderColor: rgb(0.62, 0.68, 0.78),
      color: blanco,
    });
    if (marcada) {
      pagina.drawLine({
        start: { x: x + 1.6, y: ySuperior - 4.6 },
        end: { x: x + 3.9, y: ySuperior - 7.4 },
        thickness: 1.2,
        color: azul,
      });
      pagina.drawLine({
        start: { x: x + 3.9, y: ySuperior - 7.4 },
        end: { x: x + 7.8, y: ySuperior - 1.9 },
        thickness: 1.2,
        color: azul,
      });
    }
    pagina.drawText(limpiarTextoPdf(etiqueta), {
      x: x + 13,
      y: ySuperior - 7.4,
      size: tamano,
      font: fuente,
      color: texto,
    });
  };

  let y = alto - 128;

  // Tipo de acta
  pagina.drawRectangle({
    x: margen,
    y: y - 6,
    width: 118,
    height: 20,
    color: datos.tipoActa === "Devolución" ? rojo : azul,
  });
  const tipoTexto = datos.tipoActa.toUpperCase();
  const anchoTipo = negrita.widthOfTextAtSize(tipoTexto, 9);
  pagina.drawText(tipoTexto, {
    x: margen + (118 - anchoTipo) / 2,
    y: y + 0.5,
    size: 9,
    font: negrita,
    color: blanco,
  });

  pagina.drawText(`Generado: ${fechaHora(datos.fecha)}`, {
    x: margen + 132,
    y: y + 1,
    size: 8,
    font: fuente,
    color: gris,
  });

  y = alto - 158;

  /* --- Datos personales --- */
  y = dibujarSeccion("Datos personales", y);
  const col2 = (anchoUtil - gap) / 2;
  const col4 = (anchoUtil - gap * 3) / 4;
  dibujarCampo("NOMBRE COMPLETO", datos.nombre, margen, y, col4);
  dibujarCampo("CC / TI", datos.documento, margen + col4 + gap, y, col4);
  dibujarCampo("AGENTE TI", datos.agenteTi, margen + (col4 + gap) * 2, y, col4);
  dibujarCampo("CÉDULA TI", datos.documentoTi, margen + (col4 + gap) * 3, y, col4);
  y -= 44;

  /* --- Características del equipo --- */
  y = dibujarSeccion("Características del equipo", y);
  const col3 = (anchoUtil - gap * 2) / 3;
  dibujarCampo("TIPO", datos.tipo, margen, y, col3);
  dibujarCampo("MARCA", datos.marca, margen + col3 + gap, y, col3);
  dibujarCampo("MODELO", datos.modelo, margen + (col3 + gap) * 2, y, col3);
  y -= 42;
  dibujarCampo("SERIAL", datos.serial, margen, y, col2);
  dibujarCampo("PLACA", datos.placa, margen + col2 + gap, y, col2);
  y -= 38;

  /* --- Accesorios --- */
  y = dibujarSeccion("Accesorios", y);
  const accesorios = unirValores(valoresCasillas("accesorios"), datos.accesorios);

  const columnasChecks = 4;
  const anchoCheck = (anchoUtil - gap * (columnasChecks - 1)) / columnasChecks;
  accesorios.forEach((etiqueta, indice) => {
    const columna = indice % columnasChecks;
    const fila = Math.floor(indice / columnasChecks);
    const marcada = datos.accesorios.includes(etiqueta);
    dibujarCasilla(
      margen + columna * (anchoCheck + gap),
      y - fila * 16,
      marcada,
      etiqueta,
      8.4
    );
  });
  y -= Math.ceil(accesorios.length / columnasChecks) * 16 + 8;

  /* --- Software --- */
  y = dibujarSeccion("Software instalado", y);
  const software = unirValores(valoresCasillas("software"), datos.software);

  software.forEach((etiqueta, indice) => {
    const columna = indice % columnasChecks;
    const fila = Math.floor(indice / columnasChecks);
    const marcada = datos.software.includes(etiqueta);
    dibujarCasilla(
      margen + columna * (anchoCheck + gap),
      y - fila * 16,
      marcada,
      etiqueta,
      8.4
    );
  });
  y -= Math.ceil(software.length / columnasChecks) * 16 + 8;

  /* --- Observaciones --- */
  y = dibujarSeccion("Observaciones", y);
  const observaciones = datos.observaciones || "Sin observaciones.";
  const lineas = envolverTexto(observaciones, fuente, 9.5, anchoUtil).slice(0, 3);
  lineas.forEach((linea, indice) => {
    pagina.drawText(linea, {
      x: margen,
      y: y - indice * 12,
      size: 9.5,
      font: fuente,
      color: texto,
    });
  });
  y -= lineas.length * 12 + 8;

  /* --- Firmas (dos columnas) --- */
  y = dibujarSeccion("Firmas", y);

  const altoFirma = 104;
  const yBaseFirma = y - altoFirma;
  const bloquesFirma = [
    {
      titulo: "COLABORADOR",
      nombre: datos.nombre,
      documento: datos.documento,
      dataUrl: datos.firmas?.colaborador,
    },
    {
      titulo: "AGENTE TI",
      nombre: datos.agenteTi,
      documento: datos.documentoTi,
      dataUrl: datos.firmas?.agente,
    },
  ];

  for (let i = 0; i < bloquesFirma.length; i += 1) {
    const bloque = bloquesFirma[i];
    const x = margen + i * (col2 + gap);

    pagina.drawRectangle({
      x,
      y: yBaseFirma,
      width: col2,
      height: altoFirma,
      borderWidth: 0.8,
      borderColor: borde,
      color: blanco,
    });

    pagina.drawText(bloque.titulo, {
      x: x + 10,
      y: y - 16,
      size: 8.5,
      font: negrita,
      color: azulOscuro,
    });

    const areaX = x + 12;
    const areaY = yBaseFirma + 32;
    const areaAncho = col2 - 24;
    const areaAlto = 42;

    if (bloque.dataUrl) {
      try {
        const imagenFirma = await pdfDoc.embedPng(dataUrlABytes(bloque.dataUrl));
        const escala = Math.min(
          areaAncho / imagenFirma.width,
          areaAlto / imagenFirma.height
        );
        const anchoImagen = imagenFirma.width * escala;
        const altoImagen = imagenFirma.height * escala;

        pagina.drawImage(imagenFirma, {
          x: areaX + (areaAncho - anchoImagen) / 2,
          y: areaY + (areaAlto - altoImagen) / 2,
          width: anchoImagen,
          height: altoImagen,
        });
      } catch (err) {
        console.warn("No se pudo incrustar la firma:", bloque.titulo, err);
        pagina.drawText("(Sin firma)", {
          x: areaX + 6,
          y: areaY + 18,
          size: 8,
          font: fuente,
          color: gris,
        });
      }
    } else {
      pagina.drawText("(Sin firma)", {
        x: areaX + 6,
        y: areaY + 18,
        size: 8,
        font: fuente,
        color: gris,
      });
    }

    pagina.drawLine({
      start: { x: x + 10, y: yBaseFirma + 28 },
      end: { x: x + col2 - 10, y: yBaseFirma + 28 },
      thickness: 0.6,
      color: borde,
    });
    pagina.drawText(limpiarTextoPdf(bloque.nombre || "Sin nombre"), {
      x: x + 10,
      y: yBaseFirma + 17,
      size: 9,
      font: negrita,
      color: texto,
      maxWidth: col2 - 20,
    });
    pagina.drawText(limpiarTextoPdf(`N° DOC ID: ${bloque.documento || "-"}`), {
      x: x + 10,
      y: yBaseFirma + 7,
      size: 7.5,
      font: fuente,
      color: gris,
      maxWidth: col2 - 20,
    });
  }

  /* --- Pie de página (se numera al final) --- */
  pagina.drawLine({
    start: { x: margen, y: 54 },
    end: { x: ancho - margen, y: 54 },
    thickness: 0.7,
    color: borde,
  });
  pagina.drawText("Levapan · Acta de Tecnología", {
    x: margen,
    y: 40,
    size: 8,
    font: fuente,
    color: gris,
  });
  pagina.drawText("Documento generado automáticamente", {
    x: margen,
    y: 30,
    size: 7.5,
    font: fuente,
    color: gris,
  });

  /* --- Registro fotográfico (página adicional) --- */
  const fotos = [
    { etiqueta: "Equipo Encendido", file: datos.fotos.encendido },
    { etiqueta: "Frontal", file: datos.fotos.frontal },
    { etiqueta: "Posterior", file: datos.fotos.posterior },
  ].filter((item) => item.file);

  if (fotos.length) {
    const paginaFotos = pdfDoc.addPage([595.28, 841.89]);

    paginaFotos.drawRectangle({
      x: 0,
      y: alto - 70,
      width: ancho,
      height: 70,
      color: azul,
    });
    paginaFotos.drawRectangle({
      x: 0,
      y: alto - 74,
      width: ancho,
      height: 4,
      color: rojo,
    });
    paginaFotos.drawText("REGISTRO FOTOGRÁFICO", {
      x: margen,
      y: alto - 42,
      size: 16,
      font: negrita,
      color: blanco,
    });
    paginaFotos.drawText(
      limpiarTextoPdf(
        `${datos.placa || "SIN PLACA"} · ${datos.nombre || "SIN NOMBRE"}`
      ),
      {
        x: margen,
        y: alto - 58,
        size: 9,
        font: fuente,
        color: rgb(0.85, 0.9, 0.98),
      }
    );

    const anchoFoto = (anchoUtil - gap) / 2;
    const altoFoto = anchoFoto * 0.72;

    for (let i = 0; i < fotos.length; i += 1) {
      const columna = i % 2;
      const fila = Math.floor(i / 2);
      const x = margen + columna * (anchoFoto + gap);
      const ySuperior = alto - 108 - fila * (altoFoto + 34);

      paginaFotos.drawText(fotos[i].etiqueta.toUpperCase(), {
        x,
        y: ySuperior,
        size: 9,
        font: negrita,
        color: azulOscuro,
      });

      try {
        const jpegBytes = await convertirImagenAJpeg(fotos[i].file);
        const imagen = await pdfDoc.embedJpg(jpegBytes);
        paginaFotos.drawImage(imagen, {
          x,
          y: ySuperior - altoFoto - 6,
          width: anchoFoto,
          height: altoFoto,
        });
      } catch (err) {
        console.warn("No se pudo incrustar la foto:", fotos[i].etiqueta, err);
        paginaFotos.drawText("(No se pudo cargar la imagen)", {
          x,
          y: ySuperior - 24,
          size: 8,
          font: fuente,
          color: gris,
        });
      }
    }

    paginaFotos.drawLine({
      start: { x: margen, y: 54 },
      end: { x: ancho - margen, y: 54 },
      thickness: 0.7,
      color: borde,
    });
    paginaFotos.drawText("Levapan · Acta de Tecnología", {
      x: margen,
      y: 40,
      size: 8,
      font: fuente,
      color: gris,
    });
  }

  /* --- Numeración de páginas --- */
  const paginas = pdfDoc.getPages();
  paginas.forEach((p, indice) => {
    const etiqueta = `Página ${indice + 1} de ${paginas.length}`;
    const anchoEtiqueta = fuente.widthOfTextAtSize(etiqueta, 7.5);
    p.drawText(etiqueta, {
      x: ancho - margen - anchoEtiqueta,
      y: 30,
      size: 7.5,
      font: fuente,
      color: gris,
    });
  });

  return await pdfDoc.save();
}

/* ---------------- Webhook ---------------- */

async function enviarWebhook(bytes, nombreArchivo) {
  if (!WEBHOOK_URL || !/^https?:\/\//i.test(WEBHOOK_URL)) return;

  try {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const fileBase64 = await blobToBase64(blob);

    const respuesta = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: nombreArchivo, fileBase64 }),
    });

    if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
    console.log("Acta enviada al webhook:", nombreArchivo);
  } catch (err) {
    console.warn("No se pudo enviar el acta al webhook:", err);
  }
}

/* ---------------- Envío del formulario ---------------- */

function estadoEnvio(mensaje, tipo = "") {
  const el = document.getElementById("envioStatus");
  if (!el) return;
  el.textContent = mensaje;
  el.className = `estado ${tipo}`.trim();
}

/** Datos serializables para la API (sin archivos ni firmas). */
function datosParaServidor(datos) {
  const { fotos, firmas, fecha, ...resto } = datos;
  return {
    ...resto,
    fecha: fecha instanceof Date ? fecha.toISOString() : new Date().toISOString(),
  };
}

/** Envía el PDF y los datos al servidor: escribe el archivo y actualiza SQLite. */
async function enviarActaAlServidor(bytes, datos, nombreArchivo) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const pdfBase64 = await blobToBase64(blob);

  const respuesta = await fetch(`${API_BASE}/api/actas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      archivo: nombreArchivo,
      pdfBase64,
      datos: datosParaServidor(datos),
    }),
  });

  const resultado = await respuesta.json().catch(() => ({}));
  if (!respuesta.ok || !resultado.ok) {
    throw new Error(resultado.error || `HTTP ${respuesta.status}`);
  }
  return resultado;
}

async function manejarEnvio(event) {
  event.preventDefault();

  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const boton = document.getElementById("btnGenerar");
  const textoOriginal = boton ? boton.textContent : "Generar y Guardar / Enviar";

  try {
    if (boton) {
      boton.disabled = true;
      boton.textContent = "Generando y guardando acta...";
    }
    estadoEnvio("Generando acta...", "");

    // Solicitar permiso dentro del gesto del usuario (antes del trabajo async pesado).
    if (carpetaHandle) {
      await asegurarPermiso(carpetaHandle);
    }

    const datos = recolectarDatos();
    const bytes = await generarActaPDF(datos);
    const nombreArchivo = construirNombreArchivo(datos);

    // 1) Servidor SQLite: guarda el PDF y actualiza el inventario.
    if (servidorActivo) {
      estadoEnvio("Guardando el acta en el servidor…");
      try {
        const resultado = await enviarActaAlServidor(bytes, datos, nombreArchivo);
        await enviarWebhook(bytes, nombreArchivo);

        if (resultado.equipo) {
          equipoActual = normalizarEquipo(resultado.equipo);
          mostrarFichaEquipo(equipoActual);
        }

        estadoEnvio(`Acta guardada en: ${resultado.ruta}`, "ok");
        estadoInventario(
          `Acta registrada · la placa ${datos.placa} quedó como "${
            resultado.estadoEquipo || "actualizada"
          }"`,
          "ok"
        );
        return;
      } catch (err) {
        console.error("No se pudo guardar en el servidor:", err);
        estadoEnvio(
          "El servidor no pudo guardar el acta. Se usará el guardado local…",
          "error"
        );
      }
    }

    // 2) Respaldo: carpeta vinculada del navegador.
    let guardado = false;

    if (carpetaHandle && (await asegurarPermiso(carpetaHandle))) {
      try {
        await guardarBytesEnCarpeta(carpetaHandle, bytes, nombreArchivo);
        guardado = true;
        mostrarEstadoCarpeta(`Guardado: ${nombreArchivo}`, "ok");
      } catch (err) {
        console.warn("No se pudo guardar en la carpeta vinculada:", err);
      }
    }

    // 3) Último recurso: descarga tradicional.
    if (!guardado) {
      descargarArchivo(bytes, nombreArchivo, "application/pdf");
    }

    await enviarWebhook(bytes, nombreArchivo);

    estadoEnvio(
      guardado
        ? `Acta guardada en la carpeta vinculada: ${nombreArchivo}`
        : `Acta descargada: ${nombreArchivo}`,
      "ok"
    );
  } catch (err) {
    console.error("Error al generar el acta:", err);
    estadoEnvio("No se pudo generar el acta: " + (err.message || err), "error");
    alert("Ocurrió un error al generar el acta:\n" + (err.message || err));
  } finally {
    if (boton) {
      boton.disabled = false;
      boton.textContent = textoOriginal;
    }
  }
}

/* ---------------- Eventos e inicialización ---------------- */

function inicializarEventos() {
  const formulario = document.getElementById("actaForm");
  if (formulario) formulario.addEventListener("submit", manejarEnvio);

  const btnConfig = document.getElementById("btnConfigFolder");
  if (btnConfig) btnConfig.addEventListener("click", configurarCarpetaDestino);

  // Vista previa de fotos
  const fotos = [
    { input: "fotoEncendido", preview: "previewEncendido" },
    { input: "fotoFrontal", preview: "previewFrontal" },
    { input: "fotoPosterior", preview: "previewPosterior" },
  ];

  fotos.forEach(({ input, preview }) => {
    const inputEl = document.getElementById(input);
    const previewEl = document.getElementById(preview);
    if (!inputEl || !previewEl) return;

    inputEl.addEventListener("change", () => {
      const file = inputEl.files?.[0];
      if (!file) {
        previewEl.removeAttribute("src");
        previewEl.style.display = "none";
        return;
      }
      const reader = new FileReader();
      reader.onload = (evento) => {
        previewEl.src = evento.target.result;
        previewEl.style.display = "block";
      };
      reader.readAsDataURL(file);
    });
  });

  // "Otro" accesorio
  const otroAccesorioChk = document.getElementById("otroAccesorioChk");
  const otroAccesorio = document.getElementById("otroAccesorio");
  if (otroAccesorioChk && otroAccesorio) {
    const sincronizar = () => {
      otroAccesorio.disabled = !otroAccesorioChk.checked;
      if (!otroAccesorioChk.checked) otroAccesorio.value = "";
    };
    otroAccesorioChk.addEventListener("change", sincronizar);
    sincronizar();
  }

  // "Otro" software
  const otroSoftwareChk = document.getElementById("otroSoftwareChk");
  const otroSoftware = document.getElementById("otroSoftware");
  if (otroSoftwareChk && otroSoftware) {
    const sincronizar = () => {
      otroSoftware.disabled = !otroSoftwareChk.checked;
      if (!otroSoftwareChk.checked) otroSoftware.value = "";
    };
    otroSoftwareChk.addEventListener("change", sincronizar);
    sincronizar();
  }

  // Al cambiar a Devolución, propone al responsable actual del equipo.
  document.querySelectorAll('input[name="tipoActa"]').forEach((radio) => {
    radio.addEventListener("change", autocompletarResponsableActual);
  });

  inicializarAutocompletadoPlaca();
  inicializarCascada();
  inicializarSincronizacionFirmas();

  if (window.FirmasActa && typeof window.FirmasActa.inicializar === "function") {
    window.FirmasActa.inicializar();
  }
}

async function inicializarApp() {
  inicializarEventos();

  try {
    carpetaHandle = await leerHandle();
  } catch (err) {
    carpetaHandle = null;
  }

  await cargarInfoServidor();
  actualizarEstadoCarpeta(carpetaHandle);
  await cargarInventarioSilencioso();

  // Reproducir el video de fondo (por si el navegador bloquea el autoplay).
  const video = document.getElementById("videoFondo");
  if (video) {
    video.playbackRate = 0.5;
    video.defaultPlaybackRate = 0.5;
    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = 0.5;
    });

    const reproducir = video.play();
    if (reproducir && typeof reproducir.catch === "function") {
      reproducir.catch(() => {});
    }
  }

  if (location.protocol === "file:") {
    console.warn(
      "Página abierta con file:///. La API de carpetas y la carga de ./data/inventario.json requieren localhost o HTTPS."
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", inicializarApp);
} else {
  inicializarApp();
}

/* Exponer utilidades para depuración */
window.ActaLevapan = {
  configurarCarpetaDestino,
  generarActaPDF,
  recargarInventario: async () => {
    await cargarInfoServidor();
    actualizarEstadoCarpeta(carpetaHandle);
    await cargarInventarioSilencioso();
  },
  recolectarDatos,
  construirNombreArchivo,
  buscarEquipoPorPlaca,
  buscarEquiposSugeridos,
  autocompletarEquipo,
  inventario: () => inventarioActual,
  servidor: () => ({ activo: servidorActivo, info: infoServidor }),
};
