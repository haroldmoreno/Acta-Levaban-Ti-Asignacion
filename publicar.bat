@echo off
chcp 65001 >nul
title Acta Levapan - Publicar en Internet
cd /d "%~dp0codigo"

echo.
echo ============================================================
echo   ACTA DE TECNOLOGIA - LEVAPAN
echo   Publicar la aplicacion en internet con Cloudflare Tunnel
echo ============================================================
echo.

if not exist ".env" (
  echo ERROR: falta el archivo .env con la contrasena ACTA_CLAVE.
  echo Copia .env.example como .env y define una clave.
  echo.
  pause
  exit /b 1
)

if not exist "C:\Actas-Levapan\tools\cloudflared.exe" (
  echo ERROR: no se encontro C:\Actas-Levapan\tools\cloudflared.exe
  echo Descargalo desde https://github.com/cloudflare/cloudflared/releases
  echo.
  pause
  exit /b 1
)

echo Iniciando el servidor y el tunel...
echo Deja esta ventana abierta mientras quieras mantener el enlace publico.
echo Para cerrar el acceso publico presiona Ctrl+C.
echo.

start "Servidor Acta Levapan" cmd /c "node server.js"
timeout /t 2 >nul

echo.
echo ------------------------------------------------------------
echo  Copia el enlace https://....trycloudflare.com que aparece abajo.
echo  Ese es el enlace publico de la aplicacion.
echo  Usuario: TI   Contrasena: la definida en .env
echo ------------------------------------------------------------
echo.

"C:\Actas-Levapan\tools\cloudflared.exe" tunnel --url http://localhost:3000

echo.
echo El tunel se detuvo.
pause
