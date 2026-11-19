/** probe-hist2.js — виджет истории по data-testid + клик + повторное чтение. */
const port = process.argv[2];
const url = process.argv[3];
const EXPR = `(async()=>{
  const w = document.querySelector('[data-testid="price-history-widget"]');
  const out = { widget: !!w, widgetText: w ? w.textContent.trim().slice(0,40) : null, unpub: !!document.querySelector('[data-name="OfferUnpublished"]') };
  if (w) { w.click(); await new Promise(r => setTimeout(r, 2000)); }
  const rows = Array.from(document.querySelectorAll('table tr, [class*="history"] li, [class*="History"] li')).map(e => e.textContent.trim().slice(0,40)).slice(0, 6);
  out.rowsAfterClick = rows;
  const id = (location.pathname.match(/(\\d{7,})/) || [])[1];
  try {
    const r = await fetch('/price-estimator/v1/get-estimation-and-trend-web/?cianOfferId=' + id, { credentials: 'include' });
    out.api = { status: r.status, n: (await r.json().catch(()=>({}))).priceHistory?.length ?? 0 };
  } catch (e) { out.api = 'fail: ' + e.message.slice(0,30); }
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
  await new Promise((r) => setTimeout(r, 5000));
  const r = await wsCallUrl(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(r.result && r.result.value);
})();
