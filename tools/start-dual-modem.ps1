# Dual-modem: поднять хелперы смены IP и прокси для двух модемов.
# Запускать из Windows PowerShell (НЕ из WSL):
#   powershell -ExecutionPolicy Bypass -File C:\Projects\ret\admin-updater\tools\start-dual-modem.ps1
#
# Остановить: закрыть окна node, либо:
#   Get-Process node | Where-Object { $_.Path -like '*node*' } | Stop-Process
#   (аккуратно — если есть другие node-процессы, убивать по порту)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# IP адаптеров модемов (ipconfig, шлюз 192.168.8.1)
$IFACE_A = '192.168.8.103'   # модем A, MegaFon
$IFACE_B = '192.168.8.107'   # модем B, beeline

$helpers = Join-Path $root 'modem-hilink-helper'
$proxyDir = Join-Path $root 'modem-proxy'
$logDir = 'C:\Projects\ret\modem-tools'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Start-Node([string]$workdir, [string[]]$argv, [string]$logName) {
  $out = Join-Path $logDir "$logName.log"
  $err = Join-Path $logDir "$logName.err"
  Start-Process -FilePath 'node' -ArgumentList $argv -WorkingDirectory $workdir `
    -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
}

# ── хелперы смены IP (расширение стучится на 8891/8892) ──
Start-Node $helpers @('index.js', '--slot', 'A', '--iface', $IFACE_A, '--port', '8891') 'hilink-A'
Start-Node $helpers @('index.js', '--slot', 'B', '--iface', $IFACE_B, '--port', '8892') 'hilink-B'

# ── прокси для Chrome (8881 = модем A, 8882 = модем B) ──
Start-Node $proxyDir @('proxy.js', '--port', '8881', '--iface', $IFACE_A) 'proxy-A'
Start-Node $proxyDir @('proxy.js', '--port', '8882', '--iface', $IFACE_B) 'proxy-B'

Start-Sleep -Seconds 2

Write-Host 'Проверка:' -ForegroundColor Green
foreach ($p in @(8891, 8892)) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$p/status" -TimeoutSec 5
    Write-Host ("  helper :{0} → {1} iface={2}" -f $p, $r.slot, $r.iface)
  } catch { Write-Host "  helper :$p — НЕ отвечает" -ForegroundColor Red }
}

Write-Host ''
Write-Host 'IP через прокси (должны быть разные!):' -ForegroundColor Green
foreach ($p in @(8881, 8882)) {
  $ip = curl.exe -s --max-time 15 -x "http://127.0.0.1:$p" https://api.ipify.org
  Write-Host ("  proxy :{0} → {1}" -f $p, $ip)
}

Write-Host ''
Write-Host 'Дальше — запуск Chrome с прокси и расширением, см. tools/modem-hilink-helper/README.md' -ForegroundColor Yellow
