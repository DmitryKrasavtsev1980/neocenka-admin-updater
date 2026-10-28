# discover-modems.ps1 — найти текущие IP модемов и записать их в modem-topology.json.
#
# Ищем адаптеры НЕ по IP (он меняется после каждого ребута), а по
# usbInstanceId / mac / ifaceAlias — они стабильны.
#
# Запуск:
#   powershell -ExecutionPolicy Bypass -File discover-modems.ps1
#   powershell ... discover-modems.ps1 -DryRun      # только показать
#
# Скрипт НЕ трогает сеть, НЕ перезапускает процессы — только читает и пишет JSON.

param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

Write-Host "Топология: $topoPath" -ForegroundColor Cyan

# Все NDIS-адаптеры + их USB instance id
$adapters = Get-NetAdapter | Where-Object {
  $_.InterfaceDescription -match 'NDIS|HiLink|Huawei|Mobile'
}

function Get-UsbInstance([int]$ifIndex) {
  # Берём PnP-устройство по имени адаптера
  $name = (Get-NetAdapter -ifIndex $ifIndex).Name
  $pnp = Get-PnpDevice -PresentOnly | Where-Object {
    $_.FriendlyName -match 'NDIS' -and $_.InstanceId -match 'USB\\'
  }
  # Сопоставляем по порядку/описанию — точнее через Get-NetAdapterAdvancedProperty
  # Но для HiLink достаточно: каждый NDIS-адаптер ↔ один USB\VID_... instance.
  # Пробуем точное сопоставление через PnP-узел сетевого адаптера.
  $net = Get-PnpDevice -PresentOnly -Class Net | Where-Object {
    $_.FriendlyName -match 'NDIS'
  }
  foreach ($n in $net) {
    # Находим ifIndex этого PnP-устройства
    $prop = Get-PnpDeviceProperty -InstanceId $n.InstanceId -KeyName 'DEVPKEY_Device_NetCfgInstanceId' -ErrorAction SilentlyContinue
    if ($prop -and $prop.Data) {
      $guid = $prop.Data
      $na = Get-NetAdapter | Where-Object { $_.InterfaceGuid -eq $guid -or $_.Name -eq $name }
      if ($na) { return $n.InstanceId }
    }
  }
  return $null
}

Write-Host ''
Write-Host '--- найденные NDIS-адаптеры ---' -ForegroundColor Green
$rows = @()
foreach ($a in $adapters) {
  $ip = (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
  $usb = Get-UsbInstance $a.ifIndex
  $rows += [PSCustomObject]@{
    Alias  = $a.Name
    Mac    = $a.MacAddress
    Ip     = $ip
    Status = $a.Status
    Usb    = $usb
    ifIndex = $a.ifIndex
  }
}
$rows | Format-Table -AutoSize

# Сопоставляем со слотами
Write-Host '--- сопоставление со слотами ---' -ForegroundColor Green
$changed = $false
foreach ($s in $topo.slots) {
  $match = $rows | Where-Object {
    ($s.usbInstanceId -and $_.Usb -eq $s.usbInstanceId) -or
    ($s.mac -and $_.Mac -eq $s.mac) -or
    ($s.ifaceAlias -and $_.Alias -eq $s.ifaceAlias)
  } | Select-Object -First 1

  if (-not $match) {
    Write-Host ("  слот {0} ({1}) — НЕ НАЙДЕН" -f $s.slot, $s.label) -ForegroundColor Red
    continue
  }

  $old = $s.iface
  $new = $match.Ip
  $flag = if ($old -ne $new) { "  ← ИЗМЕНИЛСЯ (было $old)" } else { "" }
  $color = if ($old -ne $new) { 'Yellow' } else { 'Green' }
  Write-Host ("  слот {0} ({1}) → {2} [{3}]{4}" -f $s.slot, $s.label, $new, $match.Alias, $flag) -ForegroundColor $color

  if ($old -ne $new -and -not $DryRun) {
    $s.iface = $new
    $changed = $true
  }
}

if ($changed -and -not $DryRun) {
  $topo | ConvertTo-Json -Depth 10 | Set-Content -Path $topoPath -Encoding UTF8
  Write-Host ''
  Write-Host "Топология ОБНОВЛЕНА: $topoPath" -ForegroundColor Yellow
} elseif ($DryRun) {
  Write-Host ''
  Write-Host 'DryRun — ничего не записано.' -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host 'Все IP совпали, топология не менялась.' -ForegroundColor Green
}

# Проверка helper/proxy, если они уже запущены
Write-Host ''
Write-Host '--- helper/proxy сейчас ---' -ForegroundColor Green
foreach ($s in $topo.slots) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$($s.helperPort)/status" -TimeoutSec 3
    $ok = if ($r.iface -eq $s.iface) { 'OK' } else { "iface в конфиге $($s.iface), у процесса $($r.iface) — НУЖЕН ПЕРЕЗАПУСК" }
    Write-Host ("  helper :{0} slot={1} {2}" -f $s.helperPort, $r.slot, $ok) -ForegroundColor $(if ($ok -eq 'OK') { 'Green' } else { 'Yellow' })
  } catch {
    Write-Host ("  helper :{0} — не запущен" -f $s.helperPort) -ForegroundColor DarkGray
  }
}
