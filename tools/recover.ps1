# recover.ps1 — последовательное восстановление парсинга после ребута/сбоя.
#
# Делает всё по порядку:
#   1. Находит модемы по USB-id и пишет актуальные IP в топологию;
#   2. Поднимает helper (смена IP) и proxy (трафик Chrome) на каждый слот;
#   3. Запускает Chrome-профили с правильным proxy и user-data-dir;
#   4. Грузит расширение через CDP Extensions.loadUnpacked (Chrome 137+);
#   5. Запускает popup и жмёт START;
#   6. Проверяет авторизацию на avito/cian и пишет отчёт.
#
# Запуск (из Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -File recover.ps1
#   powershell ... recover.ps1 -Check          # только отчёт, ничего не менять
#   powershell ... recover.ps1 -Slot A         # только один слот
#   powershell ... recover.ps1 -NoChrome       # только helper/proxy
#   powershell ... recover.ps1 -NoExtension    # не трогать расширение
#
# НЕ трогает: маршруты, сетевые настройки, роутер, уже рабочие процессы.

param(
  [switch]$Check,
  [string]$Slot,
  [switch]$NoChrome,
  [switch]$NoExtension
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

$EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil'
$EXT_PATH = $topo.extensionDist

function Say($msg, $color = 'White') { Write-Host $msg -ForegroundColor $color }
function Header($msg) { Write-Host ''; Write-Host "── $msg " -ForegroundColor Cyan; Write-Host ('─' * 60) -ForegroundColor DarkGray }

function Test-Port([int]$port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
}

function Start-NodeProc([string]$workdir, [string[]]$argv, [string]$logName) {
  $logDir = $topo.logDir
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process -FilePath 'node' -ArgumentList $argv -WorkingDirectory $workdir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$logName.log") `
    -RedirectStandardError  (Join-Path $logDir "$logName.err")
}

# ─────────────────────────────────────────────────────────────────
Header "1/6  Модемы: ищу актуальные IP"

& (Join-Path $root 'discover-modems.ps1') -DryRun:$Check | Out-Host
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json   # перечитать после discover

if ($Check) {
  Header "ПРОВЕРКА (-Check) — дальше ничего не делаю"
}

# ─────────────────────────────────────────────────────────────────
if (-not $Check) {
  Header "2/6  Helper + proxy по слотам"

  foreach ($s in $topo.slots) {
    if ($Slot -and $s.slot -ne $Slot) { continue }

    Say ("  слот {0}  iface={1}  helper=:{2}  proxy=:{3}" -f $s.slot, $s.iface, $s.helperPort, $s.proxyPort) 'Green'

    if (Test-Port $s.helperPort) {
      Say "    helper уже слушает — пропускаю (не перезапускаю рабочий)" 'DarkGray'
    } else {
      Start-NodeProc $topo.helperDir @('index.js', '--slot', $s.slot, '--iface', $s.iface, '--port', [string]$s.helperPort, '--host', $topo.modemHost) "hilink-$($s.slot)"
      Say "    helper запущен" 'Green'
    }

    if (Test-Port $s.proxyPort) {
      Say "    proxy уже слушает — пропускаю" 'DarkGray'
    } else {
      Start-NodeProc $topo.proxyDir @('proxy.js', '--port', [string]$s.proxyPort, '--iface', $s.iface) "proxy-$($s.slot)"
      Say "    proxy запущен" 'Green'
    }
  }
}

# ─────────────────────────────────────────────────────────────────
if (-not $Check -and -not $NoChrome) {
  Header "3/6  Chrome-профили"

  foreach ($s in $topo.slots) {
    if ($Slot -and $s.slot -ne $Slot) { continue }
    foreach ($p in $s.profiles) {
      # requiresWired: запускаем только при живом проводе (см. wired-gate.ps1)
      if ($p.requiresWired) {
        $wiredUp = $false
        foreach ($a in (Get-NetIPConfiguration | Where-Object {
            $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway -and
            $_.IPv4Address.IPAddress -notlike '192.168.8.*' -and $_.IPv4Address.IPAddress -notlike '127.*' })) {
          try { $e = curl.exe -s --max-time 10 --interface $a.IPv4Address.IPAddress https://api.ipify.org } catch { $e = '' }
          if ($e -match '^\d+\.\d+\.\d+\.\d+$') { $wiredUp = $true; break }
        }
        if (-not $wiredUp) {
          Say ("  :{0}  {1} — requiresWired, провода нет — пропускаю" -f $p.cdpPort, $p.name) 'Yellow'
          continue
        }
      }
      if (Test-Port $p.cdpPort) {
        Say ("  :{0}  {1} — уже запущен, пропускаю" -f $p.cdpPort, $p.name) 'DarkGray'
        continue
      }
      # Табличка-подпись профиля: чтобы окно Chrome было понятно с первого взгляда
      $labelFile = (Join-Path $root 'profile-label.html') -replace '\\','/'
      $labelUrl = 'file:///' + $labelFile +
        '#name=' + [uri]::EscapeDataString($p.name) +
        '&source=' + [uri]::EscapeDataString($p.source) +
        '&slot=' + [uri]::EscapeDataString("$($s.slot) / $($s.label)") +
        '&proxy=' + [uri]::EscapeDataString("127.0.0.1:$($s.proxyPort)") +
        '&cdp=' + [uri]::EscapeDataString([string]$p.cdpPort) +
        '&dir=' + [uri]::EscapeDataString($p.userDataDir) +
        '&auth=' + [uri]::EscapeDataString($(if ($s.authorizedSources -and $s.authorizedSources.Count) { $s.authorizedSources -join ', ' } else { 'нет' }))

      $args = @(
        "--remote-debugging-port=$($p.cdpPort)",
        "--user-data-dir=$($p.userDataDir)",
        "--proxy-server=127.0.0.1:$($s.proxyPort)",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--no-default-browser-check",
        $labelUrl
      )
      Start-Process -FilePath $topo.chromeExe -ArgumentList $args
      Say ("  :{0}  {1} → proxy {2} (слот {3}) source={4}" -f $p.cdpPort, $p.name, $s.proxyPort, $s.slot, $p.source) 'Green'
    }
  }
  Say "  жду 4 с, пока Chrome откроет CDP..." 'DarkGray'
  Start-Sleep -Seconds 4
}

# ─────────────────────────────────────────────────────────────────
if (-not $Check -and -not $NoExtension) {
  Header "4/6  Расширение (Extensions.loadUnpacked + popup START)"

  $py = @'
import json, sys, time, urllib.request
try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, '-m', 'pip', 'install', '--break-system-packages', 'websockets'])
    import websockets

EXT = sys.argv[1]
EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil'
POPUP = f'chrome-extension://{EXT_ID}/popup/popup.html'
PORTS = [int(x) for x in sys.argv[2].split(',') if x]

async def fix(port):
    ver = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=5).read())
    ws = await websockets.connect(ver['webSocketDebuggerUrl'], max_size=8*1024*1024)
    await ws.send(json.dumps({'id':1,'method':'Extensions.loadUnpacked','params':{'path': EXT}}))
    r1 = json.loads(await ws.recv())
    await ws.send(json.dumps({'id':2,'method':'Target.createTarget','params':{'url': POPUP}}))
    r2 = json.loads(await ws.recv())
    await ws.close()
    return port, r1.get('error',{}).get('message','ok'), r2.get('result',{}).get('targetId') is not None

