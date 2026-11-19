/**
 * Полный парсер страницы объявления CIAN
 */

import type { ParseResult, PriceHistoryItem } from '../types';
import { injectScript } from '../utils/tab-manager';
import { mapCianRenovation } from '../utils/renovation';

/**
 * Парсинг страницы объявления CIAN (инжектируется в ISOLATED world)
 */
function parseCianDetailPage() {
  const result: any = {};

  // Статус. Закрытая карточка Cian ещё отдаёт данные (цена, дата «Обновлено»,
  // ремонт, история цен) — это финальный снимок, он пишется в архив
  // (data-server#49). НИКОГДА не выходим здесь с одним статусом.
  const unpublished = document.querySelector('[data-name="OfferUnpublished"]');
  result.status = unpublished ? 'archived' : 'active';

  // Цена
  const priceEl = document.querySelector('[data-testid="price-amount"]');
  if (priceEl) {
    const priceText = priceEl.textContent?.replace(/[^\d]/g, '') || '';
    result.price = priceText ? parseInt(priceText, 10) : null;
  }

  // Фото
  const photos: string[] = [];
  const photoContainer = document.querySelector('#photos') ||
    document.querySelector('[class*="photo_gallery_container"]');
  if (photoContainer) {
    const imgs = photoContainer.querySelectorAll('img[src*="images.cdn-cian.ru/images/"]');
    for (const img of Array.from(imgs)) {
      const src = (img as HTMLImageElement).src;
      // Извлекаем ID фото из URL
      const idMatch = src.match(/\/images\/(\d+)-/);
      const photoId = idMatch ? idMatch[1] : src;
      if (!photos.includes(photoId)) {
        photos.push(src.split('?')[0]); // Убираем query params
      }
    }
  }
  result.photos = photos;

  // Дата обновления
  const dateEl = document.querySelector('[data-testid="metadata-updated-date"]');
  if (dateEl) {
    result.updatedDateText = dateEl.textContent?.trim() || null;
  }

  // Тип ремонта/отделки (MVP-4, admin#37).
  // DOM-фактойды: [data-name="ObjectFactoidsItem"] — label («Отделка») и
  // значение («Предчистовая») соседними span/p внутри одного элемента.
  // Запасной источник — inline JSON "decoration":"preFine".
  let renovation: string | null = null;
  for (const el of Array.from(
    document.querySelectorAll('[data-name="ObjectFactoidsItem"], [data-testid="OfferSummaryInfoItem"]'),
  )) {
    const parts = Array.from(el.querySelectorAll('p, span'))
      .map((n) => (n.textContent || '').trim())
      .filter((t, i, arr) => t && arr.indexOf(t) === i && t.length < 60);
    // Пара вида [«Отделка», «Предчистовая»] (или вложенно — label первым)
    const labelIdx = parts.findIndex((t) => /^(отделка|тип ремонта|ремонт)$/i.test(t));
    if (labelIdx !== -1 && parts[labelIdx + 1]) {
      renovation = parts[labelIdx + 1];
      break;
    }
  }
  if (!renovation) {
    for (const s of Array.from(document.querySelectorAll('script'))) {
      const m = (s.textContent || '').match(/"decoration"\s*:\s*"([^"]+)"/);
      if (m) {
        renovation = m[1];
        break;
      }
    }
  }
  result.renovation = renovation;

  // История цены: основной источник — priceChanges в инлайновом JSON страницы.
  // Он доступен и без авторизации. Старый селектор DOM (tr[class*="history-event"])
  // в текущей вёрстке ЦИАН уже не встречается — оставлен как запасной вариант.
  const priceHistory: any[] = [];
  for (const s of Array.from(document.querySelectorAll('script'))) {
    const text = s.textContent || '';
    const m = text.match(/"priceChanges":(\[.*?\])/);
    if (m) {
      try {
        const changes = JSON.parse(m[1]);
        for (const c of changes) {
          const price = c?.priceData?.price;
          if (price && c?.changeTime) {
            priceHistory.push({ date: c.changeTime, price: Number(price) });
          }
        }
      } catch {
        /* битый JSON — пробуем DOM */
      }
      break;
    }
  }

  if (priceHistory.length === 0) {
    const historyRows = document.querySelectorAll('tr[class*="history-event"]');
    for (const row of Array.from(historyRows)) {
      const cells = row.querySelectorAll('td');
      if (cells.length >= 2) {
        const dateText = cells[0].textContent?.trim() || '';
        const priceText = cells[1].textContent?.replace(/[^\d]/g, '') || '';
        if (dateText && priceText) {
          priceHistory.push({ date: dateText, price: parseInt(priceText, 10) });
        }
      }
    }
  }
  result.priceHistory = priceHistory;

  return result;
}

/**
 * Парсинг русской даты
 */
