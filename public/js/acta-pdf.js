/* ============================================================
   acta-pdf.js | Acta oficial CORP-TEC-FR-002 (2 páginas)
   ------------------------------------------------------------
   Versión navegador: abre public/template.pdf y rellena sus
   AcroForm sin añadir ni recortar páginas. Conserva encabezado,
   tablas, matrices SI/NO, registro fotográfico, texto legal y
   doble firma del formato oficial.
   ============================================================ */

(function () {
  "use strict";

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
  const PDFLIB = window.PDFLib;
  const COLOR_CELDA_PDF = PDFLIB.rgb(241 / 255, 242 / 255, 241 / 255);

  const CARACTERES_NO_WINANSI =
    /[^\t\n\r\u0020-\u007E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g;

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

  function comparar(texto) {
    return String(texto ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function estaMarcado(lista, etiqueta) {
    const objetivo = comparar(etiqueta);
    return (lista || []).some((valor) => {
      const actual = comparar(valor);
      return actual === objetivo || actual.startsWith(`${objetivo}:`);
    });
  }

  function textoOtro(lista) {
    const valor = (lista || []).find((item) => comparar(item).startsWith("otro"));
    return valor ? String(valor).replace(/^otro\s*:?\s*/i, "").trim() : "";
  }

  function formatearFecha(fecha) {
    const valor = fecha ? new Date(fecha) : new Date();
    const fechaValida = Number.isNaN(valor.getTime()) ? new Date() : valor;
    return `${String(fechaValida.getDate()).padStart(2, "0")}/${String(
      fechaValida.getMonth() + 1
    ).padStart(2, "0")}/${fechaValida.getFullYear()}`;
  }

  function obtenerWidgets(form, paginas, nombre) {
    try {
      const campo = form.getField(nombre);
      return campo.acroField.getWidgets().flatMap((widget) => {
        const indicePagina = paginas.findIndex((pagina) => pagina.ref === widget.P());
        if (indicePagina < 0) return [];
        return [{ pagina: paginas[indicePagina], rect: widget.getRectangle() }];
      });
    } catch (err) {
      console.warn(`[ACTA PDF] Campo "${nombre}" no encontrado:`, err.message);
      return [];
    }
  }

  function ajustarTamano(texto, fuente, tamanoInicial, ancho, tamanoMinimo = 5) {
    let tamano = tamanoInicial;
    while (
      tamano > tamanoMinimo &&
      fuente.widthOfTextAtSize(texto, tamano) > Math.max(1, ancho)
    ) {
      tamano -= 0.25;
    }
    return tamano;
  }

  function escribirCampo(form, paginas, fuente, nombre, valor, opciones = {}) {
    const { tamano = 9, minimo = 5 } = opciones;
    const texto = limpiarTextoPdf(valor ?? "");
    if (!texto) return;
    try {
      const campo = form.getTextField(nombre);
      const widgets = obtenerWidgets(form, paginas, nombre);
      const anchoMinimo = widgets.length
        ? Math.min(...widgets.map(({ rect }) => rect.width)) - 4
        : 100;
      campo.setText(texto);
      campo.setFontSize(ajustarTamano(texto, fuente, tamano, anchoMinimo, minimo));
    } catch (err) {
      console.warn(`[ACTA PDF] No se pudo escribir "${nombre}":`, err.message);
    }
  }

  function envolverTexto(texto, fuente, tamano, anchoMaximo) {
    const lineas = [];
    for (const parrafo of String(texto ?? "").split(/\r?\n/)) {
      const palabras = limpiarTextoPdf(parrafo).split(/\s+/).filter(Boolean);
      if (!palabras.length) {
        lineas.push("");
        continue;
      }
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
    }
    return lineas;
  }

  function escribirObservaciones(form, paginas, fuente, texto) {
    const limpio = limpiarTextoPdf(texto ?? "");
    if (!limpio) return;
    try {
      const campo = form.getTextField("observaciones");
      const widgets = obtenerWidgets(form, paginas, "observaciones");
      if (!widgets.length) return;
      const { rect } = widgets[0];
      const tamano = 8.5;
      const lineas = envolverTexto(limpio, fuente, tamano, rect.width - 8);
      const maximoLineas = Math.max(1, Math.floor((rect.height - 8) / (tamano * 1.2)));
      if (lineas.length > maximoLineas) {
        lineas.length = maximoLineas;
        lineas[maximoLineas - 1] = `${lineas[maximoLineas - 1]
          .replace(/\s+\S*$/, "")
          .trim()}...`;
      }
      campo.setText(lineas.join("\n"));
      campo.setFontSize(tamano);
      campo.enableMultiline();
    } catch (err) {
      console.warn("[ACTA PDF] No se pudieron escribir observaciones:", err.message);
    }
  }

  function taparGuia(paginas, form, nombre) {
    const widgets = obtenerWidgets(form, paginas, nombre);
    const { pagina, rect } = widgets[0] || {};
    if (!pagina || !rect) return;
    pagina.drawRectangle({
      x: rect.x + 20,
      y: rect.y + 2,
      width: Math.max(0, rect.width - 22),
      height: Math.max(0, rect.height - 4),
      color: COLOR_CELDA_PDF,
    });
  }

  function decodificarImagen(valor) {
    const texto = String(valor ?? "").trim();
    if (!texto) return null;
    const coincidencia = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(texto);
    const mime = coincidencia ? coincidencia[1].toLowerCase() : "";
    const base64 = coincidencia ? coincidencia[2] : texto.replace(/\s+/g, "");
    try {
      const binario = atob(base64);
      const bytes = new Uint8Array(binario.length);
      for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
      if (!bytes.length) return null;
      const esPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const esJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (/jpe?g/.test(mime) || esJpg) return { tipo: "jpg", bytes };
      if (/png/.test(mime) || esPng) return { tipo: "png", bytes };
    } catch (err) {
      console.warn("[ACTA PDF] Imagen no válida:", err.message);
    }
    return null;
  }

  async function incrustarImagen(pdfDoc, form, nombre, valor) {
    const imagen = decodificarImagen(valor);
    if (!imagen) return;
    try {
      const embebida =
        imagen.tipo === "png"
          ? await pdfDoc.embedPng(imagen.bytes)
          : await pdfDoc.embedJpg(imagen.bytes);
      form.getButton(nombre).setImage(embebida, PDFLIB.ImageAlignment.Center);
    } catch (err) {
      console.warn(`[ACTA PDF] No se pudo incrustar "${nombre}":`, err.message);
    }
  }

  function dibujarX(pagina, rect) {
    if (!pagina || !rect) return;
    pagina.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: PDFLIB.rgb(1, 1, 1),
      borderColor: PDFLIB.rgb(0.1, 0.1, 0.1),
      borderWidth: 1.1,
    });
    const lado = Math.max(5, Math.min(rect.width, rect.height) - 6);
    const x = rect.x + (rect.width - lado) / 2;
    const y = rect.y + (rect.height - lado) / 2;
    const color = PDFLIB.rgb(0.08, 0.08, 0.08);
    pagina.drawLine({ start: { x, y }, end: { x: x + lado, y: y + lado }, thickness: 1.3, color });
    pagina.drawLine({ start: { x, y: y + lado }, end: { x: x + lado, y }, thickness: 1.3, color });
  }

  async function generarActaPdf({ datos = {}, fotos = {}, firmas = {} } = {}) {
    const respuesta = await fetch("template.pdf", { cache: "no-store" });
    if (!respuesta.ok) throw new Error("No se pudo cargar template.pdf");
    const plantillaBytes = new Uint8Array(await respuesta.arrayBuffer());

    const pdfDoc = await PDFLIB.PDFDocument.load(plantillaBytes, { ignoreEncryption: true });
    const paginas = pdfDoc.getPages();
    const form = pdfDoc.getForm();
    const fuente = await pdfDoc.embedFont(PDFLIB.StandardFonts.Helvetica);

    /* Página 1 */
    escribirCampo(form, paginas, fuente, "name", datos.nombre, { tamano: 10 });
    escribirCampo(form, paginas, fuente, "ID", datos.documento, { tamano: 10 });
    escribirCampo(form, paginas, fuente, "tipoEquipo", datos.tipo);
    escribirCampo(form, paginas, fuente, "marcaEquipo", datos.marca);
    escribirCampo(form, paginas, fuente, "modeloEquipo", datos.modelo);
    escribirCampo(form, paginas, fuente, "serial", datos.serial);
    escribirCampo(form, paginas, fuente, "placa", datos.placa);
    escribirObservaciones(form, paginas, fuente, datos.observaciones);

    /* Página 2 */
    const sede = datos.sede ?? "";
    escribirCampo(form, paginas, fuente, "ciudad", sede, { tamano: 9 });
    let existeCiudad = true;
    try {
      form.getField("ciudad");
    } catch {
      existeCiudad = false;
    }
    if (!existeCiudad) escribirCampo(form, paginas, fuente, "sede", sede, { tamano: 9 });
    escribirCampo(form, paginas, fuente, "fecha", ` ${formatearFecha(datos.fecha)}`, { tamano: 9 });
    escribirCampo(form, paginas, fuente, "nameTi", datos.agenteTi, { tamano: 9 });
    escribirCampo(form, paginas, fuente, "IDTI", datos.documentoTi, { tamano: 9 });

    const accesorios = Array.isArray(datos.accesorios) ? datos.accesorios : [];
    const software = Array.isArray(datos.software) ? datos.software : [];

    const extrasAccesorios = accesorios
      .filter((valor) => {
        const texto = comparar(valor);
        if (!texto || texto === "base") return false;
        if (texto === "adaptador") return false;
        if (texto.startsWith("otro")) return true;
        return !ACCESORIOS_PDF.some(([etiqueta]) => comparar(etiqueta) === texto);
      })
      .map((valor) => String(valor).replace(/^otro\s*:?\s*/i, "").trim())
      .filter(Boolean);

    CAMPOS_OTRO_ACCESORIOS.forEach((campo, indice) => {
      const valor = extrasAccesorios[indice];
      if (!valor) return;
      escribirCampo(form, paginas, fuente, campo, valor, { tamano: 7, minimo: 5 });
      taparGuia(paginas, form, campo);
    });

    const otroSoftware = textoOtro(software);
    if (otroSoftware) {
      escribirCampo(form, paginas, fuente, "Texto77", otroSoftware, { tamano: 7, minimo: 5 });
      taparGuia(paginas, form, "Texto77");
    }

    for (const [campo, valor] of [
      ["signature", fotos.encendido],
      ["signature2", fotos.frontal],
      ["signature3", fotos.posterior],
      ["firmaUsuario", firmas.colaborador],
      ["firmaTecnico", firmas.agente],
    ]) {
      await incrustarImagen(pdfDoc, form, campo, valor);
    }

    const marcar = (nombre, activo) => {
      try {
        const casilla = form.getCheckBox(nombre);
        if (!activo) {
          casilla.uncheck();
          return;
        }
        const [destino] = obtenerWidgets(form, paginas, nombre);
        if (!destino) return;
        dibujarX(destino.pagina, destino.rect);
        casilla.acroField.getWidgets().forEach((widget) => {
          const ref = pdfDoc.context.getObjectRef(widget.dict);
          const pagina = paginas.find((item) => item.ref === widget.P());
          if (ref && pagina) pagina.node.removeAnnot(ref);
        });
        try {
          form.removeField(casilla);
        } catch (err) {
          console.warn(`[ACTA PDF] No se pudo quitar "${nombre}":`, err.message);
        }
      } catch (err) {
        console.warn(`[ACTA PDF] No se pudo marcar "${nombre}":`, err.message);
      }
    };

    marcar("cc", true);
    marcar("ti", false);
    const esDevolucion = comparar(datos.tipoActa) === "devolucion";
    marcar("asignacion", !esDevolucion);
    marcar("devolucion", esDevolucion);

    const tieneBase = accesorios.some((valor) => comparar(valor) === "base");
    for (const [etiqueta, si, no] of ACCESORIOS_PDF) {
      let activo = estaMarcado(accesorios, etiqueta);
      if (etiqueta === "Base Soporte" && tieneBase) activo = true;
      if (etiqueta === "Cargador") activo = activo || estaMarcado(accesorios, "Adaptador");
      marcar(si, activo);
      marcar(no, !activo);
    }
    for (const [etiqueta, si, no] of SOFTWARE_PDF) {
      const activo = estaMarcado(software, etiqueta);
      marcar(si, activo);
      marcar(no, !activo);
    }

    form.getFields().forEach((campo) => {
      try {
        campo.enableReadOnly();
      } catch {
        /* algunos campos no admiten solo lectura */
      }
    });

    return pdfDoc.save();
  }

  window.ActaPdfLevapan = { generarActaPdf, ACCESORIOS_PDF, SOFTWARE_PDF };
})();
