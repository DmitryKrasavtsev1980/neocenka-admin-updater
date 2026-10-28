# wired-gate.ps1 — управление парсинг-профилями слота A (MegaFon) по наличию провода.
#
#   powershell -ExecutionPolicy Bypass -File wired-gate.ps1            # auto: провод есть → запустить, нет → остановить
#   powershell ... wired-gate.ps1 -Check        # только показать состояние
#   powershell ... wired-gate.ps1 -Start        # запустить (упирается на проверку провода)
#   powershell ... wired-gate.ps1 -Stop         # остановить профили слота A
#
# Провод = Ethernet 2 (192.168.1.94) — НЕ путать с 192.168.8.x модемов.
# Проверка: адаптер Up + IP + шлюз + curl --interface <ip> до api.ipify.org.
#
# Остановка — ТОЛЬКО по PID chrome-процессов профилей слота A (9228/9229).
# НЕ taskkill /IM chrome.exe — это убьёт все окна пользователя.
# Маршруты и метрики не трогает.

param(
  [switch]$Check,
  [switch]$Start,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }

# ── провод: ищем НЕ-модемный Ethernet с живым шлюзом ─────────────────────────
function Get-WiredInfo {
  $adapters = Get-NetIPConfiguration | Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and
    $_.IPv4Address -and
    $_.IPv4DefaultGateway -and
    $_.IPv4Address.IPAddress -notlike '192.168.8.*' -and   # это модемы
    $_.IPv4Address.IPAddress -notlike '127.*'
  }
  foreach ($a in $adapters) {
    $ip = $a.IPv4Address.IPAddress
    $egress = ''
    try { $egress = curl.exe -s --max-time 10 --interface $ip https://api.ipify.org } catch {}
    if ($egress -match '^\d+\.\d+\.\d+\.\d+$') {
      return @{ Up = $true; Alias = $a.InterfaceAlias; IP = $ip; Egress = $egress }
    }
  }
  return @{ Up = $false }
}

# ── профили слота A с requiresWired ─────────────────────────────────────────
$gated = @()
foreach ($s in $topo.slots) {
  foreach ($p in $s.profiles) {
    if ($p.requiresWired) {
      $gated += @{ Slot = $s; Profile = $p }
    }
  }
}

function Test-Port([int]$port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
}

function Stop-GatedProfile($item) {
  # Закрыть ТОЛЬКО chrome-процессы этого CDP-порта, по PID.
  $port = $item.Profile.cdpPort
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -match "--remote-debugging-port=$port" -and $_.CommandLine -notmatch '--type=' }
  foreach ($proc in $procs) {
    Say ("    стоп PID {0} (: {1} {2})" -f $proc.ProcessId, $port, $item.Profile.name) 'Yellow'
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if (-not $procs) { Say ("    :{0} и так не запущен" -f $port) 'DarkGray' }
}

# ── режимы ──────────────────────────────────────────────────────────────────
$wired = Get-WiredInfo

if ($Check) {
  if ($wired.Up) {
    Say ("провод: ЕСТЬ  {0} {1}  egress={2}" -f $wired.Alias, $wired.IP, $wired.Egress) 'Green'
  } else {
    Say 'провода НЕТ (или он не даёт интернет)' 'Yellow'
  }
  foreach ($item in $gated) {
    $alive = Test-Port $item.Profile.cdpPort
    Say ("  :{0}  {1,-16} {2}" -f $item.Profile.cdpPort, $item.Profile.name, $(if ($alive) { '[up]' } else { '[  ]' }))
  }
  return
}

if ($Stop) {
  Say 'останавливаю профили слота A...' 'Yellow'
  foreach ($item in $gated) { Stop-GatedProfile $item }
  return
}

# auto / -Start
if (-not $wired.Up) {
  Say 'провода нет — парсинг на MegaFon НЕ запускаю (модем остаётся каналом интернета ПК)' 'Yellow'
  $anyUp = $gated | Where-Object { Test-Port $_.Profile.cdpPort }
  if ($anyUp) {
    Say '  но профили слота A ещё работают — гашу, чтобы не грузить канал:' 'Yellow'
    foreach ($item in $anyUp) { Stop-GatedProfile $item }
  }
  return
}

Say ("провод есть ({0} {1}, egress={2}) — запускаю парсинг на MegaFon" -f $wired.Alias, $wired.IP, $wired.Egress) 'Green'
foreach ($item in $gated) {
  if (Test-Port $item.Profile.cdpPort) {
    Say ("  :{0}  {1} уже запущен" -f $item.Profile.cdpPort, $item.Profile.name) 'DarkGray'
    continue
  }
  & (Join-Path $root 'start-profile.ps1') -Name $item.Profile.name
}

Say ''
Say 'Готово. Проверить: wired-gate.ps1 -Check' 'Cyan'
