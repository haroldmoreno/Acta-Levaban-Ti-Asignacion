/* ============================================================
   sync-entra.mjs | Sincronización automática Microsoft Entra ID
   ------------------------------------------------------------
   Se ejecuta al arrancar y cada 6 horas desde el servicio
   `sync-cron` de docker-compose. Sin secretos en el código:
   todo se lee de las variables de entorno de docker/.env.
   ============================================================ */

import process from "node:process";

const TENANT_ID = String(process.env.MS_TENANT_ID || "").trim();
const CLIENT_ID = String(process.env.MS_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.MS_CLIENT_SECRET || "").trim();
const API_URL = String(process.env.API_URL || process.env.SUPABASE_URL || "http://kong:8000")
  .replace(/\/$/, "");
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_KEY || "").trim();
const LOTE = 500;

function normalizar(texto) {
  return String(texto ?? "").trim().toUpperCase();
}

async function tokenGraph() {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Faltan MS_TENANT_ID, MS_CLIENT_ID o MS_CLIENT_SECRET en docker/.env");
  }
  const cuerpo = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const respuesta = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(TENANT_ID)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: cuerpo,
    }
  );
  if (!respuesta.ok) {
    throw new Error(`Graph token ${respuesta.status}: ${await respuesta.text()}`);
  }
  const datos = await respuesta.json();
  if (!datos.access_token) throw new Error("Graph no devolvió access_token");
  return datos.access_token;
}

async function graphPaginado(ruta, token) {
  const resultados = [];
  let url = ruta.startsWith("http") ? ruta : `https://graph.microsoft.com/v1.0${ruta}`;
  while (url) {
    const respuesta = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!respuesta.ok) {
      throw new Error(`Graph ${respuesta.status} en ${url}: ${await respuesta.text()}`);
    }
    const datos = await respuesta.json();
    resultados.push(...(datos.value || []));
    url = datos["@odata.nextLink"] || "";
  }
  return resultados;
}

async function upsert(tabla, registros) {
  if (!SERVICE_KEY) throw new Error("Falta SUPABASE_SERVICE_KEY en docker/.env");
  for (let i = 0; i < registros.length; i += LOTE) {
    const lote = registros.slice(i, i + LOTE);
    const respuesta = await fetch(`${API_URL}/rest/v1/${tabla}`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(lote),
    });
    if (!respuesta.ok) {
      throw new Error(`UPSERT ${tabla} ${respuesta.status}: ${await respuesta.text()}`);
    }
  }
}

async function sincronizar() {
  const inicio = new Date().toISOString();
  console.log(`[sync-entra] Inicio ${inicio}`);

  const token = await tokenGraph();
  const [dispositivos, usuarios] = await Promise.all([
    graphPaginado(
      "/devices?$select=id,deviceId,displayName,operatingSystem,osVersion,registrationDateTime,lastActivityDateTime,complianceState,registeredOwners&$top=500",
      token
    ),
    graphPaginado(
      "/users?$select=id,displayName,userPrincipalName,accountEnabled,lastSignInDateTime&$top=500",
      token
    ),
  ]);

  const usuariosPorId = new Map(usuarios.map((u) => [u.id, u]));
  const ahora = new Date().toISOString();
  const registros = dispositivos.map((d) => {
    const ownerId = d.registeredOwners?.[0]?.id || "";
    const usuario = usuariosPorId.get(ownerId) || {};
    return {
      serial: normalizar(d.deviceId || d.id),
      device_id: d.id || null,
      nombre_dispositivo: d.displayName || null,
      sistema_operativo: d.operatingSystem || null,
      version_os: d.osVersion || null,
      upn_usuario: usuario.userPrincipalName || null,
      nombre_usuario_entra: usuario.displayName || null,
      usuario_activo_m365: usuario.accountEnabled ?? null,
      ultima_actividad: d.lastActivityDateTime || usuario.lastSignInDateTime || null,
      cumplimiento: d.complianceState || null,
      synced_at: ahora,
    };
  }).filter((r) => r.serial);

  await upsert("sync_entra_dispositivos", registros);
  console.log(
    `[sync-entra] OK · ${registros.length} dispositivos y ${usuarios.length} usuarios de Entra ID sincronizados en ${API_URL}/rest/v1/sync_entra_dispositivos`
  );
}

try {
  await sincronizar();
} catch (error) {
  console.error("[sync-entra] ERROR:", error.message);
  process.exitCode = 1;
}
