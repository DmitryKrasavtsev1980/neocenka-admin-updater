# Поднять helper'ы, прокси и Chrome-профили по tools/modem-topology.json.
#
# Запускать из Windows PowerShell (НЕ из WSL):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\ret\admin-updater\tools\start-modems.ps1
#
# Добавил модем — дописал секцию в modem-topology.json и снова запустил.
# Код трогать не нужно.
#
# Расширение после запуска грузить через CDP Extensions.loadUnpacked
# (Chrome 137+ игнорирует --load-extension), путь из topology.extensionDist,
# БЕЗ trailing backslash. См. tools/apply-topology.js — он же пропишет source.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

$logDir = 'C:\Projects\ret\modem-tools'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$helpers = Join-Path $root 'modem-hilink-helper'
$proxyDir = Join-Path $root 'modem-proxy'

function Start-Node([string]$workdir, [string[]]$argv, [string]$logName) {
  $out = Join-Path $logDir "$logName.log"
  $err = Join-Path $logDir "$logName.err"
  Start-Process -FilePath 'node' -ArgumentList $argv -WorkingDirectory $workdir `
    -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
}

function Test-Port([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $c.Close()
    return $true
  } catch { return $false }
}

Write-Host "Топология: $topoPath" -ForegroundColor Cyan
Write-Host "Слотов: $($topo.slots.Count)" -ForegroundColor Cyan

# ── helper + proxy по каждому слоту ──
foreach ($s in $topo.slots) {
  Write-Host ""
  Write-Host "── слот $($s.slot) iface=$($s.iface) helper=$($s.helperPort) proxy=$($s.proxyPort)" -ForegroundColor Green

  if (Test-Port $s.helperPort) {
    Write-Host "  helper :$($s.helperPort) уже слушает — не перезапускаем" -ForegroundColor Yellow
  } else {
    Start-Node $helpers @('index.js', '--slot', $s.slot, '--iface', $s.iface, '--port', [string]$s.helperPort) "hilink-$($s.slot)"
    Write-Host "  helper :$($s.helperPort) запущен"
  }

  if (Test-Port $s.proxyPort) {
    Write-Host "  proxy  :$($s.proxyPort) уже слушает — не перезапускаем" -ForegroundColor Yellow
  } else {
    Start-Node $proxyDir @('proxy.js', '--port', [string]$s.proxyPort, '--iface', $s.iface) "proxy-$($s.slot)"
    Write-Host "  proxy  :$($s.proxyPort) запущен"
  }
}

# ── Chrome по профилям ──
Write-Host ""
Write-Host "── Chrome" -ForegroundColor Green
foreach ($s in $topo.slots) {
  foreach ($p in $s.profiles) {
    if (Test-Port $p.cdpPort) {
      Write-Host "  :$($p.cdpPort) $($p.name) уже запущен (CDP жив) — пропускаем" -ForegroundColor Yellow
      continue
    }
    $args = @(
      "--remote-debugging-port=$($p.cdpPort)",
      "--user-data-dir=$($p.userDataDir)",
      "--proxy-server=127.0.0.1:$($s.proxyPort)",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check"
    )
    Start-Process -FilePath $topo.chromeExe -ArgumentList $args
    Write-Host "  :$($p.cdpPort) $($p.name) → proxy $($s.proxyPort) (слот $($s.slot)) source=$($p.source)"
  }
}

Start-Sleep -Seconds 3

# ── проверка ──
Write-Host ""
Write-Host "Проверка helper:" -ForegroundColor Green
foreach ($s in $topo.slots) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$($s.helperPort)/status" -TimeoutSec 5
    Write-Host ("  helper :{0} → slot={1} iface={2}" -f $s.helperPort, $r.slot, $r.iface)
  } catch { Write-Host "  helper :$($s.helperPort) — НЕ отвечает" -ForegroundColor Red }
}

Write-Host ""
Write-Host "IP через прокси (должны быть разными!):" -ForegroundColor Green
foreach ($s in $topo.slots) {
  $ip = curl.exe -s --max-time 15 -x "http://127.0.0.1:$($s.proxyPort)" https://api.ipify.org
  Write-Host ("  proxy :{0} (слот {1}) → {2}" -f $s.proxyPort, $s.slot, $ip)
}

Write-Host ""
Write-Host "Дальше:" -ForegroundColor Yellow
Write-Host "  1) node C:\Projects\ret\admin-updater\tools\apply-topology.js   # source/modemSlot в профили"
Write-Host "  2) Extensions.loadUnpacked → $($topo.extensionDist)  (БЕЗ trailing backslash)"
Write-Host "  3) START из popup каждого профиля"
