# Acta de Tecnología · Levapan (Supabase Edition)

PWA empresarial para registro de entrega, devolución y préstamo de equipos de
tecnología. **No depende de Microsoft Entra ID, Microsoft Graph ni SharePoint.**

- **PostgreSQL (Supabase):** sistemas, equipos, actas, bóveda documental e historial.
- **Supabase Auth:** inicio de sesión con correo y contraseña + perfiles TI.
- **Supabase Storage:** PDFs firmados en los buckets privados `actas-pdf` y `boveda-ti`.
- **pdf-lib:** plantilla oficial `CORP-TEC-FR-002` con firma táctil incrustada.
- **Full-Text Search:** índice `tsvector` en español sobre el texto de la Bóveda.
- **Liquid Glass + PWA:** Workspace Modular post-login y caché Network-First (`acta-levapan-v22`).

## Arquitectura Inversa de TI

Después del login, la aplicación abre un workspace con cuatro módulos:

| Módulo | Qué resuelve |
| --- | --- |
| **Sistemas** | Ecosistemas macro (ERP-SAP, M365, INFRA-PLANTA, POS-CAJAS, REDES-SRV) con criticidad, placas y documentos. |
| **Placas** | Vista 360° Sistema → Placa → Equipo → Actas/Contratos con historial y líneas de conexión animadas. |
| **Equipos** | Inventario completo (1.577+), filtros por sede/estado/sistema, garantías próximas en dorado e importación Excel. |
| **Bóveda PDF** | Carpetas por categoría, búsqueda dentro del texto del PDF, vínculos a placas/sistemas y visor embebido. |

La pantalla de login (`index.html` + `js/auth.js`) permanece sin cambios: al
validar la sesión se desmonta con una transición fluida y aparece el workspace.

## 1. Requisitos

- Node.js 20 o superior (Render usa 24).
- Proyecto de Supabase (plan gratuito funciona).
- Navegador Chrome/Edge para instalar la PWA.

## 2. Base de datos

1. En Supabase → **SQL Editor → New query**.
2. Pega todo `sql/schema.sql` y ejecuta **Run**. Es idempotente.
3. Ejecuta también `sql/migracion_sharepoint_27.sql` (27 columnas reales de
   SharePoint, estados exactos y permisos granulares). Está copiado en el
   portapapeles al finalizar la preparación.
4. Crea el usuario en **Authentication → Users → Add user** (correo corporativo).
4. Copia su UUID y regístralo como técnico:

```sql
insert into public.perfiles_ti (id, nombre_completo, cedula, email, rol, activo)
values ('UUID-DEL-USUARIO', 'Harold Moreno', '1087778841',
        'harold.moreno@levapan.com', 'admin', true)
on conflict (id) do update set
  nombre_completo = excluded.nombre_completo,
  cedula = excluded.cedula,
  email = excluded.email,
  rol = excluded.rol,
  activo = excluded.activo;
```

## 3. Variables de entorno

Copia `.env.example` como `.env`:

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
PORT=3000
HOST=0.0.0.0
```

> La **SERVICE_ROLE_KEY** solo vive en el servidor. Nunca se envía al navegador.

### Bóveda opcional en Backblaze B2 / Cloudflare R2

Por defecto la Bóveda usa Supabase Storage. Para usar 10 GB gratuitos en B2 o
R2, instala `@aws-sdk/client-s3` y `@aws-sdk/s3-request-presigner` y define
`VAULT_PROVIDER`, `VAULT_S3_ENDPOINT`, `VAULT_S3_REGION`,
`VAULT_S3_ACCESS_KEY_ID` y `VAULT_S3_SECRET_ACCESS_KEY` (ver `.env.example`).
No es obligatorio: sin esas variables todo sigue funcionando en Supabase.

## 4. Instalación y migración del inventario

```bash
npm install
node scripts/migrar-inventario.js
# O con una ruta explícita:
node scripts/migrar-inventario.js "ruta/al/inventario.xlsx"
```

El script busca automáticamente `.xlsx`, `.xls`, `.ods` o `.csv` en el proyecto
y hace `upsert` por placa en lotes de 200. Imprime:

```json
{ "totalLeidos": 0, "procesados": 0, "errores": 0 }
```

## 5. Ejecución local

```bash
npm start
```

Abre `http://localhost:3000`, ingresa con el correo y contraseña creados en
Supabase Auth. El indicador superior debe mostrar
**Modo Nube Activo (Supabase)** con el total de equipos.

