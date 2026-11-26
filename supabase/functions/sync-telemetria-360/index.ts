// supabase/functions/sync-telemetria-360/index.ts
// Conector seguro SOLO LECTURA: Microsoft Graph (Entra ID + Intune) y HP WXP.
// Las llaves nunca llegan al frontend (Deno.env.get).
// Escribe únicamente en tablas espejo; jamás toca los 27 campos administrativos.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TENANT_ID = Deno.env.get("MS_TENANT_ID") || "";
const CLIENT_ID = Deno.env.get("MS_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET") || "";
const HP_API_URL = Deno.env.get("HP_WXP_API_URL") || "";
const HP_API_KEY = Deno.env.get("HP_WXP_API_KEY") || "";

const GRAPH = "https://graph.microsoft.com/v1.0";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function norm(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

async function graphToken(): Promise<string> {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Faltan MS_TENANT_ID, MS_CLIENT_ID o MS_CLIENT_SECRET");
  }
  const r = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`Graph token: ${JSON.stringify(data).slice(0, 200)}`);
  return data.access_token;
}

/** Sigue @odata.nextLink hasta traer el 100 % de los registros. */
async function graphPaginado(urlInicial: string, headers: Record<string, string>) {
  const items: any[] = [];
  let url: string | undefined = urlInicial;
  let paginas = 0;
  while (url) {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Graph ${r.status}: ${(await r.text()).slice(0, 240)}`);
    const data = await r.json();
    items.push(...(data.value || []));
    paginas += 1;
    url = data["@odata.nextLink"] || undefined;
  }
  return { items, paginas };
}

function extraerSerial(device: any, intune: any[]): string {
  const id = String(device.id || "");
  const upn = String(device.registeredOwners?.[0]?.userPrincipalName || "").toLowerCase();
  const nombre = String(device.displayName || "");

  // 1) Serial exacto de fábrica desde Intune.
  const encontrado =
    intune.find((m) => norm(m.serialNumber) === norm(device.extensionAttributes?.extensionAttribute1)) ||
    intune.find((m) => upn && norm(m.userPrincipalName) === norm(upn)) ||
    intune.find((m) => nombre && norm(m.deviceName) === norm(nombre));
  if (encontrado?.serialNumber) return norm(encontrado.serialNumber);

  // 2) physicalIds con [SerialNumber]:
  const fisicos = device.physicalIds || [];
  for (const valor of fisicos) {
    const texto = String(valor);
    const idx = texto.indexOf("[SerialNumber]:");
    if (idx >= 0) {
      const serial = texto.slice(idx + "[SerialNumber]:".length).trim();
      if (serial) return norm(serial);
    }
  }

  // 3) Exclusivamente nombre en red: clave temporal estable + nombre exacto.
  if (nombre) return `ENTRA-${id}`;
  return `ENTRA-${id}`;
}

async function upsertLotes(sb: ReturnType<typeof createClient>, tabla: string, filas: any[]) {
  let guardados = 0;
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await sb.from(tabla).upsert(filas.slice(i, i + 500), { onConflict: "serial" });
    if (error) throw error;
    guardados += Math.min(500, filas.length - i);
  }
  return guardados;
}

async function sincronizarEntra(sb: ReturnType<typeof createClient>) {
  const token = await graphToken();
  const headers = { Authorization: `Bearer ${token}` };

  const devicesUrl =
    `${GRAPH}/devices?$select=id,displayName,operatingSystem,operatingSystemVersion,` +
    `approximateLastSignInDateTime,isCompliant,accountEnabled,physicalIds&` +
    `$expand=registeredOwners($select=id,displayName,userPrincipalName,accountEnabled)`;
  const usersUrl =
    `${GRAPH}/users?$select=id,displayName,userPrincipalName,accountEnabled,department,jobTitle`;

  const [dispositivos, usuarios] = await Promise.all([
    graphPaginado(devicesUrl, headers),
    graphPaginado(usersUrl, headers),
  ]);

  // Intune: enriquecimiento opcional. Si el permiso no está activo, se omite.
  let managed: any[] = [];
  let intuneDisponible = false;
  try {
    const url =
      `${GRAPH}/deviceManagement/managedDevices?$select=` +
      `serialNumber,deviceName,userPrincipalName,operatingSystem,osVersion,lastSyncDateTime`;
    const respuesta = await graphPaginado(url, headers);
    managed = respuesta.items;
    intuneDisponible = true;
  } catch (err) {
    console.warn("Intune no disponible (permiso ausente):", String(err?.message || err).slice(0, 160));
  }

  const usuariosPorUpn = new Map<string, any>();
  for (const u of usuarios.items) usuariosPorUpn.set(norm(u.userPrincipalName), u);

  const usuariosRetirados = usuarios.items.filter((u) => u.accountEnabled === false).length;
  const filas: any[] = [];
  const syncedAt = new Date().toISOString();

  for (const d of dispositivos.items) {
    const owner = d.registeredOwners?.[0] || {};
    const upn = String(owner.userPrincipalName || "");
    const usuario = usuariosPorUpn.get(norm(upn)) || owner;
    const serial = extraerSerial(d, managed);

    filas.push({
      serial,
      device_id: d.id || null,
      nombre_dispositivo: String(d.displayName || "").trim() || null,
      sistema_operativo: d.operatingSystem || null,
      version_os: d.operatingSystemVersion || null,
      upn_usuario: upn || null,
      nombre_usuario_entra: usuario.displayName || null,
      usuario_activo_m365:
        typeof usuario.accountEnabled === "boolean" ? usuario.accountEnabled : null,
      ultima_actividad: d.approximateLastSignInDateTime || null,
      cumplimiento: d.isCompliant == null ? null : d.isCompliant ? "Compliant" : "No compliant",
      synced_at: syncedAt,
    });
  }

  const sincronizados = await upsertLotes(sb, "sync_entra_dispositivos", filas);

  return {
    total_entra_leidos: dispositivos.items.length,
    total_sincronizados: sincronizados,
    usuarios_retirados_detectados: usuariosRetirados,
    paginas_dispositivos: dispositivos.paginas,
    paginas_usuarios: usuarios.paginas,
    intune_disponible: intuneDisponible,
    intune_registros: managed.length,
    total_usuarios_leidos: usuarios.items.length,
  };
}

async function sincronizarHp(sb: ReturnType<typeof createClient>) {
  if (!HP_API_URL || !HP_API_KEY) return { omitido: true, motivo: "HP_WXP_API_KEY no configurada" };
  const r = await fetch(`${HP_API_URL.replace(/\/$/, "")}/devices`, {
    headers: { Authorization: `Bearer ${HP_API_KEY}` },
  });
  if (!r.ok) return { omitido: true, motivo: `HP WXP respondió ${r.status}` };
  const data = await r.json();
  const dispositivos = data.devices || data.value || [];
  const filas = dispositivos.map((d: any) => ({
    serial: norm(d.serial || d.serialNumber),
    device_name: d.deviceName || d.name || null,
    modelo_hp: d.model || d.productName || null,
    bios_version: d.biosVersion || null,
    salud_bateria_pct: d.batteryHealth ?? d.battery?.health ?? null,
    estado_disco: d.diskStatus || d.storageHealth || null,
    estado_conexion: d.connectionStatus || null,
    ultimo_usuario_hp: d.lastUser || d.user || null,
    ultima_conexion_hp: d.lastConnected || d.lastCheckIn || null,
    synced_at: new Date().toISOString(),
  }));
  return { total_leidos: filas.length, total_sincronizados: await upsertLotes(sb, "sync_hp_wxp", filas) };
}

Deno.serve(async () => {
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const entra = await sincronizarEntra(sb);
    const hp = await sincronizarHp(sb);
    return json({
      ok: true,
      ...entra,
      hp,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});
