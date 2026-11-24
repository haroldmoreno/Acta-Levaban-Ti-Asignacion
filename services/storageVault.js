/* ============================================================
   storageVault.js | Capa de almacenamiento abstraída
   ------------------------------------------------------------
   Hoy escribe en Supabase Storage (buckets privados) y puede
   pasar a Backblaze B2 o Cloudflare R2 (nivel gratuito de 10 GB)
   sin tocar el resto del backend: basta con definir variables de
   entorno y tener instalado @aws-sdk/client-s3.

   Variables opcionales (.env):
     VAULT_PROVIDER=s3                 # supabase (default) | s3
     VAULT_BUCKET=actas-levapan
     VAULT_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
     VAULT_S3_REGION=us-west-004
     VAULT_S3_ACCESS_KEY_ID=...
     VAULT_S3_SECRET_ACCESS_KEY=...
     VAULT_S3_FORCE_PATH_STYLE=true

   La decisión se toma en cada llamada, así que cambiar de
   proveedor no requiere reiniciar la lógica del servidor.
   ============================================================ */

import "dotenv/config";
import crypto from "node:crypto";
import { supabaseAdmin } from "../server/supabase.js";

export const BUCKET_BOVEDA = "boveda-ti";
export const BUCKET_ACTAS = "actas-pdf";

const cacheS3 = { cliente: null, firma: null, modo: null };

