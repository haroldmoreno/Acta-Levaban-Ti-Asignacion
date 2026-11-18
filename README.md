# Acta de Tecnología · Levapan

Aplicación web instalable (PWA) para registrar la entrega, devolución y préstamo de
equipos de tecnología. El inventario vive en una **Lista de SharePoint** (Microsoft
Graph) y los PDFs se guardan en SharePoint mediante **Power Automate**. El servidor
local ya no usa base de datos ni escribe archivos en disco.

## Requisitos

- Windows 10/11
- Node.js 24 o superior
- Chrome o Edge para instalar la app
- Una App registration en Microsoft Entra ID con permiso de aplicación
  `Sites.Read.All` (o `Sites.ReadWrite.All`) sobre Microsoft Graph, con consentimiento
  del administrador
- Un flujo de Power Automate con desencadenador HTTP

## Configuración de Microsoft 365

1. Copia `.env.example` como `.env` en `C:\Actas-Levapan\codigo`.
2. Completa las variables:

| Variable | Descripción |
| --- | --- |
| `TENANT_ID` | Directorio (tenant) de Entra ID |
| `CLIENT_ID` | ID de la App registration |
| `CLIENT_SECRET` | Secreto de la App registration |
| `SESSION_SECRET` | Clave aleatoria para firmar la cookie de sesión (8 h) |
| `REDIRECT_URI` | URI de callback registrada en Entra ID (opcional; si falta se deduce del host) |
| `SITE_ID` | ID del sitio de SharePoint |
| `SHAREPOINT_LIST_ID` | Nombre o ID de la lista de inventario (`Inventario` por defecto) |
| `HTTP_WEBHOOK_URL` | URL del desencadenador HTTP de Power Automate |

Formatos válidos de `SITE_ID`:

```
levapan.sharepoint.com,<siteCollectionId>,<webId>
levapan.sharepoint.com:/sites/NombreDelSitio
```

### Inicio de sesión (SSO con Entra ID)

Toda la aplicación (HTML, `/js/*` y `/api/*`) exige una cuenta corporativa de
Levapan con MFA. La sesión se guarda en una cookie firmada `HttpOnly`,
`SameSite=Lax`, válida 8 horas. `/api/health` queda abierto para monitoreo.

En **Entra ID → App registrations → tu aplicación → Authentication** agrega
estas URI de redirección de tipo **Web** (no "Single-page application"):

```
http://localhost:3000/auth/callback
http://localhost:3000/
https://acta-levapan-ti.onrender.com/auth/callback
https://acta-levapan-ti.onrender.com/
```

Las dos terminadas en `/` permiten que el cierre de sesión regrese a la app.
El permiso delegado `User.Read` debe tener consentimiento del administrador.

Genera `SESSION_SECRET` una sola vez y cópiala a Render/Azure:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`REDIRECT_URI` puede quedar vacía: el servidor usa
`X-Forwarded-Proto`/`Host` para construir `https://<host>/auth/callback`, lo que
funciona igual en localhost, en un túnel HTTPS y detrás de Render o Azure.

### Lista de inventario

La placa debe estar en la columna **Title** (columna interna `Title`). El resto de
columnas se reconocen por nombre, sin distinguir mayúsculas, tildes ni guiones:
`Serial`, `Tipo`, `Marca`, `Modelo`, `Estado`, `Usuario`, `Cedula`, `Accesorios`,
`Software`, `Procesador`, `RAM`, `Disco`, `Hostname` y `Observaciones`.

### Flujo de Power Automate

El flujo recibe un `POST` con este cuerpo:

```json
{
  "origen": "acta-levapan",
  "nombreArchivo": "ACTA_ML-217050_Harold_Moreno_20261113-143512.pdf",
  "archivoBase64": "<PDF en base64>",
  "contentType": "application/pdf",
  "carpeta": "2026/11-Noviembre",
  "placa": "ML-217050",
  "tipoActa": "Asignación",
  "fecha": "2026-11-13T14:35:12.000Z",
  "colaborador": "Harold Moreno",
  "documento": "1087778841",
  "agenteTi": "Harold Moreno",
  "documentoTi": "1087778841",
  "equipo": { "tipo": "CPU", "marca": "HP", "modelo": "ProDesk 400 G9", "serial": "..." },
  "observaciones": ""
}
```

En el flujo: **Cuando se recibe una solicitud HTTP** → decodificar
`archivoBase64` → **Crear archivo** en la biblioteca de SharePoint usando
`carpeta` y `nombreArchivo`. Si la respuesta incluye `webUrl`, `ruta` o `url`, el
servidor la devuelve al frontend para mostrarla.

El servidor reintenta hasta 3 veces ante cortes de red, `429` y errores `5xx`.

## Inicio rápido

1. Doble clic en `C:\Actas-Levapan\iniciar.bat`.
2. Se abre el navegador en `http://localhost:3000`.
3. Deja la ventana de la consola abierta mientras uses la aplicación.

