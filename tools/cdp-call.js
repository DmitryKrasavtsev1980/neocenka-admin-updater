/**
 * cdp-call.js — вызвать CDP-метод в Chrome-профиле.
 *
 * Использование (Windows PowerShell):
 *   node cdp-call.js <port> clear-origin <https://site>   — очистить cookies/storage источника
 *   node cdp-call.js <port> clear-cookies                 — Network.clearBrowserCookies (все куки профиля!)
 *   node cdp-call.js <port> <Method> @params.json         — любой метод с параметрами из файла
 *
 * Примеры:
 *   node cdp-call.js 9228 clear-origin https://www.avito.ru
 */
const fs = require('fs');

const port = process.argv[2];
const action = process.argv[3];
const arg4 = process.argv[4];

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout ' + method));
    }, 15000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return; // событие CDP — не ответ команды, ждём дальше
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

(async () => {
  // Browser-эндпоинт не знает Network/Storage-методы — берём первый page-таргет.
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('нет page-таргетов на порту ' + port);
  const ws = page.webSocketDebuggerUrl;

  if (action === 'clear-origin') {
    const r = await wsCallUrl(ws, 'Storage.clearDataForOrigin', {
      origin: arg4,
      storageTypes: 'cookies,local_storage,session_storage,indexeddb,service_workers,cache_storage',
    });
    console.log('cleared origin ' + arg4 + ' → ' + JSON.stringify(r));
    return;
  }
  if (action === 'clear-cookies') {
    const r = await wsCallUrl(ws, 'Network.clearBrowserCookies', {});
    console.log('all cookies cleared → ' + JSON.stringify(r));
    return;
  }
  if (!action) {
    console.error('usage: node cdp-call.js <port> clear-origin <url> | clear-cookies | <Method> @params.json');
    process.exit(1);
  }
  const params = arg4 && arg4.startsWith('@') ? JSON.parse(fs.readFileSync(arg4.slice(1), 'utf8')) : {};
  const r = await wsCallUrl(ws, action, params);
  console.log(JSON.stringify(r, null, 1));
})().catch((e) => {
  console.log('FAIL: ' + e.message);
  process.exit(2);
});
