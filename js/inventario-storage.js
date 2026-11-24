/* ============================================================
   inventario-storage.js | Acta de Tecnología - Levapan
   ------------------------------------------------------------
   Este archivo contiene toda la lógica de la aplicación:

   1) Consulta del inventario de SharePoint por Placa a través de
      server.js (/api/equipos) y autorrelleno del formulario.
      Si el servidor no responde, usa ./data/inventario.json.
   2) Envío del acta al servidor (/api/actas), que genera el PDF y
      lo publica en SharePoint mediante Power Automate.
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

/* Estado de la conexión con el servidor de actas. */
let servidorActivo = false;
let infoServidor = null;
let equipoActual = null;

/* Último error real devuelto por el inventario (para diagnóstico visible). */
let ultimoErrorInventario = "";

/* Indicador de reconexión en modo nube */
let reconectandoNube = false;
let timeoutReconexion = null;

/* ------------------------------------------------------------
   Modo nube (Render / HTTPS)
   ------------------------------------------------------------
   Se detecta por el host: cualquier dirección que no sea local
   (localhost, 127.0.0.1, ::1, file: o una IP de red privada) se
   considera nube. En la nube no existe una carpeta local que el
   navegador pueda vincular: el PDF se genera en el servidor y se
   publica directo en SharePoint. Por eso se ocultan los controles
   de carpeta y el estado se muestra como "Modo Nube Activo".
   ------------------------------------------------------------ */
const MODO_NUBE = (() => {
  if (typeof location === "undefined") return false;
  if (location.protocol === "file:") return false;

  const host = String(location.hostname || "").toLowerCase();
  if (!host) return false;

  // Servidor local.
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return false;
  }

  // Redes privadas: se comportan como servidor local.
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return false;

  return true;
})();

function aplicarInterfazNube() {
  if (!MODO_NUBE) return;

  const btnConfig = document.getElementById("btnConfigFolder");
  if (btnConfig) {
    btnConfig.hidden = true;
    btnConfig.setAttribute("aria-hidden", "true");
  }

  const folderStatus = document.getElementById("folderStatus");
  if (folderStatus) {
    folderStatus.hidden = true;
    folderStatus.textContent = "";
  }
}

/* ------------------------------------------------------------
   Estado de conexión en modo nube: inicial y reconexión automática
   ------------------------------------------------------------ */

/**
 * Mensaje único para cuando no hay inventario disponible. En la nube nunca
 * se debe mostrar el aviso de "inicia el servidor local".
 */
function mensajeSinConexionInventario() {
  return MODO_NUBE
    ? "Conectando con el inventario en la nube..."
    : "Sin conexión al inventario. Inicia el servidor.";
}

/**
 * Marca la conexión con el inventario como activa. Se llama en cuanto
 * /api/estado o /api/equipos/buscar responden bien (200), aunque la
 * comprobación inicial haya fallado, y pinta el indicador en verde.
 */
function marcarConexionNubeActiva(totalEquipos) {
  if (!MODO_NUBE) return;

  servidorActivo = true;
  estadoServidor("Modo Nube Activo (Supabase)", "ok");

  const inv = document.getElementById("inventarioStatus");
  if (!inv) return;

  const textoActual = String(inv.textContent || "").trim();
  const esMensajeDeConexion =
    textoActual === "" ||
    textoActual.includes("Conectando con el inventario en la nube") ||
    textoActual.includes("Sin conexión al inventario");

  if (!esMensajeDeConexion) return;

  const total = Number(totalEquipos);
  inv.textContent =
    Number.isFinite(total) && total > 0
      ? `Inventario en la nube conectado · ${total.toLocaleString("es-CO")} equipos`
      : "Inventario en la nube conectado";
  inv.className = "estado estado-inventario ok";
}

/** Reintenta la conexión en la nube mientras el servidor despierte. */
function programarReconexionNube() {
  if (!MODO_NUBE || reconectandoNube || timeoutReconexion) return;

  reconectandoNube = true;
  timeoutReconexion = setTimeout(async () => {
    reconectandoNube = false;
    timeoutReconexion = null;
    await verificarConexionNube();
  }, 5000);
}

async function inicializarConexionNube() {
  if (!MODO_NUBE) return false;

  estadoServidor("Conectando con el inventario en la nube...", "ok");

  const estadoEl = document.getElementById("estadoInventario");
  if (estadoEl && !equipoActual) {
    estadoEl.textContent = mensajeSinConexionInventario();
    estadoEl.className = "estado estado-inventario ok";
  }

  return verificarConexionNube();
}

async function verificarConexionNube() {
  if (!MODO_NUBE) return false;

  try {
    const respuesta = await fetch("/api/estado", {
      method: "GET",
      cache: "no-store",
    });

    if (!respuesta.ok) throw new Error("HTTP " + respuesta.status);

    const datos = await respuesta.json();
    if (!datos?.ok) throw new Error("Respuesta inválida del servidor");

    infoServidor = datos;
    marcarConexionNubeActiva(datos.totalEquipos);

    // Cancelar cualquier reconexión previa.
    if (timeoutReconexion) {
      clearTimeout(timeoutReconexion);
      timeoutReconexion = null;
    }
    reconectandoNube = false;

    return true;
  } catch (error) {
    servidorActivo = false;
    infoServidor = null;

    estadoServidor("Conectando con el inventario en la nube...", "ok");
    programarReconexionNube();

    return false;
  }
}

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

/** Compara placas ignorando espacios, guiones y puntos: "ML-217050" = "ML- 217050". */
function normalizarPlaca(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[\s.-]+/g, "");
}

/**
 * Normaliza lo escrito en Placa/Serial: mayúsculas y sin espacios ni guiones.
 * "ml-199865" → "ML199865"; "199865" → "199865".
 */
function normalizarTextoBusqueda(valor) {
  return String(valor ?? "")
    .toUpperCase()
    .replace(/[\s-]+/g, "");
}

/**
 * true si la Placa o el Serial del equipo equivalen a lo escrito, con o sin
 * prefijo "ML-": "199865" coincide con "ML-199865".
 */
function coincidePlacaOSerial(equipo, valor) {
  const objetivo = normalizarTextoBusqueda(valor);
  if (!objetivo) return false;

  const sinPrefijo = objetivo.replace(/^ML/, "");
  return [equipo?.placa, equipo?.serial]
    .map((campo) => normalizarTextoBusqueda(campo))
    .filter(Boolean)
    .some(
      (actual) =>
        actual === objetivo || actual.replace(/^ML/, "") === sinPrefijo
    );
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
  if (MODO_NUBE) return;
  const el = document.getElementById("folderStatus");
  if (!el) return;
  el.textContent = mensaje;
  el.className = `estado ${tipo}`.trim();
}

