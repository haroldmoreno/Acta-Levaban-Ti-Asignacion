# Inventario y base de datos · Acta de Tecnología Levapan

La aplicación funciona con **Node.js + SQLite**:

- Base de datos: `C:\Actas-Levapan\database\inventario.db`
- Actas PDF: `C:\Actas-Levapan\Actas_Guardadas\AAAA\MM-Mes\`
- Inventario fuente: `data/inventario.ods` (1.577 equipos)

## Arranque diario

Doble clic en `C:\Actas-Levapan\iniciar.bat`.

El servidor escucha en `0.0.0.0:3000`; la consola muestra la IP local para
compartir el enlace con la oficina, por ejemplo `http://192.168.1.50:3000`.

> La primera vez que se comparte el enlace, Windows puede pedir permiso para
> permitir Node.js en la red privada. Acepta el aviso del firewall.

## Actualizar el inventario desde Excel/ODS

```powershell
cd C:\Actas-Levapan\codigo
npm run importar
```

También se puede indicar otro archivo `.ods`, `.xlsx`, `.xls`, `.csv` o `.json`:

```powershell
node tools/importar-inventario.js "C:\ruta\al\inventario.xlsx"
```

La importación es idempotente: actualiza los equipos existentes por Placa. Si
un equipo ya tiene actas registradas, **conserva** el estado, el responsable y
la cédula que la aplicación guardó, para no borrar el trabajo hecho.

## Qué hace cada acta

- **Asignación**: guarda el PDF, registra el acta en `historial_actas`, cambia
  el estado del equipo a `Asignado` y actualiza `usuario_actual`,
  `cedula_usuario` y los accesorios entregados.
- **Devolución**: guarda el PDF, registra el acta, cambia el estado a
  `Disponible` y limpia el usuario y la cédula.

## Estructura

```
C:\Actas-Levapan\
  iniciar.bat
  database\inventario.db
  Actas_Guardadas\2026\11-Noviembre\...
  codigo\
    index.html
    css\style.css
    js\inventario-storage.js
    server.js
    server\db.js
    tools\importar-inventario.js
    data\inventario.ods
```

## Respaldo

Copia periódicamente:

- `C:\Actas-Levapan\database\inventario.db`
- `C:\Actas-Levapan\Actas_Guardadas`

Con el servidor detenido, copiar esos dos elementos es suficiente para
conservar el inventario, el historial y todas las actas.
