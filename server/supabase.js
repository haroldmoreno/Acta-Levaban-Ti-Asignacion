/* ============================================================
   supabase.js | Cliente administrador de Supabase
   ------------------------------------------------------------
   Única puerta de entrada a PostgreSQL, Auth y Storage.
   La SERVICE_ROLE_KEY solo se usa en el servidor (nunca en el
   navegador). Todas las variables se leen de .env / entorno.
   ============================================================ */

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

export const BUCKET_ACTAS = "actas-pdf";

/** Devuelve las variables de Supabase y la lista de las que faltan. */
export function configSupabase() {
  const url = String(process.env.SUPABASE_URL || "").trim();
  const anonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();
  const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  const faltantes = [];
  if (!url) faltantes.push("SUPABASE_URL");
  if (!anonKey) faltantes.push("SUPABASE_ANON_KEY");
  if (!serviceKey) faltantes.push("SUPABASE_SERVICE_ROLE_KEY");

  return {
    url,
    anonKey,
    serviceKey,
    faltantes,
    configurado: faltantes.length === 0,
  };
}

/** Mensaje uniforme y claro cuando falta configuración. */
export function mensajeConfiguracionIncompleta(config = configSupabase()) {
  return (
    "Supabase no está configurado. Faltan las variables de entorno: " +
    `${config.faltantes.join(", ")}. ` +
    "Copia .env.example como .env (o define las variables en Render → Environment) " +
    "y reinicia el servidor."
  );
}

const config = configSupabase();

if (!config.configurado) {
  console.error("\n" + "=".repeat(64));
  console.error("  ERROR DE CONFIGURACIÓN · ACTA DE TECNOLOGÍA LEVAPAN");
  console.error("=".repeat(64));
  console.error("  " + mensajeConfiguracionIncompleta(config));
  console.error("=".repeat(64) + "\n");
}

/**
 * Cliente con SERVICE_ROLE_KEY: sortea RLS y es el único que debe
 * escribir en equipos/actas/historial y en el bucket privado.
 * Se crea aunque falte configuración para que el mensaje de error sea
 * visible desde el primer arranque; las llamadas devolverán error.
 */
export const supabaseAdmin = createClient(
  config.url || "https://ejemplo.supabase.co",
  config.serviceKey || "service-role-key-no-configurada",
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { headers: { "x-application-name": "acta-levapan" } },
  }
);

/** Comprobación real contra PostgreSQL (la usa /api/health y /api/estado). */
export async function contarEquipos() {
  const { count, error, status } = await supabaseAdmin
    .from("equipos")
    .select("id", { count: "exact", head: true });

  if (error) {
    // Supabase devuelve message vacío en errores 401 (JWT inválido). Se
    // incluye el código/estado para que el diagnóstico nunca quede en blanco.
    const httpStatus = status ?? error.status ?? null;
    const motivo =
      [error.message, error.code && `código ${error.code}`].filter(Boolean).join(" · ") ||
      `HTTP ${httpStatus ?? "desconocido"}`;
    throw Object.assign(new Error(`Supabase/PostgreSQL: ${motivo}`), {
      status: 502,
      codigo: error.code,
      httpStatus,
    });
  }
  return Number(count) || 0;
}

/** Verificación rápida de conexión. */
export async function verificarConexionSupabase() {
  const totalEquipos = await contarEquipos();
  return { ok: true, modo: "cloud-supabase", totalEquipos };
}

/**
 * Valida un JWT de Supabase Auth y devuelve el perfil TI activo.
 * Lanza un error con `status` 401/403 para responder desde el middleware.
 */
export async function autenticarToken(token) {
  const bearer = String(token || "").trim();
  if (!bearer) {
    throw Object.assign(new Error("Falta el token de acceso (Bearer)."), {
      status: 401,
    });
  }

  const { data, error } = await supabaseAdmin.auth.getUser(bearer);
  if (error || !data?.user) {
    throw Object.assign(
      new Error(
        `Sesión no válida o expirada: ${error?.message || "usuario no encontrado"}`
      ),
      { status: 401 }
    );
  }

  const user = data.user;
  const { data: perfil, error: errorPerfil } = await supabaseAdmin
    .from("perfiles_ti")
    .select("id, nombre_completo, cedula, email, rol, activo")
    .eq("id", user.id)
    .maybeSingle();

  if (errorPerfil) {
    throw Object.assign(
      new Error(`No se pudo leer el perfil TI: ${errorPerfil.message}`),
      { status: 502 }
    );
  }

  if (!perfil) {
    throw Object.assign(
      new Error(
        "Tu correo está autenticado pero no está registrado en perfiles_ti. " +
          "Pide al administrador que te dé de alta con tu UUID de auth.users."
      ),
      { status: 403 }
    );
  }

  if (!perfil.activo) {
    throw Object.assign(
      new Error("Tu cuenta TI está inactiva. Solicita la reactivación al administrador."),
      { status: 403 }
    );
  }

  return {
    id: perfil.id,
    auth_id: user.id,
    email: perfil.email || user.email || "",
    nombre_completo: perfil.nombre_completo,
    cedula: perfil.cedula,
    rol: perfil.rol,
  };
}