function actualizarEstadoCarpeta(handle) {
  if (MODO_NUBE) return;

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
  if (MODO_NUBE) return;

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

/** Convierte el base64 del servidor en bytes listos para escribir/descargar. */
function base64ABytes(base64) {
  const limpio = String(base64 || "")
    .split(",")
    .pop()
    .replace(/\s+/g, "");
  const binario = atob(limpio);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) {
    bytes[i] = binario.charCodeAt(i);
  }
  return bytes;
}

/** Descarga directa del PDF (útil en celular o sin carpeta vinculada). */
function descargarPdf(bytes, nombreArchivo) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = nombreArchivo;
  enlace.rel = "noopener";
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Deja una copia del PDF en el navegador:
 *  - con "Configurar Carpeta Destino" vinculada → escribe ahí;
 *  - sin carpeta (celular) o si falla → descarga directa.
 */
async function guardarPdfEnDestino(resultado, nombreRespaldo) {
  const base64 = resultado?.pdfBase64;
  if (!base64) return "";

  const nombre = resultado.archivo || nombreRespaldo;
  const bytes = base64ABytes(base64);

  if (carpetaHandle) {
    try {
      await guardarBytesEnCarpeta(carpetaHandle, bytes, nombre);
      return `Copia en tu carpeta destino: ${nombre}`;
    } catch (err) {
      console.warn(
        "No se pudo escribir en la carpeta vinculada; se descarga el PDF:",
        err
      );
    }
  }

  descargarPdf(bytes, nombre);
  return `PDF descargado: ${nombre}`;
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

/* ---------------- Inventario (servidor SharePoint + respaldo JSON) ---------------- */

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
  estado: ["estado", "estadoequipo", "estatus"],
  sede: ["sede", "sedelebapan", "ubicacion", "planta", "ciudad",
    "Tulua", "Tuluá", "Fontibon", "Fontibón", "Sabaneta - Medellin", "Sabaneta",
    "Levapan Calle 72", "Levapan Fontibon", "Otra"],
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
 * actas viven en SharePoint; si no, se usa el JSON estático como respaldo.
 */
async function cargarInfoServidor() {
  // En la nube el backend vive en el mismo origen (rutas relativas /api/...).
  // La verificación se hace contra /api/estado con reintentos automáticos.
  if (MODO_NUBE) return inicializarConexionNube();

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
      `Inventario SharePoint listo · ${datos.enlaceRed || location.origin}`,
      "ok"
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

/* ------------------------------------------------------------
   Sincronización del contador superior
   ------------------------------------------------------------
   El servidor cachea el total solo 60 segundos, así que un equipo
   agregado en SharePoint aparece en el badge sin reiniciar la app. */
const INTERVALO_CONTADOR_MS = 60 * 1000;
let temporizadorContador = null;

/** Reconsulta /api/estado y actualiza únicamente el badge del servidor. */
async function refrescarContadorEquipos() {
  if (typeof document !== "undefined" && document.hidden) return;

  try {
    const respuesta = await fetch(`${API_BASE}/api/estado`, {
      cache: "no-store",
    });
    if (!respuesta.ok) return;

    const datos = await respuesta.json();
    if (!datos?.ok) return;

    servidorActivo = true;
    infoServidor = { ...(infoServidor || {}), ...datos };

    if (MODO_NUBE) {
      marcarConexionNubeActiva(datos.totalEquipos);
    } else {
      estadoServidor(
        `Servidor conectado · ${Number(datos.totalEquipos).toLocaleString("es-CO")} equipos`,
        "ok"
      );
    }
  } catch {
    /* Si falla, se conserva el último contador conocido. */
  }
}

/** Refresca el contador cada minuto y al volver a la pestaña. */
function iniciarSincronizacionContador() {
  if (temporizadorContador) return;

  temporizadorContador = setInterval(
    refrescarContadorEquipos,
    INTERVALO_CONTADOR_MS
  );

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refrescarContadorEquipos();
  });
  window.addEventListener("focus", () => refrescarContadorEquipos());
}

/** Evita llenar la consola cuando el servidor no está disponible. */
let avisoServidorEmitido = false;

function avisarServidorNoDisponible(err) {
  servidorActivo = false;
  if (avisoServidorEmitido) return;
  avisoServidorEmitido = true;
  console.info(
    "Búsqueda local: el servidor de actas no respondió.",
    err?.message || err
  );
}

