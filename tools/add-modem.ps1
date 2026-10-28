# add-modem.ps1 — подключить новый модем одной командой.
#
#   powershell -ExecutionPolicy Bypass -File add-modem.ps1 -Slot D -Phone "+7XXX" -Label "Tele3"
#   powershell ... add-modem.ps1 -Slot D -Phone "+7XXX" -Role parsing
#   powershell ... add-modem.ps1 -Slot D -Role internet        # модем только как канал интернета
#   powershell ... add-modem.ps1 -List                          # что уже есть
#
# Делает всё по HOWTO-NEWMODEM.md:
#   1) находит свободный NDIS-адаптер и его USB-id;
#   2) дописывает слот в modem-topology.json;
#   3) поднимает helper/proxy/Chrome (recover.ps1);
#   4) прописывает source в расширение (apply-topology.js);
#   5) запускает воркер (startWorker).
#
# НЕ делает: логин на площадках (нужен SMS-код, это отдельный шаг — см. HOWTO-NEWMODEM.md шаг 6),
#            смену маршрутов, ротацию IP.

param(
  [string]$Slot,
  [string]$Phone,
  [string]$Label,
  [ValidateSet('parsing', 'internet')]
  [string]$Role = 'parsing',
  [switch]$List
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$topoPath = Join-Path $root 'modem-topology.json'
$topo = Get-Content $topoPath -Raw | ConvertFrom-Json

function Say($m, $c = 'White') { Write-Host $m -ForegroundColor $c }

# ── режим списка ──
if ($List -or -not $Slot) {
  Say 'Слоты в modem-topology.json:' Cyan
  foreach ($s in $topo.slots) {
    $n = if ($s.profiles) { $s.profiles.Count } else { 0 }
    Say ("  {0}  {1,-36} role={2,-8} iface={3,-16} профилей={4}" -f `
      $s.slot, $s.label, $s.role, $s.iface, $n)
  }
  Say ''
  Say 'Свободные NDIS-адаптеры (не привязаны к слотам):' Cyan
  $used = $topo.slots | ForEach-Object { $_.usbInstanceId }
  Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'NDIS' } | ForEach-Object {
    $ip = (Get-NetIPAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
    $free = 'свободен'
    Say ("  {0,-14} {1,-16} {2,-18} {3}" -f $_.Name, $ip, $_.MacAddress, $free)
  }
  if (-not $Slot) {
    Say ''
    Say 'Пример: add-modem.ps1 -Slot D -Phone "+7XXX" -Label "Tele3"' Yellow
  }
  return
}

# ── проверка слота ──
if ($topo.slots | Where-Object { $_.slot -eq $Slot }) {
  Say "Слот $Slot уже существует. Удали его вручную из modem-topology.json, если хочешь заменить." Red
  exit 1
}

# ── 1. найти адаптер ──
Say "── 1/5  Ищу свободный NDIS-адаптер" Cyan
$usedAlias = $topo.slots | ForEach-Object { $_.ifaceAlias }
$free = Get-NetAdapter | Where-Object {
  $_.InterfaceDescription -match 'NDIS' -and $_.Status -eq 'Up' -and $usedAlias -notcontains $_.Name
}
if (-not $free) {
  Say 'Свободных NDIS-адаптеров нет. Модем воткнут? Проверь: Get-NetAdapter' Red
  exit 1
}
$ad = $free | Select-Object -First 1
$ip = (Get-NetIPAddress -InterfaceIndex $ad.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress
Say ("  найден: {0}  ip={1}  mac={2}" -f $ad.Name, $ip, $ad.MacAddress) Green

if (-not $ip) {
  Say 'У адаптера нет IPv4 — модем ещё стартует или не получил адрес. Подожди и повтори.' Red
  exit 1
}

# USB instance id (через PnP)
$pnp = Get-PnpDevice -PresentOnly -Class Net | Where-Object { $_.FriendlyName -match 'NDIS' }
$usb = $null
foreach ($n in $pnp) {
  $prop = Get-PnpDeviceProperty -InstanceId $n.InstanceId -KeyName 'DEVPKEY_Device_NetCfgInstanceId' -ErrorAction SilentlyContinue
  if ($prop -and $prop.Data) {
    $na = Get-NetAdapter | Where-Object { $_.InterfaceGuid -eq $prop.Data -or $_.Name -eq $ad.Name }
    if ($na) { $usb = $n.InstanceId; break }
  }
}
Say ("  usbInstanceId: {0}" -f $(if ($usb) { $usb } else { 'не найден, оставляю пустым' })) $(if ($usb) { 'Green' } else { 'Yellow' })

# ── 2. порты ──
Say "── 2/5  Выбираю порты" Cyan
$usedProxy = $topo.slots | ForEach-Object { $_.proxyPort }
$usedHelper = $topo.slots | ForEach-Object { $_.helperPort }
$usedCdp = $topo.slots | ForEach-Object { if ($_.profiles) { $_.profiles | ForEach-Object { $_.cdpPort } } }

$proxyPort = 8881; while ($usedProxy -contains $proxyPort) { $proxyPort++ }
$helperPort = 8891; while ($usedHelper -contains $helperPort) { $helperPort++ }
$cdp1 = 9222; while ($usedCdp -contains $cdp1) { $cdp1++ }
$cdp2 = $cdp1 + 1; while ($usedCdp -contains $cdp2) { $cdp2++ }
Say ("  proxy={0}  helper={1}  cdp={2},{3}" -f $proxyPort, $helperPort, $cdp1, $cdp2) Green

# ── 3. дописать в топологию ──
Say "── 3/5  Пишу слот в modem-topology.json" Cyan
$slug = ($Label -replace '[^a-zA-Z0-9]', '').ToLower()
if (-not $slug) { $slug = "modem$($Slot.ToLower())" }

$profiles = @()
if ($Role -eq 'parsing') {
  $profiles = @(
    @{ name = "avito-$slug";  userDataDir = "C:\Projects\ret\chrome-debug-updater-$Slot-avito"; cdpPort = $cdp1; source = 'avito'; note = "создан add-modem.ps1 $(Get-Date -Format 'dd.MM.yyyy')" },
    @{ name = "cian-$slug";   userDataDir = "C:\Projects\ret\chrome-debug-updater-$Slot-cian";  cdpPort = $cdp2; source = 'cian';  note = "создан add-modem.ps1 $(Get-Date -Format 'dd.MM.yyyy')" }
  )
}

$newSlot = [ordered]@{
  slot           = $Slot
  label          = $(if ($Label) { $Label } else { "модем $Slot" })
  usbInstanceId  = $usb
  ifaceAlias     = $ad.Name
  mac            = $ad.MacAddress
  iface          = $ip
  proxyPort      = $proxyPort
  helperPort     = $helperPort
  role           = $Role
  authorizedSources = @()
  note           = "подключён $(Get-Date -Format 'dd.MM.yyyy HH:mm'); phone=$Phone"
  profiles       = $profiles
}

$topo.slots += [PSCustomObject]$newSlot
$topo | ConvertTo-Json -Depth 10 | Set-Content -Path $topoPath -Encoding UTF8
Say "  слот $Slot добавлен" Green

# ── 4. поднять ──
Say "── 4/5  Поднимаю helper/proxy/Chrome" Cyan
& (Join-Path $root 'recover.ps1') -Slot $Slot

# ── 5. source + START ──
Say "── 5/5  Прописываю source и запускаю воркер" Cyan
node (Join-Path $root 'apply-topology.js') 2>&1 | Out-Host

# запуск воркера через CDP
$py = @'
import json, sys, time, urllib.request
import websockets
EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil'
PORTS = [int(x) for x in sys.argv[1].split(',') if x]

async def start(port):
    try:
        tabs = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=5).read())
    except Exception as e:
        return port, f'CDP недоступен: {e}'
    sw = next((t for t in tabs if t.get('type')=='service_worker' and EXT_ID in t.get('url','')), None)
    if not sw:
        return port, 'нет service worker'
    ver = json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=5).read())
    ws = await websockets.connect(ver['webSocketDebuggerUrl'], max_size=8*1024*1024)
    await ws.send(json.dumps({'id':1,'method':'Target.attachToTarget','params':{'targetId': sw['id'], 'flatten': True}}))
    sid = None
    for _ in range(8):
        m = json.loads(await ws.recv())
        if m.get('id')==1: sid = m.get('result',{}).get('sessionId'); break
        if m.get('method')=='Target.attachedToTarget': sid = m.get('params',{}).get('sessionId')
    if not sid:
        await ws.close(); return port, 'нет сессии'
    await ws.send(json.dumps({'id':2,'sessionId':sid,'method':'Runtime.evaluate','params':{
        'expression': "typeof startWorker==='function' ? (startWorker(),'started') : 'no-fn'",
        'returnByValue': True}}))
    v = 'no-fn'
    for _ in range(6):
        m = json.loads(await ws.recv())
        if m.get('id')==2:
            v = m.get('result',{}).get('result',{}).get('value')
            break
    await ws.close()
    return port, str(v)

import asyncio
async def main():
    for p in PORTS:
        port, msg = await start(p)
        print(f'  :{port} → {msg}')
asyncio.run(main())
'@
$pyPath = Join-Path $env:TEMP 'addmodem-start.py'
Set-Content -Path $pyPath -Value $py -Encoding UTF8
$portsArg = ($profiles | ForEach-Object { $_.cdpPort }) -join ','
if ($portsArg) { python3 $pyPath $portsArg }

Say ''
Say "Готово. Слот $Slot поднят." Cyan
Say ''
Say 'Осталось вручную (см. HOWTO-NEWMODEM.md шаг 6):' Yellow
Say '  1. Залогинить аккаунты (SMS-коды читаю из модема):'
Say "       node C:\Projects\ret\modem-tools\hilink.js sms $ip"
Say '  2. Проверить, что воркеры пошли:'
Say '       curl.exe -s -x http://127.0.0.1:' + $proxyPort + ' https://54.neocenka.ru/api/monitor/actualize-stats'
