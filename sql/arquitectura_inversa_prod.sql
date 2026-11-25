-- ============================================================
-- Levapan TI — Arquitectura Inversa (producción, idempotente)
-- PostgreSQL / Supabase. Ejecutar en SQL Editor → Run.
-- ============================================================

create extension if not exists pgcrypto;

create or replace function public.actualizar_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- ------------------------------------------------------------
-- Ecosistemas (Arquitectura Inversa)
-- ------------------------------------------------------------
create table if not exists public.sistemas (
  id uuid primary key default gen_random_uuid(),
  codigo text unique not null,
  nombre text not null,
  descripcion text,
  criticidad text not null default 'MEDIA'
    check (criticidad in ('CRÍTICA','ALTA','MEDIA')),
  responsable_sistema text,
  created_at timestamptz not null default now()
);

insert into public.sistemas (codigo, nombre, descripcion, criticidad, responsable_sistema)
values
  ('ERP-SAP','ERP / SAP','Núcleo transaccional y módulos SAP','CRÍTICA','Dirección TI'),
  ('INFRA-PLANTA','Infraestructura Planta','Handhelds, impresoras industriales y PLC','CRÍTICA','Infraestructura'),
  ('M365','Ofimática M365','Correo, Teams, OneDrive y Office','ALTA','Soporte TI'),
  ('POS-CAJAS','POS / Cajas','Puntos de venta y periféricos','ALTA','Comercial'),
  ('REDES-SRV','Redes y Servidores','Switches, AP, UPS y servidores','CRÍTICA','Redes')
on conflict (codigo) do nothing;

-- ------------------------------------------------------------
-- Activos (27 columnas, valores reales; sin inventar estados)
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
  tipo_elemento text,
  ruta_acceso text,
  area text,
  modificado_por text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Columnas incorporadas al orden maestro (tablas ya existentes).
alter table public.equipos add column if not exists creado_por text;
alter table public.equipos add column if not exists tipo_elemento text;
alter table public.equipos add column if not exists ruta_acceso text;

create index if not exists equipos_sistema_idx on public.equipos(sistema_id);
create index if not exists equipos_placa_idx on public.equipos(placa);
create index if not exists equipos_serial_idx on public.equipos(serial);
create index if not exists equipos_ceco_idx on public.equipos(ceco);
create index if not exists equipos_sede_idx on public.equipos(sede);

drop trigger if exists equipos_updated_at on public.equipos;
create trigger equipos_updated_at before update on public.equipos
for each row execute function public.actualizar_updated_at();

-- ------------------------------------------------------------
-- Auditoría / Hoja de Vida
-- ------------------------------------------------------------
create table if not exists public.historial_movimientos (
  id uuid primary key default gen_random_uuid(),
  equipo_id uuid references public.equipos(id) on delete set null,
  placa text,
  tipo_movimiento text not null
    check (tipo_movimiento in ('ASIGNACIÓN','DEVOLUCIÓN','TRASLADO','EDICIÓN','ALTA','BAJA')),
  responsable_anterior text,
  responsable_nuevo text,
  sede_nueva text,
  ceco_nuevo text,
  observaciones text,
  tecnico_responsable text,
  acta_pdf_url text,
  fecha_colombia timestamptz not null default now()
);

create index if not exists historial_equipo_idx on public.historial_movimientos(equipo_id);
create index if not exists historial_placa_idx on public.historial_movimientos(placa);
create index if not exists historial_fecha_idx on public.historial_movimientos(fecha_colombia desc);

-- ------------------------------------------------------------
-- Usuarios corporativos (roles de la app)
-- ------------------------------------------------------------
create table if not exists public.usuarios_corporativos (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  nombre_completo text not null,
  rol text not null default 'TECNICO_TI'
    check (rol in ('ADMINISTRADOR_TI','TECNICO_TI')),
  password_hash text,
  activo boolean not null default true,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Bóveda documental
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
  created_at timestamptz not null default now()
);

create index if not exists boveda_equipo_idx on public.boveda_documentos(equipo_id);
create index if not exists boveda_placa_idx on public.boveda_documentos(placa);

-- ------------------------------------------------------------
-- RLS y permisos (cliente Supabase directo)
-- ------------------------------------------------------------
alter table public.sistemas enable row level security;
alter table public.equipos enable row level security;
alter table public.historial_movimientos enable row level security;
alter table public.usuarios_corporativos enable row level security;
alter table public.boveda_documentos enable row level security;

drop policy if exists "lectura sistemas" on public.sistemas;
create policy "lectura sistemas" on public.sistemas for select to authenticated using (true);
drop policy if exists "escritura sistemas" on public.sistemas;
create policy "escritura sistemas" on public.sistemas for all to authenticated using (true) with check (true);

drop policy if exists "lectura equipos" on public.equipos;
create policy "lectura equipos" on public.equipos for select to authenticated using (true);
drop policy if exists "escritura equipos" on public.equipos;
create policy "escritura equipos" on public.equipos for all to authenticated using (true) with check (true);

drop policy if exists "lectura historial" on public.historial_movimientos;
create policy "lectura historial" on public.historial_movimientos for select to authenticated using (true);
drop policy if exists "escritura historial" on public.historial_movimientos;
create policy "escritura historial" on public.historial_movimientos for all to authenticated using (true) with check (true);

drop policy if exists "lectura usuarios" on public.usuarios_corporativos;
create policy "lectura usuarios" on public.usuarios_corporativos for select to authenticated using (true);
drop policy if exists "escritura usuarios" on public.usuarios_corporativos;
create policy "escritura usuarios" on public.usuarios_corporativos for all to authenticated using (true) with check (true);

drop policy if exists "lectura boveda" on public.boveda_documentos;
create policy "lectura boveda" on public.boveda_documentos for select to authenticated using (true);
drop policy if exists "escritura boveda" on public.boveda_documentos;
create policy "escritura boveda" on public.boveda_documentos for all to authenticated using (true) with check (true);

insert into storage.buckets (id, name, public, file_size_limit)
values ('boveda-ti','boveda-ti',false,52428800)
on conflict (id) do update set public=false, file_size_limit=52428800;

drop policy if exists "lectura boveda storage" on storage.objects;
create policy "lectura boveda storage" on storage.objects for select to authenticated
using (bucket_id='boveda-ti');
drop policy if exists "subida boveda storage" on storage.objects;
create policy "subida boveda storage" on storage.objects for insert to authenticated
with check (bucket_id='boveda-ti');

grant usage on schema public to authenticated, anon, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Realtime en vivo para múltiples técnicos.
do $$
begin
  alter publication supabase_realtime add table public.sistemas;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.equipos;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.historial_movimientos;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';

-- FIN DEL ESQUEMA
