/* ============================================================
   reparar-accesos.mjs | Restaura credenciales corporativas
   ------------------------------------------------------------
   Uso: node scripts/reparar-accesos.mjs
   Crea/actualiza usuarios en Supabase Auth y sus perfiles TI.
   ============================================================ */

import "dotenv/config";

const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const service = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const anon = String(process.env.SUPABASE_ANON_KEY || "").trim();
const base = "http://localhost:3000";

if (!url || !service || !anon) {
  throw new Error("Faltan SUPABASE_URL, SUPABASE_ANON_KEY o SUPABASE_SERVICE_ROLE_KEY en .env");
}

const headersAdmin = {
  apikey: service,
  Authorization: `Bearer ${service}`,
  "Content-Type": "application/json",
};
const headersDb = {
  apikey: service,
  Authorization: `Bearer ${service}`,
  Accept: "application/json",
  "Content-Type": "application/json",
};

const cuentas = [
  {
    email: "admin@levapan.com",
    password: "Macos.2025",
    nombre_completo: "Harold Adrián Hurtado Moreno",
    cedula: "1087778841",
    rol: "admin",
  },
  {
    email: "tecnico@levapan.com",
    password: "Tecnico.2025",
    nombre_completo: "Técnico TI Levapan",
    cedula: "900001",
    rol: "tecnico",
  },
  {
    email: "harold.hurtado@levapan.com",
    password: "Tecnico.2025",
    nombre_completo: "Harold Hurtado",
    cedula: "900002",
    rol: "tecnico",
  },
  {
    email: "harold.hutado@levapan.com",
    password: "Tecnico.2025",
    nombre_completo: "Harold Hurtado",
    cedula: "900003",
    rol: "tecnico",
  },
];

async function listarUsuarios() {
  const r = await fetch(`${url}/auth/v1/admin/users?per_page=1000`, { headers: headersAdmin });
  const datos = await r.json();
  if (!r.ok) throw new Error(`No se pudo listar usuarios: ${JSON.stringify(datos).slice(0, 200)}`);
  return datos.users || [];
}

async function ensureUsuario(cuenta, usuarios) {
  const existente = usuarios.find(
    (u) => String(u.email || "").toLowerCase() === cuenta.email.toLowerCase()
  );
  const metadata = {
    nombre_completo: cuenta.nombre_completo,
    cedula: cuenta.cedula,
  };

  let id;
  if (existente) {
    const r = await fetch(`${url}/auth/v1/admin/users/${existente.id}`, {
      method: "PUT",
      headers: headersAdmin,
      body: JSON.stringify({
        password: cuenta.password,
        email_confirm: true,
        user_metadata: metadata,
      }),
    });
    const datos = await r.json();
    if (!r.ok) throw new Error(`No se pudo actualizar ${cuenta.email}: ${JSON.stringify(datos).slice(0, 180)}`);
    id = existente.id;
  } else {
    const r = await fetch(`${url}/auth/v1/admin/users`, {
      method: "POST",
      headers: headersAdmin,
      body: JSON.stringify({
        email: cuenta.email,
        password: cuenta.password,
        email_confirm: true,
        user_metadata: metadata,
      }),
    });
    const datos = await r.json();
    if (!r.ok) throw new Error(`No se pudo crear ${cuenta.email}: ${JSON.stringify(datos).slice(0, 180)}`);
    id = datos.user?.id || datos.id;
  }

  const perfil = await fetch(`${url}/rest/v1/perfiles_ti?on_conflict=id`, {
    method: "POST",
    headers: { ...headersDb, Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([
      {
        id,
        nombre_completo: cuenta.nombre_completo,
        cedula: cuenta.cedula,
        email: cuenta.email,
        rol: cuenta.rol,
        activo: true,
      },
    ]),
  });
  const perfilDatos = await perfil.json();
  if (!perfil.ok) {
    throw new Error(`No se pudo crear el perfil de ${cuenta.email}: ${JSON.stringify(perfilDatos).slice(0, 180)}`);
  }

  return id;
}

async function verificar(cuenta) {
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anon, "Content-Type": "application/json" },
    body: JSON.stringify({ email: cuenta.email, password: cuenta.password }),
  });
  const datos = await r.json();
  if (!datos.access_token) {
    console.error(`  [FALLO] ${cuenta.email}: ${JSON.stringify(datos).slice(0, 160)}`);
    return false;
  }

  const perfil = await fetch(`${base}/api/perfil`, {
    headers: { Authorization: `Bearer ${datos.access_token}` },
  });
  const perfilDatos = await perfil.json();
  const equipos = await fetch(`${base}/api/equipos?limite=1`, {
    headers: { Authorization: `Bearer ${datos.access_token}` },
  });
  const adminUsuarios = await fetch(`${base}/api/admin/usuarios`, {
    headers: { Authorization: `Bearer ${datos.access_token}` },
  });

  console.log(
    `  [OK] ${cuenta.email} / ${cuenta.password} · perfil ${perfil.status} (${perfilDatos.rol}) · equipos ${equipos.status} · admin/usuarios ${adminUsuarios.status}`
  );
  return true;
}

const usuarios = await listarUsuarios();
console.log("Restaurando accesos corporativos…");
for (const cuenta of cuentas) {
  await ensureUsuario(cuenta, usuarios);
}
console.log("Verificando inicios de sesión:");
let todoOk = true;
for (const cuenta of cuentas) {
  todoOk = (await verificar(cuenta)) && todoOk;
}
console.log(todoOk ? "Todos los accesos operativos." : "Hay accesos que requieren revisión.");
