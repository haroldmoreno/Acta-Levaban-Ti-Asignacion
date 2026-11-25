-- ============================================================
-- Acta de Tecnología · Levapan — 27 columnas exactas de SharePoint
-- ------------------------------------------------------------
-- Ejecutar en Supabase → SQL Editor → New query → Run.
-- Idempotente: ADD COLUMN IF NOT EXISTS, se puede repetir sin error.
-- No inventa ni sobrescribe estados: el campo Estado queda libre.
-- ============================================================

-- El estado de SharePoint puede traer cualquier texto: sin CHECK ni NOT NULL.
alter table public.equipos drop constraint if exists equipos_estado_check;
alter table public.equipos alter column estado drop not null;

-- 1. Nombre equipo en Red
alter table public.equipos add column if not exists nombre_equipo_red text;
-- 2. Serial del equipo
alter table public.equipos add column if not exists serial text;
-- 3. Nombre del responsable
alter table public.equipos add column if not exists responsable text;
-- 4. Cedula del responsable
alter table public.equipos add column if not exists cedula_responsable text;
-- 5. Empresa
alter table public.equipos add column if not exists empresa text;
-- 6. Sede
alter table public.equipos add column if not exists sede text;
-- 7. CECO
alter table public.equipos add column if not exists ceco text;
-- 8. Estado (valor exacto del inventario)
alter table public.equipos add column if not exists estado text;
-- 9. Proveedor
alter table public.equipos add column if not exists proveedor text;
-- 10. N° Contrato
alter table public.equipos add column if not exists numero_contrato text;
-- 11. Tipo de Contrato
alter table public.equipos add column if not exists tipo_contrato text;
-- 12. Tipo de Equipo
alter table public.equipos add column if not exists tipo_equipo text;
-- 13. Marca
alter table public.equipos add column if not exists marca text;
-- 14. Modelo
alter table public.equipos add column if not exists modelo text;
-- 15. Placa (clave de UPSERT)
alter table public.equipos add column if not exists placa text;
-- 16. Procesador
alter table public.equipos add column if not exists procesador text;
-- 17. Memoria RAM
alter table public.equipos add column if not exists memoria_ram text;
-- 18. Tamaño en Disco
alter table public.equipos add column if not exists tamano_disco text;
-- 19. Bitacora del Equipo
alter table public.equipos add column if not exists bitacora_equipo text;
-- 20. Creado por
alter table public.equipos add column if not exists creado_por text;
-- 21. Modificado por
alter table public.equipos add column if not exists modificado_por text;
-- 22. Accesorios entregados
alter table public.equipos add column if not exists accesorios_entregados text;
-- 23. Modificado
alter table public.equipos add column if not exists modificado_fecha timestamptz;
-- 24. Area
alter table public.equipos add column if not exists area text;
-- 25. Fecha de Vencimiento Contrato
alter table public.equipos add column if not exists fecha_vencimiento_contrato date;
-- 26. Tipo de elemento
alter table public.equipos add column if not exists tipo_elemento text;
-- 27. Ruta de acceso
alter table public.equipos add column if not exists ruta_acceso text;

-- UPSERT por Serial cuando no venga Placa.
create unique index if not exists equipos_serial_unico_idx
  on public.equipos (serial)
  where serial is not null;

create index if not exists equipos_ceco_idx on public.equipos (ceco);
create index if not exists equipos_empresa_idx on public.equipos (empresa);
create index if not exists equipos_nombre_red_idx on public.equipos (nombre_equipo_red);
create index if not exists equipos_responsable_idx on public.equipos (responsable);

-- Etiquetas oficiales de SharePoint para trazabilidad.
comment on column public.equipos.nombre_equipo_red is 'Nombre equipo en Red';
comment on column public.equipos.serial is 'Serial del equipo';
comment on column public.equipos.responsable is 'Nombre del responsable';
comment on column public.equipos.cedula_responsable is 'Cedula del responsable';
comment on column public.equipos.empresa is 'Empresa';
comment on column public.equipos.sede is 'Sede';
comment on column public.equipos.ceco is 'CECO';
comment on column public.equipos.estado is 'Estado';
comment on column public.equipos.proveedor is 'Proveedor';
comment on column public.equipos.numero_contrato is 'N° Contrato';
comment on column public.equipos.tipo_contrato is 'Tipo de Contrato';
comment on column public.equipos.tipo_equipo is 'Tipo de Equipo';
comment on column public.equipos.marca is 'Marca';
comment on column public.equipos.modelo is 'Modelo';
comment on column public.equipos.placa is 'Placa';
comment on column public.equipos.procesador is 'Procesador';
comment on column public.equipos.memoria_ram is 'Memoria RAM';
comment on column public.equipos.tamano_disco is 'Tamaño en Disco';
comment on column public.equipos.bitacora_equipo is 'Bitacora del Equipo';
comment on column public.equipos.creado_por is 'Creado por';
comment on column public.equipos.modificado_por is 'Modificado por';
comment on column public.equipos.accesorios_entregados is 'Accesorios entregados';
comment on column public.equipos.modificado_fecha is 'Modificado';
comment on column public.equipos.area is 'Area';
comment on column public.equipos.fecha_vencimiento_contrato is 'Fecha de Vencimiento Contrato';
comment on column public.equipos.tipo_elemento is 'Tipo de elemento';
comment on column public.equipos.ruta_acceso is 'Ruta de acceso';

grant all privileges on all tables in schema public to service_role;
grant select, insert, update on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to service_role, authenticated;

notify pgrst, 'reload schema';

select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'equipos'
order by ordinal_position;

-- FIN DEL ESQUEMA 27 COLUMNAS SHAREPOINT
