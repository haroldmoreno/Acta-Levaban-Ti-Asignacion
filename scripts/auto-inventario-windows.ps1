<# ============================================================
   auto-inventario-windows.ps1 · Levapan TI
   Despliegue silencioso por GPO / Intune / MDM.
   Requiere variables de entorno:
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   El UPSERT nunca sobrescribe placa, ceco, contrato ni campos
   administrativos ya existentes en Supabase.
   ============================================================ #>

$ErrorActionPreference = "Stop"

$url = $env:SUPABASE_URL
$key = $env:SUPABASE_SERVICE_ROLE_KEY
if (-not $url -or -not $key) { throw "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" }

$headers = @{
  "apikey" = $key
  "Authorization" = "Bearer $key"
  "Content-Type" = "application/json"
  "Accept" = "application/json"
}

$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
$ramGb = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)

$nombreRed = $env:COMPUTERNAME
$serial = ($bios.SerialNumber ?? "").Trim()
$marca = ($cs.Manufacturer ?? "").Trim()
$modelo = ($cs.Model ?? "").Trim()
$procesador = ($cpu.Name ?? "").Trim()
$usuario = ($env:USERNAME ?? "").Trim()

$datos = @{
  nombre_red = $nombreRed
  serial = $serial
  marca = $marca
  modelo = $modelo
  procesador = $procesador
  ram = "$ramGb GB"
  disco = if ($disk) { "$([math]::Round($disk.Size / 1GB, 0)) GB" } else { "" }
  modificado_por = "auto-inventario-windows/$usuario"
  bitacora = "Inventario automático $(Get-Date -Format 'yyyy-MM-dd HH:mm') · usuario $usuario"
}

# Buscar registro previo por serial o nombre_red (sin sobrescribir administrativos).
$uri = "$url/rest/v1/equipos?select=*&or=(serial.ilike.*$serial*,nombre_red.ilike.*$nombreRed*)"
$anterior = @(Invoke-RestMethod -Uri $uri -Headers $headers -Method Get)[0]

$registro = @{}
if ($anterior) {
  $registro = @{}
  $anterior.PSObject.Properties | ForEach-Object { $registro[$_.Name] = $_.Value }
}

# Solo campos de hardware con valor real.
foreach ($campo in @("nombre_red","serial","marca","modelo","procesador","ram","disco","modificado_por","bitacora")) {
  if (-not [string]::IsNullOrWhiteSpace([string]$datos[$campo])) { $registro[$campo] = $datos[$campo] }
}

# Clasificación básica de ecosistema si no existe sistema_id.
if (-not $registro["sistema_id"]) {
  $texto = "$marca $modelo $nombreRed".ToLower()
  if ($texto -match "switch|server|ups|router") { $codigo = "REDES-SRV" }
  elseif ($texto -match "handheld|zebra|impresora") { $codigo = "INFRA-PLANTA" }
  elseif ($texto -match "pos|caja") { $codigo = "POS-CAJAS" }
  elseif ($texto -match "latitude|elitebook|thinkpad|optiplex") { $codigo = "M365" }
  else { $codigo = $null }
  if ($codigo) {
    $sis = @(Invoke-RestMethod -Uri "$url/rest/v1/sistemas?select=id&codigo=eq.$codigo" -Headers $headers -Method Get)[0]
    if ($sis) { $registro["sistema_id"] = $sis.id }
  }
}

$body = ConvertTo-Json -InputObject @($registro) -Depth 6
$upsert = Invoke-RestMethod -Uri "$url/rest/v1/equipos?on_conflict=serial" -Headers $headers -Method Post -Body $body
Write-Host "Auto-inventario OK: $nombreRed / $serial"
