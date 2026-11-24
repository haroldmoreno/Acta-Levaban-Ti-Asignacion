-- ============================================================
-- Acta de Tecnología · Levapan — Arquitectura Inversa de TI
-- Versión 2.0 · Esquema completo e idempotente
-- ------------------------------------------------------------
-- CÓMO EJECUTARLO
--   1) Abre este archivo en un editor de texto.
--   2) Ctrl+A y Ctrl+C (copia TODO el contenido).
--   3) Supabase → SQL Editor → New query → Ctrl+V → Run.
--
-- Es IDEMPOTENTE: se puede ejecutar varias veces sin duplicar
-- datos. La última línea del archivo es un marcador:
--   "-- FIN DEL SCRIPT"
-- Si no ves ese marcador en el editor, la copia quedó incompleta.
--
-- Modelo inverso: Sistema → Placa → Equipo → Actas / Contratos
-- La SERVICE_ROLE_KEY del servidor opera fuera de RLS; las
-- políticas de abajo protegen el acceso directo desde el navegador.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 0) Trigger genérico de updated_at
-- ------------------------------------------------------------
create or replace function public.actualizar_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ------------------------------------------------------------
-- 1) Tabla SISTEMAS (macro-ecosistemas de TI)
-- ------------------------------------------------------------
create table if not exists public.sistemas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null,
  nombre text not null,
  categoria text,
  criticidad text not null default 'Media'
    check (criticidad in ('Critica', 'Alta', 'Media', 'Baja')),
  responsable text,
  descripcion text,
  created_at timestamptz not null default now()
);

create index if not exists sistemas_codigo_idx on public.sistemas (codigo);
create index if not exists sistemas_criticidad_idx on public.sistemas (criticidad);

-- ------------------------------------------------------------
-- 2) Tabla EQUIPOS (activos físicos, uno por placa)
-- ------------------------------------------------------------
create table if not exists public.equipos (
  id uuid primary key default gen_random_uuid(),
  placa text unique not null,
  tipo text,
  marca text,
  modelo text,
  serial text,
  estado text not null default 'Disponible'
    check (estado in ('Disponible', 'Asignado', 'En Mantenimiento', 'Prestamo', 'Dado de Baja')),
  sede text,
  usuario_asignado text,
  usuario_cedula text,
  fecha_compra date,
  garantia_hasta date,
  observaciones text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Vínculo inverso: cada placa pertenece a un sistema macro.
alter table public.equipos
  add column if not exists sistema_id uuid
  references public.sistemas(id) on delete set null;

create index if not exists equipos_placa_idx on public.equipos (placa);
create index if not exists equipos_serial_idx on public.equipos (serial);
create index if not exists equipos_sede_idx on public.equipos (sede);
create index if not exists equipos_estado_idx on public.equipos (estado);
create index if not exists equipos_sistema_idx on public.equipos (sistema_id);
create index if not exists equipos_garantia_idx on public.equipos (garantia_hasta);

drop trigger if exists equipos_actualizar_updated_at on public.equipos;
create trigger equipos_actualizar_updated_at
before update on public.equipos
for each row execute function public.actualizar_updated_at();

-- ------------------------------------------------------------
-- 3) Tabla PERFILES_TI (usuarios de Tecnología)
-- ------------------------------------------------------------
create table if not exists public.perfiles_ti (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre_completo text not null,
  cedula text not null,
  email text,
  rol text not null default 'tecnico' check (rol in ('admin', 'tecnico')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 3b) Helpers de seguridad
--     Se crean DESPUÉS de perfiles_ti porque son funciones SQL
--     y su cuerpo se valida al crearlas. SECURITY DEFINER evita
--     la recursión de RLS sobre perfiles_ti.
-- ------------------------------------------------------------
create or replace function public.ti_es_activo()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.perfiles_ti p
    where p.id = auth.uid()
      and p.activo = true
  );
$$;

create or replace function public.ti_es_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.perfiles_ti p
    where p.id = auth.uid()
      and p.activo = true
      and p.rol = 'admin'
  );
