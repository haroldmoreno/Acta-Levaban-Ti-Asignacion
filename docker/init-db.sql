-- ============================================================
-- Levapan TI · Inicialización on-premise (PostgreSQL 15)
-- ------------------------------------------------------------
-- Idempotente: se ejecuta una sola vez al crear el volumen
-- ./volumes/db mediante /docker-entrypoint-initdb.d.
-- Incluye: 27 columnas maestras, actas CORP-TEC-FR-002,
-- hoja de vida, bóveda PDF, espejos Entra ID / HP WXP y
-- vista_veredicto_360.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 0) Roles y esquemas compatibles con PostgREST / GoTrue / Storage
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists auth;

-- GoTrue crea auth.users. Esta función permite que RLS lea el JWT.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role()
returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '');
$$;

-- Storage mínimo compatible con storage-api (bóveda de PDF).
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text unique not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  public boolean not null default false,
  file_size_limit bigint default 52428800,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id) on delete cascade,
  name text not null,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_accessed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique (bucket_id, name)
);

-- ------------------------------------------------------------
-- 1) Funciones base
-- ------------------------------------------------------------
create or replace function public.actualizar_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.normalizar_serial(texto text)
returns text language sql immutable as $$
  select upper(trim(coalesce(texto, '')));
$$;

-- ------------------------------------------------------------
-- 2) Ecosistemas de TI (Arquitectura Inversa)
-- ------------------------------------------------------------
create table if not exists public.sistemas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null,
  nombre text not null,
  categoria text,
  criticidad text not null default 'MEDIA',
  responsable text,
  responsable_sistema text,
  descripcion text,
  created_at timestamptz not null default now()
);

insert into public.sistemas (codigo, nombre, categoria, criticidad, responsable, responsable_sistema, descripcion)
values
  ('ERP-SAP',      'ERP / SAP',              'ERP',            'CRITICA', 'Dirección TI',  'Dirección TI',  'Núcleo transaccional: módulos SAP, interfaces y terminales.'),
  ('INFRA-PLANTA', 'Infraestructura Planta', 'Infraestructura','CRITICA', 'Infraestructura','Infraestructura','Handhelds, impresoras industriales, básculas y PLC.'),
  ('M365',         'Ofimática M365',         'Productividad',  'ALTA',    'Soporte TI',    'Soporte TI',    'Estaciones de trabajo, correo, Teams, OneDrive y Office.'),
  ('POS-CAJAS',    'POS / Cajas',            'Comercial',      'ALTA',    'Comercial',     'Comercial',     'Puntos de venta, cajas registradoras y periféricos.'),
  ('REDES-SRV',    'Redes y Servidores',     'Infraestructura','CRITICA', 'Redes',         'Redes',         'Switches, access points, UPS, servidores y enlaces.')
on conflict (codigo) do nothing;

-- ------------------------------------------------------------
-- 3) EQUIPOS · esquema maestro exacto de 27 columnas + compatibilidad
-- ------------------------------------------------------------
create table if not exists public.equipos (
  id uuid primary key default gen_random_uuid(),
  sistema_id uuid references public.sistemas(id) on delete set null,
  placa text unique not null,
  nombre_red text,
  serial text,
  responsable text,
  cedula text,
  empresa text,
  sede text,
  ceco text,
  estado text,
  proveedor text,
  num_contrato text,
  tipo_contrato text,
  fecha_vencimiento_contrato date,
  tipo_equipo text,
  marca text,
  modelo text,
  procesador text,
  ram text,
  disco text,
  bitacora text,
  accesorios text,
  creado_por text,
  modificado_por text,
  updated_at timestamptz not null default now(),
  area text,
  tipo_elemento text,
  ruta_acceso text,
  created_at timestamptz not null default now(),
  -- columnas de compatibilidad con versiones anteriores de la app
  tipo text,
  usuario_asignado text,
  usuario_cedula text,
  observaciones text
);

create index if not exists equipos_sistema_idx on public.equipos (sistema_id);
create index if not exists equipos_placa_idx on public.equipos (placa);
create index if not exists equipos_serial_idx on public.equipos (serial);
create index if not exists equipos_ceco_idx on public.equipos (ceco);
create index if not exists equipos_sede_idx on public.equipos (sede);
create index if not exists equipos_responsable_idx on public.equipos (responsable);
create index if not exists equipos_estado_idx on public.equipos (estado);

drop trigger if exists equipos_updated_at on public.equipos;
create trigger equipos_updated_at before update on public.equipos
for each row execute function public.actualizar_updated_at();

