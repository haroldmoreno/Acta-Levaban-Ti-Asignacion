-- ============================================================
-- Acta de Tecnología · Levapan — Auditoría completa del historial
-- ------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor → New query → Run.
-- Idempotente.
-- ============================================================

alter table public.historial_movimientos
  add column if not exists tipo_movimiento text;
alter table public.historial_movimientos
  add column if not exists descripcion text;
alter table public.historial_movimientos
  add column if not exists usuario_nombre text;
alter table public.historial_movimientos
  add column if not exists usuario_email text;

-- Backfill de registros existentes.
update public.historial_movimientos
set
  tipo_movimiento = coalesce(tipo_movimiento, accion, 'Edición'),
  descripcion = coalesce(descripcion, detalle, 'Movimiento registrado'),
  usuario_nombre = coalesce(usuario_nombre, realizado_por, 'sistema')
where tipo_movimiento is null or descripcion is null or usuario_nombre is null;

create index if not exists historial_tipo_idx
  on public.historial_movimientos (tipo_movimiento);
create index if not exists historial_usuario_idx
  on public.historial_movimientos (usuario_nombre);
create index if not exists historial_fecha_idx
  on public.historial_movimientos (created_at desc);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update on all tables in schema public to authenticated;

notify pgrst, 'reload schema';

-- FIN DE LA MIGRACIÓN DE AUDITORÍA