/** Carga el inventario JSON solo si el servidor de actas no responde. */
async function cargarInventarioSilencioso() {
  // En la nube no hay respaldo JSON local: el inventario siempre es Graph.
  if (MODO_NUBE || servidorActivo) return;

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
    sede: texto(equipo.sede),
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

  // Se consulta la API sin depender de /api/estado: la búsqueda puede estar
  // disponible aunque la comprobación inicial haya fallado o no haya terminado.
  try {
    const respuesta = await fetch(
      `${API_BASE}/api/equipos?placa=${encodeURIComponent(valor)}`,
      { cache: "no-store" }
    );
    if (respuesta.status === 404) {
      // El servidor respondió: la conexión está activa aunque la placa no exista.
      servidorActivo = true;
      ultimoErrorInventario = "";
      marcarConexionNubeActiva();
      return null;
    }
    if (!respuesta.ok) {
      throw new Error(await leerErrorRespuesta(respuesta));
    }

    const datos = await respuesta.json();
    if (!datos?.ok || !datos.equipo) return null;

    servidorActivo = true;
    ultimoErrorInventario = "";
    marcarConexionNubeActiva();
    return normalizarEquipo(datos.equipo);
  } catch (err) {
    if (err?.name === "AbortError") return null;
    ultimoErrorInventario =
      err?.message || "No se pudo consultar el inventario.";
    avisarServidorNoDisponible(err);
  }

  if (!normalizarTextoBusqueda(valor)) return null;
  if (!inventarioActual || !Array.isArray(inventarioActual.datos)) return null;

  const encontrado = inventarioActual.datos.find((equipo) =>
    coincidePlacaOSerial(equipo, valor)
  );
  return encontrado ? normalizarEquipo(encontrado) : null;
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

/* Predeterminados de un acta nueva: 1 accesorio y 10 programas. Se aplican
   al cargar la página y al limpiar el formulario; el técnico puede desmarcar
   cualquiera y el PDF respetará su selección final. */
const ACCESORIOS_PREDETERMINADOS = ["Cargador"];

const SOFTWARE_PREDETERMINADO = [
  "Microsoft Office",
  "Antivirus",
  "Impresora",
  "Google Chrome",
  "WinRAR",
  "Adobe Reader",
  "SAP GUI",
  "Adobe Creative Cloud",
  "7zip",
  "Team Viewer",
];

/** Deja marcados solo los predeterminados y limpia las opciones "Otro". */
function aplicarPredeterminados() {
  const marcar = (nombre, valores) => {
    const objetivo = new Set(valores.map(normalizarTexto));
    document.querySelectorAll(`input[name="${nombre}"]`).forEach((casilla) => {
      casilla.checked = objetivo.has(normalizarTexto(casilla.value));
      casilla.disabled = false;
    });
  };

  marcar("accesorios", ACCESORIOS_PREDETERMINADOS);
  marcar("software", SOFTWARE_PREDETERMINADO);

  [
    ["otroAccesorioChk", "otroAccesorio"],
    ["otroSoftwareChk", "otroSoftware"],
  ].forEach(([chkId, inputId]) => {
    const chk = document.getElementById(chkId);
    const input = document.getElementById(inputId);
    if (chk) chk.checked = false;
    if (input) {
      input.value = "";
      input.disabled = true;
    }
  });
}

/* Equivalencias del inventario: en SharePoint el cargador aparece a veces
   como "Adaptador". Se unifica en la única casilla Cargador para no crear
   una opción duplicada ni enviarlo como accesorio "Otro". */
const ALIAS_ACCESORIOS = new Map([["adaptador", "Cargador"]]);

function unificarAccesorio(valor) {
  const limpio = String(valor ?? "").trim();
  const clave = normalizarTexto(limpio);
  if (ALIAS_ACCESORIOS.has(clave)) return ALIAS_ACCESORIOS.get(clave);
  if (clave.startsWith("adaptador")) return "Cargador";
  return limpio;
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

  const predeterminados = new Set(
    ACCESORIOS_PREDETERMINADOS.map(normalizarTexto)
  );
  conocidos.forEach((input) => {
    // Parte de los predeterminados (Cargador) y suma los del inventario.
    input.checked = predeterminados.has(normalizarTexto(input.value));
    input.disabled = false;
  });

  valores.forEach((valor) => {
    // "Adaptador" y "Cargador" del inventario activan la misma casilla.
    const unificado = unificarAccesorio(valor);
    const input = mapa.get(normalizarTexto(unificado));
    if (input && !usados.has(input)) {
      input.checked = true;
      usados.add(input);
    } else if (!input) {
      desconocidos.push(unificado);
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

  // Responsable y cédula registrados en SharePoint, sincronizados con Firmas.
  // Si el equipo no tiene responsable se limpian para no arrastrar datos de
  // una búsqueda anterior.
  asignarValor("nombre", equipo.usuario_actual, true);
  asignarValor("colaborador", equipo.usuario_actual, true);
  asignarValor("documento", equipo.cedula_usuario, true);
  // Sincronizar sede del inventario al campo del formulario.
  asignarValor("sede", equipo.sede, true);

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

/** Extrae el mensaje real de una respuesta de error del servidor. */
async function leerErrorRespuesta(respuesta) {
  let mensaje = `HTTP ${respuesta.status}`;

  try {
    const cuerpo = await respuesta.clone().json();
    const partes = [];
    if (cuerpo?.error) partes.push(String(cuerpo.error));
    if (cuerpo?.detalle?.grafoStatus) {
      partes.push(`Graph HTTP ${cuerpo.detalle.grafoStatus}`);
    }
    if (cuerpo?.detalle?.causa) {
      partes.push(`causa: ${cuerpo.detalle.causa}`);
    }
    if (partes.length) {
      mensaje = `${partes.join(" · ")} (HTTP ${respuesta.status})`;
    }
  } catch {
    try {
      const cuerpoTexto = await respuesta.clone().text();
      if (cuerpoTexto) {
        mensaje = `${cuerpoTexto.slice(0, 300)} (HTTP ${respuesta.status})`;
      }
    } catch {
      /* Sin cuerpo legible. */
    }
  }

  return mensaje;
}

/** Respaldo de búsqueda: /api/equipos?q= usa la misma lista de SharePoint. */
async function buscarEquiposRespaldo(texto, signal) {
  const respuesta = await fetch(
    `${API_BASE}/api/equipos?q=${encodeURIComponent(texto)}`,
    { cache: "no-store", signal }
  );

  if (!respuesta.ok) throw new Error(await leerErrorRespuesta(respuesta));

  const datos = await respuesta.json();
  if (!datos?.ok) {
    throw new Error(datos?.error || "Respuesta inválida del servidor");
  }

  return (datos.equipos || []).map(normalizarEquipo).filter(Boolean);
}

/** Búsqueda en el JSON local (solo fuera de la nube). */
function buscarEnInventarioLocal(texto) {
  if (!inventarioActual || !Array.isArray(inventarioActual.datos)) return [];

  // Caché en memoria: placa con o sin prefijo "ML-" y también por serial.
  const normalizado = normalizarTextoBusqueda(texto);
  const sinPrefijo = normalizado.replace(/^ML/, "");
  const claves = [normalizado];
  if (sinPrefijo && sinPrefijo !== normalizado) claves.push(sinPrefijo);

  const porPrefijo = inventarioActual.datos.filter((equipo) => {
    const placa = normalizarTextoBusqueda(equipo.placa);
    return claves.some((clave) => placa.startsWith(clave));
  });
  const lista = porPrefijo.length
    ? porPrefijo
    : inventarioActual.datos.filter((equipo) => {
        const placa = normalizarTextoBusqueda(equipo.placa);
        const serial = normalizarTextoBusqueda(equipo.serial);
        return claves.some(
          (clave) => placa.includes(clave) || serial.includes(clave)
        );
      });

  return lista.slice(0, 30).map(normalizarEquipo);
}

/**
 * Busca equipos en vivo contra SharePoint. Devuelve `{ equipos, error }`.
 * - `null` si la petición se abortó por una búsqueda más reciente.
 * - `error` conserva el detalle real del servidor para mostrarlo en la UI.
 */
async function buscarEquiposSugeridos(consulta, signal) {
  const texto = String(consulta ?? "").trim();
  if (!texto) return { equipos: [], error: "" };

  let errorPrincipal = "";

  try {
    const respuesta = await fetch(
      `${API_BASE}/api/equipos/buscar?q=${encodeURIComponent(texto)}`,
      { cache: "no-store", signal }
    );

    if (!respuesta.ok) {
      throw new Error(await leerErrorRespuesta(respuesta));
    }

    const datos = await respuesta.json();
    if (!datos?.ok) {
      throw new Error(datos?.error || "Respuesta inválida del servidor");
    }

    servidorActivo = true;
    ultimoErrorInventario = "";
    // La búsqueda respondió bien: la nube está conectada aunque /api/estado
    // haya fallado al cargar la página.
    marcarConexionNubeActiva(datos.total);
    return {
      equipos: (datos.equipos || []).map(normalizarEquipo).filter(Boolean),
      error: "",
    };
  } catch (err) {
    // Petición cancelada por una búsqueda más reciente: no es un error real.
    if (err?.name === "AbortError") return null;
    errorPrincipal = err?.message || "No se pudo consultar el servidor.";
    ultimoErrorInventario = errorPrincipal;
    avisarServidorNoDisponible(err);
  }

  // Respaldo: la ruta /api/equipos?q= consulta la misma lista.
  try {
    const equipos = await buscarEquiposRespaldo(texto, signal);
    servidorActivo = true;
    ultimoErrorInventario = "";
    marcarConexionNubeActiva(equipos.length);
    return { equipos, error: "" };
  } catch (err) {
    if (err?.name === "AbortError") return null;
    console.info("Respaldo de búsqueda no disponible:", err?.message || err);
  }

  // Último recurso: inventario local (solo fuera de la nube).
  const locales = buscarEnInventarioLocal(texto);
  if (locales.length) {
    ultimoErrorInventario = "";
    return { equipos: locales, error: "" };
  }

  return { equipos: [], error: errorPrincipal };
}

function describirEquipo(equipo) {
  const tipo = String(equipo?.tipo ?? "").trim();
  const marca = String(equipo?.marca ?? "").trim();
  const modelo = String(equipo?.modelo ?? "").trim();

  // "HP" + "HP ProBook 4 G1i" → "HP ProBook 4 G1i" (sin repetir la marca).
  const marcaEnModelo =
    marca &&
    modelo &&
    normalizarTexto(modelo).startsWith(normalizarTexto(marca));

  return (
    [tipo, marcaEnModelo ? "" : marca, modelo].filter(Boolean).join(" ") ||
    "Equipo sin descripción"
  );
}

function detalleSugerencia(equipo) {
  const serial = equipo.serial ? ` (Serial: ${equipo.serial})` : "";
  return `— ${describirEquipo(equipo)}${serial}`;
}

/** Muestra un aviso discreto debajo del campo Placa (error real de Graph). */
function mostrarAvisoPlaca(mensaje) {
  const aviso = document.getElementById("placaAviso");
  if (!aviso) return;
  const texto = String(mensaje ?? "").trim();
  if (!texto) {
    aviso.textContent = "";
    aviso.hidden = true;
    return;
  }
  aviso.textContent = texto;
  aviso.hidden = false;
}

/** Oculta el aviso de Placa. */
function limpiarAvisoPlaca() {
  mostrarAvisoPlaca("");
}

/** Crea (si hace falta) el desplegable Liquid Glass bajo el campo Placa. */
function crearContenedorSugerencias(placaInput) {
  let contenedor = document.getElementById("placaSugerencias");
  if (contenedor) return contenedor;

  const caja =
    placaInput.closest(".campo-placa-caja") || placaInput.parentElement;
  if (!caja) return null;

  contenedor = document.createElement("div");
  contenedor.id = "placaSugerencias";
  contenedor.className = "placa-sugerencias";
  contenedor.setAttribute("role", "listbox");
  contenedor.setAttribute("aria-label", "Equipos encontrados");
  contenedor.hidden = true;
  caja.appendChild(contenedor);
  return contenedor;
}

function inicializarAutocompletadoPlaca() {
  const placaInput = document.getElementById("placa");
  const contenedor = placaInput ? crearContenedorSugerencias(placaInput) : null;
  if (!placaInput || !contenedor) return;

  let temporizador = null;
  let indiceActivo = -1;
  let sugerencias = [];
  let turno = 0;
  let controlador = null;

  /** Cancela la petición en curso: evita respuestas viejas y avisos falsos. */
  const abortarBusqueda = () => {
    if (!controlador) return;
    controlador.abort();
    controlador = null;
  };

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
    abortarBusqueda();

    if (!valor) {
      limpiarFichaEquipo();
      limpiarAvisoPlaca();
      placaInput.removeAttribute("aria-invalid");
      placaInput.style.borderColor = "";
      return;
    }

    const actual = ++turno;
    const equipo = await buscarEquipoPorPlaca(valor);
    if (actual !== turno) return;

    if (equipo) {
      limpiarAvisoPlaca();
      placaInput.value = equipo.placa;
      marcarValida();
      autocompletarEquipo(equipo);
      estadoInventario(`Equipo encontrado: ${describirEquipo(equipo)}`, "ok");
    } else if (mostrarError) {
      limpiarFichaEquipo();
      marcarInvalida();

      if (ultimoErrorInventario) {
        mostrarAvisoPlaca(
          `No se pudo consultar el inventario: ${ultimoErrorInventario}`
        );
        estadoInventario(
          "No se pudo consultar el inventario en SharePoint",
          "error"
        );
        return;
      }

      limpiarAvisoPlaca();
      const sinConexion = !servidorActivo && !inventarioActual;
      estadoInventario(
        sinConexion
          ? mensajeSinConexionInventario()
          : "Placa no registrada en el inventario",
        sinConexion && MODO_NUBE ? "ok" : "error"
      );
    }
  };

  /** Consulta en vivo desde el segundo carácter y pinta la lista. */
  const actualizarSugerencias = async () => {
    const valor = placaInput.value.trim();
    const actual = ++turno;

    if (valor.length < 2) {
      abortarBusqueda();
      cerrar();
      limpiarAvisoPlaca();
      placaInput.removeAttribute("aria-invalid");
      placaInput.style.borderColor = "";
      if (!valor) limpiarFichaEquipo();
      return;
    }

    // Cancela la petición anterior antes de lanzar la nueva.
    abortarBusqueda();
    controlador = new AbortController();

    estadoInventario(`Buscando equipos con "${valor}"…`);
    const resultado = await buscarEquiposSugeridos(valor, controlador.signal);
    if (resultado === null) return; // petición cancelada por otra búsqueda
    if (actual !== turno) return;

    const equipos = resultado.equipos || [];
    const error = String(resultado.error ?? "").trim();

    // Error real del servidor (Graph/SharePoint) o de red: se muestra el
    // detalle bajo el campo Placa en lugar de fallar en silencio.
    if (error) {
      cerrar();
      mostrarAvisoPlaca(`No se pudo consultar el inventario: ${error}`);
      estadoInventario(
        "No se pudo consultar el inventario en SharePoint",
        "error"
      );
      return;
    }

    limpiarAvisoPlaca();

    // Ni servidor ni inventario local: no hay de dónde obtener sugerencias.
    // En la nube se muestra un aviso neutro y se reintenta en la próxima tecla.
    if (!equipos.length && !servidorActivo && !inventarioActual) {
      cerrar();
      estadoInventario(
        mensajeSinConexionInventario(),
        MODO_NUBE ? "ok" : "error"
      );
      return;
    }

    // Coincidencia exacta por Placa o Serial, escriba "199865" o "ML-199865".
    // Solo se autorrellena si hay una única coincidencia equivalente.
    const equivalentes = equipos.filter((equipo) =>
      coincidePlacaOSerial(equipo, valor)
    );
    if (equivalentes.length === 1) {
      elegir(equivalentes[0]);
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
    // 350 ms: suficiente para no saturar la red móvil mientras se escribe.
    temporizador = setTimeout(actualizarSugerencias, 350);
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
      abortarBusqueda();
      cerrar();
    }
  });

  placaInput.addEventListener("blur", () => {
    clearTimeout(temporizador);
    abortarBusqueda();
    // Deja terminar el clic en una sugerencia antes de cerrar la lista.
    setTimeout(() => {
      cerrar();
      consultarExacta(false);
    }, 140);
  });
}

/* ---------------- Agente TI y firmas ---------------- */

const LS_DOCUMENTOS_TI = "actaLevapan.documentosTi";

/* Cédulas precargadas de los Agentes TI autorizados.
   Wilson Perez y Michel Salazar quedan editables: si ya se registró su
   cédula en este equipo se recupera automáticamente desde localStorage. */
const DOCUMENTOS_TI_CONOCIDOS = {
  "Harold Moreno": "1087778841",
  "Wilson Perez": "",
  "Michel Salazar": "",
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

/* ---------------- Sesión SSO (Microsoft Entra ID) ---------------- */

const AGENTES_TI = ["Harold Moreno", "Wilson Perez", "Michel Salazar"];

/** "Harold Adrián" → "haroldadrian" (sin tildes ni signos). */
function normalizarAgente(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Agente TI cuyo nombre o correo coincida con la cuenta autenticada. */
function agenteSesion(usuario) {
  const nombre = normalizarAgente(usuario?.name);
  const correo = normalizarAgente(String(usuario?.email ?? "").split("@")[0]);

  return (
    AGENTES_TI.find((agente) => {
      const clave = normalizarAgente(agente);
      if (!clave) return false;
      return nombre.includes(clave) || correo.includes(clave);
    }) || ""
  );
}

/**
 * Autocompleta Agente TI y cédula desde /api/perfil (perfiles_ti de Supabase).
 * Si el nombre no está en el catálogo, se añade como opción dinámica.
 */
function preseleccionarAgenteSesion(usuario) {
  const select = document.getElementById("nombreTi");
  const cedulaTi = document.getElementById("documentoTi");
  if (!select) return;

  const nombre =
    usuario?.nombre_completo ||
    usuario?.name ||
    agenteSesion({
      name: usuario?.name,
      email: usuario?.email,
    });
  if (!nombre) return;

  let opcion = [...select.options].find(
    (item) => normalizarAgente(item.value) === normalizarAgente(nombre)
  );
  if (!opcion) {
    opcion = document.createElement("option");
    opcion.value = nombre;
    opcion.textContent = nombre;
    select.appendChild(opcion);
  }

  select.value = opcion.value;

  if (cedulaTi && usuario?.cedula) {
    cedulaTi.value = String(usuario.cedula);
    cedulaTi.readOnly = false;
    guardarDocumentoTi(opcion.value, cedulaTi.value.trim());
  }

  // Dispara la carga de la cédula y la firma del Agente TI.
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Espera al perfil TI de Supabase y completa los datos del agente. */
async function cargarSesionUsuario() {
  const etiqueta = document.getElementById("sesionNombre");

  try {
    let usuario = null;
    if (window.AuthLevapan) {
      await window.AuthLevapan.listo;
      usuario = window.AuthLevapan.perfil;
    }
    if (!usuario) {
      const respuesta = await fetch("/api/me", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      usuario = await respuesta.json();
    }

    if (etiqueta) {
      etiqueta.textContent = `Conectado como: ${usuario.nombre_completo || usuario.name || usuario.email}`;
      etiqueta.title = usuario.email || "";
    }
    preseleccionarAgenteSesion(usuario);
  } catch (err) {
    if (etiqueta) etiqueta.textContent = "Sesión no disponible";
    console.warn("No se pudo leer la sesión del usuario:", err);
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
    if (documentoTi) {
      // La cédula siempre queda editable; para Harold se precarga la conocida
      // y para los demás se recupera la última registrada en este equipo.
      documentoTi.readOnly = false;
      documentoTi.value = recordado || conocido || "";
      documentoTi.placeholder = agente.value
        ? "CC editable del Agente TI"
        : "Número de cédula del Agente TI";
    }
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

  const sedeSelect = document.getElementById("sede");
  const sedeValue = sedeSelect ? sedeSelect.value : "";
  const sedeOtroInput = document.getElementById("sedeOtro") || null;
  const sedeOtro = sedeOtroInput ? sedeOtroInput.value.trim() : "";

  // Si el usuario eligió "Otra", usar el texto libre; sino usar el valor del select.
  const sede = sedeValue === "Otra" ? (sedeOtro || "") : sedeValue;

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
    sede, // <-- Añadido: sede del equipo (puede ser "Otra" + texto)
    sedeOtro, // <-- Nuevo: texto libre si el usuario eligió "Otra"
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

/** Comprime una foto y la devuelve como data URL JPEG para enviarla al servidor. */
async function convertirImagenADataUrl(file) {
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
  if (!ctx) throw new Error("No se pudo procesar la imagen");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ancho, alto);
  ctx.drawImage(imagen, 0, 0, ancho, alto);

  return canvas.toDataURL("image/jpeg", 0.86);
}

/** Serializa las fotos seleccionadas para que el servidor arme el PDF. */
async function serializarFotos(fotos) {
  const salida = {};

  for (const [clave, archivo] of Object.entries(fotos || {})) {
    if (!archivo) continue;
    try {
      salida[clave] = await convertirImagenADataUrl(archivo);
    } catch (err) {
      console.warn(`No se pudo preparar la foto "${clave}":`, err);
    }
  }

  return salida;
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

/* --- Relleno del formato oficial CORP-TEC-FR-002 (template.pdf) --- */

const PLANTILLA_ACTA = "template.pdf";

const ACCESORIOS_PDF = [
  ["Cargador", "cargadorsi", "cargadorno"],
  ["Mouse", "mousesi", "mouseno"],
  ["Teclado", "tecladosi", "tecladono"],
  ["Morral", "morralsi", "morralno"],
  ["Forro", "forrosi", "forrono"],
  ["Base Refrigerante", "basesi", "baseno"],
  ["Base Soporte", "soportesi", "soporteno"],
  ["Multipuerto USB", "usbsi", "usbno"],
];

const SOFTWARE_PDF = [
  ["Microsoft Office", "officesi", "officeno"],
  ["Antivirus", "antivirussi", "antivirusno"],
  ["Impresora", "impresorasi", "impresorano"],
  ["Softphone", "softphonesi", "softphoneno"],
  ["Google Chrome", "googlesi", "googleno"],
  ["WinRAR", "winrarsi", "winrarno"],
  ["Adobe Reader", "adobesi", "adobeno"],
  ["Foxit Reader", "foxitreadersi", "foxitreaderno"],
  ["SAP GUI", "sapguisi", "sapguino"],
  ["Adobe Creative Cloud", "adobeCloudsi", "adobeCloudno"],
  ["7zip", "zipsi", "zipno"],
  ["VPN", "forticlientsi", "forticlientno"],
  ["Team Viewer", "teamviewersi", "teamviewerno"],
  ["Sofsin", "sofsinsi", "sofsinno"],
];

const CAMPOS_OTRO_ACCESORIOS = ["Texto73", "Texto74", "Texto75", "Texto76"];
const COLOR_CELDA_PDF = [241 / 255, 242 / 255, 241 / 255];

/** Normaliza un texto para comparar etiquetas del formulario. */
function compararPdf(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

/** Indica si una etiqueta está marcada dentro de la lista del formulario. */
function estaMarcadoPdf(lista, etiqueta) {
  const objetivo = compararPdf(etiqueta);
  return (lista || []).some((valor) => {
    const actual = compararPdf(valor);
    return actual === objetivo || actual.startsWith(`${objetivo}:`);
  });
}

/** Devuelve el texto libre escrito en la opción "Otro". */
function textoOtroPdf(lista) {
  const valor = (lista || []).find((item) => compararPdf(item).startsWith("otro"));
  return valor ? String(valor).replace(/^otro\s*:?\s*/i, "").trim() : "";
}

/** Escribe un campo de texto y ajusta el tamaño para que quepa en el recuadro. */
function escribirCampoPdf(form, fuente, nombre, valor, opciones = {}) {
  const { tamano = 9, minimo = 5.5, ajustar = true } = opciones;
  try {
    const campo = form.getTextField(nombre);
    const texto = limpiarTextoPdf(valor ?? "");
    campo.setText(texto);

    let tamanoFinal = tamano;
    if (ajustar && texto) {
      const anchos = campo.acroField
        .getWidgets()
        .map((widget) => widget.getRectangle().width);
      const anchoDisponible = Math.max(1, Math.min(...anchos) - 4);
      while (
        tamanoFinal > minimo &&
        fuente.widthOfTextAtSize(texto, tamanoFinal) > anchoDisponible
      ) {
        tamanoFinal -= 0.25;
      }
    }
    campo.setFontSize(tamanoFinal);
  } catch (err) {
    console.warn(`No se pudo escribir el campo "${nombre}" del acta:`, err);
  }
}

/** Marca o desmarca una casilla del formulario. */
function marcarCasillaPdf(form, nombre, activo) {
  try {
    const casilla = form.getCheckBox(nombre);
    if (activo) casilla.check();
    else casilla.uncheck();
  } catch (err) {
    console.warn(`No se pudo marcar la casilla "${nombre}" del acta:`, err);
  }
}

/** Oculta el texto guía "cuál" del formato cuando se escribe un valor encima. */
function taparGuiaPdf(pagina, campo, colorBlanco) {
  try {
    const [widget] = campo.acroField.getWidgets();
    const rect = widget.getRectangle();
    pagina.drawRectangle({
      x: rect.x + 20,
      y: rect.y + 2,
      width: Math.max(0, rect.width - 22),
      height: Math.max(0, rect.height - 4),
      color: colorBlanco,
    });
  } catch (err) {
    console.warn("No se pudo limpiar la guía del campo del acta:", err);
  }
}

async function generarActaPDF(datos) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib || {};
  if (!PDFDocument) {
    throw new Error("La librería pdf-lib no está disponible. Revisa tu conexión a internet.");
  }

  const respuesta = await fetch(PLANTILLA_ACTA, { cache: "no-cache" });
  if (!respuesta.ok) {
    throw new Error("No se pudo cargar el formato oficial template.pdf.");
  }

  const pdfDoc = await PDFDocument.load(await respuesta.arrayBuffer(), {
    ignoreEncryption: true,
  });
  const form = pdfDoc.getForm();
  const fuente = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pagina1 = pdfDoc.getPage(0);

  /* --- Página 1: declaración y características del equipo --- */
  escribirCampoPdf(form, fuente, "name", datos.nombre, { tamano: 10 });
  escribirCampoPdf(form, fuente, "ID", datos.documento, { tamano: 10 });
  escribirCampoPdf(form, fuente, "tipoEquipo", datos.tipo);
  escribirCampoPdf(form, fuente, "marcaEquipo", datos.marca);
  escribirCampoPdf(form, fuente, "modeloEquipo", datos.modelo);
  escribirCampoPdf(form, fuente, "serial", datos.serial);
  escribirCampoPdf(form, fuente, "placa", datos.placa);

  marcarCasillaPdf(form, "cc", true);
  marcarCasillaPdf(form, "ti", false);

  const esDevolucion = compararPdf(datos.tipoActa) === "devolucion";
  marcarCasillaPdf(form, "asignacion", !esDevolucion);
  marcarCasillaPdf(form, "devolucion", esDevolucion);

  /* --- Accesorios: SI / NO y textos de "Otro" --- */
  const accesorios = datos.accesorios || [];
  const tieneBase = accesorios.some((valor) => compararPdf(valor) === "base");
  for (const [etiqueta, si, no] of ACCESORIOS_PDF) {
    let activo = estaMarcadoPdf(accesorios, etiqueta);
    if (etiqueta === "Base Soporte" && tieneBase) activo = true;
    // "Adaptador" del formulario también marca CARGADOR en el PDF.
    if (etiqueta === "Cargador") {
      activo = activo || estaMarcadoPdf(accesorios, "Adaptador");
    }
    marcarCasillaPdf(form, si, activo);
    marcarCasillaPdf(form, no, !activo);
  }

  /* --- Software instalado: SI / NO y texto de "Otro" --- */
  const software = datos.software || [];
  for (const [etiqueta, si, no] of SOFTWARE_PDF) {
    const activo = estaMarcadoPdf(software, etiqueta);
    marcarCasillaPdf(form, si, activo);
    marcarCasillaPdf(form, no, !activo);
  }

  const extrasAccesorios = accesorios
    .filter((valor) => {
      const texto = compararPdf(valor);
      if (!texto || texto === "base") return false;
      // "Adaptador" se refleja en la casilla CARGADOR, no como texto libre.
      if (texto === "adaptador") return false;
      if (texto.startsWith("otro")) return true;
      return !ACCESORIOS_PDF.some(([etiqueta]) => compararPdf(etiqueta) === texto);
    })
    .map((valor) => String(valor).replace(/^otro\s*:?\s*/i, "").trim())
    .filter(Boolean);

  CAMPOS_OTRO_ACCESORIOS.forEach((campo, indice) => {
    const valor = extrasAccesorios[indice];
    if (!valor) return;
    escribirCampoPdf(form, fuente, campo, valor, { tamano: 7, minimo: 5 });
    taparGuiaPdf(pagina1, form.getTextField(campo), rgb(...COLOR_CELDA_PDF));
  });

  const otroSoftware = textoOtroPdf(software);
  if (otroSoftware) {
    escribirCampoPdf(form, fuente, "Texto77", otroSoftware, { tamano: 7, minimo: 5 });
    taparGuiaPdf(pagina1, form.getTextField("Texto77"), rgb(...COLOR_CELDA_PDF));
  }

  /* --- Observaciones ajustadas al recuadro --- */
  const campoObservaciones = form.getTextField("observaciones");
  const [widgetObservaciones] = campoObservaciones.acroField.getWidgets();
  const rectObservaciones = widgetObservaciones.getRectangle();
  const tamanoObservaciones = 8.5;
  const lineasObservaciones = envolverTexto(
    datos.observaciones,
    fuente,
    tamanoObservaciones,
    rectObservaciones.width - 8
  );
  const maximoLineas = Math.max(
    1,
    Math.floor((rectObservaciones.height - 8) / (tamanoObservaciones * 1.2))
  );
  if (lineasObservaciones.length > maximoLineas) {
    lineasObservaciones.length = maximoLineas;
    lineasObservaciones[maximoLineas - 1] = `${lineasObservaciones[maximoLineas - 1]
      .replace(/\s+\S*$/, "")
      .trim()}...`;
  }
  escribirCampoPdf(form, fuente, "observaciones", lineasObservaciones.join("\n"), {
    tamano: tamanoObservaciones,
    ajustar: false,
  });

  /* --- Página 2: constancia y datos de las firmas --- */
  escribirCampoPdf(form, fuente, "ciudad", "Bogotá D.C.", { tamano: 9 });
  escribirCampoPdf(form, fuente, "fecha", ` ${fechaCorta(datos.fecha || new Date())}`, {
    tamano: 9,
  });
  escribirCampoPdf(form, fuente, "nameTi", datos.agenteTi, { tamano: 9 });
  escribirCampoPdf(form, fuente, "IDTI", datos.documentoTi, { tamano: 9 });

  /* --- Fotos y firmas dentro de los recuadros del formato --- */
  const incrustarBoton = async (nombre, bytes, tipo) => {
    if (!bytes) return;
    try {
      const imagen =
        tipo === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      form.getButton(nombre).setImage(imagen);
    } catch (err) {
      console.warn(`No se pudo incrustar la imagen en "${nombre}":`, err);
    }
  };

  const fotos = datos.fotos || {};
  const fotosPorCampo = [
    ["signature", fotos.encendido],
    ["signature2", fotos.frontal],
    ["signature3", fotos.posterior],
  ];
  for (const [campo, archivo] of fotosPorCampo) {
    if (!archivo) continue;
    try {
      await incrustarBoton(campo, await convertirImagenAJpeg(archivo), "jpg");
    } catch (err) {
      console.warn(`No se pudo procesar la foto para "${campo}":`, err);
    }
  }

  const firmas = datos.firmas || {};
  const firmasPorCampo = [
    ["firmaUsuario", firmas.colaborador],
    ["firmaTecnico", firmas.agente],
  ];
  for (const [campo, dataUrl] of firmasPorCampo) {
    if (!dataUrl) continue;
    try {
      await incrustarBoton(campo, dataUrlABytes(dataUrl), "png");
    } catch (err) {
      console.warn(`No se pudo procesar la firma para "${campo}":`, err);
    }
  }

  /* Deja el acta como documento final (sin edición de campos). */
  form.getFields().forEach((campo) => {
    try {
      campo.enableReadOnly();
    } catch (err) {
      /* Algunos campos no admiten solo lectura; no es crítico. */
    }
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

function estadoEnvio(mensaje, tipo = "", enlace = "") {
  const el = document.getElementById("envioStatus");
  if (!el) return;

  el.className = `estado ${tipo}`.trim();
  el.textContent = mensaje;

  if (/^https?:\/\//i.test(String(enlace || ""))) {
    const ancla = document.createElement("a");
    ancla.href = enlace;
    ancla.target = "_blank";
    ancla.rel = "noopener noreferrer";
    ancla.textContent = "Ver / Descargar PDF";
    el.append(document.createTextNode(" · "), ancla);
  }
}

/** Datos serializables para la API (las fotos se envían aparte comprimidas). */
function datosParaServidor(datos) {
  const { fotos, fecha, ...resto } = datos;
  return {
    ...resto,
    fecha: fecha instanceof Date ? fecha.toISOString() : new Date().toISOString(),
  };
}

/** Envía los datos y las imágenes al servidor para que genere el PDF oficial. */
async function enviarActaAlServidor(datos, nombreArchivo) {
  const fotos = await serializarFotos(datos.fotos);

  const respuesta = await fetch(`${API_BASE}/api/actas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      archivo: nombreArchivo,
      datos: datosParaServidor(datos),
      fotos,
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
    estadoEnvio("Preparando los datos y las imágenes...", "");

    const datos = recolectarDatos();
    const nombreArchivo = construirNombreArchivo(datos);

    estadoEnvio("El servidor está generando el PDF oficial CORP-TEC-FR-002…");

    // El servidor genera el PDF y lo sube a SharePoint (Nube Levapan).
    // En Windows además deja copia en C:\Actas-Levapan\Actas_Guardadas\;
    // en la nube (Linux) no hay disco persistente.
    const resultado = await enviarActaAlServidor(datos, nombreArchivo);

    // Copia adicional: carpeta vinculada o descarga directa (celular).
    const copia = await guardarPdfEnDestino(resultado, nombreArchivo);

    if (resultado.equipo) {
      equipoActual = normalizarEquipo(resultado.equipo);
      mostrarFichaEquipo(equipoActual);
    }

    const urlPDF = resultado.url || resultado.urlFirmada || "";
    const consecutivo = resultado.consecutivo ? ` N.º ${resultado.consecutivo}` : "";

    estadoEnvio(
      `Acta CORP-TEC-FR-002${consecutivo} guardada en Supabase Storage · ${copia || "PDF listo"}`,
      "ok",
      urlPDF
    );
    estadoInventario(
      `Acta registrada · la placa ${datos.placa} quedó como "${
        resultado.estadoEquipo || "actualizada"
      }"`,
      "ok"
    );
  } catch (err) {
    console.error("Error al guardar el acta:", err);
    estadoEnvio("No se pudo guardar el acta: " + (err.message || err), "error");
    alert(
      "No se pudo guardar el acta en Supabase:\n" +
        (err.message || err) +
        "\n\nVerifica tu sesión y que el servidor esté encendido y configurado."
    );
  } finally {
    if (boton) {
      boton.disabled = false;
      boton.textContent = textoOriginal;
    }
  }
}

/* ---------------- Limpieza total del formulario ---------------- */

function limpiarFormularioCompleto() {
  const formulario = document.getElementById("actaForm");
  if (formulario) formulario.reset();

  // Selects dependientes: se reconstruyen desde el catálogo base.
  const selectTipo = document.getElementById("tipo");
  llenarSelect(selectTipo, valoresTipos(), "Seleccione el Tipo");
  actualizarMarcas("");
  actualizarModelos("", "");

  // El estado pudo recibir opciones del inventario; se dejan solo las base.
  const estadosBase = new Set([
    "",
    "Disponible",
    "Disponible Para Asignar",
    "Asignado",
    "Prestamo",
    "En laboratorio de pruebas",
    "En laboratorio para dar de baja",
    "Para devolución a proveedor",
    "Dado de baja",
  ]);
  const selectEstado = document.getElementById("estado");
  if (selectEstado) {
    [...selectEstado.options].forEach((opcion) => {
      if (!estadosBase.has(opcion.value)) opcion.remove();
    });
    selectEstado.value = "";
    selectEstado.disabled = true;
  }

  // Campos de texto, incluidas las cédulas editables.
  [
    "nombre",
    "documento",
    "documentoTi",
    "serial",
    "placa",
    "observaciones",
    "firmaNombreColaborador",
    "firmaDocumentoColaborador",
    "firmaNombreAgente",
    "firmaDocumentoAgente",
  ].forEach((id) => {
    const campo = document.getElementById(id);
    if (campo) campo.value = "";
  });

  // Checks de accesorios y software: vuelven a los predeterminados.
  aplicarPredeterminados();

  ["otroAccesorio", "otroSoftware"].forEach((id) => {
    const campo = document.getElementById(id);
    if (campo) {
      campo.value = "";
      campo.disabled = true;
    }
  });

  // Fotos y vistas previas.
  [
    ["fotoEncendido", "previewEncendido"],
    ["fotoFrontal", "previewFrontal"],
    ["fotoPosterior", "previewPosterior"],
  ].forEach(([inputId, previewId]) => {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (input) input.value = "";
    if (preview) {
      preview.removeAttribute("src");
      preview.style.display = "none";
    }
  });

  // Firmas: se borran por completo los dos canvas.
  window.FirmasActa?.limpiarTodas?.();

  // Búsqueda de placa y ficha del equipo.
  const placa = document.getElementById("placa");
  if (placa) {
    placa.removeAttribute("aria-invalid");
    placa.removeAttribute("aria-activedescendant");
    placa.setAttribute("aria-expanded", "false");
    placa.style.borderColor = "";
    placa.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const sugerencias = document.getElementById("placaSugerencias");
  if (sugerencias) {
    sugerencias.hidden = true;
    sugerencias.innerHTML = "";
  }
  limpiarFichaEquipo();

  estadoEnvio("Formulario limpio. Listo para una nueva acta.", "ok");
}

/* ---------------- Eventos e inicialización ---------------- */

function inicializarEventos() {
  aplicarInterfazNube();

  // Acta nueva: Cargador + los 10 programas base marcados.
  aplicarPredeterminados();

  const formulario = document.getElementById("actaForm");
  if (formulario) formulario.addEventListener("submit", manejarEnvio);

  const btnLimpiar = document.getElementById("btnLimpiar");
  if (btnLimpiar) btnLimpiar.addEventListener("click", limpiarFormularioCompleto);

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
  await cargarSesionUsuario();

  try {
    carpetaHandle = await leerHandle();
  } catch (err) {
    carpetaHandle = null;
  }

  await cargarInfoServidor();
  actualizarEstadoCarpeta(carpetaHandle);
  await cargarInventarioSilencioso();
  iniciarSincronizacionContador();

  // El video de fondo solo se reproduce en pantallas grandes (rendimiento móvil).
  const video = document.getElementById("videoFondo");
  if (video) {
    const consultaMovil = window.matchMedia("(max-width: 768px)");

    const ajustarVideo = () => {
      if (consultaMovil.matches) {
        video.pause();
        video.removeAttribute("autoplay");
        return;
      }

      video.playbackRate = 0.5;
      video.defaultPlaybackRate = 0.5;
      const reproducir = video.play();
      if (reproducir && typeof reproducir.catch === "function") {
        reproducir.catch(() => {});
      }
    };

    video.addEventListener("loadedmetadata", () => {
      video.playbackRate = 0.5;
    });
    if (typeof consultaMovil.addEventListener === "function") {
      consultaMovil.addEventListener("change", ajustarVideo);
    }
    ajustarVideo();
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
  refrescarContadorEquipos,
  autocompletarEquipo,
  inventario: () => inventarioActual,
  servidor: () => ({ activo: servidorActivo, info: infoServidor }),
};