-- ------------------------------------------------------------
-- 4) Usuarios corporativos y perfiles TI
-- ------------------------------------------------------------
create table if not exists public.usuarios_corporativos (
  id uuid primary key,
  email text unique not null,
  nombre_completo text not null,
  rol text not null default 'TECNICO_TI'
    check (rol in ('ADMINISTRADOR_TI', 'TECNICO_TI')),
  cedula text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.perfiles_ti (
  id uuid primary key,
  nombre_completo text not null,
  cedula text,
  email text,
  rol text not null default 'tecnico' check (rol in ('admin', 'tecnico')),
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 5) Acta oficial CORP-TEC-FR-002 y hoja de vida
-- ------------------------------------------------------------
create table if not exists public.actas (
  id uuid primary key default gen_random_uuid(),
  consecutivo serial unique not null,
  tipo_acta text not null,
  equipo_id uuid references public.equipos(id) on delete set null,
  placa text not null,
  colaborador_nombre text,
  colaborador_cedula text,
  sede text,
  agente_ti_id uuid,
  agente_ti_nombre text,
  agente_ti_cedula text,
  accesorios jsonb not null default '[]'::jsonb,
  software jsonb not null default '[]'::jsonb,
  observaciones text,
  pdf_storage_path text,
  created_at timestamptz not null default now()
);

create table if not exists public.historial_movimientos (
  id uuid primary key default gen_random_uuid(),
  equipo_id uuid references public.equipos(id) on delete set null,
  placa text,
  tipo_movimiento text,
  accion text,
  responsable_anterior text,
  responsable_nuevo text,
  sede_nueva text,
  ceco_nuevo text,
  observaciones text,
  detalle text,
  realizado_por text,
  tecnico_responsable text,
  acta_pdf_url text,
  fecha_colombia timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists historial_equipo_idx on public.historial_movimientos (equipo_id);
create index if not exists historial_placa_idx on public.historial_movimientos (placa);
create index if not exists historial_fecha_idx on public.historial_movimientos (fecha_colombia desc);

-- ------------------------------------------------------------
-- 6) Bóveda PDF
-- ------------------------------------------------------------
create table if not exists public.boveda_documentos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  categoria text not null default 'Acta',
  equipo_id uuid references public.equipos(id) on delete set null,
  placa text,
  storage_path text not null,
  url text,
  mime_type text,
  proveedor text,
  numero_referencia text,
  fecha_documento date,
  fecha_vencimiento date,
  storage_provider text not null default 'supabase',
  storage_bucket text not null default 'boveda-ti',
  tamano_bytes bigint,
  sha256_hash text,
  contenido_texto text,
  texto_indexado tsvector,
  subido_por text,
  created_at timestamptz not null default now()
);

create index if not exists boveda_equipo_idx on public.boveda_documentos (equipo_id);
create index if not exists boveda_placa_idx on public.boveda_documentos (placa);
create index if not exists boveda_categoria_idx on public.boveda_documentos (categoria);
create index if not exists boveda_vencimiento_idx on public.boveda_documentos (fecha_vencimiento);
create index if not exists boveda_created_idx on public.boveda_documentos (created_at desc);

create or replace function public.boveda_indexar_texto()
returns trigger language plpgsql as $$
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

create table if not exists public.documento_vinculos (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null references public.boveda_documentos(id) on delete cascade,
  equipo_id uuid references public.equipos(id) on delete cascade,
  placa text,
  sistema_id uuid references public.sistemas(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 7) Espejos de telemetría 360° (solo lectura para la app)
-- ------------------------------------------------------------
create table if not exists public.sync_entra_dispositivos (
  serial text,
  device_id text,
  nombre_dispositivo text,
  sistema_operativo text,
  version_os text,
  upn_usuario text,
  nombre_usuario_entra text,
  usuario_activo_m365 boolean,
  ultima_actividad timestamptz,
  cumplimiento text,
  synced_at timestamptz not null default now()
);

create table if not exists public.sync_hp_wxp (
  serial text,
  device_name text,
  modelo_hp text,
  bios_version text,
  salud_bateria_pct integer,
  estado_disco text,
  estado_conexion text,
  ultimo_usuario_hp text,
  ultima_conexion_hp timestamptz,
  synced_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_entra_serial_unico'
      and conrelid = 'public.sync_entra_dispositivos'::regclass
  ) then
    delete from public.sync_entra_dispositivos a using public.sync_entra_dispositivos b
    where a.ctid < b.ctid and public.normalizar_serial(a.serial) = public.normalizar_serial(b.serial);
    alter table public.sync_entra_dispositivos add constraint sync_entra_serial_unico unique (serial);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_hp_serial_unico'
      and conrelid = 'public.sync_hp_wxp'::regclass
  ) then
    delete from public.sync_hp_wxp a using public.sync_hp_wxp b
    where a.ctid < b.ctid and public.normalizar_serial(a.serial) = public.normalizar_serial(b.serial);
    alter table public.sync_hp_wxp add constraint sync_hp_serial_unico unique (serial);
  end if;
end $$;

