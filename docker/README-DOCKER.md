# Levapan TI · Despliegue on-premise con Docker

Paquete completo para instalar la PWA y su backend (Supabase auto-hospedado) en un servidor de **Levapan S.A.S.** sin depender de Cloudflare ni de la nube de Supabase.

## Arquitectura

| Servicio | Imagen | Puerto | Función |
|---|---|---|---|
| `db` | `supabase/postgres:15.1.1.78` | 5432 | PostgreSQL + esquema de 27 columnas, actas y Veredicto 360° |
| `auth` | `supabase/gotrue:v2.151.0` | interno 9999 | Login con correo y contraseña (registro deshabilitado) |
| `rest` | `postgrest/postgrest:v12.0.2` | interno 3000 | API REST sobre `public` |
| `storage` | `supabase/storage-api:v1.0.6` | interno 5000 | Bóveda de PDF (`actas-pdf`, `boveda-ti`) |
| `kong` | `kong:2.8.1` | **8000** | Gateway: `/auth/v1`, `/rest/v1`, `/storage/v1` + CORS |
| `web` | `nginx:alpine` | **8080** | PWA estática servida desde `../public` |
| `sync-cron` | `node:20-alpine` | interno | Sincroniza Entra ID al arrancar y cada 6 horas |
| `db-backup` | `postgres:15-alpine` | interno | `pg_dump` diario en `./volumes/backups` con retención de 30 días |

## 1. Requisitos

- Docker Engine 24+ y Docker Compose v2.
- 4 GB RAM y 20 GB libres (los volúmenes crecen con los PDF).
- Acceso al servidor de Supabase actual para exportar la base (paso 3).

## 2. Configuración

```powershell
cd C:\Actas-Levapan\codigo\docker
Copy-Item .env.example .env
```

Edite `.env` y reemplace **todos** los valores `CAMBIAR_...`:

```env
POSTGRES_PASSWORD=ContraseñaSeguraLarga
JWT_SECRET=OtroSecretoAleatorioDeAlMenos32Caracteres
SITE_URL=http://IP_DEL_SERVIDOR:8080
```

Genere un `JWT_SECRET` aleatorio:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }) -as [byte[]])
```

> El mismo valor debe usarse en GoTrue, PostgREST y Storage. Si cambia, todas las sesiones quedan inválidas.

## 3. Migrar los datos actuales desde Supabase

En una máquina con `pg_dump` instalado (o dentro de un contenedor temporal de postgres 15):

```powershell
$env:PGPASSWORD="PASSWORD_DE_SUPABASE"
pg_dump -h zuzekclnefetsvuiyjzg.supabase.co -p 5432 -U postgres -d postgres `
  --no-owner --no-privileges --clean --if-exists -f migracion_supabase.sql
```

Luego copie el archivo a `docker/volumes-db-init/` y méntelo en el contenedor, o restáurelo **después** del primer arranque:

```powershell
docker compose exec -T db psql -U postgres -d postgres < migracion_supabase.sql
```

Si quiere empezar limpio, omita este paso: `init-db.sql` crea automáticamente las 5 tablas base, las 27 columnas, las espejos Entra/HP y la vista `vista_veredicto_360`.

## 4. Operación 24/7 (un solo comando)

Todos los servicios tienen `restart: unless-stopped` y `healthcheck`, por lo que se levantan solos tras un reinicio del servidor o de Docker y se reinician si fallan. Para iniciar **toda** la operación —incluidas la sincronización de Entra ID y los respaldos automáticos—:

```powershell
cd C:\Actas-Levapan\codigo\docker
docker compose up -d
```

Verifique el estado de **todos** los contenedores (los ocho servicios deben aparecer `Up` y `healthy`):

```powershell
docker compose ps
docker compose logs -f sync-cron
docker compose logs -f db-backup
```

### Sincronización automática de Entra ID

El servicio `sync-cron` ejecuta `sync-entra.mjs` **inmediatamente al arrancar** y luego **cada 6 horas**, sin intervención humana. Completa `sync_entra_dispositivos` con los ~3.992 dispositivos y cruza los ~3.860 usuarios de Microsoft Graph, alimentando el Veredicto 360°. Configure en `.env`:

```env
MS_TENANT_ID=CAMBIAR_TENANT_ID
MS_CLIENT_ID=CAMBIAR_CLIENT_ID
MS_CLIENT_SECRET=CAMBIAR_CLIENT_SECRET
SUPABASE_SERVICE_KEY=CAMBIAR_SERVICE_ROLE_JWT
```

La app de Azure necesita permisos de aplicación `Device.Read.All` y `User.Read.All` con consentimiento de administrador. El `service_role` se usa solo dentro de los contenedores, nunca en la PWA. Para ejecutar una sincronización manual:

```powershell
docker compose exec sync-cron node /app/sync-entra.mjs
```

### Respaldo automático

`db-backup` crea un `pg_dump` comprimido al arrancar y cada 24 horas en `./volumes/backups/`, y elimina los archivos con más de 30 días. Para restaurar:

```powershell
docker compose exec -T db pg_restore -U postgres -d postgres < .\volumes\backups\levapan_AAAAmmdd_HHMMSS.dump
```

