-- ============================================================
-- Acta de Tecnología · Levapan — Migración SharePoint 27 columnas
-- ------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor → New query → Run.
-- Idempotente: se puede ejecutar varias veces.
-- Respeta el valor exacto de "Estado": nunca se reescribe a "Disponible".
-- ============================================================

-- El estado de SharePoint puede tener cualquier texto: quitamos el CHECK.
alter table public.equipos drop constraint if exists equipos_estado_check;
alter table public.equipos alter column estado drop not null;

-- 27 columnas exactas de SharePoint (las ya existentes se respetan).
alter table public.equipos add column if not exists nombre_equipo_red text;
alter table public.equipos add column if not exists responsable text;
alter table public.equipos add column if not exists cedula_responsable text;
alter table public.equipos add column if not exists empresa text;
alter table public.equipos add column if not exists ceco text;
alter table public.equipos add column if not exists area text;
alter table public.equipos add column if not exists proveedor text;
alter table public.equipos add column if not exists numero_contrato text;
alter table public.equipos add column if not exists tipo_contrato text;
alter table public.equipos add column if not exists fecha_vencimiento_contrato date;
alter table public.equipos add column if not exists tipo_equipo text;
alter table public.equipos add column if not exists procesador text;
alter table public.equipos add column if not exists memoria_ram text;
alter table public.equipos add column if not exists tamano_disco text;
alter table public.equipos add column if not exists accesorios_entregados text;
alter table public.equipos add column if not exists bitacora_equipo text;
alter table public.equipos add column if not exists creado_por text;
alter table public.equipos add column if not exists modificado_por text;
alter table public.equipos add column if not exists modificado_fecha timestamptz;
alter table public.equipos add column if not exists tipo_elemento text;
alter table public.equipos add column if not exists ruta_acceso text;

-- UPSERT por Serial cuando no hay Placa.
create unique index if not exists equipos_serial_unico_idx
  on public.equipos (serial)
  where serial is not null;

create index if not exists equipos_responsable_idx on public.equipos (responsable);
create index if not exists equipos_ceco_idx on public.equipos (ceco);
create index if not exists equipos_contrato_idx on public.equipos (numero_contrato);

-- Permisos granulares y sede/sistema asignados en perfiles_ti.
alter table public.perfiles_ti add column if not exists sede_asignada text;
alter table public.perfiles_ti add column if not exists sistema_asignado uuid
  references public.sistemas(id) on delete set null;
alter table public.perfiles_ti add column if not exists permisos jsonb not null default '{
  "puede_crear_editar_equipos": true,
  "puede_emitir_actas": true,
  "puede_sincronizar_importar": false,
  "puede_gestionar_boveda": true,
  "puede_eliminar_registros": false,
  "puede_administrar_usuarios": false
}'::jsonb;

-- GRANTs para service_role (las tablas se crearon desde el SQL Editor).
grant all privileges on all tables in schema public to service_role;
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;

-- Recarga de PostgREST y verificación.
notify pgrst, 'reload schema';

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'equipos'
order by ordinal_position;

-- FIN DE LA MIGRACIÓN SHAREPOINT 27
