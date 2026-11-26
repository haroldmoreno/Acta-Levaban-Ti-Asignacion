// supabase/functions/sync-telemetria-360/index.ts
// Conector seguro SOLO LECTURA: Microsoft Graph + HP WXP.
// Las llaves nunca llegan al frontend (Deno.env.get).
// Escribe en tablas espejo; jamás toca los 27 campos de public.equipos.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TENANT_ID = Deno.env.get("MS_TENANT_ID") || "";
const CLIENT_ID = Deno.env.get("MS_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("MS_CLIENT_SECRET") || "";
const HP_API_URL = Deno.env.get("HP_WXP_API_URL") || "";
const HP_API_KEY = Deno.env.get("HP_WXP_API_KEY") || "";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

async function graphToken(): Promise<string> {
  if (!TENANT_ID || !CLIENT_ID || !CLIENT_SECRET) throw new Error("Faltan secretos de Microsoft Graph");
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

async function syncEntra(sb: ReturnType<typeof createClient>) {
  const token = await graphToken();
  const headers = { Authorization: `Bearer ${token}` };

  const devicesRes = await fetch("https://graph.microsoft.com/v1.0/devices?$top=500", { headers });
  const devices = (await devicesRes.json()).value || [];

  const rows = [];
  for (const d of devices) {
    const serial = norm(d.extensionAttributes?.extensionAttribute1 || d.deviceId);
    let upn = "";
    try {
      const r = await fetch(`https://graph.microsoft.com/v1.0/devices/${d.id}/registeredOwners?$top=1`, { headers });
      const owners = (await r.json()).value || [];
      upn = owners[0]?.userPrincipalName || owners[0]?.mail || "";
    } catch { /* sin propietario */ }

    let usuarioActivo: boolean | null = null;
    let nombreUsuario = "";
    if (upn) {
      try {
        const r = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}?$select=displayName,accountEnabled`,
          { headers }
        );
        const u = await r.json();
        usuarioActivo = typeof u.accountEnabled === "boolean" ? u.accountEnabled : null;
        nombreUsuario = u.displayName || "";
      } catch { /* usuario no disponible */ }
    }

    rows.push({
      serial,
      device_id: d.id || null,
      nombre_dispositivo: d.displayName || null,
      sistema_operativo: d.operatingSystem || null,
      version_os: d.operatingSystemVersion || null,
      upn_usuario: upn || null,
      nombre_usuario_entra: nombreUsuario || null,
      usuario_activo_m365: usuarioActivo,
      ultima_actividad: d.approximateLastSignInDateTime || null,
      cumplimiento: d.isCompliant == null ? null : d.isCompliant ? "Compliant" : "No compliant",
      synced_at: new Date().toISOString(),
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb
      .from("sync_entra_dispositivos")
      .upsert(rows.slice(i, i + 200), { onConflict: "serial" });
    if (error) throw error;
  }
  return rows.length;
}

async function syncHp(sb: ReturnType<typeof createClient>) {
  if (!HP_API_URL || !HP_API_KEY) return 0;
  const r = await fetch(`${HP_API_URL}/devices`, { headers: { Authorization: `Bearer ${HP_API_KEY}` } });
  const data = await r.json();
  const dispositivos = data.devices || data.value || [];

  const rows = dispositivos.map((d: any) => ({
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

  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb
      .from("sync_hp_wxp")
      .upsert(rows.slice(i, i + 200), { onConflict: "serial" });
    if (error) throw error;
  }
  return rows.length;
}

Deno.serve(async () => {
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const entra = await syncEntra(sb);
    const hp = await syncHp(sb);
    return json({ ok: true, entra, hp, syncedAt: new Date().toISOString() });
  } catch (err) {
    return json({ ok: false, error: String(err?.message || err) }, 500);
  }
});