El esquema se inicializa solo la **primera vez** que se crea `./volumes/db`. Si modifica `init-db.sql` después, borre ese volumen (¡esto elimina los datos!):

```powershell
docker compose down -v
docker compose up -d
```

## 5. Generar la anon key y apuntar la PWA al servidor

Con el `JWT_SECRET` del paso 2, genere un JWT con `role=anon`. En PowerShell:

```powershell
$secret = (Get-Content .env | Select-String '^JWT_SECRET=').Line.Split('=',2)[1]
$header = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}')).Replace('+','-').Replace('/','_').TrimEnd('=')
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('{"role":"anon","iss":"supabase","iat":1700000000,"exp":4102444800}')).Replace('+','-').Replace('/','_').TrimEnd('=')
$hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret))
$firma = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes("$header.$payload"))).Replace('+','-').Replace('/','_').TrimEnd('=')
"$header.$payload.$firma"
```

Copie el resultado en `SUPABASE_ANON_KEY` de `.env` y reemplace `public/js/config.js`:

```js
window.LEVAPAN_CONFIG = {
  supabaseUrl: "http://IP_DEL_SERVIDOR:8000",
  supabaseAnonKey: "EL_JWT_GENERADO",
  bucket: "boveda-ti",
};
```

Suba de nuevo el service worker: cambie la constante `CACHE` en `public/sw.js` a una versión nueva y refresque con **Ctrl + Shift + R**.

## 6. Crear el usuario administrador

1. Abra `http://IP_DEL_SERVIDOR:8080`.
2. Como `service_role` (o directamente en `psql`), cree el usuario en GoTrue desde el endpoint:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://IP_DEL_SERVIDOR:8000/auth/v1/admin/users" `
  -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $serviceRoleJwt" } `
  -ContentType "application/json" `
  -Body '{"email":"admin@levapan.com","password":"Macos.2025","email_confirm":true}'
```

3. Obtenga el `id` devuelto y regístrelo en la tabla corporativa:

```sql
insert into public.usuarios_corporativos (id, email, nombre_completo, rol, cedula, activo)
values ('UUID_DEVUELTO', 'admin@levapan.com', 'Harold Adrián Hurtado Moreno',
        'ADMINISTRADOR_TI', '1087778841', true)
on conflict (id) do update set rol = 'ADMINISTRADOR_TI', activo = true;
```

4. Ingrese en la PWA con `admin@levapan.com` / `Macos.2025`.

## 7. Verificación

```powershell
# API viva
Invoke-RestMethod "http://IP_DEL_SERVIDOR:8000/rest/v1/sistemas?select=count" `
  -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $anon" }

# Veredicto 360°
Invoke-RestMethod "http://IP_DEL_SERVIDOR:8000/rest/v1/vista_veredicto_360?select=placa,veredicto_estado&limit=5" `
  -Headers @{ "apikey" = $anon; "Authorization" = "Bearer $anon" }

# Bóveda de PDF
docker compose exec db psql -U postgres -c "select id, name, public from storage.buckets;"
```

Comprobación desde el navegador:

- El acta **CORP-TEC-FR-002** genera un PDF de **2 páginas** y se descarga sola.
- La píldora superior dice **SUPABASE EN VIVO**.
- El Asistente TI responde «mis equipos» con la sesión activa.
- En Administración TI aparece **Importar CSV HP WXP** y **Sincronizar Entra ID ahora**.

## 8. Operación y respaldo

```powershell
docker compose restart
docker compose logs -f --tail=100

# Respaldo físico de la base
docker compose exec db pg_dump -U postgres -Fc postgres > respaldo_levapan.dump

# Respaldo de los PDF
Copy-Item -Recurse .\volumes\storage .\respaldo_storage
```

## 9. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `permission denied for table equipos` | Roles no creados | Revise que `init-db.sql` se ejecutó; reinicie con `docker compose down -v && up -d` |
| Login responde 401 | `JWT_SECRET` distinto en los servicios | Unifique el valor en `.env` y ejecute `docker compose up -d --force-recreate` |
| CORS en consola | `SITE_URL` distinto al origen de la PWA | Ajuste `SITE_URL` y reinicie `kong` |
| El acta no descarga | `template.pdf` no accesible | Verifique `http://IP:8080/template.pdf` devuelve 200 |
| El Veredicto sale `SOLO_INVENTARIO` | Espejos vacíos | Importe el CSV HP WXP y verifique los logs de `sync-cron` |
| `sync-cron` sale `unhealthy` | Faltan credenciales de Graph o permisos de aplicación | Revise `MS_*` en `.env` y el consentimiento de administrador de `Device.Read.All` / `User.Read.All` |
| No aparecen respaldos | Volumen `./volumes/backups` sin permisos | `docker compose logs db-backup` y cree el directorio con permisos de escritura |

---

**Nota:** en on-premise el cron local `sync-entra.mjs` sustituye a la Edge Function `sync-telemetria-360` para Entra ID. La telemetría HP WXP se sigue cargando con el botón **Importar CSV HP WXP** de Administración TI (o con un `HP_WXP_API_KEY` opcional si se usa la Edge Function en la nube).
