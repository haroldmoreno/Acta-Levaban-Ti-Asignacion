# Acta de Tecnología · Levapan

Aplicación web instalable (PWA) para registrar la entrega, devolución y préstamo de
equipos de tecnología, con inventario en SQLite, generación de PDF e historial de actas.

## Requisitos

- Windows 10/11
- Node.js 24 o superior (`node:sqlite` es obligatorio)
- Chrome o Edge para instalar la app

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

## Instalar como aplicación

En Chrome o Edge, con la app abierta en `http://localhost:3000`:

- Pulsa el botón **Instalar App** de la cabecera, o
- Usa el icono de instalar de la barra de direcciones.

Queda como una app con su propio icono, ventana independiente y accesible desde el menú
Inicio. El logo de la aplicación está en `images/ico-levadesk.ico` y los iconos generados
en `icons/`.

> El Service Worker solo se activa en contexto seguro: `localhost`, `127.0.0.1` o HTTPS.
> Si abres la app por `http://192.168.x.x:3000` en otro equipo funciona como web normal,
> pero el navegador no ofrecerá la instalación.

### Sin conexión

El Service Worker guarda el código de la app, así que la interfaz abre aunque no haya red.
Los datos (inventario, actas, guardado de PDF) sí necesitan el servidor local encendido.

## Datos y archivos

| Qué | Dónde |
| --- | --- |
| Inventario (SQLite) | `C:\Actas-Levapan\database\inventario.db` |
| PDFs de actas | `C:\Actas-Levapan\Actas_Guardadas\AAAA\MM-Mes\` |
| Historial de actas | tabla `historial_actas` de la misma base |
| Inventario de respaldo | `data/inventario.json` |

## Importar el inventario

```powershell
npm run importar -- "ruta\al\inventario.ods"
```

Acepta ODS, Excel, CSV y JSON. La reimportación conserva estado, responsable y cédula de
los equipos que ya tienen actas registradas.

## Estructura

```
server.js                 Servidor HTTP, API y archivos estáticos
sw.js                     Service Worker (caché y modo sin conexión)
manifest.webmanifest      Configuración de la app instalable
server/db.js              Esquema SQLite, actas e historial
js/inventario-storage.js  Autocompletado, PDF y sincronización con la API
js/pwa.js                 Registro del Service Worker y botón Instalar
js/firmas.js              Firmas en canvas
icons/                    Iconos PWA generados desde el .ico
images/                   Logo y recursos visuales
tools/importar-inventario.js  Importador de inventario
```
