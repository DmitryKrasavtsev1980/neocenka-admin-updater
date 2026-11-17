/**
 * load-extension.js — загрузить расширение admin-updater в запущенные Chrome-профили.
 *
 * Зачем: recover.ps1 грузит расширение python-скриптом, а на ПК без Python
 * (или без модуля websockets) этот шаг молча не выполняется. Здесь — нативный
 * Node (v22+), без зависимостей: WebSocket встроен в Node.
 *
 * Использование (из Windows PowerShell):
 *   node load-extension.js                  # все порты из modem-topology.json
 *   node load-extension.js --ports 9228,9229
 *   node load-extension.js --start          # + запустить воркер (ТОЛЬКО после логина!)
 *
 * Chrome должен быть запущен с --enable-unsafe-extension-debugging (start-profile.ps1).
 * Путь к dist — БЕЗ завершающего обратного слэша (иначе Chrome молча не найдёт manifest).
 */
const fs = require('fs');
const path = require('path');

const EXT_PATH = 'C:\\Projects\\ret\\admin-updater\\dist';
const EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil';
const POPUP = `chrome-extension://${EXT_ID}/popup/popup.html`;
const TOPOLOGY = path.join(__dirname, 'modem-topology.json');

const args = process.argv.slice(2);
const wantStart = args.includes('--start');
let ports = null;
const portsIdx = args.indexOf('--ports');
if (portsIdx !== -1 && args[portsIdx + 1]) {
  ports = args[portsIdx + 1].split(',').map(Number);
} else {
  const topo = JSON.parse(fs.readFileSync(TOPOLOGY, 'utf8'));
  ports = topo.slots.flatMap((s) => s.profiles.map((p) => p.cdpPort));
}

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout ${method}`));
    }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      const msg = JSON.parse(ev.data);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('ws error'));
    };
  });
}

async function wsCall(port, method, params) {
  let ver;
  try {
    ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch (e) {
    throw new Error(`CDP ${port}: ${e.message}`);
  }
  return wsCallUrl(ver.webSocketDebuggerUrl, method, params).catch((e) => {
    throw new Error(`CDP ${port}: ${e.message}`);
  });
}

/** Выполнить выражение в КОНТЕКСТЕ service worker расширения (как apply-topology.js) */
async function swEval(port, expression) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = tabs.find((t) => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
  if (!sw) throw new Error('нет service worker');
  return wsCallUrl(sw.webSocketDebuggerUrl, 'Runtime.evaluate', { expression });
}

async function swTargetId(port) {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = tabs.find((t) => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
  return sw ? sw.id : null;
}

async function handlePort(port) {
  // 1. Загрузить расширение
  try {
    await wsCall(port, 'Extensions.loadUnpacked', { path: EXT_PATH });
    console.log(`  :${port}  loadUnpacked ok`);
  } catch (e) {
    console.log(`  :${port}  loadUnpacked FAIL: ${e.message}`);
    return;
  }

  // 2. Открыть popup (заодно будит SW)
  try {
    await wsCall(port, 'Target.createTarget', { url: POPUP });
    console.log(`  :${port}  popup открыт`);
  } catch (e) {
    console.log(`  :${port}  popup FAIL: ${e.message}`);
  }

  // 3. Дождаться service worker
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const sw = await swTargetId(port).catch(() => null);
    if (sw) {
      console.log(`  :${port}  SW жив ✅`);
      if (wantStart) {
        try {
          const r = await swEval(
            port,
            'typeof startWorker === "function" ? (startWorker(), "started") : "no startWorker"'
          );
          console.log(`  :${port}  воркер: ${JSON.stringify(r.result && r.result.value)}`);
        } catch (e) {
          console.log(`  :${port}  start FAIL: ${e.message}`);
        }
      }
      return;
    }
  }
  console.log(`  :${port}  SW так и не поднялся — открой popup и посмотри ошибку сети`);
}

(async () => {
  console.log(`dist: ${EXT_PATH}`);
  console.log(`порты: ${ports.join(', ')}${wantStart ? ' (+ запуск воркера)' : ''}`);
  for (const p of ports) {
    await handlePort(p);
  }
})();
