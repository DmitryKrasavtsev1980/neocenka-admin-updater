/**
 * sw-eval.js — выполнить JS в контексте service worker расширения.
 *
 * Использование (Windows PowerShell):
 *   node sw-eval.js <port> -f <file.js>
 *
 * Найдёт SW расширения (по id) на CDP-порту профиля и выполнит выражение.
 */
const fs = require('fs');
const port = process.argv[2];
const expr = fs.readFileSync(process.argv[4], 'utf8');
const EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil';

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout ' + method));
    }, 15000);
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

(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = tabs.find((t) => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
  if (!sw) {
    console.log('нет service worker на порту ' + port);
    process.exit(2);
  }
  const r = await wsCallUrl(sw.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    process.exit(3);
  }
  console.log(JSON.stringify(r.result && r.result.value));
})().catch((e) => {
  console.log('FAIL: ' + e.message);
  process.exit(2);
});
