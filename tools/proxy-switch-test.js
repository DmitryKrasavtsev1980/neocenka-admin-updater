/**
 * proxy-switch-test.js — проверка переключения канала (proxy) расширением НА ЛЕТУ.
 *
 * Правит то, что раньше было невозможно: proxy был зашит флагом --proxy-server
 * при старте Chrome, и кончившийся модем убивал профиль до перезапуска.
 *
 * Использование (Windows PowerShell):
 *   node proxy-switch-test.js <port> <proxyPort>   # переключить и проверить IP
 *   node proxy-switch-test.js <port>               # только показать текущий proxy
 */
const port = Number(process.argv[2]);
const targetProxyPort = process.argv[3] ? Number(process.argv[3]) : null;
const EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil';

if (!port) {
  console.error('usage: node proxy-switch-test.js <cdpPort> [proxyPort]');
  process.exit(1);
}

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout ${method}`));
    }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
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

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
  if (!sw) throw new Error('нет service worker расширения');
  const ws = sw.webSocketDebuggerUrl;

  const evalSw = async (expression) => {
    const r = await wsCallUrl(ws, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.result?.value;
  };

  const before = await evalSw(`new Promise((res) => chrome.proxy.settings.get({}, (c) => {
    const v = c?.value ?? {};
    const sp = v.rules?.singleProxy || v.rules?.proxyForHttp;
    res(sp ? sp.host + ':' + sp.port : v.mode || 'none');
  }))`);
  console.log(`proxy до: ${before}`);

  if (targetProxyPort) {
    await evalSw(`new Promise((res) => chrome.proxy.settings.set({
      value: { mode: 'fixed_servers', rules: { singleProxy: { host: '127.0.0.1', port: ${targetProxyPort} } } },
      scope: 'regular',
    }, res))`);
    const after = await evalSw(`new Promise((res) => chrome.proxy.settings.get({}, (c) => {
      const v = c?.value ?? {};
      const sp = v.rules?.singleProxy || v.rules?.proxyForHttp;
      res(sp ? sp.host + ':' + sp.port : v.mode || 'none');
    }))`);
    console.log(`proxy после: ${after}`);

    // Выход в интернет через НОВЫЙ канал — из контекста расширения.
    const ip = await evalSw(`fetch('https://api.ipify.org?format=json').then(r => r.json()).then(d => d.ip).catch(e => 'ERR: ' + e.message)`);
    console.log(`внешний IP через новый канал: ${ip}`);
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