$$;

-- ------------------------------------------------------------
-- 4) Tabla ACTAS (documento oficial CORP-TEC-FR-002)
-- ------------------------------------------------------------
create table if not exists public.actas (
  id uuid primary key default gen_random_uuid(),
  consecutivo serial unique not null,
  tipo_acta text not null
    check (tipo_acta in ('Asignacion', 'Devolucion', 'Prestamo')),
  equipo_id uuid references public.equipos(id) on delete set null,
  placa text not null,
  colaborador_nombre text not null,
  colaborador_cedula text not null,
  sede text not null,
  agente_ti_id uuid references public.perfiles_ti(id) on delete set null,
  agente_ti_nombre text,
  agente_ti_cedula text,
  accesorios jsonb not null default '[]'::jsonb,
  software jsonb not null default '[]'::jsonb,
  observaciones text,
  pdf_storage_path text,
  created_at timestamptz not null default now()
);

create index if not exists actas_placa_idx on public.actas (placa);
create index if not exists actas_consecutivo_idx on public.actas (consecutivo);
create index if not exists actas_colaborador_idx on public.actas (colaborador_nombre);
create index if not exists actas_equipo_idx on public.actas (equipo_id);

-- ------------------------------------------------------------
-- 5) Tabla HISTORIAL_MOVIMIENTOS (hoja de vida y auditoría)
-- ------------------------------------------------------------
create table if not exists public.historial_movimientos (
  id uuid primary key default gen_random_uuid(),
  equipo_id uuid references public.equipos(id) on delete cascade,
  acta_id uuid references public.actas(id) on delete set null,
  placa text not null,
  accion text not null
    check (accion in ('Creacion', 'Edicion', 'Asignacion', 'Devolucion', 'Prestamo', 'Importacion Lote')),
  detalle text,
  realizado_por text,
  created_at timestamptz not null default now()
);

create index if not exists historial_equipo_idx on public.historial_movimientos (equipo_id);
create index if not exists historial_placa_idx on public.historial_movimientos (placa);
create index if not exists historial_created_idx on public.historial_movimientos (created_at desc);

-- ------------------------------------------------------------
-- 6) Tabla BOVEDA_DOCUMENTOS (gestor documental)
-- ------------------------------------------------------------
create table if not exists public.boveda_documentos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  categoria text not null default 'Contrato'
    check (categoria in ('Acta', 'Contrato', 'Factura', 'Garantia', 'Manual', 'Licencia')),
  proveedor text,
  numero_referencia text,
  fecha_documento date,
  fecha_vencimiento date,
  storage_provider text not null default 'supabase',
  storage_bucket text not null default 'boveda-ti',
  storage_path text not null,
  mime_type text,
  tamano_bytes bigint,
  sha256_hash text,
  contenido_texto text,
  texto_indexado tsvector,
  subido_por text,
  created_at timestamptz not null default now()
);

create index if not exists boveda_categoria_idx on public.boveda_documentos (categoria);
create index if not exists boveda_vencimiento_idx on public.boveda_documentos (fecha_vencimiento);
create index if not exists boveda_created_idx on public.boveda_documentos (created_at desc);

-- Un mismo archivo no se archiva dos veces: el hash SHA-256 es único.
create unique index if not exists boveda_hash_unico_idx
  on public.boveda_documentos (sha256_hash)
  where sha256_hash is not null;

-- Índice GIN para búsqueda Full-Text instantánea en español.
create index if not exists boveda_texto_idx
  on public.boveda_documentos using gin (texto_indexado);