/** Lee la configuración activa del almacenamiento. */
export function configAlmacenamiento() {
  const proveedor = String(process.env.VAULT_PROVIDER || "supabase").trim().toLowerCase();
  const esS3 = proveedor === "s3" || proveedor === "b2" || proveedor === "r2";

  return {
    proveedor: esS3 ? "s3" : "supabase",
    bucketBoveda: String(process.env.VAULT_BUCKET || "").trim() || BUCKET_BOVEDA,
    bucketActas: BUCKET_ACTAS,
    endpoint: String(process.env.VAULT_S3_ENDPOINT || "").trim(),
    region: String(process.env.VAULT_S3_REGION || "us-east-1").trim(),
    accessKeyId: String(process.env.VAULT_S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(process.env.VAULT_S3_SECRET_ACCESS_KEY || "").trim(),
    forcePathStyle: String(process.env.VAULT_S3_FORCE_PATH_STYLE || "true") !== "false",
  };
}

/** true cuando el proveedor S3-compatible está completamente configurado. */
export function almacenamientoExternoListo() {
  const cfg = configAlmacenamiento();
  return Boolean(
    cfg.proveedor === "s3" &&
      cfg.endpoint &&
      cfg.accessKeyId &&
      cfg.secretAccessKey
  );
}

/** SHA-256 en hexadecimal: identifica el archivo y evita duplicados. */
export function calcularSha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** Nombre seguro para Storage: sin acentos, espacios ni caracteres raros. */
export function limpiarNombre(nombre) {
  return (
    String(nombre ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "documento"
  );
}

/** Ruta particionada por año/mes/hash, estable y libre de colisiones. */
export function rutaDocumento({ hash, nombre, fecha = new Date() }) {
  const anio = String(fecha.getFullYear());
  const mes = String(fecha.getMonth() + 1).padStart(2, "0");
  const corto = String(hash || "").slice(0, 16) || "sin-hash";
  return `boveda/${anio}/${mes}/${corto}-${limpiarNombre(nombre)}`;
}

async function obtenerClienteS3() {
  if (cacheS3.cliente) return cacheS3.cliente;
  const cfg = configAlmacenamiento();

  if (!almacenamientoExternoListo()) {
    throw Object.assign(
      new Error(
        "El proveedor S3 (B2/R2) está seleccionado pero faltan VAULT_S3_ENDPOINT, " +
          "VAULT_S3_ACCESS_KEY_ID o VAULT_S3_SECRET_ACCESS_KEY en .env."
      ),
      { status: 500 }
    );
  }

  const firma = JSON.stringify([cfg.endpoint, cfg.region, cfg.accessKeyId]);
  if (cacheS3.cliente && cacheS3.firma === firma) return cacheS3.cliente;

  let modulo;
  let presigner;
  try {
    modulo = await import("@aws-sdk/client-s3");
    presigner = await import("@aws-sdk/s3-request-presigner");
  } catch {
    throw Object.assign(
      new Error(
        "Para usar Backblaze B2 o Cloudflare R2 instala las dependencias: " +
          "npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner"
      ),
      { status: 500 }
    );
  }

  cacheS3.cliente = new modulo.S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  cacheS3.firma = firma;
  cacheS3.modo = { modulo, presigner };
  return cacheS3.cliente;
}

/**
 * Sube un objeto y devuelve { proveedor, bucket, ruta }.
 * Si el archivo ya existe no falla: el hash garantiza que es el mismo.
 */
export async function subirObjeto({ buffer, ruta, contentType, bucket }) {
  const cfg = configAlmacenamiento();

  if (cfg.proveedor === "s3") {
    const cliente = await obtenerClienteS3();
    const { PutObjectCommand } = cacheS3.modo.modulo;
    await cliente.send(
      new PutObjectCommand({
        Bucket: bucket || cfg.bucketBoveda,
        Key: ruta,
        Body: buffer,
        ContentType: contentType || "application/octet-stream",
      })
    );
    return { proveedor: "s3", bucket: bucket || cfg.bucketBoveda, ruta };
  }

  const destino = bucket || cfg.bucketBoveda;
  const { error } = await supabaseAdmin.storage.from(destino).upload(ruta, buffer, {
    contentType: contentType || "application/octet-stream",
    cacheControl: "3600",
    upsert: false,
  });

  if (error) {
    const mensaje = String(error.message || "").toLowerCase();
    const yaExiste =
      mensaje.includes("already exists") || mensaje.includes("duplicate") || error.statusCode === "409";
    if (!yaExiste) {
      throw Object.assign(
        new Error(`No se pudo subir el archivo a Supabase Storage: ${error.message}`),
        { status: 502 }
      );
    }
  }

  return { proveedor: "supabase", bucket: destino, ruta };
}

/** URL firmada temporal para ver o descargar el documento. */
export async function firmarObjeto({ bucket, ruta, segundos = 120, descarga }) {
  const cfg = configAlmacenamiento();

  if (cfg.proveedor === "s3") {
    const cliente = await obtenerClienteS3();
    const { GetObjectCommand } = cacheS3.modo.modulo;
    const { getSignedUrl } = cacheS3.modo.presigner;
    const url = await getSignedUrl(
      cliente,
      new GetObjectCommand({
        Bucket: bucket || cfg.bucketBoveda,
        Key: ruta,
        ResponseContentDisposition: descarga
          ? `attachment; filename="${limpiarNombre(descarga)}"`
          : undefined,
      }),
      { expiresIn: Math.min(604800, Math.max(30, Number(segundos) || 120)) }
    );
    return url;
  }

  const { data, error } = await supabaseAdmin.storage
    .from(bucket || cfg.bucketBoveda)
    .createSignedUrl(ruta, Math.min(604800, Math.max(30, Number(segundos) || 120)), {
      download: descarga ? limpiarNombre(descarga) : undefined,
    });

  if (error) {
    throw Object.assign(new Error(`No se pudo firmar el documento: ${error.message}`), {
      status: 502,
    });
  }
  return data.signedUrl;
}

/** Descarga el objeto como Buffer (para reindexar texto o respaldar). */
export async function descargarObjeto({ bucket, ruta }) {
  const cfg = configAlmacenamiento();

  if (cfg.proveedor === "s3") {
    const cliente = await obtenerClienteS3();
    const { GetObjectCommand } = cacheS3.modo.modulo;
    const respuesta = await cliente.send(
      new GetObjectCommand({ Bucket: bucket || cfg.bucketBoveda, Key: ruta })
    );
    const bytes = await respuesta.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  const { data, error } = await supabaseAdmin.storage
    .from(bucket || cfg.bucketBoveda)
    .download(ruta);
  if (error) {
    throw Object.assign(new Error(`No se pudo descargar el documento: ${error.message}`), {
      status: 502,
    });
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Elimina un objeto (solo lo usa el administrador desde el backend). */
export async function eliminarObjeto({ bucket, ruta }) {
  const cfg = configAlmacenamiento();

  if (cfg.proveedor === "s3") {
    const cliente = await obtenerClienteS3();
    const { DeleteObjectCommand } = cacheS3.modo.modulo;
    await cliente.send(
      new DeleteObjectCommand({ Bucket: bucket || cfg.bucketBoveda, Key: ruta })
    );
    return true;
  }

  const { error } = await supabaseAdmin.storage
    .from(bucket || cfg.bucketBoveda)
    .remove([ruta]);
  if (error) {
    throw Object.assign(new Error(`No se pudo eliminar el documento: ${error.message}`), {
      status: 502,
    });
  }
  return true;
}

/** Estado legible para /api/estado y el panel Bóveda. */
export function estadoAlmacenamiento() {
  const cfg = configAlmacenamiento();
  return {
    proveedor: cfg.proveedor,
    bucketActas: cfg.bucketActas,
    bucketBoveda: cfg.bucketBoveda,
    externoListo: almacenamientoExternoListo(),
  };
}
