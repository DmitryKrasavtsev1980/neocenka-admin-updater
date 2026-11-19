/** probe-reno.js — есть ли «Отделка/Ремонт» на закрытой карточке Cian. */
const fs = require('fs');
const port = process.argv[2];
const url = process.argv[3];
const EXPR = `(() => {
  const facts = Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]')).map(e => e.textContent.trim());
  const reno = facts.filter(f => /отдел|ремонт|евро|космет|дизайн|чернов/i.test(f));
  const inline = (document.body.innerHTML.match(/"decoration"\\s*:\\s*"[^"]+"/) || [null])[0];
  return JSON.stringify({ factsCount: facts.length, facts, reno, inline, unpub: !!document.querySelector('[data-name="OfferUnpublished"]') });
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
  await new Promise((r) => setTimeout(r, 4500));
  const r = await wsCallUrl(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(url.split('/').pop(), r.result && r.result.value);
})();
