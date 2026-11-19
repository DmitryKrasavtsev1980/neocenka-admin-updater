/** verify-closed2.js — контекст совпадения маски по URL из файла. */
const fs = require('fs');
const port = process.argv[2];
const urls = fs.readFileSync(process.argv[3], 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const EXTRACT = `(() => {
  const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
  const m = body.match(/.{0,50}(Объявление снято|снято с публикации|удалено|неактивно).{0,50}/i);
  return JSON.stringify({ match: m ? m[0] : null, title: document.title.slice(0, 50) });
})()`;
function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer); ws.close();
      msg.error ? reject(new Error(msg.error.message || 'err')) : resolve(msg.result || {});
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const ws = page.webSocketDebuggerUrl;
  for (const url of urls) {
    let out = 'FAIL';
    try {
      await wsCallUrl(ws, 'Page.navigate', { url });
      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const r = await wsCallUrl(ws, 'Runtime.evaluate', { expression: EXTRACT, awaitPromise: true, returnByValue: true });
          if (r.result && r.result.value) {
            const p = JSON.parse(r.result.value);
            if (p.match) { out = '«' + p.match + '»'; break; }
            out = 'НЕ НАЙДЕНО (' + p.title + ')';
          }
        } catch (e) {}
      }
    } catch (e) { out = 'ERROR ' + e.message; }
    console.log(out + '  <-  ' + url.split('/').pop());
  }
})();
