/** probe-archived-data.js — что реально доступно на ЗАКРЫТОЙ карточке.
 * Для cian: цена/фото/дата/история (как парсит полный парсинг).
 * Для avito: редирект или данные.
 */
const fs = require('fs');
const port = process.argv[2];
const urls = fs.readFileSync(process.argv[3], 'utf8').split('\n').map(s => s.trim()).filter(Boolean);

const CIAN = `(() => {
  const u = document.querySelector('[data-name="OfferUnpublished"]');
  const priceEl = document.querySelector('[data-testid="price-amount"]');
  const price = priceEl ? priceEl.textContent.replace(/[^\\d]/g, '') : null;
  const photos = document.querySelectorAll('#photos img[src*="images.cdn-cian.ru/images/"], [class*="photo_gallery_container"] img[src*="images.cdn-cian.ru/images/"]').length;
  const dateEl = document.querySelector('[data-testid="metadata-updated-date"]');
  const histBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => /истори/i.test(b.textContent||''));
  const deс = Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"]')).map(e => e.textContent.trim()).slice(0,4);
  return JSON.stringify({ unpublished: !!u, price, photos, date: dateEl ? dateEl.textContent.trim() : null, histBtn: !!histBtn, factoids: deс, title: document.title.slice(0,50) });
})()`;

const AVITO = `(() => {
  const m = document.body ? document.body.innerText.replace(/\\s+/g,' ') : '';
  return JSON.stringify({ closedText: /Объявление закрыто|Объявление истекло/.test(m), price: (document.querySelector('[itemprop="price"]')||{}).content || null, url: location.href.slice(0,90), title: document.title.slice(0,50) });
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
  const page = tabs.find((t) => t.type === 'page' && /cian\.ru|avito\.ru/.test(t.url)) || tabs.find((t) => t.type === 'page');
  const ws = page.webSocketDebuggerUrl;
  for (const url of urls) {
    const isCian = /cian/.test(url);
    let out = 'FAIL';
    try {
      await wsCallUrl(ws, 'Page.navigate', { url });
      for (let k = 0; k < 6; k++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const r = await wsCallUrl(ws, 'Runtime.evaluate', { expression: isCian ? CIAN : AVITO, awaitPromise: true, returnByValue: true });
          if (r.result && r.result.value) {
            const p = JSON.parse(r.result.value);
            if (p.unpublished || p.closedText || k >= 4) { out = JSON.stringify(p); break; }
            out = JSON.stringify(p);
          }
        } catch (e) {}
      }
    } catch (e) { out = 'ERROR ' + e.message; }
    console.log(out + '  <-  ' + url.split('/').pop());
  }
})();
