/**
 * Прописать в каждый Chrome-профиль расширения настройки из modem-topology.json:
 *   settings.source        (avito|cian) — закреплён за профилем
 *   settings.modemSlot     (A/B/...)    — модем этого профиля
 *   settings.modemHost     (http://127.0.0.1:<helperPort>)
 *   settings.sourcePinned  true         — серверный assignSource не перетирает
 *
 * Запуск (из Windows или WSL):
 *   node C:\Projects\ret\admin-updater\tools\apply-topology.js
 *   node apply-topology.js --dry-run     # только показать, что будет
 *
 * Chrome-профили должны быть запущены (CDP-порты открыты).
 * После применения — перезапустить воркер (STOP/START из popup) или
 * перезагрузить расширение через Extensions.loadUnpacked.
 */
const fs = require('fs');
const path = require('path');

const TOPOLOGY = path.join(__dirname, 'modem-topology.json');
const DRY = process.argv.includes('--dry-run');

function die(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function swEval(cdpPort, expression) {
  const listRes = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).catch((e) => {
    throw new Error(`CDP ${cdpPort} недоступен: ${e.message}`);
  });
  const targets = await listRes.json();
  const sw = targets.find(
    (t) => t.type === 'service_worker' && (t.url || '').includes('bimpcjbiacocbkodnohpghgceobgoeil')
  );
  if (!sw) throw new Error(`CDP ${cdpPort}: service worker расширения не найден`);

  // Простой WebSocket через fetch не сделать — используем встроенный WebSocket
  // (Node 22+) или деградируем на chrome.debugger-less evaluate через /json/protocol
  const WebSocketImpl = globalThis.WebSocket || require('ws');
  const ws = new WebSocketImpl(sw.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error('WS error: ' + (e.message || e)));
  });

  const result = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('WS timeout')), 15000);
    ws.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id !== 1) return;
      clearTimeout(timer);
      res(d.result?.result?.value);
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    );
  });
  try { ws.close(); } catch {}
  return result;
}

(async () => {
  const topo = JSON.parse(fs.readFileSync(TOPOLOGY, 'utf8'));
  console.log('Топология:', TOPOLOGY);
  if (DRY) console.log('(dry-run — ничего не пишем)\n');

  let ok = 0;
  let fail = 0;

  for (const slot of topo.slots) {
    console.log(`── слот ${slot.slot} (${slot.label || ''}) iface=${slot.iface} proxy=${slot.proxyPort} helper=${slot.helperPort}`);
    for (const p of slot.profiles) {
      const modemHost = `http://127.0.0.1:${slot.helperPort}`;
      const expr = `
        (async () => {
          const prev = await new Promise(r => chrome.storage.local.get('settings', r));
          const s = Object.assign({}, prev.settings || {});
          s.source = ${JSON.stringify(p.source)};
          s.modemSlot = ${JSON.stringify(slot.slot)};
          s.modemHost = ${JSON.stringify(modemHost)};
          s.modemEnabled = true;
          s.sourcePinned = true;
          // темп всегда из SOURCE_TEMPO в коде, но настройки чиним
          s.apiUrl = s.apiUrl || 'https://54.neocenka.ru/api';
          if (!DRY_EXPR) await chrome.storage.local.set({ settings: s });
          return JSON.stringify({
            browserId: (await new Promise(r => chrome.storage.local.get('browserId', r))).browserId,
            source: s.source, modemSlot: s.modemSlot, modemHost: s.modemHost, sourcePinned: s.sourcePinned
          });
        })()
      `.replace('DRY_EXPR', DRY ? 'true' : 'false');

      try {
        const val = await swEval(p.cdpPort, expr);
        console.log(`  :${p.cdpPort} ${p.name.padEnd(32)} ${val} ${DRY ? '(dry)' : 'OK'}`);
        ok++;
      } catch (e) {
        console.log(`  :${p.cdpPort} ${p.name.padEnd(32)} FAIL ${e.message}`);
        fail++;
      }
    }
    console.log('');
  }

  console.log(`Итог: ok=${ok} fail=${fail}`);
  if (!DRY && ok > 0) {
    console.log('Дальше: STOP/START воркеров (popup) или перезагрузить расширение,');
    console.log('        чтобы воркеры подхватили source и начали claim по своей площадке.');
  }
  if (fail > 0) process.exit(1);
})().catch((e) => die(e.message || e));
