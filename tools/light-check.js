/**
 * light-check.js — лёгкий статус-чек объявлений Avito через браузер
 * (CDP, вкладка профиля; профиль запущен с мобильной эмуляцией и proxy).
 *
 * Проверяет по карточке: статус (active/closed), цену, дату. Без аккаунта.
 * Режим LIGHT из схемы «лёгкий поток + события» (data-server#46).
 *
 * Использование (Windows PowerShell):
 *   node light-check.js <port> <urls-file> [delaySec]
 *
 * urls-file — текстовый файл: по URL в строке. Замеряет время на карточку.
 */
const fs = require('fs');

const port = process.argv[2];
const urlsFile = process.argv[3];
const delaySec = Number(process.argv[4] || 5);

const urls = fs.readFileSync(urlsFile, 'utf8')
  .split('\n').map((s) => s.trim()).filter(Boolean);

function wsCallUrl(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('timeout ' + method));
    }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return; // событие CDP — не ответ команды, ждём дальше
      clearTimeout(timer);
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

const EXTRACT = `(async () => {
  const body = document.body ? document.body.innerText.replace(/\\s+/g, ' ') : '';
  const isCian = /cian\\.ru/.test(location.host);
  const out = { status: 'unknown', price: null, date: null, updated: null, renovation: null, photos: [], history: [], title: document.title.slice(0, 60) };
  // Блок/капча — отдельный статус: чекер обязан ПАУЗИТЬСЯ, а не долбить IP.
  if (/доступ ограничен|проблема с ip|отключите VPN|отключите AdBlock|проверьте, что вы не робот|не робот|обнаружен подозрительный трафик|cian_waf|rate limit/i.test(body)) {
    out.status = 'blocked';
    return JSON.stringify(out);
  }
  // Русская дата («9 сен, 12:07» / «5 авг 2026») -> YYYY-MM-DD.
  const MON = { янв:1, фев:2, мар:3, апр:4, мая:5, май:5, июн:6, июл:7, авг:8, сен:9, окт:10, ноя:11, дек:12 };
  function ruDate(s) {
    const m = String(s || '').match(/(\\d{1,2})\\s+([а-я]{3})[^0-9]*(\\d{4})?/i);
    if (!m) return null;
    const mo = MON[m[2].toLowerCase()];
    if (!mo) return null;
    let y = m[3] ? +m[3] : new Date().getFullYear();
    if (!m[3] && mo > new Date().getMonth() + 1) y -= 1;
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
  }
  let status = 'unknown';
  if (isCian) {
    // Точный маркер снятой карточки + точные фразы. Широкие «удалено|неактивно»
    // убраны — ловили текст в описаниях и давали ложные архивации.
    const unpub = !!document.querySelector('[data-name="OfferUnpublished"]');
    if (unpub || /Объявление снято|снято с публикации|объявление удалено|объявление не найдено|страница не найдена/i.test(body)) status = 'closed';
    else if (/Сравнить|Пожаловаться|Обновлено:/i.test(body)) status = 'active';
  } else {
    // «Объявление не посмотреть» НЕ считаем снятием: бывает при временных
    // проблемах/блоках (15-11 такие карточки ошибочно ушли в архив).
    if (/Объявление закрыто|Объявление истекло/i.test(body)) status = 'closed';
    else if (/Добавить в избранное|Сравнить/i.test(body)) status = 'active';
  }
  out.status = status;
  let price = null;
  // Приоритет источников цены: itemprop -> testid (cian) -> data-marker.
  for (const sel of ['[itemprop="price"]', '[data-testid="price-amount"]', '[data-marker*="price"]']) {
    const el = document.querySelector(sel);
    if (el) { price = (el.getAttribute('content') || el.textContent || '').trim(); if (price) break; }
  }
  // Чистим мусор инлайн-скриптов: первое число = цена.
  if (price) {
    const m = price.match(/[\\d\\s]{3,}/);
    price = m ? m[0].replace(/\\s/g, '') : null;
  }
  if (!price) {
    const m = body.match(/(\\d[\\d\\s]{2,})\\s*[₽руб]/);
    if (m) price = m[1].replace(/\\s/g, '');
  }
  out.price = price;
  if (isCian) {
    // Дата «Обновлено: 9 сен, 12:07» -> ISO (дата площадки, важна при закрытии).
    const dm = body.match(/Обновлено:\\s*(\\d{1,2}\\s+[а-я]{3}[^,]*,?\\s*\\d{1,2}:\\d{2})/i);
    if (dm) { out.updated = ruDate(dm[1]); out.date = dm[1].trim(); }
    // Ремонт из фактойдов: «РемонтБез ремонта» / «ОтделкаКосметический».
    for (const el of Array.from(document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]'))) {
      const t = (el.textContent || '').trim();
      const m = t.match(/^(Ремонт|Отделка)\\s*:?[\\s]*(.+)$/i);
      if (!m) continue;
      const v = m[2].toLowerCase().replace(/ё/g, 'е');
      if (/без\\s*отделк|без\\s*ремонт|предчистов|чернов|требует\\s*ремонт/.test(v)) out.renovation = 'without';
      else if (/космет/.test(v)) out.renovation = 'cosmetic';
      else if (/дизайнер/.test(v)) out.renovation = 'designer';
      else if (/евро/.test(v)) out.renovation = 'euro';
      else if (/чистов|под\\s*ключ/.test(v)) out.renovation = 'cosmetic';
      break;
    }
    // Фото-ссылки (на закрытой карточке галереи нет — вернётся пусто).
    const seen = new Set();
    for (const img of Array.from(document.querySelectorAll('#photos img[src*="images.cdn-cian.ru/images/"], [class*="photo_gallery_container"] img[src*="images.cdn-cian.ru/images/"]'))) {
      const src = (img.src || '').split('?')[0];
      const idm = src.match(/\\/(\\d+)-/);
      const key = idm ? idm[1] : src;
      if (seen.has(key)) continue;
      seen.add(key);
      out.photos.push(src);
      if (out.photos.length >= 40) break;
    }
    // История цен: DOM-виджет раскрывается кликом (API price-estimator не
    // отвечает). Работает и на закрытой карточке — финальная история.
    const parseHist = () => {
      const rows = [];
      for (const tr of Array.from(document.querySelectorAll('table tr'))) {
        const c = Array.from(tr.children).map(td => (td.textContent || '').trim());
        if (c.length < 2) continue;
        const d = ruDate(c[0]);
        const pm = (c[1] || '').match(/([\\d\\s]{3,})/);
        if (!d || !pm) continue;
        rows.push({ date: d, price: parseInt(pm[1].replace(/\\s/g, ''), 10) });
      }
      return rows;
    };
    out.history = parseHist();
    if (out.history.length === 0) {
      const w = document.querySelector('[data-testid="price-history-widget"]');
      if (w) {
        w.click();
        await new Promise(r => setTimeout(r, 1500));
        out.history = parseHist();
      }
    }
  } else {
    const de = document.querySelector('[data-marker="item-date"], time');
    if (de) out.date = (de.getAttribute('datetime') || de.textContent || '').trim().slice(0, 30);
  }
  out.uaMobile = /Mobile|Android/i.test(navigator.userAgent);
  out.innerW = window.innerWidth;
  return JSON.stringify(out);
})()`;

