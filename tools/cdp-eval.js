/**
 * cdp-eval.js — выполнить JS в странице Chrome-профиля (CDP) и напечатать результат.
 *
 * Использование (Windows PowerShell):
 *   node cdp-eval.js <port> "<js-выражение>" [url-substring]
 *
 * Пример:
 *   node cdp-eval.js 9228 "document.title" avito.ru
 *
 * Выражение может возвращать Promise (awaitPromise). Результат — returnByValue.
 * Нужен запущенный профиль с открытым CDP-портом (start-profile.ps1).
 */
const port = process.argv[2];
// node cdp-eval.js <port> "<js>" [url-substring]
// node cdp-eval.js <port> -f <file.js> [url-substring]  — выражение из файла
let expr, filter;
if (process.argv[3] === '-f') {
  expr = require('fs').readFileSync(process.argv[4], 'utf8');
  filter = process.argv[5] || '';
} else {
  expr = process.argv[3];
  filter = process.argv[4] || '';
}

if (!port || !expr) {
  console.error('usage: node cdp-eval.js <port> "<js>"|-f <file.js> [url-substring]');
  process.exit(1);
}

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout ' + method));
    }, 30000);
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
  // Повтор при «target navigated or closed» — страница могла перезагружаться.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      let page = null;
      const pages = tabs.filter((t) => t.type === 'page');
      if (filter) {
        page = pages.find((t) => (t.url || '').includes(filter));
        if (!page) {
          console.log('НЕ НАЙДЕНА вкладка с url ~ ' + filter);
          console.log('вкладки: ' + pages.map((t) => t.url).join(' | '));
          process.exit(2);
        }
      } else {
        page = pages[0];
        if (!page) {
          console.log('нет page-таргетов');
          process.exit(2);
        }
      }
      const r = await wsCallUrl(page.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        console.log('EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
        process.exit(3);
      }
      const v = r.result && r.result.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
      return;
    } catch (e) {
      if (/navigated or closed|ws error|timeout/i.test(e.message) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
})();
