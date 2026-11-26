-- ============================================================
-- Levapan TI · Unificación 360° (Entra ID + HP WXP)
-- Idempotente. Ejecutar en Supabase → SQL Editor → Run.
-- Las tablas espejo son de SOLO LECTURA para los técnicos:
-- nunca sobrescriben los 27 campos administrativos de equipos.
-- ============================================================

create or replace function public.normalizar_serial(texto text)
returns text language sql immutable as $$
  select upper(trim(coalesce(texto, '')));
$$;

-- ---------------- Microsoft Entra ID (solo lectura) ----------------
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

create unique index if not exists sync_entra_serial_uidx
  on public.sync_entra_dispositivos (public.normalizar_serial(serial));

-- ---------------- HP WXP (solo lectura) ----------------
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

create unique index if not exists sync_hp_serial_uidx
  on public.sync_hp_wxp (public.normalizar_serial(serial));

-- UPSERT por columna serial (PostgREST necesita restricción única simple).
do $$
begin
  delete from public.sync_entra_dispositivos a using public.sync_entra_dispositivos b
  where a.ctid < b.ctid and public.normalizar_serial(a.serial) = public.normalizar_serial(b.serial);
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_entra_serial_unico' and conrelid = 'public.sync_entra_dispositivos'::regclass
  ) then
    alter table public.sync_entra_dispositivos add constraint sync_entra_serial_unico unique (serial);
  end if;

  delete from public.sync_hp_wxp a using public.sync_hp_wxp b
  where a.ctid < b.ctid and public.normalizar_serial(a.serial) = public.normalizar_serial(b.serial);
  if not exists (
    select 1 from pg_constraint
    where conname = 'sync_hp_serial_unico' and conrelid = 'public.sync_hp_wxp'::regclass
  ) then
    alter table public.sync_hp_wxp add constraint sync_hp_serial_unico unique (serial);
  end if;
end $$;

alter table public.sync_entra_dispositivos enable row level security;
alter table public.sync_hp_wxp enable row level security;

drop policy if exists "lectura entra" on public.sync_entra_dispositivos;
create policy "lectura entra" on public.sync_entra_dispositivos for select to authenticated using (true);
drop policy if exists "escritura entra" on public.sync_entra_dispositivos;
create policy "escritura entra" on public.sync_entra_dispositivos for all to authenticated using (true) with check (true);

drop policy if exists "lectura hp" on public.sync_hp_wxp;
create policy "lectura hp" on public.sync_hp_wxp for select to authenticated using (true);
drop policy if exists "escritura hp" on public.sync_hp_wxp;
create policy "escritura hp" on public.sync_hp_wxp for all to authenticated using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on schema public to authenticated, anon, service_role;

-- ---------------- Vista de Veredicto Cruzado 360° ----------------
create or replace view public.vista_veredicto_360 as
select
  e.id,
  e.placa,
  e.nombre_red,
  e.serial,
  e.responsable,
  e.cedula,
  e.empresa,
  e.sede,
  e.ceco,
  e.area,
  e.estado,
  e.marca,
  e.modelo,
  e.tipo_equipo,
  e.proveedor,
  e.num_contrato,
  e.tipo_contrato,
  e.fecha_vencimiento_contrato,
  e.procesador,
  e.ram,
  e.disco,
  e.bitacora,
  e.accesorios,
  e.creado_por,
  e.modificado_por,
  e.updated_at,
  e.sistema_id,
  en.device_id,
  en.nombre_dispositivo,
  en.sistema_operativo,
  en.version_os,
  en.upn_usuario,
  en.nombre_usuario_entra,
  en.usuario_activo_m365,
  en.ultima_actividad,
  en.cumplimiento,
  hp.modelo_hp,
  hp.bios_version,
  hp.salud_bateria_pct,
  hp.estado_disco,
  hp.estado_conexion,
  hp.ultimo_usuario_hp,
  hp.ultima_conexion_hp,
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

grant select on public.vista_veredicto_360 to authenticated;

-- Realtime sobre las tablas espejo.
do $$ begin alter publication supabase_realtime add table public.sync_entra_dispositivos; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.sync_hp_wxp; exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';

-- FIN UNIFICACIÓN 360°