(async () => {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let page = tabs.find((t) => t.type === 'page' && (t.url || '').includes('avito.ru'));
  if (!page) {
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    const tabs2 = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = tabs2.find((t) => t.type === 'page');
  }
  const ws = page.webSocketDebuggerUrl;

  // Мобильная эмуляция — ТОЛЬКО по флагу --mobile. Проверено 18.11.2026:
  // дефолтный рабочий профиль — ДЕСКТОПНЫЙ UA (мобильный Avito блокирует
  // с десктопного IP: «страница недоступна — отключите VPN»).
  if (process.argv.includes('--mobile')) {
    const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    await wsCallUrl(ws, 'Network.setUserAgentOverride', {
      userAgent: MOBILE_UA,
      platform: 'Linux armv81',
      acceptLanguage: 'ru-RU,ru;q=0.9',
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' }],
        fullVersionList: [{ brand: 'Chromium', version: '120.0.6099.35' }],
        platform: 'Android', platformVersion: '13.0.0', architecture: '', model: 'SM-G991B',
        mobile: true,
      },
    }).catch(() => {});
    await wsCallUrl(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    }).catch(() => {});
    await wsCallUrl(ws, 'Emulation.setTouchOverrideEnabled', { enabled: true }).catch(() => {});
    console.log('режим --mobile: Android 13 / 390x844 / touch');
  }

  console.log(`light-check: ${urls.length} карточек, порт ${port}, пауза ${delaySec}s`);
  const results = [];
  let blockStreak = 0;
  for (let i = 0; i < urls.length; i++) {
    const t0 = Date.now();
    let data = null;
    try {
      await wsCallUrl(ws, 'Page.navigate', { url: urls[i] });
      // ждём загрузку (до 12 с), затем разбираем
      for (let k = 0; k < 8; k++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const r = await wsCallUrl(ws, 'Runtime.evaluate', {
            expression: EXTRACT, awaitPromise: true, returnByValue: true,
          });
          if (r.result && r.result.value) {
            const parsed = JSON.parse(r.result.value);
            if (parsed.status !== 'unknown') { data = parsed; break; }
            data = parsed;
          }
        } catch (e) { /* контекст навигации — повторим */ }
      }
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ url: urls[i], sec, ...data });
      console.log(`[${i + 1}/${urls.length}] ${sec}s  ${data ? data.status : 'FAIL'}  ${data && data.price ? data.price + 'р' : '-'}  ${urls[i].split('/').pop().slice(0, 40)}`);
    } catch (e) {
      console.log(`[${i + 1}/${urls.length}] ERROR ${e.message}`);
    }
    // Блок = временный флуд-контроль: пауза НЕМЕДЛЕННО в момент блока
    // (серия блоков = нарастающая пауза, максимум 10 минут).
    if (data && data.status === 'blocked') {
      blockStreak += 1;
      const pause = Math.min(600, 60 * blockStreak);
      console.log(`  !! БЛОК — пауза ${pause}с (серия ${blockStreak}), не долбим IP`);
      await new Promise((r) => setTimeout(r, pause * 1000));
    } else {
      blockStreak = 0;
    }
    await new Promise((r) => setTimeout(r, delaySec * 1000));
  }
  const ok = results.filter((r) => r.status !== 'unknown');
  const avg = results.reduce((a, r) => a + Number(r.sec), 0) / (results.length || 1);
  console.log(`\nИТОГО: ${ok.length}/${urls.length} разобрано, среднее ${avg.toFixed(1)}s на карточку`);
  fs.writeFileSync(require('path').join(require('os').tmpdir(), 'light-check-result.json'), JSON.stringify(results, null, 1));
})();
