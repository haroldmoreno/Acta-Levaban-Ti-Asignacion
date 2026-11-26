#!/usr/bin/env bash
# ============================================================
# auto-inventario-unix.sh · Levapan TI (macOS / Linux)
# Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno
# (o en un .env junto al script). UPSERT seguro por serial/nombre_red.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then set -a; source "$SCRIPT_DIR/.env"; set +a; fi

: "${SUPABASE_URL:?Falta SUPABASE_URL}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Falta SUPABASE_SERVICE_ROLE_KEY}"

URL="${SUPABASE_URL%/}"
KEY="$SUPABASE_SERVICE_ROLE_KEY"
AUTH="apikey: $KEY"
AUTH2="Authorization: Bearer $KEY"

if [ "$(uname)" = "Darwin" ]; then
  NOMBRE_RED="$(scutil --get ComputerName 2>/dev/null || hostname)"
  SERIAL="$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Serial Number/{print $2; exit}')"
  MARCA="Apple"
  MODELO="$(sysctl -n hw.model 2>/dev/null || echo 'Mac')"
  CPU="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '')"
  RAM="$(system_profiler SPHardwareDataType 2>/dev/null | awk -F': ' '/Memory:/{print $2; exit}')"
  DISCO="$(df -h / | awk 'NR==2{print $2}')"
else
  NOMBRE_RED="$(hostname)"
  SERIAL="$(sudo -n dmidecode -s system-serial-number 2>/dev/null || cat /sys/class/dmi/id/product_serial 2>/dev/null || echo '')"
  MARCA="$(sudo -n dmidecode -s system-manufacturer 2>/dev/null || cat /sys/class/dmi/id/sys_vendor 2>/dev/null || echo '')"
  MODELO="$(sudo -n dmidecode -s system-product-name 2>/dev/null || cat /sys/class/dmi/id/product_name 2>/dev/null || echo '')"
  CPU="$(lscpu 2>/dev/null | awk -F': ' '/Model name/{print $2; exit}')"
  RAM="$(free -h 2>/dev/null | awk '/^Mem:/{print $2}')"
  DISCO="$(df -h / | awk 'NR==2{print $2}')"
fi

USUARIO="${USER:-desconocido}"
NOW="$(date '+%Y-%m-%d %H:%M')"

LEER="$(curl -sS -H "$AUTH" -H "$AUTH2" \
  --get --data-urlencode "select=*" \
  --data-urlencode "or=(serial.ilike.*${SERIAL}*,nombre_red.ilike.*${NOMBRE_RED}*)" \
  "$URL/rest/v1/equipos")"

PAYLOAD="$(python3 - "$LEER" "$NOMBRE_RED" "$SERIAL" "$MARCA" "$MODELO" "$CPU" "$RAM" "$DISCO" "$USUARIO" "$NOW" <<'PY'
import json, sys
anterior = json.loads(sys.argv[1]) or []
registro = dict(anterior[0]) if anterior else {}
nuevos = {
  "nombre_red": sys.argv[2], "serial": sys.argv[3], "marca": sys.argv[4],
  "modelo": sys.argv[5], "procesador": sys.argv[6], "ram": sys.argv[7],
  "disco": sys.argv[8],
  "modificado_por": f"auto-inventario-unix/{sys.argv[9]}",
  "bitacora": f"Inventario automático {sys.argv[10]} · usuario {sys.argv[9]}",
}
for clave, valor in nuevos.items():
    if valor and str(valor).strip():
        registro[clave] = valor
print(json.dumps([registro], ensure_ascii=False))
PY
)"

curl -sS -X POST -H "$AUTH" -H "$AUTH2" -H 'Content-Type: application/json' -H 'Prefer: resolution=merge-duplicates,return=representation' \
  --data "$PAYLOAD" "$URL/rest/v1/equipos?on_conflict=serial" >/dev/null

echo "Auto-inventario OK: $NOMBRE_RED / $SERIAL"
