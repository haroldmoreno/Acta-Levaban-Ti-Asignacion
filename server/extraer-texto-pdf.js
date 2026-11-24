/* ============================================================
   extraer-texto-pdf.js | Extracción de texto sin dependencias
   ------------------------------------------------------------
   Abre los streams del PDF (FlateDecode incluido) y recupera los
   literales de los operadores Tj / TJ / ' / ". Con ese texto se
   alimenta el índice Full-Text (tsvector) de boveda_documentos.

   No es un intérprete completo de PDF: cubre los documentos
   generados por Word, Excel, SAP, escáneres y pdf-lib, que son
   el 95 % de los contratos y facturas de la compañía.
   ============================================================ */

import zlib from "node:zlib";

const MAX_TEXTO = 200_000;
const MAX_STREAM = 12 * 1024 * 1024;

function desescaparLiteral(texto) {
  return texto.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, grupo) => {
    switch (grupo) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "(":
        return "(";
      case ")":
        return ")";
      case "\\":
        return "\\";
      default:
        return /^[0-7]+$/.test(grupo) ? String.fromCharCode(parseInt(grupo, 8)) : grupo;
    }
  });
}

function desescaparHex(hex) {
  const limpio = hex.replace(/[^0-9a-fA-F]/g, "");
  const pares = limpio.match(/.{1,2}/g) || [];
  let salida = "";
  for (const par of pares) {
    const codigo = parseInt(par.padEnd(2, "0"), 16);
    // Descarta controles y el rango de bytes nulos típico de fuentes CID.
    if (codigo >= 32 || codigo === 10) salida += String.fromCharCode(codigo);
  }
  return salida;
}

/** Extrae texto legible de un bloque de contenido PDF ya descomprimido. */
function textoDeContenido(contenido) {
  const piezas = [];

  // (texto) Tj  ·  (texto) '  ·  (texto) "
  const literales = /\((?:\\.|[^\\()])*\)\s*(?:Tj|'|")/g;
  let coincidencia;
  while ((coincidencia = literales.exec(contenido))) {
    const literal = coincidencia[0].replace(/\s*(?:Tj|'|")\s*$/, "");
    piezas.push(desescaparLiteral(literal.slice(1, -1)));
  }

  // [(A) -120 (B)] TJ
  const arreglos = /\[((?:\\.|[^\]])*)\]\s*TJ/g;
  while ((coincidencia = arreglos.exec(contenido))) {
    const internos = coincidencia[1].match(/\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>/g) || [];
    for (const interno of internos) {
      if (interno.startsWith("<")) piezas.push(desescaparHex(interno.slice(1, -1)));
      else piezas.push(desescaparLiteral(interno.slice(1, -1)));
    }
  }

  // <00480065> Tj (fuentes CID / UTF-16BE)
  const hexadecimales = /<([0-9A-Fa-f\s]{4,})>\s*Tj/g;
  while ((coincidencia = hexadecimales.exec(contenido))) {
    const hex = coincidencia[1].replace(/\s+/g, "");
    let texto = "";
    for (let i = 0; i + 3 < hex.length; i += 4) {
      const codigo = parseInt(hex.slice(i, i + 4), 16);
      if (codigo >= 32 && codigo !== 0xffff) texto += String.fromCharCode(codigo);
    }
    if (texto) piezas.push(texto);
  }

  return piezas.join(" ");
}

function intentarDescomprimir(bytes) {
  const intentos = [
    () => zlib.inflateSync(bytes),
    () => zlib.inflateRawSync(bytes),
    () => zlib.unzipSync(bytes),
  ];
  for (const intento of intentos) {
    try {
      return intento();
    } catch {
      /* siguiente estrategia */
    }
  }
  return null;
}

/**
 * Devuelve el texto del PDF (cadena vacía si no es un PDF de texto).
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extraerTextoPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return "";
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return "";

  const crudo = buffer.toString("latin1");
  const piezas = [];
  let cursor = 0;

  while (piezas.join(" ").length < MAX_TEXTO) {
    const inicio = crudo.indexOf("stream", cursor);
    if (inicio === -1) break;

    let desde = inicio + "stream".length;
    if (crudo[desde] === "\r") desde += 1;
    if (crudo[desde] === "\n") desde += 1;

    const fin = crudo.indexOf("endstream", desde);
    if (fin === -1) break;
    cursor = fin + "endstream".length;

    if (fin - desde <= 0 || fin - desde > MAX_STREAM) continue;

    const bytes = buffer.subarray(desde, fin);
    const descomprimido = intentarDescomprimir(bytes);
    if (descomprimido) {
      piezas.push(textoDeContenido(descomprimido.toString("latin1")));
    } else {
      const posibleTexto = bytes.toString("latin1");
      // Solo se acepta el stream crudo si contiene operadores de texto.
      if (/(?:Tj|TJ)\b/.test(posibleTexto)) {
        piezas.push(textoDeContenido(posibleTexto));
      }
    }
  }

  const texto = piezas
    .join(" ")
    .replace(/\u0000/g, " ")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

  return texto.length >= 20 ? texto.slice(0, MAX_TEXTO) : "";
}

export default extraerTextoPdf;
