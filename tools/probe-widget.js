/** probe-widget.js — DOM-структура виджета истории цен Cian. */
const port = process.argv[2];
const url = process.argv[3];
const EXPR = `(async()=>{
  const w = document.querySelector('[data-testid="price-history-widget"]');
  if (!w) return 'no widget';
  w.click();
  await new Promise(r => setTimeout(r, 2000));
  // ищем раскрывшийся контейнер
  const rows = Array.from(document.querySelectorAll('table tr')).slice(0, 4).map(tr => ({
    text: tr.textContent.trim().slice(0, 50),
    cells: Array.from(tr.children).map(td => td.textContent.trim().slice(0, 20)),
  }));
  const lis = Array.from(document.querySelectorAll('[class*="history" i] li, [class*="History"] li')).slice(0, 4).map(li => ({
    text: li.textContent.trim().slice(0, 50),
    kids: Array.from(li.children).map(c => c.textContent.trim().slice(0, 20)),
  }));
  return JSON.stringify({ rows, lis });
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
