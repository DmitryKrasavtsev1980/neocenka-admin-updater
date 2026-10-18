# modem-hilink-helper — смена IP для Huawei E3372 HiLink

Локальный HTTP-хелпер для модемов на **HiLink-прошивке** (веб-API `192.168.8.1`).
Нужен, когда к машине подключено **два модема**: у обоих LAN `192.168.8.0/24`
и веб-морда на `192.168.8.1`, маршруты неоднозначны, Chrome не умеет прибивать
сокет к конкретному адаптеру. Хелпер умеет: ходит в `192.168.8.1` с
`localAddress` = IP своего адаптера.

Смена IP:
1. `dataswitch` off→on (`/api/dialup/mobile-dataswitch`) — быстро, но операторы
   часто отдают тот же адрес;
2. если IP не изменился — **reboot** (`/api/device/control`, `<Control>1</Control>`) —
   почти всегда новый адрес, ~60–90 с.

IP сравнивается по **публичному** адресу (`api.ipify.org` через тот же адаптер):
у MegaFon/beeline WAN — CGNAT `10.x`, он не показателен.

## Запуск (из Windows, не из WSL)

```powershell
cd C:\Projects\ret\admin-updater\tools\modem-hilink-helper

# модем A (адаптер 192.168.8.103)
node index.js --slot A --iface 192.168.8.103 --port 8891

# модем B (адаптер 192.168.8.107) — второе окно
node index.js --slot B --iface 192.168.8.107 --port 8892
```

`--iface` = IP сетевого адаптера модема (см. `ipconfig`, шлюз `192.168.8.1`).

## API

```
GET  http://127.0.0.1:8891/status   → { ok, slot, iface, modemHost, lastRotateAt, ... }
POST http://127.0.0.1:8891/rotate   → { ok, slot, method, oldIp, newIp, durationMs }
```

Проверка:

```powershell
curl http://127.0.0.1:8891/status
curl -X POST http://127.0.0.1:8891/rotate
```

## Настройка расширения (popup)

```
modemMethod:   'at'                  # путь «через локальный хелпер»
modemHost:     'http://127.0.0.1:8891'
modemSlot:     'A'
modemEnabled:  true
```

Для модема B — порт `8892`, слот `B`. Код расширения один и тот же для
HiLink-хелпера и AT-хелпера: оба слушают `POST /rotate`.

## Почему не менять LAN IP модема

Веб-API настроек LAN/DHCP у E3372 закрыт (`100003` ERROR_NO_RIGHTS), а
перебор пароля может заблокировать модем. Хелпер решает ту же задачу без
входа в веб-морду и без смены адресов.

## Отличие от modem-at-helper

| | modem-at-helper | modem-hilink-helper |
|---|---|---|
| Прошивка | stick mode (нет веб-API) | HiLink (веб на 192.168.8.1) |
| Смена IP | `AT+CFUN=0/1` через COM | `dataswitch`, эскалация `reboot` |
| Зависимости | `serialport` | нет (только Node stdlib) |
| Привязка к адаптеру | не нужна | `--iface` обязателен |