## 6. Despliegue en Render

El blueprint `render.yaml` ya define el servicio. En Render:
**Environment → Add Environment Variable** con `SUPABASE_URL`,
`SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`. Luego:

```bash
git add .
git commit -m "Migracion completa a Supabase"
git push origin main
```

Render ejecuta `npm ci --omit=dev` y `npm start`. El health check es
`GET /api/health`.

## 7. API principal

| Método | Ruta | Uso |
| --- | --- | --- |
| GET | `/api/health` | Salud real contra PostgreSQL |
| GET | `/api/estado` | `{ ok, modo, totalEquipos, almacenamiento }` |
| POST | `/api/registro-corporativo` | Alta pública de cuentas `@levapan.com` (rol `tecnico`) |
| GET | `/api/admin/usuarios` | Lista de perfiles TI (solo admin) |
| POST | `/api/admin/usuarios` | Crear usuario corporativo (solo admin) |
| PATCH | `/api/admin/usuarios/:id` | Cambiar rol, sede, sistema, activo y permisos JSONB (solo admin) |
| DELETE | `/api/admin/usuarios/:id` | Desactivar acceso o `?modo=eliminar` (solo admin) |
| GET | `/api/admin/config-sync` | URL del webhook y token SharePoint (solo admin) |
| POST | `/api/sync/sharepoint` | UPSERT por Placa/Serial con header `x-sync-token` |
| GET | `/api/admin/respaldo-completo` | Respaldo JSON o `?formato=xlsx` (solo admin) |
| GET | `/api/perfil` | Técnico autenticado |
| GET | `/api/sistemas` | Sistemas con conteo de placas y documentos |
| POST / PUT | `/api/sistemas[/:id]` | Alta y edición de sistemas |
| DELETE | `/api/sistemas/:id` | Elimina un sistema (las placas quedan sin sistema) |
| GET | `/api/placas/:placa` | Vista 360°: sistema, equipo, historial, actas y documentos |
| GET | `/api/equipos/buscar?q=` | Autocompletado ILIKE (2+ caracteres, 15 resultados) |
| GET | `/api/equipos` | Lista paginada + resumen, filtros `sede`, `estado`, `sistema` |
| POST / PUT | `/api/equipos` | Alta y edición con auditoría |
| GET | `/api/equipos/:id/historial` | Hoja de vida del activo |
| POST | `/api/equipos/importar-excel` | Carga masiva XLSX/CSV/ODS (multer en memoria) |
| POST | `/api/actas` | PDF + Storage + Bóveda + auditoría + actualización de equipo |
| GET | `/api/actas` | Actas emitidas |
| GET | `/api/actas/:id/pdf` | URL firmada de 120 s |
| GET | `/api/boveda` | Documentos con `q`, `categoria`, `placa`, `sistema` |
| POST | `/api/boveda` | Subida multipart con dedupe SHA-256 y vínculos |
| GET | `/api/boveda/:id/url` | URL firmada de 300 s para el visor |
| POST | `/api/boveda/:id/vinculos` | Vincula el documento a placas/sistemas |
| POST | `/api/boveda/:id/reindexar` | Reextrae el texto del PDF (administración) |
| DELETE | `/api/boveda/:id` | Elimina el documento y su objeto si no hay más referencias |
| GET | `/api/exportar/excel` | Respaldo gerencial de 3 hojas |

Todas las rutas excepto `/api/health`, `/api/estado` y `/api/config-publica`
exigen `Authorization: Bearer <access_token>` de Supabase Auth.