-- Trigger que mantiene texto_indexado en cada alta o edición.
create or replace function public.boveda_indexar_texto()
returns trigger
language plpgsql
as $$
begin
  new.texto_indexado :=
    setweight(to_tsvector('spanish', coalesce(new.titulo, '')), 'A') ||
    setweight(to_tsvector('spanish', coalesce(new.proveedor, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(new.numero_referencia, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(new.categoria, '')), 'C') ||
    setweight(to_tsvector('spanish', coalesce(new.contenido_texto, '')), 'D');
  return new;
end;
$$;

drop trigger if exists boveda_indexar_texto_trg on public.boveda_documentos;
create trigger boveda_indexar_texto_trg
before insert or update of titulo, proveedor, numero_referencia, categoria, contenido_texto
on public.boveda_documentos
for each row execute function public.boveda_indexar_texto();

-- Relleno único para filas creadas antes de existir el trigger.
update public.boveda_documentos
set contenido_texto = contenido_texto
where texto_indexado is null;

-- ------------------------------------------------------------
-- 7) Tabla pivote DOCUMENTO_VINCULOS
--    Un contrato marco o una factura se vinculan a muchas
--    placas y sistemas sin duplicar el archivo físico.
-- ------------------------------------------------------------
create table if not exists public.documento_vinculos (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null
    references public.boveda_documentos(id) on delete cascade,
  equipo_id uuid references public.equipos(id) on delete cascade,
  placa text,
  sistema_id uuid references public.sistemas(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists vinculos_documento_idx on public.documento_vinculos (documento_id);
create index if not exists vinculos_equipo_idx on public.documento_vinculos (equipo_id);
create index if not exists vinculos_placa_idx on public.documento_vinculos (placa);
create index if not exists vinculos_sistema_idx on public.documento_vinculos (sistema_id);

-- Evita duplicar el mismo vínculo lógico.
create unique index if not exists vinculos_unicos_idx
  on public.documento_vinculos (
    documento_id,
    coalesce(equipo_id::text, ''),
    coalesce(placa, ''),
    coalesce(sistema_id::text, '')
  );

-- ------------------------------------------------------------
-- 8) ROW LEVEL SECURITY
-- ------------------------------------------------------------
alter table public.equipos enable row level security;
alter table public.perfiles_ti enable row level security;
alter table public.actas enable row level security;
alter table public.historial_movimientos enable row level security;
alter table public.sistemas enable row level security;
alter table public.boveda_documentos enable row level security;
alter table public.documento_vinculos enable row level security;

-- SISTEMAS ------------------------------------------------------
drop policy if exists "TI activo lee sistemas" on public.sistemas;
create policy "TI activo lee sistemas"
  on public.sistemas for select to authenticated using (public.ti_es_activo());

drop policy if exists "TI activo crea sistemas" on public.sistemas;
create policy "TI activo crea sistemas"
  on public.sistemas for insert to authenticated with check (public.ti_es_activo());

drop policy if exists "TI activo edita sistemas" on public.sistemas;
create policy "TI activo edita sistemas"
  on public.sistemas for update to authenticated
  using (public.ti_es_activo()) with check (public.ti_es_activo());

drop policy if exists "Solo admin elimina sistemas" on public.sistemas;
create policy "Solo admin elimina sistemas"
  on public.sistemas for delete to authenticated using (public.ti_es_admin());

-- EQUIPOS -------------------------------------------------------
drop policy if exists "TI activo lee equipos" on public.equipos;
create policy "TI activo lee equipos"
  on public.equipos for select to authenticated using (public.ti_es_activo());

drop policy if exists "TI activo crea equipos" on public.equipos;
create policy "TI activo crea equipos"
  on public.equipos for insert to authenticated with check (public.ti_es_activo());

drop policy if exists "TI activo edita equipos" on public.equipos;
create policy "TI activo edita equipos"
  on public.equipos for update to authenticated
  using (public.ti_es_activo()) with check (public.ti_es_activo());

drop policy if exists "Solo admin elimina equipos" on public.equipos;
create policy "Solo admin elimina equipos"
  on public.equipos for delete to authenticated using (public.ti_es_admin());

-- PERFILES_TI ---------------------------------------------------
drop policy if exists "Ver perfil propio o admin" on public.perfiles_ti;
create policy "Ver perfil propio o admin"
  on public.perfiles_ti for select to authenticated
  using (id = auth.uid() or public.ti_es_admin());

drop policy if exists "Admin gestiona perfiles" on public.perfiles_ti;
create policy "Admin gestiona perfiles"
  on public.perfiles_ti for all to authenticated
  using (public.ti_es_admin()) with check (public.ti_es_admin());

-- ACTAS: se pueden emitir y leer, NUNCA borrar -------------------
drop policy if exists "TI activo lee actas" on public.actas;
create policy "TI activo lee actas"
  on public.actas for select to authenticated using (public.ti_es_activo());

drop policy if exists "TI activo emite actas" on public.actas;
create policy "TI activo emite actas"
  on public.actas for insert to authenticated with check (public.ti_es_activo());

drop policy if exists "Admin corrige actas" on public.actas;
create policy "Admin corrige actas"
  on public.actas for update to authenticated
  using (public.ti_es_admin()) with check (public.ti_es_admin());

-- No existe política DELETE: nadie puede borrar un acta emitida.

-- HISTORIAL: solo lectura y escritura, sin borrado --------------
drop policy if exists "TI activo lee historial" on public.historial_movimientos;
create policy "TI activo lee historial"
  on public.historial_movimientos for select to authenticated
  using (public.ti_es_activo());

drop policy if exists "TI activo registra historial" on public.historial_movimientos;
create policy "TI activo registra historial"
  on public.historial_movimientos for insert to authenticated
  with check (public.ti_es_activo());

-- No existe política DELETE ni UPDATE sobre la auditoría.

-- BOVEDA_DOCUMENTOS ---------------------------------------------
drop policy if exists "TI activo lee boveda" on public.boveda_documentos;
create policy "TI activo lee boveda"
  on public.boveda_documentos for select to authenticated
  using (public.ti_es_activo());

drop policy if exists "TI activo sube boveda" on public.boveda_documentos;
create policy "TI activo sube boveda"
  on public.boveda_documentos for insert to authenticated
  with check (public.ti_es_activo());

drop policy if exists "Admin corrige boveda" on public.boveda_documentos;
create policy "Admin corrige boveda"
  on public.boveda_documentos for update to authenticated
  using (public.ti_es_admin()) with check (public.ti_es_admin());

drop policy if exists "Solo admin elimina boveda" on public.boveda_documentos;
create policy "Solo admin elimina boveda"
  on public.boveda_documentos for delete to authenticated
  using (public.ti_es_admin());

-- DOCUMENTO_VINCULOS -------------------------------------------
drop policy if exists "TI activo lee vinculos" on public.documento_vinculos;
create policy "TI activo lee vinculos"
  on public.documento_vinculos for select to authenticated
  using (public.ti_es_activo());

drop policy if exists "TI activo crea vinculos" on public.documento_vinculos;
create policy "TI activo crea vinculos"
  on public.documento_vinculos for insert to authenticated
  with check (public.ti_es_activo());

drop policy if exists "Admin elimina vinculos" on public.documento_vinculos;
create policy "Admin elimina vinculos"
  on public.documento_vinculos for delete to authenticated
  using (public.ti_es_admin());

-- ------------------------------------------------------------
-- 9) STORAGE: buckets privados actas-pdf y boveda-ti
--    La app sube y firma URLs con service_role; estas políticas
--    solo cubren el acceso directo desde el navegador.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('actas-pdf', 'actas-pdf', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

insert into storage.buckets (id, name, public, file_size_limit)
values ('boveda-ti', 'boveda-ti', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Limpieza de políticas permisivas de versiones anteriores.
drop policy if exists "Cualquiera ve actas" on storage.objects;
drop policy if exists "Cualquiera sube actas" on storage.objects;
drop policy if exists "Cualquiera borra actas" on storage.objects;
drop policy if exists "Admin borra actas" on storage.objects;
drop policy if exists "TI activo borra actas" on storage.objects;
drop policy if exists "Cualquiera ve boveda" on storage.objects;
drop policy if exists "Cualquiera sube boveda" on storage.objects;
drop policy if exists "Cualquiera borra boveda" on storage.objects;

drop policy if exists "TI activo lee actas pdf" on storage.objects;
create policy "TI activo lee actas pdf"
  on storage.objects for select to authenticated
  using (bucket_id = 'actas-pdf' and public.ti_es_activo());

drop policy if exists "TI activo sube actas pdf" on storage.objects;
create policy "TI activo sube actas pdf"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'actas-pdf' and public.ti_es_activo());

drop policy if exists "TI activo lee boveda pdf" on storage.objects;
create policy "TI activo lee boveda pdf"
  on storage.objects for select to authenticated
  using (bucket_id = 'boveda-ti' and public.ti_es_activo());

drop policy if exists "TI activo sube boveda pdf" on storage.objects;
create policy "TI activo sube boveda pdf"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'boveda-ti' and public.ti_es_activo());

-- Sin política UPDATE/DELETE: los PDF emitidos son inmutables.

-- ------------------------------------------------------------
-- 10) PRIVILEGIOS
--     Al crear tablas desde el SQL Editor, Supabase no concede
--     permisos automáticos a service_role; sin estos GRANT la
--     API responde "permission denied for table ...".
-- ------------------------------------------------------------
grant usage on schema public to service_role, authenticated, anon;

