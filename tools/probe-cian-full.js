/** probe-cian-full.js — полная картина данных на закрытой карточке Cian. */
const fs = require('fs');
const port = process.argv[2];
const url = fs.readFileSync(process.argv[3], 'utf8').split('\n').map(s => s.trim()).filter(Boolean)[0];
const EXPR = `(() => {
  const u = document.querySelector('[data-name="OfferUnpublished"]');
  const priceEl = document.querySelector('[data-testid="price-amount"]');
  const price = priceEl ? priceEl.textContent.replace(/[^\\d]/g, '') : null;
  const imgs = Array.from(document.querySelectorAll('img')).map(i => i.src).filter(s => /cian|cdn/.test(s)).slice(0, 5);
  const dateEl = document.querySelector('[data-testid="metadata-updated-date"]');
  const facts = Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]')).map(e => e.textContent.trim()).slice(0, 10);
  const seller = (document.body.innerText.match(/(Собственник|Агентство|Риелтор|Застройщик)/) || [null])[0];
  return JSON.stringify({ unpublished: !!u, price, date: dateEl ? dateEl.textContent.trim() : null, imgs: imgs.length, imgSample: imgs[0] ? imgs[0].slice(0, 60) : null, facts, seller });
})()`;
function wsCallUrl(u, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result || {}); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws')); };
  });
}
(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  await wsCallUrl(page.webSocketDebuggerUrl, 'Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 4000));
  const r = await wsCallUrl(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true });
  console.log(r.result && r.result.value);
})();