También puedes iniciar manualmente:

```powershell
cd C:\Actas-Levapan\codigo
npm install
npm start
```

Si faltan credenciales, el servidor arranca igual y muestra las variables pendientes;
las rutas de inventario responden `503` con un mensaje claro (no se cae el proceso).

## Instalar como aplicación

En Chrome o Edge, con la app abierta en `http://localhost:3000`:

- Pulsa el botón **Instalar App** de la cabecera, o
- Usa el icono de instalar de la barra de direcciones.

> El Service Worker solo se activa en contexto seguro: `localhost`, `127.0.0.1` o HTTPS.
> Si abres la app por `http://192.168.x.x:3000` en otro equipo funciona como web normal,
> pero el navegador no ofrecerá la instalación.

### Sin conexión

El Service Worker guarda el código de la app, así que la interfaz abre aunque no haya
red. Consultar SharePoint y guardar actas sí requieren internet. Si la API no responde,
la búsqueda usa el respaldo `data/inventario.json` cuando existe.

## Generación del PDF oficial

Al pulsar **Generar y Guardar / Enviar**, el navegador envía los datos, las fotos
comprimidas y las firmas a `POST /api/actas/guardar` (también se acepta
`/api/guardar-acta` por compatibilidad). El servidor abre `template.pdf` con
`pdf-lib`, estampa la información sobre las dos páginas del formato
**CORP-TEC-FR-002**, marca las casillas con una X y convierte el PDF a base64.

El PDF **no se escribe en el servidor**: se envía a `HTTP_WEBHOOK_URL` para que Power
Automate lo guarde en SharePoint. Cada archivo recibe un sello
`_AAAAMMDD-HHmmss` para evitar sobrescrituras.

## Agentes TI autorizados

El selector incluye a Harold Moreno (CC 1087778841), Wilson Perez y Michel
Salazar. La cédula de Harold se precarga; las de Wilson y Michel quedan
editables y se recuerdan en el equipo después de ingresarlas.

## Búsqueda por placa

En el campo **Placa**, escribe al menos dos caracteres (por ejemplo `ML-`) y aparece una
lista con las coincidencias del inventario:

```
ML-217067 — CPU HP ProDesk 400 G9 (Serial: 8CC5030J0J)
```

La consulta la resuelve Microsoft Graph mediante
`GET /api/equipos/buscar?q=ML-`, con el filtro
`startswith(fields/Title, 'ML-')` sobre la Lista de SharePoint (máximo 30 resultados).

La búsqueda exacta (`GET /api/equipos?placa=...`) usa `fields/Title eq '...'` y, si no
hay coincidencia, compara las placas ignorando espacios, guiones y puntos.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/api/health` | Salud mínima del servicio (sin datos, público) |
| `GET` | `/api/me` | Usuario autenticado (`{ name, email }`) |
| `GET` | `/api/estado` | Estado del servicio, total de equipos y configuración |
| `GET` | `/api/equipos/buscar?q=` | Coincidencias por prefijo de placa |
| `GET` | `/api/equipos?placa=` | Equipo exacto por placa |
| `POST` | `/api/actas/guardar` | Genera el PDF y lo publica en Power Automate |
| `GET` | `/api/historial` | `501`: el historial ahora vive en SharePoint |

Todas las rutas de la API (excepto `/api/health`) responden `401` sin sesión
válida. El navegador envía la cookie `HttpOnly` firmada automáticamente.

## Publicar en internet

Para usar la app desde fuera de la oficina sin abrir puertos en el router:

1. Doble clic en `publicar.bat`.
2. Copia el enlace `https://....trycloudflare.com` que muestra la consola.

El acceso exige iniciar sesión con una cuenta corporativa de Levapan (Entra ID
con MFA); sin sesión, el formulario redirige a Microsoft y la API responde `401`.
El equipo debe quedar encendido y con internet, y la URL gratuita cambia cada vez
que se reinicia el túnel (registra la nueva URI de callback en Entra ID o usa la
URL fija de Render).

## Estructura

```
server.js                 Servidor HTTP, API y archivos estáticos
server/config.js          Carga de .env (sin dotenv)
server/graph.js           MSAL Client Credentials + consultas a SharePoint
server/acta-pdf.js        PDF oficial CORP-TEC-FR-002 con pdf-lib
sw.js                     Service Worker (caché y modo sin conexión)
manifest.json             Configuración de la app instalable
js/inventario-storage.js  Autocompletado, envío al servidor y sincronización
js/pwa.js                 Registro del Service Worker y botón Instalar
js/firmas.js              Firmas en canvas
icons/                    Iconos PWA generados desde el .ico
images/                   Logo y recursos visuales
```

`server/db.js` y `tools/importar-inventario.js` quedan como legado de la versión SQLite
y ya no se usan desde `server.js`.