async def main():
    for p in PORTS:
        try:
            port, err, popup = await fix(p)
            print(f'  :{port}  load={err}  popup={popup}', flush=True)
        except Exception as e:
            print(f'  :{port}  EXC {type(e).__name__}: {str(e)[:80]}', flush=True)
    print('  жду service worker...', flush=True)
    for i in range(6):
        time.sleep(2)
        total = 0
        for p in PORTS:
            try:
                tabs = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{p}/json/list', timeout=5).read())
                total += sum(1 for t in tabs if t.get('type')=='service_worker' and EXT_ID in t.get('url',''))
            except Exception:
                pass
        if total >= len(PORTS):
            print(f'  SW поднялись на всех ({total}/{len(PORTS)})', flush=True)
            return
    print(f'  SW: {total}/{len(PORTS)} — проверь popup', flush=True)

import asyncio
asyncio.run(main())
'@

  $ports = ($topo.slots | ForEach-Object { $_.profiles | ForEach-Object { $_.cdpPort } } |
    Where-Object { Test-Port $_ }) -join ','
  $pyPath = Join-Path $env:TEMP 'recover-ext.py'
  Set-Content -Path $pyPath -Value $py -Encoding UTF8
  python3 $pyPath $EXT_PATH $ports
}

# ─────────────────────────────────────────────────────────────────
Header "5/6  apply-topology.js (source/modemSlot в расширение)"
if (-not $Check) {
  try {
    node (Join-Path $root 'apply-topology.js') 2>&1 | Out-Host
  } catch {
    Say "  apply-topology.js: $($_.Exception.Message)" 'Yellow'
  }
} else {
  Say "  пропуск (-Check)" 'DarkGray'
}

