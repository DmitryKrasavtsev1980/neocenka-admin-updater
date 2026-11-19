/** probe-html-snapshot.js — что есть в HTML ЗАКРЫТОЙ карточки Cian
 * (для решения: можно ли собирать финальный снимок дешёвым fetch без вкладки).
 */
const port = process.argv[2];
const url = process.argv[3];
const EXPR = `(async()=>{
  const r = await fetch(location.origin + location.pathname, { credentials: 'include' }).catch(() => null);
  if (!r) return 'fetch fail';
  const html = await r.text();
  const out = {};
  out.len = html.length;
  out.priceChanges = !!html.match(/"priceChanges"\\s*:\\s*\\[/);
  const pc = html.match(/"priceChanges"\\s*:\\s*(\\[.*?\\])/);
  out.pcSample = pc ? pc[1].slice(0, 120) : null;
  out.unpub = html.includes('OfferUnpublished');
  out.updated = (html.match(/Обновлено:\\s*([^<]{3,20})/) || [null, null])[1];
  out.factoids = !!html.match(/ObjectFactoidsItem/);
  out.reno = (html.match(/(Ремонт|Отделка)<\\/[^>]+>\\s*<?[^<]*([^<]{2,30})/) || [null,null,null])[2] || null;
  out.decoration = (html.match(/"decoration"\\s*:\\s*"([^"]+)"/) || [null,null])[1] || null;
  out.jsonld = !!html.match(/application\\/ld\\+json/);
  return JSON.stringify(out);
})()`;
function wsCallUrl(u, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== 1) return; clearTimeout(t); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result || {}); };
    ws.onerror = () => { clearTimeout(t); reject(new Error('ws')); };
  });
}
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  await wsCallUrl(page.webSocketDebuggerUrl, 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await wsCallUrl(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(url.split('/').pop(), r.result && r.result.value);
})();
