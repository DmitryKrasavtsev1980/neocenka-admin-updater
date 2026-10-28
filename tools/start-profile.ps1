# start-profile.ps1 — запустить ОДИН Chrome-профиль вручную.
#
#   powershell -ExecutionPolicy Bypass -File start-profile.ps1 -Name chrome-debug-updater
#   powershell ... start-profile.ps1 -Name chrome-debug-updater-B-avito -NoExtension
#   powershell ... start-profile.ps1 -List          # показать все профили
#
# Поднимает: helper/proxy слота (если не живы) → Chrome → расширение → popup.

param(
  [string]$Name,
  [switch]$List,
  [switch]$NoExtension
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

if ($List -or -not $Name) {
  Write-Host 'Доступные профили:' -ForegroundColor Cyan
  foreach ($s in $topo.slots) {
    foreach ($p in $s.profiles) {
      $alive = $false
      try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $p.cdpPort); $c.Close(); $alive = $true } catch {}
      $mark = if ($alive) { '[up]' } else { '[  ]' }
      Write-Host ("  {0}  {1,-32}  :{2}  слот {3}  {4}  proxy {5}" -f $mark, $p.name, $p.cdpPort, $s.slot, $p.source, $s.proxyPort)
    }
  }
  if (-not $Name) { return }
}

# найти профиль
$found = $null
foreach ($s in $topo.slots) {
  foreach ($p in $s.profiles) {
    if ($p.name -eq $Name) { $found = @{ Slot = $s; Profile = $p } }
  }
}
if (-not $found) {
  Write-Host "Профиль '$Name' не найден. См. -List" -ForegroundColor Red
  exit 1
}

$s = $found.Slot; $p = $found.Profile

function Test-Port([int]$port) {
  try { $c = New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1', $port); $c.Close(); return $true }
  catch { return $false }
}

# 1) helper/proxy слота
foreach ($x in @(
  @{ dir = $topo.helperDir; argv = @('index.js','--slot',$s.slot,'--iface',$s.iface,'--port',[string]$s.helperPort,'--host',$topo.modemHost); port = $s.helperPort; name = "hilink-$($s.slot)" },
  @{ dir = $topo.proxyDir;  argv = @('proxy.js','--port',[string]$s.proxyPort,'--iface',$s.iface); port = $s.proxyPort; name = "proxy-$($s.slot)" }
)) {
  if (Test-Port $x.port) {
    Write-Host ("  :{0} уже слушает — пропускаю" -f $x.port) -ForegroundColor DarkGray
    continue
  }
  $logDir = $topo.logDir
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Process -FilePath 'node' -ArgumentList $x.argv -WorkingDirectory $x.dir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "$($x.name).log") `
    -RedirectStandardError  (Join-Path $logDir "$($x.name).err")
  Write-Host ("  :{0} запущен" -f $x.port) -ForegroundColor Green
}

# 2) Chrome
if (Test-Port $p.cdpPort) {
  Write-Host ("  :{0} {1} уже запущен" -f $p.cdpPort, $p.name) -ForegroundColor DarkGray
} else {
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
  Write-Host ("  :{0} {1} → proxy {2}" -f $p.cdpPort, $p.name, $s.proxyPort) -ForegroundColor Green
  Start-Sleep -Seconds 3
}

# 3) расширение + popup
if (-not $NoExtension) {
  $py = @'
import json, sys, urllib.request
import websockets
EXT, PORT = sys.argv[1], int(sys.argv[2])
EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil'
POPUP = f'chrome-extension://{EXT_ID}/popup/popup.html'
async def main():
    ver = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version', timeout=5).read())
    ws = await websockets.connect(ver['webSocketDebuggerUrl'], max_size=8*1024*1024)
    await ws.send(json.dumps({'id':1,'method':'Extensions.loadUnpacked','params':{'path': EXT}}))
    r1 = json.loads(await ws.recv())
    await ws.send(json.dumps({'id':2,'method':'Target.createTarget','params':{'url': POPUP}}))
    r2 = json.loads(await ws.recv())
    await ws.close()
    print(f"  load={r1.get('error',{}).get('message','ok')}  popup={r2.get('result',{}).get('targetId') is not None}")
import asyncio
asyncio.run(main())
'@
  $pyPath = Join-Path $env:TEMP 'start-one-ext.py'
  Set-Content -Path $pyPath -Value $py -Encoding UTF8
  python3 $pyPath $topo.extensionDist $p.cdpPort
}

Write-Host ''
Write-Host "Готово: $($p.name) (слот $($s.slot), source=$($p.source), proxy $($s.proxyPort))" -ForegroundColor Cyan
