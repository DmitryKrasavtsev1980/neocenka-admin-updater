/** probe-cian-history.js — доступность API истории цен на ЗАКРЫТОЙ карточке Cian.
 * Пробуем и относительный, и www-вариант, из origin самой карточки.
 */
const fs = require('fs');
const port = process.argv[2];
const url = fs.readFileSync(process.argv[3], 'utf8').split('\n').map(s => s.trim()).filter(Boolean)[0];
const offerId = url.match(/(\d{7,})\/?$/)[1];

function wsCallUrl(u, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
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

const EXPR = `(async()=>{
  const out = {};
  const id = ${offerId};
  for (const base of ['', 'https://www.cian.ru']) {
    try {
      const r = await fetch(base + '/price-estimator/v1/get-estimation-and-trend-web/?cianOfferId=' + id, { credentials: 'include' });
      const j = await r.json().catch(() => null);
      out[base || 'relative'] = { status: r.status, n: j && j.priceHistory ? j.priceHistory.length : 0, last: j && j.priceHistory && j.priceHistory[j.priceHistory.length-1] };
    } catch (e) { out[base || 'relative'] = 'fail: ' + e.message.slice(0,40); }
  }
  return JSON.stringify(out);
})()`;

(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const ws = page.webSocketDebuggerUrl;
  await wsCallUrl(ws, 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await wsCallUrl(ws, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log('offerId=' + offerId, r.result && r.result.value);
})();