function parseRuDate(text: string): string | null {
  // Месяцы — по первым буквам: карточка пишет сокращённо («9 сен, 12:07»,
  // «5 авг 2026»), старый словарь полных форм («сентября») не матчился и
  // дата «Обновлено» терялась (data-server#49).
  const months: Record<string, number> = {
    'янв': 0, 'фев': 1, 'мар': 2, 'апр': 3,
    'мая': 4, 'май': 4, 'июн': 5, 'июл': 6, 'авг': 7,
    'сен': 8, 'окт': 9, 'ноя': 10, 'дек': 11,
  };
  const monthOf = (w: string): number | undefined => months[w.toLowerCase().slice(0, 3)] ?? months[w.toLowerCase().slice(0, 4)];

  const lower = text.toLowerCase().trim();
  const now = new Date();

  const fullMatch = lower.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (fullMatch) {
    const month = monthOf(fullMatch[2]);
    if (month !== undefined) {
      return new Date(parseInt(fullMatch[3]), month, parseInt(fullMatch[1])).toISOString();
    }
  }

  // Короткая форма без года: «9 сен, 12:07» / «5 авг». Год выводится от
  // текущей даты; если дата получилась в будущем — это прошлый год.
  const shortMatch = lower.match(/(\d{1,2})\s+(\w+),?\s*(?:(\d{1,2}):(\d{2}))?/);
  if (shortMatch) {
    const month = monthOf(shortMatch[2]);
    if (month !== undefined) {
      const d = new Date(now.getFullYear(), month, parseInt(shortMatch[1]),
        parseInt(shortMatch[3] ?? '0'), parseInt(shortMatch[4] ?? '0'));
      if (d.getTime() > now.getTime()) d.setFullYear(d.getFullYear() - 1);
      return d.toISOString();
    }
  }

  return null;
}

/**
 * Полный парсинг страницы объявления CIAN
 */
export async function parseCianAd(tabId: number): Promise<ParseResult> {
  try {
    // Сначала читаем title/текст: без этого сырой `rawData == null` превращался
    // в no_data даже на капче и 404 — строка горела в failed вместо captcha/archived.
    const probe = await injectScript(tabId, () => ({
      title: document.title || '',
      text: document.body?.innerText?.substring(0, 800) || '',
      hasCaptchaFrame: (() => {
        // Только видимые челленджи: площадки держат скрытые captcha-ноды
        // в DOM и на обычных карточках.
        const sel = 'iframe[src*="hcaptcha"], iframe[src*="geetest"], iframe[src*="captcha"], .captcha, [class*="captcha"]';
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = getComputedStyle(el as HTMLElement);
          if (r.width > 40 && r.height > 40 && st.display !== 'none' && st.visibility !== 'hidden') return true;
        }
        return false;
      })(),
    }));
    const bodyText = (probe?.text || '').toLowerCase();
    const title = (probe?.title || '').toLowerCase();

    // Cian отдаёт капчу с title «Captcha - база объявлений ЦИАН» (заглавная C).
    // Только явные маркеры челленджа — не любое упоминание «капч» в тексте.
    const isCaptchaTitle = title.includes('captcha') || title.includes('капч');
    const isCaptchaText =
      bodyText.includes('подтвердите, что вы не робот') ||
      bodyText.includes('пройдите проверку') ||
      bodyText.includes('решите капчу') ||
      (bodyText.includes('капч') && bodyText.includes('продолжить'));
    if (isCaptchaTitle || isCaptchaText || probe?.hasCaptchaFrame) {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'captcha' };
    }
    // WAF ЦИАНа (cian_waf_block) — «Обнаружен подозрительный трафик»
    if (bodyText.includes('подозрительный трафик') || bodyText.includes('cian_waf_block') || title === 'Ошибка - Циан') {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'waf_block' };
    }
    // Мёртвые страницы — закрываем как archived, а не как no_data
    if (
      bodyText.includes('не найдено') ||
      bodyText.includes('страница не найдена') ||
      bodyText.includes('объявление удалено') ||
      bodyText.includes('снято с публикации') ||
      title.includes('404')
    ) {
      return { status: 'archived', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null };
    }

    const rawData = await injectScript(tabId, parseCianDetailPage);
    if (!rawData) {
      return { status: 'error', price: null, price_per_meter: null, photos: [], price_history: [], seller_name: null, seller_type: null, updated: null, error: 'no_data' };
    }

    // Парсинг даты обновления
    let updated: string | null = null;
    if (rawData.updatedDateText) {
      updated = parseRuDate(rawData.updatedDateText);
    }

    // Конвертация истории цен
    const price_history: PriceHistoryItem[] = (rawData.priceHistory || []).map((h: any) => ({
      date: parseRuDate(h.date) || h.date,
      price: h.price,
    }));

    // Тип ремонта/отделки (MVP-4, admin#37)
    const renovation_raw: string | null = rawData.renovation ?? null;
    const renovation_type = mapCianRenovation(renovation_raw);

    return {
      status: rawData.status || 'active',
      price: rawData.price || null,
      price_per_meter: null,
      photos: rawData.photos || [],
      price_history,
      seller_name: null,
      seller_type: null,
      renovation_type,
      renovation_raw,
      updated,
    };
  } catch (err) {
    return {
      status: 'error',
      price: null,
      price_per_meter: null,
      photos: [],
      price_history: [],
      seller_name: null,
      seller_type: null,
      updated: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
