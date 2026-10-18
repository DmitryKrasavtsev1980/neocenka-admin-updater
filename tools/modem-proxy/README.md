# modem-proxy — исходящий трафик через конкретный модем

Маленький HTTP/HTTPS-прокси на Node (без зависимостей). Слушает `127.0.0.1:<port>`
и открывает исходящие соединения с `localAddress` = IP адаптера модема.

Chrome нельзя прибить к сетевому адаптеру напрямую — идём через этот прокси.

## Запуск

```powershell
# модем A (адаптер 192.168.8.103, MegaFon)
node proxy.js --port 8881 --iface 192.168.8.103

# модем B (адаптер 192.168.8.107, beeline)
node proxy.js --port 8882 --iface 192.168.8.107
```

## Проверка

```powershell
curl.exe -x http://127.0.0.1:8881 https://api.ipify.org   # IP модема A
curl.exe -x http://127.0.0.1:8882 https://api.ipify.org   # IP модема B
curl.exe https://api.ipify.org                             # IP кабеля
```

Три ответа должны быть **разными**.

## Chrome

```
chrome.exe --remote-debugging-port=9224 ^
  --user-data-dir="C:\Projects\ret\chrome-debug-updater-B-avito" ^
  --proxy-server=127.0.0.1:8882 ^
  --enable-unsafe-extension-debugging
```

| Прокси | Модем | Профили Chrome |
|---|---|---|
| `127.0.0.1:8881` | A (MegaFon) | avito-A 9222, cian-A 9223 |
| `127.0.0.1:8882` | B (beeline) | avito-B 9224, cian-B 9225 |

## Замена 3proxy

Раньше планировался 3proxy (`proxy -p8881 -e<ip>`). Этот скрипт делает то же
самое, но без внешних бинарей: поддерживает CONNECT (HTTPS) и обычный HTTP,
зависимостей нет.