# ─────────────────────────────────────────────────────────────────
Header "6/6  Итоговый отчёт"

Write-Host ''
Write-Host 'Прокси (публичные IP — должны быть РАЗНЫЕ):' -ForegroundColor Green
foreach ($s in $topo.slots) {
  if ($Slot -and $s.slot -ne $Slot) { continue }
  try {
    $ip = curl.exe -s --max-time 15 -x "http://127.0.0.1:$($s.proxyPort)" https://api.ipify.org
    if (-not $ip) { $ip = 'FAIL' }
  } catch { $ip = 'FAIL' }
  $color = if ($ip -eq 'FAIL') { 'Red' } else { 'Green' }
  Write-Host ("  слот {0}  proxy {1}  →  {2}" -f $s.slot, $s.proxyPort, $ip) -ForegroundColor $color
}

Write-Host ''
Write-Host 'Chrome / расширение:' -ForegroundColor Green
foreach ($s in $topo.slots) {
  if ($Slot -and $s.slot -ne $Slot) { continue }
  foreach ($p in $s.profiles) {
    $alive = Test-Port $p.cdpPort
    $sw = 0
    if ($alive) {
      try {
        $list = Invoke-RestMethod "http://127.0.0.1:$($p.cdpPort)/json/list" -TimeoutSec 4
        $sw = @($list | Where-Object { $_.type -eq 'service_worker' -and $_.url -match $EXT_ID }).Count
      } catch {}
    }
    $color = if ($alive -and $sw -gt 0) { 'Green' } elseif ($alive) { 'Yellow' } else { 'Red' }
    $state = if ($alive) { "SW=$sw" } else { 'DOWN' }
    Write-Host ("  :{0}  {1,-32} {2}  [{3}]" -f $p.cdpPort, $p.name, $state, $p.source) -ForegroundColor $color
  }
}

Write-Host ''
Write-Host 'Авторизация (из топологии — чекни глазами в popup):' -ForegroundColor Green
foreach ($s in $topo.slots) {
  if ($Slot -and $s.slot -ne $Slot) { continue }
  $auth = if ($s.authorizedSources -and $s.authorizedSources.Count -gt 0) { $s.authorizedSources -join ', ' } else { 'НЕТ (аноним — выше риск бана)' }
  $color = if ($s.authorizedSources -and $s.authorizedSources.Count -gt 0) { 'Green' } else { 'Yellow' }
  Write-Host ("  слот {0}  авторизованы: {1}" -f $s.slot, $auth) -ForegroundColor $color
}

Write-Host ''
Write-Host 'Готово. Подробности — RECOVERY.md в корне проекта.' -ForegroundColor Cyan