-- ------------------------------------------------------------
-- 8) Veredicto 360°
-- ------------------------------------------------------------
create or replace view public.vista_veredicto_360 as
select
  e.id, e.placa, e.nombre_red, e.serial, e.responsable, e.cedula,
  e.empresa, e.sede, e.ceco, e.area, e.estado, e.marca, e.modelo,
  e.tipo_equipo, e.proveedor, e.num_contrato, e.tipo_contrato,
  e.fecha_vencimiento_contrato, e.procesador, e.ram, e.disco,
  e.bitacora, e.accesorios, e.creado_por, e.modificado_por, e.updated_at,
  e.sistema_id,
  en.device_id, en.nombre_dispositivo, en.sistema_operativo, en.version_os,
  en.upn_usuario, en.nombre_usuario_entra, en.usuario_activo_m365,
  en.ultima_actividad, en.cumplimiento,
  hp.modelo_hp, hp.bios_version, hp.salud_bateria_pct, hp.estado_disco,
  hp.estado_conexion, hp.ultimo_usuario_hp, hp.ultima_conexion_hp,
  case
    when en.usuario_activo_m365 = false then 'USUARIO_RETIRADO_M365'
    when en.device_id is null and hp.device_name is null then 'SOLO_INVENTARIO'
    when en.ultima_actividad is not null and en.ultima_actividad < now() - interval '30 days' then 'SIN_REPORTE_TELEMETRIA'
    when en.upn_usuario is not null and e.responsable is not null
      and public.normalizar_serial(en.upn_usuario) <> public.normalizar_serial(e.responsable)
      then 'DISCREPANCIA_USUARIO'
    else 'VERIFICADO'
  end as veredicto_estado,
  case
    when en.usuario_activo_m365 = false then 'Usuario deshabilitado en Microsoft 365'
    when en.device_id is null and hp.device_name is null then 'Sin reporte de Entra ID ni HP WXP'
    when en.ultima_actividad is not null and en.ultima_actividad < now() - interval '30 days' then 'Sin actividad de telemetría en más de 30 días'
    when en.upn_usuario is not null and e.responsable is not null
      and public.normalizar_serial(en.upn_usuario) <> public.normalizar_serial(e.responsable)
      then 'El usuario activo en M365 difiere del responsable registrado en el acta'
    else 'Inventario, identidad y telemetría coincidentes'
  end as veredicto_detalle
from public.equipos e
left join public.sync_entra_dispositivos en
  on public.normalizar_serial(en.serial) = public.normalizar_serial(e.serial)
  or (
    en.nombre_dispositivo is not null
    and upper(trim(e.nombre_red)) = upper(trim(en.nombre_dispositivo))
  )
left join public.sync_hp_wxp hp
  on public.normalizar_serial(hp.serial) = public.normalizar_serial(e.serial);

-- ------------------------------------------------------------
-- 9) RLS y permisos
-- ------------------------------------------------------------
alter table public.sistemas enable row level security;
alter table public.equipos enable row level security;
alter table public.usuarios_corporativos enable row level security;
alter table public.perfiles_ti enable row level security;
alter table public.actas enable row level security;
alter table public.historial_movimientos enable row level security;
alter table public.boveda_documentos enable row level security;
alter table public.documento_vinculos enable row level security;
alter table public.sync_entra_dispositivos enable row level security;
alter table public.sync_hp_wxp enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'sistemas', 'equipos', 'usuarios_corporativos', 'perfiles_ti',
    'actas', 'historial_movimientos', 'boveda_documentos',
    'documento_vinculos', 'sync_entra_dispositivos', 'sync_hp_wxp'
  ] loop
    execute format('drop policy if exists "levapan lectura %s" on public.%I', t, t);
    execute format('create policy "levapan lectura %s" on public.%I for select to authenticated using (true)', t, t);
    execute format('drop policy if exists "levapan escritura %s" on public.%I', t, t);
    execute format('create policy "levapan escritura %s" on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

drop policy if exists "levapan lectura boveda storage" on storage.objects;
create policy "levapan lectura boveda storage" on storage.objects for select to authenticated
using (bucket_id in ('boveda-ti', 'actas-pdf'));
drop policy if exists "levapan subida boveda storage" on storage.objects;
create policy "levapan subida boveda storage" on storage.objects for insert to authenticated
with check (bucket_id in ('boveda-ti', 'actas-pdf'));

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant all privileges on all tables in schema storage to service_role;
grant select, insert, update, delete on all tables in schema storage to authenticated;

alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ------------------------------------------------------------
-- 10) Bucket PDF y Realtime
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('actas-pdf', 'actas-pdf', false, 52428800),
  ('boveda-ti', 'boveda-ti', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['sistemas', 'equipos', 'historial_movimientos', 'sync_entra_dispositivos', 'sync_hp_wxp'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- FIN DE LA INICIALIZACIÓN
