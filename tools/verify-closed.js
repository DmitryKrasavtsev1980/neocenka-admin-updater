/**
 * verify-closed.js — проверить, действительно ли карточки сняты.
 * Использование: node verify-closed.js <port> <file-urls>
 * Навигирует по URL из файла и выполняет ту же маску классификации,
 * что и light-check (active/closed/blocked/unknown).
 */
const fs = require('fs');

const port = process.argv[2];
const file = process.argv[3];
const urls = fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);

const EXTRACT = `(() => {
  const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
  const isCian = /cian\\.ru/.test(location.host);
  if (/доступ ограничен|проблема с ip|отключите VPN|отключите AdBlock|проверьте, что вы не робот|не робот|обнаружен подозрительный трафик|cian_waf|rate limit/i.test(body)) {
    return JSON.stringify({ status: 'blocked', title: document.title.slice(0, 70) });
  }
  let status = 'unknown';
  if (isCian) {
    if (/Объявление снято|снято с публикации|удалено|неактивно/i.test(body)) status = 'closed';
    else if (/Сравнить|Пожаловаться|Обновлено:/i.test(body)) status = 'active';
  } else {
    if (/Объявление закрыто|Объявление истекло/i.test(body)) status = 'closed';
    else if (/Добавить в избранное|Сравнить/i.test(body)) status = 'active';
  }
  return JSON.stringify({ status, title: document.title.slice(0, 70) });
})()`;

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout ' + method)); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  if (!page) { console.log('нет page-таргета'); process.exit(2); }
  const ws = page.webSocketDebuggerUrl;

  for (const url of urls) {
    let status = 'FAIL';
    let title = '';
    try {
      await wsCallUrl(ws, 'Page.navigate', { url });
      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const r = await wsCallUrl(ws, 'Runtime.evaluate', { expression: EXTRACT, awaitPromise: true, returnByValue: true });
          if (r.result && r.result.value) {
            const parsed = JSON.parse(r.result.value);
            status = parsed.status;
            title = parsed.title || '';
            if (status !== 'unknown') break;
          }
        } catch (e) { /* навигация */ }
      }
    } catch (e) {
      status = 'ERROR ' + e.message;
    }
    console.log(`${status}\t${url}\t${title}`);
  }
})();
