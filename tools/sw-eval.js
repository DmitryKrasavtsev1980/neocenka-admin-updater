/**
 * sw-eval.js — выполнить JS в контексте service worker расширения (CDP) и напечатать результат.
 *
 * Зачем: apply-topology.js пишет настройки из топологии, а здесь — точечные
 * правки настроек вручную (например, переключить профиль на другой слот).
 *
 * Использование (Windows PowerShell):
 *   node sw-eval.js <port> "<js-выражение>"
 *   node sw-eval.js <port> -f <file.js>
 */
const port = Number(process.argv[2]);
const expr = process.argv[3] === '-f'
  ? require('fs').readFileSync(process.argv[4], 'utf8')
  : process.argv[3];
const EXT_ID = 'bimpcjbiacocbkodnohpghgceobgoeil';

if (!port || !expr) {
  console.error('usage: node sw-eval.js <cdpPort> "<js>"|-f <file.js>');
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
  const r = await wsCallUrl(sw.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  const v = r.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
}

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