grant all privileges on all tables in schema public to service_role;
grant select, insert, update on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

grant usage, select on all sequences in schema public to service_role, authenticated;

grant execute on all functions in schema public to service_role, authenticated, anon;

alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to service_role, authenticated;
alter default privileges in schema public
  grant execute on functions to service_role, authenticated;

-- ------------------------------------------------------------
-- 11) Semilla de sistemas macro (Arquitectura Inversa)
-- ------------------------------------------------------------
insert into public.sistemas (codigo, nombre, categoria, criticidad, responsable, descripcion)
values
  ('ERP-SAP', 'ERP / SAP', 'ERP', 'Critica', 'Dirección TI',
   'Núcleo transaccional de la compañía: módulos SAP, interfaces y terminales de consulta.'),
  ('M365', 'Ofimática M365', 'Productividad', 'Alta', 'Soporte TI',
   'Estaciones de trabajo, correo corporativo, Teams, OneDrive y suite Office.'),
  ('INFRA-PLANTA', 'Infraestructura Planta', 'Infraestructura', 'Critica', 'Infraestructura',
   'Handhelds, impresoras industriales, básculas, PLC y equipos de piso de planta.'),
  ('POS-CAJAS', 'POS / Cajas', 'Comercial', 'Alta', 'Comercial',
   'Puntos de venta, cajas registradoras, lectores y periféricos de tienda.'),
  ('REDES-SRV', 'Redes y Servidores', 'Infraestructura', 'Critica', 'Redes',
   'Switches, access points, UPS, servidores y enlaces de comunicaciones.')
on conflict (codigo) do nothing;

-- ------------------------------------------------------------
-- 12) Alta de técnicos
--     Ejecutar DESPUÉS de crear el usuario en
--     Authentication → Users. Sustituye el UUID y los datos.
-- ------------------------------------------------------------
-- insert into public.perfiles_ti (id, nombre_completo, cedula, email, rol, activo)
-- values ('UUID-DEL-USUARIO-AQUI', 'Harold Moreno', '1087778841',
--         'harold.moreno@levapan.com', 'admin', true)
-- on conflict (id) do update set nombre_completo = excluded.nombre_completo,
--   cedula = excluded.cedula, email = excluded.email, rol = excluded.rol,
--   activo = excluded.activo;

-- ------------------------------------------------------------
-- 13) Recarga la caché de PostgREST y verifica el resultado
-- ------------------------------------------------------------
notify pgrst, 'reload schema';

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'equipos',
    'perfiles_ti',
    'actas',
    'historial_movimientos',
    'sistemas',
    'boveda_documentos',
    'documento_vinculos'
  )
order by tablename;

-- Deben aparecer 7 filas con rowsecurity = true.
-- FIN DEL SCRIPT
